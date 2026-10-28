// Sketch data model: points, curves (line / circle / arc) and constraints.
// Includes geometry builders used by the drawing tools, profile extraction,
// curve intersections, trimming and migration from the older shape-based format.
import { evaluate, isNumeric } from './expr.js';

const TAU = Math.PI * 2;
const EPS = 1e-6;
export const ORIGIN = Object.freeze({ id: 'O', x: 0, y: 0 });

export function newSketchData() {
  return { points: [], curves: [], constraints: [], nextSid: 1 };
}

const nid = (sk, pfx) => pfx + sk.nextSid++;

export function maps(sk) {
  const P = new Map(sk.points.map((p) => [p.id, p]));
  P.set('O', ORIGIN);
  const C = new Map(sk.curves.map((c) => [c.id, c]));
  return { P, C };
}

export function getPoint(sk, id) {
  return id === 'O' ? ORIGIN : sk.points.find((p) => p.id === id);
}
export function getCurve(sk, id) {
  return sk.curves.find((c) => c.id === id);
}

// ------------------------------------------------------------ builders
export function addPoint(sk, x, y) {
  const id = nid(sk, 'p');
  sk.points.push({ id, x, y });
  return id;
}
export function addLine(sk, p1, p2, construction = false) {
  const id = nid(sk, 'c');
  sk.curves.push({ id, type: 'line', p1, p2, construction });
  return id;
}
export function addCircle(sk, c, r, construction = false) {
  const id = nid(sk, 'c');
  sk.curves.push({ id, type: 'circle', c, r, construction });
  return id;
}
// A spline through the points pts (ids, in order); closed: it runs on from the last back to the first.
// Its ends are p1 / p2 (the same point when closed), so it chains with lines and arcs like they do.
export function addSpline(sk, pts, closed = false, construction = false) {
  const id = nid(sk, 's');
  sk.curves.push({ id, type: 'spline', pts: [...pts], p1: pts[0], p2: closed ? pts[0] : pts[pts.length - 1], closed: !!closed, construction });
  return id;
}

// ------------------------------------------------------------ ellipses
// An ellipse: centre c, a point `a` on it at the end of its major axis (setting the major radius and the
// turn), the minor radius r2. An elliptical arc ('earc') also has ends p1, p2 on it, running
// counter-clockwise from p1 to p2.
export function addEllipse(sk, c, a, r2, construction = false) {
  const id = nid(sk, 'e');
  sk.curves.push({ id, type: 'ellipse', c, a, r2, construction });
  return id;
}
const isEll = (c) => c?.type === 'ellipse' || c?.type === 'earc';
export function ellipseGeom(sk, c) {
  const C = getPoint(sk, c.c), A = getPoint(sk, c.a);
  const ux = A.x - C.x, uy = A.y - C.y, ra = Math.hypot(ux, uy) || 1e-9;
  return { cx: C.x, cy: C.y, ra, rb: Math.abs(c.r2) || 1e-9, u: [ux / ra, uy / ra], v: [-uy / ra, ux / ra] };
}
export const ellipseAt = (g, t) => [g.cx + g.ra * Math.cos(t) * g.u[0] + g.rb * Math.sin(t) * g.v[0], g.cy + g.ra * Math.cos(t) * g.u[1] + g.rb * Math.sin(t) * g.v[1]];
export function ellipseParam(g, x, y) {
  const dx = x - g.cx, dy = y - g.cy;
  return Math.atan2((dx * g.v[0] + dy * g.v[1]) / g.rb, (dx * g.u[0] + dy * g.u[1]) / g.ra);
}
// an ellipse's parameter range: [t0, t0 + span] (a whole one: 0 … 2π)
function ellipseRange(sk, c) {
  const g = ellipseGeom(sk, c);
  if (c.type === 'ellipse') return { g, t0: 0, span: TAU };
  const P1 = getPoint(sk, c.p1), P2 = getPoint(sk, c.p2);
  const t0 = ellipseParam(g, P1.x, P1.y);
  let span = ellipseParam(g, P2.x, P2.y) - t0;
  while (span <= 1e-9) span += TAU;
  while (span > TAU) span -= TAU;
  return { g, t0, span };
}
// Bézier pieces of an ellipse between parameters (a quarter turn or less each: an affine image of the
// usual circle approximation, within about 1e-6 of the radius)
function ellipseBeziers(g, ta, tb) {
  const n = Math.max(1, Math.ceil(Math.abs(tb - ta) / (Math.PI / 8))), out = [];
  for (let i = 0; i < n; i++) {
    const a0 = ta + ((tb - ta) * i) / n, a1 = ta + ((tb - ta) * (i + 1)) / n, k = (4 / 3) * Math.tan((a1 - a0) / 4);
    const P = (t) => ellipseAt(g, t);
    const D = (t) => [-g.ra * Math.sin(t) * g.u[0] + g.rb * Math.cos(t) * g.v[0], -g.ra * Math.sin(t) * g.u[1] + g.rb * Math.cos(t) * g.v[1]];
    const p0 = P(a0), p1 = P(a1), d0 = D(a0), d1 = D(a1);
    out.push({ type: 'bezier', a: p0, c1: [p0[0] + k * d0[0], p0[1] + k * d0[1]], c2: [p1[0] - k * d1[0], p1[1] - k * d1[1]], b: p1 });
  }
  return out;
}

// ------------------------------------------------------------ more sketch tools
// The circle through three points: { cx, cy, r } or null (in a line).
export function circleThrough(a, b, m) {
  const d = 2 * (a[0] * (b[1] - m[1]) + b[0] * (m[1] - a[1]) + m[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const A = a[0] ** 2 + a[1] ** 2, B = b[0] ** 2 + b[1] ** 2, Mq = m[0] ** 2 + m[1] ** 2;
  const cx = (A * (b[1] - m[1]) + B * (m[1] - a[1]) + Mq * (a[1] - b[1])) / d, cy = (A * (m[0] - b[0]) + B * (a[0] - m[0]) + Mq * (b[0] - a[0])) / d;
  return { cx, cy, r: Math.hypot(a[0] - cx, a[1] - cy) };
}
// The direction a curve leaves point id along (out of the curve, at that end): for a tangent arc.
export function endTangent(sk, c, id) {
  if (c.type === 'line') {
    const a = getPoint(sk, c.p1), b = getPoint(sk, c.p2);
    const [from, to] = c.p2 === id ? [a, b] : [b, a];
    const l = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    return [(to.x - from.x) / l, (to.y - from.y) / l];
  }
  if (c.type === 'arc') {
    const C = getPoint(sk, c.c), P = getPoint(sk, id);
    const r = [P.x - C.x, P.y - C.y], l = Math.hypot(r[0], r[1]) || 1;
    // counter-clockwise from p1 to p2: at p2 it leaves turning left of the radius, at p1 the other way
    return c.p2 === id ? [-r[1] / l, r[0] / l] : [r[1] / l, -r[0] / l];
  }
  return null;
}
// Copies of items (curve / point ids) moved by M(x, y) → [x, y]; returns the new ids.
const ROT_KEEPS = new Set(['coincident', 'tangent', 'equal', 'equalLength', 'parallel', 'perpendicular', 'concentric', 'midpoint', 'midpointCoincident', 'onCurve', 'collinear', 'symmetric']);
const ROT_DIMS = new Set(['distance', 'radius', 'diameter', 'angle', 'pointLine', 'arcDist']);
export function copyItems(sk, ids, M, { rotates = false } = {}) {
  const map = new Map(), out = [];
  const mp = (id) => {
    if (!id) return id;
    if (map.has(id)) return map.get(id);
    const p = getPoint(sk, id);
    const [x, y] = M(p.x, p.y);
    const nid2 = addPoint(sk, x, y);
    if (p.keep) getPoint(sk, nid2).keep = true;
    map.set(id, nid2);
    return nid2;
  };
  for (const id of ids) {
    const c = getCurve(sk, id);
    if (!c) { if (sk.points.some((q) => q.id === id) && id !== 'O') { const q = mp(id); getPoint(sk, q).keep = true; out.push(q); } continue; }
    if (c.ctrlOf && ids.includes(c.ctrlOf)) continue;
    if (c.type === 'line') out.push(addLine(sk, mp(c.p1), mp(c.p2), c.construction));
    else if (c.type === 'circle') out.push(addCircle(sk, mp(c.c), c.r, c.construction));
    else if (c.type === 'arc') out.push(addArc(sk, mp(c.c), mp(c.p1), mp(c.p2), c.construction));
    else if (c.type === 'spline') out.push(c.ctrl ? addCtrlSpline(sk, c.pts.map(mp), c.degree, c.construction, c.closed, c.weights) : c.handles ? addFitSpline(sk, c.pts.map(mp), c.closed, c.construction, c.handles.map(mp)) : addSpline(sk, c.pts.map(mp), c.closed, c.construction));
    else if (c.type === 'ellipse' || c.type === 'earc') {
      const e = addEllipse(sk, mp(c.c), mp(c.a), c.r2, c.construction);
      if (c.type === 'earc') Object.assign(getCurve(sk, e), { type: 'earc', p1: mp(c.p1), p2: mp(c.p2) });
      out.push(e);
    }
    map.set(id, out[out.length - 1]);
  }
  // relations and dimensions among the copied entities come along
  for (const k of [...sk.constraints]) {
    if (k.type === 'fix' || k.type === 'projected' || k.type === 'offset' || k.type === 'offsetGeometry' || k.offsetGroup || k.type === 'sketchPattern' || k.driven) continue;
    if (rotates && !(k.type === 'dim' ? ROT_DIMS.has(k.kind) : ROT_KEEPS.has(k.type))) continue;
    if (!k.refs.every((r) => map.has(r))) continue;
    const { id: _id, refs, ...rest } = k;
    addRel(sk, k.type, refs.map((r) => map.get(r)), JSON.parse(JSON.stringify(rest)));
  }
  return out;
}

// A block: entities saved to be inserted again (in this or another sketch). blockData returns
// { points, curves, constraints } relative to their bounding-box centre; pasteItems puts a copy at (x, y)
// and returns the new curve ids.
export function blockData(sk, ids) {
  const curves = ids.map((id) => getCurve(sk, id)).filter(Boolean);
  const pids = new Set(curves.flatMap((c) => [c.p1, c.p2, c.c, c.a, ...(c.pts || []), ...(c.handles || [])].filter(Boolean)));
  for (const id of ids) if (!getCurve(sk, id) && sk.points.some((q) => q.id === id)) pids.add(id);
  if (!curves.length) return null;
  const P = [...pids].map((id) => ({ id: id === 'O' ? '__O' : id, ...(({ x, y, keep }) => ({ x, y, keep }))(getPoint(sk, id)) }));
  const xs = P.map((q) => q.x), ys = P.map((q) => q.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const fixO = (id) => (id === 'O' ? '__O' : id);
  const all = new Set([...curves.map((c) => c.id), ...P.map((q) => q.id)]);
  const cs = curves.map((c) => {
    const o = JSON.parse(JSON.stringify(c));
    for (const k of ['p1', 'p2', 'c', 'a']) if (o[k]) o[k] = fixO(o[k]);
    if (o.pts) o.pts = o.pts.map(fixO);
    if (o.handles) o.handles = o.handles.map(fixO);
    return o;
  });
  const ks = sk.constraints.filter((k) => k.type !== 'fix' && k.type !== 'block' && k.type !== 'projected' && k.type !== 'offset' && k.type !== 'offsetGeometry' && !k.offsetGroup && k.type !== 'sketchPattern' && !k.driven && k.refs.every((r) => all.has(fixO(r))))
    .map((k) => ({ ...JSON.parse(JSON.stringify(k)), refs: k.refs.map(fixO) }));
  return { points: P.map((q) => ({ ...q, x: +(q.x - cx).toFixed(6), y: +(q.y - cy).toFixed(6) })), curves: cs, constraints: ks };
}
export function pasteItems(sk, data, x, y, map = new Map()) {
  const out = [];
  for (const q of data.points) { const id = addPoint(sk, q.x + x, q.y + y); if (q.keep) getPoint(sk, id).keep = true; map.set(q.id, id); }
  for (const c of data.curves) {
    const o = JSON.parse(JSON.stringify(c));
    o.id = nid(sk, 'c');
    for (const k of ['p1', 'p2', 'c', 'a']) if (o[k]) o[k] = map.get(o[k]);
    if (o.pts) o.pts = o.pts.map((id) => map.get(id));
    if (o.handles) o.handles = o.handles.map((id) => map.get(id));
    map.set(c.id, o.id);
    sk.curves.push(o);
    out.push(o.id);
  }
  for (const id of out) {
    const c = getCurve(sk, id);
    if (c.ctrlOf) {
      if (map.has(c.ctrlOf)) c.ctrlOf = map.get(c.ctrlOf);
      else { delete c.ctrlOf; delete c.fitHandle; }
    }
  }
  for (const id of out) { const c = getCurve(sk, id); if (c.handles) syncFitHandles(sk, c); }
  for (const k of data.constraints || []) {
    if (!k.refs.every((r) => map.has(r))) continue;
    const { id: _id, refs, type, ...rest } = k;
    addRel(sk, type, refs.map((r) => map.get(r)), rest);
  }
  return out;
}
// Linked block instances. sk.blocks: [{ id, name, def (the block's data as inserted), map: { block id: sketch id },
// at: [x, y], angle }]: the block's geometry put at x, y turned angle°, held rigid by one 'block' relation (its first
// point A, the point farthest from it B, every other point at its place along and across AB; circle radii and ellipse
// minor radii kept), so the copy moves and turns as one. Relations to its points from outside it stay.
const turned = (data, angle) => {
  const a = (angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return { ...data, points: data.points.map((q) => ({ ...q, x: q.x * c - q.y * s, y: q.x * s + q.y * c })), curves: data.curves.map((cv) => (cv.rot != null ? { ...cv, rot: cv.rot + a } : cv)), constraints: [] };
};
export function insertBlockInstance(sk, block, x, y, angle = 0) {
  const map = new Map(), curves = pasteItems(sk, turned(block.data, angle), x, y, map);
  const pids = block.data.points.map((q) => map.get(q.id)).filter(Boolean);
  const id = nid(sk, 'b');
  if (pids.length) {
    const P = pids.map((pid) => getPoint(sk, pid)), A = P[0];
    let bi = 0, bd = 0;
    P.forEach((q, i) => { const d = Math.hypot(q.x - A.x, q.y - A.y); if (d > bd) { bd = d; bi = i; } });
    const refs = bi ? [pids[0], pids[bi], ...pids.filter((_, i) => i && i !== bi)] : [pids[0]];
    const loc = {};
    if (bi) {
      const B = P[bi], ex = (B.x - A.x) / bd, ey = (B.y - A.y) / bd;
      for (const pid of refs.slice(2)) { const q = getPoint(sk, pid), dx = q.x - A.x, dy = q.y - A.y; loc[pid] = [dx * ex + dy * ey, -dx * ey + dy * ex]; }
    }
    const radii = {}, minors = {};
    for (const cid of curves) { const c = getCurve(sk, cid); if (c.type === 'circle') radii[cid] = c.r; if (c.type === 'ellipse' || c.type === 'earc') minors[cid] = Math.abs(c.r2); }
    addRel(sk, 'block', refs, { block: id, d0: bd, loc, radii, minors });
  }
  (sk.blocks ||= []).push({ id, name: block.name, def: JSON.parse(JSON.stringify(block.data)), map: Object.fromEntries(map), at: [x, y], angle });
  return { id, curves };
}
// The block instance an entity belongs to.
export const blockOf = (sk, eid) => (sk.blocks || []).find((b) => Object.values(b.map).includes(eid)) || null;
// The instance's geometry made plain: its rigid relation goes, the block's own relations and dimensions come back.
export function explodeBlock(sk, bid) {
  const b = (sk.blocks || []).find((x) => x.id === bid);
  if (!b) return false;
  sk.constraints = sk.constraints.filter((k) => !(k.type === 'block' && k.block === bid));
  for (const k of b.def.constraints || []) {
    if (!k.refs.every((r) => b.map[r])) continue;
    const { id: _id, refs, type, ...rest } = k;
    addRel(sk, type, refs.map((r) => b.map[r]), rest);
  }
  sk.blocks = sk.blocks.filter((x) => x !== b);
  if (!sk.blocks.length) delete sk.blocks;
  return true;
}
// Every instance of block `block.name` in the sketch replaced by the block as it is now, where the instance is (its
// first two points' places now against the block's when inserted). Returns how many were updated.
export function updateBlockInstances(sk, block) {
  let n = 0;
  for (const b of [...(sk.blocks || [])].filter((x) => x.name === block.name)) {
    const pts = b.def.points.filter((q) => b.map[q.id]);
    let x = b.at[0], y = b.at[1], angle = b.angle || 0;
    if (pts.length) {
      const a0 = (angle * Math.PI) / 180, rot = (q) => [q.x * Math.cos(a0) - q.y * Math.sin(a0), q.x * Math.sin(a0) + q.y * Math.cos(a0)];
      const far = pts.reduce((m, q) => (Math.hypot(q.x - pts[0].x, q.y - pts[0].y) > Math.hypot(m.x - pts[0].x, m.y - pts[0].y) ? q : m), pts[0]);
      const A = getPoint(sk, b.map[pts[0].id]), B = getPoint(sk, b.map[far.id]);
      let da = 0;
      if (far !== pts[0]) da = Math.atan2(B.y - A.y, B.x - A.x) - Math.atan2(far.y - pts[0].y, far.x - pts[0].x);
      angle = b.angle + (da * 180) / Math.PI;
      const ap = rot(pts[0]), c = Math.cos(da), s = Math.sin(da);
      x = A.x - (ap[0] * c - ap[1] * s); y = A.y - (ap[0] * s + ap[1] * c);
    }
    // (the relations from outside to the instance, by the block's own ids)
    const back = new Map(Object.entries(b.map).map(([k, v]) => [v, k])), own = new Set(back.keys());
    const outside = sk.constraints.filter((k) => !(k.type === 'block' && k.block === b.id) && k.refs.some((r) => own.has(r)) && !k.refs.every((r) => own.has(r)));
    sk.constraints = sk.constraints.filter((k) => !(k.type === 'block' && k.block === b.id) && !outside.includes(k));
    deleteItems(sk, [...own]);
    sk.blocks = (sk.blocks || []).filter((z) => z !== b);
    const nb = insertBlockInstance(sk, block, x, y, angle), inst = sk.blocks.find((z) => z.id === nb.id);
    inst.id = b.id;
    for (const k of sk.constraints) if (k.type === 'block' && k.block === nb.id) k.block = b.id;
    for (const k of outside) {
      const refs = k.refs.map((r) => (own.has(r) ? inst.map[back.get(r)] : r));
      if (refs.every(Boolean)) sk.constraints.push({ ...k, refs });
    }
    n++;
  }
  return n;
}

// Linear pattern: n1 copies along dir1 (spacing d1) × n2 along dir2 (spacing d2; angles in degrees).
export function linearPattern(sk, ids, { n1 = 2, d1 = 10, a1 = 0, n2 = 1, d2 = 10, a2 = 90 }) {
  const u = [Math.cos((a1 * Math.PI) / 180), Math.sin((a1 * Math.PI) / 180)], v = [Math.cos((a2 * Math.PI) / 180), Math.sin((a2 * Math.PI) / 180)];
  const out = [];
  for (let i = 0; i < Math.max(1, n1); i++) for (let j = 0; j < Math.max(1, n2); j++) {
    if (!i && !j) continue;
    const dx = u[0] * d1 * i + v[0] * d2 * j, dy = u[1] * d1 * i + v[1] * d2 * j;
    out.push(...copyItems(sk, ids, (x, y) => [x + dx, y + dy]));
  }
  return out;
}
// Pattern along a curve: n copies (the original first) spaced d apart along the curve pathId, measured along it from
// the point of it nearest the entities' middle; turn: each copy turned with the curve (its direction there against
// the first's). A closed curve comes round; past an open curve's end no more copies are made. Returns the new ids
// and how many copies were made.
export function patternAlongCurve(sk, ids, pathId, { n = 3, d = 10, turn = false }) {
  const c = getCurve(sk, pathId);
  if (!c) throw new Error('Pick the line or curve to follow');
  const pts = curvePoints(sk, c, 2000);
  const closed = c.type === 'circle' || c.type === 'ellipse' || (c.type === 'spline' && c.closed);
  if (closed && pts.length > 1) pts.push(pts[0]);
  const L = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = L[L.length - 1];
  if (!(total > 0)) throw new Error('The curve to follow has no length');
  // the entities' middle (their points), and the curve's nearest point to it
  const own = new Set();
  for (const id of ids) { const cc = getCurve(sk, id); if (cc) for (const k of ['p1', 'p2', 'c', 'a']) if (cc[k]) own.add(cc[k]); if (cc?.pts) cc.pts.forEach((q) => own.add(q)); else if (!cc) own.add(id); }
  const P = [...own].map((id) => getPoint(sk, id)).filter(Boolean);
  const mx = P.reduce((s, q) => s + q.x, 0) / (P.length || 1), my = P.reduce((s, q) => s + q.y, 0) / (P.length || 1);
  let s0 = 0, bd = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1e-30;
    const t = Math.max(0, Math.min(1, ((mx - a[0]) * dx + (my - a[1]) * dy) / l2)), q = [a[0] + dx * t, a[1] + dy * t], dd = Math.hypot(mx - q[0], my - q[1]);
    if (dd < bd) { bd = dd; s0 = L[i] + t * (L[i + 1] - L[i]); }
  }
  // the point and the direction of the curve at length s along it
  const at = (s) => {
    let i = 1;
    while (i < L.length - 1 && L[i] < s) i++;
    const a = pts[i - 1], b = pts[i], f = (s - L[i - 1]) / ((L[i] - L[i - 1]) || 1);
    return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], ang: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  };
  const base = at(s0), out = [];
  let made = 0;
  for (let k = 1; k < n; k++) {
    let s = s0 + k * d;
    if (closed) s = ((s % total) + total) % total; else if (s > total + 1e-9) break;
    const q = at(s), th = turn ? q.ang - base.ang : 0, co = Math.cos(th), si = Math.sin(th);
    out.push(...copyItems(sk, ids, (x, y) => {
      const rx = x - base.p[0], ry = y - base.p[1];
      return [q.p[0] + rx * co - ry * si, q.p[1] + rx * si + ry * co];
    }, { rotates: turn }));
    made++;
  }
  return { ids: out, made };
}
// Persistent sketch patterns own their generated geometry. Sources and paths remain ordinary sketch
// entities; rebuilding reuses output ids so dimensions and later features keep their references.
export function patternEntities(sk) {
  return new Set((sk.patterns || []).flatMap((p) => [...(p.generated?.points || []), ...(p.generated?.curves || [])]));
}

export function removeSketchPattern(sk, id) {
  const p = sk.patterns?.find((p) => p.id === id);
  if (!p) return;
  const gone = new Set([...(p.generated?.points || []), ...(p.generated?.curves || [])]);
  sk.points = sk.points.filter((q) => !gone.has(q.id));
  sk.curves = sk.curves.filter((c) => !gone.has(c.id));
  sk.constraints = sk.constraints.filter((k) => k.pattern !== id && !k.refs.some((r) => gone.has(r)));
  sk.patterns = sk.patterns.filter((q) => q !== p);
}

export function updateSketchPatterns(sk, ev = Number) {
  for (const p of sk.patterns || []) {
    if (!p.sources.length || p.sources.some((id) => !getCurve(sk, id) && !getPoint(sk, id))) throw new Error('A sketch pattern source is missing');
    const path = p.path ? getCurve(sk, p.path) : null;
    if (p.path && !path) throw new Error('The sketch pattern path is missing');
    const o = Object.fromEntries(['n1', 'd1', 'a1', 'n2', 'd2', 'a2'].map((k) => [k, ev(String(p[k] ?? ({ n1: 3, d1: 20, a1: 0, n2: 1, d2: 20, a2: 90 })[k]))]));
    o.n1 = Math.round(o.n1); o.n2 = Math.round(o.n2);
    const curved = path && path.type !== 'line';
    if (curved) o.n2 = 1;
    if (!Object.values(o).every(Number.isFinite) || o.n1 < 1 || o.n2 < 1 || o.n1 * o.n2 < 2 || o.n1 * o.n2 > 500 || !(o.d1 > 0) || (o.n2 > 1 && !(o.d2 > 0))) throw new Error('Use 2 to 500 instances and positive spacing');
    if (path?.type === 'line') {
      const a = getPoint(sk, path.p1), b = getPoint(sk, path.p2);
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) throw new Error('The pattern direction has no length');
      o.a1 = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    }
    const owned = new Set([...(p.generated?.points || []), ...(p.generated?.curves || [])]);
    const tmp = { ...sk, points: sk.points.filter((q) => !owned.has(q.id)).map((q) => ({ ...q })), curves: sk.curves.filter((c) => !owned.has(c.id)).map((c) => JSON.parse(JSON.stringify(c))), constraints: [] };
    const np = tmp.points.length, nc = tmp.curves.length;
    const result = curved ? patternAlongCurve(tmp, p.sources, path.id, { n: o.n1, d: o.d1, turn: !!p.turn }) : { ids: linearPattern(tmp, p.sources, o), made: o.n1 * o.n2 - 1 };
    const points = tmp.points.slice(np), curves = tmp.curves.slice(nc);
    p.pointIds ||= []; p.curveIds ||= [];
    const map = new Map();
    points.forEach((q, i) => { p.pointIds[i] ||= nid(sk, 'p'); map.set(q.id, p.pointIds[i]); });
    curves.forEach((c, i) => { p.curveIds[i] ||= nid(sk, 'c'); map.set(c.id, p.curveIds[i]); });
    points.forEach((q) => { q.id = map.get(q.id); });
    curves.forEach((c) => {
      c.id = map.get(c.id);
      for (const k of ['p1', 'p2', 'c', 'a', 'ctrlOf']) if (c[k]) c[k] = map.get(c[k]) || c[k];
      if (c.pts) c.pts = c.pts.map((id) => map.get(id));
      if (c.handles) c.handles = c.handles.map((id) => map.get(id));
    });
    sk.points = sk.points.filter((q) => !owned.has(q.id)).concat(points);
    sk.curves = sk.curves.filter((c) => !owned.has(c.id)).concat(curves);
    sk.constraints = sk.constraints.filter((k) => k.pattern !== p.id);
    p.constraintId ||= nid(sk, 'k');
    if (points.length) sk.constraints.push({ id: p.constraintId, type: 'sketchPattern', pattern: p.id, refs: curves.map((c) => c.id), pts: Object.fromEntries(points.map((q) => [q.id, [q.x, q.y]])), radii: Object.fromEntries(curves.filter((c) => c.type === 'circle').map((c) => [c.id, c.r])), minors: Object.fromEntries(curves.filter(isEll).map((c) => [c.id, c.r2])) });
    p.generated = { points: points.map((q) => q.id), curves: curves.map((c) => c.id) };
    p.made = result.made;
  }
}

export function setSketchPattern(sk, spec, ev = Number) {
  sk.patterns ||= [];
  let p = spec.id && sk.patterns.find((p) => p.id === spec.id);
  if (p) Object.assign(p, spec);
  else { p = { ...spec, id: nid(sk, 'pat') }; sk.patterns.push(p); }
  if (p.sources.includes(p.path)) p.sources = p.sources.filter((id) => id !== p.path);
  const own = new Set([...(p.generated?.points || []), ...(p.generated?.curves || [])]);
  if ([...p.sources, p.path].some((id) => own.has(id))) throw new Error('A pattern cannot use its own copies as a source or path');
  updateSketchPatterns(sk, ev);
  return p;
}

// Circular pattern: n copies round centre (cx, cy) spread over `total` degrees (360: evenly round).
export function circularPattern(sk, ids, { n = 4, total = 360, cx = 0, cy = 0 }) {
  const out = [], step = (total >= 360 - 1e-9 ? total / n : total / Math.max(1, n - 1)) * (Math.PI / 180);
  for (let i = 1; i < n; i++) {
    const a = step * i, co = Math.cos(a), si = Math.sin(a);
    out.push(...copyItems(sk, ids, (x, y) => [cx + (x - cx) * co - (y - cy) * si, cy + (x - cx) * si + (y - cy) * co], { rotates: true }));
  }
  return out;
}
// Extend: the end of a line or arc nearest (x, y) carried on to the first curve it meets. Returns
// { point, curve } (the moved end and the curve it now meets), or null.
export function extendAt(sk, curveId, x, y) {
  const c = getCurve(sk, curveId);
  if (!c || (c.type !== 'line' && c.type !== 'arc')) return null;
  const P1 = getPoint(sk, c.p1), P2 = getPoint(sk, c.p2);
  const end = Math.hypot(x - P1.x, y - P1.y) < Math.hypot(x - P2.x, y - P2.y) ? 'p1' : 'p2';
  const E = getPoint(sk, c[end]);
  // (an end joined to something else stays put)
  if (c[end] === 'O' || sk.curves.some((o) => o !== c && [o.p1, o.p2, o.c, o.a, ...(o.pts || []), ...(o.handles || [])].includes(c[end]))) return null;
  let best = null;
  if (c.type === 'line') {
    const O = end === 'p2' ? P1 : P2, d = [E.x - O.x, E.y - O.y], L = Math.hypot(d[0], d[1]) || 1;
    const far = { x: E.x + (d[0] / L) * 1e6, y: E.y + (d[1] / L) * 1e6 };
    const tmp = { id: '__ext', type: 'line', p1: '__a', p2: '__b' };
    sk.points.push({ id: '__a', x: E.x, y: E.y }, { id: '__b', x: far.x, y: far.y });
    try {
      for (const o of sk.curves) {
        if (o === c) continue;
        for (const q of intersect(sk, tmp, o)) { const t = Math.hypot(q.x - E.x, q.y - E.y); if (t > 1e-7 && (!best || t < best.t)) best = { t, q, o }; }
      }
    } finally { sk.points = sk.points.filter((q) => q.id !== '__a' && q.id !== '__b'); }
  } else {
    // round the arc's circle, in the direction it runs at that end
    const A = arcAngles(sk, c), tmp = { id: '__ext', type: 'circle', c: c.c, r: A.r };
    const angOf = (q) => Math.atan2(q.y - A.cy, q.x - A.cx), aE = angOf(E);
    for (const o of sk.curves) {
      if (o === c) continue;
      for (const q of intersect(sk, tmp, o)) {
        let da = end === 'p2' ? angOf(q) - aE : aE - angOf(q);
        da = ((da % TAU) + TAU) % TAU;
        if (da > 1e-7 && da < TAU - A.span && (!best || da < best.t)) best = { t: da, q, o };
      }
    }
  }
  if (!best) return null;
  E.x = best.q.x; E.y = best.q.y;
  return { point: c[end], curve: best.o.id };
}
// Split a line or arc at the point on it nearest (x, y) into two joined pieces. Returns the new point id.
export function splitAt(sk, curveId, x, y) {
  const c = getCurve(sk, curveId);
  if (!c || (c.type !== 'line' && c.type !== 'arc')) return null;
  const q = closestOnCurve(sk, c, x, y);
  const P1 = getPoint(sk, c.p1), P2 = getPoint(sk, c.p2);
  if (Math.hypot(q.x - P1.x, q.y - P1.y) < 1e-6 || Math.hypot(q.x - P2.x, q.y - P2.y) < 1e-6) return null;
  const m = addPoint(sk, q.x, q.y), old = c.p2;
  c.p2 = m;
  if (c.type === 'line') { const nl = addLine(sk, m, old, c.construction); addRel(sk, 'collinear', [c.id, nl]); }
  else { const na = addArc(sk, c.c, m, old, c.construction); addRel(sk, 'equal', [c.id, na]); }
  return m;
}

// ------------------------------------------------------------ splines
// A spline as cubic Bézier pieces through its points, joined smoothly (tangent continuous): at each point
// the tangent runs along the chord of its neighbours, each piece's handles a third of its length; at
// an open end the tangent makes the end piece as straight as it can be. P: [[x, y]], closed or not.
export function splineBeziers(P, closed = false, handles = null) {
  const n = P.length;
  if (n < 2) return [];
  if (handles?.length === n) return Array.from({ length: closed ? n : n - 1 }, (_, i) => {
    const j = (i + 1) % n;
    return { a: P[i], c1: handles[i], c2: [2 * P[j][0] - handles[j][0], 2 * P[j][1] - handles[j][1]], b: P[j] };
  });
  const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]], len2 = (v) => Math.hypot(v[0], v[1]);
  const unit2 = (v) => { const l = len2(v) || 1; return [v[0] / l, v[1] / l]; };
  if (n === 2 && !closed) {
    const [a, b] = P, d = sub2(b, a);
    return [{ a, c1: [a[0] + d[0] / 3, a[1] + d[1] / 3], c2: [b[0] - d[0] / 3, b[1] - d[1] / 3], b }];
  }
  const at = (i) => P[((i % n) + n) % n];
  const T = P.map((_, i) => {
    if (closed || (i > 0 && i < n - 1)) return unit2(sub2(at(i + 1), at(i - 1)));
    // open end: mirror the neighbour's tangent in the end chord
    const [q, r] = i === 0 ? [P[0], P[1]] : [P[n - 2], P[n - 1]];
    const ch = unit2(sub2(r, q)), tn = i === 0 ? unit2(sub2(P[2], P[0])) : unit2(sub2(P[n - 1], P[n - 3]));
    const k = 2 * (ch[0] * tn[0] + ch[1] * tn[1]);
    return unit2([k * ch[0] - tn[0], k * ch[1] - tn[1]]);
  });
  const out = [];
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = at(i), b = at(i + 1), d = len2(sub2(b, a)) / 3, ta = T[i], tb = T[(i + 1) % n];
    out.push({ a, c1: [a[0] + ta[0] * d, a[1] + ta[1] * d], c2: [b[0] - tb[0] * d, b[1] - tb[1] * d], b });
  }
  return out;
}
export function splinePieces(sk, c) {
  const P = c.pts.map((id) => { const q = getPoint(sk, id); return [q.x, q.y]; });
  const H = c.handles?.map((id) => { const q = getPoint(sk, id); return [q.x, q.y]; });
  return c.ctrl ? ctrlSplineBeziers(P, c.degree ?? 3, !!c.closed, c.weights) : splineBeziers(P, !!c.closed, H);
}

