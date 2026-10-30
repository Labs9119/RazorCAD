// The assembly's 3D display. Each part's mesh goes to the graphics card once and is drawn at every component
// that uses it (instanced: one placement matrix per component), so moving, hiding or exploding a component only
// changes a matrix. Picking goes through the instance to the component, and to the part's own face and edge
// numbers (what mates refer to). Nothing is merged into one big mesh. Bodies and faces show the colours and
// transparency they have (from an import or their part), and the parts inside sub-assemblies are items too.
import * as THREE from 'three';
import { wireColor } from './theme.js';

// Edge lines drawn once per instance: three.js instances only meshes, so the lines use their own small shader.
// (with the section view's clipping)
const EDGE_VERT = `
attribute mat4 iMatrix;
#include <clipping_planes_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * iMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}`;
const EDGE_FRAG = `
uniform vec3 color;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  gl_FragColor = vec4(color, 1.0);
#include <colorspace_fragment>
}`;

// A part's mesh on the graphics card, with what picking needs. Its appearances go with it: a colour per vertex
// (each face's own colour, else its body's, else `color`, the part's), and the triangles of transparent bodies
// and faces in groups of their own (one per opacity, after the opaque ones: group 0).
function partGPU(mesh, color) {
  const tris = mesh.triangles;
  const total = mesh.faceGroups.reduce((s, g) => s + g.count, 0);
  const gs = total === tris.length ? 1 : 3;
  // each face's body, colour and opacity
  const faceBody = new Int32Array(mesh.faceGroups.length).fill(-1);
  (mesh.bodies || []).forEach((b, bi) => faceBody.fill(bi, b.faceStart, b.faceStart + b.faceCount));
  const col = new Float32Array(mesh.vertices.length), c = new THREE.Color();
  const runs = new Map(); // opacity → [[start, end) index ranges]
  mesh.faceGroups.forEach((g, gi) => {
    const b = mesh.bodies?.[faceBody[gi]];
    c.set(g.look?.c ?? b?.color ?? color ?? 0xc3cad4);
    const t = g.look?.t || b?.transparency || 0;
    const op = t > 0 ? Math.round(Math.max(0.1, 1 - t) * 100) / 100 : 1;
    if (!runs.has(op)) runs.set(op, []);
    runs.get(op).push([g.start * gs, (g.start + g.count) * gs]);
    for (let k = g.start * gs; k < (g.start + g.count) * gs; k++) { const v = tris[k] * 3; col[v] = c.r; col[v + 1] = c.g; col[v + 2] = c.b; }
  });
  // the index: opaque triangles first, then each opacity's (as geometry groups, for the materials)
  const ops = [...runs.keys()].sort((a, b) => b - a);
  const index = new Uint32Array(tris.length), groups = [];
  let at = 0;
  for (const op of ops) {
    const from = at;
    for (const [a, z] of runs.get(op)) { index.set(tris.subarray(a, z), at); at += z - a; }
    groups.push({ op, start: from, count: at - from });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mesh.vertices, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(index, 1)); // (its own copy: the BVH reorders it)
  const glass = groups.length > 1 || groups[0]?.op !== 1;
  if (glass) groups.forEach((g, i) => geo.addGroup(g.start, g.count, i));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.computeBoundsTree();
  // each vertex's B-rep face (vertices are not shared between faces)
  const vertexFace = new Int32Array(mesh.vertices.length / 3).fill(-1);
  mesh.faceGroups.forEach((g, gi) => { for (let k = g.start * gs; k < (g.start + g.count) * gs; k++) vertexFace[tris[k]] = gi; });
  // the edges: their points in one array, and as line segments
  let np = 0, ns = 0;
  for (const e of mesh.edges) { np += e.pts.length; ns += Math.max(0, e.pts.length / 3 - 1); }
  const ep = new Float32Array(np), eo = new Uint32Array(mesh.edges.length + 1), seg = new Float32Array(ns * 6);
  let o = 0, s = 0;
  mesh.edges.forEach((e, i) => {
    eo[i] = o; ep.set(e.pts, o);
    for (let k = 0; k + 5 < e.pts.length; k += 3) for (let j = 0; j < 6; j++) seg[s++] = e.pts[k + j];
    o += e.pts.length;
  });
  eo[mesh.edges.length] = o;
  const edgePos = new THREE.BufferAttribute(seg, 3);
  return { mesh, geo, gs, vertexFace, ep, eo, edgePos, box: geo.boundingBox.clone(), opacities: glass ? groups.map((g) => g.op) : null };
}

