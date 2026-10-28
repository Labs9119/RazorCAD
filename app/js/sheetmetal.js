// Sheet metal. A sheet metal body is kept as its flat pattern plus bend lines:
//   sheet = { t, K, R, frame, region, bends, rootPt, flat, stale }
// - region: the flat outline (one or more planar faces in the flat XY plane, z = 0), holes included
// - bends: [{ id, p0, e, d, w, ba, ang, up, R }]: a bend zone is the strip from the line p0 + x·e
//   (0 ≤ x ≤ w) across to that line + ba·d (ba = bend allowance); ang is the bend angle (radians,
//   0 < ang < π), up: the side of the strip beyond it folds toward +z (the flat's top face)
// - material lies from z = 0 to z = t; frame maps the flat into the model: o + x·u + y·v + z·n
// - rootPt: a point in the panel that stays where it is when folding; flat: { pt } when unbent
// - corners: [{ a, b, gap, type }] closed corners: the bends a and b (ids) run on into the corner and meet
//   on the mitre, the gap across it (formed material, not in the flat pattern); type 'butt': the walls are
//   mitred too; 'square': each wall runs square to the other's inner face (the flat pattern ends them there,
//   the outside corner left open); otherwise the flat pattern makes one wall cover the other's end
// The 3D body is made by folding the pattern (fold → toSolid): every panel (the region between
// bend zones) is placed by the bends that lead to it from the root panel, every bend zone becomes
// a bent strip (inner radius R) with the neutral surface at R + K·t. Flattening is therefore exact.
import * as R from '../vendor/replicad/replicad.js';

const oc = () => R.getOC();

// ------------------------------------------------------------ small vector helpers
const a2 = (p, q) => [p[0] + q[0], p[1] + q[1]];
const s2 = (p, q) => [p[0] - q[0], p[1] - q[1]];
const m2 = (p, k) => [p[0] * k, p[1] * k];
const d2 = (p, q) => p[0] * q[0] + p[1] * q[1];
const l2 = (p) => Math.hypot(p[0], p[1]);
const u2 = (p) => { const l = l2(p) || 1; return [p[0] / l, p[1] / l]; };
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const unit3 = (a) => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ------------------------------------------------------------ rigid transforms (3×4 matrices)
export const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
export function mulM(A, B) { // A ∘ B (B first)
  const C = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) C[i * 4 + j] = A[i * 4] * B[j] + A[i * 4 + 1] * B[4 + j] + A[i * 4 + 2] * B[8 + j];
    C[i * 4 + 3] = A[i * 4] * B[3] + A[i * 4 + 1] * B[7] + A[i * 4 + 2] * B[11] + A[i * 4 + 3];
  }
  return C;
}
export const apM = (M, p) => [
  M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + M[3],
  M[4] * p[0] + M[5] * p[1] + M[6] * p[2] + M[7],
  M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11],
];
export const apMdir = (M, p) => [M[0] * p[0] + M[1] * p[1] + M[2] * p[2], M[4] * p[0] + M[5] * p[1] + M[6] * p[2], M[8] * p[0] + M[9] * p[1] + M[10] * p[2]];
export function invM(M) {
  const r = [M[0], M[4], M[8], M[1], M[5], M[9], M[2], M[6], M[10]];
  const t = [M[3], M[7], M[11]];
  return [
    r[0], r[1], r[2], -(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]),
    r[3], r[4], r[5], -(r[3] * t[0] + r[4] * t[1] + r[5] * t[2]),
    r[6], r[7], r[8], -(r[6] * t[0] + r[7] * t[1] + r[8] * t[2]),
  ];
}
export const transM = (v) => [1, 0, 0, v[0], 0, 1, 0, v[1], 0, 0, 1, v[2]];
// rotation by ang (radians) about the axis through o along the unit vector d
export function rotM(o, d, ang) {
  const [x, y, z] = unit3(d), c = Math.cos(ang), s = Math.sin(ang), k = 1 - c;
  const Rm = [
    c + x * x * k, x * y * k - z * s, x * z * k + y * s,
    y * x * k + z * s, c + y * y * k, y * z * k - x * s,
    z * x * k - y * s, z * y * k + x * s, c + z * z * k,
  ];
  const ro = [Rm[0] * o[0] + Rm[1] * o[1] + Rm[2] * o[2], Rm[3] * o[0] + Rm[4] * o[1] + Rm[5] * o[2], Rm[6] * o[0] + Rm[7] * o[1] + Rm[8] * o[2]];
  return [Rm[0], Rm[1], Rm[2], o[0] - ro[0], Rm[3], Rm[4], Rm[5], o[1] - ro[1], Rm[6], Rm[7], Rm[8], o[2] - ro[2]];
}
// flat coordinates → model (o + x·u + y·v + z·n)
export const frameM = (fr) => [fr.u[0], fr.v[0], fr.n[0], fr.o[0], fr.u[1], fr.v[1], fr.n[1], fr.o[1], fr.u[2], fr.v[2], fr.n[2], fr.o[2]];
export const frameOfM = (M) => ({ o: [M[3], M[7], M[11]], u: [M[0], M[4], M[8]], v: [M[1], M[5], M[9]], n: [M[2], M[6], M[10]] });

// copy: the result gets geometry of its own (as a finished body should); otherwise it shares the shape's
// geometry, placed by a location (much cheaper: a copy also keeps memory the kernel never gets back)
export function applyM(shape, M, copy = true) {
  const tr = new R.Transformation();
  let bt = null;
  try {
    tr.wrapped.SetValues(M[0], M[1], M[2], M[3], M[4], M[5], M[6], M[7], M[8], M[9], M[10], M[11]);
    bt = new (oc().BRepBuilderAPI_Transform)(shape.wrapped, tr.wrapped, copy, false);
    return own(bt.ModifiedShape(shape.wrapped));
  } finally { bt?.delete(); tr.delete(); }
}

// ------------------------------------------------------------ freeing kernel objects
// A kernel object is freed when its JS wrapper is garbage collected, which can't happen while a rebuild
// runs (it never gives way to the event loop): every temporary shape, and every boolean builder with all
// its working data, stays in memory until the rebuild ends. Folding and cutting a sheet make hundreds of
// them, so the big ones are freed here as soon as they are done with.
// (cast copies the raw shape it is given, which would otherwise keep the result alive for good)
function own(raw) { try { return R.cast(raw); } finally { raw.delete(); } }
export function free(...xs) { for (const x of xs) { try { x?.delete?.(); } catch { /* already freed */ } } }
// next, after freeing prev (when it is a different shape): for running results (a = f(a, …))
const swap = (prev, next) => { if (prev && prev !== next) free(prev); return next; };
// A boolean of two shapes, built once and freed (a builder made with both shapes has already built it,
// and building it again would do it all twice). glue: the shapes only touch (faster). solid: as replicad's
// fuse / cut (results simplified, must be a 3D shape).
// b: a shape, or a list of shapes (all used together, in one go)
function boolOf(kind, a, b, { glue = false, solid = false } = {}) {
  const O = oc();
  const C = kind === 'cut' ? O.BRepAlgoAPI_Cut : kind === 'fuse' ? O.BRepAlgoAPI_Fuse : O.BRepAlgoAPI_Common;
  const op = new C(), A = new O.NCollection_List_TopoDS_Shape(), T = new O.NCollection_List_TopoDS_Shape(), pr = new O.Message_ProgressRange();
  try {
    A.Append(a.wrapped);
    for (const x of Array.isArray(b) ? b : [b]) T.Append(x.wrapped);
    op.SetArguments(A); op.SetTools(T);
    if (glue) op.SetGlue(O.BOPAlgo_GlueEnum.BOPAlgo_GlueShift);
    op.Build(pr);
    if (solid) op.SimplifyResult(true, true, 1e-3);
    const out = own(op.Shape());
    if (solid && !R.isShape3D(out)) { free(out); throw new Error(`Could not ${kind} as a 3d shape`); }
    return out;
  } finally { op.delete(); A.delete(); T.delete(); pr.delete(); }
}
const fuse3 = (a, b, glue = false) => boolOf('fuse', a, b, { glue, solid: true });
const cut3 = (a, b) => boolOf('cut', a, b, { solid: true });

// ------------------------------------------------------------ planar regions (faces in z = 0)
const P3 = (p, z = 0) => [p[0], p[1], z];
// Every flat face is made facing +z (counter-clockwise outline): faces facing opposite ways would not
// merge into one outline when fused.
export function polyFace(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return R.makePolygon((a < 0 ? [...pts].reverse() : pts).map((p) => P3(p)));
}
// The faces of a flat shape, each turned to face +z.
export function upFaces(shape) {
  const fs = facesOf(shape).map((f) => {
    const n = f.normalAt();
    const nz = Array.isArray(n) ? n[2] : n.z;
    n.delete?.();
    return nz < 0 ? own(f.wrapped.Reversed()) : f;
  });
  if (fs.length === 1) return fs[0];
  let out = null;
  for (const f of fs) out = swap(out, bop('fuse', out, f));
  return out;
}
// rectangle from p along e (length w) and along d (depth h, may be negative)
export const rectFace = (p, e, d, w, h) => polyFace([p, a2(p, m2(e, w)), a2(a2(p, m2(e, w)), m2(d, h)), a2(p, m2(d, h))]);
export function circleFace(c, r) {
  return R.makeFace(R.assembleWire([R.makeCircle(r, P3(c), [0, 0, 1])]));
}

// (tol: faces this close to one plane count as one, for a sheet whose pattern came from a body: its faces may lie a
// ten-millionth of a mm apart where they should be one; default OpenCascade's own)
function clean(shape, tol = 0) {
  let u = null;
  try {
    u = new (oc().ShapeUpgrade_UnifySameDomain)(shape.wrapped, true, true, false);
    if (tol > 0 && typeof u.SetLinearTolerance === 'function') u.SetLinearTolerance(tol);
    u.Build();
    return own(u.Shape());
  } catch { return shape; } finally { u?.delete(); }
}
// boolean on regions (or a region and a solid): 'cut' | 'fuse' | 'common'; null = empty
export function bop(kind, a, b) {
  if (!a) return kind === 'fuse' ? b : null;
  if (!b) return kind === 'common' ? null : a;
  const out = boolOf(kind, a, b);
  if (!out.faces.length) { free(out); return null; }
  return swap(out, clean(out));
}
export const facesOf = (s) => (s ? s.faces : []);
export const areaOf = (s) => facesOf(s).reduce((a, f) => a + R.measureArea(f), 0);
function distTo(shape, p) {
  const q = new R.DistanceQuery(R.makeVertex(p));
  try { return q.distanceTo(shape); } finally { q.delete?.(); }
}
// the face of a region that holds the flat point p (on or inside it)
export const faceAt = (faces, p, tol = 1e-7) => faces.find((f) => distTo(f, P3(p)) <= tol) || null;
function bbox2(s) { const b = s.boundingBox.bounds; return { min: b[0], max: b[1] }; }

// Points along an edge (n segments), as [x, y, z].
function edgePts(e, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const p = e.pointAt(i / n);
    out.push(Array.isArray(p) ? p : p.toTuple ? p.toTuple() : [p.x, p.y, p.z]);
    if (!Array.isArray(p)) p.delete?.();
  }
  return out;
}
// A wire's edges chained end to end, each as its points (curves sampled: n segments; lines: their two
// ends), in order and direction around the wire. The order the edges are stored in is not always the
// order around the wire.
export function wireRuns(wire, segs = 24) {
  const pieces = wire.edges.map((e) => { const line = e.geomType === 'LINE'; return { line, pts: edgePts(e, line ? 1 : segs) }; });
  if (!pieces.length) return [];
  const dist = (p, q) => len3(sub3(p, q));
  const out = [pieces.shift()];
  while (pieces.length) {
    const last = out[out.length - 1].pts[out[out.length - 1].pts.length - 1];
    let bi = 0, rev = false, bd = Infinity;
    pieces.forEach((pc, i) => {
      const d0 = dist(pc.pts[0], last), d1 = dist(pc.pts[pc.pts.length - 1], last);
      if (d0 < bd) { bd = d0; bi = i; rev = false; }
      if (d1 < bd) { bd = d1; bi = i; rev = true; }
    });
    const pc = pieces.splice(bi, 1)[0];
    out.push(rev ? { ...pc, pts: [...pc.pts].reverse() } : pc);
  }
  return out;
}
// A wire as one closed loop of points (curves sampled).
export function wireLoop(wire, segs = 24) {
  const runs = wireRuns(wire, segs);
  if (!runs.length) return [];
  const pts = [...runs[0].pts];
  for (const r of runs.slice(1)) pts.push(...r.pts.slice(1));
  if (pts.length > 1 && len3(sub3(pts[0], pts[pts.length - 1])) < 1e-7) pts.pop();
  return pts;
}
// A flat face (facing +z) bounded by runs of flat points chained end to end ([{ pts, line }], as from
// wireRuns): each run that is straight becomes a line, every other one a single smooth B-spline (so a
// traced curve is one edge of the pattern, not dozens of short ones, each a face of the folded body).
// null when the runs don't make a face.
function runsFace(runs, tol = 1e-3) {
  const edges = [];
  for (const r of runs) {
    const P = [];
    for (const q of r.pts) if (!P.length || l2(s2(q, P[P.length - 1])) > 1e-9) P.push(q);
    if (P.length < 2) continue;
    const a = P[0], b = P[P.length - 1], ab = s2(b, a), L = l2(ab);
    const off = (q) => (L > 0 ? Math.abs((q[0] - a[0]) * ab[1] - (q[1] - a[1]) * ab[0]) / L : l2(s2(q, a)));
    if (P.length === 2 || (L > 1e-9 && P.every((q) => off(q) <= 1e-7 * (1 + L)))) edges.push(R.makeLine(P3(a), P3(b)));
    else edges.push(R.makeBSplineApproximation(P.map((q) => P3(q)), { tolerance: tol, degMax: 5 }));
  }
  if (edges.length < 2) return null;
  // (runs whose ends don't quite meet: null, and the caller traces the outline as points)
  let face;
  try { face = R.makeFace(R.assembleWire(edges)); } catch { return null; }
  return face && R.measureArea(face) > 1e-12 ? upFaces(face) : null;
}

// ------------------------------------------------------------ bends
// (K may carry a bend table, K.table = { R, t, rows: [[angle (rad), BA], …] by angle}: for bends of that radius and
// thickness the allowance is read from it, straight between its rows, in proportion to the angle past its ends)
export const bendAllowance = (ang, R0, K, t) => {
  const tb = K?.table;
  if (tb && Math.abs(R0 - tb.R) < 1e-9 && Math.abs(t - tb.t) < 1e-9) return tableAllowance(tb.rows, ang);
  return ang * (R0 + K * t);
};
export function tableAllowance(rows, ang) {
  const first = rows[0], last = rows[rows.length - 1];
  if (ang <= first[0]) return (first[1] * ang) / first[0];
  if (ang >= last[0]) return (last[1] * ang) / last[0];
  for (let i = 1; i < rows.length; i++) if (ang <= rows[i][0]) { const [a0, b0] = rows[i - 1], [a1, b1] = rows[i]; return b0 + ((b1 - b0) * (ang - a0)) / (a1 - a0); }
  return last[1];
}
// setback from a bend line to the virtual sharp: outer (R + t) or inner (R) mould line
export const setback = (ang, r) => r * (ang <= Math.PI / 2 + 1e-9 ? Math.tan(ang / 2) : 1);
const stripFace = (b) => rectFace(b.p0, b.e, b.d, b.w, b.ba);
// a bend's zone in the flat: a converted bend's own (it may run on past its line's ends, e.g. a V cutout corner, or
// end mitred), otherwise its strip. own: whether it was made here (to be freed after use)
const zoneOf = (b) => (b.zone ? { z: b.zone, own: false } : { z: stripFace(b), own: true });
// how far a bend's zone reaches along its line (from p0): [x0, x1], at least 0 to w
function zoneSpan(b) {
  if (!b.zone) return [0, b.w];
  const bb = bbox2(b.zone);
  let x0 = 0, x1 = b.w;
  for (const x of [bb.min[0], bb.max[0]]) for (const y of [bb.min[1], bb.max[1]]) { const u = d2(s2([x, y], b.p0), b.e); x0 = Math.min(x0, u); x1 = Math.max(x1, u); }
  return [x0, x1];
}
// the sign of the rotation that turns the strip's far side toward its bend side
const bendSign = (b) => { const z = [-b.e[1], b.e[0]]; const s = Math.sign(d2(b.d, z)) || 1; return b.up ? s : -s; };
const axisZ = (b, t) => (b.up ? t + b.R : -b.R);
// B side (flat coordinates) → its folded position, both in the A side's coordinates
function bendLocal(b, t) {
  const a0 = [b.p0[0], b.p0[1], axisZ(b, t)];
  return mulM(rotM(a0, [b.e[0], b.e[1], 0], bendSign(b) * b.ang), transM([-b.d[0] * b.ba, -b.d[1] * b.ba, 0]));
}

// ------------------------------------------------------------ folding
const foldCache = new WeakMap();
// Panels with their placement (flat → folded, in flat coordinates of the root panel) and, for every
// bend, the panels it joins. Throws when the pattern can't be folded.
export function fold(sheet) {
  let f = foldCache.get(sheet);
  if (f) return f;
  const { region, bends, t } = sheet;
  let strips = null;
  for (const b of bends) {
    const { z, own } = zoneOf(b), next = bop('fuse', strips, z);
    if (own && next !== z) free(z);
    // (a converted bend's zone is its own: the union starts from a copy, as the union is freed below)
    strips = swap(strips, next === z && !own ? z.clone() : next);
  }
  // (rips: cut RIP wide, so the pieces either side of each fold apart)
  const rips = seamRips((sheet.marks || []).filter((m) => m.kind === 'rip').map((m) => [m.a, m.b]), t);
  const cutter = rips ? bop('fuse', strips, rips) : strips;
  const panelShape = cutter ? bop('cut', region, cutter) : region;
  const panels = facesOf(panelShape).map((face, i) => ({ i, face, M: null }));
  if (cutter !== strips && cutter !== rips) free(cutter);
  free(strips, rips);
  if (panelShape !== region) free(panelShape); // (its faces are kept)
  // (a rolled part can be all bends: no flat panel at all)
  if (!panels.length && !bends.length) throw new Error('The sheet metal part has no flat panel left');
  const dl = Math.max(1e-3, t * 0.01);
  const panelAt = (p) => panels.find((pn) => distTo(pn.face, P3(p)) <= 1e-7) || null;
  // a bend zone cut into pieces (a slot across the bend) joins a pair of panels per piece
  const links = [];
  const piecesOf = new Map(bends.map((b) => {
    // (a converted bend: its own zone, holes and all, as the body has it; at a mitred corner two bends' zones
    // overlap in the flat, so the region's part of it would hold some of the other bend too)
    if (b.zone) return [b, facesOf(b.zone)];
    const { z, own } = zoneOf(b), common = bop('common', region, z), fs = facesOf(common);
    if (own) free(z);
    if (common !== z) free(common);
    return [b, fs];
  }));
  // a bend that runs straight on into another bend (a rolled shape: no flat between them) is joined to
  // it by a "joint": a flat of no width, with a placement but no material of its own
  const joints = new Map();
  const jointAt = (b, p) => {
    for (const [bo, ps] of piecesOf) {
      if (bo === b || !faceAt(ps, p)) continue;
      const key = [b.id, bo.id].sort().join('|');
      if (!joints.has(key)) joints.set(key, { joint: true, key, M: null });
      return joints.get(key);
    }
    return null;
  };
  // the end of a rolled part: a bend with nothing beyond it, only when the part has no flat panel at all
  const endAt = (b, side) => {
    if (panels.length && !(b.end && side === 'b')) return null;
    const key = `${b.id}|end-${side}`;
    if (!joints.has(key)) joints.set(key, { joint: true, key, M: null });
    return joints.get(key);
  };
  for (const b of bends) {
    const pieces = piecesOf.get(b);
    if (!pieces.length) throw new Error('A bend has been cut away completely');
    for (const piece of pieces) {
      const bb = bbox2(piece);
      const xs = [[bb.min[0], bb.min[1]], [bb.max[0], bb.max[1]]].map((q) => d2(s2(q, b.p0), b.e));
      const [s0, s1] = zoneSpan(b), x0 = Math.max(s0, Math.min(...xs)), x1 = Math.min(s1, Math.max(...xs));
      let A = null, B = null;
      for (const k of [0.5, 0.3, 0.7, 0.1, 0.9]) {
        const q = a2(b.p0, m2(b.e, x0 + (x1 - x0) * k));
        if (!faceAt([piece], a2(q, m2(b.d, b.ba / 2)))) continue;
        const qa = a2(q, m2(b.d, -dl)), qb = a2(q, m2(b.d, b.ba + dl));
        A = panelAt(qa) || jointAt(b, qa) || endAt(b, 'a'); B = panelAt(qb) || jointAt(b, qb) || endAt(b, 'b');
        if (A && B) break;
      }
      links.push({ b, A, B, piece });
    }
  }
  for (const lk of links) {
    if (!lk.A || !lk.B) throw new Error('A bend is not joined to flat material on both sides');
    if (lk.A === lk.B) throw new Error('A bend needs a relief at its end (the material on both sides of it is still connected)');
  }
  // the fixed panel: the one holding rootPt, or (when a hole was cut there) the nearest one
  let root = sheet.rootPt && panelAt(sheet.rootPt);
  if (!root && sheet.rootPt) {
    let bd = Infinity;
    for (const pn of panels) { const dd = distTo(pn.face, P3(sheet.rootPt)); if (dd < bd) { bd = dd; root = pn; } }
  }
  root ||= panels[0];
  // all bends: the start of the first bend stays put (the sheet's frame is placed there)
  root ||= links.find((lk) => lk.b === bends[0])?.A;
  root.M = IDENT;
  const queue = [root];
  while (queue.length) {
    const P = queue.shift();
    for (const lk of links) {
      if (lk.A === P && !lk.B.M) { lk.B.M = mulM(P.M, bendLocal(lk.b, t)); queue.push(lk.B); }
      else if (lk.B === P && !lk.A.M) { lk.A.M = mulM(P.M, invM(bendLocal(lk.b, t))); queue.push(lk.A); }
    }
  }
  for (const p of [...panels, ...joints.values()]) if (!p.M) p.M = IDENT; // a loose piece (cut off): stays flat in place
  // the panel holding a flat point, or the nearest one (when a hole was cut there)
  const panelNear = (p) => {
    let best = panelAt(p), bd = Infinity;
    if (!best) for (const pn of panels) { const dd = distTo(pn.face, P3(p)); if (dd < bd) { bd = dd; best = pn; } }
    return best;
  };
  f = { panels, links, panelAt, panelNear };
  foldCache.set(sheet, f);
  return f;
}

// Seams ([[p, q]] in the flat) as rips: cuts RIP wide along them (run on a little past their ends, to meet the bend
// zones), or null.
const RIP = 1e-3; // mm
function seamRips(seams, t) {
  if (!seams.length) return null;
  const w = Math.max(RIP, t * 1e-4), ext = Math.max(1e-3, t * 0.01);
  let out = null;
  for (const [p, q] of seams) {
    const L = l2(s2(q, p));
    if (!(L > 1e-9)) continue;
    const e = u2(s2(q, p)), n = [-e[1], e[0]];
    const f = rectFace(a2(a2(p, m2(e, -ext)), m2(n, -w / 2)), e, n, L + 2 * ext, w);
    out = out ? swap(out, bop('fuse', out, f)) : f;
    if (out !== f) free(f);
  }
  return out;
}

// Solid of one bend zone in the A side's flat coordinates (piece: the region's part of the strip).
// vcuts: [{ X, top, mid, relief }] V-cutout corners at its ends: the bend is made longer there in the same
// solid and the V is cut into it (see vcutTool), so the corner never has to be joined on afterwards.
// (Kernel Lab) bend solids made, by their inputs written out: the same inputs, the same solid
const LAB_BENDS = (globalThis.LAB_BENDS ??= { hits: 0, misses: 0, keyMs: 0 });
const BEND_MEMO = new Map();
function bendKey(b, t, piece, vcuts) {
  const t0 = performance.now();
  try {
    const seen = new Set();
    return JSON.stringify([b, t, piece, vcuts], (k, v) => {
      if (v && typeof v === 'object') {
        if (v.wrapped) return { brep: oc().BRepToolsWrapper.Write(v.wrapped) };
        if (seen.has(v)) throw new Error('cycle');
        seen.add(v);
      }
      return typeof v === 'function' ? undefined : v;
    });
  } catch { return null; } finally { LAB_BENDS.keyMs += performance.now() - t0; }
}
function bendSolid(b, t, piece, vcuts = null) {
  const key = bendKey(b, t, piece, vcuts);
  const hit = key && BEND_MEMO.get(key);
  if (hit) { LAB_BENDS.hits++; BEND_MEMO.delete(key); BEND_MEMO.set(key, hit); return hit.clone(); }
  LAB_BENDS.misses++;
  const sol = bendSolidMade(b, t, piece, vcuts);
  if (key && sol) {
    BEND_MEMO.set(key, sol.clone());
    while (BEND_MEMO.size > 64) { const [k0, v0] = BEND_MEMO.entries().next().value; v0.delete?.(); BEND_MEMO.delete(k0); }
  }
  return sol;
}
function bendSolidMade(b, t, piece, vcuts = null) {
  if (b.zone) return zoneBendSolid(b, t, piece);
  const full = b.w * b.ba;
  const partial = piece && Math.abs(areaOf(piece) - full) > full * 1e-6;
  let x0 = 0, x1 = b.w;
  const cuts = [];
  if (vcuts && !partial) {
    for (const v of vcuts) {
      if (!(v.top > 1e-6)) continue;
      const len = v.top + 2 * t;
      if (d2(s2(v.X, b.p0), b.e) > b.w / 2) x1 = b.w + len; else x0 = -len;
      cuts.push(v);
    }
  }
  const q0 = a2(b.p0, m2(b.e, x0)), q1 = a2(b.p0, m2(b.e, x1));
  const prof = R.makePolygon([P3(q0, 0), P3(q1, 0), P3(q1, t), P3(q0, t)]);
  let sol = R.revolution(prof, [b.p0[0], b.p0[1], axisZ(b, t)], [b.e[0], b.e[1], 0], (bendSign(b) * b.ang * 180) / Math.PI);
  free(prof);
  if (partial) {
    const sf = stripFace(b), missing = bop('cut', sf, piece);
    for (const face of facesOf(missing)) { const tool = wrapTool(b, t, face); sol = swap(sol, cut3(sol, tool)); free(tool); }
    free(sf, missing);
  }
  for (const v of cuts) {
    try { sol = swap(sol, sol.cut(vcutTool(b, t, v.X, v.top, v.mid ?? v.top, v.relief || 0))); } catch { /* keep */ }
  }
  return sol;
}

// A converted bend's solid: bent over the whole span of its zone, then cut at each end along the zone's own end
// (traced across the bend: a square end, a V cutout's straight line, a mitre's curve…; carried onto the bend as the
// curve it is when bent), and its holes cut out. The cutting tools reach past the bend all round (as the V cutout's
// do), so they never lie on its faces: only the end itself is cut.
const ZONE_N = 32;
function zoneBendSolid(b, t, piece) {
  const [x0, x1] = zoneSpan(b);
  const q0 = a2(b.p0, m2(b.e, x0)), q1 = a2(b.p0, m2(b.e, x1));
  const prof = R.makePolygon([P3(q0, 0), P3(q1, 0), P3(q1, t), P3(q0, t)]);
  let sol = R.revolution(prof, [b.p0[0], b.p0[1], axisZ(b, t)], [b.e[0], b.e[1], 0], (bendSign(b) * b.ang * 180) / Math.PI);
  free(prof);
  const at = (x, s) => a2(a2(b.p0, m2(b.e, x)), m2(b.d, s)); // (flat point x along the bend line, s across it)
  for (const face of facesOf(piece || b.zone)) {
    // the outline in (x, s), and where each line across the bend (s fixed) leaves it at each end
    const L = wireLoop(face.clone().outerWire(), ZONE_N).map((p) => { const v = s2([p[0], p[1]], b.p0); return [d2(v, b.e), d2(v, b.d)]; });
    const ends = { lo: [], hi: [] };
    for (let k = 0; k <= ZONE_N; k++) {
      const s = b.ba * (1e-4 + (1 - 2e-4) * (k / ZONE_N));
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < L.length; i++) {
        const [xa, sa] = L[i], [xb, sb] = L[(i + 1) % L.length];
        if ((sa - s) * (sb - s) > 0 || sa === sb) continue;
        const x = xa + ((xb - xa) * (s - sa)) / (sb - sa);
        lo = Math.min(lo, x); hi = Math.max(hi, x);
      }
      if (!Number.isFinite(lo)) break;
      ends.lo.push([lo, s]); ends.hi.push([hi, s]);
    }
    if (ends.lo.length !== ZONE_N + 1) continue;
    for (const [pts, edge, out] of [[ends.lo, x0, -1], [ends.hi, x1, 1]]) {
      if (pts.every(([x]) => Math.abs(x - edge) < 1e-7)) continue; // (square, at the span's end: nothing beyond)
      // the end line carried on a little past both sides of the bend, then out past the span
      const ext = (p, q, s) => [p[0] + ((q[0] - p[0]) * (s - p[1])) / (q[1] - p[1]), s];
      const s0 = -0.15 * b.ba, s1 = 1.15 * b.ba, far = edge + out * (3 * t + Math.abs(x1 - x0) * 0.05 + 1);
      const line = [ext(pts[0], pts[1], s0), ...pts, ext(pts[ZONE_N - 1], pts[ZONE_N], s1)];
      const loop = [...line, [far, s1], [far, s0]].map(([x, s]) => at(x, s));
      let tool = null;
      try { tool = wrapLoopTool(b, t, loop, line.length); sol = swap(sol, cut3(sol, tool)); } catch { /* keep */ } finally { free(tool); }
    }
    // holes in the bend (a slot across it…)
    for (const hw of face.clone().innerWires()) {
      let hole = null, tool = null;
      try { hole = upFaces(R.makeFace(hw)); tool = wrapTool(b, t, hole, true); sol = swap(sol, cut3(sol, tool)); } catch { /* keep */ } finally { free(tool); }
    }
  }
  return sol;
}

