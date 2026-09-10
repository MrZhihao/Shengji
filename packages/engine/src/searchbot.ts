/**
 * 搜索机器人（第三版）：确定化蒙特卡洛。
 * 别人的手牌不知道，但知道约束：谁在哪个花色断门、每张牌还剩几张、亮出的牌在谁手里、庄家知道底牌。
 * 按约束随机补全全桌手牌，对每个候选出法用策略机器人把这局推演完，取平均收益最好的。
 * 同一份采样用于全部候选（共同随机数），降低方差。带时间预算。
 */
import { makeDeck, type Card } from './cards.ts';
import { applyAction, ctxOf, currentTurn } from './reducer.ts';
import { createRng, type Rng } from './rng.ts';
import { candidatePlays, knownVoids, smartAction, type PlayCandidate } from './smartbot.ts';
import type { Action, GameState, Seat } from './state.ts';
import { groupOf, type Group } from './trump.ts';

// 引擎不依赖 DOM 或 Node 类型，这里只声明用到的两个全局
declare const setTimeout: (fn: () => void, ms: number) => unknown;
const now = (): number => Date.now();

export interface SearchOptions {
  /** 时间预算，毫秒；到点就停，至少跑 minSamples 次采样 */
  readonly timeBudgetMs: number;
  readonly minSamples: number;
  readonly maxSamples: number;
  /** 最多评估多少个候选（按规则打分取前几） */
  readonly maxCandidates: number;
}

export const defaultSearchOptions: SearchOptions = { timeBudgetMs: 600, minSamples: 4, maxSamples: 48, maxCandidates: 10 };

export interface SearchResult {
  readonly action: Action;
  readonly samples: number;
  readonly candidates: number;
  readonly elapsedMs: number;
  /** 每个候选的平均收益，与 candidates 顺序一致 */
  readonly means: readonly number[];
}

// ---------- 采样：按约束补全别人的手牌 ----------

interface Determinization {
  hands: Card[][];
  bottom: Card[];
}

/** 已经公开在某人手里的牌：亮主时亮出的、尚未打出的牌 */
function revealedInHands(s: GameState): Map<Seat, Card[]> {
  const out = new Map<Seat, Card[]>();
  const d = s.declaration;
  if (!d) return out;
  const stillHeld = d.cards.filter((c) => (s.hands[d.seat] ?? []).some((h) => h.id === c.id));
  if (stillHeld.length) out.set(d.seat, stillHeld);
  return out;
}

/**
 * 生成一份与我方视角一致的全桌手牌。失败（约束冲突）时最多重试若干次，再退回忽略断门约束。
 */
export function sampleDeterminization(s: GameState, seat: Seat, rng: Rng): Determinization {
  const n = s.config.players;
  const ctx = ctxOf(s);
  const myHand = s.hands[seat] ?? [];
  const known = new Set<string>(myHand.map((c) => c.id));
  for (const t of s.tricks) for (const p of t.plays) for (const c of p.cards) known.add(c.id);
  if (s.trick) for (const p of s.trick.plays) for (const c of p.cards) known.add(c.id);
  const bottomKnown = seat === s.dealer;
  if (bottomKnown) for (const c of s.bottom) known.add(c.id);
  const revealed = revealedInHands(s);
  for (const [who, cards] of revealed) if (who !== seat) for (const c of cards) known.add(c.id);

  const pool = makeDeck(s.config.decks).filter((c) => !known.has(c.id));
  const voids = knownVoids(s);
  const capacity: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === seat) { capacity.push(0); continue; }
    capacity.push((s.hands[i]?.length ?? 0) - (revealed.get(i)?.length ?? 0));
  }
  const bottomCap = bottomKnown ? 0 : s.bottom.length;

  const attempt = (respectVoids: boolean): Determinization | null => {
    const cap = [...capacity];
    let bcap = bottomCap;
    const hands: Card[][] = Array.from({ length: n }, (_, i) => (i === seat ? [...myHand] : [...(revealed.get(i) ?? [])]));
    const bottom: Card[] = bottomKnown ? [...s.bottom] : [];
    // 先放约束最紧的牌：断门的组越多越先分
    const shuffled = rng.shuffle(pool);
    const constrained = respectVoids
      ? shuffled.map((c) => ({ c, g: groupOf(c, ctx) })).sort((a, b) => voidCount(voids, b.g, n, seat) - voidCount(voids, a.g, n, seat))
      : shuffled.map((c) => ({ c, g: groupOf(c, ctx) }));
    for (const { c, g } of constrained) {
      const eligible: number[] = [];
      let total = 0;
      for (let i = 0; i < n; i++) {
        if (cap[i]! <= 0) continue;
        if (respectVoids && voids.get(i)?.has(g)) continue;
        eligible.push(i);
        total += cap[i]!;
      }
      if (bcap > 0) { eligible.push(-1); total += bcap; }
      if (eligible.length === 0) return null;
      // 按剩余容量加权随机
      let r = rng.next() * total;
      let chosen = eligible[eligible.length - 1] as number;
      for (const i of eligible) {
        const w = i === -1 ? bcap : cap[i]!;
        if (r < w) { chosen = i; break; }
        r -= w;
      }
      if (chosen === -1) { bottom.push(c); bcap--; }
      else { hands[chosen]!.push(c); cap[chosen]!--; }
    }
    return { hands, bottom };
  };

  for (let i = 0; i < 12; i++) {
    const d = attempt(true);
    if (d) return d;
  }
  return attempt(false) as Determinization;
}

