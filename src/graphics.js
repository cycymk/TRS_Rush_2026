// 畫面質感模組：後製（泛光、色散、放射模糊、暗角、顆粒）、反射環境、程式生成貼圖
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// 畫質等級：低＝不開後製；中＝後製＋較低解析度；高＝完整
export const QUALITY = [
  { name: '低', post: false, maxDpr: 1 },
  { name: '中', post: true, maxDpr: 1.25 },
  { name: '高', post: true, maxDpr: 2 },
];

/* ---------- 鏡頭後製 ---------- */
const LensShader = {
  uniforms: {
    tDiffuse: { value: null },
    uWarp: { value: 0 }, uHit: { value: 0 }, uTime: { value: 0 }, uAspect: { value: 1 },
    uCenter: { value: new THREE.Vector2(0.5, 0.52) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uWarp, uHit, uTime, uAspect;
    uniform vec2 uCenter;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 d = vUv - uCenter;
      float r = length(d * vec2(uAspect, 1.0));
      // 色散：越靠邊、越快、被打中時越明顯
      float ca = (0.004 + uWarp * 0.012 + uHit * 0.02) * r;
      // 超光速時的放射模糊
      float blur = uWarp * 0.05;
      int n = blur > 0.002 ? 10 : 1;
      vec3 col = vec3(0.0);
      for (int i = 0; i < 10; i++) {
        if (i >= n) break;
        float s = 1.0 - blur * float(i) / 9.0;
        col.r += texture2D(tDiffuse, uCenter + d * (s - ca)).r;
        col.g += texture2D(tDiffuse, uCenter + d * s).g;
        col.b += texture2D(tDiffuse, uCenter + d * (s + ca)).b;
      }
      col /= float(n);
      // 暗角（受傷時偏紅）
      float v = smoothstep(1.05, 0.25, r);
      col *= mix(0.35, 1.0, v);
      col += vec3(0.9, 0.05, 0.12) * uHit * (1.0 - v) * 1.5;
      // 底片顆粒
      col += (hash(vUv * 731.0 + fract(uTime) * 61.0) - 0.5) * 0.025;
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }`,
};

export function createPost(renderer, scene, camera) {
  const composer = new EffectComposer(renderer);   // 預設 HalfFloat，保留 HDR 亮度給泛光用
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.5, 1.0);
  composer.addPass(bloom);
  const lens = new ShaderPass(LensShader);
  composer.addPass(lens);
  composer.addPass(new OutputPass());               // 色調映射（ACES）＋ sRGB 輸出
  return { composer, bloom, lens };
}

/* ---------- 反射環境：依隧道配色產生，讓金屬表面映出蟲洞的光 ---------- */
export function buildEnvironment(renderer, colA, colB) {
  const envScene = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { a: { value: colA.clone() }, b: { value: colB.clone() } },
    vertexShader: /* glsl */`varying vec3 vP; void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform vec3 a, b; varying vec3 vP;
      void main() {
        vec3 d = normalize(vP);
        float ang = atan(d.y, d.x);
        float stripes = pow(0.5 + 0.5 * sin(ang * 6.0), 10.0);
        float rings = pow(0.5 + 0.5 * sin(d.z * 14.0), 16.0);
        vec3 c = mix(a, b, 0.5 + 0.5 * d.y) * (0.12 + stripes * 1.6 + rings * 0.8);
        c += (b * 0.6 + 0.4) * 2.5 * pow(max(0.0, -d.z), 10.0);   // 前方的蟲洞出口
        c += vec3(1.0) * 1.2 * pow(max(0.0, d.y), 30.0);           // 頂部的一道亮光，給金屬一條高光
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const geo = new THREE.SphereGeometry(10, 48, 24);
  envScene.add(new THREE.Mesh(geo, mat));
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(envScene, 0.02);
  pm.dispose(); geo.dispose(); mat.dispose();
  return rt;
}

/* ---------- 程式生成的隕石貼圖（可無縫重複） ---------- */
function makeNoise(size, seed) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const octaves = [];
  for (let o = 0, p = 4; o < 5; o++, p *= 2) octaves.push({ p, g: Float32Array.from({ length: p * p }, rnd) });
  const smooth = (t) => t * t * (3 - 2 * t);
  return (x, y) => {   // x, y 介於 0~1，周期為 1
    let v = 0, amp = 0.5, tot = 0;
    for (const { p, g } of octaves) {
      const fx = x * p, fy = y * p, ix = Math.floor(fx), iy = Math.floor(fy);
      const tx = smooth(fx - ix), ty = smooth(fy - iy);
      const at = (i, j) => g[((j % p + p) % p) * p + ((i % p + p) % p)];
      const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
      v += amp * (a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty);
      tot += amp; amp *= 0.5;
    }
    return v / tot;
  };
}

function canvasTex(size, fill, srgb) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  fill(img.data);
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}

