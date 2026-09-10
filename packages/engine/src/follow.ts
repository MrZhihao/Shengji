/**
 * 跟牌规则：有该花色必须出该花色；牌型匹配优先。
 * 校验与生成共用同一套「需求消解」流程，保证机器人生成的跟牌一定通过校验。
 */
import { removeCards, type Card } from './cards.ts';
import {
  clonePool, findTractors, hasTractor, identitiesWithAtLeast, poolCards, poolOf, poolTake,
  type Decomposition, type Identity, type Pool, type Shape,
} from './combos.ts';
import { ruleError, type RuleError } from './errors.ts';
import { groupOf, ordinal, type Group, type TrumpCtx } from './trump.ts';
import type { Rng } from './rng.ts';

interface Reqs {
  readonly tractors: readonly Shape[];
  readonly triples: number;
  readonly pairs: number;
}

function reqsOf(lead: Decomposition): Reqs {
  const tractors: Shape[] = [];
  let triples = 0, pairs = 0;
  for (const c of lead.components) {
    if (c.kind === 'tractor') tractors.push({ mult: c.mult, length: c.length });
    else if (c.kind === 'triple') triples++;
    else if (c.kind === 'pair') pairs++;
  }
  tractors.sort((a, b) => b.mult - a.mult || b.length - a.length);
  return { tractors, triples, pairs };
}

function groupName(g: Group): string {
  return g === 'T' ? '主牌' : { S: '黑桃', H: '红桃', D: '方块', C: '梅花' }[g];
}

/**
 * 需求消解：按拖拉机（重数高、长度长优先）→ 三条 → 对子 的顺序，
 * 手里有对应牌型就必须出，没有则降级为更小的需求。
 * pool 是手中该组的牌，playPool 是所出该组的牌；返回 playPool 是否满足。
 */
function satisfies(reqs: Reqs, ti: number, triples: number, pairs: number, pool: Pool, playPool: Pool): boolean {
  if (ti < reqs.tractors.length) {
    const t = reqs.tractors[ti] as Shape;
    if (hasTractor(pool, t.mult, t.length)) {
      for (const keys of findTractors(playPool, t.mult, t.length)) {
        const p2 = clonePool(pool), pp2 = clonePool(playPool);
        for (const k of keys) { poolTake(p2, k, t.mult); poolTake(pp2, k, t.mult); }
        if (satisfies(reqs, ti + 1, triples, pairs, p2, pp2)) return true;
      }
      return false;
    }
    return t.mult === 3
      ? satisfies(reqs, ti + 1, triples + t.length, pairs, pool, playPool)
      : satisfies(reqs, ti + 1, triples, pairs + t.length, pool, playPool);
  }
  if (triples > 0) {
    if (identitiesWithAtLeast(pool, 3).length > 0) {
      for (const id of identitiesWithAtLeast(playPool, 3)) {
        const p2 = clonePool(pool), pp2 = clonePool(playPool);
        poolTake(p2, id.key, 3); poolTake(pp2, id.key, 3);
        if (satisfies(reqs, ti, triples - 1, pairs, p2, pp2)) return true;
      }
      return false;
    }
    return satisfies(reqs, ti, 0, pairs + triples, pool, playPool);
  }
  if (pairs > 0) {
    if (identitiesWithAtLeast(pool, 2).length > 0) {
      for (const id of identitiesWithAtLeast(playPool, 2)) {
        const p2 = clonePool(pool), pp2 = clonePool(playPool);
        poolTake(p2, id.key, 2); poolTake(pp2, id.key, 2);
        if (satisfies(reqs, ti, 0, pairs - 1, p2, pp2)) return true;
      }
      return false;
    }
    return true;
  }
  return true;
}

function describeLead(lead: Decomposition): string {
  const names: string[] = [];
  for (const c of lead.components) {
    if (c.kind === 'tractor') names.push(`${c.mult === 3 ? '三条' : ''}拖拉机`);
    else names.push({ single: '单张', pair: '对子', triple: '三条' }[c.kind]);
  }
  return names.join('、');
}

