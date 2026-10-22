import * as THREE from 'three';
import { HackGame } from './hack.js';
import { sfx, initAudio, vibrate } from './audio.js';
import { Records, Prefs } from './storage.js';
import { QUALITY, createPost, buildEnvironment, makeRockTextures, shieldMaterial } from './graphics.js';
import { buildPlayerShip, buildDrone } from './models.js';

const $ = (id) => document.getElementById(id);
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (k, dt) => 1 - Math.exp(-k * dt);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const TAU = Math.PI * 2;

/* ================= 參數 ================= */
const TUNNEL_R = 11;          // 隧道半徑
const PLAY_R = 7.2;           // 飛船可移動範圍
const TUNNEL_LEN = 420;
const SPAWN_Z = -330;         // 物件從多遠出現
const BASE_SPEED = 62;
const WAVES_PER_ROUND = 3;
const BOSS_Z = -46;
const BOSS_W = 54;          // 母艦圖片在遊戲內的寬度
const BK = BOSS_W / 34;
const BOSS_R = 7.2;         // 母艦本體的命中半徑
const BOSS_SHIELD_R = 9.6 * BK;
const BOSS_Y = 3.4;         // 母艦懸停在畫面偏上方，不被飛船擋住

const WEAPONS = {
  vulcan:  { name: 'VULCAN',  zh: '連射', icon: '⋮', color: 0x59d8ff, rate: [10, 13, 16], dmg: [0.8, 1.0, 1.25], speed: 210, pellets: [1, 1, 1], spread: 0.025, assist: 1.3 },
  scatter: { name: 'SCATTER', zh: '擴散', icon: '✱', color: 0x9dff7a, rate: [2.8, 3.2, 3.6], dmg: [1.1, 1.3, 1.6], speed: 160, pellets: [5, 7, 9], spread: 0.12, range: 130, assist: 0 },
  laser:   { name: 'LASER',   zh: '光束', icon: '━', color: 0xff5ce1, dps: [7, 10, 13.5], drain: 24 },
  missile: { name: 'MISSILE', zh: '飛彈', icon: '➶', color: 0xff9a3d },
};
// 方案 C：三種變形形態，各自綁一種主武器與手感
const MODES = {
  cruise:  { name: 'CRUISE',  zh: '巡航', weapon: 'vulcan',  color: 0x59d8ff, stiff: 10, armor: 1 },
  hover:   { name: 'HOVER',   zh: '懸停', weapon: 'scatter', color: 0x9dff7a, stiff: 7.5, armor: 1 },
  assault: { name: 'ASSAULT', zh: '重裝', weapon: 'laser',   color: 0xff5ce1, stiff: 6, armor: 0.7 },
};
const MODE_KEYS = ['cruise', 'hover', 'assault'];
const WEAPON_KEYS = ['vulcan', 'scatter', 'laser', 'missile'];
const modeOfWeapon = (w) => MODE_KEYS.find((m) => MODES[m].weapon === w);

// BOSS 護盾破解後會進入其中一種狀態，每種狀態有對應的弱點（形態或飛彈）
const BOSS_STATES = {
  ARMOR: { label: '重裝甲', weak: 'missile', color: 0xffc04d, hint: '厚重裝甲 → 按住飛彈鍵鎖定，一口氣轟它' },
  SWARM: { label: '蜂群展開', weak: 'scatter', color: 0x9dff7a, hint: '無人機群 → 切到懸停形態用擴散清掉' },
  CORE:  { label: '核心暴露', weak: 'laser', color: 0xff5ce1, hint: '核心高速移動 → 切到重裝形態用光束追瞄' },
  REGEN: { label: '自我修復', weak: 'vulcan', color: 0xffe066, hint: '持續回血 → 切到巡航形態用連射壓制' },
};
const weakLabel = (w) => w === 'missile' ? '飛彈 MISSILE' : `${MODES[modeOfWeapon(w)].zh}形態 ${MODES[modeOfWeapon(w)].name}`;

const PALETTES = [
  [0x5a2cff, 0x22e0ff],
  [0xff2d7f, 0xffa23d],
  [0x0fc79a, 0x3d6bff],
  [0xa03dff, 0xff4dd2],
];

const SENS = [0.5, 0.36, 0.26];   // 陀螺儀滿偏需要的傾斜角（弧度）

/* ================= 畫面基礎 ================= */
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // 電影感色調（Unreal 預設也是 ACES）
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x8866ff, 110, 330);
const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 700);
camera.position.set(0, 1.3, 7.5);
scene.add(new THREE.HemisphereLight(0xc8b8ff, 0x180830, 0.5));
const sun = new THREE.DirectionalLight(0xfff2e0, 2.2);
sun.position.set(4, 6, 8);
scene.add(sun);
const rim = new THREE.DirectionalLight(0x88aaff, 1.6);   // 背光，勾出物體輪廓
rim.position.set(-3, -2, -10);
scene.add(rim);
const shipLight = new THREE.PointLight(0x66ccff, 6, 25, 2);
scene.add(shipLight);
// 爆炸閃光用的動態光源（固定數量，避免材質重新編譯）
const boomLights = Array.from({ length: 3 }, () => { const l = new THREE.PointLight(0xffaa55, 0, 40, 2); scene.add(l); return l; });
let boomIdx = 0;

const post = createPost(renderer, scene, camera);
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && window.innerWidth < 1100);
let dynScale = 1;
let baseFov = 72;     // 自動降解析度（掉幀時）
let quality = 2;
function resize() {
  // 泛光會把畫面一路縮小 5 次，尺寸太小（例如視窗被隱藏時）會產生空的緩衝區
  const w = Math.max(64, window.innerWidth), h = Math.max(64, window.innerHeight);
  const pr = Math.min(window.devicePixelRatio || 1, QUALITY[quality].maxDpr) * dynScale;
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h, false);
  post.composer.setPixelRatio(pr);
  post.composer.setSize(w, h);
  post.lens.uniforms.uAspect.value = w / h;
  camera.aspect = w / h;
  // 寬螢幕（手機橫拿）時拉近鏡頭，讓水平視野維持差不多，角色才不會變很小
  baseFov = camera.aspect < 1 ? 74 : clamp(2 * Math.atan(Math.tan(50 * Math.PI / 180) / camera.aspect) * 180 / Math.PI, 54, 72);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.3, 'rgba(255,255,255,0.55)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const glowTex = glowTexture();
// 發光材質：intensity > 1 代表超過一般亮度（HDR），會被泛光後製抓到而發出光暈
const hdr = (color, intensity) => new THREE.Color(color).multiplyScalar(intensity);
const additive = (color, opacity = 1, extra = {}, intensity = 1) => {
  const { intensity: _i, ...rest } = extra;
  return new THREE.MeshBasicMaterial({
    color: hdr(color, _i ?? intensity), transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: true, ...rest,
  });
};
function glowSprite(color, scale, intensity = 2) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: hdr(color, intensity), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
  s.scale.setScalar(scale);
  return s;
}

/* ================= 隧道彎曲 =================
   物件的「邏輯座標」是直的（碰撞都用它算），畫面上依距離加一段彎曲偏移，
   遠方看起來像蜿蜒的蟲洞，但靠近飛船時偏移趨近 0，所以操作手感不受影響。 */
const bend = new THREE.Vector2();
const tmpB = { x: 0, y: 0 };
function bendAt(z) {
  const k = Math.max(0, -z) / TUNNEL_LEN;
  tmpB.x = bend.x * k * k; tmpB.y = bend.y * k * k;
  return tmpB;
}
function place(o) {
  const b = bendAt(o.z);
  o.mesh.position.set(o.x + b.x, o.y + b.y, o.z);
}

