// Tolerance stack-up: a one-direction chain of dimensions (each a nominal, its upper and lower tolerance and a sense:
// +1 adding to the gap, −1 taking from it) and what it gives: the gap's nominal, its worst case and its statistical
// (root sum of squares) limits, and each dimension's share of the variation. Kept in doc.stackups.
// rows: [{ name, nominal, plus, minus (both positive: nominal +plus / −minus), dir }]; req: { min, max } (optional)
export function stackUp(rows, req = {}) {
  const items = rows.map((r) => {
    const nominal = +r.nominal, plus = Math.abs(+r.plus || 0), minus = Math.abs(+r.minus || 0), dir = +r.dir < 0 ? -1 : 1;
    if (!Number.isFinite(nominal)) throw new Error(`${r.name || 'A dimension'} needs a nominal size`);
    return { name: r.name, dir, nominal, mid: nominal + (plus - minus) / 2, half: (plus + minus) / 2 };
  });
  const nominal = items.reduce((t, x) => t + x.dir * x.nominal, 0), mid = items.reduce((t, x) => t + x.dir * x.mid, 0);
  const wc = items.reduce((t, x) => t + x.half, 0), ss = items.reduce((t, x) => t + x.half * x.half, 0), rss = Math.sqrt(ss);
  const out = {
    nominal, mean: mid,
    worst: { min: mid - wc, max: mid + wc },
    rss: { min: mid - rss, max: mid + rss },
    shares: items.map((x) => ({ name: x.name, share: ss ? (x.half * x.half) / ss : 0, wcShare: wc ? x.half / wc : 0 })),
  };
  const lo = req.min === '' || req.min == null ? -Infinity : +req.min, hi = req.max === '' || req.max == null ? Infinity : +req.max;
  out.pass = { worst: out.worst.min >= lo - 1e-12 && out.worst.max <= hi + 1e-12, rss: out.rss.min >= lo - 1e-12 && out.rss.max <= hi + 1e-12 };
  return out;
}
