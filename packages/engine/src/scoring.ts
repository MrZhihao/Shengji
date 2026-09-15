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
  const P = Math.max(0, opponentPoints);
  // 闲家一分没得（大光）：庄家阵营升 3
  if (P === 0) return { dealerHeld: true, levelsUp: 3 };
  const steps = Math.floor(P / L);
  if (P < 2 * L) return { dealerHeld: true, levelsUp: 2 - steps };
  return { dealerHeld: false, levelsUp: steps - 2 };
}
