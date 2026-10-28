// Collision detection between the components of an assembly, from their display meshes: quick enough to run
// while a component is dragged and at every step of a motion study.
//
// Each part's mesh gets a bounding-volume tree of its triangles (built once, kept with the mesh). Two placed meshes
// collide when a triangle of one passes through a triangle of the other by more than a small tolerance, so faces
// that only touch (mated faces) do not count; nor do round faces on the same axis with the same radius (a shaft in
// its hole), whose facets cross a little where the two are divided differently; nor does a screw in a threaded
// bore (threads are cosmetic: the screw is its major diameter, the bore about its minor one), where a round face of
// one part is a standard thread's major diameter and a round face of the other on the same axis lies between that
// thread's minor and major diameters.
//
//   meshesCollide(A, MA, B, MB, opts)  A, B: meshes; MA, MB: THREE.Matrix4 placements → { p } (a point, in A's
//                                      coordinates) or null
//   findCollisions(items, opts)        items: [{ mesh, matrix, owner }]; pairs of the same owner are skipped;
//                                      opts.moving: a Set of owners, only pairs with one of them; opts.skip: a Set
//                                      of "i|j" pairs to leave out → [[i, j]…] (i < j)

import * as THREE from 'three';
import { threadList, minorDiameter } from './threads.js';

// the standard threads' major diameters and the least minor diameter of each
const THREADS = (() => {
  const m = new Map();
  for (const t of [...threadList('metric'), ...threadList('imperial')]) { const d1 = minorDiameter(t.D, t.P); m.set(t.D, Math.min(m.get(t.D) ?? Infinity, d1)); }
  return [...m].map(([D, D1]) => ({ D, D1 }));
})();
// a threaded fit: the outer diameter a standard thread's, the inner between its minor and major diameters
export function threadFit(dOuter, dInner) {
  if (!(dInner < dOuter)) return false;
  return THREADS.some((t) => Math.abs(t.D - dOuter) < 0.02 && dInner > t.D1 - 0.05);
}

const LEAF = 8;
const trees = new WeakMap();

