/**
 * 手牌推断网络：根据公开信息预测每张没见过的牌在谁手里（或在底牌里）。
 *
 * 只在出牌阶段使用。训练数据由模拟器生成（sim/beliefData.ts），训练在 ml/train_belief.py，
 * 推理在这里用纯 TypeScript 做，不依赖任何运行库。搜索补全手牌时用它的概率代替均匀分配。
 *
 * 编码约定（特征与目标都按「我」的视角）：
 * - 座位用相对位置 r = (座位 - 我) mod P，r = 0 是我。
 * - 牌的身份规范化：主花色排在第 0 个花色槽，其余花色按 SUITS 顺序；无主时四门都按 SUITS 顺序。
 *   每个花色槽 13 个点数按自然顺序，再加小王、大王，共 54 个身份。级牌位置用级别独热编码告诉网络。
 * - 位置：r = 1..P-1 的其他人对应下标 0..P-2，底牌是下标 P-1。
 */
import { RANKS, SUITS, makeDeck, type Card, type Suit } from './cards.ts';
import { ctxOf } from './reducer.ts';
import { knownVoids } from './smartbot.ts';
import type { GameState, Seat } from './state.ts';
import { groupOf, type Group, type TrumpCtx } from './trump.ts';

export const BELIEF_VERSION = 1;
export const IDENTITIES = 54;

// ---------- 规范化 ----------

/** 花色槽顺序：主花色在前，其余按 SUITS；无主按 SUITS */
export function suitSlots(trumpSuit: Suit | null): Suit[] {
  if (trumpSuit === null) return [...SUITS];
  return [trumpSuit, ...SUITS.filter((x) => x !== trumpSuit)];
}

/** 牌的规范化身份下标 0..53 */
export function canonIndex(c: { suit: Card['suit']; rank: number }, slots: readonly Suit[]): number {
  if (c.suit === 'J') return c.rank === 16 ? 53 : 52;
  return slots.indexOf(c.suit as Suit) * 13 + (c.rank - 2);
}

/** 组的规范化下标：主牌 0，副牌按花色槽 1..4（有主时槽 0 的花色属于主牌，1 号位不会出现） */
function canonGroup(g: Group, slots: readonly Suit[]): number {
  return g === 'T' ? 0 : 1 + slots.indexOf(g);
}

// ---------- 隐藏信息 ----------

export interface HiddenInfo {
  /** 我没见过的牌：不在我手里、没打出、我不是庄家时的底牌、不是别人亮出的牌 */
  readonly pool: Card[];
  /** 每个座位还能装多少张未知的牌（我自己为 0） */
  readonly capacity: number[];
  readonly bottomCap: number;
  readonly bottomKnown: boolean;
  /** 别人亮主时亮出、还在手里的牌 */
  readonly revealed: Map<Seat, Card[]>;
  readonly voids: Map<Seat, Set<Group>>;
}

export function revealedInHands(s: GameState): Map<Seat, Card[]> {
  const out = new Map<Seat, Card[]>();
  const d = s.declaration;
  if (!d) return out;
  const stillHeld = d.cards.filter((c) => (s.hands[d.seat] ?? []).some((h) => h.id === c.id));
  if (stillHeld.length) out.set(d.seat, stillHeld);
  return out;
}

export function hiddenInfo(s: GameState, seat: Seat): HiddenInfo {
  const n = s.config.players;
  const myHand = s.hands[seat] ?? [];
  const known = new Set<string>(myHand.map((c) => c.id));
  for (const t of s.tricks) for (const p of t.plays) for (const c of p.cards) known.add(c.id);
  if (s.trick) for (const p of s.trick.plays) for (const c of p.cards) known.add(c.id);
  const bottomKnown = seat === s.dealer;
  if (bottomKnown) for (const c of s.bottom) known.add(c.id);
  const revealed = revealedInHands(s);
  for (const [who, cards] of revealed) if (who !== seat) for (const c of cards) known.add(c.id);
  const pool = makeDeck(s.config.decks).filter((c) => !known.has(c.id));
  const capacity: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === seat) { capacity.push(0); continue; }
    capacity.push((s.hands[i]?.length ?? 0) - (revealed.get(i)?.length ?? 0));
  }
  return { pool, capacity, bottomCap: bottomKnown ? 0 : s.bottom.length, bottomKnown, revealed, voids: knownVoids(s) };
}

