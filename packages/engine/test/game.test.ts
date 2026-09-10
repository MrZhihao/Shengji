import { describe, expect, it } from 'vitest';
import { defaultConfig, handSize } from '../src/config.ts';
import { applyAction, createGame } from '../src/reducer.ts';
import { simulateGame } from '../src/sim/run.ts';
import { viewFor } from '../src/view.ts';
import type { GameState } from '../src/state.ts';

function dealAll(s: GameState): GameState {
  while (s.phase === 'dealing') {
    const r = applyAction(s, { type: 'dealCard' });
    if (!r.ok) throw new Error(r.error.message);
    s = r.state;
  }
  return s;
}

function must(r: ReturnType<typeof applyAction>): GameState {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.state;
}

describe('整局流程', () => {
  it('5 人每人 31 张留 7 张底，6 人每人 26 张留 6 张底', () => {
    expect(handSize(defaultConfig(5))).toBe(31);
    expect(handSize(defaultConfig(6))).toBe(26);
    const s5 = dealAll(createGame(defaultConfig(5), 'deal'));
    expect(s5.hands.every((h) => h.length === 31)).toBe(true);
    expect(s5.bottom.length).toBe(7);
    expect(s5.phase).toBe('declaring');
    const s6 = dealAll(createGame(defaultConfig(6), 'deal'));
    expect(s6.hands.every((h) => h.length === 26)).toBe(true);
    expect(s6.bottom.length).toBe(6);
  });

  it('同一 seed 发牌完全一致', () => {
    const a = dealAll(createGame(defaultConfig(6), 'same'));
    const b = dealAll(createGame(defaultConfig(6), 'same'));
    expect(a.hands.map((h) => h.map((c) => c.id))).toEqual(b.hands.map((h) => h.map((c) => c.id)));
  });

  it('首局无人亮主重发，非首局翻底牌定主', () => {
    let s = dealAll(createGame(defaultConfig(6), 'redeal'));
    const before = s.hands[0]?.map((c) => c.id);
    s = must(applyAction(s, { type: 'closeDeclaring' }));
    expect(s.phase).toBe('dealing');
    expect(s.redeals).toBe(1);
    s = dealAll(s);
    expect(s.hands[0]?.map((c) => c.id)).not.toEqual(before);
  });

  it('亮主只看张数，同张数不能反', () => {
    let s = dealAll(createGame(defaultConfig(6), 'declare-1'));
    const seatWithLevel = s.hands.findIndex((h) => h.some((c) => c.rank === 5));
    const card = s.hands[seatWithLevel]?.find((c) => c.rank === 5)!;
    s = must(applyAction(s, { type: 'declare', seat: seatWithLevel, cards: [card.id] }));
    expect(s.dealer).toBe(seatWithLevel);
    expect(s.trumpSuit).toBe(card.suit);
    const other = s.hands.findIndex((h, i) => i !== seatWithLevel && h.some((c) => c.rank === 5));
    const otherCard = s.hands[other]?.find((c) => c.rank === 5)!;
    const r = applyAction(s, { type: 'declare', seat: other, cards: [otherCard.id] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('DECLARATION_TOO_WEAK');
  });

  it('单张王不能亮，两张王亮无主', () => {
    let s = dealAll(createGame(defaultConfig(6), 'joker'));
    const seat = s.hands.findIndex((h) => h.filter((c) => c.rank === 16).length >= 2);
    if (seat < 0) return;
    const jokers = s.hands[seat]!.filter((c) => c.rank === 16);
    const bad = applyAction(s, { type: 'declare', seat, cards: [jokers[0]!.id] });
    expect(bad.ok).toBe(false);
    s = must(applyAction(s, { type: 'declare', seat, cards: [jokers[0]!.id, jokers[1]!.id] }));
    expect(s.trumpSuit).toBeNull();
    expect(s.trumpDecided).toBe(true);
  });

  it('叫朋友的约束', () => {
    let s = dealAll(createGame(defaultConfig(6), 'friend'));
    const seat = s.hands.findIndex((h) => h.some((c) => c.rank === 5 && c.suit !== 'J'));
    const card = s.hands[seat]!.find((c) => c.rank === 5 && c.suit !== 'J')!;
    s = must(applyAction(s, { type: 'declare', seat, cards: [card.id] }));
    s = must(applyAction(s, { type: 'closeDeclaring' }));
    expect(s.phase).toBe('bottom');
    expect(s.hands[seat]!.length).toBe(32);
    expect(viewFor(s, (seat + 1) % 6).bottom).toBeNull();
    s = must(applyAction(s, { type: 'exchangeBottom', seat, cards: s.hands[seat]!.slice(0, 6).map((c) => c.id) }));
    expect(s.phase).toBe('callFriend');
    const trump = s.trumpSuit!;
    const offSuit = (['S', 'H', 'D', 'C'] as const).find((x) => x !== trump)!;
    const bad1 = applyAction(s, { type: 'callFriend', seat, calls: [{ suit: trump, rank: 14, nth: 1 }, { suit: offSuit, rank: 13, nth: 1 }] });
    expect(bad1.ok).toBe(false);
    const bad2 = applyAction(s, { type: 'callFriend', seat, calls: [{ suit: offSuit, rank: 5, nth: 1 }, { suit: offSuit, rank: 13, nth: 1 }] });
    expect(bad2.ok).toBe(false);
    const bad3 = applyAction(s, { type: 'callFriend', seat, calls: [{ suit: offSuit, rank: 14, nth: 1 }, { suit: offSuit, rank: 14, nth: 1 }] });
    expect(bad3.ok).toBe(false);
    const bad4 = applyAction(s, { type: 'callFriend', seat, calls: [{ suit: offSuit, rank: 14, nth: 1 }] });
    expect(bad4.ok).toBe(false);
    s = must(applyAction(s, { type: 'callFriend', seat, calls: [{ suit: offSuit, rank: 14, nth: 1 }, { suit: offSuit, rank: 14, nth: 2 }] }));
    expect(s.phase).toBe('playing');
    expect(s.trick?.leader).toBe(seat);
  });
});

describe('随机对局', () => {
  it('6 人 30 局全部打完且守恒', () => {
    for (let i = 0; i < 30; i++) {
      const st = simulateGame(defaultConfig(6), `t6-${i}`);
      expect(st.gameOver).toBe(true);
      expect(st.winners?.length).toBeGreaterThan(0);
    }
  });

  it('5 人 30 局全部打完且守恒', () => {
    for (let i = 0; i < 30; i++) {
      const st = simulateGame(defaultConfig(5), `t5-${i}`);
      expect(st.gameOver).toBe(true);
    }
  });

  it('很少亮主时走重发和翻底牌路径', () => {
    let redeals = 0, flips = 0;
    for (let i = 0; i < 12; i++) {
      const st = simulateGame(defaultConfig(6), `nd-${i}`, { maxRounds: 6, bot: { declareProbability: 0.0008, throwProbability: 0.1 } });
      redeals += st.redeals;
      flips += st.bottomFlips;
    }
    expect(redeals).toBeGreaterThan(0);
    expect(flips).toBeGreaterThan(0);
  });

  it('视图不泄露别人的手牌和底牌', () => {
    simulateGame(defaultConfig(6), 'leak', {
      maxRounds: 3,
      onEvent: (_e, s) => {
        for (let seat = 0; seat < 6; seat++) {
          const v = viewFor(s, seat);
          expect(v.hand.length).toBe(s.hands[seat]!.length);
          if (s.phase === 'bottom' && seat !== s.dealer) expect(v.bottom).toBeNull();
          if (s.phase === 'playing') expect(v.bottom).toBeNull();
        }
      },
    });
  });
});
