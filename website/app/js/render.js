// Photorealistic rendering of the part as the view shows it: each body in a look (polished or brushed metal, plastic,
// rubber, paint, glass…) of its colour, lit by a studio (or sky) environment and a key light casting soft shadows on a
// floor, tone mapped; decals (pictures on flat faces) on it. One frame, at the size asked, as a PNG data URL.
import * as THREE from 'three';

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

// A studio: a soft grey room with a big light overhead and panels at the sides (a reflection environment), or a sky.
function environment(renderer, kind) {
  const scene = new THREE.Scene(), pm = new THREE.PMREMGenerator(renderer);
  if (kind === 'sky') {
    const g = new THREE.SphereGeometry(100, 32, 16), cols = [], c = new THREE.Color();
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) { const y = pos.getY(i) / 100; c.set(y > 0 ? 0x9cc4ee : 0x6b6158).lerp(new THREE.Color(0xf4f7fb), Math.max(0, 1 - Math.abs(y) * 3)); cols.push(c.r, c.g, c.b); }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    const sun = new THREE.Mesh(new THREE.SphereGeometry(4, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(30, 28, 25) }));
    sun.position.set(40, 70, 30); scene.add(sun);
  } else {
    const room = new THREE.Mesh(new THREE.BoxGeometry(60, 30, 60), new THREE.MeshBasicMaterial({ color: 0x5a5d62, side: THREE.BackSide }));
    room.position.y = 10; scene.add(room);
    const panel = (w, h, at, look, k) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(k, k, k), side: THREE.DoubleSide })); m.position.set(...at); m.lookAt(...look); scene.add(m); };
    panel(30, 18, [0, 24.5, 0], [0, 0, 0], 14);
    panel(10, 16, [-29, 12, 8], [0, 8, 0], 6);
    panel(10, 16, [29, 12, -8], [0, 8, 0], 4);
    panel(20, 8, [0, 10, -29], [0, 8, 0], 2.5);
  }
  const rt = pm.fromScene(scene, 0.035);
  pm.dispose();
  scene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  return rt;
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
// of body indices, env: 'studio' | 'sky' | 'white', floor, exposure, background (CSS colour or null: the
// environment), decals: [{ src, p, n, w, h, angle }] }. Resolves with { url, width, height }.
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
    const scene = new THREE.Scene(), env = environment(r, opts.env === 'sky' ? 'sky' : 'studio');
    scene.environment = env.texture;
    scene.background = opts.background ? new THREE.Color(opts.background) : opts.env === 'white' ? new THREE.Color(0xffffff) : new THREE.Color(opts.env === 'sky' ? 0xdfe9f4 : 0xe9ebee);
    // (the bodies, each its own mesh sharing the view's points and normals)
    const geo = vp.bodyGeo, mesh = vp.mesh, tris = mesh?.triangles;
    if (!geo || !tris) throw new Error('There is no model to render');
    const box = new THREE.Box3(), group = new THREE.Group();
    (vp.bodies?.length ? vp.bodies : [{ triStart: 0, triCount: tris.length }]).forEach((b, bi) => {
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
    const cam = vp.camera.clone();
    if (cam.isPerspectiveCamera) { cam.aspect = width / height; } else {
      const h = (cam.top - cam.bottom) / 2, cy = (cam.top + cam.bottom) / 2, cx = (cam.left + cam.right) / 2, w = (h * width) / height;
      cam.left = cx - w; cam.right = cx + w; cam.top = cy + h; cam.bottom = cy - h;
    }
    cam.updateProjectionMatrix();
    if (opts.floor !== false) {
      const key = new THREE.DirectionalLight(0xffffff, 1.6), right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      key.position.copy(centre).add(new THREE.Vector3(0, R * 3, 0)).addScaledVector(right, R * 1.2);
      key.target.position.copy(centre);
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      Object.assign(key.shadow.camera, { left: -R * 1.6, right: R * 1.6, top: R * 1.6, bottom: -R * 1.6, near: R * 0.1, far: R * 8 });
      key.shadow.radius = 6; key.shadow.bias = -R * 1e-5;
      scene.add(key, key.target);
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(R * 40, R * 40), new THREE.ShadowMaterial({ opacity: 0.28 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(centre.x, box.min.y - R * 1e-3, centre.z);
      floor.receiveShadow = true;
      scene.add(floor);
    } else scene.add(new THREE.HemisphereLight(0xffffff, 0x808080, 0.6));
    r.render(scene, cam);
    const url = canvas.toDataURL('image/png');
    env.dispose();
    group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    return { url, width, height };
  } finally { r.dispose(); r.forceContextLoss?.(); }
}