// ---------- 特征 ----------

/** 特征长度只取决于人数 */
export function featureSize(players: number): number {
  const perSeat = 5 + 5 + 7; // 断门、领出次数、手牌数/得分/庄家/亮主/亮出张数/庄家方/闲家方
  const global = 3 + 13 + 1 + players + 5; // 无主、亮主张数、我知道底牌、级别独热、已出墩数、本墩首家、本墩首出组
  const calls = 2 * (4 + 13 + 3 + players);
  return IDENTITIES * 2 + IDENTITIES * players + perSeat * players + global + calls;
}

const clamp255 = (x: number) => (x < 0 ? 0 : x > 255 ? 255 : Math.round(x));

/** 原始整数特征（0..255），训练与推理都除以模型里的缩放系数 */
export function beliefFeatures(s: GameState, seat: Seat, info: HiddenInfo = hiddenInfo(s, seat)): Uint8Array {
  const P = s.config.players;
  const ctx: TrumpCtx = ctxOf(s);
  const slots = suitSlots(s.trumpSuit);
  const f = new Uint8Array(featureSize(P));
  let o = 0;
  const rel = (i: Seat) => (i - seat + P) % P;
  // 我的手牌
  for (const c of s.hands[seat] ?? []) f[o + canonIndex(c, slots)]!++;
  o += IDENTITIES;
  // 没见过的牌
  for (const c of info.pool) f[o + canonIndex(c, slots)]!++;
  o += IDENTITIES;
  // 每个人打出过的牌
  const playedBase = o;
  const ledCount: number[][] = Array.from({ length: P }, () => [0, 0, 0, 0, 0]);
  const scanPlays = (leader: Seat, plays: readonly { seat: Seat; cards: readonly Card[] }[]) => {
    for (const p of plays) for (const c of p.cards) f[playedBase + rel(p.seat) * IDENTITIES + canonIndex(c, slots)]!++;
    const first = plays[0];
    if (first && first.cards[0]) ledCount[rel(leader)]![canonGroup(groupOf(first.cards[0], ctx), slots)]!++;
  };
  for (const t of s.tricks) scanPlays(t.leader, t.plays);
  if (s.trick) scanPlays(s.trick.leader, s.trick.plays);
  o += IDENTITIES * P;
  // 每个座位
  const team = new Set<Seat>();
  if (s.dealer !== null) {
    team.add(s.dealer);
    if (s.config.mode === 'partners') team.add((s.dealer + 2) % P);
    for (const fr of s.friends) team.add(fr);
  }
  const allResolved = s.config.friendCount === 0 || (s.friendCalls.length > 0 && s.friendCalls.every((c) => c.resolvedSeat !== null));
  for (let r = 0; r < P; r++) {
    const i = (seat + r) % P;
    const v = info.voids.get(i);
    for (let g = 0; g < 5; g++) f[o + g] = 0;
    if (v) for (const g of v) f[o + canonGroup(g, slots)] = 1;
    o += 5;
    for (let g = 0; g < 5; g++) f[o + g] = clamp255(ledCount[r]![g]!);
    o += 5;
    f[o++] = clamp255(s.hands[i]?.length ?? 0);
    f[o++] = clamp255((s.captured[i] ?? 0) / 5);
    f[o++] = s.dealer === i ? 1 : 0;
    f[o++] = s.declaration?.seat === i ? 1 : 0;
    f[o++] = clamp255(info.revealed.get(i)?.length ?? 0);
    f[o++] = team.has(i) ? 1 : 0;
    f[o++] = allResolved && !team.has(i) ? 1 : 0;
  }
  // 全局
  f[o++] = s.trumpSuit === null ? 1 : 0;
  f[o++] = clamp255(s.declaration?.count ?? 0);
  f[o++] = info.bottomKnown ? 1 : 0;
  const li = RANKS.indexOf(s.level);
  if (li >= 0) f[o + li] = 1;
  o += 13;
  f[o++] = clamp255(s.tricks.length);
  if (s.trick && s.trick.plays.length > 0) f[o + rel(s.trick.leader)] = 1;
  o += P;
  if (s.trick?.lead) f[o + canonGroup(s.trick.lead.group, slots)] = 1;
  o += 5;
  // 叫朋友（最多两张）
  for (let k = 0; k < 2; k++) {
    const call = s.friendCalls[k];
    if (call) {
      f[o + slots.indexOf(call.suit)] = 1;
      f[o + 4 + (call.rank - 2)] = 1;
      f[o + 17] = clamp255(call.nth);
      f[o + 18] = clamp255(call.played);
      f[o + 19] = call.resolvedSeat === null ? 0 : 1;
      if (call.resolvedSeat !== null) f[o + 20 + rel(call.resolvedSeat)] = 1;
    }
    o += 4 + 13 + 3 + P;
  }
  if (o !== f.length) throw new Error(`特征长度不符：${o} != ${f.length}`);
  return f;
}

