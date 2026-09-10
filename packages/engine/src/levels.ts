/** 等级顺序不是自然点数序：5 → 10 → K → 2 → 3 → 4 → 6 → 7 → 8 → 9 → J → Q → A。 */

export const LEVEL_SEQUENCE: readonly number[] = [5, 10, 13, 2, 3, 4, 6, 7, 8, 9, 11, 12, 14];
export const MAX_LEVEL_INDEX = LEVEL_SEQUENCE.length - 1;

/** 等级用序列下标表示，0 是 5，12 是 A。 */
export type LevelIndex = number;

export function levelRank(idx: LevelIndex): number {
  const r = LEVEL_SEQUENCE[idx];
  if (r === undefined) throw new Error(`invalid level index ${idx}`);
  return r;
}

export function advanceLevel(idx: LevelIndex, steps: number): LevelIndex {
  return Math.min(MAX_LEVEL_INDEX, idx + Math.max(0, steps));
}

export function isTopLevel(idx: LevelIndex): boolean {
  return idx >= MAX_LEVEL_INDEX;
}
