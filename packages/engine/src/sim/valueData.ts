/**
 * 价值网络的训练数据：二版机器人自对弈（带少量随机），在每墩开始时记录完全公开的局面特征，
 * 这一局结束后用真实结局给它们打标签（闲家方收益，单位与 terminalUtility 一致）。
 * 用法：tsx valueData.ts --players 4 --rounds 20000 --noise 0.1 --seed v0 --out ml/data/v4-v0
 * 输出：<out>.x（特征 uint8）、<out>.t（标签 float32）、<out>.json
 */
import { closeSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { defaultConfig, type PlayerCount } from '../config.ts';
import { terminalUtility } from '../endgame.ts';
import type { GameState } from '../state.ts';
import { VALUE_VERSION, valueFeatureSize, valueFeatures } from '../valuenet.ts';
import { simulateGame } from './run.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const players = Number(arg('players', '4')) as PlayerCount;
const roundsWanted = Number(arg('rounds', '2000'));
const noise = Number(arg('noise', '0.1'));
const seed = arg('seed', 'value');
const out = arg('out', `ml/data/v${players}-${seed}`);

const cfg = defaultConfig(players);
const fx = openSync(`${out}.x`, 'w');
const ft = openSync(`${out}.t`, 'w');
let samples = 0;
let rounds = 0;
let pending: Uint8Array[] = [];
const seen = new WeakSet<GameState>();
const t0 = Date.now();
for (let g = 0; rounds < roundsWanted; g++) {
  const st = simulateGame(cfg, `${seed}-${g}`, {
    smartSeats: Array.from({ length: players }, (_, i) => i),
    noise,
    maxRounds: Math.min(40, roundsWanted - rounds),
    onEvent: (e, s) => {
      if (e.type === 'roundScored') {
        const opp = e.result.opponents[0];
        if (opp !== undefined && pending.length) {
          const u = terminalUtility(e.result, opp, s.config.levelStep);
          const labels = new Float32Array(pending.length).fill(u);
          for (const x of pending) writeSync(fx, x);
          writeSync(ft, new Uint8Array(labels.buffer));
          samples += pending.length;
        }
        pending = [];
        return;
      }
      if (s.phase !== 'playing' || !s.trick || s.trick.plays.length > 0 || seen.has(s)) return;
      seen.add(s);
      pending.push(valueFeatures(s));
    },
  });
  rounds += st.rounds;
}
closeSync(fx);
closeSync(ft);
writeFileSync(`${out}.json`, JSON.stringify({ version: VALUE_VERSION, players, features: valueFeatureSize(players), samples, rounds, noise, seed }));
console.log(`${players} 人：${rounds} 轮，${samples} 个样本，用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒 → ${out}`);
