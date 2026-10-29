// Assemblies: parts placed together and held by mates. An assembly opens in a tab of its own (like a drawing,
// through the same tab plumbing) but uses the 3D view: each part's mesh is drawn where each of its components
// sits (asmview.js).
//
// Assembly file (.rasm):
//   { kind: 'assembly', version, name, nextId,
//     parts:      [{ id, name, path, doc }]                       the parts used (a copy, refreshed from their file / tab)
//     components: [{ id, part, name, config, pos: [x, y, z], rot: [qx, qy, qz, qw], fixed, hidden, suppressed }]
//                 (config: which configuration of the part it uses; null = Default)
//     configs:    [{ id, name, comps: { compId: { config, hidden, suppressed } }, mates: { mateId: { suppressed, value } } }]
//     activeConfig                                                 the assembly configuration shown (null = Default)
//     mates:      [{ id, name, type, a: ref, b: ref, value, align, side, suppressed }] }
//   ref: { comp, kind: 'plane' | 'axis' | 'point', p, n | d, r, face | edge (local index), what }  — in the part's
//        own coordinates, so it moves with the component.
// Mates: Coincident, Concentric, Parallel, Perpendicular, Distance, Angle, Tangent, Lock. They are solved by Gauss-
// Newton steps of least change on the free components' positions and rotations (6 unknowns each).

import * as THREE from 'three';
import { icon } from './icons.js';
import { platform } from './platform.js';
import { materialById, MATERIALS, DEFAULT_BODY_COLOR, docJSON, stripThumbnail, fileStem, isDefaultName, createFeature, insertFeature, newRev, iconFor } from './model.js';
import { STD_TYPES, makeStdPart, fitToHole, fitLength, stdLengths, lengthLabel, setParts, heightOf } from './stdparts.js';
import { gauss } from './sketch3dmodel.js';
import { fmt, evalEquations, isValidName } from './expr.js';
import { ExplodeTool, explodeOffsets, drawExplodeLines, animateExplode } from './explode.js';
import { hashText, packResult, unpackResult } from './modelcache.js';
import { packMesh, unpackMesh, MESH_CACHE } from './partmeshes.js';
import { AssemblyView } from './asmview.js';
import { revisionsDialog } from './revisions.js';
import { bomRows, bomPropNames, bomCell, bomTotals, bomSources, bomColumnMenu, meshVolume, massOf } from './bom.js';
import { editCustomProps } from './custprops.js';
import { MotionTool } from './motion.js';
import { findCollisions } from './collide.js';
import { HoleTool, asmPartFeatures, fastenerLength, holeDiameter } from './asmfeatures.js';
import { t as tr } from './i18n.js';
import { volWithUnit, lenWithUnit, unitOf } from './units.js';
import * as G from './geometry.js';
import * as W from './wcs.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const el = (tag, attrs = {}, html = '') => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  if (html) e.innerHTML = html;
  return e;
};
const sameFile = (a, b) => !!a && !!b && String(a).replace(/\//g, '\\').toLowerCase() === String(b).replace(/\//g, '\\').toLowerCase();
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };

export const ASM_EXT = '.rasm';
export const isAssembly = (doc) => doc?.kind === 'assembly';
export function newAssembly(name = 'Assembly1') {
  return { kind: 'assembly', version: 1, name, nextId: 1, parts: [], components: [], mates: [] };
}

export const MATE_TYPES = {
  coincident: { label: 'Coincident', icon: 'mateCoincident' },
  concentric: { label: 'Concentric', icon: 'mateConcentric' },
  parallel: { label: 'Parallel', icon: 'mateParallel' },
  perpendicular: { label: 'Perpendicular', icon: 'matePerpendicular' },
  tangent: { label: 'Tangent', icon: 'mateTangent' },
  distance: { label: 'Distance', icon: 'mateDistance', value: 'mm' },
  angle: { label: 'Angle', icon: 'mateAngle', value: '°' },
  lock: { label: 'Lock', icon: 'mateLock' },
  // mechanical: how one component turns (or slides) as another turns, from where they are now
  gear: { label: 'Gear', icon: 'mateGear', value: 'ratio' },
  rack: { label: 'Rack Pinion', icon: 'mateRack', value: 'mm/rev' },
  screw: { label: 'Screw', icon: 'mateConcentric', value: 'mm/rev' },
  // (with more entities: width, a second face on each component; symmetric, the plane between them)
  width: { label: 'Width', icon: 'mateDistance', extra: 2 },
  // (slot: a pin or point the set distance from a straight edge, between its ends; path: a point on a curved edge)
  slot: { label: 'Slot', icon: 'mateDistance', value: 'mm' },
  path: { label: 'Path', icon: 'mateTangent' },
  // (cam: a follower (a point, or a roller: an axis) kept its radius from a cam's curved edge, in the plane square to it)
  cam: { label: 'Cam', icon: 'mateTangent', value: 'mm' },
  symmetric: { label: 'Symmetric', icon: 'mateParallel', extra: 1 },
};

// A component's turn about a direction d since orientation q0 (radians, between −π and π).
function twistOf(q, q0, d) {
  const dq = q.clone().multiply(new THREE.Quaternion(...q0).invert());
  const s = dq.w < 0 ? -1 : 1;
  return 2 * Math.atan2(s * (dq.x * d[0] + dq.y * d[1] + dq.z * d[2]), s * dq.w);
}
// The reference a gear / rack-pinion mate keeps (the poses it relates its motion to): taken when it is made,
// and again after every solve, so turns of any size add up. pin: which of a / b is the pinion (rack mates).
export function mechRef(m, poseOf, worldRef) {
  const pa = poseOf(m.a.comp), pb = poseOf(m.b.comp), A = worldRef(m.a), B = worldRef(m.b);
  if (!pa || !pb || !A || !B) return null;
  const qa = [pa.q.x, pa.q.y, pa.q.z, pa.q.w], qb = [pb.q.x, pb.q.y, pb.q.z, pb.q.w];
  if (m.type === 'gear') {
    // (both axes taken the same way round, so the ratio's sign means the same whichever way they were picked)
    const da = unit(A.d), db = dot(A.d, B.d) < 0 ? mul(unit(B.d), -1) : unit(B.d);
    return { qa, qb, da, db };
  }
  // (a screw: the second component's turn about the shared axis and its slide along it, both relative to the first's)
  if (m.type === 'screw') return { qa, qb, da: unit(A.d), pa: pa.p.slice(), pb: pb.p.slice() };
  const pin = A.kind === 'axis' && A.r > 0 ? 'a' : 'b', P = pin === 'a' ? A : B, Rk = pin === 'a' ? B : A;
  const dp = unit(P.d), dr = Rk.kind === 'plane' ? unit(cross(dp, Rk.n)) : unit(Rk.d);
  const rk = pin === 'a' ? pb : pa;
  return { pin, qp: pin === 'a' ? qa : qb, dp, dr, pr: rk.p.slice() };
}

// ------------------------------------------------------------------ vectors
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return mul(a, 1 / l); };
const r6 = (x) => Math.round(x * 1e6) / 1e6;

// (a part's mesh in the model cache: packMesh / unpackMesh / MESH_CACHE in partmeshes.js, shared with drawings)

// A part's mesh with the appearances set in the part (a body's colour, made transparent) over those it was
// imported with (the mesh bodies' color / transparency), as the assembly shows them.
function withPartLooks(mesh, doc) {
  const own = doc.bodies || {};
  if (!mesh.bodies?.some((b) => own[b.id]?.color || own[b.id]?.transparent !== undefined)) return mesh;
  return { ...mesh, bodies: mesh.bodies.map((b) => {
    const o = own[b.id];
    if (!o) return b;
    return { ...b, ...(o.color ? { color: o.color } : {}), ...(o.transparent !== undefined ? { transparency: o.transparent ? 0.7 : 0 } : {}) };
  }) };
}

// a pose: { p: [x, y, z], q: THREE.Quaternion }
const poseOf = (c) => ({ p: c.pos.slice(), q: new THREE.Quaternion(...c.rot) });
const applyQ = (q, v) => new THREE.Vector3(...v).applyQuaternion(q).toArray();
const toWorld = (pose, p) => add(applyQ(pose.q, p), pose.p);
const dirWorld = (pose, d) => applyQ(pose.q, d);
// a small rotation (rotation vector w) applied before q
const turned = (q, w) => { const a = len(w); if (a < 1e-15) return q.clone(); return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...mul(w, 1 / a)), a).multiply(q); };

// The equations of one mate: functions of world geometry A, B (refs placed by the trial poses); C, D the extra refs of a
// width mate (A's other face, B's other face) or C a symmetric mate's plane.
function mateEquations(m, A, B, C = null, D = null) {
  const t = m.type, ka = m.a.kind, kb = m.b.kind, s = m.align || -1, side = m.side || 1, v = Number(m.value) || 0;
  const eqs = [];
  // (a distance or angle mate with limits: nothing to meet between min and max, else the nearer of them; x the measured
  // value, in the mate's units)
  // (solveAssembly holds a limit as it found it, m._lim: 'free' (nothing to meet), 'lo' / 'hi' (the limit met exactly))
  const lim = (x, scale = 1) => {
    if (!m.limit) return x - v * scale;
    const lo = m.min === '' || m.min == null ? -Infinity : Number(m.min) * scale, hi = m.max === '' || m.max == null ? Infinity : Number(m.max) * scale;
    if (m._lim === 'free') return 0;
    if (m._lim === 'lo') return x - lo;
    if (m._lim === 'hi') return x - hi;
    return x < lo ? x - lo : x > hi ? x - hi : 0;
  };
  if (t === 'slot') {
    // (the edge the one with a length, second picked first; the pin's closest point to it no further than its ends)
    const [P, L] = B().len ? [A, B] : [B, A];
    const along = () => { const l = L(), p = P(); if (p.kind === 'axis') { const w = cross(p.d, l.d), ww = dot(w, w); if (ww < 1e-18) return dot(sub(p.p, l.p), l.d); const r = sub(p.p, l.p); return dot(cross(p.d, r), w) / ww; } return dot(sub(p.p, l.p), l.d); };
    eqs.push(() => {
      const l = L(), p = P(), r = sub(p.p, l.p);
      if (p.kind === 'axis') { const w = cross(p.d, l.d), lw = len(w); return (lw < 1e-9 ? len(cross(r, unit(l.d))) : Math.abs(dot(r, mul(w, 1 / lw)))) - v; }
      return len(cross(r, unit(l.d))) - v;
    });
    // (between the ends: a limit, held by solveAssembly's active sets)
    eqs.push(() => { const x = along(), hi = L().len; if (m._lim === 'free') return 0; if (m._lim === 'lo') return x; if (m._lim === 'hi') return x - hi; return x < 0 ? x : x > hi ? x - hi : 0; });
    return eqs;
  }
  if (t === 'path') {
    // (the point on the polyline of the curved edge: the second picked when both have one)
    const [P, C] = B().pts ? [A, B] : [B, A];
    const nearest = () => {
      const q = P().p, pts = C().pts; let best = pts[0], bd = Infinity;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], d = sub(pts[i], a), dd = dot(d, d), s = dd > 0 ? Math.max(0, Math.min(1, dot(sub(q, a), d) / dd)) : 0, x = add(a, mul(d, s)), e = len(sub(q, x));
        if (e < bd) { bd = e; best = x; }
      }
      return sub(q, best);
    };
    for (const k of [0, 1, 2]) eqs.push(() => nearest()[k]);
    return eqs;
  }
  if (t === 'cam') {
    // (the cam: the one with the polyline; the follower's distance to it, seen along the follower's axis (a roller) or
    // straight (a point), held at the value: the roller's radius)
    const [F, Cm] = B().pts && !A().pts ? [A, B] : A().pts && !B().pts ? [B, A] : [A, B];
    eqs.push(() => {
      const f = F(), pts = Cm().pts, d = f.kind === 'axis' ? unit(f.d) : null;
      const flat = (q) => (d ? sub(q, mul(d, dot(sub(q, f.p), d))) : q);
      let bd = Infinity;
      for (let i = 1; i < pts.length; i++) {
        const a = flat(pts[i - 1]), e = sub(flat(pts[i]), a), ee = dot(e, e), s = ee > 0 ? Math.max(0, Math.min(1, dot(sub(f.p, a), e) / ee)) : 0;
        bd = Math.min(bd, len(sub(f.p, add(a, mul(e, s)))));
      }
      return bd - v;
    });
    return eqs;
  }
  if (t === 'width') {
    // (B's two faces parallel to A's, their middle plane on A's)
    if (!C || !D) return eqs;
    const vecW = (f) => { for (const k of [0, 1, 2]) eqs.push(() => f()[k]); };
    vecW(() => cross(A().n, B().n));
    eqs.push(() => dot(A().n, sub(mul(add(B().p, D().p), 0.5), mul(add(A().p, C().p), 0.5))));
    return eqs;
  }
  if (t === 'symmetric') {
    // (B where A's mirror image in the plane C is)
    if (!C) return eqs;
    const mir = (p) => { const c = C(); return sub(p, mul(c.n, 2 * dot(sub(p, c.p), c.n))); }, mirD = (d) => { const c = C(); return sub(d, mul(c.n, 2 * dot(d, c.n))); };
    const vecS = (f) => { for (const k of [0, 1, 2]) eqs.push(() => f()[k]); };
    if (ka === 'plane' && kb === 'plane') { vecS(() => sub(mirD(A().n), mul(B().n, s))); eqs.push(() => dot(B().n, sub(B().p, mir(A().p)))); }
    else if (ka === 'point' && kb === 'point') vecS(() => sub(mir(A().p), B().p));
    else if (ka === 'axis' && kb === 'axis') { vecS(() => cross(mirD(A().d), B().d)); vecS(() => cross(sub(B().p, mir(A().p)), B().d)); }
    return eqs;
  }
  const vec3 = (f) => { for (const k of [0, 1, 2]) eqs.push(() => f()[k]); };
  const swap = (x, y) => [x, y];
  const pair = (k1, k2) => (ka === k1 && kb === k2 ? swap(A, B) : ka === k2 && kb === k1 ? swap(B, A) : null);
  const g = (o) => o;
  if (t === 'lock') {
    // the two components keep the turn and place they have relative to each other now (stored in m.rel)
    return eqs; // handled by solveAssembly (needs the poses)
  }
  if (t === 'coincident' || t === 'concentric') {
    let q;
    if ((q = pair('plane', 'plane'))) { const [a, b] = q; vec3(() => sub(a().n, mul(b().n, s))); eqs.push(() => dot(a().n, sub(b().p, a().p))); }
    else if ((q = pair('plane', 'point'))) { const [a, b] = q; eqs.push(() => dot(a().n, sub(b().p, a().p))); }
    else if ((q = pair('plane', 'axis'))) { const [a, b] = q; eqs.push(() => dot(a().n, b().d)); eqs.push(() => dot(a().n, sub(b().p, a().p))); }
    else if ((q = pair('axis', 'axis'))) { const [a, b] = q; vec3(() => cross(a().d, b().d)); vec3(() => cross(sub(b().p, a().p), a().d)); }
    else if ((q = pair('axis', 'point'))) { const [a, b] = q; vec3(() => cross(sub(b().p, a().p), a().d)); }
    else if ((q = pair('point', 'point'))) { const [a, b] = q; vec3(() => sub(a().p, b().p)); }
    return eqs;
  }
  if (t === 'parallel') {
    let q;
    if ((q = pair('plane', 'plane'))) { const [a, b] = q; vec3(() => sub(a().n, mul(b().n, s))); }
    else if ((q = pair('axis', 'axis'))) { const [a, b] = q; vec3(() => cross(a().d, b().d)); }
    else if ((q = pair('plane', 'axis'))) { const [a, b] = q; eqs.push(() => dot(a().n, b().d)); }
    return eqs;
  }
  if (t === 'perpendicular') {
    let q;
    if ((q = pair('plane', 'plane'))) { const [a, b] = q; eqs.push(() => dot(a().n, b().n)); }
    else if ((q = pair('axis', 'axis'))) { const [a, b] = q; eqs.push(() => dot(a().d, b().d)); }
    else if ((q = pair('plane', 'axis'))) { const [a, b] = q; vec3(() => cross(a().n, b().d)); }
    return eqs;
  }
  if (t === 'distance') {
    let q;
    if ((q = pair('plane', 'plane'))) { const [a, b] = q; vec3(() => sub(a().n, mul(b().n, s))); eqs.push(() => lim(side * dot(a().n, sub(b().p, a().p)))); }
    else if ((q = pair('plane', 'point'))) { const [a, b] = q; eqs.push(() => lim(side * dot(a().n, sub(b().p, a().p)))); }
    else if ((q = pair('point', 'point'))) { const [a, b] = q; eqs.push(() => lim(len(sub(a().p, b().p)))); }
    else if ((q = pair('axis', 'axis'))) { const [a, b] = q; vec3(() => cross(a().d, b().d)); eqs.push(() => lim(len(cross(sub(b().p, a().p), unit(a().d))))); }
    else if ((q = pair('axis', 'point'))) { const [a, b] = q; eqs.push(() => lim(len(cross(sub(b().p, a().p), unit(a().d))))); }
    else if ((q = pair('plane', 'axis'))) { const [a, b] = q; eqs.push(() => dot(a().n, b().d)); eqs.push(() => lim(side * dot(a().n, sub(b().p, a().p)))); }
    return eqs;
  }
  if (t === 'angle') {
    const dir = (o) => (o.kind === 'plane' ? o.n : o.d);
    eqs.push(() => { const x = dir(A()), y = dir(B()); return lim(Math.atan2(len(cross(x, y)), dot(x, y)), Math.PI / 180); });
    void ka; void kb;
    return eqs;
  }
  if (t === 'tangent') {
    let q;
    if ((q = pair('plane', 'axis'))) { const [a, b] = q; eqs.push(() => dot(a().n, b().d)); eqs.push(() => dot(a().n, sub(b().p, a().p)) - side * (b().r || 0)); }
    else if ((q = pair('axis', 'axis'))) { const [a, b] = q; vec3(() => cross(a().d, b().d)); eqs.push(() => len(cross(sub(b().p, a().p), unit(a().d))) - ((a().r || 0) + side * (b().r || 0))); }
    else if ((q = pair('plane', 'point'))) { const [a, b] = q; eqs.push(() => dot(a().n, sub(b().p, a().p)) - side * (b().r || 0)); }
    return eqs;
  }
  void g;
  return eqs;
}

// the mate types that make sense for two refs (the first the usual choice)
export function mateChoices(A, B) {
  if (!A || !B) return [];
  const k = [A.kind, B.kind].sort().join(',');
  const cyl = (o) => o.kind === 'axis' && o.r > 0;
  switch (k) {
    case 'plane,plane': return ['coincident', 'parallel', 'perpendicular', 'distance', 'angle', 'width', 'symmetric', 'lock'];
    case 'axis,axis': return [cyl(A) && cyl(B) && !A.circle && !B.circle ? 'concentric' : 'concentric', 'coincident', 'parallel', 'perpendicular', 'distance', 'angle', ...(cyl(A) && cyl(B) ? ['tangent', 'gear'] : []), 'screw', 'symmetric', ...(A.len || B.len ? ['slot'] : []), ...(cyl(A) !== cyl(B) ? ['rack'] : []), 'lock'];
    case 'axis,plane': return [...((A.kind === 'axis' ? cyl(A) : cyl(B)) ? ['tangent', 'rack'] : []), 'coincident', 'parallel', 'perpendicular', 'distance', 'angle', 'lock'];
    case 'axis,point': return ['coincident', 'distance', ...(A.len || B.len ? ['slot'] : []), ...(A.pts || B.pts ? ['path', 'cam'] : []), 'lock'];
    case 'plane,point': return ['coincident', 'distance', ...((A.kind === 'point' ? A.r : B.r) ? ['tangent'] : []), 'lock'];
    case 'point,point': return ['coincident', 'distance', 'symmetric', ...(A.pts || B.pts ? ['path', 'cam'] : []), 'lock'];
    default: return ['lock'];
  }
}

// The assembly's own planes and origin, as mate references (ref.comp ORIGIN: fixed where the assembly's origin is)
export const ORIGIN = '#origin';
export const originRef = (key) => (key === 'origin'
  ? { comp: ORIGIN, kind: 'point', p: [0, 0, 0], what: 'Origin', plane: 'origin' }
  : { comp: ORIGIN, kind: 'plane', p: [0, 0, 0], n: G.STD_PLANES[key].n.slice(), what: G.STD_PLANES[key].name, plane: key });
const ORIGIN_POSE = { p: [0, 0, 0], q: new THREE.Quaternion() };

// Solve the mates: components not fixed (and not pinned) move as little as they must. Returns { ok, residual }.
// Component patterns (doc.compPatterns: { id, name, kind: 'linear' | 'circular' | 'mirror', seeds: [component ids],
// linear: dir (world, unit), dist, count, dir2?, dist2, count2; circular: axis { p, d } (world), angle, count, equal;
// mirror: plane { p, n } (world)). Each copy is a component of its own ({ patternOf, seed, k }), fixed, placed from
// its seed after every solve: moved, turned about the axis, or placed as the seed's mirror image (the part itself is
// not mirrored: for parts the same both ways round). Adds and removes copies as counts change; returns whether any did.
export function applyCompPatterns(doc, newId = (b) => b + Math.random().toString(36).slice(2, 8)) {
  const pats = doc.compPatterns || [];
  let changed = false;
  const keep = new Set();
  for (const pt of pats) {
    const seeds = pt.seeds.map((id) => doc.components.find((c) => c.id === id)).filter(Boolean);
    const xs = compPatternTransforms(pt);
    for (const s of seeds) xs.forEach((X, k) => {
      let c = doc.components.find((x) => x.patternOf === pt.id && x.seed === s.id && x.k === k);
      if (!c) { c = { id: newId('c'), part: s.part, name: `${s.name} (${pt.name} ${k + 2})`, config: s.config ?? null, pos: [0, 0, 0], rot: [0, 0, 0, 1], fixed: true, hidden: false, patternOf: pt.id, seed: s.id, k }; doc.components.push(c); changed = true; }
      c.part = s.part; c.config = s.config ?? null; c.fixed = true;
      const ps = X(poseOf(s));
      c.pos = ps.p.map(r6); c.rot = [ps.q.x, ps.q.y, ps.q.z, ps.q.w].map((x) => Math.round(x * 1e12) / 1e12);
      keep.add(c.id);
    });
  }
  const before = doc.components.length;
  doc.components = doc.components.filter((c) => !c.patternOf || keep.has(c.id));
  if (doc.components.length !== before) { changed = true; const ids = new Set(doc.components.map((c) => c.id)); doc.mates = (doc.mates || []).filter((m) => (m.a.comp === ORIGIN || ids.has(m.a.comp)) && (m.b.comp === ORIGIN || ids.has(m.b.comp))); }
  return changed;
}
// A pattern's placements for each copy: functions of a pose { p, q } to the copy's
export function compPatternTransforms(pt) {
  const out = [], n = Math.max(1, Math.round(Number(pt.count) || 1));
  if (pt.kind === 'linear') {
    const d = unit(pt.dir), s = Number(pt.dist) || 0, two = pt.dir2 && Number(pt.count2) > 1;
    const d2 = two ? unit(pt.dir2) : [0, 0, 0], s2 = Number(pt.dist2) || 0, n2 = two ? Math.round(Number(pt.count2)) : 1;
    for (let i = 0; i < n; i++) for (let j = 0; j < n2; j++) if (i || j) { const v = add(mul(d, i * s), mul(d2, j * s2)); out.push((ps) => ({ p: add(ps.p, v), q: ps.q.clone() })); }
  } else if (pt.kind === 'circular') {
    const total = Number(pt.angle) || 0, step = pt.equal === false ? total : Math.abs(total) >= 360 ? total / n : total / Math.max(1, n - 1);
    const o = pt.axis.p, d = unit(pt.axis.d);
    for (let i = 1; i < n; i++) {
      const R = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...d), (step * i * Math.PI) / 180);
      out.push((ps) => ({ p: add(o, applyQ(R, sub(ps.p, o))), q: R.clone().multiply(ps.q) }));
    }
  } else if (pt.kind === 'mirror') {
    const o = pt.plane.p, nn = unit(pt.plane.n), M = new THREE.Matrix4().set(1 - 2 * nn[0] * nn[0], -2 * nn[0] * nn[1], -2 * nn[0] * nn[2], 0, -2 * nn[1] * nn[0], 1 - 2 * nn[1] * nn[1], -2 * nn[1] * nn[2], 0, -2 * nn[2] * nn[0], -2 * nn[2] * nn[1], 1 - 2 * nn[2] * nn[2], 0, 0, 0, 0, 1);
    out.push((ps) => {
      // (the turn M·R·M, a true rotation: the copy faces as the mirror image does, its own part the same way round)
      const Rm = new THREE.Matrix4().makeRotationFromQuaternion(ps.q), T = M.clone().multiply(Rm).multiply(M);
      return { p: sub(ps.p, mul(nn, 2 * dot(sub(ps.p, o), nn))), q: new THREE.Quaternion().setFromRotationMatrix(T) };
    });
  }
  return out;
}

