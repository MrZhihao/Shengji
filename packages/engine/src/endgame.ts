/**
 * 残局精确求解：牌很少时，在一份确定化的全桌手牌上做双方阵营的极小极大搜索，
 * 代替启发式推演。带节点预算，超出就放弃让调用方退回推演。
 */
import { identityKey, type Card } from './cards.ts';
import { decompose } from './combos.ts';
import { validateFollow } from './follow.ts';
import { applyAction, ctxOf, currentTurn, dealerTeam } from './reducer.ts';
import type { GameState, RoundResult, Seat } from './state.ts';
import { groupOf, type Group } from './trump.ts';
import { trickWinner } from './trick.ts';

/** 每人剩这么多张以内才用精确求解（五六人三副牌的默认值） */
export const EXACT_MAX_CARDS = 3;

/**
 * 按局面决定精确求解的门槛：四人对家模式阵营全知、分支少，从每人 5 张起算准
 * （实测 6 万节点内约八成能算完，平均 70 毫秒；6 张只有四成能算完，不划算）；
 * 五六人分支多，只算最后 3 张。
 */
export function exactMaxCards(s: GameState): number {
  const n = s.config.players;
  return n === 4 ? endgameTuning.exactMaxCards4 : n === 5 ? endgameTuning.exactMaxCards5 : endgameTuning.exactMaxCards6;
}

/** 节点预算，按人数分开 */
export function exactNodeBudget(s: GameState): number {
  const n = s.config.players;
  return n === 4 ? endgameTuning.nodeBudget4 : n === 5 ? endgameTuning.nodeBudget5 : endgameTuning.nodeBudget6;
}

/**
 * 残局求解参数，按人数分开；模拟器可用 --tune 改动做 A/B。
 * 实测（去重、走子排序、置换表之后）：四人 5 张约八成算完、平均 70 毫秒；
 * 五人 4 张 6 万节点内约 97% 算完、平均 25 毫秒；六人 4 张 4 万节点内约六成算完、平均 60 毫秒。
 */
export const endgameTuning = {
  exactMaxCards4: 5,
  nodeBudget4: 60_000,
  exactMaxCards5: 4,
  nodeBudget5: 60_000,
  exactMaxCards6: 4,
  nodeBudget6: 40_000,
};

/** 局终收益（从 seat 角度，单位：一级） */
export function terminalUtility(res: RoundResult, seat: Seat, levelStep: number): number {
  const side = res.dealerTeam.includes(seat) ? -1 : 1;
  const swing = (res.opponentPoints - 2 * levelStep) / levelStep;
  const levels = res.dealerHeld ? -res.levelsUp : res.levelsUp;
  return side * swing + side * levels * 0.5;
}

/** 在确定化局面里推断阵营：已知庄家方 + 手里还握着未现身朋友牌的人 */
export function sidesInDeterminized(s: GameState): Set<Seat> {
  const team = new Set<Seat>(dealerTeam(s));
  for (const call of s.friendCalls) {
    if (call.resolvedSeat !== null) continue;
    s.hands.forEach((h, i) => { if (h.some((c) => c.suit === call.suit && c.rank === call.rank)) team.add(i); });
  }
  return team;
}

function combinations<T>(arr: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  const rec = (start: number, acc: T[]) => {
    if (acc.length === k) { out.push([...acc]); return; }
    for (let i = start; i < arr.length; i++) { acc.push(arr[i] as T); rec(i + 1, acc); acc.pop(); }
  };
  rec(0, []);
  return out;
}

/** 该座位当前所有合法出法（残局手牌很少，可以穷举） */
export function legalMoves(s: GameState, seat: Seat): Card[][] {
  const hand = s.hands[seat] ?? [];
  const ctx = ctxOf(s);
  const trick = s.trick;
  if (!trick || trick.plays.length === 0 || !trick.lead) {
    const byGroup = new Map<Group, Card[]>();
    for (const c of hand) byGroup.set(groupOf(c, ctx), [...(byGroup.get(groupOf(c, ctx)) ?? []), c]);
    const out: Card[][] = [];
    for (const cards of byGroup.values()) {
      const d = decompose(cards, ctx);
      if (!d) continue;
      for (const comp of d.components) out.push([...comp.cards]);
      if (d.components.length > 1) out.push([...cards]); // 甩牌
    }
    return out.length ? out : [hand.slice(0, 1)];
  }
  let n = 0;
  for (const c of trick.lead.components) n += c.cards.length;
  if (hand.length <= n) return [[...hand]];
  // 两副牌里同一身份的牌常有重复，出哪一张结果一样：按身份去重，分支少一大半
  const seen = new Set<string>();
  const out: Card[][] = [];
  for (const cards of combinations(hand, n)) {
    const key = cards.map((c) => identityKey(c)).sort().join(',');
    if (seen.has(key)) continue;
    if (validateFollow(trick.lead, hand, cards, ctx) !== null) continue;
    seen.add(key);
    out.push(cards);
  }
  return out;
}

