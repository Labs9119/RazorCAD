// Drawings: the document (sheets, views of parts, annotations) and how a sheet is drawn.
// Everything on a sheet is turned into a display list of simple primitives (sheet millimetres,
// origin top-left, y down) that the editor shows as SVG and pdf.js writes as PDF:
//   { t: 'line', a, b, w, dash?, color? }      { t: 'poly', pts, closed?, w, dash?, color?, fill? }
//   { t: 'circle', c, r, w, dash?, color?, fill? }
//   { t: 'text', p, text, h, anchor?: start|middle|end, base?: bottom|middle|top, rot?: degrees
//     counter-clockwise, bold?, color?, fit?: max width (the text is narrowed to fit) }
//   { t: 'hatch', loops, angle, gap, w }        { t: 'clip', circle: { c, r }, prims }
// Primitives may carry `ref: { kind: 'view' | 'ann', id }` (selection).
import { paperSize, frameRect, formatPrims, titleBlockRect, LW, hatchStyle } from './drawingformats.js';
import { fontMetrics } from './fonts.js';
import { bomRows, bomCell, bomTotals } from './bom.js';

export const DRAWING_EXT = '.rdrw';
const DASH_HIDDEN = [2.4, 1.2];
const DASH_CENTER = [8, 1.5, 1.2, 1.5];
const DASH_PHANTOM = [10, 1.5, 1.2, 1.5, 1.2, 1.5]; // (long, short, short: an alternate position)

export const ORIENTATIONS = {
  front: { label: 'Front', dir: [0, 0, 1], up: [0, 1, 0] },
  back: { label: 'Back', dir: [0, 0, -1], up: [0, 1, 0] },
  top: { label: 'Top', dir: [0, 1, 0], up: [0, 0, -1] },
  bottom: { label: 'Bottom', dir: [0, -1, 0], up: [0, 0, 1] },
  right: { label: 'Right', dir: [1, 0, 0], up: [0, 1, 0] },
  left: { label: 'Left', dir: [-1, 0, 0], up: [0, 1, 0] },
  iso: { label: 'Isometric', dir: [1, 1, 1], up: [0, 1, 0] },
  dimetric: { label: 'Dimetric', dir: [1, 0.62, 1], up: [0, 1, 0] },
  trimetric: { label: 'Trimetric', dir: [1.25, 0.8, 1.9], up: [0, 1, 0] },
};
export const STANDARD_SCALES = [[1, 1], [1, 2], [1, 2.5], [1, 5], [1, 10], [1, 20], [1, 50], [1, 100], [2, 1], [5, 1], [10, 1], [20, 1]];

// ------------------------------------------------------------ document
export function newDrawing(name = 'Drawing1') {
  return {
    kind: 'drawing', version: 1, name,
    props: { title: '', number: '', material: '', finish: '', drawnBy: '', checkedBy: '', approvedBy: '', date: new Date().toISOString().slice(0, 10), company: '', revision: 'A', tolerance: 'ISO 2768-m', mass: '' },
    settings: { textH: 3.5, decimals: 2, trimZeros: true, arrow: 3, hatchGap: 2.5 },
    sheets: [{ id: 's1', name: 'Sheet1', size: 'A3', orientation: 'landscape', scale: [1, 1], projection: 'first' }],
    models: [], // [{ id, name, path, doc }] the parts drawn (a copy of each part is kept in the drawing)
    views: [],
    anns: [],
    nextId: 1,
  };
}

export const isDrawing = (doc) => doc?.kind === 'drawing' && Array.isArray(doc.sheets);
export const newId = (dwg, prefix) => `${prefix}${dwg.nextId++}`;
export const findView = (dwg, id) => dwg.views.find((v) => v.id === id) || null;
export const sheetOf = (dwg, id) => dwg.sheets.find((s) => s.id === id) || dwg.sheets[0];

// ------------------------------------------------------------ small vector helpers
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const neg3 = (a) => [-a[0], -a[1], -a[2]];
const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add2 = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul2 = (a, k) => [a[0] * k, a[1] * k];
const len2 = (a) => Math.hypot(a[0], a[1]);
const unit2 = (a) => { const l = len2(a) || 1; return [a[0] / l, a[1] / l]; };
const perp2 = (a) => [-a[1], a[0]];
const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];

// ------------------------------------------------------------ views
// The view's camera: { dir (toward the viewer), up, x, y } (3D unit vectors; x, y = the view's axes).
export function viewCamera(dwg, v, depth = 0) {
  let dir, up;
  if (v.type === 'flat') return camFrom([0, 0, 1], [0, 1, 0]);
  // (a view broken from its parent: the direction it had then)
  if (v.free && v.cam) return camFrom(v.cam.dir, v.cam.up);
  if (v.type === 'model') {
    const o = ORIENTATIONS[v.orient] || ORIENTATIONS.front;
    dir = v.dir || o.dir; up = v.up || o.up;
  } else {
    const p = findView(dwg, v.parent);
    if (!p || depth > 20) return camFrom([0, 0, 1], [0, 1, 0]);
    const pc = viewCamera(dwg, p, depth + 1);
    if (v.type === 'detail') return pc;
    if (v.type === 'aux') {
      // auxiliary view: looking square at an edge of the parent view (e: the edge direction, n: the side
      // the view was placed on, both in the parent's view coordinates); the edge stays along the view's x
      const e3 = unit3(add3(mul3(pc.x, v.aux.e[0]), mul3(pc.y, v.aux.e[1])));
      const n3 = unit3(add3(mul3(pc.x, v.aux.n[0]), mul3(pc.y, v.aux.n[1])));
      dir = sheetOf(dwg, v.sheet).projection === 'third' ? n3 : neg3(n3);
      return camFrom(dir, cross3(dir, e3));
    }
    if (v.type === 'projected') {
      // the side of the parent it was placed on; third angle shows that side, first angle the opposite
      const q = { right: pc.x, left: neg3(pc.x), up: pc.y, down: neg3(pc.y) }[v.side] || pc.x;
      const proj = sheetOf(dwg, v.sheet).projection;
      dir = proj === 'third' ? q : neg3(q);
      up = v.side === 'up' || v.side === 'down' ? cross3(dir, pc.x) : pc.y;
    } else if (v.type === 'section') {
      const s = v.section;
      // the cutting line (parent view coordinates) and the direction its arrows point
      const ad = s.arrow; // 2D, perpendicular to the line
      const arrow3 = unit3(add3(mul3(pc.x, ad[0]), mul3(pc.y, ad[1])));
      dir = neg3(arrow3);
      if (s.angle != null) {
        // (a cutting line at an angle: the view up along it when it runs more up than across, else square to it)
        const t = (s.angle * Math.PI) / 180, L3 = unit3(add3(mul3(pc.x, Math.cos(t)), mul3(pc.y, Math.sin(t))));
        up = Math.abs(Math.cos(t)) >= Math.abs(Math.sin(t)) ? cross3(dir, L3) : L3;
      } else up = s.horizontal ? cross3(dir, pc.x) : pc.y;
    }
  }
  return camFrom(dir, up);
}
function camFrom(dir, up) {
  const d = unit3(dir);
  let x = cross3(up, d);
  if (Math.hypot(...x) < 1e-9) x = cross3([0, 0, 1], d);
  x = unit3(x);
  return { dir: d, up: up, x, y: cross3(d, x) };
}

// The section plane of a section view (3D): { o, n } (n points to the side that is removed).
export function sectionPlane(dwg, v) {
  if (v.plane) return v.plane; // (broken from its parent: the cut it had then)
  const p = findView(dwg, v.parent);
  const pc = viewCamera(dwg, p);
  const a = v.section.a;
  const o = add3(mul3(pc.x, a[0]), mul3(pc.y, a[1]));
  const cam = viewCamera(dwg, v);
  return { o, n: cam.dir };
}

// The request sent to the kernel for a view's lines (detail views use their parent's).
export function viewRequest(dwg, v) {
  if (v.type === 'detail') return null;
  if (v.type === 'flat') return { id: v.id, flat: true, body: v.body || null, dir: [0, 0, 1], up: [0, 1, 0] };
  const cam = viewCamera(dwg, v);
  return { id: v.id, dir: cam.dir, up: cam.y, section: v.type === 'section' ? sectionPlane(dwg, v) : null, ...(v.breakout ? { breakout: v.breakout } : {}) };
}

export const sheetScale = (dwg, sheetId) => { const s = sheetOf(dwg, sheetId).scale || [1, 1]; return s[0] / s[1]; };
// A view's scale. The views made from a view (projected, section, auxiliary) share its scale: the scale is kept
// on the first view of the family (scaleOwner), its own or the sheet's. A detail view has a scale of its own.
export function viewScale(dwg, v) {
  if (v.type === 'detail') {
    if (v.scale) return v.scale[0] / v.scale[1];
    const p = findView(dwg, v.parent); return (p ? viewScale(dwg, p) : 1) * 2;
  }
  const o = scaleOwner(dwg, v);
  return o.scale ? o.scale[0] / o.scale[1] : sheetScale(dwg, o.sheet);
}
// (views that take their scale and place from their parent)
const FOLLOWS = new Set(['projected', 'section', 'aux']);
const follows = (v) => FOLLOWS.has(v.type) && !v.free && !!v.parent;
// The view whose scale v shows: the first of its family (a model or flat view, or a view broken from its parent).
export function scaleOwner(dwg, v) {
  let x = v;
  for (let i = 0; i < 30 && follows(x); i++) { const p = findView(dwg, x.parent); if (!p || p.type === 'detail') break; x = p; }
  return x;
}
// The views that share the owner's scale, the owner first and each view before the views made from it.
export function scaleFamily(dwg, owner) {
  const out = [owner];
  for (let i = 0; i < out.length; i++) for (const c of dwg.views) if (c.parent === out[i].id && follows(c) && !out.includes(c)) out.push(c);
  return out;
}