/* ================= 蟲洞隧道 ================= */
const tunnelUniforms = {
  uTime: { value: 0 }, uTravel: { value: 0 }, uWarp: { value: 0 }, uHit: { value: 0 },
  uBend: { value: bend }, uLen: { value: TUNNEL_LEN }, uDim: { value: 1 },
  uColA: { value: new THREE.Color() }, uColB: { value: new THREE.Color() },
};
const tunnelGeo = new THREE.CylinderGeometry(TUNNEL_R, TUNNEL_R, TUNNEL_LEN, 72, 160, true);
tunnelGeo.rotateX(-Math.PI / 2);
tunnelGeo.translate(0, 0, -TUNNEL_LEN / 2 + 25);
const tunnel = new THREE.Mesh(tunnelGeo, new THREE.ShaderMaterial({
  uniforms: tunnelUniforms,
  side: THREE.DoubleSide,
  vertexShader: /* glsl */`
    uniform vec2 uBend; uniform float uLen;
    varying vec2 vUv; varying float vZ;
    void main() {
      vUv = uv;
      vec3 p = position;
      float k = max(0.0, -p.z) / uLen;
      p.xy += uBend * k * k;
      vZ = p.z;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform float uTime, uTravel, uWarp, uLen, uHit, uDim;
    uniform vec3 uColA, uColB;
    varying vec2 vUv; varying float vZ;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
    void main() {
      float a = vUv.x * 6.2831853;
      float s = (vZ - uTravel) * 0.035 * (1.0 - 0.6 * uWarp);
      float spiral = smoothstep(0.55, 1.0, sin(a * 5.0 + s * 1.7 + uTime * 0.5));
      float rings = pow(0.5 + 0.5 * sin(s * 5.0), 24.0);
      float grid = pow(0.5 + 0.5 * sin(a * 30.0), 30.0);
      float cells = 0.5 + 0.5 * sin(a * 3.0 - s * 0.9 + uTime * 0.3);
      // 流動的電漿與能量絲（左右鏡像取樣，圓周接縫處不會斷開）
      float ax = abs(vUv.x - 0.5) * 14.0;
      float n = fbm(vec2(ax + sin(s * 0.3) * 0.8, s * 1.3 - uTime * 0.6));
      float plasma = smoothstep(0.42, 0.85, n);
      float fil = pow(1.0 - abs(n * 2.0 - 1.0), 14.0);
      vec3 base = mix(uColA, uColB, cells);
      vec3 col = base * (0.03 + plasma * 0.19 + spiral * 0.16 + grid * 0.1);
      col += base * rings * 1.1;
      col += mix(base, vec3(1.0), 0.3) * fil * 0.5;
      float streak = pow(0.5 + 0.5 * sin(a * 48.0 + floor(s * 0.25) * 13.0), 40.0);
      col += vec3(0.75, 0.9, 1.0) * streak * uWarp * 0.9;
      // 隧道盡頭的強光（亮度超過 1，會在泛光下形成光暈）
      float far = clamp(-vZ / (uLen - 60.0), 0.0, 1.0);
      col *= uDim;
      col = mix(col, (uColB * 0.6 + 0.4) * 2.4 * mix(0.6, 1.0, uDim), pow(far, 2.6) * 0.97);
      col += vec3(1.0, 0.1, 0.2) * uHit * 0.8;
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
}));
tunnel.frustumCulled = false;
scene.add(tunnel);

let envRT = null;
function setPalette(i) {
  const [a, b] = PALETTES[i % PALETTES.length];
  const A = tunnelUniforms.uColA.value.setHex(a), B = tunnelUniforms.uColB.value.setHex(b);
  scene.fog.color.copy(B).multiplyScalar(0.6).addScalar(0.4).multiplyScalar(1.1);
  // 依配色重新產生反射環境
  const old = envRT;
  envRT = buildEnvironment(renderer, A, B);
  scene.environment = envRT.texture;
  old?.dispose();
}
setPalette(0);

/* ================= 光速流線 ================= */
const STREAKS = 260;
const streakMat = additive(0xffffff, 0.7, {}, 1.6);
const streakMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 0.06, 1), streakMat, STREAKS);
streakMesh.frustumCulled = false;
scene.add(streakMesh);
const streaks = Array.from({ length: STREAKS }, () => ({ a: rand(0, TAU), r: rand(6.5, 10.5), z: rand(SPAWN_Z, 10) }));
const dummy = new THREE.Object3D();

/* ================= 美術素材（母艦仍用設定圖） ================= */
const texLoader = new THREE.TextureLoader();
function artTex(url) {
  const t = texLoader.load(url);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
const ART = { boss: { tex: artTex('assets/boss.webp'), w: 1536, h: 1024 } };
// 建立面向鏡頭的圖片；width＝遊戲內寬度，(cx, cy)＝圖片上的錨點像素
function artSprite(art, width, cx, cy) {
  const mat = new THREE.SpriteMaterial({ map: art.tex, transparent: true, alphaTest: 0.03, depthWrite: false, toneMapped: false, fog: false });
  const s = new THREE.Sprite(mat);
  const height = width * art.h / art.w;
  s.scale.set(width, height, 1);
  s.center.set(cx / art.w, 1 - cy / art.h);
  s.userData.at = (px, py, z = 0.05) => new THREE.Vector3((px - cx) / art.w * width, -(py - cy) / art.h * height, z);
  return s;
}

/* ================= 玩家飛船（3D 過渡低模，可變形） ================= */
const shipModel = buildPlayerShip(glowSprite, additive);
shipModel.group.scale.setScalar(0.62);   // 直式畫面上約佔三分之一寬
scene.add(shipModel.group);
const ship = { x: 0, y: 0, vx: 0, vy: 0, zOff: 0 };

/* ================= 引擎尾跡 ================= */
const TRAIL_N = 30;
function makeTrail(color, width, intensity) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(TRAIL_N * 2 * 3), col = new Float32Array(TRAIL_N * 2 * 3), idx = [];
  for (let i = 0; i < TRAIL_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { mesh, geo, pts: Array.from({ length: TRAIL_N }, () => new THREE.Vector3(0, 0, 50)), color: hdr(color, intensity), width, anchor: new THREE.Vector3() };
}
const trails = shipModel.nozzles.map((p) => Object.assign(makeTrail(0x4fb0ff, 0.09, 0.9), { local: p.clone() }));
function updateTrails(dt, speed) {
  const on = shipModel.group.visible;
  shipModel.group.updateMatrixWorld();
  for (const t of trails) {
    t.mesh.visible = on;
    const p = t.pts;
    for (let i = TRAIL_N - 1; i > 0; i--) p[i].copy(p[i - 1]).setZ(Math.min(4.5, p[i - 1].z + speed * dt * 0.09));
    p[0].copy(t.local).applyMatrix4(shipModel.group.matrixWorld);
    const pos = t.geo.attributes.position.array, col = t.geo.attributes.color.array;
    const w = t.width * (1 + (S.speedMul - 1) * 0.6);
    for (let i = 0; i < TRAIL_N; i++) {
      const f = 1 - i / (TRAIL_N - 1), ww = w * (0.3 + 0.7 * f), k = f * f * clamp((4.5 - p[i].z) / 2, 0, 1);
      pos.set([p[i].x - ww, p[i].y, p[i].z, p[i].x + ww, p[i].y, p[i].z], i * 6);
      col.set([t.color.r * k, t.color.g * k, t.color.b * k, t.color.r * k, t.color.g * k, t.color.b * k], i * 6);
    }
    t.geo.attributes.position.needsUpdate = true;
    t.geo.attributes.color.needsUpdate = true;
  }
}

/* ================= 共用幾何與材質 ================= */
function rockGeo(seed) {
  const g = new THREE.IcosahedronGeometry(1, 3);
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    // 用位置算出固定的起伏，同一頂點的重複點會得到相同偏移，不會裂開
    const f = 1 + 0.22 * Math.sin(v.x * 4.1 + seed) * Math.sin(v.y * 3.7 + seed * 2.1) + 0.12 * Math.sin(v.z * 5.3 + seed * 0.7);
    v.multiplyScalar(f);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}
const ROCK_GEOS = [1.3, 2.9, 4.4, 7.7].map(rockGeo);
// 隕石材質：程式生成的顏色／凹凸／粗糙度貼圖；大隕石帶發光的岩漿裂縫
const rockTex = makeRockTextures(256);
const rockMat = new THREE.MeshStandardMaterial({ map: rockTex.albedo, bumpMap: rockTex.bump, bumpScale: 4, roughnessMap: rockTex.rough, roughness: 1, metalness: 0.05, color: 0xc8b8ac });
const magmaMat = new THREE.MeshStandardMaterial({
  map: rockTex.albedo, bumpMap: rockTex.bump, bumpScale: 5, roughnessMap: rockTex.rough, roughness: 1, metalness: 0.1, color: 0x6a5c56,
  emissiveMap: rockTex.magma, emissive: 0xff5a1a, emissiveIntensity: 3.2,
});
const wallMat = new THREE.MeshStandardMaterial({ map: rockTex.albedo, bumpMap: rockTex.bump, bumpScale: 3, roughnessMap: rockTex.rough, roughness: 0.8, metalness: 0.5, color: 0x7a74a0, emissive: 0x2a1450, emissiveIntensity: 0.6 });
const crystalMat = new THREE.MeshPhysicalMaterial({ color: 0x66ffee, roughness: 0.06, metalness: 0.2, flatShading: true, clearcoat: 1, iridescence: 1, iridescenceIOR: 1.7, emissive: 0x10a090, emissiveIntensity: 1.6 });

const shotGeoSmall = new THREE.CapsuleGeometry(0.07, 1.2, 2, 6).rotateX(Math.PI / 2);
const shotMats = Object.fromEntries(['vulcan', 'scatter'].map((k) => [k, additive(WEAPONS[k].color, 1, {}, 4)]));
const eshotGeo = new THREE.SphereGeometry(0.65, 14, 10);
const eshotMat = additive(0xff3366, 1, {}, 2.6);
// 小敵人（無人機）：3D 低模，紅眼＋四臂紅圈推進器
const DRONE_SCALE = 0.85;
function makeDroneModel() {
  const m = buildDrone(glowSprite);
  m.g.scale.setScalar(DRONE_SCALE);
  scene.add(m.g);
  return m;
}
const boostOrbGeo = new THREE.OctahedronGeometry(0.8);
const boostOrbMat = new THREE.MeshPhysicalMaterial({ color: 0x113344, emissive: 0x44e8ff, emissiveIntensity: 3.5, flatShading: true, clearcoat: 1, metalness: 0.5, roughness: 0.1 });
const repairOrbMat = new THREE.MeshPhysicalMaterial({ color: 0x113322, emissive: 0x66ff88, emissiveIntensity: 3.5, flatShading: true, clearcoat: 1, metalness: 0.5, roughness: 0.1 });
const ringGeo = new THREE.TorusGeometry(2.3, 0.16, 12, 48);
const ringMat = additive(0xffd166, 0.95, {}, 4);

/* ================= 物件容器 ================= */
const rocks = [], shots = [], eshots = [], pickups = [], rings = [], drones = [], fxs = [];
let boss = null, gate = null;

function removeAt(arr, i) {
  scene.remove(arr[i].mesh);
  arr[i] = arr[arr.length - 1];
  arr.pop();
}
function clearWorld() {
  for (const arr of [rocks, shots, eshots, pickups, rings, drones, missiles]) while (arr.length) removeAt(arr, arr.length - 1);
  clearLocks();
  while (fxs.length) removeFx(fxs.length - 1);
  if (boss) { scene.remove(boss.mesh); boss = null; }
  if (gate) { scene.remove(gate.mesh); gate = null; }
  laserHide();
}

/* ================= 爆炸粒子 ================= */
function spawnBurst(x, y, z, color, count = 24, spd = 12, size = 0.9, life = 0.7, fixed = false) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3), vel = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = rand(-1, 1), th = rand(0, TAU), s = Math.sqrt(1 - u * u), m = rand(0.3, 1) * spd;
    vel[i * 3] = Math.cos(th) * s * m; vel[i * 3 + 1] = Math.sin(th) * s * m; vel[i * 3 + 2] = u * m;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: hdr(color, 3), size, map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const mesh = new THREE.Points(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  fxs.push({ kind: 'points', mesh, geo, mat, vel, x, y, z, life, max: life, fixed });
}
// 大爆炸：粒子＋擴散衝擊波＋飛散碎石＋一瞬間照亮周圍的閃光
const shockGeo = new THREE.RingGeometry(0.85, 1, 48);
function spawnExplosion(x, y, z, color, scale = 1, fixed = false) {
  spawnBurst(x, y, z, color, Math.round(36 * scale), 14 * scale, 1.2 * scale, 0.8, fixed);
  spawnBurst(x, y, z, 0xffffff, Math.round(14 * scale), 6 * scale, 2.2 * scale, 0.35, fixed);
  const mat = additive(color, 1, { side: THREE.DoubleSide }, 4);
  const ring = new THREE.Mesh(shockGeo, mat);
  scene.add(ring);
  fxs.push({ kind: 'ring', mesh: ring, mat, x, y, z, life: 0.55, max: 0.55, fixed, scale: scale * 9 });
  for (let i = 0; i < Math.round(5 * scale); i++) {
    const m = new THREE.Mesh(pick(ROCK_GEOS), rockMat);
    const s = rand(0.15, 0.4) * scale;
    m.scale.setScalar(s);
    scene.add(m);
    fxs.push({ kind: 'debris', mesh: m, x, y, z, life: rand(0.6, 1.1), max: 1, fixed, s,
      vx: rand(-1, 1) * 14 * scale, vy: rand(-1, 1) * 14 * scale, vz: rand(-1, 1) * 10 * scale, rx: rand(-8, 8), ry: rand(-8, 8) });
  }
  const l = boomLights[boomIdx++ % boomLights.length];
  l.color.setHex(color);
  l.userData = { life: 0.35, max: 0.35, peak: 260 * scale, x, y, z, fixed };
}
function removeFx(i) {
  const f = fxs[i];
  if (f.geo) f.geo.dispose();
  if (f.mat) f.mat.dispose();
  removeAt(fxs, i);
}
function updateFx(dt, speed) {
  for (let i = fxs.length - 1; i >= 0; i--) {
    const f = fxs[i];
    f.life -= dt;
    if (f.life <= 0) { removeFx(i); continue; }
    const k = f.life / f.max;
    if (f.kind === 'points') {
      const p = f.geo.attributes.position.array, drag = Math.pow(0.05, dt);
      for (let j = 0; j < p.length; j++) { p[j] += f.vel[j] * dt; f.vel[j] *= drag; }
      f.geo.attributes.position.needsUpdate = true;
      f.mat.opacity = k;
    } else if (f.kind === 'ring') {
      f.mesh.scale.setScalar(f.scale * (1 - k * k) + 0.5);
      f.mat.opacity = k * k;
    } else if (f.kind === 'debris') {
      f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
      f.mesh.rotation.x += f.rx * dt; f.mesh.rotation.y += f.ry * dt;
      f.mesh.scale.setScalar(f.s * Math.min(1, k * 2));
    }
    if (!f.fixed) f.z += speed * dt;
    place(f);
  }
  for (const l of boomLights) {
    const u = l.userData;
    if (!u || !u.life) { l.intensity = 0; continue; }
    u.life = Math.max(0, u.life - dt);
    if (!u.fixed) u.z += speed * dt;
    const b = bendAt(u.z);
    l.position.set(u.x + b.x, u.y + b.y, u.z);
    l.intensity = u.peak * (u.life / u.max) ** 2;
  }
}

/* ================= 狀態 ================= */
function freshState() {
  return {
    phase: 'title', paused: false, hacking: false, timeScale: 1, tsTarget: 1, time: 0, phaseT: 0,
    round: 1, wave: 0, waveDist: 0, waveLen: 1600,
    hull: 150, hullMax: 150, energy: 100, energyRegen: 22, laserLock: false,
    boost: 1, boostMax: 3, warp: 0, speedMul: 1, deflect: 0, invuln: 0, dash: 0, dashDir: 0,
    mode: 'cruise', weapon: 'vulcan', levels: { vulcan: 1, scatter: 1, laser: 1, missile: 1 }, fireT: 0,
    missiles: 6, missileMax: 6, locking: false, tut: null,
    score: 0, kills: 0, credits: 0, roundsCleared: 0,
    roundTime: 0, roundDmg: 0, roundKills: 0,
    spawnAcc: 0, pickupAcc: 0, ringAcc: 0, spawnCount: 0,
    shake: 0, hitFlash: 0, overdrive: false, travel: 0,
  };
}
let S = freshState();
const prefs = Prefs.load();

/* ================= 輸入：陀螺儀 / 觸控 / 滑鼠 / 鍵盤 ================= */
const input = {
  gyro: false, calibrated: false, gx: 0, gy: 0, sgx: 0, sgy: 0,
  mouse: false, mx: 0, my: 0, offX: 0, offY: 0, keys: {},
  touchId: null, tStart: null, tLast: null,
};

const qNow = new THREE.Quaternion(), qCal = new THREE.Quaternion(), qRel = new THREE.Quaternion(), qZ = new THREE.Quaternion();
const qX = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const eulIn = new THREE.Euler(), eulOut = new THREE.Euler(), zAxis = new THREE.Vector3(0, 0, 1);
const DEG = Math.PI / 180;

// 把手機姿態轉成「相對於校正姿勢」的旋轉，橫拿、直拿、任何傾斜角度握持都適用
function onOrient(e) {
  if (e.beta == null || e.gamma == null) return;
  const angle = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0);
  eulIn.set(e.beta * DEG, (e.alpha || 0) * DEG, -e.gamma * DEG, 'YXZ');
  qNow.setFromEuler(eulIn).multiply(qX).multiply(qZ.setFromAxisAngle(zAxis, -angle * DEG));
  if (!input.calibrated) { qCal.copy(qNow); input.calibrated = true; }
  qRel.copy(qCal).invert().multiply(qNow);
  eulOut.setFromQuaternion(qRel, 'YXZ');
  const sens = SENS[prefs.sens] ?? SENS[1];
  const roll = eulOut.z, yaw = eulOut.y, pitch = eulOut.x;
  input.gx = clamp(-(roll + yaw * 0.7) / sens, -1.3, 1.3);
  input.gy = clamp((prefs.invert ? 1 : -1) * pitch / sens, -1.3, 1.3);
  input.gyro = true;
}

async function enableGyro() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();   // iOS 需要使用者同意
      if (r !== 'granted') return;
    }
    window.addEventListener('deviceorientation', onOrient);
  } catch (e) { /* 沒有陀螺儀就用觸控 / 滑鼠 */ }
}

function calibrate() {
  input.calibrated = false;
  input.offX = input.offY = 0;
  toast('已重新校正', 'dim');
}

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') {
    input.mouse = true;
    input.mx = ((e.clientX / window.innerWidth) * 2 - 1) * 1.25;
    input.my = -((e.clientY / window.innerHeight) * 2 - 1) * 1.25;
  } else if (e.pointerId === input.touchId) {
    // 手指拖曳 = 微調位置（可以和陀螺儀疊加）
    const k = Math.min(window.innerWidth, window.innerHeight) * 0.32;
    input.offX = clamp(input.offX + (e.clientX - input.tLast.x) / k, -1.25, 1.25);
    input.offY = clamp(input.offY - (e.clientY - input.tLast.y) / k, -1.25, 1.25);
    input.tLast = { x: e.clientX, y: e.clientY };
  }
});
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return;
  input.touchId = e.pointerId;
  input.tStart = { x: e.clientX, y: e.clientY, t: performance.now() };
  input.tLast = { x: e.clientX, y: e.clientY };
});
const endTouch = (e) => {
  if (e.pointerId !== input.touchId) return;
  const dx = e.clientX - input.tStart.x, dt = performance.now() - input.tStart.t;
  if (dt < 230 && Math.abs(dx) > 55) dash(Math.sign(dx));   // 快速左右滑 = 翻滾閃避
  input.touchId = null;
};
canvas.addEventListener('pointerup', endTouch);
canvas.addEventListener('pointercancel', endTouch);

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (hack.key(e.code)) { e.preventDefault(); return; }
  input.keys[e.code] = true;
  const idx = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
  if (idx >= 0) setMode(MODE_KEYS[idx]);
  if (e.code === 'Tab') { cycleMode(1); e.preventDefault(); }
  if ((e.code === 'KeyF' || e.code === 'KeyM') && !e.repeat) startLock();
  if (e.code === 'Space' || e.code === 'ShiftLeft') { useBoost(); e.preventDefault(); }
  if (e.code === 'KeyH') startBossHack();
  if (e.code === 'KeyQ') dash(-1);
  if (e.code === 'KeyE') dash(1);
  if (e.code === 'KeyR') calibrate();
  if (e.code === 'Escape' || e.code === 'KeyP') togglePause();
});
window.addEventListener('keyup', (e) => {
  input.keys[e.code] = false;
  if (e.code === 'KeyF' || e.code === 'KeyM') releaseLock();
});

function targetXY(rawDt) {
  const k = input.keys;
  const kx = (k.ArrowRight || k.KeyD ? 1 : 0) - (k.ArrowLeft || k.KeyA ? 1 : 0);
  const ky = (k.ArrowUp || k.KeyW ? 1 : 0) - (k.ArrowDown || k.KeyS ? 1 : 0);
  input.offX = clamp(input.offX + kx * rawDt * 2.4, -1.25, 1.25);
  input.offY = clamp(input.offY + ky * rawDt * 2.4, -1.25, 1.25);
  const dz = (v) => Math.sign(v) * Math.max(0, Math.abs(v) - 0.05) / 0.95;
  input.sgx = lerp(input.sgx, dz(input.gx), damp(11, rawDt));
  input.sgy = lerp(input.sgy, dz(input.gy), damp(11, rawDt));
  let tx = input.offX, ty = input.offY;
  if (input.gyro) { tx += input.sgx; ty += input.sgy; }
  else if (input.mouse) { tx += input.mx; ty += input.my; }
  const len = Math.hypot(tx, ty);
  if (len > 1) { tx /= len; ty /= len; }
  return [tx * PLAY_R, ty * PLAY_R];
}

/* ================= HUD 工具 ================= */
const hudCache = {};
function setText(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v; } }
function setWidth(id, f) {
  const v = Math.round(clamp(f, 0, 1) * 1000) / 10;
  if (hudCache[id] !== v) { hudCache[id] = v; $(id).style.width = v + '%'; }
}
let bannerTimer = 0;
function banner(t1, t2 = '', warn = false, dur = 2200) {
  const b = $('banner');
  b.querySelector('.b1').textContent = t1;
  b.querySelector('.b2').textContent = t2;
  b.classList.toggle('warn', warn);
  b.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.remove('show'), dur);
}
const toastLast = {};
function toast(text, cls = '', gap = 0) {
  const now = performance.now();
  if (gap && toastLast[text] && now - toastLast[text] < gap * 1000) return;
  toastLast[text] = now;
  const el = document.createElement('div');
  el.className = 'toast ' + cls;
  el.textContent = text;
  const box = $('toasts');
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => el.remove(), 1000);
}
// 領航員（駭客女王）通訊
let commTimer = 0;
function comm(text, dur = 3200) {
  const c = $('comm');
  c.querySelector('p').textContent = text;
  c.classList.add('show');
  clearTimeout(commTimer);
  commTimer = setTimeout(() => c.classList.remove('show'), dur);
}
let flashV = 0;
function flash(v) { flashV = Math.max(flashV, v); }
const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const hex = (n) => '#' + n.toString(16).padStart(6, '0');

/* ================= 形態切換（方案 C） ================= */
const modesEl = $('modes');
for (const k of MODE_KEYS) {
  const d = MODES[k];
  const b = document.createElement('button');
  b.className = 'mbtn';
  b.dataset.m = k;
  b.style.setProperty('--wc', hex(d.color));
  b.setAttribute('aria-label', `${d.zh}形態`);
  b.innerHTML = `<b>${d.name}</b><small>${d.zh}・${WEAPONS[d.weapon].zh}</small><span class="lv"></span>`;
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); setMode(k); });
  modesEl.appendChild(b);
}
function refreshWeaponButtons() {
  const weak = boss && !boss.shieldUp && boss.state ? BOSS_STATES[boss.state].weak : null;
  for (const b of modesEl.children) {
    const k = b.dataset.m;
    b.classList.toggle('on', k === S.mode);
    b.classList.toggle('weak', MODES[k].weapon === weak);
    b.querySelector('.lv').textContent = 'LV' + S.levels[MODES[k].weapon];
  }
  $('btnMissile').classList.toggle('weak', weak === 'missile');
}
function setMode(k, silent = false) {
  if (S.mode === k) return;
  S.mode = k;
  S.weapon = MODES[k].weapon;
  S.fireT = 0.15;
  shipModel.setMode(k, MODES[k].color);
  refreshWeaponButtons();
  if (!silent) {
    sfx.transform();
    vibrate(15);
    spawnBurst(ship.x, ship.y, 0, MODES[k].color, 16, 5, 0.6, 0.35);
  }
  tutorialEvent('mode', k);
}
function cycleMode(dir) { setMode(MODE_KEYS[(MODE_KEYS.indexOf(S.mode) + dir + 3) % 3]); }

function findTarget(extra, maxDist, withEshots) {
  const aligned = (t, r) => t.z < -4 && t.z > -maxDist && Math.hypot(t.x - ship.x, t.y - ship.y) < r + extra;
  // BOSS 護盾破除時優先瞄準 BOSS 本體
  if (boss && !boss.entering && !boss.shieldUp && aligned(boss, boss.r)) return boss;
  let best = null, bestZ = -Infinity;
  const test = (t, r) => { if (t.z > bestZ && aligned(t, r)) { best = t; bestZ = t.z; } };
  for (const r of rocks) test(r, r.r);
  for (const d of drones) test(d, d.r);
  if (withEshots) for (const e of eshots) test(e, 0.7);
  if (boss && !boss.entering) test(boss, boss.r);
  return best;
}

function spawnShot(w, vx, vy, vz, dmg, life) {
  const mesh = new THREE.Mesh(shotGeoSmall, shotMats[w]);
  scene.add(mesh);
  const s = { mesh, w, x: ship.x, y: ship.y, z: -1.8, prevZ: -1.8, vx, vy, vz, dmg, life, r: 0.4 };
  place(s);
  shots.push(s);
}

function fireWeapon(dt, speed) {
  const w = S.weapon, def = WEAPONS[w], lv = S.levels[w] - 1;
  if (w === 'laser') { laserUpdate(dt, def, lv); return; }
  laserHide();
  S.fireT -= dt * (S.warp > 0 ? 1.5 : 1);
  if (S.fireT > 0) return;
  S.fireT = Math.max(0, S.fireT + 1 / def.rate[lv]);
  // 輔助瞄準：陀螺儀不好精準對準，對單發／連射稍微導向前方最近的目標
  let ax = 0, ay = 0;
  if (def.assist) {
    const t = findTarget(def.assist, 170, w === 'vulcan');   // 只有連射會自動攔截敵彈
    if (t) {
      const tt = -t.z / (def.speed + (t === boss ? 0 : speed));
      ax = (t.x - ship.x) / tt; ay = (t.y - ship.y) / tt;
    }
  }
  const n = def.pellets[lv];
  for (let i = 0; i < n; i++) {
    let vx = ax, vy = ay;
    if (n > 1 && i > 0) {
      const a = ((i - 1) / (n - 1)) * TAU + (lv === 2 ? 0.3 : 0);
      vx += Math.cos(a) * def.spread * def.speed;
      vy += Math.sin(a) * def.spread * def.speed;
    } else if (n === 1 && def.spread) {
      vx += rand(-1, 1) * def.spread * def.speed;
      vy += rand(-1, 1) * def.spread * def.speed;
    }
    spawnShot(w, vx, vy, -def.speed, def.dmg[lv], (def.range || 330) / def.speed);
  }
  sfx.shot(w);
}

// 光束：沿著隧道彎曲畫成多段
const LASER_SEGS = 14;
const laserGeo = new THREE.CylinderGeometry(0.17, 0.17, 1, 8, 1, true);
laserGeo.rotateX(Math.PI / 2);
const laserMat = additive(0xff5ce1, 0.9, {}, 5);
const laserCoreMat = additive(0xffffff, 0.9, {}, 4);
const laserSegs = [];
for (let i = 0; i < LASER_SEGS; i++) {
  const m = new THREE.Mesh(laserGeo, laserMat);
  const c = new THREE.Mesh(laserGeo, laserCoreMat);
  c.scale.set(0.4, 0.4, 1);
  m.add(c);
  m.visible = false;
  m.frustumCulled = false;
  scene.add(m);
  laserSegs.push(m);
}
const laserHit = glowSprite(0xff9cf0, 3, 4);
laserHit.visible = false;
scene.add(laserHit);
const segA = new THREE.Vector3(), segB = new THREE.Vector3();
function laserHide() {
  for (const m of laserSegs) m.visible = false;
  laserHit.visible = false;
}
function laserUpdate(dt, def, lv) {
  if (S.energy <= 0) S.laserLock = true;
  if (S.laserLock && S.energy >= 35) S.laserLock = false;
  if (S.laserLock) { laserHide(); return; }
  S.energy = Math.max(0, S.energy - def.drain * dt);
  sfx.laser();

  let best = null, bestZ = -Infinity, bestR = 0, kind = '', idx = -1;
  const test = (t, r, k, i) => {
    if (t.z < -1 && t.z > -260 && t.z > bestZ && Math.hypot(t.x - ship.x, t.y - ship.y) < r + 0.45) { best = t; bestZ = t.z; bestR = r; kind = k; idx = i; }
  };
  rocks.forEach((r, i) => test(r, r.r, 'rock', i));
  drones.forEach((d, i) => test(d, d.r, 'drone', i));
  eshots.forEach((e, i) => test(e, 0.7, 'eshot', i));
  if (boss && !boss.entering) test(boss, boss.shieldUp ? boss.shieldR : boss.r, 'boss', -1);

  const z1 = best ? best.z + bestR * 0.6 : -260;
  const dmg = def.dps[lv] * dt * (S.warp > 0 ? 1.5 : 1);
  if (kind === 'rock') damageRock(idx, dmg);
  else if (kind === 'drone') damageDrone(idx, dmg);
  else if (kind === 'eshot') killEshot(idx);
  else if (kind === 'boss') damageBoss(dmg, 'laser');

  const z0 = -1.6, w = 1 + Math.random() * 0.35;
  for (let i = 0; i < LASER_SEGS; i++) {
    const za = lerp(z0, z1, i / LASER_SEGS), zb = lerp(z0, z1, (i + 1) / LASER_SEGS);
    let b = bendAt(za); segA.set(ship.x + b.x, ship.y + b.y, za);
    b = bendAt(zb); segB.set(ship.x + b.x, ship.y + b.y, zb);
    const m = laserSegs[i];
    m.visible = true;
    m.position.copy(segA).add(segB).multiplyScalar(0.5);
    m.lookAt(segB);
    m.scale.set(w, w, segA.distanceTo(segB) + 0.05);
  }
  laserHit.visible = !!best;
  if (best) { laserHit.position.copy(segB); laserHit.scale.setScalar(rand(2.2, 3.4)); }
}

/* ================= 飛彈：按住鎖定、放開發射（馬戲團式螺旋追蹤） ================= */
const missileGeo = new THREE.CapsuleGeometry(0.07, 0.45, 2, 6).rotateX(Math.PI / 2);
const missileMat = new THREE.MeshStandardMaterial({ color: 0xe6ebf2, metalness: 0.6, roughness: 0.3 });
const missiles = [];
const locks = [];
let lockT = 0;
const reticleTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.strokeStyle = '#fff';
  g.lineWidth = 5;
  g.beginPath(); g.moveTo(32, 4); g.lineTo(60, 32); g.lineTo(32, 60); g.lineTo(4, 32); g.closePath(); g.stroke();
  g.lineWidth = 3;
  g.beginPath(); g.moveTo(32, 18); g.lineTo(32, 26); g.moveTo(32, 38); g.lineTo(32, 46); g.moveTo(18, 32); g.lineTo(26, 32); g.moveTo(38, 32); g.lineTo(46, 32); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
function makeReticle() {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: reticleTex, color: hdr(0xff9a3d, 2.2), transparent: true, depthTest: false, depthWrite: false, fog: false }));
  s.renderOrder = 10;
  scene.add(s);
  return s;
}
function isAlive(t) { return t === boss ? !!boss && !boss.entering && S.phase === 'boss' : drones.includes(t) || rocks.includes(t); }
function lockable() {
  const list = [];
  for (const d of drones) if (d.z < -8 && d.z > -160) list.push(d);
  for (const r of rocks) if (r.z < -10 && r.z > -150 && r.kind !== 'wall') list.push(r);
  if (boss && !boss.entering && S.phase === 'boss') list.push(boss);
  return list;
}
function startLock() {
  if (!canAct()) return;
  if (S.missiles < 1) { toast('飛彈裝填中', 'dim', 1); return; }
  S.locking = true;
  lockT = 0;
}
function releaseLock() {
  if (!S.locking) return;
  S.locking = false;
  if (!locks.length) return;
  fireMissiles();
}
function updateLocking(rawDt) {
  if (!S.locking) return;
  lockT -= rawDt;
  if (lockT > 0) return;
  lockT = 0.14;
  if (locks.length >= Math.floor(S.missiles)) return;
  const counts = new Map();
  for (const l of locks) counts.set(l.t, (counts.get(l.t) || 0) + 1);
  let best = null, bestScore = Infinity;
  for (const t of lockable()) {
    const c = counts.get(t) || 0;
    const cap = t === boss ? 6 : t.hp > 4 ? 2 : 1;
    if (c >= cap) continue;
    const score = Math.hypot(t.x - ship.x, t.y - ship.y) - t.z * 0.04 + c * 8 + (t.kind === 'small' ? 6 : 0);
    if (score < bestScore) { bestScore = score; best = t; }
  }
  if (!best) return;
  locks.push({ t: best, reticle: makeReticle(), born: S.time, n: counts.get(best) || 0 });
  sfx.lock();
}
function updateReticles() {
  for (let i = locks.length - 1; i >= 0; i--) {
    const l = locks[i];
    if (!isAlive(l.t)) { scene.remove(l.reticle); locks.splice(i, 1); continue; }
    const b = bendAt(l.t.z), age = S.time - l.born, off = l.n * 0.9;
    l.reticle.position.set(l.t.x + b.x + off * 0.4, l.t.y + b.y + off * 0.4, l.t.z + 1);
    l.reticle.scale.setScalar((l.t === boss ? 5 : 2.4) * (1 + Math.max(0, 0.3 - age) * 4));
    l.reticle.material.rotation = age * 1.5;
  }
}
function clearLocks() { for (const l of locks) scene.remove(l.reticle); locks.length = 0; S.locking = false; }
function fireMissiles() {
  const n = locks.length;
  locks.forEach((l, i) => {
    const mesh = new THREE.Mesh(missileGeo, missileMat);
    const g = glowSprite(0xffa040, 0.7, 2.6);
    g.position.z = 0.35;
    mesh.add(g);
    scene.add(mesh);
    const a = (i / n) * TAU + rand(-0.3, 0.3);
    missiles.push({ mesh, x: ship.x, y: ship.y, z: -0.6, vx: Math.cos(a) * 15, vy: Math.sin(a) * 15 + 5, vz: -14,
      t: l.t, age: rand(-0.06, 0), life: 4, dmg: 5 + 2 * (S.levels.missile - 1), wob: rand(0, TAU) });
    scene.remove(l.reticle);
  });
  S.missiles -= n;
  locks.length = 0;
  sfx.missile();
  vibrate(25);
  tutorialEvent('missile', n);
}
const mDir = new THREE.Vector3();
function updateMissiles(dt, speed) {
  for (let i = missiles.length - 1; i >= 0; i--) {
    const m = missiles[i];
    m.age += dt; m.life -= dt;
    let hitDone = false;
    if (m.t && isAlive(m.t)) {
      const dx = m.t.x - m.x, dy = m.t.y - m.y, dz = m.t.z - m.z, dist = Math.hypot(dx, dy, dz) || 1;
      const spd = lerp(28, 160, clamp(m.age / 0.8, 0, 1));
      const turn = m.age < 0.22 ? 1.2 : 6 + m.age * 6;
      // 剛發射時先往外甩、再帶一點蛇行，形成交錯的螺旋白煙
      const wob = Math.max(0, 1 - m.age) * 10;
      m.vx = lerp(m.vx, (dx / dist) * spd + Math.cos(m.age * 9 + m.wob) * wob, damp(turn, dt));
      m.vy = lerp(m.vy, (dy / dist) * spd + Math.sin(m.age * 9 + m.wob) * wob, damp(turn, dt));
      m.vz = lerp(m.vz, (dz / dist) * spd, damp(turn, dt));
      const rad = m.t === boss ? boss.r : (m.t.r || 1);
      if (dist < rad + 0.9) {
        hitDone = true;
        if (m.t === boss) damageBoss(m.dmg, 'missile');
        else if (drones.includes(m.t)) damageDrone(drones.indexOf(m.t), m.dmg);
        else if (rocks.includes(m.t)) damageRock(rocks.indexOf(m.t), m.dmg);
        spawnBurst(m.x, m.y, m.z, 0xffb060, 14, 8, 0.8, 0.4, m.t === boss);
        sfx.boom(false);
      }
    } else {
      m.t = null;
      m.vz = lerp(m.vz, -160, damp(2, dt));
    }
    m.x += m.vx * dt; m.y += m.vy * dt; m.z += m.vz * dt;
    if (hitDone || m.life <= 0 || m.z < SPAWN_Z) { removeAt(missiles, i); continue; }
    emitSmoke(m.x, m.y, m.z);
    place(m);
    mDir.set(m.vx, m.vy, m.vz).normalize().add(m.mesh.position);
    m.mesh.lookAt(mDir);
  }
}

// 白煙：固定大小的粒子池，循環使用
const SMOKE_N = 1200;
const smokeGeo = new THREE.BufferGeometry();
const smokePos = new Float32Array(SMOKE_N * 3), smokeCol = new Float32Array(SMOKE_N * 3);
const smokeData = Array.from({ length: SMOKE_N }, () => ({ x: 0, y: 0, z: 99, age: 9 }));
smokeGeo.setAttribute('position', new THREE.BufferAttribute(smokePos, 3));
smokeGeo.setAttribute('color', new THREE.BufferAttribute(smokeCol, 3));
const smokeMesh = new THREE.Points(smokeGeo, new THREE.PointsMaterial({ size: 0.75, map: glowTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
smokeMesh.frustumCulled = false;
scene.add(smokeMesh);
let smokeIdx = 0;
function emitSmoke(x, y, z) {
  const p = smokeData[smokeIdx];
  smokeIdx = (smokeIdx + 1) % SMOKE_N;
  p.x = x + rand(-0.08, 0.08); p.y = y + rand(-0.08, 0.08); p.z = z; p.age = 0;
}
function updateSmoke(dt, speed) {
  for (let i = 0; i < SMOKE_N; i++) {
    const p = smokeData[i];
    if (p.age > 1.1) { smokeCol[i * 3] = smokeCol[i * 3 + 1] = smokeCol[i * 3 + 2] = 0; smokePos[i * 3 + 2] = 99; continue; }
    p.age += dt;
    p.z += speed * dt * 0.6;
    const b = bendAt(p.z), k = Math.max(0, 1 - p.age / 1.1) * 0.55;
    smokePos[i * 3] = p.x + b.x; smokePos[i * 3 + 1] = p.y + b.y; smokePos[i * 3 + 2] = p.z;
    smokeCol[i * 3] = k; smokeCol[i * 3 + 1] = k; smokeCol[i * 3 + 2] = k * 1.08;
  }
  smokeGeo.attributes.position.needsUpdate = true;
  smokeGeo.attributes.color.needsUpdate = true;
}

/* ================= 生成：隕石 / 道具 / 加速環 ================= */
function makeRock(o) {
  const mesh = new THREE.Mesh(pick(ROCK_GEOS), o.kind === 'crystal' ? crystalMat : o.kind === 'wall' ? wallMat : o.kind === 'big' ? magmaMat : rockMat);
  mesh.scale.setScalar(o.r);
  mesh.rotation.set(rand(0, TAU), rand(0, TAU), 0);
  scene.add(mesh);
  const r = Object.assign({ mesh, vx: rand(-1.2, 1.2), vy: rand(-1.2, 1.2), sx: rand(-1.5, 1.5), sy: rand(-1.5, 1.5), flash: 0, crossed: false }, o);
  place(r);
  rocks.push(r);
  return r;
}
function spawnRock(aimed) {
  const big = Math.random() < (S.round === 1 ? 0.12 : 0.18 + 0.04 * S.round);
  const crystal = !big && Math.random() < 0.07;
  const r = big ? rand(1.9, 2.7) : rand(0.8, 1.4);
  let x, y;
  if (aimed) { x = ship.x + rand(-1.5, 1.5); y = ship.y + rand(-1.5, 1.5); }
  else { const a = rand(0, TAU), d = Math.sqrt(Math.random()) * (PLAY_R + 0.5); x = Math.cos(a) * d; y = Math.sin(a) * d; }
  makeRock({ x, y, z: SPAWN_Z - rand(0, 30), r, hp: big ? 6 : crystal ? 5 : 2, kind: crystal ? 'crystal' : big ? 'big' : 'small' });
}
// 隕石牆：整面擋住，只留一個缺口（也可以用擴散炮硬轟出一條路）
function spawnWall() {
  const hx = rand(-4.5, 4.5), hy = rand(-4.5, 4.5), z = SPAWN_Z - 10;
  for (let row = -4; row <= 4; row++) for (let col = -4; col <= 4; col++) {
    const x = col * 2.9 + (row % 2 ? 1.45 : 0), y = row * 2.5;
    if (Math.hypot(x, y) > PLAY_R + 1.2) continue;
    if (Math.hypot(x - hx, y - hy) < 2.9) continue;
    const r = makeRock({ x, y, z: z + rand(-1, 1), r: rand(1.2, 1.45), hp: 1.6, kind: 'wall' });
    r.vx = r.vy = 0;
  }
}
function spawnPickup(kind) {
  const a = rand(0, TAU), d = rand(0, PLAY_R - 1);
  const mesh = new THREE.Group();
  mesh.add(new THREE.Mesh(boostOrbGeo, kind === 'boost' ? boostOrbMat : repairOrbMat));
  mesh.add(glowSprite(kind === 'boost' ? 0x44e8ff : 0x66ff88, 4));
  scene.add(mesh);
  const p = { mesh, kind, x: Math.cos(a) * d, y: Math.sin(a) * d, z: SPAWN_Z };
  place(p);
  pickups.push(p);
}
function spawnRingAt(x, y, z) {
  const mesh = new THREE.Mesh(ringGeo, ringMat);
  scene.add(mesh);
  const r = { mesh, x, y, z, r: 2.3 };
  place(r);
  rings.push(r);
}
function spawnRing() {
  const a = rand(0, TAU), d = rand(0, PLAY_R - 2.5);
  const mesh = new THREE.Mesh(ringGeo, ringMat);
  scene.add(mesh);
  const r = { mesh, x: Math.cos(a) * d, y: Math.sin(a) * d, z: SPAWN_Z, r: 2.3 };
  place(r);
  rings.push(r);
}

function spawning(dt, speed) {
  S.waveDist += speed * dt;
  S.spawnAcc += speed * dt;
  S.pickupAcc += speed * dt;
  S.ringAcc += speed * dt;
  const prog = S.waveDist / S.waveLen;
  const calm = S.round === 1 && S.wave === 1;
  const gap = (calm ? lerp(44, 30, prog) : lerp(30, 16, prog)) / (1 + 0.18 * (S.round - 1) + 0.1 * (S.wave - 1));
  while (S.spawnAcc > gap) {
    S.spawnAcc -= gap;
    S.spawnCount++;
    if (S.spawnCount % 22 === 0 && (S.wave > 1 || S.round > 1)) spawnWall();
    else spawnRock(Math.random() < 0.3);
  }
  if (S.pickupAcc > 480) { S.pickupAcc = 0; spawnPickup(Math.random() < 0.72 ? 'boost' : 'repair'); }
  if (S.ringAcc > (calm ? 380 : 650)) { S.ringAcc = rand(-150, 0); spawnRing(); }
  S.enemyAcc = (S.enemyAcc || 0) + speed * dt;
  const egap = Math.max(300, 620 - S.wave * 70 - S.round * 40);
  if (!calm && S.enemyAcc > egap && prog > 0.08 && prog < 0.88 && drones.length < 9) { S.enemyAcc = 0; spawnFormation(); }
}

/* ================= 傷害與擊破 ================= */
function addScore(n) { S.score += n; }
function damageRock(i, dmg) {
  const r = rocks[i];
  r.hp -= dmg;
  r.flash = 0.12;
  if (r.hp <= 0) destroyRock(i, true);
}
function destroyRock(i, byPlayer) {
  const r = rocks[i];
  const col = r.kind === 'crystal' ? 0x66ffee : 0xffb070;
  spawnExplosion(r.x, r.y, r.z, r.kind === 'big' ? 0xff7a30 : col, r.kind === 'big' ? 1 : r.kind === 'wall' ? 0.4 : 0.55);
  sfx.boom(r.kind === 'big');
  if (byPlayer) {
    S.kills++; S.roundKills++;
    const pts = { small: 60, big: 150, crystal: 250, wall: 30 }[r.kind];
    addScore(pts);
    S.credits += { small: 4, big: 10, crystal: 45, wall: 2 }[r.kind];
    if (r.kind === 'big') {   // 大隕石碎裂成兩顆小的
      for (const sx of [-1, 1]) {
        const c = makeRock({ x: r.x + sx * 0.8, y: r.y, z: r.z, r: rand(0.7, 1.0), hp: 1.5, kind: 'small' });
        c.vx = sx * rand(4, 7); c.vy = rand(-3, 3);
      }
    }
  }
  removeAt(rocks, i);
}
function damageDrone(i, dmg) {
  const d = drones[i];
  d.hp -= dmg;
  d.flash = 0.1;
  if (d.hp <= 0) {
    spawnExplosion(d.x, d.y, d.z, 0xff4a3a, 0.75, d.mode === 'orbit');
    sfx.boom(false);
    addScore(200); S.credits += 12; S.kills++; S.roundKills++;
    removeAt(drones, i);
    tutorialEvent('kill');
  }
}
// 敵機：從蟲洞深處成隊飛入 → 在前方盤旋射擊 → 時間到就俯衝穿過
function spawnDrone(o) {
  const m = makeDroneModel();
  const d = Object.assign({ mesh: m.g, model: m, r: 1.15, hp: 3 + S.round, fireT: rand(1.2, 2.6), t: 0, flash: 0, spin: rand(-1.5, 1.5), off: rand(0, TAU) }, o);
  place(d);
  drones.push(d);
  return d;
}
function spawnFormation() {
  const n = Math.min(6, (S.round === 1 ? 1 : 2) + S.wave + Math.floor((S.round - 1) / 2));
  const shape = pick(['line', 'v', 'arc']);
  const cy = rand(1, 4.5), hoverZ = rand(-34, -24);
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0 : i / (n - 1) - 0.5;   // -0.5 ~ 0.5
    let tx = u * 14, ty = cy;
    if (shape === 'v') ty = cy + Math.abs(u) * 5;
    if (shape === 'arc') ty = cy - (0.25 - u * u) * 8;
    spawnDrone({ mode: 'fighter', x: tx * 0.3, y: ty * 0.3 + 4, z: SPAWN_Z - i * 6, tx, ty, hoverZ, life: rand(7, 10), state: 'in' });
  }
  if (!S.warnedFormation) { S.warnedFormation = true; comm('偵測到敵機編隊！它們會盤旋射擊，最後俯衝——打掉或閃開。', 3600); }
  else toast('敵機編隊接近', 'bad', 3);
}
function killEshot(i) {
  const e = eshots[i];
  spawnBurst(e.x, e.y, e.z, 0xff6688, 10, 6, 0.7, 0.4, true);
  addScore(20);
  removeAt(eshots, i);
}

function hurt(amount, fromX, fromY) {
  if (S.phase === 'dead' || S.phase === 'tutorial' || S.warp > 0 || S.dash > 0 || S.invuln > 0) return;
  showHitDir(fromX, fromY);
  amount *= MODES[S.mode].armor;
  if (S.deflect > 0) {
    S.deflect--; S.invuln = 0.8;
    toast('偏折護盾抵擋！', 'good'); sfx.shield();
    return;
  }
  S.hull -= amount;
  S.roundDmg += amount;
  if (!S.warnedHull && S.hull > 0 && S.hull / S.hullMax < 0.3) { S.warnedHull = true; comm('船體受損嚴重！找綠色修復核心，撐住！', 3000); }
  S.invuln = 1.0;
  S.shake = 0.8;
  S.hitFlash = 1;
  sfx.hit();
  vibrate([40, 30, 40]);
  if (S.hull <= 0) { S.hull = 0; die(); }
}

/* ================= 加速 / 翻滾 ================= */
function canAct() { return ['wave', 'gateApproach', 'bossIntro', 'boss', 'tutorial'].includes(S.phase) && !S.paused && !S.hacking; }
// 被打中時，畫面邊緣在來襲方向亮紅光
function showHitDir(x, y) {
  const el = $('hitdir');
  const dx = x === undefined ? 0 : x - ship.x, dy = y === undefined ? -1 : y - ship.y;
  el.dataset.side = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'l' : 'r') : (dy > 0 ? 't' : 'b');
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
}
function triggerWarp(dur) {
  S.warp = Math.max(S.warp, dur);
  camera.fov = baseFov - 14;            // 先瞬間拉近，再猛然拉遠 → 瞬移的爆發感
  camera.updateProjectionMatrix();
  ship.zOff = -3.5;
  flash(0.45);
  const ringMat = additive(0xbfe8ff, 1, { side: THREE.DoubleSide }, 3);
  const ring = new THREE.Mesh(shockGeo, ringMat);
  scene.add(ring);
  fxs.push({ kind: 'ring', mesh: ring, mat: ringMat, x: ship.x, y: ship.y, z: -3, life: 0.5, max: 0.5, fixed: true, scale: 16 });
  S.shake = 0.9;
  sfx.boost();
  vibrate(70);
}
function useBoost() {
  if (!canAct() || S.boost <= 0 || S.warp > 0.3) return;
  S.boost--;
  triggerWarp(3.0);
  toast('FOLD！', 'good');
  tutorialEvent('fold');
}
function addBoost(n) {
  const room = S.boostMax - S.boost, add = Math.min(room, n);
  S.boost += add;
  if (n > add) addScore((n - add) * 300);
}
function dash(dir) {
  if (!canAct() || S.dash > 0) return;
  S.dash = 0.38;
  S.dashDir = dir;
  input.offX = clamp(input.offX + dir * 0.55, -1.25, 1.25);
  sfx.step();
}

/* ================= 遊戲流程 ================= */
function showHUD(on) { $('hud').classList.toggle('hidden', !on); }
function hideOverlays() { for (const id of ['title', 'result', 'shop', 'over', 'board', 'pause', 'choice']) $(id).classList.add('hidden'); }

function startGame() {
  initAudio();
  $('tutTip').classList.add('hidden');
  $('btnSkipTut').classList.add('hidden');
  clearWorld();
  S = freshState();
  hideOverlays();
  showHUD(true);
  shipModel.group.visible = true;
  shipModel.setMode('cruise', MODES.cruise.color);
  refreshWeaponButtons();
  input.calibrated = false;
  input.offX = input.offY = 0;
  startRound();
}
function startRound() {
  S.wave = 0; S.roundTime = 0; S.roundDmg = 0; S.roundKills = 0;
  if (S.round === 1) S.deflect = Math.max(S.deflect, 3);   // 第一輪：前 3 次撞擊有護盾
  setPalette(S.round - 1);
  startWave();
}
function startWave() {
  S.wave++;
  S.phase = 'wave';
  S.waveDist = 0; S.spawnAcc = 0;
  S.waveLen = (S.round === 1 ? 1300 : 1500) + 250 * (S.round - 1) + 150 * (S.wave - 1);
  banner(`ROUND ${S.round} · WAVE ${S.wave}/${WAVES_PER_ROUND}`);
  if (S.overdrive) { S.overdrive = false; triggerWarp(3); }
  S.warnedFormation = false;
  S.warnedHull = false;
  if (S.wave === 1 && S.round === 1) comm('先穿光環熱身，第一段沒有敵機。我幫你開了 3 層護盾。', 4200);
  else if (S.wave === 1) comm(`第 ${S.round} 輪，蟲洞更不穩了……跟緊我的訊號。`);
  else comm(pick(['下一段航道，隕石密度上升。', '前方有大量訊號，準備交戰。', '保持速度，金色光環能讓你瞬間加速。']));
}
function endWave() {
  if (S.wave < WAVES_PER_ROUND) {
    S.phase = 'gateApproach';
    const type = (S.wave + S.round) % 2 === 0 ? 'choice' : 'hack';
    spawnGate(type);
    banner('前方：資料閘門', type === 'choice' ? '穿過閘門選擇強化' : '穿過閘門進行破解');
    comm(type === 'choice' ? '閘門裡有補給，挑一個你需要的。' : '閘門有加密節點，交給我……不，交給你的手指。');
  } else startBoss();
}

function spawnGate(type) {
  const col = type === 'choice' ? 0x66f0ff : 0xff66d9;
  const g = new THREE.Group();
  const mat = additive(col, 1, {}, 4);
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(8.8, 0.08, 6, 6), mat);
  g.add(new THREE.Mesh(new THREE.TorusGeometry(9.6, 0.35, 8, 72), mat), ring2);
  g.add(new THREE.Mesh(new THREE.CircleGeometry(9.5, 48), additive(col, 0.12, { side: THREE.DoubleSide }, 1.5)));
  scene.add(g);
  gate = { mesh: g, x: 0, y: 0, z: -300, type, ring2 };
}
function openGate(type) {
  S.phase = 'gate';
  S.tsTarget = 0.12;
  flash(0.6);
  sfx.ok();
  while (rocks.length) removeAt(rocks, rocks.length - 1);
  if (type === 'choice') showChoice();
  else {
    S.hacking = true;
    hack.start({
      n: 5, time: Math.max(7, 11 - (S.round - 1)), title: '破解資料節點',
      info: '用手指從起點畫到終點 · 經過 ◆ 可得額外加速',
      onDone: (ok, bonus) => {
        S.hacking = false;
        if (ok) { addBoost(1 + bonus); S.credits += 100 + 50 * bonus; toast(`破解成功 加速 +${1 + bonus}`, 'good'); sfx.ok(); }
        else { toast('破解失敗', 'bad'); sfx.fail(); }
        closeGate();
      },
    });
  }
}
function closeGate() {
  S.tsTarget = 1;
  startWave();
}

const CARDS = [
  { icon: '⚡', title: '加速核心 ×2', desc: '獲得 2 次超光速衝刺', apply: () => addBoost(2) },
  { icon: '✚', title: '奈米修復', desc: '修復 40 船體', ok: () => S.hull < S.hullMax, apply: () => { S.hull = Math.min(S.hullMax, S.hull + 40); } },
  { icon: '▲', title: '武器超頻', desc: '目前武器等級 +1', ok: () => S.levels[S.weapon] < 3, apply: () => { S.levels[S.weapon]++; refreshWeaponButtons(); } },
  { icon: '◈', title: '偏折護盾', desc: '抵擋接下來 2 次撞擊', apply: () => { S.deflect += 2; } },
  { icon: '◆', title: '資源艙', desc: '+250 點數（可在整備時升級）', apply: () => { S.credits += 250; } },
  { icon: '»', title: '超載起步', desc: '下一波開場直接超光速，加速上限 +1', apply: () => { S.overdrive = true; S.boostMax++; } },
  { icon: '≋', title: '能量電容', desc: '光束能量回復速度 +50%', apply: () => { S.energyRegen *= 1.5; } },
  { icon: '➶', title: '飛彈艙擴充', desc: '飛彈上限 +2，立刻補滿', apply: () => { S.missileMax += 2; S.missiles = S.missileMax; } },
];
function showChoice() {
  const pool = CARDS.filter((c) => !c.ok || c.ok());
  const chosen = [];
  while (chosen.length < 3 && pool.length) chosen.push(pool.splice((Math.random() * pool.length) | 0, 1)[0]);
  const box = $('cards');
  box.innerHTML = '';
  for (const c of chosen) {
    const b = document.createElement('button');
    b.className = 'card';
    b.innerHTML = `<div class="ic">${c.icon}</div><h3>${c.title}</h3><p>${c.desc}</p>`;
    b.onclick = () => { c.apply(); sfx.pick(); $('choice').classList.add('hidden'); closeGate(); };
    box.appendChild(b);
  }
  $('choice').classList.remove('hidden');
}

/* ================= BOSS ================= */
function createBoss() {
  const g = new THREE.Group();
  const sprite = artSprite(ART.boss, BOSS_W, 765, 465);
  g.add(sprite);
  const at = sprite.userData.at;
  // 核心：多層光暈，依狀態變色
  const coreGlow = glowSprite(0xff2a2a, 7, 2.2);
  const coreHot = glowSprite(0xffe0d0, 2.6, 3.5);
  coreGlow.position.copy(at(765, 462, 0.3));
  coreHot.position.copy(at(765, 462, 0.35));
  g.add(coreGlow, coreHot);
  // 兩道會轉動的能量環（設定圖上的同心圓）
  const ringMat = additive(0xff3a3a, 0.9, { side: THREE.DoubleSide }, 3);
  const ringA = new THREE.Mesh(new THREE.RingGeometry(3.55 * BK, 3.72 * BK, 96, 1, 0, TAU * 0.82), ringMat);
  const ringB = new THREE.Mesh(new THREE.RingGeometry(5.45 * BK, 5.62 * BK, 128, 1, 0, TAU * 0.9), ringMat);
  ringA.position.copy(at(765, 462, 0.25)); ringB.position.copy(ringA.position);
  g.add(ringA, ringB);
  // 塔頂閃爍的紅燈
  const beacons = [[765, 92], [1205, 268], [330, 350], [1240, 640], [470, 760], [1000, 160], [520, 160], [905, 840]].map(([px, py], i) => {
    const s = glowSprite(0xff3030, 1.3, 3);
    s.position.copy(at(px, py, 0.2));
    s.userData.phase = i * 0.7;
    g.add(s);
    return s;
  });
  const shieldMat = additive(0x66ddff, 0.08, { wireframe: true }, 1.2);
  const shield = new THREE.Mesh(new THREE.IcosahedronGeometry(BOSS_SHIELD_R, 2), shieldMat);
  const shellMat = shieldMaterial(0x3aa8ff);
  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(BOSS_SHIELD_R - 0.1, 3), shellMat);
  shield.position.copy(ringA.position); shell.position.copy(ringA.position);
  g.add(shield, shell);
  scene.add(g);
  const hpMax = 420 * (1 + 0.4 * (S.round - 1));
  return {
    mesh: g, sprite, coreGlow, coreHot, ringA, ringB, ringMat, beacons, shield, shieldMat, shell, shellMat,
    x: 0, y: 0, z: -380, r: BOSS_R, shieldR: BOSS_SHIELD_R, hp: hpMax, hpMax, shieldUp: true, shieldScale: 1,
    state: null, lastState: null, stateT: 0, fireT: 2.5, pattern: 0, mx: 0, t: 0, rot: 0,
    entering: true, hackCd: 0, flash: 0, shieldFlash: 0,
  };
}
function setBossColor(b, hex) {
  b.coreGlow.material.color.setHex(hex).multiplyScalar(2.6);
  b.ringMat.color.setHex(hex).multiplyScalar(3);
}
function startBoss() {
  S.phase = 'bossIntro';
  boss = createBoss();
  place(boss);
  $('bossbar').classList.remove('hidden');
  banner('⚠ WARNING ⚠', '母艦 NEMESIS 接近', true, 3000);
  comm('是母艦 NEMESIS……它的護盾我得先駭進去。準備好就按 HACK！', 4500);
  sfx.warn();
}
function dropShield(bonus) {
  const b = boss;
  b.shieldUp = false;
  const keys = Object.keys(BOSS_STATES).filter((k) => k !== b.lastState);
  b.state = b.lastState = pick(keys);
  b.stateT = 10 + bonus * 2;
  const st = BOSS_STATES[b.state];
  setBossColor(b, st.color);
  banner(`護盾破除 · ${st.label}`, `弱點：${weakLabel(st.weak)}`, false, 2600);
  comm(`護盾破了！它切換成「${st.label}」——${st.hint}。`, 4000);
  flash(0.5);
  if (b.state === 'SWARM') {
    for (let i = 0; i < 6; i++) spawnDrone({ mode: 'orbit', a: (i / 6) * TAU, x: b.x, y: b.y, z: b.z + 6, hp: 3 + S.round });
  }
  refreshWeaponButtons();
}
function raiseShield() {
  const b = boss;
  b.shieldUp = true;
  b.state = null;
  setBossColor(b, 0xff2a2a);
  for (let i = drones.length - 1; i >= 0; i--) if (drones[i].mode === 'orbit') removeAt(drones, i);
  banner('護盾重新展開', '再次破解！');
  comm('護盾又張開了，再駭一次！', 2600);
  sfx.shield();
  refreshWeaponButtons();
}
function startBossHack() {
  if (!boss || S.phase !== 'boss' || !boss.shieldUp || S.hacking || boss.hackCd > 0 || S.paused) return;
  S.hacking = true;
  S.tsTarget = 0.2;                 // 破解時世界進入慢動作，但敵彈仍在飛
  hack.start({
    n: S.round >= 2 ? 6 : 5, time: 9, title: '護盾破解',
    info: '世界進入慢動作 · 畫出路徑連到終點，◆ 會延長破盾時間',
    onDone: (ok, bonus) => {
      S.hacking = false;
      S.tsTarget = 1;
      if (!boss || S.phase !== 'boss') return;
      if (ok) { dropShield(bonus); sfx.ok(); }
      else {
        sfx.fail();
        boss.hackCd = 2.5;
        toast('破解失敗！護盾反擊', 'bad');
        comm('嘖，被反追蹤了……再試一次。', 2600);
        hurt(8);
      }
    },
  });
}
function damageBoss(dmg, w) {
  const b = boss;
  if (!b || b.entering || S.phase !== 'boss') return;
  if (b.shieldUp) { b.shieldFlash = 0.5; sfx.shield(); toast('護盾擋下了 — 先破解！', 'dim', 2.5); return; }
  const weak = BOSS_STATES[b.state].weak === w;
  const mult = weak ? 3 : 0.35;
  b.hp -= dmg * mult;
  b.flash = weak ? 0.15 : 0.05;
  addScore(Math.round(dmg * mult * 5));
  if (weak) toast('弱點命中 ×3', 'weak', 0.9);
  else toast('效果不佳 — 換弱點武器', 'dim', 2.5);
  if (b.hp <= 0) defeatBoss();
}
function defeatBoss() {
  S.phase = 'bossDown';
  S.phaseT = 2.2;
  boss.hp = 0;
  S.kills++; S.roundKills++;
  addScore(5000 * S.round);
  S.credits += 300;
  while (drones.length) removeAt(drones, drones.length - 1);
  while (eshots.length) removeAt(eshots, eshots.length - 1);
  $('btnHack').classList.add('hidden');
  banner('NEMESIS DOWN', '母艦擊沉！');
  comm('漂亮！母艦擊沉。我就知道你做得到。', 3500);
  sfx.boom(true);
  vibrate([80, 40, 120]);
}
function bossFire(b) {
  const hpR = b.hp / b.hpMax;
  b.fireT = lerp(0.9, 1.7, hpR) * (b.state === 'CORE' ? 0.8 : 1);
  b.pattern++;
  const spawn = (vx, vy, vz) => {
    const mesh = new THREE.Mesh(eshotGeo, eshotMat);
    scene.add(mesh);
    const e = { mesh, x: b.x, y: b.y, z: b.z + 4, prevZ: b.z + 4, vx, vy, vz };
    place(e);
    eshots.push(e);
  };
  if (b.pattern % 3 === 0) {
    // 環形彈：圍住你目前的位置，要往縫隙鑽
    const vz = 28, t = (-(b.z + 4)) / vz, R = rand(2.6, 4.5), n = 9, off = rand(0, TAU);
    const cx = (ship.x - b.x) / t, cy = (ship.y - b.y) / t;
    spawn(cx, cy, vz);
    for (let i = 0; i < n; i++) {
      const a = off + (i / n) * TAU;
      spawn(cx + (Math.cos(a) * R) / t, cy + (Math.sin(a) * R) / t, vz);
    }
  } else {
    const vz = 36, t = (-(b.z + 4)) / vz;
    for (let k = -1; k <= 1; k++) spawn((ship.x + k * 2.2 - b.x) / t, (ship.y - b.y) / t, vz);
  }
}
function updateBoss(dt, rawDt) {
  const b = boss;
  b.t += dt;
  if (b.entering) {
    b.z = lerp(b.z, BOSS_Z, damp(1.1, dt));
    if (b.z > BOSS_Z - 4) { b.entering = false; S.phase = 'boss'; banner('破解護盾！', '按下 HACK（或 H 鍵）開始破解'); }
  }
  const fast = b.state === 'CORE';
  b.mx += dt * (fast ? 1.6 : 0.55);
  b.x = Math.sin(b.mx) * (fast ? 5.5 : 3.2);
  b.y = BOSS_Y + Math.sin(b.mx * 1.37 + 1) * (fast ? 2.6 : 1.4);
  b.ringA.rotation.z += dt * 0.7;
  b.ringB.rotation.z -= dt * 0.45;
  b.rot = S.phase === 'bossDown' ? b.rot + rawDt * 0.8 : Math.sin(b.t * 0.4) * 0.06;
  b.mesh.rotation.z = b.rot;
  b.sprite.material.rotation = b.rot;
  const pulse = 1 + Math.sin(b.t * 5) * 0.12;
  b.coreGlow.scale.setScalar(7 * BK * pulse * (b.shieldUp ? 1 : 1.25));
  b.coreHot.scale.setScalar(2.6 * BK * pulse + b.flash * 12);
  for (const s of b.beacons) s.scale.setScalar(Math.sin(S.time * 4 + s.userData.phase) > 0.3 ? 1.3 : 0.4);
  b.shieldScale = lerp(b.shieldScale, b.shieldUp ? 1 : 0.01, damp(6, rawDt));
  b.shield.scale.setScalar(b.shieldScale);
  b.shell.scale.setScalar(b.shieldScale);
  b.shield.rotation.y += dt * 0.3;
  b.shieldFlash = Math.max(0, b.shieldFlash - rawDt * 2);
  b.shieldMat.opacity = 0.08 + b.shieldFlash * 0.6;
  b.shellMat.uniforms.uFlash.value = b.shieldFlash;
  b.shellMat.uniforms.uTime.value = S.time;
  b.flash = Math.max(0, b.flash - rawDt);
  b.sprite.material.color.setScalar(1 + b.flash * 6);
  b.sprite.material.opacity = clamp((b.z + 380) / 150, 0, 1);
  b.hackCd -= rawDt;

  if (S.phase === 'boss') {
    if (!b.shieldUp) {
      b.stateT -= dt;
      if (b.state === 'REGEN') b.hp = Math.min(b.hpMax, b.hp + b.hpMax * 0.007 * dt);
      if (b.stateT <= 0) raiseShield();
    }
    b.fireT -= dt;
    if (b.fireT <= 0) bossFire(b);
  }
  if (S.phase === 'bossDown') {
    if (Math.random() < rawDt * 12) {
      spawnExplosion(b.x + rand(-9, 9), b.y + rand(-6, 6), b.z + rand(-2, 3), pick([0xff8a40, 0xff5c7c, 0xffd0a0]), 0.9, true);
      sfx.boom(true);
      S.shake = Math.max(S.shake, 0.4);
    }
  }
  place(b);
}

function droneShoot(d, vz = 34) {
  const t = -d.z / vz;
  const mesh = new THREE.Mesh(eshotGeo, eshotMat);
  mesh.scale.setScalar(0.7);
  scene.add(mesh);
  eshots.push({ mesh, x: d.x, y: d.y, z: d.z, prevZ: d.z, vx: (ship.x - d.x) / t, vy: (ship.y - d.y) / t, vz });
}
function updateDrones(dt, speed) {
  for (let i = drones.length - 1; i >= 0; i--) {
    const d = drones[i];
    d.t += dt;
    if (d.mode === 'orbit') {
      if (!boss) { removeAt(drones, i); continue; }
      d.a += dt * 1.1;
      d.x = boss.x + Math.cos(d.a) * 13;
      d.y = boss.y + Math.sin(d.a) * 7.5 - 1;
      d.z = boss.z + 6;
      d.fireT -= dt;
      if (d.fireT <= 0) { d.fireT = rand(1.8, 3.2); droneShoot(d, 40); }
    } else {
      if (d.state === 'in') {
        d.z = lerp(d.z, d.hoverZ, damp(1.6, dt));
        d.x = lerp(d.x, d.tx, damp(1.8, dt)); d.y = lerp(d.y, d.ty, damp(1.8, dt));
        if (d.z > d.hoverZ - 3) d.state = 'hover';
      } else if (d.state === 'hover') {
        d.x = lerp(d.x, d.tx + Math.sin(d.t * 1.3 + d.off) * 2.2, damp(3, dt));
        d.y = lerp(d.y, d.ty + Math.cos(d.t * 1.1 + d.off) * 1.2, damp(3, dt));
        d.fireT -= dt;
        if (d.fireT <= 0 && !d.tut) { d.fireT = rand(1.6, 2.8) / (1 + 0.15 * (S.round - 1)); droneShoot(d); }
        if (d.t > d.life) { d.state = 'dive'; d.dx = ship.x; d.dy = ship.y; }
      } else {
        // 俯衝：朝玩家當時的位置衝過來，可以閃也可以打掉
        d.z += (speed * 0.5 + 40) * dt;
        d.x = lerp(d.x, d.dx, damp(1.2, dt)); d.y = lerp(d.y, d.dy, damp(1.2, dt));
        if (d.z > -1.2 && d.z < 1.2 && S.phase !== 'dead' && Math.hypot(d.x - ship.x, d.y - ship.y) < d.r + 0.4) {
          if (S.warp > 0 || S.dash > 0) { damageDrone(i, 999); continue; }
          hurt(15, d.x, d.y);
          spawnExplosion(d.x, d.y, d.z, 0xff4a3a, 0.75);
          removeAt(drones, i);
          continue;
        }
        if (d.z > 14) { removeAt(drones, i); continue; }
      }
    }
    // 動畫：自轉＋朝向玩家微傾、眼睛與推進器閃爍、被打中時放大抖一下
    const m = d.model;
    m.g.rotation.z += d.spin * dt;
    m.g.rotation.x = clamp((ship.y - d.y) * 0.04, -0.4, 0.4);
    m.g.rotation.y = clamp((d.x - ship.x) * -0.04, -0.4, 0.4);
    d.flash = Math.max(0, d.flash - dt);
    m.g.scale.setScalar(DRONE_SCALE * (1 + d.flash * 2));
    m.eye.scale.setScalar(1.0 + Math.sin(S.time * 8 + d.off) * 0.25 + d.flash * 4);
    for (const j of m.jets) j.scale.setScalar(0.5 + Math.random() * 0.2);
    place(d);
  }
}

/* ================= 結算 / 整備 / 排行 ================= */
function finishBoss() {
  spawnExplosion(boss.x, boss.y, boss.z, 0xffc080, 2.6, true);
  flash(1);
  scene.remove(boss.mesh);
  boss = null;
  $('bossbar').classList.add('hidden');
  S.roundsCleared++;
  showResult();
}
function showResult() {
  S.phase = 'result';
  const flawless = S.roundDmg === 0;
  const timeBonus = Math.max(0, Math.round(4000 - S.roundTime * 15));
  const flawBonus = flawless ? 5000 : 0;
  addScore(timeBonus + flawBonus);
  Records.addClear({ name: pilotName(), time: S.roundTime, round: S.round, kills: S.roundKills, flawless, date: Date.now() });
  $('resultBody').innerHTML = `
    <h2>ROUND ${S.round} CLEAR</h2>
    <div class="stats">
      <span>通關時間</span><b>${fmtTime(S.roundTime)}</b>
      <span>本輪擊落</span><b>${S.roundKills}</b>
      <span>受到傷害</span><b>${Math.round(S.roundDmg)}</b>
      <span class="bonus">時間獎勵</span><b class="bonus">+${timeBonus}</b>
      <span class="bonus">無損獎勵</span><b class="bonus">${flawless ? '+' + flawBonus : '—'}</b>
    </div>
    <div class="big-score">${Math.floor(S.score)}</div>
    <button class="btn primary" id="btnToShop">前往整備</button>`;
  $('result').classList.remove('hidden');
  $('btnToShop').onclick = () => { sfx.ui(); $('result').classList.add('hidden'); showShop(); };
  showHUD(false);
}

const WEAPON_COST = [0, 250, 500];
function showShop() {
  S.phase = 'shop';
  const items = [
    ...WEAPON_KEYS.map((k) => ({
      label: `${WEAPONS[k].name} ${WEAPONS[k].zh}`, sub: S.levels[k] >= 3 ? '已滿級' : `LV${S.levels[k]} → LV${S.levels[k] + 1}${k === 'missile' ? '（上限 +2）' : ''}`,
      cost: WEAPON_COST[S.levels[k]] ?? 0, can: S.levels[k] < 3, buy: () => { S.levels[k]++; if (k === 'missile') S.missileMax += 2; },
    })),
    { label: '船體強化', sub: `最大耐久 ${S.hullMax} → ${S.hullMax + 25}`, cost: 300, can: true, buy: () => { S.hullMax += 25; S.hull += 25; } },
    { label: '加速艙擴充', sub: `加速上限 ${S.boostMax} → ${S.boostMax + 1}`, cost: 350, can: S.boostMax < 6, buy: () => { S.boostMax++; } },
    { label: '完全修復', sub: `船體 ${Math.round(S.hull)} / ${S.hullMax}`, cost: 120, can: S.hull < S.hullMax, buy: () => { S.hull = S.hullMax; } },
    { label: '加速核心', sub: `目前 ${S.boost} / ${S.boostMax}`, cost: 150, can: S.boost < S.boostMax, buy: () => { S.boost++; } },
  ];
  $('shopBody').innerHTML = `<h2>整備艙</h2><div class="credits">◆ ${S.credits}</div><div class="shop-list"></div>
    <div class="btn-row"><button class="btn" id="btnEndRun">結束航程（記錄成績）</button><button class="btn primary" id="btnNext">出發 ROUND ${S.round + 1}</button></div>`;
  const list = $('shopBody').querySelector('.shop-list');
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'shop-item';
    row.innerHTML = `<div>${it.label}<small>${it.sub}</small></div>`;
    const b = document.createElement('button');
    b.textContent = it.can ? `◆ ${it.cost}` : '—';
    b.disabled = !it.can || S.credits < it.cost;
    b.onclick = () => { S.credits -= it.cost; it.buy(); sfx.pick(); showShop(); };
    row.appendChild(b);
    list.appendChild(row);
  }
  $('shop').classList.remove('hidden');
  $('btnNext').onclick = () => {
    sfx.ui();
    $('shop').classList.add('hidden');
    showHUD(true);
    refreshWeaponButtons();
    S.round++;
    startRound();
  };
  $('btnEndRun').onclick = () => { $('shop').classList.add('hidden'); endRun(false); };
}

function die() {
  S.phase = 'dead';
  S.phaseT = 1.8;
  if (S.hacking) { hack.abort(); S.hacking = false; }
  $('choice').classList.add('hidden');
  S.tsTarget = 0.35;
  spawnExplosion(ship.x, ship.y, 0, 0x66ddff, 1.4);
  spawnBurst(ship.x, ship.y, 0, 0xffaa55, 40, 10, 1.2, 1.2);
  shipModel.group.visible = false;
  laserHide();
  clearLocks();
  sfx.boom(true);
  vibrate([120, 60, 200]);
}
function endRun(dead) {
  S.phase = 'over';
  S.tsTarget = 1;
  showHUD(false);
  $('bossbar').classList.add('hidden');
  const rank = Records.addRun({ name: pilotName(), score: Math.floor(S.score), kills: S.kills, rounds: S.roundsCleared, date: Date.now() });
  $('overBody').innerHTML = `
    <h2>${dead ? 'SHIP DESTROYED' : 'MISSION END'}</h2>
    <div class="big-score">${Math.floor(S.score)}</div>
    <div class="stats">
      <span>通關輪數</span><b>${S.roundsCleared}</b>
      <span>總擊落</span><b>${S.kills}</b>
      <span>本機排名</span><b>#${rank}</b>
    </div>
    <div class="btn-row"><button class="btn" id="btnOverBoard">排行榜</button><button class="btn primary" id="btnRetry">再戰一次</button></div>
    <button class="btn" id="btnToTitle">回標題</button>`;
  $('over').classList.remove('hidden');
  $('btnRetry').onclick = () => { $('over').classList.add('hidden'); startGame(); };
  $('btnOverBoard').onclick = () => openBoard('score');
  $('btnToTitle').onclick = toTitle;
}
function toTitle() {
  clearWorld();
  S = freshState();
  hideOverlays();
  showHUD(false);
  $('bossbar').classList.add('hidden');
  shipModel.group.visible = true;
  setPalette(0);
  $('title').classList.remove('hidden');
}

function pilotName() { return ($('pilot').value.trim() || 'PILOT').slice(0, 12); }
function openBoard(cat) {
  $('board').classList.remove('hidden');
  for (const b of $('boardTabs').children) b.classList.toggle('on', b.dataset.cat === cat);
  const list = Records.board(cat);
  const el = $('boardList');
  if (!list.length) { el.innerHTML = '<li class="empty">還沒有紀錄，快去飛一趟！</li>'; return; }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  el.innerHTML = list.map((r, i) => {
    const v = cat === 'score' ? r.score : cat === 'kills' ? r.kills + ' 擊落' : fmtTime(r.time);
    const meta = cat === 'score' || cat === 'kills' ? `${r.rounds} 輪` : `R${r.round}${r.flawless ? ' · 無損' : ''}`;
    return `<li><span class="rk">${i + 1}</span><span>${esc(r.name)}</span><span class="meta">${meta}</span><span class="v">${v}</span></li>`;
  }).join('');
}

function togglePause(force) {
  const live = ['wave', 'gateApproach', 'bossIntro', 'boss', 'bossDown', 'tutorial'].includes(S.phase);
  if (!live || S.hacking) return;
  S.paused = force ?? !S.paused;
  $('pause').classList.toggle('hidden', !S.paused);
}

/* ================= 立繪劇情（新手開場） ================= */
const STORY = [
  { t: '……訊號接通。\n你就是新來的指揮官？' },
  { t: '我是你的領航員，代號 QUEEN。\n白天是普通高中生——這個你不用記。' },
  { t: '有什麼問題嗎？', choices: [
    { label: '「請多指教，女王。」', reply: '嗯，態度不錯。\n我們應該會合得來。' },
    { label: '「……高中生？」', reply: '就說了不用記。\n第三節是數學小考，我們十五分鐘內解決。' },
  ] },
  { t: '你的機體會變形：巡航、懸停、重裝。\n三種形態，三種打法。' },
  { t: '蟲洞另一端有東西在等我們。\n先熱身——跟著我的訊號飛。' },
];
let storyIdx = 0, storyDone = null, storyTimer = 0, storyFull = '', storyShown = 0, storyReply = false;
function playStory(onDone) {
  storyDone = onDone;
  storyIdx = 0;
  hideOverlays();
  $('story').classList.remove('hidden');
  showStoryLine(STORY[0].t);
}
function showStoryLine(text) {
  const line = STORY[storyIdx];
  storyFull = text;
  storyShown = 0;
  $('stText').textContent = '';
  clearInterval(storyTimer);
  // 打字機效果，點一下直接顯示全文
  storyTimer = setInterval(() => {
    storyShown++;
    $('stText').textContent = storyFull.slice(0, storyShown);
    if (storyShown % 2 === 0) sfx.step();
    if (storyShown >= storyFull.length) { clearInterval(storyTimer); showChoices(line); }
  }, 32);
  $('stChoices').innerHTML = '';
  $('story').querySelector('.st-char').style.transform = `translateY(${storyIdx % 2 ? 4 : 0}px)`;
}
function showChoices(line) {
  const box = $('stChoices');
  box.innerHTML = '';
  if (!line.choices || storyReply) return;
  for (const c of line.choices) {
    const b = document.createElement('button');
    b.textContent = c.label;
    b.onclick = (e) => { e.stopPropagation(); sfx.ui(); storyReply = true; box.innerHTML = ''; showStoryLine(c.reply); };
    box.appendChild(b);
  }
}
function advanceStory() {
  if (storyShown < storyFull.length) { clearInterval(storyTimer); storyShown = storyFull.length; $('stText').textContent = storyFull; showChoices(STORY[storyIdx]); return; }
  if (STORY[storyIdx].choices && !storyReply) return;   // 要先選
  storyReply = false;
  storyIdx++;
  if (storyIdx >= STORY.length) return endStory();
  sfx.ui();
  showStoryLine(STORY[storyIdx].t);
}
function endStory() {
  clearInterval(storyTimer);
  $('story').classList.add('hidden');
  storyDone?.();
}
$('stBox').addEventListener('click', advanceStory);
$('stSkip').addEventListener('click', endStory);

/* ================= 新手教學：飛行 → 射擊 → 變形 → 飛彈 → 破解 → 躍遷 ================= */
const TUT_STEPS = [
  { id: 'fly', step: 'TRAINING 1 / 4 · 飛行', main: () => input.gyro ? '傾斜手機，穿過金色光環' : '移動滑鼠（或 WASD），穿過金色光環', need: 5, hide: ['modes', 'missile', 'fold'],
    say: '不用握很緊，像拿杯珍奶那樣輕輕斜過去就好。' },
  { id: 'shoot', step: 'TRAINING 2 / 4 · 射擊', main: () => '武器會自動開火——對準敵機', need: 3, hide: ['modes', 'missile', 'fold'],
    say: '你只要負責瞄準，扣扳機這種小事交給我。' },
  { id: 'mode', step: 'TRAINING 2 / 4 · 變形', main: () => '點右側「HOVER 懸停」變形', sub: '擴散彈一次打一整排', need: 5, hide: ['missile', 'fold'], spot: 'mode-hover',
    say: '敵人排成一排的時候，用懸停形態的擴散彈。' },
  { id: 'missile', step: 'TRAINING 3 / 4 · 飛彈', main: () => '按住 MISSILE 鎖定，放開發射', sub: '鎖越多，飛彈越多', need: 6, hide: ['fold'], spot: 'missile',
    say: '按住不放，讓準星一個一個咬上去——然後放手。' },
  { id: 'hack', step: 'TRAINING 4 / 4 · 破解', main: () => '從起點畫到 ◎', sub: '經過 ◆ 有額外獎勵', hide: ['fold'],
    say: '這是我的專長。不過今天換你的手指來。' },
  { id: 'fold', step: 'TRAINING 4 / 4 · 躍遷', main: () => '按 FOLD 摺疊躍遷！', sub: '躍遷中無敵，直接撞碎障礙', hide: [], spot: 'fold',
    say: '破解成功，拿到一顆躍遷核心。用掉它！' },
];
function startTutorial() {
  initAudio();
  clearWorld();
  S = freshState();
  S.phase = 'tutorial';
  hideOverlays();
  showHUD(true);
  shipModel.group.visible = true;
  shipModel.setMode('cruise', MODES.cruise.color);
  refreshWeaponButtons();
  input.calibrated = false;
  input.offX = input.offY = 0;
  setPalette(0);
  $('tutTip').classList.remove('hidden');
  $('btnSkipTut').classList.remove('hidden');
  tutEnter(0);
}
function tutEnter(i) {
  const st = TUT_STEPS[i];
  S.tut = { i, count: 0, t: 0, done: false, ringT: 0, side: 1 };
  const hud = $('hud');
  for (const k of ['modes', 'missile', 'fold']) hud.classList.toggle('tut-hide-' + k, st.hide.includes(k));
  hud.classList.add('tut-hide-top');
  document.querySelectorAll('.spot').forEach((e) => e.classList.remove('spot'));
  if (st.spot === 'mode-hover') modesEl.querySelector('[data-m="hover"]').classList.add('spot');
  if (st.spot === 'missile') $('btnMissile').classList.add('spot');
  if (st.spot === 'fold') $('btnBoost').classList.add('spot');
  $('tutStep').textContent = st.step;
  $('tutMain').textContent = st.main();
  $('tutMain').classList.remove('done');
  tutSub();
  comm(st.say, 4200);
  if (st.id === 'shoot') spawnTutDrones(3, 'line');
  if (st.id === 'mode') spawnTutDrones(5, 'line');
  if (st.id === 'missile') { S.missiles = S.missileMax; spawnTutDrones(6, 'arc'); }
  if (st.id === 'hack') {
    S.hacking = true;
    S.tsTarget = 0.25;
    hack.start({ n: 4, time: 30, title: '破解練習', info: '用手指從起點畫到 ◎',
      onDone: (ok) => {
        S.hacking = false; S.tsTarget = 1;
        if (S.phase !== 'tutorial') return;
        if (ok) { sfx.ok(); addBoost(1); tutStepDone(); }
        else { comm('沒關係，再來一次。', 2000); setTimeout(() => S.phase === 'tutorial' && tutEnter(4), 600); }
      } });
  }
}
function tutSub() {
  const st = TUT_STEPS[S.tut.i];
  const prog = st.need ? `${Math.min(S.tut.count, st.need)} / ${st.need}` : '';
  $('tutSub').textContent = [st.sub, prog].filter(Boolean).join('　·　');
}
function spawnTutDrones(n, shape) {
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0 : i / (n - 1) - 0.5;
    const tx = u * (shape === 'arc' ? 12 : 9), ty = shape === 'arc' ? 2.5 - (0.25 - u * u) * 6 : 1.8;
    spawnDrone({ mode: 'fighter', x: tx * 0.3, y: ty + 3, z: SPAWN_Z * 0.5 - i * 4, tx, ty, hoverZ: -30, life: 1e9, fireT: 1e9, state: 'in', tut: true, hp: 2.5 });
  }
}
function tutStepDone() {
  if (S.tut.done) return;
  S.tut.done = true;
  S.tut.t = 0;
  $('tutMain').textContent = pick(['漂亮！', '很好！', '完美！']);
  $('tutMain').classList.add('done');
  sfx.ok();
  vibrate(30);
}
function tutorialEvent(type, arg) {
  if (S.phase !== 'tutorial' || !S.tut || S.tut.done) return;
  const id = TUT_STEPS[S.tut.i].id;
  if (id === 'fly' && type === 'ring') S.tut.count++;
  if ((id === 'shoot' || id === 'mode' || id === 'missile') && type === 'kill') S.tut.count++;
  if (id === 'mode' && type === 'mode' && arg === 'hover') { $('tutMain').textContent = '擊落整排敵機'; document.querySelectorAll('.spot').forEach((e) => e.classList.remove('spot')); }
  if (id === 'missile' && type === 'missile') S.tut.fired = true;
  if (id === 'fold' && type === 'fold') return tutStepDone();
  tutSub();
  const st = TUT_STEPS[S.tut.i];
  if (st.need && S.tut.count >= st.need) tutStepDone();
}
function tutUpdate(dt) {
  const t = S.tut;
  t.t += dt;
  const id = TUT_STEPS[t.i].id;
  if (t.done) {
    if (t.t > 1.3) {
      if (t.i + 1 < TUT_STEPS.length) tutEnter(t.i + 1);
      else finishTutorial(false);
    }
    return;
  }
  // 飛行：左右交替送光環過來
  if (id === 'fly') {
    t.ringT -= dt;
    if (t.ringT <= 0 && rings.length < 2) { t.ringT = 1.6; t.side *= -1; spawnRingAt(t.side * rand(2.5, 4.5), rand(-1.5, 2.5), SPAWN_Z * 0.55); }
  }
  // 射擊／變形／飛彈：敵機打完但還沒達標就補
  if ((id === 'shoot' || id === 'mode' || id === 'missile') && drones.length === 0) {
    spawnTutDrones(id === 'missile' ? 6 : id === 'mode' ? 5 : 3, id === 'missile' ? 'arc' : 'line');
  }
  if (id === 'missile' && S.missiles < S.missileMax) S.missiles = Math.min(S.missileMax, S.missiles + dt * 2);
}
function finishTutorial(skipped) {
  prefs.tutorialDone = true;
  Prefs.save(prefs);
  $('tutTip').classList.add('hidden');
  $('btnSkipTut').classList.add('hidden');
  document.querySelectorAll('.spot').forEach((e) => e.classList.remove('spot'));
  $('hud').classList.remove('tut-hide-modes', 'tut-hide-missile', 'tut-hide-fold', 'tut-hide-top');
  if (hack.active) { hack.abort(); S.hacking = false; }
  if (!skipped) comm('訓練完成。好了，正式出擊——別讓我遲到。', 3500);
  startGame(true);
}
$('btnSkipTut').addEventListener('click', () => finishTutorial(true));

/* ================= 主更新 ================= */
const hack = new HackGame($('hack'), sfx);
let last = performance.now();

function update(rawDt) {
  S.time += rawDt;
  S.timeScale = lerp(S.timeScale, S.tsTarget, damp(8, rawDt));
  const dt = rawDt * S.timeScale;
  hack.update(rawDt);

  const live = ['wave', 'gateApproach', 'gate', 'bossIntro', 'boss', 'bossDown'].includes(S.phase);
  const combat = ['wave', 'gateApproach', 'bossIntro', 'boss'].includes(S.phase);

  // 速度與超光速
  S.warp = Math.max(0, S.warp - dt);
  const warpOn = S.warp > 0;
  S.speedMul = lerp(S.speedMul, warpOn ? 3.4 : 1, damp(warpOn ? 7 : 2.2, rawDt));
  const speed = BASE_SPEED * (1 + 0.1 * (S.round - 1)) * S.speedMul * (S.phase === 'title' ? 0.6 : 1);
  S.travel += speed * dt;
  if (live) S.roundTime += dt;
  if (combat && S.phase !== 'gateApproach') addScore(speed * dt * 0.05);

  bend.set(Math.sin(S.time * 0.13) * 38, Math.sin(S.time * 0.17 + 1) * 28);
  tunnelUniforms.uTime.value = S.time;
  // 母艦出現時，蟲洞擴張成巨大的空間（不然母艦會被隧道壁切掉）
  const arenaT = ['bossIntro', 'boss', 'bossDown'].includes(S.phase) ? 1 : 0;
  S.arena = lerp(S.arena || 0, arenaT, damp(0.8, rawDt));
  tunnel.scale.set(1 + S.arena * 1.6, 1 + S.arena * 1.6, 1);
  tunnelUniforms.uDim.value = 1 - S.arena * 0.5;
  tunnelUniforms.uTravel.value = S.travel;
  tunnelUniforms.uWarp.value = clamp((S.speedMul - 1) / 2.4, 0, 1);
  S.hitFlash = Math.max(0, S.hitFlash - rawDt * 2.5);
  tunnelUniforms.uHit.value = S.hitFlash;

  // 光速流線
  const sLen = clamp(speed * 0.05, 1, 4) * (1 + tunnelUniforms.uWarp.value * 3);
  for (let i = 0; i < STREAKS; i++) {
    const s = streaks[i];
    s.z += speed * dt * 1.3;
    if (s.z > 15) { s.z -= 345; s.a = rand(0, TAU); }
    const b = bendAt(s.z);
    const sr = s.r * (1 + (S.arena || 0) * 1.6);
    dummy.position.set(Math.cos(s.a) * sr + b.x, Math.sin(s.a) * sr + b.y, s.z);
    dummy.scale.set(1, 1, sLen);
    dummy.updateMatrix();
    streakMesh.setMatrixAt(i, dummy.matrix);
  }
  streakMesh.instanceMatrix.needsUpdate = true;

  // 飛船（用真實時間移動，所以慢動作時還是能靈活閃避）
  let tx, ty;
  if (S.phase === 'title') { tx = Math.sin(S.time * 0.7) * 3; ty = Math.sin(S.time * 1.1) * 1.8; }
  else [tx, ty] = targetXY(rawDt);
  const stiff = S.dash > 0 ? 16 : MODES[S.mode].stiff;
  const rd = Math.max(rawDt, 1e-4);
  const nx = lerp(ship.x, tx, damp(stiff, rd)), ny = lerp(ship.y, ty, damp(stiff, rd));
  ship.vx = (nx - ship.x) / rd; ship.vy = (ny - ship.y) / rd;
  ship.x = nx; ship.y = ny;
  S.dash = Math.max(0, S.dash - rawDt);
  S.invuln = Math.max(0, S.invuln - rawDt);
  ship.zOff = lerp(ship.zOff, 0, damp(2.5, rawDt));
  const sm = shipModel;
  sm.group.position.set(ship.x, ship.y, ship.zOff);
  const spin = S.dash > 0 ? -S.dashDir * (1 - S.dash / 0.38) * TAU : 0;
  // 3D 機身：轉彎明顯側傾、上下俯仰、翻滾閃避整架轉一圈
  sm.group.rotation.set(clamp(ship.vy * 0.025, -0.45, 0.45), clamp(-ship.vx * 0.012, -0.3, 0.3), clamp(-ship.vx * 0.065, -1.0, 1.0) + spin);
  sm.animate(rawDt, 1 + (S.speedMul - 1) * 0.35);
  sm.bubble.visible = S.deflect > 0 || warpOn;
  sm.bubble.rotation.y += rawDt * 2;
  if (S.phase !== 'dead' && S.phase !== 'over') sm.group.visible = S.invuln > 0 ? Math.floor(S.time * 20) % 2 === 0 : true;
  shipLight.position.set(ship.x, ship.y + 2.5, 3);

  // 能量自然回復
  if (S.weapon !== 'laser' || S.laserLock || !(combat || S.phase === 'tutorial')) S.energy = Math.min(100, S.energy + S.energyRegen * dt);

  if (S.phase === 'wave') {
    spawning(dt, speed);
    if (S.waveDist >= S.waveLen) endWave();
  }
  if (S.phase === 'boss' && Math.random() < dt * 0.6) spawnRock(false);   // BOSS 戰偶爾飄來隕石
  if (gate) {
    gate.z += speed * dt;
    gate.ring2.rotation.z += dt * 1.5;
    place(gate);
    if (gate.z > -1) { scene.remove(gate.mesh); const t = gate.type; gate = null; openGate(t); }
  }

  if ((combat || S.phase === 'tutorial') && !S.hacking) fireWeapon(dt, speed); else laserHide();
  if (!canAct() && S.locking) clearLocks();
  updateLocking(rawDt);
  updateReticles();
  updateMissiles(dt, speed);
  updateSmoke(dt, speed);
  if (S.missiles < S.missileMax) S.missiles = Math.min(S.missileMax, S.missiles + dt / 1.5);
  if (S.phase === 'tutorial') tutUpdate(rawDt);

  updateRocks(dt, speed);
  updateShots(dt, speed);
  updateEshots(dt);
  updatePickups(dt, speed);
  if (boss) updateBoss(dt, rawDt);
  updateDrones(dt, speed);
  updateFx(dt, speed);
  updateTrails(dt, speed);

  if (S.phase === 'bossDown') { S.phaseT -= rawDt; if (S.phaseT <= 0 && boss) finishBoss(); }
  if (S.phase === 'dead') { S.phaseT -= rawDt; if (S.phaseT <= 0) endRun(true); }

  // 鏡頭
  const fovT = baseFov + (S.speedMul - 1) * 11;
  camera.fov = lerp(camera.fov, fovT, damp(camera.fov < fovT ? 9 : 3, rawDt));
  camera.updateProjectionMatrix();
  S.shake = Math.max(0, S.shake - rawDt * 1.8);
  const sh = S.shake * S.shake * 0.6 + (warpOn ? 0.05 : 0);
  const portrait = camera.aspect < 1;
  const follow = portrait ? 0.86 : 0.55;
  camera.position.set(
    lerp(camera.position.x, ship.x * follow, damp(6, rawDt)) + rand(-sh, sh),
    lerp(camera.position.y, ship.y * follow + (portrait ? 2.3 : 2.0), damp(6, rawDt)) + rand(-sh, sh),
    lerp(camera.position.z, (portrait ? 9.5 : 8) + (S.speedMul - 1) * 1.4, damp(4, rawDt)),   // 加速時鏡頭往後拉
  );
  camera.lookAt(ship.x * follow, ship.y * follow + (portrait ? 3.6 : 2.6), -40);   // 飛船在畫面下方，前方留給敵人
  camera.rotateZ(clamp(-ship.vx * 0.004, -0.15, 0.15));

  // 畫面特效
  flashV = Math.max(0, flashV - rawDt * 3);
  $('flash').style.opacity = flashV.toFixed(3);
  const sl = $('speedlines');
  const warpV = tunnelUniforms.uWarp.value;
  sl.style.opacity = (warpV * (QUALITY[quality].post ? 0.3 : 0.85)).toFixed(3);
  // 後製參數：超光速時色散與放射模糊加強、泛光更亮
  const lu = post.lens.uniforms;
  lu.uWarp.value = warpV;
  lu.uHit.value = S.hitFlash;
  lu.uTime.value = S.time;
  post.bloom.strength = 0.7 + warpV * 0.25 + flashV * 0.6;
  streakMat.color.setScalar(1.3 - warpV * 0.5);
  if (tunnelUniforms.uWarp.value > 0.01) sl.style.transform = `rotate(${(Math.random() * 6).toFixed(2)}deg)`;
  $('vignette').classList.toggle('hurt', S.hitFlash > 0.2 || (S.hull / S.hullMax < 0.25 && live));

  updateHUD();
}

function updateRocks(dt, speed) {
  const canHit = S.phase !== 'dead' && S.phase !== 'over' && S.phase !== 'title';
  for (let i = rocks.length - 1; i >= 0; i--) {
    const r = rocks[i];
    const prevZ = r.z;
    r.z += speed * dt;
    r.x += r.vx * dt; r.y += r.vy * dt;
    const d0 = Math.hypot(r.x, r.y);
    if (d0 > PLAY_R + 1.5) { r.vx = -Math.abs(r.vx) * Math.sign(r.x) || 0; r.vy = -Math.abs(r.vy) * Math.sign(r.y) || 0; }
    r.mesh.rotation.x += r.sx * dt;
    r.mesh.rotation.y += r.sy * dt;
    r.flash = Math.max(0, r.flash - dt);
    r.mesh.scale.setScalar(r.r * (1 + r.flash * 1.5));
    const pad = r.r + 0.65;
    if (canHit && prevZ <= pad && r.z >= -pad) {
      const d = Math.hypot(r.x - ship.x, r.y - ship.y);
      if (d < r.r + 0.45) {
        if (S.warp > 0) { addScore(80); S.kills++; S.roundKills++; destroyRock(i, false); toast('SMASH!', 'good', 0.3); continue; }
        hurt(r.kind === 'big' ? 25 : r.kind === 'wall' ? 15 : 12, r.x, r.y);
        destroyRock(i, false);
        continue;
      }
      if (!r.crossed && r.z >= 0) {
        r.crossed = true;
        if (d < r.r + 2.0 && S.dash <= 0 && S.warp <= 0) {  // 擦身而過加分
          addScore(40); S.energy = Math.min(100, S.energy + 6);
          toast('NEAR MISS +40', '', 0.4);
        }
      }
    }
    if (r.z > 14) { removeAt(rocks, i); continue; }
    place(r);
  }
}

function updateShots(dt, speed) {
  const hitTest = (s, t, rad, zMin, zMax) => t.z + rad > zMin && t.z - rad < zMax && Math.hypot(t.x - s.x, t.y - s.y) < rad + s.r;
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i];
    s.prevZ = s.z;
    s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
    s.life -= dt;
    const zMin = s.z - 0.6, zMax = s.prevZ + speed * dt + 0.6;
    let hit = false;
    for (let j = rocks.length - 1; j >= 0 && !hit; j--) if (hitTest(s, rocks[j], rocks[j].r, zMin, zMax)) { hit = true; damageRock(j, s.dmg); }
    for (let j = drones.length - 1; j >= 0 && !hit; j--) if (hitTest(s, drones[j], drones[j].r, s.z - 0.6, s.prevZ + speed * dt + 0.6)) { hit = true; damageDrone(j, s.dmg); }
    for (let j = eshots.length - 1; j >= 0 && !hit; j--) if (hitTest(s, eshots[j], 0.7, s.z - 0.6, s.prevZ + 2)) { hit = true; killEshot(j); }
    if (!hit && boss && !boss.entering) {
      const rad = boss.shieldUp ? boss.shieldR : boss.r;
      if (hitTest(s, boss, rad, s.z - 1, s.prevZ + 1)) {
        hit = true;
        damageBoss(s.dmg, s.w);
        spawnBurst(s.x, s.y, boss.z + rad * 0.8, boss.shieldUp ? 0x66ddff : WEAPONS[s.w].color, 6, 6, 0.6, 0.25, true);
      }
    }
    if (hit || s.life <= 0 || s.z < SPAWN_Z) { removeAt(shots, i); continue; }
    place(s);
  }
}

function updateEshots(dt) {
  for (let i = eshots.length - 1; i >= 0; i--) {
    const e = eshots[i];
    e.prevZ = e.z;
    e.x += e.vx * dt; e.y += e.vy * dt; e.z += e.vz * dt;
    if (e.prevZ <= 1.2 && e.z >= -1.2 && S.phase !== 'dead' && Math.hypot(e.x - ship.x, e.y - ship.y) < 0.95) {
      hurt(10, e.x - e.vx * 0.2, e.y - e.vy * 0.2);
      removeAt(eshots, i);
      continue;
    }
    if (e.z > 3) { removeAt(eshots, i); continue; }   // 飛過飛船就消失，不要穿過鏡頭
    e.mesh.scale.setScalar(1 + Math.sin(S.time * 20 + i) * 0.15);
    place(e);
  }
}

function updatePickups(dt, speed) {
  for (let i = pickups.length - 1; i >= 0; i--) {
    const p = pickups[i];
    const prevZ = p.z;
    p.z += speed * dt;
    p.mesh.rotation.y += dt * 3;
    if (prevZ <= 1.5 && p.z >= -1.5 && Math.hypot(p.x - ship.x, p.y - ship.y) < 1.9 && S.phase !== 'dead') {
      if (p.kind === 'boost') { addBoost(1); toast('加速核心 +1', 'good'); }
      else { S.hull = Math.min(S.hullMax, S.hull + 20); toast('船體修復 +20', 'good'); }
      sfx.pick();
      removeAt(pickups, i);
      continue;
    }
    if (p.z > 14) { removeAt(pickups, i); continue; }
    place(p);
  }
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    const prevZ = r.z;
    r.z += speed * dt;
    r.mesh.rotation.z += dt * 2;
    if (prevZ < 0 && r.z >= 0 && Math.hypot(r.x - ship.x, r.y - ship.y) < r.r && S.phase !== 'dead') {
      if (S.phase === 'tutorial') { sfx.pick(); spawnBurst(r.x, r.y, 0, 0xffd166, 18, 6, 0.7, 0.4); tutorialEvent('ring'); }
      else { triggerWarp(2.2); addScore(200); toast('SLIPSTREAM！', 'good'); }   // 穿過金環 = 免費瞬間加速
    }
    if (r.z > 14) { removeAt(rings, i); continue; }
    place(r);
  }
}

const _hv = new THREE.Vector3();
function updateHUD() {
  const hud = $('hud');
  if (hud.classList.contains('hidden')) return;
  setText('score', String(Math.floor(S.score)));
  setText('credits', String(S.credits));
  const inBoss = ['bossIntro', 'boss', 'bossDown'].includes(S.phase);
  setText('phase', S.phase === 'tutorial' ? 'TRAINING' : `ROUND ${S.round} · WAVE ${S.wave}/${WAVES_PER_ROUND}`);
  setWidth('progress', inBoss ? 1 : S.waveDist / S.waveLen);
  setWidth('hull', S.hull / S.hullMax);
  setWidth('energy', S.energy / 100);
  // 船體條跟著飛船走
  _hv.set(ship.x, ship.y - 0.95, ship.zOff).project(camera);
  const sb = $('shipbars');
  const bx = (_hv.x * 0.5 + 0.5) * window.innerWidth - 42, by = (-_hv.y * 0.5 + 0.5) * window.innerHeight + 4;
  sb.style.transform = `translate(${bx.toFixed(0)}px, ${by.toFixed(0)}px)`;
  sb.style.opacity = shipModel.group.visible && S.phase !== 'tutorial' ? '1' : '0';
  sb.classList.toggle('low', S.hull / S.hullMax < 0.3);
  setText('boostCount', '×' + S.boost);
  $('btnBoost').classList.toggle('empty', S.boost <= 0);
  const mb = $('btnMissile');
  mb.style.setProperty('--p', (S.missiles / S.missileMax).toFixed(3));
  setText('missileCount', S.locking ? `${locks.length} / ${Math.floor(S.missiles)}` : String(Math.floor(S.missiles)));
  mb.classList.toggle('locking', S.locking);
  mb.classList.toggle('empty', S.missiles < 1);
  hud.classList.toggle('boss-mode', inBoss);
  hud.classList.toggle('hacking', S.hacking);
  if (boss) {
    setWidth('bosshp', boss.hp / boss.hpMax);
    setText('bossState', boss.shieldUp ? '· 護盾展開' : `· ${BOSS_STATES[boss.state].label} ${Math.ceil(boss.stateT)}s`);
  }
  const showHack = !!boss && S.phase === 'boss' && boss.shieldUp && !S.hacking && boss.hackCd <= 0;
  $('btnHack').classList.toggle('hidden', !showHack);
}

function render() {
  if (QUALITY[quality].post) post.composer.render();
  else renderer.render(scene, camera);
}
// 掉幀保護：平均每幀超過 22ms（約低於 45fps）就自動降低解析度，順暢時再慢慢調回來
let frameAvg = 16, perfT = 0;
function autoScale(ms, rawDt) {
  frameAvg = lerp(frameAvg, ms, 0.05);
  perfT += rawDt;
  if (perfT < 2) return;
  perfT = 0;
  if (frameAvg > 22 && dynScale > 0.55) { dynScale = Math.max(0.55, dynScale - 0.15); resize(); }
  else if (frameAvg < 14 && dynScale < 1) { dynScale = Math.min(1, dynScale + 0.1); resize(); }
}
function loop(now) {
  const ms = now - last;
  const rawDt = Math.min(0.05, ms / 1000);
  last = now;
  if (!S.paused) update(rawDt);
  render();
  if (!document.hidden) autoScale(ms, rawDt);
  requestAnimationFrame(loop);
}

/* ================= 按鈕綁定 ================= */
$('pilot').value = prefs.name;
$('sens').value = String(prefs.sens);
$('invert').checked = !!prefs.invert;
$('lefty').checked = !!prefs.lefty;
$('hud').classList.toggle('lefty', !!prefs.lefty);
quality = clamp(prefs.quality ?? (isMobile ? 1 : 2), 0, 2);
$('quality').value = String(quality);
resize();
$('quality').addEventListener('change', () => { quality = +$('quality').value; dynScale = 1; resize(); savePrefs(); });
const savePrefs = () => { prefs.name = $('pilot').value.trim(); prefs.sens = +$('sens').value; prefs.invert = $('invert').checked; prefs.quality = quality; prefs.lefty = $('lefty').checked; $('hud').classList.toggle('lefty', prefs.lefty); Prefs.save(prefs); };
$('lefty').addEventListener('change', savePrefs);
$('pilot').addEventListener('change', savePrefs);
$('sens').addEventListener('change', savePrefs);
$('invert').addEventListener('change', savePrefs);

$('btnStart').addEventListener('click', () => {
  savePrefs();
  enableGyro();   // iOS 必須在點擊當下請求權限
  try { document.documentElement.requestFullscreen?.()?.catch(() => {}); } catch (e) { /* 不支援全螢幕就略過 */ }
  initAudio();
  // 第一次玩：先看劇情再進教學
  if (!prefs.tutorialDone) playStory(startTutorial);
  else startGame();
});
$('btnTutorial').addEventListener('click', () => { savePrefs(); enableGyro(); initAudio(); playStory(startTutorial); });
$('btnBoard').addEventListener('click', () => openBoard('score'));
$('btnBoardClose').addEventListener('click', () => $('board').classList.add('hidden'));
for (const b of $('boardTabs').children) b.addEventListener('click', () => openBoard(b.dataset.cat));
$('btnBoost').addEventListener('pointerdown', (e) => { e.preventDefault(); useBoost(); });
$('btnHack').addEventListener('pointerdown', (e) => { e.preventDefault(); startBossHack(); });
// 飛彈鍵：按住鎖定、放開發射
const mslBtn = $('btnMissile');
mslBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); try { mslBtn.setPointerCapture(e.pointerId); } catch (err) { /* 略過 */ } startLock(); });
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) mslBtn.addEventListener(ev, () => releaseLock());
mslBtn.addEventListener('contextmenu', (e) => e.preventDefault());
$('btnPause').addEventListener('pointerdown', (e) => { e.preventDefault(); togglePause(true); });
$('btnResume').addEventListener('click', () => togglePause(false));
$('btnRecal').addEventListener('click', () => { calibrate(); togglePause(false); });
$('btnQuit').addEventListener('click', () => { $('pause').classList.add('hidden'); S.paused = false; endRun(false); });
document.addEventListener('visibilitychange', () => { if (document.hidden) togglePause(true); });

refreshWeaponButtons();
requestAnimationFrame(loop);

// 給除錯用
window.__trs = {
  get S() { return S; }, rocks, startBossHack, useBoost, get boss() { return boss; }, hack, shipModel, trails, post, scene, renderer, drones, spawnFormation, camera,
  setMode, startLock, releaseLock, missiles, locks, startTutorial, playStory, finishTutorial, startGame, tutorialEvent, input,
  step(sec) { for (let t = 0; t < sec; t += 1 / 60) update(1 / 60); render(); },
};