// Persist the chosen endpoint as a point reference, so edits never switch ends.
export function lineSplineTangentEnd(sk, lineId, splineId, selectedEnd = null) {
  const l=getCurve(sk,lineId),s=getCurve(sk,splineId);
  if(l?.type!=='line'||s?.type!=='spline'||s.closed)throw new Error('Select a line and an open spline');
  const ends=[s.p1,s.p2];
  if(selectedEnd){if(!ends.includes(selectedEnd))throw new Error('Select an endpoint of the spline');return selectedEnd;}
  const shared=ends.filter(id=>id===l.p1||id===l.p2);if(shared.length===1)return shared[0];
  const a=getPoint(sk,l.p1),b=getPoint(sk,l.p2),dx=b.x-a.x,dy=b.y-a.y,n=Math.hypot(dx,dy);
  if(n<1e-9)throw new Error('The tangent line must have a nonzero length');
  const distances=ends.map(id=>{const p=getPoint(sk,id);return Math.abs((p.x-a.x)*dy-(p.y-a.y)*dx)/n;});
  if(Math.abs(distances[0]-distances[1])<1e-7)throw new Error('Both spline ends are equally close: also select the desired spline endpoint');
  return ends[distances[0]<distances[1]?0:1];
}

export function fitSplineHandles(P, closed = false) {
  const pieces = splineBeziers(P, closed);
  return P.map((p, i) => {
    const next = pieces[i]?.c1, prev = pieces[(i - 1 + pieces.length) % pieces.length]?.c2;
    if (!closed && i === 0) return next;
    if (!closed && i === P.length - 1) return [2 * p[0] - prev[0], 2 * p[1] - prev[1]];
    return [(next[0] + 2 * p[0] - prev[0]) / 2, (next[1] + 2 * p[1] - prev[1]) / 2];
  });
}

export function syncFitHandles(sk, c) {
  const old = sk.curves.filter((q) => q.ctrlOf === c.id && q.fitHandle), kept = new Set();
  c.handles?.forEach((id, i) => {
    const existing = old.find((q) => q.p1 === c.pts[i] && q.p2 === id);
    if (existing) kept.add(existing.id);
    else {
      const line = addLine(sk, c.pts[i], id, true);
      Object.assign(getCurve(sk, line), { ctrlOf: c.id, fitHandle: true }); kept.add(line);
    }
  });
  sk.curves = sk.curves.filter((q) => !(q.ctrlOf === c.id && q.fitHandle) || kept.has(q.id));
}

export function addFitSpline(sk, pts, closed = false, construction = false, handles = null) {
  const id = addSpline(sk, pts, closed, construction), c = getCurve(sk, id);
  c.handles = handles || fitSplineHandles(pts.map((id) => { const p = getPoint(sk, id); return [p.x, p.y]; }), closed).map((p) => addPoint(sk, ...p));
  syncFitHandles(sk, c);
  return id;
}

// Arc length independent of display tessellation. Weighted B-splines use their exact homogeneous pieces.
function integrateLength(f, a, b, tolerance = 1e-9) {
  const simpson = (a, b, fa, fm, fb) => (b - a) * (fa + 4 * fm + fb) / 6;
  const recurse = (a, b, fa, fm, fb, whole, tol, depth) => {
    const m = (a + b) / 2, fl = f((a + m) / 2), fr = f((m + b) / 2);
    const left = simpson(a, m, fa, fl, fm), right = simpson(m, b, fm, fr, fb), error = left + right - whole;
    if (!depth || Math.abs(error) <= 15 * tol) return left + right + error / 15;
    return recurse(a, m, fa, fl, fm, left, tol / 2, depth - 1) + recurse(m, b, fm, fr, fb, right, tol / 2, depth - 1);
  };
  const fa = f(a), fm = f((a + b) / 2), fb = f(b);
  return recurse(a, b, fa, fm, fb, simpson(a, b, fa, fm, fb), tolerance, 18);
}

export function curveLength(sk, c) {
  if (!c) throw new Error('The curve is missing');
  if (c.type === 'line') { const a = getPoint(sk, c.p1), b = getPoint(sk, c.p2); return Math.hypot(b.x - a.x, b.y - a.y); }
  if (c.type === 'circle') return TAU * Math.abs(c.r);
  if (c.type === 'arc') { const a = arcAngles(sk, c); return a.r * a.span; }
  if (isEll(c)) {
    const { g, t0, span } = ellipseRange(sk, c);
    return integrateLength((t) => Math.hypot(g.ra * Math.sin(t), g.rb * Math.cos(t)), t0, t0 + span);
  }
  if (c.type === 'spline') {
    const points = c.pts.map((id) => { const p = getPoint(sk, id); return [p.x, p.y]; });
    const pieces = c.ctrl ? bsplineBeziers(points, c.degree ?? 3, !!c.closed, c.weights) : splinePieces(sk, c).map((p) => [p.a, p.c1, p.c2, p.b]);
    return pieces.reduce((length, q) => length + integrateLength((t) => {
      const d = bezD(q, t);
      if (q[0].length !== 3) return Math.hypot(...d);
      const p = bezPt(q, t), w2 = p[2] * p[2];
      if (!(w2 > 0)) throw new Error('The spline has invalid weights');
      return Math.hypot((d[0] * p[2] - p[0] * d[2]) / w2, (d[1] * p[2] - p[1] * d[2]) / w2);
    }, 0, 1, 1e-9 / Math.max(1, pieces.length)), 0);
  }
  throw new Error('Equal Curve Length needs lines, arcs, circles, ellipses or splines');
}

