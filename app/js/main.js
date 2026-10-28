// Application controller: owns the document, routes input, and coordinates the
// viewport, sketcher and UI.
import * as THREE from 'three';
import { Viewport } from './viewport.js';
import { Sketcher, SKETCH_TOOLS } from './sketcher.js';
import { Sketcher3D, S3_TOOLS } from './sketch3d.js';
import { ToolWheel } from './toolwheel.js';
import { breadcrumb, reportError, installCrashHandlers, rememberPart } from './crash.js';
import { UI } from './ui.js';
import * as M from './model.js';
import * as G from './geometry.js';
import * as S from './sketchmodel.js';
import * as LR from './loftrefs.js';
import * as LC from './loftcorrespondence.js';
import {useReferenceRelations} from './refgeom.js';
import { evaluate, evalEquations, fmt } from './expr.js';
import { KernelClient, KernelPool, packFeature } from './kernelclient.js';
import { platform } from './platform.js';
import { RELATION_INFO } from './solver.js';
import { FONTS, fontFile, fontKey, BUNDLED_FAMILIES, fallbackFamily } from './fonts.js';
import { loadDxfSettings, saveDxfSettings, selectEnts, buildDXF, dxfFileName } from './dxf.js';
import { CLAUDE_MODELS, RAZORCAD_GUIDE, describePart, parseReply, applyPlan } from './claudespec.js';
import { DrawingEditor } from './drawingeditor.js';
import { AssemblyEditor, isAssembly, newAssembly } from './assembly.js';
import { ExplodeTool, explodeOffsets, offsetMesh, drawExplodeLines, animateExplode, newExplodeId } from './explode.js';
import { hashText, packResult, unpackResult } from './modelcache.js';
import { unitOf, UNIT_SYSTEM } from './units.js';
import { isTemplate, drawingFromTemplate } from './drawtemplates.js';
import { bodySignature, groupBodies, sameBody } from './bodygroups.js';
import * as D from './drawing.js';
import { Macros } from './macros.js';
import { igesToStep } from './igesstep.js';
import { installA11y, onControl } from './a11y.js';
import { machineInfo, kernelBudget, memoryFor, threadsPerKernel } from './machine.js';
import * as W from './wcs.js';
import { relabelAxes3D } from './sketch3dmodel.js';

// Saved parts are auto-saved next to their file at most this often while they have unsaved changes.
const AUTOSAVE_MS = 20000;

// Tools on the right-button tool wheel, clockwise from the top.
const WHEEL_TOOLS = [
  ['select', 'select'], ['dim', 'smartdim'], ['line', 'line'], ['centerline', 'centerline'],
  ['rect', 'rect'], ['crect', 'crect'], ['circle', 'circle'], ['arc', 'arc'],
  ['slot', 'slot'], ['polygon', 'polygon'], ['trim', 'trim'], ['convert', 'convert'], ['offset', 'offset'],
  ['sfillet', 'sketchFillet'], ['schamfer', 'sketchChamfer'],
];

const $ = (s) => document.querySelector(s);

class App {
  constructor() {
    this.viewport = new Viewport($('#viewport'), $('#c'), $('#labels'));
    this.history = new M.History();
    this.sketcher = new Sketcher(this);
    this.sketch3d = new Sketcher3D(this);
    this.mode = 'part';
    this.pm = null;
    this.selection = null;
    // edges and sketch curves picked for the quick dimension readout (Ctrl+click adds more)
    this.measureSel = [];
    // what is shown in the view (View ▸ Visibility / the eye drop-down); kept between sessions
    this.vis = { planes: true, sketches: true, axes: true, points: true, surfaces: true };
    this.showPlanes = false; // the standard Front / Top / Right planes
    try { const v = JSON.parse(localStorage.getItem('razorcad.vis') || 'null'); if (v) { Object.assign(this.vis, v.vis || {}); this.showPlanes = !!v.showPlanes; } } catch { /* defaults */ }
    this.isolated = null;        // Set of body ids shown while isolating (session only)
    this.showHiddenMode = false; // showing only the hidden bodies, to bring them back
    this.tabs = [{}];            // open parts; the active one's state lives on the app itself
    this.tabIndex = 0;           // (a drawing tab is { kind: 'drawing', drawing: DrawingEditor })
    this.drawing = null;         // the active drawing (mode 'drawing')
    this.filters = new Set(); // selection filter: empty = pick whatever is under the cursor
    this.hoverPlane = null;
    this.hoverFaceKey = null;
    // (plane: a standard plane, or 'custom': the plane of a face or plane picked, custom = { o, n, name })
    // (more: Sections 2 and 3, used when ticked; active: the one the arrow and a click in the view move, 0 = Section 1)
    this.sectionState = { plane: 'front', offset: 0, flip: false, custom: null, active: 0,
      more: [{ on: false, plane: 'top', offset: 0, flip: false, custom: null }, { on: false, plane: 'right', offset: 0, flip: false, custom: null }] };
    this.dirty = false;
    this.ui = new UI(this);
    this.filePath = null;
    installCrashHandlers(this);
    // (a part's kernel: multi-threaded where the PC and the page allow it; the pool's kernels work on whole parts side by side)
    this.kernel = new KernelClient({ threads: threadsPerKernel(undefined, undefined, true) }); // (Kernel Lab: the first part's kernel: front)
    this.kernelPool = new KernelPool(this.kernel); // (more kernels for assemblies and drawings)
    // (the kernels at once: from the PC's threads and free memory; a kernel for each open part, up to tabKernelMax)
    this.tabKernelMax = 1;
    this.sizeKernels();
    this.macros = new Macros(this); // (Tools ▸ Macros: recording and running them)
    // the theme changed: the 3D view's and the sketch's lines in its colours
    window.addEventListener('razorcad-theme', () => {
      this.viewport.applyDisplayStyle();
      if (this.mode === 'sketch') this.sketcher?.redraw?.();
      else if (this.mode === 'sketch3d') this.sketch3d?.redraw?.();
      this.drawing?.render?.();
    });
    this.wireKernel(this.kernel);
    // (which kernel this is, in the session log and crash reports)
    this.kernel.ready.then(() => this.kernel.stats()).then((st) => st && breadcrumb(`Geometry kernel ready: ${st.build === 'replicad_multi' ? `multi-threaded, ${st.threads} threads` : 'single-threaded'}`)).catch(() => {});
    this.result = { vars: {}, ev: (x) => evaluate(x, {}), errors: new Map(), eqErrors: new Map(), sketches: new Map(), planes: new Map(), consumed: new Set(), body: null, time: 0 };
    this.wireViewport();
    this.wireKeys();
    this.init();
  }

  async init() {
    this.status('Starting…');
    this.ui.initTreeKeys();
    await platform.ready;
    // which graphics card draws the view, and the machine (in the session log, for crash reports)
    try {
      const gl = this.viewport.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      breadcrumb(`Graphics: ${ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)} · ${navigator.hardwareConcurrency || '?'} CPU threads`);
    } catch { /* not available */ }
    // the browser version (razorcad.com/app): what works differently, and a warning before unsaved work is lost
    if (!platform.desktop && window.RAZORCAD_WEB) {
      this.ui.showWebNotice();
      window.addEventListener('beforeunload', (e) => { if (this.anyDirty()) { e.preventDefault(); e.returnValue = ''; } });
    }
    this.status('Loading the geometry kernel…');
    this.showProgress(null, 'Loading the geometry kernel…', 0);
    await this.setDoc(M.newDoc(), { fit: true });
    this.hideProgress();
    this.status('Ready');
    // started for files (double-click in Explorer): open them instead of showing the start window
    let paths = [];
    try { paths = await platform.takeOpenRequests(); } catch { /* none */ }
    if (paths.length) await this.openRequested(paths);
    else this.showStart();
    // a newer version on GitHub? (once a day, a little after starting, unless turned off)
    setTimeout(() => this.ui.checkForUpdates(false).catch(() => {}), 8000);
  }

  // Files Windows asked RazorCAD to open (this launch, or another one handing them over).
  async openRequested(paths) {
    document.querySelector('.modal-back.start-back')?.remove();
    for (const p of paths || []) {
      breadcrumb(`Open from Windows: ${p}`);
      await this.openRecent(p);
    }
  }

  // Start window: recent parts, new part, open (and any new crash reports).
  async showStart() {
    let info = { recent: [], legacy: null };
    try { info = await platform.getStartInfo(); } catch { /* show an empty list */ }
    try { info.crashes = await platform.getCrashInfo(); } catch { info.crashes = null; }
    this.ui.showStart(info);
  }

  // A crash report was written during this session: tell the user once.
  crashReported(where, kind) {
    if (kind === 'kernel-restarted') return; // the restart was already announced
    if (this._crashToastShown) return;
    this._crashToastShown = true;
    this.toast(`Something went wrong — a crash report was saved${platform.desktop ? ' (Help ▸ Open Crash Reports Folder)' : ` to ${where}`}.`, true);
  }

  async openCrashFolder(name = '') {
    if (!(await platform.openCrashFolder(name))) this.toast('Crash reports are written by the desktop app (RazorCAD.exe) to %APPDATA%\\RazorCAD\\crashes');
  }

  // ------------------------------------------------------------ document
  // (before: the background rebuild of a stored model waits for it, e.g. the feature states being restored)
  async setDoc(doc, { fit = true, cached = null, before = null } = {}) {
    breadcrumb(`Part loaded: ${doc.name} (${doc.features.length} features)`);
    if (this.mode === 'sketch') this.sketcher.exit();
    this.mode = 'part';
    this.pm = null;
    this.doc = doc;
    this.selection = null;
    this.dirty = false;
    this.viewport.setSection(null);
    for (const f of doc.features) if (f.type === 'sketch' && !f.rev) f.rev = M.newRev();
    this.history = new M.History(); // each part (tab) has its own undo history
    this.history.reset(doc);
    this.ui.renderPM();
    this.ui.refreshCommandStates();
    this.updateTitle();
    this._model = null;
    if (cached) {
      // the model as last built (unchanged since): shown now, rebuilt in the background
      this.applyResult(cached);
      this._model = { doc, r: cached };
      if (before) before.then(() => { if (this.doc === doc) this.rebuild(); }); else this.rebuild();
    } else await this.rebuild();
    if (fit) {
      this.viewport.setStandardView('trimetric', false);
      this.viewport.zoomToFit(null, false);
    }
  }

  // ---- the model as last built, kept for opening and switching tabs at once
  // (the key: a hash of the part as in its file; the model is stored once the part is unchanged since)
  docKey(doc) { const { section: _s, ...d } = doc; return hashText(M.docJSON(d, null, 0)); } // (the section view is no part of the model)
  async readModelCache(doc) {
    try {
      const key = await this.docKey(doc);
      const b64 = key && await platform.readModelCache(key);
      const r = b64 ? await unpackResult(b64) : null;
      return r && r.body?.vertices ? { key, r } : { key, r: null };
    } catch { return { key: null, r: null }; }
  }
  keepModel(r) {
    if (!r || r.preview || this.previewId() || this.mode !== 'part') return;
    const full = { ...r, body: this.result?.body || null, preview: null };
    this._model = { doc: this.doc, r: full };
    // on disk, for opening it again: parts that take a while to build (all their features, including those
    // the kernel reused from its cache this time), unchanged since their file
    const cost = Math.max(r.time || 0, (r.timing?.features || []).reduce((t, x) => t + (x[1] || 0), 0));
    if (!platform.modelStore || !(this.filePath || !platform.desktop) || this.dirty || !this._fileKey || !full.body?.vertices || cost < 800) return;
    const key = this._fileKey;
    if (this._cachedKey !== key) {
      this._cachedKey = key;
      setTimeout(async () => {
        try { await platform.writeModelCache(key, await packResult(full)); } catch { this._cachedKey = null; }
      }, 300);
    }
    // and the state after each feature (the kernel's rebuild cache), so the first change after opening is
    // as quick as later ones
    if (this._statesKey !== key) { this._statesKey = key; setTimeout(() => this.keepKernelStates(key), 600); }
  }
  async statesKey(key) { return hashText(key + ':kernel-states'); }
  async keepKernelStates(key) {
    try {
      const snaps = await this.kernel.request('exportSnaps', { ids: this.doc.features.map((f) => f.id) });
      if (snaps?.error) breadcrumb(`Feature states not kept: ${snaps.error}`);
      if (!snaps?.brep || snaps.brep.length > 300e6 || this._fileKey !== key) return;
      await platform.writeModelCache(await this.statesKey(key), await packResult(snaps));
    } catch { this._statesKey = null; }
  }
  async readKernelStates(key) {
    try {
      const b64 = key && await platform.readModelCache(await this.statesKey(key));
      return b64 ? await unpackResult(b64) : null;
    } catch { return null; }
  }

  commit() {
    rememberPart(this);
    const prev = this.history.stack[this.history.idx];
    this.history.push(this.doc);
    this.macros?.sync(prev);
    this.dirty = true;
    this.updateTitle();
    this.autosave();
  }

  // Auto-save: only once the part has been saved (it has a file), written next to that file
  // (Name.autosave.rcad) at most every AUTOSAVE_MS while there are unsaved changes.
  autosave() {
    if (!this.filePath || !this.dirty || !platform.desktop || this._autosaveTimer) return;
    this._autosaveTimer = setTimeout(async () => {
      this._autosaveTimer = null;
      if (!this.filePath || !this.dirty) return;
      try {
        await platform.saveAutosave(JSON.stringify(this.doc, null, 2), this.filePath);
        this.lastAutosave = new Date();
        this.updateTitle();
      } catch (err) {
        this.status('Auto-save failed: ' + (err?.message || err));
      }
    }, AUTOSAVE_MS);
  }

  flushAutosave() {
    if (!this._autosaveTimer) return;
    clearTimeout(this._autosaveTimer);
    this._autosaveTimer = null;
    if (this.filePath && this.dirty) platform.saveAutosave(JSON.stringify(this.doc, null, 2), this.filePath).catch?.(() => {});
  }

  cancelAutosave() {
    clearTimeout(this._autosaveTimer);
    this._autosaveTimer = null;
    this.lastAutosave = null;
  }

  // The length unit of the document in front ('mm' or 'in', units.js): a part's or assembly's doc.units, a
  // drawing's settings.units.
  get units() {
    if (this.mode === 'drawing') {
      const d = this.drawing?.doc;
      return d?.settings ? (d.settings.units === 'in' ? 'in' : 'mm') : unitOf(d);
    }
    return unitOf(this.doc);
  }
  setUnits(u) {
    u = u === 'in' ? 'in' : 'mm';
    if (u === this.units) return;
    if (this.mode === 'drawing') {
      const ed = this.drawing;
      if (!ed) return;
      if (ed.doc.settings) {
        ed.doc.settings.units = u;
        // (inch drawings: three decimals, as usual)
        if (u === 'in' && (ed.doc.settings.decimals ?? 2) === 2) ed.doc.settings.decimals = 3;
        if (u === 'mm' && ed.doc.settings.decimals === 3) ed.doc.settings.decimals = 2;
        ed.changed();
      } else {
        ed.begin?.();
        if (u === 'in') ed.doc.units = 'in'; else delete ed.doc.units;
        ed.change?.();
      }
    } else {
      if (u === 'in') this.doc.units = 'in'; else delete this.doc.units;
      this.commit();
      this.ui.renderPM();
      if (this.mode === 'sketch') this.sketcher.redraw?.();
    }
    this.updateUnitsStatus();
    this.status(`Units: ${u === 'in' ? 'inches' : 'millimetres'}. Sizes are kept exactly; only how they are shown and typed changes.`);
  }
  updateUnitsStatus() {
    const s = $('#status-units');
    if (!s) return;
    const u = this.units;
    s.textContent = UNIT_SYSTEM[u];
    s.title = `Units: ${u === 'in' ? 'inches' : 'millimetres'} — click to change`;
    s.style.cursor = 'pointer';
    s.onclick = (e) => this.ui.showContext(e.clientX, e.clientY - 60, [
      { label: (u === 'mm' ? '● ' : '　') + 'Millimetres (mm)', icon: '', action: () => this.setUnits('mm') },
      { label: (u === 'in' ? '● ' : '　') + 'Inches (in)', icon: '', action: () => this.setUnits('in') },
    ]);
  }

  // The up axis of the part or assembly shown (its doc.upAxis; drawings: the one for new parts) applied: the triad,
  // the 3D sketch's names and the status bar.
  applyUpAxis() {
    const asm = this.mode === 'drawing' && this.drawing?.doc?.kind === 'assembly' ? this.drawing : null;
    const u = this.mode === 'part' || this.mode === 'sketch' || this.mode === 'sketch3d' ? this.doc?.upAxis : asm ? asm.doc.upAxis : this.ui.prefs?.upAxis;
    const was = W.getUp();
    W.setUp(u);
    if (W.getUp() !== was) { this.viewport.setUpAxis(); relabelAxes3D(); }
    const s = $('#status-up');
    if (!s) return;
    const z = W.getUp() === 'z';
    s.textContent = z ? 'Z up' : 'Y up';
    s.title = `World axes: ${z ? 'Z' : 'Y'} up (Top plane ${W.stdPlaneAxes('top')}, Front ${W.stdPlaneAxes('front')}, Right ${W.stdPlaneAxes('right')}) — click to change`;
    s.style.cursor = 'pointer';
    s.onclick = (e) => this.ui.showContext(e.clientX, e.clientY - 60, [
      { label: (!z ? '● ' : '　') + 'Y up (Top plane XZ, Front XY)', icon: '', action: () => this.setUpAxis('y') },
      { label: (z ? '● ' : '　') + 'Z up (Top plane XY, Front XZ)', icon: '', action: () => this.setUpAxis('z') },
    ]);
  }
  // The part's up axis: the world axes renamed (with Z up the Top plane is XY, the Front plane XZ, the Right plane
  // YZ); the model stays where it is. Also the up axis for new parts.
  setUpAxis(u) {
    u = u === 'z' ? 'z' : 'y';
    if (this.ui.prefs) { if (u === 'z') this.ui.prefs.upAxis = 'z'; else delete this.ui.prefs.upAxis; this.ui.savePrefs(); }
    if (this.mode === 'part' || this.mode === 'sketch' || this.mode === 'sketch3d') {
      if ((this.doc.upAxis === 'z' ? 'z' : 'y') !== u) {
        if (u === 'z') this.doc.upAxis = 'z'; else delete this.doc.upAxis;
        this.commit();
      }
    }
    // (an assembly keeps its own, as a part does: an undoable change)
    const asm = this.mode === 'drawing' && this.drawing?.doc?.kind === 'assembly' ? this.drawing : null;
    if (asm && (asm.doc.upAxis === 'z' ? 'z' : 'y') !== u) {
      asm.begin();
      if (u === 'z') asm.doc.upAxis = 'z'; else delete asm.doc.upAxis;
      asm.change();
    }
    this.applyUpAxis();
    if (asm) asm.renderAll?.();
    else { this.ui.renderPM(); this.ui.renderTree(); this.updateEdgeHighlights(); }
    this.status(`World axes: ${u.toUpperCase()} up. The Top plane is ${W.stdPlaneAxes('top')}, the Front plane ${W.stdPlaneAxes('front')} and the Right plane ${W.stdPlaneAxes('right')}; the model stays where it is (only the axes' names change). New parts start ${u.toUpperCase()} up.`);
  }

