// Photorealistic rendering of the part as the view shows it: each body in a look (polished or brushed metal, plastic,
// rubber, paint, glass…) of its colour, lit by a scene (a studio, or a photographed place: a workshop, a warehouse, a
// garden, a sunset…) and a key light casting soft shadows on a floor, tone mapped; decals (pictures on flat faces) on
// it. One frame, at the size asked, as a PNG data URL.
import * as THREE from 'three';
import { boxMapped, boxMappedDepth, tileTexture } from './appearances.js';
import { makeSpots } from './lights.js';
import { parseHDR } from './hdr.js';

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
// (a colour, or a gradient from top to bottom) and the key light's colour and strength. photo: a photographed place
// (a 360° HDR photograph, app/scenes/<id>.hdr and .jpg, made by tools/make_scenes.py from CC0 photographs from Poly
// Haven): it lights the part and is the backdrop behind it; sun: its brightest direction [azimuth, elevation] in
// degrees (its sun, or its windows and lights), where the key light is put (the place turned so it is at the view's
// right, then by turn (degrees) more: its best side behind the part).
export const SCENES = {
  studio: { name: 'Studio', bg: 0xe9ebee },
  white: { name: 'Studio on white', bg: 0xffffff },
  cove: { name: 'Soft gradient (infinity cove)', bg: [0xffffff, 0xd3d8de] },
  dark: { name: 'Dark studio', bg: [0x34383e, 0x0b0c0e], key: [0xffffff, 1.3] },
  showroom: { name: 'Showroom', bg: [0xf4f0ea, 0xd6cdc1], key: [0xfff1de, 1.1] },
  night: { name: 'Night (blue)', bg: [0x22324f, 0x05080f], key: [0xb8ccff, 1] },
  sky: { name: 'Outdoors: field, clear sky', photo: true, sun: [36.6, 8.4], key: [0xfff4e2, 0.9] },
  outdoors: { name: 'Outdoors: garden', photo: true, sun: [36.6, 64.7], turn: 150, key: [0xfff6e8, 0.9] },
  forest: { name: 'Forest (misty)', photo: true, sun: [75.9, 42.2], turn: 150, key: [0xffffff, 0.35] },
  overcast: { name: 'Overcast (hillside)', photo: true, sun: [30.9, 19.7], turn: 150, key: [0xffffff, 0.3] },
  sunset: { name: 'Sunset (waterfront)', photo: true, sun: [36.6, 2.8], turn: 150, key: [0xffc58f, 0.8] },
  workshop: { name: 'Workshop (machine shop)', photo: true, sun: [47.8, 25.3], key: [0xfff8f0, 0.45] },
  warehouse: { name: 'Warehouse', photo: true, sun: [2.8, 36.6], key: [0xfffaf2, 0.45] },
  office: { name: 'Office', photo: true, sun: [36.6, 70.3], key: [0xfff8ee, 0.45] },
  store: { name: 'Store (home décor)', photo: true, sun: [-75.9, 14.1], key: [0xfff6ea, 0.45] },
};

