// Spotlights: lights placed and aimed by the user, kept with the part (doc.render.lights), for renders and the
// realistic view only (studio lighting: a key, a fill, a rim…). Each { id, name, pos: [x, y, z], aim: [x, y, z],
// color: '#rrggbb', power (brightness, as the scene's key light is about 1.15), angle (the cone, degrees across),
// soft (the cone's edge, 0 hard to 1 soft), shadows, suppressed }. Positions in the view's coordinates (mm).
import * as THREE from 'three';

export const LIGHT_DEFAULTS = { color: '#ffffff', power: 1, angle: 40, soft: 0.5, shadows: true };

// The lights that shine (not suppressed)
export const activeLights = (render) => (render?.lights || []).filter((l) => !l.suppressed);

export function nextLightId(list) {
  let n = 1;
  while ((list || []).some((l) => l.id === 'L' + n)) n++;
  return 'L' + n;
}

// A new spotlight for a part (its centre and radius as THREE.Vector3 / number) seen from a view (its camera's
// quaternion): above the part, in front and to one side of the view (the first to the left, then right, then behind),
// aimed at the centre
export function newSpotLight(list, centre, R, quat) {
  const n = (list || []).length, right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat), back = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
  const side = [-1.1, 1.1, 0.2, -0.5][n % 4], toward = [1, 0.8, -1.3, 1.2][n % 4];
  const pos = centre.clone().addScaledVector(right, side * R).addScaledVector(back, toward * R).add(new THREE.Vector3(0, 1.3 * R, 0));
  const id = nextLightId(list), r3 = (v) => v.toArray().map((x) => +x.toFixed(2));
  return { id, name: '', ...LIGHT_DEFAULTS, pos: r3(pos), aim: r3(centre) };
}

export const lightName = (l, i) => l.name || `Spotlight ${i + 1}`;

// THREE spotlights for the lights (their targets added to the scene with them): no fall-off with distance (the
// brightness is what reaches the part however far the light is); shadows sized to a model of radius R
export function makeSpots(list, R, mapSize = 2048) {
  return list.map((l) => {
    const s = new THREE.SpotLight(new THREE.Color(l.color || '#ffffff'), l.power ?? LIGHT_DEFAULTS.power, 0, 0, 0, 0);
    placeSpot(s, l);
    if (l.shadows !== false) {
      s.castShadow = true;
      s.shadow.mapSize.set(mapSize, mapSize);
      const d = new THREE.Vector3(...l.pos).distanceTo(new THREE.Vector3(...l.aim));
      Object.assign(s.shadow.camera, { near: Math.max(0.01, (d - R * 3) * 0.5, d / 1000), far: d + R * 4 });
      s.shadow.bias = -0.0004; s.shadow.normalBias = R * 2e-3; s.shadow.radius = 4;
    }
    s.userData.light = l.id;
    return s;
  });
}

// A spotlight (THREE) set to a light's place, aim, colour, brightness and cone
export function placeSpot(s, l) {
  s.position.set(...l.pos);
  s.target.position.set(...l.aim);
  s.target.updateMatrixWorld();
  s.color.set(l.color || '#ffffff');
  s.intensity = l.power ?? LIGHT_DEFAULTS.power;
  s.angle = THREE.MathUtils.degToRad(Math.max(1, Math.min(170, l.angle ?? LIGHT_DEFAULTS.angle)) / 2);
  s.penumbra = Math.max(0, Math.min(1, l.soft ?? LIGHT_DEFAULTS.soft));
}

// The handles of the lights in the view: a lamp (a disc facing the aim) at each light, a ring at its aim, the line
// between and the cone's outline; the selected one brighter. Sized on the screen by `wpp` (world units per pixel).
export function handleGroup(list, sel) {
  const g = new THREE.Group();
  g.renderOrder = 999;
  const over = (m) => { m.depthTest = false; m.depthWrite = false; m.transparent = true; return m; };
  for (const l of list) {
    const on = l.id === sel, P = new THREE.Vector3(...l.pos), A = new THREE.Vector3(...l.aim), dir = A.clone().sub(P), d = dir.length() || 1;
    dir.normalize();
    const col = new THREE.Color(l.color || '#ffffff');
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), over(new THREE.MeshBasicMaterial({ color: on ? 0xffc21a : 0xd9a400, opacity: l.suppressed ? 0.35 : 1 })));
    lamp.position.copy(P); lamp.userData = { handle: 'pos', light: l.id, px: on ? 9 : 7 };
    const glow = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), over(new THREE.MeshBasicMaterial({ color: col, opacity: 0.9 })));
    glow.position.copy(P); glow.userData = { px: on ? 5 : 4 };
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.22, 8, 24), over(new THREE.MeshBasicMaterial({ color: on ? 0xff7a00 : 0xb06000, opacity: l.suppressed ? 0.35 : 1 })));
    ring.position.copy(A); ring.lookAt(P); ring.userData = { handle: 'aim', light: l.id, px: on ? 8 : 6 };
    const lineMat = over(new THREE.LineBasicMaterial({ color: on ? 0xffb000 : 0x9c7a20, opacity: on ? 0.95 : 0.6 }));
    const r = d * Math.tan(THREE.MathUtils.degToRad(Math.min(170, l.angle ?? 40) / 2)), u = new THREE.Vector3().crossVectors(dir, Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize(), v = new THREE.Vector3().crossVectors(dir, u);
    const pts = [P, A];
    // (the cone: four lines from the lamp to its edge at the aim's distance, and the edge's circle)
    const circle = [];
    for (let k = 0; k <= 48; k++) { const t = (k / 48) * Math.PI * 2; circle.push(A.clone().addScaledVector(u, Math.cos(t) * r).addScaledVector(v, Math.sin(t) * r)); }
    for (let k = 0; k < 4; k++) pts.push(P, circle[k * 12]);
    const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat);
    const edge = new THREE.Line(new THREE.BufferGeometry().setFromPoints(circle), lineMat.clone());
    if (!on) { lines.material.opacity = 0.45; edge.material.opacity = 0.35; }
    g.add(lines, edge, glow, lamp, ring);
  }
  g.traverse((o) => { o.renderOrder = 999; });
  return g;
}
