/**
 * 牌型：单张、对子、三条、拖拉机，以及它们的组合（甩牌）。
 * 所有分析都在同一「组」内进行，组由 trump.ts 决定。
 */
import { identityKey, type Card } from './cards.ts';
import { commonGroup, ordinal, type Group, type TrumpCtx } from './trump.ts';

export type ComponentKind = 'single' | 'pair' | 'triple' | 'tractor';

/** 牌型形状：mult 为每个序位的张数，length 为连续序位数（非拖拉机为 1）。 */
export interface Shape {
  readonly mult: 1 | 2 | 3;
  readonly length: number;
}

export interface Component extends Shape {
  readonly kind: ComponentKind;
  readonly cards: readonly Card[];
  /** 最高序位 */
  readonly top: number;
}

export interface Decomposition {
  readonly group: Group;
  /** 按强弱降序 */
  readonly components: readonly Component[];
}

/** 同一身份（同花色同点数）的牌及其序位。 */
export interface Identity {
  readonly key: string;
  readonly ord: number;
  cards: Card[];
}

export type Pool = Map<string, Identity>;

export function poolOf(cards: readonly Card[], ctx: TrumpCtx): Pool {
  const pool: Pool = new Map();
  for (const c of cards) {
    const key = identityKey(c);
    const id = pool.get(key);
    if (id) id.cards.push(c);
    else pool.set(key, { key, ord: ordinal(c, ctx), cards: [c] });
  }
  return pool;
}

export function clonePool(pool: Pool): Pool {
  const out: Pool = new Map();
  for (const [k, v] of pool) out.set(k, { key: v.key, ord: v.ord, cards: [...v.cards] });
  return out;
}

export function poolCards(pool: Pool): Card[] {
  const out: Card[] = [];
  for (const id of pool.values()) out.push(...id.cards);
  return out;
}

export function poolSize(pool: Pool): number {
  let n = 0;
  for (const id of pool.values()) n += id.cards.length;
  return n;
}

/** 从 pool 中取走某身份的 n 张牌，返回取走的牌。 */
export function poolTake(pool: Pool, key: string, n: number): Card[] {
  const id = pool.get(key);
  if (!id || id.cards.length < n) throw new Error(`poolTake: ${key} 不足 ${n} 张`);
  const taken = id.cards.splice(0, n);
  if (id.cards.length === 0) pool.delete(key);
  return taken;
}

export function identitiesWithAtLeast(pool: Pool, mult: number): Identity[] {
  const out: Identity[] = [];
  for (const id of pool.values()) if (id.cards.length >= mult) out.push(id);
  return out.sort((a, b) => a.ord - b.ord || (a.key < b.key ? -1 : 1));
}

function byOrdinal(ids: readonly Identity[]): Map<number, Identity[]> {
  const m = new Map<number, Identity[]>();
  for (const id of ids) {
    const arr = m.get(id.ord);
    if (arr) arr.push(id);
    else m.set(id.ord, [id]);
  }
  return m;
}

/**
 * 找出所有 mult 重、长度恰为 len 的拖拉机，返回每个拖拉机用到的身份 key 列表（按序位升序）。
 * 每个身份张数需 ≥ mult，序位严格连续，同序位的不同身份互斥。
 */
export function findTractors(pool: Pool, mult: number, len: number): string[][] {
  if (len < 2) return [];
  const m = byOrdinal(identitiesWithAtLeast(pool, mult));
  const ords = [...m.keys()].sort((a, b) => a - b);
  const out: string[][] = [];
  for (const start of ords) {
    const slots: Identity[][] = [];
    let ok = true;
    for (let i = 0; i < len; i++) {
      const s = m.get(start + i);
      if (!s) { ok = false; break; }
      slots.push(s);
    }
    if (!ok) continue;
    // 笛卡尔积：每个序位选一个身份
    let combos: string[][] = [[]];
    for (const slot of slots) {
      const next: string[][] = [];
      for (const prefix of combos) for (const id of slot) next.push([...prefix, id.key]);
      combos = next;
    }
    out.push(...combos);
  }
  return out;
}

/** 是否存在 mult 重、长度 ≥ minLen 的拖拉机。 */
export function hasTractor(pool: Pool, mult: number, minLen: number): boolean {
  const ords = [...byOrdinal(identitiesWithAtLeast(pool, mult)).keys()].sort((a, b) => a - b);
  let run = 1;
  for (let i = 1; i < ords.length; i++) {
    run = (ords[i] as number) === (ords[i - 1] as number) + 1 ? run + 1 : 1;
    if (run >= minLen) return true;
  }
  return ords.length >= 1 && minLen <= 1;
}

const KIND_RANK: Record<ComponentKind, number> = { single: 0, pair: 1, triple: 2, tractor: 3 };

export function kindOfShape(s: Shape): ComponentKind {
  if (s.length >= 2) return 'tractor';
  return s.mult === 3 ? 'triple' : s.mult === 2 ? 'pair' : 'single';
}

/** 形状强弱：拖拉机 > 三条 > 对子 > 单张；拖拉机之间先比重数再比长度。 */
export function compareShape(a: Shape, b: Shape): number {
  const ka = KIND_RANK[kindOfShape(a)], kb = KIND_RANK[kindOfShape(b)];
  if (ka !== kb) return ka - kb;
  if (a.mult !== b.mult) return a.mult - b.mult;
  return a.length - b.length;
}

/** 组件强弱：先比形状，再比最高序位。 */
export function compareComponent(a: Component, b: Component): number {
  return compareShape(a, b) || a.top - b.top;
}