// A control-point spline (ctrl: true): a B-spline of `degree` (1–7) on its points, knots evenly spaced. Open, it is
// clamped (it starts at the first and ends at the last, leaving them along the first and last legs of its control
// polygon); closed, it is periodic (it runs round smoothly, with no join, near the points rather than through
// them). weights (optional, one per point, 1 when left out): a weighted (rational) spline, pulled harder toward the
// points with the larger weights; with the right weights a degree 2 spline makes arcs and ellipses (to within CTRL_FIT).
// The control polygon is drawn as construction lines (ctrlOf: the spline), so it can be dimensioned and constrained
// like any lines. Made into the cubic Bézier pieces every spline is drawn and built from: exactly for degree 2
// and 3 without weights; otherwise pieces fitted with cubics to within CTRL_FIT of the curve.
const CTRL_FIT = 1e-5; // mm
export function addCtrlSpline(sk, pts, degree = 3, construction = false, closed = false, weights = null) {
  const id = nid(sk, 's');
  const c = { id, type: 'spline', ctrl: true, degree, pts: [...pts], p1: pts[0], p2: closed ? pts[0] : pts[pts.length - 1], closed: !!closed, construction };
  if (weights && weights.some((w) => w !== 1)) c.weights = [...weights];
  sk.curves.push(c);
  syncCtrlPolygon(sk, c);
  return id;
}
// The fewest control points a control-point spline can have, and the highest degree it can have.
export const ctrlMin = (c) => (c.closed ? 3 : 2);
export const CTRL_MAX_DEGREE = 7;
export const ctrlMaxDegree = (c) => Math.max(1, Math.min(CTRL_MAX_DEGREE, c.pts.length - 1));
// After its points changed: the control polygon as construction lines between consecutive points (and from the
// last back to the first when closed), keeping the legs that are still there (with their dimensions and relations),
// the degree within what the point count allows and the weights one per point; ends p1 / p2 on the right points.
export function syncCtrlPolygon(sk, c) {
  c.degree = Math.max(1, Math.min(c.degree ?? 3, ctrlMaxDegree(c)));
  c.p1 = c.pts[0]; c.p2 = c.closed ? c.pts[0] : c.pts[c.pts.length - 1];
  if (c.weights) {
    c.weights = c.pts.map((_, i) => (c.weights[i] > 0 ? c.weights[i] : 1));
    if (c.weights.every((w) => w === 1)) delete c.weights;
  }
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const want = new Map();
  const n = c.pts.length;
  for (let i = 0; i < (c.closed ? n : n - 1); i++) {
    const a = c.pts[i], b = c.pts[(i + 1) % n];
    if (a !== b && !want.has(key(a, b))) want.set(key(a, b), [a, b]);
  }
  const drop = [];
  for (const l of sk.curves) {
    if (l.ctrlOf !== c.id) continue;
    const k = key(l.p1, l.p2);
    if (want.has(k)) want.delete(k); else drop.push(l.id);
  }
  if (drop.length) {
    const set = new Set(drop);
    sk.curves = sk.curves.filter((x) => !set.has(x.id));
    sk.constraints = sk.constraints.filter((k) => !k.refs.some((r) => set.has(r)));
  }
  for (const [a, b] of want.values()) getCurve(sk, addLine(sk, a, b, true)).ctrlOf = c.id;
}
// A control point added half way along the leg after the point at index i (closed: the last leg runs back to the
// first point). The curve changes shape a little (the knots stay evenly spaced). Returns the new point's id.
export function insertCtrlPoint(sk, c, i) {
  const n = c.pts.length;
  if (!c.closed && i >= n - 1) i = n - 2;
  const A = getPoint(sk, c.pts[i]), B = getPoint(sk, c.pts[(i + 1) % n]);
  const id = addPoint(sk, (A.x + B.x) / 2, (A.y + B.y) / 2);
  c.pts.splice(i + 1, 0, id);
  if (c.weights) c.weights.splice(i + 1, 0, 1);
  syncCtrlPolygon(sk, c);
  return id;
}
// A control point taken out of the spline (and out of the sketch when nothing else uses it). False when the
// spline has too few points left for that.
export function removeCtrlPoint(sk, c, id) {
  const i = c.pts.indexOf(id);
  if (i < 0 || c.pts.length - 1 < ctrlMin(c)) return false;
  c.pts.splice(i, 1);
  if (c.weights) c.weights.splice(i, 1);
  syncCtrlPolygon(sk, c);
  cleanup(sk);
  return true;
}
// A spline through points made a control-point spline (cubic, or lower with fewer than four points) that runs
// through the same points: open, the ends stay its first and last control points (so what joins them stays
// joined); the other control points are new. The old points it ran through go unless something else uses them.
export function convertToCtrlSpline(sk, c) {
  if (c.ctrl) return;
  const Q = c.pts.map((id) => { const q = getPoint(sk, id); return [q.x, q.y]; });
  const closed = !!c.closed, n = Q.length, p = Math.max(1, Math.min(3, n - 1));
  const P = bsplineInterpolate(Q, p, closed);
  const old = c.pts;
  const pts = P.map((q, i) => (!closed && (i === 0 || i === n - 1) ? old[i] : addPoint(sk, q[0], q[1])));
  Object.assign(c, { ctrl: true, degree: p, pts, closed });
  if (c.handles) {
    sk.curves = sk.curves.filter((q) => !(q.ctrlOf === c.id && q.fitHandle));
    delete c.handles;
  }
  delete c.weights;
  syncCtrlPolygon(sk, c);
  cleanup(sk);
}
// The knots of an evenly spaced B-spline of degree p on n points: clamped (open) or periodic (closed: the points
// wrap round, n + p of them), with the parameter range the curve covers.
function bsplineKnots(n, p, closed) {
  const U = [];
  if (closed) { for (let i = 0; i <= n + 2 * p; i++) U.push(i); return { U, lo: p, hi: n + p }; }
  const spans = n - p;
  for (let i = 0; i <= p; i++) U.push(0);
  for (let i = 1; i < spans; i++) U.push(i);
  for (let i = 0; i <= p; i++) U.push(spans);
  return { U, lo: 0, hi: spans };
}
// The B-spline basis functions of degree p at u (Cox–de Boor): N[i] for each control point of the knot vector U.
function bsplineBasis(U, p, u, count) {
  const m = U.length - 1;
  let N = U.slice(0, m).map((a, i) => (u >= a && u < U[i + 1] ? 1 : 0));
  // (the very end of the range belongs to the last span)
  if (u >= U[m - p]) { N = N.map(() => 0); let k = m - 1; while (k > 0 && !(U[k] < U[k + 1])) k--; N[k] = 1; }
  for (let d = 1; d <= p; d++) {
    N = N.slice(0, m - d).map((_, i) => {
      const l = U[i + d] - U[i], r = U[i + d + 1] - U[i + 1];
      return (l > 0 ? ((u - U[i]) / l) * N[i] : 0) + (r > 0 ? ((U[i + d + 1] - u) / r) * N[i + 1] : 0);
    });
  }
  return N.slice(0, count);
}
// The control points of an evenly spaced B-spline of degree p that runs through the points Q (as many control
// points as points): open, Q[i] at its Greville parameter; closed, at the middle of control point i's influence.
export function bsplineInterpolate(Q, p, closed = false) {
  const n = Q.length;
  if (n < 2 || p < 2) return Q.map((q) => [...q]);
  const { U, lo, hi } = bsplineKnots(n, p, closed);
  const A = [];
  for (let j = 0; j < n; j++) {
    let u;
    if (closed) { u = j + (p + 1) / 2; while (u < lo) u += n; while (u >= hi) u -= n; } else { u = 0; for (let k = 1; k <= p; k++) u += U[j + k]; u /= p; }
    const N = bsplineBasis(U, p, u, closed ? n + p : n);
    const row = new Array(n).fill(0);
    N.forEach((v, i) => { row[i % n] += v; });
    A.push(row);
  }
  // A·P = Q (Gauss–Jordan with partial pivoting; n is small)
  const M = A.map((r, j) => [...r, Q[j][0], Q[j][1]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-300;
    for (let k = col; k < n + 2; k++) M[col][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col || !M[r][col]) continue;
      const f = M[r][col];
      for (let k = col; k < n + 2; k++) M[r][k] -= f * M[col][k];
    }
  }
  return M.map((r) => [r[n], r[n + 1]]);
}
// The Bézier pieces (control points, degree p each) of an evenly spaced B-spline on P: clamped, or periodic when
// closed (Boehm knot insertion: every knot in the curve's range inserted until it is there p times). With
// weights W the points are homogeneous [w·x, w·y, w].
export function bsplineBeziers(P, p, closed = false, W = null) {
  const n = P.length;
  if (n < 2) return [];
  p = Math.max(1, Math.min(p, n - 1));
  const H = P.map((q, i) => (W ? [q[0] * W[i], q[1] * W[i], W[i]] : [q[0], q[1]]));
  const { U, lo, hi } = bsplineKnots(n, p, closed);
  let Q = closed ? [...H, ...H.slice(0, p)] : H, K = [...U];
  const mix = (A, B, a) => A.map((x, j) => (1 - a) * x + a * B[j]);
  for (let u = lo; u <= hi; u++) {
    while (K.filter((x) => x === u).length < p) {
      // the span holding u (at the end of the range, the span ending there)
      const k = u < hi ? K.findLastIndex((x) => x <= u) : K.findLastIndex((x) => x < u);
      const R = [];
      for (let i = 0; i < Q.length + 1; i++) {
        if (i <= k - p) R.push(Q[i]);
        else if (i > k) R.push(Q[i - 1]);
        else R.push(mix(Q[i - 1], Q[i], (u - K[i]) / (K[i + p] - K[i])));
      }
      K.splice(k + 1, 0, u);
      Q = R;
    }
  }
  const out = [];
  for (let u = lo; u < hi; u++) { const k = K.findLastIndex((x) => x <= u); out.push(Q.slice(k - p, k + 1)); }
  return out;
}
const bezPt = (Q, t) => { let R = Q.map((q) => [...q]); for (let r = 1; r < Q.length; r++) R = R.slice(1).map((q, i) => q.map((x, j) => R[i][j] + (x - R[i][j]) * t)); return R[0]; };
const bezD = (Q, t) => { const p = Q.length - 1, D = Q.slice(1).map((q, i) => q.map((x, j) => p * (x - Q[i][j]))); return D.length === 1 ? D[0] : bezPt(D, t); };
// one Bézier piece of any degree (homogeneous [w·x, w·y, w] when weighted) as cubic pieces: exact up to degree 3
// without weights (or with the same weight on all its points); otherwise Hermite cubics on halves until close
function bezierAsCubics(Q) {
  if (Q[0].length === 3) {
    if (Q.every((q) => Math.abs(q[2] - Q[0][2]) < 1e-12 * Q[0][2])) Q = Q.map((q) => [q[0] / q[2], q[1] / q[2]]);
  }
  const p = Q.length - 1, rational = Q[0].length === 3;
  if (!rational && p === 1) { const [a, b] = Q; return [{ a, c1: [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3], c2: [a[0] + (2 * (b[0] - a[0])) / 3, a[1] + (2 * (b[1] - a[1])) / 3], b }]; }
  if (!rational && p === 2) { const [a, q, b] = Q; return [{ a, c1: [a[0] + (2 * (q[0] - a[0])) / 3, a[1] + (2 * (q[1] - a[1])) / 3], c2: [b[0] + (2 * (q[0] - b[0])) / 3, b[1] + (2 * (q[1] - b[1])) / 3], b }]; }
  if (!rational && p === 3) return [{ a: Q[0], c1: Q[1], c2: Q[2], b: Q[3] }];
  const at = rational ? (t) => { const h = bezPt(Q, t); return [h[0] / h[2], h[1] / h[2]]; } : (t) => bezPt(Q, t);
  const dAt = rational
    ? (t) => { const h = bezPt(Q, t), d = bezD(Q, t), x = h[0] / h[2], y = h[1] / h[2]; return [(d[0] - x * d[2]) / h[2], (d[1] - y * d[2]) / h[2]]; }
    : (t) => bezD(Q, t);
  const out = [];
  const fit = (t0, t1, depth) => {
    const h = t1 - t0, a = at(t0), b = at(t1), da = dAt(t0), db = dAt(t1);
    const g = { a, c1: [a[0] + (da[0] * h) / 3, a[1] + (da[1] * h) / 3], c2: [b[0] - (db[0] * h) / 3, b[1] - (db[1] * h) / 3], b };
    let worst = 0;
    for (let i = 1; i < 8; i++) { const s = i / 8, q = bezierAt(g, s), r = at(t0 + h * s); worst = Math.max(worst, Math.hypot(q[0] - r[0], q[1] - r[1])); }
    if (worst <= CTRL_FIT || depth >= 8) { out.push(g); return; }
    fit(t0, t0 + h / 2, depth + 1); fit(t0 + h / 2, t1, depth + 1);
  };
  fit(0, 1, 0);
  return out;
}
export function ctrlSplineBeziers(P, degree = 3, closed = false, W = null) {
  return bsplineBeziers(P, degree, closed, W).flatMap(bezierAsCubics);
}
export function bezierAt(g, t) {
  const u = 1 - t, b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
  return [b0 * g.a[0] + b1 * g.c1[0] + b2 * g.c2[0] + b3 * g.b[0], b0 * g.a[1] + b1 * g.c1[1] + b2 * g.c2[1] + b3 * g.b[1]];
}
// The part of a Bézier piece between parameters t0 < t1 (de Casteljau), as a Bézier piece.
export function bezierPart(g, t0, t1) {
  const split = (q, t) => {
    const l = (p0, p1) => [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
    const ab = l(q.a, q.c1), bc = l(q.c1, q.c2), cd = l(q.c2, q.b), abc = l(ab, bc), bcd = l(bc, cd), m = l(abc, bcd);
    return [{ a: q.a, c1: ab, c2: abc, b: m }, { a: m, c1: bcd, c2: cd, b: q.b }];
  };
  let q = g;
  if (t1 < 1 - 1e-12) q = split(q, t1)[0];
  if (t0 > 1e-12) q = split(q, t0 / t1)[1];
  return q;
}
// Points along a spline (perPiece per Bézier piece), and their parameters (piece index + t).
export const SPLINE_STEPS = 24;
function splineSamples(sk, c, perPiece = SPLINE_STEPS) {
  const pcs = splinePieces(sk, c), pts = [], ts = [];
  pcs.forEach((g, k) => {
    for (let i = k ? 1 : 0; i <= perPiece; i++) { pts.push(bezierAt(g, i / perPiece)); ts.push(k + i / perPiece); }
  });
  return { pts, ts, pieces: pcs };
}
// Exact Bézier segments of a spline between parameters u0 and u1 (piece index + t; u1 < u0 runs back).
function splineSegs(sk, c, u0, u1) {
  const pcs = splinePieces(sk, c), n = pcs.length;
  const back = u1 < u0, lo = Math.min(u0, u1), hi = Math.max(u0, u1);
  const out = [];
  // (a closed spline's parameters can run past its end: they wrap round)
  for (let k = Math.floor(lo + 1e-9); k < hi - 1e-9; k++) {
    const g = pcs[((k % n) + n) % n];
    const t0 = Math.max(0, lo - k), t1 = Math.min(1, hi - k);
    if (t1 - t0 < 1e-9) continue;
    const q = bezierPart(g, t0, t1);
    out.push({ type: 'bezier', a: q.a, c1: q.c1, c2: q.c2, b: q.b });
  }
  return back ? out.reverse().map((g) => ({ type: 'bezier', a: g.b, c1: g.c2, c2: g.c1, b: g.a })) : out;
}

export function addArc(sk, c, p1, p2, construction = false) {
  const id = nid(sk, 'c');
  sk.curves.push({ id, type: 'arc', c, p1, p2, construction });
  return id;
}
export function addRel(sk, type, refs, extra = {}) {
  const k = { id: nid(sk, 'k'), type, refs, ...extra };
  sk.constraints.push(k);
  return k;
}

// Corner rectangle from two existing corner points.
export function buildRect(sk, A, C) {
  const a = getPoint(sk, A), c = getPoint(sk, C);
  const B = addPoint(sk, c.x, a.y), D = addPoint(sk, a.x, c.y);
  const l1 = addLine(sk, A, B), l2 = addLine(sk, B, C), l3 = addLine(sk, C, D), l4 = addLine(sk, D, A);
  addRel(sk, 'horizontal', [l1]); addRel(sk, 'vertical', [l2]);
  addRel(sk, 'horizontal', [l3]); addRel(sk, 'vertical', [l4]);
  return { corners: [A, B, C, D], lines: [l1, l2, l3, l4] };
}

// Center rectangle: center point M (may be 'O') and a corner position.
export function buildCenterRect(sk, M, cx, cy, hw, hh) {
  const A = addPoint(sk, cx - hw, cy - hh), B = addPoint(sk, cx + hw, cy - hh);
  const C = addPoint(sk, cx + hw, cy + hh), D = addPoint(sk, cx - hw, cy + hh);
  const l1 = addLine(sk, A, B), l2 = addLine(sk, B, C), l3 = addLine(sk, C, D), l4 = addLine(sk, D, A);
  addRel(sk, 'horizontal', [l1]); addRel(sk, 'vertical', [l2]);
  addRel(sk, 'horizontal', [l3]); addRel(sk, 'vertical', [l4]);
  const d1 = addLine(sk, A, C, true);
  addLine(sk, B, D, true);
  addRel(sk, 'midpoint', [M, d1]);
  return { corners: [A, B, C, D], lines: [l1, l2, l3, l4] };
}

// Drawing layouts shared by slot previews and committed geometry. r is the half-width.
export function slotLayout(tool, p, sweep = 0) {
  const [P, Q, T, W] = p;
  if (!P || !Q) return null;
  const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  if (['slot', 'cslot', 'oslot'].includes(tool)) {
    if (!T) return null;
    const L = dist(P, Q); if (L < 1e-6) return null;
    const ux = (Q.x - P.x) / L, uy = (Q.y - P.y) / L;
    const r = Math.abs(-(T.x - P.x) * uy + (T.y - P.y) * ux);
    if (r < 1e-6 || (tool === 'oslot' && 2 * r >= L - 1e-6)) return null;
    const a = tool === 'cslot' ? { x: 2 * P.x - Q.x, y: 2 * P.y - Q.y } : tool === 'oslot' ? { x: P.x + r * ux, y: P.y + r * uy } : P;
    const b = tool === 'oslot' ? { x: Q.x - r * ux, y: Q.y - r * uy } : Q;
    return { type: 'line', a, b, r };
  }
  if (!T) return null;
  let c, a, b, radius;
  if (tool === 'arcslot') {
    radius = dist(P, Q); if (radius < 1e-6) return null;
    c = P; a = Q;
    const endRadius = dist(P, T); if (endRadius < 1e-6) return null;
    b = { x: P.x + radius * (T.x - P.x) / endRadius, y: P.y + radius * (T.y - P.y) / endRadius };
    if (sweep < 0) [a, b] = [b, a];
  } else {
    const g = circleThrough([P.x, P.y], [Q.x, Q.y], [T.x, T.y]);
    if (!g || g.r > 1e6) return null;
    c = { x: g.cx, y: g.cy }; radius = g.r; a = P; b = Q;
    const angle = (v) => Math.atan2(v.y - c.y, v.x - c.x);
    const norm = (v) => (v % TAU + TAU) % TAU;
    if (norm(angle(T) - angle(P)) > norm(angle(Q) - angle(P))) [a, b] = [b, a];
  }
  const r = W ? Math.abs(dist(c, W) - radius) : radius * 0.1;
  if (r < 1e-6 || r >= radius - 1e-6 || dist(a, b) < 1e-6) return null;
  // A major arc with wide caps can overlap itself even when the inner radius is positive.
  const span = (Math.atan2(b.y - c.y, b.x - c.x) - Math.atan2(a.y - c.y, a.x - c.x) + TAU) % TAU;
  if (span > Math.PI && dist(a, b) <= 2 * r + 1e-6) return null;
  return { type: 'arc', c, a, b, radius, r };
}

// Four tangent arcs and a construction centre arc form a curved slot.
export function buildArcSlot(sk, centre, start, end, r) {
  const O = getPoint(sk, centre), A = getPoint(sk, start), B = getPoint(sk, end);
  const R = Math.hypot(A.x - O.x, A.y - O.y);
  if (!(r > 0 && r < R) || Math.abs(Math.hypot(B.x - O.x, B.y - O.y) - R) > 1e-5) throw new Error('Invalid arc slot width or centre arc');
  const radial = (P, radius) => addPoint(sk, O.x + (P.x - O.x) * radius / R, O.y + (P.y - O.y) * radius / R);
  const ao = radial(A, R + r), bo = radial(B, R + r), ai = radial(A, R - r), bi = radial(B, R - r);
  const outer = addArc(sk, centre, ao, bo), capB = addArc(sk, end, bo, bi);
  const inner = addArc(sk, centre, ai, bi), capA = addArc(sk, start, ai, ao);
  const centerline = addArc(sk, centre, start, end, true);
  for (const boundary of [outer, inner]) for (const cap of [capA, capB]) addRel(sk, 'tangent', [boundary, cap]);
  addRel(sk, 'equal', [capA, capB]);
  return { arcs: [outer, capB, inner, capA], centerline };
}

// Straight slot between two arc-center points with radius r.
export function buildSlot(sk, c1, c2, r) {
  const P1 = getPoint(sk, c1), P2 = getPoint(sk, c2);
  let dx = P2.x - P1.x, dy = P2.y - P1.y;
  const L = Math.hypot(dx, dy) || 1;
  dx /= L; dy /= L;
  const nx = -dy, ny = dx;
  const A = addPoint(sk, P2.x - r * nx, P2.y - r * ny), B = addPoint(sk, P2.x + r * nx, P2.y + r * ny);
  const C = addPoint(sk, P1.x + r * nx, P1.y + r * ny), D = addPoint(sk, P1.x - r * nx, P1.y - r * ny);
  const a2 = addArc(sk, c2, A, B), top = addLine(sk, B, C), a1 = addArc(sk, c1, C, D), bot = addLine(sk, D, A);
  const cl = addLine(sk, c1, c2, true);
  addRel(sk, 'tangent', [top, a2], { s: tangentSign(sk, top, a2) });
  addRel(sk, 'tangent', [top, a1], { s: tangentSign(sk, top, a1) });
  addRel(sk, 'tangent', [bot, a1], { s: tangentSign(sk, bot, a1) });
  addRel(sk, 'tangent', [bot, a2], { s: tangentSign(sk, bot, a2) });
  addRel(sk, 'equal', [a1, a2]);
  return { arcs: [a1, a2], lines: [top, bot], centerline: cl };
}

// Regular polygon inscribed in a construction circle.
export function buildPolygon(sk, c, vx, vy, n) {
  const C = getPoint(sk, c);
  const r = Math.hypot(vx - C.x, vy - C.y);
  const a0 = Math.atan2(vy - C.y, vx - C.x);
  const circ = addCircle(sk, c, r, true);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = a0 + (i / n) * TAU;
    pts.push(addPoint(sk, C.x + r * Math.cos(t), C.y + r * Math.sin(t)));
  }
  const lines = pts.map((p, i) => addLine(sk, p, pts[(i + 1) % n]));
  pts.forEach((p) => addRel(sk, 'onCurve', [p, circ]));
  for (let i = 1; i < n; i++) addRel(sk, 'equal', [lines[0], lines[i]]);
  return { circle: circ, points: pts, lines };
}

// Sign that makes the signed center-to-line distance positive at creation time.
export function tangentSign(sk, lineId, roundId) {
  const L = getCurve(sk, lineId), R = getCurve(sk, roundId);
  const a = getPoint(sk, L.p1), b = getPoint(sk, L.p2), c = getPoint(sk, R.c);
  const dx = b.x - a.x, dy = b.y - a.y;
  return dx * (c.y - a.y) - dy * (c.x - a.x) >= 0 ? 1 : -1;
}

export function radiusOf(sk, c) {
  if (c.type === 'circle') return c.r;
  if (c.type === 'ellipse' || c.type === 'earc') { const C = getPoint(sk, c.c), A = getPoint(sk, c.a); return Math.hypot(A.x - C.x, A.y - C.y); }
  const C = getPoint(sk, c.c), S = getPoint(sk, c.p1);
  return Math.hypot(S.x - C.x, S.y - C.y);
}

// ------------------------------------------------------------ polylines
export function arcAngles(sk, c) {
  const C = getPoint(sk, c.c), S = getPoint(sk, c.p1), E = getPoint(sk, c.p2);
  const a0 = Math.atan2(S.y - C.y, S.x - C.x);
  let span = Math.atan2(E.y - C.y, E.x - C.x) - a0;
  while (span <= 1e-9) span += TAU;
  while (span > TAU) span -= TAU;
  return { a0, span, r: Math.hypot(S.x - C.x, S.y - C.y), cx: C.x, cy: C.y };
}

