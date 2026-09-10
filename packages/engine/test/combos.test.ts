import { describe, expect, it } from 'vitest';
import { decompose } from '../src/combos.ts';
import { H5, cs } from './helpers.ts';
import type { TrumpCtx } from '../src/trump.ts';

const H7: TrumpCtx = { level: 7, trumpSuit: 'H' };

function shapes(names: string, ctx = H5): string[] {
  const d = decompose(cs(names), ctx);
  if (!d) return ['mixed'];
  return d.components.map((c) => `${c.kind}${c.kind === 'tractor' ? `(${c.mult}x${c.length})` : ''}`);
}

describe('牌型分解', () => {
  it('单张、对子、三条', () => {
    expect(shapes('♠A')).toEqual(['single']);
    expect(shapes('♠A ♠A')).toEqual(['pair']);
    expect(shapes('♠A ♠A ♠A')).toEqual(['triple']);
  });

  it('连续对子是拖拉机，跳过级牌', () => {
    expect(shapes('♠A ♠A ♠K ♠K')).toEqual(['tractor(2x2)']);
    expect(shapes('♠6 ♠6 ♠4 ♠4')).toEqual(['tractor(2x2)']);
    expect(shapes('♠6 ♠6 ♠4 ♠4', H7)).toEqual(['pair', 'pair']);
  });

  it('三条与相邻对子不混合', () => {
    expect(shapes('♠A ♠A ♠A ♠K ♠K')).toEqual(['triple', 'pair']);
  });

  it('连续三条是三条拖拉机', () => {
    expect(shapes('♠A ♠A ♠A ♠K ♠K ♠K')).toEqual(['tractor(3x2)']);
  });

  it('主牌内 A、副级牌、主级牌、小王、大王连续', () => {
    expect(shapes('♥A ♥A ♠5 ♠5 ♥5 ♥5')).toEqual(['tractor(2x3)']);
    expect(shapes('SJ SJ BJ BJ')).toEqual(['tractor(2x2)']);
    expect(shapes('♥5 ♥5 SJ SJ')).toEqual(['tractor(2x2)']);
  });

  it('不同花色的副级牌对子同序位，不成拖拉机', () => {
    expect(shapes('♠5 ♠5 ♦5 ♦5')).toEqual(['pair', 'pair']);
    expect(shapes('♥A ♥A ♠5 ♠5 ♦5 ♦5')).toEqual(['tractor(2x2)', 'pair']);
  });

  it('混组返回 null', () => {
    expect(shapes('♠A ♥A')).toEqual(['mixed']);
    expect(shapes('♠A ♠5')).toEqual(['mixed']);
  });

  it('甩牌按强弱降序排列', () => {
    expect(shapes('♠3 ♠A ♠A ♠K ♠K ♠9 ♠9 ♠9')).toEqual(['tractor(2x2)', 'triple', 'single']);
  });
});
