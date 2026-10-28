// 3D viewport: orthographic camera, CAD-style mouse controls, body/edge
// rendering, reference planes, face picking, standard views and section view.
import * as THREE from 'three';
import { CadControls } from './cadcontrols.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import * as G from './geometry.js';
import { hatchStyle } from './drawingformats.js';
import { wireColor } from './theme.js';
import * as W from './wcs.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const HALF_H = 100; // ortho half-height at zoom 1 (mm)
const CAM_DIST = 2000;

// Standard views: [view direction (toward the viewer), screen-up direction]
export const VIEWS = {
  front: [[0, 0, 1], [0, 1, 0]], back: [[0, 0, -1], [0, 1, 0]],
  left: [[-1, 0, 0], [0, 1, 0]], right: [[1, 0, 0], [0, 1, 0]],
  top: [[0, 1, 0], [0, 0, -1]], bottom: [[0, -1, 0], [0, 0, 1]],
  iso: [[1, 1, 1], [0, 1, 0]], trimetric: [[1, 0.6, 1.6], [0, 1, 0]],
};

// Camera orientation looking along -dir with the given screen-up direction.
function viewQuat(dir, up) {
  const back = dir.clone().normalize();
  let u = up.clone().addScaledVector(back, -up.dot(back));
  if (u.lengthSq() < 1e-8) u = Math.abs(back.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1);
  u.addScaledVector(back, -u.dot(back)).normalize();
  const right = u.clone().cross(back).normalize();
  u = back.clone().cross(right);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, u, back));
}

// Sharp edges of a dense triangle mesh (used for imported STL bodies with
// thousands of tiny B-rep faces): mesh edges whose two triangles meet at > 25°.
function denseFeatureEdges(V, T, angleDeg = 25) {
  const cosT = Math.cos((angleDeg * Math.PI) / 180);
  const q = (i) => `${Math.round(V[i * 3] * 1e4)},${Math.round(V[i * 3 + 1] * 1e4)},${Math.round(V[i * 3 + 2] * 1e4)}`;
  const normals = [];
  const map = new Map();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < T.length; t += 3) {
    a.fromArray(V, T[t] * 3); b.fromArray(V, T[t + 1] * 3); c.fromArray(V, T[t + 2] * 3);
    const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    const ti = normals.push(n) - 1;
    for (let k = 0; k < 3; k++) {
      const i = T[t + k], j = T[t + ((k + 1) % 3)];
      const ki = q(i), kj = q(j);
      const key = ki < kj ? ki + '|' + kj : kj + '|' + ki;
      let rec = map.get(key);
      if (!rec) map.set(key, (rec = { i, j, tris: [] }));
      rec.tris.push(ti);
    }
  }
  const pts = [];
  for (const r of map.values()) {
    if (r.tris.length === 2 && normals[r.tris[0]].dot(normals[r.tris[1]]) >= cosT) continue;
    pts.push(new THREE.Vector3().fromArray(V, r.i * 3), new THREE.Vector3().fromArray(V, r.j * 3));
  }
  return pts;
}

