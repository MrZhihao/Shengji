import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createRng, decompose, generateFollow, groupOf, identityKey, levelRank, rankName, suitName, validateFollow,
  type Card, type GameEvent, type PlayerView, type Seat, type TrickPlay,
} from '@shengji/engine';
import type { ClientMessage } from '@shengji/protocol';
import { CardRow, CardView } from '../components/CardView.tsx';
import { FriendCallForm } from '../components/FriendCallForm.tsx';
import { RoundEnd } from '../components/RoundEnd.tsx';
import { sound } from '../sound.ts';
import type { GameClient } from '../ws.ts';

const GLYPH: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const CN_NTH = ['一', '二', '三'];

interface Pos { x: number; y: number }
/** 对手座位在牌桌上的位置（百分比）。出牌逆时针，下家在我的右手边，依次绕到左手边 */
const SEAT_POS: Record<number, Pos[]> = {
  4: [{ x: 85, y: 64 }, { x: 73, y: 18 }, { x: 27, y: 18 }, { x: 15, y: 64 }],
  5: [{ x: 86, y: 66 }, { x: 81, y: 24 }, { x: 50, y: 10 }, { x: 19, y: 24 }, { x: 14, y: 66 }],
};
const ME_POS: Pos = { x: 50, y: 104 };
const CENTER: Pos = { x: 50, y: 52 };
const towardCenter = (p: Pos, t: number): Pos => ({ x: p.x + (CENTER.x - p.x) * t, y: p.y + (CENTER.y - p.y) * t });

function roleOf(view: PlayerView, seat: Seat): { text: string; cls: string } {
  if (view.dealer === seat) return { text: '庄', cls: 'dealer' };
  if (view.dealerTeam.includes(seat)) return { text: '友', cls: 'friend' };
  if (view.knownOpponents.includes(seat)) return { text: '闲', cls: 'opp' };
  return { text: '?', cls: 'unknown' };
}

function declarable(view: PlayerView, selected: readonly Card[]): boolean {
  if (view.phase !== 'dealing' && view.phase !== 'declaring') return false;
  if (selected.length < 1 || selected.length > 3) return false;
  const first = selected[0] as Card;
  if (!selected.every((c) => identityKey(c) === identityKey(first))) return false;
  if (first.suit === 'J' ? selected.length < 2 : first.rank !== view.level) return false;
  return selected.length > (view.declaration?.count ?? 0);
}

function statusText(view: PlayerView, name: (s: Seat) => string): string {
  const me = view.seat;
  switch (view.phase) {
    case 'dealing': return view.declaration ? `${name(view.declaration.seat)} 亮了 ${view.declaration.count} 张，更多张可以反` : '发牌中，有级牌或对王可以亮主';
    case 'declaring': {
      // 反主只改主花色，不改庄家：只有首局才是先亮主者坐庄
      const dealerText = view.dealer !== null ? `，${name(view.dealer)} 坐庄` : '';
      return view.declaration ? `${name(view.declaration.seat)} 亮 ${suitName(view.trumpSuit)}为主${dealerText}` : '无人亮主，即将翻底牌';
    }
    case 'bottom': return view.dealer === me ? '你是庄家，选 ' + view.config.bottomSize + ' 张扣底' : `${name(view.dealer!)} 正在扣底`;
    case 'callFriend': return view.dealer === me ? '叫朋友' : `${name(view.dealer!)} 正在叫朋友`;
    case 'playing': return view.currentTurn === me ? (view.trick?.plays.length ? '轮到你跟牌' : '轮到你出牌') : `等 ${name(view.currentTurn!)} 出牌`;
    case 'roundEnd': return '本局结束';
    case 'gameOver': return '游戏结束';
  }
}

/** 手牌分成两排：尽量在花色边界处切开，让同一花色不跨排。牌少于 8 张时只用一排。 */
function splitHand(hand: readonly Card[], ctx: { level: number; trumpSuit: PlayerView['trumpSuit'] }): Card[][] {
  if (hand.length < 8) return [[...hand]];
  const mid = hand.length / 2;
  let best = Math.ceil(mid);
  let bestDist = Infinity;
  for (let i = 1; i < hand.length; i++) {
    const a = hand[i - 1] as Card, b = hand[i] as Card;
    if (groupOf(a, ctx) === groupOf(b, ctx)) continue;
    const dist = Math.abs(i - mid);
    if (dist < bestDist && dist <= hand.length * 0.2) { bestDist = dist; best = i; }
  }
  return [hand.slice(0, best), hand.slice(best)];
}

