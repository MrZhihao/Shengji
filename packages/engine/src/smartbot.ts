/**
 * 带策略的机器人：不搜索，只用牌桌常识。
 * 亮主看牌力；扣底扣短门无分小牌；叫朋友叫自己缺门的 A；
 * 首出先打压不住的牌，跟牌按「这墩分归谁」给候选打分。
 */
import { RANKS, SUITS, cardPoints, identityKey, sumPoints, type Card, type Suit } from './cards.ts';
import { decompose, poolOf, type Component } from './combos.ts';
import { handSize } from './config.ts';
import { generateFollow, generateFollowWith, highestChooser, lowestChooser, validateFollow, type FollowChooser } from './follow.ts';
import { ctxOf, currentTurn, dealerTeam } from './reducer.ts';
import type { Rng } from './rng.ts';
import type { Action, FriendCallSpec, GameState, Seat } from './state.ts';
import { trickWinner, type TrickPlay } from './trick.ts';
import { groupOf, ordinal, type Group, type TrumpCtx } from './trump.ts';
import { possibleDeclarations } from './bot.ts';

/** 可单独开关的策略特性，用于做 A/B 对比。 */
export interface SmartFeatures {
  /** 按发牌进度外推牌力的亮主 */
  readonly declare: boolean;
  /** 只叫自己没有的牌、优先缺门 A 的叫朋友 */
  readonly call: boolean;
  /** 首出：帮朋友现身、抢末墩 */
  readonly lead: boolean;
  /** 跟牌：稳墩判断、末墩加权 */
  readonly follow: boolean;
}

export const SMART_V1: SmartFeatures = { declare: false, call: false, lead: false, follow: false };
export const SMART_V2: SmartFeatures = { declare: true, call: true, lead: true, follow: true };

/** 兼容旧接口：1 是第一版，2 是全部特性 */
export type SmartLevel = 1 | 2 | SmartFeatures;

function featuresOf(level: SmartLevel): SmartFeatures {
  if (level === 1) return SMART_V1;
  if (level === 2) return SMART_V2;
  return level;
}

// ---------- 记牌 ----------

/** 每个身份还有多少张在别人手里（或未知的底牌里）。 */
function unseenCounts(s: GameState, seat: Seat): Map<string, number> {
  const counts = new Map<string, number>();
  const dec = (c: Card) => counts.set(identityKey(c), (counts.get(identityKey(c)) ?? s.config.decks) - 1);
  // 先把所有身份初始化为 3
  for (const suit of SUITS) for (const rank of RANKS) counts.set(`${suit}${rank}`, s.config.decks);
  counts.set('J15', s.config.decks);
  counts.set('J16', s.config.decks);
  for (const c of s.hands[seat] ?? []) dec(c);
  for (const t of s.tricks) for (const p of t.plays) for (const c of p.cards) dec(c);
  if (s.trick) for (const p of s.trick.plays) for (const c of p.cards) dec(c);
  if (seat === s.dealer) for (const c of s.bottom) dec(c);
  return counts;
}

