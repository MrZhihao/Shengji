/** 快照落盘：服务端重启后房间与牌局仍在。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '@shengji/protocol';
import { startServer } from '../src/server.ts';

const dir = mkdtempSync(join(tmpdir(), 'shengji-snap-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function connect(port: number): Promise<{ ws: WebSocket; next: (t?: number) => Promise<ServerMessage>; send: (m: ClientMessage) => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const queue: ServerMessage[] = [];
  let waiter: ((m: ServerMessage) => void) | null = null;
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as ServerMessage;
    if (waiter) { const w = waiter; waiter = null; w(m); } else queue.push(m);
  });
  const next = (t = 5000): Promise<ServerMessage> => {
    const q = queue.shift();
    if (q) return Promise.resolve(q);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { waiter = null; rej(new Error('超时')); }, t);
      waiter = (m) => { clearTimeout(timer); res(m); };
    });
  };
  return new Promise((r) => ws.once('open', () => r({ ws, next, send: (m) => ws.send(JSON.stringify(m)) })));
}

it('重启后用同一 token 回到同一个房间，牌局继续', async () => {
  const opts = { dealIntervalMs: 2, declareGraceMs: 20, botDelayMs: 5 };
  let server = await startServer({ port: 0, host: '127.0.0.1', serveStatic: false, snapshotDir: dir, roomOptions: opts });
  const c = await connect(server.port);
  c.send({ t: 'hello', name: '甲' });
  const welcome = await c.next();
  const token = (welcome as Extract<ServerMessage, { t: 'welcome' }>).token;
  await c.next();
  c.send({ t: 'createRoom', players: 5 });
  let room = await c.next();
  const code = (room as Extract<ServerMessage, { t: 'room' }>).room!.code;
  for (let seat = 1; seat < 5; seat++) c.send({ t: 'addBot', seat });
  for (let i = 0; i < 4; i++) room = await c.next();
  c.send({ t: 'start' });
  // 等发牌进行到有手牌
  let handSize = 0;
  for (let i = 0; i < 60 && handSize < 5; i++) {
    const m = await c.next();
    if (m.t === 'state') handSize = m.view.hand.length;
  }
  expect(handSize).toBeGreaterThanOrEqual(5);
  c.ws.close();
  await server.close(); // close 会强制落盘

  server = await startServer({ port: 0, host: '127.0.0.1', serveStatic: false, snapshotDir: dir, roomOptions: opts });
  expect(server.registry.rooms.has(code)).toBe(true);
  const c2 = await connect(server.port);
  c2.send({ t: 'hello', name: '甲', token });
  await c2.next(); // welcome
  const r2 = await c2.next();
  expect(r2.t).toBe('room');
  expect((r2 as Extract<ServerMessage, { t: 'room' }>).room?.code).toBe(code);
  expect((r2 as Extract<ServerMessage, { t: 'room' }>).room?.you).toBe(0);
  let sawState = false;
  for (let i = 0; i < 20 && !sawState; i++) {
    const m = await c2.next();
    if (m.t === 'state') {
      sawState = true;
      expect(m.view.hand.length).toBeGreaterThanOrEqual(handSize);
    }
  }
  expect(sawState).toBe(true);
  c2.ws.close();
  await server.close();
}, 30_000);