export function Table({ client }: { client: GameClient }) {
  const view = client.view!;
  const room = client.room!;
  const me = view.seat;
  const n = view.config.players;
  const [selected, setSelected] = useState<string[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const [linger, setLinger] = useState<{ trick: typeof view.lastTrick; until: number } | null>(null);
  const [soundOn, setSoundOn] = useState(sound.enabled);
  const [menuOpen, setMenuOpen] = useState(false);
  const prevHandIds = useRef<Set<string>>(new Set());
  const prevTurn = useRef<boolean>(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const name = (s: Seat) => room.seats[s]?.name ?? `${s + 1} 号`;

  const positions = useMemo(() => {
    const opps: Seat[] = [];
    for (let k = 1; k < n; k++) opps.push((me + k) % n);
    const map = new Map<Seat, Pos>();
    const list = SEAT_POS[n - 1] ?? SEAT_POS[5]!;
    opps.forEach((s, i) => map.set(s, list[i] as Pos));
    map.set(me, ME_POS);
    return { opps, map };
  }, [me, n]);
  const posOf = (s: Seat): Pos => positions.map.get(s) ?? CENTER;
  const playPosOf = (s: Seat): Pos => (s === me ? { x: 50, y: 84 } : towardCenter(posOf(s), 0.48));

  // 手牌变化：清理失效选择，标记新发到的牌
  const newIds = useMemo(() => {
    const ids = new Set(view.hand.map((c) => c.id));
    const fresh = new Set<string>();
    for (const id of ids) if (!prevHandIds.current.has(id)) fresh.add(id);
    prevHandIds.current = ids;
    return fresh;
  }, [view.hand]);
  useEffect(() => {
    setSelected((sel) => sel.filter((id) => view.hand.some((c) => c.id === id)));
  }, [view.hand]);

  // 事件：闪现文字 + 音效
  useEffect(() => {
    const texts: string[] = [];
    for (const e of client.events as GameEvent[]) {
      switch (e.type) {
        case 'cardsPlayed': if (e.seat !== me) sound.tick(); break;
        case 'cardDealt': if (e.seat === me) sound.tick(); break;
        case 'trickWon': texts.push(`${name(e.winner)} 收了这墩${e.points ? `，${e.points} 分` : ''}`); sound.win(); break;
        case 'friendRevealed': texts.push(e.seat === view.dealer ? '庄家自己打出了朋友牌' : `${name(e.seat)} 是庄家的朋友`); sound.friend(); break;
        case 'throwFailed': texts.push(`${name(e.seat)} 甩牌失败，罚 ${e.penalty} 分`); sound.error(); break;
        case 'declared': texts.push(`${name(e.seat)} 亮 ${e.count} 张${e.suit ? GLYPH[e.suit] : '王'}`); break;
        case 'declaringClosed': if (e.byBottom) texts.push(`无人亮主，翻底牌定${suitName(e.trumpSuit)}`); break;
        case 'redeal': texts.push('无人亮主，重新发牌'); break;
        case 'roundRestarted': texts.push('房主重发了本局'); break;
        default: break;
      }
    }
    if (texts.length) {
      setFlash(texts.join('；'));
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => { flashTimer.current = null; setFlash(null); }, 2200);
    }
  }, [client.events]);

  // 上一墩短暂停留并飞向赢家
  useEffect(() => {
    if (view.lastTrick && (view.trick?.plays.length ?? 0) === 0) {
      setLinger({ trick: view.lastTrick, until: Date.now() + 1100 });
      const t = setTimeout(() => setLinger(null), 1100);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [view.lastTrick]);

  const myTurn = view.phase === 'playing' && view.currentTurn === me;
  useEffect(() => {
    if (myTurn && !prevTurn.current) sound.turn();
    prevTurn.current = myTurn;
  }, [myTurn]);

  const selectedCards = useMemo(() => view.hand.filter((c) => selected.includes(c.id)), [view.hand, selected]);
  const toggle = (id: string) => { sound.unlock(); setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id])); };
  const send = (m: ClientMessage) => client.send(m);
  const ctx = { level: view.level, trumpSuit: view.trumpSuit };
  const handRows = useMemo(() => splitHand(view.hand, ctx), [view.hand, view.level, view.trumpSuit]);

  // 跟牌辅助：即时校验 + 灰显不该出的牌
  const lead = view.trick?.lead ?? null;
  const following = Boolean(lead && (view.trick?.plays.length ?? 0) > 0);
  let leadCount = 0;
  if (lead) for (const c of lead.components) leadCount += c.cards.length;
  const myGroupCount = lead ? view.hand.filter((c) => groupOf(c, ctx) === lead.group).length : 0;
  const dimCard = (c: Card) => following && lead !== null && myGroupCount >= leadCount && groupOf(c, ctx) !== lead.group;
  let playHint: string | null = null;
  let canPlay = myTurn && selected.length > 0;
  if (myTurn && following && lead) {
    if (selected.length !== leadCount) { playHint = selected.length ? `要出 ${leadCount} 张` : null; canPlay = false; }
    else {
      const err = validateFollow(lead, view.hand, selectedCards, ctx);
      if (err) { playHint = err.message; canPlay = false; }
    }
  } else if (myTurn && selected.length > 0) {
    const d = decompose(selectedCards, ctx);
    if (!d) { playHint = '首出必须同一花色，或者全是主牌'; canPlay = false; }
    else if (d.components.length > 1) playHint = '甩牌：有人压得住就要罚分';
  }

  const hint = () => {
    const rng = createRng(String(Date.now()));
    let cards: Card[];
    if (lead && following) cards = generateFollow(lead, view.hand, ctx, rng);
    else {
      const groups = new Map<string, Card[]>();
      for (const c of view.hand) groups.set(groupOf(c, ctx), [...(groups.get(groupOf(c, ctx)) ?? []), c]);
      const biggest = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? [];
      const d = decompose(biggest, ctx);
      const comp = d?.components[d.components.length - 1];
      cards = comp ? [...comp.cards] : view.hand.slice(0, 1);
    }
    setSelected(cards.map((c) => c.id));
  };

  const friendText = view.friendCalls.map((c) => {
    const who = c.resolvedSeat === null ? '未现身' : c.resolvedSeat === view.dealer ? '庄家自占' : name(c.resolvedSeat);
    return `第${CN_NTH[c.nth - 1]}张 ${GLYPH[c.suit]}${rankName(c.rank)} · ${who}`;
  });

  // 当前要显示的出牌：进行中的墩，或停留中的上一墩
  const currentPlays: readonly TrickPlay[] = view.trick?.plays ?? [];
  const lingering = currentPlays.length === 0 && linger && linger.trick ? linger.trick : null;
  const shownPlays: readonly TrickPlay[] = lingering ? lingering.plays : currentPlays;
  const winnerPos = lingering ? posOf(lingering.winner) : null;

  const pct = (p: Pos): React.CSSProperties => ({ left: `${p.x}%`, top: `${p.y}%` });

  return (
    <div className="table">
      <header className="topbar">
        <span className="tb-item tb-code" title="房间码">房 <b>{room.code}</b></span>
        <span className="tb-item">第 {view.round} 局</span>
        <span className="tb-item">级 <b>{rankName(view.level)}</b></span>
        <span className="tb-item">主 <b className={view.trumpSuit === 'H' || view.trumpSuit === 'D' ? 'red' : ''}>{view.trumpDecided ? suitName(view.trumpSuit) : '未定'}</b></span>
        <span className="tb-item">闲家 <b>{view.visibleOpponentPoints}</b></span>
        <span className="tb-item">底 {view.bottomCount}{view.phase === 'dealing' ? ` · 剩 ${view.deckRemaining}` : ''}</span>
        <button className="tb-btn" onClick={() => setSoundOn(sound.toggle())} aria-label="音效">{soundOn ? '🔊' : '🔇'}</button>
        <button className="tb-btn" onClick={() => setMenuOpen((v) => !v)} aria-label="菜单">⋯</button>
      </header>
      {menuOpen && (
        <div className="host-menu">
          {room.youAreHost && (
            <>
              <button className="ghost small" onClick={() => {
                setMenuOpen(false);
                if (confirm('重发本局？当前进度作废，等级和庄家保留。')) send({ t: 'restartRound' });
              }}>重发本局</button>
              <button className="ghost small danger" onClick={() => {
                setMenuOpen(false);
                if (confirm('结束游戏回到大厅？所有人等级归零，座位保留。')) send({ t: 'abortGame' });
              }}>结束游戏</button>
            </>
          )}
          <button className="ghost small danger" onClick={() => {
            setMenuOpen(false);
            if (confirm(`退出本局？你的座位由机器人接管${room.youAreHost ? '，房主交给下一位真人' : ''}。之后用房间码 ${room.code} 重新进入可以接回机器人的座位。`)) send({ t: 'leaveRoom' });
          }}>退出本局</button>
          <button className="ghost small" onClick={() => setMenuOpen(false)}>取消</button>
        </div>
      )}
      {view.friendCalls.length > 0 && <div className="friends-line">朋友牌：{friendText.join('　')}</div>}

      <section className="felt">
        <div className="felt-ring" />
        {positions.opps.map((seat) => {
          const role = roleOf(view, seat);
          const s = room.seats[seat];
          const isTurn = view.currentTurn === seat;
          return (
            <div key={seat} className={`badge ${isTurn ? 'turn' : ''} ${role.cls}`} style={pct(posOf(seat))}>
              <span className={`role ${role.cls}`}>{role.text}</span>
              <span className="b-name">{name(seat)}</span>
              <span className="b-meta">
                <span className="b-level">{rankName(levelRank(view.levels[seat] ?? 0))}</span>
                <span className="b-count">{view.handCounts[seat]}</span>
                {view.trick?.leader === seat && currentPlays.length > 0 && <span className="b-lead">首</span>}
                {s && !s.connected && <span className="b-off">离线</span>}
              </span>
            </div>
          );
        })}

        {shownPlays.map((p) => {
          const from = posOf(p.seat), to = playPosOf(p.seat);
          const style: React.CSSProperties = {
            ...pct(to),
            ['--fx' as string]: `${(from.x - to.x) * 0.9}vw`,
            ['--fy' as string]: `${(from.y - to.y) * 0.5}vh`,
            ['--cx' as string]: winnerPos ? `${(winnerPos.x - to.x) * 0.9}vw` : '0px',
            ['--cy' as string]: winnerPos ? `${(winnerPos.y - to.y) * 0.5}vh` : '0px',
          };
          return (
            <div key={`${p.seat}-${lingering ? 'l' : 'c'}`} className={`play ${lingering ? 'collect' : ''}`} style={style}>
              <CardRow cards={p.cards} small />
            </div>
          );
        })}

        <div className="center-msg" style={pct(CENTER)}>
          <div className={`status ${flash ? 'flash' : ''}`}>{flash ?? statusText(view, name)}</div>
          {view.declaration && (view.phase === 'dealing' || view.phase === 'declaring') && (
            <div className="declared"><span>{name(view.declaration.seat)} 亮</span><CardRow cards={view.declaration.cards} small /></div>
          )}
          {view.phase === 'callFriend' && view.dealer === me && <FriendCallForm view={view} send={send} />}
        </div>
      </section>

      <section className="me">
        <div className="me-head">
          <span className={`role ${roleOf(view, me).cls}`}>{roleOf(view, me).text}</span>
          <span className="b-name">{name(me)}</span>
          <span className="b-level">{rankName(levelRank(view.levels[me] ?? 0))}</span>
          <span className="b-count">{view.hand.length}</span>
          {playHint && <span className="play-hint">{playHint}</span>}
          {selected.length > 0 && <button className="ghost tiny" onClick={() => setSelected([])}>清除</button>}
        </div>
        <div className="hand">
          {handRows.map((row, r) => (
            <div key={r} className="hand-row" style={{ ['--n' as string]: row.length } as React.CSSProperties}>
              {row.map((c) => (
                <CardView
                  key={c.id}
                  card={c}
                  selected={selected.includes(c.id)}
                  dim={dimCard(c)}
                  className={newIds.has(c.id) ? 'dealt' : ''}
                  onClick={() => toggle(c.id)}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="actions">
          {(view.phase === 'dealing' || view.phase === 'declaring') && (
            <button className="primary" disabled={!declarable(view, selectedCards)} onClick={() => { send({ t: 'declare', cards: selected }); setSelected([]); }}>
              亮主{selected.length ? ` ${selected.length} 张` : ''}
            </button>
          )}
          {view.phase === 'bottom' && view.dealer === me && (
            <button className="primary" disabled={selected.length !== view.config.bottomSize} onClick={() => { send({ t: 'exchangeBottom', cards: selected }); setSelected([]); }}>
              扣底 {selected.length}/{view.config.bottomSize}
            </button>
          )}
          {view.phase === 'playing' && (
            <>
              <button className="ghost" disabled={!myTurn} onClick={hint}>提示</button>
              <button className={`primary ${myTurn ? 'pulse' : ''}`} disabled={!canPlay} onClick={() => { send({ t: 'play', cards: selected }); setSelected([]); }}>
                出牌{selected.length ? ` ${selected.length} 张` : ''}
              </button>
            </>
          )}
        </div>
      </section>

      {(view.phase === 'roundEnd' || view.phase === 'gameOver') && view.lastRound && (
        <RoundEnd view={view} room={room} onNext={() => send({ t: 'nextRound' })} onReplay={() => send({ t: 'getReplay', round: view.round })} />
      )}
    </div>
  );
}
