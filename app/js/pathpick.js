// Part of a sketch's path: the run of segments between two picked segments or points. A sketch's (or 3D
// sketch's) segments as a graph, their ends joined where they meet; the run is the shortest way along them.
// items: [{ id, pts: [[x, y, z], …] }] (each segment as a polyline, in order); a run: [segment id, …] in order.

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], (p[2] || 0) - (q[2] || 0));

export function pathGraph(items, tol = null) {
  const span = items.flatMap((it) => [it.pts[0], it.pts[it.pts.length - 1]]);
  let size = 0;
  for (const p of span) for (const q of span) size = Math.max(size, dist(p, q));
  const t = tol ?? Math.max(1e-6, size * 1e-7), nodes = [];
  const node = (p) => { let k = nodes.findIndex((q) => dist(q, p) <= t); if (k < 0) { nodes.push(p); k = nodes.length - 1; } return k; };
  const edges = items.filter((it) => it.pts.length > 1 && dist(it.pts[0], it.pts[it.pts.length - 1]) > t).map((it) => {
    let L = 0;
    for (let i = 1; i < it.pts.length; i++) L += dist(it.pts[i - 1], it.pts[i]);
    return { id: it.id, a: node(it.pts[0]), b: node(it.pts[it.pts.length - 1]), L };
  });
  return { nodes, edges, tol: t };
}

// The node nearest a point (within the graph's tolerance × 1000), or -1
export function nodeAt(g, p) {
  let best = -1, bd = g.tol * 1000;
  g.nodes.forEach((q, k) => { const d = dist(q, p); if (d <= bd) { bd = d; best = k; } });
  return best;
}

// The run from `from` to `to`, each { seg: id } (that segment and on) or { node: index } (from that point): the
// shortest way between them along the segments, the end segments included; null when they are not connected
export function runBetween(g, from, to) {
  const E = new Map(g.edges.map((e) => [e.id, e]));
  const starts = from.seg != null ? (E.has(from.seg) ? [E.get(from.seg).a, E.get(from.seg).b] : []) : [from.node];
  const ends = to.seg != null ? (E.has(to.seg) ? [E.get(to.seg).a, E.get(to.seg).b] : []) : [to.node];
  if (!starts.length || !ends.length) return null;
  if (from.seg != null && from.seg === to.seg) return [from.seg];
  // (Dijkstra from the start's ends, not through the end segments themselves)
  const skip = new Set([from.seg, to.seg].filter((x) => x != null));
  const D = new Map(starts.map((k) => [k, 0])), prev = new Map(), done = new Set();
  for (;;) {
    let u = -1, du = Infinity;
    for (const [k, d] of D) if (!done.has(k) && d < du) { du = d; u = k; }
    if (u < 0) return null;
    if (ends.includes(u)) {
      const run = [];
      for (let k = u; prev.has(k); k = prev.get(k).from) run.unshift(prev.get(k).id);
      // (the start segment first, the end segment last, each once)
      return [...(from.seg != null ? [from.seg] : []), ...run, ...(to.seg != null ? [to.seg] : [])];
    }
    done.add(u);
    for (const e of g.edges) {
      if (skip.has(e.id) || (e.a !== u && e.b !== u)) continue;
      const v = e.a === u ? e.b : e.a, d = du + e.L;
      if (d < (D.get(v) ?? Infinity)) { D.set(v, d); prev.set(v, { from: u, id: e.id }); }
    }
  }
}
