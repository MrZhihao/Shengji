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
  /**
   * 闲家拿到分：一阵人群掌声。几十下错落的短促噪声爆发，密度先密后疏，
   * 每一下随机带通滤波模拟不同的手掌，再过一层简单混响，听起来像一小群人在拍手。
   */
  applause(): void {
    if (!enabled) return;
    const a = ac();
    if (!a) return;
    const now = a.currentTime;
    const total = 1.7;
    // 简单混响：两路反馈延迟
    const wet = a.createGain();
    wet.gain.value = 0.45;
    const master = a.createGain();
    master.gain.value = 1;
    const lp = a.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 5200;
    master.connect(lp).connect(a.destination);
    for (const ms of [29, 43]) {
      const d = a.createDelay(0.2);
      d.delayTime.value = ms / 1000;
      const fb = a.createGain();
      fb.gain.value = 0.32;
      wet.connect(d).connect(fb).connect(d);
      d.connect(master);
    }
    const claps = 70;
    for (let i = 0; i < claps; i++) {
      // 时间分布：前 0.3 秒快速变密，之后慢慢稀疏
      const u = Math.random();
      const t = total * (1 - Math.sqrt(1 - u)) * 0.92 + Math.random() * 0.03;
      const dur = 0.012 + Math.random() * 0.02;
      const buf = a.createBuffer(1, Math.max(1, Math.floor(a.sampleRate * dur)), a.sampleRate);
      const data = buf.getChannelData(0);
      for (let j = 0; j < data.length; j++) data[j] = (Math.random() * 2 - 1) * Math.pow(1 - j / data.length, 1.6);
      const src = a.createBufferSource();
      src.buffer = buf;
      const bp = a.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900 + Math.random() * 2400;
      bp.Q.value = 0.7 + Math.random() * 1.2;
      const g = a.createGain();
      const envelope = t < 0.25 ? t / 0.25 : Math.max(0.15, 1 - (t - 0.25) / (total - 0.25));
      g.gain.value = (0.05 + Math.random() * 0.06) * envelope;
      src.connect(bp).connect(g);
      g.connect(master);
      g.connect(wet);
      src.start(now + t);
    }
  },
  /** 亮主、反主：两声狗叫。锯齿波做声带，音高由高滑低，带一点噪声和低通，模拟「汪汪」 */
  bark(): void {
    if (!enabled) return;
    const a = ac();
    if (!a) return;
    const one = (at: number, base: number) => {
      const t0 = a.currentTime + at;
      const o = a.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(base * 1.35, t0);
      o.frequency.exponentialRampToValueAtTime(base * 0.75, t0 + 0.13);
      const lp = a.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(1800, t0);
      lp.frequency.exponentialRampToValueAtTime(700, t0 + 0.14);
      lp.Q.value = 3;
      const g = a.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.09);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      o.connect(lp).connect(g).connect(a.destination);
      o.start(t0);
      o.stop(t0 + 0.18);
      // 气声
      const buf = a.createBuffer(1, Math.floor(a.sampleRate * 0.08), a.sampleRate);
      const d = buf.getChannelData(0);
      for (let j = 0; j < d.length; j++) d[j] = (Math.random() * 2 - 1) * (1 - j / d.length);
      const n = a.createBufferSource();
      n.buffer = buf;
      const nf = a.createBiquadFilter();
      nf.type = 'bandpass';
      nf.frequency.value = 1500;
      const ng = a.createGain();
      ng.gain.value = 0.03;
      n.connect(nf).connect(ng).connect(a.destination);
      n.start(t0);
    };
    one(0, 330);
    one(0.19, 300);
  },
};