// Make a view made from another one (projected, section, auxiliary) independent of it, as it is: it keeps its
// direction, cut, scale and place, and no longer moves with its parent or takes its scale. A projected view becomes
// a model view of its own; a section or auxiliary view keeps its parent only for the cutting line or arrow drawn on it.
// Its own projected and section views go with it.
export function breakFromParent(dwg, v) {
  if (!follows(v)) return false;
  const cam = viewCamera(dwg, v), o = scaleOwner(dwg, v);
  const scale = o.scale ? [...o.scale] : o.sheet !== v.sheet ? scaleOf(viewScale(dwg, v)) : null;
  if (v.type === 'section') v.plane = sectionPlane(dwg, v);
  if (v.type === 'projected') {
    const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6;
    const key = Object.keys(ORIENTATIONS).find((k) => { const c = camFrom(ORIENTATIONS[k].dir, ORIENTATIONS[k].up); return near(c.dir, cam.dir) && near(c.y, cam.y); });
    v.type = 'model'; v.orient = key || 'front';
    if (!key) { v.dir = cam.dir; v.up = cam.y; }
    delete v.parent; delete v.side;
  } else { v.free = true; v.cam = { dir: cam.dir, up: cam.y }; }
  v.scale = scale;
  return true;
}
const scaleOf = (k) => (k >= 1 ? [+k.toFixed(4), 1] : [1, +(1 / k).toFixed(4)]);

// Drawings saved before a family shared its scale: a view made from another with a scale of its own that differs
// from its family's is broken from its parent (it looks as it did); one with the same scale just follows it.
export function upgradeViewScales(dwg) {
  for (const v of dwg.views) {
    if (!follows(v) || !v.scale) continue;
    const own = v.scale[0] / v.scale[1], o = scaleOwner(dwg, v);
    const fam = o.scale ? o.scale[0] / o.scale[1] : sheetScale(dwg, o.sheet);
    if (Math.abs(own - fam) < 1e-9) { v.scale = null; continue; }
    const keep = [...v.scale]; breakFromParent(dwg, v); v.scale = keep;
  }
}
export const scaleText = (k) => {
  if (k >= 1) return `${+k.toFixed(3)}:1`;
  return `1:${+(1 / k).toFixed(3)}`;
};

