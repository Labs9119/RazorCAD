// Auto-dimensioning of drawing views: the dimensions a part's views need, placed round them —
//   overall sizes (width and height of each view; the depth from the next view), outermost;
//   hole diameters ("4× Ø9" for holes of one size) and arc radii;
//   hole positions (one per distinct position), in one of three styles:
//     baseline — each from the view's left / bottom edge, on rows of their own;
//     chain    — edge to the first hole, hole to hole, on one row;
//     ordinate — values from the view's bottom left corner on a row above and a column to the right;
// each size once in the drawing (a size one view shows is not repeated in another of the same part), and none
// that a dimension in the view gives already. Only views looking along the part's axes are dimensioned.
// opts: { style, tol (added to lengths and diameters, e.g. "±0.1"), spread (texts that would overlap moved
// apart), overall, holes, positions, radii (which kinds; all by default), had (a Set: the sizes the views'
// own dimensions give are added to it) }. Each new annotation's `why` (not saved): 'size' | 'd' | 'r' | 'pos'.
import * as D from './drawing.js';

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const axisOf = (v3) => { const i = [0, 1, 2].find((k) => Math.abs(Math.abs(v3[k]) - 1) < 1e-6); return i === undefined ? null : 'xyz'[i]; };
const ROW = 7, FIRST = 9, MAX_LOCS = 8;
export const AUTO_DIM_DEFAULTS = { style: 'baseline', tol: '', spread: true, overall: true, holes: true, positions: true, radii: true };