export class Viewport {
  constructor(container, canvas, labelsEl) {
    this.container = container;
    this.canvas = canvas;
    this.labelsEl = labelsEl;
    // the dedicated graphics card where there is one
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, stencil: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.autoClear = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -20000, 20000);
    this.camera.quaternion.copy(viewQuat(new THREE.Vector3(...VIEWS.trimetric[0]), new THREE.Vector3(...VIEWS.trimetric[1])));
    this.camera.position.set(0, 0, CAM_DIST).applyQuaternion(this.camera.quaternion);
    this.camera.zoom = 0.9;
    this.scene.add(this.camera);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a96a8, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(0.4, 0.8, 1);
    this.camera.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.45);
    fill.position.set(-1, -0.4, 0.3);
    this.camera.add(fill);

    this.controls = new CadControls(this.camera, canvas, {
      getPivot: () => this.rotationPivot(),
      pickPivot: (ev) => this.pivotAt(ev),
      onPivot: (p) => this.showPivot(p),
      onChange: () => { this.anim = null; },
    });
    this.setLeftRotate(true);

    this.bodyGroup = new THREE.Group();
    this.planeGroup = new THREE.Group();
    this.sketchGroup = new THREE.Group();
    this.highlightGroup = new THREE.Group();
    this.overlayGroup = new THREE.Group();
    this.scene.add(this.planeGroup, this.bodyGroup, this.sketchGroup, this.highlightGroup, this.overlayGroup);

    this.bodyMat = new THREE.MeshPhongMaterial({
      color: 0xc3cad4, specular: 0x2a2f36, shininess: 38,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide, // surfaces are seen from both sides
    });
    // bodies made transparent (see-through, drawn after the opaque ones, don't hide what is behind them)
    this.glassMat = new THREE.MeshPhongMaterial({
      color: 0xc3cad4, specular: 0x2a2f36, shininess: 38, transparent: true, opacity: 0.3, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide,
    });
    this.edgeMat = new THREE.LineBasicMaterial({ color: 0x14181f });
    this.displayStyle = 'shadedEdges';
    this.body = null;
    this.edges = null;
    this.bodyGeo = null;
    this.section = null;
    this.planeVis = [];
    this.planeLabels = new Map();
    this.hover = null;
    this.selectedFace = null;
    this.frameCallbacks = new Set();
    this.anim = null;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Line.threshold = 1;

    this._buildOrigin();
    this._buildTriad();
    this._wirePointer();

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => { requestAnimationFrame(loop); this._frame(); };
    loop();
  }

  // Left-drag rotates in part mode; while sketching the left button draws.
  setLeftRotate(on) {
    this.controls.leftRotate = on;
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    const aspect = w / h;
    Object.assign(this.camera, { left: -HALF_H * aspect, right: HALF_H * aspect, top: HALF_H, bottom: -HALF_H });
    this.camera.updateProjectionMatrix();
    this.width = w; this.height = h;
    if (this._fitPending) { this._fitPending = false; this.zoomToFit(null, false); }
  }

  // ------------------------------------------------------------ scene content
  // mesh: { vertices, normals, triangles, faceGroups, edges:[{pts, mid, type}], bodies } from the kernel
  // colors: one colour per body (mesh.bodies order), or a single colour for everything
  // hidden: indices (in mesh.bodies) of bodies that are not drawn and can't be picked
  // transparent: indices of bodies drawn see-through (still picked)
  setBody(mesh, colors, hidden = null, transparent = null) {
    if (this._hiddenPick) { this._hiddenPick.geometry.disposeBoundsTree?.(); this._hiddenPick.geometry.dispose(); this._hiddenPick = null; }
    if (this.body) { this.bodyGroup.remove(this.body); this.body.geometry.disposeBoundsTree?.(); this.body.geometry.dispose(); }
    if (this.edges) { this.bodyGroup.remove(this.edges); this.edges.geometry.dispose(); }
    this.body = this.edges = null;
    this.contentChanged();
    this.bodyColor = Array.isArray(colors) ? colors[0] : colors;
    this.bodyColors = colors;
    this.mesh = mesh;
    this.bodies = mesh?.bodies || [];
    this.edgeList = [];
    this.clearFaceHighlights();
    this.setEdgeHighlights(null);
    if (!mesh || !mesh.triangles.length) { this.bodyGeo = null; this._updateSectionCaps(); return; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.vertices, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.triangles.slice(), 1));
    this.bodyGeo = geo;
    geo.computeBoundingSphere();
    // map each vertex to its B-rep face (vertices are not shared between faces)
    const tris = mesh.triangles;
    const total = mesh.faceGroups.reduce((s, g) => s + g.count, 0);
    const gs = total === tris.length ? 1 : 3;
    this.faceGroupScale = gs;
    this.vertexFace = new Int32Array(mesh.vertices.length / 3).fill(-1);
    mesh.faceGroups.forEach((g, gi) => {
      for (let k = g.start * gs; k < (g.start + g.count) * gs; k++) this.vertexFace[tris[k]] = gi;
    });
    // which body each face and edge belongs to, and a colour per vertex from the body's material
    this.faceBody = new Int32Array(mesh.faceGroups.length).fill(0);
    this.edgeBody = new Int32Array(mesh.edges.length).fill(0);
    const col = new Float32Array(mesh.vertices.length);
    const c = new THREE.Color();
    this.bodies.forEach((b, bi) => {
      this.faceBody.fill(bi, b.faceStart, b.faceStart + b.faceCount);
      this.edgeBody.fill(bi, b.edgeStart, b.edgeStart + b.edgeCount);
      c.set((Array.isArray(colors) ? colors[bi] : colors) ?? 0xc3cad4);
      for (let k = b.triStart; k < b.triStart + b.triCount; k++) { const v = tris[k] * 3; col[v] = c.r; col[v + 1] = c.g; col[v + 2] = c.b; }
    });
    if (!this.bodies.length) { c.set(this.bodyColor ?? 0xc3cad4); for (let v = 0; v < col.length; v += 3) { col[v] = c.r; col[v + 1] = c.g; col[v + 2] = c.b; } }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // the drawn (and picked) geometry leaves hidden bodies out; bodyGeo keeps everything
    this.hiddenBodies = new Set(hidden || []);
    this.transparentBodies = new Set([...(transparent || [])].filter((bi) => !this.hiddenBodies.has(bi)));
    let drawGeo = geo;
    if ((this.hiddenBodies.size || this.transparentBodies.size) && this.bodies.length) {
      // opaque bodies first, then the transparent ones (a second material group)
      drawGeo = new THREE.BufferGeometry();
      for (const k of ['position', 'normal', 'color']) drawGeo.setAttribute(k, geo.getAttribute(k));
      const opaque = [], glass = [];
      this.bodies.forEach((b, bi) => {
        if (!this.hiddenBodies.has(bi)) (this.transparentBodies.has(bi) ? glass : opaque).push(tris.subarray(b.triStart, b.triStart + b.triCount));
      });
      const nOpaque = opaque.reduce((n, a) => n + a.length, 0), nGlass = glass.reduce((n, a) => n + a.length, 0);
      const idx = new Uint32Array(nOpaque + nGlass);
      let o = 0;
      for (const a of [...opaque, ...glass]) { idx.set(a, o); o += a.length; }
      drawGeo.setIndex(new THREE.BufferAttribute(idx, 1));
      if (nGlass) { drawGeo.addGroup(0, nOpaque, 0); drawGeo.addGroup(nOpaque, nGlass, 1); }
      drawGeo.computeBoundingSphere();
    }
    // (the picking index built once the model has been drawn, not before it: a big model shows sooner after an edit;
    // until then picks take the plain raycast, with the same hits)
    clearTimeout(this._bvhTimer);
    this._bvhTimer = setTimeout(() => this.ensurePickIndex(), 60);
    this.body = new THREE.Mesh(drawGeo, drawGeo.groups.length ? [this.bodyMat, this.glassMat] : this.bodyMat);
    const linePts = mesh.dense ? denseFeatureEdges(mesh.vertices, drawGeo.index.array) : [];
    mesh.edges.forEach((e, ei) => {
      const pts = [];
      for (let i = 0; i < e.pts.length; i += 3) pts.push(new THREE.Vector3(e.pts[i], e.pts[i + 1], e.pts[i + 2]));
      const hiddenEdge = this.hiddenBodies.has(this.edgeBody[ei]);
      if (!hiddenEdge) for (let i = 0; i < pts.length - 1; i++) linePts.push(pts[i], pts[i + 1]);
      this.edgeList.push({ pts, mid: e.mid, type: e.type, circ: e.circ, hidden: hiddenEdge });
    });
    this.edges = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(linePts), this.edgeMat);
    this.bodyGroup.add(this.body, this.edges);
    this.applyDisplayStyle();
    this._savedColors = null;
    if (this.analysis) this.applyAnalysis();
    this._updateSectionCaps();
  }

  // ---- surface analysis shown on the bodies: { kind: 'zebra' | 'curvature' | 'draft', … } or null
  setAnalysis(a) { this.analysis = a || null; this.applyAnalysis(); }
  applyAnalysis() {
    if (!this.body) return;
    const geo = this.body.geometry, col = geo.getAttribute('color');
    if (this._savedColors && col) { col.array.set(this._savedColors); col.needsUpdate = true; this._savedColors = null; }
    const plain = geo.groups.length ? [this.bodyMat, this.glassMat] : this.bodyMat;
    const a = this.analysis;
    if (!a) { this.body.material = plain; this.applyDisplayStyle(); return; }
    if (a.kind === 'zebra') {
      this._zebraMat ||= new THREE.ShaderMaterial({
        uniforms: { density: { value: 10 } },
        vertexShader: 'varying vec3 vN; void main() { vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform float density; varying vec3 vN; void main() { vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n; vec3 r = reflect(vec3(0.0, 0.0, -1.0), n); float s = step(0.5, fract(r.y * density * 0.5 + 0.5)); float shade = 0.55 + 0.45 * abs(n.z); gl_FragColor = vec4(vec3(mix(0.08, 0.96, s) * shade), 1.0); }',
        side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
      this._zebraMat.uniforms.density.value = a.density || 10;
      this.body.material = this._zebraMat;
      return;
    }
    this.body.material = plain;
    this.applyDisplayStyle();
    if (!col) return;
    this._savedColors = col.array.slice();
    const pos = geo.getAttribute('position').array, nor = geo.getAttribute('normal').array, n = pos.length / 3, c = new THREE.Color();
    const out = col.array;
    if (a.kind === 'draft') {
      // the angle of each face to the pull direction: green with enough draft one way, red the other, yellow too little
      const d = new THREE.Vector3(...a.dir).normalize(), lim = Math.sin(((a.angle || 0) * Math.PI) / 180);
      for (let i = 0; i < n; i++) {
        const s = nor[3 * i] * d.x + nor[3 * i + 1] * d.y + nor[3 * i + 2] * d.z;
        c.set(s >= lim + 1e-9 ? 0x22a046 : s <= -lim - 1e-9 ? 0xd63b2f : 0xf2c12e);
        out[3 * i] = c.r; out[3 * i + 1] = c.g; out[3 * i + 2] = c.b;
      }
    } else if (a.kind === 'thickness' || a.kind === 'undercut') {
      // (rays through the shaded mesh: thickness, from each point in along the inward normal to where it comes out;
      // undercut, from each point along the pull direction and against it, a face neither way free is undercut)
      const geoB = this.body.geometry;
      if (!geoB.boundsTree) geoB.computeBoundsTree();
      const ray = new THREE.Raycaster(); ray.firstHitOnly = true;
      const o = new THREE.Vector3(), dv = new THREE.Vector3(), eps = 1e-4 * Math.max(1, this.bodyDiag?.() || 1);
      // (both sides of the triangles: a ray from inside the wall meets the far side from behind)
      const keepMat = this.body.material; this.body.material = this._rayMat ||= new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
      // (each point's share of the surface: a third of its triangles' areas, for the shares reported)
      const wt = new Float64Array(n), ix = geoB.index.array;
      let area = 0;
      for (let k = 0; k < ix.length; k += 3) {
        const [i, j, l] = [ix[k], ix[k + 1], ix[k + 2]], ux = pos[3 * j] - pos[3 * i], uy = pos[3 * j + 1] - pos[3 * i + 1], uz = pos[3 * j + 2] - pos[3 * i + 2], vx = pos[3 * l] - pos[3 * i], vy = pos[3 * l + 1] - pos[3 * i + 1], vz = pos[3 * l + 2] - pos[3 * i + 2];
        const A = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
        wt[i] += A / 3; wt[j] += A / 3; wt[l] += A / 3; area += A;
      }
      const hitAt = (px, py, pz, dx, dy, dz, off) => { o.set(px + dx * off, py + dy * off, pz + dz * off); dv.set(dx, dy, dz); ray.set(o, dv); ray.near = 0; ray.far = Infinity; const h = ray.intersectObject(this.body, false)[0]; return h ? h.distance + off : null; };
      if (a.kind === 'thickness') {
        const lo = a.min, hi = a.max, t = new Float32Array(n);
        let thin = 0, thick = 0, tmin = Infinity, tmax = 0;
        for (let i = 0; i < n; i++) {
          const nx = nor[3 * i], ny = nor[3 * i + 1], nz = nor[3 * i + 2];
          const d = hitAt(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2], -nx, -ny, -nz, eps);
          t[i] = d ?? NaN;
          if (d != null) { tmin = Math.min(tmin, d); tmax = Math.max(tmax, d); if (d < lo) thin += wt[i]; else if (d > hi) thick += wt[i]; }
          // red too thin, blue too thick, green to yellow in between (thin to thick), grey where no wall was found
          if (d == null) c.set(0x9aa3ad); else if (d < lo) c.set(0xd63b2f); else if (d > hi) c.set(0x2f6fd6); else c.setHSL(0.33 - 0.17 * ((d - lo) / Math.max(1e-9, hi - lo)), 0.8, 0.45);
          out[3 * i] = c.r; out[3 * i + 1] = c.g; out[3 * i + 2] = c.b;
        }
        this.thicknessStats = { min: tmin, max: tmax, thin: thin / (area || 1), thick: thick / (area || 1), values: t };
      } else {
        const d = new THREE.Vector3(...a.dir).normalize();
        let under = 0;
        for (let i = 0; i < n; i++) {
          const nx = nor[3 * i], ny = nor[3 * i + 1], nz = nor[3 * i + 2], px = pos[3 * i] + nx * eps, py = pos[3 * i + 1] + ny * eps, pz = pos[3 * i + 2] + nz * eps;
          const up = hitAt(px, py, pz, d.x, d.y, d.z, eps), down = hitAt(px, py, pz, -d.x, -d.y, -d.z, eps);
          // green: free along the pull (one half), blue: free against it (the other), red: neither way free (undercut)
          if (up != null && down != null) under += wt[i];
          c.set(up == null ? 0x22a046 : down == null ? 0x2f6fd6 : 0xd63b2f);
          out[3 * i] = c.r; out[3 * i + 1] = c.g; out[3 * i + 2] = c.b;
        }
        this.undercutShare = under / (area || 1);
      }
      this.body.material = keepMat;
    } else if (a.kind === 'curvature') {
      // curvature from how fast the normals turn along the mesh edges (within each face)
      const k = new Float32Array(n), idx = this.bodyGeo.index.array;
      for (let t = 0; t < idx.length; t += 3) for (let e = 0; e < 3; e++) {
        const i = idx[t + e], j = idx[t + ((e + 1) % 3)];
        const dl = Math.hypot(pos[3 * i] - pos[3 * j], pos[3 * i + 1] - pos[3 * j + 1], pos[3 * i + 2] - pos[3 * j + 2]);
        if (dl < 1e-12) continue;
        const dn = Math.hypot(nor[3 * i] - nor[3 * j], nor[3 * i + 1] - nor[3 * j + 1], nor[3 * i + 2] - nor[3 * j + 2]) / dl;
        if (dn > k[i]) k[i] = dn; if (dn > k[j]) k[j] = dn;
      }
      const kmax = a.radius > 0 ? 1 / a.radius : Math.max(1e-9, [...k].sort((x, y) => x - y)[Math.floor(n * 0.98)] || 1e-9);
      this.curvatureMax = kmax;
      for (let i = 0; i < n; i++) {
        const t = Math.min(1, k[i] / kmax);
        c.setHSL((1 - t) * 0.66, 0.85, 0.5); // blue (flat) → green → yellow → red (tightest)
        out[3 * i] = c.r; out[3 * i + 1] = c.g; out[3 * i + 2] = c.b;
      }
    }
    col.needsUpdate = true;
  }

  // Triangles, normal and plane of a B-rep face (by face-group index).
  faceInfo(gi) {
    const g = this.mesh?.faceGroups[gi];
    if (!g) return null;
    const { vertices: V, normals: N, triangles: T } = this.mesh;
    const gs = this.faceGroupScale;
    const pos = [];
    const n = new THREE.Vector3();
    let planar = true, first = null;
    for (let k = g.start * gs; k < (g.start + g.count) * gs; k++) {
      const vi = T[k];
      pos.push(V[vi * 3], V[vi * 3 + 1], V[vi * 3 + 2]);
      const vn = new THREE.Vector3(N[vi * 3], N[vi * 3 + 1], N[vi * 3 + 2]);
      if (!first) first = vn.clone();
      else if (vn.dot(first) < 0.99999) planar = false;
      n.add(vn);
    }
    n.normalize();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geometry.computeBoundingBox();
    const p0 = new THREE.Vector3(pos[0], pos[1], pos[2]);
    const d = n.dot(p0);
    const center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);
    center.addScaledVector(n, d - n.dot(center));
    return { index: gi, geometry, normal: n, d, center, planar };
  }

  // Triangles of a whole body (by index in mesh.bodies), for highlighting.
  bodyInfo(bi) {
    const b = this.bodies?.[bi];
    if (!b) return null;
    const { vertices: V, triangles: T } = this.mesh;
    const pos = new Float32Array(b.triCount * 3);
    for (let k = 0; k < b.triCount; k++) { const vi = T[b.triStart + k] * 3; pos[k * 3] = V[vi]; pos[k * 3 + 1] = V[vi + 1]; pos[k * 3 + 2] = V[vi + 2]; }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.computeBoundingBox();
    return { index: bi, id: b.id, geometry };
  }

  bodyIndexOf(id) { return this.bodies?.findIndex((b) => b.id === id) ?? -1; }

  // Axis-aligned bounding box of a body's mesh: { min: [x, y, z], max: [x, y, z] } or null.
  bodyBox(id) {
    const b = this.bodies?.find((x) => x.id === id);
    if (!b || !this.mesh) return null;
    const { vertices: V, triangles: T } = this.mesh;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < b.triCount; k++) {
      const vi = T[b.triStart + k] * 3;
      for (let j = 0; j < 3; j++) { const x = V[vi + j]; if (x < min[j]) min[j] = x; if (x > max[j]) max[j] = x; }
    }
    return isFinite(min[0]) ? { min, max } : null;
  }

  // Closest visible B-rep edge to the cursor (within tolPx pixels).
  pickEdge(ev, tolPx = 6) {
    if (!this.edgeList?.length) return null;
    const m = this.screenPos(ev);
    const hit = this.pickBody(ev);
    const viewDir = new THREE.Vector3();
    this.camera.getWorldDirection(viewDir);
    const depth = (p) => p.clone().sub(this.camera.position).dot(viewDir);
    const slack = (this.bodyGeo?.boundingSphere?.radius || 50) * 0.02 + 0.5;
    const hitDepth = hit ? depth(hit.point) : Infinity;
    let best = null, bd = tolPx;
    this.edgeList.forEach((e, i) => {
      if (e.hidden) return;
      let prev = null, prevW = null;
      for (const w of e.pts) {
        const s = this.project(w);
        if (prev) {
          const dx = s.x - prev.x, dy = s.y - prev.y, L2 = dx * dx + dy * dy;
          let t = L2 ? ((m.x - prev.x) * dx + (m.y - prev.y) * dy) / L2 : 0;
          t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(m.x - (prev.x + t * dx), m.y - (prev.y + t * dy));
          if (d < bd) {
            const wp = prevW.clone().lerp(w, t);
            if (depth(wp) <= hitDepth + slack) { bd = d; best = { index: i, point: wp, edge: e }; }
          }
        }
        prev = s; prevW = w;
      }
    });
    return best;
  }

  // Closest visible edge end point (B-rep vertex).
  pickVertex(ev, tolPx = 8) {
    if (!this.edgeList?.length) return null;
    const m = this.screenPos(ev);
    const hit = this.pickBody(ev);
    const viewDir = new THREE.Vector3();
    this.camera.getWorldDirection(viewDir);
    const depth = (p) => p.clone().sub(this.camera.position).dot(viewDir);
    const slack = (this.bodyGeo?.boundingSphere?.radius || 50) * 0.02 + 0.5;
    const hitDepth = hit ? depth(hit.point) : Infinity;
    let best = null, bd = tolPx;
    for (const e of this.edgeList) {
      if (e.hidden) continue;
      if (e.pts[0].distanceTo(e.pts[e.pts.length - 1]) < 1e-6) continue; // seam of a closed edge, not a real corner
      for (const w of [e.pts[0], e.pts[e.pts.length - 1]]) {
        const s = this.project(w);
        const d = Math.hypot(s.x - m.x, s.y - m.y);
        if (d < bd && depth(w) <= hitDepth + slack) { bd = d; best = { point: w.clone() }; }
      }
    }
    return best;
  }

  // A snap point under the cursor: an edge's middle (mids) or a circular edge's centre (centres), not hidden behind
  // the model: { point, kind: 'mid' | 'centre' }.
  pickSnap(ev, { mids = true, centres = true } = {}, tolPx = 8) {
    if (!this.edgeList?.length || (!mids && !centres)) return null;
    const m = this.screenPos(ev), hit = this.pickBody(ev), viewDir = new THREE.Vector3();
    this.camera.getWorldDirection(viewDir);
    const depth = (p) => p.clone().sub(this.camera.position).dot(viewDir);
    const slack = (this.bodyGeo?.boundingSphere?.radius || 50) * 0.02 + 0.5, hitDepth = hit ? depth(hit.point) : Infinity;
    let best = null, bd = tolPx;
    const consider = (w, kind, behindOk) => {
      const s = this.project(w), d = Math.hypot(s.x - m.x, s.y - m.y);
      if (d < bd && (behindOk || depth(w) <= hitDepth + slack)) { bd = d; best = { point: w.clone(), kind }; }
    };
    for (const e of this.edgeList) {
      if (e.hidden) continue;
      const closed = e.pts[0].distanceTo(e.pts[e.pts.length - 1]) < 1e-6;
      if (mids && !closed && e.mid) consider(new THREE.Vector3(...e.mid), 'mid', false);
      // (a hole's centre lies in the air over its bottom: shown when its edge is)
      if (centres && e.circ) consider(new THREE.Vector3(...e.circ.c), 'centre', true);
    }
    return best;
  }

  // Small marks at points, following the view: key names the set (replaced as a whole); list: [{ p, text, cls }].
  setPointMarks(key, list) {
    this._marks ||= new Map();
    const old = this._marks.get(key);
    if (old) { for (const x of old.els) x.remove(); this.frameCallbacks.delete(old.place); this._marks.delete(key); }
    if (!list?.length) return;
    const items = list.map((q) => {
      const el = document.createElement('div');
      el.className = `point-mark ${q.cls || ''}`;
      el.innerHTML = `<i></i>${q.text ? `<span>${q.text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</span>` : ''}`;
      this.labelsEl.appendChild(el);
      return { el, w: new THREE.Vector3(...q.p) };
    });
    const place = () => { for (const it of items) { const s = this.project(it.w); it.el.style.left = s.x + 'px'; it.el.style.top = s.y + 'px'; } };
    this.frameCallbacks.add(place);
    place();
    this._marks.set(key, { els: items.map((x) => x.el), place });
  }

  // Index of the edge whose stored reference point p lies on it.
  edgeIndexForPoint(p) {
    const P = new THREE.Vector3(...p);
    let best = -1, bd = Math.max(0.05, (this.bodyGeo?.boundingSphere?.radius || 50) * 0.004);
    this.edgeList?.forEach((e, i) => {
      for (let k = 0; k < e.pts.length - 1; k++) {
        const d = new THREE.Line3(e.pts[k], e.pts[k + 1]).closestPointToPoint(P, true, new THREE.Vector3()).distanceTo(P);
        if (d < bd) { bd = d; best = i; }
      }
    });
    return best;
  }

  // Feature preview while a Property panel is open: material added (yellow) and removed (red).
  setPreview(p) {
    if (this.previewGroup) {
      this.scene.remove(this.previewGroup);
      this.previewGroup.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
      this.previewGroup = null;
    }
    if (!p || (!p.add && !p.remove && !p.tool)) return;
    const grp = new THREE.Group();
    const mk = (m, color, opacity, xray) => {
      if (!m) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(m.vertices, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
      geo.setIndex(new THREE.BufferAttribute(m.triangles, 1));
      const mesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
        color, emissive: color, emissiveIntensity: 0.25, transparent: true, opacity, side: THREE.DoubleSide,
        depthWrite: false, depthTest: !xray, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        clippingPlanes: this.bodyMat.clippingPlanes,
      }));
      mesh.renderOrder = xray ? 7 : 4;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: new THREE.Color(color).multiplyScalar(0.6), depthTest: !xray, transparent: true, opacity: 0.9 }));
      edges.renderOrder = mesh.renderOrder;
      grp.add(mesh, edges);
    };
    mk(p.add, 0xf5c518, 0.6, false);
    mk(p.tool, 0xe53935, 0.14, false); // the whole cut volume, faint
    mk(p.remove, 0xe53935, 0.42, true); // removed material is inside the body: show it through
    this.previewGroup = grp;
    this.scene.add(grp);
  }

  // Vertex markers while picking a vertex: { selected: [x,y,z], hover: [x,y,z] }
  setVertexMarkers(m) {
    if (this.vertexHL) { this.highlightGroup.remove(this.vertexHL); this.vertexHL.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); this.vertexHL = null; }
    if (!m || (!m.selected?.length && !m.hover)) return;
    const grp = new THREE.Group();
    // `selected` may be a single [x,y,z] or a list of them
    const sel = !m.selected ? [] : Array.isArray(m.selected[0]) ? m.selected : [m.selected];
    for (const [list, color] of [[sel, 0x0ea5e9], [m.hover ? [m.hover] : [], 0xf59e0b]]) {
      if (!list.length) continue;
      const pts = new THREE.Points(new THREE.BufferGeometry().setFromPoints(list.map((p) => new THREE.Vector3(...p))), new THREE.PointsMaterial({ color, size: 11, sizeAttenuation: false, depthTest: false }));
      pts.renderOrder = 9;
      grp.add(pts);
    }
    this.vertexHL = grp;
    this.highlightGroup.add(grp);
  }

  // Reference axes (dashed lines) and points (markers), each with a label.
  setRefGeometry(axes, points, curves = [], threads = []) {
    if (this.refGroup) { this.scene.remove(this.refGroup); this.refGroup.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); }
    for (const l of this.refLabels || []) l.el.remove();
    this.refLabels = [];
    this.refGroup = new THREE.Group();
    const col = (s) => (s === 'preview' ? 0xf59e0b : s === 'selected' ? 0x2b7de9 : 0x3a6fb8);
    const pivot = this.rotationPivot();
    const half = this.planeSize() * 0.6;
    const label = (text, world) => {
      const el = document.createElement('div');
      el.className = 'plabel';
      el.textContent = text;
      this.labelsEl.appendChild(el);
      this.refLabels.push({ el, world });
    };
    for (const a of axes) {
      const c = a.o.clone().addScaledVector(a.d, pivot.clone().sub(a.o).dot(a.d));
      const p1 = c.clone().addScaledVector(a.d, -half), p2 = c.clone().addScaledVector(a.d, half);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p1, p2]),
        new THREE.LineDashedMaterial({ color: col(a.state), dashSize: half * 0.06, gapSize: half * 0.025, depthTest: false }));
      line.computeLineDistances();
      line.renderOrder = 6;
      this.refGroup.add(line);
      label(a.name, p2);
    }
    for (const c of curves) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(c.pts.map((q) => new THREE.Vector3(...q))),
        new THREE.LineBasicMaterial({ color: c.state === 'preview' ? 0xf59e0b : c.state === 'selected' ? 0x2b7de9 : 0x7c3aed, depthTest: false }));
      line.renderOrder = 6;
      this.refGroup.add(line);
      label(c.name, new THREE.Vector3(...c.pts[c.pts.length - 1]));
    }
    for (const t of threads) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(t.pts.map((q) => new THREE.Vector3(...q))),
        new THREE.LineBasicMaterial({ color: t.state === 'preview' ? 0xf59e0b : t.state === 'selected' ? 0x2b7de9 : 0x9a5b00 }));
      line.renderOrder = 3;
      this.refGroup.add(line);
    }
    for (const p of points) {
      const m = new THREE.Points(new THREE.BufferGeometry().setFromPoints([p.p]), new THREE.PointsMaterial({ color: col(p.state), size: 9, sizeAttenuation: false, depthTest: false }));
      m.renderOrder = 6;
      this.refGroup.add(m);
      label(p.name, p.p);
    }
    this.scene.add(this.refGroup);
  }

  // Highlight edges: { hover: index, selected: [indices] }
  setEdgeHighlights(h) {
    if (this.edgeHL) { this.highlightGroup.remove(this.edgeHL); this.edgeHL.traverse((o) => o.geometry?.dispose()); this.edgeHL = null; }
    if (!h || !this.edgeList?.length) return;
    const grp = new THREE.Group();
    const mk = (indices, color) => {
      const pts = [];
      for (const i of indices) {
        const e = this.edgeList[i];
        if (!e) continue;
        for (let k = 0; k < e.pts.length - 1; k++) pts.push(e.pts[k], e.pts[k + 1]);
      }
      if (!pts.length) return;
      const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, depthTest: false }));
      l.renderOrder = 8;
      grp.add(l);
    };
    mk(h.selected || [], 0x0ea5e9);
    if (h.hover != null) mk([h.hover], 0xf59e0b);
    this.edgeHL = grp;
    this.highlightGroup.add(grp);
  }

  // A picture of the view as it is now (for the file's preview): the model framed as seen, on the
  // view's background, at most max px across. A JPEG data: URL, or null.
  snapshot(max = 400) {
    const r = this.renderer, cv = r.domElement;
    if (!this.width || !this.height) return null;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.width, this.height);
    r.clear();
    r.render(this.scene, this.camera); // (no triad; drawn from at once, before the buffer is cleared)
    // the part of the view the model is in (its box as seen), with a margin, about square
    let x0 = 0, y0 = 0, x1 = this.width, y1 = this.height;
    const b = this.body?.visible !== false || this.asmView ? this.contentBox() : null;
    if (b) {
      const v = new THREE.Vector3();
      let a0 = Infinity, b0 = Infinity, a1 = -Infinity, b1 = -Infinity;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).project(this.camera);
        const sx = ((v.x + 1) / 2) * this.width, sy = ((1 - v.y) / 2) * this.height;
        a0 = Math.min(a0, sx); a1 = Math.max(a1, sx); b0 = Math.min(b0, sy); b1 = Math.max(b1, sy);
      }
      const m = Math.max(a1 - a0, b1 - b0) * 0.08 + 8;
      a0 -= m; a1 += m; b0 -= m; b1 += m;
      // widen the narrow side towards square (at most to the whole view)
      const w = a1 - a0, h = b1 - b0;
      if (w < h * 0.75) { const d = (h * 0.75 - w) / 2; a0 -= d; a1 += d; } else if (h < w * 0.75) { const d = (w * 0.75 - h) / 2; b0 -= d; b1 += d; }
      x0 = Math.max(0, a0); y0 = Math.max(0, b0); x1 = Math.min(this.width, a1); y1 = Math.min(this.height, b1);
      if (x1 - x0 < 16 || y1 - y0 < 16) { x0 = 0; y0 = 0; x1 = this.width; y1 = this.height; }
    }
    const cw = x1 - x0, ch = y1 - y0, k = Math.min(1, max / Math.max(cw, ch));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(cw * k));
    out.height = Math.max(1, Math.round(ch * k));
    const ctx = out.getContext('2d');
    // the view's background (the canvas itself is transparent there)
    const g = ctx.createLinearGradient(0, -y0 * k, 0, (this.height - y0) * k);
    g.addColorStop(0, '#c5d3e2'); g.addColorStop(0.55, '#eef2f6'); g.addColorStop(1, '#ffffff');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, out.width, out.height);
    const sx = cv.width / this.width, sy = cv.height / this.height; // (device pixels)
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cv, x0 * sx, y0 * sy, cw * sx, ch * sy, 0, 0, out.width, out.height);
    try { return out.toDataURL('image/jpeg', 0.88); } catch { return null; }
  }

  setDisplayStyle(s) { this.displayStyle = s; this.applyDisplayStyle(); }

  applyDisplayStyle() {
    const s = this.displayStyle;
    // shaded: per-body colours from the vertex colour attribute; hidden-lines-removed: white
    this.bodyMat.vertexColors = s !== 'hlr' && !!this.body?.geometry.getAttribute('color');
    this.bodyMat.color.set(s === 'hlr' || this.bodyMat.vertexColors ? 0xffffff : this.bodyColor ?? 0xc3cad4);
    this.bodyMat.emissive.set(s === 'hlr' ? 0xffffff : 0x000000);
    this.bodyMat.colorWrite = s !== 'wireframe';
    this.bodyMat.depthWrite = s !== 'wireframe';
    this.bodyMat.needsUpdate = true;
    this.glassMat.vertexColors = this.bodyMat.vertexColors;
    this.glassMat.color.copy(this.bodyMat.color);
    this.glassMat.emissive.copy(this.bodyMat.emissive);
    this.glassMat.colorWrite = this.bodyMat.colorWrite;
    this.glassMat.needsUpdate = true;
    if (this.body) this.body.visible = true;
    if (this.edges) this.edges.visible = s !== 'shaded';
    this.edgeMat.depthTest = s !== 'wireframe';
    this.edgeMat.color.set(s === 'wireframe' ? wireColor() : 0x14181f);
    this.asmView?.applyDisplayStyle(s);
  }

  // sec: { normal, constant, more: [{ normal, constant }…] } (more: further planes; then only what all of them cut away
  // is gone, e.g. a quarter cut) or null
  setSection(sec) {
    this.section = sec;
    const planes = this.sectionPlanes(), many = planes.length > 1;
    this.asmView?.setClipping(planes, many);
    for (const m of [this.bodyMat, this.glassMat, this.edgeMat]) { m.clippingPlanes = planes; m.clipIntersection = many; m.needsUpdate = true; }
    this._updateSectionCaps();
  }

  // The section view's arrow: at p on the cut, along n (both THREE.Vector3; null hides it), drawn over the model
  // at the same size on the screen whatever the zoom. Dragged to move the cut (main.js).
  setSectionArrow(a) {
    if (!a) {
      if (this._secArrow) { this.scene.remove(this._secArrow.group); this.frameCallbacks.delete(this._secArrow.place); this._secArrow.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); this._secArrow = null; }
      return;
    }
    if (!this._secArrow) {
      const group = new THREE.Group(), mat = new THREE.MeshBasicMaterial({ color: 0x2b7de9, depthTest: false, transparent: true, opacity: 0.95 });
      // (in pixels: a shaft from the cut to a head, pointing along +y, turned onto n below)
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 52, 12).translate(0, 26, 0), mat);
      const head = new THREE.Mesh(new THREE.ConeGeometry(8, 22, 20).translate(0, 63, 0), mat);
      const base = new THREE.Mesh(new THREE.SphereGeometry(4.5, 16, 10), mat);
      // (a fatter invisible shape to catch the mouse)
      const grip = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 80, 8).translate(0, 36, 0), new THREE.MeshBasicMaterial({ visible: false }));
      for (const m of [shaft, head, base]) m.renderOrder = 12;
      group.add(shaft, head, base, grip);
      const place = () => { const k = this.worldPerPixel(); group.scale.set(k, k, k); group.updateMatrixWorld(true); };
      this._secArrow = { group, mat, grip, place };
      this.frameCallbacks.add(place);
      this.scene.add(group);
    }
    const { group } = this._secArrow;
    group.position.copy(a.p);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), a.n.clone().normalize());
    this._secArrow.place();
  }
  // whether the section arrow is under the cursor
  sectionArrowAt(ev) {
    const sa = this._secArrow;
    if (!sa) return false;
    sa.place();
    this.aimRay(ev);
    return this.raycaster.intersectObject(sa.group, true).length > 0;
  }
  setSectionArrowHover(on) {
    if (this._secArrow) this._secArrow.mat.color.setHex(on ? 0xf59e0b : 0x2b7de9);
  }

  // Solid caps on the cut face using the stencil buffer: back faces increment,
  // front faces decrement; where the count is non-zero we're inside the solid.
  // One cap per body (component), in its colour with section lines: the angle alternates and the
  // spacing varies from body to body (hatchStyle), so the parts read apart.
  _updateSectionCaps() {
    if (this.capGroup) {
      this.scene.remove(this.capGroup);
      this.capGroup.traverse((o) => { if (o.material) o.material.dispose(); if (o.isMesh && !o.userData.shared && o.geometry !== this.body?.geometry) o.geometry.dispose(); });
      this.capGroup = null;
    }
    const asm = this.asmView?.capSources?.() || null;
    // (an assembly with nothing in it yet: nothing to cap)
    if (!this.section || (!asm && (!this.body || !this.bodyGeo)) || (asm && !this.contentBox())) return;
    // (several planes: each capped where the others cut away too, as only what all of them cut away is gone)
    const planes = this.sectionPlanes();
    const grp = new THREE.Group();
    const sphere = asm ? this.contentBox().getBoundingSphere(new THREE.Sphere()) : (this.bodyGeo.computeBoundingSphere(), this.bodyGeo.boundingSphere);
    // the base spacing: a round number about a fortieth of the model's size
    const raw = Math.max(sphere.radius, 1) / 20;
    const p10 = 10 ** Math.floor(Math.log10(raw)), m = raw / p10;
    const gap0 = (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p10;
    const size = this.planeSize() * 4;
    // the bodies (each a closed solid) to cap: hidden and surface bodies are left out
    // (the mesh's own triangle order: the BVH reorders the geometry's index)
    const idx = asm ? null : this.mesh.triangles, V = asm ? null : this.mesh.vertices;
    const outline = [];
    // (an assembly: each part shown, with every place it is used: asmview.js)
    const list = asm ? asm.map((src, bi) => ({ b: null, bi, src }))
      : this.bodies.length
        ? this.bodies.map((b, bi) => ({ b, bi })).filter(({ b, bi }) => !this.hiddenBodies?.has(bi) && b.kind !== 'surface' && b.triCount)
        : [{ b: null, bi: 0 }];
    const N = list.length * planes.length, col = new THREE.Color();
    const geos = new Map(); // (each body's own triangles, once for all the planes)
    let k = 0;
    planes.forEach((plane, pi) => {
      // (the other planes turned round: what they cut away is kept, so the cap shows only there)
      const others = planes.filter((_, j) => j !== pi).map((q) => new THREE.Plane(q.normal.clone().negate(), -q.constant));
      const removedByOthers = (p) => others.every((q) => q.distanceToPoint(p) >= -1e-9);
      const stencilMat = (side, op) => new THREE.MeshBasicMaterial({
        side, clippingPlanes: [plane], depthWrite: false, depthTest: false, colorWrite: false,
        stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilFail: op, stencilZFail: op, stencilZPass: op,
      });
      const center = new THREE.Vector3();
      plane.projectPoint(sphere.center, center);
      // the plane's own axes (the hatching is laid out in them)
      const n = plane.normal.clone().normalize();
      const u = new THREE.Vector3().crossVectors(n, Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
      const v = new THREE.Vector3().crossVectors(n, u);
      list.forEach(({ b, bi, src }) => {
        let geo = this.bodyGeo;
        if (b) {
          geo = geos.get(bi);
          if (!geo) {
            geo = new THREE.BufferGeometry();
            geo.setAttribute('position', this.bodyGeo.getAttribute('position'));
            geo.setIndex(new THREE.BufferAttribute(idx.subarray(b.triStart, b.triStart + b.triCount), 1));
            geos.set(bi, geo);
          }
        }
        // (an assembly's part: its mesh drawn in every place it is used, as the view draws it)
        const stencilMesh = (side, op) => {
          if (!src) { const ms = new THREE.Mesh(geo, stencilMat(side, op)); if (b && pi) ms.userData.shared = true; return ms; }
          const mi = new THREE.InstancedMesh(src.geo, stencilMat(side, op), src.count);
          mi.instanceMatrix = src.instanceMatrix; mi.count = src.count; mi.frustumCulled = false;
          mi.userData.shared = true;
          return mi;
        };
        const back = stencilMesh(THREE.BackSide, THREE.IncrementWrapStencilOp);
        const front = stencilMesh(THREE.FrontSide, THREE.DecrementWrapStencilOp);
        // its outline on the plane: its triangles cut by the plane (where the other planes cut away too)
        const t0 = src ? 0 : b ? b.triStart : 0, t1 = src ? 0 : b ? b.triStart + b.triCount : idx.length;
        const nx = n.x, ny = n.y, nz = n.z, c0 = plane.constant;
        for (let t = t0; t + 2 < t1; t += 3) {
          const i0 = idx[t] * 3, i1 = idx[t + 1] * 3, i2 = idx[t + 2] * 3;
          const P = [i0, i1, i2], d = P.map((i) => V[i] * nx + V[i + 1] * ny + V[i + 2] * nz + c0);
          const hits = [];
          for (let e = 0; e < 3; e++) {
            const a = e, c = (e + 1) % 3;
            if ((d[a] > 0) === (d[c] > 0) || d[a] === d[c]) continue;
            const f = d[a] / (d[a] - d[c]), A = P[a], C = P[c];
            hits.push(new THREE.Vector3(V[A] + (V[C] - V[A]) * f, V[A + 1] + (V[C + 1] - V[A + 1]) * f, V[A + 2] + (V[C + 2] - V[A + 2]) * f));
          }
          if (hits.length === 2 && (!others.length || (removedByOthers(hits[0]) && removedByOthers(hits[1])))) outline.push(hits[0], hits[1]);
        }
        const hs = hatchStyle(bi);
        const a = ((hs.angle + 90 * pi) * Math.PI) / 180;
        col.set(src ? src.color : (Array.isArray(this.bodyColors) ? this.bodyColors[bi] : this.bodyColors) ?? this.bodyColor ?? 0x8ea6c8);
        const base = col.clone().lerp(new THREE.Color(0x8ea6c8), 0.25).multiplyScalar(0.92);
        const ink = col.clone().multiplyScalar(0.28);
        const cap = new THREE.Mesh(
          new THREE.PlaneGeometry(size, size),
          new THREE.ShaderMaterial({
            side: THREE.DoubleSide,
            uniforms: {
              uBase: { value: base }, uInk: { value: ink }, uO: { value: center.clone() }, uU: { value: u.clone() }, uV: { value: v.clone() },
              uDir: { value: new THREE.Vector2(-Math.sin(a), Math.cos(a)) }, uGap: { value: gap0 * hs.mult },
            },
            // (clipped by the other planes, turned round: shown only where they cut away too)
            clipping: true, clippingPlanes: others,
            vertexShader: `varying vec3 vW;
              #include <clipping_planes_pars_vertex>
              void main() {
                vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
                vec4 mvPosition = viewMatrix * w;
                gl_Position = projectionMatrix * mvPosition;
                #include <clipping_planes_vertex>
              }`,
            fragmentShader: `uniform vec3 uBase, uInk, uO, uU, uV; uniform vec2 uDir; uniform float uGap; varying vec3 vW;
              #include <clipping_planes_pars_fragment>
              void main() {
                #include <clipping_planes_fragment>
                vec3 d = vW - uO;
                float s = dot(vec2(dot(d, uU), dot(d, uV)), uDir) / uGap;
                float w = max(fwidth(s), 1e-6);
                float line = 1.0 - smoothstep(0.55, 1.35, abs(fract(s + 0.5) - 0.5) / w);
                line *= 1.0 - smoothstep(0.2, 0.45, w); // (too dense when far away: the lines fade out)
                gl_FragColor = vec4(mix(uBase, uInk, line), 1.0);
                #include <colorspace_fragment>
              }`,
            stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
            stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
            polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, // (the outline sits on it)
          }),
        );
        cap.position.copy(center);
        cap.lookAt(center.clone().add(n));
        // (each body's stencil passes, then its cap, before the next body's (and the next plane's))
        back.renderOrder = front.renderOrder = 6 + (k * 2) / (2 * N + 1);
        cap.renderOrder = 6 + (k * 2 + 1) / (2 * N + 1);
        cap.onAfterRender = (r) => r.clearStencil();
        grp.add(back, front, cap);
        k++;
      });
    });
    if (outline.length) {
      const ol = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(outline), new THREE.LineBasicMaterial({ color: 0x14181f }));
      ol.renderOrder = 7.5;
      grp.add(ol);
    }
    this.capGroup = grp;
    this.scene.add(grp);
  }

  // Non-edited sketches: drawn as thin blue outlines.
  setSketches(list) {
    for (const c of [...this.sketchGroup.children]) { this.sketchGroup.remove(c); c.geometry.dispose(); c.material?.dispose(); }
    this.dottedMats = [];
    for (const s of list) {
      for (const construction of [false, true]) {
        const pts = [], dist = [];
        for (const pl of s.polylines) {
          if (!!pl.construction !== construction) continue;
          let cum = 0; // distance along the curve, so the dots run on across its short segments
          for (let i = 0; i < pl.pts.length - 1; i++) {
            const a = pl.pts[i], b = pl.pts[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
            pts.push(G.toWorld(s.frame, a[0], a[1]), G.toWorld(s.frame, b[0], b[1]));
            dist.push(cum, cum + L);
            cum += L;
          }
        }
        if (!pts.length) continue;
        const g = new THREE.BufferGeometry().setFromPoints(pts);
        const color = s.color ?? (s.highlight ? 0x0ea5e9 : 0x2563eb);
        const m = construction
          ? new THREE.LineDashedMaterial({ color, depthTest: false, transparent: !s.reference, opacity: s.reference?1:0.75, dashSize: 1, gapSize: 1 })
          : new THREE.LineBasicMaterial({ color, depthTest: false, transparent: !s.reference, opacity: s.reference||s.highlight ? 1 : 0.85 });
        const l = new THREE.LineSegments(g, m);
        if (construction) { g.setAttribute('lineDistance', new THREE.Float32BufferAttribute(dist, 1)); this.dottedMats.push(m); }
        l.renderOrder = 5;
        this.sketchGroup.add(l);
      }
    }
  }

  setLoftTags(tags) {
    for (const tag of this._loftTags || []) { tag.el.remove(); this.frameCallbacks.delete(tag.place); }
    this._loftTags = tags.map((tag) => {
      const el = document.createElement('div'); el.className = 'plabel'; el.dataset.loftLabel = '';
      el.textContent = tag.text; el.style.color = '#' + tag.color.toString(16).padStart(6, '0');
      this.labelsEl.appendChild(el);
      const place = () => { const p = this.project(tag.at); el.style.left = p.x + 8 + 'px'; el.style.top = p.y - 18 + 'px'; };
      this.frameCallbacks.add(place); place();
      return { el, place };
    });
  }

  setLoftConnections(info,active=-1){
    const key=JSON.stringify([info,active]);if(this._loftConnectionKey===key)return;this._loftConnectionKey=key;
    if(!this.loftConnectionGroup){this.loftConnectionGroup=new THREE.Group();this.scene.add(this.loftConnectionGroup);}
    for(const child of [...this.loftConnectionGroup.children]){this.loftConnectionGroup.remove(child);child.geometry.dispose();child.material.dispose();}
    this.setPointMarks('loft-connection-labels',null);this.setPointMarks('loft-connection-target',null);
    if(!info?.sections?.length)return;
    const vertices=[],labels=[];
    info.sections.forEach((section,i)=>{
      const points=section.points.map(p=>new THREE.Vector3(...p)),geometry=new THREE.BufferGeometry().setFromPoints(points);
      this.loftConnectionGroup.add(new THREE.Points(geometry,new THREE.PointsMaterial({size:i===active?10:7,sizeAttenuation:false,color:i===active?0xf59e0b:0x0891b2,depthTest:false})));
      if(i)for(let j=0;j<section.points.length;j++){
        const a=info.sections[i-1].points[j],b=section.points[j];if(!a)continue;vertices.push(new THREE.Vector3(...a),new THREE.Vector3(...b));
        if(i===1)labels.push({p:a.map((x,k)=>(x+b[k])/2),text:'C'+(j+1),cls:'pick'});
      }
    });
    this.loftConnectionGroup.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(vertices),new THREE.LineBasicMaterial({color:0x0891b2,transparent:true,opacity:.85,depthTest:false})));
    this.setPointMarks('loft-connection-labels',labels);
  }

  // Reference planes: list of {id, name, frame, state: 'normal'|'hover'|'selected'}
  setPlanes(list) {
    for (const c of [...this.planeGroup.children]) { this.planeGroup.remove(c); c.traverse((o) => o.geometry?.dispose()); }
    this.planeVis = list;
    const size = this.planeSize();
    for (const p of list) {
      const grp = new THREE.Group();
      const m = G.frameMatrix(p.frame);
      grp.matrixAutoUpdate = false;
      grp.matrix.copy(m);
      const col = p.state === 'selected' ? 0x2b7de9 : p.state === 'hover' || p.state === 'preview' ? 0xf59e0b : 0x7f9cc4;
      // Display defined planes near their references, without moving sketch frames.
      let cx = 0, cy = 0;
      if (!G.STD_PLANES[p.id]) {
        const d = (p.displayAnchor?new THREE.Vector3(...p.displayAnchor):this.rotationPivot()).sub(p.frame.o);
        cx = d.dot(p.frame.u); cy = d.dot(p.frame.v);
      }
      const fill = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size).translate(cx, cy, 0),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: p.state === 'normal' ? 0.1 : 0.22, side: THREE.DoubleSide, depthWrite: false }),
      );
      fill.userData.planeId = p.id;
      const h = size / 2;
      const border = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y]) => new THREE.Vector3(x + cx, y + cy, 0))),
        new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: p.state === 'normal' ? 0.6 : 1 }),
      );
      grp.add(fill, border);
      grp.userData = { planeId: p.id, corner: G.toWorld(p.frame, cx - h, cy + h) };
      this.planeGroup.add(grp);
    }
    // labels
    for (const [id, el] of this.planeLabels) if (!list.find((p) => p.id === id)) { el.remove(); this.planeLabels.delete(id); }
    for (const p of list) {
      let el = this.planeLabels.get(p.id);
      if (!el) { el = document.createElement('div'); el.className = 'plabel'; this.labelsEl.appendChild(el); this.planeLabels.set(p.id, el); }
      el.textContent = p.name;
    }
  }

  // The box of the model shown (a part's body, or an assembly's components), or null.
  contentBox() {
    if (this.asmView) { const b = this.asmView.box(); return b.isEmpty() ? null : b; }
    if (!this.bodyGeo) return null;
    this.bodyGeo.computeBoundingBox();
    return this.bodyGeo.boundingBox;
  }

  planeSize() {
    const b = this.contentBox();
    if (b) {
      const s = new THREE.Vector3();
      b.getSize(s);
      return Math.max(80, Math.max(s.x, s.y, s.z) * 1.3);
    }
    return 120;
  }

  _buildOrigin() {
    const g = new THREE.Group();
    const mk = (dir, color) => {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(...dir).multiplyScalar(8)]);
      return new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false }));
    };
    // Keep X red, Y green and Z blue in the user's axes, as in the corner triad.
    g.add(mk(W.fromUser([1, 0, 0]), 0xc62828), mk(W.fromUser([0, 1, 0]), 0x2e7d32), mk(W.fromUser([0, 0, 1]), 0x1d4ed8));
    g.renderOrder = 4;
    g.children.forEach((c) => (c.renderOrder = 4));
    this.origin = g;
    this.scene.add(g);
  }

  // The triad and the origin again, for the part's up axis (wcs.js)
  setUpAxis() {
    this.triadScene?.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); });
    this._buildTriad();
    const vis = this.origin?.visible ?? true;
    if (this.origin) { this.scene.remove(this.origin); this.origin.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); }
    this._buildOrigin();
    this.origin.visible = vis;
  }

  _buildTriad() {
    this.triadScene = new THREE.Scene();
    this.triadCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, -10, 10);
    const mkLabel = (txt, color) => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const ctx = c.getContext('2d');
      ctx.font = 'bold 44px Segoe UI, sans-serif';
      ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(txt, 32, 34);
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
      s.scale.set(0.55, 0.55, 1);
      return s;
    };
    // (the user's axes: with Z up, Y along RazorCAD's −Z and Z along its Y, see wcs.js)
    const axes = [[W.fromUser([1, 0, 0]), 0xd32f2f, 'X', '#d32f2f'], [W.fromUser([0, 1, 0]), 0x2e7d32, 'Y', '#2e7d32'], [W.fromUser([0, 0, 1]), 0x1d4ed8, 'Z', '#1d4ed8']];
    for (const [d, col, t, css] of axes) {
      const dir = new THREE.Vector3(...d);
      this.triadScene.add(new THREE.ArrowHelper(dir, new THREE.Vector3(), 1, col, 0.3, 0.16));
      const l = mkLabel(t, css);
      l.position.copy(dir).multiplyScalar(1.32);
      this.triadScene.add(l);
    }
  }

  // ------------------------------------------------------------ frame loop
  _frameAnim() {
    const a = this.anim;
    if (!a) return;
    const k = a.dur > 0 ? Math.min(1, (performance.now() - a.t0) / a.dur) : 1;
    a.step(k < 1 ? 1 - Math.pow(1 - k, 3) : 1);
    if (k >= 1 && this.anim === a) this.anim = null;
  }

  _frame() {
    // keep the stored size in step with the canvas (a missed resize would offset picking and labels)
    if (this.container.clientWidth !== this.width || this.container.clientHeight !== this.height) this.resize();
    this._frameAnim();
    this._scaleOrigin();
    this._fitDepth();
    // construction geometry is dotted at a constant size on screen
    if (this.dottedMats?.length) { const w = this.worldPerPixel(); for (const m of this.dottedMats) { m.dashSize = 2 * w; m.gapSize = 3 * w; } }

    for (const cb of this.frameCallbacks) cb();
    this._placePlaneLabels();
    const r = this.renderer;
    r.setScissorTest(false);
    r.clear();
    r.setViewport(0, 0, this.width, this.height);
    r.render(this.scene, this.camera);
    // triad in the lower-left corner
    const s = 90;
    this.triadCam.position.set(0, 0, 5).applyQuaternion(this.camera.quaternion);
    this.triadCam.quaternion.copy(this.camera.quaternion);
    r.clearDepth();
    r.setScissorTest(true);
    r.setScissor(4, 4, s, s);
    r.setViewport(4, 4, s, s);
    r.render(this.triadScene, this.triadCam);
    r.setScissorTest(false);
  }

  // The camera's depth range keeps all of the model, however big it is and wherever the view has been panned to
  // (the view is orthographic, so depth only clips: at least ±20 m, as it always was). The model's size is
  // measured again only when it changes (contentChanged).
  contentChanged() { this._depthBox = undefined; }
  _fitDepth() {
    if (this._depthBox === undefined) {
      const b = this.contentBox();
      this._depthBox = b ? b.getBoundingSphere(new THREE.Sphere()) : null;
    }
    const s = this._depthBox, cam = this.camera;
    const far = s ? Math.max(20000, cam.position.distanceTo(s.center) + s.radius * 1.05 + 100) : 20000;
    if (Math.abs(far - cam.far) > far * 0.02) { cam.near = -far; cam.far = far; cam.updateProjectionMatrix(); }
  }

  _scaleOrigin() {
    const s = this.worldPerPixel() * 3;
    this.origin.scale.setScalar(s);
  }

  _placePlaneLabels() {
    for (const l of this.refLabels || []) {
      const p = this.project(l.world);
      l.el.style.left = p.x + 34 + 'px';
      l.el.style.top = p.y - 8 + 'px';
    }
    for (const grp of this.planeGroup.children) {
      const el = this.planeLabels.get(grp.userData.planeId);
      if (!el) continue;
      const p = this.project(grp.userData.corner);
      el.style.left = p.x + 30 + 'px';
      el.style.top = p.y + 10 + 'px';
    }
  }

  // Camera state, so each part (tab) keeps its own view.
  saveView() {
    return { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone(), zoom: this.camera.zoom, target: this.controls.target.clone() };
  }

  restoreView(v) {
    this.anim = null;
    this.camera.position.copy(v.pos);
    this.camera.quaternion.copy(v.quat);
    this.camera.zoom = v.zoom;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(v.target);
  }

  // Measure result: a line between the closest points a and b with a label (null clears it).
  setMeasure(m) {
    if (this._measure) {
      this.overlayGroup.remove(this._measure.line);
      this._measure.line.geometry.dispose();
      this._measure.label.remove();
      this.frameCallbacks.delete(this._measure.place);
      this._measure = null;
    }
    if (!m) return;
    const a = new THREE.Vector3(...m.a), b = new THREE.Vector3(...m.b);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineDashedMaterial({ color: 0xd97706, dashSize: 3, gapSize: 2, depthTest: false }));
    line.computeLineDistances();
    line.renderOrder = 20;
    const label = document.createElement('div');
    label.className = 'measure-label';
    label.textContent = m.text;
    this.labelsEl.appendChild(label);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const place = () => {
      const s = this.project(mid);
      label.style.left = s.x + 'px';
      label.style.top = s.y + 'px';
      // keep the dashes a constant size on screen
      const w = this.worldPerPixel();
      line.material.dashSize = 6 * w; line.material.gapSize = 4 * w;
    };
    this.overlayGroup.add(line);
    this.frameCallbacks.add(place);
    place();
    this._measure = { line, label, place };
  }

  // Quick dimension readout of the selected edges / sketch curves: a small tag at the world point t.at
  // showing t.html, following the view (null clears it).
  setDimTag(t) {
    if (this._dimTag) { this._dimTag.el.remove(); this.frameCallbacks.delete(this._dimTag.place); this._dimTag = null; }
    if (!t) return;
    const el = document.createElement('div');
    el.className = 'dim-tag';
    el.innerHTML = t.html;
    this.labelsEl.appendChild(el);
    const at = new THREE.Vector3(...t.at);
    const place = () => { const s = this.project(at); el.style.left = s.x + 'px'; el.style.top = s.y + 'px'; };
    this.frameCallbacks.add(place);
    place();
    this._dimTag = { el, place };
  }

  // ------------------------------------------------------------ helpers
  worldPerPixel() {
    return (this.camera.top - this.camera.bottom) / this.camera.zoom / (this.height || 1);
  }

  project(world) {
    const v = world.clone().project(this.camera);
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height };
  }

  ndc(ev) {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  }

  screenPos(ev) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  // The raycaster aimed through the cursor, starting at the camera's near side. (The view is orthographic and
  // draws what is in front of the camera's position too: a ray starting there would pass through what is
  // nearest — easily metres of a big assembly — and pick what is behind it.)
  aimRay(ev) {
    this.camera.updateMatrixWorld(); // (as the view is now, even before the next frame is drawn)
    this.raycaster.setFromCamera(this.ndc(ev), this.camera);
    this.raycaster.ray.origin.addScaledVector(this.raycaster.ray.direction, this.camera.near);
    return this.raycaster;
  }

  // How far along dir (unit, THREE.Vector3) the pointer has dragged something at `at` (a point), from `from` to `ev`
  // (client coordinates): the movement along dir as the screen shows it; or, when dir points (nearly) at the viewer
  // (seen shorter than a quarter of its length), the movement up the screen, toward the viewer
  dragAlong(dir, at, from, ev) {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const R = this.canvas.getBoundingClientRect(), wpp = this.worldPerPixel();
    const p0 = at.clone().project(cam), p1 = at.clone().addScaledVector(dir, wpp).project(cam);
    // (pixels on the screen for one pixel's length along dir)
    const sx = ((p1.x - p0.x) * R.width) / 2, sy = (-(p1.y - p0.y) * R.height) / 2, L = Math.hypot(sx, sy);
    const mx = ev.clientX - from.clientX, my = ev.clientY - from.clientY;
    if (L >= 0.25) return ((mx * sx + my * sy) / (L * L)) * wpp;
    const toward = dir.dot(new THREE.Vector3(0, 0, 1).applyQuaternion(cam.quaternion)) >= 0 ? 1 : -1;
    return -my * wpp * toward;
  }

  rayPlane(ev, frame) {
    this.aimRay(ev);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(frame.n, frame.o);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, hit)) {
      // ray parallel to plane: project origin
      plane.projectPoint(this.raycaster.ray.origin, hit);
    }
    return hit;
  }

  pickBody(ev) {
    if (!this.body) return null;
    this.aimRay(ev);
    const hits = this.raycaster.intersectObject(this.body, false).filter((h) => !this.section || this._sectionKeeps(h.point));
    if (!hits.length) return null;
    // the BVH reorders the index buffer, so identify the B-rep face through the vertex
    return { point: hits[0].point, face: this.vertexFace[hits[0].face.a], distance: hits[0].distance };
  }

  // The bodies not drawn (hidden) under the cursor, front to back, as indices in mesh.bodies (for Shift+Tab).
  hiddenBodiesAt(ev) {
    if (!this.bodyGeo || !this.hiddenBodies?.size || !this.bodies.length) return [];
    if (!this._hiddenPick) {
      const tris = this.mesh.triangles, keep = [];
      this.bodies.forEach((b, bi) => { if (this.hiddenBodies.has(bi)) keep.push(tris.subarray(b.triStart, b.triStart + b.triCount)); });
      const idx = new Uint32Array(keep.reduce((n, a) => n + a.length, 0));
      let o = 0;
      for (const a of keep) { idx.set(a, o); o += a.length; }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', this.bodyGeo.getAttribute('position'));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      geo.computeBoundsTree();
      this._hiddenPick = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    }
    this.aimRay(ev);
    const out = [];
    for (const h of this.raycaster.intersectObject(this._hiddenPick, false)) {
      const bi = this.faceBody[this.vertexFace[h.face.a]];
      if (!out.includes(bi)) out.push(bi);
    }
    return out;
  }

  // Everything under the cursor, front to back: [{ face, body, point }] (for Shift+right-click cycling).
  hitsAt(ev) {
    if (!this.body) return [];
    this.aimRay(ev);
    return this.raycaster.intersectObject(this.body, false)
      .filter((h) => !this.section || this._sectionKeeps(h.point))
      .map((h) => { const face = this.vertexFace[h.face.a]; return { face, body: this.faceBody?.[face] ?? -1, point: h.point }; });
  }

  // the section's planes (THREE.Plane: what is on their back side is cut away)
  sectionPlanes() {
    const s = this.section;
    return s ? [s, ...(s.more || [])].map((q) => new THREE.Plane(q.normal.clone(), q.constant)) : [];
  }
  // whether a point is still shown (with several planes: unless all of them cut it away)
  _sectionKeeps(p) {
    const s = this.section;
    return [s, ...(s.more || [])].some((q) => q.normal.dot(p) + q.constant >= 0);
  }

  pickPlane(ev) {
    const meshes = [];
    this.planeGroup.children.forEach((g) => { g.updateMatrixWorld(true); meshes.push(g.children[0]); });
    if (!meshes.length) return null;
    this.aimRay(ev);
    const hits = this.raycaster.intersectObjects(meshes, false);
    return hits.length ? { id: hits[0].object.userData.planeId, distance: hits[0].distance } : null;
  }

  // Face highlights: kind = 'hover' | 'select'
  setFaceHighlight(kind, face) {
    const key = '_hl_' + kind;
    if (this[key]) { this.highlightGroup.remove(this[key]); this[key].geometry.dispose(); this[key] = null; }
    if (!face) return;
    const mesh = new THREE.Mesh(
      face.geometry.clone(),
      new THREE.MeshBasicMaterial({
        color: kind === 'hover' ? 0xf59e0b : 0x2b7de9, transparent: true, opacity: face.xray ? 0.32 : kind === 'hover' ? 0.35 : 0.45,
        depthWrite: false, depthTest: !face.xray, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        clippingPlanes: this.bodyMat.clippingPlanes,
      }),
    );
    mesh.renderOrder = face.xray ? 8 : 3;
    this[key] = mesh;
    this.highlightGroup.add(mesh);
  }

  // Highlight a set of faces/bodies. key: 'pm' (picked into a Property panel), 'featureSel' /
  // 'featureHover' (the faces a feature made, for the feature selected / hovered in the tree).
  setFaceSet(infos, key = 'pm') {
    this._faceSets ||= {};
    const old = this._faceSets[key];
    if (old) {
      this.highlightGroup.remove(old);
      old.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
      delete this._faceSets[key];
    }
    if (!infos?.length) return;
    const color = key === 'featureHover' || key === 'cycle' ? 0xf59e0b : 0x2b7de9; // cycle: candidate (orange)
    const grp = new THREE.Group();
    for (const info of infos) {
      if (!info) continue;
      const m = new THREE.Mesh(info.geometry.clone(), new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: key === 'pm' ? 0.4 : 0.38, depthWrite: false, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, clippingPlanes: this.bodyMat.clippingPlanes,
      }));
      m.renderOrder = key === 'featureHover' ? 4 : 3;
      grp.add(m);
      if (key !== 'pm') {
        // features: also show the faces through the body (e.g. the walls of a cut inside it),
        // faintly filled and outlined, like a transparent preview
        const xray = new THREE.Mesh(m.geometry, new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.16, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
          clippingPlanes: this.bodyMat.clippingPlanes,
        }));
        xray.renderOrder = 8;
        const outline = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30), new THREE.LineBasicMaterial({
          color: new THREE.Color(color).multiplyScalar(0.75), transparent: true, opacity: 0.85, depthTest: false,
          clippingPlanes: this.bodyMat.clippingPlanes,
        }));
        outline.renderOrder = 9;
        grp.add(xray, outline);
      }
    }
    this._faceSets[key] = grp;
    this.highlightGroup.add(grp);
  }

  // Index of the B-rep face nearest to a world point (for stored face references).
  // Colour single faces (appearances): [[face index, colour]], over the body colours.
  setFaceColors(pairs) {
    const geo = this.bodyGeo, mesh = this.mesh;
    if (!geo || !mesh || !pairs?.length) return;
    const col = geo.getAttribute('color'), tris = mesh.triangles, gs = this.faceGroupScale || 1, c = new THREE.Color();
    if (!col) return;
    if (this._savedColors) { col.array.set(this._savedColors); this._savedColors = null; }
    for (const [fi, color] of pairs) {
      const g = mesh.faceGroups[fi];
      if (!g) continue;
      c.set(color);
      for (let k = g.start * gs; k < (g.start + g.count) * gs; k++) { const v = tris[k] * 3; col.array[v] = c.r; col.array[v + 1] = c.g; col.array[v + 2] = c.b; }
    }
    col.needsUpdate = true;
    if (this.analysis && this.analysis.kind !== 'zebra') this.applyAnalysis();
  }

  ensurePickIndex() {
    const g = this.body?.geometry;
    if (g && !g.boundsTree) g.computeBoundsTree();
  }

  faceIndexNear(p) {
    this.ensurePickIndex();
    if (!this.body?.geometry.boundsTree) return -1;
    const hit = this.body.geometry.boundsTree.closestPointToPoint(new THREE.Vector3(...p));
    if (!hit) return -1;
    const idx = this.body.geometry.index.array;
    return this.vertexFace[idx[hit.faceIndex * 3]];
  }

  clearFaceHighlights() {
    this.setFaceHighlight('hover', null);
    this.setFaceHighlight('select', null);
  }

  // ------------------------------------------------------------ views
  // Rotation center: the middle of the model (or of the sketches).
  // The point a rotation drag turns about, from where it started (ev: clientX / clientY): the model's surface
  // under the cursor (a part's bodies, an assembly's components; what a section view cuts away left out), or,
  // over empty space, that spot at the depth of the model's center.
  pivotAt(ev) {
    const hit = this.asmView ? this.asmView.pick(ev) : this.pickBody(ev);
    if (hit?.point) return hit.point.clone();
    const c = this.rotationPivot(), n = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion);
    return this.rayPlane(ev, { n, o: c });
  }
  // A small dot at the rotation pivot while a drag lasts (p: the point, or null to hide it).
  showPivot(p) {
    if (!this._pivotDot) {
      const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
      this._pivotDot = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xe11d48, size: 7, sizeAttenuation: false, depthTest: false, transparent: true }));
      this._pivotDot.renderOrder = 10;
      this._pivotDot.visible = false;
      this.scene.add(this._pivotDot);
    }
    this._pivotDot.visible = !!p;
    if (p) this._pivotDot.position.copy(p);
  }

  rotationPivot() {
    const box = new THREE.Box3(), content = this.contentBox();
    if (content) box.union(content);
    else this.sketchGroup.children.forEach((l) => { l.geometry.computeBoundingBox(); box.union(l.geometry.boundingBox); });
    return box.isEmpty() ? this.controls.target.clone() : box.getCenter(new THREE.Vector3());
  }

  // Animate to an orientation (quaternion), target point and zoom.
  animateTo({ quat = null, target = null, zoom = null, dur = 380 } = {}) {
    const cam = this.camera, c = this.controls;
    const q0 = cam.quaternion.clone(), q1 = quat ? quat.clone() : q0.clone();
    const t0 = c.target.clone(), t1 = target ? target.clone() : t0.clone();
    const z0 = cam.zoom, z1 = zoom ?? z0;
    const anim = {
      t0: performance.now(), dur, endQuat: q1,
      step: (k) => {
        cam.quaternion.slerpQuaternions(q0, q1, k);
        c.target.lerpVectors(t0, t1, k);
        cam.position.set(0, 0, CAM_DIST).applyQuaternion(cam.quaternion).add(c.target);
        cam.zoom = z0 + (z1 - z0) * k;
        cam.updateProjectionMatrix();
      },
    };
    if (dur <= 0) { anim.step(1); this.anim = null; return; }
    this.anim = anim;
  }

  setStandardView(name, animate = true) {
    const [d, u] = VIEWS[name];
    const quat = viewQuat(new THREE.Vector3(...d), new THREE.Vector3(...u));
    if (animate) this.animateTo({ quat });
    else this.animateTo({ quat, dur: 0 });
  }

  // Look straight at a plane with its "up" axis up. Repeating it flips to the back side.
  // Flatten view: a sheet metal part's flat pattern on its own (mesh + lines: [{ color, dashed, pts: [a, b, ...] pairs }]),
  // looked at from the top face (frame) and fitted.
  showFlat({ mesh, lines, frame }) {
    this.clearFlat();
    const grp = new THREE.Group();
    if (mesh) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(mesh.vertices, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
      geo.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
      const m = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({ color: 0xc9dbee, specular: 0x2a2f36, shininess: 30, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
      grp.add(m);
    }
    for (const l of lines || []) {
      const g = new THREE.BufferGeometry().setFromPoints(l.pts);
      const mat = l.dashed
        ? new THREE.LineDashedMaterial({ color: l.color, dashSize: l.dash || 2, gapSize: (l.dash || 2) * 0.6, depthTest: false })
        : new THREE.LineBasicMaterial({ color: l.color, depthTest: false });
      const ls = new THREE.LineSegments(g, mat);
      if (l.dashed) ls.computeLineDistances();
      ls.renderOrder = 10;
      grp.add(ls);
    }
    this.flatGroup = grp;
    this.scene.add(grp);
    const box = new THREE.Box3().setFromObject(grp);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 5);
    const aspect = this.width && this.height ? this.width / this.height : 1.6;
    this.animateTo({ quat: frame ? viewQuat(frame.n, frame.v) : null, target: sphere.center, zoom: (HALF_H * Math.min(1, aspect)) / (r * 1.15), dur: 380 });
  }

  clearFlat() {
    if (!this.flatGroup) return;
    this.scene.remove(this.flatGroup);
    this.flatGroup.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    this.flatGroup = null;
  }

  // Look straight at a plane. Asked again while already looking at it, it turns to the other side
  // unless `exact` (a sketch's own view: always from the side of frame.n).
  normalTo(frame, animate = true, exact = false) {
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(this.anim?.endQuat ?? this.camera.quaternion);
    const flip = !exact && back.dot(frame.n) > 0.9999;
    const quat = viewQuat(flip ? frame.n.clone().negate() : frame.n, frame.v);
    this.animateTo({ quat, dur: animate ? 380 : 0 });
  }

  zoomToFit(extraBox = null, animate = true) {
    const box = new THREE.Box3(), content = this.contentBox();
    if (content) box.union(content);
    this.sketchGroup.children.forEach((l) => { l.geometry.computeBoundingBox(); box.union(l.geometry.boundingBox); });
    if (extraBox) box.union(extraBox);
    if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 5);
    const aspect = this.width && this.height ? this.width / this.height : 1.6;
    const zoom = (HALF_H * Math.min(1, aspect)) / (r * 1.15);
    if (!this.width) this._fitPending = true;
    const quat = this.anim?.endQuat ?? this.camera.quaternion.clone();
    this.animateTo({ quat, target: sphere.center, zoom, dur: animate ? 300 : 0 });

  }

  // ------------------------------------------------------------ pointer
  _wirePointer() {
    const cv = this.canvas;
    let down = null;
    cv.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, button: e.button, t: performance.now() };
      this.onPointerDown?.(e);
    });
    window.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4;
      const d = down;
      down = null;
      this.onPointerUp?.(e);
      if (moved || e.target !== cv) return;
      if (this.controls?.consumed) { this.controls.consumed = false; return; } // (the press opened the tool wheel)
      if (d.button === 0) this.onClick?.(e);
      else if (d.button === 2) this.onContextMenu?.(e);
    });
    let pending = null;
    cv.addEventListener('pointermove', (e) => {
      this.lastPointer = { clientX: e.clientX, clientY: e.clientY }; // where the cursor is (Tab hides what is under it)
      this.onPointerMoveImmediate?.(e);
      if (pending) { pending = e; return; }
      pending = e;
      requestAnimationFrame(() => {
        const ev = pending; pending = null;
        if (!down || down.button !== 0) this.onHover?.(ev);
      });
    });
    cv.addEventListener('pointerleave', () => { this.lastPointer = null; this.onLeave?.(); });
    cv.addEventListener('dblclick', (e) => this.onDoubleClick?.(e));
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
