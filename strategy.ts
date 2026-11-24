// RQ-trail strategy for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// What the dev window showed (see the analysis notes, not the code below):
//   - Buying AFTER a run-up loses: a coin up 5-50% over 30 slots is flat-to-down
//     over the next 100 slots on average. Momentum does not persist here.
//   - Buying dips loses too: a coin 30-45% below its recent high keeps falling.
//     Dips are dumps, not bounces.
//   - Buying at the real-SOL cross works: when a fresh curve's real SOL first
//     crosses a few SOL, the coin usually pumps further and then dumps. A
//     trailing stop from the peak banks the middle of that move: on the dev
//     window, buy at the RQ>=3 cross with a 20% trail averages about +50% per
//     trade before fees, with half the trades positive. No take-profit: the
//     few coins that run 5-10x pay for the many small losses.
//   - The creator selling early is a strong negative filter: coins whose
//     creator held reach 5x about 5x as often as ones whose creator sold.
//
// One catch: a bot acts per batch, and a bundled launch pumps ~20 SOL and 2-3x
// in its create slot, so a naive cross entry buys the top and eats the dump
// eleven slots later. Crosses that jump too far in one batch are skipped as
// bundles; a coin that dumps and re-crosses later gets a fresh look.
//
// So: enter once per coin, on the batch its real SOL first crosses entryRqSol
// (young coins only, creator still holding, no bundle jump), one small buy. Exit on a trailing
// stop from the position's best sell value, on a hard stop against cost, when
// the creator sells, when the coin goes quiet, or at a time limit. The replay
// closes a position at its final reserves when its curve completes, which is
// the best exit of all. Guardrail probes (tiny round trips) only fire if the
// run's own fills or coins fall behind the pace the guardrail needs.
//
// Deterministic by construction: no clock, no randomness, no I/O. Iteration is
// only over insertion-ordered maps fed by the batch stream, and the only time
// used is block time carried by the events themselves.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Buy when a coin's real SOL first reaches this (SOL). */
  entryRqSol: number;
  /** Skip the cross when real SOL jumped more than this (SOL) within the cross
   *  batch: a bundled launch pumps ~20 SOL in its create slot and dumps it all
   *  back within a dozen slots, and a batch-based bot can only buy the top. */
  maxCrossJumpSol: number;
  /** The cross must happen at least this many slots after the CreateEvent. */
  minCrossAge: number;
  /** When real SOL falls back below this after a cross (and the coin was never
   *  entered), forget the cross: a later re-cross is a fresh entry. 0 = off. */
  recrossLowSol: number;
  /** The cross must happen within this many slots of the CreateEvent. */
  maxEntryAge: number;
  /** Slots after the cross during which an entry may still be taken. */
  entryWindow: number;
  /** SOL to put into one position (each buy is also capped at 1% of real SOL). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when the sell value falls this far below its peak since entry. */
  trail: number;
  /** Backstop: exit when the sell value falls this far below cost. */
  stopLoss: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when no trade has hit the coin for this many slots. */
  stallSlots: number;
  /** Exit at once when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Extra buys after the first, each on a later batch while the price holds up. */
  maxAdds: number;
  /** SOL per add (each still capped at 1% of real SOL). */
  addSol: number;
  /** An add needs the price at least this far above the last buy's decision price. */
  addStep: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing: the run must end with at least 20 coins traded. When the
   *  bot's own fills or coins lag targetFills / targetCoins scaled by the share
   *  of paceSecs elapsed (block time since the first batch), it opens tiny probe
   *  round trips (buy probeSol, sell it all as soon as the buy lands). */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  entryRqSol: 2,
  maxCrossJumpSol: 2,
  minCrossAge: 0,
  recrossLowSol: 1,
  maxEntryAge: 1000,
  entryWindow: 50,
  stakeSol: 0.1,
  minBuySol: 0.01,
  buySlipBps: 1500,
  trail: 0.25,
  stopLoss: 0.35,
  maxHold: 5000,
  stallSlots: 50,
  exitOnDevSell: true,
  maxAdds: 0,
  addSol: 0.05,
  addStep: 0,
  maxExposureSol: 2,
  targetCoins: 25,
  targetFills: 200,
  paceSecs: 21_600,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
/** Curve fees on a sale: protocol 95 bps + creator 30 bps. */
const CURVE_FEE = 0.0125;

