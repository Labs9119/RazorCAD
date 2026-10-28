// The drawing editor: one open drawing (a tab), shown on the #drawing pane as SVG.
// Views of parts are placed on sheets (model, standard 3 view, projected, section, detail views),
// annotated (smart dimensions, notes, center marks, centerlines) and exported to PDF.
// The geometry of each view comes from the kernel (hidden-line projection, see kernel.worker.js).
import * as D from './drawing.js';
import { SHEET_SIZES, titleFields, frameRect, titleBlockRect, formatFonts } from './drawingformats.js';
import { hasDrawingFont, loadDrawingFont, fontMetrics } from './fonts.js';
import { buildPDF } from './pdf.js';
import { icon } from './icons.js';
import { platform } from './platform.js';
import { materialById } from './model.js';
import { buildDXF } from './dxf.js';
import { cutListRows } from './weldments.js';
import { bodyMaterialId, docJSON, stripThumbnail, fileStem, isDefaultName } from './model.js';
import { TEMPLATE_EXT, templateFromDrawing, applyTemplate } from './drawtemplates.js';
import { partMesh, assemblyParts } from './partmeshes.js';
import { bomRows, bomItemOf, BOM_FIELDS, bomPropNames, bomCell, bomSources, bomColumnMenu } from './bom.js';
import { propOf } from './custprops.js';
import { explodeOffsets } from './explode.js';
import { autoDims, AUTO_DIM_DEFAULTS } from './autodim.js';
import { checkDrawing } from './drawcheck.js';
import { parseDXF, dxfShapes } from './dxfimport.js';
import { t as tr } from './i18n.js';

// Assemblies this big (solids, or display triangles) are drawn with fast hidden-line removal unless a view asks
// for exact (exact on thousands of solids takes many minutes a view)
const FAST_SOLIDS = 200, FAST_TRIANGLES = 600000;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const el = (tag, attrs = {}, html = '') => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v);
  }
  if (html) e.innerHTML = html;
  return e;
};
const len2 = (a) => Math.hypot(a[0], a[1]);
const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add2 = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul2 = (a, k) => [a[0] * k, a[1] * k];
const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
const unit2 = (a) => { const l = len2(a) || 1; return [a[0] / l, a[1] / l]; };

const VIEW_ICONS = { model: 'modelView', projected: 'projView', section: 'sectionView', detail: 'detailView', flat: 'smFlatten', aux: 'auxView' };
// annotation tools placed like a note: an optional leader (click an edge first), then the symbol
const SYMBOL_TOOLS = ['datum', 'fcf', 'sfin', 'weld'];

export class DrawingEditor {
  constructor(app, doc, filePath = null) {
    this.app = app;
    this.doc = doc;
    this.filePath = filePath;
    this.dirty = false;
    this.undoStack = [];
    this.redoStack = [];
    this.snap = JSON.stringify(doc);
    this.sheetId = doc.sheets[0].id;
    this.geos = new Map();     // view id -> kernel geometry (view coordinates)
    this.geoKeys = new Map();  // view id -> request key of that geometry
    this.errors = new Map();   // view id -> error message
    this.selected = new Set();
    this.hover = null;
    this.tool = null;
    this.cam = null;           // { x0, y0, k }: sheet point at the top-left of the pane, px per mm
    this.live = new Map();     // model id -> the open part tab it was taken from (kept up to date)
    this.annCache = new Map(); // annotation id -> its primitives (picking)
    this.cutLists = new Map(); // model id -> its weldment cut list (rows), for cut list tables
  }

  get sheet() { return D.sheetOf(this.doc, this.sheetId); }
  get name() { return this.filePath ? fileStem(this.filePath).replace(/\.rdrt$/i, '') : this.doc.name; }
  // (a template opened to be changed is edited like a drawing and saved back as the template)
  get kindLabel() { return this.doc.isTemplate ? 'Drawing Template' : 'Drawing'; }
  get tabIcon() { return this.doc.isTemplate ? 'titleBlock' : 'drawing'; }

  // ------------------------------------------------------------ showing / hiding
  attach() {
    DrawingEditor.wire(this.app);
    $('#viewport').hidden = true;
    $('#drawing').hidden = false;
    $('#status-mode').textContent = 'Editing Drawing';
    if (!this.cam) this.fit();
    this.renderAll();
    this.refreshModels().then(() => this.updateGeometry());
  }
  detach() {
    $('#drawing').hidden = true;
    $('#viewport').hidden = false;
    $('#status-mode').textContent = 'Editing Part';
    this.tool = null;
  }
  // the drawing closed: its fast-views worker (and the meshes it holds) goes too
  dispose() {
    if (this._fast) { this._fast.w.terminate(); for (const j of this._fast.waiting.values()) j.reject(new Error('The drawing was closed')); this._fast = null; }
  }

  // Wire the pane's events once; they act on the active drawing (app.drawing).
  static wire(app) {
    if (DrawingEditor._wired) return;
    DrawingEditor._wired = true;
    const pane = $('#drawing'), svg = $('#dw-svg');
    const cur = () => app.drawing;
    new ResizeObserver(() => cur()?.render()).observe(pane);
    svg.addEventListener('wheel', (e) => { e.preventDefault(); cur()?.onWheel(e); }, { passive: false });
    svg.addEventListener('pointerdown', (e) => cur()?.onDown(e));
    svg.addEventListener('pointermove', (e) => cur()?.onMove(e));
    svg.addEventListener('pointerup', (e) => cur()?.onUp(e));
    svg.addEventListener('dblclick', (e) => cur()?.onDouble(e));
    svg.addEventListener('contextmenu', (e) => { e.preventDefault(); cur()?.onContext(e); });
    svg.addEventListener('pointerleave', () => { const d = cur(); if (d && d.hover) { d.hover = null; d.render(); } });
  }

