// Duct fittings and their flat patterns (developments) for cutting from sheet: segmented (lobster back) elbows, cones
// (concentric reducers), round-to-rectangle transitions, offsets (two parallel round ends side by side) and laterals
// (a branch joining a main duct at an angle). Sizes are outside sizes; the patterns are developed on the sheet's middle
// (outside less the thickness), with a seam allowance along the long seam.
// A fitting: { kind: 'elbow' | 'cone' | 'transition' | 'offset' | 'lateral', D, t, seam, … } (see ductSpec)

const TAU = 2 * Math.PI;
// A fitting's values with their defaults, checked.
export function ductSpec(f, ev = (x) => +x) {
  const n = (k, d) => (f[k] === undefined || f[k] === '' ? d : ev(f[k]));
  const s = { kind: f.kind || 'elbow', D: n('D', 300), t: n('t', 1), seam: n('seam', 10), angle: n('angle', 90), R: n('R', 450), gores: Math.round(n('gores', 5)), D2: n('D2', 200), L: n('L', 300), W: n('W', 400), H: n('H', 300), offset: n('offset', 150), branchD: n('branchD', 200), branchAngle: n('branchAngle', 45), branchL: n('branchL', 300) };
  if (!(s.D > 0 && s.t > 0 && s.t < s.D / 4)) throw new Error('The duct needs a diameter and a sheet thickness well under it');
  if (s.kind === 'elbow') {
    if (!(s.angle > 0 && s.angle <= 180)) throw new Error('The elbow’s angle must be more than 0° and up to 180°');
    if (!(s.gores >= 2 && s.gores <= 30)) throw new Error('An elbow needs 2 to 30 gores');
    if (!(s.R > s.D / 2)) throw new Error('The elbow’s centre line radius must be more than half its diameter');
  }
  if (s.kind === 'cone' && !(s.D2 > 0 && s.L > 0 && s.D2 !== s.D)) throw new Error('The cone needs a second diameter (not the same) and a length');
  if (s.kind === 'transition' && !(s.W > 0 && s.H > 0 && s.L > 0)) throw new Error('The transition needs a rectangle (width and height) and a length');
  if (s.kind === 'offset' && !(s.L > 0)) throw new Error('The offset needs a length');
  if (s.kind === 'lateral' && !(s.branchD > 0 && s.branchD <= s.D && s.branchAngle >= 15 && s.branchAngle <= 90 && s.L > s.branchD)) throw new Error('The lateral needs a branch no wider than the main duct, at 15° to 90°, and a main length longer than the branch is wide');
  return s;
}