// View coordinates (model mm) -> sheet mm and back. (x, y) on the sheet is where the view's
// origin is (a detail view: where its centre is).
// v.rot: the view turned on the sheet (degrees, counter-clockwise). ax / ay: the view's x and y axes on the sheet.
export const BREAK_GAP = 6;
export function viewXform(dwg, v) {
  const s = viewScale(dwg, v);
  const o = v.type === 'detail' ? v.detail.c : [0, 0];
  const r = ((v.rot || 0) * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
  // a broken view: the part between brk.a and brk.b (along brk.axis, view coordinates) is left out and the
  // far side moved up to a gap of BREAK_GAP mm on the sheet
  const B = v.brk && v.type !== 'detail' ? v.brk : null, ix = B?.axis === 'y' ? 1 : 0;
  const shift = B ? B.b - B.a - BREAK_GAP / s : 0;
  const close = (p) => { if (!B || p[ix] <= B.a) return p; const q = [...p]; q[ix] = p[ix] >= B.b ? p[ix] - shift : B.a; return q; };
  const open = (p) => { if (!B || p[ix] <= B.a + BREAK_GAP / s / 2) return p; const q = [...p]; q[ix] = p[ix] + shift; return q; };
  return {
    s, rot: v.rot || 0, brk: B,
    ax: [c, -sn], ay: [-sn, -c],
    toSheet: (p0) => {
      const p = close(p0);
      const dx = p[0] - o[0], dy = p[1] - o[1];
      return [v.x + (dx * c - dy * sn) * s, v.y - (dx * sn + dy * c) * s];
    },
    toView: (P) => {
      const rx = (P[0] - v.x) / s, ry = -(P[1] - v.y) / s;
      return open([o[0] + rx * c + ry * sn, o[1] - rx * sn + ry * c]);
    },
  };
}

// The geometry shown in a view (detail views: their parent's, clipped later).
export function viewGeom(dwg, v, geos) {
  if (v.type === 'detail') { const p = findView(dwg, v.parent); return p ? geos.get(p.id) : null; }
  return geos.get(v.id) || null;
}

// The view's rectangle on the sheet (for selecting, labels, placing).
export function viewRect(dwg, v, geos) {
  const g = viewGeom(dwg, v, geos);
  const X = viewXform(dwg, v);
  if (v.type === 'detail') {
    const r = v.detail.r * X.s, c = X.toSheet(v.detail.c);
    return { x0: c[0] - r, y0: c[1] - r, x1: c[0] + r, y1: c[1] + r };
  }
  if (!g || !g.box || !isFinite(g.box.min[0])) return { x0: v.x - 10, y0: v.y - 10, x1: v.x + 10, y1: v.y + 10 };
  const bx = v.crop ? { min: [Math.max(g.box.min[0], v.crop.x0), Math.max(g.box.min[1], v.crop.y0)], max: [Math.min(g.box.max[0], v.crop.x1), Math.min(g.box.max[1], v.crop.y1)] } : g.box;
  const pts = [bx.min, [bx.max[0], bx.min[1]], bx.max, [bx.min[0], bx.max[1]]].map(X.toSheet);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

// Views aligned with another move along one axis only: projected and section views stay in line
// with their parent. Returns 'x' (moves horizontally only), 'y' or null (free).
export function alignAxis(v) {
  if (v.free) return null;
  if (v.type === 'projected') return v.side === 'up' || v.side === 'down' ? 'y' : 'x';
  if (v.type === 'section') return v.section.angle != null ? null : v.section.horizontal ? 'y' : 'x';
  return null;
}
// Children that stay aligned with v (they move with it).
export const alignedChildren = (dwg, v) => dwg.views.filter((c) => c.parent === v.id && alignAxis(c));

// Move a view by (dx, dy) on the sheet; aligned children follow; an aligned view only slides along its axis.
export function moveView(dwg, v, dx, dy, top = true) {
  const ax = top ? alignAxis(v) : null;
  if (ax === 'x') dy = 0;
  if (ax === 'y') dx = 0;
  v.x += dx; v.y += dy;
  for (const c of alignedChildren(dwg, v)) moveView(dwg, c, dx, dy, false);
  // detail views keep their place
}

// After a sheet's projection changes (first <-> third angle), lay the views out as the new projection
// would: a view above or below its parent goes to the other side (mirrored about the parent's centre),
// so a top view stays a top view (below the front in first angle, above it in third); a view beside its
// parent stays where it is and shows the side the new projection puts there (both put the side view on
// the right). Views aligned with a moved view (sections, its own projected views) move with it; detail
// views keep their place. before: Map(view id -> viewRect) from before the change.
export function flipProjectedViews(dwg, sheetId, before) {
  const FLIP = { up: 'down', down: 'up' };
  const centre = (r) => [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];
  const shift = new Map(); // view id -> [dx, dy] it was moved by
  const todo = dwg.views.filter((v) => v.sheet === sheetId && v.parent && alignAxis(v));
  for (let pass = 0; todo.length && pass < 30; pass++) {
    for (let i = todo.length - 1; i >= 0; i--) {
      const v = todo[i], p = findView(dwg, v.parent);
      // parents first (a parent still to be done: wait for it)
      if (p && todo.includes(p)) continue;
      todo.splice(i, 1);
      const ps = (p && shift.get(p.id)) || [0, 0];
      let d = [...ps];
      if (v.type === 'projected' && FLIP[v.side] && p && p.sheet === sheetId && before.get(v.id) && before.get(p.id)) {
        const cv = centre(before.get(v.id)), cp = centre(before.get(p.id));
        d = [ps[0], ps[1] + (cp[1] - (cv[1] - cp[1])) - cv[1]];
        v.side = FLIP[v.side];
      }
      v.x += d[0]; v.y += d[1];
      shift.set(v.id, d);
    }
  }
  // the views as a whole stay centred where they were (a view moved over the front can't run off the sheet)
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const v of dwg.views.filter((x) => x.sheet === sheetId)) {
    const r = before.get(v.id);
    if (!r) continue;
    const dy = shift.get(v.id)?.[1] || 0;
    a0 = Math.min(a0, r.y0); a1 = Math.max(a1, r.y1); b0 = Math.min(b0, r.y0 + dy); b1 = Math.max(b1, r.y1 + dy);
  }
  const dy = isFinite(a0) ? (a0 + a1) / 2 - (b0 + b1) / 2 : 0;
  if (Math.abs(dy) > 1e-6) for (const v of dwg.views.filter((x) => x.sheet === sheetId)) v.y += dy;
}

// Next free letter for section / detail views.
export function nextLetter(dwg) {
  const used = new Set(dwg.views.map((v) => v.section?.letter || v.detail?.letter || v.aux?.letter).filter(Boolean));
  for (const c of 'ABCDEFGHJKLMNPRSTUVWXYZ') if (!used.has(c)) return c;
  return 'Z';
}

export function viewTitle(v) {
  if (v.type === 'flat') return 'FLAT PATTERN';
  if (v.type === 'aux') return `VIEW ${v.aux?.letter || ''}`;
  if (v.type === 'section') return `SECTION ${v.section.letter}-${v.section.letter}`;
  if (v.type === 'detail') return `DETAIL ${v.detail.letter}`;
  return null;
}

// ------------------------------------------------------------ numbers
// A length (mm) in the drawing's unit (settings.units: 'mm' or 'in'), as fmtNum formats it.
export function fmtLen(x, dwg) {
  return fmtNum(dwg.settings?.units === 'in' ? x / 25.4 : x, dwg);
}
export const unitName = (dwg) => (dwg.settings?.units === 'in' ? 'in' : 'mm');

export function fmtNum(x, dwg) {
  const d = dwg.settings?.decimals ?? 2;
  let s = (Math.round(x * 10 ** d) / 10 ** d).toFixed(d);
  if (dwg.settings?.trimZeros !== false && s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

// Helvetica widths (1/1000 em), ASCII 32..126, and the cap height (to size text by its capital height).
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELV_B = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const EXTRA_W = { '°': 400, '±': 584, 'Ø': 778, '×': 584, '²': 333, '³': 333, 'µ': 556, '·': 278, '–': 556, '—': 1000 };
export const CAP = 0.718;
// font: a family from fonts.js (text prims' p.font); measured as Helvetica until it is loaded
export function textWidth(s, h, bold = false, font = null) {
  const m = fontMetrics(font, bold);
  if (m) { let w = 0; for (const ch of String(s)) w += m.width(ch); return (w / 1000) * (h / m.cap); }
  const tbl = bold ? HELV_B : HELV;
  let w = 0;
  for (const ch of String(s)) { const c = ch.charCodeAt(0); w += c >= 32 && c <= 126 ? tbl[c - 32] : EXTRA_W[ch] || 556; }
  return (w / 1000) * (h / CAP);
}
// The share of the font size a capital letter takes (text is sized by its cap height).
export const capOf = (font, bold = false) => fontMetrics(font, bold)?.cap || CAP;

// ------------------------------------------------------------ drawing a sheet
// ctx: { geos: Map(viewId -> geometry), selected: Set of ids, hover: id, models: Map(id -> name) }
export function sheetPrims(dwg, sheet, ctx) {
  const P = [];
  const idx = dwg.sheets.indexOf(sheet);
  P.push(...formatPrims(sheet, {
    props: dwg.props, scaleText: scaleText(sheetScale(dwg, sheet.id)), sheetNo: idx + 1, sheetCount: dwg.sheets.length,
    projection: sheet.projection, sizeName: sheet.size, format: dwg.format, units: unitName(dwg),
  }));
  const views = dwg.views.filter((v) => v.sheet === sheet.id);
  for (const v of views) P.push(...viewPrims(dwg, v, ctx));
  for (const a of dwg.anns.filter((x) => x.sheet === sheet.id)) {
    const color = ctx.selected?.has(a.id) ? SEL : ctx.hover === a.id ? HOV : null;
    let prims = [];
    try { prims = annPrims(dwg, a, ctx); } catch { prims = []; }
    for (const p of prims) { p.ref = { kind: 'ann', id: a.id }; if (color) p.color = color; }
    P.push(...prims);
  }
  return P;
}
export const SEL = '#1f6fd6', HOV = '#e8892c';

function viewPrims(dwg, v, ctx) {
  const out = [];
  const g = viewGeom(dwg, v, ctx.geos);
  const X = viewXform(dwg, v);
  const color = ctx.selected?.has(v.id) ? SEL : ctx.hover === v.id ? HOV : null;
  const ref = { kind: 'view', id: v.id };
  const style = v.style || 'hlr';
  const tangent = v.tangent !== false;
  const geomPrims = [];
  if (g) {
    for (const { k, g: e } of g.edges) {
      let w, dash = null;
      if (k === 'v') w = LW.visible;
      else if (k === 'bu' || k === 'bd') { if (v.bendLines === false) continue; w = LW.thin; dash = DASH_CENTER; }
      else if (k === 'br') { if (!v.bendRegion) continue; w = LW.thin; dash = DASH_HIDDEN; }
      else if (k === 'fm') { if (v.bendLines === false) continue; w = LW.thin; dash = DASH_CENTER; }
      else if (k === 'et') { if (v.etch === false) continue; w = LW.thin; }
      else if (k === 't') { if (!tangent) continue; w = LW.thin; }
      else if (k === 'th' || k === 'thd') { if (v.threads === false) continue; w = LW.thin; dash = k === 'thd' ? DASH_HIDDEN : null; }
      else if (k === 'h' || k === 'ht') {
        if (style === 'hlr' || (k === 'ht' && !tangent)) continue;
        w = style === 'wire' ? LW.thin : LW.thin; dash = style === 'wire' ? null : DASH_HIDDEN;
      } else continue;
      if (X.brk) geomPrims.push(...brokenEdgePrims(e, X, w, dash));
      else geomPrims.push(edgePrim(e, X, w, dash));
    }
    // an alternate position of an assembly: its visible (and tangent) edges in thin phantom lines
    const ga = v.altPos ? ctx.geos.get(v.id + '~alt') : null;
    if (ga?.edges) for (const { k, g: e } of ga.edges) if (k === 'v' || (k === 't' && tangent)) geomPrims.push(...(X.brk ? brokenEdgePrims(e, X, LW.thin, DASH_PHANTOM) : [edgePrim(e, X, LW.thin, DASH_PHANTOM)]));
    // break lines across the gap
    if (X.brk && g.box) {
      const B = X.brk, ix = B.axis === 'y' ? 1 : 0, jx = 1 - ix, lo = g.box.min[jx] - 2 / X.s, hi = g.box.max[jx] + 2 / X.s;
      for (const at of [B.a, B.a + BREAK_GAP / X.s]) {
        const pts = [];
        for (let i = 0; i <= 24; i++) {
          const t = lo + ((hi - lo) * i) / 24, q = [0, 0];
          q[jx] = t; q[ix] = at + Math.sin((i / 24) * Math.PI * 6) * (1.2 / X.s);
          pts.push(q);
        }
        // (points past the gap are already in their closed-up place: map them without the shift)
        geomPrims.push({ t: 'poly', pts: pts.map((q) => { const X0 = viewXform(dwg, { ...v, brk: null }); return X0.toSheet(q); }), w: LW.thin });
      }
    }
    // flat pattern with a bend table: each bend line numbered, the table under the view
    if (v.type === 'flat' && v.bendTable && v.bendLines !== false && (g.notes || []).length) {
      const h = (dwg.settings?.textH || 3.5) * 0.75;
      for (const n of g.notes) {
        const rad = (n.rot * Math.PI) / 180;
        const P0 = X.toSheet(n.p), P1 = X.toSheet([n.p[0] - Math.sin(rad), n.p[1] + Math.cos(rad)]);
        const off = unit2(sub2(P1, P0));
        geomPrims.push({ t: 'text', p: add2(P0, mul2(off, 1)), text: 'B' + n.n, h, anchor: 'middle', base: 'bottom', rot: 0 });
      }
      // the table: below the view's lowest point, from its left edge
      let x0 = Infinity, y0 = -Infinity;
      for (const pm of geomPrims) for (const q of pm.t === 'line' ? [pm.a, pm.b] : pm.t === 'poly' ? pm.pts : pm.t === 'circle' ? [[pm.c[0] - pm.r, pm.c[1] + pm.r]] : []) { x0 = Math.min(x0, q[0]); y0 = Math.max(y0, q[1]); }
      if (Number.isFinite(x0)) {
        const cols = [['BEND', 14], ['DIRECTION', 22], ['ANGLE', 18], ['INSIDE R', 20]], rh = h * 2;
        const W = cols.reduce((s2v, c) => s2v + c[1], 0), rows = [cols.map((c) => c[0]), ...g.notes.map((n) => ['B' + n.n, n.up ? 'UP' : 'DOWN', `${+(+n.deg).toFixed(2)}°`, `R${+(+n.R).toFixed(3)}`])];
        const top = y0 + h * 2.5;
        for (let r = 0; r <= rows.length; r++) geomPrims.push({ t: 'line', a: [x0, top + r * rh], b: [x0 + W, top + r * rh], w: LW.thin });
        let cx = x0;
        for (let c = 0; c <= cols.length; c++) { geomPrims.push({ t: 'line', a: [cx, top], b: [cx, top + rows.length * rh], w: LW.thin }); if (c < cols.length) cx += cols[c][1]; }
        rows.forEach((row, r) => {
          let x = x0;
          row.forEach((text, c) => { geomPrims.push({ t: 'text', p: [x + cols[c][1] / 2, top + r * rh + rh * 0.7], text, h: r ? h : h * 0.9, anchor: 'middle', base: 'bottom', rot: 0 }); x += cols[c][1]; });
        });
      }
    }
    // flat pattern: bend notes along the bend lines
    if (v.type === 'flat' && !v.bendTable && v.bendNotes !== false && v.bendLines !== false) {
      const h = (dwg.settings?.textH || 3.5) * 0.75;
      for (const n of g.notes || []) {
        const tw = textWidth(n.text, h);
        if (n.len * X.s < tw + 2) continue;
        const rad = (n.rot * Math.PI) / 180;
        const P0 = X.toSheet(n.p), P1 = X.toSheet([n.p[0] - Math.sin(rad), n.p[1] + Math.cos(rad)]);
        const off = unit2(sub2(P1, P0));
        // keep the note readable when the view is turned (upside-down text is turned round; it stays on the same side of the line)
        let rot = n.rot + (v.rot || 0), turned = false;
        rot = ((rot % 360) + 540) % 360 - 180;
        if (rot > 90.001) { rot -= 180; turned = true; } else if (rot <= -89.999) { rot += 180; turned = true; }
        geomPrims.push({ t: 'text', p: add2(P0, mul2(off, 1)), text: n.text, h, anchor: 'middle', base: turned ? 'top' : 'bottom', rot });
      }
    }
    // a broken-out section's outline: a thin freehand line
    if (v.breakout?.poly?.length >= 3) geomPrims.push({ t: 'poly', pts: [...v.breakout.poly, v.breakout.poly[0]].map(X.toSheet), w: LW.thin });
    // section hatching (and a broken-out section's)
    if ((v.type === 'section' || v.breakout) && g.cut?.length) {
      // (each body its own angle and spacing)
      g.cut.forEach((loops, i) => {
        const hs = hatchStyle(g.cutBody?.[i] ?? 0);
        geomPrims.push({ t: 'hatch', loops: loops.map((l) => l.map(X.toSheet)), angle: hs.angle, gap: (dwg.settings?.hatchGap || 2.5) * hs.mult, w: LW.hatch });
      });
    }
  }
  if (v.type === 'detail') {
    const c = X.toSheet(v.detail.c), r = v.detail.r * X.s;
    out.push({ t: 'clip', circle: { c, r }, prims: geomPrims });
    out.push({ t: 'circle', c, r, w: LW.thin });
  } else if (v.crop) {
    // a cropped view: only what lies inside its rectangle
    const cs = [[v.crop.x0, v.crop.y0], [v.crop.x1, v.crop.y0], [v.crop.x1, v.crop.y1], [v.crop.x0, v.crop.y1]].map(X.toSheet);
    out.push({ t: 'clip', poly: cs, prims: geomPrims });
  } else out.push(...geomPrims);
  // section lines and detail circles of the views made from this one
  for (const c of dwg.views.filter((x) => x.parent === v.id)) {
    if (c.type === 'section') out.push(...sectionLinePrims(dwg, v, c, X));
    if (c.type === 'detail') out.push(...detailCirclePrims(dwg, c, X));
  }
  // title under the view
  const title = viewTitle(v);
  if (title && v.showLabel !== false) {
    const r = viewRect(dwg, v, ctx.geos);
    const h = (dwg.settings?.textH || 3.5) * 1.4;
    out.push({ t: 'text', p: [(r.x0 + r.x1) / 2, r.y1 + 4 + h], text: title, h, anchor: 'middle', base: 'bottom', bold: true });
    if (v.type === 'flat' && g?.flat) {
      const f = g.flat;
      out.push({ t: 'text', p: [(r.x0 + r.x1) / 2, r.y1 + 4 + h + 5], text: `${fmtLen(f.size[0], dwg)} × ${fmtLen(f.size[1], dwg)} ${unitName(dwg)}  ·  t ${fmtLen(f.t, dwg)}  ·  ${f.bends} bend${f.bends === 1 ? '' : 's'}${f.cut && v.cutInfo !== false ? `  ·  cut ${fmtLen(f.cut.length, dwg)} ${unitName(dwg)}, ${f.cut.loops} pierce${f.cut.loops === 1 ? '' : 's'}` : ''}`, h: dwg.settings?.textH || 3.5, anchor: 'middle', base: 'bottom' });
    }
    const k = viewScale(dwg, v);
    if (v.type === 'detail' || Math.abs(k - sheetScale(dwg, v.sheet)) > 1e-9) out.push({ t: 'text', p: [(r.x0 + r.x1) / 2, r.y1 + 4 + h + (v.type === 'flat' ? 10 : 5)], text: `SCALE ${scaleText(k)}`, h: dwg.settings?.textH || 3.5, anchor: 'middle', base: 'bottom' });
  } else if (v.type !== 'detail' && v.scale && Math.abs(viewScale(dwg, v) - sheetScale(dwg, v.sheet)) > 1e-9 && v.showLabel !== false) {
    const r = viewRect(dwg, v, ctx.geos);
    out.push({ t: 'text', p: [(r.x0 + r.x1) / 2, r.y1 + 8], text: `SCALE ${scaleText(viewScale(dwg, v))}`, h: dwg.settings?.textH || 3.5, anchor: 'middle', base: 'bottom' });
  }
  if (!g && v.type !== 'detail') {
    out.push({ t: 'text', p: [v.x, v.y], text: ctx.errors?.get(v.id) ? `(${ctx.errors.get(v.id)})` : '(updating view…)', h: 2.5, anchor: 'middle', base: 'middle', color: '#8a94a6' });
  }
  for (const p of out) { p.ref = ref; if (color) p.color = color; }
  return out;
}

// A kernel edge in a broken view: as polylines, without the part inside the break.
function brokenEdgePrims(e, X, w, dash) {
  const B = X.brk, ix = B.axis === 'y' ? 1 : 0;
  let pts;
  if (e.t === 'l') pts = [e.a, e.b];
  else if (e.t === 'c') pts = arcPts(e.c, e.r, 0, 2 * Math.PI);
  else if (e.t === 'a') pts = arcPts(e.c, e.r, e.a0, e.a1);
  else pts = e.pts;
  const runs = [];
  let cur = [];
  const flush = () => { if (cur.length > 1) runs.push(cur); cur = []; };
  const inGap = (q) => q[ix] > B.a + 1e-9 && q[ix] < B.b - 1e-9;
  for (let i = 0; i < pts.length; i++) {
    const q = pts[i];
    if (i) {
      const p = pts[i - 1];
      // split the segment where it crosses the break's ends
      const ts = [B.a, B.b].map((x) => (q[ix] - p[ix] !== 0 ? (x - p[ix]) / (q[ix] - p[ix]) : -1)).filter((t) => t > 1e-9 && t < 1 - 1e-9).sort((x, y) => x - y);
      for (const t of ts) {
        const m = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        const mid = [p[0] + (m[0] - p[0]) / 2, p[1] + (m[1] - p[1]) / 2];
        if (!inGap(mid)) cur.push(m);
        flush();
        cur.push(m);
      }
    }
    if (inGap(q)) { flush(); continue; }
    if (cur.length && inGap([(cur[cur.length - 1][0] + q[0]) / 2, (cur[cur.length - 1][1] + q[1]) / 2])) flush();
    cur.push(q);
  }
  flush();
  return runs.map((r) => ({ t: 'poly', pts: r.map(X.toSheet), w, dash }));
}

// A kernel edge (view coordinates) as a primitive on the sheet.
function edgePrim(e, X, w, dash) {
  if (e.t === 'l') return { t: 'line', a: X.toSheet(e.a), b: X.toSheet(e.b), w, dash };
  if (e.t === 'c') return { t: 'circle', c: X.toSheet(e.c), r: e.r * X.s, w, dash };
  if (e.t === 'a') return { t: 'poly', pts: arcPts(e.c, e.r, e.a0, e.a1).map(X.toSheet), w, dash };
  return { t: 'poly', pts: e.pts.map(X.toSheet), w, dash };
}
export function arcPts(c, r, a0, a1) {
  let span = a1 - a0;
  while (span <= 0) span += 2 * Math.PI;
  const n = Math.max(6, Math.min(180, Math.ceil(span / (Math.PI / 90))));
  const pts = [];
  for (let i = 0; i <= n; i++) { const t = a0 + (span * i) / n; pts.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); }
  return pts;
}

// The cutting line of section view c drawn on its parent (view transform X of the parent).
function sectionLinePrims(dwg, parent, c, X) {
  const s = c.section, out = [];
  const a = X.toSheet(s.a), b = X.toSheet(s.b);
  const d = unit2(sub2(b, a));
  // arrow direction on the sheet (view y is up, sheet y is down)
  const ar = unit2([s.arrow[0], -s.arrow[1]]);
  out.push({ t: 'line', a, b, w: LW.thin, dash: DASH_CENTER });
  // thick ends
  out.push({ t: 'line', a, b: add2(a, mul2(d, 6)), w: LW.thick }, { t: 'line', a: b, b: add2(b, mul2(d, -6)), w: LW.thick });
  const th = dwg.settings?.textH || 3.5, L = 8;
  for (const e of [a, b]) {
    const tip = add2(e, mul2(ar, 0.6)), tail = add2(e, mul2(ar, L));
    out.push({ t: 'line', a: tail, b: tip, w: LW.thin });
    out.push(arrowHead(tip, mul2(ar, -1), dwg));
    out.push({ t: 'text', p: add2(add2(e, mul2(ar, L + 1.5 + th / 2)), mul2(d, 0)), text: s.letter, h: th * 1.4, anchor: 'middle', base: 'middle', bold: true });
  }
  return out;
}
function detailCirclePrims(dwg, c, X) {
  const ctr = X.toSheet(c.detail.c), r = c.detail.r * X.s, th = dwg.settings?.textH || 3.5;
  const ang = -Math.PI / 4;
  const p = add2(ctr, [Math.cos(ang) * (r + th * 1.4), Math.sin(ang) * (r + th * 1.4)]);
  return [{ t: 'circle', c: ctr, r, w: LW.thin }, { t: 'text', p, text: c.detail.letter, h: th * 1.4, anchor: 'middle', base: 'middle', bold: true }];
}

// A filled arrowhead with its tip at `tip`, pointing along unit vector d.
export function arrowHead(tip, d, dwg) {
  const L = dwg.settings?.arrow || 3, W = L / 3;
  const u = unit2(d), n = perp2(u);
  const base = sub2(tip, mul2(u, L));
  return { t: 'poly', pts: [tip, add2(base, mul2(n, W / 2)), sub2(base, mul2(n, W / 2))], closed: true, w: LW.thin, fill: true };
}

// ------------------------------------------------------------ annotations
// Points of annotations that belong to a view are stored in that view's coordinates, so they move
// with the view; `pos` (where the text is) is stored relative to the view's origin on the sheet.
//   dim linear: { kind: 'linear', view, p1, p2, orient: 'h' | 'v' | 'a', pos }
//   dim diameter / radius: { kind, view, c, r, pos }      dim angle: { kind: 'angle', view, l1, l2, pos }
//   note: { type: 'note', text, pos, view?, leader?: point (view coordinates) }
//   center mark: { type: 'cmark', view, c, r }           centerline: { type: 'cline', view, a, b }
export function annPos(dwg, a) {
  const v = a.view ? findView(dwg, a.view) : null;
  return v ? [v.x + a.pos[0], v.y + a.pos[1]] : a.pos;
}
export function setAnnPos(dwg, a, P) {
  const v = a.view ? findView(dwg, a.view) : null;
  a.pos = v ? [P[0] - v.x, P[1] - v.y] : P;
}

export function dimValue(dwg, a) {
  if (a.kind === 'linear') {
    if (a.orient === 'h') return Math.abs(a.p2[0] - a.p1[0]);
    if (a.orient === 'v') return Math.abs(a.p2[1] - a.p1[1]);
    return len2(sub2(a.p2, a.p1));
  }
  if (a.kind === 'diameter') return 2 * a.r;
  if (a.kind === 'radius') return a.r;
  if (a.kind === 'angle') {
    const d1 = unit2(sub2(a.l1[1], a.l1[0])), d2 = unit2(sub2(a.l2[1], a.l2[0]));
    return (Math.acos(Math.max(-1, Math.min(1, Math.abs(dot2(d1, d2))))) * 180) / Math.PI;
  }
  return 0;
}
export function dimText(dwg, a) {
  if (a.override) return a.override;
  const v = dimValue(dwg, a);
  const n = a.kind === 'angle' ? `${fmtNum(v, { settings: { ...dwg.settings, decimals: Math.min(dwg.settings?.decimals ?? 2, 1) } })}°` : fmtLen(v, dwg);
  const pre = a.kind === 'diameter' ? 'Ø' : a.kind === 'radius' ? 'R' : '';
  return `${a.prefix || ''}${pre}${n}${a.suffix || ''}${a.tol ? ` ${a.tol}` : ''}`;
}

export function annPrims(dwg, a, ctx) {
  const v = a.view ? findView(dwg, a.view) : null;
  if (a.view && !v) return [];
  const X = v ? viewXform(dwg, v) : null;
  const th = dwg.settings?.textH || 3.5;
  const out = [];
  if (a.type === 'note') {
    const P = annPos(dwg, a);
    const lines = String(a.text || '').split('\n');
    const h = a.h || th;
    lines.forEach((s, i) => out.push({ t: 'text', p: [P[0], P[1] + i * h * 1.6], text: s, h, anchor: 'start', base: 'bottom' }));
    if (a.leader && X) {
      const tip = X.toSheet(a.leader);
      const w = Math.max(...lines.map((s) => textWidth(s, h)));
      const start = tip[0] < P[0] ? [P[0] - 1, P[1] - h / 2] : [P[0] + w + 1, P[1] - h / 2];
      out.push({ t: 'line', a: start, b: tip, w: LW.thin }, arrowHead(tip, sub2(tip, start), dwg));
    }
    return out;
  }
  if (a.type === 'cmark' && X) {
    const c = X.toSheet(a.c), r = a.r * X.s, e = r + 2.5;
    out.push({ t: 'line', a: [c[0] - e, c[1]], b: [c[0] + e, c[1]], w: LW.thin, dash: DASH_CENTER });
    out.push({ t: 'line', a: [c[0], c[1] - e], b: [c[0], c[1] + e], w: LW.thin, dash: DASH_CENTER });
    return out;
  }
  if (a.type === 'cline' && X) {
    const p = X.toSheet(a.a), q = X.toSheet(a.b), d = unit2(sub2(q, p));
    out.push({ t: 'line', a: sub2(p, mul2(d, 2.5)), b: add2(q, mul2(d, 2.5)), w: LW.thin, dash: DASH_CENTER });
    return out;
  }
  if (a.type === 'balloon') {
    // a circled item number with a leader to a dot on the part
    const P = annPos(dwg, a), h = a.h || th, R = h * 1.25, text = String(a.item ?? '?');
    out.push({ t: 'circle', c: P, r: R, w: LW.thin });
    out.push({ t: 'text', p: [P[0], P[1] + h / 2], text, h, anchor: 'middle', base: 'bottom', fit: 2 * R - 1 });
    if (a.leader && X) {
      const tip = X.toSheet(a.leader), d = sub2(tip, P), l = Math.hypot(d[0], d[1]);
      if (l > R + 0.5) out.push({ t: 'line', a: add2(P, mul2(d, R / l)), b: tip, w: LW.thin }, { t: 'circle', c: tip, r: 0.6, w: LW.thin, fill: '#000' });
    }
    return out;
  }
  if (a.type === 'bom') return bomTablePrims(dwg, a);
  if (a.type === 'dxf') return dxfAnnPrims(dwg, a);
  if (a.type === 'revtable') return revTablePrims(dwg, a);
  if (a.type === 'table') return generalTablePrims(dwg, a);
  if (a.type === 'cutlist') return cutListPrims(dwg, a, ctx);
  if (a.type === 'holetable') return holeTablePrims(dwg, a, ctx);
  if (a.type === 'datum' || a.type === 'fcf' || a.type === 'sfin' || a.type === 'weld') return symbolPrims(dwg, a, X);
  if (a.type === 'ordinate' && X) {
    // ordinate dimension: the distance from the origin along one axis, on a leader to a row / column
    const p = X.toSheet(a.p), P = annPos(dwg, a), ax = a.axis === 'y' ? 1 : 0;
    const val = Math.abs(a.p[ax] - a.o[ax]), text = fmtLen(val, dwg);
    const d = ax ? X.ax : X.ay; // the leader runs across the measured direction
    const t = dot2(sub2(P, p), d), end = add2(p, mul2(d, t)), u = unit2(sub2(end, p));
    if (len2(sub2(end, p)) > 1) out.push({ t: 'line', a: add2(p, mul2(u, 1)), b: end, w: LW.thin });
    let ang = (Math.atan2(-u[1], u[0]) * 180) / Math.PI;
    let anchor = 'start';
    if (ang > 90.01 || ang <= -90) { ang += ang > 0 ? -180 : 180; anchor = 'end'; }
    out.push({ t: 'text', p: add2(end, mul2(u, 1)), text, h: th, anchor, base: 'middle', rot: ang });
    return out;
  }
  if (a.type !== 'dim' || !X) return out;
  const P = annPos(dwg, a);
  const text = dimText(dwg, a);
  const tw = textWidth(text, th), gap = 1, over = 2, AL = dwg.settings?.arrow || 3;
  if (a.kind === 'linear') {
    const p1 = X.toSheet(a.p1), p2 = X.toSheet(a.p2);
    let d, n; // dimension line direction and its normal
    // horizontal / vertical: along the view's own axes (a turned view turns its dimensions with it)
    if (a.orient === 'h') d = X.ax;
    else if (a.orient === 'v') d = X.ay;
    else d = unit2(sub2(p2, p1));
    if (len2(d) < 1e-9) d = [1, 0];
    n = perp2(d);
    // the dimension line passes through P; its ends are the feet of p1 and p2
    const foot = (p) => add2(P, mul2(d, dot2(sub2(p, P), d)));
    const f1 = foot(p1), f2 = foot(p2);
    // extension lines (a small gap at the object, past the dimension line by `over`)
    for (const [p, f] of [[p1, f1], [p2, f2]]) {
      const v2 = sub2(f, p), L = len2(v2);
      if (L > 1e-6) { const u = mul2(v2, 1 / L); out.push({ t: 'line', a: add2(p, mul2(u, Math.min(gap, L))), b: add2(f, mul2(u, over)), w: LW.thin }); }
    }
    const span = len2(sub2(f2, f1)), u = span > 1e-9 ? unit2(sub2(f2, f1)) : d;
    const inside = span > 2 * AL + 1;
    if (inside) {
      out.push({ t: 'line', a: f1, b: f2, w: LW.thin });
      out.push(arrowHead(f1, mul2(u, -1), dwg), arrowHead(f2, u, dwg));
    } else {
      out.push({ t: 'line', a: sub2(f1, mul2(u, AL + 3)), b: add2(f2, mul2(u, AL + 3)), w: LW.thin });
      out.push(arrowHead(f1, u, dwg), arrowHead(f2, mul2(u, -1), dwg));
    }
    // text: on the dimension line, centred at P's position along it, above the line, readable
    const t = dot2(sub2(P, f1), u);
    let mid = add2(f1, mul2(u, t));
    let ang = (Math.atan2(-u[1], u[0]) * 180) / Math.PI; // counter-clockwise on paper
    if (ang > 90.01) ang -= 180; if (ang <= -90) ang += 180;
    const rad = (ang * Math.PI) / 180;
    const upv = [-Math.sin(rad), -Math.cos(rad)]; // "above" the text line on paper
    // text beyond the extension lines: extend the dimension line under it
    if (t < 0 || t > span) out.push({ t: 'line', a: t < 0 ? f1 : f2, b: add2(mid, mul2(u, t < 0 ? -tw / 2 : tw / 2)), w: LW.thin });
    out.push({ t: 'text', p: add2(mid, mul2(upv, 1)), text, h: th, anchor: 'middle', base: 'bottom', rot: ang });
    return out;
  }
  if (a.kind === 'diameter' || a.kind === 'radius') {
    const c = X.toSheet(a.c), r = a.r * X.s;
    const toP = sub2(P, c), dist = len2(toP);
    const u = dist > 1e-9 ? mul2(toP, 1 / dist) : [1, 0];
    const near = add2(c, mul2(u, r));
    const outside = dist > r;
    const shoulder = P[0] >= near[0] ? 1 : -1;
    const end = [P[0] + shoulder * (tw + 2), P[1]];
    if (a.kind === 'diameter') {
      const far = sub2(c, mul2(u, r));
      if (outside) {
        out.push({ t: 'line', a: far, b: P, w: LW.thin }, { t: 'line', a: P, b: end, w: LW.thin });
        out.push(arrowHead(near, mul2(u, -1), dwg), arrowHead(far, u, dwg));
      } else {
        out.push({ t: 'line', a: far, b: near, w: LW.thin });
        out.push(arrowHead(near, u, dwg), arrowHead(far, mul2(u, -1), dwg));
      }
    } else {
      out.push({ t: 'line', a: c, b: outside ? P : near, w: LW.thin });
      if (outside) out.push({ t: 'line', a: P, b: end, w: LW.thin });
      out.push(arrowHead(near, outside ? mul2(u, -1) : u, dwg));
    }
    const tx = outside ? (shoulder > 0 ? P[0] + 1 : P[0] - 1 - tw) : P[0] - tw / 2;
    out.push({ t: 'text', p: [tx, P[1] - 1], text, h: th, anchor: 'start', base: 'bottom' });
    return out;
  }
  if (a.kind === 'angle') {
    const A1 = X.toSheet(a.l1[0]), B1 = X.toSheet(a.l1[1]), A2 = X.toSheet(a.l2[0]), B2 = X.toSheet(a.l2[1]);
    const d1 = unit2(sub2(B1, A1)), d2 = unit2(sub2(B2, A2));
    const cr = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(cr) < 1e-9) return out;
    const s = ((A2[0] - A1[0]) * d2[1] - (A2[1] - A1[1]) * d2[0]) / cr;
    const O = add2(A1, mul2(d1, s));
    const R = Math.max(5, len2(sub2(P, O)));
    // the sector holding P: between the rays (±d1, ±d2) that enclose P's direction
    const ap = Math.atan2(P[1] - O[1], P[0] - O[0]);
    const rays = [d1, mul2(d1, -1), d2, mul2(d2, -1)].map((r) => Math.atan2(r[1], r[0]));
    const norm = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    let best = null;
    for (const r1 of rays.slice(0, 2)) for (const r2 of rays.slice(2)) {
      for (const [s0, s1] of [[r1, r2], [r2, r1]]) {
        const span = norm(s1 - s0);
        if (span < Math.PI && norm(ap - s0) <= span && (!best || span < best.span)) best = { s0, span };
      }
    }
    if (!best) return out;
    const pts = [];
    for (let i = 0; i <= 48; i++) { const t = best.s0 + (best.span * i) / 48; pts.push([O[0] + R * Math.cos(t), O[1] + R * Math.sin(t)]); }
    out.push({ t: 'poly', pts, w: LW.thin });
    const e0 = [Math.cos(best.s0), Math.sin(best.s0)], e1 = [Math.cos(best.s0 + best.span), Math.sin(best.s0 + best.span)];
    out.push(arrowHead(pts[0], perp2(e0).map((x) => -x), dwg), arrowHead(pts[pts.length - 1], perp2(e1), dwg));
    // extension lines from the lines' nearest points to the arc ends when the arc is beyond them
    for (const [e, A, B] of [[e0, A1, B1], [e1, A2, B2]]) {
      const far = Math.max(dot2(sub2(A, O), e), dot2(sub2(B, O), e));
      if (far < R - 0.5) out.push({ t: 'line', a: add2(O, mul2(e, far + gap)), b: add2(O, mul2(e, R + over)), w: LW.thin });
    }
    const mid = best.s0 + best.span / 2;
    const tp = [O[0] + (R + 1.5) * Math.cos(mid), O[1] + (R + 1.5) * Math.sin(mid)];
    out.push({ t: 'text', p: tp, text, h: th, anchor: 'middle', base: 'middle' });
    return out;
  }
  return out;
}

// ------------------------------------------------------------ symbols
// Leader: from the symbol at P (start point on it) to the tip (view coordinates in a.leader), with an
// arrowhead (or the datum's filled triangle).
function leaderPrims(dwg, a, X, start, triangle = false) {
  if (!a.leader || !X) return [];
  const tip = X.toSheet(a.leader), out = [{ t: 'line', a: start, b: tip, w: LW.thin }];
  if (triangle) {
    const d = unit2(sub2(tip, start)), n = perp2(d), L = (dwg.settings?.arrow || 3) * 0.9;
    out.push({ t: 'poly', pts: [add2(tip, mul2(n, L * 0.6)), sub2(tip, mul2(n, L * 0.6)), sub2(tip, mul2(d, L))], closed: true, w: LW.thin, fill: true });
  } else out.push(arrowHead(tip, sub2(tip, start), dwg));
  return out;
}
// GD&T characteristic symbols drawn in a box of height h at c
export const GDT_SYMBOLS = [
  ['straightness', 'Straightness'], ['flatness', 'Flatness'], ['circularity', 'Circularity'], ['cylindricity', 'Cylindricity'],
  ['profileLine', 'Profile of a line'], ['profileSurface', 'Profile of a surface'], ['perpendicularity', 'Perpendicularity'],
  ['angularity', 'Angularity'], ['parallelism', 'Parallelism'], ['position', 'Position'], ['concentricity', 'Concentricity'],
  ['symmetry', 'Symmetry'], ['runout', 'Circular runout'], ['totalRunout', 'Total runout'],
];
function gdtSymbol(sym, c, h) {
  const s = h * 0.32, w = LW.thin * 1.2, L = (a, b) => ({ t: 'line', a: add2(c, a), b: add2(c, b), w });
  switch (sym) {
    case 'straightness': return [L([-s, 0], [s, 0])];
    case 'flatness': return [{ t: 'poly', pts: [[-s, s * 0.45], [s * 0.6, s * 0.45], [s, -s * 0.45], [-s * 0.6, -s * 0.45]].map((q) => add2(c, q)), closed: true, w }];
    case 'circularity': return [{ t: 'circle', c, r: s * 0.8, w }];
    case 'cylindricity': return [{ t: 'circle', c, r: s * 0.6, w }, L([-s * 0.25, s * 0.9], [-s, -s * 0.9]), L([s, s * 0.9], [s * 0.25, -s * 0.9])];
    case 'profileLine': return [{ t: 'poly', pts: arcPts([0, s * 0.35], s * 0.85, Math.PI, 2 * Math.PI).map((q) => add2(c, q)), w }];
    case 'profileSurface': return [{ t: 'poly', pts: [...arcPts([0, s * 0.35], s * 0.85, Math.PI, 2 * Math.PI), [-s * 0.85, s * 0.35]].map((q) => add2(c, q)), w }];
    case 'perpendicularity': return [L([-s, s * 0.8], [s, s * 0.8]), L([0, s * 0.8], [0, -s * 0.9])];
    case 'angularity': return [L([-s, s * 0.8], [s, s * 0.8]), L([-s, s * 0.8], [s * 0.7, -s * 0.8])];
    case 'parallelism': return [L([-s * 0.7, s * 0.8], [-s * 0.1, -s * 0.8]), L([s * 0.1, s * 0.8], [s * 0.7, -s * 0.8])];
    case 'position': return [{ t: 'circle', c, r: s * 0.65, w }, L([-s, 0], [s, 0]), L([0, -s], [0, s])];
    case 'concentricity': return [{ t: 'circle', c, r: s * 0.4, w }, { t: 'circle', c, r: s * 0.85, w }];
    case 'symmetry': return [L([-s * 0.5, -s * 0.55], [s * 0.5, -s * 0.55]), L([-s, 0], [s, 0]), L([-s * 0.5, s * 0.55], [s * 0.5, s * 0.55])];
    case 'runout': return [L([-s * 0.6, s * 0.9], [s * 0.6, -s * 0.9]), { t: 'poly', pts: [[s * 0.6, -s * 0.9], [s * 0.05, -s * 0.75], [s * 0.45, -s * 0.35]].map((q) => add2(c, q)), closed: true, w, fill: true }];
    case 'totalRunout': return [L([-s * 0.9, s * 0.9], [s * 0.1, -s * 0.9]), L([-s * 0.1, s * 0.9], [s * 0.9, -s * 0.9]), L([-s * 0.9, s * 0.9], [-s * 0.1, s * 0.9]), { t: 'poly', pts: [[s * 0.1, -s * 0.9], [-s * 0.45, -s * 0.75], [-s * 0.05, -s * 0.35]].map((q) => add2(c, q)), closed: true, w, fill: true }, { t: 'poly', pts: [[s * 0.9, -s * 0.9], [s * 0.35, -s * 0.75], [s * 0.75, -s * 0.35]].map((q) => add2(c, q)), closed: true, w, fill: true }];
    default: return [];
  }
}
function symbolPrims(dwg, a, X) {
  const th = dwg.settings?.textH || 3.5, P = annPos(dwg, a), out = [];
  if (a.type === 'datum') {
    // a boxed letter; its leader ends in a filled triangle on the feature
    const s = th * 2.2;
    const box = [[P[0] - s / 2, P[1] - s / 2], [P[0] + s / 2, P[1] - s / 2], [P[0] + s / 2, P[1] + s / 2], [P[0] - s / 2, P[1] + s / 2]];
    out.push({ t: 'poly', pts: box, closed: true, w: LW.thin });
    out.push({ t: 'text', p: P, text: a.letter || 'A', h: th, anchor: 'middle', base: 'middle' });
    if (a.leader && X) {
      const tip = X.toSheet(a.leader), d = unit2(sub2(tip, P));
      // from the box edge nearest the tip
      const start = Math.abs(d[0]) > Math.abs(d[1]) ? [P[0] + Math.sign(d[0]) * s / 2, P[1]] : [P[0], P[1] + Math.sign(d[1]) * s / 2];
      out.push(...leaderPrims(dwg, a, X, start, true));
    } else {
      const b = [P[0], P[1] + s / 2], L = s * 0.5;
      out.push({ t: 'line', a: b, b: [P[0], b[1] + L], w: LW.thin }, { t: 'poly', pts: [[P[0] - L * 0.6, b[1] + L], [P[0] + L * 0.6, b[1] + L], [P[0], b[1] + L * 0.2]], closed: true, w: LW.thin, fill: true });
    }
    return out;
  }
  if (a.type === 'fcf') {
    // feature control frame: | symbol | (Ø) tolerance (modifier) | datums… |
    const h = th * 2, pad = th * 0.6;
    const tolText = `${a.dia ? 'Ø' : ''}${a.tol || ''}${a.mod ? ` ${a.mod}` : ''}`;
    const cells = [{ w: h, sym: a.sym }, { w: textWidth(tolText, th) + 2 * pad, text: tolText }, ...(a.datums || []).filter(Boolean).map((d) => ({ w: Math.max(h, textWidth(d, th) + 2 * pad), text: d }))];
    let x = P[0];
    const y0 = P[1] - h / 2, y1 = P[1] + h / 2;
    for (const c of cells) {
      out.push({ t: 'poly', pts: [[x, y0], [x + c.w, y0], [x + c.w, y1], [x, y1]], closed: true, w: LW.thin });
      if (c.sym) out.push(...gdtSymbol(c.sym, [x + c.w / 2, P[1]], h));
      else out.push({ t: 'text', p: [x + c.w / 2, P[1]], text: c.text, h: th, anchor: 'middle', base: 'middle' });
      x += c.w;
    }
    if (a.leader && X) {
      const tip = X.toSheet(a.leader);
      out.push(...leaderPrims(dwg, a, X, tip[0] < P[0] + (x - P[0]) / 2 ? [P[0], P[1]] : [x, P[1]]));
    }
    return out;
  }
  if (a.type === 'sfin') {
    // surface finish: the tick with its tip on the surface (or on the leader's end at P)
    const h = th * 1.6, T = P, out2 = out;
    const left = [T[0] - h * 0.58, T[1] - h], top = [T[0] + h * 1.15, T[1] - h * 2];
    out2.push({ t: 'poly', pts: [left, T, top], w: LW.thin });
    if (a.kind === 'removal') out2.push({ t: 'line', a: left, b: [T[0] + h * 0.58, T[1] - h], w: LW.thin });
    if (a.kind === 'noremoval') out2.push({ t: 'circle', c: [T[0], T[1] - h * 0.62], r: h * 0.36, w: LW.thin });
    const text = a.text || '';
    if (text) {
      const tw = textWidth(text, th);
      out2.push({ t: 'line', a: top, b: [top[0] + tw + 2, top[1]], w: LW.thin });
      out2.push({ t: 'text', p: [top[0] + 1, top[1] - 1], text, h: th, anchor: 'start', base: 'bottom' });
    }
    if (a.leader && X) out2.push(...leaderPrims(dwg, a, X, T));
    return out2;
  }
  if (a.type === 'weld') {
    // weld symbol: reference line from P, arrow to the joint, the weld symbol below (arrow side) /
    // above (other side), size left of it, length right of it
    const L = Math.max(24, textWidth(`${a.size || ''}${a.length || ''}`, th) + 18), h = th * 1.4;
    const dirR = a.leader && X && X.toSheet(a.leader)[0] > P[0] ? -1 : 1; // the line runs away from the arrow
    const E = [P[0] + dirR * L, P[1]];
    out.push({ t: 'line', a: P, b: E, w: LW.thin });
    if (a.leader && X) out.push(...leaderPrims(dwg, a, X, P));
    const mx = P[0] + dirR * L * 0.5;
    const sides = a.side === 'both' ? [1, -1] : a.side === 'other' ? [-1] : [1];
    for (const sd of sides) {
      // sd 1: below the line (arrow side), -1: above
      const y = P[1], q = (dx, dy) => [mx + dx, y + sd * dy];
      const k = a.wtype || 'fillet';
      if (k === 'fillet') out.push({ t: 'poly', pts: [q(-h / 2, 0), q(-h / 2, h), q(h / 2, 0)], w: LW.thin });
      else if (k === 'square') out.push({ t: 'line', a: q(-h / 4, 0), b: q(-h / 4, h), w: LW.thin }, { t: 'line', a: q(h / 4, 0), b: q(h / 4, h), w: LW.thin });
      else if (k === 'v') out.push({ t: 'poly', pts: [q(-h / 2, h), q(0, 0), q(h / 2, h)], w: LW.thin });
      else if (k === 'bevel') out.push({ t: 'poly', pts: [q(-h / 3, h), q(-h / 3, 0)], w: LW.thin }, { t: 'line', a: q(-h / 3, 0), b: q(h / 2, h), w: LW.thin });
      else if (k === 'plug') out.push({ t: 'poly', pts: [q(-h / 2, 0), q(-h / 2, h * 0.6), q(h / 2, h * 0.6), q(h / 2, 0)], w: LW.thin });
      const ty = y + sd * (h / 2);
      if (a.size) out.push({ t: 'text', p: [mx - h / 2 - 1, ty], text: String(a.size), h: th, anchor: 'end', base: 'middle' });
      if (a.length) out.push({ t: 'text', p: [mx + h / 2 + 1, ty], text: String(a.length), h: th, anchor: 'start', base: 'middle' });
    }
    if (a.allAround) out.push({ t: 'circle', c: P, r: th * 0.7, w: LW.thin });
    if (a.field) out.push({ t: 'line', a: P, b: [P[0], P[1] - th * 2.6], w: LW.thin }, { t: 'poly', pts: [[P[0], P[1] - th * 2.6], [P[0] + dirR * th * 1.6, P[1] - th * 2.1], [P[0], P[1] - th * 1.6]], closed: true, w: LW.thin, fill: true });
    if (a.tail) {
      out.push({ t: 'line', a: E, b: [E[0] + dirR * h * 0.8, E[1] - h * 0.8], w: LW.thin }, { t: 'line', a: E, b: [E[0] + dirR * h * 0.8, E[1] + h * 0.8], w: LW.thin });
      out.push({ t: 'text', p: [E[0] + dirR * (h * 0.8 + 1), E[1]], text: a.tail, h: th, anchor: dirR > 0 ? 'start' : 'end', base: 'middle' });
    }
    return out;
  }
  return out;
}

// A hole table's rows: the holes of view a.of (its full circles, one each where the same circle shows twice), each
// with its tag (a letter for each size, largest first, numbered along each row from the bottom left: A1, A2… B1), its
// X and Y from the view's lower-left corner (or a.origin, view coordinates) and its diameter
export function holeTableRows(dwg, a, geos) {
  const v = findView(dwg, a.of);
  if (!v) return null;
  const pk = viewPickables(dwg, v, geos), key = (x) => Math.round(x * 1e6);
  if (!pk.points.length) return [];
  const seen = new Map();
  for (const c of pk.circles) if (c.full) seen.set(`${key(c.c[0])},${key(c.c[1])},${key(c.r)}`, c);
  const holes = [...seen.values()];
  const o = a.origin || [Math.min(...pk.points.map((q) => q.p[0])), Math.min(...pk.points.map((q) => q.p[1]))];
  const sizes = [...new Set(holes.map((h) => key(2 * h.r)))].sort((x, y) => y - x);
  const rows = [];
  sizes.forEach((sz, i) => {
    const letter = i < 26 ? String.fromCharCode(65 + i) : 'H' + (i + 1);
    holes.filter((h) => key(2 * h.r) === sz).sort((p, q) => key(p.c[1]) - key(q.c[1]) || p.c[0] - q.c[0]).forEach((h, k) => rows.push({ tag: `${letter}${k + 1}`, x: h.c[0] - o[0], y: h.c[1] - o[1], d: 2 * h.r, c: h.c, r: h.r }));
  });
  return rows;
}
// A hole table: TAG | X | Y | SIZE for the holes of a view, the tags beside the holes in it; its top-left corner at the
// annotation's position
export function holeTablePrims(dwg, a, ctx) {
  const v = findView(dwg, a.of);
  if (!v) return [];
  const th = (dwg.settings?.textH || 3.5) * 0.85, P = annPos(dwg, a), rh = th * 2.2, X = viewXform(dwg, v);
  const rows = holeTableRows(dwg, a, ctx?.geos) || [];
  const cols = [['TAG', 14], ['X', 24], ['Y', 24], ['SIZE', 24]], W = cols.reduce((s2, c) => s2 + c[1], 0), N = rows.length + 1, out = [];
  out.push({ t: 'text', p: [P[0] + W / 2, P[1] - rh * 0.3], text: 'HOLE TABLE', h: th, anchor: 'middle', base: 'bottom', bold: true });
  for (let r = 0; r <= N; r++) out.push({ t: 'line', a: [P[0], P[1] + r * rh], b: [P[0] + W, P[1] + r * rh], w: LW.thin });
  let x = P[0];
  for (let c = 0; c <= cols.length; c++) { out.push({ t: 'line', a: [x, P[1]], b: [x, P[1] + N * rh], w: LW.thin }); if (c < cols.length) x += cols[c][1]; }
  const cell = (r, vals, bold) => { let cx = P[0]; vals.forEach((t, c) => { out.push({ t: 'text', p: [cx + cols[c][1] / 2, P[1] + r * rh + rh * 0.7], text: String(t), h: th, anchor: 'middle', base: 'bottom', bold }); cx += cols[c][1]; }); };
  cell(0, cols.map((c) => c[0]), true);
  rows.forEach((row, i) => {
    cell(i + 1, [row.tag, fmtLen(row.x, dwg), fmtLen(row.y, dwg), 'Ø' + fmtLen(row.d, dwg)], false);
    // (the tag beside its hole, up and to the right)
    const C = X.toSheet(row.c), R = row.r * X.s;
    out.push({ t: 'text', p: [C[0] + R * 0.75 + 0.8, C[1] - R * 0.75 - 0.8], text: row.tag, h: th, anchor: 'start', base: 'bottom' });
  });
  if (!rows.length) out.push({ t: 'text', p: [P[0] + W / 2, P[1] + rh * 1.7], text: geosReady(ctx, v) ? '(no holes seen end on in the view)' : '(updating…)', h: th, anchor: 'middle', base: 'bottom', color: '#8a94a6' });
  return out;
}
const geosReady = (ctx, v) => !!ctx?.geos?.get?.(v.type === 'detail' ? v.parent : v.id);

// A weldment cut list table (rows worked out by the editor: ctx.cutLists by model), its top-left corner at the position.
export function cutListPrims(dwg, a, ctx) {
  const th = (dwg.settings?.textH || 3.5) * 0.85, P = annPos(dwg, a), rh = th * 2.2;
  const cl = ctx?.cutLists?.get(a.model);
  const cols = [['ITEM', 12], ['QTY', 11], ['DESCRIPTION', 60], ['LENGTH', 20], ['ANGLE 1', 16], ['ANGLE 2', 16]];
  const W = cols.reduce((s2, c) => s2 + c[1], 0), out = [];
  const rows = cl?.rows || [];
  const N = rows.length + 1;
  out.push({ t: 'text', p: [P[0] + W / 2, P[1] - rh * 0.3], text: 'CUT LIST', h: th, anchor: 'middle', base: 'bottom', bold: true });
  for (let r = 0; r <= N; r++) out.push({ t: 'line', a: [P[0], P[1] + r * rh], b: [P[0] + W, P[1] + r * rh], w: LW.thin });
  let x = P[0];
  for (let c = 0; c <= cols.length; c++) { out.push({ t: 'line', a: [x, P[1]], b: [x, P[1] + N * rh], w: LW.thin }); if (c < cols.length) x += cols[c][1]; }
  const cell = (r, vals, bold) => {
    let cx = P[0];
    vals.forEach((t, c) => { out.push({ t: 'text', p: [cx + (c === 2 ? 1 : cols[c][1] / 2), P[1] + r * rh + rh * 0.7], text: String(t ?? ''), h: th, anchor: c === 2 ? 'start' : 'middle', base: 'bottom', bold, fit: cols[c][1] - 1.5 }); cx += cols[c][1]; });
  };
  cell(0, cols.map((c) => c[0]), true);
  const f = (v, deg = false) => (v == null ? '-' : deg ? fmtNum(v, dwg) + '°' : fmtLen(v, dwg));
  rows.forEach((row, i) => cell(i + 1, [row.item, row.qty, row.description, row.weld ? f(row.totalLength) : f(row.length), f(row.angle1, true), f(row.angle2, true)]));
  if (!cl) out.push({ t: 'text', p: [P[0] + W / 2, P[1] + rh * 1.7], text: '(updating…)', h: th, anchor: 'middle', base: 'bottom', color: '#8a94a6' });
  return out;
}

// The bill of materials of an assembly in the drawing (a.model): its columns a.cols ([{ key, title, w, values }],
// see bom.js; ITEM | QTY | PART | MATERIAL when it has none), the top level (a.indented: the sub-assemblies'
// parts too), its top-left corner at the annotation's position.
export const BOM_COLS = [['ITEM', 12], ['QTY', 11], ['PART', 62], ['MATERIAL', 40]];
const BOM_KEYS = ['item', 'qty', 'name', 'material'];
export const bomColumns = (a) => (a?.cols?.length ? a.cols : BOM_COLS.map(([title, w], i) => ({ key: BOM_KEYS[i], title, w })));
export function bomTablePrims(dwg, a) {
  const th = (dwg.settings?.textH || 3.5) * 0.85, P = annPos(dwg, a), rh = th * 2.2;
  const m = (dwg.models || []).find((x) => x.id === a.model);
  const rows = bomRows(m?.doc).filter((r) => a.indented || !r.depth);
  const spec = bomColumns(a), cols = spec.map((c) => [c.title, Math.max(4, Number(c.w) || 20)]), W = cols.reduce((s2, c) => s2 + c[1], 0), out = [];
  const centred = spec.map((c) => ['item', 'qty', 'mass', 'totalMass', 'cost', 'totalCost'].includes(c.key));
  const totals = bomTotals(rows, spec);
  const N = rows.length + 1 + (totals ? 1 : 0);
  out.push({ t: 'text', p: [P[0] + W / 2, P[1] - rh * 0.3], text: 'BILL OF MATERIALS', h: th, anchor: 'middle', base: 'bottom', bold: true });
  for (let r = 0; r <= N; r++) out.push({ t: 'line', a: [P[0], P[1] + r * rh], b: [P[0] + W, P[1] + r * rh], w: LW.thin });
  let x = P[0];
  for (let c = 0; c <= cols.length; c++) { out.push({ t: 'line', a: [x, P[1]], b: [x, P[1] + N * rh], w: LW.thin }); if (c < cols.length) x += cols[c][1]; }
  const cell = (r, vals, bold) => {
    let cx = P[0];
    vals.forEach((t, c) => { out.push({ t: 'text', p: [cx + (!centred[c] ? 1.2 : cols[c][1] / 2), P[1] + r * rh + rh * 0.7], text: String(t ?? ''), h: th, anchor: !centred[c] ? 'start' : 'middle', base: 'bottom', bold, fit: cols[c][1] - 1.5 }); cx += cols[c][1]; });
  };
  cell(0, cols.map((c) => c[0]), true);
  rows.forEach((r, i) => cell(i + 1, spec.map((c) => (c.key === 'name' ? '  '.repeat(r.depth) : '') + bomCell(r, c))));
  if (totals) cell(rows.length + 1, spec.map((c, i) => totals[i] ?? ''), true);
  if (!m) out.push({ t: 'text', p: [P[0] + W / 2, P[1] + rh * 1.7], text: '(the assembly is missing)', h: th, anchor: 'middle', base: 'bottom', color: '#8a94a6' });
  return out;
}

// A DXF drawing placed on the sheet (Insert ▸ DXF Drawing): its shapes (dxfimport.js, in mm, its lower left corner
// at the origin) drawn at the annotation's position (the lower left corner on the sheet), times a.scale.
export function dxfAnnPrims(dwg, a) {
  const P = annPos(dwg, a), k = a.scale || 1, out = [], w = LW.visible;
  const T = (q) => [P[0] + q[0] * k, P[1] - q[1] * k];
  const arcPts = (c, r, a0, a1) => { let s = a1 - a0; while (s <= 0) s += 360; const n = Math.max(8, Math.ceil(s / 6)); return Array.from({ length: n + 1 }, (_, i) => { const t = ((a0 + (s * i) / n) * Math.PI) / 180; return T([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); }); };
  for (const s of a.shapes || []) {
    if (s.line) out.push({ t: 'line', a: T(s.line[0]), b: T(s.line[1]), w });
    else if (s.circle) out.push({ t: 'circle', c: T(s.circle.c), r: s.circle.r * k, w });
    else if (s.arc) out.push({ t: 'poly', pts: arcPts(s.arc.c, s.arc.r, s.arc.a0, s.arc.a1), w });
    else if (s.ellipse) {
      const { c, major, ratio, t0, t1 } = s.ellipse, ra = Math.hypot(major[0], major[1]), u = [major[0] / ra, major[1] / ra], v = [-u[1], u[0]], rb = ra * ratio;
      let span = t1 - t0;
      while (span <= 0) span += 2 * Math.PI;
      const n = 64, pts = Array.from({ length: n + 1 }, (_, i) => { const t = t0 + (span * i) / n; return T([c[0] + ra * Math.cos(t) * u[0] + rb * Math.sin(t) * v[0], c[1] + ra * Math.cos(t) * u[1] + rb * Math.sin(t) * v[1]]); });
      out.push({ t: 'poly', pts, w });
    } else if (s.spline) out.push({ t: 'poly', pts: s.spline.pts.map(T), closed: !!s.spline.closed, w });
    else if (s.text) out.push({ t: 'text', p: T(s.text.p), text: s.text.s, h: s.text.h * k, anchor: 'start', base: 'bottom', rot: s.text.rot || 0 });
  }
  return out;
}

// Where on a BOM table a sheet point is: { col (index, or -1), row (0: the headings, 1…: the rows, or -1), r (the
// row's bomRows entry) }.
export function bomHit(dwg, a, P) {
  const th = (dwg.settings?.textH || 3.5) * 0.85, O = annPos(dwg, a), rh = th * 2.2;
  const m = (dwg.models || []).find((x) => x.id === a.model);
  const rows = bomRows(m?.doc).filter((r) => a.indented || !r.depth);
  let x = O[0], col = -1;
  bomColumns(a).forEach((c, i) => { const w = Math.max(4, Number(c.w) || 20); if (P[0] >= x && P[0] < x + w) col = i; x += w; });
  const k = Math.floor((P[1] - O[1]) / rh), row = k >= 0 && k <= rows.length ? k : -1;
  return { col, row, r: row > 0 ? rows[row - 1] : null };
}

// A general table (a.title, a.rows: [[cell…]…], the first row its header when a.header), its top-left corner at the
// annotation's position: each column as wide as its widest cell. Cells may hold variables in {braces}: the drawing's
// properties ({title}, {material}…).
export function parseTable(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  return lines.map((l) => (l.includes('\t') ? l.split('\t') : l.split('|')).map((c) => c.trim()));
}
export function generalTablePrims(dwg, a) {
  const th = (dwg.settings?.textH || 3.5) * 0.85, P = annPos(dwg, a), rh = th * 2.2, out = [];
  const props = dwg.props || {}, fill = (t) => String(t ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in props ? String(props[k] ?? '') : m));
  const rows = (a.rows || []).map((r) => r.map(fill));
  const nc = Math.max(1, ...rows.map((r) => r.length));
  const widths = Array.from({ length: nc }, (_, c) => Math.max(10, ...rows.map((r, i) => textWidth(r[c] || '', th, !!a.header && i === 0) + 3)));
  const W = widths.reduce((s2, w) => s2 + w, 0), top = a.title ? 1 : 0, N = rows.length + top;
  if (a.title) out.push({ t: 'text', p: [P[0] + W / 2, P[1] + rh * 0.7], text: fill(a.title), h: th, anchor: 'middle', base: 'bottom', bold: true });
  for (let r = 0; r <= N; r++) out.push({ t: 'line', a: [P[0], P[1] + r * rh], b: [P[0] + W, P[1] + r * rh], w: r === top + 1 && a.header ? LW.visible * 0.7 : LW.thin });
  let x = P[0];
  for (let c = 0; c <= nc; c++) {
    out.push({ t: 'line', a: [x, P[1] + (c === 0 || c === nc ? 0 : top * rh)], b: [x, P[1] + N * rh], w: LW.thin });
    if (c < nc) x += widths[c];
  }
  rows.forEach((row, i) => {
    let cx = P[0];
    for (let c = 0; c < nc; c++) { out.push({ t: 'text', p: [cx + widths[c] / 2, P[1] + (i + top) * rh + rh * 0.7], text: row[c] || '', h: th, anchor: 'middle', base: 'bottom', bold: !!a.header && i === 0 }); cx += widths[c]; }
  });
  return out;
}

// The revision table (rows from dwg.revisions), its top-left corner at the annotation's position.
export function revTablePrims(dwg, a) {
  const th = (dwg.settings?.textH || 3.5) * 0.85, P = annPos(dwg, a), rh = th * 2.2;
  const rows = dwg.revisions || [];
  const cols = [['REV', 12], ['DESCRIPTION', 70], ['DATE', 24], ['APPROVED', 22]];
  const W = cols.reduce((s2, c) => s2 + c[1], 0), out = [];
  const N = rows.length + 2;
  out.push({ t: 'text', p: [P[0] + W / 2, P[1] + rh * 0.7], text: 'REVISIONS', h: th, anchor: 'middle', base: 'bottom', bold: true });
  for (let r = 0; r <= N; r++) if (r !== 1 || true) out.push({ t: 'line', a: [P[0], P[1] + r * rh], b: [P[0] + W, P[1] + r * rh], w: LW.thin });
  let x = P[0];
  for (let c = 0; c <= cols.length; c++) {
    out.push({ t: 'line', a: [x, P[1] + (c === 0 || c === cols.length ? 0 : rh)], b: [x, P[1] + N * rh], w: LW.thin });
    if (c < cols.length) x += cols[c][1];
  }
  const cell = (r, vals, bold) => {
    let cx = P[0];
    vals.forEach((t, c) => { out.push({ t: 'text', p: [cx + cols[c][1] / 2, P[1] + r * rh + rh * 0.7], text: String(t ?? ''), h: th, anchor: 'middle', base: 'bottom', bold, fit: cols[c][1] - 1.5 }); cx += cols[c][1]; });
  };
  cell(1, cols.map((c) => c[0]), true);
  rows.forEach((row, i) => cell(i + 2, [row.rev, row.desc, row.date, row.by]));
  return out;
}

// ------------------------------------------------------------ picking helpers
// The pickable geometry of a view in sheet coordinates: lines (with their view-coordinate ends),
// circles / arcs (centre, radius) and points (ends, centres, midpoints).
export function viewPickables(dwg, v, geos) {
  const g = viewGeom(dwg, v, geos);
  const X = viewXform(dwg, v);
  const out = { lines: [], circles: [], points: [] };
  if (!g) return out;
  const clip = v.type === 'detail' ? { c: X.toSheet(v.detail.c), r: v.detail.r * X.s } : null;
  const inView = (p) => (!v.crop || (p[0] >= v.crop.x0 - 1e-6 && p[0] <= v.crop.x1 + 1e-6 && p[1] >= v.crop.y0 - 1e-6 && p[1] <= v.crop.y1 + 1e-6))
    && (!X.brk || !(p[X.brk.axis === 'y' ? 1 : 0] > X.brk.a + 1e-9 && p[X.brk.axis === 'y' ? 1 : 0] < X.brk.b - 1e-9));
  const inClip = (P, p) => (!clip || len2(sub2(P, clip.c)) <= clip.r + 1e-6) && (!p || inView(p));
  const pt = (p) => { const P = X.toSheet(p); if (inClip(P, p)) out.points.push({ P, p }); };
  for (const { k, g: e } of g.edges) {
    if (k !== 'v' && k !== 't' && k !== 'bu' && k !== 'bd' && !((v.style === 'hlv' || v.style === 'wire') && (k === 'h' || k === 'ht'))) continue;
    if (e.t === 'l') {
      const A = X.toSheet(e.a), B = X.toSheet(e.b);
      if (!inClip(A, e.a) && !inClip(B, e.b)) continue;
      out.lines.push({ A, B, a: e.a, b: e.b });
      pt(e.a); pt(e.b);
    } else if (e.t === 'c' || e.t === 'a') {
      const C = X.toSheet(e.c);
      if (!inView(e.c)) continue;
      out.circles.push({ C, R: e.r * X.s, c: e.c, r: e.r, full: e.t === 'c', a0: e.a0, a1: e.a1 });
      pt(e.c);
      if (e.t === 'a') { pt([e.c[0] + e.r * Math.cos(e.a0), e.c[1] + e.r * Math.sin(e.a0)]); pt([e.c[0] + e.r * Math.cos(e.a1), e.c[1] + e.r * Math.sin(e.a1)]); }
    } else if (e.t === 'p') {
      pt(e.pts[0]); pt(e.pts[e.pts.length - 1]);
    }
  }
  return out;
}

export const distToSeg = (P, A, B) => {
  const d = sub2(B, A), L2 = dot2(d, d);
  const t = L2 > 0 ? Math.max(0, Math.min(1, dot2(sub2(P, A), d) / L2)) : 0;
  return len2(sub2(P, add2(A, mul2(d, t))));
};

// The paper size and frame, for the editor.
export { paperSize, frameRect, titleBlockRect };
