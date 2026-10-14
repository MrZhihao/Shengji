import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.ts';
import { simulateGame } from '../src/sim/run.ts';
import { currentTurn } from '../src/reducer.ts';
import { createRng } from '../src/rng.ts';
import type { GameState } from '../src/state.ts';
import {
  IDENTITIES, beliefFeatures, beliefMask, beliefProbs, beliefTargets, canonIndex, featureSize, hiddenInfo,
  parseBeliefModel, setBeliefModel, suitSlots,
} from '../src/belief.ts';
import { sampleDeterminization } from '../src/searchbot.ts';
import { SUITS, RANKS } from '../src/cards.ts';

/** 收集若干出牌阶段的局面 */
function positions(players: 4 | 5 | 6, n: number): { s: GameState; me: number }[] {
  const out: { s: GameState; me: number }[] = [];
  const rng = createRng(`belief-pos-${players}`);
  simulateGame(defaultConfig(players), `belief-${players}`, {
    smartSeats: Array.from({ length: players }, (_, i) => i),
    maxRounds: 2,
    onEvent: (_e, s) => {
      if (out.length >= n || s.phase !== 'playing') return;
      const me = currentTurn(s);
      if (me !== null && rng.next() < 0.1) out.push({ s, me });
    },
  });
  return out;
}

/** 随机权重的小模型，用来测试推理和采样接入 */
function randomModel(players: number) {
  const F = featureSize(players);
  const H = 16;
  const O = IDENTITIES * players;
  const rng = createRng('rand-model');
  const n = F * H + H + H * O + O;
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = (rng.next() - 0.5) * 0.2;
  return parseBeliefModel({ version: 1, players, inputSize: F, scale: new Array(F).fill(3), layers: [{ inSize: F, outSize: H }, { inSize: H, outSize: O }] }, new Uint8Array(w.buffer));
}

describe('手牌推断网络', () => {
  it('规范化身份是 54 张身份的一一映射，主花色排在第 0 槽', () => {
    for (const trump of [null, ...SUITS]) {
      const slots = suitSlots(trump);
      const seen = new Set<number>();
      for (const suit of SUITS) for (const rank of RANKS) seen.add(canonIndex({ suit, rank }, slots));
      seen.add(canonIndex({ suit: 'J', rank: 15 }, slots));
      seen.add(canonIndex({ suit: 'J', rank: 16 }, slots));
      expect(seen.size).toBe(54);
      if (trump) expect(canonIndex({ suit: trump, rank: 2 }, slots)).toBe(0);
    }
  });

  for (const players of [4, 5, 6] as const) {
    it(`${players} 人：特征长度固定，目标覆盖全部没见过的牌，且都落在掩码允许的位置`, () => {
      for (const { s, me } of positions(players, 12)) {
        const info = hiddenInfo(s, me);
        expect(beliefFeatures(s, me, info).length).toBe(featureSize(players));
        const t = beliefTargets(s, me, info);
        const m = beliefMask(s, me, info);
        let total = 0, outside = 0;
        for (let k = 0; k < t.length; k++) { total += t[k]!; if (t[k]! > 0 && !m[k]) outside += t[k]!; }
        expect(total).toBe(info.pool.length);
        // 五六人里庄家断门是推断出来的，偶尔会错；四人的断门全是实打实看到的
        if (players === 4) expect(outside).toBe(0);
      }
    });
  }

  it('装入模型后：概率在每个身份上归一，补全仍满足手牌张数和断门约束', () => {
    setBeliefModel(4, randomModel(4));
    try {
      for (const { s, me } of positions(4, 6)) {
        const p = beliefProbs(s, me)!;
        expect(p).not.toBeNull();
        for (let c = 0; c < IDENTITIES; c++) {
          let z = 0;
          for (let l = 0; l < 4; l++) z += p[c * 4 + l]!;
          expect(z === 0 || Math.abs(z - 1) < 1e-4).toBe(true);
        }
        const d = sampleDeterminization(s, me, createRng('det'));
        expect(d.hands.map((h) => h.length)).toEqual(s.hands.map((h) => h.length));
        expect(d.bottom.length).toBe(s.bottom.length);
        const ids = new Set<string>();
        for (const h of d.hands) for (const c of h) ids.add(c.id);
        for (const c of d.bottom) ids.add(c.id);
        expect(ids.size).toBe(d.hands.reduce((a, h) => a + h.length, 0) + d.bottom.length);
      }
    } finally {
      setBeliefModel(4, null);
    }
  });
});

describe('完美信息价值网络', () => {
  it('特征长度固定；装入模型后庄家方与闲家方的估值互为相反数，搜索照常给出合法出法', async () => {
    const { valueFeatureSize, valueFeatures, parseValueModel, setValueModel, predictUtility } = await import('../src/valuenet.ts');
    const { searchPlay, searchTuning } = await import('../src/searchbot.ts');
    const { applyAction, dealerTeam } = await import('../src/reducer.ts');
    const F = valueFeatureSize(4);
    const H = 8;
    const rng = createRng('rand-value');
    const n = F * H + H + H + 1;
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = (rng.next() - 0.5) * 0.2;
    setValueModel(4, parseValueModel({ version: 1, players: 4, inputSize: F, scale: new Array(F).fill(3), layers: [{ inSize: F, outSize: H }, { inSize: H, outSize: 1 }] }, new Uint8Array(w.buffer)));
    try {
      const pos = positions(4, 8);
      for (const { s, me } of pos) {
        expect(valueFeatures(s).length).toBe(F);
        const team = dealerTeam(s);
        const mate = team[0]!;
        const foe = [0, 1, 2, 3].find((i) => !team.includes(i))!;
        expect(predictUtility(s, mate)!).toBeCloseTo(-predictUtility(s, foe)!, 6);
        searchTuning.value = 1;
        const r = searchPlay(s, me, createRng('vs'), { timeBudgetMs: 0, minSamples: 2, maxSamples: 2, maxCandidates: 4 });
        expect(applyAction(s, r.action).ok).toBe(true);
      }
    } finally {
      setValueModel(4, null);
    }
  }, 60_000);
});
