/** 并行搜索：worker 线程能加载 TS 引擎，结果是合法出法。 */
import { afterAll, expect, it } from 'vitest';
import { applyAction, createGame, createRng, currentTurn, defaultConfig, smartAction, smartDeclare } from '@shengji/engine';
import { SearchPool } from '../src/searchPool.ts';

const pool = new SearchPool(2);
afterAll(() => pool.close());

it('线程池并行采样并返回合法出法', async () => {
  const rng = createRng('pool-test');
  let s = createGame(defaultConfig(6), 'pool-test');
  const step = (a: Parameters<typeof applyAction>[1]) => { const r = applyAction(s, a); if (!r.ok) throw new Error(r.error.message); s = r.state; };
  while (s.phase === 'dealing') { for (let i = 0; i < 6; i++) { const d = smartDeclare(s, i, rng); if (d) step(d); } step({ type: 'dealCard' }); }
  step({ type: 'closeDeclaring' });
  // 扣底用并行搜索
  expect(pool.size).toBe(2);
  const dealer = s.dealer!;
  const b = await pool.searchDealer(s, dealer, rng, { timeBudgetMs: 300, minSamples: 2, maxSamples: 8, maxCandidates: 6 });
  expect(b.action.type).toBe('exchangeBottom');
  expect(b.workers).toBe(2);
  step(b.action);
  const c = await pool.searchDealer(s, dealer, rng, { timeBudgetMs: 300, minSamples: 2, maxSamples: 8, maxCandidates: 6 });
  expect(c.action.type).toBe('callFriend');
  step(c.action);
  for (let k = 0; k < 7; k++) { const t = currentTurn(s)!; step(smartAction(s, t, rng)!); }
  const seat = currentTurn(s)!;
  const r = await pool.searchPlay(s, seat, rng, { timeBudgetMs: 400, minSamples: 4, maxSamples: 40, maxCandidates: 8 });
  expect(r.samples).toBeGreaterThanOrEqual(4);
  expect(applyAction(s, r.action).ok).toBe(true);
}, 60_000);
