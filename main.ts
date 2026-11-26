// Pump.fun Paper Sprint: "Fresh-Momentum Rotation" bot.
//
// Idea: pump.fun coins mostly dump after launch, so buy-and-hold loses. This bot
// buys only coins that are already proving demand — several distinct buyers,
// net SOL flowing in, price rising and sitting near its recent high — then exits
// fast on a stop-loss, a trailing stop once it is up, or a time limit. With at
// most 5 open positions it rotates through many coins, which also clears the
// guardrail (a round trip of >= 0.01 SOL on each of at least 20 coins). A small
// probe trade keeps the coin count on pace when momentum entries go quiet.
//
// Fully deterministic: no clock, no randomness, no environment reads. All
// iteration is over insertion-ordered maps fed by the batch stream, so the two
// grading executions produce byte-identical action logs.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9; // lamports per SOL, as a float for signal math

// --- tuning ---------------------------------------------------------------

// Entry window: the last N recorded trades on a curve.
const WINDOW_TRADES = 20;
// Entry needs at least this net SOL flowing in (buys minus sells) over the window.
const MIN_NET_SOL = 1.0;
// Entry needs at least this many buy trades and distinct buyers in the window.
const MIN_BUYS = 5;
const MIN_BUYERS = 5;
// Price now must be up at least this much over the window start, and no more
// than this much (skip coins that already ran too far in one window).
const MIN_PRICE_UP = 0.05;
const MAX_PRICE_UP = 2.0;
// Price now must sit at least this close to the window high.
const NEAR_HIGH = 0.95;
// Curve must be at least this old (slots since its CreateEvent) to enter:
// fresh curves are mostly bundled launches that get dumped immediately.
const MIN_AGE_SLOTS = 500;
// Real SOL reserves at entry must sit inside this band.
const MIN_RQ_SOL = 0.5;
const MAX_RQ_SOL = 80;
// SOL staked on one position (capped by the 1%-of-real-reserve order cap).
const STAKE_SOL = 0.2;
// Smallest buy worth sending (the guardrail needs round trips >= 0.01 SOL).
const MIN_BUY_SOL = 0.011;
// Slippage: buys tight-ish, sells wide open so an exit is never refused.
const BUY_SLIP_BPS = 1500;
const SELL_SLIP_BPS = 10_000;
// Exits: stop-loss vs cost, trailing stop once armed, time limit in slots.
const STOP_LOSS = 0.85;
const TRAIL_ARM = 1.1;
const TRAIL_KEEP = 0.85;
const MAX_HOLD_SLOTS = 1200;
// Hard take-profit: bank a winner before it retraces.
const TAKE_PROFIT = 1.5;
// Don't re-enter a curve too soon after an exit; at most 2 entries per curve.
const COOLDOWN_SLOTS = 150;
const MAX_ENTRIES_PER_CURVE = 2;
// Most momentum positions open at once (one slot is kept free for probes).
const MAX_MAIN = 4;
// Probe trades: keep the distinct-coin count on pace when entries go quiet.
const PROBE_SOL = 0.02;
const PROBE_EVERY_BATCHES = 5000;
const TARGET_COINS = 25;

// --- per-curve tape -------------------------------------------------------

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  entryPrice: number;
  probe: boolean;
  /** A sell is already sent and awaiting its fill; don't sell twice. */
  exiting: boolean;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
/** Mints whose probe buy filled and whose sell goes out on the next batch. */
const probeSelling = new Set<Pubkey>();
/** Coins with a completed round trip (a sell fill on a coin we bought). */
const roundTripped = new Set<Pubkey>();
/** Batches answered so far, for probe pacing. */
let batchesSeen = 0;
/** Batches since the last probe buy. */
let batchesSinceProbe = 0;

function priceOf(state: BotState, mint: Pubkey): number {
  const c = state.curves.get(mint);
  if (c === undefined) return 0;
  const vt = Number(c.virtual_token_reserves);
  if (vt <= 0) return 0;
  return Number(c.virtual_quote_reserves) / vt;
}

function valueSol(state: BotState, mint: Pubkey, tokens: bigint): number {
  return (Number(tokens) * priceOf(state, mint)) / LAMPORTS;
}

function tapeFor(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: 0 };
    tapes.set(mint, t);
  }
  return t;
}

interface Signal {
  ok: boolean;
  netSol: number;
  buys: number;
  buyers: number;
  priceUp: number;
  nearHigh: number;
}

