/** 状态机：createGame 创建一局，applyAction 推进。纯函数，返回新状态与事件。 */
import { SUITS, findCards, identityKey, makeDeck, removeCards, sumPoints, type Card, type Suit } from './cards.ts';
import type { GameConfig } from './config.ts';
import { handSize } from './config.ts';
import { ruleError, type RuleError } from './errors.ts';
import { validateFollow } from './follow.ts';
import { validateLead } from './lead.ts';
import { advanceLevel, isTopLevel, levelRank } from './levels.ts';
import { createRng } from './rng.ts';
import { scoreRound } from './scoring.ts';
import type { Action, FriendCall, FriendCallSpec, GameEvent, GameState, RoundResult, Seat, Trick } from './state.ts';
import { bottomMultiplier, trickWinner, type TrickPlay } from './trick.ts';
import type { TrumpCtx } from './trump.ts';
import type { Decomposition } from './combos.ts';

export type ApplyResult =
  | { readonly ok: true; readonly state: GameState; readonly events: readonly GameEvent[] }
  | { readonly ok: false; readonly error: RuleError };

export interface CreateOptions {
  /** 首局从谁开始发牌，默认 0 号座位（房主） */
  readonly firstDealSeat?: Seat;
}

export function ctxOf(s: GameState): TrumpCtx {
  return { level: s.level, trumpSuit: s.trumpSuit };
}

export function nextSeat(s: GameState, seat: Seat): Seat {
  return (seat + 1) % s.config.players;
}

export function currentTurn(s: GameState): Seat | null {
  if (s.phase === 'bottom' || s.phase === 'callFriend') return s.dealer;
  if (s.phase !== 'playing' || !s.trick) return null;
  const last = s.trick.plays[s.trick.plays.length - 1];
  return last ? nextSeat(s, last.seat) : s.trick.leader;
}

export function dealerTeam(s: GameState): Seat[] {
  return s.dealer === null ? [] : [s.dealer, ...s.friends];
}

export function createGame(config: GameConfig, seed: string, opts: CreateOptions = {}): GameState {
  handSize(config); // 校验牌数可整除
  const n = config.players;
  const base: GameState = {
    config,
    seed,
    round: 1,
    redeals: 0,
    phase: 'dealing',
    levels: Array.from({ length: n }, () => 0),
    dealer: null,
    level: levelRank(0),
    trumpSuit: null,
    trumpDecided: false,
    declaration: null,
    deck: [],
    hands: Array.from({ length: n }, () => []),
    bottom: [],
    dealTurn: opts.firstDealSeat ?? 0,
    firstDealSeat: opts.firstDealSeat ?? 0,
    friendCalls: [],
    friends: [],
    trick: null,
    tricks: [],
    captured: Array.from({ length: n }, () => 0),
    penalties: Array.from({ length: n }, () => 0),
    lastRound: null,
    winners: null,
  };
  return startDealing(base, opts.firstDealSeat ?? 0);
}

function startDealing(s: GameState, firstSeat: Seat): GameState {
  const n = s.config.players;
  const rng = createRng(`${s.seed}/${s.round}/${s.redeals}`);
  const deck = rng.shuffle(makeDeck(s.config.decks));
  return {
    ...s,
    phase: 'dealing',
    trumpSuit: null,
    trumpDecided: false,
    declaration: null,
    deck,
    hands: Array.from({ length: n }, () => []),
    bottom: [],
    dealTurn: firstSeat,
    friendCalls: [],
    friends: [],
    trick: null,
    tricks: [],
    captured: Array.from({ length: n }, () => 0),
    penalties: Array.from({ length: n }, () => 0),
  };
}

function fail(code: RuleError['code'], message: string): ApplyResult {
  return { ok: false, error: ruleError(code, message) };
}

function ok(state: GameState, events: GameEvent[]): ApplyResult {
  return { ok: true, state, events };
}