// Limited distance and angle mates by active sets: each held free inside its limits or exactly at the one it is
// past, the assembly solved, then each checked again where it ended up (a free one now past a limit held there)
export function solveAssembly(doc, opts = {}) {
  const limited = (opts.only || doc.mates).filter((m) => (m.limit || m.type === 'slot') && !m.suppressed);
  if (!limited.length) return solveMates(doc, opts);
  const comps = new Map(doc.components.map((c) => [c.id, c]));
  const pose = (id) => (id === ORIGIN ? ORIGIN_POSE : comps.get(id) ? poseOf(comps.get(id)) : null);
  // (where a limit stands: the value equation's band residual with the poses as they are)
  const where = (m) => {
    const ref = (r) => () => { const ps = pose(r.comp); if (!ps) return null; const o = { kind: r.kind, p: toWorld(ps, r.p), r: r.r, len: r.len }; if (r.n) o.n = dirWorld(ps, r.n); if (r.d) o.d = dirWorld(ps, r.d); if (r.pts) o.pts = r.pts.map((q) => toWorld(ps, q)); return o; };
    const eqs = mateEquations({ ...m, _lim: undefined }, ref(m.a), ref(m.b));
    const x = eqs.length ? eqs[eqs.length - 1]() : 0;
    return Math.abs(x) < 1e-12 ? 'free' : x < 0 ? 'lo' : 'hi';
  };
  let r = null;
  try {
    for (const m of limited) m._lim = where(m);
    for (let pass = 0; pass < 4; pass++) {
      r = solveMates(doc, opts);
      if (!r.ok) break;
      const moved = limited.filter((m) => m._lim === 'free' && where(m) !== 'free');
      if (!moved.length) break;
      for (const m of moved) m._lim = where(m);
    }
  } finally { for (const m of limited) delete m._lim; }
  return r;
}
function solveMates(doc, { pinned = new Set(), only = null } = {}) {
  const comps = doc.components, byId = new Map(comps.map((c) => [c.id, c]));
  const has = (id) => id === ORIGIN || byId.has(id);
  const mates = (only || doc.mates).filter((m) => !m.suppressed && has(m.a?.comp) && has(m.b?.comp) && (!MATE_TYPES[m.type]?.extra || [m.a2, m.b2, m.s].filter(Boolean).every((r) => has(r.comp))));
  const free = comps.filter((c) => !c.fixed && !pinned.has(c.id) && mates.some((m) => m.a.comp === c.id || m.b.comp === c.id || m.s?.comp === c.id));
  const col = new Map(free.map((c, i) => [c.id, 6 * i]));
  const N = 6 * free.length;
  if (!mates.length) return { ok: true, residual: 0, dofs: new Map() };
  const base = new Map(comps.map((c) => [c.id, poseOf(c)]));
  base.set(ORIGIN, ORIGIN_POSE);
  let X = new Float64Array(N);
  const poseAt = (id, Xv) => {
    const b = base.get(id), i = col.get(id);
    if (i === undefined) return b;
    return { p: [b.p[0] + Xv[i], b.p[1] + Xv[i + 1], b.p[2] + Xv[i + 2]], q: turned(b.q, [Xv[i + 3], Xv[i + 4], Xv[i + 5]]) };
  };
  // the equations, each a function of X
  let cur = X;
  const world = (ref) => () => {
    const ps = poseAt(ref.comp, cur);
    const o = { kind: ref.kind, p: toWorld(ps, ref.p), r: ref.r, len: ref.len };
    if (ref.n) o.n = dirWorld(ps, ref.n);
    if (ref.d) o.d = dirWorld(ps, ref.d);
    if (ref.pts) o.pts = ref.pts.map((q) => toWorld(ps, q));
    return o;
  };
  const eqs = [];
  for (const m of mates) {
    if (m.type === 'lock' && m.rel) {
      // B's pose seen from A stays as it was when locked
      const lockEq = (k) => () => {
        const pa = poseAt(m.a.comp, cur), pb = poseAt(m.b.comp, cur);
        const inv = pa.q.clone().invert();
        const relP = applyQ(inv, sub(pb.p, pa.p)), relQ = inv.clone().multiply(pb.q);
        const dq = new THREE.Quaternion(...m.rel.q).invert().multiply(relQ);
        const w = [dq.x, dq.y, dq.z].map((x) => x * 2 * Math.sign(dq.w || 1));
        return k < 3 ? relP[k] - m.rel.p[k] : w[k - 3];
      };
      for (let k = 0; k < 6; k++) eqs.push(lockEq(k));
      continue;
    }
    if (m.type === 'screw' && m.ref) {
      // (on the one axis, and the second slides along it the pitch per turn it makes relative to the first)
      for (const f of mateEquations({ ...m, type: 'concentric' }, world(m.a), world(m.b))) eqs.push(f);
      const R = m.ref, sgn = (m.side || 1) > 0 ? 1 : -1, v = Number(m.value) || 0;
      eqs.push(() => {
        const pa = poseAt(m.a.comp, cur), pb = poseAt(m.b.comp, cur);
        const slide = dot(sub(pb.p, R.pb), R.da) - dot(sub(pa.p, R.pa), R.da), turn = twistOf(pb.q, R.qb, R.da) - twistOf(pa.q, R.qa, R.da);
        return slide - sgn * (v / (2 * Math.PI)) * turn;
      });
      continue;
    }
    if ((m.type === 'gear' || m.type === 'rack') && m.ref) {
      // turns (and a rack's slide) since the reference poses, in the ratio the mate asks for
      const R = m.ref, sgn = (m.side || 1) > 0 ? 1 : -1, v = Number(m.value) || 0;
      if (m.type === 'gear') eqs.push(() => twistOf(poseAt(m.a.comp, cur).q, R.qa, R.da) * v + sgn * twistOf(poseAt(m.b.comp, cur).q, R.qb, R.db));
      else {
        const pin = R.pin === 'a' ? m.a.comp : m.b.comp, rack = R.pin === 'a' ? m.b.comp : m.a.comp;
        eqs.push(() => dot(sub(poseAt(rack, cur).p, R.pr), R.dr) - sgn * (v / (2 * Math.PI)) * twistOf(poseAt(pin, cur).q, R.qp, R.dp));
      }
      continue;
    }
    for (const f of mateEquations(m, world(m.a), world(m.b), m.type === 'symmetric' ? (m.s ? world(m.s) : null) : m.a2 ? world(m.a2) : null, m.b2 ? world(m.b2) : null)) eqs.push(f);
  }
  const M = eqs.length;
  const F = new Float64Array(M);
  const evalF = (Xv) => { cur = Xv; let s = 0; for (let k = 0; k < M; k++) { const v = eqs[k](); F[k] = Number.isFinite(v) ? v : 1e6; s += F[k] * F[k]; } return Math.sqrt(s); };
  const scale = Math.max(1, ...comps.flatMap((c) => c.pos.map(Math.abs)));
  let res = evalF(X), J = null;
  // (nothing free to move: the mates are met as things stand, or not)
  if (!N) return { ok: res < 1e-6 * scale, residual: res, dofs: new Map() };
  const jac = () => {
    const rows = Array.from({ length: M }, () => new Float64Array(N));
    const F0 = Float64Array.from(F);
    for (let j = 0; j < N; j++) {
      const h = j % 6 < 3 ? 1e-6 * scale : 1e-7;
      const Xp = Float64Array.from(X); Xp[j] += h;
      evalF(Xp);
      for (let k = 0; k < M; k++) rows[k][j] = (F[k] - F0[k]) / h;
    }
    evalF(X);
    return rows;
  };
  for (let it = 0; it < 80 && res > 1e-9 * scale; it++) {
    J = jac();
    const A = Array.from({ length: M }, () => new Float64Array(M));
    for (let a = 0; a < M; a++) for (let b = a; b < M; b++) { let s = 0; const ra = J[a], rb = J[b]; for (let j = 0; j < N; j++) s += ra[j] * rb[j]; A[a][b] = A[b][a] = s; }
    for (let a = 0; a < M; a++) A[a][a] += 1e-12 + 1e-9 * A[a][a];
    const y = gauss(A, Array.from(F));
    if (!y) break;
    const step = new Float64Array(N);
    for (let a = 0; a < M; a++) for (let j = 0; j < N; j++) step[j] -= J[a][j] * y[a];
    let t = 1, next = res, Xn = X;
    for (let tries = 0; tries < 10; tries++) {
      Xn = X.map((x, j) => x + t * step[j]);
      next = evalF(Xn);
      if (next < res) break;
      t /= 2;
    }
    if (!(next < res)) { evalF(X); break; }
    X = Xn;
    res = next;
    // (bake the step into the base poses: small rotations stay small)
    for (const c of free) { const ps = poseAt(c.id, X); base.set(c.id, ps); }
    X = new Float64Array(N);
    res = evalF(X);
  }
  const ok = res < 1e-6 * scale;
  if (ok) for (const c of free) { const ps = base.get(c.id); c.pos = ps.p.map(r6); c.rot = [ps.q.x, ps.q.y, ps.q.z, ps.q.w].map((x) => Math.round(x * 1e9) / 1e9); }
  // gear / rack-pinion mates relate the next motion to where things are now
  if (ok) {
    const poseNow = (id) => (id === ORIGIN ? ORIGIN_POSE : byId.get(id) ? poseOf(byId.get(id)) : null);
    const worldNow = (r) => { const ps = poseNow(r.comp); return ps && { kind: r.kind, p: toWorld(ps, r.p), n: r.n && dirWorld(ps, r.n), d: r.d && dirWorld(ps, r.d), r: r.r }; };
    for (const m of mates) if ((m.type === 'gear' || m.type === 'rack' || m.type === 'screw') && m.ref) { const r = mechRef(m, poseNow, worldNow); if (r) m.ref = r; }
  }
  // degrees of freedom left: per free component 6 less the rank of its columns (others held)
  const dofs = new Map();
  if (ok) {
    const Jn = jac();
    const rank = (cols) => {
      const rows = Jn.map((r) => cols.map((j) => r[j]));
      let rk = 0; const used = new Array(rows.length).fill(false);
      for (let c = 0; c < cols.length; c++) {
        let best = -1, bv = 1e-7;
        for (let r = 0; r < rows.length; r++) if (!used[r] && Math.abs(rows[r][c]) > bv) { bv = Math.abs(rows[r][c]); best = r; }
        if (best < 0) continue;
        used[best] = true; rk++;
        for (let r = 0; r < rows.length; r++) { if (used[r] || !rows[r][c]) continue; const k = rows[r][c] / rows[best][c]; for (let j = c; j < cols.length; j++) rows[r][j] -= k * rows[best][j]; }
      }
      return rk;
    };
    for (const c of free) { const i = col.get(c.id); dofs.set(c.id, 6 - rank([0, 1, 2, 3, 4, 5].map((k) => i + k))); }
  }
  return { ok, residual: res, dofs };
}

// ------------------------------------------------------------------ the editor
export class AssemblyEditor {
  constructor(app, doc, filePath = null) {
    this.app = app;
    this.doc = doc;
    doc.parts ||= []; doc.components ||= []; doc.mates ||= []; doc.nextId ||= 1; doc.configs ||= [];
    this.filePath = filePath;
    this.dirty = false;
    this.tabIcon = 'assembly';
    this.kindLabel = 'Assembly';
    this.parts = new Map();      // part id → { key, mesh, color, box, error }
    this.live = new Map();       // part id → the open part tab it came from
    this.sel = null;             // { kind: 'comp' | 'mate', id }
    this.pm = null;              // the open Mate Property panel
    this.undoStack = [];
    this.redoStack = [];
    this.dofs = new Map();
    this.cmTab = 'assembly';
    doc.explodes ||= [];
    doc.motions ||= [];
    doc.asmFeatures ||= [];
    this.explodeTool = null;
    this.motionTool = null;
    this.holeTool = null;
  }

  // ---------------------------------------------------------------- exploded views (the display moves only)
  offsets() {
    if (this.explodeTool?.ex) return this.explodeTool.offsets();
    const ex = this.doc.exploded && this.doc.explodes.find((x) => x.id === this.doc.exploded);
    return ex ? explodeOffsets(ex, null, this._explodeT ?? 1) : new Map();
  }
  // (the explode tool's host)
  items() { return this.doc.components.filter((c) => !this.eff(c).suppressed).map((c) => ({ id: c.id, name: c.name })); }
  itemAt(e) { return this.compAt(e)?.comp.id || null; }
  itemCenter(id) { const c = this.comp(id); return c ? this.compCenter(c) : [0, 0, 0]; }
  itemSize(id) { const c = this.comp(id), b = c && this.geo(c)?.box; return b ? Math.max(...b.max.map((x, i) => x - b.min[i])) * 1.2 : 50; }
  faceNormalAt(e) { const ch = this.compAt(e); const fi = ch && this.display.faceInfo(ch.leaf, ch.hit.face); return fi?.planar ? fi.normal.toArray() : null; }
  redisplay() { this.updateGeometry(); }
  commit(msg) { this.change(msg); }
  pmRoot() { return $('#pm'); }
  onToolClosed() { this.explodeTool = null; this.renderAll(); }
  startExplode(id = null) {
    if (this.doc.components.length < 2) { this.app.toast('Insert at least two components first'); return; }
    if (this.pm) this.cancelMate(true);
    this.begin();
    this.doc.exploded = null; this._explodeT = 1;
    this.explodeTool = new ExplodeTool(this);
    this.explodeTool.open(id);
    this.renderCommandManager();
  }
  setExploded(id, animate = false) {
    const was = this.doc.exploded;
    if (!animate) { this.doc.exploded = id || null; this._explodeT = 1; this.dirty = true; this.updateGeometry(); this.renderAll(); return; }
    const target = id || was;
    if (!target) return;
    this.doc.exploded = target;
    animateExplode((t) => { this._explodeT = t; this.buildMesh(); }, id ? 0 : 1, id ? 1 : 0, () => { this._explodeT = 1; this.doc.exploded = id || null; this.dirty = true; this.buildMesh(); this.renderAll(); });
  }
  collapseExplode() { if (this.doc.exploded) { this.doc.exploded = null; this.updateGeometry(); this.renderAll(); this.app.status('Collapsed to edit (the exploded view is kept).'); } }
  // ---------------------------------------------------------------- motion studies (motion.js)
  startMotion(id = null, play = false) {
    if (this.doc.components.length < 2) { this.app.toast('Insert and mate at least two components first'); return; }
    if (this.pm) this.cancelMate(true);
    if (this.explodeTool) this.explodeTool.close(false);
    this.collapseExplode();
    this.motionTool = new MotionTool(this);
    this.motionTool.open(id);
    this.renderCommandManager();
    if (play) this.motionTool.play();
  }
  solveView(v, opts) { const r = solveAssembly(v, opts); if (v.flexible) this.writeFlex(v); return r; }
  onMotionClosed() { this.motionTool = null; this.updateGeometry(); this.renderAll(); }
  deleteMotion(id) { this.begin(); this.doc.motions = this.doc.motions.filter((x) => x.id !== id); this.change(); }
  deleteExplode(id) { this.begin(); this.doc.explodes = this.doc.explodes.filter((x) => x.id !== id); if (this.doc.exploded === id) this.doc.exploded = null; this.change(); }
  get name() { return this.filePath ? fileStem(this.filePath) : this.doc.name; }
  get vp() { return this.app.viewport; }
  uid(prefix) { return prefix + this.doc.nextId++; }
  comp(id) { return this.doc.components.find((c) => c.id === id) || null; }

  // ---------------------------------------------------------------- configurations
  // the assembly configuration shown, and what it sets for a component / mate
  cfg() { return this.doc.activeConfig ? this.doc.configs.find((c) => c.id === this.doc.activeConfig) || null : null; }
  eff(c) {
    const o = this.cfg()?.comps?.[c.id] || {};
    return { config: 'config' in o ? o.config : (c.config ?? null), hidden: 'hidden' in o ? o.hidden : !!c.hidden, suppressed: 'suppressed' in o ? o.suppressed : !!c.suppressed };
  }
  effMate(m) { const o = this.cfg()?.mates?.[m.id]; return o ? { ...m, ...o } : m; }
  // a component / mate setting: in the configuration shown, else on the component itself
  setComp(c, key, val) {
    const cf = this.cfg();
    if (cf) { cf.comps ||= {}; (cf.comps[c.id] ||= {})[key] = val; } else c[key] = val;
  }
  setMate(m, key, val) {
    const cf = this.cfg();
    if (cf) { cf.mates ||= {}; (cf.mates[m.id] ||= {})[key] = val; } else m[key] = val;
  }
  // the assembly as the configuration shows it (suppressed components and their mates left out)
  view() {
    const comps = this.doc.components.filter((c) => !this.eff(c).suppressed), on = new Set([ORIGIN, ...comps.map((c) => c.id)]);
    const mates = this.doc.mates.map((m) => this.effMate(m)).filter((m) => on.has(m.a.comp) && on.has(m.b.comp));
    const flex = comps.filter((c) => c.flexible && this.isSub(this.part(c.part)));
    return flex.length ? this.flexView(comps, mates, flex) : { components: comps, mates };
  }
  // Flexible sub-assemblies: their components solved here as components of this assembly (ids "sub/inner", placed
  // through the sub-assembly), with the sub-assembly's own mates, and this assembly's mates on their parts moved onto
  // them. Where they end up is kept with the sub-assembly component (c.flex: { inner id: { pos, rot } }, in its frame):
  // the sub-assembly itself is not changed. A fixed component inside stays fixed only when the sub-assembly is.
  flexView(comps, mates, flex) {
    const out = comps.filter((c) => !flex.includes(c)), outMates = [], inner = new Map();
    for (const S of flex) {
      const sd = this.subView(this.part(S.part).doc, this.eff(S).config), PS = poseOf(S), rel = new Map();
      for (const c of sd.components || []) {
        if (c.suppressed) continue;
        const o = S.flex?.[c.id], pr = { p: (o?.pos || c.pos).slice(), q: new THREE.Quaternion(...(o?.rot || c.rot)).normalize() };
        rel.set(c.id, pr);
        const q = PS.q.clone().multiply(pr.q);
        out.push({ ...c, id: `${S.id}/${c.id}`, name: `${S.name} ▸ ${c.name}`, pos: toWorld(PS, pr.p), rot: [q.x, q.y, q.z, q.w], fixed: !!(S.fixed && c.fixed), _flexOf: S.id, _inner: c.id });
      }
      for (const m of sd.mates || []) if (!m.suppressed && rel.has(m.a.comp) && rel.has(m.b.comp)) outMates.push({ ...m, id: `${S.id}/${m.id}`, a: { ...m.a, comp: `${S.id}/${m.a.comp}` }, b: { ...m.b, comp: `${S.id}/${m.b.comp}` } });
      inner.set(S.id, rel);
    }
    // (a reference on a part inside a flexible sub-assembly: given in the sub-assembly's frame, moved into its part's)
    const remap = (r) => {
      const rel = inner.get(r.comp), pr = rel && r.sub?.length && rel.get(r.sub[0]);
      if (!pr) return r;
      const inv = pr.q.clone().invert(), loc = (x) => applyQ(inv, sub(x, pr.p)), dir = (d) => applyQ(inv, d);
      return { ...r, comp: `${r.comp}/${r.sub[0]}`, sub: r.sub.length > 1 ? r.sub.slice(1) : undefined, p: loc(r.p), n: r.n && dir(r.n), d: r.d && dir(r.d), pts: r.pts && r.pts.map(loc) };
    };
    for (const m of mates) outMates.push({ ...m, a: remap(m.a), b: remap(m.b) });
    return { components: out, mates: outMates, flexible: true };
  }
  // A flexible sub-assembly's component placed (world pose), kept in its frame: id "sub/inner".
  setFlexPose(id, pos, rot) {
    const [sid, iid] = String(id).split('/'), S = this.comp(sid);
    if (!S || !iid) return false;
    const PS = poseOf(S), inv = PS.q.clone().invert(), q = inv.clone().multiply(new THREE.Quaternion(...rot));
    (S.flex ||= {})[iid] = { pos: applyQ(inv, sub(pos, PS.p)), rot: [q.x, q.y, q.z, q.w] };
    return true;
  }
  writeFlex(v) { for (const c of v.components) if (c._flexOf) this.setFlexPose(c.id, c.pos, c.rot); }
  setFlexible(id, on) {
    const c = this.comp(id);
    if (!c) return;
    if (on) c.flexible = true; else { delete c.flexible; delete c.flex; }
    this.solve(); this.updateGeometry?.(); this.renderAll?.();
    this.commit(on ? 'Make flexible' : 'Make rigid');
  }
  // ---------------------------------------------------------------- sub-assemblies
  // A component can use an assembly instead of a part: a sub-assembly, kept whole (its own parts, components,
  // placements and configurations, saved inside this one or in its own .rasm file). It moves as one; its parts
  // are built and drawn through it.
  isSub(p) { return isAssembly(p?.doc); }
  // every part shown, through the sub-assemblies, in tree order:
  //   [{ ci (top component index), comp (the top component), chain (the component ids below it), p (part record),
  //      cfg (its configuration), gk (geometry key), M (THREE.Matrix4: where it sits in the top component), hidden, names }]
  leaves() {
    const out = [];
    const effIn = (doc, cfgId, c) => {
      const o = (cfgId ? (doc.configs || []).find((x) => x.id === cfgId) : null)?.comps?.[c.id] || {};
      return { config: 'config' in o ? o.config : (c.config ?? null), hidden: 'hidden' in o ? o.hidden : !!c.hidden, suppressed: 'suppressed' in o ? o.suppressed : !!c.suppressed };
    };
    const q = new THREE.Quaternion(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    const walk = (doc, M, ci, top, chain, prefix, hidden, names, depth, over = null) => {
      if (depth > 16) return; // (an assembly inside itself)
      for (const c of doc.components) {
        const e = effIn(doc, doc.activeConfig, c);
        if (e.suppressed) continue;
        const p = (doc.parts || []).find((x) => x.id === c.part);
        if (!p) continue;
        const o = over?.[c.id]; // (a flexible sub-assembly: where its component is in this assembly)
        const Mc = M.clone().multiply(new THREE.Matrix4().compose(v.set(...(o?.pos || c.pos)), q.set(...(o?.rot || c.rot)).normalize(), one));
        if (this.isSub(p)) walk(this.subView(p.doc, e.config), Mc, ci, top, [...chain, c.id], `${prefix}${p.id}>`, hidden || e.hidden, [...names, c.name], depth + 1);
        else out.push({ ci, comp: top, chain: [...chain, c.id], p, cfg: e.config, gk: `${prefix}${p.id}|${e.config || ''}`, M: Mc, hidden: hidden || e.hidden, names: [...names, c.name] });
      }
    };
    this.doc.components.forEach((c, ci) => {
      const e = this.eff(c), p = this.part(c.part);
      if (e.suppressed || !p) return;
      if (this.isSub(p)) walk(this.subView(p.doc, e.config), new THREE.Matrix4(), ci, c, [], `${p.id}>`, e.hidden, [], 1, c.flexible ? c.flex : null);
      else out.push({ ci, comp: c, chain: [], p, cfg: e.config, gk: this.geoKey(c.part, e.config) + this.cutSuffix(c.id), cut: this._cuts?.get(c.id)?.feats || null, M: new THREE.Matrix4(), hidden: e.hidden, names: [] });
    });
    return out;
  }
  // whether an assembly uses a file anywhere inside it (to keep an assembly out of itself)
  usesFile(doc, path, depth = 0) {
    if (!path || depth > 16) return false;
    return (doc.parts || []).some((p) => sameFile(p.path, path) || (isAssembly(p.doc) && this.usesFile(p.doc, path, depth + 1)));
  }
  // a sub-assembly as one of its configurations shows it
  subView(doc, cfgId) { return { ...doc, activeConfig: cfgId && (doc.configs || []).some((x) => x.id === cfgId) ? cfgId : null }; }
  // the box round a sub-assembly component's parts, in its own frame ({ min, max } or null)
  subBox(c) {
    const box = new THREE.Box3(), b = new THREE.Box3();
    const ls = this._leaves?.some((l) => l.comp === c) ? this._leaves : this.leaves();
    for (const l of ls) {
      if (l.comp !== c) continue;
      const g = this.parts.get(l.gk)?.box;
      if (g) box.union(b.set(new THREE.Vector3(...g.min), new THREE.Vector3(...g.max)).applyMatrix4(l.M));
    }
    return box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() };
  }
  // the leaf a mate reference is on (by its component and the components below it)
  leafOf(r) {
    const chain = r.sub || [];
    return (this._leaves || this.leaves()).findIndex((l) => l.comp.id === r.comp && l.chain.length === chain.length && l.chain.every((x, i) => x === chain[i]));
  }

  // a part's configurations: [[id | null, name]…]
  partConfigs(p) { return [[null, 'Default'], ...((p?.doc?.configs) || []).map((c) => [c.id, c.name])]; }
  configName(p, id) { return id ? (p?.doc?.configs || []).find((c) => c.id === id)?.name || '?' : 'Default'; }
  // the built geometry of a component (its part in its configuration)
  geoKey(partId, cfgId) { return partId + '|' + (cfgId || ''); }
  // a component's geometry: { mesh, color, box } (a sub-assembly: only the box round its parts)
  geo(c) {
    if (this.isSub(this.part(c.part))) { const box = this.subBox(c); return box ? { mesh: null, box, sub: true } : null; }
    return this.parts.get(this.geoKey(c.part, this.eff(c).config) + this.cutSuffix(c.id)) || null;
  }
  // ---------------------------------------------------------------- assembly features (asmfeatures.js)
  // The part features each component gets from the assembly's holes and cuts (this._cuts: component id →
  // { sig, feats }), worked out again when the assembly changes (not while dragging: the holes go with the
  // components then). True when they are different now.
  updateCuts() {
    const m = asmPartFeatures(this.doc), next = new Map();
    for (const [id, feats] of m) { const json = JSON.stringify(feats); next.set(id, { sig: json.length + ':' + hash(json), feats }); }
    const old = this._cuts || new Map();
    const same = old.size === next.size && [...next].every(([id, x]) => old.get(id)?.sig === x.sig);
    this._cuts = next;
    return !same;
  }
  cutSuffix(id) { const x = this._cuts?.get(id); return x ? '|x' + x.sig : ''; }
  startAsmFeature(type = 'hole', id = null) {
    if (!this.doc.components.length) { this.app.toast('Insert components first'); return; }
    if (this.pm) this.cancelMate(true);
    if (this.explodeTool) this.explodeTool.close(false);
    if (this.motionTool) this.motionTool.close(false);
    this.collapseExplode();
    this.holeTool = new HoleTool(this);
    this.holeTool.open(id, type);
    this.renderCommandManager();
  }
  onHoleToolClosed() { this.holeTool = null; this.renderAll(); }
  toggleAsmFeature(id) { const f = this.doc.asmFeatures.find((x) => x.id === id); if (!f) return; this.begin(); f.suppressed = !f.suppressed; this.loadParts().then(() => { this.solve(); this.change(`${f.name} ${f.suppressed ? 'suppressed' : 'unsuppressed'}.`); }); }
  deleteAsmFeature(id) { const f = this.doc.asmFeatures.find((x) => x.id === id); if (!f) return; this.begin(); this.doc.asmFeatures = this.doc.asmFeatures.filter((x) => x !== f); this.loadParts().then(() => { this.solve(); this.change(`${f.name} deleted (the fasteners in it are kept).`); }); }
  // A fastener in each hole of an assembly hole (feature f): through the whole stack it cuts, with washers and a
  // nut on the far side, mated in the hole. fast: { kind, washer, nut }
  async fastenHoles(f, fast) {
    const first = this.comp(f.comps[0]?.id), last = this.comp(f.comps[f.comps.length - 1]?.id);
    if (!first || first.id !== f.at.comp) return 0;
    const leaves = this._leaves || this.leaves(), li = (c) => leaves.findIndex((l) => l.comp === c && !l.chain.length);
    const meshOf = (c) => this.parts.get(leaves[li(c)]?.gk)?.mesh;
    const tapped = f.tapLast && last !== first, nut = fast.nut && !tapped;
    // (the hole's round face in a component, on the axis through p along n (world), of radius r)
    const holeIn = (c, pw, nw, r) => {
      const m = meshOf(c);
      if (!m) return null;
      const pc = poseOf(c), qi = pc.q.clone().invert(), p = applyQ(qi, sub(pw, pc.p)), n = unit(applyQ(qi, nw));
      for (let gi = 0; gi < m.faceGroups.length; gi++) {
        const s = m.faceGroups[gi].surf;
        if (s?.t !== 'CYLINDER' || Math.abs(s.r - r) > 1e-3 || len(cross(unit(s.d), n)) > 1e-4 || len(cross(sub(s.p, p), n)) > 1e-3) continue;
        return { comp: c.id, kind: 'axis', p: s.p.map(r6), d: s.d.map(r6), r: r6(s.r), face: gi, gi: `${li(c)}:f${gi}`, what: 'Cylindrical face' };
      }
      return null;
    };
    const rFirst = (holeDiameter(f, 'first') || 0) / 2, rLast = (holeDiameter(f, f.comps.length > 1 ? 'last' : 'first') || 0) / 2;
    const P = poseOf(first), nW = unit(applyQ(P.q, f.at.n));
    let n = 0;
    for (const p0 of f.at.pts) {
      const pw = toWorld(P, p0);
      const ref = holeIn(first, pw, nW, rFirst);
      const h = ref && this.holeOf(ref);
      if (!h) continue;
      // (the hole's end on the clicked face first)
      if (dot(dirWorld(P, h.end.n), nW) < 0) [h.end, h.face, h.far, h.farFace] = [h.far, h.farFace, h.end, h.face];
      // the far end: the last component's way out (put in the first one's coordinates); into a tapped last
      // component, its way in (the screw goes on into it)
      const qi = P.q.clone().invert(), local = (w) => applyQ(qi, sub(w, P.p));
      let depth = Math.abs(dot(sub(toWorld(P, h.far.p), toWorld(P, h.end.p)), nW));
      if (last !== first) {
        const rl = holeIn(last, pw, nW, tapped ? (holeDiameter({ ...f, holeType: 'tapped', thread: f.size }, 'first') || 0) / 2 : rLast);
        const hl = rl && this.holeOf(rl);
        if (hl) {
          const L = poseOf(last), out = (e) => dot(dirWorld(L, e.n), nW) < 0;
          const [e, fc] = tapped ? (out(hl.end) ? [hl.far, hl.farFace] : [hl.end, hl.face]) : (out(hl.end) ? [hl.end, hl.face] : [hl.far, hl.farFace]);
          if (!tapped) { h.far = { p: local(toWorld(L, e.p)).map(r6), n: unit(applyQ(qi, dirWorld(L, e.n))).map(r6), sign: -1 }; h.farFace = fc; }
          depth = Math.abs(dot(sub(toWorld(L, e.p), toWorld(P, h.end.p)), nW));
        }
      }
      const size = f.size, opts = { washer: !!fast.washer, nut }, dNom = parseFloat(size.slice(1)) || 0;
      // (into a tapped component: about one diameter of thread engaged)
      const L = fastenerLength(fast.kind, size, tapped ? depth + 0.2 * dNom : depth, tapped ? { washer: opts.washer, nut: false } : opts);
      await this.insertStdPart(fast.kind, size, L, 'steel', h, opts);
      n++;
    }
    return n;
  }

