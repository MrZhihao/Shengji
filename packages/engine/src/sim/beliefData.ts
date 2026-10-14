/**
 * 手牌推断网络的训练数据：用二版机器人（带少量随机）自对弈，在出牌决策点按概率抽样，
 * 从出牌人的视角记录特征、真实位置计数、掩码、各位置容量。
 * 用法：tsx beliefData.ts --players 4 --rounds 20000 --sample 0.25 --noise 0.15 --seed a --out ml/data/p4-a
 * 输出：<out>.x（特征 uint8）、<out>.y（目标计数 uint8）、<out>.m（掩码 uint8）、<out>.c（容量 uint8）、<out>.json
 */
import { closeSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { defaultConfig, type PlayerCount } from '../config.ts';
import { currentTurn } from '../reducer.ts';
import { createRng } from '../rng.ts';
import type { GameState } from '../state.ts';
import { BELIEF_VERSION, IDENTITIES, beliefFeatures, beliefMask, beliefTargets, featureSize, hiddenInfo } from '../belief.ts';
import { simulateGame } from './run.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const players = Number(arg('players', '4')) as PlayerCount;
const roundsWanted = Number(arg('rounds', '2000'));
const sampleRate = Number(arg('sample', '0.25'));
const noise = Number(arg('noise', '0.15'));
const seed = arg('seed', 'belief');
const out = arg('out', `ml/data/p${players}-${seed}`);

const cfg = defaultConfig(players);
const F = featureSize(players);
const fx = openSync(`${out}.x`, 'w');
const fy = openSync(`${out}.y`, 'w');
const fm = openSync(`${out}.m`, 'w');
const fc = openSync(`${out}.c`, 'w');
const rng = createRng(`pick/${seed}`);
let samples = 0;
let rounds = 0;
const seen = new WeakSet<GameState>();
const t0 = Date.now();
for (let g = 0; rounds < roundsWanted; g++) {
  const st = simulateGame(cfg, `${seed}-${g}`, {
    smartSeats: Array.from({ length: players }, (_, i) => i),
    noise,
    maxRounds: Math.min(40, roundsWanted - rounds),
    onEvent: (_e, s) => {
      if (s.phase !== 'playing' || seen.has(s)) return;
      seen.add(s);
      const turn = currentTurn(s);
      if (turn === null || rng.next() >= sampleRate) return;
      const info = hiddenInfo(s, turn);
      if (info.pool.length === 0) return;
      writeSync(fx, beliefFeatures(s, turn, info));
      writeSync(fy, beliefTargets(s, turn, info));
      writeSync(fm, beliefMask(s, turn, info));
      const cap = new Uint8Array(players);
      for (let r = 1; r < players; r++) cap[r - 1] = info.capacity[(turn + r) % players] ?? 0;
      cap[players - 1] = info.bottomCap;
      writeSync(fc, cap);
      samples++;
    },
  });
  rounds += st.rounds;
}
for (const f of [fx, fy, fm, fc]) closeSync(f);
writeFileSync(`${out}.json`, JSON.stringify({ version: BELIEF_VERSION, players, features: F, outputs: IDENTITIES * players, samples, rounds, sampleRate, noise, seed }));
console.log(`${players} 人：${rounds} 轮，${samples} 个样本，用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒 → ${out}`);
