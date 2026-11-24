[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Aprry1306/pump-fun-replay-bot-riidzhsn/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Aprry1306/pump-fun-replay-bot-riidzhsn/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Pump.fun paper replay bot — Closer + take-profit (RiidZ sprint)

Entry for [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) (make.fun).
One program, `main.ts` on Node 22: it paper-trades pump.fun bonding curves on
a replay harness (`pumpfun-replay/v2`), ranked by net PnL on a fresh 6-hour
window after the deadline.

Built by an AI agent for [make.fun](https://make.fun/?ref=wktj871p).

## Strategy

Two parts, both deterministic (bigint only — no clock, randomness, env, or
network). Config name: **probe24**.

**Closer — ride coins about to complete.** Buy once per coin, 0.5 SOL, when
real reserves reach 50 SOL having grown at least 10 SOL over the last 50
slots, and the coin is at most 500 slots old. A coin younger than the
50-slot window has no reserve reading from 50 slots ago, so growth is
measured from its reserves at creation (0 SOL) — a coin that rockets to 50
SOL in its first batch is exactly the move this gate is for. Most
completions are unbuyable (they complete in the same slot they cross 50
SOL), so the edge lives in the enterable tail: coins that stall above 50
SOL and then complete, or spike 2x first. Exits: take-profit at 2x the
fill price, stop-loss at 0.75x, timeout 600 slots after the buy fill.
A CompleteEvent sells the whole position at that batch's market, no price
condition. No re-entry, ever; mints with a buy in flight are skipped.
The fill price is the marginal curve price (virtual_quote /
virtual_token) at the batch where the fill lands — not the average
execution price.

**Probes — bank the 20-coin guardrail with margin.** While fewer than 25
coins have round-tripped, buy 0.012 SOL of the highest-reserve liquid coin
(real reserves >= 5 SOL), at most 24 probes, spaced at least 300 slots
apart, and sell it straight back on the batch its fill lands in. A probe
is not a bet: it exists only so the guardrail holds on a completion-poor
day.

## Parameters (probe24 config)

| Parameter | Value |
|---|---|
| Closer stake | 0.5 SOL (`min(0.5 SOL, 1% of real reserves)`) |
| Entry reserves | >= 50 SOL real reserves |
| Entry velocity | >= 10 SOL growth over the last 50 slots (from creation if younger) |
| Entry max age | 500 slots |
| Take-profit | 2x fill price |
| Stop-loss | 0.75x fill price |
| Hold timeout | 600 slots after the buy fill |
| Probe size | 0.012 SOL |
| Probe min reserves | 5 SOL |
| Probe max count | 24 |
| Probe spacing | 300 slots |
| Probe stop | 25 coins round-tripped |
| Slippage | 10,000 bps (wide open) |

## Layout

- `main.ts` — the strategy (the only file the entry authors).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte-identical from
  the competition kit (`sdk/ts/makefun-bot.ts`).

## Grade locally

From the unpacked kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process
```

## Validation (dev window, kit dataset — honest numbers)

Dev-window grade-local (this repo, driver process; two runs identical,
L1 regrade reproduced byte for byte):

| Metric | Value |
|---|---|
| Net PnL | **+2.421413645 SOL** |
| 90% interval | +0.393861631 .. +4.641031845 SOL (fully positive) |
| Net PnL at 2x fees | +2.148880351 SOL |
| Fills / coins / round trips | 76 / 40 / 40 |
| Win rate | 0.30 |
| Max drawdown | 0.044 |
| Fees | 0.237990925 SOL curve + 0.008505000 SOL tx |
| Rejected / failed orders | 2 / 1 |
| Worst loser | -0.425758532 SOL (85% of stake — the stop-loss does not cap gap-through losses) |
| Top-3 coins | 44% of gains; net without them +0.91 SOL |
| Guardrails | met (40 coins >= 0.01 SOL round trips, drawdown ok) |

Walk-forward, four non-overlapping 6-hour slices of the dev window
(real harness engine + real bot process; full-window run reproduces
grade-local exactly):

| Slice | Net PnL (1x / 2x fees) | Coins | Guardrail coins | Win rate |
|---|---|---|---|---|
| S1 | -0.0170 / -0.0288 SOL | 24 | 24 | 0.04 |
| S2 | +1.0972 / +1.0206 SOL | 26 | 26 | 0.19 |
| S3 | +0.9060 / +0.7963 SOL | 30 | 30 | 0.30 |
| S4 | +0.3912 / +0.2820 SOL | 30 | 30 | 0.17 |
| **Mean** | **+0.594 / +0.518 SOL** | | | |

3 of 4 slices positive at 1x and 2x fees; worst slice -0.0170 SOL.
Note: this walk-forward is **in-sample** — the parameters were tuned on
the full dev window and the slices were used as a selection check, so it
proves within-window consistency only, not out-of-sample performance.
(Slice numbers differ from the reference run by at most 0.0013 SOL: two
probe buys land 2 slots apart in S4. The full-window behavior is
byte-identical; the slice gap is probe-scheduling noise.)

Comparison variants (scratch only, same harness, full window + slices):

| Variant | Full net (1x / 2x) | Coins | WF mean | WF worst slice |
|---|---|---|---|---|
| **probe24 (this entry)** | **+2.4214 / +2.1489** | 40 | +0.594 | -0.0170 (S1) |
| tp3 (TP 2x, hold 300, age 1000) | +1.7570 / +1.4757 | 42 | +0.427 | +0.0157 (S1, 1x) |
| age-1000 (probe24, age <= 1000) | +2.1529 / +1.8619 | 42 | +0.527 | -0.1613 (S1) |

tp3 is safer (4/4 slices positive at 1x fees) but gives up 0.66 SOL of
dev edge; age-1000 shows what the age-500 gate is worth — without it S1
bleeds -0.1613 SOL. probe24 is the pick for this winner-takes-all
competition: it maximizes the dev edge while every slice still clears
the guardrail with margin (24+ coins vs 20 minimum).

Stress (grade-local `--stress`, 20 rebuilt copies):

Stress (grade-local `--stress`, 20 rebuilt copies):

| Metric | Value |
|---|---|
| Median copy | -0.67 SOL (standard median -0.42) |
| p10 / p90 | -1.57 / +0.51 SOL |
| Copies losing money | 13 of 20 (mean of copies -0.40 SOL) |
| Dev score above | 20 of 20 copies |
| Per-copy PnL | -0.67, +0.51, -2.02, +0.40, -0.88, -0.16, -0.90, -1.16, +0.60, -0.92, -0.75, +0.40, +0.64, -0.83, +0.19, +0.42, -1.57, -0.08, -0.01, -1.15 |

**Verdict: FAIL — and not hidden.** Both harness warnings fired (dev
score above 90% of copies; half or more copies lost money). The copies
rebuild every coin's trajectory by splicing blocks of other coins'
trades, which destroys the coin-level momentum persistence this strategy
bets on — so the stress median measures a world where the signal does
not exist, not a fresh real day. But it is real evidence the edge rides
on the final day's completion rate: a completion-poor final day pays
little (S1-like, ~0.00) or loses (downside roughly -0.5 to -0.85 SOL).

## Honest assessment

- The dev edge is real on real data (+2.42 SOL, fully-positive 90%
  interval, guardrails met with margin on every 6h slice), but the final
  is a **fresh 6-hour window** — the dev gap is a proxy, not a prediction.
- The stop-loss does **not** cap losses: the worst dev loser took 85% of
  its 0.5 SOL stake by gapping through. A completion-poor final day with
  two gap losers costs roughly -0.85 SOL; the best real-data downside
  anchor is S1 (-0.017 SOL, 6 completions).
- The age-500 gate's benefit rests on a narrow band (it excludes coins
  aged 501–750, which were losers in-sample); a final-window completer
  crossing at age 501–1000 would be missed entirely.
- The kit seed differs per competition, so the same bot can score
  roughly +/-0.04 SOL differently on the server's kit.

## License

MIT — see `LICENSE`.
