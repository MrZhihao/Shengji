import { describe, expect, it } from 'vitest';
import { validateLead } from '../src/lead.ts';
import { H5, more, resetDecks } from './helpers.ts';

function lead(play: string, others: string[]) {
  resetDecks();
  const p = more(play);
  const o = others.map((h) => more(h));
  return validateLead(p, o, H5, 10);
}

describe('首出与甩牌', () => {
  it('单一牌型直接合法', () => {
    const r = lead('♠A ♠A', ['♠K ♠K']);
    expect('code' in r).toBe(false);
  });

  it('混组不能首出', () => {
    const r = lead('♠A ♥A', []);
    expect('code' in r && r.code).toBe('MIXED_GROUPS');
  });

  it('甩牌成功：没人压得住任何组件', () => {
    const r = lead('♠A ♠A ♠K', ['♠Q ♠Q ♠J', '♥A ♥A']);
    if ('code' in r) throw new Error(r.message);
    expect(r.forced).toBeNull();
    expect(r.penalty).toBe(0);
    expect(r.effective.components.length).toBe(2);
  });

  it('甩牌失败：强制出最小的可被压组件并罚分', () => {
    const r = lead('♠K ♠K ♠Q', ['♠A ♠A ♠3']);
    if ('code' in r) throw new Error(r.message);
    expect(r.forced?.kind).toBe('single');
    expect(r.forced?.cards.map((c) => c.rank)).toEqual([12]);
    expect(r.penalty).toBe(30);
  });

  it('只有单张 A 压不住对子，但压得住单张', () => {
    const r = lead('♠K ♠K ♠Q', ['♠A ♠3', '♠J ♠J']);
    if ('code' in r) throw new Error(r.message);
    expect(r.forced?.kind).toBe('single');
  });

  it('别人有更大的对子时对子也会被压', () => {
    const r = lead('♠K ♠K ♠2', ['♠A ♠A', '♠3']);
    if ('code' in r) throw new Error(r.message);
    expect(r.forced?.kind).toBe('single');
    expect(r.forced?.cards[0]?.rank).toBe(2);
  });

  it('主牌不算压副牌甩牌', () => {
    const r = lead('♠K ♠K ♠Q', ['♥A ♥A ♥K', 'BJ BJ']);
    if ('code' in r) throw new Error(r.message);
    expect(r.forced).toBeNull();
  });
});