  updateTitle() {
    this.updateUnitsStatus();
    this.applyUpAxis();
    if (this.mode === 'drawing' && this.drawing) {
      const d = this.drawing;
      const file = d.filePath ? d.filePath.split(/[\\/]/).pop() : null;
      const t = `${d.name}${d.dirty ? ' *' : ''}`;
      platform.setTitle(`${t} — RazorCAD`);
      platform.setDirty(this.anyDirty(), !!d.filePath);
      $('#doc-title').title = file ? d.filePath : 'Not saved yet';
      this.ui.renderTabs?.();
      return;
    }
    if (!this.doc) return;
    const file = this.filePath ? this.filePath.split(/[\\/]/).pop() : null;
    const t = `${this.filePath ? M.fileStem(this.filePath) : this.doc.name}${this.dirty ? ' *' : ''}`;
    const auto = this.dirty && this.lastAutosave ? `  (auto-saved ${this.lastAutosave.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : '';
    $('#doc-title').textContent = file ? `${t}  —  ${file}${auto}` : t;
    $('#doc-title').title = file ? this.filePath : 'Not saved yet — auto-save starts once the part is saved';
    platform.setTitle(`${t} — RazorCAD`);
    platform.setDirty(this.anyDirty(), !!this.filePath);
    this.ui.renderTabs?.();
  }

  // While a feature's Property panel is open the kernel rolls the model back to just
  // before it and returns the feature's effect as a coloured preview.
  previewId() {
    return this.pm?.kind === 'feature' ? this.pm.feature.id : null;
  }

  // Fonts used by sketch text, sent to the kernel once.
  async ensureFonts(kernel = this.kernel) {
    const need = new Map();
    for (const f of this.doc?.features || []) for (const t of f.texts || []) need.set(fontKey(t), t);
    for (const [key, t] of need) {
      // (fonts are shared by the kernels: one loaded already is sent to this kernel if it hasn't it yet)
      if (kernel.fonts.has(key)) { await kernel.sendFont(key, kernel.fonts.get(key)); continue; }
      // (a font this PC doesn't have: the bundled one most like it)
      const data = await platform.fontData(fontFile(t.font, t.bold, t.italic)) || await platform.fontData(fontFile(fallbackFamily(t.font), t.bold, t.italic));
      if (data) await kernel.loadFont(key, data);
    }
  }

  // Font families this PC has (for the text tool).
  async fontFamilies() {
    if (!this._fontFamilies) {
      const files = Object.entries(FONTS).filter(([k]) => !BUNDLED_FAMILIES.includes(k)).map(([, x]) => x[0]);
      const have = new Set(await platform.fontsAvailable(files).catch(() => []));
      this._fontFamilies = [...Object.keys(FONTS).filter((k) => !BUNDLED_FAMILIES.includes(k) && have.has(FONTS[k][0])), ...BUNDLED_FAMILIES];
    }
    return this._fontFamilies;
  }

  async rebuild() {
    const doc = this.doc, kernel = this.kernel;
    // (the kernel this rebuild goes to, throughout: another tab may come to the front meanwhile, with its own)
    kernel.expect(true);
    try { await this.ensureFonts(kernel).catch(() => {}); } finally { kernel.expect(false); }
    $('#status-rebuild').textContent = 'Rebuilding…';
    $('#status-rebuild').style.color = '';
    let r;
    // a slow feature still being built that this change makes pointless (it was deleted, or something
    // before it changed, or another part was opened): stop it now instead of queueing behind it
    if (kernel.busy && performance.now() - kernel.runningSince > 1500 && this.runningWorkIsStale()) {
      breadcrumb('Stopped a stale rebuild');
      this.endLongRun();
      await kernel.cancel();
      this._forceMesh = true;
    }
    this.watchLongRun();
    try {
      r = await kernel.rebuild(this.doc, this.previewId(), this._forceMesh ? null : this.result?.body?.key || null);
      this._forceMesh = false;
    } catch (err) {
      if (err.cancelled) return; // (stopped: the rebuild that follows shows the model)
      $('#status-rebuild').textContent = 'Kernel error';
      this.hideProgress();
      this.toast('Geometry kernel error: ' + err.message, true);
      reportError('kernel-error', err, this);
      return;
    }
    if (kernel.pending) return; // a newer rebuild is already queued
    if (this.mode === 'drawing') return; // (a drawing or assembly tab came to the front meanwhile)
    if (this.doc !== doc) return; // (another part came to the front meanwhile)
    if (r.time > 1000 || r.errors.length) breadcrumb(`Rebuild ${Math.round(r.time)} ms` + (r.errors.length ? `, feature errors: ${r.errors.map(([id, m]) => `${M.findFeature(this.doc, id)?.name || id}: ${m}`).join(' | ').slice(0, 400)}` : ''));
    this.applyResult(r);
    this.keepModel(r);
    // (the first full model after opening a part: how long it took, and what the stored states saved)
    if (this._firstBuild?.doc === doc) {
      const fb = this._firstBuild;
      this._firstBuild = null;
      breadcrumb(`Model ready ${Math.round(performance.now() - fb.t0)} ms after opening (rebuild ${Math.round(r.time)} ms, meshing ${r.timing?.mesh ?? 0} ms, ${r.timing?.reused ?? 0} of ${doc.features.length} features from the stored states)`);
    }
    if (!this._progressHold) this.hideProgress();
  }

  // ------------------------------------------------------------ Ask Claude
  // Claude answers with features to add (claudespec.js). They are added and rebuilt; when they
  // don't build, the part is put back and Claude is told what went wrong (up to two more tries).
  // A good answer is one undo step. Returns false when the request wasn't sent.
  async askClaude(text) {
    const ui = this.ui;
    if (this.claudeBusy) return false;
    if (this.mode === 'sketch' || this.pm) {
      ui.claudeLog('error', 'Close the open sketch or feature first, then send again.');
      return false;
    }
    const st = await platform.claudeStatus();
    if (!st.ready) { ui.showClaudeSettings(); return false; }
    const model = CLAUDE_MODELS.some(([id]) => id === st.model) ? st.model : CLAUDE_MODELS[0][0];
    ui.claudeLog('you', text);
    const chat = this.claudeChat || (this.claudeChat = []);
    const context = describePart(this.doc, this.result, (id) => this.viewport.bodyBox(id));
    const msgs = [...chat, { role: 'user', content: `${text}\n\n<current_part>\n${context.slice(0, 12000)}\n</current_part>` }];
    this.claudeBusy = true;
    $('#claude-panel').classList.add('busy');
    const wait = ui.claudeLog('busy', 'Claude is working on it…');
    breadcrumb(`Ask Claude (${model}): ${text.slice(0, 200)}`);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await platform.claudeMessages({ model, max_tokens: 16000, system: RAZORCAD_GUIDE, messages: msgs });
        const reply = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        msgs.push({ role: 'assistant', content: reply || '(no answer)' });
        const { message, plan, error } = parseReply(reply);
        if (message) ui.claudeLog('claude', message);
        const problem = error || (plan ? await this.applyClaudePlan(plan) : null);
        if (!problem) break;
        if (attempt === 2) { ui.claudeLog('error', `It still doesn't build (${problem}); the part was left as it was. Try rephrasing or splitting the request.`); break; }
        ui.claudeLog('note', `That didn't build (${problem}). Asking Claude to correct it…`);
        msgs.push({ role: 'user', content: `Your features could not be built: ${problem}\nThe part is unchanged. Answer with the corrected json block (the complete list of features to add).` });
      }
    } catch (err) {
      ui.claudeLog('error', err?.message || String(err));
    } finally {
      wait.remove();
      this.claudeBusy = false;
      $('#claude-panel').classList.remove('busy');
    }
    // keep the conversation (without the old part descriptions) for follow-up requests
    const keep = msgs.map((x) => ({ role: x.role, content: x.role === 'user' ? x.content.replace(/\n\n<current_part>[\s\S]*?<\/current_part>/, '') : x.content })).slice(-16);
    while (keep.length && keep[0].role !== 'user') keep.shift();
    chat.splice(0, chat.length, ...keep);
    return true;
  }

  // Add Claude's features and rebuild. Returns null when they built, else what went wrong (the part is restored).
  async applyClaudePlan(plan) {
    const before = JSON.stringify(this.doc);
    const restore = async () => {
      const old = JSON.parse(before);
      for (const k of Object.keys(this.doc)) delete this.doc[k];
      Object.assign(this.doc, old);
      await this.rebuild();
    };
    const hadBodies = (this.result?.bodies || []).length;
    let added;
    try { added = applyPlan(this.doc, plan); } catch (err) { await restore(); return err.message; }
    if (!added.length) return null;
    await this.rebuild();
    const errs = added.map((id, i) => [plan.features[i], this.result.errors.get(id)]).filter(([, m]) => m);
    if (!errs.length && !(this.result.bodies || []).length && added.some((id) => M.findFeature(this.doc, id)?.type !== 'sketch' && M.findFeature(this.doc, id)?.type !== 'plane')) errs.push([{ id: 'part' }, 'no solid body was made']);
    if (errs.length) {
      await restore();
      return errs.map(([f, m]) => `${f.id || f.type}${f.type ? ` (${f.type})` : ''}: ${m}`).join('; ');
    }
    this.commit();
    this.ui.renderTree();
    const names = added.map((id) => M.findFeature(this.doc, id)?.name).filter(Boolean);
    this.ui.claudeLog('note', `${plan.replace ? 'Part rebuilt from' : 'Added'} ${names.length} feature${names.length === 1 ? '' : 's'}: ${names.join(', ')}. (Ctrl+Z undoes it.)`);
    if (plan.replace || !hadBodies) this.viewport.zoomToFit();
    return null;
  }

  // Progress bar in the status bar (bottom left). value: 0..1, or null when it can't be
  // measured. It only appears when an operation takes longer than `delay` ms.
  showProgress(value, label, delay = 250) {
    this._prog = { value, label };
    const render = () => {
      const el = $('#progress');
      el.hidden = false;
      el.classList.toggle('indet', value == null && this._prog.value == null);
      el.querySelector('.pg-label').textContent = this._prog.label || 'Working…';
      el.querySelector('.pg-fill').style.width = this._prog.value == null ? '' : Math.round(Math.max(0, Math.min(1, this._prog.value)) * 100) + '%';
    };
    if (this._progShown) return render();
    if (!this._progTimer) this._progTimer = setTimeout(() => { this._progTimer = null; this._progShown = true; render(); }, delay);
  }

  hideProgress() {
    clearTimeout(this._progTimer);
    this._progTimer = null;
    this._progShown = false;
    $('#progress').hidden = true;
  }

  // ---- long operations: after a few seconds a banner (and the progress bar) offer to stop it. Stopping
  // replaces the kernel; the feature that was being built is suppressed (or its Property panel closed), so
  // the model comes back without it.
  watchLongRun() {
    if (this._longTimer) return;
    this._longStart = performance.now();
    this._longTimer = setInterval(() => {
      if (!this.kernel.pending) { this.endLongRun(); return; }
      if (performance.now() - this._longStart < 4000) return;
      const f = this._progFeature && M.findFeature(this.doc, this._progFeature);
      const what = f ? f.name : 'the model';
      let b = document.getElementById('busy-banner');
      if (!b) {
        b = document.createElement('div');
        b.id = 'busy-banner';
        b.innerHTML = '<span class="bb-text"></span><button>Stop</button>';
        b.querySelector('button').onclick = () => this.stopKernel();
        ($('#viewport') || document.body).appendChild(b);
      }
      b.querySelector('.bb-text').textContent = `Still working on ${what} (${Math.round((performance.now() - this._longStart) / 1000)} s)… Your changes wait until it is done.`;
      const st = $('#progress .pg-stop');
      if (st) { st.hidden = false; st.onclick = () => this.stopKernel(); }
      $('#progress').hidden = false;
    }, 500);
  }
  // the feature the kernel is busy with (or one before it) is no longer what this part has
  runningWorkIsStale() {
    const k = this.kernel, fid = this._progFeature;
    if (!k.runningDoc || !fid) return false;
    if (this._staleParsedFor !== k.runningDoc) {
      try { this._staleParsed = JSON.parse(k.runningDoc); } catch { return false; }
      this._staleParsedFor = k.runningDoc;
    }
    const old = this._staleParsed.features || [], cur = this.doc.features;
    const i = old.findIndex((f) => f.id === fid);
    if (i < 0) return false;
    // (features as the kernel was sent them: a big import's text named by its hash)
    for (let j = 0; j <= i; j++) if (!cur[j] || cur[j].id !== old[j].id || JSON.stringify(packFeature(cur[j])) !== JSON.stringify(old[j])) return true;
    return false;
  }
  endLongRun() {
    this._staleParsed = this._staleParsedFor = null;
    clearInterval(this._longTimer);
    this._longTimer = null;
    document.getElementById('busy-banner')?.remove();
    const st = $('#progress .pg-stop');
    if (st) st.hidden = true;
  }
  async stopKernel() {
    const fid = this._progFeature, f = fid ? M.findFeature(this.doc, fid) : null;
    this.endLongRun();
    breadcrumb(`Stop: ${f?.name || 'kernel'}`);
    await this.kernel.cancel();
    this.hideProgress();
    this._forceMesh = true;
    if (this.pm?.kind === 'feature' && (!f || this.pm.feature.id === fid)) {
      this.cancelPM();
      this.toast(`Stopped: ${f ? f.name : 'the preview'} was taking too long, so it was cancelled.`);
    } else if (f && !f.suppressed && f.type !== 'sketch') {
      f.suppressed = true;
      this.commit();
      this.toast(`Stopped: ${f.name} was taking too long and is now suppressed (unsuppress it to try again).`);
    } else this.toast('Stopped.');
    this.rebuild();
  }

  // Run an async task with an (indeterminate) progress bar; rebuilds inside it keep it updated.
  async withProgress(label, fn) {
    this._progressHold = (this._progressHold || 0) + 1;
    this.showProgress(null, label);
    try { return await fn(); } finally {
      this._progressHold--;
      if (!this._progressHold) this.hideProgress();
    }
  }

  applyResult(r) {
    const doc = this.doc;
    if (this.flatView) this.exitFlatten(); // the model changed: back to the model view
    for (const [fid, s] of Object.entries(r.sketches)) {
      const f = M.findFeature(doc, fid);
      if (!f || f.type !== 'sketch' || f.rev !== s.rev) continue;
      if (this.mode === 'sketch' && this.sketcher.f === f) continue;
      Object.assign(f, s.data);
      delete f.entities;
    }
    for (const [fid, u] of Object.entries(r.features)) {
      const f = M.findFeature(doc, fid);
      if (f && this.pm?.feature !== f) Object.assign(f, u);
    }
    if (r.body?.same) {
      // the kernel says the view already shows this mesh
      if (this.result?.body?.key !== r.body.key) { this._forceMesh = true; this.rebuild(); return; }
      r.body = this.result.body;
    }
    const { vars, errors: eqErrors } = evalEquations(doc.equations || []);
    const sketches = new Map(), planes = new Map();
    for (const [fid, s] of Object.entries(r.sketches)) {
      const f = M.findFeature(doc, fid);
      if (f) sketches.set(fid, { frame: G.frameFromJSON(s.frame), sketch: f, textPolys: s.textPolys || null });
    }
    for (const [fid, fr] of Object.entries(r.planes)) planes.set(fid, G.frameFromJSON(fr));
    const info = r.info || {}; // (what features report for their Property panel, e.g. a fillet's vertices)
    const axes = new Map(Object.entries(r.axes || {}).map(([k, a]) => [k, { o: new THREE.Vector3(...a.o), d: new THREE.Vector3(...a.d) }]));
    const points = new Map(Object.entries(r.points || {}).map(([k, p]) => [k, new THREE.Vector3(...p)]));
    this.result = {
      info,
      vars, ev: (x) => evaluate(x, vars), eqErrors, errors: new Map(r.errors), missing: new Map(Object.entries(r.missing || {})), sketches, planes, axes, points,
      consumed: new Set(doc.features.filter((f) => f.type !== 'sketch').flatMap((f) => M.sketchesUsedBy(f))), body: r.body, time: r.time,
      preview: r.preview, previewOf: this.previewId(),
    };
    this.result.bodies = this.bodyList(r.body);
    this.result.curves = new Map(Object.entries(r.curves || {}));
    this.result.notes = new Map(Object.entries(r.notes || {}));
    this.result.threads = new Map(Object.entries(r.threads || {})); // cosmetic threads (and tapped holes' threads)
    this.result.detected = new Map(Object.entries(r.detected || {})); // what features found in the model (e.g. a converted sheet's thickness)
    this.clearCycle(); // the mesh (and its face/body indices) changed
    this._featureFaceCache = new Map();
    if (this.isolated && ![...this.isolated].some((id) => this.bodyById(id))) this.isolated = null;
    this.pushBody();
    this.viewport.setPreview(this.pm?.kind === 'feature' ? r.preview : null);
    this.updateRefGeometry();
    this.hoverFaceKey = null;
    this.hoverEdge = this.hoverVertex = null;
    const selKind = this.selection?.kind;
    if (selKind === 'face' || selKind === 'edge' || selKind === 'vertex') this.selection = null;
    if (selKind === 'body' && !this.bodyById(this.selection.id)) this.selection = null;
    this.updateSelectionHighlight();
    if (this._hoverFeature) this.highlightFeature(this._hoverFeature, 'featureHover');
    this.updateSketchDisplay();
    this.updatePlanes();
    this.ui.renderTree();
    const n = this.result.errors.size;
    $('#status-rebuild').textContent = `Rebuild ${this.result.time.toFixed(0)} ms` + (n ? ` · ${n} error${n > 1 ? 's' : ''}` : '');
    $('#status-rebuild').style.color = n ? '#c62828' : '';
    // (the error count opens Fix References)
    $('#status-rebuild').style.cursor = n ? 'pointer' : '';
    $('#status-rebuild').title = n ? 'Click to see and fix the features with errors' : '';
    $('#status-rebuild').onclick = n ? () => this.ui.showFixReferences() : null;
    this.ui.refreshFixReferences?.();
    if (this.viewport.section) this.applySection();
    this.updateEdgeHighlights();
    this.ui.updatePMStatus();
    this.autosave();
  }

  // Solid bodies of the rebuilt part, with display names and the material that applies.
  bodyList(mesh) {
    const list = (mesh?.bodies || []).map((b, index) => {
      const own = M.bodySettings(this.doc, b.id);
      return {
        ...b, index, own, ownMaterial: !!own?.material,
        material: M.materialById(M.bodyMaterialId(this.doc, b.id)),
        // (weldment members are called after their profile)
        defaultName: b.member ? b.member.label : M.findFeature(this.doc, b.last)?.name || 'Body',
      };
    });
    // shape signature of each solid (identical bodies are listed once with a count)
    // (kept by the body's mesh key: a body meshed the same as before has the same triangles)
    if (mesh?.vertices && mesh?.triangles) {
      const was = this._bodySigs || new Map(), now = new Map();
      for (const b of list) {
        if (b.kind === 'surface') continue;
        if (b.meshKey && was.has(b.meshKey)) b.sig = was.get(b.meshKey);
        else { try { b.sig = bodySignature(mesh.vertices, mesh.triangles, b.triStart, b.triCount); } catch { b.sig = null; } }
        if (b.meshKey) now.set(b.meshKey, b.sig);
      }
      this._bodySigs = now;
    }
    // unnamed bodies are called after the last feature that changed them
    const seen = {};
    for (const b of list) {
      if (b.own?.name) { b.name = b.own.name; continue; }
      const n = (seen[b.defaultName] = (seen[b.defaultName] || 0) + 1);
      b.name = n > 1 ? `${b.defaultName}[${n}]` : b.defaultName;
    }
    return list;
  }

  bodyById(id) { return this.result?.bodies?.find((b) => b.id === id) || null; }

  // The bodies identical to b (b included), and how many there are.
  identicalBodies(b) { return b ? (this.result?.bodies || []).filter((x) => x === b || sameBody(b, x)) : []; }
  bodyCount(b) { return Math.max(1, this.identicalBodies(b).length); }

  // Show the result's mesh; skipped when the same mesh is already shown with the same colours
  // and hidden bodies (re-uploading it and rebuilding its picking structure takes time).
  pushBody(force = false) {
    const colors = this.bodyColors(), hidden = this.hiddenBodyIndices(), glass = this.transparentBodyIndices();
    const faces = JSON.stringify(this.doc.appearance?.faces || []);
    // an exploded view shown: the bodies moved apart (the display only)
    const offs = this.bodyOffsets();
    const exKey = offs.size ? JSON.stringify([...offs]) : '';
    const sig = `${this.result.body?.key}|${colors.join(',')}|${[...hidden].join(',')}|${[...glass].join(',')}|${faces}|${exKey}`;
    if (!force && sig === this._bodySig && (this.viewport.mesh === this.result.body || exKey)) return;
    this._bodySig = sig;
    const byIndex = new Map();
    (this.result.bodies || []).forEach((b, i) => { const o = offs.get(b.id); if (o) byIndex.set(i, o); });
    this.viewport.setBody(byIndex.size ? offsetMesh(this.result.body, byIndex) : this.result.body, colors, hidden, glass);
    this._exLines = drawExplodeLines(this.viewport, this._exLines, this.explodeShowLines === false ? [] : [...offs].filter(([, o]) => Math.hypot(...o) > 1e-9).map(([id, o]) => { const c = this.bodyCenter(id); return c ? [c, c.map((x, i) => x + o[i])] : null; }).filter(Boolean));
    // face appearances: those an import gave, then the part's own (each stored face found again by its point)
    const pairs = [];
    (this.result.body?.faceGroups || []).forEach((g, gi) => { if (g.look?.c != null) pairs.push([gi, g.look.c]); });
    for (const a of this.doc.appearance?.faces || []) { const fi = this.viewport.faceIndexNear(a.p); if (fi >= 0) pairs.push([fi, a.color]); }
    this.viewport.setFaceColors(pairs);
  }

  // ------------------------------------------------------------ exploded views of multi-body parts
  // (the centre of a body where it is modelled, not where an exploded view shows it)
  bodyCenter(id) {
    const m = this.result?.body, b = m?.bodies?.find((x) => x.id === id);
    if (!b) return null;
    const V = m.vertices, T = m.triangles, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < b.triCount; k++) { const vi = T[b.triStart + k] * 3; for (let j = 0; j < 3; j++) { const x = V[vi + j]; if (x < lo[j]) lo[j] = x; if (x > hi[j]) hi[j] = x; } }
    return isFinite(lo[0]) ? lo.map((x, j) => (x + hi[j]) / 2) : null;
  }
  bodyOffsets() {
    if (this.mode !== 'part' && this.mode !== 'sketch' && this.mode !== 'sketch3d') return new Map();
    if (this.explodeTool?.ex) return this.explodeTool.offsets();
    const ex = this.doc?.exploded && (this.doc.explodes || []).find((x) => x.id === this.doc.exploded);
    return ex ? explodeOffsets(ex, null, this._explodeT ?? 1) : new Map();
  }
  explodeHost() {
    const a = this;
    return this._explodeHost ||= {
      app: a, get vp() { return a.viewport; }, get doc() { return a.doc; },
      items: () => (a.result?.bodies || []).filter((b) => b.kind !== 'surface').map((b) => ({ id: b.id, name: b.name })),
      itemAt: (e) => { const fh = a.faceAt(e); return fh ? a.result.bodies[a.viewport.faceBody[fh.hit.face]]?.id || null : null; },
      faceNormalAt: (e) => { const fh = a.faceAt(e); const fi = fh && a.viewport.faceInfo(fh.hit.face); return fi?.planar ? fi.normal.toArray() : null; },
      itemCenter: (id) => a.bodyCenter(id) || [0, 0, 0],
      itemSize: (id) => { const box = a.viewport.bodyBox(id); return box ? Math.max(...box.max.map((x, i) => x - box.min[i])) * 1.2 : 50; },
      redisplay: () => a.pushBody(true),
      commit: (msg) => { a.commit(); a.ui.renderTree(); if (msg) a.status(msg); },
      pmRoot: () => document.getElementById('pm'),
      onToolClosed: () => { a.explodeTool = null; a.pm = null; a.ui.renderPM(); a.ui.renderTree(); a.ui.refreshCommandStates(); },
    };
  }
  startExplode(id = null) {
    if (this.mode !== 'part') { this.toast('Close the sketch first', true); return; }
    const solids = (this.result?.bodies || []).filter((b) => b.kind !== 'surface');
    if (solids.length < 2) { this.toast('An exploded view needs a part with two or more bodies', true); return; }
    if (this.pm) this.cancelPM();
    // (the bodies' places when collapsed, for the explode lines)
    this.doc.exploded = null; this._explodeT = 1; this.pushBody(true);
    this.explodeTool = new ExplodeTool(this.explodeHost());
    this.pm = { kind: 'explode' };
    this.explodeTool.open(id);
    this.ui.refreshCommandStates();
  }
  setExploded(id, animate = false) {
    const was = this.doc.exploded;
    if (!animate) { this.doc.exploded = id || null; this._explodeT = 1; this.pushBody(true); this.ui.renderTree(); return; }
    const target = id || was;
    if (!target) return;
    this.doc.exploded = target;
    animateExplode((t) => { this._explodeT = t; this.pushBody(true); }, id ? 0 : 1, id ? 1 : 0, () => { this._explodeT = 1; this.doc.exploded = id || null; this.pushBody(true); this.ui.renderTree(); });
  }
  collapseExplode() { if (this.doc?.exploded) { this.doc.exploded = null; this.pushBody(true); this.status('Collapsed (the exploded view is kept: right-click it to explode again).'); } }
  deleteExplode(id) {
    this.doc.explodes = (this.doc.explodes || []).filter((x) => x.id !== id);
    if (this.doc.exploded === id) this.doc.exploded = null;
    this.commit(); this.pushBody(true); this.ui.renderTree();
  }

  // A body's colour: its appearance, else the one it was imported with, else its material's (surfaces: the surface colour).
  bodyColors() {
    return (this.result?.bodies || []).map((b) => this.doc.bodies?.[b.id]?.color || (b.color ?? (b.kind === 'surface' ? M.SURFACE_COLOR : b.material?.color ?? M.DEFAULT_BODY_COLOR)));
  }

  // ---- appearances: a colour on a face or a whole body (null colour: back to the default)
  setAppearance(target, color) {
    this.doc.appearance ||= { faces: [] };
    if (target.kind === 'face') {
      const fi = this.viewport.faceIndexNear(target.p);
      this.doc.appearance.faces = this.doc.appearance.faces.filter((a) => this.viewport.faceIndexNear(a.p) !== fi);
      if (color) this.doc.appearance.faces.push({ p: target.p, color });
    } else {
      const s = M.ensureBodySettings(this.doc, target.id);
      if (color) s.color = color; else delete s.color;
    }
    this.commit();
    this.pushBody(true);
  }

  // ---- surface analysis on the model (zebra stripes, curvature, draft)
  setAnalysis(a) {
    const same = a && this.analysis?.kind === a.kind && !a.force;
    this.analysis = same ? null : a || null;
    this.viewport.setAnalysis(this.analysis);
    this.ui.renderCommandManager();
    const k = this.analysis?.kind;
    if (k === 'curvature') this.status(`Curvature: blue flat → green → yellow → red tightest (red: radius ${fmt(1 / this.viewport.curvatureMax, 2)} mm or less). Click Curvature again to turn it off.`);
    else if (k === 'draft') this.status(`Draft analysis: green ≥ ${this.analysis.angle}° draft toward the pull direction, red ≥ ${this.analysis.angle}° away from it, yellow needs draft. Click Draft Analysis again to turn it off.`);
    else if (k === 'thickness') { const t = this.viewport.thicknessStats; this.status(`Thickness: red under ${fmt(this.analysis.min, 3)} mm, blue over ${fmt(this.analysis.max, 3)} mm, green to yellow between. Walls ${t && Number.isFinite(t.min) ? `${fmt(t.min, 3)} to ${fmt(t.max, 3)} mm` : 'not found'}${t ? `; ${Math.round(t.thin * 100)} % too thin, ${Math.round(t.thick * 100)} % too thick` : ''}. Click again to turn it off.`); }
    else if (k === 'undercut') this.status(`Undercut check: green free along the pull direction, blue free against it, red undercut (${Math.round((this.viewport.undercutShare || 0) * 100)} % of the surface): the mould cannot release it either way. Click again to turn it off.`);
    else if (k === 'zebra') this.status('Zebra stripes: smooth (tangent / curvature-continuous) joins show stripes running on without a kink. Click again to turn them off.');
    else this.status('Ready');
  }

  // ---- interference: where solid bodies overlap
  async checkInterference() {
    if ((this.result?.bodies || []).filter((b) => b.kind !== 'surface').length < 2) { this.toast('Interference Check needs two or more solid bodies', true); return; }
    let r;
    try { r = await this.withProgress('Checking for interference…', () => this.kernel.request('interference', {})); } catch (e) { this.toast(e.message, true); return; }
    this.viewport.setPreview(r.mesh ? { remove: r.mesh } : null);
    const name = (id) => this.bodyById(id)?.name || id;
    const html = r.pairs.length
      ? `<p>${r.pairs.length} interference${r.pairs.length === 1 ? '' : 's'} (shown in red on the model):</p><table class="grid"><tr><th>Body</th><th>Body</th><th>Overlap volume</th></tr>${r.pairs.map((x) => `<tr><td>${name(x.a).replace(/[<>&]/g, '')}</td><td>${name(x.b).replace(/[<>&]/g, '')}</td><td class="num">${fmt(x.volume, 3)} mm³</td></tr>`).join('')}</table>`
      : '<p>No interference: none of the solid bodies overlap.</p>';
    await this.ui.choose('Interference Check', 'interference', html, [['ok', 'Close', true]]);
    this.viewport.setPreview(null);
  }

  // ---- configurations
  activeConfig() { return this.doc.activeConfig ? (this.doc.configs || []).find((c) => c.id === this.doc.activeConfig) || null : null; }
  setActiveConfig(id) {
    if (this.pm) this.cancelPM();
    this.doc.activeConfig = id || null;
    this.commit();
    this.rebuild();
    this.ui.renderTree();
    this.ui.renderConfigs?.();
    this.status(`Configuration: ${this.activeConfig()?.name || 'Default'}`);
  }
  // suppressed in the configuration shown (its own list first, then the feature's own state)
  isSuppressed(f) {
    const c = this.activeConfig();
    if (c?.suppressed?.includes(f.id)) return true;
    if (c?.unsuppressed?.includes(f.id)) return false;
    return !!f.suppressed;
  }
  addConfig(copyOf = null) {
    const d = this.doc;
    d.configs ||= [];
    let k = 1;
    while (d.configs.some((c) => c.id === 'cfg' + k)) k++;
    let n = d.configs.length + 1;
    const base = copyOf ? (d.configs.find((c) => c.id === copyOf) || null) : this.activeConfig();
    const stem = copyOf && base ? `Copy of ${base.name}` : 'Config';
    let name = copyOf && base ? stem : stem + n;
    while (d.configs.some((c) => c.name === name)) name = copyOf ? `${stem} (${++n})` : stem + ++n;
    const c = { id: 'cfg' + k, name, vals: { ...(base?.vals || {}) }, suppressed: [...(base?.suppressed || [])], unsuppressed: [...(base?.unsuppressed || [])] };
    d.configs.push(c);
    this.setActiveConfig(c.id);
    return c;
  }
  deleteConfig(id) {
    const d = this.doc;
    d.configs = (d.configs || []).filter((c) => c.id !== id);
    if (d.activeConfig === id) d.activeConfig = null;
    this.commit();
    this.rebuild();
    this.ui.renderTree();
    this.ui.renderConfigs?.();
  }

  // ------------------------------------------------------------ visibility
  isBodyHidden(id) { return !!this.doc.bodies?.[id]?.hidden; }

  // Bodies not drawn: hidden ones, surfaces when filtered out, all but the isolated ones, or — when
  // showing the hidden bodies — all the others.
  hiddenBodyIndices() {
    const out = new Set();
    (this.result?.bodies || []).forEach((b, i) => {
      let hide = this.isBodyHidden(b.id) || (b.kind === 'surface' && !this.vis.surfaces);
      if (this.isolated) hide = !this.isolated.has(b.id);
      if (this.showHiddenMode) hide = !this.isBodyHidden(b.id);
      if (hide) out.add(i);
    });
    return out;
  }

  // ------------------------------------------------------------ transparency
  // (set in the part, else as imported: a body can be made opaque even if it came in transparent)
  isBodyTransparent(id) {
    const own = this.doc.bodies?.[id]?.transparent;
    return own !== undefined ? !!own : (this.bodyById(id)?.transparency || 0) > 0;
  }

  transparentBodyIndices() {
    const out = new Set();
    (this.result?.bodies || []).forEach((b, i) => { if (this.isBodyTransparent(b.id)) out.add(i); });
    return out;
  }

  // The bodies a feature made or changed (for a sketch: those of the features that use it).
  bodiesOfFeature(f) {
    if (!f) return [];
    const ids = new Set([f.id]);
    if (f.type === 'sketch') for (const g of this.doc.features) if (M.sketchesUsedBy(g).includes(f.id)) ids.add(g.id);
    return (this.result?.bodies || []).filter((b) => b.feats?.some((k) => ids.has(k)) || ids.has(b.last)).map((b) => b.id);
  }

  setBodiesTransparent(ids, on) {
    for (const id of ids) {
      const st = M.ensureBodySettings(this.doc, id);
      if (on) st.transparent = true;
      else if ((this.bodyById(id)?.transparency || 0) > 0) st.transparent = false; // (imported transparent)
      else delete st.transparent;
    }
    this.commit();
    this.refreshBodyVisibility();
    const names = ids.map((id) => this.bodyById(id)?.name).filter(Boolean);
    this.status(`${names.length === 1 ? names[0] : `${names.length} bodies`} ${on ? 'made transparent' : 'made opaque'}.`);
  }

  // Context-menu item toggling the transparency of some bodies (opaque again when all are transparent).
  transparencyItem(ids) {
    const all = ids.length && ids.every((id) => this.isBodyTransparent(id));
    const what = ids.length > 1 ? ` (${ids.length} bodies)` : '';
    return { label: (all ? 'Make Opaque' : 'Make Transparent') + what, icon: 'transparent', action: () => this.setBodiesTransparent(ids, !all) };
  }

  refreshBodyVisibility() {
    if (!this.result) return;
    this.pushBody(true);
    this.clearCycle();
    this.hoverFaceKey = null;
    if (this.selection?.kind === 'body' && this.viewport.hiddenBodies.has(this.viewport.bodyIndexOf(this.selection.id))) this.selection = null;
    if (['face', 'edge', 'vertex'].includes(this.selection?.kind)) this.selection = null;
    this.updateSelectionHighlight();
    if (this.viewport.section) this.applySection();
    this.ui.renderTree();
  }

  // several bodies at once (one undo step)
  setBodiesHidden(ids, hidden) {
    for (const id of ids) {
      const st = M.ensureBodySettings(this.doc, id);
      if (hidden) st.hidden = true; else delete st.hidden;
    }
    this.commit();
    if (this.showHiddenMode && !(this.result.bodies || []).some((b) => this.isBodyHidden(b.id))) this.exitShowHidden();
    else this.refreshBodyVisibility();
    this.ui.renderTree();
  }

  // ---- what the eye in the tree's visibility column shows: true (shown), false (hidden), null (nothing to show)
  // Planes, axes, points and curves follow their kind's switch (View ▸ Hide/Show) unless shown or hidden one
  // by one (f.visible); a feature that makes bodies is shown while any of its bodies is.
  refVisKind(f) {
    if (f.type === 'plane') return 'planes';
    if (f.type === 'axis') return 'axes';
    if (f.type === 'point') return 'points';
    if (['helix', 'sketch3d', 'projCurve', 'compCurve'].includes(f.type)) return 'curves';
    return null;
  }
  refShown(f) {
    const k = this.refVisKind(f);
    if (f.visible === true || f.visible === false) return f.visible;
    return k === 'curves' ? true : !!this.vis[k];
  }
  featureVisible(f) {
    if (!f || f.suppressed || M.isRolledBack(this.doc, f)) return null;
    if (f.type === 'sketch') return this.sketchShown(f);
    if (this.refVisKind(f)) return this.refShown(f);
    const ids = this.bodiesOfFeature(f);
    if (!ids.length) return null;
    return ids.some((id) => !this.isBodyHidden(id));
  }
  setFeatureVisible(id, on) {
    const f = M.findFeature(this.doc, id);
    if (!f) return;
    if (f.type === 'sketch') return this.setSketchVisible(id, on);
    if (this.refVisKind(f)) {
      f.visible = on;
      this.commit();
      this.updatePlanes();
      this.updateRefGeometry();
      this.ui.renderTree();
      this.status(`${f.name} ${on ? 'shown' : 'hidden'}.`);
      return;
    }
    const ids = this.bodiesOfFeature(f);
    if (ids.length) { this.setBodiesHidden(ids, !on); this.status(`${f.name}: ${ids.length === 1 ? 'its body' : `its ${ids.length} bodies`} ${on ? 'shown' : 'hidden'}.`); }
  }
  toggleFeatureVisible(id) {
    const v = this.featureVisible(M.findFeature(this.doc, id));
    if (v !== null) this.setFeatureVisible(id, !v);
  }
  // the standard planes: shown with the Planes switch (and in an empty part) unless shown or hidden one by one
  stdPlaneShown(key) {
    const own = this.doc.planeVis?.[key];
    if (own === true || own === false) return own;
    // (in an empty part they show where things are; not while drawing a 3D sketch, which has its own planes)
    return (this.showPlanes && this.vis.planes) || (!this.result?.body && this.mode !== 'sketch3d');
  }
  setStdPlaneVisible(key, on) {
    (this.doc.planeVis ||= {})[key] = on;
    this.commit();
    this.updatePlanes();
    this.ui.renderTree();
    this.status(`${G.STD_PLANES[key].name} ${on ? 'shown' : 'hidden'}.`);
  }

  setBodyHidden(id, hidden) {
    const st = M.ensureBodySettings(this.doc, id);
    if (hidden) st.hidden = true; else delete st.hidden;
    this.commit();
    if (this.showHiddenMode && !(this.result.bodies || []).some((b) => this.isBodyHidden(b.id))) this.exitShowHidden();
    else this.refreshBodyVisibility();
    const b = this.bodyById(id);
    this.status(`${b?.name || 'Body'} ${hidden ? 'hidden — Shift+Tab over it (or right-click the view ▸ Show Hidden Bodies) brings it back' : 'shown'}.`);
  }

  // ------------------------------------------------------------ sheet metal: flatten, DXF
  // The sheet metal body to act on: the given one, the selected one, or the only one.
  sheetBodyFor(bodyId = null) {
    if (bodyId) return this.bodyById(bodyId);
    const s = this.selection;
    const b = s?.kind === 'body' ? this.bodyById(s.id) : (s?.kind === 'face' || s?.kind === 'edge') && s.body != null ? this.result?.bodies?.[s.body] : null;
    if (b?.sheet) return b;
    const sheets = (this.result?.bodies || []).filter((x) => x.sheet);
    return sheets.length === 1 ? sheets[0] : null;
  }

  // Flatten: show a sheet metal body's flat pattern on its own; again (or Esc) restores the view.
  async toggleFlatten(bodyId = null) {
    if (this.flatView) return this.exitFlatten();
    if (this.mode === 'sketch') { this.toast('Exit the sketch first', true); return; }
    const b = this.sheetBodyFor(bodyId);
    if (!b) {
      this.toast((this.result?.bodies || []).some((x) => x.sheet) ? 'Select the sheet metal body to flatten (click it, or pick it in Sheet Metal Bodies)' : 'There is no sheet metal body to flatten', true);
      return;
    }
    if (this.pm) this.cancelPM();
    let data;
    try { data = await this.withProgress('Flattening…', () => this.kernel.request('sheetFlat', { bodyId: b.id, flip: this.flatFlip(b.id) })); } catch (err) { this.toast('Could not flatten: ' + err.message, true); return; }
    this.flatView = { bodyId: b.id, view: this.viewport.saveView(), isolated: this.isolated, data };
    // (a feature selected in the tree would show its folded faces over the pattern)
    this.viewport.clearFaceHighlights();
    this.viewport.setFaceSet([], 'featureSel');
    this.viewport.setFaceSet([], 'featureHover');
    this.isolated = new Set(); // every body hidden while the flat pattern is shown
    this.pushBody(true);
    // seen from the side chosen in Body Properties (the bottom face: from below)
    const fr = G.frameFromJSON(data.frame);
    if (data.flip) fr.n = fr.n.clone().negate();
    this.viewport.showFlat({ mesh: data.mesh, lines: this.flatLines(data), frame: fr });
    const [w, h] = data.size.map((x) => +x.toFixed(2));
    this.showBanner(`Flat pattern of ${b.name}: ${w} × ${h} mm, ${data.bends.length} bend${data.bends.length === 1 ? '' : 's'}, seen from the ${data.flip ? 'bottom' : 'top'} face${data.stale ? ` (not including ${data.stale})` : ''}`,
      [{ label: 'Export DXF…', action: () => this.exportSheetDXF(b.id) }, { label: 'Exit Flatten', action: () => this.exitFlatten() }]);
    this.status('Flat pattern. Red bend lines bend up, blue ones down (seen from this side). Export DXF… saves it; Esc or Flatten again goes back.');
    this.ui.refreshCommandStates();
  }

  exitFlatten() {
    const fv = this.flatView;
    if (!fv) return;
    this.flatView = null;
    this.viewport.clearFlat();
    this.isolated = fv.isolated;
    this.showBanner(null);
    this.pushBody(true);
    this.viewport.restoreView(fv.view);
    this.ui.refreshCommandStates();
    this.status('Ready');
  }

  // Which face a sheet metal body's flat pattern is seen from (Body Properties): true = the bottom face.
  flatFlip(bodyId) { return M.bodySettings(this.doc, bodyId)?.flatSide === 'bottom'; }

  // The flat pattern's lines in the model (on the face it is seen from).
  flatLines(data) {
    const fr = data.frame, [x0, y0] = data.origin, off = Math.max(0.005, data.t * 0.01);
    const z = data.flip ? -off : data.t + off, W = data.size[0];
    // a flipped pattern is mirrored: put it back in place on the part
    const P = (q) => {
      const p = data.flip ? [W - q[0], q[1]] : q;
      return new THREE.Vector3(
        fr.o[0] + (p[0] + x0) * fr.u[0] + (p[1] + y0) * fr.v[0] + z * fr.n[0],
        fr.o[1] + (p[0] + x0) * fr.u[1] + (p[1] + y0) * fr.v[1] + z * fr.n[1],
        fr.o[2] + (p[0] + x0) * fr.u[2] + (p[1] + y0) * fr.v[2] + z * fr.n[2]);
    };
    const groups = { cut: [], up: [], down: [], region: [], mark: [] };
    const push = (key, pts) => { for (let i = 0; i < pts.length - 1; i++) groups[key].push(P(pts[i]), P(pts[i + 1])); };
    for (const e of data.ents) {
      const key = e.layer === 'BEND_UP' ? 'up' : e.layer === 'BEND_DOWN' ? 'down' : e.layer === 'BEND_REGION' ? 'region' : e.layer === 'FORMING' ? 'mark' : e.layer === 'NOTES' ? null : 'cut';
      if (!key) continue;
      if (e.type === 'LINE') push(key, [e.a, e.b]);
      else if (e.type === 'POLYLINE') push(key, e.pts);
      else if (e.type === 'CIRCLE' || e.type === 'ARC') {
        let a0 = e.type === 'CIRCLE' ? 0 : e.a0, a1 = e.type === 'CIRCLE' ? 360 : e.a1;
        if (a1 <= a0) a1 += 360;
        const n = Math.max(12, Math.ceil((a1 - a0) / 6)), pts = [];
        for (let i = 0; i <= n; i++) { const t = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180; pts.push([e.c[0] + e.r * Math.cos(t), e.c[1] + e.r * Math.sin(t)]); }
        push(key, pts);
      }
    }
    const size = Math.max(...data.size, 1);
    return [
      { color: 0x1d2430, pts: groups.cut },
      { color: 0xd32f2f, pts: groups.up, dashed: true, dash: size * 0.02 },
      { color: 0x1565c0, pts: groups.down, dashed: true, dash: size * 0.02 },
      { color: 0x8a96a8, pts: groups.region, dashed: true, dash: size * 0.008 },
      { color: 0xb02fb0, pts: groups.mark, dashed: true, dash: size * 0.012 },
    ].filter((l) => l.pts.length);
  }

  // Text block for a DXF: part name, material, thickness, quantity, flat size, bends.
  sheetPartInfo(b, data) {
    const qty = (M.bodySettings(this.doc, b.id)?.qty || 1) * this.bodyCount(b);
    const [w, h] = data.size.map((x) => +x.toFixed(2));
    return {
      h: Math.min(Math.max(Math.max(w, h) * 0.02, 2), 6),
      lines: [`PART: ${b.name}`, `MATERIAL: ${b.material?.name || 'NOT SPECIFIED'}`, `THICKNESS: ${+data.t.toFixed(3)} MM`, `QTY: ${qty}`, `FLAT SIZE: ${w} X ${h} MM`, `BENDS: ${data.bends.length}`,
        ...(data.cut ? [`CUT LENGTH: ${+data.cut.length.toFixed(1)} MM`, `PIERCES: ${data.cut.loops}`] : [])],
    };
  }

  // Export flat patterns as DXF: one body (save dialog) or all sheet metal bodies (into a chosen
  // folder). Each one is previewed first; the layer colours / line types can be changed there.
  async exportSheetDXF(bodyId = null, all = false) {
    if (this.mode === 'sketch') { this.toast('Exit the sketch first', true); return; }
    const sheets = (this.result?.bodies || []).filter((b) => b.sheet);
    if (!sheets.length) { this.toast('There are no sheet metal bodies to export', true); return; }
    let list;
    if (all) list = groupBodies(sheets).map((g) => g.rep); // identical bodies: one file (with their quantity)
    else {
      const b = this.sheetBodyFor(bodyId || this.flatView?.bodyId || null);
      if (!b) { this.toast('Select a sheet metal body (or use Export All DXF)', true); return; }
      list = [b];
    }
    let folder = null;
    if (all) { folder = await platform.pickFolder(); if (!folder) return; }
    const settings = loadDxfSettings();
    let done = 0, skipped = 0, aborted = false;
    for (const [i, b] of list.entries()) {
      let data = this.flatView?.bodyId === b.id ? this.flatView.data : null; // (shown now: already flattened)
      if (!data) try { data = await this.withProgress(`Flattening ${b.name}…`, () => this.kernel.request('sheetFlat', { bodyId: b.id, flip: this.flatFlip(b.id) })); } catch (err) { this.toast(`${b.name}: ${err.message}`, true); skipped++; continue; }
      const info = this.sheetPartInfo(b, data);
      const r = await this.ui.showDxfPreview({ title: `DXF Export — ${b.name}${list.length > 1 ? ` (${i + 1} of ${list.length})` : ''}`, data, info, bulk: list.length > 1, fileName: dxfFileName(b.name) }, settings);
      if (r.action === 'abort') { aborted = true; break; }
      if (r.action === 'skip') { skipped++; continue; }
      settings.mapping = r.mapping; settings.options = r.options;
      if (r.remember) saveDxfSettings(settings);
      const bytes = new TextEncoder().encode(buildDXF(r.ents || selectEnts(data.ents, r.options, info), r.mapping));
      try {
        const path = all ? await platform.saveInto(folder, dxfFileName(b.name), bytes) : await platform.saveBinary(dxfFileName(b.name), bytes, 'dxf');
        if (path) done++; else if (all) { this.toast(`${b.name}: could not write the file`, true); skipped++; }
      } catch (err) { this.toast('DXF export failed: ' + err.message, true); }
    }
    if (done || skipped || aborted) this.toast(`${done} DXF file${done === 1 ? '' : 's'} exported${skipped ? `, ${skipped} skipped` : ''}${aborted ? ', export aborted' : ''}${all && platform.desktop && done ? ` to ${folder}` : ''}`);
  }

  // Tab hides the body under the cursor; Shift+Tab shows the hidden body under the cursor.
  tabHide(show) {
    const vp = this.viewport, at = vp.lastPointer;
    if (!this.result?.bodies?.length) return;
    if (!at) { this.status('Point at a body in the view and press Tab to hide it; Shift+Tab over a hidden body shows it again.'); return; }
    if (show) {
      const bi = vp.hiddenBodiesAt(at).find((i) => this.isBodyHidden(this.result.bodies[i]?.id));
      if (bi == null) { this.status('No hidden body under the cursor (right-click the view ▸ Show Hidden Bodies shows them all).'); return; }
      this.setBodyHidden(this.result.bodies[bi].id, false);
      return;
    }
    if (this.showHiddenMode) { this.status('Tab hides bodies in the normal view: press Esc to leave Show Hidden Bodies first.'); return; }
    const hit = vp.pickBody(at);
    const b = hit ? this.result.bodies[vp.faceBody[hit.face]] : null;
    if (!b) { this.status('No body under the cursor.'); return; }
    this.setBodyHidden(b.id, true);
  }

  isolateBodies(ids) {
    if (this.showHiddenMode) this.exitShowHidden(false);
    this.isolated = new Set(ids);
    this.refreshBodyVisibility();
    const names = ids.map((id) => this.bodyById(id)?.name).filter(Boolean).join(', ');
    this.showBanner(`Isolated: ${names} — the other bodies are hidden while you work on it.`, { label: 'Exit Isolate', action: () => this.exitIsolate() });
  }

  exitIsolate() {
    if (!this.isolated) return;
    this.isolated = null;
    this.showBanner(null);
    this.refreshBodyVisibility();
  }

  // Show only the hidden bodies; clicking one shows it again.
  toggleShowHidden() {
    if (this.showHiddenMode) return this.exitShowHidden();
    if (!(this.result?.bodies || []).some((b) => this.isBodyHidden(b.id))) { this.toast('There are no hidden bodies'); return; }
    if (this.pm) this.cancelPM();
    if (this.isolated) { this.isolated = null; }
    this.showHiddenMode = true;
    this.select(null);
    this.refreshBodyVisibility();
    this.showBanner('Hidden bodies — click a body to show it again.', { label: 'Done', action: () => this.exitShowHidden() });
  }

  exitShowHidden(refresh = true) {
    this.showHiddenMode = false;
    this.showBanner(null);
    if (refresh) this.refreshBodyVisibility();
  }

  setVisibility(key, on) {
    // (an assembly shown: its own planes)
    const asm = this.mode === 'drawing' && this.drawing?.updatePlanes ? this.drawing : null;
    if (asm && (key === 'stdPlanes' || key === 'all')) {
      this.showPlanes = on;
      if (asm.doc.planeVis) { delete asm.doc.planeVis; asm.dirty = true; this.updateTitle(); }
      try { localStorage.setItem('razorcad.vis', JSON.stringify({ vis: this.vis, showPlanes: this.showPlanes })); } catch { /* not kept */ }
      asm.updatePlanes(); asm.renderTree(); this.ui.renderHUD();
      return;
    }
    if (key === 'stdPlanes') { this.showPlanes = on; if (this.doc.planeVis) { delete this.doc.planeVis; this.commit(); } }
    else if (key === 'all') { for (const k of Object.keys(this.vis)) this.vis[k] = on; this.showPlanes = on; }
    else this.vis[key] = on;
    try { localStorage.setItem('razorcad.vis', JSON.stringify({ vis: this.vis, showPlanes: this.showPlanes })); } catch { /* not kept */ }
    this.updatePlanes();
    this.updateRefGeometry();
    this.updateSketchDisplay();
    if (key === 'surfaces' || key === 'all') this.refreshBodyVisibility();
    this.ui.renderHUD();
  }

  // ------------------------------------------------------------ measure
  startMeasure() {
    if (this.mode === 'sketch') this.exitSketch(true);
    if (this.mode === 'sketch3d') this.exitSketch3D(true);
    if (this.pm) this.cancelPM();
    // (snap points and chaining kept from the last time Measure was used)
    const o = this._measureOpts ||= { snap: { sketch: true, mids: true, centres: true }, keepFirst: false };
    this.pm = { kind: 'measure', picks: [], result: null, error: null, snap: o.snap, keepFirst: o.keepFirst, history: [] };
    this.select(null);
    this.ui.renderPM();
    this.ui.refreshCommandStates();
    this.status('Measure: click vertices, snap points (midpoints, centres, sketch points), edges, faces, planes or sketch lines (two items: the distance between them). Use the body filter (B) to pick whole bodies.');
  }

  // The measure pick under the cursor: a sketch point, sketch line, vertex, snap point (an edge's middle, a circle's
  // centre), edge, face (or body), plane. (snap: which snap points are on, Measure's ticks)
  measurePickAt(e) {
    const vp = this.viewport, snap = this.pm?.snap || {};
    if (snap.sketch !== false) {
      const sp = this.sketchPointAt(e);
      if (sp) {
        const s = this.result.sketches.get(sp.sketch), q = s && S.getPoint(s.sketch, sp.point);
        if (q) return { kind: 'vertex', p: G.toWorld(s.frame, q.x, q.y).toArray(), label: 'Sketch point' };
      }
    }
    const sl = this.sketchSegmentAt(e);
    if (sl) return { kind: 'seg', a: sl.a, b: sl.b, label: 'Sketch line' };
    if (this.allows('vertex')) { const v = vp.pickVertex(e, 7); if (v) return { kind: 'vertex', p: v.point.toArray(), label: 'Vertex' }; }
    if (this.allows('vertex') || this.allows('edge')) {
      const sn = vp.pickSnap(e, { mids: snap.mids !== false, centres: snap.centres !== false }, 7);
      if (sn) return { kind: 'vertex', p: sn.point.toArray(), label: sn.kind === 'mid' ? 'Midpoint' : 'Centre' };
    }
    if (this.allows('edge')) { const ed = vp.pickEdge(e, 5); if (ed) return { kind: 'edge', p: ed.edge.mid, label: 'Edge' }; }
    const fh = this.faceAt(e);
    if (fh && this.allows('body') && !this.allows('face')) { const b = this.result.bodies[vp.faceBody[fh.hit.face]]; if (b) return { kind: 'body', id: b.id, label: b.name }; }
    if (fh && this.allows('face')) return { kind: 'face', p: fh.hit.point.toArray(), label: vp.faceInfo(fh.hit.face).planar ? 'Face (flat)' : 'Face' };
    const ph = vp.pickPlane(e);
    if (ph) {
      const fr = G.STD_PLANES[ph.id] ? G.stdFrame(ph.id) : this.result.planes.get(ph.id);
      if (fr) return { kind: 'plane', o: fr.o.toArray(), n: fr.n.toArray(), label: G.STD_PLANES[ph.id]?.name || M.findFeature(this.doc, ph.id)?.name || 'Plane' };
    }
    return null;
  }

  // A line of any sketch shown in the view under the cursor: { a, b } in world coordinates.
  sketchSegmentAt(e) {
    const vp = this.viewport, m = vp.screenPos(e);
    let best = null, bd = 6;
    for (const [id, s] of this.result.sketches) {
      const f = s.sketch;
      if (!(this.vis.sketches && this.sketchShown(f)) && this.hoverSketchId !== id) continue;
      for (const c of f.curves) {
        if (c.type !== 'line') continue;
        const A = S.getPoint(f, c.p1), B = S.getPoint(f, c.p2);
        const wa = G.toWorld(s.frame, A.x, A.y), wb = G.toWorld(s.frame, B.x, B.y);
        const a = vp.project(wa), b = vp.project(wb);
        const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
        const t = L2 ? Math.max(0, Math.min(1, ((m.x - a.x) * dx + (m.y - a.y) * dy) / L2)) : 0;
        const d = Math.hypot(m.x - (a.x + t * dx), m.y - (a.y + t * dy));
        if (d < bd) { bd = d; best = { a: wa.toArray(), b: wb.toArray() }; }
      }
    }
    return best;
  }

  // A point of a sketch shown in the view under the cursor (part mode): { sketch, point }.
  sketchPointAt(e) {
    const vp = this.viewport, m = vp.screenPos(e);
    let best = null, bd = 7;
    for (const [id, s] of this.result.sketches) {
      const f = s.sketch;
      const datum=this.pickMode()==='ref';
      if(datum&&(f.suppressed||this.result.errors.has(id)||this.doc.features.indexOf(f)>=this.doc.features.indexOf(this.pm.feature)))continue;
      if (!datum&&!(this.vis.sketches && this.sketchShown(f)) && this.hoverSketchId !== id) continue;
      for (const q of f.points) {
        const a = vp.project(G.toWorld(s.frame, q.x, q.y)), d = Math.hypot(m.x - a.x, m.y - a.y);
        if (d < bd) { bd = d; best = { sketch: id, point: q.id }; }
      }
    }
    return best;
  }

  // A curve (line, arc or circle) of a sketch shown in the view under the cursor (part mode):
  // { sketch, curve, at (a world point on it, near the cursor) }.
  sketchCurveAt(e) {
    const vp = this.viewport, m = vp.screenPos(e);
    let best = null, bd = 6;
    for (const [id, s] of this.result.sketches) {
      const f = s.sketch;
      const datum=this.pickMode()==='ref';
      if(datum&&(f.suppressed||this.result.errors.has(id)||this.doc.features.indexOf(f)>=this.doc.features.indexOf(this.pm.feature)))continue;
      if (!datum&&!(this.vis.sketches && this.sketchShown(f)) && this.hoverSketchId !== id) continue;
      for (const c of f.curves) {
        const pts = S.curvePoints(f, c, 64).map(([x, y]) => G.toWorld(s.frame, x, y));
        for (let k = 0; k < pts.length - 1; k++) {
          const a = vp.project(pts[k]), b = vp.project(pts[k + 1]);
          const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
          const t = L2 ? Math.max(0, Math.min(1, ((m.x - a.x) * dx + (m.y - a.y) * dy) / L2)) : 0;
          const d = Math.hypot(m.x - (a.x + t * dx), m.y - (a.y + t * dy));
          if (d < bd) { bd = d; best = { sketch: id, curve: c.id, at: pts[k].clone().lerp(pts[k + 1], t).toArray() }; }
        }
      }
    }
    return best;
  }

  async measureClick(e) {
    const pick = this.measurePickAt(e);
    if (!pick) return;
    const pm = this.pm;
    const same = (x, y) => x.kind === y.kind && JSON.stringify(x.p || x.id || x.a || x.o) === JSON.stringify(y.p || y.id || y.a || y.o);
    const i = pm.picks.findIndex((x) => same(x, pick));
    if (i >= 0) pm.picks.splice(i, 1);
    // (a third item: in place of the first, or, keeping the first, of the second: from one item to each next one)
    else { pm.picks.push(pick); if (pm.picks.length > 2) pm.picks.splice(pm.keepFirst ? 1 : 0, 1); }
    await this.runMeasure();
  }

  // Measure's marks: the items picked, numbered; the point a click would pick (hover)
  measureMarks(hover) {
    const vp = this.viewport, pm = this.pm;
    if (pm?.kind !== 'measure') { vp.setPointMarks('measure-picks', null); vp.setPointMarks('measure-hover', null); return; }
    if (hover !== undefined) vp.setPointMarks('measure-hover', hover?.kind === 'vertex' && !pm.picks.some((x) => x.kind === 'vertex' && String(x.p) === String(hover.p)) ? [{ p: hover.p, text: hover.label }] : null);
    const at = (r) => r.p || (r.a && r.b ? r.a.map((x, k) => (x + r.b[k]) / 2) : r.o);
    vp.setPointMarks('measure-picks', pm.picks.map((r, i) => ({ p: at(r), text: String(i + 1), cls: 'pick' })).filter((x) => x.p));
  }

  async runMeasure() {
    const pm = this.pm;
    if (pm?.kind !== 'measure') return;
    pm.result = null; pm.error = null;
    this.viewport.setMeasure(null);
    this.updateEdgeHighlights();
    if (pm.picks.length) {
      try { pm.result = await this.kernel.measure(pm.picks.map(({ label, ...r }) => r)); } catch (err) { pm.error = err.message; }
      if (this.pm !== pm) return;
      const r = pm.result;
      if (r?.a && r.distance > 1e-9) this.viewport.setMeasure({ a: r.a, b: r.b, text: `${r.distance.toFixed(3)} mm` });
      // (the distances measured, most recent first: the panel lists them)
      if (r?.distance != null && pm.picks.length === 2) {
        pm.history.unshift({ text: `${pm.picks[0].label} → ${pm.picks[1].label}`, distance: r.distance });
        if (pm.history.length > 8) pm.history.length = 8;
      }
    }
    this.measureMarks();
    this.ui.renderPM();
  }

  // ------------------------------------------------------------ geometry kernels: one per open part
  // How many kernels may work at once on this PC (machine.js): the pool's size (an assembly's parts, drawing views)
  // and how many open parts keep a kernel of their own. A part with its own kernel is ready the moment its tab
  // comes back (the kernel still holds it), and goes on building while another tab is worked on.
  async sizeKernels() {
    try {
      const m = await machineInfo();
      this.machine = m;
      const n = kernelBudget(m);
      this.kernelPool.size = Math.max(1, n - 1);
      this.tabKernelMax = Math.max(1, Math.min(8, Math.ceil(n / 2)));
      this.warmSpareKernel();
      const tpk = threadsPerKernel(m.threads);
      breadcrumb(`Geometry kernels: up to ${n} at once (${m.threads} threads${m.freeMB != null ? `, ${(m.freeMB / 1024).toFixed(1)} GB free` : m.totalMB != null ? `, about ${Math.round(m.totalMB / 1024)} GB` : ''}): ${this.kernelPool.size} for assemblies and drawings, ${this.tabKernelMax} for open parts${tpk > 1 ? `, each with ${tpk} threads` : ', single-threaded'}`);
    } catch { /* keep the defaults */ }
  }
  wireKernel(k) {
    k.onCrash = (err) => reportError('kernel-worker-crash', err, this);
    // the kernel broke and is being replaced; the request is repeated on the fresh kernel
    k.onRestart = (err) => {
      breadcrumb(`Geometry kernel restarted after: ${err.message}`);
      if (k === this.kernel) this.toast('The geometry kernel hit an internal error and was restarted; rebuilding the model.', true);
      reportError('kernel-restarted', err, this, { restarts: k.restarts });
    };
    // (a big import's bodies meshed in the pool's free kernels too: kernel.worker.js meshHelped)
    k.helpers = {
      free: (want) => { const st = this.kernelPool.stats(); return Math.max(0, Math.min(want, st.size - st.busy)); },
      mesh: (data) => this.kernelPool.request('meshImport', data, 'meshhelp:' + data.slot).catch(() => null),
    };
    // (progress shown for the part in front only)
    k.onProgress = (v, label, feature) => { if (k !== this.kernel) return; if (feature !== undefined) this._progFeature = feature; this.showProgress(v, label); };
    return k;
  }
  // the kernels the open parts hold
  liveKernels() { return new Set([this.kernel, ...this.tabs.map((t) => t.kernel), this._spareKernel].filter((k) => k && !k.disposed)); }
  // (one kernel started ahead, while the PC allows another: a new part's tab takes it ready, without waiting for a
  // kernel to start. Only once the part's own kernel is ready: in the browser both would download the kernel at
  // once, each at half the speed; after it, the spare one's comes from the browser's cache)
  warmSpareKernel() {
    clearTimeout(this._spareTimer);
    const seq = (this._spareSeq = (this._spareSeq || 0) + 1);
    Promise.resolve(this.kernel?.ready).catch(() => {}).then(() => {
      if (seq !== this._spareSeq) return;
      this._spareTimer = setTimeout(() => {
        if (this._spareKernel || this.liveKernels().size >= this.tabKernelMax || (this.machine && !memoryFor(this.machine, this.liveKernels().size))) return;
        this._spareKernel = this.wireKernel(new KernelClient({ fonts: this.kernel.fonts, threads: threadsPerKernel(this.machine?.threads) }));
      }, 300);
    });
  }
  // A kernel for a part coming to the front (tab: its tab, or a new one): its own if it still has one; else a
  // new one while the PC allows (machine.js); else the one of the part used longest ago (it builds this part next).
  kernelForTab(tab) {
    if (tab.kernel && !tab.kernel.disposed) return tab.kernel;
    const live = this.liveKernels();
    if (this._spareKernel && !this._spareKernel.disposed) {
      tab.kernel = this._spareKernel;
      this._spareKernel = null;
      this.warmSpareKernel();
      return tab.kernel;
    }
    if (live.size < this.tabKernelMax && (!this.machine || memoryFor(this.machine, live.size))) {
      // (the free memory looked at again for next time)
      machineInfo().then((m) => { this.machine = m; this.warmSpareKernel(); }).catch(() => {});
      return (tab.kernel = this.wireKernel(new KernelClient({ fonts: this.kernel.fonts, threads: threadsPerKernel(this.machine?.threads) })));
    }
    const others = this.tabs.filter((t) => t !== tab && t.kernel && !t.kernel.disposed && t.kernel !== this.kernel).sort((a, b) => (a.kernelUsed || 0) - (b.kernelUsed || 0));
    const from = others[0];
    const k = from ? from.kernel : this.kernel;
    if (from) from.kernel = null;
    for (const t of this.tabs) if (t !== tab && t.kernel === k) t.kernel = null;
    return (tab.kernel = k);
  }
  // the part of tab t to the front: its kernel becomes the app's
  useTabKernel(t) {
    const k = this.kernelForTab(t);
    t.kernelUsed = performance.now();
    this.kernel = k;
  }
  // a closed part's kernel stopped, unless another part still uses it or it is the last one
  releaseKernel(k) {
    if (!k || k.disposed || k === this.kernel || this.tabs.some((t) => t.kernel === k) || ![...this.liveKernels()].some((x) => x !== k)) return;
    k.dispose();
  }

  // ------------------------------------------------------------ part tabs
  // The active part's state lives on the app; switching tabs stores it and loads the other one.
  storeTab() {
    const t = this.tabs[this.tabIndex];
    if (t?.kind === 'drawing') { t.dirty = t.drawing.dirty; t.filePath = t.drawing.filePath; t.section = this.sectionForFile(); return; }
    if (!t || !this.doc) return;
    Object.assign(t, { doc: this.doc, history: this.history, filePath: this.filePath, dirty: this.dirty, lastAutosave: this.lastAutosave, view: this.viewport.saveView(), section: this.sectionForFile(),
      model: this._model?.doc === this.doc ? this._model.r : null, fileKey: this._fileKey, cachedKey: this._cachedKey, statesKey: this._statesKey, kernel: this.kernel, kernelUsed: performance.now() });
  }

  // Open the next part in a new tab, unless this tab holds an empty, untouched part.
  beginTab() {
    if (this.mode === 'drawing') {
      this.storeTab();
      this.exitDrawing();
      this.tabs.push({});
      this.tabIndex = this.tabs.length - 1;
      return;
    }
    const blank = this.doc && !this.doc.features.length && !this.dirty && !this.filePath;
    if (blank) return;
    if (this.mode === 'sketch') this.exitSketch(true);
    if (this.mode === 'sketch3d') this.exitSketch3D(true);
    if (this.pm) this.cancelPM();
    this.flushAutosave();
    this.storeTab();
    this.tabs.push({});
    this.tabIndex = this.tabs.length - 1;
    this.useTabKernel(this.tabs[this.tabIndex]);
    this.isolated = null;
    if (this.showHiddenMode) this.exitShowHidden(false);
    this.showBanner(null);
  }

  async activateTab(i) {
    if (i === this.tabIndex || !this.tabs[i]) return;
    if (this.mode === 'drawing') { this.storeTab(); this.exitDrawing(); }
    else {
      if (this.mode === 'sketch') this.exitSketch(true);
    if (this.mode === 'sketch3d') this.exitSketch3D(true);
      if (this.pm) this.cancelPM();
      this.flushAutosave();
      this.storeTab();
    }
    this.tabIndex = i;
    const t = this.tabs[i];
    if (t.kind === 'drawing') { this.enterDrawing(t.drawing); this.restoreSection(t.section); return; }
    this.useTabKernel(t);
    this.doc = t.doc; this.history = t.history; this.filePath = t.filePath; this.dirty = t.dirty; this.lastAutosave = t.lastAutosave;
    this._fileKey = t.fileKey || null; this._cachedKey = t.cachedKey || null; this._statesKey = t.statesKey || null; this._model = null;
    this.selection = null;
    this.isolated = null;
    if (this.showHiddenMode) this.exitShowHidden(false);
    this.showBanner(null);
    this.clearCycle();
    this.viewport.setSection(null);
    this.ui.renderPM();
    this.ui.refreshCommandStates();
    this.updateTitle();
    if (this.showTabModel(t)) { this.restoreSection(t.section); return; }
    await this.rebuild();
    if (t.view) this.viewport.restoreView(t.view);
    this.restoreSection(t.section);
  }

  // A tab's model as last built: shown now; the kernel (which holds one part at a time) catches up behind.
  showTabModel(t) {
    if (!t.model) return false;
    this.applyResult(t.model);
    this._model = { doc: this.doc, r: t.model };
    if (t.view) this.viewport.restoreView(t.view);
    this.rebuild();
    return true;
  }

  async closeTab(i) {
    if (i !== this.tabIndex) await this.activateTab(i);
    if (this.mode === 'drawing') return this.closeDrawingTab(i);
    if (this.mode === 'sketch') this.exitSketch(true);
    if (this.mode === 'sketch3d') this.exitSketch3D(true);
    if (this.pm) this.cancelPM();
    if (this.dirty && (this.doc.features.length || this.filePath)) {
      const choice = await this.ui.choose('Close Part', 'part', `<p>Save the changes to <b>${this.doc.name.replace(/[<>&]/g, '')}</b> before closing it?</p>`,
        [['save', 'Save', true], ['discard', 'Don\'t Save'], ['cancel', 'Cancel']]);
      if (!choice || choice === 'cancel') return false;
      if (choice === 'save') { await this.saveFile(); if (this.dirty) return false; }
    }
    this.cancelAutosave();
    if (this.tabs.length === 1) {
      this.tabs = [{}]; this.tabIndex = 0;
      this.filePath = null;
      await this.setDoc(M.newDoc());
      return true;
    }
    const closed = this.tabs.splice(i, 1)[0], closedKernel = this.kernel;
    this.tabIndex = -1; // nothing to store: the closed part is gone
    const next = Math.min(i, this.tabs.length - 1);
    const t = this.tabs[next];
    this.tabIndex = next;
    if (closed) closed.kernel = null;
    if (t.kind === 'drawing') { this.releaseKernel(closedKernel); this.enterDrawing(t.drawing); return true; }
    this.useTabKernel(t);
    this.releaseKernel(closedKernel);
    this.doc = t.doc; this.history = t.history; this.filePath = t.filePath; this.dirty = t.dirty; this.lastAutosave = t.lastAutosave;
    this._fileKey = t.fileKey || null; this._cachedKey = t.cachedKey || null; this._statesKey = t.statesKey || null; this._model = null;
    this.selection = null;
    this.ui.renderPM();
    this.ui.refreshCommandStates();
    this.updateTitle();
    if (this.showTabModel(t)) return true;
    await this.rebuild();
    if (t.view) this.viewport.restoreView(t.view);
    return true;
  }

  anyDirty() {
    const cur = this.mode === 'drawing' ? !!this.drawing?.dirty : this.dirty;
    return cur || this.tabs.some((t, i) => i !== this.tabIndex && (t.kind === 'drawing' ? t.drawing.dirty : t.dirty));
  }

  // ------------------------------------------------------------ drawings
  // A drawing opens in a tab of its own; while it is active the 3D view is hidden.
  openDrawingTab(doc, filePath = null, editor = null) {
    const ed = editor || new DrawingEditor(this, doc, filePath);
    if (this.macros?.rec) ed._macroBase = JSON.stringify(ed.doc); // (a macro being recorded: its first change)
    const cur = this.tabs[this.tabIndex];
    const blankPart = this.mode !== 'drawing' && cur && cur.kind !== 'drawing' && this.doc && !this.doc.features.length && !this.dirty && !this.filePath;
    if (this.mode === 'drawing') { this.storeTab(); this.exitDrawing(); }
    else {
      if (this.mode === 'sketch') this.exitSketch(true);
    if (this.mode === 'sketch3d') this.exitSketch3D(true);
      if (this.pm) this.cancelPM();
      this.flushAutosave();
      this.storeTab();
    }
    const tab = { kind: 'drawing', drawing: ed, filePath, dirty: false };
    if (blankPart) this.tabs[this.tabIndex] = tab; // an empty, untouched part tab is replaced
    else { this.tabs.push(tab); this.tabIndex = this.tabs.length - 1; }
    this.enterDrawing(ed);
    return ed;
  }

  // ------------------------------------------------------------ assemblies (an editor tab, like a drawing, that uses the 3D view)
  openAssemblyTab(doc, filePath = null) {
    const ed = this.openDrawingTab(doc, filePath, new AssemblyEditor(this, doc, filePath));
    this.restoreSection(doc.section); // (saved with a section view: the cut on again)
    return ed;
  }
  newAssembly() {
    const names = new Set(this.tabs.filter((t) => t.kind === 'drawing').map((t) => t.drawing.name));
    let n = 1;
    while (names.has('Assembly' + n)) n++;
    const doc = newAssembly('Assembly' + n);
    if (this.ui.prefs?.upAxis === 'z') doc.upAxis = 'z';
    const ed = this.openAssemblyTab(doc, null);
    this.status('New assembly: Insert Components (the parts open in tabs, or part files), then Mate them.');
    setTimeout(() => ed.insertComponents(), 50);
    return ed;
  }

  enterDrawing(ed) {
    if (this.ui.leftTab === 'config' && !ed.renderConfigs) this.ui.showLeft('tree');
    this.mode = 'drawing';
    this.drawing = ed;
    this.selection = null;
    this.showBanner(null);
    this.ui.closeClaude?.();
    ed.attach();
    this.updateTitle();
  }

  exitDrawing() {
    if (!this.drawing) return;
    this.drawing.detach();
    this.drawing = null;
    this.mode = 'part';
    this.ui.renderCommandManager();
    this.ui.showLeft('tree');
  }

  // File ▸ New Drawing (fromPart: of the open part or assembly, with its standard views).
  async newDrawing(fromPart = false) {
    let partTab = null, partDoc = null, partPath = null;
    if (fromPart) {
      const asm = this.mode === 'drawing' && this.drawing?.doc?.kind === 'assembly' ? this.drawing : null;
      if (asm) {
        if (!asm.doc.components.length) { this.toast('The assembly is empty: insert components first', true); return; }
        partTab = this.tabs[this.tabIndex];
        partDoc = asm.doc;
        partPath = asm.filePath || null;
      } else {
        if (this.mode === 'drawing') { this.toast('Open the part or assembly first, then use Make Drawing', true); return; }
        if (!this.doc.features.length) { this.toast('The part is empty: model something first', true); return; }
        this.storeTab();
        partTab = this.tabs[this.tabIndex];
        partDoc = this.doc;
        partPath = partTab.filePath || null;
      }
    }
    const names = new Set(this.tabs.filter((t) => t.kind === 'drawing').map((t) => t.drawing.name));
    let name = partDoc ? (partPath ? M.fileStem(partPath) : partDoc.name) : 'Drawing1';
    if (!partDoc) for (let n = 1; names.has(name); n++) name = 'Drawing' + n;
    // set up the drawing: its template, name, title block and sheet
    const setup = await this.ui.newDrawingSetup({ name, title: partDoc ? name : '' });
    if (!setup) { if (fromPart && partTab) this.status('Drawing not made.'); return; }
    const doc = drawingFromTemplate(setup.template, { name: setup.name, props: setup.props, sheet: setup.sheet });
    const ed = this.openDrawingTab(doc, null);
    if (partDoc) {
      const mid = ed.addModel({ name: partDoc.name, path: partPath, doc: partDoc, tab: partTab });
      ed.snap = JSON.stringify(ed.doc);
      ed.startTool('std3', { model: mid, choice: { key: 'm:' + mid, model: mid, label: partDoc.name } });
      await ed.placeStandard3(ed.tool);
      this.status(`Drawing of ${partDoc.name}: add views (View Layout) and dimensions (Annotation), then File ▸ Export ▸ PDF.`);
    } else {
      ed.startTool('model');
      this.status('New drawing: pick a part (open in another tab, or browse for its file), then click on the sheet to place a view.');
    }
  }

  async closeDrawingTab(i) {
    const ed = this.drawing;
    if (ed.dirty) {
      const choice = await this.ui.choose(`Close ${ed.kindLabel || 'Drawing'}`, ed.tabIcon || 'drawing', `<p>Save the changes to <b>${ed.name.replace(/[<>&]/g, '')}</b> before closing it?</p>`,
        [['save', 'Save', true], ['discard', 'Don\'t Save'], ['cancel', 'Cancel']]);
      if (!choice || choice === 'cancel') return false;
      if (choice === 'save' && !(await ed.save())) return false;
    }
    this.exitDrawing();
    ed.dispose?.();
    if (this.tabs.length === 1) {
      this.tabs = [{}]; this.tabIndex = 0;
      this.filePath = null;
      await this.setDoc(M.newDoc());
      return true;
    }
    this.tabs.splice(i, 1);
    this.tabIndex = -1;
    const next = Math.min(i, this.tabs.length - 1);
    const t = this.tabs[next];
    this.tabIndex = next;
    if (t.kind === 'drawing') { this.enterDrawing(t.drawing); return true; }
    this.doc = t.doc; this.history = t.history; this.filePath = t.filePath; this.dirty = t.dirty; this.lastAutosave = t.lastAutosave;
    this._fileKey = t.fileKey || null; this._cachedKey = t.cachedKey || null; this._statesKey = t.statesKey || null; this._model = null;
    this.selection = null;
    this.ui.renderPM();
    this.ui.refreshCommandStates();
    this.updateTitle();
    if (this.showTabModel(t)) return true;
    await this.rebuild();
    if (t.view) this.viewport.restoreView(t.view);
    return true;
  }

  // The open tabs with unsaved work (a new part with nothing in it doesn't count): [{ t, i }]
  dirtyTabs() {
    this.storeTab();
    return this.tabs.map((t, i) => ({ t, i })).filter(({ t }) => (t.kind === 'drawing' ? t.drawing.dirty : t.dirty && t.doc && (t.doc.features.length || t.filePath)));
  }
  // Saves every tab with unsaved work (asking where for those never saved); false when one was not saved.
  async saveAll() {
    for (const { i } of this.dirtyTabs()) {
      await this.activateTab(i);
      await this.saveFile();
      if (this.mode === 'drawing' ? this.drawing.dirty : this.dirty) return false;
    }
    return true;
  }

  // Asked by the desktop shell when the window is closing with unsaved parts.
  async confirmClose() {
    platform.closeAck();
    const dirty = this.dirtyTabs();
    if (!dirty.length) { platform.closeApp(); return; }
    const list = dirty.map(({ t }) => `<li><b>${(t.kind === 'drawing' ? t.drawing.name : t.doc.name).replace(/[<>&]/g, '')}</b>${(t.kind === 'drawing' ? t.drawing.filePath : t.filePath) ? '' : ' <span class="pm-hint">(never saved)</span>'}</li>`).join('');
    const choice = await this.ui.choose('Unsaved Changes', 'save',
      `<p>${dirty.length === 1 ? 'This part has' : 'These parts have'} unsaved changes:</p><ul style="margin:6px 0 10px 18px;padding:0">${list}</ul><p class="pm-hint">Save them before closing RazorCAD?</p>`,
      [['save', dirty.length === 1 ? 'Save and Close' : 'Save All and Close', true], ['discard', 'Close Without Saving'], ['cancel', 'Cancel']]);
    if (choice === 'discard') { platform.closeApp(); return; }
    if (choice !== 'save') { platform.closeCancel(); return; }
    if (!(await this.saveAll())) { this.toast('Not closed: a file was not saved', true); platform.closeCancel(); return; }
    platform.closeApp();
  }

  // ------------------------------------------------------------ STEP / STL: new part or insert
  // asPart: opened with File ▸ Open: always a part of its own (no question)
  async handleImport(file, { asPart = false } = {}) {
    if (!file) return;
    // (an IGES file: translated into STEP, its faces sewn into solids when they close)
    if (file.format === 'iges') {
      let r;
      try { r = igesToStep(file.data); } catch (e) { this.toast(`${file.name} could not be read: ${e.message}`, true); return; }
      if (!r.faces && !r.solids) { this.toast(`${file.name} has no surfaces or solids RazorCAD can read`, true); return; }
      const skipped = Object.entries(r.skipped).map(([t, n]) => `${n} × entity ${t}`).join(', ');
      if (skipped) breadcrumb(`IGES ${file.name}: left out ${skipped}`);
      file = { ...file, format: 'step', data: r.step, sew: true, igesNote: skipped };
    }
    const stem = file.name.replace(/\.[^.]+$/, '');
    // a STEP file: its structure and appearances (colours, transparency) read first. An assembly opened (not
    // inserted into a part) can open as an assembly, with its sub-assemblies; otherwise the appearances go with
    // the import, placed as the file places its parts.
    let appearance = null;
    if (file.format === 'step') {
      let asm = null;
      try { asm = await this.withProgress(`Reading ${file.name}…`, () => this.readStepAssembly(file.data)); }
      catch (err) { breadcrumb(`STEP structure not read: ${err.message}`); }
      appearance = asm ? (asm.single ? asm.appearance : asm.oneAppearance) : null;
      if (asPart && asm && !asm.single && asm.occurrences.length > 1) {
        const per = new Map(asm.parts.map((p) => [p.key, p.solids]));
        const solids = asm.occurrences.reduce((n, o) => n + (per.get(o.part) || 0), 0);
        const choice = await this.ui.choose('Open a STEP Assembly', 'assembly',
          `<p><b>${file.name.replace(/[<>&]/g, '')}</b> is an assembly of ${asm.parts.length} parts${asm.assemblies.length > 1 ? ` and ${asm.assemblies.length - 1} sub-assembl${asm.assemblies.length === 2 ? 'y' : 'ies'}` : ''} (${asm.occurrences.length} part occurrences).</p><p class="pm-hint">As an assembly, it keeps its structure, sub-assemblies and appearances; each part is built on its own and a part used more than once is built once. As one part, all ${solids.toLocaleString()} solids go into a single part.</p>`,
          [['asm', 'Open as an Assembly', true], ['part', 'Open as One Part']]);
        if (!choice) return;
        if (choice === 'asm') { this.openStepAssembly(file, asm); return; }
      }
    }
    let choice = asPart ? 'new' : 'insert';
    if (!asPart && this.doc.features.length) {
      choice = await this.ui.choose('Open a 3D File', 'import',
        `<p><b>${file.name.replace(/[<>&]/g, '')}</b></p><p>Open it as a new part, or insert it into <b>${this.doc.name.replace(/[<>&]/g, '')}</b>?</p><p class="pm-hint">Inserted bodies can be dropped in place, or located with mates (a Move/Copy Body feature under the import that you can edit later).</p>`,
        [['new', 'Open in a New Part', true], ['insert', 'Insert (drop in place)'], ['mates', 'Insert and Locate with Mates']]);
      if (!choice) return;
    }
    if (choice === 'new') {
      this.beginTab();
      this.filePath = null;
      const doc = M.newDoc();
      doc.name = stem;
      await this.setDoc(doc, { fit: false });
    } else if (!this.doc.features.length && /^Part\d+$/.test(this.doc.name)) this.doc.name = stem;
    await this.insertImport(file, choice === 'mates', appearance);
  }

  // The structure and appearances of a STEP file (stepasm.js, in a worker of its own).
  readStepAssembly(text) {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./stepasm.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const m = e.data;
        if (m.progress) { this.showProgress(null, m.progress); return; }
        w.terminate();
        if (m.error) reject(new Error(m.error)); else resolve(m.result);
      };
      w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'The STEP file could not be read')); };
      w.postMessage({ text });
    });
  }

  // A STEP assembly as a new assembly with the file's structure: each sub-assembly kept as one (inside this
  // assembly), each part of the file a part holding its own piece of the STEP file and the appearances the
  // file gives its solids and faces, and a component, fixed, where the file places each child.
  openStepAssembly(file, asm) {
    const r6 = (x) => Math.round(x * 1e6) / 1e6, r9 = (x) => Math.round(x * 1e9) / 1e9;
    const partDocs = new Map(asm.parts.map((p) => {
      const pd = M.newDoc();
      pd.name = p.name;
      M.insertFeature(pd, M.createFeature(pd, 'import', { format: 'step', fileName: p.name + '.step', data: p.step, name: p.name, ...(p.appearance ? { appearance: p.appearance } : {}) }));
      return [p.key, pd];
    }));
    const byKey = new Map(asm.assemblies.map((a) => [a.key, a]));
    const built = new Map(); // (a sub-assembly used in several places is one document)
    const build = (key, name, depth = 0) => {
      if (built.has(key)) return built.get(key);
      const a = byKey.get(key);
      const doc = newAssembly(name || a.name || 'Assembly');
      const ids = new Map();
      for (const ch of a.children) {
        let id = ids.get(ch.ref);
        if (!id) {
          const d = ch.kind === 'asm' ? (depth < 32 ? build(ch.ref, null, depth + 1) : null) : partDocs.get(ch.ref);
          if (!d) continue;
          id = 'pt' + doc.nextId++;
          ids.set(ch.ref, id);
          doc.parts.push({ id, name: d.name, path: null, doc: d });
        }
        doc.components.push({ id: 'c' + doc.nextId++, part: id, name: ch.name, config: null, pos: ch.pos.map(r6), rot: ch.rot.map(r9), fixed: true, hidden: false });
      }
      built.set(key, doc);
      return doc;
    };
    const doc = build(asm.root, file.name.replace(/\.[^.]+$/, ''));
    breadcrumb(`STEP assembly: ${file.name} (${asm.parts.length} parts, ${asm.assemblies.length - 1} sub-assemblies, ${asm.occurrences.length} part occurrences)`);
    const ed = this.openAssemblyTab(doc, null);
    ed.dirty = true;
    this.updateTitle();
    if (asm.warnings.length) this.toast(asm.warnings.join(' · '), true);
    const subs = asm.assemblies.length - 1;
    this.status(`${file.name}: ${asm.parts.length} parts${subs ? `, ${subs} sub-assembl${subs === 1 ? 'y' : 'ies'}` : ''}, each fixed where the file places it.`);
    return ed;
  }

  // (appearance: the colours and transparency of the file's solids and faces, from stepasm.js)
  async insertImport(file, locate = false, appearance = null) {
    if (this.mode === 'sketch') this.exitSketch(true);
    if (this.mode === 'sketch3d') this.exitSketch3D(true);
    if (this.pm) this.cancelPM();
    // (into a part shown Z up: the file's Z up made the part's, kept with the import so changing the part's up
    // axis later moves nothing)
    const f = M.createFeature(this.doc, 'import', { format: file.format, fileName: file.name, data: file.data, name: file.name.replace(/\.[^.]+$/, ''), ...(appearance ? { appearance } : {}), ...(file.sew ? { sew: true } : {}), ...(this.doc.upAxis === 'z' ? { upAxis: 'z' } : {}) });
    M.insertFeature(this.doc, f);
    this.commit();
    this.status(`Importing ${file.name}…`);
    breadcrumb(`Import: ${file.name} (${file.format}, ${Math.round(file.data.length / 1024)} KB)`);
    await this.withProgress(`Importing ${file.name}…`, () => this.refresh());
    const err = this.result.errors.get(f.id);
    const ids = (this.result.bodies || []).filter((b) => M.bodyOwner(b.id) === f.id).map((b) => b.id);
    if (err) { this.toast(`Import of ${file.name} failed: ${err}`, true); return; }
    this.viewport.zoomToFit();
    this.status(`Imported ${file.name}` + (ids.length > 1 ? ` — ${ids.length} bodies (grouped in Solid Bodies; select one with the body filter, B)` : ''));
    if (!locate || !ids.length) return;
    // locate it with mates: a Move/Copy Body feature that belongs to the import
    const mb = M.createFeature(this.doc, 'moveBody', { bodies: ids, mode: 'mates', parent: f.id, name: `Locate ${f.name}`, mates: [{ type: 'coincident', a: null, b: null, value: 10, flip: false }] });
    M.insertFeature(this.doc, mb);
    this.pm = { kind: 'feature', feature: mb, isNew: true, mateSlot: { i: 0, which: 'a' } };
    this.selection = null;
    this.rebuild();
    this.ui.renderPM();
    this.ui.refreshCommandStates();
    this.status('Locate the imported bodies: for each mate pick an entity on them, then one on the part. ✔ applies; Cancel leaves them where they are.');
  }

  startFeatureOnBody(type, id) {
    this.select({ kind: 'body', id });
    this.startFeature(type);
  }

  // ------------------------------------------------------------ feature highlight (tree hover / selection)
  // The faces a feature made (asked from the kernel once per rebuild), its surface bodies, or —
  // for sketches, planes, axes and points — the item itself.
  async featureFaces(id) {
    this._featureFaceCache ||= new Map();
    if (!this._featureFaceCache.has(id)) this._featureFaceCache.set(id, this.kernel.featureFaces(id).catch(() => []));
    return this._featureFaceCache.get(id);
  }

  hoverFeature(id) {
    if (this._hoverFeature === id) return;
    this._hoverFeature = id;
    const f = id ? M.findFeature(this.doc, id) : null;
    this.hoverSketchId = f?.type === 'sketch' ? id : null;
    this.updateSketchDisplay();
    this.updateRefGeometry();
    if (f?.type === 'plane' || !f) this.setHoverPlane(f ? id : null);
    this.highlightFeature(id, 'featureHover');
  }

  async highlightFeature(id, key) {
    const vp = this.viewport;
    this._featureHL ||= {};
    this._featureHL[key] = id;
    const f = id ? M.findFeature(this.doc, id) : null;
    if (!f || f.suppressed || this.mode === 'sketch' || this.pm || this.flatView || ['sketch', 'plane', 'axis', 'point'].includes(f.type)) { vp.setFaceSet([], key); return; }
    const infos = [];
    // surface bodies made by the feature
    for (const b of this.result?.bodies || []) {
      if (b.kind === 'surface' && (b.id === f.id || String(b.id).startsWith(f.id + '.'))) infos.push(vp.bodyInfo(b.index));
    }
    const faces = await this.featureFaces(f.id);
    if (this._featureHL[key] !== id) return; // something else is highlighted by now
    for (const i of faces) infos.push(vp.faceInfo(i));
    vp.setFaceSet(infos, key);
  }

  async refresh() {
    this.ui.renderPM();
    this.ui.refreshCommandStates();
    await this.rebuild();
    this.ui.renderPM();
  }

  sweepPicking() {
    const pm=this.pm,f=pm?.feature;
    return pm?.kind==='feature'&&['sweep','surfSweep'].includes(f.type)&&pm.sweepCanvas!==false&&!pm.scopePick;
  }

  activateSweepSlot(slot) {
    const pm=this.pm;
    if(pm.loftDraft?.curves.length&&pm.sweepSlot!==slot){this.toast('Add or clear the current contour before switching sweep roles',true);return false;}
    pm.sweepSlot=slot;pm.sweepCanvas=true;pm.scopePick=false;pm.planarEdges=false;pm.sweepSupportPick=false;pm.loftHover=null;
    this.ui.renderPM();this.updateSketchDisplay();return true;
  }

  setSweepReference(ref,slot=this.pm.sweepSlot||'profile',toggle=false) {
    const pm=this.pm,f=pm.feature;
    try{
      let autoThin=false;
      if(ref&&pm.loftDraft?.curves.length&&pm.sweepSlot!==slot)throw new Error('Add or clear the current contour before switching sweep roles');
      if(slot==='profile'&&f.profileType==='circle')throw new Error('The circular profile uses its diameter');
      if(ref){
        const source=M.findFeature(this.doc,LR.sourceId(ref));
        if(!source||source.suppressed)throw new Error('The selected sweep source is unavailable');
        if(slot==='profile'&&source.type!=='sketch')throw new Error('Choose a sketch contour for the profile');
        if(typeof ref!=='string'){
          const sketch=this.result.sketches.get(ref.sketch)?.sketch;if(!sketch)throw new Error('The selected sketch is unavailable');
          const resolved=LR.resolveContour(sketch,ref,slot!=='profile');
          if(slot==='profile'&&f.type==='sweep'&&!resolved.region&&!resolved.chain.closed)autoThin=true;
        }
        for(const other of ['profile','path','guide'])if(other!==slot&&!(other==='profile'&&f.profileType==='circle')&&LR.overlappingRefs(ref,f[other]))throw new Error('Choose different entities for the sweep profile, path and guide');
      }
      f[slot]=ref&&toggle&&LR.refKey(ref)===LR.refKey(f[slot])?null:ref;
      if(f[slot]&&autoThin)f.thin=true;
      if(ref){pm.sweepSlot=slot;pm.sweepCanvas=true;pm.scopePick=false;pm.loftDraft=null;pm.loftHover=null;}
      this.preview(true);this.updateSketchDisplay();return true;
    }catch(e){this.toast(e.message,true);this.ui.renderPM();return false;}
  }

  // What the open Property panel wants picked on the model: 'edge', 'vertex' or 'face'.
  loftConnectionGraph(){
    const f=this.pm?.kind==='feature'?this.pm.feature:null;if(!f||!['loft','surfLoft'].includes(f.type)||!LC.hasManualConnections(f))return null;
    const graph=this.result.info?.[f.id]?.loftConnections;return graph?.signature===JSON.stringify(f)?graph:null;
  }

  activateLoftConnector(index){
    const pm=this.pm;if(pm.loftDraft?.curves.length){this.toast('Add or clear the current contour first',true);return;}
    pm.loftConnector={index,key:LR.refKey(pm.feature.profiles[index]),connector:0,picking:true};pm.loftEndSlot=null;pm.loftSlot='profiles';pm.loftHover=null;
    this.ui.renderPM();this.updateSketchDisplay();this.status('Click the desired start vertex of this profile, or a point on its circle.');
  }

  setLoftConnection(ref,control,rerender=true){
    const pm=this.pm,f=pm.feature,key=LR.refKey(ref);
    try{
      const source=this.result.sketches.get(LR.sourceId(ref));if(!source)throw new Error('The profile sketch is unavailable');
      if(control)LC.connectionAnchor(source.sketch,ref,source.frame,control,x=>this.result.ev(x));
      f.loftCorrespondence={...(f.loftCorrespondence||{})};
      if(control)Object.defineProperty(f.loftCorrespondence,key,{value:{...control},enumerable:true,writable:true,configurable:true});else delete f.loftCorrespondence[key];
      f.correspondenceMode='manual';pm.loftConnector=null;pm.loftHover=null;this.preview(rerender);this.updateSketchDisplay();return true;
    }catch(e){this.toast(e.message,true);return false;}
  }

  loftConnectorTarget(e,pick=this.pm?.loftConnector){
    if(!pick)return null;
    const f=this.pm?.feature,ref=f?.profiles[pick.index],source=ref&&this.result.sketches.get(LR.sourceId(ref));if(!source||LR.refKey(ref)!==pick.key)return null;
    const options=LC.profileConnectionOptions(source.sketch,ref),graph=this.loftConnectionGraph(),row=graph?.sections[pick.index],m=this.viewport.screenPos(e),control=LC.connectionFor(f,ref)||{};
    if(options.circle){
      const hit=this.viewport.aimRay(e).ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(source.frame.n,source.frame.o),new THREE.Vector3());if(!hit)return null;
      const q=G.toLocal(source.frame,hit),center=options.circle.c,angle=Math.atan2(q.y-center.y,q.x-center.x),p=G.toWorld(source.frame,center.x+options.circle.r*Math.cos(angle),center.y+options.circle.r*Math.sin(angle)),screen=this.viewport.project(p);
      if(Math.hypot(screen.x-m.x,screen.y-m.y)>12)return null;
      const localAt=j=>{const p=row?.points[j];if(!p)return 0;const q=G.toLocal(source.frame,new THREE.Vector3(...p));return Math.atan2(q.y-center.y,q.x-center.x);};
      const delta=angle-localAt(pick.connector||0),next={...control,circle:options.circle.curve,angle:(localAt(0)+delta)*180/Math.PI};delete next.point;
      const origin=G.toWorld(source.frame,center.x,center.y),points=row?.points.map(p=>new THREE.Vector3(...p).sub(origin).applyAxisAngle(source.frame.n,delta).add(origin).toArray());
      return {ref,control:next,p:p.toArray(),points};
    }
    let target=null,distance=12;
    for(const point of options.points){const p=G.toWorld(source.frame,point.x,point.y),screen=this.viewport.project(p),d=Math.hypot(screen.x-m.x,screen.y-m.y);if(d<distance){target={point,p:p.toArray()};distance=d;}}
    if(!target&&options.curves.length){
      // (inside a curve: the profile gains a point there, its start)
      const hit=this.viewport.aimRay(e).ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(source.frame.n,source.frame.o),new THREE.Vector3());if(!hit)return null;
      const q=G.toLocal(source.frame,hit),near=LC.nearestCurvePoint2D(options.segs,options.curves,[q.x,q.y]);if(!near)return null;
      const p=G.toWorld(source.frame,near.q[0],near.q[1]),screen=this.viewport.project(p);if(Math.hypot(screen.x-m.x,screen.y-m.y)>12)return null;
      const next={...control,curve:near.curve,at:+near.at.toFixed(4)};delete next.point;delete next.circle;delete next.angle;
      return {ref,control:next,p:p.toArray(),points:null};
    }
    if(!target)return null;
    let point=target.point,points=row?.points;
    if(row){
      const k=row.points.findIndex(p=>p.every((x,i)=>Math.abs(x-target.p[i])<1e-5));if(k<0)return null;
      const shift=(k-(pick.connector||0)+row.points.length)%row.points.length,start=row.points[shift];
      point=options.points.find(p=>G.toWorld(source.frame,p.x,p.y).distanceTo(new THREE.Vector3(...start))<1e-5);if(!point)return null;
      points=[...row.points.slice(shift),...row.points.slice(0,shift)];
    }else if(pick.connector)return null;
    const next={...control,point:point.id};delete next.circle;delete next.angle;delete next.curve;delete next.at;if(!options.closed)next.reverse=false;
    return {ref,control:next,p:target.p,points};
  }

  loftConnectorDown(e){
    if(e.button!==0||this.pm?.kind!=='feature'||this.pm.loftEndSlot||this.pm.loftDraft?.curves.length)return false;
    if((this.pm.loftSlot||'profiles')!=='profiles')return false;
    if(this.pm.loftConnector?.picking)return false;
    const graph=this.loftConnectionGraph();if(!graph)return false;
    const m=this.viewport.screenPos(e);let pick=null,distance=9;
    graph.sections.forEach((section,index)=>{if(this.pm.loftConnector&&this.pm.loftConnector.index!==index)return;section.points.forEach((p,connector)=>{const s=this.viewport.project(new THREE.Vector3(...p)),d=Math.hypot(s.x-m.x,s.y-m.y);if(d<distance){distance=d;pick={index,connector,key:LR.refKey(section.ref)};}});});
    if(!pick)return false;
    this.viewport.controls.drag=null;this.pm.loftConnector=pick;this._loftConnectorDrag={pm:this.pm,pick,x:e.clientX,y:e.clientY,candidate:null};
    try{this.viewport.canvas.setPointerCapture(e.pointerId);}catch{}
    this.ui.renderPM();this.updateSketchDisplay();this.status('Drag this connector endpoint onto another vertex of the same profile.');return true;
  }

  loftConnectorMove(e){
    const drag=this._loftConnectorDrag;if(!drag)return false;if(this.pm!==drag.pm)return true;
    if(drag.cancelled)return true;
    try{drag.candidate=this.loftConnectorTarget(e,drag.pick);}catch{drag.candidate=null;}
    const graph=this.loftConnectionGraph(),candidate=drag.candidate;
    if(graph){const sections=graph.sections.map((row,i)=>i===drag.pick.index&&candidate?.points?{...row,points:candidate.points}:row);this.viewport.setLoftConnections({...graph,sections},drag.pick.index);}
    this.viewport.setPointMarks('loft-connection-target',candidate?[{p:candidate.p,text:'Attach',cls:'pick'}]:null);return true;
  }

  loftConnectorUp(e){
    const drag=this._loftConnectorDrag;if(!drag)return false;this._loftConnectorDrag=null;if(this.pm!==drag.pm)return true;
    const moved=Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>4;
    if(!moved&&e.target===this.viewport.canvas)this.viewport.controls.consumed=true;
    if(drag.cancelled||!LC.hasManualConnections(this.pm.feature)){this.updateSketchDisplay();return true;}
    if(moved&&drag.candidate)this.setLoftConnection(drag.candidate.ref,drag.candidate.control);
    else {if(this.pm.loftConnector)this.pm.loftConnector.picking=true;if(moved)this.toast('Choose a profile vertex, or a point on its circle',true);this.updateSketchDisplay();}
    return true;
  }

  loftPicking() { return this.sweepPicking() || this.pm?.kind === 'feature' && (['loft', 'surfLoft'].includes(this.pm.feature.type) && !this.pm.loftEndSlot || (this.pm.feature.type === 'extrude' && this.pm.extrudePick !== false) || (this.pm.feature.type === 'surfPlanar' && !this.pm.planarEdges) || (['revolve','surfExtrude','surfRevolve'].includes(this.pm.feature.type) && this.pm.profilePick!==false && !this.pm.planarEdges)); }

  loftCandidates() {
    if (!this.loftPicking()) return [];
    const before = this.doc.features.indexOf(this.pm.feature);
    return [...this.result.sketches].filter(([id, s]) => s.sketch.type === 'sketch' && !s.sketch.suppressed && !this.result.errors.has(id) && this.doc.features.indexOf(s.sketch) < before);
  }

  loftPickData(id, s) {
    this._loftPickCache ||= new Map();
    let cache = this._loftPickCache.get(id);
    if (!cache || cache.points !== s.sketch.points || cache.curves !== s.sketch.curves) {
      cache = { points: s.sketch.points, curves: s.sketch.curves, lines: s.sketch.curves.filter((c) => !c.ctrlOf).map((c) => ({ c, pts: S.curvePoints(s.sketch, c) })) };
      this._loftPickCache.set(id, cache);
    }
    return cache;
  }

  pickLoftContour(e) {
    const sweep=this.sweepPicking(),slot=sweep?(this.pm.sweepSlot||'profile'):(this.pm.loftSlot||'profiles'),guide=sweep?slot!=='profile':slot==='guides',chain=sweep?this.pm.feature.selectionChains?.[slot]!==false:this.pm.loftChain!==false;
    const candidates = this.loftCandidates(), vp = this.viewport, m = vp.screenPos(e);
    let edge = null, distance = 7;
    for (const [id, s] of candidates) for (const line of this.loftPickData(id, s).lines) {
      if (!guide && line.c.construction) continue;
      const pts = line.pts.map(([x, y]) => vp.project(G.toWorld(s.frame, x, y)));
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], d = S.segDist(m.x, m.y, a.x, a.y, b.x, b.y);
        if (d < distance) { distance = d; edge = { id, s, curve: line.c.id }; }
      }
    }
    const regions = (id, s) => { const cache = this.loftPickData(id, s); return cache.regions ||= LR.selectableRegions(s.sketch); };
    const regionRef = (id, region) => LR.regionRef(id, this.pm.feature.type === 'surfLoft' ? { ...region, holes: [] } : region);
    if (edge) {
      if (!guide && chain) {
        const matches = regions(edge.id, edge.s).filter((r) => [r.outer, ...r.holes].some((loop) => loop.segs.some((g) => g.sourceCurve === edge.curve)));
        if (matches.length === 1) return regionRef(edge.id, matches[0]);
        if (matches.length > 1) throw new Error('This edge borders several profiles; click inside the desired region or select its segments manually');
      }
      return LR.chainRef(edge.s.sketch, edge.id, edge.curve, chain, guide);
    }
    if (guide || !chain) return null;
    const ray = vp.aimRay(e).ray;
    let best = null, depth = Infinity;
    for (const [id, s] of candidates) {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(s.frame.n, s.frame.o), hit = ray.intersectPlane(plane, new THREE.Vector3());
      if (!hit) continue;
      const p = G.toLocal(s.frame, hit), d = hit.distanceTo(ray.origin);
      if (d >= depth) continue;
      const found = regions(id, s).find((r) => S.pointInPoly([p.x, p.y], r.outer.poly) && !r.holes.some((h) => S.pointInPoly([p.x, p.y], h.poly)));
      if (found) { depth = d; best = regionRef(id, found); }
    }
    return best;
  }

  addLoftContour(ref) {
    const f = this.pm.feature;
    if(['sweep','surfSweep'].includes(f.type)){this.setSweepReference(ref,this.pm.sweepSlot||'profile',true);return;}
    const key = this.pm.loftSlot || 'profiles', guide = key === 'guides';
    const source = this.result.sketches.get(LR.sourceId(ref));
    if (!source) throw new Error('The source sketch is unavailable');
    const result = LR.resolveContour(source.sketch, ref, guide);
    if (!guide && f.type === 'surfPlanar' && result.chain && !result.chain.closed) throw new Error('Planar Surface requires a closed contour');
    if (!guide && f.type === 'loft' && !f.thin && !result.region && !result.chain.closed) throw new Error('A solid loft needs a closed profile. Use Surface Loft for open sections');
    if (['extrude','revolve','surfExtrude','surfRevolve'].includes(f.type)) {
      const first = this.result.sketches.get(LR.sourceId(f.profiles?.[0]));
      if (first && (Math.abs(first.frame.n.dot(source.frame.n)) < 1 - 1e-7 || Math.abs(source.frame.o.clone().sub(first.frame.o).dot(first.frame.n)) > 1e-5)) throw new Error('Selected profiles must lie in the same plane');
      if (['extrude','revolve'].includes(f.type)&&!result.region && result.chain && !result.chain.closed) f.thin = true;
    }
    f[key] ||= [];
    if (f[key].some((q) => LR.refKey(q) === LR.refKey(ref))) {
      if (['extrude','surfPlanar','revolve','surfExtrude','surfRevolve'].includes(f.type)) {
        f[key] = f[key].filter((q) => LR.refKey(q) !== LR.refKey(ref));
        this.pm.loftDraft = null; this.pm.loftHover = null;
        this.preview(true); this.updateSketchDisplay(); return;
      }
      this.pm.loftDraft = null; this.pm.loftHover = null;
      this.ui.renderPM(); this.updateSketchDisplay();
      this.status('That contour is already selected.'); return;
    }
    if (['extrude','surfPlanar','revolve','surfExtrude','surfRevolve'].includes(f.type)) f[key] = f[key].filter((q) => q !== LR.sourceId(ref));
    f[key].push(ref); this.pm.loftDraft = null; this.pm.loftHover = null;
    this.preview(true); this.updateSketchDisplay();
    this.status(`${guide ? 'Guide' : 'Profile'} ${f[key].length} selected.`);
  }

  finishLoftSelection() {
    if (!this.pm?.loftDraft?.curves.length) return;
    try {
      let ref = this.pm.loftDraft;
      if ((['sweep','surfSweep'].includes(this.pm.feature.type)?(this.pm.sweepSlot||'profile')==='profile':(this.pm.loftSlot||'profiles')==='profiles') && ['loft', 'extrude', 'surfPlanar','revolve','surfExtrude','surfRevolve','sweep','surfSweep'].includes(this.pm.feature.type)) {
        const source = this.result.sketches.get(ref.sketch), subset = source && LR.contourSketch(source.sketch, ref);
        const regions = subset && S.profileRegions(subset, true);
        if (regions?.length === 1) {
          const canonical = LR.regionRef(ref.sketch, regions[0]);
          if (canonical.curves.length === new Set(ref.curves).size) ref = canonical;
        }
      }
      this.addLoftContour(ref);
    } catch (e) { this.toast(e.message, true); }
  }

  loftClick(e) {
    try {
      const ref = this.pickLoftContour(e);
      if (!ref && this.faceProfilePicking()) { const fh = this.faceAt(e); if (fh) return this.addFaceProfile(fh); }
      if (!ref) { this.status('Click a sketch contour, or inside a closed profile.'); return; }
      const chain=this.sweepPicking()?this.pm.feature.selectionChains?.[this.pm.sweepSlot||'profile']!==false:this.pm.loftChain!==false;
      if (chain) return this.addLoftContour(ref);
      let draft = this.pm.loftDraft;
      if (draft && draft.sketch !== ref.sketch) throw new Error('Finish the current contour before selecting another sketch');
      draft ||= { ...ref, curves: [] };
      const id = ref.curves[0], i = draft.curves.indexOf(id);
      if (i < 0) draft.curves.push(id); else draft.curves.splice(i, 1);
      this.pm.loftDraft = draft; this.pm.loftHover = null;
      this.ui.renderPM(); this.updateSketchDisplay();
    } catch (e) { this.toast(e.message, true); }
  }

  // A fillet's or chamfer's edges: all of a clicked face's added (removed when they are all in already)
  async addFaceEdges(fh) {
    const f = this.pm.feature, pm = this.pm, body = this.result.bodies?.[this.viewport.faceBody[fh.hit.face]]?.id, face = this.viewport.faceInfo(fh.hit.face);
    try {
      const refs = await this.kernel.request('faceEdges', { ref: { p: fh.hit.point.toArray(), ...(face.planar ? { n: face.normal.toArray() } : {}), ...(body ? { body } : {}) } });
      if (this.pm !== pm) return;
      const same = (a, b) => Math.hypot(...a.p.map((x, k) => x - b.p[k])) < 1e-4;
      f.edges ||= [];
      const all = refs.every((r) => f.edges.some((e) => same(e, r)));
      if (all) f.edges = f.edges.filter((e) => !refs.some((r) => same(e, r)));
      else for (const r of refs) if (!f.edges.some((e) => same(e, r))) f.edges.push(r);
      this.ui.renderPM(); this.updateEdgeHighlights(); this.preview();
      this.status(`${refs.length} edge${refs.length === 1 ? '' : 's'} ${all ? 'removed' : 'added'}.`);
    } catch (e) { if (this.pm === pm) this.toast(e.message, true); }
  }

  // Extrude and Revolve take flat model faces as profiles too (where no sketch profile is clicked)
  faceProfilePicking() {
    const f = this.pm?.feature;
    return !!f && ['extrude', 'revolve', 'surfExtrude', 'surfRevolve'].includes(f.type) && (this.pm.loftSlot || 'profiles') === 'profiles' && this.pm.loftChain !== false;
  }

  // A flat model face added as a profile, or removed when it is picked again
  addFaceProfile(fh) {
    const f = this.pm.feature, vp = this.viewport, face = vp.faceInfo(fh.hit.face);
    if (!face.planar) { this.toast('Click a flat face of the model, or a sketch profile', true); return; }
    const body = this.result.bodies?.[vp.faceBody[fh.hit.face]]?.id;
    f.profiles ||= [];
    const i = f.profiles.findIndex((q) => q?.kind === 'modelFace' && vp.faceIndexNear(q.p) === fh.hit.face);
    if (i >= 0) f.profiles.splice(i, 1);
    else { f.profiles.push({ kind: 'modelFace', p: fh.hit.point.toArray(), n: face.normal.toArray(), ...(body ? { body } : {}) }); f.thin = false; }
    this.pm.loftDraft = null; this.pm.loftHover = null;
    this.preview(true); this.updateSketchDisplay(); this.updateEdgeHighlights();
    this.status(i >= 0 ? 'Face profile removed.' : `Profile ${f.profiles.length} selected (a model face).`);
  }

  pickMode() {
    if (this.pm?.kind === 'measure') return 'measure';
    if (this.pm?.kind === 'section') return 'section';
    const f = this.pm?.kind === 'feature' ? this.pm.feature : null;
    if (!f) return null;
    if(['loft','surfLoft'].includes(f.type)&&this.pm.loftConnector&&!this.pm.loftEndSlot)return 'loftConnector';
    if(this.pm.scopePick&&['extrude','revolve','sweep'].includes(f.type)&&['cut','intersect'].includes(f.op)&&f.scopeAll===false)return 'body';
    if (['surfPlanar', 'surfExtrude', 'surfRevolve', 'sweep', 'surfSweep'].includes(f.type) && this.pm.planarEdges) return 'edge';
    if (['sweep', 'surfSweep'].includes(f.type) && this.pm.sweepSupportPick) return 'faces';
    if (['loft', 'surfLoft'].includes(f.type) && this.pm.loftEndSlot) return 'faces';
    if (this.loftPicking()) return 'loftContour';
    if (f.type === 'plane'||f.referenceDefinition&&['axis','point'].includes(f.type)&&!(f.type==='point'&&f.pointType==='coords')) return 'ref';
    if (f.type === 'hole' && this.pm.holeEndPick && f.end === 'upToVertex') return 'vertex';
    if (f.type === 'hole' && this.pm.holeEndPick && ['upToSurface', 'offsetSurface'].includes(f.end)) return 'face';
    if (f.type === 'boss' || f.type === 'snapHook') return 'faces';
    if (f.type === 'lipGroove') return 'flatface';
    if (f.type === 'shell' || f.type === 'surfOffset' || f.type === 'surfCopy' || f.type === 'hole' || f.type === 'smClosedCorner' || f.type === 'smCrossBreak' || f.type === 'smGusset' || (f.type === 'smForm' && f.formType !== 'louver')) return 'faces';
    const scoped = (f.type === 'extrude' || f.type === 'revolve') && (f.op === 'cut' || f.op === 'intersect') && f.scopeAll === false;
    if (f.type === 'deleteBody' || f.type === 'deleteSurface') return 'body';
    if (f.type === 'axis' && f.axisType === 'cylinder') return 'cylface';
    if (f.type === 'thread' || f.type === 'cosmeticThread') return 'cylface';
    if (f.type === 'sketch3d') return 'vertex'; // (a clicked vertex adds a point)
    if (f.type === 'smUnfold') return 'flatface';
    if (f.type === 'smTabSlot') return f.edge ? 'flatface' : 'edge'; // (the tab edge first, then the slot face)
    if (f.type === 'smConvert') return 'anyface'; // (a curved surface can be converted too)
    if (f.type === 'smFlange' || f.type === 'smHem' || f.type === 'smProfileFlange') return 'edge';
    if (f.type === 'surfFill') return this.pm.patchSupportPick ? 'faces' : 'edge';
    if (f.type === 'surfExtend') return 'edge';
    if (f.type === 'surfTrim' || f.type === 'deleteFace' || f.type === 'replaceFace' || f.type === 'untrim' || f.type === 'editFillet') return 'faces';
    if (f.type === 'ruledSurface' || f.type === 'compCurve') return 'edge';
    if (f.type === 'projCurve' || f.type === 'splitLine' || f.type === 'flattenSurf') return 'faces';
    if (['smCornerRelief', 'smFold', 'defeature'].includes(f.type)) return 'body';
    if (f.type === 'wrap') return 'anyface';
    if (['revolve', 'surfRevolve'].includes(f.type) && this.pm.revolveEndPick && f.extent === 'upToVertex') return 'vertex';
    if (['revolve', 'surfRevolve'].includes(f.type) && this.pm.revolveEndPick && f.extent === 'upToSurface') return 'face';
    if (f.type === 'revolve' && scoped) return 'body';
    if (f.type === 'revolve' || f.type === 'surfRevolve') return 'revaxis';
    if (f.type === 'moveBody' && f.mode === 'mates' && this.pm.mateSlot) return 'entity';
    if (f.type === 'split' && !f.tool) return 'face';
    if (['combine', 'knit', 'surfSolid', 'meshRepair', 'thicken', 'moveBody', 'split'].includes(f.type)) return 'body';
    if (f.type === 'fillet' && ['face', 'fullRound'].includes(f.filletType)) return 'faces';
    if (f.type === 'chamfer' && f.chamferType === 'vertex') return 'vertex';
    if ((f.type === 'fillet' || f.type === 'chamfer') && this.pm.faceEdgesPick) return 'faces';
    if (f.type === 'fillet' || f.type === 'chamfer') return 'edge';
    if (f.type === 'draft') return f.face ? 'faces' : 'flatface'; // (the neutral plane first, then the faces)
    if (f.type === 'dome') return 'faces';
    if (f.type === 'fillPattern') return 'flatface';
    if (f.type === 'weldTrim' || f.type === 'weldBead') return 'body';
    if (f.type === 'endCap' || f.type === 'weldGusset') return 'faces';
    if (f.type === 'moveFace') return f.mode === 'rotate' && f.faces?.length && !f.edge ? 'edge' : 'faces';
    if(['extrude','surfExtrude'].includes(f.type)&&f.startFrom==='surface'&&this.pm.extrudeSurfaceSlot==='start')return 'face';
    if(f.type==='extrude'&&f.side2&&this.pm.extrudeSurfaceSlot==='end2'&&f.end2==='upToVertex')return 'vertex';
    if(f.type==='extrude'&&f.side2&&this.pm.extrudeSurfaceSlot==='end2'&&['upToSurface','offsetSurface'].includes(f.end2))return 'face';
    if (['extrude', 'surfExtrude'].includes(f.type) && f.end === 'upToVertex') return 'vertex';
    if (['extrude', 'surfExtrude'].includes(f.type) && (f.end === 'upToSurface' || f.end === 'offsetSurface')) return 'face';
    if (scoped) return 'body';
    if (f.type === 'axis' && f.axisType === 'edge') return 'edge';
    if (f.type === 'point' && f.pointType === 'vertex') return 'vertex';
    if (f.type === 'point' && (f.pointType === 'arcCenter' || f.pointType === 'edgeMid')) return 'edge';
    // (a pattern: faces of the features to copy, or bodies to copy whole)
    if (['lpattern', 'cpattern', 'spattern', 'curvePattern'].includes(f.type)) return f.pick === 'bodies' ? 'body' : 'faces';
    if (f.type === 'mirror') return 'body';
    return null;
  }

  edgePickMode() { return this.pickMode() === 'edge'; }

  async pickPatchChain(hit) {
    const pm=this.pm,f=pm.feature;if(pm.patchChainBusy)return;
    const bodyId=this.result.bodies?.[this.viewport.edgeBody[hit.index]]?.id;
    pm.patchChainBusy=true;
    try{
      const result=await this.kernel.request('patchChain',{bodyId,ref:{p:hit.edge.mid},supportFaces:f.supportFaces||[]});
      if(this.pm!==pm||!f.chainSelection||pm.patchSupportPick)return;
      const same=(a,b)=>(!a.body||!b.body||a.body===b.body)&&Math.hypot(...a.p.map((x,i)=>x-b.p[i]))<1e-4;
      const allSelected=result.refs.every(ref=>f.edges.some(e=>same(e,ref)));
      if(allSelected)f.edges=f.edges.filter(e=>!result.refs.some(ref=>same(e,ref)));
      else for(const ref of result.refs)if(!f.edges.some(e=>same(e,ref)))f.edges.push(ref);
      this.ui.renderPM();this.updateEdgeHighlights();this.preview();
      this.status(result.ambiguous?'Chain stopped at a branch; pick the remaining edges individually.':`${result.refs.length} boundary edges ${allSelected?'removed':'selected'}.`);
    }catch(e){if(this.pm===pm)this.toast(e.message,true);}finally{pm.patchChainBusy=false;}
  }

  // Apply a pick from the model to the open Property panel.
  applyModelPick(hit) {
    const f = this.pm.feature;
    const mode = this.pickMode();
    if (mode === 'edge' && f.type === 'fillet' && this.pm.pickEdgePoint) {
      // a variable fillet's point added where its edge was clicked: the share of the edge's length from its start
      const k = f.edges.findIndex((x) => this.viewport.edgeIndexForPoint(x.p) === hit.index);
      if (k < 0) { this.toast('Click one of the fillet\'s own edges (select the edge first)'); return; }
      const P = hit.edge.pts, L = [0];
      for (let i = 1; i < P.length; i++) L.push(L[i - 1] + P[i].distanceTo(P[i - 1]));
      let s = 0, bd = Infinity;
      for (let i = 1; i < P.length; i++) {
        const seg = new THREE.Line3(P[i - 1], P[i]), q = seg.closestPointToPoint(hit.point, true, new THREE.Vector3()), dd = q.distanceTo(hit.point);
        if (dd < bd) { bd = dd; s = L[i - 1] + q.distanceTo(P[i - 1]); }
      }
      const pct = Math.max(0.1, Math.min(99.9, (100 * s) / (L[L.length - 1] || 1)));
      (f.edgePoints ||= []).push({ edge: k, t: +pct.toFixed(2), r: f.radius });
      this.pm.pickEdgePoint = false;
      this.status(`Point added ${pct.toFixed(1)} % along edge ${k + 1}: set its radius in the panel.`);
      this.ui.renderPM(); this.updateEdgeHighlights(); this.preview();
      return;
    }
    if (mode === 'edge') {
      if (['surfFill','surfPlanar','surfExtrude','surfRevolve','sweep','surfSweep'].includes(f.type) && f.chainSelection) { this.pickPatchChain(hit); return; }
      if (f.type === 'fillet' || f.type === 'chamfer' || f.type === 'smFlange' || f.type === 'smHem' || f.type === 'smProfileFlange' || f.type === 'surfFill' || f.type === 'surfPlanar' || (['surfExtrude', 'surfRevolve', 'sweep', 'surfSweep'].includes(f.type) && this.pm.planarEdges) || f.type === 'surfExtend' || f.type === 'ruledSurface' || f.type === 'compCurve') {
        const i = f.edges.findIndex((x) => this.viewport.edgeIndexForPoint(x.p) === hit.index);
        if (i >= 0) f.edges.splice(i, 1);
        else { f.edges ||= []; f.edges.push({ p: hit.edge.mid, ...(['surfPlanar', 'surfExtrude', 'surfRevolve', 'sweep', 'surfSweep'].includes(f.type) ? {body:this.result.bodies?.[this.viewport.edgeBody[hit.index]]?.id} : {}) }); }
      } else f.edge = { p: hit.edge.mid };
    } else if (mode === 'vertex') {
      if (f.type === 'extrude' && this.pm.extrudeSurfaceSlot === 'end2' && f.side2) { f.toVertex2 = { p: hit.point.toArray() }; f.toPoint2 = null; }
      else if (['extrude', 'surfExtrude', 'revolve', 'surfRevolve', 'hole'].includes(f.type)) { f.toVertex = { p: hit.point.toArray() }; f.toPoint = null; }
      else if (f.type === 'sketch3d') { const q = hit.point.toArray().map((x) => +x.toFixed(6)); (f.pts ||= []).push({ x: q[0], y: q[1], z: q[2] }); }
      else if (f.type === 'chamfer' && f.chamferType === 'vertex') { const p = hit.point.toArray(), L = (f.vertices ||= []), i = L.findIndex((v) => Math.hypot(...v.p.map((x, k) => x - p[k])) < 1e-4); if (i >= 0) L.splice(i, 1); else L.push({ p }); }
      else f.vertex = { p: hit.point.toArray() };
    } else if (mode === 'face') {
      if (f.type === 'split') f.toolFace = { p: hit.p, n: hit.n };
      else if(['extrude','surfExtrude'].includes(f.type)&&this.pm.extrudeSurfaceSlot==='start'){f.startFace={p:hit.p,n:hit.n};f.startPlane=null;}
      else if(f.type==='extrude'&&this.pm.extrudeSurfaceSlot==='end2'&&f.side2){f.toFace2={p:hit.p,n:hit.n};f.toPlane2=null;}
      else { f.toFace = { p: hit.p, n: hit.n }; f.toPlane = null; }
    }
    this.ui.renderPM();
    this.updateEdgeHighlights();
    this.preview();
  }

  // Add a reference to the plane being defined (or remove it if picked again). Up to three
  // references are kept; the plane type follows from them (see refgeom.js).
  togglePlaneRef(ref) {
    const pm=this.pm,f = pm.feature;
    const sourceId=ref.id||ref.sketch||(ref.body?M.bodyOwner(ref.body):null),source=sourceId&&M.findFeature(this.doc,sourceId);
    if(source&&(source.suppressed||this.doc.features.indexOf(source)>=this.doc.features.indexOf(f))){this.toast('Choose an earlier, unsuppressed reference',true);return;}
    f.refs = f.refs?.length ? f.refs : [];
    const same = (a, b) => a.kind === b.kind && (a.kind === 'sketch' ? a.sketch === b.sketch && (a.curve ?? null) === (b.curve ?? null) && (a.point ?? null) === (b.point ?? null) : a.id ? a.id === b.id
      : a.kind === 'edge' ? (a.body||'')===(b.body||'')&&Math.hypot(...a.p.map((x,i)=>x-b.p[i]))<1e-4
        : Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) < 1e-4 || (a.kind === 'face' && a.n && b.n && Math.abs(a.n[0] * b.n[0] + a.n[1] * b.n[1] + a.n[2] * b.n[2]) > 0.9999 && Math.abs(a.n[0] * (a.p[0] - b.p[0]) + a.n[1] * (a.p[1] - b.p[1]) + a.n[2] * (a.p[2] - b.p[2])) < 1e-4));
    const i = f.refs.findIndex((r) => same(r, ref));
    if (i >= 0) {
      if(pm.datumSlot!=null&&pm.datumSlot!==i){this.toast('This geometry is already used in another reference slot',true);return;}
      f.refs.splice(i,1);
    } else {
      if(pm.datumSlot!=null&&pm.datumSlot<f.refs.length)f.refs[pm.datumSlot]=ref;
      else if(f.refs.length<3)f.refs.push(ref);
      else{this.toast('All three slots are filled. Select a reference slot to replace it.',true);return;}
    }
    pm.datumSlot=null;
    useReferenceRelations(f);
    this.ui.renderPM();
    this.updateEdgeHighlights();
    this.updatePlanes();
    this.preview();
  }

  // Selected / hovered edges and vertices for the open Property panel.
  updateEdgeHighlights() {
    this.updatePickedHighlights();
    this.updateDimTag(); // (cleared when a Property panel or sketch opens)
    const mode = this.pickMode();
    const vp = this.viewport;
    if (mode === 'entity' || (this.pm?.feature?.type === 'moveBody' && this.pm.feature.mode === 'mates')) {
      const refs = (this.pm.feature.mates || []).flatMap((m) => [m.a, m.b]).filter(Boolean);
      const selected = refs.filter((r) => r.kind === 'edge').map((r) => vp.edgeIndexForPoint(r.p)).filter((i) => i >= 0);
      vp.setEdgeHighlights({ selected, hover: this.hoverEdge ?? null });
      vp.setVertexMarkers({ selected: refs.filter((r) => r.kind === 'vertex').map((r) => r.p), hover: this.hoverVertex ?? null });
      return;
    }
    if (mode === 'measure') {
      const picks = this.pm.picks || [];
      vp.setEdgeHighlights({ selected: picks.filter((r) => r.kind === 'edge').map((r) => vp.edgeIndexForPoint(r.p)).filter((i) => i >= 0), hover: this.hoverEdge ?? null });
      vp.setVertexMarkers({ selected: picks.filter((r) => r.kind === 'vertex').map((r) => r.p), hover: this.hoverVertex ?? null });
      return;
    }
    if (mode === 'revaxis') {
      const f = this.pm.feature;
      const selected = f.axis === 'edge' && f.axisEdge ? [vp.edgeIndexForPoint(f.axisEdge.p)].filter((i) => i >= 0) : [];
      vp.setEdgeHighlights({ selected, hover: this.hoverEdge ?? null });
      vp.setVertexMarkers(null);
      return;
    }
    if (mode === 'ref') {
      const refs = this.pm.feature.refs || [];
      const selected = refs.filter((r) => r.kind === 'edge').map((r) => vp.edgeIndexForPoint(r.p)).filter((i) => i >= 0);
      vp.setEdgeHighlights({ selected, hover: this.hoverEdge ?? null });
      vp.setVertexMarkers({ selected: refs.filter((r) => r.kind === 'vertex').map((r) => r.p), hover: this.hoverVertex ?? null });
      return;
    }
    if (!mode) {
      // no Property panel picking: show the selected / hovered edge or vertex
      const s = this.pm ? null : this.selection;
      const selEdge = this.measureSel.some((x) => x.kind === 'edge') ? this.measureSel.filter((x) => x.kind === 'edge').map((x) => x.index) : s?.kind === 'edge' ? [s.index] : [];
      vp.setEdgeHighlights(selEdge.length || this.hoverEdge != null ? { selected: selEdge, hover: this.hoverEdge ?? null } : null);
      vp.setVertexMarkers(s?.kind === 'vertex' || this.hoverVertex ? { selected: s?.kind === 'vertex' ? s.p : null, hover: this.hoverVertex ?? null } : null);
      return;
    }
    if (mode !== 'edge') vp.setEdgeHighlights(null);
    if (mode !== 'vertex') vp.setVertexMarkers(null);
    const f = this.pm.feature;
    if (mode === 'edge') {
      const refs = ['fillet','chamfer','smFlange','smHem','smProfileFlange','surfFill','surfPlanar'].includes(f.type) ? (f.edges || []) : f.edge ? [f.edge] : [];
      const selected = refs.map((e) => vp.edgeIndexForPoint(e.p)).filter((i) => i >= 0);
      vp.setEdgeHighlights({ selected, hover: this.hoverEdge ?? null });
      // (a variable fillet's points along its edges: where the panel puts them, so a drag moves them at once; else
      // where the last build put them)
      const fp = this.filletPoints(f);
      const pts = fp ? fp.filter(Boolean).map((x) => x.p) : null;
      vp.setVertexMarkers(pts?.length ? { selected: pts, hover: this._fpDrag ? pts[this._fpDrag.i] ?? null : null } : null);
    } else if (mode === 'vertex') {
      const two = f.type === 'extrude' && f.side2 && this.pm.extrudeSurfaceSlot === 'end2';
      if (f.type === 'chamfer' && f.chamferType === 'vertex') { vp.setVertexMarkers({ selected: (f.vertices || []).map((v) => v.p), hover: this.hoverVertex ?? null }); return; }
      const ref = f.type === 'extrude' ? (two ? f.toVertex2 : f.toVertex) : ['surfExtrude', 'revolve', 'surfRevolve', 'hole'].includes(f.type) ? f.toVertex : f.type === 'sketch3d' ? null : f.vertex;
      vp.setVertexMarkers({ selected: ref && !(two ? f.toPoint2 : f.toPoint) ? ref.p : null, hover: this.hoverVertex ?? null });
    }
  }

  // Faces and bodies picked into the open Property panel (shell faces, bodies to combine, ...).
  updatePickedHighlights() {
    const vp = this.viewport, f = this.pm?.kind === 'feature' ? this.pm.feature : null;
    const marks=[];
    if(f&&this.pickMode()==='ref')for(const [i,r] of (f.refs||[]).entries()){
      let p=r.kind==='vertex'?r.p:r.kind==='point'?this.result.points?.get(r.id)?.toArray():null;
      if(r.kind==='sketch'&&r.point){const s=this.result.sketches.get(r.sketch),q=s&&S.getPoint(s.sketch,r.point);if(q)p=G.toWorld(s.frame,q.x,q.y).toArray();}
      if(p)marks.push({p,text:String(i+1),cls:'pick'});
    }
    vp.setPointMarks('reference-picks',marks.length?marks:null);
    const infos = [];
    if (this.pm?.kind === 'measure') {
      for (const r of this.pm.picks) {
        if (r.kind === 'face') { const i = vp.faceIndexNear(r.p); if (i >= 0) infos.push(vp.faceInfo(i)); }
        if (r.kind === 'body') { const bi = vp.bodyIndexOf(r.id); if (bi >= 0) infos.push(vp.bodyInfo(bi)); }
      }
    }
    if (f) {
      if(['extrude','surfExtrude'].includes(f.type)&&f.startFrom==='surface'&&f.startFace){const i=vp.faceIndexNear(f.startFace.p);if(i>=0)infos.push(vp.faceInfo(i));}
      if(f.type==='extrude'&&f.side2&&['upToSurface','offsetSurface'].includes(f.end2)&&f.toFace2){const i=vp.faceIndexNear(f.toFace2.p);if(i>=0)infos.push(vp.faceInfo(i));}
      const faceRefs = [...(f.faces || []), ...(f.startFaces || []), ...(f.endFaces || []), ...(f.refs||[]).filter(r=>r.kind==='face'), ...(['extrude', 'revolve', 'surfExtrude', 'surfRevolve'].includes(f.type) ? (f.profiles || []).filter((r) => r?.kind === 'modelFace') : []), ...(f.type === 'moveBody' ? (f.mates || []).flatMap((m) => [m.a, m.b]).filter((r) => r?.kind === 'face') : [])];
      if (((f.type === 'axis' && f.axisType === 'cylinder') || f.type === 'thread' || f.type === 'cosmeticThread' || f.type === 'wrap') && f.face) faceRefs.push(f.face);
      if (f.axis === 'face' && f.axisFace) faceRefs.push(f.axisFace);
      if (['revolve', 'surfRevolve'].includes(f.type) && f.extent === 'upToSurface' && f.toFace) faceRefs.push(f.toFace);
      if (['sweep', 'surfSweep'].includes(f.type) && f.orientation === 'surface') faceRefs.push(...(f.supportFaces || []));
      if (f.type === 'shell') faceRefs.push(...(f.thickFaces || []));
      for (const r of faceRefs) { const i = vp.faceIndexNear(r.p); if (i >= 0) infos.push(vp.faceInfo(i)); }
      const ids = [...(f.bodies || []), f.main, f.body, ...(f.scopeAll === false ? f.scope || [] : [])].filter(Boolean);
      for (const id of new Set(ids)) { const bi = vp.bodyIndexOf(id); if (bi >= 0) infos.push(vp.bodyInfo(bi)); }
    }
    vp.setFaceSet(infos);
  }

  // A body clicked on the model or in the tree while a body-picking Property panel is open.
  pmPickBody(id) {
    const f = this.pm?.kind === 'feature' ? this.pm.feature : null;
    if (!f || !id) return false;
    const b = this.bodyById(id);
    const toggle = (list) => { const i = list.indexOf(id); if (i >= 0) list.splice(i, 1); else list.push(id); };
    if (f.type === 'combine') {
      if (b?.kind === 'surface') { this.toast('Only solid bodies can be combined'); return true; }
      if (!f.main || f.main === id) f.main = f.main === id ? null : id;
      else toggle(f.bodies);
    } else if (f.type === 'knit' || f.type === 'surfSolid' || f.type === 'meshRepair') {
      if (b?.kind !== 'surface') { this.toast(f.type === 'knit' ? 'Select surface bodies to knit' : 'Select surface bodies (a solid is already closed)'); return true; }
      toggle(f.bodies);
    } else if (f.type === 'thicken') {
      if (b?.kind !== 'surface') { this.toast('Select a surface body to thicken'); return true; }
      f.body = id;
    } else if (f.type === 'weldBead') {
      if (b?.kind === 'surface') { this.toast('Select solid bodies'); return true; }
      toggle(f.bodies);
    } else if (f.type === 'weldTrim') {
      if (!b?.member?.axis) { this.toast('Select straight structural members'); return true; }
      toggle(f.bodies);
    } else if (f.type === 'deleteBody' || f.type === 'deleteSurface') {
      if (f.type === 'deleteSurface' && b?.kind !== 'surface') { this.toast('Select surface bodies (use Delete Body for solids)'); return true; }
      toggle(f.bodies);
    } else if (['extrude','revolve','sweep'].includes(f.type) && (f.op === 'cut' || f.op === 'intersect') && f.scopeAll === false) {
      if (b?.kind === 'surface') { this.toast('Cuts only act on solid bodies'); return true; }
      f.scope = Array.isArray(f.scope) ? f.scope : [];
      toggle(f.scope);
    } else if (['smCornerRelief', 'smClosedCorner', 'smFold'].includes(f.type)) {
      if (!b?.sheet) { this.toast('Select a sheet metal body'); return true; }
      f.body = f.body === id ? null : id;
    } else if (['lpattern', 'cpattern', 'mirror', 'spattern', 'curvePattern'].includes(f.type)) {
      f.bodies = Array.isArray(f.bodies) ? f.bodies : [];
      toggle(f.bodies);
    } else if (f.type === 'moveBody' || f.type === 'split') {
      if (f.type === 'split' && b?.kind === 'surface') { f.tool = id; f.toolFace = null; }
      else toggle(f.bodies);
    } else return false;
    this.ui.renderPM();
    this.updateEdgeHighlights();
    this.preview();
    return true;
  }

  // Put a picked entity into the active mate slot, then move on to the next empty slot.
  pmPickMate(ref) {
    const f = this.pm.feature, slot = this.pm.mateSlot;
    if (!slot || !f.mates[slot.i]) return false;
    f.mates[slot.i][slot.which] = ref;
    const m = f.mates[slot.i];
    this.pm.mateSlot = slot.which === 'a' && !m.b ? { i: slot.i, which: 'b' } : null;
    this.ui.renderPM();
    this.updateEdgeHighlights();
    this.preview();
    return true;
  }

  // Reference axes and points: drawn in the view, orange while being edited.
  updateRefGeometry() {
    const res = this.result;
    const editing = this.pm?.kind === 'feature' ? this.pm.feature.id : null;
    const sel = this.selection?.kind === 'feature' ? this.selection.id : null;
    const sweep = this.pm?.kind === 'feature' && ['sweep','surfSweep'].includes(this.pm.feature.type) ? this.pm.feature : null;
    const datumRefs=new Set(this.pm?.feature?.referenceDefinition?(this.pm.feature.refs||[]).filter(r=>r.id).map(r=>r.id):[]);
    const state = (id) => (id === editing || id === sweep?.guide ? 'preview' : id === sel || id === this._hoverFeature || id === sweep?.path || datumRefs.has(id) ? 'selected' : 'normal');
    const axes = [], points = [];
    for (const f of this.doc.features) {
      if (f.suppressed || this.mode === 'sketch') continue;
      const st = state(f.id);
      if (f.type === 'axis' && res.axes?.has(f.id) && (this.refShown(f) || st !== 'normal')) axes.push({ id: f.id, name: f.name, ...res.axes.get(f.id), state: st });
      if (f.type === 'point' && res.points?.has(f.id) && (this.refShown(f) || st !== 'normal')) points.push({ id: f.id, name: f.name, p: res.points.get(f.id), state: st });
    }
    const curves = [];
    for (const f of this.doc.features) {
      if (f.suppressed || this.mode === 'sketch' || !res.curves?.has(f.id)) continue;
      if (this.mode === 'sketch3d' && this.sketch3d.f === f) continue;
      const st = state(f.id);
      const cv = res.curves.get(f.id), many = Array.isArray(cv?.[0]?.[0]); // (some curves are several pieces)
      const shown = this.refVisKind(f) ? this.refShown(f) : this.vis.axes;
      if (shown || st !== 'normal') for (const pts of many ? cv : [cv]) curves.push({ id: f.id, name: f.name, pts, state: st });
      // a 3D sketch being edited: its points, numbered
      if (f.type === 'sketch3d' && st === 'preview') (res.detected?.get(f.id)?.pts || []).forEach((p, i) => points.push({ id: f.id + ':' + i, name: 'P' + (i + 1), p: new THREE.Vector3(...p), state: 'preview' }));
    }
    // cosmetic threads: a helix just off the bore / shaft (at most 60 turns drawn)
    const threads = [];
    for (const f of this.doc.features) {
      const list = !f.suppressed && this.mode !== 'sketch' && res.threads?.get(f.id);
      if (!list) continue;
      const st = state(f.id);
      for (const t of list) {
        const d = new THREE.Vector3(...t.d).normalize(), o = new THREE.Vector3(...t.o);
        const u = new THREE.Vector3().crossVectors(d, Math.abs(d.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize(), w = new THREE.Vector3().crossVectors(d, u);
        const r = t.r * (t.internal ? 0.985 : 1.015), turns = Math.min(60, t.len / t.P), n = Math.max(8, Math.ceil(turns * 24));
        const pts = [];
        for (let i = 0; i <= n; i++) {
          const s = i / n, a = s * turns * 2 * Math.PI * (t.label.endsWith(' LH') ? -1 : 1);
          pts.push(o.clone().addScaledVector(d, s * t.len).addScaledVector(u, r * Math.cos(a)).addScaledVector(w, r * Math.sin(a)).toArray());
        }
        threads.push({ pts, state: st });
      }
    }
    this.viewport.setRefGeometry(axes, points, curves, threads);
  }


  // A sketch is shown unless it is hidden; a sketch used by a feature is hidden unless shown.
  sketchShown(f) {
    return f.visible === true || (f.visible !== false && !this.result?.consumed?.has(f.id));
  }

  setSketchVisible(id, on) {
    const f = M.findFeature(this.doc, id);
    if (!f) return;
    f.visible = on;
    this.commit();
    this.updateSketchDisplay();
    this.ui.renderTree();
  }

  updateSketchDisplay() {
    const res = this.result, list = [];
    const loft = this.loftPicking(), loftFeature = loft ? this.pm.feature : null;
    const sweepFeature = this.pm?.kind === 'feature' && ['sweep','surfSweep'].includes(this.pm.feature.type) ? this.pm.feature : null;
    if (!loft) this._loftPickCache = null;
    // Dependent sketches still contain the last rebuilt projections while their source is being edited.
    // Hide that stale geometry until leaving the sketch rebuilds it; keep independent references visible.
    const editing = this.mode === 'sketch' ? this.sketcher.f?.id : null;
    const referencePicking = editing && ['convert', 'intersect'].includes(this.sketcher.tool);
    const stale = new Set(editing ? [editing] : []);
    if (editing) {
      const refs = this.doc.features.map((f) => [f.id, M.referencesOf(this.doc, f)]);
      let changed;
      do {
        changed = false;
        for (const [id, dependencies] of refs) if (!stale.has(id) && [...dependencies].some((r) => stale.has(r))) { stale.add(id); changed = true; }
      } while (changed);
    }
    for (const [id, s] of res.sketches) {
      if (stale.has(id)) continue;
      if(referencePicking&&(this.sketcher.projectionSource==='model'||this.sketcher.projectionSource?.startsWith('sketch:')&&id!==this.sketcher.projectionSource.slice(7)))continue;
      const pmSketch = this.pm?.kind === 'feature' && (this.pm.feature.sketch === id || (['revolve','surfRevolve'].includes(this.pm.feature.type)&&this.pm.profilePick===false&&this.doc.features.findIndex(f=>f.id===id)<this.doc.features.indexOf(this.pm.feature)));
      const selected = (this.selection?.kind === 'feature' && this.selection.id === id) || this.hoverSketchId === id;
      const datumPicking=this.pickMode()==='ref'&&this.doc.features.findIndex(f=>f.id===id)<this.doc.features.indexOf(this.pm.feature);
      if ((this.vis.sketches && this.sketchShown(s.sketch)) || pmSketch || selected || loft || datumPicking || (referencePicking && this.doc.features.findIndex((f) => f.id === id) < this.doc.features.findIndex((f) => f.id === editing))) {
        const polylines = s.sketch.curves.filter((c) => !loft || !c.ctrlOf).map((c) => ({ pts: S.curvePoints(s.sketch, c), construction: c.construction }));
        for (const polys of Object.values(s.textPolys || {})) for (const pts of polys) polylines.push({ pts, construction: false });
        if (s.sketch.gearTrains?.length) for (const pts of S.gearPolylines(s.sketch)) polylines.push({ pts, construction: false });
        if (s.sketch.airfoils?.length) for (const pts of S.airfoilPolylines(s.sketch)) polylines.push({ pts, construction: false });
        list.push({ frame: s.frame, polylines, highlight: pmSketch || selected,...(referencePicking?{color:0x94a3b8,reference:true}:{}) });
      }
    }
    // sketch entities picked for the dimension readout, and a reference plane's sketch references
    const picked = this.mode === 'sketch' ? [] : this.measureSel.filter((x) => x.kind === 'skcurve');
    if (this.pm?.kind === 'feature' && ['plane','axis','point'].includes(this.pm.feature.type)) for (const r of this.pm.feature.refs || []) if (r.kind === 'sketch' && r.curve) picked.push({ sketch: r.sketch, curve: r.curve });
    for (const x of picked) {
      const s = res.sketches.get(x.sketch), c = s && S.getCurve(s.sketch, x.curve);
      if (c) list.push({ frame: s.frame, polylines: [{ pts: S.curvePoints(s.sketch, c), construction: false }], highlight: true, color: 0xf97316 });
    }
    const tags = [];
    if (loft || sweepFeature) {
      const show = (ref, color, label = '') => {
        const s = res.sketches.get(LR.sourceId(ref));
        if (!s) {
          const cv = res.curves?.get(ref), pts = Array.isArray(cv?.[0]?.[0]) ? cv[0] : cv;
          if (label && pts?.length) tags.push({ text: label, at: new THREE.Vector3(...pts[0]), color });
          return;
        }
        const ids = typeof ref === 'string' ? null : new Set(ref.curves);
        const curves = s.sketch.curves.filter((c) => !c.ctrlOf && (ids ? ids.has(c.id) : !c.construction));
        list.push({ frame: s.frame, polylines: curves.map((c) => ({ pts: S.curvePoints(s.sketch, c), construction: false })), highlight: true, color });
        if (label && curves.length) {
          const p = S.curvePoints(s.sketch, curves[0])[0];
          tags.push({ text: label, at: G.toWorld(s.frame, p[0], p[1]), color });
        }
      };
      if (loft && !sweepFeature) {
        (loftFeature.profiles || []).forEach((r, i) => show(r, 0x0ea5e9, `Profile ${i + 1}`));
        (loftFeature.guides || []).forEach((r, i) => show(r, 0xf97316, `Guide ${i + 1}`));
        if (this.pm.loftDraft?.curves.length) show(this.pm.loftDraft, 0x16a34a);
        if (this.pm.loftHover) show(this.pm.loftHover, 0xfacc15);
      } else {
        if (sweepFeature.profileType !== 'circle') show(sweepFeature.profile, 0x0ea5e9, 'Profile');
        show(sweepFeature.path, 0x8b5cf6, 'Path');
        if (sweepFeature.guide) show(sweepFeature.guide, 0xf97316, 'Guide');
        if (this.pm.loftDraft?.curves.length) show(this.pm.loftDraft,0x16a34a);
        if (this.pm.loftHover) show(this.pm.loftHover,0xfacc15);
      }
    }
    this.viewport.setSketches(list);
    this.viewport.setLoftTags(tags);
    this.viewport.setLoftConnections(this.loftConnectionGraph(),this.pm?.loftConnector?.index??-1);
  }

  updatePlanes() {
    const list = [];
    if (this.mode !== 'sketch') {
      const sel = this.selection?.kind === 'plane' ? this.selection.id : this.selection?.kind === 'feature' ? this.selection.id : null;
      const pmPlanes = new Set();
      if (this.pm?.kind === 'feature') {
        const f = this.pm.feature;
        if(f.type==='extrude'){if(f.startFrom==='surface'&&f.startPlane)pmPlanes.add(f.startPlane);if(['upToSurface','offsetSurface'].includes(f.end)&&f.toPlane)pmPlanes.add(f.toPlane);if(f.side2&&['upToSurface','offsetSurface'].includes(f.end2)&&f.toPlane2)pmPlanes.add(f.toPlane2);}
        if (['plane','axis','point'].includes(f.type)) for (const r of f.refs || []) if (r.kind === 'plane') pmPlanes.add(r.id);
        if (f.type === 'mirror') pmPlanes.add(f.plane);
      }
      const picking = this.pm?.kind === 'selectPlane' || this.pickMode()==='ref';
      const editing = this.pm?.kind === 'feature' && this.pm.feature.type === 'plane' ? this.pm.feature.id : null;
      const state = (id) => (id === editing ? 'preview' : sel === id || pmPlanes.has(id) ? 'selected' : this.hoverPlane === id ? 'hover' : 'normal');
      for (const key of Object.keys(G.STD_PLANES)) {
        if (picking || this.stdPlaneShown(key) || sel === key || this.hoverPlane === key || pmPlanes.has(key)) list.push({ id: key, name: G.STD_PLANES[key].name, frame: G.stdFrame(key), state: state(key) });
      }
      for (const f of this.doc.features) {
        if (f.type !== 'plane' || f.suppressed) continue;
        const fr = this.result.planes.get(f.id);
        const st = state(f.id);
        if (fr && (this.refShown(f) || st !== 'normal' || this.pm?.kind === 'selectPlane')) list.push({ id: f.id, name: f.name, frame: fr, state: st,displayAnchor:this.result.info?.[f.id]?.datumAnchor });
      }
    }
    this.viewport.setPlanes(list);
  }

  // ------------------------------------------------------------ selection
  select(sel) {
    this.selection = sel;
    this.updateSelectionHighlight();
    this.updatePlanes();
    this.updateRefGeometry();

    this.updateSketchDisplay();
    this.ui.renderTree();
    this.ui.refreshCommandStates();
    const bodyOf = (bi) => this.result?.bodies?.[bi]?.name;
    if (sel?.kind === 'body') this.status(`${this.bodyById(sel.id)?.name || 'Body'} selected. Right-click for Body Properties or Export Body as STEP.`);
    else if (sel?.kind === 'edge') this.status(`Edge selected (${bodyOf(sel.body) || 'body'}). Right-click to fillet or chamfer it.`);
    else if (sel?.kind === 'skcurve') this.status('Sketch entity selected.');
    else if (sel?.kind === 'vertex') this.status(`Vertex selected at (${sel.p.map((x) => +x.toFixed(3)).join(', ')}) mm.`);
    else if (sel?.kind === 'face') this.status(sel.face.planar ? 'Face selected. Click Sketch to sketch on it, Normal To to look at it, or right-click ▸ Export Face as DXF.' : 'Face selected.');
    else if (sel?.kind === 'plane') this.status(`${G.STD_PLANES[sel.id]?.name || 'Plane'} selected. Click Sketch to start a sketch on it.`);
    else if (sel?.kind === 'feature') {
      const f = M.findFeature(this.doc, sel.id);
      this.status(f ? `${f.name} selected` + (this.result.errors.get(f.id) ? ` — ${this.result.errors.get(f.id)}` : '') : 'Ready');
    } else this.status('Ready');
  }

  // An edge or sketch curve clicked: on its own, or (Ctrl) added to / taken from those picked before;
  // the quick readout shows its size, or the total length of them all.
  pickForReadout(item, add) {
    const same = (x) => x.kind === item.kind && (x.kind === 'edge' ? x.index === item.index : x.kind === 'face' ? x.gi === item.gi : x.sketch === item.sketch && x.curve === item.curve);
    // (lengths go with lengths, faces with faces: Ctrl+click on the other kind starts again)
    const family = (x) => (x.kind === 'face' ? 'face' : 'len');
    if (add && this.measureSel.every((x) => family(x) === family(item))) {
      const i = this.measureSel.findIndex(same);
      if (i >= 0) this.measureSel.splice(i, 1); else this.measureSel.push(item);
    } else this.measureSel = [item];
    const last = this.measureSel[this.measureSel.length - 1];
    const vp = this.viewport;
    this.select(!last ? null : last.kind === 'face' ? { kind: 'face', face: vp.faceInfo(last.gi), point: last.p, body: last.body } : { ...last });
  }

  // The quick dimension readout: one edge / curve's length (and radius or diameter), or the total of several.
  async updateDimTag() {
    const vp = this.viewport, s = this.selection;
    if (this.mode !== 'part' || this.pm || !s || !['edge', 'skcurve', 'face'].includes(s.kind)) this.measureSel = [];
    const items = this.measureSel;
    const key = items.map((x) => (x.kind === 'edge' ? 'e' + x.index : x.kind === 'face' ? 'f' + x.gi : x.sketch + '/' + x.curve)).join(' ') + '|' + (this.result?.body?.key ?? '');
    if (key === this._dimKey) return;
    this._dimKey = key;
    // several faces: all of them highlighted (one face: the normal selection highlight)
    const faceItems = items.filter((x) => x.kind === 'face');
    vp.setFaceSet(faceItems.length > 1 ? faceItems.map((x) => vp.faceInfo(x.gi)).filter(Boolean) : null, 'measure');
    if (!items.length) { vp.setDimTag(null); return; }
    if (faceItems.length) return this.faceReadout(faceItems, key);
    let infos;
    try { infos = await Promise.all(items.map((x) => this.readoutOf(x))); } catch { infos = null; }
    if (key !== this._dimKey) return; // (a newer pick came in meanwhile)
    if (!infos || infos.some((x) => !x)) { vp.setDimTag(null); return; }
    const mm = (x) => `${+x.toFixed(3)} mm`;
    let html, text;
    if (infos.length === 1) {
      const d = infos[0];
      if (d.type === 'circle') { html = `<b>Ø ${mm(2 * d.r)}</b> <span class="sub">· circumference ${mm(d.length)}</span>`; text = `Ø ${mm(2 * d.r)}, circumference ${mm(d.length)}`; }
      else if (d.type === 'arc') { html = `<b>R ${mm(d.r)}</b> <span class="sub">· length ${mm(d.length)}</span>`; text = `R ${mm(d.r)}, length ${mm(d.length)}`; }
      else { html = `<b>${mm(d.length)}</b>`; text = `Length ${mm(d.length)}`; }
    } else {
      // closed: every open end meets another (the edges go round, e.g. a face's outline)
      const ends = infos.filter((d) => !d.closed).flatMap((d) => [d.a, d.b]);
      const tol = 1e-3;
      const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < tol;
      const closed = ends.every((p, i) => ends.some((q, j) => j !== i && near(p, q)));
      const total = infos.reduce((t, d) => t + d.length, 0);
      const what = closed ? 'Perimeter' : 'Total length';
      html = `<b>${what} ${mm(total)}</b> <span class="sub">· ${infos.length} ${items.every((x) => x.kind === 'edge') ? 'edges' : items.every((x) => x.kind === 'skcurve') ? 'sketch entities' : 'items'}</span>`;
      text = `${what} ${mm(total)} (${infos.length} selected)`;
    }
    const at = items[items.length - 1].kind === 'edge' ? items[items.length - 1].p : items[items.length - 1].at;
    vp.setDimTag({ at, html });
    this.status(`${text}${items.length === 1 ? ' · Ctrl+click more edges or sketch entities for their total length' : ''}`);
  }

  // Faces: one face's area (and diameter when round); two faces: parallel (and how far apart),
  // perpendicular, or the angle between them (flat faces exactly from their planes; otherwise the
  // nearest distance, the centre distance of two round faces and any angle); more: their total area.
  async faceReadout(items, key) {
    await null; // (after the selection's own status message, which this one replaces)
    const vp = this.viewport;
    const ref = (x) => { const fi = vp.faceInfo(x.gi); return { kind: 'face', p: x.p, ...(fi?.planar ? { n: fi.normal.toArray() } : {}), ...(this.result.bodies?.[x.body]?.id ? { body: this.result.bodies[x.body].id } : {}) }; };
    const mm = (x) => `${+x.toFixed(3)} mm`, deg = (x) => `${+x.toFixed(3)}°`, mm2 = (x) => `${+x.toFixed(2)} mm²`;
    let html, text;
    try {
      if (items.length === 2) {
        const [A, B] = items.map((x) => vp.faceInfo(x.gi));
        if (A?.planar && B?.planar) {
          const c = Math.min(1, Math.abs(A.normal.dot(B.normal))), ang = (Math.acos(c) * 180) / Math.PI;
          if (ang < 0.01) {
            const gap = Math.abs(B.center.clone().sub(A.center).dot(A.normal));
            html = gap < 1e-6 ? '<b>Parallel · in one plane</b>' : `<b>Parallel · ${mm(gap)} apart</b>`;
            text = gap < 1e-6 ? 'Parallel faces, in one plane' : `Parallel faces, ${mm(gap)} apart`;
          } else if (Math.abs(ang - 90) < 0.01) { html = '<b>Perpendicular · 90°</b>'; text = 'Perpendicular faces (90°)'; }
          else { html = `<b>Angle ${deg(ang)}</b> <span class="sub">· (${deg(180 - ang)} the other way)</span>`; text = `Angle between the faces ${deg(ang)}`; }
        } else {
          const r = await this.kernel.request('measure', { refs: items.map(ref) });
          const parts = [];
          // (two round faces: the distance between their axes says it; otherwise the nearest points)
          if (r.centerDistance != null) parts.push(`centre distance ${mm(r.centerDistance)}`);
          else if (r.distance != null) parts.push(`nearest ${mm(r.distance)}`);
          if (r.angle != null) parts.push(Math.abs(r.angle) < 0.01 ? 'parallel' : Math.abs(r.angle - 90) < 0.01 ? 'perpendicular (90°)' : `angle ${deg(r.angle)}`);
          html = `<b>${parts[0] ? parts[0][0].toUpperCase() + parts[0].slice(1) : 'Two faces'}</b>${parts.length > 1 ? ` <span class="sub">· ${parts.slice(1).join(' · ')}</span>` : ''}`;
          text = parts.join(', ');
        }
      } else {
        const infos = await Promise.all(items.map((x) => this.kernel.request('measure', { refs: [ref(x)] }).then((r) => r.items[0])));
        if (items.length === 1) {
          const d = infos[0];
          html = `<b>Area ${mm2(d.area)}</b>${d.radius ? ` <span class="sub">· Ø ${mm(2 * d.radius)}</span>` : ''}`;
          text = `Face area ${mm2(d.area)}${d.radius ? `, Ø ${mm(2 * d.radius)}` : ''} · Ctrl+click a second face for the distance or angle between them`;
        } else {
          const total = infos.reduce((t, d) => t + d.area, 0);
          html = `<b>Total area ${mm2(total)}</b> <span class="sub">· ${items.length} faces</span>`;
          text = `Total area ${mm2(total)} (${items.length} faces)`;
        }
      }
    } catch { html = null; }
    if (key !== this._dimKey) return; // (a newer pick came in meanwhile)
    if (!html) { vp.setDimTag(null); return; }
    vp.setDimTag({ at: items[items.length - 1].p, html });
    this.status(text);
  }

  // Size of one edge (measured by the kernel, kept for the current model) or sketch curve:
  // { type: line | arc | circle | other, length, r, closed, a, b (ends) }.
  async readoutOf(x) {
    if (x.kind === 'skcurve') {
      const s = this.result.sketches.get(x.sketch), c = s && S.getCurve(s.sketch, x.curve);
      if (!c) return null;
      const w = (id) => { const q = S.getPoint(s.sketch, id); return G.toWorld(s.frame, q.x, q.y).toArray(); };
      if (c.type === 'line') { const a = w(c.p1), b = w(c.p2); return { type: 'line', length: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), a, b }; }
      if (c.type === 'circle') return { type: 'circle', r: c.r, length: 2 * Math.PI * c.r, closed: true };
      const { span, r } = S.arcAngles(s.sketch, c);
      return { type: 'arc', r, length: r * span, a: w(c.p1), b: w(c.p2) };
    }
    const key = `${this.result?.body?.key}|${x.index}`;
    this._edgeInfo ||= new Map();
    if (!this._edgeInfo.has(key)) {
      this._edgeInfo.set(key, this.kernel.request('measure', { refs: [{ kind: 'edge', p: x.p }] }).then((r) => {
        const it = r.items[0], e = this.viewport.edgeList?.[x.index];
        const a = e?.pts[0], b = e?.pts[e.pts.length - 1];
        const closed = !!(a && b && a.distanceTo(b) < 1e-6);
        return { type: it.curve === 'circle' || it.curve === 'arc' ? it.curve : it.curve === 'line' ? 'line' : 'other', length: it.length, r: it.radius, closed, a: a?.toArray(), b: b?.toArray() };
      }));
    }
    return this._edgeInfo.get(key);
  }

  updateSelectionHighlight() {
    const s = this.selection, vp = this.viewport;
    this.highlightFeature(s?.kind === 'feature' ? s.id : null, 'featureSel');
    const info = s?.kind === 'face' ? s.face : s?.kind === 'body' ? vp.bodyInfo(vp.bodyIndexOf(s.id)) : null;
    vp.setFaceHighlight('select', info && (s.kind === 'body' || s.xray) ? { ...info, xray: true } : info);
    this.updateEdgeHighlights();
  }

  // ------------------------------------------------------------ selection filter
  // Empty filter: vertices, edges, faces and planes are picked (whichever is under the cursor,
  // in that order); bodies are picked from the tree, or with the body filter on.
  allows(kind) { return this.filters.size ? this.filters.has(kind) : kind !== 'body'; }

  toggleFilter(kind) {
    if (kind === 'clear') this.filters.clear();
    else if (this.filters.has(kind)) this.filters.delete(kind);
    else this.filters.add(kind);
    const names = { face: 'Faces', edge: 'Edges', vertex: 'Vertices', body: 'Bodies', plane: 'Planes' };
    this.status(this.filters.size ? `Selection filter: ${[...this.filters].map((k) => names[k]).join(', ')} only` : 'Selection filter cleared — anything can be selected');
    if (this.selection && ['face', 'edge', 'vertex', 'body'].includes(this.selection.kind) && !this.allows(this.selection.kind)) this.select(null);
    this.ui.renderHUD();
  }

  pickEntity(e) {
    const vp = this.viewport;
    if (this.allows('vertex')) { const v = vp.pickVertex(e, 7); if (v) return { kind: 'vertex', p: v.point.toArray() }; }
    if (this.allows('edge')) { const ed = vp.pickEdge(e, 5); if (ed) return { kind: 'edge', index: ed.index, edge: ed.edge }; }
    const fh = this.faceAt(e);
    if (fh && this.allows('face')) return { kind: 'face', hit: fh.hit };
    if (fh && this.allows('body')) return { kind: 'body', hit: fh.hit, index: vp.faceBody[fh.hit.face] };
    if (this.allows('plane')) { const ph = vp.pickPlane(e); if (ph) return { kind: 'plane', id: ph.id }; }
    return null;
  }

  // Select whatever the filter allows under the cursor (part mode, no Property panel open).
  selectAt(e) {
    const p = this.pickEntity(e), vp = this.viewport, ctrl = e.ctrlKey || e.metaKey;
    // a sketch curve shown in the view (drawn over the model, so before faces)
    if (this.allows('edge') && (!p || !['edge', 'vertex'].includes(p.kind))) {
      const sc = this.sketchCurveAt(e);
      if (sc) return this.pickForReadout({ kind: 'skcurve', ...sc }, ctrl);
    }
    if (p?.kind === 'edge') return this.pickForReadout({ kind: 'edge', index: p.index, p: p.edge.mid, body: vp.edgeBody[p.index] }, ctrl);
    if (p?.kind === 'face') return this.pickForReadout({ kind: 'face', gi: p.hit.face, p: p.hit.point.toArray(), body: vp.faceBody[p.hit.face] }, ctrl);
    if (ctrl && this.measureSel.length) return; // (Ctrl+click on something else keeps what was picked so far)
    if (!p) return this.select(null);
    if (p.kind === 'plane') return G.STD_PLANES[p.id] ? this.treePickPlane(p.id) : this.treePickFeature(p.id);
    if (p.kind === 'body') return this.select({ kind: 'body', id: this.result.bodies[p.index]?.id });
    if (p.kind === 'edge') return this.select({ kind: 'edge', index: p.index, p: p.edge.mid, body: vp.edgeBody[p.index] });
    return this.select({ kind: 'vertex', p: p.p });
  }

  hoverAt(e) {
    const vp = this.viewport, p = this.pickEntity(e);
    const he = p?.kind === 'edge' ? p.index : null, hv = p?.kind === 'vertex' ? p.p : null;
    if (he !== this.hoverEdge || String(hv) !== String(this.hoverVertex)) {
      this.hoverEdge = he;
      this.hoverVertex = hv;
      this.updateEdgeHighlights();
    }
    const key = p?.kind === 'face' ? 'f' + p.hit.face : p?.kind === 'body' ? 'b' + p.index : null;
    if (key !== this.hoverFaceKey) {
      this.hoverFaceKey = key;
      vp.setFaceHighlight('hover', p?.kind === 'face' ? vp.faceInfo(p.hit.face) : p?.kind === 'body' ? vp.bodyInfo(p.index) : null);
    }
    if (p?.kind === 'plane') this.setHoverPlane(p.id);
    else if (this.hoverPlane && !this._treeHover) this.setHoverPlane(null);
    vp.canvas.style.cursor = p ? 'pointer' : 'default';
  }

  // ------------------------------------------------------------ bodies
  selectBody(id) {
    if (this.pickMode() === 'body' && this.pmPickBody(id)) return;
    this.select({ kind: 'body', id });
  }

  setHoverBody(id) {
    const vp = this.viewport;
    vp.setFaceHighlight('hover', id ? vp.bodyInfo(vp.bodyIndexOf(id)) : null);
    this.hoverFaceKey = null;
  }

  // Store a body's settings (name, material, description, custom properties).
  updateBody(id, data) {
    Object.assign(M.ensureBodySettings(this.doc, id), data);
    this.commit();
    this.refresh();
  }

  // Name and colour of each body for STEP export.
  exportInfo() {
    const info = {};
    // OpenCascade takes linear RGB and writes sRGB to the STEP file, so pass the linear value
    const hex = (c) => {
      const col = new THREE.Color(c); // three.js converts the sRGB hex to linear components
      return '#' + [col.r, col.g, col.b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
    };
    for (const b of this.result?.bodies || []) info[b.id] = { name: b.name, color: hex(b.kind === 'surface' ? M.SURFACE_COLOR : b.material?.color ?? M.DEFAULT_BODY_COLOR) };
    return info;
  }

  async exportBodySTEP(id) {
    const b = this.bodyById(id);
    if (!b) { this.toast('That body no longer exists', true); return; }
    try {
      this.status(`Exporting ${b.name} as STEP…`);
      const bytes = await this.withProgress(`Exporting ${b.name}…`, () => this.kernel.exportBody('step', id, this.exportInfo()));
      const file = (b.name.replace(/[^\w\- \[\]]+/g, '_') || 'Body') + '.step';
      const path = await platform.saveBinary(file, bytes, 'step');
      this.status(path ? 'Exported ' + String(path).split(/[\\/]/).pop() : 'Ready');
    } catch (err) {
      this.toast('Export failed: ' + err.message, true);
    }
  }

  // When a Property panel is open, clicking things in the tree/viewport fills its selection fields.
  pmPick(kind, id) {
    if (this.pm?.kind !== 'feature') return false;
    const f = this.pm.feature;
    if (id === f.id) return false;
    const before = this.doc.features.indexOf(f);
    const target = M.findFeature(this.doc, id);
    if (target && before >= 0 && this.doc.features.indexOf(target) > before) return false; // only earlier references
    if (this.loftPicking() && kind === 'sketch') {
      if (f.type === 'extrude') {
        f.profiles ||= [];
        f.profiles = f.profiles.filter((r) => LR.sourceId(r) !== id || typeof r === 'string');
        if (!f.profiles.includes(id)) f.profiles.push(id);
        if (S.isOpenSketch(target)) f.thin = true;
        this.preview(true); this.updateSketchDisplay(); return true;
      }
      this.hoverSketchId = id; this.updateSketchDisplay();
      this.status('Select the desired contour in the canvas; a sketch can contain several profiles or guides.');
      return true;
    }
    if(kind==='sketch'&&['revolve','surfExtrude','surfRevolve'].includes(f.type)){
      this.hoverSketchId=id;this.updateSketchDisplay();this.status('Use Select profiles in canvas to pick a contour, or Select axis in canvas to pick an axis line.');return true;
    }
    if (['loft', 'surfLoft'].includes(f.type) && kind === 'axis' && this.pm.loftEndAxis) { f[this.pm.loftEndAxis] = id; this.preview(true); return true; }
    if(f.referenceDefinition&&['plane','point'].includes(f.type)&&f.pointType!=='coords'&&target&&['helix','sketch3d','compCurve','projCurve'].includes(target.type)){this.togglePlaneRef({kind:'curve',id});return true;}
    // two-slot fields (axis from two planes / two points) fill alternately
    const slot = (a, b) => { const k = this.pm.slot === a ? b : a; this.pm.slot = k; return k; };
    if ((f.type === 'plane'||f.referenceDefinition&&['axis','point'].includes(f.type)&&f.pointType!=='coords') && (kind === 'plane' || kind === 'point' || kind === 'axis')) {
      this.togglePlaneRef({ kind, id });
      return true;
    }
    if (f.type === 'moveBody' && f.mode === 'mates' && this.pm.mateSlot && ['plane', 'axis', 'point'].includes(kind)) return this.pmPickMate({ kind, id });
    let key = null;
    if (kind === 'plane' && f.type === 'split') { f.toolFace = null; f.tool = id; this.preview(true); return true; }
    if (kind === 'axis' && f.type === 'moveBody' && f.mode !== 'mates') { f.rotAxis = id; this.preview(true); return true; }
    if (kind === 'plane') {
      if (f.type === 'mirror') key = 'plane';
      else if(['extrude','surfExtrude'].includes(f.type)&&f.startFrom==='surface'&&this.pm.extrudeSurfaceSlot==='start'){key='startPlane';f.startFace=null;}
      else if(f.type==='extrude'&&f.side2&&this.pm.extrudeSurfaceSlot==='end2'&&['upToSurface','offsetSurface'].includes(f.end2)){key='toPlane2';f.toFace2=null;}
      else if (['extrude', 'surfExtrude'].includes(f.type) && (f.end === 'upToSurface' || f.end === 'offsetSurface')) { key = 'toPlane'; f.toFace = null; }
      else if (['revolve', 'surfRevolve'].includes(f.type) && f.extent === 'upToSurface' && this.pm.revolveEndPick) { key = 'toPlane'; f.toFace = null; }
      else if (f.type === 'hole' && ['upToSurface', 'offsetSurface'].includes(f.end)) { key = 'toPlane'; f.toFace = null; }
      else if (f.type === 'axis' && f.axisType === 'twoPlanes') key = slot('planeA', 'planeB');
    } else if (kind === 'point') {
      if (f.type === 'extrude' && f.side2 && this.pm.extrudeSurfaceSlot === 'end2' && f.end2 === 'upToVertex') { key = 'toPoint2'; f.toVertex2 = null; }
      else if (['extrude', 'surfExtrude'].includes(f.type) && f.end === 'upToVertex') { key = 'toPoint'; f.toVertex = null; }
      else if (['revolve', 'surfRevolve'].includes(f.type) && f.extent === 'upToVertex' && this.pm.revolveEndPick) { key = 'toPoint'; f.toVertex = null; }
      else if (f.type === 'hole' && f.end === 'upToVertex') { key = 'toPoint'; f.toVertex = null; }
      else if (f.type === 'axis' && f.axisType === 'twoPoints') key = slot('pointA', 'pointB');
    } else if (kind === 'axis') {
      if (['cpattern','revolve','surfRevolve'].includes(f.type)) { key = 'axis'; if(['revolve','surfRevolve'].includes(f.type))this.pm.profilePick=false; }
      else if (f.type === 'lpattern') key = 'dir1';
    } else if (kind === 'sketch' && f.type === 'loft') {
      f.profiles = Array.isArray(f.profiles) ? f.profiles : [];
      if (!f.profiles.includes(id)) f.profiles.push(id); else f.profiles = f.profiles.filter((x) => x !== id);
      this.preview(true);
      return true;
    } else if (['sweep','surfSweep'].includes(f.type) && target && ['sketch','sketch3d','helix','compCurve','projCurve'].includes(target.type)) {
      if(kind==='sketch'){this.hoverSketchId=id;this.updateSketchDisplay();this.status('Activate a sweep slot and select its contour in the canvas.');return true;}
      return this.setSweepReference(id,this.pm.sweepSlot||(f.profileType==='circle'?'path':'profile'));
    } else {
      const fields = { sketch: ['extrude', 'revolve', 'surfExtrude', 'surfRevolve', 'surfPlanar', 'helix', 'wrap'], feature: ['lpattern', 'cpattern', 'mirror'] };
      if (fields[kind]?.includes(f.type)) key = kind;
    }
    if (!key) return false;
    if (['sweep','surfSweep'].includes(f.type)) {
      const profile = f.profileType === 'circle' ? null : f.profile;
      if (key === 'guide' && [f.path,profile].includes(id) || key === 'path' && f.guide === id || key === 'profile' && [f.path,f.guide].includes(id)) return false;
    }
    f[key] = id;
    this.preview(true);
    return true;
  }

  // a standard plane's or a reference plane's frame and name (null: not a plane, or it failed)
  planeFrameFor(id) {
    if (G.STD_PLANES[id]) return { frame: G.stdFrame(id), name: G.STD_PLANES[id].name };
    const f = M.findFeature(this.doc, id), fr = f?.type === 'plane' && this.result?.planes?.get(id);
    return fr ? { frame: fr, name: f.name } : null;
  }

  treePickPlane(key) {
    if (this.mode === 'sketch3d') { const p = this.planeFrameFor(key); if (p) this.sketch3d.useFrame(p.frame, p.name); return; }
    if (this.pm?.kind === 'selectPlane') return this.createSketchOn({ ref: key });
    if (this.pmPick('plane', key)) return;
    this.select({ kind: 'plane', id: key });
  }

  treePickFeature(id) {
    const f = M.findFeature(this.doc, id);
    if (!f) return;
    if (this.pm?.kind === 'selectPlane' && f.type === 'plane') return this.createSketchOn({ ref: f.id });
    if (this.mode === 'sketch3d' && f.type === 'plane') { const p = this.planeFrameFor(f.id); if (p) this.sketch3d.useFrame(p.frame, p.name); return; }
    if (this.pm?.kind === 'feature') {
      if (f.type === 'sketch' && this.pmPick('sketch', id)) return;
      if ((f.type === 'helix' || f.type === 'sketch3d') && this.pmPick('helix', id)) return;
      if (['compCurve','projCurve'].includes(f.type) && this.pmPick('curve',id)) return;
      if ((f.type === 'extrude' || f.type === 'revolve') && this.pmPick('feature', id)) return;
      if (f.type === 'plane' && this.pmPick('plane', id)) return;
      if (f.type === 'point' && this.pmPick('point', id)) return;
      if (f.type === 'axis' && this.pmPick('axis', id)) return;
    }
    this.select({ kind: 'feature', id });
  }

  setHoverPlane(id) {
    if (this.hoverPlane === id) return;
    this.hoverPlane = id;
    this.updatePlanes();
  }

  faceAt(e) {
    const hit = this.viewport.pickBody(e);
    if (!hit || hit.face < 0) return null;
    return { hit };
  }

  faceFrame(face) {
    const o = face.normal.clone().multiplyScalar(face.d);
    return G.frameFromNormal(o, face.normal);
  }

  // ------------------------------------------------------------ viewport input
  wireViewport() {
    const vp = this.viewport;
    const asm = () => (this.mode === 'drawing' && this.drawing?.vpEvent ? this.drawing : null);
    const exT = () => (this.pm?.kind === 'explode' ? this.explodeTool : null);
    vp.onPointerDown = (e) => { if (this.loftConnectorDown(e) || this.sectionDragDown(e) || this.filletPointDown(e)) return; if (asm()) asm().vpEvent('down', e); else if (exT()) exT().down(e); else if (this.mode === 'sketch') this.sketcher.pointerDown(e); else if (this.mode === 'sketch3d') this.sketch3d.pointerDown(e); };
    vp.onPointerMoveImmediate = (e) => { if (this.loftConnectorMove(e) || this.sectionDragMove(e) || this.filletPointMove(e)) return; if (asm()) asm().vpEvent('move', e); else if (exT()?.drag) exT().move(e); else if (this.mode === 'sketch' && !this.toolWheel.isOpen) this.sketcher.pointerMove(e); else if (this.mode === 'sketch3d') this.sketch3d.pointerMove(e); };
    vp.onPointerUp = (e) => { if (this.loftConnectorUp(e) || this.sectionDragUp(e) || this.filletPointUp(e)) return; if (asm()) asm().vpEvent('up', e); else if (exT()?.drag) exT().up(e); else if (this.mode === 'sketch' && e.button === 0) this.sketcher.pointerUp(e); else if (this.mode === 'sketch3d' && e.button === 0) this.sketch3d.pointerUp(e); };
    vp.onDoubleClick = (e) => { if (asm()) asm().vpEvent('dbl', e); else if (this.mode === 'sketch') this.sketcher.doubleClick(); else if (this.mode === 'sketch3d') this.sketch3d.doubleClick(); };
    vp.onLeave = () => {
      if (asm()) { asm().vpEvent('leave'); return; }
      if (this.mode === 'sketch') this.sketcher.leave();
      if (this.mode === 'sketch3d') this.sketch3d.leave();
      vp.setFaceHighlight('hover', null);
      this.hoverFaceKey = null;
      if (this.mode !== 'sketch' && (this.hoverEdge != null || this.hoverVertex)) { this.hoverEdge = this.hoverVertex = null; this.updateEdgeHighlights(); }
    };
    vp.onClick = (e) => { if (asm()) asm().vpEvent('click', e); else if (exT()) exT().click(e); else if (this.mode !== 'sketch' && this.mode !== 'sketch3d') this.handleClick(e); };
    vp.onHover = (e) => { if (asm()) asm().vpEvent('hover', e); else if (this.mode !== 'sketch' && this.mode !== 'sketch3d') this.handleHover(e); };
    vp.onContextMenu = (e) => (asm() ? asm().vpEvent('context', e) : this.viewportMenu(e));
    // Sketch tool wheel: hold the right mouse button (or drag with it), move toward a tool, release.
    this.toolWheel = new ToolWheel();
    vp.controls.onButtonHold = (e) => {
      if (this.mode !== 'sketch') return false;
      this.ui.closeContext?.();
      const items = WHEEL_TOOLS.map(([t, ic]) => ({ id: t, icon: ic, label: SKETCH_TOOLS[t].label, active: this.sketcher.tool === t }));
      this.toolWheel.open(e.clientX, e.clientY, items, (it) => { if (this.mode === 'sketch') this.sketcher.setTool(it.id); }, 2);
      return true;
    };
  }

  pickAt(e) {
    const fh = this.faceAt(e);
    const ph = this.viewport.pickPlane(e);
    // the model wins over the translucent planes (pick planes outside the model or in the tree)
    if (fh) return { kind: 'face', ...fh };
    if (ph) return { kind: 'plane', id: ph.id };
    return null;
  }

  handleClick(e) {
    if (this.showHiddenMode) {
      // showing the hidden bodies: a click shows that body again
      const fh = this.faceAt(e);
      const b = fh && this.result.bodies[this.viewport.faceBody[fh.hit.face]];
      if (b) this.setBodyHidden(b.id, false);
      return;
    }
    if (this.pickMode() === 'measure') { this.measureClick(e); return; }
    // cycling through overlapping bodies: Shift+left-click steps back, a plain click on the spot selects
    if (this.cycleAllowed()) {
      const c = this._cycle;
      if (e.shiftKey && this.cycleAt(e, -1)) return;
      if (c && !e.shiftKey && Math.hypot(e.clientX - c.x, e.clientY - c.y) < 8) return this.confirmCycle();
    }
    this.clearCycle();
    const mode = this.pickMode();
    if(mode==='loftConnector'){try{const target=this.loftConnectorTarget(e);if(target)this.setLoftConnection(target.ref,target.control);else this.toast('Choose a start vertex on this profile, or a point on its circle',true);}catch(error){this.toast(error.message,true);}return;}
    if (mode === 'loftContour') { this.loftClick(e); return; }
    if (mode === 'section') {
      // a flat face or a plane: the section moves onto it
      const p = this.pickAt(e);
      const sel = p?.kind === 'face' ? { kind: 'face', face: this.viewport.faceInfo(p.hit.face) } : p?.kind === 'plane' ? { kind: 'plane', id: p.id } : null;
      if (!sel) return;
      const from = this.sectionPlaneOf(sel);
      if (!from) { this.toast('Click a flat face or a plane to cut from it'); return; }
      Object.assign(this.activeSection(), from, { offset: 0 });
      this.applySection();
      this.ui.renderPM();
      return;
    }
    if (mode === 'ref') {
      // reference plane: vertex, then edge, then face or plane under the cursor
      const vp = this.viewport;
      const v = this.allows('vertex') ? vp.pickVertex(e, 7) : null;
      if (v) return this.togglePlaneRef({ kind: 'vertex', p: v.point.toArray() });
      // (a sketch shown in the view: its points, lines, circles and arcs)
      const sp = this.allows('vertex') ? this.sketchPointAt(e) : null;
      if (sp) return this.togglePlaneRef({ kind: 'sketch', sketch: sp.sketch, point: sp.point });
      const ed = this.allows('edge') ? vp.pickEdge(e, 5) : null;
      if (ed) return this.togglePlaneRef({ kind: 'edge', p: ed.edge.mid,...(this.result.bodies?.[vp.edgeBody[ed.index]]?.id?{body:this.result.bodies[vp.edgeBody[ed.index]].id}:{}) });
      const sc = this.allows('edge') ? this.sketchCurveAt(e) : null;
      if (sc) {
        const c = S.getCurve(this.result.sketches.get(sc.sketch)?.sketch, sc.curve);
        if (c && (['line', 'circle', 'arc'].includes(c.type)||this.pm?.feature?.type!=='axis'&&c.type==='spline')) return this.togglePlaneRef({ kind: 'sketch', sketch: sc.sketch, curve: sc.curve });
      }
      if(['plane','point'].includes(this.pm?.feature?.type)){
        const m=vp.screenPos(e);let best=null,distance=6;
        for(const [id,curve] of this.result.curves||[]){
          const feature=M.findFeature(this.doc,id);if(!feature||feature.suppressed||this.doc.features.indexOf(feature)>=this.doc.features.indexOf(this.pm.feature))continue;
          const paths=Array.isArray(curve?.[0]?.[0])?curve:[curve];
          for(const points of paths)for(let i=1;i<points.length;i++){const a=vp.project(new THREE.Vector3(...points[i-1])),b=vp.project(new THREE.Vector3(...points[i])),d=S.segDist(m.x,m.y,a.x,a.y,b.x,b.y);if(d<distance){best=id;distance=d;}}
        }
        if(best)return this.togglePlaneRef({kind:'curve',id:best});
      }
      const p = this.pickAt(e);
      if (p?.kind === 'plane') return this.togglePlaneRef({ kind: 'plane', id: p.id });
      if (p?.kind === 'face') {
        const face = vp.faceInfo(p.hit.face);
        // (a curved face: a cylinder, for a tangent plane; the kernel says when it is not one)
        const body = this.result.bodies?.[vp.faceBody[p.hit.face]]?.id;
        if (!face.planar) return this.togglePlaneRef({ kind: 'face', p: p.hit.point.toArray(), ...(body ? { body } : {}) });
        return this.togglePlaneRef({ kind: 'face', p: p.hit.point.toArray(), n: face.normal.toArray(),...(body?{body}:{}) });
      }
      return;
    }
    if (mode === 'edge') {
      const hit = this.viewport.pickEdge(e);
      if (hit) this.applyModelPick(hit);
      return;
    }
    if (mode === 'vertex') {
      const hit = this.viewport.pickVertex(e);
      if (hit) this.applyModelPick(hit);
      else this.toast('Click a vertex (corner) of the model, or choose a reference point in the Property panel');
      return;
    }
    if (mode === 'entity') {
      const vp = this.viewport;
      const v = vp.pickVertex(e, 7);
      if (v) return this.pmPickMate({ kind: 'vertex', p: v.point.toArray() });
      const ed = vp.pickEdge(e, 5);
      if (ed) return this.pmPickMate({ kind: 'edge', p: ed.edge.mid });
      const p = this.pickAt(e);
      if (p?.kind === 'plane') return this.pmPickMate({ kind: 'plane', id: p.id });
      if (p?.kind === 'face') {
        const face = vp.faceInfo(p.hit.face);
        return this.pmPickMate({ kind: 'face', p: p.hit.point.toArray(), ...(face.planar ? { n: face.normal.toArray() } : {}) });
      }
      return;
    }
    if (mode === 'flatface') {
      const fh = this.faceAt(e);
      if (!fh) return;
      const face = this.viewport.faceInfo(fh.hit.face);
      if (!face.planar) { this.toast('Select a flat face'); return; }
      this.pm.feature.face = { p: fh.hit.point.toArray(), n: face.normal.toArray() };
      this.ui.renderPM(); this.updateEdgeHighlights(); this.preview();
      return;
    }
    if (mode === 'anyface') {
      const fh = this.faceAt(e);
      if (!fh) return;
      const face = this.viewport.faceInfo(fh.hit.face), body = this.result.bodies[this.viewport.faceBody[fh.hit.face]]?.id;
      // (body: which of several faces on top of each other was clicked, e.g. a copied surface on its solid)
      this.pm.feature.face = { p: fh.hit.point.toArray(), ...(face.planar ? { n: face.normal.toArray() } : {}), ...(body ? { body } : {}) };
      this.ui.renderPM(); this.updateEdgeHighlights(); this.preview();
      return;
    }
    if (mode === 'cylface') {
      const fh = this.faceAt(e);
      if (!fh) return;
      const face = this.viewport.faceInfo(fh.hit.face), f = this.pm.feature;
      if (face.planar) {
        // a thread's end reference
        if ((f.type === 'thread' || f.type === 'cosmeticThread') && f.end === 'upTo') { f.toFace = { p: fh.hit.point.toArray(), n: face.normal.toArray() }; f.toPlane = null; this.ui.renderPM(); this.preview(); return; }
        this.toast(f.type === 'thread' || f.type === 'cosmeticThread' ? 'Select a bore or a shaft (a cylindrical face)' : 'Select a cylindrical or conical face');
        return;
      }
      this.pm.feature.face = { p: fh.hit.point.toArray() };
      this.ui.renderPM(); this.updateEdgeHighlights(); this.preview();
      return;
    }
    if (mode === 'revaxis') {
      if (this.pickRevolveAxis(e)) { this.ui.renderPM(); this.updateEdgeHighlights(); this.preview(); }
      return;
    }
    if (mode === 'faces') {
      const fh = this.faceAt(e);
      if (!fh) {
        // (a pattern: a plane clicked goes to the panel as before, e.g. for a direction)
        const p = ['lpattern', 'cpattern', 'spattern', 'curvePattern'].includes(this.pm.feature?.type) ? this.pickAt(e) : null;
        if (p?.kind === 'plane') G.STD_PLANES[p.id] ? this.treePickPlane(p.id) : this.treePickFeature(p.id);
        return;
      }
      const f = this.pm.feature, vp = this.viewport, gi = fh.hit.face;
      const face = vp.faceInfo(gi);
      if (['fillet', 'chamfer'].includes(f.type) && this.pm.faceEdgesPick) { this.addFaceEdges(fh); return; }
      const key = ['loft', 'surfLoft'].includes(f.type) ? this.pm.loftEndSlot : ['surfFill', 'sweep', 'surfSweep'].includes(f.type) ? 'supportFaces' : f.type === 'shell' && this.pm.shellThickPick ? 'thickFaces' : 'faces';
      if (!key) return;
      f[key] ||= [];
      const i = f[key].findIndex((r) => vp.faceIndexNear(r.p) === gi);
      if (i >= 0) f[key].splice(i, 1);
      else f[key].push({ p: fh.hit.point.toArray(), ...(face.planar ? { n: face.normal.toArray() } : {}), ...(['loft', 'surfLoft', 'surfFill'].includes(f.type) ? { body: this.result.bodies[vp.faceBody[gi]]?.id } : {}), ...(key === 'thickFaces' ? { t: +(2 * (Number(f.thickness) || 1)).toFixed(3) } : {}) });
      this.ui.renderPM();
      this.updateEdgeHighlights();
      this.preview();
      return;
    }
    if (mode === 'body') {
      const fh = this.faceAt(e);
      if (fh) this.pmPickBody(this.result.bodies[this.viewport.faceBody[fh.hit.face]]?.id);
      else {
        const p = this.pickAt(e);
        if (p?.kind === 'plane') G.STD_PLANES[p.id] ? this.treePickPlane(p.id) : this.treePickFeature(p.id);
      }
      return;
    }
    if (!this.pm) return this.selectAt(e);
    const p = this.pickAt(e);
    if (mode === 'face' && p?.kind === 'face') {
      const face = this.viewport.faceInfo(p.hit.face);
      if (!face.planar) { this.toast('Select a flat face or a plane'); return; }
      this.applyModelPick({ p: p.hit.point.toArray(), n: face.normal.toArray() });
      return;
    }
    if (!p) {
      if (!this.pm) this.select(null);
      return;
    }
    if (p.kind === 'plane') {
      const isStd = !!G.STD_PLANES[p.id];
      return isStd ? this.treePickPlane(p.id) : this.treePickFeature(p.id);
    }
    const face = this.viewport.faceInfo(p.hit.face);
    if (this.pm?.kind === 'selectPlane') {
      if (!face.planar) { this.toast('Select a flat face (or a plane) to sketch on'); return; }
      const frame = this.faceFrame(face);
      return this.createSketchOn({ ref: 'face', frame: G.frameToJSON(frame) });
    }
    if (this.pm) return;
    this.select({ kind: 'face', face, point: p.hit.point.toArray() });
  }

  handleHover(e) {
    const vp = this.viewport;
    if (this.pm?.kind === 'section') {
      const on = vp.sectionArrowAt(e);
      vp.setSectionArrowHover(on);
      if (on) { vp.setFaceHighlight('hover', null); this.hoverFaceKey = null; vp.canvas.style.cursor = 'grab'; return; }
    }
    const mode = this.showHiddenMode ? 'body' : this.pickMode();
    if(mode==='loftConnector'){let target=null;try{target=this.loftConnectorTarget(e);}catch{}vp.canvas.style.cursor=target?'pointer':'default';vp.setPointMarks('loft-connection-target',target?[{p:target.p,text:'Attach',cls:'pick'}]:null);return;}
    if (mode === 'loftContour') {
      let ref = null;
      try { ref = this.pickLoftContour(e); } catch { /* ambiguous edges need a region or manual selection */ }
      if (LR.refKey(ref) !== LR.refKey(this.pm.loftHover)) { this.pm.loftHover = ref; this.updateSketchDisplay(); }
      vp.canvas.style.cursor = ref ? 'pointer' : 'default'; return;
    }
    if (mode === 'body') {
      const fh = this.faceAt(e);
      const bi = fh ? vp.faceBody[fh.hit.face] : -1;
      const key = fh ? 'b' + bi : null;
      if (key !== this.hoverFaceKey) { this.hoverFaceKey = key; vp.setFaceHighlight('hover', fh ? vp.bodyInfo(bi) : null); }
      vp.canvas.style.cursor = fh ? 'pointer' : 'default';
      return;
    }
    if (mode === 'revaxis') {
      const ed = vp.pickEdge(e, 5);
      const he = ed ? ed.index : null;
      if (he !== this.hoverEdge) { this.hoverEdge = he; this.updateEdgeHighlights(); }
      if (ed || this.sketchLineAt(e)) {
        if (this.hoverFaceKey != null) { vp.setFaceHighlight('hover', null); this.hoverFaceKey = null; }
        vp.canvas.style.cursor = 'pointer';
        return;
      }
    }
    if (mode === 'measure') this.measureMarks(this.measurePickAt(e));
    if (mode === 'ref' || mode === 'entity' || mode === 'measure') {
      const v = vp.pickVertex(e, 7);
      const ed = v ? null : vp.pickEdge(e, 5);
      const hv = v ? v.point.toArray() : null, he = ed ? ed.index : null;
      if (String(hv) !== String(this.hoverVertex) || he !== this.hoverEdge) {
        this.hoverVertex = hv;
        this.hoverEdge = he;
        this.updateEdgeHighlights();
      }
      if (v || ed) {
        if (this.hoverFaceKey != null) { vp.setFaceHighlight('hover', null); this.hoverFaceKey = null; }
        vp.canvas.style.cursor = 'pointer';
        return;
      }
      // otherwise fall through to face / plane hover
    }
    if (mode === 'edge') {
      // (over a variable fillet's point: it can be dragged)
      const fpts = this.filletPoints(this.pm?.feature);
      if (fpts) {
        const m = vp.screenPos(e);
        if (fpts.some((x) => x && Math.hypot(...(({ x: sx, y: sy }) => [sx - m.x, sy - m.y])(vp.project(new THREE.Vector3(...x.p)))) < 9)) { vp.canvas.style.cursor = 'grab'; return; }
      }
      const hit = vp.pickEdge(e);
      const h = hit ? hit.index : null;
      if (h !== this.hoverEdge) { this.hoverEdge = h; this.updateEdgeHighlights(); }
      vp.canvas.style.cursor = hit ? 'pointer' : 'default';
      return;
    }
    if (mode === 'vertex') {
      const hit = vp.pickVertex(e);
      this.hoverVertex = hit ? hit.point.toArray() : null;
      this.updateEdgeHighlights();
      vp.canvas.style.cursor = hit ? 'pointer' : 'default';
      return;
    }

    if (!this.pm) return this.hoverAt(e);
    if (mode === 'measure' && this.sketchSegmentAt(e)) { vp.canvas.style.cursor = 'pointer'; return; }
    if (mode === 'measure' && vp.pickSnap(e, { mids: this.pm.snap?.mids !== false, centres: this.pm.snap?.centres !== false }, 7)) { vp.canvas.style.cursor = 'pointer'; return; }
    const p = this.pickAt(e);
    if (p?.kind === 'face') {
      const key = p.hit.face;
      if (key !== this.hoverFaceKey) {
        this.hoverFaceKey = key;
        vp.setFaceHighlight('hover', vp.faceInfo(key));
      }
      if (this.hoverPlane && !this._treeHover) this.setHoverPlane(null);
    } else {
      if (this.hoverFaceKey) { vp.setFaceHighlight('hover', null); this.hoverFaceKey = null; }
      this.setHoverPlane(p?.kind === 'plane' ? p.id : null);
    }
    vp.canvas.style.cursor = p ? 'pointer' : 'default';
  }

  // A line of the open revolve's sketch under the cursor (within 6 px), or null.
  sketchLineAt(e) {
    const f=this.pm?.feature;if(!f)return null;
    const vp=this.viewport,m=vp.screenPos(e),before=this.doc.features.indexOf(f);let best=null,bd=6;
    for(const [id,s] of this.result.sketches){
      if(s.sketch.suppressed||this.result.errors.has(id)||this.doc.features.findIndex(f=>f.id===id)>=before)continue;
      for(const c of s.sketch.curves){
        if(c.type!=='line')continue;
        const A=S.getPoint(s.sketch,c.p1),B=S.getPoint(s.sketch,c.p2),a=vp.project(G.toWorld(s.frame,A.x,A.y)),b=vp.project(G.toWorld(s.frame,B.x,B.y));
        const d=S.segDist(m.x,m.y,a.x,a.y,b.x,b.y);
        if(d<bd){bd=d;best={...c,sketchId:id};}
      }
    }
    return best;
  }

  // Revolve axis clicked in the view: a sketch line, a straight model edge or a cylindrical face.
  pickRevolveAxis(e) {
    const f = this.pm.feature, vp = this.viewport;
    const line = this.sketchLineAt(e);
    if (line) { f.axis = 'sketchLine'; f.axisSketch = {sketch:line.sketchId,curve:line.id}; f.axisEdge = f.axisFace = null; return true; }
    const ed = vp.pickEdge(e, 5);
    if (ed) { f.axis = 'edge'; f.axisEdge = { p: ed.edge.mid }; f.axisFace = null; return true; }
    const fh = this.faceAt(e);
    if (fh) {
      if (vp.faceInfo(fh.hit.face).planar) { this.toast('Click a sketch line, a straight edge or a cylindrical face for the axis'); return false; }
      f.axis = 'face'; f.axisFace = { p: fh.hit.point.toArray() }; f.axisEdge = null;
      return true;
    }
    return false;
  }

  // Cycling through what is under the cursor, to reach bodies/surfaces (or faces) behind others:
  //   Shift+right-click  next one (front to back)      Shift+left-click  previous one
  //   left-click (Shift released) on that spot           select it (or add it to the open Property panel)
  // The current candidate is shown in orange, through whatever is in front of it.
  cycleAllowed() {
    const m = this.pickMode();
    return this.mode !== 'sketch' && (m === null || m === 'body' || m === 'faces');
  }

  cycleAt(e, dir = 1) {
    const vp = this.viewport;
    const facesMode = this.pickMode() === 'faces' || (this.filters.size > 0 && this.allows('face') && !this.allows('body'));
    const list = [], seen = new Set();
    for (const h of vp.hitsAt(e)) {
      const k = facesMode ? h.face : h.body;
      if (k == null || k < 0 || seen.has(k)) continue;
      seen.add(k);
      list.push({ k, h });
    }
    if (!list.length) { this.status('There is nothing under the cursor to cycle through'); return false; }
    const c = this._cycle;
    const same = c && c.facesMode === facesMode && c.list.length === list.length && Math.hypot(e.clientX - c.x, e.clientY - c.y) < 8;
    let i;
    if (same) i = (c.i + dir + list.length) % list.length;
    else if (dir < 0) i = list.length - 1; // stepping backwards from a new spot starts at the back
    else {
      // start behind the item that is already selected (a plain click selects the front one)
      const sel = this.selection, front = list[0];
      const frontSelected = facesMode ? sel?.kind === 'face' && sel.face?.index === front.k : sel?.kind === 'body' && this.result.bodies?.[front.k]?.id === sel.id;
      i = frontSelected && list.length > 1 ? 1 : 0;
    }
    this._cycle = { x: same ? c.x : e.clientX, y: same ? c.y : e.clientY, list, i, facesMode };
    const pick = list[i];
    vp.setFaceSet([facesMode ? vp.faceInfo(pick.k) : vp.bodyInfo(pick.k)], 'cycle');
    const name = facesMode ? 'Face' : this.result.bodies[pick.k]?.name || 'Body';
    this.status(`${name} — ${i + 1} of ${list.length} under the cursor. Click to select it · Shift+right-click: next · Shift+left-click: previous · Esc: cancel`);
    return true;
  }

  clearCycle() {
    if (!this._cycle) return;
    this._cycle = null;
    this.viewport.setFaceSet([], 'cycle');
  }

  // Left-click after cycling: select the candidate (or put it into the open Property panel).
  confirmCycle() {
    const c = this._cycle, vp = this.viewport;
    const pick = c.list[c.i];
    this.clearCycle();
    const mode = this.pickMode();
    if (c.facesMode) {
      if (mode === 'faces') {
        const f = this.pm.feature, face = vp.faceInfo(pick.k);
        if (!f.faces.some((r) => vp.faceIndexNear(r.p) === pick.k)) f.faces.push({ p: pick.h.point.toArray(), ...(face.planar ? { n: face.normal.toArray() } : {}) });
        this.ui.renderPM(); this.updateEdgeHighlights(); this.preview();
      } else this.select({ kind: 'face', face: vp.faceInfo(pick.k), point: pick.h.point.toArray(), body: vp.faceBody[pick.k], xray: c.i > 0 });
      this.status('Face selected.');
      return;
    }
    const id = this.result.bodies[pick.k]?.id;
    if (mode === 'body') this.pmPickBody(id);
    else this.select({ kind: 'body', id });
  }

  viewportMenu(e) {
    if (this.mode === 'sketch3d') return void this.ui.showContext(e.clientX, e.clientY, this.sketch3d.menuItems());
    if (this.flatView) {
      const b = this.bodyById(this.flatView.bodyId);
      return void this.ui.showContext(e.clientX, e.clientY, [
        { label: `Export Flat Pattern as DXF…${b ? ` (${b.name})` : ''}`, icon: 'dxf', action: () => this.exportSheetDXF(this.flatView.bodyId) },
        { label: 'Export All Flat Patterns as DXF…', icon: 'dxfAll', action: () => this.exportSheetDXF(null, true) },
        { label: 'DXF Settings…', icon: 'gear', action: () => this.ui.showDxfSettings() },
        'sep',
        { label: 'Exit Flatten', icon: 'smFlatten', key: 'Esc', action: () => this.exitFlatten() },
      ]);
    }
    if (e.shiftKey && this.cycleAllowed()) return void this.cycleAt(e, 1);
    const items = [];
    if (this.mode === 'sketch') {
      items.push({ label: 'Exit Sketch', icon: 'exitSketch', action: () => this.exitSketch(true) });
      items.push({ label: 'Discard Changes', icon: 'cancel', action: () => this.exitSketch(false) });
      items.push('sep');
      for (const [t, ic, l] of [['select', 'select', 'Select'], ['dim', 'smartdim', 'Dimension'], ['line', 'line', 'Line'], ['centerline', 'centerline', 'Centerline'], ['rect', 'rect', 'Corner Rectangle'], ['circle', 'circle', 'Circle'], ['arc', 'arc', 'Centerpoint Arc'], ['trim', 'trim', 'Trim']])
        items.push({ label: l, icon: ic, action: () => this.sketcher.setTool(t) });
      if (this.sketcher.sel.size) {
        items.push('sep');
        for (const r of this.sketcher.applicableRelations().slice(0, 6)) items.push({ label: 'Add Relation: ' + RELATION_INFO[r].label, icon: 'relations', action: () => this.sketcher.addRelation(r) });
        items.push({ label: 'Construction Geometry', icon: 'construction', key: 'Q', action: () => this.sketcher.toggleConstruction() });
        items.push({ label: 'Delete', icon: 'trash', key: 'Del', action: () => this.sketcher.deleteSelected() });
      }
      items.push('sep', { label: 'Normal To', icon: 'normalTo', action: () => this.sketcher.normalTo() });
    } else {
      const p = this.pm ? null : this.pickEntity(e);
      const vp = this.viewport;
      const bodyItems = (bi) => {
        const b = this.result.bodies?.[bi];
        return b ? [
          { label: `Body Properties… (${b.name})`, icon: 'body', action: () => this.ui.showBodyProps(b.id) },
          { label: b.kind === 'surface' ? 'Hide Surface' : 'Hide Body', icon: 'hide', action: () => this.setBodyHidden(b.id, true) },
          this.transparencyItem([b.id]),
          { label: 'Isolate', icon: 'isolate', action: () => this.isolateBodies([b.id]) },
          { label: 'Body Appearance…', icon: 'appearance', action: () => this.ui.showAppearance({ kind: 'body', id: b.id }) },
          ...(b.kind === 'surface' ? [{ label: 'Convert to Solid…', icon: 'surfSolid', action: () => this.startFeatureOnBody('surfSolid', b.id) }, { label: 'Repair Mesh…', icon: 'meshRepair', action: () => this.startFeatureOnBody('meshRepair', b.id) }] : []),
          ...(b.sheet ? [
            { label: 'View Flat Pattern', icon: 'smFlatten', action: () => this.toggleFlatten(b.id) },
            { label: 'Export Flat Pattern as DXF…', icon: 'dxf', action: () => this.exportSheetDXF(b.id) },
          ] : []),
          { label: 'Export Body as STEP…', icon: 'step', action: () => this.exportBodySTEP(b.id) },
        ] : [];
      };
      if (p?.kind === 'face') {
        const face = vp.faceInfo(p.hit.face);
        const bi = vp.faceBody[p.hit.face];
        this.select({ kind: 'face', face, point: p.hit.point.toArray(), body: bi });
        const fp = p.hit.point.toArray(), bid = this.result.bodies?.[bi]?.id;
        items.push({ label: 'Appearance…', icon: 'appearance', action: () => this.ui.showAppearance({ kind: 'face', p: fp, body: bid }) });
        if (face.planar) {
          items.push({ label: 'Sketch', icon: 'sketch', action: () => this.createSketchOn({ ref: 'face', frame: G.frameToJSON(this.faceFrame(face)) }) });
          items.push({ label: 'Normal To', icon: 'normalTo', action: () => this.viewport.normalTo(this.faceFrame(face)) });
          items.push({ label: 'Export Face as DXF…', icon: 'dxf', action: () => this.exportFaceDXF() });
        }
        items.push({ label: 'Fillet…', icon: 'fillet', action: () => this.startFeature('fillet') });
        items.push({ label: 'Chamfer…', icon: 'chamfer', action: () => this.startFeature('chamfer') });
        items.push('sep', ...bodyItems(bi), 'sep');
      } else if (p?.kind === 'body') {
        this.select({ kind: 'body', id: this.result.bodies[p.index]?.id });
        items.push(...bodyItems(p.index), 'sep');
      } else if (p?.kind === 'edge') {
        const bi = vp.edgeBody[p.index];
        this.select({ kind: 'edge', index: p.index, p: p.edge.mid, body: bi });
        items.push({ label: 'Fillet…', icon: 'fillet', action: () => this.startFeature('fillet') });
        items.push({ label: 'Chamfer…', icon: 'chamfer', action: () => this.startFeature('chamfer') });
        items.push({ label: 'Reference Axis', icon: 'axis', action: () => this.startFeature('axis') });
        items.push('sep', ...bodyItems(bi), 'sep');
      } else if (p?.kind === 'vertex') {
        this.select({ kind: 'vertex', p: p.p });
        items.push({ label: 'Reference Point', icon: 'refpoint', action: () => this.startFeature('point') });
        items.push('sep');
      } else if (p?.kind === 'plane') {
        G.STD_PLANES[p.id] ? this.treePickPlane(p.id) : this.treePickFeature(p.id);
        items.push({ label: 'Sketch', icon: 'sketch', action: () => this.createSketchOn({ ref: p.id }) });
        items.push('sep');
      }
      items.push({ label: 'Zoom to Fit', icon: 'zoomfit', key: 'F', action: () => this.viewport.zoomToFit() });
      for (const [l, v] of [['Front', 'front'], ['Top', 'top'], ['Right', 'right'], ['Isometric', 'iso']]) items.push({ label: l, icon: 'views', action: () => this.viewport.setStandardView(v) });
      items.push('sep');
      items.push({ label: this.showHiddenMode ? 'Done Showing Hidden Bodies' : 'Show Hidden Bodies', icon: 'hiddenBodies', action: () => this.toggleShowHidden(), disabled: !this.showHiddenMode && !(this.result?.bodies || []).some((b) => this.isBodyHidden(b.id)) });
      if (this.isolated) items.push({ label: 'Exit Isolate', icon: 'isolate', action: () => this.exitIsolate() });
      items.push({ label: 'Measure', icon: 'measure', action: () => this.startMeasure() });
      items.push({ label: (this.showPlanes ? 'Hide' : 'Show') + ' Planes', icon: 'eye', action: () => this.togglePlanes() });
    }
    this.ui.showContext(e.clientX, e.clientY, items);
  }

  // ------------------------------------------------------------ sketch flow
  startSketch() {
    if (this.mode === 'sketch') return;
    if (this.pm) this.cancelPM();
    const s = this.selection;
    if (s?.kind === 'plane') return this.createSketchOn({ ref: s.id });
    if (s?.kind === 'face' && s.face.planar) return this.createSketchOn({ ref: 'face', frame: G.frameToJSON(this.faceFrame(s.face)) });
    if (s?.kind === 'feature') {
      const f = M.findFeature(this.doc, s.id);
      if (f?.type === 'plane') return this.createSketchOn({ ref: f.id });
      if (f?.type === 'sketch') return this.editSketch(f.id);
    }
    this.pm = { kind: 'selectPlane' };
    this.status('Select a plane or a flat face on which to create a sketch.');
    this.updatePlanes();
    this.ui.renderPM();
    this.ui.refreshCommandStates();
    this.showBanner('Select a plane or flat face to sketch on');
  }

  // Change Sketch Plane (sketch right-click): pick another plane or flat face for an existing sketch, e.g.
  // when the plane it was on has been deleted. Its curves keep their sketch coordinates.
  changeSketchPlane(id) {
    const f = M.findFeature(this.doc, id);
    if (!f || f.type !== 'sketch') return;
    if (this.mode === 'sketch') this.exitSketch(true);
    if (this.mode === 'sketch3d') this.exitSketch3D(true);
    if (this.pm) this.cancelPM();
    this.pm = { kind: 'selectPlane', forSketch: id };
    this.select({ kind: 'feature', id });
    this.status(`Select the new plane or flat face for ${f.name}.`);
    this.updatePlanes();
    this.ui.renderPM();
    this.ui.refreshCommandStates();
    this.showBanner(`Select the new plane or flat face for ${f.name}`);
  }

  // a plane (or face) the sketch may be put on: one before it in the tree
  planeUsableFor(sk, ref) {
    if (G.STD_PLANES[ref] || ref === 'face') return true;
    const p = M.findFeature(this.doc, ref);
    return !!p && this.doc.features.indexOf(p) < this.doc.features.indexOf(sk);
  }

  setSketchPlane(id, plane) {
    const f = M.findFeature(this.doc, id);
    this.pm = null;
    this.showBanner(null);
    this.setHoverPlane(null);
    if (!f) return;
    if (!this.planeUsableFor(f, plane.ref)) {
      this.toast(`${M.findFeature(this.doc, plane.ref)?.name || 'That plane'} comes after ${f.name} in the tree: pick a plane above it (or drag the sketch below the plane first)`, true);
      this.ui.renderPM();
      return;
    }
    breadcrumb(`Sketch plane of ${f.name}: ${plane.ref}`);
    f.plane = plane;
    f.rev = M.newRev();
    this.commit();
    this.ui.renderPM();
    this.ui.refreshCommandStates();
    this.rebuild();
    const where = plane.ref === 'face' ? 'the selected face' : G.STD_PLANES[plane.ref]?.name || M.findFeature(this.doc, plane.ref)?.name;
    this.status(`${f.name} is now on ${where}.`);
  }

  createSketchOn(plane) {
    if (this.pm?.kind === 'selectPlane' && this.pm.forSketch) return this.setSketchPlane(this.pm.forSketch, plane);
    if (this.pm?.kind === 'selectPlane') this.pm = null;
    this.setHoverPlane(null);
    const f = M.createFeature(this.doc, 'sketch', { plane });
    M.insertFeature(this.doc, f);
    this.enterSketch(f, true);
  }

  async enterSketch(f, isNew) {
    breadcrumb(`${isNew ? 'New' : 'Edit'} sketch: ${f.name}`);
    this.collapseExplode();
    this.showBanner(null);
    this.status('Opening sketch…');
    await this.rebuild();
    const s = this.result.sketches.get(f.id);
    if (!s) {
      this.toast(this.result.errors.get(f.id) || 'Cannot open this sketch', true);
      if (isNew) { this.doc.features = this.doc.features.filter((x) => x !== f); this.rebuild(); }
      return;
    }
    this.mode = 'sketch';
    this.pm = { kind: 'sketch' };
    this.selection = null;
    this.viewport.clearFaceHighlights();
    this.sketcher.enter(f, s.frame, isNew);
    this.ui.setCmTab('sketch');
    $('#status-mode').textContent = 'Editing ' + f.name;
    this.updateSketchDisplay();
    this.updatePlanes();
    this.ui.renderTree();
    this.ui.renderPM();
    this.ui.refreshCommandStates();
    if (this.pendingGears) { this.pendingGears = false; this.sketcher.startGearPick(); }
    if (this.pendingAirfoil) { this.pendingAirfoil = false; this.sketcher.makeAirfoil(); }
    else if (this.pendingTool) { this.sketcher.setTool(this.pendingTool); this.pendingTool = null; }
    else this.status(isNew ? 'Sketching. Pick a tool from the Sketch tab — Line, Rectangle, Circle…' : 'Editing sketch. Click a dimension to change it.');
  }

  // ------------------------------------------------------------ 3D sketch
  // Drawn in space with its own editor (sketch3d.js): no plane to pick, it opens empty.
  newSketch3D() {
    this.collapseExplode();
    if (this.mode === 'sketch') this.exitSketch(true);
    else if (this.mode === 'sketch3d') this.exitSketch3D(true);
    if (this.pm) this.cancelPM();
    const f = M.createFeature(this.doc, 'sketch3d', {});
    M.insertFeature(this.doc, f);
    this.enterSketch3D(f, true);
  }

  editSketch3D(id) {
    const f = M.findFeature(this.doc, id);
    if (!f || f.type !== 'sketch3d') return;
    if (M.isRolledBack(this.doc, f)) { this.toast(`${f.name} is below the rollback bar — drag the bar below it (or right-click ▸ Roll to End) to edit it`, true); return; }
    if (this.mode === 'sketch3d') { if (this.sketch3d.f === f) return; this.exitSketch3D(true); }
    if (this.mode === 'sketch') this.exitSketch(true);
    if (this.pm) this.cancelPM();
    this.enterSketch3D(f, false);
  }

  enterSketch3D(f, isNew) {
    breadcrumb(`${isNew ? 'New' : 'Edit'} 3D sketch: ${f.name}`);
    this.showBanner(null);
    this.mode = 'sketch3d';
    this.pm = { kind: 'sketch3d', feature: f };
    this.selection = null;
    this.viewport.clearFaceHighlights();
    this.sketch3d.enter(f, isNew);
    this.ui.setCmTab('sketch');
    $('#status-mode').textContent = 'Editing ' + f.name;
    this.updateRefGeometry();
    this.updatePlanes();
    this.ui.renderTree();
    this.ui.renderPM();
    this.ui.refreshCommandStates();
    if (isNew) this.status('3D Sketch: click points to draw lines in space. Tab switches the drawing plane (XY / YZ / ZX); lines snap to X, Y and Z.');
  }

  exitSketch3D(save) {
    if (this.mode !== 'sketch3d') return null;
    const s3 = this.sketch3d, f = s3.f, isNew = s3.isNew;
    breadcrumb(`Exit 3D sketch (${save ? 'saved' : 'discarded'}): ${f?.name}`);
    if (!save) {
      if (isNew) this.doc.features = this.doc.features.filter((x) => x !== f);
      else s3.restoreSnapshot();
    } else if (isNew && !f.pts.length) {
      // (nothing drawn: no empty feature is left behind)
      this.doc.features = this.doc.features.filter((x) => x !== f);
      save = false;
    }
    s3.exit();
    this.mode = 'part';
    this.pm = null;
    this.ui.setCmTab('features');
    $('#status-mode').textContent = 'Editing Part';
    if (save) { f.rev = M.newRev(); this.commit(); }
    const kept = this.doc.features.includes(f);
    this.selection = kept ? { kind: 'feature', id: f.id } : null;
    this.rebuild();
    this.ui.renderPM();
    this.ui.renderTree();
    this.ui.refreshCommandStates();
    this.status(kept && save ? `${f.name} saved. Use it as a sweep path (e.g. Sweep or a structural member).` : 'Ready');
    return kept ? f : null;
  }

  // Gears: in a sketch, make a gear train from the selected lines (or pick them first); otherwise open the
  // selected sketch, or start a new one, and then pick the lines.
  startGears() {
    if (this.mode === 'sketch') return this.sketcher.makeGears();
    this.pendingGears = true;
    this.startSketch();
  }

  // Airfoil: on the selected sketch line (its chord), or the next line clicked; starts a sketch if needed.
  startAirfoil() {
    if (this.mode === 'sketch') return this.sketcher.makeAirfoil();
    this.pendingAirfoil = true;
    this.startSketch();
  }

  editSketch(id) {
    const f = M.findFeature(this.doc, id);
    if (!f || f.type !== 'sketch') return;
    if (M.isRolledBack(this.doc, f)) { this.toast(`${f.name} is below the rollback bar — drag the bar below it (or right-click ▸ Roll to End) to edit it`, true); return; }
    if (this.mode === 'sketch') { if (this.sketcher.f === f) return; this.exitSketch(true); }
    if (this.pm) this.cancelPM();
    this.enterSketch(f, false);
  }

  exitSketch(save) {
    if (this.mode !== 'sketch') return null;
    breadcrumb(`Exit sketch (${save ? 'saved' : 'discarded'}): ${this.sketcher.f?.name}`);
    const f = this.sketcher.f, isNew = this.sketcher.isNew;
    if (!save) {
      if (isNew) this.doc.features = this.doc.features.filter((x) => x !== f);
      else this.sketcher.restoreSnapshot();
    }
    if (save && f) S.pruneRefs(f); // automatic references nothing uses
    this.sketcher.exit();
    this.mode = 'part';
    this.pm = null;
    $('#status-mode').textContent = 'Editing Part';
    if (save) { f.rev = M.newRev(); this.commit(); }
    const kept = this.doc.features.includes(f);
    this.selection = kept ? { kind: 'feature', id: f.id } : null;
    this.rebuild();
    this.ui.setCmTab('features');
    this.ui.renderPM();
    this.ui.refreshCommandStates();
    this.status(kept && save ? `${f.name} saved. Choose a feature such as Extrude to use it.` : 'Ready');
    const pf = this.pendingFeature;
    this.pendingFeature = null;
    if (pf && save && kept) setTimeout(() => this.continuePendingFeature(pf, f), 0);
    return kept ? f : null;
  }

  // After sketching the profile for a feature started without one: start the feature with it, or
  // (open boundaries where a closed profile is needed) offer to keep editing or to give up.
  async continuePendingFeature(pf, sk) {
    if (this.mode === 'sketch' || this.pm) return;
    const label = M.TYPE_INFO[pf.type][pf.op === 'cut' ? 'cutBase' : 'base'] || pf.type;
    const empty = pf.type === 'smTransition' ? !sk.curves.some((c) => c.type === 'line') : !sk.curves.some((c) => !c.construction);
    const needsClosed = pf.type === 'revolve' || pf.type === 'surfPlanar';
    if (empty || (needsClosed && S.isOpenSketch(sk))) {
      const choice = await this.ui.choose('Open Sketch', 'sketch',
        `<p><b>${sk.name.replace(/[<>&]/g, '')}</b> ${empty ? 'has no curves' : 'has open boundaries (the profile is not closed)'}, so the ${label} can't be made from it.</p><p class="pm-hint">Continue editing the sketch, or ignore this: the ${label} is cancelled and the sketch is kept, so you can edit it at any time.</p>`,
        [['edit', 'Continue editing the sketch', true], ['ignore', 'Ignore']]);
      if (choice === 'edit') { this.pendingFeature = pf; this.editSketch(sk.id); }
      else this.status(`${label} cancelled; ${sk.name} was kept.`);
      return;
    }
    this.selection = { kind: 'feature', id: sk.id };
    this.startFeature(pf.type, pf.op, pf.opts);
  }

  // The Sketch tab's tools: in a 3D sketch the ones it has; otherwise a 2D sketch (a plane is asked for first)
  sketchTool(t) {
    if (this.mode === 'sketch3d') { if (S3_TOOLS.includes(t)) this.sketch3d.setTool(t); return; }
    if (this.mode !== 'sketch') { this.pendingTool = t; this.startSketch(); return; }
    this.sketcher.setTool(t);
  }

  sketchEdited(rerender = true) {
    if (rerender) this.ui.renderPM();
    this.ui.refreshCommandStates();
    if (!this.dirty) { this.dirty = true; this.updateTitle(); }
    this.autosave();
  }

  // ------------------------------------------------------------ feature flow
  // opts.surfaces: Move/Copy started from the Surfaces tab (picks surface bodies)
  startFeature(type, op, opts = {}) {
    breadcrumb(`Start feature: ${type}${op ? ' ' + op : ''}`);
    this.collapseExplode();
    this.warnDenseMesh(type);
    let preSketch = null;
    if (type === 'sketch3d') return this.newSketch3D();
    if (this.mode === 'sketch') preSketch = this.exitSketch(true);
    else if (this.mode === 'sketch3d') this.exitSketch3D(true);
    if (this.pm) this.cancelPM();
    const doc = this.doc, sel = this.selection;
    const selF = sel?.kind === 'feature' ? M.findFeature(doc, sel.id) : null;
    const props = {};
    if (op) props.op = op;
    if (type === 'smTransition') {
      // the axis line's sketch: the one just sketched or selected, or the last unused one holding just a line;
      // none: pick a plane and sketch the line, then the transition carries on
      const isAxis = (x) => x?.type === 'sketch' && x.curves.some((c) => c.type === 'line');
      let sk = isAxis(preSketch) ? preSketch : isAxis(selF) ? selF : null;
      if (!sk) {
        const used = new Set(doc.features.flatMap((x) => M.sketchesUsedBy(x)));
        sk = doc.features.slice(0, M.rollbackIndex(doc)).reverse().find((x) => isAxis(x) && !x.suppressed && !used.has(x.id) && x.curves.filter((c) => !c.construction).length <= 1) || null;
      }
      if (!sk) {
        this.pendingFeature = { type, op, opts };
        this.pendingTool = 'line';
        this.startSketch();
        if (this.mode !== 'sketch') {
          this.status('Select a reference plane (or flat face) and sketch the axis line: from the bottom centre to the top centre (its length is the height). The transition continues when you exit the sketch.');
          this.showBanner('Select a plane to sketch the transition\'s axis line on');
        }
        return;
      }
      props.sketch = sk.id;
    }
    if (M.SKETCH_FEATURES.has(type) && !['surfPlanar','revolve','surfExtrude','surfRevolve'].includes(type)) {
      let sk = preSketch || (selF?.type === 'sketch' ? selF : null);
      if (!sk) {
        const used = new Set(doc.features.flatMap((f) => M.sketchesUsedBy(f)));
        const free = doc.features.slice(0, M.rollbackIndex(doc)).filter((f) => f.type === 'sketch' && !used.has(f.id) && !f.suppressed);
        sk = (type === 'extrude' && free.length !== 1 ? null : free[free.length - 1]) || null;
      }
      if (!sk && !(type === 'extrude' && doc.features.slice(0, M.rollbackIndex(doc)).some((f) => f.type === 'sketch' && !f.suppressed))) {
        // nothing to use: sketch the profile first (on the selected plane/face, or pick one), then come back
        this.pendingFeature = { type, op, opts };
        this.startSketch();
        if (this.mode !== 'sketch') this.status(`Select a plane or flat face to sketch the profile on; ${M.TYPE_INFO[type].base} continues when you exit the sketch.`);
        return;
      }
      props.sketch = sk?.id ?? null;
      if (type === 'extrude' && op === 'cut' && this.result.body) props.end = 'through2';
      if (type === 'extrude') {
        if (sk && S.isOpenSketch(sk)) props.thin = true; // open curves: a thin wall
        const regions = sk && LR.selectableRegions(this.result.sketches.get(sk.id)?.sketch || sk);
        props.profiles = sk ? (preSketch || selF?.id === sk.id || !regions.length ? [sk.id] : regions.length === 1 ? [LR.regionRef(sk.id, regions[0])] : []) : [];
        props.sketch = null;
      }
    }
    if(['surfPlanar','revolve','surfExtrude','surfRevolve'].includes(type)){
      const sketches=doc.features.slice(0,M.rollbackIndex(doc)).filter(f=>f.type==='sketch'&&!f.suppressed);
      const sketch=preSketch||(selF?.type==='sketch'?selF:null);
      props.profiles=[];
      if(sketch){const regions=LR.selectableRegions(this.result.sketches.get(sketch.id)?.sketch||sketch);if(regions.length===1)props.profiles=[LR.regionRef(sketch.id,regions[0])];}
      if(type==='surfPlanar'&&sel?.kind==='edge')props.edges=[{p:sel.p,...(this.result.bodies?.[sel.body]?.id?{body:this.result.bodies[sel.body].id}:{})}];
      if(!sketches.length&&!this.result.bodies?.length){this.pendingFeature={type,op,opts};this.startSketch();return;}
    }
    if(type==='loft'){
      props.profiles=[];if(!doc.features.some(f=>f.type==='sketch')){this.toast('A loft needs two or more sketches: draw the profiles on different planes first.',true);return;}
    }
    if(['sweep','surfSweep'].includes(type)){
      props.profile=null;props.path=null;props.guide=null;
      const source=preSketch||(selF?.type==='sketch'?selF:null);
      if(source){const regions=LR.selectableRegions(this.result.sketches.get(source.id)?.sketch||source);if(regions.length===1)props.profile=LR.regionRef(source.id,regions[0]);}
      if(selF&&['helix','sketch3d','compCurve','projCurve'].includes(selF.type)){props.path=selF.id;props.profileType='circle';}
    }
    if ((type === 'thread' || type === 'cosmeticThread') && sel?.kind === 'face' && !sel.face.planar) props.face = { p: sel.point || sel.face.center.toArray() };
    if (type === 'wrap' && sel?.kind === 'face') props.face = { p: sel.point || sel.face.center.toArray() };
    if (type === 'helix' && !props.sketch) {
      const withCircle = [...doc.features].reverse().find((x) => x.type === 'sketch' && x.curves?.some((c) => c.type === 'circle'));
      if (withCircle) props.sketch = withCircle.id;
    }
    if (['lpattern', 'cpattern', 'mirror', 'spattern', 'curvePattern', 'fillPattern'].includes(type)) {
      const ok = (f) => f && !M.PATTERN_SKIP.has(f.type) && !f.suppressed;
      const src = ok(selF) ? selF : [...doc.features].reverse().find(ok);
      if (!src) { this.toast('Create a feature to pattern first (e.g. an extrude, a cut, a hole or a fillet).', true); return; }
      props.feature = src.id;
      if (type === 'spattern') props.sketch = [...doc.features].reverse().find((f) => f.type === 'sketch' && !f.suppressed && f.points?.length)?.id ?? null;
      if (type === 'curvePattern') props.path = [...doc.features].reverse().find((f) => ['sketch', 'sketch3d', 'helix'].includes(f.type) && !f.suppressed && f.id !== src.sketch)?.id ?? null;
      if (type === 'fillPattern' && sel?.kind === 'face' && sel.face.planar) props.face = { p: sel.point || sel.face.center.toArray(), n: sel.face.normal.toArray() };
    }
    if (type === 'mirror') {
      const planeRef = sel?.kind === 'plane' ? sel.id : selF?.type === 'plane' ? selF.id : null;
      if (planeRef) props.plane = planeRef;
    }
    if (['plane','axis','point'].includes(type)) {
      // start from whatever is selected: a plane, a flat face, an axis or a point
      let ref = null;
      if (sel?.kind === 'plane') ref = { kind: 'plane', id: sel.id };
      else if (sel?.kind === 'face' && sel.face.planar) ref = { kind: 'face', p: sel.point || sel.face.center.toArray(), n: sel.face.normal.toArray() };
      else if (sel?.kind === 'edge') ref = { kind: 'edge', p: sel.p };
      else if (sel?.kind === 'vertex') ref = { kind: 'vertex', p: sel.p };
      else if (selF?.type === 'plane') ref = { kind: 'plane', id: selF.id };
      else if (selF?.type === 'axis') ref = { kind: 'axis', id: selF.id };
      else if (selF?.type === 'point') ref = { kind: 'point', id: selF.id };
      else if(type!=='axis'&&selF&&['helix','sketch3d','compCurve','projCurve'].includes(selF.type))ref={kind:'curve',id:selF.id};
      props.refs = ref ? [ref] : [];
      props.referenceDefinition=true;
      if(type==='axis')props.axisType='references';
      if(type==='point'&&ref)props.pointType='references';
    }
    if (type === 'fillet' || type === 'chamfer') {
      if (!this.result.body) { this.toast('There is no solid body to ' + type, true); return; }
      props.edges = sel?.kind === 'edge' ? [{ p: sel.p }] : [];
    }
    // sheet metal: features on an existing sheet metal body need one
    const sheets = (this.result?.bodies || []).filter((b) => b.sheet);
    if (['smFlange', 'smHem', 'smCornerRelief', 'smClosedCorner', 'smUnfold', 'smFold', 'smCrossBreak', 'smTabSlot', 'smForm', 'smGusset', 'smProfileFlange'].includes(type) && !sheets.length) {
      this.toast('There is no sheet metal body yet: start with a Base Flange (or Convert to Sheet Metal)', true);
      return;
    }
    if (type === 'smFlange' || type === 'smHem' || type === 'smProfileFlange') props.edges = sel?.kind === 'edge' ? [{ p: sel.p }] : [];
    if (type === 'smConvert' && sel?.kind === 'face') props.face = { p: sel.point || sel.face.center.toArray(), ...(sel.face.planar ? { n: sel.face.normal.toArray() } : {}), ...(this.result.bodies?.[sel.body]?.id ? { body: this.result.bodies[sel.body].id } : {}) };
    if (type === 'smUnfold' && sel?.kind === 'face' && sel.face.planar) props.face = { p: sel.point || sel.face.center.toArray(), n: sel.face.normal.toArray() };
    if (type === 'axis' && sel?.kind === 'edge') { props.axisType = 'edge'; props.edge = { p: sel.p }; }
    if (type === 'axis' && sel?.kind === 'face' && !sel.face.planar) { props.axisType = 'cylinder'; props.face = { p: sel.point || sel.face.center.toArray() }; }
    const selBody = sel?.kind === 'body' ? this.bodyById(sel.id) : sel?.kind === 'face' ? this.result.bodies?.[sel.body] : null;
    if (['smCornerRelief', 'smClosedCorner'].includes(type)) props.body = selBody?.sheet ? selBody.id : sheets.length === 1 ? sheets[0].id : null;
    if (type === 'smTabSlot' && sel?.kind === 'edge') props.edge = { p: sel.p };
    if (type === 'hole') {
      if (!this.result.body) { this.toast('There is no body to put holes in', true); return; }
      props.faces = sel?.kind === 'face' && sel.face.planar ? [{ p: sel.point || sel.face.center.toArray(), n: sel.face.normal.toArray() }] : [];
      if (selF?.type === 'sketch') props.sketch = selF.id;
    }
    if (type === 'structMember') {
      const isPath = (x) => x && (x.type === 'sketch' || x.type === 'sketch3d') && !x.suppressed;
      const src = isPath(selF) ? selF : [...doc.features].reverse().find(isPath);
      if (!src) { this.toast('Draw the frame first: a sketch or 3D sketch with a line for each member', true); return; }
      props.path = src.id;
      // the profile last used
      const last = [...doc.features].reverse().find((x) => x.type === 'structMember');
      if (last) Object.assign(props, { standard: last.standard, ptype: last.ptype, size: last.size, dims: { ...(last.dims || {}) }, corner: last.corner });
    }
    if (type === 'draft' || type === 'dome' || type === 'moveFace') {
      if (!this.result.body) { this.toast('There is no solid body', true); return; }
      const fr = sel?.kind === 'face' && sel.face.planar ? { p: sel.point || sel.face.center.toArray(), n: sel.face.normal.toArray() } : null;
      if (type === 'draft') props.face = fr; else props.faces = fr ? [fr] : [];
    }
    if (type === 'smCrossBreak') props.faces = sel?.kind === 'face' && sel.face.planar ? [{ p: sel.point || sel.face.center.toArray(), n: sel.face.normal.toArray() }] : [];
    if (type === 'shell' || type === 'surfOffset' || type === 'surfCopy') {
      if (!this.result.body && type === 'shell') { this.toast('There is no solid body to shell', true); return; }
      props.faces = sel?.kind === 'face' ? [{ p: sel.point || sel.face.center.toArray(), ...(sel.face.planar ? { n: sel.face.normal.toArray() } : {}) }] : [];
    }
    if (type === 'combine') {
      if ((this.result.bodies || []).filter((b) => b.kind !== 'surface').length < 2) { this.toast('Combine needs at least two solid bodies (untick Merge result on a boss to make a separate body)', true); return; }
      props.main = selBody?.kind === 'solid' ? selBody.id : null;
    }
    if (type === 'knit' || type === 'surfSolid' || type === 'meshRepair') props.bodies = selBody?.kind === 'surface' ? [selBody.id] : (type !== 'knit' && (this.result.bodies || []).filter((x) => x.kind === 'surface').length === 1 ? [(this.result.bodies || []).find((x) => x.kind === 'surface').id] : []);
    if (type === 'thicken') props.body = selBody?.kind === 'surface' ? selBody.id : (this.result.bodies || []).find((b) => b.kind === 'surface')?.id ?? null;
    if (type === 'moveBody') props.bodies = selBody && (!opts.surfaces || selBody.kind === 'surface') ? [selBody.id] : [];
    if (type === 'deleteBody') props.bodies = selBody ? [selBody.id] : [];
    if (type === 'deleteSurface') props.bodies = selBody?.kind === 'surface' ? [selBody.id] : [];
    if ((type === 'deleteBody' || type === 'deleteSurface') && !(this.result.bodies || []).some((b) => type === 'deleteBody' || b.kind === 'surface')) {
      this.toast(type === 'deleteSurface' ? 'There are no surface bodies to delete' : 'There are no bodies to delete', true);
      return;
    }
    if (type === 'split') props.bodies = selBody?.kind === 'solid' ? [selBody.id] : [];
    if (type === 'split' && sel?.kind === 'plane') props.tool = sel.id;
    if (type === 'split' && selF?.type === 'plane') props.tool = selF.id;
    if (type === 'point' && sel?.kind === 'vertex') { props.pointType = 'vertex'; props.vertex = { p: sel.p }; }
    if (type === 'sketch3d' && sel?.kind === 'vertex') { const q = (sel.p.toArray ? sel.p.toArray() : sel.p).map((x) => +x.toFixed(6)); props.pts = [{ x: q[0], y: q[1], z: q[2] }]; }
    const f = M.createFeature(doc, type, props);
    if (this.units === 'in') this.ui.inchDefaults(f); // (default sizes in round inches)
    M.insertFeature(doc, f);
    this.pm = { kind: 'feature', feature: f, isNew: true };
    this.selection = null;
    this.viewport.clearFaceHighlights();
    this.rebuild();
    this.ui.renderPM();
    this.ui.refreshCommandStates();
    this.status(`${f.name}: set parameters, then click ✔ (or press Enter).`);
  }

  // Cutting, combining or rounding a body made of tens of thousands of mesh triangles (an imported STL)
  // can take minutes: say so up front (the Stop button gets you out).
  warnDenseMesh(type) {
    const HEAVY = ['extrude', 'revolve', 'sweep', 'loft', 'hole', 'combine', 'fillet', 'chamfer', 'shell', 'draft', 'split', 'intersect', 'thicken', 'cosmeticThread', 'thread', 'wrap', 'emboss'];
    if (!HEAVY.includes(type)) return;
    const dense = (this.result?.bodies || []).filter((b) => b.kind === 'solid' && b.faceCount > 20000);
    if (!dense.length) return;
    const n = Math.max(...dense.map((b) => b.faceCount));
    this.toast(`Heads up: ${dense.length > 1 ? 'some bodies are' : (dense[0].name || dense[0].defaultName) + ' is'} an imported mesh with ${n.toLocaleString()} faces. Cutting or joining it can take several minutes. If it runs too long, click Stop.`);
  }

  editFeature(id) {
    const f = M.findFeature(this.doc, id);
    if (!f) return;
    if (f.type === 'sketch') return this.editSketch(id);
    if (f.type === 'sketch3d') return this.editSketch3D(id);
    this.collapseExplode();
    if (M.isRolledBack(this.doc, f)) { this.toast(`${f.name} is below the rollback bar — drag the bar below it (or right-click ▸ Roll to End) to edit it`, true); return; }
    breadcrumb(`Edit feature: ${f.name}`);
    if (this.mode === 'sketch') this.exitSketch(true);
    if (this.mode === 'sketch3d') this.exitSketch3D(true);
    if (this.pm) this.cancelPM();
    this.pm = { kind: 'feature', feature: f, isNew: false, snapshot: JSON.stringify(f) };
    if (f.type === 'plane' && !Array.isArray(f.refs)) f.refs = [{ kind: 'plane', id: f.base || 'front' }]; // older files

    this.selection = null;
    this.rebuild();
    this.ui.renderPM();
    this.ui.refreshCommandStates();
    this.status(`Editing ${f.name}`);
  }

  preview(rerenderPM = false) {
    if (rerenderPM) this.ui.renderPM();
    if(this.pm?.feature?.referenceDefinition)this.ui.updatePMStatus();
    clearTimeout(this._previewTimer);
    this._previewTimer = setTimeout(() => this.rebuild(), rerenderPM ? 0 : 70); // rebuilds are incremental, so previews can follow typing closely
  }

  async okPM() {
    if (this.pm?.loftDraft?.curves.length) { this.toast('Add or clear the current contour selection before accepting the feature', true); return; }
    if (this.mode === 'sketch' && this.sketcher.patternDraft) { this.sketcher.finishPattern(true); return; }
    const pm = this.pm;
    if (!pm) return;
    if (pm.kind === 'sketch') return this.exitSketch(true);
    if (pm.kind === 'sketch3d') return this.exitSketch3D(true);
    if (pm.kind === 'explode') return this.explodeTool?.close(true);
    if (pm.kind === 'selectPlane' || pm.kind === 'measure') return this.cancelPM();
    if (pm.kind === 'section') {
      // (a view of the model only: the cut stays, its arrow goes; nothing is built again)
      this.pm = null;
      this.viewport.setSectionArrow(null);
      this.ui.renderPM();
      this.ui.refreshCommandStates();
      this.status('Ready');
      return;
    }
    if(pm.kind==='feature'&&(pm.feature.referenceDefinition&&['plane','axis','point'].includes(pm.feature.type)||['loft','surfLoft'].includes(pm.feature.type)&&LC.hasManualConnections(pm.feature))){
      clearTimeout(this._previewTimer);await this.rebuild();
      if(this.pm!==pm)return;
      const error=this.result.errors.get(pm.feature.id);if(error){this.toast(error,true);return;}
    }
    clearTimeout(this._previewTimer);
    this.pm = null;
    this.hoverEdge = null;
    this.hoverVertex = null;
    this.viewport.setFaceSet([]);
    if (pm.kind === 'section') this.viewport.setSectionArrow(null); // (the section stays on; its arrow goes)
    if (pm.kind === 'feature') {
      breadcrumb(`OK feature: ${pm.feature.name} ${JSON.stringify(pm.feature).slice(0, 300)}`);
      this.commit();
      this.selection = { kind: 'feature', id: pm.feature.id };
    }
    await this.refresh();
    const err = pm.kind === 'feature' && this.result.errors.get(pm.feature.id);
    if (err) this.toast(`${pm.feature.name}: ${err}`, true);
    this.status('Ready');
  }

  cancelPM() {
    if (this.mode === 'sketch' && this.sketcher.patternDraft) { this.sketcher.finishPattern(false); return; }
    const pm = this.pm;
    if (!pm) return;
    breadcrumb(`Cancel: ${pm.kind}${pm.feature ? ' ' + pm.feature.name : ''}`);
    if (pm.kind === 'sketch') return this.exitSketch(false);
    if (pm.kind === 'sketch3d') return this.exitSketch3D(true);
    if (pm.kind === 'explode') return this.explodeTool?.close(false);
    if (pm.kind === 'section') { this.clearSection(); this.status('Ready'); return; } // (the cut taken away; nothing built again)
    clearTimeout(this._previewTimer);
    this.pm = null;
    this.viewport.setFaceSet([]);
    if (pm.kind === 'feature') {
      if (pm.isNew) this.doc.features = this.doc.features.filter((f) => f !== pm.feature);
      else {
        const orig = JSON.parse(pm.snapshot);
        for (const k of Object.keys(pm.feature)) delete pm.feature[k];
        Object.assign(pm.feature, orig);
      }
    }
    if (pm.kind === 'section') this.clearSection();
    if (pm.kind === 'measure') { this.viewport.setMeasure(null); this.viewport.setPointMarks('measure-picks', null); this.viewport.setPointMarks('measure-hover', null); }
    if (pm.kind === 'selectPlane') { this.pendingTool = null; this.pendingFeature = null; this.pendingGears = false; this.pendingAirfoil = false; this.showBanner(null); }
    this.hoverEdge = null;
    this.hoverVertex = null;
    this.refresh();

    this.status('Ready');
  }

  deleteSelection() {
    if (this.mode === 'sketch') return this.sketcher.deleteSelected();
    if (this.mode === 'sketch3d') return this.sketch3d.deleteSelected();
    if (this.selection?.kind === 'feature') this.deleteFeature(this.selection.id);
  }

  deleteFeature(id) {
    if (this.pm) this.cancelPM();
    const doc = this.doc, f = M.findFeature(doc, id);
    if (!f) return;
    const toDelete = new Set([f.id]);
    if (f.sketch && M.consumersOf(doc, f.sketch).length === 1) toDelete.add(f.sketch);
    const deps = doc.features.filter((x) => !toDelete.has(x.id) && [...toDelete].some((d) => M.dependentsOf(doc, d).includes(x)));
    if (deps.length && !confirm(`Delete ${f.name}?\n\nThese features depend on it and will show errors:\n• ${deps.map((d) => d.name).join('\n• ')}`)) return;
    if (doc.rollbackAt && toDelete.has(doc.rollbackAt)) {
      const i = doc.features.findIndex((x) => x.id === doc.rollbackAt);
      doc.rollbackAt = doc.features.slice(i).find((x) => !toDelete.has(x.id))?.id ?? null;
    }
    doc.features = doc.features.filter((x) => !toDelete.has(x.id));
    this.selection = null;
    this.commit();
    this.refresh();
    this.status(`Deleted ${f.name}` + (toDelete.size > 1 ? ' and its sketch' : '') + '. Ctrl+Z to undo.');
  }

  // ------------------------------------------------------------ tree editing
  // what: { kind: 'feature', id } or { kind: 'bar' }; beforeId: drop before this feature (null = the end)
  treeDrop(what, beforeId) {
    const doc = this.doc;
    if (what.kind === 'bar') return this.setRollback(beforeId);
    const f = M.findFeature(doc, what.id);
    if (!f) return;
    // a feature moves together with the sketches it absorbed
    const group = [...M.absorbedSketches(doc, f), f, ...doc.features.filter((x) => x.parent === f.id)].sort((x, y) => doc.features.indexOf(x) - doc.features.indexOf(y)).map((x) => x.id);
    if (beforeId && group.includes(beforeId)) return;
    const next = doc.features[doc.features.indexOf(M.findFeature(doc, group[group.length - 1])) + 1];
    if (next && next.id === beforeId) return; // already there
    const problem = M.moveProblem(doc, group, beforeId);
    if (problem) { this.toast(`Can't move ${f.name} there: ${problem}`, true); return; }
    if (doc.rollbackAt && group.includes(doc.rollbackAt)) doc.rollbackAt = next?.id ?? null;
    M.moveFeatures(doc, group, beforeId);
    this.commit();
    this.refresh();
    this.status(`Moved ${f.name}. Ctrl+Z to undo.`);
  }

  // Put the rollback bar just before feature `id` (null: at the end).
  setRollback(id) {
    if (this.pm) this.cancelPM();
    if (this.mode === 'sketch') this.exitSketch(true);
    if (this.mode === 'sketch3d') this.exitSketch3D(true);
    const doc = this.doc;
    const last = doc.features[doc.features.length - 1];
    doc.rollbackAt = id && M.findFeature(doc, id) ? id : null;
    if (!last) doc.rollbackAt = null;
    this.selection = null;
    this.commit();
    this.refresh();
    this.status(doc.rollbackAt ? `Rolled back to before ${M.findFeature(doc, doc.rollbackAt).name}. New features are inserted above the bar; drag it to the bottom to roll forward.` : 'Rolled forward to the end.');
  }

  newBodyFolder(kind, name = null, bodyIds = []) {
    const g = M.newBodyFolder(this.doc, kind, name);
    for (const id of bodyIds) M.putBodyInFolder(this.doc, id, g.id);
    this.commit();
    this.ui.renderTree();
    this.ui.renameFolder(g.id);
  }

  moveBodyToFolder(bodyId, folderId) {
    M.putBodyInFolder(this.doc, bodyId, folderId);
    this.commit();
    this.ui.renderTree();
  }

  deleteBodyFolder(id) {
    this.doc.bodyFolders = (this.doc.bodyFolders || []).filter((g) => g.id !== id);
    this.commit();
    this.ui.renderTree();
  }

  // Fix References: drop a feature's references that are no longer found in the model (the rest are kept).
  // Returns how many were removed.
  removeMissingRefs(id) {
    const f = M.findFeature(this.doc, id), paths = this.result?.missing?.get(id) || [];
    if (!f) return 0;
    if (this.pm) this.cancelPM();
    // (from the end of each list, so the other places in it stay right)
    const items = paths.filter((p) => typeof p[p.length - 1] === 'number').sort((x, y) => y[y.length - 1] - x[x.length - 1]);
    let n = 0;
    for (const p of items) {
      const list = p.slice(0, -1).reduce((o, k) => o?.[k], f);
      if (Array.isArray(list) && p[p.length - 1] < list.length) { list.splice(p[p.length - 1], 1); n++; }
    }
    if (!n) return 0;
    this.commit();
    this.refresh();
    this.status(`${f.name}: ${n} missing reference${n > 1 ? 's' : ''} removed.`);
    return n;
  }

  toggleSuppress(id) {
    if (this.pm) this.cancelPM();
    const f = M.findFeature(this.doc, id);
    if (!f) return;
    const c = this.activeConfig();
    if (c) {
      // (in a configuration: just this configuration; the feature keeps its own state for the others)
      const now = this.isSuppressed(f);
      c.suppressed = (c.suppressed || []).filter((x) => x !== id);
      c.unsuppressed = (c.unsuppressed || []).filter((x) => x !== id);
      if (!now !== !!f.suppressed) (now ? c.unsuppressed : c.suppressed).push(id);
      this.status(`${f.name} ${now ? 'unsuppressed' : 'suppressed'} in ${c.name}.`);
    } else f.suppressed = !f.suppressed;
    this.commit();
    this.refresh();
    this.ui.renderConfigs?.();
  }

  // ------------------------------------------------------------ view helpers
  normalToSelection() {
    if (this.mode === 'sketch') return this.sketcher.normalTo();
    const s = this.selection;
    let frame = null;
    if (s?.kind === 'plane') frame = G.stdFrame(s.id);
    else if (s?.kind === 'face') frame = this.faceFrame(s.face);
    else if (s?.kind === 'feature') frame = this.result.planes.get(s.id) || this.result.sketches.get(s.id)?.frame;
    if (frame) this.viewport.normalTo(frame);
    else this.toast('Select a plane, flat face or sketch first');
  }

  togglePlanes() {
    this.setVisibility('stdPlanes', !this.showPlanes);
  }

  startSection() {
    if (this.mode === 'sketch') { this.toast('Exit the sketch before using Section View'); return; }
    // a plane or flat face selected: the section starts there (in an assembly: a component's flat face)
    const from = this.mode === 'drawing' ? this.drawing?.sectionPlaneOf?.() || null : this.sectionPlaneOf(this.selection);
    if (this.pm) this.cancelPM();
    if (from) Object.assign(this.sectionState, from, { offset: 0, active: 0 });
    this.pm = { kind: 'section', section: this.sectionState };
    this.applySection();
    this.ui.renderPM();
    this.ui.refreshCommandStates();
    this.status('Section View: drag the arrow (or set the offset); click a flat face or a plane to cut from it instead.');
  }

  // The Section View panel opened again on the cut as it is (the cut kept after OK)
  reopenSection() {
    if (this.pm) this.cancelPM();
    this.pm = { kind: 'section', section: this.sectionState };
    this.applySection();
    this.ui.renderPM();
    this.ui.refreshCommandStates();
    this.status('Section View: drag the arrow (or set the offset); OK keeps the cut, ✗ removes it.');
  }

  // The section plane of what is selected or clicked: a standard plane, a reference plane, a sketch's plane or a
  // flat face ({ plane, custom }); null for anything else.
  sectionPlaneOf(sel) {
    if (!sel) return null;
    const v = (x) => (x?.isVector3 ? x.clone() : new THREE.Vector3(...x));
    if (sel.kind === 'plane') {
      if (G.STD_PLANES[sel.id]) return { plane: sel.id, custom: null };
      const fr = this.result?.planes?.get(sel.id);
      return fr ? { plane: 'custom', custom: { o: v(fr.o), n: v(fr.n).normalize(), name: this.doc.features.find((x) => x.id === sel.id)?.name || 'Plane' } } : null;
    }
    if (sel.kind === 'feature') {
      const fr = this.result?.planes?.get(sel.id) || this.result?.sketches?.get(sel.id)?.frame;
      const f = this.doc.features.find((x) => x.id === sel.id);
      return fr ? { plane: 'custom', custom: { o: v(fr.o), n: v(fr.n).normalize(), name: f?.name || 'Plane' } } : null;
    }
    if (sel.kind === 'face' && sel.face?.planar) {
      const fr = this.faceFrame(sel.face);
      return { plane: 'custom', custom: { o: fr.o.clone(), n: fr.n.clone().normalize(), name: 'Selected face' } };
    }
    return null;
  }

  // The section's plane before its offset: { o (a point on it), n } (THREE.Vector3)
  sectionFrame(s = this.sectionState) {
    if (s.plane === 'custom' && s.custom) return { o: s.custom.o, n: s.custom.n };
    const f = G.stdFrame(s.plane);
    return { o: f.o, n: f.n };
  }
  sectionOffset(s = this.sectionState) {
    try { return evaluate(s.offset, this.result?.vars || {}); } catch { return 0; }
  }
  // how far the model reaches along the section's normal, from its plane: [lo, hi] (for the slider)
  sectionRange(s = this.sectionState) {
    const b = this.viewport.contentBox();
    if (!b) return [-100, 100];
    const { o, n } = this.sectionFrame(s), base = n.dot(o);
    let lo = Infinity, hi = -Infinity;
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
      const d = n.x * x + n.y * y + n.z * z - base;
      lo = Math.min(lo, d); hi = Math.max(hi, d);
    }
    return [Math.floor(lo - 1), Math.ceil(hi + 1)];
  }

  // The section the arrow and a click in the view move (Section 1, or 2 / 3 when ticked)
  activeSection(s = this.sectionState) {
    const q = s.active ? s.more?.[s.active - 1] : null;
    return q?.on ? q : s;
  }

  applySection() {
    const s = this.pm?.kind === 'section' ? this.pm.section : this.sectionState;
    this.sectionState = s;
    // each plane: what is on its back side is cut away (with several, only what all of them cut away)
    const one = (q) => {
      const { o, n } = this.sectionFrame(q), d = n.dot(o) + this.sectionOffset(q);
      return { n, d, normal: q.flip ? n.clone() : n.clone().negate(), constant: q.flip ? -d : d };
    };
    const all = [s, ...(s.more || []).filter((q) => q.on)].map(one);
    this.viewport.setSection({ normal: all[0].normal, constant: all[0].constant, more: all.slice(1).map(({ normal, constant }) => ({ normal, constant })) });
    // the arrow (while the Section View panel is open): on the active cut, across from the model's middle
    const box = this.viewport.contentBox();
    if (this.pm?.kind === 'section' && box) {
      const { n, d } = one(this.activeSection(s));
      const c = box.getCenter(new THREE.Vector3()), p = c.clone().addScaledVector(n, d - n.dot(c));
      this.viewport.setSectionArrow({ p, n });
    } else this.viewport.setSectionArrow(null);
    this.ui.renderHUD();
  }

  // Dragging the section arrow: the offset follows the mouse along the section's normal, in round steps.
  // A Linear or Circular Pattern of a feature folder: started with the folder as what it copies.
  patternFolder(folderId, type) {
    const g = (this.doc.featureFolders || []).find((x) => x.id === folderId);
    if (!g) return;
    this.startFeature(type);
    const f = this.pm?.feature;
    if (f?.type !== type) return;
    f.feature = null;
    f.features = ['folder:' + g.id];
    this.ui.renderPM(); this.preview(true);
  }

  // ------------------------------------------------------------ a variable fillet's points, dragged along their edges
  // Each point of the fillet's edgePoints on the model: { p (world), vi (the edge as drawn), P (its points), L (the
  // lengths up to them) } or null (its edge not found, its place not a number). The place is the share of the edge's
  // drawn length from its start, as a click puts it (applyModelPick).
  filletPoints(f) {
    if (f?.type !== 'fillet' || f.filletType !== 'variable' || f.radiusMode !== 'vertices' || !f.edgePoints?.length) return null;
    const vp = this.viewport;
    return f.edgePoints.map((x) => {
      const ref = f.edges?.[x.edge], vi = ref ? vp.edgeIndexForPoint(ref.p) : -1, e = vp.edgeList?.[vi];
      if (!e) return null;
      const P = e.pts, L = [0];
      for (let i = 1; i < P.length; i++) L.push(L[i - 1] + P[i].distanceTo(P[i - 1]));
      const total = L[L.length - 1] || 1, t = Number(x.t);
      if (!Number.isFinite(t)) return null;
      const s = Math.max(0, Math.min(total, x.unit === 'mm' ? t : (t / 100) * total));
      let k = 1;
      while (k < P.length - 1 && L[k] < s) k++;
      const u = (s - L[k - 1]) / ((L[k] - L[k - 1]) || 1);
      return { p: P[k - 1].clone().lerp(P[k], Math.max(0, Math.min(1, u))).toArray(), vi, P, L };
    });
  }
  filletPointDown(e) {
    if (this.mode !== 'part' || this.pm?.kind !== 'feature' || e.button !== 0) return false;
    const pts = this.filletPoints(this.pm.feature);
    if (!pts) return false;
    const vp = this.viewport, m = vp.screenPos(e);
    let best = -1, bd = 9;
    pts.forEach((x, i) => { if (!x) return; const s = vp.project(new THREE.Vector3(...x.p)), d = Math.hypot(s.x - m.x, s.y - m.y); if (d < bd) { bd = d; best = i; } });
    if (best < 0) return false;
    vp.controls.drag = null; // (the press moves the point: no view rotation)
    try { vp.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this._fpDrag = { i: best };
    this.status('Drag the point along its edge; let go to rebuild.');
    return true;
  }
  filletPointMove(e) {
    const d = this._fpDrag;
    if (!d) return false;
    const f = this.pm?.feature, x = f?.edgePoints?.[d.i], at = this.filletPoints(f)?.[d.i];
    if (!x || !at) return true;
    // (the place along the edge nearest the cursor, as the screen shows the edge)
    const vp = this.viewport, m = vp.screenPos(e), { P, L } = at;
    let s = 0, bd = Infinity;
    for (let i = 1; i < P.length; i++) {
      const a = vp.project(P[i - 1]), b = vp.project(P[i]), dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const u = l2 ? Math.max(0, Math.min(1, ((m.x - a.x) * dx + (m.y - a.y) * dy) / l2)) : 0;
      const dd = Math.hypot(m.x - (a.x + u * dx), m.y - (a.y + u * dy));
      if (dd < bd) { bd = dd; s = L[i - 1] + u * (L[i] - L[i - 1]); }
    }
    const total = L[L.length - 1] || 1, pct = Math.max(0.1, Math.min(99.9, (100 * s) / total));
    x.t = x.unit === 'mm' ? +((pct / 100) * total).toFixed(2) : +pct.toFixed(2);
    this.updateEdgeHighlights();
    this.status(`Point ${d.i + 1}: ${x.unit === 'mm' ? `${x.t} mm` : `${x.t} %`} along edge ${x.edge + 1}`);
    return true;
  }
  filletPointUp() {
    if (!this._fpDrag) return false;
    this._fpDrag = null;
    this.ui.renderPM(); this.updateEdgeHighlights(); this.preview();
    return true;
  }

  sectionDragDown(e) {
    if (this.pm?.kind !== 'section' || e.button !== 0 || !this.viewport.sectionArrowAt(e)) return false;
    const vp = this.viewport, q = this.activeSection(), { n } = this.sectionFrame(q);
    vp.controls.drag = null; // (the press moves the cut: no view rotation)
    try { vp.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    // (dragged along the normal as the screen shows it; seen end on, up the screen is toward the viewer: dragAlong)
    this._secDrag = { q, n: n.clone().normalize(), o: vp._secArrow.group.position.clone(), from: { clientX: e.clientX, clientY: e.clientY }, off0: this.sectionOffset(q) };
    return true;
  }
  sectionDragMove(e) {
    const d = this._secDrag;
    if (!d) return false;
    const vp = this.viewport;
    const step = 10 ** Math.ceil(Math.log10(Math.max(1e-6, vp.worldPerPixel())));
    const off = Math.round(Math.round((d.off0 + vp.dragAlong(d.n, d.o, d.from, e)) / step) * step * 1e6) / 1e6;
    if (off !== d.q.offset) {
      d.q.offset = off;
      this.applySection();
      this.ui.updateSectionOffset?.(off, d.q === this.sectionState ? 0 : this.sectionState.more.indexOf(d.q) + 1);
    }
    return true;
  }
  sectionDragUp() {
    if (!this._secDrag) return false;
    this._secDrag = null;
    this.ui.renderPM();
    return true;
  }

  // The section view as a file keeps it (doc.section: a part or assembly saved with the cut on; a tab keeps it too):
  // the planes, offsets and flips, a picked plane's point and normal as numbers. null when there is no cut.
  sectionForFile() {
    if (!this.viewport.section) return null;
    const arr = (x) => (Array.isArray(x) ? [...x] : [x.x, x.y, x.z]);
    const one = ({ more: _m, ...q }) => ({ ...q, custom: q.custom ? { o: arr(q.custom.o), n: arr(q.custom.n), name: q.custom.name } : null });
    const s = this.sectionState;
    return { ...one(s), more: (s.more || []).map(one) };
  }
  // A section kept in a file (or a tab) put back, as after OK: the cut on, its panel closed.
  restoreSection(saved) {
    if (!saved?.plane) return false;
    const v = (x) => new THREE.Vector3(...x);
    const one = (q, def) => ({ ...def, ...(q || {}), custom: q?.custom?.o && q.custom.n ? { o: v(q.custom.o), n: v(q.custom.n).normalize(), name: q.custom.name || 'Plane' } : null });
    const s = this.sectionState;
    this.sectionState = { ...one(saved, s), active: saved.active || 0, more: s.more.map((d, i) => one(saved.more?.[i], d)) };
    if (this.pm?.kind === 'section') this.pm = null;
    this.applySection();
    this.ui.refreshCommandStates();
    return true;
  }

  clearSection() {
    this.viewport.setSectionArrow(null);
    this.viewport.setSection(null);
    if (this.pm?.kind === 'section') this.pm = null;
    this.ui.renderPM();
    this.ui.refreshCommandStates();
  }

  // ------------------------------------------------------------ undo / files
  undo() {
    if (this.mode === 'sketch') { this.sketcher.undo(); return; }
    if (this.mode === 'sketch3d') { this.sketch3d.undo(); return; }
    if (this.pm) this.cancelPM();
    const prev = this.history.stack[this.history.idx];
    const d = this.history.undo();
    if (!d) return;
    this.doc = d;
    this.macros?.sync(prev);
    this.selection = null;
    this.dirty = true;
    this.refresh();
    this.updateTitle();
    this.status('Undo');
  }

  redo() {
    if (this.mode === 'sketch') { this.sketcher.redo(); return; }
    if (this.mode === 'sketch3d') { this.sketch3d.redo(); return; }
    if (this.pm) this.cancelPM();
    const prev = this.history.stack[this.history.idx];
    const d = this.history.redo();
    if (!d) return;
    this.doc = d;
    this.macros?.sync(prev);
    this.selection = null;
    this.dirty = true;
    this.refresh();
    this.updateTitle();
    this.status('Redo');
  }

  newDocument() {
    this.beginTab();
    this.cancelAutosave();
    const doc = M.newDoc();
    if (this.ui.prefs?.upAxis === 'z') doc.upAxis = 'z';
    // a new part in another tab gets the next free name
    const names = new Set(this.tabs.map((t, i) => (i === this.tabIndex ? null : t.doc?.name)).filter(Boolean));
    for (let n = 1; names.has(doc.name); n++) doc.name = 'Part' + n;
    this.setDoc(doc);
    this.filePath = null;
    this.updateTitle();
    this.status('New part. Select a plane in the tree (e.g. Top Plane) and click Sketch.');
  }

  openSample() {
    this.beginTab();
    this.cancelAutosave();
    this.setDoc(M.sampleDoc());
    this.filePath = null;
    this.updateTitle();
  }

  // The example part of the tutorial in the manual (splines, a guided loft, a variable fillet, a sheet metal tray).
  openExample() {
    this.beginTab();
    this.cancelAutosave();
    this.setDoc(M.exampleDoc());
    this.filePath = null;
    this.updateTitle();
  }

  // Only one file is opened at a time (repeated clicks while a part loads are ignored).
  async openGuarded(fn) {
    if (this._opening) { this.status('Still opening the previous file…'); return null; }
    this._opening = true;
    try { return await fn(); } finally { this._opening = false; }
  }

  async openFile() {
    return this.openGuarded(async () => {
      let file;
      try { file = await platform.openText(); } catch (err) { this.toast('Could not open file: ' + err.message, true); return false; }
      if (!file) return false;
      if (file.format) { await this.handleImport(file, { asPart: true }); return true; } // a STEP or STL file: a new part
      return this.openFromFile(file);
    });
  }

  // Open a part from the recent-files list.
  // choice: 'recover' (open the auto-saved version), 'saved' (discard it) or undefined (ask)
  async openRecent(path, choice) {
    // already open in a tab: just go there
    const open = this.tabOfPath(path);
    if (open >= 0 && !choice) { await this.activateTab(open); this.status(`${path.split(/[\\/]/).pop()} is already open`); return true; }
    return this.openGuarded(async () => {
      let file;
      try { file = await platform.openPath(path); } catch (err) { this.toast('Could not open file: ' + (err?.message || err), true); return false; }
      if (file.format) { await this.handleImport(file, { asPart: true }); return true; } // a STEP, IGES or mesh file (opened from Windows): a new part
      return this.openFromFile(file, choice);
    });
  }

  // The tab holding the part saved at `path` (Windows paths: case and slashes don't matter), or -1.
  tabOfPath(path) {
    if (!path) return -1;
    const norm = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();
    const want = norm(path);
    return this.tabs.findIndex((t, i) => norm(t.kind === 'drawing' ? t.drawing.filePath : i === this.tabIndex ? this.filePath : t.filePath) === want);
  }

  // Load a part file; if it has a newer auto-save (changes that were never saved), offer it.
  async openFromFile(file, preset) {
    // an auto-save file opened directly: recover it into its part (unsaved until saved)
    let content = file.content, recovered = !!file.fromAutosave;
    if (file.autosave) {
      const when = new Date(file.autosave.modified).toLocaleString();
      const choice = preset || await this.ui.choose('Recover Auto-Save', 'part',
        `<p><b>${file.name.replace(/[<>&]/g, '')}</b> has an auto-saved version from <b>${when}</b> with changes that were never saved.</p><p class="pm-hint">The auto-save is kept next to the part until you save it again.</p>`,
        [['recover', 'Recover the auto-saved version', true], ['saved', 'Open the last saved version']]);
      if (choice === 'recover') { content = file.autosave.content; recovered = true; }
      else if (choice === 'saved') await platform.discardAutosave(file.path);
      else return false;
    }
    // already open in a tab: go there
    const open = this.tabOfPath(file.path);
    if (open >= 0 && !recovered) { await this.activateTab(open); this.status(`${file.name} is already open`); return true; }
    try {
      const doc = M.stripThumbnail(JSON.parse(content));
      if (isAssembly(doc)) {
        this.openAssemblyTab(doc, file.path || null);
        this.status(`Opened ${file.name}`);
        breadcrumb(`Opened assembly: ${file.path || file.name}`);
        return true;
      }
      if (isTemplate(doc)) {
        const dwg = drawingFromTemplate(doc, { name: doc.name });
        dwg.isTemplate = true;
        dwg.templateDescription = doc.description || '';
        dwg.props = { ...dwg.props, date: '' };
        this.openDrawingTab(dwg, file.path || null);
        this.status(`Editing the drawing template ${file.name}: change its sheets, title block and notes, then Save.`);
        breadcrumb(`Opened drawing template: ${file.path || file.name}`);
        return true;
      }
      if (D.isDrawing(doc)) {
        doc.nextId ??= 1;
        this.openDrawingTab(doc, file.path || null);
        this.status(`Opened ${file.name}`);
        breadcrumb(`Opened drawing: ${file.path || file.name}`);
        return true;
      }
      if (!Array.isArray(doc.features)) throw new Error('Not a RazorCAD part file');
      doc.equations ??= [];
      M.renameLegacyNames(doc); // (features still carrying an old default name get the current one)
      doc.nextId ??= doc.features.length + 1;
      // (the browser version's files have no path: kept by their content alone)
      const stored = (file.path || (!platform.desktop && platform.modelStore)) && !recovered ? await this.readModelCache(doc) : { key: null, r: null };
      if (file.path && M.isDefaultName(doc.name)) doc.name = M.fileStem(file.path); // (a part still called "Part1": its file's name)
      // the state after each feature as last built: the kernel picks up from it instead of building them all
      // (read and handed to the kernel while the stored model is shown: the kernel takes its requests in order, so
      // the rebuild that follows picks up from them)
      const statesP = stored.r ? this.readKernelStates(stored.key).then((snaps) => (snaps ? this.kernel.request('importSnaps', { snaps }).catch(() => false) : false)) : Promise.resolve(false);
      this.beginTab();
      this.cancelAutosave();
      this._firstBuild = { doc, t0: performance.now() };
      const statesFirst = statesP.then(() => {});
      await this.withProgress(`Opening ${file.name}…`, () => this.setDoc(doc, { cached: stored.r, before: statesFirst }));
      // (saved with a section view: the cut on again; else none, whatever the part before had)
      if (!this.restoreSection(doc.section) && this.viewport.section) this.clearSection();
      const states = await statesP;
      this._fileKey = recovered ? null : stored.key;
      this._cachedKey = stored.r ? stored.key : null;
      this._statesKey = states ? stored.key : null;
      if (states) breadcrumb(`Feature states restored: ${file.name}`);
      if (stored.r) breadcrumb(`Opened from the stored model: ${file.name}`);
      this.filePath = file.path;
      // (built just now, before it had its file: store it for the next time)
      if (!stored.r && !recovered && this._model?.doc === doc) this.keepModel(this._model.r);
      if (recovered) this.dirty = true;
      this.updateTitle();
      this.status(recovered ? `Recovered the auto-saved version of ${file.name} — save to keep it.` : `Opened ${file.name}`);
      breadcrumb(`Opened: ${file.path || file.name}${recovered ? ' (auto-save recovered)' : ''}`);
      rememberPart(this, true);
      return true;
    } catch (err) {
      this.toast('Could not open file: ' + err.message, true);
      return false;
    }
  }

  // The unsaved session kept by earlier versions of RazorCAD (offered in the start window).
  async recoverLegacySession() {
    try {
      const text = await platform.loadLegacySession();
      if (!text) { this.toast('There is no previous session to recover'); return false; }
      const parsed = JSON.parse(text);
      const doc = parsed.doc ?? parsed;
      if (!Array.isArray(doc.features)) throw new Error('The previous session is damaged');
      this.beginTab();
      this.cancelAutosave();
      await this.setDoc(doc);
      this.filePath = parsed.path || null;
      this.dirty = true;
      this.updateTitle();
      await platform.retireLegacySession();
      this.status('Recovered your previous session. Save it to keep it (auto-save starts once it is saved).');
      return true;
    } catch (err) {
      this.toast('Could not recover the previous session: ' + err.message, true);
      return false;
    }
  }

  safeName() {
    return this.doc.name.replace(/[^\w\- ]+/g, '_') || 'Part';
  }

  async saveFile(saveAs = false) {
    if (this.mode === 'drawing') return this.drawing.save(saveAs);
    if (this.mode === 'sketch') this.exitSketch(true);
    if (this.mode === 'sketch3d') this.exitSketch3D(true);
    if (this.pm) this.okPM();
    try {
      let thumb = null;
      try { thumb = this.viewport.snapshot(); } catch { /* saved without a preview */ }
      // (the section view as it is: opened with the cut on again)
      const sec = this.sectionForFile();
      if (sec) this.doc.section = sec; else delete this.doc.section;
      const path = await platform.saveText(`${this.safeName()}${M.PART_EXT}`, M.docJSON(this.doc, thumb, 2), saveAs ? null : this.filePath, this.filePath);
      if (!path) return;
      if (platform.desktop) this.filePath = path;
      if (platform.desktop && M.isDefaultName(this.doc.name) && M.fileStem(path) !== this.doc.name) {
        // (saved under a name of its own: the part takes it, in the file too)
        this.doc.name = M.fileStem(path);
        await platform.saveText(`${this.safeName()}${M.PART_EXT}`, M.docJSON(this.doc, thumb, 2), path, path);
      }
      this._fileKey = await this.docKey(this.doc);
      if (this._model?.doc === this.doc) { this.dirty = false; this.keepModel(this._model.r); }
      this.cancelAutosave(); // saving removes the auto-save file
      breadcrumb(`Saved: ${path}`);
      rememberPart(this, true);
      this.dirty = false;
      this.updateTitle();
      this.status('Saved ' + String(path).split(/[\\/]/).pop());
    } catch (err) {
      this.toast('Save failed: ' + err.message, true);
    }
  }

  exportSTL() { return this.exportFile('stl'); }

  // Export the solid as STEP (exact B-rep) or STL (triangle mesh).
  async exportFile(format) {
    if (!this.result?.body) { this.toast('There is no solid body to export', true); return; }
    try {
      this.status(`Exporting ${format.toUpperCase()}…`);
      const bytes = await this.withProgress(`Exporting ${format.toUpperCase()}…`, () => this.kernel.exportBody(format, null, this.exportInfo()));
      const ext = format === 'step' ? 'step' : format;
      const path = await platform.saveBinary(`${this.safeName()}.${ext}`, bytes, format);
      this.status(path ? 'Exported ' + String(path).split(/[\\/]/).pop() : 'Ready');
    } catch (err) {
      this.toast('Export failed: ' + err.message, true);
    }
  }

  // Export the selected flat face as a 2D DXF drawing (outline and holes, in the face's plane).
  async exportFaceDXF() {
    if (this.flatView) return this.exportSheetDXF(this.flatView.bodyId);
    const s = this.selection;
    if (s?.kind !== 'face' || !s.face.planar) { this.toast('Select a flat face on the model first, then export it as DXF', true); return; }
    try {
      this.status('Exporting DXF…');
      const bytes = await this.withProgress('Exporting DXF…', () => this.kernel.exportFaceDXF({ p: s.point || s.face.center.toArray(), n: s.face.normal.toArray() }));
      const path = await platform.saveBinary(`${this.safeName()}-face.dxf`, bytes, 'dxf');
      this.status(path ? 'Exported ' + String(path).split(/[\\/]/).pop() : 'Ready');
    } catch (err) {
      this.toast('DXF export failed: ' + err.message, true);
    }
  }

  // Import a STEP or STL file as a base-body feature.
  async importFile() {
    if (this.mode === 'sketch') this.exitSketch(true);
    if (this.mode === 'sketch3d') this.exitSketch3D(true);
    if (this.pm) this.cancelPM();
    let file;
    try { file = await platform.openImport(); } catch (err) { this.toast('Import failed: ' + err.message, true); return; }
    await this.handleImport(file);
  }

  // ------------------------------------------------------------ keyboard
  wireKeys() {
    window.addEventListener('keydown', (e) => {
      const typing = e.target.closest?.('input, select, textarea');
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      // command search, everywhere
      // the tree, once clicked: the arrow keys move through it (not the view)
      if (document.activeElement?.id === 'tree' && e.target === document.activeElement && !ctrl && !e.altKey && !document.querySelector('.modal-back')
        && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(e.key) && this.ui.treeKey(e)) { e.preventDefault(); return; }
      // the user's own shortcuts (Help ▸ Customize Shortcuts) come first
      if (!typing && !document.querySelector('.modal-back') && !document.querySelector('#cmd-search') && this.ui.runShortcut(e)) { e.preventDefault(); return; }
      if (((ctrl && k === 'k' && !e.shiftKey && !e.altKey) || (e.key === '/' && !ctrl && !typing)) && !document.querySelector('.modal-back') && !document.querySelector('#cmd-search')) {
        e.preventDefault();
        this.ui.commandSearch();
        return;
      }
      if (this.mode === 'drawing') {
        if (this.drawing.handleKey(e)) return;
        if (ctrl && !typing) {
          if (k === 's') { e.preventDefault(); this.saveFile(e.shiftKey); }
          else if (k === 'o') { e.preventDefault(); this.openFile(); }
          else if (k === 'n') { e.preventDefault(); this.newDocument(); }
        }
        if (e.key === 'Escape') { this.ui.closeContext(); this.ui.closeDropdown(); }
        return;
      }
      if (e.key.startsWith('Arrow') && !typing && !document.querySelector('.modal-back')) {
        if (this.viewport.controls.key(e)) { e.preventDefault(); return; }
      }
      if (ctrl) {

        const views = { 1: 'front', 2: 'back', 3: 'left', 4: 'right', 5: 'top', 6: 'bottom', 7: 'iso' };
        if (views[e.key]) { e.preventDefault(); this.viewport.setStandardView(views[e.key]); return; }
        if (e.key === '8') { e.preventDefault(); this.normalToSelection(); return; }
        if (typing) return;
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); return; }
        if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); this.redo(); return; }
        if (k === 's') { e.preventDefault(); this.saveFile(e.shiftKey); return; }
        if (k === 'o') { e.preventDefault(); this.openFile(); return; }
        if (k === 'i') { e.preventDefault(); this.importFile(); return; }
        if (k === 'n') { e.preventDefault(); this.newDocument(); return; }
        if (k === 'b') { e.preventDefault(); this.refresh(); return; }
        return;
      }
      if (typing) {
        if (e.key === 'Enter' && this.pm?.kind === 'feature' && e.target.tagName === 'INPUT') { e.preventDefault(); this.okPM(); }
        return;
      }
      if (document.querySelector('.modal-back')) return;
      if(e.key==='Escape'&&this.pm?.loftConnector){e.preventDefault();this.pm.loftConnector=null;if(this._loftConnectorDrag)this._loftConnectorDrag.cancelled=true;this.ui.renderPM();this.updateSketchDisplay();return;}
      if (this.loftPicking() && this.pm.loftDraft?.curves.length && ['Enter', 'Escape'].includes(e.key)) {
        e.preventDefault();
        if (e.key === 'Enter') this.finishLoftSelection();
        else { this.pm.loftDraft = null; this.pm.loftHover = null; this.ui.renderPM(); this.updateSketchDisplay(); }
        return;
      }
      if (this.mode === 'sketch' && this.sketcher.key(e)) { e.preventDefault(); return; }
      if (this.mode === 'sketch3d' && this.sketch3d.key(e)) { e.preventDefault(); return; }
      if (e.key === 'Escape' && this.flatView) { this.exitFlatten(); return; }
      if (e.key === 'Escape' && this._cycle) { this.clearCycle(); this.status('Ready'); return; }
      if (e.key === 'Escape' && this.showHiddenMode) { this.exitShowHidden(); return; }
      if (e.key === 'Escape') {
        this.ui.closeContext();
        this.ui.closeDropdown();
        // in a sketch Esc first ends the active tool (handled by the sketcher); then it closes the sketch, keeping it
        if (this.pm?.kind === 'sketch') this.exitSketch(true);
        else if (this.pm) this.cancelPM();
        else this.select(null);
        return;
      }
      // (Tab hides what is under the cursor only with the focus on the view: in the panels it moves the focus; Enter
      // on a focused button presses it)
      if (e.key === 'Tab' && !e.altKey && (e.target === document.body || e.target.id === 'c')) { e.preventDefault(); this.tabHide(e.shiftKey); return; }
      if (onControl(e) && (e.key === 'Enter' || e.key === ' ' || e.key === 'Tab')) return;
      if (e.key === 'Enter' && this.pm && this.pm.kind !== 'sketch') { e.preventDefault(); this.okPM(); return; }
      if (e.key === 'Delete') { this.deleteSelection(); return; }
      if (k === 'f') { this.viewport.zoomToFit(); return; }
      if (this.mode !== 'sketch' && this.mode !== 'sketch3d' && !e.altKey) {
        const fk = { x: 'face', e: 'edge', v: 'vertex', b: 'body' }[k];
        if (fk) { this.toggleFilter(fk); return; }
        if (e.key === 'F5') { e.preventDefault(); this.toggleFilter('clear'); return; }
      }
    });
  }

  // ------------------------------------------------------------ feedback
  status(msg) { $('#status-msg').textContent = msg; }

  // A note across the top of the view, optionally with a button { label, action }.
  // button: { label, action } or a list of them
  showBanner(msg, button = null) {
    const b = $('#vp-banner');
    b.hidden = !msg;
    b.textContent = msg || '';
    if (msg && button) for (const x of Array.isArray(button) ? button : [button]) {
      const btn = document.createElement('button');
      btn.textContent = x.label;
      btn.onclick = () => x.action();
      b.append(' ', btn);
    }
  }

  toast(msg, err = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = err ? 'err' : '';
    t.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => (t.hidden = true), 3200);
  }
}

// No browser right-click menu over RazorCAD (the browser version; the desktop window has none): RazorCAD's own menus
// open where they belong, and a right button press or drag elsewhere does nothing. Kept in text fields and on
// selected text, for cut, copy and paste.
export function browserMenuWanted(e) {
  const t = e.target;
  if (t instanceof Element && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return true;
  const sel = window.getSelection?.();
  return !!(sel && !sel.isCollapsed && t instanceof Node && sel.containsNode(t, true));
}
// (on the way down: some panels stop the event on its way back up; RazorCAD's own menus still open)
document.addEventListener('contextmenu', (e) => { if (!browserMenuWanted(e)) e.preventDefault(); }, true);

window.app = new App();
installA11y();
