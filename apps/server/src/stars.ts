/** 机器人用电影明星的名字：十位男演员、十位女演员。头像由前端按名字到维基百科取缩略图。 */
export const STAR_NAMES: readonly string[] = [
  // 男演员
  '周润发', '梁朝伟', '刘德华', '张国荣', '周星驰', '成龙', '李连杰', '葛优', '黄渤', '吴京',
  // 女演员
  '张曼玉', '巩俐', '章子怡', '林青霞', '杨紫琼', '周迅', '舒淇', '刘嘉玲', '汤唯', '赵薇',
];

/** 从还没用过的名字里挑一个；都用完了就退回「机器人 N」 */
export function pickStarName(used: ReadonlySet<string>, random: () => number, fallback: string): string {
  const free = STAR_NAMES.filter((n) => !used.has(n));
  if (free.length === 0) return fallback;
  return free[Math.floor(random() * free.length)] as string;
}
