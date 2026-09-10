/** 一个房间：大厅座位管理 + 驾驭引擎状态机 + 机器人 + 广播。 */
import {
  applyAction, createGame, createRng, currentTurn, defaultConfig, restartRound, smartAction, smartDeclare, viewFor,
  type Action, type GameConfig, type GameEvent, type GameState, type Rng, type Seat,
} from '@shengji/engine';
import type { RoomInfo, RoundReplay, ServerMessage } from '@shengji/protocol';
import type { WebSocket } from 'ws';
import type { RoomSnapshot } from './store.ts';

export interface Member {
  readonly token: string;
  name: string;
  socket: WebSocket | null;
}

interface SeatSlot {
  readonly token: string;
  readonly isBot: boolean;
}

export interface RoomOptions {
  readonly dealIntervalMs: number;
  readonly declareGraceMs: number;
  readonly botDelayMs: number;
}

export const defaultRoomOptions: RoomOptions = { dealIntervalMs: 150, declareGraceMs: 5000, botDelayMs: 900 };

export class Room {
  readonly code: string;
  readonly config: GameConfig;
  readonly members = new Map<string, Member>();
  readonly seats: (SeatSlot | null)[];
  hostToken: string;
  state: GameState | null = null;
  seq = 0;
  lastActivity = Date.now();
  /** 最近几局的操作日志，用于回放 */
  roundLogs: RoundReplay[] = [];
  private readonly rng: Rng;
  private dealTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private botTimer: NodeJS.Timeout | null = null;
  private readonly opts: RoomOptions;
  /** 任何需要落盘的变化后调用 */
  onChange: () => void = () => {};

  constructor(code: string, players: 5 | 6, hostToken: string, opts: RoomOptions = defaultRoomOptions) {
    this.code = code;
    this.config = defaultConfig(players);
    this.hostToken = hostToken;
    this.seats = Array.from({ length: players }, () => null);
    this.rng = createRng(`bots/${code}/${Date.now()}`);
    this.opts = opts;
  }

  toSnapshot(): RoomSnapshot {
    return {
      code: this.code,
      players: this.config.players,
      hostToken: this.hostToken,
      seats: this.seats.map((s) => (s ? { token: s.token, isBot: s.isBot } : null)),
      members: [...this.members.values()].map((m) => ({ token: m.token, name: m.name })),
      state: this.state,
      seq: this.seq,
      lastActivity: this.lastActivity,
      roundLogs: this.roundLogs,
    };
  }

  static fromSnapshot(snap: RoomSnapshot, opts: RoomOptions): Room {
    const room = new Room(snap.code, snap.players, snap.hostToken, opts);
    snap.seats.forEach((s, i) => { room.seats[i] = s ? { token: s.token, isBot: s.isBot } : null; });
    for (const m of snap.members) room.members.set(m.token, { token: m.token, name: m.name, socket: null });
    room.state = snap.state;
    room.seq = snap.seq;
    room.lastActivity = snap.lastActivity;
    room.roundLogs = [...(snap.roundLogs ?? [])];
    return room;
  }

  /** 恢复后重新挂上定时器（发牌、亮主缓冲、机器人） */
  resume(): void {
    if (this.state) this.afterChange([]);
  }

  get started(): boolean {
    return this.state !== null;
  }

  seatOf(token: string): Seat | null {
    const i = this.seats.findIndex((s) => s?.token === token);
    return i >= 0 ? i : null;
  }

  private send(m: Member | undefined, msg: ServerMessage): void {
    if (m?.socket && m.socket.readyState === m.socket.OPEN) m.socket.send(JSON.stringify(msg));
  }

  private error(token: string, code: string, message: string): void {
    this.send(this.members.get(token), { t: 'error', code, message });
  }

