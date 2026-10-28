// 3D printing (the 3D Print tab): printer and material profiles, the part's build orientation, its mesh turned onto the
// printer's bed, and the printability checks run on that mesh. The print frame has the bed at z = 0 and z up; the
// part's orientation is a rotation from the model's axes into it (doc.print.R, nine numbers row by row).

// ------------------------------------------------------------ profiles
// A profile is a printer and a material: every size the print features and the checks use is read from it.
const FITS = { press: 0.05, snug: 0.15, sliding: 0.3, loose: 0.5 };
const FDM = { kind: 'fdm', nozzle: 0.4, width: 0.4, layer: 0.2, bed: [220, 220, 250], overhang: 45, bridge: 10, clearance: 0.2, fits: FITS, filament: 1.75, minHole: 1.5, minPin: 2, minGap: 0.4, minStroke: 0.5 };
export const BUILTIN_PROFILES = [
  { ...FDM, name: 'PLA, 0.4 mm nozzle', material: 'PLA', density: 1.24, shrinks: false },
  { ...FDM, name: 'PETG, 0.4 mm nozzle', material: 'PETG', density: 1.27, shrinks: false },
  { ...FDM, name: 'ABS, 0.4 mm nozzle', material: 'ABS', density: 1.04, shrinks: true },
  { kind: 'resin', name: 'Resin', material: 'Resin', nozzle: 0, width: 0.3, layer: 0.05, bed: [130, 80, 160], overhang: 30, bridge: null, clearance: 0.1, fits: { press: 0.02, snug: 0.08, sliding: 0.15, loose: 0.3 }, density: 1.1, filament: null, shrinks: false, minHole: 0.5, minPin: 0.5, minGap: 0.2, minStroke: 0.3 },
];
export const PROFILE_FIELDS = [
  ['nozzle', 'Nozzle diameter', 'mm'], ['width', 'Extrusion width', 'mm'], ['layer', 'Layer height', 'mm'],
  ['overhang', 'Overhang limit (from vertical)', '°'], ['bridge', 'Longest bridge', 'mm'], ['clearance', 'Hole clearance (each side)', 'mm'],
  ['density', 'Material density', 'g/cm³'], ['filament', 'Filament diameter', 'mm'],
  ['minHole', 'Smallest hole', 'mm'], ['minPin', 'Smallest pin', 'mm'], ['minGap', 'Smallest gap', 'mm'],
];
export function allProfiles(prefs) {
  const own = (prefs?.printProfiles || []).filter((p) => p?.name);
  return [...BUILTIN_PROFILES.filter((b) => !own.some((p) => p.name === b.name)).map((p) => ({ ...p, builtIn: true })), ...own];
}
// The part's profile: its own (doc.print.profile) if it is still in the settings, else the copy saved with the part,
// else the settings' default, else the first one
export function profileFor(doc, prefs) {
  const all = allProfiles(prefs), name = doc?.print?.profile || prefs?.printProfile;
  return (name && (all.find((p) => p.name === name) || (doc?.print?.p?.name === name ? doc.print.p : null))) || all[0];
}

// ------------------------------------------------------------ fastener sizes
// hex nuts (ISO 4032): across flats, height (mm)
export const NUTS = { M2: [4, 1.6], 'M2.5': [5, 2], M3: [5.5, 2.4], M4: [7, 3.2], M5: [8, 4.7], M6: [10, 5.2], M8: [13, 6.8], M10: [16, 8.4], M12: [18, 10.8] };
// threaded inserts pressed or melted in (heat-set): the hole's diameter and the insert's length (mm). Typical sizes from
// the makers' charts, which differ from one maker to the next: check them against your inserts (the Insert Hole
// panel takes your own numbers)
export const INSERTS = { M2: [3.2, 4], 'M2.5': [3.6, 5.7], M3: [4, 5.7], M4: [5.6, 8.1], M5: [6.4, 9.5], M6: [8, 12.7], M8: [9.7, 12.7] };
// screws cut straight into the print: the pilot hole as a share of the screw's size
export const PILOT_SHARE = 0.85;
export const SCREW_SIZES = ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6'];