interface Book {
  created: number | null;
  creator: Pubkey | null;
  /** Slot the real SOL first crossed entryRqSol (-1 = not yet). */
  crossed: number;
  /** The creator sold at least once. */
  devSold: boolean;
  /** Slot of the most recent trade on this coin. */
  lastTrade: number;
  /** Real SOL (SOL) at the end of the previous batch (0 before the first). */
  lastRq: number;
  /** Entered once already (or skipped for good): never buy it again. */
  done: boolean;
}

interface Held {
  opened: number;
  /** Best sell value seen since entry (SOL, fees deducted). */
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  /** A sell is already in flight. */
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastAddPrice: number;
  adds: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const books = new Map<Pubkey, Book>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint. */
  const probes = new Set<Pubkey>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const bookOf = (mint: Pubkey): Book => {
    let b = books.get(mint);
    if (b === undefined) {
      b = { created: null, creator: null, crossed: -1, devSold: false, lastTrade: -1, lastRq: 0, done: false };
      books.set(mint, b);
    }
    return b;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const b = bookOf(e.mint);
          b.created = e.slot;
          b.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const b = bookOf(e.mint);
          b.lastTrade = e.slot;
          traded.add(e.mint);
          if (!e.is_buy && b.creator !== null && e.user === b.creator) b.devSold = true;
        } else {
          bookOf(e.mint).done = true;
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      /** Sell value of a position now (SOL, curve and tx fees deducted). */
      const valueOf = (mint: Pubkey, tokens: bigint): number => {
        const curve = state.curves.get(mint);
        if (curve === undefined) return 0;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const t = Number(tokens);
        return ((t * vq) / (vt + t) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            bookOf(mint).done = true;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = valueOf(mint, pos.token_amount);
        if (value > h.peakValue) h.peakValue = value;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        const b = bookOf(mint);
        let exit = h.exiting;
        if (!exit && h.peakValue > 0 && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && p.exitOnDevSell && b.devSold) exit = true;
        if (!exit && b.lastTrade >= 0 && now - b.lastTrade > p.stallSlots) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const mint of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const b = books.get(mint)!;
        const h = held.get(mint);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        if (h === undefined) {
          if (b.done || slotsLeft <= 0) continue;
          // A dumped coin that never got entered may cross again later.
          if (b.crossed >= 0 && p.recrossLowSol > 0 && rqSol < p.recrossLowSol) b.crossed = -1;
          // The entry moment: the first batch real SOL is at or above the line.
          if (b.crossed < 0) {
            if (rqSol < p.entryRqSol) continue;
            // A bundle pumps its whole stake in one batch: untradeable.
            if (rqSol - b.lastRq > p.maxCrossJumpSol) {
              b.done = true;
              continue;
            }
            if (b.created !== null && now - b.created < p.minCrossAge) {
              b.done = true;
              continue;
            }
            b.crossed = now;
          }
          if (now - b.crossed > p.entryWindow) {
            b.done = true;
            continue;
          }
          if (b.created === null || b.crossed - b.created > p.maxEntryAge) {
            b.done = true;
            continue;
          }
          if (b.devSold) {
            b.done = true;
            continue;
          }
          const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
          let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          const lamports = BigInt(Math.floor(amount * LAMPORTS));
          orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          exposure += amount;
          held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, lastAddPrice: price, adds: 0 });
          b.done = true;
          slotsLeft--;
        } else {
          // Adds only into strength: price above the last buy's, position filled.
          if (p.maxAdds <= 0 || h.exiting || !h.filled || h.adds >= p.maxAdds) continue;
          if (h.invested >= p.stakeSol - p.minBuySol) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
          let amount = Math.min(capSol, p.addSol, p.stakeSol - h.invested, p.maxExposureSol - exposure);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          const lamports = BigInt(Math.floor(amount * LAMPORTS));
          orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          exposure += amount;
          h.invested += amount;
          h.lastAddPrice = price;
          h.adds++;
        }
      }

      // Remember this batch's real SOL for the next batch's jump check.
      for (const mint of traded) {
        const curve = state.curves.get(mint);
        if (curve !== undefined) books.get(mint)!.lastRq = Number(curve.real_quote_reserves) / LAMPORTS;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.add(mint);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
