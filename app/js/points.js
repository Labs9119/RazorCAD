// Point clouds (scans): read from PLY (ASCII or binary) and XYZ / CSV text, kept as base64 of 32-bit floats, and
// surfaces fitted to them: a plane, a sphere or a cylinder by least squares, or a freeform surface through a grid of
// heights over the cloud's best plane.

// The points of a file: Float32Array of x, y, z. A PLY's faces are not read (a mesh: import it as a mesh instead).
export function parsePoints(name, bytes) {
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  if (/^ply\b/.test(head)) return parsePLY(bytes);
  const text = new TextDecoder().decode(bytes), out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().split(/[\s,;]+/);
    if (m.length < 3) continue;
    const x = +m[0], y = +m[1], z = +m[2];
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) out.push(x, y, z);
  }
  if (!out.length) throw new Error(`${name} has no points (lines of x y z)`);
  return Float32Array.from(out);
}
function parsePLY(bytes) {
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const end = text.indexOf('end_header');
  if (end < 0) throw new Error('A PLY file without its header');
  const header = text.slice(0, end).split(/\r?\n/), fmt = (header.find((l) => l.startsWith('format')) || '').split(/\s+/)[1];
  let count = 0, inVertex = false;
  const props = [];
  for (const l of header) {
    const w = l.trim().split(/\s+/);
    if (w[0] === 'element') { inVertex = w[1] === 'vertex'; if (inVertex) count = +w[2]; }
    else if (w[0] === 'property' && inVertex) props.push(w[1] === 'list' ? { type: 'list' } : { type: w[1], name: w[2] });
  }
  const ix = ['x', 'y', 'z'].map((n) => props.findIndex((p) => p.name === n));
  if (!count || ix.some((i) => i < 0)) throw new Error('The PLY file has no x, y, z vertices');
  const out = new Float32Array(count * 3);
  let at = end + 'end_header'.length;
  while (bytes[at] === 13 || bytes[at] === 10) at++;
  if (fmt === 'ascii') {
    const lines = new TextDecoder().decode(bytes.subarray(at)).split(/\r?\n/);
    for (let k = 0, n = 0; k < lines.length && n < count; k++) { const w = lines[k].trim().split(/\s+/); if (w.length < props.length) continue; for (let j = 0; j < 3; j++) out[3 * n + j] = +w[ix[j]]; n++; }
    return out;
  }
  const little = fmt === 'binary_little_endian', dv = new DataView(bytes.buffer, bytes.byteOffset + at);
  const size = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
  const read = (t, o) => (t === 'float' || t === 'float32' ? dv.getFloat32(o, little) : t === 'double' || t === 'float64' ? dv.getFloat64(o, little) : t.includes('int') || t === 'short' || t === 'ushort' || t === 'char' || t === 'uchar' ? (size[t] === 1 ? dv.getUint8(o) : size[t] === 2 ? dv.getInt16(o, little) : dv.getInt32(o, little)) : 0);
  if (props.some((p) => p.type === 'list')) throw new Error('This PLY file has lists in its vertices (not supported)');
  const offs = [], stride = props.reduce((s, p) => { offs.push(s); return s + size[p.type]; }, 0);
  for (let n = 0; n < count; n++) for (let j = 0; j < 3; j++) out[3 * n + j] = read(props[ix[j]].type, n * stride + offs[ix[j]]);
  return out;
}
// At most max points (every k-th): for keeping in the part.
export function thinPoints(P, max = 200000) {
  const n = P.length / 3;
  if (n <= max) return P;
  const k = n / max, out = new Float32Array(max * 3);
  for (let i = 0; i < max; i++) { const j = Math.floor(i * k) * 3; out[3 * i] = P[j]; out[3 * i + 1] = P[j + 1]; out[3 * i + 2] = P[j + 2]; }
  return out;
}
export function encodePoints(P) { const b = new Uint8Array(P.buffer, P.byteOffset, P.byteLength); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); }
export function decodePoints(s) { const bin = atob(s), b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return new Float32Array(b.buffer); }