export function curvePoints(sk, c, segsPerCircle = 96) {
  if (c.type === 'spline') return splineSamples(sk, c).pts;
  if (isEll(c)) {
    const { g, t0, span } = ellipseRange(sk, c), n = Math.max(8, Math.ceil((span / TAU) * segsPerCircle));
    const pts = Array.from({ length: n + 1 }, (_, i) => ellipseAt(g, t0 + (span * i) / n));
    if (c.type === 'ellipse') pts[n] = [...pts[0]];
    else { const P1 = getPoint(sk, c.p1), P2 = getPoint(sk, c.p2); pts[0] = [P1.x, P1.y]; pts[n] = [P2.x, P2.y]; }
    return pts;
  }
  if (c.type === 'line') {
    const a = getPoint(sk, c.p1), b = getPoint(sk, c.p2);
    return [[a.x, a.y], [b.x, b.y]];
  }
  if (c.type === 'circle') {
    const C = getPoint(sk, c.c), pts = [];
    for (let i = 0; i <= segsPerCircle; i++) {
      const t = (i / segsPerCircle) * TAU;
      pts.push([C.x + c.r * Math.cos(t), C.y + c.r * Math.sin(t)]);
    }
    pts[pts.length - 1] = [...pts[0]];
    return pts;
  }
  const { a0, span, r, cx, cy } = arcAngles(sk, c);
  const n = Math.max(4, Math.ceil((span / TAU) * segsPerCircle));
  const S = getPoint(sk, c.p1), E = getPoint(sk, c.p2);
  const pts = [[S.x, S.y]];
  for (let i = 1; i < n; i++) {
    const t = a0 + (i / n) * span;
    pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  pts.push([E.x, E.y]);
  return pts;
}

// ------------------------------------------------------------ profiles
// Build closed outer loops from all non-construction curves. Segments are split
// at intersections, dangling edges are pruned, and each connected component's
// outer boundary is traced. Nesting (holes/islands) is resolved later.
export function profileLoops(sk) {
  const segs = [];
  for (const c of sk.curves) {
    if (c.construction) continue;
    const pts = curvePoints(sk, c);
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      if (Math.hypot(bx - ax, by - ay) > 1e-9) segs.push([ax, ay, bx, by]);
    }
  }
  if (!segs.length) return [];

  // split at intersections
  const splits = segs.map(() => [0, 1]);
  const bb = segs.map(([ax, ay, bx, by]) => [Math.min(ax, bx) - EPS, Math.min(ay, by) - EPS, Math.max(ax, bx) + EPS, Math.max(ay, by) + EPS]);
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      if (bb[i][0] > bb[j][2] || bb[j][0] > bb[i][2] || bb[i][1] > bb[j][3] || bb[j][1] > bb[i][3]) continue;
      segSegParams(segs[i], segs[j], splits[i], splits[j]);
    }
  }

  // nodes (clustered) and edges
  const nodes = [];
  const grid = new Map();
  const cell = 1e-4;
  const nodeAt = (x, y) => {
    const gx = Math.round(x / cell), gy = Math.round(y / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const list = grid.get(`${gx + dx},${gy + dy}`);
      if (list) for (const n of list) if (Math.abs(nodes[n].x - x) < 1e-5 && Math.abs(nodes[n].y - y) < 1e-5) return n;
    }
    const id = nodes.length;
    nodes.push({ x, y, adj: new Set() });
    const k = `${gx},${gy}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(id);
    return id;
  };
  segs.forEach(([ax, ay, bx, by], i) => {
    const ts = [...new Set(splits[i].map((t) => Math.min(1, Math.max(0, t))))].sort((a, b) => a - b);
    let prev = null;
    for (const t of ts) {
      const n = nodeAt(ax + (bx - ax) * t, ay + (by - ay) * t);
      if (prev !== null && prev !== n) { nodes[prev].adj.add(n); nodes[n].adj.add(prev); }
      prev = n;
    }
  });

  // prune dangling edges
  const alive = nodes.map(() => true);
  const stack = nodes.map((_, i) => i).filter((i) => nodes[i].adj.size < 2);
  while (stack.length) {
    const i = stack.pop();
    if (!alive[i]) continue;
    alive[i] = false;
    for (const j of nodes[i].adj) {
      nodes[j].adj.delete(i);
      if (alive[j] && nodes[j].adj.size < 2) stack.push(j);
    }
    nodes[i].adj.clear();
  }

  // components and outer boundaries
  const seen = new Uint8Array(nodes.length);
  const loops = [];
  for (let s = 0; s < nodes.length; s++) {
    if (!alive[s] || seen[s]) continue;
    const comp = [];
    const q = [s];
    seen[s] = 1;
    while (q.length) {
      const i = q.pop();
      comp.push(i);
      for (const j of nodes[i].adj) if (!seen[j]) { seen[j] = 1; q.push(j); }
    }
    const loop = outerBoundary(nodes, comp);
    if (loop && loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function segSegParams(s1, s2, out1, out2) {
  const [px, py, p2x, p2y] = s1, [qx, qy, q2x, q2y] = s2;
  const rx = p2x - px, ry = p2y - py, sx = q2x - qx, sy = q2y - qy;
  const den = rx * sy - ry * sx;
  const qpx = qx - px, qpy = qy - py;
  const rl = rx * rx + ry * ry, sl = sx * sx + sy * sy;
  if (Math.abs(den) < 1e-12 * Math.sqrt(rl * sl)) {
    // parallel: handle collinear overlap
    if (Math.abs(qpx * ry - qpy * rx) / Math.sqrt(rl) > 1e-7) return;
    const t0 = (qpx * rx + qpy * ry) / rl, t1 = ((q2x - px) * rx + (q2y - py) * ry) / rl;
    if (t0 > 0 && t0 < 1) out1.push(t0);
    if (t1 > 0 && t1 < 1) out1.push(t1);
    const u0 = (-qpx * sx - qpy * sy) / sl, u1 = ((p2x - qx) * sx + (p2y - qy) * sy) / sl;
    if (u0 > 0 && u0 < 1) out2.push(u0);
    if (u1 > 0 && u1 < 1) out2.push(u1);
    return;
  }
  const t = (qpx * sy - qpy * sx) / den, u = (qpx * ry - qpy * rx) / den;
  const e = 1e-9;
  if (t >= -e && t <= 1 + e && u >= -e && u <= 1 + e) { out1.push(t); out2.push(u); }
}

function outerBoundary(nodes, comp, indices = false) {
  let start = comp[0];
  for (const i of comp) {
    const a = nodes[i], b = nodes[start];
    if (a.x < b.x - 1e-9 || (Math.abs(a.x - b.x) < 1e-9 && a.y < b.y)) start = i;
  }
  let d = [0, -1];
  let prev = -1, cur = start, first = null;
  const loop = [];
  for (let step = 0; step < 200000; step++) {
    let best = -1, bestTurn = Infinity;
    const N = nodes[cur];
    for (const nb of N.adj) {
      if (nb === prev && N.adj.size > 1) continue;
      let ox = nodes[nb].x - N.x, oy = nodes[nb].y - N.y;
      const l = Math.hypot(ox, oy);
      ox /= l; oy /= l;
      const turn = Math.atan2(d[0] * oy - d[1] * ox, d[0] * ox + d[1] * oy);
      if (turn < bestTurn) { bestTurn = turn; best = nb; }
    }
    if (best < 0) return null;
    if (first && cur === first[0] && best === first[1]) break;
    if (!first) first = [cur, best];
    loop.push(indices ? cur : [N.x, N.y]);
    const l = Math.hypot(nodes[best].x - N.x, nodes[best].y - N.y);
    d = [(nodes[best].x - N.x) / l, (nodes[best].y - N.y) / l];
    prev = cur;
    cur = best;
  }
  return loop;
}

// ------------------------------------------------------------ exact profiles for the solid kernel
export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Like profileLoops, but each loop also carries its exact boundary as line /
// arc / circle segments, and loops are grouped into regions (outer + holes).
export function profileRegions(sk, withSources = false, boundedFaces = false) {
  const segs = [];
  for (const c of sk.curves) {
    if (c.construction) continue;
    const pts = curvePoints(sk, c);
    let params;
    if (c.type === 'line') params = [0, 1];
    else if (c.type === 'spline') params = splineSamples(sk, c).ts;
    else if (isEll(c)) { const { span } = ellipseRange(sk, c); params = pts.map((_, i) => (i / (pts.length - 1)) * span); }
    else if (c.type === 'circle') params = pts.map((_, i) => (i / (pts.length - 1)) * TAU);
    else { const { span } = arcAngles(sk, c); params = pts.map((_, i) => (i / (pts.length - 1)) * span); }
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      if (Math.hypot(bx - ax, by - ay) > 1e-9) segs.push({ g: [ax, ay, bx, by], cid: c.id, ta: params[i], tb: params[i + 1] });
    }
  }
  if (!segs.length) return [];
  const splits = segs.map(() => [0, 1]);
  const bb = segs.map(({ g: [ax, ay, bx, by] }) => [Math.min(ax, bx) - EPS, Math.min(ay, by) - EPS, Math.max(ax, bx) + EPS, Math.max(ay, by) + EPS]);
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      if (bb[i][0] > bb[j][2] || bb[j][0] > bb[i][2] || bb[i][1] > bb[j][3] || bb[j][1] > bb[i][3]) continue;
      if (segs[i].cid === segs[j].cid && sk.curves.find((c) => c.id === segs[i].cid)?.type !== 'line') continue;
      segSegParams(segs[i].g, segs[j].g, splits[i], splits[j]);
    }
  }
  const nodes = [];
  const grid = new Map();
  const cell = 1e-4;
  const nodeAt = (x, y) => {
    const gx = Math.round(x / cell), gy = Math.round(y / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const list = grid.get(`${gx + dx},${gy + dy}`);
      if (list) for (const n of list) if (Math.abs(nodes[n].x - x) < 1e-5 && Math.abs(nodes[n].y - y) < 1e-5) return n;
    }
    const id = nodes.length;
    nodes.push({ x, y, adj: new Set() });
    const k = `${gx},${gy}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(id);
    return id;
  };
  const edges = new Map(); // "a>b" -> {cid, pa, pb}
  segs.forEach(({ g: [ax, ay, bx, by], cid, ta, tb }, i) => {
    const ts = [...new Set(splits[i].map((t) => Math.min(1, Math.max(0, t))))].sort((a, b) => a - b);
    let prev = null, prevT = 0;
    for (const t of ts) {
      const n = nodeAt(ax + (bx - ax) * t, ay + (by - ay) * t);
      if (prev !== null && prev !== n && !edges.has(`${prev}>${n}`)) {
        const pa = ta + (tb - ta) * prevT, pb = ta + (tb - ta) * t;
        nodes[prev].adj.add(n); nodes[n].adj.add(prev);
        edges.set(`${prev}>${n}`, { cid, pa, pb });
        edges.set(`${n}>${prev}`, { cid, pa: pb, pb: pa });
      }
      prev = n; prevT = t;
    }
  });
  const alive = nodes.map(() => true);
  const stack = nodes.map((_, i) => i).filter((i) => nodes[i].adj.size < 2);
  while (stack.length) {
    const i = stack.pop();
    if (!alive[i]) continue;
    alive[i] = false;
    for (const j of nodes[i].adj) {
      nodes[j].adj.delete(i);
      if (alive[j] && nodes[j].adj.size < 2) stack.push(j);
    }
    nodes[i].adj.clear();
  }
  const seen = new Uint8Array(nodes.length);
  const loops = [];
  for (let s = 0; s < nodes.length; s++) {
    if (!alive[s] || seen[s]) continue;
    const comp = [];
    const q = [s];
    seen[s] = 1;
    while (q.length) {
      const i = q.pop();
      comp.push(i);
      for (const j of nodes[i].adj) if (!seen[j]) { seen[j] = 1; q.push(j); }
    }
    const sequences=boundedFaces?boundedBoundaries(nodes,comp):[outerBoundary(nodes,comp,true)];
    for(const seq of sequences){
      if (!seq || seq.length < 2) continue;
      const poly = seq.map((i) => [nodes[i].x, nodes[i].y]);
      if (Math.abs(signedArea(poly)) < 1e-9) continue;
      loops.push({ poly, segs: loopSegments(sk, nodes, edges, seq, withSources) });
    }
  }
  // nesting: even depth = material, odd depth = hole of its immediate parent
  const items = loops.map((l) => ({ ...l, area: Math.abs(signedArea(l.poly)) }));
  for (const a of items) {
    a.parents = items.filter((b) => b !== a && b.area > a.area && pointInPoly(a.poly[0], b.poly));
    a.depth = a.parents.length;
  }
  const regions = [];
  for (const a of items) if (a.depth % 2 === 0) regions.push({ outer: a, holes: [] });
  for (const a of items) {
    if (a.depth % 2 === 1) {
      const p = a.parents.find((b) => b.depth === a.depth - 1);
      regions.find((r) => r.outer === p)?.holes.push(a);
    }
  }
  return regions.map((r) => ({ outer: { poly: r.outer.poly, segs: r.outer.segs }, holes: r.holes.map((h) => ({ poly: h.poly, segs: h.segs })) }));
}

// Walk both directions of every graph edge, retaining the bounded faces on
// the left. Split repeated-vertex walks so bridges do not become fake borders.
function boundedBoundaries(nodes,comp){
  const neighbors=new Map(comp.map(i=>[i,[...nodes[i].adj].sort((a,b)=>Math.atan2(nodes[a].y-nodes[i].y,nodes[a].x-nodes[i].x)-Math.atan2(nodes[b].y-nodes[i].y,nodes[b].x-nodes[i].x))])),seen=new Set(),loops=[];
  for(const a of comp)for(const b of neighbors.get(a)){
    if(seen.has(`${a}>${b}`))continue;
    let u=a,v=b;const walk=[];
    while(!seen.has(`${u}>${v}`)){
      seen.add(`${u}>${v}`);walk.push(u);const around=neighbors.get(v),next=around[(around.indexOf(u)+around.length-1)%around.length];u=v;v=next;
    }
    if(u!==a||v!==b)continue;
    const stack=[],positions=new Map();
    for(const id of [...walk,walk[0]]){
      if(positions.has(id)){const at=positions.get(id),cycle=stack.slice(at);if(cycle.length>=3&&signedArea(cycle.map(i=>[nodes[i].x,nodes[i].y]))>1e-9)loops.push(cycle);for(const gone of stack.slice(at+1))positions.delete(gone);stack.length=at+1;}
      else{positions.set(id,stack.length);stack.push(id);}
    }
  }
  return loops;
}

// The parameter range that comes round to its start: circles 2π, closed splines their piece count.
const periodOf = (c, sk) => (c?.type === 'circle' || c?.type === 'ellipse' ? TAU : c?.type === 'spline' && c.closed ? splinePieces(sk, c).length : 0);

function loopSegments(sk, nodes, edges, seq, withSources = false) {
  const C = new Map(sk.curves.map((c) => [c.id, c]));
  const pieces = [];
  const n = seq.length;
  const close = (a, b) => Math.abs(a - b) < 1e-7;
  for (let k = 0; k < n; k++) {
    const a = seq[k], b = seq[(k + 1) % n];
    const e = edges.get(`${a}>${b}`);
    if (!e) continue;
    const last = pieces[pieces.length - 1];
    const period = periodOf(C.get(e.cid), sk);
    if (last && last.cid === e.cid && (close(last.u1, e.pa) || (period && close(Math.abs(last.u1 - e.pa), period)))) {
      last.u1 += e.pb - e.pa;
      last.end = b;
    } else pieces.push({ cid: e.cid, u0: e.pa, u1: e.pb, start: a, end: b });
  }
  if (pieces.length > 1) {
    const f = pieces[0], l = pieces[pieces.length - 1];
    const period = periodOf(C.get(f.cid), sk);
    if (f.cid === l.cid && (close(l.u1, f.u0) || (period && close(Math.abs(l.u1 - f.u0), period)))) {
      const shift = f.u0 - l.u1;
      f.u0 = l.u0 + shift;
      f.start = l.start;
      pieces.pop();
    }
  }
  const P = (i) => [nodes[i].x, nodes[i].y];
  const segmentsOf = (p) => {
    const c = C.get(p.cid);
    if (c.type === 'line') return { type: 'line', a: P(p.start), b: P(p.end) };
    if (c.type === 'spline') {
      const segs = splineSegs(sk, c, p.u0, p.u1);
      if (segs.length) { segs[0].a = P(p.start); segs[segs.length - 1].b = P(p.end); }
      return segs;
    }
    if (isEll(c)) {
      const { g, t0 } = ellipseRange(sk, c);
      const segs = ellipseBeziers(g, t0 + p.u0, t0 + p.u1);
      segs[0].a = P(p.start); segs[segs.length - 1].b = P(p.end);
      return segs;
    }
    const ctr = getPoint(sk, c.c);
    const r = radiusOf(sk, c);
    const a0 = c.type === 'arc' ? arcAngles(sk, c).a0 : 0;
    if (Math.abs(p.u1 - p.u0) >= TAU - 1e-6) return { type: 'circle', c: [ctr.x, ctr.y], r };
    const um = a0 + (p.u0 + p.u1) / 2;
    return { type: 'arc', a: P(p.start), b: P(p.end), m: [ctr.x + r * Math.cos(um), ctr.y + r * Math.sin(um)] };
  };
  return pieces.flatMap((p) => {
    const result = [segmentsOf(p)].flat();
    return withSources ? result.map((g) => ({ ...g, sourceCurve: p.cid,sourceDirection:Math.sign(p.u1-p.u0) })) : result;
  });
}

// ------------------------------------------------------------ revolve axis
export function revolveAxis(f, sketch) {
  if (f.axis === 'u') return { a: [0, 0], d: [1, 0] };
  if (f.axis && f.axis !== 'v') {
    const c = sketch && getCurve(sketch, f.axis);
    if (!c || c.type !== 'line') throw new Error('The selected axis line no longer exists');
    const p = getPoint(sketch, c.p1), q = getPoint(sketch, c.p2);
    const L = Math.hypot(q.x - p.x, q.y - p.y);
    if (L < 1e-9) throw new Error('The axis line has zero length');
    return { a: [p.x, p.y], d: [(q.x - p.x) / L, (q.y - p.y) / L] };
  }
  return { a: [0, 0], d: [0, 1] };
}

// ------------------------------------------------------------ projection (Project Edges)
// Frames here are plain arrays: { o, u, v, n } (3-vectors).
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);

export function toFrame2D(fr, p) {
  const d = sub3(p, fr.o);
  return [dot3(d, fr.u), dot3(d, fr.v)];
}
export function fromFrame2D(fr, x, y) {
  return [0, 1, 2].map((i) => fr.o[i] + fr.u[i] * x + fr.v[i] * y);
}

// Classify a 3D polyline sampled from an edge/curve: line, circle/arc or free curve.
export function classifyPolyline3(pts) {
  const n = pts.length;
  if (n < 2) return null;
  const a = pts[0], b = pts[n - 1];
  const closed = len3(sub3(a, b)) < 1e-6;
  if (!closed) {
    const d = sub3(b, a), L = len3(d);
    if (L > 1e-9 && pts.every((p) => len3(cross3(sub3(p, a), d)) / L < 1e-4)) return { type: 'line', a, b };
  }
  if (n >= 3) {
    const i1 = closed ? Math.floor(n / 3) : Math.floor(n / 2), i2 = closed ? Math.floor((2 * n) / 3) : n - 1;
    const p0 = pts[0], p1 = pts[i1], p2 = pts[i2];
    const ab = sub3(p1, p0), ac = sub3(p2, p0), nrm = cross3(ab, ac), nl = len3(nrm);
    if (nl > 1e-12) {
      // circumcenter
      const ab2 = dot3(ab, ab), ac2 = dot3(ac, ac);
      const t = cross3(nrm, ab).map((v) => v * ac2), s = cross3(ac, nrm).map((v) => v * ab2);
      const c = [0, 1, 2].map((i) => p0[i] + (t[i] + s[i]) / (2 * nl * nl));
      const r = len3(sub3(p0, c));
      const N = nrm.map((v) => v / nl);
      if (pts.every((p) => Math.abs(len3(sub3(p, c)) - r) < 1e-3 * Math.max(1, r) && Math.abs(dot3(sub3(p, c), N)) < 1e-3)) {
        return { type: closed ? 'circle' : 'arc', c, r, normal: N, a, b, m: pts[Math.floor(n / 2)] };
      }
    }
  }
  return { type: 'poly', pts };
}

// Project a classified 3D curve onto a sketch frame -> list of 2D primitives.
export function projectCurve(fr, g, { preserveSpline = false } = {}) {
  if (!g) return [];
  if (preserveSpline && g.spline) return [{ type: 'spline', ...g.spline, pts: g.spline.pts.map((p) => toFrame2D(fr, p)), handles: g.spline.handles?.map((p) => toFrame2D(fr, p)) }];
  if (g.type === 'line') {
    const a = toFrame2D(fr, g.a), b = toFrame2D(fr, g.b);
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-7) return [{ type: 'point', p: a }];
    return [{ type: 'line', a, b }];
  }
  if ((g.type === 'circle' || g.type === 'arc') && Math.abs(dot3(g.normal, fr.n)) > 0.99999) {
    const c = toFrame2D(fr, g.c);
    if (g.type === 'circle') return [{ type: 'circle', c, r: g.r }];
    let a = toFrame2D(fr, g.a), b = toFrame2D(fr, g.b);
    const m = toFrame2D(fr, g.m);
    // keep counter-clockwise order a -> b passing through m
    const ang = (p) => Math.atan2(p[1] - c[1], p[0] - c[0]);
    const norm = (x) => ((x % TAU) + TAU) % TAU;
    if (norm(ang(m) - ang(a)) > norm(ang(b) - ang(a))) [a, b] = [b, a];
    return [{ type: 'arc', c, a, b, r: g.r }];
  }
  const pts = g.type === 'poly' ? g.pts : sampleCircle3(g, 48);
  const p2 = pts.map((p) => toFrame2D(fr, p));
  const out = [];
  for (let i = 0; i < p2.length - 1; i++) if (Math.hypot(p2[i + 1][0] - p2[i][0], p2[i + 1][1] - p2[i][1]) > 1e-7) out.push({ type: 'line', a: p2[i], b: p2[i + 1] });
  return out;
}

function sampleCircle3(g, n) {
  const u = sub3(g.a, g.c).map((v) => v / g.r), w = cross3(g.normal, u);
  let span = TAU;
  if (g.type === 'arc') {
    const e = sub3(g.b, g.c);
    span = ((Math.atan2(dot3(e, w), dot3(e, u)) % TAU) + TAU) % TAU || TAU;
  }
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * span;
    pts.push([0, 1, 2].map((k) => g.c[k] + g.r * (u[k] * Math.cos(t) + w[k] * Math.sin(t))));
  }
  return pts;
}

// Intersections with a sketch plane. Coplanar curves retain their geometry.
export function intersectCurve(fr, g) {
  if (!g) return [];
  const distance = (p) => dot3(sub3(p, fr.o), fr.n), tol = 1e-7;
  let points = [];
  if (g.type === 'circle' || g.type === 'arc') {
    const u = sub3(g.a, g.c).map((v) => v / g.r), v = cross3(g.normal, u);
    const A = g.r * dot3(u, fr.n), B = g.r * dot3(v, fr.n), D = distance(g.c), h = Math.hypot(A, B);
    if (h < tol) return Math.abs(D) < tol ? projectCurve(fr, g, { preserveSpline: true }) : [];
    if (Math.abs(D) > h + tol) return [];
    const phi = Math.atan2(B, A), alpha = Math.acos(Math.max(-1, Math.min(1, -D / h)));
    const norm = (t) => ((t % TAU) + TAU) % TAU;
    const span = g.type === 'circle' ? TAU : norm(Math.atan2(dot3(sub3(g.b, g.c), v), dot3(sub3(g.b, g.c), u))) || TAU;
    for (const t of [norm(phi - alpha), norm(phi + alpha)].sort((a, b) => a - b)) {
      if (t > span + tol) continue;
      points.push(g.c.map((q, i) => q + g.r * (u[i] * Math.cos(t) + v[i] * Math.sin(t))));
    }
  } else {
    const pts = g.type === 'line' ? [g.a, g.b] : g.pts || [];
    if (pts.length && pts.every((p) => Math.abs(distance(p)) < tol)) return projectCurve(fr, g, { preserveSpline: true });
    if (g.spline) return []; // Non-coplanar spline intersection needs a root solver.
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], da = distance(a), db = distance(b);
      if (Math.abs(da) < tol) points.push(a);
      if (da * db < 0) points.push(a.map((q, k) => q + (b[k] - q) * da / (da - db)));
      if (Math.abs(db) < tol) points.push(b);
    }
  }
  const out = [];
  for (const p of points) { const q = toFrame2D(fr, p); if (!out.some((g) => Math.hypot(g.p[0] - q[0], g.p[1] - q[1]) < tol)) out.push({ type: 'point', p: q }); }
  return out;
}

// World-space classification of a sketch curve (for projecting other sketches).
export function curve3D(sk, c, fr) {
  const P = (id) => { const p = getPoint(sk, id); return fromFrame2D(fr, p.x, p.y); };
  if (c.type === 'spline' || isEll(c)) {
    const g = { type: 'poly', pts: curvePoints(sk, c).map(([x, y]) => fromFrame2D(fr, x, y)) };
    if (c.type === 'spline') g.spline = { pts: c.pts.map(P), handles: c.handles?.map(P), ctrl: !!c.ctrl, degree: c.degree, closed: !!c.closed, weights: c.weights ? [...c.weights] : undefined };
    return g;
  }
  if (c.type === 'line') return { type: 'line', a: P(c.p1), b: P(c.p2) };
  const C = getPoint(sk, c.c);
  const r = radiusOf(sk, c);
  if (c.type === 'circle') return { type: 'circle', c: P(c.c), r, normal: fr.n, a: fromFrame2D(fr, C.x + r, C.y), b: fromFrame2D(fr, C.x + r, C.y) };
  const A = arcAngles(sk, c), um = A.a0 + A.span / 2;
  return { type: 'arc', c: P(c.c), r, normal: fr.n, a: P(c.p1), b: P(c.p2), m: fromFrame2D(fr, C.x + r * Math.cos(um), C.y + r * Math.sin(um)) };
}

// Create linked (projected) geometry in a sketch. Returns ids of the created curves/points.
export function addProjected(sk, prims, src, construction = false) {
  const out = [];
  prims.forEach((g, idx) => {
    // a single item picked out of a larger list (e.g. one curve of a section) keeps its own index
    const s = src.idx != null && src.of != null && prims.length === 1 ? { ...src } : { ...src, idx, of: prims.length };
    if (g.type === 'spline') {
      const pts = g.pts.map((p) => addPoint(sk, p[0], p[1]));
      const handles = g.handles?.map((p) => addPoint(sk, ...p));
      const id = g.ctrl ? addCtrlSpline(sk, pts, g.degree, construction, g.closed, g.weights) : handles ? addFitSpline(sk, pts, g.closed, construction, handles) : addSpline(sk, pts, g.closed, construction);
      addRel(sk, 'projected', [id], { src: { ...s, spline: true }, pts: Object.fromEntries([...pts.map((p, i) => [p, g.pts[i]]), ...(handles || []).map((p, i) => [p, g.handles[i]])]) });
      out.push(id);
    } else if (g.type === 'point') {
      const p = addPoint(sk, g.p[0], g.p[1]);
      getPoint(sk, p).keep = true;
      addRel(sk, 'projected', [p], { src: s, pts: { [p]: g.p } });
      out.push(p);
    } else if (g.type === 'line') {
      const a = addPoint(sk, g.a[0], g.a[1]), b = addPoint(sk, g.b[0], g.b[1]);
      const l = addLine(sk, a, b, construction);
      addRel(sk, 'projected', [l], { src: s, pts: { [a]: g.a, [b]: g.b } });
      out.push(l);
    } else if (g.type === 'circle') {
      const c = addPoint(sk, g.c[0], g.c[1]);
      const ci = addCircle(sk, c, g.r, construction);
      addRel(sk, 'projected', [ci], { src: s, pts: { [c]: g.c }, r: g.r });
      out.push(ci);
    } else if (g.type === 'arc') {
      const c = addPoint(sk, g.c[0], g.c[1]), a = addPoint(sk, g.a[0], g.a[1]), b = addPoint(sk, g.b[0], g.b[1]);
      const ar = addArc(sk, c, a, b, construction);
      addRel(sk, 'projected', [ar], { src: s, pts: { [c]: g.c, [a]: g.a, [b]: g.b } });
      out.push(ar);
    }
  });
  return out;
}

