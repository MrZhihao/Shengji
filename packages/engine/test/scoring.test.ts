import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.ts';
import { LEVEL_SEQUENCE, advanceLevel, levelRank } from '../src/levels.ts';
import { scoreRound } from '../src/scoring.ts';

describe('结算阶梯', () => {
  it('5 人 60 分一级，120 下庄', () => {
    const cfg = defaultConfig(5);
    expect(scoreRound(0, cfg)).toEqual({ dealerHeld: true, levelsUp: 2 });
    expect(scoreRound(59, cfg)).toEqual({ dealerHeld: true, levelsUp: 2 });
    expect(scoreRound(60, cfg)).toEqual({ dealerHeld: true, levelsUp: 1 });
    expect(scoreRound(119, cfg)).toEqual({ dealerHeld: true, levelsUp: 1 });
    expect(scoreRound(120, cfg)).toEqual({ dealerHeld: false, levelsUp: 0 });
    expect(scoreRound(179, cfg)).toEqual({ dealerHeld: false, levelsUp: 0 });
    expect(scoreRound(180, cfg)).toEqual({ dealerHeld: false, levelsUp: 1 });
    expect(scoreRound(240, cfg)).toEqual({ dealerHeld: false, levelsUp: 2 });
    expect(scoreRound(300, cfg)).toEqual({ dealerHeld: false, levelsUp: 3 });
  });

  it('6 人 50 分一级，100 下庄', () => {
    const cfg = defaultConfig(6);
    expect(scoreRound(49, cfg)).toEqual({ dealerHeld: true, levelsUp: 2 });
    expect(scoreRound(50, cfg)).toEqual({ dealerHeld: true, levelsUp: 1 });
    expect(scoreRound(100, cfg)).toEqual({ dealerHeld: false, levelsUp: 0 });
    expect(scoreRound(150, cfg)).toEqual({ dealerHeld: false, levelsUp: 1 });
    expect(scoreRound(300, cfg)).toEqual({ dealerHeld: false, levelsUp: 4 });
  });

  it('等级顺序 5 10 K 2 3 4 6 7 8 9 J Q A', () => {
    expect(LEVEL_SEQUENCE).toEqual([5, 10, 13, 2, 3, 4, 6, 7, 8, 9, 11, 12, 14]);
    expect(levelRank(0)).toBe(5);
    expect(levelRank(advanceLevel(0, 2))).toBe(13);
    expect(levelRank(advanceLevel(11, 5))).toBe(14);
  });
});
