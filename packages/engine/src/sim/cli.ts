/** 命令行模拟器：pnpm sim --players 6 --games 1000 --seed abc */
import { defaultConfig, type PlayerCount } from '../config.ts';
import { simulateGame, type SimStats } from './run.ts';
import { SMART_V2, smartTuning, type SmartFeatures } from '../smartbot.ts';
import { searchTuning } from '../searchbot.ts';
import { endgameTuning } from '../endgame.ts';
import { loadBeliefModels } from '../node.ts';

const beliefLoaded = loadBeliefModels();
if (beliefLoaded.length) console.log(`手牌推断模型：${beliefLoaded.join('、')} 人`);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

const players = Number(arg('players', '6')) as PlayerCount;
const games = Number(arg('games', '100'));
const seed = arg('seed', 'shengji');
const verbose = process.argv.includes('--verbose');
/** --smart all：全部二版策略；half：偶数座位策略、奇数随机；ab：偶数座位二版、奇数座位一版；strong：偶数座位三版搜索、奇数座位二版；feat：偶数座位二版全特性、奇数座位只开 --features 列出的特性；none：全随机 */
/** --budget 毫秒 / --samples N / --cands N：三版搜索的时间预算、最大采样数、候选数 */
const smartMode = arg('smart', 'none');
/** --features declare,call,lead,follow：二版机器人只开这些特性；默认全开 */
const featureArg = arg('features', 'all');
const smartFeatures: SmartFeatures = featureArg === 'all' ? SMART_V2 : {
  declare: featureArg.includes('declare'),
  call: featureArg.includes('call'),
  lead: featureArg.includes('lead'),
  follow: featureArg.includes('follow'),
  partner: featureArg.includes('partner'),
};

if (players !== 4 && players !== 5 && players !== 6) {
  console.error('--players 只能是 4、5 或 6');
  process.exit(1);
}

const config = defaultConfig(players);
/** --tune declareSingle=9,declarePair=7 */
for (const kv of arg('tune', '').split(',').filter(Boolean)) {
  const [k, v] = kv.split('=');
  if (!k || !v) continue;
  if (k in smartTuning) (smartTuning as Record<string, number>)[k] = Number(v);
  else if (k in searchTuning) (searchTuning as Record<string, number>)[k] = Number(v);
  else if (k in endgameTuning) (endgameTuning as Record<string, number>)[k] = Number(v);
  else { console.error(`未知调参项 ${k}`); process.exit(1); }
}
if (arg('tune', '')) console.log(`调参：${JSON.stringify({ ...smartTuning, ...searchTuning, ...endgameTuning })}`);
const allSeats = Array.from({ length: players }, (_, i) => i);
const smartSeats = smartMode === 'all' ? allSeats
  : smartMode === 'half' || smartMode === 'ab' || smartMode === 'feat' ? allSeats.filter((i) => i % 2 === 0)
  : [];
const basicSeats = smartMode === 'ab' ? allSeats.filter((i) => i % 2 === 1) : [];
/** feat 模式：奇数座位用 --features 指定的特性子集 */
const subsetSeats = smartMode === 'feat' ? allSeats.filter((i) => i % 2 === 1) : [];
const strongSeats = smartMode === 'strong' ? allSeats.filter((i) => i % 2 === 0) : smartMode === 'beliefab' ? allSeats : [];
/** beliefab：全部座位都是搜索版，偶数座位开手牌推断网络、奇数座位关 */
const beliefSeats = smartMode === 'beliefab' ? allSeats.filter((i) => i % 2 === 0) : undefined;
const search = {
  timeBudgetMs: Number(arg('budget', '600')),
  minSamples: 2,
  maxSamples: Number(arg('samples', '48')),
  maxCandidates: Number(arg('cands', '10')),
};
if (smartMode === 'strong') {
  // strong 模式下奇数座位用二版
  smartSeats.length = 0;
  smartSeats.push(...allSeats.filter((i) => i % 2 === 1));
}
const agg: SimStats = {
  rounds: 0, redeals: 0, bottomFlips: 0, dealerHeld: 0, throwsAttempted: 0, throwsFailed: 0,
  friendSlots: 0, friendsRevealed: 0, dealerSelfFriend: 0, levelsUpHistogram: {}, opponentPointsSum: 0,
  gameOver: false, winners: null, actions: 0, finalLevels: [], roundWins: Array.from({ length: players }, () => 0),
  levelGain: Array.from({ length: players }, () => 0), dealerRounds: Array.from({ length: players }, () => 0), dealerHolds: Array.from({ length: players }, () => 0),
};
let finished = 0;
const levelSum = Array.from({ length: players }, () => 0);
const gameWins = Array.from({ length: players }, () => 0);
let minRounds = Infinity, maxRounds = 0;
const t0 = performance.now();
for (let g = 0; g < games; g++) {
  const gameSeed = `${seed}-${g}`;
  let st: SimStats;
  try {
    st = simulateGame(config, gameSeed, verbose ? {
      smartSeats,
      basicSeats,
      strongSeats,
      search,
      smartFeatures,
      onEvent: (e) => {
        if (e.type === 'roundScored') {
          const r = e.result;
          console.log(`  第 ${r.round} 局 庄家 ${r.dealer} 阵营 [${r.dealerTeam.join(',')}] 闲家得 ${r.opponentPoints} → ${r.dealerHeld ? '守住' : '下庄'} 升 ${r.levelsUp}，等级 ${r.levelsAfter.join('/')}`);
        }
      },
    } : { smartSeats, basicSeats, strongSeats, beliefSeats, subsetSeats, subsetFeatures: smartFeatures, search, smartFeatures: smartMode === 'feat' ? SMART_V2 : smartFeatures });
  } catch (err) {
    console.error(`游戏 ${gameSeed} 出错：${(err as Error).message}`);
    process.exit(1);
  }
  if (st.gameOver) finished++;
  minRounds = Math.min(minRounds, st.rounds);
  maxRounds = Math.max(maxRounds, st.rounds);
  for (const k of ['rounds', 'redeals', 'bottomFlips', 'dealerHeld', 'throwsAttempted', 'throwsFailed', 'friendSlots', 'friendsRevealed', 'dealerSelfFriend', 'opponentPointsSum', 'actions'] as const) {
    agg[k] += st[k];
  }
  for (const [k, v] of Object.entries(st.levelsUpHistogram)) agg.levelsUpHistogram[k] = (agg.levelsUpHistogram[k] ?? 0) + v;
  st.finalLevels.forEach((l, i) => { levelSum[i] = (levelSum[i] ?? 0) + l; });
  st.roundWins.forEach((w, i) => { agg.roundWins[i] = (agg.roundWins[i] ?? 0) + w; });
  st.levelGain.forEach((w, i) => { agg.levelGain[i] = (agg.levelGain[i] ?? 0) + w; });
  st.dealerRounds.forEach((w, i) => { agg.dealerRounds[i] = (agg.dealerRounds[i] ?? 0) + w; });
  st.dealerHolds.forEach((w, i) => { agg.dealerHolds[i] = (agg.dealerHolds[i] ?? 0) + w; });
  for (const w of st.winners ?? []) gameWins[w] = (gameWins[w] ?? 0) + 1;
}
const ms = performance.now() - t0;