  setActiveConfig(id) {
    if (this.pm) this.cancelMate(true);
    this.doc.activeConfig = id || null;
    this.dirty = true;
    this.loadParts().then(() => { this.solve(); this.updateGeometry(); this.renderAll(); this.app.ui.renderConfigs?.(); });
    this.app.status(`Configuration: ${this.cfg()?.name || 'Default'}`);
  }
  addConfig(copyOf = null) {
    const base = copyOf ? this.doc.configs.find((c) => c.id === copyOf) : this.cfg();
    let k = 1;
    while (this.doc.configs.some((c) => c.id === 'acfg' + k)) k++;
    let n = this.doc.configs.length + 1, name = copyOf && base ? `Copy of ${base.name}` : 'Config' + n;
    while (this.doc.configs.some((c) => c.name === name)) name = copyOf && base ? `Copy of ${base.name} (${++n})` : 'Config' + ++n;
    this.begin();
    this.doc.configs.push({ id: 'acfg' + k, name, comps: JSON.parse(JSON.stringify(base?.comps || {})), mates: JSON.parse(JSON.stringify(base?.mates || {})) });
    this._before && this.undoStack.push(this._before); this._before = null;
    this.setActiveConfig('acfg' + k);
  }
  deleteConfig(id) {
    this.begin();
    this.doc.configs = this.doc.configs.filter((c) => c.id !== id);
    if (this.doc.activeConfig === id) this.doc.activeConfig = null;
    this.change();
    this.setActiveConfig(this.doc.activeConfig);
  }
  configSummary(cf) {
    if (!cf) return 'the assembly as built';
    const out = [];
    for (const [id, o] of Object.entries(cf.comps || {})) {
      const c = this.comp(id);
      if (!c) continue;
      if ('config' in o && o.config !== (c.config ?? null)) out.push(`${c.name}: ${this.configName(this.part(c.part), o.config)}`);
      if (o.suppressed && !c.suppressed) out.push(`${c.name} suppressed`);
      if ('suppressed' in o && !o.suppressed && c.suppressed) out.push(`${c.name} unsuppressed`);
      if (o.hidden && !c.hidden) out.push(`${c.name} hidden`);
    }
    for (const [id, o] of Object.entries(cf.mates || {})) {
      const m = this.doc.mates.find((x) => x.id === id);
      if (!m) continue;
      if ('value' in o && o.value !== m.value) out.push(`${m.name} = ${fmt(Number(o.value))}${MATE_TYPES[m.type].value === '°' ? '°' : ' mm'}`);
      if (o.suppressed && !m.suppressed) out.push(`${m.name} suppressed`);
    }
    return out.join('; ') || 'same as Default';
  }
  // the Configurations tab (drawn by the app's left panel)
  renderConfigs(root) {
    if (!root) return;
    const ui = this.app.ui;
    root.innerHTML = '';
    root.appendChild(el('div', { class: 'cfg-head' }, `${icon('configs')}<span><b>${esc(this.doc.name)}</b> Configuration(s)</span>`));
    const bar = el('div', { class: 'cfg-bar' });
    const addB = el('button', { class: 'pm-btn', title: 'A new configuration, starting as the one shown' }, '+ Add Configuration');
    addB.onclick = () => this.addConfig();
    bar.appendChild(addB);
    root.appendChild(bar);
    const active = this.doc.activeConfig || null;
    const item = (cf) => {
      const id = cf?.id || null, on = id === active;
      const n = el('div', { class: 'tn cfg-item' + (on ? ' cfg-active' : '') + (this._cfgSel === (id || '__default') ? ' selected' : ''), title: `${cf ? cf.name : 'Default'}: ${this.configSummary(cf)}\nDouble-click to show it` });
      n.innerHTML = `<span class="tw"></span><span class="ti">${icon(on ? 'ok' : 'configs')}</span><span class="tl">${esc(cf ? cf.name : 'Default')}</span><span class="tsub">${esc(this.configSummary(cf))}</span>`;
      n.onclick = () => { this._cfgSel = id || '__default'; this.renderConfigs(root); };
      n.ondblclick = () => this.setActiveConfig(id);
      n.oncontextmenu = (e) => {
        e.preventDefault();
        const items = [{ label: 'Show Configuration', icon: 'show', action: () => this.setActiveConfig(id), disabled: on }];
        if (cf) items.push(
          { label: 'Rename', icon: 'rename', action: () => ui.promptText('Rename Configuration', 'configs', 'Name', cf.name).then((v) => { if (v?.trim()) { this.begin(); cf.name = v.trim(); this.change(); ui.renderConfigs(); } }) },
          { label: 'Copy Configuration', icon: 'configs', action: () => this.addConfig(cf.id) },
          'sep',
          { label: 'Delete', icon: 'trash', action: () => this.deleteConfig(cf.id) },
        );
        else items.push({ label: 'Add Configuration', icon: 'configs', action: () => this.addConfig() });
        ui.showContext(e.clientX, e.clientY, items);
      };
      root.appendChild(n);
    };
    item(null);
    for (const cf of this.doc.configs) item(cf);
    root.appendChild(el('div', { class: 'pm-hint', style: 'padding:8px 12px' }, 'Double-click a configuration to show it. While one is shown, these change it only: a component\'s part configuration, Hide / Show, Suppress, and a mate\'s Suppress or value (Edit Mate).'));
  }
  part(id) { return this.doc.parts.find((p) => p.id === id) || null; }
  isActive() { return this.app.drawing === this; }

  // ---------------------------------------------------------------- tab life
  attach() {
    const a = this.app, vp = this.vp;
    $('#drawing').hidden = true;
    $('#viewport').hidden = false;
    $('#status-mode').textContent = 'Editing Assembly';
    // (nothing of the part shown before)
    vp.setPlanes?.([]); vp.setRefGeometry?.([], [], []); vp.setSketches?.([]); vp.setPreview?.(null); vp.setSection?.(null);
    vp.setDimTag?.(null); vp.setMeasure?.(null); vp.setVertexMarkers?.(null); vp.setEdgeHighlights?.(null);
    vp.setBody(null, null);
    // the components are drawn by an AssemblyView (each part once, placed per component)
    this.display = vp.asmView = new AssemblyView(vp);
    a.ui.showLeft('tree');
    // (left-drag moves components; the middle button turns the view, Shift + the right one pans)
    vp.setLeftRotate(false);
    this.renderAll();
    // (the mesh is built first: loadParts only asks for it on the next frame)
    this.refreshParts().then(() => this.loadParts()).then(() => { if (!this._fitted && this.isActive()) { this._fitted = true; if (this._geoFrame) this.flushGeometry(); vp.zoomToFit(); } });
    this.updateGeometry();
  }
  detach() {
    this.pm = null;
    this.vp.setLeftRotate(true);
    this.vp.setFaceSet?.([]);
    this.vp.clearFaceHighlights();
    this.vp.setVertexMarkers?.(null);
    this.vp.setEdgeHighlights?.(null);
    if (this._geoFrame) { cancelAnimationFrame(this._geoFrame.raf); clearTimeout(this._geoFrame.tm); this._geoFrame = null; }
    this._exLines = drawExplodeLines(this.vp, this._exLines, []);
    if (this.display) { this.display.dispose(); if (this.vp.asmView === this.display) this.vp.asmView = null; this.display = null; }
    this.vp.setPlanes([]); this._planeSig = null;
    $('#status-mode').textContent = 'Editing Part';
  }
  render() { this.updateGeometry(); } // (asked by the drawing pane's resize observer: nothing of its own to draw)
  renderAll() {
    if (!this.isActive()) return;
    this.renderTree();
    this.renderPM();
    this.renderCommandManager();
    this.app.updateTitle();
  }

  // ---------------------------------------------------------------- undo / changes
  // (a part copy goes in by reference: it can hold megabytes of imported geometry, and copies are replaced, never changed)
  snapshot() { return JSON.stringify({ components: this.doc.components, mates: this.doc.mates, parts: this.doc.parts.map((p) => ({ ...p, doc: this.docRef(p.doc) })), name: this.doc.name, nextId: this.doc.nextId, configs: this.doc.configs, activeConfig: this.doc.activeConfig || null, explodes: this.doc.explodes, exploded: this.doc.exploded || null, motions: this.doc.motions || [], customProps: this.doc.customProps || null, bomCols: this.doc.bomCols || null, equations: this.doc.equations || [], asmFeatures: this.doc.asmFeatures || [], upAxis: this.doc.upAxis || null }); }
  docRef(doc) {
    this._docKeys ||= new WeakMap(); this._docs ||= new Map();
    let k = this._docKeys.get(doc);
    if (!k) { k = 'doc' + (this._docs.size + 1); this._docKeys.set(doc, k); this._docs.set(k, doc); }
    return k;
  }
  begin() { this._before = this.snapshot(); }
  change(msg = null) {
    if (this._before && this._before !== this.snapshot()) { this.undoStack.push(this._before); if (this.undoStack.length > 100) this.undoStack.shift(); this.redoStack = []; }
    this._before = null;
    this.dirty = true;
    this.updateGeometry();
    this.renderAll();
    if (msg) this.app.status(msg);
    this.app.macros?.syncEditor(this);
    // (components moved or features changed: the holes and cuts again)
    if (this.updateCuts()) { this.loadParts().then(() => { this.solve(); this.updateGeometry(); this.renderAll(); }); }
  }
  restore(json) {
    const s = JSON.parse(json);
    s.parts = s.parts.map((p) => ({ ...p, doc: this._docs.get(p.doc) }));
    if (!s.equations) s.equations = [];
    if (!s.asmFeatures) s.asmFeatures = []; Object.assign(this.doc, s); if (!s.customProps) delete this.doc.customProps; if (!s.bomCols) delete this.doc.bomCols; if (!s.upAxis) delete this.doc.upAxis;
    this.app.applyUpAxis?.(); // (the up axis undone or redone with the rest)
    this.dirty = true; this.loadParts(); this.updateGeometry(); this.renderAll(); this.app.macros?.syncEditor(this); }
  undo() { const s = this.undoStack.pop(); if (!s) return; this.redoStack.push(this.snapshot()); this.restore(s); }
  redo() { const s = this.redoStack.pop(); if (!s) return; this.undoStack.push(this.snapshot()); this.restore(s); }

  // ---------------------------------------------------------------- parts and their geometry
  // bring the part (and sub-assembly) copies up to date from the open tabs, else from their files
  async refreshParts() {
    let changed = false;
    const docOf = (t) => (t.kind === 'drawing' ? (t.drawing instanceof AssemblyEditor && t.drawing !== this ? t.drawing.doc : null) : t.doc);
    for (const p of this.doc.parts) {
      let doc = null;
      const tab = this.live.get(p.id) || this.app.tabs.find((t) => docOf(t) && p.path && sameFile(t.filePath, p.path));
      if (tab && this.app.tabs.includes(tab)) doc = tab.kind === 'drawing' ? docOf(tab) : this.app.tabs.indexOf(tab) === this.app.tabIndex ? this.app.doc : tab.doc;
      else if (p.path && platform.desktop) { try { const text = await platform.readText(p.path); if (text) doc = stripThumbnail(JSON.parse(text)); } catch { /* keep the copy */ } }
      if (doc && JSON.stringify(doc) !== JSON.stringify(p.doc)) { p.doc = JSON.parse(JSON.stringify(doc)); p.name = (p.path && isDefaultName(doc.name) ? fileStem(p.path) : doc.name) || p.name; changed = true; }
    }
    if (changed) { this.dirty = true; this.app.updateTitle(); }
    return changed;
  }

  // each part's mesh, in each configuration the components use (again only when it changed). A mesh built
  // before comes from the model cache (on disk; in the browser version, the browser's store: modelcache.js, keyed
  // by a hash of the part as built), all of them at once; the kernel builds the others one by one, and they are
  // stored for next time.
  async loadParts() {
    this.applyEquationLinks();
    this.updateCuts();
    let any = false;
    // (every part shown, through the sub-assemblies; a component cut by the assembly's holes: its part with them)
    const want = new Map();
    for (const l of this.leaves()) if (!want.has(l.gk)) want.set(l.gk, [l.p, l.cfg, l.cut]);
    const jobs = [];
    for (const [gk, [p, cfgId, cut]] of want) {
      // (speed mode: a simplified display mesh, unless this one is wanted in full)
      const coarse = !!this.doc.speedMode && !this._full?.has(gk), g0 = this.parts.get(gk);
      // (the same part copy as last time: built already, without writing out and hashing it again)
      if (g0?.from === p.doc && !!g0.coarse === coarse) continue;
      const doc = { ...p.doc, activeConfig: cfgId && (p.doc.configs || []).some((x) => x.id === cfgId) ? cfgId : null, ...(cut ? { features: [...p.doc.features, ...cut] } : {}) };
      const json = JSON.stringify(doc), key = (coarse ? 'c' : '') + json.length + ':' + hash(json);
      if (g0?.key === key) { g0.from = p.doc; continue; }
      jobs.push({ gk, p, cfgId, json, key, cut: !!cut, coarse });
    }
    // (colour: the part's material's, for bodies without one of their own; p.color: an older STEP import's part colour)
    const done = (j, mesh, error = null) => {
      this.parts.set(j.gk, error ? { key: j.key, from: j.p.doc, mesh: null, error, coarse: j.coarse } : { key: j.key, from: j.p.doc, coarse: j.coarse, mesh: mesh && withPartLooks(mesh, j.p.doc), color: materialById(j.p.doc.material)?.color ?? j.p.color ?? DEFAULT_BODY_COLOR, box: mesh ? meshBox(mesh) : null });
      // (its mass, for the bill of materials: the mesh's volume and the part's material)
      if (mesh && !isAssembly(j.p.doc) && !j.cut) {
        const kg = massOf(Number.isFinite(mesh.volume) ? mesh.volume : meshVolume(mesh), j.p.doc.material), k = j.cfgId ?? ''; // (Kernel Lab: the kernel's volume)
        if (kg != null) { if (j.p.mass?.[k] !== +kg.toPrecision(6)) (j.p.mass ||= {})[k] = +kg.toPrecision(6); } else if (j.p.mass) delete j.p.mass[k];
      }
      any = true;
    };
    if (jobs.length && platform.modelStore) {
      this.app.status(`Reading ${jobs.length === 1 ? jobs[0].p.name : `${jobs.length} parts`}…`);
      await Promise.all(jobs.map(async (j) => {
        try {
          j.cacheKey = await hashText(MESH_CACHE + (j.coarse ? 'coarse|' : '') + j.json);
          const b64 = j.cacheKey && await platform.readModelCache(j.cacheKey);
          const r = b64 ? await unpackResult(b64) : null;
          if (r?.body?.vertices && r.body.edgePts) { done(j, unpackMesh(r.body)); j.cached = true; }
        } catch { /* build it */ }
      }));
      // (what was stored shows at once, while the kernel builds the rest)
      if (any && jobs.some((j) => !j.cached)) { this.resyncRefs(); this.solve(); this.updateGeometry(); this.renderAll(); }
    }
    // (the same part in several places, e.g. in two sub-assemblies, is built once; different parts side by side, in
    // the extra kernels)
    const built = new Map(), todo = [];
    for (const j of jobs) {
      if (j.cached) continue;
      if (built.has(j.key)) { built.get(j.key).push(j); continue; }
      built.set(j.key, [j]);
      todo.push(j);
    }
    // (the biggest first: the one that takes longest starts at once, not after the small ones; a 64 MB import in a
    // plant layout of 26 parts started 2 s late)
    todo.sort((a, b) => b.json.length - a.json.length);
    let left = todo.length;
    const pool = this.app.kernelPool || { each: async (xs, fn) => { for (const x of xs) await fn(x); }, request: (t, d) => this.app.kernel.request(t, d) };
    await pool.each(todo, async (j) => {
      this.app.status(left > 1 ? `Building ${left} parts…` : `Building ${j.p.name}${j.cfgId ? ` (${this.configName(j.p, j.cfgId)})` : ''}…`);
      try {
        const r = await pool.request('partMesh', { doc: j.json, coarse: !!j.coarse, withVolume: true }); // (Kernel Lab: the part's volume for the BOM's mass)
        const mesh = r.body && r.body.vertices ? r.body : null;
        for (const x of built.get(j.key)) done(x, mesh);
        // stored for next time, unless it had errors (its rebuild may come out differently)
        if (mesh && !r.errors && j.cacheKey) packResult({ body: packMesh(mesh) }).then((b64) => platform.writeModelCache(j.cacheKey, b64)).catch(() => {});
      } catch (err) {
        for (const x of built.get(j.key)) done(x, null, err.message);
        this.app.toast(`${j.p.name} could not be built: ${err.message}`, true);
      }
      left--;
      // (each part shows as soon as it is built)
      if (todo.length > 1) { this.resyncRefs(); this.updateGeometry(); }
    });
    this.app.hideProgress?.(); // (the part builds report progress like a rebuild)
    // mates on faces / edges follow the part (the same face or edge, by its number) in the configuration used
    this.resyncRefs();
    if (any) { this.solve(); this.updateGeometry(); this.renderAll(); this.app.status('Ready'); }
    if (any) this.suggestSpeedMode();
  }
  // ---------------------------------------------------------------- speed mode (very large assemblies)
  // The parts shown from simplified display meshes (the kernel meshes them coarser: the same faces and edges, so
  // mates, measuring and picking work as before, with far fewer triangles to draw and keep); a component selected
  // gets its full mesh (this._full: the part keys wanted in full). Saved with the assembly.
  setSpeedMode(on) {
    const before = this.display?.stats?.().triangles || 0;
    this.doc.speedMode = !!on || undefined;
    if (!on) delete this.doc.speedMode;
    this._full = new Set();
    this.dirty = true;
    this.renderCommandManager();
    this.app.status(on ? 'Speed mode: simplifying the parts shown…' : 'Speed mode off: loading the parts in full…');
    return this.loadParts().then(() => {
      this.updateGeometry(); this.flushGeometry?.();
      const after = this.display?.stats?.().triangles || 0;
      this.app.status(on ? `Speed mode: the parts are shown simplified (${fmtCount(before)} → ${fmtCount(after)} triangles); a component selected is loaded in full.` : `Speed mode off: the parts are shown in full (${fmtCount(after)} triangles).`);
      this.app.updateTitle?.();
      return after;
    });
  }
  // the parts of these components wanted in full (in speed mode)
  ensureFull(ids) {
    if (!this.doc.speedMode || !ids.length) return;
    this._full ||= new Set();
    let more = false;
    for (const l of this.leaves()) if (ids.includes(l.comp.id) && !this._full.has(l.gk)) { this._full.add(l.gk); more = true; }
    if (more) this.loadParts();
  }
  // (a large assembly: speed mode suggested, once)
  suggestSpeedMode() {
    if (this.doc.speedMode || this._speedHint) return;
    const st = this.display?.stats?.();
    if (!st || (st.triangles < 3e6 && this.doc.components.length < 300)) return;
    this._speedHint = true;
    this.app.status(`A large assembly (${fmtCount(st.triangles)} triangles): View ▸ Speed Mode shows it faster.`);
  }

  resyncRefs() {
    this._leaves = this.leaves();
    this.brokenMates = new Map(); // mate id → which of its two references (a / b) are no longer found
    for (const m of this.doc.mates) for (const side of ['a', 'b']) {
      const r = m[side];
      if (r.comp === ORIGIN) continue;
      const l = this._leaves[this.leafOf(r)], mesh = l && this.parts.get(l.gk)?.mesh;
      if (!mesh) continue;
      const hit = this.refind(l, mesh, r);
      if (hit === undefined) continue;
      if (!hit) { this.brokenMates.set(m.id, [...(this.brokenMates.get(m.id) || []), side]); continue; }
      Object.assign(r, { p: hit.p, n: hit.n, d: hit.d, r: hit.r });
      if (r.face !== undefined) r.face = hit.idx; else r.edge = hit.idx;
    }
    for (const m of this.doc.mates) for (const side of ['a', 'b']) if (m[side]?.holeEnd) this.resyncHoleEnd(m[side]);
  }

  // The face / edge a mate reference is on, found again after its part changed (in top-component coordinates,
  // with its number idx). By its number while that one is still exactly where it was; else the face of the same
  // kind exactly where it was (the part's faces were numbered differently, e.g. after a feature was added);
  // else the numbered one if it is still the same kind, facing the same way (it moved with a dimension); else
  // the one of the same kind and direction clearly nearest. null: gone; undefined: not a face or edge.
  refind(l, mesh, r) {
    const isFace = r.face !== undefined;
    if (!isFace && r.edge === undefined) return undefined;
    const count = isFace ? mesh.faceGroups?.length || 0 : mesh.edges?.length || 0;
    const make = (i) => {
      const x = isFace ? refOfFace(mesh, i) : refOfEdge(mesh, i, r.endAt);
      return x && x.kind === r.kind && !!x.circle === !!r.circle ? { ...this.toTop(l, x), idx: i } : null;
    };
    const dir = (x) => x.n || x.d;
    const parallel = (x) => {
      const a = dir(x), b = dir(r);
      if (!a || !b) return !a && !b;
      return r.kind === 'plane' ? dot(a, b) > 0.999 : Math.abs(dot(a, b)) > 0.999;
    };
    // how far from where it was: a plane's offset, an axis's distance (and change of radius), a point's distance
    const dist = (x) => r.kind === 'plane' ? Math.abs(dot(sub(x.p, r.p), r.n))
      : r.kind === 'axis' ? len(cross(sub(x.p, r.p), unit(r.d))) + Math.abs((x.r || 0) - (r.r || 0))
      : len(sub(x.p, r.p));
    const TOL = 1e-5;
    const own = isFace ? r.face : r.edge;
    const cur = own < count ? make(own) : null;
    if (cur && parallel(cur) && dist(cur) < TOL) return cur;
    const cands = [];
    for (let i = 0; i < count; i++) { const x = make(i); if (x && parallel(x)) cands.push([dist(x), x]); }
    const exact = cands.filter(([d]) => d < TOL).map(([, x]) => x);
    if (exact.length) return exact.sort((x, y) => len(sub(x.p, r.p)) - len(sub(y.p, r.p)))[0];
    if (cur && parallel(cur)) return cur;
    cands.sort((x, y) => x[0] - y[0]);
    if (cands.length && (cands.length === 1 || cands[1][0] > cands[0][0] * 1.6)) return cands[0][1];
    return null;
  }

