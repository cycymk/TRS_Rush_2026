// 過渡用的 3D 低模：照設定圖的剪影用程式組出來，之後換成正式 glTF 模型時，
// 只要保留同樣的零件名稱（wingL/wingR/podL/podR/prongL/prongR…）就能沿用變形動畫。
import * as THREE from 'three';

const TAU = Math.PI * 2;
const damp = (k, dt) => 1 - Math.exp(-k * dt);

// 三種形態的零件姿勢（變形＝在這些姿勢之間平滑切換）
export const MODE_POSE = {
  cruise:  { wingYaw: 0.42, wingRoll: 0.0, podPitch: 0.0, prongZ: 0.0, finRoll: 0.35, bodyPitch: 0.0, spread: 1.0 },
  hover:   { wingYaw: 0.0, wingRoll: -0.18, podPitch: 0.95, prongZ: 0.25, finRoll: 0.9, bodyPitch: -0.12, spread: 1.18 },
  assault: { wingYaw: 0.15, wingRoll: 1.15, podPitch: 0.0, prongZ: -0.75, finRoll: 0.1, bodyPitch: 0.06, spread: 0.82 },
};

function mats() {
  return {
    hull: new THREE.MeshStandardMaterial({ color: 0x3a4152, metalness: 0.85, roughness: 0.32, envMapIntensity: 0.9 }),
    panel: new THREE.MeshStandardMaterial({ color: 0x8a93a6, metalness: 0.8, roughness: 0.28, envMapIntensity: 0.8 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x14171f, metalness: 0.7, roughness: 0.5 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x08121e, metalness: 0.3, roughness: 0.05, emissive: 0x0d3a66, emissiveIntensity: 0.8 }),
  };
}

/* ---------- 玩家飛船 ---------- */
// glow(color, scale, intensity) 由主程式傳入（共用發光貼圖）
export function buildPlayerShip(glow, additive) {
  const M = mats();
  const accent = new THREE.MeshStandardMaterial({ color: 0x0a0f18, emissive: 0x59d8ff, emissiveIntensity: 3 });
  const root = new THREE.Group();      // 位置／翻滾由主程式控制
  const body = new THREE.Group();      // 形態變化時整體微微俯仰
  root.add(body);

  // 機身：六角長柱＋尖鼻
  const fus = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.28, 2.1, 6), M.hull);
  fus.rotation.x = Math.PI / 2;
  body.add(fus);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.9, 6), M.panel);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -1.48;
  body.add(nose);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 8), M.glass);
  canopy.scale.set(1, 0.7, 2.2);
  canopy.position.set(0, 0.2, -0.55);
  body.add(canopy);
  // 背脊燈條（顏色跟著形態）
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 1.3), accent);
  spine.position.set(0, 0.25, 0.2);
  body.add(spine);
  const spineGlow = glow(0x59d8ff, 0.5, 1.6);
  spineGlow.position.set(0, 0.3, 0.1);
  body.add(spineGlow);

  // 兩具大引擎艙（懸停形態會往下轉）
  const pods = [];
  const engines = [];
  const nozzles = [];
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.48, -0.04, 0.2);
    body.add(pivot);
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 1.6, 8), M.hull);
    pod.rotation.x = Math.PI / 2;
    pivot.add(pod);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.05, 6, 16), M.panel);
    ring.position.z = 0.82;
    pivot.add(ring);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.2, 16), additive(0x8fe6ff, 1, {}, 2.4));
    disc.position.z = 0.86;
    pivot.add(disc);
    const core = glow(0x6fd0ff, 0.6, 1.5);
    core.position.z = 0.95;
    const plume = glow(0x3f8cff, 0.5, 0.9);
    plume.position.z = 1.5;
    pivot.add(core, plume);
    // 往前的尖刺（重裝形態會往前伸＝砲管）
    const prong = new THREE.Mesh(new THREE.ConeGeometry(0.07, 1.3, 5), M.dark);
    prong.rotation.x = -Math.PI / 2;
    prong.position.set(sx * 0.12, 0.1, -1.1);
    pivot.add(prong);
    const prongTip = glow(0xff5ce1, 0.35, 2);
    prongTip.position.set(sx * 0.12, 0.1, -1.8);
    prongTip.visible = false;
    pivot.add(prongTip);
    pods.push({ pivot, prong, prongTip, sx });
    engines.push({ core, plume });
    nozzles.push(new THREE.Vector3(sx * 0.48, -0.04, 1.1));
  }

  // 主翼（巡航後掠、懸停展開、重裝豎起）
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, -0.25); wingShape.lineTo(1.05, 0.25); wingShape.lineTo(1.1, 0.55); wingShape.lineTo(0, 0.5); wingShape.closePath();
  const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.05, bevelEnabled: false });
  wingGeo.rotateX(Math.PI / 2);
  const wings = [];
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.62, 0, 0.35);
    body.add(pivot);
    const wing = new THREE.Mesh(wingGeo, M.panel);
    wing.scale.x = sx;
    pivot.add(wing);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.03, 0.04), accent);
    edge.position.set(sx * 0.5, 0.04, 0.3);
    edge.rotation.y = sx * -0.42;
    pivot.add(edge);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.7, 4), M.dark);
    tip.rotation.x = -Math.PI / 2;
    tip.position.set(sx * 1.08, 0, -0.05);
    pivot.add(tip);
    // 下垂尾鰭
    const finPivot = new THREE.Group();
    finPivot.position.set(sx * 0.3, -0.05, 0.6);
    pivot.add(finPivot);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.5, 0.45), M.hull);
    fin.position.y = -0.25;
    finPivot.add(fin);
    wings.push({ pivot, finPivot, sx });
  }

  const bubble = new THREE.Mesh(new THREE.IcosahedronGeometry(1.9, 2), additive(0x66ffcc, 0.07, { wireframe: true }, 1.5));
  bubble.visible = false;
  root.add(bubble);

  const pose = { ...MODE_POSE.cruise };
  let target = MODE_POSE.cruise;
  return {
    group: root, body, engines, nozzles, bubble, spineGlow, accent,
    setMode(mode, color) {
      target = MODE_POSE[mode];
      accent.emissive.setHex(color);
      spineGlow.material.color.setHex(color).multiplyScalar(1.6);
      for (const p of pods) p.prongTip.visible = mode === 'assault';
    },
    // 每幀：零件往目前形態的姿勢補間＝變形動畫
    animate(dt, thrust) {
      const k = damp(9, dt);
      for (const key in pose) pose[key] += (target[key] - pose[key]) * k;
      body.rotation.x = pose.bodyPitch;
      for (const w of wings) {
        w.pivot.rotation.set(0, w.sx * pose.wingYaw, w.sx * pose.wingRoll);
        w.pivot.position.x = w.sx * 0.62 * pose.spread;
        w.finPivot.rotation.z = w.sx * pose.finRoll;
      }
      for (const p of pods) {
        p.pivot.rotation.x = pose.podPitch;
        p.pivot.position.x = p.sx * 0.48 * pose.spread;
        p.prong.position.z = -1.1 + pose.prongZ;
        p.prongTip.position.z = -1.8 + pose.prongZ;
      }
      for (const e of engines) {
        e.core.scale.setScalar((0.5 + Math.random() * 0.12) * thrust);
        e.plume.scale.set(0.4 * thrust, 0.4 * thrust, 1);
        e.plume.position.z = 1.3 + thrust * 0.25;
      }
    },
  };
}

