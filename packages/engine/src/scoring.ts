/** 结算阶梯：一级为 L，下庄线为 2L。 */
import type { GameConfig } from './config.ts';

export interface RoundOutcome {
  /** 庄家阵营是否守住 */
  readonly dealerHeld: boolean;
  /** 获胜阵营升几级 */
  readonly levelsUp: number;
}

export function scoreRound(opponentPoints: number, cfg: GameConfig): RoundOutcome {
  const L = cfg.levelStep;
  const steps = Math.floor(Math.max(0, opponentPoints) / L);
  if (opponentPoints < 2 * L) return { dealerHeld: true, levelsUp: 2 - steps };
  return { dealerHeld: false, levelsUp: steps - 2 };
}
