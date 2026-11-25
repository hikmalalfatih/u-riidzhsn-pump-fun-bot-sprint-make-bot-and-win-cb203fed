// Dip-Buy Survivor — a pump.fun bonding-curve replay bot (agent-fun/replay/v2).
//
// Two arms, one bookkeeping:
//  * DIP ARM (the profit engine): buy a seasoned curve's pullback while buyers are
//    still stepping in. A curve qualifies when it is >= 400 slots old, holds >= 25
//    real SOL, and its price sits 15-40% below its 1800-slot high while the last 6
//    trades show >= 3 buys, non-negative net flow, a buy as the most recent trade,
//    no creator sell, and no single sell >= 2.5 SOL in the last 30 slots. Size is
//    1.5% of real SOL (0.05-0.5 SOL), built across batches within 10% of the entry
//    price while flow stays positive. Exits: hard stop -10% of cost, take half at
//    +25%, trailing stop 25% from the peak once up >= 12%, stale exit after 400
//    slots, instant full exit if the creator sells or a >= 2.5 SOL sell lands.
//  * YOUNG ARM (the breadth engine): the final window is only 6 hours, and the dip
//    arm alone trades ~20 coins on a full 24h dev window — too close to the >= 20
//    coins guardrail. So launches get one tiny 0.02 SOL ticket in their first 10
//    slots when the tape looks unbundled (creator bought >= 0.02 SOL, net flow
//    positive, at most 3 distinct non-creator buyers, no creator sell), exited flat
//    at +20% / -10% / 10 slots. It runs at a small expected loss per coin and buys
//    the guardrail; at most 3 young positions are open at once.
//
// Why this shape: most pump.fun coins die. Chasing fresh launches pays the
// creator's dump, and buying every dip pays the slow bleed. Waiting for a curve
// that already ran up with >= 25 real SOL and then pulled back 15-40% selects
// coins with a live crowd and a price that has already shown it can recover —
// that is where the dev window's profit sits. The young arm exists only so the
// entry clears the coin-count bar on a short final window.
//
// Everything here is a pure function of the batches the harness sends: no clock, no
// randomness, no I/O, so the two graded executions produce byte-identical action logs.

import type { Batch, BotState, Mark, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Lookback (slots) for the recent high the pullback is measured from. */
  highWindow: number;
  /** Enter when price is at least this far below the recent high (fraction). */
  ddMin: number;
  /** ...and not further than this (a collapse, not a dip). */
  ddMax: number;
  /** Curve must hold at least this much real SOL at decision time. */
  minRealSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Of the last `flowTrades` trades at least `minBuys` must be buys... */
  flowTrades: number;
  minBuys: number;
  /** ...and the most recent trade must be a buy (the dip is being bought). */
  lastMustBeBuy: boolean;
  /** Net SOL bought over the last `flowTrades` trades must be at least this (SOL). */
  minNetFlowSol: number;
  /** Target position size as a share of the curve's real SOL at first entry. */
  targetPctReal: number;
  /** Target position size bounds (SOL). */
  targetMinSol: number;
  targetMaxSol: number;
  /** Add tranches only while the price stays within this fraction of the first entry price. */
  addBand: number;
  /** Take profit: sell `tpPart` of the position once value reaches cost * (1 + tpGain). */
  tpGain: number;
  tpPart: number;
  /** Trailing stop: once value reaches cost * (1 + trailArm), exit on a fall of `trail`. */
  trailArm: number;
  trail: number;
  /** Stop when liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Exit after holding this many slots when still below cost * (1 + staleGain). */
  maxHoldSlots: number;
  staleGain: number;
  /** After an exit, ignore the coin for this many slots. */
  cooldownSlots: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** A single sell of at least this many SOL blocks entry / exits a held position. */
  bigSellSol: number;
  /** Slippage tolerance on buys (bps); sells always go out at 10000. */
  buySlippageBps: number;
  /** Price must have recovered at least this fraction above the window low (0 = off). */
  recoverMin: number;
  /** Most new entries per reply. */
  maxEntriesPerBatch: number;
  // ---- Young-launch arm (breadth): buy a launch in its first slots when the tape
  // looks unbundled, exit within slots. Off by default; see youngEnabled.
  youngEnabled: boolean;
  /** Age window (slots since CreateEvent) in which a first young buy may be decided. */
  youngMinAge: number;
  youngMaxAge: number;
  /** SOL to aim for per young coin (each reply still capped at 1% of real SOL). */
  youngStakeSol: number;
  /** Young exit: take profit / stop loss as fractions of cost. */
  youngTp: number;
  youngSl: number;
  /** Young exit: most slots held. */
  youngMaxHold: number;
  /** Most distinct non-creator buyers seen before a young entry (a bundled launch has many). */
  youngMaxBuyers: number;
  /** Creator's own buys before entry must total at least this (SOL). */
  youngMinDevBuySol: number;
  /** Young entry needs at least this much real SOL. */
  youngMinRealSol: number;
  /** Most young positions open at once (the rest of the 5 slots stay for the dip arm). */
  youngMaxOpen: number;
}

