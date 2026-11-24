// Pump.fun paper bot — config "probe24" (Closer + probes).
//
// Competition: Pump.fun Bot Sprint (pumpfun-replay/v2), capital 10 SOL,
// final window 6h of fresh pump.fun data. Strategy, in brief:
//   - CLOSER: buy once per coin, min(0.5 SOL, 1% of real reserves), when a
//     coin's real reserves reach 50 SOL and grew >= 10 SOL over the last
//     50 slots, and the coin is at most 500 slots old. Exit at 2x the fill
//     price (take-profit), 0.75x (stop-loss), or after 600 slots, and
//     always sell everything when a CompleteEvent arrives. No re-entry.
//   - PROBES: 0.012 SOL round trips on the most liquid coin (highest real
//     reserves, at least 5 SOL — a probe on a thinner coin is noise, not a
//     guardrail coin), at most 24 probes spaced 300 slots apart, until 25 coins
//     have round-tripped — only to bank the 20-coin guardrail with margin.
//
// Protocol (agent-fun/replay/v2, see vendor/makefun-bot.ts): the harness
// opens with a hello handshake (seed, capital, caps, latency_slots, fees),
// then sends one batch per slot — events (TradeEvent / CreateEvent /
// CompleteEvent), marks (latest reserves for held or pending mints),
// fills that resolved since the previous batch, and the account — and the
// bot answers each batch with exactly one reply echoing the batch seq,
// carrying its orders for that slot. An order decided on slot s fills at
// slot s + latency_slots (2). The fill price used for take-profit /
// stop-loss is the marginal curve price (virtual_quote / virtual_token
// from state.curves) at the batch where the fill lands — NOT the average
// execution price — because the curve moves between decision and fill.
//
// Deterministic: bigint arithmetic only; no clock, no randomness, no
// environment, no network. Every decision is a pure function of the
// hello + the batches seen so far.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
} from "./vendor/makefun-bot.ts";

const SOL = LAMPORTS_PER_SOL; // 1_000_000_000n lamports
const CLOSER_SIZE = SOL / 2n; // 0.5 SOL per Closer buy
const RQ_TRIGGER = 50n * SOL; // real reserves must reach 50 SOL
const VEL_MIN = 10n * SOL; // ... and grow >= 10 SOL over ...
const VEL_WINDOW = 50; // ... the last 50 slots
const AGE_MAX = 500; // coin age at entry, in slots
const HOLD_MAX = 600; // timeout exit, in slots after the fill
const PROBE_SIZE = 12_000_000n; // 0.012 SOL probe round trip
const PROBE_MIN_RQ = 5n * SOL; // probe only a coin with >= 5 SOL real reserves
const PROBE_MAX = 24; // at most 24 probes in the run
const PROBE_SPACING = 300; // slots between probe buys
const PROBE_STOP_COINS = 25; // stop probing once 25 coins round-tripped
const MIN_ROUND_TRIP_BUY = 10_000_000n; // 0.01 SOL guardrail floor
const MAX_SLIPPAGE_BPS = 10_000; // accept the fill at any price move

// ---------------------------------------------------------------- state
// All module-level, built up batch by batch; nothing else is read.

/** Mints a buy order was ever sent for: one buy per coin, no re-entry. */
const bought = new Set<string>();
/** Mints bought as probes (sold as soon as the buy fill lands). */
const probeMints = new Set<string>();
/** Mints whose buy filled and whose sell (or harness close) filled. */
const roundTripped = new Set<string>();
/** Fill price per held mint: marginal curve price at fill landing. */
const entries = new Map<string, { vq: bigint; vt: bigint; slot: number }>();
/** Real-quote reserve samples per mint, for the 50-slot velocity check. */
const history = new Map<string, { slot: number; rq: bigint }[]>();
/** Mints whose completion sell was already sent (send it once). */
const completeSellSent = new Set<string>();
let probeCount = 0;
let lastProbeSlot = -1_000_000_000;

// ---------------------------------------------------------------- helpers

function hasPending(state: BotState, mint: string, side: "buy" | "sell"): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
  }
  return false;
}