function replaceAt<T>(arr: readonly T[], i: number, v: T): T[] {
  const out = [...arr];
  out[i] = v;
  return out;
}

export function applyAction(s: GameState, a: Action): ApplyResult {
  switch (a.type) {
    case 'dealCard': return dealCard(s);
    case 'declare': return declare(s, a.seat, a.cards);
    case 'closeDeclaring': return closeDeclaring(s);
    case 'exchangeBottom': return exchangeBottom(s, a.seat, a.cards);
    case 'callFriend': return callFriend(s, a.seat, a.calls);
    case 'play': return play(s, a.seat, a.cards);
    case 'nextRound': return nextRound(s);
  }
}

function dealCard(s: GameState): ApplyResult {
  if (s.phase !== 'dealing') return fail('WRONG_PHASE', '现在不是发牌阶段');
  const deck = [...s.deck];
  const card = deck.pop() as Card;
  const seat = s.dealTurn;
  const hands = replaceAt(s.hands, seat, [...(s.hands[seat] as readonly Card[]), card]);
  const done = deck.length === s.config.bottomSize;
  const next: GameState = {
    ...s,
    deck: done ? [] : deck,
    bottom: done ? deck : s.bottom,
    hands,
    dealTurn: nextSeat(s, seat),
    phase: done ? 'declaring' : 'dealing',
  };
  return ok(next, [{ type: 'cardDealt', seat, card }]);
}

function declarationKindRank(cards: readonly Card[]): number {
  const c = cards[0] as Card;
  if (c.suit !== 'J') return 0;
  return c.rank === 16 ? 2 : 1;
}

function declare(s: GameState, seat: Seat, ids: readonly string[]): ApplyResult {
  if (s.phase !== 'dealing' && s.phase !== 'declaring') return fail('WRONG_PHASE', '现在不能亮主');
  const hand = s.hands[seat];
  if (!hand) return fail('INVALID_ACTION', '座位不存在');
  const cards = findCards(hand, ids);
  if (!cards || cards.length === 0) return fail('CARDS_NOT_IN_HAND', '亮出的牌不在手中');
  const first = cards[0] as Card;
  if (cards.length > 3) return fail('INVALID_DECLARATION', '最多亮三张');
  const allJokers = cards.every((c) => c.suit === 'J');
  // 三张王不论大小王混不混都可以亮；其余情况必须是同一张牌的多张
  const mixedTripleJokers = allJokers && cards.length === 3;
  if (!mixedTripleJokers && !cards.every((c) => identityKey(c) === identityKey(first))) {
    return fail('INVALID_DECLARATION', '亮主的牌必须是同一张牌的多张，三张王可以混');
  }
  let suit: Suit | null;
  if (first.suit === 'J') {
    if (cards.length < 2) return fail('INVALID_DECLARATION', '单张王不能亮主');
    suit = null;
  } else {
    if (first.rank !== s.level) return fail('INVALID_DECLARATION', `只能用级牌亮主，当前级牌是 ${s.level}`);
    suit = first.suit;
  }
  const current = s.declaration;
  const count = cards.length;
  if (current) {
    if (count < current.count) return fail('DECLARATION_TOO_WEAK', `已有人亮了 ${current.count} 张，要反主必须更多张`);
    if (count === current.count) {
      if (!s.config.allowEqualCountOverride) return fail('DECLARATION_TOO_WEAK', '张数相同不能反主');
      if (declarationKindRank(cards) <= declarationKindRank(current.cards)) {
        return fail('DECLARATION_TOO_WEAK', '同张数只能用更大的王反主');
      }
    }
  }
  const next: GameState = {
    ...s,
    declaration: { seat, cards, suit, count },
    trumpSuit: suit,
    trumpDecided: true,
    // 首局谁最终抢到主谁坐庄：被反主则庄家随之改变；非首局庄家已定，反主只改主花色
    dealer: s.round === 1 ? seat : s.dealer,
  };
  return ok(next, [{ type: 'declared', seat, cards, suit, count }]);
}

