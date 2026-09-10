/** 首出规则：单一牌型直接合法；甩牌需每个组件都压得住其他人手中同组的对应牌型。 */
import type { Card } from './cards.ts';
import {
  compareComponent, decompose, findTractors, identitiesWithAtLeast, poolOf,
  type Component, type Decomposition, type Identity,
} from './combos.ts';
import { ruleError, type RuleError } from './errors.ts';
import { groupOf, type TrumpCtx } from './trump.ts';

export interface LeadOutcome {
  /** 实际生效的首出 */
  readonly effective: Decomposition;
  /** 甩牌失败时被迫打出的组件 */
  readonly forced: Component | null;
  /** 甩牌失败罚分 */
  readonly penalty: number;
  readonly attempted: Decomposition;
}

/** 其他某个玩家手中同组的牌能否压过该组件。 */
export function canBeat(comp: Component, otherGroupCards: readonly Card[], ctx: TrumpCtx): boolean {
  const pool = poolOf(otherGroupCards, ctx);
  if (comp.kind === 'tractor') {
    return findTractors(pool, comp.mult, comp.length).some((keys) =>
      Math.max(...keys.map((k) => (pool.get(k) as Identity).ord)) > comp.top,
    );
  }
  return identitiesWithAtLeast(pool, comp.mult).some((id) => id.ord > comp.top);
}

export function validateLead(
  play: readonly Card[],
  otherHands: readonly (readonly Card[])[],
  ctx: TrumpCtx,
  penaltyPerCard: number,
): LeadOutcome | RuleError {
  const d = decompose(play, ctx);
  if (!d) return ruleError('MIXED_GROUPS', '首出的牌必须是同一花色，或者全部是主牌');
  if (d.components.length === 1) return { effective: d, forced: null, penalty: 0, attempted: d };

  const beatable = d.components.filter((comp) =>
    otherHands.some((h) => canBeat(comp, h.filter((c) => groupOf(c, ctx) === d.group), ctx)),
  );
  if (beatable.length === 0) return { effective: d, forced: null, penalty: 0, attempted: d };

  const forced = beatable.reduce((min, c) => (compareComponent(c, min) < 0 ? c : min));
  return {
    effective: { group: d.group, components: [forced] },
    forced,
    penalty: penaltyPerCard * play.length,
    attempted: d,
  };
}
