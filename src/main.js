import * as THREE from 'three';
import { HackGame } from './hack.js';
import { sfx, initAudio, vibrate } from './audio.js';
import { Records, Prefs } from './storage.js';
import { QUALITY, createPost, buildEnvironment, makeRockTextures, shieldMaterial } from './graphics.js';

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

const WEAPONS = {
  pulse:   { name: 'PULSE',   zh: '單發', icon: '●', color: 0x7fd8ff, rate: [2.4, 3.0, 3.6], dmg: [4, 5.5, 7.5], speed: 230, pellets: [1, 1, 1], spread: 0, assist: 1.8 },
  vulcan:  { name: 'VULCAN',  zh: '連射', icon: '⋮', color: 0xffe066, rate: [10, 13, 16], dmg: [0.7, 0.9, 1.15], speed: 210, pellets: [1, 1, 1], spread: 0.025, assist: 1.1 },
  scatter: { name: 'SCATTER', zh: '擴散', icon: '✱', color: 0x9dff7a, rate: [2.6, 3.0, 3.4], dmg: [1.1, 1.3, 1.6], speed: 160, pellets: [5, 7, 9], spread: 0.12, range: 130, assist: 0 },
  laser:   { name: 'LASER',   zh: '光束', icon: '━', color: 0xff5ce1, dps: [7, 10, 13.5], drain: 24 },
};
const WEAPON_KEYS = ['pulse', 'vulcan', 'scatter', 'laser'];

// BOSS 護盾破解後會進入其中一種狀態，每種狀態有對應的弱點武器
const BOSS_STATES = {
  ARMOR: { label: '重裝甲', weak: 'pulse', color: 0xffc04d, hint: '厚重裝甲 → 用單發高傷害貫穿' },
  SWARM: { label: '蜂群展開', weak: 'scatter', color: 0x9dff7a, hint: '無人機群 → 用擴散一次清掉' },
  CORE:  { label: '核心暴露', weak: 'laser', color: 0xff5ce1, hint: '核心高速移動 → 用光束持續追瞄' },
  REGEN: { label: '自我修復', weak: 'vulcan', color: 0xffe066, hint: '持續回血 → 用連射壓制' },
};

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
let dynScale = 1;     // 自動降解析度（掉幀時）
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
  uBend: { value: bend }, uLen: { value: TUNNEL_LEN },
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
    uniform float uTime, uTravel, uWarp, uLen, uHit;
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
      vec3 col = base * (0.035 + plasma * 0.32 + spiral * 0.22 + grid * 0.12);
      col += base * rings * 1.5;
      col += mix(base, vec3(1.0), 0.3) * fil * 0.9;
      float streak = pow(0.5 + 0.5 * sin(a * 48.0 + floor(s * 0.25) * 13.0), 40.0);
      col += vec3(0.75, 0.9, 1.0) * streak * uWarp * 0.9;
      // 隧道盡頭的強光（亮度超過 1，會在泛光下形成光暈）
      float far = clamp(-vZ / (uLen - 60.0), 0.0, 1.0);
      col = mix(col, (uColB * 0.6 + 0.4) * 2.4, pow(far, 2.6) * 0.97);
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
const streaks = Array.from({ length: STREAKS }, () => ({ a: rand(0, TAU), r: rand(2.5, 10.5), z: rand(SPAWN_Z, 10) }));
const dummy = new THREE.Object3D();