function voidCount(voids: Map<Seat, Set<Group>>, g: Group, n: number, me: Seat): number {
  let k = 0;
  for (let i = 0; i < n; i++) if (i !== me && voids.get(i)?.has(g)) k++;
  return k;
}

// ---------- 推演 ----------

/** 从 seat 出 cards 开始，用策略机器人把这局打完，返回从 seat 角度看的收益（单位：一级） */
function rollout(base: GameState, seat: Seat, cards: Card[], det: Determinization, rng: Rng): number | null {
  let s: GameState = { ...base, hands: det.hands, bottom: det.bottom };
  const first = applyAction(s, { type: 'play', seat, cards: cards.map((c) => c.id) });
  if (!first.ok) return null;
  s = first.state;
  let guard = 0;
  while (s.phase === 'playing') {
    if (++guard > 400) return null;
    const turn = currentTurn(s);
    if (turn === null) return null;
    const a = smartAction(s, turn, rng, 2);
    if (!a) return null;
    const r = applyAction(s, a);
    if (!r.ok) return null;
    s = r.state;
  }
  const res = s.lastRound;
  if (!res) return null;
  const L = s.config.levelStep;
  const onDealerSide = res.dealerTeam.includes(seat);
  const side = onDealerSide ? -1 : 1;
  // 闲家分相对下庄线的位置，加上升级数的方向
  const swing = (res.opponentPoints - 2 * L) / L;
  const levels = res.dealerHeld ? -res.levelsUp : res.levelsUp;
  return side * swing + side * levels * 0.5;
}

// ---------- 搜索 ----------

interface SearchState {
  readonly cands: PlayCandidate[];
  readonly sums: number[];
  readonly counts: number[];
  samples: number;
  readonly t0: number;
}

function beginSearch(s: GameState, seat: Seat, rng: Rng, opts: SearchOptions): SearchState {
  const all = candidatePlays(s, seat, rng, 2);
  const cands = all.slice(0, Math.max(1, opts.maxCandidates));
  return { cands, sums: new Array<number>(cands.length).fill(0), counts: new Array<number>(cands.length).fill(0), samples: 0, t0: now() };
}

/** 跑一次采样：同一采样、同一推演随机序列，所有候选公平比较 */
function searchStep(s: GameState, seat: Seat, rng: Rng, st: SearchState): void {
  const det = sampleDeterminization(s, seat, rng);
  const seed = `${rng.next()}`;
  for (let i = 0; i < st.cands.length; i++) {
    const u = rollout(s, seat, (st.cands[i] as PlayCandidate).cards, det, createRng(seed));
    if (u === null) continue;
    st.sums[i]! += u;
    st.counts[i]! += 1;
  }
  st.samples++;
}

function shouldContinue(st: SearchState, opts: SearchOptions): boolean {
  if (st.samples >= opts.maxSamples) return false;
  if (st.samples < opts.minSamples) return true;
  return now() - st.t0 <= opts.timeBudgetMs;
}

function finishSearch(seat: Seat, st: SearchState): SearchResult {
  const { cands, sums, counts } = st;
  const means = cands.map((_, i) => (counts[i]! > 0 ? sums[i]! / counts[i]! : -Infinity));
  let best = 0;
  for (let i = 1; i < cands.length; i++) {
    const a = means[i]!, b = means[best]!;
    if (a > b + 1e-9 || (Math.abs(a - b) <= 1e-9 && (cands[i] as PlayCandidate).heuristic > (cands[best] as PlayCandidate).heuristic)) best = i;
  }
  const chosen = (means[best] === -Infinity ? cands[0] : cands[best]) as PlayCandidate;
  return {
    action: { type: 'play', seat, cards: chosen.cards.map((c) => c.id) },
    samples: st.samples,
    candidates: cands.length,
    elapsedMs: now() - st.t0,
    means,
  };
}

function trivial(s: GameState, seat: Seat, st: SearchState): boolean {
  return st.cands.length === 1 || (s.hands[seat]?.length ?? 0) <= 1;
}

/** 同步搜索：模拟器用 */
export function searchPlay(s: GameState, seat: Seat, rng: Rng, opts: SearchOptions = defaultSearchOptions): SearchResult {
  const st = beginSearch(s, seat, rng, opts);
  if (!trivial(s, seat, st)) while (shouldContinue(st, opts)) searchStep(s, seat, rng, st);
  return finishSearch(seat, st);
}

/** 异步搜索：每次采样之间让出事件循环，服务端用，不会卡住收发消息 */
export async function searchPlayAsync(s: GameState, seat: Seat, rng: Rng, opts: SearchOptions = defaultSearchOptions): Promise<SearchResult> {
  const st = beginSearch(s, seat, rng, opts);
  if (!trivial(s, seat, st)) {
    while (shouldContinue(st, opts)) {
      searchStep(s, seat, rng, st);
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
  return finishSearch(seat, st);
}

/** 第三版机器人：出牌用搜索，其余沿用第二版 */
export function searchAction(s: GameState, seat: Seat, rng: Rng, opts: SearchOptions = defaultSearchOptions): Action | null {
  if (s.phase === 'playing') return currentTurn(s) === seat ? searchPlay(s, seat, rng, opts).action : null;
  return smartAction(s, seat, rng, 2);
}