function signal(t: Tape): Signal {
  const w = t.trades.slice(-WINDOW_TRADES);
  const bad: Signal = { ok: false, netSol: 0, buys: 0, buyers: 0, priceUp: 0, nearHigh: 0 };
  if (w.length < 8) return bad;
  let netSol = 0;
  let buys = 0;
  const buyers = new Set<string>();
  let high = 0;
  for (const tr of w) {
    netSol += tr.buy ? tr.sol : -tr.sol;
    if (tr.buy) {
      buys += 1;
      buyers.add(tr.user);
    }
    if (tr.price > high) high = tr.price;
  }
  const first = w[0].price;
  const last = w[w.length - 1].price;
  if (first <= 0 || last <= 0 || high <= 0) return bad;
  const priceUp = last / first - 1;
  const nearHigh = last / high;
  const ok =
    netSol >= MIN_NET_SOL &&
    buys >= MIN_BUYS &&
    buyers.size >= MIN_BUYERS &&
    priceUp >= MIN_PRICE_UP &&
    priceUp <= MAX_PRICE_UP &&
    nearHigh >= NEAR_HIGH;
  return { ok, netSol, buys, buyers: buyers.size, priceUp, nearHigh };
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    batchesSeen += 1;
    batchesSinceProbe += 1;
    const orders: OrderInput[] = [];
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();

    // Fold fills in: track round trips, probe fills, and position exits.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.side === 'sell') {
        const h = held.get(f.mint);
        if (h !== undefined) {
          held.delete(f.mint);
          const t = tapes.get(f.mint);
          if (t !== undefined) t.lastExit = state.slot;
          roundTripped.add(f.mint);
        }
        probeSelling.delete(f.mint);
      }
      if (f.side === 'buy') {
        const h = held.get(f.mint);
        if (h !== undefined && h.probe) probeSelling.add(f.mint);
      }
    }
    // Positions the harness closed for us (complete/flatten) are gone from
    // state.positions; drop their bookkeeping too.
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) {
        held.delete(mint);
        probeSelling.delete(mint);
        roundTripped.add(mint);
        const t = tapes.get(mint);
        if (t !== undefined) t.lastExit = state.slot;
      }
    }

    // --- exits: stop-loss, trailing stop, time limit, probe sell ---------
    for (const [mint, pos] of state.positions) {
      const h = held.get(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (cost <= 0) continue;
      const value = valueSol(state, mint, pos.token_amount);
      if (h === undefined) {
        // A position we hold without bookkeeping (should not happen): sell it
        // rather than leave it unmanaged.
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
        continue;
      }
      if (h.exiting) continue; // sell already sent, awaiting its fill
      if (value > h.peakValue) h.peakValue = value;
      const heldSlots = state.slot - h.opened;
      let exit = false;
      if (h.probe && probeSelling.has(mint)) exit = true; // probe: sell at once
      else if (value <= STOP_LOSS * cost) exit = true; // stop-loss
      else if (h.peakValue >= TRAIL_ARM * cost && value <= TRAIL_KEEP * h.peakValue) exit = true; // trailing stop
      else if (value >= TAKE_PROFIT * cost) exit = true; // take-profit
      else if (heldSlots >= MAX_HOLD_SLOTS && value < 2 * cost) exit = true; // time limit (winners ride)
      if (exit) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIP_BPS });
        h.exiting = true;
        const t = tapes.get(mint);
        if (t !== undefined) t.lastExit = state.slot;
      }
    }

    // --- entries: evaluate only curves that traded in this batch ---------
    let mainSlots = MAX_MAIN - [...held.values()].filter((h) => !h.probe).length;
    // Probes also occupy a slot; count them against the overall cap via
    // committedPositionCount below.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = tapeFor(e.mint);
        if (t.created === null) t.created = e.slot;
        continue;
      }
      if (e.event !== 'TradeEvent') continue;
      const t = tapeFor(e.mint);
      if (t.created === null) t.created = e.slot;
      const p = priceOf(state, e.mint);
      t.trades.push({
        slot: e.slot,
        buy: e.is_buy,
        sol: Number(e.sol_amount) / LAMPORTS,
        user: e.user,
        price: p,
      });
      if (t.trades.length > 40) t.trades.splice(0, t.trades.length - 40);

      // Entry decision, once per curve per batch at most.
      if (held.has(e.mint)) continue;
      if (state.committedPositionCount() >= caps.max_open_positions) continue;
      if (mainSlots <= 0) continue;
      if (orders.length >= caps.max_orders_per_batch) continue;
      if (t.entries >= MAX_ENTRIES_PER_CURVE) continue;
      if (state.slot - t.lastExit < COOLDOWN_SLOTS && t.lastExit !== 0) continue;
      if (t.created !== null && state.slot - t.created < MIN_AGE_SLOTS) continue;
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) continue;
      const rq = Number(curve.real_quote_reserves) / LAMPORTS;
      if (rq < MIN_RQ_SOL || rq > MAX_RQ_SOL) continue;
      const s = signal(t);
      if (!s.ok) continue;
      const cap = state.maxBuyLamports(e.mint);
      const stake = BigInt(Math.floor(STAKE_SOL * LAMPORTS));
      const amount = cap < stake ? cap : stake;
      if (amount < BigInt(Math.floor(MIN_BUY_SOL * LAMPORTS))) continue;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: BUY_SLIP_BPS });
      free -= amount + tx;
      mainSlots -= 1;
      t.entries += 1;
      held.set(e.mint, {
        opened: state.slot,
        peakValue: 0,
        entryPrice: p,
        probe: false,
        exiting: false,
      });
    }

    // --- probe: a tiny round trip to keep the coin count on pace --------
    if (
      roundTripped.size < TARGET_COINS &&
      batchesSinceProbe >= PROBE_EVERY_BATCHES &&
      state.committedPositionCount() < caps.max_open_positions &&
      orders.length < caps.max_orders_per_batch
    ) {
      let bestMint: Pubkey | null = null;
      let bestRq = 0;
      for (const [mint, curve] of state.curves) {
        if (curve.complete || held.has(mint)) continue;
        if (roundTripped.has(mint)) continue;
        const rq = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rq < 2) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < BigInt(Math.floor(PROBE_SOL * LAMPORTS))) continue;
        const t = tapes.get(mint);
        if (t === undefined || t.trades.length < 5) continue;
        if (rq > bestRq) {
          bestRq = rq;
          bestMint = mint;
        }
      }
      if (bestMint !== null) {
        const amount = BigInt(Math.floor(PROBE_SOL * LAMPORTS));
        if (free >= amount + tx) {
          orders.push({ side: 'buy', mint: bestMint, quote_lamports: amount, max_slippage_bps: SELL_SLIP_BPS });
          free -= amount + tx;
          batchesSinceProbe = 0;
          held.set(bestMint, {
            opened: state.slot,
            peakValue: 0,
            entryPrice: priceOf(state, bestMint),
            probe: true,
            exiting: false,
          });
          const t = tapes.get(bestMint);
          if (t !== undefined) t.entries += 1;
        }
      }
    }

    return orders;
  },
});