console.log(`\n${players} 人 · ${games} 局游戏 · seed=${seed} · 用时 ${(ms / 1000).toFixed(1)}s`);
console.log(`完整打完：${finished}/${games}，每局游戏 ${(agg.rounds / games).toFixed(1)} 轮（最少 ${minRounds}，最多 ${maxRounds}），共 ${agg.actions} 次操作`);
console.log(`庄家守住：${((agg.dealerHeld / agg.rounds) * 100).toFixed(1)}%，闲家平均得分 ${(agg.opponentPointsSum / agg.rounds).toFixed(1)}`);
console.log(`重发：${agg.redeals}，翻底牌定主：${agg.bottomFlips}`);
console.log(`甩牌尝试：${agg.throwsAttempted}，失败：${agg.throwsFailed}`);
console.log(`朋友位：${agg.friendSlots}，揭晓：${agg.friendsRevealed}，庄家自占：${agg.dealerSelfFriend}`);
const hist = Object.entries(agg.levelsUpHistogram).sort(([a], [b]) => a.localeCompare(b));
console.log(`结算分布：${hist.map(([k, v]) => `${k}=${v}`).join('  ')}`);
if (smartSeats.length > 0 || strongSeats.length > 0 || subsetSeats.length > 0) {
  const label = (i: number) => (beliefSeats ? (beliefSeats.includes(i) ? '搜索+推断网络' : '搜索') : strongSeats.includes(i) ? '搜索三版' : smartSeats.includes(i) ? '策略二版' : basicSeats.includes(i) ? '策略一版' : subsetSeats.includes(i) ? `二版子集(${featureArg})` : '随机');
  console.log(`座位对比（${smartMode}${smartMode === 'ab' ? `，二版特性 ${featureArg}` : ''}）：`);
  const groups = new Map<string, number[]>();
  for (let i = 0; i < players; i++) {
    groups.set(label(i), [...(groups.get(label(i)) ?? []), i]);
    const dr = agg.dealerRounds[i] ?? 0;
    console.log(`  座位 ${i} ${label(i)}：每轮胜率 ${((agg.roundWins[i] ?? 0) / agg.rounds * 100).toFixed(1)}%，每轮升级 ${((agg.levelGain[i] ?? 0) / agg.rounds).toFixed(3)}，坐庄 ${dr} 次守住 ${dr ? ((agg.dealerHolds[i] ?? 0) / dr * 100).toFixed(0) : '-'}%，整局获胜 ${gameWins[i]}`);
  }
  const summary: Record<string, unknown> = { rounds: agg.rounds, games, groups: {} as Record<string, unknown> };
  for (const [name, seats] of groups) {
    const sum = (arr: readonly number[]) => seats.reduce((a, i) => a + (arr[i] ?? 0), 0);
    console.log(`  ${name} 合计：每轮升级 ${(sum(agg.levelGain) / agg.rounds / seats.length).toFixed(3)}，整局获胜 ${sum(gameWins)}，坐庄守住 ${sum(agg.dealerRounds) ? (sum(agg.dealerHolds) / sum(agg.dealerRounds) * 100).toFixed(0) : '-'}%（坐庄 ${sum(agg.dealerRounds)} 次）`);
    (summary.groups as Record<string, unknown>)[name] = { seats: seats.length, levelGain: sum(agg.levelGain), gameWins: sum(gameWins), dealerRounds: sum(agg.dealerRounds), dealerHolds: sum(agg.dealerHolds) };
  }
  // 机器可读的一行，供多进程汇总脚本使用
  console.log(`SUMMARY ${JSON.stringify(summary)}`);
}
