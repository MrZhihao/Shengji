/**
 * 主牌上下文：级牌 + 主花色（null 为无主）。
 * 所有牌被划入一个「组」：主牌组 T，或四个副牌花色之一。
 * 组内用「序位」比较大小和判断拖拉机的连续性。
 */
import { ACE, BIG_JOKER, SMALL_JOKER, type Card, type Suit } from './cards.ts';

export interface TrumpCtx {
  readonly level: number;
  /** null 表示无主 */
  readonly trumpSuit: Suit | null;
}

export type Group = Suit | 'T';

export function isTrump(c: Card, ctx: TrumpCtx): boolean {
  return c.suit === 'J' || c.rank === ctx.level || (ctx.trumpSuit !== null && c.suit === ctx.trumpSuit);
}

export function groupOf(c: Card, ctx: TrumpCtx): Group {
  return isTrump(c, ctx) ? 'T' : (c.suit as Suit);
}

/** 副牌花色内，2..A 去掉级牌后从 0 开始编号。 */
function suitedOrdinal(rank: number, level: number): number {
  return rank < level ? rank - 2 : rank - 3;
}

/**
 * 序位：组内从小到大的位置。
 * 有主花色：主花色非级牌 0..11，副级牌 12（三色相等），主级牌 13，小王 14，大王 15。
 * 无主：级牌 0（四色相等），小王 1，大王 2。
 */
export function ordinal(c: Card, ctx: TrumpCtx): number {
  if (!isTrump(c, ctx)) return suitedOrdinal(c.rank, ctx.level);
  if (ctx.trumpSuit === null) {
    if (c.rank === BIG_JOKER) return 2;
    if (c.rank === SMALL_JOKER) return 1;
    return 0;
  }
  if (c.rank === BIG_JOKER) return 15;
  if (c.rank === SMALL_JOKER) return 14;
  if (c.rank === ctx.level) return c.suit === ctx.trumpSuit ? 13 : 12;
  return suitedOrdinal(c.rank, ctx.level);
}

/** 同一组内所有牌是否属于同一组；返回该组或 null（混组）。 */
export function commonGroup(cards: readonly Card[], ctx: TrumpCtx): Group | null {
  if (cards.length === 0) return null;
  const g = groupOf(cards[0] as Card, ctx);
  for (const c of cards) if (groupOf(c, ctx) !== g) return null;
  return g;
}

/** 副牌花色的显示顺序：红黑交错，主牌组放最后。 */
export function suitDisplayOrder(trumpSuit: Suit | null): Suit[] {
  const blacks: Suit[] = (['S', 'C'] as Suit[]).filter((x) => x !== trumpSuit);
  const reds: Suit[] = (['H', 'D'] as Suit[]).filter((x) => x !== trumpSuit);
  // 多的颜色先放，然后交错：黑红黑（红）或 红黑红
  const [more, less] = blacks.length >= reds.length ? [blacks, reds] : [reds, blacks];
  const out: Suit[] = [];
  for (let i = 0; i < Math.max(more.length, less.length); i++) {
    if (more[i]) out.push(more[i] as Suit);
    if (less[i]) out.push(less[i] as Suit);
  }
  return out;
}

/** 手牌排序：副牌按红黑交错的花色顺序，主牌在最后，组内按序位升序。 */
export function sortCards(cards: readonly Card[], ctx: TrumpCtx): Card[] {
  const order = suitDisplayOrder(ctx.trumpSuit);
  const groupRank = (g: Group): number => (g === 'T' ? 4 : order.indexOf(g));
  return [...cards].sort((a, b) => {
    const ga = groupOf(a, ctx), gb = groupOf(b, ctx);
    if (ga !== gb) return groupRank(ga) - groupRank(gb);
    const oa = ordinal(a, ctx), ob = ordinal(b, ctx);
    if (oa !== ob) return oa - ob;
    if (a.suit !== b.suit) return a.suit < b.suit ? -1 : 1;
    return a.deck - b.deck;
  });
}

export { ACE };