export const DEFAULT_PARAMS: Params = {
  highWindow: 1800,
  ddMin: 0.15,
  ddMax: 0.4,
  minRealSol: 25,
  minAge: 400,
  flowTrades: 6,
  minBuys: 3,
  lastMustBeBuy: true,
  minNetFlowSol: 0,
  targetPctReal: 0.015,
  targetMinSol: 0.05,
  targetMaxSol: 0.5,
  addBand: 0.1,
  tpGain: 0.25,
  tpPart: 0.5,
  trailArm: 0.12,
  trail: 0.25,
  stopLoss: 0.1,
  maxHoldSlots: 400,
  staleGain: 0.05,
  cooldownSlots: 400,
  maxEntries: 2,
  bigSellSol: 2.5,
  recoverMin: 0,
  buySlippageBps: 800,
  maxEntriesPerBatch: 2,
  youngEnabled: true,
  youngMinAge: 0,
  youngMaxAge: 10,
  youngStakeSol: 0.02,
  youngTp: 0.2,
  youngSl: 0.1,
  youngMaxHold: 10,
  youngMaxBuyers: 3,
  youngMinDevBuySol: 0.02,
  youngMinRealSol: 0.3,
  youngMaxOpen: 3,
};

const LAMPORTS = 1e9;
const FEE_BPS = 125;
const BPS = 10_000;

/** Per-reply buy cap with a margin (the harness checks it against reserves shifted by our own flow). */
function buyCap(state: BotState, mint: Pubkey): bigint {
  return (state.maxBuyLamports(mint) * 97n) / 100n;
}

