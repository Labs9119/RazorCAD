// Nesting flat patterns on stock sheets: each part as the rectangle round its flat pattern (given a quarter turn
// where that fits better), placed by MaxRects (best short side fit) on sheets of W × H inside a margin, `gap` apart. Returns the sheets with each part's place, and the share of each sheet used.
// parts: [{ name, qty, size: [w, h], area, ents }] (ents: flat entities from the lower left corner, as for DXF)

// The parts' rectangles, each placed at (x, y) turned rot (0 or 90°, anticlockwise, then moved back to x ≥ 0).
export function nest(parts, { W, H, margin = 10, gap = 5, rotate = true } = {}) {
  if (!(W > 0 && H > 0)) throw new Error('The sheet needs a width and a height');
  const iw = W - 2 * margin, ih = H - 2 * margin;
  const items = [];
  parts.forEach((p, i) => { for (let k = 0; k < Math.max(0, Math.round(p.qty ?? 1)); k++) items.push({ i, w: p.size[0], h: p.size[1], area: p.area ?? p.size[0] * p.size[1] }); });
  for (const it of items) {
    const fits0 = it.w <= iw + 1e-9 && it.h <= ih + 1e-9, fits90 = rotate && it.h <= iw + 1e-9 && it.w <= ih + 1e-9;
    if (!fits0 && !fits90) throw new Error(`${parts[it.i].name} (${+it.w.toFixed(1)} × ${+it.h.toFixed(1)}) does not fit on the sheet inside its margin`);
  }
  // (biggest first)
  items.sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h);
  const sheets = [];
  const newSheet = () => { const s = { free: [{ x: 0, y: 0, w: iw + gap, h: ih + gap }], placed: [] }; sheets.push(s); return s; };
  const place = (s, it) => {
    let best = null;
    for (const r of s.free) for (const rot of rotate ? [0, 90] : [0]) {
      const w = (rot ? it.h : it.w) + gap, h = (rot ? it.w : it.h) + gap;
      if (w > r.w + 1e-9 || h > r.h + 1e-9) continue;
      const short = Math.min(r.w - w, r.h - h), long = Math.max(r.w - w, r.h - h);
      if (!best || short < best.short - 1e-9 || (Math.abs(short - best.short) < 1e-9 && long < best.long)) best = { x: r.x, y: r.y, w, h, rot, short, long };
    }
    if (!best) return false;
    s.placed.push({ i: it.i, x: margin + best.x, y: margin + best.y, rot: best.rot, w: best.w - gap, h: best.h - gap });
    // (split every free rectangle the new one overlaps, then drop those inside others)
    const nb = { x: best.x, y: best.y, w: best.w, h: best.h }, next = [];
    for (const r of s.free) {
      if (nb.x >= r.x + r.w || nb.x + nb.w <= r.x || nb.y >= r.y + r.h || nb.y + nb.h <= r.y) { next.push(r); continue; }
      if (nb.x > r.x) next.push({ x: r.x, y: r.y, w: nb.x - r.x, h: r.h });
      if (nb.x + nb.w < r.x + r.w) next.push({ x: nb.x + nb.w, y: r.y, w: r.x + r.w - nb.x - nb.w, h: r.h });
      if (nb.y > r.y) next.push({ x: r.x, y: r.y, w: r.w, h: nb.y - r.y });
      if (nb.y + nb.h < r.y + r.h) next.push({ x: r.x, y: nb.y + nb.h, w: r.w, h: r.y + r.h - nb.y - nb.h });
    }
    s.free = next.filter((r, k) => r.w > 1e-9 && r.h > 1e-9 && !next.some((q, j) => j !== k && q.x <= r.x + 1e-9 && q.y <= r.y + 1e-9 && q.x + q.w >= r.x + r.w - 1e-9 && q.y + q.h >= r.y + r.h - 1e-9 && (j < k || q.w * q.h > r.w * r.h)));
    return true;
  };
  for (const it of items) if (!sheets.some((s) => place(s, it))) place(newSheet(), it);
  return sheets.map((s) => ({ placed: s.placed, used: s.placed.reduce((t, q) => t + (parts[q.i].area ?? q.w * q.h), 0) / (W * H) }));
}

// A part's flat entities where the nest puts it (x, y the lower left corner of its rectangle; rot 90: a quarter turn).
export function placeEnts(ents, size, { x, y, rot }) {
  const T = rot ? (p) => [x + size[1] - p[1], y + p[0]] : (p) => [x + p[0], y + p[1]];
  return ents.map((e) => {
    const r = { ...e };
    if (e.a) r.a = T(e.a);
    if (e.b) r.b = T(e.b);
    if (e.c) r.c = T(e.c);
    if (e.p) r.p = T(e.p);
    if (e.pts) r.pts = e.pts.map(T);
    if (rot && e.type === 'ARC') { r.a0 = e.a0 + 90; r.a1 = e.a1 + 90; }
    if (rot && e.type === 'TEXT') r.rot = (e.rot || 0) + 90;
    return r;
  });
}

// The nest as DXF entities: the sheets side by side (`apart` between them), each with its outline (layer SHEET) and
// its parts (outlines and holes; bend lines if asked), each part named at its middle.
export function nestEnts(parts, sheets, { W, H, apart = 50, bendLines = false, names = true } = {}) {
  const out = [];
  sheets.forEach((s, k) => {
    const ox = k * (W + apart);
    const c = [[ox, 0], [ox + W, 0], [ox + W, H], [ox, H]];
    c.forEach((p, i) => out.push({ type: 'LINE', layer: 'SHEET', a: p, b: c[(i + 1) % 4] }));
    out.push({ type: 'TEXT', layer: 'NOTES', p: [ox, H + 8], h: 6, rot: 0, text: `Sheet ${k + 1}: ${W} x ${H}, ${(s.used * 100).toFixed(1)} % used` });
    for (const q of s.placed) {
      const p = parts[q.i], keep = p.ents.filter((e) => e.layer === 'OUTLINE' || e.layer === 'HOLES' || (bendLines && (e.layer === 'BEND_UP' || e.layer === 'BEND_DOWN')));
      out.push(...placeEnts(keep, p.size, { x: ox + q.x, y: q.y, rot: q.rot }));
      if (names) out.push({ type: 'TEXT', layer: 'NOTES', p: [ox + q.x + q.w / 2, q.y + q.h / 2], h: Math.min(5, q.h / 6), rot: 0, text: p.name, align: 'center' });
    }
  });
  return out;
}
