import { useState } from 'react';
import type { GameClient } from '../ws.ts';
import { buildTime } from '../pwa.ts';

export function Home({ client }: { client: GameClient }) {
  const [name, setName] = useState(client.name);
  const [code, setCode] = useState(() => (new URLSearchParams(location.search).get('room') ?? '').toUpperCase().slice(0, 4));
  const [players, setPlayers] = useState<5 | 6>(6);
  const ready = name.trim().length > 0;

  const ensureName = () => {
    if (name.trim() !== client.name) client.setName(name);
  };

  return (
    <div className="home">
      <h1>升级<span>·</span>找朋友</h1>
      <p className="sub">三副牌 · 5 或 6 人 · 找朋友</p>
      <label className="field">
        <span>你的名字</span>
        <input value={name} maxLength={12} placeholder="比如 小赵" onChange={(e) => setName(e.target.value)} onBlur={ensureName} />
      </label>
      <div className="panel">
        <div className="panel-title">开房</div>
        <div className="seg">
          <button className={players === 5 ? 'on' : ''} onClick={() => setPlayers(5)}>5 人 · 1 个朋友</button>
          <button className={players === 6 ? 'on' : ''} onClick={() => setPlayers(6)}>6 人 · 2 个朋友</button>
        </div>
        <button className="primary" disabled={!ready} onClick={() => { ensureName(); setTimeout(() => client.send({ t: 'createRoom', players }), 50); }}>
          创建房间
        </button>
      </div>
      <div className="panel">
        <div className="panel-title">加入</div>
        <div className="hint">房间已开局也能进，会接管机器人的座位</div>
        <div className="row">
          <input className="code" value={code} maxLength={4} placeholder="房间码" onChange={(e) => setCode(e.target.value.toUpperCase())} />
          <button className="primary" disabled={!ready || code.length !== 4} onClick={() => { ensureName(); setTimeout(() => client.send({ t: 'joinRoom', code }), 50); }}>
            进入
          </button>
        </div>
      </div>
      <div className="build">版本 {buildTime}</div>
    </div>
  );
}
