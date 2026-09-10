import { cardId, type Card, type CardSuit } from '../src/cards.ts';
import type { TrumpCtx } from '../src/trump.ts';

const RANK_MAP: Record<string, number> = { J: 11, Q: 12, K: 13, A: 14, SJ: 15, BJ: 16 };
const SUIT_MAP: Record<string, CardSuit> = { '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' };

let deckCounter = new Map<string, number>();

export function resetDecks(): void {
  deckCounter = new Map();
}

/** c('♠A') → 黑桃 A；c('SJ') 小王；c('BJ') 大王。同一张牌多次调用自动换副。 */
export function c(name: string, deck?: number): Card {
  let suit: CardSuit, rankStr: string;
  if (name === 'SJ' || name === 'BJ') {
    suit = 'J';
    rankStr = name;
  } else {
    suit = SUIT_MAP[name[0] as string] as CardSuit;
    rankStr = name.slice(1);
  }
  const rank = RANK_MAP[rankStr] ?? Number(rankStr);
  const key = `${suit}${rank}`;
  const d = deck ?? (deckCounter.get(key) ?? 0);
  if (deck === undefined) deckCounter.set(key, d + 1);
  return { id: cardId(suit, rank, d % 3), suit, rank, deck: d % 3 };
}

/** cs('♠A ♠A ♠K') → 三张牌，重复的自动分到不同副。 */
export function cs(names: string): Card[] {
  resetDecks();
  return names.trim().split(/\s+/).map((n) => c(n));
}

/** 不重置副数计数的版本，用于同一测试里构造多手牌 */
export function more(names: string): Card[] {
  return names.trim().split(/\s+/).map((n) => c(n));
}

export const H5: TrumpCtx = { level: 5, trumpSuit: 'H' };
export const NT5: TrumpCtx = { level: 5, trumpSuit: null };
