// 3D Sketch: points, lines, arcs, circles and polygons drawn anywhere in space (no sketch plane), held by 3D
// relations and dimensions, the way 3D sketches work in feature-based CAD:
//  * lines follow the mouse on the active drawing plane through the last point (XY, YZ or ZX; Tab cycles them,
//    shown at the cursor and by the space handle), and snap along X, Y or Z from the last point (any of the three,
//    in the plane or out of it) with an automatic Along X / Y / Z relation (hold Ctrl or Shift: no snapping);
//  * circles, arcs and polygons are drawn on the active drawing plane through their first click;
//  * Sketch Fillet rounds the corner where two lines meet with a tangent arc (the sharp corner is kept as a point);
//  * Ctrl+click a plane or a flat face (or click a plane in the tree) to draw on it: its points get On Plane;
//  * points snap to the sketch's own points (coincident), the midpoints of lines and arcs, onto lines, model
//    vertices and the origin (fixed there);
//  * Dimension: lengths, distances, angles, arc radii and circle diameters; Tab while placing a length or
//    distance measures it along X, Y or Z instead;
//  * a selected point shows its X / Y / Z (type new values); a selected line its length and ΔX / ΔY / ΔZ;
//  * construction geometry (Centerline tool, Construction Geometry) shapes the sketch but makes no curve.
//
// Feature data:  pts  [{ id, x, y, z }]                                      points (mm)
//                segs [{ id, a, b, construction? }]                           lines between two points
//                     [{ id, type: 'arc', a, b, c, n }]                       arc from a to b about centre point c,
//                                                                             counterclockwise round the normal n
//                     [{ id, type: 'circle', c, r, n }]                       circle: centre point, radius, normal
//                rels [{ id, type, refs, value, axis, sgn }]                  relations and dimensions (see REL3D)
//                kind 'lines' | 'spline', radius                              how the kernel joins chains of lines
// Older 3D sketches (a list of points joined in order) are converted when opened (normalize3d).

import * as THREE from 'three';
import { evaluate, fmt } from './expr.js';
import {
  AXES, COORD, PLANES, REL3D, TAU, V, addv, applicableRelations,
  arcGeom, circleGeom, closestSegSeg, cross, dot, equations, freedom3d, gauss,
  getPt, getSeg, isLine, kindOf, len, lineRound, mulv, newId,
  normalize3d, perp, r6, rot, segPts, solve3d, sub, unit,
  unknowns,
} from './sketch3dmodel.js';
import { splineGeom, splineBeziers, bezierCurvature, segEnds as segEndIds } from './sketch3dmodel.js';
import { sketchDefined, sketchUnder } from './theme.js';
import * as W from './wcs.js';
export { REL3D, normalize3d, solve3d, freedom3d, applicableRelations, getPt, getSeg, arcGeom, circleGeom } from './sketch3dmodel.js';

// the Sketch tab's tools a 3D sketch has (the rest are 2D only), and their keys
export const S3_TOOLS = ['select', 'line', 'centerline', 'point', 'dim', 'circle', 'arc', 'arc3', 'tarc', 'spline', 'polygon', 'sfillet', 'schamfer', 'trim', 'convert'];
export const S3_KEYS = { select: 'S', line: 'L', circle: 'C', arc: 'A', spline: 'N', polygon: 'P', dim: 'D', trim: 'T', convert: 'E' };
const TOOL_NAMES = { select: 'Select', line: 'Line', centerline: 'Centerline', point: 'Point', dim: 'Dimension', circle: 'Circle', arc: 'Centerpoint Arc', arc3: '3 Point Arc', tarc: 'Tangent Arc', spline: 'Spline', polygon: 'Polygon', sfillet: 'Sketch Fillet', schamfer: 'Sketch Chamfer', trim: 'Trim', convert: 'Project Edges' };
const DRAW_TOOLS = new Set(['line', 'centerline', 'point', 'circle', 'arc', 'arc3', 'tarc', 'spline', 'polygon']);
const LINKED = 0x7c3aed; // converted (linked) geometry

const AXIS_COLOR = { X: 0xdc2626, Y: 0x16a34a, Z: 0x2563eb };
const AXIS_CSS = { X: '#dc2626', Y: '#16a34a', Z: '#2563eb' };

// ------------------------------------------------------------------ the editor
export class Sketcher3D {
  constructor(app) {
    this.app = app;
    this.vp = app.viewport;
    this.active = false;
    this.filletR = 10;     // Sketch Fillet radius
    this.chamferD = 5;     // Sketch Chamfer distance
    this.polySides = 6;    // Polygon sides
    this.blendFirst = null; // the first fillet / chamfer of this use of the tool: the later ones are made equal to it
    this.onFrame = () => this.placeLabels();
  }

  get ev() {
    const vars = this.app.result?.vars || {};
    return (x) => (typeof x === 'number' ? x : evaluate(x, vars));
  }

  enter(f, isNew) {
    normalize3d(f, this.ev);
    // converted (linked) geometry: where the kernel found the model's edges at the last rebuild
    const fresh = this.app.result?.detected?.get?.(f.id)?.s3;
    if (fresh && !isNew) {
      for (const q of fresh.pts) { const p = getPt(f, q.id); if (p) { p.x = q.x; p.y = q.y; p.z = q.z; } }
      for (const [id, r] of Object.entries(fresh.radii || {})) { const sg = getSeg(f, id); if (sg) sg.r = r; }
      for (const [id, n] of Object.entries(fresh.normals || {})) { const sg = getSeg(f, id); if (sg) sg.n = n; }
      for (const [id, v] of Object.entries(fresh.values || {})) { const r = f.rels.find((x) => x.id === id); if (r) r.value = v; }
      for (const [id, l] of Object.entries(fresh.links || {})) { const sg = getSeg(f, id); if (sg?.link) sg.link = l; }
    }
    this.f = f;
    this.isNew = isNew;
    this.snapshot = JSON.stringify(this.data());
    this.hist = [this.snapshot];
    this.redoStack = [];
    this.active = true;
    this.tool = isNew ? 'line' : 'select';
    this.sel = new Set();
    this.hover = null;
    this.chain = null;     // the line being drawn: { last: point id, start: point id }
    this.draw = null;      // a circle / arc / polygon being drawn: { tool, picks: [snap…], n, sweep… }
    this.cand = null;      // where the next click puts a point
    this.dimPicks = [];
    this.dimPending = null; // { type, refs, axis } waiting for the click that places it
    this.drag = null;
    this.custom = null;    // a plane or face chosen to draw on (Ctrl+click), instead of XY / YZ / ZX
    this.plane = this.facingPlane();
    this.group = new THREE.Group();
    this.vp.overlayGroup.add(this.group);
    this.labels = [];
    this.tipEl = document.createElement('div');
    this.tipEl.className = 'cursor-tip';
    this.tipEl.style.whiteSpace = 'pre';
    this.tipEl.hidden = true;
    this.vp.labelsEl.append(this.tipEl);
    this.vp.setLeftRotate(false);
    this.vp.frameCallbacks.add(this.onFrame);
    this.solve();
    this.redraw();
  }

  exit() {
    if (!this.active) return;
    this.closeInput();
    this.vp.frameCallbacks.delete(this.onFrame);
    this.vp.overlayGroup.remove(this.group);
    this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    for (const l of this.labels) l.el.remove();
    this.labels = [];
    this.tipEl.remove();
    this.vp.setLeftRotate(true);
    this.vp.canvas.style.cursor = 'default';
    this.active = false;
    this.f = null;
  }

  data() { const f = this.f; return { pts: f.pts, segs: f.segs, rels: f.rels, nextId: f.nextId, kind: f.kind, radius: f.radius }; }
  restoreSnapshot() { Object.assign(this.f, JSON.parse(this.snapshot)); }