/* ================= 玩家飛船 ================= */
function buildShip() {
  const group = new THREE.Group();
  // 烤漆金屬：清漆層＋高金屬度，會映出隧道的光
  const hullMat = new THREE.MeshPhysicalMaterial({ color: 0x9aa3b8, metalness: 0.85, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.1, envMapIntensity: 0.55 });
  const darkMat = new THREE.MeshPhysicalMaterial({ color: 0x23283a, metalness: 0.9, roughness: 0.35, clearcoat: 0.6, envMapIntensity: 0.6 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0x111122, emissive: 0x7fd8ff, emissiveIntensity: 3.5 });
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x0a1830, metalness: 0.2, roughness: 0.02, clearcoat: 1, emissive: 0x1a4a80, emissiveIntensity: 0.6 });

  const body = new THREE.Mesh(new THREE.ConeGeometry(0.55, 2.8, 8), hullMat);
  body.rotation.x = -Math.PI / 2;
  body.scale.set(1, 1, 0.75);
  group.add(body);
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.22, 1.9), darkMat);
  spine.position.set(0, 0.28, 0.35);
  group.add(spine);
  // 後掠翼
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0.2, -0.3); wingShape.lineTo(1.8, 0.55); wingShape.lineTo(1.85, 0.95); wingShape.lineTo(0.25, 0.95); wingShape.closePath();
  const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.07, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.03, bevelSegments: 1 });
  wingGeo.rotateX(Math.PI / 2);
  for (const sx of [-1, 1]) {
    const wing = new THREE.Mesh(wingGeo, hullMat);
    wing.scale.x = sx;
    wing.position.set(0, -0.02, 0.05);
    group.add(wing);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.02, 0.06), accentMat);
    stripe.position.set(sx * 1.05, 0.06, 0.62);
    stripe.rotation.y = sx * -0.48;
    group.add(stripe);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.32, 0.7), accentMat);
    tip.position.set(sx * 1.83, 0.08, 0.72);
    group.add(tip);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.6, 0.75), darkMat);
    fin.position.set(sx * 0.42, 0.38, 0.95);
    fin.rotation.z = sx * -0.38;
    group.add(fin);
    // 引擎噴嘴
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.55, 12, 1, true), darkMat);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(sx * 0.32, -0.02, 1.25);
    group.add(nozzle);
    const core = new THREE.Mesh(new THREE.CircleGeometry(0.19, 12), additive(0x9fe8ff, 1, {}, 1.4));
    core.position.set(sx * 0.32, -0.02, 1.5);
    group.add(core);
  }
  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 10), glassMat);
  cockpit.scale.set(1, 0.7, 1.9);
  cockpit.position.set(0, 0.24, -0.35);
  group.add(cockpit);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.32, 1.6, 12, 1, true), additive(0x66ddff, 0.5, {}, 1.0));
  flame.rotation.x = Math.PI / 2;
  flame.position.z = 2.2;
  group.add(flame);
  const glow = glowSprite(0x66ddff, 0.7, 0.6);
  glow.position.z = 1.6;
  group.add(glow);
  const bubble = new THREE.Mesh(new THREE.IcosahedronGeometry(1.9, 1), additive(0x66ffcc, 0.25, { wireframe: true }, 2));
  bubble.visible = false;
  group.add(bubble);
  scene.add(group);
  return { group, flame, glow, accentMat, bubble };
}
const shipModel = buildShip();
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
const trails = [
  Object.assign(makeTrail(0x66ccff, 0.07, 0.7), { local: new THREE.Vector3(-0.32, -0.02, 1.5) }),
  Object.assign(makeTrail(0x66ccff, 0.07, 0.7), { local: new THREE.Vector3(0.32, -0.02, 1.5) }),
  Object.assign(makeTrail(0xffffff, 0.025, 0.8), { local: new THREE.Vector3(-1.83, 0.08, 1.0) }),
  Object.assign(makeTrail(0xffffff, 0.025, 0.8), { local: new THREE.Vector3(1.83, 0.08, 1.0) }),
];
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

