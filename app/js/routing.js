// Routing: pipe sizes (nominal size DN / NPS, outside diameter and Schedule 40 wall, mm, as in ASME B36.10M) and a
// cable bundle's diameter from its wires.
// tee: an equal tee's centre to end (C = M), reducer: a concentric reducer's length (H), both as in ASME B16.9.
export const PIPE_SIZES = [
  { dn: 15, nps: 0.5, D: 21.3, t: 2.77, tee: 25, reducer: 38 }, { dn: 20, nps: 0.75, D: 26.7, t: 2.87, tee: 29, reducer: 38 }, { dn: 25, nps: 1, D: 33.4, t: 3.38, tee: 38, reducer: 51 },
  { dn: 32, nps: 1.25, D: 42.2, t: 3.56, tee: 48, reducer: 51 }, { dn: 40, nps: 1.5, D: 48.3, t: 3.68, tee: 57, reducer: 64 }, { dn: 50, nps: 2, D: 60.3, t: 3.91, tee: 64, reducer: 76 },
  { dn: 65, nps: 2.5, D: 73.0, t: 5.16, tee: 76, reducer: 89 }, { dn: 80, nps: 3, D: 88.9, t: 5.49, tee: 86, reducer: 89 }, { dn: 100, nps: 4, D: 114.3, t: 6.02, tee: 105, reducer: 102 },
  { dn: 125, nps: 5, D: 141.3, t: 6.55, tee: 124, reducer: 127 }, { dn: 150, nps: 6, D: 168.3, t: 7.11, tee: 143, reducer: 140 }, { dn: 200, nps: 8, D: 219.1, t: 8.18, tee: 178, reducer: 152 },
  { dn: 250, nps: 10, D: 273.0, t: 9.27, tee: 216, reducer: 178 }, { dn: 300, nps: 12, D: 323.8, t: 10.31, tee: 254, reducer: 203 },
];
export const pipeLabel = (s) => `DN${s.dn} (${s.nps < 1 ? s.nps.toString().replace(/^0/, '') : s.nps}″) ${s.D} × ${s.t}`;
// The pipe of a route feature: { D, t, R (the elbow / bend radius at the pipe's centre line), label }
export function pipeOf(f, ev) {
  const s = f.size !== 'custom' ? PIPE_SIZES.find((x) => String(x.dn) === String(f.size)) : null;
  const D = s ? s.D : ev(f.od), t = s ? s.t : ev(f.wall);
  if (!(D > 0) || !(t > 0) || 2 * t >= D) throw new Error('The pipe needs an outside diameter and a wall thinner than half of it');
  const auto = f.corner === 'bend' ? 3 * D : s ? 1.5 * s.nps * 25.4 : 1.5 * D; // (long radius elbows: 1.5 × the nominal size; bends: 3 × OD)
  const R = f.radius === '' || f.radius == null || f.radius === 'auto' ? auto : ev(f.radius);
  if (!(R > D / 2)) throw new Error('The bend radius must be more than half the pipe’s diameter');
  return { D, t, R, tee: s ? s.tee : D, reducer: s ? s.reducer : 1.5 * D, label: s ? `Pipe DN${s.dn}` : `Tube ${+D.toFixed(3)} × ${+t.toFixed(3)}` };
}
// A bundle of n wires of diameter d: about 1.15 · d · √n across (round, loosely packed); one wire: d.
export const bundleDiameter = (n, d) => (n <= 1 ? d : 1.15 * d * Math.sqrt(n));
