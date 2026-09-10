/** 合成音效：不依赖音频文件。首次用户手势后解锁 AudioContext。 */

const KEY = 'shengji.sound';
let ctx: AudioContext | null = null;
let enabled = (() => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } })();

function ac(): AudioContext | null {
  if (typeof window === 'undefined' || !('AudioContext' in window)) return null;
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tone(freq: number, dur: number, type: OscillatorType = 'sine', gain = 0.06, at = 0): void {
  if (!enabled) return;
  const a = ac();
  if (!a) return;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.value = freq;
  const t0 = a.currentTime + at;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(a.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

export const sound = {
  get enabled() { return enabled; },
  toggle(): boolean {
    enabled = !enabled;
    try { localStorage.setItem(KEY, enabled ? 'on' : 'off'); } catch { /* 忽略 */ }
    if (enabled) sound.tick();
    return enabled;
  },
  unlock(): void { ac(); },
  /** 出牌、发牌 */
  tick(): void { tone(1800, 0.05, 'triangle', 0.035); },
  /** 轮到你 */
  turn(): void { tone(660, 0.12, 'sine', 0.05); tone(880, 0.16, 'sine', 0.05, 0.12); },
  /** 赢墩 */
  win(): void { tone(523, 0.1, 'triangle', 0.05); tone(659, 0.1, 'triangle', 0.05, 0.09); tone(784, 0.18, 'triangle', 0.05, 0.18); },
  /** 朋友现身 */
  friend(): void { tone(392, 0.12, 'sine', 0.06); tone(523, 0.12, 'sine', 0.06, 0.1); tone(659, 0.12, 'sine', 0.06, 0.2); tone(784, 0.25, 'sine', 0.06, 0.3); },
  /** 错误 */
  error(): void { tone(220, 0.15, 'square', 0.03); },
};
