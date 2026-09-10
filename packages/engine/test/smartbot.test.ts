import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.ts';
import { simulateGame } from '../src/sim/run.ts';

describe('策略机器人', () => {
  it('全部策略机器人 5 人、6 人各 20 局都能打完', () => {
    for (const players of [5, 6] as const) {
      const all = Array.from({ length: players }, (_, i) => i);
      for (let i = 0; i < 20; i++) {
        const st = simulateGame(defaultConfig(players), `smart-${players}-${i}`, { smartSeats: all });
        expect(st.gameOver).toBe(true);
      }
    }
  }, 60_000);

  it('策略机器人明显强于随机机器人', () => {
    const players = 6;
    const smart = [0, 2, 4];
    let smartWins = 0, randomWins = 0, rounds = 0;
    for (let i = 0; i < 30; i++) {
      const st = simulateGame(defaultConfig(players), `vs-${i}`, { smartSeats: smart });
      rounds += st.rounds;
      st.roundWins.forEach((w, seat) => { if (smart.includes(seat)) smartWins += w; else randomWins += w; });
    }
    const smartRate = smartWins / (rounds * smart.length);
    const randomRate = randomWins / (rounds * (players - smart.length));
    expect(smartRate).toBeGreaterThan(randomRate + 0.1);
  }, 60_000);
});