// Update a projected constraint's targets from freshly projected primitives.
export function updateProjected(sk, k, prims) {
  const g = prims[k.src.idx ?? 0];
  if (!g || prims.length !== (k.src.of ?? prims.length)) return false;
  const target = k.refs[0];
  const c = getCurve(sk, target);
  if (!c) { if (g.type === 'point') { k.pts = { [target]: g.p }; return true; } return false; }
  if (c.type === 'spline' && g.type === 'spline') {
    if (c.pts.length !== g.pts.length || !!c.ctrl !== !!g.ctrl || !!c.closed !== !!g.closed) return false;
    if ((c.handles?.length || 0) !== (g.handles?.length || 0)) return false;
    if (c.ctrl) { c.degree = g.degree; if (g.weights) c.weights = [...g.weights]; else delete c.weights; }
    k.pts = Object.fromEntries([...c.pts.map((p, i) => [p, g.pts[i]]), ...(c.handles || []).map((p, i) => [p, g.handles[i]])]);
  }
  else if (c.type === 'line' && g.type === 'line') k.pts = { [c.p1]: g.a, [c.p2]: g.b };
  else if (c.type === 'circle' && g.type === 'circle') { k.pts = { [c.c]: g.c }; k.r = g.r; }
  else if (c.type === 'arc' && g.type === 'arc') k.pts = { [c.c]: g.c, [c.p1]: g.a, [c.p2]: g.b };
  else return false;
  return true;
}

// Projected edges can share an endpoint until a source edit (e.g. a fillet) separates them.
// Split only targets that now disagree, after all projection targets have been refreshed.
export function splitProjectedPoints(sk) {
  const uses = new Map();
  for (const k of sk.constraints) {
    if (k.type !== 'projected') continue;
    for (const [id, xy] of Object.entries(k.pts || {})) {
      if (!uses.has(id)) uses.set(id, []);
      uses.get(id).push({ k, xy });
    }
  }
  let split = 0;
  for (const [id, targets] of uses) {
    if (id === 'O') continue;
    const groups = [];
    for (const target of targets) {
      let g = groups.find((g) => Math.hypot(g[0].xy[0] - target.xy[0], g[0].xy[1] - target.xy[1]) < EPS);
      if (!g) { g = []; groups.push(g); }
      g.push(target);
    }
    for (const group of groups.slice(1)) {
      const next = addPoint(sk, ...group[0].xy);
      if (getPoint(sk, id)?.keep) getPoint(sk, next).keep = true;
      for (const { k, xy } of group) {
        const c = getCurve(sk, k.refs[0]);
        if (c) {
          for (const curve of sk.curves.filter((q) => q === c || q.ctrlOf === c.id)) {
            for (const key of ['p1', 'p2', 'c', 'a']) if (curve[key] === id) curve[key] = next;
            if (curve.pts) curve.pts = curve.pts.map((p) => p === id ? next : p);
            if (curve.handles) curve.handles = curve.handles.map((p) => p === id ? next : p);
          }
        } else if (k.refs[0] === id) k.refs[0] = next;
        delete k.pts[id]; k.pts[next] = xy;
      }
      split++;
    }
  }
  return split;
}

// ------------------------------------------------------------ hit testing & intersections
function prim(sk, c) {
  if (c.type === 'line') {
    const a = getPoint(sk, c.p1), b = getPoint(sk, c.p2);
    return { kind: 'seg', ax: a.x, ay: a.y, bx: b.x, by: b.y };
  }
  if (c.type === 'circle') {
    const C = getPoint(sk, c.c);
    return { kind: 'circ', cx: C.x, cy: C.y, r: c.r, a0: 0, span: TAU, full: true };
  }
  const A = arcAngles(sk, c);
  return { kind: 'circ', cx: A.cx, cy: A.cy, r: A.r, a0: A.a0, span: A.span, full: false };
}

const normAng = (a) => ((a % TAU) + TAU) % TAU;
function inArc(p, x, y, tol = 1e-9) {
  if (p.full) return true;
  const u = normAng(Math.atan2(y - p.cy, x - p.cx) - p.a0);
  return u <= p.span + tol || u >= TAU - tol;
}

// (splines: along their points)
function polyClosest(pts, x, y) {
  let best = { d: Infinity, x: pts[0][0], y: pts[0][1] };
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, L2 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0));
    const qx = ax + t * dx, qy = ay + t * dy, d = Math.hypot(x - qx, y - qy);
    if (d < best.d) best = { d, x: qx, y: qy };
  }
  return best;
}
export function distToCurve(sk, c, x, y) {
  if (c.type === 'spline' || isEll(c)) return polyClosest(curvePoints(sk, c, 192), x, y).d;
  const p = prim(sk, c);
  if (p.kind === 'seg') return segDist(x, y, p.ax, p.ay, p.bx, p.by);
  if (inArc(p, x, y, 0)) return Math.abs(Math.hypot(x - p.cx, y - p.cy) - p.r);
  const s = getPoint(sk, c.p1), e = getPoint(sk, c.p2);
  return Math.min(Math.hypot(x - s.x, y - s.y), Math.hypot(x - e.x, y - e.y));
}

export function segDist(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

// Closest point on a curve (used for "on curve" snapping).
export function closestOnCurve(sk, c, x, y) {
  if (c.type === 'spline' || isEll(c)) { const q = polyClosest(curvePoints(sk, c, 192), x, y); return { x: q.x, y: q.y }; }
  const p = prim(sk, c);
  if (p.kind === 'seg') {
    const dx = p.bx - p.ax, dy = p.by - p.ay, L2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, L2 ? ((x - p.ax) * dx + (y - p.ay) * dy) / L2 : 0));
    return { x: p.ax + t * dx, y: p.ay + t * dy };
  }
  const a = Math.atan2(y - p.cy, x - p.cx);
  return { x: p.cx + p.r * Math.cos(a), y: p.cy + p.r * Math.sin(a) };
}

export function intersect(sk, c1, c2) {
  if (c1.type === 'spline' || c2.type === 'spline' || isEll(c1) || isEll(c2)) {
    // along the points of either (closely spaced on a spline)
    const pa = curvePoints(sk, c1, 192), pb = curvePoints(sk, c2, 192), out = [];
    for (let i = 0; i + 1 < pa.length; i++) {
      for (let j = 0; j + 1 < pb.length; j++) {
        const o1 = [], o2 = [];
        segSegParams([...pa[i], ...pa[i + 1]], [...pb[j], ...pb[j + 1]], o1, o2);
        for (const t of o1) {
          const x = pa[i][0] + (pa[i + 1][0] - pa[i][0]) * t, y = pa[i][1] + (pa[i + 1][1] - pa[i][1]) * t;
          if (!out.some((q) => Math.hypot(q.x - x, q.y - y) < 1e-6)) out.push({ x, y });
        }
      }
    }
    return out;
  }
  const A = prim(sk, c1), B = prim(sk, c2);
  let pts = [];
  if (A.kind === 'seg' && B.kind === 'seg') {
    const r = [];
    const o1 = [], o2 = [];
    segSegParams([A.ax, A.ay, A.bx, A.by], [B.ax, B.ay, B.bx, B.by], o1, o2);
    for (const t of o1) r.push({ x: A.ax + (A.bx - A.ax) * t, y: A.ay + (A.by - A.ay) * t });
    return r;
  }
  if (A.kind === 'seg' || B.kind === 'seg') {
    const S = A.kind === 'seg' ? A : B, C = A.kind === 'seg' ? B : A;
    const dx = S.bx - S.ax, dy = S.by - S.ay, fx = S.ax - C.cx, fy = S.ay - C.cy;
    const a = dx * dx + dy * dy, b = 2 * (fx * dx + fy * dy), cc = fx * fx + fy * fy - C.r * C.r;
    let disc = b * b - 4 * a * cc;
    if (disc < -1e-9 * a) return [];
    disc = Math.sqrt(Math.max(0, disc));
    for (const t of disc < 1e-12 ? [-b / (2 * a)] : [(-b - disc) / (2 * a), (-b + disc) / (2 * a)]) {
      if (t < -1e-9 || t > 1 + 1e-9) continue;
      const x = S.ax + dx * t, y = S.ay + dy * t;
      if (inArc(C, x, y, 1e-7)) pts.push({ x, y });
    }
    return pts;
  }
  const dx = B.cx - A.cx, dy = B.cy - A.cy, d = Math.hypot(dx, dy);
  if (d < 1e-12 || d > A.r + B.r + 1e-9 || d < Math.abs(A.r - B.r) - 1e-9) return [];
  const a = (A.r * A.r - B.r * B.r + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, A.r * A.r - a * a));
  const mx = A.cx + (a * dx) / d, my = A.cy + (a * dy) / d;
  const cand = h < 1e-12 ? [{ x: mx, y: my }] : [{ x: mx + (h * dy) / d, y: my - (h * dx) / d }, { x: mx - (h * dy) / d, y: my + (h * dx) / d }];
  return cand.filter((p) => inArc(A, p.x, p.y, 1e-7) && inArc(B, p.x, p.y, 1e-7));
}

// Parameter of a point along a curve: lines 0..1, circles angle 0..2π, arcs angle from start 0..span.
function paramOf(sk, c, x, y) {
  if (isEll(c)) { const { g, t0 } = ellipseRange(sk, c); return (((ellipseParam(g, x, y) - (c.type === 'earc' ? t0 : 0)) % TAU) + TAU) % TAU; }
  const p = prim(sk, c);
  if (p.kind === 'seg') {
    const dx = p.bx - p.ax, dy = p.by - p.ay;
    return ((x - p.ax) * dx + (y - p.ay) * dy) / (dx * dx + dy * dy || 1);
  }
  return normAng(Math.atan2(y - p.cy, x - p.cx) - p.a0);
}

function cutsOn(sk, c) {
  const cuts = [];
  for (const o of sk.curves) {
    if (o.id === c.id) continue;
    for (const pt of intersect(sk, c, o)) cuts.push({ t: paramOf(sk, c, pt.x, pt.y), x: pt.x, y: pt.y, other: o.id });
  }
  return cuts;
}

// Portion of a curve that Trim would remove at (x, y), as {lo, hi} params or 'all'.
function trimSpan(sk, c, x, y) {
  const cuts = cutsOn(sk, c);
  const tc = paramOf(sk, c, x, y);
  if (c.type === 'circle' || c.type === 'ellipse') {
    const ts = [...new Set(cuts.map((k) => +k.t.toFixed(9)))];
    if (ts.length < 2) return { all: true, cuts };
    const below = cuts.filter((k) => k.t < tc), above = cuts.filter((k) => k.t > tc);
    const lo = below.length ? below.reduce((a, b) => (b.t > a.t ? b : a)) : cuts.reduce((a, b) => (b.t > a.t ? b : a));
    const hi = above.length ? above.reduce((a, b) => (b.t < a.t ? b : a)) : cuts.reduce((a, b) => (b.t < a.t ? b : a));
    return { lo, hi, cuts, circle: true };
  }
  const end = c.type === 'line' ? 1 : c.type === 'earc' ? ellipseRange(sk, c).span : arcAngles(sk, c).span;
  const tol = c.type === 'line' ? 1e-7 : 1e-7;
  const inner = cuts.filter((k) => k.t > tol && k.t < end - tol);
  const below = inner.filter((k) => k.t < tc), above = inner.filter((k) => k.t > tc);
  const lo = below.length ? below.reduce((a, b) => (b.t > a.t ? b : a)) : null;
  const hi = above.length ? above.reduce((a, b) => (b.t < a.t ? b : a)) : null;
  if (!lo && !hi) return { all: true, cuts };
  return { lo, hi, cuts, end };
}

// Polyline of the portion Trim would remove (for hover preview).
// (a spline is only trimmed away whole, when nothing crosses it)
const splineCrossed = (sk, c) => sk.curves.some((o) => o.id !== c.id && intersect(sk, c, o).length);
export function trimPreview(sk, c, x, y) {
  if (c.type === 'spline') return splineCrossed(sk, c) ? null : curvePoints(sk, c);
  const s = trimSpan(sk, c, x, y);
  if (s.all) return curvePoints(sk, c);
  if (isEll(c)) {
    // the span between the cuts either side, along the ellipse
    const { g, t0 } = ellipseRange(sk, c), off = c.type === 'earc' ? t0 : 0;
    let a = s.lo ? s.lo.t : 0, b = s.hi ? s.hi.t : s.end;
    if (s.circle && b <= a) b += TAU;
    return Array.from({ length: 49 }, (_, i) => ellipseAt(g, off + a + ((b - a) * i) / 48));
  }
  const p = prim(sk, c);
  if (p.kind === 'seg') {
    const t0 = s.lo ? s.lo.t : 0, t1 = s.hi ? s.hi.t : 1;
    return [[p.ax + (p.bx - p.ax) * t0, p.ay + (p.by - p.ay) * t0], [p.ax + (p.bx - p.ax) * t1, p.ay + (p.by - p.ay) * t1]];
  }
  let u0, u1;
  if (s.circle) { u0 = s.lo.t; u1 = s.hi.t; if (u1 <= u0) u1 += TAU; }
  else { u0 = s.lo ? s.lo.t : 0; u1 = s.hi ? s.hi.t : s.end; }
  const pts = [];
  const n = Math.max(4, Math.ceil(((u1 - u0) / TAU) * 96));
  for (let i = 0; i <= n; i++) {
    const t = p.a0 + u0 + ((u1 - u0) * i) / n;
    pts.push([p.cx + p.r * Math.cos(t), p.cy + p.r * Math.sin(t)]);
  }
  return pts;
}

function pointForCut(sk, cut) {
  for (const p of [ORIGIN, ...sk.points]) if (Math.hypot(p.x - cut.x, p.y - cut.y) < 1e-6) return p.id;
  const id = addPoint(sk, cut.x, cut.y);
  addRel(sk, 'onCurve', [id, cut.other]);
  return id;
}

// Power trim: remove the clicked portion of a curve between its nearest intersections.
export function trimAt(sk, curveId, x, y) {
  const c = getCurve(sk, curveId);
  if (!c) return false;
  if (c.type === 'spline') { if (splineCrossed(sk, c)) return false; deleteItems(sk, [curveId]); return true; }
  const s = trimSpan(sk, c, x, y);
  if (s.all) { deleteItems(sk, [curveId]); return true; }

  if (c.type === 'circle' || c.type === 'ellipse') {
    const p1 = pointForCut(sk, s.hi), p2 = pointForCut(sk, s.lo);
    c.type = c.type === 'circle' ? 'arc' : 'earc';
    c.p1 = p1; c.p2 = p2;
    delete c.r;
    cleanup(sk);
    return true;
  }

  const replaceEnd = (end, newId) => {
    const old = c[end];
    const other = c[end === 'p1' ? 'p2' : 'p1'];
    c[end] = newId;
    // dimensions/relations tied to the removed portion no longer make sense
    sk.constraints = sk.constraints.filter((k) => !(k.refs.includes(old) && (k.refs.includes(other) || k.refs.includes(c.id))));
  };
  if (s.lo && s.hi) {
    const oldP2 = c.p2;
    const pLo = pointForCut(sk, s.lo), pHi = pointForCut(sk, s.hi);
    replaceEnd('p2', pLo);
    if (c.type === 'line') {
      const nl = addLine(sk, pHi, oldP2, c.construction);
      for (const k of sk.constraints.filter((k) => (k.type === 'horizontal' || k.type === 'vertical') && k.refs.length === 1 && k.refs[0] === c.id)) addRel(sk, k.type, [nl]);
      if (!sk.constraints.some((k) => (k.type === 'horizontal' || k.type === 'vertical') && k.refs[0] === c.id)) addRel(sk, 'collinear', [c.id, nl]);
    } else {
      if (c.type === 'earc') { const ne = addEllipse(sk, c.c, c.a, c.r2, c.construction); Object.assign(getCurve(sk, ne), { type: 'earc', p1: pHi, p2: oldP2 }); }
      else { const na = addArc(sk, c.c, pHi, oldP2, c.construction); addRel(sk, 'equal', [c.id, na]); }
    }
    sk.constraints = sk.constraints.filter((k) => !(k.type === 'midpoint' && k.refs[1] === c.id));
  } else if (s.hi) {
    replaceEnd('p1', pointForCut(sk, s.hi));
  } else {
    replaceEnd('p2', pointForCut(sk, s.lo));
  }
  sk.constraints = sk.constraints.filter((k) => !(k.type === 'midpoint' && k.refs[1] === c.id));
  cleanup(sk);
  return true;
}

// ------------------------------------------------------------ chains
// Connected runs of curves joined end to end (a circle is a chain of its own). Points tied by
// coincident relations count as one. Items are { c: curve, rev } in traversal order, where
// rev means the curve is walked from p2 to p1. Only curves of the same kind (construction or
// not) are joined.
export function curveChains(sk, { includeConstruction = false } = {}) {
  const parent = new Map();
  const find = (a) => { while (parent.has(a) && parent.get(a) !== a) a = parent.get(a); return a; };
  for (const k of sk.constraints) {
    if (k.type !== 'coincident') continue;
    const a = find(k.refs[0]), b = find(k.refs[1]);
    if (a !== b) parent.set(a, b);
  }
  const curves = sk.curves.filter((c) => includeConstruction || !c.construction);
  const ends = new Map();
  for (const c of curves) {
    if (c.type === 'circle' || c.type === 'ellipse' || (c.type === 'spline' && c.closed)) continue;
    for (const end of ['p1', 'p2']) {
      // construction and regular curves meet in separate "graphs"
      const n = find(c[end]) + (c.construction ? '|c' : '|r');
      if (!ends.has(n)) ends.set(n, []);
      ends.get(n).push({ c, end });
    }
  }
  const used = new Set(), chains = [];
  const exitOf = (it) => (it.rev ? it.c.p1 : it.c.p2);
  const entryOf = (it) => (it.rev ? it.c.p2 : it.c.p1);
  const step = (pid, cur) => {
    const list = ends.get(find(pid) + (cur.construction ? '|c' : '|r')) || [];
    if (list.length !== 2) return null; // a branch or a dead end stops the chain
    const nx = list.find((e) => e.c !== cur);
    return nx && !used.has(nx.c.id) ? nx : null;
  };
  for (const c0 of curves) {
    if (used.has(c0.id)) continue;
    used.add(c0.id);
    if (c0.type === 'circle' || c0.type === 'ellipse' || (c0.type === 'spline' && c0.closed)) { chains.push({ items: [{ c: c0, rev: false }], closed: true }); continue; }
    const items = [{ c: c0, rev: false }];
    for (let cur = items[0]; ;) {
      const nx = step(exitOf(cur), cur.c);
      if (!nx) break;
      used.add(nx.c.id);
      cur = { c: nx.c, rev: nx.end === 'p2' };
      items.push(cur);
    }
    for (let cur = items[0]; ;) {
      const nx = step(entryOf(cur), cur.c);
      if (!nx) break;
      used.add(nx.c.id);
      cur = { c: nx.c, rev: nx.end === 'p1' };
      items.unshift(cur);
    }
    const closed = items.length > 1 && find(entryOf(items[0])) === find(exitOf(items[items.length - 1])) && (ends.get(find(entryOf(items[0])) + (c0.construction ? '|c' : '|r')) || []).length === 2;
    chains.push({ items, closed });
  }
  return chains;
}

export function chainOf(sk, curveId) {
  return curveChains(sk, { includeConstruction: true }).find((ch) => ch.items.some((it) => it.c.id === curveId)) || null;
}

// Exact segments of a chain in traversal order (for building kernel wires).
export function chainSegs(sk, chain) {
  return chain.items.flatMap(({ c, rev }) => {
    if (c.type === 'spline') { const n = splinePieces(sk, c).length; return rev ? splineSegs(sk, c, n, 0) : splineSegs(sk, c, 0, n); }
    if (isEll(c)) { const { g, t0, span } = ellipseRange(sk, c); return rev ? ellipseBeziers(g, t0 + span, t0) : ellipseBeziers(g, t0, t0 + span); }
    if (c.type === 'circle') { const C = getPoint(sk, c.c); return { type: 'circle', c: [C.x, C.y], r: c.r }; }
    const A = getPoint(sk, c.p1), B = getPoint(sk, c.p2);
    let a = [A.x, A.y], b = [B.x, B.y];
    if (c.type === 'line') return rev ? { type: 'line', a: b, b: a } : { type: 'line', a, b };
    const g = arcAngles(sk, c), t = g.a0 + g.span / 2;
    const m = [g.cx + g.r * Math.cos(t), g.cy + g.r * Math.sin(t)];
    if (rev) [a, b] = [b, a];
    return { type: 'arc', a, m, b };
  });
}

// ------------------------------------------------------------ offset entities
// Signed offset distance of point (x, y) from a chain: positive on the left of the traversal.
export function chainSide(sk, chain, x, y) {
  let best = null, bd = Infinity;
  for (const it of chain.items) {
    const d = distToCurve(sk, it.c, x, y);
    if (d < bd) { bd = d; best = it; }
  }
  const { c, rev } = best;
  if (c.type === 'line') {
    const A = getPoint(sk, c.p1), B = getPoint(sk, c.p2);
    let dx = B.x - A.x, dy = B.y - A.y;
    if (rev) { dx = -dx; dy = -dy; }
    const L = Math.hypot(dx, dy) || 1;
    return (dx * (y - A.y) - dy * (x - A.x)) / L;
  }
  const C = getPoint(sk, c.c), r = radiusOf(sk, c), dist = Math.hypot(x - C.x, y - C.y);
  return rev ? dist - r : r - dist; // walked counter-clockwise, the left side is inside
}