  info(forToken: string): RoomInfo {
    return {
      code: this.code,
      players: this.config.players,
      seats: this.seats.map((s, seat) => {
        if (!s) return null;
        const m = this.members.get(s.token);
        return {
          seat,
          name: s.isBot ? `机器人${seat + 1}` : (m?.name ?? '?'),
          connected: s.isBot || Boolean(m?.socket && m.socket.readyState === m.socket.OPEN),
          isBot: s.isBot,
          isHost: s.token === this.hostToken,
        };
      }),
      started: this.started,
      you: this.seatOf(forToken),
      youAreHost: forToken === this.hostToken,
    };
  }

  broadcastRoom(): void {
    for (const m of this.members.values()) this.send(m, { t: 'room', room: this.info(m.token) });
    this.onChange();
  }

  private broadcastState(events: readonly GameEvent[]): void {
    if (!this.state) return;
    this.seq++;
    for (const [seat, slot] of this.seats.entries()) {
      if (!slot || slot.isBot) continue;
      const m = this.members.get(slot.token);
      if (!m) continue;
      const filtered = events.map((e) => (e.type === 'cardDealt' && e.seat !== seat ? { ...e, card: hiddenCard } : e));
      this.send(m, { t: 'state', seq: this.seq, view: viewFor(this.state, seat), events: filtered });
    }
  }

  /** 重连或首次连接时补发当前状态 */
  sync(token: string): void {
    const m = this.members.get(token);
    this.send(m, { t: 'room', room: this.info(token) });
    const seat = this.seatOf(token);
    if (this.state && seat !== null) {
      this.send(m, { t: 'state', seq: this.seq, view: viewFor(this.state, seat), events: [] });
    }
  }

  // ---------- 大厅 ----------

  join(token: string, name: string, socket: WebSocket | null): void {
    const existing = this.members.get(token);
    if (existing) {
      existing.socket = socket;
      existing.name = name;
    } else {
      this.members.set(token, { token, name, socket });
    }
    this.lastActivity = Date.now();
  }

  detach(token: string): void {
    const m = this.members.get(token);
    if (m) m.socket = null;
    if (!this.started && this.seatOf(token) !== null) {
      // 游戏未开始时掉线直接让座
      const seat = this.seatOf(token) as Seat;
      this.seats[seat] = null;
    }
    this.broadcastRoom();
  }

  leave(token: string): void {
    const seat = this.seatOf(token);
    if (this.started && seat !== null) {
      // 游戏中离开：座位交给机器人接管；房主离开则把房主交给下一位真人
      this.seats[seat] = { token: `bot:${seat}`, isBot: true };
      this.members.delete(token);
      if (token === this.hostToken) {
        const next = this.seats.find((s) => s && !s.isBot);
        if (next) this.hostToken = next.token;
      }
      this.broadcastRoom();
      this.afterChange([]);
      return;
    }
    if (seat !== null) this.seats[seat] = null;
    this.members.delete(token);
    if (token === this.hostToken) {
      const next = this.seats.find((s) => s && !s.isBot);
      if (next) this.hostToken = next.token;
      else {
        const first = this.members.keys().next();
        if (!first.done) this.hostToken = first.value;
      }
    }
    this.broadcastRoom();
  }

  /** 开局后进来的人接管一个机器人座位；没有机器人座位返回 false */
  takeoverBot(token: string): boolean {
    const i = this.seats.findIndex((s) => s?.isBot);
    if (i < 0) return false;
    this.seats[i] = { token, isBot: false };
    if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
    this.broadcastRoom();
    this.afterChange([]);
    return true;
  }

  sit(token: string, seat: Seat): void {
    if (this.started) return this.error(token, 'STARTED', '游戏已经开始');
    if (seat < 0 || seat >= this.seats.length) return this.error(token, 'BAD_SEAT', '座位不存在');
    if (this.seats[seat]) return this.error(token, 'SEAT_TAKEN', '这个座位已经有人');
    const cur = this.seatOf(token);
    if (cur !== null) this.seats[cur] = null;
    this.seats[seat] = { token, isBot: false };
    this.broadcastRoom();
  }