// Map a flat point in a bend zone onto the bent strip at radius r (from the bend axis).
function wrapPoint(b, t, p, r) {
  const x = d2(s2(p, b.p0), b.e), s = d2(s2(p, b.p0), b.d);
  const phi = (bendSign(b) * b.ang * Math.min(Math.max(s, -0.5 * b.ba), 1.5 * b.ba)) / b.ba;
  const e3 = [b.e[0], b.e[1], 0];
  const r0 = b.up ? [0, 0, -1] : [0, 0, 1];
  const dir = apMdir(rotM([0, 0, 0], e3, phi), r0);
  return add3(add3([b.p0[0], b.p0[1], axisZ(b, t)], mul3(e3, x)), mul3(dir, r));
}
// A solid that cuts the part of a bend zone outside the pattern (a flat face in the zone) out of the bent strip.
// (each curved edge of the face is carried onto the bend as one smooth edge, so one face of the tool)
function wrapTool(b, t, face, formed = false) {
  let runs = wireRuns(face.clone().outerWire(), 32).map((r) => r.pts.map((p) => [p[0], p[1]]));
  // formed: a straight edge that runs across the bend is carried onto it as a curve (it is one when bent), not as
  // a straight chord between its ends
  if (formed) {
    const across = (p, q) => Math.abs(d2(s2(q, p), b.d)) > 1e-9;
    runs = runs.map((pts) => (pts.length === 2 && across(pts[0], pts[1]) ? Array.from({ length: 33 }, (_, i) => a2(pts[0], m2(s2(pts[1], pts[0]), i / 32))) : pts));
  }
  const polygon = () => wrapLoopTool(b, t, wireLoop(face.clone().outerWire(), 32).map((p) => [p[0], p[1]]));
  if (runs.every((pts) => pts.length === 2)) return polygon();
  const ri = Math.max(1e-3, b.R - 0.1 * t), ro = b.R + 1.1 * t;
  const wire = (r, rs) => R.assembleWire(rs.map((lp) => {
    const pts = lp.map((p) => wrapPoint(b, t, p, r));
    return pts.length === 2 ? R.makeLine(pts[0], pts[1]) : R.makeBSplineApproximation(pts, { tolerance: 1e-4 * (t + b.R), degMax: 5 });
  }));
  const loft = (A, B) => { const ws = [wire(A[0], A[1]), wire(B[0], B[1])]; try { return R.loft(ws, { ruled: true }); } finally { free(...ws); } };
  try {
    // the loft can come out inside out (negative volume), which would cut away the wrong side
    let tool = loft([ri, runs], [ro, runs]);
    if (R.measureVolume(tool) < 0) {
      const rev = [...runs].reverse().map((pts) => [...pts].reverse());
      tool = swap(tool, loft([ri, rev], [ro, rev]));
      if (R.measureVolume(tool) < 0) tool = swap(tool, loft([ro, runs], [ri, runs]));
    }
    return tool;
  } catch { return polygon(); }
}
// The same from a flat outline given as points (flat coordinates, closed implicitly). smooth: the number
// of points at the start of the loop that lie on one curve; they make one smooth edge (so one face).
// smooth: that many points from `start` are one smooth curve (through its first and last points exactly; the ruled
// loft joins the two wires' vertices), the rest of the loop straight lines
function wrapLoopTool(b, t, loop, smooth = 0, start = 0) {
  const ri = Math.max(1e-3, b.R - 0.1 * t), ro = b.R + 1.1 * t, n = loop.length;
  const wire = (r, lp, s0) => {
    const pts = lp.map((p) => wrapPoint(b, t, p, r));
    if (smooth < 3) return R.assembleWire(pts.map((p, i) => R.makeLine(p, pts[(i + 1) % n])));
    const run = [];
    for (let i = 0; i < smooth; i++) run.push(pts[(s0 + i) % n]);
    const edges = [R.makeBSplineApproximation(run, { tolerance: 1e-4 * (t + b.R), degMax: 5 })];
    for (let i = s0 + smooth - 1; (i % n) !== s0 % n; i++) edges.push(R.makeLine(pts[i % n], pts[(i + 1) % n]));
    return R.assembleWire(edges);
  };
  // the loft can come out inside out (negative volume), which would cut away the wrong side
  let tool = R.loft([wire(ri, loop, start), wire(ro, loop, start)], { ruled: true });
  if (R.measureVolume(tool) < 0) {
    const rev = [...loop].reverse(), rs = (2 * n - start - smooth) % n;
    tool = R.loft([wire(ri, rev, rs), wire(ro, rev, rs)], { ruled: true });
    if (R.measureVolume(tool) < 0) tool = R.loft([wire(ro, loop, start), wire(ri, loop, start)], { ruled: true });
  }
  return tool;
}
// V cutout: a bend run on into the corner as the flat pattern would form it: in the flat, the run-on
// (beyond the bend's end) is cut along a straight line from the corner point (length `bottom` at the
// bend line) to the wall (length `top` where the bend meets its wall). Folded, the line becomes a curve,
// so the two bends of a corner leave a lens-shaped opening between them, as on a real formed corner.
// Near the corner point the two bends would meet (and, by a hair, cross), so there each one is set back
// a little (a narrow relief along its cut edge, `relief` wide at the bend line, fading smoothly into the
// V line part way up the bend). At the bend line the set-back edges run square to it and a small round
// of the same radius at the corner point joins them through the base (cornerReliefRound): one smooth
// curve from one bend round the corner point to the other, no sharp corner.
const RELIEF_FADE = 0.5; // × the bend's length: where the set-back has faded into the V line
function vcutRelief(t, gap) { return Math.max(gap || 0, 0.075 * t, 0.1); }
// a corner's relief: none at a square corner (its bends end in plain straight V lines from the corner point, as a
// formed part's do: there the two bends only touch)
const cornerRelief0 = (c, t) => (c.type === 'square' ? 0 : vcutRelief(t, c.gap));
function cornerReliefRound(A, B, t, r) {
  const at = cornerUV(A, B);
  if (!at) return null;
  const Q = at(0, 0);
  return R.basicFaceExtrusion(circleFace([Q[0], Q[1]], r), new R.Vector([0, 0, 3 * t])).translate([0, 0, -t]);
}
function vcutRunOn(b, t, X, top, mid = top, relief = 0) {
  if (!(top > 1e-6)) return null;
  const len = top + 2 * t;
  try { return bendRunOn(b, t, X, len).cut(vcutTool(b, t, X, top, mid, relief)); } catch { return null; }
}
// What lies beyond the V cutout line (flat: from the corner point at the bend line to `top` at the wall).
// mid: the line's slope at the corner point (as a top reached in a straight line). Both bends of a corner
// get the same one, so near the corner point they are mirror images about the mitre; the line then
// curves on to its own wall's end. relief: the set-back at the bend line (see above).
// The V line in the flat: pt(xp, s) is the flat point `xp` past the bend's end at the corner and `s` up
// the bend; f(s) the line's xp at s. The folded tool and the flat pattern both use it.
function vcutLine(b, t, X, top, mid = top, relief = 0) {
  const atEnd = d2(s2(X, b.p0), b.e) > b.w / 2;
  const pt = (xp, s) => a2(a2(b.p0, m2(b.e, atEnd ? b.w + xp : -xp)), m2(b.d, s));
  // set-back (1 + a·q)(1 − q)² over q = s / fade: `relief` at the bend line with a slope that cancels the
  // V line's there (so the edge leaves the bend line square to it), gone with zero slope at q = 1
  const fade = RELIEF_FADE * b.ba;
  const a = relief > 0 ? 2 + (mid * fade) / (b.ba * relief) : 0;
  const back = (s) => { const q = s / fade; return q >= 1 ? 0 : relief * (1 + a * q) * (1 - q) * (1 - q); };
  const f = (s) => { const q = s / b.ba; return mid * q + (top - mid) * q * q - back(s); };
  return { pt, f, far: top + 3 * t };
}
// (the same points for the folded tool and the flat. Without a relief: N + 1 along the bend, from the bend line to the
// wall, one smooth curve through both ends exactly, so the cut passes exactly through the panel's corner and the
// wall's end and leaves no sliver of either; and a point a little past each end, in the panel and the wall, on the
// line carried straight on as it leaves the bend. With one: N + 1 from a little before the bend to a little past it,
// one smooth curve: the set-back meets the round at the corner point tangentially, which booleans only take when the
// curve is not exactly through the bend's ends)
const VCUT_N = 48;
const vcutLoop = (b, pt, f, far, relief) => {
  const N = VCUT_N, s0 = -0.15 * b.ba, s1 = 1.15 * b.ba, h = 1e-4 * b.ba;
  if (relief > 0) {
    const loop = [];
    for (let k = 0; k <= N; k++) { const s = s0 + ((s1 - s0) * k) / N; loop.push(pt(f(s), s)); }
    loop.push(pt(far, s1), pt(far, s0));
    return { loop, start: 0 };
  }
  const d0 = (f(h) - f(0)) / h, d1 = (f(b.ba) - f(b.ba - h)) / h;
  const loop = [pt(f(0) + d0 * s0, s0)];
  for (let k = 0; k <= N; k++) { const s = (b.ba * k) / N; loop.push(pt(f(s), s)); }
  loop.push(pt(f(b.ba) + d1 * (s1 - b.ba), s1), pt(far, s1), pt(far, s0));
  return { loop, start: 1 };
};
function vcutTool(b, t, X, top, mid = top, relief = 0) {
  const { pt, f, far } = vcutLine(b, t, X, top, mid, relief), { loop, start } = vcutLoop(b, pt, f, far, relief);
  return wrapLoopTool(b, t, loop, VCUT_N + 1, start);
}
// The same in the flat: what lies beyond the V line, as a face.
function vcutFlatBeyond(b, t, X, top, mid, relief) {
  const { pt, f, far } = vcutLine(b, t, X, top, mid, relief);
  const { loop: lp, start } = vcutLoop(b, pt, f, far, relief), loop = lp.map((p) => P3(p));
  const pts = loop.slice(start, start + VCUT_N + 1), rest = [...loop.slice(start + VCUT_N), ...loop.slice(0, start + 1)];
  const wire = R.assembleWire([
    R.makeBSplineApproximation(pts, { tolerance: 1e-4 * (t + b.R), degMax: 5 }),
    ...rest.slice(1).map((p, i) => R.makeLine(rest[i], p)),
  ]);
  return { face: upFaces(R.makeFace(wire)), pt, far };
}

// A bend zone run on past its end at the corner X (flat coordinates) by `len`: the bent strip there.
function bendRunOn(b, t, X, len) {
  const atEnd = d2(s2(X, b.p0), b.e) > b.w / 2;
  const s = atEnd ? b.w : -len;
  const q0 = a2(b.p0, m2(b.e, s)), q1 = a2(q0, m2(b.e, len));
  const prof = R.makePolygon([P3(q0, 0), P3(q1, 0), P3(q1, t), P3(q0, t)]);
  return R.revolution(prof, [b.p0[0], b.p0[1], axisZ(b, t)], [b.e[0], b.e[1], 0], (bendSign(b) * b.ang * 180) / Math.PI);
}
// The bends of a closed corner run on into the corner, each up to the other's outer surface; they
// meet on the mitre (the plane halfway between the two walls), like two real bends closing a corner.
function cornerPieces(A, B, t) {
  const out = { a: null, b: null };
  const pair = cornerPairs({ bends: [A, B], t }).find(() => true);
  if (!pair) return out;
  const len = Math.max(A.R, B.R) + 2 * t;
  // (the mitre cut keeps each inside the other's outer surface: past the mitre ρB < ρA ≤ R + t)
  try { out.a = bendRunOn(A, t, pair.X, len); } catch { /* skip */ }
  try { out.b = bendRunOn(B, t, pair.X, len); } catch { /* skip */ }
  return out;
}
// What lies past the mitre for A ('a') or for B ('b'), less half the gap, inside the corner only.
// Corner coordinates: u outward from B's bend line (along B.d), v outward from A's (along A.d), from the
// point Q where the bend lines cross; the mitre is u = v. Flat coordinates of the common panel; H: height.
function cornerUV(A, B) {
  const cr = A.e[0] * B.e[1] - A.e[1] * B.e[0];
  if (Math.abs(cr) < 1e-9) return null;
  const s = ((B.p0[0] - A.p0[0]) * B.e[1] - (B.p0[1] - A.p0[1]) * B.e[0]) / cr;
  const Q = a2(A.p0, m2(A.e, s));
  return (u, v) => a2(a2(Q, m2(B.d, u)), m2(A.d, v));
}
// A prism over a (u, v) outline from height z0 to z1.
function uvPrism(at, uv, z0, z1) {
  const face = R.makePolygon(uv.map(([u, v]) => { const p = at(u, v); return [p[0], p[1], z0]; }));
  return R.basicFaceExtrusion(face, new R.Vector([0, 0, z1 - z0]));
}
function mitreCutter(A, B, t, gap, H, side) {
  const at = cornerUV(A, B);
  if (!at) return null;
  const L = 2 * (Math.max(A.R, B.R) + 2 * t), c = gap / Math.SQRT2, dl = t;
  // a: u ≥ max(0, v − c)   b: v ≥ max(0, u − c)
  const uv = side === 'a' ? [[0, -dl], [L, -dl], [L, L + c], [0, c]] : [[-dl, 0], [-dl, L], [L + c, L], [c, 0]];
  return uvPrism(at, uv, -H, H);
}
// The bend corner of an overlap corner (A covers B), from the two run-on bends pa (about A's axis) and pb
// (about B's). Corner coordinates as in mitreCutter; A's wall inner face is at v = A.R, B's wall ends at
// v = A.R − gap. A keeps its bend up to the mitre (less half the gap below its wall) and takes the part of
// B's bend above v = A.R; B keeps the rest of its bend below v = A.R − gap and the mitre.
function overlapPieces(A, B, t, gap, H, pa, pb) {
  const at = cornerUV(A, B);
  if (!at) return [];
  const L = 2 * (Math.max(A.R, B.R) + 2 * t), c = gap / Math.SQRT2, dl = t, Ra = A.R;
  const keep = (piece, uv) => {
    const pts = uv.filter((p, i) => i === 0 || Math.hypot(p[0] - uv[i - 1][0], p[1] - uv[i - 1][1]) > 1e-9);
    try { return piece.intersect(uvPrism(at, pts, -H, H)); } catch { return null; }
  };
  const out = [];
  if (pa) out.push(keep(pa, [[-dl, L], [L, L], [Ra, Ra], [Ra - c, Ra], [-dl, c - dl]]));
  if (pb) {
    out.push(keep(pb, [[Ra, Ra], [L, Ra], [L, L]]));
    if (Ra - gap > -dl) out.push(keep(pb, [[c - dl, -dl], [L, -dl], [L, Ra - gap], [Ra - gap + c, Ra - gap]]));
  }
  return out.filter(Boolean);
}
// The end of a butt corner's wall past what the flat pattern holds (the flat stops at the inside of the
// mitre): the wall's section run on to the outer corner (the mitre cut trims it). h: the wall's height.
function wallRunOn(A, B, t, h, side) {
  const at = cornerUV(A, B);
  if (!at || !(h > 1e-6)) return null;
  const W = side === 'a' ? A : B, O = side === 'a' ? B : A;
  const far = O.R + 2 * t;
  const uv = side === 'a' ? [[0, A.R], [far, A.R], [far, A.R + t], [0, A.R + t]] : [[B.R, 0], [B.R + t, 0], [B.R + t, far], [B.R, far]];
  const [z0, z1] = W.up ? [t + W.R, t + W.R + h] : [-W.R - h, -W.R];
  return uvPrism(at, uv, z0, z1);
}

// The corner (a pair of bend ids) a picked point on the folded body belongs to: the panel nearest the
// point, then the nearest corner of the bends around that panel. chosen: the bend of the flange picked.
export function cornerAt(sheet, modelPt) {
  if (sheet.flat) return null;
  const pairs = cornerPairs(sheet);
  if (!pairs.length) return null;
  const { panels, links } = fold(sheet);
  const W = frameM(sheet.frame), t = sheet.t;
  let best = null;
  for (const pn of panels) {
    const loc = apM(invM(mulM(W, pn.M)), modelPt);
    const dz = loc[2] < 0 ? -loc[2] : loc[2] > t ? loc[2] - t : 0;
    const d = Math.hypot(distTo(pn.face, P3(loc)), dz);
    if (!best || d < best.d) best = { pn, loc, d };
  }
  const own = new Set(links.filter((lk) => lk.B === best.pn).map((lk) => lk.b.id));
  const around = new Set(links.filter((lk) => lk.A === best.pn || lk.B === best.pn).map((lk) => lk.b.id));
  let pick = null;
  for (const pr of pairs) {
    if (!around.has(pr.A.id) && !around.has(pr.B.id)) continue;
    const d = l2(s2(pr.X, best.loc));
    if (!pick || d < pick.d) pick = { pr, d };
  }
  if (!pick) return null;
  const { A, B } = pick.pr;
  const [c, o] = own.has(B.id) && !own.has(A.id) ? [B, A] : [A, B];
  return { chosen: c.id, other: o.id, dist: best.d };
}

// The folded (or, when unbent, flat) body in model coordinates.
// (Kernel Lab) the last folds, by the sheet's content (tools/patch_fold_memo.py)
const FOLD_MEMO = new Map();
const LAB_FOLDS = (globalThis.LAB_FOLDS = { made: 0, reused: 0 });
// (a shape in the sheet, e.g. its region face, by its content: its BREP text, kept per object; a feature makes the
// region again each time, so the same object is rarely met twice)
const FOLD_SHAPE_TEXT = new WeakMap();
function foldKey(sheet) {
  let plain = true;
  let key = null;
  try {
    key = JSON.stringify(sheet, (n, v) => {
      if (v && typeof v === 'object') {
        if (v instanceof Map || v instanceof Set) { plain = false; return null; }
        if ('wrapped' in v) {
          let t = FOLD_SHAPE_TEXT.get(v);
          if (t === undefined) { t = typeof v.serialize === 'function' ? v.serialize() : null; FOLD_SHAPE_TEXT.set(v, t); }
          if (typeof t !== 'string') { plain = false; return null; }
          return `[shape ${t}]`;
        }
        if (typeof v.delete === 'function') { plain = false; return null; }
      }
      return v;
    });
  } catch { return null; }
  return plain ? key : null;
}
export function toSolid(sheet) {
  const key = foldKey(sheet);
  const kept = key && FOLD_MEMO.get(key);
  if (kept) { FOLD_MEMO.delete(key); FOLD_MEMO.set(key, kept); LAB_FOLDS.reused++; return kept.clone(); }
  const out = toSolidMade(sheet);
  LAB_FOLDS.made++;
  if (key) {
    FOLD_MEMO.set(key, out.clone());
    if (FOLD_MEMO.size > 8) FOLD_MEMO.delete(FOLD_MEMO.keys().next().value);
  }
  return out;
}
function toSolidMade(sheet) {
  const W = frameM(sheet.frame);
  const t = sheet.t;
  if (sheet.lofted && !sheet.flat) return applyM(loftedSolid(sheet), W);
  if (sheet.flat) {
    const P = fold(sheet).panelNear(sheet.flat.pt);
    return placed(prismOf(flatRegion(sheet), t), mulM(W, P?.M || IDENT));
  }
  const { panels, links } = fold(sheet);
  const panelSol = new Map(panels.map((p) => [p, placed(prismOf(p.face, t), p.M, false)]));
  const parts = [];
  // V-cutout corners lengthen their bends (when the two bends start from the same panel)
  const vcuts = new Map();
  for (const c of sheet.corners || []) {
    if (c.type === 'butt' || c.bend === 'mitre') continue;
    const la = links.find((lk) => lk.b.id === c.a), lb = links.find((lk) => lk.b.id === c.b && lk.A === la?.A);
    if (!la || !lb) continue;
    const pair = cornerPairs({ bends: [la.b, lb.b], t })[0];
    if (!pair) continue;
    for (const [bd, top] of [[la.b, c.ea ?? 0], [lb.b, c.eb ?? 0]]) {
      if (!vcuts.has(bd.id)) vcuts.set(bd.id, []);
      // the V line runs from the start of the bend at the corner point (set back by the relief) up to the wall
      vcuts.get(bd.id).push({ X: pair.X, top, mid: Math.min(c.ea ?? 0, c.eb ?? 0), relief: cornerRelief0(c, t) });
    }
  }
  const linkCount = new Map();
  for (const lk of links) linkCount.set(lk.b.id, (linkCount.get(lk.b.id) || 0) + 1);
  const doneV = new Set();
  for (const lk of links) {
    const v = linkCount.get(lk.b.id) === 1 ? vcuts.get(lk.b.id) : null;
    if (v) doneV.add(lk.b.id);
    parts.push(placed(bendSolid(lk.b, t, lk.piece, v), lk.A.M, false));
  }
  for (const c of sheet.corners || []) {
    const la = links.find((lk) => lk.b.id === c.a), lb = links.find((lk) => lk.b.id === c.b && lk.A === la?.A);
    if (!la || !lb) continue; // the bends no longer start from the same panel
    // the bends always meet on the mitre; the walls too for a butt corner (overlap / underlap: the flat
    // pattern already ends them, one covering the other)
    const butt = c.type === 'butt';
    if (!butt && c.bend !== 'mitre') {
      // V cutout (default): each bend runs on as formed from the flat, up to its wall's end at the top;
      // the V line starts at the start of the bend at the corner point
      const pair = cornerPairs({ bends: [la.b, lb.b], t })[0];
      if (pair) {
        // (only bends cut into pieces by slots get their run-on as a separate solid, without the set-back)
        for (const [bd, top] of [[la.b, c.ea], [lb.b, c.eb]].filter(([bd]) => !doneV.has(bd.id))) {
          let p = null;
          try { p = vcutRunOn(bd, t, pair.X, top ?? 0, Math.min(c.ea ?? 0, c.eb ?? 0)); } catch { p = null; }
          if (p) parts.push(applyM(p, la.A.M));
        }
        // both bends set back: the round at the corner point joins them through the panel
        const ps = panelSol.get(la.A);
        if (ps && doneV.has(la.b.id) && doneV.has(lb.b.id) && cornerRelief0(c, t) > 0) {
          try { const rd = cornerReliefRound(la.b, lb.b, t, vcutRelief(t, c.gap)); if (rd) panelSol.set(la.A, ps.cut(applyM(rd, la.A.M))); } catch { /* keep */ }
        }
      }
      continue;
    }
    let { a: pa, b: pb } = cornerPieces(la.b, lb.b, t);
    const bb = bbox2(sheet.region);
    const H = bb.max[0] - bb.min[0] + bb.max[1] - bb.min[1] + 10 * t;
    if (!butt) {
      // closed mitre: a's wall covers b's end, and below the wall the seam carries straight on down b's
      // bend (a covers that part of b's bend too) until it reaches the mitre, which it then follows
      for (const piece of overlapPieces(la.b, lb.b, t, c.gap || 0, H, pa, pb)) parts.push(applyM(piece, la.A.M));
      continue;
    }
    for (const [side, lk] of [['a', la], ['b', lb]]) {
      let cut;
      try { cut = mitreCutter(la.b, lb.b, t, c.gap || 0, H, side); } catch { cut = null; }
      const piece = side === 'a' ? pa : pb;
      if (!piece) continue;
      let p2 = piece;
      if (cut) { try { p2 = piece.cut(cut); } catch { /* keep */ } }
      p2 = applyM(p2, la.A.M);
      if (side === 'a') pa = p2; else pb = p2;
      if (butt) {
        let wr = null;
        try { wr = wallRunOn(la.b, lb.b, t, side === 'a' ? c.ha : c.hb, side); } catch { wr = null; }
        if (wr && cut) { try { wr = wr.cut(cut); } catch { wr = null; } }
        if (wr) parts.push(applyM(wr, la.A.M));
      }
    }
    if (pa) parts.push(pa);
    if (pb) parts.push(pb);
  }
  parts.unshift(...panelSol.values());
  const nBase = panelSol.size + links.length;
  // the panels and bends only touch: fused in one go (much faster, and far less kernel memory, than one
  // at a time), or one at a time when that loses material
  let sol = parts[0], fused = null;
  if (nBase > 1) {
    const base = parts.slice(0, nBase), v = base.reduce((a, p) => a + R.measureVolume(p), 0);
    // (to 1 part in 100 000: a converted bend's curved ends are fitted, which moves its volume by about a millionth;
    // glued first, then in one go without the glue: the glue mishandles bends that only touch along a line, as at
    // a square corner, where the V cuts meet at the corner point)
    for (const glue of [true, false]) {
      try { fused = soleSolid(boolOf('fuse', parts[0], base.slice(1), { glue, solid: true })); } catch { fused = null; }
      if (fused && Math.abs(R.measureVolume(fused) - v) <= Math.abs(v) * 1e-5) break;
      free(fused); fused = null;
    }
    if (fused) sol = fused;
  }
  for (const [i, p] of parts.entries()) {
    if (!i) continue;
    if (i < nBase) {
      if (fused) continue;
      // (the glue option is for shapes that only touch: when it loses material, e.g. bend zones that run on into
      // each other, the fuse is made again without it)
      // (and never a result with less than the larger of the two: a fuse that went wrong, e.g. inside out)
      const va = R.measureVolume(sol), vb = R.measureVolume(p);
      let next = null;
      try { next = fuse3(sol, p, true); } catch { next = null; }
      if (!next || R.measureVolume(next) < (va + vb) * (1 - 1e-5)) {
        free(next);
        try { next = fuse3(sol, p, false); } catch { next = null; }
        if (next && R.measureVolume(next) < Math.max(va, vb) * (1 - 1e-5)) { free(next); next = null; }
      }
      if (next) sol = swap(sol, next);
      continue;
    }
    // corner pieces: a fuse that fails quietly (loses material) leaves the piece out instead
    const v0 = R.measureVolume(sol);
    let next = null;
    for (const glue of [true, false]) {
      try { next = fuse3(sol, p, glue); } catch { next = null; }
      if (next && R.measureVolume(next) >= v0 * (1 - 1e-6)) break;
      free(next);
      next = null;
    }
    if (next) sol = swap(sol, next);
  }
  for (const p of parts) if (p !== sol) free(p);
  sol = swap(sol, formSolid(sheet, sol)); // (dimples, louvers, extruded holes, gussets)
  const one = clean(sol, sheet.tidyTol || 0);
  if (one !== sol && one.constructor === sol.constructor) sol = swap(sol, one); else if (one !== sol) free(one);
  return placed(sol, W);
}
// a compound of one solid → that solid
function soleSolid(shape) {
  if (!(shape instanceof R.Compound)) return shape;
  const solids = [...R.iterTopo(shape.wrapped, 'solid')];
  const sol = solids.length === 1 ? own(solids[0]) : null;
  if (sol && sol.faces.length === shape.faces.length) { free(shape); return sol; }
  free(sol, ...solids);
  return shape;
}
// a temporary shape moved into place (and freed)
function placed(shape, M, copy = true) { try { return applyM(shape, M, copy); } finally { free(shape); } }
// Is the model point on one of the sheet's bends (its round faces)?
export const onBend = (sheet, p) => !sheet.lofted && !sheet.flat && !!locateOnBend(sheet, p);
function prismOf(region, t) {
  const fs = facesOf(region);
  if (fs.length === 1) return R.basicFaceExtrusion(fs[0], new R.Vector([0, 0, t]));
  let sol = null;
  for (const f of fs) { const p = R.basicFaceExtrusion(f, new R.Vector([0, 0, t])); if (sol) { sol = swap(sol, fuse3(sol, p)); free(p); } else sol = p; }
  return sol;
}

// ------------------------------------------------------------ base flange
// region: the sketch profile as faces in the sketch plane's own coordinates (z = 0)
export function baseFlange({ region, frame, t, R: R0, K, reverse }) {
  if (!(t > 0)) throw new Error('The thickness must be greater than zero');
  // material on the sketch's other side: look at the pattern from behind (mirror x, flip the normal)
  let fr = frame, reg = upFaces(region);
  if (reverse) {
    fr = { o: frame.o, u: mul3(frame.u, -1), v: frame.v, n: mul3(frame.n, -1) };
    reg = upFaces(applyM(reg, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]));
  }
  const f0 = facesOf(reg)[0];
  const c = f0 ? f0.center : [0, 0, 0];
  const cc = Array.isArray(c) ? c : c.toTuple ? c.toTuple() : [c.x, c.y, c.z];
  const rootPt = [cc[0], cc[1]];
  return { t, K, R: R0, frame: fr, region: reg, bends: [], rootPt: insidePoint(reg, rootPt), flat: null, stale: null, nextBend: 1 };
}
// a point inside the region (the centre of the first face may be in a hole)
function insidePoint(region, guess) {
  const fs = facesOf(region);
  if (faceAt(fs, guess)) return guess;
  for (const f of fs) {
    const loop = wireLoop(f.clone().outerWire(), 8);
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], n = u2([-(b[1] - a[1]), b[0] - a[0]]);
      for (const k of [1e-3, 1e-2, 1e-1]) for (const sg of [1, -1]) { const q = a2(m, m2(n, sg * k)); if (faceAt(fs, q)) return q; }
    }
  }
  return guess;
}

// ------------------------------------------------------------ edge flanges
// Find a straight model edge (a, b in model coordinates) on the pattern: the panel it belongs to,
// the segment in flat coordinates, and whether it lies on the top (z = t) or bottom (z = 0) face.
export function locateEdge(sheet, a, b) {
  const { panels } = fold(sheet);
  const W = frameM(sheet.frame), t = sheet.t, tol = Math.max(1e-4, t * 1e-3);
  for (const P of panels) {
    const L = invM(mulM(W, P.M));
    const qa = apM(L, a), qb = apM(L, b);
    const top = Math.abs(qa[2] - t) < tol && Math.abs(qb[2] - t) < tol;
    const bottom = Math.abs(qa[2]) < tol && Math.abs(qb[2]) < tol;
    if (!top && !bottom) continue;
    const pa = [qa[0], qa[1]], pb = [qb[0], qb[1]];
    const m = m2(a2(pa, pb), 0.5), n = u2([-(pb[1] - pa[1]), pb[0] - pa[0]]);
    const dl = Math.max(1e-3, t * 0.01);
    const inA = !!faceAt([P.face], a2(m, m2(n, dl))), inB = !!faceAt([P.face], a2(m, m2(n, -dl)));
    if (inA === inB || !faceAt([P.face], m, 1e-6)) continue;
    return { panel: P, pa, pb, top, d: inA ? m2(n, -1) : n };
  }
  return null;
}

// Add edge flanges. edges: [{ a, b }] (model coordinates of straight edges on the sheet's faces).
// opts: { length, lengthRef: 'outer'|'inner'|'tangent', angle (°), position: 'inside'|'outside'|'bend',
//   offset, R, flip, relief: { type: 'rect'|'obround'|'tear', ratio } }
export function addFlanges(sheet, edges, opts) {
  if (sheet.lofted) throw new Error('Edge flanges cannot be added to a lofted bend (its shape comes from the two profiles)');
  if (sheet.flat) throw new Error('Fold the part (Bend feature) before adding flanges');
  const t = sheet.t, R0 = opts.R > 0 ? opts.R : sheet.R, K = sheet.K;
  const ang = (Math.min(Math.max(opts.angle, 1), opts.maxAngle || 179) * Math.PI) / 180;
  if (!(opts.length > 0) && !opts.rolled) throw new Error('The flange length must be greater than zero');
  const ba = bendAllowance(ang, R0, K, t);
  const items = edges.map((ed, i) => {
    const loc = locateEdge(sheet, ed.a, ed.b);
    if (!loc) throw new Error(`Edge ${i + 1} is not a straight edge on the top or bottom face of the sheet`);
    const up = loc.top !== !!opts.flip;
    // how far the bend line moves in from the edge
    const pos = opts.position || 'inside';
    let dt = pos === 'inside' ? setback(ang, R0 + t) : pos === 'outside' ? setback(ang, R0) : 0;
    dt -= opts.offset || 0;
    const e = u2(s2(loc.pb, loc.pa)), w = l2(s2(loc.pb, loc.pa));
    // the flat length of the straight part of the flange
    const ref = opts.lengthRef || 'outer';
    const h = opts.rolled ? 0 : opts.length - (ref === 'outer' ? setback(ang, R0 + t) : ref === 'inner' ? setback(ang, R0) : 0);
    if (!(h > 1e-6) && !opts.rolled) throw new Error('The flange is shorter than its bend: make it longer');
    // (a flange along part of the edge: extent 'offsets', a and b in from its start and end (swap: the other way
    // round), or 'centered', width wide in its middle; the rest of the edge stays as it is)
    const x = opts.extent || { type: 'full' };
    let i0 = 0, i1 = 0;
    if (x.type === 'offsets') { [i0, i1] = x.swap ? [x.b, x.a] : [x.a, x.b]; if (!(i0 >= 0 && i1 >= 0)) throw new Error('A flange’s offsets from the ends of its edge can’t be negative'); }
    else if (x.type === 'centered') { if (!(x.width > 0)) throw new Error('The flange width must be greater than zero'); i0 = i1 = (w - x.width) / 2; if (i0 < -1e-9) throw new Error('The flange is wider than its edge'); i0 = i1 = Math.max(0, i0); }
    else if (x.type !== 'full') throw new Error('Select a supported flange width');
    if (i0 + i1 >= w - 1e-6) throw new Error('A flange’s offsets leave nothing of its edge');
    return { ...loc, e, w, up, dt, h, s0: 0, s1: 0, i0, i1 };
  });
  // flanges sharing a corner stop at the other flange's bend line (an open corner, closed later if wanted)
  const tolC = Math.max(1e-4, t * 1e-3);
  for (const it of items) {
    for (const ot of items) {
      if (ot === it) continue;
      for (const [end, k] of [[it.pa, 's0'], [it.pb, 's1']]) {
        if (l2(s2(end, ot.pa)) < tolC || l2(s2(end, ot.pb)) < tolC) { it[k] = Math.max(it[k], ot.dt); it['meets' + k] = true; }
      }
    }
  }
  for (const it of items) { it.s0 += it.i0; it.s1 += it.i1; }
  let region = sheet.region;
  // trim the panels back to the bend lines (over the whole edge, which leaves the corner notches; a flange along part
  // of its edge: over that part only)
  for (const it of items) {
    const part = it.i0 > 1e-9 || it.i1 > 1e-9, from = part ? a2(it.pa, m2(it.e, it.i0)) : it.pa, wide = part ? it.w - it.i0 - it.i1 : it.w;
    if (it.dt > 1e-9) region = bop('cut', region, rectFace(from, it.e, it.d, wide, -it.dt));
    else if (it.dt < -1e-9) region = bop('fuse', region, rectFace(from, it.e, it.d, wide, -it.dt));
  }
  const bends = [...sheet.bends];
  let nextBend = sheet.nextBend || bends.length + 1;
  const added = [];
  for (const it of items) {
    const w = it.w - it.s0 - it.s1;
    if (!(w > 1e-6)) throw new Error('A flange is too short between its corners');
    const p0 = a2(a2(it.pa, m2(it.e, it.s0)), m2(it.d, -it.dt));
    const bend = { id: 'b' + nextBend++, p0, e: it.e, d: it.d, w, ba, ang, up: it.up, R: R0, ...(opts.rolled ? { end: true } : {}) };
    region = bop('fuse', region, stripFace(bend));
    if (it.h > 1e-6) region = bop('fuse', region, rectFace(a2(p0, m2(it.d, ba)), it.e, it.d, w, it.h));
    bends.push(bend);
    added.push({ bend, it });
  }
  // hems folded back over the sheet meeting at a corner: their legs would lie on each other there, so
  // each is cut back on the diagonal (a mitre, mitreLegs the gap). A leg point x along the edge from the
  // corner and y into the leg lies (dt + y) from its own edge and x from the other one.
  if (opts.mitreLegs != null) {
    const g = opts.mitreLegs / 2;
    for (const { bend, it } of added) {
      if (!(it.h > 1e-6)) continue;
      for (const [k, base, ex] of [['s0', it.pa, it.e], ['s1', it.pb, m2(it.e, -1)]]) {
        if (!it['meets' + k]) continue;
        const H = it.h + 1, dt = it.dt;
        const map = ([x, y]) => a2(a2(base, m2(ex, x)), m2(it.d, -dt + bend.ba + y));
        region = bop('cut', region, polyFace([[dt + g, 0], [dt + g + H, H], [-1, H], [-1, 0]].map(map)));
      }
    }
  }
  // reliefs where a bend zone ends next to material that doesn't fold with it
  const rl = opts.relief || { type: 'rect', ratio: 0.5 };
  for (const { bend, it } of added) {
    for (const [x, dir] of [[0, -1], [bend.w, 1]]) {
      const end = a2(bend.p0, m2(bend.e, x));
      const probe = a2(a2(end, m2(bend.e, dir * Math.max(1e-3, t * 0.02))), m2(bend.d, Math.min(bend.ba, Math.max(it.dt, 0)) * 0.5 + 1e-4));
      if (!faceAt(facesOf(region), probe, 1e-9)) continue;
      region = bop('cut', region, reliefFace(bend, x, dir, Math.max(it.dt, 0), t, rl));
    }
  }
  return { ...sheet, region, bends, nextBend };
}

// Hems: the edge folded back on itself. type: 'closed' (flat on the sheet, a hairline gap), 'open' (gap
// between the layers), 'teardrop' (bent past 180° at radius R so the leg leans back onto the sheet) or
// 'rolled' (a curl of angle at radius R, no straight leg). length: from the outer face of the fold to
// the end of the hem (closed / open; a teardrop's leg runs back to the sheet). position: 'inside' (the fold's outer face stays at the edge) | 'outside' (the hem
// is added beyond the edge).
export function addHems(sheet, edges, { type = 'closed', length, gap = 0, R: Rh, angle, position = 'inside', flip = false, relief }) {
  if (sheet.lofted) throw new Error('Hems cannot be added to a lofted bend (its shape comes from the two profiles)');
  const t = sheet.t;
  let R0, ang = 180, rolled = false;
  if (type === 'closed') R0 = Math.max(0.005, 0.005 * t);
  else if (type === 'open') { if (!(gap > 0)) throw new Error('The gap of an open hem must be greater than zero'); R0 = gap / 2; }
  else {
    if (!(Rh > 0)) throw new Error('The hem radius must be greater than zero');
    R0 = Rh;
    ang = angle;
    if (type === 'teardrop' && !(ang > 180 && ang < 270)) throw new Error('A teardrop hem is bent 181° to 269°');
    if (type === 'rolled' && !(ang >= 90 && ang <= 340)) throw new Error('A rolled hem is bent 90° to 340°');
    rolled = type === 'rolled';
  }
  // the straight leg: a teardrop's runs back until it (almost) touches the sheet
  const a = (ang * Math.PI) / 180;
  let leg = rolled ? 0 : length - (R0 + t);
  if (type === 'teardrop') leg = (R0 * (1 - Math.cos(a)) - Math.max(0.01, 0.005 * t)) / -Math.sin(a);
  else if (!rolled && !(leg > 1e-6)) throw new Error(`The hem must be longer than its fold (more than ${+(R0 + t).toFixed(3)} mm)`);
  return addFlanges(sheet, edges, {
    length: leg, lengthRef: 'tangent', angle: ang, maxAngle: 340, rolled, mitreLegs: Math.max(0.1, 0.05 * t),
    position: position === 'outside' ? 'bend' : 'inside', offset: 0, R: R0, flip, relief,
  });
}

