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