// ------------------------------------------------------------ fitting
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };
const at = (P, i) => [P[3 * i], P[3 * i + 1], P[3 * i + 2]];
// (a symmetric 3 × 3 matrix's eigen vectors by Jacobi: [{ value, vector }] smallest first)
function eigen3(A) {
  const a = A.map((r) => r.slice()), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 60; it++) {
    let p = 0, q = 1;
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) if (Math.abs(a[i][j]) > Math.abs(a[p][q])) { p = i; q = j; }
    if (Math.abs(a[p][q]) < 1e-15) break;
    const th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
    for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
    for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
    for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
  }
  return [0, 1, 2].map((i) => ({ value: a[i][i], vector: [V[0][i], V[1][i], V[2][i]] })).sort((x, y) => x.value - y.value);
}
// The best plane: { o (the middle), n (normal), u, v (in it), rms }
export function fitPlane(P) {
  const n = P.length / 3, o = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) o[k] += P[3 * i + k] / n;
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) { const d = sub(at(P, i), o); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r][c] += d[r] * d[c] / n; }
  const e = eigen3(C), nn = unit(e[0].vector), v = unit(e[2].vector), u = unit(cross(v, nn));
  return { o, n: nn, u, v: cross(nn, u), rms: Math.sqrt(Math.max(0, e[0].value)), axisGuess: unit(e[2].vector) };
}
// The best sphere: { c, r, rms } (linear least squares on x² + y² + z² = 2a·p + d)
export function fitSphere(P) {
  const n = P.length / 3, M = Array.from({ length: 4 }, () => [0, 0, 0, 0]), b = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) { const p = at(P, i), row = [2 * p[0], 2 * p[1], 2 * p[2], 1], w = dot(p, p); for (let r = 0; r < 4; r++) { b[r] += row[r] * w; for (let c = 0; c < 4; c++) M[r][c] += row[r] * row[c]; } }
  const x = solve(M, b), c = [x[0], x[1], x[2]], r = Math.sqrt(Math.max(0, x[3] + dot(c, c)));
  let e = 0; for (let i = 0; i < n; i++) { const d = Math.hypot(...sub(at(P, i), c)) - r; e += d * d; }
  return { c, r, rms: Math.sqrt(e / n) };
}
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-18) throw new Error('The points do not fix the shape (all in a line or a plane?)');
    for (let r = 0; r < n; r++) if (r !== c) { const k = M[r][c] / M[c][c]; for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
// The best cylinder: { p (a point on the axis), d (its direction), r, rms, t0, t1 (the points' extent along it) }:
// the axis started along the cloud's longest spread (or the plane's normal when it is short and wide), then by
// Gauss–Newton on the distances to the axis.
export function fitCylinder(P) {
  const n = P.length / 3, pl = fitPlane(P);
  const tryFrom = (d0) => {
    let d = unit(d0), p = pl.o.slice(), r = 0;
    for (let it = 0; it < 40; it++) {
      // (the circle in the plane square to d: an algebraic fit, then the axis turned to cut the residuals)
      const u = unit(Math.abs(d[0]) < 0.9 ? cross(d, [1, 0, 0]) : cross(d, [0, 1, 0])), v = cross(d, u);
      const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
      for (let i = 0; i < n; i++) { const q = sub(at(P, i), p), x = dot(q, u), y = dot(q, v), row = [2 * x, 2 * y, 1], w = x * x + y * y; for (let a = 0; a < 3; a++) { b[a] += row[a] * w; for (let c = 0; c < 3; c++) M[a][c] += row[a] * row[c]; } }
      const s = solve(M, b);
      p = [0, 1, 2].map((k) => p[k] + u[k] * s[0] + v[k] * s[1]);
      r = Math.sqrt(Math.max(0, s[2] + s[0] * s[0] + s[1] * s[1]));
      // (the axis direction: the turn that best lowers the residuals, from their slopes along it)
      let gx = 0, gy = 0, hh = 0;
      for (let i = 0; i < n; i++) { const q = sub(at(P, i), p), t = dot(q, d), x = dot(q, u), y = dot(q, v), rho = Math.hypot(x, y) || 1e-12, e = rho - r; gx += e * (x / rho) * t; gy += e * (y / rho) * t; hh += t * t; }
      if (hh < 1e-18) break;
      const dx = gx / hh, dy = gy / hh;
      d = unit([0, 1, 2].map((k) => d[k] + u[k] * dx + v[k] * dy));
      if (Math.hypot(dx, dy) < 1e-12) break;
    }
    let e = 0, t0 = Infinity, t1 = -Infinity;
    for (let i = 0; i < n; i++) { const q = sub(at(P, i), p), t = dot(q, d), rho = Math.hypot(...sub(q, d.map((x) => x * t))); e += (rho - r) ** 2; t0 = Math.min(t0, t); t1 = Math.max(t1, t); }
    return { p, d, r, rms: Math.sqrt(e / n), t0, t1 };
  };
  const a = tryFrom(pl.axisGuess), b = tryFrom(pl.n);
  return a.rms <= b.rms ? a : b;
}
// A grid of heights over the best plane for a freeform surface: N × N points (rows along v), each the height of a
// plane fitted by weighted least squares to the points near it (so slopes, at the edges too, are not pulled flat),
// gaps filled from neighbours. { rows: [[x, y, z]…]…, plane, rms }
export function heightGrid(P, N = 20) {
  const pl = fitPlane(P), n = P.length / 3, uv = new Float64Array(n * 3);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < n; i++) { const q = sub(at(P, i), pl.o), u = dot(q, pl.u), v = dot(q, pl.v), w = dot(q, pl.n); uv[3 * i] = u; uv[3 * i + 1] = v; uv[3 * i + 2] = w; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  const du = (u1 - u0) / (N - 1), dv = (v1 - v0) / (N - 1), R = 1.6 * Math.max(du, dv), S = new Float64Array(N * N * 9);
  for (let i = 0; i < n; i++) {
    const u = uv[3 * i], v = uv[3 * i + 1], h = uv[3 * i + 2], gi = (u - u0) / du, gj = (v - v0) / dv, rr = R / Math.max(du, dv);
    for (let a = Math.max(0, Math.floor(gi - rr)); a <= Math.min(N - 1, Math.ceil(gi + rr)); a++) for (let b = Math.max(0, Math.floor(gj - rr)); b <= Math.min(N - 1, Math.ceil(gj + rr)); b++) {
      const x = u - (u0 + a * du), y = v - (v0 + b * dv), d2 = x * x + y * y;
      if (d2 > R * R) continue;
      const w = (1 - d2 / (R * R)) ** 2, o = (b * N + a) * 9;
      S[o] += w; S[o + 1] += w * x; S[o + 2] += w * y; S[o + 3] += w * x * x; S[o + 4] += w * x * y; S[o + 5] += w * y * y; S[o + 6] += w * h; S[o + 7] += w * h * x; S[o + 8] += w * h * y;
    }
  }
  const H = new Float64Array(N * N).fill(NaN);
  for (let k = 0; k < N * N; k++) {
    const o = k * 9, [w, sx, sy, sxx, sxy, syy, sh, shx, shy] = S.subarray(o, o + 9);
    if (!(w > 0)) continue;
    // (h = c0 + c1 x + c2 y at the node: c0)
    const A = [[w, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]], bb = [sh, shx, shy];
    try { H[k] = solve(A, bb)[0]; } catch { H[k] = sh / w; }
  }
  for (let pass = 0; pass < N && H.some(Number.isNaN); pass++) {
    const G = H.slice();
    for (let b = 0; b < N; b++) for (let a = 0; a < N; a++) {
      if (!Number.isNaN(H[b * N + a])) continue;
      let s = 0, c = 0; for (const [x, y] of [[a - 1, b], [a + 1, b], [a, b - 1], [a, b + 1]]) if (x >= 0 && y >= 0 && x < N && y < N && !Number.isNaN(H[y * N + x])) { s += H[y * N + x]; c++; }
      if (c) G[b * N + a] = s / c;
    }
    H.set(G);
  }
  const rows = [];
  for (let b = 0; b < N; b++) { const row = []; for (let a = 0; a < N; a++) { const u = u0 + a * du, v = v0 + b * dv, w = H[b * N + a] || 0; row.push([0, 1, 2].map((k) => pl.o[k] + pl.u[k] * u + pl.v[k] * v + pl.n[k] * w)); } rows.push(row); }
  return { rows, plane: pl, extent: { u0, u1, v0, v1 } };
}