function closeDeclaring(s: GameState): ApplyResult {
  if (s.phase !== 'declaring') return fail('WRONG_PHASE', '发牌还没结束');
  const events: GameEvent[] = [];
  let next = s;
  if (!s.declaration) {
    if (s.dealer === null) {
      if (!s.config.redealIfNoDeclarerFirstRound) return fail('INVALID_ACTION', '首局无人亮主且未配置重发');
      // 发牌轮数是人数的整数倍，此时 dealTurn 已回到首局的起点
      next = startDealing({ ...s, redeals: s.redeals + 1 }, s.dealTurn);
      return ok(next, [{ type: 'redeal' }]);
    }
    const flipped = [...s.bottom].reverse().find((c) => c.suit !== 'J');
    const trumpSuit = flipped ? (flipped.suit as Suit) : null;
    next = { ...s, trumpSuit, trumpDecided: true };
    events.push({ type: 'declaringClosed', trumpSuit, byBottom: true });
  } else {
    events.push({ type: 'declaringClosed', trumpSuit: s.trumpSuit, byBottom: false });
  }
  const dealer = next.dealer as Seat;
  const hands = replaceAt(next.hands, dealer, [...(next.hands[dealer] as readonly Card[]), ...next.bottom]);
  next = { ...next, hands, bottom: [], phase: 'bottom' };
  events.push({ type: 'bottomTaken', seat: dealer, count: s.bottom.length });
  return ok(next, events);
}

function exchangeBottom(s: GameState, seat: Seat, ids: readonly string[]): ApplyResult {
  if (s.phase !== 'bottom') return fail('WRONG_PHASE', '现在不是扣底阶段');
  if (seat !== s.dealer) return fail('NOT_DEALER', '只有庄家能扣底');
  const hand = s.hands[seat] as readonly Card[];
  const cards = findCards(hand, ids);
  if (!cards) return fail('CARDS_NOT_IN_HAND', '扣的牌不在手中');
  if (cards.length !== s.config.bottomSize) {
    return fail('WRONG_CARD_COUNT', `必须扣 ${s.config.bottomSize} 张`);
  }
  const next: GameState = {
    ...s,
    hands: replaceAt(s.hands, seat, removeCards(hand, cards)),
    bottom: cards,
    phase: 'callFriend',
  };
  return ok(next, [{ type: 'bottomExchanged', seat }]);
}

function callFriend(s: GameState, seat: Seat, calls: readonly FriendCallSpec[]): ApplyResult {
  if (s.phase !== 'callFriend') return fail('WRONG_PHASE', '现在不是叫朋友阶段');
  if (seat !== s.dealer) return fail('NOT_DEALER', '只有庄家能叫朋友');
  if (calls.length !== s.config.friendCount) {
    return fail('INVALID_FRIEND_CALL', `必须叫 ${s.config.friendCount} 个朋友`);
  }
  const seen = new Set<string>();
  for (const c of calls) {
    if (!SUITS.includes(c.suit)) return fail('INVALID_FRIEND_CALL', '朋友牌花色无效');
    if (c.suit === s.trumpSuit) return fail('INVALID_FRIEND_CALL', '朋友牌不能是主花色');
    if (!Number.isInteger(c.rank) || c.rank < 2 || c.rank > 14) return fail('INVALID_FRIEND_CALL', '朋友牌点数无效');
    if (c.rank === s.level) return fail('INVALID_FRIEND_CALL', '朋友牌不能是级牌');
    if (!Number.isInteger(c.nth) || c.nth < 1 || c.nth > s.config.decks) {
      return fail('INVALID_FRIEND_CALL', `序号必须在 1 到 ${s.config.decks} 之间`);
    }
    const key = `${c.suit}${c.rank}#${c.nth}`;
    if (seen.has(key)) return fail('INVALID_FRIEND_CALL', '两个朋友牌不能完全相同');
    seen.add(key);
  }
  const friendCalls: FriendCall[] = calls.map((c) => ({ ...c, played: 0, resolvedSeat: null }));
  const next: GameState = {
    ...s,
    friendCalls,
    phase: 'playing',
    trick: { leader: seat, plays: [], lead: null },
  };
  return ok(next, [{ type: 'friendCalled', calls }]);
}

