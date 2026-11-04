// Identical bodies: the turn and move that take one body onto another, from their corner points and the middle of them.
// The same shape turned over is not the same body here: only turns, never reflections, so a mirrored body isn't matched.
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// a frame from two directions: its axes as rows, or null when they are in line
function frame(u, v) {
  const e1 = unit(u), side = sub(v, e1.map((x) => x * dot(v, e1)));
  if (len(side) < 1e-6) return null;
  const e2 = unit(side);
  return [e1, e2, cross(e1, e2)];
}
// rotation matrix (rows) as the quaternion [x, y, z, w]
function quaternion(m) {
  const t = m[0][0] + m[1][1] + m[2][2];
  let q;
  if (t > 0) { const s = Math.sqrt(t + 1) * 2; q = [(m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s, s / 4]; }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; q = [s / 4, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s, (m[2][1] - m[1][2]) / s]; }
  else if (m[1][1] > m[2][2]) { const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; q = [(m[0][1] + m[1][0]) / s, s / 4, (m[1][2] + m[2][1]) / s, (m[0][2] - m[2][0]) / s]; }
  else { const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; q = [(m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, s / 4, (m[1][0] - m[0][1]) / s]; }
  return q.map((x) => +x.toFixed(12));
}

// { pos, rot } with q = rot(p) + pos for each corner p of the first onto a corner q of the second; null when none does
export function matchBodies(P, cp, Q, cq, tol = 1e-3) {
  const out = (m) => {
    const turn = (p) => [dot(m[0], p), dot(m[1], p), dot(m[2], p)], t = sub(cq, turn(cp));
    return { pos: t.map((x) => +x.toFixed(9)), rot: quaternion(m), turn: (p) => { const r = turn(p); return [r[0] + t[0], r[1] + t[1], r[2] + t[2]]; } };
  };
  const answer = ({ pos, rot }) => ({ pos, rot });
  if (P.length !== Q.length) return null;
  const covers = (r) => P.every((p) => { const x = r.turn(p); return Q.some((q) => len(sub(x, q)) < tol); });
  const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  // (a body without two corners off its centre's line, a ball: only the move)
  const off = P.map((p) => sub(p, cp)).sort((a, b) => len(b) - len(a));
  const a = off[0];
  if (!a || len(a) < tol) return answer(out(I));
  const b = off.map((p) => ({ p, d: len(cross(unit(a), p)) })).sort((x, y) => y.d - x.d)[0].p;
  const onto = Q.map((q) => sub(q, cq));
  const near = (x, y) => Math.abs(x - y) < tol;
  const through = (to, from) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => to[0][i] * from[0][j] + to[1][i] * from[1][j] + to[2][i] * from[2][j]));
  const from = frame(a, b);
  // (every point on one line through the centre, a plain shaft: any turn about that line will do)
  if (!from) {
    const side = (d) => frame(d, Math.abs(d[0]) < Math.abs(d[1]) ? [1, 0, 0] : [0, 1, 0]);
    for (const u of onto) { if (near(len(u), len(a))) { const r = out(through(side(u), side(a))); if (covers(r)) return answer(r); } }
    return null;
  }
  for (const u of onto) {
    if (!near(len(u), len(a))) continue;
    for (const v of onto) {
      if (!near(len(v), len(b)) || !near(len(sub(u, v)), len(sub(a, b)))) continue;
      const to = frame(u, v);
      if (!to) continue;
      const r = out(through(to, from));
      if (covers(r)) return answer(r);
    }
  }
  return null;
}