/** Record this batch's real-quote reserves for one mint (one sample/slot). */
function recordSample(state: BotState, mint: string): void {
  const curve = state.curves.get(mint);
  if (curve === undefined) return;
  const samples = history.get(mint) ?? [];
  if (samples.length > 0 && samples[samples.length - 1].slot === state.slot) return;
  samples.push({ slot: state.slot, rq: curve.real_quote_reserves });
  // Prune samples older than the lookback window, keeping the newest one
  // at-or-before (slot - VEL_WINDOW) as the velocity anchor: reserves only
  // change on a trade, so that anchor IS the reserve VEL_WINDOW slots ago.
  let cut = 0;
  while (cut < samples.length && samples[cut].slot < state.slot - VEL_WINDOW - 10) cut++;
  if (cut > 1) samples.splice(0, cut - 1);
  if (samples.length > 256) samples.splice(0, samples.length - 256);
  history.set(mint, samples);
}

/** Real-quote reserves at-or-before a slot, or null when never observed. */
function rqAtOrBefore(mint: string, slot: number): bigint | null {
  const samples = history.get(mint);
  if (samples === undefined) return null;
  let value: bigint | null = null;
  for (const s of samples) {
    if (s.slot <= slot) value = s.rq;
    else break;
  }
  return value;
}

/**
 * The velocity anchor for a mint: its reserves 50 slots ago when observed,
 * else 0 — its reserves at creation. A coin younger than the window has no
 * reading from 50 slots ago, but it did not exist then either: real SOL
 * starts at 0, so growth since creation is just its current reserves.
 * (Falling back to the first-seen reserves instead would miss a coin
 * that rockets to 50 SOL in its very first batch — its first-seen
 * reserves already ARE the move.)
 */
function velocityAnchor(mint: string, slot: number): bigint | null {
  const old = rqAtOrBefore(mint, slot - VEL_WINDOW);
  if (old !== null) return old;
  const samples = history.get(mint);
  if (samples === undefined || samples.length === 0) return null;
  return 0n;
}

/**
 * Fold this batch's fills into the books. A buy fill records the entry at
 * the marginal curve price of the batch where the fill lands (the curve
 * state runBot applied before onBatch runs already includes the fill's own
 * trade). A sell fill — ours, or a harness close (_complete_ / _flatten_ /
 * _writeoff_) — closes the round trip.
 */
function noteFills(state: BotState, batch: Batch): void {
  for (const f of batch.fills) {
    if (f.status !== "filled") continue;
    if (f.side === "buy") {
      const curve = state.curves.get(f.mint);
      if (curve !== undefined && curve.virtual_token_reserves > 0n) {
        entries.set(f.mint, {
          vq: curve.virtual_quote_reserves,
          vt: curve.virtual_token_reserves,
          slot: f.slot,
        });
      } else {
        // Fallback only (curve unseen): average execution price.
        const tokens = BigInt(f.token_amount);
        if (tokens > 0n) {
          entries.set(f.mint, { vq: BigInt(f.quote_lamports), vt: tokens, slot: f.slot });
        }
      }
    } else {
      roundTripped.add(f.mint);
      entries.delete(f.mint);
      probeMints.delete(f.mint);
    }
  }
}

