// Macros: JavaScript that drives RazorCAD — written in Tools ▸ Macros, or recorded (Tools ▸ Record Macro) from what
// you do: the features added, changed and deleted in parts; the components, mates, parts, views, annotations and
// sheets of assemblies and drawings; and the commands run from the menus, toolbars, command search and your own
// shortcuts. Saved with the preferences (and as .js files, to share them).
//
// A macro is the body of an async function given `rc` (below) and `app`. Its changes to a part are one undo step,
// rebuilt when it ends (or at rc.rebuild()). Macros can do anything RazorCAD can: run only the ones you trust.
import * as M from './model.js';
import * as S from './sketchmodel.js';
import { applyPlan } from './claudespec.js';
import { platform } from './platform.js';
import { icon } from './icons.js';
import * as D from './drawing.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const el = (tag, attrs = {}, html = '') => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  if (html) e.innerHTML = html;
  return e;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
// a command's name as the command search knows it ("Features ▸ Fillet…" → "fillet")
export const cmdName = (label) => String(label || '').replace(/…/g, '').replace(/^[●　\s]+/, '').trim();
const cmdKey = (label) => cmdName(label).split('▸').pop().trim().toLowerCase();
const NOT_RECORDED = /macro/i;

// ------------------------------------------------------------------ recording: a document change as code
const IDENT = /^[A-Za-z_$][\w$]*$/;
const defaultName = (f) => {
  const t = M.TYPE_INFO[f.type];
  return !!t && new RegExp(`^(${[t.base, t.cutBase].filter(Boolean).map((b) => b.replace(/[-]/g, '\\-')).join('|')})\\d+$`).test(f.name || '');
};
// The statements that turn document a into b. vars: feature id → the variable holding it (features the recording
// made); other features are found by name when the macro runs.
export function diffCode(a, b, vars) {
  const ids = new Set([...a.features, ...b.features].map((f) => f.id));
  const names = new Map([...a.features, ...b.features].map((f) => [f.id, f.name]));
  const idx = (id) => (vars.has(id) ? vars.get(id) : names.has(id) ? `rc.id(${JSON.stringify(names.get(id))})` : JSON.stringify(id));
  const lit = (v) => {
    if (typeof v === 'string') return ids.has(v) ? idx(v) : JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(lit).join(', ')}]`;
    if (v && typeof v === 'object') { const e = Object.entries(v); return e.length ? `{ ${e.map(([k, x]) => `${IDENT.test(k) ? k : JSON.stringify(k)}: ${lit(x)}`).join(', ')} }` : '{}'; }
    return v === undefined ? 'null' : JSON.stringify(v);
  };
  const out = [];
  const before = new Map(a.features.map((f) => [f.id, f])), after = new Map(b.features.map((f) => [f.id, f]));
  for (const f of a.features) if (!after.has(f.id)) out.push(`await rc.remove(${idx(f.id)});`);
  for (const f of b.features) {
    const old = before.get(f.id);
    if (!old) {
      const { id, type, rev, ...props } = f;
      if (defaultName(f)) delete props.name;
      // (only what differs from a new feature of its type, so it reads like what was set)
      const def = M.createFeature(M.newDoc(), type, {});
      for (const k of Object.keys(props)) if (k !== 'plane' && k !== 'sketch' && k in def && JSON.stringify(def[k]) === JSON.stringify(props[k])) delete props[k];
      let v = IDENT.test(id) ? id : 'f' + vars.size;
      while ([...vars.values()].includes(v)) v += '_';
      out.push(`const ${v} = await rc.add(${JSON.stringify(type)}, ${lit(props)});`);
      vars.set(id, v);
      continue;
    }
    const ch = {};
    for (const k of new Set([...Object.keys(old), ...Object.keys(f)])) if (k !== 'id' && k !== 'rev' && JSON.stringify(old[k]) !== JSON.stringify(f[k])) ch[k] = f[k] === undefined ? null : f[k];
    if (Object.keys(ch).length) out.push(`await rc.set(${idx(f.id)}, ${lit(ch)});`);
  }
  // (moved in the tree)
  const kept = (list, other) => list.filter((f) => other.has(f.id)).map((f) => f.id);
  if (JSON.stringify(kept(a.features, after)) !== JSON.stringify(kept(b.features, before))) out.push(`await rc.reorder([${b.features.map((f) => idx(f.id)).join(', ')}]);`);
  const dch = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (['features', 'nextId', 'version', 'thumbnail'].includes(k)) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) dch[k] = b[k] === undefined ? null : b[k];
  }
  if (Object.keys(dch).length) out.push(`await rc.setDoc(${lit(dch)});`);
  return out;
}

// An assembly's or drawing's change as code: its lists of items with ids (components, mates, parts, views,
// annotations, sheets…) item by item, the rest with rc.setDoc. vars: item id → the variable holding it (items the
// recording made); other items are found by name (rc.ref), or by id when they have none. What is inside a part or
// model copy (`doc`) is written as it is.
export function diffEditorCode(a, b, vars) {
  const isList = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && typeof x.id === 'string');
  const lists = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => isList(a[k]) || isList(b[k]));
  const where = new Map(), names = new Map();
  for (const doc of [a, b]) for (const k of lists) for (const x of doc[k] || []) { where.set(x.id, k); if (x.name) names.set(x.id, x.name); }
  const idx = (id) => (vars.has(id) ? vars.get(id) : names.has(id) ? `rc.ref(${JSON.stringify(where.get(id))}, ${JSON.stringify(names.get(id))})` : JSON.stringify(id));
  const lit = (v, key = '') => {
    if (key === 'doc') return JSON.stringify(v); // (a part or model copy: as it is)
    if (typeof v === 'string') return where.has(v) ? idx(v) : JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map((x) => lit(x)).join(', ')}]`;
    if (v && typeof v === 'object') { const e = Object.entries(v); return e.length ? `{ ${e.map(([k, x]) => `${IDENT.test(k) ? k : JSON.stringify(k)}: ${lit(x, k)}`).join(', ')} }` : '{}'; }
    return v === undefined ? 'null' : JSON.stringify(v);
  };
  const out = [];
  for (const k of lists) {
    const before = new Map((a[k] || []).map((x) => [x.id, x])), after = new Map((b[k] || []).map((x) => [x.id, x]));
    for (const x of a[k] || []) if (!after.has(x.id)) out.push(`await rc.removeItem(${JSON.stringify(k)}, ${idx(x.id)});`);
    for (const x of b[k] || []) {
      const old = before.get(x.id);
      if (!old) {
        let v = IDENT.test(x.id) ? x.id : 'x' + vars.size;
        while ([...vars.values()].includes(v)) v += '_';
        const { id, ...item } = x;
        // (its own id only tells what kind of id the new one gets)
        const rest = lit(item);
        out.push(`const ${v} = await rc.addItem(${JSON.stringify(k)}, { id: ${JSON.stringify(id)}${rest === '{}' ? ' }' : ', ' + rest.slice(2)});`);
        vars.set(x.id, v);
        continue;
      }
      const ch = {};
      for (const key of new Set([...Object.keys(old), ...Object.keys(x)])) if (key !== 'id' && JSON.stringify(old[key]) !== JSON.stringify(x[key])) ch[key] = x[key] === undefined ? null : x[key];
      if (Object.keys(ch).length) out.push(`await rc.setItem(${JSON.stringify(k)}, ${idx(x.id)}, ${lit(ch)});`);
    }
  }
  const dch = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (lists.includes(key) || ['nextId', 'version', 'kind', 'thumbnail'].includes(key)) continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) dch[key] = b[key] === undefined ? null : b[key];
  }
  if (Object.keys(dch).length) out.push(`await rc.setDoc(${lit(dch)});`);
  return out;
}

