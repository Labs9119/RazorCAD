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

// A part's flat entities where the nest puts it: x, y the lower left corner of its rectangle, turned rot (90: a
// quarter turn); a true-shape placement (dx, dy) instead: turned rot° about the part's origin, then moved by dx, dy.
export function placeEnts(ents, size, { x, y, rot, dx, dy }) {
  let T;
  if (dx != null) {
    const a = (rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    T = (p) => [x + dx + p[0] * c - p[1] * s, y + dy + p[0] * s + p[1] * c];
  } else T = rot ? (p) => [x + size[1] - p[1], y + p[0]] : (p) => [x + p[0], y + p[1]];
  return ents.map((e) => {
    const r = { ...e };
    if (e.a) r.a = T(e.a);
    if (e.b) r.b = T(e.b);
    if (e.c) r.c = T(e.c);
    if (e.p) r.p = T(e.p);
    if (e.pts) r.pts = e.pts.map(T);
    if (rot && e.type === 'ARC') { r.a0 = e.a0 + rot; r.a1 = e.a1 + rot; }
    if (rot && e.type === 'TEXT') r.rot = (e.rot || 0) + rot;
    return r;
  });
}

// ------------------------------------------------------------ true-shape nesting
// The closed loops of a part's outline and holes (lines, arcs, circles and polylines joined end to end), as points.
export function outlineLoops(ents, tol = 1e-4) {
  const segs = [];
  for (const e of ents) {
    if (e.layer !== 'OUTLINE' && e.layer !== 'HOLES') continue;
    if (e.type === 'CIRCLE') { segs.push({ pts: Array.from({ length: 49 }, (_, i) => [e.c[0] + e.r * Math.cos((i / 48) * 2 * Math.PI), e.c[1] + e.r * Math.sin((i / 48) * 2 * Math.PI)]) }); continue; }
    if (e.type === 'LINE') { segs.push({ pts: [e.a, e.b] }); continue; }
    if (e.type === 'ARC') {
      let a0 = (e.a0 * Math.PI) / 180, a1 = (e.a1 * Math.PI) / 180;
      while (a1 <= a0) a1 += 2 * Math.PI;
      const n = Math.max(4, Math.ceil(((a1 - a0) * 24) / Math.PI));
      segs.push({ pts: Array.from({ length: n + 1 }, (_, i) => { const t = a0 + ((a1 - a0) * i) / n; return [e.c[0] + e.r * Math.cos(t), e.c[1] + e.r * Math.sin(t)]; }) });
      continue;
    }
    if (e.pts?.length > 1) segs.push({ pts: e.closed ? [...e.pts, e.pts[0]] : [...e.pts] });
  }
  const near = (p, q) => Math.abs(p[0] - q[0]) < tol && Math.abs(p[1] - q[1]) < tol, loops = [], left = [...segs];
  while (left.length) {
    let loop = [...left.shift().pts];
    for (let grew = true; grew && !near(loop[0], loop.at(-1)); ) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i].pts;
        if (near(p[0], loop.at(-1))) loop.push(...p.slice(1));
        else if (near(p.at(-1), loop.at(-1))) loop.push(...[...p].reverse().slice(1));
        else continue;
        left.splice(i, 1); grew = true; break;
      }
    }
    if (loop.length > 2) loops.push(loop);
  }
  return loops;
}
// A part turned rot° as a raster (rows of 32-bit words, 1 = taken), grown by half the gap all round, and where its
// cells start: { w, h, words, rows, ox, oy } (ox, oy: the turned part's lower left, in mm, at cell 0, 0).
function partMask(loops, rot, cell, gap) {
  const a = (rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), R = loops.map((l) => l.map(([x, y]) => [x * c - y * s, x * s + y * c]));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of R) for (const [x, y] of l) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const g = gap / 2, w = Math.max(1, Math.ceil((x1 - x0 + gap) / cell) + 1), h = Math.max(1, Math.ceil((y1 - y0 + gap) / cell) + 1);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.setTransform(1 / cell, 0, 0, 1 / cell, (-x0 + g) / cell, (-y0 + g) / cell);
  ctx.beginPath();
  for (const l of R) { ctx.moveTo(...l[0]); for (const p of l.slice(1)) ctx.lineTo(...p); ctx.closePath(); }
  ctx.fillStyle = '#000'; ctx.fill('evenodd');
  ctx.lineWidth = Math.max(gap, cell * 0.5); ctx.lineJoin = 'round'; ctx.strokeStyle = '#000'; ctx.stroke();
  const px = ctx.getImageData(0, 0, w, h).data, nw = Math.ceil(w / 32), words = new Uint32Array(nw * h);
  for (let r = 0; r < h; r++) for (let x = 0; x < w; x++) if (px[(r * w + x) * 4 + 3] > 0) words[r * nw + (x >> 5)] |= 1 << (x & 31);
  return { w, h, nw, words, ox: x0 - g, oy: y0 - g };
}
// Each part placed by its true outline (its holes free for smaller parts), bottom left first, the biggest first,
// turned by any of `rotations` (degrees); cell: the raster size in mm (by default about a 700th of the sheet).
// Same result shape as nest(): [{ placed: [{ i, x, y, rot, dx, dy, w, h }], used }].
export function nestShapes(parts, { W, H, margin = 10, gap = 5, rotations = [0, 90, 180, 270], cell = null } = {}) {
  if (!(W > 0 && H > 0)) throw new Error('The sheet needs a width and a height');
  cell ||= Math.max(W, H) / 700;
  const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell), nw = Math.ceil(gw / 32);
  const masks = parts.map((p) => { const loops = outlineLoops(p.ents); if (!loops.length) throw new Error(`${p.name} has no closed outline`); return rotations.map((r) => ({ rot: r, ...partMask(loops, r, cell, gap) })); });
  const items = [];
  parts.forEach((p, i) => { for (let k = 0; k < Math.max(0, Math.round(p.qty ?? 1)); k++) items.push(i); });
  items.sort((a, b) => (parts[b].area ?? 0) - (parts[a].area ?? 0) || b - a);
  const blank = () => {
    const g = new Uint32Array(nw * gh), m = Math.max(0, Math.ceil((margin - gap / 2) / cell));
    const set = (x, y) => { g[y * nw + (x >> 5)] |= 1 << (x & 31); };
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (x < m || y < m || x >= gw - m || y >= gh - m) set(x, y);
    for (let y = 0; y < gh; y++) for (let x = gw; x < nw * 32; x++) set(x, y); // (past the sheet's right edge)
    return { grid: g, placed: [] };
  };
  const fits = (g, M, X, Y) => {
    if (X + M.w > gw || Y + M.h > gh) return false;
    const wi = X >> 5, sh = X & 31;
    for (let r = 0; r < M.h; r++) {
      const row = (Y + r) * nw, mr = r * M.nw;
      for (let k = 0; k < M.nw; k++) {
        const m = M.words[mr + k];
        if (!m) continue;
        if (g[row + wi + k] & (m << sh)) return false;
        if (sh && wi + k + 1 < nw && g[row + wi + k + 1] & (m >>> (32 - sh))) return false;
      }
    }
    return true;
  };
  const mark = (g, M, X, Y) => {
    const wi = X >> 5, sh = X & 31;
    for (let r = 0; r < M.h; r++) {
      const row = (Y + r) * nw, mr = r * M.nw;
      for (let k = 0; k < M.nw; k++) { const m = M.words[mr + k]; if (!m) continue; g[row + wi + k] |= m << sh; if (sh && wi + k + 1 < nw) g[row + wi + k + 1] |= m >>> (32 - sh); }
    }
  };
  // (the lowest place, then the leftmost, over the turns)
  const place = (s, i) => {
    let best = null;
    for (const M of masks[i]) {
      for (let Y = 0; Y + M.h <= gh && (!best || Y <= best.Y); Y++) {
        let X = 0;
        for (; X + M.w <= gw; X++) if (fits(s.grid, M, X, Y)) break;
        if (X + M.w <= gw) { if (!best || Y < best.Y || (Y === best.Y && X < best.X)) best = { M, X, Y }; break; }
      }
    }
    if (!best) return false;
    mark(s.grid, best.M, best.X, best.Y);
    const { M, X, Y } = best;
    s.placed.push({ i, x: X * cell, y: Y * cell, rot: M.rot, dx: -M.ox, dy: -M.oy, w: (M.w - 1) * cell - gap, h: (M.h - 1) * cell - gap });
    return true;
  };
  const sheets = [];
  for (const i of items) {
    if (sheets.some((s) => place(s, i))) continue;
    const s = blank(); sheets.push(s);
    if (!place(s, i)) throw new Error(`${parts[i].name} does not fit on the sheet inside its margin`);
  }
  return sheets.map((s) => ({ placed: s.placed, used: s.placed.reduce((t, q) => t + (parts[q.i].area ?? 0), 0) / (W * H) }));
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