// ------------------------------------------------------------ orientation
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
// the model's Y up as the printer's Z up: (x, y, z) → (x, −z, y)
export const Y_UP = [1, 0, 0, 0, 0, -1, 0, 1, 0];
export const turn = (R, p) => [R[0] * p[0] + R[1] * p[1] + R[2] * p[2], R[3] * p[0] + R[4] * p[1] + R[5] * p[2], R[6] * p[0] + R[7] * p[1] + R[8] * p[2]];
export const back = (R, p) => [R[0] * p[0] + R[3] * p[1] + R[6] * p[2], R[1] * p[0] + R[4] * p[1] + R[7] * p[2], R[2] * p[0] + R[5] * p[1] + R[8] * p[2]];
export const orientationOf = (doc) => (Array.isArray(doc?.print?.R) && doc.print.R.length === 9 ? doc.print.R : null);
// The rotation that lays a face of outward normal n (model axes) down on the bed: n turned onto −Z (the shortest turn)
export function faceDown(n) {
  const a = unit(n), b = [0, 0, -1], c = dot(a, b);
  if (c < -1 + 1e-12) return [1, 0, 0, 0, -1, 0, 0, 0, -1]; // (n is +Z: half a turn about X)
  const v = cross(a, b), k = 1 / (1 + c);
  const V = [0, -v[2], v[1], v[2], 0, -v[0], -v[1], v[0], 0];
  const V2 = [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => V[3 * i] * V[j] + V[3 * i + 1] * V[3 + j] + V[3 * i + 2] * V[6 + j]));
  return [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => (i === j ? 1 : 0) + V[3 * i + j] + V2[3 * i + j] * k));
}

// ------------------------------------------------------------ the mesh on the bed
// The shown mesh (result.body: vertices, triangles, faceGroups, bodies) turned into the print frame, for the bodies
// given (all solids when none): { P (x, y, z per point), T (index triples), tri (per triangle: its face group), groups,
// lo, hi (the box), tris: per triangle { n (unit normal), a (area), c (centroid) } }
export function printMesh(body, R, bodyIds = null) {
  const V = body.vertices, I = body.triangles, G = body.faceGroups || [];
  const keep = (body.bodies || []).filter((b) => (bodyIds ? bodyIds.includes(b.id) : b.kind !== 'surface' && !b.context));
  const groups = [];
  for (const b of keep) for (let g = b.faceStart; g < b.faceStart + b.faceCount; g++) groups.push({ ...G[g], body: b.id, gi: g });
  const P = [], at = new Map(), T = [], tri = [];
  const point = (i) => { let j = at.get(i); if (j === undefined) { j = P.length; at.set(i, j); P.push(turn(R, [V[3 * i], V[3 * i + 1], V[3 * i + 2]])); } return j; };
  groups.forEach((g, gk) => { for (let q = g.start; q < g.start + g.count; q += 3) { T.push([point(I[q]), point(I[q + 1]), point(I[q + 2])]); tri.push(gk); } });
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of P) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], p[c]); hi[c] = Math.max(hi[c], p[c]); }
  const tris = T.map(([a, b, c]) => {
    const x = cross([P[b][0] - P[a][0], P[b][1] - P[a][1], P[b][2] - P[a][2]], [P[c][0] - P[a][0], P[c][1] - P[a][1], P[c][2] - P[a][2]]), l = len(x);
    return { n: l > 0 ? [x[0] / l, x[1] / l, x[2] / l] : [0, 0, 0], a: l / 2, c: [0, 1, 2].map((k) => (P[a][k] + P[b][k] + P[c][k]) / 3) };
  });
  return { P, T, tri, groups, lo, hi, tris, R };
}
// The default orientation: the biggest flat face of the solids down on the bed
export function biggestFlatDown(body) {
  let best = null;
  const V = body.vertices, I = body.triangles;
  for (const b of (body.bodies || []).filter((x) => x.kind !== 'surface' && !x.context)) for (let g = b.faceStart; g < b.faceStart + b.faceCount; g++) {
    const fg = body.faceGroups[g];
    if (fg.surf?.t !== 'PLANE') continue;
    let A = 0;
    for (let q = fg.start; q < fg.start + fg.count; q += 3) {
      const p = [0, 1, 2].map((j) => [V[3 * I[q + j]], V[3 * I[q + j] + 1], V[3 * I[q + j] + 2]]);
      A += len(cross([p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]], [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]])) / 2;
    }
    // (only a face on the outside of the part: nothing of it beyond the plane on its outward side)
    const n = fg.surf.n, h = dot(fg.surf.p, n);
    let out = 0;
    for (let i = 0; i < V.length; i += 3) out = Math.max(out, V[i] * n[0] + V[i + 1] * n[1] + V[i + 2] * n[2] - h);
    if (out > 1e-6 * (1 + Math.abs(h))) continue;
    if (!best || A > best.A + 1e-9) best = { A, n };
  }
  return best ? faceDown(best.n) : Y_UP;
}