function play(s: GameState, seat: Seat, ids: readonly string[]): ApplyResult {
  if (s.phase !== 'playing' || !s.trick) return fail('WRONG_PHASE', '现在不是出牌阶段');
  const turn = currentTurn(s);
  if (turn !== seat) return fail('NOT_YOUR_TURN', '还没轮到你出牌');
  const hand = s.hands[seat] as readonly Card[];
  const cards = findCards(hand, ids);
  if (!cards || cards.length === 0) return fail('CARDS_NOT_IN_HAND', '出的牌不在手中');
  const ctx = ctxOf(s);
  const events: GameEvent[] = [];
  let actual: readonly Card[] = cards;
  let lead: Decomposition | null = s.trick.lead;
  let penalties = s.penalties;

  if (s.trick.plays.length === 0) {
    const others = s.hands.filter((_, i) => i !== seat);
    const outcome = validateLead(cards, others, ctx, s.config.throwPenaltyPerCard);
    if ('code' in outcome) return { ok: false, error: outcome };
    lead = outcome.effective;
    if (outcome.forced) {
      actual = outcome.forced.cards;
      penalties = replaceAt(penalties, seat, (penalties[seat] as number) + outcome.penalty);
      events.push({ type: 'throwFailed', seat, attempted: cards, forced: actual, penalty: outcome.penalty });
    }
  } else {
    const err = validateFollow(lead as Decomposition, hand, cards, ctx);
    if (err) return { ok: false, error: err };
  }

  const plays: TrickPlay[] = [...s.trick.plays, { seat, cards: actual }];
  events.push({ type: 'cardsPlayed', seat, cards: actual });

  // 朋友牌计数
  let friendCalls = s.friendCalls;
  let friends = s.friends;
  for (const c of actual) {
    if (c.suit === 'J') continue;
    friendCalls = friendCalls.map((fc) => {
      if (fc.resolvedSeat !== null || fc.suit !== c.suit || fc.rank !== c.rank) return fc;
      if (seat === s.dealer && !s.config.dealerCountsForFriend) return fc;
      const played = fc.played + 1;
      if (played === fc.nth) {
        events.push({ type: 'friendRevealed', seat, call: { suit: fc.suit, rank: fc.rank, nth: fc.nth } });
        if (seat !== s.dealer && !friends.includes(seat)) friends = [...friends, seat];
        return { ...fc, played, resolvedSeat: seat };
      }
      return { ...fc, played };
    });
  }

  let next: GameState = {
    ...s,
    hands: replaceAt(s.hands, seat, removeCards(hand, actual)),
    trick: { ...s.trick, plays, lead },
    friendCalls,
    friends,
    penalties,
  };

  if (plays.length < s.config.players) return ok(next, events);

  const winnerIdx = trickWinner(plays, lead as Decomposition, ctx);
  const winner = (plays[winnerIdx] as TrickPlay).seat;
  let points = 0;
  for (const p of plays) points += sumPoints(p.cards);
  next = {
    ...next,
    captured: replaceAt(next.captured, winner, (next.captured[winner] as number) + points),
    tricks: [...next.tricks, { leader: s.trick.leader, winner, plays, points }],
  };
  events.push({ type: 'trickWon', winner, points });

  const roundOver = next.hands.every((h) => h.length === 0);
  if (!roundOver) {
    const trick: Trick = { leader: winner, plays: [], lead: null };
    return ok({ ...next, trick }, events);
  }
  return endRound({ ...next, trick: null }, winner, lead as Decomposition, events);
}