// ---------- 目标与掩码 ----------

/** 位置下标：其他人 r = 1..P-1 → 0..P-2，底牌 → P-1 */
function locOf(i: Seat, seat: Seat, P: number): number {
  return ((i - seat + P) % P) - 1;
}

/** 哪些（身份, 位置）在规则上可能：位置有空位、该人没在这门断门 */
export function beliefMask(s: GameState, seat: Seat, info: HiddenInfo): Uint8Array {
  const P = s.config.players;
  const ctx = ctxOf(s);
  const slots = suitSlots(s.trumpSuit);
  const m = new Uint8Array(IDENTITIES * P);
  const groupOfCanon: Group[] = new Array(IDENTITIES);
  for (const suit of SUITS) for (const rank of RANKS) groupOfCanon[canonIndex({ suit, rank }, slots)] = groupOf({ id: '', suit, rank, deck: 0 }, ctx);
  groupOfCanon[52] = 'T';
  groupOfCanon[53] = 'T';
  for (let c = 0; c < IDENTITIES; c++) {
    for (let r = 1; r < P; r++) {
      const i = (seat + r) % P;
      if ((info.capacity[i] ?? 0) <= 0) continue;
      if (info.voids.get(i)?.has(groupOfCanon[c] as Group)) continue;
      m[c * P + (r - 1)] = 1;
    }
    if (info.bottomCap > 0) m[c * P + P - 1] = 1;
  }
  return m;
}

/** 训练目标：每张没见过的牌实际在哪，按（身份, 位置）计数。只能在模拟器里用（要看全桌手牌） */
export function beliefTargets(s: GameState, seat: Seat, info: HiddenInfo): Uint8Array {
  const P = s.config.players;
  const slots = suitSlots(s.trumpSuit);
  const where = new Map<string, number>();
  for (let i = 0; i < P; i++) if (i !== seat) for (const c of s.hands[i] ?? []) where.set(c.id, locOf(i, seat, P));
  for (const c of s.bottom) where.set(c.id, P - 1);
  const t = new Uint8Array(IDENTITIES * P);
  for (const c of info.pool) {
    const loc = where.get(c.id);
    if (loc === undefined) continue;
    t[canonIndex(c, slots) * P + loc]!++;
  }
  return t;
}

// ---------- 模型 ----------

export interface DenseLayer {
  readonly inSize: number;
  readonly outSize: number;
  /** 行优先 [outSize][inSize] */
  readonly w: Float32Array;
  readonly b: Float32Array;
}

export interface BeliefModel {
  readonly version: number;
  readonly players: number;
  readonly inputSize: number;
  readonly scale: Float32Array;
  readonly layers: readonly DenseLayer[];
}

export interface BeliefModelMeta {
  readonly version: number;
  readonly players: number;
  readonly inputSize: number;
  readonly scale: readonly number[];
  readonly layers: readonly { readonly inSize: number; readonly outSize: number }[];
}