export function makeRockTextures(size = 256) {
  const n1 = makeNoise(size, 1234), n2 = makeNoise(size, 98765);
  const H = new Float32Array(size * size), R = new Float32Array(size * size), C = new Float32Array(size * size);
  // 隕石坑
  const craters = Array.from({ length: 26 }, () => ({ x: Math.random(), y: Math.random(), r: 0.02 + Math.random() ** 2 * 0.12 }));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size, i = y * size + x;
    let h = n1(u, v);
    for (const c of craters) {
      let dx = Math.abs(u - c.x), dy = Math.abs(v - c.y);
      dx = Math.min(dx, 1 - dx); dy = Math.min(dy, 1 - dy);
      const d = Math.hypot(dx, dy) / c.r;
      if (d < 1.3) h += d < 1 ? -0.35 * (1 - d * d) : 0.25 * (1 - Math.abs(d - 1.15) / 0.15) * (d < 1.3 ? 1 : 0);
    }
    H[i] = h;
    R[i] = n2(u * 1.0, v * 1.0);
    const ridge = 1 - Math.abs(n2(u, v) * 2 - 1);   // 岩漿裂縫
    C[i] = Math.max(0, (ridge - 0.9) / 0.1) ** 1.5;
  }
  let mn = Infinity, mx = -Infinity;
  for (const h of H) { mn = Math.min(mn, h); mx = Math.max(mx, h); }
  const norm = (h) => (h - mn) / (mx - mn);

  const albedo = canvasTex(size, (d) => {
    for (let i = 0; i < H.length; i++) {
      const h = norm(H[i]), t = R[i];
      d[i * 4] = 70 + h * 120 + t * 30; d[i * 4 + 1] = 62 + h * 105 + t * 18; d[i * 4 + 2] = 58 + h * 95; d[i * 4 + 3] = 255;
    }
  }, true);
  const bump = canvasTex(size, (d) => {
    for (let i = 0; i < H.length; i++) { const v = norm(H[i]) * 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  }, false);
  const rough = canvasTex(size, (d) => {
    for (let i = 0; i < H.length; i++) { const v = (0.6 + R[i] * 0.4) * 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  }, false);
  const magma = canvasTex(size, (d) => {
    for (let i = 0; i < H.length; i++) {
      const c = Math.min(1, C[i] + (1 - norm(H[i])) ** 6 * 0.6);
      d[i * 4] = c * 255; d[i * 4 + 1] = c * c * 200; d[i * 4 + 2] = c * c * c * 120; d[i * 4 + 3] = 255;
    }
  }, true);
  return { albedo, bump, rough, magma };
}

/* ---------- BOSS 護盾：邊緣發亮的能量殼（菲涅耳效果） ---------- */
export function shieldMaterial(color) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(color) }, uFlash: { value: 0 }, uTime: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        vP = position;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uFlash, uTime;
      varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main() {
        float f = pow(1.0 - abs(dot(normalize(vN), vV)), 3.0);
        float hex = pow(0.5 + 0.5 * sin(vP.x * 3.0 + uTime) * sin(vP.y * 3.0 - uTime * 0.7) * sin(vP.z * 3.0), 6.0);
        float scan = pow(0.5 + 0.5 * sin(vP.y * 2.0 - uTime * 3.0), 20.0);
        vec3 c = uColor * (f * 1.6 + hex * 0.08 + scan * 0.12) * (1.0 + uFlash * 4.0);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}
