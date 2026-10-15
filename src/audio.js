// 用 WebAudio 即時合成的簡單音效（不用任何音檔）
let ctx = null, master = null, noiseBuf = null;
const last = {};

export function initAudio() {
  try {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.45;
      master.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    ctx.resume();
  } catch (e) { ctx = null; }
}

function throttle(name, gap) {
  if (!ctx) return false;
  const t = ctx.currentTime;
  if (last[name] && t - last[name] < gap) return false;
  last[name] = t;
  return true;
}

function tone(f1, f2, dur, type = 'square', vol = 0.12) {
  if (!ctx) return;
  const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f1, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}

function noise(dur, vol, f1 = 1200, f2 = 200) {
  if (!ctx) return;
  const t = ctx.currentTime, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noiseBuf;
  f.type = 'lowpass';
  f.frequency.setValueAtTime(f1, t);
  f.frequency.exponentialRampToValueAtTime(Math.max(40, f2), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(f).connect(g).connect(master);
  s.start(t); s.stop(t + dur + 0.02);
}

export const sfx = {
  shot(w) {
    if (w === 'pulse' && throttle('s', 0.05)) tone(900, 180, 0.12, 'square', 0.09);
    else if (w === 'vulcan' && throttle('s', 0.06)) tone(1400, 600, 0.05, 'square', 0.05);
    else if (w === 'scatter' && throttle('s', 0.05)) noise(0.15, 0.18, 4000, 500);
  },
  laser() { if (throttle('laser', 0.09)) tone(1800, 1700, 0.09, 'sawtooth', 0.025); },
  boom(big) { if (throttle('boom', 0.03)) noise(big ? 0.9 : 0.35, big ? 0.5 : 0.28, big ? 2000 : 1400, 60); },
  hit() { tone(180, 50, 0.3, 'sawtooth', 0.22); noise(0.25, 0.35, 900, 80); },
  boost() { tone(110, 1100, 0.7, 'sawtooth', 0.14); noise(1.0, 0.25, 5000, 300); },
  pick() { tone(700, 1500, 0.14, 'triangle', 0.14); },
  ui() { tone(880, 880, 0.05, 'square', 0.05); },
  step() { tone(520, 540, 0.04, 'square', 0.04); },
  bump() { tone(140, 90, 0.1, 'square', 0.08); },
  ok() { tone(500, 1600, 0.35, 'triangle', 0.18); },
  fail() { tone(320, 70, 0.45, 'sawtooth', 0.18); },
  shield() { if (throttle('sh', 0.12)) tone(1300, 400, 0.08, 'sine', 0.06); },
  warn() { tone(440, 440, 0.25, 'square', 0.1); setTimeout(() => tone(440, 440, 0.25, 'square', 0.1), 350); },
};

export function vibrate(p) { try { navigator.vibrate?.(p); } catch (e) { /* 不支援就略過 */ } }
