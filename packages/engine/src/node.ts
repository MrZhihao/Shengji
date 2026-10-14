/**
 * 只在 Node 里用的入口：从 packages/engine/models 读取手牌推断模型并装入引擎。
 * 网页端不引用这个文件，引擎主入口保持零依赖、不读文件。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBeliefModel, setBeliefModel, type BeliefModelMeta } from './belief.ts';

export const MODELS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'models');

/** 环境变量 BELIEF_PLAYERS（如「4」或「4,5,6」）指定装哪些人数的模型 */
function envPlayers(): number[] | null {
  const v = process.env.BELIEF_PLAYERS;
  if (!v) return null;
  return v.split(',').map((x) => Number(x.trim())).filter((x) => x === 4 || x === 5 || x === 6);
}

/** 装入能找到的各人数模型，返回装上的人数列表。环境变量 BELIEF=0 时一个都不装 */
export function loadBeliefModels(dir: string = MODELS_DIR, which: readonly number[] = envPlayers() ?? [4, 5, 6]): number[] {
  if (process.env.BELIEF === '0') return [];
  const loaded: number[] = [];
  for (const players of which) {
    const metaPath = join(dir, `belief-${players}.json`);
    const binPath = join(dir, `belief-${players}.bin`);
    if (!existsSync(metaPath) || !existsSync(binPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as BeliefModelMeta;
      setBeliefModel(players, parseBeliefModel(meta, new Uint8Array(readFileSync(binPath))));
      loaded.push(players);
    } catch (err) {
      console.error(`手牌推断模型 ${players} 人装入失败：${(err as Error).message}`);
    }
  }
  return loaded;
}