export class AssemblyView {
  constructor(vp) {
    this.vp = vp;
    this.group = new THREE.Group();
    this.hlGroup = new THREE.Group();
    vp.bodyGroup.add(this.group);
    vp.highlightGroup.add(this.hlGroup);
    this.gpu = new Map();     // part mesh → partGPU
    this.batches = new Map(); // part mesh → { faces: InstancedMesh, lines: LineSegments, comps: [component index], cap }
    this.items = [];          // per item (a part shown, through the sub-assemblies): { mesh, color, matrix, hidden } (as last given)
    this.mats = new Map();    // opacity → face material (colours come from the geometry)
    this.edgeMat = new THREE.ShaderMaterial({ vertexShader: EDGE_VERT, fragmentShader: EDGE_FRAG, uniforms: { color: { value: new THREE.Color(0x14181f) } }, clipping: true });
    this.style = vp.displayStyle;
    this.clipping = []; // (the section view's planes)
  }

  // ---- section view: the components cut by the viewport's planes; the caps on the cut drawn by the viewport
  setClipping(planes, many = false) {
    this.clipping = planes; this.clipMany = many;
    for (const m of [...this.mats.values(), this.edgeMat]) { m.clippingPlanes = planes; m.clipIntersection = many; m.needsUpdate = true; }
  }
  // each part shown, for the caps: its mesh, where it is used, its colour
  capSources() {
    return [...this.batches].filter(([, b]) => b.faces.count).map(([mesh, b]) => ({ geo: this.gpu.get(mesh).geo, instanceMatrix: b.faces.instanceMatrix, count: b.faces.count, color: this.gpu.get(mesh).color ?? 0x8ea6c8 }));
  }

  dispose() {
    this.clearHighlights();
    for (const b of this.batches.values()) this.dropBatch(b);
    for (const g of this.gpu.values()) { g.geo.disposeBoundsTree?.(); g.geo.dispose(); }
    for (const m of this.mats.values()) m.dispose();
    this.edgeMat.dispose();
    this.vp.bodyGroup.remove(this.group);
    this.vp.highlightGroup.remove(this.hlGroup);
    this.batches.clear(); this.gpu.clear(); this.mats.clear(); this.items = [];
  }

  // the face material for an opacity (1: opaque; transparent ones are drawn after, and hide nothing behind them)
  faceMat(op = 1) {
    let m = this.mats.get(op);
    if (!m) {
      const b = this.vp.bodyMat;
      m = new THREE.MeshPhongMaterial({ color: 0xffffff, vertexColors: true, specular: b.specular, shininess: b.shininess, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide,
        ...(op < 1 ? { transparent: true, opacity: op } : {}) });
      m.userData.op = op;
      if (this.clipping?.length) { m.clippingPlanes = this.clipping; m.clipIntersection = !!this.clipMany; }
      this.mats.set(op, m);
      this.styleMat(m);
    }
    return m;
  }
  facesMaterial(g) { return g.opacities ? g.opacities.map((op) => this.faceMat(op)) : this.faceMat(1); }

  dropBatch(b) {
    this.group.remove(b.faces, b.lines);
    b.faces.dispose();
    b.lines.geometry.dispose();
  }
  dropGPU(mesh) {
    const b = this.batches.get(mesh);
    if (b) { this.dropBatch(b); this.batches.delete(mesh); }
    const g = this.gpu.get(mesh);
    if (g) { g.geo.disposeBoundsTree?.(); g.geo.dispose(); this.gpu.delete(mesh); }
  }

