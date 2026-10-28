// Sketch edit mode: drawing tools with automatic relations, selection,
// solver-driven dragging, Dimension, relations and Trim.
import * as THREE from 'three';
import * as G from './geometry.js';
import * as S from './sketchmodel.js';
import * as SO from './sketchoffset.js';
import { solveSketch, analyzeSketch, sketchRank, RELATION_INFO, relationDiagnosis } from './solver.js';
import { evaluate, fmt, isNumeric, normalizeValue } from './expr.js';
import { fmtLen, lenText, lenValue } from './units.js';
import { parseDXF, dxfShapes, addShapes } from './dxfimport.js';
import { platform } from './platform.js';
import { isDark, sketchDefined, sketchUnder } from './theme.js';

const COL = {
  under: 0x1d4ed8, defined: 0x111827, selected: 0x0ea5e9, hover: 0xf59e0b, linked: 0x9333ea,
  preview: 0xf97316, dim: 0x5b6f9c, error: 0xdc2626, trim: 0xef4444, origin: 0xdc2626, handle: 0x0d9488,
};
// (the dark theme: light lines for what is fully defined, a lighter blue for the rest)
const themeCols = () => { COL.defined = sketchDefined(); COL.under = sketchUnder(); COL.dim = isDark() ? 0x93a4c8 : 0x5b6f9c; COL.handle = isDark() ? 0x5eead4 : 0x0d9488; };
themeCols();
if (typeof window !== 'undefined') window.addEventListener('razorcad-theme', themeCols);
const r4 = (x) => Math.round(x * 1e4) / 1e4;

// Points along a 2D primitive (line / arc / circle) for drawing.
function primPolyline(g) {
  if (g.type === 'line') return [g.a, g.b];
  if (g.type === 'point') return [g.p, g.p];
  const a0 = g.type === 'arc' ? Math.atan2(g.a[1] - g.c[1], g.a[0] - g.c[0]) : 0;
  let span = g.type === 'arc' ? Math.atan2(g.b[1] - g.c[1], g.b[0] - g.c[0]) - a0 : Math.PI * 2;
  while (span <= 0) span += Math.PI * 2;
  const pts = [];
  for (let i = 0; i <= 64; i++) { const t = a0 + (span * i) / 64; pts.push([g.c[0] + g.r * Math.cos(t), g.c[1] + g.r * Math.sin(t)]); }
  return pts;
}

// Cursors with a small badge so the active tool is obvious next to the pointer.
const cursorSvg = (badge) => `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M2 2 L2 17 L6 13 L9 20 L12 19 L9 12 L14 12 Z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/>${badge}</svg>`;
const mkCursor = (badge) => `url("data:image/svg+xml;utf8,${encodeURIComponent(cursorSvg(badge))}") 2 2, crosshair`;
const CURSORS = {
  dim: mkCursor('<rect x="13" y="18" width="18" height="12" rx="2" fill="#fff" stroke="#1d4ed8"/><path d="M15.5 24 H28.5 M17.5 22 L15.5 24 L17.5 26 M26.5 22 L28.5 24 L26.5 26" stroke="#1d4ed8" stroke-width="1.4" fill="none"/><path d="M15.5 20.5 V27.5 M28.5 20.5 V27.5" stroke="#1d4ed8" stroke-width="1"/>'),
  trim: mkCursor('<rect x="13" y="18" width="18" height="12" rx="2" fill="#fff" stroke="#ef4444"/><path d="M15 24 H29" stroke="#1d4ed8" stroke-width="1.4"/><path d="M19 21 L25 27 M25 21 L19 27" stroke="#ef4444" stroke-width="1.6"/>'),
  offset: mkCursor('<rect x="13" y="18" width="18" height="12" rx="2" fill="#fff" stroke="#1d4ed8"/><path d="M15.5 27 Q22 19 28.5 27" stroke="#1d4ed8" stroke-width="1.3" fill="none"/><path d="M15.5 23.5 Q22 15.5 28.5 23.5" stroke="#f97316" stroke-width="1.3" fill="none" stroke-dasharray="2 1"/>'),
  convert: mkCursor('<rect x="13" y="18" width="18" height="12" rx="2" fill="#fff" stroke="#0b7a2b"/><path d="M22 20 V27 M19 24.5 L22 27.5 L25 24.5" stroke="#0b7a2b" stroke-width="1.6" fill="none"/><path d="M15 28.5 H29" stroke="#1d4ed8" stroke-width="1" stroke-dasharray="2 1"/>'),
};

export const SKETCH_TOOLS = {
  select: { label: 'Select', hint: 'Click to select, Ctrl+click to add to the selection, drag points or lines to move them. Model edges and vertices can be selected too (e.g. a hole edge and a circle for Concentric or Equal). Selected entities show Add Relations in the Property panel.' },
  dim: { label: 'Dimension', hint: 'Click a line, circle, arc, or two entities, then click where to place the dimension. Move the mouse to switch between horizontal, vertical and aligned. Model edges/vertices and other sketches can be used as references too.' },
  line: { label: 'Line', hint: 'Click to place points. Horizontal/vertical and coincident relations are added automatically. Double-click, Enter or Esc ends the chain.' },
  midline: { label: 'Midpoint Line', hint: 'Click the midpoint, then an endpoint. The other endpoint is mirrored about the midpoint and a Midpoint constraint keeps it centred.' },
  spline: { label: 'Fit Point Spline', hint: 'Click the points the spline passes through; Enter or double-click ends it. Drag its tangent handles to change direction and strength. Their construction lines can be dimensioned or constrained. Click the first point to close the spline.' },
  cspline: { label: 'Control-Point Spline', hint: 'Click to place control points: the curve is drawn by them (it starts and ends on the first and last, and passes near the others). Double-click, Enter or Esc ends it; click the first point again to close it (smoothly, with no join). Afterwards drag the control points, constrain and dimension the dashed control polygon, and set the degree, the weights and the control points in the panel.' },
  centerline: { label: 'Centerline', hint: 'Click two points to draw a construction centerline (use it as a symmetry line or revolve axis).' },
  rect: { label: 'Corner Rectangle', hint: 'Click or drag from one corner to the opposite corner.' },
  crect: { label: 'Center Rectangle', hint: 'Click the center, then a corner.' },
  circle: { label: 'Circle', hint: 'Click the center, then a point on the circle.' },
  arc: { label: 'Centerpoint Arc', hint: 'Click the center, then the start point, then the end point (direction follows the mouse).' },
  arc3: { label: '3 Point Arc', hint: 'Click the start point, then the end point, then a third point the arc runs through.' },
  tarc: { label: 'Tangent Arc', hint: 'Click the end of a line or arc, then where the arc should end: it leaves tangent to that line or arc (a Tangent relation keeps it so).' },
  ellipse: { label: 'Ellipse', hint: 'Click the centre, then the end of the major axis, then set the minor radius. Trim it for an elliptical arc. Dimension on it sets the minor radius (or, nearer the major axis, the major radius).' },
  point: { label: 'Point', hint: 'Click to place a sketch point (e.g. for hole positions or as a reference). It snaps like the line tool.' },
  slot: { label: 'Straight Slot', hint: 'Click the first arc center, the second arc center, then set the width.' },
  cslot: { label: 'Center Point Slot', hint: 'Click the slot midpoint, one end arc centre, then set the width.' },
  oslot: { label: 'Overall Slot', hint: 'Click the two outermost ends along the slot axis, then set the width. The total length must exceed the width.' },
  arcslot: { label: 'Center Point Arc Slot', hint: 'Click the arc centre, the start centre, the end direction, then set the width. Move around the centre to choose the arc direction.' },
  arcslot3: { label: '3 Point Arc Slot', hint: 'Click the start and end centres, a third point on the centre arc, then set the width.' },
  polygon: { label: 'Polygon', hint: 'Click the center, then a vertex. Set the number of sides in the Property panel.' },
  trim: { label: 'Trim', hint: 'Power trim: hover over a segment (it turns red) and click to remove it up to the nearest intersections.' },
  extend: { label: 'Extend', hint: 'Click a line or arc near the end to extend: it runs on to the first entity in its way (and stays on it).' },
  split: { label: 'Split', hint: 'Click a line or arc where it should be split into two joined pieces.' },
  block: { label: 'Insert Block', hint: 'Click where the block goes (its centre). Click again for more copies; Esc ends.' },
  offset: { label: 'Offset', hint: 'Click a line, arc, circle or spline, choose the distance and direction, then click to create the offset. Select one entity or its chain; Both sides shares one editable dimension. Linked offset keeps the parametric relation.' },
  intersect: { label: 'Intersection Curve', hint: 'Click curves of earlier sketches to intersect them with this sketch plane, or click a model section. References remain linked. Esc exits.' },
  convert: { label: 'Project Edges', hint: 'Click model edges, vertices or entities of other sketches to project them into this sketch. Projected geometry stays linked and updates when its source changes.' },
  text: { label: 'Text', hint: 'Click where the text should start. Type it and choose the font, height, bold and italic in the Property panel. Text makes closed outlines for extruded bosses and cuts (and Wrap).' },
  sfillet: { label: 'Sketch Fillet', hint: 'Set the radius in the Property panel, then click a corner where two lines, a line and an arc, or two arcs meet. They are trimmed and joined by a tangent arc.' },
  schamfer: { label: 'Sketch Chamfer', hint: 'Set the distance in the Property panel, then click a corner where two lines meet. The corner is cut off by a line at that distance along both lines.' },
};

export class Sketcher {
  constructor(app) {
    this.app = app;
    this.vp = app.viewport;
    this.active = false;
    this.dimsVisible = true;
    this.relsVisible = true;
    this.autoRelations = true;
    this.constructionMode = false;
    this.polySides = 6;
    this.splineDegree = 3;   // the degree a Control-Point Spline is drawn with (chosen in the panel before drawing)
    this.offsetLinked = true; // offsets stay linked to their source (off: plain geometry)
    this.offsetChain = true;  // sketch entities and model edges: select connected chains
    this.offsetMode='side';this.offsetDistance=5;this.offsetTyped=true;
    this.filletR = 5;         // Sketch Fillet radius
    this.chamferD = 2;        // Sketch Chamfer distance
    this.dimPool = [];
    this.relPool = [];
    this.gearPool = []; // gear numbers: screen labels only, never sketch geometry
    this.onFrame = () => this._frame();
  }

  get ev() {
    const vars = this.app.result?.vars || {};
    return (x) => evaluate(x, vars);
  }

  get sk() { return this.f; }

  // ------------------------------------------------------------ lifecycle
  enter(feature, frame, isNew) {
    this.projectionSource='all';
    this.f = feature;
    this.frame = frame;
    this.isNew = isNew;
    this.snapshot = JSON.stringify({ points: feature.points, curves: feature.curves, constraints: feature.constraints, nextSid: feature.nextSid, plane: feature.plane, texts: feature.texts || [], gearTrains: feature.gearTrains || [], airfoils: feature.airfoils || [], patterns: feature.patterns || [] });
    this.patternDraft = null; this.patternPreview = null;
    this.active = true;
    this.tool = 'select';
    this.constructionMode = false;
    this.gearPick = false;
    this.airfoilPick = false;
    this.sel = new Set();
    this.hover = null;
    this.draw = null;
    this.drag = null;
    this.cursor = null;
    this.lastWpp = 0;
    this.trimHover = null;

    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    this.group.matrix.copy(G.frameMatrix(frame));
    this.vp.overlayGroup.add(this.group);
    const grid = isDark() ? new THREE.GridHelper(2000, 200, 0x4a5a72, 0x323c4a) : new THREE.GridHelper(2000, 200, 0x9fb3d1, 0xc6d3e6);
    grid.rotateX(Math.PI / 2);
    grid.material.transparent = true;
    grid.material.opacity = 0.45;
    grid.material.depthWrite = false;
    grid.renderOrder = 1;
    this.drawGroup = new THREE.Group();
    this.group.add(grid, this.drawGroup);

    this.snapEl = document.createElement('div');
    this.snapEl.className = 'snapmark';
    this.snapEl.hidden = true;
    this.tipEl = document.createElement('div');
    this.tipEl.className = 'cursor-tip';
    this.tipEl.hidden = true;
    this.vp.labelsEl.append(this.snapEl, this.tipEl);

    this.vp.setLeftRotate(false);
    this.normalTo();
    this.vp.frameCallbacks.add(this.onFrame);
    this.solve();
    this.analyze();
    this.textPolys = {};
    this._textKey = null;
    this.refreshTexts();
    this.hist = [this.snapshotData()];
    this.redoStack = [];
    this.redraw();
  }

  exit() {
    if (!this.active) return;
    this.dimLabelDrag?.cancel();
    this.patternDraft = null; this.patternPreview = null;
    this.endGearPick();
    this.clearSection();
    this.closeModify();
    this.vp.frameCallbacks.delete(this.onFrame);
    this.vp.overlayGroup.remove(this.group);
    this.group.traverse((o) => o.geometry?.dispose());
    [...this.dimPool, ...this.relPool, ...this.gearPool].forEach((l) => l.remove());
    this.gearPool = [];
    this.dimPool = [];
    this.relPool = [];
    this.snapEl.remove();
    this.tipEl.remove();
    this.vp.setLeftRotate(true);
    this.vp.canvas.style.cursor = 'default';
    this.active = false;
    this.f = null;
  }

  restoreSnapshot() {
    Object.assign(this.f, JSON.parse(this.snapshot));
  }

  // Turn the sketch's own frame to match plane.rot (after undo/redo of a rotation).
  syncFrameRotation(oldRot) {
    let steps = ((((this.f.plane?.rot || 0) - (oldRot || 0)) / 90) % 4 + 4) % 4;
    if (!steps) return;
    let fr = this.frame;
    for (; steps > 0; steps--) fr = { o: fr.o, u: fr.v.clone(), v: fr.u.clone().negate(), n: fr.n };
    this.setFrame(fr);
  }

  setFrame(fr) {
    this.frame = fr;
    this.group.matrix.copy(G.frameMatrix(fr));
    this.group.matrixWorldNeedsUpdate = true;
    this.normalTo();
  }

  // The sketch's own view: straight at its plane, from the side it is set to be seen from
  // (plane.viewFlip: from behind). It never toggles, so the sketch opens the same way every time.
  normalTo(animate = true) {
    const fr = this.frame;
    this.vp.normalTo(this.f?.plane?.viewFlip ? { ...fr, n: fr.n.clone().negate() } : fr, animate, true);
  }

  // Look at the sketch from the other side of its plane (kept with the sketch; the geometry and the
  // model don't change).
  flipSide() {
    this.endDraw();
    this.f.plane = { ...this.f.plane, viewFlip: !this.f.plane.viewFlip };
    if (!this.f.plane.viewFlip) delete this.f.plane.viewFlip;
    this.normalTo();
    this.changed();
    this.app.status(this.f.plane.viewFlip ? 'Looking at the sketch from the back of its plane.' : 'Looking at the sketch from the front of its plane.');
  }

  setTool(t) {
    this.dimLabelDrag?.cancel();
    if (this.patternDraft) this.finishPattern(false);
    const dimPicks = t === 'dim' ? this.selectedItems().filter((p) => ['point', 'line', 'circle', 'arc', 'ellipse', 'earc'].includes(p.kind)).map(({ id, kind }) => ({ id, kind })) : [];
    // Project Edges with model edges (or another sketch's entities) selected: those become sketch
    // geometry at once (the tool itself waits for clicks when nothing is selected)
    if (t === 'convert' && this.convertSelection()) return;
    this.blendFirst = null;
    this.endDraw();
    if (t !== 'select') this.endGearPick();
    if (['convert', 'intersect', 'offset'].includes(t)) { this.tool = t; this.loadSection(); }
    else this.clearSection();
    this.tool = t;
    this.app.ui.rememberSketchTool(t);
    this.app.updateSketchDisplay();
    if (t !== 'select') this.sel.clear();
    if (dimPicks.length && dimPicks.length <= 2) {
      this.draw = { tool: 'dim', picks: dimPicks, spec: null, ext: [], placing: !!this.dimSpec(dimPicks, { x: 0, y: 0 }) };
      this.sel = new Set(dimPicks.map((p) => p.id));
    }
    this.trimHover = null;
    this.app.status(SKETCH_TOOLS[t].hint);
    this.extHover = null;
    this.vp.canvas.style.cursor = CURSORS[t] || (t === 'select' ? 'default' : 'crosshair');
    this.redraw();
    this.app.ui.renderPM();
    this.app.ui.refreshCommandStates();
  }

  // ------------------------------------------------------------ text
  textById(id) { return (this.f.texts || []).find((t) => t.id === id) || null; }

  // Outlines of the sketch's texts (from the kernel, which has the fonts), cached per text.
  async refreshTexts() {
    const texts = this.f?.texts || [];
    const key = JSON.stringify(texts);
    if (key === this._textKey) return;
    this._textKey = key;
    if (!texts.length) { this.textPolys = {}; this.redraw(); return; }
    try {
      await this.app.ensureFonts();
      const polys = await this.app.kernel.textOutlines(texts);
      if (this._textKey === key && this.active) { this.textPolys = polys; this.redraw(); }
    } catch { /* keep the old outlines */ }
  }