const shotGeoBig = new THREE.CapsuleGeometry(0.13, 1.6, 2, 8).rotateX(Math.PI / 2);
const shotGeoSmall = new THREE.CapsuleGeometry(0.07, 1.2, 2, 6).rotateX(Math.PI / 2);
const shotMats = Object.fromEntries(WEAPON_KEYS.map((k) => [k, additive(WEAPONS[k].color, 1, {}, 5)]));
const eshotGeo = new THREE.SphereGeometry(0.65, 14, 10);
const eshotMat = additive(0xff3366, 1, {}, 4);
const droneGeo = new THREE.OctahedronGeometry(0.9);
const droneMat = new THREE.MeshPhysicalMaterial({ color: 0x1a2a1e, metalness: 0.9, roughness: 0.25, emissive: 0x7dff9a, emissiveIntensity: 2.5, flatShading: true, clearcoat: 1 });
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
  for (const arr of [rocks, shots, eshots, pickups, rings, drones]) while (arr.length) removeAt(arr, arr.length - 1);
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
    hull: 100, hullMax: 100, energy: 100, energyRegen: 20, laserLock: false,
    boost: 1, boostMax: 3, warp: 0, speedMul: 1, deflect: 0, invuln: 0, dash: 0, dashDir: 0,
    weapon: 'pulse', levels: { pulse: 1, vulcan: 1, scatter: 1, laser: 1 }, fireT: 0,
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
  const idx = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(e.code);
  if (idx >= 0) setWeapon(WEAPON_KEYS[idx]);
  if (e.code === 'Space' || e.code === 'ShiftLeft') { useBoost(); e.preventDefault(); }
  if (e.code === 'KeyH') startBossHack();
  if (e.code === 'KeyQ') dash(-1);
  if (e.code === 'KeyE') dash(1);
  if (e.code === 'KeyR') calibrate();
  if (e.code === 'Escape' || e.code === 'KeyP') togglePause();
});
window.addEventListener('keyup', (e) => { input.keys[e.code] = false; });

function targetXY(rawDt) {
  const k = input.keys;
  const kx = (k.ArrowRight || k.KeyD ? 1 : 0) - (k.ArrowLeft || k.KeyA ? 1 : 0);
  const ky = (k.ArrowUp || k.KeyW ? 1 : 0) - (k.ArrowDown || k.KeyS ? 1 : 0);
  input.offX = clamp(input.offX + kx * rawDt * 2.4, -1.25, 1.25);
  input.offY = clamp(input.offY + ky * rawDt * 2.4, -1.25, 1.25);
  input.sgx = lerp(input.sgx, input.gx, damp(14, rawDt));
  input.sgy = lerp(input.sgy, input.gy, damp(14, rawDt));
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
let flashV = 0;
function flash(v) { flashV = Math.max(flashV, v); }
const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const hex = (n) => '#' + n.toString(16).padStart(6, '0');

/* ================= 武器 ================= */
const weaponsEl = $('weapons');
for (const k of WEAPON_KEYS) {
  const d = WEAPONS[k];
  const b = document.createElement('button');
  b.className = 'wbtn';
  b.dataset.w = k;
  b.style.setProperty('--wc', hex(d.color));
  b.innerHTML = `<i>${d.icon}</i><b>${d.name}</b><small>${d.zh}</small><span class="lv"></span>`;
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); setWeapon(k); });
  weaponsEl.appendChild(b);
}
function refreshWeaponButtons() {
  const weak = boss && !boss.shieldUp && boss.state ? BOSS_STATES[boss.state].weak : null;
  for (const b of weaponsEl.children) {
    const k = b.dataset.w;
    b.classList.toggle('on', k === S.weapon);
    b.classList.toggle('weak', k === weak);
    b.querySelector('.lv').textContent = 'LV' + S.levels[k];
  }
}
function setWeapon(k) {
  if (S.weapon === k) return;
  S.weapon = k;
  S.fireT = 0.05;
  shipModel.accentMat.emissive.setHex(WEAPONS[k].color);
  refreshWeaponButtons();
  sfx.ui();
}

function findTarget(extra, maxDist, withEshots) {
  const aligned = (t, r) => t.z < -4 && t.z > -maxDist && Math.hypot(t.x - ship.x, t.y - ship.y) < r + extra;
  // BOSS 護盾破除時優先瞄準 BOSS 本體
  if (boss && !boss.entering && !boss.shieldUp && aligned(boss, boss.r)) return boss;
  let best = null, bestZ = -Infinity;
  const test = (t, r) => { if (t.z > bestZ && aligned(t, r)) { best = t; bestZ = t.z; } };
  for (const r of rocks) test(r, r.r);
  for (const d of drones) test(d, 0.9);
  if (withEshots) for (const e of eshots) test(e, 0.7);
  if (boss && !boss.entering) test(boss, boss.r);
  return best;
}

