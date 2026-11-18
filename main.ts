// Dip-buy / mean-reversion bot for cbBTC (CBBTC/USDC), bars-replay/v1.
//
// Idea, derived from the dev window's own bars: wait in cash until the close
// sits far below its 240-bar high (a genuine washout, not noise), buy the
// whole cash balance once per washout episode, then exit on a fixed take
// profit, a trailing stop, a hard stop, or a maximum hold. Every comparison
// is exact integer arithmetic in basis points; no clock, no randomness, no
// network, no files. Two runs on the same bars decide the same orders.
//
// Parameters (basis points unless noted; chosen from a broad plateau of
// neighbouring configurations on the dev data, not from one sharp point):
//   LOOKBACK_BARS  240  bars of closes behind the decision bar for the high
//   DIP_BPS        150  close must be at least this far below that high
//   TAKE_PROFIT_BPS 100 exit when the close rises this far above the fill
//   TRAIL_BPS      100  exit when the close falls this far below the peak
//   STOP_BPS       150  exit when the close falls this far below the fill
//   MAX_HOLD_BARS  480  exit when the position is this old (scored bars)
//   COOLDOWN_BARS   30  no new entry this soon after an exit decision
//   LAST_ENTRY_SEQ 1380 no new entry decided after this scored bar
//   MAX_SLIPPAGE_BPS 100 every order's bound against the latest close
//
// One position at a time. Entries fire only on the crossing into a dip, so
// a long washout produces one entry, not one per bar; a crossing that lands
// inside the cooldown is remembered, not lost. Exits are re-evaluated on
// every bar while holding, so a rejected sell is re-decided next bar.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const BPS = 10000n;
const LOOKBACK_BARS = 240;
const DIP_BPS = 150n;
const TAKE_PROFIT_BPS = 100n;
const TRAIL_BPS = 100n;
const STOP_BPS = 150n;
const MAX_HOLD_BARS = 480;
const COOLDOWN_BARS = 30;
const LAST_ENTRY_SEQ = 1380;
const MAX_SLIPPAGE_BPS = 100;
const MIN_NOTIONAL = 1000000n; // 1 USDC in quote units

// Closes of CBBTC bars in the order received (one per bar that exists).
const closes: bigint[] = [];
// Whether the dip condition held on the last bar that reset it. It is set
// true only when a dipped bar is actually evaluated for entry, and reset
// whenever an evaluated bar is not dipped; while holding or gated it is
// left alone, so a crossing is never lost to a bar that could not act.
let prevDipped = false;
// Scored-bar seq before which no new entry may be decided.
let cooldownUntil = -1;
// Fill price of the open position (null while flat), and the scored seq of
// the batch whose reply decided the buy.
let entryPrice: bigint | null = null;
let entrySeq = -1;
// Highest close seen since the open position's buy was decided.
let peakClose = 0n;

function scoredSeq(state: BarsState): number {
  return state.seq - state.warmupBars;
}

function rollingHigh(): bigint | null {
  // Max of the LOOKBACK_BARS closes strictly before the current bar.
  if (closes.length <= LOOKBACK_BARS) return null;
  let high = closes[closes.length - 1 - LOOKBACK_BARS]!;
  for (let i = closes.length - LOOKBACK_BARS; i < closes.length - 1; i++) {
    if (closes[i]! > high) high = closes[i]!;
  }
  return high;
}

await runBars({
  onBatch(state, batch: Batch): OrderInput[] {
    // Fold this batch's fills into the position bookkeeping first. A fill
    // priced here is the fill of an order decided on the previous batch.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' || fill.client_id.startsWith('_')) continue;
      if (fill.symbol !== SYMBOL) continue;
      if (fill.side === 'buy') {
        entryPrice = BigInt(fill.price);
        entrySeq = fill.decided_bar - state.warmupBars;
        // Peak starts at the close of the bar the buy was decided on: the
        // last close recorded before this batch's bar.
        peakClose = closes.length > 0 ? closes[closes.length - 1]! : entryPrice;
      } else if (fill.side === 'sell') {
        entryPrice = null;
        entrySeq = -1;
        peakClose = 0n;
      }
    }

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    closes.push(close);
    const seq = scoredSeq(state);

    // Dip evaluation for this bar (null while history builds or warming
    // up: warm-up bars only build history, they never arm or reset).
    const high = state.warmingUp ? null : rollingHigh();
    const isDipped = high === null ? null : close * BPS <= high * (BPS - DIP_BPS);
    if (isDipped === false) prevDipped = false;

    const held = state.positions.get(SYMBOL);
    const holding = held !== undefined && held.qty > 0n;

    if (holding) {
      if (entryPrice === null) {
        // Defensive only: a position whose buy fill was never seen. Anchor
        // the exits at this close rather than holding without any exit.
        entryPrice = close;
        entrySeq = seq;
        peakClose = close;
        return [];
      }
      if (close > peakClose) peakClose = close;
      const entry = entryPrice;
      const stopHit = close * BPS <= entry * (BPS - STOP_BPS);
      const profitHit = close * BPS >= entry * (BPS + TAKE_PROFIT_BPS);
      const trailHit = peakClose > entry && close * BPS <= peakClose * (BPS - TRAIL_BPS);
      const stale = seq - entrySeq >= MAX_HOLD_BARS;
      if (stopHit || profitHit || trailHit || stale) {
        cooldownUntil = seq + 1 + COOLDOWN_BARS;
        return [{ side: 'sell', symbol: SYMBOL, qty: held!.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: consider an entry.
    if (isDipped === null || isDipped === false) return [];
    if (seq < cooldownUntil) return [];
    if (seq > LAST_ENTRY_SEQ) return [];
    if (state.cash < MIN_NOTIONAL) return [];
    const crossing = !prevDipped;
    prevDipped = true;
    if (!crossing) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
