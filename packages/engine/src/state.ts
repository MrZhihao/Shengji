/** 游戏状态、操作与事件的类型定义。 */
import type { Card, CardId, Suit } from './cards.ts';
import type { Decomposition } from './combos.ts';
import type { GameConfig } from './config.ts';
import type { LevelIndex } from './levels.ts';
import type { TrickPlay } from './trick.ts';

export type Seat = number;

export type Phase = 'dealing' | 'declaring' | 'bottom' | 'callFriend' | 'playing' | 'roundEnd' | 'gameOver';

export interface Declaration {
  readonly seat: Seat;
  readonly cards: readonly Card[];
  /** null 为王牌亮无主 */
  readonly suit: Suit | null;
  readonly count: number;
}

export interface FriendCallSpec {
  readonly suit: Suit;
  readonly rank: number;
  readonly nth: number;
}

export interface FriendCall extends FriendCallSpec {
  /** 已打出的张数 */
  readonly played: number;
  /** 打出第 nth 张的人；庄家自己打出时也记庄家 */
  readonly resolvedSeat: Seat | null;
}

export interface Trick {
  readonly leader: Seat;
  readonly plays: readonly TrickPlay[];
  /** 首出生效后的分解 */
  readonly lead: Decomposition | null;
}

export interface TrickRecord {
  readonly leader: Seat;
  readonly winner: Seat;
  readonly plays: readonly TrickPlay[];
  readonly points: number;
}

export interface RoundResult {
  readonly round: number;
  readonly dealer: Seat;
  readonly dealerTeam: readonly Seat[];
  readonly opponents: readonly Seat[];
  readonly capturedByOpponents: number;
  readonly bottomCards: readonly Card[];
  readonly bottomPoints: number;
  readonly bottomMultiplier: number;
  readonly bottomBonus: number;
  readonly penaltyDelta: number;
  /** 闲家最终得分 */
  readonly opponentPoints: number;
  readonly dealerHeld: boolean;
  readonly levelsUp: number;
  readonly levelsBefore: readonly LevelIndex[];
  readonly levelsAfter: readonly LevelIndex[];
  readonly nextDealer: Seat;
  readonly gameOver: boolean;
}

export interface GameState {
  readonly config: GameConfig;
  readonly seed: string;
  readonly round: number;
  readonly redeals: number;
  readonly phase: Phase;
  readonly levels: readonly LevelIndex[];
  readonly dealer: Seat | null;
  /** 当局级牌点数 */
  readonly level: number;
  readonly trumpSuit: Suit | null;
  readonly trumpDecided: boolean;
  readonly declaration: Declaration | null;
  readonly deck: readonly Card[];
  readonly hands: readonly (readonly Card[])[];
  readonly bottom: readonly Card[];
  readonly dealTurn: Seat;
  /** 首局从谁开始发牌，重发首局时沿用 */
  readonly firstDealSeat: Seat;
  readonly friendCalls: readonly FriendCall[];
  readonly friends: readonly Seat[];
  readonly trick: Trick | null;
  readonly tricks: readonly TrickRecord[];
  readonly captured: readonly number[];
  readonly penalties: readonly number[];
  readonly lastRound: RoundResult | null;
  readonly winners: readonly Seat[] | null;
}

export type Action =
  | { readonly type: 'dealCard' }
  | { readonly type: 'declare'; readonly seat: Seat; readonly cards: readonly CardId[] }
  | { readonly type: 'closeDeclaring' }
  | { readonly type: 'exchangeBottom'; readonly seat: Seat; readonly cards: readonly CardId[] }
  | { readonly type: 'callFriend'; readonly seat: Seat; readonly calls: readonly FriendCallSpec[] }
  | { readonly type: 'play'; readonly seat: Seat; readonly cards: readonly CardId[] }
  | { readonly type: 'nextRound' };

export type GameEvent =
  | { readonly type: 'cardDealt'; readonly seat: Seat; readonly card: Card }
  | { readonly type: 'declared'; readonly seat: Seat; readonly cards: readonly Card[]; readonly suit: Suit | null; readonly count: number }
  | { readonly type: 'redeal' }
  | { readonly type: 'roundRestarted' }
  | { readonly type: 'declaringClosed'; readonly trumpSuit: Suit | null; readonly byBottom: boolean }
  | { readonly type: 'bottomTaken'; readonly seat: Seat; readonly count: number }
  | { readonly type: 'bottomExchanged'; readonly seat: Seat }
  | { readonly type: 'friendCalled'; readonly calls: readonly FriendCallSpec[] }
  | { readonly type: 'cardsPlayed'; readonly seat: Seat; readonly cards: readonly Card[] }
  | { readonly type: 'throwFailed'; readonly seat: Seat; readonly attempted: readonly Card[]; readonly forced: readonly Card[]; readonly penalty: number }
  | { readonly type: 'friendRevealed'; readonly seat: Seat; readonly call: FriendCallSpec }
  | { readonly type: 'trickWon'; readonly winner: Seat; readonly points: number }
  | { readonly type: 'roundScored'; readonly result: RoundResult }
  | { readonly type: 'dealerChanged'; readonly dealer: Seat }
  | { readonly type: 'gameOver'; readonly winners: readonly Seat[] };
