/** 一局游戏的规则配置。存在地方差异的规则全部放在这里。 */

export type PlayerCount = 5 | 6;

export interface GameConfig {
  readonly players: PlayerCount;
  readonly decks: number;
  /** 底牌张数 */
  readonly bottomSize: number;
  /** 叫朋友的个数 */
  readonly friendCount: number;
  /** 计分一级的分数，下庄线为两级 */
  readonly levelStep: number;
  /** 甩牌失败每张罚分 */
  readonly throwPenaltyPerCard: number;
  /** 抠底倍数：按最后一墩首出的最高牌型 */
  readonly bottomMultiplier: {
    readonly single: number;
    readonly pair: number;
    readonly triple: number;
    readonly tractor: number;
  };
  /** 同张数是否可以反主。默认 false：只看张数，同张数先亮者有效 */
  readonly allowEqualCountOverride: boolean;
  /** 庄家自己打出的朋友牌是否计入序号 */
  readonly dealerCountsForFriend: boolean;
  /** 首局无人亮主时重发 */
  readonly redealIfNoDeclarerFirstRound: boolean;
}

export const TOTAL_POINTS_PER_DECK = 100;

export function defaultConfig(players: PlayerCount): GameConfig {
  const five = players === 5;
  return {
    players,
    decks: 3,
    bottomSize: five ? 7 : 6,
    friendCount: five ? 1 : 2,
    levelStep: five ? 60 : 50,
    throwPenaltyPerCard: 10,
    bottomMultiplier: { single: 2, pair: 4, triple: 8, tractor: 8 },
    allowEqualCountOverride: false,
    dealerCountsForFriend: true,
    redealIfNoDeclarerFirstRound: true,
  };
}

export function handSize(cfg: GameConfig): number {
  const total = cfg.decks * 54;
  const perHand = (total - cfg.bottomSize) / cfg.players;
  if (!Number.isInteger(perHand)) {
    throw new Error(`牌数不能整除：${total} 张减 ${cfg.bottomSize} 张底牌无法平分给 ${cfg.players} 人`);
  }
  return perHand;
}
