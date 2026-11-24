// Survivor-momentum strategy for agent-fun/replay/v2 (pump.fun bonding curves).
//
// Idea: fresh launches are mostly traps, so this bot never buys one. A coin
// first has to prove it can live: enough slots since creation, a real SOL
// reserve that shows strangers actually paid in, a crowd of distinct buyers
// with no single wallet dominating, a creator who has not sold, a reserve
// that is still growing over the recent tape, and a price that is not pinned
// to its all-time high (the second leg, not the top). Only then does it buy
// one small fixed stake.
//
// Exits: a trailing stop rides winners once they are meaningfully up, a hard
// stop caps each loss early, and a hard time stop, a quiet-tape exit and an
// instant exit on any creator sale bound the rest. One entry per coin, ever.
//
// Pacing: the house only ranks entries that round-trip at least 0.01 SOL on
// at least 20 coins, and the final window is a fixed 6 hours, so the bot
// paces itself against the tape's own timestamps: it aims for 24 entries per
// 6 hours and, whenever it falls behind that pace, steps down through two
// looser filter tiers (younger coins, smaller reserves) until it catches up.
// In a rich window it never leaves the strict tier.
//
// Pure function of the batches: no clock, no randomness, no I/O.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Tape evidence required before entry (all tiers). */
  minBuyers: number;
  /** Buys must be at least this share of other people's traded SOL (bps). */
  minBuyShareBps: number;
  /** Largest single non-creator buyer's share of bought SOL, at most (bps). */
  maxWhaleShareBps: number;
  /** Reserve-growth window (slots). */
  growthWindow: number;
  /** Price at most this share of its peak price (bps): skip pinned tops. */
  maxPeakShareBps: number;
  /** Lamports per entry. */
  stakeLamports: bigint;
  /** Slippage tolerated on buys (bps). */
  buySlippageBps: number;
  /** Hard stop: exit when value falls to this share of cost (bps). */
  hardStopBps: number;
  /** Trailing stop: arms at this gain over cost (bps), exits on this give-back from the peak value (bps). */
  trailArmBps: number;
  trailGivebackBps: number;
  /** Hard time stop (slots held) and quiet-tape exit (slots without a trade). */
  maxHoldSlots: number;
  quietSlots: number;
  /** Pacing: entries aimed for per 6 hours of tape time. */
  pacePer6h: number;
}

export const DEFAULT_PARAMS: Params = {
  minBuyers: 12,
  minBuyShareBps: 5_500,
  maxWhaleShareBps: 5_000,
  growthWindow: 60,
  maxPeakShareBps: 9_500,
  stakeLamports: 80_000_000n,
  buySlippageBps: 1_500,
  hardStopBps: 8_500,
  trailArmBps: 2_000,
  trailGivebackBps: 2_800,
  maxHoldSlots: 300,
  quietSlots: 30,
  pacePer6h: 24,
};

interface Tier {
  minAgeSlots: number;
  minRealSol: bigint;
  maxRealSol: bigint;
  minTrades: number;
  minGrowthBps: number;
}

/** Strictest first; the pacing rule steps down only while behind pace. */
const TIERS: Tier[] = [
  { minAgeSlots: 250, minRealSol: 10_000_000_000n, maxRealSol: 60_000_000_000n, minTrades: 40, minGrowthBps: 300 },
  { minAgeSlots: 150, minRealSol: 8_000_000_000n, maxRealSol: 60_000_000_000n, minTrades: 30, minGrowthBps: 300 },
  { minAgeSlots: 150, minRealSol: 6_000_000_000n, maxRealSol: 60_000_000_000n, minTrades: 25, minGrowthBps: 300 },
];

interface ReserveSample {
  slot: number;
  rq: bigint;
}

interface Coin {
  createdSlot: number;
  creator: Pubkey;
  creatorSold: boolean;
  trades: number;
  buyers: Map<Pubkey, bigint>;
  boughtSol: bigint;
  soldSol: bigint;
  lastTradeSlot: number;
  /** Price peak as a reserves pair (ratio vq/vt is maximal). */
  peakVq: bigint;
  peakVt: bigint;
  samples: ReserveSample[];
  entered: boolean;
}

interface Held {
  sinceSlot: number;
  peakValue: bigint;
}

const FEE_BPS = 125n;

/** SOL a sale of `tokens` would return against (vq, vt), curve fees taken off. */
function liquidationValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  return gross - (gross * FEE_BPS + BPS - 1n) / BPS;
}

/** a/b >= c/d, all positive bigints, without floats. */
function ratioAtLeast(a: bigint, b: bigint, c: bigint, d: bigint): boolean {
  return a * d >= c * b;
}

