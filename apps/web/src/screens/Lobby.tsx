import type { GameClient } from '../ws.ts';

export function Lobby({ client }: { client: GameClient }) {
  const room = client.room!;
  const full = room.seats.every((s) => s);
  const shareUrl = `${location.origin}/?room=${room.code}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(`来打找朋友：${shareUrl} 房间码 ${room.code}`); } catch { /* 忽略 */ }
  };
  return (
    <div className="lobby">
      <div className="code-card">
        <div className="label">房间码</div>
        <div className="big-code">{room.code}</div>
        <div className="hint">{room.players} 人局 · 按座位号逆时针出牌 · 把房间码发给朋友</div>
        <button className="ghost" onClick={copy}>复制邀请</button>
      </div>
      <div className="seats">
        {room.seats.map((s, i) => (
          <div key={i} className={`seat ${s ? 'taken' : 'empty'} ${room.you === i ? 'me' : ''}`}>
            <div className="seat-no">{i + 1} 号位</div>
            {s ? (
              <>
                <div className="seat-name">{s.name}{s.isHost && <span className="tag">房主</span>}{s.isBot && <span className="tag">机器人</span>}</div>
                {!s.connected && <div className="seat-off">已断线</div>}
                {room.youAreHost && s.isBot && <button className="ghost small" onClick={() => client.send({ t: 'removeBot', seat: i })}>移除</button>}
                {room.you === i && <button className="ghost small" onClick={() => client.send({ t: 'stand' })}>起立</button>}
              </>
            ) : (
              <div className="seat-actions">
                <button className="ghost small" onClick={() => client.send({ t: 'sit', seat: i })}>坐下</button>
                {room.youAreHost && <button className="ghost small" onClick={() => client.send({ t: 'addBot', seat: i })}>加机器人</button>}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="lobby-actions">
        {room.youAreHost ? (
          <button className="primary" disabled={!full} onClick={() => client.send({ t: 'start' })}>
            {full ? '开始游戏' : `还差 ${room.seats.filter((s) => !s).length} 人`}
          </button>
        ) : (
          <div className="hint">等待房主开始</div>
        )}
        <button className="ghost" onClick={() => client.send({ t: 'leaveRoom' })}>离开房间</button>
        {room.youAreHost && (
          <button className="ghost danger" onClick={() => { if (confirm(`关闭房间 ${room.code}？所有人都会回到首页。`)) client.send({ t: 'closeRoom' }); }}>关闭房间</button>
        )}
      </div>
    </div>
  );
}
