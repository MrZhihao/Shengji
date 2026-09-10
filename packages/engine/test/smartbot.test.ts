import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.ts';
import { simulateGame } from '../src/sim/run.ts';
import { searchPlay } from '../src/searchbot.ts';
import { applyAction, createGame, currentTurn } from '../src/reducer.ts';
import { createRng } from '../src/rng.ts';
import { smartAction, smartDeclare } from '../src/smartbot.ts';

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

describe('搜索机器人', () => {
  it('搜索给出的出法合法，且能与二版机器人打完两局', () => {
    const st = simulateGame(defaultConfig(6), 'search-legal', {
      maxRounds: 2,
      strongSeats: [0, 3],
      smartSeats: [1, 2, 4, 5],
      search: { timeBudgetMs: 0, minSamples: 1, maxSamples: 1, maxCandidates: 4 },
    });
    expect(st.rounds).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('搜索结果包含采样统计', () => {
    const rng = createRng('search-unit');
    let s = createGame(defaultConfig(5), 'search-unit');
    const step = (a: Parameters<typeof applyAction>[1]) => { const r = applyAction(s, a); if (!r.ok) throw new Error(r.error.message); s = r.state; };
    while (s.phase === 'dealing') { for (let i = 0; i < 5; i++) { const d = smartDeclare(s, i, rng); if (d) step(d); } step({ type: 'dealCard' }); }
    step({ type: 'closeDeclaring' });
    while (s.phase !== 'playing') { const a = smartAction(s, s.dealer!, rng); if (a) step(a); }
    const seat = currentTurn(s)!;
    const r = searchPlay(s, seat, rng, { timeBudgetMs: 0, minSamples: 2, maxSamples: 2, maxCandidates: 3 });
    expect(r.samples).toBe(2);
    expect(r.candidates).toBeGreaterThan(0);
    expect(r.means.length).toBe(r.candidates);
    const applied = applyAction(s, r.action);
    expect(applied.ok).toBe(true);
  }, 60_000);
});

describe('残局精确求解', () => {
  it('残局所有合法出法都能算出确定值', async () => {
    const { legalMoves, exactValueAfterPlay } = await import('../src/endgame.ts');
    const rng = createRng('endgame-unit');
    let s = createGame(defaultConfig(5), 'endgame-unit');
    const step = (a: Parameters<typeof applyAction>[1]) => { const r = applyAction(s, a); if (!r.ok) throw new Error(r.error.message); s = r.state; };
    while (s.phase === 'dealing') { for (let i = 0; i < 5; i++) { const d = smartDeclare(s, i, rng); if (d) step(d); } step({ type: 'dealCard' }); }
    step({ type: 'closeDeclaring' });
    while (s.phase !== 'playing') { const a = smartAction(s, s.dealer!, rng); if (a) step(a); }
    while (!(s.hands.every((h) => h.length <= 3) && (s.trick?.plays.length ?? 0) === 0)) { const t = currentTurn(s)!; step(smartAction(s, t, rng)!); }
    const seat = currentTurn(s)!;
    const moves = legalMoves(s, seat);
    expect(moves.length).toBeGreaterThan(0);
    for (const m of moves) {
      const v = exactValueAfterPlay(s, seat, m, 500_000);
      expect(v).not.toBeNull();
      expect(Number.isFinite(v)).toBe(true);
    }
    const r = searchPlay(s, seat, rng, { timeBudgetMs: 0, minSamples: 2, maxSamples: 2, maxCandidates: 6 });
    expect(applyAction(s, r.action).ok).toBe(true);
  }, 120_000);

  it('扣底与叫朋友的候选集合有效', async () => {
    const { rankedBottomSets, rankedFriendCallSets } = await import('../src/smartbot.ts');
    const rng = createRng('dealer-cands');
    let s = createGame(defaultConfig(6), 'dealer-cands');
    const step = (a: Parameters<typeof applyAction>[1]) => { const r = applyAction(s, a); if (!r.ok) throw new Error(r.error.message); s = r.state; };
    while (s.phase === 'dealing') { for (let i = 0; i < 6; i++) { const d = smartDeclare(s, i, rng); if (d) step(d); } step({ type: 'dealCard' }); }
    step({ type: 'closeDeclaring' });
    const dealer = s.dealer!;
    const bottoms = rankedBottomSets(s, dealer);
    expect(bottoms.length).toBeGreaterThan(1);
    for (const b of bottoms) {
      expect(b.length).toBe(s.config.bottomSize);
      expect(new Set(b.map((c) => c.id)).size).toBe(b.length);
      expect(applyAction(s, { type: 'exchangeBottom', seat: dealer, cards: b.map((c) => c.id) }).ok).toBe(true);
    }
    step({ type: 'exchangeBottom', seat: dealer, cards: bottoms[0]!.map((c) => c.id) });
    const calls = rankedFriendCallSets(s, dealer);
    expect(calls.length).toBeGreaterThan(0);
    for (const set of calls) expect(applyAction(s, { type: 'callFriend', seat: dealer, calls: set }).ok).toBe(true);
  }, 60_000);
});
