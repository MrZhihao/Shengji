/** 牌的基本定义：三副牌共 162 张，每张有唯一 id。 */

export type Suit = 'S' | 'H' | 'D' | 'C';
export const SUITS: readonly Suit[] = ['S', 'H', 'D', 'C'];

/** 王牌的 suit 记为 J，rank 用 15（小王）和 16（大王）。 */
export type CardSuit = Suit | 'J';
export const SMALL_JOKER = 15;
export const BIG_JOKER = 16;
export const ACE = 14;

export type CardId = string;

export interface Card {
  readonly id: CardId;
  readonly suit: CardSuit;
  readonly rank: number;
  readonly deck: number;
}

export const RANKS: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

export function cardId(suit: CardSuit, rank: number, deck: number): CardId {
  return `${suit}${rank}-${deck}`;
}

export function makeDeck(decks: number): Card[] {
  const cards: Card[] = [];
  for (let d = 0; d < decks; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) cards.push({ id: cardId(suit, rank, d), suit, rank, deck: d });
    }
    cards.push({ id: cardId('J', SMALL_JOKER, d), suit: 'J', rank: SMALL_JOKER, deck: d });
    cards.push({ id: cardId('J', BIG_JOKER, d), suit: 'J', rank: BIG_JOKER, deck: d });
  }
  return cards;
}

/** 同花色同点数即同一「身份」，对子、三条按身份判定。 */
export function identityKey(c: { suit: CardSuit; rank: number }): string {
  return `${c.suit}${c.rank}`;
}

export function isJoker(c: Card): boolean {
  return c.suit === 'J';
}

export function cardPoints(c: Card): number {
  if (c.rank === 5) return 5;
  if (c.rank === 10 || c.rank === 13) return 10;
  return 0;
}

export function sumPoints(cards: readonly Card[]): number {
  let s = 0;
  for (const c of cards) s += cardPoints(c);
  return s;
}

export function rankName(rank: number): string {
  switch (rank) {
    case 11: return 'J';
    case 12: return 'Q';
    case 13: return 'K';
    case 14: return 'A';
    case SMALL_JOKER: return '小王';
    case BIG_JOKER: return '大王';
    default: return String(rank);
  }
}

const SUIT_GLYPH: Record<CardSuit, string> = { S: '♠', H: '♥', D: '♦', C: '♣', J: '' };

export function cardName(c: { suit: CardSuit; rank: number }): string {
  return `${SUIT_GLYPH[c.suit]}${rankName(c.rank)}`;
}

export function suitName(suit: Suit | null): string {
  if (suit === null) return '无主';
  return SUIT_GLYPH[suit];
}

export function removeCards(hand: readonly Card[], toRemove: readonly Card[]): Card[] {
  const ids = new Set(toRemove.map((c) => c.id));
  return hand.filter((c) => !ids.has(c.id));
}

export function findCards(hand: readonly Card[], ids: readonly CardId[]): Card[] | null {
  const byId = new Map(hand.map((c) => [c.id, c] as const));
  const out: Card[] = [];
  const seen = new Set<CardId>();
  for (const id of ids) {
    const c = byId.get(id);
    if (!c || seen.has(id)) return null;
    seen.add(id);
    out.push(c);
  }
  return out;
}