function spawnShot(w, vx, vy, vz, dmg, life) {
  const mesh = new THREE.Mesh(w === 'pulse' ? shotGeoBig : shotGeoSmall, shotMats[w]);
  scene.add(mesh);
  const s = { mesh, w, x: ship.x, y: ship.y, z: -1.8, prevZ: -1.8, vx, vy, vz, dmg, life, r: w === 'pulse' ? 0.55 : 0.35 };
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
  drones.forEach((d, i) => test(d, 0.9, 'drone', i));
  eshots.forEach((e, i) => test(e, 0.7, 'eshot', i));
  if (boss && !boss.entering) test(boss, boss.shieldUp ? 7 : boss.r, 'boss', -1);

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
  const big = Math.random() < 0.2 + 0.04 * S.round;
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
  const gap = lerp(26, 13, prog) / (1 + 0.18 * (S.round - 1) + 0.1 * (S.wave - 1));
  while (S.spawnAcc > gap) {
    S.spawnAcc -= gap;
    S.spawnCount++;
    if (S.spawnCount % 22 === 0 && (S.wave > 1 || S.round > 1)) spawnWall();
    else spawnRock(Math.random() < 0.3);
  }
  if (S.pickupAcc > 480) { S.pickupAcc = 0; spawnPickup(Math.random() < 0.72 ? 'boost' : 'repair'); }
  if (S.ringAcc > 650) { S.ringAcc = rand(-150, 0); spawnRing(); }
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
  if (d.hp <= 0) {
    spawnExplosion(d.x, d.y, d.z, 0x7dff9a, 0.6, true);
    sfx.boom(false);
    addScore(150); S.credits += 15; S.kills++; S.roundKills++;
    removeAt(drones, i);
  }
}
function killEshot(i) {
  const e = eshots[i];
  spawnBurst(e.x, e.y, e.z, 0xff6688, 10, 6, 0.7, 0.4, true);
  addScore(20);
  removeAt(eshots, i);
}

function hurt(amount) {
  if (S.phase === 'dead' || S.warp > 0 || S.dash > 0 || S.invuln > 0) return;
  if (S.deflect > 0) {
    S.deflect--; S.invuln = 0.8;
    toast('偏折護盾抵擋！', 'good'); sfx.shield();
    return;
  }
  S.hull -= amount;
  S.roundDmg += amount;
  S.invuln = 1.0;
  S.shake = 0.8;
  S.hitFlash = 1;
  sfx.hit();
  vibrate([40, 30, 40]);
  if (S.hull <= 0) { S.hull = 0; die(); }
}

