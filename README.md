# 升级·找朋友

三副牌、5 或 6 人的「升级找朋友」联机网页版。设计文档见 [docs/DESIGN.md](docs/DESIGN.md)。

## 目录

```
packages/engine/   规则引擎（纯 TypeScript，零运行时依赖）+ 随机/策略机器人 + 模拟器
packages/protocol/ 前后端共享的 WebSocket 消息 schema（zod）
apps/server/       Node + Fastify + ws，房间、会话、机器人补位、静态托管
apps/web/          React + Vite 网页客户端，PWA，手机竖屏优先
docs/              设计文档
```

## 开发

```bash
pnpm install
pnpm test                                   # 引擎单元测试、属性测试、服务端 WebSocket 集成测试
pnpm typecheck
pnpm sim -- --players 6 --games 1000        # 随机机器人跑 1000 局游戏
pnpm sim -- --players 5 --games 3 --verbose # 逐局打印结算
pnpm sim -- --players 6 --games 200 --smart half  # 偶数座位策略机器人、奇数随机，对比胜率
pnpm sim -- --players 6 --games 300 --smart ab --features follow   # 新旧策略 A/B，只开某个特性
pnpm sim -- --players 6 --games 300 --smart ab --tune declareSingle=9,declarePair=7  # 调亮主阈值
```

本地联机（两个终端）：

```bash
pnpm dev:server    # ws://localhost:3000/ws
```

```bash
pnpm dev:web       # http://localhost:5173，会打印局域网地址，同一 WiFi 的手机可直接打开
```

房主创建房间后把 4 位房间码发给朋友，人不够时可以往空位「加机器人」。注意 `dev:server` 用 tsx watch，改服务端代码会重启进程，内存里的房间会丢。

生产方式：先 `pnpm build` 出前端静态文件，再 `pnpm start`，服务端在 3000 端口同时托管页面和 WebSocket。房间快照默认写在 `.data/rooms.json`，重启后自动恢复，可用 `SNAPSHOT_DIR` 改目录。

## 部署到 Fly.io

线上地址：https://shengji-zhaopengyou.fly.dev （Fly 应用名 `shengji-zhaopengyou`，纽瓦克 ewr 机房，shared-cpu-4x 1GB，空闲自动休眠）。

仓库自带 `Dockerfile` 和 `fly.toml`（一台机器，空闲时自动休眠、有人访问自动唤醒，1GB 卷挂在 /data 存快照，休眠前后牌局靠快照恢复）。改完代码重新上线只需：

```bash
fly deploy --ha=false
```

首次在新账号下部署的步骤：

```bash
fly launch --no-deploy --copy-config --name <你的应用名>
```

```bash
fly volumes create shengji_data --region ewr --size 1
```

```bash
fly deploy
```

绑定自己的域名时用 `fly certs add 你的域名`，HTTPS 是 PWA 安装和微信内置浏览器的硬要求。部署完手机打开网址，浏览器菜单里「添加到主屏幕」即可像 App 一样全屏使用。

## 引擎 API

```ts
import { createGame, applyAction, viewFor, defaultConfig } from '@shengji/engine';

let state = createGame(defaultConfig(6), 'room-seed');
const r = applyAction(state, { type: 'dealCard' });
if (r.ok) {
  state = r.state;      // 新状态，旧状态不变
  r.events;             // 供服务端广播的事件列表
} else {
  r.error;              // { code, message }，message 是给玩家看的中文
}
viewFor(state, seat);   // 该座位能看到的信息
```

操作类型：`dealCard`、`declare`、`closeDeclaring`、`exchangeBottom`、`callFriend`、`play`、`nextRound`。

## 参考资料

机器人策略参考了这些公开攻略与规则整理：

- [升级基础打法和技巧攻略 - 87G](http://www.87g.com/zixun/27171.html)
- [An Introduction to Sheng Ji / Tractor - Benjamin Zhang](https://static1.squarespace.com/static/5942f94fb8a79b3aa562e99d/t/62c340d68ede295f34d37bb4/1656963287304/An_Introduction_To_Sheng_Ji_Tractor.pdf)
- [Zhao Pengyou - pagat.com](https://www.pagat.com/kt5/pengyou.html)
- [《找朋友》扑克游戏规则 - 文学城](https://www.wenxuecity.com/blog/201201/37660/19953.html)
- [“找朋友”、“掼蛋”和“大掼路子” - 新浪博客](https://blog.sina.com.cn/s/blog_54644bfd01017iow.html)