// the tree of a mesh's triangles: nodes as flat arrays (boxes, children, leaves' triangle runs)
function treeOf(mesh) {
  let t = trees.get(mesh);
  if (t) return t;
  const V = mesh.vertices, T = mesh.triangles, n = Math.floor(T.length / 3);
  const cen = new Float64Array(n * 3), order = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    order[i] = i;
    for (let k = 0; k < 3; k++) cen[i * 3 + k] = (V[T[i * 3] * 3 + k] + V[T[i * 3 + 1] * 3 + k] + V[T[i * 3 + 2] * 3 + k]) / 3;
  }
  // (the face each triangle belongs to, for its surface)
  const face = new Int32Array(n).fill(-1);
  const groups = mesh.faceGroups || [];
  const total = groups.reduce((s, g) => s + g.count, 0), gs = total === T.length ? 1 : 3;
  groups.forEach((g, gi) => { for (let k = g.start * gs; k < (g.start + g.count) * gs; k += 3) face[k / 3] = gi; });
  // (how far a round face's facets lie from the true surface: crossings that shallow are the facets', not the parts')
  const dev = new Float64Array(groups.length);
  groups.forEach((g, gi) => {
    const sf = g.surf;
    if (!sf || !(sf.t === 'CYLINDER' || sf.t === 'SPHERE' || sf.t === 'CONE')) return;
    if (sf.t === 'CONE') { dev[gi] = 0.006 * (sf.r || 1); return; }
    const d = sf.d && unit3(sf.d);
    let m = 0;
    for (let k = g.start * gs; k < (g.start + g.count) * gs; k += 3) {
      const c = [cen[k], cen[k + 1], cen[k + 2]], w = sub3(c, sf.p);
      const r = d ? Math.hypot(...cross3(w, d)) : Math.hypot(...w);
      m = Math.max(m, Math.abs(sf.r - r));
    }
    dev[gi] = m * 1.5;
  });
  const lo = [], hi = [], left = [], right = [], start = [], count = [];
  const build = (s, e) => {
    const id = lo.length / 3;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = s; i < e; i++) {
      const tri = order[i];
      for (let j = 0; j < 3; j++) { const v = T[tri * 3 + j] * 3; for (let k = 0; k < 3; k++) { const x = V[v + k]; if (x < mn[k]) mn[k] = x; if (x > mx[k]) mx[k] = x; } }
    }
    lo.push(...mn); hi.push(...mx); left.push(-1); right.push(-1); start.push(s); count.push(e - s);
    if (e - s <= LEAF) return id;
    // (split across the longest side, at the middle of the triangles' centres)
    const ax = [0, 1, 2].reduce((b, k) => (mx[k] - mn[k] > mx[b] - mn[b] ? k : b), 0);
    order.subarray(s, e).sort((a, b) => cen[a * 3 + ax] - cen[b * 3 + ax]);
    const m = (s + e) >> 1;
    left[id] = build(s, m);
    right[id] = build(m, e);
    return id;
  };
  if (n) build(0, n);
  t = { lo: Float64Array.from(lo), hi: Float64Array.from(hi), left: Int32Array.from(left), right: Int32Array.from(right), start: Int32Array.from(start), count: Int32Array.from(count), order, face, dev,
    stamp: new Uint32Array(V.length / 3), tv: new Float64Array(V.length), gen: 0, diag: n ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) : 0 };
  trees.set(mesh, t);
  return t;
}

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit3 = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// the segment where triangle (p0, p1, p2) crosses a plane, by the corners' signed distances d: its two ends
function crossing(P, d) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3, a = d[i], b = d[j];
    if ((a < 0) !== (b < 0)) { const t = a / (a - b); out.push([P[i][0] + (P[j][0] - P[i][0]) * t, P[i][1] + (P[j][1] - P[i][1]) * t, P[i][2] + (P[j][2] - P[i][2]) * t]); }
  }
  return out.length === 2 ? out : null;
}
// Do two triangles pass through each other (by more than eps on both sides of each one's plane)? { p: a point
// where they do, depth: how far (the least of how far each passes the other's plane, either way) } or null.
export function trianglesCross(P, Q, eps) {
  const nq = cross3(sub3(Q[1], Q[0]), sub3(Q[2], Q[0])), lq = Math.hypot(...nq);
  const np = cross3(sub3(P[1], P[0]), sub3(P[2], P[0])), lp = Math.hypot(...np);
  if (lq < 1e-14 || lp < 1e-14) return null;
  const dp = P.map((p) => dot3(nq, sub3(p, Q[0])) / lq);
  if (Math.max(...dp) <= eps || Math.min(...dp) >= -eps) return null;
  const dq = Q.map((q) => dot3(np, sub3(q, P[0])) / lp);
  if (Math.max(...dq) <= eps || Math.min(...dq) >= -eps) return null;
  const L = cross3(np, nq);
  if (Math.hypot(...L) < 1e-12 * lp * lq) return null;
  const sp = crossing(P, dp), sq = crossing(Q, dq);
  if (!sp || !sq) return null;
  const a0 = dot3(L, sp[0]), a1 = dot3(L, sp[1]), b0 = dot3(L, sq[0]), b1 = dot3(L, sq[1]);
  const lo = Math.max(Math.min(a0, a1), Math.min(b0, b1)), hi = Math.min(Math.max(a0, a1), Math.max(b0, b1));
  if (hi <= lo) return null;
  // (the middle of the overlap)
  const m = (lo + hi) / 2, s = (Math.abs(a1 - a0) > 1e-15 ? (m - a0) / (a1 - a0) : 0);
  const depth = Math.min(Math.max(...dp), -Math.min(...dp), Math.max(...dq), -Math.min(...dq));
  return { p: sp[0].map((x, k) => x + (sp[1][k] - x) * s), depth };
}

// round faces on one axis with one radius (in A's coordinates): a fit, not a collision
function sameRound(sa, sb, T, tol) {
  if (!sa || !sb || sa.t !== sb.t || !(sa.t === 'CYLINDER' || sa.t === 'CONE' || sa.t === 'SPHERE')) return false;
  if (Math.abs(sa.r - sb.r) > tol) return false;
  const p = new THREE.Vector3(...sb.p).applyMatrix4(T);
  if (sa.t === 'SPHERE') return p.distanceTo(new THREE.Vector3(...sa.p)) < tol;
  const d = new THREE.Vector3(...sb.d).transformDirection(T), da = new THREE.Vector3(...sa.d).normalize();
  if (d.clone().cross(da).length() > 1e-4) return false;
  return p.sub(new THREE.Vector3(...sa.p)).cross(da).length() < tol;
}