export function shapeKey(s: Shape): string {
  return `${s.mult}x${s.length}`;
}

export function shapesEqual(a: readonly Shape[], b: readonly Shape[]): boolean {
  if (a.length !== b.length) return false;
  const ka = a.map(shapeKey).sort(), kb = b.map(shapeKey).sort();
  return ka.every((k, i) => k === kb[i]);
}

function makeComponent(cards: Card[], mult: 1 | 2 | 3, length: number, ctx: TrumpCtx): Component {
  let top = -1;
  for (const c of cards) top = Math.max(top, ordinal(c, ctx));
  return { kind: kindOfShape({ mult, length }), mult, length, cards, top };
}

/**
 * 把同组的一组牌拆成规范牌型：先取三条拖拉机，再取对子拖拉机，剩下的三条、对子、单张各自独立。
 * 三条不拆开凑对子拖拉机，三条与相邻对子不混合。混组返回 null。
 */
export function decompose(cards: readonly Card[], ctx: TrumpCtx): Decomposition | null {
  const group = commonGroup(cards, ctx);
  if (!group) return null;
  const pool = poolOf(cards, ctx);
  const components: Component[] = [];

  for (const mult of [3, 2] as const) {
    // 只用张数恰为 mult 的身份组链，避免拆散三条
    let changed = true;
    while (changed) {
      changed = false;
      const exact = identitiesWithAtLeast(pool, mult).filter((id) => id.cards.length === mult);
      const m = byOrdinal(exact);
      const ords = [...m.keys()].sort((a, b) => a - b);
      let i = 0;
      while (i < ords.length) {
        let j = i;
        while (j + 1 < ords.length && (ords[j + 1] as number) === (ords[j] as number) + 1) j++;
        const runLen = j - i + 1;
        if (runLen >= 2) {
          const taken: Card[] = [];
          for (let k = i; k <= j; k++) {
            const slot = m.get(ords[k] as number) as Identity[];
            taken.push(...poolTake(pool, (slot[0] as Identity).key, mult));
          }
          components.push(makeComponent(taken, mult, runLen, ctx));
          changed = true;
          break; // 重新扫描，剩余身份可能还能组链
        }
        i = j + 1;
      }
    }
  }

  for (const id of [...pool.values()]) {
    const n = id.cards.length;
    if (n === 3) components.push(makeComponent(poolTake(pool, id.key, 3), 3, 1, ctx));
    else if (n === 2) components.push(makeComponent(poolTake(pool, id.key, 2), 2, 1, ctx));
    else if (n === 1) components.push(makeComponent(poolTake(pool, id.key, 1), 1, 1, ctx));
    else throw new Error(`身份 ${id.key} 有 ${n} 张，超过三副牌上限`);
  }

  components.sort((a, b) => compareComponent(b, a));
  return { group, components };
}

export function totalCards(d: Decomposition): number {
  let n = 0;
  for (const c of d.components) n += c.cards.length;
  return n;
}

export function shapesOf(d: Decomposition): Shape[] {
  return d.components.map((c) => ({ mult: c.mult, length: c.length }));
}

/** 给定形状在 pool 中的所有候选（身份 key 列表与最高序位）。 */
export function candidatesForShape(pool: Pool, shape: Shape): { keys: string[]; top: number }[] {
  if (shape.length >= 2) {
    return findTractors(pool, shape.mult, shape.length).map((keys) => ({
      keys,
      top: Math.max(...keys.map((k) => (pool.get(k) as Identity).ord)),
    }));
  }
  return identitiesWithAtLeast(pool, shape.mult).map((id) => ({ keys: [id.key], top: id.ord }));
}

export function takeShape(pool: Pool, keys: readonly string[], mult: number): Card[] {
  const out: Card[] = [];
  for (const k of keys) out.push(...poolTake(pool, k, mult));
  return out;
}

/**
 * pool 中的牌能否恰好拆成给定形状的集合（用于判断跟牌能否「盖住」甩牌的结构）。
 */
export function canPartition(pool: Pool, shapes: readonly Shape[]): boolean {
  const sorted = [...shapes].sort((a, b) => compareShape(b, a));
  return partitionRec(pool, sorted, 0);
}

function partitionRec(pool: Pool, shapes: readonly Shape[], i: number): boolean {
  if (i >= shapes.length) return poolSize(pool) === 0;
  const shape = shapes[i] as Shape;
  if (shape.mult === 1 && shape.length === 1) {
    // 剩下全是单张，只需张数吻合
    return poolSize(pool) === shapes.length - i;
  }
  for (const cand of candidatesForShape(pool, shape)) {
    const p2 = clonePool(pool);
    takeShape(p2, cand.keys, shape.mult);
    if (partitionRec(p2, shapes, i + 1)) return true;
  }
  return false;
}

/**
 * 在 play 中找出与首出最高形状 highest 对应的组件的最高可能序位，
 * 且余下的牌能拆成首出其余形状。找不到返回 null。
 */
export function bestTopForShape(pool: Pool, shapes: readonly Shape[], highest: Shape): number | null {
  const rest = [...shapes];
  const idx = rest.findIndex((s) => s.mult === highest.mult && s.length === highest.length);
  if (idx < 0) return null;
  rest.splice(idx, 1);
  const cands = candidatesForShape(pool, highest).sort((a, b) => b.top - a.top);
  for (const cand of cands) {
    const p2 = clonePool(pool);
    takeShape(p2, cand.keys, highest.mult);
    if (canPartition(p2, rest)) return cand.top;
  }
  return null;
}