function lineLine(a1, b1, a2, b2) {
  const d1 = [b1[0] - a1[0], b1[1] - a1[1]], d2 = [b2[0] - a2[0], b2[1] - a2[1]];
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-12 * (Math.hypot(...d1) * Math.hypot(...d2) || 1)) return [];
  const t = ((a2[0] - a1[0]) * d2[1] - (a2[1] - a1[1]) * d2[0]) / den;
  return [[a1[0] + t * d1[0], a1[1] + t * d1[1]]];
}
function lineCircle(a, b, c, r) {
  const dx = b[0] - a[0], dy = b[1] - a[1], fx = a[0] - c[0], fy = a[1] - c[1];
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < -1e-9 * A * r * r || A < 1e-18) return [];
  const sq = Math.sqrt(Math.max(0, disc));
  return [(-B - sq) / (2 * A), (-B + sq) / (2 * A)].map((t) => [a[0] + t * dx, a[1] + t * dy]);
}
function circleCircle(c1, r1, c2, r2) {
  const d = Math.hypot(c2[0] - c1[0], c2[1] - c1[1]);
  if (d < 1e-12 || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const ux = (c2[0] - c1[0]) / d, uy = (c2[1] - c1[1]) / d, mx = c1[0] + a * ux, my = c1[1] + a * uy;
  return [[mx - h * uy, my + h * ux], [mx + h * uy, my - h * ux]];
}

// Geometry of a chain offset by d (positive = left of the traversal). Corners are re-joined
// where the offset curves meet, so they extend or trim as needed.
// Returns { items: [{ it, type, entry, exit, a, b, c, r }], error }.
export function offsetChain(sk, chain, d) {
  if(!chain?.items?.length||!Number.isFinite(d))return {items:[],error:'Select a nonempty chain and a finite offset distance'};
  if (chain.items.some((it) => it.c.type === 'spline' || isEll(it.c))) return { items: [], error: 'A spline or ellipse cannot be offset (yet): offset the lines and arcs, or draw the second curve' };
  const out = chain.items.map((it) => {
    const { c, rev } = it;
    if (c.type === 'line') {
      const A = getPoint(sk, c.p1), B = getPoint(sk, c.p2);
      let tx = B.x - A.x, ty = B.y - A.y;
      if (rev) { tx = -tx; ty = -ty; }
      const L = Math.hypot(tx, ty) || 1, nx = (-ty / L) * d, ny = (tx / L) * d;
      const a = [A.x + nx, A.y + ny], b = [B.x + nx, B.y + ny];
      return { it, type: 'line', a, b, entry: rev ? b : a, exit: rev ? a : b };
    }
    const C = getPoint(sk, c.c), r0 = radiusOf(sk, c);
    const r = c.type === 'circle' || !rev ? r0 - d : r0 + d;
    const o = { it, type: c.type, c: [C.x, C.y], r };
    if (c.type === 'arc') {
      const P1 = getPoint(sk, c.p1), P2 = getPoint(sk, c.p2);
      const at = (P) => { const L = Math.hypot(P.x - C.x, P.y - C.y) || 1; return [C.x + ((P.x - C.x) / L) * r, C.y + ((P.y - C.y) / L) * r]; };
      o.a = at(P1); o.b = at(P2);
      o.entry = rev ? o.b : o.a; o.exit = rev ? o.a : o.b;
    }
    return o;
  });
  if (out.some((o) => o.r !== undefined && o.r <= 1e-9)) return { items: out, error: 'The offset is larger than an arc radius on the inside' };
  const meet = (p, q) => {
    const ref = [(p.exit[0] + q.entry[0]) / 2, (p.exit[1] + q.entry[1]) / 2];
    let pts;
    if (p.type === 'line' && q.type === 'line') pts = lineLine(p.a, p.b, q.a, q.b);
    else if (p.type === 'line') pts = lineCircle(p.a, p.b, q.c, q.r);
    else if (q.type === 'line') pts = lineCircle(q.a, q.b, p.c, p.r);
    else pts = circleCircle(p.c, p.r, q.c, q.r);
    if (!pts.length) return ref;
    return pts.reduce((best, x) => (Math.hypot(x[0] - ref[0], x[1] - ref[1]) < Math.hypot(best[0] - ref[0], best[1] - ref[1]) ? x : best));
  };
  const n = out.length;
  if (out[0].type !== 'circle') {
    for (let i = 0; i < n - (chain.closed ? 0 : 1); i++) {
      const p = out[i], q = out[(i + 1) % n];
      const j = meet(p, q);
      p.exit = j; q.entry = j;
    }
    for (const o of out) {
      if (o.type === 'line' || o.type === 'arc') {
        if (o.it.rev) { o.a = o.exit; o.b = o.entry; } else { o.a = o.entry; o.b = o.exit; }
      }
    }
  }
  return { items: out, error: null };
}

// Polylines for previewing an offset.
export function offsetPreview(sk, chain, d) {
  const g = offsetChain(sk, chain, d);
  if(g.error)return [];
  return g.items.map((o) => {
    if (o.type === 'line') return [o.a, o.b];
    let a0 = 0, span = TAU;
    if (o.type === 'arc') {
      a0 = Math.atan2(o.a[1] - o.c[1], o.a[0] - o.c[0]);
      span = Math.atan2(o.b[1] - o.c[1], o.b[0] - o.c[0]) - a0;
      while (span <= 1e-9) span += TAU;
    }
    const pts = [], m = Math.max(8, Math.ceil((span / TAU) * 96));
    for (let i = 0; i <= m; i++) { const t = a0 + (span * i) / m; pts.push([o.c[0] + o.r * Math.cos(t), o.c[1] + o.r * Math.sin(t)]); }
    return pts;
  });
}

// Create the offset of a chain: new curves joined at their corners, an Offset relation per
// curve (parallel / concentric at the offset distance) and one driving dimension.
export function buildOffset(sk, chain, d, { construction = !!chain.items[0].c.construction } = {}) {
  const g = offsetChain(sk, chain, d);
  if (g.error) throw new Error(g.error);
  const items = g.items, n = items.length;
  const created = [];
  const joins = [];
  const newPt = (p) => { const id = addPoint(sk, p[0], p[1]); created.push(id); return id; };
  if (items[0].type !== 'circle') {
    // shared corner points between consecutive curves
    for (let i = 0; i < n; i++) joins.push({ entry: null, exit: null });
    for (let i = 0; i < n; i++) {
      if (i > 0) joins[i].entry = joins[i - 1].exit;
      else if (chain.closed) joins[i].entry = null; // set after the loop
      if (!joins[i].entry) joins[i].entry = newPt(items[i].entry);
      joins[i].exit = chain.closed && i === n - 1 ? joins[0].entry : newPt(items[i].exit);
    }
  }
  const dim = addRel(sk, 'dim', [], { kind: 'offset', value: +Math.abs(d).toFixed(4) });
  items.forEach((o, i) => {
    const src = o.it.c;
    let id, s;
    if (o.type === 'circle') {
      id = addCircle(sk, src.c, o.r, construction);
      s = o.r >= src.r ? 1 : -1;
    } else {
      const { entry, exit } = joins[i];
      const [p1, p2] = o.it.rev ? [exit, entry] : [entry, exit];
      if (o.type === 'line') {
        id = addLine(sk, p1, p2, construction);
        const A = getPoint(sk, src.p1), B = getPoint(sk, src.p2), P = getPoint(sk, p1), Q = getPoint(sk, p2);
        const mx = (P.x + Q.x) / 2, my = (P.y + Q.y) / 2;
        s = (B.x - A.x) * (my - A.y) - (B.y - A.y) * (mx - A.x) >= 0 ? 1 : -1;
      } else {
        id = addArc(sk, src.c, p1, p2, construction);
        s = o.r >= radiusOf(sk, src) ? 1 : -1;
      }
    }
    created.push(id);
    const ends = [];
    if (!chain.closed && o.type !== 'circle') {
      const srcEntry = o.it.rev ? src.p2 : src.p1, srcExit = o.it.rev ? src.p1 : src.p2;
      if (i === 0) ends.push([joins[i].entry, srcEntry]);
      if (i === n - 1) ends.push([joins[i].exit, srcExit]);
    }
    addRel(sk, 'offset', [src.id, id], { s, dim: dim.id, v: Math.abs(d), ...(ends.length ? { ends } : {}) });
    if (i === 0) dim.refs = [src.id, id];
  });
  return { dim, created };
}

// ------------------------------------------------------------ thin features
// Sampled outline of exact segments (for areas and containment tests).
function segsPoly(segs) {
  const pts = [];
  for (const g of segs) {
    if (g.type === 'circle') { for (let i = 0; i < 48; i++) { const t = (i / 48) * TAU; pts.push([g.c[0] + g.r * Math.cos(t), g.c[1] + g.r * Math.sin(t)]); } continue; }
    pts.push(g.a);
    if (g.type === 'arc') pts.push(g.m);
    if (g.type === 'bezier') for (let i = 1; i < 8; i++) pts.push(bezierAt(g, i / 8));
  }
  return pts;
}

// Exact segments, in traversal order, of a chain offset by d (see offsetChain).
function offsetSegs(sk, chain, d) {
  const g = offsetChain(sk, chain, d);
  if (g.error) throw new Error(g.error.replace('The offset', 'The wall thickness'));
  return g.items.map((o) => {
    if (o.type === 'circle') return { type: 'circle', c: o.c, r: o.r };
    if (o.type === 'line') return { type: 'line', a: o.entry, b: o.exit };
    // arcs run counter-clockwise from o.a to o.b; the middle point doesn't depend on the direction
    const a0 = Math.atan2(o.a[1] - o.c[1], o.a[0] - o.c[0]);
    let span = Math.atan2(o.b[1] - o.c[1], o.b[0] - o.c[0]) - a0;
    while (span <= 1e-9) span += TAU;
    const t = a0 + span / 2;
    return { type: 'arc', a: o.entry, b: o.exit, m: [o.c[0] + o.r * Math.cos(t), o.c[1] + o.r * Math.sin(t)] };
  });
}

const reverseSegs = (segs) => segs.slice().reverse().map((g) => (g.type === 'circle' ? g : g.type === 'bezier' ? { ...g, a: g.b, b: g.a, c1: g.c2, c2: g.c1 } : { ...g, a: g.b, b: g.a }));

// Profile regions of a thin feature: every (non-construction) chain of the sketch becomes a wall
// of thickness t. dir: 'one' = outside a closed chain / left of an open one, 'other' = the other
// side, 'mid' = half on each side. Same format as profileRegions.
export function thinRegions(sk, t, dir = 'one') {
  if (!(t > 0)) throw new Error('The wall thickness must be greater than zero');
  const regions = [];
  for (const ch of curveChains(sk)) {
    // positive offsets go to the left of the traversal; for a closed chain, s makes them go outside
    const s = ch.closed && signedArea(segsPoly(chainSegs(sk, ch))) > 0 ? -1 : 1;
    const [d1, d2] = dir === 'mid' ? [(s * t) / 2, (-s * t) / 2] : dir === 'other' ? [0, -s * t] : [0, s * t];
    const A = offsetSegs(sk, ch, d1), B = offsetSegs(sk, ch, d2);
    if (ch.closed) {
      const la = { segs: A, poly: segsPoly(A) }, lb = { segs: B, poly: segsPoly(B) };
      const [outer, inner] = Math.abs(signedArea(la.poly)) >= Math.abs(signedArea(lb.poly)) ? [la, lb] : [lb, la];
      regions.push({ outer, holes: [inner] });
    } else {
      // one side, a straight end, the other side backwards, the other end
      const R = reverseSegs(B);
      const segs = [...A, { type: 'line', a: A[A.length - 1].b, b: R[0].a }, ...R, { type: 'line', a: R[R.length - 1].b, b: A[0].a }];
      regions.push({ outer: { segs, poly: segsPoly(segs) }, holes: [] });
    }
  }
  if (!regions.length) throw new Error('The sketch has no (non-construction) curves');
  return regions;
}

// ------------------------------------------------------------ involute gears
// A gear train: gears centred on sketch points, meshing along sketch lines between them (the
// lines are references, e.g. centerlines). Stored in sk.gearTrains:
//   { id, centers: [point ids], lines: [line ids], teeth: [per gear], module, pa (pressure angle, °),
//     backlash (mm, per mesh), clearance (extra tip/root gap, mm), bore (hole diameter, 0 = none),
//     phase0 (turn of the first gear, °), fit (line lengths set to the mesh distance), dims: { lineId: dimId } }
// The gears are generated geometry: they follow their centre points but are not part of the solver.
const inv = (a) => Math.tan(a) - a;

// Closed outline (CCW points) of one involute gear.
// g: { cx, cy, z, m, pa, backlash, clearance, phase (radians: angle of a tooth centre) }
export function gearOutline(g) {
  const z = Math.max(4, Math.round(g.z)), m = g.m, a = ((g.pa || 20) * Math.PI) / 180;
  const r = (m * z) / 2, rb = r * Math.cos(a);
  let ra = r + m - (g.clearance || 0) / 2;
  const rf = Math.max(0.3 * r, r - 1.25 * m - (g.clearance || 0) / 2);
  const s = (Math.PI * m) / 2 - (g.backlash || 0) / 2; // tooth thickness on the pitch circle
  const half = (rho) => s / (2 * r) + inv(a) - inv(Math.acos(Math.min(1, rb / rho)));
  const r0 = Math.max(rb, rf);
  // pointed teeth (few teeth, large backlash): end the tip where the flanks meet
  if (half(ra) < 0.002) {
    let lo = r0, hi = ra;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (half(mid) > 0.002) lo = mid; else hi = mid; }
    ra = lo;
  }
  const N = 10;
  const flank = [];
  for (let i = 0; i <= N; i++) { const rho = r0 + (ra - r0) * (1 - Math.cos((Math.PI / 2) * (i / N))); flank.push([rho, half(rho)]); }
  const pitch = (2 * Math.PI) / z;
  const P = (rho, t) => [g.cx + rho * Math.cos(t), g.cy + rho * Math.sin(t)];
  const pts = [];
  const push = (p) => { const q = pts[pts.length - 1]; if (!q || Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-9) pts.push(p); };
  const h0 = Math.min(flank[0][1], pitch / 2 - 1e-4);
  for (let k = 0; k < z; k++) {
    const c = (g.phase || 0) + k * pitch;
    if (rf < r0) push(P(rf, c - h0)); // radial flank below the base circle
    for (const [rho, h] of flank) push(P(rho, c - h));
    const ht = flank[N][1];
    for (let j = 1; j < 4; j++) push(P(ra, c - ht + (2 * ht * j) / 4));
    for (let i = N; i >= 0; i--) push(P(flank[i][0], c + flank[i][1]));
    if (rf < r0) push(P(rf, c + h0));
    // root arc to the next tooth
    const t0 = c + h0, t1 = c + pitch - h0;
    for (let j = 1; j < 4; j++) push(P(rf, t0 + ((t1 - t0) * j) / 4));
  }
  if (pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-9) pts.pop();
  return pts;
}

// The gears of a train with their centres, sizes and turns (so neighbouring teeth mesh).
export function trainGears(sk, train) {
  const centers = train.centers || [];
  const pt = (id) => getPoint(sk, id);
  const zOf = (i) => Math.max(4, Math.round(train.teeth?.[i] || 20));
  const index = new Map(centers.map((p, i) => [p, i]));
  const edges = (train.lines || []).map((id) => getCurve(sk, id)).filter((c) => c && index.has(c.p1) && index.has(c.p2)).map((c) => [index.get(c.p1), index.get(c.p2)]);
  const phase = new Map([[0, ((train.phase0 || 0) * Math.PI) / 180]]);
  const queue = [0];
  while (queue.length) {
    const i = queue.shift();
    for (const [a, b] of edges) {
      const j = a === i ? b : b === i ? a : -1;
      if (j < 0 || phase.has(j)) continue;
      // at the meshing point the two gears' positions within a tooth pitch add up to half a pitch
      const A = pt(centers[i]), B = pt(centers[j]);
      if (!A || !B) continue;
      const th = Math.atan2(B.y - A.y, B.x - A.x);
      const pa = (2 * Math.PI) / zOf(i), pb = (2 * Math.PI) / zOf(j);
      const fa = (((th - phase.get(i)) / pa) % 1 + 1) % 1;
      const fb = ((0.5 - fa) % 1 + 1) % 1;
      phase.set(j, th + Math.PI - fb * pb);
      queue.push(j);
    }
  }
  return centers.map((pid, i) => {
    const p = pt(pid) || { x: 0, y: 0 };
    return { i, pid, cx: p.x, cy: p.y, z: zOf(i), m: +train.module || 1, pa: +train.pa || 20, backlash: +train.backlash || 0, clearance: +train.clearance || 0, bore: +train.bore || 0, phase: phase.get(i) ?? 0 };
  });
}

// Meshing gear pairs of a train: [{ line, i, j, need (centre distance for the module), have (line length) }].
export function trainMeshes(sk, train) {
  const index = new Map((train.centers || []).map((p, i) => [p, i]));
  const z = (i) => Math.max(4, Math.round(train.teeth?.[i] || 20));
  return (train.lines || []).map((id) => {
    const c = getCurve(sk, id);
    if (!c || !index.has(c.p1) || !index.has(c.p2)) return null;
    const i = index.get(c.p1), j = index.get(c.p2), A = getPoint(sk, c.p1), B = getPoint(sk, c.p2);
    return { line: id, i, j, need: ((+train.module || 1) * (z(i) + z(j))) / 2, have: Math.hypot(B.x - A.x, B.y - A.y) };
  }).filter(Boolean);
}

export const GEAR_MIN_TEETH = 6;
export const GEAR_MODULES = [0.5, 0.6, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
const gearTip = (g) => (g.m * g.z) / 2 + g.m - (g.clearance || 0) / 2;
const mm3 = (x) => +x.toFixed(3);

// Why a gear train is not a working gear set ([] when it is): meshing gears must sit exactly their
// mesh distance apart, every gear needs enough teeth, and gears that don't mesh must not overlap.
export function trainProblems(sk, train) {
  const centers = train.centers || [];
  if (!centers.length || centers.some((id) => !getPoint(sk, id))) return ['a gear centre point was deleted'];
  const meshes = trainMeshes(sk, train);
  const out = [];
  if (meshes.length !== (train.lines || []).length) out.push('a line of the gear train was deleted');
  for (const mm of meshes) {
    if (Math.abs(mm.need - mm.have) > 1e-3) out.push(`gears ${mm.i + 1} and ${mm.j + 1} don't mesh: their centres are ${mm3(mm.have)} mm apart but their teeth need ${mm3(mm.need)} mm`);
  }
  centers.forEach((_, i) => { if (Math.round(train.teeth?.[i] || 0) < GEAR_MIN_TEETH) out.push(`gear ${i + 1} needs at least ${GEAR_MIN_TEETH} teeth`); });
  const gears = trainGears(sk, train);
  const meshing = new Set(meshes.map((mm) => `${Math.min(mm.i, mm.j)}|${Math.max(mm.i, mm.j)}`));
  for (let i = 0; i < gears.length; i++) {
    for (let j = i + 1; j < gears.length; j++) {
      if (meshing.has(`${i}|${j}`)) continue;
      const d = Math.hypot(gears[j].cx - gears[i].cx, gears[j].cy - gears[i].cy);
      if (d < gearTip(gears[i]) + gearTip(gears[j])) out.push(`gears ${i + 1} and ${j + 1} overlap (they don't mesh with each other)`);
    }
  }
  return out;
}

// A module and tooth counts that make the train work with its line lengths as they are (for lines
// fixed by other dimensions): keeps the current module and first gear when it can, then tries the
// standard modules, then a module that fits the first line. null when nothing fits.
export function fitTrainTeeth(sk, train) {
  const meshes = trainMeshes(sk, train);
  const n = (train.centers || []).length;
  if (!meshes.length || !n) return null;
  const cur = +train.module || 1;
  const mods = [cur, ...GEAR_MODULES.filter((m) => Math.abs(m - cur) > 1e-9).sort((a, b) => Math.abs(Math.log(a / cur)) - Math.abs(Math.log(b / cur)))];
  const t0 = train.teeth || [], m0 = meshes[0], s0 = Math.round((t0[m0.i] || 20) + (t0[m0.j] || 20));
  for (let k = 0; k <= 300; k++) for (const s of k ? [s0 + k, s0 - k] : [s0]) if (s >= 2 * GEAR_MIN_TEETH) mods.push((2 * m0.have) / s);
  const adj = Array.from({ length: n }, () => []);
  for (const mm of meshes) { adj[mm.i].push([mm.j, mm.have]); adj[mm.j].push([mm.i, mm.have]); }
  const zc = Math.round(t0[0] || 20);
  for (const m of mods) {
    const zMax = Math.floor((2 * Math.max(...meshes.map((mm) => mm.have))) / m);
    for (let k = 0; k <= zMax; k++) {
      for (const z0 of k ? [zc + k, zc - k] : [zc]) {
        if (z0 < GEAR_MIN_TEETH || z0 > zMax) continue;
        const z = new Array(n).fill(null);
        z[0] = z0;
        const q = [0];
        let ok = true;
        while (q.length && ok) {
          const i = q.shift();
          for (const [j, d] of adj[i]) {
            const zj = (2 * d) / m - z[i], r = Math.round(zj);
            if (Math.abs(zj - r) * m > 2e-3 || r < GEAR_MIN_TEETH || (z[j] != null && z[j] !== r)) { ok = false; break; }
            if (z[j] == null) { z[j] = r; q.push(j); }
          }
        }
        if (!ok) continue;
        const teeth = z.map((v, i) => v ?? Math.round(t0[i] || 20));
        if (!trainProblems(sk, { ...train, module: +m.toFixed(6), teeth }).length) return { module: +m.toFixed(6), teeth };
      }
    }
  }
  return null;
}

// Outline polylines of all gears in a sketch (for display): [[x, y], ...][]
export function gearPolylines(sk) {
  const out = [];
  for (const tr of sk.gearTrains || []) {
    for (const g of trainGears(sk, tr)) {
      const pts = gearOutline(g);
      out.push([...pts, pts[0]]);
      if (g.bore > 0) { const b = []; for (let i = 0; i <= 48; i++) { const t = (i / 48) * TAU; b.push([g.cx + (g.bore / 2) * Math.cos(t), g.cy + (g.bore / 2) * Math.sin(t)]); } out.push(b); }
    }
  }
  return out;
}

// ------------------------------------------------------------ airfoils
// An airfoil drawn on a sketch line, the chord: its leading edge at the line's start (or end: swap),
// the camber to the line's left (or right: flip). Generated geometry like the gears: it follows the line
// (dimension the line to set the chord) but is not part of the solver. Stored in sk.airfoils:
//   { id, line, spec, sharpTE (closed trailing edge), flip, swap }
// spec: { kind: 'naca4', m (max camber, % chord), p (its position, % chord), t (thickness, % chord) }
//     | { kind: 'naca5', cl (design lift coefficient), p (max camber position, % chord), reflex, t }
//     | { kind: 'clarky', t (thickness, % chord; 11.7 as drawn by Clark) }
const NACA5 = { // camber line constants for a design lift coefficient of 0.3 (by max camber position)
  std: [[0.05, 0.0580, 361.4], [0.10, 0.1260, 51.640], [0.15, 0.2025, 15.957], [0.20, 0.2900, 6.643], [0.25, 0.3910, 3.230]],
  reflex: [[0.10, 0.1300, 51.990, 0.000764], [0.15, 0.2170, 15.793, 0.00677], [0.20, 0.3180, 6.520, 0.0303], [0.25, 0.4410, 3.191, 0.1355]],
};
// Clark Y as tabulated (x, upper, lower in % chord; from the flat lower datum, leading edge 3.5 % up)
const CLARK_Y = [
  [0, 3.50, 3.50], [1.25, 5.45, 1.93], [2.5, 6.50, 1.47], [5, 7.90, 0.93], [7.5, 8.85, 0.63], [10, 9.60, 0.42], [15, 10.68, 0.15],
  [20, 11.36, 0.03], [30, 11.70, 0], [40, 11.40, 0], [50, 10.52, 0], [60, 9.15, 0], [70, 7.35, 0], [80, 5.22, 0], [90, 2.80, 0], [95, 1.49, 0], [100, 0.12, 0],
];

// The library: common NACA sections and Clark Y.
export const AIRFOIL_LIBRARY = [
  ...['0006', '0008', '0009', '0010', '0012', '0015', '0018', '0021', '0024', '1408', '1410', '1412', '2408', '2410', '2412', '2414', '2415', '2418', '2421', '2424', '4409', '4412', '4415', '4418', '4421', '4424', '6409', '6412']
    .map((c) => ({ group: 'NACA 4-digit', spec: parseNaca(c) })),
  ...['21012', '22012', '23012', '23015', '23018', '23021', '23024', '24012', '25012', '23112']
    .map((c) => ({ group: 'NACA 5-digit', spec: parseNaca(c) })),
  ...[11.7, 8, 10, 14].map((t) => ({ group: 'Clark Y', spec: { kind: 'clarky', t } })),
];

// A NACA designation ('2412', 'NACA 23012') as a spec, or null.
export function parseNaca(code) {
  const d = String(code || '').replace(/^\s*naca\s*/i, '').replace(/[\s-]/g, '');
  if (/^\d{4}$/.test(d)) return { kind: 'naca4', m: +d[0], p: +d[1] * 10, t: +d.slice(2) };
  if (/^\d{5}$/.test(d)) return { kind: 'naca5', cl: +(0.15 * +d[0]).toFixed(4), p: +d[1] * 5, reflex: d[2] === '1', t: +d.slice(3) };
  return null;
}

// Its name: 'NACA 2412', 'NACA 23012', 'Clark Y 11.7 %', or the parameters when they have no designation.
export function airfoilName(spec) {
  if (!spec) return 'Airfoil';
  const two = (x) => String(Math.round(x)).padStart(2, '0');
  const whole = (x, k = 1) => Math.abs(x * k - Math.round(x * k)) < 1e-9;
  if (spec.kind === 'naca4') {
    if (whole(spec.m) && spec.m < 10 && whole(spec.p, 0.1) && spec.p < 100 && whole(spec.t) && spec.t < 100 && (spec.m > 0) === (spec.p > 0)) return `NACA ${Math.round(spec.m)}${Math.round(spec.p / 10)}${two(spec.t)}`;
    return `NACA 4-digit (camber ${+spec.m.toFixed(3)} % at ${+spec.p.toFixed(3)} %, ${+spec.t.toFixed(3)} % thick)`;
  }
  if (spec.kind === 'naca5') {
    if (whole(spec.cl / 0.15) && spec.cl / 0.15 < 10 && whole(spec.p / 5) && spec.p / 5 < 10 && whole(spec.t) && spec.t < 100) return `NACA ${Math.round(spec.cl / 0.15)}${Math.round(spec.p / 5)}${spec.reflex ? 1 : 0}${two(spec.t)}`;
    return `NACA 5-digit (CL ${+spec.cl.toFixed(3)}, camber at ${+spec.p.toFixed(3)} %${spec.reflex ? ', reflexed' : ''}, ${+spec.t.toFixed(3)} % thick)`;
  }
  return `Clark Y ${+spec.t.toFixed(3)} %`;
}

// Why a spec can't be drawn ('' when it can).
export function airfoilSpecProblem(spec) {
  if (!spec || !(spec.t > 0)) return 'the thickness must be more than 0 %';
  if (spec.t > 50) return 'the thickness must be at most 50 % of the chord';
  if (spec.kind === 'naca4') {
    if (!(spec.m >= 0) || spec.m >= 20) return 'the camber must be 0 to 20 % of the chord';
    if (spec.m > 0 && !(spec.p > 0 && spec.p < 100)) return 'the camber position must be between 0 and 100 % of the chord';
  } else if (spec.kind === 'naca5') {
    if (!(spec.cl >= 0) || spec.cl > 2) return 'the design lift coefficient must be 0 to 2';
    const tab = spec.reflex ? NACA5.reflex : NACA5.std;
    if (spec.cl > 0 && !(spec.p >= tab[0][0] * 100 - 1e-9 && spec.p <= tab[tab.length - 1][0] * 100 + 1e-9)) return `the camber position must be ${tab[0][0] * 100}–${tab[tab.length - 1][0] * 100} % of the chord${spec.reflex ? ' (reflexed)' : ''}`;
  } else if (spec.kind !== 'clarky') return 'unknown airfoil';
  return '';
}

// Monotone cubic interpolation (no overshoot) of y over increasing xs.
function pchip(xs, ys) {
  const n = xs.length, h = [], d = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); d.push((ys[i + 1] - ys[i]) / h[i]); }
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
  }
  return (x) => {
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

// The surfaces of an airfoil on a unit chord (leading edge at 0,0, trailing edge at 1,0, camber up):
// side(β) for β from 0 (leading edge) to π (trailing edge), x = (1 − cos β) / 2 (points close together
// at the nose, where the surface turns fastest).
export function airfoilSides(spec, sharpTE = true) {
  const t = spec.t / 100;
  let camber = () => [0, 0];
  if (spec.kind === 'naca4' && spec.m > 0) {
    const m = spec.m / 100, p = spec.p / 100;
    camber = (x) => (x < p ? [(m / (p * p)) * (2 * p * x - x * x), ((2 * m) / (p * p)) * (p - x)] : [(m / ((1 - p) ** 2)) * (1 - 2 * p + 2 * p * x - x * x), ((2 * m) / ((1 - p) ** 2)) * (p - x)]);
  } else if (spec.kind === 'naca5' && spec.cl > 0) {
    const tab = spec.reflex ? NACA5.reflex : NACA5.std, P = spec.p / 100, sc = spec.cl / 0.3;
    let i = 0;
    while (i < tab.length - 2 && P > tab[i + 1][0]) i++;
    const f = Math.max(0, Math.min(1, (P - tab[i][0]) / (tab[i + 1][0] - tab[i][0])));
    const r = tab[i][1] + f * (tab[i + 1][1] - tab[i][1]);
    const k1 = Math.exp(Math.log(tab[i][2]) + f * (Math.log(tab[i + 1][2]) - Math.log(tab[i][2]))) * sc;
    if (!spec.reflex) {
      camber = (x) => (x < r ? [(k1 / 6) * (x ** 3 - 3 * r * x * x + r * r * (3 - r) * x), (k1 / 6) * (3 * x * x - 6 * r * x + r * r * (3 - r))] : [((k1 * r ** 3) / 6) * (1 - x), (-k1 * r ** 3) / 6]);
    } else {
      const k21 = tab[i][3] + f * (tab[i + 1][3] - tab[i][3]), q = k21 * (1 - r) ** 3 + r ** 3;
      camber = (x) => (x < r ? [(k1 / 6) * ((x - r) ** 3 - q * x + r ** 3), (k1 / 6) * (3 * (x - r) ** 2 - q)]
        : [(k1 / 6) * (k21 * (x - r) ** 3 - q * x + r ** 3), (k1 / 6) * (3 * k21 * (x - r) ** 2 - q)]);
    }
  }
  if (spec.kind === 'clarky') {
    // the table as half-thickness about its mean line (scaled to the thickness asked for), interpolated
    // over √x (smooth round the nose), then turned so the chord runs from the nose to the trailing edge
    const k = spec.t / 11.7, s = CLARK_Y.map(([x]) => Math.sqrt(x / 100));
    const mean = pchip(s, CLARK_Y.map(([, u, l]) => (u + l) / 200)), half = pchip(s, CLARK_Y.map(([, u, l]) => (u - l) / 200));
    const teHalf = half(1);
    const y0 = mean(0), y1 = mean(1);
    const ang = Math.atan2(y1 - y0, 1), cs = Math.cos(ang), sn = Math.sin(ang), Lc = Math.hypot(1, y1 - y0);
    const at = (x, sign) => {
      const sx = Math.sqrt(Math.max(0, x));
      const hh = (half(sx) - (sharpTE ? x * teHalf : 0)) * k;
      const X = x, Y = mean(sx) + sign * hh - y0;
      return [(X * cs + Y * sn) / Lc, (-X * sn + Y * cs) / Lc];
    };
    return { upper: (b) => at((1 - Math.cos(b)) / 2, 1), lower: (b) => at((1 - Math.cos(b)) / 2, -1) };
  }
  const a4 = sharpTE ? 0.1036 : 0.1015;
  const yt = (x) => 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - a4 * x ** 4);
  const at = (x, sign) => {
    const [yc, dy] = camber(x), th = Math.atan(dy), h = yt(x);
    return [x - sign * h * Math.sin(th), yc + sign * h * Math.cos(th)];
  };
  return { upper: (b) => at((1 - Math.cos(b)) / 2, 1), lower: (b) => at((1 - Math.cos(b)) / 2, -1) };
}

