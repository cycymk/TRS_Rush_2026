// 破解小遊戲（參考 Pragmata 的駭入盤面）：
// 從起點畫一條路徑走到終點，不能穿過障壁、不能重複走；
// 退回上一格可以反悔。經過 ◆ 會得到額外加成（繞路去拿再退回也算）。
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const key = (x, y) => x + ',' + y;
const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// 先隨機走出一條保證可解的路，再把其他格子隨機變成障壁
function generate(n) {
  for (let tries = 0; tries < 400; tries++) {
    const start = { x: (Math.random() * n) | 0, y: n - 1 };
    const goal = { x: (Math.random() * n) | 0, y: 0 };
    const path = [start];
    const seen = new Set([key(start.x, start.y)]);
    let cur = start, ok = false;
    while (path.length < n * n) {
      const opts = [];
      for (const [dx, dy] of DIRS) {
        const x = cur.x + dx, y = cur.y + dy;
        if (x < 0 || y < 0 || x >= n || y >= n || seen.has(key(x, y))) continue;
        opts.push({ x, y, w: dist({ x, y }, goal) < dist(cur, goal) ? 2.3 : 1 });
      }
      if (!opts.length) break;
      let r = Math.random() * opts.reduce((s, o) => s + o.w, 0), nxt = opts[0];
      for (const o of opts) { r -= o.w; if (r <= 0) { nxt = o; break; } }
      cur = { x: nxt.x, y: nxt.y };
      path.push(cur); seen.add(key(cur.x, cur.y));
      if (cur.x === goal.x && cur.y === goal.y) { ok = true; break; }
    }
    if (!ok || path.length < n + 2) continue;

    const cells = new Array(n * n).fill('empty');
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (!seen.has(key(x, y)) && Math.random() < 0.55) cells[y * n + x] = 'block';
    }
    for (const p of shuffle(path.slice(1, -1)).slice(0, 2)) cells[p.y * n + p.x] = 'bonus';
    // 一顆需要繞路才拿得到的 ◆
    const detour = [];
    for (const p of path) for (const [dx, dy] of DIRS) {
      const x = p.x + dx, y = p.y + dy;
      if (x >= 0 && y >= 0 && x < n && y < n && !seen.has(key(x, y)) && cells[y * n + x] === 'empty') detour.push({ x, y });
    }
    if (detour.length) { const d = detour[(Math.random() * detour.length) | 0]; cells[d.y * n + d.x] = 'bonus'; }
    return { n, start, goal, cells };
  }
  // 理論上不會到這裡：退回一條直線
  const cells = new Array(n * n).fill('empty');
  return { n, start: { x: 0, y: n - 1 }, goal: { x: 0, y: 0 }, cells };
}

export class HackGame {
  constructor(root, sfx) {
    this.root = root;
    this.sfx = sfx;
    this.gridEl = root.querySelector('.hack-grid');
    this.timeEl = root.querySelector('.hack-time i');
    this.titleEl = root.querySelector('.hack-title');
    this.infoEl = root.querySelector('.hack-info');
    this.active = false;
    this.dragging = false;
    this.gridEl.addEventListener('pointerdown', (e) => { this.dragging = true; this.trace(e); e.preventDefault(); });
    window.addEventListener('pointermove', (e) => { if (this.dragging) this.trace(e); });
    const up = () => { this.dragging = false; };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  start({ n = 5, time = 10, title = '', info = '', onDone }) {
    this.p = generate(n);
    this.path = [this.p.start];
    this.got = new Set();
    this.t = this.tMax = time;
    this.onDone = onDone;
    this.active = true;
    this.titleEl.textContent = title;
    this.infoEl.textContent = info;
    this.gridEl.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    this.gridEl.innerHTML = '';
    this.cellEls = [];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const c = document.createElement('div');
      c.className = 'cell ' + this.p.cells[y * n + x];
      if (x === this.p.start.x && y === this.p.start.y) c.classList.add('start');
      if (x === this.p.goal.x && y === this.p.goal.y) c.classList.add('goal');
      c.dataset.x = x; c.dataset.y = y;
      this.gridEl.appendChild(c);
      this.cellEls.push(c);
    }
    this.root.classList.remove('hidden', 'ok', 'fail');
    this.render();
  }

  get head() { return this.path[this.path.length - 1]; }

  trace(e) {
    if (!this.active) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const c = el && el.closest && el.closest('.cell');
    if (!c) return;
    const x = +c.dataset.x, y = +c.dataset.y, h = this.head;
    if (Math.abs(x - h.x) + Math.abs(y - h.y) === 1) this.step(x - h.x, y - h.y);
  }

  key(code) {
    if (!this.active) return false;
    const m = { ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] }[code];
    if (m) { this.step(m[0], m[1]); return true; }
    return false;
  }

  step(dx, dy) {
    const n = this.p.n, h = this.head, x = h.x + dx, y = h.y + dy;
    if (x < 0 || y < 0 || x >= n || y >= n) return;
    const type = this.p.cells[y * n + x];
    if (type === 'block') {
      const c = this.cellEls[y * n + x];
      c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump');
      this.sfx?.bump();
      return;
    }
    const prev = this.path[this.path.length - 2];
    if (prev && prev.x === x && prev.y === y) { this.path.pop(); this.sfx?.step(); this.render(); return; }
    if (this.path.some((p) => p.x === x && p.y === y)) return;
    this.path.push({ x, y });
    if (type === 'bonus' && !this.got.has(key(x, y))) { this.got.add(key(x, y)); this.sfx?.pick(); } else this.sfx?.step();
    this.render();
    if (x === this.p.goal.x && y === this.p.goal.y) this.finish(true);
  }

  update(dt) {
    if (!this.active) return;
    this.t -= dt;
    this.timeEl.style.width = Math.max(0, (this.t / this.tMax) * 100) + '%';
    if (this.t <= 0) this.finish(false);
  }

  finish(ok) {
    this.active = false;
    this.dragging = false;
    this.root.classList.add(ok ? 'ok' : 'fail');
    const bonus = this.got.size;
    setTimeout(() => { this.root.classList.add('hidden'); this.onDone?.(ok, bonus); }, 550);
  }

  abort() {
    this.active = false;
    this.root.classList.add('hidden');
  }

  render() {
    const n = this.p.n;
    this.cellEls.forEach((c) => c.classList.remove('path', 'head'));
    for (const p of this.path) this.cellEls[p.y * n + p.x].classList.add('path');
    const h = this.head;
    this.cellEls[h.y * n + h.x].classList.add('head');
    for (const k of this.got) { const [x, y] = k.split(',').map(Number); this.cellEls[y * n + x].classList.add('got'); }
  }
}