  // items: one per part shown: { mesh, color (the part's, for bodies without their own), matrix: THREE.Matrix4, hidden }
  // (null: nothing). Picking returns item indices (as `comp`).
  update(items) {
    this.items = items;
    this.vp.contentChanged?.();
    const by = new Map();
    items.forEach((it, i) => {
      if (!it?.mesh || it.hidden) return;
      let l = by.get(it.mesh);
      if (!l) by.set(it.mesh, (l = { color: it.color, comps: [] }));
      l.comps.push(i);
    });
    // (a part whose colour changed is coloured again)
    for (const [mesh, l] of by) { const g = this.gpu.get(mesh); if (g && g.color !== l.color) { this.dropGPU(mesh); } }
    // parts no longer shown
    for (const [mesh, b] of this.batches) if (!by.has(mesh)) { this.dropBatch(b); this.batches.delete(mesh); }
    const used = new Set(items.map((it) => it?.mesh).filter(Boolean));
    for (const mesh of [...this.gpu.keys()]) if (!by.has(mesh) && !used.has(mesh)) this.dropGPU(mesh);
    for (const [mesh, l] of by) {
      let g = this.gpu.get(mesh);
      if (!g) { g = partGPU(mesh, l.color); g.color = l.color; this.gpu.set(mesh, g); }
      let b = this.batches.get(mesh);
      const n = l.comps.length;
      if (!b || b.cap < n) {
        if (b) this.dropBatch(b);
        const cap = Math.max(n, b ? b.cap * 2 : 1);
        const faces = new THREE.InstancedMesh(g.geo, this.facesMaterial(g), cap);
        faces.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        faces.frustumCulled = false;
        const lg = new THREE.InstancedBufferGeometry();
        lg.setAttribute('position', g.edgePos);
        const im = new THREE.InstancedBufferAttribute(new Float32Array(16 * cap), 16);
        im.setUsage(THREE.DynamicDrawUsage);
        lg.setAttribute('iMatrix', im);
        const lines = new THREE.LineSegments(lg, this.edgeMat);
        lines.frustumCulled = false;
        lines.visible = this.style !== 'shaded';
        b = { faces, lines, cap, comps: [] };
        this.batches.set(mesh, b);
        this.group.add(faces, lines);
      }
      b.comps = l.comps;
      const im = b.lines.geometry.getAttribute('iMatrix');
      l.comps.forEach((ci, k) => { const m = items[ci].matrix; b.faces.setMatrixAt(k, m); m.toArray(im.array, 16 * k); });
      b.faces.count = n;
      b.faces.instanceMatrix.needsUpdate = true;
      b.faces.boundingSphere = null; b.faces.boundingBox = null; // (picking tests them first)
      b.lines.geometry.instanceCount = n;
      im.needsUpdate = true;
    }
    // (the section's caps follow the components)
    if (this.vp.section) this.vp._updateSectionCaps();
  }

  // ---- display styles (the viewport's: shaded with edges, shaded, hidden lines removed, wireframe)
  styleMat(m) {
    const s = this.style;
    m.vertexColors = s !== 'hlr';
    m.emissive.set(s === 'hlr' ? 0xffffff : 0x000000);
    m.colorWrite = s !== 'wireframe';
    m.depthWrite = s !== 'wireframe' && m.userData.op >= 1;
    m.needsUpdate = true;
  }
  applyDisplayStyle(s) {
    this.style = s;
    for (const m of this.mats.values()) this.styleMat(m);
    for (const b of this.batches.values()) b.lines.visible = s !== 'shaded';
    this.edgeMat.depthTest = s !== 'wireframe';
    this.edgeMat.uniforms.color.value.set(s === 'wireframe' ? wireColor() : 0x14181f);
    this.edgeMat.needsUpdate = true;
  }

  // ---- size
  // the world box of what is shown (THREE.Box3; empty when nothing is)
  box() {
    const out = new THREE.Box3(), b = new THREE.Box3();
    this.items.forEach((it) => {
      if (!it?.mesh || it.hidden) return;
      const g = this.gpu.get(it.mesh);
      if (g) out.union(b.copy(g.box).applyMatrix4(it.matrix));
    });
    return out;
  }

  // ---- picking
  // the component face under the cursor: { comp (index), face (the part's face number), point } or null
  pick(ev) {
    const vp = this.vp, objs = [...this.batches.values()].map((b) => b.faces);
    if (!objs.length) return null;
    vp.aimRay(ev);
    // (what a section view cuts away is not there)
    const hits = vp.raycaster.intersectObjects(objs, false).filter((h) => !vp.section || vp._sectionKeeps(h.point));
    for (const h of hits) {
      const entry = [...this.batches].find(([, b]) => b.faces === h.object);
      if (!entry) continue;
      const [mesh, b] = entry, g = this.gpu.get(mesh);
      return { comp: b.comps[h.instanceId], face: g.vertexFace[h.face.a], point: h.point };
    }
    return null;
  }