// ------------------------------------------------------------------ the macro API
export function makeRC(app, macros, log) {
  let stale = false, changed = false;
  const partDoc = () => {
    if (app.mode === 'drawing') throw new Error('This needs a part in front (an assembly or drawing is)');
    if (app.mode === 'sketch' || app.mode === 'sketch3d') throw new Error('Finish the sketch first');
    if (app.pm) app.cancelPM();
    return app.doc;
  };
  const find = (ref) => {
    const d = partDoc(), f = d.features.find((x) => x.id === ref) || d.features.find((x) => x.name === ref);
    if (!f) throw new Error(`There is no feature "${ref}"`);
    return f;
  };
  const touch = () => { stale = true; changed = true; };
  // (the assembly or drawing in front, changed by the macro: its undo step begun once, and it is brought up to date
  // — parts built, mates solved, views drawn — when the macro ends or runs a command)
  let edTouched = null;
  const editor = () => {
    if (app.mode !== 'drawing' || !app.drawing) throw new Error('This needs an assembly or drawing in front');
    const e = app.drawing;
    if (!edTouched) { edTouched = e; e.begin?.(); }
    return e;
  };
  const flushEditor = async () => {
    const e = edTouched;
    if (!e) return;
    edTouched = null;
    if (e.loadParts) { await e.loadParts(); e.solve(); e.change('Macro done.'); } else e.changed();
  };
  const findItem = (e, list, ref) => (e.doc[list] || []).find((x) => x.id === ref) || (e.doc[list] || []).find((x) => x.name === ref);
  const commit = () => { if (changed) { changed = false; app.commit(); app.ui.renderTree(); } };
  const build = async () => { if (stale) { stale = false; await app.rebuild(); } await flushEditor(); };
  const rc = {
    app, M, S,
    // ---- parts: features
    id: (name) => find(name).id,
    feature: (ref) => find(ref),
    features: () => partDoc().features.map((f) => ({ id: f.id, name: f.name, type: f.type, suppressed: !!f.suppressed })),
    async add(type, props = {}) {
      const d = partDoc();
      if (!M.TYPE_INFO[type]) throw new Error(`Unknown feature type "${type}"`);
      const f = M.createFeature(d, type, JSON.parse(JSON.stringify(props)));
      M.insertFeature(d, f);
      touch();
      return f.id;
    },
    async set(ref, props) {
      const f = find(ref);
      for (const [k, v] of Object.entries(props || {})) { if (k === 'id' || k === 'type') continue; if (v === null && !(k in f)) continue; f[k] = JSON.parse(JSON.stringify(v)); }
      if (f.type === 'sketch') f.rev = M.newRev();
      touch();
      return f.id;
    },
    async remove(ref) {
      const d = partDoc(), f = d.features.find((x) => x.id === ref) || d.features.find((x) => x.name === ref);
      if (!f) return false;
      const i = d.features.indexOf(f);
      d.features.splice(i, 1);
      if (d.rollbackAt === f.id) d.rollbackAt = d.features[i]?.id ?? null;
      touch();
      return true;
    },
    async reorder(refs) {
      const d = partDoc(), fs = refs.map((r) => d.features.find((x) => x.id === r || x.name === r)).filter(Boolean);
      const slots = fs.map((f) => d.features.indexOf(f)).sort((x, y) => x - y);
      slots.forEach((s, i) => { d.features[s] = fs[i]; });
      touch();
    },
    // ---- assemblies and drawings: their lists of items (components, mates, parts, explodes, motions; models,
    // sheets, views, anns…), as the documents store them
    async addItem(list, item) {
      const e = editor(), arr = (e.doc[list] ||= []);
      const prefix = String(item?.id || list[0]).replace(/\d+$/, '') || list[0];
      const id = e.uid ? e.uid(prefix) : D.newId(e.doc, prefix);
      arr.push({ ...JSON.parse(JSON.stringify(item || {})), id });
      return id;
    },
    async setItem(list, ref, props) {
      const e = editor(), x = findItem(e, list, ref);
      if (!x) throw new Error(`There is no "${ref}" in ${list}`);
      for (const [k, v] of Object.entries(props || {})) { if (k === 'id') continue; if (v === null) delete x[k]; else x[k] = JSON.parse(JSON.stringify(v)); }
      return x.id;
    },
    async removeItem(list, ref) {
      const e = editor(), x = findItem(e, list, ref);
      if (!x) return false;
      e.doc[list] = e.doc[list].filter((y) => y !== x);
      return true;
    },
    ref(list, name) {
      if (app.mode !== 'drawing' || !app.drawing) throw new Error('This needs an assembly or drawing in front');
      const x = findItem(app.drawing, list, name);
      if (!x) throw new Error(`There is no "${name}" in ${list}`);
      return x.id;
    },
    items: (list) => (app.mode === 'drawing' && app.drawing ? (app.drawing.doc[list] || []).map((x) => ({ id: x.id, name: x.name, type: x.type })) : []),
    async setDoc(props) {
      if (app.mode === 'drawing') {
        const e = editor();
        for (const [k, v] of Object.entries(props || {})) { if (v === null) delete e.doc[k]; else e.doc[k] = JSON.parse(JSON.stringify(v)); }
        return;
      }
      const d = partDoc();
      for (const [k, v] of Object.entries(props || {})) { if (k === 'features') continue; if (v === null) delete d[k]; else d[k] = JSON.parse(JSON.stringify(v)); }
      touch();
    },
    async equation(name, expr) {
      const d = partDoc();
      d.equations ||= [];
      const e = d.equations.find((x) => x.name === name);
      if (e) e.expr = String(expr); else d.equations.push({ name, expr: String(expr) });
      touch();
    },
    // A sketch on a plane ('front' | 'top' | 'right', or a plane feature), drawn by draw(s): s.line(x1, y1, x2, y2),
    // s.polyline([[x, y]…], closed = true), s.rect(x, y, w, h), s.centerRect(cx, cy, w, h), s.circle(cx, cy, r),
    // s.arc(cx, cy, x1, y1, x2, y2) (counter-clockwise), s.polygon(cx, cy, r, sides), s.point(x, y). Lines that
    // meet share their end points, so closed outlines make profiles.
    async sketch(plane, draw) {
      const d = partDoc(), ref = ['front', 'top', 'right'].includes(plane) ? plane : find(plane).id;
      const sk = M.createFeature(d, 'sketch', { plane: { ref } });
      const at = new Map();
      const pt = (x, y) => { const k = `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`; if (!at.has(k)) at.set(k, S.addPoint(sk, x, y)); return at.get(k); };
      const s = {
        point: (x, y) => pt(x, y),
        line: (x1, y1, x2, y2) => S.addLine(sk, pt(x1, y1), pt(x2, y2)),
        polyline(pts, closed = true) { const out = []; for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; out.push(s.line(p[0], p[1], q[0], q[1])); } return out; },
        rect: (x, y, w, h) => s.polyline([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]),
        centerRect: (cx, cy, w, h) => s.rect(cx - w / 2, cy - h / 2, w, h),
        circle: (cx, cy, r) => S.addCircle(sk, S.addPoint(sk, cx, cy), r),
        arc: (cx, cy, x1, y1, x2, y2) => S.addArc(sk, S.addPoint(sk, cx, cy), pt(x1, y1), pt(x2, y2)),
        polygon: (cx, cy, r, n = 6) => s.polyline(Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)])),
      };
      await draw?.(s);
      M.insertFeature(d, sk);
      touch();
      return sk.id;
    },
    extrude: (sketch, depth = 10, opts = {}) => rc.add('extrude', { sketch, depth, ...opts }),
    cut: (sketch, depth = 10, opts = {}) => rc.add('extrude', { sketch, depth, op: 'cut', ...opts }),
    revolve: (sketch, angle = 360, opts = {}) => rc.add('revolve', { sketch, angle, ...opts }),
    // features in the form Ask Claude uses (see its guide): { features: [{ id, type, … }] }; their ids
    async plan(plan) { const ids = applyPlan(partDoc(), plan); touch(); return ids; },
    async newPart(name = null) { commit(); await build(); app.newDocument(); if (name) { app.doc.name = name; touch(); } },
    // the part rebuilt now: { bodies, errors: [{ feature, error }] }
    async rebuild() {
      partDoc();
      stale = true;
      await build();
      return { bodies: (app.result?.bodies || []).length, errors: [...(app.result?.errors || [])].map(([id, error]) => ({ feature: M.findFeature(app.doc, id)?.name || id, error })) };
    },
    // ---- any document: commands, as the command search names them
    commands: () => app.ui.commandList().map((c) => c.label),
    async command(name) {
      commit(); await build();
      const k = cmdKey(name), commands=app.ui.commandList(), c = commands.find(x=>x.k===k)||commands.find(x=>x.aliases?.includes(k));
      if (!c) throw new Error(`"${name}" is not a command here`);
      await c.action();
      await wait(30);
    },
    async run(name) { const m = macros.list().find((x) => x.name === name); if (!m) throw new Error(`There is no macro "${name}"`); commit(); await build(); await new AsyncFunction('rc', 'app', m.code)(rc, app); },
    // ---- talking to you
    log: (...args) => { log.push(args.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); },
    status: (msg) => app.status(String(msg)),
    wait,
    ask: (question, value = '') => macros.ask(question, value),
    _end: async () => { commit(); await build(); },
  };
  return rc;
}

