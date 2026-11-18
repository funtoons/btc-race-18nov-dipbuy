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
//
// Guardrail fallback: if the main rule has still filled nothing by scored
// bar 1200 (a window with no deep washout at all), a shallower dip rule
// arms itself so the entry can still meet the race window's minimum-trade
// guardrail instead of sitting out the whole window. It uses the same
// crossing logic with a 120-bar high and a 70 bp dip, tight 50 bp take
// profit / 60 bp stop / 60-bar exits, and never fires on a window where
// the main rule already traded (the dev window included).

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
// Fallback rule (see the header comment).
const FB_ARM_SEQ = 1200;
const FB_LOOKBACK_BARS = 120;
const FB_DIP_BPS = 70n;
const FB_TAKE_PROFIT_BPS = 50n;
const FB_STOP_BPS = 60n;
const FB_MAX_HOLD_BARS = 60;
const FB_COOLDOWN_BARS = 10;
const FB_LAST_ENTRY_SEQ = 1420;

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
// Own filled orders so far (either side, harness closes excluded).
let fillsCount = 0;
// Which rule opened the current position, and which rule the outstanding
// buy decision (if any) belongs to.
let entryKind: 'main' | 'fallback' | null = null;
let pendingKind: 'main' | 'fallback' | null = null;
// Crossing memory for the fallback rule, kept apart from the main rule's.
let prevFbDipped = false;

function scoredSeq(state: BarsState): number {
  return state.seq - state.warmupBars;
}

function rollingHigh(lookback: number): bigint | null {
  // Max of the `lookback` closes strictly before the current bar.
  if (closes.length <= lookback) return null;
  let high = closes[closes.length - 1 - lookback]!;
  for (let i = closes.length - lookback; i < closes.length - 1; i++) {
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
      fillsCount++;
      if (fill.side === 'buy') {
        entryPrice = BigInt(fill.price);
        entrySeq = fill.decided_bar - state.warmupBars;
        entryKind = pendingKind ?? 'main';
        pendingKind = null;
        // Peak starts at the close of the bar the buy was decided on: the
        // last close recorded before this batch's bar.
        peakClose = closes.length > 0 ? closes[closes.length - 1]! : entryPrice;
      } else if (fill.side === 'sell') {
        entryPrice = null;
        entrySeq = -1;
        entryKind = null;
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
    const high = state.warmingUp ? null : rollingHigh(LOOKBACK_BARS);
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
        entryKind = 'main';
        peakClose = close;
        return [];
      }
      if (close > peakClose) peakClose = close;
      const entry = entryPrice;
      const fallback = entryKind === 'fallback';
      const takeProfit = fallback ? FB_TAKE_PROFIT_BPS : TAKE_PROFIT_BPS;
      const stop = fallback ? FB_STOP_BPS : STOP_BPS;
      const maxHold = fallback ? FB_MAX_HOLD_BARS : MAX_HOLD_BARS;
      const stopHit = close * BPS <= entry * (BPS - stop);
      const profitHit = close * BPS >= entry * (BPS + takeProfit);
      const trailHit = !fallback && peakClose > entry && close * BPS <= peakClose * (BPS - TRAIL_BPS);
      const stale = seq - entrySeq >= maxHold;
      if (stopHit || profitHit || trailHit || stale) {
        cooldownUntil = seq + 1 + (fallback ? FB_COOLDOWN_BARS : COOLDOWN_BARS);
        return [{ side: 'sell', symbol: SYMBOL, qty: held!.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: consider the main entry first.
    if (isDipped === true) {
      if (seq >= cooldownUntil && seq <= LAST_ENTRY_SEQ && state.cash >= MIN_NOTIONAL) {
        const crossing = !prevDipped;
        prevDipped = true;
        if (crossing) {
          pendingKind = 'main';
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      // Dipped but gated, or a continuing episode: fall through to the
      // fallback check below only when the main rule cannot fire at all
      // (it can still fire later in this episode once the gates open, so
      // the fallback must not steal a dipped bar from it).
      if (seq <= LAST_ENTRY_SEQ) return [];
    }

    // Flat: the guardrail fallback. It arms only when nothing has ever
    // filled and the window is nearly over.
    if (state.warmingUp || fillsCount > 0 || seq < FB_ARM_SEQ || seq > FB_LAST_ENTRY_SEQ) return [];
    if (seq < cooldownUntil || state.cash < MIN_NOTIONAL) return [];
    const fbHigh = rollingHigh(FB_LOOKBACK_BARS);
    if (fbHigh === null) return [];
    const fbDipped = close * BPS <= fbHigh * (BPS - FB_DIP_BPS);
    if (!fbDipped) {
      prevFbDipped = false;
      return [];
    }
    const fbCrossing = !prevFbDipped;
    prevFbDipped = true;
    if (!fbCrossing) return [];
    pendingKind = 'fallback';
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