// A relief cut beside the end (at x along the bend line) of a bend zone, on the side dir (±1).
function reliefFace(b, x, dir, dt, t, rl) {
  const wR = rl.type === 'tear' ? Math.max(0.02, 0.02 * t) : Math.max(0.05, (rl.ratio || 0.5) * t);
  const depth = rl.type === 'tear' ? 0 : wR; // below the bend line, into the panel
  const top = Math.max(dt, b.ba) + 1e-3 + (dt > 0 ? 0 : 0);
  const start = a2(a2(b.p0, m2(b.e, x)), m2(b.d, -depth));
  const ex = m2(b.e, dir);
  let f = rectFace(start, ex, b.d, wR, depth + top);
  if (rl.type === 'obround' && depth > 0) {
    // round end below the bend line
    const c = a2(start, m2(ex, wR / 2));
    f = bop('fuse', rectFace(a2(start, m2(b.d, wR / 2)), ex, b.d, wR, depth + top - wR / 2), circleFace(c, wR / 2));
  }
  return f;
}

// ------------------------------------------------------------ corner relief / closed corner
// Pairs of bends that meet at a corner (their zones end close to each other, not parallel).
function cornerPairs(sheet) {
  const out = [];
  const bs = sheet.bends;
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      const A = bs[i], B = bs[j];
      const cr = A.e[0] * B.e[1] - A.e[1] * B.e[0];
      if (Math.abs(cr) < 1e-6) continue;
      // where the two bends' centre lines cross
      const ca = a2(A.p0, m2(A.d, A.ba / 2)), cb = a2(B.p0, m2(B.d, B.ba / 2));
      const s = ((cb[0] - ca[0]) * B.e[1] - (cb[1] - ca[1]) * B.e[0]) / cr;
      const X = a2(ca, m2(A.e, s));
      const xb = d2(s2(X, cb), B.e);
      const reach = Math.max(A.ba, B.ba) + 3 * sheet.t + Math.max(A.R, B.R) * 2;
      const nearA = s >= -reach && s <= A.w + reach, nearB = xb >= -reach && xb <= B.w + reach;
      if (nearA && nearB && (s < 0 || s > A.w) && (xb < 0 || xb > B.w)) out.push({ A, B, X });
    }
  }
  return out;
}

// Relief at every corner where two bends meet: rect (square) | circle | tear (none) of size.
export function cornerRelief(sheet, { type = 'rect', size }) {
  if (sheet.lofted) throw new Error('Corner reliefs cannot be added to a lofted bend (its shape comes from the two profiles)');
  const pairs = cornerPairs(sheet);
  if (!pairs.length) throw new Error('There is no corner where two bends meet');
  let region = sheet.region;
  const sz = size > 0 ? size : 2 * sheet.t;
  for (const { A, B, X } of pairs) {
    if (type === 'tear') continue;
    let f;
    if (type === 'circle') f = circleFace(X, sz / 2);
    else {
      // a square aligned with the first bend, centred on the corner
      f = rectFace(a2(a2(X, m2(A.e, -sz / 2)), m2(A.d, -sz / 2)), A.e, A.d, sz, sz);
    }
    region = bop('cut', region, f);
  }
  return { ...sheet, region, cornerCount: pairs.length };
}

// Close the open corners between 90° flanges: one flange runs on to the other's outer face (covering
// its end), the other runs on to the first one's inner face, less the gap. swap: the other way round.
// only: a Set of bend ids (only corners between two of these); quiet: no error when there is nothing to close.
// type: 'overlap' (the first flange covers the other's end) | 'underlap' (the other way) | 'butt' (mitred) |
// 'square' (both to the other's inner face, square ended, less the gap's share across the inside corner: the
// walls' inner edges are the gap apart; the bends always a V cutout).
// picks: [{ chosen, other }] bend ids of the corners to close (chosen = the flange picked); else every corner.
// bend: 'vcut' (the bends as formed from the flat, a lens-shaped opening between them) | 'mitre' (closed).
export function closedCorner(sheet, { gap = 0, swap = false, only = null, quiet = false, type = 'overlap', picks = null, bend = 'vcut' }) {
  if (sheet.lofted) throw new Error('Closed corners cannot be added to a lofted bend (its shape comes from the two profiles)');
  const byId = new Map(sheet.bends.map((b) => [b.id, b]));
  let pairs;
  if (picks) {
    const seen = new Set();
    pairs = [];
    for (const pk of picks) {
      const A = byId.get(pk.chosen), B = byId.get(pk.other);
      const key = [pk.chosen, pk.other].sort().join('|');
      if (!A || !B || seen.has(key)) continue;
      seen.add(key);
      const pr = cornerPairs({ bends: [A, B], t: sheet.t })[0];
      if (pr) pairs.push({ A, B, X: pr.X });
    }
  } else pairs = cornerPairs(sheet).filter((p) => !only || (only.has(p.A.id) && only.has(p.B.id))).map((p) => (swap ? { A: p.B, B: p.A, X: p.X } : p));
  if (!pairs.length) {
    if (quiet) return { ...sheet, cornerCount: 0 };
    throw new Error('There is no corner where two flanges meet');
  }
  const t = sheet.t;
  let region = sheet.region;
  let n = 0;
  const corners = [...(sheet.corners || [])];
  const end = (A, X) => {
    const atEnd = d2(s2(X, A.p0), A.e) > A.w / 2;
    return { Pe: a2(A.p0, m2(A.e, atEnd ? A.w : 0)), dir: m2(A.e, atEnd ? 1 : -1) };
  };
  const butt = type === 'butt', square = type === 'square';
  for (const pr of pairs) {
    const [A, B] = type === 'underlap' ? [pr.B, pr.A] : [pr.A, pr.B];
    if (Math.abs(A.ang - Math.PI / 2) > 1e-3 || Math.abs(B.ang - Math.PI / 2) > 1e-3) continue;
    if (Math.abs(d2(A.e, B.d)) < 0.999 || Math.abs(d2(B.e, A.d)) < 0.999) continue; // the walls must meet square
    const ea = end(A, pr.X), eb = end(B, pr.X);
    // A to B's outer face (B.R + t from B's bend line), B to A's inner face (A.R from A's) less the gap
    let extA = (B.R + t - d2(s2(ea.Pe, B.p0), B.d)) / d2(ea.dir, B.d);
    // butt: the flat pattern takes both walls to the inside of the mitre (so they can never meet in the
    // flat); the rest of the mitred end is added to the folded body (wallRunOn)
    // (square: the same as butt in the flat, folded without the mitred rest)
    const c45 = gap / Math.SQRT2;
    const extB = (A.R - d2(s2(eb.Pe, A.p0), A.d)) / d2(eb.dir, A.d) - (butt || square ? c45 : gap);
    if (butt || square) extA = (B.R - d2(s2(ea.Pe, B.p0), B.d)) / d2(ea.dir, B.d) - c45;
    const hA = wallHeight(region, A), hB = wallHeight(region, B);
    let done = false;
    if (extA > 1e-6 && hA > 1e-6) { region = bop('fuse', region, rectFace(a2(ea.Pe, m2(A.d, A.ba)), ea.dir, A.d, extA, hA)); done = true; }
    if (extB > 1e-6 && hB > 1e-6) { region = bop('fuse', region, rectFace(a2(eb.Pe, m2(B.d, B.ba)), eb.dir, B.d, extB, hB)); done = true; }
    // the bends run on into the corner too (same bend radius and direction only)
    if (A.up === B.up && Math.abs(A.R - B.R) < 1e-9) {
      const k = corners.findIndex((c) => (c.a === A.id && c.b === B.id) || (c.a === B.id && c.b === A.id));
      if (k >= 0) corners.splice(k, 1);
      corners.push({ a: A.id, b: B.id, gap, type: butt ? 'butt' : square ? 'square' : 'overlap', bend: bend === 'mitre' && !square ? 'mitre' : 'vcut', ea: extA, eb: extB, ...(butt ? { ha: hA, hb: hB } : {}) });
      done = true;
    }
    if (done) n++;
  }
  if (!n) {
    if (quiet) return { ...sheet, cornerCount: 0 };
    throw new Error('No corner between two 90° flanges was found to close');
  }
  return { ...sheet, region, corners, cornerCount: n };
}
// how far the flat wall reaches beyond a bend zone (measured along the middle of the bend)
function wallHeight(region, b) {
  const fs = facesOf(region);
  const mid = a2(b.p0, m2(b.e, b.w / 2));
  let lo = b.ba, hi = b.ba + 1e4;
  if (!faceAt(fs, a2(mid, m2(b.d, b.ba + 1e-4)))) return 0;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (faceAt(fs, a2(mid, m2(b.d, m)))) lo = m; else hi = m; }
  // (on the outline's straight edge there exactly: the point test only finds it to its tolerance, a ten-millionth
  // of a mm, and a corner's run-on of the wall that far off its edge would leave the wall's end face split there)
  const across = d2(s2(mid, b.p0), b.e);
  for (const f of fs) for (const e of f.edges) {
    if (e.geomType !== 'LINE') continue;
    const [p, q] = edgePts(e, 1), sp = d2(s2(p, b.p0), b.d), sq = d2(s2(q, b.p0), b.d);
    const ep = d2(s2(p, b.p0), b.e), eq = d2(s2(q, b.p0), b.e);
    if (Math.abs(sp - lo) < 1e-5 && Math.abs(sq - lo) < 1e-5 && Math.min(ep, eq) <= across && across <= Math.max(ep, eq)) return (sp + sq) / 2 - b.ba;
  }
  return lo - b.ba;
}

// ------------------------------------------------------------ cuts on sheet metal
// A cutting tool (solid, model coordinates) applied to the pattern: where it passes through the
// sheet (at mid-thickness) the pattern gets a hole. Panels are exact; in bends the hole outline
// is traced on the bent strip and unrolled.
export function cutSheet(sheet, tool) {
  if (sheet.lofted?.method === 'developed') return cutDeveloped(sheet, tool);
  if (sheet.lofted) return cutLofted(sheet, tool);
  const W = frameM(sheet.frame), t = sheet.t;
  let holes = null;
  const midPlane = (box) => rectFace([box.min[0] - 1, box.min[1] - 1], [1, 0], [0, 1], box.max[0] - box.min[0] + 2, box.max[1] - box.min[1] + 2);
  // the tool's section with the mid-thickness plane of a panel (whose flat → model placement is M)
  const section = (box, M) => {
    const local = applyM(tool, invM(mulM(W, M)), false), plane = placed(midPlane(box), transM([0, 0, t / 2]));
    const sec = bop('common', plane, local);
    free(local, plane);
    return sec && placed(sec, transM([0, 0, -t / 2]));
  };
  if (sheet.flat) {
    const P = fold(sheet).panelNear(sheet.flat.pt);
    holes = section(bbox2(sheet.region), P?.M || IDENT);
  } else {
    const { panels, links } = fold(sheet);
    for (const P of panels) {
      const sec = section(bbox2(P.face), P.M);
      if (!sec) continue;
      const hole = bop('common', sec, P.face);
      free(sec);
      if (hole) { holes = swap(holes, bop('fuse', holes, hole)); if (hole !== holes) free(hole); }
    }
    for (const lk of links) {
      const b = lk.b;
      const local = applyM(tool, invM(mulM(W, lk.A.M)), false);
      // the neutral (mid-thickness) surface of the bend, and the tool's footprint on it
      const q1 = a2(b.p0, m2(b.e, b.w));
      const line = R.makeLine(P3(b.p0, t / 2), P3(q1, t / 2));
      const surf = revolveEdge(line, [b.p0[0], b.p0[1], axisZ(b, t)], [b.e[0], b.e[1], 0], (bendSign(b) * b.ang * 180) / Math.PI);
      const foot = surf ? bop('common', surf, local) : null;
      free(local, line, surf);
      for (const face of facesOf(foot)) {
        // the footprint unrolled: traced at 48 points per curved edge, each edge then made one smooth
        // B-spline (a polyline would give the pattern, and so the folded body, hundreds of tiny faces)
        const outer = face.clone().outerWire();
        const runs = wireRuns(outer, 48).map((r) => ({ ...r, pts: r.pts.map((p) => unwrapPoint(b, t, p)) }));
        let hole = null;
        try { hole = runsFace(runs); } catch { hole = null; }
        if (!hole) {
          const loop = runs.flatMap((r, i) => (i ? r.pts.slice(1) : r.pts));
          if (loop.length > 1 && l2(s2(loop[0], loop[loop.length - 1])) < 1e-7) loop.pop();
          if (loop.length >= 3) hole = polyFace(loop);
        }
        free(outer, face);
        if (hole) { holes = swap(holes, bop('fuse', holes, hole)); if (hole !== holes) free(hole); }
      }
      free(foot);
    }
  }
  if (!holes) return { sheet, hit: false };
  const region = bop('cut', sheet.region, holes);
  free(holes);
  if (!region) throw new Error('The cut removes the whole sheet');
  return { sheet: { ...sheet, region }, hit: true };
}
// A developed sheet cut: its body cut, and unrolled again from the same face (found by a point kept on it), so the
// hole is in the flat pattern too. The sheet's frame carries on from the old one.
function cutDeveloped(sheet, tool) {
  const L = sheet.lofted, W = frameM(sheet.frame);
  const local = applyM(tool, invM(W));
  let cut;
  try { cut = soleSolid(cut3(L.solid, local)); } finally { free(local); }
  const v0 = R.measureVolume(L.solid), v1 = R.measureVolume(cut);
  if (Math.abs(v1 - v0) <= 1e-9 * v0) { free(cut); return { sheet, hit: false }; }
  const face = cut.faces.map((f) => ({ f, d: distTo(f, L.seed) })).sort((a, b) => a.d - b.d)[0];
  if (!face || face.d > 0.05) throw new Error('The cut took away the face the sheet is unrolled from');
  const { sheet: s2 } = fromSolid(cut, face.f, { R: sheet.R, K: sheet.K });
  return { sheet: { ...s2, frame: frameOfM(mulM(W, frameM(s2.frame))) }, hit: true };
}
// A lofted bend's flat pattern is developed triangle by triangle at the neutral layer (loftedSheet), so
// the tool's footprint is traced on each neutral triangle and carried to that triangle's place in the flat
// (each point by where it lies in its triangle). The body is cut by the tool as it is (lofted.cuts).
function cutLofted(sheet, tool) {
  const L = sheet.lofted;
  if (!L.N) throw new Error('A cut on this lofted bend is not carried into its flat pattern');
  const local = applyM(tool, invM(frameM(sheet.frame)));
  const n = L.A.length - 1, N = L.N;
  const flatOf = (v) => (v <= n ? L.stations[v][0] : L.stations[v - n - 1][1]);
  const tb = bbox2(local), pad = Math.max(1e-6, sheet.t);
  const holes = [];
  for (let i = 0; i < n; i++) {
    for (const tr of [[i, i + 1, n + 1 + i], [i + 1, n + 2 + i, n + 1 + i]]) {
      const [p, q, r] = tr.map((v) => N[v]);
      const e1 = sub3(q, p), e2 = sub3(r, p), nr = cross3(e1, e2), nn = dot3(nr, nr);
      if (!(nn > 1e-18)) continue; // a sliver: nothing of it is flat
      if ([0, 1, 2].some((k) => Math.max(p[k], q[k], r[k]) < tb.min[k] - pad || Math.min(p[k], q[k], r[k]) > tb.max[k] + pad)) continue;
      const foot = bop('common', R.makePolygon([p, q, r]), local);
      if (!foot) continue;
      const [fp, fq, fr] = tr.map(flatOf);
      // a point of the triangle → the same point of its flat copy
      const toFlat = (x) => {
        const d = sub3(x, p), c = cross3(d, e2), w1 = dot3(c, nr) / nn, w2 = dot3(cross3(e1, d), nr) / nn;
        return a2(a2(fp, m2(s2(fq, fp), w1)), m2(s2(fr, fp), w2));
      };
      for (const f of facesOf(foot)) {
        // (a few points per curved edge: each piece is one thin triangle's worth of the cut)
        let h = polyFace(wireLoop(f.clone().outerWire(), 4).map(toFlat));
        for (const w of f.clone().innerWires()) h = bop('cut', h, polyFace(wireLoop(w, 4).map(toFlat))) || h;
        holes.push(h);
      }
    }
  }
  if (!holes.length) return { sheet, hit: false };
  // (as separate tools: neighbouring holes share edges, which one compound tool may not)
  const O = oc(), op = new O.BRepAlgoAPI_Cut();
  const list = (shapes) => { const Ls = new O.NCollection_List_TopoDS_Shape(); for (const x of shapes) Ls.Append(x.wrapped); return Ls; };
  const args = list([sheet.region]), tools = list(holes);
  let region;
  try {
    op.SetArguments(args); op.SetTools(tools); op.Build(new O.Message_ProgressRange());
    if (op.HasErrors()) throw new Error('The cut could not be traced on the flat pattern');
    const out = R.cast(op.Shape());
    region = out.faces.length ? clean(out) : null;
  } finally { op.delete(); args.delete(); tools.delete(); }
  if (!region || !facesOf(region).length) throw new Error('The cut removes the whole sheet');
  const lofted = { ...L, cuts: [...(L.cuts || []), local] };
  return { sheet: { ...sheet, region, lofted, rootPt: insidePoint(region, sheet.rootPt) }, hit: true };
}

// A cut lofted bend as it is made: the blank is laser cut flat and then formed, so every cut edge is square
// to the sheet. The uncut body is split by a band square to the sheet over each cut edge of the flat
// pattern (the edge carried from the flat to the neutral layer, then each way along the sheet's normal),
// and the pieces inside the pattern are kept. null when it can't be done (the caller cuts with the tools).
function trimLofted(whole, sheet) {
  const L = sheet.lofted, n = L.A.length - 1, N = L.N, t = sheet.t;
  if (!N || !sheet.region) return null;
  const flatOf = (v) => (v <= n ? L.stations[v][0] : L.stations[v - n - 1][1]);
  // the neutral layer's triangles (as developed), with their flat copies
  const tris = [];
  for (let i = 0; i < n; i++) {
    for (const tr of [[i, i + 1, n + 1 + i], [i + 1, n + 2 + i, n + 1 + i]]) {
      const [p, q, r] = tr.map((v) => N[v]), nr = cross3(sub3(q, p), sub3(r, p));
      const [fp, fq, fr] = tr.map(flatOf), e1 = s2(fq, fp), e2 = s2(fr, fp), det = e1[0] * e2[1] - e1[1] * e2[0];
      if (len3(nr) > 1e-12 && Math.abs(det) > 1e-12) tris.push({ tr, nr, fp, e1, e2, det });
    }
  }
  if (!tris.length) return null;
  // the normal at each point of the neutral layer (area weighted, the same both sides of a seam point)
  const nV = N.map(() => [0, 0, 0]);
  for (const T of tris) for (const v of T.tr) nV[v] = add3(nV[v], T.nr);
  weldNormals(N, nV);
  for (let v = 0; v < nV.length; v++) nV[v] = unit3(nV[v]);
  // a flat point → the neutral layer: its point and normal (in the triangle that holds it best)
  const toModel = (q) => {
    let best = null;
    for (const T of tris) {
      const d = s2(q, T.fp), u = (d[0] * T.e2[1] - d[1] * T.e2[0]) / T.det, w = (T.e1[0] * d[1] - T.e1[1] * d[0]) / T.det;
      const ws = [1 - u - w, u, w], worst = Math.min(...ws);
      if (!best || worst > best.worst) best = { T, ws, worst };
    }
    const { T, ws } = best;
    let p = [0, 0, 0], m = [0, 0, 0];
    T.tr.forEach((v, k) => { p = add3(p, mul3(N[v], ws[k])); m = add3(m, mul3(nV[v], ws[k])); });
    return { p, m: unit3(m) };
  };
  // the sheet's own outline (A along, B back): edges of the pattern on it are not cut edges
  const outline = [...L.stations.map((s) => s[0]), ...L.stations.map((s) => s[1]).reverse()];
  const offOutline = (q) => {
    let dmin = Infinity;
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i], b = outline[(i + 1) % outline.length], ab = s2(b, a), L2 = d2(ab, ab);
      const k = L2 > 0 ? Math.max(0, Math.min(1, d2(s2(q, a), ab) / L2)) : 0;
      dmin = Math.min(dmin, l2(s2(q, a2(a, m2(ab, k)))));
    }
    return dmin;
  };
  // the cut edges as runs of flat points, split at corners (each run becomes one smooth band face)
  const runs = [];
  const corner = (a, b, c) => { const u = u2(s2(b, a)), w = u2(s2(c, b)); return d2(u, w) < Math.cos((20 * Math.PI) / 180); };
  for (const f of facesOf(sheet.region)) {
    for (const w of [f.clone().outerWire(), ...f.clone().innerWires()]) {
      const loop = [];
      for (const p of wireLoop(w, 1)) if (!loop.length || l2(s2([p[0], p[1]], loop[loop.length - 1])) > 1e-4) loop.push([p[0], p[1]]);
      if (loop.length > 1 && l2(s2(loop[0], loop[loop.length - 1])) < 1e-4) loop.pop();
      const m = loop.length;
      if (m < 3) continue;
      const cut = loop.map((q, i) => { const r = loop[(i + 1) % m]; return offOutline(m2(a2(q, r), 0.5)) > 1e-4 || (offOutline(q) > 1e-4 && offOutline(r) > 1e-4); });
      if (!cut.some(Boolean)) continue;
      // walk the loop from the start of a run (after an outline segment), or, when it is cut all round
      // (a hole), from a corner; a run ends at the outline (open: it goes on past the sheet's edge) or a corner
      const allCut = cut.every(Boolean);
      const s0 = allCut ? Math.max(0, loop.findIndex((q, i) => corner(loop[(i + m - 1) % m], q, loop[(i + 1) % m]))) : cut.findIndex((c, i) => c && !cut[(i + m - 1) % m]);
      let cur = null;
      for (let k = 0; k < m; k++) {
        const i = (s0 + k) % m, a = loop[i], b = loop[(i + 1) % m];
        if (!cut[i]) { if (cur) { cur.open[1] = true; runs.push(cur); cur = null; } continue; }
        if (cur && corner(cur.pts[cur.pts.length - 2], a, b)) { runs.push(cur); cur = null; }
        if (!cur) cur = { pts: [a], open: [!allCut && !cut[(i + m - 1) % m], false] };
        cur.pts.push(b);
      }
      if (cur) runs.push(cur);
    }
  }
  // a run that closes on itself (a round hole): in quarters, so no band face closes on itself
  for (let k = runs.length - 1; k >= 0; k--) {
    const pts = runs[k].pts;
    if (pts.length > 4 && l2(s2(pts[0], pts[pts.length - 1])) < 1e-7) {
      const q = Math.ceil((pts.length - 1) / 4), parts = [];
      for (let s = 0; s < pts.length - 1; s += q) parts.push({ pts: pts.slice(s, Math.min(s + q, pts.length - 1) + 1), open: [false, false] });
      runs.splice(k, 1, ...parts);
    }
  }
  if (!runs.length) return null;
  // the bands: each run on the neutral layer, carried 2t each way along the normal (past both faces)
  const O = oc(), h = 2 * t, faces = [];
  const curve = (pts) => (pts.length === 2 ? R.makeLine(pts[0], pts[1]) : R.makeBSplineApproximation(pts, { tolerance: 1e-3, degMax: 3 }));
  // (each run evenly resampled: the cut edges are smooth curves, and fewer points give band faces of
  // few spans, which split the sheet many times faster)
  const resample = (pts, count) => {
    const S0 = [0];
    for (let i = 1; i < pts.length; i++) S0.push(S0[i - 1] + l2(s2(pts[i], pts[i - 1])));
    const total = S0[S0.length - 1];
    if (pts.length <= count || !(total > 0)) return pts;
    const out = [pts[0]];
    for (let k = 1, i = 1; k < count - 1; k++) {
      const s = (total * k) / (count - 1);
      while (i < pts.length - 1 && S0[i] < s) i++;
      const f = (s - S0[i - 1]) / (S0[i] - S0[i - 1] || 1);
      out.push(a2(pts[i - 1], m2(s2(pts[i], pts[i - 1]), f)));
    }
    out.push(pts[pts.length - 1]);
    return out;
  };
  for (const run of runs) {
    let P = resample(run.pts, 24).map(toModel);
    // a run that ends on the sheet's own edge goes on a little past it
    const ext = (a, b) => ({ p: add3(a.p, mul3(unit3(sub3(a.p, b.p)), 2 * t)), m: a.m });
    if (P.length > 1 && run.open[0]) P = [ext(P[0], P[1]), ...P];
    if (P.length > 1 && run.open[1]) P = [...P, ext(P[P.length - 1], P[P.length - 2])];
    const lo = P.map(({ p, m }) => sub3(p, mul3(m, h))), hi = P.map(({ p, m }) => add3(p, mul3(m, h)));
    const ts = new O.BRepOffsetAPI_ThruSections(false, true, 1e-6);
    try {
      ts.AddWire(R.assembleWire([curve(lo)]).wrapped);
      ts.AddWire(R.assembleWire([curve(hi)]).wrapped);
      ts.Build(new O.Message_ProgressRange());
      faces.push(R.cast(ts.Shape()));
    } finally { ts.delete(); }
  }
  // split, and keep the pieces whose sheet lies in the pattern
  const list = (shapes) => { const Ls = new O.NCollection_List_TopoDS_Shape(); for (const x of shapes) Ls.Append(x.wrapped); return Ls; };
  const sp = new O.BRepAlgoAPI_Splitter(), A = list([whole]), T = list(faces);
  let split;
  try {
    sp.SetArguments(A); sp.SetTools(T); sp.Build(new O.Message_ProgressRange());
    if (sp.HasErrors()) return null;
    split = R.cast(sp.Shape());
  } finally { sp.delete(); A.delete(); T.delete(); }
  const pieces = [...R.iterTopo(split.wrapped, 'solid')].map((s) => R.cast(s));
  if (pieces.length < 2) return null;
  const fs = facesOf(sheet.region);
  // a model point → the flat (nearest neutral triangle)
  const toFlat = (x) => {
    let best = null;
    for (const T of tris) {
      const [p, q, r] = T.tr.map((v) => N[v]), e1 = sub3(q, p), e2 = sub3(r, p), nn = dot3(T.nr, T.nr), d = sub3(x, p);
      const u = dot3(cross3(d, e2), T.nr) / nn, w = dot3(cross3(e1, d), T.nr) / nn, ws = [1 - u - w, u, w];
      const score = Math.min(0, ...ws) * 1e3 - Math.abs(dot3(d, T.nr)) / Math.sqrt(nn);
      if (!best || score > best.score) best = { score, q: a2(a2(T.fp, m2(T.e1, u)), m2(T.e2, w)) };
    }
    return best.q;
  };
  const kept = pieces.filter((pc) => {
    // the middles of its biggest mesh triangles (on its faces, away from its edges) vote
    const msh = pc.mesh({ tolerance: Math.max(0.05, t / 4), angularTolerance: 0.3 }), V = msh.vertices, Tr = msh.triangles;
    const cand = [];
    for (let k = 0; k < Tr.length; k += 3) {
      const [a, b, c] = [Tr[k], Tr[k + 1], Tr[k + 2]].map((i) => [V[3 * i], V[3 * i + 1], V[3 * i + 2]]);
      cand.push({ area: len3(cross3(sub3(b, a), sub3(c, a))), m: mul3(add3(add3(a, b), c), 1 / 3) });
    }
    cand.sort((x, y) => y.area - x.area);
    const top = cand.slice(0, 7);
    return top.filter((c) => faceAt(fs, toFlat(c.m), 1e-6)).length * 2 > top.length;
  });
  if (!kept.length || kept.length === pieces.length) return null;
  let out = kept[0];
  for (const pc of kept.slice(1)) out = bop('fuse', out, pc) || out;
  return out;
}
function revolveEdge(edge, o, d, deg) {
  const O = oc();
  const ax = R.makeAx1(o, d);
  const rv = new O.BRepPrimAPI_MakeRevol(edge.wrapped, ax, (deg * Math.PI) / 180, false);
  try { return own(rv.Shape()); } catch { return null; } finally { rv.delete(); ax.delete(); }
}
// a point on a bent strip (A side flat coordinates) back to the pattern
function unwrapPoint(b, t, p) {
  const e3 = [b.e[0], b.e[1], 0], a0 = [b.p0[0], b.p0[1], axisZ(b, t)];
  const rel = sub3(p, a0), x = dot3(rel, e3), rad = sub3(rel, mul3(e3, x));
  const r0 = b.up ? [0, 0, -1] : [0, 0, 1];
  const phi = Math.atan2(dot3(e3, cross3(r0, rad)), dot3(r0, rad));
  const s = (phi / (bendSign(b) * b.ang)) * b.ba;
  return a2(a2(b.p0, m2(b.e, x)), m2(b.d, s));
}

// ------------------------------------------------------------ unbend / bend
export function unfoldSheet(sheet, modelPt) {
  if (sheet.flat) throw new Error('The part is already unbent');
  let pt = sheet.rootPt;
  if (modelPt) {
    const { panels } = fold(sheet);
    const W = frameM(sheet.frame);
    let best = null, bd = Infinity;
    for (const P of panels) {
      const q = apM(invM(mulM(W, P.M)), modelPt);
      const dz = Math.min(Math.abs(q[2]), Math.abs(q[2] - sheet.t));
      const inside = faceAt([P.face], [q[0], q[1]], 1e-5);
      if (inside && dz < bd) { bd = dz; best = [q[0], q[1]]; }
    }
    if (!best || bd > Math.max(1e-3, sheet.t * 0.01)) throw new Error('Pick a flat face of the sheet metal part to keep in place');
    pt = best;
  }
  return { ...sheet, flat: { pt } };
}
export const refoldSheet = (sheet) => ({ ...sheet, flat: null });

// ------------------------------------------------------------ flat pattern output
// The sheet as it is cut: its region plus, at every V cutout corner, what the folded body adds there
// (toSolid): each bend's run-on into the corner up to its V line, less the relief set back along the
// line near the corner point, less the small round at the corner point. Folding this gives the body.
const flatCache = new WeakMap(); // region → Map(corners key → flat region)
export function flatRegion(sheet) {
  const cs = (sheet.corners || []).filter((c) => c.type !== 'butt' && c.bend !== 'mitre');
  if (!cs.length || !sheet.region) return sheet.region;
  const key = `${sheet.t}|${JSON.stringify(cs)}`;
  let m = flatCache.get(sheet.region);
  if (!m) flatCache.set(sheet.region, (m = new Map()));
  if (m.has(key)) return m.get(key);
  const t = sheet.t;
  let region = sheet.region;
  for (const c of cs) {
    const A = sheet.bends.find((b) => b.id === c.a), B = sheet.bends.find((b) => b.id === c.b);
    if (!A || !B) continue;
    const pair = cornerPairs({ bends: [A, B], t })[0];
    const at = cornerUV(A, B);
    if (!pair || !at) continue;
    const mid = Math.min(c.ea ?? 0, c.eb ?? 0), h = cornerRelief0(c, t);
    let next = region;
    try {
      for (const [bd, top] of [[A, c.ea ?? 0], [B, c.eb ?? 0]]) {
        if (!(top > 1e-6)) continue;
        const { face: beyond, pt, far } = vcutFlatBeyond(bd, t, pair.X, top, mid, h);
        // the run-on (past the bend's end, up to the V line) and the set-back (before its end)
        const runOn = bop('cut', polyFace([pt(0, 0), pt(far, 0), pt(far, bd.ba), pt(0, bd.ba)]), beyond);
        next = bop('fuse', next, runOn);
        if (h > 0) next = bop('cut', next, bop('common', beyond, polyFace([pt(-2 * h, 0), pt(0, 0), pt(0, bd.ba), pt(-2 * h, bd.ba)])));
      }
      // the round at the corner point, out of the panel the two bends start from
      if (h > 0) {
        const quarter = bop('common', circleFace(at(0, 0), h), polyFace([at(0, 0), at(-2 * h, 0), at(-2 * h, -2 * h), at(0, -2 * h)]));
        next = bop('cut', next, quarter);
      }
      if (next) region = next;
    } catch { /* keep the region without this corner */ }
  }
  region = dropPointHoles(region);
  m.set(key, region);
  return region;
}
// Where a V line passes exactly through a corner of the outline, the booleans can leave a "hole" of zero
// size (a loop round one point, a few hundred-thousandths of a mm): it is not a cut, so it is dropped.
function dropPointHoles(region) {
  if (!region) return region;
  const isPoint = (w) => w.edges.reduce((s, e) => s + e.length, 0) <= 1e-3; // mm: far below anything cut
  const fs = facesOf(region);
  if (!fs.some((f) => f.clone().innerWires().some(isPoint))) return region;
  let out = null;
  for (const f of fs) {
    const inner = f.clone().innerWires();
    if (!inner.some(isPoint)) { out = bop('fuse', out, f); continue; }
    let face = upFaces(R.makeFace(f.clone().outerWire()));
    for (const w of inner.filter((x) => !isPoint(x))) face = bop('cut', face, R.makeFace(w)) || face;
    out = bop('fuse', out, face);
  }
  return out || region;
}