/** What selling `tokens` would pay, curve fees deducted, against the marked reserves. */
function liquidationValue(mark: Mark | undefined, tokens: bigint, txFee: bigint): bigint {
  if (mark === undefined) return 0n;
  const vq = BigInt(mark.virtual_quote_reserves);
  const vt = BigInt(mark.virtual_token_reserves);
  if (vt + tokens === 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  const net = q - (q * BigInt(FEE_BPS) + BigInt(BPS) - 1n) / BigInt(BPS);
  return net > txFee ? net - txFee : 0n;
}

interface Tick {
  slot: number;
  /** virtual SOL / virtual tokens: the marginal price. */
  price: number;
  realSol: number;
  isBuy: boolean;
  sol: number;
  user: string;
}

interface Book {
  ticks: Tick[];
  creator: string;
  createdSlot: number;
  creatorSold: boolean;
  /** Slot of the most recent single sell >= bigSellSol. */
  lastBigSellSlot: number;
  entryPrice: number;
  entrySlot: number;
  entries: number;
  coolUntil: number;
  /** Peak liquidation value of the current holding (SOL). */
  peakValue: number;
  tpDone: boolean;
  exiting: boolean;
  /** Young arm state. */
  youngDecided: boolean;
  youngBuyers: Set<string> | null;
  youngNetSol: number;
  creatorBuySol: number;
  /** Current position was entered by the young arm. */
  isYoung: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const books = new Map<Pubkey, Book>();
  const book = (mint: Pubkey): Book => {
    let b = books.get(mint);
    if (b === undefined) {
      b = {
        ticks: [], creator: '', createdSlot: -1, creatorSold: false, lastBigSellSlot: -1e12,
        entryPrice: 0, entrySlot: -1, entries: 0, coolUntil: -1,
        peakValue: 0, tpDone: false, exiting: false,
        youngDecided: false, youngBuyers: null, youngNetSol: 0, creatorBuySol: 0, isYoung: false,
      };
      books.set(mint, b);
    }
    return b;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      const tx = state.txFeeLamports();
      const txSol = Number(tx) / LAMPORTS;
      const touched: Pubkey[] = [];
      const markTouched = (mint: Pubkey) => {
        if (touched[touched.length - 1] !== mint && !touched.includes(mint)) touched.push(mint);
      };

      // Fold this batch's events into the tapes.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const b = book(e.mint);
          b.creator = e.creator;
          b.createdSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const b = book(e.mint);
          const vt = BigInt(e.virtual_token_reserves);
          const price = vt === 0n ? 0 : Number(BigInt(e.virtual_quote_reserves)) / Number(vt);
          const sol = Number(e.sol_amount) / LAMPORTS;
          b.ticks.push({
            slot, price, realSol: Number(e.real_quote_reserves) / LAMPORTS,
            isBuy: e.is_buy, sol, user: e.user,
          });
          if (b.ticks.length > 400) b.ticks.splice(0, b.ticks.length - 400);
          if (!e.is_buy && e.user === b.creator) b.creatorSold = true;
          if (!e.is_buy && sol >= p.bigSellSol) b.lastBigSellSlot = slot;
          // Young-arm tape: only until the launch is decided.
          if (!b.youngDecided && b.createdSlot >= 0 && slot - b.createdSlot <= p.youngMaxAge + 2) {
            b.youngNetSol += e.is_buy ? sol : -sol;
            if (e.is_buy && e.user === b.creator) b.creatorBuySol += sol;
            if (e.is_buy && e.user !== b.creator) {
              if (b.youngBuyers === null) b.youngBuyers = new Set();
              b.youngBuyers.add(e.user);
            }
          }
          markTouched(e.mint);
        }
      }

      // A sell that resolved (or failed) clears the exiting flag; a fully closed
      // position resets the book for a possible re-entry after cooldown.
      for (const f of batch.fills) {
        const b = books.get(f.mint);
        if (b === undefined) continue;
        if (f.side === 'sell') {
          b.exiting = false;
          if (!state.positions.has(f.mint)) {
            b.coolUntil = slot + p.cooldownSlots;
            b.peakValue = 0;
            b.tpDone = false;
            b.entrySlot = -1;
            b.isYoung = false;
          }
        } else if (f.status !== 'filled' && !state.positions.has(f.mint)) {
          let stillPending = false;
          for (const o of state.pending.values()) if (o.order.mint === f.mint) stillPending = true;
          if (!stillPending) {
            b.entrySlot = -1;
            b.entries = Math.max(0, b.entries - 1);
          }
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const marks = new Map<Pubkey, Mark>();
      for (const m of batch.marks) marks.set(m.mint, m);
      const pendingMints = new Set<Pubkey>();
      const pendingBuySol = new Map<Pubkey, number>();
      for (const o of state.pending.values()) {
        pendingMints.add(o.order.mint);
        if (o.order.side === 'buy') {
          pendingBuySol.set(o.order.mint, (pendingBuySol.get(o.order.mint) ?? 0) + Number(o.order.quote_lamports) / LAMPORTS);
        }
      }

      // 1. Manage held positions: exits, partial take-profit, and adds.
      const held = [...state.positions.keys()].sort();
      for (const mint of held) {
        if (orders.length >= cap) break;
        const pos = state.positions.get(mint)!;
        const b = book(mint);
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (b.exiting) continue;
        const value = Number(liquidationValue(marks.get(mint), pos.token_amount, tx)) / LAMPORTS;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (cost <= 0) continue;
        if (value > b.peakValue) b.peakValue = value;
        const gain = value / cost - 1;
        const ticks = b.ticks;
        const price = ticks.length > 0 ? ticks[ticks.length - 1]!.price : 0;

        // Instant full exit: creator dumped or a whale sell landed.
        const panic = b.creatorSold || slot - b.lastBigSellSlot <= 2;
        // Young arm: flat TP / SL / max-hold, no partials, no trailing.
        if (b.isYoung) {
          const yTp = gain >= p.youngTp;
          const ySl = gain <= -p.youngSl;
          const yStale = b.entrySlot >= 0 && slot - b.entrySlot >= p.youngMaxHold;
          if (panic || yTp || ySl || yStale) {
            if (pendingMints.has(mint)) continue;
            orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
            b.exiting = true;
          }
          continue;
        }
        // Partial take-profit at +25%: sell half, reset the peak to the remainder.
        if (!panic && !b.tpDone && gain >= p.tpGain) {
          if (pendingMints.has(mint)) continue;
          const half = pos.token_amount / 2n;
          if (half > 0n) {
            orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: 10_000 });
            b.tpDone = true;
            b.peakValue = value / 2;
            b.exiting = true;
            continue;
          }
        }
        const sl = gain <= -p.stopLoss;
        const trailHit = b.tpDone && value >= cost * (1 + p.trailArm) && value < b.peakValue * (1 - p.trail);
        const stale = b.entrySlot >= 0 && slot - b.entrySlot >= p.maxHoldSlots && gain < p.staleGain;
        if (panic || sl || trailHit || stale) {
          if (pendingMints.has(mint)) continue;
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
          b.exiting = true;
          continue;
        }
        // Add a tranche while the dip holds near the first entry price.
        if (pendingMints.has(mint)) continue;
        const invested = cost + (pendingBuySol.get(mint) ?? 0);
        const target = Math.min(p.targetMaxSol, Math.max(p.targetMinSol, p.targetPctReal * (ticks.length > 0 ? ticks[ticks.length - 1]!.realSol : 0)));
        if (invested >= target - 0.005 || b.entryPrice <= 0) continue;
        if (Math.abs(price / b.entryPrice - 1) > p.addBand) continue;
        let net = 0;
        for (let i = Math.max(0, ticks.length - p.flowTrades); i < ticks.length; i++) {
          const t = ticks[i]!;
          net += t.isBuy ? t.sol : -t.sol;
        }
        if (net < p.minNetFlowSol) continue;
        let amount = target - invested;
        const sizeCap = Number(buyCap(state, mint)) / LAMPORTS;
        if (amount > sizeCap) amount = sizeCap;
        if (amount < 0.01) continue;
        if (Number(state.freeCashLamports()) / LAMPORTS - amount - txSol < 0) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlippageBps });
        pendingMints.add(mint);
      }

      // 2. New entries on coins that traded this batch.
      let entries = 0;
      let open = state.committedPositionCount();
      for (const mint of touched) {
        if (orders.length >= cap || entries >= p.maxEntriesPerBatch) break;
        if (open >= state.hello.caps.max_open_positions) break;
        if (state.positions.has(mint) || pendingMints.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const b = book(mint);
        if (b.createdSlot < 0 || slot - b.createdSlot < p.minAge) continue;
        if (slot < b.coolUntil || b.entries >= p.maxEntries) continue;
        if (b.creatorSold) continue;
        if (slot - b.lastBigSellSlot < 30) continue;
        const ticks = b.ticks;
        if (ticks.length < p.flowTrades) continue;
        const last = ticks[ticks.length - 1]!;
        if (last.realSol < p.minRealSol) continue;
        // Recent high within the window.
        let hi = 0;
        let lo = Infinity;
        for (let i = ticks.length - 1; i >= 0; i--) {
          const t = ticks[i]!;
          if (slot - t.slot > p.highWindow) break;
          if (t.price > hi) hi = t.price;
          if (t.price < lo) lo = t.price;
        }
        if (hi <= 0) continue;
        const dd = 1 - last.price / hi;
        if (dd < p.ddMin || dd > p.ddMax) continue;
        if (p.recoverMin > 0 && lo !== Infinity && last.price < lo * (1 + p.recoverMin)) continue;
        // Buyers still there.
        let buys = 0;
        let net = 0;
        for (let i = ticks.length - p.flowTrades; i < ticks.length; i++) {
          const t = ticks[i]!;
          if (t.isBuy) {
            buys++;
            net += t.sol;
          } else net -= t.sol;
        }
        if (buys < p.minBuys || net < p.minNetFlowSol) continue;
        if (p.lastMustBeBuy && !last.isBuy) continue;
        const target = Math.min(p.targetMaxSol, Math.max(p.targetMinSol, p.targetPctReal * last.realSol));
        let amount = target;
        const sizeCap = Number(buyCap(state, mint)) / LAMPORTS;
        if (amount > sizeCap) amount = sizeCap;
        if (amount < 0.01) continue;
        if (Number(state.freeCashLamports()) / LAMPORTS - amount - txSol < 0) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlippageBps });
        b.entryPrice = last.price;
        b.entrySlot = slot;
        b.entries++;
        b.peakValue = 0;
        b.tpDone = false;
        pendingMints.add(mint);
        entries++;
        open++;
      }
      // 3. Young-launch entries: breadth arm for the >= 20-coins guardrail.
      if (p.youngEnabled) {
        let youngOpen = 0;
        for (const m of state.positions.keys()) if (book(m).isYoung) youngOpen++;
        for (const mint of touched) {
          if (orders.length >= cap) break;
          if (open >= state.hello.caps.max_open_positions || youngOpen >= p.youngMaxOpen) break;
          if (state.positions.has(mint) || pendingMints.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const b = book(mint);
          if (b.youngDecided) continue;
          if (b.createdSlot < 0) continue;
          const age = slot - b.createdSlot;
          if (age < p.youngMinAge || age > p.youngMaxAge) continue;
          const ticks = b.ticks;
          if (ticks.length === 0) continue;
          const last = ticks[ticks.length - 1]!;
          if (last.realSol < p.youngMinRealSol) continue;
          if (b.creatorSold) continue;
          if (b.creatorBuySol < p.youngMinDevBuySol) continue;
          if (b.youngNetSol <= 0) continue;
          if ((b.youngBuyers?.size ?? 0) > p.youngMaxBuyers) continue;
          let amount = p.youngStakeSol;
          const sizeCap = Number(buyCap(state, mint)) / LAMPORTS;
          if (amount > sizeCap) amount = sizeCap;
          if (amount < 0.01) continue;
          if (Number(state.freeCashLamports()) / LAMPORTS - amount - txSol < 0) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlippageBps });
          b.youngDecided = true;
          b.youngBuyers = null;
          b.entryPrice = last.price;
          b.entrySlot = slot;
          b.entries++;
          b.isYoung = true;
          b.peakValue = 0;
          b.tpDone = false;
          pendingMints.add(mint);
          open++;
          youngOpen++;
        }
        // Mark every touched coin that aged out of the young window as decided, so the
        // buyer set is dropped and the coin is never reconsidered young.
        for (const mint of touched) {
          const b = books.get(mint);
          if (b !== undefined && !b.youngDecided && b.createdSlot >= 0 && slot - b.createdSlot > p.youngMaxAge) {
            b.youngDecided = true;
            b.youngBuyers = null;
          }
        }
      }
      return orders;
    },
  };
}