// ---------------------------------------------------------------- onBatch

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  // Lamports this reply already commits (buy amounts + every tx fee),
  // so cash checks inside this batch see the orders already planned.
  let reserved = 0n;
  const txFee = state.txFeeLamports();
  // Positions this reply already opens (committedPositionCount does not
  // see orders planned in this batch yet).
  let plannedBuys = 0;

  const completed = new Set<string>();
  for (const e of batch.events) {
    if (e.event === "CompleteEvent") completed.add(e.mint);
  }

  noteFills(state, batch);

  // Reserve samples for every mint this batch touched.
  const touched = new Set<string>();
  for (const e of batch.events) touched.add(e.mint);
  for (const m of batch.marks) touched.add(m.mint);
  for (const mint of touched) recordSample(state, mint);

  // --- exits: completion, probe exit, take-profit, stop-loss, timeout ---
  for (const [mint, pos] of state.positions) {
    const curve = state.curves.get(mint);
    const ent = entries.get(mint);
    let sell = false;
    if (completed.has(mint) && !completeSellSent.has(mint)) {
      // COMPLETION, exact rule: sell the whole position at this batch's
      // market, no price condition. (The harness also closes completed
      // curves itself; whichever lands first closes the position.)
      sell = true;
      completeSellSent.add(mint);
    } else if (probeMints.has(mint)) {
      sell = true; // probe buy filled: round-trip it at once
    } else if (ent !== undefined && curve !== undefined) {
      const vq = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;
      if (vt > 0n && ent.vt > 0n) {
        // Current marginal price vq/vt vs fill price ent.vq/ent.vt,
        // compared by cross-multiplication (no floats, no division).
        if (vq * ent.vt >= 2n * ent.vq * vt) sell = true; // take-profit 2x
        else if (4n * vq * ent.vt <= 3n * ent.vq * vt) sell = true; // stop 0.75x
        else if (state.slot - ent.slot >= HOLD_MAX) sell = true; // timeout
      } else if (state.slot - ent.slot >= HOLD_MAX) {
        sell = true;
      }
    } else if (ent !== undefined && state.slot - ent.slot >= HOLD_MAX) {
      sell = true;
    }
    if (sell && !hasPending(state, mint, "sell")) {
      orders.push({
        side: "sell",
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      reserved += txFee;
    }
  }

  // --- Closer entries: one buy per coin on the 50-SOL + velocity gate ---
  for (const e of batch.events) {
    if (e.event !== "TradeEvent") continue;
    const mint = e.mint;
    if (bought.has(mint)) continue;
    if (state.positions.has(mint)) continue;
    if (hasPending(state, mint, "buy")) continue; // buy in flight: skip
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (curve.created_slot === null) continue;
    if (state.slot - curve.created_slot > AGE_MAX) continue;
    const rq = curve.real_quote_reserves;
    if (rq < RQ_TRIGGER) continue;
    const old = velocityAnchor(mint, state.slot);
    if (old === null) continue;
    if (rq - old < VEL_MIN) continue;
    // Size: min(0.5 SOL, 1% of real reserves), inside the harness cap
    // (max_order_bps_of_real_reserve = 100 bps = 1% of real reserves).
    let size = rq / 100n;
    if (size > CLOSER_SIZE) size = CLOSER_SIZE;
    const cap = state.maxBuyLamports(mint);
    if (size > cap) size = cap;
    if (size <= 0n) continue;
    if (state.committedPositionCount() + plannedBuys >= state.hello.caps.max_open_positions) continue;
    if (state.freeCashLamports() - reserved < size + txFee) continue;
    orders.push({ side: "buy", mint, quote_lamports: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
    bought.add(mint);
    plannedBuys += 1;
    reserved += size + txFee;
  }

  // --- probes: 0.012 SOL round trips on the most liquid coin ---
  if (
    probeCount < PROBE_MAX &&
    roundTripped.size < PROBE_STOP_COINS &&
    state.slot - lastProbeSlot >= PROBE_SPACING
  ) {
    let best: string | null = null;
    let bestRq = 0n;
    for (const [mint, curve] of state.curves) {
      if (curve.complete) continue;
      if (bought.has(mint) || state.positions.has(mint)) continue;
      if (hasPending(state, mint, "buy")) continue;
      if (curve.real_quote_reserves > bestRq) {
        bestRq = curve.real_quote_reserves;
        best = mint;
      }
    }
    if (best !== null && bestRq >= PROBE_MIN_RQ) {
      const cap = state.maxBuyLamports(best);
      const size = PROBE_SIZE < cap ? PROBE_SIZE : cap;
      if (
        size >= MIN_ROUND_TRIP_BUY &&
        state.committedPositionCount() + plannedBuys < state.hello.caps.max_open_positions &&
        state.freeCashLamports() - reserved >= size + txFee
      ) {
        orders.push({ side: "buy", mint: best, quote_lamports: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
        bought.add(best);
        probeMints.add(best);
        probeCount += 1;
        lastProbeSlot = state.slot;
        plannedBuys += 1;
        reserved += size + txFee;
      }
    }
  }

  return orders;
}

await runBot({ onBatch });