// ------------------------------------------------------------ checks
// 2D convex hull (monotone chain) and its least width (the narrowest way across: rotating calipers)
function hull(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]), cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length > 1 && cr(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length > 1 && cr(up.at(-2), up.at(-1), q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
const hullArea = (h) => Math.abs(h.reduce((s, p, i) => { const q = h[(i + 1) % h.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
function leastWidth(h) {
  if (h.length < 3) return 0;
  let w = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(L > 1e-12)) continue;
    let far = 0;
    for (const q of h) far = Math.max(far, Math.abs((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])) / L);
    w = Math.min(w, far);
  }
  return w;
}
// Material under the overhangs, as columns down from each overhanging triangle to the part below it or the bed:
// mm³. (A grid over the bed holds each upward triangle, so each column meets only the few under it.)
function supportVolume(m, over) {
  const cell = Math.max(1, Math.max(m.hi[0] - m.lo[0], m.hi[1] - m.lo[1]) / 64), key = (x, y) => `${Math.floor((x - m.lo[0]) / cell)},${Math.floor((y - m.lo[1]) / cell)}`;
  const grid = new Map();
  m.T.forEach((t, k) => {
    if (!(m.tris[k].n[2] > 1e-6)) return;
    const xs = t.map((i) => m.P[i][0]), ys = t.map((i) => m.P[i][1]);
    for (let x = Math.floor((Math.min(...xs) - m.lo[0]) / cell); x <= Math.floor((Math.max(...xs) - m.lo[0]) / cell); x++)
      for (let y = Math.floor((Math.min(...ys) - m.lo[1]) / cell); y <= Math.floor((Math.max(...ys) - m.lo[1]) / cell); y++) { const kk = `${x},${y}`; if (!grid.has(kk)) grid.set(kk, []); grid.get(kk).push(k); }
  });
  const under = (x, y, z) => {
    let best = m.lo[2];
    for (const k of grid.get(key(x, y)) || []) {
      const [a, b, c] = m.T[k].map((i) => m.P[i]), d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(d) < 1e-15) continue;
      const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d, l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d, l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      const zz = l1 * a[2] + l2 * b[2] + l3 * c[2];
      if (zz < z - 1e-6 && zz > best) best = zz;
    }
    return best;
  };
  let vol = 0;
  for (const k of over) { const t = m.tris[k]; vol += t.a * Math.abs(t.n[2]) * Math.max(0, t.c[2] - under(t.c[0], t.c[1], t.c[2])); }
  return vol;
}
// Every check on the mesh in its build orientation: { findings: [{ check, level: 'fail' | 'warn' | 'pass' | 'info',
// text, p (model axes) }], stats }. extra: { thickness: { min } (from the thickness map), cavities: [{ volume, p }],
// volume (mm³) }
export function checkPrintability(m, prof, extra = {}) {
  const out = [], f1 = (x) => +x.toFixed(1), f2 = (x) => +x.toFixed(2), at = (p) => back(m.R, p);
  const zBed = m.lo[2], tolZ = 1e-3 * (1 + (m.hi[2] - m.lo[2]));
  const onBed = (k) => m.T[k].every((i) => m.P[i][2] < zBed + tolZ);
  const lim = prof.overhang, flat = Math.cos((1 * Math.PI) / 180);
  // overhangs (faces facing down steeper than the limit from vertical, not on the bed; ceilings are bridges, below),
  // a finding per face
  const overTris = [], perFace = new Map();
  m.tris.forEach((t, k) => {
    if (!(t.n[2] < 0) || onBed(k) || t.a < 1e-12) return;
    const ang = (Math.asin(Math.min(1, -t.n[2])) * 180) / Math.PI;
    if (ang <= lim - 10 + 1e-9) return;
    if (-t.n[2] > flat) { if (ang > lim + 1e-9) overTris.push(k); return; }
    const g = m.tri[k], e = perFace.get(g) || { ang: 0, area: 0, p: t.c, warn: 0 };
    if (ang > lim + 1e-9) { e.area += t.a; overTris.push(k); } else e.warn += t.a;
    if (ang > e.ang) { e.ang = ang; e.p = t.c; }
    perFace.set(g, e);
  });
  for (const e of perFace.values()) {
    if (e.area > 0) out.push({ check: 'overhang', level: 'fail', text: `Overhang ${f1(e.ang)}°: over the ${lim}° limit, needs support (${f1(e.area)} mm²)`, p: at(e.p) });
    else out.push({ check: 'overhang', level: 'warn', text: `Overhang ${f1(e.ang)}°: close to the ${lim}° limit`, p: at(e.p) });
  }
  // bridges: flat faces facing down, off the bed, crossed the narrow way
  const byGroup = m.groups.map(() => []);
  m.tri.forEach((g, k) => byGroup[g].push(k));
  m.groups.forEach((g, gk) => {
    const ks = byGroup[gk];
    if (!ks.length || !ks.every((k) => -m.tris[k].n[2] > flat) || ks.some(onBed)) return;
    const h = hull(ks.flatMap((k) => m.T[k].map((i) => [m.P[i][0], m.P[i][1]]))), w = leastWidth(h), c = m.tris[ks[0]].c;
    if (prof.bridge == null) return;
    if (w > prof.bridge + 1e-9) out.push({ check: 'bridge', level: 'fail', text: `Bridge ${f1(w)} mm: longer than ${prof.bridge} mm, needs support`, p: at(c) });
    else if (w > 0.8 * prof.bridge) out.push({ check: 'bridge', level: 'warn', text: `Bridge ${f1(w)} mm: close to the ${prof.bridge} mm limit`, p: at(c) });
  });
  // walls (from the thickness map)
  const w2 = 2 * prof.width, w3 = 3 * prof.width, tmin = extra.thickness?.min;
  if (Number.isFinite(tmin)) {
    if (tmin < w2 - 1e-9) out.push({ check: 'wall', level: 'fail', text: `Wall ${f2(tmin)} mm thick: under 2 extrusion widths (${f2(w2)} mm)`, p: extra.thickness.p || null });
    else if (tmin < w3 - 1e-9) out.push({ check: 'wall', level: 'warn', text: `Wall ${f2(tmin)} mm thick: under 3 extrusion widths (${f2(w3)} mm)`, p: extra.thickness.p || null });
  }
  // small holes and pins (round faces standing up within 20° of vertical; a hole's surface faces its axis)
  for (let gi = 0; gi < m.groups.length; gi++) {
    const g = m.groups[gi], s = g.surf;
    if (s?.t !== 'CYLINDER') continue;
    const d = unit(turn(m.R, s.d));
    if (Math.abs(d[2]) < Math.cos((20 * Math.PI) / 180)) continue;
    const k = byGroup[gi][0];
    if (k == null) continue;
    const ax = turn(m.R, s.p), t = m.tris[k], rel = [t.c[0] - ax[0], t.c[1] - ax[1], t.c[2] - ax[2]], radial = [rel[0] - d[0] * dot(rel, d), rel[1] - d[1] * dot(rel, d), rel[2] - d[2] * dot(rel, d)];
    const hole = dot(t.n, radial) < 0, D = 2 * s.r, lim2 = hole ? prof.minHole : prof.minPin;
    if (D < lim2 - 1e-9) out.push({ check: hole ? 'hole' : 'pin', level: 'fail', text: `${hole ? 'Hole' : 'Pin'} Ø${f2(D)} mm: under Ø${lim2} mm, ${hole ? 'it closes up' : 'too thin to print'}`, p: at(t.c) });
  }
  // closed hollows (from the kernel: inner shells)
  for (const c of extra.cavities || []) out.push({ check: 'cavity', level: prof.kind === 'resin' ? 'fail' : 'warn', text: `A closed hollow of ${f1(c.volume)} mm³ inside: ${prof.kind === 'resin' ? 'resin is trapped in it' : 'it fills with support, or prints as a sealed void'}`, p: c.p });
  // bed contact and fit
  let contact = 0;
  m.tris.forEach((t, k) => { if (t.n[2] < -flat && onBed(k)) contact += t.a; });
  const foot = hullArea(hull(m.P.map((p) => [p[0], p[1]]))), size = [m.hi[0] - m.lo[0], m.hi[1] - m.lo[1], m.hi[2] - m.lo[2]];
  const lowest = at(m.P.reduce((b, p) => (p[2] < b[2] ? p : b), m.P[0]));
  if (contact < 1 || contact < 0.05 * foot) out.push({ check: 'contact', level: 'fail', text: `Only ${f1(contact)} mm² on the bed (${f1((100 * contact) / (foot || 1))} % of its footprint): it may not stay put`, p: lowest });
  const bed = prof.bed, fits = size[0] <= bed[0] + 1e-9 && size[1] <= bed[1] + 1e-9, turned = size[1] <= bed[0] + 1e-9 && size[0] <= bed[1] + 1e-9;
  if (!(fits || turned) || size[2] > bed[2] + 1e-9) out.push({ check: 'bed', level: 'fail', text: `${f1(size[0])} × ${f1(size[1])} × ${f1(size[2])} mm: bigger than the ${bed[0]} × ${bed[1]} × ${bed[2]} mm printer (Split for Printing)`, p: null });
  // warping
  if (prof.shrinks && Math.max(size[0], size[1]) > 150) out.push({ check: 'warp', level: 'warn', text: `A ${f1(Math.max(size[0], size[1]))} mm long base in ${prof.material}: it may warp (a brim or an enclosure helps)`, p: null });
  // support, mass, filament
  const support = supportVolume(m, overTris) / 1000, volume = (extra.volume ?? 0) / 1000;
  const mass = volume * prof.density, filament = prof.filament ? (volume / (Math.PI * (prof.filament / 20) ** 2)) / 100 : null;
  const stats = { size, contact, footprint: foot, support, volume, mass, filament, overhangArea: overTris.reduce((s, k) => s + m.tris[k].a, 0) };
  if (support > 0) out.push({ check: 'support', level: 'info', text: `Support: about ${f2(support)} cm³ (${f1((100 * support) / (volume || 1))} % of the part)`, p: null });
  const order = { fail: 0, warn: 1, info: 2, pass: 3 };
  out.sort((a, b) => order[a.level] - order[b.level]);
  if (!out.some((x) => x.level === 'fail' || x.level === 'warn')) out.unshift({ check: 'all', level: 'pass', text: 'Printable as it stands: nothing over the profile’s limits', p: null });
  return { findings: out, stats };
}