  stand(token: string): void {
    if (this.started) return this.error(token, 'STARTED', '游戏已经开始');
    const cur = this.seatOf(token);
    if (cur !== null) this.seats[cur] = null;
    this.broadcastRoom();
  }

  addBot(token: string, seat: Seat): void {
    if (token !== this.hostToken) return this.error(token, 'NOT_HOST', '只有房主能添加机器人');
    if (this.started) return this.error(token, 'STARTED', '游戏已经开始');
    if (this.seats[seat]) return this.error(token, 'SEAT_TAKEN', '这个座位已经有人');
    this.seats[seat] = { token: `bot:${seat}`, isBot: true };
    this.broadcastRoom();
  }

  removeBot(token: string, seat: Seat): void {
    if (token !== this.hostToken) return this.error(token, 'NOT_HOST', '只有房主能移除机器人');
    if (this.started) return this.error(token, 'STARTED', '游戏已经开始');
    if (!this.seats[seat]?.isBot) return this.error(token, 'NOT_BOT', '这个座位不是机器人');
    this.seats[seat] = null;
    this.broadcastRoom();
  }

  start(token: string): void {
    if (token !== this.hostToken) return this.error(token, 'NOT_HOST', '只有房主能开始');
    if (this.started) return this.error(token, 'STARTED', '游戏已经开始');
    if (this.seats.some((s) => !s)) return this.error(token, 'NOT_FULL', '人还没坐满');
    const hostSeat = this.seatOf(token) ?? 0;
    this.state = createGame(this.config, `${this.code}/${Date.now()}`, { firstDealSeat: hostSeat });
    this.beginRoundLog(this.state);
    this.broadcastRoom();
    this.afterChange([]);
  }

  // ---------- 游戏 ----------

  act(token: string, action: Action): void {
    if (!this.state) return this.error(token, 'NOT_STARTED', '游戏还没开始');
    if (action.type === 'nextRound' && token !== this.hostToken) {
      return this.error(token, 'NOT_HOST', '由房主开始下一局');
    }
    const r = applyAction(this.state, action);
    if (!r.ok) return this.error(token, r.error.code, r.error.message);
    this.record(action, r.state, r.events);
    this.state = r.state;
    this.lastActivity = Date.now();
    this.afterChange(r.events);
  }

  /** 房主重发本局 */
  restartRound(token: string): void {
    if (token !== this.hostToken) return this.error(token, 'NOT_HOST', '只有房主能重发本局');
    if (!this.state) return this.error(token, 'NOT_STARTED', '游戏还没开始');
    if (this.state.phase === 'gameOver') return this.error(token, 'WRONG_PHASE', '游戏已经结束，请回大厅重新开始');
    this.dispose();
    const r = restartRound(this.state);
    this.state = r.state;
    this.beginRoundLog(r.state);
    this.lastActivity = Date.now();
    this.afterChange(r.events);
  }

  /** 房主结束游戏：回到大厅，座位与机器人保留，等级从头开始 */
  abortGame(token: string): void {
    if (token !== this.hostToken) return this.error(token, 'NOT_HOST', '只有房主能结束游戏');
    if (!this.state) return this.error(token, 'NOT_STARTED', '游戏还没开始');
    this.dispose();
    this.state = null;
    this.seq++;
    this.lastActivity = Date.now();
    this.broadcastRoom();
  }

  private beginRoundLog(initial: GameState): void {
    this.roundLogs.push({ round: initial.round, initial, actions: [], names: this.seats.map((s, i) => this.nameOfSeat(i, s)) });
    if (this.roundLogs.length > 6) this.roundLogs.shift();
  }

  private nameOfSeat(seat: Seat, slot: SeatSlot | null): string {
    if (!slot) return `${seat + 1} 号`;
    if (slot.isBot) return `机器人${seat + 1}`;
    return this.members.get(slot.token)?.name ?? `${seat + 1} 号`;
  }

