# Dip-Buy Survivor

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/hikmalalfatih/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/hikmalalfatih/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) competition on make.fun. It trades paper SOL on a replay of pump.fun bonding-curve data.

## Strategy

Two arms, one bookkeeping (see `strategy.ts` for the full logic and parameters):

- **Dip arm (profit engine):** buys a seasoned curve's pullback — age ≥ 400 slots, real SOL ≥ 25, price 15–40% below its 1800-slot high, while the last 6 trades show ≥ 3 buys, non-negative net flow, a buy as the most recent trade, no creator sell, and no single sell ≥ 2.5 SOL recently. Size is 1.5% of real SOL (0.05–0.5 SOL). Exits: hard stop −10%, take half at +25%, trailing stop 25% from the peak once up ≥ 12%, stale exit after 400 slots, instant exit on a creator sell or a ≥ 2.5 SOL sell.
- **Young arm (breadth engine):** one tiny 0.02 SOL ticket per launch in its first 10 slots when the tape looks unbundled (creator bought ≥ 0.02 SOL, net flow positive, ≤ 3 distinct non-creator buyers, no creator sell), exited flat at +20% / −10% / 10 slots. It exists so the entry clears the ≥ 20-coins guardrail on the short 6-hour final window; at most 3 young positions are open at once.

## Local dev results (kit dev window, 24h)

Measured with the kit's own replay engine (`grade-local --driver process`):

- Net PnL: **+0.664 SOL** (90% interval −0.159 … +1.675 SOL — the interval contains 0)
- Coins traded: 306 · round trips: 319 · win rate: 17.6% · max drawdown: 2.9%
- Fees: 0.518 SOL curve + 0.074 SOL tx; at 2× fees net PnL is still +0.070 SOL
- Guardrails met (306 coins hold a round trip ≥ 0.01 SOL; drawdown ok)

## Stress test (honest check)

`grade-local --stress 20` rebuilds the dev window from resampled blocks of its own
trades — 20 copies, all of them lost money:

- Median: **−0.50 SOL** · 10th percentile −0.90 · 90th percentile −0.05 · **20/20 copies lost**
- The dev score (+0.664) sits above all 20 copies
- The top 3 coins made 61% of the gains; without them net PnL is −0.21 SOL

Read it plainly: the dev profit leans on three specific coins' sequences, and the
edge does not survive resampling. On a fresh 6-hour final window this entry is a
lottery ticket, not a robust edge. That is the honest state of this build.

## Files

- `main.ts` — entrypoint: runs the strategy with `DEFAULT_PARAMS`.
- `strategy.ts` — the whole strategy, written fresh for this competition.
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte.
- `LICENSE` — MIT.

## Grade locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --stress 20
```