/* ================= 加速 / 翻滾 ================= */
function canAct() { return ['wave', 'gateApproach', 'bossIntro', 'boss'].includes(S.phase) && !S.paused && !S.hacking; }
function triggerWarp(dur) {
  S.warp = Math.max(S.warp, dur);
  camera.fov = 56;            // 先瞬間拉近，再猛然拉遠 → 瞬移的爆發感
  camera.updateProjectionMatrix();
  ship.zOff = -3.5;
  flash(0.85);
  S.shake = 0.9;
  sfx.boost();
  vibrate(70);
}
function useBoost() {
  if (!canAct() || S.boost <= 0 || S.warp > 0.3) return;
  S.boost--;
  triggerWarp(3.0);
  toast('超光速衝刺！', 'good');
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
  clearWorld();
  S = freshState();
  hideOverlays();
  showHUD(true);
  shipModel.group.visible = true;
  shipModel.accentMat.emissive.setHex(WEAPONS.pulse.color);
  refreshWeaponButtons();
  input.calibrated = false;
  input.offX = input.offY = 0;
  startRound();
}
function startRound() {
  S.wave = 0; S.roundTime = 0; S.roundDmg = 0; S.roundKills = 0;
  setPalette(S.round - 1);
  startWave();
}
function startWave() {
  S.wave++;
  S.phase = 'wave';
  S.waveDist = 0; S.spawnAcc = 0;
  S.waveLen = 1500 + 250 * (S.round - 1) + 150 * (S.wave - 1);
  banner(`ROUND ${S.round} · WAVE ${S.wave}/${WAVES_PER_ROUND}`, S.wave === 1 && S.round === 1 ? '傾斜手機閃避隕石，武器會自動開火' : '');
  if (S.overdrive) { S.overdrive = false; triggerWarp(3); }
}
function endWave() {
  if (S.wave < WAVES_PER_ROUND) {
    S.phase = 'gateApproach';
    const type = (S.wave + S.round) % 2 === 0 ? 'choice' : 'hack';
    spawnGate(type);
    banner('前方：資料閘門', type === 'choice' ? '穿過閘門選擇強化' : '穿過閘門進行破解');
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
  const coreMat = new THREE.MeshPhysicalMaterial({ color: 0x1a1a26, metalness: 0.9, roughness: 0.2, clearcoat: 1, emissive: 0xff3355, emissiveIntensity: 0.8, flatShading: true });
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(3, 0), coreMat);
  g.add(core);
  const armorMat = new THREE.MeshPhysicalMaterial({ color: 0xb4bccf, metalness: 0.95, roughness: 0.28, clearcoat: 0.8, clearcoatRoughness: 0.15, flatShading: true });
  const ringA = new THREE.Mesh(new THREE.TorusGeometry(4.6, 0.5, 6, 20), armorMat);
  const ringB = new THREE.Mesh(new THREE.TorusGeometry(5.6, 0.22, 4, 36), armorMat);
  ringB.rotation.x = Math.PI / 2;
  for (let i = 0; i < 6; i++) {
    const sp = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.2, 5), armorMat);
    const a = (i / 6) * TAU;
    sp.position.set(Math.cos(a) * 5.3, Math.sin(a) * 5.3, 0);
    sp.rotation.z = a - Math.PI / 2;
    ringA.add(sp);
  }
  g.add(ringA, ringB);
  const eyeMat = new THREE.MeshBasicMaterial({ color: hdr(0xff3355, 3) });
  const eye = new THREE.Mesh(new THREE.SphereGeometry(1.1, 16, 12), eyeMat);
  eye.position.z = 2.6;
  g.add(eye);
  const eyeGlow = glowSprite(0xff3355, 6, 3);
  eyeGlow.position.z = 3;
  g.add(eyeGlow);
  const shieldMat = additive(0x66ddff, 0.3, { wireframe: true }, 1.6);
  const shield = new THREE.Mesh(new THREE.IcosahedronGeometry(7, 2), shieldMat);
  const shellMat = shieldMaterial(0x3aa8ff);
  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(6.9, 3), shellMat);
  g.add(shield, shell);
  scene.add(g);
  const hpMax = 420 * (1 + 0.4 * (S.round - 1));
  return {
    mesh: g, core, coreMat, ringA, ringB, eyeMat, eyeGlow, shield, shieldMat, shell, shellMat,
    x: 0, y: 0, z: -380, r: 4.3, hp: hpMax, hpMax, shieldUp: true, shieldScale: 1,
    state: null, lastState: null, stateT: 0, fireT: 2.5, pattern: 0, mx: 0, t: 0,
    entering: true, hackCd: 0, flash: 0, shieldFlash: 0,
  };
}
function startBoss() {
  S.phase = 'bossIntro';
  boss = createBoss();
  place(boss);
  $('bossbar').classList.remove('hidden');
  banner('⚠ WARNING ⚠', '巨型守衛接近 — 先破解護盾，再用弱點武器攻擊', true, 3000);
  sfx.warn();
}
function dropShield(bonus) {
  const b = boss;
  b.shieldUp = false;
  const keys = Object.keys(BOSS_STATES).filter((k) => k !== b.lastState);
  b.state = b.lastState = pick(keys);
  b.stateT = 10 + bonus * 2;
  const st = BOSS_STATES[b.state];
  b.coreMat.emissive.setHex(st.color);
  b.eyeMat.color.setHex(st.color).multiplyScalar(3);
  b.eyeGlow.material.color.setHex(st.color).multiplyScalar(3);
  banner(`護盾破除 · ${st.label}`, `${st.hint}（弱點：${WEAPONS[st.weak].zh} ${WEAPONS[st.weak].name}）`, false, 3000);
  flash(0.5);
  if (b.state === 'SWARM') {
    for (let i = 0; i < 6; i++) {
      const mesh = new THREE.Mesh(droneGeo, droneMat);
      scene.add(mesh);
      drones.push({ mesh, a: (i / 6) * TAU, x: b.x, y: b.y, z: b.z + 5, hp: 3, fireT: rand(1, 3) });
    }
  }
  refreshWeaponButtons();
}
function raiseShield() {
  const b = boss;
  b.shieldUp = true;
  b.state = null;
  b.coreMat.emissive.setHex(0xff3355);
  b.eyeMat.color.setHex(0xff3355).multiplyScalar(3);
  b.eyeGlow.material.color.setHex(0xff3355).multiplyScalar(3);
  while (drones.length) removeAt(drones, drones.length - 1);
  banner('護盾重新展開', '再次破解！');
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
  banner('GUARDIAN DOWN', '守衛擊破！');
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
  b.y = Math.sin(b.mx * 1.37 + 1) * (fast ? 3.8 : 2.4);
  b.ringA.rotation.z += dt * 0.6;
  b.ringB.rotation.y += dt * 0.9;
  b.core.rotation.x += dt * 0.4; b.core.rotation.y += dt * 0.3;
  b.shieldScale = lerp(b.shieldScale, b.shieldUp ? 1 : 0.01, damp(6, rawDt));
  b.shield.scale.setScalar(b.shieldScale);
  b.shell.scale.setScalar(b.shieldScale);
  b.shield.rotation.y += dt * 0.3;
  b.shieldFlash = Math.max(0, b.shieldFlash - rawDt * 2);
  b.shieldMat.opacity = 0.25 + b.shieldFlash;
  b.shellMat.uniforms.uFlash.value = b.shieldFlash;
  b.shellMat.uniforms.uTime.value = S.time;
  b.flash = Math.max(0, b.flash - rawDt);
  b.coreMat.emissiveIntensity = 1.2 + b.flash * 14;
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
    b.mesh.rotation.z += rawDt * 2;
    if (Math.random() < rawDt * 10) {
      spawnExplosion(b.x + rand(-4, 4), b.y + rand(-4, 4), b.z + rand(-2, 3), pick([0xff8a40, 0xff5c7c, 0xffd0a0]), 0.9, true);
      sfx.boom(true);
      S.shake = Math.max(S.shake, 0.4);
    }
  }
  place(b);
}