// The photographed places, loaded once: light (the HDR, an equirectangular texture) and backdrop (the photograph).
const photos = new Map();
const scenesUrl = (f) => new URL(`../scenes/${f}`, import.meta.url).href;
export const photoReady = (id) => !SCENES[id]?.photo || !!photos.get(id + ':light')?.tex;
// (resolves with the scene's lighting texture, and with backdrop: its photograph too)
export async function loadScene(id, backdrop = false) {
  if (!SCENES[id]?.photo) return null;
  const once = (key, make) => {
    let p = photos.get(key);
    if (!p) { p = { promise: make().then((tex) => { p.tex = tex; return tex; }, (e) => { photos.delete(key); throw e; }) }; photos.set(key, p); }
    return p.promise;
  };
  const light = once(id + ':light', async () => {
    const res = await fetch(scenesUrl(id + '.hdr'));
    if (!res.ok) throw new Error(`The ${SCENES[id].name} scene could not be loaded (${res.status})`);
    const { width, height, data } = parseHDR(await res.arrayBuffer());
    const t = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
    Object.assign(t, { mapping: THREE.EquirectangularReflectionMapping, colorSpace: THREE.LinearSRGBColorSpace, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false, needsUpdate: true });
    return t;
  });
  if (!backdrop) return light;
  await once(id + ':backdrop', async () => {
    const t = await new THREE.TextureLoader().loadAsync(scenesUrl(id + '.jpg'));
    Object.assign(t, { mapping: THREE.EquirectangularReflectionMapping, colorSpace: THREE.SRGBColorSpace, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    return t;
  });
  return light;
}


// A scene's background for a render: its colour, or its gradient as a texture filling the frame.
function background(id) {
  const bg = (SCENES[id] || SCENES.studio).bg ?? 0xe9ebee;
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

// A scene's environment (what lights the part and shows in its reflections) as a PMREM texture (a photographed place
// not loaded yet (loadScene): the studio's)
export function environment(renderer, kind) {
  const pm = new THREE.PMREMGenerator(renderer), photo = SCENES[kind]?.photo && photos.get(kind + ':light')?.tex;
  // (through a copy of the texture, let go after: each renderer that uses the cached one would keep a hold on it)
  if (photo) { const t = photo.clone(), rt = pm.fromEquirectangular(t); t.dispose(); pm.dispose(); return rt; }
  const scene = envScene(SCENES[kind]?.photo ? 'studio' : kind);
  const rt = pm.fromScene(scene, 0.035);
  pm.dispose();
  disposeScene(scene);
  return rt;
}
const disposeScene = (scene) => scene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });

// A studio's surroundings, built of shapes, some glowing (the lights), seen from the part's place (the floor 5 below):
// a soft grey room with a big light overhead and panels at the sides, a dark one, a showroom…
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
  if (kind === 'dark') {
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

// A contact shadow under the part (on the floor at box.min.y): the part seen from below the floor through a parallel
// camera looking up, each point the darker the nearer the floor, blurred, on a plane on the floor (soft, darkest where
// the part meets the floor, as the light from all round leaves it). Added to scene; returns { dispose }.
function contactShadow(r, scene, group, box, R) {
  const res = 512, size = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) + R * 1.2, height = Math.max(R * 0.35, (box.max.y - box.min.y) * 0.5);
  const opt = { type: THREE.HalfFloatType };
  const rt = new THREE.WebGLRenderTarget(res, res, opt), rt2 = new THREE.WebGLRenderTarget(res, res, opt);
  const cam = new THREE.OrthographicCamera(-size / 2, size / 2, size / 2, -size / 2, 0, height);
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2, y0 = box.min.y;
  cam.position.set(cx, y0, cz);
  cam.rotation.x = Math.PI / 2; // (looking up)
  cam.updateMatrixWorld();
  // (black, its opacity falling from 1 at the floor to 0 at `height`, squared: the contact darkest)
  const dm = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
  dm.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );', 'float k = 1.0 - fragCoordZ; gl_FragColor = vec4( vec3( 0.0 ), k * k );'); };
  dm.depthTest = false; dm.depthWrite = false;
  const only = new THREE.Scene(), parent = group.parent;
  only.overrideMaterial = dm;
  only.add(group);
  const clear = r.getClearColor(new THREE.Color()), clearA = r.getClearAlpha();
  r.setClearColor(0x000000, 0);
  r.setRenderTarget(rt); r.clear(); r.render(only, cam);
  parent.add(group);
  // (blurred: across, then down, twice, the second time finer)
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, step: { value: new THREE.Vector2() } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D map; uniform vec2 step; varying vec2 vUv;
      void main() { vec4 s = texture2D(map, vUv) * 0.1633;
        s += (texture2D(map, vUv - step) + texture2D(map, vUv + step)) * 0.1531;
        s += (texture2D(map, vUv - 2.0 * step) + texture2D(map, vUv + 2.0 * step)) * 0.12245;
        s += (texture2D(map, vUv - 3.0 * step) + texture2D(map, vUv + 3.0 * step)) * 0.0918;
        s += (texture2D(map, vUv - 4.0 * step) + texture2D(map, vUv + 4.0 * step)) * 0.051;
        gl_FragColor = s; }`,
    depthTest: false, depthWrite: false,
  }));
  const qs = new THREE.Scene(), qc = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  qs.add(quad);
  const blur = (px) => {
    quad.material.uniforms.map.value = rt.texture; quad.material.uniforms.step.value.set(px / res, 0);
    r.setRenderTarget(rt2); r.render(qs, qc);
    quad.material.uniforms.map.value = rt2.texture; quad.material.uniforms.step.value.set(0, px / res);
    r.setRenderTarget(rt); r.render(qs, qc);
  };
  const soft = (res * R * 0.07) / size;
  blur(soft); blur(soft * 0.4);
  r.setRenderTarget(null);
  r.setClearColor(clear, clearA);
  quad.geometry.dispose(); quad.material.dispose(); dm.dispose(); rt2.dispose();
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ map: rt.texture, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
  plane.scale.y = -1; // (the picture from below is the floor's mirror image)
  plane.position.set(cx, y0 + R * 1e-4, cz);
  plane.renderOrder = 1;
  scene.add(plane);
  return { dispose: () => { scene.remove(plane); plane.geometry.dispose(); plane.material.dispose(); rt.dispose(); } };
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
// lights (spotlights, lights.js), envStrength (the scene's environment, 0 to 1), keyLight (false: the scene's key light
// off), placeTurn (degrees: a photographed place turned about the vertical from where its sun is at the view's right,
// the sun and the key light with it), decals: [{ src, p, n, w, h, angle }] }. Resolves with { url, width, height }.
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
    const sc = SCENES[opts.env] ? opts.env : 'studio', S = SCENES[sc], scene = new THREE.Scene();
    if (S.photo) await loadScene(sc, !opts.background);
    const env = environment(r, sc);
    scene.environment = env.texture;
    scene.environmentIntensity = opts.envStrength ?? 1;
    // (a photographed place behind the part: drawn first, its own scene, as the photograph is (not tone mapped again))
    const place = !opts.background && S.photo ? new THREE.Scene() : null, photo = place && photos.get(sc + ':backdrop').tex.clone();
    if (!place) scene.background = opts.background ? new THREE.Color(opts.background) : background(sc);
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
    // (a photographed place turned about the vertical so its sun (or brightest light) is at the view's right, where the
    // key light is: the part's light, shadow and reflections agree with the place behind it)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion), keyAz = Math.abs(right.x) + Math.abs(right.z) > 1e-6 ? Math.atan2(right.z, right.x) : 0;
    const t0 = S.photo ? (((S.turn || 0) + (+opts.placeTurn || 0)) * Math.PI) / 180 : 0, turn = S.photo ? (S.sun[0] * Math.PI) / 180 - keyAz + t0 : 0, sunAz = keyAz - t0;
    scene.environmentRotation.set(0, turn, 0);
    // (the place: the photograph on a dome whose lower half is flattened into a ground at the part's floor, as seen from
    // a point as high above it as the camera is, the camera's own place: the photograph's ground goes on under the part
    // and takes its shadow. Seen through a perspective camera like the view's (a parallel view: a narrow one along it,
    // framing the same at the part). A view from below the floor: the place seen level, as a backdrop behind.)
    let placeCam = null, dome = null;
    if (place) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion), floorY = box.min.y;
      if (cam.isPerspectiveCamera) placeCam = cam.clone();
      else {
        const fov = 24, up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion), halfH = (cam.top - cam.bottom) / 2 / cam.zoom;
        const depth = centre.clone().sub(cam.position).dot(fwd);
        const at = cam.position.clone().addScaledVector(right, (cam.left + cam.right) / 2 / cam.zoom).addScaledVector(up, (cam.top + cam.bottom) / 2 / cam.zoom).addScaledVector(fwd, depth);
        placeCam = new THREE.PerspectiveCamera(fov, width / height, 1, 10);
        placeCam.quaternion.copy(cam.quaternion);
        placeCam.position.copy(at).addScaledVector(fwd, -halfH / Math.tan((fov * Math.PI) / 360));
      }
      const h = placeCam.position.y - floorY;
      if (h > R * 0.05) {
        const radius = Math.max(h * 30, R * 60), g = new THREE.SphereGeometry(radius, 256, 128);
        g.scale(1, 1, -1);
        const pos = g.getAttribute('position'), v = new THREE.Vector3(), y1 = (-h * 3) / 2;
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i);
          if (v.y < 0) { v.multiplyScalar(v.y < y1 ? -h / v.y : 1 - (v.y * v.y) / (3 * y1 * y1)); v.toArray(pos.array, 3 * i); }
        }
        const e = opts.exposure ?? 1;
        // (the photograph looked up per pixel by the direction from the dome's middle (its points were only moved
        // along it), not spread over its triangles: straight lines stay straight, also where the ground's long thin
        // triangles meet the horizon)
        dome = new THREE.Mesh(g, new THREE.ShaderMaterial({
          uniforms: { map: { value: photo }, gain: { value: e } },
          vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader: `uniform sampler2D map; uniform float gain; varying vec3 vDir;
            void main() {
              vec3 d = normalize(vDir);
              vec2 uv = vec2(atan(d.z, d.x) * 0.15915494309189535 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.3183098861837907 + 0.5);
              gl_FragColor = vec4(texture2D(map, uv).rgb * gain, 1.0);
              #include <colorspace_fragment>
            }`,
          depthWrite: false, toneMapped: false,
        }));
        dome.position.set(placeCam.position.x, floorY + h, placeCam.position.z);
        dome.rotation.y = turn;
        place.add(dome);
        Object.assign(placeCam, { near: Math.max(h * 0.01, R * 0.01), far: radius * 2.5 });
      } else {
        const f = fwd, pitch = Math.max(-0.12, Math.min(0.35, Math.asin(Math.max(-1, Math.min(1, f.y))))), hz = Math.hypot(f.x, f.z) > 1e-6 ? new THREE.Vector2(f.x, f.z).normalize() : new THREE.Vector2(0, -1);
        placeCam = new THREE.PerspectiveCamera(55, width / height, 0.1, 10);
        placeCam.lookAt(hz.x * Math.cos(pitch), Math.sin(pitch), hz.y * Math.cos(pitch));
        Object.assign(place, { background: photo, backgroundIntensity: opts.exposure ?? 1 });
        place.backgroundRotation.set(0, turn, 0);
      }
      placeCam.aspect = width / height;
      placeCam.clearViewOffset?.();
      placeCam.updateProjectionMatrix();
    }
    const draw = () => {
      if (!place) { r.render(scene, cam); return; }
      r.toneMapping = THREE.NoToneMapping;
      r.render(place, placeCam);
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.autoClear = false; r.clearDepth(); r.render(scene, cam); r.autoClear = true;
    };
    let key = null, keyAt = null;
    if (opts.floor !== false && opts.keyLight !== false) {
      const [kc, ki] = S.key || [0xffffff, 1.15];
      key = new THREE.DirectionalLight(kc, ki);
      if (S.photo) {
        const el = (Math.min(65, Math.max(25, S.sun[1])) * Math.PI) / 180;
        key.position.copy(centre).add(new THREE.Vector3(Math.cos(el) * Math.cos(sunAz), Math.sin(el), Math.cos(el) * Math.sin(sunAz)).multiplyScalar(R * 3.2));
      } else key.position.copy(centre).add(new THREE.Vector3(0, R * 3, 0)).addScaledVector(right, R * 1.2);
      key.target.position.copy(centre);
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      const sR = R * (S.photo ? 2.6 : 1.6);
      Object.assign(key.shadow.camera, { left: -sR, right: sR, top: sR, bottom: -sR, near: R * 0.1, far: R * 8 });
      key.shadow.radius = 6; key.shadow.bias = -R * 1e-5;
      scene.add(key, key.target);
      keyAt = key.position.clone();
    }
    // (a photographed place: the shadow its own light (the sky, the ceiling: not shadowed) leaves out, under the part)
    const contact = S.photo && opts.floor !== false ? contactShadow(r, scene, group, box, R) : null;
    if (opts.floor !== false) {
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(R * 40, R * 40), new THREE.ShadowMaterial({ opacity: S.photo ? 0.6 : 0.28, depthWrite: false }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(centre.x, box.min.y - R * 1e-3, centre.z);
      floor.receiveShadow = true;
      scene.add(floor);
    } else scene.add(new THREE.HemisphereLight(0xffffff, 0x808080, 0.6));
    // (the part's spotlights (lights.js), each moved a little about its place pass by pass, more the softer it is)
    const spots = makeSpots(opts.lights || [], R);
    for (const s of spots) scene.add(s, s.target);
    const spotAt = spots.map((s) => {
      const d = s.position.clone().sub(s.target.position).normalize(), u = new THREE.Vector3().crossVectors(d, Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
      return { p: s.position.clone(), u, v: new THREE.Vector3().crossVectors(d, u), r: R * 0.25 * (0.3 + s.penumbra) };
    });
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
        spots.forEach((s, i) => { const q = spotAt[i], a = 2 * Math.PI * halton(k + 1, 11), rr = Math.sqrt(halton(k + 1, 13)) * q.r; s.position.copy(q.p).addScaledVector(q.u, Math.cos(a) * rr).addScaledVector(q.v, Math.sin(a) * rr); });
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
    for (const s of spots) s.dispose();
    contact?.dispose();
    if (place) { photo.dispose(); dome?.geometry.dispose(); dome?.material.dispose(); } else scene.background?.dispose?.();
    group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); o.customDepthMaterial?.dispose(); } });
    return { url, width, height };
  } finally { r.dispose(); r.forceContextLoss?.(); }
}
