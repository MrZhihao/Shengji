import { describe, expect, it } from 'vitest';
import { groupOf, ordinal, sortCards, suitDisplayOrder } from '../src/trump.ts';
import { H5, NT5, c, cs } from './helpers.ts';

describe('主牌与序位', () => {
  it('有主花色时的分组', () => {
    expect(groupOf(c('♠5'), H5)).toBe('T');
    expect(groupOf(c('♥3'), H5)).toBe('T');
    expect(groupOf(c('SJ'), H5)).toBe('T');
    expect(groupOf(c('♠A'), H5)).toBe('S');
  });

  it('主牌组序位：主花色 0..11，副级牌 12，主级牌 13，小王 14，大王 15', () => {
    expect(ordinal(c('♥2'), H5)).toBe(0);
    expect(ordinal(c('♥4'), H5)).toBe(2);
    expect(ordinal(c('♥6'), H5)).toBe(3);
    expect(ordinal(c('♥A'), H5)).toBe(11);
    expect(ordinal(c('♠5'), H5)).toBe(12);
    expect(ordinal(c('♣5'), H5)).toBe(12);
    expect(ordinal(c('♥5'), H5)).toBe(13);
    expect(ordinal(c('SJ'), H5)).toBe(14);
    expect(ordinal(c('BJ'), H5)).toBe(15);
  });

  it('副牌组序位跳过级牌', () => {
    expect(ordinal(c('♠4'), H5)).toBe(2);
    expect(ordinal(c('♠6'), H5)).toBe(3);
    expect(ordinal(c('♠A'), H5)).toBe(11);
  });

  it('无主：级牌四色相等，只有级牌和王是主', () => {
    expect(groupOf(c('♥A'), NT5)).toBe('H');
    expect(ordinal(c('♠5'), NT5)).toBe(0);
    expect(ordinal(c('♥5'), NT5)).toBe(0);
    expect(ordinal(c('SJ'), NT5)).toBe(1);
    expect(ordinal(c('BJ'), NT5)).toBe(2);
  });

  it('手牌排序：副牌红黑交错在前，主牌在后，组内升序', () => {
    // 主 ♥：剩 ♠ ♣ 两黑一红 ♦ → 黑红黑：♠ ♦ ♣
    const sorted = sortCards(cs('BJ ♥3 ♠A ♠2 ♣5 ♦9 ♣7'), H5).map((x) => `${x.suit}${x.rank}`);
    expect(sorted).toEqual(['S2', 'S14', 'D9', 'C7', 'H3', 'C5', 'J16']);
  });

  it('副牌花色顺序红黑交错', () => {
    expect(suitDisplayOrder('H')).toEqual(['S', 'D', 'C']);
    expect(suitDisplayOrder('S')).toEqual(['H', 'C', 'D']);
    expect(suitDisplayOrder('D')).toEqual(['S', 'H', 'C']);
    expect(suitDisplayOrder('C')).toEqual(['H', 'S', 'D']);
    expect(suitDisplayOrder(null)).toEqual(['S', 'H', 'C', 'D']);
  });
});