function updateDrones(dt) {
  for (let i = drones.length - 1; i >= 0; i--) {
    const d = drones[i];
    d.a += dt * 1.4;
    d.x = boss.x + Math.cos(d.a) * 6.5;
    d.y = boss.y + Math.sin(d.a) * 6.5;
    d.z = boss.z + 5;
    d.mesh.rotation.y += dt * 3;
    d.fireT -= dt;
    if (d.fireT <= 0) {
      d.fireT = rand(1.8, 3.2);
      const vz = 40, t = -d.z / vz;
      const mesh = new THREE.Mesh(eshotGeo, eshotMat);
      scene.add(mesh);
      eshots.push({ mesh, x: d.x, y: d.y, z: d.z, prevZ: d.z, vx: (ship.x - d.x) / t, vy: (ship.y - d.y) / t, vz });
    }
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
      label: `${WEAPONS[k].name} ${WEAPONS[k].zh}`, sub: S.levels[k] >= 3 ? '已滿級' : `LV${S.levels[k]} → LV${S.levels[k] + 1}`,
      cost: WEAPON_COST[S.levels[k]] ?? 0, can: S.levels[k] < 3, buy: () => { S.levels[k]++; },
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
  const live = ['wave', 'gateApproach', 'bossIntro', 'boss', 'bossDown'].includes(S.phase);
  if (!live || S.hacking) return;
  S.paused = force ?? !S.paused;
  $('pause').classList.toggle('hidden', !S.paused);
}

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
    dummy.position.set(Math.cos(s.a) * s.r + b.x, Math.sin(s.a) * s.r + b.y, s.z);
    dummy.scale.set(1, 1, sLen);
    dummy.updateMatrix();
    streakMesh.setMatrixAt(i, dummy.matrix);
  }
  streakMesh.instanceMatrix.needsUpdate = true;

  // 飛船（用真實時間移動，所以慢動作時還是能靈活閃避）
  let tx, ty;
  if (S.phase === 'title') { tx = Math.sin(S.time * 0.7) * 3; ty = Math.sin(S.time * 1.1) * 1.8; }
  else [tx, ty] = targetXY(rawDt);
  const stiff = S.dash > 0 ? 16 : 9;
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
  sm.group.rotation.set(clamp(ship.vy * 0.03, -0.5, 0.5), clamp(-ship.vx * 0.01, -0.3, 0.3), clamp(-ship.vx * 0.045, -0.9, 0.9) + spin);
  sm.flame.scale.set(1, 1 + (S.speedMul - 1) * 1.6 + Math.random() * 0.3, 1);
  sm.glow.scale.setScalar(0.7 + (S.speedMul - 1) * 0.5 + Math.random() * 0.1);
  sm.bubble.visible = S.deflect > 0 || warpOn;
  sm.bubble.rotation.y += rawDt * 2;
  if (S.phase !== 'dead' && S.phase !== 'over') sm.group.visible = S.invuln > 0 ? Math.floor(S.time * 20) % 2 === 0 : true;
  shipLight.position.set(ship.x, ship.y + 3, 3);

  // 能量自然回復
  if (S.weapon !== 'laser' || S.laserLock || !combat) S.energy = Math.min(100, S.energy + S.energyRegen * dt);

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

  if (combat && !S.hacking) fireWeapon(dt, speed); else laserHide();

  updateRocks(dt, speed);
  updateShots(dt, speed);
  updateEshots(dt);
  updatePickups(dt, speed);
  if (boss) { updateBoss(dt, rawDt); updateDrones(dt); }
  updateFx(dt, speed);
  updateTrails(dt, speed);

  if (S.phase === 'bossDown') { S.phaseT -= rawDt; if (S.phaseT <= 0 && boss) finishBoss(); }
  if (S.phase === 'dead') { S.phaseT -= rawDt; if (S.phaseT <= 0) endRun(true); }

  // 鏡頭
  const fovT = 72 + (S.speedMul - 1) * 13;
  camera.fov = lerp(camera.fov, fovT, damp(camera.fov < fovT ? 9 : 3, rawDt));
  camera.updateProjectionMatrix();
  S.shake = Math.max(0, S.shake - rawDt * 1.8);
  const sh = S.shake * S.shake * 0.6 + (warpOn ? 0.05 : 0);
  camera.position.set(
    lerp(camera.position.x, ship.x * 0.55, damp(6, rawDt)) + rand(-sh, sh),
    lerp(camera.position.y, ship.y * 0.55 + 1.3, damp(6, rawDt)) + rand(-sh, sh),
    7.5 + (S.speedMul - 1) * 0.8,
  );
  camera.lookAt(ship.x * 0.7, ship.y * 0.7, -40);
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
      if (d < r.r + 0.6) {
        if (S.warp > 0) { addScore(80); S.kills++; S.roundKills++; destroyRock(i, false); toast('SMASH!', 'good', 0.3); continue; }
        hurt(r.kind === 'big' ? 25 : r.kind === 'wall' ? 15 : 12);
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
    for (let j = drones.length - 1; j >= 0 && !hit; j--) if (hitTest(s, drones[j], 0.9, s.z - 0.6, s.prevZ + 0.6)) { hit = true; damageDrone(j, s.dmg); }
    for (let j = eshots.length - 1; j >= 0 && !hit; j--) if (hitTest(s, eshots[j], 0.7, s.z - 0.6, s.prevZ + 2)) { hit = true; killEshot(j); }
    if (!hit && boss && !boss.entering) {
      const rad = boss.shieldUp ? 7 : boss.r;
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
    if (e.prevZ <= 1.2 && e.z >= -1.2 && S.phase !== 'dead' && Math.hypot(e.x - ship.x, e.y - ship.y) < 1.3) {
      hurt(10);
      removeAt(eshots, i);
      continue;
    }
    if (e.z > 12) { removeAt(eshots, i); continue; }
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
      triggerWarp(2.2);   // 穿過金環 = 免費瞬間加速
      addScore(200);
      toast('SLIPSTREAM！', 'good');
    }
    if (r.z > 14) { removeAt(rings, i); continue; }
    place(r);
  }
}