// The new annotations (without ids) for the views, in order (dimensioned first, so the front view's sizes are on
// it). done: sizes dimensioned already (it is added to).
export function autoDims(dwg, views, geos, done = new Set(), options = {}) {
  const o = { ...AUTO_DIM_DEFAULTS, ...options };
  const out = [];
  for (const v of views) {
    if (!['model', 'projected', 'section', 'aux', 'flat'].includes(v.type)) continue;
    const cam = D.viewCamera(dwg, v), ax = axisOf(cam.x), ay = axisOf(cam.y);
    if (!ax || !ay || !axisOf(cam.dir)) continue;
    const pk = D.viewPickables(dwg, v, geos);
    if (pk.points.length < 2) continue;
    const X = D.viewXform(dwg, v);
    const ns = `${v.model}|${v.type === 'flat' ? 'flat' : 'part'}`;
    // (what the view's own dimensions give already)
    const keyOf = (a) => (a.type === 'ordinate' ? `ord|${a.axis}|${r4(Math.abs(a.p[a.axis === 'y' ? 1 : 0] - a.o[a.axis === 'y' ? 1 : 0]))}` : `${a.kind}|${a.orient || ''}|${r4(D.dimValue(dwg, a))}`);
    const have = new Set(dwg.anns.filter((a) => (a.type === 'dim' || a.type === 'ordinate') && a.view === v.id).map(keyOf));
    const mine = [];
    const add = (a, key = null) => {
      const k = keyOf(a);
      if (have.has(k)) { if (key) { done.add(key); o.had?.add(key); } return false; } // (shown already: done)
      if (key && done.has(key)) return false;
      if (a.kind === 'linear' && D.dimValue(dwg, a) < 1e-6) return false;
      if (o.tol && a.type === 'dim' && (a.kind === 'linear' || a.kind === 'diameter')) a.tol = o.tol;
      have.add(k);
      if (key) done.add(key);
      Object.defineProperty(a, 'why', { value: key ? key.split('|')[2] : 'pos', enumerable: false });
      out.push(a); mine.push(a);
      return true;
    };
    const base = { type: 'dim', sheet: v.sheet, view: v.id };
    // the view's extent (view coordinates) and the points at its edges
    let lo = pk.points[0], hi = lo, bo = lo, to = lo;
    for (const q of pk.points) {
      if (q.p[0] < lo.p[0] - 1e-9) lo = q;
      if (q.p[0] > hi.p[0] + 1e-9) hi = q;
      if (q.p[1] < bo.p[1] - 1e-9) bo = q;
      if (q.p[1] > to.p[1] + 1e-9) to = q;
    }
    const Ps = pk.points.map((q) => q.P);
    const sx0 = Math.min(...Ps.map((P) => P[0])), sx1 = Math.max(...Ps.map((P) => P[0])), sy0 = Math.min(...Ps.map((P) => P[1])), sy1 = Math.max(...Ps.map((P) => P[1]));
    let rowH = 0, rowV = 0; // dimension rows used above and to the right of the view
    const hDim = (p1, p2, key, row = null) => {
      const P1 = X.toSheet(p1), P2 = X.toSheet(p2);
      if (add({ ...base, kind: 'linear', orient: 'h', p1, p2, pos: [(P1[0] + P2[0]) / 2 - v.x, sy0 - FIRST - ROW * (row ?? rowH) - v.y] }, key) && row === null) rowH++;
    };
    const vDim = (p1, p2, key, row = null) => {
      const P1 = X.toSheet(p1), P2 = X.toSheet(p2);
      if (add({ ...base, kind: 'linear', orient: 'v', p1, p2, pos: [sx1 + FIRST + ROW * (row ?? rowV) - v.x, (P1[1] + P2[1]) / 2 - v.y] }, key) && row === null) rowV++;
    };
    // holes and arcs: one dimension per size (in the view the hole is round in)
    const full = new Map(), arcs = new Map();
    for (const c of pk.circles) {
      const m = c.full ? full : arcs, k = r4(c.r);
      if (!m.has(k)) m.set(k, []);
      const list = m.get(k);
      if (!list.some((q) => Math.hypot(q.c[0] - c.c[0], q.c[1] - c.c[1]) < 1e-6)) list.push(c);
    }
    const rKey = (kind, r) => `${ns}|${kind}|${r4(r)}|${axisOf(cam.dir)}`;
    if (o.holes) for (const [r, list] of full) {
      // (the one furthest up and right takes the dimension; its leader at 45° towards the middle of the view, clear
      // of the dimensions round it; a hole in the middle: down and to the right, away from the others)
      const c = list.reduce((b, x) => (x.C[0] - x.C[1] > b.C[0] - b.C[1] ? x : b), list[0]);
      const L = c.R + 8, mx = (sx0 + sx1) / 2 - c.C[0], my = (sy0 + sy1) / 2 - c.C[1];
      const dx = Math.abs(mx) > 1e-6 ? Math.sign(mx) : 1, dy = Math.abs(my) > 1e-6 ? Math.sign(my) : 1;
      add({ ...base, kind: 'diameter', c: c.c, r, pos: [c.C[0] + L * 0.7071 * dx - v.x, c.C[1] + L * 0.7071 * dy - v.y], ...(list.length > 1 ? { prefix: `${list.length}× ` } : {}) }, rKey('d', r));
    }
    if (o.radii) for (const [r, list] of arcs) {
      const c = list[0], am = (c.a0 + c.a1) / 2 + (c.a1 < c.a0 ? Math.PI : 0);
      const dir = [Math.cos(am), Math.sin(am)], L = c.R + 6;
      add({ ...base, kind: 'radius', c: c.c, r, pos: [c.C[0] + L * dir[0] - v.x, c.C[1] - L * dir[1] - v.y], ...(list.length > 1 ? { prefix: `${list.length}× ` } : {}) }, rKey('r', r));
    }
    // hole positions (only holes inside the outline), one per distinct position
    const centres = [...full.values()].flat().filter((c) => c.c[0] - c.r > lo.p[0] + 1e-6 || c.c[0] + c.r < hi.p[0] - 1e-6);
    const xs = [...new Set(centres.map((c) => r4(c.c[0])))].filter((x) => x > lo.p[0] + 1e-6 && x < hi.p[0] - 1e-6).sort((p, q) => p - q).slice(0, MAX_LOCS);
    const ys = [...new Set(centres.map((c) => r4(c.c[1])))].filter((y) => y > bo.p[1] + 1e-6 && y < to.p[1] - 1e-6).sort((p, q) => p - q).slice(0, MAX_LOCS);
    const atX = (x) => centres.find((c) => r4(c.c[0]) === x).c, atY = (y) => centres.find((c) => r4(c.c[1]) === y).c;
    const round = [...full.values()].flat().some((c) => c.c[0] - c.r <= lo.p[0] + 1e-6 && c.c[0] + c.r >= hi.p[0] - 1e-6 && c.c[1] - c.r <= bo.p[1] + 1e-6 && c.c[1] + c.r >= to.p[1] - 1e-6);
    if (o.style === 'ordinate' && (o.positions || o.overall)) {
      // (values from the bottom left corner: a row above the view for x, a column to its right for y)
      const origin = [lo.p[0], bo.p[1]];
      const ord = (axis, p, P) => add({ type: 'ordinate', sheet: v.sheet, view: v.id, o: origin, p, axis, pos: [P[0] - v.x, P[1] - v.y] });
      const xv = [lo.p[0], ...(o.positions ? xs : []), ...(o.overall && !round ? [hi.p[0]] : [])];
      const yv = [bo.p[1], ...(o.positions ? ys : []), ...(o.overall && !round ? [to.p[1]] : [])];
      for (const x of [...new Set(xv.map(r4))]) { const p = [x, to.p[1]]; ord('x', p, [X.toSheet(p)[0], sy0 - FIRST]); }
      for (const y of [...new Set(yv.map(r4))]) { const p = [hi.p[0], y]; ord('y', p, [sx1 + FIRST, X.toSheet(p)[1]]); }
      if (o.overall && !round) { done.add(`${ns}|size|${ax}`); done.add(`${ns}|size|${ay}`); }
    } else {
      if (o.positions) {
        if (o.style === 'chain') {
          // (edge to the first hole, hole to hole: one row each way)
          let px = lo.p;
          for (const x of xs) { const c = atX(x); hDim(px, c, null, rowH); px = c; }
          if (xs.length) rowH++;
          let py = bo.p;
          for (const y of ys) { const c = atY(y); vDim(py, c, null, rowV); py = c; }
          if (ys.length) rowV++;
        } else {
          for (const x of xs) hDim(lo.p, atX(x), null);
          for (const y of ys) vDim(bo.p, atY(y), null);
        }
      }
      // overall sizes, outermost (not when the outline is a circle: its diameter gives them)
      if (o.overall) {
        if (!round) {
          hDim(lo.p, hi.p, `${ns}|size|${ax}`);
          vDim(bo.p, to.p, `${ns}|size|${ay}`);
        } else { done.add(`${ns}|size|${ax}`); done.add(`${ns}|size|${ay}`); }
      }
    }
    if (o.spread) spreadLabels(dwg, v, mine);
  }
  return out;
}