/**
 * 走子排序：让 alpha-beta 先看最可能好的出法。跟牌时先看能赢这墩的、再看垫分少的；
 * 首出先看大牌。排序只影响速度，不影响结果。
 */
function orderedMoves(s: GameState, turn: Seat): Card[][] {
  const moves = legalMoves(s, turn);
  if (moves.length <= 1) return moves;
  const ctx = ctxOf(s);
  const trick = s.trick;
  const score = (cards: Card[]): number => {
    let pts = 0;
    for (const c of cards) pts += c.rank === 5 ? 5 : c.rank === 10 || c.rank === 13 ? 10 : 0;
    if (trick && trick.plays.length > 0 && trick.lead) {
      const plays = [...trick.plays, { seat: turn, cards }];
      const w = trickWinner(plays, trick.lead, ctx);
      const wins = (plays[w] as { seat: Seat }).seat === turn;
      // 赢墩优先；不能赢就先看少送分的
      return (wins ? 100 : 0) + (wins ? pts : -pts);
    }
    const d = decompose(cards, ctx);
    return (d?.components[0]?.top ?? 0) + cards.length * 20;
  };
  return moves.map((m) => ({ m, k: score(m) })).sort((a, b) => b.k - a.k).map((x) => x.m);
}

interface Solver {
  nodes: number;
  readonly budget: number;
  readonly me: Seat;
  readonly mates: Set<Seat>;
  readonly levelStep: number;
  /** 置换表：同样的剩余手牌、同样的当前墩与得分，只算一次（只存算准的值） */
  readonly table: Map<string, number>;
}

/** 局面键：各家手牌按身份排序 + 当前墩 + 各家已得分与罚分。牌的副数不影响结果，所以用身份不用 id */
function positionKey(s: GameState): string {
  const parts: string[] = [];
  for (const h of s.hands) parts.push(h.map((c) => identityKey(c)).sort().join(' '));
  const t = s.trick;
  parts.push(t ? `${t.leader}:${t.plays.map((p) => `${p.seat}=${p.cards.map((c) => identityKey(c)).sort().join(' ')}`).join(';')}` : '-');
  parts.push(s.captured.join(','));
  parts.push(s.penalties.join(','));
  return parts.join('|');
}

function solve(s: GameState, sv: Solver, alpha: number, beta: number): number | null {
  if (s.phase !== 'playing') {
    return s.lastRound ? terminalUtility(s.lastRound, sv.me, sv.levelStep) : null;
  }
  if (++sv.nodes > sv.budget) return null;
  const turn = currentTurn(s);
  if (turn === null) return null;
  const key = positionKey(s);
  const cached = sv.table.get(key);
  if (cached !== undefined) return cached;
  const maximizing = sv.mates.has(turn);
  const alpha0 = alpha, beta0 = beta;
  let best = maximizing ? -Infinity : Infinity;
  for (const cards of orderedMoves(s, turn)) {
    const r = applyAction(s, { type: 'play', seat: turn, cards: cards.map((c) => c.id) });
    if (!r.ok) continue;
    const v = solve(r.state, sv, alpha, beta);
    if (v === null) return null;
    if (maximizing) { if (v > best) best = v; if (best > alpha) alpha = best; }
    else { if (v < best) best = v; if (best < beta) beta = best; }
    if (alpha >= beta) break;
  }
  if (!Number.isFinite(best)) return null;
  // 只有在窗口内算出的精确值才能复用；被剪枝截断的是界，不存
  if (best > alpha0 && best < beta0) sv.table.set(key, best);
  return best;
}

/**
 * 对「seat 已出 cards 之后」的确定化局面做精确求解。
 * 返回 seat 角度的收益；超出节点预算返回 null。
 */
export function exactValueAfterPlay(s: GameState, seat: Seat, cards: readonly Card[], nodeBudget = exactNodeBudget(s)): number | null {
  if ((s.hands[seat]?.length ?? 0) > exactMaxCards(s)) return null;
  const first = applyAction(s, { type: 'play', seat, cards: cards.map((c) => c.id) });
  if (!first.ok) return null;
  const mates = sidesInDeterminized(s);
  const mine = mates.has(seat) ? mates : new Set<Seat>(Array.from({ length: s.config.players }, (_, i) => i).filter((i) => !mates.has(i)));
  const sv: Solver = { nodes: 0, budget: nodeBudget, me: seat, mates: mine, levelStep: s.config.levelStep, table: new Map() };
  return solve(first.state, sv, -Infinity, Infinity);
}
