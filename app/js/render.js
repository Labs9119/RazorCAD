// Photorealistic rendering of the part as the view shows it: each body in a look (polished or brushed metal, plastic,
// rubber, paint, glass…) of its colour, lit by a scene (studio, showroom, workshop, sky, sunset…) and a key light casting soft shadows on a
// floor, tone mapped; decals (pictures on flat faces) on it. One frame, at the size asked, as a PNG data URL.
import * as THREE from 'three';
import { boxMapped, boxMappedDepth, tileTexture } from './appearances.js';

export const LOOKS = {
  auto: { name: 'From the material' },
  polished: { name: 'Polished metal', metalness: 1, roughness: 0.08 },
  brushed: { name: 'Brushed metal', metalness: 1, roughness: 0.32 },
  cast: { name: 'Cast / machined metal', metalness: 0.9, roughness: 0.55 },
  paint: { name: 'Gloss paint', metalness: 0.15, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06 },
  powder: { name: 'Powder coat (satin)', metalness: 0, roughness: 0.55, clearcoat: 0.2, clearcoatRoughness: 0.5 },
  glossyPlastic: { name: 'Glossy plastic', metalness: 0, roughness: 0.18, clearcoat: 0.5, clearcoatRoughness: 0.1 },
  plastic: { name: 'Matte plastic', metalness: 0, roughness: 0.6 },
  rubber: { name: 'Rubber', metalness: 0, roughness: 0.92 },
  glass: { name: 'Glass', metalness: 0, roughness: 0.02, transmission: 1, ior: 1.5, thickness: 4 },
};
// (a material's look when the body is left at 'From the material')
const BY_MATERIAL = { steel: 'cast', stainless: 'brushed', al6061: 'brushed', brass: 'polished', copper: 'polished', titanium: 'brushed', abs: 'glossyPlastic', pla: 'plastic', nylon: 'plastic' };
export const lookFor = (look, materialId) => (look && look !== 'auto' && LOOKS[look] ? look : BY_MATERIAL[materialId] || 'powder');

// The scenes a render can be set in: the environment that lights and reflects in the part, the background behind it
// (a colour, a gradient from top to bottom, or 'place': the surroundings themselves, a little out of focus) and the
// key light's colour and strength.
export const SCENES = {
  studio: { name: 'Studio', bg: 0xe9ebee },
  white: { name: 'Studio on white', bg: 0xffffff },
  cove: { name: 'Soft gradient (infinity cove)', bg: [0xffffff, 0xd3d8de] },
  dark: { name: 'Dark studio', bg: [0x34383e, 0x0b0c0e], key: [0xffffff, 1.3] },
  showroom: { name: 'Showroom', bg: [0xf4f0ea, 0xd6cdc1], key: [0xfff1de, 1.1] },
  sky: { name: 'Outdoor sky', bg: 0xdfe9f4 },
  overcast: { name: 'Overcast', bg: [0xd9dde2, 0xaeb3b9], key: [0xffffff, 0.55] },
  sunset: { name: 'Sunset', bg: [0x4f6c9c, 0xf0b07a], key: [0xffb36b, 1.25] },
  night: { name: 'Night (blue)', bg: [0x22324f, 0x05080f], key: [0xb8ccff, 1] },
  outdoors: { name: 'Outdoors (park)', bg: 'place', key: [0xfff2dc, 1.3] },
  forest: { name: 'Forest', bg: 'place', key: [0xfff0c8, 1.05] },
  office: { name: 'Office', bg: 'place', key: [0xffffff, 0.9] },
  workshop: { name: 'Workshop', bg: 'place', key: [0xf2f4ff, 1] },
  store: { name: 'Store', bg: 'place', key: [0xffffff, 0.9] },
};