// Texts of new dimensions that would overlap moved apart: along their row (lengths on one row: the next one
// starts past the last), and diameters / radii further out along their leader.
function spreadLabels(dwg, v, mine) {
  const th = dwg.settings?.textH || 3.5, gap = 2;
  const width = (a) => D.textWidth(D.dimText(dwg, a), th);
  for (const orient of ['h', 'v']) {
    const ax = orient === 'h' ? 0 : 1, rows = new Map();
    for (const a of mine) if (a.type === 'dim' && a.kind === 'linear' && a.orient === orient) {
      const k = r4(a.pos[1 - ax]);
      if (!rows.has(k)) rows.set(k, []);
      rows.get(k).push(a);
    }
    for (const list of rows.values()) {
      list.sort((p, q) => p.pos[ax] - q.pos[ax]);
      let end = -Infinity;
      for (const a of list) {
        // (along a row going right / down the sheet: the text's extent on it, h dims by their width, v dims by
        // theirs too, as the text turns with the line)
        const w = width(a), start = a.pos[ax] - w / 2;
        if (start < end + gap) a.pos = ax ? [a.pos[0], end + gap + w / 2] : [end + gap + w / 2, a.pos[1]];
        end = a.pos[ax] + w / 2;
      }
    }
  }
  // round dimensions: further out while their text meets another one's
  const boxes = (a) => {
    // (dimensions only: a centre mark or centreline on the view has no text, nor a place for one)
    if (a.type !== 'dim' || !a.pos) return null;
    const P = D.annPos(dwg, a), w = width(a);
    if (a.kind === 'diameter' || a.kind === 'radius') return [P[0], P[1] - th, P[0] + w + 2, P[1]];
    if (a.type === 'dim' && a.kind === 'linear') return a.orient === 'v' ? [P[0] - th, P[1] - w / 2, P[0], P[1] + w / 2] : [P[0] - w / 2, P[1] - th - 1, P[0] + w / 2, P[1]];
    return null;
  };
  const meet = (b1, b2) => b1 && b2 && b1[0] < b2[2] && b2[0] < b1[2] && b1[1] < b2[3] && b2[1] < b1[3];
  const all = [...dwg.anns.filter((a) => a.view === v.id), ...mine];
  for (const a of mine) {
    if (a.type !== 'dim' || (a.kind !== 'diameter' && a.kind !== 'radius')) continue;
    const X = D.viewXform(dwg, v), C = X.toSheet(a.c);
    for (let i = 0; i < 6 && all.some((b) => b !== a && meet(boxes(a), boxes(b))); i++) {
      const P = D.annPos(dwg, a), d = [P[0] - C[0], P[1] - C[1]], L = Math.hypot(d[0], d[1]) || 1;
      a.pos = [a.pos[0] + (d[0] / L) * 5, a.pos[1] + (d[1] / L) * 5];
    }
  }
}
