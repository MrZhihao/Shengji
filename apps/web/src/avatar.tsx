/**
 * 头像：机器人用电影明星的名字，头像从维基百科取该词条的缩略图（维基百科接口允许跨域，图片多为自由授权）；
 * 取不到或真人玩家就显示名字首字的圆形色块。结果缓存在本地。
 */
import { useEffect, useState } from 'react';

const CACHE_KEY = 'shengji.avatar.';
const memory = new Map<string, string | null>();

async function fetchWikiThumb(name: string): Promise<string | null> {
  try {
    const res = await fetch(`https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const json = (await res.json()) as { thumbnail?: { source?: string } };
    return json.thumbnail?.source ?? null;
  } catch {
    return null;
  }
}

export function useAvatar(name: string, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(() => (enabled ? memory.get(name) ?? null : null));
  useEffect(() => {
    if (!enabled) { setUrl(null); return; }
    if (memory.has(name)) { setUrl(memory.get(name) ?? null); return; }
    let cached: string | null = null;
    try { cached = localStorage.getItem(CACHE_KEY + name); } catch { /* 忽略 */ }
    if (cached) { memory.set(name, cached); setUrl(cached); return; }
    let alive = true;
    void fetchWikiThumb(name).then((u) => {
      memory.set(name, u);
      if (u) { try { localStorage.setItem(CACHE_KEY + name, u); } catch { /* 忽略 */ } }
      if (alive) setUrl(u);
    });
    return () => { alive = false; };
  }, [name, enabled]);
  return url;
}

const HUES = [14, 36, 92, 160, 200, 250, 290, 330];
function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length] as number;
}

export function Avatar({ name, isBot, size = 28 }: { name: string; isBot: boolean; size?: number }) {
  const url = useAvatar(name, isBot);
  const style: React.CSSProperties = { width: size, height: size, fontSize: Math.round(size * 0.46) };
  if (url) return <img className="avatar" src={url} alt={name} style={style} referrerPolicy="no-referrer" />;
  return <span className="avatar avatar-text" style={{ ...style, background: `hsl(${hueOf(name)} 40% 38%)` }}>{name.slice(0, 1)}</span>;
}
