/**
 * 完美信息价值网络：给一个「所有人的牌都公开」的局面打分，预测这一局最后闲家方的收益。
 *
 * 搜索补全别人的手牌之后，局面就是完全公开的；原来要用二版机器人把整局打完才知道结果（每次约 7 毫秒，
 * 还带着二版打法的偏差），现在只推演一两墩，剩下的交给这个网络估值。思路来自 PerfectDou 的
 * 「训练时用完美信息」：看得到所有人的牌时，价值好学得多。
 *
 * 只在一墩开始时（桌上还没人出牌）求值。收益的单位和 terminalUtility 一致：
 * 闲家方 = (闲家得分 - 2L) / L + 升级数 × 0.5（庄家守住时升级数记负），庄家方取相反数。
 *
 * 特征以庄家为基准排座位（r = 0 庄家），牌的身份规范化方式与手牌推断网络相同（主花色排第一个花色槽）。
 */
import { RANKS, type Card } from './cards.ts';
import { canonIndex, denseForward, IDENTITIES, suitSlots, type DenseLayer } from './belief.ts';
import { dealerTeam } from './reducer.ts';
import type { GameState, Seat } from './state.ts';

export const VALUE_VERSION = 1;

/** 特征长度：各家手牌、底牌、已出的牌 + 每人得分、罚分、是否庄家方 + 首家、已出墩数、无主、级别 */
export function valueFeatureSize(players: number): number {
  return IDENTITIES * (players + 2) + players * 3 + players + 1 + 1 + 13;
}

const clamp255 = (x: number) => (x < 0 ? 0 : x > 255 ? 255 : Math.round(x));

/** 原始整数特征（0..255）。只在完全公开的局面上用：搜索的补全局面、模拟器的真实局面 */
export function valueFeatures(s: GameState): Uint8Array {
  const P = s.config.players;
  const dealer = s.dealer ?? 0;
  const slots = suitSlots(s.trumpSuit);
  const rel = (i: Seat) => (i - dealer + P) % P;
  const f = new Uint8Array(valueFeatureSize(P));
  let o = 0;
  for (let i = 0; i < P; i++) {
    const base = o + rel(i) * IDENTITIES;
    for (const c of s.hands[i] ?? []) f[base + canonIndex(c, slots)]!++;
  }
  o += IDENTITIES * P;
  for (const c of s.bottom) f[o + canonIndex(c, slots)]!++;
  o += IDENTITIES;
  const addPlayed = (cards: readonly Card[]) => { for (const c of cards) f[o + canonIndex(c, slots)]!++; };
  for (const t of s.tricks) for (const p of t.plays) addPlayed(p.cards);
  if (s.trick) for (const p of s.trick.plays) addPlayed(p.cards);
  o += IDENTITIES;
  const team = new Set<Seat>(dealerTeam(s));
  for (let i = 0; i < P; i++) {
    const r = rel(i);
    f[o + r * 3] = clamp255((s.captured[i] ?? 0) / 5);
    f[o + r * 3 + 1] = clamp255((s.penalties[i] ?? 0) / 10);
    f[o + r * 3 + 2] = team.has(i) ? 1 : 0;
  }
  o += P * 3;
  if (s.trick) f[o + rel(s.trick.leader)] = 1;
  o += P;
  f[o++] = clamp255(s.tricks.length);
  f[o++] = s.trumpSuit === null ? 1 : 0;
  const li = RANKS.indexOf(s.level);
  if (li >= 0) f[o + li] = 1;
  o += 13;
  if (o !== f.length) throw new Error(`价值网络特征长度不符：${o} != ${f.length}`);
  return f;
}

// ---------- 模型 ----------

export interface ValueModel {
  readonly version: number;
  readonly players: number;
  readonly inputSize: number;
  readonly scale: Float32Array;
  readonly layers: readonly DenseLayer[];
}

export interface ValueModelMeta {
  readonly version: number;
  readonly players: number;
  readonly inputSize: number;
  readonly scale: readonly number[];
  readonly layers: readonly { readonly inSize: number; readonly outSize: number }[];
}

export function parseValueModel(meta: ValueModelMeta, weights: Uint8Array): ValueModel {
  if (meta.version !== VALUE_VERSION) throw new Error(`价值网络版本 ${meta.version} 与代码版本 ${VALUE_VERSION} 不符`);
  if (meta.inputSize !== valueFeatureSize(meta.players)) throw new Error('价值网络输入长度与特征不符');
  const all = new Float32Array(weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength));
  let off = 0;
  const layers: DenseLayer[] = meta.layers.map(({ inSize, outSize }) => {
    const w = all.subarray(off, off + inSize * outSize); off += inSize * outSize;
    const b = all.subarray(off, off + outSize); off += outSize;
    return { inSize, outSize, w, b };
  });
  if (off !== all.length) throw new Error('价值网络权重长度不符');
  if (layers[layers.length - 1]?.outSize !== 1) throw new Error('价值网络输出应为 1 维');
  return { version: meta.version, players: meta.players, inputSize: meta.inputSize, scale: Float32Array.from(meta.scale), layers };
}

const models = new Map<number, ValueModel>();

export function setValueModel(players: number, model: ValueModel | null): void {
  if (model) models.set(players, model);
  else models.delete(players);
}

export function hasValueModel(players: number): boolean {
  return models.has(players);
}

/** 闲家方的预测收益；没有模型时返回 null */
export function predictOpponentUtility(s: GameState): number | null {
  const model = models.get(s.config.players);
  if (!model) return null;
  const raw = valueFeatures(s);
  const x = new Float32Array(raw.length);
  for (let k = 0; k < raw.length; k++) x[k] = (raw[k] as number) / (model.scale[k] as number);
  return denseForward(model.layers, x)[0] ?? null;
}

/** 从 seat 角度的预测收益（庄家方取相反数）。只适用于阵营已知的局面（四人对家模式） */
export function predictUtility(s: GameState, seat: Seat): number | null {
  const v = predictOpponentUtility(s);
  if (v === null) return null;
  return dealerTeam(s).includes(seat) ? -v : v;
}
