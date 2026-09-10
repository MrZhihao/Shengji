/** 与服务端的 WebSocket 连接：自动重连、会话 token 持久化。 */
import { useEffect, useRef, useState } from 'react';
import type { GameEvent, PlayerView } from '@shengji/engine';
import type { ClientMessage, RoomInfo, RoundReplay, ServerMessage } from '@shengji/protocol';

export interface Toast {
  readonly id: number;
  readonly kind: 'error' | 'info';
  readonly text: string;
}

export interface GameClient {
  readonly connected: boolean;
  readonly name: string;
  readonly room: RoomInfo | null;
  readonly view: PlayerView | null;
  readonly events: readonly GameEvent[];
  readonly toasts: readonly Toast[];
  readonly replay: RoundReplay | null;
  send(msg: ClientMessage): void;
  closeReplay(): void;
  setName(name: string): void;
  dismissToast(id: number): void;
}

const NAME_KEY = 'shengji.name';
const TOKEN_KEY = 'shengji.token';

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export function useGameClient(): GameClient {
  const [connected, setConnected] = useState(false);
  const [name, setNameState] = useState(() => localStorage.getItem(NAME_KEY) ?? '');
  const [room, setRoom] = useState<RoomInfo | null>(null);
  const [view, setView] = useState<PlayerView | null>(null);
  const [events, setEvents] = useState<readonly GameEvent[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [replay, setReplay] = useState<RoundReplay | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const nameRef = useRef(name);
  const toastId = useRef(0);

  const pushToast = (kind: Toast['kind'], text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 3500 : 2500);
  };

  useEffect(() => {
    let closed = false;
    let retry = 500;
    const connect = () => {
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 500;
        setConnected(true);
        if (nameRef.current) {
          const token = localStorage.getItem(TOKEN_KEY) ?? undefined;
          ws.send(JSON.stringify({ t: 'hello', name: nameRef.current, token }));
        }
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as ServerMessage;
        switch (msg.t) {
          case 'welcome': localStorage.setItem(TOKEN_KEY, msg.token); break;
          case 'room':
            setRoom(msg.room);
            if (!msg.room || !msg.room.started) setView(null);
            break;
          case 'state': setView(msg.view); setEvents(msg.events); break;
          case 'error': pushToast('error', msg.message); break;
          case 'replay': setReplay(msg.replay); break;
          case 'pong': break;
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 8000);
      };
    };
    connect();
    const ping = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ t: 'ping' }));
    }, 20000);
    return () => { closed = true; clearInterval(ping); wsRef.current?.close(); };
  }, []);

  const send = (msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else pushToast('error', '还没连上服务器');
  };

  const setName = (n: string) => {
    const trimmed = n.trim().slice(0, 12);
    nameRef.current = trimmed;
    setNameState(trimmed);
    localStorage.setItem(NAME_KEY, trimmed);
    if (trimmed && wsRef.current?.readyState === WebSocket.OPEN) {
      const token = localStorage.getItem(TOKEN_KEY) ?? undefined;
      wsRef.current.send(JSON.stringify({ t: 'hello', name: trimmed, token }));
    }
  };

  return {
    connected, name, room, view, events, toasts, replay, send, setName,
    closeReplay: () => setReplay(null),
    dismissToast: (id) => setToasts((t) => t.filter((x) => x.id !== id)),
  };
}