// { region (flat faces), bendLines: [{ a, b, up, ang, R, t0: [a, b], t1: [a, b] }], size: [w, h], area }
export function flatPattern(sheet) {
  const region = flatRegion(sheet);
  const fs = facesOf(region);
  const bendLines = [];
  // a lofted bend: the developed fold lines (bent: every fold between two flat facets), clipped to the
  // pattern (a cut can take part of a line away)
  for (const [i, L] of (sheet.lofted?.bendLines || []).entries()) {
    for (const [a, b] of sheet.lofted.cuts?.length ? clipSegment(fs, L.a, L.b) : [[L.a, L.b]]) bendLines.push({ a, b, up: L.up, ang: L.ang, R: sheet.R, id: 'lb' + (i + 1), t0: [], t1: [] });
  }
  for (const b of sheet.bends) {
    const [x0, x1] = zoneSpan(b);
    const mid = (s) => [a2(a2(b.p0, m2(b.d, s)), m2(b.e, x0)), a2(a2(b.p0, m2(b.d, s)), m2(b.e, x1))];
    // the bend line, clipped to the pattern
    const [ca, cb] = mid(b.ba / 2);
    const pieces = clipSegment(fs, ca, cb);
    for (const [a, c] of pieces) bendLines.push({ a, b: c, up: b.up, ang: b.ang, R: b.R, id: b.id, t0: clipSegment(fs, ...mid(0)), t1: clipSegment(fs, ...mid(b.ba)) });
  }
  const bb = bbox2(region);
  // marks for forming (cross breaks …), clipped to the pattern
  const marks = [];
  for (const mk of sheet.marks || []) for (const [a, c] of clipSegment(fs, mk.a, mk.b)) marks.push({ ...mk, a, b: c });
  return { region, bendLines, marks, size: [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]], min: [bb.min[0], bb.min[1]], area: areaOf(region) };
}
// parts of the segment a–b inside the faces
function clipSegment(fs, a, b) {
  const L = l2(s2(b, a));
  if (L < 1e-9) return [];
  // coarse samples, then each change from outside to inside found by halving (a few dozen tests
  // instead of hundreds: a rolled part has many bend lines)
  const n = 32;
  const at = (k) => a2(a, m2(s2(b, a), k));
  const ins = (k) => !!faceAt(fs, at(k), 1e-7);
  const edge = (k0, k1, in0) => { for (let it = 0; it < 14; it++) { const km = (k0 + k1) / 2; if (ins(km) === in0) k0 = km; else k1 = km; } return in0 ? k0 : k1; };
  const ks = Array.from({ length: n + 1 }, (_, i) => i / n), inside = ks.map(ins);
  const out = [];
  let start = inside[0] ? 0 : null;
  for (let i = 1; i <= n; i++) {
    if (inside[i] && !inside[i - 1]) start = edge(ks[i - 1], ks[i], false);
    if (!inside[i] && inside[i - 1] && start !== null) { const e = edge(ks[i - 1], ks[i], true); if (e > start) out.push([at(start), at(e)]); start = null; }
  }
  if (start !== null && inside[n] && 1 > start) out.push([at(start), at(1)]);
  return out;
}

// Summary for the interface (cheap: no bend line clipping).
export function sheetInfo(sheet) {
  const region = flatRegion(sheet);
  const bb = bbox2(region);
  const cut = cutInfo(region);
  return {
    t: sheet.t, R: sheet.R, K: sheet.K, bends: sheet.bends.length + (sheet.lofted?.bendLines?.length || 0), lofted: sheet.lofted ? sheet.lofted.method : null,
    flatSize: [bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]], flatArea: areaOf(region),
    cutLength: cut.length + cutLines(sheet), pierces: cut.loops,
    flat: !!sheet.flat, stale: sheet.stale || null,
  };
}

// The length of the cut lines in a sheet's marks (louver slits, rips), cut as well as the outline.
export const cutLines = (sheet) => (sheet.marks || []).filter((m) => m.kind === 'slit' || m.kind === 'rip').reduce((s, m) => s + l2(s2(m.b, m.a)), 0);

// What a laser (or other profile cutter) cuts: the total length of the flat pattern's outline and of
// every hole and cut-out in it, and the number of closed contours (one pierce each). Edges shared by two
// faces of the pattern (seams inside the material) are not cut.
const cutCache = new WeakMap();
export function cutInfo(region) {
  if (cutCache.has(region)) return cutCache.get(region);
  const edges = new Map();
  let loops = 0;
  for (const f of facesOf(region)) {
    for (const w of [f.clone().outerWire(), ...f.clone().innerWires()]) {
      loops++;
      for (const e of w.edges) {
        const m = e.pointAt(0.5);
        const q = m.toTuple ? m.toTuple() : m;
        const key = `${Math.round(q[0] * 1e4)},${Math.round(q[1] * 1e4)}`;
        const rec = edges.get(key);
        if (rec) rec.n++; else edges.set(key, { len: e.length, n: 1 });
      }
    }
  }
  let length = 0;
  for (const r of edges.values()) if (r.n === 1) length += r.len;
  const out = { length, loops };
  cutCache.set(region, out);
  return out;
}

// Move the sheet with a rigid motion of its body (Move/Copy Bodies).
export const moveSheet = (sheet, M) => ({ ...sheet, frame: frameOfM(mulM(M, frameM(sheet.frame))) });
// The sheet of a mirror image of its body (M: a reflection, determinant −1; Mirror feature). A mirrored
// part's flat pattern is the same outline seen from its other face: the frame is turned over (z → t − z,
// so it stays right handed) and every bend and form goes the other way. null for a lofted bend (its
// developed triangles are not turned over).
export function mirrorSheet(sheet, M) {
  if (sheet.lofted) return null;
  const over = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, sheet.t];
  return {
    ...sheet,
    frame: frameOfM(mulM(M, mulM(frameM(sheet.frame), over))),
    bends: sheet.bends.map((b) => ({ ...b, up: !b.up })),
    ...(sheet.forms ? { forms: sheet.forms.map((f) => ('up' in f ? { ...f, up: !f.up } : f)) } : {}),
  };
}
// The sheet moved with its body by any rigid motion or mirror (M, 3×4); null when it can't be carried.
export function transformSheet(sheet, M) {
  const det = M[0] * (M[5] * M[10] - M[6] * M[9]) - M[1] * (M[4] * M[10] - M[6] * M[8]) + M[2] * (M[4] * M[9] - M[5] * M[8]);
  return det > 0 ? moveSheet(sheet, M) : mirrorSheet(sheet, M);
}

// ------------------------------------------------------------ lofted bend
// A sheet between two open profiles A and B (matched points, A[i] ↔ B[i], on the sheet's own side; the
// material is on the side `side` of the strip, ±1 along the normal of the quad A[i] A[i+1] B[i+1] B[i]).
// method: 'bent' — flat triangles A[i] A[i+1] B[i] and A[i+1] B[i+1] B[i] folded along their edges (press-
// brake bends, each a bend line in the flat pattern); 'formed' — the smooth ruled surface between the
// profiles (rolled / pressed). Either way the flat pattern is developed by triangulation at the neutral
// layer (K·t into the material): each triangle laid flat against the last one, edge lengths kept.
// The points are kept in the sheet's frame (so the part moves with it).
// breaks: indices where a profile has a corner (a formed part is smooth between them)
export function loftedSheet(A, B, { t, K, R = 0, method = 'bent', side = 1, breaks = [] }) {
  const n = A.length - 1;
  if (n < 1 || B.length !== A.length) throw new Error('The profiles need at least one segment each');
  // the strip's triangles, in order along it (each shares an edge with the one before)
  const P = [...A, ...B], a = (i) => i, b = (i) => n + 1 + i;
  const tris = [];
  for (let i = 0; i < n; i++) { tris.push([a(i), a(i + 1), b(i)]); tris.push([a(i + 1), b(i + 1), b(i)]); }
  const nrm = (tr) => cross3(sub3(P[tr[1]], P[tr[0]]), sub3(P[tr[2]], P[tr[0]]));
  const area = tris.map((tr) => len3(nrm(tr)) / 2);
  const big = Math.max(...area);
  const live = tris.map((tr, k) => area[k] > big * 1e-9);
  if (!live.some(Boolean)) throw new Error('The two profiles lie on top of each other');
  // material direction per triangle and per point (averaged), and the neutral layer
  const mTri = tris.map((tr, k) => (live[k] ? mul3(unit3(nrm(tr)), side) : null));
  const mPt = P.map(() => [0, 0, 0]);
  tris.forEach((tr, k) => { if (live[k]) for (const v of tr) mPt[v] = add3(mPt[v], mul3(mTri[k], area[k])); });
  weldNormals(P, mPt);
  for (let v = 0; v < P.length; v++) mPt[v] = len3(mPt[v]) > 1e-12 ? unit3(mPt[v]) : mTri.find(Boolean);
  const Nl = P.map((p, v) => add3(p, mul3(mPt[v], K * t)));
  // the frame: on the first real triangle, z into the material (its flat face stays where it is)
  const k0 = live.indexOf(true), t0 = tris[k0];
  const u = unit3(sub3(P[t0[1]], P[t0[0]])), zN = mTri[k0], vv = cross3(zN, u);
  const frame = { o: P[t0[0]], u, v: vv, n: zN };
  const toLocal = (q) => { const d = sub3(q, frame.o); return [dot3(d, u), dot3(d, vv), dot3(d, zN)]; };
  // development: the first triangle as it lies, then each next one unfolded across the shared edge
  const F = new Array(P.length).fill(null);
  for (const v of t0) { const q = toLocal(Nl[v]); F[v] = [q[0], q[1]]; }
  let prev = t0;
  const bendLines = [];
  // on from the first real triangle, then back from it to the start (slivers before it)
  const order = [...Array.from({ length: tris.length - k0 - 1 }, (_, i) => k0 + 1 + i), ...Array.from({ length: k0 }, (_, i) => k0 - 1 - i)];
  for (const k of order) {
    if (k === k0 - 1) prev = t0;
    const tr = tris[k];
    const nu = tr.find((v) => !F[v]);
    if (nu == null) { prev = live[k] ? tr : prev; continue; }
    const known = tr.filter((v) => v !== nu);
    if (!live[k]) {
      // a sliver (a profile end collapsed to a point): the new point sits on its twin
      const twin = known.reduce((best, v) => (len3(sub3(P[v], P[nu])) < len3(sub3(P[best], P[nu])) ? v : best), known[0]);
      F[nu] = [...F[twin]];
      continue;
    }
    const [p, q] = known, dp = len3(sub3(Nl[nu], Nl[p])), dq = len3(sub3(Nl[nu], Nl[q]));
    const e = s2(F[q], F[p]), L = l2(e), ex = m2(e, 1 / L), ey = [-ex[1], ex[0]];
    const x = (dp * dp - dq * dq + L * L) / (2 * L), y = Math.sqrt(Math.max(0, dp * dp - x * x));
    // on the other side of the shared edge from the triangle before
    // (a point of the last triangle off the shared edge: copies of p or q, at the same place, don't count)
    const away = (v) => F[v] && l2(s2(F[v], F[p])) > 1e-9 && l2(s2(F[v], F[q])) > 1e-9;
    const other = prev.find((v) => v !== p && v !== q && away(v)) ?? prev.find((v) => v !== p && v !== q);
    const sideOf = other != null && F[other] ? Math.sign(d2(s2(F[other], F[p]), ey)) || 1 : -1;
    F[nu] = a2(a2(F[p], m2(ex, x)), m2(ey, -sideOf * y));
    // the fold between the two triangles: its angle, and up (toward the material) or down
    if (prev && mTri[tris.indexOf(prev)]) {
      const m1 = mTri[tris.indexOf(prev)], m2v = mTri[k];
      const ang = Math.acos(Math.max(-1, Math.min(1, dot3(m1, m2v))));
      if (ang > (0.05 * Math.PI) / 180) bendLines.push({ i: p, j: q, ang, up: dot3(sub3(P[nu], P[p]), m1) > 0, st: p <= n ? p : q <= n ? q : null });
    }
    prev = tr;
  }
  // the flat outline: along A, back along B
  const outline = [...A.map((_, i) => F[a(i)]), ...B.map((_, i) => F[b(n - i)])].filter((q, i, arr) => !i || l2(s2(q, arr[i - 1])) > 1e-9);
  let region;
  try { region = polyFace(outline); } catch { region = null; }
  if (!region || !facesOf(region).length) throw new Error('The developed flat pattern overlaps itself (the loft turns too far): split it into two lofted bends');
  const loc = (q) => toLocal(q);
  const lofted = {
    method, side, A: A.map(loc), B: B.map(loc), breaks,
    // the neutral layer (points A then B), where cuts are traced for the flat pattern
    N: Nl.map(loc),
    bendLines: method === 'bent' ? bendLines.map((L) => ({ a: F[L.i], b: F[L.j], ang: L.ang, up: L.up })) : [],
    // every point pair A[i] ↔ B[i] in the flat, and the folds by the pair they start from (forming lines)
    stations: A.map((_, i) => [F[a(i)], F[b(i)]]),
    folds: bendLines.filter((L) => L.st != null).map((L) => ({ st: L.st, ang: L.ang, up: L.up })),
  };
  const c = facesOf(region)[0].center, cc = Array.isArray(c) ? c : c.toTuple ? c.toTuple() : [c.x, c.y];
  return { t, K, R, frame, region, bends: [], rootPt: insidePoint(region, [cc[0], cc[1]]), flat: null, stale: null, nextBend: 1, lofted };
}

// Bend lines of a formed (rolled / pressed) lofted sheet, for the flat pattern and DXF: only the sharp folds
// at its corners (breaks), e.g. a frustum's corners. The smoothly curved stretches between them are rolled,
// as a cylinder is, and get no lines.
export function formLines(L, { breaks = L.breaks || [] } = {}) {
  const n = L.stations.length - 1;
  const turn = new Array(n + 1).fill(0);
  for (const f of L.folds || []) turn[f.st] += f.up ? f.ang : -f.ang;
  const out = [];
  for (const i of [...new Set(breaks)].filter((i) => i > 0 && i < n).sort((x, y) => x - y)) {
    if (Math.abs(turn[i]) < (0.05 * Math.PI) / 180) continue;
    const [a, b] = L.stations[i];
    out.push({ a, b, ang: Math.abs(turn[i]), up: turn[i] > 0 });
  }
  return out;
}

// The folded lofted bend (in its frame): bent — flat facets with sharp folds; formed — smooth. Kept per
// sheet (it is asked for again by views and exports).
const loftCache = new WeakMap();
function loftedSolid(sheet) {
  const L = sheet.lofted;
  if (L.method === 'developed') return L.solid; // (the body as it was converted: developedSheet)
  if (loftCache.has(L)) return loftCache.get(L);
  // a cut lofted bend: the uncut one trimmed to the flat pattern with its cut edges square to the sheet
  // (as a laser-cut blank formed to shape); failing that, the uncut one less each cut as it is
  if (L.cuts?.length) {
    const whole = loftedSolid({ ...sheet, lofted: { ...L, cuts: null } });
    let sol = null;
    try { sol = trimLofted(whole, sheet); } catch { sol = null; }
    if (!sol) { sol = whole; for (const c of L.cuts) sol = bop('cut', sol, c) || sol; }
    loftCache.set(L, sol);
    return sol;
  }
  // (the uncut one is kept per strip: its cut copies share the strip's points)
  if (loftCache.has(L.A)) return loftCache.get(L.A);
  let sol = null;
  const facets = facetSolid(L.A, L.B, sheet.t);
  if (L.method === 'formed') {
    // the smooth one, unless it doesn't hold the material the (fine) facets do — e.g. material on the
    // inside of a profile's corner, where the smooth other side can fold into itself
    try { sol = formedSolid(L.A, L.B, sheet.t, L.breaks || []); } catch { sol = null; }
    if (sol && Math.abs(solidVolume(sol) / solidVolume(facets) - 1) > 0.02) sol = null;
  }
  if (!sol) sol = facets;
  loftCache.set(L.A, sol);
  return sol;
}
// The volume of a solid, integrated to tolerance knot span by knot span. (R.measureVolume uses a fixed
// number of points per face, which can be several % out on a B-spline face with many spans, e.g. a formed
// cone strip of 72 divisions: 134,912 mm³ for a solid of 140,366.)
function solidVolume(shape) {
  const O = oc(), p = new O.GProp_GProps();
  try {
    O.BRepGProp.VolumePropertiesGK(shape.wrapped, p, 1e-6, false, true, false, false, false);
    return p.Mass();
  } finally { p.delete(); }
}
// How far a point of the strip moves to the other side: a thickness from each facet around it (a mitre
// across a fold or corner: least squares over the different facet planes, the smallest such move).
function mitre(mv, ns, t) {
  const nv = len3(mv) > 1e-12 ? unit3(mv) : [0, 0, 1];
  const uniq = [];
  for (const m of ns) if (!uniq.some((u) => dot3(u, m) > 1 - 1e-9)) uniq.push(m);
  if (uniq.length < 2) return mul3(uniq[0] || nv, t);
  // (Σ m mᵀ + ε I) x = t Σ m (ε: the normals can lie almost in one plane, e.g. a cone's fan; made
  // stronger until the move is a sensible one)
  const det = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  for (let eps = 2e-4 * uniq.length; eps < 10 * uniq.length; eps *= 4) {
    const A = [[eps, 0, 0], [0, eps, 0], [0, 0, eps]], b = [0, 0, 0];
    for (const m of uniq) for (let i = 0; i < 3; i++) { b[i] += t * m[i]; for (let j = 0; j < 3; j++) A[i][j] += m[i] * m[j]; }
    const D = det(A);
    const x = [0, 1, 2].map((c) => det(A.map((row, i) => row.map((v, j) => (j === c ? b[i] : v)))) / D);
    if (dot3(x, nv) > 0.5 * t && len3(x) <= 3 * t) return x;
  }
  return mul3(nv, t);
}

// Points at the same place (a profile point repeated, e.g. a transition's corner fanned to an arc) get the
// summed normal (and facet normals) of them all, so the sheet's other side stays one closed surface.
function weldNormals(P, mPt, adj = null) {
  const key = (p) => p.map((x) => Math.round(x * 1e6)).join(',');
  const groups = new Map();
  P.forEach((p, v) => { const k = key(p); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(v); });
  for (const vs of groups.values()) {
    if (vs.length < 2) continue;
    const sum = vs.reduce((acc, v) => add3(acc, mPt[v]), [0, 0, 0]);
    const all = adj ? vs.flatMap((v) => adj[v]) : null;
    for (const v of vs) { mPt[v] = sum; if (adj) adj[v] = all; }
  }
}

// The strip between the profiles (points A then B, triangles A[i] A[i+1] B[i] and A[i+1] B[i+1] B[i]) and
// its other side: each point moved a thickness into the material (+z of the frame at the first facet)
// along its averaged facet normal, far enough that the facets stay a full thickness apart (across a fold
// the averaged normal leans: t / cos of the lean).
function stripOffset(A, B, t) {
  const n = A.length - 1, P = [...A, ...B], a = (i) => i, b = (i) => n + 1 + i;
  const tris = [];
  for (let i = 0; i < n; i++) { tris.push([a(i), a(i + 1), b(i)]); tris.push([a(i + 1), b(i + 1), b(i)]); }
  const nrm = (tr) => cross3(sub3(P[tr[1]], P[tr[0]]), sub3(P[tr[2]], P[tr[0]]));
  const big = Math.max(...tris.map((tr) => len3(nrm(tr))));
  const live = tris.filter((tr) => len3(nrm(tr)) > big * 1e-9);
  const sgn = dot3(nrm(live[0]), [0, 0, 1]) >= 0 ? 1 : -1;
  const mPt = P.map(() => [0, 0, 0]), adj = P.map(() => []);
  for (const tr of live) { const m = mul3(nrm(tr), sgn); for (const v of tr) { mPt[v] = add3(mPt[v], m); adj[v].push(unit3(m)); } }
  weldNormals(P, mPt, adj);
  const Q = P.map((p, v) => add3(p, mitre(mPt[v], adj[v], t)));
  return { n, P, Q, a, b, live, big };
}

// Formed: a smooth closed solid of ruled faces sewn together — between each pair of corners (breaks) the
// surface between the profiles, its other side a thickness into the material and the ends along the
// profiles; and the two ends of the strip.
function formedSolid(A, B, t, breaks = []) {
  const O = oc(), { n, Q } = stripOffset(A, B, t);
  const A2 = Q.slice(0, n + 1), B2 = Q.slice(n + 1);
  const curve = (pts) => (pts.length === 2 ? R.makeLine(pts[0], pts[1]) : R.makeBSplineApproximation(pts, { tolerance: 1e-4, degMax: 3 }));
  const ruled = (e1, e2) => {
    const ts = new O.BRepOffsetAPI_ThruSections(false, true, 1e-6);
    try {
      ts.AddWire(R.assembleWire([e1]).wrapped);
      ts.AddWire(R.assembleWire([e2]).wrapped);
      ts.Build(new O.Message_ProgressRange());
      return R.cast(ts.Shape());
    } finally { ts.delete(); }
  };
  const cuts = [0, ...[...new Set(breaks)].filter((i) => i > 0 && i < n).sort((x, y) => x - y), n];
  const parts = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const [i0, i1] = [cuts[k], cuts[k + 1]];
    const span = (pts) => curve(pts.slice(i0, i1 + 1));
    const cA = span(A), cB = span(B), cA2 = span(A2), cB2 = span(B2);
    parts.push(ruled(cA, cB), ruled(cA2, cB2), ruled(cA, cA2), ruled(cB, cB2));
  }
  parts.push(ruled(R.makeLine(A[0], B[0]), R.makeLine(A2[0], B2[0])), ruled(R.makeLine(A[n], B[n]), R.makeLine(A2[n], B2[n])));
  const sw = new O.BRepBuilderAPI_Sewing(1e-4, true, true, true, false);
  for (const sh of parts) sw.Add(sh.wrapped);
  sw.Perform(new O.Message_ProgressRange());
  const sewn = R.cast(sw.SewedShape());
  sw.delete();
  const shells = [...R.iterTopo(sewn.wrapped, 'shell')];
  if (shells.length !== 1) return null;
  // (every face turned the same way round, then made into a solid facing out)
  let shell = shells[0];
  try {
    const fx = new O.ShapeFix_Shell_2(shell, new O.Message_ProgressRange());
    try { fx.FixFaceOrientation(shell, true, false); shell = fx.Shell(); } finally { fx.delete(); }
  } catch { /* as sewn */ }
  const ms = new O.BRepBuilderAPI_MakeSolid(shell);
  let out = R.cast(ms.Solid());
  ms.delete();
  O.BRepLib.OrientClosedSolid(out.wrapped);
  const v = R.measureVolume(out);
  if (!(Math.abs(v) > 0)) return null;
  return v < 0 ? R.cast(out.wrapped.Reversed()) : out;
}
// Flat facets (the bent loft, or a formed one the kernel couldn't make smooth), as a folded sheet is: each
// facet moved a thickness square to itself for its other side (so every cut edge is square to the sheet);
// where two facets fold, a narrow strip is the outside of the fold, and round each point of the strip's
// edge a fan of triangles is the end face of the folds meeting there. Sewn into one closed solid.
function facetSolid(A, B, t) {
  const n = A.length - 1, P0 = [...A, ...B];
  const tris = [];
  for (let i = 0; i < n; i++) { tris.push([i, i + 1, n + 1 + i]); tris.push([i + 1, n + 2 + i, n + 1 + i]); }
  const nrm = (tr) => cross3(sub3(P0[tr[1]], P0[tr[0]]), sub3(P0[tr[2]], P0[tr[0]]));
  const big = Math.max(...tris.map((tr) => len3(nrm(tr))));
  const live = tris.filter((tr) => len3(nrm(tr)) > big * 1e-9);
  const sgn = dot3(nrm(live[0]), [0, 0, 1]) >= 0 ? 1 : -1;
  // points at the same place are one vertex; facets in one plane share one normal (so one other side)
  const gid = new Map(), pos = [];
  const G = P0.map((p) => { const k = p.map((x) => Math.round(x * 1e6)).join(','); if (!gid.has(k)) { gid.set(k, gid.size); pos.push(p); } return gid.get(k); });
  const normals = [];
  const canon = (m) => normals.find((u) => dot3(u, m) > 1 - 1e-9) || (normals.push(m), m);
  const F = live.map((tr) => ({ v: tr.map((x) => G[x]), m: canon(unit3(mul3(nrm(tr), sgn))) }));
  const Q = (f, g) => add3(pos[g], mul3(f.m, t));
  const faces = [];
  const tri = (p, q, r) => { if (len3(cross3(sub3(q, p), sub3(r, p))) > big * 1e-10) faces.push(R.makePolygon([p, q, r])); }; // (a polygon is already a face)
  // both sides of every facet
  for (const f of F) { const [i, j, k] = f.v; tri(pos[i], pos[j], pos[k]); tri(Q(f, i), Q(f, k), Q(f, j)); }
  // edges: between two facets the outside of the fold (when they are not in one plane), on the strip's edge
  // the cut edge face
  const edges = new Map();
  for (const f of F) for (let k = 0; k < 3; k++) {
    const u = f.v[k], w = f.v[(k + 1) % 3], key = u < w ? `${u},${w}` : `${w},${u}`;
    if (!edges.has(key)) edges.set(key, { u, w, fs: [] });
    edges.get(key).fs.push(f);
  }
  for (const { u, w, fs } of edges.values()) {
    if (fs.length === 1) { const f = fs[0]; tri(pos[u], pos[w], Q(f, w)); tri(pos[u], Q(f, w), Q(f, u)); continue; }
    const [f, g] = fs;
    if (f.m === g.m) continue;
    tri(Q(f, u), Q(f, w), Q(g, w)); tri(Q(f, u), Q(g, w), Q(g, u));
  }
  // round each vertex: the facets meeting there in order (through the edges they share); a vertex on the
  // strip's edge gets the fan from the vertex itself (the end face of the folds there), any other the gap
  // between the facets' other sides closed
  const at = new Map();
  for (const f of F) for (const g of f.v) { if (!at.has(g)) at.set(g, []); at.get(g).push(f); }
  const edgeFs = (g, x) => edges.get(g < x ? `${g},${x}` : `${x},${g}`)?.fs || [];
  for (const [g, fs] of at) {
    if (fs.length < 2) continue;
    const others = (f) => f.v.filter((x) => x !== g);
    let start = fs.find((f) => others(f).some((x) => edgeFs(g, x).length === 1));
    const open = !!start;
    start ||= fs[0];
    const chain = [start], used = new Set([start]);
    for (let cur = start; ;) {
      const nx = others(cur).flatMap((x) => edgeFs(g, x)).find((f) => f !== cur && !used.has(f) && fs.includes(f));
      if (!nx) break;
      chain.push(nx); used.add(nx); cur = nx;
    }
    const qs = chain.map((f) => Q(f, g)).filter((q, i, arr) => !i || len3(sub3(q, arr[i - 1])) > 1e-9);
    if (open) for (let i = 0; i + 1 < qs.length; i++) tri(pos[g], qs[i], qs[i + 1]);
    else for (let i = 1; i + 1 < qs.length; i++) tri(qs[0], qs[i], qs[i + 1]);
  }
  const O = oc();
  const sw = new O.BRepBuilderAPI_Sewing(1e-6, true, true, true, false);
  for (const f of faces) sw.Add(f.wrapped);
  sw.Perform(new O.Message_ProgressRange());
  const shell = R.cast(sw.SewedShape());
  sw.delete();
  const shells = [...R.iterTopo(shell.wrapped, 'shell')];
  if (shells.length !== 1) throw new Error('The lofted bend could not be made into a solid');
  const ms = new O.BRepBuilderAPI_MakeSolid(shells[0]);
  let sol = R.cast(ms.Solid());
  ms.delete();
  O.BRepLib.OrientClosedSolid(sol.wrapped);
  if (R.measureVolume(sol) < 0) sol = R.cast(sol.wrapped.Reversed());
  // facets in one plane (e.g. a transition's flat side, split where a seam can go) as one face
  try { const v0 = R.measureVolume(sol), one = sol.simplify(); if (Math.abs(R.measureVolume(one) - v0) <= Math.abs(v0) * 1e-6) sol = one; } catch { /* as sewn */ }
  return sol;
}