  // The mates whose faces / edges are no longer found in their parts: what each one lost, and ways to fix it.
  showBrokenMates() {
    const ui = this.app.ui, body = document.createElement('div');
    body.className = 'fixrefs';
    const render = () => {
      const bad = this.doc.mates.filter((m) => this.brokenMates?.has(m.id));
      if (!bad.length) { body.innerHTML = '<p>Every mate finds its faces and edges.</p>'; return; }
      body.innerHTML = `<p class="pm-hint">${bad.length} mate${bad.length > 1 ? 's have' : ' has'} a face or edge that is no longer in its part (it keeps its last position for now). Edit the mate to pick it again, or suppress or delete it.</p>`;
      const tbl = document.createElement('table');
      tbl.className = 'grid';
      tbl.innerHTML = '<tr><th>Mate</th><th>Not found</th><th></th></tr>';
      for (const m of bad) {
        const tr = document.createElement('tr');
        const lost = this.brokenMates.get(m.id).map((k) => `${m[k].what || 'Reference'} of ${this.comp(m[k].comp)?.name || '?'}`).join(', ');
        tr.innerHTML = `<td>${icon(MATE_TYPES[m.type]?.icon || 'mate')} ${esc(m.name)}</td><td>${esc(lost)}</td>`;
        const td = document.createElement('td');
        td.className = 'fix-acts';
        const btn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; td.appendChild(b); };
        btn('Edit', () => { dlg.close(); this.startMate(m.id); });
        btn(this.effMate(m).suppressed ? 'Unsuppress' : 'Suppress', () => { this.toggleMate(m.id); render(); });
        btn('Delete', () => { this.deleteMate(m.id); render(); });
        tr.appendChild(td);
        tbl.appendChild(tr);
      }
      body.appendChild(tbl);
    };
    render();
    const dlg = ui.modal('Fix Mates', 'fix', body, [{ label: 'Close', primary: true }]);
  }
  // a reference in a part's own coordinates → in its top component's (through the sub-assemblies it is in)
  toTop(l, r) {
    if (!l.chain.length) return r;
    const out = { ...r }, M = l.M;
    if (r.p) out.p = new THREE.Vector3(...r.p).applyMatrix4(M).toArray().map(r6);
    for (const k of ['n', 'd']) if (r[k]) out[k] = new THREE.Vector3(...r[k]).transformDirection(M).toArray().map(r6);
    return out;
  }

  // ---------------------------------------------------------------- the view: each part drawn at its components
  updateGeometry() {
    if (!this.isActive()) return;
    if (this._geoFrame) return;
    // (next frame; a timer too, as frames pause while the window is in the background)
    const run = () => this.flushGeometry();
    this._geoFrame = { raf: requestAnimationFrame(run), tm: setTimeout(run, 40) };
  }
  flushGeometry() {
    if (!this._geoFrame) return;
    cancelAnimationFrame(this._geoFrame.raf); clearTimeout(this._geoFrame.tm); this._geoFrame = null;
    this.buildMesh();
  }
  // Each part shown (through the sub-assemblies) placed by its component's placement, with its exploded-view
  // offset, as a matrix: all a move changes on the graphics card.
  buildMesh() {
    if (!this.isActive() || !this.display) return;
    const offs = this.offsets();
    const q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    const tops = this.doc.components.map((c) => {
      const o = offs.get(c.id);
      p.set(...(o ? c.pos.map((x, k) => x + o[k]) : c.pos));
      return new THREE.Matrix4().compose(p, q.set(...c.rot).normalize(), one);
    });
    this._leaves = this.leaves();
    this._shownGk ||= new Map();
    this.display.update(this._leaves.map((l) => {
      // (a component whose cuts changed shows as it was until it is built again)
      let g = this.parts.get(l.gk);
      const key = l.chain.length ? null : l.comp.id;
      if (g?.mesh) { if (key) this._shownGk.set(key, l.gk); } else if (key && this._shownGk.has(key)) g = this.parts.get(this._shownGk.get(key));
      if (!g?.mesh) return null;
      return { mesh: g.mesh, color: g.color ?? DEFAULT_BODY_COLOR, hidden: !!l.hidden, matrix: tops[l.ci].clone().multiply(l.M) };
    }));
    this._exLines = drawExplodeLines(this.vp, this._exLines, this.showLines === false ? [] : [...offs].filter(([id, o]) => Math.hypot(...o) > 1e-9 && this.comp(id)).map(([id, o]) => { const a = this.compCenter(this.comp(id)); return [a, a.map((x, k) => x + o[k])]; }));
    this.highlight();
  }

  // ---------------------------------------------------------------- picking
  // the (top-level) component under the mouse: { comp, hit: { point, face (the part's face number) }, bi (its index),
  // leaf (the part shown that was hit: an index in this._leaves) }. A part inside a sub-assembly picks the sub-assembly.
  compAt(e) {
    const hit = this.display?.pick(e);
    const l = hit && hit.face >= 0 && this._leaves?.[hit.comp];
    return l ? { comp: l.comp, hit, bi: l.ci, leaf: hit.comp } : null;
  }
  // What is under the mouse, as the selection filter allows (as in part files: vertices, edges, faces and the
  // assembly's planes, whichever is under the cursor in that order; with the body filter, whole components).
  // A face, edge or vertex comes as a mate reference in its top component's coordinates (sub: the components
  // below it when it is on a part inside a sub-assembly); a component as { kind: 'comp', comp }.
  // forMate: only what a mate can use (faces that are flat, round…; no whole components).
  entityAt(e, forMate = false) {
    const view = this.display;
    if (!view || !this._leaves) return null;
    const allows = (k) => this.app.allows(k);
    const inv = (c) => { const ps = poseOf(c); const qi = ps.q.clone().invert(); return (w) => applyQ(qi, sub(w, ps.p)); };
    const subOf = (l) => (l.chain.length ? { sub: l.chain } : {});
    if (allows('vertex')) {
      const vx = view.pickVertex(e, 7);
      const vl = vx && this._leaves[vx.comp];
      if (vl) return { comp: vl.comp.id, kind: 'point', p: inv(vl.comp)(vx.point.toArray()).map(r6), what: 'Vertex', world: vx.point.toArray(), gi: `${vx.comp}:v${vx.point.toArray().map((x) => Math.round(x * 1e4)).join(',')}` };
    }
    if (allows('edge')) {
      const ed = view.pickEdge(e, 5);
      const l = ed && this._leaves[ed.comp], m = l && this.parts.get(l.gk)?.mesh;
      if (m) {
        const r = refOfEdge(m, ed.edge), gi = `${ed.comp}:e${ed.edge}`;
        if (r) return { comp: l.comp.id, ...this.toTop(l, r), edge: ed.edge, ...subOf(l), gi };
        if (!forMate) return { comp: l.comp.id, kind: 'edge', what: 'Edge', edge: ed.edge, ...subOf(l), gi };
      }
    }
    const ch = this.compAt(e);
    if (ch && allows('face')) {
      const l = this._leaves[ch.leaf], m = this.parts.get(l.gk)?.mesh;
      const r = m && refOfFace(m, ch.hit.face), gi = `${ch.leaf}:f${ch.hit.face}`;
      if (r) return { comp: ch.comp.id, ...this.toTop(l, r), face: ch.hit.face, ...subOf(l), gi };
      if (forMate) { this.app.toast('That face is not flat, cylindrical, conical or spherical: pick another face, an edge or a vertex'); return null; }
      return { comp: ch.comp.id, kind: 'face', what: 'Face', face: ch.hit.face, ...subOf(l), gi };
    }
    if (ch && !forMate && allows('body')) return { kind: 'comp', comp: ch.comp.id };
    if (allows('plane') && !ch) { const ph = this.vp.pickPlane(e); if (ph && G.STD_PLANES[ph.id]) return { ...originRef(ph.id), gi: 'plane:' + ph.id }; }
    return null;
  }
  // a selected reference the same as another
  sameRef(a, b) { return a.comp === b.comp && (a.gi && a.gi === b.gi || (a.comp === ORIGIN && a.plane === b.plane)); }
  // the references selected in the view (faces, edges, vertices, planes: as in part files, Ctrl adds or takes away)
  pickRef(r, add = false) {
    const cur = this.sel?.kind === 'refs' ? this.sel.refs : [];
    const has = cur.some((x) => this.sameRef(x, r));
    const refs = add ? (has ? cur.filter((x) => !this.sameRef(x, r)) : [...cur, r]) : [r];
    this.select(refs.length ? { kind: 'refs', refs } : null);
    if (refs.length) this.app.status(refs.length === 1 ? `${this.refLabel(r)} selected — right-click for more, or M to mate it.` : `${refs.length} selected — M mates the first two.`);
  }
  // the component a selection is on (a component, or the first face / edge / vertex's)
  selComp() {
    if (this.sel?.kind === 'comp') return this.comp(this.sel.id);
    if (this.sel?.kind === 'refs') { const r = this.sel.refs.find((x) => x.comp !== ORIGIN); return r ? this.comp(r.comp) : null; }
    return null;
  }
  refLabel(r) { if (r.comp === ORIGIN) return r.what; const c = this.comp(r.comp); return `${r.what} of ${c?.name || '?'}`; }
  // a component's pose now (the assembly's origin: where it is)
  poseOfId(id) { if (id === ORIGIN) return ORIGIN_POSE; const c = this.comp(id); return c ? poseOf(c) : null; }
  // a ref placed by its component's pose now
  // Section View: started (from the flat face selected, if one is), or, with a cut on and its panel closed, the panel
  // opened again
  toggleSection() { if (this.vp.section && !this.app.pm) this.app.reopenSection(); else this.app.startSection(); }

  // The section plane of a component's flat face (a mate reference: r, or the one selected): { plane: 'custom', custom }
  sectionPlaneOf(r = this.sel) {
    if (r?.kind !== 'plane' || !r.comp) return null;
    const w = this.worldRef(r);
    if (!w?.n) return null;
    const v = (x) => new THREE.Vector3(...x);
    return { plane: 'custom', custom: { o: v(w.p), n: v(w.n).normalize(), name: `${this.comp(r.comp)?.name || 'Component'}: face` } };
  }

  worldRef(r) {
    const ps = this.poseOfId(r.comp);
    if (!ps) return null;
    return { kind: r.kind, p: toWorld(ps, r.p), n: r.n && dirWorld(ps, r.n), d: r.d && dirWorld(ps, r.d), r: r.r, len: r.len, pts: r.pts && r.pts.map((q) => toWorld(ps, q)) };
  }

  // ---------------------------------------------------------------- solving
  solve(opts) {
    const v = this.view(), r = solveAssembly(v, opts);
    if (v.flexible) this.writeFlex(v);
    // (pattern copies placed from their seeds, where these are now)
    if (this.doc.compPatterns?.length && applyCompPatterns(this.doc, (b) => this.uid(b))) this.loadParts?.();
    this.solveOk = r.ok;
    if (r.ok) this.dofs = r.dofs || new Map();
    return r;
  }

  // ---------------------------------------------------------------- viewport input (routed here by the app)
  vpEvent(kind, e) {
    // (a motion study is open: the view only turns, pans and zooms)
    if (this.motionTool && ['down', 'move', 'up', 'click', 'dbl', 'context'].includes(kind)) return;
    if (this.holeTool) {
      if (kind === 'click') return this.holeTool.click(e);
      if (kind === 'hover') { const ch = this.compAt(e); this.hoverComp = ch?.comp.id || null; this.highlight(); }
      return;
    }
    const t = this.explodeTool;
    if (t) {
      if (kind === 'down') return t.down(e);
      if (kind === 'move') return t.move(e);
      if (kind === 'up') return t.up(e);
      if (kind === 'click') return t.click(e);
      if (kind === 'hover') { const ch = this.compAt(e); this.hoverComp = ch?.comp.id || null; this.highlight(); return; }
      return;
    }
    // (the Section View panel open: a click on a component's flat face cuts from it; the arrow is dragged by the app)
    if (this.app.pm?.kind === 'section') {
      if (kind === 'click') {
        const r = this.entityAt(e, true), from = r && this.sectionPlaneOf(r);
        if (from) { Object.assign(this.app.activeSection(), from, { offset: 0 }); this.app.applySection(); this.app.ui.renderPM(); } else if (r) this.app.toast('Click a flat face to cut from it');
        return;
      }
      if (kind === 'hover') { const on = this.vp.sectionArrowAt(e); this.vp.setSectionArrowHover(on); this.vp.canvas.style.cursor = on ? 'grab' : 'default'; return; }
      if (kind === 'down' || kind === 'up' || kind === 'dbl' || kind === 'move') return;
    }
    if (kind === 'down') return this.onDown(e);
    if (kind === 'move') return this.onMove(e);
    if (kind === 'up') return this.onUp(e);
    if (kind === 'click') return this.onClick(e);
    if (kind === 'hover') return this.onHover(e);
    if (kind === 'context') return this.onContext(e);
    if (kind === 'leave') { this.hoverRef = null; this.hoverComp = null; this.highlight(); }
    if (kind === 'dbl') return this.onDouble(e);
  }
  onDown(e) {
    if (e.button !== 0 || this.pm) return;
    const ch = this.compAt(e);
    if (!ch) return;
    if (this.doc.exploded) { this.collapseExplode(); return; }
    if (ch.comp.fixed) { this.dragNote = `${ch.comp.name} is fixed (right-click ▸ Float to move it).`; return; }
    const dir = new THREE.Vector3();
    this.vp.camera.getWorldDirection(dir);
    const ps = poseOf(ch.comp);
    const center = this.compCenter(ch.comp);
    this.drag = { comp: ch.comp, from: ch.hit.point.toArray(), n: dir, pose: ps, center, x: e.clientX, y: e.clientY, rotate: e.altKey, moved: false, before: this.snapshot() };
    // (collision detection: the poses at the start, the last poses without a collision, and the parts that overlap
    // already, which are left out)
    if (this.collideMode !== 'off') {
      this.drag.start = this.doc.components.map((c) => ({ pos: c.pos.slice(), rot: c.rot.slice() }));
      this.drag.free = this.drag.start;
      this.drag.overlap = new Set(findCollisions(this.collideItems()).map(([i, j]) => i + '|' + j));
      this.clash = null;
    }
  }
  onMove(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
    d.moved = true;
    const c = d.comp;
    if (d.rotate || e.altKey) {
      // turn it about its centre: across the screen about the view's up, up and down about its right
      const cam = this.vp.camera, up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion), right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      const qd = new THREE.Quaternion().setFromAxisAngle(up, (e.clientX - d.x) * 0.01).multiply(new THREE.Quaternion().setFromAxisAngle(right, (e.clientY - d.y) * 0.01));
      const q = qd.clone().multiply(d.pose.q);
      const p = add(applyQ(qd, sub(d.pose.p, d.center)), d.center);
      c.pos = p; c.rot = [q.x, q.y, q.z, q.w];
    } else {
      const to = this.vp.rayPlane(e, { n: d.n, o: new THREE.Vector3(...d.from) }).toArray();
      c.pos = add(d.pose.p, sub(to, d.from));
      c.rot = [d.pose.q.x, d.pose.q.y, d.pose.q.z, d.pose.q.w];
    }
    // the mates: first with it held where the mouse put it, else it slides along what they allow
    const keep = JSON.stringify(this.doc.components);
    let r = this.solve({ pinned: new Set([c.id]) });
    if (!r.ok) {
      const back = JSON.parse(keep);
      r = this.solve();
      if (!r.ok) Object.assign(this.doc.components, back.map((x, i) => Object.assign(this.doc.components[i], x)));
    }
    if (d.start) this.dragCollisions(d);
    this.updateGeometry();
  }
  // While dragging with collision detection on: the parts that run into others shown in red, and with Stop at
  // Collisions the components kept where they last were clear.
  dragCollisions(d) {
    const moving = new Set(this.doc.components.filter((c, i) => !samePose(c, d.start[i])).map((c) => c.id));
    if (!moving.size) { this.clash = null; this.highlight(); return; }
    const leaves = this.leaves(), pairs = findCollisions(this.collideItems(leaves), { moving, skip: d.overlap });
    if (!pairs.length) {
      d.free = this.doc.components.map((c) => ({ pos: c.pos.slice(), rot: c.rot.slice() }));
      if (this.clash) { this.clash = null; this.highlight(); this.app.status(''); }
      return;
    }
    this.clash = [...new Set(pairs.flat())];
    const names = pairs.slice(0, 3).map(([i, j]) => `${leafName(leaves[i])} and ${leafName(leaves[j])}`).join('; ');
    if (this.collideMode === 'stop') {
      // (brought up to the collision: the way from the last clear poses to these halved a few times)
      const to = this.doc.components.map((c) => ({ pos: c.pos.slice(), rot: c.rot.slice() }));
      const at = (t) => this.doc.components.forEach((c, i) => {
        const f = d.free[i], g = to[i];
        c.pos = f.pos.map((x, k) => x + (g.pos[k] - x) * t);
        const q = new THREE.Quaternion(...f.rot).slerp(new THREE.Quaternion(...g.rot), t);
        c.rot = [q.x, q.y, q.z, q.w];
      });
      let lo = 0, hi = 1;
      for (let k = 0; k < 10; k++) { const m = (lo + hi) / 2; at(m); if (findCollisions(this.collideItems(leaves), { moving, skip: d.overlap, first: true }).length) hi = m; else lo = m; }
      at(lo);
      d.free = this.doc.components.map((c) => ({ pos: c.pos.slice(), rot: c.rot.slice() }));
      this.app.status(`Stopped at a collision: ${names}.`);
    } else this.app.status(`Collision: ${names}.`);
    this.highlight();
  }
  // ---------------------------------------------------------------- collisions
  // 'off' | 'show' (parts that collide shown in red while dragging) | 'stop' (and the drag stops at them)
  get collideMode() { return this.app.ui.prefs?.collide || 'off'; }
  setCollideMode(m) {
    const ui = this.app.ui;
    (ui.prefs ||= {}).collide = m;
    ui.savePrefs?.();
    this.clash = null;
    this.highlight();
    this.renderCommandManager();
    this.app.status(m === 'off' ? 'Collision detection off.' : m === 'stop' ? 'Collision detection: dragged components stop where they would run into others.' : 'Collision detection: parts that run into others are shown in red while dragging.');
  }
  // the parts shown, placed as their components are now (not exploded): [{ mesh, matrix, owner }] by leaf
  collideItems(leaves = this.leaves()) {
    const q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    const tops = this.doc.components.map((c) => new THREE.Matrix4().compose(p.set(...c.pos), q.set(...c.rot).normalize(), one));
    return leaves.map((l) => { const g = this.parts.get(l.gk); return g?.mesh && !l.hidden ? { mesh: g.mesh, matrix: tops[l.ci].clone().multiply(l.M), owner: l.comp.id } : null; });
  }
  // the components that collide now: [[name, name]…]
  collisions(opts = {}) {
    const leaves = this.leaves();
    return findCollisions(this.collideItems(leaves), opts).map(([i, j]) => [leafName(leaves[i]), leafName(leaves[j])]);
  }
  onUp() {
    const d = this.drag;
    this.drag = null;
    if (!d) { if (this.dragNote) { this.app.status(this.dragNote); this.dragNote = null; } return; }
    const clash = this.clash;
    if (clash) { this.clash = null; this.highlight(); }
    if (d.moved) { this._before = d.before; this.change(clash && this.collideMode === 'stop' ? `${d.comp.name} moved (stopped at a collision).` : `${d.comp.name} moved.`); }
  }
  onClick(e) {
    if (this.pm) {
      const r = this.entityAt(e, true);
      if (!r) return;
      this.pmPick(r);
      return;
    }
    // (as the selection filter allows: a face, edge, vertex or plane, or with the body filter a component)
    const r = this.entityAt(e), add = e.ctrlKey || e.metaKey;
    if (!r) { if (!add) this.select(null); return; }
    if (r.kind === 'comp') this.select({ kind: 'comp', id: r.comp });
    else this.pickRef(r, add);
  }
  onDouble(e) { const ch = this.compAt(e); if (ch) this.openPart(ch.comp.id); }
  onHover(e) {
    if (this.drag) return;
    const r = this.entityAt(e, !!this.pm);
    this.hoverComp = r?.kind === 'comp' ? r.comp : null;
    this.hoverRef = r && r.kind !== 'comp' ? r : null;
    this.highlight();
  }
  onContext(e) {
    const r = this.entityAt(e);
    const c = r && r.comp !== ORIGIN ? this.comp(r.comp) : null;
    if (r && r.kind !== 'comp' && !(this.sel?.kind === 'refs' && this.sel.refs.some((x) => this.sameRef(x, r)))) this.pickRef(r);
    if (r?.kind === 'comp') this.select({ kind: 'comp', id: r.comp });
    if (r) {
      const mate = { label: 'Mate…', icon: 'mate', key: 'M', action: () => this.startMate() };
      this.app.ui.showContext(e.clientX, e.clientY, r.kind === 'comp' || !c ? (c ? this.compMenu(c) : [mate]) : [mate, 'sep', ...this.compMenu(c)]);
      return;
    }
    this.app.ui.showContext(e.clientX, e.clientY, [
      { label: 'Insert Components…', icon: 'insertComponent', action: () => this.insertComponents() },
      { label: 'Mate', icon: 'mate', action: () => this.startMate() },
      'sep',
      { label: 'Zoom to Fit', icon: 'zoomfit', action: () => this.vp.zoomToFit() },
    ]);
  }

  compCenter(c) {
    const box = this.geo(c)?.box;
    const mid = box ? box.min.map((x, i) => (x + box.max[i]) / 2) : [0, 0, 0];
    return toWorld(poseOf(c), mid);
  }

  select(s) {
    this.sel = s;
    if (this.doc.speedMode) this.ensureFull(s?.kind === 'comp' ? [s.id] : s?.kind === 'refs' ? s.refs.map((r) => r.comp) : []);
    this.highlight();
    this.renderTree();
    this.renderPM();
    this.renderCommandManager();
    if (s?.kind === 'comp') { const c = this.comp(s.id); this.app.status(`${c.name} selected — drag it to move it (Alt+drag turns it), right-click for more.`); }
    this.updatePlanes();
  }

  // a standard plane shown: as set for it in this assembly (its eye in the tree), else as View ▸ Show Planes says
  planeShown(key) { const v = this.doc.planeVis?.[key]; return v !== undefined ? !!v : !!this.app.showPlanes; }
  setPlaneShown(key, on) {
    this.doc.planeVis ||= {};
    this.doc.planeVis[key] = on;
    this.dirty = true;
    this.app.updateTitle();
    this.updatePlanes();
    this.renderTree();
  }
  // the assembly's own planes (Front, Top, Right) in the view: when planes are shown (View ▸ Show Planes), while
  // a mate is being made, or when one is selected or under the cursor
  updatePlanes() {
    if (!this.isActive()) return;
    const refs = this.pm ? this.pm.picks : this.sel?.kind === 'refs' ? this.sel.refs : this.sel?.kind === 'mate' ? (([m]) => (m ? [m.a, m.b] : []))(this.doc.mates.filter((m) => m.id === this.sel.id)) : [];
    const on = new Set(refs.filter((r) => r.comp === ORIGIN && r.kind === 'plane').map((r) => r.plane));
    const hover = this.hoverRef?.comp === ORIGIN ? this.hoverRef.plane : this.hoverPlane || null;
    const list = [];
    for (const key of Object.keys(G.STD_PLANES)) {
      if (!(this.planeShown(key) || this.pm || on.has(key) || hover === key)) continue;
      list.push({ id: key, name: G.STD_PLANES[key].name, frame: G.stdFrame(key), state: on.has(key) ? 'selected' : hover === key ? 'hover' : 'normal' });
    }
    const sig = JSON.stringify(list.map((p) => p.id + p.state));
    if (sig !== this._planeSig || this.vp.planeGroup.children.length !== list.length) { this._planeSig = sig; this.vp.setPlanes(list); }
  }

  // ---------------------------------------------------------------- highlights
  highlight() {
    const vp = this.vp, view = this.display;
    if (!this.isActive() || !view) return;
    const bi = (id) => this.doc.components.findIndex((c) => c.id === id);
    // (a component's parts shown: one, or all of a sub-assembly's)
    const leavesOf = (id) => (id ? (this._leaves || []).map((l, i) => (l.comp.id === id ? i : -1)).filter((i) => i >= 0) : []);
    const sel = this.sel?.kind === 'comp' ? leavesOf(this.sel.id) : [];
    const hov = this.hoverComp && this.hoverComp !== this.sel?.id ? leavesOf(this.hoverComp) : [];
    // the faces / edges / vertices selected, of the mate being made, or of the selected mate (blue), and the one
    // under the cursor (orange)
    const refs = this.pm ? this.pm.picks : this.sel?.kind === 'refs' ? this.sel.refs : this.sel?.kind === 'mate' ? (([m]) => (m ? [m.a, m.b] : []))(this.doc.mates.filter((m) => m.id === this.sel.id)) : [];
    const faceInfos = [], edgesSel = [], pts = [];
    let hoverFace = null, hoverEdges = [], hoverPt = null;
    const hr = this.hoverRef && !refs.some((x) => this.sameRef(x, this.hoverRef)) ? this.hoverRef : null;
    for (const r of [...refs, ...(hr ? [hr] : [])]) {
      if (r.comp === ORIGIN) continue; // (planes are drawn by updatePlanes)
      if (bi(r.comp) < 0) continue;
      const li = this.leafOf(r), isHover = r === hr;
      if (r.face !== undefined) { const fi = li >= 0 && view.faceInfo(li, r.face); if (fi) { if (isHover) hoverFace = fi; else faceInfos.push(fi); } }
      else if (r.edge !== undefined) { if (li >= 0) (isHover ? hoverEdges : edgesSel).push([li, r.edge]); }
      else { const w = toWorld(poseOf(this.comp(r.comp)), r.p); if (isHover) hoverPt = w; else pts.push(w); }
    }
    vp.setFaceSet?.(faceInfos, 'pm');
    vp.setFaceHighlight('hover', hoverFace);
    view.setHighlights({ selected: sel, hover: refs.length ? [] : hov, edges: edgesSel, hoverEdges, clash: this.clash || [] });
    vp.setVertexMarkers?.(pts.length || hoverPt ? { selected: pts, hover: hoverPt } : null);
    if (this.holeTool) this.holeTool.markers(); // (the points of the hole or cut being made)
    this.updatePlanes();
  }

  // ---------------------------------------------------------------- components
  async insertComponents() {
    const a = this.app;
    const parts = a.tabs.map((t, i) => ({ t, i })).filter(({ t }) => t.kind !== 'drawing' && (t.doc || false));
    const body = el('div');
    body.appendChild(el('p', {}, 'Insert a part as a component. It is placed beside what is there; then drag it or add mates.'));
    const list = el('div', { class: 'pm-list' });
    let chosen = null;
    const pick = (li, val) => { list.querySelectorAll('.li').forEach((x) => x.classList.remove('active')); li.classList.add('active'); chosen = val; };
    for (const { t, i } of parts) {
      const doc = i === a.tabIndex ? a.doc : t.doc;
      if (!doc?.features?.length) continue;
      const li = el('div', { class: 'li' }, `${icon('part')}<span>${esc(doc.name)}</span><span class="pm-hint" style="margin-left:auto">${t.filePath ? 'open' : 'open, not saved'}</span>`);
      li.onclick = () => pick(li, { doc, path: i === a.tabIndex ? a.filePath : t.filePath, tab: t });
      li.ondblclick = () => { pick(li, { doc, path: i === a.tabIndex ? a.filePath : t.filePath, tab: t }); dlg.close(); go(); };
      list.appendChild(li);
    }
    for (const p of this.doc.parts) {
      const li = el('div', { class: 'li' }, `${icon('component')}<span>${esc(p.name)}</span><span class="pm-hint" style="margin-left:auto">in this assembly</span>`);
      li.onclick = () => pick(li, { existing: p.id });
      li.ondblclick = () => { pick(li, { existing: p.id }); dlg.close(); go(); };
      list.appendChild(li);
    }
    if (!list.children.length) list.appendChild(el('div', { class: 'pm-hint', style: 'padding:6px' }, 'No parts open — browse for a part file.'));
    body.appendChild(list);
    // the configuration of the part to use (when it has some)
    const cfgRow = el('div', { class: 'asm-cfgrow', style: 'margin-top:8px;display:none' }, '<label class="pm-label">Configuration</label>');
    const cfgSel = el('select');
    cfgRow.appendChild(cfgSel);
    body.appendChild(cfgRow);
    const showCfgs = () => {
      const doc = chosen?.existing ? this.part(chosen.existing)?.doc : chosen?.doc;
      const list2 = [[null, 'Default'], ...((doc?.configs) || []).map((c) => [c.id, c.name])];
      cfgSel.innerHTML = '';
      for (const [id, name] of list2) { const o = el('option', { value: id || '' }, esc(name)); if ((doc?.activeConfig || null) === id) o.selected = true; cfgSel.appendChild(o); }
      cfgRow.style.display = list2.length > 1 ? '' : 'none';
    };
    list.addEventListener('click', () => setTimeout(showCfgs, 0));
    const go = async () => {
      if (!chosen) return;
      const cfg = cfgRow.style.display === 'none' ? undefined : cfgSel.value || null;
      if (chosen.existing) return this.addComponent(chosen.existing, cfg);
      const pid = this.addPart(chosen.doc, chosen.path, chosen.tab);
      await this.addComponent(pid, cfg);
    };
    const browse = async () => {
      const f = await platform.openText();
      if (!f?.content) return;
      try {
        const doc = JSON.parse(f.content);
        // (a part, or an assembly: it goes in whole, as a sub-assembly)
        if (!Array.isArray(doc.features) && !isAssembly(doc)) throw new Error('Not a RazorCAD part or assembly file');
        if (isAssembly(doc) && (sameFile(f.path, this.filePath) || this.usesFile(doc, this.filePath))) throw new Error('An assembly cannot go inside itself');
        stripThumbnail(doc);
        const pid = this.addPart(doc, f.path || null, null);
        const cfgs = doc.configs || [];
        let cfg;
        if (cfgs.length) {
          // (which configuration of it)
          const pick = await a.ui.choose('Part Configuration', 'configs', `<p><b>${esc(doc.name)}</b> has configurations: which one should the component use?</p>`, [[ '', 'Default', !doc.activeConfig ], ...cfgs.map((c) => [c.id, c.name, doc.activeConfig === c.id])]);
          if (pick === null) return;
          cfg = pick || null;
        }
        await this.addComponent(pid, cfg);
      } catch (err) { a.toast('Could not insert it: ' + err.message, true); }
    };
    const dlg = a.ui.modal('Insert Components', 'insertComponent', body, [
      { label: 'Browse for a Part or Assembly…', action: () => { browse(); } },
      { label: 'Insert', primary: true, action: () => { go(); } },
      { label: 'Cancel' },
    ]);
  }

  // ---------------------------------------------------------------- standard parts
  // Where along an axis the coaxial cylindrical faces of radius rad reach (a hole or shaft, end to end), in its top
  // component's coordinates: [t0, t1] from the point p along d, or null when there are none.
  axisExtent(l, mesh, p, d, rad) {
    let t0 = Infinity, t1 = -Infinity;
    if (mesh) mesh.faceGroups.forEach((g, gi) => {
      const x = refOfFace(mesh, gi);
      if (!x || x.kind !== 'axis') return;
      const t = this.toTop(l, x);
      if (Math.abs(t.r - rad) > 1e-4 || len(cross(unit(t.d), d)) > 1e-4 || len(cross(sub(t.p, p), d)) > 1e-4) return;
      for (let k = g.start; k < g.start + g.count; k++) {
        const v = mesh.triangles[k] * 3, w = this.toTop(l, { p: [mesh.vertices[v], mesh.vertices[v + 1], mesh.vertices[v + 2]] }).p;
        const s = dot(sub(w, p), d);
        if (s < t0) t0 = s;
        if (s > t1) t1 = s;
      }
    });
    return t1 > t0 ? [t0, t1] : null;
  }
  // The hole a picked round face or edge is: its axis and radius, how deep it is, its end that faces the camera
  // (near) and the other one (far), each with the flat face there as a mate reference (a plane of its own where
  // there is none, found again from the hole when the part changes). In its top component's coordinates.
  holeOf(r) {
    if (!r || r.comp === ORIGIN || r.kind !== 'axis' || !(r.r > 0) || !r.d) return null;
    const li = this.leafOf(r), l = (this._leaves || this.leaves())[li], mesh = l && this.parts.get(l.gk)?.mesh;
    const d = unit(r.d), subOf = l?.chain.length ? { sub: l.chain } : {};
    const [t0, t1] = this.axisExtent(l, mesh, r.p, d, r.r) || [0, 0]; // (a round edge on its own: the hole starts there)
    const ends = [{ p: add(r.p, mul(d, t1)), n: d, sign: 1 }, { p: add(r.p, mul(d, t0)), n: mul(d, -1), sign: -1 }];
    // (the end looking at the camera first)
    const pose = this.poseOfId(r.comp), view = this.vp.camera.getWorldDirection(new THREE.Vector3()).toArray();
    ends.sort((e1, e2) => dot(dirWorld(pose, e1.n), view) - dot(dirWorld(pose, e2.n), view));
    const faceAt = (end) => {
      if (mesh) for (let gi = 0; gi < mesh.faceGroups.length; gi++) {
        const x = refOfFace(mesh, gi);
        if (!x || x.kind !== 'plane') continue;
        const t = this.toTop(l, x);
        if (dot(t.n, end.n) > 0.9999 && Math.abs(dot(t.n, sub(end.p, t.p))) < 1e-4) return { comp: r.comp, ...t, face: gi, ...subOf, gi: `${li}:f${gi}` };
      }
      return { comp: r.comp, ...subOf, kind: 'plane', p: end.p.map(r6), n: end.n.map(r6), what: 'Hole end', holeEnd: { p: r.p.map(r6), d: d.map(r6), r: r.r, sign: end.sign } };
    };
    const [near, far] = ends;
    return { ref: r, r: r.r, depth: t1 - t0, end: near, face: faceAt(near), far, farFace: t1 > t0 ? faceAt(far) : null };
  }
  // The other holes of the same size in the same part, parallel to this one (each as from holeOf).
  matchingHoles(hole) {
    const r = hole.ref, li = this.leafOf(r), l = (this._leaves || this.leaves())[li], mesh = l && this.parts.get(l.gk)?.mesh;
    if (!mesh) return [];
    const d = unit(r.d), subOf = l.chain.length ? { sub: l.chain } : {}, axes = [r.p], out = [];
    mesh.faceGroups.forEach((g, gi) => {
      const x = refOfFace(mesh, gi);
      if (!x || x.kind !== 'axis' || x.circle) return;
      const t = this.toTop(l, x);
      if (Math.abs(t.r - r.r) > 1e-4 || len(cross(unit(t.d), d)) > 1e-4) return;
      if (axes.some((p) => len(cross(sub(t.p, p), d)) < 1e-3)) return; // (this hole, or one found already)
      axes.push(t.p);
      const h = this.holeOf({ comp: r.comp, ...t, face: gi, ...subOf, gi: `${li}:f${gi}` });
      if (h) out.push(h);
    });
    return out;
  }
  // a hole's end that has no flat face, found again from its hole (after the part changed)
  resyncHoleEnd(r) {
    const he = r.holeEnd, l = this._leaves?.[this.leafOf(r)], mesh = l && this.parts.get(l.gk)?.mesh;
    if (!mesh) return;
    const d = unit(he.d);
    // (the coaxial faces of that radius nearest where the hole was)
    let best = null, bd = Infinity;
    mesh.faceGroups.forEach((g, gi) => {
      const x = refOfFace(mesh, gi);
      if (!x || x.kind !== 'axis') return;
      const t = this.toTop(l, x);
      if (Math.abs(t.r - he.r) > 1e-4 || len(cross(unit(t.d), d)) > 1e-4) return;
      const dist = len(cross(sub(t.p, he.p), d));
      if (dist < bd) { bd = dist; best = t; }
    });
    if (!best) return;
    const ext = this.axisExtent(l, mesh, best.p, d, he.r);
    if (!ext) return;
    const p = add(best.p, mul(d, he.sign > 0 ? ext[1] : ext[0]));
    Object.assign(r, { p: p.map(r6), n: mul(d, he.sign).map(r6) });
    he.p = best.p.map(r6);
  }

  // Standard Parts: ISO and inch fasteners, pins, circlips, keys, rivets and bearings made to size. With a hole
  // selected the size is picked to fit it, and the part goes in it, mated (concentric, and seated on the hole's
  // end); a bolt or screw can take a washer under its head and a washer and nut on the far side, and the same can go
  // into every matching hole of the part.
  standardParts() {
    const a = this.app, U = unitOf(this.doc);
    const sr = this.sel?.kind === 'refs' ? this.sel.refs.find((r) => r.kind === 'axis' && r.r > 0 && r.comp !== ORIGIN) : null;
    const hole = sr ? this.holeOf(sr) : null;
    const others = hole ? this.matchingHoles(hole) : [];
    const last = this._stdLast || { type: 'hexBolt', material: 'steel' };
    const body = el('div', { class: 'stdparts' });
    body.appendChild(el('p', {}, hole
      ? `Into the selected hole (Ø${esc(lenWithUnit(2 * hole.r, U))}${hole.depth > 0 ? `, ${esc(lenWithUnit(hole.depth, U))} deep` : ''}), mated to it: the size is picked to fit it.`
      : 'Placed beside the assembly. To put it in a hole, mated, select the hole (its round face or edge) first.'));
    const row = (label, ctl) => { const r = el('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:6px' }, `<label class="pm-label" style="width:90px;flex:none">${esc(label)}</label>`); ctl.style.flex = '1'; r.appendChild(ctl); body.appendChild(r); return r; };
    const check = (label, on) => { const lab = el('label', { style: 'display:flex;align-items:center;gap:6px;margin-top:6px' }); const cb = el('input', { type: 'checkbox' }); cb.checked = on; lab.append(cb, document.createTextNode(label)); body.appendChild(lab); return { lab, cb }; };
    const typeSel = el('select'), sizeSel = el('select'), lenSel = el('select'), matSel = el('select');
    const opts = (s, list, val) => { s.innerHTML = ''; for (const [v, t] of list) { const o = el('option', { value: v }, esc(t)); if (String(v) === String(val)) o.selected = true; s.appendChild(o); } };
    row('Type', typeSel);
    row('Size', sizeSel);
    const lenRow = row('Length', lenSel), lenLabel = lenRow.querySelector('label');
    row('Material', matSel);
    const wHead = check('Washer under the head', !!last.washer);
    const wNut = check('Washer and nut on the other side', !!last.nut);
    const all = check(`Into all ${others.length + 1} matching holes of the part`, !!last.all);
    const type = () => STD_TYPES.find((x) => x.id === typeSel.value);
    const extra = () => {
      const t = type(), set = setParts(t.id, sizeSel.value);
      return (wHead.cb.checked ? heightOf(...set.washer) : 0) + (wNut.cb.checked && hole?.farFace ? heightOf(...set.washer) + heightOf(...set.nut) : 0);
    };
    const fillLen = () => {
      const t = type();
      lenRow.style.display = t.length ? 'flex' : 'none';
      wHead.lab.style.display = t.fastener ? 'flex' : 'none';
      wNut.lab.style.display = t.fastener && hole?.farFace ? 'flex' : 'none';
      all.lab.style.display = hole && others.length ? 'flex' : 'none';
      if (!t.length) return;
      lenLabel.textContent = t.inch ? 'Length (in)' : 'Length (mm)';
      const ls = stdLengths(t.id, sizeSel.value), want = hole ? fitLength(t.id, sizeSel.value, hole.depth, t.fastener ? extra() : 0) : last.length;
      opts(lenSel, ls.map((L) => [L, lengthLabel(t.id, L)]), ls.includes(want) ? want : ls[Math.min(3, ls.length - 1)]);
    };
    const fillSize = () => {
      const t = type(), fit = hole ? fitToHole(t.id, 2 * hole.r, hole.depth) : null;
      opts(sizeSel, t.sizes.map((s) => [s, s]), fit?.size || (t.sizes.includes(last.size) ? last.size : t.sizes[Math.floor(t.sizes.length / 2)]));
      fillLen();
    };
    opts(typeSel, STD_TYPES.map((t) => [t.id, t.label]), last.type);
    opts(matSel, MATERIALS.filter((m) => ['steel', 'stainless', 'brass', 'al6061'].includes(m.id)).map((m) => [m.id, m.name]), last.material);
    typeSel.onchange = fillSize;
    sizeSel.onchange = fillLen;
    wHead.cb.onchange = fillLen;
    wNut.cb.onchange = fillLen;
    fillSize();
    a.ui.modal('Standard Parts', 'stdParts', body, [
      { label: 'Insert', primary: true, action: () => {
        const t = type(), length = t.length ? Number(lenSel.value) : null;
        const o = { washer: t.fastener && wHead.cb.checked, nut: t.fastener && wNut.cb.checked && !!hole?.farFace, all: !!hole && others.length > 0 && all.cb.checked };
        this._stdLast = { type: t.id, size: sizeSel.value, length, material: matSel.value, washer: wHead.cb.checked, nut: wNut.cb.checked, all: all.cb.checked };
        this.insertStdPart(t.id, sizeSel.value, length, matSel.value, hole, o).catch((e) => a.toast('Could not insert it: ' + e.message, true));
      } },
      { label: 'Cancel' },
    ]);
  }
  // the assembly's part for a standard part (one per type, size, length and material, however many use it)
  stdPartOf(sp) {
    let p = this.doc.parts.find((x) => x.libKey === sp.key);
    if (!p) { p = this.part(this.addPart(sp.doc, null, null)); p.libKey = sp.key; }
    return p;
  }
  // A standard part inserted; into a hole (from holeOf): placed there with a Concentric mate to the hole and a
  // Coincident one on its end. opts: washer (one under a bolt's head), nut (a washer and nut on the hole's far
  // side), all (the same into every matching hole of the part). The components made.
  async insertStdPart(type, size, length, material = 'steel', hole = null, opts = {}) {
    const sp = makeStdPart(type, size, length, material);
    const p = this.stdPartOf(sp);
    if (!hole) { await this.addComponent(p.id); return this.doc.components[this.doc.components.length - 1]; }
    if (!opts.batch) this.begin();
    const set = setParts(type, size);
    const wsp = (opts.washer || opts.nut) ? makeStdPart(...set.washer, null, material) : null;
    const nsp = opts.nut ? makeStdPart(...set.nut, null, material) : null;
    const made = [];
    const mate = (t, ra, rb, align) => {
      const k = this.doc.mates.filter((x) => x.type === t).length + 1;
      this.doc.mates.push({ id: this.uid('m'), name: `${MATE_TYPES[t].label}${k}`, type: t, a: ra, b: rb, align, side: 1, value: null });
    };
    // one part placed on a hole's end (its +Y out of it), `up` along it from the end, seated on `on`
    const place = (s, h, end, on, align, up = 0) => {
      const part = this.stdPartOf(s), n = this.doc.components.filter((c) => c.part === part.id).length + 1;
      const hp = this.poseOfId(h.ref.comp), out = unit(dirWorld(hp, end.n)), at = add(toWorld(hp, end.p), mul(out, up));
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...out));
      const c = { id: this.uid('c'), part: part.id, name: `${part.name}<${n}>`, config: null, pos: sub(at, applyQ(q, s.seat.p)).map(r6), rot: [q.x, q.y, q.z, q.w], fixed: false, hidden: false };
      this.doc.components.push(c);
      mate('concentric', { ...h.ref }, { comp: c.id, ...s.axis }, -1);
      mate('coincident', { ...on }, { comp: c.id, ...s.seat }, align);
      made.push(c);
      return c;
    };
    for (const h of [hole, ...(opts.all ? this.matchingHoles(hole) : [])]) {
      if (wsp) {
        if (opts.washer) {
          const w = place(wsp, h, h.end, h.face, -1);
          place(sp, h, h.end, { comp: w.id, ...wsp.top }, -1, wsp.top.p[1]);
        } else place(sp, h, h.end, h.face, sp.align);
        if (opts.nut && h.farFace) {
          const w2 = place(wsp, h, h.far, h.farFace, -1);
          place(nsp, h, h.far, { comp: w2.id, ...wsp.top }, -1, wsp.top.p[1]);
        }
      } else place(sp, h, h.end, h.face, sp.align);
    }
    if (opts.batch) return made.find((c) => c.part === p.id) || made[0];
    await this.loadParts();
    this.solve();
    this.sel = { kind: 'comp', id: made.find((c) => c.part === p.id)?.id || made[0].id };
    const holes = new Set(made.length ? [hole, ...(opts.all ? this.matchingHoles(hole) : [])] : []).size;
    this.change(`${made.length} component${made.length === 1 ? '' : 's'} inserted into ${holes === 1 ? 'the hole' : holes + ' holes'}, mated to ${holes === 1 ? 'it' : 'them'}.`);
    return made.find((c) => c.part === p.id) || made[0];
  }

  // ---------------------------------------------------------------- equations shared with the parts
  // The assembly's global variables (doc.equations: [{ name, expr, drive }]). A driven one (drive, the default) sets
  // the variable of the same name in every part that has one (through the sub-assemblies): its value is written into
  // the assembly's copy of the part, so the assembly, its drawings and its exports use it. Done before the parts are
  // built, so a part read again from its file is driven again. The number of part variables changed.
  applyEquationLinks() {
    const eqs = this.doc.equations || [];
    if (!eqs.some((e) => e.drive !== false)) return 0;
    const { vars } = evalEquations(eqs);
    let n = 0;
    // (a changed part gets a new copy, so it is built again and an open tab's document is left alone; the same
    // copy used in several places stays one)
    const swapped = new Map();
    const walk = (doc, depth = 0) => {
      for (const p of doc.parts || []) {
        if (isAssembly(p.doc)) { if (depth < 16) walk(p.doc, depth + 1); continue; }
        if (swapped.has(p.doc)) { p.doc = swapped.get(p.doc); continue; }
        let k = 0;
        const next = (p.doc?.equations || []).map((e) => {
          const a = eqs.find((x) => x.name === e.name && x.drive !== false);
          if (!a || !(a.name in vars)) return e;
          const v = String(+vars[a.name].toPrecision(12));
          if (String(e.expr) === v) return e;
          k++;
          return { ...e, expr: v };
        });
        if (!k) continue;
        const d = { ...p.doc, equations: next };
        swapped.set(p.doc, d);
        p.doc = d;
        n += k;
      }
    };
    walk(this.doc);
    return n;
  }
  // the parts (names) that have a variable of this name
  partsWithVariable(name) {
    const out = [];
    const walk = (doc, depth = 0) => { for (const p of doc.parts || []) { if (isAssembly(p.doc)) { if (depth < 16) walk(p.doc, depth + 1); } else if ((p.doc?.equations || []).some((e) => e.name === name) && !out.includes(p.name)) out.push(p.name); } };
    walk(this.doc);
    return out;
  }
  // Equations window: the assembly's variables, each driving the parts' variables of its name (or not)
  showEquations() {
    const a = this.app, ui = a.ui;
    const rows = (this.doc.equations || []).map((e) => ({ ...e }));
    const wrap = el('div');
    wrap.appendChild(el('p', { class: 'pm-hint', style: 'margin:0 0 8px' }, 'The assembly\'s variables. A variable that drives the parts sets the variable of the same name in every part that has one (e.g. <code>thickness = 12</code> sets each part\'s <code>thickness</code>), so the parts are sized together. Use them in the parts\' dimensions and features as usual.'));
    const table = el('table', { class: 'grid' });
    wrap.appendChild(table);
    const addBtn = el('button', { class: 'pm-btn', style: 'margin-top:8px' }, '+ Add variable');
    wrap.appendChild(addBtn);
    const render = () => {
      const { vars, errors } = evalEquations(rows);
      const names = rows.map((r) => r.name);
      table.innerHTML = '<tr><th style="width:22%">Name</th><th>Value / Equation</th><th style="width:16%">Evaluates to</th><th style="width:26%">Drives the parts</th><th style="width:28px"></th></tr>';
      rows.forEach((r, i) => {
        const tr = el('tr');
        const n = el('input', { type: 'text', value: r.name, spellcheck: 'false' });
        const v = el('input', { type: 'text', value: String(r.expr), spellcheck: 'false' });
        const dup = names.indexOf(r.name) !== i, bad = r.name && (!isValidName(r.name) || dup);
        const out = el('td', { class: 'num' + (bad || errors.has(r.name) ? ' err' : '') }, bad ? (dup ? 'Duplicate name' : 'Invalid name') : r.name in vars ? fmt(vars[r.name], 4) : esc(errors.get(r.name) || ''));
        const parts = this.partsWithVariable(r.name);
        const drv = el('td');
        const cb = el('input', { type: 'checkbox' });
        cb.checked = r.drive !== false;
        cb.onchange = () => { r.drive = cb.checked; };
        drv.append(cb, document.createTextNode(' ' + (parts.length ? parts.join(', ') : '(no part has it)')));
        for (const x of [n, v]) x.addEventListener('keydown', (e) => e.stopPropagation());
        n.onchange = () => { r.name = n.value.trim(); render(); };
        v.oninput = () => { r.expr = v.value; const ev = evalEquations(rows); out.textContent = r.name in ev.vars ? fmt(ev.vars[r.name], 4) : ev.errors.get(r.name) || ''; };
        const del = el('button', { class: 'pm-btn', style: 'padding:0 6px;height:22px', title: 'Delete' }, '✕');
        del.onclick = () => { rows.splice(i, 1); render(); };
        const td1 = el('td'), td2 = el('td'), td5 = el('td');
        td1.appendChild(n); td2.appendChild(v); td5.appendChild(del);
        tr.append(td1, td2, out, drv, td5);
        table.appendChild(tr);
      });
    };
    addBtn.onclick = () => { let k = rows.length + 1; while (rows.some((r) => r.name === 'var' + k)) k++; rows.push({ name: 'var' + k, expr: '10', drive: true }); render(); };
    render();
    const apply = async () => {
      const clean = rows.filter((r) => r.name), names = clean.map((r) => r.name);
      if (clean.some((r, i) => !isValidName(r.name) || names.indexOf(r.name) !== i)) { a.toast('Fix invalid or duplicate names first', true); return false; }
      this.begin();
      this.doc.equations = clean;
      const n = this.applyEquationLinks();
      await this.loadParts();
      this.solve();
      this.change(n ? `${n} part variable${n === 1 ? '' : 's'} set from the assembly.` : 'Assembly equations changed.');
      return true;
    };
    ui.modal('Assembly Equations', 'equations', wrap, [
      { label: 'Update Open Parts', action: () => { apply().then((ok) => { if (ok) this.pushEquationsToOpenParts(); }); return false; } },
      { label: 'OK', primary: true, action: () => { apply(); } },
      { label: 'Cancel' },
    ]);
  }
  // the driven values written into the parts open in tabs too (they show as changed, to be saved)
  pushEquationsToOpenParts() {
    const a = this.app, { vars } = evalEquations(this.doc.equations || []);
    let n = 0;
    for (const t of a.tabs) {
      if (t.kind === 'drawing' || !t.doc || t === a.tabs[a.tabIndex]) continue;
      if (!this.doc.parts.some((p) => this.live.get(p.id) === t || (p.path && sameFile(p.path, t.filePath)))) continue;
      for (const e of t.doc.equations || []) {
        const x = (this.doc.equations || []).find((q) => q.name === e.name && q.drive !== false);
        if (!x || !(x.name in vars)) continue;
        const v = String(+vars[x.name].toPrecision(12));
        if (String(e.expr) !== v) { e.expr = v; t.dirty = true; n++; }
      }
    }
    a.updateTitle?.();
    a.renderTabs?.();
    a.status(n ? `${n} variable${n === 1 ? '' : 's'} set in the open parts: save them to keep it.` : 'The open parts have these values already.');
  }

  // the part (reused when it is in the assembly already)
  addPart(doc, path, tab) {
    let p = (path && this.doc.parts.find((x) => sameFile(x.path, path))) || (tab && [...this.live].find(([, t]) => t === tab) && this.doc.parts.find((x) => this.live.get(x.id) === tab));
    if (!p) {
      p = { id: this.uid('pt'), name: (path && isDefaultName(doc.name) ? fileStem(path) : doc.name) || 'Part', path: path || null, doc: stripThumbnail(JSON.parse(JSON.stringify(doc))) };
      this.doc.parts.push(p);
    } else p.doc = stripThumbnail(JSON.parse(JSON.stringify(doc)));
    if (tab) this.live.set(p.id, tab);
    return p.id;
  }

  async addComponent(partId, config = undefined) {
    const p = this.part(partId);
    if (!p) return;
    this.begin();
    const n = this.doc.components.filter((c) => c.part === partId).length + 1;
    const first = !this.doc.components.length;
    // (the part's configuration chosen, else the one it was saved showing)
    const cfgId = config !== undefined ? config : (p.doc.activeConfig ?? null);
    const c = { id: this.uid('c'), part: partId, name: `${p.name}<${n}>`, config: cfgId, pos: [0, 0, 0], rot: [0, 0, 0, 1], fixed: first, hidden: false };
    this.doc.components.push(c);
    await this.loadParts();
    // beside what is there already (to the right, a little apart)
    if (!first) {
      const box = this.geo(c)?.box, all = this.worldBox(c.id);
      if (box && all) c.pos = [all.max[0] - box.min[0] + 0.15 * Math.max(1, all.max[0] - all.min[0]), all.min[1] - box.min[1], (all.min[2] + all.max[2]) / 2 - (box.min[2] + box.max[2]) / 2].map(r6);
    }
    this.sel = { kind: 'comp', id: c.id };
    this.change(first ? `${c.name} inserted and fixed at the origin (the first component). Insert more, then mate them.` : `${c.name} inserted. Drag it into place or add mates.`);
    if (first) { this.buildMesh(); this.vp.zoomToFit(); }
  }

  // the box round every component (but one) as placed
  worldBox(except = null) {
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const c of this.doc.components) {
      if (c.id === except || this.eff(c).suppressed) continue;
      const box = this.geo(c)?.box;
      if (!box) continue;
      const ps = poseOf(c);
      for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) {
        const w = toWorld(ps, [x, y, z]);
        min = min.map((m, i) => Math.min(m, w[i])); max = max.map((m, i) => Math.max(m, w[i]));
      }
    }
    return Number.isFinite(min[0]) ? { min, max } : null;
  }

  setFixed(id, on) {
    const c = this.comp(id);
    if (!c) return;
    this.begin();
    c.fixed = on;
    this.solve();
    this.change(`${c.name} ${on ? 'fixed where it is' : 'floating: it moves within its mates'}.`);
  }
  setHidden(id, on) { const c = this.comp(id); if (!c) return; this.begin(); this.setComp(c, 'hidden', on); this.change(); }
  setSuppressed(id, on) {
    const c = this.comp(id);
    if (!c) return;
    this.begin();
    this.setComp(c, 'suppressed', on);
    this.solve();
    this.change(`${c.name} ${on ? 'suppressed (left out, with its mates)' : 'unsuppressed'}${this.cfg() ? ` in ${this.cfg().name}` : ''}.`);
    if (!on) this.loadParts();
  }
  async setCompConfig(id, cfgId) {
    const c = this.comp(id);
    if (!c) return;
    this.begin();
    this.setComp(c, 'config', cfgId || null);
    this.change();
    await this.loadParts();
    this.solve();
    this.updateGeometry();
    this.renderAll();
    this.app.status(`${c.name} uses ${this.configName(this.part(c.part), cfgId)}${this.cfg() ? ` in ${this.cfg().name}` : ''}.`);
  }
  deleteComponent(id) {
    const c = this.comp(id);
    if (!c) return;
    this.begin();
    this.doc.components = this.doc.components.filter((x) => x.id !== id);
    this.doc.mates = this.doc.mates.filter((m) => m.a.comp !== id && m.b.comp !== id);
    // a part no component uses any more goes from the assembly
    this.doc.parts = this.doc.parts.filter((p) => this.doc.components.some((x) => x.part === p.id));
    if (this.sel?.id === id) this.sel = null;
    this.change(`${c.name} deleted (with its mates).`);
  }
  renameComponent(id) {
    const c = this.comp(id);
    if (!c) return;
    this.app.ui.promptText('Rename Component', 'rename', 'Name', c.name).then((v) => { if (v && v.trim()) { this.begin(); c.name = v.trim(); this.change(); } });
  }
  // open a component's part, or its sub-assembly, in a tab (its file when it has one, else this assembly's copy)
  async openPart(id) {
    const c = this.comp(id), p = c && this.part(c.part);
    if (!p) return;
    const tab = await this.openPartDoc(p);
    if (tab) this.live.set(p.id, tab);
  }
  async openPartDoc(p) {
    const a = this.app, sub = this.isSub(p);
    const tab = this.live.get(p.id) || a.tabs.find((t) => p.path && sameFile(t.filePath, p.path) && (sub ? t.kind === 'drawing' : t.kind !== 'drawing'));
    if (tab && a.tabs.includes(tab)) { await a.activateTab(a.tabs.indexOf(tab)); return null; }
    if (p.path && platform.desktop) { try { const f = await platform.openPath(p.path); if (f) { await a.openFromFile(f); return null; } } catch { /* use the copy */ } }
    await a.openFromFile({ name: p.name + (sub ? ASM_EXT : '.rcad'), content: JSON.stringify(p.doc), path: null });
    return a.tabs[a.tabIndex];
  }
  // Number Parts: a Part Number property for each part and sub-assembly (in the order of the bill of materials, through
  // the sub-assemblies): prefix + a number of `digits` from start in steps of step; those with one already kept unless
  // asked. Returns how many were numbered.
  numberParts({ prefix = 'P-', start = 1, step = 1, digits = 4, all = false } = {}) {
    let n = start, done = 0;
    const seen = new Set();
    const walk = (doc, depth) => {
      if (depth > 16) return;
      for (const p of doc.parts || []) {
        if (!p.doc || seen.has(p.doc) || p.libKey || !(doc.components || []).some((c) => c.part === p.id)) continue;
        seen.add(p.doc);
        const props = (p.doc.customProps ||= []), have = props.find((x) => x.name === 'Part Number');
        if (all || !have?.value) {
          const v = `${prefix}${String(n).padStart(digits, '0')}`;
          if (have) have.value = v; else props.push({ name: 'Part Number', value: v });
          n += step; done++;
        }
        if (this.isSub(p)) walk(p.doc, depth + 1);
      }
    };
    walk(this.doc, 0);
    if (done) this.commit('Number parts');
    return done;
  }
  async numberPartsDialog() {
    const v = await this.app.ui.promptFields('Number Parts', 'bom', [
      { key: 'prefix', label: 'Before the number', type: 'text', value: this.doc.numbering?.prefix ?? 'P-' },
      { key: 'start', label: 'First number', type: 'expr', value: this.doc.numbering?.next ?? 1 },
      { key: 'step', label: 'Step', type: 'expr', value: 1 },
      { key: 'digits', label: 'Digits', type: 'expr', value: 4 },
      { key: 'all', label: 'Number again those with a part number', type: 'check', value: false },
    ], 'Each part and sub-assembly gets a Part Number property (shown in the bill of materials and title blocks), in the order of the bill of materials. Save the parts kept in files of their own to keep it there.');
    if (!v) return;
    const o = { prefix: v.prefix, start: Math.round(+v.start) || 1, step: Math.round(+v.step) || 1, digits: Math.max(1, Math.min(9, Math.round(+v.digits) || 4)), all: !!v.all };
    const n = this.numberParts(o);
    this.doc.numbering = { prefix: o.prefix, next: o.start + n * o.step };
    this.app.status(n ? `${n} part${n === 1 ? '' : 's'} numbered.` : 'Every part has a part number already.');
  }
  // Positions (doc.positions: [{ id, name, comps: { component id: { pos, rot } } }]): where the components are now, kept
  // under a name: shown in a drawing view as an alternate position (phantom lines), or the assembly put back there.
  savePosition(name) {
    const list = (this.doc.positions ||= []);
    let n = 1;
    while (list.some((p) => p.id === 'pos' + n)) n++;
    const p = { id: 'pos' + n, name: name || `Position ${n}`, comps: Object.fromEntries(this.doc.components.map((c) => [c.id, { pos: [...c.pos], rot: [...c.rot] }])) };
    list.push(p);
    this.commit('Save position');
    return p;
  }
  restorePosition(id) {
    const p = (this.doc.positions || []).find((x) => x.id === id);
    if (!p) return false;
    for (const c of this.doc.components) { const q = p.comps[c.id]; if (q) { c.pos = [...q.pos]; c.rot = [...q.rot]; } }
    this.solve(); this.updateGeometry(); this.renderAll();
    this.commit('Restore position');
    return true;
  }
  async positionsDialog() {
    const a = this.app, list = this.doc.positions || [];
    const v = await a.ui.promptFields('Positions', 'explode', [
      { key: 'act', label: 'Do', type: 'select', options: [['save', 'Keep where the components are now as a position'], ...list.flatMap((p) => [['go:' + p.id, `Put the components back at ${p.name}`], ['del:' + p.id, `Delete ${p.name}`]])], value: 'save' },
      { key: 'name', label: 'Name (a new position)', type: 'text', value: `Position ${list.length + 1}` },
    ], 'A position keeps where every component is (e.g. a lid open, after changing a mate). A drawing view of the assembly can show a position as an alternate position, in phantom lines.');
    if (!v) return;
    if (v.act === 'save') { const p = this.savePosition(v.name.trim()); a.status(`${p.name} kept: a drawing view can show it as an alternate position.`); }
    else if (v.act.startsWith('go:')) this.restorePosition(v.act.slice(3));
    else if (v.act.startsWith('del:')) { this.doc.positions = list.filter((p) => p.id !== v.act.slice(4)); if (!this.doc.positions.length) delete this.doc.positions; this.commit('Delete position'); }
  }
  // Edit in Context: the part opened with the other parts of the assembly in it as context bodies (transparent), where
  // they are from it, so it can be sketched on them, take their edges or be extruded up to them. The context bodies are
  // references only: left out of the part where it is used. Again on the same component: the context brought up to date.
  // The parts a part takes its shape from in this assembly (its context bodies' parts), and theirs in turn: part ids
  partDeps(partId, seen = new Set()) {
    const p = this.part(partId);
    for (const f of p?.doc?.features || []) {
      if (f.type !== 'import' || !f.context?.comp || f.suppressed || (f.context.asm && this.doc.uid && f.context.asm !== this.doc.uid)) continue;
      const q = this.comp(f.context.comp)?.part;
      if (q && !seen.has(q)) { seen.add(q); this.partDeps(q, seen); }
    }
    return seen;
  }
  // Would component x as context of part `partId` make a circular reference (x is the same part, or its part already
  // takes its shape from this one, directly or through others)? The chain of parts, or null
  circularVia(partId, x) {
    if (x.part === partId) return [this.part(partId)?.name || 'the part'];
    if (!this.partDeps(x.part).has(partId)) return null;
    return [this.part(x.part)?.name || x.name, this.part(partId)?.name || 'the part'];
  }
  // Edit Part (right-click a part, in the tree or the view): the part opened with every other part shown in the
  // assembly brought in as context (Edit in Context, without asking which), its feature tree the one features go into
  async editPart(id) {
    const c = this.comp(id), p = c && this.part(c.part);
    if (!p) return null;
    if (this.isSub(p) || p.libKey) { this.app.toast('Edit Part works on parts made here (not sub-assemblies or library parts): open those instead', true); return null; }
    const others = this.contextCandidates(c);
    if (!others.length) { await this.openPart(c.id); this.app.status(`Editing ${p.name}: there are no other parts to show with it.`); return { ids: [] }; }
    return this.editInContext(id, others.map((x) => x.id));
  }
  contextCandidates(c) {
    return this.doc.components.filter((x) => x.id !== c.id && !this.eff(x).suppressed && !this.eff(x).hidden && this.part(x.part) && !this.isSub(this.part(x.part)));
  }
  async editInContext(id, pick = null) {
    const a = this.app, c = this.comp(id), p = c && this.part(c.part);
    if (!p) return null;
    if (this.isSub(p) || p.libKey) { a.toast('Edit in Context works on parts made here (not sub-assemblies or library parts)', true); return null; }
    const others = this.contextCandidates(c);
    if (!others.length) { a.toast('There are no other parts to show in context', true); return null; }
    let chosen = pick ? others.filter((x) => pick.includes(x.id)) : null;
    // (parts that would make a circular reference are left out, with a warning: they take their shape from this one)
    const refuseCircular = async (list) => {
      const bad = list.map((x) => ({ x, via: this.circularVia(p.id, x) })).filter((r) => r.via);
      if (!bad.length) return list;
      const box = document.createElement('div');
      box.dataset.circularRefused = '';
      const p1 = document.createElement('p');
      p1.textContent = `These can't be brought into ${p.name} as context: each would make a circular reference, so they are left out.`;
      const ul = document.createElement('ul');
      for (const { x, via } of bad) { const li = document.createElement('li'); li.textContent = via.length === 1 ? `${x.name}: another instance of ${p.name} itself` : `${x.name}: ${via[0]} already takes its shape from ${via[1]}`; ul.appendChild(li); }
      const p2 = document.createElement('p');
      p2.textContent = 'A part can only take its shape from parts that do not depend on it. Remove the reference in the other part first (its Context feature) to use it here.';
      box.append(p1, ul, p2);
      a.ui.modal('Circular reference not allowed', 'error', box, [{ label: 'OK', primary: true }]);
      return list.filter((x) => !bad.some((r) => r.x === x));
    };
    if (chosen) chosen = await refuseCircular(chosen);
    if (!chosen) {
      const v = await a.ui.promptFields(`Edit ${c.name || p.name} in Context`, 'part', others.slice(0, 40).map((x, i) => ({ key: 'c' + i, label: x.name || this.part(x.part).name, type: 'check', value: others.length <= 12 })), 'The parts ticked come into the part as transparent context bodies, where they are in the assembly.');
      if (!v) return null;
      chosen = await refuseCircular(others.slice(0, 40).filter((_, i) => v['c' + i]));
      if (!chosen.length) return null;
    }
    if (!chosen.length) { await this.openPart(c.id); this.contextOf = { asmTab: a.tabs[a.tabIndex], comp: c.id }; return { ids: [] }; }
    const ctx = [];
    await a.withProgress?.('Bringing in the context…', async () => {
      for (const x of chosen) {
        try { ctx.push({ comp: x, text: await this.contextStep(c, x), sig: this.contextSig(c, x) }); }
        catch (e) { a.toast(`${x.name || this.part(x.part).name} could not come into context: ${e.message}`, true); }
      }
    }) ?? null;
    if (!ctx.length) return null;
    const asmTab = a.tabs[a.tabIndex];
    // (the assembly's own id, kept with the context: component ids repeat from one assembly to another)
    this.doc.uid ||= newRev() + newRev();
    const asmUid = this.doc.uid;
    await this.openPart(c.id);
    const doc = a.doc;
    if (!doc || doc === this.doc) return null;
    const made = [];
    for (const { comp, text, sig } of ctx) {
      let f = doc.features.find((g) => g.type === 'import' && g.context?.comp === comp.id);
      if (f) { f.data = text; f.rev = newRev(); f.context = { ...f.context, host: c.id, asm: asmUid, sig }; }
      else {
        f = createFeature(doc, 'import', { format: 'step', fileName: `${comp.name || 'context'}.step`, data: text, context: { comp: comp.id, name: comp.name, host: c.id, asm: asmUid, sig } });
        f.name = `Context: ${comp.name || this.part(comp.part).name}`;
        insertFeature(doc, f);
      }
      made.push(f.id);
    }
    a.commit();
    await a.rebuild?.();
    const ids = (a.result?.bodies || []).filter((b) => made.includes(String(b.id).split(/[.~]/)[0])).map((b) => b.id);
    if (ids.length) a.setBodiesTransparent(ids, true);
    a.status(`Editing ${p.name} in context: ${ctx.length} part${ctx.length === 1 ? '' : 's'} in as transparent context bodies. Sketch on them, use their edges or extrude up to them; they are left out of the part in the assembly. Save the part to update the assembly.`);
    this.contextOf = { asmTab, comp: c.id };
    a.showBanner(`Editing ${p.name} in ${this.doc.name || 'the assembly'}: features go into ${p.name}`, { label: 'Back to the Assembly', action: () => { a.showBanner(null); if (a.tabs.includes(asmTab)) a.activateTab(a.tabs.indexOf(asmTab)); } });
    return { ids: made };
  }
  // Context: another component's part as a STEP file where it is from the host component (the part edited), and a
  // signature of that (its part as built, its configuration, where it is from the host) to tell when it changed.
  contextPose(host, x) {
    const P0 = poseOf(host), inv = P0.q.clone().invert(), Px = poseOf(x), q = inv.clone().multiply(Px.q), t = applyQ(inv, sub(Px.p, P0.p));
    return { p: t, q: [q.x, q.y, q.z, q.w] };
  }
  contextDoc(x) {
    const px = this.part(x.part), cfg = this.eff(x).config;
    return { ...px.doc, activeConfig: cfg && (px.doc.configs || []).some((k) => k.id === cfg) ? cfg : null };
  }
  contextSig(host, x) {
    const P = this.contextPose(host, x);
    return hash(JSON.stringify(this.contextDoc(x))) + ':' + [...P.p, ...P.q].map((v) => (Math.abs(v) < 5e-10 ? 0 : v).toFixed(9)).join(',');
  }
  async contextStep(host, x) {
    const pool = this.app.kernelPool || this.app.kernel;
    const r = await pool.request('partSTEP', { doc: JSON.stringify(this.contextDoc(x)), pose: this.contextPose(host, x), name: x.name || this.part(x.part).name }, 'asm-parts');
    return r.text;
  }
  // The context features of a part (doc) edited in context in this assembly brought up to date: those whose
  // component's part, configuration or place from the host changed (force: all), and those whose component is gone
  // suppressed. Returns { updated, gone }.
  async refreshContext(doc, force = false) {
    let updated = 0, gone = 0;
    // (not context from another assembly: its id kept with the context, when both have one)
    for (const f of doc.features.filter((g) => g.type === 'import' && g.context?.host && !(g.context.asm && this.doc.uid && g.context.asm !== this.doc.uid))) {
      const host = this.comp(f.context.host), x = this.comp(f.context.comp);
      if (!host) continue;
      if (!x || !this.part(x.part)) { if (!f.suppressed) { f.suppressed = true; f.context = { ...f.context, gone: true }; gone++; } continue; }
      const sig = this.contextSig(host, x);
      if (!force && sig === f.context.sig) continue;
      f.data = await this.contextStep(host, x);
      f.rev = newRev();
      f.context = { ...f.context, sig, gone: undefined };
      updated++;
    }
    return { updated, gone };
  }
  compMenu(c) {
    const sub = this.isSub(this.part(c.part));
    return [
      ...(sub ? [] : [{ label: 'Edit Part', icon: 'edit', action: () => this.editPart(c.id) }]),
      { label: sub ? 'Open Sub-assembly' : 'Open Part', icon: sub ? 'assembly' : 'part', action: () => this.openPart(c.id) },
      ...(sub ? [c.flexible ? { label: 'Make Rigid', icon: 'fix', action: () => this.setFlexible(c.id, false) } : { label: 'Make Flexible', icon: 'float', action: () => this.setFlexible(c.id, true) }] : []),
      ...(sub ? [] : [{ label: 'Edit in Context…', icon: 'part', action: () => this.editInContext(c.id) }]),
      { label: 'Mate…', icon: 'mate', action: () => this.startMate() },
      'sep',
      c.fixed ? { label: 'Float', icon: 'float', action: () => this.setFixed(c.id, false) } : { label: 'Fix', icon: 'fix', action: () => this.setFixed(c.id, true) },
      this.eff(c).hidden ? { label: 'Show', icon: 'show', action: () => this.setHidden(c.id, false) } : { label: 'Hide', icon: 'hide', action: () => this.setHidden(c.id, true) },
      this.eff(c).suppressed ? { label: 'Unsuppress', icon: 'suppress', action: () => this.setSuppressed(c.id, false) } : { label: 'Suppress', icon: 'suppress', action: () => this.setSuppressed(c.id, true) },
      ...(this.partConfigs(this.part(c.part)).length > 1 ? ['sep', ...this.partConfigs(this.part(c.part)).map(([id, name]) => ({ label: `${(this.eff(c).config || null) === id ? '● ' : '　'}Configuration: ${name}`, icon: '', action: () => this.setCompConfig(c.id, id) }))] : []),
      { label: 'Insert Another Instance', icon: 'insertComponent', action: () => this.addComponent(c.part) },
      'sep',
      { label: 'Rename', icon: 'rename', action: () => this.renameComponent(c.id) },
      { label: 'Delete', icon: 'trash', key: 'Del', action: () => this.deleteComponent(c.id) },
    ];
  }

  // ---------------------------------------------------------------- fasteners everywhere
  // The lined-up holes of the assembly: every round hole of each component (a cylinder whose faces look in towards
  // its axis), in stacks of holes on one axis through different components. [{ holes: [{ comp, li, gi, ref, p, d, r }] }]
  holeStacks() {
    const leaves = this._leaves || this.leaves(), holes = [];
    leaves.forEach((l, li) => {
      const c = l.comp;
      if (l.chain.length || this.eff(c).suppressed || this.part(c.part)?.libKey) return;
      const m = this.parts.get(l.gk)?.mesh;
      if (!m) return;
      const ps = poseOf(c), V = m.vertices, T = m.triangles;
      m.faceGroups.forEach((g, gi) => {
        const s = g.surf;
        if (s?.t !== 'CYLINDER' || !g.count) return;
        const [a, b, cc] = [0, 1, 2].map((k) => { const v = T[g.start + k]; return [V[3 * v], V[3 * v + 1], V[3 * v + 2]]; });
        const N = cross(sub(b, a), sub(cc, a)), mid = mul(add(add(a, b), cc), 1 / 3), d = unit(s.d), rad = sub(mid, add(s.p, mul(d, dot(sub(mid, s.p), d))));
        if (!(dot(N, rad) < 0)) return; // (a shaft, not a hole)
        const ref = { comp: c.id, kind: 'axis', p: s.p.map(r6), d: s.d.map(r6), r: r6(s.r), face: gi, gi: `${li}:f${gi}`, what: 'Cylindrical face' };
        holes.push({ comp: c, li, gi, ref, p: toWorld(ps, s.p), d: unit(dirWorld(ps, s.d)), r: s.r });
      });
    });
    const root = holes.map((_, i) => i), find = (i) => (root[i] === i ? i : (root[i] = find(root[i])));
    for (let i = 0; i < holes.length; i++) for (let j = i + 1; j < holes.length; j++) {
      const A = holes[i], B = holes[j];
      if (len(cross(A.d, B.d)) < 1e-4 && len(cross(sub(B.p, A.p), A.d)) < 1e-3) root[find(i)] = find(j);
    }
    const groups = new Map();
    holes.forEach((h, i) => { const k = find(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(h); });
    // (one hole per component: the widest of a stepped one is its counterbore)
    return [...groups.values()].map((hs) => ({ holes: [...new Map(hs.sort((x, y) => x.r - y.r).map((h) => [h.comp.id, h])).values()] }));
  }
  // A fastener in each stack of lined-up holes through two or more components (singles: in every hole), sized to the
  // holes, as long as the stack (with a washer under its head, and a washer and nut on the far side), mated in it;
  // stacks with a fastener already left alone. The number put in.
  async autoFasten({ kind = 'hexBolt', washer = true, nut = true, singles = false } = {}) {
    const stacks = this.holeStacks().filter((s) => s.holes.length >= (singles ? 1 : 2));
    // (a fastener already on the axis: a standard part's component whose own axis lies on it)
    const filled = (st) => this.doc.components.some((c) => {
      if (!this.part(c.part)?.libKey) return false;
      const ps = poseOf(c), up = dirWorld(ps, [0, 1, 0]), h = st.holes[0];
      return len(cross(up, h.d)) < 1e-4 && len(cross(sub(ps.p, h.p), h.d)) < 1e-3;
    });
    let n = 0;
    this.begin();
    for (const st of stacks) {
      if (filled(st)) continue;
      // (the stack's two outer ends: of all its holes' ends, the furthest towards the camera (where the fastener goes in,
      // as for a single hole) and the furthest away)
      const hs = st.holes.map((x) => ({ x, h: this.holeOf(x.ref) })).filter((o) => o.h);
      if (!hs.length) continue;
      const u = unit(dirWorld(this.poseOfId(hs[0].x.comp.id), hs[0].h.end.n));
      let top = null, bot = null;
      for (const o of hs) {
        const X = this.poseOfId(o.x.comp.id);
        for (const [e, fc, far] of [[o.h.end, o.h.face, false], [o.h.far, o.h.farFace, true]]) {
          const t = dot(toWorld(X, e.p), u);
          if (!top || t > top.t) top = { o, e, fc, far, t };
          if (!bot || t < bot.t) bot = { o, e, fc, t, X };
        }
      }
      const h = top.o.h;
      if (top.far) [h.end, h.face, h.far, h.farFace] = [h.far, h.farFace, h.end, h.face];
      const P = this.poseOfId(top.o.x.comp.id), qi = P.q.clone().invert(), local = (w) => applyQ(qi, sub(w, P.p));
      if (bot.o !== top.o) { h.far = { p: local(toWorld(bot.X, bot.e.p)).map(r6), n: unit(applyQ(qi, dirWorld(bot.X, bot.e.n))).map(r6), sign: -1 }; h.farFace = bot.fc; }
      const depth = top.t - bot.t;
      const fit = fitToHole(kind, 2 * Math.max(...st.holes.map((x) => x.r)));
      const L = fastenerLength(kind, fit.size, depth, { washer, nut });
      await this.insertStdPart(kind, fit.size, L, 'steel', h, { washer, nut, batch: true });
      n++;
    }
    await this.loadParts();
    this.solve();
    this.change(n ? `${n} fastener${n === 1 ? '' : 's'} put in (${stacks.length - n} stack${stacks.length - n === 1 ? '' : 's'} had one already or no fit).` : 'No stacks of holes to fasten (or each has a fastener already).');
    return n;
  }
  async autoFastenDialog() {
    const kinds = STD_TYPES.filter((t) => t.fastener).map((t) => [t.id, t.label]);
    const v = await this.app.ui.promptFields('Fasten All Holes', 'stdParts', [
      { key: 'kind', label: 'Fastener', type: 'select', options: kinds, value: 'hexBolt' },
      { key: 'washer', label: 'Washer under the head', type: 'check', value: true },
      { key: 'nut', label: 'Washer and nut on the far side', type: 'check', value: true },
      { key: 'singles', label: 'Also holes through one component only', type: 'check', value: false },
    ], 'Every stack of lined-up holes through two or more components gets a fastener sized to the holes and as long as the stack, mated in it. Stacks with a fastener already are left alone.');
    if (v) await this.autoFasten(v);
  }

  // ---------------------------------------------------------------- component patterns
  // The components selected (or the one), and a picked edge, axis or face for the direction, axis or mirror plane
  async startCompPattern(kind, edit = null) {
    const pt0 = edit ? this.doc.compPatterns.find((x) => x.id === edit) : null;
    const seeds = pt0 ? pt0.seeds : [...new Set([this.selComp()?.id, ...(this.sel?.kind === 'refs' ? this.sel.refs.map((r) => r.comp) : [])].filter((id) => id && id !== ORIGIN && !this.comp(id)?.patternOf))];
    if (!seeds.length) { this.app.toast('Select the component to pattern first', true); return; }
    kind = pt0?.kind || kind;
    const ref = this.sel?.kind === 'refs' ? this.sel.refs.map((r) => this.worldRef(r)).find((r) => r && (kind === 'mirror' ? r.kind === 'plane' : r.kind === 'axis')) : null;
    const axes = [['x', 'X axis'], ['y', 'Y axis'], ['z', 'Z axis'], ...(ref ? [['ref', kind === 'mirror' ? 'The selected face' : 'The selected edge / axis']] : [])];
    const planes = [['yz', 'YZ plane (x = 0)'], ['xz', 'XZ plane (y = 0)'], ['xy', 'XY plane (z = 0)'], ...(ref ? [['ref', 'The selected face']] : [])];
    const fields = kind === 'linear' ? [
      { key: 'dir', label: 'Direction', type: 'select', options: axes, value: pt0 ? 'keep' : ref ? 'ref' : 'x' }, { key: 'dist', label: 'Spacing (mm)', value: pt0?.dist ?? 50 }, { key: 'count', label: 'Instances', value: pt0?.count ?? 3 },
      { key: 'dir2', label: 'Second direction', type: 'select', options: [['none', 'None'], ...axes.filter(([k]) => k !== 'ref')], value: pt0?.dir2 ? 'keep' : 'none' }, { key: 'dist2', label: 'Second spacing (mm)', value: pt0?.dist2 ?? 50 }, { key: 'count2', label: 'Second instances', value: pt0?.count2 ?? 2 },
    ] : kind === 'circular' ? [
      { key: 'axis', label: 'Axis', type: 'select', options: axes, value: pt0 ? 'keep' : ref ? 'ref' : 'z' }, { key: 'angle', label: 'Angle (°)', value: pt0?.angle ?? 360 }, { key: 'count', label: 'Instances', value: pt0?.count ?? 4 }, { key: 'equal', label: 'Equal spacing (angle is total)', type: 'check', value: pt0 ? pt0.equal !== false : true },
    ] : [{ key: 'plane', label: 'Mirror plane', type: 'select', options: planes, value: pt0 ? 'keep' : ref ? 'ref' : 'yz' }];
    if (pt0) for (const f of fields) if (f.type === 'select' && f.value === 'keep') f.options = [['keep', 'As it is'], ...f.options];
    const title = { linear: 'Component Pattern', circular: 'Circular Component Pattern', mirror: 'Mirror Components' }[kind];
    const v = await this.app.ui.promptFields(title, { linear: 'lpattern', circular: 'cpattern', mirror: 'mirror' }[kind], fields, `${seeds.length} component${seeds.length === 1 ? '' : 's'}: ${seeds.map((id) => this.comp(id)?.name).join(', ')}. Copies are fixed and follow their seeds.${kind === 'mirror' ? ' Mirror places copies as the mirror image (the parts are not mirrored: for parts the same both ways round).' : ''}`);
    if (!v) return;
    const AX = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, PL = { yz: [1, 0, 0], xz: [0, 1, 0], xy: [0, 0, 1] };
    const num = (x, name) => { const n = Number(x); if (!Number.isFinite(n)) throw new Error(`${name} must be a number`); return n; };
    try {
      const pt = pt0 ? { ...pt0 } : { id: this.uid('cp'), name: `${{ linear: 'Pattern', circular: 'Circular Pattern', mirror: 'Mirror' }[kind]}${(this.doc.compPatterns || []).length + 1}`, kind, seeds };
      if (kind === 'linear') {
        if (v.dir !== 'keep') pt.dir = v.dir === 'ref' ? ref.d : AX[v.dir];
        pt.dist = num(v.dist, 'The spacing'); pt.count = Math.round(num(v.count, 'The instances'));
        if (v.dir2 === 'none') { delete pt.dir2; } else if (v.dir2 !== 'keep') pt.dir2 = AX[v.dir2];
        pt.dist2 = num(v.dist2, 'The second spacing'); pt.count2 = Math.round(num(v.count2, 'The second instances'));
      } else if (kind === 'circular') {
        if (v.axis !== 'keep') pt.axis = v.axis === 'ref' ? { p: ref.p, d: ref.d } : { p: [0, 0, 0], d: AX[v.axis] };
        pt.angle = num(v.angle, 'The angle'); pt.count = Math.round(num(v.count, 'The instances')); pt.equal = !!v.equal;
      } else if (v.plane !== 'keep') pt.plane = v.plane === 'ref' ? { p: ref.p, n: ref.n } : { p: [0, 0, 0], n: PL[v.plane] };
      if (!(pt.count >= 1) || (pt.count || 1) * (pt.count2 || 1) > 400) throw new Error('Between 1 and 400 instances');
      this.begin();
      this.doc.compPatterns = [...(this.doc.compPatterns || []).filter((x) => x.id !== pt.id), pt];
      applyCompPatterns(this.doc, (b) => this.uid(b));
      await this.loadParts();
      this.solve();
      this.change(`${pt.name}: ${this.doc.components.filter((c) => c.patternOf === pt.id).length} copies`);
    } catch (e) { this.app.toast(e.message, true); }
  }
  deleteCompPattern(id) {
    const pt = (this.doc.compPatterns || []).find((x) => x.id === id);
    if (!pt) return;
    this.begin();
    this.doc.compPatterns = this.doc.compPatterns.filter((x) => x !== pt);
    applyCompPatterns(this.doc, (b) => this.uid(b));
    this.doc.parts = this.doc.parts.filter((p) => this.doc.components.some((x) => x.part === p.id));
    this.change(`${pt.name} deleted (with its copies).`);
  }

  // ---------------------------------------------------------------- mates
  startMate(edit = null) {
    if (!this.doc.components.length) { this.app.toast('Insert a component first'); return; }
    this.collapseExplode();
    this.cancelMate(true);
    this.begin();
    this.pmBefore = JSON.stringify(this.doc.components);
    if (edit) {
      const m = this.doc.mates.find((x) => x.id === edit);
      this.pm = { picks: [m.a, m.b], type: m.type, value: this.effMate(m).value, align: m.align, side: m.side, edit: m.id, extra: [m.a2, m.b2, m.s].filter(Boolean), limit: !!m.limit, min: m.min, max: m.max };
    } else this.pm = { picks: [], type: null, value: null, align: null, side: 1 };
    // (faces, edges, vertices or planes selected first are the mate's: the first two a mate can use)
    const pre = !edit && this.sel?.kind === 'refs' ? this.sel.refs.filter((r) => ['plane', 'axis', 'point'].includes(r.kind)) : [];
    this.sel = null;
    for (const r of pre.slice(0, 2)) if (!this.pm.picks.length || this.pm.picks[0].comp !== r.comp) this.pmPick(r);
    this.app.status('Mate: click two faces, edges or vertices on different components.');
    this.renderAll();
    this.highlight();
  }
  pmPick(r) {
    const pm = this.pm;
    // (a width or symmetric mate's further entities, after its first two)
    const extra = MATE_TYPES[pm.type]?.extra || 0;
    if (pm.picks.length === 2 && extra && (pm.extra ||= []).length < extra) {
      if (pm.type === 'width') {
        const want = pm.picks[pm.extra.length].comp;
        if (r.comp !== want || r.kind !== 'plane') { this.app.toast(pm.extra.length ? 'Now the second component’s other face' : 'Now the first component’s other face (parallel to its first)'); return; }
      } else if (r.kind !== 'plane') { this.app.toast('Pick the plane (or flat face) between them'); return; }
      pm.extra.push(r); this.previewMate(); this.renderPM(); this.highlight(); return;
    }
    if (pm.picks.length >= 2) { pm.picks = []; pm.extra = []; }
    if (pm.picks.length === 1 && pm.picks[0].comp === r.comp) { this.app.toast('Pick the second entity on another component'); return; }
    pm.picks.push(r);
    if (pm.picks.length === 2) {
      const [A, B] = pm.picks.map((x) => this.worldRef(x));
      const choices = mateChoices(A, B);
      if (!pm.type || !choices.includes(pm.type)) pm.type = choices[0];
      this.setDefaultValue();
      this.previewMate();
    } else this.app.status('Now click the entity on the other component.');
    this.renderPM();
    this.highlight();
  }
  setDefaultValue() {
    const pm = this.pm;
    if (pm.picks.length < 2) return;
    // (from where the components were before this mate was shown)
    const now = JSON.stringify(this.doc.components);
    if (this.pmBefore) Object.assign(this.doc.components, JSON.parse(this.pmBefore).map((x, i) => Object.assign(this.doc.components[i], x)));
    const [A, B] = pm.picks.map((x) => this.worldRef(x));
    Object.assign(this.doc.components, JSON.parse(now).map((x, i) => Object.assign(this.doc.components[i], x)));
    // aligned or not: as they face now (the least turning; Flip for the other way)
    const dA = A.n || A.d, dB = B.n || B.d;
    pm.align = dA && dB ? (dot(dA, dB) >= 0 ? 1 : -1) : -1;
    if (pm.type === 'cam') { const fol = A.pts && !B.pts ? B : A; pm.value ??= r6(fol.kind === 'axis' && fol.r > 0 ? fol.r : 0); }
    if (pm.type === 'distance') {
      const plane = A.kind === 'plane' ? A : B.kind === 'plane' ? B : null, other = plane === A ? B : A;
      if (plane) { const d = dot(plane.n, sub(other.p, plane.p)); pm.side = d >= 0 ? 1 : -1; pm.value ??= r6(Math.abs(d)); }
      else if (A.kind === 'axis') pm.value ??= r6(len(cross(sub(B.p, A.p), unit(A.d))));
      else if (B.kind === 'axis') pm.value ??= r6(len(cross(sub(A.p, B.p), unit(B.d))));
      else pm.value ??= r6(len(sub(A.p, B.p)));
    }
    if (pm.type === 'angle') { const x = A.n || A.d, y = B.n || B.d; pm.value ??= r6((Math.atan2(len(cross(x, y)), dot(x, y)) * 180) / Math.PI); }
    // a gear pair turns in the ratio of the cylinders picked (their pitch circles); a rack moves a pitch
    // circumference per turn of its pinion
    if (pm.type === 'gear') pm.value ??= A.r > 0 && B.r > 0 ? r6(A.r / B.r) : 1;
    if (pm.type === 'rack') { const r = A.kind === 'axis' && A.r > 0 ? A.r : B.r; pm.value ??= r6(2 * Math.PI * (r || 10)); }
    if (pm.type === 'screw') pm.value ??= 1;
    if (pm.type === 'slot') { const [P, L] = B.len ? [A, B] : [A.len ? B : A, A.len ? A : B]; const r = sub(P.p, L.p); pm.value ??= r6(P.kind === 'axis' && len(cross(P.d, L.d)) > 1e-9 ? Math.abs(dot(r, unit(cross(P.d, L.d)))) : len(cross(r, unit(L.d)))); }
    if (pm.type === 'gear' || pm.type === 'rack' || pm.type === 'screw') pm.side ??= 1;
    if (pm.type === 'tangent') {
      const plane = A.kind === 'plane' ? A : B.kind === 'plane' ? B : null, other = plane === A ? B : A;
      if (plane) pm.side = dot(plane.n, sub(other.p, plane.p)) >= 0 ? 1 : -1;
    }
  }
  // the mate as it would be made
  pmMate() {
    const pm = this.pm;
    if (!pm || pm.picks.length < 2 || !pm.type) return null;
    const m = { id: pm.edit || '__new', name: '', type: pm.type, a: pm.picks[0], b: pm.picks[1], align: pm.align, side: pm.side, value: pm.value, ...(pm.limit && ['distance', 'angle'].includes(pm.type) ? { limit: true, min: pm.min ?? '', max: pm.max ?? '' } : {}) };
    const extra = MATE_TYPES[pm.type]?.extra || 0;
    if (extra) {
      if ((pm.extra || []).length < extra) return null;
      if (pm.type === 'width') { m.a2 = pm.extra[0]; m.b2 = pm.extra[1]; }
      else {
        m.s = pm.extra[0];
        // (aligned as the mirror image of the first faces the second now)
        const A = this.worldRef(m.a), B = this.worldRef(m.b), S = this.worldRef(m.s), d = A.n || A.d, e = B.n || B.d;
        if (d && e && S?.n && !pm.flipped) { const md = sub(d, mul(S.n, 2 * dot(d, S.n))); m.align = dot(md, e) >= 0 ? 1 : -1; }
      }
    }
    if (pm.type === 'gear' || pm.type === 'rack' || pm.type === 'screw') {
      // (the poses before this mate was shown applied)
      const now = JSON.stringify(this.doc.components);
      if (this.pmBefore) Object.assign(this.doc.components, JSON.parse(this.pmBefore).map((x, i) => Object.assign(this.doc.components[i], x)));
      m.ref = mechRef(m, (id) => this.poseOfId(id), (r) => this.worldRef(r));
      Object.assign(this.doc.components, JSON.parse(now).map((x, i) => Object.assign(this.doc.components[i], x)));
    }
    if (pm.type === 'lock') {
      const pa = this.poseOfId(m.a.comp), pb = this.poseOfId(m.b.comp), inv = pa.q.clone().invert();
      const relQ = inv.clone().multiply(pb.q);
      m.rel = { p: applyQ(inv, sub(pb.p, pa.p)), q: [relQ.x, relQ.y, relQ.z, relQ.w] };
    }
    return m;
  }
  // show the mate applied (components moved); an error when it can't be
  previewMate() {
    const m = this.pmMate();
    if (!m) return;
    Object.assign(this.doc.components, JSON.parse(this.pmBefore).map((x, i) => Object.assign(this.doc.components[i], x)));
    const v = this.view(), others = v.mates.filter((x) => x.id !== m.id);
    let r = solveAssembly(v, { only: [...others, m] });
    // (the alignment chosen from how they face now can be out of reach, e.g. faces at right angles: then the
    // other one, unless Flip was used)
    if (!r.ok && !this.pm.flipped && this.pm.align && ['coincident', 'parallel'].includes(m.type)) {
      Object.assign(this.doc.components, JSON.parse(this.pmBefore).map((x, i) => Object.assign(this.doc.components[i], x)));
      const m2 = { ...m, align: -m.align };
      const r2 = solveAssembly(v, { only: [...others, m2] });
      if (r2.ok) { this.pm.align = m2.align; r = r2; }
      else Object.assign(this.doc.components, JSON.parse(this.pmBefore).map((x, i) => Object.assign(this.doc.components[i], x)));
    }
    this.pm.error = r.ok ? null : 'This mate conflicts with the others (over-defined) or can\'t be reached: try Flip, another type or other entities.';
    if (r.ok) this.dofs = r.dofs || this.dofs;
    else Object.assign(this.doc.components, JSON.parse(this.pmBefore).map((x, i) => Object.assign(this.doc.components[i], x)));
    this.updateGeometry();
    this.renderPM();
  }
  okMate() {
    const need = MATE_TYPES[this.pm?.type]?.extra || 0;
    if (this.pm?.picks.length === 2 && need && (this.pm.extra || []).length < need) { this.app.toast(this.pm.type === 'width' ? 'A width mate needs the other face of each component too' : 'A symmetric mate needs the plane between them', true); return; }
    const m = this.pmMate();
    if (!m) { this.cancelMate(); return; }
    if (this.pm.error) { this.app.toast(this.pm.error, true); return; }
    if (this.pm.edit) {
      const old = this.doc.mates.find((x) => x.id === this.pm.edit);
      // (a configuration shown keeps its own value; the rest of the mate is the same in all)
      const cfgVal = this.cfg() && MATE_TYPES[m.type].value && old.type === m.type;
      const { value, ...rest } = m;
      Object.assign(old, { ...rest, id: old.id, name: old.name }, cfgVal ? {} : { value });
      if (cfgVal) this.setMate(old, 'value', value);
    } else {
      const n = this.doc.mates.filter((x) => x.type === m.type).length + 1;
      this.doc.mates.push({ ...m, id: this.uid('m'), name: `${MATE_TYPES[m.type].label}${n}` });
    }
    const editing = !!this.pm.edit;
    this.pm = null;
    this.change(`${MATE_TYPES[m.type].label} mate ${editing ? 'changed' : 'added'}.`);
    if (!editing) this.startMate(); // (ready for the next mate)
  }
  cancelMate(quiet = false) {
    if (!this.pm) return;
    if (this.pmBefore) Object.assign(this.doc.components, JSON.parse(this.pmBefore).map((x, i) => Object.assign(this.doc.components[i], x)));
    this.pm = null;
    this.pmBefore = null;
    this._before = null;
    if (!quiet) { this.updateGeometry(); this.renderAll(); this.highlight(); this.app.status('Ready'); }
  }
  deleteMate(id) {
    this.begin();
    this.doc.mates = this.doc.mates.filter((m) => m.id !== id);
    if (this.sel?.id === id) this.sel = null;
    this.solve();
    this.change('Mate deleted.');
  }
  toggleMate(id) { const m = this.doc.mates.find((x) => x.id === id); if (!m) return; this.begin(); this.setMate(m, 'suppressed', !this.effMate(m).suppressed); this.solve(); this.change(); }
  flipMate(id) {
    const m = this.doc.mates.find((x) => x.id === id);
    if (!m) return;
    this.begin();
    if (m.type === 'distance' || m.type === 'tangent' || m.type === 'gear' || m.type === 'rack') m.side = -(m.side || 1); else m.align = -(m.align || -1);
    if (!this.solve().ok) { this.restore(this._before); this.app.toast('Flipped, the mates can\'t all be met: left as it was', true); return; }
    this.change();
  }

  // ---------------------------------------------------------------- bill of materials
  // Interference Check: where components overlap (in red), with the overlap volume of each pair. Parts that
  // only touch (mated faces) do not count. Done with the components where the mates put them (not exploded).
  async checkInterference() {
    const shown = this.doc.components.filter((c) => !this.eff(c).suppressed);
    if (shown.length < 2) { this.app.toast('Interference Check needs two or more components', true); return; }
    if (this.doc.exploded) this.setExploded(null, false);
    let r;
    try { r = await this.app.withProgress('Checking for interference…', () => (this.app.kernelPool || this.app.kernel).request('asmInterference', { doc: JSON.stringify(this.doc) }, 'asm-parts')); } catch (e) { this.app.toast('Interference Check failed: ' + e.message, true); return; }
    this.vp.setPreview(r.mesh ? { remove: r.mesh } : null);
    this.vp.requestRender?.();
    // a body's path → "Component" (inside a sub-assembly: "Sub-assembly ▸ Component")
    const nameOf = (path) => {
      const ids = String(path).split('/').slice(0, -1);
      let doc = this.doc;
      const names = [];
      for (const id of ids) {
        const c = (doc?.components || []).find((x) => x.id === id);
        if (!c) break;
        names.push(c.name);
        doc = (doc.parts || []).find((p) => p.id === c.part)?.doc;
      }
      return names.join(' ▸ ') || path;
    };
    const U = unitOf(this.doc);
    const html = r.pairs.length
      ? `<p>${r.pairs.length} interference${r.pairs.length === 1 ? '' : 's'} (shown in red):</p><table class="grid"><tr><th>Component</th><th>Component</th><th>Overlap volume</th></tr>${r.pairs.map((x) => `<tr><td>${esc(nameOf(x.a))}</td><td>${esc(nameOf(x.b))}</td><td class="num">${volWithUnit(x.volume, U)}</td></tr>`).join('')}</table><p class="pm-hint">Faces that only touch (such as mated faces) are not counted.</p>`
      : '<p>No interference: no two components overlap.</p><p class="pm-hint">Faces that only touch (such as mated faces) are not counted.</p>';
    await this.app.ui.choose('Interference Check', 'interference', html, [['ok', 'Close', true]]);
    this.vp.setPreview(null);
  }

  // the Bill of Materials window's columns: the assembly's own (doc.bomCols), else item, part, qty, material, the
  // parts' custom properties and the file
  bomCols() {
    if (this.doc.bomCols?.length) return this.doc.bomCols;
    return [{ key: 'item', title: 'Item' }, { key: 'name', title: 'Part' }, { key: 'qty', title: 'Qty' }, { key: 'material', title: 'Material' },
      ...bomPropNames(this.doc).map((n) => ({ key: 'prop:' + n, title: n })), { key: 'file', title: 'File' }];
  }
  showBOM() {
    // (indented: one row per part / sub-assembly and configuration used, a sub-assembly's own under it with the
    // quantity in one of it; suppressed components left out. bom.js: shared with the BOM tables and balloons on
    // drawings.) Click a heading for its column's menu (what it shows, insert, move, rename, remove); values typed
    // into the table are edited in place.
    const box = el('div');
    const NUM = ['qty', 'mass', 'totalMass', 'cost', 'totalCost'];
    const render = () => {
      const rows = bomRows(this.doc), cols = this.bomCols(), totals = bomTotals(rows, cols);
      const top = rows.filter((r) => !r.depth);
      const cell = (r, c, i) => {
        if (c.key === 'text') return `<td><input class="bc-v" data-col="${i}" data-row="${esc(r.key)}" value="${esc(bomCell(r, c))}"></td>`;
        if (c.key === 'name') return `<td style="padding-left:${6 + r.depth * 14}px">${r.sub ? '<b>' : ''}${esc(r.name)}${r.sub ? '</b>' : ''}</td>`;
        return `<td${NUM.includes(c.key) ? ' class="num"' : ''}>${esc(bomCell(r, c))}</td>`;
      };
      box.innerHTML = `<table class="bom"><tr>${cols.map((c, i) => `<th class="bc-h" data-col="${i}" title="Click: what this column shows, insert, move, rename, remove">${esc(c.title)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${cols.map((c, i) => cell(r, c, i)).join('')}</tr>`).join('')}${totals ? `<tr class="bc-total">${cols.map((c, i) => `<td${NUM.includes(c.key) ? ' class="num"' : ''}>${esc(totals[i] ?? '')}</td>`).join('')}</tr>` : ''}</table>
        <p class="pm-hint">${top.reduce((t, r) => t + r.qty, 0)} components at the top level, ${top.length} different parts and sub-assemblies${rows.length > top.length ? ' (a sub-assembly\'s quantities are for one of it)' : ''}. Click a column heading to change the columns. Masses come from the parts' materials; costs from their Cost property.</p>`;
      box.querySelectorAll('th.bc-h').forEach((th) => {
        th.onclick = (e) => {
          const cols2 = JSON.parse(JSON.stringify(this.bomCols()));
          const done = () => { this.begin(); this.doc.bomCols = cols2; this.change('Bill of materials columns changed.'); render(); };
          const r = th.getBoundingClientRect();
          this.app.ui.showContext(r.left, r.bottom, bomColumnMenu(cols2, +th.dataset.col, bomSources(bomPropNames(this.doc), cols2), done, (t) => this.app.ui.promptText('Column Heading', 'bom', 'Heading', t)));
          e.stopPropagation();
        };
      });
      box.querySelectorAll('input.bc-v').forEach((inp) => {
        inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); };
        inp.onchange = () => {
          const cols2 = JSON.parse(JSON.stringify(this.bomCols())), c = cols2[+inp.dataset.col];
          (c.values ||= {})[inp.dataset.row] = inp.value;
          this.begin(); this.doc.bomCols = cols2; this.change();
        };
      });
    };
    render();
    const csv = () => {
      const rows = bomRows(this.doc), cols = this.bomCols(), totals = bomTotals(rows, cols), q = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
      return [cols.map((c) => q(c.title)).join(','), ...rows.map((r) => cols.map((c) => q(bomCell(r, c))).join(',')), ...(totals ? [cols.map((c, i) => q(totals[i] ?? '')).join(',')] : [])].join('\r\n');
    };
    const dlg = this.app.ui.modal('Bill of Materials', 'bom', box, [
      { label: 'Default Columns', action: () => { if (this.doc.bomCols) { this.begin(); delete this.doc.bomCols; this.change(); } render(); return false; } },
      { label: 'Copy as CSV', action: () => { navigator.clipboard?.writeText(csv()); this.app.status('Bill of materials copied (CSV).'); return false; } },
      { label: 'Save CSV…', action: () => { platform.saveBinary(`${this.safeName()} BOM.csv`, new TextEncoder().encode(csv()), 'csv'); } },
      { label: 'Close', primary: true },
    ]);
    dlg.body.closest('.modal')?.classList.add('modal-wide');
  }

  // The assembly as a STEP file with its structure: each part once, every component placed and named after it,
  // sub-assemblies as assemblies, with the parts' colours (suppressed components left out).
  exportDoc() {
    // (each part's colour as the view shows it: its material's, else its own)
    const withColours = (d) => ({ ...d, parts: (d.parts || []).map((p) => {
      if (isAssembly(p.doc)) return { ...p, doc: withColours(p.doc) };
      const c = materialById(p.doc?.material)?.color ?? p.color ?? DEFAULT_BODY_COLOR;
      return { ...p, exportColor: '#' + (Number(c) >>> 0 & 0xffffff).toString(16).padStart(6, '0') };
    }) });
    return withColours(this.doc);
  }
  async exportSTEP() {
    if (!this.doc.components.length) return;
    try {
      const r = await this.app.withProgress('Exporting STEP…', () => (this.app.kernelPool || this.app.kernel).request('exportAssemblySTEP', { doc: JSON.stringify(this.exportDoc()) }, 'asm-parts'));
      const path = await platform.saveBinary(`${this.safeName()}.step`, r.bytes, 'step');
      if (path !== null) this.app.status(`STEP saved: ${r.parts} part${r.parts === 1 ? '' : 's'}, ${r.components} component${r.components === 1 ? '' : 's'}${r.assemblies > 1 ? `, ${r.assemblies - 1} sub-assembl${r.assemblies === 2 ? 'y' : 'ies'}` : ''}.`);
    } catch (e) { this.app.toast('STEP export failed: ' + e.message, true); }
  }

  // ---------------------------------------------------------------- file
  safeName() { return (this.doc.name || 'Assembly').replace(/[\\/:*?"<>|]/g, '_'); }
  async save(saveAs = false) {
    if (this.pm) this.cancelMate();
    try {
      // parts and sub-assemblies that are only inside this assembly (e.g. from a STEP file): kept in it, or each
      // saved as a file of its own beside it (asked on the first save and on Save As, until kept inside)
      let separate = false;
      const inside = platform.desktop ? this.insideCount() : 0;
      if (inside && (saveAs || !this.filePath || !this.doc.keepInside)) {
        const choice = await this.app.ui.choose('Save the Assembly', 'save',
          `<p><b>${esc(this.doc.name)}</b> has ${inside} part${inside === 1 ? '' : 's'} and sub-assembl${inside === 1 ? 'y' : 'ies'} that are only inside it.</p><p class="pm-hint">As separate files, each part is saved as a .rcad file and each sub-assembly as a .rasm file beside the assembly, so each can be opened and changed on its own; the assembly uses those files. As one file, they all stay inside the assembly file.</p>`,
          [['separate', 'Save Parts as Separate Files', true], ['one', 'Save as One File']]);
        if (!choice) return false;
        separate = choice === 'separate';
        if (separate) delete this.doc.keepInside; else this.doc.keepInside = true;
      }
      let thumb = null;
      try { thumb = this.vp.snapshot(); } catch { /* saved without a preview */ }
      // (the section view as it is: opened with the cut on again)
      const sec = this.app.sectionForFile();
      if (sec) this.doc.section = sec; else delete this.doc.section;
      const path = await platform.saveText(`${this.safeName()}${ASM_EXT}`, docJSON(this.doc, thumb, 1), saveAs ? null : this.filePath, this.filePath, 'assembly');
      if (!path) return false;
      if (platform.desktop) this.filePath = path;
      let rename = platform.desktop && isDefaultName(this.doc.name) && fileStem(path) !== this.doc.name;
      if (rename) this.doc.name = fileStem(path);
      let written = 0;
      if (separate) {
        written = await this.saveInsideSeparately(path);
        if (written === null) { this.app.status(`Saved ${String(path).split(/[\\/]/).pop()} (as one file: the separate files were not written)`); written = 0; }
        else rename = true; // (again, now using the files)
      }
      if (rename) await platform.saveText(`${this.safeName()}${ASM_EXT}`, docJSON(this.doc, thumb, 1), path, path, 'assembly');
      this.dirty = false;
      this.app.updateTitle();
      this.renderTree();
      this.app.status('Saved ' + String(path).split(/[\\/]/).pop() + (written ? ` and ${written} part and sub-assembly file${written === 1 ? '' : 's'} beside it` : ''));
      return true;
    } catch (err) {
      this.app.toast('Save failed: ' + err.message, true);
      return false;
    }
  }

  // how many parts and sub-assemblies (all through the tree, each once) have no file of their own
  insideCount() {
    const seen = new Set();
    const walk = (doc, depth) => {
      if (depth > 16) return;
      for (const p of doc.parts || []) {
        if (p.path || seen.has(p.doc)) continue;
        seen.add(p.doc);
        if (this.isSub(p)) walk(p.doc, depth + 1);
      }
    };
    walk(this.doc, 0);
    return seen.size;
  }

  // Collect Files: the assembly with everything in it (parts and sub-assemblies, as the assembly has them now) copied into
  // one folder, each a file of its own, names given a prefix / suffix if asked; the copied assemblies use the copied
  // files. The assembly open here is left as it is. Returns the files written ([{ name, path }]), or null.
  async collectFiles(opts = null) {
    const a = this.app;
    const v = opts || (await a.ui.promptFields('Collect Files', 'save', [
      { key: 'prefix', label: 'Before each name', type: 'text', value: '' },
      { key: 'suffix', label: 'After each name', type: 'text', value: '' },
    ], 'Every part and sub-assembly of the assembly is copied, with the assembly, into the folder you choose next (to send it on, or to start a variant of it).'));
    if (!v) return null;
    const folder = v.folder || (await platform.pickFolder());
    if (!folder) return null;
    const top = JSON.parse(JSON.stringify(this.doc)), used = new Set(), out = [];
    const safe = (s) => (String(s || 'Part').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 120) || 'Part');
    const nameOf = (base, ext) => { let b = safe(`${v.prefix || ''}${base}${v.suffix || ''}`), n = b + ext, k = 2; while (used.has(n.toLowerCase())) n = `${b} (${k++})${ext}`; used.add(n.toLowerCase()); return n; };
    const written = new Map(); // (the same document used twice: one file)
    const sep = String(folder).includes('\\') ? '\\' : '/';
    const write = async (doc, name) => {
      const path = await platform.saveInto(folder, name, new TextEncoder().encode(docJSON(doc, null, doc.kind === 'assembly' ? 1 : 0)));
      if (!path) throw new Error(`${name} could not be written`);
      out.push({ name, path });
      return path;
    };
    const pack = async (doc, depth) => {
      if (depth > 16) return;
      for (const p of doc.parts || []) {
        if (p.libKey || !p.doc) continue;
        const key = JSON.stringify(p.doc);
        if (!written.has(key)) {
          const sub = this.isSub(p);
          if (sub) await pack(p.doc, depth + 1);
          const name = nameOf(p.name || p.doc.name || 'Part', sub ? ASM_EXT : '.rcad');
          p.doc.name = name.replace(/\.[^.]+$/, '');
          written.set(key, await write(p.doc, name) || `${folder}${sep}${name}`);
        }
        p.path = written.get(key);
        p.name = String(p.path).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
      }
    };
    try {
      await a.withProgress?.('Collect Files…', async () => {
        await pack(top, 0);
        const name = nameOf(this.doc.name || 'Assembly', ASM_EXT);
        top.name = name.replace(/\.[^.]+$/, '');
        await write(top, name);
      });
    } catch (e) { a.toast('Collect Files failed: ' + e.message, true); return null; }
    a.status(`Collect Files: ${out.length} file${out.length === 1 ? '' : 's'} written${platform.desktop ? ` to ${folder}` : ''}.`);
    return out;
  }

  // Each part and sub-assembly that is only inside this assembly saved as a file of its own beside it (the
  // assembly at mainPath, just saved): parts as .rcad, sub-assemblies as .rasm, those inside a sub-assembly
  // before it, so every assembly file uses the files of what is in it. Returns how many files were written, or
  // null when that was cancelled.
  async saveInsideSeparately(mainPath) {
    const plan = [], planned = new Map(), used = new Set();
    const safe = (s) => (String(s || 'Part').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 120) || 'Part');
    const fileName = (p, ext) => {
      let base = safe(p.name || p.doc.name), name = base + ext, k = 2;
      if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) { base += '_'; name = base + ext; }
      while (used.has(name.toLowerCase()) || sameFile(name, String(mainPath).split(/[\\/]/).pop())) name = `${base} (${k++})${ext}`;
      used.add(name.toLowerCase());
      return name;
    };
    const walk = (doc, depth) => {
      if (depth > 16) return;
      for (const p of doc.parts || []) {
        if (p.path || planned.has(p.doc)) continue;
        const sub = this.isSub(p);
        if (sub) walk(p.doc, depth + 1); // (what is inside it first)
        const entry = { doc: p.doc, sub, name: fileName(p, sub ? ASM_EXT : '.rcad') };
        planned.set(p.doc, entry);
        plan.push(entry);
      }
    };
    walk(this.doc, 0);
    if (!plan.length) return 0;
    const there = await platform.besideExists(mainPath, plan.map((x) => x.name));
    if (there.length) {
      const ok = await this.app.ui.choose('Replace Files', 'save',
        `<p>${there.length === 1 ? `<b>${esc(there[0])}</b> is` : `${there.length} of the files (${there.slice(0, 4).map(esc).join(', ')}${there.length > 4 ? '…' : ''}) are`} already in the assembly's folder.</p><p class="pm-hint">Replace ${there.length === 1 ? 'it' : 'them'} with the parts and sub-assemblies of this assembly?</p>`,
        [['replace', 'Replace', true], ['cancel', 'Cancel']]);
      if (ok !== 'replace') return null;
    }
    // every part record (anywhere in the tree) that uses a document now uses its file
    const setPath = (doc, path, depth = 0) => {
      const visit = (d, k) => {
        if (k > 16) return;
        for (const p of d.parts || []) {
          if (p.doc === doc) p.path = path;
          else if (this.isSub(p) && !p.path) visit(p.doc, k + 1);
        }
      };
      visit(this.doc, depth);
    };
    let n = 0;
    for (const x of plan) {
      this.app.status(`Saving ${x.name} (${n + 1} of ${plan.length})…`);
      const path = await platform.saveBeside(mainPath, x.name, docJSON(x.doc, null, x.sub ? 1 : 0));
      if (!path) throw new Error(`${x.name} could not be saved`);
      setPath(x.doc, path);
      n++;
    }
    return n;
  }

  // ---------------------------------------------------------------- keys
  handleKey(e) {
    if (this.explodeTool && this.explodeTool.key(e)) return true;
    if (this.motionTool && this.motionTool.key(e)) return true;
    if (this.holeTool && this.holeTool.key(e)) return true;
    const typing = e.target.closest?.('input, select, textarea');
    if (typing) { if (e.key === 'Enter' && this.pm) { this.okMate(); return true; } return false; }
    const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (ctrl && k === 'z') { e.preventDefault(); this.undo(); return true; }
    if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); this.redo(); return true; }
    const views = { 1: 'front', 2: 'back', 3: 'left', 4: 'right', 5: 'top', 6: 'bottom', 7: 'iso' };
    if (ctrl && views[e.key]) { e.preventDefault(); this.vp.setStandardView(views[e.key]); return true; }
    if (ctrl) return false;
    if (e.key.startsWith('Arrow') && this.vp.controls.key(e)) { e.preventDefault(); return true; }
    if (e.key === 'Escape') { if (this.pm) this.cancelMate(); else this.select(null); return true; }
    if (e.key === 'Enter' && this.pm) { this.okMate(); return true; }
    if (e.key === 'Delete') {
      if (this.sel?.kind === 'comp') this.deleteComponent(this.sel.id);
      else if (this.sel?.kind === 'mate') this.deleteMate(this.sel.id);
      return true;
    }
    if (k === 'f') { this.vp.zoomToFit(); return true; }
    if (k === 'm' && !this.pm) { this.startMate(); return true; }
    return false;
  }

  // ---------------------------------------------------------------- UI: ribbon, menus, tree, Property panel
  commandDefs() {
    const selC = this.selComp();
    return {
      assembly: [
        { icon: 'insertComponent', label: 'Insert Components', action: () => this.insertComponents() },
        { icon: 'stdParts', label: 'Standard Parts', action: () => this.standardParts() },
        { icon: 'stdParts', label: 'Fasten All Holes', action: () => this.autoFastenDialog() },
        { icon: 'equations', label: 'Equations', action: () => this.showEquations() },
        { icon: 'asmHole', label: 'Assembly Hole', action: () => this.startAsmFeature('hole'), active: this.holeTool?.f?.type === 'hole' },
        { icon: 'asmCut', label: 'Assembly Cut', action: () => this.startAsmFeature('cut'), active: this.holeTool?.f?.type === 'cut' },
        { icon: 'mate', label: 'Mate', key: 'M', action: () => this.startMate(), active: !!this.pm },
        { icon: 'lpattern', label: 'Component Pattern', action: () => this.startCompPattern('linear') },
        { icon: 'cpattern', label: 'Circular Component Pattern', action: () => this.startCompPattern('circular') },
        { icon: 'mirror', label: 'Mirror Components', action: () => this.startCompPattern('mirror') },
        'sep',
        { icon: 'fix', label: 'Fix', action: () => selC && this.setFixed(selC.id, true), disabled: !selC || selC.fixed },
        { icon: 'float', label: 'Float', action: () => selC && this.setFixed(selC.id, false), disabled: !selC || !selC.fixed },
        { icon: selC && this.eff(selC).hidden ? 'show' : 'hide', label: selC && this.eff(selC).hidden ? 'Show Component' : 'Hide Component', action: () => selC && this.setHidden(selC.id, !this.eff(selC).hidden), disabled: !selC },
        { icon: 'suppress', label: selC && this.eff(selC).suppressed ? 'Unsuppress' : 'Suppress', action: () => selC && this.setSuppressed(selC.id, !this.eff(selC).suppressed), disabled: !selC },
        { icon: 'part', label: 'Open Part', action: () => selC && this.openPart(selC.id), disabled: !selC },
        { icon: 'part', label: 'Edit in Context', action: () => selC && this.editInContext(selC.id), disabled: !selC },
        'sep',
        { icon: 'explode', label: 'Exploded View', action: () => this.startExplode(), active: !!this.explodeTool },
        { icon: 'explode', label: 'Positions', action: () => this.positionsDialog() },
        { icon: 'explode', label: this.doc.exploded ? 'Collapse' : 'Explode', action: () => (this.doc.exploded ? this.setExploded(null, true) : this.doc.explodes.length && this.setExploded(this.doc.explodes[this.doc.explodes.length - 1].id, true)), disabled: !this.doc.explodes.length },
        { icon: 'motion', label: 'Motion Study', action: () => this.startMotion(), active: !!this.motionTool },
        'sep',
        { icon: 'bom', label: 'Bill of Materials', action: () => this.showBOM() },
        { icon: 'bom', label: 'Number Parts', action: () => this.numberPartsDialog() },
        { icon: 'interference', label: 'Interference Check', action: () => this.checkInterference() },
        { icon: 'measure', label: 'Tolerance Stack-Up', action: () => this.app.ui.showStackUp(this.doc, () => this.commit('Tolerance stack-up')) },
        { icon: 'section', label: 'Section View', action: () => this.toggleSection(), active: !!this.vp.section },
        { icon: 'collide', label: 'Collision Detection', action: () => this.setCollideMode(this.collideMode === 'off' ? 'stop' : 'off'), active: this.collideMode !== 'off' },
        { icon: 'speed', label: 'Speed Mode', action: () => this.setSpeedMode(!this.doc.speedMode), active: !!this.doc.speedMode },
        { icon: 'zoomfit', label: 'Zoom to Fit', key: 'F', action: () => this.vp.zoomToFit() },
      ],
    };
  }
  renderCommandManager() {
    if (!this.isActive()) return;
    const defs = this.commandDefs();
    const btns = $('#cm-buttons');
    btns.innerHTML = '';
    for (const d of defs[this.cmTab]) {
      if (d === 'sep') { btns.appendChild(el('div', { class: 'cm-sep' })); continue; }
      const b = el('button', { class: 'cm-btn' + (d.active ? ' active' : ''), title: tr(d.label) + (d.key ? ` (${d.key})` : ''), disabled: d.disabled }, `<span class="cm-ic">${icon(d.icon)}${d.key ? `<span class="cm-key">${esc(d.key)}</span>` : ''}</span><span>${esc(tr(d.label))}</span>`);
      b.addEventListener('click', () => { this.app.macros?.note(d.label); d.action(); });
      btns.appendChild(b);
    }
    const tabs = $('#cm-tabs');
    tabs.innerHTML = '';
    const t = el('button', { class: 'active' }, esc(tr('Assembly')));
    tabs.appendChild(t);
  }
  menuDefs() {
    const a = this.app, selC = this.selComp();
    return {
      File: [
        { label: 'New Part', icon: 'newdoc', key: 'Ctrl+N', action: () => a.newDocument() },
        { label: 'New Assembly', icon: 'assembly', action: () => a.newAssembly() },
        { label: 'New Drawing', icon: 'drawing', action: () => a.newDrawing() },
        { label: 'Make Drawing from Assembly', icon: 'std3View', action: () => a.newDrawing(true), disabled: !this.doc.components.length },
        { label: 'Open…', icon: 'open', key: 'Ctrl+O', action: () => a.openFile() },
        { label: 'Recent Files / Start…', icon: 'open', action: () => a.showStart() },
        'sep',
        { label: 'Save', icon: 'save', key: 'Ctrl+S', action: () => a.saveFile() },
        { label: 'Save As…', icon: 'save', key: 'Ctrl+Shift+S', action: () => a.saveFile(true) },
        { label: 'Collect Files…', icon: 'save', action: () => this.collectFiles(), disabled: !this.doc.components.length },
        { label: 'Revisions…', icon: 'revTable', action: () => revisionsDialog(a, this.doc, () => this.commit('Revision'), ASM_EXT) },
        { label: 'Where Used…', icon: 'open', action: () => a.whereUsed() },
        'sep',
        { label: 'Export ▸ STEP…', icon: 'step', action: () => this.exportSTEP(), disabled: !this.doc.components.length },
        'sep',
        { label: 'Properties…', icon: 'customProps', action: () => { const before = this.snapshot(); editCustomProps(this.app.ui, this.doc, (ch) => { if (ch) { this._before = before; this.change('Assembly properties changed.'); } }, 'assembly'); } },
      ],
      Edit: [
        { label: 'Undo', icon: 'undo', key: 'Ctrl+Z', action: () => this.undo(), disabled: !this.undoStack.length },
        { label: 'Redo', icon: 'redo', key: 'Ctrl+Y', action: () => this.redo(), disabled: !this.redoStack.length },
        'sep',
        { label: 'Delete', icon: 'trash', key: 'Del', action: () => (this.sel?.kind === 'comp' ? this.deleteComponent(this.sel.id) : this.sel?.kind === 'mate' ? this.deleteMate(this.sel.id) : null), disabled: !this.sel },
      ],
      View: [
        { label: 'Zoom to Fit', icon: 'zoomfit', key: 'F', action: () => this.vp.zoomToFit() },
        { label: (this.doc.speedMode ? '✓ ' : '') + 'Speed Mode (large assemblies)', icon: 'speed', action: () => this.setSpeedMode(!this.doc.speedMode) },
        { label: 'Isometric', icon: 'views', key: 'Ctrl+7', action: () => this.vp.setStandardView('iso') },
        { label: 'Front', icon: 'views', key: 'Ctrl+1', action: () => this.vp.setStandardView('front') },
        { label: 'Top', icon: 'views', key: 'Ctrl+5', action: () => this.vp.setStandardView('top') },
      ],
      Insert: [
        { label: 'Components…', icon: 'insertComponent', action: () => this.insertComponents() },
        { label: 'Standard Parts…', icon: 'stdParts', action: () => this.standardParts() },
        { label: 'Assembly Hole…', icon: 'asmHole', action: () => this.startAsmFeature('hole') },
        { label: 'Assembly Cut…', icon: 'asmCut', action: () => this.startAsmFeature('cut') },
        { label: 'Exploded View…', icon: 'explode', action: () => this.startExplode() },
        { label: 'Mate…', icon: 'mate', key: 'M', action: () => this.startMate() },
      ],
      Tools: [
        { label: 'Settings…', icon: 'gear', action: () => this.app.ui.showSettings() },
        'sep',
        { label: 'Bill of Materials…', icon: 'bom', action: () => this.showBOM() },
        { label: 'Equations…', icon: 'equations', action: () => this.showEquations() },
        { label: 'Interference Check…', icon: 'interference', action: () => this.checkInterference() },
        { label: 'Section View…', icon: 'section', action: () => this.app.startSection() },
        'sep',
        ...[['off', 'Collision Detection Off'], ['show', 'Show Collisions While Dragging'], ['stop', 'Stop at Collisions While Dragging']].map(([m, label]) => ({ label: (this.collideMode === m ? '✓ ' : '') + label, icon: 'collide', action: () => this.setCollideMode(m) })),
        'sep',
        { label: 'Motion Study…', icon: 'motion', action: () => this.startMotion() },
        { label: 'Fix Mates…', icon: 'fix', action: () => this.showBrokenMates() },
        ...(selC ? [{ label: `Open ${selC.name}`, icon: 'part', action: () => this.openPart(selC.id) }] : []),
      ],
    };
  }

  renderTree() {
    if (!this.isActive()) return;
    const root = $('#tree');
    root.innerHTML = '';
    const row = ({ ic, label, depth = 0, cls = '', sub = '', title = '', selected = false, onClick, onDbl, menu, vis, twisty = '', onTwisty, onHover, error = '' }) => {
      const n = el('div', { class: 'tn' + (cls ? ' ' + cls : '') + (selected ? ' selected' : ''), title });
      n.style.paddingLeft = 6 + depth * 16 + 'px';
      n.innerHTML = `<span class="tw">${twisty}</span><span class="ti">${icon(ic)}</span><span class="tl">${esc(label)}</span>${sub ? `<span class="tsub">${esc(sub)}</span>` : ''}${error ? `<span class="terr" title="${esc(error)}">!</span>` : ''}<span class="tvis"></span>`;
      if (vis) {
        const v = n.querySelector('.tvis');
        v.innerHTML = icon(vis.on ? 'visOn' : 'visOff');
        v.classList.add(vis.on ? 'on' : 'off');
        v.title = vis.on ? 'Shown — click to hide' : 'Hidden — click to show';
        v.onclick = (e) => { e.stopPropagation(); vis.toggle(); };
      }
      if (onTwisty) n.querySelector('.tw').onclick = (e) => { e.stopPropagation(); onTwisty(); };
      if (onHover) { n.onmouseenter = () => onHover(true); n.onmouseleave = () => onHover(false); }
      if (onClick) n.onclick = onClick;
      if (onDbl) n.ondblclick = onDbl;
      n.oncontextmenu = (e) => { e.preventDefault(); onClick?.(); if (menu) this.app.ui.showContext(e.clientX, e.clientY, menu()); };
      root.appendChild(n);
      return n;
    };
    const free = [...this.dofs.values()].reduce((t, x) => t + x, 0);
    row({ ic: 'assembly', label: this.doc.name + (this.cfg() ? ` (${this.cfg().name})` : ''), cls: 'tree-part', title: free ? `${free} degree${free === 1 ? '' : 's'} of freedom left among the floating components` : 'Fully placed',
      sub: this.brokenMates?.size ? `${this.brokenMates.size} mate${this.brokenMates.size > 1 ? 's' : ''} lost a face` : !this.solveOk && this.doc.mates.length ? 'mates conflict' : '',
      onDbl: () => this.app.ui.promptText('Rename Assembly', 'rename', 'Name', this.doc.name).then((v) => { if (v?.trim()) { this.begin(); this.doc.name = v.trim(); this.change(); } }) });
    // the assembly's own planes and origin (as in a part: select them, mate to them, show or hide them)
    const selRef = (key) => this.sel?.kind === 'refs' && this.sel.refs.some((r) => r.comp === ORIGIN && r.plane === key);
    for (const key of [...Object.keys(G.STD_PLANES), 'origin']) {
      const plane = key !== 'origin', shown = plane && this.planeShown(key);
      row({
        ic: plane ? 'plane' : 'origin', label: plane ? G.STD_PLANES[key].name : 'Origin', depth: 1, cls: plane && !shown ? 'hidden-item' : '',
        // (the planes' axes in the assembly's up axis; the Origin: which, changed from its menu)
        sub: plane ? W.stdPlaneAxes(key) : W.getUp() === 'z' ? 'Z up' : 'Y up',
        selected: selRef(key),
        onClick: () => this.pickRef({ ...originRef(key), gi: 'plane:' + key }),
        onHover: plane ? (on) => { this.hoverPlane = on ? key : null; this.updatePlanes(); } : null,
        vis: plane ? { on: shown, toggle: () => this.setPlaneShown(key, !shown) } : null,
        menu: () => [
          { label: 'Mate…', icon: 'mate', key: 'M', action: () => this.startMate() },
          ...(!plane ? [['y', 'Y up (Top plane XZ, Front XY)'], ['z', 'Z up (Top plane XY, Front XZ)']].map(([v, l]) => ({ label: `${W.getUp() === v ? '● ' : '　'}${l}`, icon: 'axis', action: () => this.app.setUpAxis(v) })) : []),
          ...(plane ? [{ label: 'Normal To', icon: 'normalTo', action: () => this.vp.normalTo(G.stdFrame(key)) },
            shown ? { label: 'Hide', icon: 'hide', action: () => this.setPlaneShown(key, false) } : { label: 'Show', icon: 'show', action: () => this.setPlaneShown(key, true) }] : []),
        ],
      });
    }
    this._openSubs ||= new Set();
    // a sub-assembly's own components, under it (shown as they are in it; picking one picks the sub-assembly)
    const subRows = (doc, cfgId, top, key, depth) => {
      if (depth > 17) return;
      const cf = cfgId ? (doc.configs || []).find((x) => x.id === cfgId) : null;
      for (const sc of doc.components) {
        const o = cf?.comps?.[sc.id] || {}, sp = (doc.parts || []).find((x) => x.id === sc.part);
        const hid = 'hidden' in o ? o.hidden : !!sc.hidden, sup = 'suppressed' in o ? o.suppressed : !!sc.suppressed;
        const isSub = this.isSub(sp), k = `${key}/${sc.id}`, open = this._openSubs.has(k), has = isSub || featureRowsOf(sp).length;
        row({
          ic: isSub ? 'assembly' : 'component', label: sc.name, depth, cls: (hid ? 'hidden-item' : '') + (sup ? ' suppressed' : ''),
          title: `In ${doc.name || 'the sub-assembly'}: open it to change it`,
          twisty: has ? (open ? '▼' : '▶') : '', onTwisty: has ? () => { if (open) this._openSubs.delete(k); else this._openSubs.add(k); this.renderTree(); } : null,
          selected: false,
          onClick: () => this.select({ kind: 'comp', id: top.id }),
          onDbl: () => sp && this.openPartDoc(sp),
        });
        if (isSub && open) subRows(sp.doc, 'config' in o ? o.config : (sc.config ?? null), top, k, depth + 1);
        else if (open) featureRows(sp, depth + 1, () => this.openPartDoc(sp));
      }
    };
    // a part's features, under it (to see; double-click one, or the part, to edit it)
    const featureRowsOf = (p) => (p && !this.isSub(p) && Array.isArray(p.doc?.features) ? p.doc.features : []);
    const featureRows = (p, depth, edit) => {
      for (const f of featureRowsOf(p)) {
        if (f.parent || (f.type === 'sketch' && featureRowsOf(p).some((g) => g !== f && g.type !== 'sketch' && (g.sketch === f.id || g.profile === f.id || g.path === f.id)))) continue;
        row({ ic: iconFor(f), label: f.name, depth, cls: (f.suppressed ? 'suppressed' : '') + (f.type === 'import' && f.context ? ' hidden-item' : ''), title: `${f.name} (a feature of ${p.name}): double-click to edit the part`, onDbl: edit, featureOf: p.id });
      }
    };
    for (const c of this.doc.components) {
      const e = this.eff(c), p = this.part(c.part);
      const dof = this.dofs.get(c.id) || 0, mated = this.view().mates.some((m) => !m.suppressed && (m.a.comp === c.id || m.b.comp === c.id));
      const prefix = e.suppressed ? '' : c.fixed ? '(f) ' : dof > 0 || !mated ? '(-) ' : '';
      const isSub = this.isSub(p), open = this._openSubs.has(c.id), has = isSub || featureRowsOf(p).length;
      row({
        ic: isSub ? 'assembly' : 'component', label: prefix + c.name, depth: 1, cls: (e.hidden ? 'hidden-item' : '') + (e.suppressed ? ' suppressed' : ''),
        twisty: has ? (open ? '▼' : '▶') : '', onTwisty: has ? () => { if (open) this._openSubs.delete(c.id); else this._openSubs.add(c.id); this.renderTree(); } : null,
        sub: this.partConfigs(p).length > 1 ? `(${this.configName(p, e.config)})` : '',
        title: c.fixed ? 'Fixed in place' : dof > 0 || !mated ? `Under defined: it can still move (${mated ? dof : 6} degree${(mated ? dof : 6) === 1 ? '' : 's'} of freedom) — drag it, or add mates` : 'Fully defined by its mates',
        selected: this.sel?.kind === 'comp' && this.sel.id === c.id,
        onClick: () => this.select({ kind: 'comp', id: c.id }),
        onDbl: () => this.openPart(c.id),
        menu: () => this.compMenu(c),
        vis: e.suppressed ? null : { on: !e.hidden, toggle: () => this.setHidden(c.id, !e.hidden) },
      });
      if (isSub && open) subRows(p.doc, e.config, c, c.id, 2);
      else if (open) featureRows(p, 2, () => this.editPart(c.id));
    }
    for (const pt of this.doc.compPatterns || []) row({
      ic: { linear: 'lpattern', circular: 'cpattern', mirror: 'mirror' }[pt.kind], label: pt.name, depth: 1,
      sub: `(${pt.seeds.map((id) => this.comp(id)?.name || '?').join(', ')} · ${this.doc.components.filter((c) => c.patternOf === pt.id).length} copies)`,
      onDbl: () => this.startCompPattern(pt.kind, pt.id),
      menu: () => [{ label: 'Edit Pattern', icon: 'edit', action: () => this.startCompPattern(pt.kind, pt.id) }, 'sep', { label: 'Delete', icon: 'trash', action: () => this.deleteCompPattern(pt.id) }],
    });
    const open = !this._matesClosed;
    row({ ic: 'mate', label: `Mates (${this.doc.mates.length})`, depth: 1, cls: 'tree-folder', twisty: this.doc.mates.length ? (open ? '▼' : '▶') : '', onTwisty: () => { this._matesClosed = open; this.renderTree(); } });
    if (open) for (const m0 of this.doc.mates) {
      const m = this.effMate(m0);
      const info = MATE_TYPES[m.type];
      const val = info.value ? (info.value === 'ratio' ? ` 1:${fmt(1 / (Number(m.value) || 1), 4)}` : ` ${fmt(Number(m.value))}${info.value === '°' ? '°' : info.value === 'mm/rev' ? ' mm/turn' : ' mm'}`) : '';
      row({
        ic: info.icon, label: `${m.name}${val}`, depth: 2, cls: m.suppressed ? 'suppressed' : '',
        error: this.brokenMates?.has(m.id) ? 'A face or edge of this mate is no longer in its part: edit the mate to pick it again (Tools ▸ Fix Mates)' : '',
        sub: `(${[m.a, m.b].map((r) => (r.comp === ORIGIN ? r.what : this.comp(r.comp)?.name || '?')).join(', ')})`,
        selected: this.sel?.kind === 'mate' && this.sel.id === m.id,
        onClick: () => this.select({ kind: 'mate', id: m.id }),
        onDbl: () => this.startMate(m.id),
        menu: () => [
          { label: 'Edit Mate', icon: 'edit', action: () => this.startMate(m.id) },
          ...(['coincident', 'parallel', 'distance', 'tangent', 'gear', 'rack'].includes(m.type) ? [{ label: m.type === 'gear' || m.type === 'rack' ? 'Reverse Direction' : 'Flip Alignment', icon: 'flip', action: () => this.flipMate(m.id) }] : []),
          { label: m.suppressed ? 'Unsuppress' : 'Suppress', icon: 'suppress', action: () => this.toggleMate(m.id) },
          'sep',
          { label: 'Delete', icon: 'trash', key: 'Del', action: () => this.deleteMate(m.id) },
        ],
      });
    }
    if (this.doc.asmFeatures?.length) {
      const afOpen = !this._afClosed;
      row({ ic: 'asmHole', label: `Assembly Features (${this.doc.asmFeatures.length})`, depth: 1, cls: 'tree-folder', twisty: afOpen ? '▼' : '▶', onTwisty: () => { this._afClosed = afOpen; this.renderTree(); } });
      if (afOpen) for (const f of this.doc.asmFeatures) {
        row({
          ic: f.type === 'cut' ? 'asmCut' : 'asmHole', label: f.name, depth: 2, cls: f.suppressed ? 'suppressed' : '',
          sub: `(${f.at?.pts?.length || 0} × through ${f.comps?.length || 0})`,
          title: `Cuts ${(f.comps || []).map((e) => this.comp(e.id)?.name || '?').join(', ')} — double-click to edit`,
          onDbl: () => this.startAsmFeature(f.type, f.id),
          menu: () => [
            { label: 'Edit Feature', icon: 'edit', action: () => this.startAsmFeature(f.type, f.id) },
            { label: f.suppressed ? 'Unsuppress' : 'Suppress', icon: 'suppress', action: () => this.toggleAsmFeature(f.id) },
            { label: 'Rename', icon: 'rename', action: () => this.app.ui.promptText('Rename', f.type === 'cut' ? 'asmCut' : 'asmHole', 'Name', f.name).then((v) => { if (v?.trim()) { this.begin(); f.name = v.trim(); this.change(); } }) },
            'sep',
            { label: 'Delete', icon: 'trash', action: () => this.deleteAsmFeature(f.id) },
          ],
        });
      }
    }
    if (this.doc.explodes.length) {
      const exOpen = !this._exClosed;
      row({ ic: 'explode', label: `Exploded Views (${this.doc.explodes.length})`, depth: 1, cls: 'tree-folder', twisty: exOpen ? '▼' : '▶', onTwisty: () => { this._exClosed = exOpen; this.renderTree(); } });
      if (exOpen) for (const ex of this.doc.explodes) {
        const on = this.doc.exploded === ex.id;
        row({
          ic: 'explode', label: ex.name, depth: 2, sub: on ? 'exploded' : '', cls: on ? '' : 'hidden-item',
          title: `${ex.steps.length} step${ex.steps.length === 1 ? '' : 's'} — double-click to ${on ? 'collapse' : 'explode'}`,
          onDbl: () => this.setExploded(on ? null : ex.id, true),
          menu: () => [
            on ? { label: 'Collapse', icon: 'explode', action: () => this.setExploded(null) } : { label: 'Explode', icon: 'explode', action: () => this.setExploded(ex.id) },
            { label: on ? 'Animate Collapse' : 'Animate Explode', icon: 'explode', action: () => this.setExploded(on ? null : ex.id, true) },
            { label: 'Edit Exploded View', icon: 'edit', action: () => this.startExplode(ex.id) },
            { label: 'Rename', icon: 'rename', action: () => this.app.ui.promptText('Rename', 'explode', 'Name', ex.name).then((v) => { if (v?.trim()) { this.begin(); ex.name = v.trim(); this.change(); } }) },
            'sep',
            { label: 'Delete', icon: 'trash', action: () => this.deleteExplode(ex.id) },
          ],
        });
      }
    }
    if (this.doc.motions?.length) {
      const moOpen = !this._moClosed;
      row({ ic: 'motion', label: `Motion Studies (${this.doc.motions.length})`, depth: 1, cls: 'tree-folder', twisty: moOpen ? '▼' : '▶', onTwisty: () => { this._moClosed = moOpen; this.renderTree(); } });
      if (moOpen) for (const mo of this.doc.motions) {
        row({
          ic: 'motion', label: mo.name, depth: 2, title: 'Double-click to play',
          onDbl: () => this.startMotion(mo.id, true),
          menu: () => [
            { label: 'Play', icon: 'motion', action: () => this.startMotion(mo.id, true) },
            { label: 'Edit Motion Study', icon: 'edit', action: () => this.startMotion(mo.id) },
            { label: 'Rename', icon: 'rename', action: () => this.app.ui.promptText('Rename', 'motion', 'Name', mo.name).then((v) => { if (v?.trim()) { this.begin(); mo.name = v.trim(); this.change(); } }) },
            'sep',
            { label: 'Delete', icon: 'trash', action: () => this.deleteMotion(mo.id) },
          ],
        });
      }
    }
    if (!this.doc.components.length) root.appendChild(el('div', { class: 'pm-hint', style: 'padding:10px 14px' }, 'Start with <b>Insert Components</b>: the first part is fixed at the origin; insert more and <b>Mate</b> them.'));
  }

  renderPM() {
    if (!this.isActive()) return;
    // (the Section View panel: the app's, as in a part)
    if (this.app.pm?.kind === 'section') { const root = $('#pm'); root.innerHTML = ''; this.app.ui.showLeft('pm'); this.app.ui.renderSectionPM(root); return; }
    if (this.explodeTool) { this.explodeTool.renderPM(); return; }
    if (this.motionTool) { this.motionTool.renderPM(); return; }
    if (this.holeTool) { this.holeTool.renderPM(); return; }
    const ui = this.app.ui, root = $('#pm');
    root.innerHTML = '';
    const pm = this.pm;
    if (!pm) { ui.showLeft('tree'); return; }
    ui.showLeft('pm');
    root.appendChild(el('div', { class: 'pm-head' }, `<span class="ti">${icon('mate')}</span><span>${pm.edit ? 'Edit Mate' : 'Mate'}</span>`));
    const act = el('div', { class: 'pm-actions' });
    act.appendChild(el('button', { title: 'OK (Enter)', onclick: () => this.okMate() }, icon('ok')));
    act.appendChild(el('button', { title: 'Close (Esc)', onclick: () => this.cancelMate() }, icon('cancel')));
    root.appendChild(act);
    if (pm.error) root.appendChild(el('div', { class: 'pm-msg err' }, esc(pm.error)));
    const g1 = ui.pmGroup(root, 'Entities to Mate', 'asm:ents');
    const list = el('div', { class: 'pm-list' });
    pm.picks.forEach((r, i) => {
      const li = el('div', { class: 'li sel' }, `<span>${i + 1}. ${esc(this.refLabel(r))}</span><span class="x" title="Remove">✕</span>`);
      li.querySelector('.x').onclick = () => { pm.picks.splice(i, 1); this.cancelPreview(); this.renderPM(); this.highlight(); };
      list.appendChild(li);
    });
    (MATE_TYPES[pm.type]?.extra ? pm.extra || [] : []).forEach((r, i) => {
      const li = el('div', { class: 'li sel' }, `<span>${i + 3}. ${esc(this.refLabel(r))} (${pm.type === 'width' ? 'other face' : 'mirror plane'})</span><span class="x" title="Remove">✕</span>`);
      li.querySelector('.x').onclick = () => { pm.extra.splice(i); this.cancelPreview(); this.renderPM(); this.highlight(); };
      list.appendChild(li);
    });
    if (pm.picks.length < 2) list.appendChild(el('div', { class: 'pm-hint', style: 'padding:4px 6px' }, pm.picks.length ? 'Click the entity on the other component.' : 'Click a face, edge or vertex of one component, then one of another.'));
    g1.appendChild(list);
    if (pm.picks.length === 2) {
      const [A, B] = pm.picks.map((x) => this.worldRef(x));
      const g2 = ui.pmGroup(root, 'Mate Type', 'asm:type');
      const bar = el('div', { class: 's3-tools' });
      for (const t of mateChoices(A, B)) {
        const b = el('button', { class: 's3-tool' + (pm.type === t ? ' active' : '') }, `${icon(MATE_TYPES[t].icon)}<span>${MATE_TYPES[t].label}</span>`);
        b.onclick = () => { pm.type = t; pm.value = null; pm.extra = []; this.setDefaultValue(); this.previewMate(); };
        bar.appendChild(b);
      }
      g2.appendChild(bar);
      const info = MATE_TYPES[pm.type];
      if (info?.value) {
        g2.appendChild(el('label', { class: 'pm-label' }, { angle: 'Angle', gear: 'Ratio (turns of entity 2 per turn of entity 1)', rack: 'Rack travel per pinion turn', screw: 'Advance per turn (pitch)', slot: 'Distance from the edge (0: on it)' }[pm.type] || 'Distance'));
        const vu = info.value === '°' ? '°' : info.value === 'ratio' ? '' : 'mm';
        g2.appendChild(ui.exprInput(pm.value ?? 0, vu, (v) => { const x = Number(v); if (Number.isFinite(x) && x > 0 || (vu !== '' && Number.isFinite(x))) { pm.value = x; this.previewMate(); } }, { min: 0 }));
        if (pm.type === 'gear') g2.appendChild(el('div', { class: 'pm-hint' }, 'Pick the two gears\' cylinders (their pitch circles): the ratio starts as their radii\'s. Turn one gear and the other follows. Use Reverse for an internal gear (both turn the same way).'));
        if (pm.type === 'rack') g2.appendChild(el('div', { class: 'pm-hint' }, 'Pick the pinion\'s cylinder and a straight edge (or the flat face) of the rack along which it runs: the travel starts as the pinion\'s circumference (π × diameter).'));
      }
      if (info?.extra) {
        const n = (pm.extra || []).length;
        g2.appendChild(el('div', { class: 'pm-hint', 'data-mate-extra': String(n) }, pm.type === 'width'
          ? (n === 0 ? 'Width: now click the first component’s other face (parallel to its first): the second component is centred between them.' : n === 1 ? 'Now click the second component’s other face.' : 'The second component’s two faces are centred between the first’s.')
          : (n === 0 ? 'Symmetric: now click the plane (or flat face) between them: the second entity is kept where the first one’s mirror image is.' : 'Mirrored about the plane.')));
      }
      if (['distance', 'angle'].includes(pm.type)) {
        const lb = el('label'), cb = el('input', { type: 'checkbox', 'data-mate-limit': '' }); cb.checked = !!pm.limit;
        cb.onchange = () => { pm.limit = cb.checked; if (pm.limit) { pm.min ??= 0; pm.max ??= pm.value ?? 0; } this.previewMate(); this.renderPM(); };
        lb.append(cb, document.createTextNode(' Limit (free between a minimum and a maximum)'));
        g2.appendChild(lb);
        if (pm.limit) for (const k of ['min', 'max']) {
          g2.appendChild(el('label', { class: 'pm-label' }, k === 'min' ? 'Minimum' : 'Maximum'));
          const input = ui.exprInput(pm[k] ?? '', pm.type === 'angle' ? '°' : 'mm', (v) => { pm[k] = v === '' ? '' : Number(v); this.previewMate(); });
          input.dataset.mateLimit = k; g2.appendChild(input);
        }
      }
      const mech = pm.type === 'gear' || pm.type === 'rack' || pm.type === 'screw';
      const flippable = mech || ['coincident', 'parallel', 'distance', 'tangent'].includes(pm.type) && (pm.type === 'distance' || pm.type === 'tangent' || (A.n || A.d) && (B.n || B.d));
      if (flippable) {
        const fb = el('button', { class: 'pm-btn' }, mech ? ((pm.side || 1) > 0 ? 'Reverse the direction' : 'Reversed — click for the usual direction') : pm.type === 'distance' || pm.type === 'tangent' ? 'Flip Side' : pm.align > 0 ? 'Aligned — click for Anti-Aligned' : 'Anti-Aligned — click for Aligned');
        fb.onclick = () => { if (mech || pm.type === 'distance' || pm.type === 'tangent') pm.side = -(pm.side || 1); else pm.align = -(pm.align || -1); pm.flipped = true; this.previewMate(); };
        g2.appendChild(fb);
      }
      g2.appendChild(el('div', { class: 'pm-hint' }, 'The mate is shown applied. ✔ keeps it and starts the next one; Esc closes.'));
    }
  }
  cancelPreview() {
    if (this.pmBefore) Object.assign(this.doc.components, JSON.parse(this.pmBefore).map((x, i) => Object.assign(this.doc.components[i], x)));
    this.updateGeometry();
  }
}