export function meshesCollide(A, MA, B, MB, opts = {}) {
  if (!A?.triangles?.length || !B?.triangles?.length) return null;
  const ta = treeOf(A), tb = treeOf(B);
  const eps = opts.eps ?? 1e-3 + 1e-5 * Math.max(ta.diag, tb.diag);
  const T = new THREE.Matrix4().copy(MA).invert().multiply(MB), e = T.elements;
  // B's corners in A's coordinates, worked out when needed
  const gen = ++tb.gen, VB = B.vertices, VA = A.vertices;
  const vb = (i) => {
    const o = i * 3;
    if (tb.stamp[i] !== gen) {
      const x = VB[o], y = VB[o + 1], z = VB[o + 2];
      tb.tv[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
      tb.tv[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      tb.tv[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      tb.stamp[i] = gen;
    }
    return [tb.tv[o], tb.tv[o + 1], tb.tv[o + 2]];
  };
  const va = (i) => [VA[i * 3], VA[i * 3 + 1], VA[i * 3 + 2]];
  // a node of B's tree as a box in A's coordinates
  const boxB = (n) => {
    const c = [0, 1, 2].map((k) => (tb.lo[n * 3 + k] + tb.hi[n * 3 + k]) / 2), h = [0, 1, 2].map((k) => (tb.hi[n * 3 + k] - tb.lo[n * 3 + k]) / 2);
    const out = [];
    for (let r = 0; r < 3; r++) {
      const cc = e[r] * c[0] + e[4 + r] * c[1] + e[8 + r] * c[2] + e[12 + r];
      const hh = Math.abs(e[r]) * h[0] + Math.abs(e[4 + r]) * h[1] + Math.abs(e[8 + r]) * h[2];
      out.push(cc - hh, cc + hh);
    }
    return out;
  };
  const meet = (a, bb) => {
    for (let k = 0; k < 3; k++) if (ta.lo[a * 3 + k] > bb[k * 2 + 1] + eps || ta.hi[a * 3 + k] < bb[k * 2] - eps) return false;
    return true;
  };
  const surfA = A.faceGroups || [], surfB = B.faceGroups || [];
  const roundTol = (r) => Math.max(1e-4, 1e-4 * r);
  const fit = new Map();
  const skipFaces = (fa, fb) => {
    if (fa < 0 || fb < 0) return false;
    const k = fa * 100003 + fb;
    if (!fit.has(k)) { const sa = surfA[fa]?.surf, sb = surfB[fb]?.surf; fit.set(k, sameRound(sa, sb, T, roundTol(sa?.r || 0))); }
    return fit.get(k);
  };
  // (threaded fits between the two: zones round an axis, between two radii, where crossings are the threads')
  const zones = [];
  const rounds = (groups, M) => {
    const out = [];
    for (const g of groups) {
      const sf = g.surf;
      if (sf?.t !== 'CYLINDER') continue;
      const p = M ? new THREE.Vector3(...sf.p).applyMatrix4(M) : new THREE.Vector3(...sf.p), d = M ? new THREE.Vector3(...sf.d).transformDirection(M) : new THREE.Vector3(...sf.d).normalize();
      if (!out.some((o) => Math.abs(o.r - sf.r) < 1e-6 && o.d.clone().cross(d).length() < 1e-6 && o.p.clone().sub(p).cross(d).length() < 1e-6)) out.push({ p, d, r: sf.r });
    }
    return out;
  };
  const ra = rounds(surfA, null), rb = rounds(surfB, T);
  for (const x of ra) for (const y of rb) {
    if (x.d.clone().cross(y.d).length() > 1e-4 || y.p.clone().sub(x.p).cross(x.d).length() > 1e-3) continue;
    const [lo, hi] = x.r < y.r ? [x.r, y.r] : [y.r, x.r];
    if (threadFit(2 * hi, 2 * lo)) zones.push({ p: x.p, d: x.d, lo, hi });
  }
  const inZone = (q) => zones.some((z) => { const w = new THREE.Vector3(...q).sub(z.p), r = w.clone().cross(z.d).length(); return r > z.lo - 0.05 && r < z.hi + 0.05; });
  const stack = [0, 0];
  let tests = 0;
  const limit = opts.limit ?? 4e6;
  while (stack.length) {
    const nb = stack.pop(), na = stack.pop();
    const bb = boxB(nb);
    if (!meet(na, bb)) continue;
    const la = ta.left[na] < 0, lb = tb.left[nb] < 0;
    if (la && lb) {
      for (let i = ta.start[na]; i < ta.start[na] + ta.count[na]; i++) {
        const tA = ta.order[i], P = [va(A.triangles[tA * 3]), va(A.triangles[tA * 3 + 1]), va(A.triangles[tA * 3 + 2])];
        for (let j = tb.start[nb]; j < tb.start[nb] + tb.count[nb]; j++) {
          const tB = tb.order[j];
          if (++tests > limit) return null;
          const Q = [vb(B.triangles[tB * 3]), vb(B.triangles[tB * 3 + 1]), vb(B.triangles[tB * 3 + 2])];
          let out = false;
          for (let k = 0; k < 3 && !out; k++) {
            const qa = Math.min(Q[0][k], Q[1][k], Q[2][k]), qb = Math.max(Q[0][k], Q[1][k], Q[2][k]);
            const pa = Math.min(P[0][k], P[1][k], P[2][k]), pb = Math.max(P[0][k], P[1][k], P[2][k]);
            out = qa > pb + eps || qb < pa - eps;
          }
          if (out) continue;
          const x = trianglesCross(P, Q, eps);
          if (!x) continue;
          const fa = ta.face[tA], fb = tb.face[tB];
          if (x.depth > eps + (fa >= 0 ? ta.dev[fa] : 0) + (fb >= 0 ? tb.dev[fb] : 0) && !skipFaces(fa, fb) && !(zones.length && inZone(x.p))) return { p: x.p, depth: x.depth };
        }
      }
      continue;
    }
    // (the bigger node opened)
    const sizeA = ta.hi[na * 3] - ta.lo[na * 3] + ta.hi[na * 3 + 1] - ta.lo[na * 3 + 1] + ta.hi[na * 3 + 2] - ta.lo[na * 3 + 2];
    const sizeB = bb[1] - bb[0] + bb[3] - bb[2] + bb[5] - bb[4];
    if (lb || (!la && sizeA >= sizeB)) stack.push(ta.left[na], nb, ta.right[na], nb);
    else stack.push(na, tb.left[nb], na, tb.right[nb]);
  }
  return null;
}

// a placed mesh's box in the world
function worldBox(mesh, M) {
  const t = treeOf(mesh);
  if (!t.lo.length) return null;
  const box = new THREE.Box3(new THREE.Vector3(t.lo[0], t.lo[1], t.lo[2]), new THREE.Vector3(t.hi[0], t.hi[1], t.hi[2]));
  return box.applyMatrix4(M);
}

export function findCollisions(items, opts = {}) {
  const boxes = items.map((it) => (it?.mesh ? worldBox(it.mesh, it.matrix) : null));
  const out = [];
  for (let i = 0; i < items.length; i++) {
    if (!boxes[i]) continue;
    for (let j = i + 1; j < items.length; j++) {
      if (!boxes[j] || items[i].owner === items[j].owner) continue;
      if (opts.moving && !opts.moving.has(items[i].owner) && !opts.moving.has(items[j].owner)) continue;
      if (opts.skip?.has(i + '|' + j)) continue;
      if (!boxes[i].intersectsBox(boxes[j])) continue;
      const hit = meshesCollide(items[i].mesh, items[i].matrix, items[j].mesh, items[j].matrix, opts);
      if (hit) { out.push([i, j]); if (opts.first) return out; }
    }
  }
  return out;
}

// The closest point of a triangle (a, b, c) to p (Ericson's regions).
function closestOnTri(p, a, b, c) {
  const ab = sub3(b, a), ac = sub3(c, a), ap = sub3(p, a), d1 = dot3(ab, ap), d2 = dot3(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub3(p, b), d3 = dot3(ab, bp), d4 = dot3(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]; }
  const cp = sub3(p, c), d5 = dot3(ab, cp), d6 = dot3(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]; }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}
// (each point of A against B's triangles: the nearest, by B's tree, branches further than the best so far left out)
function nearestOneWay(A, MA, B, MB, best) {
  const t = treeOf(B), V = B.vertices, T = B.triangles, P = A.vertices;
  const toB = new THREE.Matrix4().copy(MB).invert().multiply(MA), v = new THREE.Vector3();
  const stack = new Int32Array(256);
  for (let i = 0; i < P.length; i += 3) {
    v.set(P[i], P[i + 1], P[i + 2]).applyMatrix4(toB);
    const p = [v.x, v.y, v.z];
    let sp = 0;
    stack[sp++] = 0;
    while (sp) {
      const nd = stack[--sp], b3 = nd * 3;
      let dd = 0;
      for (let k = 0; k < 3; k++) { const x = p[k], lo = t.lo[b3 + k], hi = t.hi[b3 + k], e = x < lo ? lo - x : x > hi ? x - hi : 0; dd += e * e; }
      if (dd >= best.d * best.d) continue;
      if (t.left[nd] < 0) {
        for (let s = t.start[nd]; s < t.start[nd] + t.count[nd]; s++) {
          const tri = t.order[s], q = [0, 1, 2].map((j) => { const w = T[tri * 3 + j] * 3; return [V[w], V[w + 1], V[w + 2]]; });
          const c = closestOnTri(p, q[0], q[1], q[2]), d = Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]);
          if (d < best.d) { best.d = d; best.pb = new THREE.Vector3(...c).applyMatrix4(MB).toArray(); best.pa = new THREE.Vector3(...p).applyMatrix4(MB).toArray(); }
        }
      } else if (sp < 254) { stack[sp++] = t.left[nd]; stack[sp++] = t.right[nd]; }
    }
  }
}
// The clearance between two placed meshes: the least distance between them (from each one's points to the other's
// triangles, so as fine as the meshes), up to max (beyond it: { d: max }). { d, pa, pb } (world points).
export function meshesDistance(A, MA, B, MB, max = Infinity) {
  const best = { d: max, pa: null, pb: null };
  if (!A?.triangles?.length || !B?.triangles?.length) return best;
  nearestOneWay(A, MA, B, MB, best);
  const r = { d: best.d }; nearestOneWay(B, MB, A, MA, r);
  if (r.d < best.d) return { d: r.d, pa: r.pb, pb: r.pa };
  return best;
}