  // ------------------------------------------------------------ document changes / undo
  changed(render = true) {
    const now = JSON.stringify(this.doc);
    if (now === this.snap) { if (render) this.render(); return; }
    this.undoStack.push(this.snap);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.snap = now;
    this.dirty = true;
    this.app.updateTitle();
    if (render) { this.renderLeft(); this.render(); }
    this.updateGeometry();
    this.app.macros?.syncEditor(this);
  }
  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snap);
    this.snap = this.undoStack.pop();
    this.restore();
  }
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snap);
    this.snap = this.redoStack.pop();
    this.restore();
  }
  restore() {
    this.doc = JSON.parse(this.snap);
    if (!this.doc.sheets.some((s) => s.id === this.sheetId)) this.sheetId = this.doc.sheets[0].id;
    this.selected.clear();
    this.dirty = true;
    this.app.updateTitle();
    this.renderAll();
    this.updateGeometry();
    this.app.macros?.syncEditor(this);
  }

  // ------------------------------------------------------------ models (the parts drawn)
  modelDoc(mid) { return this.doc.models.find((m) => m.id === mid)?.doc || null; }

  // Add a part (or reuse it when it is already in the drawing). tab: the open part tab it came from.
  addModel({ name, path, doc, tab = null }) {
    const norm = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();
    let m = (path && this.doc.models.find((x) => norm(x.path) === norm(path))) || (tab && [...this.live].find(([, t]) => t === tab) && this.doc.models.find((x) => this.live.get(x.id) === tab));
    if (!m) {
      m = { id: D.newId(this.doc, 'm'), name, path: path || null, doc: JSON.parse(JSON.stringify(doc)) };
      this.doc.models.push(m);
    } else m.doc = JSON.parse(JSON.stringify(doc));
    if (tab) this.live.set(m.id, tab);
    // title block defaults from the first part
    const p = this.doc.props;
    if (!p.title) p.title = name;
    if (!p.number) p.number = propOf(doc, 'Part Number') || name.toUpperCase().replace(/\s+/g, '-');
    if (!p.material) { const mat = materialById(doc.material); if (mat) p.material = mat.name; }
    // (the first part's units, when it is in inches and nothing was chosen)
    if (this.doc.models.length === 1 && doc.units === 'in' && !this.doc.settings.units) { this.doc.settings.units = 'in'; if ((this.doc.settings.decimals ?? 2) === 2) this.doc.settings.decimals = 3; }
    return m.id;
  }

  // the kernels drawings use: the extra ones (the main kernel stays with the part being edited)
  kernel() { return this.app.kernelPool || { request: (t, d) => this.app.kernel.request(t, d) }; }

  // Bring the parts up to date: from the open part tabs, else from their files.
  async refreshModels() {
    let changed = false;
    for (const m of this.doc.models) {
      let doc = null;
      // (an assembly: from its open assembly tab)
      const docOf = (t) => (t.kind === 'drawing' ? (t.drawing !== this && t.drawing?.doc?.kind === 'assembly' ? t.drawing.doc : null) : t.doc);
      const tab = this.live.get(m.id) || this.app.tabs.find((t) => docOf(t) && m.path && sameFile(t.filePath, m.path));
      if (tab && this.app.tabs.includes(tab) && docOf(tab)) doc = docOf(tab);
      else if (m.path && platform.desktop) {
        try { const text = await platform.readText(m.path); if (text) doc = stripThumbnail(JSON.parse(text)); } catch { /* keep the copy */ }
      }
      if (doc && JSON.stringify(doc) !== JSON.stringify(m.doc)) { m.doc = JSON.parse(JSON.stringify(doc)); changed = true; }
    }
    if (changed) { this.snap = JSON.stringify(this.doc); this.dirty = true; this.app.updateTitle(); }
    return changed;
  }

  // ------------------------------------------------------------ view geometry (kernel)
  // the cut lists of the parts that have a cut list table (worked out again when a part changes)
  async updateCutLists() {
    const want = new Set(this.doc.anns.filter((a) => a.type === 'cutlist').map((a) => a.model));
    this._cutKeys ||= new Map();
    for (const mid of want) {
      const m = this.doc.models.find((x) => x.id === mid);
      if (!m) continue;
      const docJson = JSON.stringify(m.doc), key = docJson.length + ':' + hash(docJson);
      if (this._cutKeys.get(mid) === key) continue;
      try {
        const members = await this.kernel().request('cutList', { doc: docJson }, 'dwg:' + key);
        for (const x of members) x.density = materialById(bodyMaterialId(m.doc, x.id))?.density || null;
        this.cutLists.set(mid, cutListRows(members));
        this._cutKeys.set(mid, key);
      } catch (e) { this.app.toast('Could not make the cut list: ' + e.message, true); }
    }
    this.render();
  }

  // The views of an assembly model that are drawn fast: Map view id → result (as the kernel's drawingViews
  // returns it). Plain views (not sections or flat patterns) of a big assembly, or of any assembly whose view
  // asks for it; a view set to Exact never.
  async fastViews(m, reqs) {
    const out = new Map();
    if (m?.doc?.kind !== 'assembly') return out;
    const views = reqs.filter((r) => !r.section && !r.flat && D.findView(this.doc, r.id)?.hlr !== 'exact');
    if (!views.length) return out;
    // the parts shown and their display meshes (from the cache on disk when built before)
    const leaves = assemblyParts(m.doc);
    const got = new Map(); // leaf → { key, mesh }
    let solids = 0, tris = 0;
    const byDoc = new Map(); // (the same part in several places: one mesh)
    const distinct = [];
    for (const l of leaves) {
      if (!byDoc.has(l.part.doc)) byDoc.set(l.part.doc, new Map());
      if (!byDoc.get(l.part.doc).has(l.cfg)) { byDoc.get(l.part.doc).set(l.cfg, null); distinct.push(l); }
    }
    // (different parts built side by side, in the extra kernels)
    const k = this.kernel();
    const each = this.app.kernelPool ? (xs, fn) => this.app.kernelPool.each(xs, fn) : async (xs, fn) => { for (const x of xs) await fn(x); };
    await each(distinct, async (l) => {
      const r = await partMesh(k, l.part.doc, l.cfg, { onBuild: (n) => this.app.status(`Building ${n} for the drawing…`) }).catch((e) => ({ error: e.message }));
      byDoc.get(l.part.doc).set(l.cfg, r);
    });
    for (const l of leaves) {
      const r = byDoc.get(l.part.doc).get(l.cfg);
      if (r?.mesh) { got.set(l, r); solids += r.mesh.bodies?.length || 1; tris += r.mesh.triangles.length / 3; }
    }
    const big = solids > FAST_SOLIDS || tris > FAST_TRIANGLES;
    const use = views.filter((r) => big || D.findView(this.doc, r.id)?.hlr === 'fast');
    if (!use.length) return out;
    // the worker (kept for the drawing), with each part's mesh sent to it once
    if (!this._fast) {
      const w = new Worker(new URL('./fasthlr.worker.js', import.meta.url), { type: 'module' });
      this._fast = { w, sent: new Set(), req: 0, waiting: new Map() };
      w.onmessage = (e) => {
        const d = e.data;
        if (d.progress) { this.app.status(d.progress.replace(/Drawing \S+/, 'Drawing the views fast')); return; }
        const job = this._fast.waiting.get(d.req);
        if (!job) return;
        this._fast.waiting.delete(d.req);
        if (d.error) job.reject(new Error(d.error)); else job.resolve(d.results);
      };
      w.onerror = (e) => { for (const j of this._fast.waiting.values()) j.reject(new Error(e.message || 'Fast views failed')); this._fast.waiting.clear(); };
    }
    const F = this._fast, parts = [];
    for (const r of new Set(got.values())) {
      if (F.sent.has(r.key)) continue;
      const mesh = r.mesh, T = mesh.triangles;
      const total = mesh.faceGroups.reduce((s, g) => s + g.count, 0), gs = total === T.length ? 1 : 3;
      let n = 0;
      for (const e of mesh.edges) n += e.pts.length;
      const ep = new Float32Array(n), eo = new Uint32Array(mesh.edges.length + 1);
      let o = 0;
      mesh.edges.forEach((e, i) => { eo[i] = o; ep.set(e.pts, o); o += e.pts.length; });
      eo[mesh.edges.length] = o;
      parts.push({ key: r.key, V: mesh.vertices, T, groups: mesh.faceGroups.map((g) => ({ start: g.start * gs, count: g.count * gs, curved: g.surf ? g.surf.t !== 'PLANE' : true })), ep, eo });
      F.sent.add(r.key);
    }
    if (parts.length) F.w.postMessage({ type: 'parts', parts });
    const inst = [...got].map(([l, r]) => ({ key: r.key, M: l.M }));
    const req = ++F.req;
    const results = await new Promise((resolve, reject) => {
      F.waiting.set(req, { resolve, reject });
      F.w.postMessage({ type: 'views', req, inst, views: use.map((r) => ({ id: r.id, dir: r.dir, up: r.up, cells: 4096 })) });
    });
    for (const r of results) out.set(r.id, r);
    return out;
  }

  // The exploded view of the assembly a drawing view shows (its own, or its parent model view's), or null.
  explodeOf(v) {
    for (let x = v, i = 0; x && i < 10; i++, x = x.parent ? D.findView(this.doc, x.parent) : null) {
      if (x.explode) return x.explode;
      if (x.type === 'model') return null;
    }
    return null;
  }
  // The model a view shows: its part or assembly — an assembly exploded as the view asks (each component moved
  // by the steps of that exploded view).
  viewModel(v) {
    const m = this.doc.models.find((x) => x.id === v.model);
    const exId = m?.doc?.kind === 'assembly' ? this.explodeOf(v) : null;
    const ex = exId && (m.doc.explodes || []).find((x) => x.id === exId);
    if (!ex) return m;
    const offs = explodeOffsets(ex);
    return { ...m, doc: { ...m.doc, exploded: null, components: m.doc.components.map((c) => { const o = offs.get(c.id); return o ? { ...c, pos: c.pos.map((x, i) => x + o[i]) } : c; }) } };
  }

  async updateGeometry() {
    this.updateCutLists();
    const byModel = new Map();
    for (const v of this.doc.views) {
      const req = D.viewRequest(this.doc, v);
      if (!req) continue;
      const m = this.viewModel(v);
      if (!m) { this.errors.set(v.id, 'the part or assembly is missing'); continue; }
      const docJson = JSON.stringify(m.doc);
      const key = docJson.length + ':' + hash(docJson) + JSON.stringify(req);
      if (this.geoKeys.get(v.id) === key) continue;
      // (one batch per model as each view shows it: exploded views of an assembly apart from the others)
      const gk = m.id + '|' + (this.explodeOf(v) || '');
      if (!byModel.has(gk)) byModel.set(gk, { m, docJson, reqs: [], keys: new Map() });
      const g = byModel.get(gk);
      g.reqs.push(req); g.keys.set(v.id, key);
    }
    if (!byModel.size) return;
    const run = ++this._geoRun;
    for (const [, { m: model, docJson, reqs, keys }] of byModel) {
      this.app.status('Updating drawing views…');
      try {
        // an assembly: its big views drawn fast (from the display meshes), the rest by the kernel
        const fast = await this.fastViews(model, reqs);
        const exact = reqs.filter((r) => !fast.has(r.id));
        const res = [...fast.values()];
        if (exact.length) res.push(...(await this.kernel().request('drawingViews', { doc: docJson, views: exact }, 'dwg:' + docJson.length + ':' + hash(docJson))));
        if (run !== this._geoRun && this._geoRun) { /* a newer update follows; keep what arrived */ }
        let moved = false;
        for (const r of res) {
          if (r.error) this.errors.set(r.id, r.error); else this.errors.delete(r.id);
          const old = this.geos.get(r.id);
          this.geos.set(r.id, r);
          this.geoKeys.set(r.id, keys.get(r.id));
          if (old && !r.error && this.reassociate(r.id, old, r)) moved = true;
        }
        // views whose orientation changed: put the new lines where the view was
        for (const r of res) {
          const P = this.pendingCentre?.get(r.id), v = D.findView(this.doc, r.id);
          if (P && v && !r.error) { this.pendingCentre.delete(r.id); this.recentre(v, P); moved = true; }
        }
        if (moved) { this.snap = JSON.stringify(this.doc); this.dirty = true; this.app.updateTitle(); }
      } catch (err) {
        for (const r of reqs) this.errors.set(r.id, err.message);
        this.app.toast('Could not make the drawing views: ' + err.message, true);
      }
    }
    this.app.status('Ready');
    this.app.hideProgress();
    if (this.app.drawing === this) { this.render(); this.renderTree(); }
  }
  _geoRun = 0;

  // The part changed: move the annotation references of a view (and detail circles on it) to the
  // matching points of its new geometry. A reference that still lies on the geometry stays; others
  // are mapped by their place in the view's extent and snapped to the nearest end point / centre.
  reassociate(viewId, oldG, newG) {
    const cand = { pts: [], circles: [], lines: [] };
    for (const { k, g } of newG.edges) {
      if (k !== 'v' && k !== 't' && k !== 'h' && k !== 'bu' && k !== 'bd') continue;
      if (g.t === 'l') { cand.pts.push(g.a, g.b); cand.lines.push(g); }
      else if (g.t === 'c' || g.t === 'a') {
        cand.circles.push({ c: g.c, r: g.r });
        cand.pts.push(g.c);
        if (g.t === 'a') cand.pts.push([g.c[0] + g.r * Math.cos(g.a0), g.c[1] + g.r * Math.sin(g.a0)], [g.c[0] + g.r * Math.cos(g.a1), g.c[1] + g.r * Math.sin(g.a1)]);
      } else if (g.t === 'p') cand.pts.push(g.pts[0], g.pts[g.pts.length - 1]);
    }
    if (!cand.pts.length) return false;
    const ob = oldG.box, nb = newG.box;
    const diag = Math.hypot(nb.max[0] - nb.min[0], nb.max[1] - nb.min[1]) || 1;
    const same = (p) => cand.pts.some((q) => Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]) < 1e-6 * diag);
    const map = (p) => [0, 1].map((i) => {
      const o = ob.max[i] - ob.min[i], n = nb.max[i] - nb.min[i];
      return o > 1e-9 ? nb.min[i] + ((p[i] - ob.min[i]) * n) / o : p[i] + (nb.min[i] - ob.min[i]);
    });
    const snapPt = (p) => {
      if (same(p)) return p;
      const m = map(p);
      let best = null, bd = 0.15 * diag;
      for (const q of cand.pts) { const d = Math.hypot(q[0] - m[0], q[1] - m[1]); if (d < bd) { bd = d; best = q; } }
      return best ? [...best] : p;
    };
    const snapCircle = (c, r) => {
      if (cand.circles.some((k) => Math.hypot(k.c[0] - c[0], k.c[1] - c[1]) < 1e-6 * diag && Math.abs(k.r - r) < 1e-6 * diag)) return null;
      const m = map(c);
      let best = null, bd = Infinity;
      for (const k of cand.circles) { const d = Math.hypot(k.c[0] - m[0], k.c[1] - m[1]) + 0.5 * Math.abs(k.r - r); if (d < bd) { bd = d; best = k; } }
      return best && bd < 0.2 * diag ? best : null;
    };
    let changed = false;
    const upd = (obj, key, fn) => { const v = fn(obj[key]); if (v && JSON.stringify(v) !== JSON.stringify(obj[key])) { obj[key] = v; changed = true; } };
    // the length of one edge: the edge in the new geometry with the same direction nearest its mapped place
    const snapEdge = (p1, p2) => {
      if (same(p1) && same(p2)) return null;
      const d0 = [p2[0] - p1[0], p2[1] - p1[1]], L0 = Math.hypot(...d0) || 1;
      const m1 = map(p1), m2 = map(p2);
      let best = null, bd = 0.2 * diag;
      for (const l of cand.lines) {
        const d = [l.b[0] - l.a[0], l.b[1] - l.a[1]], L = Math.hypot(...d) || 1;
        if (Math.abs(d[0] * d0[1] - d[1] * d0[0]) / (L * L0) > 1e-3) continue;
        const fwd = (d[0] * d0[0] + d[1] * d0[1]) > 0;
        const [q1, q2] = fwd ? [l.a, l.b] : [l.b, l.a];
        const s = (Math.hypot(q1[0] - m1[0], q1[1] - m1[1]) + Math.hypot(q2[0] - m2[0], q2[1] - m2[1])) / 2;
        if (s < bd) { bd = s; best = [[...q1], [...q2]]; }
      }
      return best;
    };
    for (const a of this.doc.anns.filter((x) => x.view === viewId)) {
      if (a.type === 'dim' && a.kind === 'linear' && a.edge) { const e = snapEdge(a.p1, a.p2); if (e) { [a.p1, a.p2] = e; changed = true; } }
      else if (a.type === 'dim' && a.kind === 'linear') { upd(a, 'p1', snapPt); upd(a, 'p2', snapPt); }
      else if (a.type === 'dim' && (a.kind === 'diameter' || a.kind === 'radius')) { const k = snapCircle(a.c, a.r); if (k) { a.c = [...k.c]; a.r = k.r; changed = true; } }
      else if (a.type === 'dim' && a.kind === 'angle') { a.l1 = a.l1.map(snapPt); a.l2 = a.l2.map(snapPt); changed = true; }
      else if (a.type === 'cmark') { const k = snapCircle(a.c, a.r); if (k) { a.c = [...k.c]; a.r = k.r; changed = true; } }
      else if (a.type === 'cline') { upd(a, 'a', snapPt); upd(a, 'b', snapPt); }
      else if (a.type === 'note' && a.leader) { const m = map(a.leader); if (JSON.stringify(m) !== JSON.stringify(a.leader)) { a.leader = m; changed = true; } }
    }
    for (const v of this.doc.views.filter((x) => x.parent === viewId && x.type === 'detail')) {
      const m = map(v.detail.c);
      if (JSON.stringify(m) !== JSON.stringify(v.detail.c)) { v.detail.c = m; changed = true; }
    }
    return changed;
  }

  // Geometry for a view that is not placed yet (tool previews).
  async previewGeom(model, req) {
    const m = this.doc.models.find((x) => x.id === model);
    if (!m) return null;
    try {
      // (a big assembly: drawn fast, as its placed views will be)
      const fast = await this.fastViews(m, [{ ...req, id: 'preview' }]);
      if (fast.has('preview')) return fast.get('preview');
      const pj = JSON.stringify(m.doc);
      const [r] = await this.kernel().request('drawingViews', { doc: pj, views: [{ ...req, id: 'preview' }] }, 'dwg:' + pj.length + ':' + hash(pj));
      return r.error ? null : r;
    } catch { return null; } finally { this.app.hideProgress(); }
  }

  // ------------------------------------------------------------ camera
  paneSize() { const r = $('#dw-svg').getBoundingClientRect(); return [Math.max(50, r.width), Math.max(50, r.height)]; }
  fit() {
    const [W, H] = D.paperSize(this.sheet);
    const [pw, ph] = this.paneSize();
    const k = Math.min((pw - 40) / W, (ph - 40) / H);
    this.cam = { k, x0: W / 2 - pw / 2 / k, y0: H / 2 - ph / 2 / k };
    this.render();
  }
  toSheet(e) {
    const r = $('#dw-svg').getBoundingClientRect();
    return [this.cam.x0 + (e.clientX - r.left) / this.cam.k, this.cam.y0 + (e.clientY - r.top) / this.cam.k];
  }
  onWheel(e) {
    const P = this.toSheet(e);
    const f = Math.exp(-e.deltaY * 0.0015);
    const k = Math.max(0.2, Math.min(60, this.cam.k * f));
    this.cam.x0 = P[0] - (P[0] - this.cam.x0) * (this.cam.k / k);
    this.cam.y0 = P[1] - (P[1] - this.cam.y0) * (this.cam.k / k);
    this.cam.k = k;
    this.render();
  }

  // ------------------------------------------------------------ rendering
  renderAll() {
    this.renderLeft();
    this.renderCommandManager();
    this.renderSheetTabs();
    this.render();
  }

  render() {
    if (this.app.drawing !== this || $('#drawing').hidden) return;
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this.draw(); });
  }

  // The fonts the sheet format's text is set in, read from the PC once; the sheet is drawn again when
  // they arrive (until then its text shows in Helvetica).
  loadFonts() {
    const missing = formatFonts(this.doc.format).filter(([f, b]) => !hasDrawingFont(f, b));
    if (!missing.length) return Promise.resolve();
    this._fontLoad ??= Promise.all(missing.map(([f, b]) => loadDrawingFont(f, b, (file) => platform.fontData(file))))
      .then(() => { this._fontLoad = null; if (this.app.drawing === this) this.render(); });
    return this._fontLoad;
  }

  draw() {
    this.loadFonts();
    const svg = $('#dw-svg');
    if (!this.cam) this.fit();
    const [pw, ph] = this.paneSize();
    const k = this.cam.k;
    svg.setAttribute('viewBox', `${this.cam.x0} ${this.cam.y0} ${pw / k} ${ph / k}`);
    const sheet = this.sheet;
    const [W, H] = D.paperSize(sheet);
    const prims = D.sheetPrims(this.doc, sheet, { geos: this.geos, selected: this.selected, hover: this.hover, errors: this.errors, cutLists: this.cutLists });
    this.annCache = new Map();
    for (const p of prims) if (p.ref?.kind === 'ann') { if (!this.annCache.has(p.ref.id)) this.annCache.set(p.ref.id, []); this.annCache.get(p.ref.id).push(p); }
    const extra = this.toolPrims();
    const ids = { n: 0 };
    svg.innerHTML = `<defs><filter id="dw-shadow" x="-5%" y="-5%" width="110%" height="110%"><feDropShadow dx="0" dy="${1.2 / k}" stdDeviation="${2.5 / k}" flood-opacity="0.25"/></filter></defs>`
      + `<rect x="0" y="0" width="${W}" height="${H}" fill="#fff" filter="url(#dw-shadow)"/>`
      + svgOf(prims, k, ids) + svgOf(extra, k, ids);
  }

  // ------------------------------------------------------------ hit testing
  viewAt(P, tol = 2) {
    let best = null, bestA = Infinity;
    for (const v of this.doc.views.filter((x) => x.sheet === this.sheetId)) {
      const r = D.viewRect(this.doc, v, this.geos);
      if (P[0] >= r.x0 - tol && P[0] <= r.x1 + tol && P[1] >= r.y0 - tol && P[1] <= r.y1 + tol) {
        const a = (r.x1 - r.x0) * (r.y1 - r.y0);
        if (a < bestA) { bestA = a; best = v; }
      }
    }
    return best;
  }
  annAt(P) {
    const tol = Math.max(0.8, 5 / this.cam.k);
    let best = null, bd = tol;
    for (const [id, prims] of this.annCache) {
      for (const p of prims) {
        const d = primDist(p, P);
        if (d < bd) { bd = d; best = id; }
      }
    }
    return best ? this.doc.anns.find((a) => a.id === best) : null;
  }
  // A view entity under the cursor: { kind: 'point' | 'line' | 'circle', view, ... } (view coordinates)
  entityAt(P, kinds = ['point', 'line', 'circle']) {
    const tol = Math.max(0.6, 6 / this.cam.k);
    const v = this.viewAt(P, tol);
    if (!v) return null;
    const pk = D.viewPickables(this.doc, v, this.geos);
    if (kinds.includes('point')) {
      let best = null, bd = tol * 0.5;
      for (const q of pk.points) { const d = len2(sub2(q.P, P)); if (d < bd) { bd = d; best = q; } }
      if (best) return { kind: 'point', view: v.id, p: best.p, P: best.P };
    }
    let best = null, bd = tol;
    if (kinds.includes('circle')) {
      for (const c of pk.circles) {
        const d = Math.abs(len2(sub2(P, c.C)) - c.R);
        if (d < bd && (c.full || onArc(c, P))) { bd = d; best = { kind: 'circle', view: v.id, c: c.c, r: c.r, full: c.full, C: c.C, R: c.R }; }
      }
    }
    if (kinds.includes('line')) {
      for (const l of pk.lines) {
        const d = D.distToSeg(P, l.A, l.B);
        if (d < bd) { bd = d; best = { kind: 'line', view: v.id, a: l.a, b: l.b, A: l.A, B: l.B }; }
      }
    }
    return best;
  }

  // ------------------------------------------------------------ pointer
  onDown(e) {
    const P = this.toSheet(e);
    if (e.button === 1 || e.button === 2) {
      // pan
      e.preventDefault();
      $('#dw-svg').setPointerCapture(e.pointerId);
      this.drag = { kind: 'pan', start: [e.clientX, e.clientY], cam: { ...this.cam }, moved: false, button: e.button };
      return;
    }
    if (e.button !== 0) return;
    if (this.tool && this.tool.kind !== 'viewprops') { this.toolClick(P, e); return; }
    const ann = this.annAt(P);
    const view = ann ? null : this.viewAt(P, 1);
    const id = ann?.id || view?.id || null;
    if (!id) {
      if (this.tool) this.cancelTool(false);
      this.selected.clear(); this.app.ui.showLeft('tree'); this.renderLeft(); this.renderCommandManager(); this.render();
      this.drag = { kind: 'pan', start: [e.clientX, e.clientY], cam: { ...this.cam }, moved: false, button: 0 };
      $('#dw-svg').setPointerCapture(e.pointerId);
      return;
    }
    // a click on a view opens its properties (orientation, rotation, scale, display) next to the sheet
    if (view && !e.ctrlKey && !e.shiftKey && this.tool?.view !== view.id) { this.tool = { kind: 'viewprops', view: view.id }; this.app.ui.showLeft('pm'); }
    if (ann && this.tool?.kind === 'viewprops') this.cancelTool(false);
    if (e.ctrlKey || e.shiftKey) { if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id); }
    else if (!this.selected.has(id)) { this.selected.clear(); this.selected.add(id); }
    $('#dw-svg').setPointerCapture(e.pointerId);
    this.drag = { kind: ann ? 'ann' : 'view', id, last: P, moved: false };
    this.renderLeft();
    this.render();
  }
  onMove(e) {
    const P = this.toSheet(e);
    this.mouse = P;
    const d = this.drag;
    if (d?.kind === 'pan') {
      const dx = e.clientX - d.start[0], dy = e.clientY - d.start[1];
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      this.cam.x0 = d.cam.x0 - dx / this.cam.k;
      this.cam.y0 = d.cam.y0 - dy / this.cam.k;
      this.render();
      return;
    }
    if (d?.kind === 'view') {
      const v = D.findView(this.doc, d.id);
      if (v) { D.moveView(this.doc, v, P[0] - d.last[0], P[1] - d.last[1]); d.moved = true; }
      d.last = P;
      this.render();
      return;
    }
    if (d?.kind === 'ann') {
      const a = this.doc.anns.find((x) => x.id === d.id);
      if (a && a.pos) { D.setAnnPos(this.doc, a, add2(D.annPos(this.doc, a), sub2(P, d.last))); d.moved = true; }
      d.last = P;
      this.render();
      return;
    }
    if (this.tool && this.tool.kind !== 'viewprops') { this.toolMove(P, e); return; }
    const ann = this.annAt(P);
    const h = ann?.id || this.viewAt(P, 1)?.id || null;
    if (h !== this.hover) { this.hover = h; this.render(); }
  }
  onUp(e) {
    const d = this.drag;
    this.drag = null;
    try { $('#dw-svg').releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (!d) return;
    if (d.kind === 'pan' && d.button === 2 && !d.moved) { this.contextAt(e); return; }
    if ((d.kind === 'view' || d.kind === 'ann') && d.moved) this.changed();
  }
  onContext() { /* handled on pointer up (right button without dragging) */ }
  onDouble(e) {
    if (this.tool && this.tool.kind !== 'viewprops') return;
    const P = this.toSheet(e);
    const ann = this.annAt(P);
    if (ann) { this.editAnn(ann, P); return; }
    const v = this.viewAt(P, 1);
    if (v) this.startViewProps(v);
  }

  contextAt(e) {
    const P = this.toSheet(e);
    if (this.tool) { this.cancelTool(); return; }
    const ann = this.annAt(P), v = ann ? null : this.viewAt(P, 1);
    const items = [];
    if (ann) {
      this.selected.clear(); this.selected.add(ann.id);
      if (ann.type === 'dim' || ann.type === 'note') items.push({ label: ann.type === 'dim' ? 'Edit Dimension Text…' : 'Edit Note…', icon: 'note', action: () => this.editAnn(ann) });
      if (['datum', 'fcf', 'sfin', 'weld', 'revtable'].includes(ann.type)) items.push({ label: 'Edit…', icon: 'note', action: () => this.editAnn(ann) });
      if (ann.type === 'dxf') items.push({ label: `Scale (now ${ann.scale >= 1 ? `${+ann.scale.toFixed(3)}:1` : `1:${+(1 / ann.scale).toFixed(3)}`})…`, icon: 'dxf', action: async () => {
        const t = await this.app.ui.promptText('DXF Scale', 'dxf', 'Scale (e.g. 1:2, 2:1 or 0.5)', ann.scale >= 1 ? `${+ann.scale.toFixed(3)}:1` : `1:${+(1 / ann.scale).toFixed(3)}`);
        if (t == null) return;
        const m = /^\s*([\d.]+)\s*:\s*([\d.]+)\s*$/.exec(t), v = m ? +m[1] / +m[2] : +t;
        if (!(v > 0)) { this.app.toast('Enter a scale such as 1:2', true); return; }
        ann.scale = v; this.changed();
      } });
      if (ann.type === 'balloon') items.push({ label: 'Item Number…', icon: 'balloon', action: async () => { const t = await this.app.ui.promptText('Balloon', 'balloon', 'Item number', String(ann.item ?? '')); if (t != null && t.trim()) { ann.item = t.trim(); this.changed(); } } });
      if (ann.type === 'bom') {
        // (the column under the cursor: what it shows, insert, move, rename, remove; a typed value: edit it)
        const hit = D.bomHit(this.doc, ann, P);
        if (hit.col >= 0) {
          const m = this.doc.models.find((x) => x.id === ann.model);
          const cols = JSON.parse(JSON.stringify(D.bomColumns(ann)));
          const src = bomSources(bomPropNames(m?.doc), cols);
          const done = () => { ann.cols = cols; this.changed(); };
          if (cols[hit.col].key === 'text' && hit.r) items.push({ label: `Edit "${cols[hit.col].title}" of ${hit.r.name}…`, icon: 'note', action: () => this.editBomValue(ann, hit.col, hit.r) }, 'sep');
          items.push(...bomColumnMenu(cols, hit.col, src, done, (t) => this.app.ui.promptText('Column Heading', 'bom', 'Heading', t)).map((x) => (x === 'sep' ? x : { ...x, label: x.label.startsWith('Shows ▸') ? `${cols[hit.col].title} ${x.label}` : x.label })), 'sep');
        }
        items.push({ label: 'Columns…', icon: 'bom', action: () => this.bomColumnsDialog(ann) }, { label: ann.indented ? 'Top Level Only' : 'Show Sub-assembly Parts (Indented)', icon: 'bom', action: () => { ann.indented = !ann.indented; this.changed(); } });
      }
      items.push({ label: 'Delete', icon: 'trash', action: () => this.deleteSelection() });
    } else if (v) {
      this.selected.clear(); this.selected.add(v.id);
      items.push({ label: 'View Properties…', icon: VIEW_ICONS[v.type], action: () => this.startViewProps(v) });
      if (v.type !== 'detail' && v.type !== 'flat') {
        items.push({ label: 'Projected View', icon: 'projView', action: () => this.startTool('projected', { parent: v.id }) });
        items.push({ label: 'Section View', icon: 'sectionView', action: () => this.startTool('section', { parent: v.id }) });
      }
      items.push({ label: 'Detail View', icon: 'detailView', action: () => this.startTool('detail', { parent: v.id }) });
      if (v.type !== 'detail') {
        items.push({ label: v.brk ? 'Remove Break' : 'Break View', icon: 'breakView', action: () => { if (v.brk) { const keep = this.viewCentre(v); delete v.brk; this.recentre(v, keep); this.changed(); } else this.startTool('break', { view: v.id }); } });
        items.push({ label: v.crop ? 'Remove Crop' : 'Crop View', icon: 'cropView', action: () => { if (v.crop) { const keep = this.viewCentre(v); delete v.crop; this.recentre(v, keep); this.changed(); } else this.startTool('crop', { view: v.id }); } });
      }
      items.push('sep', { label: 'Delete View', icon: 'trash', action: () => this.deleteSelection() });
    } else {
      items.push({ label: 'Sheet Properties…', icon: 'sheetProps', action: () => this.sheetPropsDialog() });
      items.push({ label: 'Drawing Properties (Title Block)…', icon: 'titleBlock', action: () => this.propsDialog() });
      items.push({ label: 'Zoom to Sheet', icon: 'zoomfit', action: () => this.fit() });
    }
    this.renderLeft(); this.render();
    this.app.ui.showContext(e.clientX, e.clientY, items);
  }

  handleKey(e) {
    const typing = e.target.closest?.('input, select, textarea');
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (ctrl) {
      if (typing) return false;
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); return true; }
      if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); this.redo(); return true; }
      return false;
    }
    if (typing || document.querySelector('.modal-back')) return false;
    if (e.key === 'Escape') { if (this.tool) this.cancelTool(); else { this.selected.clear(); this.renderLeft(); this.render(); } return true; }
    if (e.key === 'Delete') { this.deleteSelection(); return true; }
    if (k === 'f') { this.fit(); return true; }
    if (e.key === 'Enter' && this.tool?.kind === 'viewprops') { this.cancelTool(); return true; }
    return false;
  }

  deleteSelection() {
    if (!this.selected.size) return;
    this.removeItems(this.selected);
    this.selected.clear();
    this.changed();
  }
  // Remove views (with the views made from them and their annotations) and annotations; no undo step of its own.
  removeItems(ids) {
    const kill = new Set(ids);
    // views take their derived views and their annotations with them
    let grew = true;
    while (grew) { grew = false; for (const v of this.doc.views) if (v.parent && kill.has(v.parent) && !kill.has(v.id)) { kill.add(v.id); grew = true; } }
    this.doc.views = this.doc.views.filter((v) => !kill.has(v.id));
    this.doc.anns = this.doc.anns.filter((a) => !kill.has(a.id) && !(a.view && kill.has(a.view)) && !(a.of && kill.has(a.of)));
    for (const id of kill) { this.geos.delete(id); this.geoKeys.delete(id); }
  }

  // ------------------------------------------------------------ tools
  startTool(kind, opts = {}) {
    if (this.tool) this.cancelTool(false);
    this.tool = { kind, ...opts };
    const t = this.tool;
    if (kind === 'model' || kind === 'std3') {
      const choices = this.partChoices();
      if (!t.model && !t.choice) t.choice = choices[0] || null;
      if (kind === 'model') { t.orient ||= 'front'; t.style ||= 'hlr'; }
    }
    if ((kind === 'projected' || kind === 'section' || kind === 'detail') && !t.parent) {
      const sel = [...this.selected].map((id) => D.findView(this.doc, id)).find(Boolean);
      if (sel && !(kind !== 'detail' && (sel.type === 'detail' || sel.type === 'flat'))) t.parent = sel.id;
    }
    if (kind === 'section') t.horizontal ??= true;
    if (kind === 'dim') t.picks = [];
    if (kind === 'cline') t.picks = [];
    if (kind === 'baseline' || kind === 'chamferDim') t.picks = [];
    if (kind === 'ordinate') t.axis ||= 'x';
    if (kind === 'break') t.axis ||= 'x';
    this.app.ui.showLeft('pm');
    this.renderLeft();
    this.renderCommandManager();
    this.toolHint();
    if (kind === 'model') this.modelPreview();
  }
  cancelTool(render = true) {
    this.tool = null;
    this.app.status('Ready');
    if (render) { this.app.ui.showLeft('tree'); this.renderLeft(); this.renderCommandManager(); this.render(); }
  }
  toolHint() {
    const t = this.tool;
    const msg = {
      model: 'Pick the part or assembly and its orientation, then click on the sheet to place the view.',
      std3: 'Pick the part or assembly, then click Place (or click on the sheet) to add its three standard views.',
      projected: t?.parent ? 'Move the cursor to a side of the view and click to place the projected view.' : 'Click the view to project from.',
      section: !t?.parent ? 'Click the view to cut.' : !t?.a ? 'Click on the view where the cutting line goes.' : 'Move to the side the arrows point and click to place the section view.',
      detail: !t?.parent ? 'Click the view to take the detail from.' : !t?.c ? 'Click the centre of the detail circle.' : !t?.r ? 'Click to set the circle size.' : 'Click to place the detail view.',
      dim: 'Click edges, circles or points; then click where the dimension goes. Esc to finish.',
      note: 'Click where the note goes (click an edge first for a leader).',
      cmark: 'Click circles or arcs to add center marks. Esc to finish.',
      cline: 'Click two lines (or two points) to add a centerline between them. Esc to finish.',
      callout: 'Click a hole (its circle) in a view, then where the callout goes.',
      baseline: !t?.base ? 'Click the base: a point or edge every dimension is measured from.' : !t?.last ? 'Click the first point or edge, then where its dimension goes.' : 'Click more points or edges: each gets a dimension from the base, stacked. Esc to finish.',
      ordinate: !t?.o ? 'Click the origin point (zero).' : t?.row == null ? 'Click where the row of values goes.' : 'Click points: each gets its distance from the origin. Esc to finish.',
      chamferDim: !t?.picks?.length ? 'Click the chamfer edge.' : t.picks.length === 1 ? 'Click one of the edges next to it.' : 'Click where the dimension goes.',
      datum: 'Click the edge the datum is on, then where the datum letter goes.',
      fcf: 'Click the edge (or click on the sheet for a frame without a leader), then where the frame goes.',
      sfin: 'Click the surface edge, then where the symbol goes (or click on the sheet to place it on its own).',
      weld: 'Click the joint (an edge), then where the weld symbol goes.',
      aux: !t?.parent ? 'Click a straight edge of a view: the auxiliary view looks square at it.' : 'Move to the side of the edge and click to place the auxiliary view.',
      break: !t?.view ? 'Click the view to break.' : t.a == null ? 'Click where the break starts.' : 'Click where the break ends.',
      crop: !t?.view ? 'Click the view to crop.' : !t.c0 ? 'Click one corner of the area to keep.' : 'Click the opposite corner.',
    }[t?.kind];
    if (msg) this.app.status(msg);
  }

  // the parts and assemblies a view can show: those in the drawing, and those open in other tabs
  partChoices() {
    const out = [];
    for (const m of this.doc.models) out.push({ key: 'm:' + m.id, label: m.name + (m.doc?.kind === 'assembly' ? ' (assembly)' : ''), model: m.id });
    this.app.tabs.forEach((tab, i) => {
      const asm = tab.kind === 'drawing' && tab.drawing?.doc?.kind === 'assembly' && tab.drawing !== this;
      if (tab.kind === 'drawing' && !asm) return;
      const doc = asm ? tab.drawing.doc : i === this.app.tabIndex ? null : tab.doc;
      if (!doc || (asm ? !doc.components?.length : !doc.features?.length)) return;
      if (this.doc.models.some((m) => (m.path && sameFile(m.path, tab.filePath)) || this.live.get(m.id) === tab)) return;
      out.push({ key: 't:' + i, label: `${doc.name} (open ${asm ? 'assembly' : 'part'})`, tab, doc, path: (asm ? tab.drawing.filePath : null) || tab.filePath || null, name: doc.name });
    });
    return out;
  }
  // The model id of the tool's chosen part (adding it to the drawing when needed).
  ensureModel(t) {
    if (t.model) return t.model;
    const c = t.choice;
    if (!c) return null;
    if (c.model) return (t.model = c.model);
    t.model = this.addModel({ name: c.name, path: c.path, doc: c.doc, tab: c.tab || null });
    return t.model;
  }
  async browsePart() {
    let file;
    try { file = await platform.openText(); } catch (err) { this.app.toast('Could not open file: ' + err.message, true); return; }
    if (!file || file.format) { if (file?.format) this.app.toast('Pick a RazorCAD part (.rcad) or assembly (.rasm); open a STEP / STL file first and save it', true); return; }
    let doc;
    try { doc = stripThumbnail(JSON.parse(file.content)); } catch { this.app.toast('That file is not a RazorCAD part or assembly', true); return; }
    if (!Array.isArray(doc.features) && doc.kind !== 'assembly') { this.app.toast('That file is not a RazorCAD part or assembly', true); return; }
    const name = doc.name || file.name.replace(/\.(rcad|rasm)$/i, '');
    const mid = this.addModel({ name, path: file.path || null, doc });
    if (this.tool) { this.tool.model = mid; this.tool.choice = { key: 'm:' + mid, model: mid, label: name }; this.tool.geom = null; }
    this.renderLeft();
    if (this.tool?.kind === 'model') this.modelPreview();
  }

  async modelPreview() {
    const t = this.tool;
    if (!t || t.kind !== 'model') return;
    const mid = this.ensureModel(t);
    if (!mid) return;
    const key = mid + t.orient;
    t.geomKey = key;
    let g;
    if (t.orient === 'flat') g = await this.previewGeom(mid, { flat: true, body: null, dir: [0, 0, 1], up: [0, 1, 0] });
    else { const o = D.ORIENTATIONS[t.orient]; g = await this.previewGeom(mid, { dir: o.dir, up: o.up }); }
    if (this.tool === t && t.orient === 'flat' && !g) { this.app.toast('This part has no sheet metal body to flatten', true); }
    if (this.tool !== t || t.geomKey !== key) return;
    t.geom = g;
    // the first view on an empty sheet picks a scale that fits the part
    if (g && !this.doc.views.some((v) => v.sheet === this.sheetId)) this.autoScale(g.box, t.orient === 'flat' ? 1.3 : 2.3);
    this.render();
  }

  // Choose the sheet scale so the part's standard views fit the sheet.
  autoScale(box, room = 2.3) {
    const f = frameRect(this.sheet, this.doc.format), tb = titleBlockRect(this.sheet, this.doc.format);
    const w = box.max[0] - box.min[0], h = box.max[1] - box.min[1];
    const d = Math.max(w, h);
    const availW = (f.x1 - f.x0) * 0.8, availH = (f.y1 - f.y0 - (tb.y1 - tb.y0)) * 0.85;
    // room for about two views across and two down (a flat pattern on its own needs less)
    const need = Math.max((room * d) / availW, (room * d) / availH);
    const scales = [[10, 1], [5, 1], [2, 1], [1, 1], [1, 2], [1, 2.5], [1, 5], [1, 10], [1, 20], [1, 50], [1, 100]];
    const pick = scales.find(([a, b]) => a / b <= 1 / need) || scales[scales.length - 1];
    this.sheet.scale = pick;
  }

  // Tool preview primitives drawn over the sheet.
  toolPrims() {
    const t = this.tool, P = this.mouse;
    const out = [];
    if (!t) return out;
    const ghost = (prims) => prims.map((p) => ({ ...p, color: '#1f6fd6' }));
    const geomPrims = (g, X, s) => {
      const list = [];
      for (const { k, g: e } of g.edges) {
        if (k !== 'v' && k !== 't') continue;
        if (e.t === 'l') list.push({ t: 'line', a: X(e.a), b: X(e.b), w: 0.25 });
        else if (e.t === 'c') list.push({ t: 'circle', c: X(e.c), r: e.r * s, w: 0.25 });
        else if (e.t === 'a') list.push({ t: 'poly', pts: D.arcPts(e.c, e.r, e.a0, e.a1).map(X), w: 0.25 });
        else list.push({ t: 'poly', pts: e.pts.map(X), w: 0.25 });
      }
      return list;
    };
    if (t.kind === 'model' && t.geom && P) {
      const s = D.sheetScale(this.doc, this.sheetId), b = t.geom.box;
      const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
      const X = (p) => [P[0] + (p[0] - cx) * s, P[1] - (p[1] - cy) * s];
      out.push(...ghost(geomPrims(t.geom, X, s)));
    }
    if (t.kind === 'projected' && t.parent && P && t.side && t.geoms?.[t.side]) {
      const p = D.findView(this.doc, t.parent);
      const s = D.viewScale(this.doc, p), g = t.geoms[t.side], b = g.box;
      const { x, y } = this.alignedPlace(p, t.side, b, P, s);
      out.push(...ghost(geomPrims(g, (q) => [x + q[0] * s, y - q[1] * s], s)));
    }
    if (t.kind === 'section' && t.parent) {
      const p = D.findView(this.doc, t.parent);
      const X = D.viewXform(this.doc, p);
      const line = t.a ? t : (P ? this.sectionLineAt(p, P) : null);
      if (line) out.push({ t: 'line', a: X.toSheet(line.la), b: X.toSheet(line.lb), w: 0.35, dash: [6, 1.5, 1.2, 1.5], color: '#1f6fd6' });
      if (t.a && P && t.side && t.geoms?.[t.side]) {
        const g = t.geoms[t.side], s = D.viewScale(this.doc, p);
        const { x, y } = this.sectionPlace(p, t, g.box, P, s);
        out.push(...ghost(geomPrims(g, (q) => [x + q[0] * s, y - q[1] * s], s)));
      }
    }
    if (t.kind === 'detail' && t.parent && P) {
      const p = D.findView(this.doc, t.parent);
      const X = D.viewXform(this.doc, p);
      if (t.c) {
        const C = X.toSheet(t.c);
        const r = t.r ? t.r * X.s : len2(sub2(P, C));
        out.push({ t: 'circle', c: C, r, w: 0.25, color: '#1f6fd6', dash: [2, 1] });
        if (t.r) {
          const s = X.s * 2;
          const R = t.r * s;
          out.push({ t: 'circle', c: P, r: R, w: 0.25, color: '#1f6fd6' });
          const g = D.viewGeom(this.doc, p, this.geos);
          if (g) out.push({ t: 'clip', circle: { c: P, r: R }, prims: ghost(geomPrims(g, (q) => [P[0] + (q[0] - t.c[0]) * s, P[1] - (q[1] - t.c[1]) * s], s)) });
        }
      }
    }
    if ((['dim', 'cmark', 'cline', 'note', 'callout', 'baseline', 'ordinate', 'chamferDim', 'aux'].includes(t.kind) || SYMBOL_TOOLS.includes(t.kind)) && t.hoverEnt) out.push(...entPrims(t.hoverEnt, '#e8892c'));
    if (['dim', 'cline', 'baseline', 'chamferDim'].includes(t.kind)) for (const pk of [...(t.picks || []), ...(t.base ? [t.base] : [])]) out.push(...entPrims(pk, '#1f6fd6'));
    if (t.kind === 'baseline' && t.base && t.picks?.length && P && !t.hoverEnt) {
      const a = this.dimFromPicks([t.base, t.picks[0]], P);
      if (a) { try { out.push(...D.annPrims(this.doc, a, {}).map((q) => ({ ...q, color: '#1f6fd6' }))); } catch { /* not drawable */ } }
    }
    // break / crop: the lines and rectangle being picked
    if ((t.kind === 'break' || t.kind === 'crop') && t.view && P) {
      const v = D.findView(this.doc, t.view), X = D.viewXform(this.doc, v), r = D.viewRect(this.doc, v, this.geos);
      if (t.kind === 'break') {
        for (const at of [t.a, X.toView(P)[t.axis === 'y' ? 1 : 0]].filter((x) => x != null)) {
          const q0 = t.axis === 'y' ? [X.toView([r.x0, 0])[0], at] : [at, X.toView([0, r.y0])[1]];
          const q1 = t.axis === 'y' ? [X.toView([r.x1, 0])[0], at] : [at, X.toView([0, r.y1])[1]];
          out.push({ t: 'line', a: X.toSheet(q0), b: X.toSheet(q1), w: 0.3, dash: [2, 1], color: '#1f6fd6' });
        }
      } else if (t.c0) {
        const A = X.toSheet(t.c0);
        out.push({ t: 'poly', pts: [A, [P[0], A[1]], P, [A[0], P[1]]], closed: true, w: 0.3, dash: [2, 1], color: '#1f6fd6' });
      }
    }
    if (t.kind === 'dim' && t.picks?.length && P && !t.hoverEnt) {
      const a = this.dimFromPicks(t.picks, P);
      if (a) { try { out.push(...D.annPrims(this.doc, a, {}).map((q) => ({ ...q, color: '#1f6fd6' }))); } catch { /* not drawable */ } }
    }
    return out;
  }

  toolMove(P) {
    const t = this.tool;
    if (t.kind === 'projected') {
      if (!t.parent) { const v = this.viewAt(P, 1); this.setHover(v && v.type !== 'detail' && v.type !== 'flat' ? v.id : null); return; }
      const p = D.findView(this.doc, t.parent);
      const r = D.viewRect(this.doc, p, this.geos);
      const c = [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];
      const d = sub2(P, c);
      const side = Math.abs(d[0]) > Math.abs(d[1]) ? (d[0] > 0 ? 'right' : 'left') : (d[1] > 0 ? 'down' : 'up');
      if (side !== t.side) { t.side = side; this.loadSideGeom(t, p, side); }
      this.render();
      return;
    }
    if (t.kind === 'section') {
      if (!t.parent) { const v = this.viewAt(P, 1); this.setHover(v && v.type !== 'detail' ? v.id : null); return; }
      if (t.a) {
        const p = D.findView(this.doc, t.parent);
        const X = D.viewXform(this.doc, p);
        const q = X.toView(P);
        const side = t.angled ? (((q[0] - t.a[0]) * -Math.sin((t.angle * Math.PI) / 180) + (q[1] - t.a[1]) * Math.cos((t.angle * Math.PI) / 180)) < 0 ? 'neg' : 'pos') : t.horizontal ? (q[1] < t.a[1] ? 'neg' : 'pos') : (q[0] < t.a[0] ? 'neg' : 'pos');
        if (side !== t.side) { t.side = side; this.loadSectionGeom(t, p, side); }
      }
      this.render();
      return;
    }
    if (t.kind === 'detail') {
      if (!t.parent) { const v = this.viewAt(P, 1); this.setHover(v?.id || null); return; }
      this.render();
      return;
    }
    if (t.kind === 'dim') { t.hoverEnt = this.entityAt(P); this.render(); return; }
    if (t.kind === 'cmark') { t.hoverEnt = this.entityAt(P, ['circle']); this.render(); return; }
    if (t.kind === 'cline') { t.hoverEnt = this.entityAt(P, ['line', 'point']); this.render(); return; }
    if (t.kind === 'note' || SYMBOL_TOOLS.includes(t.kind)) { t.hoverEnt = t.leader ? null : this.entityAt(P, ['line', 'circle', 'point']); this.render(); return; }
    if (t.kind === 'callout') { t.hoverEnt = this.entityAt(P, ['circle']); this.render(); return; }
    if (t.kind === 'baseline' || t.kind === 'ordinate') { t.hoverEnt = this.entityAt(P, t.kind === 'ordinate' ? ['point', 'circle'] : ['point', 'line', 'circle']); this.render(); return; }
    if (t.kind === 'chamferDim' || (t.kind === 'aux' && !t.parent)) { t.hoverEnt = t.picks?.length >= 2 ? null : this.entityAt(P, ['line']); this.render(); return; }
    if ((t.kind === 'break' || t.kind === 'crop') && !t.view) { const v = this.viewAt(P, 1); this.setHover(v && v.type !== 'detail' ? v.id : null); return; }
    this.render();
  }
  setHover(id) { if (id !== this.hover) { this.hover = id; } this.render(); }

  async loadSideGeom(t, p, side) {
    t.geoms ||= {};
    if (t.geoms[side] !== undefined) return;
    t.geoms[side] = null;
    const tmp = { id: 'tmp', type: 'projected', parent: p.id, side, sheet: p.sheet, model: p.model };
    const cam = D.viewCamera(this.doc, tmp);
    const g = await this.previewGeom(p.model, { dir: cam.dir, up: cam.y });
    if (this.tool === t) { t.geoms[side] = g; this.render(); }
  }
  alignedPlace(p, side, box, P, s) {
    const cx = (box.min[0] + box.max[0]) / 2, cy = (box.min[1] + box.max[1]) / 2;
    if (side === 'left' || side === 'right') return { x: P[0] - cx * s, y: p.y };
    return { x: p.x, y: P[1] + cy * s };
  }

  sectionLineAt(p, P) {
    const X = D.viewXform(this.doc, p);
    // snap the line to circle centres and points nearby
    const ent = this.entityAt(P, ['point']);
    const q = ent && ent.view === p.id ? ent.p : X.toView(P);
    const g = D.viewGeom(this.doc, p, this.geos);
    const b = g?.box || { min: [q[0] - 10, q[1] - 10], max: [q[0] + 10, q[1] + 10] };
    const m = 4 / X.s;
    if (this.tool.angled) {
      // (at an angle: through the point, across the whole view)
      const t = (this.tool.angle * Math.PI) / 180, d = [Math.cos(t), Math.sin(t)];
      const ts = [[b.min[0], b.min[1]], [b.max[0], b.min[1]], [b.min[0], b.max[1]], [b.max[0], b.max[1]]].map((c) => (c[0] - q[0]) * d[0] + (c[1] - q[1]) * d[1]);
      const t0 = Math.min(...ts) - m, t1 = Math.max(...ts) + m;
      return { q, la: [q[0] + d[0] * t0, q[1] + d[1] * t0], lb: [q[0] + d[0] * t1, q[1] + d[1] * t1] };
    }
    const la = this.tool.horizontal ? [b.min[0] - m, q[1]] : [q[0], b.min[1] - m];
    const lb = this.tool.horizontal ? [b.max[0] + m, q[1]] : [q[0], b.max[1] + m];
    return { q, la, lb };
  }
  sectionSpec(t, side) {
    // the arrows point to where the view is placed
    if (t.angled) {
      const a = (t.angle * Math.PI) / 180, k = side === 'pos' ? 1 : -1;
      return { a: t.la, b: t.lb, arrow: [-Math.sin(a) * k, Math.cos(a) * k], horizontal: Math.abs(Math.cos(a)) >= Math.abs(Math.sin(a)), angle: t.angle, letter: t.letter };
    }
    const arrow = t.horizontal ? [0, side === 'pos' ? 1 : -1] : [side === 'pos' ? 1 : -1, 0];
    return { a: t.la, b: t.lb, arrow, horizontal: t.horizontal, letter: t.letter };
  }
  async loadSectionGeom(t, p, side) {
    t.geoms ||= {};
    if (t.geoms[side] !== undefined) return;
    t.geoms[side] = null;
    const tmp = { id: 'tmp', type: 'section', parent: p.id, sheet: p.sheet, model: p.model, section: this.sectionSpec(t, side) };
    const req = D.viewRequest(this.doc, tmp);
    const g = await this.previewGeom(p.model, req);
    if (this.tool === t) { t.geoms[side] = g; this.render(); }
  }
  sectionPlace(p, t, box, P, s) {
    const cx = (box.min[0] + box.max[0]) / 2, cy = (box.min[1] + box.max[1]) / 2;
    if (t.angled) return { x: P[0] - cx * s, y: P[1] + cy * s };
    if (t.horizontal) return { x: p.x, y: P[1] + cy * s };
    return { x: P[0] - cx * s, y: p.y };
  }

  async toolClick(P, e) {
    const t = this.tool;
    if (t.kind === 'model') {
      if (!t.geom) { this.app.toast('Pick a part first (the view is still being made)', true); return; }
      const mid = this.ensureModel(t);
      const s = D.sheetScale(this.doc, this.sheetId), b = t.geom.box;
      const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
      const flat = t.orient === 'flat';
      const v = flat
        ? { id: D.newId(this.doc, 'v'), name: 'Flat Pattern', type: 'flat', model: mid, sheet: this.sheetId, body: t.geom.flat?.body || null, bendLines: true, bendNotes: true, bendRegion: false, x: P[0] - cx * s, y: P[1] + cy * s, scale: null }
        : { id: D.newId(this.doc, 'v'), name: this.nextViewName(), type: 'model', model: mid, sheet: this.sheetId, orient: t.orient, style: t.style || 'hlr', tangent: true, x: P[0] - cx * s, y: P[1] + cy * s, scale: null };
      this.doc.views.push(v);
      this.geos.set(v.id, t.geom);
      this.geoKeys.delete(v.id);
      this.changed();
      if (flat) { this.cancelTool(); return; }
      // carry on placing projected views from it
      if (!['iso', 'dimetric', 'trimetric'].includes(t.orient)) this.startTool('projected', { parent: v.id });
      else this.cancelTool();
      return;
    }
    if (t.kind === 'std3') { await this.placeStandard3(t, P); return; }
    if (t.kind === 'projected') {
      if (!t.parent) {
        const v = this.viewAt(P, 1);
        if (v && v.type !== 'detail' && v.type !== 'flat') { t.parent = v.id; this.toolHint(); this.renderLeft(); }
        return;
      }
      const g = t.side && t.geoms?.[t.side];
      if (!g) return;
      const p = D.findView(this.doc, t.parent);
      const s = D.viewScale(this.doc, p);
      const { x, y } = this.alignedPlace(p, t.side, g.box, P, s);
      const v = { id: D.newId(this.doc, 'v'), name: this.nextViewName(), type: 'projected', parent: p.id, side: t.side, model: p.model, sheet: p.sheet, style: p.style || 'hlr', tangent: p.tangent !== false, x, y, scale: null };
      this.doc.views.push(v);
      this.geos.set(v.id, g);
      this.changed();
      t.geoms = {}; t.side = null;
      return;
    }
    if (t.kind === 'section') {
      if (!t.parent) {
        const v = this.viewAt(P, 1);
        if (v && v.type !== 'detail' && v.type !== 'flat') { t.parent = v.id; this.toolHint(); this.renderLeft(); }
        return;
      }
      const p = D.findView(this.doc, t.parent);
      if (!t.a) {
        const L = this.sectionLineAt(p, P);
        t.a = L.q; t.la = L.la; t.lb = L.lb; t.letter = D.nextLetter(this.doc);
        t.geoms = {}; t.side = null;
        this.toolHint();
        return;
      }
      const g = t.side && t.geoms?.[t.side];
      if (!g) return;
      const s = D.viewScale(this.doc, p);
      const { x, y } = this.sectionPlace(p, t, g.box, P, s);
      const v = { id: D.newId(this.doc, 'v'), name: `Section View ${t.letter}-${t.letter}`, type: 'section', parent: p.id, model: p.model, sheet: p.sheet, style: 'hlr', tangent: p.tangent !== false, x, y, scale: null, section: this.sectionSpec(t, t.side) };
      this.doc.views.push(v);
      this.geos.set(v.id, g);
      this.changed();
      this.cancelTool();
      return;
    }
    if (t.kind === 'detail') {
      if (!t.parent) { const v = this.viewAt(P, 1); if (v) { t.parent = v.id; this.toolHint(); this.renderLeft(); } return; }
      const p = D.findView(this.doc, t.parent);
      const X = D.viewXform(this.doc, p);
      if (!t.c) { t.c = X.toView(P); this.toolHint(); return; }
      if (!t.r) { t.r = Math.max(1 / X.s, len2(sub2(P, X.toSheet(t.c))) / X.s); this.toolHint(); return; }
      const letter = D.nextLetter(this.doc);
      const v = { id: D.newId(this.doc, 'v'), name: `Detail View ${letter}`, type: 'detail', parent: p.id, model: p.model, sheet: p.sheet, x: P[0], y: P[1], scale: null, detail: { c: t.c, r: t.r, letter } };
      const k = D.viewScale(this.doc, p) * 2;
      v.scale = scaleOf(k);
      this.doc.views.push(v);
      this.changed();
      this.cancelTool();
      return;
    }
    if (t.kind === 'dim') {
      const ent = this.entityAt(P);
      if (ent && t.picks.length < 2 && !(t.picks[0] && t.picks[0].view !== ent.view)) {
        t.picks.push(ent);
        // one circle, or two items: wait for the placement click
        this.render();
        return;
      }
      if (!t.picks.length) return;
      const a = this.dimFromPicks(t.picks, P);
      t.picks = [];
      if (a) { a.id = D.newId(this.doc, 'a'); this.doc.anns.push(a); this.changed(); }
      return;
    }
    if (t.kind === 'cmark') {
      const ent = this.entityAt(P, ['circle']);
      if (!ent) return;
      const v = D.findView(this.doc, ent.view);
      this.doc.anns.push({ id: D.newId(this.doc, 'a'), type: 'cmark', sheet: v.sheet, view: v.id, c: ent.c, r: ent.r });
      this.changed();
      return;
    }
    if (t.kind === 'cline') {
      const ent = this.entityAt(P, ['line', 'point']);
      if (!ent) return;
      if (t.picks[0] && t.picks[0].view !== ent.view) return;
      t.picks.push(ent);
      if (t.picks.length < 2) { this.render(); return; }
      const [e1, e2] = t.picks;
      t.picks = [];
      let a, b;
      if (e1.kind === 'line' && e2.kind === 'line') {
        const foot = (p, l) => { const d = unit2(sub2(l.b, l.a)); return add2(l.a, mul2(d, dot2(sub2(p, l.a), d))); };
        a = mul2(add2(e1.a, foot(e1.a, e2)), 0.5);
        b = mul2(add2(e1.b, foot(e1.b, e2)), 0.5);
      } else {
        a = e1.kind === 'line' ? mul2(add2(e1.a, e1.b), 0.5) : e1.p;
        b = e2.kind === 'line' ? mul2(add2(e2.a, e2.b), 0.5) : e2.p;
      }
      if (len2(sub2(a, b)) < 1e-6) return;
      const v = D.findView(this.doc, e1.view);
      this.doc.anns.push({ id: D.newId(this.doc, 'a'), type: 'cline', sheet: v.sheet, view: v.id, a, b });
      this.changed();
      return;
    }
    if (t.kind === 'callout') {
      const ent = t.ent ? null : this.entityAt(P, ['circle']);
      if (!t.ent) { if (ent) { t.ent = ent; this.app.status('Click where the hole callout goes.'); } return; }
      const e2 = t.ent, v = D.findView(this.doc, e2.view), X = D.viewXform(this.doc, v);
      const tip = add2(e2.c, mul2(unit2(sub2(X.toView(P), e2.c)), e2.r));
      const a = { id: D.newId(this.doc, 'a'), type: 'note', sheet: v.sheet, view: v.id, leader: tip, text: this.holeCallout(v, e2), h: this.doc.settings.textH, pos: [0, 0] };
      D.setAnnPos(this.doc, a, P);
      this.doc.anns.push(a);
      t.ent = null;
      this.changed();
      return;
    }
    if (t.kind === 'baseline') {
      const ent = this.entityAt(P);
      if (!t.base) { if (ent) { t.base = ent; this.toolHint(); this.render(); } return; }
      if (ent && t.last) {
        // stacked one row further out than the last
        if (ent.view !== t.base.view) return;
        const L = t.last, Lp = D.annPos(this.doc, L), v = D.findView(this.doc, L.view), X = D.viewXform(this.doc, v);
        const d = L.orient === 'h' ? X.ay : L.orient === 'v' ? X.ax : [0, 1];
        const f1 = X.toSheet(L.p1), side = Math.sign(dot2(sub2(Lp, f1), d)) || 1;
        const Pn = add2(Lp, mul2(d, side * (this.doc.settings.textH || 3.5) * 2.2));
        const a = this.dimFromPicks([t.base, ent], Pn);
        if (!a) return;
        a.orient = L.orient;
        a.id = D.newId(this.doc, 'a');
        this.doc.anns.push(a); t.last = a;
        this.changed();
        return;
      }
      if (ent && !t.picks.length) { if (ent.view === t.base.view) { t.picks = [ent]; this.render(); } return; }
      if (!t.picks.length) return;
      const a = this.dimFromPicks([t.base, t.picks[0]], P);
      t.picks = [];
      if (!a) return;
      a.id = D.newId(this.doc, 'a');
      this.doc.anns.push(a); t.last = a;
      this.toolHint();
      this.changed();
      return;
    }
    if (t.kind === 'ordinate') {
      const ent = this.entityAt(P, ['point', 'circle']);
      const ptOf = (e2) => (e2.kind === 'circle' ? e2.c : e2.p);
      if (!t.o) { if (ent) { t.o = ptOf(ent); t.view = ent.view; this.toolHint(); } return; }
      const v = D.findView(this.doc, t.view);
      if (!v) { this.cancelTool(); return; }
      if (t.row == null) {
        // the row (or column) of values, and the origin's zero
        const X = D.viewXform(this.doc, v), q = X.toView(P);
        t.row = q;
        const a = { id: D.newId(this.doc, 'a'), type: 'ordinate', sheet: v.sheet, view: v.id, o: t.o, p: t.o, axis: t.axis, pos: [0, 0] };
        D.setAnnPos(this.doc, a, P);
        this.doc.anns.push(a);
        this.toolHint();
        this.changed();
        return;
      }
      if (!ent || ent.view !== t.view) return;
      const p = ptOf(ent), X = D.viewXform(this.doc, v);
      // on the row: across from the point
      const rowP = t.axis === 'y' ? [t.row[0], p[1]] : [p[0], t.row[1]];
      const a = { id: D.newId(this.doc, 'a'), type: 'ordinate', sheet: v.sheet, view: v.id, o: t.o, p, axis: t.axis, pos: [0, 0] };
      D.setAnnPos(this.doc, a, X.toSheet(rowP));
      this.doc.anns.push(a);
      this.changed();
      return;
    }
    if (t.kind === 'chamferDim') {
      if (t.picks.length < 2) {
        const ent = this.entityAt(P, ['line']);
        if (!ent || (t.picks[0] && ent.view !== t.picks[0].view)) return;
        t.picks.push(ent); this.toolHint(); this.render();
        return;
      }
      const [c, e2] = t.picks, v = D.findView(this.doc, c.view);
      const dc = unit2(sub2(c.b, c.a)), de = unit2(sub2(e2.b, e2.a));
      const ang = (Math.acos(Math.min(1, Math.abs(dot2(dc, de)))) * 180) / Math.PI, L = len2(sub2(c.b, c.a));
      const dist = L * Math.cos((ang * Math.PI) / 180);
      const a = { id: D.newId(this.doc, 'a'), type: 'note', sheet: v.sheet, view: v.id, leader: mul2(add2(c.a, c.b), 0.5), text: `${D.fmtLen(dist, this.doc)} × ${D.fmtNum(ang, { settings: { ...this.doc.settings, decimals: 1 } })}°`, h: this.doc.settings.textH, pos: [0, 0] };
      D.setAnnPos(this.doc, a, P);
      this.doc.anns.push(a);
      t.picks = [];
      this.toolHint();
      this.changed();
      return;
    }
    if (SYMBOL_TOOLS.includes(t.kind)) {
      const ent = t.leader ? null : this.entityAt(P, ['line', 'circle', 'point']);
      if (ent && !t.leader) {
        const v = D.findView(this.doc, ent.view), X = D.viewXform(this.doc, v);
        const tip = ent.kind === 'point' ? ent.p : ent.kind === 'circle' ? add2(ent.c, mul2(unit2(sub2(X.toView(P), ent.c)), ent.r)) : footOnSeg(X.toView(P), ent.a, ent.b);
        t.leader = { view: v.id, p: tip };
        this.app.status('Click where it goes.');
        return;
      }
      const a = { id: D.newId(this.doc, 'a'), type: t.kind, sheet: this.sheetId, pos: P };
      if (t.kind === 'datum') a.letter = this.nextDatum();
      if (!(await this.symbolDialog(a))) { t.leader = null; return; }
      if (t.leader) { a.view = t.leader.view; a.leader = t.leader.p; D.setAnnPos(this.doc, a, P); }
      t.leader = null;
      this.doc.anns.push(a);
      this.changed();
      return;
    }
    if (t.kind === 'aux') {
      if (!t.parent) {
        const ent = this.entityAt(P, ['line']);
        if (!ent) return;
        const v = D.findView(this.doc, ent.view);
        if (!v || v.type === 'detail' || v.type === 'flat') return;
        t.parent = v.id; t.e = unit2(sub2(ent.b, ent.a)); t.mid = mul2(add2(ent.a, ent.b), 0.5);
        // (the edge's direction picked so the view stays upright on the sheet)
        if (t.e[0] < -1e-9 || (Math.abs(t.e[0]) <= 1e-9 && t.e[1] < 0)) t.e = mul2(t.e, -1);
        this.toolHint();
        return;
      }
      const p = D.findView(this.doc, t.parent), X = D.viewXform(this.doc, p);
      let n = [-t.e[1], t.e[0]];
      if (dot2(sub2(X.toView(P), t.mid), n) < 0) n = mul2(n, -1);
      const letter = D.nextLetter(this.doc);
      const rot = (p.rot || 0) + (Math.atan2(t.e[1], t.e[0]) * 180) / Math.PI;
      const v = { id: D.newId(this.doc, 'v'), name: `Auxiliary View ${letter}`, type: 'aux', parent: p.id, model: p.model, sheet: p.sheet, style: p.style || 'hlr', tangent: p.tangent !== false, x: P[0], y: P[1], scale: null, rot: +(((rot % 360) + 540) % 360 - 180).toFixed(4), aux: { e: t.e, n, letter } };
      this.doc.views.push(v);
      this.pendingCentre ||= new Map();
      this.pendingCentre.set(v.id, P);
      this.changed();
      this.cancelTool();
      return;
    }
    if (t.kind === 'break' || t.kind === 'crop') {
      if (!t.view) { const v = this.viewAt(P, 1); if (v && v.type !== 'detail') { t.view = v.id; this.toolHint(); } return; }
      const v = D.findView(this.doc, t.view), X = D.viewXform(this.doc, v), q = X.toView(P);
      if (t.kind === 'break') {
        const at = q[t.axis === 'y' ? 1 : 0];
        if (t.a == null) { t.a = at; this.toolHint(); this.render(); return; }
        const a = Math.min(t.a, at), b = Math.max(t.a, at);
        if (b - a < 1e-6) return;
        const keep = this.viewCentre(v);
        v.brk = { axis: t.axis, a, b };
        this.recentre(v, keep);
        this.changed();
        this.cancelTool();
        return;
      }
      if (!t.c0) { t.c0 = q; this.toolHint(); return; }
      const keep = this.viewCentre(v);
      v.crop = { x0: Math.min(t.c0[0], q[0]), y0: Math.min(t.c0[1], q[1]), x1: Math.max(t.c0[0], q[0]), y1: Math.max(t.c0[1], q[1]) };
      this.recentre(v, keep);
      this.changed();
      this.cancelTool();
      return;
    }
    if (t.kind === 'balloon') {
      if (!t.leader) {
        // the point on a part: its item number from the bill of materials (worked out while the balloon is placed)
        const v = this.viewAt(P, 1);
        if (!v || v.type === 'flat') { this.app.status('Click on a part in a view.'); return; }
        const X = D.viewXform(this.doc, v), p = X.toView(P);
        t.leader = { view: v.id, p };
        const m = this.viewModel(v.type === 'detail' ? D.findView(this.doc, v.parent) || v : v);
        const req = D.viewRequest(this.doc, v) || D.viewRequest(this.doc, D.findView(this.doc, v.parent));
        const mj = m?.doc ? JSON.stringify(m.doc) : '';
        t.item = m?.doc?.kind === 'assembly' && req ? this.kernel().request('drawingPick', { doc: mj, view: { dir: req.dir, up: req.up }, p }, 'dwg:' + mj.length + ':' + hash(mj))
          .then((id) => (id ? bomItemOf(m.doc, String(id).split('/')[0]) : null)).catch(() => null) : Promise.resolve(m?.doc?.kind === 'assembly' ? null : '1');
        this.app.status('Click where the balloon goes.');
        this.render();
        return;
      }
      const leader = t.leader;
      t.leader = null;
      let item = await t.item;
      if (!item) {
        const used = this.doc.anns.filter((x) => x.type === 'balloon').map((x) => +x.item).filter(Number.isFinite);
        item = (await this.app.ui.promptText('Balloon', 'balloon', 'Item number (the part could not be told at that point)', String((used.length ? Math.max(...used) : 0) + 1)))?.trim();
        if (!item) return;
      }
      const a = { id: D.newId(this.doc, 'a'), type: 'balloon', sheet: this.sheetId, view: leader.view, leader: leader.p, item, h: this.doc.settings.textH, pos: [0, 0] };
      D.setAnnPos(this.doc, a, P);
      this.doc.anns.push(a);
      this.changed();
      this.app.status(`Balloon ${item} placed. Click the next part, or Esc to finish.`);
      return;
    }
    if (t.kind === 'note') {
      const ent = t.leader ? null : this.entityAt(P, ['line', 'circle', 'point']);
      if (ent && !t.leader) {
        // a leader to this edge; the next click places the text
        const v = D.findView(this.doc, ent.view), X = D.viewXform(this.doc, v);
        const tip = ent.kind === 'point' ? ent.p : ent.kind === 'circle' ? add2(ent.c, mul2(unit2(sub2(X.toView(P), ent.c)), ent.r)) : footOnSeg(X.toView(P), ent.a, ent.b);
        t.leader = { view: v.id, p: tip };
        this.app.status('Click where the note text goes.');
        return;
      }
      const text = await this.app.ui.promptText?.('Note', 'note', 'Note text', '', true);
      if (!text) { t.leader = null; return; }
      const a = { id: D.newId(this.doc, 'a'), type: 'note', sheet: this.sheetId, text, pos: P, h: this.doc.settings.textH };
      if (t.leader) { a.view = t.leader.view; a.leader = t.leader.p; D.setAnnPos(this.doc, a, P); }
      t.leader = null;
      this.doc.anns.push(a);
      this.changed();
      this.cancelTool();
    }
  }

  // The callout text of a hole (circle `e` in view v): from the Hole feature when it made the hole,
  // else the diameter. Holes of the same kind in the view are counted (4× …).
  holeCallout(v, e) {
    const g = D.viewGeom(this.doc, v, this.geos), f = (x) => D.fmtLen(x, this.doc);
    const holes = g?.holes || [];
    const tol = Math.max(1e-4, e.r * 1e-3);
    const h = holes.find((x) => len2(sub2(x.c, e.c)) < tol);
    if (!h) {
      const same = (g?.edges || []).filter(({ k, g: q }) => k === 'v' && q.t === 'c' && Math.abs(q.r - e.r) < tol).length;
      return `${same > 1 ? `${same}× ` : ''}Ø${f(2 * e.r)}`;
    }
    const key = (x) => JSON.stringify([x.sizes, x.through, x.depth, x.thread]);
    const n = holes.filter((x) => key(x) === key(h)).length;
    const z = h.sizes, depth = h.through ? 'THRU ALL' : `DEEP ${f(h.depth)}`;
    const lines = [];
    if (h.thread) {
      lines.push(`${h.thread.label} ${h.through ? 'THRU ALL' : `DEEP ${f(h.thread.depth ?? h.depth)}`}`);
      lines.push(`TAP DRILL Ø${f(z.d)} ${depth}`);
    } else {
      lines.push(`Ø${f(z.d)} ${depth}`);
      if (z.type === 'cbore') lines.push(`CBORE Ø${f(z.cbD)} DEEP ${f(z.cbDepth)}`);
      if (z.type === 'csink') lines.push(`CSK Ø${f(z.csD)} × ${D.fmtNum(z.csAng, this.doc)}°`);
    }
    if (n > 1) lines[0] = `${n}× ${lines[0]}`;
    return lines.join('\n');
  }

  nextDatum() {
    const used = new Set(this.doc.anns.filter((a) => a.type === 'datum').map((a) => a.letter));
    for (const c of 'ABCDEFGHJKLMNPRSTUVWXYZ') if (!used.has(c)) return c;
    return 'Z';
  }

  // Parameters of a datum / GD&T frame / surface finish / weld symbol; resolves true when OK'd.
  symbolDialog(a) {
    return new Promise((resolve) => {
      const box = el('div', { class: 'dw-form' });
      const opts = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(cur ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('');
      let title = 'Symbol', ic = 'note';
      if (a.type === 'datum') {
        title = 'Datum Feature'; ic = 'datum';
        box.innerHTML = `<div class="kv"><div class="k">Letter</div><div><input type="text" data-k="letter" maxlength="2" value="${esc(a.letter || 'A')}"></div></div>`;
      } else if (a.type === 'fcf') {
        title = 'Geometric Tolerance'; ic = 'gdt';
        const d = a.datums || [];
        box.innerHTML = `<div class="kv">
          <div class="k">Characteristic</div><div><select data-k="sym">${opts(D.GDT_SYMBOLS, a.sym || 'position')}</select></div>
          <div class="k">Tolerance</div><div><input type="text" data-k="tol" value="${esc(a.tol ?? '0.1')}"></div>
          <div class="k">Diameter zone (Ø)</div><div><input type="checkbox" data-k="dia" ${a.dia ? 'checked' : ''}></div>
          <div class="k">Material condition</div><div><select data-k="mod">${opts([['', 'None'], ['Ⓜ', 'Maximum (M)'], ['Ⓛ', 'Least (L)']].map(([v, l]) => [v === 'Ⓜ' ? '(M)' : v === 'Ⓛ' ? '(L)' : '', l]), a.mod || '')}</select></div>
          <div class="k">Primary datum</div><div><input type="text" data-k="d0" maxlength="3" value="${esc(d[0] || '')}"></div>
          <div class="k">Secondary datum</div><div><input type="text" data-k="d1" maxlength="3" value="${esc(d[1] || '')}"></div>
          <div class="k">Tertiary datum</div><div><input type="text" data-k="d2" maxlength="3" value="${esc(d[2] || '')}"></div></div>`;
      } else if (a.type === 'sfin') {
        title = 'Surface Finish'; ic = 'surfFinish';
        box.innerHTML = `<div class="kv">
          <div class="k">Symbol</div><div><select data-k="kind">${opts([['any', 'Basic (any process)'], ['removal', 'Machining required'], ['noremoval', 'Machining not allowed']], a.kind || 'removal')}</select></div>
          <div class="k">Roughness / text</div><div><input type="text" data-k="text" value="${esc(a.text ?? 'Ra 1.6')}"></div></div>`;
      } else if (a.type === 'weld') {
        title = 'Weld Symbol'; ic = 'weld';
        box.innerHTML = `<div class="kv">
          <div class="k">Weld</div><div><select data-k="wtype">${opts([['fillet', 'Fillet'], ['square', 'Square butt'], ['v', 'V butt'], ['bevel', 'Bevel butt'], ['plug', 'Plug / slot']], a.wtype || 'fillet')}</select></div>
          <div class="k">Side</div><div><select data-k="side">${opts([['arrow', 'Arrow side'], ['other', 'Other side'], ['both', 'Both sides']], a.side || 'arrow')}</select></div>
          <div class="k">Size</div><div><input type="text" data-k="size" value="${esc(a.size ?? '5')}"></div>
          <div class="k">Length (- pitch)</div><div><input type="text" data-k="length" value="${esc(a.length ?? '')}"></div>
          <div class="k">All around</div><div><input type="checkbox" data-k="allAround" ${a.allAround ? 'checked' : ''}></div>
          <div class="k">Field weld</div><div><input type="checkbox" data-k="field" ${a.field ? 'checked' : ''}></div>
          <div class="k">Tail (process)</div><div><input type="text" data-k="tail" value="${esc(a.tail ?? '')}"></div></div>`;
      }
      let done = false;
      const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
      const read = () => {
        box.querySelectorAll('[data-k]').forEach((i) => {
          const k = i.dataset.k, v = i.type === 'checkbox' ? i.checked : i.value.trim();
          if (k === 'd0' || k === 'd1' || k === 'd2') { a.datums ||= ['', '', '']; a.datums[+k[1]] = v.toUpperCase(); } else a[k] = k === 'letter' ? (v || 'A').toUpperCase() : v;
        });
        if (a.datums) a.datums = a.datums.filter(Boolean);
      };
      const dlg = this.app.ui.modal(title, ic, box, [{ label: 'OK', primary: true, action: () => { read(); finish(true); } }, { label: 'Cancel', action: () => finish(false) }]);
      const obs = new MutationObserver(() => { if (!document.contains(dlg.body)) { obs.disconnect(); finish(false); } });
      obs.observe(document.getElementById('modal-root'), { childList: true });
    });
  }

  // A bill of materials table of the drawing's assembly (of the selected view, else the first assembly), at
  // the top right of the sheet's frame.
  // Auto Dimension: the dimensions the selected views (or all of the sheet's) need, placed round them; each size
  // once (the front view's first), none that a view's own dimensions give already. One undo step.
  // Auto Dimension's options (kept with the preferences): the style of the hole positions, a tolerance for the
  // new lengths and diameters, overlapping texts spread, which kinds of dimension
  autoDimensionDialog() {
    const ui = this.app.ui, o = { ...AUTO_DIM_DEFAULTS, ...(ui.prefs?.autoDim || {}) };
    const box = el('div', { class: 'dw-form' });
    box.innerHTML = `<div class="kv">
      <div class="k">Positions</div><div><select data-k="style"><option value="baseline">Baseline (each from the edge)</option><option value="chain">Chain (feature to feature)</option><option value="ordinate">Ordinate (values from a corner)</option></select></div>
      <div class="k">Tolerance</div><div><input type="text" data-k="tol" placeholder="none, e.g. ±0.1"></div>
      <div class="k">Add</div><div class="ad-kinds">${[['overall', 'Overall sizes'], ['holes', 'Hole diameters'], ['positions', 'Hole positions'], ['radii', 'Arc radii']].map(([k, l]) => `<label><input type="checkbox" data-k="${k}"> ${esc(l)}</label>`).join('')}</div>
      <div class="k"></div><div><label class="ad-check"><input type="checkbox" data-k="spread"> Spread labels that would overlap</label></div></div>
      <div class="pm-hint">For the selected views, or every view on the sheet. Sizes already given in a view are not added again; Ctrl+Z takes them all away.</div>`;
    box.querySelectorAll('[data-k]').forEach((i) => { const k = i.dataset.k; if (i.type === 'checkbox') i.checked = !!o[k]; else i.value = o[k] ?? ''; i.addEventListener('keydown', (e) => e.stopPropagation()); });
    ui.modal('Auto Dimension', 'autoDim', box, [
      { label: 'Dimension', primary: true, action: () => {
        box.querySelectorAll('[data-k]').forEach((i) => { const k = i.dataset.k; o[k] = i.type === 'checkbox' ? i.checked : i.value.trim(); });
        ui.prefs ||= {};
        ui.prefs.autoDim = o;
        ui.savePrefs();
        this.autoDimension(o);
      } },
      { label: 'Cancel' },
    ]);
  }
  autoDimension(opts = null) {
    const sel = this.doc.views.filter((v) => this.selected.has(v.id) && v.sheet === this.sheetId);
    const views = sel.length ? sel : this.doc.views.filter((v) => v.sheet === this.sheetId);
    if (!views.length) { this.app.toast('Place a view of a part first', true); return 0; }
    if (views.some((v) => !D.viewGeom(this.doc, v, this.geos))) { this.app.toast('The views are still being drawn: try again in a moment', true); return 0; }
    // (models in the order of their first view; a model view before the views projected from it)
    const order = (v) => (v.type === 'model' || v.type === 'flat' ? 0 : 1);
    const list = [...views].sort((p, q) => order(p) - order(q));
    const anns = autoDims(this.doc, list, this.geos, new Set(), opts || this.app.ui.prefs?.autoDim || {});
    for (const a of anns) { a.id = D.newId(this.doc, 'a'); this.doc.anns.push(a); }
    if (anns.length) this.changed();
    this.app.status(anns.length ? `${anns.length} dimension${anns.length === 1 ? '' : 's'} added${sel.length ? ' to the selected view' + (sel.length > 1 ? 's' : '') : ''}. Drag them to tidy up; Ctrl+Z takes them all away.` : 'Nothing more to dimension: the views have the sizes already.');
    return anns.length;
  }

  // Check Drawing: what the drawing still lacks (title block fields, views without dimensions, sizes not
  // dimensioned), listed by importance; clicking one shows its view or annotation. Add Missing Dimensions puts in
  // what Auto Dimension would.
  checkDrawingDialog() {
    if (this.doc.views.some((v) => !D.viewGeom(this.doc, v, this.geos))) { this.app.toast('The views are still being drawn: try again in a moment', true); return null; }
    const r = checkDrawing(this.doc, this.geos);
    const ui = this.app.ui, wrap = document.createElement('div');
    wrap.className = 'dc-wrap';
    const n = { error: 0, warn: 0, info: 0 };
    for (const it of r.items) n[it.level]++;
    const head = document.createElement('p');
    head.innerHTML = r.items.some((x) => x.level !== 'info') ? `<b>${n.error}</b> to fix, <b>${n.warn}</b> to look at${n.info ? `, ${n.info} note${n.info === 1 ? '' : 's'}` : ''}. Click one to show it.` : '<b>Nothing to fix.</b>' + (n.info ? ` ${n.info} note${n.info === 1 ? '' : 's'}:` : ' The title block is filled in and the views are dimensioned.');
    wrap.appendChild(head);
    let group = null;
    for (const it of r.items.sort((p, q) => p.group.localeCompare(q.group) || ['error', 'warn', 'info'].indexOf(p.level) - ['error', 'warn', 'info'].indexOf(q.level))) {
      if (it.group !== group) { group = it.group; const h = document.createElement('div'); h.className = 'dc-group'; h.textContent = tr(group); wrap.appendChild(h); }
      const row = document.createElement('button');
      row.className = 'dc-item dc-' + it.level;
      row.innerHTML = `<span class="dc-dot"></span><span></span>`;
      row.lastChild.textContent = it.text;
      row.title = it.level === 'error' ? 'To fix' : it.level === 'warn' ? 'To look at' : 'A note';
      row.onclick = () => this.showCheckItem(it);
      wrap.appendChild(row);
    }
    const missing = [...r.missing.values()].reduce((t, x) => t + x.length, 0);
    const buttons = [];
    if (missing) buttons.push({ label: `Add Missing Dimensions (${missing})`, action: () => { this.selected = new Set(r.missing.keys()); const sheet = this.sheetId; for (const s of new Set([...r.missing.keys()].map((id) => this.doc.views.find((v) => v.id === id)?.sheet))) { this.sheetId = s; this.autoDimension(); } this.sheetId = sheet; this.selected.clear(); this.renderAll(); } });
    if (r.items.some((x) => x.fix === 'props')) buttons.push({ label: 'Title Block…', action: () => { setTimeout(() => this.propsDialog(), 0); } });
    buttons.push({ label: 'Close', primary: true });
    ui.modal('Check Drawing', 'drawCheck', wrap, buttons);
    this.app.status(r.items.length ? `Check Drawing: ${n.error} to fix, ${n.warn} to look at.` : 'Check Drawing: nothing to fix.');
    return r;
  }
  // a check's view or annotation shown (selected, on its sheet)
  showCheckItem(it) {
    const id = it.ann || it.view, sheet = (it.ann ? this.doc.anns.find((a) => a.id === it.ann) : this.doc.views.find((v) => v.id === it.view))?.sheet;
    if (!id) { if (it.fix === 'props') this.propsDialog(); return; }
    if (sheet && sheet !== this.sheetId) { this.sheetId = sheet; this.fit?.(); }
    this.selected = new Set([id]);
    this.renderAll();
  }

  // The BOM table's columns: what each shows (a field, a custom property of the parts, or values typed in here),
  // its heading and width, in order; typed values are entered in the grid below.
  // a value typed into a BOM table cell
  async editBomValue(ann, col, row) {
    const cols = JSON.parse(JSON.stringify(D.bomColumns(ann))), c = cols[col];
    const t = await this.app.ui.promptText(c.title, 'bom', `${row.name}`, c.values?.[row.key] ?? '');
    if (t == null) return;
    (c.values ||= {})[row.key] = t;
    ann.cols = cols;
    this.changed();
  }
  bomColumnsDialog(ann) {
    const m = this.doc.models.find((x) => x.id === ann.model);
    const rows = bomRows(m?.doc).filter((r) => ann.indented || !r.depth);
    const props = bomPropNames(m?.doc);
    let cols = JSON.parse(JSON.stringify(D.bomColumns(ann)));
    const sources = () => bomSources(props, cols);
    const label = (k) => sources().find((x) => x[0] === k)?.[1] || k;
    const box = el('div', { class: 'bomcols' });
    const render = () => {
      const typed = cols.map((c, i) => [c, i]).filter(([c]) => c.key === 'text');
      box.innerHTML = `<table class="bc-table"><tr><th>Shows</th><th>Heading</th><th>Width</th><th></th></tr>${cols.map((c, i) => `<tr>
        <td><select data-i="${i}" data-k="key">${sources().map(([k, l]) => `<option value="${esc(k)}"${k === c.key ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></td>
        <td><input type="text" data-i="${i}" data-k="title" value="${esc(c.title)}"></td>
        <td><input type="number" data-i="${i}" data-k="w" min="4" max="300" step="1" value="${Number(c.w) || 20}" style="width:60px"></td>
        <td class="bc-btns"><button data-i="${i}" data-a="up" title="Move left"${i ? '' : ' disabled'}>↑</button><button data-i="${i}" data-a="down" title="Move right"${i < cols.length - 1 ? '' : ' disabled'}>↓</button><button data-i="${i}" data-a="del" title="Remove"${cols.length > 1 ? '' : ' disabled'}>✕</button></td></tr>`).join('')}</table>
        <div style="margin-top:6px"><button class="bc-add">Add Column</button></div>
        ${props.length ? '' : '<p class="pm-hint">Give the parts custom properties (File ▸ Properties… in a part: Part Number, Description, Vendor…) to show them here.</p>'}
        ${typed.length ? `<div class="pm-label" style="margin-top:10px">Values typed in the table</div><div class="bc-grid"><table><tr><th>Item</th><th>Part</th>${typed.map(([c]) => `<th>${esc(c.title)}</th>`).join('')}</tr>${rows.map((r) => `<tr><td>${esc(r.item)}</td><td>${esc('  '.repeat(r.depth) + r.name)}</td>${typed.map(([c, i]) => `<td><input type="text" data-v="${i}" data-row="${esc(r.key)}" value="${esc(bomCell(r, c))}"></td>`).join('')}</tr>`).join('')}</table></div>` : ''}`;
      box.querySelectorAll('[data-k]').forEach((inp) => {
        inp.onkeydown = (e) => e.stopPropagation();
        inp.onchange = () => {
          const c = cols[+inp.dataset.i], k = inp.dataset.k;
          if (k === 'key') {
            const was = label(c.key).replace(/^Property: /, '').toUpperCase();
            c.key = inp.value;
            if (!c.title || c.title === was) c.title = label(c.key).replace(/^Property: /, '').toUpperCase();
            if (c.key === 'text') c.values ||= {}; else delete c.values;
            render();
          } else if (k === 'w') c.w = Math.max(4, Math.min(300, Number(inp.value) || 20));
          else c.title = inp.value;
        };
      });
      box.querySelectorAll('[data-v]').forEach((inp) => { inp.onkeydown = (e) => e.stopPropagation(); inp.oninput = () => { const c = cols[+inp.dataset.v]; (c.values ||= {})[inp.dataset.row] = inp.value; }; });
      box.querySelectorAll('[data-a]').forEach((b) => {
        b.onclick = () => {
          const i = +b.dataset.i, a = b.dataset.a;
          if (a === 'del') cols.splice(i, 1);
          else { const j = a === 'up' ? i - 1 : i + 1; [cols[i], cols[j]] = [cols[j], cols[i]]; }
          render();
        };
      });
      box.querySelector('.bc-add').onclick = () => {
        const pick = props.find((n) => !cols.some((c) => c.key === 'prop:' + n));
        cols.push(pick ? { key: 'prop:' + pick, title: pick.toUpperCase(), w: 30 } : { key: 'text', title: 'NOTES', w: 30, values: {} });
        render();
      };
    };
    render();
    // (its right edge stays where it is: a table placed at the frame's right stays inside it)
    const width = (cs) => cs.reduce((s, c) => s + Math.max(4, Number(c.w) || 20), 0), w0 = width(D.bomColumns(ann));
    const keepRight = () => { if (Array.isArray(ann.pos)) ann.pos = [ann.pos[0] + w0 - width(D.bomColumns(ann)), ann.pos[1]]; };
    this.app.ui.modal('BOM Table Columns', 'bom', box, [
      { label: 'OK', primary: true, action: () => { ann.cols = cols; keepRight(); this.changed(); } },
      { label: 'Default Columns', action: () => { delete ann.cols; keepRight(); this.changed(); } },
      { label: 'Cancel' },
    ]);
  }

  // Insert ▸ DXF Drawing: a DXF file's lines, arcs, circles, polylines, splines and texts placed on the sheet as one
  // item (move it, scale it, delete it), in the middle of the frame, at full size or a standard scale that fits.
  async insertDXF() {
    if (this.tool) this.cancelTool(false);
    const f = await platform.openDXF();
    if (!f?.text) return;
    let shapes;
    try { shapes = dxfShapes(parseDXF(f.text)).filter((s) => !s.point); } catch (e) { this.app.toast(`${f.name} could not be read: ${e.message}`, true); return; }
    if (!shapes.length) { this.app.toast(`${f.name} has nothing RazorCAD can draw`, true); return; }
    // (its lower left corner at the origin)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const pt = (q) => { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]); };
    for (const s of shapes) {
      if (s.line) s.line.forEach(pt); else if (s.circle || s.arc) { const c = s.circle || s.arc; pt([c.c[0] - c.r, c.c[1] - c.r]); pt([c.c[0] + c.r, c.c[1] + c.r]); }
      else if (s.ellipse) { const e = s.ellipse, ra = Math.hypot(...e.major); pt([e.c[0] - ra, e.c[1] - ra]); pt([e.c[0] + ra, e.c[1] + ra]); }
      else if (s.spline) s.spline.pts.forEach(pt); else if (s.text) pt(s.text.p);
    }
    const mv = (q) => [q[0] - x0, q[1] - y0];
    for (const s of shapes) {
      if (s.line) s.line = s.line.map(mv); else if (s.circle) s.circle.c = mv(s.circle.c); else if (s.arc) s.arc.c = mv(s.arc.c);
      else if (s.ellipse) s.ellipse.c = mv(s.ellipse.c); else if (s.spline) s.spline.pts = s.spline.pts.map(mv); else if (s.text) s.text.p = mv(s.text.p);
    }
    const W = Math.max(1e-6, x1 - x0), H = Math.max(1e-6, y1 - y0);
    const fr = frameRect(this.sheet, this.doc.format), tb = titleBlockRect(this.sheet, this.doc.format);
    const aw = (fr.x1 - fr.x0) * 0.9, ah = (fr.y1 - fr.y0 - (tb.y1 - tb.y0)) * 0.9;
    const fit = Math.min(1, aw / W, ah / H), k = fit >= 1 ? 1 : [0.5, 0.4, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001].find((x) => x <= fit) || fit;
    const cx = (fr.x0 + fr.x1) / 2, cy = (fr.y0 + fr.y1 - (tb.y1 - tb.y0)) / 2;
    const a = { id: D.newId(this.doc, 'a'), type: 'dxf', sheet: this.sheetId, name: f.name, scale: k, shapes, pos: [cx - (W * k) / 2, cy + (H * k) / 2] };
    this.doc.anns.push(a);
    this.selected.clear(); this.selected.add(a.id);
    this.changed();
    this.app.status(`${f.name} placed (${shapes.length} items${k !== 1 ? `, at 1:${+(1 / k).toFixed(3)}` : ''}): drag it where you want it; right-click it to scale it.`);
    return a;
  }

  addBOM() {
    if (this.tool) this.cancelTool(false);
    const v = [...this.selected].map((id) => D.findView(this.doc, id)).find(Boolean);
    const isAsm = (id) => this.doc.models.find((x) => x.id === id)?.doc?.kind === 'assembly';
    const mid = v && isAsm(v.model) ? v.model : this.doc.models.find((x) => x.doc?.kind === 'assembly')?.id;
    if (!mid) { this.app.toast('A bill of materials needs a view of an assembly', true); return; }
    const f = frameRect(this.sheet, this.doc.format), W = D.bomColumns(null).reduce((s, c) => s + c.w, 0);
    this.doc.anns.push({ id: D.newId(this.doc, 'a'), type: 'bom', sheet: this.sheetId, model: mid, pos: [f.x1 - W - 8, f.y0 + 12] });
    this.changed();
    this.app.status(`Bill of materials added (${bomRows(this.doc.models.find((x) => x.id === mid).doc).filter((r) => !r.depth).length} items): drag it where you want it. Right-click it to show the sub-assemblies' parts.`);
  }

  // A hole table for the selected view (else the first part view): its holes tagged, their positions from the view's
  // lower-left corner, placed at the bottom left of the sheet's frame
  addHoleTable() {
    if (this.tool) this.cancelTool(false);
    const v = [...this.selected].map((id) => D.findView(this.doc, id)).find((x) => x && x.type !== 'detail') || this.doc.views.find((x) => x.sheet === this.sheetId && ['model', 'projected', 'flat'].includes(x.type));
    if (!v) { this.app.toast('Select the view whose holes go in the table', true); return; }
    const f = frameRect(this.sheet, this.doc.format);
    const a = { id: D.newId(this.doc, 'a'), type: 'holetable', sheet: this.sheetId, of: v.id, pos: [f.x0 + 8, f.y0 + 12] };
    this.doc.anns.push(a);
    this.changed();
    const n = D.holeTableRows(this.doc, a, this.geos)?.length || 0;
    this.app.status(`Hole table added (${n} hole${n === 1 ? '' : 's'} in ${v.name}): drag it where you want it.`);
    return a;
  }

  // A weldment cut list table for a part of the drawing (the part of the selected view, else the first),
  // placed at the top left of the sheet's frame.
  addCutList() {
    if (this.tool) this.cancelTool(false);
    const v = [...this.selected].map((id) => D.findView(this.doc, id)).find(Boolean);
    const mid = v?.model || this.doc.models[0]?.id;
    if (!mid) { this.app.toast('Add a view of the part first', true); return; }
    const f = frameRect(this.sheet, this.doc.format);
    this.doc.anns.push({ id: D.newId(this.doc, 'a'), type: 'cutlist', sheet: this.sheetId, model: mid, pos: [f.x0 + 8, f.y0 + 12] });
    this.changed();
    this.updateCutLists();
    this.app.status('Cut list table added: drag it where you want it.');
  }

  // The revision table: edit its rows (one per line: REV | DESCRIPTION | DATE | APPROVED); placed at the
  // top right of the sheet the first time.
  async revisionTable() {
    if (this.tool) this.cancelTool(false);
    const rows = this.doc.revisions || [];
    const text = rows.map((r) => [r.rev, r.desc, r.date, r.by].join(' | ')).join('\n') || `${this.doc.props.revision || 'A'} | Initial release | ${new Date().toISOString().slice(0, 10)} | ${this.doc.props.approvedBy || ''}`;
    const out = await this.app.ui.promptText('Revision Table', 'revTable', 'One revision per line: REV | DESCRIPTION | DATE | APPROVED (the latest revision goes into the title block).', text, true);
    if (out === null || out === undefined) return;
    this.doc.revisions = out.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter((c) => c.some(Boolean)).map(([rev, desc, date, by]) => ({ rev: rev || '', desc: desc || '', date: date || '', by: by || '' }));
    if (this.doc.revisions.length) this.doc.props.revision = this.doc.revisions[this.doc.revisions.length - 1].rev;
    if (!this.doc.anns.some((a) => a.type === 'revtable' && a.sheet === this.sheetId) && this.doc.revisions.length) {
      const f = frameRect(this.sheet, this.doc.format);
      this.doc.anns.push({ id: D.newId(this.doc, 'a'), type: 'revtable', sheet: this.sheetId, pos: [f.x1 - 128, f.y0] });
    }
    this.changed();
  }

  // The current sheet as DXF (sheet millimetres, y up): layers by line kind, text, hatching as lines.
  async exportDXF() {
    if (this.tool) this.cancelTool();
    await this.updateGeometry();
    const sheet = this.sheet, size = D.paperSize(sheet), H = size[1];
    const prims = D.sheetPrims(this.doc, sheet, { geos: this.geos, selected: new Set(), hover: null, errors: new Map(), cutLists: this.cutLists });
    const ents = [];
    const Y = (q) => [q[0], H - q[1]];
    const layerOf = (p) => (p.dash ? (p.dash.length > 2 ? 'CENTER' : 'HIDDEN') : (p.w || 0) >= 0.4 ? 'VISIBLE' : 'THIN');
    const clipOK = (clip) => (q) => !clip || (clip.circle ? len2(sub2(q, clip.circle.c)) <= clip.circle.r + 1e-6 : inPoly(q, clip.poly));
    // a polyline cut to a clip region (pieces inside it, sampled finely enough at the boundary)
    const clipPts = (pts, ok) => {
      const runs = [];
      let cur = [];
      for (let i = 0; i < pts.length; i++) {
        if (i) {
          const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.ceil(len2(sub2(b, a)) / 0.5));
          for (let k = 1; k <= n; k++) {
            const q = add2(a, mul2(sub2(b, a), k / n));
            if (ok(q)) { if (!cur.length) cur.push(add2(a, mul2(sub2(b, a), (k - 1) / n))); cur.push(q); } else if (cur.length) { runs.push(cur); cur = []; }
          }
        } else if (ok(pts[0])) cur.push(pts[0]);
      }
      if (cur.length > 1) runs.push(cur);
      return runs.map((r) => simplifyRun(r));
    };
    const emit = (list, clip = null) => {
      const ok = clipOK(clip);
      for (const p of list) {
        if (p.t === 'clip') { emit(p.prims, p); continue; }
        const layer = p.layer || layerOf(p);
        if (p.t === 'line') { for (const r of clip ? clipPts([p.a, p.b], ok) : [[p.a, p.b]]) ents.push(r.length === 2 ? { type: 'LINE', layer, a: Y(r[0]), b: Y(r[1]) } : { type: 'POLYLINE', layer, pts: r.map(Y) }); }
        else if (p.t === 'poly') {
          const pts = p.closed ? [...p.pts, p.pts[0]] : p.pts;
          for (const r of clip ? clipPts(pts, ok) : [pts]) ents.push({ type: 'POLYLINE', layer, pts: r.map(Y) });
          if (p.fill && !clip) ents.push({ type: 'POLYLINE', layer, pts: pts.map(Y), closed: false });
        } else if (p.t === 'circle') {
          if (!clip) ents.push({ type: 'CIRCLE', layer, c: Y(p.c), r: p.r });
          else for (const r of clipPts(D.arcPts(p.c, p.r, 0, 2 * Math.PI), ok)) ents.push({ type: 'POLYLINE', layer, pts: r.map(Y) });
        } else if (p.t === 'text') {
          if (clip && !ok(p.p)) continue;
          // DXF text sits on its baseline at its left end: move the anchor there
          const w = D.textWidth(p.text, p.h, p.bold), rad = ((p.rot || 0) * Math.PI) / 180, ux = [Math.cos(rad), -Math.sin(rad)], uy = [Math.sin(rad), Math.cos(rad)];
          const dx = p.anchor === 'middle' ? -w / 2 : p.anchor === 'end' ? -w : 0, dy = p.base === 'middle' ? p.h / 2 : p.base === 'top' ? p.h : 0;
          const q = add2(add2(p.p, mul2(ux, dx)), mul2(uy, dy));
          ents.push({ type: 'TEXT', layer: 'TEXT', p: Y(q), h: p.h, rot: p.rot || 0, text: String(p.text) });
        } else if (p.t === 'hatch') {
          for (const seg of hatchLines(p)) ents.push({ type: 'LINE', layer: 'HATCH', a: Y(seg[0]), b: Y(seg[1]) });
        }
      }
    };
    emit(prims);
    const mapping = { VISIBLE: { color: 7, ltype: 'CONTINUOUS' }, THIN: { color: 7, ltype: 'CONTINUOUS' }, HIDDEN: { color: 8, ltype: 'HIDDEN' }, CENTER: { color: 1, ltype: 'CENTER' }, TEXT: { color: 3, ltype: 'CONTINUOUS' }, HATCH: { color: 8, ltype: 'CONTINUOUS' } };
    const bytes = new TextEncoder().encode(buildDXF(ents, mapping));
    try {
      const name = `${this.safeName()}${this.doc.sheets.length > 1 ? ` - ${sheet.name}` : ''}.dxf`;
      const path = await platform.saveBinary(name, bytes, 'dxf');
      if (path) this.app.status('Exported ' + String(path).split(/[\\/]/).pop());
    } catch (err) {
      this.app.toast('DXF export failed: ' + err.message, true);
    }
  }

  // A dimension from the picked entities and the cursor position (where its text goes).
  dimFromPicks(picks, P) {
    const v = D.findView(this.doc, picks[0].view);
    if (!v) return null;
    const X = D.viewXform(this.doc, v);
    const q = X.toView(P);
    const base = { id: 'preview', type: 'dim', sheet: v.sheet, view: v.id, pos: [P[0] - v.x, P[1] - v.y] };
    const ptOf = (e) => (e.kind === 'point' ? e.p : e.kind === 'circle' ? e.c : null);
    const axisOf = (l) => { const d = unit2(sub2(l.b, l.a)); return Math.abs(d[1]) < 1e-6 ? 'h' : Math.abs(d[0]) < 1e-6 ? 'v' : 'a'; };
    const orientByCursor = (p1, p2) => {
      const x0 = Math.min(p1[0], p2[0]), x1 = Math.max(p1[0], p2[0]), y0 = Math.min(p1[1], p2[1]), y1 = Math.max(p1[1], p2[1]);
      const outX = q[0] < x0 || q[0] > x1, outY = q[1] < y0 || q[1] > y1;
      if (Math.abs(p1[0] - p2[0]) < 1e-6) return 'v';
      if (Math.abs(p1[1] - p2[1]) < 1e-6) return 'h';
      if (outY && !outX) return 'h';
      if (outX && !outY) return 'v';
      return 'a';
    };
    let a;
    if (picks.length === 1) {
      const e = picks[0];
      if (e.kind === 'circle') a = { ...base, kind: e.full ? 'diameter' : 'radius', c: e.c, r: e.r };
      else if (e.kind === 'line') { const o = axisOf(e); a = { ...base, kind: 'linear', p1: e.a, p2: e.b, orient: o === 'a' ? orientByCursor(e.a, e.b) : o, edge: true }; }
      else return null;
    } else {
      const [e1, e2] = picks;
      if (e1.kind === 'line' && e2.kind === 'line') {
        const d1 = unit2(sub2(e1.b, e1.a)), d2 = unit2(sub2(e2.b, e2.a));
        if (Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) > 1e-4) a = { ...base, kind: 'angle', l1: [e1.a, e1.b], l2: [e2.a, e2.b] };
        else {
          const p2 = footOnLine(e1.a, e2.a, e2.b), o = axisOf(e1);
          a = { ...base, kind: 'linear', p1: e1.a, p2, orient: o === 'h' ? 'v' : o === 'v' ? 'h' : 'a' };
        }
      } else if (e1.kind === 'line' || e2.kind === 'line') {
        const l = e1.kind === 'line' ? e1 : e2, o = e1.kind === 'line' ? e2 : e1;
        const p = ptOf(o), f = footOnLine(p, l.a, l.b), ax = axisOf(l);
        a = { ...base, kind: 'linear', p1: p, p2: f, orient: ax === 'h' ? 'v' : ax === 'v' ? 'h' : 'a' };
      } else {
        const p1 = ptOf(e1), p2 = ptOf(e2);
        a = { ...base, kind: 'linear', p1, p2, orient: orientByCursor(p1, p2) };
      }
    }
    if (a.kind === 'linear' && D.dimValue(this.doc, a) < 1e-9) return null;
    return a;
  }

  async placeStandard3(t, P = null) {
    const mid = this.ensureModel(t);
    if (!mid) { this.app.toast('Pick a part first', true); return; }
    const sheet = this.sheet;
    const third = sheet.projection === 'third';
    const front = { id: D.newId(this.doc, 'v'), name: this.nextViewName(), type: 'model', orient: 'front', model: mid, sheet: sheet.id, style: 'hlr', tangent: true, scale: null, x: 0, y: 0 };
    const vert = { id: D.newId(this.doc, 'v'), name: '', type: 'projected', parent: front.id, side: third ? 'up' : 'down', model: mid, sheet: sheet.id, style: 'hlr', tangent: true, scale: null, x: 0, y: 0 };
    const side = { id: D.newId(this.doc, 'v'), name: '', type: 'projected', parent: front.id, side: 'right', model: mid, sheet: sheet.id, style: 'hlr', tangent: true, scale: null, x: 0, y: 0 };
    this.doc.views.push(front); // (the projected views need their parent to find their direction)
    const camV = D.viewCamera(this.doc, vert), camS = D.viewCamera(this.doc, side);
    const [g, gv, gs] = await Promise.all([
      this.previewGeom(mid, { dir: [0, 0, 1], up: [0, 1, 0] }),
      this.previewGeom(mid, { dir: camV.dir, up: camV.y }),
      this.previewGeom(mid, { dir: camS.dir, up: camS.y }),
    ]);
    this.doc.views.pop();
    if (!g) { this.app.toast('The part could not be drawn', true); return; }
    const W = (b) => (b ? b.max[0] - b.min[0] : 0), H = (b) => (b ? b.max[1] - b.min[1] : 0);
    const f = frameRect(sheet, this.doc.format), tb = titleBlockRect(sheet, this.doc.format);
    const gap = 22;
    const availW = f.x1 - f.x0 - 3 * gap, availH = f.y1 - f.y0 - (tb.y1 - tb.y0) - 3 * gap;
    if (!this.doc.views.some((v) => v.sheet === sheet.id)) {
      const needW = W(g.box) + W(gs?.box), needH = H(g.box) + H(gv?.box);
      const scales = [[10, 1], [5, 1], [2, 1], [1, 1], [1, 2], [1, 2.5], [1, 5], [1, 10], [1, 20], [1, 50], [1, 100]];
      sheet.scale = scales.find(([a, b]) => (needW * a) / b <= availW && (needH * a) / b <= availH) || scales[scales.length - 1];
    }
    const s = D.sheetScale(this.doc, sheet.id);
    const wF = W(g.box) * s, hF = H(g.box) * s, wS = W(gs?.box) * s, hV = H(gv?.box) * s;
    // centre the group in the drawing area above the title block
    const totW = wF + (gs ? gap + wS : 0), totH = hF + (gv ? gap + hV : 0);
    const areaX0 = f.x0, areaX1 = f.x1, areaY0 = f.y0, areaY1 = f.y1 - (tb.y1 - tb.y0);
    const gx0 = P ? P[0] - wF / 2 : areaX0 + (areaX1 - areaX0 - totW) / 2;
    const gy0 = P ? P[1] - hF / 2 - (third && gv ? gap + hV : 0) : areaY0 + (areaY1 - areaY0 - totH) / 2;
    // front view centre
    const fcx = gx0 + wF / 2, fcy = gy0 + (third && gv ? hV + gap : 0) + hF / 2;
    const place = (v, geom, cx, cy) => { const b = geom.box; v.x = cx - ((b.min[0] + b.max[0]) / 2) * s; v.y = cy + ((b.min[1] + b.max[1]) / 2) * s; };
    place(front, g, fcx, fcy);
    this.doc.views.push(front);
    this.geos.set(front.id, g);
    if (gv) {
      const cy = third ? fcy - hF / 2 - gap - hV / 2 : fcy + hF / 2 + gap + hV / 2;
      place(vert, gv, fcx, cy);
      vert.x = front.x; // aligned
      vert.name = this.nextViewName();
      this.doc.views.push(vert);
      this.geos.set(vert.id, gv);
    }
    if (gs) {
      place(side, gs, fcx + wF / 2 + gap + wS / 2, fcy);
      side.y = front.y; // aligned
      side.name = this.nextViewName();
      this.doc.views.push(side);
      this.geos.set(side.id, gs);
    }
    this.changed();
    this.cancelTool();
  }

  nextViewName() {
    let n = 1;
    const names = new Set(this.doc.views.map((v) => v.name));
    while (names.has(`Drawing View${n}`)) n++;
    return `Drawing View${n}`;
  }

  // ------------------------------------------------------------ editing annotations / views
  async editAnn(a, P = null) {
    if (a.type === 'bom') {
      // (double-click on a typed value: edit it; anywhere else: the columns)
      const hit = P ? D.bomHit(this.doc, a, P) : null, col = hit?.col >= 0 ? D.bomColumns(a)[hit.col] : null;
      if (col?.key === 'text' && hit.r) return this.editBomValue(a, hit.col, hit.r);
      return this.bomColumnsDialog(a);
    }
    if (a.type === 'revtable') { this.revisionTable(); return; }
    if (['datum', 'fcf', 'sfin', 'weld'].includes(a.type)) {
      const copy = JSON.parse(JSON.stringify(a));
      if (await this.symbolDialog(copy)) { Object.assign(a, copy); this.changed(); }
      return;
    }
    if (a.type === 'note') {
      const text = await this.app.ui.promptText('Edit Note', 'note', 'Note text', a.text, true);
      if (text === null || text === undefined) return;
      if (!text.trim()) { this.doc.anns = this.doc.anns.filter((x) => x !== a); } else a.text = text;
      this.changed();
      return;
    }
    if (a.type !== 'dim') return;
    const box = el('div', { class: 'dw-form' });
    box.innerHTML = `<div class="pm-hint">Value: <b>${esc(a.kind === 'angle' ? D.fmtNum(D.dimValue(this.doc, a), this.doc) : D.fmtLen(D.dimValue(this.doc, a), this.doc))}</b>${a.kind === 'angle' ? '°' : ' ' + D.unitName(this.doc)}</div>
      <div class="kv"><div class="k">Prefix</div><div><input type="text" class="d-pre"></div>
      <div class="k">Suffix</div><div><input type="text" class="d-suf"></div>
      <div class="k">Tolerance</div><div><input type="text" class="d-tol" placeholder="e.g. ±0.1  or  H7"></div>
      <div class="k">Override text</div><div><input type="text" class="d-ovr" placeholder="(empty: the measured value)"></div></div>`;
    const q = (c) => box.querySelector(c);
    q('.d-pre').value = a.prefix || ''; q('.d-suf').value = a.suffix || ''; q('.d-tol').value = a.tol || ''; q('.d-ovr').value = a.override || '';
    this.app.ui.modal('Dimension', 'smartdim', box, [
      { label: 'OK', primary: true, action: () => { a.prefix = q('.d-pre').value; a.suffix = q('.d-suf').value; a.tol = q('.d-tol').value.trim(); a.override = q('.d-ovr').value.trim() || null; this.changed(); } },
      { label: 'Cancel' },
    ]);
  }

  // Change a placed view to another orientation, or to / from the flat pattern of its sheet metal body.
  // Projected and section views made from it no longer fit a flat pattern: they are removed (undo brings them back).
  setViewOrientation(v, k) {
    this.pendingCentre ||= new Map();
    this.pendingCentre.set(v.id, this.viewCentre(v));
    if (k === 'flat') {
      if (v.type === 'flat') return;
      const kids = this.doc.views.filter((c) => c.parent === v.id && (c.type === 'projected' || c.type === 'section'));
      if (kids.length) {
        this.removeItems(kids.map((c) => c.id));
        this.app.status(`${kids.length} projected / section view${kids.length === 1 ? '' : 's'} made from it removed (Ctrl+Z brings them back).`);
      }
      v.prevOrient = v.orient || 'front';
      v.type = 'flat';
      v.bendLines ??= true; v.bendNotes ??= true; v.bendRegion ??= false;
    } else {
      if (v.type === 'flat') { v.type = 'model'; v.style ||= 'hlr'; v.tangent ??= true; }
      v.orient = k;
    }
    this.selected = new Set([v.id]);
    this.changed();
  }

  // The middle of a view on the sheet, and moving a view so its middle is at P (its aligned views follow).
  viewCentre(v) { const r = D.viewRect(this.doc, v, this.geos); return [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2]; }
  recentre(v, P) {
    const c = this.viewCentre(v);
    if (Math.hypot(c[0] - P[0], c[1] - P[1]) > 1e-9) D.moveView(this.doc, v, P[0] - c[0], P[1] - c[1], false);
  }

  // the selected view (for Break / Crop started from the toolbar)
  selViewOpt() { const v = [...this.selected].map((id) => D.findView(this.doc, id)).find((x) => x && x.type !== 'detail'); return v ? { view: v.id } : {}; }

  startViewProps(v) {
    this.selected.clear();
    this.selected.add(v.id);
    this.startTool('viewprops', { view: v.id });
  }

  // ------------------------------------------------------------ sheets
  addSheet() {
    const cur = this.sheet;
    let n = this.doc.sheets.length + 1;
    while (this.doc.sheets.some((s) => s.name === `Sheet${n}`)) n++;
    const s = { id: D.newId(this.doc, 's'), name: `Sheet${n}`, size: cur.size, orientation: cur.orientation, scale: [...cur.scale], projection: cur.projection };
    this.doc.sheets.push(s);
    this.sheetId = s.id;
    this.changed();
    this.renderSheetTabs();
    this.fit();
  }
  deleteSheet(id) {
    if (this.doc.sheets.length < 2) { this.app.toast('A drawing keeps at least one sheet', true); return; }
    const ids = new Set(this.doc.views.filter((v) => v.sheet === id).map((v) => v.id));
    this.doc.views = this.doc.views.filter((v) => v.sheet !== id);
    this.doc.anns = this.doc.anns.filter((a) => a.sheet !== id && !(a.view && ids.has(a.view)));
    this.doc.sheets = this.doc.sheets.filter((s) => s.id !== id);
    if (this.sheetId === id) this.sheetId = this.doc.sheets[0].id;
    this.changed();
    this.renderSheetTabs();
  }
  renderSheetTabs() {
    const bar = $('#dw-sheets');
    if (!bar) return;
    bar.innerHTML = '';
    for (const s of this.doc.sheets) {
      const b = el('button', { class: 'dw-sheet' + (s.id === this.sheetId ? ' active' : ''), title: 'Right-click for sheet properties' }, esc(s.name));
      b.onclick = () => { this.sheetId = s.id; this.selected.clear(); this.renderAll(); this.fit(); };
      b.oncontextmenu = (e) => {
        e.preventDefault();
        this.app.ui.showContext(e.clientX, e.clientY, [
          { label: 'Sheet Properties…', icon: 'sheetProps', action: () => { this.sheetId = s.id; this.renderAll(); this.sheetPropsDialog(); } },
          { label: 'Add Sheet', icon: 'addSheet', action: () => this.addSheet() },
          { label: 'Delete Sheet', icon: 'trash', disabled: this.doc.sheets.length < 2, action: () => this.deleteSheet(s.id) },
        ]);
      };
      bar.appendChild(b);
    }
    const plus = el('button', { class: 'dw-sheet add', title: 'Add a sheet' }, '+');
    plus.onclick = () => this.addSheet();
    bar.appendChild(plus);
  }

  sheetPropsDialog() {
    const s = this.sheet;
    const box = el('div', { class: 'dw-form' });
    box.innerHTML = `<div class="kv">
      <div class="k">Name</div><div><input type="text" class="s-name"></div>
      <div class="k">Sheet size</div><div><select class="s-size">${Object.keys(SHEET_SIZES).map((k) => `<option value="${k}">${k} (${SHEET_SIZES[k][0]} × ${SHEET_SIZES[k][1]} mm)</option>`).join('')}</select></div>
      <div class="k">Orientation</div><div><select class="s-or"><option value="landscape">Landscape</option><option value="portrait">Portrait</option></select></div>
      <div class="k">Scale</div><div class="s-scale-row"><input type="number" class="s-s1" min="0.001" step="any"> : <input type="number" class="s-s2" min="0.001" step="any"></div>
      <div class="k">Projection</div><div><select class="s-proj"><option value="first">First angle (ISO / Europe)</option><option value="third">Third angle (ANSI / USA)</option></select></div>
      </div><div class="pm-hint">Views placed with the sheet scale follow it. Changing the projection swaps where projected views show which side.</div>`;
    const q = (c) => box.querySelector(c);
    q('.s-name').value = s.name; q('.s-size').value = s.size; q('.s-or').value = s.orientation; q('.s-s1').value = s.scale[0]; q('.s-s2').value = s.scale[1]; q('.s-proj').value = s.projection;
    this.app.ui.modal('Sheet Properties', 'sheetProps', box, [
      {
        label: 'OK', primary: true, action: () => {
          const a = +q('.s-s1').value, b = +q('.s-s2').value;
          if (!(a > 0 && b > 0)) { this.app.toast('Enter a scale like 1 : 2', true); return false; }
          const before = new Map(this.doc.views.map((v) => [v.id, D.viewRect(this.doc, v, this.geos)])), oldProj = s.projection;
          s.name = q('.s-name').value.trim() || s.name; s.size = q('.s-size').value; s.orientation = q('.s-or').value; s.scale = [a, b]; s.projection = q('.s-proj').value;
          if (s.projection !== oldProj) D.flipProjectedViews(this.doc, s.id, before);
          this.changed(); this.renderSheetTabs(); this.fit();
        },
      },
      { label: 'Cancel' },
    ]);
  }

  propsDialog() {
    const p = this.doc.props;
    const box = el('div', { class: 'dw-form' });
    box.innerHTML = `<div class="kv">${titleFields(this.doc.format).map(([k, l]) => `<div class="k">${esc(l)}</div><div><input type="text" data-k="${k}"></div>`).join('')}
      <div class="k">Drawing name</div><div><input type="text" data-k="__name"></div>
      <div class="k">Text height</div><div><input type="number" data-k="__textH" min="1" max="10" step="0.5"></div>
      <div class="k">Decimals</div><div><input type="number" data-k="__dec" min="0" max="6" step="1"></div></div>
      <div class="pm-hint">These fill the title block. Title, drawing number and material are taken from the part when you add its first view.</div>`;
    box.querySelectorAll('input[data-k]').forEach((i) => {
      const k = i.dataset.k;
      i.value = k === '__name' ? this.doc.name : k === '__textH' ? this.doc.settings.textH : k === '__dec' ? this.doc.settings.decimals : p[k] ?? '';
    });
    this.app.ui.modal('Drawing Properties', 'titleBlock', box, [
      {
        label: 'OK', primary: true, action: () => {
          box.querySelectorAll('input[data-k]').forEach((i) => {
            const k = i.dataset.k, v = i.value;
            if (k === '__name') this.doc.name = v.trim() || this.doc.name;
            else if (k === '__textH') this.doc.settings.textH = Math.max(1, Math.min(10, +v || 3.5));
            else if (k === '__dec') this.doc.settings.decimals = Math.max(0, Math.min(6, Math.round(+v)));
            else p[k] = v;
          });
          this.changed();
        },
      },
      { label: 'Cancel' },
    ]);
  }

  // ------------------------------------------------------------ files
  safeName() { return this.doc.name.replace(/[^\w\- ]+/g, '_') || 'Drawing'; }
  async save(saveAs = false) {
    if (this.tool) this.cancelTool();
    if (this.doc.isTemplate) return this.saveTemplate(saveAs);
    try {
      let thumb = null;
      try { thumb = await this.thumbnail(); } catch { /* saved without a preview */ }
      const path = await platform.saveText(`${this.safeName()}${D.DRAWING_EXT}`, docJSON(this.doc, thumb, 1), saveAs ? null : this.filePath, this.filePath, 'drawing');
      if (!path) return false;
      if (platform.desktop) this.filePath = path;
      if (platform.desktop && isDefaultName(this.doc.name) && fileStem(path) !== this.doc.name) {
        this.doc.name = fileStem(path);
        await platform.saveText(`${this.safeName()}${D.DRAWING_EXT}`, docJSON(this.doc, thumb, 1), path, path, 'drawing');
      }
      this.dirty = false;
      this.app.updateTitle();
      this.app.status('Saved ' + String(path).split(/[\\/]/).pop());
      return true;
    } catch (err) {
      this.app.toast('Save failed: ' + err.message, true);
      return false;
    }
  }

  // The sheet shown, as a picture (the file's preview): a PNG data: URL at most max px across.
  async thumbnail(max = 400) {
    const sheet = this.sheet;
    if (!sheet) return null;
    await this.loadFonts();
    const [W, H] = D.paperSize(sheet);
    const k = max / Math.max(W, H);
    const w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
    const prims = D.sheetPrims(this.doc, sheet, { geos: this.geos, selected: new Set(), hover: null, errors: this.errors, cutLists: this.cutLists });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${W} ${H}"><rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>${svgOf(prims, k, { n: 0 })}</svg>`;
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return cv.toDataURL('image/png');
  }

  // File ▸ Save as Template…: this drawing's set-up (sheets, settings, title block entries that are not
  // about one part, free notes) as a template file, listed in the New Drawing dialog from then on.
  async saveAsTemplate() {
    if (this.tool) this.cancelTool();
    const name = await this.app.ui.promptText('Save as Template', 'titleBlock', 'Template name (shown in the New Drawing dialog)', this.doc.isTemplate ? this.doc.name : `${this.name} template`);
    if (!name?.trim()) return false;
    const tpl = templateFromDrawing(this.doc, name.trim());
    let thumb = null;
    try { thumb = await this.thumbnail(); } catch { /* saved without a preview */ }
    try {
      const path = await platform.saveText(`${name.trim().replace(/[^\w\- ]+/g, '_')}${TEMPLATE_EXT}`, docJSON(tpl, thumb, 1), null, null, 'template');
      if (!path) return false;
      this.app.status(`Template saved: ${String(path).split(/[\\/]/).pop()} — choose it in File ▸ New Drawing.`);
      return true;
    } catch (err) { this.app.toast('Could not save the template: ' + err.message, true); return false; }
  }

  // File ▸ Change Template…: switch this drawing to another template (its sheet format, sheet set-up,
  // settings and notes); views, dimensions and title block entries stay. Undoable.
  async changeTemplate() {
    if (this.tool) this.cancelTool(false);
    const setup = await this.app.ui.newDrawingSetup({ change: { key: this.doc.template?.key || null } });
    if (!setup) return false;
    // (projected views change sides when the projection changes)
    const before = new Map(this.doc.views.map((v) => [v.id, D.viewRect(this.doc, v, this.geos)]));
    const proj = new Map(this.doc.sheets.map((s) => [s.id, s.projection]));
    applyTemplate(this.doc, setup.template, setup.sheet);
    for (const s of this.doc.sheets) if (s.projection !== proj.get(s.id)) D.flipProjectedViews(this.doc, s.id, before);
    this.changed();
    this.renderSheetTabs();
    this.fit();
    this.app.status(`Template changed to ${setup.template.name}. Edit ▸ Undo goes back.`);
    return true;
  }

  // A template being edited: saved back to its file as a template.
  async saveTemplate(saveAs = false) {
    const tpl = templateFromDrawing(this.doc, this.doc.name, this.doc.templateDescription);
    let thumb = null;
    try { thumb = await this.thumbnail(); } catch { /* saved without a preview */ }
    try {
      const path = await platform.saveText(`${this.safeName()}${TEMPLATE_EXT}`, docJSON(tpl, thumb, 1), saveAs ? null : this.filePath, this.filePath, 'template');
      if (!path) return false;
      if (platform.desktop) this.filePath = path;
      this.dirty = false;
      this.app.updateTitle();
      this.app.status('Template saved ' + String(path).split(/[\\/]/).pop());
      return true;
    } catch (err) { this.app.toast('Save failed: ' + err.message, true); return false; }
  }

  async exportPDF() {
    if (this.tool) this.cancelTool();
    // every view needs its lines first, and the text its fonts
    await this.updateGeometry();
    await this.loadFonts();
    const missing = this.doc.views.filter((v) => v.type !== 'detail' && !this.geos.get(v.id));
    if (missing.length) { this.app.toast('Some views could not be drawn; the PDF leaves them out', true); }
    const pages = this.doc.sheets.map((s) => ({ size: D.paperSize(s), prims: D.sheetPrims(this.doc, s, { geos: this.geos, selected: new Set(), hover: null, errors: new Map(), cutLists: this.cutLists }) }));
    const bytes = buildPDF(pages, { title: this.doc.props.title || this.doc.name });
    try {
      const path = await platform.saveBinary(`${this.safeName()}.pdf`, bytes, 'pdf');
      if (path) this.app.status('Exported ' + String(path).split(/[\\/]/).pop());
    } catch (err) {
      this.app.toast('PDF export failed: ' + err.message, true);
    }
  }

  // ------------------------------------------------------------ left panel (tree / Property panel)
  renderLeft() {
    if (this.app.drawing !== this) return;
    this.renderTree();
    this.renderPM();
  }
  renderTree() {
    const root = $('#tree');
    root.innerHTML = '';
    const node = (ic, label, opts = {}) => {
      const n = el('div', { class: 'tn' + (opts.selected ? ' selected' : '') + (opts.cls ? ' ' + opts.cls : ''), style: `padding-left:${4 + (opts.depth || 0) * 14}px`, title: label }, `<span class="tw"></span><span class="ti">${icon(ic)}</span><span class="tl">${esc(label)}</span>`);
      if (opts.onclick) n.onclick = opts.onclick;
      if (opts.ondblclick) n.ondblclick = opts.ondblclick;
      if (opts.oncontext) n.oncontextmenu = (e) => { e.preventDefault(); opts.oncontext(e); };
      root.appendChild(n);
      return n;
    };
    node('drawing', this.doc.name, { cls: 'root', oncontext: (e) => this.app.ui.showContext(e.clientX, e.clientY, [{ label: 'Drawing Properties (Title Block)…', icon: 'titleBlock', action: () => this.propsDialog() }, { label: 'Change Template…', icon: 'titleBlock', action: () => this.changeTemplate() }]) });
    for (const m of this.doc.models) node(m.doc?.kind === 'assembly' ? 'assembly' : 'part', m.name + (m.path ? '' : ' (copy kept in the drawing)'), { depth: 1, cls: 'tree-muted' });
    for (const s of this.doc.sheets) {
      node('sheet', s.name + (s.id === this.sheetId ? '' : ''), { depth: 1, selected: s.id === this.sheetId, onclick: () => { this.sheetId = s.id; this.renderAll(); this.fit(); }, oncontext: (e) => this.app.ui.showContext(e.clientX, e.clientY, [{ label: 'Sheet Properties…', icon: 'sheetProps', action: () => { this.sheetId = s.id; this.renderAll(); this.sheetPropsDialog(); } }, { label: 'Delete Sheet', icon: 'trash', disabled: this.doc.sheets.length < 2, action: () => this.deleteSheet(s.id) }]) });
      node('sheetFormat', 'Sheet Format', { depth: 2, ondblclick: () => this.propsDialog() });
      const add = (v, depth) => {
        node(VIEW_ICONS[v.type] || 'modelView', v.name + (this.errors.get(v.id) ? ' ⚠' : ''), {
          depth, selected: this.selected.has(v.id),
          onclick: () => { this.sheetId = s.id; this.selected.clear(); this.selected.add(v.id); this.renderAll(); },
          ondblclick: () => this.startViewProps(v),
          oncontext: (e) => { this.selected.clear(); this.selected.add(v.id); this.render(); this.contextAt(e); },
        });
        for (const c of this.doc.views.filter((x) => x.parent === v.id)) add(c, depth + 1);
      };
      for (const v of this.doc.views.filter((x) => x.sheet === s.id && !x.parent)) add(v, 2);
    }
  }

  renderPM() {
    const root = $('#pm');
    root.innerHTML = '';
    const t = this.tool;
    if (!t) { root.appendChild(el('div', { class: 'pm-msg' }, 'Pick a drawing command (View Layout or Annotation tab) or double-click a view to edit it.')); return; }
    const titles = { model: t.orient === 'flat' ? ['smFlatten', 'Flat Pattern'] : ['modelView', 'Model View'], std3: ['std3View', 'Standard Views'], projected: ['projView', 'Projected View'], section: ['sectionView', 'Section View'], detail: ['detailView', 'Detail View'], dim: ['smartdim', 'Dimension'], note: ['note', 'Note'], cmark: ['centerMark', 'Center Mark'], cline: ['centerline', 'Centerline'], viewprops: ['modelView', 'Drawing View'],
      callout: ['holeCallout', 'Hole Callout'], balloon: ['balloon', 'Balloon'], baseline: ['baselineDim', 'Baseline Dimension'], ordinate: ['ordinateDim', 'Ordinate Dimension'], chamferDim: ['chamferDim', 'Chamfer Dimension'], datum: ['datum', 'Datum Feature'], fcf: ['gdt', 'Geometric Tolerance'], sfin: ['surfFinish', 'Surface Finish'], weld: ['weld', 'Weld Symbol'], aux: ['auxView', 'Auxiliary View'], break: ['breakView', 'Break View'], crop: ['cropView', 'Crop View'] };
    const [ic, title] = titles[t.kind] || ['modelView', t.kind];
    root.appendChild(el('div', { class: 'pm-head' }, `<span class="ti">${icon(ic)}</span><span>${esc(title)}</span>`));
    const act = el('div', { class: 'pm-actions' });
    act.appendChild(el('button', { title: 'Close (Esc)', onclick: () => this.cancelTool() }, icon(t.kind === 'viewprops' ? 'ok' : 'cancel')));
    root.appendChild(act);
    const group = (label) => {
      const g = el('div', { class: 'pm-group' });
      g.appendChild(el('div', { class: 'pm-gt' }, esc(label)));
      const b = el('div', { class: 'pm-gb' });
      g.appendChild(b);
      root.appendChild(g);
      return b;
    };
    const row = (body, label, control) => {
      const r = el('div', { class: 'pm-row' });
      r.appendChild(el('label', {}, esc(label)));
      r.appendChild(control);
      body.appendChild(r);
    };
    const select = (options, value, onchange) => {
      const s = el('select');
      for (const [v, l] of options) s.appendChild(el('option', { value: v }, esc(l)));
      s.value = value;
      s.onchange = () => onchange(s.value);
      const w = el('div', { class: 'pm-input' }); w.appendChild(s);
      return w;
    };
    if (t.kind === 'model' || t.kind === 'std3') {
      const g = group('Part or Assembly');
      const choices = this.partChoices();
      const list = el('div', { class: 'pm-list' });
      if (!choices.length) list.appendChild(el('div', { class: 'li pm-hint' }, 'No parts yet: open a part or assembly in another tab, or browse for its file.'));
      for (const c of choices) {
        const cur = t.choice?.key === c.key;
        const isAsm = (c.doc || this.modelDoc(c.model))?.kind === 'assembly';
        const li = el('div', { class: 'li' + (cur ? ' sel' : '') }, `${icon(isAsm ? 'assembly' : 'part')}<span>${esc(c.label)}</span>`);
        li.onclick = () => { t.choice = c; t.model = c.model || null; t.geom = null; this.renderPM(); if (t.kind === 'model') this.modelPreview(); };
        list.appendChild(li);
      }
      g.appendChild(list);
      g.appendChild(el('button', { class: 'pm-btn', onclick: () => this.browsePart() }, 'Browse for a part or assembly file…'));
      if (t.kind === 'model') {
        const o = group('Orientation');
        const grid = el('div', { class: 'dw-orients' });
        for (const [k, def] of [...Object.entries(D.ORIENTATIONS), ['flat', { label: 'Flat Pattern' }]]) {
          const b = el('button', { class: 'pm-btn' + (t.orient === k ? ' on' : '') + (k === 'flat' ? ' wide' : '') }, esc(def.label));
          b.onclick = () => { t.orient = k; t.geom = null; this.renderPM(); this.modelPreview(); };
          grid.appendChild(b);
        }
        o.appendChild(grid);
        if (t.orient === 'flat') o.appendChild(el('div', { class: 'pm-hint' }, 'The sheet metal body unfolded, with its bend lines (up / down) and bend notes, for making it.'));
        const d = group('Display Style');
        row(d, 'Style', select([['hlr', 'Hidden lines removed'], ['hlv', 'Hidden lines visible'], ['wire', 'Wireframe']], t.style, (v) => { t.style = v; }));
        d.appendChild(el('div', { class: 'pm-hint' }, `Sheet scale ${D.scaleText(D.sheetScale(this.doc, this.sheetId))} (Sheet Properties to change it).`));
      } else {
        const g2 = group('Layout');
        g2.appendChild(el('div', { class: 'pm-hint' }, `Front, top and side views, laid out for ${this.sheet.projection === 'third' ? 'third' : 'first'} angle projection (Sheet Properties).`));
        g2.appendChild(el('button', { class: 'pm-btn primary', onclick: () => this.placeStandard3(t) }, 'Place the three views'));
      }
      return;
    }
    if (t.kind === 'projected' || t.kind === 'section' || t.kind === 'detail') {
      const g = group('View');
      g.appendChild(el('div', { class: 'pm-hint' }, t.parent ? `From: ${esc(D.findView(this.doc, t.parent)?.name || '')}` : 'Click the view to start from.'));
      if (t.kind === 'section') {
        const c = group('Cutting Line');
        const grid = el('div', { class: 'dw-orients' });
        for (const [h, label] of [[true, 'Horizontal'], [false, 'Vertical'], ['angle', 'At an angle']]) {
          const on = h === 'angle' ? !!t.angled : !t.angled && t.horizontal === h;
          const b = el('button', { class: 'pm-btn' + (on ? ' on' : ''), 'data-section-line': String(h) }, label);
          b.onclick = () => { if (h === 'angle') { t.angled = true; t.angle ??= 45; } else { t.angled = false; t.horizontal = h; } t.a = null; t.geoms = {}; t.side = null; this.renderPM(); this.toolHint(); this.render(); };
          grid.appendChild(b);
        }
        c.appendChild(grid);
        if (t.angled) {
          const inp = el('input', { type: 'number', value: t.angle, step: '1', 'data-section-angle': '' });
          inp.onchange = () => { const x = Number(inp.value); if (Number.isFinite(x)) { t.angle = x; t.a = null; t.geoms = {}; t.side = null; this.toolHint(); this.render(); } };
          const row = el('label', { class: 'pm-label' }, 'Angle from horizontal (°, counter-clockwise) '); row.appendChild(inp); c.appendChild(row);
        }
      }
      return;
    }
    if (t.kind === 'viewprops') {
      const v = D.findView(this.doc, t.view);
      if (!v) { this.cancelTool(); return; }
      root.querySelector('.pm-head span:last-child').textContent = v.name;
      const g = group('View');
      const name = el('input', { type: 'text' }); name.value = v.name;
      name.onchange = () => { v.name = name.value.trim() || v.name; this.changed(); };
      const wn = el('div', { class: 'pm-input' }); wn.appendChild(name);
      row(g, 'Name', wn);
      if (v.type === 'model' || v.type === 'flat') {
        const og = group('Orientation');
        const grid = el('div', { class: 'dw-orients' });
        const cur = v.type === 'flat' ? 'flat' : v.orient;
        for (const [k, def] of [...Object.entries(D.ORIENTATIONS), ['flat', { label: 'Flat Pattern' }]]) {
          const b = el('button', { class: 'pm-btn' + (cur === k ? ' on' : '') + (k === 'flat' ? ' wide' : '') }, esc(def.label));
          b.onclick = () => this.setViewOrientation(v, k);
          grid.appendChild(b);
        }
        og.appendChild(grid);
      } else {
        // (only the text for this view's type is built: a projected view has no section / detail letter)
        const hint = v.type === 'projected' ? 'Projected from its parent view (the direction follows the sheet\'s first / third angle projection).'
          : v.type === 'section' ? `Section ${esc(v.section?.letter || '')}-${esc(v.section?.letter || '')} of its parent view.`
          : v.type === 'detail' ? `Detail ${esc(v.detail?.letter || '')} of its parent view.` : '';
        if (hint) g.appendChild(el('div', { class: 'pm-hint' }, hint));
      }
      // rotation on the sheet
      const rg = group('Rotate View');
      const rrow = el('div', { class: 'dw-rot' });
      const setRot = (deg) => {
        let r = ((deg % 360) + 360) % 360; if (r > 180) r -= 360;
        const keep = this.viewCentre(v);
        v.rot = Math.abs(r) < 1e-9 ? 0 : +r.toFixed(4);
        this.recentre(v, keep);
        this.changed();
      };
      for (const [label, dlt, title] of [['−90°', -90, 'Turn clockwise by 90°'], ['+90°', 90, 'Turn counter-clockwise by 90°'], ['180°', 180, 'Turn by 180°'], ['0°', null, 'Back to unrotated']]) {
        const b = el('button', { class: 'pm-btn', title }, label);
        b.onclick = () => setRot(dlt === null ? 0 : (v.rot || 0) + dlt);
        rrow.appendChild(b);
      }
      rg.appendChild(rrow);
      const ang = el('input', { type: 'number', step: 'any', title: 'Angle in degrees (counter-clockwise); Enter applies it' });
      ang.value = +(v.rot || 0).toFixed(4);
      const apply = () => { const x = parseFloat(ang.value); if (isFinite(x)) setRot(x); };
      ang.onchange = apply;
      ang.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); apply(); } };
      const wa = el('div', { class: 'pm-input' }); wa.append(ang, el('span', { class: 'unit' }, '°'));
      row(rg, 'Angle', wa);
      rg.appendChild(el('div', { class: 'pm-hint' }, 'Counter-clockwise on the sheet. Dimensions on the view turn with it.'));
      if (v.type === 'flat') {
        const fg = this.geos.get(v.id)?.flat;
        if (fg && fg.bodies.length > 1) row(g, 'Body', select(fg.bodies.map((id, i) => [id, `Sheet metal body ${i + 1}`]), v.body || fg.body, (b) => { v.body = b; this.changed(); }));
        const fl = group('Flat Pattern');
        for (const [key, label, def] of [['bendLines', 'Bend lines', true], ['bendNotes', 'Bend notes (direction, angle, radius)', true], ['bendTable', 'Bend table (bends numbered B1, B2 … instead of notes)', false], ['bendRegion', 'Bend region lines', false], ['etch', 'Etch lines', true], ['cutInfo', 'Cut length and pierces under the view', true]]) {
          const c = el('label', {}, `<input type="checkbox" ${(v[key] ?? def) ? 'checked' : ''}> ${esc(label)}`);
          c.querySelector('input').onchange = (ev) => { v[key] = ev.target.checked; this.changed(); };
          fl.appendChild(c);
        }
        if (fg) fl.appendChild(el('div', { class: 'pm-hint' }, `Flat size ${D.fmtNum(fg.size[0], this.doc)} × ${D.fmtNum(fg.size[1], this.doc)} mm, thickness ${D.fmtNum(fg.t, this.doc)} mm, K-factor ${D.fmtNum(fg.K, this.doc)}, bend radius ${D.fmtNum(fg.R, this.doc)} mm${fg.cut ? `, cut length ${D.fmtNum(fg.cut.length, this.doc)} mm (${fg.cut.loops} pierces)` : ''}. Seen from the ${fg.flip ? 'bottom' : 'top'} face (part: Body Properties ▸ Flat pattern seen from).${fg.stale ? ` The flat pattern no longer matches the part (${esc(fg.stale)} changed it).` : ''}`));
      }
      if (v.type !== 'detail' && v.type !== 'flat') {
        const d = group('Display');
        row(d, 'Style', select([['hlr', 'Hidden lines removed'], ['hlv', 'Hidden lines visible'], ['wire', 'Wireframe']], v.style || 'hlr', (s) => { v.style = s; this.changed(); }));
        const tg = el('label', {}, `<input type="checkbox" ${v.tangent !== false ? 'checked' : ''}> Tangent edges`);
        tg.querySelector('input').onchange = (e) => { v.tangent = e.target.checked; this.changed(); };
        d.appendChild(tg);
        const th = el('label', {}, `<input type="checkbox" ${v.threads !== false ? 'checked' : ''}> Cosmetic threads`);
        th.querySelector('input').onchange = (e) => { v.threads = e.target.checked; this.changed(); };
        d.appendChild(th);
        // (an assembly with exploded views: show this view exploded)
        const md = this.doc.models.find((x) => x.id === v.model)?.doc;
        if (md?.kind === 'assembly' && md.explodes?.length && (v.type === 'model' || v.explode)) {
          row(d, 'Exploded', select([['', 'Not exploded'], ...md.explodes.map((x) => [x.id, x.name])], v.explode || '', (s) => { (this.pendingCentre ||= new Map()).set(v.id, this.viewCentre(v)); if (s) v.explode = s; else delete v.explode; this.changed(); this.updateGeometry(); }));
        } else if (md?.kind === 'assembly' && v.type === 'model') d.appendChild(el('div', { class: 'pm-hint' }, 'Exploded views made in the assembly (Exploded View) can be shown here.'));
        // (an assembly: how its hidden lines are worked out — exactly, or quickly from the display meshes)
        if (this.modelDoc(v.model)?.kind === 'assembly' && v.type !== 'section') {
          row(d, 'Hidden lines', select([['auto', 'Automatic (fast for big assemblies)'], ['exact', 'Exact'], ['fast', 'Fast (from the display meshes)']], v.hlr || 'auto', (s) => { v.hlr = s === 'auto' ? undefined : s; this.changed(); }));
          const fg = this.geos.get(v.id);
          if (fg?.fast) d.appendChild(el('div', { class: 'pm-hint' }, `Drawn fast: lines are as exact as the 3D view's, and where they turn hidden to about ${D.fmtNum(fg.fast.cell * 2, this.doc)} mm.`));
        }
      }
      const sc = group('Scale');
      const useSheet = !v.scale;
      const cb = el('label', {}, `<input type="checkbox" ${useSheet ? 'checked' : ''}> Use the sheet scale (${D.scaleText(D.sheetScale(this.doc, v.sheet))})`);
      cb.querySelector('input').onchange = (e) => { v.scale = e.target.checked ? null : scaleOf(D.viewScale(this.doc, v)); this.changed(); };
      if (v.type === 'model' || v.type === 'detail' || v.type === 'flat') sc.appendChild(cb);
      if (v.scale) {
        const r = el('div', { class: 's-scale-row' }, '<input type="number" min="0.001" step="any"> : <input type="number" min="0.001" step="any">');
        const [i1, i2] = r.querySelectorAll('input');
        i1.value = v.scale[0]; i2.value = v.scale[1];
        const set = () => { const a = +i1.value, b = +i2.value; if (a > 0 && b > 0) { v.scale = [a, b]; this.changed(); } };
        i1.onchange = set; i2.onchange = set;
        sc.appendChild(r);
      } else if (v.type !== 'model' && v.type !== 'detail' && v.type !== 'flat') sc.appendChild(el('div', { class: 'pm-hint' }, 'Same scale as the view it was made from.'));
      if (v.type === 'section' || v.type === 'detail' || v.type === 'flat') {
        const lb = el('label', {}, `<input type="checkbox" ${v.showLabel !== false ? 'checked' : ''}> Show the view label`);
        lb.querySelector('input').onchange = (e) => { v.showLabel = e.target.checked; this.changed(); };
        sc.appendChild(lb);
      }
      if (v.type === 'section') {
        const f = el('button', { class: 'pm-btn' }, 'Flip the direction');
        f.onclick = () => { v.section.arrow = [-v.section.arrow[0], -v.section.arrow[1]]; this.changed(); };
        sc.appendChild(f);
      }
      return;
    }
    if (t.kind === 'ordinate' || t.kind === 'break') {
      const c = group(t.kind === 'ordinate' ? 'Measure' : 'Break Lines');
      const grid = el('div', { class: 'dw-orients' });
      for (const [ax, label] of t.kind === 'ordinate' ? [['x', 'Horizontal distances'], ['y', 'Vertical distances']] : [['x', 'Vertical (shortens across)'], ['y', 'Horizontal (shortens up / down)']]) {
        const b = el('button', { class: 'pm-btn' + (t.axis === ax ? ' on' : '') }, label);
        b.onclick = () => { t.axis = ax; if (t.kind === 'break') t.a = null; this.renderPM(); this.render(); };
        grid.appendChild(b);
      }
      c.appendChild(grid);
    }
    const g = group('How');
    g.appendChild(el('div', { class: 'pm-hint' }, { balloon: 'Click a part in a view, then where the balloon goes. Its number is the part\'s item in the bill of materials (asked for when the part can\'t be told).', callout: 'Click a hole in a view: the callout gives its size and depth (counterbore, countersink, thread) from the Hole feature, and how many of the same holes the view shows.', baseline: 'Click the base edge or point first, then each point or edge to dimension from it; the dimensions stack one above the other.', ordinate: 'Click the origin, then where the values line up, then the points to dimension.', chamferDim: 'Click the chamfer edge and an edge next to it, then place the text (distance × angle).', datum: 'A datum letter in a box, with a triangle on the feature.', fcf: 'A feature control frame: characteristic, tolerance (Ø zone, material condition) and datums.', sfin: 'A surface finish symbol with its roughness.', weld: 'A weld symbol on a reference line with an arrow to the joint.', aux: 'A view looking square at an inclined edge (shows its true shape).', break: 'Leaves out the middle of a long part; dimensions across it keep the true length.', crop: 'Shows only the area you draw round.', dim: 'Click a line for its length, a circle for its diameter (an arc: radius), two points, lines or circles for the distance between them (two lines at an angle: the angle), then click where the text goes.', note: 'Click on the sheet for a note; click an edge first to add a leader.', cmark: 'Click circles or arcs.', cline: 'Click two lines (or two points); the centerline runs between them.' }[t.kind] || ''));
  }

  // ------------------------------------------------------------ command ribbon / menus
  commandDefs() {
    return {
      layout: [
        { icon: 'modelView', label: 'Model View', action: () => this.startTool('model'), active: this.tool?.kind === 'model' },
        { icon: 'std3View', label: 'Standard Views', action: () => this.startTool('std3'), active: this.tool?.kind === 'std3' },
        { icon: 'projView', label: 'Projected View', action: () => this.startTool('projected'), active: this.tool?.kind === 'projected' },
        { icon: 'smFlatten', label: 'Flat Pattern', action: () => this.startTool('model', { orient: 'flat' }), active: this.tool?.kind === 'model' && this.tool.orient === 'flat' },
        'sep',
        { icon: 'sectionView', label: 'Section View', action: () => this.startTool('section'), active: this.tool?.kind === 'section' },
        { icon: 'detailView', label: 'Detail View', action: () => this.startTool('detail'), active: this.tool?.kind === 'detail' },
        { icon: 'auxView', label: 'Auxiliary View', action: () => this.startTool('aux'), active: this.tool?.kind === 'aux' },
        { icon: 'breakView', label: 'Break', action: () => this.startTool('break', this.selViewOpt()), active: this.tool?.kind === 'break' },
        { icon: 'cropView', label: 'Crop View', action: () => this.startTool('crop', this.selViewOpt()), active: this.tool?.kind === 'crop' },
        'sep',
        { icon: 'rebuild', label: 'Update Views', action: async () => { await this.refreshModels(); this.geoKeys.clear(); this.updateGeometry(); } },
      ],
      annotation: [
        { icon: 'smartdim', label: 'Dimension', action: () => this.startTool('dim'), active: this.tool?.kind === 'dim' },
        { icon: 'autoDim', label: 'Auto Dimension', action: () => this.autoDimensionDialog() },
        { icon: 'drawCheck', label: 'Check Drawing', action: () => this.checkDrawingDialog() },
        { icon: 'note', label: 'Note', action: () => this.startTool('note'), active: this.tool?.kind === 'note' },
        'sep',
        { icon: 'baselineDim', label: 'Baseline Dimension', action: () => this.startTool('baseline'), active: this.tool?.kind === 'baseline' },
        { icon: 'ordinateDim', label: 'Ordinate Dimension', action: () => this.startTool('ordinate'), active: this.tool?.kind === 'ordinate' },
        { icon: 'chamferDim', label: 'Chamfer Dimension', action: () => this.startTool('chamferDim'), active: this.tool?.kind === 'chamferDim' },
        { icon: 'holeCallout', label: 'Hole Callout', action: () => this.startTool('callout'), active: this.tool?.kind === 'callout' },
        'sep',
        { icon: 'datum', label: 'Datum Feature', action: () => this.startTool('datum'), active: this.tool?.kind === 'datum' },
        { icon: 'gdt', label: 'Geometric Tolerance', action: () => this.startTool('fcf'), active: this.tool?.kind === 'fcf' },
        { icon: 'surfFinish', label: 'Surface Finish', action: () => this.startTool('sfin'), active: this.tool?.kind === 'sfin' },
        { icon: 'weld', label: 'Weld Symbol', action: () => this.startTool('weld'), active: this.tool?.kind === 'weld' },
        'sep',
        { icon: 'centerMark', label: 'Center Mark', action: () => this.startTool('cmark'), active: this.tool?.kind === 'cmark' },
        { icon: 'centerline', label: 'Centerline', action: () => this.startTool('cline'), active: this.tool?.kind === 'cline' },
        { icon: 'revTable', label: 'Revision Table', action: () => this.revisionTable() },
        { icon: 'cutList', label: 'Cut List Table', action: () => this.addCutList() },
        { icon: 'holeCallout', label: 'Hole Table', action: () => this.addHoleTable() },
        'sep',
        { icon: 'balloon', label: 'Balloon', action: () => this.startTool('balloon'), active: this.tool?.kind === 'balloon' },
        { icon: 'bom', label: 'BOM Table', action: () => this.addBOM() },
      ],
      sheet: [
        { icon: 'sheetProps', label: 'Sheet Properties', action: () => this.sheetPropsDialog() },
        { icon: 'titleBlock', label: 'Title Block', action: () => this.propsDialog() },
        { icon: 'titleBlock', label: 'Change Template', action: () => this.changeTemplate() },
        { icon: 'addSheet', label: 'Add Sheet', action: () => this.addSheet() },
        'sep',
        { icon: 'pdf', label: 'Export PDF', action: () => this.exportPDF() },
        { icon: 'dxf', label: 'Export DXF', action: () => this.exportDXF() },
      ],
    };
  }
  cmTab = 'layout';
  renderCommandManager() {
    if (this.app.drawing !== this) return;
    const defs = this.commandDefs();
    const btns = $('#cm-buttons');
    btns.innerHTML = '';
    for (const d of defs[this.cmTab]) {
      if (d === 'sep') { btns.appendChild(el('div', { class: 'cm-sep' })); continue; }
      const b = el('button', { class: 'cm-btn' + (d.active ? ' active' : ''), title: tr(d.label) }, `<span class="cm-ic">${icon(d.icon)}</span><span>${esc(tr(d.label))}</span>`);
      b.addEventListener('click', () => { this.app.macros?.note(d.label); d.action(); });
      btns.appendChild(b);
    }
    const tabs = $('#cm-tabs');
    tabs.innerHTML = '';
    for (const [id, label] of [['layout', 'View Layout'], ['annotation', 'Annotation'], ['sheet', 'Sheet']]) {
      const t = el('button', { class: this.cmTab === id ? 'active' : '' }, esc(tr(label)));
      t.onclick = () => { this.cmTab = id; this.renderCommandManager(); };
      tabs.appendChild(t);
    }
  }

  menuDefs() {
    const a = this.app;
    return {
      File: [
        { label: 'New Part', icon: 'newdoc', key: 'Ctrl+N', action: () => a.newDocument() },
        { label: 'New Drawing', icon: 'drawing', action: () => a.newDrawing() },
        { label: 'Open…', icon: 'open', key: 'Ctrl+O', action: () => a.openFile() },
        { label: 'Recent Files / Start…', icon: 'open', action: () => a.showStart() },
        'sep',
        { label: 'Save', icon: 'save', key: 'Ctrl+S', action: () => a.saveFile() },
        { label: 'Save As…', icon: 'save', key: 'Ctrl+Shift+S', action: () => a.saveFile(true) },
        { label: 'Save as Template…', icon: 'titleBlock', action: () => this.saveAsTemplate() },
        { label: 'Change Template…', icon: 'titleBlock', action: () => this.changeTemplate() },
        'sep',
        { label: 'Export ▸ PDF…', icon: 'pdf', action: () => this.exportPDF() },
        { label: 'Export ▸ DXF (this sheet)…', icon: 'dxf', action: () => this.exportDXF() },
        'sep',
        { label: 'Drawing Properties (Title Block)…', icon: 'titleBlock', action: () => this.propsDialog() },
      ],
      Edit: [
        { label: 'Undo', icon: 'undo', key: 'Ctrl+Z', action: () => this.undo(), disabled: !this.undoStack.length },
        { label: 'Redo', icon: 'redo', key: 'Ctrl+Y', action: () => this.redo(), disabled: !this.redoStack.length },
        'sep',
        { label: 'Delete', icon: 'trash', key: 'Del', action: () => this.deleteSelection(), disabled: !this.selected.size },
      ],
      View: [
        { label: 'Zoom to Sheet', icon: 'zoomfit', key: 'F', action: () => this.fit() },
        { label: 'Update Views', icon: 'rebuild', action: async () => { await this.refreshModels(); this.geoKeys.clear(); this.updateGeometry(); } },
        'sep',
        ...this.app.ui.iconSizeItems(),
      ],
      Insert: [
        { label: 'Drawing View ▸ Model View…', icon: 'modelView', action: () => this.startTool('model') },
        { label: 'Drawing View ▸ Standard Views', icon: 'std3View', action: () => this.startTool('std3') },
        { label: 'Drawing View ▸ Projected View', icon: 'projView', action: () => this.startTool('projected') },
        { label: 'Drawing View ▸ Flat Pattern', icon: 'smFlatten', action: () => this.startTool('model', { orient: 'flat' }) },
        { label: 'Drawing View ▸ Section View', icon: 'sectionView', action: () => this.startTool('section') },
        { label: 'Drawing View ▸ Detail View', icon: 'detailView', action: () => this.startTool('detail') },
        'sep',
        { label: 'Annotations ▸ Dimension', icon: 'smartdim', action: () => this.startTool('dim') },
        { label: 'Annotations ▸ Auto Dimension', icon: 'autoDim', action: () => this.autoDimensionDialog() },
        { label: 'Annotations ▸ Note', icon: 'note', action: () => this.startTool('note') },
        { label: 'Annotations ▸ Center Mark', icon: 'centerMark', action: () => this.startTool('cmark') },
        { label: 'Annotations ▸ Centerline', icon: 'centerline', action: () => this.startTool('cline') },
        'sep',
        { label: 'DXF Drawing…', icon: 'dxf', action: () => this.insertDXF() },
        { label: 'Sheet', icon: 'addSheet', action: () => this.addSheet() },
      ],
      Tools: [
        { label: 'Settings…', icon: 'gear', action: () => this.app.ui.showSettings() },
        'sep',
        { label: 'Sheet Properties…', icon: 'sheetProps', action: () => this.sheetPropsDialog() },
        { label: 'Drawing Properties (Title Block)…', icon: 'titleBlock', action: () => this.propsDialog() },
        { label: 'Check Drawing…', icon: 'drawCheck', action: () => this.checkDrawingDialog() },
      ],
      Help: [
        { label: 'About Drawings', icon: '', action: () => this.app.ui.modal('Drawings', 'drawing', '<p>Place views of a part with <b>Model View</b> or <b>Standard Views</b>; make <b>Projected</b>, <b>Section</b> and <b>Detail</b> views from them; add <b>Dimensions</b>, <b>Notes</b>, <b>Center Marks</b> and <b>Centerlines</b>; fill in the title block (<b>Title Block</b>) and export a PDF.</p><p class="pm-hint">Middle or right mouse button drags the sheet, the wheel zooms, F fits the sheet. Drag views and annotations to move them; double-click to edit; Del deletes.</p>', [{ label: 'OK', primary: true }]) },
      ],
    };
  }
}

