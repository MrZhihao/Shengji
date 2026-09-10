/** 一墩牌的胜负判定与抠底倍数。 */
import type { Card } from './cards.ts';
import { bestTopForShape, poolOf, shapesOf, type Decomposition, type Shape } from './combos.ts';
import type { GameConfig } from './config.ts';
import { commonGroup, type TrumpCtx } from './trump.ts';

export interface TrickPlay {
  readonly seat: number;
  readonly cards: readonly Card[];
}

/**
 * plays[0] 是首出，lead 是其生效的分解。返回赢家在 plays 中的下标。
 * 跟牌要赢必须：同组或全主牌；能拆成与首出完全相同的形状集合；对应最高形状的牌更大。
 */
export function trickWinner(plays: readonly TrickPlay[], lead: Decomposition, ctx: TrumpCtx): number {
  const shapes = shapesOf(lead);
  const highest = shapes.reduce((h, s) => (compareShapeForWinner(s, h) > 0 ? s : h));
  const leadTop = bestTopForShape(poolOf(plays[0]?.cards ?? [], ctx), shapes, highest);
  let best = 0;
  let bestTop = leadTop ?? -1;
  let bestIsTrump = lead.group === 'T';
  for (let i = 1; i < plays.length; i++) {
    const cards = (plays[i] as TrickPlay).cards;
    const g = commonGroup(cards, ctx);
    if (g === null) continue;
    if (g !== lead.group && g !== 'T') continue;
    const top = bestTopForShape(poolOf(cards, ctx), shapes, highest);
    if (top === null) continue;
    const isTrump = g === 'T';
    if (isTrump && !bestIsTrump) {
      best = i; bestTop = top; bestIsTrump = true;
    } else if (isTrump === bestIsTrump && top > bestTop) {
      best = i; bestTop = top;
    }
  }
  return best;
}

function compareShapeForWinner(a: Shape, b: Shape): number {
  const ka = a.length >= 2 ? 3 : a.mult === 3 ? 2 : a.mult === 2 ? 1 : 0;
  const kb = b.length >= 2 ? 3 : b.mult === 3 ? 2 : b.mult === 2 ? 1 : 0;
  if (ka !== kb) return ka - kb;
  if (a.mult !== b.mult) return a.mult - b.mult;
  return a.length - b.length;
}

/** 抠底倍数按最后一墩首出的最高牌型。 */
export function bottomMultiplier(lead: Decomposition, cfg: GameConfig): number {
  const kinds = lead.components.map((c) => c.kind);
  if (kinds.includes('tractor')) return cfg.bottomMultiplier.tractor;
  if (kinds.includes('triple')) return cfg.bottomMultiplier.triple;
  if (kinds.includes('pair')) return cfg.bottomMultiplier.pair;
  return cfg.bottomMultiplier.single;
}