  // screen projection through a component's placement: a function (x, y, z) → [sx, sy, ndc z]
  projector(matrix) {
    const vp = this.vp;
    vp.camera.updateMatrixWorld();
    const cam = vp.viewCam;
    const e = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(matrix).elements;
    const W = vp.width, H = vp.height;
    return (x, y, z) => {
      const w = e[3] * x + e[7] * y + e[11] * z + e[15] || 1;
      return [((e[0] * x + e[4] * y + e[8] * z + e[12]) / w + 1) / 2 * W, (1 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w) / 2 * H, (e[2] * x + e[6] * y + e[10] * z + e[14]) / w];
    };
  }

  // components whose box on screen is within tol px of the cursor (the one under it first)
  near(ev, tol, under) {
    const m = this.vp.screenPos(ev), out = under != null ? [under] : [];
    this.items.forEach((it, i) => {
      if (i === under || !it?.mesh || it.hidden) return;
      const g = this.gpu.get(it.mesh);
      if (!g) return;
      const P = this.projector(it.matrix), bx = g.box;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < 8; k++) {
        const [sx, sy] = P(k & 1 ? bx.max.x : bx.min.x, k & 2 ? bx.max.y : bx.min.y, k & 4 ? bx.max.z : bx.min.z);
        x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
      }
      if (m.x >= x0 - tol && m.x <= x1 + tol && m.y >= y0 - tol && m.y <= y1 + tol) out.push(i);
    });
    return out;
  }

  // the ndc depth a point may have and still be in front of what the cursor hits
  depthLimit(hit) {
    if (!hit) return Infinity;
    const cam = this.vp.viewCam, p = hit.point.clone().project(cam);
    const r = this.box().getBoundingSphere(new THREE.Sphere()).radius || 50;
    return p.z + ((r * 0.02 + 0.5) * 2) / (cam.far - cam.near);
  }

  // the closest visible edge: { comp, edge (the part's edge number), point } or null
  pickEdge(ev, tolPx = 6) {
    const hit = this.pick(ev), m = this.vp.screenPos(ev), zmax = this.depthLimit(hit);
    let best = null, bd = tolPx;
    for (const ci of this.near(ev, tolPx, hit?.comp)) {
      const it = this.items[ci], g = this.gpu.get(it.mesh), P = this.projector(it.matrix), { ep, eo } = g;
      for (let ei = 0; ei + 1 < eo.length; ei++) {
        let prev = null;
        for (let k = eo[ei]; k < eo[ei + 1]; k += 3) {
          const s = P(ep[k], ep[k + 1], ep[k + 2]);
          if (prev) {
            const dx = s[0] - prev[0], dy = s[1] - prev[1], L2 = dx * dx + dy * dy;
            const t = L2 ? Math.max(0, Math.min(1, ((m.x - prev[0]) * dx + (m.y - prev[1]) * dy) / L2)) : 0;
            const d = Math.hypot(m.x - (prev[0] + t * dx), m.y - (prev[1] + t * dy));
            if (d < bd && prev[2] + t * (s[2] - prev[2]) <= zmax) {
              bd = d;
              const a = new THREE.Vector3(ep[k - 3], ep[k - 2], ep[k - 1]), b = new THREE.Vector3(ep[k], ep[k + 1], ep[k + 2]);
              best = { comp: ci, edge: ei, point: a.lerp(b, t).applyMatrix4(it.matrix) };
            }
          }
          prev = s;
        }
      }
    }
    return best;
  }

  // the closest visible B-rep vertex (edge end): { comp, point } or null
  pickVertex(ev, tolPx = 8) {
    const hit = this.pick(ev), m = this.vp.screenPos(ev), zmax = this.depthLimit(hit);
    let best = null, bd = tolPx;
    for (const ci of this.near(ev, tolPx, hit?.comp)) {
      const it = this.items[ci], g = this.gpu.get(it.mesh), P = this.projector(it.matrix), { ep, eo } = g;
      for (let ei = 0; ei + 1 < eo.length; ei++) {
        const a = eo[ei], z = eo[ei + 1] - 3;
        if (z <= a) continue;
        // (a closed edge's seam is not a corner)
        if (Math.hypot(ep[a] - ep[z], ep[a + 1] - ep[z + 1], ep[a + 2] - ep[z + 2]) < 1e-6) continue;
        for (const k of [a, z]) {
          const s = P(ep[k], ep[k + 1], ep[k + 2]);
          const d = Math.hypot(s[0] - m.x, s[1] - m.y);
          if (d < bd && s[2] <= zmax) { bd = d; best = { comp: ci, point: new THREE.Vector3(ep[k], ep[k + 1], ep[k + 2]).applyMatrix4(it.matrix) }; }
        }
      }
    }
    return best;
  }

  // ---- faces and highlights
  // a face of a component in world space (for highlights and face normals), like Viewport.faceInfo
  faceInfo(ci, gi) {
    const it = this.items[ci], g = it?.mesh && this.gpu.get(it.mesh), fg = g?.mesh.faceGroups[gi];
    if (!fg) return null;
    const { vertices: V, normals: N, triangles: T } = g.mesh;
    const nm = new THREE.Matrix3().getNormalMatrix(it.matrix);
    const pos = [], v = new THREE.Vector3(), n = new THREE.Vector3(), vn = new THREE.Vector3();
    let planar = true, first = null;
    for (let k = fg.start * g.gs; k < (fg.start + fg.count) * g.gs; k++) {
      const vi = T[k] * 3;
      v.set(V[vi], V[vi + 1], V[vi + 2]).applyMatrix4(it.matrix);
      pos.push(v.x, v.y, v.z);
      vn.set(N[vi], N[vi + 1], N[vi + 2]).applyMatrix3(nm).normalize();
      if (!first) first = vn.clone(); else if (vn.dot(first) < 0.99999) planar = false;
      n.add(vn);
    }
    n.normalize();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geometry.computeBoundingBox();
    const d = n.dot(new THREE.Vector3(pos[0], pos[1], pos[2]));
    const center = geometry.boundingBox.getCenter(new THREE.Vector3());
    center.addScaledVector(n, d - n.dot(center));
    return { index: gi, geometry, normal: n, d, center, planar };
  }

  clearHighlights() {
    for (const o of [...this.hlGroup.children]) { this.hlGroup.remove(o); if (o.isLineSegments) o.geometry.dispose(); o.material.dispose(); }
  }

  // whole parts shown (sharing their geometry: nothing copied) and edges: { selected, hover } item indices (one
  // each, or lists: all the parts of a sub-assembly), edges: [[item index, edge number]]
  setHighlights({ selected = [], hover = [], edges = [], hoverEdges = [], clash = [] } = {}) {
    const list = (x) => (Array.isArray(x) ? x : x >= 0 ? [x] : []);
    selected = list(selected); hover = list(hover).filter((i) => !selected.includes(i));
    this.clearHighlights();
    const comp = (ci, color, opacity, order) => {
      const it = this.items[ci], g = it?.mesh && !it.hidden && this.gpu.get(it.mesh);
      if (!g) return;
      const m = new THREE.Mesh(g.geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.matrixAutoUpdate = false;
      m.matrix.copy(it.matrix);
      m.raycast = () => {};
      m.renderOrder = order;
      this.hlGroup.add(m);
    };
    for (const i of selected) comp(i, 0x2b7de9, 0.45, 3);
    for (const i of hover) comp(i, 0xf59e0b, 0.35, 3);
    // (parts that collide, in red)
    for (const i of clash) if (!selected.includes(i)) comp(i, 0xe53935, 0.5, 4);
    // (edges selected in blue, the one under the cursor in orange)
    for (const [list, color] of [[edges, 0x0ea5e9], [hoverEdges, 0xf59e0b]]) {
      const pts = [];
      for (const [ci, ei] of list) {
        const it = this.items[ci], g = it?.mesh && this.gpu.get(it.mesh);
        if (!g || ei >= g.eo.length - 1) continue;
        const { ep, eo } = g;
        for (let k = eo[ei]; k + 5 < eo[ei + 1]; k += 3) {
          pts.push(new THREE.Vector3(ep[k], ep[k + 1], ep[k + 2]).applyMatrix4(it.matrix), new THREE.Vector3(ep[k + 3], ep[k + 4], ep[k + 5]).applyMatrix4(it.matrix));
        }
      }
      if (!pts.length) continue;
      const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, depthTest: false }));
      l.renderOrder = 8;
      this.hlGroup.add(l);
    }
  }

  // triangles drawn per frame, and parts / instances (for measuring)
  stats() {
    let tris = 0, inst = 0;
    for (const [mesh, b] of this.batches) { tris += (mesh.triangles.length / 3) * b.faces.count; inst += b.faces.count; }
    return { parts: this.batches.size, instances: inst, triangles: tris };
  }
}
