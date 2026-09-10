/**
 * 残局精确求解：牌很少时，在一份确定化的全桌手牌上做双方阵营的极小极大搜索，
 * 代替启发式推演。带节点预算，超出就放弃让调用方退回推演。
 */
import type { Card } from './cards.ts';
import { decompose } from './combos.ts';
import { validateFollow } from './follow.ts';
import { applyAction, ctxOf, currentTurn, dealerTeam } from './reducer.ts';
import type { GameState, RoundResult, Seat } from './state.ts';
import { groupOf, type Group } from './trump.ts';

/** 每人剩这么多张以内才用精确求解 */
export const EXACT_MAX_CARDS = 3;

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
  return combinations(hand, n).filter((cards) => validateFollow(trick.lead!, hand, cards, ctx) === null);
}

interface Solver {
  nodes: number;
  readonly budget: number;
  readonly me: Seat;
  readonly mates: Set<Seat>;
  readonly levelStep: number;
}

function solve(s: GameState, sv: Solver, alpha: number, beta: number): number | null {
  if (s.phase !== 'playing') {
    return s.lastRound ? terminalUtility(s.lastRound, sv.me, sv.levelStep) : null;
  }
  if (++sv.nodes > sv.budget) return null;
  const turn = currentTurn(s);
  if (turn === null) return null;
  const maximizing = sv.mates.has(turn);
  let best = maximizing ? -Infinity : Infinity;
  for (const cards of legalMoves(s, turn)) {
    const r = applyAction(s, { type: 'play', seat: turn, cards: cards.map((c) => c.id) });
    if (!r.ok) continue;
    const v = solve(r.state, sv, alpha, beta);
    if (v === null) return null;
    if (maximizing) { if (v > best) best = v; if (best > alpha) alpha = best; }
    else { if (v < best) best = v; if (best < beta) beta = best; }
    if (alpha >= beta) break;
  }
  return Number.isFinite(best) ? best : null;
}

/**
 * 对「seat 已出 cards 之后」的确定化局面做精确求解。
 * 返回 seat 角度的收益；超出节点预算返回 null。
 */
export function exactValueAfterPlay(s: GameState, seat: Seat, cards: readonly Card[], nodeBudget = 40_000): number | null {
  if ((s.hands[seat]?.length ?? 0) > EXACT_MAX_CARDS) return null;
  const first = applyAction(s, { type: 'play', seat, cards: cards.map((c) => c.id) });
  if (!first.ok) return null;
  const mates = sidesInDeterminized(s);
  const mine = mates.has(seat) ? mates : new Set<Seat>(Array.from({ length: s.config.players }, (_, i) => i).filter((i) => !mates.has(i)));
  const sv: Solver = { nodes: 0, budget: nodeBudget, me: seat, mates: mine, levelStep: s.config.levelStep };
  return solve(first.state, sv, -Infinity, Infinity);
}