export const airfoilById = (sk, id) => (sk.airfoils || []).find((a) => a.id === id) || null;

// Why an airfoil can't be drawn ('' when it can).
export function airfoilProblem(sk, af) {
  const c = getCurve(sk, af.line);
  if (!c || c.type !== 'line') return 'its chord line was deleted';
  const A = getPoint(sk, c.p1), B = getPoint(sk, c.p2);
  if (!A || !B || Math.hypot(B.x - A.x, B.y - A.y) < 1e-9) return 'its chord line has no length';
  return airfoilSpecProblem(af.spec);
}

// The airfoil as smooth cubic Bézier pieces in sketch coordinates, round the outline from the trailing
// edge over the upper surface to the nose and back along the lower one (+ a straight piece across a
// blunt trailing edge): [{ a, c1, c2, b }] (or { a, b } for the straight one). null when it can't be drawn.
export function airfoilPieces(sk, af, perSide = af.spec?.kind === 'clarky' ? 40 : 16) { // (Clark Y comes from a table: more pieces)
  if (airfoilProblem(sk, af)) return null;
  const c = getCurve(sk, af.line);
  let A = getPoint(sk, c.p1), B = getPoint(sk, c.p2);
  if (af.swap) [A, B] = [B, A];
  const ux = B.x - A.x, uy = B.y - A.y, L = Math.hypot(ux, uy), s = af.flip ? -1 : 1;
  const nx = (-uy / L) * s, ny = (ux / L) * s;
  const map = ([x, y]) => [A.x + x * ux + y * L * nx, A.y + x * uy + y * L * ny];
  const sides = airfoilSides(af.spec, af.sharpTE !== false);
  // Hermite pieces of one side, from the nose to the trailing edge, with tangents from the surface itself
  const piecesOf = (fn) => {
    const P = (b) => map(fn(b)), h = 1e-6;
    const D = (b) => { const b0 = Math.max(0, b - h), b1 = Math.min(Math.PI, b + h), p0 = P(b0), p1 = P(b1); return [(p1[0] - p0[0]) / (b1 - b0), (p1[1] - p0[1]) / (b1 - b0)]; };
    const out = [];
    for (let k = 0; k < perSide; k++) {
      const b0 = (Math.PI * k) / perSide, b1 = (Math.PI * (k + 1)) / perSide, db = b1 - b0;
      const a = P(b0), b = P(b1), d0 = D(b0), d1 = D(b1);
      out.push({ a, c1: [a[0] + (d0[0] * db) / 3, a[1] + (d0[1] * db) / 3], c2: [b[0] - (d1[0] * db) / 3, b[1] - (d1[1] * db) / 3], b });
    }
    return out;
  };
  const up = piecesOf(sides.upper).reverse().map((q) => ({ a: q.b, c1: q.c2, c2: q.c1, b: q.a }));
  const low = piecesOf(sides.lower);
  low[0].a = up[up.length - 1].b; // (one point at the nose)
  const pieces = [...up, ...low];
  const teU = up[0].a, teL = low[low.length - 1].b;
  if (Math.hypot(teU[0] - teL[0], teU[1] - teL[1]) > 1e-9 * L) pieces.push({ a: teL, b: teU });
  else low[low.length - 1].b = teU;
  return pieces;
}

// The airfoil's outline as a closed polyline (for display): [[x, y], …]
export function airfoilPolyline(sk, af, perPiece = 8) {
  const pieces = airfoilPieces(sk, af);
  if (!pieces) return null;
  const pts = [pieces[0].a];
  for (const q of pieces) {
    if (!q.c1) { pts.push(q.b); continue; }
    for (let i = 1; i <= perPiece; i++) {
      const t = i / perPiece, u = 1 - t;
      pts.push([u * u * u * q.a[0] + 3 * u * u * t * q.c1[0] + 3 * u * t * t * q.c2[0] + t * t * t * q.b[0], u * u * u * q.a[1] + 3 * u * u * t * q.c1[1] + 3 * u * t * t * q.c2[1] + t * t * t * q.b[1]]);
    }
  }
  return pts;
}

// Outlines of all airfoils in a sketch (for display)
export function airfoilPolylines(sk) {
  return (sk.airfoils || []).map((af) => airfoilPolyline(sk, af)).filter(Boolean);
}

// True when the sketch has curves but no closed profile (it can only be used as a thin feature).
export function isOpenSketch(sk) {
  if (sk?.texts?.length || sk?.gearTrains?.length || sk?.airfoils?.length) return false;
  if (!sk?.curves?.some((c) => !c.construction)) return false;
  try { return !profileRegions(sk).length; } catch { return false; }
}

// ------------------------------------------------------------ sketch mirror, fillet, chamfer, orientation
// Mirror curves (and points) about a line. Points on the line are shared; every other point gets a
// mirrored partner tied to it with a Symmetric relation, so the copy follows the original.
// Returns the ids of the new curves and points.
export function mirrorItems(sk, ids, axisId) {
  const ax = getCurve(sk, axisId);
  if (!ax || ax.type !== 'line') throw new Error('Mirror about a line (a centerline)');
  const A = getPoint(sk, ax.p1), B = getPoint(sk, ax.p2);
  const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy;
  if (L2 < 1e-18) throw new Error('The mirror line has no length');
  const onAxis = (p) => Math.abs(dx * (p.y - A.y) - dy * (p.x - A.x)) / Math.sqrt(L2) < 1e-7;
  const refl = (p) => {
    const t = ((p.x - A.x) * dx + (p.y - A.y) * dy) / L2;
    return [2 * (A.x + t * dx) - p.x, 2 * (A.y + t * dy) - p.y];
  };
  const created = [];
  const map = new Map();
  const mp = (id) => {
    if (map.has(id)) return map.get(id);
    const p = getPoint(sk, id);
    let nid = id;
    if (!onAxis(p)) {
      const [x, y] = refl(p);
      nid = addPoint(sk, x, y);
      created.push(nid);
      addRel(sk, 'symmetric', [id, nid, axisId]);
    }
    map.set(id, nid);
    return nid;
  };
  let n = 0;
  for (const id of ids) {
    if (id === axisId) continue;
    const c = getCurve(sk, id);
    if (!c) {
      if (sk.points.some((p) => p.id === id)) { const q = mp(id); if (q !== id) getPoint(sk, q).keep = true; n++; }
      continue;
    }
    if (c.ctrlOf && ids.includes(c.ctrlOf)) continue;
    n++;
    if (c.type === 'line') created.push(addLine(sk, mp(c.p1), mp(c.p2), c.construction));
    else if (c.type === 'spline') created.push(c.ctrl ? addCtrlSpline(sk, c.pts.map(mp), c.degree, c.construction, c.closed, c.weights) : c.handles ? addFitSpline(sk, c.pts.map(mp), c.closed, c.construction, c.handles.map(mp)) : addSpline(sk, c.pts.map(mp), c.closed, c.construction));
    else if (isEll(c)) {
      // (a reflection reverses an elliptical arc's direction, as an arc's)
      const e = addEllipse(sk, mp(c.c), mp(c.a), c.r2, c.construction);
      if (c.type === 'earc') Object.assign(getCurve(sk, e), { type: 'earc', p1: mp(c.p2), p2: mp(c.p1) });
      created.push(e);
    }
    else if (c.type === 'circle') { const ci = addCircle(sk, mp(c.c), c.r, c.construction); created.push(ci); addRel(sk, 'equal', [c.id, ci]); }
    else created.push(addArc(sk, mp(c.c), mp(c.p2), mp(c.p1), c.construction)); // a reflection reverses the arc's direction
  }
  if (!n) throw new Error('Select the entities to mirror as well as the centerline');
  return created;
}

// The two lines that meet at point P (end points), or null.
export function cornerLines(sk, P) {
  const lines = sk.curves.filter((c) => c.type === 'line' && (c.p1 === P || c.p2 === P));
  return lines.length === 2 ? lines : null;
}

// Round (r = radius) or chamfer (chamfer = true, r = distance along each line) the corner at
// point P where two lines meet. The lines are shortened to the new arc / line. The corner point
// stays as a "virtual sharp" (on both lines) when other relations or dimensions use it, and for
// a chamfer, which is dimensioned from it. Returns the ids of the new entities.
export function blendCorner(sk, P, r, chamfer = false) {
  // Joining coincident endpoints and trimming curves must not change the sketch if the blend fails.
  const trial = JSON.parse(JSON.stringify(sk));
  const created = blendCornerInPlace(trial, P, r, chamfer);
  Object.assign(sk, trial);
  return created;
}

function blendCornerInPlace(sk, P, r, chamfer) {
  if (!(r > 0)) throw new Error(chamfer ? 'The chamfer distance must be greater than zero' : 'The radius must be greater than zero');
  // A corner can be shared directly or through a chain of Coincident relations, including the origin.
  const joined = new Set([P]);
  for (const id of joined) for (const k of sk.constraints) {
    if (k.type === 'coincident' && k.refs.includes(id)) for (const q of k.refs) if (getPoint(sk, q)) joined.add(q);
  }
  if (joined.has('O')) P = 'O';
  for (const q of joined) if (q !== P) mergePoints(sk, q, P);
  let two = sk.curves.filter((c) => (c.type === 'line' || c.type === 'arc' || (c.type === 'spline' && !c.ctrl && !c.closed && !c.ctrlOf)) && (c.p1 === P || c.p2 === P));
  const regular = two.filter((c) => !c.construction);
  if (regular.length === 2) two = regular;
  // (a spline and a line or an arc: rounded along the spline, which is cut back to the fillet)
  if (two.length === 2 && two.some((c) => c.type === 'spline')) {
    if (chamfer) throw new Error('Pick a corner where exactly two lines meet');
    if (two.every((c) => c.type === 'spline')) throw new Error('A fillet between two splines is not supported yet: round a spline with a line or an arc');
    const sp = two.find((c) => c.type === 'spline');
    return filletSpline(sk, P, sp, two.find((c) => c !== sp), r);
  }
  const lines = two.length === 2 && two.every((c) => c.type === 'line') ? two : null;
  if (!lines) {
    // a line and an arc, or two arcs: rounded (not chamfered)
    if (two.length !== 2 || chamfer) throw new Error(chamfer ? 'Pick a corner where exactly two lines meet' : 'Pick a corner where exactly two lines, a line and an arc, or two arcs meet');
    return filletCurves(sk, P, two[0], two[1], r);
  }
  const [L1, L2] = lines;
  const p = getPoint(sk, P);
  const far = (L) => getPoint(sk, L.p1 === P ? L.p2 : L.p1);
  const A = far(L1), B = far(L2);
  const l1 = Math.hypot(A.x - p.x, A.y - p.y), l2 = Math.hypot(B.x - p.x, B.y - p.y);
  const u1 = [(A.x - p.x) / l1, (A.y - p.y) / l1], u2 = [(B.x - p.x) / l2, (B.y - p.y) / l2];
  const th = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
  if (th < 1e-3 || th > Math.PI - 1e-3) throw new Error('The lines are parallel, so there is no corner to blend');
  const t = chamfer ? r : r / Math.tan(th / 2);
  if (t >= l1 - 1e-9 || t >= l2 - 1e-9) throw new Error(chamfer ? 'The chamfer is longer than one of the lines' : 'The radius is too large for these lines');
  const used = P === 'O' || sk.constraints.some((k) => k.refs.includes(P));
  const T1 = addPoint(sk, p.x + u1[0] * t, p.y + u1[1] * t), T2 = addPoint(sk, p.x + u2[0] * t, p.y + u2[1] * t);
  for (const [L, T] of [[L1, T1], [L2, T2]]) { if (L.p1 === P) L.p1 = T; else L.p2 = T; }
  const created = [T1, T2];
  const construction = L1.construction && L2.construction;
  const keepSharp = () => {
    if (P !== 'O') getPoint(sk, P).keep = true;
    addRel(sk, 'onCurve', [P, L1.id]);
    addRel(sk, 'onCurve', [P, L2.id]);
  };
  if (chamfer) {
    created.push(addLine(sk, T1, T2, construction));
    keepSharp();
    addRel(sk, 'dim', [P, T1], { kind: 'distance', value: +r.toFixed(6) });
    addRel(sk, 'dim', [P, T2], { kind: 'distance', value: +r.toFixed(6) });
  } else {
    const bis = [u1[0] + u2[0], u1[1] + u2[1]], bl = Math.hypot(bis[0], bis[1]);
    const h = r / Math.sin(th / 2);
    const C = addPoint(sk, p.x + (bis[0] / bl) * h, p.y + (bis[1] / bl) * h);
    const c = getPoint(sk, C), a = getPoint(sk, T1), b = getPoint(sk, T2);
    const ccw = (a.x - c.x) * (b.y - c.y) - (a.y - c.y) * (b.x - c.x) > 0;
    const arc = ccw ? addArc(sk, C, T1, T2, construction) : addArc(sk, C, T2, T1, construction);
    addRel(sk, 'tangent', [L1.id, arc]);
    addRel(sk, 'tangent', [L2.id, arc]);
    addRel(sk, 'dim', [arc], { kind: 'radius', value: +r.toFixed(6) });
    if (used) keepSharp();
    created.push(C, arc);
  }
  return created;
}