function updateHUD() {
  if ($('hud').classList.contains('hidden')) return;
  setText('score', String(Math.floor(S.score)));
  setText('kills', String(S.kills));
  setText('credits', String(S.credits));
  setText('time', fmtTime(S.roundTime));
  const inBoss = ['bossIntro', 'boss', 'bossDown'].includes(S.phase);
  setText('phase', inBoss ? `ROUND ${S.round} · BOSS` : `ROUND ${S.round} · WAVE ${S.wave}/${WAVES_PER_ROUND}`);
  setWidth('progress', inBoss ? 1 : S.waveDist / S.waveLen);
  setWidth('hull', S.hull / S.hullMax);
  setWidth('energy', S.energy / 100);
  const pips = Array.from({ length: S.boostMax }, (_, i) => `<i class="${i < S.boost ? 'on' : ''}"></i>`).join('');
  if (hudCache.pips !== pips) { hudCache.pips = pips; $('boostPips').innerHTML = pips; }
  $('btnBoost').classList.toggle('empty', S.boost <= 0);
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
quality = clamp(prefs.quality ?? (isMobile ? 1 : 2), 0, 2);
$('quality').value = String(quality);
resize();
$('quality').addEventListener('change', () => { quality = +$('quality').value; dynScale = 1; resize(); savePrefs(); });
const savePrefs = () => { prefs.name = $('pilot').value.trim(); prefs.sens = +$('sens').value; prefs.invert = $('invert').checked; prefs.quality = quality; Prefs.save(prefs); };
$('pilot').addEventListener('change', savePrefs);
$('sens').addEventListener('change', savePrefs);
$('invert').addEventListener('change', savePrefs);

$('btnStart').addEventListener('click', () => {
  savePrefs();
  enableGyro();   // iOS 必須在點擊當下請求權限
  try {
    const el = document.documentElement;
    const p = el.requestFullscreen?.();
    p?.then(() => screen.orientation?.lock?.('landscape')).catch(() => {});
  } catch (e) { /* 不支援全螢幕就略過 */ }
  startGame();
});
$('btnBoard').addEventListener('click', () => openBoard('score'));
$('btnBoardClose').addEventListener('click', () => $('board').classList.add('hidden'));
for (const b of $('boardTabs').children) b.addEventListener('click', () => openBoard(b.dataset.cat));
$('btnBoost').addEventListener('pointerdown', (e) => { e.preventDefault(); useBoost(); });
$('btnHack').addEventListener('pointerdown', (e) => { e.preventDefault(); startBossHack(); });
$('btnCal').addEventListener('pointerdown', (e) => { e.preventDefault(); calibrate(); });
$('btnPause').addEventListener('pointerdown', (e) => { e.preventDefault(); togglePause(true); });
$('btnResume').addEventListener('click', () => togglePause(false));
$('btnRecal').addEventListener('click', () => { calibrate(); togglePause(false); });
$('btnQuit').addEventListener('click', () => { $('pause').classList.add('hidden'); S.paused = false; endRun(false); });
document.addEventListener('visibilitychange', () => { if (document.hidden) togglePause(true); });

refreshWeaponButtons();
requestAnimationFrame(loop);

// 給除錯用
window.__trs = {
  get S() { return S; }, rocks, startBossHack, useBoost, get boss() { return boss; }, hack, shipModel, trails, post, scene, renderer,
  step(sec) { for (let t = 0; t < sec; t += 1 / 60) update(1 / 60); render(); },
};