/* ---------- 小敵人（無人機） ---------- */
let droneTemplate = null;
export function buildDrone(glow) {
  if (!droneTemplate) {
    const M = mats();
    const red = new THREE.MeshStandardMaterial({ color: 0x1a0606, emissive: 0xff2238, emissiveIntensity: 3.2 });
    const g = new THREE.Group();
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 1), M.hull);
    core.material = M.hull.clone();
    core.material.flatShading = true;
    g.add(core);
    // 前方一圈裝甲環＋紅眼
    const visor = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.07, 6, 18), M.panel);
    visor.position.z = 0.5;
    g.add(visor);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), red);
    eye.position.z = 0.52;
    g.add(eye);
    const eyeGlow = glow(0xff2a3a, 1.0, 2.6);
    eyeGlow.position.z = 0.7;
    eyeGlow.name = 'eye';
    g.add(eyeGlow);
    // 四支機械臂（X 形）＋紅圈推進器
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * TAU) / 4;
      const arm = new THREE.Group();
      arm.rotation.z = a;
      g.add(arm);
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.16, 0.2), M.dark);
      beam.position.x = 0.85;
      arm.add(beam);
      const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.2, 0.5, 8), M.hull);
      pod.rotation.x = Math.PI / 2;
      pod.position.x = 1.32;
      arm.add(pod);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.04, 6, 14), red);
      ring.position.set(1.32, 0, 0.26);
      arm.add(ring);
      const jet = glow(0xff3040, 0.55, 2);
      jet.position.set(1.32, 0, 0.32);
      jet.name = 'jet';
      arm.add(jet);
      // 兩臂之間的尖刺
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.6, 4), M.dark);
      spike.rotation.z = -Math.PI / 2;
      spike.position.set(0.8, 0, 0);
      const spikeHolder = new THREE.Group();
      spikeHolder.rotation.z = Math.PI / 4;
      spikeHolder.add(spike);
      arm.add(spikeHolder);
    }
    droneTemplate = g;
  }
  const g = droneTemplate.clone(true);
  const eye = g.getObjectByName('eye');
  const jets = [];
  g.traverse((o) => { if (o.name === 'jet') jets.push(o); });
  return { g, eye, jets };
}