// A scene's background for a render: its colour, its gradient as a texture filling the frame, or the place itself (a
// cube of it as seen from the part, sharper than the lighting's).
function background(renderer, id) {
  const bg = (SCENES[id] || SCENES.studio).bg;
  if (bg === 'place') {
    const rt = new THREE.WebGLCubeRenderTarget(1024, { type: THREE.HalfFloatType }), scene = envScene(id);
    new THREE.CubeCamera(0.1, 1000, rt).update(renderer, scene);
    disposeScene(scene);
    rt.texture.needsPMREMUpdate = true; // (blurred for the background: made into a PMREM by the renderer)
    rt.texture.dispose = () => rt.dispose();
    return rt.texture;
  }
  if (!Array.isArray(bg)) return new THREE.Color(bg);
  const cv = document.createElement('canvas');
  cv.width = 2; cv.height = 256;
  const ctx = cv.getContext('2d'), gr = ctx.createLinearGradient(0, 0, 0, 256), hex = (c) => '#' + c.toString(16).padStart(6, '0');
  gr.addColorStop(0, hex(bg[0])); gr.addColorStop(1, hex(bg[1]));
  ctx.fillStyle = gr; ctx.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// A scene's environment (what lights the part and shows in its reflections) as a PMREM texture
export function environment(renderer, kind) {
  const scene = envScene(kind), pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(scene, 0.035);
  pm.dispose();
  disposeScene(scene);
  return rt;
}
const disposeScene = (scene) => scene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });

// A scene's surroundings, built of shapes, some glowing (the lights), seen from the part's place (the floor 5 below):
// a studio's soft grey room with a big light overhead and panels at the sides, a sky's dome and sun, a forest's trees,
// an office's desks and windows, a store's shelves…
function envScene(kind) {
  const scene = new THREE.Scene();
  const glow = (k) => (Array.isArray(k) ? new THREE.Color(...k) : new THREE.Color(k, k, k));
  const room = (w, h, d, color) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color, side: THREE.BackSide })); m.position.y = h / 2 - 5; scene.add(m); };
  const panel = (w, h, at, look, k) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: glow(k), side: THREE.DoubleSide })); m.position.set(...at); m.lookAt(...look); scene.add(m); };
  const sun = (at, k, size = 4) => { const m = new THREE.Mesh(new THREE.SphereGeometry(size, 16, 8), new THREE.MeshBasicMaterial({ color: glow(k) })); m.position.set(...at); scene.add(m); };
  // (a dome, its colour from the top through the horizon to the ground, the horizon's colour spread over `band`)
  const dome = (top, horizon, ground, band = 3) => {
    const g = new THREE.SphereGeometry(100, 32, 16), cols = [], c = new THREE.Color(), h = glow(horizon);
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) { const y = pos.getY(i) / 100; c.copy(glow(y > 0 ? top : ground)).lerp(h, Math.max(0, 1 - Math.abs(y) * band)); cols.push(c.r, c.g, c.b); }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  };
  const rgb = (c) => new THREE.Color(c).toArray();
  // (solid things: a box standing on y0 (shared geometry and materials), the ground, trees; places drawn about
  // 5 units to the metre of their size)
  const unit = new THREE.BoxGeometry(1, 1, 1), mats = new Map();
  const mat = (c) => { const k = Array.isArray(c) ? c.join() : c; if (!mats.has(k)) mats.set(k, new THREE.MeshBasicMaterial({ color: Array.isArray(c) ? glow(c) : c })); return mats.get(k); };
  const block = (w, h, d, x, y0, z, c) => { const m = new THREE.Mesh(unit, mat(c)); m.scale.set(w, h, d); m.position.set(x, y0 + h / 2, z); scene.add(m); return m; };
  const ground = (r, c) => { const m = new THREE.Mesh(new THREE.CircleGeometry(r, 48), mat(c)); m.rotation.x = -Math.PI / 2; m.position.y = -4.95; scene.add(m); };
  const ball = (r, x, y, z, c, sy = 1) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 10), mat(c)); m.scale.y = sy; m.position.set(x, y, z); scene.add(m); };
  const cone = (r, h, x, y0, z, c) => { const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 10), mat(c)); m.position.set(x, y0 + h / 2, z); scene.add(m); };
  let seed = 7;
  const rand = (a = 0, b = 1) => { seed = (seed * 16807) % 2147483647; return a + ((seed - 1) / 2147483646) * (b - a); };
  const around = (n, r0, r1, fn) => { for (let i = 0; i < n; i++) { const a = rand(0, Math.PI * 2), r = rand(r0, r1); fn(Math.cos(a) * r, Math.sin(a) * r, i); } };
  if (kind === 'outdoors') {
    dome(rgb(0x5f97d6), [1.3, 1.42, 1.55], rgb(0x55704a), 3.5);
    sun([40, 70, 30], [34, 31, 27]);
    ground(99, 0x5c8a3c);
    block(200, 0.05, 7, 0, -4.95, 18, 0xc4b494);
    for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2 + 0.3; ball(rand(22, 34), Math.cos(a) * 94, -5, Math.sin(a) * 94, 0x7f9d86, 0.3); }
    for (const [x, y, z, r] of [[-30, 60, -50, 12], [-18, 62, -54, 9], [50, 55, -20, 14], [10, 66, 60, 11]]) ball(r, x, y, z, [1.7, 1.75, 1.8], 0.35);
    around(26, 28, 80, (x, z) => { const h = rand(5, 8); block(0.9, h, 0.9, x, -5, z, 0x5a4230); ball(rand(3.5, 6), x, -5 + h + 2.5, z, rand() < 0.5 ? 0x3f6b2e : 0x4c7a34); });
  } else if (kind === 'forest') {
    dome([0.8, 1.05, 1.4], [0.95, 1.1, 0.85], rgb(0x3b3426), 2.5);
    sun([25, 80, 30], [22, 20, 14], 3);
    ground(99, 0x5c5139);
    around(170, 12, 95, (x, z) => { const h = rand(28, 50); block(1.1, h * 0.3, 1.1, x, -5, z, 0x4a3626); cone(rand(4, 7), h * 0.8, x, -5 + h * 0.2, z, rand() < 0.5 ? 0x22402a : 0x2e4f2f); });
    around(30, 14, 60, (x, z) => ball(rand(1.2, 2.5), x, -4.6, z, 0x3d5a2a, 0.6));
  } else if (kind === 'office') {
    room(90, 14, 70, 0xc5c8ca);
    block(90, 0.05, 70, 0, -5, 0, 0x4d535b);
    for (let x = -36; x <= 36; x += 12) for (let z = -24; z <= 24; z += 12) panel(5, 5, [x, 8.9, z], [x, 0, z], 5);
    panel(84, 9, [0, 3.5, -34.8], [0, 3.5, 0], [2.3, 2.7, 3.3]);
    for (let x = -40; x <= 40; x += 10) block(0.5, 10, 0.4, x, -1, -34.5, 0x3b3f44);
    block(90, 4, 0.5, 0, -5, -34.6, 0xb5b8ba);
    for (const [x, z, r] of [[-20, -14, 0], [0, -17, 0], [20, -14, 0], [-24, 14, 1], [22, 16, 1]]) {
      const f = r ? 1 : -1;
      block(10, 0.4, 5, x, -1.6, z, 0xd8cfc0);
      block(0.4, 3.4, 4.6, x - 4.6, -5, z, 0x7c8288); block(0.4, 3.4, 4.6, x + 4.6, -5, z, 0x7c8288);
      block(3.2, 2, 0.2, x, -1.2, z + f * 1.6, 0x1d1f22);
      block(3, 2.4, 3, x, -5, z - f * 3.6, 0x2b2e33); block(3, 3.2, 0.5, x, -2.6, z - f * 5, 0x2b2e33);
    }
    for (const [x, z] of [[-40, -28], [40, -28], [-6, 30]]) { block(1.8, 2, 1.8, x, -5, z, 0x8b5a3c); ball(2.2, x, -0.5, z, 0x3f7a3a, 1.2); }
    for (const z of [-10, 0, 10]) block(3, 7, 9.5, 43.4, -5, z, 0xa7abaf);
    panel(16, 6, [-44.9, 2, 0], [0, 2, 0], 1.5);
  } else if (kind === 'workshop') {
    room(90, 22, 70, 0x57544e);
    block(90, 0.05, 70, 0, -5, 0, 0x77736c);
    for (const [w, d, x, z] of [[90, 0.3, 0, -34.8], [90, 0.3, 0, 34.8], [0.3, 70, -44.8, 0], [0.3, 70, 44.8, 0]]) block(w, 6, d, x, -5, z, 0x3e5566);
    for (const x of [-30, -10, 10, 30]) panel(1.2, 50, [x, 16.8, 0], [x, 0, 0], 9);
    panel(26, 10, [0, 9, -34.8], [0, 9, 0], [3.4, 3.8, 4.6]);
    block(26, 4.2, 5.5, -2, -5, -30, 0x3a3a3a); block(26, 0.8, 6, -2, -0.8, -30, 0x8a6a45);
    block(30, 9, 0.3, -2, 0, -34.4, 0x8d7b60);
    block(8, 10, 7, -32, -5, 10, 0x5e7a68); block(6, 4, 6, -32, 5, 8, 0x4a5f52);
    block(18, 6, 5, 30, -5, 14, 0x6a7f8c); block(5, 4, 5, 23, 1, 14, 0x55666f);
    block(7, 9, 3, -18, -5, 32.5, 0xa8322b);
    for (const z of [-20, -8, 4]) { block(4, 16, 10, 42, -5, z, 0x6d7378); for (const y of [-1, 4, 9]) block(3.5, 2.5, 8.5, 41.6, y, z, 0xd9822b); }
  } else if (kind === 'store') {
    room(100, 16, 80, 0xeeeeec);
    block(100, 0.05, 80, 0, -5, 0, 0xcfcdc8);
    for (let x = -42; x <= 42; x += 12) panel(1.2, 70, [x, 10.9, 0], [x, 0, 0], 8);
    const goods = [0xd94a3a, 0x3a7bd5, 0xf2c230, 0x4caf50, 0xff8c1a, 0xf4f4f4, 0x8e44ad, 0x1abc9c];
    for (const z of [-28, -16, 16, 28]) for (const [x0, x1] of [[-44, -8], [8, 44]]) {
      block(x1 - x0, 9, 3, (x0 + x1) / 2, -5, z, 0xd2d4d6);
      for (const side of [-1.6, 1.6]) for (const y of [-4, -1, 2]) for (let x = x0 + 0.3; x < x1 - 1.5;) { const w = rand(1.1, 2.4); block(w - 0.15, rand(1.5, 2.6), 0.8, x + w / 2, y, z + side, goods[Math.floor(rand(0, goods.length))]); x += w; }
      block(x1 - x0, 1.4, 3.2, (x0 + x1) / 2, 6, z, 0xc23b2c);
    }
    for (const z of [-30, -15, 0, 15, 30]) { block(2, 12, 12, 49, -5, z, 0xbfc4c8); panel(10, 9, [47.9, 2, z], [0, 2, z], [2.4, 2.6, 2.8]); }
    panel(40, 2.5, [0, 12.5, -39.9], [0, 12.5, 0], [1.8, 0.3, 0.25]);
  } else if (kind === 'sky') {
    dome(rgb(0x9cc4ee), rgb(0xf4f7fb), rgb(0x6b6158));
    sun([40, 70, 30], [30, 28, 25]);
  } else if (kind === 'overcast') {
    dome([1.5, 1.55, 1.6], [1.25, 1.28, 1.3], rgb(0x55534f), 2);
    panel(120, 120, [0, 90, 0], [0, 0, 0], 1.8);
  } else if (kind === 'sunset') {
    dome([0.45, 0.65, 1.15], [1.8, 0.95, 0.45], [0.42, 0.33, 0.28], 4);
    sun([70, 9, 25], [40, 20, 8], 5);
  } else if (kind === 'dark') {
    room(60, 30, 60, 0x060708);
    panel(24, 14, [0, 24.5, 0], [0, 0, 0], 7);
    panel(3, 22, [-28, 10, 6], [0, 8, 0], 9);
    panel(3, 22, [28, 10, 6], [0, 8, 0], 9);
    panel(16, 3, [0, 14, -29], [0, 8, 0], 3);
  } else if (kind === 'showroom') {
    room(80, 26, 70, 0x8a8277);
    for (const x of [-24, -8, 8, 24]) for (const z of [-18, 0, 18]) sun([x, 20.5, z], [14, 12.5, 10.5], 1.4);
    panel(50, 10, [0, 9, -34.5], [0, 9, 0], [2.6, 2.4, 2.1]);
    panel(20, 12, [39.5, 10, 0], [0, 10, 0], 2);
  } else if (kind === 'night') {
    room(60, 30, 60, 0x0b1222);
    panel(30, 16, [0, 24.5, 0], [0, 0, 0], [2.4, 3, 4.6]);
    panel(6, 22, [-28, 10, 4], [0, 8, 0], [2.5, 4.5, 10]);
    panel(6, 22, [28, 10, -4], [0, 8, 0], [9, 5, 2.2]);
    panel(30, 10, [0, 10, 29], [0, 8, 0], [1, 1.3, 2]);
  } else if (kind === 'cove') {
    room(60, 30, 60, 0xa9adb3);
    panel(34, 22, [0, 24.5, 0], [0, 0, 0], 5);
    panel(14, 18, [-29, 12, 8], [0, 8, 0], 4);
    panel(14, 18, [29, 12, -8], [0, 8, 0], 3.5);
    panel(30, 14, [0, 12, 29], [0, 8, 0], 2.5);
  } else {
    room(60, 30, 60, 0x5a5d62);
    panel(30, 18, [0, 24.5, 0], [0, 0, 0], 6);
    panel(10, 16, [-29, 12, 8], [0, 8, 0], 6);
    panel(10, 16, [29, 12, -8], [0, 8, 0], 4);
    panel(20, 8, [0, 10, -29], [0, 8, 0], 2.5);
  }
  return scene;
}

