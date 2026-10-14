/**
 * 评估手牌推断：在新的对局上，比较三种补全方式对「每个对手每组牌有几张」的估计误差。
 *   原来的随机补全（含四人手写先验）；网络概率直接求期望；网络引导的随机补全（搜索实际用的）。
 * 用法：tsx beliefEval.ts --players 4 --positions 1500 --samples 24
 */
import { defaultConfig, type PlayerCount } from '../config.ts';
import { ctxOf, currentTurn } from '../reducer.ts';
import { createRng } from '../rng.ts';
import type { GameState } from '../state.ts';
import { groupOf, type Group } from '../trump.ts';
import { IDENTITIES, beliefProbs, canonIndex, hasBeliefModel, hiddenInfo, suitSlots } from '../belief.ts';
import { sampleDeterminization, searchTuning } from '../searchbot.ts';
import { loadBeliefModels } from '../node.ts';
import { simulateGame } from './run.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}
const players = Number(arg('players', '4')) as PlayerCount;
const positions = Number(arg('positions', '1500'));
const N = Number(arg('samples', '24'));
loadBeliefModels();
if (!hasBeliefModel(players)) { console.error(`没有 ${players} 人的模型`); process.exit(1); }

const GROUPS: Group[] = ['T', 'S', 'H', 'D', 'C'];
const err = { old: 0, netDirect: 0, netSampled: 0, oldBottom: 0, netBottom: 0 };
const ms = { old: 0, net: 0 };
let count = 0;
const pickRng = createRng('eval-pick');
const seen = new WeakSet<GameState>();

function evaluate(s: GameState, me: number): void {
  const P = s.config.players;
  const ctx = ctxOf(s);
  const info = hiddenInfo(s, me);
  const poolIds = new Set(info.pool.map((c) => c.id));
  // 真实：每个位置每组有几张没见过的牌
  const actual = (cards: readonly { id: string; suit: string; rank: number }[]) => {
    const v = [0, 0, 0, 0, 0];
    for (const c of cards) if (poolIds.has(c.id)) v[GROUPS.indexOf(groupOf(c as never, ctx))]!++;
    return v;
  };
  const truth = Array.from({ length: P }, (_, i) => (i === me ? null : actual(s.hands[i] ?? [])));
  const truthBottom = info.bottomKnown ? null : actual(s.bottom);
  const sampled = (belief: number) => {
    searchTuning.belief = belief;
    const est = Array.from({ length: P }, () => [0, 0, 0, 0, 0]);
    const estB = [0, 0, 0, 0, 0];
    const rng = createRng(`eval/${count}/${belief}`);
    const t0 = performance.now();
    for (let k = 0; k < N; k++) {
      const d = sampleDeterminization(s, me, rng);
      d.hands.forEach((h, i) => { const v = actual(h); for (let g = 0; g < 5; g++) est[i]![g]! += v[g]! / N; });
      const vb = actual(d.bottom);
      for (let g = 0; g < 5; g++) estB[g]! += vb[g]! / N;
    }
    return { est, estB, ms: (performance.now() - t0) / N };
  };
  const diff = (est: number[][], estB: number[]) => {
    let e = 0, eb = 0;
    for (let i = 0; i < P; i++) if (truth[i]) for (let g = 0; g < 5; g++) e += Math.abs(est[i]![g]! - truth[i]![g]!);
    if (truthBottom) for (let g = 0; g < 5; g++) eb += Math.abs(estB[g]! - truthBottom[g]!);
    return { e, eb };
  };
  const o = sampled(0);
  const n = sampled(1);
  // 网络概率直接求期望
  const p = beliefProbs(s, me, info) as Float32Array;
  const slots = suitSlots(s.trumpSuit);
  const estD = Array.from({ length: P }, () => [0, 0, 0, 0, 0]);
  const estDB = [0, 0, 0, 0, 0];
  for (const c of info.pool) {
    const ci = canonIndex(c, slots);
    const g = GROUPS.indexOf(groupOf(c, ctx));
    for (let r = 1; r < P; r++) estD[(me + r) % P]![g]! += p[ci * P + r - 1] as number;
    estDB[g]! += p[ci * P + P - 1] as number;
  }
  const a = diff(o.est, o.estB), b = diff(estD, estDB), c = diff(n.est, n.estB);
  err.old += a.e; err.netDirect += b.e; err.netSampled += c.e; err.oldBottom += a.eb; err.netBottom += c.eb;
  ms.old += o.ms; ms.net += n.ms;
  void IDENTITIES;
}

for (let g = 0; count < positions; g++) {
  simulateGame(defaultConfig(players), `eval-${players}-${g}`, {
    smartSeats: Array.from({ length: players }, (_, i) => i),
    maxRounds: 6,
    onEvent: (_e, s) => {
      if (count >= positions || s.phase !== 'playing' || seen.has(s)) return;
      seen.add(s);
      const me = currentTurn(s);
      if (me === null || pickRng.next() > 0.08) return;
      evaluate(s, me);
      count++;
    },
  });
}
searchTuning.belief = 1;
const f = (x: number) => (x / count).toFixed(3);
console.log(`${players} 人 · ${count} 个局面 · 每个局面 ${N} 次采样`);
console.log(`对手各组张数误差合计：原来的补全 ${f(err.old)}，网络直接期望 ${f(err.netDirect)}，网络引导补全 ${f(err.netSampled)}（降低 ${(100 * (1 - err.netSampled / err.old)).toFixed(1)}%）`);
console.log(`底牌各组张数误差合计：原来 ${f(err.oldBottom)}，网络引导 ${f(err.netBottom)}`);
console.log(`每次补全耗时：原来 ${(ms.old / count).toFixed(3)} 毫秒，网络引导 ${(ms.net / count).toFixed(3)} 毫秒（网络推理每个局面只算一次，已含在首次采样里）`);