// (a closed outline from its points, as LINE entities)
const loopEnts = (pts, layer = 'OUTLINE') => pts.map((p, i) => ({ type: 'LINE', layer, a: p, b: pts[(i + 1) % pts.length] }));
const boxOf = (pts) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return { x0, y0, x1, y1 }; };
const area = (pts) => Math.abs(pts.reduce((t, p, i) => { const q = pts[(i + 1) % pts.length]; return t + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
// A piece: its outline moved to start at (0, 0), with its name, size and area.
const piece = (name, pts, extra = []) => {
  const b = boxOf(pts), mv = ([x, y]) => [x - b.x0, y - b.y0], P = pts.map(mv);
  return { name, outline: P, holes: extra.map((h) => h.map(mv)), size: [b.x1 - b.x0, b.y1 - b.y0], area: area(P) - extra.reduce((t, h) => t + area(h), 0) };
};
// A tube's development between a bottom and a top edge given as heights at each angle round it (φ from the seam),
// rolled on radius r; a seam allowance along one side. n points round.
function tubePattern(name, r, bottom, top, seam, n = 96) {
  const B = [], T = [];
  for (let i = 0; i <= n; i++) { const phi = (TAU * i) / n, x = r * phi; B.push([x, bottom(phi)]); T.push([x, top(phi)]); }
  const left = [[-seam, B[0][1]], [-seam, T[0][1]]];
  return piece(name, [...left.slice(0, 1), ...B, ...T.reverse(), ...left.slice(1)]);
}

// The flat patterns of a fitting: [{ name, outline, holes, size, area, qty }]
export function ductPatterns(s) {
  const rm = (s.D - s.t) / 2, out = [];
  if (s.kind === 'elbow') {
    // (n gores: two end gores of half the cut and n − 2 full ones; each cut plane turns by a = angle / (n − 1); the
    // seam at the throat, φ = 0 there, so a gore's height at φ: (R − r cos φ) tan(a / 2) each side of its middle)
    const a = ((s.angle * Math.PI) / 180) / (s.gores - 1), k = Math.tan(a / 2), h = (phi) => (s.R - rm * Math.cos(phi)) * k;
    out.push({ ...tubePattern('Elbow end gore', rm, () => 0, h, s.seam), qty: 2 });
    if (s.gores > 2) out.push({ ...tubePattern('Elbow middle gore', rm, (phi) => -h(phi), h, s.seam), qty: s.gores - 2 });
  } else if (s.kind === 'cone') {
    // (a frustum: an annular sector; slant length along the side, radii from the apex)
    const r1 = Math.max(s.D, s.D2) / 2 - s.t / 2, r2 = Math.min(s.D, s.D2) / 2 - s.t / 2, sl = Math.hypot(s.L, r1 - r2);
    const R1 = (sl * r1) / (r1 - r2), R2 = R1 - sl, th = (TAU * r1) / R1, m = 96, pts = [];
    for (let i = 0; i <= m; i++) { const t = (th * i) / m; pts.push([R1 * Math.cos(t), R1 * Math.sin(t)]); }
    for (let i = m; i >= 0; i--) { const t = (th * i) / m; pts.push([R2 * Math.cos(t), R2 * Math.sin(t)]); }
    // (the seam allowance: a strip along the first straight side)
    const sp = [[R2 * Math.cos(-s.seam / R2), R2 * Math.sin(-s.seam / R2)], [R1 * Math.cos(-s.seam / R1), R1 * Math.sin(-s.seam / R1)]];
    out.push({ ...piece('Cone', [...sp.slice(1), ...pts, sp[0]]), qty: 1 });
  } else if (s.kind === 'transition' || s.kind === 'offset') {
    out.push({ ...piece(s.kind === 'transition' ? 'Round to rectangle' : 'Offset', triangulated(rulings(s), s.seam)), qty: 1 });
  } else if (s.kind === 'lateral') {
    const L = lateral(s);
    out.push({ ...tubePattern('Lateral branch', L.rb, (phi) => L.cut(phi), () => L.len, s.seam), qty: 1 });
    // (the main: a plain tube with the hole where the branch joins it)
    const W = TAU * L.rmain, base = piece('Lateral main', [[-s.seam, 0], [W, 0], [W, s.L], [-s.seam, s.L]], [L.hole]);
    out.push({ ...base, qty: 1 });
  }
  return out;
}

// The 3D rulings (pairs of points, bottom → top) of a transition or an offset, starting at the seam.
export function rulings(s) {
  const rm = (s.D - s.t) / 2, out = [];
  if (s.kind === 'offset') {
    // (two parallel circles, the top one moved `offset` along X: straight lines at the same angle)
    for (let i = 0; i <= 96; i++) { const p = (TAU * i) / 96, c = Math.cos(p), sn = Math.sin(p); out.push([[rm * c, rm * sn, 0], [s.offset + rm * c, rm * sn, s.L]]); }
    return out;
  }
  // (a rectangle W × H (middle sizes) at z = 0, a circle on top at z = L; the seam at the middle of the rectangle's
  // side y = −h. Each circle quarter fans to a corner; between them a flat triangle to the next corner)
  const w = (s.W - s.t) / 2, h = (s.H - s.t) / 2, C = [[w, -h], [w, h], [-w, h], [-w, -h]], circ = (a) => [rm * Math.cos(a), rm * Math.sin(a), s.L];
  out.push([[0, -h, 0], circ(-Math.PI / 2)]);
  for (let q = 0; q < 4; q++) {
    const corner = [...C[q], 0], a0 = -Math.PI / 2 + (q * Math.PI) / 2;
    for (let i = 0; i <= 24; i++) out.push([corner, circ(a0 + (i / 24) * (Math.PI / 2))]);
  }
  out.push([[0, -h, 0], circ(1.5 * Math.PI)]);
  return out;
}
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// A ruled surface developed by triangles (the true length of every edge kept), a seam allowance at its start.
function triangulated(R, seam) {
  const B = [[0, 0]], T = [[0, d3(R[0][0], R[0][1])]];
  // (a point from two placed ones and its true distances to them, on the left of a → b)
  const third = (a, b, da, db) => { const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-12, x = (da * da - db * db + L * L) / (2 * L), y = Math.sqrt(Math.max(0, da * da - x * x)), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L; return [a[0] + ux * x - uy * y, a[1] + uy * x + ux * y]; };
  for (let i = 1; i < R.length; i++) {
    const [b0, t0] = R[i - 1], [b1, t1] = R[i];
    const Tn = d3(t0, t1) < 1e-12 ? T[i - 1] : third(T[i - 1], B[i - 1], d3(t0, t1), d3(b0, t1));
    // (both on the side away from the seam: the left of the line from the top point down to the bottom one)
    const Bn = d3(b0, b1) < 1e-12 ? B[i - 1] : third(Tn, B[i - 1], d3(t1, b1), d3(b0, b1));
    T.push(Tn); B.push(Bn);
  }
  const n0 = [B[0][0] - seam, B[0][1]], n1 = [T[0][0] - seam, T[0][1]];
  return [n0, ...B, ...T.reverse(), n1];
}

// A lateral: the branch (radius rb on the sheet's middle) joining the main (rmain) at branchAngle, its axis meeting
// the main's axis at the middle of the main's length. cut(φ): how far up the branch's generatrix at φ it meets the
// main (from the axes' crossing); len: the branch's end; hole: the hole in the main's development.
export function lateral(s) {
  const rmain = (s.D - s.t) / 2, rb = (s.branchD - s.t) / 2, b = (s.branchAngle * Math.PI) / 180;
  const d = [Math.sin(b), 0, Math.cos(b)], u = [Math.cos(b), 0, -Math.sin(b)], v = [0, 1, 0], z0 = s.L / 2;
  // (the main along Z, its axis through (0, 0); the branch's line from (0, 0, z0) along d)
  const meet = (phi) => {
    const o = [rb * (Math.cos(phi) * u[0] + Math.sin(phi) * v[0]), rb * (Math.cos(phi) * u[1] + Math.sin(phi) * v[1]), z0 + rb * (Math.cos(phi) * u[2] + Math.sin(phi) * v[2])];
    // |o_xy + s d_xy| = rmain (outside the main, s > 0)
    const A = d[0] * d[0] + d[1] * d[1], Bq = 2 * (o[0] * d[0] + o[1] * d[1]), Cq = o[0] * o[0] + o[1] * o[1] - rmain * rmain;
    const sv = (-Bq + Math.sqrt(Math.max(0, Bq * Bq - 4 * A * Cq))) / (2 * A);
    return { sv, p: [o[0] + sv * d[0], o[1] + sv * d[1], o[2] + sv * d[2]] };
  };
  const len = s.branchL + rmain / Math.sin(b);
  const hole = [];
  for (let i = 0; i < 96; i++) { const { p } = meet((TAU * i) / 96); let a = Math.atan2(p[1], p[0]); if (a < 0) a += TAU; hole.push([rmain * ((a + Math.PI) % TAU), p[2]]); }
  return { rmain, rb, len, cut: (phi) => meet(phi).sv, hole };
}

// The patterns as DXF entities, side by side, `apart` between them, each named.
export function patternEnts(pieces, apart = 30) {
  const out = [];
  let x = 0;
  for (const p of pieces) {
    const mv = ([a, b]) => [a + x, b];
    out.push(...loopEnts(p.outline.map(mv)), ...p.holes.flatMap((h) => loopEnts(h.map(mv), 'HOLES')));
    out.push({ type: 'TEXT', layer: 'NOTES', p: [x + p.size[0] / 2, -12], h: 6, rot: 0, text: `${p.name} x${p.qty}`, align: 'center' });
    x += p.size[0] + apart;
  }
  return out;
}
