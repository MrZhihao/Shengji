import { useEffect } from 'react';
import { Home } from './screens/Home.tsx';
import { Lobby } from './screens/Lobby.tsx';
import { Replay } from './screens/Replay.tsx';
import { Table } from './screens/Table.tsx';
import { sound } from './sound.ts';
import { useGameClient } from './ws.ts';

export function App() {
  const client = useGameClient();

  // 第一次触摸后解锁音频
  useEffect(() => {
    const unlock = () => { sound.unlock(); window.removeEventListener('pointerdown', unlock); };
    window.addEventListener('pointerdown', unlock);
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  useEffect(() => {
    const last = client.toasts[client.toasts.length - 1];
    if (last?.kind === 'error') sound.error();
  }, [client.toasts]);

  let screen;
  if (!client.name || !client.room) screen = <Home client={client} />;
  else if (!client.room.started || !client.view) screen = <Lobby client={client} />;
  else screen = <Table client={client} />;
  return (
    <>
      {screen}
      {client.replay && <Replay replay={client.replay} onClose={client.closeReplay} />}
      <div className="toasts">
        {client.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => client.dismissToast(t.id)}>{t.text}</div>
        ))}
      </div>
      {!client.connected && <div className="offline">连接断开，正在重连…</div>}
    </>
  );
}