// ------------------------------------------------------------------ refs from a part's mesh
function meshBox(m) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.vertices.length; i += 3) for (let k = 0; k < 3; k++) { const v = m.vertices[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  return { min, max };
}
// a count, short (1.2M, 340k)
function fmtCount(n) { return n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n); }
// a component's pose the same as a stored one
function samePose(c, o) { return !!o && c.pos.every((x, k) => Math.abs(x - o.pos[k]) < 1e-9) && c.rot.every((x, k) => Math.abs(x - o.rot[k]) < 1e-12); }
// a part shown, by its component's name (inside a sub-assembly: "Sub-assembly ▸ Component")
function leafName(l) { return [l.comp.name, ...l.names].join(' ▸ '); }
// a face (by its number in the part's mesh) as a mate ref
function refOfFace(m, gi) {
  const s = m.faceGroups[gi]?.surf;
  if (!s) return null;
  if (s.t === 'PLANE') return { kind: 'plane', p: s.p.map(r6), n: s.n.map(r6), what: 'Face' };
  if (s.t === 'CYLINDER' || s.t === 'CONE' || s.t === 'TORUS') return { kind: 'axis', p: s.p.map(r6), d: s.d.map(r6), r: r6(s.r), what: s.t === 'CYLINDER' ? 'Cylindrical face' : s.t === 'CONE' ? 'Conical face' : 'Toroidal face' }; // (Kernel Lab k8: tori)
  if (s.t === 'SPHERE') return { kind: 'point', p: s.p.map(r6), r: r6(s.r), what: 'Spherical face' };
  return null;
}
// an edge as a mate ref: a circle → its axis; a straight edge → its line
function refOfEdge(m, ei) {
  const e = m.edges[ei];
  if (!e) return null;
  // (the edge's points, at most 256, for a path mate)
  const pts = []; const n = Math.floor(e.pts.length / 3), step = Math.max(1, Math.ceil(n / 256));
  for (let i = 0; i < n; i += step) pts.push(e.pts.slice(3 * i, 3 * i + 3).map(r6));
  if (n && (n - 1) % step) pts.push(e.pts.slice(3 * (n - 1), 3 * n).map(r6));
  if (e.circ) return { kind: 'axis', p: e.circ.c.map(r6), d: e.circ.n.map(r6), r: r6(e.circ.r), circle: true, what: 'Circular edge', pts };
  if (e.type === 'LINE' && e.pts.length >= 6) {
    const a = e.pts.slice(0, 3), b = e.pts.slice(-3);
    return { kind: 'axis', p: a.map(r6), d: unit(sub(b, a)).map(r6), len: r6(len(sub(b, a))), what: 'Edge' };
  }
  return { kind: 'point', p: e.mid.map(r6), what: 'Edge middle', pts };
}