// Where a ray (o, d in the world) passes through a placed mesh's triangles: the distances along it, in order.
export function rayHits(mesh, M, o, d) {
  if (!mesh?.triangles?.length) return [];
  const t = treeOf(mesh), V = mesh.vertices, T = mesh.triangles;
  const inv = new THREE.Matrix4().copy(M).invert();
  const lo3 = new THREE.Vector3(...o).applyMatrix4(inv), ld = new THREE.Vector3(...d).transformDirection(inv);
  const O = lo3.toArray(), D = ld.toArray(), out = [];
  const slab = (n) => {
    let t0 = -Infinity, t1 = Infinity;
    for (let k = 0; k < 3; k++) {
      const a = t.lo[n * 3 + k] - 1e-6, b = t.hi[n * 3 + k] + 1e-6;
      if (Math.abs(D[k]) < 1e-15) { if (O[k] < a || O[k] > b) return false; continue; }
      let u = (a - O[k]) / D[k], v = (b - O[k]) / D[k];
      if (u > v) [u, v] = [v, u];
      t0 = Math.max(t0, u); t1 = Math.min(t1, v);
      if (t0 > t1) return false;
    }
    return t1 >= -1e-6;
  };
  const stack = [0];
  while (stack.length) {
    const n = stack.pop();
    if (!slab(n)) continue;
    if (t.left[n] >= 0) { stack.push(t.left[n], t.right[n]); continue; }
    for (let i = t.start[n]; i < t.start[n] + t.count[n]; i++) {
      const tri = t.order[i], a = T[tri * 3] * 3, b = T[tri * 3 + 1] * 3, c = T[tri * 3 + 2] * 3;
      const A = [V[a], V[a + 1], V[a + 2]], e1 = [V[b] - A[0], V[b + 1] - A[1], V[b + 2] - A[2]], e2 = [V[c] - A[0], V[c + 1] - A[1], V[c + 2] - A[2]];
      const p = cross3(D, e2), det = dot3(e1, p);
      if (Math.abs(det) < 1e-14) continue;
      const s = sub3(O, A), u = dot3(s, p) / det;
      if (u < -1e-9 || u > 1 + 1e-9) continue;
      const q = cross3(s, e1), v = dot3(D, q) / det;
      if (v < -1e-9 || u + v > 1 + 1e-9) continue;
      out.push(dot3(e2, q) / det);
    }
  }
  return out.sort((x, y) => x - y);
}