// ------------------------------------------------------------ helpers
function sameFile(a, b) {
  if (!a || !b) return false;
  const n = (p) => String(p).replace(/\//g, '\\').toLowerCase();
  return n(a) === n(b);
}
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function scaleOf(k) {
  if (k >= 1) return [+k.toFixed(4), 1];
  return [1, +(1 / k).toFixed(4)];
}
const onArc = (c, P) => {
  // P's angle (view coordinates are y up; sheet is y down: flip)
  const t = Math.atan2(-(P[1] - c.C[1]), P[0] - c.C[0]);
  const TAU = 2 * Math.PI, norm = (x) => ((x % TAU) + TAU) % TAU;
  return norm(t - c.a0) <= norm(c.a1 - c.a0) + 1e-6;
};
function footOnLine(p, a, b) {
  const d = unit2(sub2(b, a));
  return add2(a, mul2(d, dot2(sub2(p, a), d)));
}
function footOnSeg(p, a, b) {
  const d = sub2(b, a), L2 = dot2(d, d);
  const t = L2 > 0 ? Math.max(0, Math.min(1, dot2(sub2(p, a), d) / L2)) : 0;
  return add2(a, mul2(d, t));
}

// Highlight primitives for a picked / hovered entity.
function entPrims(e, color) {
  if (e.kind === 'point') return [{ t: 'circle', c: e.P, r: 0.9, w: 0.3, color, fill: color }];
  if (e.kind === 'line') return [{ t: 'line', a: e.A, b: e.B, w: 0.6, color }];
  if (e.kind === 'circle') return [{ t: 'circle', c: e.C, r: e.R, w: 0.6, color }];
  return [];
}

// Distance from a sheet point to a primitive (picking annotations).
function primDist(p, P) {
  if (p.t === 'line') return D.distToSeg(P, p.a, p.b);
  if (p.t === 'poly') { let d = Infinity; for (let i = 0; i < p.pts.length - 1; i++) d = Math.min(d, D.distToSeg(P, p.pts[i], p.pts[i + 1])); if (p.fill && p.closed) d = Math.min(d, insidePoly(P, p.pts) ? 0 : d); return d; }
  if (p.t === 'circle') return Math.abs(len2(sub2(P, p.c)) - p.r);
  if (p.t === 'text') {
    const w = D.textWidth(p.text, p.h, p.bold, p.font);
    const rad = ((p.rot || 0) * Math.PI) / 180;
    // the text's box in its own frame (x along the baseline, y up)
    const d = sub2(P, p.p);
    const lx = d[0] * Math.cos(rad) - d[1] * Math.sin(rad);
    const ly = -(d[0] * Math.sin(rad) + d[1] * Math.cos(rad));
    const x0 = p.anchor === 'middle' ? -w / 2 : p.anchor === 'end' ? -w : 0;
    const y0 = p.base === 'middle' ? -p.h / 2 : p.base === 'top' ? -p.h : 0;
    const dx = Math.max(x0 - lx, 0, lx - (x0 + w)), dy = Math.max(y0 - 0.3 * p.h - ly, 0, ly - (y0 + p.h * 1.1));
    return Math.hypot(dx, dy);
  }
  return Infinity;
}
function insidePoly(P, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[1] > P[1]) !== (b[1] > P[1]) && P[0] < ((b[0] - a[0]) * (P[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

// ------------------------------------------------------------ SVG
const fmtn = (x) => +x.toFixed(3);
function svgOf(prims, k, ids) {
  let out = '';
  const minW = 0.9 / k;
  for (const p of prims) {
    const col = p.color || '#000';
    const sw = fmtn(Math.max(p.w || 0.18, minW));
    const dash = p.dash ? ` stroke-dasharray="${p.dash.join(' ')}"` : '';
    if (p.t === 'line') out += `<line x1="${fmtn(p.a[0])}" y1="${fmtn(p.a[1])}" x2="${fmtn(p.b[0])}" y2="${fmtn(p.b[1])}" stroke="${col}" stroke-width="${sw}"${dash} stroke-linecap="round"/>`;
    else if (p.t === 'poly') {
      const pts = p.pts.map((q) => `${fmtn(q[0])},${fmtn(q[1])}`).join(' ');
      const fill = p.fill ? (p.fill === true ? col : p.fill) : 'none';
      out += `<${p.closed ? 'polygon' : 'polyline'} points="${pts}" fill="${fill}" stroke="${col}" stroke-width="${sw}"${dash} stroke-linejoin="round" stroke-linecap="round"/>`;
    } else if (p.t === 'circle') {
      const fill = p.fill ? (p.fill === true ? col : p.fill) : 'none';
      out += `<circle cx="${fmtn(p.c[0])}" cy="${fmtn(p.c[1])}" r="${fmtn(p.r)}" fill="${fill}" stroke="${col}" stroke-width="${sw}"${dash}/>`;
    } else if (p.t === 'text') {
      const size = p.h / D.capOf(p.font, p.bold);
      let w = D.textWidth(p.text, p.h, p.bold, p.font);
      const family = p.font && fontMetrics(p.font, p.bold) ? `'${p.font}', Helvetica, Arial, sans-serif` : 'Helvetica, Arial, sans-serif';
      let fitAttr = '';
      if (p.fit && w > p.fit) { fitAttr = ` textLength="${fmtn(p.fit)}" lengthAdjust="spacingAndGlyphs"`; w = p.fit; }
      const dx = p.anchor === 'middle' ? -w / 2 : p.anchor === 'end' ? -w : 0;
      const dy = p.base === 'middle' ? p.h / 2 : p.base === 'top' ? p.h : 0;
      out += `<text transform="translate(${fmtn(p.p[0])} ${fmtn(p.p[1])}) rotate(${fmtn(-(p.rot || 0))})" x="${fmtn(dx)}" y="${fmtn(dy)}" font-family="${family}" font-size="${fmtn(size)}"${p.bold ? ' font-weight="bold"' : ''} fill="${col}"${fitAttr} style="white-space:pre">${esc(p.text)}</text>`;
    } else if (p.t === 'image') {
      out += `<image href="${esc(p.src)}" x="${fmtn(p.x)}" y="${fmtn(p.y)}" width="${fmtn(p.w)}" height="${fmtn(p.h)}" preserveAspectRatio="none"/>`;
    } else if (p.t === 'hatch') {
      const id = `dwh${ids.n++}`;
      const d = p.loops.map((l) => 'M' + l.map((q) => `${fmtn(q[0])},${fmtn(q[1])}`).join('L') + 'Z').join(' ');
      const pts = p.loops.flat();
      const a = ((p.angle || 45) * Math.PI) / 180, dv = [Math.cos(a), -Math.sin(a)], nv = [-dv[1], dv[0]];
      let lo = Infinity, hi = -Infinity, mn = Infinity, mx = -Infinity;
      for (const q of pts) { const s1 = q[0] * nv[0] + q[1] * nv[1], s2 = q[0] * dv[0] + q[1] * dv[1]; lo = Math.min(lo, s1); hi = Math.max(hi, s1); mn = Math.min(mn, s2); mx = Math.max(mx, s2); }
      let lines = '';
      const gap = p.gap || 2.5;
      for (let s1 = Math.ceil(lo / gap) * gap; s1 <= hi; s1 += gap) {
        lines += `<line x1="${fmtn(nv[0] * s1 + dv[0] * mn)}" y1="${fmtn(nv[1] * s1 + dv[1] * mn)}" x2="${fmtn(nv[0] * s1 + dv[0] * mx)}" y2="${fmtn(nv[1] * s1 + dv[1] * mx)}"/>`;
      }
      out += `<clipPath id="${id}"><path d="${d}" clip-rule="evenodd"/></clipPath><g clip-path="url(#${id})" stroke="${col}" stroke-width="${fmtn(Math.max(p.w || 0.13, minW))}">${lines}</g>`;
    } else if (p.t === 'clip') {
      const id = `dwc${ids.n++}`;
      const shape = p.poly ? `<path d="M${p.poly.map((q) => `${fmtn(q[0])},${fmtn(q[1])}`).join('L')}Z"/>` : `<circle cx="${fmtn(p.circle.c[0])}" cy="${fmtn(p.circle.c[1])}" r="${fmtn(p.circle.r)}"/>`;
      out += `<clipPath id="${id}">${shape}</clipPath><g clip-path="url(#${id})">${svgOf(p.prims.map((q) => (p.color ? { ...q, color: p.color } : q)), k, ids)}</g>`;
    }
  }
  return out;
}

// Is point q inside polygon pts (even-odd)?
function inPoly(q, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
// Points of a clipped run that lie on one straight line are merged.
function simplifyRun(r) {
  const out = [r[0]];
  for (let i = 1; i < r.length - 1; i++) {
    const a = out[out.length - 1], b = r[i], c = r[i + 1];
    if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) > 1e-6) out.push(b);
  }
  out.push(r[r.length - 1]);
  return out;
}
// The lines of a hatch primitive, cut to its loops (even-odd).
function hatchLines(p) {
  const a = ((p.angle || 45) * Math.PI) / 180, dv = [Math.cos(a), -Math.sin(a)], nv = [-dv[1], dv[0]];
  const pts = p.loops.flat(), gap = p.gap || 2.5, out = [];
  let lo = Infinity, hi = -Infinity;
  for (const q of pts) { const s1 = q[0] * nv[0] + q[1] * nv[1]; lo = Math.min(lo, s1); hi = Math.max(hi, s1); }
  for (let s1 = Math.ceil(lo / gap) * gap; s1 <= hi; s1 += gap) {
    const ts = [];
    for (const l of p.loops) for (let i = 0; i < l.length; i++) {
      const A = l[i], B = l[(i + 1) % l.length];
      const sa = A[0] * nv[0] + A[1] * nv[1] - s1, sb = B[0] * nv[0] + B[1] * nv[1] - s1;
      if ((sa > 0) === (sb > 0) || sa === sb) continue;
      const t = sa / (sa - sb), X = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t];
      ts.push(X[0] * dv[0] + X[1] * dv[1]);
    }
    ts.sort((x, y) => x - y);
    for (let i = 0; i + 1 < ts.length; i += 2) out.push([[nv[0] * s1 + dv[0] * ts[i], nv[1] * s1 + dv[1] * ts[i]], [nv[0] * s1 + dv[0] * ts[i + 1], nv[1] * s1 + dv[1] * ts[i + 1]]]);
  }
  return out;
}