/** 校验跟牌。play 必须已确认全部在 hand 中。 */
export function validateFollow(lead: Decomposition, hand: readonly Card[], play: readonly Card[], ctx: TrumpCtx): RuleError | null {
  let n = 0;
  for (const c of lead.components) n += c.cards.length;
  if (play.length !== n) return ruleError('WRONG_CARD_COUNT', `首出 ${n} 张，必须跟 ${n} 张`);
  const g = lead.group;
  const hg = hand.filter((c) => groupOf(c, ctx) === g);
  const pg = play.filter((c) => groupOf(c, ctx) === g);
  const need = Math.min(n, hg.length);
  if (pg.length < need) {
    return ruleError('MUST_FOLLOW_SUIT', `手里还有${groupName(g)}，必须先出${groupName(g)}`);
  }
  const reqs = reqsOf(lead);
  if (!satisfies(reqs, 0, reqs.triples, reqs.pairs, poolOf(hg, ctx), poolOf(pg, ctx))) {
    return ruleError('MUST_MATCH_STRUCTURE', `首出是${describeLead(lead)}，手里有相同牌型必须跟出`);
  }
  return null;
}

/** 跟牌生成时的取舍策略：随机、最小、最大，或自定义。 */
export interface FollowChooser {
  /** 从多个可用拖拉机中选一个（每个是身份 key 列表） */
  pickTractor(options: string[][], pool: Pool): string[];
  /** 从多个身份中选一个 */
  pickIdentity(options: Identity[]): Identity;
  /** 从剩余的牌里补 n 张 */
  fill(cards: Card[], n: number): Card[];
}

export function randomChooser(rng: Rng): FollowChooser {
  return {
    pickTractor: (o) => rng.pick(o),
    pickIdentity: (o) => rng.pick(o),
    fill: (cards, n) => rng.shuffle(cards).slice(0, n),
  };
}

function tractorTop(keys: string[], pool: Pool): number {
  let top = -1;
  for (const k of keys) top = Math.max(top, pool.get(k)?.ord ?? -1);
  return top;
}

/** 尽量出小 */
export const lowestChooser = (ctx: TrumpCtx): FollowChooser => ({
  pickTractor: (o, pool) => o.reduce((a, b) => (tractorTop(b, pool) < tractorTop(a, pool) ? b : a)),
  pickIdentity: (o) => o.reduce((a, b) => (b.ord < a.ord ? b : a)),
  fill: (cards, n) => [...cards].sort((a, b) => ordinal(a, ctx) - ordinal(b, ctx)).slice(0, n),
});

/** 尽量出大 */
export const highestChooser = (ctx: TrumpCtx): FollowChooser => ({
  pickTractor: (o, pool) => o.reduce((a, b) => (tractorTop(b, pool) > tractorTop(a, pool) ? b : a)),
  pickIdentity: (o) => o.reduce((a, b) => (b.ord > a.ord ? b : a)),
  fill: (cards, n) => [...cards].sort((a, b) => ordinal(b, ctx) - ordinal(a, ctx)).slice(0, n),
});

/** 生成一个随机的合法跟牌。 */
export function generateFollow(lead: Decomposition, hand: readonly Card[], ctx: TrumpCtx, rng: Rng): Card[] {
  return generateFollowWith(lead, hand, ctx, randomChooser(rng));
}

/** 按给定策略生成合法跟牌。结构部分由需求消解决定，只有可选处交给策略。 */
export function generateFollowWith(lead: Decomposition, hand: readonly Card[], ctx: TrumpCtx, chooser: FollowChooser): Card[] {
  let n = 0;
  for (const c of lead.components) n += c.cards.length;
  const g = lead.group;
  const hg = hand.filter((c) => groupOf(c, ctx) === g);
  if (hg.length <= n) {
    const others = removeCards(hand, hg);
    return [...hg, ...chooser.fill(others, n - hg.length)];
  }
  const pool = poolOf(hg, ctx);
  const chosen: Card[] = [];
  const reqs = reqsOf(lead);
  let triples = reqs.triples, pairs = reqs.pairs;
  for (const t of reqs.tractors) {
    if (hasTractor(pool, t.mult, t.length)) {
      const keys = chooser.pickTractor(findTractors(pool, t.mult, t.length), pool);
      for (const k of keys) chosen.push(...poolTake(pool, k, t.mult));
    } else if (t.mult === 3) triples += t.length;
    else pairs += t.length;
  }
  while (triples > 0) {
    const ids = identitiesWithAtLeast(pool, 3);
    if (ids.length === 0) { pairs += triples; break; }
    chosen.push(...poolTake(pool, chooser.pickIdentity(ids).key, 3));
    triples--;
  }
  while (pairs > 0) {
    const ids = identitiesWithAtLeast(pool, 2);
    if (ids.length === 0) break;
    chosen.push(...poolTake(pool, chooser.pickIdentity(ids).key, 2));
    pairs--;
  }
  chosen.push(...chooser.fill(poolCards(pool), n - chosen.length));
  return chosen;
}
