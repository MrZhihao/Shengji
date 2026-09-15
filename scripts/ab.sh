#!/bin/bash
# 多进程 A/B：scripts/ab.sh <标签> <人数> <进程数> <每进程局数> <其余 sim 参数...>
# 例：scripts/ab.sh base 4 4 5 --smart strong --budget 999999 --samples 8 --cands 8
set -e
label=$1; players=$2; procs=$3; games=$4; shift 4
dir=${AB_DIR:-/tmp/shengji-ab}/$label; mkdir -p "$dir"
for i in $(seq 0 $((procs-1))); do
  pnpm sim --players "$players" --games "$games" --seed "${SEED_PREFIX:-$label}-$i" "$@" > "$dir/$i.log" 2>&1 &
done
wait
python3 - "$dir" <<'PY'
import sys, json, glob
tot={'rounds':0,'games':0}; groups={}
for f in glob.glob(sys.argv[1]+'/*.log'):
    for line in open(f):
        if line.startswith('SUMMARY '):
            d=json.loads(line[8:]); tot['rounds']+=d['rounds']; tot['games']+=d['games']
            for k,v in d['groups'].items():
                g=groups.setdefault(k,{'seats':v['seats'],'levelGain':0,'gameWins':0,'dealerRounds':0,'dealerHolds':0})
                for kk in ('levelGain','gameWins','dealerRounds','dealerHolds'): g[kk]+=v[kk]
print(f"汇总 {tot['games']} 局游戏 {tot['rounds']} 轮")
for k,g in groups.items():
    hold = g['dealerHolds']/g['dealerRounds']*100 if g['dealerRounds'] else 0
    print(f"  {k}: 每轮升级 {g['levelGain']/tot['rounds']/g['seats']:.3f}  整局获胜 {g['gameWins']}  坐庄守住 {hold:.0f}% ({g['dealerRounds']} 次)")
PY
