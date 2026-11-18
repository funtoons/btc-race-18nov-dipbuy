[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/funtoons/btc-race-18nov-dipbuy/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/funtoons/btc-race-18nov-dipbuy/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

# Dip-buy cbBTC bot

A long-only, single-position bot for the make.fun BTC race (`bars-replay/v1`).
It waits in cash until the 1-minute close sits at least 150 bps below its
240-bar high, buys with the full cash balance once per washout episode, and
exits on a 100 bp take profit, a 100 bp trailing stop, a 150 bp hard stop,
or after 480 bars. All decisions use exact integer arithmetic; the bot reads
no clock, randomness, network, or files, so two runs on the same bars decide
the same orders.

- `main.ts` — the bot (Node type stripping, standard library + vendored SDK)
- `vendor/makefun-bars.ts` — the kit's protocol shim, copied byte for byte

Grade locally from the competition kit:

```
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver process
```