  // after each change: kept for undo
  changed() {
    const s = JSON.stringify(this.data());
    if (s !== this.hist[this.hist.length - 1]) { this.hist.push(s); this.redoStack = []; if (this.hist.length > 200) this.hist.shift(); }
    this.solve();
    this.redraw();
    this.app.ui.renderPM();
    this.app.ui.refreshCommandStates();
  }
  undo() {
    if (this.hist.length < 2) return;
    this.redoStack.push(this.hist.pop());
    Object.assign(this.f, JSON.parse(this.hist[this.hist.length - 1]));
    this.chain = null; this.draw = null; this.sel.clear();
    this.solve(); this.redraw(); this.app.ui.renderPM();
  }
  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.hist.push(s);
    Object.assign(this.f, JSON.parse(s));
    this.solve(); this.redraw(); this.app.ui.renderPM();
  }

  solve(opts) {
    const r = solve3d(this.f, this.ev, opts);
    this.solveOk = r.ok;
    try { this.dof = freedom3d(this.f, this.ev); } catch { this.dof = null; }
    return r;
  }

  // ---------------------------------------------------------------- drawing plane
  facingPlane() {
    const d = new THREE.Vector3();
    this.vp.camera.getWorldDirection(d);
    let best = 'XY', bv = -1;
    for (const [k, p] of Object.entries(PLANES)) { const v = Math.abs(d.x * p.n[0] + d.y * p.n[1] + d.z * p.n[2]); if (v > bv) { bv = v; best = k; } }
    return best;
  }
  curPlane() { return this.custom || PLANES[this.plane]; }
  planeLabel() { return this.custom ? this.custom.name : this.plane; }
  setPlane(k) {
    this.plane = k;
    this.custom = null;
    if (this.draw) this.draw.n = PLANES[k].n.slice();
    this.app.status(`Drawing plane: ${PLANES[k].name}. Tab switches XY → YZ → ZX; lines snap along X, Y and Z from the last point in any view.`);
    this.app.ui.renderPM();
    this.redraw();
  }
  nextPlane() {
    const ks = Object.keys(PLANES);
    this.setPlane(this.custom ? this.plane : ks[(ks.indexOf(this.plane) + 1) % ks.length]);
  }
  // a plane or flat face to draw on: frame { o, n, u, v } (THREE vectors)
  useFrame(fr, name) {
    const n = fr.n.toArray(), o = fr.o.toArray();
    this.custom = { n, o, u: fr.u.toArray(), v: fr.v.toArray(), d: dot(n, o), color: 0x7c3aed, name };
    if (this.draw) this.draw.n = n.slice();
    this.app.status(`Drawing on ${name}: points placed on it get an On Plane relation. Tab goes back to XY / YZ / ZX.`);
    this.app.ui.renderPM();
    this.redraw();
  }
  // Ctrl+click: the plane or flat face under the mouse becomes the drawing plane
  pickPlaneAt(e) {
    const a = this.app, p = a.pickAt(e);
    if (!p) return false;
    if (p.kind === 'plane') {
      const G = a.planeFrameFor?.(p.id);
      if (G) { this.useFrame(G.frame, G.name); return true; }
    }
    if (p.kind === 'face') {
      const face = this.vp.faceInfo(p.hit.face);
      if (!face.planar) { a.toast('Ctrl+click a flat face or a plane to draw on it'); return true; }
      this.useFrame(a.faceFrame(face), 'the selected face');
      return true;
    }
    return false;
  }

  // the point the drawing plane runs through
  anchor() {
    if (this.drag) return this.drag.from;
    if (this.tarc) { const p = getPt(this.f, this.tarc.pid); if (p) return V(p); }
    if (this.draw?.picks.length) return this.draw.picks[0].p;
    const p = this.chain && getPt(this.f, this.chain.last);
    return p ? V(p) : [0, 0, 0];
  }

  rayOnPlane(ev, through, n = null) {
    const pl = this.curPlane();
    const N = new THREE.Vector3(...(n || pl.n)), o = new THREE.Vector3(...(this.custom && !n ? this.custom.o : through));
    return this.vp.rayPlane(ev, { n: N, o }).toArray();
  }

  // ---------------------------------------------------------------- picking
  screen(p) { return this.vp.project(new THREE.Vector3(p[0], p[1], p[2])); }

  // points along an entity (lines: the two ends)
  entPts(s, m = 48) {
    if (s.type === 'arc') { const g = arcGeom(this.f, s), k = Math.max(4, Math.ceil(m * g.th / TAU)); return Array.from({ length: k + 1 }, (_, i) => g.at(i / k)); }
    if (s.type === 'circle') { const g = circleGeom(this.f, s); return Array.from({ length: m + 1 }, (_, i) => g.at(i / m)); }
    if (s.type === 'spline') return splineGeom(this.f, s).sample(Math.max(6, Math.ceil(m / Math.max(1, s.pts.length - 1))));
    const e = this.segEnds(s);
    return e || [];
  }
  // an entity's middle (labels, midpoint snapping)
  entMid(s) {
    if (s.type === 'arc') return arcGeom(this.f, s).at(0.5);
    if (s.type === 'circle') return circleGeom(this.f, s).at(0.125);
    if (s.type === 'spline') { const q = splineGeom(this.f, s).sample(8); return q[q.length >> 1]; }
    const e = this.segEnds(s);
    return e ? e[0].map((x, i) => (x + e[1][i]) / 2) : null;
  }

  pick(ev, { points = true, segs = true } = {}) {
    const m = this.vp.screenPos(ev);
    let best = null, bd = 9;
    if (points) for (const p of this.f.pts) {
      const s = this.screen(V(p)), d = Math.hypot(s.x - m.x, s.y - m.y);
      if (d < bd) { bd = d; best = { id: p.id, kind: 'pt' }; }
    }
    if (best) return best;
    bd = 6;
    if (segs) for (const sg of this.f.segs) {
      const pts = this.entPts(sg).map((p) => this.screen(p));
      for (let i = 0; i + 1 < pts.length; i++) {
        const A = pts[i], B = pts[i + 1];
        const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((m.x - A.x) * dx + (m.y - A.y) * dy) / L2));
        const d = Math.hypot(A.x + t * dx - m.x, A.y + t * dy - m.y);
        if (d < bd) { bd = d; best = { id: sg.id, kind: kindOf(this.f, sg.id) }; }
      }
    }
    return best;
  }

  // Along X, Y or Z from point `from`: when the mouse is near that direction on screen (whichever plane is
  // active), the point on it nearest the mouse ray. null when no direction is close.
  axisSnap(ev, from) {
    const m = this.vp.screenPos(ev);
    const S0 = this.screen(from), w = this.vp.worldPerPixel();
    let best = null, bd = 10;
    for (const [k, a] of Object.entries(AXES)) {
      const S1 = this.screen(from.map((x, i) => x + a[i] * w * 100));
      const dx = S1.x - S0.x, dy = S1.y - S0.y, L = Math.hypot(dx, dy);
      if (L < 22) continue; // (pointing almost at the viewer: can't be followed on screen)
      const ux = dx / L, uy = dy / L;
      const along = (m.x - S0.x) * ux + (m.y - S0.y) * uy;
      if (Math.abs(along) < 10) continue; // (too close to the last point to tell)
      const d = Math.abs((m.x - S0.x) * uy - (m.y - S0.y) * ux);
      if (d < bd) { bd = d; best = { k, a }; }
    }
    if (!best) return null;
    this.vp.aimRay(ev);
    const ray = this.vp.raycaster.ray, ro = ray.origin.toArray(), rd = ray.direction.toArray();
    const a = best.a, w0 = sub(from, ro), b = dot(a, rd), denom = 1 - b * b;
    if (denom < 1e-9) return null;
    let t = (b * dot(rd, w0) - dot(a, w0)) / denom;
    const step = this.roundStep();
    t = Math.round(t / step) * step;
    if (Math.abs(t) < 1e-9) return null;
    return { k: best.k, p: from.map((x, i) => r6(x + a[i] * t)) };
  }

  // The sketch's lines and arcs near the mouse: their midpoint (≤ 9 px), or else the point along a line nearest
  // the mouse ray (≤ 7 px). Lines ending at the last point of the line being drawn are left out of "along" (it
  // would fold back on itself).
  lineSnap(ev) {
    const m = this.vp.screenPos(ev);
    let best = null, bd = 9;
    for (const sg of this.f.segs) {
      if (sg.type === 'circle' || sg.type === 'spline') continue;
      const mid = this.entMid(sg);
      if (!mid) continue;
      const s = this.screen(mid), d = Math.hypot(s.x - m.x, s.y - m.y);
      if (d < bd) { bd = d; best = { p: mid.map(r6), seg: sg.id, mid: true, why: 'midpoint' }; }
    }
    if (best) return best;
    this.vp.aimRay(ev);
    const ray = this.vp.raycaster.ray, ro = ray.origin.toArray(), rd = ray.direction.toArray();
    bd = 7;
    for (const sg of this.f.segs) {
      if (!isLine(sg)) continue;
      if (this.chain && (sg.a === this.chain.last || sg.b === this.chain.last)) continue;
      const e = this.segEnds(sg);
      if (!e) continue;
      const L = len(sub(e[1], e[0]));
      if (L < 1e-9) continue;
      const u = sub(e[1], e[0]).map((x) => x / L), w0 = sub(e[0], ro), b = dot(u, rd), den = 1 - b * b;
      if (den < 1e-9) continue;
      const t = Math.max(0, Math.min(L, (b * dot(rd, w0) - dot(u, w0)) / den));
      if (t < 1e-6 || t > L - 1e-6) continue; // (the ends are points: snapped to as such)
      const q = e[0].map((x, i) => x + u[i] * t), sq = this.screen(q), d = Math.hypot(sq.x - m.x, sq.y - m.y);
      if (d < bd) { bd = d; best = { p: q.map(r6), seg: sg.id, why: 'online' }; }
    }
    return best;
  }

  // Where a click would put a point: an existing point, a midpoint or a point along a line, the origin, a model
  // vertex, along X / Y / Z from the last point, or on the drawing plane. (Circles, arcs and polygons: after
  // their first click, on their plane.)
  snap(ev) {
    const hit = this.pick(ev, { segs: false });
    if (hit) { const p = getPt(this.f, hit.id); return { p: V(p), pid: hit.id, why: 'point' }; }
    const ls = this.lineSnap(ev);
    if (ls) return ls;
    const m = this.vp.screenPos(ev);
    const o = this.screen([0, 0, 0]);
    if (Math.hypot(o.x - m.x, o.y - m.y) < 9) return { p: [0, 0, 0], fix: true, why: 'origin' };
    const vx = this.vp.pickVertex(ev, 8);
    if (vx) return { p: vx.point.toArray().map(r6), fix: true, why: 'vertex' };
    const from = this.anchor();
    if (this.draw?.picks.length) return { p: this.rayOnPlane(ev, from, this.draw.n).map(r6), why: 'plane' };
    const free = ev.ctrlKey || ev.shiftKey; // (no inference)
    if (this.chain && !free && !this.custom) {
      const ax = this.axisSnap(ev, from);
      if (ax) return { p: ax.p, axis: ax.k, why: 'axis' };
    }
    let p = this.rayOnPlane(ev, from);
    if (this.custom) return { p: p.map(r6), onPlane: true, why: 'plane' };
    // (round to a tidy step for the view's zoom, staying on the plane)
    const step = this.roundStep(), pl = PLANES[this.plane];
    p = p.map((x, i) => (pl.n[i] ? from[i] : Math.round(x / step) * step));
    return { p: p.map(r6), why: 'plane' };
  }
  roundStep() {
    const w = this.vp.worldPerPixel() * 8;
    const e = 10 ** Math.floor(Math.log10(w));
    return w / e < 2 ? e : w / e < 5 ? 2 * e : 5 * e;
  }

  addPoint(c) {
    if (c.pid) return c.pid;
    const id = newId(this.f, 'p');
    this.f.pts.push({ id, x: c.p[0], y: c.p[1], z: c.p[2] });
    if (c.fix) this.f.rels.push({ id: newId(this.f, 'r'), type: 'fix', refs: [id], value: c.p.slice() });
    if (c.seg && getSeg(this.f, c.seg)) this.f.rels.push({ id: newId(this.f, 'r'), type: c.mid ? 'midpoint' : 'onLine', refs: [id, c.seg] });
    if (c.onPlane && this.custom) this.f.rels.push({ id: newId(this.f, 'r'), type: 'onPlane', refs: [id], value: { n: this.custom.n.slice(), d: this.custom.d, name: this.custom.name } });
    return id;
  }
  // a new point at p (no snapping)
  newPoint(p) {
    const id = newId(this.f, 'p');
    this.f.pts.push({ id, x: r6(p[0]), y: r6(p[1]), z: r6(p[2]) });
    return id;
  }

  addLine(c) {
    const id = this.addPoint(c);
    if (id === this.chain.last) return null;
    const sid = newId(this.f, 's');
    this.f.segs.push({ id: sid, a: this.chain.last, b: id, ...(this.tool === 'centerline' ? { construction: true } : {}) });
    if (c.axis) this.f.rels.push({ id: newId(this.f, 'r'), type: 'along' + c.axis, refs: [sid] });
    return id;
  }

  // ---------------------------------------------------------------- input
  setTool(t) {
    if (this.spl) this.finishSpline(false);
    this.tarc = null;
    this.tool = t;
    this.blendFirst = null;
    this.chain = null;
    this.draw = null;
    this.dimPicks = [];
    this.dimPending = null;
    this.cand = null;
    this.closeInput();
    const hints = {
      select: 'Select points, lines, arcs and circles (Ctrl+click for more) to add relations or type coordinates; drag a point to move it.',
      line: 'Click points to draw lines in space. Points snap to other points, to the midpoints of lines and onto lines (Midpoint / On Line), and along X, Y or Z from the last point (Along relation). Tab switches the drawing plane XY / YZ / ZX; Ctrl+click a plane or flat face to draw on it. Double-click or Esc ends the line.',
      centerline: 'Centerline: construction lines that shape the sketch (e.g. an envelope to attach to) but make no curve.',
      point: 'Click to place a point (on the drawing plane, a sketch point, a line or its midpoint, a model vertex or the origin).',
      dim: 'Dimension: click a line (length), two points (distance), two lines (angle), an arc (radius) or a circle (diameter), then click where to place it. Tab measures a length along X, Y or Z instead.',
      circle: 'Circle: click the centre, then a point on the circle. It lies on the drawing plane (Tab switches it first).',
      arc: 'Centerpoint Arc: click the centre, then the start, then the end (the arc follows the mouse round). It lies on the drawing plane.',
      arc3: '3 Point Arc: click the start, then the end, then a point the arc runs through (on the drawing plane through the start).',
      polygon: `Polygon: click the centre, then a corner (${this.polySides} sides — set them in the Property panel). It lies on the drawing plane and stays regular.`,
      sfillet: `Sketch Fillet: click corners where two lines meet. Radius ${this.filletR} mm (set it in the Property panel); further fillets are made equal to the first until you leave the tool.`,
      schamfer: `Sketch Chamfer: click corners where two lines meet. Distance ${this.chamferD} mm (set it in the Property panel); further chamfers are made equal to the first until you leave the tool.`,
      trim: 'Trim: click the piece of a line, arc or circle to remove, up to where other entities cross or touch it (nothing crosses it: the whole entity goes).',
      spline: 'Spline: click points it runs through (they snap like line points). Double-click or Enter ends it; click the first point to close it. A Tangent relation with a line at an end makes it leave the line smoothly.',
      tarc: 'Tangent Arc: click the free end of a line, arc or spline, then where the arc ends. It carries on tangent from there; keep clicking for more arcs, Esc ends.',
      convert: 'Project Edges: click model edges to bring them into the 3D sketch. They stay linked: when the model changes they follow (and what is attached to them).',
    };
    this.app.status(hints[t]);
    this.app.ui.renderPM();
    this.app.ui.refreshCommandStates();
    this.redraw();
  }

  // Construction Geometry (Sketch tab, Q): the selected lines become centerlines, or lines again
  toggleConstruction() {
    const segs = [...this.sel].map((id) => getSeg(this.f, id)).filter(Boolean);
    if (segs.length) this.setConstruction(!segs.every((s) => s.construction));
  }

  pointerDown(e) {
    if (e.button !== 0) return;
    const t = this.tool;
    if (t === 'line' || t === 'centerline' || t === 'point') {
      if (e.ctrlKey && !this.pick(e) && this.pickPlaneAt(e)) return;
      const c = this.snap(e);
      if (t === 'point') { if (!c.pid) { this.addPoint(c); this.changed(); } return; }
      if (!this.chain) {
        const id = this.addPoint(c);
        this.chain = { start: id, last: id, count: 0 };
        this.changed();
        return;
      }
      const id = this.addLine(c);
      if (!id) return;
      const closed = id === this.chain.start;
      this.chain.last = id;
      this.chain.count++;
      if (closed) this.chain = null;
      this.changed();
      return;
    }
    if (t === 'circle' || t === 'arc' || t === 'arc3' || t === 'polygon') {
      if (e.ctrlKey && !this.pick(e) && !this.draw && this.pickPlaneAt(e)) return;
      return this.shapeClick(e);
    }
    if (t === 'spline') {
      if (e.ctrlKey && !this.pick(e) && !this.spl && this.pickPlaneAt(e)) return;
      const c = this.snap(e);
      if (!this.spl) {
        const id = this.addPoint(c);
        this.spl = { ids: [id] };
        this.chain = { start: id, last: id, count: 0 };
        this.redraw();
        return;
      }
      const id = this.addPoint(c);
      if (id === this.spl.ids[this.spl.ids.length - 1]) return;
      if (id === this.spl.ids[0] && this.spl.ids.length >= 3) return this.finishSpline(true);
      this.spl.ids.push(id);
      this.chain.last = id;
      this.redraw();
      return;
    }
    if (t === 'tarc') {
      if (!this.tarc) {
        const h = this.pick(e, { segs: false });
        const st = h && this.tangentAtEnd(h.id);
        if (!st) { this.app.toast('Start a tangent arc at the free end of a line, arc or spline', true); return; }
        this.tarc = st;
        this.app.status('Click where the arc ends (it lies in the plane of the tangent and the mouse on the drawing plane).');
        this.redraw();
        return;
      }
      return this.finishTangentArc(e);
    }
    if (t === 'convert') {
      const hit = this.vp.pickEdge(e, 6);
      if (!hit) { this.app.toast('Click an edge of the model to convert it into the 3D sketch'); return; }
      return this.convertEdge(this.vp.edgeList?.[hit.index] || hit.edge);
    }
    if (t === 'sfillet' || t === 'schamfer') {
      const h = this.pick(e, { segs: false });
      if (!h) { this.app.toast('Click a corner point where two lines meet'); return; }
      return t === 'sfillet' ? this.filletCorner(h.id, this.filletR) : this.chamferCorner(h.id, this.chamferD);
    }
    if (t === 'trim') {
      const h = this.pick(e, { points: false });
      if (h) this.trimAt(h.id, e);
      return;
    }
    if (t === 'dim') return this.dimClick(e);
    // select
    const h = this.pick(e);
    const multi = e.ctrlKey || e.shiftKey;
    if (!h) { if (!multi) this.sel.clear(); this.redraw(); this.app.ui.renderPM(); this.app.ui.refreshCommandStates(); return; }
    if (multi) { this.sel.has(h.id) ? this.sel.delete(h.id) : this.sel.add(h.id); }
    else if (!this.sel.has(h.id)) { this.sel.clear(); this.sel.add(h.id); }
    if (h.kind === 'pt' && !multi) {
      const p = getPt(this.f, h.id);
      this.drag = { id: h.id, from: V(p), moved: false };
    } else if (!multi) {
      // dragging a line, arc or circle moves everything selected
      const ids = this.selPoints(), seg = getSeg(this.f, h.id), from = seg && this.entMid(seg);
      if (from && ids.length) this.drag = { kind: 'move', from, ids, orig: new Map(ids.map((id) => [id, V(getPt(this.f, id))])), moved: false };
    }
    this.redraw();
    this.app.ui.renderPM();
    this.app.ui.refreshCommandStates();
  }

  // ---------------------------------------------------------------- spline, tangent arc, convert
  finishSpline(closed) {
    const f = this.f, sp = this.spl;
    this.spl = null;
    this.chain = null;
    if (!sp) return;
    if (sp.ids.length < 2) { for (const id of sp.ids) this.dropLonely(id); this.redraw(); return; }
    f.segs.push({ id: newId(f, 's'), type: 'spline', pts: sp.ids.slice(), ...(closed ? { closed: true } : {}) });
    this.changed();
    this.app.status(`Spline through ${sp.ids.length} points${closed ? ' (closed)' : ''}. Drag its points to shape it.`);
  }

  // the free end pid of an entity, and the direction to carry on in from it
  tangentAtEnd(pid) {
    const f = this.f;
    const ents = f.segs.filter((s) => (segEndIds(s) || []).includes(pid)).reverse();
    if (!ents.length) return null;
    const s = ents[0], P = V(getPt(f, pid));
    let t;
    if (isLine(s)) t = unit(sub(P, V(getPt(f, s.a === pid ? s.b : s.a))));
    else if (s.type === 'arc') {
      const g = arcGeom(f, s), along = unit(cross(g.n, sub(P, g.C)));
      t = pid === s.b ? along : mulv(along, -1);
    } else if (s.type === 'spline') {
      const q = splineGeom(f, s).pieces;
      t = pid === s.pts[s.pts.length - 1] ? unit(sub(q[q.length - 1][3], q[q.length - 1][2])) : unit(sub(q[0][0], q[0][1]));
    }
    return t && len(t) > 0 ? { pid, t, from: s.id } : null;
  }

  // the tangent arc from this.tarc to Q: { C, n, R, th }, or null (Q straight ahead)
  tangentArcTo(Q) {
    const S = V(getPt(this.f, this.tarc.pid)), t = this.tarc.t, d = sub(Q, S);
    const nn = cross(t, d);
    if (len(nn) < 1e-9 * Math.max(1, dot(d, d))) return null;
    const n = unit(nn), m = cross(n, t), R = dot(d, d) / (2 * dot(d, m)), C = addv(S, mulv(m, R));
    const u = sub(S, C), w = sub(Q, C);
    let th = Math.atan2(dot(n, cross(u, w)), dot(u, w));
    if (th <= 0) th += TAU;
    return { S, C, n, R, th, at: (k) => addv(C, rot(u, n, th * k)) };
  }

  finishTangentArc(e) {
    const f = this.f, c = this.snap(e);
    const g = this.tangentArcTo(c.p);
    if (!g) { this.app.toast('That is straight ahead: no arc (use Line there)', true); return; }
    const bid = this.addPoint(c);
    if (bid === this.tarc.pid) return;
    const cid = this.newPoint(g.C), arcId = newId(f, 's');
    f.segs.push({ id: arcId, type: 'arc', a: this.tarc.pid, b: bid, c: cid, n: g.n.map(r6) });
    const from = getSeg(f, this.tarc.from);
    if (from && (isLine(from) || from.type === 'arc')) f.rels.push({ id: newId(f, 'r'), type: 'tangent', refs: [arcId, from.id] });
    const E = V(getPt(f, bid));
    this.tarc = { pid: bid, t: unit(cross(g.n, sub(E, g.C))), from: arcId };
    this.changed();
    this.app.status('Tangent arc added. Click for another one carrying on; Esc ends.');
  }

  // a model edge (from the view's edge list: pts, mid, type) as linked sketch geometry
  convertEdge(E) {
    const f = this.f;
    const P = (E.pts || []).map((q) => (q.toArray ? q.toArray() : q)).map((q) => q.map(r6));
    if (P.length < 2) return;
    const scale = Math.max(1, ...P.flat().map(Math.abs)), tol = 1e-6 * scale;
    const mid = E.mid?.toArray ? E.mid.toArray() : E.mid || P[P.length >> 1];
    const sid = newId(f, 's');
    const link = { p: mid.map(r6), t: E.type || '' };
    // (what the kernel needs to find the edge again after the model changes: the model's box, a line's
    // direction, a circle's size and place)
    const all = (this.vp.edgeList || []).flatMap((x) => x.pts.map((q) => (q.toArray ? q.toArray() : q)));
    if (all.length) link.box = { min: [0, 1, 2].map((k) => Math.min(...all.map((q) => q[k]))), max: [0, 1, 2].map((k) => Math.max(...all.map((q) => q[k]))) };
    if (E.type === 'LINE') link.d = unit(sub(P[P.length - 1], P[0])).map(r6);
    // a point there already (an end of an edge converted before) is shared, so converted edges join up
    const pointAt = (q) => {
      let id = f.pts.find((p) => len(sub(V(p), q)) < tol)?.id;
      if (!id) id = this.newPoint(q);
      if (!f.rels.some((r) => r.type === 'fix' && r.refs[0] === id)) f.rels.push({ id: newId(f, 'r'), type: 'fix', refs: [id], value: q.slice(), link: sid, hidden: true });
      return id;
    };
    const closed = len(sub(P[0], P[P.length - 1])) < tol;
    const collinear = P.every((q) => len(cross(sub(q, P[0]), sub(P[P.length - 1], P[0]))) < tol * Math.max(1, len(sub(P[P.length - 1], P[0]))));
    if (E.type === 'LINE' || (!closed && collinear)) {
      f.segs.push({ id: sid, a: pointAt(P[0]), b: pointAt(P[P.length - 1]), link });
    } else if (E.type === 'CIRCLE' && P.length >= 3) {
      const A = P[0], M = P[Math.floor(P.length / 3)], B = P[Math.floor((2 * P.length) / 3)];
      const circ = (a, m, b) => { const ab = sub(b, a), am = sub(m, a), x = cross(ab, am); return addv(a, mulv(addv(mulv(cross(x, ab), dot(am, am)), mulv(cross(am, x), dot(ab, ab))), 1 / (2 * dot(x, x)))); };
      if (closed) {
        const C = circ(A, M, B), n = unit(cross(sub(M, A), sub(B, M))), R = len(sub(A, C));
        Object.assign(link, { r: r6(R), c: C.map(r6), n: n.map(r6) });
        f.segs.push({ id: sid, type: 'circle', c: pointAt(C), r: r6(R), n: n.map(r6), link });
        f.rels.push({ id: newId(f, 'r'), type: 'radius', refs: [sid], value: r6(R), link: sid, hidden: true });
      } else {
        const Bend = P[P.length - 1], Mid = P[P.length >> 1], C = circ(A, Mid, Bend), n = unit(cross(sub(Mid, A), sub(Bend, Mid)));
        f.segs.push({ id: sid, type: 'arc', a: pointAt(A), b: pointAt(Bend), c: pointAt(C), n: n.map(r6), link });
      }
    } else {
      // any other curve: a spline through points along it
      const k = Math.min(12, P.length);
      const idx = Array.from({ length: k }, (_, i) => Math.round((i * (P.length - 1)) / (k - 1)));
      const ids = (closed ? idx.slice(0, -1) : idx).map((i) => pointAt(P[i]));
      f.segs.push({ id: sid, type: 'spline', pts: ids, link, ...(closed ? { closed: true } : {}) });
    }
    this.changed();
    this.app.status('Edge converted (purple: linked to the model). Click more edges; Esc ends.');
  }

  // break the link of the selected converted entities (they become ordinary geometry where they are)
  unlinkSelected() {
    const f = this.f, ids = new Set([...this.sel].filter((id) => getSeg(f, id)?.link));
    for (const s of f.segs) if (ids.has(s.id)) delete s.link;
    f.rels = f.rels.filter((r) => !(r.link && ids.has(r.link)));
    this.changed();
  }

  // ---------------------------------------------------------------- move / copy / rotate the selection
  // the points of the selected entities and the selected points
  selPoints() {
    const f = this.f, out = new Set();
    for (const id of this.sel) { if (getPt(f, id)) out.add(id); const s = getSeg(f, id); if (s) segPts(s).forEach((x) => out.add(x)); }
    return [...out];
  }

  // Along X/Y/Z, Parallel to XY/YZ/ZX, On XY/YZ/ZX after a rotation R: the turned type, or null (no longer one)
  turnedType(type, R) {
    const axisOf = (v) => { const k = Object.keys(AXES).find((K) => Math.abs(dot(v, AXES[K])) > 1 - 1e-9); return k || null; };
    const along = /^along([XYZ])$/.exec(type), par = /^parallel(XY|YZ|ZX)$/.exec(type), on = /^on(XY|YZ|ZX)$/.exec(type);
    const NORMAL = { XY: 'Z', YZ: 'X', ZX: 'Y' }, PLANE = { Z: 'XY', X: 'YZ', Y: 'ZX' };
    if (along) { const k = axisOf(R(AXES[along[1]])); return k ? 'along' + k : null; }
    if (par || on) { const k = axisOf(R(AXES[NORMAL[(par || on)[1]]])); return k ? (par ? 'parallel' : 'on') + PLANE[k] : null; }
    return type;
  }

  // T: point → point; R: how directions turn (null for a move)
  transformSelection(T, R = null, copy = false) {
    const f = this.f, ids = this.selPoints(), set = new Set(ids);
    const segs = [...this.sel].map((id) => getSeg(f, id)).filter(Boolean);
    if (!ids.length) return;
    const before = JSON.stringify(this.data());
    if (!copy) {
      if (f.rels.some((r) => (r.type === 'fix' || r.link) && set.has(r.refs[0])) || segs.some((s) => s.link)) { this.app.toast('Fixed or converted geometry can\'t be moved (delete its Fix, or unlink it, first)', true); return; }
      for (const id of ids) { const p = getPt(f, id); [p.x, p.y, p.z] = T(V(p)).map(r6); }
      if (R) {
        for (const s of segs) if (s.n) s.n = R(s.n).map(r6);
        const mine = (x) => set.has(x) || segs.some((q) => q.id === x);
        f.rels = f.rels.filter((r) => {
          if (!r.refs.every(mine)) return true;
          if (r.type === 'regular' && r.value?.n) r.value.n = R(r.value.n).map(r6);
          const k = this.turnedType(r.type, R);
          if (k) r.type = k;
          return !!k;
        });
      }
      const pinned = new Set(ids.flatMap((id) => { const i = f.pts.findIndex((p) => p.id === id); return [3 * i, 3 * i + 1, 3 * i + 2]; }));
      if (!solve3d(f, this.ev, { pinned }).ok) {
        Object.assign(f, JSON.parse(before));
        this.app.toast('It can\'t go there: relations or dimensions to the rest of the sketch hold it', true);
        return;
      }
      this.changed();
      return;
    }
    // a copy: new points and entities, with the relations among them (not the ones holding them in place)
    const map = new Map(ids.map((id) => [id, this.newPoint(T(V(getPt(f, id))))]));
    const segMap = new Map();
    for (const sg of segs) {
      const c = JSON.parse(JSON.stringify(sg));
      c.id = newId(f, 's');
      delete c.link;
      for (const k of ['a', 'b', 'c']) if (c[k]) c[k] = map.get(c[k]);
      if (c.pts) c.pts = c.pts.map((x) => map.get(x));
      if (R && c.n) c.n = R(c.n).map(r6);
      f.segs.push(c);
      segMap.set(sg.id, c.id);
    }
    const inside = (x) => map.has(x) || segMap.has(x);
    for (const r of [...f.rels]) {
      if (r.link || r.type === 'fix' || r.type === 'onPlane' || /^on(XY|YZ|ZX)$/.test(r.type) || !r.refs.every(inside)) continue;
      const c = JSON.parse(JSON.stringify(r));
      c.id = newId(f, 'r');
      c.refs = r.refs.map((x) => map.get(x) || segMap.get(x));
      if (R) { const k = this.turnedType(c.type, R); if (!k) continue; c.type = k; if (c.type === 'regular' && c.value?.n) c.value.n = R(c.value.n).map(r6); if (c.axis) continue; }
      f.rels.push(c);
    }
    this.sel = new Set(segMap.size ? [...segMap.values()] : [...map.values()]);
    if (!solve3d(f, this.ev).ok) { Object.assign(f, JSON.parse(before)); this.app.toast('The copy could not be placed', true); return; }
    this.changed();
  }
  moveBy(d, copy = false) { this.transformSelection((p) => addv(p, d), null, copy); }
  rotateBy(axis, deg, copy = false) {
    const ids = this.selPoints();
    if (!ids.length) return;
    const pts = ids.map((id) => V(getPt(this.f, id)));
    const c = mulv(pts.reduce((a, b) => addv(a, b), [0, 0, 0]), 1 / pts.length);
    const n = AXES[axis] || this.curPlane().n, th = (deg * Math.PI) / 180;
    this.transformSelection((p) => addv(c, rot(sub(p, c), n, th)), (v) => rot(v, n, th), copy);
  }

  // ---------------------------------------------------------------- circles, arcs, polygons
  shapeClick(e) {
    const t = this.tool;
    const c = this.snap(e);
    if (!this.draw) {
      const n = this.curPlane().n.slice();
      this.draw = { tool: t, picks: [c], n, sweep: 0, lastAng: null };
      this.app.status({ circle: 'Click a point on the circle.', arc: 'Click the start of the arc.', arc3: 'Click the end of the arc.', polygon: 'Click a corner of the polygon.' }[t]);
      this.redraw();
      return;
    }
    const d = this.draw;
    d.picks.push(c);
    if (t === 'circle') return this.finishCircle();
    if (t === 'polygon') return this.finishPolygon();
    if (d.picks.length === 2) {
      if (len(sub(d.picks[1].p, d.picks[0].p)) < 1e-9) { d.picks.pop(); return; }
      this.app.status(t === 'arc' ? 'Click the end of the arc (move round the way it should go).' : 'Click a point the arc runs through.');
      this.redraw();
      return;
    }
    if (t === 'arc') return this.finishArc();
    return this.finishArc3();
  }

  // the projection of q onto the plane of the shape (normal n through o)
  onShapePlane(q, o, n) { const k = dot(sub(q, o), n); return sub(q, mulv(n, k)); }

  finishCircle() {
    const d = this.draw, f = this.f, n = unit(d.n);
    const C = d.picks[0].p, Q = this.onShapePlane(d.picks[1].p, C, n), r = len(sub(Q, C));
    this.draw = null;
    if (r < 1e-6) return this.redraw();
    const cid = this.addPoint(d.picks[0]);
    const id = newId(f, 's');
    f.segs.push({ id, type: 'circle', c: cid, r: r6(r), n: n.map(r6) });
    this.changed();
    this.app.status('Circle added. Click for another; Dimension sets its diameter.');
  }

  finishPolygon() {
    const d = this.draw, f = this.f, n = unit(d.n), k = Math.max(3, Math.min(64, this.polySides | 0));
    const C = d.picks[0].p, Q = this.onShapePlane(d.picks[1].p, C, n), u = sub(Q, C);
    this.draw = null;
    if (len(u) < 1e-6) return this.redraw();
    const cid = this.addPoint(d.picks[0]);
    const vs = Array.from({ length: k }, (_, i) => (i === 0 && d.picks[1].pid ? d.picks[1].pid : this.newPoint(addv(C, rot(u, n, (TAU * i) / k)))));
    for (let i = 0; i < k; i++) f.segs.push({ id: newId(f, 's'), a: vs[i], b: vs[(i + 1) % k] });
    f.rels.push({ id: newId(f, 'r'), type: 'regular', refs: [cid, ...vs], value: { n: n.map(r6) } });
    this.changed();
    this.app.status(`Polygon (${k} sides) added. It stays regular; dimension a side or the centre-to-corner distance to size it.`);
  }

  // the angle (round n from u) of a point, for following the mouse round an arc
  angleOf(q, C, u, n) { const w = sub(q, C); return Math.atan2(dot(n, cross(u, w)), dot(u, w)); }

  finishArc() {
    const d = this.draw, f = this.f, n0 = unit(d.n);
    const C = d.picks[0].p, A = this.onShapePlane(d.picks[1].p, C, n0), u = sub(A, C), R = len(u);
    let ang = this.angleOf(d.picks[2].p, C, u, n0);
    if (d.sweep < 0 && ang > 0) ang -= TAU;
    if (d.sweep > 0 && ang < 0) ang += TAU;
    this.draw = null;
    if (R < 1e-6 || Math.abs(ang) < 1e-6) return this.redraw();
    const n = ang < 0 ? mulv(n0, -1) : n0;
    const B = addv(C, rot(u, n, Math.abs(ang)));
    const cid = this.addPoint(d.picks[0]);
    const aid = d.picks[1].pid || this.newPoint(A);
    const bid = d.picks[2].pid && Math.abs(len(sub(V(getPt(f, d.picks[2].pid)), C)) - R) < 1e-6 * Math.max(1, R) ? d.picks[2].pid : this.newPoint(B);
    f.segs.push({ id: newId(f, 's'), type: 'arc', a: aid, b: bid, c: cid, n: n.map(r6) });
    this.changed();
    this.app.status('Arc added. Its ends join lines drawn from them; Dimension sets its radius.');
  }

  finishArc3() {
    const d = this.draw, f = this.f;
    const A = d.picks[0].p, B = d.picks[1].p, M = d.picks[2].p;
    this.draw = null;
    const nn = cross(sub(M, A), sub(B, M));
    if (len(nn) < 1e-9 * Math.max(1, len(sub(B, A)) ** 2)) { this.app.toast('The three points are in line: no arc runs through them', true); return this.redraw(); }
    const n = unit(nn);
    // the centre: equally far from A, B and M, in their plane
    const ab = sub(B, A), am = sub(M, A);
    const abxam = cross(ab, am);
    const C = addv(A, mulv(addv(mulv(cross(abxam, ab), dot(am, am)), mulv(cross(am, abxam), dot(ab, ab))), 1 / (2 * dot(abxam, abxam))));
    const aid = this.addPoint(d.picks[0]), bid = this.addPoint(d.picks[1]);
    if (aid === bid) return this.redraw();
    const cid = this.newPoint(C);
    f.segs.push({ id: newId(f, 's'), type: 'arc', a: aid, b: bid, c: cid, n: n.map(r6) });
    this.changed();
    this.app.status('Arc added. Dimension sets its radius.');
  }

  // Sketch Fillet: the corner point where two lines meet becomes a tangent arc of radius R. The lines are trimmed
  // back; the sharp corner stays as a point on both lines (dimensions to it keep their meaning).
  filletCorner(pid, R) {
    const f = this.f;
    const lines = f.segs.filter((s) => isLine(s) && (s.a === pid || s.b === pid));
    const others = f.segs.filter((s) => !isLine(s) && segPts(s).includes(pid));
    if (lines.length !== 2 || others.length) { this.app.toast('Sketch Fillet: click a corner where exactly two lines meet', true); return; }
    if (!(R > 0)) { this.app.toast('Set a fillet radius greater than zero', true); return; }
    const before = JSON.stringify(this.data());
    const P = V(getPt(f, pid));
    const far = lines.map((l) => (l.a === pid ? l.b : l.a));
    const u1 = unit(sub(V(getPt(f, far[0])), P)), u2 = unit(sub(V(getPt(f, far[1])), P));
    const th = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
    if (th < 1e-3 || th > Math.PI - 1e-3) { this.app.toast('Those lines are in line: there is no corner to round', true); return; }
    const s = R / Math.tan(th / 2);
    if (s > len(sub(V(getPt(f, far[0])), P)) - 1e-9 || s > len(sub(V(getPt(f, far[1])), P)) - 1e-9) { this.app.toast(`A ${fmt(R)} mm fillet doesn't fit on those lines: make it smaller`, true); return; }
    const T1 = addv(P, mulv(u1, s)), T2 = addv(P, mulv(u2, s));
    const Cc = addv(P, mulv(unit(addv(u1, u2)), R / Math.sin(th / 2)));
    const n = unit(cross(sub(T1, Cc), sub(T2, Cc)));
    const t1 = this.newPoint(T1), t2 = this.newPoint(T2), cid = this.newPoint(Cc);
    lines.forEach((l, i) => { const t = i ? t2 : t1; if (l.a === pid) l.a = t; else l.b = t; });
    const arcId = newId(f, 's');
    f.segs.push({ id: arcId, type: 'arc', a: t1, b: t2, c: cid, n: n.map(r6) });
    // lengths measured to the corner keep measuring to it
    for (const r of f.rels) if (r.type === 'length' && lines.some((l) => l.id === r.refs[0])) { const i = lines.findIndex((l) => l.id === r.refs[0]); r.type = 'distance'; r.refs = [far[i], pid]; }
    lines.forEach((l) => f.rels.push({ id: newId(f, 'r'), type: 'onLine', refs: [pid, l.id] }));
    lines.forEach((l) => f.rels.push({ id: newId(f, 'r'), type: 'tangent', refs: [arcId, l.id] }));
    // the first fillet of this use of the tool gets the radius; the later ones are equal to it
    const first = this.blendFirst?.kind === 'fillet' && getSeg(f, this.blendFirst.arc) ? this.blendFirst.arc : null;
    if (first) f.rels.push({ id: newId(f, 'r'), type: 'equalR', refs: [first, arcId] });
    else f.rels.push({ id: newId(f, 'r'), type: 'radius', refs: [arcId], value: +R.toFixed(4) });
    if (!solve3d(f, this.ev).ok) {
      Object.assign(f, JSON.parse(before));
      this.app.toast('The fillet conflicts with the relations already on those lines', true);
      return;
    }
    if (!first) this.blendFirst = { kind: 'fillet', arc: arcId };
    this.changed();
    this.app.status(first ? 'Corner rounded, equal to the first fillet (Equal Radius). Leave the tool to start a new size.' : `Corner rounded (R ${fmt(R)} mm). Further fillets are made equal to it; double-click the radius to change them all.`);
  }

  // Sketch Chamfer: the corner where two lines meet is cut by a line d from it along both. The first chamfer of
  // this use of the tool gets the distances; the later ones are made equal to it (Equal Distance).
  chamferCorner(pid, d) {
    const f = this.f;
    const lines = f.segs.filter((s) => isLine(s) && (s.a === pid || s.b === pid));
    const others = f.segs.filter((s) => !isLine(s) && segPts(s).includes(pid));
    if (lines.length !== 2 || others.length) { this.app.toast('Sketch Chamfer: click a corner where exactly two lines meet', true); return; }
    if (!(d > 0)) { this.app.toast('Set a chamfer distance greater than zero', true); return; }
    const before = JSON.stringify(this.data());
    const P = V(getPt(f, pid)), far = lines.map((l) => (l.a === pid ? l.b : l.a));
    const u = far.map((q) => unit(sub(V(getPt(f, q)), P)));
    if (len(cross(u[0], u[1])) < 1e-6) { this.app.toast('Those lines are in line: there is no corner to chamfer', true); return; }
    if (far.some((q) => d > len(sub(V(getPt(f, q)), P)) - 1e-9)) { this.app.toast(`A ${fmt(d)} mm chamfer doesn't fit on those lines: make it smaller`, true); return; }
    const t = u.map((ui) => this.newPoint(addv(P, mulv(ui, d))));
    lines.forEach((l, i) => { if (l.a === pid) l.a = t[i]; else l.b = t[i]; });
    const cl = newId(f, 's');
    f.segs.push({ id: cl, a: t[0], b: t[1], ...(lines.every((l) => l.construction) ? { construction: true } : {}) });
    for (const r of f.rels) if (r.type === 'length' && lines.some((l) => l.id === r.refs[0])) { const i = lines.findIndex((l) => l.id === r.refs[0]); r.type = 'distance'; r.refs = [far[i], pid]; }
    lines.forEach((l) => f.rels.push({ id: newId(f, 'r'), type: 'onLine', refs: [pid, l.id] }));
    const first = this.blendFirst?.kind === 'chamfer' && getPt(f, this.blendFirst.p) && getPt(f, this.blendFirst.t) ? this.blendFirst : null;
    // (the first chamfer: one distance, both sides equal to it; the later ones equal to the first)
    if (first) for (const ti of t) f.rels.push({ id: newId(f, 'r'), type: 'equalDist', refs: [pid, ti, first.p, first.t] });
    else {
      f.rels.push({ id: newId(f, 'r'), type: 'distance', refs: [pid, t[0]], value: +d.toFixed(4) });
      f.rels.push({ id: newId(f, 'r'), type: 'equalDist', refs: [pid, t[1], pid, t[0]] });
    }
    if (!solve3d(f, this.ev).ok) {
      Object.assign(f, JSON.parse(before));
      this.app.toast('The chamfer conflicts with the relations already on those lines', true);
      return;
    }
    if (!first) this.blendFirst = { kind: 'chamfer', p: pid, t: t[0] };
    this.changed();
    this.app.status(first ? 'Corner chamfered, equal to the first chamfer (Equal Distance). Leave the tool to start a new size.' : `Corner chamfered (${fmt(d)} mm). Further chamfers are made equal to it; double-click a distance to change them all.`);
  }

  // ---------------------------------------------------------------- Trim
  // Where the entity id is crossed or touched by the others: [{ t, p, pid?, by? }] along it (t: distance for a
  // line, angle for an arc / circle), and the parameter of the clicked spot.
  cutsOn(id) {
    const f = this.f, s = getSeg(f, id), out = [];
    const scale = Math.max(1, ...f.pts.flatMap((p) => [Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)]));
    const tol = 1e-6 * scale + 1e-7;
    // the entity as a curve: param of a point on it (null: not on it), point at a param, ends
    let paramOf, L, closed = false;
    if (isLine(s)) {
      const [A, B] = this.segEnds(s); L = len(sub(B, A));
      const u = mulv(sub(B, A), 1 / (L || 1));
      paramOf = (q) => { const t = dot(sub(q, A), u); return t > -tol && t < L + tol && len(sub(addv(A, mulv(u, t)), q)) < tol ? Math.max(0, Math.min(L, t)) : null; };
    } else {
      const g = s.type === 'arc' ? arcGeom(f, s) : circleGeom(f, s);
      const u0 = s.type === 'arc' ? sub(g.A, g.C) : sub(g.at(0), g.C);
      L = s.type === 'arc' ? g.th : TAU; closed = s.type === 'circle';
      paramOf = (q) => {
        const w = sub(q, g.C);
        if (Math.abs(dot(w, g.n)) > tol || Math.abs(len(w) - g.R) > tol) return null;
        let a = Math.atan2(dot(g.n, cross(u0, w)), dot(u0, w));
        if (a < -1e-9) a += TAU;
        return a <= L + 1e-9 ? Math.min(a, L) : null;
      };
    }
    const own = new Set(segPts(s));
    // points of other entities lying on it (T-junctions, ends touching it)
    for (const p of f.pts) {
      if (own.has(p.id)) continue;
      if (!f.segs.some((o) => o.id !== id && segPts(o).includes(p.id))) continue;
      const t = paramOf(V(p));
      if (t !== null) out.push({ t, p: V(p), pid: p.id });
    }
    // crossings with other lines (and lines with this arc / circle)
    for (const o of f.segs) {
      if (o.id === id || o.type === 'spline') continue;
      const pts = [];
      if (isLine(o) && isLine(s)) {
        const [A, B] = this.segEnds(s), [C, D] = this.segEnds(o);
        const q = closestSegSeg(A, B, C, D);
        if (q && q.d < tol) pts.push(q.p);
      } else if (isLine(o) !== isLine(s)) {
        const [ln, rd] = isLine(o) ? [o, s] : [s, o];
        const [A, B] = this.segEnds(ln), g = rd.type === 'arc' ? arcGeom(f, rd) : circleGeom(f, rd);
        for (const q of lineRound(A, B, g.C, g.n, g.R, tol)) pts.push(q);
      }
      for (const q of pts) {
        if (segPts(o).some((pid) => len(sub(V(getPt(f, pid)), q)) < tol)) continue; // (its end: counted above)
        const t = paramOf(q);
        // (on the other one too, for an arc)
        if (t !== null && (o.type !== 'arc' || this.onArc(o, q, tol))) out.push({ t, p: q, by: isLine(o) ? o.id : null });
      }
    }
    // (the same place once)
    out.sort((a, b) => a.t - b.t);
    const cuts = out.filter((c, i) => !i || Math.abs(c.t - out[i - 1].t) > 1e-7 * Math.max(1, L));
    return { s, L, closed, cuts: cuts.filter((c) => closed || (c.t > 1e-7 * Math.max(1, L) && c.t < L - 1e-7 * Math.max(1, L))), paramOf };
  }
  onArc(o, q, tol) { const g = arcGeom(this.f, o), u = sub(g.A, g.C), w = sub(q, g.C); let a = Math.atan2(dot(g.n, cross(u, w)), dot(u, w)); if (a < -1e-9) a += TAU; return a <= g.th + 1e-7 && Math.abs(len(w) - g.R) < tol * 10; }

  // the parameter along entity s nearest the mouse (on screen)
  clickParam(s, e, L) {
    const m = this.vp.screenPos(e), pts = this.entPts(s, 240);
    let best = 0, bd = Infinity;
    if (isLine(s)) {
      const A = this.screen(pts[0]), B = this.screen(pts[1]), dx = B.x - A.x, dy = B.y - A.y;
      return Math.max(0, Math.min(1, ((m.x - A.x) * dx + (m.y - A.y) * dy) / (dx * dx + dy * dy || 1))) * L;
    }
    pts.forEach((q, i) => { const sq = this.screen(q), d = Math.hypot(sq.x - m.x, sq.y - m.y); if (d < bd) { bd = d; best = i; } });
    return (best / (pts.length - 1)) * L;
  }

  trimAt(id, e) {
    const f = this.f;
    if (getSeg(f, id)?.type === 'spline') { this.app.toast('Splines can\'t be trimmed (yet): delete or reshape it instead', true); return; }
    const { s, L, closed, cuts } = this.cutsOn(id);
    const tc = this.clickParam(s, e, L);
    if (!cuts.length) { this.sel = new Set([id]); this.deleteSelected(); this.app.status('Nothing crosses it: the whole entity was removed.'); return; }
    if (closed && cuts.length < 2) { this.app.toast('A circle needs two crossings to be trimmed (or nothing crossing it to be removed)', true); return; }
    // the point for a cut (an existing point there, else a new one held on what crosses there)
    const pointAt = (c) => {
      if (c.pid) return c.pid;
      const pid = this.newPoint(c.p);
      if (c.by) f.rels.push({ id: newId(f, 'r'), type: 'onLine', refs: [pid, c.by] });
      return pid;
    };
    // (relations that measured the whole entity no longer apply)
    const dropRels = () => { f.rels = f.rels.filter((r) => !(r.refs.includes(id) && ['length', 'midpoint', 'equal'].includes(r.type))); };
    if (closed) {
      // the circle loses the piece between the cuts either side of the click: it becomes an arc
      let k = cuts.findIndex((c) => c.t > tc);
      if (k < 0) k = 0;
      const after = cuts[k], before = cuts[(k - 1 + cuts.length) % cuts.length];
      const a = pointAt(after), b = pointAt(before);
      s.type = 'arc'; s.a = a; s.b = b; delete s.r;
      dropRels();
    } else {
      const lo = [...cuts].reverse().find((c) => c.t < tc), hi = cuts.find((c) => c.t > tc);
      if (lo && hi) {
        // the middle piece goes: the entity is split in two
        const p1 = pointAt(lo), p2 = pointAt(hi);
        const nid = newId(f, 's');
        f.segs.push({ ...s, id: nid, a: p2, b: s.b });
        s.b = p1;
        for (const r of f.rels) if (['alongX', 'alongY', 'alongZ', 'parallelXY', 'parallelYZ', 'parallelZX'].includes(r.type) && r.refs[0] === id) f.rels.push({ ...r, id: newId(f, 'r'), refs: [nid] });
      } else if (hi) {
        const old = s.a; s.a = pointAt(hi); this.dropLonely(old);
      } else {
        const old = s.b; s.b = pointAt(lo); this.dropLonely(old);
      }
      dropRels();
    }
    f.rels = f.rels.filter((r) => r.refs.every((x) => getPt(f, x) || getSeg(f, x)));
    this.changed();
    this.app.status('Trimmed.');
  }
  // a point nothing uses any more goes (with its relations)
  dropLonely(pid) {
    const f = this.f;
    if (f.segs.some((o) => segPts(o).includes(pid))) return;
    f.pts = f.pts.filter((p) => p.id !== pid);
    f.rels = f.rels.filter((r) => !r.refs.includes(pid));
  }

  // ---------------------------------------------------------------- Dimension: pick, then click to place
  dimClick(e) {
    const h = this.pick(e);
    if (!h) {
      if (this.dimPending) return this.makeDim(this.dimPending);
      this.dimPicks = []; this.redraw(); return;
    }
    if (this.dimPicks.some((x) => x.id === h.id)) {
      if (this.dimPending) return this.makeDim(this.dimPending);
      return;
    }
    if (h.kind === 'arc' || h.kind === 'circle') this.dimPicks = [];
    if (this.dimPicks.length >= 2 || (this.dimPicks.length === 1 && this.dimPicks[0].kind !== h.kind)) this.dimPicks = [];
    this.dimPicks.push(h);
    const ks = this.dimPicks.map((x) => x.kind).join(',');
    const ids = this.dimPicks.map((x) => x.id);
    this.dimPending = ks === 'seg' ? { type: 'length', refs: ids, axis: null }
      : ks === 'arc' ? { type: 'radius', refs: ids, axis: null }
        : ks === 'circle' ? { type: 'diameter', refs: ids, axis: null }
          : ks === 'pt,pt' ? { type: 'distance', refs: ids, axis: null }
            : ks === 'seg,seg' ? { type: 'angle', refs: ids, axis: null } : null;
    // (shown at once, where the mouse is, as in a 2D sketch)
    if (this.dimPending) this.dimPending.off = this.dimOffset(e, this.dimPending);
    this.app.status(ks === 'seg' ? 'Click where to place the length (Tab: along X, Y or Z), or another line for the angle.'
      : ks === 'pt' ? 'Click another point for the distance.' : this.dimPending?.type === 'distance' ? 'Click where to place the distance (Tab: along X, Y or Z).' : 'Click where to place it.');
    this.redraw();
  }

  pointerMove(e) {
    this.lastEv = e;
    if (this.drag?.kind === 'move') {
      const d = this.drag, f = this.f;
      const ax = e.ctrlKey || e.shiftKey ? null : this.axisSnap(e, d.from);
      const to = ax ? ax.p : this.rayOnPlane(e, d.from), delta = sub(to, d.from);
      if (!d.moved && f.rels.some((r) => (r.type === 'fix' || r.link) && d.ids.includes(r.refs[0]))) { this.app.status('Fixed or converted geometry stays where it is.'); return; }
      const keep = JSON.stringify(this.data());
      for (const id of d.ids) { const p = getPt(f, id), o = d.orig.get(id); p.x = r6(o[0] + delta[0]); p.y = r6(o[1] + delta[1]); p.z = r6(o[2] + delta[2]); }
      const pinned = new Set(d.ids.flatMap((id) => { const i = f.pts.findIndex((p) => p.id === id); return [3 * i, 3 * i + 1, 3 * i + 2]; }));
      if (!solve3d(f, this.ev, { pinned }).ok) Object.assign(f, JSON.parse(keep)); // (held there)
      d.moved = true;
      this.redraw();
      return;
    }
    if (this.drag) {
      const p = getPt(this.f, this.drag.id);
      const ax = e.ctrlKey || e.shiftKey ? null : this.axisSnap(e, this.drag.from);
      const to = ax ? ax.p : this.rayOnPlane(e, this.drag.from);
      const keep = JSON.stringify(this.data());
      p.x = to[0]; p.y = to[1]; p.z = to[2];
      const i = this.f.pts.indexOf(p);
      let r = solve3d(this.f, this.ev, { pinned: new Set([3 * i, 3 * i + 1, 3 * i + 2]) });
      if (!r.ok) r = solve3d(this.f, this.ev);
      if (!r.ok) Object.assign(this.f, JSON.parse(keep)); // (can't go there)
      this.drag.moved = true;
      this.redraw();
      return;
    }
    // a dimension being placed follows the mouse
    if (this.tool === 'dim' && this.dimPending) this.dimPending.off = this.dimOffset(e, this.dimPending);
    if (DRAW_TOOLS.has(this.tool)) {
      this.cand = this.snap(e);
      // an arc follows the mouse round (which way it goes)
      const d = this.draw;
      if (d?.tool === 'arc' && d.picks.length === 2) {
        const n = unit(d.n), C = d.picks[0].p, u = sub(this.onShapePlane(d.picks[1].p, C, n), C);
        const a = this.angleOf(this.cand.p, C, u, n);
        if (d.lastAng !== null) { let da = a - d.lastAng; if (da > Math.PI) da -= TAU; if (da < -Math.PI) da += TAU; d.sweep += da; }
        d.lastAng = a;
      }
      this.vp.canvas.style.cursor = 'crosshair';
    } else {
      const h = this.pick(e, this.tool === 'sfillet' || this.tool === 'schamfer' ? { segs: false } : this.tool === 'trim' ? { points: false } : {});
      this.hover = h?.id || null;
      this.vp.canvas.style.cursor = h ? 'pointer' : 'default';
    }
    this.redraw();
  }

  pointerUp() {
    if (this.drag) {
      const moved = this.drag.moved;
      this.drag = null;
      if (moved) this.changed();
    }
  }

  doubleClick() {
    if (this.tool === 'spline' && this.spl) return this.finishSpline(false);
    if ((this.tool === 'line' || this.tool === 'centerline') && this.chain) { this.chain = null; this.redraw(); }
  }

  leave() { this.cand = null; this.hover = null; this.redraw(); }

  // keys: true when used
  key(e) {
    const k = e.key;
    if (k === 'Tab') {
      // placing a length or distance: absolute → along X → Y → Z
      if (this.dimPending && (this.dimPending.type === 'length' || this.dimPending.type === 'distance')) {
        const order = [null, 'x', 'y', 'z'];
        this.dimPending.axis = order[(order.indexOf(this.dimPending.axis) + 1) % order.length];
        this.redraw();
        return true;
      }
      this.nextPlane();
      return true;
    }
    if (k === 'Escape') {
      if (this.inputEl) { this.closeInput(); return true; }
      if (this.spl) { this.finishSpline(false); return true; }
      if (this.tarc) { this.tarc = null; this.redraw(); return true; }
      if (this.draw) { this.draw = null; this.redraw(); return true; }
      if (this.chain) { this.chain = null; this.redraw(); return true; }
      if (this.dimPicks.length) { this.dimPicks = []; this.dimPending = null; this.redraw(); return true; }
      if (this.custom) { this.setPlane(this.plane); return true; }
      if (this.tool !== 'select') { this.setTool('select'); return true; }
      if (this.sel.size) { this.sel.clear(); this.redraw(); this.app.ui.renderPM(); return true; }
      return false;
    }
    if (k === 'Enter' && this.spl) { this.finishSpline(false); return true; }
    if (k === 'Enter' && this.chain) { this.chain = null; this.redraw(); return true; }
    if (k === 'Delete' || k === 'Backspace') { this.deleteSelected(); return true; }
    if (e.altKey || e.ctrlKey || e.metaKey) return false;
    const tools = { l: 'line', c: 'circle', a: 'arc', n: 'spline', p: 'polygon', d: 'dim', s: 'select', t: 'trim', e: 'convert' };
    if (tools[k.toLowerCase()]) { this.setTool(tools[k.toLowerCase()]); return true; }
    if (k.toLowerCase() === 'q') { this.toggleConstruction(); return true; }
    return false;
  }

  deleteSelected() {
    if (!this.sel.size) return;
    const f = this.f, ids = new Set(this.sel);
    // a deleted point takes its lines, arcs and circles with it; relations on anything deleted go too
    for (const s of f.segs) if (segPts(s).some((p) => ids.has(p))) ids.add(s.id);
    const ends = new Set(f.segs.filter((s) => ids.has(s.id)).flatMap(segPts));
    f.segs = f.segs.filter((s) => !ids.has(s.id));
    f.pts = f.pts.filter((p) => !ids.has(p.id));
    f.rels = f.rels.filter((r) => !ids.has(r.id) && r.refs.every((x) => getPt(f, x) || getSeg(f, x)));
    // points left alone by the deleted entities go as well
    const used = new Set(f.segs.flatMap(segPts));
    f.pts = f.pts.filter((p) => used.has(p.id) || !ends.has(p.id));
    f.rels = f.rels.filter((r) => r.refs.every((x) => getPt(f, x) || getSeg(f, x)));
    this.sel.clear();
    this.chain = null;
    this.changed();
  }

  // ---------------------------------------------------------------- relations and dimensions
  addRelation(type, refs) {
    const f = this.f;
    if (type === 'merge') return this.mergePoints(refs[0], refs[1]);
    const before = JSON.stringify(this.data());
    const one = REL3D[type].refs.length === 1;
    for (const r of one ? refs.map((x) => [x]) : [refs]) {
      if (f.rels.some((x) => x.type === type && x.refs.join() === r.join())) continue;
      f.rels.push({ id: newId(f, 'r'), type, refs: r.slice(), ...(type === 'fix' ? { value: V(getPt(f, r[0])) } : {}) });
    }
    if (!solve3d(f, this.ev).ok) {
      Object.assign(f, JSON.parse(before));
      this.app.toast(`${REL3D[type].label} can't be added: it conflicts with the relations or dimensions already there`, true);
      return;
    }
    this.changed();
  }

  mergePoints(keep, drop) {
    const f = this.f;
    for (const s of f.segs) { for (const k of ['a', 'b', 'c']) if (s[k] === drop) s[k] = keep; if (s.pts) s.pts = s.pts.map((x) => (x === drop ? keep : x)); }
    f.segs = f.segs.filter((s) => !isLine(s) || s.a !== s.b);
    for (const r of f.rels) r.refs = r.refs.map((x) => (x === drop ? keep : x));
    f.pts = f.pts.filter((p) => p.id !== drop);
    this.sel.clear();
    this.changed();
  }

  deleteRelation(id) {
    this.f.rels = this.f.rels.filter((r) => r.id !== id);
    this.changed();
  }

  setConstruction(on) {
    for (const id of this.sel) { const s = getSeg(this.f, id); if (s) { if (on) s.construction = true; else delete s.construction; } }
    this.changed();
  }

  // a point typed in its X / Y / Z boxes (the rest follows; refused when the relations hold it elsewhere)
  movePoint(id, xyz) {
    const p = getPt(this.f, id);
    if (!p) return;
    const keep = JSON.stringify(this.data());
    [p.x, p.y, p.z] = xyz;
    const i = this.f.pts.indexOf(p);
    const r = solve3d(this.f, this.ev, { pinned: new Set([3 * i, 3 * i + 1, 3 * i + 2]) });
    if (!r.ok) {
      Object.assign(this.f, JSON.parse(keep));
      this.app.toast('The point can\'t go there: its relations or dimensions hold it (delete one, e.g. Fix, to move it)', true);
      this.app.ui.renderPM();
      return;
    }
    this.changed();
  }

  currentValue(type, refs, axis = null) {
    const f = this.f;
    if (type === 'angle') {
      const s1 = getSeg(f, refs[0]), s2 = getSeg(f, refs[1]);
      const a = sub(V(getPt(f, s1.b)), V(getPt(f, s1.a))), b = sub(V(getPt(f, s2.b)), V(getPt(f, s2.a)));
      return (Math.atan2(len(cross(a, b)), dot(a, b)) * 180) / Math.PI;
    }
    if (type === 'radius' || type === 'diameter') {
      const s = getSeg(f, refs[0]);
      const R = s.type === 'circle' ? s.r : arcGeom(f, s).R;
      return type === 'diameter' ? 2 * R : R;
    }
    const [a, b] = type === 'length' ? (({ a: x, b: y }) => [x, y])(getSeg(f, refs[0])) : refs;
    const d = sub(V(getPt(f, b)), V(getPt(f, a)));
    return axis ? d[COORD[axis]] : len(d);
  }

  makeDim(p) {
    const { type, refs, axis = null } = p;
    this.dimPicks = [];
    this.dimPending = null;
    const f = this.f;
    const old = f.rels.find((r) => r.type === type && r.refs.join() === refs.join() && (r.axis || null) === axis);
    if (old) { this.redraw(); this.editDim(old.id); return; }
    const v = this.currentValue(type, refs, axis);
    if (axis && Math.abs(v) < 1e-9) { this.app.toast(`Those are level along ${axis.toUpperCase()} (0 mm): use a relation instead, or Tab to another direction`, true); this.redraw(); return; }
    const r = { id: newId(f, 'r'), type, refs: refs.slice(), value: +Math.abs(r6(v)).toFixed(4), ...(axis ? { axis, sgn: v < 0 ? -1 : 1 } : {}), ...(p.off && len(p.off) > 1e-9 ? { off: p.off.map(r6) } : {}) };
    f.rels.push(r);
    if (!solve3d(f, this.ev).ok) {
      f.rels = f.rels.filter((x) => x !== r);
      this.app.toast('That dimension conflicts with the relations and dimensions already there', true);
      this.redraw();
      return;
    }
    this.changed();
    this.editDim(r.id);
  }

  // the value box for a dimension, at its label
  editDim(id) {
    const r = this.f.rels.find((x) => x.id === id);
    if (!r) return;
    this.closeInput();
    const at = this.relAnchor(r);
    if (!at) return;
    const s = this.screen(at);
    const box = document.createElement('div');
    box.className = 's3-input';
    box.style.left = s.x + 'px';
    box.style.top = s.y + 'px';
    const input = document.createElement('input');
    input.value = String(r.value);
    const pre = r.axis ? 'Δ' + r.axis.toUpperCase() : r.type === 'radius' ? 'R' : r.type === 'diameter' ? 'Ø' : '';
    box.append(...(pre ? [Object.assign(document.createElement('span'), { textContent: pre })] : []), input, Object.assign(document.createElement('span'), { textContent: r.type === 'angle' ? '°' : 'mm' }));
    this.vp.labelsEl.appendChild(box);
    box.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.inputEl = box;
    // (after the click that opened it is over, or the view takes the focus back; no scrolling to it)
    setTimeout(() => { if (this.inputEl === box) { input.focus({ preventScroll: true }); input.select(); } }, 0);
    const apply = () => {
      const v = this.ev(input.value.trim());
      if (!(Number.isFinite(v) && (r.type === 'angle' ? v >= 0 && v <= 180 : v > 0))) { input.classList.add('bad'); return; }
      const before = JSON.stringify(this.data());
      r.value = /^[-+0-9.eE]+$/.test(input.value.trim()) ? +v : input.value.trim();
      if (!solve3d(this.f, this.ev).ok) {
        Object.assign(this.f, JSON.parse(before));
        this.app.toast(`The sketch can't take ${input.value.trim()}${r.type === 'angle' ? '°' : ' mm'} there (it conflicts with the other relations)`, true);
        input.classList.add('bad');
        return;
      }
      this.closeInput();
      this.changed();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') apply();
      if (e.key === 'Escape') this.closeInput();
    });
  }
  closeInput() { this.inputEl?.remove(); this.inputEl = null; }

  // Exact point: absolute coordinates, or relative to the last point while drawing a line.
  typedPoint(x, y, z) {
    const rel = !!this.chain;
    const from = rel ? this.anchor() : [0, 0, 0];
    const p = [from[0] + x, from[1] + y, from[2] + z].map(r6);
    if (!['line', 'centerline', 'point'].includes(this.tool)) this.setTool('line');
    const c = { p };
    const nz = [x, y, z].map((v) => Math.abs(v) > 1e-12);
    if (rel && nz.filter(Boolean).length === 1) c.axis = 'XYZ'[nz.indexOf(true)];
    if (this.tool === 'point' || !this.chain) {
      const id = this.addPoint(c);
      if (this.tool !== 'point') this.chain = { start: id, last: id, count: 0 };
      this.changed();
      return;
    }
    const id = this.addLine(c);
    if (id) this.chain.last = id;
    this.changed();
  }

  // ---------------------------------------------------------------- display
  segEnds(s) { if (!isLine(s)) return null; const a = getPt(this.f, s.a), b = getPt(this.f, s.b); return a && b ? [V(a), V(b)] : null; }

  // where a relation's or dimension's label sits
  relAnchor(r) {
    const f = this.f;
    if (r.type === 'distance') { const a = getPt(f, r.refs[0]), b = getPt(f, r.refs[1]); return a && b ? V(a).map((x, i) => (x + V(b)[i]) / 2) : null; }
    if (r.type === 'regular') { const p = getPt(f, r.refs[0]); return p ? V(p) : null; }
    const sid = r.type === 'tangent' ? null : r.refs.find((x) => getSeg(f, x));
    if (r.type === 'tangent') {
      const arc = getSeg(f, r.refs[0]), ln = getSeg(f, r.refs[1]);
      const E = arc && ln && ([ln.a, ln.b].includes(arc.a) ? arc.a : arc.b);
      const p = E && getPt(f, E);
      return p ? V(p) : null;
    }
    if (sid) return this.entMid(getSeg(f, sid));
    const p = getPt(f, r.refs[0]);
    return p ? V(p) : null;
  }

  // A dimension's lines and where its value sits, `off` (a 3D offset, as placed) from what it measures: a length or
  // distance between extension lines, its dimension line square to them (along X, Y or Z for one along an axis); a
  // radius, diameter or angle on a leader from its entity. { lines, at }, or null when there is nothing to draw
  dimGeom(type, refs, axis, off) {
    const f = this.f;
    if (!off) return null;
    if (type === 'length' || type === 'distance') {
      const sg = type === 'length' ? getSeg(f, refs[0]) : null, pa = getPt(f, sg ? sg.a : refs[0]), pb = getPt(f, sg ? sg.b : refs[1]);
      if (!pa || !pb) return null;
      const A = V(pa), B0 = V(pb), k = axis ? COORD[axis] : -1;
      const B = k >= 0 ? A.map((x, i) => (i === k ? B0[i] : x)) : B0, d = sub(B, A);
      if (len(d) < 1e-9) return null;
      const u = unit(d), o = sub(off, mulv(u, dot(off, u))), w = this.vp.worldPerPixel(), ol = len(o);
      const over = ol > 1e-9 ? mulv(o, (ol + 6 * w) / ol) : o;
      return { lines: [[A, addv(A, over)], [B0, addv(B, over)], [addv(A, o), addv(B, o)]], at: addv(addv(A, o), mulv(d, 0.5)) };
    }
    const anchor = this.relAnchor({ type, refs });
    if (!anchor) return null;
    const at = addv(anchor, off);
    return { lines: [[anchor, at]], at };
  }
  // where the mouse puts a dimension being placed: its offset from what it measures, in the plane through it that
  // faces the view (for a length, the plane along it)
  dimOffset(e, p) {
    const f = this.f, cam = new THREE.Vector3();
    this.vp.camera.getWorldDirection(cam);
    let base, n = cam.toArray();
    if (p.type === 'length' || p.type === 'distance') {
      const sg = p.type === 'length' ? getSeg(f, p.refs[0]) : null, pa = getPt(f, sg ? sg.a : p.refs[0]), pb = getPt(f, sg ? sg.b : p.refs[1]);
      if (!pa || !pb) return null;
      base = V(pa);
      const u = unit(sub(V(pb), base)), m = sub(n, mulv(u, dot(n, u)));
      if (len(m) > 1e-6) n = unit(m);
    } else base = this.relAnchor({ type: p.type, refs: p.refs });
    if (!base) return null;
    return sub(this.rayOnPlane(e, base, n), base);
  }

  dimText(type, value, axis) {
    const pre = axis ? `Δ${axis.toUpperCase()} ` : type === 'distance' ? '↔ ' : type === 'radius' ? 'R' : type === 'diameter' ? 'Ø' : '';
    return pre + (typeof value === 'string' ? `${value} = ${fmt(this.ev(value))}` : fmt(value)) + (type === 'angle' ? '°' : '');
  }

  redraw() {
    if (!this.active) return;
    const g = this.group;
    for (const o of [...g.children]) { g.remove(o); o.traverse((x) => { x.geometry?.dispose(); x.material?.dispose?.(); }); }
    const f = this.f, w = this.vp.worldPerPixel();
    const fixed = new Set(f.rels.filter((r) => r.type === 'fix').map((r) => r.refs[0]));
    const picked = new Set(this.dimPicks.map((x) => x.id));
    const snapSeg = DRAW_TOOLS.has(this.tool) ? this.cand?.seg : null;
    const segCol = (id) => (this.sel.has(id) || picked.has(id) ? 0xf97316 : this.hover === id || snapSeg === id ? 0x0ea5e9 : this.dof === 0 ? sketchDefined() : sketchUnder());
    const lineMat = (color, extra = {}) => new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, ...extra });
    const polyline = (pts, color, dashed = false, order = 20, opacity = 1) => {
      const geo = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(...p)));
      const l = dashed
        ? new THREE.Line(geo, new THREE.LineDashedMaterial({ color, dashSize: 6 * w, gapSize: 4 * w, depthTest: false, transparent: true, opacity }))
        : new THREE.Line(geo, lineMat(color, { opacity }));
      if (dashed) l.computeLineDistances();
      l.renderOrder = order;
      g.add(l);
    };
    // lines, arcs and circles (construction: dashed)
    for (const s of f.segs) {
      const pts = this.entPts(s);
      const col = s.link && !this.sel.has(s.id) && this.hover !== s.id && !picked.has(s.id) ? LINKED : segCol(s.id);
      if (pts.length > 1) polyline(pts, col, !!s.construction);
    }
    // curvature combs on the splines (Show curvature): a tooth along the normal, as long as the curvature
    if (this.showComb) {
      const combs = [];
      for (const s of f.segs) {
        if (s.type !== 'spline' || (this.combSel && this.sel.size && !this.sel.has(s.id))) continue;
        for (const q of splineGeom(f, s).pieces) for (let k = 0; k <= 24; k++) combs.push(bezierCurvature(q, k / 24));
      }
      const kmax = Math.max(1e-12, ...combs.map((c) => c.k));
      const scale = (60 * w) / kmax; // (the longest tooth: 60 pixels)
      const tips = combs.map((c) => addv(c.p, mulv(c.n, c.k * scale)));
      for (let i = 0; i < combs.length; i++) if (combs[i].k > 1e-12) polyline([combs[i].p, tips[i]], 0xa855f7, false, 19, 0.7);
      if (tips.length > 1) polyline(tips, 0xa855f7, false, 19, 0.9);
    }
    // the spline being drawn, and the tangent arc that would be made
    if (this.spl && this.cand) {
      const P = [...this.spl.ids.map((id) => V(getPt(f, id))), this.cand.p];
      const pieces = splineBeziers(P);
      if (pieces.length) polyline(pieces.flatMap((q, i) => Array.from({ length: 17 - (i < pieces.length - 1 ? 1 : 0) }, (_, k) => { const t = k / 16, u = 1 - t; return [0, 1, 2].map((j) => u * u * u * q[0][j] + 3 * u * u * t * q[1][j] + 3 * u * t * t * q[2][j] + t * t * t * q[3][j]); })), 0xf59e0b, false, 22);
    }
    if (this.tool === 'tarc' && this.tarc) {
      const S = V(getPt(f, this.tarc.pid));
      polyline([S, addv(S, mulv(this.tarc.t, w * 40))], 0x16a34a, true, 22);
      const g = this.cand && this.tangentArcTo(this.cand.p);
      if (g) polyline(Array.from({ length: 49 }, (_, i) => g.at(i / 48)), 0xf59e0b, false, 22);
    }
    // points (centres of arcs and circles smaller, as crosses would be)
    const byCol = new Map();
    const centres = new Set(f.segs.filter((s) => !isLine(s)).map((s) => s.c));
    for (const p of f.pts) {
      const c = this.sel.has(p.id) || picked.has(p.id) ? 0xf97316 : this.hover === p.id ? 0x0ea5e9 : fixed.has(p.id) || this.dof === 0 ? sketchDefined() : sketchUnder();
      const key = c + (centres.has(p.id) ? ':c' : '');
      if (!byCol.has(key)) byCol.set(key, { c, size: centres.has(p.id) ? 5 : 7, list: [] });
      byCol.get(key).list.push(new THREE.Vector3(p.x, p.y, p.z));
    }
    for (const { c, size, list } of byCol.values()) {
      const pts = new THREE.Points(new THREE.BufferGeometry().setFromPoints(list), new THREE.PointsMaterial({ color: c, size, sizeAttenuation: false, depthTest: false }));
      pts.renderOrder = 21;
      g.add(pts);
    }
    // the drawing plane through the anchor (a chosen plane: where the anchor meets it) and the space handle
    this.handle = null;
    const drawing = DRAW_TOOLS.has(this.tool);
    if (drawing || this.drag) {
      const pl = this.draw ? { ...this.curPlane(), n: this.draw.n } : this.curPlane();
      let Aa = this.anchor();
      if (this.custom && !this.draw) { const k = dot(Aa, pl.n) - this.custom.d; Aa = Aa.map((x, i) => x - k * pl.n[i]); }
      const A = new THREE.Vector3(...Aa), size = w * 140;
      const nn = new THREE.Vector3(...pl.n).normalize();
      const U = new THREE.Vector3(...perp(pl.n)), W = nn.clone().cross(U);
      if (!this.draw || !this.custom) { const P0 = this.custom || PLANES[this.plane]; if (Math.abs(dot(P0.n, pl.n)) > 0.999) { U.set(...P0.u); W.set(...P0.v); } }
      const pos = [];
      const nDiv = 8;
      for (let i = -nDiv; i <= nDiv; i++) {
        const t = (i / nDiv) * size;
        for (const [a, b] of [[U, W], [W, U]]) {
          const p1 = A.clone().addScaledVector(a, t).addScaledVector(b, -size), p2 = A.clone().addScaledVector(a, t).addScaledVector(b, size);
          pos.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
        }
      }
      const grid = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)), lineMat(pl.color, { opacity: 0.18 }));
      grid.renderOrder = 18;
      g.add(grid);
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2 * size, 2 * size), new THREE.MeshBasicMaterial({ color: pl.color, transparent: true, opacity: 0.05, depthTest: false, side: THREE.DoubleSide, depthWrite: false }));
      quad.position.copy(A);
      quad.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), nn);
      quad.renderOrder = 17;
      g.add(quad);
      // space handle: X / Y / Z from the last point (the active plane's two bright)
      const H = new THREE.Vector3(...this.anchor());
      this.handle = [];
      for (const [k, a] of Object.entries(AXES)) {
        const d = new THREE.Vector3(...a).multiplyScalar(size * 0.55);
        const inPlane = Math.abs(dot(a, pl.n)) < 0.5;
        const ax = new THREE.Line(new THREE.BufferGeometry().setFromPoints([H.clone().sub(d.clone().multiplyScalar(0.25)), H.clone().add(d)]), lineMat(AXIS_COLOR[k], { opacity: inPlane || !this.custom ? 0.9 : 0.35 }));
        ax.renderOrder = 19;
        g.add(ax);
        this.handle.push({ k, at: H.clone().add(d).toArray() });
      }
    }
    // what is being drawn, and the point a click would make
    let tip = null;
    if (this.cand && drawing) {
      const c = this.cand.p;
      const shape = this.draw ? this.shapePreview(c) : null;
      if (shape) {
        for (const pts of shape.lines) polyline(pts, 0xf59e0b, false, 22);
        for (const pts of shape.guides || []) polyline(pts, 0xf59e0b, true, 22, 0.7);
        tip = `${this.planeLabel()}\n${shape.tip}`;
      } else if (this.chain && this.tool !== 'point') {
        const a = this.anchor();
        const col = this.cand.axis ? AXIS_COLOR[this.cand.axis] : 0xf59e0b;
        if (this.cand.axis) {
          // the inference line along the axis, both ways
          const ad = AXES[this.cand.axis].map((x) => x * w * 2000);
          const inf = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...sub(a, ad)), new THREE.Vector3(...a.map((x, i) => x + ad[i]))]), new THREE.LineDashedMaterial({ color: col, dashSize: 3 * w, gapSize: 3 * w, depthTest: false, transparent: true, opacity: 0.6 }));
          inf.computeLineDistances();
          inf.renderOrder = 22;
          g.add(inf);
        }
        polyline([a, c], col, false, 22);
        const d = sub(c, a);
        tip = `${this.planeLabel()}\n${fmt(len(d))} mm${this.cand.axis ? ' · Along ' + this.cand.axis : ''}\nΔ ${fmt(d[0])}, ${fmt(d[1])}, ${fmt(d[2])}`;
      } else tip = `${this.planeLabel()}\n${fmt(c[0])}, ${fmt(c[1])}, ${fmt(c[2])}`;
      if (this.cand.why !== 'plane' && this.cand.why !== 'axis') tip = ({ point: 'On point (coincident)', midpoint: 'Midpoint', online: 'On the line', vertex: 'Model vertex (fixed)', origin: 'Origin (fixed)' }[this.cand.why]) + '\n' + tip;
      const m = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...c)]), new THREE.PointsMaterial({ color: this.cand.why === 'plane' || this.cand.why === 'axis' ? 0xf59e0b : this.cand.why === 'midpoint' ? 0x16a34a : 0x0ea5e9, size: this.cand.why === 'midpoint' ? 12 : 10, sizeAttenuation: false, depthTest: false }));
      m.renderOrder = 23;
      g.add(m);
    }
    if (this.tool === 'sfillet' && this.hover) tip = this.blendFirst?.kind === 'fillet' ? 'Round this corner (equal to the first fillet)' : `Round this corner (R ${fmt(this.filletR)} mm)`;
    if (this.tool === 'schamfer' && this.hover) tip = this.blendFirst?.kind === 'chamfer' ? 'Chamfer this corner (equal to the first chamfer)' : `Chamfer this corner (${fmt(this.chamferD)} mm)`;
    if (this.tool === 'trim' && this.hover) tip = 'Trim this piece';
    if (this.tool === 'tarc' && this.tarc && this.cand) { const g = this.tangentArcTo(this.cand.p); tip = g ? `R ${fmt(g.R)} mm · ${fmt((g.th * 180) / Math.PI)}°` : 'Straight ahead'; }
    if (this.tool === 'spline' && this.spl) tip = `${this.planeLabel()}\nSpline: ${this.spl.ids.length + 1} points · double-click or Enter ends`;
    if (this.tool === 'convert') tip = null;
    // dimensions placed off what they measure: their extension and dimension lines (or leader)
    const dimCol = document.documentElement.dataset.theme === 'dark' ? 0x93a4c8 : 0x5b6f9c;
    for (const r of f.rels) {
      if (!REL3D[r.type]?.dim || r.hidden || !r.off) continue;
      for (const l of this.dimGeom(r.type, r.refs, r.axis, r.off)?.lines || []) polyline(l, dimCol, false, 21);
    }
    if (this.dimPending) for (const l of this.dimGeom(this.dimPending.type, this.dimPending.refs, this.dimPending.axis, this.dimPending.off)?.lines || []) polyline(l, 0xf97316, false, 24);
    // a dimension being placed
    if (this.dimPending) {
      const p = this.dimPending, lin = p.type === 'length' || p.type === 'distance';
      tip = `${lin ? `Tab: ${p.axis === 'z' ? 'true length' : 'along ' + ({ null: 'X', x: 'Y', y: 'Z' }[p.axis])}\n` : ''}Click to place`;
    }
    this.tip = tip;
    this.buildLabels();
    this.placeLabels();
  }

  // the circle / arc / polygon being drawn, with the mouse at c: { lines: [[pts]], guides, tip }
  shapePreview(c) {
    const d = this.draw, n = unit(d.n), P0 = d.picks[0].p;
    const ring = (C, u, nn, th, k = 64) => Array.from({ length: k + 1 }, (_, i) => addv(C, rot(u, nn, (th * i) / k)));
    if (d.tool === 'circle' || d.tool === 'polygon') {
      const Q = this.onShapePlane(c, P0, n), u = sub(Q, P0), r = len(u);
      if (r < 1e-9) return null;
      if (d.tool === 'circle') return { lines: [ring(P0, u, n, TAU)], guides: [[P0, Q]], tip: `Ø ${fmt(2 * r)} mm (R ${fmt(r)})` };
      const k = Math.max(3, Math.min(64, this.polySides | 0));
      return { lines: [ring(P0, u, n, TAU, k)], guides: [ring(P0, u, n, TAU), [P0, Q]], tip: `${k} sides · ${fmt(r)} mm to a corner · side ${fmt(2 * r * Math.sin(Math.PI / k))} mm` };
    }
    if (d.tool === 'arc') {
      if (d.picks.length === 1) { const Q = this.onShapePlane(c, P0, n); return { lines: [], guides: [[P0, Q]], tip: `R ${fmt(len(sub(Q, P0)))} mm` }; }
      const u = sub(this.onShapePlane(d.picks[1].p, P0, n), P0);
      let ang = this.angleOf(c, P0, u, n);
      if (d.sweep < 0 && ang > 0) ang -= TAU;
      if (d.sweep > 0 && ang < 0) ang += TAU;
      return { lines: [ring(P0, u, n, ang)], guides: [[P0, addv(P0, u)]], tip: `R ${fmt(len(u))} mm · ${fmt(Math.abs((ang * 180) / Math.PI))}°` };
    }
    if (d.tool === 'arc3') {
      if (d.picks.length === 1) return { lines: [[P0, c]], tip: `Chord ${fmt(len(sub(c, P0)))} mm` };
      const A = P0, B = d.picks[1].p, M = c;
      const nn = cross(sub(M, A), sub(B, M));
      if (len(nn) < 1e-9) return { lines: [[A, B]], tip: 'In line' };
      const ab = sub(B, A), am = sub(M, A), abxam = cross(ab, am);
      const C = addv(A, mulv(addv(mulv(cross(abxam, ab), dot(am, am)), mulv(cross(am, abxam), dot(ab, ab))), 1 / (2 * dot(abxam, abxam))));
      const nu = unit(nn), u = sub(A, C);
      let th = Math.atan2(dot(nu, cross(u, sub(B, C))), dot(u, sub(B, C)));
      if (th <= 0) th += TAU;
      return { lines: [ring(C, u, nu, th)], tip: `R ${fmt(len(u))} mm` };
    }
    return null;
  }

  // relation glyphs, dimension values and the space handle's X / Y / Z: HTML labels kept at their 3D places
  buildLabels() {
    for (const l of this.labels) l.el.remove();
    this.labels = [];
    const f = this.f;
    const perRef = new Map();
    for (const r of f.rels) {
      const info = REL3D[r.type];
      if (!info || r.hidden) continue;
      const placed = info.dim && r.off ? this.dimGeom(r.type, r.refs, r.axis, r.off)?.at : null;
      const at = placed || this.relAnchor(r);
      if (!at) continue;
      const el = document.createElement('div');
      if (info.dim) {
        el.className = 's3-dim';
        el.textContent = this.dimText(r.type, r.value, r.axis);
        el.title = `${r.axis ? `${info.label} along ${r.axis.toUpperCase()}` : info.label} — double-click to change`;
        el.addEventListener('pointerdown', (e) => e.stopPropagation());
        el.addEventListener('dblclick', (e) => { e.stopPropagation(); this.editDim(r.id); });
        el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.app.ui.showContext(e.clientX, e.clientY, [{ label: 'Change Value…', icon: 'edit', action: () => this.editDim(r.id) }, { label: 'Delete Dimension', icon: 'trash', action: () => this.deleteRelation(r.id) }]); });
      } else {
        el.className = 's3-rel';
        el.textContent = info.glyph;
        el.title = `${info.label}${r.type === 'onPlane' && r.value?.name ? ' (' + r.value.name + ')' : ''} — right-click to delete`;
        el.addEventListener('pointerdown', (e) => e.stopPropagation());
        el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.app.ui.showContext(e.clientX, e.clientY, [{ label: `Delete ${info.label}`, icon: 'trash', action: () => this.deleteRelation(r.id) }]); });
      }
      const k = r.refs.find((x) => getSeg(f, x)) || r.refs[0];
      const n = perRef.get(k) || 0;
      perRef.set(k, n + 1);
      this.vp.labelsEl.appendChild(el);
      this.labels.push({ el, at, off: placed ? [0, 0] : info.dim ? [0, -12 - 16 * n] : [10 + 22 * n, 8] });
    }
    // the dimension being placed: its value where it will go
    const p = this.dimPending;
    if (p) {
      const at = this.dimGeom(p.type, p.refs, p.axis, p.off)?.at || this.relAnchor({ type: p.type, refs: p.refs });
      if (at) {
        const el = document.createElement('div');
        el.className = 's3-dim s3-dim-pending';
        el.dataset.dimPending = p.type;
        el.textContent = this.dimText(p.type, Math.abs(this.currentValue(p.type, p.refs, p.axis)), p.axis);
        el.style.pointerEvents = 'none';
        this.vp.labelsEl.appendChild(el);
        this.labels.push({ el, at, off: [0, 0] });
      }
    }
    for (const h of this.handle || []) {
      const el = document.createElement('div');
      el.className = 's3-axis';
      el.textContent = h.k;
      el.style.color = AXIS_CSS[h.k];
      this.vp.labelsEl.appendChild(el);
      this.labels.push({ el, at: h.at, off: [6, -6] });
    }
  }

  placeLabels() {
    if (!this.active) return;
    // (the drawing plane's grid keeps its size on screen while zooming)
    const w = this.vp.worldPerPixel();
    if (this._wpp && Math.abs(w / this._wpp - 1) > 0.15) { this._wpp = w; this.redraw(); return; }
    this._wpp = w;
    for (const l of this.labels) {
      const s = this.screen(l.at);
      l.el.style.left = s.x + l.off[0] + 'px';
      l.el.style.top = s.y + l.off[1] + 'px';
    }
    if (this.tip && this.lastEv) {
      const m = this.vp.screenPos(this.lastEv);
      this.tipEl.hidden = false;
      this.tipEl.textContent = this.tip;
      this.tipEl.style.left = m.x + 16 + 'px';
      this.tipEl.style.top = m.y + 18 + 'px';
    } else this.tipEl.hidden = true;
  }

  // ---------------------------------------------------------------- Property panel
  renderPM(root, ui) {
    const f = this.f, el = ui.el, esc = ui.esc;
    root.appendChild(el('div', { class: 'pm-head' }, `<span class="ti">${ui.icon('sketch3d')}</span><span>${esc(f.name)}</span>`));
    const act = el('div', { class: 'pm-actions' });
    act.appendChild(el('button', { title: 'Keep the 3D sketch (Enter)', onclick: () => this.app.exitSketch3D(true) }, ui.icon('ok')));
    act.appendChild(el('button', { title: 'Discard the changes', onclick: () => this.app.exitSketch3D(false) }, ui.icon('cancel')));
    root.appendChild(act);
    const st = !this.solveOk ? ['err', 'The relations and dimensions conflict: delete one of them.'] : this.dof === 0 ? ['ok', 'Fully defined'] : this.dof ? ['', `Under defined — ${this.dof} degree${this.dof === 1 ? '' : 's'} of freedom`] : ['', ''];
    if (f.pts.length) root.appendChild(el('div', { class: 'pm-msg ' + st[0] }, st[1]));
    root.appendChild(el('div', { class: 'pm-hint s3-toolnote' }, `Tool: <b>${TOOL_NAMES[this.tool]}</b>. The 3D sketch tools are on the <b>Sketch</b> tab (Line, Centerline, Circle, arcs, Polygon, Point, Sketch Fillet, Dimension); the greyed ones are 2D only.`));

    // the active tool's settings
    if (this.tool === 'sfillet' || this.tool === 'schamfer' || this.tool === 'polygon') {
      const gt = ui.pmGroup(root, TOOL_NAMES[this.tool], 's3:toolset');
      if (this.tool === 'sfillet') {
        gt.appendChild(el('label', { class: 'pm-label' }, 'Fillet radius'));
        gt.appendChild(ui.exprInput(this.filletR, 'mm', (v) => { const x = this.ev(v); if (x > 0) this.filletR = x; }, { min: 0 }));
        gt.appendChild(el('div', { class: 'pm-hint' }, 'Click corners where two lines meet: each becomes a tangent arc. The first gets a radius dimension; the next ones are made <b>equal</b> to it (Equal Radius) until you leave the tool. The sharp corners stay as points.'));
      } else if (this.tool === 'schamfer') {
        gt.appendChild(el('label', { class: 'pm-label' }, 'Chamfer distance (along both lines)'));
        gt.appendChild(ui.exprInput(this.chamferD, 'mm', (v) => { const x = this.ev(v); if (x > 0) this.chamferD = x; }, { min: 0 }));
        gt.appendChild(el('div', { class: 'pm-hint' }, 'Click corners where two lines meet: each is cut by a line this far along both. The first gets distance dimensions; the next ones are made <b>equal</b> to it (Equal Distance) until you leave the tool.'));
      } else {
        gt.appendChild(el('label', { class: 'pm-label' }, 'Number of sides'));
        gt.appendChild(ui.exprInput(this.polySides, '', (v) => { const x = Math.round(this.ev(v)); if (x >= 3 && x <= 64) { this.polySides = x; this.redraw(); } }, { min: 3 }));
        gt.appendChild(el('div', { class: 'pm-hint' }, 'Click the centre, then a corner. The polygon lies on the drawing plane and stays regular.'));
      }
    }

    // the selection first: its coordinates, relations to add, the ones there
    const ids = [...this.sel].filter((id) => kindOf(f, id));
    if (ids.length) {
      const gs = ui.pmGroup(root, `Selected (${ids.length})`, 's3:sel');
      const NAMES = { pt: 'Point', seg: 'Line', arc: 'Arc', circle: 'Circle', spline: 'Spline' };
      const name = (id) => (getSeg(f, id)?.construction ? 'Construction ' : '') + NAMES[kindOf(f, id)] + ' ' + id.replace(/^\D+/, '');
      gs.appendChild(el('div', { class: 'pm-hint' }, esc(ids.map(name).join(', '))));
      const only = ids.length === 1 ? kindOf(f, ids[0]) : null;
      if (only === 'pt') {
        // the point's coordinates (in the user's axes, wcs.js): type to move it
        const p = getPt(f, ids[0]), shown = W.toUser(V(p));
        const row = el('div', { class: 's3-xyz s3-coords' });
        const inputs = ['X', 'Y', 'Z'].map((a, i) => {
          const wrap = el('label', { class: 's3-coord' }, `<span>${a}</span>`);
          const inp = el('input', { type: 'text', spellcheck: 'false' });
          inp.value = fmt(shown[i]);
          wrap.appendChild(inp);
          row.appendChild(wrap);
          return inp;
        });
        const apply = () => {
          const u = inputs.map((i) => this.ev(i.value.trim() || '0'));
          if (!u.every(Number.isFinite)) { inputs.forEach((i, k) => i.classList.toggle('bad', !Number.isFinite(u[k]))); return; }
          const v = W.fromUser(u);
          if (v.some((x, i) => Math.abs(x - V(p)[i]) > 1e-9)) this.movePoint(p.id, v);
        };
        inputs.forEach((i) => { i.addEventListener('change', apply); i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); apply(); } }); });
        gs.appendChild(row);
      }
      if (only === 'seg') {
        const [A, B] = this.segEnds(getSeg(f, ids[0])), d = sub(B, A);
        gs.appendChild(el('div', { class: 's3-props' }, `Length <b>${fmt(len(d))}</b> mm<br>ΔX ${fmt(d[0])} · ΔY ${fmt(d[1])} · ΔZ ${fmt(d[2])}<br><span class="pm-hint">From (${A.map(fmt).join(', ')}) to (${B.map(fmt).join(', ')})</span>`));
      }
      if (only === 'arc') {
        const g = arcGeom(f, getSeg(f, ids[0]));
        gs.appendChild(el('div', { class: 's3-props' }, `Radius <b>${fmt(g.R)}</b> mm · ${fmt((g.th * 180) / Math.PI)}°<br>Arc length ${fmt(g.R * g.th)} mm<br><span class="pm-hint">Centre (${g.C.map(fmt).join(', ')})</span>`));
      }
      if (only === 'spline') {
        const s = getSeg(f, ids[0]), q = this.entPts(s, 240);
        const L = q.slice(1).reduce((t, p, i) => t + len(sub(p, q[i])), 0);
        gs.appendChild(el('div', { class: 's3-props' }, `Spline through <b>${s.pts.length}</b> points${s.closed ? ' (closed)' : ''}<br>Length ${fmt(L)} mm<br><span class="pm-hint">Drag its points to shape it; Tangent with a line at an end makes it leave the line smoothly.</span>`));
        // its shape: tangent-smooth (each point's tangent from its neighbours) or curvature-continuous (C2)
        const shape = el('select');
        for (const [v, l] of [['c1', 'Tangent-smooth (C1)'], ['c2', 'Curvature-continuous (C2)']]) { const o = el('option', { value: v }, l); if ((s.smooth || 'c1') === v) o.selected = true; shape.appendChild(o); }
        shape.onchange = () => { if (shape.value === 'c2') s.smooth = 'c2'; else delete s.smooth; this.changed(); };
        gs.appendChild(el('label', { class: 'pm-label' }, 'Shape'));
        gs.appendChild(shape);
        if (!s.closed) {
          const wrow = el('div', { class: 's3-xyz' });
          for (const [k, lab] of [['w0', 'Start weight'], ['w1', 'End weight']]) {
            const wrap = el('label', { class: 's3-coord' }, `<span>${lab}</span>`);
            const inp = el('input', { type: 'text', spellcheck: 'false' });
            inp.value = String(s[k] ?? 1);
            inp.addEventListener('change', () => { const v = Number(inp.value); if (v > 0 && v <= 10) { if (v === 1) delete s[k]; else s[k] = v; this.changed(); } else inp.classList.add('bad'); });
            inp.addEventListener('keydown', (e) => e.stopPropagation());
            wrap.appendChild(inp);
            wrow.appendChild(wrap);
          }
          gs.appendChild(wrow);
          gs.appendChild(el('div', { class: 'pm-hint' }, 'How strongly the end tangents pull (1: as they are; more: the spline leaves its ends straighter). C2 keeps the curvature running on smoothly through every point.'));
        }
      }
      if (ids.some((id) => getSeg(f, id)?.link)) {
        gs.appendChild(el('div', { class: 'pm-hint' }, 'Converted from the model (purple): it follows the edge when the model changes.'));
        const ub = el('button', { class: 'pm-btn' }, 'Unlink from the Model');
        ub.onclick = () => this.unlinkSelected();
        gs.appendChild(ub);
      }
      if (only === 'circle') {
        const s = getSeg(f, ids[0]), C = V(getPt(f, s.c));
        gs.appendChild(el('div', { class: 's3-props' }, `Diameter <b>${fmt(2 * s.r)}</b> mm<br><span class="pm-hint">Centre (${C.map(fmt).join(', ')})</span>`));
      }
      const can = applicableRelations(f, ids);
      if (can.length) {
        gs.appendChild(el('div', { class: 'pm-label' }, 'Add Relations'));
        const bar = el('div', { class: 's3-rels' });
        for (const [type, refs] of can) {
          const label = type === 'merge' ? 'Merge (Coincident)' : REL3D[type].label;
          const b = el('button', { class: 'pm-btn' }, esc(label));
          b.onclick = () => this.addRelation(type, refs);
          bar.appendChild(b);
        }
        gs.appendChild(bar);
      }
      const segIds = ids.filter((id) => getSeg(f, id));
      if (segIds.length) {
        const allC = segIds.every((id) => getSeg(f, id).construction);
        const cb = el('button', { class: 'pm-btn' }, allC ? 'Make Geometry (not construction)' : 'Make Construction');
        cb.onclick = () => this.setConstruction(!allC);
        gs.appendChild(cb);
      }
      const on = f.rels.filter((r) => r.refs.some((x) => ids.includes(x)));
      if (on.length) {
        gs.appendChild(el('div', { class: 'pm-label' }, 'Existing Relations'));
        const ul = el('div', { class: 'pm-list' });
        for (const r of on) {
          const info = REL3D[r.type];
          const li = el('div', { class: 'li' }, `<span>${esc(info?.label || r.type)}${r.axis ? ' along ' + r.axis.toUpperCase() : ''}${info?.dim ? ' ' + esc(fmt(this.ev(r.value))) + (r.type === 'angle' ? '°' : ' mm') : ''}</span>`);
          const x = el('button', { class: 'li-x', title: 'Delete' }, '×');
          x.onclick = (e) => { e.stopPropagation(); this.deleteRelation(r.id); };
          li.appendChild(x);
          if (info?.dim) li.ondblclick = () => this.editDim(r.id);
          ul.appendChild(li);
        }
        gs.appendChild(ul);
      }
      const del = el('button', { class: 'pm-btn' }, 'Delete Selected (Del)');
      del.onclick = () => this.deleteSelected();
      gs.appendChild(del);

      // move / copy / rotate what is selected
      const gm = ui.pmGroup(root, 'Move / Copy / Rotate', 's3:move');
      gm.appendChild(el('div', { class: 'pm-label' }, 'Move by (ΔX, ΔY, ΔZ)'));
      const mrow = el('div', { class: 's3-xyz s3-coords' });
      const dIn = ['ΔX', 'ΔY', 'ΔZ'].map((a) => { const w = el('label', { class: 's3-coord' }, `<span>${a}</span>`); const i = el('input', { type: 'text', spellcheck: 'false' }); i.value = '0'; w.appendChild(i); mrow.appendChild(w); return i; });
      gm.appendChild(mrow);
      const mb = el('div', { class: 's3-rels' });
      const dval = () => { const v = dIn.map((i) => this.ev(i.value.trim() || '0')); return v.every(Number.isFinite) ? v : null; };
      for (const [label, copy] of [['Move', false], ['Copy', true]]) {
        const b = el('button', { class: 'pm-btn' }, label);
        b.onclick = () => { const v = dval(); if (v && v.some((x) => x !== 0)) this.moveBy(v, copy); };
        mb.appendChild(b);
      }
      gm.appendChild(mb);
      gm.appendChild(el('div', { class: 'pm-label' }, 'Rotate about the selection\'s centre'));
      const rrow = el('div', { class: 's3-xyz s3-rot' });
      const axSel = el('select');
      for (const [v, l] of [['X', 'about X'], ['Y', 'about Y'], ['Z', 'about Z'], ['N', 'about the drawing plane\'s normal']]) axSel.appendChild(el('option', { value: v }, l));
      axSel.value = this._rotAxis || 'Z';
      axSel.onchange = () => { this._rotAxis = axSel.value; };
      const angIn = el('input', { type: 'text', spellcheck: 'false' });
      angIn.value = this._rotAng ?? '90';
      angIn.onchange = () => { this._rotAng = angIn.value; };
      rrow.append(axSel, angIn, el('span', { class: 'unit' }, '°'));
      gm.appendChild(rrow);
      const rb = el('div', { class: 's3-rels' });
      for (const [label, copy] of [['Rotate', false], ['Copy Rotated', true]]) {
        const b = el('button', { class: 'pm-btn' }, label);
        b.onclick = () => { const a = this.ev(angIn.value.trim()); if (Number.isFinite(a) && a) this.rotateBy(axSel.value === 'N' ? null : axSel.value, a, copy); };
        rb.appendChild(b);
      }
      gm.appendChild(rb);
      gm.appendChild(el('div', { class: 'pm-hint' }, 'Or drag a selected line, arc or circle to move the selection (it snaps along X, Y and Z). A copy keeps the relations among the copied geometry; a rotation turns Along X/Y/Z relations with it.'));
    }

    const gp = ui.pmGroup(root, 'Drawing Plane', 's3:plane');
    const pr = el('div', { class: 's3-planes' });
    for (const k of Object.keys(PLANES)) {
      const b = el('button', { class: 's3-plane' + (!this.custom && this.plane === k ? ' active' : ''), title: PLANES[k].name }, k);
      b.style.borderBottomColor = '#' + PLANES[k].color.toString(16).padStart(6, '0');
      b.onclick = () => this.setPlane(k);
      pr.appendChild(b);
    }
    gp.appendChild(pr);
    if (this.custom) gp.appendChild(el('div', { class: 'pm-msg' }, `Drawing on <b>${esc(this.custom.name)}</b> (points get On Plane). Tab or Esc: back to XY / YZ / ZX.`));
    gp.appendChild(el('div', { class: 'pm-hint' }, 'Points snap to other points, to the <b>midpoints</b> of lines and arcs and <b>onto lines</b>. Lines snap along <b>X, Y or Z</b> from the last point in any view (Ctrl or Shift: free). Elsewhere they follow the drawing plane through the last point: <b>Tab</b> switches XY → YZ → ZX. Circles, arcs and polygons lie on the drawing plane. <b>Ctrl+click</b> a plane or flat face (or click a plane in the tree) to draw on it. Rotate the view with the middle mouse button.'));

    const ge = ui.pmGroup(root, this.chain ? 'Next Point (from the last point)' : 'Point at', 's3:exact');
    const row = el('div', { class: 's3-xyz' });
    const inputs = ['X', 'Y', 'Z'].map((a) => {
      const i = el('input', { type: 'text', placeholder: (this.chain ? 'Δ' : '') + a, spellcheck: 'false' });
      i.value = '0';
      row.appendChild(i);
      return i;
    });
    const go = el('button', { class: 'pm-btn', title: 'Add the point (Enter)' }, 'Add');
    const addTyped = () => {
      const u = inputs.map((i) => this.ev(i.value.trim() || '0'));
      if (!u.every(Number.isFinite)) { inputs.forEach((i, k) => i.classList.toggle('bad', !Number.isFinite(u[k]))); return; }
      // (typed in the user's axes, wcs.js)
      this.typedPoint(...W.fromUser(u));
    };
    go.onclick = addTyped;
    inputs.forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); addTyped(); } }));
    row.appendChild(go);
    ge.appendChild(row);
    ge.appendChild(el('div', { class: 'pm-hint' }, this.chain ? 'How far the next point is from the last one, e.g. 0, 0, 250 runs 250 mm along Z (Along Z is added).' : 'Type a point to start a line at (or click in the view).'));

    const gc = ui.pmGroup(root, 'Curve', 's3:curve');
    const sel = el('select');
    for (const [v, l] of [['lines', 'Straight runs (a route)'], ['spline', 'A smooth spline through the points']]) {
      const o = el('option', { value: v }, l);
      if ((f.kind || 'lines') === v) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => { f.kind = sel.value; this.changed(); };
    gc.appendChild(el('label', { class: 'pm-label' }, 'Join the points of runs of lines with'));
    gc.appendChild(sel);
    if ((f.kind || 'lines') !== 'spline') {
      gc.appendChild(el('label', { class: 'pm-label' }, 'Bend radius at every corner of runs of lines'));
      gc.appendChild(ui.exprInput(f.radius ?? 0, 'mm', (v) => { f.radius = v; this.changed(); }, { min: 0 }));
    }
    if (f.segs.some((s) => s.type === 'spline')) {
      const lab = el('label', { class: 'pm-check', style: 'display:flex;align-items:center;gap:6px;margin-top:6px' });
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!this.showComb;
      cb.onchange = () => { this.showComb = cb.checked; this.redraw(); };
      lab.append(cb, document.createTextNode('Show curvature (combs on the splines; the selected ones when some are)'));
      gc.appendChild(lab);
      this.combSel = true;
    }
    const count = (pred) => f.segs.filter(pred).length;
    const nl = count((s) => isLine(s) && !s.construction), na = count((s) => s.type === 'arc' && !s.construction), nci = count((s) => s.type === 'circle' && !s.construction), nc = count((s) => s.construction);
    gc.appendChild(el('div', { class: 'pm-hint' }, `${f.pts.length} point${f.pts.length === 1 ? '' : 's'}, ${nl} line${nl === 1 ? '' : 's'}${na ? `, ${na} arc${na === 1 ? '' : 's'}` : ''}${nci ? `, ${nci} circle${nci === 1 ? '' : 's'}` : ''}${nc ? `, ${nc} construction` : ''}. Each connected run of lines and arcs is one curve (a sweep path, a pipe route, structural members…); runs with arcs keep their arcs (no extra bends).`));
  }

  // right-click in the view
  menuItems() {
    const items = [];
    if (this.chain) items.push({ label: 'End Line', icon: 'line', action: () => { this.chain = null; this.redraw(); } });
    items.push(
      { label: 'Select', icon: 'select', action: () => this.setTool('select') },
      { label: 'Line', icon: 'line', action: () => this.setTool('line') },
      { label: 'Circle', icon: 'circle', action: () => this.setTool('circle') },
      { label: 'Centerpoint Arc', icon: 'arc', action: () => this.setTool('arc') },
      { label: 'Tangent Arc', icon: 'tarc', action: () => this.setTool('tarc') },
      { label: 'Spline', icon: 'spline', action: () => this.setTool('spline') },
      { label: 'Project Edges', icon: 'convert', action: () => this.setTool('convert') },
      { label: 'Sketch Fillet', icon: 'sketchFillet', action: () => this.setTool('sfillet') },
      { label: 'Dimension', icon: 'smartdim', action: () => this.setTool('dim') },
      { label: `Drawing Plane: ${this.planeLabel()} (Tab for the next)`, icon: 'plane', action: () => this.nextPlane() },
      'sep',
      { label: 'Exit 3D Sketch', icon: 'ok', action: () => this.app.exitSketch3D(true) },
      { label: 'Discard Changes', icon: 'cancel', action: () => this.app.exitSketch3D(false) },
    );
    return items;
  }
}
