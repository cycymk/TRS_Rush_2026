// 本機排行榜（存在瀏覽器 localStorage；之後可換成線上伺服器）
const KEY = 'trs-rush-records-v1';
const PREF = 'trs-rush-prefs-v1';

function read() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && Array.isArray(d.runs) && Array.isArray(d.clears)) return d;
  } catch (e) { /* 讀不到就用空的 */ }
  return { runs: [], clears: [] };
}
function write(d) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) { /* 私密模式等情況寫不進去 */ } }

export const Records = {
  // 一整趟航程（死亡或主動結束）
  addRun(r) {
    const d = read();
    d.runs.push(r);
    d.runs.sort((a, b) => b.score - a.score);
    d.runs = d.runs.slice(0, 100);
    write(d);
    return d.runs.indexOf(r) + 1;
  },
  // 每打倒一隻 BOSS 記一筆通關
  addClear(c) {
    const d = read();
    d.clears.push(c);
    d.clears.sort((a, b) => a.time - b.time);
    d.clears = d.clears.slice(0, 100);
    write(d);
  },
  board(cat) {
    const d = read();
    if (cat === 'score') return d.runs.slice().sort((a, b) => b.score - a.score).slice(0, 10);
    if (cat === 'kills') return d.runs.slice().sort((a, b) => b.kills - a.kills).slice(0, 10);
    if (cat === 'fast') return d.clears.slice().sort((a, b) => a.time - b.time).slice(0, 10);
    if (cat === 'flawless') return d.clears.filter((c) => c.flawless).sort((a, b) => a.time - b.time).slice(0, 10);
    return [];
  },
};

export const Prefs = {
  load() {
    try { return Object.assign({ name: '', sens: 1, invert: false }, JSON.parse(localStorage.getItem(PREF)) || {}); }
    catch (e) { return { name: '', sens: 1, invert: false }; }
  },
  save(p) { try { localStorage.setItem(PREF, JSON.stringify(p)); } catch (e) { /* 略過 */ } },
};
