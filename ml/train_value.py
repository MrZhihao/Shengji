"""
训练完美信息价值网络。

数据由 packages/engine/src/sim/valueData.ts 生成（ml/data/v{P}-tr*.{x,t,json}，测试集 v{P}-te）。
输入是完全公开局面的原始整数特征除以缩放系数，输出一个数：这一局闲家方的收益（单位：级）。
训练时随机置换三个副牌花色槽做数据增强（副牌花色互换不改变局面价值）。

导出到 packages/engine/models/value-{P}.json 与 value-{P}.bin（小端 float32，各层 weight[out][in] 再 bias），
由引擎里的 parseValueModel 读取。

用法：ml/.venv/bin/python ml/train_value.py --players 4 [--hidden 512 --layers 3 --epochs 8]
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


def load(prefix_glob):
    xs, ts = [], []
    F = None
    for meta_path in sorted(glob.glob(prefix_glob + '.json')):
        meta = json.load(open(meta_path))
        base = meta_path[:-5]
        n, F = meta['samples'], meta['features']
        xs.append(np.fromfile(base + '.x', dtype=np.uint8).reshape(n, F))
        ts.append(np.fromfile(base + '.t', dtype='<f4').reshape(n))
    if not xs:
        raise SystemExit(f'没有找到数据 {prefix_glob}')
    return np.concatenate(xs), np.concatenate(ts), F


def slot_permutation_index(F, P, perm):
    """把三个副牌花色槽（1..3）按 perm 重排后的特征下标。前 (P+2) 个 54 维块是牌的计数，其余不动"""
    idx = np.arange(F)
    for b in range(P + 2):
        base = b * IDENTITIES
        for new_slot, old_slot in enumerate([0] + [1 + p for p in perm]):
            idx[base + new_slot * 13: base + new_slot * 13 + 13] = np.arange(base + old_slot * 13, base + old_slot * 13 + 13)
    return idx


class Net(nn.Module):
    def __init__(self, F, hidden, layers):
        super().__init__()
        dims = [F] + [hidden] * layers
        mods = []
        for a, b in zip(dims[:-1], dims[1:]):
            mods += [nn.Linear(a, b), nn.ReLU()]
        mods.append(nn.Linear(dims[-1], 1))
        self.net = nn.Sequential(*mods)

    def forward(self, x):
        return self.net(x).squeeze(-1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--players', type=int, default=4)
    ap.add_argument('--hidden', type=int, default=512)
    ap.add_argument('--layers', type=int, default=3)
    ap.add_argument('--epochs', type=int, default=8)
    ap.add_argument('--batch', type=int, default=4096)
    ap.add_argument('--lr', type=float, default=1e-3)
    ap.add_argument('--out', default=os.path.join(ROOT, 'packages', 'engine', 'models'))
    args = ap.parse_args()
    P = args.players
    torch.manual_seed(0)
    rng = np.random.default_rng(0)
    dev = torch.device('mps' if torch.backends.mps.is_available() else 'cpu')

    data_dir = os.path.join(ROOT, 'ml', 'data')
    X, T, F = load(os.path.join(data_dir, f'v{P}-tr*'))
    Xt, Tt, _ = load(os.path.join(data_dir, f'v{P}-te'))
    print(f'{P} 人：训练 {len(X)} 个样本，测试 {len(Xt)} 个，特征 {F} 维，设备 {dev}')
    scale = np.maximum(1.0, X.max(axis=0).astype(np.float32))
    scale_t = torch.tensor(scale, device=dev)
    perms = [slot_permutation_index(F, P, p) for p in [(0, 1, 2), (0, 2, 1), (1, 0, 2), (1, 2, 0), (2, 0, 1), (2, 1, 0)]]

    base_mse = float(np.mean((Tt - T.mean()) ** 2))
    print(f'基线（一律猜平均值）测试均方误差 {base_mse:.4f}，标签标准差 {Tt.std():.3f}')

    net = Net(F, args.hidden, args.layers).to(dev)
    opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=1e-5)
    total = math.ceil(len(X) / args.batch) * args.epochs
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=total, pct_start=0.1)
    loss_fn = nn.SmoothL1Loss(beta=1.0)

    def evaluate():
        net.eval()
        preds = []
        with torch.no_grad():
            for s in range(0, len(Xt), 16384):
                x = torch.from_numpy(Xt[s:s + 16384]).to(dev).float() / scale_t
                preds.append(net(x).cpu().numpy())
        net.train()
        p = np.concatenate(preds)
        mse = float(np.mean((p - Tt) ** 2))
        corr = float(np.corrcoef(p, Tt)[0, 1])
        return mse, corr

    t0 = time.time()
    for ep in range(args.epochs):
        perm = rng.permutation(len(X))
        run = 0.0; nb = 0
        for s in range(0, len(X), args.batch):
            idx = np.sort(perm[s:s + args.batch])
            xb = X[idx][:, perms[rng.integers(len(perms))]]
            x = torch.from_numpy(xb).to(dev).float() / scale_t
            t = torch.from_numpy(T[idx]).to(dev)
            loss = loss_fn(net(x), t)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            sched.step()
            run += loss.item(); nb += 1
        mse, corr = evaluate()
        print(f'  第 {ep + 1} 轮：训练损失 {run / nb:.4f}  测试均方误差 {mse:.4f}（基线 {base_mse:.4f}，解释了 {100 * (1 - mse / base_mse):.1f}%）  相关系数 {corr:.3f}  用时 {time.time() - t0:.0f}s')

    os.makedirs(args.out, exist_ok=True)
    layers = [m for m in net.net if isinstance(m, nn.Linear)]
    parts, meta_layers = [], []
    for L in layers:
        w = L.weight.detach().cpu().numpy().astype('<f4')
        b = L.bias.detach().cpu().numpy().astype('<f4')
        parts += [w.reshape(-1), b.reshape(-1)]
        meta_layers.append({'inSize': int(w.shape[1]), 'outSize': int(w.shape[0])})
    blob = np.concatenate(parts).astype('<f4')
    blob.tofile(os.path.join(args.out, f'value-{P}.bin'))
    meta = {
        'version': 1, 'players': P, 'inputSize': int(F), 'scale': [float(v) for v in scale], 'layers': meta_layers,
        'trainSamples': int(len(X)), 'testMse': round(mse, 5), 'baselineMse': round(base_mse, 5), 'testCorr': round(corr, 4),
    }
    json.dump(meta, open(os.path.join(args.out, f'value-{P}.json'), 'w'))
    print(f'已导出 value-{P}.bin，{blob.nbytes / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