  // Bounding box of a text's outline (for picking).
  textBox(t) {
    const pts = (this.textPolys?.[t.id] || []).flat();
    if (!pts.length) return { x0: t.x, y0: t.y, x1: t.x + t.h * Math.max(1, (t.text || '').length) * 0.6, y1: t.y + t.h };
    return { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) };
  }

  addText(p) {
    const f = this.f;
    f.texts ||= [];
    const h = +(Math.max(1, this.gridStep() * 3)).toFixed(3);
    const t = { id: 't' + f.nextSid++, text: 'Text', x: r4(p.x), y: r4(p.y), h, font: 'Arial', bold: false, italic: false, angle: 0 };
    f.texts.push(t);
    this.sel = new Set([t.id]);
    this.setTool('select');
    this.changed();
    setTimeout(() => document.querySelector('#pm .text-input')?.select(), 0);
  }

  // ------------------------------------------------------------ gears
  trainById(id) { return (this.f.gearTrains || []).find((t) => t.id === id) || null; }

  // The gear train of a selection id 'gear:<train>:<i>'.
  selectedTrain() {
    for (const id of this.sel) if (String(id).startsWith('gear:')) return this.trainById(String(id).split(':')[1]);
    return null;
  }

  // Gears command: on the selected lines (between gear centres) and/or points (one gear each).
  // Picking the lines for a gear train: clicks add lines (and points) to the selection; Enter, the banner
  // button or the Gears button again makes the train.
  startGearPick() {
    this.setTool('select');
    this.gearPick = true;
    this.sel = new Set([...this.sel].filter((id) => S.getCurve(this.f, id)?.type === 'line' || this.f.points.some((p) => p.id === id)));
    this.redraw();
    this.app.ui.renderPM();
    this.app.showBanner('Gears: click the lines between the gear centres (or one point for a single gear), then press Enter.', { label: 'Make Gears', action: () => this.makeGears() });
    this.app.status('Gears: click the lines joining the gear centres — centerlines work well; draw them first if needed (Esc cancels).');
  }

  endGearPick() {
    if (!this.gearPick) return;
    this.gearPick = false;
    this.app.showBanner(null);
  }

  makeGears() {
    const f = this.f;
    const lines = [...this.sel].map((id) => S.getCurve(f, id)).filter((c) => c?.type === 'line');
    const lonePts = [...this.sel].filter((id) => id !== 'O' && f.points.some((p) => p.id === id));
    if (!lines.length && !lonePts.length) {
      if (!this.gearPick) return this.startGearPick();
      this.app.toast('Click at least one line between gear centres (or a point for a single gear) first.', true);
      return;
    }
    this.endGearPick();
    // centres in order, walking the lines from an end (a tree of lines is fine; a closed loop is not)
    const adj = new Map();
    for (const c of lines) for (const [a, b] of [[c.p1, c.p2], [c.p2, c.p1]]) { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); }
    const nodes = [...adj.keys()];
    if (lines.length >= nodes.length && lines.length) { this.app.toast('The lines form a closed loop: gears in a loop cannot all mesh. Select an open chain (or a tree) of lines.', true); return; }
    const start = nodes.find((n) => adj.get(n).length === 1) || nodes[0];
    const centers = [];
    if (start) { const q = [start], seen = new Set([start]); while (q.length) { const n = q.shift(); centers.push(n); for (const m of adj.get(n)) if (!seen.has(m)) { seen.add(m); q.push(m); } } }
    for (const p of lonePts) if (!centers.includes(p)) { centers.push(p); S.getPoint(f, p).keep = true; }
    // a module that gives about 20 teeth on the first gear
    const first = lines[0] ? Math.hypot(S.getPoint(f, lines[0].p2).x - S.getPoint(f, lines[0].p1).x, S.getPoint(f, lines[0].p2).y - S.getPoint(f, lines[0].p1).y) : 20;
    const MODULES = S.GEAR_MODULES;
    const module = MODULES.reduce((best, mm) => (Math.abs(first / mm - 20) < Math.abs(first / best - 20) ? mm : best), MODULES[0]);
    const z = Math.max(8, Math.round(first / module));
    f.gearTrains ||= [];
    const tr = { id: 'g' + f.nextSid++, centers, lines: lines.map((c) => c.id), teeth: centers.map(() => z), module, pa: 20, backlash: 0.1, clearance: 0.1, bore: 0, phase0: 0, fit: true, dims: {} };
    f.gearTrains.push(tr);
    this.updateTrain(tr);
    // only a working gear set is made: when other dimensions fix the line lengths, the module and teeth
    // are chosen to fit them; when nothing fits, no gears are made
    let probs = S.trainProblems(f, tr), note = '';
    if (probs.length) {
      const fit = S.fitTrainTeeth(f, tr);
      if (fit) {
        const fixedLines = probs.some((p) => p.includes("don't mesh:"));
        Object.assign(tr, fit);
        this.updateTrain(tr);
        probs = S.trainProblems(f, tr);
        note = fixedLines ? ' The line lengths are fixed by other dimensions, so the module and teeth were chosen to fit them.' : ' The teeth were chosen so the gears don’t overlap.';
      }
    }
    if (probs.length) {
      this.deleteTrain(tr);
      this.solve();
      this.changed();
      this.app.toast(`No gears made: ${probs[0]}. Change the line lengths or angles so the gears can mesh.`, true);
      return;
    }
    this.sel = new Set(['gear:' + tr.id + ':0']);
    this.setTool('select');
    this.changed();
    this.app.status(`Gear train: ${centers.length} gear${centers.length === 1 ? '' : 's'}, module ${tr.module}.${note} Set the teeth or ratios, backlash and clearance in the Property panel.`);
  }

  // Change a gear train (mutate it). A change that would break a working train is undone, saying why
  // (a train that is already broken can be edited freely while it is being put right).
  editTrain(tr, mutate) {
    const f = this.f;
    const saved = JSON.stringify({ tr, points: f.points, constraints: f.constraints });
    const wasOk = !S.trainProblems(f, tr).length;
    mutate();
    this.updateTrain(tr, { stretch: true });
    const probs = S.trainProblems(f, tr);
    if (probs.length && wasOk) {
      const s = JSON.parse(saved);
      for (const k of Object.keys(tr)) delete tr[k];
      Object.assign(tr, s.tr);
      f.points = s.points;
      f.constraints = s.constraints;
      this.solve();
      this.changed(false);
      const fixed = !probs[0].includes("don't mesh:") ? ''
        : tr.fit === false ? ' (turn on "Set the line lengths to the mesh distance" to let the lines follow the gears)'
        : " (that line's length is fixed by a relation, an equation or fixed points, so it can't be stretched)";
      this.app.toast(`Not changed — ${probs[0]}${fixed}.`, true);
      return false;
    }
    this.changed(false);
    return true;
  }

  // Make a broken train work with its lines as they are (new module / teeth), if possible.
  fitTrain(tr) {
    const fit = S.fitTrainTeeth(this.f, tr);
    if (!fit) { this.app.toast('No gear sizes fit these centre distances without overlapping. Change the line lengths or angles.', true); return false; }
    return this.editTrain(tr, () => Object.assign(tr, fit));
  }

  // Keep the train's line lengths at the mesh distance (driving dimensions), or remove them.
  // stretch: a line whose length the user's own dimension fixes gets that dimension changed to the
  // mesh distance (when teeth / ratios / module are edited: the lines follow the gears).
  updateTrain(tr, { stretch = false } = {}) {
    const f = this.f;
    tr.dims ||= {};
    for (const mm of S.trainMeshes(f, tr)) {
      const dimId = tr.dims[mm.line];
      const k = dimId && f.constraints.find((x) => x.id === dimId);
      if (tr.fit) {
        if (k) k.value = +mm.need.toFixed(6);
        else {
          const c = S.getCurve(f, mm.line);
          // (quietly: when other dimensions already fix the line, its length stays as it is)
          const res = this.tryAddConstraints([['dim', [c.p1, c.p2], { kind: 'distance', value: +mm.need.toFixed(6), off: 6 * this.wpp() }]], { quiet: true });
          if (res?.kept) tr.dims[mm.line] = res.kept.id;
          else if (stretch && Math.abs(mm.need - mm.have) > 1e-6) this.stretchLine(c, mm.need / mm.have);
        }
      } else if (k) { f.constraints = f.constraints.filter((x) => x !== k); delete tr.dims[mm.line]; }
    }
    this.solve();
  }

  // Scale the user's length dimensions on a line (aligned, horizontal or vertical: the line keeps its
  // direction, so each scales with the length). false when the line has none, or one is an expression.
  stretchLine(c, factor) {
    const f = this.f, ends = new Set([c.p1, c.p2]);
    const dims = f.constraints.filter((k) => k.type === 'dim' && !k.driven && ['distance', 'hdist', 'vdist'].includes(k.kind)
      && ((k.refs.length === 1 && k.refs[0] === c.id) || (k.refs.length === 2 && k.refs.every((r) => ends.has(r)) && k.refs[0] !== k.refs[1])));
    const numeric = (v) => typeof v === 'number' || /^\s*-?\d*\.?\d+\s*$/.test(String(v));
    if (!dims.length || !dims.every((k) => numeric(k.value))) return false;
    for (const k of dims) k.value = +(+k.value * factor).toFixed(6);
    return true;
  }

  deleteTrain(tr) {
    const f = this.f;
    const dims = new Set(Object.values(tr.dims || {}));
    f.constraints = f.constraints.filter((k) => !dims.has(k.id));
    f.gearTrains = f.gearTrains.filter((t) => t !== tr);
  }

  // ------------------------------------------------------------ airfoils
  // The airfoil of a selection id 'airfoil:<id>'.
  selectedAirfoil() {
    for (const id of this.sel) if (String(id).startsWith('airfoil:')) return S.airfoilById(this.f, String(id).slice(8));
    return null;
  }

  // Airfoil command: an airfoil on each selected line (its chord); with none selected, the next line clicked.
  makeAirfoil() {
    const f = this.f;
    const lines = [...this.sel].map((id) => S.getCurve(f, id)).filter((c) => c?.type === 'line');
    if (!lines.length) {
      this.setTool('select');
      this.airfoilPick = true;
      this.sel.clear();
      this.redraw();
      this.app.ui.renderPM();
      this.app.showBanner('Airfoil: click the line to use as the chord (leading edge at its start).', { label: 'Cancel', action: () => this.endAirfoilPick(true) });
      this.app.status('Airfoil: click a line — it becomes the chord. Draw one first if needed (Esc cancels).');
      return;
    }
    this.endAirfoilPick();
    f.airfoils ||= [];
    const made = [];
    for (const c of lines) {
      if (f.airfoils.some((a) => a.line === c.id)) continue; // (one airfoil per chord line)
      c.construction = true; // the chord is a reference line, not part of the outline
      const af = { id: 'a' + f.nextSid++, line: c.id, spec: { kind: 'naca4', m: 2, p: 40, t: 12 }, sharpTE: true, flip: false, swap: false };
      f.airfoils.push(af);
      made.push(af);
    }
    if (!made.length) { this.app.toast('That line already has an airfoil: select the airfoil to change it.'); return; }
    this.sel = new Set(made.map((a) => 'airfoil:' + a.id));
    this.setTool('select');
    this.changed();
    this.app.status(`${made.length === 1 ? 'Airfoil NACA 2412' : made.length + ' airfoils (NACA 2412)'} on the chord line. Pick another airfoil or set your own in the Property panel; dimension the line to set the chord.`);
  }

  endAirfoilPick(cancelled = false) {
    if (!this.airfoilPick) return;
    this.airfoilPick = false;
    this.app.showBanner(null);
    if (cancelled) { this.redraw(); this.app.ui.renderPM(); this.app.status('Airfoil cancelled.'); }
  }

  // Change an airfoil (redraws, one undo step).
  editAirfoil(af, mutate) {
    mutate(af);
    this.changed(false);
  }

  deleteAirfoil(af) {
    this.f.airfoils = (this.f.airfoils || []).filter((a) => a !== af);
  }

  // Set the chord length: the user's length dimension on the line changes, or one is added.
  setChord(af, length) {
    const c = S.getCurve(this.f, af.line);
    if (!c || !(length > 0)) return false;
    const A = S.getPoint(this.f, c.p1), B = S.getPoint(this.f, c.p2), have = Math.hypot(B.x - A.x, B.y - A.y);
    if (this.stretchLine(c, length / have)) { this.solve(); this.changed(); return true; }
    const res = this.tryAddConstraints([['dim', [c.p1, c.p2], { kind: 'distance', value: +length.toFixed(6), off: 6 * this.wpp() }]]);
    if (!res?.kept) return false;
    this.changed();
    return true;
  }

  // ------------------------------------------------------------ sections (where the sketch plane cuts the model)
  // For Project Edges / Offset: the section curves are drawn and can be picked; the faces the plane cuts are highlighted.
  async loadSection() {
    const f = this.f;
    this.sectionPrims = null;
    this.highlightCutFaces();
    try {
      const prims = await this.app.kernel.sectionCurves(f.id);
      if (this.f === f && (['convert', 'intersect', 'offset'].includes(this.tool))) { this.sectionPrims = prims; this.redraw(); }
    } catch { this.sectionPrims = null; }
  }

  clearSection() {
    this.sectionPrims = null;
    this.vp.setFaceSet([], 'section');
  }

  highlightCutFaces() {
    const vp = this.vp, mesh = vp.mesh, fr = this.frame;
    if (!mesh) return;
    const V = mesh.vertices, T = mesh.triangles, gs = vp.faceGroupScale || 1, n = fr.n, o = fr.o;
    const r = vp.bodyGeo?.boundingSphere?.radius || 50, tol = Math.max(1e-4, r * 1e-5);
    const infos = [];
    mesh.faceGroups.forEach((g, gi) => {
      if (vp.hiddenBodies?.has(vp.faceBody[gi])) return;
      let lo = Infinity, hi = -Infinity;
      for (let k2 = g.start * gs; k2 < (g.start + g.count) * gs; k2++) {
        const i = T[k2] * 3, d = (V[i] - o.x) * n.x + (V[i + 1] - o.y) * n.y + (V[i + 2] - o.z) * n.z;
        if (d < lo) lo = d; if (d > hi) hi = d;
      }
      if (lo < -tol && hi > tol) infos.push(vp.faceInfo(gi));
    });
    vp.setFaceSet(infos, 'section');
  }

  // The connected chain of section curves through curve `idx` (indices into sectionPrims).
  sectionChain(idx) {
    const prims = this.sectionPrims || [];
    const tol = Math.max(1e-6, this.wpp() * 1e-3);
    const ends = (g) => (g.type === 'circle' ? [] : [g.a, g.b]);
    const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol;
    const out = [idx], seen = new Set([idx]);
    for (let i = 0; i < out.length; i++) {
      for (const p of ends(prims[out[i]])) {
        prims.forEach((g, j) => { if (!seen.has(j) && ends(g).some((q) => near(p, q))) { seen.add(j); out.push(j); } });
      }
    }
    return out;
  }

  // ------------------------------------------------------------ solving
  solve(opts) {
    const r = solveSketch(this.f, this.ev, opts);
    this.solveOk = r.ok && !r.bad.length;
    this.solveMsg = r.bad[0] || (r.ok ? '' : 'Cannot solve: conflicting relations or dimensions');
    return r;
  }

  analyze() {
    try { this.analysis = analyzeSketch(this.f, this.ev); } catch { this.analysis = null; }
  }

  statusText() {
    if (!this.solveOk) return { text: this.solveMsg || 'Over Defined', cls: 'err' };
    if (!this.analysis) return { text: '', cls: '' };
    const dof = this.analysis.dofDefined ?? this.analysis.dof;
    if (dof === 0) return { text: 'Fully Defined', cls: 'ok' };
    return { text: `Under Defined — ${dof} degree${dof > 1 ? 's' : ''} of freedom`, cls: '' };
  }

  snapshotData() {
    const { points, curves, constraints, nextSid, plane, texts, gearTrains, airfoils, patterns } = this.f;
    return JSON.stringify({ points, curves, constraints, nextSid, plane, texts: texts || [], gearTrains: gearTrains || [], airfoils: airfoils || [], patterns: patterns || [] });
  }

  undo() {
    if (this.dimLabelDrag) { this.dimLabelDrag.cancel(); return; }
    if (this.patternDraft) { this.finishPattern(false); return; }
    if (this.hist.length < 2) { this.app.toast('Nothing to undo in this sketch'); return; }
    this.redoStack.push(this.hist.pop());
    this.restoreData(this.hist[this.hist.length - 1]);
  }

  redo() {
    if (this.dimLabelDrag) { this.dimLabelDrag.cancel(); return; }
    if (this.patternDraft) { this.finishPattern(false); return; }
    const s = this.redoStack.pop();
    if (!s) return;
    this.hist.push(s);
    this.restoreData(s);
  }

  restoreData(s) {
    this.endDraw();
    this.closeModify();
    const oldRot = this.f.plane?.rot, oldFlip = !!this.f.plane?.viewFlip;
    Object.assign(this.f, JSON.parse(s));
    this.syncFrameRotation(oldRot);
    if (!!this.f.plane?.viewFlip !== oldFlip) this.normalTo();
    this.refreshTexts();
    this.sel.clear();
    this.solve();
    this.analyze();
    this.redraw();
    this.app.sketchEdited(true);
  }

  // Remove automatic references nothing uses any more (selected ones stay, for relations about to be added).
  pruneUnusedRefs() {
    const before = this.f.constraints.length;
    S.pruneRefs(this.f, this.sel);
    for (const id of [...this.sel]) if (!this.exists(id)) this.sel.delete(id);
    if (this.f.constraints.length !== before) this.solve();
  }

  changed(rerenderPM = true) {
    this.refreshTexts();
    if (this.f.airfoils?.length) this.f.airfoils = this.f.airfoils.filter((a) => S.getCurve(this.f, a.line));
    S.pruneRefs(this.f, this.sel || new Set());
    S.cleanup(this.f);
    const snap = this.snapshotData();
    if (this.hist[this.hist.length - 1] !== snap) {
      this.hist.push(snap);
      if (this.hist.length > 200) this.hist.shift();
      this.redoStack = [];
    }
    this.solve();
    this.analyze();
    for (const id of [...this.sel]) if (!this.exists(id)) this.sel.delete(id);
    this.redraw();
    this.app.sketchEdited(rerenderPM);
  }

  exists(id) {
    if (String(id).startsWith('gear:')) return !!this.trainById(String(id).split(':')[1]);
    if (String(id).startsWith('airfoil:')) return !!S.airfoilById(this.f, String(id).slice(8));
    return id === 'O' || this.f.points.some((p) => p.id === id) || this.f.curves.some((c) => c.id === id) || this.f.constraints.some((k) => k.id === id) || !!this.textById(id);
  }

  // Add constraints, refusing redundant or conflicting ones. Returns true if kept.
  tryAddConstraints(list, { asDriven = false, quiet = false } = {}) {
    const sk = this.f;
    const before = JSON.stringify(sk);
    if (list.length > 1) {
      let working = JSON.parse(before), redundant = 0;
      const kept = [];
      for (const [type, refs, extra] of list) {
        const trial = JSON.parse(JSON.stringify(working)), rank = sketchRank(working, this.ev);
        const k = S.addRel(trial, type, refs, extra || {});
        const gain = sketchRank(trial, this.ev) - rank;
        const solved = solveSketch(trial, this.ev);
        if (!solved.ok || solved.bad.length) {
          if (!quiet) this.app.toast('That relation conflicts with existing relations or dimensions.', true);
          return null; // the original sketch, including earlier candidates, is unchanged
        }
        if (gain < 1) { redundant++; continue; }
        working = trial; kept.push(k.id);
      }
      if (!kept.length) {
        if (!quiet) this.app.toast('These entities are already constrained that way; no new relation is needed.');
        return null;
      }
      const { gearTrains, texts, airfoils, ...rest } = working;
      Object.assign(sk, rest);
      this.solve();
      return { kept: sk.constraints.find((k) => k.id === kept[kept.length - 1]), added: kept.length, redundant };
    }
    const r0 = sketchRank(sk, this.ev);
    const added = list.map(([type, refs, extra]) => S.addRel(sk, type, refs, extra || {}));
    const r1 = sketchRank(sk, this.ev);
    let problem = null;
    // (why, when the new relations take away less than their share: already satisfied, or would over-define the
    // sketch, and with which relations already there; worked out before solving moves the geometry)
    let why = null;
    if (r1 - r0 < added.length && !quiet) { try { why = relationDiagnosis(sk, added, this.ev); } catch { why = null; } }
    const solved = this.solve();
    if (!solved.ok || solved.bad.length) problem = 'conflict';
    else if (r1 - r0 < added.length) problem = 'redundant';
    if (problem) {
      // put the geometry back; the gear trains and texts keep their objects (callers hold on to them)
      const { gearTrains, texts, airfoils, ...rest } = JSON.parse(before);
      Object.assign(sk, rest);
      if (asDriven && added.length === 1 && added[0].type === 'dim') {
        const k = S.addRel(sk, 'dim', added[0].refs, { ...added[0], driven: true });
        delete k.id; k.id = 'k' + sk.nextSid++;
        this.solve();
        this.app.toast('That dimension would over-define the sketch, so it was added as a driven (reference) dimension.');
        return { kept: k, driven: true };
      }
      this.solve();
      this.analyze(); this.redraw();
      if (!quiet) {
        const what = added.length === 1 ? `${RELATION_INFO[added[0].type]?.label || 'That relation'}` : 'Those relations';
        const name = (k) => (k.type === 'dim' ? (k.value != null && k.value !== '' ? `the ${k.value} dimension` : 'a dimension') : `${RELATION_INFO[k.type]?.label || k.type}`);
        const by = why?.blockers.length ? why.blockers.slice(0, 3).map(name).join(', ') + (why.blockers.length > 3 ? '…' : '') : '';
        let msg;
        if (why?.kind === 'conflict') msg = `${what} would over-define the sketch${by ? `: it conflicts with ${by} (highlighted). Delete ${why.blockers.length > 1 ? 'one of those' : 'that'} first to use it instead` : ' (it conflicts with relations or dimensions already there)'}.`;
        else if (why) msg = `${what} is already satisfied${by ? `: ${by} (highlighted) already ${why.blockers.length > 1 ? 'define' : 'defines'} the geometry that way` : '; no new relation is needed'}.`;
        else msg = problem === 'redundant' ? 'These entities are already constrained that way; no new relation is needed.' : 'That relation conflicts with existing relations or dimensions.';
        // (the relations in the way shown selected)
        if (why?.blockers.length) { const ids = new Set(why.blockers.map((k) => k.id).filter((id) => sk.constraints.some((x) => x.id === id))); if (ids.size) { this.sel = ids; this.redraw(); } }
        this.app.toast(msg, why ? why.kind === 'conflict' : problem !== 'redundant');
      }
      return null;
    }
    return { kept: added[added.length - 1] };
  }

  // ------------------------------------------------------------ picking
  wpp() { return this.vp.worldPerPixel(); }

  localFromEvent(ev) {
    return G.toLocal(this.frame, this.vp.rayPlane(ev, this.frame));
  }

  gridStep() {
    const w = this.wpp();
    for (const s of [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200]) if (s / w >= 12) return s;
    return 500;
  }

  hitTest(p, { points = true, curves = true, exclude = null, texts = true } = {}) {
    const tol = 7 * this.wpp();
    if (texts && curves && this.tool === 'select') {
      for (const tr of this.f.gearTrains || []) {
        for (const g of S.trainGears(this.f, tr)) {
          const d = Math.hypot(p.x - g.cx, p.y - g.cy), ra = (g.m * g.z) / 2 + g.m;
          if (d < ra && d > 8 * this.wpp() && !exclude?.has('gear:' + tr.id + ':' + g.i)) return { id: 'gear:' + tr.id + ':' + g.i, kind: 'gear' };
        }
      }
    }
    if (texts && curves && this.tool === 'select') {
      // an airfoil: near its outline
      for (const af of this.f.airfoils || []) {
        const pl = S.airfoilPolyline(this.f, af, 4);
        if (!pl || exclude?.has('airfoil:' + af.id)) continue;
        for (let i = 0; i < pl.length - 1; i++) {
          const a = pl[i], b = pl[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
          const u = L2 ? Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / L2)) : 0;
          if (Math.hypot(p.x - (a[0] + u * dx), p.y - (a[1] + u * dy)) < tol) return { id: 'airfoil:' + af.id, kind: 'airfoil' };
        }
      }
    }
    if (texts && curves && (this.tool === 'select' || this.tool === 'text')) {
      for (const t of this.f.texts || []) {
        const b = this.textBox(t);
        if (p.x > b.x0 - tol && p.x < b.x1 + tol && p.y > b.y0 - tol && p.y < b.y1 + tol && !exclude?.has(t.id)) return { id: t.id, kind: 'text' };
      }
    }
    if (points) {
      let best = null, bd = tol;
      for (const q of [S.ORIGIN, ...this.f.points]) {
        if (exclude?.has(q.id)) continue;
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < bd) { bd = d; best = { id: q.id, kind: 'point' }; }
      }
      if (best) return best;
    }
    if (curves) {
      // the nearest curve; where a line and a spline are about as near (a control-point spline crossing its own
      // control polygon), the line: the spline can be picked anywhere else along it
      const tie = 1.5 * this.wpp();
      let best = null, bd = tol;
      for (const c of this.f.curves) {
        if (exclude?.has(c.id)) continue;
        const d = S.distToCurve(this.f, c, p.x, p.y);
        const beats = best && c.type === 'line' && best.kind === 'spline' ? d < bd + tie : best && c.type === 'spline' && best.kind === 'line' ? d < bd - tie : d < bd;
        if (beats || (!best && d < bd)) { bd = d; best = { id: c.id, kind: c.type }; }
      }
      return best;
    }
    return null;
  }

  // Snap a cursor position: existing point > line midpoint > on curve > grid.
  lineInference(p,prev,tol){
    let best=null;
    const extensionSource=prev&&this.f.constraints.find(k=>k.autoExtension&&k.refs[0]===prev.id)?.refs[1];
    for(const c of this.f.curves){
      if(c.type!=='line'||c.ctrlOf)continue;
      const a=S.getPoint(this.f,c.p1),b=S.getPoint(this.f,c.p2),vx=b.x-a.x,vy=b.y-a.y,L=Math.hypot(vx,vy);if(L<1e-7)continue;
      const ux=vx/L,uy=vy/L,origin=prev||a,dx=p.x-origin.x,dy=p.y-origin.y,t=dx*ux+dy*uy,error=Math.abs(dx*uy-dy*ux);
      if(error>tol)continue;
      if(!prev){
        const along=(p.x-a.x)*ux+(p.y-a.y)*uy,gap=along<0?-along:along>L?along-L:0;
        if(!gap||gap>Math.max(2*L,50*this.wpp()))continue;
        if(!best||error<best.error)best={x:a.x+along*ux,y:a.y+along*uy,kind:'onCurve',curve:c.id,extension:true,inferCurve:c.id,inferGuide:[[a.x,a.y],[a.x+along*ux,a.y+along*uy]],error};
        continue;
      }
      if(Math.hypot(dx,dy)<3*this.wpp()||error/Math.hypot(dx,dy)>Math.sin(4*Math.PI/180))continue;
      const distance=Math.abs((prev.x-a.x)*uy-(prev.y-a.y)*ux),infer=distance<1e-5?'collinear':'parallel',rank=infer==='collinear'?(c.id===extensionSource?-1:0):1,near=S.segDist(prev.x,prev.y,a.x,a.y,b.x,b.y);
      if(!best||rank<best.rank||rank===best.rank&&(error<best.error-1e-7||Math.abs(error-best.error)<1e-7&&near<best.near))best={x:prev.x+t*ux,y:prev.y+t*uy,kind:'grid',infer,inferCurve:c.id,inferGuide:[[a.x,a.y],[b.x,b.y]],rank,error,near};
    }
    return best;
  }

  snap(p, { exclude = new Set(), prev = null } = {}) {
    const tol = 9 * this.wpp();
    let best = null, bd = tol;
    for (const q of [S.ORIGIN, ...this.f.points]) {
      if (exclude.has(q.id)) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bd) { bd = d; best = { x: q.x, y: q.y, kind: 'point', id: q.id }; }
    }
    if (best) return best;
    const model = this.autoRelations ? this.modelSnapItems() : [];
    for (const it of model) {
      for (const [q, w] of it.ends || []) {
        const d = Math.hypot(q[0] - p.x, q[1] - p.y);
        if (d < bd) { bd = d; best = { x: q[0], y: q[1], kind: 'model', as: 'point', ext: { kind: 'extVertex', p: w } }; }
      }
      if (it.center) {
        const d = Math.hypot(it.center[0] - p.x, it.center[1] - p.y);
        if (d < bd) { bd = d; best = { x: it.center[0], y: it.center[1], kind: 'model', as: 'center', ext: it.ext }; }
      }
    }
    if (best) return best;
    if (this.autoRelations) {
      for (const c of this.f.curves) {
        if ((c.type !== 'line' && c.type !== 'arc') || exclude.has(c.id)) continue;
        let mx, my;
        if (c.type === 'arc') {
          // (an arc's midpoint: half way round it)
          const C = S.getPoint(this.f, c.c), A = S.arcAngles(this.f, c), r = S.radiusOf(this.f, c), t = A.a0 + A.span / 2;
          mx = C.x + r * Math.cos(t); my = C.y + r * Math.sin(t);
        } else {
          const a = S.getPoint(this.f, c.p1), b = S.getPoint(this.f, c.p2);
          mx = (a.x + b.x) / 2; my = (a.y + b.y) / 2;
        }
        const d = Math.hypot(mx - p.x, my - p.y);
        if (d < bd) { bd = d; best = { x: mx, y: my, kind: 'mid', curve: c.id }; }
      }
      if (best) return best;
      let bc = null, bcd = tol * 0.7;
      for (const c of this.f.curves) {
        if (exclude.has(c.id)) continue;
        const d = S.distToCurve(this.f, c, p.x, p.y);
        if (d < bcd) { bcd = d; bc = c; }
      }
      if (bc) { const q = S.closestOnCurve(this.f, bc, p.x, p.y); return { x: q.x, y: q.y, kind: 'onCurve', curve: bc.id }; }
      // on a model edge lying in the sketch plane
      let bm = null, bmd = tol * 0.7;
      for (const it of model) {
        if (!it.poly) continue;
        for (let i = 0; i < it.poly.length - 1; i++) {
          const a = it.poly[i], b = it.poly[i + 1];
          const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
          const t = L2 ? Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / L2)) : 0;
          const x = a[0] + t * dx, y = a[1] + t * dy, d = Math.hypot(p.x - x, p.y - y);
          if (d < bmd) { bmd = d; bm = { x, y, kind: 'model', as: 'onCurve', ext: it.ext }; }
        }
      }
      if (bm) return bm;
    }
    const s = this.gridStep();
    const res = { x: r4(Math.round(p.x / s) * s), y: r4(Math.round(p.y / s) * s), kind: 'grid' };
    const lineTool=['line','centerline'].includes(this.tool);
    if(!prev&&this.autoRelations&&lineTool){const extension=this.lineInference(p,null,tol*.7);if(extension)return extension;}
    if (prev && this.autoRelations) {
      // horizontal / vertical inference relative to the previous point
      const dx = p.x - prev.x, dy = p.y - prev.y;
      const ang = Math.abs(Math.atan2(dy, dx));
      const tolA = (4 * Math.PI) / 180;
      if (Math.hypot(dx, dy) > 3 * this.wpp()) {
        if (ang < tolA || Math.abs(ang - Math.PI) < tolA) { res.y = prev.y; res.infer = 'horizontal'; }
        else if (Math.abs(ang - Math.PI / 2) < tolA) { res.x = prev.x; res.infer = 'vertical'; }
      }
    }
    if(prev&&this.autoRelations&&lineTool){const inference=this.lineInference(p,prev,tol);if(inference&&(inference.infer==='collinear'||!res.infer))return inference;}
    return res;
  }

  // Turn a snap result into a point id, adding the inferred relation.
  resolve(s) {
    if (s.kind === 'point') return s.id;
    if (s.kind === 'model') return this.resolveModelSnap(s);
    const id = S.addPoint(this.f, s.x, s.y);
    if (s.kind === 'mid') S.addRel(this.f, 'midpoint', [id, s.curve]);
    if (s.kind === 'onCurve' && S.getCurve(this.f, s.curve)?.type !== 'spline') S.addRel(this.f, 'onCurve', [id, s.curve],s.extension?{autoExtension:true}:{});
    return id;
  }

  // ------------------------------------------------------------ pointer events
  pointerDown(ev) {
    if (ev.button !== 0) return;
    this.closeModify();
    const raw = this.localFromEvent(ev);
    const t = this.tool;
    const multi = ev.ctrlKey || ev.shiftKey || ev.metaKey || this.gearPick; // picking gear lines: clicks add to the selection

    if (this.patternDraft) {
      const d = this.patternDraft, hit = this.hitTest(raw, { points: d.pick !== 'path' });
      if (hit && !S.patternEntities(this.f).has(hit.id)) {
        if (d.pick === 'path' && S.getCurve(this.f, hit.id)) { d.path = hit.id; d.sources = d.sources.filter((id) => id !== hit.id); }
        else if (d.pick === 'sources' && hit.id !== d.path) d.sources = d.sources.includes(hit.id) ? d.sources.filter((id) => id !== hit.id) : [...d.sources, hit.id];
        this.updatePatternPreview(); this.app.ui.renderPM();
      }
      return;
    }
    if (t === 'select') {
      let hit = this.hitTest(raw);
      let external = false;
      if (!hit) {
        // a model edge / vertex (or an entity of another sketch): selected through a linked reference,
        // so relations and dimensions can use it directly
        const ext = this.externalHit(ev);
        if (ext) { hit = this.materializeExternal(ext, raw); external = !!hit; this.extHover = null; }
      }
      if (hit) {
        if (multi) { this.sel.has(hit.id) ? this.sel.delete(hit.id) : this.sel.add(hit.id); }
        else if (!this.sel.has(hit.id)) { this.sel.clear(); this.sel.add(hit.id); }
        if (!multi && !external) {
          if (S.patternEntities(this.f).has(hit.id)) this.app.status('Linked pattern copy: edit the original geometry or use Edit Pattern in the Property panel.');
          else {
            const blk = S.blockOf(this.f, hit.id);
            if (blk) this.app.status(`Block "${blk.name}": it moves and turns as one (Explode Block to change its geometry here, or change the block and Make Block again under its name).`);
            this.startDrag(hit, raw);
          }
        }
      } else {
        if (!multi) this.sel.clear();
        // a drag from empty space: a selection box (see boxMove / boxEnd)
        const at = this.vp.screenPos(ev);
        this.box = { a: at, b: at, el: null };
      }
      if (this.airfoilPick && hit && S.getCurve(this.f, hit.id)?.type === 'line') { this.drag = null; this.makeAirfoil(); return; }
      this.pruneUnusedRefs();
      this.redraw();
      this.app.ui.renderPM();
      this.app.ui.refreshCommandStates();
      return;
    }
    if (t === 'trim') {
      const hit = this.hitTest(raw, { points: false });
      if (hit && S.trimAt(this.f, hit.id, raw.x, raw.y)) { this.trimHover = null; this.changed(); }
      return;
    }
    if (t === 'extend' || t === 'split') {
      const hit = this.hitTest(raw, { points: false });
      const c = hit && S.getCurve(this.f, hit.id);
      if (!c || (c.type !== 'line' && c.type !== 'arc')) { this.app.status(SKETCH_TOOLS[t].hint); return; }
      if (t === 'split') {
        if (!S.splitAt(this.f, c.id, raw.x, raw.y)) { this.app.toast('Click inside the line or arc, away from its ends', true); return; }
        this.hover = null;
        this.changed();
        this.app.status(`${S.itemName(this.f, c.id)} split in two.`);
        return;
      }
      const r = S.extendAt(this.f, c.id, raw.x, raw.y);
      if (!r) { this.app.toast('Nothing to extend to from that end (or the end is joined to other entities)', true); return; }
      const to = S.getCurve(this.f, r.curve);
      if (to && to.type !== 'spline') S.addRel(this.f, 'onCurve', [r.point, r.curve]);
      if (!this.solve().ok) this.app.toast('The extended end is held by relations or dimensions', true);
      this.changed();
      return;
    }
    if (t === 'point') {
      const s = this.snap(raw);
      const id = this.resolve(s);
      if (id !== 'O') S.getPoint(this.f, id).keep = true;
      this.changed();
      return;
    }
    if (t === 'block') {
      if (!this.blockIns) { this.setTool('select'); return; }
      const s = this.snap(raw);
      const ids = this.blockIns.linked === false ? S.pasteItems(this.f, this.blockIns.data, s.x, s.y) : S.insertBlockInstance(this.f, this.blockIns, s.x, s.y, this.blockIns.angle || 0).curves;
      this.sel = new Set(ids);
      this.changed();
      this.app.status(`Block "${this.blockIns.name}" inserted${this.blockIns.linked === false ? ' (plain geometry)' : ': it moves as one, and follows the block when it is saved again (Explode Block makes it plain geometry)'}. Click for another copy; Esc ends.`);
      return;
    }
    if (t === 'tarc') {
      const d = this.draw;
      if (!d) {
        const s = this.snap(raw);
        const from = s.kind === 'point' ? s.id : null;
        const c = from && [...this.f.curves].reverse().find((x) => (x.type === 'line' || x.type === 'arc') && (x.p1 === from || x.p2 === from));
        if (!c) { this.app.toast('Start the tangent arc at the end of a line or arc', true); return; }
        const P = S.getPoint(this.f, from);
        this.draw = { tool: 'tarc', from, curve: c.id, t: S.endTangent(this.f, c, from), p0: { x: P.x, y: P.y }, p1: { x: P.x, y: P.y } };
        this.redraw();
        return;
      }
      d.s1 = this.snap(raw, { exclude: new Set([d.from]) });
      d.p1 = d.s1;
      this.commit();
      return;
    }
    if (t === 'dim') return this.dimClick(raw, ev);
    if (t === 'offset') return this.offsetClick(raw, ev);
    if (t === 'text') { const hit = this.hitTest(raw, { points: false }); if (hit?.kind === 'text') { this.sel = new Set([hit.id]); this.setTool('select'); } else this.addText(raw); return; }
    if (t === 'sfillet' || t === 'schamfer') {
      const hit = this.hitTest(raw, { curves: false });
      if (!hit) { this.app.status(SKETCH_TOOLS[t].hint); return; }
      let created;
      try {
        created = S.blendCorner(this.f, hit.id, t === 'sfillet' ? this.filletR : this.chamferD, t === 'schamfer');
      } catch (e) { this.app.toast(e.message, true); return; }
      const equalled = this.equalToFirstBlend(t, hit.id, created);
      this.hover = null;
      this.changed();
      if (equalled) this.app.status(t === 'sfillet' ? 'Corner rounded, equal to the first fillet (Equal). Leave the tool to start a new size.' : 'Corner chamfered, equal to the first chamfer (Equal Distance). Leave the tool to start a new size.');
      return;
    }
    if (t === 'convert' || t === 'intersect') {
      const ext = this.externalHit(ev, { vertices: false });
      if (!ext) return;
      if (ext.kind === 'extSection') {
        // the whole connected outline where the plane cuts the model, linked to it (not what is already there)
        const chain = ext.chain.filter((i) => !this.hasCurveLike(this.sectionPrims[i]));
        if (!chain.length) { this.app.status('That outline is already in the sketch.'); return; }
        const ids = chain.flatMap((i) => S.addProjected(this.f, [this.sectionPrims[i]], { kind: 'section', idx: i, of: this.sectionPrims.length }));
        this.joinEnds(ids, true);
        this.extHover = null;
        this.changed();
        this.app.status(`Converted ${ids.length} intersection curve${ids.length === 1 ? '' : 's'} into the sketch (linked to the model).`);
        return;
      }
      const prims = this.externalPrims(ext);
      if (!prims.length) { this.app.status(ext.geom?.spline && t === 'intersect' ? 'Intersection of a non-coplanar spline is not supported yet.' : 'That curve does not intersect this sketch plane.'); return; }
      const existing = this.existingRef(ext);
      if (existing && t === 'intersect') { this.app.status('That intersection is already linked in the sketch.'); return; }
      if (existing) {
        const k = this.f.constraints.find((k) => k.type === 'projected' && k.refs[0] === existing.id);
        const c = S.getCurve(this.f, existing.id);
        if (k?.ref || c?.construction) {
          this.sel = new Set([existing.id]);
          this.extHover = null;
          this.convertSelection();
          return;
        }
      }
      if (prims.every((g) => this.hasCurveLike(g))) { this.app.status('That is already in the sketch (converted entities are purple).'); return; }
      this.joinEnds(S.addProjected(this.f, prims, this.externalSrc(ext)), true);
      this.extHover = null;
      this.changed();
      this.app.status(`Converted ${prims.length} entit${prims.length === 1 ? 'y' : 'ies'} into the sketch (linked to the source).`);
      return;
    }

    if (t === 'spline' || t === 'cspline') {
      // each click a point the curve runs through (a control-point spline: a control point); the spline is made
      // when it ends
      const d = this.draw;
      const s = this.snap(raw, { exclude: new Set(d ? [d.pts[d.pts.length - 1]] : []) });
      if (!d) { this.draw = { tool: t, pts: [this.resolve(s)] }; this.redraw(); return; }
      // (a click on the last point again, e.g. the second click of a double-click, adds nothing)
      const lp = S.getPoint(this.f, d.pts[d.pts.length - 1]);
      if (lp && Math.hypot(s.x - lp.x, s.y - lp.y) < 3 * this.wpp()) return;
      const pid = this.resolve(s);
      if (pid === d.pts[d.pts.length - 1]) return;
      if (pid === d.pts[0] && d.pts.length >= 3) {
        // back on the first point: a closed loop (a control-point spline runs round smoothly)
        if (t === 'cspline') S.addCtrlSpline(this.f, d.pts, Math.min(this.splineDegree, d.pts.length - 1), this.constructionMode, true);
        else S.addFitSpline(this.f, d.pts, true, this.constructionMode);
        this.draw = null;
        this.solve();
        this.changed();
        return;
      }
      d.pts.push(pid);
      this.redraw();
      return;
    }
    if (t === 'line' || t === 'centerline') {
      const d = this.draw;
      const prevPt = d ? S.getPoint(this.f, d.last) : null;
      const s = this.snap(raw, { prev: prevPt, exclude: new Set(d ? [d.last] : []) });
      if (!d) {
        this.draw = { tool: t, start: this.resolve(s), last: null, count: 0 };
        this.draw.last = this.draw.start;
      } else {
        const pid = this.resolve(s);
        if (pid === d.last) return;
        const lid = S.addLine(this.f, d.last, pid, t === 'centerline' || this.constructionMode);
        if(s.inferCurve&&s.infer==='collinear')this.f.constraints=this.f.constraints.filter(k=>!(k.autoExtension&&k.refs[0]===d.last&&k.refs[1]===s.inferCurve));
        if (s.infer) S.addRel(this.f, s.infer, s.inferCurve?[s.inferCurve,lid]:[lid]);
        d.count++;
        const closed = s.kind === 'point' && s.id === d.start;
        d.last = pid;
        this.solve();
        if (closed || t === 'centerline') this.draw = null;
        this.changed();
      }
      this.redraw();
      return;
    }

    const s = this.snap(raw, { prev: this.draw?.p0 || null });
    const screen = this.vp.screenPos(ev);
    if (['arcslot', 'arcslot3'].includes(t)) {
      const d = this.draw;
      if (!d) this.draw = { tool: t, stage: 1, s0: s, p0: s, p1: s, p2: s, p3: s, sweep: 0, screen };
      else if (d.stage === 1) {
        if (Math.hypot(s.x - d.p0.x, s.y - d.p0.y) < 1e-6) return;
        Object.assign(d, { s1: s, p1: s, p2: s, stage: 2, lastAng: null });
      } else if (d.stage === 2) Object.assign(d, { s2: s, p2: s, p3: s, stage: 3 });
      else { d.s3 = s; d.p3 = s; this.commit(); }
      this.redraw(); return;
    }
    if (['arc', 'slot', 'cslot', 'oslot', 'arc3', 'ellipse'].includes(t)) {
      if (!this.draw) this.draw = { tool: t, stage: 1, s0: s, p0: s, p1: s, p2: s, sweep: 0, screen };
      else if (this.draw.stage === 1) {
        if (Math.hypot(s.x - this.draw.p0.x, s.y - this.draw.p0.y) < 1e-9) return;
        this.draw.s1 = s; this.draw.p1 = s; this.draw.p2 = s; this.draw.stage = 2; this.draw.lastAng = null; this.draw.sweep = 0;
      } else { this.draw.s2 = s; this.commit(); }
      this.redraw();
      return;
    }
    // two-click tools
    if (!this.draw) this.draw = { tool: t, s0: s, p0: s, p1: s, downAt: screen };
    else { this.draw.s1 = s; this.draw.p1 = s; this.commit(); }
    this.redraw();
  }

  // Sketch Fillet / Chamfer: the first one made since the tool was picked keeps its dimension(s); each later one
  // gets Equal (radius) / Equal Distance relations to it instead. Returns true when it was made equal.
  equalToFirstBlend(t, P, created) {
    const sk = this.f, fillet = t === 'sfillet';
    const first = this.blendFirst?.tool === t ? this.blendFirst : null;
    const isDimOf = (k, kind, refs) => k.type === 'dim' && k.kind === kind && k.refs.length === refs.length && refs.every((x, i) => k.refs[i] === x);
    if (fillet) {
      const arc = created[created.length - 1];
      if (first && S.getCurve(sk, first.arc)) {
        sk.constraints = sk.constraints.filter((k) => !isDimOf(k, 'radius', [arc]));
        S.addRel(sk, 'equal', [first.arc, arc]);
        return true;
      }
      this.blendFirst = { tool: t, arc };
      return false;
    }
    const [T1, T2] = created;
    if (first && S.getPoint(sk, first.P) && S.getPoint(sk, first.T)) {
      sk.constraints = sk.constraints.filter((k) => !isDimOf(k, 'distance', [P, T1]) && !isDimOf(k, 'distance', [P, T2]));
      S.addRel(sk, 'equalDist', [P, T1, first.P, first.T]);
      S.addRel(sk, 'equalDist', [P, T2, first.P, first.T]);
      return true;
    }
    // (the first chamfer: one distance, both sides equal, so one value sizes it and the later ones)
    sk.constraints = sk.constraints.filter((k) => !isDimOf(k, 'distance', [P, T2]));
    S.addRel(sk, 'equalDist', [P, T2, P, T1]);
    this.blendFirst = { tool: t, P, T: T1 };
    return false;
  }

  startDrag(hit, raw) {
    const sk = this.f;
    if (hit.kind === 'gear' || hit.kind === 'airfoil') return; // (generated geometry: moved with its lines)
    if (hit.kind === 'text') { const t = this.textById(hit.id); if (t) this.drag = { type: 'text', t, start: raw, x0: t.x, y0: t.y, moved: false }; return; }
    if (hit.kind === 'point') {
      if (hit.id !== 'O') this.drag = {
        type: 'point', id: hit.id, p0: { ...S.getPoint(sk, hit.id) }, moved: false,
        handles: sk.curves.filter((c) => c.handles && c.pts.includes(hit.id)).map((c) => ({ ...S.getPoint(sk, c.handles[c.pts.indexOf(hit.id)]) })),
      };
    } else if (hit.kind === 'line') {
      const c = S.getCurve(sk, hit.id);
      const a = S.getPoint(sk, c.p1), b = S.getPoint(sk, c.p2);
      this.drag = { type: 'line', c, start: raw, a: { ...a }, b: { ...b }, moved: false };
    } else if (hit.kind === 'spline') {
      const c = S.getCurve(sk, hit.id);
      this.drag = { type: 'spline', c, start: raw, p0: [...c.pts, ...(c.handles || [])].map((id) => ({ id, ...S.getPoint(sk, id) })), moved: false };
    } else if (hit.kind === 'circle') {
      this.drag = { type: 'radius', c: S.getCurve(sk, hit.id), moved: false };
    } else if (hit.kind === 'arc' || hit.kind === 'ellipse' || hit.kind === 'earc') {
      const c = S.getCurve(sk, hit.id);
      this.drag = { type: 'center', id: c.c, start: raw, c0: { ...S.getPoint(sk, c.c) }, moved: false };
    }
  }

  pointerMove(ev) {
    const raw = this.localFromEvent(ev);
    const screen = this.vp.screenPos(ev);
    if (this.drag) return this.dragMove(raw, screen);
    if (this.box) return this.boxMove(screen);
    const t = this.tool;
    if (t === 'select') {
      const hit = this.hitTest(raw);
      const h = hit ? hit.id : null;
      if (h !== this.hover) { this.hover = h; this.redraw(); }
      // model edges / vertices can be selected too: highlight them
      const prev = this.extHover, now = performance.now();
      if (hit) this.extHover = null;
      else if (now - (this._extT || 0) > 30) {
        this._extT = now;
        const ext = this.externalHit(ev);
        this.extHover = ext ? { prims: this.externalPrims(ext) } : null;
      }
      if (prev !== this.extHover && (prev || this.extHover)) this.redraw();
      this.vp.canvas.style.cursor = hit || this.extHover ? 'pointer' : 'default';
      this.cursor = null;
      this._updateCursorUI();
      return;
    }
    if (t === 'trim') {
      const hit = this.hitTest(raw, { points: false });
      const prev = this.trimHover;
      this.trimHover = hit ? { id: hit.id, pts: S.trimPreview(this.f, S.getCurve(this.f, hit.id), raw.x, raw.y) } : null;
      if (prev || this.trimHover) this.redraw();
      this.vp.canvas.style.cursor = CURSORS.trim;
      return;
    }
    if (t === 'extend' || t === 'split') {
      const hit = this.hitTest(raw, { points: false });
      const h = hit && (hit.kind === 'line' || hit.kind === 'arc') ? hit.id : null;
      if (h !== this.hover) { this.hover = h; this.redraw(); }
      this.vp.canvas.style.cursor = h ? 'pointer' : 'crosshair';
      return;
    }
    if (t === 'sfillet' || t === 'schamfer') {
      const hit = this.hitTest(raw, { curves: false });
      const h = hit && S.cornerLines(this.f, hit.id) ? hit.id : null;
      if (h !== this.hover) { this.hover = h; this.redraw(); }
      this.vp.canvas.style.cursor = h ? 'pointer' : 'crosshair';
      return;
    }
    if (t === 'offset') {
      this.vp.canvas.style.cursor = CURSORS.offset;
      if (this.draw?.tool === 'offset') this.draw.dist = SO.side(this.f, this.draw.chain, raw.x, raw.y);
      else {
        const hit = this.hitTest(raw, { points: false });
        const id = hit && S.getCurve(this.f, hit.id) ? hit.id : null;
        if (id !== this.offHoverId) { this.offHoverId = id; this.offHover = id ? this.offsetSketchChain(id) : null; }
        const now = performance.now();
        if (id) this.extHover = null;
        else if (now - (this._extT || 0) > 30) {
          this._extT = now;
          const ext = this.externalHit(ev, { vertices: false });
          this.extHover = ext ? { prims: this.offsetSourcePrims(ext).flatMap((x) => x.prims) } : null;
        }
      }
      this.cursor = { p: raw, screen };
      this.redraw();
      return;
    }
    if (t === 'dim' || t === 'convert' || t === 'intersect') {
      this.vp.canvas.style.cursor = CURSORS[t];
      const hit = t === 'dim' ? this.hitTest(raw) : null;
      this.hover = hit ? hit.id : null;
      this.cursor = { p: raw, screen };
      const n = this.draw?.picks?.length ?? 0;
      const picking = !this.draw?.placing && (t === 'convert' || t === 'intersect' || n === 0 || (n === 1 && !['circle', 'arc'].includes(this.draw.picks[0].kind)));
      const now = performance.now();
      if (!hit && picking && now - (this._extT || 0) > 30) {
        this._extT = now;
        const ext = this.externalHit(ev, { vertices: t === 'dim' });
        this.extHover = ext ? { prims: this.externalPrims(ext) } : null;
      } else if (hit || !picking) this.extHover = null;
      if (this.draw?.picks?.length) this.draw.spec = this.dimensionPreview(this.draw.picks, raw);
      this.redraw();
      return;
    }
    this.vp.canvas.style.cursor = 'crosshair';
    const d = this.draw;
    let prev = null;
    if (d?.tool === 'line' || d?.tool === 'centerline') prev = S.getPoint(this.f, d.last);
    else if ((d?.tool === 'slot' || d?.tool === 'ellipse') && d.stage === 1) prev = d.p0;
    const s = this.snap(raw, { prev, exclude: new Set(d?.last ? [d.last] : []) });
    this.cursor = { p: s, screen };
    // show the model edge (or circle) being snapped to
    this.extHover = s.kind === 'model' && s.as !== 'point' ? { prims: this.externalPrims(s.ext) } : null;
    if (d) {
      if (['arc', 'slot', 'cslot', 'oslot', 'arcslot', 'arcslot3', 'arc3', 'ellipse'].includes(d.tool)) {
        if (d.stage === 1) d.p1 = s;
        else if (d.stage === 3) d.p3 = s;
        else {
          d.p2 = s;
          if (d.tool === 'arc' || d.tool === 'arcslot') {
            const a = Math.atan2(s.y - d.p0.y, s.x - d.p0.x);
            if (d.lastAng === null) d.lastAng = Math.atan2(d.p1.y - d.p0.y, d.p1.x - d.p0.x);
            let da = a - d.lastAng;
            while (da > Math.PI) da -= 2 * Math.PI;
            while (da < -Math.PI) da += 2 * Math.PI;
            d.sweep += da;
            d.lastAng = a;
          }
        }
      } else if (d.p0) d.p1 = s;
    }
    this.redraw();
  }

  dragMove(raw, screen) {
    const d = this.drag, sk = this.f;
    if (d.type === 'text') {
      d.t.x = r4(d.x0 + raw.x - d.start.x); d.t.y = r4(d.y0 + raw.y - d.start.y); d.moved = true;
      // move the outline with it until the kernel sends the new one
      const dx = d.t.x - (d.lastX ?? d.x0), dy = d.t.y - (d.lastY ?? d.y0);
      d.lastX = d.t.x; d.lastY = d.t.y;
      const polys = this.textPolys?.[d.t.id];
      if (polys) for (const pl of polys) for (const q of pl) { q[0] += dx; q[1] += dy; }
      this._textKey = JSON.stringify(this.f.texts);
      this.redraw();
      return;
    }
    let r;
    if (d.type === 'point') {
      const s = this.snap(raw, { exclude: new Set([d.id]) });
      const x = s.kind === 'grid' ? raw.x : s.x, y = s.kind === 'grid' ? raw.y : s.y;
      r = this.solve({ pin: [{ id: d.id, x, y }, ...(d.handles || []).map((q) => ({ id: q.id, x: q.x + x - d.p0.x, y: q.y + y - d.p0.y }))] });
    } else if (d.type === 'line') {
      const dx = raw.x - d.start.x, dy = raw.y - d.start.y;
      const pin = [];
      if (d.c.p1 !== 'O') pin.push({ id: d.c.p1, x: d.a.x + dx, y: d.a.y + dy });
      if (d.c.p2 !== 'O') pin.push({ id: d.c.p2, x: d.b.x + dx, y: d.b.y + dy });
      r = this.solve({ pin });
    } else if (d.type === 'spline') {
      const dx = raw.x - d.start.x, dy = raw.y - d.start.y;
      r = this.solve({ pin: d.p0.filter((q) => q.id !== 'O').map((q) => ({ id: q.id, x: q.x + dx, y: q.y + dy })) });
    } else if (d.type === 'radius') {
      const c = S.getPoint(sk, d.c.c);
      r = this.solve({ pinR: [{ id: d.c.id, r: Math.max(1e-3, Math.hypot(raw.x - c.x, raw.y - c.y)) }] });
    } else if (d.type === 'center') {
      if (d.id === 'O') return;
      r = this.solve({ pin: [{ id: d.id, x: d.c0.x + raw.x - d.start.x, y: d.c0.y + raw.y - d.start.y }] });
    }
    if (r?.ok) d.moved = true;
    else this.solve();
    this.cursor = null;
    this.redraw();
  }

  pointerUp(ev) {
    if (this.box) { this.boxEnd(); return; }
    if (this.drag) {
      const moved = this.drag.moved;
      this.drag = null;
      if (moved) this.changed();
      return;
    }
    const d = this.draw;
    if (d?.downAt && ['rect', 'crect', 'circle', 'polygon'].includes(d.tool)) {
      const s = this.vp.screenPos(ev);
      if (Math.hypot(s.x - d.downAt.x, s.y - d.downAt.y) > 6) { d.s1 = d.p1; this.commit(); }
    }
  }

  // ------------------------------------------------------------ selection box
  // Dragged from empty space with the Select tool. Left to right: a window, selecting what lies wholly inside it
  // (drawn solid); right to left: crossing, selecting whatever it touches (drawn dashed). Points and curves, tested
  // as they are drawn on the screen (so any view works); Ctrl or Shift adds to the selection.
  boxMove(screen) {
    const B = this.box;
    B.b = screen;
    if (Math.hypot(B.b.x - B.a.x, B.b.y - B.a.y) < 4 && !B.el) return;
    if (!B.el) {
      B.el = document.createElement('div');
      B.el.className = 'sk-box';
      this.vp.canvas.parentElement.appendChild(B.el);
    }
    const cr = this.vp.canvas.getBoundingClientRect(), pr = this.vp.canvas.parentElement.getBoundingClientRect();
    const x0 = Math.min(B.a.x, B.b.x), y0 = Math.min(B.a.y, B.b.y);
    Object.assign(B.el.style, { left: `${x0 + cr.left - pr.left}px`, top: `${y0 + cr.top - pr.top}px`, width: `${Math.abs(B.b.x - B.a.x)}px`, height: `${Math.abs(B.b.y - B.a.y)}px` });
    B.el.classList.toggle('crossing', B.b.x < B.a.x);
  }
  boxEnd() {
    const B = this.box;
    this.box = null;
    B.el?.remove();
    if (!B.el) return;
    const ids = this.boxItems(B.a, B.b, B.b.x < B.a.x);
    for (const id of ids) this.sel.add(id);
    this.redraw();
    this.app.ui.renderPM();
    this.app.ui.refreshCommandStates();
    this.app.status(`${ids.length} entit${ids.length === 1 ? 'y' : 'ies'} selected by the box (${B.b.x < B.a.x ? 'crossing: whatever it touches' : 'window: wholly inside'}).`);
  }
  // The points and curves of the sketch in the box a–b (screen); crossing: also those it touches
  boxItems(a, b, crossing) {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    const scr = (x, y) => this.vp.project(G.toWorld(this.frame, x, y));
    const inside = (q) => q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1;
    // a segment touching the box: an end inside, or crossing one of its sides
    const cuts = (p, q) => {
      if (inside(p) || inside(q)) return true;
      const sides = [[{ x: x0, y: y0 }, { x: x1, y: y0 }], [{ x: x1, y: y0 }, { x: x1, y: y1 }], [{ x: x1, y: y1 }, { x: x0, y: y1 }], [{ x: x0, y: y1 }, { x: x0, y: y0 }]];
      const cr = (o, u, v) => (u.x - o.x) * (v.y - o.y) - (u.y - o.y) * (v.x - o.x);
      return sides.some(([c, d]) => cr(p, q, c) * cr(p, q, d) < 0 && cr(c, d, p) * cr(c, d, q) < 0);
    };
    const out = [];
    for (const p of this.f.points) {
      if (p.id === 'O') continue;
      if (inside(scr(p.x, p.y))) out.push(p.id);
    }
    for (const c of this.f.curves) {
      const q = S.curvePoints(this.f, c).map(([x, y]) => scr(x, y));
      if (!q.length) continue;
      const hit = crossing ? q.some((p, i) => (i ? cuts(q[i - 1], p) : inside(p))) : q.every(inside);
      if (hit) out.push(c.id);
    }
    return out;
  }

  doubleClick() {
    if (this.draw?.tool === 'line' || this.draw?.tool === 'spline' || this.draw?.tool === 'cspline') this.endDraw(true);
  }

  leave() {
    this.cursor = null;
    this.trimHover = null;
    this._updateCursorUI();
  }

  endDraw(changed = false) {
    const had = !!this.draw;
    // a spline being drawn is made from the points placed so far (two at least)
    if (this.draw?.tool === 'spline' || this.draw?.tool === 'cspline') {
      const pts = this.draw.pts.filter((id, i, a) => !i || id !== a[i - 1]);
      if (pts.length >= 2) {
        if (this.draw.tool === 'cspline') S.addCtrlSpline(this.f, pts, Math.min(this.splineDegree, pts.length - 1), this.constructionMode);
        else S.addFitSpline(this.f, pts, false, this.constructionMode);
        this.solve(); changed = true;
      }
    }
    if (this.draw?.ext?.length) { S.deleteItems(this.f, this.draw.ext); changed = true; }
    this.draw = null;
    if (had) { S.cleanup(this.f); if (changed) this.changed(); else this.redraw(); }
  }

  key(e) {
    if (this.dimLabelDrag && e.key === 'Escape') { this.dimLabelDrag.cancel(); return true; }
    if (this.airfoilPick && e.key === 'Escape') { this.endAirfoilPick(true); return true; }
    if (this.gearPick && e.key === 'Enter') { this.makeGears(); return true; }
    if (this.patternDraft && (e.key === 'Escape' || e.key === 'Enter')) { this.finishPattern(e.key === 'Enter'); return true; }
    if (this.patternDraft && (e.key === 'Delete' || e.key === 'Backspace')) { this.app.status('Remove pattern sources with the × buttons in the Property panel, or click them again in the sketch.'); return true; }
    if (this.gearPick && e.key === 'Escape') { this.endGearPick(); this.sel.clear(); this.redraw(); this.app.ui.renderPM(); this.app.status('Gears cancelled.'); return true; }
    if (e.key === 'Escape') {
      if (this.modifyEl) { this.closeModify(); return true; }
      if (this.draw) { this.endDraw(this.draw.tool !== 'dim'); return true; }
      if (this.tool !== 'select') { this.setTool('select'); return true; }
      if (this.sel.size) { this.sel.clear(); this.redraw(); this.app.ui.renderPM(); this.app.ui.refreshCommandStates(); return true; }
      return false;
    }
    if (e.key === 'Enter' && this.modifyEl) { this.modifyEl.querySelector('input')?.focus(); return true; }
    if (e.key === 'Enter' && (this.draw?.tool === 'line' || this.draw?.tool === 'spline' || this.draw?.tool === 'cspline')) { this.endDraw(true); return true; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel.size) { this.deleteSelected(); return true; }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const map = { l: 'line', r: 'rect', c: 'circle', a: 'arc', n: 'spline', p: 'polygon', s: 'select', t: 'trim', d: 'dim', e: 'convert', o: 'offset' };
    const k = e.key.toLowerCase();
    if (map[k]) { this.setTool(map[k]); return true; }
    if (k === 'q') { this.toggleConstruction(); return true; }
    return false;
  }

  // ------------------------------------------------------------ commands
  // Mirror the selected entities about the selected centerline (the last construction line picked).
  mirrorSelected() {
    const ids = [...this.sel];
    const axis = ids.map((id) => S.getCurve(this.f, id)).filter((c) => c?.type === 'line' && c.construction).pop();
    if (!axis) { this.app.toast('Select the entities to mirror and a centerline to mirror them about (Ctrl+click to select several)', true); return; }
    let created;
    try { created = S.mirrorItems(this.f, ids, axis.id); } catch (e) { this.app.toast(e.message, true); return; }
    this.sel = new Set(created.filter((id) => S.getCurve(this.f, id)));
    this.changed();
    this.app.status(`Mirrored ${this.sel.size} entit${this.sel.size === 1 ? 'y' : 'ies'} about ${S.itemName(this.f, axis.id)} (kept symmetric).`);
  }

  // Curves where this sketch's plane cuts the solid bodies, added as linked geometry.
  intersectionCurve() { this.setTool('intersect'); }

  // Turn the sketch's horizontal / vertical directions by 90° (dir 1: counter-clockwise).
  rotateAxes(dir) {
    this.endDraw();
    const f = this.f;
    S.rotateSketchAxes(f, dir);
    f.plane = { ...f.plane, rot: ((((f.plane.rot || 0) + dir * 90) % 360) + 360) % 360 };
    const fr = this.frame;
    this.setFrame(dir > 0 ? { o: fr.o, u: fr.v.clone(), v: fr.u.clone().negate(), n: fr.n } : { o: fr.o, u: fr.v.clone().negate(), v: fr.u.clone(), n: fr.n });
    this.changed();
    this.app.status('Sketch orientation turned 90°. Horizontal and vertical relations follow the new axes; the geometry stays in place.');
  }

  deleteSelected() {
    if (!this.sel.size) return;
    const sk = this.f;
    const handles = new Set(sk.curves.filter((c) => c.handles && !this.sel.has(c.id)).flatMap((c) => [...c.handles, ...sk.curves.filter((q) => q.fitHandle && q.ctrlOf === c.id).map((q) => q.id)]));
    const ids = [...this.sel].filter((id) => id !== 'O' && !handles.has(id));
    if (!ids.length) { this.app.status('Tangent handles belong to their spline; drag or constrain them, or delete the spline.'); return; }
    if (sk.texts?.length) sk.texts = sk.texts.filter((t) => !ids.includes(t.id));
    for (const id of ids) if (String(id).startsWith('gear:')) { const tr = this.trainById(String(id).split(':')[1]); if (tr) this.deleteTrain(tr); }
    for (const id of ids) if (String(id).startsWith('airfoil:')) { const af = S.airfoilById(sk, String(id).slice(8)); if (af) this.deleteAirfoil(af); }
    // a spline loses the deleted points it runs through (and goes when fewer than two are left; a control-point
    // spline loses those control points and their weights)
    const gone = [];
    for (const c of sk.curves) {
      if (c.type !== 'spline' || !c.pts.some((id) => ids.includes(id))) continue;
      if (c.weights) c.weights = c.weights.filter((_, i) => !ids.includes(c.pts[i]));
      if (c.handles) c.handles = c.handles.filter((_, i) => !ids.includes(c.pts[i]));
      c.pts = c.pts.filter((id) => !ids.includes(id));
      if (c.pts.length >= (c.closed ? 3 : 2)) { c.p1 = c.pts[0]; c.p2 = c.closed ? c.pts[0] : c.pts[c.pts.length - 1]; } else gone.push(c.id);
    }
    // deleting a point removes the curves that use it
    const extra = [...gone, ...sk.curves.filter((c) => ids.includes(c.p1) || ids.includes(c.p2) || ids.includes(c.c)).map((c) => c.id)];
    S.deleteItems(sk, [...ids, ...extra]);
    // control polygons made whole again (a deleted leg comes back; a deleted control point's legs are joined up)
    for (const c of sk.curves) if (c.ctrl) S.syncCtrlPolygon(sk, c);
    for (const c of sk.curves) if (c.handles) S.syncFitHandles(sk, c);
    this.sel.clear();
    this.changed();
  }

  toggleConstruction() {
    const curves = [...this.sel].map((id) => S.getCurve(this.f, id)).filter(Boolean);
    if (!curves.length) {
      this.constructionMode = !this.constructionMode;
      this.redraw(); this.app.ui.renderPM(); this.app.ui.refreshCommandStates();
      this.app.status(this.constructionMode ? 'New geometry will be construction geometry.' : 'New geometry will be profile geometry.');
      return;
    }
    const to = !curves.every((c) => c.construction);
    curves.forEach((c) => (c.construction = to));
    this.changed();
  }

  toggleDims() { this.dimsVisible = !this.dimsVisible; this.redraw(); this.app.ui.refreshCommandStates(); this.app.ui.renderPM(); }
  toggleRelations() { this.relsVisible = !this.relsVisible; this.redraw(); this.app.ui.refreshCommandStates(); this.app.ui.renderPM(); }

  selectedItems() {
    return [...this.sel].map((id) => {
      if (id === 'O' || this.f.points.some((p) => p.id === id)) return { id, kind: 'point' };
      const t = this.textById(id);
      if (t) return { id, kind: 'text', t };
      if (String(id).startsWith('gear:')) return { id, kind: 'gear' };
      if (String(id).startsWith('airfoil:')) return { id, kind: 'airfoil' };
      const c = S.getCurve(this.f, id);
      if (c) return { id, kind: c.type, c };
      const k = this.f.constraints.find((x) => x.id === id);
      if (k) return { id, kind: k.type === 'dim' ? 'dim' : 'relation', k };
      return null;
    }).filter(Boolean);
  }

  // Relations that can be added for the current selection.
  relationLabel(relation) {
    const type = typeof relation === 'string' ? relation : relation.type;
    const refs = typeof relation === 'string' ? this.selectedItems().map((i) => i.id) : relation.refs;
    if (type === 'equal' && refs.length && refs.every((id) => ['circle', 'arc'].includes(S.getCurve(this.f, id)?.type))) return 'Equal Radius';
    return RELATION_INFO[type]?.label || type;
  }

  applicableRelations() {
    const items = this.selectedItems().filter((i) => i.kind !== 'dim' && i.kind !== 'relation' && i.kind !== 'text' && i.kind !== 'gear' && i.kind !== 'airfoil');
    const pts = items.filter((i) => i.kind === 'point');
    const lines = items.filter((i) => i.kind === 'line');
    const rounds = items.filter((i) => i.kind === 'circle' || i.kind === 'arc');
    const n = items.length, out = [];
    if (!n) return out;
    if (n === 1) {
      if (lines.length) out.push('horizontal', 'vertical', 'fix');
      if (pts.length && pts[0].id !== 'O') out.push('fix');
      if (rounds.length) out.push('fix');
      return out;
    }
    if (pts.length === n) out.push('coincident', 'horizontal', 'vertical');
    if (lines.length === n) out.push('horizontal', 'vertical', 'parallel', 'equal');
    if (lines.length === 2 && n === 2) out.push('perpendicular', 'collinear', 'midpoint');
    if (rounds.length === n) out.push('equal', 'concentric');
    if (n >= 2 && items.every((i) => ['line', 'arc', 'circle', 'ellipse', 'earc', 'spline'].includes(i.kind)) && lines.length !== n) out.push('equalLength');
    if (n === 2 && rounds.length === 2) out.push('tangent');
    if (n === 2 && pts.length === 1 && (lines.length === 1 || rounds.length === 1)) out.push('onCurve');
    if (n === 2 && pts.length === 1 && (lines.length === 1 || (rounds.length === 1 && rounds[0].kind === 'arc'))) out.push('midpoint');
    if (n === 2 && lines.length === 1 && rounds.length === 1) out.push('tangent');
    if ((n===2||n===3&&pts.length===1)&&lines.length===1&&items.some(i=>i.kind==='spline'&&!S.getCurve(this.f,i.id)?.closed)) out.push('tangent');
    if (n === 3 && pts.length === 2 && lines.length === 1) out.push('symmetric');
    if (n === 3 && lines.length === 3) out.push('symmetric');
    return [...new Set(out)];
  }

  addRelation(type) {
    const sk = this.f;
    const items = this.selectedItems().filter((i) => i.kind !== 'dim' && i.kind !== 'relation');
    const ids = items.map((i) => i.id);
    const list = [];
    const pts = items.filter((i) => i.kind === 'point').map((i) => i.id);
    const lines = items.filter((i) => i.kind === 'line').map((i) => i.id);
    const rounds = items.filter((i) => i.kind === 'circle' || i.kind === 'arc').map((i) => i.id);
    const chain = (t, arr) => { for (let i = 1; i < arr.length; i++) list.push([t, [arr[0], arr[i]]]); };
    switch (type) {
      case 'horizontal':
      case 'vertical':
        if (lines.length) lines.forEach((l) => list.push([type, [l]]));
        else chain(type, pts);
        break;
      case 'coincident': chain('coincident', pts); break;
      case 'parallel': chain('parallel', lines); break;
      case 'perpendicular': list.push(['perpendicular', lines]); break;
      case 'collinear': list.push(['collinear', lines]); break;
      case 'equal': chain('equal', lines.length ? lines : rounds); break;
      case 'equalLength': chain('equalLength', ids); break;
      case 'concentric': chain('concentric', rounds); break;
      case 'onCurve': list.push(['onCurve', [pts[0], lines[0] || rounds[0]]]); break;
      case 'midpoint':
        if (lines.length === 2 && items.length === 2) list.push(['midpointCoincident', lines]);
        else list.push(['midpoint', [pts[0], lines[0] || rounds[0]]]);
        break;
      case 'midpointCoincident': list.push(['midpointCoincident', lines]); break;
      case 'tangent': {
        const spline=items.find(i=>i.kind==='spline');
        if(lines.length&&spline){
          try{list.push(['tangent',[lines[0],spline.id,S.lineSplineTangentEnd(sk,lines[0],spline.id,pts[0])]]);}
          catch(e){this.app.toast(e.message,true);return;}
        }
        else if (lines.length) list.push(['tangent', [lines[0], rounds[0]], { s: S.tangentSign(sk, lines[0], rounds[0]) }]);
        else {
          const a = S.getCurve(sk, rounds[0]), b = S.getCurve(sk, rounds[1]);
          const ca = S.getPoint(sk, a.c), cb = S.getPoint(sk, b.c);
          const d = Math.hypot(ca.x - cb.x, ca.y - cb.y), ra = S.radiusOf(sk, a), rb = S.radiusOf(sk, b);
          list.push(['tangent', rounds, { internal: Math.abs(d - Math.abs(ra - rb)) < Math.abs(d - ra - rb) }]);
        }
        break;
      }
      case 'symmetric': {
        if (pts.length === 2) list.push(['symmetric', [pts[0], pts[1], lines[0]]]);
        else {
          // two lines symmetric about the third (prefer a centerline as the axis)
          const curves = lines.map((id) => S.getCurve(sk, id));
          const axis = curves.find((c) => c.construction) || curves[2];
          const [l1, l2] = curves.filter((c) => c !== axis);
          const P = (id) => S.getPoint(sk, id);
          const straight = Math.hypot(P(l1.p1).x - P(l2.p1).x, P(l1.p1).y - P(l2.p1).y) + Math.hypot(P(l1.p2).x - P(l2.p2).x, P(l1.p2).y - P(l2.p2).y);
          const crossed = Math.hypot(P(l1.p1).x - P(l2.p2).x, P(l1.p1).y - P(l2.p2).y) + Math.hypot(P(l1.p2).x - P(l2.p1).x, P(l1.p2).y - P(l2.p1).y);
          const pairs = straight <= crossed ? [[l1.p1, l2.p1], [l1.p2, l2.p2]] : [[l1.p1, l2.p2], [l1.p2, l2.p1]];
          pairs.forEach(([a, b]) => list.push(['symmetric', [a, b, axis.id]]));
        }
        break;
      }
      case 'fix': {
        const fixPts = new Set();
        for (const id of ids) {
          const c = S.getCurve(sk, id);
          if (!c) fixPts.add(id);
          else for (const k of ['p1', 'p2', 'c']) if (c[k]) fixPts.add(c[k]);
          if (c?.type === 'circle') list.push(['dim', [c.id], { kind: 'radius', value: r4(c.r), hidden: true }]);
        }
        fixPts.delete('O');
        for (const p of fixPts) { const q = S.getPoint(sk, p); list.push(['fix', [p], { x: q.x, y: q.y }]); }
        break;
      }
    }
    if (!list.length) return;
    const result = this.tryAddConstraints(list);
    if (result) {
      this.app.status(`${this.relationLabel(type)} relation added${result.redundant ? ` (${result.redundant} already satisfied)` : ''}`);
      this.changed();
    }
  }

  deleteConstraint(id) {
    const k = this.f.constraints.find((x) => x.id === id);
    if (k?.kind === 'offset') {
      let v = 0;
      try { v = this.ev(k.value); } catch { /* keep the stored value */ }
      for (const r of this.f.constraints) if (['offset','offsetGeometry'].includes(r.type) && r.dim === id) { r.v = v; delete r.dim; }
    }
    S.deleteItems(this.f, [id]);
    this.sel.delete(id);
    this.changed();
  }

  // Relations/dimensions that reference any selected item.
  relationsForSelection() {
    const ids = new Set(this.sel);
    for (const id of [...ids]) {
      const c = S.getCurve(this.f, id);
      if (c) for (const k of ['p1', 'p2', 'c']) if (c[k]) ids.add(c[k]);
    }
    return this.f.constraints.filter((k) => k.refs.some((r) => ids.has(r)) || ids.has(k.id));
  }

  // Move a point to exact coordinates (from the Property panel).
  movePoint(id, x, y) {
    const r = this.solve({ pin: [{ id, x, y }] });
    if (!r.ok) { this.solve(); this.app.toast('The point is constrained and cannot move there', true); }
    this.changed(false);
    return r.ok;
  }

  // ------------------------------------------------------------ geometry creation
  commit() {
    const d = this.draw;
    if (!d) return;
    this.draw = null;
    const sk = this.f;
    const oldCurves = new Set(sk.curves.map((c) => c.id));
    const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-9;
    if (d.tool === 'midline') {
      if (near(d.p0, d.p1)) return this.redraw();
      const m = this.resolve(d.s0), end = this.resolve(d.s1);
      if (m !== 'O') S.getPoint(sk, m).keep = true;
      const a = S.addPoint(sk, 2 * d.p0.x - d.p1.x, 2 * d.p0.y - d.p1.y);
      const line = S.addLine(sk, a, end);
      S.addRel(sk, 'midpoint', [m, line]);
      if (d.s1.infer) S.addRel(sk, d.s1.infer, [line]);
    } else if (d.tool === 'rect') {
      if (Math.abs(d.p1.x - d.p0.x) < 1e-6 || Math.abs(d.p1.y - d.p0.y) < 1e-6) return this.redraw();
      const A = this.resolve(d.s0), C = this.resolve(d.s1);
      S.buildRect(sk, A, C);
    } else if (d.tool === 'crect') {
      const hw = Math.abs(d.p1.x - d.p0.x), hh = Math.abs(d.p1.y - d.p0.y);
      if (hw < 1e-6 || hh < 1e-6) return this.redraw();
      const M = this.resolve(d.s0);
      const m = S.getPoint(sk, M);
      const r = S.buildCenterRect(sk, M, m.x, m.y, hw, hh);
      this.attachCorner(r.corners, d.s1);
    } else if (d.tool === 'circle') {
      const rad = Math.hypot(d.p1.x - d.p0.x, d.p1.y - d.p0.y);
      if (rad < 1e-6) return this.redraw();
      const c = this.resolve(d.s0);
      const cid = S.addCircle(sk, c, r4(rad));
      if (d.s1?.kind === 'point') S.addRel(sk, 'onCurve', [d.s1.id, cid]);
    } else if (d.tool === 'polygon') {
      if (near(d.p0, d.p1)) return this.redraw();
      const c = this.resolve(d.s0);
      const p = S.buildPolygon(sk, c, d.p1.x, d.p1.y, this.polySides);
      if (d.s1?.kind === 'point') S.addRel(sk, 'coincident', [p.points[0], d.s1.id]);
    } else if (d.tool === 'arc') {
      const rad = Math.hypot(d.p1.x - d.p0.x, d.p1.y - d.p0.y);
      if (rad < 1e-6 || Math.abs(d.sweep) < 1e-3) return this.redraw();
      const c = this.resolve(d.s0);
      const sId = this.resolve(d.s1);
      let eId;
      if (d.s2.kind === 'point') eId = d.s2.id;
      else {
        const a = Math.atan2(d.p2.y - d.p0.y, d.p2.x - d.p0.x);
        eId = S.addPoint(sk, d.p0.x + rad * Math.cos(a), d.p0.y + rad * Math.sin(a));
      }
      if (d.sweep >= 0) S.addArc(sk, c, sId, eId); else S.addArc(sk, c, eId, sId);
    } else if (d.tool === 'arc3') {
      const C = S.circleThrough([d.p0.x, d.p0.y], [d.p1.x, d.p1.y], [d.p2.x, d.p2.y]);
      if (!C || near(d.p0, d.p1) || C.r > 1e6) return this.redraw();
      const a = this.resolve(d.s0), b = this.resolve(d.s1);
      const c = S.addPoint(sk, r4(C.cx), r4(C.cy));
      // counter-clockwise from the start through the third point to the end, or the other way
      const ccw = (d.p2.x - d.p0.x) * (d.p1.y - d.p0.y) - (d.p2.y - d.p0.y) * (d.p1.x - d.p0.x) > 0;
      if (ccw) S.addArc(sk, c, a, b); else S.addArc(sk, c, b, a);
    } else if (d.tool === 'tarc') {
      const g = this.tarcGeom(d);
      if (!g) return this.redraw();
      const e = this.resolve(d.s1);
      const c = S.addPoint(sk, g.cx, g.cy);
      const arc = g.ccw ? S.addArc(sk, c, d.from, e) : S.addArc(sk, c, e, d.from);
      S.addRel(sk, 'tangent', [d.curve, arc]);
    } else if (d.tool === 'ellipse') {
      const ra = Math.hypot(d.p1.x - d.p0.x, d.p1.y - d.p0.y);
      if (ra < 1e-6) return this.redraw();
      const ux = (d.p1.x - d.p0.x) / ra, uy = (d.p1.y - d.p0.y) / ra;
      const rb = Math.abs(-(d.p2.x - d.p0.x) * uy + (d.p2.y - d.p0.y) * ux);
      if (rb < 1e-6) return this.redraw();
      const c = this.resolve(d.s0), a = this.resolve(d.s1);
      S.addEllipse(sk, c, a, r4(rb));
    } else if (['slot', 'cslot', 'oslot', 'arcslot', 'arcslot3'].includes(d.tool)) {
      const g = S.slotLayout(d.tool, [d.p0, d.p1, d.p2, d.p3], d.sweep);
      if (!g) { this.app.toast('Invalid slot: use a positive width smaller than the overall length or centre-arc diameter, without overlapping ends', true); return this.redraw(); }
      const point = (p) => S.addPoint(sk, p.x, p.y);
      if (g.type === 'line') {
        const c1 = d.tool === 'slot' ? this.resolve(d.s0) : point(g.a);
        const c2 = d.tool === 'oslot' ? point(g.b) : this.resolve(d.s1);
        const sl = S.buildSlot(sk, c1, c2, g.r);
        if (d.tool === 'cslot') {
          const m = this.resolve(d.s0); if (m !== 'O') S.getPoint(sk, m).keep = true;
          S.addRel(sk, 'midpoint', [m, sl.centerline]);
        }
        if (d.tool === 'oslot') {
          const a = this.resolve(d.s0), b = this.resolve(d.s1), axis = S.addLine(sk, a, b, true);
          S.addRel(sk, 'collinear', [axis, sl.centerline]);
          S.addRel(sk, 'onCurve', [a, sl.arcs[0]]); S.addRel(sk, 'onCurve', [b, sl.arcs[1]]);
          if (d.s1.infer) S.addRel(sk, d.s1.infer, [axis]);
        } else if (d.s1.infer) S.addRel(sk, d.s1.infer, [sl.centerline]);
      } else {
        const centre = d.tool === 'arcslot' ? this.resolve(d.s0) : point(g.c);
        const match = (p, s) => s && Math.hypot(p.x - s.x, p.y - s.y) < 1e-6;
        const endPoint = (p) => {
          const s = [d.s0, d.s1, d.s2].find((s) => s && (d.tool !== 'arcslot' || s !== d.s0) && match(p, s));
          return s ? this.resolve(s) : point(p);
        };
        const sl = S.buildArcSlot(sk, centre, endPoint(g.a), endPoint(g.b), g.r);
        // Like a three-point arc, the third click defines curvature without leaving
        // a free helper point. Preserve a reference only when snapped to geometry.
        if (d.tool === 'arcslot3' && ['point', 'model'].includes(d.s2.kind)) S.addRel(sk, 'onCurve', [this.resolve(d.s2), sl.centerline]);
      }
    }
    if (this.constructionMode) for (const c of sk.curves) if (!oldCurves.has(c.id)) c.construction = true;
    this.changed();
  }

  // A tangent arc from d.from (leaving along d.t) to d.p1: its centre and turn, or null (in line)
  tarcGeom(d) {
    const P = d.p0, E = d.p1, t = d.t;
    if (!t) return null;
    const n = [-t[1], t[0]], w = [E.x - P.x, E.y - P.y], wn = w[0] * n[0] + w[1] * n[1], L2 = w[0] * w[0] + w[1] * w[1];
    if (L2 < 1e-12 || Math.abs(wn) < 1e-6 * Math.sqrt(L2)) return null;
    const k = L2 / (2 * wn), cx = P.x + n[0] * k, cy = P.y + n[1] * k;
    if (Math.abs(k) > 1e6) return null;
    return { cx, cy, r: Math.abs(k), ccw: k > 0 };
  }

  // ------------------------------------------------------------ sketch patterns and blocks
  // The selected entities (curves and lone points) for a pattern / block.
  patternSource() {
    return [...this.sel].filter((id) => id !== 'O' && (S.getCurve(this.f, id) || this.f.points.some((q) => q.id === id)));
  }

  linearPatternSel(id = null) {
    const selected = S.patternEntities(this.f);
    const p = this.f.patterns?.find((p) => p.id === id || [...this.sel].some((q) => p.generated?.curves.includes(q) || p.generated?.points.includes(q)));
    this.setTool('select');
    this.patternDraft = p ? JSON.parse(JSON.stringify(p)) : { sources: this.patternSource().filter((id) => !selected.has(id)), path: '', n1: '3', d1: '20', a1: '0', n2: '1', d2: '20', a2: '90', turn: false };
    this.patternDraft.pick = 'sources';
    this.updatePatternPreview();
    this.app.ui.renderPM();
  }

  updatePatternPreview() {
    if (!this.patternDraft) return;
    this.sel = new Set([...this.patternDraft.sources, this.patternDraft.path].filter(Boolean));
    this.patternPreview = null;
    this.patternError = '';
    try {
      const tmp = JSON.parse(JSON.stringify(this.f));
      // Preview allocation must not extend the draft's ID pools: the next preview
      // starts from the real sketch's counter and could reuse those temporary IDs.
      const p = S.setSketchPattern(tmp, JSON.parse(JSON.stringify(this.patternDraft)), this.ev);
      this.patternPreview = { sketch: tmp, pattern: p };
    } catch (e) { this.patternError = e.message; }
    this.redraw();
  }

  finishPattern(ok) {
    if (!this.patternDraft) return;
    if (ok) {
      this.updatePatternPreview();
      if (!this.patternPreview) { this.app.toast(this.patternError, true); return; }
      const { sketch, pattern } = this.patternPreview;
      for (const k of ['points', 'curves', 'constraints', 'patterns', 'nextSid']) this.f[k] = sketch[k];
      this.sel = new Set(pattern.generated.curves);
    }
    this.patternDraft = null; this.patternPreview = null; this.patternError = '';
    if (ok) this.changed();
    else { this.redraw(); this.app.ui.renderPM(); }
  }

  async circularPatternSel() {
    const ids = this.patternSource();
    // a selected point that no selected curve uses is the centre (else the origin)
    const used = new Set(ids.flatMap((id) => { const c = S.getCurve(this.f, id); return c ? [c.p1, c.p2, c.c, c.a, ...(c.pts || [])] : []; }));
    const ctrId = [...this.sel].find((id) => (id === 'O' || this.f.points.some((q) => q.id === id)) && !used.has(id));
    const curves = ids.filter((id) => id !== ctrId);
    if (!curves.length) { this.app.toast('Select the entities to pattern first (and a point to turn them about; the origin otherwise)', true); return; }
    const C = ctrId ? S.getPoint(this.f, ctrId) : { x: 0, y: 0 };
    const v = await this.app.ui.promptFields('Circular Sketch Pattern', 'skCirPattern', [
      { key: 'n', label: 'Number of instances (including the original)', type: 'expr', value: 6 },
      { key: 'total', label: 'Total angle (°; 360 spreads them evenly round)', type: 'expr', value: 360 },
      { key: 'cx', label: 'Centre X (mm)', type: 'expr', value: +C.x.toFixed(4) },
      { key: 'cy', label: 'Centre Y (mm)', type: 'expr', value: +C.y.toFixed(4) },
    ], ctrId ? 'Turned about the selected point.' : 'Turned about the centre below (select a point with the entities to use it).');
    if (!v || !this.active) return;
    const n = (x) => this.ev(String(x));
    const o = { n: Math.round(n(v.n)), total: n(v.total), cx: n(v.cx), cy: n(v.cy) };
    if (![o.n, o.total, o.cx, o.cy].every(Number.isFinite) || o.n < 2 || o.n > 500 || !(Math.abs(o.total) > 1e-6)) { this.app.toast('Enter numbers: 2 to 500 instances over a non-zero angle', true); return; }
    const made = S.circularPattern(this.f, curves, o);
    this.sel = new Set(made);
    this.changed();
    this.app.status(`Circular sketch pattern: ${o.n - 1} cop${o.n === 2 ? 'y' : 'ies'} made.`);
  }

  // Import a DXF file's lines, arcs, circles, ellipses, splines and points into this sketch.
  async importDXF() {
    let file;
    try { file = await platform.openDXF(); } catch (e) { this.app.toast('Could not open the file: ' + e.message, true); return; }
    if (!file || !this.active) return;
    let shapes, dxf;
    try { dxf = parseDXF(file.text); shapes = dxfShapes(dxf); } catch (e) { this.app.toast('That DXF could not be read: ' + e.message, true); return; }
    if (!shapes.length) { this.app.toast('The DXF has no lines, arcs, circles, ellipses, splines or points to import', true); return; }
    // its extent, for placing it
    const xs = [], ys = [];
    for (const s of shapes) for (const q of s.line || (s.arc || s.circle || s.ellipse ? [s.arc?.c || s.circle?.c || s.ellipse.c] : s.spline ? s.spline.pts : s.point ? [s.point] : [])) { xs.push(q[0]); ys.push(q[1]); }
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    const v = await this.app.ui.promptFields('Import DXF', 'dxfImport', [
      { key: 'scale', label: 'Scale', value: 1 },
      { key: 'place', label: 'Place', type: 'select', options: [['asis', 'As in the file (its origin on the sketch origin)'], ['centre', 'Centred on the sketch origin'], ['corner', 'Its lower left corner on the origin']], value: 'asis' },
    ], `${file.name}: ${shapes.length} entities, ${fmt(w, 3)} × ${fmt(h, 3)} mm${dxf.units !== 1 ? ` (converted from the file's units, ×${dxf.units})` : ''}.`);
    if (!v || !this.active) return;
    const k = this.ev(String(v.scale));
    if (!(k > 0)) { this.app.toast('The scale must be greater than zero', true); return; }
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    const off = v.place === 'centre' ? [-(x0 + w / 2) * k, -(y0 + h / 2) * k] : v.place === 'corner' ? [-x0 * k, -y0 * k] : [0, 0];
    const r = addShapes(this.f, shapes, { k, dx: off[0], dy: off[1], tol: Math.max(1e-6, (Math.max(w, h) * k) * 1e-7) });
    this.sel = new Set(r.curves);
    this.changed();
    this.app.status(`Imported ${r.curves.length} entit${r.curves.length === 1 ? 'y' : 'ies'} from ${file.name}${r.skipped ? ` (${r.skipped} skipped)` : ''}.`);
  }

  async makeBlock() {
    const ids = this.patternSource();
    const data = ids.length ? S.blockData(this.f, ids) : null;
    if (!data) { this.app.toast('Select the entities for the block first', true); return; }
    const name = (await this.app.ui.promptText('Make Block', 'skBlock', 'Name of the block (it is kept with your settings, for any sketch):', 'Block ' + ((this.app.ui.prefs?.blocks || []).length + 1)))?.trim();
    if (!name) return;
    const ui = this.app.ui;
    ui.prefs ||= {};
    const list = (ui.prefs.blocks ||= []).filter((b) => b.name !== name);
    list.push({ name, data });
    ui.prefs.blocks = list;
    ui.savePrefs();
    const n = S.updateBlockInstances(this.f, { name, data });
    if (n) this.changed();
    this.app.status(`Block "${name}" saved: Insert Block puts copies of it in any sketch.${n ? ` ${n} cop${n === 1 ? 'y' : 'ies'} of it in this sketch updated.` : ''}`);
  }

  async insertBlock() {
    const ui = this.app.ui, list = ui.prefs?.blocks || [];
    if (!list.length) { this.app.toast('No blocks yet: select entities and use Make Block first', true); return; }
    const v = await ui.promptFields('Insert Block', 'skBlock', [
      { key: 'name', label: 'Block', type: 'select', options: list.map((b) => [b.name, b.name]), value: this.blockIns?.name || list[list.length - 1].name },
      { key: 'angle', label: 'Turned (°)', type: 'expr', value: this.blockIns?.angle || 0 },
      { key: 'linked', label: 'Linked (moves as one, follows the block)', type: 'check', value: this.blockIns?.linked !== false },
      { key: 'del', label: 'Delete this block from the library instead', type: 'check', value: false },
    ]);
    if (!v || !this.active) return;
    const b = list.find((x) => x.name === v.name);
    if (!b) return;
    if (v.del) { ui.prefs.blocks = list.filter((x) => x !== b); ui.savePrefs(); this.app.status(`Block "${b.name}" deleted.`); return; }
    this.blockIns = { ...b, angle: +this.app.result.ev(v.angle) || 0, linked: !!v.linked };
    this.setTool('block');
  }

  // Explode Block: the selected block copies made plain geometry (their own relations and dimensions back)
  explodeBlocks() {
    const ids = new Set([...this.sel].map((id) => S.blockOf(this.f, id)?.id).filter(Boolean));
    if (!ids.size) { this.app.toast('Select an entity of a block copy first', true); return; }
    for (const id of ids) S.explodeBlock(this.f, id);
    this.changed();
    this.app.status(`${ids.size} block cop${ids.size === 1 ? 'y' : 'ies'} exploded into plain geometry.`);
  }

  // the block at the cursor
  blockPreview() {
    const b = this.blockIns, c = this.cursor;
    if (!b || !c) return [];
    const a = ((b.angle || 0) * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const tmp = { points: b.data.points.map((q) => ({ ...q, x: q.x * ca - q.y * sa + c.p.x, y: q.x * sa + q.y * ca + c.p.y })), curves: b.data.curves, constraints: [] };
    return b.data.curves.map((cv) => S.curvePoints(tmp, cv));
  }

  attachCorner(corners, s) {
    if (!s || (s.kind !== 'point' && s.kind !== 'onCurve' && s.kind !== 'mid' && s.kind !== 'model')) return;
    let best = corners[0], bd = Infinity;
    for (const c of corners) {
      const p = S.getPoint(this.f, c);
      const d = Math.hypot(p.x - s.x, p.y - s.y);
      if (d < bd) { bd = d; best = c; }
    }
    if (s.kind === 'model') {
      const ref = this.materializeExternal(s.ext, s);
      if (!ref) return;
      const c = S.getCurve(this.f, ref.id);
      if (s.as === 'point') S.addRel(this.f, 'coincident', [best, ref.id]);
      else if (s.as === 'center' && c?.c) S.addRel(this.f, 'coincident', [best, c.c]);
      else S.addRel(this.f, 'onCurve', [best, ref.id]);
    } else if (s.kind === 'point') S.addRel(this.f, 'coincident', [best, s.id]);
    else if (s.kind === 'onCurve') S.addRel(this.f, 'onCurve', [best, s.curve]);
    else S.addRel(this.f, 'midpoint', [best, s.curve]);
  }

  // ------------------------------------------------------------ Offset
  // Model edge (and, with Select chain, the connected edges lying in a plane parallel to the
  // sketch) or a curve of another sketch, projected onto this sketch: [{ src, prims }].
  offsetSourcePrims(ext) {
    if (ext.kind === 'extSection') return ext.chain.map((i) => ({ src: { kind: 'section', idx: i, of: this.sectionPrims.length }, prims: [this.sectionPrims[i]] }));
    const fr = this.frameArr();
    if (ext.kind === 'extCurve') {
      // a curve of another sketch, with the curves chained to it in that sketch
      const other = this.app.result.sketches.get(ext.fid);
      const chain = other && this.offsetChain ? SO.chainOf(other.sketch, ext.cid) : null;
      if (!chain) return [{ src: this.externalSrc(ext), prims: S.projectCurve(fr, ext.geom) }];
      return chain.items.map(({ c }) => ({ src: { kind: 'sketch', fid: ext.fid, cid: c.id }, prims: S.projectCurve(fr, S.curve3D(other.sketch, c, this.frameArr(other.frame))) }));
    }
    if (ext.kind !== 'extEdge') return [];
    const edges = this.vp.edgeList || [];
    const start = edges.find((e) => e.mid[0] === ext.mid[0] && e.mid[1] === ext.mid[1] && e.mid[2] === ext.mid[2]);
    const list = start && this.offsetChain ? this.modelEdgeChain(start) : start ? [start] : [];
    return list.map((e) => ({ src: { kind: 'edge', p: e.mid }, prims: S.projectCurve(fr, S.classifyPolyline3(e.pts.map((q) => q.toArray()))) }));
  }

  // Edges joined end to end with `start` that lie in the same plane parallel to the sketch.
  modelEdgeChain(start) {
    const n = this.frame.n, depth = (q) => q.dot(n);
    const R = this.vp.bodyGeo?.boundingSphere?.radius || 50, tol = Math.max(1e-4, R * 1e-5);
    const d0 = depth(start.pts[0]);
    const flat = (e) => e.pts.every((q) => Math.abs(depth(q) - d0) < tol);
    if (!flat(start)) return [start];
    const cands = this.vp.edgeList.filter(flat);
    const ends = (e) => [e.pts[0], e.pts[e.pts.length - 1]];
    const closed = (e) => ends(e)[0].distanceTo(ends(e)[1]) < tol;
    if (closed(start)) return [start];
    const at = (p) => cands.filter((e) => !closed(e) && ends(e).some((q) => q.distanceTo(p) < tol));
    const out = [start], used = new Set([start]);
    for (const p0 of ends(start)) {
      let p = p0;
      for (;;) {
        const here = at(p);
        if (here.length !== 2) break; // a branch or a free end
        const nx = here.find((e) => !used.has(e));
        if (!nx) break;
        used.add(nx); out.push(nx);
        const [a, b] = ends(nx);
        p = a.distanceTo(p) < tol ? b : a;
      }
    }
    return out;
  }

  offsetSketchChain(id) {
    const c=S.getCurve(this.f,id);if(!c)return null;
    return SO.chainOf(this.f,id,this.offsetChain);
  }

  offsetClick(raw, ev) {
    const d = this.draw;
    if (d?.tool !== 'offset') {
      const hit = this.hitTest(raw, { points: false });
      let chain = hit && S.getCurve(this.f, hit.id) ? this.offsetSketchChain(hit.id) : null;
      let ext = [];
      if (!chain && ev) {
        // a model edge or another sketch's curve: bring it in as linked construction geometry
        const src = this.externalHit(ev, { vertices: false });
        const groups = src ? this.offsetSourcePrims(src) : [];
        if (!groups.length || !groups.some((g) => g.prims.length)) return;
        const curves = [];
        for (const g of groups) curves.push(...S.addProjected(this.f, g.prims, g.src, true));
        // join coincident end points so the projected edges form one chain
        const tol = Math.max(1e-6, this.wpp() * 1e-3);
        const pids = [...new Set(curves.flatMap((id) => { const c = S.getCurve(this.f, id); return c && c.type !== 'circle' ? [c.p1, c.p2] : []; }))];
        for (let i = 0; i < pids.length; i++) for (let j = i + 1; j < pids.length; j++) {
          const a = S.getPoint(this.f, pids[i]), b = S.getPoint(this.f, pids[j]);
          if (a && b && Math.hypot(a.x - b.x, a.y - b.y) < tol) S.mergePoints(this.f, pids[j], pids[i]);
        }
        const first = curves.find((id) => S.getCurve(this.f, id));
        chain = first ? SO.chainOf(this.f, first) : null;
        ext = [...curves, ...this.f.constraints.filter((k) => k.type === 'projected' && curves.includes(k.refs[0])).map((k) => k.id)];
        this.extHover = null;
        if (!chain) { S.deleteItems(this.f, ext); return; }
      }
      if (!chain) return;
      try{SO.geometry(this.f,chain,0);}catch(e){if(ext.length)S.deleteItems(this.f,ext);this.extHover=null;this.app.toast(e.message,true);this.redraw();return;}
      this.draw = { tool: 'offset', chain, dist: 0, ext, fromModel: ext.length > 0 };
      this.offHover = null; this.offHoverId = null;
      this.app.status(`Offsetting ${chain.items.length} entit${chain.items.length === 1 ? 'y' : 'ies'}: move to the side and distance you want and click (Esc cancels).`);
      this.redraw();
      return;
    }
    let dist;
    try{const side=SO.side(this.f,d.chain,raw.x,raw.y),value=this.offsetTyped?this.ev(this.offsetDistance):Math.abs(r4(side));if(!Number.isFinite(value)||value<1e-6)throw new Error('Enter a positive offset distance');dist=value*(side<0?-1:1);}catch(e){this.app.toast(e.message,true);return;}
    if (Math.abs(dist) < 1e-6) return;
    const before = this.snapshotData();
    try {
      // offsets of model edges are regular geometry (their projected source stays as construction);
      // so are offsets of construction lines that are projected model edges
      const projectedSrc = d.chain.items.every((it) => this.f.constraints.some((k) => k.type === 'projected' && k.refs[0] === it.c.id));
      const values=SO.distances(this.f,d.chain,dist,this.offsetMode),{dim,groups}=SO.build(this.f,d.chain,values,{...(d.fromModel||projectedSrc?{construction:false}:{}),value:this.offsetTyped?this.offsetDistance:null});
      this.draw = null;
      if (!this.offsetLinked) {
        // single offset: plain geometry, no link to the source
        const rels = groups.map(k=>k.id);
        S.deleteItems(this.f, [dim.id, ...rels, ...(d.ext || [])]);
      }
      const solved=this.solve();if(!solved.ok||solved.bad.length)throw new Error(solved.bad[0]||'The offset could not be solved with the existing relations');
      this.changed();
      if (this.offsetLinked) {
        const idx = this.dims.findIndex((x) => x.k.id === dim.id);
        if (idx >= 0) this.openModify(idx);
        this.app.status(d.fromModel ? 'Linked offset created: it follows the model edges when they change. Type the exact distance.' : 'Offset created. Type the exact distance (the offset stays linked to the original entities).');
      } else this.app.status(`Single offset created at ${fmt(Math.abs(dist))} mm (not linked to its source).`);
    } catch (e) {
      Object.assign(this.f, JSON.parse(before));
      if (d.ext?.length) S.deleteItems(this.f, d.ext);
      this.draw = null;
      this.solve();
      this.redraw();
      this.app.toast(e.message, true);
    }
  }

  // ------------------------------------------------------------ Dimension
  dimensionPreview(picks, raw) {
    const spec = this.dimSpec(picks, raw);
    if (spec) this.positionDimension(spec, raw);
    return spec;
  }

  dimClick(raw, ev) {
    if (!this.draw) this.draw = { tool: 'dim', picks: [], spec: null, ext: [] };
    const d = this.draw;
    const canPick = !d.placing && d.picks.length < 2;
    let hit = canPick ? this.hitTest(raw) : null;
    if (!hit && canPick && !(d.picks.length === 1 && ['circle', 'arc'].includes(d.picks[0].kind))) {
      // outside reference: model edge/vertex or another sketch -> linked construction geometry
      const ext = this.externalHit(ev);
      if (ext) {
        hit = this.materializeExternal(ext, raw);
        if (hit) d.ext.push(...hit.created);
      }
    }
    if (hit && canPick && !(d.picks.length && hit.id === d.picks[0].id)) {
      d.picks.push(hit);
      d.spec = this.dimensionPreview(d.picks, raw);
      this.extHover = null;
      this.redraw();
      return;
    }
    if (d.placing || d.spec) d.spec = this.dimensionPreview(d.picks, raw);
    if (d.spec) {
      const sp = d.spec;
      this.draw = null;
      const extra = { kind: sp.kind, value: r4(sp.value), s: sp.s, off: sp.off, ang: sp.ang, e1: sp.e1, e2: sp.e2, labelOffset: sp.labelOffset };
      if (sp.axis) extra.axis = sp.axis;
      if (sp.kind === 'arcDist') { extra.cond = sp.cond; extra.nested = !!sp.nested; }
      const res = this.tryAddConstraints([['dim', sp.refs, extra]], { asDriven: true });
      this.changed();
      if (res && !res.driven) {
        const idx = this.dims.findIndex((x) => x.k.id === res.kept.id);
        if (idx >= 0) this.openModify(idx);
      }
      return;
    }
    this.endDraw();
  }

  // Merge coincident end points of the given curves so they form chains.
  // The selected outside references (made when model edges / vertices or other sketches' entities are
  // clicked with Select: dotted construction kept only while something uses them) turned into real
  // converted geometry — still linked to the source, no longer construction or removed when unused.
  // Returns how many were converted (0: nothing selected was such a reference).
  convertSelection() {
    const ids = [];
    for (const id of this.sel) {
      const k = this.f.constraints.find((x) => x.type === 'projected' && x.refs[0] === id);
      if (!k) continue;
      const c = S.getCurve(this.f, id);
      if (!k.ref && !(c && c.construction)) continue; // (already converted geometry)
      delete k.ref;
      if (c) c.construction = false;
      else { const p = S.getPoint(this.f, id); if (p) p.keep = true; }
      ids.push(id);
    }
    if (!ids.length) return 0;
    this.joinEnds(ids.filter((id) => S.getCurve(this.f, id)), true);
    this.sel.clear();
    this.changed();
    this.redraw();
    this.app.ui.refreshCommandStates();
    this.app.status(`Converted ${ids.length} selected entit${ids.length === 1 ? 'y' : 'ies'} into the sketch (purple: linked to the source).`);
    return ids.length;
  }

  // The sketch already has a curve where this projected primitive would go (converting it again would
  // only stack a copy on top).
  hasCurveLike(g) {
    const tol = Math.max(1e-6, this.wpp() * 1e-3);
    const P = (id) => S.getPoint(this.f, id) || (id === 'O' ? S.ORIGIN : null);
    const at = (id, q) => { const p = P(id); return p && Math.hypot(p.x - q[0], p.y - q[1]) < tol; };
    return this.f.curves.some((c) => {
      if (g.type === 'line' && c.type === 'line') return (at(c.p1, g.a) && at(c.p2, g.b)) || (at(c.p1, g.b) && at(c.p2, g.a));
      if ((g.type === 'circle' || g.type === 'arc') && c.type === g.type && at(c.c, g.c) && Math.abs(S.radiusOf(this.f, c) - g.r) < tol) {
        return g.type === 'circle' || (at(c.p1, g.a) && at(c.p2, g.b)) || (at(c.p1, g.b) && at(c.p2, g.a));
      }
      return false;
    });
  }

  joinEnds(curveIds, all = false) {
    const tol = Math.max(1e-6, this.wpp() * 1e-3);
    const ends = (ids) => [...new Set(ids.flatMap((id) => { const c = S.getCurve(this.f, id); return c && c.type !== 'circle' ? [c.p1, c.p2] : []; }))];
    const pids = ends(curveIds);
    const near = (a, b) => a && b && Math.hypot(a.x - b.x, a.y - b.y) < tol;
    const gone = new Set();
    for (let i = 0; i < pids.length; i++) for (let j = i + 1; j < pids.length; j++) {
      if (gone.has(pids[i]) || gone.has(pids[j])) continue;
      if (near(S.getPoint(this.f, pids[i]), S.getPoint(this.f, pids[j]))) { S.mergePoints(this.f, pids[j], pids[i]); gone.add(pids[j]); }
    }
    if (!all) return;
    // the ends of the sketch's other entities they land on (not the origin: linked points move with the model)
    const mine = new Set(curveIds);
    const others = ends(this.f.curves.filter((c) => !mine.has(c.id)).map((c) => c.id)).filter((o) => o !== 'O');
    for (const pid of pids) {
      if (gone.has(pid)) continue;
      const a = S.getPoint(this.f, pid), to = others.find((o) => o !== pid && near(a, S.getPoint(this.f, o)));
      if (to) { S.mergePoints(this.f, pid, to); gone.add(pid); }
    }
  }

  // ------------------------------------------------------------ outside references
  frameArr(fr = this.frame) {
    return { o: fr.o.toArray(), u: fr.u.toArray(), v: fr.v.toArray(), n: fr.n.toArray() };
  }

  // Pick something outside this sketch: points/curves of earlier sketches, then model vertices/edges.
  externalHit(ev, { vertices = true } = {}) {
    const vp = this.vp, m = vp.screenPos(ev), doc = this.app.doc;
    const projection=['convert','intersect'].includes(this.tool),source=projection?this.projectionSource||'all':'all';
    const myIdx = doc.features.indexOf(this.f);
    const others = [];
    for (const [fid, s] of this.app.result.sketches) {
      if (fid === this.f.id) continue;
      if(source==='model'||source.startsWith('sketch:')&&fid!==source.slice(7))continue;
      const i = doc.features.findIndex((x) => x.id === fid);
      if (myIdx >= 0 && i > myIdx) continue;
      if (!['convert', 'intersect'].includes(this.tool) && this.app.result.consumed.has(fid) && !this.app.showAbsorbed) {
        // absorbed sketches are hidden in the view; only offer visible ones
        continue;
      }
      others.push([fid, s]);
    }
    let best = null, bd = 8;
    if (vertices) for (const [fid, s] of others) {
      for (const p of s.sketch.points) {
        const w = G.toWorld(s.frame, p.x, p.y), sp = vp.project(w);
        const dd = Math.hypot(sp.x - m.x, sp.y - m.y);
        if (dd < bd) { bd = dd; best = { kind: 'extPoint', fid, pid: p.id, p: w.toArray() }; }
      }
    }
    if (best) return best;
    bd = 6;
    for (const [fid, s] of others) {
      for (const c of s.sketch.curves) {
        if (c.ctrlOf) continue;
        const pts = S.curvePoints(s.sketch, c).map(([x, y]) => vp.project(G.toWorld(s.frame, x, y)));
        for (let i = 0; i < pts.length - 1; i++) {
          const dd = S.segDist(m.x, m.y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
          if (dd < bd) { bd = dd; best = { kind: 'extCurve', fid, cid: c.id, geom: S.curve3D(s.sketch, c, this.frameArr(s.frame)) }; }
        }
      }
    }
    if (best) return best;
    if(source.startsWith('sketch:'))return null;
    const v = vertices ? vp.pickVertex(ev) : null;
    if (v) return { kind: 'extVertex', p: v.point.toArray() };
    const e = this.tool === 'intersect' ? null : vp.pickEdge(ev);
    if (e) return { kind: 'extEdge', mid: e.edge.mid, geom: S.classifyPolyline3(e.edge.pts.map((q) => q.toArray())) };
    if (this.sectionPrims?.length && (['convert', 'intersect', 'offset'].includes(this.tool))) {
      const raw = this.localFromEvent(ev), tol = 6 * this.wpp();
      let bi = -1, bdd = tol;
      this.sectionPrims.forEach((g, i) => {
        const dd = g.type === 'line' ? S.segDist(raw.x, raw.y, g.a[0], g.a[1], g.b[0], g.b[1]) : g.type === 'point' ? Infinity : Math.abs(Math.hypot(raw.x - g.c[0], raw.y - g.c[1]) - g.r);
        if (dd < bdd) { bdd = dd; bi = i; }
      });
      if (bi >= 0) return { kind: 'extSection', idx: bi, chain: this.sectionChain(bi) };
    }
    return null;
  }

  externalPrims(ext) {
    if (ext.kind === 'extSection') return ext.chain.map((i) => this.sectionPrims[i]);
    const fr = this.frameArr();
    if (ext.kind === 'extPoint' || ext.kind === 'extVertex') return [{ type: 'point', p: S.toFrame2D(fr, ext.p) }];
    return this.tool === 'intersect' ? S.intersectCurve(fr, ext.geom) : S.projectCurve(fr, ext.geom, { preserveSpline: true });
  }

  externalSrc(ext) {
    if (ext.kind === 'extSection') return { kind: 'section', idx: ext.idx, of: this.sectionPrims.length };
    if (ext.kind === 'extPoint') return { kind: 'sketchPoint', fid: ext.fid, pid: ext.pid };
    if (ext.kind === 'extCurve') return { kind: 'sketch', fid: ext.fid, cid: ext.cid, ...(this.tool === 'intersect' ? { intersection: true } : {}) };
    if (ext.kind === 'extVertex') return { kind: 'vertex', p: ext.p };
    return { kind: 'edge', p: ext.mid };
  }

  // Create linked construction geometry for an outside reference and return it as a pick.
  materializeExternal(ext, raw) {
    // already referenced: use the same reference
    const have = this.existingRef(ext);
    if (have) return have;
    const prims = this.externalPrims(ext);
    if (!prims.length) return null;
    let idx = 0;
    if (prims.length > 1) {
      let bd = Infinity;
      prims.forEach((g, i) => {
        const dd = g.type === 'line' ? S.segDist(raw.x, raw.y, g.a[0], g.a[1], g.b[0], g.b[1]) : g.type === 'point' ? Math.hypot(raw.x - g.p[0], raw.y - g.p[1]) : Math.abs(Math.hypot(raw.x - g.c[0], raw.y - g.c[1]) - g.r);
        if (dd < bd) { bd = dd; idx = i; }
      });
    }
    const ids = S.addProjected(this.f, [prims[idx]], this.externalSrc(ext), true);
    const k = this.f.constraints[this.f.constraints.length - 1];
    k.src.idx = idx;
    k.src.of = prims.length;
    k.ref = true; // an automatic reference: removed again when nothing uses it
    this.solve();
    const c = S.getCurve(this.f, ids[0]);
    return { id: ids[0], kind: c ? c.type : 'point', created: ids };
  }

  // A reference to the same model edge / vertex (or other sketch entity) that already exists here.
  existingRef(ext) {
    const src = this.externalSrc(ext);
    const near = (a, b) => a && b && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6;
    for (const k of this.f.constraints) {
      if (k.type !== 'projected' || !k.src || k.src.kind !== src.kind) continue;
      const same = src.kind === 'edge' || src.kind === 'vertex' ? near(k.src.p, src.p)
        : src.kind === 'sketch' ? k.src.fid === src.fid && k.src.cid === src.cid && !!k.src.intersection === !!src.intersection
          : k.src.fid === src.fid && k.src.pid === src.pid;
      if (!same) continue;
      const id = k.refs[0], c = S.getCurve(this.f, id);
      if (c || this.f.points.some((p) => p.id === id)) return { id, kind: c ? c.type : 'point', created: [] };
    }
    return null;
  }

  // ------------------------------------------------------------ snapping to the model
  // Model geometry the cursor can snap to, in sketch coordinates: vertices and edges lying in the
  // sketch plane, and the centres of circular edges parallel to it (e.g. holes in other faces).
  modelSnapItems() {
    const vp = this.vp, fr = this.frame;
    const key = `${fr.o.toArray()}|${fr.n.toArray()}|${fr.u.toArray()}`;
    if (this._modelSnap?.edges === vp.edgeList && this._modelSnap.key === key) return this._modelSnap.items;
    const fa = this.frameArr();
    const r = vp.bodyGeo?.boundingSphere?.radius || 50;
    const tol = Math.max(1e-3, r * 2e-5);
    const items = [];
    for (const e of vp.edgeList || []) {
      if (e.hidden) continue;
      const inPlane = e.pts.every((p) => Math.abs(p.clone().sub(fr.o).dot(fr.n)) < tol);
      const pts3 = e.pts.map((p) => p.toArray());
      const geom = S.classifyPolyline3(pts3);
      const round = geom && (geom.type === 'circle' || geom.type === 'arc') && Math.abs(geom.normal[0] * fr.n.x + geom.normal[1] * fr.n.y + geom.normal[2] * fr.n.z) > 0.9999;
      if (!inPlane && !round) continue;
      const it = { ext: { kind: 'extEdge', mid: e.mid, geom } };
      if (inPlane) {
        it.poly = pts3.map((p) => S.toFrame2D(fa, p));
        const closed = e.pts[0].distanceTo(e.pts[e.pts.length - 1]) < 1e-6;
        if (!closed) it.ends = [[it.poly[0], pts3[0]], [it.poly[it.poly.length - 1], pts3[pts3.length - 1]]];
      }
      if (round) { it.center = S.toFrame2D(fa, geom.c); it.round = true; }
      items.push(it);
    }
    items.sort((a, b) => (b.poly ? 1 : 0) - (a.poly ? 1 : 0)); // edges on the sketch plane win ties
    this._modelSnap = { edges: vp.edgeList, key, items };
    return items;
  }

  // Turn a model snap into a point id: the model vertex itself, the centre of the circular
  // edge, or a new point kept on the edge (through a linked reference).
  resolveModelSnap(s) {
    const ref = this.materializeExternal(s.ext, s);
    if (!ref) return S.addPoint(this.f, s.x, s.y);
    if (s.as === 'point') return ref.id;
    const c = S.getCurve(this.f, ref.id);
    if (s.as === 'center' && c?.c) return c.c;
    const id = S.addPoint(this.f, s.x, s.y);
    S.addRel(this.f, 'onCurve', [id, ref.id]);
    return id;
  }

  dimSpec(picks, m) {
    const sk = this.f;
    const P = (id) => S.getPoint(sk, id);
    const kinds = picks.map((p) => p.kind);
    const twoPoint = (a, b, refs) => {
      const A = P(a), B = P(b);
      const minx = Math.min(A.x, B.x), maxx = Math.max(A.x, B.x), miny = Math.min(A.y, B.y), maxy = Math.max(A.y, B.y);
      const inX = m.x > minx && m.x < maxx, inY = m.y > miny && m.y < maxy;
      if ((inX && !inY) || Math.abs(B.y - A.y) < 1e-9) {
        const s = B.x >= A.x ? 1 : -1;
        return { kind: 'hdist', refs, s, value: Math.abs(B.x - A.x), off: m.y - (A.y + B.y) / 2 };
      }
      if ((inY && !inX) || Math.abs(B.x - A.x) < 1e-9) {
        const s = B.y >= A.y ? 1 : -1;
        return { kind: 'vdist', refs, s, value: Math.abs(B.y - A.y), off: m.x - (A.x + B.x) / 2 };
      }
      const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy);
      return { kind: 'distance', refs, value: L, off: ((m.x - A.x) * -dy + (m.y - A.y) * dx) / L };
    };
    const pointLine = (p, l) => {
      const c = S.getCurve(sk, l), A = P(c.p1), B = P(c.p2), Q = P(p);
      const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy);
      const sd = (dx * (Q.y - A.y) - dy * (Q.x - A.x)) / L;
      return { kind: 'pointLine', refs: [p, l], s: sd >= 0 ? 1 : -1, value: Math.abs(sd) };
    };
    const center = (id) => S.getCurve(sk, id).c;
    if (picks.length === 1) {
      const [a] = picks;
      if (a.kind === 'line') { const c = S.getCurve(sk, a.id); return twoPoint(c.p1, c.p2, [c.p1, c.p2]); }
      if (a.kind === 'circle' || a.kind === 'arc') {
        const c = S.getCurve(sk, a.id), C = P(c.c);
        return { kind: a.kind === 'circle' ? 'diameter' : 'radius', refs: [a.id], value: (a.kind === 'circle' ? 2 : 1) * S.radiusOf(sk, c), ang: Math.atan2(m.y - C.y, m.x - C.x) };
      }
      if (a.kind === 'ellipse' || a.kind === 'earc') {
        // the minor radius, or the major one when the mouse is nearer the major axis
        const c = S.getCurve(sk, a.id), g = S.ellipseGeom(sk, c);
        const du = Math.abs((m.x - g.cx) * g.u[0] + (m.y - g.cy) * g.u[1]), dv = Math.abs((m.x - g.cx) * g.v[0] + (m.y - g.cy) * g.v[1]);
        const axis = du > dv ? 'major' : 'minor';
        return { kind: 'radius', axis, refs: [a.id], value: axis === 'major' ? g.ra : g.rb };
      }
      return null;
    }
    const [a, b] = picks;
    const isRound = (k) => k === 'circle' || k === 'arc';
    if (kinds[0] === 'point' && kinds[1] === 'point') return twoPoint(a.id, b.id, [a.id, b.id]);
    if (kinds[0] === 'point' && kinds[1] === 'line') return pointLine(a.id, b.id);
    if (kinds[0] === 'line' && kinds[1] === 'point') return pointLine(b.id, a.id);
    // anything to a circle/arc: center-to-center by default (Min/Max in the Modify box);
    // concentric circles (offsets) start as the minimum (arc-to-arc) distance
    const arcDist = (A, B) => {
      const k = { kind: 'arcDist', refs: [A.id, B.id], cond: 'center' };
      const cb = S.getCurve(sk, B.id), CB = P(cb.c);
      if (A.kind === 'line') {
        const c = S.getCurve(sk, A.id), A1 = P(c.p1), A2 = P(c.p2);
        k.s = (A2.x - A1.x) * (CB.y - A1.y) - (A2.y - A1.y) * (CB.x - A1.x) >= 0 ? 1 : -1;
      } else if (isRound(A.kind)) {
        const ca = S.getCurve(sk, A.id), CA = P(ca.c);
        const dd = Math.hypot(CB.x - CA.x, CB.y - CA.y), ra = S.radiusOf(sk, ca), rb = S.radiusOf(sk, cb);
        k.nested = dd < Math.abs(ra - rb);
        if (dd < 1e-6 * (1 + ra)) { k.cond = 'min'; k.ang = Math.atan2(m.y - CB.y, m.x - CB.x); }
      }
      const g = this.arcDistGeom(k);
      if (!g) return null;
      const ux = g.pB[0] - g.pA[0], uy = g.pB[1] - g.pA[1], L = Math.hypot(ux, uy);
      k.off = L > 1e-9 ? ((m.x - g.pA[0]) * -uy + (m.y - g.pA[1]) * ux) / L : 0;
      k.value = g.value;
      return k;
    };
    if (kinds[0] === 'point' && isRound(kinds[1])) return arcDist(a, b);
    if (isRound(kinds[0]) && kinds[1] === 'point') return arcDist(b, a);
    if (isRound(kinds[0]) && isRound(kinds[1])) return arcDist(a, b);
    if (kinds[0] === 'line' && isRound(kinds[1])) return arcDist(a, b);
    if (isRound(kinds[0]) && kinds[1] === 'line') return arcDist(b, a);
    if (kinds[0] === 'line' && kinds[1] === 'line') {
      const c1 = S.getCurve(sk, a.id), c2 = S.getCurve(sk, b.id);
      const A1 = P(c1.p1), B1 = P(c1.p2), A2 = P(c2.p1), B2 = P(c2.p2);
      const d1 = norm([B1.x - A1.x, B1.y - A1.y]), d2 = norm([B2.x - A2.x, B2.y - A2.y]);
      const cr = d1[0] * d2[1] - d1[1] * d2[0];
      if (Math.abs(cr) < 1e-6) return pointLine(c2.p1, a.id);
      const V = lineIntersection(A1, d1, A2, d2);
      const v = [m.x - V[0], m.y - V[1]];
      const e1 = v[0] * d1[0] + v[1] * d1[1] >= 0 ? 1 : -1, e2 = v[0] * d2[0] + v[1] * d2[1] >= 0 ? 1 : -1;
      const u = [d1[0] * e1, d1[1] * e1], w = [d2[0] * e2, d2[1] * e2];
      const ang = (Math.atan2(Math.abs(u[0] * w[1] - u[1] * w[0]), u[0] * w[0] + u[1] * w[1]) * 180) / Math.PI;
      return { kind: 'angle', refs: [a.id, b.id], e1, e2, value: ang, off: Math.hypot(v[0], v[1]) };
    }
    return null;
  }

  // Witness points and value of a circle/arc distance (A: point, line or circle/arc; B: circle/arc).
  arcDistGeom(k) {
    const sk = this.f, P = (id) => S.getPoint(sk, id);
    const cb = S.getCurve(sk, k.refs[1]);
    if (!cb) return null;
    const CB = [P(cb.c).x, P(cb.c).y], rB = S.radiusOf(sk, cb), cond = k.cond || 'center';
    const ca = S.getCurve(sk, k.refs[0]);
    if (ca?.type === 'line') {
      const A1 = P(ca.p1), A2 = P(ca.p2), dx = A2.x - A1.x, dy = A2.y - A1.y, L2 = dx * dx + dy * dy || 1;
      const t = ((CB[0] - A1.x) * dx + (CB[1] - A1.y) * dy) / L2;
      const F = [A1.x + t * dx, A1.y + t * dy];
      const dd = Math.hypot(CB[0] - F[0], CB[1] - F[1]);
      const u = dd > 1e-9 ? [(CB[0] - F[0]) / dd, (CB[1] - F[1]) / dd] : norm([-dy, dx]);
      const sd = (k.s || 1) * (dx * (CB[1] - A1.y) - dy * (CB[0] - A1.x)) / Math.sqrt(L2);
      const rs = cond === 'min' ? -1 : cond === 'max' ? 1 : 0;
      return { pA: F, pB: [CB[0] + rs * u[0] * rB, CB[1] + rs * u[1] * rB], value: sd + rs * rB, ext: [[A1.x, A1.y], [A2.x, A2.y]] };
    }
    const isPt = !ca;
    const pa = isPt ? P(k.refs[0]) : P(ca.c);
    if (!pa) return null;
    const CA = [pa.x, pa.y], rA = isPt ? 0 : S.radiusOf(sk, ca);
    const dv = [CB[0] - CA[0], CB[1] - CA[1]], d = Math.hypot(dv[0], dv[1]);
    const ang = k.ang ?? Math.PI / 4;
    const u = d > 1e-9 ? [dv[0] / d, dv[1] / d] : [Math.cos(ang), Math.sin(ang)];
    const at = (C, r, sg) => [C[0] + sg * u[0] * r, C[1] + sg * u[1] * r];
    if (cond === 'center') return { pA: CA, pB: CB, value: d };
    if (cond === 'max') return { pA: at(CA, rA, -1), pB: at(CB, rB, 1), value: d + rA + rB };
    if (k.nested) {
      const sg = rA >= rB ? 1 : -1; // measure across the gap between the inner and the outer circle
      return { pA: at(CA, rA, sg), pB: at(CB, rB, sg), value: Math.abs(rA - rB) - d };
    }
    return { pA: at(CA, rA, 1), pB: at(CB, rB, -1), value: d - rA - rB };
  }

  // Graphics for a dimension (existing constraint or preview spec).
  dimGraphics(k, wpp) {
    const sk = this.f;
    const P = (id) => S.getPoint(sk, id);
    const segs = [];
    const push = (a, b) => segs.push(a, b);
    const arrow = (from, to) => {
      const dx = to[0] - from[0], dy = to[1] - from[1], L = Math.hypot(dx, dy) || 1;
      const ux = dx / L, uy = dy / L, s = 7 * wpp;
      for (const sg of [1, -1]) {
        const c = Math.cos(0.4), sn = Math.sin(0.4) * sg;
        push(to, [to[0] - s * (ux * c - uy * sn), to[1] - s * (uy * c + ux * sn)]);
      }
    };
    const ext = 5 * wpp;
    let layout = null;
    let at, value, prefix = '';
    const linear = (a, b, extensions, offsetDir, offsetValue) => {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), u = L > 1e-12 ? [(b[0] - a[0]) / L, (b[1] - a[1]) / L] : [1, 0];
      const flip = u[0] < -1e-9 || (Math.abs(u[0]) <= 1e-9 && u[1] < 0), textDir = u.map((x) => flip ? -x : x);
      const normal = [-textDir[1], textDir[0]];
      at = [(a[0] + b[0]) / 2 + normal[0] * 9 * wpp, (a[1] + b[1]) / 2 + normal[1] * 9 * wpp];
      layout = { a, b, u, L, textDir, normal, offsetDir, offsetValue };
      for (const [from, to] of extensions) {
        const dx = to[0] - from[0], dy = to[1] - from[1], length = Math.hypot(dx, dy);
        if (length <= 3 * wpp) continue;
        const nx = dx / length, ny = dy / length;
        push([from[0] + nx * 3 * wpp, from[1] + ny * 3 * wpp], [to[0] + nx * ext, to[1] + ny * ext]);
      }
    };
    try {
      switch (k.kind) {
        case 'distance': {
          const A = P(k.refs[0]), B = P(k.refs[1]);
          const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
          const nx = -dy / L, ny = dx / L, off = k.off ?? 12 * wpp;
          const a2 = [A.x + nx * off, A.y + ny * off], b2 = [B.x + nx * off, B.y + ny * off];
          linear(a2, b2, [[[A.x, A.y], a2], [[B.x, B.y], b2]], [nx, ny], off);
          value = L;
          break;
        }
        case 'hdist':
        case 'vdist': {
          const A = P(k.refs[0]), B = P(k.refs[1]), off = k.off ?? 12 * wpp;
          if (k.kind === 'hdist') {
            const y = (A.y + B.y) / 2 + off, a2 = [A.x, y], b2 = [B.x, y];
            linear(a2, b2, [[[A.x, A.y], a2], [[B.x, B.y], b2]], [0, 1], off);
            value = Math.abs(B.x - A.x);
          } else {
            const x = (A.x + B.x) / 2 + off, a2 = [x, A.y], b2 = [x, B.y];
            linear(a2, b2, [[[A.x, A.y], a2], [[B.x, B.y], b2]], [1, 0], off);
            value = Math.abs(B.y - A.y);
          }
          break;
        }
        case 'pointLine': {
          const Q = P(k.refs[0]), c = S.getCurve(sk, k.refs[1]), A = P(c.p1), B = P(c.p2);
          const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy || 1, L = Math.sqrt(L2);
          const t = ((Q.x - A.x) * dx + (Q.y - A.y) * dy) / L2;
          const F = [A.x + t * dx, A.y + t * dy], u = [dx / L, dy / L], off = k.off ?? 12 * wpp;
          const a2 = [Q.x + u[0] * off, Q.y + u[1] * off], b2 = [F[0] + u[0] * off, F[1] + u[1] * off];
          const movedT = t + off / L;
          const reference = movedT < 0 ? [A.x, A.y] : movedT > 1 ? [B.x, B.y] : b2;
          linear(a2, b2, [[[Q.x, Q.y], a2], [reference, b2]], u, off);
          value = Math.hypot(Q.x - F[0], Q.y - F[1]);
          break;
        }
        case 'diameter':
        case 'radius': {
          const c = S.getCurve(sk, k.refs[0]);
          if (c.type === 'ellipse' || c.type === 'earc') {
            // along the axis it sets, from the centre
            const g = S.ellipseGeom(sk, c), maj = k.axis === 'major', u = maj ? g.u : g.v, r = maj ? g.ra : g.rb;
            const p1 = [g.cx + r * u[0], g.cy + r * u[1]];
            push([g.cx, g.cy], p1); arrow([g.cx, g.cy], p1);
            prefix = k.kind === 'diameter' ? 'Ø' : maj ? 'Rmaj ' : 'Rmin ';
            value = (k.kind === 'diameter' ? 2 : 1) * r;
            at = [p1[0] + u[0] * 18 * wpp, p1[1] + u[1] * 18 * wpp];
            break;
          }
          const C = P(c.c), r = S.radiusOf(sk, c);
          const ang = k.ang ?? Math.PI / 4;
          const u = [Math.cos(ang), Math.sin(ang)];
          const p1 = [C.x + r * u[0], C.y + r * u[1]];
          const q = [C.x + (r + 16 * wpp) * u[0], C.y + (r + 16 * wpp) * u[1]];
          if (k.kind === 'diameter') {
            const p0 = [C.x - r * u[0], C.y - r * u[1]];
            push(p0, q); arrow(q, p1); arrow([C.x, C.y], p0);
            prefix = 'Ø';
            value = 2 * r;
          } else {
            push([C.x, C.y], q); arrow([C.x, C.y], p1);
            prefix = 'R';
            value = r;
          }
          at = [q[0] + u[0] * 12 * wpp, q[1] + u[1] * 12 * wpp];
          break;
        }
        case 'arcDist':
        case 'offset': {
          let pA, pB;
          if (k.kind === 'arcDist') {
            const g = this.arcDistGeom(k);
            pA = g.pA; pB = g.pB; value = Math.abs(g.value);
          } else {
            // offset: across from the first source curve to its copy
            const c1 = S.getCurve(sk, k.refs[0]), c2 = S.getCurve(sk, k.refs[1]);
            const group=k.offsetGroup&&sk.constraints.find(q=>q.id===k.offsetGroup);
            if(group){[pA,pB]=SO.dimensionPair(sk,group,this.ev(k.value));}
            else if (c1.type === 'line') {
              const A = P(c1.p1), B = P(c1.p2), Q1 = P(c2.p1), Q2 = P(c2.p2);
              const M = [(Q1.x + Q2.x) / 2, (Q1.y + Q2.y) / 2];
              const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy || 1;
              const t = ((M[0] - A.x) * dx + (M[1] - A.y) * dy) / L2;
              pA = [A.x + t * dx, A.y + t * dy]; pB = M;
            } else {
              const C = P(c1.c), r1 = S.radiusOf(sk, c1), r2 = S.radiusOf(sk, c2);
              let ang = k.ang ?? Math.PI / 4;
              if (c1.type === 'arc') { const g = S.arcAngles(sk, c1); ang = g.a0 + g.span / 2; }
              pA = [C.x + r1 * Math.cos(ang), C.y + r1 * Math.sin(ang)]; pB = [C.x + r2 * Math.cos(ang), C.y + r2 * Math.sin(ang)];
            }
            value = Math.hypot(pB[0] - pA[0], pB[1] - pA[1]);
          }
          const dx = pB[0] - pA[0], dy = pB[1] - pA[1], L = Math.hypot(dx, dy);
          const nx = L > 1e-9 ? -dy / L : 0, ny = L > 1e-9 ? dx / L : 1, off = k.off ?? 0;
          const a2 = [pA[0] + nx * off, pA[1] + ny * off], b2 = [pB[0] + nx * off, pB[1] + ny * off];
          linear(a2, b2, [[pA, a2], [pB, b2]], [nx, ny], off);
          if (k.kind === 'arcDist' && k.cond && k.cond !== 'center') prefix = k.cond === 'min' ? '↧ ' : '↥ ';
          break;
        }
        case 'angle': {
          const c1 = S.getCurve(sk, k.refs[0]), c2 = S.getCurve(sk, k.refs[1]);
          const A1 = P(c1.p1), B1 = P(c1.p2), A2 = P(c2.p1), B2 = P(c2.p2);
          const d1 = norm([B1.x - A1.x, B1.y - A1.y]), d2 = norm([B2.x - A2.x, B2.y - A2.y]);
          const V = lineIntersection(A1, d1, A2, d2);
          const u = [d1[0] * (k.e1 || 1), d1[1] * (k.e1 || 1)], w = [d2[0] * (k.e2 || 1), d2[1] * (k.e2 || 1)];
          const r = k.off ?? 20 * wpp;
          let a0 = Math.atan2(u[1], u[0]), a1 = Math.atan2(w[1], w[0]);
          let span = a1 - a0;
          while (span > Math.PI) span -= 2 * Math.PI;
          while (span < -Math.PI) span += 2 * Math.PI;
          const n = 24;
          let prev = [V[0] + r * Math.cos(a0), V[1] + r * Math.sin(a0)];
          for (let i = 1; i <= n; i++) {
            const t = a0 + (span * i) / n;
            const cur = [V[0] + r * Math.cos(t), V[1] + r * Math.sin(t)];
            push(prev, cur);
            prev = cur;
          }
          const mid = a0 + span / 2;
          at = [V[0] + r * 1.18 * Math.cos(mid), V[1] + r * 1.18 * Math.sin(mid)];
          value = Math.abs(span * 180) / Math.PI;
          break;
        }
      }
    } catch { return null; }
    if (!at) return null;
    if (Array.isArray(k.labelOffset)) {
      const moved = [at[0] + k.labelOffset[0], at[1] + k.labelOffset[1]];
      if (!layout && Math.hypot(...k.labelOffset) > 1e-6) push(at, moved);
      at = moved;
    }
    if (layout) {
      const { a, b, u, L, normal } = layout;
      this._dimMeasure ||= document.createElement('canvas').getContext('2d');
      this._dimMeasure.font = '12px Segoe UI, sans-serif';
      const text = (k.driven ? '(' : '') + (prefix || '') + this.L(value) + (k.driven ? ')' : '');
      const width = (this._dimMeasure.measureText(text).width + 10) * wpp;
      const along = (at[0] - a[0]) * u[0] + (at[1] - a[1]) * u[1];
      const height = (at[0] - a[0]) * normal[0] + (at[1] - a[1]) * normal[1];
      const atLength = (t) => [a[0] + u[0] * t, a[1] + u[1] * t];
      const outside = L < width + 18 * wpp;
      const lo = Math.min(outside ? -14 * wpp : 0, along < 0 ? along - width / 2 : 0);
      const hi = Math.max(outside ? L + 14 * wpp : L, along > L ? along + width / 2 : L);
      if (Math.abs(height) < 8 * wpp) {
        const left = Math.max(lo, Math.min(hi, along - width / 2 - 2 * wpp)), right = Math.max(lo, Math.min(hi, along + width / 2 + 2 * wpp));
        if (left > lo) push(atLength(lo), atLength(left));
        if (right < hi) push(atLength(right), atLength(hi));
      } else push(atLength(lo), atLength(hi));
      if (outside) { arrow(atLength(-14 * wpp), a); arrow(atLength(L + 14 * wpp), b); }
      else { arrow(b, a); arrow(a, b); }
      if (Math.abs(height) > 18 * wpp) push(atLength(along), [at[0] - normal[0] * Math.sign(height) * 7 * wpp, at[1] - normal[1] * Math.sign(height) * 7 * wpp]);
    }
    return { segs, at, value, prefix, suffix: k.kind === 'angle' ? '°' : '', textDir: layout?.textDir, offsetDir: layout?.offsetDir, offsetValue: layout?.offsetValue };
  }

  positionDimension(k, target) {
    const P = (id) => S.getPoint(this.f, id);
    delete k.labelOffset;
    const current = this.dimGraphics(k, this.wpp());
    if (current?.offsetDir) {
      k.off = current.offsetValue + (target.x - current.at[0]) * current.offsetDir[0] + (target.y - current.at[1]) * current.offsetDir[1];
    } else if (k.kind === 'radius' || k.kind === 'diameter') {
      const c = S.getCurve(this.f, k.refs[0]), p = P(c.c);
      let angle = Math.atan2(target.y - p.y, target.x - p.x);
      if (c.type === 'arc') {
        const { a0, span } = S.arcAngles(this.f, c), tau = 2 * Math.PI;
        if (((angle - a0) % tau + tau) % tau > span) {
          const distance = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
          angle = distance(angle, a0) < distance(angle, a0 + span) ? a0 : a0 + span;
        }
      }
      k.ang = angle;
    } else if (k.kind === 'angle') {
      const a = S.getCurve(this.f, k.refs[0]), b = S.getCurve(this.f, k.refs[1]);
      const p = P(a.p1), q = P(a.p2), r = P(b.p1), s = P(b.p2);
      const v = lineIntersection(p, norm([q.x - p.x, q.y - p.y]), r, norm([s.x - r.x, s.y - r.y]));
      k.off = Math.hypot(target.x - v[0], target.y - v[1]) / 1.18;
    }
    const graphics = this.dimGraphics(k, this.wpp());
    if (graphics) k.labelOffset = [target.x - graphics.at[0], target.y - graphics.at[1]];
  }

  moveDimensionLabel(k, target) {
    this.positionDimension(k, target);
    this.redraw();
  }

  // ------------------------------------------------------------ drawing
  curveColor(c) {
    if (this.sel.has(c.id)) return COL.selected;
    if (this.hover === c.id || this.relHover?.has(c.id)||['line','centerline'].includes(this.tool)&&this.cursor?.p?.inferCurve===c.id) return COL.hover;
    if (!this.solveOk) return COL.error;
    // projected (linked) geometry: purple, so it shows on the model edges it was taken from
    if (this._linked?.has(c.id)) return COL.linked;
    if (this._patterned?.has(c.id)) return COL.defined;
    return this.analysis?.curveDefined.get(c.id) ? COL.defined : COL.under;
  }

  redraw() {
    if (!this.active) return;
    const g = this.drawGroup, sk = this.f;
    for (const c of [...g.children]) { g.remove(c); c.geometry?.dispose(); c.material?.dispose(); }
    const wpp = this.wpp();
    this.lastWpp = wpp;
    const byColor = new Map();
    const addSegs = (color, dashed, pts) => {
      const key = color + (dashed ? 'd' : '');
      if (!byColor.has(key)) byColor.set(key, { color, dashed, pts: [], dist: [] });
      const e = byColor.get(key);
      let cum = 0; // distance along the curve: dots continue across the short segments of arcs
      for (let i = 0; i < pts.length - 1; i++) {
        const L = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        e.pts.push(pts[i], pts[i + 1]);
        e.dist.push(cum, cum + L);
        cum += L;
      }
    };
    this._linked = new Set(sk.constraints.filter((k) => k.type === 'projected').map((k) => k.refs[0]));
    this._patterned = S.patternEntities(sk);
    const editingPattern = this.patternDraft?.id && sk.patterns?.find((p) => p.id === this.patternDraft.id);
    const hiddenPattern = new Set(editingPattern?.generated?.curves || []);
    for (const c of sk.curves) if (!hiddenPattern.has(c.id)) {
      if (!c.fitHandle) { addSegs(this.curveColor(c), c.construction, S.curvePoints(sk, c)); continue; }
      // Tangent controls have their own visual language, distinct from centre lines.
      const P = S.getPoint(sk, c.p1), H = S.getPoint(sk, c.p2), dx = H.x - P.x, dy = H.y - P.y, length = Math.hypot(dx, dy);
      const selected = this.sel.has(c.id) || this.sel.has(c.ctrlOf), hovered = this.hover === c.id;
      const color = selected ? COL.selected : hovered ? COL.hover : !this.solveOk ? COL.error : this.analysis?.curveDefined.get(c.id) ? COL.defined : COL.handle;
      if (length > 5 * wpp) {
        const ux = dx / length, uy = dy / length;
        addSegs(color, false, [[P.x, P.y], [H.x - ux * 4.5 * wpp, H.y - uy * 4.5 * wpp]]);
        if (length > 20 * wpp) {
          const x = H.x - ux * 8 * wpp, y = H.y - uy * 8 * wpp;
          addSegs(color, false, [[x - (ux + uy) * 3 * wpp, y - (uy - ux) * 3 * wpp], [x, y], [x - (ux - uy) * 3 * wpp, y - (uy + ux) * 3 * wpp]]);
        }
      }
    }
    if (this.patternPreview) {
      const { sketch, pattern } = this.patternPreview;
      for (const id of pattern.generated.curves) { const c = S.getCurve(sketch, id); if (c) addSegs(COL.preview, c.construction, S.curvePoints(sketch, c)); }
    }
    // gears: outline, pitch circle (construction) and bore
    for (const tr of sk.gearTrains || []) {
      const selTr = [...this.sel].some((id) => String(id).startsWith('gear:' + tr.id + ':'));
      const bad = S.trainProblems(sk, tr).length > 0; // drawn red until it works again
      for (const g of S.trainGears(sk, tr)) {
        const hov = this.hover === 'gear:' + tr.id + ':' + g.i;
        const col = selTr ? COL.selected : hov ? COL.hover : bad ? COL.error : COL.defined;
        const out = S.gearOutline(g);
        addSegs(col, false, [...out, out[0]]);
        const pc = [], r = (g.m * g.z) / 2;
        for (let i = 0; i <= 96; i++) { const t = (i / 96) * Math.PI * 2; pc.push([g.cx + r * Math.cos(t), g.cy + r * Math.sin(t)]); }
        addSegs(selTr ? COL.selected : COL.dim, true, pc);
        if (g.bore > 0) { const b = []; for (let i = 0; i <= 48; i++) { const t = (i / 48) * Math.PI * 2; b.push([g.cx + (g.bore / 2) * Math.cos(t), g.cy + (g.bore / 2) * Math.sin(t)]); } addSegs(col, false, b); }
      }
    }
    for (const af of sk.airfoils || []) {
      const id = 'airfoil:' + af.id, pl = S.airfoilPolyline(sk, af);
      if (pl) addSegs(this.sel.has(id) ? COL.selected : this.hover === id ? COL.hover : COL.defined, false, pl);
    }
    for (const t of sk.texts || []) {
      const col = this.sel.has(t.id) ? COL.selected : this.hover === t.id ? COL.hover : COL.defined;
      for (const pl of this.textPolys?.[t.id] || []) addSegs(col, false, pl);
    }
    // where the sketch plane cuts the model (Project Edges / Offset can pick these)
    if (this.sectionPrims && (['convert', 'intersect', 'offset'].includes(this.tool))&&!(this.tool!=='offset'&&this.projectionSource?.startsWith('sketch:'))) for (const g of this.sectionPrims) addSegs(0x0891b2, true, primPolyline(g));

    // preview geometry
    const d = this.draw;
    if(this.cursor?.p?.inferGuide&&['line','centerline'].includes(this.tool))addSegs(COL.hover,true,this.cursor.p.inferGuide);
    if (d && d.tool !== 'dim' && d.tool !== 'offset') for (const pl of this.previewPolylines(d)) addSegs(COL.preview, d.tool === 'centerline' || this.constructionMode, pl);
    if (this.tool === 'block') for (const pl of this.blockPreview()) addSegs(COL.preview, false, pl);
    if (this.trimHover?.pts) addSegs(COL.trim, false, this.trimHover.pts);
    if (this.tool === 'offset') {
      const ch = d?.tool === 'offset' ? d.chain : this.offHover;
      if (ch) for (const it of ch.items) addSegs(COL.hover, false, S.curvePoints(sk, it.c));
      if(d?.tool==='offset')try{const value=this.offsetTyped?Math.abs(this.ev(this.offsetDistance))*(d.dist<0?-1:1):d.dist;if(Math.abs(value)>1e-9)for(const distance of SO.distances(sk,d.chain,value,this.offsetMode))for(const pl of SO.polylines(SO.geometry(sk,d.chain,distance).pieces))addSegs(COL.preview,false,pl);d.error=null;}catch(e){d.error=e.message;}
    }
    if (this.extHover) {
      for (const g of this.extHover.prims) {
        if (g.type === 'point') {
          const s = 6 * wpp;
          addSegs(COL.hover, false, [[g.p[0] - s, g.p[1] - s], [g.p[0] + s, g.p[1] + s]]);
          addSegs(COL.hover, false, [[g.p[0] - s, g.p[1] + s], [g.p[0] + s, g.p[1] - s]]);
        } else if (g.type === 'line') addSegs(COL.hover, false, [g.a, g.b]);
        else if (g.type === 'spline') {
          const temp = S.newSketchData();
          const ids = S.addProjected(temp, [g], {});
          addSegs(COL.hover, false, S.curvePoints(temp, S.getCurve(temp, ids[0])));
        }
        else if (g.type === 'circle' || g.type === 'arc') {
          const a0 = g.type === 'arc' ? Math.atan2(g.a[1] - g.c[1], g.a[0] - g.c[0]) : 0;
          let span = g.type === 'arc' ? Math.atan2(g.b[1] - g.c[1], g.b[0] - g.c[0]) - a0 : Math.PI * 2;
          while (span <= 0) span += Math.PI * 2;
          const pts = [];
          for (let i = 0; i <= 64; i++) { const t = a0 + (span * i) / 64; pts.push([g.c[0] + g.r * Math.cos(t), g.c[1] + g.r * Math.sin(t)]); }
          addSegs(COL.hover, false, pts);
        }
      }
    }


    // dimensions
    this.dims = [];
    const dimSegs = [], drivenSegs = [], previewDimSegs = [];
    const dimList = this.dimsVisible ? sk.constraints.filter((k) => k.type === 'dim' && !k.hidden) : [];
    for (const k of dimList) {
      const gfx = this.dimGraphics(k, wpp);
      if (!gfx) continue;
      (k.driven ? drivenSegs : dimSegs).push(...gfx.segs);
      this.dims.push({ k, ...gfx });
    }
    if (d?.tool === 'dim' && d.spec) {
      const gfx = this.dimGraphics(d.spec, wpp);
      if (gfx) { previewDimSegs.push(...gfx.segs); this.dims.push({ k: { id: '__preview', ...d.spec }, ...gfx, preview: true }); }
    }

    const mkLines = (pts, color, dashed, order = 10, dist = null) => {
      if (!pts.length) return;
      const geo = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p[0], p[1], 0)));
      const mat = dashed
        ? new THREE.LineDashedMaterial({ color, depthTest: false, dashSize: 2 * wpp, gapSize: 3 * wpp }) // dotted
        : new THREE.LineBasicMaterial({ color, depthTest: false });
      const l = new THREE.LineSegments(geo, mat);
      if (dashed) { if (dist) geo.setAttribute('lineDistance', new THREE.Float32BufferAttribute(dist, 1)); else l.computeLineDistances(); }
      l.renderOrder = order;
      g.add(l);
    };
    for (const { color, dashed, pts, dist } of byColor.values()) mkLines(pts, color, dashed, 10, dist);
    mkLines(dimSegs, COL.dim, false, 9);
    mkLines(drivenSegs, 0x9aa3b2, false, 9);
    mkLines(previewDimSegs, COL.preview, false, 9);

    // points
    const ptGroups = new Map();
    const addPt = (p, color) => {
      if (!ptGroups.has(color)) ptGroups.set(color, []);
      ptGroups.get(color).push(new THREE.Vector3(p.x, p.y, 0));
    };
    const handlePoints = new Set(sk.curves.flatMap((c) => c.handles || []));
    for (const p of sk.points) {
      const color = this.sel.has(p.id) ? COL.selected : this.hover === p.id || this.relHover?.has(p.id) ? COL.hover : !this.solveOk ? COL.error : this.analysis?.pointDefined.get(p.id) ? COL.defined : COL.under;
      if (handlePoints.has(p.id)) {
        const handleColor = this.sel.has(p.id) || this.hover === p.id || !this.solveOk || this.analysis?.pointDefined.get(p.id) ? color : COL.handle;
        const ring = [];
        for (let i = 0; i < 24; i++) {
          const a = i * Math.PI / 12, b = (i + 1) * Math.PI / 12;
          ring.push([p.x + Math.cos(a) * 4.5 * wpp, p.y + Math.sin(a) * 4.5 * wpp], [p.x + Math.cos(b) * 4.5 * wpp, p.y + Math.sin(b) * 4.5 * wpp]);
        }
        mkLines(ring, handleColor, false, 12);
        continue;
      }
      addPt(p, color);
    }
    addPt(S.ORIGIN, this.sel.has('O') || this.hover === 'O' ? COL.selected : COL.origin);
    for (const [color, pts] of ptGroups) {
      const m = new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts), new THREE.PointsMaterial({ color, size: 6, sizeAttenuation: false, depthTest: false }));
      m.renderOrder = 11;
      g.add(m);
    }
    this._syncDimLabels();
    this._syncRelGlyphs();
    this._syncGearLabels();
    this._updateCursorUI();
  }

  // Gear numbers (as in the Gear Train panel) at each gear's centre: labels in the view, not geometry.
  // With several trains in the sketch the number is prefixed with the train's letter (A1, B2 …).
  _syncGearLabels() {
    const trains = this.f?.gearTrains || [];
    this.gearLabels = [];
    trains.forEach((tr, ti) => {
      const bad = S.trainProblems(this.f, tr).length > 0;
      const sel = [...this.sel].some((id) => String(id).startsWith('gear:' + tr.id + ':'));
      for (const g of S.trainGears(this.f, tr)) this.gearLabels.push({ x: g.cx, y: g.cy, r: (g.m * g.z) / 2, text: (trains.length > 1 ? String.fromCharCode(65 + (ti % 26)) : '') + (g.i + 1), bad, sel });
    });
    while (this.gearPool.length < this.gearLabels.length) {
      const el = document.createElement('div');
      this.vp.labelsEl.appendChild(el);
      this.gearPool.push(el);
    }
    this.gearPool.forEach((el, i) => {
      const gl = this.gearLabels[i];
      el.hidden = !gl;
      if (!gl) return;
      el.textContent = gl.text;
      el.className = 'gear-num' + (gl.bad ? ' bad' : '') + (gl.sel ? ' selected' : '');
      el.title = `Gear ${gl.text}`;
    });
    this._placeLabels();
  }

  previewPolylines(d) {
    const out = [];
    const sk = this.f;
    if (d.tool === 'spline' || d.tool === 'cspline') {
      const P = d.pts.map((id) => { const q = S.getPoint(sk, id); return [q.x, q.y]; });
      if (this.cursor) P.push([this.cursor.p.x, this.cursor.p.y]);
      const Q = P.filter((q, i, a) => !i || Math.hypot(q[0] - a[i - 1][0], q[1] - a[i - 1][1]) > 1e-9);
      // (a control-point spline: its control polygon too)
      if (d.tool === 'cspline' && Q.length >= 2) out.push(Q);
      const pcs = d.tool === 'cspline' ? S.ctrlSplineBeziers(Q, Math.min(this.splineDegree, Q.length - 1)) : S.splineBeziers(Q, false, Q.length >= 2 ? S.fitSplineHandles(Q) : null);
      if (pcs.length) out.push(pcs.flatMap((g, k) => Array.from({ length: 25 - (k ? 1 : 0) }, (_, i) => S.bezierAt(g, (i + (k ? 1 : 0)) / 24))));
      return out;
    }
    if (d.tool === 'line' || d.tool === 'centerline') {
      const a = S.getPoint(sk, d.last);
      if (a && this.cursor) out.push([[a.x, a.y], [this.cursor.p.x, this.cursor.p.y]]);
      return out;
    }
    const { p0, p1, p2 } = d;
    if (!p0) return out;
    if (d.tool === 'midline') return [[[2 * p0.x - p1.x, 2 * p0.y - p1.y], [p1.x, p1.y]]];
    const circ = (cx, cy, r, a0 = 0, span = Math.PI * 2) => {
      const pts = [], n = Math.max(8, Math.ceil((Math.abs(span) / (Math.PI * 2)) * 96));
      for (let i = 0; i <= n; i++) { const t = a0 + (span * i) / n; pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
      return pts;
    };
    if (d.tool === 'rect') out.push([[p0.x, p0.y], [p1.x, p0.y], [p1.x, p1.y], [p0.x, p1.y], [p0.x, p0.y]]);
    if (d.tool === 'crect') {
      const hw = p1.x - p0.x, hh = p1.y - p0.y;
      out.push([[p0.x - hw, p0.y - hh], [p0.x + hw, p0.y - hh], [p0.x + hw, p0.y + hh], [p0.x - hw, p0.y + hh], [p0.x - hw, p0.y - hh]]);
    }
    if (d.tool === 'circle') out.push(circ(p0.x, p0.y, Math.hypot(p1.x - p0.x, p1.y - p0.y)));
    if (d.tool === 'polygon') {
      const r = Math.hypot(p1.x - p0.x, p1.y - p0.y), a0 = Math.atan2(p1.y - p0.y, p1.x - p0.x), n = this.polySides;
      const pts = [];
      for (let i = 0; i <= n; i++) { const t = a0 + (i / n) * Math.PI * 2; pts.push([p0.x + r * Math.cos(t), p0.y + r * Math.sin(t)]); }
      out.push(pts);
    }
    if (d.tool === 'arc') {
      const r = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      if (d.stage === 1) out.push([[p0.x, p0.y], [p1.x, p1.y]]);
      else out.push(circ(p0.x, p0.y, r, Math.atan2(p1.y - p0.y, p1.x - p0.x), d.sweep));
    }
    if (d.tool === 'arc3') {
      if (d.stage === 1) out.push([[p0.x, p0.y], [p1.x, p1.y]]);
      else {
        const C = S.circleThrough([p0.x, p0.y], [p1.x, p1.y], [p2.x, p2.y]);
        if (!C) out.push([[p0.x, p0.y], [p1.x, p1.y]]);
        else {
          const a0 = Math.atan2(p0.y - C.cy, p0.x - C.cx), a1 = Math.atan2(p1.y - C.cy, p1.x - C.cx);
          const ccw = (p2.x - p0.x) * (p1.y - p0.y) - (p2.y - p0.y) * (p1.x - p0.x) > 0;
          let span = ccw ? a1 - a0 : a0 - a1;
          while (span <= 0) span += Math.PI * 2;
          out.push(circ(C.cx, C.cy, C.r, a0, ccw ? span : -span));
        }
      }
    }
    if (d.tool === 'tarc') {
      const g = this.tarcGeom(d);
      if (!g) out.push([[p0.x, p0.y], [p1.x, p1.y]]);
      else {
        const a0 = Math.atan2(p0.y - g.cy, p0.x - g.cx), a1 = Math.atan2(p1.y - g.cy, p1.x - g.cx);
        let span = g.ccw ? a1 - a0 : a0 - a1;
        while (span <= 0) span += Math.PI * 2;
        out.push(circ(g.cx, g.cy, g.r, a0, g.ccw ? span : -span));
      }
    }
    if (d.tool === 'ellipse') {
      const ra = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      if (d.stage === 1 || ra < 1e-9) out.push([[p0.x, p0.y], [p1.x, p1.y]]);
      else {
        const u = [(p1.x - p0.x) / ra, (p1.y - p0.y) / ra], v = [-u[1], u[0]];
        const rb = Math.abs((p2.x - p0.x) * v[0] + (p2.y - p0.y) * v[1]);
        const pts = [];
        for (let i = 0; i <= 96; i++) { const t = (i / 96) * Math.PI * 2; pts.push([p0.x + ra * Math.cos(t) * u[0] + rb * Math.sin(t) * v[0], p0.y + ra * Math.cos(t) * u[1] + rb * Math.sin(t) * v[1]]); }
        out.push(pts, [[p0.x - ra * u[0], p0.y - ra * u[1]], [p1.x, p1.y]]);
      }
    }
    if (['slot', 'cslot', 'oslot', 'arcslot', 'arcslot3'].includes(d.tool)) {
      if (d.stage === 1) out.push([[p0.x, p0.y], [p1.x, p1.y]]);
      else {
        const g = S.slotLayout(d.tool, [p0, p1, p2, d.stage === 3 ? d.p3 : null], d.sweep);
        if (!g) return out;
        if (g.type === 'line') {
          const { a: A, b: B, r } = g, angle = Math.atan2(B.y - A.y, B.x - A.x), nx = -Math.sin(angle), ny = Math.cos(angle);
          out.push([[B.x + r * nx, B.y + r * ny], [A.x + r * nx, A.y + r * ny]], [[A.x - r * nx, A.y - r * ny], [B.x - r * nx, B.y - r * ny]]);
          out.push(circ(B.x, B.y, r, angle - Math.PI / 2, Math.PI), circ(A.x, A.y, r, angle + Math.PI / 2, Math.PI));
        } else {
          const a = Math.atan2(g.a.y - g.c.y, g.a.x - g.c.x), b = Math.atan2(g.b.y - g.c.y, g.b.x - g.c.x), span = (b - a + Math.PI * 2) % (Math.PI * 2);
          if (d.stage === 2) out.push(circ(g.c.x, g.c.y, g.radius, a, span));
          else out.push(circ(g.c.x, g.c.y, g.radius + g.r, a, span), circ(g.c.x, g.c.y, g.radius - g.r, a, span), circ(g.b.x, g.b.y, g.r, b, Math.PI), circ(g.a.x, g.a.y, g.r, a + Math.PI, Math.PI));
        }
      }
    }
    return out;
  }

  _syncDimLabels() {
    const dims = this.dims || [];
    while (this.dimPool.length < dims.length) {
      const el = document.createElement('div');
      el.className = 'dim';
      let drag = null, suppressClick = false;
      const finish = (ok) => {
        if (!drag) return;
        const d = drag; drag = null; this.dimLabelDrag = null;
        if (el.hasPointerCapture(d.pointerId)) el.releasePointerCapture(d.pointerId);
        if (d.moved) {
          suppressClick = true;
          if (ok) this.changed();
          else { for (const key of ['off', 'ang', 'labelOffset']) { if (key in d.before) d.k[key] = d.before[key]; else delete d.k[key]; } this.redraw(); }
        }
      };
      el.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        suppressClick = false;
        if (ev.button !== 0 || ev.ctrlKey || ev.shiftKey || ev.metaKey) return;
        const dm = this.dims[+el.dataset.idx];
        if (!dm || dm.preview) return;
        ev.preventDefault(); this.closeModify();
        const start = this.localFromEvent(ev);
        drag = { k: dm.k, pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY, grab: [dm.at[0] - start.x, dm.at[1] - start.y], before: Object.fromEntries(['off', 'ang', 'labelOffset'].filter((key) => key in dm.k).map((key) => [key, dm.k[key]])), moved: false, cancel: () => finish(false) };
        this.dimLabelDrag = drag;
        el.setPointerCapture(ev.pointerId);
      });
      el.addEventListener('pointermove', (ev) => {
        if (!drag || ev.pointerId !== drag.pointerId) return;
        ev.stopPropagation();
        if (!drag.moved && Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < 4) return;
        drag.moved = true;
        const p = this.localFromEvent(ev);
        this.moveDimensionLabel(drag.k, { x: p.x + drag.grab[0], y: p.y + drag.grab[1] });
      });
      el.addEventListener('pointerup', (ev) => { if (drag && ev.pointerId === drag.pointerId) { ev.stopPropagation(); finish(true); } });
      el.addEventListener('pointercancel', () => finish(false));
      el.addEventListener('lostpointercapture', () => finish(false));
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (suppressClick) { suppressClick = false; return; }
        const dm = this.dims[+el.dataset.idx];
        if (!dm || dm.preview) return;
        if (ev.ctrlKey || ev.shiftKey) { this.sel.has(dm.k.id) ? this.sel.delete(dm.k.id) : this.sel.add(dm.k.id); this.redraw(); this.app.ui.renderPM(); return; }
        this.openModify(+el.dataset.idx);
      });
      this.vp.labelsEl.appendChild(el);
      this.dimPool.push(el);
    }
    this.dimPool.forEach((el, i) => {
      const dm = dims[i];
      el.hidden = !dm;
      if (!dm) return;
      el.dataset.idx = i;
      const k = dm.k;
      const expr = !dm.preview && !isNumeric(k.value);
      el.className = 'dim' + (k.driven ? ' driven' : '') + (this.sel.has(k.id) ? ' selected' : '') + (dm.preview ? ' preview' : '');
      el.style.pointerEvents = dm.preview || this.patternDraft || (this.tool !== 'select' && this.tool !== 'dim') ? 'none' : 'auto';
      const txt = (dm.prefix || '') + (k.kind === 'angle' ? fmt(dm.value) : this.L(dm.value)) + (dm.suffix || '');
      el.innerHTML = (expr ? '<span class="sig">Σ</span>' : '') + (k.driven ? `(${txt})` : txt);
      el.title = (k.driven ? 'Driven (reference) dimension' : expr ? `= ${k.kind === 'angle' ? k.value : lenText(k.value, this.app.units)}` : 'Click to modify') + ' · Drag to move the annotation';
    });
    this._placeLabels();
  }

  relAnchors() {
    const sk = this.f, wpp = this.wpp();
    const out = [];
    if (!this.relsVisible) return out;
    const counts = new Map();
    const place = (x, y, k, glyph) => {
      const key = `${Math.round(x / (wpp * 14))},${Math.round(y / (wpp * 14))}`;
      const n = counts.get(key) || 0;
      counts.set(key, n + 1);
      out.push({ k, glyph, x, y, shift: n });
    };
    const curveAnchor = (c) => {
      if (c.type === 'spline') { const q = S.curvePoints(sk, c); const m = q[q.length >> 1]; return [m[0] + 8 * wpp, m[1] + 8 * wpp]; }
      if (c.type === 'line') {
        const a = S.getPoint(sk, c.p1), b = S.getPoint(sk, c.p2);
        const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
        return [(a.x + b.x) / 2 - (dy / L) * 10 * wpp, (a.y + b.y) / 2 + (dx / L) * 10 * wpp];
      }
      const C = S.getPoint(sk, c.c), r = S.radiusOf(sk, c);
      if (c.type === 'arc') {
        const A = S.arcAngles(sk, c);
        const t = A.a0 + A.span / 2;
        return [C.x + (r + 10 * wpp) * Math.cos(t), C.y + (r + 10 * wpp) * Math.sin(t)];
      }
      return [C.x + (r + 10 * wpp) * Math.cos(2.4), C.y + (r + 10 * wpp) * Math.sin(2.4)];
    };
    for (const k of sk.constraints) {
      if (k.type === 'dim' || k.type === 'sketchPattern') continue;
      const glyph = RELATION_INFO[k.type]?.glyph || '?';
      if (k.type === 'equalDist') {
        const a = S.getPoint(sk, k.refs[0]), b = S.getPoint(sk, k.refs[1]);
        if (a && b) place((a.x + b.x) / 2 + 6 * wpp, (a.y + b.y) / 2 - 6 * wpp, k, glyph);
        continue;
      }
      const refs = k.type === 'symmetric' ? [k.refs[0], k.refs[1]] : k.type==='offsetGeometry'?[k.chain[0].id,k.refs[k.chain.length]]:k.refs;
      for (const r of refs) {
        const c = S.getCurve(sk, r);
        if (c) { const [x, y] = curveAnchor(c); place(x, y, k, glyph); }
        else {
          const p = S.getPoint(sk, r);
          if (p) place(p.x + 8 * wpp, p.y - 8 * wpp, k, glyph);
        }
        if (k.type === 'onCurve' || k.type === 'midpoint' || k.type === 'coincident' || k.type === 'fix') break;
      }
    }
    return out;
  }

  _syncRelGlyphs() {
    this.rels = this.relAnchors();
    while (this.relPool.length < this.rels.length) {
      const el = document.createElement('div');
      el.className = 'rel';
      el.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const r = this.rels[+el.dataset.idx];
        if (!r) return;
        if (!(ev.ctrlKey || ev.shiftKey)) this.sel.clear();
        this.sel.has(r.k.id) ? this.sel.delete(r.k.id) : this.sel.add(r.k.id);
        this.redraw();
        this.app.ui.renderPM();
        this.app.ui.refreshCommandStates();
      });
      el.addEventListener('pointerenter', () => {
        const r = this.rels[+el.dataset.idx];
        if (r) { this.relHover = new Set(r.k.refs); this.redraw(); }
      });
      el.addEventListener('pointerleave', () => { this.relHover = null; this.redraw(); });
      this.vp.labelsEl.appendChild(el);
      this.relPool.push(el);
    }
    this.relPool.forEach((el, i) => {
      const r = this.rels[i];
      el.hidden = !r;
      if (!r) return;
      el.dataset.idx = i;
      el.textContent = r.glyph;
      el.className = 'rel' + (this.sel.has(r.k.id) ? ' selected' : '');
      el.style.pointerEvents = this.tool === 'select' ? 'auto' : 'none';
      el.title = this.relationLabel(r.k);
    });
    this._placeLabels();
  }

  _placeLabels() {
    (this.dims || []).forEach((dm, i) => {
      const el = this.dimPool[i];
      if (!el) return;
      const p = this.vp.project(G.toWorld(this.frame, dm.at[0], dm.at[1]));
      el.style.left = p.x + 'px';
      el.style.top = p.y + 'px';
      let angle = 0;
      if (dm.textDir) {
        const q = this.vp.project(G.toWorld(this.frame, dm.at[0] + dm.textDir[0], dm.at[1] + dm.textDir[1]));
        angle = Math.atan2(q.y - p.y, q.x - p.x);
        if (angle > Math.PI / 2) angle -= Math.PI;
        if (angle < -Math.PI / 2) angle += Math.PI;
      }
      el.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`;
    });
    (this.gearLabels || []).forEach((gl, i) => {
      const el = this.gearPool[i];
      if (!el) return;
      // just above the centre point, so the point stays visible and pickable
      const p = this.vp.project(G.toWorld(this.frame, gl.x, gl.y));
      el.style.left = p.x + 'px';
      el.style.top = p.y - 14 + 'px';
    });
    (this.rels || []).forEach((r, i) => {
      const el = this.relPool[i];
      if (!el) return;
      const p = this.vp.project(G.toWorld(this.frame, r.x, r.y));
      el.style.left = p.x + r.shift * 15 + 'px';
      el.style.top = p.y + 'px';
    });
    if (this.modifyEl && this.modifyK) {
      const dm = this.dims.find((x) => x.k.id === this.modifyK.id);
      if (dm) {
        const p = this.vp.project(G.toWorld(this.frame, dm.at[0], dm.at[1]));
        this.modifyEl.style.left = Math.min(p.x + 14, this.vp.width - 210) + 'px';
        this.modifyEl.style.top = Math.min(p.y + 10, this.vp.height - 110) + 'px';
      }
    }
  }

  _frame() {
    if (!this.active) return;
    const w = this.wpp();
    if (Math.abs(w - this.lastWpp) / (this.lastWpp || 1) > 0.04 && !this.drag) this.redraw();
    else this._placeLabels();
  }

  _updateCursorUI() {
    const fmt = (x, d) => (d === 1 ? fmtLen(x, 'mm', 1) : this.L(x)); // (lengths in the document's unit; angles have 1 decimal)
    const c = this.cursor;
    if (this.tool === 'dim' && this.draw?.spec && c) {
      this.snapEl.hidden = true; this.tipEl.hidden = false;
      this.tipEl.textContent = this.draw.placing || this.draw.picks.length === 2 ? 'Click to place dimension · Esc cancels' : 'Click to place, or pick another entity · Esc cancels';
      this.tipEl.style.left = c.screen.x + 'px'; this.tipEl.style.top = c.screen.y + 'px';
      return;
    }
    const drawing = !['select', 'trim', 'dim', 'convert', 'intersect', 'offset', 'extend', 'split'].includes(this.tool);
    if (this.tool === 'offset' && this.draw?.tool === 'offset' && c) {
      this.tipEl.hidden = false;
      let value=Math.abs(this.draw.dist);try{if(this.offsetTyped)value=this.ev(this.offsetDistance);}catch{}
      this.tipEl.textContent = this.draw.error||`Offset ${fmt(value)}${this.offsetMode==='both'?' each side':''}`;
      this.tipEl.style.left = c.screen.x + 'px';
      this.tipEl.style.top = c.screen.y + 'px';
      this.snapEl.hidden = true;
      return;
    }

    if (!c || !drawing) { this.snapEl.hidden = true; this.tipEl.hidden = true; return; }
    const p = c.p;
    this.snapEl.hidden = !(p.kind === 'point' || p.kind === 'mid' || p.kind === 'onCurve' || p.kind === 'model'||p.inferCurve);
    const sp = this.vp.project(G.toWorld(this.frame, p.x, p.y));
    this.snapEl.style.left = sp.x + 'px';
    this.snapEl.style.top = sp.y + 'px';
    const infer = p.inferCurve?`${p.extension?'≡ Extension':p.infer==='collinear'?'≡ Collinear':'∥ Parallel'} · ${S.itemName(this.f,p.inferCurve)}`:(p.kind === 'model' ? { point: '• Model vertex', center: '⊙ Centre', onCurve: '◦ On edge' }[p.as] : { point: '• Coincident', mid: 'M Midpoint', onCurve: '◦ On curve' }[p.kind]) || (p.infer === 'horizontal' ? 'H' : p.infer === 'vertical' ? 'V' : '');
    let tip = `${fmt(p.x)}, ${fmt(p.y)}`;
    const d = this.draw;
    if (d?.tool === 'spline') tip = `Point ${d.pts.length + 1}   ${tip}`;
    if (d?.tool === 'cspline') tip = `Control point ${d.pts.length + 1}   ${tip}`;
    else if (d?.tool === 'line' || d?.tool === 'centerline') {
      const a = S.getPoint(this.f, d.last);
      if (a) tip = `L ${fmt(Math.hypot(p.x - a.x, p.y - a.y))}  ∠ ${fmt((Math.atan2(p.y - a.y, p.x - a.x) * 180) / Math.PI, 1)}°`;
    } else if (d?.p0) {
      const dx = d.p1.x - d.p0.x, dy = d.p1.y - d.p0.y;
      if (d.tool === 'rect') tip = `${fmt(Math.abs(dx))} × ${fmt(Math.abs(dy))}`;
      if (d.tool === 'crect') tip = `${fmt(2 * Math.abs(dx))} × ${fmt(2 * Math.abs(dy))}`;
      if (d.tool === 'circle' || d.tool === 'polygon') tip = `Ø ${fmt(2 * Math.hypot(dx, dy))}`;
      if (d.tool === 'arc' && d.stage === 2) tip = `R ${fmt(Math.hypot(dx, dy))}  ${fmt(Math.abs((d.sweep * 180) / Math.PI), 1)}°`;
      if (d.tool === 'slot') tip = `L ${fmt(Math.hypot(dx, dy))}`;
      if (d.tool === 'ellipse') {
        const ra = Math.hypot(dx, dy);
        tip = d.stage === 1 || ra < 1e-9 ? `Major R ${fmt(ra)}` : `Major R ${fmt(ra)}  Minor R ${fmt(Math.abs(-(d.p2.x - d.p0.x) * (dy / ra) + (d.p2.y - d.p0.y) * (dx / ra)))}`;
      }
      if (d.tool === 'arc3' && d.stage === 2) { const C = S.circleThrough([d.p0.x, d.p0.y], [d.p1.x, d.p1.y], [d.p2.x, d.p2.y]); if (C) tip = `R ${fmt(C.r)}`; }
      if (d.tool === 'tarc') { const g = this.tarcGeom(d); if (g) tip = `R ${fmt(g.r)}`; }
    }
    this.tipEl.hidden = false;
    this.tipEl.textContent = infer ? `${infer}   ${tip}` : tip;
    this.tipEl.style.left = c.screen.x + 'px';
    this.tipEl.style.top = c.screen.y + 'px';
  }

  // A length as the document shows it (inches in an inch document).
  L(x, digits = null) { return this.app.units === 'in' ? fmtLen(x, 'in', digits ?? 3) : fmt(x, digits ?? 2); }

  // ------------------------------------------------------------ Modify dialog
  openModify(i) {
    this.closeModify();
    const dm = this.dims[i];
    if (!dm || dm.preview) return;
    const k = dm.k;
    this.sel.clear();
    this.sel.add(k.id);
    const el = document.createElement('div');
    el.className = 'modify';
    el.innerHTML = `
      <div class="mh"><span>Modify</span><button data-a="ok" title="Save">✔</button><button data-a="cancel" title="Cancel">✖</button><button data-a="del" title="Delete dimension">🗑</button></div>
      <input type="text" spellcheck="false">
      ${k.kind === 'arcDist' ? `<div class="mcond">${[['center', 'Center'], ['min', 'Min'], ['max', 'Max']].map(([c, l]) => `<button data-c="${c}" class="${(k.cond || 'center') === c ? 'on' : ''}" title="${c === 'center' ? 'Center to center' : c === 'min' ? 'Minimum (arc to arc, nearest)' : 'Maximum (arc to arc, farthest)'}">${l}</button>`).join('')}</div>` : ''}
      <div class="merr"></div>`;
    el.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    const input = el.querySelector('input');
    this.app.ui.completeExpression(input);
    // (a length in an inch sketch: shown and typed in inches)
    const U = k.kind === 'angle' ? 'mm' : this.app.units;
    input.value = k.driven ? (k.kind === 'angle' ? fmt(dm.value, 4) : fmtLen(dm.value, U, 4)) : String(lenText(k.value, U));
    if (k.driven) input.disabled = true;
    const err = el.querySelector('.merr');
    if (k.driven) err.textContent = 'Driven dimension (reference only)';
    const apply = () => {
      if (k.driven) return this.closeModify();
      const old = k.value;
      try {
        const v = this.ev(lenValue(input.value, U));
        if (!['hdist', 'vdist', 'pointLine', 'arcDist'].includes(k.kind) && v <= 0) throw new Error('Value must be greater than zero');
        if (k.kind === 'arcDist' && v < 0 && (k.cond || 'center') !== 'min') throw new Error('Value must not be negative');
        k.value = lenValue(input.value, U);
        const r = this.solve();
        if (!r.ok) { k.value = old; this.solve(); throw new Error('The sketch cannot be solved with that value'); }
        this.closeModify();
        this.changed();
      } catch (ex) {
        err.textContent = ex.message;
        input.classList.add('bad');
      }
    };
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') apply();
      if (ev.key === 'Escape') this.closeModify();
    });
    input.addEventListener('input', () => {
      try { this.ev(lenValue(input.value, U)); err.textContent = ''; input.classList.remove('bad'); } catch (ex) { err.textContent = ex.message; }
    });
    el.querySelectorAll('.mcond button').forEach((b) => {
      b.onclick = () => this.setArcCondition(k, b.dataset.c);
    });
    el.querySelector('[data-a=ok]').onclick = apply;
    el.querySelector('[data-a=cancel]').onclick = () => this.closeModify();
    el.querySelector('[data-a=del]').onclick = () => { this.closeModify(); this.deleteConstraint(k.id); };
    this.vp.labelsEl.appendChild(el);
    this.modifyEl = el;
    this.modifyK = k;
    this._placeLabels();
    this.redraw();
    this.app.ui.renderPM();
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  // Switch a circle/arc dimension between center, minimum and maximum. The geometry stays put;
  // the dimension takes the value measured with the new condition.
  setArcCondition(k, cond) {
    k.cond = cond;
    if (cond === 'min') {
      const sk = this.f, a = S.getCurve(sk, k.refs[0]), b = S.getCurve(sk, k.refs[1]);
      if (a && a.type !== 'line') {
        const A = S.getPoint(sk, a.c), B = S.getPoint(sk, b.c);
        k.nested = Math.hypot(B.x - A.x, B.y - A.y) < Math.abs(S.radiusOf(sk, a) - S.radiusOf(sk, b));
      }
    }
    const g = this.arcDistGeom(k);
    if (g && !k.driven) k.value = r4(g.value);
    this.solve();
    this.changed();
    const idx = this.dims.findIndex((x) => x.k.id === k.id);
    if (idx >= 0) this.openModify(idx);
  }

  closeModify() {
    if (this.modifyEl) this.modifyEl.remove();
    this.modifyEl = null;
    this.modifyK = null;
  }
}

function norm(v) {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

function lineIntersection(A, d1, B, d2) {
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < 1e-12) return [A.x, A.y];
  const t = ((B.x - A.x) * d2[1] - (B.y - A.y) * d2[0]) / den;
  return [A.x + t * d1[0], A.y + t * d1[1]];
}