export function createStrategy(params: Params = DEFAULT_PARAMS) {
  // Lamport knobs may arrive as plain numbers from a JSON sweep: normalise.
  const P: Params = { ...params, stakeLamports: BigInt(params.stakeLamports) };
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  let firstTime: number | null = null;
  let nowTime = 0;
  let entries = 0;

  function watch(batch: Batch): void {
    for (const e of batch.events) {
      const t = Number(e.timestamp);
      if (firstTime === null) firstTime = t;
      if (t > nowTime) nowTime = t;
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          coins.set(e.mint, {
            createdSlot: e.slot,
            creator: e.creator,
            creatorSold: false,
            trades: 0,
            buyers: new Map(),
            boughtSol: 0n,
            soldSol: 0n,
            lastTradeSlot: e.slot,
            peakVq: BigInt(e.virtual_quote_reserves),
            peakVt: BigInt(e.virtual_token_reserves),
            samples: [{ slot: e.slot, rq: 0n }],
            entered: false,
          });
        }
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        if (e.is_buy) {
          c.boughtSol += sol;
          if (e.user !== c.creator) c.buyers.set(e.user, (c.buyers.get(e.user) ?? 0n) + sol);
        } else {
          c.soldSol += sol;
          if (e.user === c.creator) c.creatorSold = true;
        }
        const vq = BigInt(e.virtual_quote_reserves);
        const vt = BigInt(e.virtual_token_reserves);
        if (ratioAtLeast(vq, vt, c.peakVq, c.peakVt)) {
          c.peakVq = vq;
          c.peakVt = vt;
        }
        c.samples.push({ slot: e.slot, rq: BigInt(e.real_quote_reserves) });
        const floor = e.slot - P.growthWindow;
        while (c.samples.length > 1 && c.samples[1].slot <= floor) c.samples.shift();
      }
    }
  }

  function hasPending(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint) return true;
    return false;
  }

  /** Which filter tier the pace currently allows: 0 strict, 1 medium, 2 loose.
   * The pace is measured against a 6-hour horizon (the scored window's
   * length): the target stops growing after 6 hours of tape, so on a longer
   * tape the strict tier takes over for good once the target is met. */
  function tierNow(): number {
    if (firstTime === null) return 0;
    const elapsed = Math.min(Math.max(0, nowTime - firstTime), 21_600);
    const due = Math.ceil((P.pacePer6h * elapsed) / 21_600);
    const deficit = due - entries;
    if (deficit >= 5) return 2;
    if (deficit >= 2) return 1;
    return 0;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    watch(batch);
    const orders: OrderInput[] = [];
    const slot = batch.slot;

    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    // Exits first: they free position slots and stop losses early.
    for (const [mint, pos] of state.positions) {
      let h = held.get(mint);
      if (h === undefined) {
        h = { sinceSlot: slot, peakValue: 0n };
        held.set(mint, h);
      }
      if (hasPending(state, mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const value = liquidationValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (value > h.peakValue) h.peakValue = value;
      const cost = pos.cost_lamports;
      const c = coins.get(mint);
      let exit = false;
      if (value * BPS <= cost * BigInt(P.hardStopBps)) exit = true;
      else if (
        h.peakValue * BPS >= cost * BigInt(10_000 + P.trailArmBps) &&
        value * BPS <= h.peakValue * BigInt(10_000 - P.trailGivebackBps)
      ) exit = true;
      else if (slot - h.sinceSlot >= P.maxHoldSlots) exit = true;
      else if (c !== undefined && c.creatorSold) exit = true;
      else if (c !== undefined && slot - c.lastTradeSlot >= P.quietSlots) exit = true;
      if (exit) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }
    }

    // Entries, while position slots and cash allow.
    const tier = TIERS[tierNow()];
    let committed = state.committedPositionCount();
    for (const [mint, c] of coins) {
      if (orders.length >= 16) break;
      if (committed >= state.hello.caps.max_open_positions) break;
      if (c.entered || c.creatorSold) continue;
      if (slot - c.createdSlot < tier.minAgeSlots) continue;
      if (c.trades < tier.minTrades || c.buyers.size < P.minBuyers) continue;
      const traded = c.boughtSol + c.soldSol;
      if (traded === 0n || (c.boughtSol * BPS) / traded < BigInt(P.minBuyShareBps)) continue;
      let whale = 0n;
      for (const v of c.buyers.values()) if (v > whale) whale = v;
      if (c.boughtSol > 0n && (whale * BPS) / c.boughtSol > BigInt(P.maxWhaleShareBps)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < tier.minRealSol || curve.real_quote_reserves > tier.maxRealSol) continue;
      const base = c.samples[0];
      if (base === undefined || base.rq === 0n) continue;
      if (slot - base.slot > P.growthWindow + 30) continue;
      if ((curve.real_quote_reserves * BPS) / base.rq < BigInt(10_000 + tier.minGrowthBps)) continue;
      // Not pinned to the top: skip when the current price is above
      // maxPeakShareBps of the peak price (vq/vt vs peakVq/peakVt).
      if (
        curve.virtual_quote_reserves * c.peakVt * BPS >
        curve.virtual_token_reserves * c.peakVq * BigInt(P.maxPeakShareBps)
      ) continue;
      if (state.positions.has(mint) || hasPending(state, mint)) continue;
      const cap = state.maxBuyLamports(mint);
      const amount = P.stakeLamports < cap ? P.stakeLamports : cap;
      if (amount < 10_000_000n) continue;
      if (state.freeCashLamports() - amount < 0n) break;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
      c.entered = true;
      entries += 1;
      committed += 1;
    }
    return orders;
  }

  return { onBatch };
}