// ------------------------------------------------------------------ the macros, the recorder and the dialog
export class Macros {
  constructor(app) {
    this.app = app;
    this.rec = null; // recording: { lines, vars, key (the part's history), last (its JSON), pending (a command) }
    this.running = false;
  }
  list() { const p = (this.app.ui.prefs ||= {}); return (p.macros ||= []); }
  store(list) { this.app.ui.prefs.macros = list; this.app.ui.savePrefs(); }
  // menu items (added to every Tools menu)
  menuItems() {
    return [
      { label: 'Macros…', icon: 'macro', action: () => this.showDialog() },
      this.rec ? { label: 'Stop Recording Macro', icon: 'macroStop', action: () => this.stopRecording() } : { label: 'Record Macro', icon: 'macroRec', action: () => this.startRecording() },
      ...this.list().map((m) => ({ label: `Macro: ${m.name}`, icon: 'macro', action: () => this.runMacro(m) })),
    ];
  }

  // ---- running
  async run(code, name = 'Macro') {
    if (this.running) return { ok: false, error: 'A macro is running already' };
    this.running = true;
    const log = [], t0 = performance.now();
    const rc = makeRC(this.app, this, log);
    const a = this.app, empty = a.mode !== 'drawing' && !a.doc?.features?.some((f) => f.type !== 'sketch' && f.type !== 'plane' && f.type !== 'axis' && f.type !== 'point'), doc0 = a.doc;
    try {
      await new AsyncFunction('rc', 'app', code)(rc, this.app);
      await rc._end();
      // (a part that was empty: the model shown whole)
      if (empty && a.doc === doc0 && a.mode !== 'drawing' && (a.result?.bodies || []).length) a.viewport.zoomToFit();
      return { ok: true, log, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      await rc._end().catch(() => {});
      const m = /<anonymous>:(\d+):\d+/.exec(e?.stack || '');
      return { ok: false, error: e?.message || String(e), line: m ? Number(m[1]) - 2 : null, log };
    } finally { this.running = false; }
  }
  async runMacro(m) {
    this.app.status(`Running macro ${m.name}…`);
    const r = await this.run(m.code, m.name);
    if (r.ok) this.app.status(`Macro ${m.name} done${r.log.length ? ': ' + r.log[r.log.length - 1] : ''}.`);
    else this.app.toast(`Macro ${m.name}: ${r.error}${r.line ? ` (line ${r.line})` : ''}`, true);
    return r;
  }
  ask(question, value = '') {
    return new Promise((resolve) => {
      const body = el('div'), input = el('input', { type: 'text', style: 'width:100%;margin-top:6px' });
      input.value = value;
      body.append(el('p', {}, esc(question)), input);
      let done = false;
      const end = (v) => { if (!done) { done = true; resolve(v); } };
      const dlg = this.app.ui.modal('Macro', 'macro', body, [{ label: 'OK', primary: true, action: () => end(input.value) }, { label: 'Cancel', action: () => end(null) }]);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); end(input.value); dlg.close(); } });
      const obs = new MutationObserver(() => { if (!body.isConnected) { obs.disconnect(); end(null); } });
      obs.observe(document.getElementById('modal-root'), { childList: true });
      setTimeout(() => input.focus(), 0);
    });
  }

  // ---- recording
  startRecording() {
    if (this.rec) return;
    this.rec = { lines: [], vars: new Map(), key: null, last: null, pending: null, t0: new Date() };
    if (this.app.mode !== 'drawing') { this.rec.key = this.app.history; this.rec.last = JSON.stringify(this.app.doc); }
    // (each open assembly and drawing as it is now, for its first change)
    for (const t of this.app.tabs) if (t.kind === 'drawing' && t.drawing) t.drawing._macroBase = JSON.stringify(t.drawing.doc);
    this.showRecording(true);
    this.app.status('Recording a macro: the features you add, change or delete, and the commands you run. Tools ▸ Stop Recording Macro ends it.');
  }
  // a command run from a menu, toolbar, the command search or a shortcut
  note(label) {
    const r = this.rec;
    if (!r || this.running || !label || NOT_RECORDED.test(label)) return;
    this.flushPending();
    r.pending = cmdName(label);
  }
  flushPending() {
    const r = this.rec;
    if (r?.pending) { r.lines.push(`await rc.command(${JSON.stringify(r.pending)});`); r.pending = null; }
  }
  // the part in front changed (a commit, undo or redo); prev: its JSON before
  sync(prev = null) {
    const r = this.rec, a = this.app;
    if (!r || a.mode === 'drawing' || !a.doc) return;
    const now = JSON.stringify(a.doc);
    if (r.key !== a.history) { r.key = a.history; r.last = prev || now; }
    if (r.last === now) return;
    // (the command just run made this change: the change is what is recorded)
    r.pending = null;
    try { r.lines.push(...diffCode(JSON.parse(r.last), JSON.parse(now), r.vars)); } catch (e) { r.lines.push(`// (not recorded: ${String(e.message).replace(/\n/g, ' ')})`); }
    r.last = now;
  }
  // an assembly or drawing changed (a change, undo or redo)
  syncEditor(ed) {
    const r = this.rec;
    if (!r || !ed?.doc) return;
    const now = JSON.stringify(ed.doc);
    if (r.key !== ed) { r.key = ed; r.last = ed._macroBase ?? now; }
    ed._macroBase = now;
    if (r.last === now) return;
    r.pending = null;
    try { r.lines.push(...diffEditorCode(JSON.parse(r.last), JSON.parse(now), r.vars)); } catch (e) { r.lines.push(`// (not recorded: ${String(e.message).replace(/\n/g, ' ')})`); }
    r.last = now;
  }
  stopRecording() {
    const r = this.rec;
    if (!r) return null;
    if (this.app.mode === 'drawing') this.syncEditor(this.app.drawing); else this.sync();
    this.flushPending();
    this.rec = null;
    this.showRecording(false);
    const t = r.t0, two = (n) => String(n).padStart(2, '0');
    const stamp = `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())} ${two(t.getHours())}:${two(t.getMinutes())}`;
    const code = `// Recorded ${stamp}\n${r.lines.join('\n')}\n`;
    this.app.status(`Macro recorded (${r.lines.length} step${r.lines.length === 1 ? '' : 's'}): Save keeps it.`);
    this.showDialog({ name: `Recorded ${stamp}`, code, unsaved: true });
    return code;
  }
  showRecording(on) {
    let pill = document.getElementById('status-macro');
    if (!pill) {
      pill = el('span', { id: 'status-macro', title: 'Recording a macro — click to stop' }, '● Recording macro');
      pill.onclick = () => this.stopRecording();
      document.getElementById('status-msg')?.before(pill);
    }
    pill.hidden = !on;
  }

  // ---- files
  async exportMacro(m) {
    const name = (m.name || 'Macro').replace(/[\\/:*?"<>|]+/g, '_') + '.js';
    return platform.saveBinary(name, new TextEncoder().encode(`// RazorCAD macro: ${m.name}\n${m.code}`), 'js');
  }
  async importMacro() {
    const f = await platform.openMacro();
    if (!f?.content) return null;
    const code = f.content.replace(/^\/\/ RazorCAD macro: .*\r?\n/, '');
    return { name: (f.name || 'Macro').replace(/\.js$/i, ''), code };
  }

  // ---- the dialog: the macros saved, an editor, Run / Save / Delete, Record, import and export
  showDialog(open = null) {
    const ui = this.app.ui;
    let list = this.list().slice();
    let cur = open ? { id: null, name: open.name, code: open.code } : list[0] ? { ...list[0] } : { id: null, name: 'Macro1', code: SAMPLE };
    const body = el('div', { class: 'macros' });
    body.innerHTML = `<div class="mc-side"><div class="mc-list"></div><button class="mc-new">New Macro</button></div>
      <div class="mc-main"><div class="mc-row"><label class="pm-label">Name</label><input class="mc-name" type="text" spellcheck="false"></div>
      <textarea class="mc-code" spellcheck="false" wrap="off" data-own-escape></textarea>
      <div class="mc-bar"><button class="primary mc-run">▶ Run</button><button class="mc-save">Save</button><button class="mc-del">Delete</button><span class="mc-gap"></span>
      <button class="mc-rec">● Record Macro</button><button class="mc-imp">Import…</button><button class="mc-exp">Export…</button><button class="mc-help">API</button></div>
      <pre class="mc-out"></pre><pre class="mc-api" hidden>${esc(API_HELP)}</pre>
      <p class="pm-hint">Macros can do anything RazorCAD can (change and save files): run only macros you trust. Saved macros are in Tools ▸ Macro: and the command search, so they can have shortcuts.</p></div>`;
    const $ = (s) => body.querySelector(s);
    const nameIn = $('.mc-name'), code = $('.mc-code'), out = $('.mc-out');
    const show = (m) => { cur = m; nameIn.value = m.name; code.value = m.code; out.textContent = open?.unsaved && !m.id ? 'Recorded: Save keeps it, Run plays it back.' : ''; renderList(); };
    const renderList = () => {
      const box = $('.mc-list');
      box.innerHTML = '';
      if (!list.length && !cur.id) box.appendChild(el('div', { class: 'pm-hint' }, 'No macros saved yet'));
      for (const m of list) {
        const li = el('div', { class: 'li' + (cur.id === m.id ? ' active' : '') }, `${icon('macro')}<span>${esc(m.name)}</span>`);
        li.onclick = () => show({ ...m });
        box.appendChild(li);
      }
      $('.mc-del').disabled = !cur.id;
    };
    const save = () => {
      const name = nameIn.value.trim() || 'Macro';
      const clash = list.find((m) => m.name === name && m.id !== cur.id);
      if (clash) { out.textContent = `There is a macro called "${name}" already.`; return false; }
      cur = { id: cur.id || 'm' + Date.now().toString(36), name, code: code.value };
      const i = list.findIndex((m) => m.id === cur.id);
      if (i >= 0) list[i] = cur; else list.push(cur);
      this.store(list.slice());
      out.textContent = `Saved "${name}".`;
      renderList();
      return true;
    };
    code.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Tab') { e.preventDefault(); const s = code.selectionStart; code.setRangeText('  ', s, code.selectionEnd, 'end'); }
      else if (e.key === 'Escape') { e.preventDefault(); dlg.close(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
      else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); $('.mc-run').click(); }
    });
    nameIn.addEventListener('keydown', (e) => e.stopPropagation());
    $('.mc-new').onclick = () => { let n = 1; while (list.some((m) => m.name === 'Macro' + n)) n++; show({ id: null, name: 'Macro' + n, code: SAMPLE }); };
    $('.mc-save').onclick = save;
    $('.mc-del').onclick = async () => {
      if (!cur.id) return;
      const c = await ui.choose('Delete Macro', 'trash', `<p>Delete the macro <b>${esc(cur.name)}</b>?</p>`, [['del', 'Delete', true], ['cancel', 'Cancel']]);
      if (c !== 'del') return;
      list = list.filter((m) => m.id !== cur.id);
      this.store(list.slice());
      show(list[0] ? { ...list[0] } : { id: null, name: 'Macro1', code: SAMPLE });
    };
    $('.mc-run').onclick = async () => {
      out.textContent = 'Running…';
      const r = await this.run(code.value, nameIn.value);
      out.textContent = (r.log.length ? r.log.join('\n') + '\n' : '') + (r.ok ? `Done (${r.ms} ms).` : `Error${r.line ? ` on line ${r.line}` : ''}: ${r.error}`);
      out.classList.toggle('err', !r.ok);
      if (!r.ok && r.line) { const lines = code.value.split('\n'), s = lines.slice(0, r.line - 1).join('\n').length + (r.line > 1 ? 1 : 0); code.focus(); code.setSelectionRange(s, s + (lines[r.line - 1] || '').length); }
    };
    $('.mc-rec').onclick = () => { dlg.close(); this.startRecording(); };
    $('.mc-imp').onclick = async () => { const m = await this.importMacro().catch((e) => { out.textContent = 'Could not open it: ' + e.message; return null; }); if (m) { show({ id: null, ...m }); out.textContent = `Opened "${m.name}": read it before you run it, then Save to keep it.`; } };
    $('.mc-exp').onclick = () => this.exportMacro({ name: nameIn.value.trim() || 'Macro', code: code.value });
    $('.mc-help').onclick = () => { const h = $('.mc-api'); h.hidden = !h.hidden; };
    const dlg = ui.modal('Macros', 'macro', body, [{ label: 'Close' }]);
    dlg.body.closest('.modal')?.classList.add('modal-wide');
    show(cur);
    if (open?.unsaved) out.textContent = `Recorded ${code.value.split('\n').filter((l) => l.startsWith('await') || l.startsWith('const')).length} steps: Save keeps it, Run plays it back.`;
    return dlg;
  }
}

