"""
训练手牌推断网络。

数据由 packages/engine/src/sim/beliefData.ts 生成（ml/data/p{P}-tr*.{x,y,m,c,json}，测试集 p{P}-te）。
网络：多层感知机，输入是原始整数特征除以缩放系数，输出每个（规范化身份, 位置）的分数，
在位置维度上按掩码做 softmax。损失是「每张没见过的牌」的交叉熵。

导出到 packages/engine/models/belief-{P}.json（元数据和缩放系数）与 belief-{P}.bin（小端 float32 权重，
各层依次 weight[out][in] 再 bias），由引擎里的 parseBeliefModel 读取。

用法：ml/.venv/bin/python ml/train_belief.py --players 4 [--hidden 512 --layers 2 --epochs 8]
"""
import argparse
import glob
import json
import math
import os
import time

import numpy as np
import torch
import torch.nn as nn

IDENTITIES = 54
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(prefix_glob, players):
    xs, ys, ms, cs = [], [], [], []
    feats = None
    for meta_path in sorted(glob.glob(prefix_glob + '.json')):
        meta = json.load(open(meta_path))
        base = meta_path[:-5]
        n, F, O = meta['samples'], meta['features'], meta['outputs']
        feats = F
        xs.append(np.fromfile(base + '.x', dtype=np.uint8).reshape(n, F))
        ys.append(np.fromfile(base + '.y', dtype=np.uint8).reshape(n, O))
        ms.append(np.fromfile(base + '.m', dtype=np.uint8).reshape(n, O))
        cs.append(np.fromfile(base + '.c', dtype=np.uint8).reshape(n, players))
    if not xs:
        raise SystemExit(f'没有找到数据 {prefix_glob}')
    return np.concatenate(xs), np.concatenate(ys), np.concatenate(ms), np.concatenate(cs), feats


class Net(nn.Module):
    def __init__(self, F, P, hidden, layers):
        super().__init__()
        dims = [F] + [hidden] * layers
        mods = []
        for a, b in zip(dims[:-1], dims[1:]):
            mods += [nn.Linear(a, b), nn.ReLU()]
        mods.append(nn.Linear(dims[-1], IDENTITIES * P))
        self.net = nn.Sequential(*mods)

    def forward(self, x):
        return self.net(x)


def masked_ce(logits, y, m, P):
    """每张没见过的牌的平均交叉熵（自然对数）。掩码外的目标（推断出的断门判断错了）不计入"""
    B = logits.shape[0]
    logits = logits.view(B, IDENTITIES, P)
    y = (y.view(B, IDENTITIES, P) * m.view(B, IDENTITIES, P))
    mask = m.view(B, IDENTITIES, P) > 0
    logits = logits.masked_fill(~mask, -1e4)
    logp = torch.log_softmax(logits, dim=-1)
    return -(y * logp).sum(), y.sum()


def capacity_baseline_ce(y, m, c, P):
    """基线：按各位置剩余容量均匀分配（和原来的随机补全一致，不含手写先验）"""
    y = y.reshape(-1, IDENTITIES, P).astype(np.float64)
    m = m.reshape(-1, IDENTITIES, P).astype(np.float64)
    w = m * c[:, None, :].astype(np.float64)
    z = w.sum(-1, keepdims=True)
    p = np.where(z > 0, w / np.maximum(z, 1e-12), 0)
    y = y * m
    tot = y.sum()
    ce = -(y * np.log(np.maximum(p, 1e-12))).sum()
    return ce / tot


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--players', type=int, required=True)
    ap.add_argument('--hidden', type=int, default=512)
    ap.add_argument('--layers', type=int, default=2)
    ap.add_argument('--epochs', type=int, default=8)
    ap.add_argument('--batch', type=int, default=2048)
    ap.add_argument('--lr', type=float, default=1e-3)
    ap.add_argument('--out', default=os.path.join(ROOT, 'packages', 'engine', 'models'))
    args = ap.parse_args()
    P = args.players
    torch.manual_seed(0)
    dev = torch.device('mps' if torch.backends.mps.is_available() else 'cpu')

    data_dir = os.path.join(ROOT, 'ml', 'data')
    X, Y, M, C, F = load(os.path.join(data_dir, f'p{P}-tr*'), P)
    Xt, Yt, Mt, Ct, _ = load(os.path.join(data_dir, f'p{P}-te'), P)
    print(f'{P} 人：训练 {len(X)} 个样本，测试 {len(Xt)} 个，特征 {F} 维，设备 {dev}')

    scale = np.maximum(1.0, X.max(axis=0).astype(np.float32))
    scale_t = torch.tensor(scale, device=dev)

    base_ce = capacity_baseline_ce(Yt, Mt, Ct, P)
    print(f'基线（按容量均匀分配）测试交叉熵 {base_ce:.4f}')

    net = Net(F, P, args.hidden, args.layers).to(dev)
    opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=1e-5)
    steps_per_epoch = math.ceil(len(X) / args.batch)
    total_steps = steps_per_epoch * args.epochs
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=total_steps, pct_start=0.1)

    def batch(arrs, idx):
        x, y, m = (torch.from_numpy(a[idx]).to(dev) for a in arrs)
        return x.float() / scale_t, y.float(), m.float()

    def evaluate():
        net.eval()
        tot_l, tot_n = 0.0, 0.0
        with torch.no_grad():
            for s in range(0, len(Xt), 8192):
                idx = np.arange(s, min(len(Xt), s + 8192))
                x, y, m = batch((Xt, Yt, Mt), idx)
                l, n = masked_ce(net(x), y, m, P)
                tot_l += l.item(); tot_n += n.item()
        net.train()
        return tot_l / tot_n

    t0 = time.time()
    for ep in range(args.epochs):
        perm = np.random.default_rng(ep).permutation(len(X))
        run_l, run_n = 0.0, 0.0
        for s in range(0, len(X), args.batch):
            idx = np.sort(perm[s:s + args.batch])
            x, y, m = batch((X, Y, M), idx)
            l, n = masked_ce(net(x), y, m, P)
            loss = l / n.clamp(min=1)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            sched.step()
            run_l += l.item(); run_n += n.item()
        te = evaluate()
        print(f'  第 {ep + 1} 轮：训练 {run_l / run_n:.4f}  测试 {te:.4f}  比基线低 {100 * (1 - te / base_ce):.1f}%  用时 {time.time() - t0:.0f}s')

    # 导出
    os.makedirs(args.out, exist_ok=True)
    layers = [m for m in net.net if isinstance(m, nn.Linear)]
    parts = []
    meta_layers = []
    for L in layers:
        w = L.weight.detach().cpu().numpy().astype('<f4')
        b = L.bias.detach().cpu().numpy().astype('<f4')
        parts += [w.reshape(-1), b.reshape(-1)]
        meta_layers.append({'inSize': int(w.shape[1]), 'outSize': int(w.shape[0])})
    blob = np.concatenate(parts).astype('<f4')
    blob.tofile(os.path.join(args.out, f'belief-{P}.bin'))
    meta = {
        'version': 1, 'players': P, 'inputSize': int(F), 'scale': [float(v) for v in scale], 'layers': meta_layers,
        'trainSamples': int(len(X)), 'testCrossEntropy': round(te, 5), 'baselineCrossEntropy': round(float(base_ce), 5),
    }
    json.dump(meta, open(os.path.join(args.out, f'belief-{P}.json'), 'w'))
    print(f'已导出 {os.path.join(args.out, f"belief-{P}.bin")}，{blob.nbytes / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