// Round the corner at P where a line and an arc, or two arcs, meet (A, B: the two curves). The fillet's centre is r
// from both: where their offsets meet (a line's two parallels, an arc's circles r wider and r narrower); of the
// places that touch both curves within what they are (not past their other ends), the one nearest the corner. The
// curves are cut back to the fillet, which gets tangent relations and a radius dimension, as for two lines.
function filletCurves(sk, P, A, B, r) {
  const p = getPoint(sk, P), tol = 1e-9;
  const geo = (c) => {
    if (c.type === 'line') {
      const a = getPoint(sk, c.p1 === P ? c.p2 : c.p1), L = Math.hypot(a.x - p.x, a.y - p.y), u = [(a.x - p.x) / L, (a.y - p.y) / L];
      return { c, line: true, far: a, L, u, n: [-u[1], u[0]] };
    }
    const C = getPoint(sk, c.c), s = getPoint(sk, c.p1), e = getPoint(sk, c.p2), R = Math.hypot(s.x - C.x, s.y - C.y);
    const a0 = Math.atan2(s.y - C.y, s.x - C.x);
    let span = Math.atan2(e.y - C.y, e.x - C.x) - a0;
    while (span <= 0) span += 2 * Math.PI;
    return { c, line: false, C, R, a0, span };
  };
  const g1 = geo(A), g2 = geo(B);
  // the offsets: { line: point + direction } or { circle: centre, radius }
  const offsets = (g) => (g.line
    ? [1, -1].map((sg) => ({ line: true, q: [p.x + g.n[0] * r * sg, p.y + g.n[1] * r * sg], u: g.u }))
    : [g.R + r, g.R - r].filter((x) => x > tol).map((rr) => ({ line: false, C: [g.C.x, g.C.y], R: rr })));
  const meet = (o1, o2) => {
    if (o1.line && o2.line) return [];
    if (!o1.line && o2.line) return meet(o2, o1);
    if (o1.line) {
      // the line q + t u and the circle (C, R)
      const d = [o1.q[0] - o2.C[0], o1.q[1] - o2.C[1]], b = d[0] * o1.u[0] + d[1] * o1.u[1], cc = d[0] * d[0] + d[1] * d[1] - o2.R * o2.R, D = b * b - cc;
      if (D < -tol) return [];
      const sq = Math.sqrt(Math.max(0, D));
      return [-b - sq, -b + sq].map((t) => [o1.q[0] + o1.u[0] * t, o1.q[1] + o1.u[1] * t]);
    }
    // two circles
    const dx = o2.C[0] - o1.C[0], dy = o2.C[1] - o1.C[1], d = Math.hypot(dx, dy);
    if (d < tol || d > o1.R + o2.R + tol || d < Math.abs(o1.R - o2.R) - tol) return [];
    const a = (o1.R * o1.R - o2.R * o2.R + d * d) / (2 * d), h = Math.sqrt(Math.max(0, o1.R * o1.R - a * a));
    const m = [o1.C[0] + (dx * a) / d, o1.C[1] + (dy * a) / d];
    return [[m[0] - (dy * h) / d, m[1] + (dx * h) / d], [m[0] + (dy * h) / d, m[1] - (dx * h) / d]];
  };
  // where a fillet centred at O touches the curve, if within it (a line: between the corner and its other end; an
  // arc: within its sweep)
  const touch = (g, O) => {
    if (g.line) {
      const t = (O[0] - p.x) * g.u[0] + (O[1] - p.y) * g.u[1];
      return t > tol && t < g.L - tol ? [p.x + g.u[0] * t, p.y + g.u[1] * t] : null;
    }
    const v = [O[0] - g.C.x, O[1] - g.C.y], vl = Math.hypot(v[0], v[1]);
    if (vl < tol) return null;
    const T = [g.C.x + (v[0] / vl) * g.R, g.C.y + (v[1] / vl) * g.R];
    let a = Math.atan2(T[1] - g.C.y, T[0] - g.C.x) - g.a0;
    while (a < 0) a += 2 * Math.PI;
    return a > 1e-9 && a < g.span - 1e-9 ? T : null;
  };
  let best = null;
  for (const o1 of offsets(g1)) {
    for (const o2 of offsets(g2)) {
      for (const O of meet(o1, o2)) {
        const T1 = touch(g1, O), T2 = touch(g2, O);
        if (!T1 || !T2) continue;
        const cost = Math.hypot(T1[0] - p.x, T1[1] - p.y) + Math.hypot(T2[0] - p.x, T2[1] - p.y);
        if (!best || cost < best.cost) best = { O, T1, T2, cost };
      }
    }
  }
  if (!best) throw new Error('The radius is too large (or too small) for these curves: no fillet fits between them');
  const used = P === 'O' || sk.constraints.some((k) => k.refs.includes(P));
  const T1 = addPoint(sk, ...best.T1), T2 = addPoint(sk, ...best.T2), C = addPoint(sk, ...best.O);
  for (const [c, T] of [[A, T1], [B, T2]]) { if (c.p1 === P) c.p1 = T; else c.p2 = T; }
  const construction = A.construction && B.construction;
  const c = getPoint(sk, C), a = getPoint(sk, T1), b = getPoint(sk, T2);
  const ccw = (a.x - c.x) * (b.y - c.y) - (a.y - c.y) * (b.x - c.x) > 0;
  const arc = ccw ? addArc(sk, C, T1, T2, construction) : addArc(sk, C, T2, T1, construction);
  // (the solver takes a line first in a tangent relation)
  for (const g of [A, B]) addRel(sk, 'tangent', g.type === 'line' ? [g.id, arc] : [arc, g.id]);
  addRel(sk, 'dim', [arc], { kind: 'radius', value: +r.toFixed(6) });
  if (used) {
    if (P !== 'O') getPoint(sk, P).keep = true;
    addRel(sk, 'onCurve', [P, A.id]);
    addRel(sk, 'onCurve', [P, B.id]);
  }
  return [T1, T2, C, arc];
}

// Round the corner at P where a (fit-point) spline meets a line or an arc. The fillet's centre is r from both: along
// the spline, the first place (from the corner) where a point r off it, square to it, is r from the other curve
// (within it). The spline is cut back to where the fillet touches it: its fit points before that are dropped, the
// touch point becomes its end, with its tangent handle along the spline there (so the shape beyond barely changes);
// the other curve is cut back as for two curves. The fillet gets a tangent relation with the other curve, a spline
// tangent relation (its end handle square to the fillet's radius) and a radius dimension.
function filletSpline(sk, P, sp, B, r) {
  const p = getPoint(sk, P), tol = 1e-9, atStart = sp.p1 === P;
  if (!sp.handles) { sp.handles = fitSplineHandles(sp.pts.map((id) => { const q = getPoint(sk, id); return [q.x, q.y]; }), false).map((q) => addPoint(sk, ...q)); syncFitHandles(sk, sp); }
  // the spline from the corner, as close points (each with its piece and that piece's parameter), with the length
  const pieces = splinePieces(sk, sp), N = 48, S = [];
  pieces.forEach((g, j) => {
    for (let k = j ? 1 : 0; k <= N; k++) {
      const t = k / N, u = 1 - t;
      S.push({ q: [0, 1].map((d) => u * u * u * g.a[d] + 3 * u * u * t * g.c1[d] + 3 * u * t * t * g.c2[d] + t * t * t * g.b[d]), j, t });
    }
  });
  if (!atStart) S.reverse();
  const L = [0];
  for (let i = 1; i < S.length; i++) L.push(L[i - 1] + Math.hypot(S[i].q[0] - S[i - 1].q[0], S[i].q[1] - S[i - 1].q[1]));
  const tangent = (i) => { const a = S[Math.max(0, i - 1)].q, b = S[Math.min(S.length - 1, i + 1)].q, l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  // the other curve: its distance from a point less r (a line: either side; an arc: outside or inside), and where it is
  // touched (within it)
  let other;
  if (B.type === 'line') {
    const a = getPoint(sk, B.p1 === P ? B.p2 : B.p1), BL = Math.hypot(a.x - p.x, a.y - p.y), u = [(a.x - p.x) / BL, (a.y - p.y) / BL];
    other = {
      gap: (O) => Math.abs((O[0] - p.x) * -u[1] + (O[1] - p.y) * u[0]) - r,
      touch: (O) => { const t = (O[0] - p.x) * u[0] + (O[1] - p.y) * u[1]; return t > tol && t < BL - tol ? [p.x + u[0] * t, p.y + u[1] * t] : null; },
    };
  } else {
    const C = getPoint(sk, B.c), s = getPoint(sk, B.p1), e = getPoint(sk, B.p2), R = Math.hypot(s.x - C.x, s.y - C.y), a0 = Math.atan2(s.y - C.y, s.x - C.x);
    let span = Math.atan2(e.y - C.y, e.x - C.x) - a0;
    while (span <= 0) span += 2 * Math.PI;
    other = {
      gap: (O) => Math.abs(Math.hypot(O[0] - C.x, O[1] - C.y) - R) - r,
      touch: (O) => {
        const v = [O[0] - C.x, O[1] - C.y], vl = Math.hypot(v[0], v[1]);
        if (vl < tol) return null;
        const T = [C.x + (v[0] / vl) * R, C.y + (v[1] / vl) * R];
        let a = Math.atan2(T[1] - C.y, T[0] - C.x) - a0;
        while (a < 0) a += 2 * Math.PI;
        return a > 1e-9 && a < span - 1e-9 ? T : null;
      },
    };
  }
  // along the spline, each side: where the gap first changes sign (found to a hair between two close points)
  const centre = (i, sg, f = 0) => {
    // (the direction too between the two points)
    const q = [0, 1].map((d) => S[i].q[d] + (S[i + 1]?.q[d] - S[i].q[d] || 0) * f), u0 = tangent(i), u1 = tangent(Math.min(S.length - 1, i + 1));
    const uu = [u0[0] + (u1[0] - u0[0]) * f, u0[1] + (u1[1] - u0[1]) * f], ul = Math.hypot(uu[0], uu[1]) || 1, u = [uu[0] / ul, uu[1] / ul];
    return { O: [q[0] - u[1] * r * sg, q[1] + u[0] * r * sg], q, s: L[i] + (L[i + 1] - L[i] || 0) * f };
  };
  let best = null;
  for (const sg of [1, -1]) {
    let prev = other.gap(centre(1, sg).O);
    for (let i = 2; i < S.length - 1; i++) {
      const cur = other.gap(centre(i, sg).O);
      if ((prev < 0) !== (cur < 0)) {
        let lo = 0, hi = 1;
        for (let it = 0; it < 40; it++) { const m = (lo + hi) / 2; if ((other.gap(centre(i - 1, sg, m).O) < 0) === (prev < 0)) lo = m; else hi = m; }
        const c = centre(i - 1, sg, (lo + hi) / 2), T2 = other.touch(c.O);
        if (T2 && (!best || c.s < best.s)) best = { ...c, T2, i: i - 1 };
        break;
      }
      prev = cur;
    }
  }
  if (!best) throw new Error('The radius is too large (or too small) for these curves: no fillet fits between them');
  // the spline cut back: its fit points before the touch point dropped, the touch point its end with the handle along it
  const ptsFrom = atStart ? sp.pts : [...sp.pts].reverse(), handlesFrom = atStart ? sp.handles : [...sp.handles].reverse();
  // (fit point m, as the spline is stored: where piece m starts, i.e. where piece m − 1 ends; its length from the corner)
  const posOf = (m) => { const idx = S.findIndex((x) => (m === 0 ? x.j === 0 && x.t === 0 : x.j === m - 1 && x.t === 1)); return idx >= 0 ? L[idx] : Infinity; };
  const keep = ptsFrom.map((_, k) => k).filter((k) => k > 0 && posOf(atStart ? k : sp.pts.length - 1 - k) > best.s + 1e-6);
  if (!keep.length) throw new Error('The fillet would take up the whole spline: use a smaller radius');
  const T1 = addPoint(sk, ...best.q), u = tangent(best.i), nextQ = getPoint(sk, ptsFrom[keep[0]]);
  const h = Math.hypot(nextQ.x - best.q[0], nextQ.y - best.q[1]) / 3, fwd = atStart ? 1 : -1;
  const H1 = addPoint(sk, best.q[0] + u[0] * h * fwd, best.q[1] + u[1] * h * fwd);
  const newPts = [T1, ...keep.map((k) => ptsFrom[k])], newHandles = [H1, ...keep.map((k) => handlesFrom[k])];
  sp.pts = atStart ? newPts : newPts.reverse();
  sp.handles = atStart ? newHandles : newHandles.reverse();
  sp.p1 = sp.pts[0]; sp.p2 = sp.pts[sp.pts.length - 1];
  syncFitHandles(sk, sp);
  // the other curve cut back, the fillet
  const used = P === 'O' || sk.constraints.some((k) => k.refs.includes(P));
  const T2 = addPoint(sk, ...best.T2), C = addPoint(sk, ...best.O);
  if (B.p1 === P) B.p1 = T2; else B.p2 = T2;
  const construction = sp.construction && B.construction;
  const c = getPoint(sk, C), a = getPoint(sk, T1), b = getPoint(sk, T2);
  const ccw = (a.x - c.x) * (b.y - c.y) - (a.y - c.y) * (b.x - c.x) > 0;
  const arc = ccw ? addArc(sk, C, T1, T2, construction) : addArc(sk, C, T2, T1, construction);
  addRel(sk, 'tangent', B.type === 'line' ? [B.id, arc] : [arc, B.id]);
  addRel(sk, 'splineTangent', [arc, sp.id]);
  addRel(sk, 'dim', [arc], { kind: 'radius', value: +r.toFixed(6) });
  if (used) {
    if (P !== 'O') getPoint(sk, P).keep = true;
    addRel(sk, 'onCurve', [P, B.id]);
  }
  return [T1, T2, C, arc];
}

// Turn the sketch's axes by 90° (dir = 1: counter-clockwise, -1: clockwise) while the geometry
// stays where it is in the model: coordinates are rotated the other way, and horizontal /
// vertical relations and dimensions swap.
export function rotateSketchAxes(sk, dir) {
  for (const p of sk.patterns || []) for (const k of ['a1', 'a2']) p[k] = `(${p[k] ?? (k === 'a1' ? 0 : 90)})${dir > 0 ? '-90' : '+90'}`;
  const T = dir > 0 ? (x, y) => [y, -x] : (x, y) => [-y, x];
  for (const p of sk.points) [p.x, p.y] = T(p.x, p.y);
  for (const k of sk.constraints) {
    if (k.type === 'horizontal') k.type = 'vertical';
    else if (k.type === 'vertical') k.type = 'horizontal';
    else if (k.type === 'fix') [k.x, k.y] = T(k.x, k.y);
    else if (k.type === 'projected' && k.pts) for (const id of Object.keys(k.pts)) k.pts[id] = T(k.pts[id][0], k.pts[id][1]);
    else if (k.type === 'dim') {
      if (Array.isArray(k.labelOffset)) k.labelOffset = T(...k.labelOffset);
      if (k.kind === 'hdist') { k.kind = 'vdist'; if (dir > 0) k.s = -(k.s || 1); }
      else if (k.kind === 'vdist') { k.kind = 'hdist'; if (dir < 0) k.s = -(k.s || 1); }
      if (typeof k.ang === 'number') k.ang += dir > 0 ? -Math.PI / 2 : Math.PI / 2;
    }
  }
}

// ------------------------------------------------------------ deletion & cleanup
export function deleteItems(sk, ids) {
  const set = new Set(ids);
  for (const p of [...(sk.patterns || [])]) if ([p.id, p.path, ...p.sources, ...(p.generated?.points || []), ...(p.generated?.curves || [])].some((id) => set.has(id))) removeSketchPattern(sk, p.id);
  // (a control-point spline's polygon goes with it)
  for (const c of sk.curves) if (c.ctrlOf && set.has(c.ctrlOf)) set.add(c.id);
  sk.curves = sk.curves.filter((c) => !set.has(c.id));
  sk.constraints = sk.constraints.filter((k) => !set.has(k.id));
  sk.points = sk.points.filter((p) => !set.has(p.id));
  cleanup(sk);
}

export function cleanup(sk) {
  for (let pass = 0; pass < 5; pass++) {
    sk.constraints=sk.constraints.filter(k=>{
      if(!k.offsetGroup)return true;
      const group=sk.constraints.find(q=>q.type==='offsetGeometry'&&q.dim===k.id);
      if(!group)return false;
      k.offsetGroup=group.id;k.refs=[group.chain[0].id,group.refs[group.chain.length]];return true;
    });
    const used = new Set(['O']);
    for (const c of sk.curves) for (const k of ['p1', 'p2', 'c', 'a']) if (c[k]) used.add(c[k]);
    for (const c of sk.curves) for (const id of [...(c.pts || []), ...(c.handles || [])]) used.add(id);
    for (const p of sk.points) if (p.keep) used.add(p.id);
    const before = sk.points.length + sk.constraints.length;
    sk.points = sk.points.filter((p) => used.has(p.id));
    const exists = new Set(['O', ...sk.points.map((p) => p.id), ...sk.curves.map((c) => c.id)]);
    sk.constraints = sk.constraints.filter((k) => k.refs.every((r) => exists.has(r)));
    // degenerate: a curve whose endpoints merged
    sk.curves = sk.curves.filter((c) => c.type === 'circle' || c.type === 'ellipse' || c.p1 !== c.p2 || c.type === 'arc' || c.type === 'earc' || (c.type === 'spline' && new Set(c.pts).size >= 2));
    if (sk.points.length + sk.constraints.length === before) break;
  }
  // (block copies whose rigid relation went with their geometry)
  if (sk.blocks) { sk.blocks = sk.blocks.filter((b) => sk.constraints.some((k) => k.type === 'block' && k.block === b.id)); if (!sk.blocks.length) delete sk.blocks; }
}

// Automatic references (projected geometry made when a relation, dimension or snap uses a model
// edge or vertex directly; their 'projected' relation has ref: true) are removed once no other
// relation, dimension or curve uses them. `keep`: ids that stay (e.g. the current selection).
export function pruneRefs(sk, keep = new Set()) {
  keep = new Set([...keep, ...(sk.patterns || []).flatMap((p) => [...p.sources, p.path].filter(Boolean))]);
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const k of [...sk.constraints]) {
      if (k.type !== 'projected' || !k.ref) continue;
      const target = k.refs[0];
      if (keep.has(target)) continue;
      const c = getCurve(sk, target);
      const ids = new Set([target, ...(c ? [c.p1, c.p2, c.c, c.a, ...(c.pts || []), ...(c.handles || [])].filter(Boolean) : [])]);
      if ([...ids].some((id) => keep.has(id))) continue;
      const used = sk.constraints.some((x) => x !== k && x.refs.some((r) => ids.has(r)))
        || sk.curves.some((x) => x.id !== target && [x.p1, x.p2, x.c, x.a, ...(x.pts || []), ...(x.handles || [])].some((p) => p && ids.has(p)));
      if (used) continue;
      sk.constraints = sk.constraints.filter((x) => x !== k);
      if (c) sk.curves = sk.curves.filter((x) => x !== c);
      else { const p = getPoint(sk, target); if (p && p.id !== 'O') p.keep = false; }
      changed = true;
    }
    if (!changed) break;
  }
  cleanup(sk);
}

// Replace point `from` with `to` everywhere (used when the user merges points).
export function mergePoints(sk, from, to) {
  if (from === to || from === 'O') return;
  for (const c of sk.curves) for (const k of ['p1', 'p2', 'c', 'a']) if (c[k] === from) c[k] = to;
  for (const c of sk.curves) {
    if (c.pts) c.pts = c.pts.map((id) => (id === from ? to : id)).filter((id, i, a) => !i || id !== a[i - 1]);
    if (c.handles) c.handles = c.handles.map((id) => id === from ? to : id);
  }
  for (const k of sk.constraints) {
    k.refs = k.refs.map((r) => (r === from ? to : r));
    if (k.pts && from in k.pts) { k.pts[to] = k.pts[from]; delete k.pts[from]; }
    if (k.ends) k.ends = k.ends.map((pair) => pair.map((id) => (id === from ? to : id)));
  }
  sk.constraints = sk.constraints.filter((k) => !(k.type === 'coincident' && k.refs[0] === k.refs[1]));
  cleanup(sk);
}

// ------------------------------------------------------------ naming
export function itemName(sk, id) {
  if (id === 'O') return 'Origin';
  const fit = sk.curves.find((c) => c.handles?.includes(id));
  if (fit) return `Tangent Handle ${fit.handles.indexOf(id) + 1} (${itemName(sk, fit.id)})`;
  const counts = { line: 0, circle: 0, arc: 0, spline: 0, ellipse: 0, earc: 0 };
  for (const c of sk.curves) {
    counts[c.type]++;
    if (c.id === id && c.fitHandle) {
      const spline = getCurve(sk, c.ctrlOf);
      return `Tangent Handle Line ${(spline?.handles?.indexOf(c.p2) ?? 0) + 1}`;
    }
    if (c.id === id) return (c.construction && c.type === 'line' ? 'Centerline' : { line: 'Line', circle: 'Circle', arc: 'Arc', spline: 'Spline', ellipse: 'Ellipse', earc: 'Elliptical Arc' }[c.type]) + counts[c.type];
  }
  const pi = sk.points.findIndex((p) => p.id === id);
  if (pi >= 0) return 'Point' + (pi + 1);
  const ki = sk.constraints.findIndex((k) => k.id === id);
  if (ki >= 0) {
    const k = sk.constraints[ki];
    return k.type === 'dim' ? 'D' + (sk.constraints.filter((x, i) => x.type === 'dim' && i <= ki).length) : k.type;
  }
  return id;
}

// ------------------------------------------------------------ migration from the old format
function evalOld(e, ev) {
  const n = (k, d) => (e[k] === undefined || e[k] === '' ? d : ev(e[k]));
  return { cx: n('cx', 0), cy: n('cy', 0), w: Math.abs(n('w', 0)), h: Math.abs(n('h', 0)), d: Math.abs(n('d', 0)), n: Math.max(3, Math.round(n('n', 6))), rot: n('rot', 0), len: Math.abs(n('len', 0)) };
}

function placeCenter(sk, e, E) {
  const numericZero = (v) => v === undefined || (isNumeric(v) && +v === 0);
  if (numericZero(e.cx) && numericZero(e.cy)) return 'O';
  const M = addPoint(sk, E.cx, E.cy);
  if (!isNumeric(e.cx ?? 0) || +e.cx !== 0) addRel(sk, 'dim', ['O', M], { kind: 'hdist', value: e.cx ?? 0, s: 1 });
  else addRel(sk, 'vertical', ['O', M]);
  if (!isNumeric(e.cy ?? 0) || +e.cy !== 0) addRel(sk, 'dim', ['O', M], { kind: 'vdist', value: e.cy ?? 0, s: 1 });
  else addRel(sk, 'horizontal', ['O', M]);
  return M;
}

export function migrateSketch(f, vars = {}) {
  if (!f.entities || f.points) return;
  const ev = (x) => evaluate(x, vars);
  const sk = newSketchData();
  for (const e of f.entities) {
    let E;
    try { E = evalOld(e, ev); } catch { continue; }
    if (e.type === 'rect') {
      const M = placeCenter(sk, e, E);
      const r = buildCenterRect(sk, M, E.cx, E.cy, E.w / 2, E.h / 2);
      addRel(sk, 'dim', [r.corners[0], r.corners[1]], { kind: 'hdist', value: e.w, s: 1 });
      addRel(sk, 'dim', [r.corners[1], r.corners[2]], { kind: 'vdist', value: e.h, s: 1 });
    } else if (e.type === 'circle') {
      const M = placeCenter(sk, e, E);
      const c = addCircle(sk, M, E.d / 2);
      addRel(sk, 'dim', [c], { kind: 'diameter', value: e.d, ang: Math.PI / 4 });
    } else if (e.type === 'polygon') {
      const M = placeCenter(sk, e, E);
      const a = ((E.rot + 90) * Math.PI) / 180;
      const p = buildPolygon(sk, M, E.cx + (E.d / 2) * Math.cos(a), E.cy + (E.d / 2) * Math.sin(a), E.n);
      addRel(sk, 'dim', [p.circle], { kind: 'diameter', value: e.d, ang: Math.PI / 4 });
    } else if (e.type === 'slot') {
      const a = (E.rot * Math.PI) / 180, h = E.len / 2;
      const c1 = addPoint(sk, E.cx - h * Math.cos(a), E.cy - h * Math.sin(a));
      const c2 = addPoint(sk, E.cx + h * Math.cos(a), E.cy + h * Math.sin(a));
      const s = buildSlot(sk, c1, c2, E.w / 2);
      const M = placeCenter(sk, e, E);
      addRel(sk, 'midpoint', [M, s.centerline]);
      if (Math.abs(E.rot) < 1e-9) addRel(sk, 'horizontal', [s.centerline]);
      addRel(sk, 'dim', [c1, c2], { kind: 'distance', value: e.len, off: -(E.w / 2 + 8) });
      addRel(sk, 'dim', [s.arcs[1]], { kind: 'radius', value: isNumeric(e.w) ? +e.w / 2 : `(${e.w})/2`, ang: 0.3 });
    } else if (e.type === 'poly') {
      const ids = e.pts.map((p) => {
        const id = addPoint(sk, ev(p[0]), ev(p[1]));
        if (!isNumeric(p[0])) addRel(sk, 'dim', ['O', id], { kind: 'hdist', value: p[0], s: 1 });
        if (!isNumeric(p[1])) addRel(sk, 'dim', ['O', id], { kind: 'vdist', value: p[1], s: 1 });
        return id;
      });
      ids.forEach((id, i) => {
        const l = addLine(sk, id, ids[(i + 1) % ids.length]);
        const a = getPoint(sk, id), b = getPoint(sk, ids[(i + 1) % ids.length]);
        if (Math.abs(a.y - b.y) < 1e-9) addRel(sk, 'horizontal', [l]);
        else if (Math.abs(a.x - b.x) < 1e-9) addRel(sk, 'vertical', [l]);
      });
    }
  }
  Object.assign(f, sk);
  delete f.entities;
}