  /** 记录一次成功的操作；进入新一局或重发时另起一份日志 */
  private record(action: Action, next: GameState, events: readonly GameEvent[]): void {
    const cur = this.roundLogs[this.roundLogs.length - 1];
    if (cur) (cur.actions as Action[]).push(action);
    if (events.some((e) => e.type === 'dealerChanged' || e.type === 'redeal')) this.beginRoundLog(next);
  }

  replayFor(token: string, round: number): void {
    const log = this.roundLogs.find((r) => r.round === round);
    const finished = this.state && (this.state.round > round || this.state.phase === 'roundEnd' || this.state.phase === 'gameOver');
    if (!log || !finished) return this.error(token, 'NO_REPLAY', '这一局还没结束或者已经太久');
    this.send(this.members.get(token), { t: 'replay', replay: log });
  }

  private apply(action: Action): boolean {
    if (!this.state) return false;
    const r = applyAction(this.state, action);
    if (!r.ok) {
      console.error(`[${this.code}] 内部操作失败 ${action.type}: ${r.error.code} ${r.error.message}`);
      return false;
    }
    this.record(action, r.state, r.events);
    this.state = r.state;
    this.afterChange(r.events);
    return true;
  }

  private afterChange(events: readonly GameEvent[]): void {
    this.broadcastState(events);
    this.onChange();
    const s = this.state;
    if (!s) return;
    switch (s.phase) {
      case 'dealing':
        this.clearTimer('grace');
        if (!this.dealTimer) this.dealTimer = setTimeout(() => this.dealTick(), this.opts.dealIntervalMs);
        break;
      case 'declaring':
        this.clearTimer('deal');
        if (!this.graceTimer) {
          this.graceTimer = setTimeout(() => {
            this.graceTimer = null;
            this.botsMaybeDeclare();
            this.apply({ type: 'closeDeclaring' });
          }, this.opts.declareGraceMs);
        }
        break;
      case 'bottom':
      case 'callFriend':
      case 'playing':
        this.scheduleBot();
        break;
      case 'roundEnd':
        // 房主是机器人（房主离开后）时自动开下一局
        if (this.seats[this.seatOf(this.hostToken) ?? -1]?.isBot || this.seatOf(this.hostToken) === null) {
          this.botTimer = setTimeout(() => { this.botTimer = null; this.apply({ type: 'nextRound' }); }, 8000);
        }
        break;
      case 'gameOver':
        break;
    }
  }

  private dealTick(): void {
    this.dealTimer = null;
    if (!this.state || this.state.phase !== 'dealing') return;
    this.botsMaybeDeclare();
    if (this.state.phase !== 'dealing') return;
    this.apply({ type: 'dealCard' });
  }

  private botsMaybeDeclare(): void {
    if (!this.state) return;
    for (const [seat, slot] of this.seats.entries()) {
      if (!slot?.isBot) continue;
      const a = smartDeclare(this.state, seat, this.rng);
      if (a) {
        const r = applyAction(this.state, a);
        if (r.ok) { this.record(a, r.state, r.events); this.state = r.state; this.broadcastState(r.events); }
      }
    }
  }

  private scheduleBot(): void {
    if (this.botTimer || !this.state) return;
    const turn = currentTurn(this.state);
    if (turn === null || !this.seats[turn]?.isBot) return;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      if (!this.state) return;
      const t = currentTurn(this.state);
      if (t === null || !this.seats[t]?.isBot) return;
      const a = smartAction(this.state, t, this.rng);
      if (a) this.apply(a);
    }, this.opts.botDelayMs);
  }

  private clearTimer(which: 'deal' | 'grace'): void {
    if (which === 'deal' && this.dealTimer) { clearTimeout(this.dealTimer); this.dealTimer = null; }
    if (which === 'grace' && this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
  }

  dispose(): void {
    this.clearTimer('deal');
    this.clearTimer('grace');
    if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
  }
}

const hiddenCard = { id: 'hidden', suit: 'J' as const, rank: 0, deck: 0 };