// The part's decals in the view (a group of textured quads on the faces), replaced each time.
export function showDecals(vp, list) {
  if (vp._decals) { vp.scene.remove(vp._decals); vp._decals.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); }); vp._decals = null; }
  if (!list?.length) return;
  const g = new THREE.Group(), R = vp.bodyGeo?.boundingSphere?.radius || 50;
  for (const d of list) {
    const img = new Image(), tex = new THREE.Texture(img);
    img.onload = () => { tex.needsUpdate = true; };
    img.src = d.src;
    tex.colorSpace = THREE.SRGBColorSpace;
    const q = new THREE.Mesh(new THREE.PlaneGeometry(d.w, d.h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, polygonOffset: true, polygonOffsetFactor: -4, depthWrite: false }));
    const n = new THREE.Vector3(...d.n).normalize();
    q.position.copy(new THREE.Vector3(...d.p).addScaledVector(n, R * 1e-4));
    q.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    q.rotateZ(((d.angle || 0) * Math.PI) / 180);
    q.userData.decal = d.id;
    g.add(q);
  }
  vp._decals = g;
  vp.scene.add(g);
}

// Render the viewport's bodies: opts { width, height, looks: [look per body], colors: [colour per body], hidden: Set
// of body indices, env: a scene's id (SCENES), floor, exposure, background (CSS colour or null: the scene's),
// decals: [{ src, p, n, w, h, angle }] }. Resolves with { url, width, height }.
// opts.groups: [{ index: Uint32Array (triangles' vertex indices), spec }] (appearances.js) in place of the looks and
// colours by body: each its own material, with its texture and holes (and the holes in the shadows).
export async function renderImage(vp, opts = {}) {
  const width = Math.max(16, Math.round(opts.width || vp.width)), height = Math.max(16, Math.round(opts.height || vp.height));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: true });
  try {
    r.setPixelRatio(1);
    r.setSize(width, height, false);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = opts.exposure ?? 1;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = opts.floor !== false;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    const sc = SCENES[opts.env] ? opts.env : 'studio', scene = new THREE.Scene(), env = environment(r, sc);
    scene.environment = env.texture;
    // (a place behind the part: drawn first, its own scene, through a perspective camera facing the same way (a cube
    // background through a parallel view would only fill a few pixels))
    const place = !opts.background && SCENES[sc].bg === 'place' ? new THREE.Scene() : null;
    if (place) { place.background = background(r, sc); place.backgroundBlurriness = 0.03; } else scene.background = opts.background ? new THREE.Color(opts.background) : background(r, sc);
    // (the bodies, each its own mesh sharing the view's points and normals)
    const geo = vp.bodyGeo, mesh = vp.mesh, tris = mesh?.triangles;
    if (!geo || !tris) throw new Error('There is no model to render');
    const box = new THREE.Box3(), group = new THREE.Group();
    for (const { index, spec } of opts.groups || []) {
      if (!index.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', geo.getAttribute('position'));
      g.setAttribute('normal', geo.getAttribute('normal'));
      g.setIndex(new THREE.BufferAttribute(index, 1));
      const tex = spec.tex ? tileTexture(spec) : null, pb = spec.pbr || {};
      const m = new THREE.MeshPhysicalMaterial({ color: tex ? 0xffffff : spec.color, envMapIntensity: 1, side: THREE.DoubleSide, metalness: pb.metalness ?? 0, roughness: pb.roughness ?? 0.5, clearcoat: pb.clearcoat || 0, clearcoatRoughness: pb.clearcoatRoughness ?? 0.1, transmission: pb.transmission || 0, ior: pb.ior ?? 1.5, thickness: pb.thickness || 0 });
      const o = new THREE.Mesh(g, tex ? boxMapped(m, tex, spec) : m);
      if (tex && spec.cut) o.customDepthMaterial = boxMappedDepth(tex, spec);
      o.castShadow = !pb.transmission; o.receiveShadow = true;
      group.add(o);
      g.computeBoundingBox(); box.union(g.boundingBox);
    }
    if (!opts.groups) (vp.bodies?.length ? vp.bodies : [{ triStart: 0, triCount: tris.length }]).forEach((b, bi) => {
      if (opts.hidden?.has(bi)) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', geo.getAttribute('position'));
      g.setAttribute('normal', geo.getAttribute('normal'));
      g.setIndex(new THREE.BufferAttribute(tris.slice(b.triStart, b.triStart + b.triCount), 1));
      const L = LOOKS[opts.looks?.[bi]] || LOOKS.powder, { name: _n, ...props } = L;
      const m = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(opts.colors?.[bi] ?? 0xc3cad4), envMapIntensity: 1, side: THREE.DoubleSide, ...props });
      const o = new THREE.Mesh(g, m);
      o.castShadow = true; o.receiveShadow = true;
      group.add(o);
      g.computeBoundingBox(); box.union(g.boundingBox);
    });
    scene.add(group);
    const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3()), R = Math.max(size.length() / 2, 1e-3);
    // (decals: a picture on a flat face, just off it)
    for (const d of opts.decals || []) {
      const img = await new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = d.src; });
      if (!img) continue;
      const tex = new THREE.Texture(img); tex.needsUpdate = true; tex.colorSpace = THREE.SRGBColorSpace;
      const q = new THREE.Mesh(new THREE.PlaneGeometry(d.w, d.h), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.6, metalness: 0, envMapIntensity: 0.6, polygonOffset: true, polygonOffsetFactor: -4 }));
      const n = new THREE.Vector3(...d.n).normalize();
      q.position.copy(new THREE.Vector3(...d.p).addScaledVector(n, R * 1e-4));
      q.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      q.rotateZ(((d.angle || 0) * Math.PI) / 180);
      q.receiveShadow = true;
      scene.add(q);
    }
    // (a key light casting the shadow, from above and behind the camera's right; the floor under the model)
    const cam = vp.viewCam.clone();
    if (cam.isPerspectiveCamera) { cam.aspect = width / height; } else {
      const h = (cam.top - cam.bottom) / 2, cy = (cam.top + cam.bottom) / 2, cx = (cam.left + cam.right) / 2, w = (h * width) / height;
      cam.left = cx - w; cam.right = cx + w; cam.top = cy + h; cam.bottom = cy - h;
    }
    cam.updateProjectionMatrix();
    // (the place seen nearly level, the way the view faces: looking down on the part would show only the floor)
    const placeCam = new THREE.PerspectiveCamera(55, width / height, 0.1, 10);
    const draw = () => {
      if (!place) { r.render(scene, cam); return; }
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion), pitch = Math.max(-0.12, Math.min(0.35, Math.asin(Math.max(-1, Math.min(1, f.y)))));
      const h = Math.hypot(f.x, f.z) > 1e-6 ? new THREE.Vector2(f.x, f.z).normalize() : new THREE.Vector2(0, -1);
      placeCam.position.set(0, 0, 0);
      placeCam.lookAt(h.x * Math.cos(pitch), Math.sin(pitch), h.y * Math.cos(pitch));
      r.render(place, placeCam);
      r.autoClear = false; r.clearDepth(); r.render(scene, cam); r.autoClear = true;
    };
    let key = null, keyAt = null;
    if (opts.floor !== false) {
      const [kc, ki] = SCENES[sc].key || [0xffffff, 1.15];
      key = new THREE.DirectionalLight(kc, ki);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      key.position.copy(centre).add(new THREE.Vector3(0, R * 3, 0)).addScaledVector(right, R * 1.2);
      key.target.position.copy(centre);
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      Object.assign(key.shadow.camera, { left: -R * 1.6, right: R * 1.6, top: R * 1.6, bottom: -R * 1.6, near: R * 0.1, far: R * 8 });
      key.shadow.radius = 6; key.shadow.bias = -R * 1e-5;
      scene.add(key, key.target);
      keyAt = key.position.clone();
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(R * 40, R * 40), new THREE.ShadowMaterial({ opacity: 0.28 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(centre.x, box.min.y - R * 1e-3, centre.z);
      floor.receiveShadow = true;
      scene.add(floor);
    } else scene.add(new THREE.HemisphereLight(0xffffff, 0x808080, 0.6));
    // (passes: each with the camera moved by part of a pixel (smooth edges) and the key light by part of its size (soft
    // shadows), averaged; Halton points spread them evenly)
    const n = Math.max(1, Math.min(256, Math.round(opts.samples ?? 1)));
    let url;
    if (n === 1) { draw(); url = canvas.toDataURL('image/png'); } else {
      const gl = r.getContext(), acc = new Float32Array(width * height * 4), px = new Uint8Array(width * height * 4);
      const halton = (i, b) => { let f = 1, x = 0; while (i > 0) { f /= b; x += f * (i % b); i = Math.floor(i / b); } return x; };
      const lu = new THREE.Vector3(), lv = new THREE.Vector3();
      if (key) { const ld = key.position.clone().sub(key.target.position).normalize(); lu.crossVectors(ld, Math.abs(ld.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize(); lv.crossVectors(ld, lu); }
      for (let k = 0; k < n; k++) {
        const jx = halton(k + 1, 2) - 0.5, jy = halton(k + 1, 3) - 0.5;
        cam.setViewOffset(width, height, jx, jy, width, height);
        if (key) { const a = 2 * Math.PI * halton(k + 1, 5), rr = Math.sqrt(halton(k + 1, 7)) * R * 0.35; key.position.copy(keyAt).addScaledVector(lu, Math.cos(a) * rr).addScaledVector(lv, Math.sin(a) * rr); }
        draw();
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, px);
        for (let i = 0; i < acc.length; i++) acc[i] += px[i];
        opts.onPass?.(k + 1, n);
        if (k % 8 === 7) await new Promise((res) => setTimeout(res, 0));
      }
      cam.clearViewOffset();
      // (readPixels reads bottom row first: turned the right way up)
      const out = document.createElement('canvas'); out.width = width; out.height = height;
      const ctx = out.getContext('2d'), im = ctx.createImageData(width, height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const s = ((height - 1 - y) * width + x) * 4, d = (y * width + x) * 4; for (let c = 0; c < 4; c++) im.data[d + c] = Math.round(acc[s + c] / n); }
      ctx.putImageData(im, 0, 0);
      url = out.toDataURL('image/png');
    }
    env.dispose();
    (place || scene).background?.dispose?.();
    group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); o.customDepthMaterial?.dispose(); } });
    return { url, width, height };
  } finally { r.dispose(); r.forceContextLoss?.(); }
}