// ------------------------------------------------------------ sheet metal extrude
// A sheet extruded from an open sketch profile (a chain of lines and arcs; segs as S.chainSegs gives
// them, in sketch coordinates) or a lone circle (rolled, with a seam gap). Drawn arcs are bends of their
// own radius; sharp corners get a bend of inside radius R (the sketch stays on the sheet's face, so its
// lines are the face's virtual sharps). side: the material 'one' (left of the profile's direction of
// travel) | 'other' | 'mid' (the sketch is the middle of the thickness). The sheet runs from z0 to z1
// along the sketch normal. Returns { sheet, corners (bends added at corners), drawn (drawn arcs) }.
export function extrudedSheet(segs, { frame, z0, z1, t, K, R: R0, side: mode = 'one', gap = 0.5 }) {
  if (!(t > 0)) throw new Error('The thickness must be greater than zero');
  if (!(z1 - z0 > 1e-9)) throw new Error('The depth must be greater than zero');
  const side = mode === 'other' ? -1 : 1, off = mode === 'mid' ? t / 2 : 0;
  const left = (v) => [-v[1], v[0]];
  const ang = (c, q) => Math.atan2(q[1] - c[1], q[0] - c[0]);
  const norm = (x) => ((x % TAU2) + TAU2) % TAU2;
  // arcs: centre c, radius r, start angle a0, sweep (> 0), ccw; their ends a, b
  const arcEnds = (g) => { const e = g.a0 + (g.ccw ? g.sweep : -g.sweep); g.a = [g.c[0] + g.r * Math.cos(g.a0), g.c[1] + g.r * Math.sin(g.a0)]; g.b = [g.c[0] + g.r * Math.cos(e), g.c[1] + g.r * Math.sin(e)]; return g; };
  const tanAt = (g, end) => {
    if (g.kind === 'line') return u2(s2(g.b, g.a));
    const phi = end ? g.a0 + (g.ccw ? g.sweep : -g.sweep) : g.a0;
    return g.ccw ? [-Math.sin(phi), Math.cos(phi)] : [Math.sin(phi), -Math.cos(phi)];
  };
  let list = [];
  let closedCircle = false;
  if (segs.length === 1 && segs[0].type === 'circle') {
    const { c, r } = segs[0];
    if (!(gap > 0)) throw new Error('A rolled circle needs a seam gap greater than zero');
    if (gap >= r * Math.PI) throw new Error('The seam gap is larger than the circle');
    list.push(arcEnds({ kind: 'arc', c, r, a0: gap / 2 / r, sweep: TAU2 - gap / r, ccw: true, drawn: true }));
    closedCircle = true;
  } else {
    for (const g of segs) {
      if (g.type === 'line') { if (l2(s2(g.b, g.a)) > 1e-9) list.push({ kind: 'line', a: g.a, b: g.b }); continue; }
      if (g.type !== 'arc') throw new Error('Only lines and arcs (or one circle) can be extruded as sheet metal');
      // the circle through a, m, b and the way round from a to b
      const [a, m, b] = [g.a, g.m, g.b];
      const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
      const sq = (q) => q[0] * q[0] + q[1] * q[1];
      const c = [(sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d, (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d];
      const ccw = (m[0] - a[0]) * (b[1] - m[1]) - (m[1] - a[1]) * (b[0] - m[0]) > 0;
      const a0 = ang(c, a), sweep = ccw ? norm(ang(c, b) - a0) : norm(a0 - ang(c, b));
      list.push({ kind: 'arc', c, r: l2(s2(a, c)), a0, sweep, ccw, a, b, drawn: true });
    }
  }
  if (!list.length) throw new Error('The profile has no length');
  // sharp corners: a bend (tangent arc) of the radius that gives inside radius R on the sheet
  let corners = 0;
  if (!closedCircle) {
    const out = [list[0]];
    for (let i = 1; i < list.length; i++) {
      const g1 = out[out.length - 1], g2 = list[i];
      const t1 = tanAt(g1, true), t2 = tanAt(g2, false);
      const cr = t1[0] * t2[1] - t1[1] * t2[0], th = Math.acos(Math.max(-1, Math.min(1, d2(t1, t2))));
      if (th < (0.5 * Math.PI) / 180) { out.push(g2); continue; } // (already smooth)
      if (th > Math.PI - 1e-3) throw new Error('The profile turns right back on itself at a corner: it cannot be bent');
      const turn = cr > 0 ? 1 : -1; // +1: turning left
      const rf = mode === 'mid' ? R0 + t / 2 : turn === side ? R0 + t : R0;
      if (!(rf > 1e-9)) throw new Error('The bend radius must be greater than zero');
      // the fillet's centre: where both curves moved rf toward the inside of the turn meet (nearest the corner)
      const P = g1.b;
      const inN = (g, end) => m2(left(tanAt(g, end)), turn);
      const offC = (g, end) => {
        if (g.kind === 'line') { const n = inN(g, end); return { kind: 'line', a: a2(g.a, m2(n, rf)), d: u2(s2(g.b, g.a)) }; }
        const towardC = g.ccw === (turn > 0);
        return { kind: 'circle', c: g.c, r: towardC ? g.r - rf : g.r + rf };
      };
      const C = nearestMeet(offC(g1, true), offC(g2, false), P);
      if (!C) throw new Error('A bend at a corner does not fit (the radius is too big for the lines and arcs around it)');
      const foot = (g) => (g.kind === 'line' ? a2(g.a, m2(u2(s2(g.b, g.a)), d2(s2(C, g.a), u2(s2(g.b, g.a))))) : a2(g.c, m2(u2(s2(C, g.c)), g.r)));
      const T1 = foot(g1), T2 = foot(g2);
      // trim the two curves back to the fillet
      const trimEnd = (g, T) => {
        if (g.kind === 'line') { if (d2(s2(T, g.a), s2(g.b, g.a)) <= 1e-9) throw new Error('A line is too short for the bends at its ends: use a smaller bend radius'); g.b = T; return; }
        const sw = g.ccw ? norm(ang(g.c, T) - g.a0) : norm(g.a0 - ang(g.c, T));
        if (!(sw > 1e-9 && sw <= g.sweep + 1e-9)) throw new Error('An arc is too short for the bends at its ends: use a smaller bend radius');
        g.sweep = sw; arcEnds(g);
      };
      const trimStart = (g, T) => {
        if (g.kind === 'line') { if (d2(s2(g.b, T), s2(g.b, g.a)) <= 1e-9) throw new Error('A line is too short for the bends at its ends: use a smaller bend radius'); g.a = T; return; }
        const cut = g.ccw ? norm(ang(g.c, T) - g.a0) : norm(g.a0 - ang(g.c, T));
        if (!(cut < g.sweep - 1e-9)) throw new Error('An arc is too short for the bends at its ends: use a smaller bend radius');
        g.a0 = ang(g.c, T); g.sweep -= cut; arcEnds(g);
      };
      const g2c = { ...g2 };
      trimEnd(g1, T1);
      trimStart(g2c, T2);
      const fa0 = ang(C, T1), fsw = turn > 0 ? norm(ang(C, T2) - fa0) : norm(fa0 - ang(C, T2));
      out.push(arcEnds({ kind: 'arc', c: C, r: rf, a0: fa0, sweep: fsw, ccw: turn > 0 }), g2c);
      corners++;
    }
    list = out;
  }
  // the sheet's own side (z = 0 of the flat): the sketch, or half a thickness off it (mid)
  if (off) {
    const dlt = -side * off; // along the left normal
    list = list.map((g) => {
      if (g.kind === 'line') { const n = left(u2(s2(g.b, g.a))); return { ...g, a: a2(g.a, m2(n, dlt)), b: a2(g.b, m2(n, dlt)) }; }
      const r = g.ccw ? g.r - dlt : g.r + dlt;
      if (!(r > 1e-9)) throw new Error('An arc is tighter than half the thickness');
      return arcEnds({ ...g, r });
    });
  }
  // lay it out flat: straight runs as they are, arcs as bends (bend allowance)
  let X = 0;
  const lay = [];
  for (const g of list) {
    if (g.kind === 'line') { const L = l2(s2(g.b, g.a)); lay.push({ s: g, X, len: L }); X += L; continue; }
    const outer = (g.ccw ? 1 : -1) === side; // curving toward the material: the sheet's own side is outside
    const R = outer ? g.r - t : g.r;
    if (R < -1e-6) throw new Error(`An arc (R${+g.r.toFixed(3)}) is tighter than the sheet is thick: use a bigger radius or put the material on the other side`);
    const ba = bendAllowance(g.sweep, Math.max(R, 0), K, t);
    lay.push({ s: g, X, len: ba, R: Math.max(R, 0), up: outer });
    X += ba;
  }
  // the frame: at the start of the first straight run (it stays put), or of the profile
  const first = lay.find((L) => L.s.kind === 'line') || lay[0];
  const T0 = tanAt(first.s, false);
  const toward = (T) => (side > 0 ? [-T[1], T[0]] : [T[1], -T[0]]);
  const { o, u, v, n } = frame;
  const to3 = (q) => add3(add3(o, mul3(u, q[0])), mul3(v, q[1]));
  const dir3 = (q) => add3(mul3(u, q[0]), mul3(v, q[1]));
  const u3 = unit3(dir3(T0)), n3 = unit3(dir3(toward(T0))), v3 = cross3(n3, u3);
  const fr = { o: sub3(to3(first.s.a), mul3(u3, first.X)), u: u3, v: v3, n: n3 };
  // along the extrusion: y of the flat (v3 is ± the sketch normal)
  const sy = dot3(n, v3), ya = z0 * sy, yb = z1 * sy, y0 = Math.min(ya, yb), w = Math.abs(yb - ya);
  const region = rectFace([0, y0], [1, 0], [0, 1], X, w);
  const bends = [];
  let nextBend = 1;
  for (const L of lay) {
    if (L.s.kind !== 'arc') continue;
    bends.push({ id: 'b' + nextBend++, p0: [L.X, y0], e: [0, 1], d: [1, 0], w, ba: L.len, ang: L.s.sweep, up: L.up, R: L.R });
  }
  const rootPt = first.s.kind === 'line' ? [first.X + first.len / 2, y0 + w / 2] : null;
  return {
    sheet: { t, K, R: R0, frame: fr, region, bends, rootPt, flat: null, stale: null, nextBend },
    corners, drawn: lay.filter((L) => L.s.kind === 'arc').length - corners, rolled: closedCircle,
  };
}
// Where two curves (a line { a, d } or a circle { c, r }) meet: the point nearest P.
function nearestMeet(A, B, P) {
  if (A.kind === 'circle' && B.kind === 'line') [A, B] = [B, A];
  let pts = [];
  if (A.kind === 'line' && B.kind === 'line') {
    const cr = A.d[0] * B.d[1] - A.d[1] * B.d[0];
    if (Math.abs(cr) < 1e-12) return null;
    const w = s2(B.a, A.a), s = (w[0] * B.d[1] - w[1] * B.d[0]) / cr;
    pts = [a2(A.a, m2(A.d, s))];
  } else if (A.kind === 'line') {
    if (!(B.r > 0)) return null;
    const f = s2(A.a, B.c), bq = d2(f, A.d), cq = d2(f, f) - B.r * B.r, disc = bq * bq - cq;
    if (disc < -1e-9) return null;
    const sq = Math.sqrt(Math.max(0, disc));
    pts = [-bq - sq, -bq + sq].map((s) => a2(A.a, m2(A.d, s)));
  } else {
    if (!(A.r > 0 && B.r > 0)) return null;
    const dv = s2(B.c, A.c), d = l2(dv);
    if (d < 1e-12 || d > A.r + B.r + 1e-9 || d < Math.abs(A.r - B.r) - 1e-9) return null;
    const a = (A.r * A.r - B.r * B.r + d * d) / (2 * d), h = Math.sqrt(Math.max(0, A.r * A.r - a * a));
    const m = a2(A.c, m2(dv, a / d)), nn = [-dv[1] / d, dv[0] / d];
    pts = [a2(m, m2(nn, h)), a2(m, m2(nn, -h))];
  }
  return pts.reduce((best, q) => (!best || l2(s2(q, P)) < l2(s2(best, P)) ? q : best), null);
}

// ------------------------------------------------------------ profile (miter) flange
// A flange with a profile of several segments along a chain of edges: each segment { L (outer length),
// ang (°; negative: folds back the other way, e.g. a Z rather than a C) } is an edge flange on the far edges
// of the one before, corners closed (mitred) at each level when the edges meet. opts as addFlanges
// (R, position for the first level, flip) plus gap (corner gap; null: open corners).
export function addProfileFlanges(sheet, edges, segs, { R, position = 'inside', flip = false, gap = 0.1, relief } = {}) {
  if (!segs.length) throw new Error('The profile needs at least one segment');
  let out = sheet, cur = edges, prevUp = null;
  segs.forEach((sg, k) => {
    if (!(sg.L > 0)) throw new Error(`Segment ${k + 1}: the length must be greater than zero`);
    const ang = Math.abs(sg.ang);
    if (!(ang >= 1 && ang <= 179)) throw new Error(`Segment ${k + 1}: the angle must be 1° to 179° (negative: the other way)`);
    const before = out.bends.length;
    // later segments: on the top face of the last flange's far edge, folding on round the same way
    // (a positive angle) or back (negative)
    const up = k === 0 ? null : sg.ang >= 0 ? prevUp : !prevUp;
    // (later segments: the outer face on the edge, so every length is to the outside of its bends)
    out = addFlanges(out, cur, { length: sg.L, lengthRef: 'outer', angle: ang, position: k ? 'inside' : position, offset: 0, R, flip: k ? !up : flip, relief });
    const added = out.bends.slice(before);
    if (gap != null && added.length > 1) {
      try { out = closedCorner(out, { gap, only: new Set(added.map((b) => b.id)), quiet: true, type: 'overlap', bend: 'vcut' }); } catch { /* corners left open */ }
    }
    prevUp = added[0]?.up;
    if (k === segs.length - 1) return;
    // the far edges of the new flanges (their top face), in model coordinates
    const t = out.t, W = frameM(out.frame), { panelAt } = fold(out);
    cur = added.map((b) => {
      const h = sg.L - setback(b.ang, b.R + t);
      const f0 = a2(b.p0, m2(b.d, b.ba + h)), f1 = a2(f0, m2(b.e, b.w));
      const P = panelAt(a2(m2(a2(f0, f1), 0.5), m2(b.d, -Math.min(1e-2, h / 4))));
      if (!P) throw new Error(`Segment ${k + 2} cannot be placed on the flange before it`);
      const M = mulM(W, P.M);
      return { a: apM(M, [f0[0], f0[1], t]), b: apM(M, [f1[0], f1[1], t]) };
    });
  });
  return out;
}

// ------------------------------------------------------------ sheet metal check
// What the shop needs to know before bending: every bend (angle, inside radius, direction, length, the
// straight flange on each side), and warnings: flanges too short for a press brake (under 3 × t of
// straight past the bend) and holes so close to a bend (under 2t + R) that they would be pulled out of
// shape.
export function sheetCheck(sheet) {
  const t = sheet.t, out = { t, K: sheet.K, R: sheet.R, bends: [], warnings: [], forms: (sheet.forms || []).length, marks: new Set((sheet.marks || []).filter((m) => m.kind !== 'rip').map((m) => m.id)).size };
  if (sheet.lofted) { out.lofted = sheet.lofted.method; return out; }
  const { links } = fold(sheet);
  const pts = (face) => wireLoop(face.clone().outerWire(), 16).map((q) => [q[0], q[1]]);
  const minFlange = 3 * t;
  const order = sheet.bends.map((b) => b.id);
  const seen = new Set();
  for (const lk of links) {
    const b = lk.b;
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    const n = order.indexOf(b.id) + 1;
    const reach = (P, from, dir) => (P?.face ? Math.max(...pts(P.face).map((q) => d2(s2(q, from), dir))) : null);
    const fa = reach(lk.A, b.p0, m2(b.d, -1)), fb = reach(lk.B, a2(b.p0, m2(b.d, b.ba)), b.d);
    out.bends.push({ n, id: b.id, ang: (b.ang * 180) / Math.PI, R: b.R, up: b.up, w: b.w, flangeA: fa, flangeB: fb });
    for (const [side, len] of [['one side', fa], ['the other side', fb]]) {
      if (len != null && len < minFlange - 1e-9) out.warnings.push(`Bend ${n}: the flange on ${side} is ${+len.toFixed(2)} mm — shorter than 3 × t (${+minFlange.toFixed(2)} mm), too short for most V-dies`);
    }
  }
  // holes near bends
  const region = flatRegion(sheet);
  const near = 2 * t;
  let h = 0;
  for (const f of facesOf(region)) {
    for (const w of f.clone().innerWires()) {
      h++;
      const loop = wireLoop(w, 24).map((q) => [q[0], q[1]]);
      for (const b of sheet.bends) {
        // distance from the hole to the bend zone (a rectangle along the bend line)
        let dmin = Infinity;
        for (const q of loop) {
          const rel = s2(q, b.p0), x = d2(rel, b.e), y = d2(rel, b.d);
          const dx = x < 0 ? -x : x > b.w ? x - b.w : 0, dy = y < 0 ? -y : y > b.ba ? y - b.ba : 0;
          dmin = Math.min(dmin, Math.hypot(dx, dy));
        }
        const lim = near + b.R;
        if (dmin < lim - 1e-9) out.warnings.push(`Hole ${h} is ${+dmin.toFixed(2)} mm from bend ${order.indexOf(b.id) + 1} — closer than 2t + R (${+lim.toFixed(2)} mm), it may be pulled out of shape (move it, or add a relief cut)`);
      }
    }
  }
  out.holes = h;
  return out;
}

// ------------------------------------------------------------ forming tools
// Forms pressed into flat panels (dimple, louver, extruded hole) or across bends (gusset). Each is kept on
// the sheet (sheet.forms) in flat coordinates and applied to the folded body after folding; the flat
// pattern gets what the shop needs: a centre mark and note, a louver's slit (a cut) and outline, an
// extruded hole's pre-hole (a real hole in the flat).
// form (flat coords): dimple { kind, q, r, h, up } · louver { kind, q (slit start), e (along), n (hood
// side), L, W, H, up } · exthole { kind, q, D, h, R, up } · gusset { kind, bend (id), s (along it), L, w }

// The flat panel a form at flat point q sits on, and its outline (to keep the form inside it).
function formPanel(sheet, q) {
  const { panels } = fold(sheet);
  return panels.find((P) => faceAt([P.face], q, 1e-7)) || null;
}
function footprintInside(P, foot, what) {
  const out = bop('cut', foot, P.face);
  if (out && areaOf(out) > 1e-6 * (1 + areaOf(foot))) throw new Error(`${what} is too near an edge, a hole or a bend: it must sit on one flat face`);
}
const circleAt = (q, r) => circleFace(q, r);
const markLine = (id, a, b, note = null) => ({ kind: 'form', id, a, b, ...(note ? { note } : {}) });

// Add forms. items: [{ kind, p (model point on a face) | line { a, b } (louver) | p on a bend face (gusset),
// ...params }]. Returns the new sheet.
export function addForms(sheet, items) {
  if (sheet.lofted) throw new Error('Forms cannot be added to a lofted bend');
  if (sheet.flat) throw new Error('Fold the part (Bend feature) before adding forms');
  const t = sheet.t, K = sheet.K;
  let region = sheet.region;
  const forms = [...(sheet.forms || [])], marks = [...(sheet.marks || [])];
  let n = sheet.nextMark || 1;
  items.forEach((it, i) => {
    const what = items.length > 1 ? `${FORM_NAMES[it.kind]} ${i + 1}` : `The ${FORM_NAMES[it.kind].toLowerCase()}`;
    const id = 'f' + n++;
    if (it.kind === 'gusset') {
      const g = locateOnBend(sheet, it.p);
      if (!g) throw new Error(`${what} must be clicked on a bend (its round face)`);
      const { b, s } = g;
      if (!(it.L > 0 && it.w > 0)) throw new Error('The gusset size and width must be greater than zero');
      if (s - it.w / 2 < -1e-9 || s + it.w / 2 > b.w + 1e-9) throw new Error(`${what} runs past the end of its bend`);
      forms.push({ kind: 'gusset', id, bend: b.id, s, L: it.L, w: it.w });
      const c = a2(b.p0, m2(b.e, s));
      marks.push(markLine(id, c, a2(c, m2(b.d, b.ba)), `GUSSET ${+it.L.toFixed(2)} × ${+it.w.toFixed(2)}`));
      return;
    }
    if (it.kind === 'emboss') {
      // (a closed outline raised (or pressed) by H with straight walls: its corners on one flat face)
      const hits = it.poly.map((p) => pointOnSheet(sheet, p));
      if (hits.some((h) => !h) || hits.some((h) => h.panel !== hits[0].panel)) throw new Error(`${what} must lie on one flat face of the sheet`);
      if (!(it.H > 0)) throw new Error('The emboss height must be greater than zero');
      const poly = hits.map((h) => h.q), up = hits[0].top !== !!it.flip;
      const area = Math.abs(poly.reduce((s, p, k) => { const q = poly[(k + 1) % poly.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
      if (!(area > 4 * t * t)) throw new Error(`${what} is too small for the sheet's thickness`);
      footprintInside(hits[0].panel, polyFace(poly), what);
      forms.push({ kind: 'emboss', id, poly, H: it.H, up });
      poly.forEach((p, k) => marks.push(markLine(id, p, poly[(k + 1) % poly.length], k === 0 ? `EMBOSS ${+it.H.toFixed(2)} ${up ? 'UP' : 'DOWN'}` : null)));
      return;
    }
    // a point (or line) on a flat face: the panel and flat coordinates
    const hit = it.kind === 'louver' || it.kind === 'bead' || it.kind === 'lance' ? lineOnSheet(sheet, it.line.a, it.line.b) : pointOnSheet(sheet, it.p);
    if (!hit) throw new Error(`${what} is not on a flat face of the sheet`);
    const P = hit.panel;
    const up = hit.top !== !!it.flip; // (toward the face it was placed on, unless flipped)
    if (it.kind === 'dimple') {
      const r = it.D / 2, h = it.h;
      if (!(r > 0 && h > 0)) throw new Error('The dimple diameter and depth must be greater than zero');
      if (h > r) throw new Error('A dimple can be at most half its diameter deep');
      footprintInside(P, circleAt(hit.q, r + t), what);
      forms.push({ kind: 'dimple', id, q: hit.q, r, h, up });
      for (const dir of [[1, 0], [0, 1]]) marks.push(markLine(id, a2(hit.q, m2(dir, -r)), a2(hit.q, m2(dir, r)), dir[0] ? `DIMPLE Ø${+it.D.toFixed(2)} × ${+h.toFixed(2)} ${up ? 'UP' : 'DOWN'}` : null));
    } else if (it.kind === 'louver') {
      const L = l2(s2(hit.pb, hit.pa)), e = u2(s2(hit.pb, hit.pa));
      const nn = it.side ? [e[1], -e[0]] : [-e[1], e[0]];
      if (!(it.W > 0 && it.H > 0)) throw new Error('The louver width and height must be greater than zero');
      if (it.H > it.W * 1.5) throw new Error('A louver can be at most 1.5 × its width high');
      footprintInside(P, rectFace(a2(a2(hit.pa, m2(e, -t)), m2(nn, -t)), e, nn, L + 2 * t, it.W + 2 * t), what);
      forms.push({ kind: 'louver', id, q: hit.pa, e, n: nn, L, W: it.W, H: it.H, up });
      // the slit (cut) and the hood's outline
      marks.push({ kind: 'slit', id, a: hit.pa, b: hit.pb });
      const c = [hit.pa, a2(hit.pa, m2(nn, it.W)), a2(hit.pb, m2(nn, it.W)), hit.pb];
      for (let k = 0; k < 3; k++) marks.push(markLine(id, c[k], c[k + 1], k === 1 ? `LOUVER ${+L.toFixed(2)} × ${+it.W.toFixed(2)} × ${+it.H.toFixed(2)} ${up ? 'UP' : 'DOWN'}` : null));
    } else if (it.kind === 'bead') {
      // (a stiffening bead along the line: a round-topped rib W wide, H high, its ends rounded)
      const L = l2(s2(hit.pb, hit.pa)), e = u2(s2(hit.pb, hit.pa)), nn = [-e[1], e[0]], r = it.W / 2;
      if (!(r > 0 && it.H > 0)) throw new Error('The bead width and height must be greater than zero');
      if (it.H > r) throw new Error('A bead can be at most half its width high');
      footprintInside(P, rectFace(a2(a2(hit.pa, m2(e, -r - t)), m2(nn, -r - t)), e, nn, L + 2 * r + 2 * t, 2 * r + 2 * t), what);
      forms.push({ kind: 'bead', id, q: hit.pa, e, n: nn, L, r, h: it.H, up });
      marks.push(markLine(id, hit.pa, hit.pb, `BEAD ${+it.W.toFixed(2)} × ${+it.H.toFixed(2)} ${up ? 'UP' : 'DOWN'}`));
    } else if (it.kind === 'lance') {
      // (a bridge lance: slits along the line and W from it, the strip between pressed out H, ramped at 45° at its ends)
      const L = l2(s2(hit.pb, hit.pa)), e = u2(s2(hit.pb, hit.pa)), nn = it.side ? [e[1], -e[0]] : [-e[1], e[0]];
      if (!(it.W > 0 && it.H > 0)) throw new Error('The lance width and height must be greater than zero');
      if (!(L > 2 * it.H + t)) throw new Error('A lance must be longer than twice its height (its ramps)');
      footprintInside(P, rectFace(a2(a2(hit.pa, m2(e, -t)), m2(nn, -t)), e, nn, L + 2 * t, it.W + 2 * t), what);
      forms.push({ kind: 'lance', id, q: hit.pa, e, n: nn, L, W: it.W, H: it.H, up });
      marks.push({ kind: 'slit', id, a: hit.pa, b: hit.pb }, { kind: 'slit', id, a: a2(hit.pa, m2(nn, it.W)), b: a2(hit.pb, m2(nn, it.W)) });
      marks.push(markLine(id, hit.pa, a2(hit.pa, m2(nn, it.W)), `LANCE ${+L.toFixed(2)} × ${+it.W.toFixed(2)} × ${+it.H.toFixed(2)} ${up ? 'UP' : 'DOWN'}`));
    } else if (it.kind === 'exthole') {
      const R0 = it.R > 0 ? it.R : sheet.R, D = it.D, h = it.h;
      if (!(D > 0)) throw new Error('The hole diameter must be greater than zero');
      if (!(h >= t + R0)) throw new Error(`The collar must be at least ${+(t + R0).toFixed(3)} mm high (thickness + radius)`);
      const rb = D / 2 + t + R0;
      // the pre-hole: the collar laid flat (bend allowance + straight wall) back from where the bend starts
      const rPre = rb - (bendAllowance(Math.PI / 2, R0, K, t) + (h - t - R0));
      if (!(rPre > 1e-3)) throw new Error('The collar is too high for the hole: there is no material left to form it (use a larger hole or a lower collar)');
      footprintInside(P, circleAt(hit.q, rb + t), what);
      region = bop('cut', region, circleAt(hit.q, rPre));
      forms.push({ kind: 'exthole', id, q: hit.q, D, h, R: R0, up, rPre });
      for (const dir of [[1, 0], [0, 1]]) marks.push(markLine(id, a2(hit.q, m2(dir, -rb)), a2(hit.q, m2(dir, rb)), dir[0] ? `EXTRUDED HOLE Ø${+D.toFixed(2)} × ${+h.toFixed(2)} ${up ? 'UP' : 'DOWN'} (pre-hole Ø${+(2 * rPre).toFixed(2)})` : null));
    }
  });
  return { ...sheet, region, forms, marks, nextMark: n };
}
const FORM_NAMES = { dimple: 'Dimple', louver: 'Louver', exthole: 'Extruded hole', gusset: 'Gusset', bead: 'Bead', lance: 'Lance', emboss: 'Emboss' };

// The bend a model point (on a bend's round face) is on, and how far along it.
function locateOnBend(sheet, p) {
  const { links } = fold(sheet);
  const W = frameM(sheet.frame), t = sheet.t;
  let best = null;
  for (const lk of links) {
    const b = lk.b, q = apM(invM(mulM(W, lk.A.M)), p);
    // the point in the bend's own terms: along it, and its distance from the bend axis
    const rel = s2([q[0], q[1]], b.p0), s = d2(rel, b.e), across = d2(rel, b.d);
    const az = axisZ(b, t), r = Math.hypot(across, q[2] - az);
    if (s < -1e-6 || s > b.w + 1e-6) continue;
    const off = Math.max(0, b.R - r, r - (b.R + t));
    // (and on the bend's side of the A panel)
    if (across < -1e-3) continue;
    if (!best || off < best.off) best = { b, s, off };
  }
  return best && best.off < Math.max(0.05, t * 0.05) ? best : null;
}

// The forms on the folded body (in the root panel's flat coordinates, before the frame is applied).
function formSolid(sheet, sol) {
  if (!sheet.forms?.length) return sol;
  const { panels, links } = fold(sheet);
  const t = sheet.t;
  const mirror = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, t]; // z → t − z (a form pressed down)
  for (const f of sheet.forms) {
    try {
      if (f.kind === 'gusset') {
        const lk = links.find((x) => x.b.id === f.bend);
        if (!lk) continue;
        const b = lk.b, th = b.ang, R0 = b.R;
        // the inside corner: a triangle from the A panel's inner face, through the virtual sharp, along B's
        const zi = b.up ? t : 0, sg = b.up ? 1 : -1, dv = R0 * Math.tan(th / 2);
        const X0 = a2(b.p0, m2(b.e, f.s - f.w / 2));
        const at = (u, z) => [X0[0] + b.d[0] * u, X0[1] + b.d[1] * u, z];
        const tri = [at(dv - f.L, zi), at(dv, zi), at(dv + Math.cos(th) * f.L, zi + sg * Math.sin(th) * f.L)];
        // (a full triangle only for bends up to 90° plus; beyond that the legs pass behind each other)
        const prism = R.basicFaceExtrusion(R.makePolygon(tri), new R.Vector([b.e[0] * f.w, b.e[1] * f.w, 0]));
        sol = sol.fuse(applyM(prism, lk.A.M));
        continue;
      }
      // (an extruded hole's centre is in its pre-hole: the panel round it)
      const P = panels.find((x) => faceAt([x.face], f.kind === 'emboss' ? f.poly[0] : f.q, f.kind === 'exthole' ? f.rPre + 1e-4 : f.kind === 'emboss' ? 1e-4 : 1e-7));
      if (!P) continue;
      let cutTool = null, addTool = null;
      if (f.kind === 'emboss') {
        // (the footprint moved out by H: its top a thickness thick, its walls a thickness thick, straight)
        const prism = (pts, z0, z1) => R.basicFaceExtrusion(R.makePolygon(pts.map(([x, y]) => [x, y, z0])), new R.Vector([0, 0, z1 - z0]));
        const cw = f.poly.reduce((s, p, k) => { const q = f.poly[(k + 1) % f.poly.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) > 0 ? 1 : -1;
        // (the outline moved in by a thickness: each side's line moved in, corners where they meet)
        const m = f.poly.length, lines = f.poly.map((p, k) => { const q = f.poly[(k + 1) % m], d = u2(s2(q, p)), nin = cw > 0 ? [-d[1], d[0]] : [d[1], -d[0]]; return { p: a2(p, m2(nin, t)), d }; });
        const inner = lines.map((l, k) => { const o = lines[(k + m - 1) % m], den = o.d[0] * l.d[1] - o.d[1] * l.d[0]; if (Math.abs(den) < 1e-12) return l.p; const w = s2(l.p, o.p), s = (w[0] * l.d[1] - w[1] * l.d[0]) / den; return a2(o.p, m2(o.d, s)); });
        cutTool = prism(f.poly, -1e-3, t + 1e-3);
        addTool = prism(f.poly, 0, f.H + t).cut(prism(inner, -1e-3, f.H));
      }
      if (f.kind === 'dimple') {
        // the material pushed out: lose the cap under the inner surface, gain the cap under the outer one
        const rho = (f.r * f.r + f.h * f.h) / (2 * f.h);
        const cap = (z0) => {
          const sphere = R.makeSphere(rho).translate([f.q[0], f.q[1], z0 + f.h - rho]);
          return sphere.intersect(R.makeBox([f.q[0] - f.r - 1, f.q[1] - f.r - 1, z0], [f.q[0] + f.r + 1, f.q[1] + f.r + 1, z0 + f.h + 1]));
        };
        cutTool = cap(0); addTool = cap(t);
      } else if (f.kind === 'louver') {
        // the hood: the strip between the slit and the back edge raised on a quarter ellipse (leaving the
        // panel level at the back, upright at the slit), a thickness thick; its footprint taken out
        const N = 16, pts = [];
        for (let k = 0; k <= N; k++) { const ph = (k / N) * (Math.PI / 2); pts.push([f.W - f.W * Math.sin(ph), f.H - f.H * Math.cos(ph)]); }
        // the other side: a thickness along the curve's normal (toward +z / the front)
        const top = pts.map((p, k) => {
          const a = pts[Math.max(0, k - 1)], b = pts[Math.min(N, k + 1)], tg = u2(s2(b, a));
          const nrm = [tg[1], -tg[0]]; // (rotated so it points up at the back)
          const nn = nrm[1] < 0 ? m2(nrm, -1) : nrm;
          return a2(p, m2(nn, t));
        });
        const to3 = ([u, z]) => [f.q[0] + f.n[0] * u, f.q[1] + f.n[1] * u, z];
        // (smooth curves, so the hood is two smooth faces rather than facets)
        const bot3 = pts.map(to3), top3 = top.map(to3);
        let face;
        try {
          const sp = (q) => R.makeBSplineApproximation(q, { tolerance: 1e-4, degMax: 3 });
          face = R.makeFace(R.assembleWire([sp(bot3), R.makeLine(bot3[N], top3[N]), sp([...top3].reverse()), R.makeLine(top3[0], bot3[0])]));
        } catch { face = R.makePolygon([...bot3, ...[...top3].reverse()]); }
        addTool = R.basicFaceExtrusion(face, new R.Vector([f.e[0] * f.L, f.e[1] * f.L, 0]));
        const foot = rectFace(f.q, f.e, f.n, f.L, f.W);
        cutTool = R.basicFaceExtrusion(facesOf(applyM(foot, transM([0, 0, -1e-3])))[0], new R.Vector([0, 0, t + 2e-3]));
      } else if (f.kind === 'bead') {
        // (like a dimple drawn along the line: a cap's cross-section swept along it, a dimple cap at each end)
        const rho = (f.r * f.r + f.h * f.h) / (2 * f.h);
        const capAlong = (z0) => {
          const N = 24, pts = [];
          for (let k = 0; k <= N; k++) { const x = -f.r + (2 * f.r * k) / N, z = Math.sqrt(Math.max(0, rho * rho - x * x)) - (rho - f.h); pts.push([x, z]); }
          const sec = R.makePolygon(pts.map(([x, z]) => [f.q[0] + f.n[0] * x, f.q[1] + f.n[1] * x, z0 + Math.max(0, z)]));
          let s3 = R.basicFaceExtrusion(sec, new R.Vector([f.e[0] * f.L, f.e[1] * f.L, 0]));
          // (each end rounded: half the cross-section turned about the end's upright, a spherical cap)
          for (const end of [f.q, a2(f.q, m2(f.e, f.L))]) {
            const half = pts.filter(([x]) => x >= -1e-12).map(([x, z]) => [end[0] + f.n[0] * x, end[1] + f.n[1] * x, z0 + Math.max(0, z)]);
            s3 = s3.fuse(R.revolution(R.makePolygon([[end[0], end[1], z0], ...half.slice(0, -1), [half.at(-1)[0], half.at(-1)[1], z0]].filter((q, k, l) => k === 0 || Math.hypot(q[0] - l[k - 1][0], q[1] - l[k - 1][1], q[2] - l[k - 1][2]) > 1e-9)), [end[0], end[1], z0], [0, 0, 1], 360));
          }
          return s3;
        };
        cutTool = capAlong(0); addTool = capAlong(t);
      } else if (f.kind === 'lance') {
        // (the strip: pressed out H, ramped at 45° to the panel at each end, a thickness thick; its footprint out)
        const a = f.H, prof = [[0, 0], [a, f.H], [f.L - a, f.H], [f.L, 0], [f.L, t], [f.L - a, f.H + t], [a, f.H + t], [0, t]];
        const sec = R.makePolygon(prof.map(([u, z]) => [f.q[0] + f.e[0] * u, f.q[1] + f.e[1] * u, z]));
        addTool = R.basicFaceExtrusion(sec, new R.Vector([f.n[0] * f.W, f.n[1] * f.W, 0]));
        const foot = rectFace(f.q, f.e, f.n, f.L, f.W);
        cutTool = R.basicFaceExtrusion(facesOf(applyM(foot, transM([0, 0, -1e-3])))[0], new R.Vector([0, 0, t + 2e-3]));
      } else if (f.kind === 'exthole') {
        // the collar: the bend (quarter annulus) and the straight wall, turned round the hole's axis
        const rb = f.D / 2 + t + f.R, N = 12, pts = [];
        const cz = t + f.R;
        for (let k = 0; k <= N; k++) { const a = -Math.PI / 2 - (k / N) * (Math.PI / 2); pts.push([rb + (f.R + t) * Math.cos(a), cz + (f.R + t) * Math.sin(a)]); }
        pts.push([f.D / 2, f.h], [f.D / 2 + t, f.h]);
        for (let k = N; k >= 0; k--) { const a = -Math.PI / 2 - (k / N) * (Math.PI / 2); pts.push([rb + f.R * Math.cos(a), cz + f.R * Math.sin(a)]); }
        const prof = R.makePolygon(pts.map(([r, z]) => [f.q[0] + r, f.q[1], z]));
        addTool = R.revolution(prof, [f.q[0], f.q[1], 0], [0, 0, 1], 360);
        cutTool = R.makeCylinder(rb, t + 2e-3, [f.q[0], f.q[1], -1e-3], [0, 0, 1]);
      }
      if (!f.up) { cutTool = applyM(cutTool, mirror); addTool = applyM(addTool, mirror); }
      sol = sol.cut(applyM(cutTool, P.M)).fuse(applyM(addTool, P.M));
    } catch { /* (a form that cannot be made is left off rather than losing the part) */ }
  }
  return sol;
}

// ------------------------------------------------------------ tab and slot
// Tabs on an edge of sheet A where it meets a face of sheet B, and the slots they go through in B (so the
// parts locate each other for welding). edge: { a, b } a straight model edge on A's top or bottom face
// (the end of a panel). opts: { count, length (each tab, along the edge), height (how far a tab sticks out;
// default B's thickness, flush), clearance (slot oversize all round), margin (from each end of the edge;
// default: the tabs evenly spread) }. Returns { a, b } — the two new sheets.
export function addTabsSlots(sa, edge, sb, { count = 3, length = 15, height = 0, clearance = 0.1, margin = null } = {}) {
  if (sa.lofted || sb.lofted) throw new Error('Tabs and slots cannot be added to a lofted bend');
  if (sa.flat || sb.flat) throw new Error('Fold the parts (Bend feature) before adding tabs and slots');
  const loc = locateEdge(sa, edge.a, edge.b);
  if (!loc) throw new Error('The tab edge is not a straight edge on the top or bottom face of the sheet (pick an edge where it meets the other part)');
  const n = Math.round(count);
  if (!(n >= 1 && n <= 200)) throw new Error('The number of tabs must be 1 to 200');
  if (!(length > 0)) throw new Error('The tab length must be greater than zero');
  if (!(clearance >= 0)) throw new Error('The clearance can\'t be negative');
  const h = height > 0 ? height : sb.t;
  const e = u2(s2(loc.pb, loc.pa)), w = l2(s2(loc.pb, loc.pa)), d = loc.d;
  const room = margin != null && margin >= 0 ? w - 2 * margin : w;
  if (n * length > room + 1e-9) throw new Error(`${n} tabs of ${length} mm do not fit along the ${+w.toFixed(2)} mm edge${margin ? ` (less the margins)` : ''}`);
  // the tabs evenly spread: equal gaps between them, half a gap (or the margin) at each end
  const starts = [];
  if (margin != null && margin >= 0) {
    const gap = n > 1 ? (room - n * length) / (n - 1) : 0;
    for (let i = 0; i < n; i++) starts.push(n > 1 ? margin + i * (length + gap) : (w - length) / 2);
  } else {
    const gap = (w - n * length) / n;
    for (let i = 0; i < n; i++) starts.push(gap / 2 + i * (length + gap));
  }
  // A: the tabs added to its flat pattern, beyond the edge
  let region = sa.region;
  for (const s of starts) region = bop('fuse', region, rectFace(a2(loc.pa, m2(e, s)), e, d, length, h));
  const a = { ...sa, region };
  // B: a slot through it where each tab goes (the tab with the clearance all round, carried on through B)
  const t = sa.t, M = mulM(frameM(sa.frame), loc.panel.M);
  let tool = null;
  for (const s of starts) {
    const foot = rectFace(a2(a2(loc.pa, m2(e, s - clearance)), m2(d, -clearance)), e, d, length + 2 * clearance, h + sb.t + clearance + 1);
    const box = R.basicFaceExtrusion(facesOf(applyM(foot, transM([0, 0, -clearance])))[0], new R.Vector([0, 0, t + 2 * clearance]));
    tool = tool ? tool.fuse(applyM(box, M)) : applyM(box, M);
  }
  const cut = cutSheet(sb, tool);
  if (!cut.hit) throw new Error('The tabs do not reach the other part: pick the edge that meets the slot face');
  return { a, b: cut.sheet, starts, h };
}

// ------------------------------------------------------------ cross breaks
// The flat panel whose top or bottom face holds the model point p: { panel, q (flat), top } or null.
export function pointOnSheet(sheet, p) {
  if (sheet.lofted || sheet.flat) return null;
  const { panels } = fold(sheet);
  const W = frameM(sheet.frame), t = sheet.t, tol = Math.max(1e-4, t * 1e-3);
  for (const P of panels) {
    const q = apM(invM(mulM(W, P.M)), p);
    const top = Math.abs(q[2] - t) < tol, bottom = Math.abs(q[2]) < tol;
    if ((top || bottom) && faceAt([P.face], [q[0], q[1]], 1e-6)) return { panel: P, q: [q[0], q[1]], top };
  }
  return null;
}
// Cross breaks: an X across each picked flat face (corner to corner of a four-sided face, otherwise across
// the face's bounding box), shallow folds that stiffen the panel. They are kept as marks for the flat
// pattern and DXF (the folded body is not changed: the folds are a few degrees). up: the X pressed up.
export function addCrossBreaks(sheet, points, { up = true } = {}) {
  if (sheet.lofted) throw new Error('A lofted bend cannot have cross breaks');
  if (sheet.flat) throw new Error('Fold the part (Bend feature) before adding cross breaks');
  const marks = [...(sheet.marks || [])];
  let n = (sheet.nextMark || 1);
  points.forEach((p, i) => {
    const hit = pointOnSheet(sheet, p);
    if (!hit) throw new Error(`Face ${i + 1} is not a flat face of the sheet`);
    const face = hit.panel.face;
    // the face's corners (points along straight runs dropped)
    let loop = wireLoop(face.clone().outerWire(), 8).map((q) => [q[0], q[1]]);
    loop = loop.filter((q, k) => {
      const a = loop[(k + loop.length - 1) % loop.length], b = loop[(k + 1) % loop.length];
      return Math.abs((q[0] - a[0]) * (b[1] - q[1]) - (q[1] - a[1]) * (b[0] - q[0])) > 1e-9 * (1 + l2(s2(b, a)) ** 2);
    });
    let diags;
    if (loop.length === 4) diags = [[loop[0], loop[2]], [loop[1], loop[3]]];
    else {
      const bb = bbox2(face);
      diags = [[bb.min, bb.max], [[bb.min[0], bb.max[1]], [bb.max[0], bb.min[1]]]].map(([a, b]) => [[a[0], a[1]], [b[0], b[1]]]);
    }
    const id = 'x' + n++;
    for (const [a, b] of diags) for (const [ca, cb] of clipSegment([face], a, b)) marks.push({ kind: 'crossbreak', id, a: ca, b: cb, up });
  });
  return { ...sheet, marks, nextMark: n };
}

// ------------------------------------------------------------ sketched bend / jog
// Where a model line (a, b) lies on the sheet: the flat panel whose top or bottom face holds it, the line
// in flat coordinates, and whether it is on the top face. null when it is not on a flat face.
export function lineOnSheet(sheet, a, b) {
  if (sheet.lofted || sheet.flat) return null;
  const { panels } = fold(sheet);
  const W = frameM(sheet.frame), t = sheet.t, tol = Math.max(1e-4, t * 1e-3);
  for (const P of panels) {
    const L = invM(mulM(W, P.M));
    const qa = apM(L, a), qb = apM(L, b);
    const top = Math.abs(qa[2] - t) < tol && Math.abs(qb[2] - t) < tol;
    const bottom = Math.abs(qa[2]) < tol && Math.abs(qb[2]) < tol;
    if (!top && !bottom) continue;
    const pa = [qa[0], qa[1]], pb = [qb[0], qb[1]];
    if (l2(s2(pb, pa)) < 1e-9) continue;
    if (!faceAt([P.face], m2(a2(pa, pb), 0.5), 1e-6)) continue;
    return { panel: P, pa, pb, top };
  }
  return null;
}

// Etch lines: polylines drawn on a flat face of the sheet (model coordinates), marked in the flat pattern on the
// panel they lie on, clipped to its face. Returns { sheet, count } (count: the segments marked).
export function addEtch(sheet, polylines, id) {
  if (sheet.lofted) throw new Error('A lofted bend cannot have etch lines');
  if (sheet.flat) throw new Error('Fold the part (Bend feature) before adding etch lines');
  const { panels } = fold(sheet);
  const W = frameM(sheet.frame), t = sheet.t, tol = Math.max(1e-4, t * 1e-3);
  const pts = polylines.flat();
  // the panel whose top or bottom face holds the most of the points
  let best = null, bestN = 0;
  for (const P of panels) {
    const L = invM(mulM(W, P.M));
    let n = 0;
    for (const p of pts) {
      const q = apM(L, p);
      if ((Math.abs(q[2] - t) < tol || Math.abs(q[2]) < tol) && faceAt([P.face], [q[0], q[1]], 1e-6)) n++;
    }
    if (n > bestN) { bestN = n; best = { P, L }; }
  }
  if (!best) throw new Error('The etch sketch is not on a flat face of the sheet: draw it on the top or bottom face of a flat part');
  const marks = [...(sheet.marks || [])];
  let count = 0;
  for (const pl of polylines) for (let i = 1; i < pl.length; i++) {
    const a = apM(best.L, pl[i - 1]), b = apM(best.L, pl[i]);
    for (const [ca, cb] of clipSegment([best.P.face], [a[0], a[1]], [b[0], b[1]])) { marks.push({ kind: 'etch', id, a: ca, b: cb }); count++; }
  }
  return { sheet: { ...sheet, marks }, count };
}

const bendShift = (position, ba) => (position === 'start' ? 0 : position === 'end' ? -ba : -ba / 2);

// A bend zone across the panel of `hit` (a line found by lineOnSheet), `shift` across the line from it
// (along the line's left normal). Returns the sheet with the bend added.
function placeBend(sheet, hit, { ang, R0, shift, up }, what) {
  const t = sheet.t, ba = bendAllowance(ang, R0, sheet.K, t);
  const e = u2(s2(hit.pb, hit.pa)), nrm = [-e[1], e[0]];
  const bb = bbox2(sheet.region), big = 4 * (bb.max[0] - bb.min[0] + bb.max[1] - bb.min[1]) + 10;
  const band = rectFace(a2(a2(hit.pa, m2(e, -big)), m2(nrm, shift)), e, nrm, 2 * big, ba);
  const piece = bop('common', sheet.region, band);
  if (!piece || areaOf(piece) < 1e-9) throw new Error(`${what} does not cross the sheet`);
  for (const ob of sheet.bends) {
    const c = bop('common', piece, stripFace(ob));
    if (c && areaOf(c) > 1e-6) throw new Error(`${what} runs into another bend: a bend must cross one flat panel only`);
  }
  // only the face the line is on: the zone may not reach into another part of the sheet
  const other = bop('cut', piece, hit.panel.face);
  if (other && areaOf(other) > 1e-6 * ba) throw new Error(`${what} runs on beyond its flat face (into other parts of the sheet)`);
  // the zone's extent along the line
  let s0 = Infinity, s1 = -Infinity;
  for (const f of facesOf(piece)) for (const q of wireLoop(f.clone().outerWire(), 8)) { const s = d2(s2([q[0], q[1]], hit.pa), e); s0 = Math.min(s0, s); s1 = Math.max(s1, s); }
  const p0 = a2(a2(hit.pa, m2(e, s0)), m2(nrm, shift));
  let nextBend = sheet.nextBend || sheet.bends.length + 1;
  const bend = { id: 'b' + nextBend++, p0, e, d: nrm, w: s1 - s0, ba, ang, up, R: R0 };
  return { ...sheet, bends: [...sheet.bends, bend], nextBend };
}

// Which side of a new bend zone [lo, hi] (across the line of `hit`) keeps its place when sheetN is folded:
// the side whose panel is placed as the bent face was before (-1: before the zone, +1: after it).
function stayingSide(hit, sheetN, lo, hi) {
  const { panelAt } = fold(sheetN);
  const e = u2(s2(hit.pb, hit.pa)), nrm = [-e[1], e[0]], mid = m2(a2(hit.pa, hit.pb), 0.5);
  const same = (M) => M && M.every((v, i) => Math.abs(v - hit.panel.M[i]) < 1e-7 * (1 + Math.abs(v)));
  for (const dl of [1e-3, 1e-2, 0.1]) {
    const before = panelAt(a2(mid, m2(nrm, lo - dl))), after = panelAt(a2(mid, m2(nrm, hi + dl)));
    if (before && same(before.M)) return -1;
    if (after && same(after.M)) return 1;
  }
  return -1;
}
// The other side kept in place instead (or the root moved out of a zone): the root point goes to that side
// of the bent face, and the frame moves with it so nothing else moves (the face was placed by hit.panel.M).
function keepSide(sheet0, sheetN, hit, lo, hi, side, what) {
  const e = u2(s2(hit.pb, hit.pa)), nrm = [-e[1], e[0]];
  const bb = bbox2(sheet0.region), big = 4 * (bb.max[0] - bb.min[0] + bb.max[1] - bb.min[1]) + 10;
  const half = side < 0
    ? rectFace(a2(a2(hit.pa, m2(e, -big)), m2(nrm, lo - big)), e, nrm, 2 * big, big)
    : rectFace(a2(a2(hit.pa, m2(e, -big)), m2(nrm, hi)), e, nrm, 2 * big, big);
  const keep = bop('common', hit.panel.face, half);
  if (!keep || areaOf(keep) < 1e-9) throw new Error(`${what} is at the edge of its face: there is no material on that side of the bend`);
  const c = facesOf(keep)[0].center, cc = Array.isArray(c) ? c : c.toTuple ? c.toTuple() : [c.x, c.y];
  return { ...sheetN, rootPt: insidePoint(keep, [cc[0], cc[1]]), frame: frameOfM(mulM(frameM(sheet0.frame), hit.panel.M)) };
}
// Place the zones of new bends (offsets across the line from `lay(sign)`, sign: +1 when the moving side
// is the line's left) so that 'start' / 'end' are measured toward the side that moves.
function bendsAcross(sheet, hit, { ang, R0, position, swapFixed, flip }, zones, what) {
  const ba = bendAllowance(ang, R0, sheet.K, sheet.t);
  // which side moves: try the bend centred on the line
  const trial = placeBend(sheet, hit, { ang, R0, shift: -ba / 2, up: true }, what);
  let fixed = stayingSide(hit, trial, -ba / 2, ba / 2);
  if (swapFixed) fixed = -fixed;
  const mv = -fixed;
  const first = position === 'center' ? -ba / 2 : position === 'start' ? (mv > 0 ? 0 : -ba) : mv > 0 ? -ba : 0;
  let out = sheet, lo = Infinity, hi = -Infinity;
  for (const z of zones(first, mv, ba)) {
    out = placeBend(out, hit, { ang, R0, shift: z.shift, up: z.up !== !!flip ? hit.top : !hit.top }, what);
    lo = Math.min(lo, z.shift); hi = Math.max(hi, z.shift + ba);
  }
  // the side asked for keeps its place (and never the root inside a zone)
  if (stayingSide(hit, out, lo, hi) !== fixed) out = keepSide(sheet, out, hit, lo, hi, fixed, what);
  return { out, lo, hi };
}
function bendChecks(sheet, angle, R) {
  if (sheet.lofted) throw new Error('A lofted bend cannot be bent along a line');
  if (sheet.flat) throw new Error('Fold the part (Bend feature) before adding bends');
  const R0 = R > 0 ? R : sheet.R;
  if (!(R0 >= 0)) throw new Error('The bend radius can\'t be negative');
  return { R0, ang: (Math.min(Math.max(angle, 1), 179) * Math.PI) / 180 };
}

// Bend a flat panel along lines drawn on its face (the flat pattern stays the plate it is: a bend zone is
// placed on each line, right across its panel). lines: [{ a, b }] in model coordinates.
// opts: { angle (°), R, position: 'center' | 'start' | 'end' (the zone centred on the line, or starting /
// ending at it on the side that moves), flip (fold away from the face the line is on), swapFixed (the
// other side stays put) }
export function addSketchedBends(sheet, lines, { angle, R, position = 'center', flip = false, swapFixed = false }) {
  let out = sheet;
  lines.forEach(({ a, b }, i) => {
    const what = lines.length > 1 ? `Bend line ${i + 1}` : 'The bend line';
    const { R0, ang } = bendChecks(out, angle, R);
    const hit = lineOnSheet(out, a, b);
    if (!hit) throw new Error(`${what} is not on a flat face of the sheet: draw the sketch on its top or bottom face`);
    out = bendsAcross(out, hit, { ang, R0, position, swapFixed, flip }, (first) => [{ shift: first, up: true }], what).out;
  });
  return out;
}

// A jog: two opposite bends from one line, the flat between them long enough that the sheet steps over by
// `height` — measured face to face on the same side ('face'), outside to outside ('overall': the step
// plus t) or inside to inside ('inside': the step less t). The first bend is placed on the line.
export function addJog(sheet, { a, b }, { height, ref = 'face', angle = 90, R, position = 'start', flip = false, swapFixed = false }) {
  if (!(height > 0)) throw new Error('The jog height must be greater than zero');
  const { R0, ang } = bendChecks(sheet, angle, R);
  const t = sheet.t;
  const H = ref === 'overall' ? height - t : ref === 'inside' ? height + t : height;
  // a face steps over two opposite bends with a flat of m between them by (2R + t)(1 − cos θ) + m sin θ
  const m = (H - (2 * R0 + t) * (1 - Math.cos(ang))) / Math.sin(ang);
  if (m < -1e-9) {
    const least = (2 * R0 + t) * (1 - Math.cos(ang)) + (ref === 'overall' ? t : ref === 'inside' ? -t : 0);
    throw new Error(`The jog is too low for its bends: at this radius and angle it is at least ${+least.toFixed(3)} mm (use a smaller radius or angle)`);
  }
  const hit = lineOnSheet(sheet, a, b);
  if (!hit) throw new Error('The jog line is not on a flat face of the sheet: draw the sketch on its top or bottom face');
  const flat = Math.max(0, m);
  const { out } = bendsAcross(sheet, hit, { ang, R0, position, swapFixed, flip }, (first, mv, ba) => [
    { shift: first, up: true },
    // the second bend on past the first and the flat, toward the moving side, folding back
    { shift: mv > 0 ? first + ba + flat : first - flat - ba, up: false },
  ], 'The jog');
  return { ...out, jogFlat: flat };
}

// ------------------------------------------------------------ transitions / reducers
// The two ends of a transition: round (r) or a convex polygon (corners counter-clockwise), in the end's
// plane coordinates (centre c). Polygon side k runs from corner k to corner k + 1; its outward normal
// is at angle psi[k] (side 0 faces +x).
export function transitionEnd({ shape, d, w, l, size, basis = 'side' }, grow = 0) {
  if (shape === 'round') {
    if (!(d > 0)) throw new Error('The diameter must be greater than zero');
    return { kind: 'round', r: d / 2 + grow };
  }
  let corners;
  if (shape === 'square' || shape === 'rect') {
    const W = shape === 'square' ? size : w, L = shape === 'square' ? size : l;
    if (!(W > 0 && L > 0)) throw new Error('The sides must be greater than zero');
    corners = [[W / 2, -L / 2], [W / 2, L / 2], [-W / 2, L / 2], [-W / 2, -L / 2]];
  } else {
    const M = { tri: 3, pent: 5, hex: 6 }[shape];
    if (!M) throw new Error('Unknown end shape: ' + shape);
    if (!(size > 0)) throw new Error('The size must be greater than zero');
    // circumradius from the side, the inscribed diameter (across flats) or the circumscribed one
    const Rc = basis === 'corners' ? size / 2 : basis === 'flats' ? size / 2 / Math.cos(Math.PI / M) : size / 2 / Math.sin(Math.PI / M);
    corners = Array.from({ length: M }, (_, k) => { const a = ((2 * k - 1) * Math.PI) / M; return [Rc * Math.cos(a), Rc * Math.sin(a)]; });
  }
  const M = corners.length;
  const psi = corners.map((c, k) => { const q = corners[(k + 1) % M]; return Math.atan2(-(q[0] - c[0]), q[1] - c[1]); });
  // grown outward (each side moved out by grow)
  if (grow) {
    corners = corners.map((c, k) => {
      const a1 = psi[(k + M - 1) % M], a2v = psi[k];
      const n1 = [Math.cos(a1), Math.sin(a1)], n2 = [Math.cos(a2v), Math.sin(a2v)];
      const f = grow / (1 + n1[0] * n2[0] + n1[1] * n2[1]);
      return [c[0] + (n1[0] + n2[0]) * f, c[1] + (n1[1] + n2[1]) * f];
    });
  }
  return { kind: 'poly', corners, psi, M };
}
const TAU2 = 2 * Math.PI;
// angles from a0 upward (a0 ≤ result < a0 + 2π)
const unwrapFrom = (a, a0) => { let x = a; while (x < a0 - 1e-12) x += TAU2; while (x >= a0 + TAU2 - 1e-12) x -= TAU2; return x; };

// The parts of a transition between end `bot` (in the plane at o, axes X, Y) and end `top` (in the plane
// at o + h·d, its centre moved off by `off` along X, Y), each part an open strip of matched points
// A (bottom) ↔ B (top) with the indices where it has a corner (breaks).
// parts: equal parts (seams evenly round); seamAt: 'mid' (middle of the flat sides) | 'corner'
// (polygons); seamShift: the first seam one side / corner on; seamAngle: where the first seam of a round
// to round part is (radians from X); div: divisions (a quarter turn of a corner fan, or the whole round
// for round to round); gap: the gap at each seam of a round to round part (a one-part cone needs one).
export function transitionParts({ o, d, X, Y, h, bot, top, off = [0, 0], parts = 1, seamAt = 'mid', seamShift = false, seamAngle = 0, div = 24, gap = 0 }) {
  if (!(h > 0)) throw new Error('The height (the length of the sketch line) must be greater than zero');
  const N = Math.round(parts);
  if (!(N >= 1 && N <= 64)) throw new Error('The number of parts must be 1 to 64');
  const at = (q, top_) => (top_ ? add3(add3(o, mul3(d, h)), add3(mul3(X, q[0] + off[0]), mul3(Y, q[1] + off[1]))) : add3(o, add3(mul3(X, q[0]), mul3(Y, q[1]))));
  const circ = (e, th) => [e.r * Math.cos(th), e.r * Math.sin(th)];
  const out = [];
  if (bot.kind === 'round' && top.kind === 'round') {
    const step = Math.max(2, Math.ceil(div / N)), D = TAU2 / N;
    const gB = Math.max(gap, N === 1 ? 0.02 : 0) / 2 / bot.r, gT = Math.max(gap, N === 1 ? 0.02 : 0) / 2 / top.r;
    for (let j = 0; j < N; j++) {
      const A = [], B = [];
      for (let i = 0; i <= step; i++) {
        const k = i / step;
        A.push(at(circ(bot, seamAngle + j * D + gB + k * (D - 2 * gB)), false));
        B.push(at(circ(top, seamAngle + j * D + gT + k * (D - 2 * gT)), true));
      }
      out.push({ A, B, breaks: [] });
    }
    return out;
  }
  // a polygon end: N must divide its sides (so the parts are the same)
  const P = bot.kind === 'poly' ? bot : top, M = P.M;
  if (N < 2) throw new Error('A transition with a polygon end is made of two or more parts (welded together)');
  if (M % N) {
    const ok = Array.from({ length: M - 1 }, (_, i) => i + 2).filter((k) => !(M % k));
    throw new Error(`This end has ${M} sides: it splits into ${ok.join(' or ')} equal parts`);
  }
  const ring = []; // { a: bottom 2D, b: top 2D, site, brk }
  const mid = (E, k) => { const c0 = E.corners[k], c1 = E.corners[(k + 1) % E.M]; return [(c0[0] + c1[0]) / 2, (c0[1] + c1[1]) / 2]; };
  if (bot.kind === 'poly' && top.kind === 'poly') {
    if (bot.M !== top.M) throw new Error('Both polygon ends need the same number of sides');
    for (let k = 0; k < M; k++) {
      ring.push({ a: mid(bot, k), b: mid(top, k), site: 'mid' + k });
      ring.push({ a: bot.corners[(k + 1) % M], b: top.corners[(k + 1) % M], site: 'corner' + ((k + 1) % M), brk: true });
    }
  } else {
    const C = bot.kind === 'round' ? bot : top, polyBottom = bot.kind === 'poly';
    // the side normals, unwrapped so they increase round the polygon
    const psi = [P.psi[0]];
    for (let k = 1; k <= M; k++) psi.push(unwrapFrom(P.psi[k % M], psi[k - 1] + 1e-9));
    const pair = (pp, cp, extra) => ({ a: polyBottom ? pp : cp, b: polyBottom ? cp : pp, ...extra });
    for (let k = 0; k < M; k++) {
      const c1 = P.corners[(k + 1) % M], a0 = psi[k], a1 = psi[k + 1];
      ring.push(pair(mid(P, k), circ(C, a0), { site: 'mid' + k }));
      ring.push(pair(c1, circ(C, a0), { brk: true }));
      // the corner's fan, to the arc of the round end between the two sides' tangent points
      let nf = Math.max(2, Math.ceil((div * (a1 - a0)) / (Math.PI / 2) - 1e-6));
      if (nf % 2) nf++;
      for (let i = 1; i < nf; i++) ring.push(pair(c1, circ(C, a0 + ((a1 - a0) * i) / nf), i === nf / 2 ? { site: 'corner' + ((k + 1) % M) } : {}));
      ring.push(pair(c1, circ(C, a1), { brk: true }));
    }
  }
  const L = ring.length;
  const first = (seamShift ? 1 : 0);
  const cuts = Array.from({ length: N }, (_, j) => {
    const k = (first + (j * M) / N) % M;
    const i = ring.findIndex((r) => r.site === (seamAt === 'corner' ? 'corner' : 'mid') + k);
    if (i < 0) throw new Error('A seam could not be placed');
    return i;
  });
  for (let j = 0; j < N; j++) {
    const i0 = cuts[j];
    let i1 = cuts[(j + 1) % N];
    if (i1 <= i0) i1 += L;
    const sts = [];
    for (let i = i0; i <= i1; i++) sts.push(ring[i % L]);
    const A = sts.map((r) => at(r.a, false)), B = sts.map((r) => at(r.b, true));
    const breaks = sts.map((r, i) => (r.brk && i > 0 && i < sts.length - 1 ? i : -1)).filter((i) => i > 0);
    out.push({ A, B, breaks });
  }
  return out;
}

// ------------------------------------------------------------ convert to sheet metal
// A solid that is a sheet of even thickness (e.g. a sheet metal part read from a STEP file): starting
// from the picked flat face, follow that side of the sheet across every smooth edge, through flat faces
// and cylindrical bend faces, and across sharp edges to flat faces that have the sheet's other side
// behind them (sharp-cornered sheets). Each bend face (one or more cylindrical faces on one axis) joins
// two flat faces and becomes a bend with its own radius and angle; sharp edges become bends of radius R0.
const vec3 = (v) => (Array.isArray(v) ? v : v.toTuple ? v.toTuple() : [v.x, v.y, v.z]);
function faceNormal(face, p) {
  const v = p ? face.normalAt(p) : face.normalAt();
  const n = unit3(vec3(v));
  v.delete?.();
  return n;
}
function cylinderOf(face) {
  const ad = new (oc().BRepAdaptor_Surface)(face.wrapped, false);
  try {
    const c = ad.Cylinder(), ax = c.Axis(), L = ax.Location(), D = ax.Direction();
    return { o: [L.X(), L.Y(), L.Z()], d: unit3([D.X(), D.Y(), D.Z()]), r: c.Radius() };
  } finally { ad.delete(); }
}
// t / Rset: a thickness / an inside bend radius to use instead of the body's (null: the body's own)
// (a sheet the ordinary way can't take, as a closed tube or a bend with no relief: unrolled instead, when it can be)
const UNROLL_INSTEAD = /material on one side only|needs a relief|closes on itself/;
export function fromSolid(solid, picked, opts) {
  try {
    return fromSolidAs(solid, picked, opts);
  } catch (e) {
    if (!UNROLL_INSTEAD.test(e?.message || '') || opts.Rset != null) throw e;
    try { return fromSolidAs(solid, picked, { ...opts, develop: true }); } catch { throw e; }
  }
}
function fromSolidAs(solid, picked, { R: R0, K, t: tSet = null, Rset = null, develop = false }) {
  const info = solid.faces.map((face, i) => ({ i, face, type: face.geomType }));
  for (const F of info) if (F.type === 'PLANE') { F.n = faceNormal(F.face); F.c = vec3(F.face.center); }
  const i0 = info.findIndex((F) => F.face.isSame(picked));
  if (i0 < 0) throw new Error('Pick a face of the body');
  const P0 = info[i0];
  // the thickness: the nearest parallel face facing the other way, behind the picked face (a curved one: straight
  // through the sheet from the middle of the picked face, to the first face reached)
  let t = Infinity;
  if (P0.type === 'PLANE') {
    for (const q of info) {
      if (q.type !== 'PLANE' || dot3(q.n, P0.n) > -0.9999) continue;
      const d = dot3(sub3(P0.c, q.c), P0.n);
      if (d > 1e-6 && d < t) t = d;
    }
  } else {
    // (a point on the face itself: the middle of its surface may be in a hole)
    const UV = [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7], [0.3, 0.3], [0.7, 0.7], [0.3, 0.7], [0.7, 0.3], [0.15, 0.5], [0.85, 0.5]];
    const p = UV.map(([u, v]) => vec3(P0.face.pointOnSurface(u, v))).find((q) => distTo(P0.face, q) <= 1e-6);
    if (!p) throw new Error('No point found on the picked face to measure the thickness from');
    // (both ways along the normal: a face's normal may point either way out of its surface)
    const n = faceNormal(P0.face, p);
    for (const q of info) {
      if (q === P0) continue;
      const d = distTo(q.face, p);
      if (d > 1e-6 && d < t && [1, -1].some((sg) => distTo(q.face, add3(p, mul3(n, sg * d))) <= 1e-3 * d)) t = d;
    }
  }
  if (!isFinite(t)) throw new Error('No parallel face behind the picked face: is this a sheet of even thickness?');
  const tol = Math.max(1e-4, t * 1e-3);
  const tUse = tSet > 0 ? tSet : t; // (the body's own thickness still finds its sides)
  // which faces meet along which edges (an edge shared by two faces has the same midpoint and length)
  const keyOf = (m, L) => `${Math.round(m[0] * 1e4)},${Math.round(m[1] * 1e4)},${Math.round(m[2] * 1e4)},${Math.round(L * 1e4)}`;
  const byKey = new Map();
  for (const F of info) {
    F.edges = [];
    for (const e of F.face.edges) {
      const m = vec3(e.pointAt(0.5)), L = e.length;
      const ed = { e, m, L, line: e.geomType === 'LINE', key: keyOf(m, L) };
      F.edges.push(ed);
      if (!byKey.has(ed.key)) byKey.set(ed.key, []);
      byKey.get(ed.key).push(F);
    }
  }
  const across = (F) => F.edges.flatMap((ed) => (byKey.get(ed.key) || []).filter((G) => G !== F).map((G) => ({ G, ed })));
  const hasPartner = (x) => info.some((q) => q.type === 'PLANE' && q !== x && dot3(q.n, x.n) < -0.9999 && Math.abs(dot3(sub3(x.c, q.c), x.n) - t) < tol);
  // one side of the sheet: across smooth edges only when the sheet has real bends (an edge face can look
  // like a side face behind a sharp edge, e.g. a flange's end against the next flange at a closed corner);
  // across sharp edges too when it has none (a sharp-cornered sheet: every corner is a bend)
  const walk = (sharp) => {
    const side = new Set([P0]), queue = [P0];
    while (queue.length) {
      const F = queue.shift();
      for (const { G, ed } of across(F)) {
        if (side.has(G)) continue;
        let smooth = false;
        try { smooth = dot3(faceNormal(F.face, ed.m), faceNormal(G.face, ed.m)) > 0.9995; } catch { smooth = false; }
        if (smooth) {
          // (any other curved face: unrolled by developedSheet; curved both ways (a dished end), spread out as nearly
          // as it can be, its stretch reported)
        } else if (!(sharp && F.type === 'PLANE' && G.type === 'PLANE' && ed.line && hasPartner(G))) continue;
        side.add(G);
        queue.push(G);
      }
    }
    return side;
  };
  let side = walk(false);
  // curved faces other than plain bends (a square-to-round transition, a cone…), or a curved face picked: the side
  // unrolled as it is
  if (develop || P0.type !== 'PLANE' || [...side].some((F) => F.type !== 'PLANE' && F.type !== 'CYLINDRE')) {
    if (Rset != null) throw new Error('A sheet with curved faces other than plain bends keeps the body\'s own shape: use the body\'s bend radii');
    const sheet = developedSheet(solid, [...side].map((F) => F.face), P0, { t: tSet > 0 ? tSet : t, K });
    const curved = [...side].filter((F) => F.type !== 'PLANE').length;
    return { sheet, exact: tSet == null, detected: { kind: 'solid', t, radii: [], bends: 0, sharp: 0, developed: curved, ...(sheet.stretch ? { stretch: sheet.stretch } : {}) } };
  }
  if (![...side].some((F) => F.type === 'CYLINDRE')) side = walk(true);
  const planes = [...side].filter((F) => F.type === 'PLANE');
  const cyls = [...side].filter((F) => F.type === 'CYLINDRE');
  // bend faces: cylindrical faces on one axis with one radius
  const groups = [];
  for (const C of cyls) {
    const cy = cylinderOf(C.face);
    const g = groups.find((x) => Math.abs(Math.abs(dot3(x.cy.d, cy.d)) - 1) < 1e-6 && Math.abs(x.cy.r - cy.r) < tol
      && len3(cross3(sub3(cy.o, x.cy.o), x.cy.d)) < tol);
    if (g) g.faces.push(C); else groups.push({ cy, faces: [C] });
  }
  const groupOf = new Map(groups.flatMap((g) => g.faces.map((C) => [C, g])));
  // where a bend runs straight on into the next one (a rolled shape): a joint, a flat of no width
  const joints = new Map();
  const jointOf = (g, g2, C, ed) => {
    const key = [groups.indexOf(g), groups.indexOf(g2)].sort((x, y) => x - y).join('|');
    if (!joints.has(key)) joints.set(key, { joint: true, n: faceNormal(C.face, ed.m) });
    return joints.get(key);
  };
  const links = [];
  for (const g of groups) {
    const { o, d, r } = g.cy;
    // inside or outside of the bend: the side's normal points to the axis on the inside
    const C = g.faces[0], m = C.edges[0].m;
    const rad = sub3(sub3(m, o), mul3(d, dot3(sub3(m, o), d)));
    const outer = dot3(faceNormal(C.face, m), rad) > 0;
    const Rb = outer ? r - t : r; // its inside radius in the body
    if (!(Rb > -tol)) throw new Error('A bend is tighter on its inside than the sheet is thick: it cannot be unfolded');
    // the radius used: the one set, or the body's (the picked side stays where it is: on the outside of a
    // bend, a thickness set instead of the body's changes the inside radius)
    const Ru = Rset ?? (outer ? r - tUse : r);
    if (!(Ru > -tol)) throw new Error(`With a thickness of ${+tUse.toFixed(4)} mm a bend's inside radius (R${+r.toFixed(4)} outside) would be below zero: use a thinner sheet or set the bend radius`);
    // what it joins (flat faces, or the next bend), and where: its straight edges along the axis
    const touch = new Map();
    for (const Cf of g.faces) {
      for (const { G, ed } of across(Cf)) {
        if (!side.has(G) || !ed.line) continue;
        const a = vec3(ed.e.pointAt(0)), b = vec3(ed.e.pointAt(1));
        if (Math.abs(Math.abs(dot3(unit3(sub3(b, a)), d)) - 1) > 1e-4) continue;
        let node = G;
        if (G.type === 'CYLINDRE') {
          const g2 = groupOf.get(G);
          if (!g2 || g2 === g) continue; // a seam inside the bend
          node = jointOf(g, g2, Cf, ed);
        }
        if (!touch.has(node)) touch.set(node, []);
        touch.get(node).push(a, b);
      }
    }
    if (touch.size !== 2) {
      throw new Error(touch.size > 2 ? 'A bend joins more than two faces: it cannot be unfolded'
        : 'A bend has material on one side only (a closed tube, or a bend at the edge of the part): it cannot be unfolded');
    }
    const ends = [...touch.entries()].map(([G, pts]) => {
      const q = pts[0], s = pts.map((p) => dot3(sub3(p, q), d));
      return { G, a: add3(q, mul3(d, Math.min(...s))), b: add3(q, mul3(d, Math.max(...s))) };
    });
    links.push({ i: ends[0].G, j: ends[1].G, ai: ends[0].a, bi: ends[0].b, aj: ends[1].a, bj: ends[1].b, axis: { o, d }, R: Math.max(Ru, 0), Rbody: Math.max(Rb, 0), outer, faces: g.faces.map((x) => x.face) });
  }
  const faces = planes.map((F) => ({ face: F.face, n: F.n }));
  const jl = [...joints.values()];
  const idx = new Map([...planes.map((F, k) => [F, k]), ...jl.map((J, k) => [J, planes.length + k])]);
  for (const L of links) { L.i = idx.get(L.i); L.j = idx.get(L.j); }
  const radius = Rset ?? (links.length ? links[0].R : R0);
  let sheet = fromFaces(faces, idx.get(P0), { t: tUse, R: Rset ?? R0, K, connectedOnly: true, links, joints: jl.map((J) => ({ n: J.n })) });
  // what the body has (shown in the feature's panel): its thickness, the inside radii of its bends, and
  // how many sharp edges became bends
  const radii = [];
  for (const L of links) if (!radii.some((x) => Math.abs(x - L.Rbody) < tol)) radii.push(L.Rbody);
  const sharp = sheet.bends.length - links.length;
  const detected = { kind: 'solid', t, radii, bends: links.length, sharp };
  // exact: the body's own thickness and bends throughout, so the sheet should hold just the body's material
  const exact = !sharp && tSet == null && Rset == null;
  // (corners closed by RazorCAD itself: made again exactly as it made them, when the body is one of its own)
  const own = exact ? exactCorners(sheet, solid) : null;
  if (own) { sheet = own; detected.corners = own.corners.length; }
  return { sheet: { ...sheet, R: radius }, exact, detected };
}

// Closed corners as RazorCAD makes them (Edge Flange's and Closed Corner's), converted exactly. A body that was
// folded by RazorCAD comes out of the conversion with each corner bend ending short of the corner point by the V
// cutout's relief (or at it: a closed mitre or butt corner) and its wall running on past it as the corner made it.
// From those each corner is worked out (which wall covers the other's end, or both mitred; the gap), its bends
// lengthened to the corner point and formed as usual (no zone of their own), the corner closed as closedCorner
// closes it. Kept only when the folded solid is the body (its volume, area and box); else null, and the corners
// stay as traced from the body. (Folded with faces a millionth of a mm from one plane taken as one: a STEP file moves
// the walls by a ten-millionth, which would leave a seam where a butt corner's mitred run-on joins its wall.)
const CORNER_TOL = 1e-4;
// (volume and area to 3 parts in a million: OpenCascade's measure of a curved corner's B-spline faces is no closer;
// a corner made with a gap 0.01 mm off differs ten times as much)
const EXACT_TOL = 3e-6;
export function exactCorners(sheet, solid) {
  const t = sheet.t;
  const pairs = cornerPairs(sheet).filter(({ A, B }) => A.zone && B.zone && A.up === B.up && Math.abs(A.R - B.R) < 1e-9
    && Math.abs(A.ang - Math.PI / 2) < 1e-3 && Math.abs(B.ang - Math.PI / 2) < 1e-3 && Math.abs(d2(A.e, B.d)) > 0.999 && Math.abs(d2(B.e, A.d)) > 0.999);
  if (!pairs.length) return null;
  const fs = facesOf(sheet.region);
  // a bend lengthened to the corner point Q at its corner end (it ends short of it by the relief)
  const toQ = (b, X, Q) => {
    const atEnd = d2(s2(X, b.p0), b.e) > b.w / 2;
    const dq = atEnd ? d2(s2(Q, b.p0), b.e) - b.w : -d2(s2(Q, b.p0), b.e);
    return { dq, atEnd, b: atEnd ? { ...b, w: b.w + dq } : { ...b, p0: a2(b.p0, m2(b.e, -dq)), w: b.w + dq } };
  };
  // how far a bend's wall runs on past the bend's corner end (measured half way up the wall)
  const runOn = (b, atEnd) => {
    const h = wallHeight(sheet.region, b);
    if (!(h > 1e-6)) return null;
    const Pe = a2(b.p0, m2(b.e, atEnd ? b.w : 0)), dir = m2(b.e, atEnd ? 1 : -1), at = (x) => a2(a2(Pe, m2(dir, x)), m2(b.d, b.ba + h / 2));
    if (!faceAt(fs, at(-1e-4))) return null;
    let lo = -1e-4, hi = 4 * (b.R + t) + 10;
    if (faceAt(fs, at(hi))) return null;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (faceAt(fs, at(m))) lo = m; else hi = m; }
    return { ext: Math.max(0, lo), h, Pe, dir };
  };
  const bends = new Map(sheet.bends.map((b) => [b.id, b]));
  const found = [];
  for (const pr of pairs) {
    const Q = cornerUV(pr.A, pr.B)?.(0, 0);
    if (!Q) return null;
    const a = toQ(bends.get(pr.A.id), pr.X, Q), b = toQ(bends.get(pr.B.id), pr.X, Q);
    if (a.dq < -CORNER_TOL || b.dq < -CORNER_TOL || Math.abs(a.dq - b.dq) > CORNER_TOL) return null;
    const A = a.b, B = b.b, wa = runOn(A, a.atEnd), wb = runOn(B, b.atEnd);
    if (!wa || !wb) return null;
    // the walls' ends as closedCorner puts them: to the other's outer face (covering its end), or its inner face
    const reach = (w, O, extra) => (O.R + extra - d2(s2(w.Pe, O.p0), O.d)) / d2(w.dir, O.d);
    const outerA = reach(wa, B, t), innerA = reach(wa, B, 0), outerB = reach(wb, A, t), innerB = reach(wb, A, 0);
    let rec = null;
    if (Math.abs(wa.ext - outerA) < CORNER_TOL && innerB - wb.ext > -CORNER_TOL) rec = { A, B, gap: Math.max(0, innerB - wb.ext), type: 'overlap' };
    else if (Math.abs(wb.ext - outerB) < CORNER_TOL && innerA - wa.ext > -CORNER_TOL) rec = { A: B, B: A, gap: Math.max(0, innerA - wa.ext), type: 'overlap' };
    else if (Math.abs((innerA - wa.ext) - (innerB - wb.ext)) < CORNER_TOL && Math.abs(a.dq) < CORNER_TOL && innerA - wa.ext > -CORNER_TOL) rec = { A, B, gap: Math.max(0, innerA - wa.ext) * Math.SQRT2, type: 'square' };
    else if (Math.abs((innerA - wa.ext) - (innerB - wb.ext)) < CORNER_TOL && innerA + t - wa.ext > -CORNER_TOL) rec = { A, B, gap: Math.max(0, innerA + t - wa.ext) * Math.SQRT2, type: 'butt' };
    if (!rec) return null;
    rec.gap = Math.round(rec.gap * 1e5) / 1e5;
    // a V cutout: the bends end short of the corner point by its relief; a closed mitre, butt or square corner: at it
    const atQ = rec.type === 'butt' || rec.type === 'square';
    rec.bend = atQ ? 'vcut' : a.dq > CORNER_TOL ? 'vcut' : 'mitre';
    if (!atQ && rec.bend === 'vcut' && Math.abs(a.dq - vcutRelief(t, rec.gap)) > CORNER_TOL) return null;
    if (atQ && a.dq > CORNER_TOL) return null;
    rec.ha = (rec.A === A ? wa : wb).h; rec.hb = (rec.A === A ? wb : wa).h;
    found.push(rec);
    bends.set(A.id, A); bends.set(B.id, B);
  }
  // (a bend at two corners: lengthened at both ends, its final version used for both)
  for (const c of found) { c.A = bends.get(c.A.id); c.B = bends.get(c.B.id); }
  // each corner as closedCorner closes it: how far each wall runs on in the flat (to the other's outer face, or its
  // inner face less the gap; a butt or square corner's both to the inner face less the mitre's share of the gap)
  const records = found.map((c) => {
    const Q = cornerUV(c.A, c.B)(0, 0);
    const end = (b) => { const atEnd = d2(s2(Q, b.p0), b.e) > b.w / 2; return { Pe: a2(b.p0, m2(b.e, atEnd ? b.w : 0)), dir: m2(b.e, atEnd ? 1 : -1) }; };
    const ea = end(c.A), eb = end(c.B), c45 = c.gap / Math.SQRT2, butt = c.type === 'butt', both = butt || c.type === 'square';
    const extA = (c.B.R + (both ? 0 : t) - d2(s2(ea.Pe, c.B.p0), c.B.d)) / d2(ea.dir, c.B.d) - (both ? c45 : 0);
    const extB = (c.A.R - d2(s2(eb.Pe, c.A.p0), c.A.d)) / d2(eb.dir, c.A.d) - (both ? c45 : c.gap);
    return { c, ea, eb, extA, extB, rec: { a: c.A.id, b: c.B.id, gap: c.gap, type: c.type, bend: c.bend, ea: extA, eb: extB, ...(butt ? { ha: c.ha, hb: c.hb } : {}) } };
  });
  // the corner bends formed as usual, over their strips: the pattern without their traced zones, with the strips;
  // the panel's corner filled where the V cutout's round took it away (the round is made again when folding); a butt
  // corner's walls cut back to where the flat pattern ends them (the mitred rest is added when folding)
  let region = sheet.region.clone();
  const done = new Set();
  for (const { c, ea, eb, extA, extB } of records) {
    for (const bd of [c.A, c.B]) {
      if (done.has(bd.id)) continue;
      done.add(bd.id);
      const old = sheet.bends.find((x) => x.id === bd.id);
      region = bop('cut', region, old.zone.clone());
      const { zone: _z, ...plain } = bd;
      bends.set(bd.id, plain);
      region = bop('fuse', region, stripFace(bd));
    }
    if (c.type === 'butt') {
      for (const [bd, e, ext, h] of [[c.A, ea, extA, c.ha], [c.B, eb, extB, c.hb]]) {
        region = bop('cut', region, rectFace(a2(a2(e.Pe, m2(e.dir, ext)), m2(bd.d, bd.ba)), e.dir, bd.d, 4 * (bd.R + t) + 10, h + 1));
      }
    } else if (c.bend === 'vcut' && c.type !== 'square') {
      const at = cornerUV(c.A, c.B), s = 2 * vcutRelief(t, c.gap) + t;
      region = bop('fuse', region, polyFace([at(0, 0), at(-s, 0), at(-s, -s), at(0, -s)]));
    }
  }
  // (the pattern's faces that meet merged: each panel one face, folded in one piece)
  const merged = clean(region);
  if (merged !== region) { free(region); region = merged; }
  // (folded with faces within a millionth of a mm of one plane taken as one: the pattern's walls came from the body)
  const out = { ...sheet, bends: sheet.bends.map((b) => bends.get(b.id)), region, corners: [...(sheet.corners || []), ...records.map((r) => r.rec)], tidyTol: 1e-6 };
  // kept only when it folds into the body: the same volume and area (EXACT_TOL) and box (a boolean between the two
  // would be no test: on faces that lie on each other it goes wrong)
  let sol = null;
  try {
    sol = toSolid(out);
    const v0 = R.measureVolume(solid), v1 = R.measureVolume(sol), A0 = R.measureArea(solid), A1 = R.measureArea(sol);
    const b0 = solid.boundingBox.bounds, b1 = sol.boundingBox.bounds;
    if (!(Math.abs(v1 - v0) <= EXACT_TOL * v0) || !(Math.abs(A1 - A0) <= EXACT_TOL * A0)) return null;
    if (!b0.every((p, i) => p.every((x, k) => Math.abs(x - b1[i][k]) <= 1e-5))) return null;
    return out;
  } catch { return null; } finally { free(sol); }
}

// ------------------------------------------------------------ developed sheets: any one-way curved shape unrolled
// A sheet whose curved faces are not all plain bends (a square-to-round transition, a cone, a twisted strip…), as
// a body converted from another program has them: its side (the faces found from the picked one) is meshed finely,
// moved to the neutral layer (K·t from the inside of the curves) and laid out flat triangle by triangle, each
// edge keeping its length. Where the shape closes on itself (a ring) the triangles meet again out of place: there
// the pattern is cut (a seam). A face curved both ways (a dished end) can't be laid flat exactly: it is spread out on
// its best plane and relaxed so every edge of the mesh keeps its length as nearly as it can (dishedFlat), and the
// largest stretch is reported (sheet.stretch). The sheet is
// marked like a lofted bend (lofted.method 'developed'), so features that need real bends refuse it; folded, it is
// the body itself, and its flat pattern is the unrolled outline with its holes.
const DEV_TOL = 1e-5; // × the part's size: the mesh's largest distance from a curved face
const DEV_DEFECT = 4e-3; // rad: more than this short of a full turn round a point of the mesh, a face is curved both ways
const DEV_CRACK = 0.1; // mm: a loop of the outline narrower than this on average is no cut-out (see below)
// A mesh curved both ways laid out flat as nearly as it can be (scaled at the end to the same area: a pressed dish keeps
// its volume), as Flatten Surface does it: projected onto its best
// plane (square to its average normal, weighted by area), then relaxed, edge by edge, each pulled towards its length
// on the sheet (half the error each end), 400 passes, once at full strength and once damped; of all the layouts met
// (the projection and every 25 passes) the one with the least length change (root mean square, and the worst) and
// nothing folded over is kept.
// Returns { xy (per point), maxStrain (the largest edge length change, a fraction), area (flat / curved), rms, flip }.
function dishedFlat(P, T, Mn, edges) {
  let n = [0, 0, 0], a3 = 0, c3 = [0, 0, 0];
  for (const tri of T) {
    const c = cross3(sub3(P[tri[1]], P[tri[0]]), sub3(P[tri[2]], P[tri[0]])), a = len3(c) / 2;
    a3 += a; c3 = add3(c3, mul3(add3(add3(P[tri[0]], P[tri[1]]), P[tri[2]]), a / 3));
    n = add3(n, dot3(c, add3(add3(Mn[tri[0]], Mn[tri[1]]), Mn[tri[2]])) < 0 ? mul3(c, -1) : c);
  }
  n = unit3(n); c3 = mul3(c3, 1 / a3);
  const u = unit3(cross3(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), v = cross3(n, u);
  const proj = () => P.map((p) => { const d = sub3(p, c3); return [dot3(d, u), dot3(d, v)]; });
  // (a dish is nearly always turned round an axis: the second start lays each point at its distance along the dish's
  // profile from the middle, at its angle round the axis (azimuthal equidistant): lengths out from the middle exact,
  // those round it a little long, θ / sin θ at an angle θ off the axis)
  const equidistant = () => {
    const pr = P.map((p) => { const d = sub3(p, c3); return [dot3(d, u), dot3(d, v), dot3(d, n)]; });
    let ix = 0; pr.forEach((q, i) => { if (Math.hypot(q[0], q[1]) < Math.hypot(pr[ix][0], pr[ix][1])) ix = i; });
    const o = pr[ix], rho = pr.map((q) => Math.hypot(q[0] - o[0], q[1] - o[1])), rmax = Math.max(...rho), B = 200, sum = new Float64Array(B + 1), cnt = new Float64Array(B + 1);
    pr.forEach((q, i) => { const k = Math.round((rho[i] / rmax) * B); sum[k] += q[2]; cnt[k]++; });
    const hs = []; for (let k = 0; k <= B; k++) if (cnt[k]) hs.push([(k / B) * rmax, sum[k] / cnt[k]]);
    const arc = [0]; for (let k = 1; k < hs.length; k++) arc.push(arc[k - 1] + Math.hypot(hs[k][0] - hs[k - 1][0], hs[k][1] - hs[k - 1][1]));
    const sAt = (r) => { let k = 1; while (k < hs.length - 1 && hs[k][0] < r) k++; const f = (r - hs[k - 1][0]) / ((hs[k][0] - hs[k - 1][0]) || 1); return arc[k - 1] + f * (arc[k] - arc[k - 1]) + (k === 1 && r < hs[0][0] ? r - hs[0][0] : 0); };
    return pr.map((q, i) => { const r = rho[i]; if (r < 1e-12) return [0, 0]; const sc = sAt(r) / r; return [(q[0] - o[0]) * sc, (q[1] - o[1]) * sc]; });
  };
  const E = [];
  for (const e of edges.keys()) { const a = Math.floor(e / 4294967296), b = e % 4294967296; E.push([a, b, len3(sub3(P[a], P[b]))]); }
  const turn = (xy, tri) => { const [A, B, C] = tri.map((i) => xy[i]); return ((B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1])) / 2; };
  // (triangles with no area on the sheet, as at a pole, where the mesh repeats a point: never folded, never a test)
  const real = T.filter((tri) => tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2] && len3(cross3(sub3(P[tri[1]], P[tri[0]]), sub3(P[tri[2]], P[tri[0]]))) > 1e-9 * a3);
  // (the largest stretch over edges of a fair length: a quarter of the median and more; slivers, as in the fan of
  // triangles at a dish's pole, say nothing of the sheet)
  const fair = [...E.map((e) => e[2])].sort((x, y) => x - y)[E.length >> 1] / 4;
  const score = (xy) => {
    let rms = 0, mx = 0, pos = 0, neg = 0;
    for (const [a, b, L] of E) { const st = Math.abs(Math.hypot(xy[b][0] - xy[a][0], xy[b][1] - xy[a][1]) - L) / (L || 1); rms += st * st; if (L >= fair) mx = Math.max(mx, st); }
    for (const tri of real) { const ar = turn(xy, tri); if (ar >= 0) pos += ar; else neg -= ar; }
    const flip = Math.min(pos, neg) / ((pos + neg) || 1);
    rms = Math.sqrt(rms / E.length);
    // (and the worst stretch counts: a layout crushed in one place loses to one a little worse on average)
    return { rms, mx, flip, area: (pos + neg) / a3, s: rms + 3 * flip + 0.25 * mx };
  };
  let best = null;
  for (const [start, damp] of [[proj, 1], [proj, 0.35], [equidistant, 1], [equidistant, 0.35]]) {
    const xy = start();
    { const sc = score(xy); if (!best || sc.s < best.s) best = { ...sc, xy: xy.map((q) => [...q]) }; }
    for (let it = 0; it < 400; it++) {
      let worst = 0;
      for (const [a, b, L] of E) {
        const dx = xy[b][0] - xy[a][0], dy = xy[b][1] - xy[a][1], d = Math.hypot(dx, dy) || 1e-12, k = ((d - L) / d / 2) * damp;
        worst = Math.max(worst, Math.abs(d - L) / (L || 1));
        xy[a][0] += dx * k; xy[a][1] += dy * k; xy[b][0] -= dx * k; xy[b][1] -= dy * k;
      }
      if (worst < 1e-7 || (it + 1) % 25 === 0) {
        const sc = score(xy);
        if (sc.s < best.s) best = { ...sc, xy: xy.map((q) => [...q]) };
        if (worst < 1e-7) break;
      }
    }
  }
  // (untangled: a point of a triangle folded over moves to the middle of its neighbours, until none is; a few at a
  // crowded point, such as a dish's pole)
  const xy = best.xy, nb = P.map(() => []);
  for (const [a, b] of E) { nb[a].push(b); nb[b].push(a); }
  const sgn = real.reduce((x, tri) => x + turn(xy, tri), 0) >= 0 ? 1 : -1;
  for (let it = 0; it < 200; it++) {
    const bad = new Set();
    for (const tri of real) if (sgn * turn(xy, tri) <= 0) for (const i of tri) bad.add(i);
    if (!bad.size) break;
    for (const i of bad) if (nb[i].length) { let x = 0, y = 0; for (const j of nb[i]) { x += xy[j][0]; y += xy[j][1]; } xy[i] = [x / nb[i].length, y / nb[i].length]; }
  }
  // (scaled evenly to the dish's own area: pressed, the sheet keeps its volume, so the blank has the dish's area)
  { const k = Math.sqrt(1 / score(xy).area); for (const q of xy) { q[0] *= k; q[1] *= k; } }
  const sc = score(xy);
  // (the stretch 98 % of the mesh stays within: a few edges at a crowded point, as a pole, where the mesh's normals
  // are poor, say nothing of the sheet)
  const st = E.filter((e) => e[2] >= fair).map(([a, b, L]) => Math.abs(Math.hypot(xy[b][0] - xy[a][0], xy[b][1] - xy[a][1]) / L - 1)).sort((x, y) => x - y);
  return { xy, maxStrain: st[Math.min(st.length - 1, Math.floor(st.length * 0.98))] ?? sc.mx, area: sc.area, flip: sc.flip, rms: sc.rms };
}
export function developedSheet(solid, faces, P0, { t, K, coarse = false }) {
  const O = oc();
  const builder = new O.TopoDS_Builder(), comp = new O.TopoDS_Compound();
  builder.MakeCompound(comp);
  for (const f of faces) builder.Add(comp, f.wrapped);
  builder.delete();
  const side = R.cast(comp);
  const kind = new Map(faces.map((f) => [f.hashCode, f.geomType]));
  // (meshed as one: each edge divided once, for both its faces; finer for a small part, about a hundred-thousandth
  // of its size, 0.005 to 0.05 mm)
  const bb = solid.boundingBox.bounds, size = Math.hypot(bb[1][0] - bb[0][0], bb[1][1] - bb[0][1], bb[1][2] - bb[0][2]);
  // (curved both ways: meshed again more coarsely, about a thousandth of its size, so relaxing it can spread out)
  const m = side.mesh(coarse ? { tolerance: Math.max(0.05, size * 1e-3), angularTolerance: 0.1 } : { tolerance: Math.min(0.05, Math.max(0.005, size * DEV_TOL)), angularTolerance: 0.05 });
  const gs = m.faceGroups.reduce((n, g) => n + g.count, 0) === m.triangles.length ? 1 : 3;
  // the points of the mesh, each once (a point on an edge is in both its faces' meshes)
  const key = (i) => `${Math.round(m.vertices[3 * i] * 1e5)},${Math.round(m.vertices[3 * i + 1] * 1e5)},${Math.round(m.vertices[3 * i + 2] * 1e5)}`;
  const idx = new Map(), V = [], N = [];
  const at = new Int32Array(m.vertices.length / 3);
  for (let i = 0; i < at.length; i++) {
    const k = key(i);
    let j = idx.get(k);
    if (j === undefined) { j = V.length; idx.set(k, j); V.push([m.vertices[3 * i], m.vertices[3 * i + 1], m.vertices[3 * i + 2]]); N.push([0, 0, 0]); }
    at[i] = j;
    for (let c = 0; c < 3; c++) N[j][c] += m.normals[3 * i + c];
  }
  // the material side: against the faces' outward normals
  const Mn = N.map((n) => mul3(unit3(n), -1));
  const T = [], curvedTri = [], fixedTri = [], triFace = [];
  for (const g of m.faceGroups) {
    const ty = kind.get(g.faceId), fixed = g.faceId === P0.face.hashCode;
    for (let q = g.start * gs; q < (g.start + g.count) * gs; q += 3) {
      const tri = [at[m.triangles[q]], at[m.triangles[q + 1]], at[m.triangles[q + 2]]];
      if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
      if (fixed) fixedTri.push(T.length);
      curvedTri.push(ty !== 'PLANE');
      triFace.push(g.faceId);
      T.push(tri);
    }
  }
  if (!fixedTri.length) throw new Error('The picked face was not found in the sheet');
  // the neutral layer: K·t from the inside of the curves, the inside found for each face (where moving into the
  // material makes it longer): a square-to-round's cone and the bends of its rims curve opposite ways, so one side
  // for the whole sheet put the layer on the wrong side of one of them. A face curving both ways along it (a twisted
  // blade) takes its overall side, as the whole sheet did; a point on an edge between faces curving opposite ways
  // takes the mean of theirs.
  const area3 = (a, b, c) => { const u = sub3(b, a), v = sub3(c, a); return len3(cross3(u, v)) / 2; };
  const faceGrow = new Map();
  T.forEach((tri, k) => {
    if (!curvedTri[k]) return;
    const p = tri.map((i) => V[i]), q = tri.map((i) => add3(V[i], mul3(Mn[i], 1e-3)));
    const dA = area3(...q) - area3(...p);
    if (Number.isFinite(dA)) faceGrow.set(triFace[k], (faceGrow.get(triFace[k]) || 0) + dA);
  });
  const sideSum = new Float64Array(V.length), sideN = new Float64Array(V.length);
  T.forEach((tri, k) => {
    if (!curvedTri[k]) return;
    const g = faceGrow.get(triFace[k]) || 0, sgn = g > 0 ? 1 : g < 0 ? -1 : 0;
    for (const i of tri) { sideSum[i] += sgn; sideN[i]++; }
  });
  const P = V.map((v, i) => { const sgn = sideN[i] ? sideSum[i] / sideN[i] : 0; return add3(v, mul3(Mn[i], t * (0.5 + (K - 0.5) * sgn))); });
  // edges → their triangles
  const ek = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
  const edges = new Map();
  T.forEach((tri, k) => { for (let s = 0; s < 3; s++) { const e = ek(tri[s], tri[(s + 1) % 3]); const l = edges.get(e); if (l) l.push(k); else edges.set(e, [k]); } });
  for (const l of edges.values()) if (l.length > 2) throw new Error('The sheet\'s faces meet more than two at an edge: it cannot be unrolled');
  // curved one way only? (round a point inside the mesh its triangles' corners add up to a full turn)
  const angSum = new Float64Array(V.length), inner = new Uint8Array(V.length).fill(1);
  for (const [e, l] of edges) if (l.length === 1) { inner[Math.floor(e / 4294967296)] = 0; inner[e % 4294967296] = 0; }
  // (the mesh can fold back over itself in a few slivers, near a trimmed edge of a face: a triangle turned against
  // the surface's own normal there; the corners round it are no test of the shape)
  const facing = T.map((tri) => dot3(cross3(sub3(V[tri[1]], V[tri[0]]), sub3(V[tri[2]], V[tri[0]])), add3(add3(N[tri[0]], N[tri[1]]), N[tri[2]])));
  const flipSign = facing.filter((x) => x < 0).length > T.length / 2 ? -1 : 1;
  T.forEach((tri, k) => { if (flipSign * facing[k] <= 0) for (const i of tri) inner[i] = 0; });
  const ang = (a, b, c) => { const u = unit3(sub3(b, a)), v = unit3(sub3(c, a)); return Math.acos(Math.max(-1, Math.min(1, dot3(u, v)))); };
  // (of the sheet's own side: the shape's test; the neutral layer, moved by different amounts where the curves turn the
  // other way, is a hair off developable there)
  for (const tri of T) for (let s = 0; s < 3; s++) angSum[tri[s]] += ang(V[tri[s]], V[tri[(s + 1) % 3]], V[tri[(s + 2) % 3]]);
  // (the worst point, and the whole: on a fine mesh of a gently curved dish each point is only a little short, but
  // together they add up to the dish's whole curvature, e.g. 1.47 rad for a sphere cap 40° round)
  let worst = 0, total = 0;
  for (let i = 0; i < V.length; i++) if (inner[i]) { const d = Math.abs(2 * Math.PI - angSum[i]); worst = Math.max(worst, d); total += d; }
  const both = worst > DEV_DEFECT || total > 25 * DEV_DEFECT || faces.some((f) => ['SPHERE', 'TORUS'].includes(f.geomType));
  // (curved both ways: spread out and relaxed, not unrolled; the outline is then one piece, no seams)
  if (both && !coarse) return developedSheet(solid, faces, P0, { t, K, coarse: true });
  const dished = both ? dishedFlat(P, T, Mn, edges) : null;
  // laid out flat, from the picked face (flat: in its own plane, so the flat pattern lies under it; curved: from one
  // of its triangles, in that triangle's plane), triangle by triangle
  const t0 = T[fixedTri[0]];
  let n0 = unit3(cross3(sub3(P[t0[1]], P[t0[0]]), sub3(P[t0[2]], P[t0[0]])));
  if (dot3(n0, Mn[t0[0]]) < 0) n0 = mul3(n0, -1);
  const fr = planeFrame(P[t0[0]], kind.get(P0.face.hashCode) === 'PLANE' ? Mn[t0[0]] : n0);
  const proj = (p) => { const d = sub3(p, fr.o); return [dot3(d, fr.u), dot3(d, fr.v)]; };
  const C = new Array(T.length).fill(null); // per triangle: its three corners flat
  const queue = [];
  if (dished) {
    // (turned and moved onto the sheet's frame by the picked triangle's first edge: as the triangles would start)
    const [i0, i1] = T[fixedTri[0]], A = dished.xy[i0], B = dished.xy[i1], A2 = proj(P[i0]), B2 = proj(P[i1]);
    const th = Math.atan2(B2[1] - A2[1], B2[0] - A2[0]) - Math.atan2(B[1] - A[1], B[0] - A[0]), c = Math.cos(th), sn = Math.sin(th);
    const to = (q) => { const x = q[0] - A[0], y = q[1] - A[1]; return [A2[0] + c * x - sn * y, A2[1] + sn * x + c * y]; };
    T.forEach((tri, k) => { C[k] = tri.map((i) => to(dished.xy[i])); });
  }
  else for (const k of kind.get(P0.face.hashCode) === 'PLANE' ? fixedTri : fixedTri.slice(0, 1)) { C[k] = T[k].map((i) => proj(P[i])); queue.push(k); }
  for (let qi = 0; qi < queue.length; qi++) {
    const k = queue[qi], tri = T[k];
    for (let s = 0; s < 3; s++) {
      const a = tri[s], b = tri[(s + 1) % 3], o = tri[(s + 2) % 3];
      for (const j of edges.get(ek(a, b))) {
        if (j === k || C[j]) continue;
        const A = C[k][s], B = C[k][(s + 1) % 3], Oo = C[k][(s + 2) % 3];
        const tj = T[j], c = tj.find((x) => x !== a && x !== b);
        const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
        if (!(L > 1e-12)) continue;
        const da = len3(sub3(P[c], P[a])), db = len3(sub3(P[c], P[b]));
        const e = [(B[0] - A[0]) / L, (B[1] - A[1]) / L], nn = [-e[1], e[0]];
        const x = (da * da - db * db + L * L) / (2 * L), y = Math.sqrt(Math.max(0, da * da - x * x));
        const side0 = Math.sign((Oo[0] - A[0]) * nn[0] + (Oo[1] - A[1]) * nn[1]) || 1;
        const Cc = [A[0] + e[0] * x - nn[0] * y * side0, A[1] + e[1] * x - nn[1] * y * side0];
        C[j] = tj.map((v) => (v === a ? A : v === b ? B : Cc));
        queue.push(j);
      }
    }
  }
  if (C.some((x) => !x)) throw new Error('Part of the sheet is not joined to the picked face');
  // each point's places in the flat (one, or two or more along a seam), its triangles' corners each one of them
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const v of V) for (let c = 0; c < 3; c++) { if (v[c] < lo[c]) lo[c] = v[c]; if (v[c] > hi[c]) hi[c] = v[c]; }
  const diag2 = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  // (a point reached round different ways lands a few hundredths of a mm apart, from the mesh's own small errors:
  // one place, the average; the two sides of a seam are far further apart)
  const tau = Math.max(0.5, 5e-4 * diag2);
  const places = V.map(() => []), node = T.map(() => [0, 0, 0]), first = [], sum = [], cnt = [];
  T.forEach((tri, k) => tri.forEach((v, s) => {
    const p = C[k][s];
    let n = places[v].find((q) => Math.hypot(first[q][0] - p[0], first[q][1] - p[1]) <= tau);
    if (n === undefined) { n = first.length; first.push(p); sum.push([0, 0]); cnt.push(0); places[v].push(n); }
    sum[n][0] += p[0]; sum[n][1] += p[1]; cnt[n]++;
    node[k][s] = n;
  }));
  const nodeXY = sum.map((q, n) => [q[0] / cnt[n], q[1] / cnt[n]]);
  // the outline: edges with one triangle, and edges whose two triangles have them in different places (a seam)
  const segs = [];
  for (const [e, l] of edges) {
    const a = Math.floor(e / 4294967296), b = e % 4294967296;
    const nd = (k, v) => node[k][T[k].indexOf(v)];
    if (l.length === 2 && nd(l[0], a) === nd(l[1], a) && nd(l[0], b) === nd(l[1], b)) continue;
    for (const k of l) segs.push([nd(k, a), nd(k, b)]);
  }
  // chained into loops (by their points)
  const from = new Map();
  segs.forEach((sg, i) => { for (const p of sg) { const l = from.get(p); if (l) l.push(i); else from.set(p, [i]); } });
  const used = new Uint8Array(segs.length), loops = [];
  for (let i0 = 0; i0 < segs.length; i0++) {
    if (used[i0]) continue;
    used[i0] = 1;
    const first = segs[i0][0], loop = [first];
    let cur = segs[i0][1];
    for (let guard = 0; guard < segs.length && cur !== first; guard++) {
      loop.push(cur);
      const nx = (from.get(cur) || []).find((q) => !used[q]);
      if (nx === undefined) break;
      used[nx] = 1;
      cur = segs[nx][0] === cur ? segs[nx][1] : segs[nx][0];
    }
    if (loop.length >= 3) loops.push(loop.map((n) => nodeXY[n]));
  }
  if (!loops.length) throw new Error('The unrolled sheet has no outline');
  // (points along straight runs dropped: one edge per straight run)
  const simplify = (L) => L.filter((p, i) => {
    const a = L[(i - 1 + L.length) % L.length], b = L[(i + 1) % L.length];
    const cr = (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0]);
    return Math.abs(cr) > 1e-9 * (1 + Math.hypot(b[0] - a[0], b[1] - a[1]) ** 2);
  });
  const sa = (L) => L.reduce((s, p, i) => { const q = L[(i + 1) % L.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
  // (a loop narrower on average than DEV_CRACK is no cut-out: where the layout's small errors add up, triangles
  // that meet in the shape can land a hair apart in the flat; the pattern is closed there)
  const perim = (L) => L.reduce((s, p, i) => s + Math.hypot(L[(i + 1) % L.length][0] - p[0], L[(i + 1) % L.length][1] - p[1]), 0);
  const ls = loops.map(simplify).filter((L) => L.length >= 3).sort((x, y) => Math.abs(sa(y)) - Math.abs(sa(x)))
    .filter((L, i) => i === 0 || (2 * Math.abs(sa(L))) / perim(L) >= DEV_CRACK);
  let region = polyFace(ls[0]);
  for (const h of ls.slice(1)) region = bop('cut', region, polyFace(h)) || region;
  // laid flat without running into itself: the pattern's area is the triangles' own
  const triArea = node.reduce((s, nd) => { const c = nd.map((n) => nodeXY[n]); return s + Math.abs((c[1][0] - c[0][0]) * (c[2][1] - c[0][1]) - (c[2][0] - c[0][0]) * (c[1][1] - c[0][1])) / 2; }, 0);
  const A = areaOf(region);
  if (Math.abs(A - triArea) > 1e-4 * triArea) throw new Error('The unrolled sheet would overlap itself: it cannot be laid out flat in one piece');
  const local = applyM(solid, invM(frameM(fr)));
  const [rp, rq, rr] = C[fixedTri[0]];
  // (a point on the picked face, in the sheet's frame: the face is found by it again after a cut)
  const seed = apM(invM(frameM(fr)), [0, 1, 2].map((c) => (V[t0[0]][c] + V[t0[1]][c] + V[t0[2]][c]) / 3));
  return {
    t, K, R: 0, frame: fr, region, bends: [], flat: null, stale: null, nextBend: 1,
    rootPt: [(rp[0] + rq[0] + rr[0]) / 3, (rp[1] + rq[1] + rr[1]) / 3],
    lofted: { method: 'developed', solid: local, seed, bendLines: [] },
    ...(dished ? { stretch: { max: dished.maxStrain, rms: dished.rms, area: dished.area } } : {}),
  };
}

// ------------------------------------------------------------ convert a curved surface (a rolled sheet)
// A face curved one way only: a cylinder, or any surface swept straight along one direction D (e.g. an
// extruded airfoil). Its section across D is fitted with arcs (and straight runs) that join smoothly,
// to within tol (ROLL_TOL by default); each arc becomes a bend of its own radius, so the sheet is rolled.
// The flat pattern is the face's own outline unrolled along the section. side: where the material is,
// 'one' (behind the face, against its normal), 'other' (in front) or 'mid' (half each side). trim: where
// the sheet would run into itself (e.g. the two sides of a blade meeting at its trailing edge), one end
// is cut back (the end that needs the least) to leave a small clearance.
export const ROLL_TOL = 0.05; // mm: default largest distance between the section and the fitted arcs
export function fromCurvedFace(face, { t, K, side = 'one', tol = ROLL_TOL, trim = true }) {
  const ad = new (oc().BRepAdaptor_Surface)(face.wrapped, true);
  let u0, u1, v0, v1, at;
  try {
    u0 = ad.FirstUParameter(); u1 = ad.LastUParameter(); v0 = ad.FirstVParameter(); v1 = ad.LastVParameter();
    at = (u, v) => { const p = ad.Value(u, v); const r = [p.X(), p.Y(), p.Z()]; p.delete?.(); return r; };
    return rolledSheet(face, { t, K, mode: side, tol, trim, at, u0, u1, v0, v1 });
  } finally { ad.delete(); }
}
function rolledSheet(face, { t, K, mode, tol, trim, at, u0, u1, v0, v1 }) {
  // the straight direction: one of the surface's parameter lines runs the same way everywhere
  const grid = [0.05, 0.27, 0.5, 0.73, 0.95];
  const straightAlong = (which) => {
    const hu = (u1 - u0) * 1e-4, hv = (v1 - v0) * 1e-4;
    let D = null;
    for (const gu of grid) {
      for (const gv of grid) {
        const u = u0 + (u1 - u0) * gu, v = v0 + (v1 - v0) * gv;
        const d = which === 'u' ? sub3(at(u + hu, v), at(u - hu, v)) : sub3(at(u, v + hv), at(u, v - hv));
        if (len3(d) < 1e-12) return null;
        const du = unit3(d);
        if (!D) D = du;
        else if (Math.abs(Math.abs(dot3(D, du)) - 1) > 1e-5) return null;
      }
    }
    return D;
  };
  let rul = 'v', D = straightAlong('v');
  if (!D) { rul = 'u'; D = straightAlong('u'); }
  if (!D) throw new Error('This surface is curved in two directions (or twisted), so it cannot be rolled from a flat sheet: only a surface curved one way (like a cylinder or an extruded profile) can be converted');
  // the section: the surface across D, in a plane square to D (basis A1, A2 with A1 × A2 = D)
  const A1 = unit3(cross3(D, Math.abs(D[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), A2 = cross3(D, A1);
  const [p0, p1] = rul === 'v' ? [u0, u1] : [v0, v1];
  const rm = rul === 'v' ? (v0 + v1) / 2 : (u0 + u1) / 2;
  const onSurf = (p) => (rul === 'v' ? at(p, rm) : at(rm, p));
  const O3 = onSurf(p0);
  const proj = (P) => { const r = sub3(P, O3); return [dot3(r, A1), dot3(r, A2)]; };
  const N = 800, eps = (p1 - p0) * 1e-5;
  const pts = [], tg = [];
  for (let i = 0; i <= N; i++) {
    const p = p0 + ((p1 - p0) * i) / N;
    pts.push(proj(onSurf(p)));
    const a = proj(onSurf(Math.max(p0, p - eps))), b = proj(onSurf(Math.min(p1, p + eps)));
    tg.push(u2(s2(b, a)));
  }
  // which side the material is on (left or right of the section's direction of travel)
  const pm = onSurf(p0 + (p1 - p0) * 0.5), nOut = faceNormal(face, pm).map((x) => (mode === 'other' ? -x : x));
  const tMid = tg[N >> 1], m2d = [-dot3(nOut, A1), -dot3(nOut, A2)];
  const side = Math.sign(tMid[0] * m2d[1] - tMid[1] * m2d[0]) || 1; // +1: material on the left
  const toward = (T) => (side > 0 ? [-T[1], T[0]] : [T[1], -T[0]]);
  // the sheet's own side (z = 0 of the flat): the surface, or half a thickness off it (symmetric)
  const mat = tg.map(toward), off = mode === 'mid' ? t / 2 : 0;
  const ref = pts.map((p, i) => s2(p, m2(mat[i], off)));
  const S = [0];
  for (let i = 1; i <= N; i++) S.push(S[i - 1] + l2(s2(ref[i], ref[i - 1])));
  // where the sheet would run into itself: cut one end back (whichever needs less), with a little clearance
  let iA = 0, iB = N, trimmed = null;
  const clear = Math.max(0.05, 0.05 * t);
  const hits = trim ? selfOverlaps(ref, mat, t, S, clear) : [];
  if (hits.length) {
    const startTo = Math.max(...hits.map(([i]) => i)) + 1, endTo = Math.min(...hits.map(([, j]) => j));
    const cutStart = S[startTo], cutEnd = S[N] - S[endTo];
    if (Math.min(cutStart, cutEnd) > S[N] / 2) throw new Error('The sheet would run into itself well away from its ends, so it cannot be trimmed back: use a thinner sheet or another thickness side');
    if (cutStart <= cutEnd) { iA = startTo; trimmed = { at: 'start', length: cutStart }; } else { iB = endTo; trimmed = { at: 'end', length: cutEnd }; }
  } else if (!trim && selfOverlaps(ref, mat, t, S, 0).length) {
    trimmed = { at: null, length: 0, overlaps: true }; // (left as it is: the sheet runs into itself)
  }
  // smoothly joined arcs through the section, every point within tol
  const segs = fitArcs(ref.slice(iA, iB + 1), tg.slice(iA, iB + 1), tol);
  if (!segs.length) throw new Error('The surface has no length across its straight direction');
  // lay the section out flat: straight runs as they are, arcs as bends (bend allowance)
  let X = 0;
  const lay = [];
  for (const s of segs) {
    if (s.kind === 'line') { const L = l2(s2(s.b, s.a)); lay.push({ s, X, len: L }); X += L; continue; }
    const outer = (s.ccw ? 1 : -1) === side; // curving toward the material: the face is on the outside
    const R = outer ? s.r - t : s.r;
    if (R < -1e-6) throw new Error(`The surface curves tighter (R${+s.r.toFixed(3)}) than the sheet is thick: use a thinner sheet or put the material on the other side`);
    const ba = bendAllowance(s.sweep, Math.max(R, 0), K, t);
    lay.push({ s, X, len: ba, R: Math.max(R, 0), up: outer });
    X += ba;
  }
  // the frame: at the start of the first straight run (it stays put), or at the start of the section
  const first = lay.find((L) => L.s.kind === 'line') || lay[0];
  const T0 = first.s.kind === 'line' ? u2(s2(first.s.b, first.s.a)) : first.s.t0;
  const to3 = (q) => add3(add3(O3, mul3(A1, q[0])), mul3(A2, q[1]));
  const dir3 = (q) => add3(mul3(A1, q[0]), mul3(A2, q[1]));
  const u3 = unit3(dir3(T0)), n3 = unit3(dir3(toward(T0))), v3 = cross3(n3, u3);
  const frame = { o: sub3(to3(first.s.a), mul3(u3, first.X)), u: u3, v: v3, n: n3 };
  // a point of the face to the flat: along the section (through the bends' allowances) and along D;
  // past a trimmed end it carries straight on (that part is cut off below)
  const flatOf = (P) => {
    const q = proj(P);
    let nk = 0, nl = 0, nd = Infinity;
    for (let k = 0; k < N; k++) {
      const a = pts[k], v = s2(pts[k + 1], a), L2 = d2(v, v) || 1;
      const l = Math.max(0, Math.min(1, d2(s2(q, a), v) / L2)), d = l2(s2(q, a2(a, m2(v, l))));
      if (d < nd) { nd = d; nk = k; nl = l; }
    }
    const pos = nk + nl, sAt = S[nk] + nl * (S[nk + 1] - S[nk]);
    let x;
    if (pos < iA) x = sAt - S[iA];
    else if (pos > iB) x = X + (sAt - S[iB]);
    else {
      const qr = a2(ref[nk], m2(s2(ref[nk + 1], ref[nk]), nl));
      let best = null;
      for (const L of lay) {
        const { d, f } = locateOn(L.s, qr);
        if (!best || d < best.d) best = { d, x: L.X + f * L.len };
      }
      x = best.x;
    }
    return [x, dot3(sub3(P, O3), v3)];
  };
  const loopFlat = (w) => wireLoop(w, 96).map(flatOf);
  let region = polyFace(loopFlat(face.clone().outerWire()));
  for (const w of face.clone().innerWires()) region = bop('cut', region, polyFace(loopFlat(w)));
  if (iA > 0 || iB < N) {
    const b0 = bbox2(region);
    region = bop('common', region, rectFace([0, b0.min[1] - 1], [1, 0], [0, 1], X, b0.max[1] - b0.min[1] + 2));
    if (!region) throw new Error('Nothing of the sheet is left after trimming it back');
  }
  const bb = bbox2(region);
  const bends = [];
  let nextBend = 1;
  for (const L of lay) {
    if (L.s.kind !== 'arc') continue;
    bends.push({ id: 'b' + nextBend++, p0: [L.X, bb.min[1]], e: [0, 1], d: [1, 0], w: bb.max[1] - bb.min[1], ba: L.len, ang: L.s.sweep, up: L.up, R: L.R });
  }
  const rootPt = first.s.kind === 'line' ? insidePoint(region, [first.X + first.len / 2, (bb.min[1] + bb.max[1]) / 2]) : null;
  const radii = bends.map((b) => b.R);
  return {
    sheet: { t, K, R: radii.length ? Math.min(...radii) : 0, frame, region, bends, rootPt, flat: null, stale: null, nextBend },
    rolled: { bends: bends.length, straight: lay.length - bends.length, rMin: radii.length ? Math.min(...radii) : null, rMax: radii.length ? Math.max(...radii) : null, tol, trimmed },
  };
}
// Where a sheet of thickness t along the section (points ref, material directions mat, arc lengths S)
// overlaps itself, or comes within clear of itself: pairs [i, j] (i < j) of pieces between points i, i+1
// and j, j+1. Pieces close along the section are not compared (they are joined, e.g. round a bend).
function selfOverlaps(ref, mat, t, S, clear) {
  const n = ref.length - 1;
  const quads = [], boxes = [];
  for (let i = 0; i < n; i++) {
    const q = [ref[i], ref[i + 1], a2(ref[i + 1], m2(mat[i + 1], t)), a2(ref[i], m2(mat[i], t))];
    quads.push(q);
    boxes.push([Math.min(...q.map((p) => p[0])) - clear, Math.min(...q.map((p) => p[1])) - clear, Math.max(...q.map((p) => p[0])) + clear, Math.max(...q.map((p) => p[1])) + clear]);
  }
  // triangles a and b are apart by more than clear along one of their edge normals
  const apart = (a, b) => {
    for (const poly of [a, b]) {
      for (let k = 0; k < 3; k++) {
        const e = s2(poly[(k + 1) % 3], poly[k]), nn = [-e[1], e[0]], L = l2(nn);
        if (L < 1e-12) continue;
        const pa = a.map((p) => d2(p, nn) / L), pb = b.map((p) => d2(p, nn) / L);
        if (Math.max(...pa) + clear < Math.min(...pb) || Math.max(...pb) + clear < Math.min(...pa)) return true;
      }
    }
    return false;
  };
  const sep = 2 * (t + clear);
  const out = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (S[j] - S[i + 1] <= sep) continue;
      const A = boxes[i], B = boxes[j];
      if (A[2] < B[0] || B[2] < A[0] || A[3] < B[1] || B[3] < A[1]) continue;
      const qa = quads[i], qb = quads[j];
      const ta = [[qa[0], qa[1], qa[2]], [qa[0], qa[2], qa[3]]], tb = [[qb[0], qb[1], qb[2]], [qb[0], qb[2], qb[3]]];
      if (ta.some((x) => tb.some((y) => !apart(x, y)))) out.push([i, j]);
    }
  }
  return out;
}
// Where q lies on a fitted segment: its distance from it and how far along it is (0…1).
function locateOn(s, q) {
  if (s.kind === 'line') {
    const v = s2(s.b, s.a), L2 = d2(v, v) || 1;
    const f = Math.max(0, Math.min(1, d2(s2(q, s.a), v) / L2));
    return { d: l2(s2(q, a2(s.a, m2(v, f)))), f };
  }
  const ang = Math.atan2(q[1] - s.c[1], q[0] - s.c[0]);
  let phi = s.ccw ? ang - s.a0 : s.a0 - ang;
  phi = ((phi % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (phi > s.sweep) {
    // past either end: whichever end is nearer
    const da = l2(s2(q, s.a)), db = l2(s2(q, s.b));
    return da < db ? { d: da, f: 0 } : { d: db, f: 1 };
  }
  return { d: Math.abs(l2(s2(q, s.c)) - s.r), f: phi / s.sweep };
}
// Smoothly joined arcs and straight runs through points pts (tangents tg; only the first is used),
// every point within tol, as few as it can; neighbouring arcs on one circle merged.
function fitArcs(pts, tg, tol) {
  const arcFrom = (a, ta, b) => {
    const ch = s2(b, a), L2 = d2(ch, ch);
    if (L2 < 1e-20) return null;
    const nn = [-ta[1], ta[0]], den = 2 * d2(ch, nn);
    if (Math.abs(den) < 1e-14 * Math.sqrt(L2)) return { kind: 'line', a, b };
    const rs = L2 / den, c = a2(a, m2(nn, rs)), r = Math.abs(rs), ccw = rs > 0;
    const angOf = (p) => Math.atan2(p[1] - c[1], p[0] - c[0]);
    const a0 = angOf(a);
    let sw = ccw ? angOf(b) - a0 : a0 - angOf(b);
    sw = ((sw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (sw < 1e-4 && l2(ch) < r) return { kind: 'line', a, b }; // (a negligible turn: straight)
    return { kind: 'arc', a, b, c, r, ccw, a0, sweep: sw, t0: ta };
  };
  const devOf = (s, i, j) => {
    let dev = 0;
    for (let k = i + 1; k < j && dev <= tol; k++) dev = Math.max(dev, locateOn(s, pts[k]).d);
    return dev;
  };
  // (1) pairs of arcs meeting each point's tangent (biarcs), each pair split in two until it fits
  const biarc = (p1, t1, p2, t2) => {
    const v = s2(p2, p1), vv = d2(v, v);
    if (vv < 1e-20) return [];
    const vh = m2(v, 1 / Math.sqrt(vv));
    if (Math.abs(vh[0] * t1[1] - vh[1] * t1[0]) < 1e-9 && Math.abs(vh[0] * t2[1] - vh[1] * t2[0]) < 1e-9 && d2(v, t1) > 0) return [{ kind: 'line', a: p1, b: p2 }];
    const tt = a2(t1, t2), vt = d2(v, tt), den = 2 * (1 - d2(t1, t2));
    const d = Math.abs(den) < 1e-10 ? vv / (4 * d2(v, t2)) : (-vt + Math.sqrt(vt * vt + den * vv)) / den;
    if (!(d > 0) || !isFinite(d)) { const one = arcFrom(p1, t1, p2); return one ? [one] : []; }
    const q1 = a2(p1, m2(t1, d)), q2 = s2(p2, m2(t2, d));
    const pm = m2(a2(q1, q2), 0.5), tm = u2(s2(q2, q1));
    return [arcFrom(p1, t1, pm), arcFrom(pm, tm, p2)].filter(Boolean);
  };
  const byBiarcs = [];
  const split = (i, j) => {
    const b = biarc(pts[i], tg[i], pts[j], tg[j]);
    let dev = 0;
    for (let k = i + 1; k < j && dev <= tol; k++) dev = Math.max(dev, Math.min(...b.map((s) => locateOn(s, pts[k]).d)));
    if (dev <= tol || j - i <= 2) { byBiarcs.push(...b); return; }
    const m = (i + j) >> 1;
    split(i, m); split(m, j);
  };
  split(0, pts.length - 1);
  // (2) greedy: each arc starts where the last one ended, in the direction it ended (so they join
  // smoothly), and runs as far along the points as it can while every point stays within tol of it
  const out = [];
  const endTangent = (s) => {
    if (s.kind === 'line') return u2(s2(s.b, s.a));
    const rv = m2(s2(s.b, s.c), 1 / s.r);
    return s.ccw ? [-rv[1], rv[0]] : [rv[1], -rv[0]];
  };
  let i = 0, T = tg[0];
  const last = pts.length - 1;
  while (i < last) {
    const ok = (j) => { const s = arcFrom(pts[i], T, pts[j]); return s && devOf(s, i, j) <= tol ? s : null; };
    // the furthest end that still fits: double the step while it fits, then halve back
    let good = i + 1, step = 1;
    while (good + step <= last && ok(good + step)) { good += step; step *= 2; }
    for (step >>= 1; step >= 1; step >>= 1) if (good + step <= last && ok(good + step)) good += step;
    const s = arcFrom(pts[i], T, pts[good]);
    if (s) { out.push(s); T = endTangent(s); }
    i = good;
  }
  // one circle split in pieces: merge them (and straight runs in line); the fit with fewer pieces is used
  const mergeRuns = (list) => {
    const merged = [];
    for (const s of list) {
      const p = merged[merged.length - 1];
      if (p && p.kind === 'arc' && s.kind === 'arc' && p.ccw === s.ccw && Math.abs(p.r - s.r) < tol && l2(s2(p.c, s.c)) < tol) {
        merged[merged.length - 1] = { ...p, b: s.b, sweep: p.sweep + s.sweep };
      } else if (p && p.kind === 'line' && s.kind === 'line' && Math.abs(u2(s2(p.b, p.a))[0] * u2(s2(s.b, s.a))[1] - u2(s2(p.b, p.a))[1] * u2(s2(s.b, s.a))[0]) < 1e-9) {
        merged[merged.length - 1] = { ...p, b: s.b };
      } else merged.push(s);
    }
    return merged;
  };
  const a = mergeRuns(byBiarcs), b = mergeRuns(out);
  const arcsIn = (list) => list.filter((s) => s.kind === 'arc').length;
  return arcsIn(b) < arcsIn(a) ? b : a;
}

// faces: planar faces of one side of the sheet ({ face (replicad Face), n (unit normal pointing
// away from the material) }) connected along straight edges; fixed: index of the face that stays.
// The faces are the sheet's surface on that side; the material is on the other side (thickness t).
// Every shared edge becomes a bend with inner radius R0. links: real bends between two of the faces
// (from fromSolid): { i, j, ai, bi / aj, bj (where the bend meets face i / j), axis { o, d }, R (inner
// radius), outer (the faces are the outside of the bend), faces (its cylindrical faces) }. Link ends past
// the faces (faces.length + k) are joints[k] ({ n }): where a bend runs straight on into the next.
export function fromFaces(faces, fixed, { t, R: R0, K, connectedOnly = false, links = [], joints = [] }) {
  if (!faces.length) throw new Error('No flat faces to convert');
  const tol = Math.max(1e-4, t * 1e-3);
  let info = faces.map((f, i) => ({ i, face: f.face, n: unit3(f.n), loops: [wireLoop(f.face.clone().outerWire(), 32), ...f.face.clone().innerWires().map((w) => wireLoop(w, 32))], edges: lineEdges(f.face) }));
  info.push(...joints.map((J, k) => ({ i: faces.length + k, joint: true, n: unit3(J.n), loops: null, edges: [] })));
  // shared straight edges between pairs of faces
  const shared = [];
  for (let i = 0; i < info.length; i++) {
    for (let j = i + 1; j < info.length; j++) {
      for (const ea of info[i].edges) {
        for (const eb of info[j].edges) {
          const ov = overlapSegs(ea, eb, tol);
          if (ov) shared.push({ i, j, a: ov[0], b: ov[1] });
        }
      }
    }
  }
  // only the faces joined to the fixed one (for a solid: its side of the sheet)
  if (connectedOnly) {
    const reach = new Set([fixed]), q = [fixed];
    while (q.length) { const i = q.shift(); for (const sh of [...shared, ...links]) { const j = sh.i === i ? sh.j : sh.j === i ? sh.i : -1; if (j >= 0 && !reach.has(j)) { reach.add(j); q.push(j); } } }
    info = info.filter((F) => reach.has(F.i));
  }
  const byI = new Map(info.map((F) => [F.i, F]));
  // flat frame on the fixed face: z goes from the faces into the material
  const F0 = info.find((F) => F.i === fixed);
  const n0 = mul3(F0.n, -1);
  const fr0 = planeFrame(F0.loops[0][0], n0);
  const toFlat0 = invM(frameM(fr0));
  // unfold transform for every face (model → flat, before bend allowances), found face by face
  const T = new Map([[fixed, toFlat0]]);
  const bends = [];
  let region = null, nextBend = 1;
  const queue = [fixed];
  const trims = new Map(); // face index → list of rect trims (flat coords, applied to its image)
  const shifts = new Map([[fixed, IDENT]]);
  const bendFaces = [], realBend = new Set(); // unrolled faces of real bends; their ids
  const usedLinks = new Set(); // links made into bends
  while (queue.length) {
    const i = queue.shift();
    // real bends: face j turned about the bend's axis into face i's plane, then moved on by the bend
    // allowance; the bend's own faces are unrolled in between
    for (const L0 of links) {
      if (L0.i !== i && L0.j !== i) continue;
      const L = L0.i === i ? L0 : { ...L0, i: L0.j, j: L0.i, ai: L0.aj, bi: L0.bj, aj: L0.ai, bj: L0.bi };
      const j = L.j;
      if (T.has(j) || !byI.has(j)) continue;
      usedLinks.add(L0);
      const Fi = byI.get(i), Fj = byI.get(j);
      const ang = Math.acos(Math.max(-1, Math.min(1, dot3(Fi.n, Fj.n))));
      if (ang > Math.PI - 1e-3) throw new Error('Two faces fold flat onto each other (a hem): not supported when converting');
      const { o, d: ax } = L.axis;
      let rot = rotM(o, ax, ang);
      if (len3(sub3(apMdir(rot, Fj.n), Fi.n)) > 1e-6) rot = rotM(o, ax, -ang);
      const Ti = T.get(i);
      const fa = apM(Ti, L.ai), fb = apM(Ti, L.bi);
      const pa = [fa[0], fa[1]], pb = [fb[0], fb[1]];
      const e = u2(s2(pb, pa)), w = l2(s2(pb, pa));
      let d = [-e[1], e[0]];
      if (Fi.joint) {
        // a joint: the bend carries straight on in the direction the last one went
        if (d2(d, Fi.dOut) < 0) d = m2(d, -1);
      } else {
        const qi = apM(Ti, loopPointAway(Fi.loops[0], L.ai, L.bi));
        if (d2(s2([qi[0], qi[1]], pa), d) > 0) d = m2(d, -1);
      }
      if (Fj.joint) Fj.dOut = d;
      const ba = bendAllowance(ang, L.R, K, t);
      T.set(j, mulM(transM([d[0] * ba, d[1] * ba, 0]), mulM(Ti, rot)));
      realBend.add('b' + nextBend);
      bends.push({ id: 'b' + nextBend++, p0: pa, e, d, w, ba, ang, up: L.outer, R: L.R });
      // unroll: a point of the bend goes to its place along the bend line, and across by the share of
      // the bend's angle it has turned through
      const radial = (p) => { const r = sub3(p, o); return sub3(r, mul3(ax, dot3(r, ax))); };
      const r0 = radial(L.ai), ua = unit3(sub3(L.bi, L.ai));
      const sg = Math.sign(dot3(cross3(r0, radial(L.aj)), ax)) || 1;
      const unroll = (p) => {
        const rp = radial(p);
        let phi = Math.atan2(sg * dot3(cross3(r0, rp), ax), dot3(r0, rp));
        phi = Math.max(0, Math.min(ang, phi));
        const q = apM(Ti, add3(L.ai, mul3(ua, dot3(sub3(p, L.ai), ua))));
        return a2([q[0], q[1]], m2(d, (phi / ang) * ba));
      };
      // its zone in the flat: its own faces unrolled edge by edge (a straight edge stays a line, a curved one is
      // one smooth curve). The bend is formed over exactly this zone (fold, bendSolid), so its ends come out as
      // the body has them: square, run on into a corner as a V cutout, mitred…
      const flatRuns = (w) => wireRuns(w, 32).map((r) => ({ ...r, pts: r.pts.map(unroll) }));
      const flatFace = (w) => runsFace(flatRuns(w), 1e-5) || polyFace(wireLoop(w, 32).map(unroll));
      let zone = null;
      for (const cf of L.faces) {
        let face = flatFace(cf.clone().outerWire());
        for (const hw of cf.clone().innerWires()) face = bop('cut', face, flatFace(hw));
        if (face) { bendFaces.push(face); zone = bop('fuse', zone, face); }
      }
      if (zone) bends[bends.length - 1].zone = zone;
      queue.push(j);
    }
    for (const sh of shared) {
      const j = sh.i === i ? sh.j : sh.j === i ? sh.i : -1;
      if (j < 0 || T.has(j) || !byI.has(j)) continue;
      const Fi = byI.get(i), Fj = byI.get(j);
      const ang = Math.acos(Math.max(-1, Math.min(1, dot3(Fi.n, Fj.n))));
      if (ang < 1e-4) { T.set(j, T.get(i)); queue.push(j); continue; } // same plane: no bend between them
      const ed = unit3(sub3(sh.b, sh.a));
      // a point of Fj next to the edge, to tell which way it turns
      const qj = loopPointAway(Fj.loops[0], sh.a, sh.b);
      const convex = dot3(sub3(qj, sh.a), Fi.n) < 0; // turns away from the faces' side: they are the outer side
      // unfold Fj into Fi's plane about the edge
      let rot = rotM(sh.a, ed, ang);
      if (len3(sub3(apMdir(rot, Fj.n), Fi.n)) > 1e-6) rot = rotM(sh.a, ed, -ang);
      const Ti = T.get(i);
      const TjRaw = mulM(Ti, rot);
      // in flat coordinates: the edge line, and the direction from Fi across it
      const fa = apM(Ti, sh.a), fb = apM(Ti, sh.b);
      const pa = [fa[0], fa[1]], pb = [fb[0], fb[1]];
      const e = u2(s2(pb, pa)), w = l2(s2(pb, pa));
      let d = [-e[1], e[0]];
      const qi = apM(Ti, loopPointAway(Fi.loops[0], sh.a, sh.b));
      if (d2(s2([qi[0], qi[1]], pa), d) > 0) d = m2(d, -1);
      const sb = setback(ang, convex ? R0 + t : R0);
      const ba = bendAllowance(ang, R0, K, t);
      const shift = transM([d[0] * (ba - 2 * sb), d[1] * (ba - 2 * sb), 0]);
      T.set(j, mulM(shift, TjRaw));
      trims.set(i, [...(trims.get(i) || []), { p: pa, e, d, w, depth: -sb }]);
      const pj = a2(pa, m2(d, ba - 2 * sb));
      trims.set(j, [...(trims.get(j) || []), { p: a2(pj, m2(d, 0)), e, d: m2(d, -1), w, depth: -sb, back: true }]);
      // the material is on +z of the flat; the flange turns toward it when the faces are the outer side
      bends.push({ id: 'b' + nextBend++, p0: a2(pa, m2(d, -sb)), e, d, w, ba, ang, up: convex, R: R0 });
      queue.push(j);
    }
  }
  if (T.size !== info.length) throw new Error('Some faces are not connected to the fixed face along straight edges');
  // (a bend between two faces both laid out already: the sheet goes all the way round, and laid out face by face
  // that bend would be left out)
  if (links.some((L) => !usedLinks.has(L) && byI.has(L.i) && byI.has(L.j))) throw new Error('The sheet closes on itself (it goes all the way round)');
  if (bends.some((b) => b.ang > Math.PI - 1e-3)) throw new Error('Two faces fold flat onto each other (a hem): not supported when converting');
  let fixedFace = null;
  const images = [];
  for (const F of info) {
    if (F.joint) continue;
    const M = T.get(F.i);
    // the face itself moved into the flat (holes and arcs stay exact); its outline as points if that fails
    let face = null;
    try { face = upFaces(applyM(F.face.clone(), M)); } catch { face = null; }
    if (!face || !facesOf(face).length) {
      const loops = F.loops.map((lp) => lp.map((p) => { const q = apM(M, p); return [q[0], q[1]]; }));
      face = polyFace(loops[0]);
      for (const h of loops.slice(1)) face = bop('cut', face, polyFace(h));
    }
    for (const tr of trims.get(F.i) || []) face = bop('cut', face, rectFace(tr.p, tr.e, tr.d, tr.w, tr.depth));
    if (F.i === fixed) fixedFace = face;
    images.push(imageOf(face, { i: F.i }, tol));
    region = bop('fuse', region, face);
  }
  // (the bends' zones too: a flange's bend can run flush against the material beside it as well)
  for (const b of bends) {
    const z = b.zone || stripFace(b);
    images.push(imageOf(z, { zone: true, e: b.e }, tol));
    if (!b.zone) free(z);
  }
  // seams: where the images of two faces touch side by side in the flat without being joined in the body (not
  // one plane across an edge they share): a flange whose end runs flush against the material beside it, with no
  // relief. The sheet is ripped there, as it is made: a cut line in the flat pattern, and folded a cut of next to
  // no width (fold), so the flange folds up free.
  const samePlane = new Set(shared.filter((sh) => byI.get(sh.i) && byI.get(sh.j) && !byI.get(sh.i).joint && !byI.get(sh.j).joint && dot3(byI.get(sh.i).n, byI.get(sh.j).n) > 1 - 1e-8).map((sh) => `${sh.i}|${sh.j}`));
  const seams = [];
  for (let a = 0; a < images.length; a++) {
    for (let b = a + 1; b < images.length; b++) {
      const A = images[a], B = images[b];
      // (two zones meet at corners; a zone touches the faces its bend joins along the bend lines, which is no seam:
      // only where it touches across its ends)
      if (A.zone && B.zone) continue;
      const Z = A.zone ? A : B.zone ? B : null;
      if (!Z && samePlane.has(`${Math.min(A.i, B.i)}|${Math.max(A.i, B.i)}`)) continue;
      const apart = (x, y) => x.lo[0] > y.hi[0] || y.lo[0] > x.hi[0] || x.lo[1] > y.hi[1] || y.lo[1] > x.hi[1];
      if (!A.edges.length || !B.edges.length || apart(A, B)) continue;
      for (const ea of A.edges) {
        if (apart(ea, B)) continue;
        for (const eb of B.edges) {
          if (apart(ea, eb)) continue;
          const ov = overlapSegs(ea.ed, eb.ed, tol);
          if (!ov || !(len3(sub3(ov[1], ov[0])) > 10 * tol)) continue;
          if (Z) { const v = u2(s2([ov[1][0], ov[1][1]], [ov[0][0], ov[0][1]])); if (Math.abs(v[0] * Z.e[1] - v[1] * Z.e[0]) < 1e-3) continue; }
          seams.push([[ov[0][0], ov[0][1]], [ov[1][0], ov[1][1]]]);
        }
      }
    }
  }
  // (pieces of one rip, along the face and along the bend zone: one line)
  for (let merged = true; merged;) {
    merged = false;
    for (let a = 0; a < seams.length && !merged; a++) {
      for (let b = a + 1; b < seams.length && !merged; b++) {
        const [p, q] = seams[a], [r, s] = seams[b], e = u2(s2(q, p));
        const off = (x) => { const v = s2(x, p); return Math.abs(e[0] * v[1] - e[1] * v[0]); };
        if (off(r) > tol || off(s) > tol) continue;
        const ts = [0, d2(s2(q, p), e), d2(s2(r, p), e), d2(s2(s, p), e)];
        if (Math.max(ts[2], ts[3]) < -tol || Math.min(ts[2], ts[3]) > ts[1] + tol) continue;
        const lo = Math.min(...ts), hi = Math.max(...ts);
        seams[a] = [a2(p, m2(e, lo)), a2(p, m2(e, hi))];
        seams.splice(b, 1);
        merged = true;
      }
    }
  }
  // sharp edges: the whole bend zone; real bends: their own faces, unrolled
  for (const b of bends) if (!realBend.has(b.id)) region = bop('fuse', region, stripFace(b));
  for (const f of bendFaces) region = bop('fuse', region, f);
  // the fixed face's middle (not a corner: corners end up in bend zones)
  const c = facesOf(fixedFace)[0]?.center;
  const cc = !c ? [0, 0] : Array.isArray(c) ? c : c.toTuple ? c.toTuple() : [c.x, c.y];
  // (kept as rip marks: one cut line each in the flat pattern and its DXF, ripped when folded)
  return { t, K, R: R0, frame: fr0, region, bends, ...(seams.length ? { marks: seams.map(([a, b]) => ({ kind: 'rip', a, b })) } : {}), rootPt: insidePoint(fixedFace || region, [cc[0], cc[1]]), flat: null, stale: null, nextBend };
}
// A face laid flat, for finding where it touches another: its straight edges, each with its box, and its box
// (to pass over the pairs far apart quickly; tol: how near counts as touching). extra: what it is (i: the face;
// zone, e: a bend's zone and its bend line's direction).
function imageOf(face, extra, tol) {
  const es = lineEdges(face).map((ed) => ({ ed, lo: [Math.min(ed[0][0], ed[1][0]) - tol, Math.min(ed[0][1], ed[1][1]) - tol], hi: [Math.max(ed[0][0], ed[1][0]) + tol, Math.max(ed[0][1], ed[1][1]) + tol] }));
  return { ...extra, edges: es, lo: [Math.min(...es.map((x) => x.lo[0])), Math.min(...es.map((x) => x.lo[1]))], hi: [Math.max(...es.map((x) => x.hi[0])), Math.max(...es.map((x) => x.hi[1]))] };
}
function planeFrame(p, n) {
  n = unit3(n);
  const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit3(cross3(a, n)), v = cross3(n, u);
  return { o: p, u, v, n };
}
function lineEdges(face) {
  const out = [];
  for (const e of face.edges) {
    if (e.geomType !== 'LINE') continue;
    const a = edgePts(e, 1);
    out.push([a[0], a[1]]);
  }
  return out;
}
// overlapping part of two collinear segments (or null)
function overlapSegs([a0, a1], [b0, b1], tol) {
  const d = unit3(sub3(a1, a0)), L = len3(sub3(a1, a0));
  const off = (p) => len3(sub3(sub3(p, a0), mul3(d, dot3(sub3(p, a0), d))));
  if (off(b0) > tol || off(b1) > tol) return null;
  const s0 = dot3(sub3(b0, a0), d), s1 = dot3(sub3(b1, a0), d);
  const lo = Math.max(0, Math.min(s0, s1)), hi = Math.min(L, Math.max(s0, s1));
  if (hi - lo < tol * 10) return null;
  return [add3(a0, mul3(d, lo)), add3(a0, mul3(d, hi))];
}
// a point of the loop well away from the line a–b (to see which side the face lies on)
function loopPointAway(loop, a, b) {
  const d = unit3(sub3(b, a));
  let best = loop[0], bd = -1;
  for (const p of loop) { const r = sub3(p, a); const dist = len3(sub3(r, mul3(d, dot3(r, d)))); if (dist > bd) { bd = dist; best = p; } }
  return best;
}