/** 别人手里还可能有压过该组件的牌吗？ */
function beatable(comp: Component, group: Group, unseen: Map<string, number>, ctx: TrumpCtx): boolean {
  const higher: { ord: number; count: number }[] = [];
  for (const [key, count] of unseen) {
    if (count <= 0) continue;
    const suit = key[0] as Card['suit'];
    const rank = Number(key.slice(1));
    const card: Card = { id: key, suit, rank, deck: 0 };
    if (groupOf(card, ctx) !== group) continue;
    const o = ordinal(card, ctx);
    if (o > comp.top) higher.push({ ord: o, count });
  }
  if (comp.kind === 'single') return higher.length > 0;
  if (comp.kind === 'pair') return higher.some((h) => h.count >= 2);
  if (comp.kind === 'triple') return higher.some((h) => h.count >= 3);
  // 拖拉机：需要连续序位都还剩 mult 张以上
  const ords = new Set(higher.filter((h) => h.count >= comp.mult).map((h) => h.ord));
  for (const o of ords) {
    let ok = true;
    for (let i = 0; i < comp.length; i++) if (!ords.has(o + i)) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

/** 谁在哪个组已经断门：跟牌时出了别的组的牌，就说明没有该组的牌了。 */
function knownVoids(s: GameState): Map<Seat, Set<Group>> {
  const out = new Map<Seat, Set<Group>>();
  const ctx = ctxOf(s);
  const scan = (leader: Seat, plays: readonly TrickPlay[], lead: { group: Group } | null) => {
    if (!lead) return;
    for (const p of plays) {
      if (p.seat === leader) continue;
      if (p.cards.some((c) => groupOf(c, ctx) !== lead.group)) {
        const set = out.get(p.seat) ?? new Set<Group>();
        set.add(lead.group);
        out.set(p.seat, set);
      }
    }
  };
  for (const t of s.tricks) {
    const first = t.plays[0];
    if (first) scan(t.leader, t.plays, decompose(first.cards, ctx));
  }
  if (s.trick) scan(s.trick.leader, s.trick.plays, s.trick.lead);
  return out;
}

/** 外面还有多少张主牌 */
function unseenTrumps(unseen: Map<string, number>, ctx: TrumpCtx): number {
  let n = 0;
  for (const [key, count] of unseen) {
    if (count <= 0) continue;
    const card: Card = { id: key, suit: key[0] as Card['suit'], rank: Number(key.slice(1)), deck: 0 };
    if (groupOf(card, ctx) === 'T') n += count;
  }
  return n;
}

// ---------- 阵营 ----------

interface Sides {
  /** 我这边的人，含自己 */
  mates: Set<Seat>;
  likelyDealerSide: boolean;
}

function sidesOf(s: GameState, seat: Seat): Sides {
  const team = dealerTeam(s);
  const hand = s.hands[seat] ?? [];
  const holdsFriendCard = s.friendCalls.some((c) => c.resolvedSeat === null && hand.some((h) => h.suit === c.suit && h.rank === c.rank));
  if (team.includes(seat) || (holdsFriendCard && s.dealer !== null)) {
    const mates = new Set<Seat>(team);
    mates.add(seat);
    return { mates, likelyDealerSide: true };
  }
  const mates = new Set<Seat>([seat]);
  const allKnown = s.friendCalls.length > 0 && s.friendCalls.every((c) => c.resolvedSeat !== null);
  if (allKnown) for (let i = 0; i < s.config.players; i++) if (!team.includes(i)) mates.add(i);
  return { mates, likelyDealerSide: false };
}

// ---------- 亮主 ----------

export function smartDeclare(s: GameState, seat: Seat, _rng: Rng, level: SmartLevel = 2): Action | null {
  if (s.phase !== 'dealing' && s.phase !== 'declaring') return null;
  const options = possibleDeclarations(s, seat);
  if (options.length === 0) return null;
  return featuresOf(level).declare ? declareV2(s, seat, options) : declareV1(s, seat, options);
}

function declareV1(s: GameState, seat: Seat, options: Card[][]): Action | null {
  const hand = s.hands[seat] ?? [];
  const jokers = hand.filter((c) => c.suit === 'J').length;
  const levelCards = hand.filter((c) => c.rank === s.level).length;
  let best: { cards: Card[]; strength: number } | null = null;
  for (const cards of options) {
    const first = cards[0] as Card;
    let strength: number;
    if (first.suit === 'J') {
      strength = jokers * 2 + levelCards;
    } else {
      const suitCards = hand.filter((c) => c.suit === first.suit).length;
      const suitLevel = hand.filter((c) => c.suit === first.suit && c.rank === s.level).length;
      strength = suitCards + suitLevel * 2 + jokers;
    }
    if (s.declaration && s.declaration.seat === seat && s.declaration.suit === (first.suit === 'J' ? null : first.suit)) strength += 100;
    if (!best || strength > best.strength) best = { cards, strength };
  }
  if (!best) return null;
  const count = best.cards.length;
  const threshold = count >= 3 ? 0 : count === 2 ? 8 : 10;
  const bonus = s.dealer === null ? 1 : 0;
  if (best.strength + bonus < threshold) return null;
  return { type: 'declare', seat, cards: best.cards.map((c) => c.id) };
}

/** 假设某花色为主时这手牌的牌力，会按发牌进度外推最终主牌数。 */
export function trumpStrength(hand: readonly Card[], level: number, suit: Suit | null, progress: number): number {
  const ctx: TrumpCtx = { level, trumpSuit: suit };
  const trumps = hand.filter((c) => groupOf(c, ctx) === 'T');
  const p = Math.max(progress, 0.3);
  const expected = trumps.length / p;
  let high = 0;
  for (const c of trumps) {
    if (c.suit === 'J') high += c.rank === 16 ? 1.2 : 1;
    else if (c.rank === level) high += c.suit === suit ? 1 : 0.6;
    else if (c.rank === 14) high += 0.7;
    else if (c.rank === 13) high += 0.4;
  }
  const pool = poolOf(trumps, ctx);
  let pairs = 0;
  for (const id of pool.values()) if (id.cards.length >= 2) pairs += id.cards.length >= 3 ? 2 : 1;
  let voids = 0;
  if (suit !== null) {
    for (const other of SUITS) {
      if (other === suit) continue;
      if (!hand.some((c) => c.suit === other && c.rank !== level)) voids++;
    }
  }
  return expected + high * 1.5 + pairs * 1.2 + voids * 1.5 * progress;
}

/** 亮主阈值，可在模拟器里调参 */
export const smartTuning = {
  declareSingle: 11.5,
  declarePair: 9.5,
  earlyPenalty: 1.5,
  lateBonus: 1.5,
  overridePenalty: 1,
};

function declareV2(s: GameState, seat: Seat, options: Card[][]): Action | null {
  const hand = s.hands[seat] ?? [];
  const progress = Math.min(1, hand.length / handSize(s.config));
  const current = s.declaration;
  let best: { cards: Card[]; strength: number; mine: boolean } | null = null;
  for (const cards of options) {
    const first = cards[0] as Card;
    const suit: Suit | null = first.suit === 'J' ? null : (first.suit as Suit);
    const mine = current !== null && current.seat === seat && current.suit === suit;
    const strength = trumpStrength(hand, s.level, suit, progress);
    if (!best) best = { cards, strength, mine };
    else if (mine !== best.mine) { if (mine) best = { cards, strength, mine }; }
    else if (strength > best.strength) best = { cards, strength, mine };
  }
  if (!best) return null;
  // 自己亮过的花色再多一张就加固，别人更难反
  if (best.mine) return { type: 'declare', seat, cards: best.cards.map((c) => c.id) };
  const count = best.cards.length;
  let threshold = count >= 3 ? 0 : count === 2 ? smartTuning.declarePair : smartTuning.declareSingle;
  // 发牌早期手牌还不全，谨慎一点；快发完了还没人亮，就放低要求抢庄
  if (progress < 0.5) threshold += smartTuning.earlyPenalty;
  if (!current && progress > 0.85) threshold -= smartTuning.lateBonus;
  // 反别人的主要更有把握
  if (current && current.seat !== seat) threshold += smartTuning.overridePenalty;
  if (best.strength < threshold) return null;
  return { type: 'declare', seat, cards: best.cards.map((c) => c.id) };
}

// ---------- 扣底 ----------

export function smartExchangeBottom(s: GameState, seat: Seat, _rng: Rng): Action {
  const hand = s.hands[seat] ?? [];
  const ctx = ctxOf(s);
  const bySuit = new Map<Group, Card[]>();
  for (const c of hand) bySuit.set(groupOf(c, ctx), [...(bySuit.get(groupOf(c, ctx)) ?? []), c]);
  const pool = poolOf(hand, ctx);
  const scored = hand.map((c) => {
    const g = groupOf(c, ctx);
    const suitLen = bySuit.get(g)?.length ?? 0;
    const copies = pool.get(identityKey(c))?.cards.length ?? 1;
    let score = 30 - ordinal(c, ctx);
    if (g === 'T') score -= 40;
    if (cardPoints(c) > 0) score -= 25;
    if (g !== 'T') score += Math.max(0, 8 - suitLen) * 3;
    if (copies >= 2) score -= 12;
    if (c.rank === 14 && g !== 'T') score -= 15;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return { type: 'exchangeBottom', seat, cards: scored.slice(0, s.config.bottomSize).map((x) => x.c.id) };
}

// ---------- 叫朋友 ----------

export function smartCallFriend(s: GameState, seat: Seat, _rng: Rng, level: SmartLevel = 2): Action {
  return featuresOf(level).call ? callFriendV2(s, seat) : callFriendV1(s, seat);
}

function callFriendV1(s: GameState, seat: Seat): Action {
  const hand = s.hands[seat] ?? [];
  const candidates: { call: FriendCallSpec; score: number }[] = [];
  for (const suit of SUITS) {
    if (suit === s.trumpSuit) continue;
    const suitCards = hand.filter((c) => c.suit === suit).length;
    for (const rank of [14, 13, 12]) {
      if (rank === s.level) continue;
      const held = hand.filter((c) => c.suit === suit && c.rank === rank).length;
      if (held >= s.config.decks) continue;
      const score = (rank === 14 ? 30 : rank === 13 ? 12 : 4) - suitCards * 2 - held * 6;
      candidates.push({ call: { suit, rank, nth: Math.min(s.config.decks, held + 1) }, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const calls: FriendCallSpec[] = [];
  const usedSuits = new Set<Suit>();
  for (const cand of candidates) {
    if (calls.length >= s.config.friendCount) break;
    if (usedSuits.has(cand.call.suit) && candidates.some((x) => !usedSuits.has(x.call.suit) && !calls.includes(x.call))) continue;
    calls.push(cand.call);
    usedSuits.add(cand.call.suit);
  }
  let nth = 1;
  while (calls.length < s.config.friendCount) {
    const base = candidates[0]?.call ?? { suit: SUITS.find((x) => x !== s.trumpSuit) as Suit, rank: s.level === 14 ? 13 : 14, nth: 1 };
    const spec = { ...base, nth };
    if (!calls.some((c) => c.suit === spec.suit && c.rank === spec.rank && c.nth === spec.nth)) calls.push(spec);
    nth++;
  }
  return { type: 'callFriend', seat, calls };
}

/**
 * 叫朋友第二版：只叫自己手里和底牌里都没有的牌，序号一律「第一张」，谁先打出谁就是朋友，不会被自己的牌搅乱；
 * 优先缺门或短门的 A，朋友的 A 能赢墩，自己还能毙；两个朋友尽量不同花色，让更多人有机会成为朋友。
 */
function callFriendV2(s: GameState, seat: Seat): Action {
  const hand = s.hands[seat] ?? [];
  const bottom = s.bottom;
  const count = (cards: readonly Card[], suit: Suit, rank: number) => cards.filter((c) => c.suit === suit && c.rank === rank).length;
  interface Cand { call: FriendCallSpec; score: number }
  const cands: Cand[] = [];
  for (const suit of SUITS) {
    if (suit === s.trumpSuit) continue;
    const suitLen = hand.filter((c) => c.suit === suit).length;
    for (const rank of [14, 13, 12, 11]) {
      if (rank === s.level) continue;
      const mine = count(hand, suit, rank);
      const buried = count(bottom, suit, rank);
      const outside = s.config.decks - mine - buried;
      if (outside <= 0) continue;
      let score = rank === 14 ? 40 : rank === 13 ? 20 : rank === 12 ? 8 : 2;
      score -= suitLen * 3;          // 越短越好，缺门最好
      score -= mine * 12;            // 自己有这张牌会搅乱序号
      score += outside === s.config.decks ? 3 : 0;
      // 序号：自己没有就叫第一张；自己有 k 张，叫第 k+1 张只是权宜
      const nth = Math.min(s.config.decks, mine + 1);
      cands.push({ call: { suit, rank, nth }, score });
      // 第二个朋友可以叫同一张的第二张（前提是外面至少两张）
      if (outside >= 2 && mine === 0) cands.push({ call: { suit, rank, nth: 2 }, score: score - 14 });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const calls: FriendCallSpec[] = [];
  const key = (c: FriendCallSpec) => `${c.suit}${c.rank}#${c.nth}`;
  // 第一轮：不同花色优先
  for (const c of cands) {
    if (calls.length >= s.config.friendCount) break;
    if (calls.some((x) => x.suit === c.call.suit)) continue;
    calls.push(c.call);
  }
  // 第二轮：补齐
  for (const c of cands) {
    if (calls.length >= s.config.friendCount) break;
    if (calls.some((x) => key(x) === key(c.call))) continue;
    calls.push(c.call);
  }
  let nth = 1;
  while (calls.length < s.config.friendCount) {
    const suit = SUITS.find((x) => x !== s.trumpSuit) as Suit;
    const spec: FriendCallSpec = { suit, rank: s.level === 14 ? 13 : 14, nth };
    if (!calls.some((c) => key(c) === key(spec))) calls.push(spec);
    nth++;
  }
  return { type: 'callFriend', seat, calls };
}

// ---------- 出牌 ----------

interface LeadCandidate { cards: Card[]; score: number }

function leadCandidates(s: GameState, seat: Seat, sides: Sides, unseen: Map<string, number>, f: SmartFeatures): LeadCandidate[] {
  const hand = s.hands[seat] ?? [];
  const ctx = ctxOf(s);
  const lastTrick = f.lead && hand.length <= 3;
  const unresolvedCalls = f.lead && seat === s.dealer ? s.friendCalls.filter((c) => c.resolvedSeat === null) : [];
  const voids = f.lead ? knownVoids(s) : new Map<Seat, Set<Group>>();
  const trumpsOutside = f.lead ? unseenTrumps(unseen, ctx) : 0;
  const mateVoid = (g: Group) => [...sides.mates].some((m) => m !== seat && voids.get(m)?.has(g));
  const foeVoid = (g: Group) => {
    for (let i = 0; i < s.config.players; i++) if (!sides.mates.has(i) && voids.get(i)?.has(g)) return true;
    return false;
  };
  const byGroup = new Map<Group, Card[]>();
  for (const c of hand) byGroup.set(groupOf(c, ctx), [...(byGroup.get(groupOf(c, ctx)) ?? []), c]);
  const trumpCount = byGroup.get('T')?.length ?? 0;
  const out: LeadCandidate[] = [];
  for (const [g, cards] of byGroup) {
    const d = decompose(cards, ctx);
    if (!d) continue;
    const safe = d.components.filter((c) => !beatable(c, g, unseen, ctx));
    for (const comp of d.components) {
      const pts = sumPoints(comp.cards);
      const isSafe = safe.includes(comp);
      let score: number;
      if (isSafe) {
        score = 100 + comp.cards.length * 10 + pts * 2;
        if (g === 'T' && !sides.likelyDealerSide && trumpCount < 6) score -= 30; // 闲家别急着放主
      } else if (g === 'T') {
        score = (sides.likelyDealerSide && trumpCount >= 8 ? 60 : 15) - comp.top - pts * 4 - (comp.cards.length - 1) * 8;
      } else {
        score = 40 - comp.top - pts * 5 + Math.max(0, 8 - cards.length) * 2 - (comp.cards.length - 1) * 6;
        // 庄家用朋友牌花色的小单张引牌，让握着 A 的朋友尽早现身并赢墩
        if (comp.kind === 'single' && unresolvedCalls.some((c) => c.suit === g && c.rank > comp.top + 2) && cards.length <= 3) score += 28;
      }
      // 最后几墩：能赢就赢，末墩关系到抠底
      if (lastTrick && isSafe) score += 30;
      if (f.lead && g !== 'T' && trumpsOutside > 0) {
        // 对手已经断门会来毙，尤其别送分；队友断门则可以喂他毙
        if (foeVoid(g)) score -= isSafe ? 45 : 10 + pts * 3;
        else if (mateVoid(g) && !isSafe) score += 18 + pts * 2;
      }
      out.push({ cards: [...comp.cards], score });
    }
    // 甩牌：两个以上都安全的组件一起出
    if (safe.length >= 2) {
      const cards = safe.flatMap((c) => [...c.cards]);
      out.push({ cards, score: 120 + cards.length * 10 + sumPoints(cards) * 2 });
    }
  }
  return out;
}

function cardCost(c: Card, ctx: TrumpCtx): number {
  return ordinal(c, ctx) + (groupOf(c, ctx) === 'T' ? 14 : 0);
}

function dedupe(cands: Card[][]): Card[][] {
  const seen = new Set<string>();
  const out: Card[][] = [];
  for (const c of cands) {
    const key = c.map((x) => x.id).sort().join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** 给点数优先、其次尽量小的补牌策略 */
function pointsChooser(ctx: TrumpCtx): FollowChooser {
  const low = lowestChooser(ctx);
  return {
    ...low,
    fill: (cards, n) => [...cards].sort((a, b) => cardPoints(b) - cardPoints(a) || ordinal(a, ctx) - ordinal(b, ctx)).slice(0, n),
  };
}

/** 没有该花色时，用主牌凑出首出的形状来毙 */
function ruffCandidates(s: GameState, seat: Seat): Card[][] {
  const trick = s.trick;
  const lead = trick?.lead;
  if (!lead || lead.group === 'T') return [];
  const hand = s.hands[seat] ?? [];
  const ctx = ctxOf(s);
  if (hand.some((c) => groupOf(c, ctx) === lead.group)) return [];
  const trumps = hand.filter((c) => groupOf(c, ctx) === 'T');
  const d = decompose(trumps, ctx);
  if (!d) return [];
  const out: Card[][] = [];
  if (lead.components.length === 1) {
    const shape = lead.components[0] as Component;
    for (const comp of d.components) {
      if (comp.mult === shape.mult && comp.length === shape.length) out.push([...comp.cards]);
      // 拆三条当对子
      if (shape.kind === 'pair' && comp.kind === 'triple') out.push(comp.cards.slice(0, 2));
    }
  }
  return out;
}

/** 目前赢家的牌后面的人还压得住吗？只在主牌首出时可判断，副牌首出后面可能有人毙。 */
function winnerSecure(s: GameState, seat: Seat, plays: TrickPlay[], winnerIdx: number, unseen: Map<string, number>): boolean {
  const lead = s.trick?.lead;
  if (!lead || lead.group !== 'T') return false;
  const ctx = ctxOf(s);
  const d = decompose((plays[winnerIdx] as TrickPlay).cards, ctx);
  if (!d || d.group !== 'T') return false;
  const top = d.components[0];
  if (!top) return false;
  void seat;
  return !beatable(top, 'T', unseen, ctx);
}

function evaluateFollow(s: GameState, seat: Seat, sides: Sides, cards: Card[], f: SmartFeatures, unseen: Map<string, number> | null): number {
  const trick = s.trick as NonNullable<GameState['trick']>;
  const ctx = ctxOf(s);
  const plays: TrickPlay[] = [...trick.plays, { seat, cards }];
  const winnerIdx = trickWinner(plays, trick.lead!, ctx);
  const winner = (plays[winnerIdx] as TrickPlay).seat;
  let pts = 0;
  for (const p of plays) pts += sumPoints(p.cards);
  const remaining = s.config.players - plays.length;
  const weWin = sides.mates.has(winner);
  let score = 0;
  if (f.follow) {
    const hand = s.hands[seat] ?? [];
    const isLastTrick = hand.length === cards.length;
    const secure = remaining === 0 || (unseen !== null && winnerSecure(s, seat, plays, winnerIdx, unseen));
    if (weWin) {
      // 不稳的赢墩上送分要打折，自己赢比队友赢略保守
      const factor = secure ? 1 : winner === seat ? 0.55 : 0.7;
      score += pts * factor + (secure ? 4 : 2);
      if (isLastTrick) score += 45; // 末墩：闲家抠底、庄家保底
    } else {
      score -= pts + 1;
      if (isLastTrick) score -= 45;
    }
  } else if (weWin) score += pts * (remaining === 0 ? 1 : winner === seat ? 0.7 : 0.85) + 3;
  else score -= pts + 1;
  // 最后一手且这墩没分，不值得用大牌
  let cost = 0;
  for (const c of cards) cost += cardCost(c, ctx);
  score -= cost * 0.12;
  // 自己赢时用的牌越贵越亏，别人赢时送出的分牌已经算在 pts 里
  return score;
}

export function smartPlay(s: GameState, seat: Seat, rng: Rng, level: SmartLevel = 2): Action {
  const f = featuresOf(level);
  const hand = s.hands[seat] ?? [];
  const ctx = ctxOf(s);
  const trick = s.trick;
  const sides = sidesOf(s, seat);

  if (!trick || trick.plays.length === 0 || !trick.lead) {
    const unseen = unseenCounts(s, seat);
    const cands = leadCandidates(s, seat, sides, unseen, f);
    cands.sort((a, b) => b.score - a.score);
    const best = cands[0];
    if (!best) return { type: 'play', seat, cards: [hand[0]!.id] };
    return { type: 'play', seat, cards: best.cards.map((c) => c.id) };
  }

  const lead = trick.lead;
  const raw: Card[][] = [
    generateFollowWith(lead, hand, ctx, lowestChooser(ctx)),
    generateFollowWith(lead, hand, ctx, highestChooser(ctx)),
    generateFollowWith(lead, hand, ctx, pointsChooser(ctx)),
    ...ruffCandidates(s, seat),
  ];
  for (let i = 0; i < 20; i++) raw.push(generateFollow(lead, hand, ctx, rng));
  const cands = dedupe(raw).filter((c) => validateFollow(lead, hand, c, ctx) === null);
  const unseen = f.follow ? unseenCounts(s, seat) : null;
  let best = cands[0] ?? generateFollow(lead, hand, ctx, rng);
  let bestScore = -Infinity;
  for (const c of cands) {
    const sc = evaluateFollow(s, seat, sides, c, f, unseen);
    if (sc > bestScore) { bestScore = sc; best = c; }
  }
  return { type: 'play', seat, cards: best.map((c) => c.id) };
}

export function smartAction(s: GameState, seat: Seat, rng: Rng, level: SmartLevel = 2): Action | null {
  switch (s.phase) {
    case 'bottom': return seat === s.dealer ? smartExchangeBottom(s, seat, rng) : null;
    case 'callFriend': return seat === s.dealer ? smartCallFriend(s, seat, rng, level) : null;
    case 'playing': return currentTurn(s) === seat ? smartPlay(s, seat, rng, level) : null;
    default: return null;
  }
}