/** 从元数据和小端 float32 权重（各层依次 w 再 b）组装模型 */
export function parseBeliefModel(meta: BeliefModelMeta, weights: Uint8Array): BeliefModel {
  if (meta.version !== BELIEF_VERSION) throw new Error(`手牌推断模型版本 ${meta.version} 与代码版本 ${BELIEF_VERSION} 不符`);
  if (meta.inputSize !== featureSize(meta.players)) throw new Error('手牌推断模型输入长度与特征不符');
  const all = new Float32Array(weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength));
  let off = 0;
  const layers: DenseLayer[] = meta.layers.map(({ inSize, outSize }) => {
    const w = all.subarray(off, off + inSize * outSize); off += inSize * outSize;
    const b = all.subarray(off, off + outSize); off += outSize;
    return { inSize, outSize, w, b };
  });
  if (off !== all.length) throw new Error('手牌推断模型权重长度不符');
  const last = layers[layers.length - 1];
  if (!last || last.outSize !== IDENTITIES * meta.players) throw new Error('手牌推断模型输出长度不符');
  return { version: meta.version, players: meta.players, inputSize: meta.inputSize, scale: Float32Array.from(meta.scale), layers };
}

function forward(model: BeliefModel, x: Float32Array): Float32Array {
  return denseForward(model.layers, x);
}

/** 多层感知机前向：隐藏层 ReLU，最后一层线性。手牌推断网络和价值网络共用 */
export function denseForward(layers: readonly DenseLayer[], x: Float32Array): Float32Array {
  let h = x;
  layers.forEach((L, li) => {
    const out = new Float32Array(L.outSize);
    for (let j = 0; j < L.outSize; j++) {
      let acc = L.b[j] as number;
      const row = j * L.inSize;
      for (let k = 0; k < L.inSize; k++) acc += (L.w[row + k] as number) * (h[k] as number);
      out[j] = li < layers.length - 1 && acc < 0 ? 0 : acc; // 隐藏层 ReLU
    }
    h = out;
  });
  return h;
}

const models = new Map<number, BeliefModel>();

/** 装入（或用 null 卸下）某个人数的模型。引擎本身不读文件，由服务端和模拟器调用 */
export function setBeliefModel(players: number, model: BeliefModel | null): void {
  if (model) models.set(players, model);
  else models.delete(players);
}

export function hasBeliefModel(players: number): boolean {
  return models.has(players);
}

/**
 * 每个（规范化身份, 位置）的概率，位置维度上已按掩码做 softmax。没有模型或不在出牌阶段时返回 null。
 * 同一局面对象重复调用会走缓存。
 */
const cache = new WeakMap<GameState, Map<Seat, Float32Array | null>>();
export function beliefProbs(s: GameState, seat: Seat, info?: HiddenInfo): Float32Array | null {
  if (s.phase !== 'playing') return null;
  const model = models.get(s.config.players);
  if (!model) return null;
  let bySeat = cache.get(s);
  if (bySeat?.has(seat)) return bySeat.get(seat) ?? null;
  const hi = info ?? hiddenInfo(s, seat);
  const raw = beliefFeatures(s, seat, hi);
  const x = new Float32Array(raw.length);
  for (let k = 0; k < raw.length; k++) x[k] = (raw[k] as number) / (model.scale[k] as number);
  const logits = forward(model, x);
  const mask = beliefMask(s, seat, hi);
  const P = s.config.players;
  const p = new Float32Array(IDENTITIES * P);
  for (let c = 0; c < IDENTITIES; c++) {
    let mx = -Infinity;
    for (let l = 0; l < P; l++) if (mask[c * P + l]) mx = Math.max(mx, logits[c * P + l] as number);
    if (mx === -Infinity) continue;
    let z = 0;
    for (let l = 0; l < P; l++) if (mask[c * P + l]) { const e = Math.exp((logits[c * P + l] as number) - mx); p[c * P + l] = e; z += e; }
    for (let l = 0; l < P; l++) p[c * P + l] = (p[c * P + l] as number) / z;
  }
  if (!bySeat) { bySeat = new Map(); cache.set(s, bySeat); }
  bySeat.set(seat, p);
  return p;
}

/** 采样时用的位置下标，供 searchbot 调用 */
export function beliefLoc(i: Seat, seat: Seat, players: number): number {
  return locOf(i, seat, players);
}