function endRound(s: GameState, lastWinner: Seat, lastLead: Decomposition, events: GameEvent[]): ApplyResult {
  const dealer = s.dealer as Seat;
  const team = dealerTeam(s);
  const opponents: Seat[] = [];
  for (let i = 0; i < s.config.players; i++) if (!team.includes(i)) opponents.push(i);

  let capturedByOpponents = 0;
  for (const o of opponents) capturedByOpponents += s.captured[o] as number;
  const bottomPoints = sumPoints(s.bottom);
  const mult = bottomMultiplier(lastLead, s.config);
  const bottomBonus = opponents.includes(lastWinner) ? bottomPoints * mult : 0;
  let penaltyDelta = 0;
  for (const t of team) penaltyDelta += s.penalties[t] as number;
  for (const o of opponents) penaltyDelta -= s.penalties[o] as number;
  const opponentPoints = Math.max(0, capturedByOpponents + bottomBonus + penaltyDelta);

  const { dealerHeld, levelsUp } = scoreRound(opponentPoints, s.config);
  const winnersTeam = dealerHeld ? team : opponents;
  const gameOver = dealerHeld && isTopLevel(s.levels[dealer] as number);
  const levelsBefore = [...s.levels];
  let levels = [...s.levels];
  if (!gameOver) {
    for (const w of winnersTeam) levels[w] = advanceLevel(levels[w] as number, levelsUp);
  }

  let nextDealer = dealer;
  for (let k = 1; k < s.config.players; k++) {
    const cand = (dealer + k) % s.config.players;
    if (winnersTeam.includes(cand)) { nextDealer = cand; break; }
  }

  const result: RoundResult = {
    round: s.round,
    dealer,
    dealerTeam: team,
    opponents,
    capturedByOpponents,
    bottomCards: s.bottom,
    bottomPoints,
    bottomMultiplier: mult,
    bottomBonus,
    penaltyDelta,
    opponentPoints,
    dealerHeld,
    levelsUp,
    levelsBefore,
    levelsAfter: levels,
    nextDealer,
    gameOver,
  };
  events.push({ type: 'roundScored', result });
  const next: GameState = {
    ...s,
    levels,
    lastRound: result,
    phase: gameOver ? 'gameOver' : 'roundEnd',
    winners: gameOver ? team : null,
  };
  if (gameOver) events.push({ type: 'gameOver', winners: team });
  return ok(next, events);
}

/**
 * 房主重发本局：等级、局数、庄家（非首局）都保留，当前进度作废，换一副新牌重新发。
 * 首局重发时庄家也清空，仍由先亮主者坐庄。
 */
export function restartRound(s: GameState): { state: GameState; events: GameEvent[] } {
  if (s.phase === 'gameOver') return { state: s, events: [] };
  const firstRound = s.round === 1;
  const dealer = firstRound ? null : s.dealer;
  const base: GameState = {
    ...s,
    dealer,
    level: dealer === null ? levelRank(0) : levelRank(s.levels[dealer] as number),
    redeals: s.redeals + 1,
    winners: null,
  };
  const start = dealer === null ? (s.firstDealSeat ?? 0) : nextSeat(s, dealer);
  return { state: startDealing(base, start), events: [{ type: 'roundRestarted' }] };
}

function nextRound(s: GameState): ApplyResult {
  if (s.phase !== 'roundEnd' || !s.lastRound) return fail('WRONG_PHASE', '本局还没结束');
  const dealer = s.lastRound.nextDealer;
  const base: GameState = {
    ...s,
    round: s.round + 1,
    redeals: 0,
    dealer,
    level: levelRank(s.levels[dealer] as number),
  };
  const next = startDealing(base, nextSeat(s, dealer));
  return ok(next, [{ type: 'dealerChanged', dealer }]);
}
