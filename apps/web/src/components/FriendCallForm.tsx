import { useState } from 'react';
import { SUITS, rankName, type PlayerView, type Suit } from '@shengji/engine';
import type { ClientMessage } from '@shengji/protocol';

const GLYPH: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const NTH = ['第一张', '第二张', '第三张'];

interface Call { suit: Suit; rank: number; nth: number }

export function FriendCallForm({ view, send }: { view: PlayerView; send: (m: ClientMessage) => void }) {
  const suits = SUITS.filter((s) => s !== view.trumpSuit);
  const ranks = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2].filter((r) => r !== view.level);
  const [calls, setCalls] = useState<Call[]>(() =>
    Array.from({ length: view.config.friendCount }, (_, i) => ({ suit: suits[0] as Suit, rank: ranks[0] as number, nth: i + 1 })),
  );
  const update = (i: number, patch: Partial<Call>) => setCalls((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const dup = new Set(calls.map((c) => `${c.suit}${c.rank}#${c.nth}`)).size !== calls.length;
  return (
    <div className="friend-form">
      <div className="panel-title">叫朋友</div>
      {calls.map((c, i) => (
        <div key={i} className="friend-row">
          <select value={c.nth} onChange={(e) => update(i, { nth: Number(e.target.value) })}>
            {NTH.slice(0, view.config.decks).map((n, k) => <option key={k} value={k + 1}>{n}</option>)}
          </select>
          <select value={c.suit} onChange={(e) => update(i, { suit: e.target.value as Suit })}>
            {suits.map((s) => <option key={s} value={s}>{GLYPH[s]}</option>)}
          </select>
          <select value={c.rank} onChange={(e) => update(i, { rank: Number(e.target.value) })}>
            {ranks.map((r) => <option key={r} value={r}>{rankName(r)}</option>)}
          </select>
        </div>
      ))}
      {dup && <div className="hint warn">两个朋友牌不能完全相同</div>}
      <button className="primary" disabled={dup} onClick={() => send({ t: 'callFriend', calls })}>确定</button>
    </div>
  );
}