const SAMPLE = `// A plate with a hole in each corner. rc.log shows text below; Ctrl+Enter runs, Ctrl+S saves.
const w = Number(await rc.ask('Plate width (mm)?', '120')) || 120, d = 80, t = 10;
const plate = await rc.sketch('top', (s) => s.centerRect(0, 0, w, d));
await rc.extrude(plate, t);
const holes = await rc.sketch('top', (s) => { for (const x of [-1, 1]) for (const y of [-1, 1]) s.circle(x * (w / 2 - 10), y * (d / 2 - 10), 4.5); });
await rc.cut(holes, t);
const r = await rc.rebuild();
rc.log(\`\${r.bodies} body, \${r.errors.length} errors\`);
`;

const API_HELP = `rc — what a macro can use (await the ones that are async):
Parts (the part in front):
  await rc.sketch(plane, s => { … })  a sketch on 'front' | 'top' | 'right' (or a plane feature); its id.
      s.line(x1, y1, x2, y2)  s.polyline([[x, y], …], closed = true)  s.rect(x, y, w, h)  s.centerRect(cx, cy, w, h)
      s.circle(cx, cy, r)  s.arc(cx, cy, x1, y1, x2, y2)  s.polygon(cx, cy, r, sides)  s.point(x, y)
  await rc.extrude(sketch, depth, { reverse, end: 'through', … })   await rc.cut(sketch, depth, { … })
  await rc.revolve(sketch, angle = 360, { … })
  await rc.add(type, props)        any feature, with the properties a part file stores (see a recorded macro); its id
  await rc.set(feature, props)     change a feature (by id or name)    await rc.remove(feature)
  await rc.reorder([features…])    await rc.setDoc({ material: 'steel', name: … })
  await rc.equation(name, expr)    a global variable (equations)
  await rc.plan({ features: […] }) features in the form Ask Claude uses
  rc.id(name)  rc.feature(name)  rc.features()
  await rc.rebuild()  → { bodies, errors }   (a macro's changes are rebuilt when it ends anyway)
  await rc.newPart(name)
Assemblies and drawings (the one in front):
  await rc.addItem(list, item)      add to a list of the document: 'parts', 'components', 'mates', 'explodes'…;
                                    'models', 'sheets', 'views', 'anns'… (as the file stores them); its new id
  await rc.setItem(list, item, props)   await rc.removeItem(list, item)   (an item by id or name)
  rc.ref(list, name) → its id      rc.items(list)      await rc.setDoc({ … })   (parts are built, mates solved,
                                    views drawn when the macro ends or runs a command)
Any document:
  await rc.command('Zoom to Fit')  a command, by its name in the command search    rc.commands()
  await rc.run('Other macro')     await rc.ask(question, value) → text or null    await rc.wait(ms)
  rc.log(…)  rc.status(text)       rc.app (the whole application), rc.M (part model), rc.S (sketches)
A macro's changes to a part are one undo step.`;
