// User interface: menus, Command ribbon, Feature tree, Property panel,
// context menus, heads-up view toolbar and dialogs.
import { icon } from './icons.js';
import { editCustomProps } from './custprops.js';
import { compareWith } from './compare.js';
import { setThemePref, themePref, isDark } from './theme.js';
import { t as tr, LANGUAGES, language, setLanguage } from './i18n.js';
import { iconFor, MATERIALS, planeName, findFeature, TYPE_INFO, bodySettings, materialById, rollbackIndex, referencesOf, dependentsOf, absorbedSketches, moveProblem, bodyOwner, folderOfBody, sketchesUsedBy } from './model.js';
import { STD_PLANES } from './geometry.js';
import { evaluate, evalEquations, fmt, isNumeric, isValidName, normalizeValue } from './expr.js';
import { SKETCH_TOOLS } from './sketcher.js';
import { completeExpression } from './exprcomplete.js';
import { S3_TOOLS, S3_KEYS } from './sketch3d.js';
import { RELATION_INFO, analyzeSketch } from './solver.js';
import * as SM from './sketchmodel.js';
import * as LR from './loftrefs.js';
import { axisCandidates, PATTERN_SKIP, fileStem, folderOfFeature, newFeatureFolder, putFeatureInFolder } from './model.js';
import { BUILTIN_TEMPLATES, DEFAULT_TEMPLATE_ID, templateSummary, isTemplate } from './drawtemplates.js';
import { SHEET_SIZES as DW_SIZES } from './drawingformats.js';
import { inferPlaneType, planeRefs, legacyDatumRefs, useReferenceRelations } from './refgeom.js';
import * as G from './geometry.js';
import { platform } from './platform.js';
import { threadList } from './threads.js';
import { HOLE_SIZES } from './holes.js';
import { LIBRARY, STANDARDS, PROFILE_TYPES, PIERCE } from './profiles.js';
import { PIPE_SIZES, pipeLabel } from './routing.js';
import { stackUp } from './stackup.js';
import { revisionsDialog } from './revisions.js';
import { cutListRows, cutListCSV } from './weldments.js';
import { ACI, aciColor, LTYPES, OPTION_LABELS, loadDxfSettings, saveDxfSettings, selectEnts } from './dxf.js';
import { CLAUDE_MODELS } from './claudespec.js';
import { lenText, lenValue, fmtLen, lenWithUnit, areaWithUnit, volWithUnit } from './units.js';
import { groupBodies } from './bodygroups.js';
import * as W from './wcs.js';
import {referenceRelations,defaultReferenceRelations,RELATION_LABELS} from './refconstraints.js';
import * as LC from './loftcorrespondence.js';

function datumHint(doc,r){
  if(r.kind==='curve')return {kind:'path',curve:{type:'path'}};
  if(r.kind==='plane'||r.kind==='face'&&r.n)return {kind:'plane'};
  if(r.kind==='face')return {kind:'cylinder'};
  if(r.kind==='point'||r.kind==='vertex'||r.kind==='sketch'&&r.point)return {kind:'point'};
  const source=r.kind==='sketch'?findFeature(doc,r.sketch):null,c=source&&SM.getCurve(source,r.curve);
  if(c?.type==='spline')return {kind:'path',curve:{type:'path'}};
  return {kind:'line',...(r.kind==='edge'||c?{curve:{type:c?.type||'unknown'}}:{})};
}
function resolvedDatumHint(doc,r,g,type){
  if(g.kind!=='path')return g;
  if(r.kind==='sketch')return datumHint(doc,r);
  if(r.kind==='edge'&&(type==='point'||['line','circle','arc'].includes(g.curve?.type)))return {kind:'line',curve:g.curve};
  return g;
}
function hasPlaneRelation(f,a,relation){
  const refs=f.refs||[],info=a.result?.info?.[f.id],geo=info?.datumSignature===JSON.stringify(f)&&info.geometry?info.geometry:refs.map(r=>datumHint(a.doc,r)),defaults=defaultReferenceRelations('plane',geo,f);
  return refs.some((r,i)=>(r.relation||defaults[i])===relation);
}

const SKETCH_TOOL_GROUPS = [
  ['line', 'Line', ['line', 'centerline', 'midline']],
  ['rectangle', 'Rectangle', ['rect', 'crect']],
  ['arc', 'Arc', ['arc', 'arc3', 'tarc']],
  ['spline', 'Spline', ['spline', 'cspline']],
  ['slot', 'Slot', ['slot', 'cslot', 'oslot', 'arcslot3', 'arcslot']],
];

// Draw DXF entities (flat pattern) on a canvas: CAD colours on dark, line types as dash patterns.
// view: { zoom, px, py } on top of the fit-to-window placement (zoom / pan in the preview);
// sel / hover: entity ids drawn highlighted. Returns the placement { X, Y, s, toWorld } (for picking).
function dxfExtents(ents) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const ext = (p, r = 0) => { x0 = Math.min(x0, p[0] - r); y0 = Math.min(y0, p[1] - r); x1 = Math.max(x1, p[0] + r); y1 = Math.max(y1, p[1] + r); };
  for (const e of ents) {
    if (e.type === 'LINE') { ext(e.a); ext(e.b); } else if (e.type === 'TEXT') { ext(e.p); ext([e.p[0] + e.h * e.text.length * 0.6, e.p[1] + e.h]); } else if (e.c) ext(e.c, e.r); else e.pts.forEach((p) => ext(p));
  }
  return isFinite(x0) ? { x0, y0, x1, y1 } : null;
}
function drawDxfPreview(cv, ents, mapping, view = null, sel = null, hover = null, fitEnts = null) {
  const ctx = cv.getContext('2d');
  const dpr = cv.width / (cv.clientWidth || cv.width);
  const W = cv.width / dpr, H = cv.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#1b1f24';
  ctx.fillRect(0, 0, W, H);
  const box = dxfExtents(fitEnts || ents);
  if (!box) return null;
  const { x0, y0, x1, y1 } = box;
  const m = 24, s0 = Math.min((W - 2 * m) / Math.max(x1 - x0, 1e-6), (H - 2 * m) / Math.max(y1 - y0, 1e-6));
  const ox = m + ((W - 2 * m) - (x1 - x0) * s0) / 2, oy = m + ((H - 2 * m) - (y1 - y0) * s0) / 2;
  const z = view?.zoom || 1, px = view?.px || 0, py = view?.py || 0, s = s0 * z;
  const X = (x) => (ox + (x - x0) * s0) * z + px, Y = (y) => (H - (oy + (y - y0) * s0)) * z + py;
  const toWorld = (sx, sy) => [((sx - px) / z - ox) / s0 + x0, (H - (sy - py) / z - oy) / s0 + y0];
  for (const e of ents) {
    const map = mapping[e.layer] || { color: 7, ltype: 'CONTINUOUS' };
    const on = sel?.has(e._id), hot = hover != null && hover === e._id;
    ctx.strokeStyle = ctx.fillStyle = on ? '#38bdf8' : hot ? '#fbbf24' : aciColor(map.color);
    ctx.lineWidth = on || hot ? 2.4 : 1.2;
    const pat = (LTYPES[e.ltype || map.ltype]?.pattern || []).map((x) => Math.max(Math.abs(x) * s, x === 0 ? 1.5 : 3));
    ctx.setLineDash(pat);
    ctx.beginPath();
    if (e.type === 'LINE') { ctx.moveTo(X(e.a[0]), Y(e.a[1])); ctx.lineTo(X(e.b[0]), Y(e.b[1])); }
    else if (e.type === 'CIRCLE') ctx.arc(X(e.c[0]), Y(e.c[1]), e.r * s, 0, Math.PI * 2);
    else if (e.type === 'ARC') ctx.arc(X(e.c[0]), Y(e.c[1]), e.r * s, (-e.a0 * Math.PI) / 180, (-e.a1 * Math.PI) / 180, true);
    else if (e.type === 'POLYLINE') { e.pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])))); if (e.closed) ctx.closePath(); }
    else if (e.type === 'TEXT') {
      ctx.save();
      ctx.translate(X(e.p[0]), Y(e.p[1]));
      ctx.rotate((-(e.rot || 0) * Math.PI) / 180);
      ctx.font = `${Math.max(8, e.h * s)}px Consolas, monospace`;
      ctx.textAlign = e.align === 'center' ? 'center' : 'left';
      ctx.fillText(e.text, 0, 0);
      ctx.restore();
      continue;
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  return { X, Y, s, toWorld };
}

// The entity under a screen point (within tol pixels), for picking in the preview; null if none.
function dxfPick(ents, P, sx, sy, tol = 6) {
  const segD = (ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((sx - ax) * dx + (sy - ay) * dy) / L)) : 0;
    return Math.hypot(sx - ax - t * dx, sy - ay - t * dy);
  };
  let best = null, bd = tol;
  for (const e of ents) {
    let d = Infinity;
    if (e.type === 'LINE') d = segD(P.X(e.a[0]), P.Y(e.a[1]), P.X(e.b[0]), P.Y(e.b[1]));
    else if (e.type === 'CIRCLE' || e.type === 'ARC') {
      const cx = P.X(e.c[0]), cy = P.Y(e.c[1]);
      d = Math.abs(Math.hypot(sx - cx, sy - cy) - e.r * P.s);
      if (e.type === 'ARC') {
        let a = (Math.atan2(cy - sy, sx - cx) * 180) / Math.PI; // (y up)
        const norm = (x) => ((x % 360) + 360) % 360;
        const a0 = norm(e.a0), span = norm(e.a1 - e.a0) || 360;
        if (norm(a - a0) > span) d = Infinity;
      }
    } else if (e.type === 'POLYLINE') {
      for (let i = 0; i + 1 < e.pts.length; i++) d = Math.min(d, segD(P.X(e.pts[i][0]), P.Y(e.pts[i][1]), P.X(e.pts[i + 1][0]), P.Y(e.pts[i + 1][1])));
      if (e.closed && e.pts.length > 2) { const a = e.pts[e.pts.length - 1], b = e.pts[0]; d = Math.min(d, segD(P.X(a[0]), P.Y(a[1]), P.X(b[0]), P.Y(b[1]))); }
    } else if (e.type === 'TEXT') {
      const x = P.X(e.p[0]), y = P.Y(e.p[1]), w = e.h * e.text.length * 0.6 * P.s, h = e.h * P.s;
      const l = e.align === 'center' ? x - w / 2 : x;
      if (sx >= l - 2 && sx <= l + w + 2 && sy <= y + 2 && sy >= y - h - 2) d = 0;
    }
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}
// The entities inside a screen rectangle (wholly inside, as a window selection).
function dxfInBox(ents, P, r) {
  const inside = (x, y) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
  return ents.filter((e) => {
    if (e.type === 'LINE') return inside(P.X(e.a[0]), P.Y(e.a[1])) && inside(P.X(e.b[0]), P.Y(e.b[1]));
    if (e.type === 'CIRCLE' || e.type === 'ARC') { const cx = P.X(e.c[0]), cy = P.Y(e.c[1]), rr = e.r * P.s; return inside(cx - rr, cy - rr) && inside(cx + rr, cy + rr); }
    if (e.type === 'POLYLINE') return e.pts.every((p) => inside(P.X(p[0]), P.Y(p[1])));
    if (e.type === 'TEXT') return inside(P.X(e.p[0]), P.Y(e.p[1]));
    return false;
  });
}

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A key press as a shortcut name ("Ctrl+Shift+F", "G", "F6"), or null for a modifier key on its own.
export function comboOf(e) {
  const k = e.key;
  if (!k || ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'].includes(k)) return null;
  const key = k === ' ' ? 'Space' : k.length === 1 ? k.toUpperCase() : k;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  // (Shift with a letter or a named key; a symbol typed with Shift is that symbol)
  if (e.shiftKey && (k.length !== 1 || /[a-z]/i.test(k))) parts.push('Shift');
  return [...parts, key].join('+');
}
// shortcuts RazorCAD has of its own (a custom shortcut on one of these takes its place)
const BUILTIN_KEYS = { 'Ctrl+S': 'Save', 'Ctrl+Shift+S': 'Save As', 'Ctrl+O': 'Open', 'Ctrl+N': 'New Part', 'Ctrl+Z': 'Undo', 'Ctrl+Y': 'Redo', 'Ctrl+B': 'Rebuild', 'Ctrl+I': 'Import', 'Ctrl+K': 'Search Commands',
  F: 'Zoom to Fit', X: 'Face filter', E: 'Edge filter (in a sketch: Convert Entities)', V: 'Vertex filter', B: 'Body filter', F5: 'Clear the filters', Delete: 'Delete', L: 'Line (sketch)', R: 'Rectangle (sketch)', C: 'Circle (sketch)', A: 'Arc (sketch)', N: 'Spline (sketch)', P: 'Polygon (sketch)', S: 'Select (sketch)', D: 'Dimension (sketch)', T: 'Trim (sketch)', O: 'Offset (sketch)', M: 'Mate (assembly)' };
const RESERVED_KEYS = new Set(['Escape', 'Enter', 'Tab', 'Shift+Tab', 'Backspace', '/']);

const el = (tag, attrs = {}, html = '') => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  if (html) e.innerHTML = html;
  return e;
};

const ENDS = [['blind', 'Blind'], ['midplane', 'Mid Plane'], ['through', 'Through All'], ['through2', 'Through All - Both']];
// The X, Y and Z axes as choices (RazorCAD's keys for the user's axes, wcs.js); cur: the value held, listed too
// when the up axis has changed since it was chosen (e.g. RazorCAD's 'z' with Z up: −Y)
const axisChoices = (cur) => {
  const out = ['x', 'y', 'z'].map((u) => [W.internalAxis(u), `${u.toUpperCase()} axis`]);
  if (/^-?[xyz]$/.test(cur || '') && !out.some(([k]) => k === cur)) out.push([cur, `${W.axisLabel(cur)} axis`]);
  return out;
};
// A value negated (a number, or an expression: −(…), which undoes itself)
const negExpr = (e) => {
  if (typeof e === 'number') return e ? -e : 0;
  const t = String(e ?? '').trim();
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) { const v = -Number(t); return String(v || 0); }
  const m = /^-\((.*)\)$/.exec(t);
  return m ? m[1] : `-(${t})`;
};
const ENDS_REF = [...ENDS, ['upToVertex', 'Up To Vertex'], ['upToSurface', 'Up To Surface'], ['offsetSurface', 'Offset From Surface']];
const isSurfEnd = (f) => f.end === 'upToSurface' || f.end === 'offsetSurface';
// An extrusion's second side: offered with a one-sided end condition
const hasSide2 = (f) => ['blind', 'through', 'upToVertex', 'upToSurface', 'offsetSurface'].includes(f.end || 'blind');
const side2On = (f) => !!f.side2 && hasSide2(f);
// ... and a draft of its own for it (or for Two sides' second depth)
const hasDraft2 = (f) => side2On(f) || f.end === 'twoSides';
// The picked model face or vertex a reference field stands for, and the pick slot it fills
const REF_PICKED = { startPlane: 'startFace', toPlane: 'toFace', toPlane2: 'toFace2', toPoint: 'toVertex', toPoint2: 'toVertex2' };
const REF_SLOT = { startPlane: 'start', toPlane: 'end', toPoint: 'end', toPlane2: 'end2', toPoint2: 'end2' };

// Cuts act on every body they reach unless the scope is limited to chosen bodies.
const SCOPE_GROUP = [{
  title: 'Feature Scope', fields: [
    { key: 'scopeAll', type: 'check', default: true, label: 'All bodies', show: (f) => f.op === 'cut' || f.op === 'intersect' },
    { key: 'scope', type: 'bodyList', kinds: ['solid'], show: (f) => (f.op === 'cut' || f.op === 'intersect') && f.scopeAll === false, hint: 'The cut or intersect only affects these bodies (an intersect removes a chosen body it does not overlap). Click bodies on the model or tick them here.' },
  ],
}];

// Standard planes (front/top/right) a feature refers to, for the reference arrows.
function stdPlaneRefs(f) {
  const out = new Set();
  const add = (v) => { if (typeof v === 'string' && STD_PLANES[v]) out.add(v); };
  add(f.plane?.ref); if (typeof f.plane === 'string') add(f.plane);
  for (const k of ['planeA', 'planeB', 'toPlane', 'toPlane2', 'startPlane', 'tool']) add(f[k]);
  for (const r of f.refs || []) if (r?.kind === 'plane') add(r.id);
  for (const m of f.mates || []) { if (m.a?.kind === 'plane') add(m.a.id); if (m.b?.kind === 'plane') add(m.b.id); }
  return [...out];
}

// Thin-feature directions read differently for closed profiles and open curves.
function thinDirOptions(f) {
  const ref = f.sketch || f.profile || f.profiles?.[0];
  let sk = window.app?.doc && findFeature(window.app.doc, LR.sourceId(ref));
  if (sk && ref?.kind === 'sketchContour') { try { sk = LR.contourSketch(sk, ref); } catch { /* invalid reference is reported by the feature */ } }
  return SM.isOpenSketch(sk)
    ? [['one', 'One side'], ['other', 'Other side'], ['mid', 'Mid-plane (half each side)']]
    : [['one', 'Outside the profile'], ['other', 'Inside the profile'], ['mid', 'Mid-plane (half each side)']];
}

const LOFT_END_GROUPS = ['start', 'end'].map((key) => ({
  title: key === 'start' ? 'Start Condition' : 'End Condition', fields: [
    { key: key + 'Condition', type: 'select', label: 'Constraint', options: [['none', 'Free'], ['normal', 'Normal to profile'], ['direction', 'Direction'], ['tangent', 'Tangent to adjacent faces (G1)'], ['curvature', 'Curvature to adjacent faces (G2)']] },
    { key: key + 'Direction', type: 'direction', label: 'Direction', show: (f) => f[key + 'Condition'] === 'direction' },
    { key: key + 'Faces', type: 'faceList', loftEnd: key, show: (f) => ['tangent', 'curvature'].includes(f[key + 'Condition']), hint: 'Select the adjacent side faces whose boundary coincides with this profile. Select all faces needed to cover its outer and inner edges, including Thin walls.' },
    { key: key + 'Strength', type: 'expr', default: 1, label: 'Influence', show: (f) => f[key + 'Condition'] && f[key + 'Condition'] !== 'none' },
    { key: key + 'Reverse', type: 'check', label: 'Reverse tangent direction', show: (f) => f[key + 'Condition'] && f[key + 'Condition'] !== 'none' },
    { key: key + 'Hint', type: 'hint', show: (f) => f[key + 'Condition'] && f[key + 'Condition'] !== 'none', text: 'Smooth loft with matching profile curves. Holes and Thin include their inner walls. Guides require Adaptive approximation and compatible endpoint tangents. Influence controls the endpoint derivative length (1 is the default). Contact and tangent planes are checked on the final CAD faces to 0.0001 mm and 0.5 degrees. G2 also checks all three curvature components against the adjacent faces to 0.001 1/mm. Interior profiles use C2 interpolation.' },
  ],
}));

const REVOLUTION_AXIS = {title:'Axis of Revolution',fields:[
  {key:'axis',type:'axis',label:'Axis'},
  {key:'axisPick',type:'axisPick'},
  {key:'projectAxis',type:'check',label:'Project axis into profile plane'},
]};
// (a revolve up to a vertex or a surface: kernel.worker.js revolveExtent)
const revUpTo=f=>['upToVertex','upToSurface'].includes(f.extent),revAngle=f=>f.extent!=='full'&&!revUpTo(f);
const REVOLUTION_DIRECTIONS = {title:'Revolution',fields:[
  {key:'extent',type:'select',label:'Extent',options:[['full','Full (360°)'],['angle','Angle'],['upToVertex','Up To Vertex'],['upToSurface','Up To Surface']]},
  {key:'end',type:'select',label:'Direction',show:revAngle,options:[['oneway','One side'],['twoSides','Two sides'],['midplane','Symmetric']]},
  {key:'angle',type:'expr',label:'Angle',unit:'°',show:revAngle},
  {key:'angle2',type:'expr',label:'Second angle',unit:'°',default:0,show:f=>revAngle(f)&&f.end==='twoSides'},
  {key:'toPoint',type:'pointRef',label:'Vertex',show:f=>f.extent==='upToVertex'},
  {key:'toPlane',type:'surfaceRef',label:'Surface',show:f=>f.extent==='upToSurface'},
  {key:'reverse',type:'check',label:'Reverse direction',show:f=>revUpTo(f)||revAngle(f)&&f.end!=='midplane'},
]};
// (a sweep's orientation, its twist and the profile's scale along the path: kernel.worker.js sweepOptions)
const twisted = (f) => !f.guide && (f.orientation || 'perpendicular') === 'perpendicular';
const SWEEP_SHAPE = [
  { key: 'orientation', type: 'select', label: 'Orientation', show: (f) => !f.guide, options: [['perpendicular', 'Perpendicular to path'], ['parallel', 'Parallel to initial profile'], ['surface', 'Square to faces it runs on']] },
  { key: 'supportFaces', type: 'faceList', sweepSupport: true, show: (f) => !f.guide && f.orientation === 'surface', hint: 'Select the faces the path runs on: the profile keeps square to them all along it (its plane through their normal).' },
  { key: 'twistAngle', type: 'expr', default: 0, label: 'Twist angle', unit: '°', show: twisted },
  { key: 'twistLaw', type: 'select', label: 'Twist', default: 'linear', show: (f) => twisted(f) && !!f.twistAngle && String(f.twistAngle).trim() !== '0', options: [['linear', 'Evenly along the path'], ['smooth', 'Eased in and out']] },
  { key: 'twistHint', type: 'hint', show: twisted, text: 'Total rotation distributed by distance along the path (evenly, or slowly at both ends). Positive angles follow the right-hand rule along the path. Twist requires an open, tangent-continuous path; zero keeps the usual sweep.' },
  { key: 'scaleEnd', type: 'expr', default: 1, label: 'End scale', unit: '×', show: (f) => !f.guide },
  { key: 'scaleLaw', type: 'select', label: 'Scale', default: 'linear', show: (f) => !f.guide && f.scaleEnd != null && String(f.scaleEnd).trim() !== '1', options: [['linear', 'Evenly along the path'], ['smooth', 'Eased in and out']] },
  { key: 'scaleHint', type: 'hint', show: (f) => !f.guide && f.scaleEnd != null && String(f.scaleEnd).trim() !== '1', text: 'The profile grows or shrinks about the path, by the length along it, from its own size at the start to End scale times it at the end.' },
];
const SWEEP_EDGES = { title: 'Path from Model Edges', fields: [{ key: 'edges', type: 'edges' }] };
const THIN_GROUP = {
  title: 'Thin Feature', fields: [
    { key: 'thin', type: 'check', label: 'Thin feature (a wall along the sketch curves)' },
    { key: 'thinT', type: 'expr', label: 'Thickness', unit: 'mm', show: (f) => f.thin },
    { key: 'thinDir', type: 'select', label: 'Direction', options: (f) => thinDirOptions(f), show: (f) => f.thin },
  ],
};

// Gauge tables: common sheet thicknesses with a typical inside bend radius and K-factor (air bending; a
// starting point — check them against your press brake tooling). Your own entries are kept in prefs.gauges.
const GAUGE_TABLES = (() => {
  const rows = [];
  const add = (mat, list, rOf, K) => { for (const [name, t] of list) rows.push({ mat, name: `${mat} ${name}`, t, R: +rOf(t).toFixed(3), K }); };
  add('Mild steel', [0.8, 1, 1.2, 1.5, 1.6, 2, 2.5, 3, 4, 5, 6, 8, 10].map((t) => [`${t} mm`, t]), (t) => (t <= 6 ? t : 1.5 * t), 0.42);
  add('Steel gauge', [['22 ga', 0.759], ['20 ga', 0.912], ['18 ga', 1.214], ['16 ga', 1.519], ['14 ga', 1.897], ['12 ga', 2.657], ['11 ga', 3.038], ['10 ga', 3.416]], (t) => t, 0.42);
  add('Stainless 304', [0.9, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6].map((t) => [`${t} mm`, t]), (t) => (t <= 3 ? t : 1.5 * t), 0.45);
  add('Aluminium 5052', [1, 1.2, 1.6, 2, 2.5, 3, 4, 5, 6].map((t) => [`${t} mm`, t]), (t) => t, 0.43);
  add('Aluminium 6061-T6', [1.6, 2, 3, 4, 5, 6].map((t) => [`${t} mm`, t]), (t) => 2.5 * t, 0.45);
  return rows;
})();
const SM_GAUGE = { key: 'gauge', type: 'gauge' };

const SM_BODY = { title: 'Sheet Metal Body', fields: [{ key: 'body', type: 'bodySel', label: 'Body', kinds: ['sheet'] }] };
// What a pattern copies: its feature and more features; model: 'pick' (faces or bodies clicked on the model, or
// ticked), 'list' (bodies ticked in the list or clicked), 'none' (features only)
// Instances to leave out of a pattern, by number (1 is the feature)
const PATTERN_SKIP_GROUP = (two) => ({ title: 'Instances to Skip', fields: [
  { key: 'skip', type: 'text', label: 'Skip', placeholder: '3, 5', optional: true },
  { key: 'skHint', type: 'hint', text: (f) => (two(f) ? 'Instance numbers to leave out, as row.column: 3.2 is the 3rd along the first direction (or round), 2nd along the second (or ring); 1 is the feature, -2 the first the other way.' : 'Instance numbers to leave out, separated by commas: 1 is the feature, 2 the first copy, -2 the first the other way.') },
] });
const patternSources = (title, model = 'pick') => ({ title, fields: [
  { key: 'feature', type: 'feature', label: 'Feature' },
  { key: 'features', type: 'featureList', label: 'More features' },
  ...(model === 'pick' ? [
    { key: 'pick', type: 'select', label: 'Clicking the model picks', options: [['faces', 'Faces (each brings the feature that made it)'], ['bodies', 'Bodies (copied whole)']] },
    { key: 'faces', type: 'faceList', show: (f) => f.pick !== 'bodies', hint: 'Click faces of the features to pattern (a hole\'s wall, a boss\'s top…): each brings the feature that made it.', empty: 'No faces picked' },
  ] : []),
  ...(model !== 'none' ? [{ key: 'bodies', type: 'bodyList', kinds: ['solid', 'surface'], show: (f) => model === 'list' || f.pick === 'bodies', hint: 'Bodies copied whole to every place, as new bodies. Click them on the model or tick them here.' }] : []),
] });
// (how a bend's flat length is worked out: kernel.worker.js sheetKFactor)
const SM_BEND_CALC = [
  { key: 'bendCalc', type: 'select', label: 'Bend calculation', default: 'k', options: [['k', 'K-factor'], ['ba', 'Bend allowance (90° bend)'], ['bd', 'Bend deduction (90° bend)'], ['table', 'Bend table (by angle)']] },
  { key: 'bendTable', type: 'text', label: 'Allowances', placeholder: '30: 1.5; 45: 2.0; 90: 4.2', show: (f) => f.bendCalc === 'table' },
  { key: 'btHint', type: 'hint', show: (f) => f.bendCalc === 'table', text: 'The bend allowance (mm) for each angle (°), from your bend table for this thickness and the default radius, separated by semicolons. Angles between rows are interpolated, angles past the ends in proportion; bends of another radius use the K-factor the 90° allowance gives.' },
  { key: 'kFactor', type: 'expr', label: 'K-factor', unit: '', show: (f) => (f.bendCalc || 'k') === 'k' },
  { key: 'bendAllowance', type: 'expr', label: 'Bend allowance', unit: 'mm', default: 4.2, show: (f) => f.bendCalc === 'ba' },
  { key: 'bendDeduction', type: 'expr', label: 'Bend deduction', unit: 'mm', default: 3.8, show: (f) => f.bendCalc === 'bd' },
  { key: 'bcHint', type: 'hint', show: (f) => ['ba', 'bd'].includes(f.bendCalc), text: 'For a 90° bend at this radius and thickness (from your bend table): the length the bend takes flat (allowance), or how much shorter the flat is than the two outside lengths to the sharp (deduction). Other angles follow in proportion.' },
];
const SM_PARAMS = [
  { key: 'radius', type: 'expr', label: 'Bend radius (inside)', unit: 'mm' },
  ...SM_BEND_CALC,
  { key: 'kHint', type: 'hint', text: 'The K-factor is where the neutral (unstretched) layer lies in the thickness: 0.5 is the middle. It sets how much material a bend takes when flattened; 0.3–0.45 is typical for steel bent on a press brake.' },
];

// Convert to Sheet Metal: what the kernel found in the picked body (thickness, bend radii, sharp edges)
const convertDet = (f, a) => (f.face ? a?.result?.detected?.get(f.id) || null : null);
const convertMM = (x) => `${+(+x).toFixed(3)} mm`;
function convertFound(f, a) {
  if (!f.face) return 'Click a flat face: the thickness and bend radii are read from the body.';
  const d = convertDet(f, a);
  if (!d) return 'Reading the body…';
  if (d.kind === 'surface' && d.curved) {
    const r = d.bends ? ` with ${d.bends} bend${d.bends === 1 ? '' : 's'} (inside R${+d.rMin.toFixed(2)}${d.rMax - d.rMin > 0.005 ? `–R${+d.rMax.toFixed(2)}` : ''})` : '';
    const tr = d.trimmed?.at ? ` Trimmed back ${+d.trimmed.length.toFixed(2)} mm at its ${d.trimmed.at}, where it would run into itself.` : d.trimmed?.overlaps ? ' ⚠ The sheet runs into itself.' : '';
    return `A curved surface: it is rolled from a flat sheet${r}, following the surface to within ${d.tol ?? 0.05} mm.${tr} Set the thickness, and which side of the surface it goes, below.`;
  }
  if (d.kind === 'surface') return 'A surface has no thickness of its own: set it below. Every edge where two flat faces meet becomes a bend.';
  const radii = d.radii.length ? `bend radi${d.radii.length > 1 ? 'i' : 'us'} ${d.radii.map((r) => 'R' + +r.toFixed(3)).join(', ')} (inside, ${d.bends} bend${d.bends === 1 ? '' : 's'})` : 'no formed bends';
  const sharp = d.sharp ? ` · ${d.sharp} sharp edge${d.sharp === 1 ? '' : 's'} (bent at the radius below)` : '';
  if (d.developed) return `Found in the body: thickness ${convertMM(d.t)} · ${d.developed} curved face${d.developed === 1 ? '' : 's'} other than plain bends: the sheet is unrolled flat at the neutral layer (the K-factor below sets where that is).`;
  return `Found in the body: thickness ${convertMM(d.t)} · ${radii}${sharp}.`;
}

// Sheet metal extrude: is the profile a lone circle (rolled)?
const smCircle = (f, a) => { const sk = a?.doc?.features.find((x) => x.id === f.sketch); const cs = (sk?.curves || []).filter((c) => !c.construction); return cs.length === 1 && cs[0].type === 'circle'; };
// Transition ends (k: 'b' bottom, 't' top)
const trRound = (f) => f.bShape === 'round' && f.tShape === 'round';
const TR_SHAPES = [['round', 'Round'], ['square', 'Square'], ['rect', 'Rectangle'], ['tri', 'Triangle'], ['pent', 'Pentagon'], ['hex', 'Hexagon']];
const TR_BASIS = { side: 'Side length', flats: 'Across flats (inscribed Ø)', corners: 'Across corners (circumscribed Ø)' };
const trEnd = (k, title) => ({ title, fields: [
  { key: k + 'Shape', type: 'select', label: 'Shape', options: TR_SHAPES },
  { key: k + 'D', type: 'expr', label: 'Diameter', unit: 'mm', show: (f) => f[k + 'Shape'] === 'round' },
  { key: k + 'Basis', type: 'select', label: 'Size measured', options: Object.entries(TR_BASIS), show: (f) => ['tri', 'pent', 'hex'].includes(f[k + 'Shape']) },
  { key: k + 'Size', type: 'expr', label: (f) => (f[k + 'Shape'] === 'square' ? 'Side' : TR_BASIS[f[k + 'Basis'] || 'side']), unit: 'mm', show: (f) => ['square', 'tri', 'pent', 'hex'].includes(f[k + 'Shape']) },
  { key: k + 'W', type: 'expr', label: 'Width (X)', unit: 'mm', show: (f) => f[k + 'Shape'] === 'rect' },
  { key: k + 'L', type: 'expr', label: 'Depth (Y)', unit: 'mm', show: (f) => f[k + 'Shape'] === 'rect' },
] });

const PM_SCHEMAS = {
  smBase: [
    { title: 'Profile', fields: [{ key: 'sketch', type: 'sketch', label: 'Sketch (closed)' }] },
    {
      title: 'Sheet Metal Parameters', fields: [
        SM_GAUGE,
        { key: 'thickness', type: 'expr', label: 'Thickness', unit: 'mm' },
        { key: 'reverse', type: 'check', label: 'Reverse direction (material on the other side)' },
        ...SM_PARAMS,
      ],
    },
  ],
  smLoft: [
    { title: 'Profiles', fields: [
      { key: 'profileA', type: 'sketch', label: 'First profile (open)' },
      { key: 'profileB', type: 'sketch', label: 'Second profile (open)' },
      { key: 'lHint', type: 'hint', text: 'Two sketches, each one open chain of lines and arcs (e.g. on parallel planes: a transition, hopper or duct piece). Points are matched along both by length, corners kept.' },
    ] },
    { title: 'Manufacturing Method', fields: [
      { key: 'method', type: 'select', label: 'Method', options: [['bent', 'Bent (flat facets, press-brake bends)'], ['formed', 'Formed (smooth, rolled / pressed)']] },
      { key: 'bends', type: 'expr', label: (f) => (f.method === 'formed' ? 'Forming lines along the profiles' : 'Divisions along the profiles'), unit: '', hint: (f) => (f.method === 'formed' ? 'The curved stretches get this many forming lines in the flat pattern and DXF (corners of the profiles are lines of their own).' : 'Each division is two flat facets (corners of the profiles add more): more divisions, smaller folds.') },
      { key: 'radius', type: 'expr', label: 'Bend radius (for the line notes)', unit: 'mm' },
      { key: 'mHint', type: 'hint', text: (f) => (f.method === 'formed' ? 'The smooth surface between the profiles is thickened; the flat pattern is developed from it (triangulation at the neutral layer).' : 'The sheet is made of flat facets folded along straight lines: each fold is a bend line (with its angle, up or down) in the flat pattern and DXF.') },
    ] },
    {
      title: 'Sheet Metal Parameters', fields: [
        { key: 'thickness', type: 'expr', label: 'Thickness', unit: 'mm' },
        { key: 'flip', type: 'check', label: 'Material on the other side' },
        ...SM_BEND_CALC,
      ],
    },
  ],
  smEtch: [
    { title: 'Etch Lines', fields: [
      { key: 'sketch', type: 'sketch', label: 'Sketch (lines or text on a face)' },
      { key: 'eHint', type: 'hint', text: 'Draw lines, arcs, circles, splines or text on the top or bottom face of a flat part of the sheet. They are marked in the flat pattern and exported on the DXF\'s ETCH layer (for etching, scribing or marking part numbers); the folded part is not changed.' },
    ] },
  ],
  smSketchBend: [
    { title: 'Bend Lines', fields: [
      { key: 'sketch', type: 'sketch', label: 'Sketch (lines on a face)' },
      { key: 'bHint', type: 'hint', text: 'Draw straight lines on the top or bottom face of a flat part of the sheet: the sheet is bent along each one, right across that face. The flat pattern stays the plate it is.' },
    ] },
    { title: 'Bend', fields: [
      { key: 'angle', type: 'expr', label: 'Angle', unit: '°' },
      { key: 'position', type: 'select', label: 'Bend position', options: [['center', 'Bend centred on the line'], ['start', 'Bend starts at the line'], ['end', 'Bend ends at the line']] },
      { key: 'flip', type: 'check', label: 'Fold the other way (away from the sketch face)' },
      { key: 'swapFixed', type: 'check', label: 'Keep the other side fixed' },
      { key: 'useDefaultRadius', type: 'check', default: true, label: 'Use the part\'s bend radius' },
      { key: 'radius', type: 'expr', label: 'Bend radius (inside)', unit: 'mm', show: (f) => f.useDefaultRadius === false },
    ] },
  ],
  smProfileFlange: [
    { title: 'Edges', fields: [{ key: 'edges', type: 'edges' }, { key: 'eHint', type: 'hint', text: 'Click a chain of straight edges on the top or bottom face of the sheet: the profile runs along all of them, mitred where they meet.' }] },
    { title: 'Profile', fields: [
      { key: 'segments', type: 'select', label: 'Segments', options: [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']] },
      { key: 'len1', type: 'expr', label: 'Segment 1 length', unit: 'mm', show: (f) => (+f.segments || 1) >= 1 },
      { key: 'ang1', type: 'expr', label: 'Segment 1 angle', unit: '°', show: (f) => (+f.segments || 1) >= 1 },
      { key: 'len2', type: 'expr', label: 'Segment 2 length', unit: 'mm', show: (f) => (+f.segments || 1) >= 2 },
      { key: 'ang2', type: 'expr', label: 'Segment 2 angle (− : back the other way)', unit: '°', show: (f) => (+f.segments || 1) >= 2 },
      { key: 'len3', type: 'expr', label: 'Segment 3 length', unit: 'mm', show: (f) => (+f.segments || 1) >= 3 },
      { key: 'ang3', type: 'expr', label: 'Segment 3 angle (− : back the other way)', unit: '°', show: (f) => (+f.segments || 1) >= 3 },
      { key: 'len4', type: 'expr', label: 'Segment 4 length', unit: 'mm', show: (f) => (+f.segments || 1) >= 4 },
      { key: 'ang4', type: 'expr', label: 'Segment 4 angle (− : back the other way)', unit: '°', show: (f) => (+f.segments || 1) >= 4 },
      { key: 'pHint', type: 'hint', text: 'Each segment is a flange on the end of the one before (lengths to the outside of the bend). A negative angle folds back the other way: 90 then 90 makes a C, 90 then −90 a Z.' },
    ] },
    { title: 'Position', fields: [
      { key: 'position', type: 'select', label: 'First bend', options: [['inside', 'Material inside (outer face on the edge)'], ['outside', 'Material outside (inner face on the edge)'], ['bend', 'Bend outside (the bend starts at the edge)']] },
      { key: 'flip', type: 'check', label: 'Flip direction' },
      { key: 'useDefaultRadius', type: 'check', default: true, label: 'Use the part\'s bend radius' },
      { key: 'radius', type: 'expr', label: 'Bend radius (inside)', unit: 'mm', show: (f) => f.useDefaultRadius === false },
    ] },
    { title: 'Corners', fields: [
      { key: 'corner', type: 'select', label: 'Where the edges meet', options: [['closed', 'Mitred (closed, with the gap)'], ['open', 'Open']] },
      { key: 'cornerGap', type: 'expr', label: 'Gap', unit: 'mm', show: (f) => f.corner !== 'open' },
      { key: 'reliefType', type: 'select', label: 'Relief', options: [['rect', 'Rectangular'], ['obround', 'Obround'], ['tear', 'Tear']] },
    ] },
  ],
  smForm: [
    { title: 'Form', fields: [
      { key: 'formType', type: 'select', label: 'Type', options: [['dimple', 'Dimple'], ['louver', 'Louver'], ['exthole', 'Extruded (flanged) hole'], ['bead', 'Bead (stiffening rib)'], ['lance', 'Lance (bridge)'], ['emboss', 'Emboss (raised outline)']] },
      { key: 'diameter', type: 'expr', label: 'Diameter', unit: 'mm', show: (f) => f.formType === 'dimple' },
      { key: 'depth', type: 'expr', label: 'Depth', unit: 'mm', show: (f) => f.formType === 'dimple' },
      { key: 'width', type: 'expr', label: (f) => (f.formType === 'bead' ? 'Width' : 'Width (back from the slit)'), unit: 'mm', show: (f) => ['louver', 'lance', 'bead'].includes(f.formType) },
      { key: 'height', type: 'expr', label: (f) => (f.formType === 'louver' ? 'Height (opening)' : 'Height'), unit: 'mm', show: (f) => ['louver', 'lance', 'bead', 'emboss'].includes(f.formType) },
      { key: 'side', type: 'check', label: (f) => (f.formType === 'lance' ? 'On the other side of the line' : 'Hood on the other side of the line'), show: (f) => f.formType === 'louver' || f.formType === 'lance' },
      { key: 'holeDiameter', type: 'expr', label: 'Hole diameter (inside the collar)', unit: 'mm', show: (f) => f.formType === 'exthole' },
      { key: 'collarHeight', type: 'expr', label: 'Collar height (overall)', unit: 'mm', show: (f) => f.formType === 'exthole' },
      { key: 'useDefaultRadius', type: 'check', default: true, label: 'Use the part\'s bend radius', show: (f) => f.formType === 'exthole' },
      { key: 'radius', type: 'expr', label: 'Bend radius (inside)', unit: 'mm', show: (f) => f.formType === 'exthole' && f.useDefaultRadius === false },
      { key: 'flip', type: 'check', label: 'Pressed the other way' },
    ] },
    { title: 'Placement', fields: [
      { key: 'sketch', type: 'sketch', label: (f) => (f.formType === 'louver' || f.formType === 'lance' ? 'Sketch (lines: the slits)' : f.formType === 'bead' ? 'Sketch (lines: the beads)' : f.formType === 'emboss' ? 'Sketch (closed outlines)' : 'Sketch (points / circle centres)') },
      { key: 'faces', type: 'faceList', show: (f) => !['louver', 'lance', 'bead', 'emboss'].includes(f.formType), hint: 'Click points on a flat face of the sheet (or use a sketch on the face for exact places).', itemLabel: 'Point' },
      { key: 'plHint', type: 'hint', text: (f) => (f.formType === 'louver' ? 'Draw a line on a flat face for each louver: the line is the slit (its length is the louver\'s), the hood rises behind it.' : 'Each point on a flat face gets one. The flat pattern gets a centre mark and a note' + (f.formType === 'exthole' ? ', and the pre-hole (the collar laid flat).' : '.')) },
    ] },
  ],
  smGusset: [
    { title: 'Bends', fields: [{ key: 'faces', type: 'faceList', hint: 'Click a bend (its round face) where each gusset goes, along the bend.', itemLabel: 'Gusset' }] },
    { title: 'Gusset', fields: [
      { key: 'size', type: 'expr', label: 'Size (each leg, from the inside corner)', unit: 'mm' },
      { key: 'width', type: 'expr', label: 'Width (across the bend)', unit: 'mm' },
      { key: 'gHint', type: 'hint', text: 'A stiffening dart pressed across the bend. The flat pattern marks where it goes.' },
    ] },
  ],
  smTabSlot: [
    { title: 'Parts', fields: [
      { key: 'edge', type: 'pick', label: 'Tab edge', what: 'edge' },
      { key: 'face', type: 'pick', label: 'Slot face', what: 'flatface' },
      { key: 'pHint', type: 'hint', text: 'Click the edge of the part that gets the tabs, where it sits on the other part (an edge of its top or bottom face), then the face of the other part that gets the slots. Both flat patterns get them.' },
    ] },
    { title: 'Tabs', fields: [
      { key: 'count', type: 'expr', label: 'Number of tabs', unit: '' },
      { key: 'length', type: 'expr', label: 'Tab length', unit: 'mm' },
      { key: 'height', type: 'expr', label: 'Tab height (empty: through the other part)', unit: 'mm', optional: true },
      { key: 'margin', type: 'expr', label: 'Margin at each end (empty: evenly spread)', unit: 'mm', optional: true },
    ] },
    { title: 'Slots', fields: [
      { key: 'clearance', type: 'expr', label: 'Clearance (all round)', unit: 'mm' },
    ] },
  ],
  smCrossBreak: [
    { title: 'Faces', fields: [{ key: 'faces', type: 'faceList', hint: 'Click flat faces of the sheet: each gets an X of shallow folds, corner to corner, that stiffens the panel.' }] },
    { title: 'Direction', fields: [
      { key: 'flip', type: 'check', label: 'Pressed down (the other way)' },
      { key: 'cHint', type: 'hint', text: 'Cross breaks are marked in the flat pattern, Flatten and the DXF (Forming marks layer, with a note); the folds are only a few degrees, so the model is not changed.' },
    ] },
  ],
  smJog: [
    { title: 'Jog Line', fields: [
      { key: 'sketch', type: 'sketch', label: 'Sketch (one line on a face)' },
      { key: 'jHint', type: 'hint', text: 'Draw one straight line on the top or bottom face of a flat part of the sheet. Two opposite bends step the sheet over by the height; the first bend is at the line.' },
    ] },
    { title: 'Jog', fields: [
      { key: 'height', type: 'expr', label: 'Height', unit: 'mm' },
      { key: 'heightRef', type: 'select', label: 'Measured', options: [['face', 'Face to face (the step of one face)'], ['overall', 'Overall (outside to outside)'], ['inside', 'Inside (inside to inside)']] },
      { key: 'angle', type: 'expr', label: 'Angle', unit: '°' },
      { key: 'position', type: 'select', label: 'First bend', options: [['start', 'Starts at the line'], ['center', 'Centred on the line'], ['end', 'Ends at the line']] },
      { key: 'flip', type: 'check', label: 'Jog the other way' },
      { key: 'swapFixed', type: 'check', label: 'Keep the other side fixed' },
      { key: 'useDefaultRadius', type: 'check', default: true, label: 'Use the part\'s bend radius' },
      { key: 'radius', type: 'expr', label: 'Bend radius (inside)', unit: 'mm', show: (f) => f.useDefaultRadius === false },
    ] },
  ],
  smExtrude: [
    { title: 'Profile', fields: [
      { key: 'sketch', type: 'sketch', label: 'Sketch (open, or a circle)' },
      { key: 'pHint', type: 'hint', text: 'One chain of lines and arcs joined end to end. Arcs you draw are bends of their own radius; sharp corners get a bend of the radius below. A circle on its own is rolled into a cylinder, leaving the seam gap.' },
    ] },
    { title: 'Extrude', fields: [
      { key: 'depth', type: 'expr', label: 'Depth', unit: 'mm' },
      { key: 'direction', type: 'select', label: 'Direction', options: [['one', 'One direction'], ['reverse', 'Reverse direction'], ['mid', 'Mid-plane (half each way)']] },
    ] },
    { title: 'Sheet Metal Parameters', fields: [
      SM_GAUGE,
      { key: 'thickness', type: 'expr', label: 'Thickness', unit: 'mm' },
      { key: 'side', type: 'select', label: 'Material', options: (f, a) => (smCircle(f, a) ? [['one', 'Inside the circle'], ['other', 'Outside the circle'], ['mid', 'Both sides (the circle in the middle)']] : [['one', 'One side of the sketch'], ['other', 'Other side of the sketch'], ['mid', 'Both sides (the sketch in the middle)']]) },
      { key: 'radius', type: 'expr', label: 'Bend radius (inside, at sharp corners)', unit: 'mm', show: (f, a) => !smCircle(f, a) },
      { key: 'seamGap', type: 'expr', label: 'Seam gap', unit: 'mm', show: (f, a) => smCircle(f, a) },
      ...SM_BEND_CALC,
    ] },
  ],
  smTransition: [
    { title: 'Axis', fields: [
      { key: 'sketch', type: 'sketch', label: 'Sketch (one line)' },
      { key: 'reverse', type: 'check', label: 'Swap the bottom and top ends' },
      { key: 'aHint', type: 'hint', text: 'The line runs from the bottom centre to the top centre: its length is the height and it places the part. Change the line (or its dimension) to change the height.' },
    ] },
    trEnd('b', 'Bottom End'),
    trEnd('t', 'Top End'),
    { title: 'Position', fields: [
      { key: 'offX', type: 'expr', label: 'Top offset across (X)', unit: 'mm' },
      { key: 'offY', type: 'expr', label: 'Top offset out of the sketch (Y)', unit: 'mm' },
      { key: 'rotation', type: 'expr', label: 'Rotation about the axis', unit: '°' },
      { key: 'pHint', type: 'hint', text: 'X lies in the sketch plane, square to the line; Y is out of the sketch plane. Offset the top for an eccentric reducer or an offset transition.' },
    ] },
    { title: 'Parts', fields: [
      { key: 'parts', type: 'expr', label: 'Number of equal parts', unit: '' },
      { key: 'seamAt', type: 'select', label: 'Seams at', options: [['mid', 'The middle of the flat sides'], ['corner', 'The corners']], show: (f) => !trRound(f) },
      { key: 'seamShift', type: 'check', label: 'Move the seams on by one side', show: (f) => !trRound(f) },
      { key: 'seamAngle', type: 'expr', label: 'First seam at (from X)', unit: '°', show: (f) => trRound(f) },
      { key: 'seamGap', type: 'expr', label: 'Gap at each seam', unit: 'mm', show: (f) => trRound(f) },
      { key: 'sHint', type: 'hint', text: (f) => (trRound(f) ? 'A cone can be rolled from one part, or from two or more equal parts welded together.' : 'With a flat-sided end the transition is made from two or more equal parts welded together; the number of parts must divide its number of sides (a square: 2 or 4).') },
    ] },
    { title: 'Manufacturing Method', fields: [
      { key: 'method', type: 'select', label: 'Method', options: [['formed', 'Formed (rolled smooth)'], ['bent', 'Bent (bump formed: press-brake bends)']] },
      { key: 'divs', type: 'expr', label: (f) => (f.method === 'bent' ? 'Bends per corner' : 'Forming lines per corner'), unit: '', show: (f) => !trRound(f) },
      { key: 'divsRound', type: 'expr', label: (f) => (f.method === 'bent' ? 'Bends round the whole part' : 'Forming lines round the whole part'), unit: '', show: (f) => trRound(f) },
      { key: 'radius', type: 'expr', label: 'Bend radius (for the line notes)', unit: 'mm' },
      { key: 'mHint', type: 'hint', text: (f) => (f.method === 'bent' ? 'Each part has its own flat pattern, developed by triangulation at the neutral layer; every bend is a bend line (angle, up / down) in the flat pattern and DXF.' : 'Each part has its own flat pattern, developed by triangulation at the neutral layer. The curved corners (cones) get forming lines in the flat pattern and DXF, each with the angle to form along it (for rolling or bump forming).') },
    ] },
    { title: 'Sheet Metal Parameters', fields: [
      SM_GAUGE,
      { key: 'thickness', type: 'expr', label: 'Thickness', unit: 'mm' },
      { key: 'dims', type: 'select', label: 'Sizes are', options: [['inside', 'Inside sizes (material outward)'], ['outside', 'Outside sizes (material inward)'], ['mean', 'Mean (middle of the thickness)']] },
      ...SM_BEND_CALC,
    ] },
  ],
  smHem: [
    { title: 'Hem Edges', fields: [{ key: 'edges', type: 'edges' }, { key: 'hHint', type: 'hint', text: 'Click straight edges on the top or bottom face of the sheet. The hem folds back over the face the edge belongs to (Flip direction for the other face).' }] },
    { title: 'Hem', fields: [
      { key: 'hemType', type: 'select', label: 'Type', options: [['closed', 'Closed (pressed flat)'], ['open', 'Open (with a gap)'], ['teardrop', 'Teardrop'], ['rolled', 'Rolled (curl)']] },
      { key: 'length', type: 'expr', label: 'Length (from the outside of the fold)', unit: 'mm', show: (f) => f.hemType !== 'rolled' && f.hemType !== 'teardrop' },
      { key: 'gap', type: 'expr', label: 'Gap between the layers', unit: 'mm', show: (f) => f.hemType === 'open' },
      { key: 'radius', type: 'expr', label: 'Inside radius', unit: 'mm', show: (f) => f.hemType === 'teardrop' || f.hemType === 'rolled' },
      { key: 'tearAngle', type: 'expr', label: 'Angle (181°–269°)', unit: '°', show: (f) => f.hemType === 'teardrop' },
      { key: 'angle', type: 'expr', label: 'Angle (90°–340°)', unit: '°', show: (f) => f.hemType === 'rolled' },
      { key: 'position', type: 'select', label: 'Position', options: [['inside', 'Inside (the fold at the edge)'], ['outside', 'Outside (added beyond the edge)']] },
      { key: 'flip', type: 'check', label: 'Flip direction' },
      { key: 'tHint', type: 'hint', text: (f) => ({ closed: 'Folded right back and pressed flat onto the sheet.', open: 'Folded right back, leaving the gap between the two layers.', teardrop: 'Bent past 180° at the radius; the leg runs back until it touches the sheet.', rolled: 'A curl at the radius, with no straight leg.' })[f.hemType || 'closed'] },
    ] },
    { title: 'Auto Relief', fields: [
      { key: 'reliefType', type: 'select', label: 'Type', options: [['rect', 'Rectangular'], ['obround', 'Obround'], ['tear', 'Tear']] },
      { key: 'reliefRatio', type: 'expr', label: 'Width (× thickness)', unit: '', show: (f) => f.reliefType !== 'tear' },
    ] },
  ],
  smFlange: [
    { title: 'Flange Edges', fields: [{ key: 'edges', type: 'edges' }, { key: 'fHint', type: 'hint', text: 'Click straight edges on the top or bottom face of the sheet. The flange rises on the side of the face the edge belongs to (Flip direction to reverse).' }] },
    {
      title: 'Flange Length', fields: [
        { key: 'length', type: 'expr', label: 'Length', unit: 'mm' },
        { key: 'lengthRef', type: 'select', label: 'Measured to', options: [['outer', 'Outer virtual sharp'], ['inner', 'Inner virtual sharp'], ['tangent', 'Tangent (end of the bend)']] },
      ],
    },
    {
      title: 'Flange Width', fields: [
        { key: 'widthType', type: 'select', label: 'Along the edge', default: 'full', options: [['full', 'The whole edge'], ['offsets', 'Offsets from its ends'], ['centered', 'A width in its middle']] },
        { key: 'startOffset', type: 'expr', label: 'From the start', unit: 'mm', default: 0, show: (f) => f.widthType === 'offsets' },
        { key: 'endOffset', type: 'expr', label: 'From the end', unit: 'mm', default: 0, show: (f) => f.widthType === 'offsets' },
        { key: 'swapEnds', type: 'check', label: 'Swap the ends', show: (f) => f.widthType === 'offsets' },
        { key: 'flangeWidth', type: 'expr', label: 'Width', unit: 'mm', default: 20, show: (f) => f.widthType === 'centered' },
      ],
    },
    {
      title: 'Angle and Position', fields: [
        { key: 'angle', type: 'expr', label: 'Angle', unit: '°' },
        { key: 'position', type: 'select', label: 'Position', options: [['inside', 'Material inside (outer face on the edge)'], ['outside', 'Material outside (inner face on the edge)'], ['bend', 'Bend outside (the bend starts at the edge)']] },
        { key: 'offset', type: 'expr', label: 'Offset (moves the flange outward)', unit: 'mm' },
        { key: 'flip', type: 'check', label: 'Flip direction' },
      ],
    },
    {
      title: 'Bend', fields: [
        { key: 'useDefaultRadius', type: 'check', default: true, label: 'Use the part\'s bend radius' },
        { key: 'radius', type: 'expr', label: 'Bend radius (inside)', unit: 'mm', show: (f) => f.useDefaultRadius === false },
      ],
    },
    {
      title: 'Corners', fields: [
        { key: 'corner', type: 'select', label: 'Where these flanges meet', options: [['square', 'Corner to corner (square ends)'], ['butt', 'Mitred (meet on the diagonal)'], ['closed', 'Overlap (one covers the other\'s end)'], ['open', 'Open corner']] },
        { key: 'cornerGap', type: 'expr', label: 'Gap', unit: 'mm', show: (f) => f.corner !== 'open' },
        { key: 'cornerBend', type: 'select', label: 'Bend region', options: [['vcut', 'V cutout (as formed from the flat; lens-shaped opening)'], ['mitre', 'Closed (the bends meet on the diagonal)']], show: (f) => f.corner === 'closed' },
        { key: 'cornerSwap', type: 'check', label: 'Swap which flange covers the other', show: (f) => f.corner === 'closed' },
        { key: 'cHint', type: 'hint', show: (f) => f.corner !== 'open', text: 'For 90° flanges picked in this feature that meet at a corner. Corner to corner: each runs square up to the other\'s inside face, their inside edges the gap apart, the outside corner left open; the bends end in a V cutout. Mitred: the two meet on the diagonal, the gap apart. Overlap: one runs on to cover the other\'s end (bends included), the other runs up to it, leaving the gap.' },
      ],
    },
    {
      title: 'Auto Relief', fields: [
        { key: 'reliefType', type: 'select', label: 'Type', options: [['rect', 'Rectangular'], ['obround', 'Obround'], ['tear', 'Tear']] },
        { key: 'reliefRatio', type: 'expr', label: 'Width (× thickness)', unit: '', show: (f) => f.reliefType !== 'tear' },
        { key: 'rHint', type: 'hint', text: 'A relief is cut where a bend ends next to material that does not bend with it.' },
      ],
    },
  ],
  smCornerRelief: [
    SM_BODY,
    {
      title: 'Relief', fields: [
        { key: 'reliefType', type: 'select', label: 'Type', options: [['rect', 'Rectangular'], ['circle', 'Circular'], ['tear', 'Tear (no material removed)']] },
        { key: 'size', type: 'expr', label: 'Size', unit: 'mm', show: (f) => f.reliefType !== 'tear' },
        { key: 'crHint', type: 'hint', text: 'Cut at every corner where two bends meet, so the bends can form without the material crowding.' },
      ],
    },
  ],
  smClosedCorner: [
    {
      title: 'Corners to Close', fields: [{
        key: 'faces', type: 'faceList', itemLabel: 'Corner', empty: 'No corners picked: every corner of the body is closed',
        hint: 'Click a face of a flange next to each corner to close; the flange it meets is found automatically. The flange you click overlaps the other (Overlap) or tucks under it (Underlap).',
      }],
    },
    { ...SM_BODY, show: (f) => !f.faces?.length },
    {
      title: 'Corner Type', fields: [
        { key: 'cornerType', type: 'select', label: 'Type', options: [['overlap', 'Overlap (covers the other flange\'s end)'], ['underlap', 'Underlap (tucks under the other flange)'], ['square', 'Butt (square ends, each to the other\'s inside face)'], ['butt', 'Mitre (ends meet on the diagonal)']] },
        { key: 'gap', type: 'expr', label: 'Gap', unit: 'mm' },
        { key: 'bendCorner', type: 'select', label: 'Bend region', options: [['vcut', 'V cutout (as formed from the flat; lens-shaped opening)'], ['mitre', 'Closed (the bends meet on the diagonal)']], show: (f) => f.cornerType === 'overlap' || f.cornerType === 'underlap' },
        { key: 'swap', type: 'check', label: 'Swap which flange covers the other', show: (f) => !f.faces?.length && (f.cornerType === 'overlap' || f.cornerType === 'underlap') },
        { key: 'ccHint', type: 'hint', text: 'For corners between 90° flanges. Bend region: V cutout runs each bend on as it would form from the flat (a lens-shaped opening is left between them); Closed meets them on the diagonal with the gap.' },
      ],
    },
  ],
  smUnfold: [
    { title: 'Fixed Face', fields: [{ key: 'face', type: 'pick', label: 'Fixed face', what: 'flatface' }, { key: 'uHint', type: 'hint', text: 'Click a flat face of the sheet metal part: it stays where it is and the part unbends flat around it. Features after this one are made on the flat part (e.g. cuts across bends); add a Bend feature to fold it again.' }] },
  ],
  smFold: [
    { title: 'Body', fields: [{ key: 'body', type: 'bodySel', label: 'Body (empty: every unbent one)', kinds: ['sheet'] }, { key: 'bHint', type: 'hint', text: 'Folds an unbent sheet metal part back into its bent shape, keeping what was done to it while flat.' }] },
  ],
  smConvert: [
    { title: 'Fixed Face', fields: [{ key: 'face', type: 'pick', label: 'Fixed face', what: 'faceAny' }, { key: 'cHint', type: 'hint', text: 'Click a flat face of a body of even thickness, e.g. a sheet metal part from a STEP file. The whole sheet is followed from that face: its bends keep their own radius and angle, including bends that run straight into each other (rolled shapes). A body curved other than in plain bends (a square-to-round transition, a cone or reducer from another program) is unrolled at the neutral layer; for a cone you can click its curved face. On a sharp-cornered body (e.g. a shelled box) every sharp edge becomes a bend of the radius below. Also works on a knitted surface made of flat faces, and on a curved surface that is curved one way only (e.g. a copied fan blade): it is rolled from the flat.' }] },
    {
      // the thickness and bend radii are read from a solid; either can be set instead
      title: 'Sheet Metal Parameters', fields: [
        { key: 'detHint', type: 'hint', text: (f, a) => convertFound(f, a) },
        { key: 'autoThickness', type: 'check', label: 'Use the body\'s thickness', default: true, show: (f, a) => convertDet(f, a)?.kind !== 'surface',
          onChange: (f, a) => { const d = convertDet(f, a); if (f.autoThickness === false && d?.t) f.thickness = +d.t.toFixed(4); } },
        { key: 'thickness', type: 'expr', label: (f, a) => (convertDet(f, a)?.kind === 'surface' ? 'Thickness' : 'Thickness (instead of the body\'s)'), unit: 'mm',
          show: (f, a) => f.autoThickness === false || convertDet(f, a)?.kind === 'surface' },
        { key: 'thickSide', type: 'select', label: 'Thickness', show: (f, a) => convertDet(f, a)?.kind === 'surface',
          options: [['one', 'Behind the surface'], ['other', 'In front of the surface'], ['mid', 'Both sides (symmetric)']] },
        { key: 'trimSelf', type: 'check', label: 'Trim where the sheet would run into itself', default: true, show: (f, a) => !!convertDet(f, a)?.curved },
        { key: 'rollTol', type: 'expr', label: 'Arc fit tolerance', unit: 'mm', show: (f, a) => !!convertDet(f, a)?.curved,
          hint: 'How closely the rolled sheet follows the surface. Smaller: more, shorter bends.' },
        { key: 'autoRadius', type: 'check', label: 'Use the body\'s bend radii', default: true, show: (f, a) => convertDet(f, a)?.kind !== 'surface',
          onChange: (f, a) => { const d = convertDet(f, a); if (f.autoRadius === false && d?.radii?.length) f.radius = +d.radii[0].toFixed(4); } },
        { key: 'radius', type: 'expr', unit: 'mm',
          label: (f, a) => (f.autoRadius === false ? 'Bend radius (inside, every bend)' : convertDet(f, a)?.kind === 'surface' ? 'Bend radius (inside)' : 'Bend radius for sharp edges (inside)'),
          show: (f, a) => { const d = convertDet(f, a); return f.autoRadius === false || !d || (d.kind === 'surface' && !d.curved) || d.sharp > 0; } },
        ...SM_PARAMS.filter((x) => !['radius', 'bendCalc', 'bendAllowance', 'bendDeduction', 'bcHint'].includes(x.key)),
      ],
    },
  ],
  sweep: [
    {
      title: 'Profile, Path and Guide', fields: [
        { key: 'profileType', type: 'select', label: 'Profile', options: [['sketch', 'Sketch profile'], ['circle', 'Circular (enter the diameter)']] },
        { key: 'profile', type: 'sweepSelection', label: 'Profile', show: (f) => f.profileType !== 'circle' },
        { key: 'diameter', type: 'expr', label: 'Diameter', unit: 'mm', show: (f) => f.profileType === 'circle' },
        { key: 'path', type: 'sweepSelection', label: 'Path' },
        { key: 'guide', type: 'sweepSelection', label: 'Guide (optional)', optional: true },
        ...SWEEP_SHAPE,
        { key: 'guideMode', type: 'select', label: 'Guide controls', show: (f) => !!f.guide, options: [['orientation', 'Orientation — keep profile size'], ['contact', 'Section size — keep guide on boundary']] },
        { key: 'guideHint', type: 'hint', show: (f) => !!f.guide, text: 'Use one closed profile without holes or Thin, with an open path and guide. Both curves must span the same normal sections. Orientation keeps the profile size; the guide need not touch its boundary. Section size uniformly scales the profile; the guide must start on its boundary. Contact is checked to 0.0001 mm.' },
        { key: 'sweepHint', type: 'hint', text: 'The path is a sketch (one chain of lines and arcs) or a helix. A sketch profile should sit at the start of the path, across it. For a spring: a helix path and a circular profile.' },
      ],
    },
    SWEEP_EDGES,
    { title: 'Operation', fields: [{ key: 'operation', type: 'solidOperation' }] },
    { ...THIN_GROUP, fields: THIN_GROUP.fields.map((x) => ({ ...x, show: (f) => f.profileType !== 'circle' && (!x.show || x.show(f)) })) },
    ...SCOPE_GROUP,
  ],
  loft: [
    { title: 'Profiles', fields: [{ key: 'profiles', type: 'loftSelection' }] },
    {title:'Profile Correspondence',fields:[{key:'loftCorrespondence',type:'loftCorrespondence'}]},
    ...LOFT_END_GROUPS,
    { title: 'Guide Curves', fields: [
      { key: 'guides', type: 'loftSelection', show: (f) => !f.ruled || f.guides?.length },
      { key: 'guideMethod', type: 'select', label: 'Guide construction', show: (f) => f.guides?.length && !f.ruled, options: (f) => [['adaptive', 'Adaptive approximation'], ['constrained', [f.startCondition, f.endCondition].some(x => x && x !== 'none') ? 'CAD constraints (requires free endpoints)' : 'CAD constraints (two profiles)']] },
      { key: 'guideContinuity', type: 'select', label: 'Across guide seams', show: (f) => f.guides?.length && f.guideMethod === 'constrained' && !f.ruled, options: [['C0', 'C0 — Contact'], ['G1', 'G1 — Tangent'], ['G2', 'G2 — Curvature']] },
      { key: 'guideMethodHint', type: 'hint', show: (f) => f.guides?.length && f.guideMethod === 'constrained', text: 'Native guide edges constrain the CAD patches to 0.0001 mm. Requires two profiles without Thin Feature; holes are lofted straight between the profiles, without the guides. Across guide seams controls the joins along shared guides; original profile corners are not smoothed. Incompatible constraints report an error without lowering continuity.' },
    ] },
    { title: 'Options', fields: [
      { key: 'ruled', type: 'check', label: 'Straight (ruled) sides between profiles' },
      { key: 'continuity', type: 'select', label: 'Through the profiles', show: (f) => !f.ruled && ![f.startCondition, f.endCondition].some(x => x && x !== 'none') && !(f.guides?.length && f.guideMethod === 'constrained'), options: [['C2', 'Curvature-continuous (C2)'], ['C1', 'Tangent-continuous (C1)']] },
      { key: 'smoothing', type: 'check', label: 'Smooth the surface (evens out its bends)', show: (f) => !f.ruled && ![f.startCondition, f.endCondition].some(x => x && x !== 'none') && !(f.guides?.length && f.guideMethod === 'constrained') },
      { key: 'merge', type: 'check', label: 'Merge result (off: make a separate body)', show: (f) => f.op === 'add' },
    ] },
    THIN_GROUP,
    ...SCOPE_GROUP,
  ],
  hole: [
    { title: 'Hole Type', fields: [
      { key: 'holeType', type: 'select', label: 'Type', options: [['simple', 'Hole (clearance)'], ['cbore', 'Counterbore'], ['csink', 'Countersink'], ['tapped', 'Tapped hole'], ['cdrill', 'Counterdrill'], ['slot', 'Slot']] },
      { key: 'system', type: 'select', label: 'Standard', options: [['metric', 'ISO metric'], ['imperial', 'Unified (inch)']], show: (f) => f.holeType === 'tapped' },
      { key: 'thread', type: 'select', label: 'Thread', options: (f) => threadList(f.system || 'metric').map((t) => [t.id, t.label]), show: (f) => f.holeType === 'tapped' },
      { key: 'threadDepth', type: 'expr', label: 'Thread depth (for the callout; empty: the hole)', unit: 'mm', optional: true, show: (f) => f.holeType === 'tapped' },
      { key: 'size', type: 'select', label: 'Screw size', options: [...HOLE_SIZES.map((s) => [s, s]), ['custom', 'Custom sizes']], show: (f) => f.holeType !== 'tapped' },
      { key: 'fit', type: 'select', label: 'Fit (ISO 273)', options: [['close', 'Close'], ['normal', 'Normal'], ['loose', 'Loose']], show: (f) => f.holeType !== 'tapped' && f.size !== 'custom' },
      { key: 'diameter', type: 'expr', label: (f) => (f.holeType === 'slot' ? 'Slot width' : 'Hole diameter'), unit: 'mm', show: (f) => f.holeType !== 'tapped' && f.size === 'custom' },
      { key: 'slotLength', type: 'expr', label: 'Slot length (between the ends’ centres)', unit: 'mm', default: 10, show: (f) => f.holeType === 'slot' },
      { key: 'slotAngle', type: 'expr', label: 'Slot angle', unit: '°', default: 0, show: (f) => f.holeType === 'slot' },
      { key: 'cboreD', type: 'expr', label: 'Counterbore diameter', unit: 'mm', show: (f) => f.holeType === 'cbore' && f.size === 'custom' },
      { key: 'cboreDepth', type: 'expr', label: 'Counterbore depth', unit: 'mm', show: (f) => f.holeType === 'cbore' && f.size === 'custom' },
      { key: 'csinkD', type: 'expr', label: 'Countersink diameter', unit: 'mm', show: (f) => f.holeType === 'csink' && f.size === 'custom' },
      { key: 'cdrillD', type: 'expr', label: 'Counterdrill diameter', unit: 'mm', default: 11, show: (f) => f.holeType === 'cdrill' && f.size === 'custom' },
      { key: 'cdrillDepth', type: 'expr', label: 'Counterdrill depth', unit: 'mm', default: 6, show: (f) => f.holeType === 'cdrill' && f.size === 'custom' },
      { key: 'cdrillAngle', type: 'expr', label: 'Counterdrill point angle', unit: '°', default: 118, show: (f) => f.holeType === 'cdrill' },
      { key: 'csinkAngle', type: 'expr', label: 'Countersink angle', unit: '°', show: (f) => f.holeType === 'csink' && f.size === 'custom' },
      { key: 'tHint', type: 'hint', text: (f) => (f.holeType === 'tapped' ? 'Drilled at the tap drill size (major diameter − pitch), with the thread kept for callouts. For a modelled thread, add Thread Cut on the hole afterwards.' : f.size === 'custom' ? 'Your own sizes.' : 'Sizes for the screw: clearance hole by ISO 273, counterbore for socket head cap screws (ISO 4762), countersink for countersunk screws (ISO 10642, 90°).') },
    ] },
    { title: 'End Condition', fields: [
      { key: 'end', type: 'select', label: 'End', options: [['blind', 'Blind'], ['through', 'Through all'], ['upToNext', 'Up To Next'], ['upToVertex', 'Up To Vertex'], ['upToSurface', 'Up To Surface'], ['offsetSurface', 'Offset From Surface']] },
      { key: 'depth', type: 'expr', label: 'Depth', unit: 'mm', show: (f) => (f.end || 'blind') === 'blind' },
      { key: 'toPoint', type: 'pointRef', label: 'Vertex', show: (f) => f.end === 'upToVertex' },
      { key: 'toPlane', type: 'surfaceRef', label: 'Surface', show: isSurfEnd },
      { key: 'toOffset', type: 'expr', label: 'Offset', unit: 'mm', default: 2, show: (f) => f.end === 'offsetSurface' },
      { key: 'toFlip', type: 'check', label: 'Reverse offset (past the surface)', show: (f) => f.end === 'offsetSurface' },
      { key: 'drillPoint', type: 'check', default: true, label: 'Drill point', show: (f) => (f.end || 'blind') === 'blind' && f.holeType !== 'slot' },
      { key: 'drillAngle', type: 'expr', label: 'Drill point angle', unit: '°', default: 118, show: (f) => (f.end || 'blind') === 'blind' && f.drillPoint !== false && f.holeType !== 'slot' },
      { key: 'farCsink', type: 'check', label: 'Far-side countersink (where it comes out)', show: (f) => ['through', 'upToNext'].includes(f.end) && f.holeType !== 'slot' },
      { key: 'farCsinkD', type: 'expr', label: 'Far-side countersink diameter', unit: 'mm', default: 12, show: (f) => ['through', 'upToNext'].includes(f.end) && f.farCsink && f.holeType !== 'slot' },
      { key: 'farCsinkAngle', type: 'expr', label: 'Far-side countersink angle', unit: '°', default: 90, show: (f) => ['through', 'upToNext'].includes(f.end) && f.farCsink && f.holeType !== 'slot' },
      { key: 'reverse', type: 'check', label: 'Reverse direction' },
      { key: 'eHint', type: 'hint', show: (f) => f.end === 'upToNext', text: 'Up To Next: each hole goes until its axis first comes out of the material (through the wall it starts in).' },
    ] },
    { title: 'Positions', fields: [
      { key: 'faces', type: 'faceList', hint: 'Click points on a face for the holes (flat or curved: a curved face is drilled square to it there), or (for exact places) select a sketch on the face with points or circles: each point / circle centre gets a hole.', itemLabel: 'Hole' },
      { key: 'sketch', type: 'sketch', label: 'Sketch (points / circle centres)' },
    ] },
  ],
  boss: [
    { title: 'Positions', fields: [
      { key: 'faces', type: 'faceList', hint: 'Click points on a flat face for the bosses, or select a sketch on the face with points or circles: each gets one.', itemLabel: 'Boss' },
      { key: 'sketch', type: 'sketch', label: 'Sketch (points / circle centres)' },
      { key: 'reverse', type: 'check', label: 'Reverse direction' },
    ] },
    { title: 'Boss', fields: [
      { key: 'outerD', type: 'expr', label: 'Outer diameter', unit: 'mm' },
      { key: 'height', type: 'expr', label: 'Height', unit: 'mm' },
      { key: 'draft', type: 'expr', label: 'Draft on the outside', unit: '°' },
      { key: 'holeD', type: 'expr', label: 'Hole diameter (0: none)', unit: 'mm' },
      { key: 'holeDepth', type: 'expr', label: 'Hole depth (empty: the height)', unit: 'mm', optional: true },
    ] },
    { title: 'Ribs', fields: [
      { key: 'ribs', type: 'expr', label: 'Ribs (0: none)', unit: '#' },
      { key: 'ribWidth', type: 'expr', label: 'Rib width', unit: 'mm', show: (f) => Number(f.ribs) > 0 },
      { key: 'ribLength', type: 'expr', label: 'Rib length (out from the boss)', unit: 'mm', show: (f) => Number(f.ribs) > 0 },
      { key: 'ribHeight', type: 'expr', label: 'Rib height', unit: 'mm', show: (f) => Number(f.ribs) > 0 },
    ] },
  ],
  snapHook: [
    { title: 'Positions', fields: [
      { key: 'faces', type: 'faceList', hint: 'Click points on a flat face for the snap hooks, or select a sketch on the face with points.', itemLabel: 'Hook' },
      { key: 'sketch', type: 'sketch', label: 'Sketch (points)' },
      { key: 'angle', type: 'expr', label: 'Hook faces (° from the face’s X)', unit: '°' },
      { key: 'reverse', type: 'check', label: 'Reverse direction' },
    ] },
    { title: 'Beam and Hook', fields: [
      { key: 'length', type: 'expr', label: 'Beam length', unit: 'mm' },
      { key: 'thickness', type: 'expr', label: 'Beam thickness', unit: 'mm' },
      { key: 'width', type: 'expr', label: 'Width', unit: 'mm' },
      { key: 'overhang', type: 'expr', label: 'Hook overhang', unit: 'mm' },
      { key: 'insertAngle', type: 'expr', label: 'Lead-in angle (from the beam)', unit: '°' },
      { key: 'retainAngle', type: 'expr', label: 'Catch angle (90: square)', unit: '°' },
    ] },
  ],
  lipGroove: [
    { title: 'Rim Face', fields: [{ key: 'face', type: 'pick', label: 'Face', what: 'flatface' }, { key: 'lgHint', type: 'hint', text: 'The flat face along the open edge of a shelled part, where its two halves meet.' }] },
    { title: 'Lip / Groove', fields: [
      { key: 'kind', type: 'select', label: 'Type', options: [['lip', 'Lip (raised)'], ['groove', 'Groove (sunk)']] },
      { key: 'side', type: 'select', label: 'Along', options: [['inner', 'The inner edge'], ['outer', 'The outer edge']] },
      { key: 'width', type: 'expr', label: 'Width', unit: 'mm' },
      { key: 'height', type: 'expr', label: (f) => (f.kind === 'groove' ? 'Depth' : 'Height'), unit: 'mm' },
      { key: 'lg2Hint', type: 'hint', text: 'For a matching pair: a lip on one half, and on the other a groove a little wider and deeper (the clearance).' },
    ] },
  ],
  mold: [
    { title: 'Mould', fields: [
      { key: 'dir', type: 'select', label: 'Pull direction (the cavity side)', options: [['y', '+Y'], ['-y', '−Y'], ['x', '+X'], ['-x', '−X'], ['z', '+Z'], ['-z', '−Z']] },
      { key: 'parting', type: 'select', label: 'Parting plane', options: [['auto', 'At the largest section'], ['at', 'At a height up the part']] },
      { key: 'partingAt', type: 'expr', label: 'Height (from the part’s lowest point)', unit: 'mm', show: (f) => f.parting === 'at' },
      { key: 'margin', type: 'expr', label: 'Block margin (round the part)', unit: 'mm' },
      { key: 'shrink', type: 'expr', label: 'Shrinkage', unit: '%' },
      { key: 'keepPart', type: 'check', default: true, label: 'Keep the part as a body too' },
      { key: 'mHint', type: 'hint', text: 'A block round the part is split into a core and a cavity at a parting plane square to the pull direction, the part (grown by the shrinkage) taken out of both. Check the part first with Draft Analysis and Undercut Check: undercuts need side actions this does not make.' },
    ] },
  ],
  vent: [
    { title: 'Boundary', fields: [{ key: 'sketch', type: 'sketch', label: 'Sketch (a closed outline on the face)' }] },
    { title: 'Slots', fields: [
      { key: 'slotWidth', type: 'expr', label: 'Slot width', unit: 'mm' },
      { key: 'barWidth', type: 'expr', label: 'Bar width (between slots)', unit: 'mm' },
      { key: 'angle', type: 'expr', label: 'Angle', unit: '°' },
      { key: 'margin', type: 'expr', label: 'Margin from the outline', unit: 'mm' },
      { key: 'end', type: 'select', label: 'Depth', options: [['through', 'Through all'], ['blind', 'Blind']] },
      { key: 'depth', type: 'expr', label: 'Depth', unit: 'mm', show: (f) => f.end === 'blind' },
      { key: 'reverse', type: 'check', label: 'Reverse direction' },
    ] },
  ],
  sketch3d: [
    { title: 'Points', fields: [
      { key: 'pts', type: 'points3d' },
    ] },
    { title: 'Curve', fields: [
      { key: 'kind', type: 'select', label: 'Join the points with', options: [['lines', 'Straight runs (a route)'], ['spline', 'A smooth spline']] },
      { key: 'radius', type: 'expr', label: 'Bend radius at the corners', unit: 'mm', show: (f) => f.kind !== 'spline' },
      { key: 'closed', type: 'check', label: 'Closed loop (back to the first point)' },
      { key: 'kHint', type: 'hint', text: (f) => (f.kind === 'spline' ? 'A smooth curve through every point (e.g. a cable or hose).' : 'Straight runs between the points, each corner rounded at the bend radius (0: sharp corners) — e.g. a pipe or duct route. Sweep a circle or a sketch profile along it.') },
    ] },
  ],
  helix: [
    {
      title: 'Defined By', fields: [
        { key: 'sketch', type: 'sketch', label: 'Sketch with a circle' },
        { key: 'helixHint', type: 'hint', text: 'The circle sets the axis (the sketch normal), the centre and the diameter.' },
        { key: 'definedBy', type: 'select', label: 'Defined by', options: [['pitchRev', 'Pitch and revolutions'], ['pitchHeight', 'Pitch and height'], ['heightRev', 'Height and revolutions']] },
      ],
    },
    {
      title: 'Parameters', fields: [
        { key: 'pitch', type: 'expr', label: 'Pitch', unit: 'mm', show: (f) => f.definedBy !== 'heightRev' },
        { key: 'revolutions', type: 'expr', label: 'Revolutions', unit: '#', show: (f) => f.definedBy !== 'pitchHeight' },
        { key: 'height', type: 'expr', label: 'Height', unit: 'mm', show: (f) => f.definedBy !== 'pitchRev' },
        { key: 'startAngle', type: 'expr', label: 'Start angle', unit: '°' },
        { key: 'clockwise', type: 'check', label: 'Clockwise (left-hand)' },
        { key: 'reverse', type: 'check', label: 'Reverse direction' },
      ],
    },
  ],
  thread: [
    { title: 'Thread Location', fields: [{ key: 'face', type: 'pick', label: 'Cylinder', what: 'cylface' }, { key: 'threadHint', type: 'hint', text: 'Click a bore (internal thread) or a shaft (external thread). The thread starts at the end nearest to where you click.' }] },
    {
      title: 'Specification', fields: [
        { key: 'system', type: 'select', label: 'Standard', options: [['metric', 'Metric (ISO)'], ['imperial', 'Inch (UNC / UNF)']] },
        { key: 'size', type: 'threadSize', label: 'Size' },
        { key: 'diameter', type: 'expr', label: 'Major diameter', unit: 'mm', show: (f) => f.size === 'custom' },
        { key: 'pitch', type: 'expr', label: (f) => (f.size === 'custom' ? 'Pitch' : 'Pitch (empty = standard)'), unit: 'mm', optional: true },
        { key: 'leftHand', type: 'check', label: 'Left-hand thread' },
        { key: 'autoSize', type: 'check', default: true, label: 'Resize the bore / shaft to the thread size (stays inside the body)' },
      ],
    },
    {
      title: 'Length', fields: [
        { key: 'end', type: 'select', label: 'End condition', options: [['through', 'Whole length of the face'], ['blind', 'Depth'], ['upTo', 'Up to a plane or face']] },
        { key: 'depth', type: 'expr', label: 'Depth', unit: 'mm', show: (f) => f.end === 'blind' },
        { key: 'toPlane', type: 'surfaceRef', label: 'Up to', show: (f) => f.end === 'upTo' },
        { key: 'reverse', type: 'check', label: 'Start from the other end' },
      ],
    },
  ],
  cosmeticThread: [
    { title: 'Thread Location', fields: [{ key: 'face', type: 'pick', label: 'Cylinder', what: 'cylface' }, { key: 'threadHint', type: 'hint', text: 'Click a bore (internal thread) or a shaft (external thread). The thread is shown and called out on drawings but not modelled, so it costs nothing to rebuild. It starts at the end nearest to where you click.' }] },
    {
      title: 'Specification', fields: [
        { key: 'system', type: 'select', label: 'Standard', options: [['metric', 'Metric (ISO)'], ['imperial', 'Inch (UNC / UNF)']] },
        { key: 'size', type: 'threadSize', label: 'Size' },
        { key: 'diameter', type: 'expr', label: 'Major diameter', unit: 'mm', show: (f) => f.size === 'custom' },
        { key: 'pitch', type: 'expr', label: (f) => (f.size === 'custom' ? 'Pitch' : 'Pitch (empty = standard)'), unit: 'mm', optional: true },
        { key: 'leftHand', type: 'check', label: 'Left-hand thread' },
      ],
    },
    {
      title: 'Length', fields: [
        { key: 'end', type: 'select', label: 'End condition', options: [['through', 'Whole length of the face'], ['blind', 'Depth'], ['upTo', 'Up to a plane or face']] },
        { key: 'depth', type: 'expr', label: 'Depth', unit: 'mm', show: (f) => f.end === 'blind' },
        { key: 'toPlane', type: 'surfaceRef', label: 'Up to', show: (f) => f.end === 'upTo' },
        { key: 'reverse', type: 'check', label: 'Start from the other end' },
      ],
    },
  ],
  wrap: [
    { title: 'Sketch', fields: [{ key: 'sketch', type: 'sketch', label: 'Sketch (outlines or text)' }] },
    { title: 'Face', fields: [{ key: 'face', type: 'pick', label: 'Face', what: 'faceAny' }, { key: 'wrapHint', type: 'hint', text: 'The sketch is projected along its normal onto the face (flat or curved) and raised or sunk by the depth.' }] },
    {
      title: 'Parameters', fields: [
        { key: 'method', type: 'select', label: 'Type', options: [['emboss', 'Emboss (raise)'], ['deboss', 'Deboss (sink in)']] },
        { key: 'depth', type: 'expr', label: 'Depth', unit: 'mm' },
        { key: 'flip', type: 'check', label: 'Reverse direction' },
      ],
    },
  ],
  extrude: [
    { title: 'Profiles', fields: [{ key: 'profiles', type: 'loftSelection' }] },
    { title:'Start',fields:[
      {key:'startFrom',type:'select',label:'Start from',default:'profile',options:[['profile','Profile plane'],['offset','Offset from profile'],['surface','Plane / planar face']]},
      {key:'startOffset',type:'expr',label:'Start offset',unit:'mm',show:f=>f.startFrom==='offset'},
      {key:'startPlane',type:'surfaceRef',label:'Start surface',show:f=>f.startFrom==='surface'},
    ]},
    {
      title: 'End', fields: [
        { key: 'end', type: 'select', label: 'End condition', options: [...ENDS_REF,['twoSides','Two sides']] },
        { key: 'depth', type: 'expr', label: 'Depth', unit: 'mm', show: (f) => ['blind', 'midplane', 'twoSides'].includes(f.end) },
        { key: 'depth2', type: 'expr', label: 'Second depth', unit: 'mm', default: 0, show: f => f.end === 'twoSides' },
        { key: 'toPoint', type: 'pointRef', label: 'Vertex', show: (f) => f.end === 'upToVertex' },
        { key: 'toPlane', type: 'surfaceRef', label: 'Surface', show: isSurfEnd },
        { key: 'toOffset', type: 'expr', label: 'Offset', unit: 'mm', show: (f) => f.end === 'offsetSurface' },
        { key: 'toFlip', type: 'check', label: 'Reverse offset (past the surface)', show: (f) => f.end === 'offsetSurface' },
        { key: 'reverse', type: 'check', label: 'Reverse direction', show: (f) => ['blind', 'through', 'twoSides'].includes(f.end) },
        { key: 'operation', type: 'solidOperation' },
      ],
    },
    {
      // (the other way from the start, to an end of its own: kernel.worker.js extrude, side2)
      title: 'Second Side', fields: [
        { key: 'side2', type: 'check', label: 'Second side (its own end condition)', show: hasSide2, onChange: (f) => { if (f.side2 && (f.depth2 === 0 || f.depth2 === '0' || f.depth2 == null)) f.depth2 = f.depth ?? 10; } },
        { key: 'end2', type: 'select', label: 'End condition', default: 'blind', options: [['blind', 'Blind'], ['through', 'Through All'], ['upToVertex', 'Up To Vertex'], ['upToSurface', 'Up To Surface'], ['offsetSurface', 'Offset From Surface']], show: side2On },
        { key: 'depth2', type: 'expr', label: 'Depth', unit: 'mm', default: 0, show: (f) => side2On(f) && (f.end2 || 'blind') === 'blind' },
        { key: 'toPoint2', type: 'pointRef', label: 'Vertex', show: (f) => side2On(f) && f.end2 === 'upToVertex' },
        { key: 'toPlane2', type: 'surfaceRef', label: 'Surface', show: (f) => side2On(f) && ['upToSurface', 'offsetSurface'].includes(f.end2) },
        { key: 'toOffset2', type: 'expr', label: 'Offset', unit: 'mm', default: 5, show: (f) => side2On(f) && f.end2 === 'offsetSurface' },
        { key: 'toFlip2', type: 'check', label: 'Reverse offset (past the surface)', show: (f) => side2On(f) && f.end2 === 'offsetSurface' },
      ],
    },
    {
      // (the walls tilted about the profile's plane, each side drafted away from it)
      title: 'Draft', fields: [
        { key: 'draft', type: 'expr', label: 'Draft angle', unit: '°', default: 0 },
        { key: 'draftOutward', type: 'check', label: 'Draft outward (wider away from the profile)', show: (f) => !!f.draft && String(f.draft).trim() !== '0' },
        { key: 'draft2Own', type: 'check', label: 'Second side drafted on its own', show: hasDraft2 },
        { key: 'draft2', type: 'expr', label: 'Second side draft angle', unit: '°', default: 0, show: (f) => hasDraft2(f) && f.draft2Own },
        { key: 'draftOutward2', type: 'check', label: 'Second side drafted outward', show: (f) => hasDraft2(f) && f.draft2Own && !!f.draft2 && String(f.draft2).trim() !== '0' },
      ],
    },
    {
      title: 'Thin Feature', fields: [
        { key: 'thin', type: 'check', label: 'Thin feature (a wall along the sketch curves)' },
        { key: 'thinT', type: 'expr', label: 'Thickness', unit: 'mm', show: (f) => f.thin },
        { key: 'thinDir', type: 'select', label: 'Direction', options: (f) => thinDirOptions(f), show: (f) => f.thin },
      ],
    },
    ...SCOPE_GROUP,
  ],
  revolve: [
    {title:'Profiles',fields:[{key:'profiles',type:'loftSelection'}]},
    REVOLUTION_AXIS,REVOLUTION_DIRECTIONS,
    {title:'Operation',fields:[{key:'operation',type:'solidOperation'}]},
    THIN_GROUP,...SCOPE_GROUP,
  ],
  plane: [
    {title:'References and Relations',fields:[{key:'refs',type:'planeRefs'}]},
    {title:'Options',fields:[
      {key:'flip',type:'check',label:'Flip offset direction',show:(f,a)=>hasPlaneRelation(f,a,'offset')},
      {key:'position',type:'select',label:'Position on edge',options:[['start','Start'],['mid','Midpoint'],['end','End'],['distance','At a distance from the start']],show:(f,a)=>hasPlaneRelation(f,a,'normal')&&f.refs?.length===1&&f.refs[0].kind!=='axis'},
      {key:'along',type:'expr',label:'Distance along the edge',unit:'mm',show:(f,a)=>hasPlaneRelation(f,a,'normal')&&f.position==='distance'&&f.refs?.length===1&&f.refs[0].kind!=='axis'},
      {key:'around',type:'expr',label:'Angle round the cylinder',unit:'°',show:(f,a)=>hasPlaneRelation(f,a,'tangent')&&f.refs?.length===1},
    ]},
    {title:'Placement',fields:[
      {key:'moveBy',type:'expr',label:'Move along its normal',unit:'mm',show:(f,a)=>!hasPlaneRelation(f,a,'offset')},
      {key:'turn',type:'expr',label:'Turn its axes in the plane',unit:'°'},
      {key:'reverse',type:'check',label:'Reverse its normal'},
      {key:'plHint',type:'hint',text:'Placement transforms the constructed plane after solving its reference relations. Reverse changes its orientation; Turn changes the axes of sketches attached to it.'},
    ]},
  ],
  lpattern: [
    patternSources('Features to Pattern'),
    {
      title: 'Direction 1', fields: [
        { key: 'dir1', type: 'direction', label: 'Direction' },
        { key: 'rev1', type: 'check', label: 'Reverse direction' },
        { key: 'spacing1', type: 'select', label: 'Distance', default: 'spacing', options: [['spacing', 'Between each two'], ['total', 'From the first to the last']] },
        { key: 'dist1', type: 'expr', label: (f) => (f.spacing1 === 'total' ? 'Total length' : 'Spacing'), unit: 'mm' },
        { key: 'count1', type: 'expr', label: 'Instances', unit: '#' },
        { key: 'inc1', type: 'expr', label: 'Spacing grows by', unit: 'mm', default: 0, show: (f) => f.spacing1 !== 'total' },
        { key: 'sym1', type: 'check', label: 'Symmetric (as many again the other way)' },
      ],
    },
    {
      title: 'Direction 2', fields: [
        { key: 'dir2', type: 'direction', label: 'Direction', none: true },
        { key: 'rev2', type: 'check', label: 'Reverse direction', show: (f) => f.dir2 !== 'none' },
        { key: 'spacing2', type: 'select', label: 'Distance', default: 'spacing', show: (f) => f.dir2 !== 'none', options: [['spacing', 'Between each two'], ['total', 'From the first to the last']] },
        { key: 'dist2', type: 'expr', label: (f) => (f.spacing2 === 'total' ? 'Total length' : 'Spacing'), unit: 'mm', show: (f) => f.dir2 !== 'none' },
        { key: 'count2', type: 'expr', label: 'Instances', unit: '#', show: (f) => f.dir2 !== 'none' },
        { key: 'inc2', type: 'expr', label: 'Spacing grows by', unit: 'mm', default: 0, show: (f) => f.dir2 !== 'none' && f.spacing2 !== 'total' },
        { key: 'sym2', type: 'check', label: 'Symmetric (as many again the other way)', show: (f) => f.dir2 !== 'none' },
        { key: 'seedOnly2', type: 'check', label: 'Pattern the feature only (not the first row)', show: (f) => f.dir2 !== 'none' },
      ],
    },
    PATTERN_SKIP_GROUP((f) => f.dir2 && f.dir2 !== 'none'),
  ],
  cpattern: [
    patternSources('Features to Pattern'),
    {
      title: 'Parameters', fields: [
        { key: 'axis', type: 'direction', label: 'Axis' },
        { key: 'angle', type: 'expr', label: 'Angle', unit: '°' },
        { key: 'count', type: 'expr', label: 'Instances', unit: '#' },
        { key: 'equal', type: 'check', label: 'Equal spacing (angle is total)' },
        { key: 'angleInc', type: 'expr', label: 'Angle grows by', unit: '°', default: 0, show: (f) => !f.equal },
        { key: 'sym', type: 'check', label: 'Symmetric (as many again the other way round)' },
        { key: 'rings', type: 'expr', label: 'Rings (out from the axis)', unit: '#', default: 1 },
        { key: 'ringStep', type: 'expr', label: 'Ring spacing', unit: 'mm', default: 10, show: (f) => Number(f.rings) > 1 || (typeof f.rings === 'string' && f.rings.trim() !== '1') },
      ],
    },
    PATTERN_SKIP_GROUP((f) => Number(f.rings) > 1),
  ],
  mirror: [
    { title: 'Mirror Face/Plane', fields: [{ key: 'plane', type: 'plane', label: 'Plane' }] },
    patternSources('Features to Mirror', 'list'),
  ],
  spattern: [
    patternSources('Features to Pattern'),
    { title: 'Selections', fields: [
      { key: 'sketch', type: 'sketch', label: 'Reference sketch' },
      { key: 'spHint', type: 'hint', text: 'A copy goes at every point of the sketch (lone points and circle centres). The point nearest the feature is the feature itself.' },
    ] },
  ],
  curvePattern: [
    patternSources('Features to Pattern'),
    { title: 'Direction', fields: [
      { key: 'path', type: 'pathSel', label: 'Curve' },
      { key: 'count', type: 'expr', label: 'Instances (including the feature)', unit: '#' },
      { key: 'spacing', type: 'select', label: 'Spacing', options: [['equal', 'Equal, to the end of the curve'], ['distance', 'Distance along the curve']] },
      { key: 'distance', type: 'expr', label: 'Distance', unit: 'mm', show: (f) => f.spacing === 'distance' },
      { key: 'reverse', type: 'check', label: 'Reverse direction', show: (f) => f.spacing === 'distance' },
      { key: 'align', type: 'select', label: 'Alignment', options: [['translate', 'Moved (same orientation)'], ['tangent', 'Turned with the curve']] },
      { key: 'cpHint', type: 'hint', text: 'The copies start at the point of the curve nearest the feature (a sketch, 3D sketch or helix).' },
    ] },
  ],
  pipeRoute: [
    { title: 'Route', fields: [{ key: 'path', type: 'pathSel', label: 'Sketch or 3D sketch (straight lines)' }] },
    { title: 'Pipe', fields: [
      { key: 'size', type: 'select', label: 'Size (Schedule 40)', options: [...PIPE_SIZES.map((s) => [String(s.dn), pipeLabel(s)]), ['custom', 'Tube: outside diameter and wall']] },
      { key: 'od', type: 'expr', label: 'Outside diameter', unit: 'mm', show: (f) => f.size === 'custom' },
      { key: 'wall', type: 'expr', label: 'Wall', unit: 'mm', show: (f) => f.size === 'custom' },
      { key: 'corner', type: 'select', label: 'Corners', options: [['elbow', 'Elbows (fittings)'], ['bend', 'Bends (one bent tube)']] },
      { key: 'radius', type: 'expr', label: 'Bend radius (auto: 1.5 × the size for elbows, 3 × OD for bends)', unit: 'mm' },
      { key: 'reduceAt', type: 'select', label: 'Reducer', options: [['none', 'None'], ['start', 'At the first end'], ['end', 'At the last end'], ['both', 'At both ends']] },
      { key: 'reduceSize', type: 'select', label: 'Reduced to', options: PIPE_SIZES.map((s) => [String(s.dn), pipeLabel(s)]), show: (f) => f.reduceAt && f.reduceAt !== 'none' && f.size !== 'custom' },
      { key: 'flanges', type: 'check', label: 'Flanges at the (other) ends' },
      { key: 'flangeD', type: 'expr', label: 'Flange outside diameter', unit: 'mm', show: (f) => !!f.flanges },
      { key: 'flangeT', type: 'expr', label: 'Flange thickness', unit: 'mm', show: (f) => !!f.flanges },
      { key: 'prHint', type: 'hint', text: 'Straight pipes run between the fittings: an elbow (or a bend) at each corner, a tee where a line branches square off a straight run. The pipes are on the weldment Cut List with their lengths; the fittings are bodies of their own. Spool Drawing makes an isometric drawing with the cut list and the fittings.' },
    ] },
  ],
  fitSurface: [
    { title: 'Fit To', fields: [
      { key: 'cloud', type: 'select', label: 'Point cloud', options: (f, doc) => (doc?.features || []).filter((x) => x.type === 'pointCloud').map((x) => [x.id, x.name]) },
      { key: 'kind', type: 'select', label: 'Surface', options: [['freeform', 'Freeform (a grid of heights)'], ['plane', 'Plane'], ['cylinder', 'Cylinder'], ['sphere', 'Sphere']] },
      { key: 'grid', type: 'expr', label: 'Grid (points each way)', unit: '#', show: (f) => (f.kind || 'freeform') === 'freeform' },
      { key: 'fHint', type: 'hint', text: 'A surface body fitted to the scan by least squares (freeform: through a grid of heights over its best plane, more grid points following it more closely). The message gives how far the points are from it.' },
    ] },
  ],
  ductFitting: [
    { title: 'Fitting', fields: [
      { key: 'kind', type: 'select', label: 'Kind', options: [['elbow', 'Segmented elbow'], ['cone', 'Cone (reducer)'], ['transition', 'Round to rectangle'], ['offset', 'Offset'], ['lateral', 'Lateral (branch)']] },
      { key: 'D', type: 'expr', label: 'Diameter (outside)', unit: 'mm' },
      { key: 't', type: 'expr', label: 'Sheet thickness', unit: 'mm' },
      { key: 'seam', type: 'expr', label: 'Seam allowance (flat patterns)', unit: 'mm' },
      { key: 'angle', type: 'expr', label: 'Angle', unit: '°', show: (f) => f.kind === 'elbow' },
      { key: 'R', type: 'expr', label: 'Centre line radius', unit: 'mm', show: (f) => f.kind === 'elbow' },
      { key: 'gores', type: 'expr', label: 'Gores (pieces)', unit: '#', show: (f) => f.kind === 'elbow' },
      { key: 'D2', type: 'expr', label: 'Other diameter', unit: 'mm', show: (f) => f.kind === 'cone' },
      { key: 'W', type: 'expr', label: 'Rectangle width', unit: 'mm', show: (f) => f.kind === 'transition' },
      { key: 'H', type: 'expr', label: 'Rectangle height', unit: 'mm', show: (f) => f.kind === 'transition' },
      { key: 'offset', type: 'expr', label: 'Offset (across)', unit: 'mm', show: (f) => f.kind === 'offset' },
      { key: 'L', type: 'expr', label: (f) => (f.kind === 'lateral' ? 'Main length' : 'Length'), unit: 'mm', show: (f) => ['cone', 'transition', 'offset', 'lateral'].includes(f.kind) },
      { key: 'branchD', type: 'expr', label: 'Branch diameter', unit: 'mm', show: (f) => f.kind === 'lateral' },
      { key: 'branchAngle', type: 'expr', label: 'Branch angle', unit: '°', show: (f) => f.kind === 'lateral' },
      { key: 'branchL', type: 'expr', label: 'Branch length (past the main)', unit: 'mm', show: (f) => f.kind === 'lateral' },
      { key: 'dHint', type: 'hint', text: 'A sheet metal duct fitting, with its flat patterns developed on the sheet’s middle and a seam allowance along the long seam (File ▸ Export ▸ Duct Patterns writes them all to one DXF). Move it into place with Move Body.' },
    ] },
  ],
  cable: [
    { title: 'Route', fields: [{ key: 'path', type: 'pathSel', label: 'Sketch or 3D sketch' }] },
    { title: 'Cable', fields: [
      { key: 'sizeBy', type: 'select', label: 'Size', options: [['diameter', 'Diameter'], ['wires', 'From its wires']] },
      { key: 'diameter', type: 'expr', label: 'Diameter', unit: 'mm', show: (f) => f.sizeBy !== 'wires' },
      { key: 'wires', type: 'expr', label: 'Wires', unit: '#', show: (f) => f.sizeBy === 'wires' },
      { key: 'wireD', type: 'expr', label: 'Wire diameter (with insulation)', unit: 'mm', show: (f) => f.sizeBy === 'wires' },
      { key: 'slack', type: 'expr', label: 'Slack (added to the cut length)', unit: '%' },
      { key: 'cHint', type: 'hint', text: 'A round cable or bundle along the route (a 3D sketch spline through the points it must pass is best). The message gives its cut length.' },
    ] },
  ],
  tablePattern: [
    patternSources('Features to Pattern'),
    { title: 'Table', fields: [
      { key: 'plane', type: 'plane', label: 'Plane (empty: the feature’s sketch plane)' },
      { key: 'table', type: 'text', label: 'Rows: x, y, angle', placeholder: '20, 0; 0, 20; 20, 20, 45' },
      { key: 'tpHint', type: 'hint', text: 'Each row puts a copy x and y from the feature, along the plane’s directions; a third number turns it (°) about the plane’s normal through the feature. Rows can be pasted from a spreadsheet (commas, tabs or spaces; a header row is skipped) and can use variables.' },
    ] },
  ],
  fillPattern: [
    patternSources('Features to Pattern', 'none'),
    { title: 'Fill Boundary', fields: [{ key: 'face', type: 'pick', label: 'Face', what: 'flatface' }] },
    { title: 'Pattern Layout', fields: [
      { key: 'layout', type: 'select', label: 'Layout', options: [['square', 'Square'], ['staggered', 'Staggered (perforation)']] },
      { key: 'spacing', type: 'expr', label: 'Spacing', unit: 'mm' },
      { key: 'angle', type: 'expr', label: 'Angle', unit: '°' },
      { key: 'margin', type: 'expr', label: 'Margin from the edges', unit: 'mm' },
      { key: 'fpHint', type: 'hint', text: 'Copies of the feature on a grid over the face, lined up with the feature, kept the margin away from the face edges (e.g. holes or cuts for a perforated panel).' },
    ] },
  ],
  fillet: [
    { title: 'Fillet Type', fields: [{ key: 'filletType', type: 'select', label: 'Type', options: [['constant', 'Constant size'], ['variable', 'Variable size'], ['face', 'Face fillet'], ['fullRound', 'Full round']] }] },
    { title: 'Fillet Parameters', show: (f) => f.filletType !== 'fullRound', fields: [
      { key: 'sizeBy', type: 'select', label: 'Size by', default: 'radius', show: (f) => (f.filletType || 'constant') === 'constant', options: [['radius', 'Radius'], ['chord', 'Chord width']] },
      { key: 'radiusMode', type: 'select', label: 'Radius', show: (f) => f.filletType === 'variable', options: [['ends', 'From the start to the end of each edge'], ['vertices', 'At vertices and points along edges']] },
      { key: 'radius', type: 'expr', label: (f) => (f.filletType === 'variable' ? (f.radiusMode === 'vertices' ? 'Radius (vertices not set)' : 'Radius at the start') : f.sizeBy === 'chord' && (f.filletType || 'constant') === 'constant' ? 'Chord width' : 'Radius'), unit: 'mm' },
      { key: 'chHint', type: 'hint', show: (f) => (f.filletType || 'constant') === 'constant' && f.sizeBy === 'chord', text: 'The width across each fillet, edge to edge: each edge’s radius follows from how far its faces turn (at its middle).' },
      { key: 'radius2', type: 'expr', label: 'Radius at the end', unit: 'mm', show: (f) => f.filletType === 'variable' && f.radiusMode !== 'vertices' },
      { key: 'flipRadii', type: 'check', label: 'Swap the ends', show: (f) => f.filletType === 'variable' && f.radiusMode !== 'vertices' },
      { key: 'vHint', type: 'hint', show: (f) => f.filletType === 'variable' && f.radiusMode !== 'vertices', text: 'The radius changes smoothly from the start to the end of each edge (the ends follow the edge direction: Swap the ends turns it round).' },
      { key: 'vertexRadii', type: 'vertexRadii', show: (f) => f.filletType === 'variable' && f.radiusMode === 'vertices' },
      { key: 'edgePoints', type: 'edgePoints', show: (f) => f.filletType === 'variable' && f.radiusMode === 'vertices' },
      { key: 'setback', type: 'expr', label: 'Setback at corners', unit: 'mm', show: (f) => f.filletType !== 'face' },
      { key: 'sHint', type: 'hint', show: (f) => f.filletType !== 'face', text: 'Where three or more fillets meet: 0 keeps the usual corner; a distance blends the corner smoothly from that far out (a little more than the radius).' },
    ] },
    { title: 'Items To Fillet', fields: [
      { key: 'edges', type: 'edges', show: (f) => f.filletType !== 'face' && f.filletType !== 'fullRound' },
      { key: 'faces', type: 'faceList', show: (f) => f.filletType === 'face', hint: 'Click the faces to blend (two or more): every edge where two of them meet is rounded.' },
      { key: 'faces', type: 'faceList', show: (f) => f.filletType === 'fullRound', hint: 'Click three faces in order: a side face, the face to round off, then the other side face (flat and parallel: a wall). The middle face becomes one round meeting both sides.', itemLabel: 'Face' },
    ] },
  ],
  draft: [
    { title: 'Draft Angle', fields: [{ key: 'angle', type: 'expr', label: 'Angle', unit: '°' }, { key: 'reverse', type: 'check', label: 'Reverse direction' }] },
    { title: 'Neutral Plane', fields: [{ key: 'face', type: 'pick', label: 'Neutral face', what: 'flatface' }, { key: 'nHint', type: 'hint', text: 'A flat face that keeps its size (e.g. the parting face). The faces are tilted about where they meet it, getting smaller away from it along its normal (Reverse direction for the other way).' }] },
    { title: 'Faces to Draft', fields: [{ key: 'faces', type: 'faceList', hint: 'After the neutral face, click the faces to tilt (e.g. the sides of a block, or a bore).' }] },
  ],
  rib: [
    { title: 'Parameters', fields: [
      { key: 'sketch', type: 'sketch', label: 'Sketch (open lines)' },
      { key: 'thickness', type: 'expr', label: 'Thickness', unit: 'mm' },
      { key: 'ribDir', type: 'select', label: 'Extrusion direction', options: [['parallel', 'Parallel to the sketch'], ['normal', 'Normal to the sketch']] },
      { key: 'flip', type: 'check', label: 'Flip material side' },
      { key: 'rHint', type: 'hint', text: (f) => (f.ribDir === 'normal' ? 'The line is thickened in its sketch plane and run square to the sketch until it meets the model.' : 'The line is thickened across its sketch plane (half each side) and filled out in the plane until it meets the model — e.g. a line across the corner of a bracket makes a gusset.') + ' Draw the line so its ends meet faces of the body.' },
    ] },
  ],
  dome: [
    { title: 'Parameters', fields: [
      { key: 'height', type: 'expr', label: 'Height', unit: 'mm' },
      { key: 'elliptical', type: 'check', label: 'Elliptical (round faces)' },
      { key: 'reverse', type: 'check', label: 'Reverse (pressed in)' },
      { key: 'faces', type: 'faceList', hint: 'Click flat faces. A round face gets a spherical cap (or a half ellipsoid); any other outline gets a smooth dome filled over it, highest in the middle.' },
    ] },
  ],
  scale: [
    { title: 'Scale', fields: [
      { key: 'factor', type: 'expr', label: 'Scale factor', unit: '×' },
      { key: 'about', type: 'select', label: 'Scale about', options: [['origin', 'The origin'], ['centroid', 'The centre of the bodies']] },
      { key: 'sHint', type: 'hint', text: 'Every body (solids and surfaces) is scaled by the same factor in all directions. Sheet metal bodies become plain solids.' },
    ] },
  ],
  moveFace: [
    { title: 'Move Face', fields: [
      { key: 'mode', type: 'select', label: 'Type', options: [['offset', 'Offset (push / pull)'], ['rotate', 'Rotate about an edge']] },
      { key: 'distance', type: 'expr', label: 'Distance (out +, in −)', unit: 'mm', show: (f) => f.mode !== 'rotate' },
      { key: 'angle', type: 'expr', label: 'Angle', unit: '°', show: (f) => f.mode === 'rotate' },
      { key: 'reverse', type: 'check', label: 'Reverse direction', show: (f) => f.mode === 'rotate' },
      { key: 'faces', type: 'faceList', hint: 'Click the flat faces to move.' },
      { key: 'edge', type: 'pick', label: 'Hinge edge', what: 'edge', show: (f) => f.mode === 'rotate' },
      { key: 'mHint', type: 'hint', text: (f) => (f.mode === 'rotate' ? 'After the face, click a straight edge of it: the face turns about that edge and the faces round it follow.' : 'Each face moves along its normal, the body growing or shrinking with it (the sides stay square to the face).') },
    ] },
  ],
  chamfer: [
    {
      title: 'Chamfer Parameters', fields: [
        { key: 'chamferType', type: 'select', label: 'Chamfer type', options: [['distance', 'Equal distances'], ['angleDist', 'Distance and angle'], ['twoDist', 'Two distances'], ['vertex', 'Vertex (cut off a corner)']] },
        { key: 'vertexDistances', type: 'check', label: 'Different distances along X, Y and Z', show: (f) => f.chamferType === 'vertex' },
        { key: 'distance', type: 'expr', label: (f) => (f.chamferType === 'twoDist' ? 'Distance 1' : f.chamferType === 'vertex' && f.vertexDistances ? 'Along X' : 'Distance'), unit: 'mm' },
        { key: 'distance2', type: 'expr', label: (f) => (f.chamferType === 'vertex' ? 'Along Y' : 'Distance 2'), unit: 'mm', show: (f) => f.chamferType === 'twoDist' || (f.chamferType === 'vertex' && f.vertexDistances) },
        { key: 'distance3', type: 'expr', label: 'Along Z', unit: 'mm', default: 1, show: (f) => f.chamferType === 'vertex' && f.vertexDistances },
        { key: 'angle', type: 'expr', label: 'Angle', unit: '°', show: (f) => f.chamferType === 'angleDist' },
        { key: 'flip', type: 'check', label: (f) => (f.chamferType === 'angleDist' ? 'Flip direction (distance on the other face)' : 'Flip direction (swap the distances)'), show: (f) => f.chamferType === 'angleDist' || f.chamferType === 'twoDist' },
      ],
    },
    { title: 'Items To Chamfer', fields: [
      { key: 'edges', type: 'edges', show: (f) => f.chamferType !== 'vertex' },
      { key: 'vertices', type: 'vertexList', show: (f) => f.chamferType === 'vertex', hint: 'Click corners of the model where three straight edges meet: each is cut off by the plane through the points the distances along its edges.' },
    ] },
  ],
  shell: [
    { title: 'Parameters', fields: [{ key: 'thickness', type: 'expr', label: 'Thickness', unit: 'mm' }, { key: 'outward', type: 'check', label: 'Shell outward' }] },
    { title: 'Faces to Remove', fields: [{ key: 'faces', type: 'faceList', hint: 'Click the faces to remove (open the shell there). With none, the body is hollowed: a closed void inside.' }] },
    { title: 'Walls of Their Own Thickness', show: (f) => !f.outward, fields: [{ key: 'thickFaces', type: 'faceList', shellThick: true, empty: 'None (every wall the same)', itemLabel: 'Wall', hint: 'Select walls in canvas, then click flat faces of the body: each gets a thickness of its own (more than the shell’s).' }] },
  ],
  combine: [
    { title: 'Operation Type', fields: [{ key: 'op', type: 'select', label: 'Type', options: [['add', 'Add (union)'], ['subtract', 'Subtract'], ['common', 'Common (keep the overlap)']] }] },
    {
      title: 'Bodies', fields: [
        { key: 'main', type: 'bodySel', label: (f) => (f.op === 'subtract' ? 'Target body' : 'Main body'), kinds: ['solid'] },
        {
          key: 'bodies', type: 'bodyList', kinds: ['solid'], exclude: 'main',
          hint: (f) => (f.op === 'subtract' ? 'Cutting bodies: they are subtracted from the target body. The first body you click becomes the target.' : 'Bodies to add to or intersect with the main body. The first body you click becomes the main body.'),
        },
        { key: 'consume', type: 'check', default: true, label: (f) => (f.op === 'subtract' ? 'Consume the cutting bodies (off: keep them)' : 'Consume the tool bodies (off: keep them)') },
      ],
    },
  ],
  deleteBody: [
    { title: 'Bodies to Delete', fields: [{ key: 'bodies', type: 'bodyList', kinds: ['solid', 'surface'], hint: 'Click bodies on the model or tick them here. They stay in the history: delete or suppress this feature to bring them back.' }] },
  ],
  deleteSurface: [
    { title: 'Surfaces to Delete', fields: [{ key: 'bodies', type: 'bodyList', kinds: ['surface'], hint: 'Click surface bodies on the model or tick them here. Delete or suppress this feature to bring them back.' }] },
  ],
  split: [
    { title: 'Trim Tool', fields: [{ key: 'tool', type: 'splitTool', label: 'Split with' }, { key: 'keep', type: 'select', label: 'Keep', options: [['all', 'All pieces'], ['positive', 'The piece on the normal side'], ['negative', 'The piece on the other side']], show: (f) => !window.app?.bodyById(f.tool) }] },
    { title: 'Target Bodies', fields: [{ key: 'bodies', type: 'bodyList', kinds: ['solid'], hint: 'Leave empty to split every solid body the tool crosses.' }] },
  ],
  moveBody: [
    { title: 'Bodies to Move/Copy', fields: [{ key: 'bodies', type: 'bodyList', kinds: ['solid', 'surface'] }, { key: 'copy', type: 'check', label: 'Copy (keep the original bodies)' }, { key: 'copies', type: 'expr', label: 'Copies', unit: '#', show: (f) => f.copy && f.mode !== 'mates' }] },
    { title: 'Method', fields: [{ key: 'mode', type: 'select', label: 'Move by', options: [['translate', 'Translate / Rotate (coordinates)'], ['mates', 'Mates']] }] },
    { title: 'Translate', fields: [{ key: 'dx', world: ['x', ['dx', 'dy', 'dz']], type: 'expr', label: 'ΔX', unit: 'mm', show: (f) => f.mode !== 'mates' }, { key: 'dy', world: ['y', ['dx', 'dy', 'dz']], type: 'expr', label: 'ΔY', unit: 'mm', show: (f) => f.mode !== 'mates' }, { key: 'dz', world: ['z', ['dx', 'dy', 'dz']], type: 'expr', label: 'ΔZ', unit: 'mm', show: (f) => f.mode !== 'mates' }] },
    { title: 'Rotate', fields: [{ key: 'rotAxis', type: 'direction', label: 'Axis', none: true, show: (f) => f.mode !== 'mates' }, { key: 'angle', type: 'expr', label: 'Angle', unit: '°', show: (f) => f.mode !== 'mates' && f.rotAxis !== 'none' }, { key: 'rotCenter', type: 'select', label: 'About', options: [['origin', 'The axis (through the origin for X/Y/Z)'], ['body', 'The center of the bodies']], show: (f) => f.mode !== 'mates' && f.rotAxis !== 'none' }] },
    { title: 'Mates', fields: [{ key: 'mates', type: 'mates', show: (f) => f.mode === 'mates' }] },
  ],
  surfExtrude: [
    {title:'Contours',fields:[{key:'profiles',type:'loftSelection'}]},
    {title:'Model Edges',fields:[{key:'edges',type:'edges'}]},
    {title:'Start',fields:[
      {key:'startFrom',type:'select',label:'Start from',default:'profile',options:[['profile','Contour plane'],['offset','Offset from the contours'],['surface','Plane / planar face']]},
      {key:'startOffset',type:'expr',label:'Start offset',unit:'mm',show:f=>f.startFrom==='offset'},
      {key:'startPlane',type:'surfaceRef',label:'Start surface',show:f=>f.startFrom==='surface'},
    ]},
    {title:'Direction',fields:[
      {key:'end',type:'select',label:'Direction',options:[['blind','One side'],['twoSides','Two sides'],['midplane','Symmetric'],['upToVertex','Up To Vertex'],['upToSurface','Up To Surface'],['offsetSurface','Offset From Surface']]},
      {key:'depth',type:'expr',label:'Depth',unit:'mm',show:f=>['blind','twoSides','midplane'].includes(f.end||'blind')},
      {key:'depth2',type:'expr',label:'Second depth',unit:'mm',default:0,show:f=>f.end==='twoSides'},
      {key:'toPoint',type:'pointRef',label:'Vertex',show:f=>f.end==='upToVertex'},
      {key:'toPlane',type:'surfaceRef',label:'Surface',show:isSurfEnd},
      {key:'toOffset',type:'expr',label:'Offset',unit:'mm',default:5,show:f=>f.end==='offsetSurface'},
      {key:'toFlip',type:'check',label:'Reverse offset (past the surface)',show:f=>f.end==='offsetSurface'},
      {key:'reverse',type:'check',label:'Reverse direction',show:f=>['blind','twoSides'].includes(f.end||'blind')},
      {key:'direction',type:'direction',label:'Along',none:true},
      {key:'dirHint',type:'hint',text:'Along None extrudes square to the contours’ plane; choose an axis to extrude along it instead (needed for model edges that do not lie in one plane).'},
    ]},
    {title:'Draft',fields:[
      {key:'draft',type:'expr',label:'Draft angle',unit:'°',default:0},
      {key:'draftOutward',type:'check',label:'Draft outward (wider away from the contour)',show:f=>!!f.draft&&String(f.draft).trim()!=='0'},
      {key:'draftHint',type:'hint',show:f=>!!f.draft&&String(f.draft).trim()!=='0',text:'A closed contour narrows away from where it starts (or widens drafted outward); an open one leans towards the side its surface faces away from (drafted outward: towards the side it faces).'},
    ]},
  ],
  surfRevolve: [
    {title:'Contours',fields:[{key:'profiles',type:'loftSelection'}]},
    {title:'Model Edges',fields:[{key:'edges',type:'edges'}]},
    REVOLUTION_AXIS,REVOLUTION_DIRECTIONS,
  ],
  surfPlanar: [
    { title: 'Sketch Profiles', fields: [{ key: 'profiles', type: 'loftSelection' }] },
    { title: 'Model Boundary Edges', fields: [{ key: 'edges', type: 'edges' }] },
  ],
  surfLoft: [
    { title: 'Profiles', fields: [{ key: 'profiles', type: 'loftSelection', with3d: true }] },
    {title:'Profile Correspondence',fields:[{key:'loftCorrespondence',type:'loftCorrespondence'}]},
    ...LOFT_END_GROUPS,
    { title: 'Guide Curves', fields: [
      { key: 'guides', type: 'loftSelection', show: (f) => !f.ruled || f.guides?.length },
      { key: 'guideMethod', type: 'select', label: 'Guide construction', show: (f) => f.guides?.length && !f.ruled, options: (f) => [['adaptive', 'Adaptive approximation'], ['constrained', [f.startCondition, f.endCondition].some(x => x && x !== 'none') ? 'CAD constraints (requires free endpoints)' : 'CAD constraints (two profiles)']] },
      { key: 'guideContinuity', type: 'select', label: 'Across guide seams', show: (f) => f.guides?.length && f.guideMethod === 'constrained' && !f.ruled, options: [['C0', 'C0 — Contact'], ['G1', 'G1 — Tangent'], ['G2', 'G2 — Curvature']] },
      { key: 'guideMethodHint', type: 'hint', show: (f) => f.guides?.length && f.guideMethod === 'constrained', text: 'Native guide edges form patch boundaries, checked to 0.0001 mm. Requires two profiles. Open profiles make a sheet; closed profiles make an uncapped shell. Across guide seams controls contact, tangency or curvature continuity along shared guides. Incompatible constraints report an error without lowering continuity.' },
      { key: 'gHint', type: 'hint', show: (f) => !f.ruled && f.guideMethod !== 'constrained', text: 'Optional: curves (rails) the surface follows between the profiles, e.g. along its edges. Each runs from the first profile to the last, through every profile. One guide pulls the surface along it; two or more shape it across, each where it touches the profiles.' },
    ] },
    { title: 'Options', fields: [{ key: 'ruled', type: 'check', label: 'Straight (ruled) between profiles' }] },
  ],
  surfSweep: [
    { title: 'Profile, Path and Guide', fields: [
      { key: 'profileType', type: 'select', label: 'Profile', options: [['sketch', 'Sketch contour (open or closed)'], ['circle', 'Circular (enter the diameter)']] },
      { key: 'profile', type: 'sweepSelection', label: 'Profile', show: (f) => f.profileType !== 'circle' },
      { key: 'diameter', type: 'expr', label: 'Diameter', unit: 'mm', show: (f) => f.profileType === 'circle' },
      { key: 'path', type: 'sweepSelection', label: 'Path' },
      { key: 'guide', type: 'sweepSelection', label: 'Guide (optional)', optional: true },
        ...SWEEP_SHAPE,
      { key: 'guideMode', type: 'select', label: 'Guide controls', show: (f) => !!f.guide, options: [['orientation', 'Orientation — keep profile size'], ['contact', 'Section size — follow the guide']] },
      { key: 'guideHint', type: 'hint', show: (f) => !!f.guide, text: 'Use one open or closed profile chain and an open path and guide. Orientation keeps the profile size. Section size uniformly scales the profile; the guide must start on the profile curve. Contact with the surface is checked to 0.0001 mm. Closed profiles produce an uncapped surface.' },
      { key: 'ssHint', type: 'hint', text: 'The profile (one chain of curves, open or closed) is swept along the path as a surface. Place it at the start of the path, across it.' },
    ] },
    SWEEP_EDGES,
  ],
  surfFill: [
    { title: 'Patch Boundary', fields: [
      { key: 'edges', type: 'edges' },
      { key: 'continuity', type: 'select', label: 'Boundary continuity', options: [['G0', 'Contact (G0)'], ['G1', 'Tangent (G1)'], ['G2', 'Curvature (G2)']] },
      { key: 'supportFaces', type: 'faceList', patchSupport: true, show: f => (f.continuity ?? (f.tangent ? 'G1' : 'G0')) !== 'G0' || f.edges.some(e => e.continuity && e.continuity !== 'G0'), hint: 'Open boundary edges infer their adjacent face. Select support faces explicitly when an edge has two adjacent faces. Each G1/G2 edge needs exactly one support.' },
      { key: 'merge', type: 'check', default: true, label: 'Knit into the surface (when the edges are all on one surface body)' },
      { key: 'solid', type: 'check', label: 'Make a solid when that closes it', show: (f) => f.merge !== false },
      { key: 'fHint', type: 'hint', text: 'Select one closed loop. Set G0, G1 or G2 for the boundary, or override individual edges. Contact, tangency and curvature are checked on CAD surfaces; incompatible constraints report an error without lowering continuity. A tangent edge’s reach (mm) keeps the patch to its support’s tangent plane further in before it turns.' },
    ] },
    { title: 'Pass Through', fields: [
      { key: 'throughCurves', type: 'curveList', empty: 'No curves', add: '+ Add a curve it passes through…' },
      { key: 'throughPoints', type: 'curveList', types: ['point', 'sketch'], empty: 'No points', add: '+ Add points it passes through…' },
      { key: 'thHint', type: 'hint', text: 'Curves (sketches, 3D sketches, curves) and points (reference points, or a sketch’s own points) inside the opening that the patch passes through, checked to 0.0001 mm.' },
    ] },
  ],
  surfTrim: [
    { title: 'Trim Tool', fields: [
      { key: 'tool', type: 'trimTool', label: 'Trim with' },
      { key: 'mutual', type: 'check', label: 'Mutual (trim the tool surface too)', show: (f) => !!window.app?.bodyById(f.tool) },
    ] },
    { title: 'Pieces', fields: [
      { key: 'mode', type: 'select', label: 'Selection', options: [['keep', 'Keep the clicked pieces'], ['remove', 'Remove the clicked pieces']] },
      { key: 'faces', type: 'faceList', itemLabel: 'Piece', hint: 'Click the surfaces on the side of the tool you want to keep (or remove). A sketch tool cuts along its curves, square to the sketch.' },
    ] },
  ],
  surfExtend: [
    { title: 'Edges to Extend', fields: [{ key: 'edges', type: 'edges' }] },
    { title: 'End Condition', fields: [
      { key: 'distance', type: 'expr', label: 'Distance', unit: 'mm' },
      { key: 'eHint', type: 'hint', text: 'Click open edges of a surface: it is extended straight on from them, carrying on its slope at the edge, and knit to it.' },
    ] },
  ],
  deleteFace: [
    { title: 'Faces to Delete', fields: [{ key: 'faces', type: 'faceList', hint: 'Click faces of a solid or a surface body.' }] },
    { title: 'Options', fields: [
      { key: 'mode', type: 'select', label: 'Then', options: [['delete', 'Leave the hole (a solid becomes a surface body)'], ['patch', 'Patch each hole (the solid stays a solid)'], ['heal', 'Heal: the faces round them grow to close the gap (exact)']] },
      { key: 'tangent', type: 'check', label: 'Patch tangent to the faces round the hole', show: (f) => f.mode === 'patch' },
      { key: 'dHint', type: 'hint', text: (f) => (f.mode === 'patch' ? 'Each hole left by the deleted faces gets a smooth patch: good for taking out fillets, small features and bad faces of imported parts.' : 'The faces are taken out; the rest stays as a surface body (e.g. to rebuild them with other surface tools).') },
    ] },
  ],
  editFillet: [
    { title: 'Fillet / Chamfer Faces', fields: [{ key: 'faces', type: 'faceList', hint: 'Click the fillet or chamfer faces of a solid (e.g. an imported part).' }] },
    { title: 'Options', fields: [
      { key: 'mode', type: 'select', label: 'Then', options: [['delete', 'Delete (back to a sharp edge)'], ['resize', 'Resize (round or chamfer it again)']] },
      { key: 'radius', type: 'expr', label: 'New radius / chamfer distance', unit: 'mm', show: (f) => f.mode === 'resize' },
      { key: 'eHint', type: 'hint', text: 'Rounds along straight edges between flat faces, full rounds on circular edges (between a flat face and a round one) and chamfers. The faces either side are carried on to meet exactly; the ends must meet flat faces.' },
    ] },
  ],
  defeature: [
    { title: 'Body', fields: [{ key: 'body', type: 'bodySel', label: 'Body (none: every solid)', kinds: ['solid'] }] },
    { title: 'Take Out', fields: [
      { key: 'fillets', type: 'check', default: true, label: 'Fillets' },
      { key: 'filletR', type: 'expr', label: 'Up to radius', unit: 'mm', show: (f) => f.fillets !== false },
      { key: 'holes', type: 'check', default: true, label: 'Holes' },
      { key: 'holeD', type: 'expr', label: 'Up to diameter', unit: 'mm', show: (f) => f.holes !== false },
      { key: 'dHint', type: 'hint', text: 'Small fillets and holes (with their counterbores, countersinks and drill points) are taken out exactly, for a simpler part to send to a supplier or to analyse. Fillets whose ends do not meet flat faces, and holes that break out of the side, stay.' },
    ] },
  ],
  replaceFace: [
    { title: 'Faces to Replace', fields: [{ key: 'faces', type: 'faceList', hint: 'Click flat faces of a solid.' }] },
    { title: 'Replacement Surface', fields: [
      { key: 'tool', type: 'bodySel', label: 'Surface', kinds: ['surface'] },
      { key: 'rHint', type: 'hint', text: 'The faces move onto the surface: the body grows or shrinks to it. The surface must reach past the faces all round (hide it afterwards).' },
    ] },
  ],
  ruledSurface: [
    { title: 'Edges', fields: [{ key: 'edges', type: 'edges' }] },
    { title: 'Type', fields: [
      { key: 'ruleType', type: 'select', label: 'Direction', options: [['normal', 'Normal to the surface'], ['direction', 'Along a direction (tapered by an angle)']] },
      { key: 'direction', type: 'direction', label: 'Direction', show: (f) => f.ruleType === 'direction' },
      { key: 'angle', type: 'expr', label: 'Taper angle', unit: '°', show: (f) => f.ruleType === 'direction' },
      { key: 'distance', type: 'expr', label: 'Distance', unit: 'mm' },
      { key: 'flip', type: 'check', label: 'Flip side', show: (f) => !f.both },
      { key: 'both', type: 'check', label: 'Both sides' },
      { key: 'ruHint', type: 'hint', text: 'Straight-sided surfaces standing on the edges: e.g. parting surfaces for moulds, or drafted walls. (For a surface carried on in its own slope, use Extend Surface.)' },
    ] },
  ],
  untrim: [
    { title: 'Surface', fields: [
      { key: 'body', type: 'bodySel', label: 'Surface body', kinds: ['surface'] },
      { key: 'mode', type: 'select', label: 'Untrim', options: [['holes', 'Fill its holes'], ['all', 'To its natural extent (holes and outline)']] },
      { key: 'faces', type: 'faceList', hint: 'Optional: click faces to untrim only those (none: every face).' },
    ] },
  ],
  weldBead: [
    { title: 'Weld Bead', fields: [
      { key: 'size', type: 'expr', label: 'Weld size', unit: 'mm' },
      { key: 'bodies', type: 'bodyList', kinds: ['solid'], hint: 'Click the bodies to weld together (none: every weldment member). A bead runs along every line where two of them meet.' },
    ] },
  ],
  weldTrim: [
    { title: 'Bodies to Trim', fields: [{ key: 'bodies', type: 'bodyList', kinds: ['solid'], hint: 'Click the members to trim (or extend) on the model.' }] },
    { title: 'Trimming Boundary', fields: [
      { key: 'tool', type: 'boundarySel', label: 'Trim to' },
      { key: 'extend', type: 'check', default: true, label: 'Extend members that stop short of it' },
      { key: 'trimType', type: 'select', label: 'Cut', options: [['planar', 'Square, on the boundary’s face'], ['cope', 'Coped to the boundary body']] },
      { key: 'tHint', type: 'hint', text: 'Each member is trimmed (or extended) at its end nearer the boundary. Pipes and round bars are always coped to a body.' },
    ] },
  ],
  endCap: [
    { title: 'Parameters', fields: [
      { key: 'faces', type: 'faceList', hint: 'Click the open end faces of hollow members (tubes, pipes).' },
      { key: 'capType', type: 'select', label: 'Cap', options: [['outside', 'On the end (outside)'], ['inside', 'In the end (flush)']] },
      { key: 'thickness', type: 'expr', label: 'Thickness', unit: 'mm' },
    ] },
  ],
  weldGusset: [
    { title: 'Supporting Faces', fields: [{ key: 'faces', type: 'faceList', hint: 'Click two flat faces that meet at a corner, one on each member.' }] },
    { title: 'Profile', fields: [
      { key: 'd1', type: 'expr', label: 'Leg 1 (along the first face)', unit: 'mm' },
      { key: 'd2', type: 'expr', label: 'Leg 2 (along the second face)', unit: 'mm' },
      { key: 'thickness', type: 'expr', label: 'Thickness', unit: 'mm' },
      { key: 'chamfer', type: 'expr', label: 'Corner chamfer (weld clearance)', unit: 'mm' },
    ] },
    { title: 'Location', fields: [
      { key: 'position', type: 'select', label: 'Plate', options: [['mid', 'Centred'], ['start', 'To one side'], ['end', 'To the other side']] },
      { key: 'offset', type: 'expr', label: 'Offset along the corner', unit: 'mm' },
    ] },
  ],
  structMember: [
    { title: 'Profile', fields: [{ key: 'profile', type: 'profileSel' }] },
    { title: 'Path', fields: [
      { key: 'path', type: 'pathSel', label: 'Sketch / 3D sketch' },
      { key: 'paths', type: 'curveList' },
      { key: 'pHint', type: 'hint', text: 'Every line (and arc) of the sketch becomes a member, its own body. Add more sketches / 3D sketches (the list) for a frame in 3D, e.g. the top of a table and its legs: the joints between them are treated too. Arcs (or the bends of a 3D sketch with a bend radius) become bent members.' },
    ] },
    { title: 'Corners', fields: [
      { key: 'corner', type: 'select', label: 'Corner treatment', options: [['mitre', 'Mitre'], ['butt1', 'Butt (first member trimmed)'], ['butt2', 'Butt (second member trimmed)'], ['none', 'None (members meet at the sketch points)']] },
      { key: 'trim', type: 'select', label: 'Trimmed ends', options: [['planar', 'Square cut on the face (pipes and bars: coped)'], ['cope', 'Coped to the other member’s outside']] },
      { key: 'cHint', type: 'hint', text: 'Corners: where two members meet end to end. A member ending on the middle of another is trimmed to it as well.' },
    ] },
    { title: 'Alignment', fields: [
      { key: 'pierce', type: 'select', label: 'Sketch line runs through', options: PIERCE },
      { key: 'rotate', type: 'expr', label: 'Rotate profile', unit: '°' },
      { key: 'mirror', type: 'check', label: 'Mirror profile' },
    ] },
  ],
  flattenSurf: [
    { title: 'Faces to Flatten', fields: [
      { key: 'faces', type: 'faceList', hint: 'Click the faces (of a surface or a solid) to unroll. They are laid flat beside the model as a surface body.' },
      { key: 'iterations', type: 'expr', label: 'Relaxing passes (doubly curved faces)', unit: '#' },
      { key: 'flHint', type: 'hint', text: 'Faces that unroll (cylinders, cones, bent sheets) come out exact. A doubly curved face (e.g. a dome) cannot lie flat without stretching: it is spread out keeping its edge lengths as well as possible, and the note gives the area change. A closed tube needs a seam (Split Line) to open out.' },
    ] },
  ],
  projCurve: [
    { title: 'Projection', fields: [
      { key: 'sketch', type: 'sketch', label: 'Sketch' },
      { key: 'faces', type: 'faceList', hint: 'Click the faces to project onto (none: every face it reaches). The sketch is projected along its normal, both ways.' },
    ] },
  ],
  splitLine: [
    { title: 'Split With', fields: [
      { key: 'tool', type: 'trimTool', label: 'Split with' },
      { key: 'faces', type: 'faceList', hint: 'Click the faces to split. A sketch is projected onto them along its normal; a plane or surface splits them where it crosses them. The body stays one body, with the faces split (e.g. for a part line, a draft, or a face to colour).' },
    ] },
  ],
  compCurve: [
    { title: 'Edges', fields: [{ key: 'edges', type: 'edges' }, { key: 'cHint', type: 'hint', text: 'Click edges that join end to end: they become one curve (e.g. a sweep path or a loft profile).' }] },
  ],
  boundarySurf: [
    { title: 'Direction 1', fields: [{ key: 'dir1', type: 'curveList' }] },
    { title: 'Direction 2', fields: [{ key: 'dir2', type: 'curveList' }, { key: 'bHint', type: 'hint', text: 'The first and last curves of each direction bound the surface and must meet at their ends; the curves between shape it. With curves in one direction only, use Lofted Surface.' }] },
  ],
  surfOffset: [
    { title: 'Parameters', fields: [{ key: 'distance', type: 'expr', label: 'Distance', unit: 'mm' }, { key: 'flip', type: 'check', label: 'Flip direction' }] },
    { title: 'Faces to Offset', fields: [{ key: 'faces', type: 'faceList' }] },
  ],
  surfCopy: [
    { title: 'Faces to Copy', fields: [{ key: 'faces', type: 'faceList' }, { key: 'cHint', type: 'hint', text: 'Faces of solid or surface bodies, flat or curved. The copies become surface bodies; the bodies themselves are not changed.' }] },
    { title: 'Options', fields: [{ key: 'knit', type: 'check', label: 'Join copies that touch into one surface body', default: true }] },
  ],
  knit: [
    { title: 'Surfaces to Knit', fields: [{ key: 'bodies', type: 'bodyList', kinds: ['surface'] }] },
    { title: 'Options', fields: [{ key: 'solid', type: 'check', label: 'Try to form a solid (when the surfaces are closed)' }, { key: 'merge', type: 'check', label: 'Merge the solid with bodies it touches', show: (f) => f.solid }, { key: 'tolerance', type: 'expr', label: 'Gap tolerance', unit: 'mm' }] },
  ],
  surfSolid: [
    { title: 'Surfaces', fields: [{ key: 'bodies', type: 'bodyList', kinds: ['surface'] }, { key: 'sHint', type: 'hint', text: 'Pick the surface bodies that together enclose a volume (or an STL mesh that came in as a surface). They are sewn together and made into one solid. If they leave gaps, the message says how many open edges there are: raise the gap tolerance, or close the holes with Repair Mesh.' }] },
    { title: 'Options', fields: [
      { key: 'tolerance', type: 'expr', label: 'Gap tolerance (edges closer than this join)', unit: 'mm' },
      { key: 'merge', type: 'check', label: 'Merge the solid with bodies it touches' },
    ] },
  ],
  meshRepair: [
    { title: 'Mesh / Surfaces', fields: [{ key: 'bodies', type: 'bodyList', kinds: ['surface'] }, { key: 'rHint', type: 'hint', text: 'Pick the surface body to repair, e.g. an STL with small missing pieces (an STL that is not closed comes in as a surface body). Every hole — a loop of edges with a face on one side only — is closed: flat holes with one flat face, curved ones with a filling surface, holes in a mesh with triangles. Then it is made into a solid.' }] },
    { title: 'Options', fields: [
      { key: 'maxHole', type: 'expr', label: 'Largest hole to close (0: any size)', unit: 'mm' },
      { key: 'tolerance', type: 'expr', label: 'Gap tolerance (edges closer than this join)', unit: 'mm' },
      { key: 'solid', type: 'check', label: 'Make a solid when it is closed', default: true },
      { key: 'merge', type: 'check', label: 'Merge the solid with bodies it touches', show: (f) => f.solid !== false },
    ] },
  ],
  thicken: [
    { title: 'Surface', fields: [{ key: 'body', type: 'bodySel', label: 'Surface body', kinds: ['surface'] }] },
    { title: 'Thickness', fields: [{ key: 'thickness', type: 'expr', label: 'Thickness', unit: 'mm' }, { key: 'side', type: 'select', label: 'Side', options: [['one', 'One side'], ['both', 'Both sides (mid)']] }, { key: 'flip', type: 'check', label: 'Flip side', show: (f) => f.side !== 'both' }, { key: 'merge', type: 'check', label: 'Merge result' }] },
  ],
  import: [
    { title: 'Imported File', fields: [
      { key: 'fileName', type: 'fileinfo' },
      { key: 'mergeBodies', type: 'check', label: 'Merge touching bodies into one body' },
      { key: 'maxTris', type: 'expr', label: 'Simplify meshes above (triangles; 0: never)', unit: '#', show: (f) => f.format !== 'step' },
      { key: 'mtHint', type: 'hint', show: (f) => f.format !== 'step', text: 'Big meshes (e.g. 3D printing models) are simplified on import: the triangles that change the shape least are merged. Around 80,000 keeps the detail and stays quick; much more gets slow and can run out of memory.' },
    ] },
  ],
  axis: [{title:'References and Relations',fields:[{key:'refs',type:'planeRefs'}]}],
  point: [
    {title:'Definition',fields:[{key:'pointType',type:'select',label:'Defined by',options:[['coords','Coordinates'],['references','Reference geometry']]}]},
    {title:'References and Relations',show:f=>f.pointType!=='coords',fields:[{key:'refs',type:'planeRefs',show:f=>f.pointType!=='coords'}]},
    {title:'Coordinates',fields:['x','y','z'].map(k=>({key:k,world:[k,['x','y','z']],type:'expr',label:k.toUpperCase(),unit:'mm',show:f=>f.pointType==='coords'}))},
  ],
};

const CURVE_ICON = { line: 'line', circle: 'circle', arc: 'arc', spline: 'spline', point: 'point', ellipse: 'ellipse', earc: 'ellipse' };
// A toolbar command's key (saved in the user's toolbar layout)
const cmdKey = (d) => d.id || d.label;

export class UI {
  constructor(app) {
    this.app = app;
    this.cmTab = 'features';
    this.collapsed = new Set();
    this.groupCollapsed = new Set();
    this.buildMenus();
    this.buildLeftTabs();
    this.buildHUD();
    this.buildSplitter();
    this.prefs = {};
    this.renderCommandManager();
    // the user's own toolbar layout (and other preferences), once the desktop app answers
    platform.ready.then(() => platform.getPrefs()).then((p) => { this.prefs = p || {}; setThemePref(this.prefs.theme); if (this.prefs.lang && this.prefs.lang !== 'en') setLanguage(this.prefs.lang); this.applyIconSize(); this.renderCommandManager(); }).catch(() => {});
    // another language: everything drawn again in it
    window.addEventListener('razorcad-lang', () => {
      document.querySelectorAll('#menubar > button[data-menu]').forEach((b) => { b.textContent = tr(b.dataset.menu); });
      const a = this.app;
      if (a.mode === 'drawing' && a.drawing) a.drawing.renderAll?.();
      else { this.renderCommandManager(); this.renderTree?.(); this.renderPM?.(); }
    });
    // A tree row's hover highlight ends when the pointer is anywhere else. The row's own
    // pointerleave is not enough: when the tree is redrawn under the pointer (after a click,
    // hide, rebuild or drag) the old row is removed without one, and the highlight stuck.
    const endTreeHover = (e) => {
      const h = this.treeHover;
      if (h && (!e || !h.el.isConnected || !h.el.contains(e.target))) { this.treeHover = null; h.off(); }
    };
    document.addEventListener('pointermove', endTreeHover, true);
    document.addEventListener('pointerdown', endTreeHover, true);
    document.addEventListener('dragend', () => endTreeHover(), true);
    document.documentElement.addEventListener('pointerleave', () => endTreeHover());
    window.addEventListener('blur', () => endTreeHover());
    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('#dropdown') && !e.target.closest('#menubar')) this.closeDropdown();
      if (!e.target.closest('#ctxmenu')) this.closeContext();
    });
    window.addEventListener('blur', () => { this.closeDropdown(); this.closeContext(); });
    $('#help-btn').onclick = () => this.showShortcuts();
  }

  // ------------------------------------------------------------ menus
  // the menus of the document in front, with the theme and language in View and the macros in Tools
  menuDefs() {
    const defs = this.baseMenuDefs();
    if (defs) defs.View = [...(defs.View || []), 'sep', ...this.upAxisItems(), 'sep', ...this.themeItems(), 'sep', ...this.languageItems()];
    if (defs && this.app.macros) defs.Tools = [...(defs.Tools || []), 'sep', ...this.app.macros.menuItems()];
    return defs;
  }
  // the world's up axis (the part's own; also for new parts): see wcs.js
  upAxisItems() {
    const cur = W.getUp();
    return [['Y (Top plane XZ, Front XY)', 'y'], ['Z (Top plane XY, Front XZ)', 'z']].map(([l, v]) => ({ label: `Up Axis ▸ ${cur === v ? '● ' : ''}${l}`, icon: 'axis', action: () => this.app.setUpAxis(v) }));
  }
  themeItems() {
    const cur = themePref();
    return [['Light', 'light'], ['Dark', 'dark'], ['Follow Windows', 'system']].map(([l, v]) => ({ label: `Theme ▸ ${cur === v ? '● ' : ''}${l}`, icon: 'theme', action: () => this.setTheme(v) }));
  }
  languageItems() {
    const cur = language();
    return LANGUAGES.map(([code, name]) => ({ label: `Language ▸ ${cur === code ? '● ' : ''}${name}`, icon: 'language', action: () => this.setLang(code) }));
  }
  async setLang(code) {
    this.prefs ||= {};
    this.prefs.lang = code;
    this.savePrefs();
    await setLanguage(code);
    this.app.status(LANGUAGES.find(([c]) => c === code)?.[1] || code);
  }
  setTheme(v) {
    this.prefs ||= {};
    this.prefs.theme = v;
    setThemePref(v);
    this.savePrefs();
    this.app.status(`Theme: ${{ light: 'light', dark: 'dark', system: 'as Windows is set' }[v]}.`);
  }

  // Settings: everything you can set, in one place (each change applies at once, as from its own menu): the
  // look, units and up axis, your gauges, and the editors for drawings' DXF, shortcuts, toolbars and Claude.
  showSettings() {
    const a = this.app, box = el('div', { class: 'settings' });
    let dlg = null;
    const section = (title) => { const s = el('div', { class: 'settings-sec' }); s.appendChild(el('h4', {}, esc(tr(title)))); box.appendChild(s); return s; };
    const select = (opts, cur, onchange) => {
      const s = el('select', { style: 'min-width:12em' });
      for (const [v, l] of opts) { const o = el('option', { value: v }, esc(l)); if (v === cur) o.selected = true; s.appendChild(o); }
      s.onchange = () => onchange(s.value);
      return s;
    };
    const open = (label, fn) => el('button', { class: 'pm-btn', onclick: () => { dlg?.close(); fn(); } }, esc(tr(label)));
    const look = section('Appearance');
    look.appendChild(this.row('Theme', select([['light', 'Light'], ['dark', 'Dark'], ['system', 'Follow Windows']], this.prefs?.theme || 'system', (v) => this.setTheme(v))));
    look.appendChild(this.row('Language', select(LANGUAGES, language(), (v) => this.setLang(v))));
    look.appendChild(this.row('Toolbar icons', select([['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], this.prefs?.iconSize || 'medium', (v) => this.setIconSize(v))));
    look.appendChild(this.row('Sketch toolbar', select([['expanded', 'Expanded (all tools)'], ['grouped', 'Grouped (flyout menus)']], this.tbPrefs().sketchLayout || 'expanded', (v) => { this.tbPrefs().sketchLayout = v; this.savePrefs(); this.renderCommandManager(); })));
    const ua = section('Units and Axes');
    const what = a.mode === 'drawing' ? (a.drawing?.doc?.kind === 'assembly' ? 'this assembly' : 'this drawing') : 'this part';
    ua.appendChild(this.row('Units', select([['mm', 'Millimetres (mm)'], ['in', 'Inches (in)']], a.units, (v) => a.setUnits(v))));
    ua.appendChild(el('div', { class: 'pm-hint' }, esc(`For ${what}.`)));
    ua.appendChild(this.row('Up axis', select([['y', 'Y up (Top plane XZ, Front XY)'], ['z', 'Z up (Top plane XY, Front XZ)']], W.getUp(), (v) => a.setUpAxis(v))));
    ua.appendChild(el('div', { class: 'pm-hint' }, esc(a.mode === 'drawing' && a.drawing?.doc?.kind !== 'assembly' ? 'For new parts.' : `For ${what}, and for new parts.`)));
    const sm = section('Sheet Metal Gauges');
    const gl = el('div', { class: 'pm-list' });
    const gauges = () => {
      gl.innerHTML = '';
      const mine = this.prefs?.gauges || [];
      if (!mine.length) gl.appendChild(el('div', { class: 'li pm-hint' }, esc(tr('None of your own yet: save one from a sheet metal feature\'s Gauge row (Save…).'))));
      for (const g of mine) {
        const li = el('div', { class: 'li' }, `<span>${esc(g.name)}: t ${esc(fmt(g.t, 3))} mm, R ${esc(fmt(g.R, 3))} mm, K ${esc(fmt(g.K, 3))}</span><span class="x" title="Delete">✕</span>`);
        li.querySelector('.x').onclick = () => { this.prefs.gauges = mine.filter((x) => x !== g); this.savePrefs(); gauges(); };
        gl.appendChild(li);
      }
    };
    gauges();
    sm.appendChild(gl);
    const more = section('More Settings');
    const btns = el('div', { class: 'settings-btns' });
    btns.append(open('DXF Settings…', () => this.showDxfSettings()), open('Customize Shortcuts…', () => this.showShortcutEditor()), open('Customize Toolbars…', () => this.showToolbarCustomize()), open('Claude Settings…', () => this.showClaudeSettings()), open('Getting Started Tour', () => this.startTour()));
    more.appendChild(btns);
    dlg = this.modal('Settings', 'gear', box, [{ label: 'Close', primary: true }]);
  }
  baseMenuDefs() {
    const a = this.app;
    if (a.mode === 'drawing' && a.drawing) return a.drawing.menuDefs();
    return {
      File: [
        { label: 'New Part', icon: 'newdoc', key: 'Ctrl+N', action: () => a.newDocument() },
        { label: 'New Assembly', icon: 'assembly', action: () => a.newAssembly() },
        { label: 'New Drawing', icon: 'drawing', action: () => a.newDrawing() },
        { label: 'Make Drawing from Part', icon: 'std3View', action: () => a.newDrawing(true), disabled: !a.doc?.features.length },
        { label: 'Open…', icon: 'open', key: 'Ctrl+O', action: () => a.openFile() },
        { label: 'Open Sample Part', icon: 'part', action: () => a.openSample() },
        { label: 'Open Example Part (Tutorial)', icon: 'loft', action: () => a.openExample() },
        { label: 'Recent Parts / Start…', icon: 'open', action: () => a.showStart() },
        'sep',
        { label: 'Save', icon: 'save', key: 'Ctrl+S', action: () => a.saveFile() },
        { label: 'Save As…', icon: 'save', key: 'Ctrl+Shift+S', action: () => a.saveFile(true) },
        { label: 'Revisions…', icon: 'revTable', action: () => revisionsDialog(a, a.doc, () => a.commit()) },
        { label: 'Where Used…', icon: 'open', action: () => a.whereUsed() },
        'sep',
        { label: 'Import STEP / STL…', icon: 'import', key: 'Ctrl+I', action: () => a.importFile() },
        { label: 'Import Point Cloud (PLY, XYZ)…', icon: 'import', action: () => a.importPointCloud() },
        { label: 'Export ▸ STEP…', icon: 'step', action: () => a.exportFile('step') },
        { label: 'Export ▸ STL…', icon: 'stl', action: () => a.exportFile('stl') },
        { label: 'Export ▸ glTF (.glb) for web and AR…', icon: 'obj', action: () => a.exportFile('glb') },
        { label: 'Export ▸ Duct Patterns (DXF)…', icon: 'dxf', action: () => a.exportDuctPatterns(), disabled: !a.doc?.features?.some((f) => f.type === 'ductFitting' && !f.suppressed) },
        { label: 'Export ▸ Flat Pattern as DXF…', icon: 'dxf', action: () => a.exportSheetDXF(), disabled: !a.flatView && !(a.result?.bodies || []).some((b) => b.sheet) },
        { label: 'Export ▸ Face as DXF…', icon: 'dxf', action: () => a.exportFaceDXF(), disabled: !a.flatView && !(a.selection?.kind === 'face' && a.selection.face.planar) },
        'sep',
        { label: 'Properties…', icon: 'customProps', action: () => editCustomProps(this, a.doc, (ch) => { if (ch) { a.commit(); a.status('Part properties changed.'); } }) },
        { label: 'Compare With…', icon: 'compare', action: () => compareWith(a) },
        'sep',
        { label: 'Settings…', icon: 'gear', action: () => this.showSettings() },
      ],
      Edit: [
        { label: 'Undo', icon: 'undo', key: 'Ctrl+Z', action: () => a.undo(), disabled: !a.history.canUndo() || a.mode === 'sketch' },
        { label: 'Redo', icon: 'redo', key: 'Ctrl+Y', action: () => a.redo(), disabled: !a.history.canRedo() || a.mode === 'sketch' },
        'sep',
        { label: 'Rebuild', icon: 'rebuild', key: 'Ctrl+B', action: () => a.rebuild({ force: true }) },
        { label: 'Delete', icon: 'trash', key: 'Del', action: () => a.deleteSelection(), disabled: a.selection?.kind !== 'feature' },
      ],
      View: [
        { label: 'Zoom to Fit', icon: 'zoomfit', key: 'F', action: () => a.viewport.zoomToFit() },
        'sep',
        ...[['Front', 'front', '1'], ['Back', 'back', '2'], ['Left', 'left', '3'], ['Right', 'right', '4'], ['Top', 'top', '5'], ['Bottom', 'bottom', '6'], ['Isometric', 'iso', '7'], ['Trimetric', 'trimetric', '']]
          .map(([l, v, k]) => ({ label: l, icon: 'views', key: k ? 'Ctrl+' + k : '', action: () => a.viewport.setStandardView(v) })),
        { label: 'Normal To', icon: 'normalTo', key: 'Ctrl+8', action: () => a.normalToSelection() },
        'sep',
        ...this.displayItems(),
        'sep',
        { label: (a.showPlanes ? 'Hide' : 'Show') + ' Planes', icon: 'eye', action: () => a.togglePlanes() },
        ...this.iconSizeItems(),
        'sep',
        { label: 'Visibility…', icon: 'eye', action: () => { const r = $('#hud .vis-btn')?.getBoundingClientRect(); this.showVisMenu(r ? r.left : 300, r ? r.bottom + 4 : 120); } },
        { label: a.showHiddenMode ? 'Done Showing Hidden Bodies' : 'Show Hidden Bodies', icon: 'hiddenBodies', action: () => a.toggleShowHidden() },
        ...(a.isolated ? [{ label: 'Exit Isolate', icon: 'isolate', action: () => a.exitIsolate() }] : []),
      ],
      Insert: [
        { label: 'Sketch', icon: 'sketch', action: () => a.startSketch() },
        { label: 'Exploded View… (multi-body part)', icon: 'explode', action: () => a.startExplode() },
        'sep',
        { label: 'Extrude…', icon: 'extrude', action: () => a.startFeature('extrude', 'add') },
        { label: 'Revolve…', icon: 'revolve', action: () => a.startFeature('revolve', 'add') },
        { label: 'Cut ▸ Extrude…', icon: 'cutExtrude', action: () => a.startFeature('extrude', 'cut') },
        { label: 'Cut ▸ Revolve…', icon: 'cutRevolve', action: () => a.startFeature('revolve', 'cut') },
        { label: 'Sweep…', icon: 'sweep', action: () => a.startFeature('sweep', 'add') },
        { label: 'Loft…', icon: 'loft', action: () => a.startFeature('loft', 'add') },
        { label: 'Cut ▸ Sweep…', icon: 'cutSweep', action: () => a.startFeature('sweep', 'cut') },
        { label: 'Cut ▸ Loft…', icon: 'cutLoft', action: () => a.startFeature('loft', 'cut') },
        { label: 'Curve ▸ Helix…', icon: 'helix', action: () => a.startFeature('helix') },
        { label: '3D Sketch…', icon: 'sketch3d', action: () => a.startFeature('sketch3d') },
        { label: 'Features ▸ Hole…', icon: 'hole', action: () => a.startFeature('hole') },
        { label: 'Features ▸ Thread Cut…', icon: 'threadCut', action: () => a.startFeature('thread', 'cut') },
        { label: 'Features ▸ Thread Extrude…', icon: 'threadExtrude', action: () => a.startFeature('thread', 'add') },
        { label: 'Features ▸ Cosmetic Thread…', icon: 'cosmeticThread', action: () => a.startFeature('cosmeticThread') },
        { label: 'Features ▸ Wrap (Emboss / Deboss)…', icon: 'wrap', action: () => a.startFeature('wrap') },
        'sep',
        { label: 'Pattern/Mirror ▸ Linear Pattern…', icon: 'lpattern', action: () => a.startFeature('lpattern') },
        { label: 'Pattern/Mirror ▸ Circular Pattern…', icon: 'cpattern', action: () => a.startFeature('cpattern') },
        { label: 'Pattern/Mirror ▸ Mirror…', icon: 'mirror', action: () => a.startFeature('mirror') },
        'sep',
        { label: 'Features ▸ Fillet…', icon: 'fillet', action: () => a.startFeature('fillet') },
        { label: 'Features ▸ Chamfer…', icon: 'chamfer', action: () => a.startFeature('chamfer') },
        { label: 'Features ▸ Shell…', icon: 'shell', action: () => a.startFeature('shell') },
        { label: 'Features ▸ Combine…', icon: 'combine', action: () => a.startFeature('combine') },
        { label: 'Features ▸ Subtract Bodies…', icon: 'subtract', action: () => a.startFeature('combine', 'subtract') },
        { label: 'Features ▸ Delete Body…', icon: 'deleteBody', action: () => a.startFeature('deleteBody') },
        { label: 'Features ▸ Split…', icon: 'split', action: () => a.startFeature('split') },
        { label: 'Features ▸ Move/Copy Bodies…', icon: 'moveBody', action: () => a.startFeature('moveBody') },
        { label: 'Features ▸ Imported Body (STEP / STL)…', icon: 'import', action: () => a.importFile() },
        'sep',
        { label: 'Surface ▸ Extruded…', icon: 'surfExtrude', action: () => a.startFeature('surfExtrude') },
        { label: 'Surface ▸ Revolved…', icon: 'surfRevolve', action: () => a.startFeature('surfRevolve') },
        { label: 'Surface ▸ Planar…', icon: 'surfPlanar', action: () => a.startFeature('surfPlanar') },
        { label: 'Surface ▸ Offset…', icon: 'surfOffset', action: () => a.startFeature('surfOffset') },
        { label: 'Surface ▸ Copy…', icon: 'surfCopy', action: () => a.startFeature('surfCopy') },
        { label: 'Surface ▸ Knit…', icon: 'knit', action: () => a.startFeature('knit') },
        { label: 'Surface ▸ Convert to Solid…', icon: 'surfSolid', action: () => a.startFeature('surfSolid') },
        { label: 'Surface ▸ Repair Mesh…', icon: 'meshRepair', action: () => a.startFeature('meshRepair') },
        { label: 'Surface ▸ Thicken…', icon: 'thicken', action: () => a.startFeature('thicken') },
        { label: 'Surface ▸ Move/Copy Surfaces…', icon: 'moveBody', action: () => a.startFeature('moveBody', null, { surfaces: true }) },
        { label: 'Surface ▸ Delete Surface…', icon: 'deleteSurface', action: () => a.startFeature('deleteSurface') },
        'sep',
        { label: 'Reference Geometry ▸ Plane…', icon: 'refplane', action: () => a.startFeature('plane') },
        { label: 'Reference Geometry ▸ Axis…', icon: 'axis', action: () => a.startFeature('axis') },
        { label: 'Reference Geometry ▸ Point…', icon: 'refpoint', action: () => a.startFeature('point') },
      ],
      Tools: [
        { label: 'Settings…', icon: 'gear', action: () => this.showSettings() },
        'sep',
        { label: 'Measure…', icon: 'measure', action: () => a.startMeasure() },
        { label: 'Equations…', icon: 'equations', action: () => this.showEquations() },
        { label: 'Mass Properties…', icon: 'mass', action: () => this.showMassProps() },
        { label: 'Tolerance Stack-Up…', icon: 'measure', action: () => this.showStackUp() },
        { label: '3D Annotations…', icon: 'measure', action: () => a.manageAnnotations() },
        { label: 'Render…', icon: 'camera', action: () => a.renderView() },
        { label: 'Decals…', icon: 'sketchPicture', action: () => a.manageDecals() },
        { label: 'Section View…', icon: 'section', action: () => a.startSection() },
        { label: 'Edit Material…', icon: 'material', action: () => this.showMaterial() },
        { label: 'Fix References…', icon: 'fix', action: () => this.showFixReferences() },
        { label: 'Units: Millimetres', icon: '', action: () => a.setUnits('mm') },
        { label: 'Units: Inches', icon: '', action: () => a.setUnits('in') },
        'sep',
        { label: 'Ask Claude…', icon: 'assistant', action: () => this.openClaude() },
        { label: 'Claude Settings…', icon: 'gear', action: () => this.showClaudeSettings() },
      ],
      Help: [
        { label: 'Getting Started Tour', icon: 'help', action: () => this.startTour() },
        { label: 'Search Commands…', icon: 'search', key: 'Ctrl+K', action: () => this.commandSearch() },
        { label: 'Customize Shortcuts…', icon: 'select', action: () => this.showShortcutEditor() },
        { label: 'Keyboard Shortcuts', icon: '', action: () => this.showShortcuts() },
        { label: 'Report a Problem…', icon: 'error', action: () => this.reportProblemMenu() },
        { label: 'Open Crash Reports Folder', icon: 'open', action: () => a.openCrashFolder() },
        { label: 'Open Files With RazorCAD (.rcad .rasm .rdrw)…', icon: 'open', action: () => this.showFileTypes() },
        { label: 'Check for Updates…', icon: 'rebuild', action: () => this.checkForUpdates(true) },
        { label: 'About RazorCAD', icon: 'part', action: () => this.showAbout() },
      ],
    };
  }

  displayItems() {
    const a = this.app;
    return [['Shaded With Edges', 'shadedEdges'], ['Shaded', 'shaded'], ['Hidden Lines Removed', 'hlr'], ['Wireframe', 'wireframe']]
      .map(([l, v]) => ({ label: (a.viewport.displayStyle === v ? '● ' : '　') + l, icon: 'display', action: () => { a.viewport.setDisplayStyle(v); } }));
  }

  buildMenus() {
    const bar = $('#menubar');
    bar.innerHTML = '';
    for (const name of ['File', 'Edit', 'View', 'Insert', 'Tools', 'Help']) {
      const b = el('button', { 'data-menu': name }, esc(tr(name)));
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (b.classList.contains('open')) return this.closeDropdown();
        this.openDropdown(b, this.menuDefs()[name]);
      });
      b.addEventListener('pointerenter', () => {
        if ($('#menubar .open') && !b.classList.contains('open')) this.openDropdown(b, this.menuDefs()[name]);
      });
      bar.appendChild(b);
    }
    // quick buttons next to the menus
    const quick = el('div', { class: 'mb-quick' });
    for (const [ic, title, fn] of [['save', 'Save (Ctrl+S)', () => this.app.saveFile()], ['saveAs', 'Save As… (Ctrl+Shift+S)', () => this.app.saveFile(true)], ['rebuild', 'Rebuild (Ctrl+B)', () => this.app.refresh()], ['search', 'Search commands (Ctrl+K or /)', () => this.commandSearch()]]) {
      const q = el('button', { title }, icon(ic));
      q.onclick = fn;
      quick.appendChild(q);
    }
    bar.appendChild(quick);
  }

  openDropdown(btn, items) {
    this.closeDropdown();
    btn.classList.add('open');
    const dd = $('#dropdown');
    this.fillMenu(dd, items, () => this.closeDropdown());
    const r = btn.getBoundingClientRect();
    dd.style.left = r.left + 'px';
    dd.style.top = r.bottom + 'px';
    dd.hidden = false;
  }

  closeDropdown() {
    $('#dropdown').hidden = true;
    document.querySelectorAll('#menubar .open').forEach((b) => b.classList.remove('open'));
  }

  fillMenu(root, items, close) {
    root.innerHTML = '';
    for (const it of items) {
      if (it === 'sep') { root.appendChild(el('div', { class: 'msep' })); continue; }
      const row = el('div', { class: 'mi' + (it.disabled ? ' disabled' : '') },
        `<span class="mi-icon">${icon(it.icon)}</span><span class="mi-label">${esc(tr(it.label))}</span>${it.key ? `<span class="mi-key">${it.key}</span>` : ''}`);
      row.addEventListener('click', () => { close(); this.app.macros?.note(it.label); it.action(); });
      root.appendChild(row);
    }
  }

  showContext(x, y, items) {
    const cm = $('#ctxmenu');
    this.fillMenu(cm, items, () => this.closeContext());
    cm.hidden = false;
    const w = cm.offsetWidth, h = cm.offsetHeight;
    cm.style.left = Math.min(x, innerWidth - w - 4) + 'px';
    cm.style.top = Math.min(y, innerHeight - h - 4) + 'px';
  }

  closeContext() { $('#ctxmenu').hidden = true; document.querySelectorAll('[data-sketch-variants][aria-expanded="true"]').forEach(b=>b.setAttribute('aria-expanded','false')); }

  // ------------------------------------------------------------ Command ribbon
  commandDefs() {
    const a = this.app;
    const sk = a.mode === 'sketch';
    // keyboard shortcuts of the sketch tools (shown on their buttons)
    const KEYS = { select: 'S', line: 'L', rect: 'R', circle: 'C', arc: 'A', spline: 'N', polygon: 'P', trim: 'T', dim: 'D', convert: 'E', offset: 'O' };
    const s3 = a.mode === 'sketch3d';
    const S3 = new Set(S3_TOOLS); // (the tools a 3D sketch has)
    const KEYS3 = S3_KEYS;
    const tool = (t, ic, label) => (s3
      ? { id: 'tool-' + t, icon: ic, label, key: KEYS3[t], action: () => a.sketchTool(t), active: S3.has(t) && a.sketch3d.tool === t, disabled: !S3.has(t) }
      : { id: 'tool-' + t, icon: ic, label, key: KEYS[t], action: () => a.sketchTool(t), active: sk && a.sketcher.tool === t });
    // (2D-only commands: off in a 3D sketch)
    const only2d = (d) => (s3 ? { ...d, disabled: true, active: false } : d);
    return {
      features: [
        { icon: 'extrude', label: 'Extrude', action: () => a.startFeature('extrude', 'add') },
        { icon: 'revolve', label: 'Revolve', action: () => a.startFeature('revolve', 'add') },
        'sep',
        { icon: 'sweep', label: 'Sweep', action: () => a.startFeature('sweep', 'add') },
        { icon: 'loft', label: 'Loft', action: () => a.startFeature('loft', 'add') },
        'sep',
        { icon: 'cutExtrude', label: 'Extrude Cut', action: () => a.startFeature('extrude', 'cut') },
        { icon: 'cutRevolve', label: 'Revolve Cut', action: () => a.startFeature('revolve', 'cut') },
        { icon: 'cutSweep', label: 'Sweep Cut', action: () => a.startFeature('sweep', 'cut') },
        { icon: 'cutLoft', label: 'Loft Cut', action: () => a.startFeature('loft', 'cut') },
        { icon: 'hole', label: 'Hole', action: () => a.startFeature('hole') },
        { icon: 'folder', label: 'Library Feature', action: () => a.insertLibraryFeature() },
        'sep',
        { icon: 'helix', label: 'Helix', action: () => a.startFeature('helix') },
        { icon: 'threadCut', label: 'Thread Cut', action: () => a.startFeature('thread', 'cut') },
        { icon: 'threadExtrude', label: 'Thread Extrude', action: () => a.startFeature('thread', 'add') },
        { icon: 'cosmeticThread', label: 'Cosmetic Thread', action: () => a.startFeature('cosmeticThread') },
        { icon: 'wrap', label: 'Wrap (Emboss / Deboss)', action: () => a.startFeature('wrap') },
        'sep',
        { icon: 'lpattern', label: 'Linear Pattern', action: () => a.startFeature('lpattern') },
        { icon: 'cpattern', label: 'Circular Pattern', action: () => a.startFeature('cpattern') },
        { icon: 'mirror', label: 'Mirror', action: () => a.startFeature('mirror') },
        { icon: 'spattern', label: 'Sketch Driven Pattern', action: () => a.startFeature('spattern') },
        { icon: 'curvePattern', label: 'Curve Driven Pattern', action: () => a.startFeature('curvePattern') },
        { icon: 'spattern', label: 'Table Driven Pattern', action: () => a.startFeature('tablePattern') },
        { icon: 'fillPattern', label: 'Fill Pattern', action: () => a.startFeature('fillPattern') },
        'sep',
        { icon: 'fillet', label: 'Fillet', action: () => a.startFeature('fillet') },
        { icon: 'chamfer', label: 'Chamfer', action: () => a.startFeature('chamfer') },
        { icon: 'shell', label: 'Shell', action: () => a.startFeature('shell') },
        { icon: 'draft', label: 'Draft', action: () => a.startFeature('draft') },
        { icon: 'rib', label: 'Rib', action: () => a.startFeature('rib') },
        { icon: 'dome', label: 'Dome', action: () => a.startFeature('dome') },
        { icon: 'hole', label: 'Mounting Boss', action: () => a.startFeature('boss') },
        { icon: 'rib', label: 'Snap Hook', action: () => a.startFeature('snapHook') },
        { icon: 'shell', label: 'Lip / Groove', action: () => a.startFeature('lipGroove') },
        { icon: 'fillPattern', label: 'Vent', action: () => a.startFeature('vent') },
        { icon: 'split', label: 'Core and Cavity', action: () => a.startFeature('mold') },
        { icon: 'moveFace', label: 'Move Face', action: () => a.startFeature('moveFace') },
        { icon: 'scale', label: 'Scale', action: () => a.startFeature('scale') },
        'sep',
        { icon: 'combine', label: 'Combine', action: () => a.startFeature('combine') },
        { icon: 'subtract', label: 'Subtract Bodies', action: () => a.startFeature('combine', 'subtract') },
        { icon: 'split', label: 'Split', action: () => a.startFeature('split') },
        { icon: 'moveBody', label: 'Move/Copy Bodies', action: () => a.startFeature('moveBody') },
        { icon: 'deleteBody', label: 'Delete Body', action: () => a.startFeature('deleteBody') },
        'sep',
        { icon: 'refplane', label: 'Reference Plane', action: () => a.startFeature('plane') },
        { icon: 'axis', label: 'Reference Axis', action: () => a.startFeature('axis') },
        { icon: 'refpoint', label: 'Reference Point', action: () => a.startFeature('point') },

        { icon: 'import', label: 'Import STEP / STL', action: () => a.importFile() },
      ],
      sketch: [
        sk ? { id: 'sketch-toggle', icon: 'exitSketch', label: 'Exit Sketch', action: () => a.exitSketch(true) }
          : s3 ? { id: 'sketch-toggle', icon: 'exitSketch', label: 'Exit 3D Sketch', action: () => a.exitSketch3D(true) }
            : { id: 'sketch-toggle', icon: 'sketch', label: 'Sketch', action: () => a.startSketch() },
        { id: 'sketch3d-toggle', icon: 'sketch3d', label: '3D Sketch', action: () => (s3 ? null : a.startFeature('sketch3d')), active: s3 },
        tool('dim', 'smartdim', 'Dimension'),
        { icon: 'equations', label: 'Parameters', action: () => this.showEquations() },
        'sep',
        tool('select', 'select', 'Select'),
        tool('line', 'line', 'Line'),
        tool('centerline', 'centerline', 'Centerline'),
        tool('midline', 'line', 'Midpoint Line'),
        tool('rect', 'rect', 'Corner Rectangle'),
        tool('crect', 'crect', 'Center Rectangle'),
        tool('circle', 'circle', 'Circle'),
        tool('arc', 'arc', 'Centerpoint Arc'),
        tool('arc3', 'arc3', '3 Point Arc'),
        tool('tarc', 'tarc', 'Tangent Arc'),
        tool('ellipse', 'ellipse', 'Ellipse'),
        tool('spline', 'spline', s3 ? 'Spline' : 'Fit Point Spline'),
        tool('cspline', 'cspline', 'Control-Point Spline'),
        tool('point', 'point', 'Point'),
        tool('slot', 'slot', 'Straight Slot'),
        tool('cslot', 'slot', 'Center Point Slot'),
        tool('oslot', 'slot', 'Overall Slot'),
        tool('arcslot3', 'slot', '3 Point Arc Slot'),
        tool('arcslot', 'slot', 'Center Point Arc Slot'),
        tool('polygon', 'polygon', 'Polygon'),
        'sep',
        tool('trim', 'trim', 'Trim'),
        tool('extend', 'extend', 'Extend'),
        tool('split', 'skSplit', 'Split'),
        tool('convert', 'convert', 'Project Edges'),
        tool('offset', 'offset', 'Offset'),
        only2d({ icon: 'sketchMirror', label: 'Mirror', action: () => (sk ? a.sketcher.mirrorSelected() : a.startSketch()) }),
        only2d({ icon: 'dxfImport', label: 'Import DXF', action: () => (sk ? a.sketcher.importDXF() : a.startSketch()) }),
        only2d({ icon: 'sketchPicture', label: 'Sketch Picture', action: () => (sk ? a.sketcher.sketchPicture() : a.startSketch()) }),
        only2d({ icon: 'spline', label: 'Equation Curve', action: () => (sk ? a.sketcher.equationCurve() : a.startSketch()) }),
        only2d({ icon: 'skLinPattern', label: 'Linear Sketch Pattern', action: () => (sk ? a.sketcher.linearPatternSel() : a.startSketch()) }),
        only2d({ icon: 'skCirPattern', label: 'Circular Sketch Pattern', action: () => (sk ? a.sketcher.circularPatternSel() : a.startSketch()) }),
        only2d({ icon: 'skBlock', label: 'Make Block', action: () => (sk ? a.sketcher.makeBlock() : a.startSketch()) }),
        only2d({ id: 'tool-block', icon: 'skInsertBlock', label: 'Insert Block', action: () => (sk ? a.sketcher.insertBlock() : a.startSketch()), active: sk && a.sketcher.tool === 'block' }),
        only2d({ icon: 'skBlock', label: 'Explode Block', action: () => (sk ? a.sketcher.explodeBlocks() : a.startSketch()) }),
        tool('text', 'text', 'Text'),
        only2d({ icon: 'gear', label: 'Gears', action: () => a.startGears() }),
        only2d({ icon: 'airfoil', label: 'Airfoil', action: () => a.startAirfoil() }),
        tool('sfillet', 'sketchFillet', 'Sketch Fillet'),
        tool('schamfer', 'sketchChamfer', 'Sketch Chamfer'),
        only2d({ icon: 'intersectCurve', label: 'Intersection Curve', action: () => (sk ? a.sketcher.intersectionCurve() : a.startSketch()) }),
        s3 ? { icon: 'construction', label: 'Construction Geometry', key: 'Q', action: () => a.sketch3d.toggleConstruction(), disabled: ![...a.sketch3d.sel].some((id) => a.sketch3d.f?.segs.some((x) => x.id === id)) }
          : { icon: 'construction', label: 'Construction Geometry', key: 'Q', active: sk && a.sketcher.constructionMode, action: () => (sk ? a.sketcher.toggleConstruction() : a.startSketch()) },
        only2d({ icon: 'relations', label: 'Display Relations', action: () => (sk ? a.sketcher.toggleRelations() : a.startSketch()), active: sk && a.sketcher.relsVisible }),
        'sep',
        s3 ? { icon: 'trash', label: 'Delete', key: 'Del', action: () => a.sketch3d.deleteSelected(), disabled: !a.sketch3d.sel?.size }
          : { icon: 'trash', label: 'Delete', key: 'Del', action: () => a.sketcher.deleteSelected(), disabled: !sk || !a.sketcher.sel?.size },
      ],
      surfaces: [
        { icon: 'surfExtrude', label: 'Extruded Surface', action: () => a.startFeature('surfExtrude') },
        { icon: 'surfRevolve', label: 'Revolved Surface', action: () => a.startFeature('surfRevolve') },
        { icon: 'surfPlanar', label: 'Planar Surface', action: () => a.startFeature('surfPlanar') },
        { icon: 'surfLoft', label: 'Lofted Surface', action: () => a.startFeature('surfLoft') },
        { icon: 'surfSweep', label: 'Swept Surface', action: () => a.startFeature('surfSweep') },
        { icon: 'surfFill', label: 'Filled Surface', action: () => a.startFeature('surfFill') },
        { icon: 'boundarySurf', label: 'Boundary Surface', action: () => a.startFeature('boundarySurf') },
        { icon: 'surfOffset', label: 'Offset Surface', action: () => a.startFeature('surfOffset') },
        { icon: 'surfCopy', label: 'Copy Surface', action: () => a.startFeature('surfCopy') },
        'sep',
        { icon: 'surfTrim', label: 'Trim Surface', action: () => a.startFeature('surfTrim') },
        { icon: 'surfExtend', label: 'Extend Surface', action: () => a.startFeature('surfExtend') },
        { icon: 'untrim', label: 'Untrim Surface', action: () => a.startFeature('untrim') },
        { icon: 'splitLine', label: 'Split Line', action: () => a.startFeature('splitLine') },
        { icon: 'projCurve', label: 'Projected Curve', action: () => a.startFeature('projCurve') },
        { icon: 'compCurve', label: 'Composite Curve', action: () => a.startFeature('compCurve') },
        { icon: 'ruledSurface', label: 'Ruled Surface', action: () => a.startFeature('ruledSurface') },
        { icon: 'knit', label: 'Knit Surface', action: () => a.startFeature('knit') },
        { icon: 'surfSolid', label: 'Convert to Solid', action: () => a.startFeature('surfSolid') },
        { icon: 'deleteFace', label: 'Delete Face', action: () => a.startFeature('deleteFace') },
        { icon: 'fillet', label: 'Delete / Resize Fillet', action: () => a.startFeature('editFillet') },
        { icon: 'deleteFace', label: 'Defeature', action: () => a.startFeature('defeature') },
        { icon: 'replaceFace', label: 'Replace Face', action: () => a.startFeature('replaceFace') },
        { icon: 'surfPlanar', label: 'Fit Surface to Points', action: () => a.startFeature('fitSurface') },
        { icon: 'meshRepair', label: 'Repair Mesh', action: () => a.startFeature('meshRepair') },
        { icon: 'thicken', label: 'Thicken', action: () => a.startFeature('thicken') },
        { icon: 'flattenSurf', label: 'Flatten Surface', action: () => a.startFeature('flattenSurf') },
        'sep',
        { icon: 'split', label: 'Split (with a surface)', action: () => a.startFeature('split') },
        { icon: 'moveBody', label: 'Move/Copy Surfaces', action: () => a.startFeature('moveBody', null, { surfaces: true }) },
        { icon: 'deleteSurface', label: 'Delete Surface', action: () => a.startFeature('deleteSurface') },
      ],
      weldments: [
        { icon: 'sketch3d', label: '3D Sketch', action: () => a.startFeature('sketch3d') },
        { icon: 'structMember', label: 'Structural Member', action: () => a.startFeature('structMember') },
        { icon: 'sweep', label: 'Pipe Route', action: () => a.startFeature('pipeRoute') },
        { icon: 'sweep', label: 'Cable', action: () => a.startFeature('cable') },
        { icon: 'sweep', label: 'Duct Fitting', action: () => a.startFeature('ductFitting') },
        { icon: 'cutList', label: 'Spool Drawing', action: () => a.spoolDrawing() },
        { icon: 'cutList', label: 'Harness Formboard', action: () => a.harnessFormboard() },
        { icon: 'weldTrim', label: 'Trim/Extend', action: () => a.startFeature('weldTrim') },
        { icon: 'endCap', label: 'End Cap', action: () => a.startFeature('endCap') },
        { icon: 'weldGusset', label: 'Gusset', action: () => a.startFeature('weldGusset') },
        { icon: 'weldBead', label: 'Weld Bead', action: () => a.startFeature('weldBead') },
        'sep',
        { icon: 'cutList', label: 'Cut List', action: () => this.showCutList() },
      ],
      sheetmetal: [
        { icon: 'smBase', label: 'Base Flange', action: () => a.startFeature('smBase') },
        { icon: 'smExtrude', label: 'Sheet Metal Extrude', action: () => a.startFeature('smExtrude') },
        { icon: 'smLoft', label: 'Lofted Bend', action: () => a.startFeature('smLoft') },
        { icon: 'smTransition', label: 'Transition / Reducer', action: () => a.startFeature('smTransition') },
        { icon: 'smFlange', label: 'Edge Flange', action: () => a.startFeature('smFlange') },
        { icon: 'smProfileFlange', label: 'Miter Flange', action: () => a.startFeature('smProfileFlange') },
        { icon: 'smHem', label: 'Hem', action: () => a.startFeature('smHem') },
        { icon: 'smSketchBend', label: 'Sketched Bend', action: () => a.startFeature('smSketchBend') },
        { icon: 'smJog', label: 'Jog', action: () => a.startFeature('smJog') },
        { icon: 'smCrossBreak', label: 'Cross Break', action: () => a.startFeature('smCrossBreak') },
        { icon: 'smEtch', label: 'Etch Lines', action: () => a.startFeature('smEtch') },
        { icon: 'smTabSlot', label: 'Tab and Slot', action: () => a.startFeature('smTabSlot') },
        { icon: 'smForm', label: 'Forming Tools', action: () => a.startFeature('smForm') },
        { icon: 'smGusset', label: 'Gusset', action: () => a.startFeature('smGusset') },
        'sep',
        { icon: 'smCornerRelief', label: 'Corner Relief', action: () => a.startFeature('smCornerRelief') },
        { icon: 'smClosedCorner', label: 'Closed Corner', action: () => a.startFeature('smClosedCorner') },
        'sep',
        { icon: 'smUnfold', label: 'Unbend', action: () => a.startFeature('smUnfold') },
        { icon: 'smFold', label: 'Bend', action: () => a.startFeature('smFold') },
        { icon: 'smFlatten', label: 'Flatten', action: () => a.toggleFlatten(), active: !!a.flatView },
        'sep',
        { icon: 'smConvert', label: 'Convert to Sheet Metal', action: () => a.startFeature('smConvert') },
        { icon: 'sheetCheck', label: 'Sheet Metal Check', action: () => this.showSheetCheck() },
        'sep',
        { icon: 'dxf', label: 'Export DXF (flat pattern)', action: () => a.exportSheetDXF() },
        { icon: 'dxfAll', label: 'Export All DXF', action: () => a.exportSheetDXF(null, true) },
        { icon: 'dxfAll', label: 'Nest Flat Patterns', action: () => a.nestFlatPatterns() },
        { icon: 'gear', label: 'DXF Settings', action: () => this.showDxfSettings() },
      ],
      claude: [
        { icon: 'assistant', label: 'Ask Claude', action: () => this.toggleClaude(), active: !$('#claude-panel').hidden },
        { icon: 'newdoc', label: 'New Conversation', action: () => this.newClaudeChat() },
        'sep',
        { icon: 'gear', label: 'Claude Settings', action: () => this.showClaudeSettings() },
      ],
      evaluate: [
        { icon: 'measure', label: 'Measure', action: () => a.startMeasure(), active: a.pm?.kind === 'measure' },
        { icon: 'mass', label: 'Mass Properties', action: () => this.showMassProps() },
        { icon: 'measure', label: 'Tolerance Stack-Up', action: () => this.showStackUp() },
        { icon: 'measure', label: '3D Annotation', action: () => a.startAnnotation(), active: a.pm?.kind === 'annotate' },
        { icon: 'section', label: 'Section View', action: () => a.startSection(), active: !!a.viewport.section },
        { icon: 'equations', label: 'Equations', action: () => this.showEquations() },
        { icon: 'material', label: 'Edit Material', action: () => this.showMaterial() },
        'sep',
        { icon: 'interference', label: 'Interference Check', action: () => a.checkInterference() },
        { icon: 'zebra', label: 'Zebra Stripes', action: () => a.setAnalysis({ kind: 'zebra', density: 10 }), active: a.analysis?.kind === 'zebra' },
        { icon: 'camera', label: 'Render', action: () => a.renderView() },
        { icon: 'measure', label: 'DFM Check', action: () => a.dfmCheck() },
        { icon: 'sketchPicture', label: 'Decal', action: () => a.addDecal() },
        { icon: 'curvature', label: 'Curvature', action: () => a.setAnalysis({ kind: 'curvature' }), active: a.analysis?.kind === 'curvature' },
        { icon: 'draftAnalysis', label: 'Draft Analysis', action: () => (a.analysis?.kind === 'draft' ? a.setAnalysis(null) : this.showDraftAnalysis()), active: a.analysis?.kind === 'draft' },
        { icon: 'measure', label: 'Thickness Analysis', action: () => (a.analysis?.kind === 'thickness' ? a.setAnalysis(null) : this.showThicknessAnalysis()), active: a.analysis?.kind === 'thickness' },
        { icon: 'draftAnalysis', label: 'Undercut Check', action: () => (a.analysis?.kind === 'undercut' ? a.setAnalysis(null) : this.showDraftAnalysis('undercut')), active: a.analysis?.kind === 'undercut' },
        { icon: 'configs', label: 'Configurations', action: () => this.showConfigurations() },
        'sep',
        { icon: 'step', label: 'Export STEP', action: () => a.exportFile('step') },
        { icon: 'stl', label: 'Export STL', action: () => a.exportFile('stl') },
        { icon: 'obj', label: 'Export OBJ', action: () => a.exportFile('obj') },
        { icon: 'obj', label: 'Export glTF', action: () => a.exportFile('glb') },
        { icon: 'threemf', label: 'Export 3MF', action: () => a.exportFile('3mf') },
        { icon: 'dxf', label: a.flatView ? 'Export DXF (flat pattern)' : 'Export Face as DXF', action: () => a.exportFaceDXF(), disabled: !a.flatView && !(a.selection?.kind === 'face' && a.selection.face.planar) },
        { icon: 'import', label: 'Import STEP / STL / OBJ / 3MF', action: () => a.importFile() },
      ],
    };
  }

  renderCommandManager() {
    if (this.app.mode === 'drawing' && this.app.drawing) { this.app.drawing.renderCommandManager(); return; }
    if (this._tbDrag) { this._tbPending = true; return; } // (a button is being dragged: drawn again when it is dropped)
    const defs = this.commandDefs();
    const tabsList = this.toolbarTabs();
    if (!tabsList.some((t) => t.id === this.cmTab)) this.cmTab = 'features';
    const custom = this.customToolbar(this.cmTab);
    const btns = $('#cm-buttons');
    btns.innerHTML = '';
    // right-click on the ribbon's empty space
    if (!btns._ctx) {
      btns._ctx = true;
      btns.addEventListener('contextmenu', (e) => {
        if (e.target !== btns) return;
        e.preventDefault();
        this.showContext(e.clientX, e.clientY, [{ label: 'Customize Toolbars…', icon: 'gear', action: () => this.showToolbarCustomize(this.cmTab === 'claude' ? 'features' : this.cmTab) }, 'sep', ...this.iconSizeItems()]);
      });
    }
    const items = this.toolbarItems(this.cmTab, defs);
    for (const d of this.cmTab === 'sketch' && this.tbPrefs().sketchLayout === 'grouped' ? this.groupSketchTools(items) : items) {
      if (d === 'sep') { const s = el('div', { class: 'cm-sep' }); s.dataset.key = 'sep'; this.toolbarDraggable(s); btns.appendChild(s); continue; }
      const b = el('button', { class: 'cm-btn' + (d.active ? ' active' : ''), title: tr(d.label) + (d.key ? ` (${d.key})` : ''), disabled: d.disabled },
        `<span class="cm-ic">${icon(d.icon)}${d.key ? `<span class="cm-key">${esc(d.key)}</span>` : ''}</span><span>${esc(tr(d.label))}</span>`);
      b.dataset.key = cmdKey(d);
      if (d.children) {
        const group=el('div',{class:'cm-split'+(d.active?' active':''),role:'group','aria-label':tr(d.groupLabel),'data-group':d.id});
        group.dataset.key=cmdKey(d);b.dataset.sketchPrimary=d.primary.id;
        b.onclick=(e)=>{if(this._tbJustDragged){e.preventDefault();return;}this.app.macros?.note(d.primary.label);d.primary.action();};
        const arrow=el('button',{class:'cm-split-arrow',title:tr(d.groupLabel)+' variants','aria-label':tr(d.groupLabel)+' variants','aria-haspopup':'menu','aria-expanded':'false',disabled:d.disabled,'data-sketch-variants':d.id},'▾');
        const open=()=>{this.closeContext();const r=group.getBoundingClientRect();this.showContext(r.left,r.bottom,d.children);arrow.setAttribute('aria-expanded','true');};
        arrow.onclick=open;b.onkeydown=e=>{if(e.key==='ArrowDown'){e.preventDefault();open();}};
        group.addEventListener('contextmenu',(e)=>{e.preventDefault();this.showToolbarCustomize('sketch');});
        group.append(b,arrow);btns.appendChild(group);continue;
      }
      // (the click that ends a drag is not a press)
      b.addEventListener('click', (e) => { if (this._tbJustDragged) { e.preventDefault(); return; } this.app.macros?.note(d.label); d.action(); });
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); this.showContext(e.clientX, e.clientY, this.toolbarButtonMenu(d)); });
      this.toolbarDraggable(b);
      btns.appendChild(b);
    }
    if (custom && !custom.items.length) btns.appendChild(el('div', { class: 'cm-empty' }, `<b>${esc(custom.name)}</b> is empty. Drag buttons from the other toolbars onto its tab, right-click a button ▸ Add to "${esc(custom.name)}", or use <a href="#" class="cm-cust">Customize…</a>`));
    btns.querySelector('.cm-cust')?.addEventListener('click', (e) => { e.preventDefault(); this.showToolbarCustomize(this.cmTab); });
    const tabs = $('#cm-tabs');
    tabs.innerHTML = '';
    for (const t of tabsList) {
      const b = el('button', { class: (this.cmTab === t.id ? 'active' : '') + (t.id === 'claude' ? ' cm-tab-claude' : '') + (t.custom ? ' cm-tab-custom' : ''), title: t.id === 'claude' ? 'Model with Claude: describe a part or a change' : t.custom ? 'Your own toolbar (right-click to rename or delete it)' : '' }, t.html || esc(t.custom ? t.label : tr(t.label)));
      b.dataset.tab = t.id;
      if (t.custom) b.dataset.custom = '1';
      b.onclick = () => { this.cmTab = t.id; this.renderCommandManager(); };
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); this.showContext(e.clientX, e.clientY, this.toolbarTabMenu(t)); });
      tabs.appendChild(b);
    }
    const add = el('button', { class: 'cm-tab-add', title: 'New toolbar (your own, with any tools)' }, '+');
    add.onclick = () => this.newToolbar();
    tabs.appendChild(add);
  }

  // ------------------------------------------------------------ toolbar layout (the user's own)
  // prefs.toolbars: { order: { tab: [keys | 'sep'] }, hidden: { tab: [keys] }, custom: [{ id, name, items: [keys | 'sep'] }] }
  tbPrefs() {
    this.prefs ||= {};
    const t = (this.prefs.toolbars ||= {});
    t.order ||= {}; t.hidden ||= {}; t.custom ||= [];
    return t;
  }

  groupSketchTools(items) {
    const emitted = new Set();
    return items.flatMap((d) => {
      const group = SKETCH_TOOL_GROUPS.find((g) => g[2].some(t=>'tool-'+t===d.id));
      if (!group) return [d];
      if (emitted.has(group[0])) return [];
      emitted.add(group[0]);
      const children = items.filter((q) => group[2].some(t=>'tool-'+t===q.id));
      const primary=children.find(q=>q.active&&!q.disabled)||children.find(q=>q.id==='tool-'+this.tbPrefs().sketchVariants?.[group[0]]&&!q.disabled)||children.find(q=>!q.disabled)||children[0];
      return [{ ...primary, id: 'sketch-group-' + group[0], groupLabel:group[1], primary, children, active: children.some((q) => q.active), disabled: children.every((q) => q.disabled) }];
    });
  }

  rememberSketchTool(tool){
    const group=SKETCH_TOOL_GROUPS.find(g=>g[2].includes(tool));if(!group)return;
    const prefs=this.tbPrefs();prefs.sketchVariants ||= {};
    if(prefs.sketchVariants[group[0]]!==tool){prefs.sketchVariants[group[0]]=tool;this.savePrefs();}
  }
  // The browser version's notice above the window (closed for good with ✕).
  showWebNotice() {
    try { if (localStorage.getItem('razorcad.webNoticeClosed') === '1') return; } catch { /* no storage */ }
    if (document.getElementById('web-notice')) return;
    const bar = el('div', { id: 'web-notice', role: 'note' },
      `<span><b>RazorCAD in your browser.</b> Save downloads the file and Open reads one from your PC. There is no auto-save, Windows fonts or Ask Claude sign-in here: <a href="../#download" target="_blank" rel="noopener">get the Windows app</a> for those.</span><button class="x" title="Close">✕</button>`);
    bar.querySelector('.x').onclick = () => { bar.remove(); document.getElementById('app').classList.remove('with-notice'); try { localStorage.setItem('razorcad.webNoticeClosed', '1'); } catch { /* no storage */ } this.app.viewport?.resize?.(); };
    const root = document.getElementById('app');
    root.prepend(bar);
    root.classList.add('with-notice');
  }

  savePrefs() { platform.setPrefs(this.prefs || {}).catch?.(() => {}); }
  toolbarTabs() {
    const out = [['features', 'Features'], ['sketch', 'Sketch'], ['surfaces', 'Surfaces'], ['sheetmetal', 'Sheet Metal'], ['weldments', 'Fast Structure'], ['evaluate', 'Evaluate']].map(([id, label]) => ({ id, label }));
    for (const c of this.tbPrefs().custom) out.push({ id: 'custom:' + c.id, label: c.name, custom: true });
    out.push({ id: 'claude', label: 'Claude', html: `${icon('assistant')}Claude` });
    return out;
  }
  customToolbar(tab) { return String(tab).startsWith('custom:') ? this.tbPrefs().custom.find((c) => 'custom:' + c.id === tab) || null : null; }
  // every command of the built-in toolbars by its key, and the toolbar it comes from
  allCommands(defs = this.commandDefs()) {
    const m = new Map();
    for (const [tab, list] of Object.entries(defs)) for (const d of list) if (d !== 'sep' && !m.has(cmdKey(d))) m.set(cmdKey(d), { d, tab });
    return m;
  }
  // The buttons of a toolbar as laid out by the user (new commands of later versions at the end)
  toolbarItems(tab, defs) {
    const tb = this.tbPrefs();
    let out;
    const custom = this.customToolbar(tab);
    if (custom) {
      const all = this.allCommands(defs);
      out = custom.items.map((k) => (k === 'sep' ? 'sep' : all.get(k)?.d)).filter(Boolean);
    } else {
      const list = defs[tab] || [];
      const saved = tb.order[tab], hidden = new Set(tb.hidden[tab] || []);
      if (!saved) out = list.slice();
      else {
        const byKey = new Map(list.filter((d) => d !== 'sep').map((d) => [cmdKey(d), d]));
        out = [];
        for (const k of saved) {
          if (k === 'sep') out.push('sep');
          else if (byKey.has(k)) { out.push(byKey.get(k)); byKey.delete(k); }
        }
        // commands added since the order was saved: next to their neighbour in the standard layout
        const std = list.filter((d) => d !== 'sep');
        for (const d of byKey.values()) {
          const i = std.indexOf(d);
          let at = -1;
          for (let j = i - 1; j >= 0 && at < 0; j--) at = out.indexOf(std[j]);
          out.splice(at < 0 ? out.length : at + 1, 0, d);
        }
      }
      out = out.filter((d) => d === 'sep' || !hidden.has(cmdKey(d)));
    }
    // (no separator first, last or twice in a row)
    return out.filter((d, i, arr) => d !== 'sep' || (i > 0 && i < arr.length - 1 && arr[i - 1] !== 'sep'));
  }
  setToolbarItems(tab, keys) {
    const c = this.customToolbar(tab);
    if (c) c.items = keys;
    else this.tbPrefs().order[tab] = keys;
    this.savePrefs();
  }
  currentKeys(tab) { return this.toolbarItems(tab, this.commandDefs()).map((d) => (d === 'sep' ? 'sep' : cmdKey(d))); }
  addToToolbar(tab, key) {
    const c = this.customToolbar(tab);
    if (!c) return;
    if (key !== 'sep' && c.items.includes(key)) { this.app.status(`Already on ${c.name}.`); return; }
    c.items.push(key);
    this.savePrefs();
    this.renderCommandManager();
    this.app.status(`Added to ${c.name}.`);
  }
  async newToolbar(firstKey = null) {
    const name = (await this.promptText('New Toolbar', 'gear', 'Name of the toolbar (it appears as a tab next to the others):', 'My Tools'))?.trim();
    if (!name) return null;
    const c = { id: Date.now().toString(36), name, items: firstKey ? [firstKey] : [] };
    this.tbPrefs().custom.push(c);
    this.savePrefs();
    this.cmTab = 'custom:' + c.id;
    this.renderCommandManager();
    return c;
  }
  async renameToolbar(tab) {
    const c = this.customToolbar(tab);
    if (!c) return;
    const name = (await this.promptText('Rename Toolbar', 'rename', 'New name:', c.name))?.trim();
    if (!name) return;
    c.name = name;
    this.savePrefs();
    this.renderCommandManager();
  }
  async deleteToolbar(tab) {
    const c = this.customToolbar(tab);
    if (!c) return;
    const ok = await this.choose('Delete Toolbar', 'trash', `<p>Delete the toolbar <b>${esc(c.name)}</b>? (Its commands stay on the other toolbars.)</p>`, [['del', 'Delete', true], ['no', 'Cancel']]);
    if (ok !== 'del') return;
    const tb = this.tbPrefs();
    tb.custom = tb.custom.filter((x) => x !== c);
    this.savePrefs();
    if (this.cmTab === tab) this.cmTab = 'features';
    this.renderCommandManager();
  }
  resetToolbar(tab) {
    const tb = this.tbPrefs();
    delete tb.order[tab];
    delete tb.hidden[tab];
    this.savePrefs();
    this.renderCommandManager();
  }
  // ---- toolbar icon size: 'small' | 'medium' | 'large' (the ribbon's height follows it)
  applyIconSize() {
    const cm = $('#commandmanager'), size = this.prefs?.iconSize || 'medium';
    if (!cm) return;
    cm.classList.toggle('cm-small', size === 'small');
    cm.classList.toggle('cm-large', size === 'large');
    // (the views below get the new room)
    window.dispatchEvent(new Event('resize'));
  }
  setIconSize(size) {
    this.prefs ||= {};
    this.prefs.iconSize = size;
    this.savePrefs();
    this.applyIconSize();
    this.app.status(`Toolbar icons: ${size}.`);
  }
  iconSizeItems() {
    const cur = this.prefs?.iconSize || 'medium';
    return [['Small', 'small'], ['Medium', 'medium'], ['Large', 'large']].map(([l, v]) => ({ label: (cur === v ? '● ' : '　') + 'Toolbar Icons: ' + l, icon: '', action: () => this.setIconSize(v) }));
  }

  toolbarButtonMenu(d) {
    const key = cmdKey(d), tab = this.cmTab, custom = this.customToolbar(tab);
    const items = [];
    for (const c of this.tbPrefs().custom) if ('custom:' + c.id !== tab) items.push({ label: `Add to "${c.name}"`, icon: '', action: () => this.addToToolbar('custom:' + c.id, key) });
    items.push({ label: 'Add to a New Toolbar…', icon: '', action: () => this.newToolbar(key) });
    items.push('sep');
    if (custom) items.push({ label: 'Remove from This Toolbar', icon: 'trash', action: () => { this.setToolbarItems(tab, this.currentKeys(tab).filter((k) => k !== key)); this.renderCommandManager(); } });
    else items.push({ label: 'Hide from This Toolbar', icon: '', action: () => { const tb = this.tbPrefs(); (tb.hidden[tab] ||= []).push(key); this.savePrefs(); this.renderCommandManager(); this.app.status(`${d.label} hidden: Customize Toolbars… shows it again.`); } });
    items.push({ label: 'Add a Separator After', icon: '', action: () => { const keys = this.currentKeys(tab); keys.splice(keys.indexOf(key) + 1, 0, 'sep'); this.setToolbarItems(tab, keys); this.renderCommandManager(); } });
    items.push('sep', { label: 'Customize Toolbars…', icon: 'gear', action: () => this.showToolbarCustomize(tab) }, 'sep', ...this.iconSizeItems());
    return items;
  }
  toolbarTabMenu(t) {
    const tb = this.tbPrefs(), items = [];
    if (t.custom) items.push({ label: 'Rename…', icon: 'rename', action: () => this.renameToolbar(t.id) }, { label: 'Delete Toolbar', icon: 'trash', action: () => this.deleteToolbar(t.id) }, 'sep');
    else if (t.id !== 'claude' && (tb.order[t.id] || tb.hidden[t.id]?.length)) items.push({ label: 'Reset This Toolbar', icon: '', action: () => this.resetToolbar(t.id) }, 'sep');
    items.push({ label: 'New Toolbar…', icon: '', action: () => this.newToolbar() }, { label: 'Customize Toolbars…', icon: 'gear', action: () => this.showToolbarCustomize(t.id === 'claude' ? 'features' : t.id) }, 'sep', ...this.iconSizeItems());
    return items;
  }

  // Drag a toolbar button (or separator) to a new place: the others move aside as it goes. Dropped on
  // the tab of one of your own toolbars it is added there; dragged off your own toolbar it is removed.
  toolbarDraggable(node) {
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const sx = e.clientX, sy = e.clientY;
      const move = (ev) => {
        if (!this._tbDrag) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
          this.toolbarDragStart(node, ev);
        }
        this.toolbarDragMove(ev);
      };
      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (this._tbDrag) this.toolbarDragEnd(ev);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }
  toolbarDragStart(node, ev) {
    const r = node.getBoundingClientRect();
    const ghost = node.cloneNode(true);
    ghost.classList.add('cm-ghost');
    Object.assign(ghost.style, { width: r.width + 'px', height: r.height + 'px', left: r.left + 'px', top: r.top + 'px' });
    document.body.appendChild(ghost);
    node.classList.add('cm-dragging');
    this._tbDrag = { node, ghost, dx: ev.clientX - r.left, dy: ev.clientY - r.top, tab: this.cmTab };
  }
  toolbarDragMove(ev) {
    const d = this._tbDrag, bar = $('#cm-buttons'), br = bar.getBoundingClientRect();
    d.ghost.style.left = ev.clientX - d.dx + 'px';
    d.ghost.style.top = ev.clientY - d.dy + 'px';
    // over the tab of one of your own toolbars: added there when dropped
    const tabEl = document.elementsFromPoint(ev.clientX, ev.clientY).find((x) => x.dataset?.tab);
    $('#cm-tabs').querySelectorAll('.cm-drop').forEach((x) => x.classList.remove('cm-drop'));
    d.overTab = tabEl?.dataset.custom && tabEl.dataset.tab !== d.tab ? tabEl.dataset.tab : null;
    if (d.overTab) tabEl.classList.add('cm-drop');
    d.outside = !d.overTab && (ev.clientY < br.top - 24 || ev.clientY > br.bottom + 24);
    d.ghost.classList.toggle('cm-ghost-remove', !!(d.outside && this.customToolbar(d.tab)));
    if (d.overTab || d.outside) return;
    // its new place: before the first button whose middle is to the right of the pointer; the others
    // slide over to make room
    // (two rows, filled column by column: the button nearest the pointer; before it when the pointer is on
    // its left half (same row) or above it, else after it)
    const kids = [...bar.children].filter((k) => k !== d.node && k.dataset.key);
    let near = null, nd = Infinity;
    for (const k of kids) {
      const kr = k.getBoundingClientRect();
      const dx = Math.max(kr.left - ev.clientX, 0, ev.clientX - kr.right), dy = Math.max(kr.top - ev.clientY, 0, ev.clientY - kr.bottom);
      if (dx * dx + dy * dy < nd) { nd = dx * dx + dy * dy; near = k; }
    }
    let before = null;
    if (near) {
      const kr = near.getBoundingClientRect();
      const first = ev.clientY < kr.top || (ev.clientY <= kr.bottom && ev.clientX < kr.left + kr.width / 2);
      before = first ? near : near.nextElementSibling;
    }
    if (before === d.node) before = d.node.nextElementSibling;
    if (d.node.nextElementSibling === before && d.node.parentNode === bar) return;
    const was = new Map(kids.map((k) => { const r0 = k.getBoundingClientRect(); return [k, [r0.left, r0.top]]; }));
    bar.insertBefore(d.node, before);
    for (const k of kids) {
      const r1 = k.getBoundingClientRect(), [x0, y0] = was.get(k), sx = x0 - r1.left, sy = y0 - r1.top;
      if (!sx && !sy) continue;
      k.style.transition = 'none';
      k.style.transform = `translate(${sx}px, ${sy}px)`;
      requestAnimationFrame(() => { k.style.transition = 'transform 140ms ease'; k.style.transform = ''; });
    }
  }
  toolbarDragEnd() {
    const d = this._tbDrag;
    this._tbDrag = null;
    d.ghost.remove();
    d.node.classList.remove('cm-dragging');
    $('#cm-tabs').querySelectorAll('.cm-drop').forEach((x) => x.classList.remove('cm-drop'));
    this._tbJustDragged = true;
    setTimeout(() => { this._tbJustDragged = false; }, 0);
    const keys = [...$('#cm-buttons').children].map((k) => k.dataset.key).filter(Boolean);
    if (d.overTab) this.addToToolbar(d.overTab, d.node.dataset.key);
    else if (d.outside && this.customToolbar(d.tab)) { this.setToolbarItems(d.tab, keys.filter((_, i) => [...$('#cm-buttons').children].filter((k) => k.dataset.key)[i] !== d.node)); this.app.status('Removed from the toolbar.'); }
    else if (!d.outside) this.setToolbarItems(d.tab, keys);
    this._tbPending = false;
    this.renderCommandManager();
  }

  // Customize Toolbars: your own toolbars (new, rename, delete), any command added to them, and the
  // built-in toolbars' hidden buttons shown again. (Buttons are rearranged by dragging them.)
  showToolbarCustomize(tab = this.cmTab) {
    let target = tab === 'claude' ? 'features' : tab;
    const box = el('div', { class: 'tb-cust' });
    const draw = () => {
      box.innerHTML = '';
      const tabsList = this.toolbarTabs().filter((t) => t.id !== 'claude');
      if (!tabsList.some((t) => t.id === target)) target = 'features';
      const custom = this.customToolbar(target);
      const top = el('div', { class: 'tb-cust-top' });
      const sel = el('select');
      for (const t of tabsList) { const o = el('option', { value: t.id }, esc(t.label + (t.custom ? '  (yours)' : ''))); if (t.id === target) o.selected = true; sel.appendChild(o); }
      sel.onchange = () => { target = sel.value; draw(); };
      top.append(el('span', {}, 'Toolbar'), sel);
      const btn = (label, fn, primary = false) => { const b = el('button', { class: 'pm-btn' + (primary ? ' primary' : '') }, esc(label)); b.onclick = fn; top.appendChild(b); };
      btn('New…', async () => { const c = await this.newToolbar(); if (c) { target = 'custom:' + c.id; draw(); } });
      if (custom) {
        btn('Rename…', async () => { await this.renameToolbar(target); draw(); });
        btn('Delete', async () => { await this.deleteToolbar(target); draw(); });
        btn('Add Separator', () => { this.addToToolbar(target, 'sep'); draw(); });
      } else btn('Reset', () => { this.resetToolbar(target); draw(); });
      box.appendChild(top);
      if (target === 'sketch') {
        const layout = el('select', { 'data-sketch-layout': '' });
        layout.append(el('option', { value: 'expanded' }, 'Expanded (all tools)'), el('option', { value: 'grouped' }, 'Grouped (flyout menus)'));
        layout.value = this.tbPrefs().sketchLayout || 'expanded';
        layout.onchange = () => { this.tbPrefs().sketchLayout = layout.value; this.savePrefs(); this.renderCommandManager(); };
        box.appendChild(this.row('Sketch toolbar layout', layout));
      }
      box.appendChild(el('div', { class: 'pm-hint' }, custom ? 'Add any command to your toolbar. Drag its buttons on the toolbar to rearrange them, or drag one off the toolbar to remove it.' : 'Built-in toolbar: drag its buttons to rearrange them; hidden buttons can be shown again here. To gather tools from several toolbars, make a toolbar of your own (New…).'));
      const on = new Set(this.currentKeys(target));
      const all = this.allCommands();
      const groups = new Map();
      for (const [key, { d, tab: from }] of all) {
        if (!custom && from !== target) continue;
        if (!groups.has(from)) groups.set(from, []);
        groups.get(from).push({ key, d });
      }
      const names = Object.fromEntries(this.toolbarTabs().map((t) => [t.id, t.label]));
      const list = el('div', { class: 'tb-cust-list' });
      for (const [from, rows] of groups) {
        list.appendChild(el('div', { class: 'tb-cust-group' }, esc(names[from] || from)));
        for (const { key, d } of rows) {
          const row = el('div', { class: 'tb-cust-row' }, `<span class="ic">${icon(d.icon)}</span><span class="lb">${esc(d.label)}</span>`);
          const has = on.has(key);
          const b = el('button', { class: 'pm-btn' }, custom ? (has ? 'Remove' : 'Add') : has ? 'Hide' : 'Show');
          b.onclick = () => {
            if (custom) {
              if (has) this.setToolbarItems(target, this.currentKeys(target).filter((k) => k !== key));
              else custom.items.push(key), this.savePrefs();
            } else {
              const tb = this.tbPrefs(), h = new Set(tb.hidden[target] || []);
              if (has) h.add(key); else h.delete(key);
              tb.hidden[target] = [...h];
              this.savePrefs();
            }
            this.renderCommandManager();
            draw();
          };
          row.appendChild(b);
          list.appendChild(row);
        }
      }
      box.appendChild(list);
    };
    draw();
    this.modal('Customize Toolbars', 'gear', box, [{ label: 'Done', primary: true }]);
  }

  setCmTab(t) { this.cmTab = t; this.renderCommandManager(); }

  refreshCommandStates() {
    if (this.app.mode === 'drawing') { this.renderCommandManager(); return; }
    this.renderCommandManager();
    this.renderHUD();
    this.renderConfirmCorner();
  }

  // ------------------------------------------------------------ left panel
  buildLeftTabs() {
    const [t, p, c] = document.querySelectorAll('#lp-tabs button');
    t.innerHTML = icon('tree');
    p.innerHTML = icon('pmIcon');
    c.innerHTML = icon('configs');
    t.onclick = () => { this._leaveConfig = true; this.showLeft('tree'); this._leaveConfig = false; };
    p.onclick = () => this.showLeft('pm');
    c.onclick = () => this.showLeft('config');
  }

  // which = 'tree' | 'pm' | 'config' (the Configurations tab stays up until another tab is picked)
  showLeft(which) {
    const cfgOk = this.app.mode !== 'drawing' || !!this.app.drawing?.renderConfigs; // (parts and assemblies)
    if (which === 'tree' && this.leftTab === 'config' && cfgOk && !this._leaveConfig) which = 'config';
    if (which === 'config' && !cfgOk) which = 'tree';
    this.leftTab = which;
    $('#tree').hidden = which !== 'tree';
    $('#pm').hidden = which !== 'pm';
    $('#configs').hidden = which !== 'config';
    const cb = document.querySelector('#lp-tabs button[data-tab="config"]');
    if (cb) cb.hidden = !cfgOk;
    document.querySelectorAll('#lp-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === which));
    if (which === 'config') this.renderConfigs();
  }

  // ------------------------------------------------------------ Configurations tab
  // The part's configurations: Default and each one, the one shown marked. Double-click shows one; right-
  // click for more. Each sets other values for the global variables and suppresses features.
  renderConfigs() {
    const a = this.app, doc = a.doc, root = $('#configs');
    if (!root || root.hidden) return;
    if (a.mode === 'drawing') { a.drawing?.renderConfigs?.(root); return; } // (an assembly's own configurations)
    if (!doc) return;
    root.innerHTML = '';
    const active = doc.activeConfig || null;
    const head = el('div', { class: 'cfg-head' }, `${icon('configs')}<span><b>${esc(doc.name)}</b> Configuration(s)</span>`);
    root.appendChild(head);
    const bar = el('div', { class: 'cfg-bar' });
    const addB = el('button', { class: 'pm-btn', title: 'A new configuration, starting as the one shown' }, '+ Add Configuration');
    addB.onclick = () => a.addConfig();
    const tableB = el('button', { class: 'pm-btn', title: 'All configurations in a table: variable values and suppressed features (CSV in / out)' }, 'Design Table…');
    tableB.onclick = () => this.showConfigurations();
    bar.append(addB, tableB);
    root.appendChild(bar);
    const nameOf = (id) => doc.features.find((f) => f.id === id)?.name || id;
    const summary = (c) => {
      if (!c) return 'the part as modelled';
      const v = Object.entries(c.vals || {}).filter(([, x]) => String(x).trim() !== '').map(([k, x]) => `${k} = ${x}`);
      const s = (c.suppressed || []).map(nameOf), u = (c.unsuppressed || []).map(nameOf);
      return [...v, ...(s.length ? [`suppressed: ${s.join(', ')}`] : []), ...(u.length ? [`unsuppressed: ${u.join(', ')}`] : [])].join('; ') || 'same as Default';
    };
    const item = (c) => {
      const id = c?.id || null, on = id === active;
      const n = el('div', { class: 'tn cfg-item' + (on ? ' cfg-active' : '') + (this._cfgSel === (id || '__default') ? ' selected' : ''), title: `${c ? c.name : 'Default'}: ${summary(c)}\nDouble-click to show it` });
      n.innerHTML = `<span class="tw"></span><span class="ti">${icon(on ? 'ok' : 'configs')}</span><span class="tl">${esc(c ? c.name : 'Default')}</span><span class="tsub">${esc(summary(c))}</span>`;
      n.onclick = () => { this._cfgSel = id || '__default'; this.renderConfigs(); };
      n.ondblclick = () => a.setActiveConfig(id);
      n.oncontextmenu = (e) => {
        e.preventDefault();
        this._cfgSel = id || '__default';
        this.renderConfigs();
        const items = [{ label: 'Show Configuration', icon: 'show', action: () => a.setActiveConfig(id), disabled: on }];
        if (c) items.push(
          { label: 'Rename', icon: 'rename', action: () => this.promptText('Rename Configuration', 'configs', 'Name', c.name).then((v) => { if (v?.trim()) { c.name = v.trim(); a.commit(); this.renderConfigs(); this.renderTree(); } }) },
          { label: 'Copy Configuration', icon: 'configs', action: () => a.addConfig(c.id) },
          { label: 'Properties (Design Table)…', icon: 'configs', action: () => this.showConfigurations() },
          'sep',
          { label: 'Delete', icon: 'trash', action: () => a.deleteConfig(c.id) },
        );
        else items.push({ label: 'Add Configuration', icon: 'configs', action: () => a.addConfig() });
        this.showContext(e.clientX, e.clientY, items);
      };
      root.appendChild(n);
    };
    item(null);
    for (const c of doc.configs || []) item(c);
    root.appendChild(el('div', { class: 'pm-hint', style: 'padding:8px 12px' },
      (doc.equations || []).some((e) => e.name)
        ? 'Double-click a configuration to show it. While one is shown, Suppress / Unsuppress in the tree changes that configuration only; its variable values are set in the Design Table.'
        : 'Configurations give the global variables other values (add variables in Equations, e.g. <code>length = 100</code>) and suppress features. Double-click one to show it; while it is shown, Suppress in the tree changes it only.'));
  }

  buildSplitter() {
    const sp = $('#splitter');
    sp.addEventListener('pointerdown', (e) => {
      sp.setPointerCapture(e.pointerId);
      const move = (ev) => document.documentElement.style.setProperty('--lp-width', Math.max(200, Math.min(520, ev.clientX)) + 'px');
      const up = () => { sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
    });
  }

  // ------------------------------------------------------------ feature tree
  renderTree() {
    if (this.app.mode === 'drawing' && this.app.drawing) { this.app.drawing.renderTree(); return; }
    const a = this.app, doc = a.doc, res = a.result;
    const root = $('#tree');
    root.innerHTML = '';
    const sel = a.selection;
    const editingId = a.pm?.feature?.id || (a.mode === 'sketch' ? a.sketcher.f?.id : null);

    const node = (opts) => {
      const n = el('div', {
        class: 'tn' + (opts.cls ? ' ' + opts.cls : '') + (opts.selected ? ' selected' : '') + (opts.editing ? ' editing' : '') + (opts.suppressed ? ' suppressed' : ''),
        title: opts.title || '',
      });
      n.style.paddingLeft = 6 + (opts.depth || 0) * 16 + 'px';
      if (opts.fid) n.dataset.fid = opts.fid;
      n.innerHTML = `<span class="tw">${opts.twisty ?? ''}</span><span class="ti">${icon(opts.icon)}</span><span class="tl">${esc(tr(opts.label))}</span>${opts.sub ? `<span class="tsub">${esc(opts.sub)}</span>` : ''}${opts.error ? `<span class="terr" title="${esc(opts.error)}">!</span>` : ''}<span class="tvis"></span>`;
      // the visibility column: an eye to show or hide the item
      if (opts.vis && opts.vis.on !== null && opts.vis.on !== undefined) {
        const v = n.querySelector('.tvis');
        v.innerHTML = icon(opts.vis.on ? 'visOn' : 'visOff');
        v.classList.add(opts.vis.on ? 'on' : 'off');
        v.title = opts.vis.on ? 'Shown — click to hide' : 'Hidden — click to show';
        v.addEventListener('click', (e) => { e.stopPropagation(); opts.vis.toggle(); });
        v.addEventListener('dblclick', (e) => e.stopPropagation());
      }
      if (opts.onTwisty) n.querySelector('.tw').addEventListener('click', (e) => { e.stopPropagation(); opts.onTwisty(); });
      n.addEventListener('click', (e) => opts.onClick?.(e));
      n.addEventListener('dblclick', (e) => opts.onDbl?.(e));
      n.addEventListener('contextmenu', (e) => { e.preventDefault(); opts.onClick?.(e); if (opts.menu) this.showContext(e.clientX, e.clientY, opts.menu()); });
      if (opts.onHover) {
        n.addEventListener('pointerenter', () => { this.treeHover = { el: n, off: () => opts.onHover(false) }; opts.onHover(true); });
        n.addEventListener('pointerleave', () => { if (this.treeHover?.el === n) this.treeHover = null; opts.onHover(false); });
      }
      root.appendChild(n);
      return n;
    };

    const mat = MATERIALS.find((m) => m.id === doc.material);
    node({
      icon: 'part', label: doc.name + (a.activeConfig() ? ` (${a.activeConfig().name})` : ''), cls: 'tree-part',
      onDbl: (e) => this.inlineRename(e.currentTarget, doc.name, (v) => { doc.name = v; a.commit(); a.updateTitle(); }),
      menu: () => [
        { label: 'Rename', icon: 'rename', action: () => this.inlineRename(root.querySelector('.tree-part'), doc.name, (v) => { doc.name = v; a.commit(); a.updateTitle(); }) },
        { label: 'Equations…', icon: 'equations', action: () => this.showEquations() },
        { label: 'Mass Properties…', icon: 'mass', action: () => this.showMassProps() },
      ],
    });
    // Solid Bodies / Surface Bodies folders, with user folders and one group per multi-body import
    const kindOfBody = (b) => (b.sheet ? 'sheet' : b.kind || 'solid');
    for (const [kind, key, folderIcon, title] of [['solid', '__bodies', 'bodies', 'Solid Bodies'], ['sheet', '__sheets', 'sheetBodies', 'Sheet Metal Bodies'], ['surface', '__surfaces', 'surfaces', 'Surface Bodies']]) {
      const bodies = (res?.bodies || []).filter((b) => kindOfBody(b) === kind);
      if (!bodies.length) continue;
      const closed = this.collapsed.has(key);
      const toggle = () => { closed ? this.collapsed.delete(key) : this.collapsed.add(key); this.renderTree(); };
      node({
        icon: folderIcon, label: `${title}(${bodies.length})`, depth: 1, cls: 'tree-bodies',
        twisty: closed ? '▶' : '▼', onTwisty: toggle, onDbl: toggle,
        menu: () => [
          ...(kind === 'sheet' ? [
            { label: 'Export All Flat Patterns as DXF…', icon: 'dxfAll', action: () => a.exportSheetDXF(null, true) },
            { label: 'DXF Settings…', icon: 'gear', action: () => this.showDxfSettings() },
            'sep',
          ] : []),
          { label: 'Export All Bodies as STEP…', icon: 'step', action: () => a.exportFile('step') },
          ...(kind === 'solid' && bodies.length > 1 ? [{ label: 'Exploded View…', icon: 'explode', action: () => a.startExplode() }] : []),
          { label: 'New Folder', icon: 'folder', action: () => a.newBodyFolder(kind) },
        ],
      });
      if (closed) continue;
      const bodyNode = (b, depth) => {
        const n = node({
          icon: kind === 'surface' ? 'surfBody' : kind === 'sheet' ? 'sheetBody' : 'body', label: b.name, depth, sub: kind === 'sheet' ? `${+b.sheet.t.toFixed(3)} mm${b.ownMaterial ? ' · ' + b.material?.name : ''}` : b.ownMaterial ? b.material?.name : '',
          cls: a.isBodyHidden?.(b.id) ? 'hidden-item' : '',
          vis: { on: !a.isBodyHidden?.(b.id), toggle: () => a.setBodyHidden(b.id, !a.isBodyHidden(b.id)) },
          title: (kind === 'surface' ? `${b.name} (surface body)` : `${b.name}${kind === 'sheet' ? ` (sheet metal, ${+b.sheet.t.toFixed(3)} mm, ${b.sheet.bends} bend${b.sheet.bends === 1 ? '' : 's'})` : ''}\nMaterial: ${b.material?.name || 'not specified'}${b.ownMaterial ? '' : ' (part material)'}`) + '\nDouble-click to rename, right-click for Body Properties',
          selected: sel?.kind === 'body' && sel.id === b.id,
          onClick: () => a.selectBody(b.id),
          onDbl: () => this.renameBody(b.id),
          onHover: (on) => a.setHoverBody(on ? b.id : null),
          menu: () => this.bodyMenu(b),
        });
        n.dataset.body = b.id;
      };
      // identical bodies: one item with their count, opened to list each one
      const listBodies = (list, depth) => {
        for (const g of groupBodies(list)) {
          if (g.members.length < 2) { bodyNode(g.rep, depth); continue; }
          const b = g.rep, gkey = 'same:' + b.id, isOpen = this.collapsed.has(gkey);
          const ids = g.members.map((x) => x.id);
          const toggleOpen = () => { isOpen ? this.collapsed.delete(gkey) : this.collapsed.add(gkey); this.renderTree(); };
          const n = node({
            icon: kind === 'sheet' ? 'sheetBody' : 'body', label: `${b.name}`, depth,
            sub: `×${g.members.length}${kind === 'sheet' ? ` · ${+b.sheet.t.toFixed(3)} mm` : ''}${b.ownMaterial ? ' · ' + b.material?.name : ''}`,
            cls: 'tree-same' + (g.members.every((x) => a.isBodyHidden?.(x.id)) ? ' hidden-item' : ''),
            vis: { on: !g.members.every((x) => a.isBodyHidden?.(x.id)), toggle: () => a.setBodiesHidden(ids, !g.members.every((x) => a.isBodyHidden(x.id))) },
            title: `${g.members.length} identical bodies (same shape${kind === 'sheet' ? ', thickness and flat pattern' : ''} and material): ${g.members.map((x) => x.name).join(', ')}\nOpen it to see each one`,
            twisty: isOpen ? '▼' : '▶', onTwisty: toggleOpen,
            selected: sel?.kind === 'body' && ids.includes(sel.id),
            onClick: () => a.selectBody(b.id),
            onDbl: toggleOpen,
            onHover: (on) => a.setHoverBody(on ? b.id : null),
            menu: () => [
              { label: `Isolate All ${g.members.length}`, icon: 'isolate', action: () => a.isolateBodies(ids) },
              g.members.every((x) => a.isBodyHidden(x.id))
                ? { label: `Show All ${g.members.length}`, icon: 'show', action: () => ids.forEach((id) => a.setBodyHidden(id, false)) }
                : { label: `Hide All ${g.members.length}`, icon: 'hide', action: () => ids.forEach((id) => a.setBodyHidden(id, true)) },
              a.transparencyItem(ids),
              'sep',
              ...this.bodyMenu(b),
            ],
          });
          n.dataset.body = b.id;
          if (isOpen) for (const x of g.members) bodyNode(x, depth + 1);
        }
      };
      const groupNode = (gkey, label, ic, members, { open, menu } = {}) => {
        const isOpen = open();
        const n = node({
          icon: ic, label: `${label}(${members.length})`, depth: 2, cls: 'tree-folder',
          twisty: isOpen ? '▼' : '▶', onTwisty: () => { this.toggleGroup(gkey); this.renderTree(); }, onDbl: () => { this.toggleGroup(gkey); this.renderTree(); },
          menu,
        });
        n.dataset.folder = gkey;
        if (isOpen) listBodies(members, 3);
      };
      const inFolder = new Set();
      for (const g of (doc.bodyFolders || []).filter((x) => (x.kind || 'solid') === kind)) {
        const members = bodies.filter((b) => g.bodies.includes(b.id));
        members.forEach((b) => inFolder.add(b.id));
        groupNode(g.id, g.name, 'folder', members, {
          open: () => !this.collapsed.has(g.id),
          menu: () => [
            { label: 'Rename Folder', icon: 'rename', action: () => this.renameFolder(g.id) },
            { label: 'Delete Folder (keep the bodies)', icon: 'trash', action: () => a.deleteBodyFolder(g.id) },
          ],
        });
      }
      // bodies of one import (a multi-body STEP file) are grouped together, closed at first
      const byImport = new Map();
      for (const b of bodies) {
        if (inFolder.has(b.id)) continue;
        const owner = findFeature(doc, bodyOwner(b.id));
        if (owner?.type === 'import') { if (!byImport.has(owner.id)) byImport.set(owner.id, []); byImport.get(owner.id).push(b); }
      }
      for (const [fid, members] of byImport) {
        if (members.length < 2) continue;
        members.forEach((b) => inFolder.add(b.id));
        groupNode('imp:' + fid, findFeature(doc, fid).name, 'import', members, {
          open: () => this.collapsed.has('imp:' + fid), // closed unless opened
          menu: () => [{ label: 'Move to a New Folder', icon: 'folder', action: () => a.newBodyFolder(kind, findFeature(doc, fid).name, members.map((b) => b.id)) }],
        });
      }
      listBodies(bodies.filter((b) => !inFolder.has(b.id)), 2);
    }
    if ((doc.explodes || []).length) {
      const key = '__explodes', closed = this.collapsed.has(key);
      node({ icon: 'explode', label: `Exploded Views (${doc.explodes.length})`, depth: 1, cls: 'tree-folder', twisty: closed ? '▶' : '▼', onTwisty: () => { closed ? this.collapsed.delete(key) : this.collapsed.add(key); this.renderTree(); } });
      if (!closed) for (const ex of doc.explodes) {
        const on = doc.exploded === ex.id;
        node({
          icon: 'explode', label: ex.name, depth: 2, sub: on ? 'exploded' : '', cls: on ? '' : 'hidden-item',
          title: `${ex.steps.length} step${ex.steps.length === 1 ? '' : 's'} — double-click to ${on ? 'collapse' : 'explode'}`,
          onDbl: () => a.setExploded(on ? null : ex.id, true),
          menu: () => [
            on ? { label: 'Collapse', icon: 'explode', action: () => a.setExploded(null) } : { label: 'Explode', icon: 'explode', action: () => a.setExploded(ex.id) },
            { label: on ? 'Animate Collapse' : 'Animate Explode', icon: 'explode', action: () => a.setExploded(on ? null : ex.id, true) },
            { label: 'Edit Exploded View', icon: 'edit', action: () => a.startExplode(ex.id) },
            { label: 'Rename', icon: 'rename', action: () => this.promptText('Rename', 'explode', 'Name', ex.name).then((v) => { if (v?.trim()) { ex.name = v.trim(); a.commit(); this.renderTree(); } }) },
            'sep',
            { label: 'Delete', icon: 'trash', action: () => a.deleteExplode(ex.id) },
          ],
        });
      }
    }
    node({
      icon: 'material', label: mat ? mat.name : 'Material <not specified>', depth: 1,
      onDbl: () => this.showMaterial(),
      menu: () => [{ label: 'Edit Material…', icon: 'material', action: () => this.showMaterial() }],
    });
    for (const key of Object.keys(STD_PLANES)) {
      node({
        // (its axes beside it: with Z up the Top plane is XY, see wcs.js)
        icon: 'plane', label: STD_PLANES[key].name, sub: W.stdPlaneAxes(key), title: `${STD_PLANES[key].name}: the ${W.stdPlaneAxes(key)} plane (${W.getUp().toUpperCase()} up)`, depth: 1, fid: key,
        cls: a.stdPlaneShown(key) ? '' : 'hidden-item',
        vis: { on: a.stdPlaneShown(key), toggle: () => a.setStdPlaneVisible(key, !a.stdPlaneShown(key)) },
        selected: sel?.kind === 'plane' && sel.id === key,
        onClick: () => a.treePickPlane(key),
        onHover: (on) => a.setHoverPlane(on ? key : null),
        menu: () => [
          { label: 'Sketch', icon: 'sketch', action: () => a.createSketchOn({ ref: key }) },
          { label: 'Normal To', icon: 'normalTo', action: () => a.viewport.normalTo(G.stdFrame(key)) },
          a.stdPlaneShown(key) ? { label: 'Hide', icon: 'hide', action: () => a.setStdPlaneVisible(key, false) } : { label: 'Show', icon: 'show', action: () => a.setStdPlaneVisible(key, true) },
        ],
      });
    }
    // the origin: the world's up axis beside it, changed from its right-click menu (wcs.js)
    node({
      icon: 'origin', label: 'Origin', depth: 1, sub: `${W.getUp().toUpperCase()} up`,
      title: `World axes: ${W.getUp().toUpperCase()} up (Top plane ${W.stdPlaneAxes('top')}, Front ${W.stdPlaneAxes('front')}, Right ${W.stdPlaneAxes('right')}). Right-click to change.`,
      menu: () => [['y', 'Y up (Top plane XZ, Front XY)'], ['z', 'Z up (Top plane XY, Front XZ)']].map(([v, l]) => ({ label: `${W.getUp() === v ? '● ' : '　'}${l}`, icon: 'axis', action: () => a.setUpAxis(v) })),
    });

    // features above the rollback bar are built; the ones below it are rolled back (greyed)
    const ri = rollbackIndex(doc);
    const active = (f) => doc.features.indexOf(f) < ri;
    // a sketch is shown under the feature that absorbed it (unless only the feature is rolled back)
    const consumedBy = new Map();
    for (const f of doc.features) {
      if (f.type === 'sketch') continue;
      for (const sid of sketchesUsedBy(f)) {
        if (consumedBy.has(sid)) continue;
        const s = findFeature(doc, sid);
        if (s?.type === 'sketch' && (active(f) || !active(s))) consumedBy.set(sid, f.id);
      }
    }

    const featureNode = (f, depth) => {
      const kids = doc.features.filter((s) => (s.type === 'sketch' && consumedBy.get(s.id) === f.id) || (s.parent === f.id && findFeature(doc, f.id)));
      const collapsed = this.collapsed.has(f.id);
      const rolled = !active(f);
      const err = rolled ? null : res?.errors.get(f.id);
      // (-) marks an under-defined sketch
      const dof = f.type === 'sketch' && !err && !rolled ? this.sketchFreedom(f) : 0;
      const shown = a.featureVisible(f);
      const hidden = shown === false;
      const n = node({
        icon: iconFor(f), label: (dof > 0 ? '(-) ' : '') + f.name, depth, error: err, fid: f.id,
        title: rolled ? 'Rolled back (below the rollback bar)' : err || (dof > 0 ? `Under defined: ${dof} degree${dof > 1 ? 's' : ''} of freedom` : '') + (hidden ? (dof > 0 ? '\n' : '') + 'Hidden (click the eye, or right-click ▸ Show)' : ''),
        cls: (hidden ? 'hidden-item' : '') + (rolled ? ' rolled' : ''),
        vis: { on: shown, toggle: () => a.toggleFeatureVisible(f.id) },
        suppressed: a.isSuppressed(f),
        selected: sel?.kind === 'feature' && sel.id === f.id,
        editing: editingId === f.id,
        twisty: kids.length ? (collapsed ? '▶' : '▼') : '',
        onTwisty: kids.length ? () => { collapsed ? this.collapsed.delete(f.id) : this.collapsed.add(f.id); this.renderTree(); } : null,
        onClick: () => a.treePickFeature(f.id),
        onDbl: () => (f.type === 'sketch' ? a.editSketch(f.id) : a.editFeature(f.id)),
        onHover: (on) => a.hoverFeature(on ? f.id : null),
        menu: () => this.featureMenu(f),
      });
      if (depth === 1) { n.dataset.top = '1'; this.makeDraggable(n, { kind: 'feature', id: f.id }); }
      if (!collapsed) for (const k of kids) featureNode(k, depth + 1);
    };
    const barNode = () => {
      const bar = el('div', { class: 'rollback-bar', title: 'Rollback bar: drag it up to roll the part back and insert features there; drag it to the bottom to roll forward', draggable: 'true' });
      bar.appendChild(el('span'));
      this.makeDraggable(bar, { kind: 'bar' });
      root.appendChild(bar);
    };
    let barDone = false;
    // (a feature folder: where its first feature is, its features under it)
    const folderDone = new Set();
    const folderNode = (g) => {
      const key = 'ff:' + g.id, collapsed = this.collapsed.has(key);
      const members = doc.features.filter((x) => g.ids.includes(x.id));
      const n = node({
        icon: 'folder', label: g.name, depth: 1, sub: `${members.length}`,
        title: `Feature folder: ${members.map((x) => x.name).join(', ')}`,
        twisty: collapsed ? '▶' : '▼',
        onTwisty: () => { collapsed ? this.collapsed.delete(key) : this.collapsed.add(key); this.renderTree(); },
        menu: () => [
          { label: 'Linear Pattern of the Folder…', icon: 'lpattern', action: () => a.patternFolder(g.id, 'lpattern') },
          { label: 'Circular Pattern of the Folder…', icon: 'cpattern', action: () => a.patternFolder(g.id, 'cpattern') },
          { label: 'Save as Library Feature…', icon: 'folder', action: () => a.saveLibraryFeature(g.ids, g.name) },
          'sep',
          { label: 'Rename', icon: 'rename', action: () => this.promptText('Rename Folder', 'folder', 'Name', g.name).then((v) => { if (v?.trim()) { g.name = v.trim(); a.commit(); this.renderTree(); } }) },
          { label: 'Delete Folder (keep its features)', icon: 'trash', action: () => { doc.featureFolders = doc.featureFolders.filter((x) => x !== g); if (!doc.featureFolders.length) delete doc.featureFolders; a.commit(); this.renderTree(); } },
        ],
      });
      n.dataset.folderF = g.id;
      if (!collapsed) for (const m of members) if (!(m.type === 'sketch' && consumedBy.has(m.id)) && !(m.parent && findFeature(doc, m.parent))) featureNode(m, 2);
    };
    for (const f of doc.features) {
      if (f.type === 'sketch' && consumedBy.has(f.id)) continue;
      if (f.parent && findFeature(doc, f.parent)) continue;
      if (!barDone && !active(f)) { barNode(); barDone = true; }
      const g = folderOfFeature(doc, f.id);
      if (g) { if (!folderDone.has(g.id)) { folderDone.add(g.id); folderNode(g); } continue; }
      featureNode(f, 1);
    }
    if (!barDone && doc.features.length) barNode();
    if (!doc.features.length) {
      root.appendChild(el('div', { class: 'pm-hint', style: 'padding:10px 14px' },
        'Start by selecting a plane (e.g. <b>Top Plane</b>) and clicking <b>Sketch</b>, or open <b>File ▸ Open Sample Part</b>.'));
    }
    this.wireTreeDrop(root);
    this.drawRefArrows(root);
  }

  toggleGroup(key) { this.collapsed.has(key) ? this.collapsed.delete(key) : this.collapsed.add(key); }

  renameFolder(id) {
    const a = this.app, g = (a.doc.bodyFolders || []).find((x) => x.id === id);
    const row = document.querySelector(`#tree .tn[data-folder="${CSS.escape(id)}"]`);
    if (g && row) {
      row.querySelector('.tl').textContent = g.name;
      this.inlineRename(row, g.name, (v) => { g.name = v; a.commit(); this.renderTree(); });
    }
  }

  // ------------------------------------------------------------ tree drag and drop
  // Features are dragged to a new place in the history (where their references allow), and the
  // rollback bar to roll the part back. A drop line shows where it will land.
  makeDraggable(row, what) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      if (this.app.pm || this.app.mode === 'sketch') { e.preventDefault(); this.app.toast('Close the Property panel or sketch before rearranging the tree'); return; }
      this._drag = what;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', what.kind + ':' + (what.id || ''));
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); this._drag = null; this.dropLine?.remove(); this.dropLine = null; });
  }

  // Where a drop at clientY lands: { beforeId (null = the end), y (line position) }.
  dropTarget(root, clientY) {
    const doc = this.app.doc;
    const rows = [...root.querySelectorAll(':scope > .tn[data-fid], :scope > .rollback-bar')].filter((r) => r.classList.contains('rollback-bar') || r.dataset.top);
    if (!rows.length) return null;
    // the first feature of a group: a feature with its absorbed sketches starts at the first sketch
    const groupStart = (id) => { const f = findFeature(doc, id); const ks = absorbedSketches(doc, f); return ks.length && doc.features.indexOf(ks[0]) < doc.features.indexOf(f) ? ks[0].id : id; };
    const barBefore = doc.rollbackAt || null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) {
        const id = rows[i].classList.contains('rollback-bar') ? barBefore : groupStart(rows[i].dataset.fid);
        return { beforeId: id, y: rows[i].offsetTop };
      }
    }
    const last = rows[rows.length - 1];
    return { beforeId: null, y: last.offsetTop + last.offsetHeight };
  }

  wireTreeDrop(root) {
    if (root._dropWired) return;
    root._dropWired = true;
    root.addEventListener('dragover', (e) => {
      if (!this._drag) return;
      const t = this.dropTarget(root, e.clientY);
      if (!t) return;
      e.preventDefault();
      if (!this.dropLine) { this.dropLine = el('div', { class: 'drop-line' }); root.appendChild(this.dropLine); }
      this.dropLine.style.top = t.y - 1 + 'px';
    });
    root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) { this.dropLine?.remove(); this.dropLine = null; } });
    root.addEventListener('drop', (e) => {
      const what = this._drag;
      this.dropLine?.remove(); this.dropLine = null;
      if (!what) return;
      e.preventDefault();
      const t = this.dropTarget(root, e.clientY);
      if (t) this.app.treeDrop(what, t.beforeId);
    });
  }

  // Arrows from the selected feature to the features it uses (blue) and to the features that use it (purple).
  drawRefArrows(root) {
    const a = this.app, doc = a.doc, sel = a.selection;
    root.querySelector('svg.ref-arrows')?.remove();
    if (sel?.kind !== 'feature') return;
    const f = findFeature(doc, sel.id);
    if (!f) return;
    const rowOf = (id) => root.querySelector(`:scope > .tn[data-fid="${CSS.escape(id)}"]`);
    const me = rowOf(f.id);
    if (!me) return;
    const parents = [...referencesOf(doc, f), ...stdPlaneRefs(f)];
    const children = dependentsOf(doc, f.id).map((x) => x.id);
    if (!parents.length && !children.length) return;
    const W = root.clientWidth, H = root.scrollHeight;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ref-arrows');
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.innerHTML = `<defs>${['#1d4ed8', '#9333ea'].map((c, i) => `<marker id="refarrow${i}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="${c}"/></marker>`).join('')}</defs>`;
    const yMid = (row) => row.offsetTop + row.offsetHeight / 2;
    // just right of the item's name (and the marks after it, such as a rebuild error's "!")
    const rootLeft = root.getBoundingClientRect().left - root.scrollLeft;
    const xEnd = (row) => {
      const tl = row.querySelector(':scope > .tl');
      let right = tl ? tl.getBoundingClientRect().right : rootLeft + W / 2;
      for (let n = tl?.nextElementSibling; n; n = n.nextElementSibling) if (n.offsetWidth) right = Math.max(right, n.getBoundingClientRect().right);
      return Math.min(W - 52, right - rootLeft + 6);
    };
    // every arrow starts at the selected feature, runs right to a lane of its own, straight up or down, and
    // back left to the related item's name. Lanes clear the names they pass, and the farther an item is, the
    // farther out its lane, so the lines nest without crossing.
    const rows = [...root.querySelectorAll(':scope > .tn')].filter((r) => r.offsetHeight);
    const clearOver = (ya, yb) => {
      let x = 0;
      for (const r of rows) { const y = yMid(r); if (y >= ya - 1 && y <= yb + 1) x = Math.max(x, xEnd(r)); }
      return x;
    };
    const links = [];
    for (const id of new Set(parents)) { const r = rowOf(id); if (r && r !== me) links.push({ r, color: '#1d4ed8', mi: 0 }); }
    for (const id of new Set(children)) { const r = rowOf(id); if (r && r !== me) links.push({ r, color: '#9333ea', mi: 1 }); }
    const y0 = yMid(me), x0 = xEnd(me), GAP = 7, HEAD_RUN = 28, VIS_W = 26; // (VIS_W: the visibility column)
    for (const up of [true, false]) {
      const side = links.filter((l) => (yMid(l.r) < y0) === up).sort((p, q) => Math.abs(yMid(p.r) - y0) - Math.abs(yMid(q.r) - y0));
      let last = -Infinity;
      for (const l of side) {
        const y1 = yMid(l.r), x1 = xEnd(l.r) + 2;
        // (the last run is long enough for the line to come into the arrowhead from behind)
        const lane = Math.min(W - VIS_W - 4, Math.max(clearOver(Math.min(y0, y1), Math.max(y0, y1)) + 10, x1 + HEAD_RUN, last + GAP));
        last = lane;
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', `M ${x0} ${y0} H ${lane} V ${y1} H ${x1}`);
        p.setAttribute('stroke', l.color); p.setAttribute('stroke-width', '1.5'); p.setAttribute('fill', 'none');
        p.setAttribute('stroke-linejoin', 'round');
        p.setAttribute('marker-end', `url(#refarrow${l.mi})`);
        svg.appendChild(p);
      }
    }
    root.appendChild(svg);
  }

  // Degrees of freedom of a sketch (0 = fully defined), cached until the sketch or the equations change.
  sketchFreedom(f) {
    this._skFree ||= new Map();
    const vars = this.app.result?.vars || {};
    const key = JSON.stringify([f.points, f.curves, f.constraints, vars]);
    const hit = this._skFree.get(f.id);
    if (hit?.key === key) return hit.dof;
    let dof = 0;
    try { const an = analyzeSketch(f, (x) => evaluate(x, vars)); dof = an.dofDefined ?? an.dof; } catch { dof = 0; }
    this._skFree.set(f.id, { key, dof });
    return dof;
  }

  bodyMenu(b) {
    const a = this.app;
    return [
      { label: 'Body Properties…', icon: 'body', action: () => this.showBodyProps(b.id) },
      { label: 'Rename', icon: 'rename', action: () => this.renameBody(b.id) },
      ...(b.kind === 'surface' ? [] : [{ label: 'Material…', icon: 'material', action: () => this.showBodyProps(b.id, 'material') }]),
      'sep',
      a.isBodyHidden(b.id) ? { label: 'Show', icon: 'show', action: () => a.setBodyHidden(b.id, false) } : { label: 'Hide', icon: 'hide', action: () => a.setBodyHidden(b.id, true) },
      a.transparencyItem([b.id]),
      { label: 'Isolate', icon: 'isolate', action: () => a.isolateBodies([b.id]) },
      ...(b.kind === 'surface' ? [{ label: 'Convert to Solid (Knit)…', icon: 'knit', action: () => a.startFeatureOnBody('knit', b.id) }] : []),
      ...(b.sheet ? ['sep',
        { label: 'View Flat Pattern', icon: 'smFlatten', action: () => a.toggleFlatten(b.id) },
        { label: 'Export Flat Pattern as DXF…', icon: 'dxf', action: () => a.exportSheetDXF(b.id) },
      ] : []),
      'sep',
      { label: 'Add to New Folder', icon: 'folder', action: () => a.newBodyFolder(b.sheet ? 'sheet' : b.kind || 'solid', null, [b.id]) },
      ...(a.doc.bodyFolders || []).filter((g) => (g.kind || 'solid') === (b.kind || 'solid') && !g.bodies.includes(b.id))
        .map((g) => ({ label: `Move to ${g.name}`, icon: 'folder', action: () => a.moveBodyToFolder(b.id, g.id) })),
      ...(folderOfBody(a.doc, b.id) ? [{ label: 'Remove from Folder', icon: 'folder', action: () => a.moveBodyToFolder(b.id, null) }] : []),
      'sep',
      { label: 'Export as STEP…', icon: 'step', action: () => a.exportBodySTEP(b.id) },
    ];
  }

  renameBody(id) {
    const a = this.app, b = a.bodyById(id);
    const row = document.querySelector(`#tree .tn[data-body="${CSS.escape(id)}"]`);
    if (b && row) this.inlineRename(row, b.name, (v) => a.updateBody(id, { name: v }));
  }

  // Body Properties: name, material (overrides the part material), description, custom
  // properties, and the body's own mass properties.
  // Layer colours / line types and what to include, as editable controls (DXF preview and settings).
  dxfControls(st, onChange) {
    const box = el('div', { class: 'dxf-ctrl' });
    box.appendChild(el('div', { class: 'bp-sec' }, 'Layers'));
    const tbl = el('table', { class: 'grid dxf-layers' });
    tbl.appendChild(el('tr', {}, '<th>Layer</th><th>Colour</th><th>Line type</th>'));
    for (const [name, m] of Object.entries(st.mapping)) {
      const tr = el('tr');
      const sw = el('span', { class: 'dxf-sw' });
      sw.style.background = aciColor(m.color);
      const cs = el('select');
      for (const [n, label] of ACI) { const o = el('option', { value: n }, `${n} — ${label}`); if (n === m.color) o.selected = true; cs.appendChild(o); }
      cs.onchange = () => { m.color = +cs.value; sw.style.background = aciColor(m.color); onChange(); };
      const ls = el('select');
      for (const [k, lt] of Object.entries(LTYPES)) { const o = el('option', { value: k }, lt.label); if (k === m.ltype) o.selected = true; ls.appendChild(o); }
      ls.onchange = () => { m.ltype = ls.value; onChange(); };
      const td1 = el('td', { title: name }, esc(m.label)), td2 = el('td'), td3 = el('td');
      td2.append(sw, cs); td3.appendChild(ls);
      tr.append(td1, td2, td3);
      tbl.appendChild(tr);
    }
    box.appendChild(tbl);
    box.appendChild(el('div', { class: 'bp-sec' }, 'Include'));
    for (const [k, label] of Object.entries(OPTION_LABELS)) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!st.options[k];
      cb.onchange = () => { st.options[k] = cb.checked; onChange(); };
      const lab = el('label', { class: 'dxf-opt' });
      lab.append(cb, document.createTextNode(' ' + label));
      box.appendChild(lab);
    }
    return box;
  }

  // Preview of one flat pattern before it is written. Resolves { action: 'ok' | 'skip' | 'abort', mapping, options, remember, ents }
  // (ents: what to write, with the lines deleted / changed in the preview).
  // The preview: wheel zooms (at the cursor), dragging pans, double-click fits; click picks a line (Ctrl / Shift
  // adds), Shift+drag picks the lines inside a box; Delete removes them; their layer or line type can be changed.
  showDxfPreview({ title, data, info, bulk, fileName }, settings) {
    return new Promise((resolve) => {
      const st = { mapping: structuredClone(settings.mapping), options: { ...settings.options } };
      // edits in this preview (by entity id): deleted, and layer / line type changes
      let edits = { deleted: new Set(), over: new Map() };
      const undo = [];
      const snap = () => ({ deleted: new Set(edits.deleted), over: new Map([...edits.over].map(([k, v]) => [k, { ...v }])) });
      const ents0 = data.ents.map((e, i) => ({ ...e, _id: i }));
      const current = () => selectEnts(ents0, st.options, info)
        .filter((e) => !edits.deleted.has(e._id))
        .map((e) => { const o = edits.over.get(e._id); if (!o) return e; const n = { ...e, ...o }; if (n.ltype === 'BYLAYER') delete n.ltype; return n; });
      let done = false;
      const finish = (action) => {
        if (done) return;
        done = true;
        resolve({ action, mapping: st.mapping, options: st.options, remember: remember.checked, ents: current().map(({ _id, ...e }) => e) });
      };
      const wrap = el('div', { class: 'dxf-prev' });
      const left = el('div', { class: 'dxf-left' });
      const cv = el('canvas', { class: 'dxf-canvas', tabindex: '0', 'data-own-escape': true });
      const [w, h] = data.size.map((x) => +x.toFixed(2));
      const facts = el('div', { class: 'pm-hint' }, esc(`${fileName} · flat size ${w} × ${h} mm · thickness ${+data.t.toFixed(3)} mm · ${data.bends.length} bend${data.bends.length === 1 ? '' : 's'} (K ${data.K}, R ${+data.R.toFixed(3)})`));
      // the edit bar: what is selected, its layer and line type, delete / undo / restore / fit
      const bar = el('div', { class: 'dxf-bar' });
      const selInfo = el('span', { class: 'dxf-selinfo' });
      const layerSel = el('select', { title: 'Move the selected lines to another layer (its colour and line type)' });
      const ltSel = el('select', { title: 'Line type of the selected lines (By layer: the layer\'s)' });
      ltSel.appendChild(el('option', { value: 'BYLAYER' }, 'By layer'));
      for (const [k, lt] of Object.entries(LTYPES)) ltSel.appendChild(el('option', { value: k }, esc(lt.label)));
      const delB = el('button', { class: 'pm-btn', title: 'Delete the selected lines (Del)' }, 'Delete');
      const undoB = el('button', { class: 'pm-btn', title: 'Undo the last change (Ctrl+Z)' }, 'Undo');
      const resetB = el('button', { class: 'pm-btn', title: 'Put back every deleted or changed line' }, 'Restore All');
      const fitB = el('button', { class: 'pm-btn', title: 'Zoom to fit (double-click)' }, 'Fit');
      bar.append(selInfo, el('span', { class: 'dxf-lab' }, 'Layer'), layerSel, el('span', { class: 'dxf-lab' }, 'Line type'), ltSel, delB, undoB, resetB, fitB);
      const help = el('div', { class: 'pm-hint' }, 'Wheel: zoom · drag: pan · double-click: fit · click a line to select it (Ctrl / Shift: add) · Shift+drag: box select · Del: delete · Ctrl+Z: undo');
      left.append(cv, bar, help, facts);
      if (data.stale) left.appendChild(el('div', { class: 'pm-msg warn' }, esc(`${data.stale} changed this body after its last sheet metal feature: the flat pattern does not include that change.`)));
      const view = { zoom: 1, px: 0, py: 0 };
      const sel = new Set();
      let hover = null, place = null, boxSel = null;
      const fillLayers = () => {
        layerSel.innerHTML = '';
        for (const [name, m] of Object.entries(st.mapping)) layerSel.appendChild(el('option', { value: name }, esc(m.label || name)));
      };
      const syncBar = () => {
        const list = current().filter((e) => sel.has(e._id));
        const lines = list.filter((e) => e.type !== 'TEXT');
        selInfo.textContent = list.length ? `${list.length} selected` : 'Nothing selected';
        for (const c of [layerSel, ltSel, delB]) c.disabled = !list.length;
        ltSel.disabled = !lines.length;
        const one = (vals) => (vals.length && vals.every((v) => v === vals[0]) ? vals[0] : '');
        layerSel.value = one(list.map((e) => e.layer));
        ltSel.value = one(lines.map((e) => e.ltype || 'BYLAYER'));
        undoB.disabled = !undo.length;
        resetB.disabled = !edits.deleted.size && !edits.over.size;
      };
      const redraw = () => {
        place = drawDxfPreview(cv, current(), st.mapping, view, sel, hover, selectEnts(ents0, st.options, info));
        if (boxSel) {
          const ctx = cv.getContext('2d');
          ctx.strokeStyle = '#38bdf8'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
          ctx.strokeRect(Math.min(boxSel.x0, boxSel.x1), Math.min(boxSel.y0, boxSel.y1), Math.abs(boxSel.x1 - boxSel.x0), Math.abs(boxSel.y1 - boxSel.y0));
          ctx.setLineDash([]);
        }
        syncBar();
      };
      const change = (fn) => { undo.push(snap()); fn(); redraw(); };
      const setOver = (key, val) => change(() => {
        const text = new Set(ents0.filter((e) => e.type === 'TEXT').map((e) => e._id));
        for (const id of sel) {
          if (key === 'ltype' && (text.has(id) || String(id).startsWith('info'))) continue; // (text has no line type)
          edits.over.set(id, { ...(edits.over.get(id) || {}), [key]: val });
        }
      });
      const deleteSel = () => { if (!sel.size) return; change(() => { for (const id of sel) edits.deleted.add(id); sel.clear(); }); };
      const doUndo = () => { if (!undo.length) return; edits = undo.pop(); sel.clear(); redraw(); };
      layerSel.onchange = () => setOver('layer', layerSel.value);
      ltSel.onchange = () => setOver('ltype', ltSel.value);
      delB.onclick = deleteSel;
      undoB.onclick = doUndo;
      resetB.onclick = () => change(() => { edits = { deleted: new Set(), over: new Map() }; sel.clear(); });
      fitB.onclick = () => { Object.assign(view, { zoom: 1, px: 0, py: 0 }); redraw(); };
      // sized for the screen (sharp on high-DPI displays)
      const size = () => {
        const dpr = window.devicePixelRatio || 1, r = cv.getBoundingClientRect();
        const cw = Math.max(200, Math.round(r.width || 640)), ch = Math.max(150, Math.round(r.height || 400));
        if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) { cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr); }
      };
      const at = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        const [mx, my] = at(e), f = Math.exp(-e.deltaY * 0.0015);
        const z = Math.min(Math.max(view.zoom * f, 0.2), 500), k = z / view.zoom;
        view.px = mx - (mx - view.px) * k; view.py = my - (my - view.py) * k; view.zoom = z;
        redraw();
      }, { passive: false });
      let drag = null;
      cv.addEventListener('pointerdown', (e) => {
        cv.focus();
        const [mx, my] = at(e);
        drag = { x: mx, y: my, px: view.px, py: view.py, moved: false, box: e.button === 0 && e.shiftKey, add: e.ctrlKey || e.shiftKey || e.metaKey };
        cv.setPointerCapture(e.pointerId);
      });
      cv.addEventListener('pointermove', (e) => {
        const [mx, my] = at(e);
        if (drag) {
          if (Math.hypot(mx - drag.x, my - drag.y) > 3) drag.moved = true;
          if (!drag.moved) return;
          if (drag.box) boxSel = { x0: drag.x, y0: drag.y, x1: mx, y1: my };
          else { view.px = drag.px + mx - drag.x; view.py = drag.py + my - drag.y; cv.style.cursor = 'grabbing'; }
          redraw();
          return;
        }
        if (!place) return;
        const hit = dxfPick(current(), place, mx, my);
        const id = hit ? hit._id : null;
        if (id !== hover) { hover = id; cv.style.cursor = id != null ? 'pointer' : 'default'; redraw(); }
      });
      cv.addEventListener('pointerup', (e) => {
        const d = drag;
        drag = null;
        cv.style.cursor = 'default';
        if (!d || !place) return;
        if (d.moved && d.box && boxSel) {
          const r = { x0: Math.min(boxSel.x0, boxSel.x1), y0: Math.min(boxSel.y0, boxSel.y1), x1: Math.max(boxSel.x0, boxSel.x1), y1: Math.max(boxSel.y0, boxSel.y1) };
          boxSel = null;
          for (const x of dxfInBox(current(), place, r)) sel.add(x._id);
          redraw();
          return;
        }
        if (d.moved) return;
        const [mx, my] = at(e);
        const hit = dxfPick(current(), place, mx, my);
        if (!d.add) sel.clear();
        if (hit) { if (d.add && sel.has(hit._id)) sel.delete(hit._id); else sel.add(hit._id); }
        redraw();
      });
      cv.addEventListener('dblclick', () => { Object.assign(view, { zoom: 1, px: 0, py: 0 }); redraw(); });
      cv.addEventListener('keydown', (e) => {
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); deleteSel(); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); doUndo(); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); e.stopPropagation(); for (const x of current()) sel.add(x._id); redraw(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (sel.size) { sel.clear(); redraw(); } else dlg.close(); }
      });
      const right = this.dxfControls(st, redraw);
      const remember = el('input', { type: 'checkbox' });
      remember.checked = true;
      const rl = el('label', { class: 'dxf-opt' });
      rl.append(remember, document.createTextNode(' Use these settings for later exports'));
      right.appendChild(rl);
      wrap.append(left, right);
      const buttons = bulk
        ? [{ label: 'Abort Export', action: () => finish('abort') }, { label: 'Skip This One', action: () => finish('skip') }, { label: 'Export', primary: true, action: () => finish('ok') }]
        : [{ label: 'Cancel', action: () => finish('skip') }, { label: 'Export…', primary: true, action: () => finish('ok') }];
      const dlg = this.modal(title, 'dxf', wrap, buttons);
      dlg.body.parentElement.classList.add('modal-wide');
      // closing with ✕, Esc or a click outside skips this one
      const obs = new MutationObserver(() => { if (!document.contains(dlg.body)) { obs.disconnect(); finish('skip'); } });
      obs.observe(document.getElementById('modal-root'), { childList: true });
      fillLayers();
      size();
      redraw();
      requestAnimationFrame(() => { size(); redraw(); });
    });
  }

  // The default DXF layer colours, line types and options.
  showDxfSettings() {
    const st = loadDxfSettings();
    const box = el('div');
    box.appendChild(el('div', { class: 'pm-hint' }, 'How flat patterns are written to DXF. Each export shows a preview where these can be changed for that file too.'));
    box.appendChild(this.dxfControls(st, () => {}));
    this.modal('DXF Settings', 'gear', box, [
      { label: 'Reset to Defaults', action: () => { saveDxfSettings({ mapping: {}, options: {} }); try { localStorage.removeItem('razorcad.dxfMapping.v1'); } catch { /* ignore */ } setTimeout(() => this.showDxfSettings(), 0); } },
      { label: 'Save', primary: true, action: () => { saveDxfSettings(st); this.app.status('DXF settings saved.'); } },
      { label: 'Cancel' },
    ]);
  }

  // ------------------------------------------------------------ Ask Claude (modelling with Claude)
  toggleClaude() {
    if ($('#claude-panel').hidden) this.openClaude(); else this.closeClaude();
  }

  // Forget the conversation (Claude starts fresh; the part stays as it is).
  async newClaudeChat() {
    this.app.claudeChat = [];
    const p = $('#claude-panel');
    if (p.hidden) await this.openClaude();
    $('.cl-log', p).innerHTML = '';
    this.claudeLog('note', 'New conversation. Describe a part or a change.');
    $('textarea', p).focus();
  }

  closeClaude() {
    $('#claude-panel').hidden = true;
    this.renderCommandManager?.();
  }

  async openClaude() {
    const p = $('#claude-panel');
    if (!p._init) this.initClaude(p);
    p.hidden = false;
    this.renderCommandManager?.();
    const st = await this.refreshClaude();
    if (!p.querySelector('.cl-log').children.length) {
      this.claudeLog('note', 'Describe a part or a change and Claude adds the features to the feature tree (each answer is one undo step). '
        + 'Claude sees the feature list and the body sizes of this part, not the picture.');
    }
    $('textarea', p).focus();
    if (!st.ready) this.showClaudeSettings();
  }

  initClaude(p) {
    p._init = true;
    $('.cl-title', p).innerHTML = `${icon('assistant')}<span>Ask Claude</span>`;
    $('.cl-set', p).innerHTML = icon('gear');
    const sel = el('select', { title: 'Model' });
    for (const [id, label] of CLAUDE_MODELS) sel.appendChild(el('option', { value: id, title: label }, esc(label.replace(/^Claude | \(.*$/g, ''))));
    sel.onchange = () => platform.claudeSet({ model: sel.value });
    $('.cl-model', p).appendChild(sel);
    const neu = el('button', { class: 'cl-new', title: 'Start a new conversation (Claude forgets the earlier messages)' }, 'New chat');
    neu.onclick = () => this.newClaudeChat();
    $('.cl-set', p).before(neu);
    $('.cl-x', p).onclick = () => this.closeClaude();
    $('.cl-set', p).onclick = () => this.showClaudeSettings();
    const ta = $('textarea', p), send = $('.cl-send', p);
    const go = async () => {
      const text = ta.value.trim();
      if (!text || this.app.claudeBusy) return;
      ta.value = '';
      const ok = await this.app.askClaude(text);
      if (ok === false && !ta.value) ta.value = text; // not sent: give the text back
    };
    send.onclick = go;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); go(); }
      else if (e.key === 'Escape') { e.stopPropagation(); this.closeClaude(); }
    });
    // the panel sits over the 3D view: keep its clicks and scrolling to itself
    for (const t of ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick', 'contextmenu']) p.addEventListener(t, (e) => e.stopPropagation());
  }

  async refreshClaude() {
    const st = await platform.claudeStatus();
    const p = $('#claude-panel');
    const sel = $('.cl-model select', p);
    if (sel) sel.value = CLAUDE_MODELS.some(([id]) => id === st.model) ? st.model : CLAUDE_MODELS[0][0];
    p.classList.toggle('nokey', !st.ready);
    return st;
  }

  // One entry in the conversation. kind: 'you' | 'claude' | 'note' | 'error' | 'busy'
  claudeLog(kind, text) {
    const log = $('#claude-panel .cl-log');
    const who = { you: 'You', claude: 'Claude' }[kind];
    const m = el('div', { class: `cl-m cl-${kind}` }, (who ? `<b>${who}</b>` : '') + `<div>${esc(text).replace(/\n/g, '<br>')}</div>`);
    log.appendChild(m);
    log.scrollTop = log.scrollHeight;
    return m;
  }

  async showClaudeSettings() {
    const st = await platform.claudeStatus();
    const box = el('div', { class: 'claude-set' });
    box.innerHTML = `
      ${platform.desktop ? `<div class="cl-backend">
        <label><input type="radio" name="cl-backend" value="cli"> My Claude subscription (Claude Code on this PC)</label>
        <label><input type="radio" name="cl-backend" value="api"> An Anthropic API key</label>
      </div>` : ''}
      <div class="cl-sub-opts">
        <div class="pm-hint">Ask Claude runs through Claude Code, signed in to your own Claude Pro or Max plan; requests count toward that plan's usage limits.
        Claude Code must be installed and signed in on this PC, as you (for your own use, not for sharing RazorCAD's Claude access with others).</div>
        <div class="pm-hint cl-clistate">Looking for Claude Code…</div>
      </div>
      <div class="cl-api-opts">
        <div class="pm-hint">Ask Claude uses your own Anthropic API key (create one at console.anthropic.com ▸ API Keys); requests are billed to that account.
        ${platform.desktop ? 'The key is kept on this PC in the RazorCAD data folder and is only sent to api.anthropic.com.' : 'The key is kept in this browser and only sent to api.anthropic.com.'}</div>
        <div class="kv"><div class="k">API key</div><div><input type="password" class="cl-key" autocomplete="off" spellcheck="false"></div></div>
        <div class="pm-hint cl-keystate"></div>
      </div>
      <div class="kv"><div class="k">Model</div><div><select class="cl-mod"></select></div></div>`;
    const keyIn = $('.cl-key', box), sel = $('.cl-mod', box);
    keyIn.placeholder = st.hasKey ? 'A key is saved (enter a new key to replace it)' : 'sk-ant-…';
    $('.cl-keystate', box).textContent = st.hasKey ? 'An API key is saved.' : 'No API key saved yet.';
    for (const [id, label] of CLAUDE_MODELS) sel.appendChild(el('option', { value: id }, esc(label)));
    sel.value = CLAUDE_MODELS.some(([id]) => id === st.model) ? st.model : CLAUDE_MODELS[0][0];
    let backend = platform.desktop ? st.backend : 'api';
    const radios = [...box.querySelectorAll('input[name="cl-backend"]')];
    const show = () => {
      $('.cl-sub-opts', box).hidden = backend !== 'cli';
      $('.cl-api-opts', box).hidden = backend !== 'api';
      for (const r of radios) r.checked = r.value === backend;
    };
    for (const r of radios) r.onchange = () => { backend = r.value; show(); };
    show();
    // Claude Code: found? signed in? (asking it takes a moment, so the dialog opens first)
    const cliState = $('.cl-clistate', box);
    const check = async () => {
      cliState.textContent = 'Looking for Claude Code…';
      const c = await platform.claudeCliCheck();
      cliState.innerHTML = '';
      if (!c.cli) {
        cliState.innerHTML = 'Claude Code was not found on this PC. Install it (claude.com/claude-code: in PowerShell, <code>irm https://claude.ai/install.ps1 | iex</code>), then reopen these settings.';
        return;
      }
      const where = el('div', {}, `Claude Code ${esc(c.version)} — ${esc(c.cli)}`);
      const state = el('div', {}, c.error ? `Could not ask it whether it is signed in (${esc(c.error)}).`
        : c.loggedIn ? (c.authMethod === 'claude.ai' || !c.authMethod ? '✓ Signed in to your Claude subscription.' : `Signed in (${esc(c.authMethod)}). For your subscription, sign in again with your Claude account.`)
          : 'Not signed in yet.');
      const btn = el('button', {}, c.loggedIn ? 'Sign In Again…' : 'Sign In…');
      btn.onclick = async () => {
        await platform.claudeCliLogin();
        state.textContent = 'Finish signing in in the window that opened (and your browser), then click Check Again.';
      };
      const again = el('button', {}, 'Check Again');
      again.onclick = check;
      cliState.append(where, state, el('div', { class: 'cl-cli-btns' }));
      $('.cl-cli-btns', cliState).append(btn, again);
    };
    if (platform.desktop) check();
    const buttons = [];
    if (st.hasKey) buttons.push({ label: 'Remove Key', action: () => { platform.claudeSet({ clear: true }).then(() => { this.app.status('Claude API key removed.'); this.refreshClaude(); }); } });
    buttons.push({
      label: 'Save', primary: true, action: () => {
        const key = backend === 'api' ? keyIn.value.trim() : '';
        if (key && !/^sk-ant-/.test(key) && !confirm('That does not look like an Anthropic API key (they start with "sk-ant-"). Save it anyway?')) return false;
        platform.claudeSet({ key: key || null, model: sel.value, backend }).then(() => { this.app.status('Claude settings saved.'); this.refreshClaude(); });
      },
    });
    buttons.push({ label: 'Cancel' });
    this.modal('Claude Settings', 'assistant', box, buttons);
    if (backend === 'api') setTimeout(() => keyIn.focus(), 0);
  }

  showBodyProps(id, focus = null) {
    const a = this.app, doc = a.doc, b = a.bodyById(id);
    if (!b) { a.toast('That body no longer exists', true); return; }
    const cur = bodySettings(doc, id) || {};
    const st = { name: cur.name || '', material: cur.material || null, description: cur.description || '', props: (cur.props || []).map((p) => ({ ...p })), qty: cur.qty || 1, flatSide: cur.flatSide || 'top' };
    const partMat = materialById(doc.material);
    const wrap = el('div', { class: 'bodyprops' });
    wrap.innerHTML = `
      <div class="bp-sec">General</div>
      <div class="kv bp-kv">
        <div class="k">Name</div><div><input type="text" class="bp-name" spellcheck="false"></div>
        <div class="k">Material</div><div><select class="bp-mat"></select></div>
        <div class="k">Description</div><div><input type="text" class="bp-desc"></div>
      </div>
      <div class="bp-sec">Custom Properties</div>
      <table class="grid bp-props"></table>
      <button class="pm-btn bp-add" style="margin-top:6px">+ Add property</button>
      <div class="bp-sec">Mass Properties</div>
      <div class="kv bp-mass"></div>
      ${b.sheet ? '<div class="bp-sec">Sheet Metal</div><div class="kv bp-sheet"></div>' : ''}`;
    const nameIn = $('.bp-name', wrap), matSel = $('.bp-mat', wrap), descIn = $('.bp-desc', wrap);
    nameIn.value = st.name;
    nameIn.placeholder = `${b.defaultName} (default: named after the last feature)`;
    descIn.value = st.description;
    matSel.appendChild(el('option', { value: '' }, esc(`Use part material (${partMat ? partMat.name : 'not specified'})`)));
    for (const m of MATERIALS) matSel.appendChild(el('option', { value: m.id }, esc(`${m.name} — ${m.density} g/cm³`)));
    matSel.value = st.material || '';

    const mp = G.massProps(a.viewport.bodyInfo(b.index).geometry);
    const surface = b.kind === 'surface';
    if (surface) { matSel.closest('div').previousElementSibling.remove(); matSel.closest('div').remove(); [...wrap.querySelectorAll('.bp-sec')].at(-1).textContent = 'Geometry'; }
    const renderMass = () => {
      if (surface) {
        const size = W.toUser(mp.bbox.getSize(new (mp.bbox.min.constructor)()).toArray()).map(Math.abs);
        $('.bp-mass', wrap).innerHTML = `<div class="k">Surface area</div><div>${fmt(mp.area, 2)} mm² (one side)</div><div class="k">Bounding box</div><div>${fmt(size[0])} × ${fmt(size[1])} × ${fmt(size[2])} mm</div>`;
        return;
      }
      const mat = materialById(st.material) || partMat;
      const density = mat ? mat.density : 1.0;
      const size = W.toUser(mp.bbox.getSize(new (mp.bbox.min.constructor)()).toArray()).map(Math.abs), com = W.toUser([mp.com.x, mp.com.y, mp.com.z]);
      $('.bp-mass', wrap).innerHTML = `
        <div class="k">Density</div><div>${fmt(density, 3)} g/cm³${mat ? '' : ' <i>(no material: 1.00 assumed)</i>'}</div>
        <div class="k">Mass</div><div><b>${fmt((mp.volume / 1000) * density, 2)} g</b></div>
        <div class="k">Volume</div><div>${fmt(mp.volume, 2)} mm³</div>
        <div class="k">Surface area</div><div>${fmt(mp.area, 2)} mm²</div>
        <div class="k">Center of mass</div><div>X ${fmt(com[0])} &nbsp; Y ${fmt(com[1])} &nbsp; Z ${fmt(com[2])} mm</div>
        <div class="k">Bounding box</div><div>${fmt(size[0])} × ${fmt(size[1])} × ${fmt(size[2])} mm</div>`;
    };
    const table = $('.bp-props', wrap);
    const renderProps = () => {
      table.innerHTML = '<tr><th style="width:38%">Property name</th><th>Value</th><th style="width:28px"></th></tr>';
      if (!st.props.length) table.appendChild(el('tr', {}, '<td colspan="3" class="pm-hint">No custom properties yet (e.g. Part number, Supplier, Finish).</td>'));
      st.props.forEach((p, i) => {
        const tr = el('tr');
        const n = el('input', { type: 'text', spellcheck: 'false' });
        const v = el('input', { type: 'text' });
        n.value = p.name; v.value = p.value;
        n.oninput = () => { p.name = n.value; };
        v.oninput = () => { p.value = v.value; };
        const del = el('button', { class: 'pm-btn', style: 'padding:0 6px;height:22px', title: 'Delete property' }, '✕');
        del.onclick = () => { st.props.splice(i, 1); renderProps(); };
        const td1 = el('td'), td2 = el('td'), td3 = el('td');
        td1.appendChild(n); td2.appendChild(v); td3.appendChild(del);
        tr.append(td1, td2, td3);
        table.appendChild(tr);
      });
    };
    if (b.sheet) {
      // sheet metal: thickness, bends and the flat pattern size; the quantity goes into DXF part info
      const sm = b.sheet, kv = $('.bp-sheet', wrap);
      kv.innerHTML = `
        <div class="k">Thickness</div><div>${fmt(sm.t, 3)} mm</div>
        <div class="k">Bend radius</div><div>${fmt(sm.R, 3)} mm (inside) · K-factor ${fmt(sm.K, 3)}</div>
        <div class="k">Bends</div><div>${sm.bends}</div>
        <div class="k">Overall size (flat)</div><div>${fmt(sm.flatSize[0])} × ${fmt(sm.flatSize[1])} mm</div>
        <div class="k">Flat area</div><div>${fmt(sm.flatArea, 2)} mm²</div>
        <div class="k">Cut length</div><div><b>${fmt(sm.cutLength ?? 0, 2)} mm</b> · ${sm.pierces ?? 0} pierce${sm.pierces === 1 ? '' : 's'} <span class="pm-hint">(outline + holes and cut-outs, for laser cutting estimates)</span></div>
        <div class="k">Quantity</div><div><input type="number" class="bp-qty" min="1" step="1" style="width:80px"> <span class="pm-hint">per body${a.bodyCount(b) > 1 ? ` · ${a.bodyCount(b)} identical bodies in the part (DXF quantity: this × ${a.bodyCount(b)})` : ''}</span></div>
        <div class="k">Flat pattern seen from</div><div><select class="bp-flatside"><option value="top">Top face (the side the flanges bend up to)</option><option value="bottom">Bottom face (mirrored; up and down bends swap)</option></select></div>
        ${sm.flat ? '<div class="k">State</div><div>Unbent (flat)</div>' : ''}
        ${sm.stale ? `<div class="k">Note</div><div>${esc(sm.stale)} changed the body after its last sheet metal feature (not in the flat pattern)</div>` : ''}`;
      const fsel = $('.bp-flatside', kv);
      fsel.value = st.flatSide;
      fsel.onchange = () => { st.flatSide = fsel.value; };
      kv.appendChild(el('div', { class: 'k' }));
      kv.appendChild(el('div', { class: 'pm-hint' }, 'The side shown in Flatten, exported to DXF and drawn in flat pattern drawing views; bend lines and notes follow it.'));
      const q = $('.bp-qty', kv);
      q.value = st.qty;
      q.oninput = () => { const v = Math.round(+q.value); if (v >= 1) st.qty = v; };
    }
    $('.bp-add', wrap).onclick = () => { st.props.push({ name: '', value: '' }); renderProps(); table.querySelector('tr:last-child input')?.focus(); };
    matSel.onchange = () => { st.material = matSel.value || null; renderMass(); };
    renderProps();
    renderMass();
    const apply = () => {
      a.updateBody(id, {
        name: nameIn.value.trim(), material: st.material, description: descIn.value.trim(),
        props: st.props.map((p) => ({ name: p.name.trim(), value: p.value })).filter((p) => p.name),
        ...(b.sheet ? { qty: st.qty, flatSide: st.flatSide } : {}),
      });
    };
    this.modal(`Body Properties — ${b.name}`, 'body', wrap, [
      { label: 'Export as STEP…', action: () => { setTimeout(() => a.exportBodySTEP(id), 0); return false; } },
      { label: 'OK', primary: true, action: apply },
      { label: 'Cancel' },
    ]);
    (focus === 'material' && !surface ? matSel : nameIn).focus();
  }

  featureMenu(f) {
    const a = this.app;
    const items = [];
    if (f.type === 'sketch') {
      items.push({ label: 'Edit Sketch', icon: 'sketch', action: () => a.editSketch(f.id) });
      items.push({ label: 'Change Sketch Plane…', icon: 'plane', action: () => a.changeSketchPlane(f.id) });
      items.push(a.sketchShown(f) ? { label: 'Hide', icon: 'hide', action: () => a.setSketchVisible(f.id, false) } : { label: 'Show', icon: 'show', action: () => a.setSketchVisible(f.id, true) });
    }
    else {
      if (a.result?.errors.has(f.id)) items.push({ label: 'Fix References…', icon: 'fix', action: () => this.showFixReferences(f.id) });
      items.push(f.type === 'sketch3d' ? { label: 'Edit 3D Sketch', icon: 'sketch3d', action: () => a.editFeature(f.id) } : { label: 'Edit Feature', icon: 'edit', action: () => a.editFeature(f.id) });
      if (f.sketch) items.push({ label: 'Edit Sketch', icon: 'sketch', action: () => a.editSketch(f.sketch) });
    }
    if (f.type === 'plane') {
      items.push({ label: 'Sketch', icon: 'sketch', action: () => a.createSketchOn({ ref: f.id }) });
      items.push({ label: 'Normal To', icon: 'normalTo', action: () => { const fr = a.result.planes.get(f.id); if (fr) a.viewport.normalTo(fr); } });
    }
    if (f.type !== 'sketch') {
      const v = a.featureVisible(f);
      const what = a.refVisKind(f) ? '' : ' Bodies';
      if (v === true) items.push({ label: 'Hide' + what, icon: 'hide', action: () => a.setFeatureVisible(f.id, false) });
      else if (v === false) items.push({ label: 'Show' + what, icon: 'show', action: () => a.setFeatureVisible(f.id, true) });
    }
    const bodies = a.bodiesOfFeature(f);
    if (bodies.length) items.push(a.transparencyItem(bodies));
    items.push('sep');
    items.push({ label: 'Roll Back (to just before this)', icon: 'rollback', action: () => a.setRollback(f.id) });
    if (a.doc.rollbackAt) items.push({ label: 'Roll to End', icon: 'rollback', action: () => a.setRollback(null) });
    items.push({ label: f.suppressed ? 'Unsuppress' : 'Suppress', icon: 'suppress', action: () => a.toggleSuppress(f.id) });
    items.push({ label: 'Rename', icon: 'rename', action: () => this.renameFeature(f.id) });
    // (feature folders)
    const inFolder = folderOfFeature(a.doc, f.id);
    if (f.type === 'import' && f.context?.host) items.push({ label: 'Update Context', icon: 'part', action: () => a.updateContext(true) });
    if (f.type !== 'sketch3d') items.push({ label: 'Save as Library Feature…', icon: 'folder', action: () => a.saveLibraryFeature([f.id], f.name) });
    items.push({ label: 'Add to New Folder…', icon: 'folder', action: () => this.promptText('New Folder', 'folder', 'Name', 'Folder').then((v) => { if (v?.trim()) { newFeatureFolder(a.doc, v.trim(), [f.id]); a.commit(); this.renderTree(); } }) });
    for (const g of (a.doc.featureFolders || []).filter((x) => x !== inFolder)) items.push({ label: `Move to ${g.name}`, icon: 'folder', action: () => { putFeatureInFolder(a.doc, f.id, g.id); a.commit(); this.renderTree(); } });
    if (inFolder) items.push({ label: 'Remove from Folder', icon: 'folder', action: () => { putFeatureInFolder(a.doc, f.id, null); a.commit(); this.renderTree(); } });
    items.push({ label: 'Delete', icon: 'trash', key: 'Del', action: () => a.deleteFeature(f.id) });
    return items;
  }

  renameFeature(id) {
    const f = findFeature(this.app.doc, id);
    if (!f) return;
    const rows = [...document.querySelectorAll('#tree .tn')];
    const row = rows.find((r) => r.dataset.fid === id);
    if (row) this.inlineRename(row, f.name, (v) => { f.name = v; this.app.commit(); this.app.refresh(); });
  }

  inlineRename(row, value, done) {
    const label = row.querySelector('.tl');
    const input = el('input', { class: 'rename', type: 'text', value });
    label.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const finish = (ok) => {
      if (finished) return;
      finished = true;
      const v = input.value.trim();
      if (ok && v && v !== value) done(v);
      else this.renderTree();
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  // ------------------------------------------------------------ Property panel
  renderPM() {
    if (this.app.mode === 'drawing' && this.app.drawing) { this.app.drawing.renderPM(); return; }
    const a = this.app, pm = a.pm, root = $('#pm');
    root.innerHTML = '';
    if (!pm) { if (this.leftTab === 'pm') this.showLeft('tree'); else this.showLeft(this.leftTab || 'tree'); return; }
    this.showLeft('pm');
    if (pm.kind === 'sketch') return this.renderSketchPM(root);
    if (pm.kind === 'sketch3d') return a.sketch3d.renderPM(root, { el, esc, icon, pmGroup: (...x) => this.pmGroup(...x), exprInput: (...x) => this.exprInput(...x) });
    if (pm.kind === 'selectPlane') return this.renderSelectPlanePM(root);
    if (pm.kind === 'decal') { root.appendChild(el('div', { class: 'pm-hint', style: 'margin:10px' }, esc(`Decal ${pm.draft.name}: click the flat face for it. Esc cancels.`))); return; }
    if (pm.kind === 'annotate') { root.appendChild(el('div', { class: 'pm-hint', style: 'margin:10px' }, esc(`3D annotation (${pm.draft.kind}): click ${pm.need - pm.pts.length === 2 ? 'the two points' : 'the point'} on the model. Esc cancels.`))); return; }
    if (pm.kind === 'section') return this.renderSectionPM(root);
    if (pm.kind === 'measure') return this.renderMeasurePM(root);
    if (pm.kind === 'feature') return this.renderFeaturePM(root);
    if (pm.kind === 'explode') return a.explodeTool?.renderPM();
  }

  updatePMStatus() {
    const pm = this.app.pm;
    if (pm?.kind !== 'feature') return;
    const root = $('#pm');
    const f = pm.feature;
    let msg = root.querySelector('.pm-status');
    const err = this.app.result?.errors.get(f.id);
    const note=this.app.result?.notes?.get(f.id);let noteBox=root.querySelector('[data-pm-note]');
    if(err||!note)noteBox?.remove();
    else{if(!noteBox){noteBox=el('div',{class:'pm-msg ok','data-pm-note':''});root.querySelector('.pm-actions')?.after(noteBox);}noteBox.textContent=note;}
    if(['loft','surfLoft'].includes(f.type)&&LC.hasManualConnections(f)){
      const graph=this.app.result?.info?.[f.id]?.loftConnections,box=root.querySelector('[data-loft-correspondence]');
      if(box&&box.dataset.graph===''&&graph?.signature===JSON.stringify(f)){this.renderPM();return;}
    }
    if(f.referenceDefinition&&['plane','axis','point'].includes(f.type)){
      const info=this.app.result?.info?.[f.id],body=root.querySelector('.datum-definition');
      if(body&&info?.datumSignature===JSON.stringify(f)&&info.geometry&&body.dataset.geometry!==JSON.stringify(info.geometry)){this.renderPM();return;}
      this.updateDatumStatus(root,f);msg?.remove();return;
    }
    if (!msg) {
      msg = el('div', { class: 'pm-msg pm-status' });
      root.querySelector('.pm-actions')?.after(msg);
    }
    if (!err && (f.type === 'fillet' || f.type === 'chamfer')) {
      msg.className = 'pm-msg pm-status';
      msg.textContent = `${f.edges.length} edge${f.edges.length === 1 ? '' : 's'} selected. Click edges on the model; ✔ applies the ${f.type}.`;
      return;
    }
    const missed = !err && this.app.result?.previewOf === f.id && this.app.result?.preview?.missed;
    msg.className = 'pm-msg pm-status' + (err ? ' err' : missed ? ' warn' : '');
    msg.textContent = err || (missed
      ? '⚠ This cut does not remove any material. Check the profile (which loops are closed), the direction and the end condition.'
      : 'Preview updated. Click ✔ to accept.');
  }

  pmHeader(root, iconName, title, { ok = true, cancel = true } = {}) {
    root.appendChild(el('div', { class: 'pm-head' }, `<span class="ti">${icon(iconName)}</span><span>${esc(tr(title))}</span>`));
    const act = el('div', { class: 'pm-actions' });
    if (ok) act.appendChild(el('button', { title: 'OK (Enter)', onclick: () => this.app.okPM() }, icon('ok')));
    if (cancel) act.appendChild(el('button', { title: 'Cancel (Esc)', onclick: () => this.app.cancelPM() }, icon('cancel')));
    root.appendChild(act);
  }

  // A variable fillet's radius at each vertex of its runs of edges (the vertices as the last build found them); empty:
  // the fillet's radius.
  renderVertexRadii(body, f) {
    const a = this.app, vs = a.result?.info?.[f.id]?.vertices || [];
    if (!vs.length) { body.appendChild(el('div', { class: 'pm-hint' }, tr('Select the edges first: their vertices are listed here.'))); return; }
    const L = a.units, fmtP = (q) => q.map((x) => (L === 'in' ? +(x / 25.4).toFixed(3) : +x.toFixed(2))).join(', ');
    const same = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-4;
    vs.forEach((q, i) => {
      const cur = (f.vertexRadii || []).find((x) => same(x.p, q));
      const inp = this.exprInput(cur ? cur.r : '', 'mm', (v) => {
        const list = (f.vertexRadii || []).filter((x) => !same(x.p, q));
        if (v !== '' && v != null) list.push({ p: q, r: v });
        f.vertexRadii = list;
        a.preview();
      }, { optional: true });
      inp.querySelector('input').placeholder = String(f.radius);
      body.appendChild(this.row(`${tr('Vertex')} ${i + 1} (${fmtP(q)})`, inp));
    });
  }

  // A variable fillet's points along its edges, each with its own radius: the edge (its place in the list of edges),
  // where along it (% of its length from its start; the point is marked in the view) and the radius there.
  renderEdgePoints(body, f) {
    const a = this.app, edges = f.edges || [];
    body.appendChild(el('div', { class: 'pm-sub' }, tr('Points along the edges')));
    (f.edgePoints || []).forEach((pt, i) => {
      const sel = el('select', { title: tr('The edge the point is on') });
      edges.forEach((_, k) => sel.appendChild(el('option', { value: String(k), ...(k === pt.edge ? { selected: '' } : {}) }, `${tr('Edge')} ${k + 1}`)));
      sel.onchange = () => { pt.edge = +sel.value; a.preview(); };
      const x = el('button', { class: 'pm-btn', title: tr('Remove this point') }, '✕');
      x.onclick = () => { f.edgePoints.splice(i, 1); a.preview(); this.renderPM(); };
      const head = el('div', { class: 'pm-edgept' });
      head.append(sel, x);
      body.appendChild(this.row(`${tr('Point')} ${i + 1}`, head));
      const at = this.exprInput(pt.t, pt.unit === 'mm' ? 'mm' : '%', (v) => { pt.t = v; a.preview(); });
      at.title = tr('Where along the edge, from its start (the point is marked in the view)');
      const unit = el('select', { title: tr('A share of the edge\'s length, or a distance from its start') });
      for (const [v, l] of [['%', '% of its length'], ['mm', 'mm from its start']]) unit.appendChild(el('option', { value: v, ...((pt.unit || '%') === v ? { selected: '' } : {}) }, tr(l)));
      unit.onchange = () => { pt.unit = unit.value === 'mm' ? 'mm' : undefined; if (!pt.unit) delete pt.unit; a.preview(); this.renderPM(); };
      const atRow = el('div', { class: 'pm-edgept' });
      atRow.append(at, unit);
      body.appendChild(this.row(tr('Along the edge'), atRow));
      const rad = this.exprInput(pt.r, 'mm', (v) => { pt.r = v; a.preview(); });
      body.appendChild(this.row(tr('Radius there'), rad));
    });
    const add = el('button', { class: 'pm-btn', title: tr('A point half way along an edge, with the fillet\'s radius: then set where it is and its radius') }, tr('Add Point'));
    add.disabled = !edges.length;
    add.onclick = () => { (f.edgePoints ||= []).push({ edge: 0, t: 50, r: f.radius }); a.preview(); this.renderPM(); };
    const byClick = el('button', { class: 'pm-btn', title: tr('Then click on one of the fillet\'s edges in the view, where the point goes') }, tr(a.pm?.pickEdgePoint ? 'Click the Edge…' : 'Add by Clicking'));
    byClick.disabled = !edges.length;
    byClick.onclick = () => { a.pm.pickEdgePoint = !a.pm.pickEdgePoint; if (a.pm.pickEdgePoint) a.status('Click on one of the fillet\'s edges where the point goes'); this.renderPM(); };
    const bar = el('div', { class: 'pm-btns' });
    bar.append(add, byClick);
    body.appendChild(bar);
    body.appendChild(el('div', { class: 'pm-hint' }, tr(edges.length ? 'The radius runs smoothly along each edge from its start through its points to its end. A point is placed by the share of the edge\'s length from its start, or a distance from its start (each point is marked in the view); Add by Clicking puts one where you click on an edge.' : 'Select the edges first, then add points along them.')));
  }

  pmGroup(root, title, id) {
    const key = id || title;
    const g = el('div', { class: 'pm-group' + (this.groupCollapsed.has(key) ? ' collapsed' : '') });
    const t = el('div', { class: 'pm-gt' }, `<span class="caret">${this.groupCollapsed.has(key) ? '▶' : '▼'}</span>${esc(tr(title))}`);
    t.onclick = () => {
      g.classList.toggle('collapsed');
      this.groupCollapsed[g.classList.contains('collapsed') ? 'add' : 'delete'](key);
      t.querySelector('.caret').textContent = g.classList.contains('collapsed') ? '▶' : '▼';
    };
    const b = el('div', { class: 'pm-gb' });
    g.append(t, b);
    root.appendChild(g);
    return b;
  }

  // A new feature in an inch document: its default lengths (the panel's mm fields) to the nearest 1/8 inch.
  inchDefaults(f) {
    for (const g of PM_SCHEMAS[f.type] || []) for (const fd of g.fields || []) {
      if (fd.unit !== 'mm' || typeof f[fd.key] !== 'number' || !f[fd.key]) continue;
      const v = f[fd.key], eighths = Math.max(1, Math.round((Math.abs(v) / 25.4) * 8));
      f[fd.key] = Math.sign(v) * (eighths / 8) * 25.4;
    }
  }

  completeExpression(input) {
    completeExpression(input, () => {
      const rows = this.app.doc.equations || [], { vars } = evalEquations(rows);
      return rows.map((q) => ({ name: q.name, value: this.app.result?.vars?.[q.name] ?? vars[q.name] }));
    });
  }

  exprInput(value, unit, onValid, { min = null, optional = false } = {}) {
    const wrap = el('div', { class: 'pm-input' });
    const input = el('input', { type: 'text', spellcheck: 'false' });
    this.completeExpression(input);
    // a length in an inch document: shown and typed in inches, stored in millimetres (units.js)
    const L = unit === 'mm' ? this.app.units : null;
    const toStore = (t) => (L ? lenValue(t, L) : normalizeValue(t));
    if (L) unit = L;
    input.value = L ? lenText(value, L) : value ?? '';
    const valEl = el('span', { class: 'val' });
    const unitEl = el('span', { class: 'unit' }, unit || '');
    if (unit) input.style.paddingRight = '52px';
    const vars = this.app.result?.vars || {};
    const check = (commit) => {
      if (optional && !input.value.trim()) { input.classList.remove('bad'); input.title = ''; valEl.textContent = ''; if (commit) onValid(''); return; }
      try {
        const v = evaluate(toStore(input.value), vars);
        if (min !== null && v < min) throw new Error(`Must be ≥ ${L ? fmtLen(min, L) : min}`);
        input.classList.remove('bad');
        input.title = '';
        valEl.textContent = isNumeric(input.value) ? '' : '= ' + (L ? fmtLen(v, L) : fmt(v));
        if (commit) onValid(toStore(input.value));
      } catch (e) {
        input.classList.add('bad');
        input.title = e.message;
        valEl.textContent = '';
      }
    };
    input.addEventListener('input', () => check(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (!isNumeric(input.value)) return;
        e.preventDefault();
        const step = L === 'in' ? (e.shiftKey ? 1 : 0.1) : e.shiftKey ? 10 : 1;
        input.value = String(+(parseFloat(input.value) + (e.key === 'ArrowUp' ? step : -step)).toFixed(6));
        check(true);
      }
    });
    check(false);
    wrap.append(input, valEl, unitEl);
    return wrap;
  }

  row(label, control, cls = '') {
    const r = el('div', { class: 'pm-row ' + cls });
    if (label !== null) r.appendChild(el('label', {}, esc(tr(label))));
    r.appendChild(control);
    return r;
  }

  renderFeaturePM(root) {
    const a = this.app, pm = a.pm, f = pm.feature, doc = a.doc;
    const info = TYPE_INFO[f.type];
    if(['plane','axis','point'].includes(f.type)&&!f.referenceDefinition){
      f.refs=legacyDatumRefs(f);f.referenceDefinition=true;
      if(['plane','axis'].includes(f.type))f.referenceLegacy=true;
      if(f.type==='point'&&f.pointType!=='coords')f.pointType='references';
      a.preview();
    }
    if(['sweep','surfSweep'].includes(f.type)){pm.sweepSlot ||= f.profileType==='circle'?'path':'profile';}
    if (f.type === 'surfFill' && f.continuity == null) f.continuity = f.tangent ? 'G1' : 'G0';
    if (['extrude','surfPlanar','revolve','surfExtrude','surfRevolve'].includes(f.type) && !Array.isArray(f.profiles)) { f.profiles = f.sketch ? [f.sketch] : []; f.sketch = null; }
    if(['revolve','surfRevolve'].includes(f.type)){if(!f.extent){try{f.extent=evaluate(f.angle??360,a.result?.vars||{})>=360?'full':'angle';}catch{f.extent='angle';}}f.end ||= 'oneway';}
    if (f.type === 'surfPlanar') f.edges ||= [];
    if (f.type === 'surfPlanar' && pm.planarEdges === undefined) pm.planarEdges = !!f.edges?.length && !f.profiles.length;
    this.pmHeader(root, iconFor(f), f.name);
    if(f.type==='point'&&f.pointType==='coords')root.appendChild(el('div',{'data-datum-status':'checking',class:'pm-msg'},'Updating preview…'));
    const err = a.result?.errors.get(f.id);
    if (f.type === 'loft' && f.ruled && pm.loftSlot === 'guides') { pm.loftSlot = 'profiles'; pm.loftDraft = null; pm.loftHover = null; }
    const waitingForRefs = f.referenceDefinition || f.type === 'plane' && !inferPlaneType(planeRefs(f), f.through);
    const waitingForProfiles = ['loft', 'surfLoft'].includes(f.type) && (f.profiles || []).length < 2;
    if (waitingForProfiles) root.appendChild(el('div', { class: 'pm-msg' }, 'Select two or more section profiles in the canvas.'));
    else if (f.type === 'extrude' && !f.profiles.length) root.appendChild(el('div', { class: 'pm-msg' }, 'Select one or more profiles in the canvas, or select a whole sketch in the tree.'));
    else if (err && !waitingForRefs) root.appendChild(el('div', { class: 'pm-msg pm-status err' }, esc(err)));
    else if (pm.isNew && !waitingForRefs) root.appendChild(el('div', { class: 'pm-msg pm-status' }, 'Set the parameters. The model previews live. Click ✔ to accept.'));

    const note = a.result?.notes?.get(f.id);
    if (note && !err) root.appendChild(el('div', { class: 'pm-msg ok','data-pm-note':'' }, esc(note)));
    const idx = doc.features.indexOf(f);
    const before = doc.features.slice(0, idx < 0 ? doc.features.length : idx);
    const schema = PM_SCHEMAS[f.type] || [];
    for (const grp of schema) {
      if (grp.show && !grp.show(f)) continue;
      const visible = grp.fields.filter((fd) => !fd.show || fd.show(f, a));
      if (!visible.length) continue;
      const body = this.pmGroup(root, grp.title, f.type + ':' + grp.title);
      for (const fd0 of visible) {
        // labels, hints and options may depend on the feature
        const fd = { ...fd0 };
        for (const k of ['label', 'hint', 'options', 'text']) if (typeof fd[k] === 'function') fd[k] = fd[k](f, a);
        // (world: [the user's axis, the feature's keys for RazorCAD's x, y, z]: which one it is, and negated or not)
        if (fd.world) { const ik = W.internalAxis(fd.world[0]); fd.key = fd.world[1]['xyz'.indexOf(ik.slice(-1))]; fd.neg = ik.startsWith('-'); }
        if (fd.type === 'hint') {
          body.appendChild(el('div', { class: 'pm-hint' }, esc(fd.text)));
        } else if(fd.type==='sweepSelection'){
          this.renderSweepSelection(body,f,before,fd);
        } else if(fd.type==='loftCorrespondence'){
          this.renderLoftCorrespondence(body,f);
        } else if (fd.type === 'loftSelection') {
          this.renderLoftSelection(body, f, before, fd);
        } else if (fd.type === 'sketchList') {
          this.renderSketchList(body, f, before, fd);
        } else if (fd.type === 'text') {
          // (a line of text: a list such as a pattern's instances to skip)
          const input = el('input', { type: 'text', value: f[fd.key] ?? '', placeholder: fd.placeholder || '', 'data-feature-text': fd.key, spellcheck: 'false' });
          input.onchange = () => { f[fd.key] = input.value; a.preview(true); };
          const w = el('div', { class: 'pm-input' }); w.appendChild(input);
          body.appendChild(this.row(fd.label, w));
        } else if (fd.type === 'vertexList') {
          if (!Array.isArray(f[fd.key])) f[fd.key] = [];
          const L = f[fd.key], ul = el('div', { class: 'pm-list', 'data-vertex-list': fd.key });
          body.appendChild(el('div', { class: 'pm-hint' }, esc(fd.hint || 'Click vertices on the model.')));
          if (!L.length) ul.appendChild(el('div', { class: 'li pm-hint' }, 'No corners selected'));
          L.forEach((v, i) => { const li = el('div', { class: 'li sel' }, `${icon('point')}<span>Corner&lt;${i + 1}&gt;</span><span class="x" title="Remove">✕</span>`); li.querySelector('.x').onclick = () => { L.splice(i, 1); this.renderPM(); a.updateEdgeHighlights(); a.preview(); }; ul.appendChild(li); });
          body.appendChild(ul);
        } else if (fd.type === 'vertexRadii') {
          this.renderVertexRadii(body, f);
        } else if (fd.type === 'edgePoints') {
          this.renderEdgePoints(body, f);
        } else if(fd.type==='solidOperation'){
          const select=el('select',{'data-solid-operation':''});
          for(const [value,label] of [['join','Join'],['new','New body'],['cut','Cut'],['intersect','Intersect']])select.appendChild(el('option',{value},label));
          select.value=f.op==='cut'||f.op==='intersect'?f.op:f.merge===false?'new':'join';
          select.onchange=()=>{f.op=['cut','intersect'].includes(select.value)?select.value:'add';f.merge=select.value!=='new';pm.scopePick=false;this.renderPM();a.preview(true);};
          body.appendChild(this.row('Operation',select));
        } else if(fd.type==='axisPick'){
          body.appendChild(el('button',{class:'pm-btn'+(pm.profilePick===false&&!pm.scopePick&&!pm.revolveEndPick?' on':''),'data-profile-axis':'',onclick:()=>{pm.profilePick=false;pm.scopePick=false;pm.revolveEndPick=false;pm.loftDraft=null;this.renderPM();a.updateSketchDisplay();}},'Select axis in canvas'));
        } else if (fd.type === 'edges') {
          this.renderEdgeList(body, f);
        } else if (fd.type === 'points3d') {
          this.renderPoints3d(body, f);
        } else if (fd.type === 'gauge') {
          this.renderGauge(body, f);
        } else if (fd.type === 'faceList') {
          this.renderFaceList(body, f, fd);
        } else if (fd.type === 'bodyList') {
          this.renderBodyList(body, f, fd);
        } else if (fd.type === 'bodySel') {
          this.renderBodySel(body, f, fd);
        } else if (fd.type === 'featureList') {
          // more features (a pattern's): listed, each removable, added from the features before this one
          if (!Array.isArray(f[fd.key])) f[fd.key] = [];
          const L = f[fd.key];
          if (L.length) {
            const ul = el('div', { class: 'pm-list' });
            L.forEach((id, i) => {
              const folder = String(id).startsWith('folder:') ? (a.doc.featureFolders || []).find((g) => 'folder:' + g.id === id) : null;
              const x = folder ? null : before.find((y) => y.id === id);
              const li = el('div', { class: 'li sel' }, `${icon(folder ? 'folder' : x ? iconFor(x) : 'feature')}<span>${esc(folder ? `${folder.name} (folder)` : x?.name || '(missing)')}</span><span class="x" title="Remove">✕</span>`);
              li.querySelector('.x').onclick = () => { L.splice(i, 1); this.renderPM(); a.preview(true); };
              ul.appendChild(li);
            });
            body.appendChild(ul);
          }
          const sel = el('select');
          sel.appendChild(el('option', { value: '' }, '+ Add a feature…'));
          for (const x of before.filter((y) => !PATTERN_SKIP.has(y.type) && !y.suppressed && y.id !== f.feature && !L.includes(y.id))) sel.appendChild(el('option', { value: x.id }, esc(x.name)));
          for (const g of (a.doc.featureFolders || []).filter((y) => !L.includes('folder:' + y.id))) sel.appendChild(el('option', { value: 'folder:' + g.id }, esc(`${g.name} (folder)`)));
          sel.onchange = () => { if (sel.value) { L.push(sel.value); this.renderPM(); a.preview(true); } };
          const w = el('div', { class: 'pm-input' }); w.appendChild(sel);
          body.appendChild(this.row(fd.label, w));
        } else if (fd.type === 'curveList') {
          // an ordered list of curves (sketches, 3D sketches, composite / projected curves, helices)
          if (!Array.isArray(f[fd.key])) f[fd.key] = [];
          const L = f[fd.key], ul = el('div', { class: 'pm-list' });
          if (!L.length) ul.appendChild(el('div', { class: 'li pm-hint' }, fd.empty || 'No curves yet'));
          L.forEach((id, i) => {
            const x = before.find((y) => y.id === id);
            const li = el('div', { class: 'li sel' }, `${icon(x ? TYPE_INFO[x.type]?.icon || 'sketch' : 'sketch')}<span>${i + 1}. ${esc(x?.name || '(missing)')}</span><span class="x" title="Move up">▲</span><span class="x" title="Remove">✕</span>`);
            const [up, rm] = li.querySelectorAll('.x');
            up.onclick = () => { if (i > 0) { [L[i - 1], L[i]] = [L[i], L[i - 1]]; a.preview(true); } };
            rm.onclick = () => { L.splice(i, 1); a.preview(true); };
            ul.appendChild(li);
          });
          body.appendChild(ul);
          const sel = el('select');
          sel.appendChild(el('option', { value: '' }, fd.add || '+ Add a curve…'));
          for (const x of before.filter((y) => (fd.types || ['sketch', 'sketch3d', 'compCurve', 'projCurve', 'helix']).includes(y.type) && !y.suppressed && !L.includes(y.id))) sel.appendChild(el('option', { value: x.id }, esc(x.name)));
          sel.onchange = () => { if (sel.value) { L.push(sel.value); a.preview(true); } };
          const w = el('div', { class: 'pm-input' }); w.appendChild(sel);
          body.appendChild(w);
        } else if (fd.type === 'boundarySel') {
          const opts = [['', '— choose the boundary —'], ...Object.entries(STD_PLANES).map(([k, p]) => [k, 'Plane: ' + p.name]),
            ...before.filter((x) => x.type === 'plane' && !x.suppressed).map((x) => [x.id, 'Plane: ' + x.name]),
            ...(a.result?.bodies || []).filter((b) => !f.bodies?.includes(b.id)).map((b) => [b.id, 'Body: ' + b.name])];
          const sel = el('select');
          for (const [v, l] of opts) { const o = el('option', { value: v }, esc(l)); if ((f.tool || '') === v) o.selected = true; sel.appendChild(o); }
          sel.onchange = () => { f.tool = sel.value; this.renderPM(); a.preview(); };
          const w = el('div', { class: 'pm-input' }); w.appendChild(sel);
          body.appendChild(this.row(fd.label, w));
        } else if (fd.type === 'profileSel') {
          // standard → type → size (or custom sizes)
          const sel = (label, opts, val, on) => {
            const s2 = el('select');
            for (const [v, l] of opts) { const o = el('option', { value: v }, esc(l)); if (String(val) === String(v)) o.selected = true; s2.appendChild(o); }
            s2.onchange = () => { on(s2.value); this.renderPM(); a.preview(); };
            const w = el('div', { class: 'pm-input' }); w.appendChild(s2);
            body.appendChild(this.row(label, w));
          };
          const firstSize = () => LIBRARY[f.standard]?.[f.ptype]?.[0]?.name || '';
          sel('Standard', [...STANDARDS.map((x) => [x, x]), ['custom', 'Custom sizes']], f.standard, (v) => { f.standard = v; if (v !== 'custom' && !(LIBRARY[v]?.[f.ptype] || []).some((x) => x.name === f.size)) f.size = firstSize(); });
          sel('Type', Object.entries(PROFILE_TYPES).map(([k, t]) => [k, t.label]), f.ptype, (v) => { f.ptype = v; f.size = firstSize(); });
          if (f.standard !== 'custom') {
            const list = LIBRARY[f.standard]?.[f.ptype] || [];
            sel('Size', list.map((x) => [x.name, x.name]), f.size, (v) => { f.size = v; });
          } else {
            f.dims ||= {};
            for (const [k, label] of PROFILE_TYPES[f.ptype].dims) {
              const inp = this.exprInput(f.dims[k] ?? '', 'mm', (v) => { f.dims[k] = v; a.preview(); });
              body.appendChild(this.row(label, inp));
            }
          }
        } else if (fd.type === 'trimTool') {
          const opts = [['', '— choose the trim tool —'], ...Object.entries(STD_PLANES).map(([k, p]) => [k, 'Plane: ' + p.name]),
            ...before.filter((x) => x.type === 'plane' && !x.suppressed).map((x) => [x.id, 'Plane: ' + x.name]),
            ...(a.result?.bodies || []).filter((b) => b.kind === 'surface').map((b) => [b.id, 'Surface: ' + b.name]),
            ...before.filter((x) => x.type === 'sketch' && !x.suppressed).map((x) => [x.id, 'Sketch: ' + x.name])];
          const sel = el('select');
          for (const [v, l] of opts) { const o = el('option', { value: v }, esc(l)); if ((f.tool || '') === v) o.selected = true; sel.appendChild(o); }
          sel.onchange = () => { f.tool = sel.value; this.renderPM(); a.preview(); };
          const w = el('div', { class: 'pm-input' }); w.appendChild(sel);
          body.appendChild(this.row(fd.label, w));
        } else if (fd.type === 'splitTool') {
          this.renderSplitTool(body, f, before);
        } else if (fd.type === 'mates') {
          this.renderMates(body, f);
        } else if (fd.type === 'fileinfo') {
          body.appendChild(el('div', {}, `<b>${esc(f.fileName || '(no file)')}</b>`));
          body.appendChild(el('div', { class: 'pm-hint' }, `${f.format === 'step' ? 'STEP (exact B-rep solid)' : `${String(f.format).toUpperCase()} (triangle mesh converted to a solid)`} · ${(f.data.length / 1024).toFixed(0)} KB stored in the part file`));
        } else if (fd.type === 'planeRefs') {
          this.renderPlaneRefs(body, f, before);
        } else if (fd.type === 'angleQuick') {
          const row = el('div', { style: 'display:flex;gap:6px' });
          for (const [v, label] of [[0, 'Parallel (0°)'], [90, 'Perpendicular (90°)']]) {
            row.appendChild(el('button', { class: 'pm-btn', style: 'flex:1', onclick: () => { f.angle = v; this.renderPM(); a.preview(); } }, label));
          }
          body.appendChild(this.row(null, row, 'check'));
        } else if (fd.type === 'pick') {
          const picked = !!f[fd.key];
          const row = el('div', { style: 'display:flex;gap:6px;align-items:center' });
          const what = { edge: ['Edge', 'an edge'], vertex: ['Vertex', 'a vertex'], face: ['Face', 'a cylindrical or conical face'], cylface: ['Cylinder', 'a bore or a shaft (a cylindrical face)'], faceAny: ['Face', 'a face (flat or curved)'], flatface: ['Face', 'a flat face'] }[fd.what];
          row.appendChild(el('div', { class: 'pm-hint', style: 'flex:1' }, picked ? `✔ ${what[0]} selected — click another to replace` : `Click ${what[1]} on the model`));
          if (picked) row.appendChild(el('button', { class: 'pm-btn', onclick: () => { f[fd.key] = null; this.renderPM(); a.updateEdgeHighlights(); a.preview(); } }, 'Clear'));
          body.appendChild(this.row(fd.label, row));
        } else if (fd.type === 'expr') {
          body.appendChild(this.row(fd.label, this.exprInput(fd.neg ? negExpr(f[fd.key] ?? fd.default) : (f[fd.key] ?? fd.default), fd.unit, (v) => { f[fd.key] = fd.neg ? negExpr(v) : v; a.preview(); }, { optional: !!fd.optional })));
        } else if (fd.type === 'check') {
          const cb = el('input', { type: 'checkbox' });
          cb.checked = !!(f[fd.key] ?? fd.default);
          cb.onchange = () => { f[fd.key] = cb.checked; if (f.type === 'extrude' && fd.key === 'scopeAll' && !cb.checked) pm.extrudePick = false; fd.onChange?.(f, a); if (fd.onChange) this.renderPM(); a.preview(true); a.updateEdgeHighlights(); };
          const lab = el('label');
          lab.append(cb, document.createTextNode(tr(fd.label)));
          body.appendChild(this.row(null, lab, 'check'));
        } else {
          let options = typeof fd.options === 'function' ? fd.options(f, doc) : fd.options;
          if (fd.type === 'sketch') options = [['', '— select a sketch —'], ...before.filter((x) => x.type === 'sketch').map((x) => [x.id, x.name])];
          if (fd.type === 'feature') options = [['', '— select a feature —'], ...before.filter((x) => !PATTERN_SKIP.has(x.type) && !x.suppressed).map((x) => [x.id, x.name])];
          if (fd.type === 'axis') {
            options = [['v', 'Sketch vertical axis'], ['u', 'Sketch horizontal axis'], ...axisCandidates(findFeature(doc, f.sketch || LR.sourceId(f.profiles?.[0])))];
            if (f.axis === 'sketchLine') options.push(['sketchLine','✔ Sketch line (picked in canvas)']);
            if (f.axis === 'edge') options.push(['edge', '✔ Model edge (picked on the model)']);
            if (f.axis === 'face') options.push(['face', '✔ Cylindrical face (picked on the model)']);
          }
          if (fd.type === 'plane') options =[...Object.entries(STD_PLANES).map(([k, p]) => [k, p.name]), ...before.filter((x) => x.type === 'plane' && x.id !== f.id).map((x) => [x.id, x.name])];
          const axisFeats = before.filter((x) => x.type === 'axis' && !x.suppressed).map((x) => [x.id, x.name]);
          const pointFeats = before.filter((x) => x.type === 'point' && !x.suppressed).map((x) => [x.id, x.name]);
          if (fd.type === 'axis') options = [...options, ...axisFeats];
          if (fd.type === 'direction') options = [...(fd.none ? [['none', 'None']] : []), ...axisChoices(f[fd.key]), ...axisFeats];
          if (fd.type === 'pointSel') options = [['', '— select a reference point —'], ...pointFeats];
          if (fd.type === 'pointRef') options = [['', f[REF_PICKED[fd.key] || 'toVertex'] ? '✔ Vertex picked on the model' : '— click a vertex on the model —'], ...pointFeats];
          if (fd.type === 'surfaceRef') options = [['', f[REF_PICKED[fd.key] || 'toFace'] ? '✔ Face picked on the model' : '— click a flat face on the model —'], ...Object.entries(STD_PLANES).map(([k, p]) => [k, p.name]), ...before.filter((x) => x.type === 'plane' && !x.suppressed).map((x) => [x.id, x.name])];
          if (fd.type === 'pathSel') options = [['', fd.optional ? '— None —' : '— a sketch, 3D sketch, curve or helix —'], ...before.filter((x) => ['sketch', 'helix', 'sketch3d', 'compCurve', 'projCurve'].includes(x.type) && !x.suppressed && (['sweep','surfSweep'].includes(f.type) && f.profileType === 'circle' || x.id !== f.profile) && !(['sweep','surfSweep'].includes(f.type) && x.id === (fd.key === 'guide' ? f.path : f.guide))).map((x) => [x.id, x.name])];
          if (fd.type === 'threadSize') {
            options = [['auto', 'Automatic (the size that fits the face)'], ...threadList(f.system || 'metric').map((t) => [t.id, t.label]), ['custom', 'Custom…']];
            if (!options.some(([vv]) => vv === f.size)) f.size = 'auto';
          }
          if (fd.type === 'sketchLineSel') {
            options = [['', '— select a sketch line —']];
            for (const sk of before.filter((x) => x.type === 'sketch')) for (const c of sk.curves || []) if (c.type === 'line') options.push([`${sk.id}:${c.id}`, `${sk.name}: ${SM.itemName(sk, c.id)}`]);
          }

          const s = el('select');
          for (const [v, l] of options) {
            const o = el('option', { value: v }, esc(tr(l)));
            if ((f[fd.key] ?? '') === v) o.selected = true;
            s.appendChild(o);
          }
          if (['sweep','surfSweep'].includes(f.type)) s.dataset.sweepField = fd.key;
          if (['loft', 'surfLoft'].includes(f.type) && /^(start|end)/.test(fd.key)) { s.dataset.loftEndField = fd.key; if (fd.type === 'direction') s.onfocus = () => { pm.loftEndAxis = fd.key; }; }
          if (['revolve','surfRevolve'].includes(f.type)&&fd.key==='axis')s.onfocus=()=>{pm.profilePick=false;pm.scopePick=false;pm.revolveEndPick=false;a.updateSketchDisplay();};
          if (['revolve','surfRevolve','surfExtrude','extrude'].includes(f.type))s.dataset.featureField=fd.key;
          if(f.referenceDefinition)s.dataset.datumField=fd.key;
          if (f.type === 'surfFill' && fd.key === 'continuity') s.dataset.patchContinuity = '';
          if (['sweep','surfSweep'].includes(f.type) && ['profile','path','guide'].includes(fd.key)) s.onfocus = () => { pm.sweepSlot = fd.key; };
          if(['extrude','surfExtrude'].includes(f.type)&&['surfaceRef','pointRef'].includes(fd.type))s.onfocus=()=>{pm.extrudeSurfaceSlot=REF_SLOT[fd.key];pm.extrudePick=false;pm.profilePick=f.type==='surfExtrude'?false:pm.profilePick;pm.planarEdges=false;pm.scopePick=false;a.updateSketchDisplay();};
          if(f.type==='hole'&&['surfaceRef','pointRef'].includes(fd.type))s.onfocus=()=>{pm.holeEndPick=true;a.updateSketchDisplay();};
          if(['revolve','surfRevolve'].includes(f.type)&&['surfaceRef','pointRef'].includes(fd.type))s.onfocus=()=>{pm.revolveEndPick=true;pm.profilePick=false;pm.scopePick=false;a.updateSketchDisplay();};
          s.onchange = () => {
            f[fd.key] = s.value || null;
            if(f.type==='surfExtrude'&&(['surfaceRef','pointRef'].includes(fd.type)||fd.key==='startFrom'&&f.startFrom==='surface'||fd.key==='end'&&['upToVertex','upToSurface','offsetSurface'].includes(f.end))){pm.profilePick=false;pm.planarEdges=false;}
            if(['extrude','surfExtrude'].includes(f.type)){
              if(fd.key==='startFrom'&&f.startFrom==='surface'){pm.extrudeSurfaceSlot='start';pm.extrudePick=false;pm.scopePick=false;}
              if(['surfaceRef','pointRef'].includes(fd.type)){pm.extrudeSurfaceSlot=REF_SLOT[fd.key];f[REF_PICKED[fd.key]]=null;}
              if(fd.key==='end')pm.extrudeSurfaceSlot='end';
              if(fd.key==='end2')pm.extrudeSurfaceSlot='end2';
            }
            if(['revolve','surfRevolve'].includes(f.type)){
              if(['surfaceRef','pointRef'].includes(fd.type)){pm.revolveEndPick=true;f[REF_PICKED[fd.key]]=null;}
              if(fd.key==='extent'&&revUpTo(f)){pm.revolveEndPick=true;pm.profilePick=false;pm.scopePick=false;}
            }
            if(f.type==='point'&&fd.key==='pointType'&&s.value==='references')useReferenceRelations(f);
            if(['sweep','surfSweep'].includes(f.type)&&fd.key==='profileType'){pm.sweepSlot=f.profileType==='circle'?'path':'profile';pm.sweepCanvas=true;pm.loftDraft=null;pm.loftHover=null;}
            if (['revolve','surfRevolve'].includes(f.type)&&fd.key==='axis')s.onfocus=()=>{pm.profilePick=false;pm.scopePick=false;pm.revolveEndPick=false;a.updateSketchDisplay();};
          if (['revolve','surfRevolve','surfExtrude','extrude'].includes(f.type))s.dataset.featureField=fd.key;
          if (f.type === 'surfFill' && fd.key === 'continuity' && s.value === 'G0' && !f.edges.some(e => e.continuity && e.continuity !== 'G0')) pm.patchSupportPick = false;
            if (['loft', 'surfLoft'].includes(f.type) && /^(start|end)Condition$/.test(fd.key)) { pm.loftConnector=null; pm.loftEndSlot = ['tangent', 'curvature'].includes(s.value) ? fd.key.replace('Condition', 'Faces') : null; pm.loftDraft = null; a.updateSketchDisplay(); }
            if (f.type === 'extrude' && (['pointRef', 'surfaceRef'].includes(fd.type) || (fd.key === 'end' && ['upToVertex', 'upToSurface', 'offsetSurface'].includes(f.end)) || (fd.key === 'end2' && ['upToVertex', 'upToSurface', 'offsetSurface'].includes(f.end2)))) { pm.extrudePick = false; pm.loftHover = null; a.updateSketchDisplay(); }
            // an open sketch can only be extruded as a thin feature
            if (fd.type === 'sketch' && f.type === 'extrude' && SM.isOpenSketch(findFeature(doc, f.sketch))) f.thin = true;
            a.preview(true);
          };
          const wrap = el('div', { class: 'pm-input' });
          wrap.appendChild(s);
          body.appendChild(this.row(fd.label, wrap));
          if(f.type==='hole'&&['surfaceRef','pointRef'].includes(fd.type))body.appendChild(el('button',{class:'pm-btn'+(pm.holeEndPick?' on':''),'data-hole-end-pick':fd.key,onclick:()=>{pm.holeEndPick=!pm.holeEndPick;this.renderPM();a.updatePlanes();a.status(pm.holeEndPick?(fd.type==='pointRef'?'Click the vertex the holes go up to.':'Select the plane or flat face the holes go up to.'):'Click points on a face for the holes.');}},fd.type==='pointRef'?'Pick end vertex in canvas':'Pick end surface in canvas'));
          if(['revolve','surfRevolve'].includes(f.type)&&['surfaceRef','pointRef'].includes(fd.type))body.appendChild(el('button',{class:'pm-btn'+(pm.revolveEndPick?' on':''),'data-revolve-end-pick':fd.key,onclick:()=>{pm.revolveEndPick=true;pm.profilePick=false;pm.scopePick=false;this.renderPM();a.updateSketchDisplay();a.updatePlanes();a.status(fd.type==='pointRef'?'Click the vertex the revolution goes up to.':'Select the plane or flat face the revolution goes up to.');}},fd.type==='pointRef'?'Pick end vertex in canvas':'Pick end surface in canvas'));
          if(['extrude','surfExtrude'].includes(f.type)&&fd.type==='surfaceRef')body.appendChild(el('button',{class:'pm-btn'+(pm.extrudeSurfaceSlot===REF_SLOT[fd.key]&&(f.type==='extrude'||pm.profilePick===false&&!pm.planarEdges)?' on':''),'data-extrude-surface-pick':fd.key,onclick:()=>{pm.extrudeSurfaceSlot=REF_SLOT[fd.key];pm.extrudePick=false;if(f.type==='surfExtrude'){pm.profilePick=false;pm.planarEdges=false;}pm.scopePick=false;this.renderPM();a.updateSketchDisplay();a.updatePlanes();a.status(`Select a plane or planar face for the ${{start:'start',end:'end',end2:'second side’s end'}[pm.extrudeSurfaceSlot]} of the extrusion.`);}},{startPlane:'Pick start surface in canvas',toPlane:'Pick end surface in canvas',toPlane2:'Pick second side surface in canvas'}[fd.key]));
        }
      }
    }
    if (['extrude', 'revolve'].includes(f.type)) {
      root.appendChild(el('div', { class: 'pm-hint', style: 'padding:0 10px' }, 'Tip: type an equation name or expression (e.g. <code>thickness*2</code>) into any value field. Arrow keys step numbers.'));
    }
    if (f.type === 'lpattern' || f.type === 'cpattern' || f.type === 'mirror') {
      root.appendChild(el('div', { class: 'pm-hint', style: 'padding:0 10px' }, 'Patterns and mirrors repeat the selected boss or cut feature.'));
    }
    if(f.referenceDefinition)this.updateDatumStatus(root,f);
    void info;
  }

  renderSketchPatternPM(root) {
    const sk = this.app.sketcher, d = sk.patternDraft;
    this.pmHeader(root, 'skLinPattern', d.id ? 'Edit Sketch Pattern' : 'Sketch Pattern');
    const source = this.pmGroup(root, 'Entities to pattern', 'sk:patternSources');
    const pickSources = el('button', { class: d.pick === 'sources' ? 'active' : '', onclick: () => { d.pick = 'sources'; this.renderPM(); } }, 'Select entities in the sketch');
    source.appendChild(pickSources);
    source.appendChild(el('div', { class: 'pm-hint' }, 'Click entities to add or remove them. Copies stay linked; edit the original geometry to change their shape.'));
    const list = el('div', { class: 'pm-list' });
    for (const id of d.sources) {
      const li = el('div', { class: 'li sel' }, `<span>${esc(SM.itemName(sk.f, id))}</span><span class="x" title="Remove">✕</span>`);
      li.querySelector('.x').onclick = () => { d.sources = d.sources.filter((q) => q !== id); sk.updatePatternPreview(); this.renderPM(); };
      list.appendChild(li);
    }
    source.appendChild(list);
    const direction = this.pmGroup(root, 'Direction / path', 'sk:patternDirection');
    const sel = el('select', { 'data-pattern': 'path' });
    sel.appendChild(el('option', { value: '' }, 'By angle'));
    const generated = SM.patternEntities(sk.f);
    for (const c of sk.f.curves) if (!generated.has(c.id) && !c.ctrlOf) sel.appendChild(el('option', { value: c.id }, SM.itemName(sk.f, c.id)));
    sel.value = d.path || '';
    sel.onchange = () => { d.path = sel.value; d.sources = d.sources.filter((id) => id !== d.path); sk.updatePatternPreview(); this.renderPM(); };
    direction.appendChild(this.row('Direction 1', sel));
    direction.appendChild(el('button', { class: d.pick === 'path' ? 'active' : '', onclick: () => { d.pick = 'path'; this.renderPM(); } }, 'Pick a line or curve'));
    const curved = d.path && SM.getCurve(sk.f, d.path)?.type !== 'line';
    const parameters = this.pmGroup(root, 'Parameters', 'sk:patternParameters');
    const message = el('div', { class: 'pm-msg' });
    const updateMessage = () => {
      message.className = 'pm-msg' + (sk.patternError ? ' err' : '');
      message.textContent = sk.patternError || `${(sk.patternPreview?.pattern.made || 0) + 1} instances including the original${curved ? '; spacing measured along the path (copies stop at an open end)' : ''}.`;
    };
    const field = (key, label, unit = '') => {
      const wrap = el('div', { class: 'pm-input' });
      const inp = el('input', { type: 'text', value: String(d[key]), 'data-pattern': key });
      this.completeExpression(inp);
      inp.oninput = () => { d[key] = inp.value; sk.updatePatternPreview(); updateMessage(); };
      wrap.appendChild(inp); if (unit) wrap.appendChild(el('span', { class: 'unit' }, unit));
      parameters.appendChild(this.row(label, wrap));
    };
    field('n1', 'Instances 1 (includes original)');
    field('d1', 'Spacing 1', 'mm');
    if (!d.path) field('a1', 'Angle 1', '°');
    if (curved) {
      const check = el('input', { type: 'checkbox', 'data-pattern': 'turn' }); check.checked = !!d.turn;
      check.onchange = () => { d.turn = check.checked; sk.updatePatternPreview(); updateMessage(); };
      const label = el('label'); label.append(check, document.createTextNode(' Rotate instances with the path'));
      parameters.appendChild(this.row(null, label, 'check'));
    } else {
      field('n2', 'Instances 2 (1 disables)'); field('d2', 'Spacing 2', 'mm'); field('a2', 'Angle 2', '°');
    }
    parameters.appendChild(message); updateMessage();
  }

  renderSketchPM(root) {
    const a = this.app, sk = a.sketcher, f = sk.f;
    if (sk.patternDraft) { this.renderSketchPatternPM(root); return; }
    this.pmHeader(root, 'sketch', f.name);
    const variants=SKETCH_TOOL_GROUPS.find(g=>g[2].includes(sk.tool));
    if(variants){
      const group=this.pmGroup(root,tr(variants[1])+' type','sk:tool-variant'),select=el('select',{'data-sketch-tool-variant':variants[0],'aria-label':tr(variants[1])+' type'});
      for(const tool of variants[2])select.appendChild(el('option',{value:tool},esc(tr(SKETCH_TOOLS[tool].label))));
      select.value=sk.tool;select.onchange=()=>a.sketchTool(select.value);
      group.appendChild(this.row('Type',select));
    }
    const st = sk.statusText();
    if (st.text) root.appendChild(el('div', { class: 'pm-msg ' + st.cls }, esc(st.text)));
    if (f.patterns?.length) {
      const g = this.pmGroup(root, 'Sketch Patterns', 'sk:patterns');
      for (const [i, p] of f.patterns.entries()) {
        const row = el('div', { class: 'pm-row' });
        row.appendChild(el('button', { onclick: () => sk.linearPatternSel(p.id) }, `Edit Pattern ${i + 1}`));
        row.appendChild(el('button', { onclick: () => { SM.removeSketchPattern(f, p.id); sk.sel.clear(); sk.changed(); } }, 'Delete'));
        g.appendChild(row);
      }
    }
    if (sk.tool !== 'select') root.appendChild(el('div', { class: 'pm-msg' }, `<b>${esc(SKETCH_TOOLS[sk.tool].label)}:</b> ${esc(SKETCH_TOOLS[sk.tool].hint)}`));
    if (['line', 'midline', 'rect', 'crect', 'circle', 'arc', 'arc3', 'tarc', 'ellipse', 'spline', 'cspline', 'polygon', 'slot', 'cslot', 'oslot', 'arcslot', 'arcslot3'].includes(sk.tool)) {
      const g = this.pmGroup(root, 'Creation Options', 'sk:creation');
      const cb = el('input', { type: 'checkbox', 'data-construction-mode': '' }); cb.checked = sk.constructionMode;
      cb.onchange = () => { sk.constructionMode = cb.checked; sk.redraw(); this.refreshCommandStates(); };
      const label = el('label'); label.append(cb, document.createTextNode(' For construction'));
      g.appendChild(this.row(null, label, 'check'));
    }

    if(['convert','intersect'].includes(sk.tool)){
      const group=this.pmGroup(root,'Projection Source','sk:projection-source'),select=el('select',{'data-projection-source':'','aria-label':'Projection source'});
      group.classList.add('datum-definition');
      select.append(el('option',{value:'all'},'All earlier geometry'),el('option',{value:'model'},'Model edges / sections only'));
      const index=a.doc.features.indexOf(sk.f);
      for(const source of a.doc.features.slice(0,index).filter(f=>f.type==='sketch'&&!f.suppressed&&a.result?.sketches.has(f.id)&&!a.result.errors.has(f.id)))select.appendChild(el('option',{value:'sketch:'+source.id},esc(source.name)));
      select.value=sk.projectionSource||'all';select.onchange=()=>{sk.projectionSource=select.value;sk.extHover=null;sk.hover=null;a.updateSketchDisplay();sk.redraw();};
      group.appendChild(this.row('Source',select));group.appendChild(el('div',{class:'pm-hint'},'Choose one sketch to pick overlapping entities unambiguously. Source geometry is gray; projected entities are purple. Other source sketches are temporarily hidden; their saved visibility is preserved. Only clicked entities are projected.'));
    }
    if (sk.tool === 'offset') {
      const g = this.pmGroup(root, 'Offset Options', 'sk:offset');
      const mode=el('select',{'data-offset-mode':'',onchange:e=>{sk.offsetMode=e.target.value;sk.redraw();}});
      for(const [value,label] of [['side','Pick side'],['inside','Inside / left'],['outside','Outside / right'],['both','Both sides']])mode.appendChild(el('option',{value,selected:sk.offsetMode===value},label));
      g.appendChild(this.row('Direction',mode));
      const distance=this.exprInput(sk.offsetDistance,'mm',v=>{sk.offsetDistance=v;sk.offsetTyped=true;sk.redraw();});distance.dataset.offsetDistance='';g.appendChild(this.row('Distance',distance));
      g.appendChild(el('button',{class:'pm-btn','data-offset-mouse':'',onclick:()=>{sk.offsetTyped=false;sk.redraw();}},'Use mouse distance'));
      g.appendChild(el('div',{class:'pm-hint'},'Inside/outside applies to closed contours; for open chains these mean left/right along the chain. Both sides uses this distance on each side.'));
      const opt = (label, key, title) => {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = !!sk[key];
        cb.onchange = () => { sk[key] = cb.checked; if(key==='offsetChain'&&sk.draw?.tool==='offset')sk.endDraw();sk.offHoverId=null;sk.offHover=null;sk.redraw();this.renderPM(); };
        const lab = el('label', { title });
        lab.append(cb, document.createTextNode(' ' + label));
        g.appendChild(this.row(null, lab, 'check'));
      };
      opt('Linked offset', 'offsetLinked', 'On: the offset follows its source (sketch entities or model edges) and keeps one editable offset dimension. Off: a single offset — plain geometry with no link.');
      opt('Select chain', 'offsetChain', 'Offset a connected chain of sketch curves or model edges. Turn off to offset only the clicked entity.');
      g.appendChild(el('div',{class:'pm-hint'},'Spline offsets are fitted within 0.001 mm. Reduce the distance if an offset folds or collapses.'));
      g.appendChild(el('div', { class: 'pm-hint' }, sk.offsetLinked ? 'Linked: the offset updates when the source changes; its distance stays editable.' : 'Single: the offset is created once as plain geometry and does not follow the source.'));
    }

    if (sk.tool === 'sfillet' || sk.tool === 'schamfer') {
      const fillet = sk.tool === 'sfillet';
      const g = this.pmGroup(root, fillet ? 'Fillet Parameters' : 'Chamfer Parameters', 'sk:blend');
      g.appendChild(this.row(fillet ? 'Radius' : 'Distance', this.exprInput(fillet ? sk.filletR : sk.chamferD, 'mm', (v) => {
        const x = evaluate(v, a.result?.vars || {});
        if (x > 0) { if (fillet) sk.filletR = x; else sk.chamferD = x; }
      }, { min: 0 })));
      g.appendChild(el('div', { class: 'pm-hint' }, fillet
        ? 'Click corners where two lines, a line and an arc, or two arcs meet. The first fillet gets tangent relations and a radius dimension; the next ones are made <b>equal</b> to it (Equal) until you leave the tool, so one dimension sizes them all.'
        : 'Click corners where two lines meet. The first chamfer is dimensioned from the original corner (kept as a point); the next ones are made <b>equal</b> to it (Equal Distance) until you leave the tool.'));
    }

    // the selected text / gear train
    const txt = [...sk.sel].map((id) => sk.textById(id)).find(Boolean);
    if (txt) this.renderTextPM(root, sk, txt);
    const train = sk.selectedTrain();
    if (train) this.renderGearPM(root, sk, train);
    const foil = sk.selectedAirfoil();
    if (foil) this.renderAirfoilPM(root, sk, foil);

    if (sk.tool === 'cspline') {
      // the degree it is drawn with (lower when it has fewer control points; changed afterwards in its own panel)
      const g = this.pmGroup(root, 'Control-Point Spline', 'sk:cspline');
      const sel = el('select');
      for (let d = 1; d <= SM.CTRL_MAX_DEGREE; d++) sel.appendChild(el('option', { value: String(d), ...(d === sk.splineDegree ? { selected: '' } : {}) }, d === 1 ? '1 (straight)' : d === 2 ? '2 (quadratic)' : d === 3 ? '3 (cubic)' : String(d)));
      sel.onchange = () => { sk.splineDegree = +sel.value; sk.redraw(); };
      g.appendChild(this.row('Degree', sel));
      g.appendChild(el('div', { class: 'pm-hint' }, `Click the control points; double-click or Enter ends it, clicking the first point closes it. It is drawn with this degree, or one less than its control points when it has fewer (a degree ${sk.splineDegree} spline needs ${sk.splineDegree + 1}).`));
    }

    if (sk.tool === 'polygon') {
      const g = this.pmGroup(root, 'Polygon', 'sk:poly');
      const inp = el('input', { type: 'number', min: 3, max: 40, value: sk.polySides });
      inp.oninput = () => { const n = Math.round(+inp.value); if (n >= 3 && n <= 40) sk.polySides = n; };
      const w = el('div', { class: 'pm-input' }); w.appendChild(inp);
      g.appendChild(this.row('Sides', w));
    }

    const generated = SM.patternEntities(f);
    if ([...sk.sel].some((id) => generated.has(id))) root.appendChild(el('div', { class: 'pm-hint' }, 'Linked pattern copies: edit the original geometry or choose Edit Pattern above.'));
    const items = sk.selectedItems().filter((i) => i.kind !== 'text' && i.kind !== 'gear' && i.kind !== 'airfoil' && !generated.has(i.id) && i.k?.type !== 'sketchPattern'); // they have their own groups above
    if (items.length) {
      const selG = this.pmGroup(root, `Selected Entities (${items.length})`, 'sk:sel');
      const ul = el('div', { class: 'pm-list' });
      for (const it of items) {
        const ic = it.kind === 'relation' ? `<span class="g">${esc(RELATION_INFO[it.k.type]?.glyph || '?')}</span>` : it.kind === 'dim' ? icon('smartdim') : icon(CURVE_ICON[it.kind] || 'point');
        const name = it.kind === 'relation' ? RELATION_INFO[it.k.type]?.label : SM.itemName(f, it.id);
        const li = el('div', { class: 'li sel' }, `${ic}<span>${esc(name)}</span><span class="x" title="Remove from selection">✕</span>`);
        li.querySelector('.x').onclick = () => { sk.sel.delete(it.id); sk.redraw(); this.renderPM(); this.refreshCommandStates(); };
        ul.appendChild(li);
      }
      selG.appendChild(ul);

      const rels = sk.applicableRelations();
      if (rels.length) {
        const g = this.pmGroup(root, 'Add Relations', 'sk:add');
        const grid = el('div', { class: 'pm-rels' });
        for (const r of rels) {
          const label = sk.relationLabel(r);
          const b = el('button', { title: label }, `<span class="g">${esc(RELATION_INFO[r].glyph)}</span>${esc(label.replace(' (on curve)', ''))}`);
          if (r === 'equalLength') b.style.gridColumn = '1 / -1';
          b.onclick = () => sk.addRelation(r);
          grid.appendChild(b);
        }
        g.appendChild(grid);
      } else if (items.some((i) => i.kind !== 'relation' && i.kind !== 'dim')) {
        const g = this.pmGroup(root, 'Add Relations', 'sk:add');
        g.appendChild(el('div', { class: 'pm-hint' }, 'No relations apply to this combination. Ctrl+click to select more entities (e.g. two lines, a point and a line, or two points and a centerline for Symmetric).'));
      }

      const existing = sk.relationsForSelection();
      if (existing.length) {
        const g = this.pmGroup(root, `Existing Relations (${existing.length})`, 'sk:exist');
        const ul2 = el('div', { class: 'pm-list' });
        for (const k of existing) {
          const label = k.type === 'dim' ? `Dimension ${SM.itemName(f, k.id)} (${k.kind})` : `${sk.relationLabel(k)}: ${k.refs.map((r) => SM.itemName(f, r)).join(', ')}`;
          const glyph = k.type === 'dim' ? '↔' : RELATION_INFO[k.type]?.glyph || '?';
          const li = el('div', { class: 'li' + (sk.sel.has(k.id) ? ' sel' : '') }, `<span class="g">${esc(glyph)}</span><span>${esc(label)}</span><span class="x" title="Delete">✕</span>`);
          li.onpointerenter = () => { sk.relHover = new Set(k.refs); sk.redraw(); };
          li.onpointerleave = () => { sk.relHover = null; sk.redraw(); };
          li.querySelector('.x').onclick = (e) => { e.stopPropagation(); sk.relHover = null; sk.deleteConstraint(k.id); };
          ul2.appendChild(li);
        }
        g.appendChild(ul2);
      }

      // parameters for a single selection
      if (items.length === 1 && items[0].kind !== 'relation' && !(items[0].kind === 'point' && items[0].id === 'O')) {
        const it = items[0];
        const g = this.pmGroup(root, 'Parameters', 'sk:params');
        const ro = (label, value, unit = 'mm') => {
          const w = el('div', { class: 'pm-input' });
          const i = el('input', { type: 'text', value: fmt(value, 3), disabled: true });
          w.append(i, el('span', { class: 'unit' }, unit));
          g.appendChild(this.row(label, w));
        };
        if (it.kind === 'point') {
          const p = SM.getPoint(f, it.id);
          const mk = (axis) => {
            const w = el('div', { class: 'pm-input' });
            const i = el('input', { type: 'text', value: fmt(p[axis], 4) });
            i.onchange = () => {
              const v = parseFloat(i.value);
              if (!Number.isFinite(v)) return;
              sk.movePoint(it.id, axis === 'x' ? v : p.x, axis === 'y' ? v : p.y);
              this.renderPM();
            };
            w.append(i, el('span', { class: 'unit' }, 'mm'));
            g.appendChild(this.row(axis.toUpperCase(), w));
          };
          mk('x'); mk('y');
          // a control point of a control-point spline: its weight, a control point added after it, or taken out
          for (const c of f.curves.filter((x) => x.type === 'spline' && x.ctrl && x.pts.includes(it.id))) {
            const i = c.pts.indexOf(it.id);
            const cg = this.pmGroup(root, `Control Point ${i + 1} of ${SM.itemName(f, c.id)}`, 'sk:ctrlpt:' + c.id);
            const w = el('div', { class: 'pm-input' });
            const inp = el('input', { type: 'text', value: fmt(c.weights?.[i] ?? 1, 4) });
            inp.onchange = () => {
              const v = parseFloat(inp.value);
              if (!(v > 0) || !Number.isFinite(v)) { inp.value = fmt(c.weights?.[i] ?? 1, 4); this.app.toast('A weight must be a number above 0'); return; }
              c.weights = c.weights || c.pts.map(() => 1);
              c.weights[i] = v;
              SM.syncCtrlPolygon(f, c);
              sk.changed();
            };
            w.appendChild(inp);
            cg.appendChild(this.row('Weight', w));
            const bar = el('div', { class: 'pm-btns' });
            const ins = el('button', { class: 'pm-btn', title: 'A new control point half way along the leg after this one (the curve changes shape a little)' }, 'Insert After');
            ins.onclick = () => { const id = SM.insertCtrlPoint(f, c, i); sk.sel.clear(); sk.sel.add(id); sk.changed(); this.renderPM(); };
            const rem = el('button', { class: 'pm-btn', title: 'Take this control point out of the spline; its two legs are joined' }, 'Remove');
            rem.disabled = c.pts.length - 1 < SM.ctrlMin(c);
            rem.onclick = () => { if (SM.removeCtrlPoint(f, c, it.id)) { sk.sel.clear(); sk.changed(); this.renderPM(); } };
            bar.append(ins, rem);
            cg.appendChild(bar);
            cg.appendChild(el('div', { class: 'pm-hint' }, 'A larger weight pulls the curve closer to this control point, a smaller one lets it go farther (1 is plain). With three control points at the corners of a square, degree 2 and weight 0.7071 (½√2) on the middle one, the curve is a quarter circle (to within 0.00001 mm).'));
          }
        } else if (it.kind === 'line') {
          const A = SM.getPoint(f, it.c.p1), B = SM.getPoint(f, it.c.p2);
          ro('Length', Math.hypot(B.x - A.x, B.y - A.y));
          ro('Angle', (Math.atan2(B.y - A.y, B.x - A.x) * 180) / Math.PI, '°');
        } else if (it.kind === 'spline') {
          const q = SM.curvePoints(f, it.c);
          ro(it.c.ctrl ? 'Control points' : 'Points', it.c.pts.length, '');
          ro('Length', q.reduce((acc, p2, i) => (i ? acc + Math.hypot(p2[0] - q[i - 1][0], p2[1] - q[i - 1][1]) : 0), 0));
          if (it.c.ctrl) {
            // the degree: 1 (straight between the control points) to 5, at most one less than the control points
            const top = SM.ctrlMaxDegree(it.c);
            const sel = el('select');
            for (let d = 1; d <= top; d++) sel.appendChild(el('option', { value: String(d), ...(d === (it.c.degree ?? 3) ? { selected: '' } : {}) }, d === 1 ? '1 (straight)' : d === 2 ? '2 (quadratic)' : d === 3 ? '3 (cubic)' : String(d)));
            sel.onchange = () => { it.c.degree = +sel.value; sk.changed(); };
            g.appendChild(this.row('Degree', sel));
            // closed: periodic, round smoothly with no join (at least three control points)
            const cb = el('input', { type: 'checkbox', ...(it.c.closed ? { checked: '' } : {}) });
            cb.disabled = !it.c.closed && it.c.pts.length < 3;
            cb.onchange = () => { it.c.closed = cb.checked; SM.syncCtrlPolygon(f, it.c); sk.changed(); this.renderPM(); };
            const lab = el('label', { title: 'Closed: the curve runs round smoothly, with no join, near its control points (the polygon closes too). Open: it starts and ends on the first and last control points.' });
            lab.append(cb, document.createTextNode(' Closed'));
            g.appendChild(this.row(null, lab, 'check'));
            if (it.c.weights) ro('Weighted control points', it.c.weights.filter((w) => w !== 1).length, '');
            g.appendChild(el('div', { class: 'pm-hint' }, `Drag the control points to reshape it. The dashed control polygon is made of construction lines: dimension it and give it relations like any lines (horizontal, parallel, equal, an angle…).${it.c.closed ? '' : ' The spline leaves each end along the polygon\'s end leg, so a relation on that leg (tangent, collinear) sets its direction there.'} A higher degree makes it smoother and farther from the polygon. Select a control point to set its weight, insert a control point after it or remove it.`));
          } else {
            if (it.c.closed) g.appendChild(el('div', { class: 'pm-hint' }, 'A closed spline (it runs back to its first point).'));
            const conv = el('button', { class: 'pm-btn', title: 'Make it a control-point spline (cubic) that runs through the same points; its control polygon can then be dimensioned and constrained' }, 'Convert to Control-Point Spline');
            conv.onclick = () => { SM.convertToCtrlSpline(f, it.c); sk.changed(); this.renderPM(); };
            const bar = el('div', { class: 'pm-btns' });
            bar.appendChild(conv);
            g.appendChild(bar);
            g.appendChild(el('div', { class: 'pm-hint' }, it.c.handles ? 'Drag a fit point to move it with its tangent handle. Drag a handle to change tangent direction and strength. The dashed handle lines accept length, angle, parallel and other line constraints.' : 'Drag the points it runs through to reshape it; drag the curve to move it. Convert it, or draw a Control-Point Spline, for control points, weights and a degree to choose.'));
          }
        } else if (it.kind === 'ellipse' || it.kind === 'earc') {
          const eg = SM.ellipseGeom(f, it.c);
          ro('Major radius', eg.ra); ro('Minor radius', eg.rb);
          ro('Angle', (Math.atan2(eg.u[1], eg.u[0]) * 180) / Math.PI, '°');
          ro('Center X', eg.cx); ro('Center Y', eg.cy);
        } else if (it.kind === 'circle' || it.kind === 'arc') {
          ro('Radius', SM.radiusOf(f, it.c));
          const C = SM.getPoint(f, it.c.c);
          ro('Center X', C.x); ro('Center Y', C.y);
        } else if (it.kind === 'dim') {
          if (it.k.driven) g.appendChild(el('div', { class: 'pm-hint' }, 'Driven (reference) dimension — it shows a value but does not control geometry.'));
          else {
            const inp = this.exprInput(it.k.value, it.k.kind === 'angle' ? '°' : 'mm', (v) => {
              const old = it.k.value;
              it.k.value = v;
              if (!sk.solve().ok) { it.k.value = old; sk.solve(); }
              sk.redraw();
            });
            inp.querySelector('input').addEventListener('change', () => sk.changed(false));
            g.appendChild(this.row('Value', inp));
          }
        }
      }
      if (items.some((i) => i.c)) {
        const g = this.pmGroup(root, 'Options', 'sk:copts');
        const cb = el('input', { type: 'checkbox' });
        cb.checked = items.filter((i) => i.c).every((i) => i.c.construction);
        cb.onchange = () => sk.toggleConstruction();
        const lab = el('label');
        lab.append(cb, document.createTextNode('For construction'));
        g.appendChild(this.row(null, lab, 'check'));
      }
      const act = el('div', { style: 'padding:0 8px 8px' });
      act.appendChild(el('button', { class: 'pm-btn', onclick: () => sk.deleteSelected() }, 'Delete selected'));
      root.appendChild(act);
    } else {
      const g = this.pmGroup(root, 'Sketch', 'sk:info');
      g.appendChild(el('div', {}, `Plane: <b>${esc(planeName(a.doc, f.plane.ref))}</b>`));
      g.appendChild(el('div', { class: 'pm-hint' }, `${f.curves.filter((c) => !c.construction).length} curves, ${f.constraints.filter((k) => k.type !== 'dim').length} relations, ${f.constraints.filter((k) => k.type === 'dim').length} dimensions`));
      if (sk.tool === 'select') g.appendChild(el('div', { class: 'pm-hint' }, `Select entities to add relations (Ctrl+click for several). Blue geometry is under defined; ${isDark() ? 'white' : 'black'} is fully defined. Centerlines only need to be positioned.`));
      const og = this.pmGroup(root, 'Orientation', 'sk:orient');
      const row = el('div', { style: 'display:flex;gap:6px' });
      row.appendChild(el('button', { class: 'pm-btn', style: 'flex:1', title: 'Turn the sketch axes 90° counter-clockwise', onclick: () => sk.rotateAxes(1) }, '⟲ Rotate 90°'));
      row.appendChild(el('button', { class: 'pm-btn', style: 'flex:1', title: 'Turn the sketch axes 90° clockwise', onclick: () => sk.rotateAxes(-1) }, '⟳ Rotate 90°'));
      og.appendChild(row);
      og.appendChild(el('div', { class: 'pm-hint' }, `Turns which way is horizontal and vertical in this sketch about its normal (now ${f.plane?.rot || 0}°). The geometry stays where it is.`));
      og.appendChild(el('button', { class: 'pm-btn', style: 'width:100%;margin-top:6px', title: 'Look at the sketch from the other side of its plane', onclick: () => { sk.flipSide(); this.renderPM(); } }, '⇅ Flip Side'));
      og.appendChild(el('div', { class: 'pm-hint' }, `Seen from the ${f.plane?.viewFlip ? 'back' : 'front'} of the plane. The sketch always opens this way; flipping only changes the view, not the sketch or the model.`));
    }

    const opts = this.pmGroup(root, 'Display', 'sk:opts');
    const check = (label, value, fn) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = value;
      cb.onchange = fn;
      const lab = el('label');
      lab.append(cb, document.createTextNode(label));
      opts.appendChild(this.row(null, lab, 'check'));
    };
    check('Show dimensions', sk.dimsVisible, () => sk.toggleDims());
    check('Show relations', sk.relsVisible, () => sk.toggleRelations());
    check('Automatic relations while sketching', sk.autoRelations, () => { sk.autoRelations = !sk.autoRelations; });
    opts.appendChild(el('div', { class: 'pm-hint' }, 'Keys: <span class="kbd">L</span> line · <span class="kbd">R</span> rectangle · <span class="kbd">C</span> circle · <span class="kbd">A</span> arc · <span class="kbd">N</span> spline · <span class="kbd">P</span> polygon · <span class="kbd">D</span> dimension · <span class="kbd">T</span> trim · <span class="kbd">Q</span> construction · <span class="kbd">S</span> select · <span class="kbd">Del</span> delete · <span class="kbd">Esc</span> cancel'));
  }

  // Gear train: module, pressure angle, teeth / ratios, tolerances for printing, bore.
  renderGearPM(root, sk, tr) {
    const a = this.app, f = sk.f, vars = a.result?.vars || {};
    // every change goes through the sketcher, which refuses one that would break a working train
    const apply = (mutate, rerender = false) => { if (!sk.editTrain(tr, mutate) || rerender) this.renderPM(); };
    const num = (v) => evaluate(v, vars);
    const letter = (f.gearTrains || []).length > 1 ? ' ' + String.fromCharCode(65 + (f.gearTrains.indexOf(tr) % 26)) : ''; // as on the gear labels
    const g = this.pmGroup(root, `Gear Train${letter} (${tr.centers.length} gear${tr.centers.length === 1 ? '' : 's'})`, 'sk:gear');
    const probs = SM.trainProblems(f, tr);
    if (probs.length) {
      const box = el('div', { class: 'pm-msg err' });
      box.innerHTML = `<b>These gears don't work</b> — they can't be extruded until this is fixed:<br>${probs.map((p) => '• ' + esc(p)).join('<br>')}`;
      g.appendChild(box);
      g.appendChild(el('button', { class: 'pm-btn', style: 'margin:4px 0 6px', onclick: () => { if (sk.fitTrain(tr)) this.renderPM(); } }, 'Fit gears to the lines'));
    }
    g.appendChild(this.row('Module', this.exprInput(tr.module, 'mm', (v) => { const x = num(v); if (x > 0) apply(() => { tr.module = x; }); }, { min: 0 })));
    g.appendChild(el('div', { class: 'pm-hint' }, 'Module = pitch diameter ÷ teeth (gears that mesh share it). Larger module = bigger, stronger teeth.'));
    g.appendChild(this.row('Pressure angle', this.exprInput(tr.pa, '°', (v) => { const x = num(v); if (x > 5 && x < 35) apply(() => { tr.pa = x; }); })));
    const gears = SM.trainGears(f, tr);
    const tg = this.pmGroup(root, 'Teeth and Ratios', 'sk:gearz');
    gears.forEach((gr) => {
      const pd = (tr.module * gr.z).toFixed(2);
      tg.appendChild(this.row(`Gear ${gr.i + 1} teeth`, this.exprInput(gr.z, `Ø${pd}`, (v) => { const x = Math.round(num(v)); if (x >= SM.GEAR_MIN_TEETH && x <= 400) apply(() => { tr.teeth[gr.i] = x; }); }, { min: 6 })));
    });
    for (const mm of SM.trainMeshes(f, tr)) {
      const zi = tr.teeth[mm.i], zj = tr.teeth[mm.j];
      const inp = this.exprInput(+(zj / zi).toFixed(4), ':1', (v) => { const x = num(v); if (x > 0) apply(() => { tr.teeth[mm.j] = Math.max(SM.GEAR_MIN_TEETH, Math.round(zi * x)); }); }, { min: 0 });
      inp.querySelector('input').addEventListener('change', () => this.renderPM());
      tg.appendChild(this.row(`Ratio ${mm.i + 1} → ${mm.j + 1}`, inp));
      const ok = Math.abs(mm.need - mm.have) < 1e-3;
      tg.appendChild(el('div', { class: 'pm-hint', style: ok ? '' : 'color:#c62828' }, ok ? `✔ meshes — centre distance ${mm.need.toFixed(3)} mm` : `✗ the line is ${mm.have.toFixed(3)} mm; these gears need ${mm.need.toFixed(3)} mm`));
    }
    if (tr.fit !== false) tg.appendChild(el('div', { class: 'pm-hint' }, 'Set the teeth or the ratio you want: the centre lines (and your dimensions on them) change length to suit.'));
    const pg = this.pmGroup(root, 'Fit (3D printing / tolerances)', 'sk:gearfit');
    pg.appendChild(this.row('Backlash', this.exprInput(tr.backlash, 'mm', (v) => { const x = num(v); if (x >= 0) apply(() => { tr.backlash = x; }); }, { min: 0 })));
    pg.appendChild(this.row('Tip / root clearance', this.exprInput(tr.clearance, 'mm', (v) => { const x = num(v); if (x >= 0) apply(() => { tr.clearance = x; }); }, { min: 0 })));
    pg.appendChild(el('div', { class: 'pm-hint' }, 'Backlash thins the teeth (play between meshing teeth). Clearance shortens the tips and deepens the roots. For FDM printing try 0.1–0.3 mm of each.'));
    const og = this.pmGroup(root, 'Options', 'sk:gearopt');
    og.appendChild(this.row('Bore diameter', this.exprInput(tr.bore, 'mm', (v) => { const x = num(v); if (x >= 0) apply(() => { tr.bore = x; }); }, { min: 0 })));
    og.appendChild(this.row('Turn first gear', this.exprInput(tr.phase0 || 0, '°', (v) => { const x = num(v); apply(() => { tr.phase0 = x; }); })));
    const cb = el('input', { type: 'checkbox' });
    cb.checked = tr.fit !== false;
    cb.onchange = () => apply(() => { tr.fit = cb.checked; }, true);
    const lab = el('label'); lab.append(cb, document.createTextNode(' Set the line lengths to the mesh distance (driving dimensions)'));
    og.appendChild(this.row(null, lab, 'check'));
    og.appendChild(el('button', { class: 'pm-btn', style: 'margin-top:6px', onclick: () => { sk.deleteTrain(tr); sk.sel.clear(); sk.changed(); } }, 'Delete gear train'));
    g.appendChild(el('div', { class: 'pm-hint' }, 'The teeth are turned so neighbouring gears mesh. Extrude the sketch to make the gears (each becomes its own body).'));
  }

  // Airfoil on a chord line: a NACA or Clark Y section from the library, or NACA parameters of your own.
  renderAirfoilPM(root, sk, af) {
    const a = this.app, f = sk.f, vars = a.result?.vars || {};
    const num = (v) => evaluate(v, vars);
    const set = (mutate, rerender = true) => { sk.editAirfoil(af, mutate); if (rerender) this.renderPM(); };
    const same = (x, y) => JSON.stringify(Object.entries(x).sort()) === JSON.stringify(Object.entries(y).sort());
    const g = this.pmGroup(root, `Airfoil — ${SM.airfoilName(af.spec)}`, 'sk:airfoil');
    const why = SM.airfoilProblem(f, af);
    if (why) g.appendChild(el('div', { class: 'pm-msg err' }, `This airfoil can't be drawn: ${esc(why)}.`));
    // the library (grouped), or Custom
    const lib = el('select');
    const groups = new Map();
    SM.AIRFOIL_LIBRARY.forEach((it, i) => {
      if (!groups.has(it.group)) { const og = el('optgroup', { label: it.group }); groups.set(it.group, og); lib.appendChild(og); }
      const o = el('option', { value: String(i) }, esc(SM.airfoilName(it.spec)));
      if (same(it.spec, af.spec)) o.selected = true;
      groups.get(it.group).appendChild(o);
    });
    const custom = el('option', { value: 'custom' }, 'Custom (parameters below)');
    if (!SM.AIRFOIL_LIBRARY.some((it) => same(it.spec, af.spec))) custom.selected = true;
    lib.appendChild(custom);
    lib.onchange = () => { if (lib.value !== 'custom') set((x) => { x.spec = { ...SM.AIRFOIL_LIBRARY[+lib.value].spec }; }); };
    const lw = el('div', { class: 'pm-input' }); lw.appendChild(lib);
    g.appendChild(this.row('Airfoil', lw));
    // a NACA designation typed in
    const code = el('input', { type: 'text', placeholder: 'e.g. 4415 or 23012', spellcheck: 'false' });
    code.value = /^NACA \d{4,5}$/.test(SM.airfoilName(af.spec)) ? SM.airfoilName(af.spec).slice(5) : '';
    code.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') code.blur(); };
    code.onchange = () => {
      const spec = SM.parseNaca(code.value);
      if (!spec) { a.toast('Type a NACA 4-digit (e.g. 2412) or 5-digit (e.g. 23012) designation', true); return; }
      const bad = SM.airfoilSpecProblem(spec);
      if (bad) { a.toast(`NACA ${code.value}: ${bad}`, true); return; }
      set((x) => { x.spec = spec; });
    };
    const cw = el('div', { class: 'pm-input' }); cw.appendChild(code);
    g.appendChild(this.row('NACA code', cw));

    // your own: the series and its parameters (NACA convention)
    const pg = this.pmGroup(root, 'Shape Parameters', 'sk:airfoilp');
    const series = el('select');
    for (const [k, label] of [['naca4', 'NACA 4-digit'], ['naca5', 'NACA 5-digit'], ['clarky', 'Clark Y']]) {
      const o = el('option', { value: k }, label);
      if (af.spec.kind === k) o.selected = true;
      series.appendChild(o);
    }
    series.onchange = () => set((x) => { x.spec = series.value === 'naca4' ? SM.parseNaca('2412') : series.value === 'naca5' ? SM.parseNaca('23012') : { kind: 'clarky', t: 11.7 }; });
    const sw = el('div', { class: 'pm-input' }); sw.appendChild(series);
    pg.appendChild(this.row('Series', sw));
    // (a value that would make an impossible shape is not taken: the field says why)
    const field = (label, key, unit, ok) => this.exprInput(af.spec[key], unit, (v) => {
      const x = num(v), spec = { ...af.spec, [key]: x };
      const bad = SM.airfoilSpecProblem(spec);
      if (!(ok?.(x) ?? true) || bad) { a.status(`Not changed — ${bad || 'out of range'}`); return; }
      set((y) => { y.spec = spec; }, false);
      // (the panel is not redrawn while typing: just its title)
      const h = g.parentElement?.querySelector('.pm-gt');
      if (h) h.lastChild.textContent = `Airfoil — ${SM.airfoilName(spec)}`;
    }, { min: 0 });
    const spec = af.spec;
    if (spec.kind === 'naca4') {
      pg.appendChild(this.row('Max camber', field('Max camber', 'm', '% chord')));
      pg.appendChild(this.row('Camber position', field('Camber position', 'p', '% chord')));
      pg.appendChild(this.row('Thickness', field('Thickness', 't', '% chord')));
      pg.appendChild(el('div', { class: 'pm-hint' }, 'NACA 4-digit MPXX: M = max camber (% chord), P = its position (tenths of the chord), XX = thickness (% chord). 0 camber = symmetric. Decimals are allowed here.'));
    } else if (spec.kind === 'naca5') {
      pg.appendChild(this.row('Design lift coeff.', field('Design lift coefficient', 'cl', 'CL')));
      pg.appendChild(this.row('Camber position', field('Camber position', 'p', '% chord')));
      pg.appendChild(this.row('Thickness', field('Thickness', 't', '% chord')));
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!spec.reflex;
      cb.onchange = () => {
        const next = { ...af.spec, reflex: cb.checked };
        if (cb.checked && next.p < 10) next.p = 10;
        set((y) => { y.spec = next; });
      };
      const lab = el('label'); lab.append(cb, document.createTextNode(' Reflexed camber line (third digit 1)'));
      pg.appendChild(this.row(null, lab, 'check'));
      pg.appendChild(el('div', { class: 'pm-hint' }, 'NACA 5-digit LPQXX: L × 0.15 = design lift coefficient, P × 5 = max camber position (% chord, 5–25), Q = 1 for a reflexed camber line, XX = thickness (% chord).'));
    } else {
      pg.appendChild(this.row('Thickness', field('Thickness', 't', '% chord')));
      pg.appendChild(el('div', { class: 'pm-hint' }, 'Clark Y: flat-bottomed section, 11.7 % thick as drawn by Clark; other thicknesses scale it about its mean line. The chord runs from the nose to the trailing edge.'));
    }

    // the chord (the line: dimension it, or set it here) and how the airfoil sits on it
    const og = this.pmGroup(root, 'Chord and Options', 'sk:airfoilo');
    const c = SM.getCurve(f, af.line);
    const len = c ? Math.hypot(SM.getPoint(f, c.p2).x - SM.getPoint(f, c.p1).x, SM.getPoint(f, c.p2).y - SM.getPoint(f, c.p1).y) : 0;
    og.appendChild(this.row('Chord length', this.exprInput(+len.toFixed(4), 'mm', (v) => {
      const x = num(v);
      if (x > 0 && Math.abs(x - len) > 1e-9) { if (!sk.setChord(af, x)) a.toast('The chord line\'s length is fixed by other relations or dimensions', true); this.renderPM(); }
    }, { min: 0 })));
    for (const [key, label, def] of [['sharpTE', 'Sharp (closed) trailing edge', true], ['flip', 'Camber to the other side of the line', false], ['swap', 'Leading edge at the other end of the line', false]]) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = af[key] ?? def;
      cb.onchange = () => set((x) => { x[key] = cb.checked; });
      const lab = el('label'); lab.append(cb, document.createTextNode(' ' + label));
      og.appendChild(this.row(null, lab, 'check'));
    }
    og.appendChild(el('div', { class: 'pm-hint' }, 'The airfoil follows its chord line: drag the line\'s ends, or dimension it, and the airfoil scales with it. Extrude the sketch to make a wing section.'));
    og.appendChild(el('button', { class: 'pm-btn', style: 'margin-top:6px', onclick: () => { sk.deleteAirfoil(af); sk.sel.clear(); sk.changed(); } }, 'Delete airfoil'));
  }

  renderTextPM(root, sk, t) {
    const a = this.app;
    const g = this.pmGroup(root, 'Text', 'sk:text');
    const changed = () => sk.changed(false);
    const ta = el('textarea', { class: 'text-input', rows: 2, spellcheck: 'false' });
    ta.value = t.text;
    ta.oninput = () => { t.text = ta.value; changed(); };
    ta.onkeydown = (e) => e.stopPropagation();
    const tw = el('div', { class: 'pm-input' }); tw.appendChild(ta);
    g.appendChild(this.row('Text', tw));
    const fs = el('select');
    const fill = (fams) => { fs.innerHTML = ''; for (const fam of fams.length ? fams : ['Arial']) { const o = el('option', { value: fam }, esc(fam)); if (fam === t.font) o.selected = true; fs.appendChild(o); } };
    fill([t.font || 'Arial']);
    a.fontFamilies().then((fams) => fill(fams.includes(t.font) ? fams : [t.font, ...fams]));
    fs.onchange = () => { t.font = fs.value; changed(); };
    const fw = el('div', { class: 'pm-input' }); fw.appendChild(fs);
    g.appendChild(this.row('Font', fw));
    g.appendChild(this.row('Height', this.exprInput(t.h, 'mm', (v) => { const x = evaluate(v, a.result?.vars || {}); if (x > 0) { t.h = x; changed(); } }, { min: 0 })));
    g.appendChild(this.row('Angle', this.exprInput(t.angle || 0, '°', (v) => { t.angle = evaluate(v, a.result?.vars || {}); changed(); })));
    const style = el('div', { style: 'display:flex;gap:14px' });
    for (const [key, label] of [['bold', 'Bold'], ['italic', 'Italic']]) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!t[key];
      cb.onchange = () => { t[key] = cb.checked; changed(); };
      const lab = el('label'); lab.append(cb, document.createTextNode(' ' + label));
      style.appendChild(lab);
    }
    g.appendChild(this.row(null, style, 'check'));
    g.appendChild(el('div', { class: 'pm-hint' }, 'Drag the text to move it. The height is the height of capital letters. Text inside a closed outline is cut out of it when extruded.'));
  }

  renderSelectPlanePM(root) {
    const a = this.app;
    const sk = a.pm.forSketch ? findFeature(a.doc, a.pm.forSketch) : null;
    this.pmHeader(root, sk ? 'plane' : 'sketch', sk ? 'Sketch Plane' : 'Edit Sketch', { ok: false });
    if (sk) {
      const err = a.result?.errors.get(sk.id);
      root.appendChild(el('div', { class: 'pm-msg' }, `Select the plane or flat face to put <b>${esc(sk.name)}</b> on. Its curves keep their sketch coordinates.`));
      if (err) root.appendChild(el('div', { class: 'pm-msg err' }, esc(err)));
    } else root.appendChild(el('div', { class: 'pm-msg' }, 'Select a plane or a flat face of the model on which to create a sketch.'));
    if (a.pendingFeature) root.appendChild(el('div', { class: 'pm-msg ok' }, `When you exit the sketch, ${esc(TYPE_INFO[a.pendingFeature.type]?.[a.pendingFeature.op === 'cut' ? 'cutBase' : 'base'] || 'the feature')} continues with it.`));
    const g = this.pmGroup(root, 'Planes', 'sp:planes');
    const opts = [...Object.keys(STD_PLANES).map((k) => [k, STD_PLANES[k].name, 'plane']), ...a.doc.features.filter((f) => f.type === 'plane' && !f.suppressed && (!sk || a.planeUsableFor(sk, f.id))).map((f) => [f.id, f.name, 'refplane'])];
    const cur = sk?.plane?.ref;
    const ul = el('div', { class: 'pm-list' });
    for (const [id, name, ic] of opts) {
      const li = el('div', { class: 'li' + (cur === id ? ' active' : '') }, `${icon(ic)}<span>${esc(name)}${cur === id ? ' (now)' : ''}</span>`);
      li.onclick = () => a.createSketchOn({ ref: id });
      li.onpointerenter = () => a.setHoverPlane(id);
      li.onpointerleave = () => a.setHoverPlane(null);
      ul.appendChild(li);
    }
    g.appendChild(ul);
  }

  renderSectionPM(root) {
    const a = this.app, s0 = a.pm.section;
    this.pmHeader(root, 'section', 'Section View');
    // Section 1, then Sections 2 and 3 (each used when ticked: only what all the planes cut away is gone, e.g. a
    // quarter cut); the arrow and a click in the view move the one last changed
    [s0, ...(s0.more || [])].forEach((s, i) => this.renderSectionGroup(root, s0, s, i));
  }
  renderSectionGroup(root, s0, s, i) {
    const a = this.app;
    const g = this.pmGroup(root, `Section ${i + 1}`, `sec:${i + 1}`);
    g.classList.add('sec-group');
    g.dataset.sec = String(i);
    // (a change here: this one gets the arrow)
    const touch = () => { if ((s0.active || 0) !== i) { s0.active = i; a.applySection(); } };
    g.addEventListener('pointerdown', touch, true);
    g.addEventListener('focusin', touch);
    if (i) {
      const use = el('input', { type: 'checkbox' });
      use.checked = !!s.on;
      use.onchange = () => { s.on = use.checked; s0.active = use.checked ? i : 0; a.applySection(); this.renderPM(); };
      const ul = el('label');
      ul.append(use, document.createTextNode(tr('Use this section too')));
      g.appendChild(this.row(null, ul, 'check'));
      if (!s.on) return;
    }
    if ((s0.active || 0) === i && (i === 0 || s.on)) g.appendChild(el('div', { class: 'pm-hint' }, tr('The arrow in the view moves this section.')));
    const sel = el('select');
    for (const [k, p] of Object.entries(STD_PLANES)) {
      const o = el('option', { value: k }, p.name);
      if (s.plane === k) o.selected = true;
      sel.appendChild(o);
    }
    // (the face or plane picked)
    if (s.custom) {
      const o = el('option', { value: 'custom' }, s.custom.name || 'Selected face');
      if (s.plane === 'custom') o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => { s.plane = sel.value; a.applySection(); this.renderPM(); };
    const wrap = el('div', { class: 'pm-input' });
    wrap.appendChild(sel);
    g.appendChild(this.row('Plane', wrap));
    g.appendChild(el('div', { class: 'pm-hint' }, tr('Or click a flat face or a plane in the view to cut from it.')));
    const offIn = this.exprInput(s.offset, 'mm', (v) => { s.offset = v; a.applySection(); });
    offIn.classList.add('sec-offset');
    g.appendChild(this.row('Offset', offIn));
    const [lo, hi] = a.sectionRange(s);
    const slider = el('input', { type: 'range', class: 'sec-slider', min: lo, max: hi, step: 0.5, value: evaluate(s.offset, a.result?.vars || {}) });
    slider.oninput = () => { s.offset = +slider.value; a.applySection(); const t = g.querySelector('.sec-offset input[type=text]'); if (t) t.value = slider.value; };
    g.appendChild(this.row('', slider));
    if (i === 0) g.appendChild(el('div', { class: 'pm-hint' }, tr('Or drag the arrow in the view.')));
    const cb = el('input', { type: 'checkbox' });
    cb.checked = s.flip;
    cb.onchange = () => { s.flip = cb.checked; a.applySection(); };
    const lab = el('label');
    lab.append(cb, document.createTextNode('Flip side to view'));
    g.appendChild(this.row(null, lab, 'check'));
  }

  // the section's offset shown while its arrow is dragged (without building the panel again)
  updateSectionOffset(v, k = 0) {
    const root = this.app.pm?.kind === 'section' ? document.querySelector(`#pm .sec-group[data-sec="${k}"]`) : null;
    if (!root) return;
    const i = root.querySelector('.sec-offset input[type=text]'), sl = root.querySelector('.sec-slider');
    if (i && document.activeElement !== i) i.value = String(this.app.units === 'in' ? +(v / 25.4).toFixed(4) : v);
    if (sl) sl.value = String(v);
  }

  // ------------------------------------------------------------ viewport chrome
  buildHUD() { this.renderHUD(); }

  renderHUD() {
    const a = this.app, hud = $('#hud');
    hud.innerHTML = '';
    const btn = (ic, title, action, { on = false, drop = false } = {}) => {
      const b = el('button', { class: (on ? 'on ' : '') + (drop ? 'drop' : ''), title }, icon(ic));
      b.addEventListener('click', (e) => action(e, b));
      hud.appendChild(b);
      return b;
    };
    const sep = () => hud.appendChild(el('div', { class: 'hsep' }));
    btn('zoomfit', 'Zoom to Fit (F)', () => a.viewport.zoomToFit());
    btn('normalTo', 'Normal To (Ctrl+8)', () => a.normalToSelection());
    sep();
    btn('views', 'View Orientation', (e, b) => {
      const r = b.getBoundingClientRect();
      this.showContext(r.left, r.bottom + 4, [['Front', 'front', '1'], ['Back', 'back', '2'], ['Left', 'left', '3'], ['Right', 'right', '4'], ['Top', 'top', '5'], ['Bottom', 'bottom', '6'], ['Isometric', 'iso', '7'], ['Trimetric', 'trimetric', '']]
        .map(([l, v, k]) => ({ label: l, icon: 'views', key: k ? 'Ctrl+' + k : '', action: () => a.viewport.setStandardView(v) })));
    }, { drop: true });
    btn('display', 'Display Style', (e, b) => {
      const r = b.getBoundingClientRect();
      this.showContext(r.left, r.bottom + 4, this.displayItems());
    }, { drop: true });
    // (a cut on, its panel closed: the panel opened again; its ✗ removes the cut)
    btn('section', 'Section View', () => (a.viewport.section && !a.pm ? a.reopenSection() : a.startSection()), { on: !!a.viewport.section });
    const vb = btn('eye', 'Visibility: planes, sketches, axes, points, surfaces', (e, b) => { const r = b.getBoundingClientRect(); this.showVisMenu(r.left, r.bottom + 4); }, { drop: true, on: Object.values(a.vis).some((x) => !x) || a.showPlanes });
    vb.classList.add('vis-btn');
    sep();
    // selection filter (keys: X faces, E edges, V vertices; F5 clears)
    for (const [k, ic, t] of [['face', 'filterFace', 'Filter Faces (X)'], ['edge', 'filterEdge', 'Filter Edges (E)'], ['vertex', 'filterVertex', 'Filter Vertices (V)'], ['body', 'filterBody', 'Filter Solid Bodies (B)'], ['plane', 'filterPlane', 'Filter Planes']])
      btn(ic, t + (a.filters.has(k) ? ' — on' : ''), () => a.toggleFilter(k), { on: a.filters.has(k) });
    const clr = btn('filterClear', 'Clear Selection Filters (F5)', () => a.toggleFilter('clear'));
    clr.disabled = !a.filters.size;
    sep();
    btn('undo', 'Undo (Ctrl+Z)', () => a.undo());
    btn('redo', 'Redo (Ctrl+Y)', () => a.redo());
  }

  // Visibility filter: tick what to show; it stays open while ticking.
  showVisMenu(x, y) {
    const a = this.app, cm = $('#ctxmenu');
    cm.innerHTML = '';
    const rows = [['stdPlanes', 'Standard planes (Front, Top, Right)', a.showPlanes], ['planes', 'Reference planes', a.vis.planes], ['sketches', 'Sketches', a.vis.sketches], ['axes', 'Axes', a.vis.axes], ['points', 'Points', a.vis.points], ['surfaces', 'Surface bodies', a.vis.surfaces]];
    cm.appendChild(el('div', { class: 'vis-h' }, 'Show in the view'));
    for (const [key, label, on] of rows) {
      const row = el('label', { class: 'mi vis-row' });
      const cb = el('input', { type: 'checkbox' });
      cb.checked = on;
      cb.onchange = () => a.setVisibility(key, cb.checked);
      row.append(cb, el('span', { class: 'mi-label' }, esc(label)));
      cm.appendChild(row);
    }
    cm.appendChild(el('div', { class: 'msep' }));
    const all = el('div', { class: 'vis-all' });
    all.appendChild(el('button', { class: 'pm-btn', onclick: () => { a.setVisibility('all', true); this.showVisMenu(x, y); } }, 'Select all'));
    all.appendChild(el('button', { class: 'pm-btn', onclick: () => { a.setVisibility('all', false); this.showVisMenu(x, y); } }, 'Deselect all'));
    cm.appendChild(all);
    cm.appendChild(el('div', { class: 'pm-hint', style: 'padding:4px 10px 6px' }, 'Hidden items still show while you use them (selected, edited or picked in a feature).'));
    cm.hidden = false;
    cm.style.left = Math.min(x, innerWidth - cm.offsetWidth - 4) + 'px';
    cm.style.top = Math.min(y, innerHeight - cm.offsetHeight - 4) + 'px';
  }

  // One tab per open part (in the title bar).
  renderTabs() {
    const a = this.app, bar = $('#doc-title');
    if (!bar) return;
    bar.innerHTML = '';
    bar.classList.add('doctabs');
    a.tabs.forEach((t, i) => {
      const cur = i === a.tabIndex;
      if (t.kind === 'drawing') {
        const d = t.drawing;
        const tab = el('div', { class: 'doctab' + (cur ? ' active' : ''), title: d.filePath || 'Not saved yet' }, `${icon(d.tabIcon || 'drawing')}<span>${esc(d.name)}${d.dirty ? ' *' : ''}</span>`);
        const x = el('button', { class: 'doctab-x', title: `Close this ${(d.kindLabel || 'drawing').toLowerCase()}` }, '✕');
        x.onclick = (e) => { e.stopPropagation(); a.closeTab(i); };
        tab.appendChild(x);
        tab.onclick = () => a.activateTab(i);
        tab.onauxclick = (e) => { if (e.button === 1) a.closeTab(i); };
        bar.appendChild(tab);
        return;
      }
      const doc = cur ? a.doc : t.doc;
      if (!doc) return;
      const dirty = cur ? a.dirty : t.dirty;
      const path = cur ? a.filePath : t.filePath;
      const label = path ? fileStem(path) : doc.name;
      const tab = el('div', { class: 'doctab' + (cur ? ' active' : ''), title: path || 'Not saved yet' }, `${icon('part')}<span>${esc(label)}${dirty ? ' *' : ''}</span>`);
      const x = el('button', { class: 'doctab-x', title: 'Close this part' }, '✕');
      x.onclick = (e) => { e.stopPropagation(); a.closeTab(i); };
      tab.appendChild(x);
      tab.onclick = () => a.activateTab(i);
      tab.onauxclick = (e) => { if (e.button === 1) a.closeTab(i); };
      bar.appendChild(tab);
    });
    const plus = el('button', { class: 'doctab-new', title: 'New part (Ctrl+N)' }, '+');
    plus.onclick = () => a.newDocument();
    bar.appendChild(plus);
  }

  renderMeasurePM(root) {
    const a = this.app, pm = a.pm;
    this.pmHeader(root, 'measure', 'Measure', { ok: false });
    root.appendChild(el('div', { class: 'pm-msg' }, 'Click up to two items: vertices, snap points, edges, faces, planes, sketch points or lines (turn on the body filter, B, to pick whole bodies). The point a click would pick is marked as you move. Click an item again to remove it.'));
    const sg = this.pmGroup(root, 'Snap To', 'ms:snap');
    for (const [k, label] of [['sketch', 'Sketch points'], ['mids', 'Midpoints of edges'], ['centres', 'Centres of circles and arcs']]) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = pm.snap[k] !== false;
      cb.onchange = () => { pm.snap[k] = cb.checked; };
      const lab = el('label', { class: 'pm-check' }); lab.append(cb, ` ${label}`);
      sg.appendChild(this.row(null, lab, 'check'));
    }
    {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!pm.keepFirst;
      cb.onchange = () => { pm.keepFirst = cb.checked; a._measureOpts.keepFirst = cb.checked; };
      const lab = el('label', { class: 'pm-check' }); lab.append(cb, ' Keep the first item (from it to each next click)');
      sg.appendChild(this.row(null, lab, 'check'));
    }
    const g = this.pmGroup(root, 'Selections', 'ms:sel');
    const ul = el('div', { class: 'pm-list' });
    if (!pm.picks.length) ul.appendChild(el('div', { class: 'li pm-hint' }, 'Nothing selected'));
    const ic = { vertex: 'point', edge: 'edge', face: 'plane', body: 'body', plane: 'plane', seg: 'line' };
    pm.picks.forEach((r, i) => {
      const li = el('div', { class: 'li sel' }, `${icon(ic[r.kind])}<span>${esc(r.label)}</span><span class="x" title="Remove">✕</span>`);
      li.querySelector('.x').onclick = () => { pm.picks.splice(i, 1); a.runMeasure(); };
      ul.appendChild(li);
    });
    g.appendChild(ul);
    if (pm.picks.length) g.appendChild(el('button', { class: 'pm-btn', onclick: () => { pm.picks.length = 0; a.runMeasure(); } }, 'Clear'));
    if (pm.error) root.appendChild(el('div', { class: 'pm-msg err' }, esc(pm.error)));
    // (the distances measured so far)
    if (pm.history.length > 1) {
      const hg = this.pmGroup(root, 'Measured', 'ms:hist');
      const ol = el('ol', { class: 'measure-history' });
      for (const h of pm.history) ol.appendChild(el('li', {}, `${esc(h.text)}: <b>${esc(lenWithUnit(h.distance, a.units, a.units === 'in' ? 4 : 3))}</b>`));
      hg.appendChild(ol);
    }
    const r = pm.result;
    if (!r) return;
    const res = this.pmGroup(root, 'Results', 'ms:res');
    const kv = el('div', { class: 'kv measure-kv' });
    const row = (k, v) => kv.insertAdjacentHTML('beforeend', `<div class="k">${esc(k)}</div><div>${v}</div>`);
    const U = a.units, mm = (x) => lenWithUnit(x, U, U === 'in' ? 4 : 3), at = (x) => fmtLen(x, U, U === 'in' ? 4 : 3);
    if (r.items.length === 1) {
      const it = r.items[0];
      if (it.type === 'point') { const q = W.toUser(it.p); row('Point', `X ${at(q[0])} · Y ${at(q[1])} · Z ${at(q[2])} ${U}`); }
      if (it.type === 'edge') { row('Length', `<b>${mm(it.length)}</b>`); if (it.radius) row(it.curve === 'circle' ? 'Diameter' : 'Radius', it.curve === 'circle' ? mm(2 * it.radius) : mm(it.radius)); }
      if (it.type === 'face') { row('Area', `<b>${areaWithUnit(it.area, U)}</b>`); if (it.radius) row('Diameter', mm(2 * it.radius)); }
      if (it.type === 'body') { if (it.volume != null) row('Volume', `<b>${volWithUnit(it.volume, U)}</b>`); row('Surface area', areaWithUnit(it.area, U)); }
      if (it.type === 'plane') row('Plane', 'Pick a second item to measure the distance');
    } else if (r.distance != null) {
      const d = W.toUser([0, 1, 2].map((k) => r.b[k] - r.a[k]));
      row('Distance', `<b>${mm(r.distance)}</b>`);
      row('ΔX', mm(Math.abs(d[0])));
      row('ΔY', mm(Math.abs(d[1])));
      row('ΔZ', mm(Math.abs(d[2])));
      if (r.centerDistance != null) row('Centre to centre', mm(r.centerDistance));
      if (r.angle != null) row('Angle', `${fmt(r.angle, 3)}°`);
      if (r.distance < 1e-9) kv.insertAdjacentHTML('beforeend', '<div class="k"></div><div class="pm-hint">The items touch or intersect.</div>');
    }
    res.appendChild(kv);
  }

  renderConfirmCorner() {
    const a = this.app, cc = $('#confirm-corner');
    cc.innerHTML = '';
    if (!a.pm) { cc.hidden = true; return; }
    cc.hidden = false;
    if (a.pm.kind === 'sketch') {
      cc.appendChild(el('button', { title: 'Exit Sketch (save)', onclick: () => a.exitSketch(true) }, icon('exitSketch')));
      cc.appendChild(el('button', { title: 'Discard changes and exit', onclick: () => a.exitSketch(false) }, icon('cancel')));
    } else {
      if (a.pm.kind !== 'selectPlane' && a.pm.kind !== 'measure') cc.appendChild(el('button', { title: 'OK', onclick: () => a.okPM() }, icon('ok')));
      cc.appendChild(el('button', { title: 'Cancel', onclick: () => a.cancelPM() }, icon('cancel')));
    }
  }

  // ------------------------------------------------------------ dialogs
  // Tolerance Stack-Up: the stack-ups kept in a part or an assembly (doc.stackups), edited in a table with the results
  // worked out as you type. commit: saves the change in that document.
  showStackUp(doc = this.app.doc, commit = () => this.app.commit()) {
    const list = (doc.stackups ||= []);
    if (!list.length) list.push({ name: 'Stack-Up 1', req: { min: '', max: '' }, rows: [{ name: 'A', nominal: 10, plus: 0.1, minus: 0.1, dir: 1 }] });
    let cur = list[0];
    const box = el('div', { class: 'dw-form', style: 'min-width:640px' });
    const num = (v) => { const n = this.app.result?.ev ? (() => { try { return this.app.result.ev(String(v)); } catch { return NaN; } })() : +v; return Number.isFinite(n) ? n : NaN; };
    const f4 = (x) => (Number.isFinite(x) ? fmt(x, 4) : '—');
    const render = () => {
      box.innerHTML = '';
      const top = el('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:6px' });
      const pick = el('select');
      list.forEach((s, i) => { const o = el('option', { value: i }, esc(s.name)); if (s === cur) o.selected = true; pick.appendChild(o); });
      pick.onchange = () => { cur = list[+pick.value]; render(); };
      const name = el('input', { type: 'text', style: 'width:140px' }); name.value = cur.name; name.onchange = () => { cur.name = name.value.trim() || cur.name; commit(); render(); };
      const add = el('button', {}, 'New stack-up'); add.onclick = () => { list.push((cur = { name: `Stack-Up ${list.length + 1}`, req: { min: '', max: '' }, rows: [] })); commit(); render(); };
      const del = el('button', {}, 'Delete'); del.onclick = () => { list.splice(list.indexOf(cur), 1); if (!list.length) list.push({ name: 'Stack-Up 1', req: { min: '', max: '' }, rows: [] }); cur = list[0]; commit(); render(); };
      top.append(pick, name, add, del);
      box.appendChild(top);
      const t = el('table', { class: 'bom-table', style: 'width:100%' });
      t.innerHTML = '<tr><th>Dimension</th><th>Nominal</th><th>+ Tol.</th><th>− Tol.</th><th>Sense</th><th>Share (RSS)</th><th></th></tr>';
      let res = null;
      try { res = stackUp(cur.rows.map((r) => ({ ...r, nominal: num(r.nominal), plus: num(r.plus), minus: num(r.minus) })), { min: cur.req?.min === '' ? '' : num(cur.req?.min), max: cur.req?.max === '' ? '' : num(cur.req?.max) }); } catch { res = null; }
      cur.rows.forEach((r, i) => {
        const tr = el('tr');
        const cell = (key, w) => { const inp = el('input', { type: 'text', style: `width:${w}px` }); inp.value = r[key]; inp.onchange = () => { r[key] = key === 'name' ? inp.value : inp.value.trim(); commit(); render(); }; const td = el('td'); td.appendChild(inp); return td; };
        const sense = el('select'); for (const [v, l] of [[1, '+ adds to the gap'], [-1, '− takes from it']]) { const o = el('option', { value: v }, l); if (+r.dir === v) o.selected = true; sense.appendChild(o); }
        sense.onchange = () => { r.dir = +sense.value; commit(); render(); };
        const sd = el('td'); sd.appendChild(sense);
        const share = el('td', {}, res ? `${(res.shares[i].share * 100).toFixed(1)} %` : '—');
        const x = el('button', { title: 'Remove' }, '✕'); x.onclick = () => { cur.rows.splice(i, 1); commit(); render(); };
        const xd = el('td'); xd.appendChild(x);
        tr.append(cell('name', 120), cell('nominal', 80), cell('plus', 60), cell('minus', 60), sd, share, xd);
        t.appendChild(tr);
      });
      box.appendChild(t);
      const addRow = el('button', { style: 'margin:6px 0' }, 'Add dimension');
      addRow.onclick = () => { cur.rows.push({ name: String.fromCharCode(65 + (cur.rows.length % 26)), nominal: 0, plus: 0.1, minus: 0.1, dir: 1 }); commit(); render(); };
      box.appendChild(addRow);
      const req = el('div', { style: 'display:flex;gap:8px;align-items:center;margin:4px 0' });
      const rq = (key, label) => { const inp = el('input', { type: 'text', style: 'width:70px' }); inp.value = cur.req?.[key] ?? ''; inp.onchange = () => { (cur.req ||= {})[key] = inp.value.trim(); commit(); render(); }; req.append(el('span', {}, label), inp); };
      rq('min', 'Gap required: at least'); rq('max', 'at most');
      box.appendChild(req);
      const out = el('div', { class: 'pm-hint', style: 'margin-top:6px;line-height:1.5' });
      out.innerHTML = res
        ? `Gap: nominal <b>${f4(res.nominal)}</b>, mean ${f4(res.mean)}<br>Worst case: ${f4(res.worst.min)} to ${f4(res.worst.max)} ${cur.req?.min !== '' || cur.req?.max !== '' ? (res.pass.worst ? '✔ within the requirement' : '✘ outside the requirement') : ''}<br>Statistical (RSS): ${f4(res.rss.min)} to ${f4(res.rss.max)} ${cur.req?.min !== '' || cur.req?.max !== '' ? (res.pass.rss ? '✔' : '✘') : ''}`
        : 'Give each dimension a nominal size (numbers or expressions).';
      box.appendChild(out);
      box.appendChild(el('div', { class: 'pm-hint', style: 'margin-top:4px' }, 'One direction: each dimension adds to or takes from the gap. Worst case adds up every tolerance; statistical (root sum of squares) is what most assemblies see when the parts vary independently. The share shows which tolerances matter most.'));
    };
    render();
    this.modal('Tolerance Stack-Up', 'measure', box, [{ label: 'Close', primary: true }]);
    return { box, render, get current() { return cur; } };
  }

  modal(title, ic, body, buttons) {
    const back = el('div', { class: 'modal-back' });
    const m = el('div', { class: 'modal' });
    const h = el('div', { class: 'modal-h' }, `${icon(ic)}<span>${esc(tr(title))}</span>`);
    const x = el('button', { class: 'x', title: 'Close' }, '✕');
    h.appendChild(x);
    const b = el('div', { class: 'modal-b' });
    if (typeof body === 'string') b.innerHTML = body; else b.appendChild(body);
    const f = el('div', { class: 'modal-f' });
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.target.closest?.('[data-own-escape]')) { e.stopPropagation(); close(); }
    };
    document.addEventListener('keydown', onKey, true);
    for (const btn of buttons) {
      const bb = el('button', { class: btn.primary ? 'primary' : '' }, esc(tr(btn.label)));
      bb.onclick = () => { if (btn.action?.() !== false) close(); };
      f.appendChild(bb);
    }
    x.onclick = close;
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
    m.append(h, b, f);
    back.appendChild(m);
    $('#modal-root').appendChild(back);
    return { close, body: b };
  }

  // A text input dialog; resolves with the text (null if cancelled).
  promptText(title, ic, label, value = '', multiline = false) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const box = el('div', { class: 'dw-form' });
      box.appendChild(el('div', { class: 'pm-hint', style: 'margin-bottom:6px' }, esc(label)));
      const input = el(multiline ? 'textarea' : 'input', multiline ? { rows: '4', style: 'width:100%;box-sizing:border-box;font:inherit' } : { type: 'text', style: 'width:100%;box-sizing:border-box' });
      input.value = value || '';
      box.appendChild(input);
      if (multiline) box.appendChild(el('div', { class: 'pm-hint', style: 'margin-top:4px' }, 'Enter adds a line; Ctrl+Enter is OK.'));
      const dlg = this.modal(title, ic, box, [{ label: 'OK', primary: true, action: () => finish(input.value) }, { label: 'Cancel', action: () => finish(null) }]);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (!multiline || e.ctrlKey)) { e.preventDefault(); finish(input.value); dlg.close(); }
      });
      const obs = new MutationObserver(() => { if (!document.contains(dlg.body)) { obs.disconnect(); finish(null); } });
      obs.observe(document.getElementById('modal-root'), { childList: true });
      setTimeout(() => { input.focus(); input.select?.(); }, 0);
    });
  }

  // A dialog of a few fields ({ key, label, value, type: 'text' | 'expr' | 'select' | 'check', options }); resolves
  // with { key: value } (strings, booleans for checks), or null if cancelled.
  promptFields(title, ic, fields, hint = '') {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const box = el('div', { class: 'dw-form' });
      if (hint) box.appendChild(el('div', { class: 'pm-hint', style: 'margin-bottom:6px' }, esc(hint)));
      const inputs = {};
      for (const f of fields) {
        const row = el('label', { style: 'display:flex;align-items:center;gap:8px;margin:4px 0' });
        let inp;
        if (f.type === 'select') {
          inp = el('select', { style: 'flex:1' });
          for (const [v, l] of f.options) { const o = el('option', { value: v }, esc(l)); if (String(v) === String(f.value)) o.selected = true; inp.appendChild(o); }
        } else if (f.type === 'check') { inp = el('input', { type: 'checkbox' }); inp.checked = !!f.value; }
        else { inp = el('input', { type: 'text', style: 'width:90px' }); inp.value = f.value ?? ''; }
        if (f.type === 'expr') this.completeExpression(inp);
        row.append(el('span', { style: 'flex:1' }, esc(f.label)), inp);
        box.appendChild(row);
        inputs[f.key] = inp;
      }
      const read = () => Object.fromEntries(fields.map((f) => [f.key, f.type === 'check' ? inputs[f.key].checked : inputs[f.key].value]));
      const dlg = this.modal(title, ic, box, [{ label: 'OK', primary: true, action: () => finish(read()) }, { label: 'Cancel', action: () => finish(null) }]);
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(read()); dlg.close(); } });
      const obs = new MutationObserver(() => { if (!document.contains(dlg.body)) { obs.disconnect(); finish(null); } });
      obs.observe(document.getElementById('modal-root'), { childList: true });
      setTimeout(() => { const first = box.querySelector('input,select'); first?.focus(); first?.select?.(); }, 0);
    });
  }

  // A dialog with a few choices; resolves with the chosen id (null if closed).
  choose(title, ic, html, choices) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const dlg = this.modal(title, ic, html, choices.map(([id, label, primary]) => ({ label, primary, action: () => finish(id) })));
      // closing with ✕, Esc or a click outside counts as cancel
      const obs = new MutationObserver(() => { if (!document.contains(dlg.body)) { obs.disconnect(); finish(null); } });
      obs.observe(document.getElementById('modal-root'), { childList: true });
    });
  }

  // Start window: new part, open, sample, and the recent parts list.
  showStart(info) {
    const a = this.app;
    document.querySelector('.modal-back.start-back')?.remove();
    const wrap = el('div', { class: 'start' });
    const left = el('div', { class: 'start-l' });
    const right = el('div', { class: 'start-r' });
    wrap.append(left, right);
    let dlg = null;
    // the start window closes as soon as a choice is made (the part loads behind it, with the
    // progress bar); if nothing was opened after all (a file dialog was cancelled) it comes back
    let chosen = false;
    const act = (fn) => async () => {
      if (chosen) return;
      chosen = true;
      dlg?.close();
      const ok = await fn();
      if (ok === false && a.doc && !a.doc.features.length && !a.filePath && !a.dirty) a.showStart();
    };
    const big = (ic, label, sub, fn, cls = '') => {
      const b = el('button', { class: 'start-btn ' + cls }, `${icon(ic)}<span><b>${esc(tr(label))}</b><small>${esc(tr(sub))}</small></span>`);
      b.onclick = act(fn);
      left.appendChild(b);
    };
    big('newdoc', 'New Part', 'Start an empty part', () => a.newDocument(), 'primary');
    big('assembly', 'New Assembly', 'Parts put together and held by mates', () => a.newAssembly());
    big('drawing', 'New Drawing', 'A 2D drawing of a part, from a template', () => a.newDrawing());
    big('open', 'Open…', 'Open a part or drawing file', () => a.openFile());
    big('part', 'Sample Part', 'A mounting plate to explore', () => a.openSample());
    big('loft', 'Example Part', 'Splines, a guided loft and a sheet metal tray (the tutorial in the manual)', () => a.openExample());
    if (info.legacy) {
      const when = info.legacy.modified ? new Date(info.legacy.modified).toLocaleString() : 'an earlier version';
      big('rebuild', 'Recover Previous Session', `Unsaved work kept by RazorCAD (${when})`, () => a.recoverLegacySession(), 'warn');
    }
    left.appendChild(el('div', { class: 'pm-hint start-note' }, tr('Parts are auto-saved next to their file once they have been saved for the first time.')));
    // new here: a short tour of the window
    const firstRun = !this.prefs?.tourDone;
    if (firstRun) {
      const t = el('button', { class: 'start-tour' }, `${icon('help')}<span><b>New to RazorCAD?</b> Take the one-minute tour</span>`);
      t.onclick = () => { chosen = true; dlg?.close(); setTimeout(() => this.startTour(), 50); };
      left.insertBefore(t, left.firstChild);
    }

    // crash reports written since they were last shown
    const crashes = info.crashes?.recent || [];
    if (crashes.length) {
      const box = el('div', { class: 'start-recover start-crash' });
      const what = crashes[0].kind === 'unexpected-shutdown' ? 'RazorCAD did not close normally last time' : crashes[0].kind === 'native-crash' ? 'RazorCAD crashed last time' : 'RazorCAD ran into an error';
      box.appendChild(el('div', { class: 'sr-h' }, `${icon('error')}<span><b>${esc(what)}</b><br><small>${crashes.length === 1 ? 'A crash report was' : crashes.length + ' crash reports were'} saved for inspection: ${esc(crashes[0].message.slice(0, 140))}</small></span>`));
      const row = el('div', { class: 'sr-row' }, '<span class="sr-n"></span>');
      const open = el('button', { class: 'pm-btn' }, 'Open crash reports folder');
      open.onclick = () => { a.openCrashFolder(crashes.length === 1 ? crashes[0].name : ''); platform.markCrashesSeen(); box.remove(); };
      const ok = el('button', { class: 'pm-btn' }, 'Dismiss');
      ok.onclick = () => { platform.markCrashesSeen(); box.remove(); };
      const rep = el('button', { class: 'pm-btn primary' }, 'Report on GitHub…');
      rep.onclick = () => { this.reportProblem(crashes[0].name); };
      row.append(rep, open, ok);
      box.appendChild(row);
      right.appendChild(box);
    }
    // parts with auto-saved changes that were never saved (RazorCAD crashed or was closed without saving)
    const pending = info.recent.filter((r) => r.exists && r.autosave);
    if (pending.length) {
      const box = el('div', { class: 'start-recover' });
      box.appendChild(el('div', { class: 'sr-h' }, `${icon('rebuild')}<span><b>Unsaved changes were auto-saved</b><br><small>RazorCAD was closed without saving these parts (or did not shut down normally).</small></span>`));
      for (const r of pending) {
        const row = el('div', { class: 'sr-row' }, `<span class="sr-n" title="${esc(r.path)}">${esc(r.name.replace(/\.(rcad|rasm|rdrw)$/i, ''))}</span>`);
        const rec = el('button', { class: 'pm-btn primary' }, 'Recover');
        const saved = el('button', { class: 'pm-btn' }, 'Open saved version');
        rec.onclick = act(() => a.openRecent(r.path, 'recover'));
        saved.onclick = act(() => a.openRecent(r.path, 'saved'));
        row.append(rec, saved);
        box.appendChild(row);
      }
      right.appendChild(box);
    }
    right.appendChild(el('div', { class: 'start-h' }, esc(tr('Recent Files'))));
    const list = el('div', { class: 'start-list' });
    if (!info.recent.length) list.appendChild(el('div', { class: 'pm-hint', style: 'padding:14px' }, esc(tr('No recent parts yet. Parts you open or save appear here.'))));
    for (const r of info.recent) {
      const when = r.modified ? new Date(r.modified).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'file not found';
      const isDwg = /\.rdrw$/i.test(r.name), isAsm = /\.rasm$/i.test(r.name);
      const item = el('div', { class: 'start-item' + (r.exists ? '' : ' missing'), title: r.path },
        `${r.thumb ? `<img class="si-thumb" src="${esc(r.thumb)}" alt="">` : `<span class="si-thumb si-noth">${icon(isDwg ? 'drawing' : isAsm ? 'assembly' : 'part')}</span>`}<div class="si-t"><div class="si-n">${esc(r.name.replace(/\.(rcad|rasm|rdrw)$/i, ''))}${r.autosave ? '<span class="si-badge" title="There are auto-saved changes that were never saved">auto-save</span>' : ''}</div><div class="si-f">${esc(r.folder)}</div></div><div class="si-d">${esc(when)}</div><button class="si-x" title="Remove from the list">✕</button>`);
      if (r.exists) item.onclick = act(() => a.openRecent(r.path));
      item.querySelector('.si-x').onclick = async (e) => {
        e.stopPropagation();
        await platform.removeRecent(r.path);
        item.remove();
      };
      list.appendChild(item);
    }
    right.appendChild(list);
    dlg = this.modal('RazorCAD', 'part', wrap, []);
    dlg.body.closest('.modal-back').classList.add('start-back');
    // (the first time: when the start window closes on an empty part, the tour starts by itself, once)
    if (firstRun && !this.prefs.tourOffered) {
      this.prefs.tourOffered = true;
      this.savePrefs();
      const back = dlg.body.closest('.modal-back');
      new MutationObserver((_, obs) => {
        if (back.isConnected) return;
        obs.disconnect();
        setTimeout(() => { if (!this.prefs.tourDone && !document.querySelector('.modal-back') && a.mode === 'part' && !a.doc?.features?.length) this.startTour(); }, 700);
      }).observe($('#modal-root'), { childList: true });
    }
  }

  // ---- Getting Started Tour: a few steps, each pointing at a part of the window (Next / Back, → / ← or Enter;
  // Esc ends it). Shown once by itself the first time RazorCAD starts; Help ▸ Getting Started Tour any time.
  startTour() {
    document.querySelector('#tour')?.remove();
    const a = this.app;
    if (a.mode !== 'part' && a.mode !== 'sketch') { a.toast('The tour shows the part window: open or start a part first'); return; }
    const steps = [
      { title: 'Welcome to RazorCAD', text: 'A one-minute look round the window. Use <b>Next</b> (or → / Enter); <b>Esc</b> ends the tour.' },
      { at: '#commandmanager', title: 'Commands', text: 'The toolbar holds the commands of each tab: Features, Sketch, Surfaces, Sheet Metal, Fast Structure, Evaluate. Point at a button for its name. The menus above have them all as well.' },
      { at: '#tree', title: 'The feature tree', text: 'Your part as you built it, one feature after another. Double-click a feature to change it, right-click for more, and drag the bar at the end to roll the part back.' },
      { at: '#viewport', title: 'The view', text: '<b>Middle mouse</b>: turn · <b>Shift + right mouse</b>: pan · <b>wheel</b>: zoom · <b>F</b>: zoom to fit. Click faces, edges and vertices to pick them; the arrows turn the view in steps.' },
      { at: '#tree', title: 'Your first part', text: 'Click <b>Top Plane</b> here, then <b>Sketch</b> (Sketch tab). Draw with <b>R</b> (rectangle), <b>L</b> (line) or <b>C</b> (circle), dimension with <b>D</b>, close the sketch and click <b>Extrude</b>.' },
      { at: '#menubar .mb-quick', title: 'Find any command', text: 'Press <b>Ctrl+K</b> (or click the magnifier) and type part of a command\'s name. Help ▸ Keyboard Shortcuts lists the controls, and you can give commands keys of your own.' },
      { at: '#status-units', title: 'Units', text: 'Millimetres or inches, for each part, assembly or drawing: click here to change.' },
      { title: 'That\'s it', text: 'The sample part shows many features at work. Help ▸ Getting Started Tour shows this tour again.', end: true },
    ];
    let i = 0;
    const root = el('div', { id: 'tour' });
    const hole = el('div', { class: 'tour-hole' });
    const bub = el('div', { class: 'tour-bubble' });
    root.append(hole, bub);
    document.body.appendChild(root);
    const finish = (sample = false) => {
      root.remove();
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', show);
      this.prefs ||= {};
      this.prefs.tourDone = true;
      this.savePrefs();
      if (sample) a.openSample();
    };
    const show = () => {
      const st = steps[i];
      const t = st.at && document.querySelector(st.at);
      const r = t?.getBoundingClientRect();
      const W = window.innerWidth, H = window.innerHeight;
      if (r && r.width && r.height) {
        const pad = 4;
        Object.assign(hole.style, { display: 'block', left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + 2 * pad + 'px', height: r.height + 2 * pad + 'px' });
      } else Object.assign(hole.style, { display: 'block', left: W / 2 + 'px', top: H / 2 + 'px', width: '0px', height: '0px' });
      bub.innerHTML = `<div class="tb-n">${i + 1} / ${steps.length}</div><div class="tb-t">${esc(st.title)}</div><div class="tb-x">${st.text}</div>`;
      const nav = el('div', { class: 'tb-nav' });
      const btn = (label, fn, primary = false) => { const b = el('button', { class: 'pm-btn' + (primary ? ' primary' : '') }, esc(label)); b.onclick = fn; nav.appendChild(b); };
      if (!st.end) btn('Skip the tour', () => finish());
      if (i > 0) btn('Back', () => { i--; show(); });
      if (st.end) { btn('Open the Sample Part', () => finish(true)); btn('Finish', () => finish(), true); } else btn('Next', () => { i++; show(); }, true);
      bub.appendChild(nav);
      // the bubble beside what it points at: below, else above, else in the middle
      const bw = Math.min(360, W - 24), bh = bub.offsetHeight || 160;
      let x = W / 2 - bw / 2, y = H / 2 - bh / 2;
      if (r && r.width) {
        const tall = r.height > H * 0.4, wide = r.width > W * 0.5;
        if (tall && wide) { x = r.left + Math.min(40, r.width / 8); y = r.top + Math.min(40, r.height / 8); } // (a big area: inside it, at its top left)
        else if (tall) { y = r.top + Math.min(60, r.height / 6); x = r.right + 14 + bw < W ? r.right + 14 : Math.max(12, r.left - bw - 14); } // (beside a tall one)
        else {
          x = r.left + r.width / 2 - bw / 2;
          if (r.bottom + 14 + bh < H) y = r.bottom + 14;
          else if (r.top - 14 - bh > 0) y = r.top - 14 - bh;
          else { y = r.top + 20; x = r.right + 14 + bw < W ? r.right + 14 : r.left - bw - 14; }
        }
        x = Math.min(Math.max(12, x), W - bw - 12);
        y = Math.min(Math.max(12, y), H - bh - 12);
      }
      Object.assign(bub.style, { left: x + 'px', top: y + 'px', width: bw + 'px' });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(); }
      else if ((e.key === 'ArrowRight' || e.key === 'Enter') && !steps[i].end) { e.preventDefault(); e.stopPropagation(); i++; show(); }
      else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); e.stopPropagation(); i--; show(); }
      else if (e.key === 'Enter' && steps[i].end) { e.preventDefault(); e.stopPropagation(); finish(); }
    };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', show);
    show();
  }

  // Draft analysis: the pull direction and the draft needed.
  async showThicknessAnalysis() {
    const v = await this.promptFields('Thickness Analysis', 'measure', [
      { key: 'min', label: 'Thinnest wall allowed (mm)', value: 1 },
      { key: 'max', label: 'Thickest wall allowed (mm)', value: 4 },
    ], 'The model is coloured by its wall thickness, measured from each point straight in through the material: red thinner than allowed, blue thicker (sinks and voids when moulded), green to yellow between.');
    if (!v) return;
    const lo = parseFloat(v.min), hi = parseFloat(v.max);
    if (!(lo >= 0 && hi > lo)) { this.app.toast('Give a thinnest wall and a thicker thickest one', true); return; }
    this.app.setAnalysis({ kind: 'thickness', min: lo, max: hi, force: true });
  }

  async showDraftAnalysis(kind = 'draft') {
    const a = this.app, sel = a.selection;
    const opts = [['y', 'Y (up)'], ['-y', '−Y'], ['x', 'X'], ['-x', '−X'], ['z', 'Z'], ['-z', '−Z']];
    if (sel?.kind === 'face' && sel.face.planar) opts.unshift(['face', 'Normal of the selected face']);
    const v = await this.promptFields(kind === 'undercut' ? 'Undercut Check' : 'Draft Analysis', 'draftAnalysis', [
      { key: 'dir', label: 'Pull direction', type: 'select', options: opts, value: opts[0][0] },
      ...(kind === 'undercut' ? [] : [{ key: 'angle', label: 'Draft needed (°)', value: 1 }]),
    ], kind === 'undercut' ? 'Each point is looked at along the pull direction and against it: green can be pulled out one way (one mould half), blue the other, red neither (an undercut: it needs a side action or a change).' : 'Faces are coloured by their angle to the pull direction: green has the draft, red has it the other way (the other mould half), yellow needs more.');
    if (!v) return;
    const ax = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const dir = v.dir === 'face' ? sel.face.normal.toArray() : v.dir.startsWith('-') ? ax[v.dir[1]].map((q) => -q) : ax[v.dir];
    if (kind === 'undercut') { a.setAnalysis({ kind: 'undercut', dir, force: true }); return; }
    const ang = parseFloat(v.angle);
    a.setAnalysis({ kind: 'draft', dir, angle: Number.isFinite(ang) ? Math.max(0, ang) : 1, force: true });
  }

  // The weldment cut list: identical members counted together, with lengths, end angles and masses.
  async showCutList() {
    const a = this.app;
    let members;
    try { members = await a.kernel.request('cutList', {}); } catch (e) { a.toast(e.message, true); return; }
    if (!members.length) { a.toast('There are no weldment members yet (Fast Structure ▸ Structural Member)', true); return; }
    for (const m of members) m.density = a.bodyById(m.id)?.material?.density || null;
    const cl = cutListRows(members);
    const f2 = (x) => (x == null ? '—' : fmt(x, 1));
    const html = `<table class="grid"><tr><th>Item</th><th>Qty</th><th>Description</th><th>Length</th><th>Angle 1</th><th>Angle 2</th><th>Total length</th><th>Mass each</th></tr>${cl.rows.map((r) => `<tr><td class="num">${r.item}</td><td class="num">${r.qty}</td><td>${esc(r.description)}</td><td class="num">${f2(r.length)}</td><td class="num">${r.angle1 == null ? '—' : f2(r.angle1) + '°'}</td><td class="num">${r.angle2 == null ? '—' : f2(r.angle2) + '°'}</td><td class="num">${f2(r.totalLength)}</td><td class="num">${r.mass == null ? '—' : fmt(r.mass, 3) + ' kg'}</td></tr>`).join('')}</table>`
      + (cl.totals.length ? `<p class="pm-hint" style="margin-top:8px">Total length by profile: ${cl.totals.map((t) => `${esc(t.label)} ${fmt(t.length, 1)} mm`).join(' · ')}. Masses from the bodies' materials (none set: —). Angles: the end cuts from square.</p>` : '');
    const choice = await this.choose('Cut List', 'cutList', html, [['csv', 'Export CSV…'], ['close', 'Close', true]]);
    if (choice === 'csv') {
      try {
        const path = await platform.saveBinary(`${a.safeName()} cut list.csv`, new TextEncoder().encode(cutListCSV(cl)), 'csv');
        if (path) a.status('Exported ' + String(path).split(/[\\/]/).pop());
      } catch (e) { a.toast('Export failed: ' + e.message, true); }
    }
  }

  // Appearance of a face or a body: a colour (or back to the default).
  showAppearance(target) {
    const a = this.app;
    const cur = target.kind === 'body' ? a.doc.bodies?.[target.id]?.color : (a.doc.appearance?.faces || []).find((x) => a.viewport.faceIndexNear(x.p) === a.viewport.faceIndexNear(target.p))?.color;
    const box = el('div', { class: 'dw-form' });
    const swatches = ['#c3cad4', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#3949ab', '#8e24aa', '#6d4c41', '#212121', '#f5f5f5', '#b0bec5'];
    box.innerHTML = `<div class="pm-hint" style="margin-bottom:6px">${target.kind === 'body' ? 'Colour of the whole body (over its material colour).' : 'Colour of this face (it stays with the face when the model changes, found again by where it is).'}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">${swatches.map((c) => `<button class="sw" data-c="${c}" style="width:22px;height:22px;border:1px solid #8a94a3;border-radius:3px;background:${c};cursor:pointer" title="${c}"></button>`).join('')}</div>
      <label style="display:flex;gap:8px;align-items:center">Colour <input type="color" value="${cur || '#1e88e5'}"></label>`;
    const inp = box.querySelector('input[type=color]');
    box.querySelectorAll('.sw').forEach((b) => (b.onclick = () => { inp.value = b.dataset.c; }));
    this.modal(target.kind === 'body' ? 'Body Appearance' : 'Face Appearance', 'appearance', box, [
      { label: 'OK', primary: true, action: () => a.setAppearance(target, inp.value) },
      { label: 'Default colour', action: () => a.setAppearance(target, null) },
      { label: 'Cancel' },
    ]);
  }

  // Configurations and their design table: rows = configurations, columns = the global variables (a
  // blank cell keeps the variable's own value) and the features each configuration suppresses.
  showConfigurations() {
    const a = this.app, doc = a.doc;
    const vars = (doc.equations || []).filter((e) => e.name).map((e) => e.name);
    const feats = doc.features.filter((f) => f.type !== 'sketch' || true);
    let rows = JSON.parse(JSON.stringify(doc.configs || []));
    let active = doc.activeConfig || null;
    const wrap = el('div');
    wrap.appendChild(el('p', { class: 'pm-hint', style: 'margin:0 0 8px' }, vars.length ? 'Each configuration is the part with other values for the global variables (blank: the value from Equations) and with features suppressed. Pick the active one with the round button.' : 'Add global variables in Equations first (e.g. <code>length = 100</code>), then each configuration can give them other values. Configurations can also suppress features.'));
    const table = el('table', { class: 'grid' });
    wrap.appendChild(table);
    const btns = el('div', { style: 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap' });
    const addB = el('button', { class: 'pm-btn' }, '+ Add configuration');
    const copyB = el('button', { class: 'pm-btn', title: 'Copy the design table as CSV (paste into Excel)' }, 'Copy as CSV');
    const pasteB = el('button', { class: 'pm-btn', title: 'Paste a design table (CSV or tab separated, e.g. copied from Excel)' }, 'Paste design table…');
    btns.append(addB, copyB, pasteB);
    wrap.appendChild(btns);
    const nameOf = (id) => doc.features.find((f) => f.id === id)?.name || id;
    const render = () => {
      table.innerHTML = `<tr><th style="width:24px"></th><th>Configuration</th>${vars.map((v) => `<th>${esc(v)}</th>`).join('')}<th>Suppressed features</th><th style="width:28px"></th></tr>`;
      const defRow = el('tr');
      const r0 = el('input', { type: 'radio', name: 'cfg-active' }); r0.checked = !active; r0.onchange = () => { active = null; };
      const td0 = el('td'); td0.appendChild(r0);
      defRow.append(td0, el('td', {}, '<i>Default</i>'), ...vars.map((v) => el('td', { class: 'num' }, esc(String(doc.equations.find((e) => e.name === v)?.expr ?? '')))), el('td', {}, ''), el('td'));
      table.appendChild(defRow);
      rows.forEach((c, i) => {
        const tr = el('tr');
        const rb = el('input', { type: 'radio', name: 'cfg-active' }); rb.checked = active === c.id; rb.onchange = () => { active = c.id; };
        const tdr = el('td'); tdr.appendChild(rb);
        const nm = el('input', { type: 'text', value: c.name }); nm.oninput = () => { c.name = nm.value; };
        const tdn = el('td'); tdn.appendChild(nm);
        const cells = vars.map((v) => {
          const inp = el('input', { type: 'text', value: c.vals?.[v] ?? '', placeholder: String(doc.equations.find((e) => e.name === v)?.expr ?? ''), style: 'width:70px' });
          inp.oninput = () => { c.vals ||= {}; c.vals[v] = inp.value; };
          const td = el('td'); td.appendChild(inp); return td;
        });
        const sel = el('select', { multiple: true, size: '3', style: 'min-width:140px' });
        for (const f of feats) { const o = el('option', { value: f.id }, esc(f.name)); o.selected = (c.suppressed || []).includes(f.id); sel.appendChild(o); }
        sel.onchange = () => { c.suppressed = [...sel.selectedOptions].map((o) => o.value); };
        const tds = el('td'); tds.appendChild(sel);
        const del = el('button', { class: 'pm-btn', style: 'padding:0 6px;height:22px', title: 'Delete' }, '✕');
        del.onclick = () => { if (active === c.id) active = null; rows.splice(i, 1); render(); };
        const tdd = el('td'); tdd.appendChild(del);
        tr.append(tdr, tdn, ...cells, tds, tdd);
        table.appendChild(tr);
      });
    };
    const newId = () => { let k = 1; while (rows.some((c) => c.id === 'cfg' + k)) k++; return 'cfg' + k; };
    addB.onclick = () => { let k = rows.length + 1; while (rows.some((c) => c.name === 'Config' + k)) k++; rows.push({ id: newId(), name: 'Config' + k, vals: {}, suppressed: [] }); render(); };
    const toCSV = () => {
      const q = (s2) => (/[",\n]/.test(s2) ? `"${s2.replace(/"/g, '""')}"` : s2);
      return [['Configuration', ...vars, 'Suppressed'], ...rows.map((c) => [c.name, ...vars.map((v) => c.vals?.[v] ?? ''), (c.suppressed || []).map(nameOf).join('; ')])].map((r) => r.map((x) => q(String(x))).join(',')).join('\n');
    };
    copyB.onclick = async () => { try { await navigator.clipboard.writeText(toCSV()); a.status('Design table copied as CSV.'); } catch { a.toast('Could not copy to the clipboard', true); } };
    pasteB.onclick = async () => {
      const text = await this.promptText('Paste Design Table', 'configs', 'Paste the table: a header row (Configuration, variable names…, Suppressed) and one row per configuration, comma or tab separated.', toCSV(), true);
      if (!text) return;
      const parse = (line) => { const sep = line.includes('\t') ? '\t' : ','; const out = []; let cur2 = '', qd = false; for (const ch of line) { if (ch === '"') qd = !qd; else if (ch === sep && !qd) { out.push(cur2); cur2 = ''; } else cur2 += ch; } out.push(cur2); return out.map((x) => x.trim()); };
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      const head = parse(lines[0]);
      const sCol = head.findIndex((h) => /^suppress/i.test(h));
      const next = [];
      for (const l of lines.slice(1)) {
        const cells = parse(l), name = cells[0];
        if (!name) continue;
        const old = rows.find((c) => c.name === name);
        const c = { id: old?.id || newId() + '_' + next.length, name, vals: {}, suppressed: [] };
        head.forEach((h, k) => { if (k && k !== sCol && vars.includes(h) && cells[k] !== undefined && cells[k] !== '') c.vals[h] = cells[k]; });
        if (sCol > 0 && cells[sCol]) c.suppressed = cells[sCol].split(/[;|]/).map((x) => x.trim()).map((n) => doc.features.find((f) => f.name === n)?.id).filter(Boolean);
        next.push(c);
      }
      rows = next;
      if (!rows.some((c) => c.id === active)) active = null;
      render();
    };
    render();
    this.modal('Configurations / Design Table', 'configs', wrap, [
      {
        label: 'OK', primary: true, action: () => {
          for (const c of rows) { c.name = c.name.trim() || c.id; for (const k of Object.keys(c.vals || {})) if (String(c.vals[k]).trim() === '') delete c.vals[k]; }
          doc.configs = rows;
          doc.activeConfig = rows.some((c) => c.id === active) ? active : null;
          a.commit();
          a.rebuild();
          this.renderTree();
          this.renderConfigs();
          a.status(`Configuration: ${a.activeConfig()?.name || 'Default'}`);
        },
      },
      { label: 'Cancel' },
    ]);
  }

  showEquations() {
    const a = this.app;
    const rows = a.doc.equations.map((e) => ({ ...e }));
    const wrap = el('div');
    wrap.appendChild(el('p', { class: 'pm-hint', style: 'margin:0 0 8px' }, 'Global variables can be used in any dimension or feature value. Example: <code>width = 120</code>, then set a depth to <code>width/4</code>.'));
    const table = el('table', { class: 'grid' });
    wrap.appendChild(table);
    const addBtn = el('button', { class: 'pm-btn', style: 'margin-top:8px' }, '+ Add variable');
    wrap.appendChild(addBtn);
    const render = () => {
      const { vars, errors } = evalEquations(rows);
      const names = rows.map((r) => r.name);
      table.innerHTML = '<tr><th style="width:30%">Name</th><th>Value / Equation</th><th style="width:22%">Evaluates to</th><th style="width:28px"></th></tr>';
      rows.forEach((r, i) => {
        const tr = el('tr');
        const n = el('input', { type: 'text', value: r.name, spellcheck: 'false' });
        const v = el('input', { type: 'text', value: String(r.expr), spellcheck: 'false' });
        const dup = names.indexOf(r.name) !== i;
        const bad = r.name && (!isValidName(r.name) || dup);
        const out = el('td', { class: 'num' + (bad || errors.has(r.name) ? ' err' : '') },
          bad ? (dup ? 'Duplicate name' : 'Invalid name') : r.name in vars ? fmt(vars[r.name], 4) : esc(errors.get(r.name) || ''));
        n.oninput = () => { r.name = n.value.trim(); refreshVals(); };
        v.oninput = () => { r.expr = v.value; refreshVals(); };
        const del = el('button', { class: 'pm-btn', style: 'padding:0 6px;height:22px', title: 'Delete' }, '✕');
        del.onclick = () => { rows.splice(i, 1); render(); };
        const td1 = el('td'), td2 = el('td'), td4 = el('td');
        td1.appendChild(n); td2.appendChild(v); td4.appendChild(del);
        tr.append(td1, td2, out, td4);
        tr.dataset.i = i;
        table.appendChild(tr);
      });
    };
    const refreshVals = () => {
      const { vars, errors } = evalEquations(rows);
      const names = rows.map((r) => r.name);
      table.querySelectorAll('tr[data-i]').forEach((tr) => {
        const r = rows[+tr.dataset.i];
        const td = tr.children[2];
        const dup = names.indexOf(r.name) !== +tr.dataset.i;
        const bad = r.name && (!isValidName(r.name) || dup);
        td.className = 'num' + (bad || errors.has(r.name) ? ' err' : '');
        td.textContent = bad ? (dup ? 'Duplicate name' : 'Invalid name') : r.name in vars ? fmt(vars[r.name], 4) : errors.get(r.name) || '';
      });
    };
    addBtn.onclick = () => {
      let k = rows.length + 1;
      while (rows.some((r) => r.name === 'var' + k)) k++;
      rows.push({ name: 'var' + k, expr: '10' });
      render();
      table.querySelector('tr:last-child input')?.select();
    };
    render();
    this.modal('Equations, Global Variables', 'equations', wrap, [
      {
        label: 'OK', primary: true, action: () => {
          const clean = rows.filter((r) => r.name);
          const names = clean.map((r) => r.name);
          if (clean.some((r, i) => !isValidName(r.name) || names.indexOf(r.name) !== i)) { a.toast('Fix invalid or duplicate names first', true); return false; }
          a.doc.equations = clean;
          a.commit();
          a.rebuild();
        },
      },
      { label: 'Cancel' },
    ]);
  }

  // References of a reference plane: picked on the model (faces, edges, vertices), in the
  // view (planes) or in the tree (planes, axes, points). The plane type follows from them.
  datumGeometryHint(r){return datumHint(this.app.doc,r);}

  updateDatumStatus(root,f){
    const a=this.app,info=a.result?.info?.[f.id],coordinate=f.type==='point'&&f.pointType==='coords';
    const current=info?.datumSignature===JSON.stringify(f),datum=current?info.datum:null;
    const status=datum?.status||(!coordinate&&!(f.refs||[]).length?'under':'checking');
    const label={defined:'Fully Defined',under:'Under Defined',conflict:'Conflicting',checking:'Updating preview…'}[status];
    for(const box of root.querySelectorAll('[data-datum-status]')){
      box.dataset.datumStatus=status;box.className='pm-msg'+(status==='defined'?' ok':status==='conflict'?' err':'');
      box.textContent=label+(datum?.message?' — '+datum.message:datum?.legacy?' — existing construction preserved; edit a relation to use the constraint definition':status==='under'?' — select references and their relations':'');
    }
    const ok=root.querySelector('.pm-actions button[title^="OK"]');if(ok){ok.disabled=status!=='defined';ok.setAttribute('aria-disabled',String(ok.disabled));}
    const solution=root.querySelector('[data-datum-solution]');if(solution){solution.disabled=!(datum?.alternatives>1);solution.value=String(Math.min(f.solution||0,(datum?.alternatives||1)-1));}
    for(const node of root.querySelectorAll('[data-datum-path-info]')){const sample=current&&info.pathLocations?.[Number(node.dataset.datumPathInfo)];node.textContent=sample?`Length: ${lenWithUnit(sample.length,a.units)} · Distance: ${lenWithUnit(sample.distance,a.units)}`:'The path length will appear after preview.';}
  }

  renderPlaneRefs(body, f, before) {
    const a=this.app,pm=a.pm;f.refs ||= [];body.classList.add('datum-definition');
    body.appendChild(el('div',{'data-datum-status':'checking',class:'pm-msg'},'Updating preview…'));
    const info=a.result?.info?.[f.id],resolved=info?.datumSignature===JSON.stringify(f)&&info.geometry;
    const hints=resolved?resolved.map((g,i)=>resolvedDatumHint(a.doc,f.refs[i],g,f.type)):f.refs.map(r=>this.datumGeometryHint(r)),defaults=defaultReferenceRelations(f.type,hints,f);body.dataset.geometry=resolved?JSON.stringify(resolved):'';
    const name=r=>{
      if(r.kind==='sketch'){const sk=a.result?.sketches.get(r.sketch)?.sketch||findFeature(a.doc,r.sketch),id=r.point||r.curve;return `${sk?.name||'(missing sketch)'} · ${sk?SM.itemName(sk,id):id} (${id})`;}
      return r.kind==='plane'?STD_PLANES[r.id]?.name||findFeature(a.doc,r.id)?.name||'(missing plane)':['axis','point','curve'].includes(r.kind)?findFeature(a.doc,r.id)?.name||'(missing reference)':r.kind==='face'?(r.n?'Planar face':'Cylindrical / conical face'):r.kind==='edge'?'Model edge':'Model vertex';
    };
    for(let i=0;i<3;i++){
      const r=f.refs[i],row=el('div',{class:'pm-row','data-datum-slot':i});
      const pick=el('button',{class:'pm-btn'+(pm.datumSlot===i?' on':''),'data-datum-pick':i,disabled:i>f.refs.length,onclick:()=>{pm.datumSlot=pm.datumSlot===i?null:i;this.renderPM();a.updateSketchDisplay();a.updatePlanes();}},`Reference ${i+1}: ${r?esc(name(r)):'Select geometry'}`);
      row.appendChild(pick);
      if(r)row.appendChild(el('button',{'data-datum-remove':i,class:'pm-btn',title:'Remove reference',onclick:()=>{f.refs.splice(i,1);useReferenceRelations(f);pm.datumSlot=null;a.preview(true);a.updateSketchDisplay();a.updatePlanes();}},'✕'));
      body.appendChild(row);
      if(!r)continue;
      const select=el('select',{'data-datum-relation':i,'aria-label':`Reference ${i+1} relation`});
      select.appendChild(el('option',{value:''},'Automatic — '+(RELATION_LABELS[defaults[i]]||'Choose relation')));
      for(const relation of referenceRelations(f.type,hints[i]))select.appendChild(el('option',{value:relation},RELATION_LABELS[relation]));
      select.value=r.relation||'';select.onchange=()=>{if(select.value)r.relation=select.value;else delete r.relation;useReferenceRelations(f);f.solution=0;a.preview(true);};
      body.appendChild(this.row('Relation',select));
      const relation=r.relation||defaults[i],key=relation==='angle'?'angle':relation==='offset'?'offset':relation==='distance'?'distance':null;
      if(key){const initial=r[key]??(f.type==='plane'?f[key]:null)??0,input=this.exprInput(initial,key==='angle'?'°':'mm',value=>{r[key]=value;useReferenceRelations(f);a.preview();});input.dataset.datumParameter=i+':'+key;body.appendChild(this.row(key==='angle'?'Angle':key==='offset'?'Distance':'Distance from start',input));}
      if(relation==='alongPath'){
        const mode=el('select',{'data-datum-path-mode':i,'aria-label':'Position along path'});
        for(const [value,label] of [['fraction','Fraction (0–1)'],['distance','Distance along curve'],['start','Start'],['mid','Half arc length'],['end','End']])mode.appendChild(el('option',{value},label));
        mode.value=r.positionMode||'fraction';mode.onchange=()=>{r.positionMode=mode.value;useReferenceRelations(f);a.preview(true);};body.appendChild(this.row('Position',mode));
        if(['fraction','distance'].includes(mode.value)){
          const field=mode.value,initial=r[field]??(field==='fraction'?.5:0),input=this.exprInput(initial,field==='fraction'?'#':'mm',value=>{r[field]=value;useReferenceRelations(f);a.preview();});input.dataset.datumParameter=i+':'+field;body.appendChild(this.row(field==='fraction'?'Fraction':'Arc distance',input));
        }
        const reverse=el('input',{type:'checkbox','data-datum-path-reverse':i});reverse.checked=!!r.reversePath;reverse.onchange=()=>{r.reversePath=reverse.checked;useReferenceRelations(f);a.preview();};
        const label=el('label');label.append(reverse,document.createTextNode(' Reverse path direction'));body.appendChild(this.row(null,label,'check'));
        body.appendChild(el('div',{'data-datum-path-info':i,class:'pm-hint'},''));
      }
    }
    const sources=el('select',{'data-datum-source':'','aria-label':'Reference geometry'}),entities=[];sources.appendChild(el('option',{value:''},'Choose reference geometry…'));
    for(const [id,p] of Object.entries(STD_PLANES))sources.appendChild(el('option',{value:'plane:'+id},esc(p.name)));
    for(const source of before.filter(x=>!x.suppressed&&(['plane','axis','point'].includes(x.type)||f.type!=='axis'&&['helix','sketch3d','compCurve','projCurve'].includes(x.type))))sources.appendChild(el('option',{value:(['plane','axis','point'].includes(source.type)?source.type:'curve')+':'+source.id},esc(source.name)));
    for(const source of before.filter(x=>x.type==='sketch'&&!x.suppressed&&!a.result?.errors.has(x.id))){
      const sk=a.result?.sketches.get(source.id)?.sketch;if(!sk)continue;
      const group=el('optgroup',{label:source.name});
      const add=(kind,id)=>{const ref={kind:'sketch',sketch:source.id,[kind]:id},value='entity:'+entities.length;entities.push(ref);group.appendChild(el('option',{value,'data-datum-sketch':source.id,['data-datum-'+kind]:id},`${SM.itemName(sk,id)} (${id})`));};
      for(const c of sk.curves)if(['line','arc','circle'].includes(c.type)||f.type!=='axis'&&c.type==='spline')add('curve',c.id);
      add('point','O');for(const p of sk.points)add('point',p.id);
      sources.appendChild(group);
    }
    sources.onchange=()=>{if(sources.value){const [kind,id]=sources.value.split(':');a.togglePlaneRef(kind==='entity'?{...entities[Number(id)]}:{kind,id});}};
    body.appendChild(sources);
    const solution=el('select',{'data-datum-solution':'','aria-label':'Geometric solution'});solution.append(el('option',{value:'0'},'Solution 1'),el('option',{value:'1'},'Solution 2'));
    solution.value=String(f.solution||0);solution.onchange=()=>{f.solution=Number(solution.value);a.preview();};body.appendChild(this.row('Solution',solution));
    body.appendChild(el('div',{class:'pm-hint'},'Pick references in the canvas or tree. Choose a slot to replace it. Relations constrain the resulting geometry; incomplete or conflicting definitions cannot be accepted. An alternative solution is offered when the relations define two distinct results.'));
    this.updateDatumStatus(body,f);
  }

  renderFaceList(body, f, fd = {}) {
    const a = this.app;
    const key = fd.key || 'faces', pm = a.pm;
    if (!Array.isArray(f[key])) f[key] = [];
    if (fd.sweepSupport) body.appendChild(el('button', { class: 'pm-btn' + (pm.sweepSupportPick ? ' on' : ''), 'data-sweep-support': '', onclick: () => { pm.sweepSupportPick = !pm.sweepSupportPick; pm.planarEdges = false; if (pm.sweepSupportPick) pm.sweepCanvas = false; this.renderPM(); a.updateSketchDisplay(); a.updateEdgeHighlights(); } }, 'Select faces in canvas'));
    if (fd.shellThick) body.appendChild(el('button', { class: 'pm-btn' + (pm.shellThickPick ? ' on' : ''), 'data-shell-thick': '', onclick: () => { pm.shellThickPick = !pm.shellThickPick; this.renderPM(); a.updateEdgeHighlights(); } }, 'Select walls in canvas'));
    if (fd.patchSupport) body.appendChild(el('button', { class: 'pm-btn' + (pm.patchSupportPick ? ' on' : ''), 'data-patch-support': '', onclick: () => { pm.patchSupportPick = !pm.patchSupportPick; this.renderPM(); a.updateEdgeHighlights(); } }, 'Select support faces'));
    if (fd.loftEnd) body.appendChild(el('button', { class: 'pm-btn' + (pm.loftEndSlot === key ? ' on' : ''), 'data-loft-end-faces': key, onclick: () => { pm.loftEndSlot = pm.loftEndSlot === key ? null : key; pm.loftDraft = null; this.renderPM(); a.updateSketchDisplay(); a.updateEdgeHighlights(); } }, `Select ${fd.loftEnd} support faces`));
    body.appendChild(el('div', { class: 'pm-hint' }, esc(fd.hint || 'Click faces on the model to add or remove them.')));
    const ul = el('div', { class: 'pm-list' });
    if (!f[key].length) ul.appendChild(el('div', { class: 'li pm-hint' }, esc(fd.empty || 'No faces selected')));
    f[key].forEach((r, i) => {
      const li = el('div', { class: 'li sel' }, `${icon('plane')}<span>${esc(fd.itemLabel || 'Face')}&lt;${i + 1}&gt;</span><span class="x" title="Remove">✕</span>`);
      if (fd.shellThick) { const own = this.exprInput(r.t ?? '', 'mm', (value) => { r.t = value; a.preview(); }); own.dataset.shellWallThickness = i; own.title = 'This wall’s thickness'; li.insertBefore(own, li.querySelector('.x')); }
      li.querySelector('.x').onclick = () => { f[key].splice(i, 1); this.renderPM(); a.updateEdgeHighlights(); a.preview(); };
      ul.appendChild(li);
    });
    body.appendChild(ul);
    if (f[key].length) body.appendChild(el('button', { class: 'pm-btn', onclick: () => { f[key].length = 0; this.renderPM(); a.updateEdgeHighlights(); a.preview(); } }, 'Clear'));
  }

  renderSweepSelection(body,f,before,fd){
    const a=this.app,pm=a.pm,slot=fd.key,active=pm.sweepSlot===slot&&pm.sweepCanvas!==false&&!pm.scopePick;
    body.appendChild(el('button',{class:'pm-btn'+(active?' on':''),'data-sweep-slot':slot,'aria-pressed':String(active),onclick:()=>a.activateSweepSlot(slot)},`Select ${fd.label} in canvas`));
    const current=f[slot];
    if(current){
      const row=el('div',{class:'li sel','data-sweep-reference':slot}),name=typeof current==='string'?findFeature(a.doc,current)?.name||'(missing)':LR.describeRef(a.doc,current);
      row.appendChild(el('span',{},esc(name)));row.appendChild(el('button',{class:'pm-btn','data-sweep-clear':slot,onclick:()=>a.setSweepReference(null,slot)},'✕'));body.appendChild(row);
    }
    if(active){
      const checkbox=el('input',{type:'checkbox','data-sweep-chain':slot});checkbox.checked=f.selectionChains?.[slot]!==false;
      checkbox.onchange=()=>{f.selectionChains={...(f.selectionChains||{}),[slot]:checkbox.checked};pm.loftDraft=null;pm.loftHover=null;this.renderPM();a.updateSketchDisplay();};
      const label=el('label');label.append(checkbox,document.createTextNode(' Chain selection'));body.appendChild(this.row(null,label,'check'));
      body.appendChild(el('div',{class:'pm-hint'},slot==='profile'?'Choose a region or contour. Surface profiles may be open; solid open profiles use Thin Feature.':'Choose one connected path or guide; construction curves are allowed. Different contours from one sketch can fill different roles.'));
      if(!checkbox.checked){
        const count=pm.loftDraft?.curves.length||0;
        body.appendChild(el('div',{class:'pm-hint'},`${count} entities in the current contour`));
        body.appendChild(el('button',{class:'pm-btn','data-sweep-finish':slot,disabled:!count,onclick:()=>a.finishLoftSelection()},'Use selected contour'));
        if(count)body.appendChild(el('button',{class:'pm-btn','data-sweep-draft-clear':slot,onclick:()=>{pm.loftDraft=null;this.renderPM();a.updateSketchDisplay();}},'Clear current selection'));
      }
    }
    const details=el('details'),summary=el('summary',{},'Other sources (whole sketch / curve)');details.appendChild(summary);
    const select=el('select',{'data-sweep-field':slot}),kinds=slot==='profile'?['sketch']:['sketch','sketch3d','helix','compCurve','projCurve'];
    select.appendChild(el('option',{value:''},slot==='guide'?'— no guide —':'— select a source —'));
    for(const source of before.filter(s=>kinds.includes(s.type)&&!s.suppressed&&!['profile','path','guide'].some(other=>other!==slot&&!(other==='profile'&&f.profileType==='circle')&&LR.overlappingRefs(s.id,f[other]))))select.appendChild(el('option',{value:source.id},esc(source.name)));
    select.value=typeof current==='string'?current:'';
    select.onchange=()=>a.setSweepReference(select.value||null,slot);
    details.appendChild(select);body.appendChild(details);
  }

  // Loft profiles: sketches in order (the loft goes through them from first to last).
  renderLoftCorrespondence(body,f){
    const a=this.app,pm=a.pm,active=LC.hasManualConnections(f),refs=f.profiles||[];
    body.classList.add('datum-definition');body.dataset.loftCorrespondence='';
    const graph=a.result?.info?.[f.id]?.loftConnections;body.dataset.graph=graph?.signature===JSON.stringify(f)?JSON.stringify(graph):'';
    const blocked=refs.some(r=>findFeature(a.doc,LR.sourceId(r))?.type!=='sketch')?'Manual connectors currently require sketch profiles.':null;
    const enabled=el('input',{type:'checkbox','data-loft-manual':''});enabled.checked=active;enabled.disabled=!!blocked&&!active;
    enabled.onchange=()=>{
      if(pm.loftDraft?.curves.length){a.toast('Add or clear the current contour before editing connectors',true);this.renderPM();return;}
      f.correspondenceMode=enabled.checked?'manual':'auto';pm.loftConnector=null;pm.loftEndSlot=null;pm.loftSlot='profiles';a.preview(true);a.updateSketchDisplay();
    };
    const label=el('label');label.append(enabled,document.createTextNode(' Edit profile connectors'));body.appendChild(this.row(null,label,'check'));
    if(blocked)body.appendChild(el('div',{class:'pm-hint'},blocked+' Choose Automatic correspondence to continue.'));
    if(active&&!blocked){
      body.appendChild(el('div',{class:'pm-hint'},'Drag a numbered connector endpoint onto another profile vertex, or use Pick start below. Moving one attachment shifts the cyclic correspondence of the whole contour. Circles also accept a seam angle. A start inside a curve adds a point to that profile there (to match another profile with one more).'+(f.thin?' Thin: each wall starts at its vertex nearest the start.':'')));
      refs.forEach((ref,i)=>{
        const source=a.result.sketches.get(LR.sourceId(ref)),control=LC.connectionFor(f,ref)||{};if(!source)return;
        const heading=el('div',{},`<b>${i+1}. ${esc(LR.describeRef(a.doc,ref))}</b>`);body.appendChild(heading);
        try{
          const options=LC.profileConnectionOptions(source.sketch,ref),pick=el('button',{class:'pm-btn'+(pm.loftConnector?.key===LR.refKey(ref)?' on':''),'data-loft-connector-pick':i,disabled:!options.circle&&!options.points.length,onclick:()=>a.activateLoftConnector(i)},'Pick start in canvas');body.appendChild(pick);
          if(options.circle){
            let angle=0;const p=graph?.signature===JSON.stringify(f)&&graph.sections[i]?.points[0];if(p){const q=G.toLocal(source.frame,source.frame.o.clone().fromArray(p));angle=Math.atan2(q.y-options.circle.c.y,q.x-options.circle.c.x)*180/Math.PI;}
            const input=this.exprInput(control.circle?control.angle??0:angle,'°',value=>{const next={...control,circle:options.circle.curve,angle:value};delete next.point;a.setLoftConnection(ref,next,false);});input.dataset.loftConnectorAngle=i;body.appendChild(this.row('Seam angle',input));
          }else{
            const select=el('select',{'data-loft-connector-point':i,'aria-label':'Profile start vertex'});select.appendChild(el('option',{value:''},'Automatic start'));
            for(const p of options.points)select.appendChild(el('option',{value:p.id},esc(SM.itemName(source.sketch,p.id))));
            if(options.curves.length&&!f.thin)select.appendChild(el('option',{value:'@curve'},'Inside a curve…'));
            select.value=control.curve?'@curve':control.point||'';
            select.onchange=()=>{const next={...control};delete next.point;delete next.curve;delete next.at;if(select.value==='@curve'){next.curve=options.curves[0];next.at=50;}else if(select.value){next.point=select.value;if(!options.closed)next.reverse=false;}a.setLoftConnection(ref,next);};body.appendChild(this.row('Start vertex',select));
            if(control.curve)this.loftCurveStart(body,options,source,control,next=>a.setLoftConnection(ref,next,false),i);
          }
          if(options.holes.length&&!f.thin)this.loftHoleControls(body,f,ref,i,options,source,control);
          const reverse=el('input',{type:'checkbox','data-loft-connector-reverse':i});reverse.checked=!!control.reverse;
          reverse.onchange=()=>{const next={...control,reverse:reverse.checked};if(!options.closed)delete next.point;a.setLoftConnection(ref,next);};
          const label=el('label');label.append(reverse,document.createTextNode(' Reverse traversal'));body.appendChild(this.row(null,label,'check'));
        }catch(e){body.appendChild(el('div',{class:'pm-hint'},esc(e.message)));}
        body.appendChild(el('button',{class:'pm-btn','data-loft-connector-auto':i,onclick:()=>a.setLoftConnection(ref,null)},'Automatic for this profile'));
      });
    }
    if(active||Object.keys(f.loftCorrespondence||{}).length)body.appendChild(el('button',{class:'pm-btn','data-loft-connector-reset':'',onclick:()=>{f.loftCorrespondence={};f.correspondenceMode='auto';pm.loftConnector=null;a.preview(true);a.updateSketchDisplay();}},'Reset all to Automatic'));
  }

  // A start inside a curve: which curve, and how far along it (percent, in the curve's own direction)
  loftCurveStart(body,options,source,control,set,i,label='Start'){
    const curve=el('select',{'data-loft-connector-curve':i,'aria-label':`${label} curve`});
    for(const id of options.curves)curve.appendChild(el('option',{value:id},esc(SM.itemName(source.sketch,id))));
    curve.value=control.curve;curve.onchange=()=>set({...control,curve:curve.value});body.appendChild(this.row(`${label} on`,curve));
    const at=this.exprInput(control.at??50,'%',value=>set({...control,at:value}));at.dataset.loftConnectorAt=i;body.appendChild(this.row('Along it',at));
  }

  // A profile's holes: which of its holes goes with each hole of the others (slot by slot), and where each starts
  loftHoleControls(body,f,ref,i,options,source,control){
    const a=this.app,keys=options.holes.map(h=>h.key),set=next=>a.setLoftConnection(ref,next);
    let order;try{order=LC.holeOrder(control,keys);}catch{order=keys.map((_,k)=>k);}
    const name=h=>esc(h.curves.length?SM.itemName(source.sketch,h.curves[0]):h.circle?SM.itemName(source.sketch,h.circle.curve):'Hole');
    order.forEach((hi,slot)=>{
      const sel=el('select',{'data-loft-hole-order':`${i}:${slot}`,'aria-label':`Hole ${slot+1}`});
      options.holes.forEach((h,k)=>sel.appendChild(el('option',{value:String(k)},`${name(h)}`)));sel.value=String(hi);
      sel.onchange=()=>{const next=[...order],k=+sel.value,j=next.indexOf(k);[next[slot],next[j]]=[next[j],next[slot]];set({...control,holeOrder:next.map(x=>keys[x])});};
      body.appendChild(this.row(`Hole ${slot+1}`,sel));
      const h=options.holes[hi],hc=control.holeStarts?.[h.key]||{},put=v=>{const starts={...(control.holeStarts||{})};if(v)starts[h.key]=v;else delete starts[h.key];set({...control,holeStarts:starts});};
      if(h.circle){const input=this.exprInput(hc.angle??0,'°',value=>put({circle:h.circle.curve,angle:value}));input.dataset.loftHoleAngle=`${i}:${slot}`;body.appendChild(this.row(`Hole ${slot+1} seam`,input));return;}
      const start=el('select',{'data-loft-hole-start':`${i}:${slot}`,'aria-label':`Hole ${slot+1} start`});start.appendChild(el('option',{value:''},'Automatic start'));
      for(const p of h.points)start.appendChild(el('option',{value:p.id},esc(SM.itemName(source.sketch,p.id))));
      if(h.curves.length)start.appendChild(el('option',{value:'@curve'},'Inside a curve…'));
      start.value=hc.curve?'@curve':hc.point||'';
      start.onchange=()=>put(start.value==='@curve'?{curve:h.curves[0],at:50}:start.value?{point:start.value}:null);
      body.appendChild(this.row(`Hole ${slot+1} start`,start));
      if(hc.curve)this.loftCurveStart(body,h,source,hc,v=>put(v),`${i}:${slot}`,`Hole ${slot+1} start`);
    });
  }

  renderLoftSelection(body, f, before, fd) {
    const a = this.app, pm = a.pm, key = fd.key, guide = key === 'guides';
    const extrude = f.type === 'extrude', planar = f.type === 'surfPlanar', common=['revolve','surfExtrude','surfRevolve'].includes(f.type), surface=['surfExtrude','surfRevolve'].includes(f.type);
    pm.loftSlot ||= 'profiles'; f[key] ||= [];
    const active = !pm.loftEndSlot && pm.loftSlot === key && (!extrude || pm.extrudePick !== false) && (!planar || !pm.planarEdges) && (!common || pm.profilePick!==false && !pm.planarEdges);
    body.appendChild(el('button', { class: 'pm-btn' + (active ? ' on' : ''), 'aria-pressed': String(active), disabled: guide && f.ruled, 'data-loft-slot': key, onclick: () => {
      pm.loftEndSlot = null; pm.loftEndAxis = null; pm.loftConnector=null; pm.scopePick=false; pm.loftSlot = key; pm.loftDraft = null; pm.loftHover = null;
      if (extrude) pm.extrudePick = !active;
      if (planar) pm.planarEdges = active;
      if (common) { pm.profilePick=!active; pm.revolveEndPick=false; pm.planarEdges=false; pm.extrudeSurfaceSlot=null; }
      this.renderPM(); a.updateSketchDisplay(); a.status(guide ? 'Click the guide curves in the canvas.' : 'Click the section contours or inside closed profiles in the canvas.');
    } }, guide ? 'Select guides in canvas' : 'Select profiles in canvas'));
    if (!guide) {
      const cb = el('input', { type: 'checkbox', 'data-loft-chain': '' }); cb.checked = pm.loftChain !== false;
      cb.onchange = () => { pm.loftChain = cb.checked; pm.loftDraft = null; pm.loftHover = null; this.renderPM(); a.updateSketchDisplay(); };
      const label = el('label'); label.append(cb, document.createTextNode(' Chain selection'));
      body.appendChild(this.row(null, label, 'check'));
    }
    body.appendChild(el('div', { class: 'pm-hint' }, common ? (surface?'Select open or closed contours, regions or individual sketch entities. Closed contours stay uncapped. For Revolve, select the axis separately.':f.type==='revolve'?'Select closed profiles or flat faces of the model, or enable Thin Feature for open contours. Select the revolution axis separately (for a model face: a reference axis, a model edge or face, or a sketch line).':'Select closed profiles or enable Thin Feature for open contours. Select the revolution axis separately.') : planar ? 'Click inside closed regions or select sketch contours. Turn off Chain selection to pick individual entities, then add the closed contour. Select model edges in the section below.' : extrude ? 'Click inside closed regions or select contours, or click a flat face of the model. Click again to remove a profile. Profiles must be coplanar; open contours enable Thin Feature. Turn off canvas profile selection to pick end references or bodies.' : guide ? f.ruled ? 'Guide curves require a smooth loft. Remove the guides or untick straight (ruled) sides.' : 'Pick guide curves or connected chains, including construction curves. Guides must meet every section.' : f.type === 'loft' ? 'Pick closed contours or click inside regions. Each selection adds one section.' : 'Pick open or closed contours. All sections must be open, or all closed.'));
    const ul = el('div', { class: 'pm-list', 'data-loft-list': key });
    if (!f[key].length) ul.appendChild(el('div', { class: 'li pm-hint' }, guide ? 'No guides selected' : 'No profiles selected'));
    f[key].forEach((ref, i) => {
      const li = el('div', { class: 'li sel' });
      li.appendChild(el('span', {}, `${i + 1}. ${LR.describeRef(a.doc, ref)}`));
      for (const [label, action] of (extrude || planar || common ? [['✕', 'remove']] : [['▲', 'up'], ['▼', 'down'], ['✕', 'remove']])) {
        const b = el('button', { class: 'pm-btn', title: action === 'up' ? 'Move up' : action === 'down' ? 'Move down' : 'Remove', 'data-loft-action': action, disabled: action === 'up' ? i === 0 : action === 'down' ? i === f[key].length - 1 : false }, label);
        b.onclick = () => {
          if (action === 'remove') f[key].splice(i, 1);
          else { const j = i + (action === 'up' ? -1 : 1); [f[key][i], f[key][j]] = [f[key][j], f[key][i]]; }
          pm.loftConnector=null;pm.loftHover = null; a.preview(true); a.updateSketchDisplay();
        };
        li.appendChild(b);
      }
      li.onpointerenter = () => { pm.loftHover = ref; a.updateSketchDisplay(); };
      li.onpointerleave = () => { pm.loftHover = null; a.updateSketchDisplay(); };
      ul.appendChild(li);
    });
    body.appendChild(ul);
    if (active && pm.loftChain === false) {
      const count = pm.loftDraft?.curves.length || 0;
      body.appendChild(el('div', { class: 'pm-hint' }, `Manual selection: ${count} curves. Click segments to add/remove them, then confirm this contour.`));
      body.appendChild(el('button', { class: 'pm-btn', 'data-loft-finish': '', disabled: !count, onclick: () => a.finishLoftSelection() }, 'Add selected contour'));
      if (count) body.appendChild(el('button', { class: 'pm-btn', onclick: () => { pm.loftDraft = null; this.renderPM(); a.updateSketchDisplay(); } }, 'Clear current selection'));
    }
    const details = el('details'), summary = el('summary', {}, 'Other sources (whole sketch / curve)'); details.appendChild(summary);
    const select = el('select', { 'data-loft-legacy': key, 'aria-label': guide ? 'Add a guide from a whole sketch or curve' : 'Add a profile from a whole sketch or curve' }); select.appendChild(el('option', { value: '' }, '+ Add source…'));
    const kinds = guide ? ['sketch', 'sketch3d', 'compCurve', 'projCurve', 'helix'] : fd.with3d ? ['sketch', 'sketch3d', 'compCurve', 'projCurve'] : ['sketch'];
    for (const source of before.filter((s) => kinds.includes(s.type) && !s.suppressed && !f[key].includes(s.id))) select.appendChild(el('option', { value: source.id }, esc(source.name)));
    select.onchange = () => { if (select.value) {
      if (extrude || planar || common) { f[key] = f[key].filter((r) => LR.sourceId(r) !== select.value); if (extrude && SM.isOpenSketch(findFeature(a.doc, select.value))) f.thin = true; }
      f[key].push(select.value); a.preview(true); a.updateSketchDisplay();
    } };
    details.appendChild(select); body.appendChild(details);
  }

  renderSketchList(body, f, before, fd = {}) {
    const a = this.app, doc = a.doc;
    if (!Array.isArray(f.profiles)) f.profiles = [];
    body.appendChild(el('div', { class: 'pm-hint' }, fd.hint || 'Two or more sketches with one closed profile each, in order. Click sketches in the tree or add them here. A circle is split to match the other profiles’ corners; other profiles must have the same number of segments.'));
    const ul = el('div', { class: 'pm-list' });
    if (!f.profiles.length) ul.appendChild(el('div', { class: 'li pm-hint' }, 'No profiles yet'));
    f.profiles.forEach((id, i) => {
      const sk = findFeature(doc, id);
      const li = el('div', { class: 'li sel' }, `${icon('sketch')}<span>${i + 1}. ${esc(sk?.name || '(missing)')}</span><span class="x" title="Move up">▲</span><span class="x" title="Remove">✕</span>`);
      const [up, x] = li.querySelectorAll('.x');
      up.onclick = () => { if (i > 0) { [f.profiles[i - 1], f.profiles[i]] = [f.profiles[i], f.profiles[i - 1]]; a.preview(true); } };
      x.onclick = () => { f.profiles.splice(i, 1); a.preview(true); };
      ul.appendChild(li);
    });
    body.appendChild(ul);
    const s = el('select');
    s.appendChild(el('option', { value: '' }, '+ Add a profile sketch…'));
    for (const x of before.filter((y) => (y.type === 'sketch' || (fd.with3d && ['sketch3d', 'compCurve', 'projCurve'].includes(y.type))) && !y.suppressed && !f.profiles.includes(y.id))) s.appendChild(el('option', { value: x.id }, esc(x.name)));
    s.onchange = () => { if (s.value) { f.profiles.push(s.value); a.preview(true); } };
    const w = el('div', { class: 'pm-input' }); w.appendChild(s);
    body.appendChild(w);
  }

  // Bodies (as they are before this feature) with tick boxes; they can also be clicked on the model.
  renderBodyList(body, f, fd) {
    const a = this.app;
    if(fd.key==='scope'&&['extrude','revolve','sweep'].includes(f.type))body.appendChild(el('button',{class:'pm-btn','data-feature-scope':'',onclick:()=>{a.pm.scopePick=true;a.pm.sweepCanvas=false;a.pm.profilePick=false;a.pm.extrudePick=false;this.renderPM();a.updateSketchDisplay();}},'Select target bodies in canvas'));
    if (!Array.isArray(f[fd.key])) f[fd.key] = [];
    const list = (a.result?.bodies || []).filter((b) => (fd.kinds.includes(b.kind) || (b.sheet && fd.kinds.includes('sheet'))) && !(fd.kinds.length === 1 && fd.kinds[0] === 'sheet' && !b.sheet) && (!fd.exclude || b.id !== f[fd.exclude]));
    if (fd.hint) body.appendChild(el('div', { class: 'pm-hint' }, esc(fd.hint)));
    const ul = el('div', { class: 'pm-list' });
    if (!list.length) ul.appendChild(el('div', { class: 'li pm-hint' }, `No ${fd.kinds.length === 1 && fd.kinds[0] === 'surface' ? 'surface' : 'solid'} bodies before this feature`));
    for (const b of list) {
      const on = f[fd.key].includes(b.id);
      const li = el('div', { class: 'li' + (on ? ' sel' : '') }, `<input type="checkbox" ${on ? 'checked' : ''} style="margin:0 4px 0 0">${icon(b.kind === 'surface' ? 'surfBody' : 'body')}<span>${esc(b.name)}</span>`);
      li.onclick = () => {
        const i = f[fd.key].indexOf(b.id);
        if (i >= 0) f[fd.key].splice(i, 1); else f[fd.key].push(b.id);
        this.renderPM(); a.updateEdgeHighlights(); a.preview();
      };
      li.onpointerenter = () => a.setHoverBody(b.id);
      li.onpointerleave = () => a.setHoverBody(null);
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }

  renderBodySel(body, f, fd) {
    const a = this.app;
    const list = (a.result?.bodies || []).filter((b) => (fd.kinds[0] === 'sheet' ? !!b.sheet : fd.kinds.includes(b.kind)));
    const s = el('select');
    s.appendChild(el('option', { value: '' }, esc(`— click a ${fd.kinds[0] === 'surface' ? 'surface' : fd.kinds[0] === 'sheet' ? 'sheet metal body' : 'body'} on the model —`)));
    for (const b of list) { const o = el('option', { value: b.id }, esc(b.name)); if (f[fd.key] === b.id) o.selected = true; s.appendChild(o); }
    s.onchange = () => { f[fd.key] = s.value || null; this.renderPM(); a.updateEdgeHighlights(); a.preview(); };
    const w = el('div', { class: 'pm-input' }); w.appendChild(s);
    body.appendChild(this.row(fd.label, w));
  }

  renderSplitTool(body, f, before) {
    const a = this.app;
    const opts = [['', f.toolFace ? '✔ Flat face picked on the model' : '— click a flat face on the model —'],
      ...Object.entries(STD_PLANES).map(([k, p]) => [k, p.name]),
      ...before.filter((x) => x.type === 'plane' && !x.suppressed).map((x) => [x.id, x.name]),
      ...(a.result?.bodies || []).filter((b) => b.kind === 'surface').map((b) => [b.id, 'Surface: ' + b.name])];
    const s = el('select');
    for (const [v, l] of opts) { const o = el('option', { value: v }, esc(l)); if ((f.tool || '') === v) o.selected = true; s.appendChild(o); }
    s.onchange = () => { f.tool = s.value || ''; if (f.tool) f.toolFace = null; this.renderPM(); a.updateEdgeHighlights(); a.preview(); };
    const w = el('div', { class: 'pm-input' }); w.appendChild(s);
    body.appendChild(this.row('Split with', w));
    body.appendChild(el('div', { class: 'pm-hint' }, 'A plane, a flat face of the model or a surface body that cuts through the bodies.'));
  }

  // Mates for Move/Copy Body: each ties an entity of the moving bodies to fixed geometry.
  renderMates(body, f) {
    const a = this.app, pm = a.pm, doc = a.doc;
    body.appendChild(el('div', { class: 'pm-hint' }, 'For each mate, pick an entity on a moving body and one on fixed geometry: a face, edge or vertex of another body, or a plane, axis or point (in the view or the tree).'));
    const name = (r) => {
      if (!r) return '— click to pick —';
      if (r.kind === 'plane') return STD_PLANES[r.id]?.name || findFeature(doc, r.id)?.name || 'Plane';
      if (r.kind === 'axis' || r.kind === 'point') return findFeature(doc, r.id)?.name || r.kind;
      return { face: r.n ? 'Face (flat)' : 'Face', edge: 'Edge', vertex: 'Vertex' }[r.kind];
    };
    f.mates.forEach((m, i) => {
      const box = el('div', { class: 'mate' });
      const head = el('div', { class: 'mate-h' });
      const sel = el('select');
      for (const [v, l] of [['coincident', 'Coincident'], ['distance', 'Distance'], ['parallel', 'Parallel'], ['perpendicular', 'Perpendicular'], ['angle', 'Angle'], ['concentric', 'Concentric']]) { const o = el('option', { value: v }, l); if (m.type === v) o.selected = true; sel.appendChild(o); }
      sel.onchange = () => { m.type = sel.value; this.renderPM(); a.preview(); };
      const del = el('button', { class: 'pm-btn', title: 'Delete mate', style: 'padding:0 7px' }, '✕');
      del.onclick = () => { f.mates.splice(i, 1); pm.mateSlot = null; this.renderPM(); a.updateEdgeHighlights(); a.preview(); };
      head.append(el('span', { class: 'mate-n' }, String(i + 1)), sel, del);
      box.appendChild(head);
      for (const which of ['a', 'b']) {
        const active = pm.mateSlot?.i === i && pm.mateSlot.which === which;
        const b = el('button', { class: 'slot' + (active ? ' active' : '') + (m[which] ? ' set' : '') }, `<span class="k">${which === 'a' ? 'Entity 1' : 'Entity 2'}</span><span>${esc(active ? '◉ picking — click on the model…' : name(m[which]))}</span>`);
        b.onclick = () => { pm.mateSlot = active ? null : { i, which }; this.renderPM(); a.updateEdgeHighlights(); };
        box.appendChild(b);
      }
      if (m.type === 'distance' || m.type === 'angle') box.appendChild(this.row(m.type === 'angle' ? 'Angle' : 'Distance', this.exprInput(m.value ?? 0, m.type === 'angle' ? '°' : 'mm', (v) => { m.value = v; a.preview(); })));
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!m.flip;
      cb.onchange = () => { m.flip = cb.checked; a.preview(true); };
      const lab = el('label', { class: 'mate-flip' });
      lab.append(cb, document.createTextNode(' Flip alignment'));
      box.appendChild(lab);
      body.appendChild(box);
    });
    const add = el('button', { class: 'pm-btn', style: 'width:100%;margin-top:4px' }, '+ Add mate');
    add.onclick = () => { f.mates.push({ type: 'coincident', a: null, b: null, value: 10, flip: false }); pm.mateSlot = { i: f.mates.length - 1, which: 'a' }; this.renderPM(); a.updateEdgeHighlights(); };
    body.appendChild(add);
  }

  // Sheet Metal Check: every bend of the sheet metal body (or each of them) and what may not make well.
  async showSheetCheck() {
    const a = this.app;
    const sheets = (a.result?.bodies || []).filter((b) => b.sheet);
    if (!sheets.length) { a.toast('There is no sheet metal body to check', true); return; }
    const one = a.sheetBodyFor?.();
    const list = one ? [one] : sheets;
    const box = el('div', { class: 'sm-check' });
    for (const b of list) {
      let r;
      try { r = await a.kernel.request('sheetCheck', { bodyId: b.id }); } catch (e) { box.appendChild(el('div', { class: 'pm-msg err' }, esc(`${b.name}: ${e.message}`))); continue; }
      const sec = el('div', { class: 'sm-check-body' });
      sec.appendChild(el('div', { class: 'sm-check-h' }, `<b>${esc(b.name)}</b> · t ${r.t} mm · K ${r.K} · ${r.bends.length} bend${r.bends.length === 1 ? '' : 's'}${r.holes ? ` · ${r.holes} hole${r.holes === 1 ? '' : 's'}` : ''}${r.forms ? ` · ${r.forms} form${r.forms === 1 ? '' : 's'}` : ''}${r.lofted ? ` · lofted (${r.lofted})` : ''}`));
      if (r.bends.length) {
        const f2 = (x) => (x == null ? '—' : +(+x).toFixed(2));
        const tbl = el('table', { class: 'sm-check-t' }, `<tr><th>Bend</th><th>Direction</th><th>Angle</th><th>Inside R</th><th>Length</th><th>Flange</th><th>Flange</th></tr>` + r.bends.map((x) => `<tr><td>B${x.n}</td><td>${x.up ? 'Up' : 'Down'}</td><td>${f2(x.ang)}°</td><td>${f2(x.R)}</td><td>${f2(x.w)}</td><td>${f2(x.flangeA)}</td><td>${f2(x.flangeB)}</td></tr>`).join(''));
        sec.appendChild(tbl);
      }
      sec.appendChild(r.warnings.length ? el('div', { class: 'pm-msg err' }, r.warnings.map(esc).join('<br>')) : el('div', { class: 'pm-msg ok' }, 'No problems found: every flange is at least 3 × t past its bend and no hole is within 2t + R of a bend.'));
      box.appendChild(sec);
    }
    box.appendChild(el('div', { class: 'pm-hint' }, 'Rules of thumb for press-brake bending: a flange needs about 3 × t of straight past the bend to sit on the V-die; a hole closer than 2t + R to a bend is pulled out of shape. Check them against your tooling.'));
    this.modal('Sheet Metal Check', 'sheetCheck', box, [{ label: 'Close', primary: true }]);
  }

  // Gauge: pick a material and thickness from the table (or your own) to set thickness, radius and K-factor.
  renderGauge(body, f) {
    const a = this.app;
    const mine = (this.prefs?.gauges || []).map((g) => ({ ...g, mat: 'Your gauges' }));
    const rows = [...mine, ...GAUGE_TABLES];
    const num = (v) => { try { return evaluate(String(v), a.result?.vars || {}); } catch { return NaN; } };
    const same = (g) => Math.abs(num(f.thickness) - g.t) < 1e-6 && Math.abs(num(f.radius) - g.R) < 1e-6 && Math.abs(num(f.kFactor) - g.K) < 1e-6;
    const cur = rows.find((g) => g.name === f.gauge && same(g)) || rows.find(same);
    const sel = el('select');
    sel.appendChild(el('option', { value: '' }, cur ? '— (custom values) —' : '— custom values —'));
    for (const mat of [...new Set(rows.map((g) => g.mat))]) {
      const og = el('optgroup', { label: mat });
      for (const g of rows.filter((x) => x.mat === mat)) {
        const o = el('option', { value: g.name }, esc(`${g.name.replace(mat + ' ', '')} — t ${g.t}, R ${g.R}, K ${g.K}`));
        if (cur && g.name === cur.name) o.selected = true;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    if (!cur) sel.value = '';
    sel.onchange = () => {
      const g = rows.find((x) => x.name === sel.value);
      if (!g) { f.gauge = null; return; }
      f.gauge = g.name;
      f.thickness = String(g.t);
      if ('radius' in f) f.radius = String(g.R);
      if ('useDefaultRadius' in f) f.useDefaultRadius = false;
      f.kFactor = String(g.K);
      this.renderPM();
      a.preview();
    };
    const row = el('div', { style: 'display:flex;gap:4px;align-items:center' });
    sel.style.flex = '1';
    sel.style.minWidth = '0';
    row.appendChild(sel);
    const save = el('button', { class: 'pm-btn', title: 'Save the thickness, radius and K-factor below as a gauge of your own' }, 'Save…');
    save.onclick = async () => {
      const t = num(f.thickness), R = num(f.radius ?? 0), K = num(f.kFactor);
      if (!(t > 0) || !(K >= 0)) { a.toast('Set the thickness and K-factor first', true); return; }
      const name = (await this.promptText('Save Gauge', 'gear', `A name for t ${t} mm, R ${R} mm, K ${K}:`, `My ${t} mm`))?.trim();
      if (!name) return;
      this.prefs ||= {};
      this.prefs.gauges = [...(this.prefs.gauges || []).filter((g) => g.name !== name), { name, t, R, K }];
      this.savePrefs();
      f.gauge = name;
      this.renderPM();
    };
    row.appendChild(save);
    body.appendChild(this.row('Gauge', row));
  }

  // 3D sketch points: X, Y, Z of each (expressions), removed with ✕; new points by a step along an axis
  // from the last one, or by clicking model vertices.
  renderPoints3d(body, f) {
    const a = this.app;
    f.pts ||= [];
    body.appendChild(el('div', { class: 'pm-hint' }, 'Type the coordinates (mm, from the origin), add a point a step along an axis from the last one, or click a vertex of the model to add a point there.'));
    const head = el('div', { style: 'display:flex;gap:4px;font-size:11px;color:#667;margin:2px 0 0 30px' }, '<span style="flex:1">X</span><span style="flex:1">Y</span><span style="flex:1">Z</span><span style="width:26px"></span>');
    body.appendChild(head);
    f.pts.forEach((p, i) => {
      const row = el('div', { style: 'display:flex;gap:4px;align-items:center;margin:2px 0' });
      row.appendChild(el('span', { style: 'width:26px;font-size:11px;color:#667' }, 'P' + (i + 1)));
      for (const k of ['x', 'y', 'z']) {
        const inp = this.exprInput(p[k] ?? 0, '', (v) => { p[k] = v; a.preview(); });
        inp.style.flex = '1';
        inp.style.minWidth = '0';
        row.appendChild(inp);
      }
      row.appendChild(el('button', { class: 'pm-btn', style: 'width:26px;padding:0', title: 'Remove this point', onclick: () => { f.pts.splice(i, 1); this.renderPM(); a.preview(); } }, '✕'));
      body.appendChild(row);
    });
    // a new point: a step along an axis from the last one
    const last = () => {
      const got = a.result?.detected?.get(f.id)?.pts;
      if (got?.length === f.pts.length && got.length) return got[got.length - 1];
      const q = f.pts[f.pts.length - 1];
      return q ? ['x', 'y', 'z'].map((k) => { try { return evaluate(String(q[k] ?? 0), a.result?.vars || {}); } catch { return 0; } }) : [0, 0, 0];
    };
    const stepRow = el('div', { style: 'display:flex;gap:4px;align-items:center;margin-top:6px' });
    stepRow.appendChild(el('span', { style: 'font-size:12px' }, 'Step'));
    const stepIn = this.exprInput(f.step ?? 100, 'mm', (v) => { f.step = v; });
    stepIn.style.flex = '1';
    stepRow.appendChild(stepIn);
    body.appendChild(stepRow);
    const btns = el('div', { style: 'display:grid;grid-template-columns:repeat(6,1fr);gap:3px;margin-top:4px' });
    for (const [lab, ax, sg] of [['+X', 0, 1], ['−X', 0, -1], ['+Y', 1, 1], ['−Y', 1, -1], ['+Z', 2, 1], ['−Z', 2, -1]]) {
      btns.appendChild(el('button', { class: 'pm-btn', style: 'padding:2px 0', title: `Add a point one step along ${lab} from the last point`, onclick: () => {
        let st = 100;
        try { st = evaluate(String(f.step ?? 100), a.result?.vars || {}); } catch { /* default */ }
        const q = [...last()];
        q[ax] += sg * st;
        const r6 = (x) => +x.toFixed(6);
        f.pts.push({ x: r6(q[0]), y: r6(q[1]), z: r6(q[2]) });
        this.renderPM();
        a.preview();
      } }, lab));
    }
    body.appendChild(btns);
  }

  renderEdgeList(body, f) {

    const a = this.app;
    f.edges ||= [];
    const n = f.edges.length;
    if(['surfFill','surfPlanar','surfExtrude','surfRevolve','sweep','surfSweep'].includes(f.type)){
      const label=el('label'),checkbox=el('input',{type:'checkbox','data-patch-chain':''});checkbox.checked=!!f.chainSelection;
      checkbox.onchange=()=>{f.chainSelection=checkbox.checked;this.renderPM();};
      label.append(checkbox,document.createTextNode(' Chain selection'));body.appendChild(this.row(null,label,'check'));
      body.appendChild(el('div',{class:'pm-hint'},'Chain selection follows connected boundary edges on the clicked body and stops at branches. Turn it off to pick individual edges. Existing edge continuity settings are preserved.'));
    }
    if(['surfPlanar','surfExtrude','surfRevolve','sweep','surfSweep'].includes(f.type))body.appendChild(el('button',{class:'pm-btn'+(a.pm.planarEdges?' on':''),'data-planar-edges':'',onclick:()=>{a.pm.planarEdges=true;a.pm.revolveEndPick=false;a.pm.extrudeSurfaceSlot=null;a.pm.sweepSupportPick=false;if(['sweep','surfSweep'].includes(f.type))a.pm.sweepCanvas=false;this.renderPM();a.updateSketchDisplay();a.updateEdgeHighlights();}},'Select model edges'));
    if(['sweep','surfSweep'].includes(f.type))body.appendChild(el('div',{class:'pm-hint'},'Instead of a sketch or curve, the path can be model edges joined end to end into one chain (it starts at the end in the profile’s plane).'));
    if(['surfExtrude','surfRevolve'].includes(f.type))body.appendChild(el('div',{class:'pm-hint'},'Model edges join end to end into open or closed chains (without branches); they are extruded or revolved with the contours.'));
    if (f.type === 'surfFill') body.appendChild(el('button', { class: 'pm-btn' + (!a.pm.patchSupportPick ? ' on' : ''), 'data-patch-edges': '', onclick: () => { a.pm.patchSupportPick = false; this.renderPM(); a.updateEdgeHighlights(); } }, 'Select boundary edges'));
    const sized = (f.type === 'fillet' && (f.filletType || 'constant') === 'constant') || (f.type === 'chamfer' && (f.chamferType || 'distance') === 'distance');
    if (f.type === 'fillet' || f.type === 'chamfer') body.appendChild(el('button', { class: 'pm-btn' + (a.pm.faceEdgesPick ? ' on' : ''), 'data-face-edges': '', onclick: () => { a.pm.faceEdgesPick = !a.pm.faceEdgesPick; this.renderPM(); a.status(a.pm.faceEdgesPick ? 'Click a face: all its edges are added (or removed when they are all in already).' : 'Click edges on the model.'); } }, 'Add a face’s edges'));
    body.appendChild(el('div', { class: 'pm-hint' }, 'Click edges on the model to add or remove them. The preview shows material removed in <b style="color:#c62828">red</b> and added in <b style="color:#a37f00">yellow</b>.' + (sized ? ' An edge can have a size of its own (leave it blank for the feature’s).' : '')));
    const ul = el('div', { class: 'pm-list' });
    if (!n) ul.appendChild(el('div', { class: 'li pm-hint' }, 'No edges selected'));
    f.edges.forEach((e, i) => {
      const li = el('div', { class: 'li' }, `${icon('edge')}<span>Edge&lt;${i + 1}&gt;</span><span class="x" title="Remove">✕</span>`);
      if(f.type==='surfFill')li.dataset.patchEdgeRow=i;
      if(sized){const own=this.exprInput(e.size??'','mm',value=>{if(value===''||value==null)delete e.size;else e.size=value;a.preview();});own.dataset.edgeSize=i;own.title='Own size (blank: the feature’s)';li.insertBefore(own,li.querySelector('.x'));}
      if(f.type==='surfFill'){
        const select=el('select',{'data-patch-edge':i,'aria-label':`Edge ${i+1} continuity`});
        for(const [value,label] of [['','Use boundary setting'],['G0','G0 Contact'],['G1','G1 Tangent'],['G2','G2 Curvature']]){
          const option=el('option',{value},label);option.selected=(e.continuity||'')===value;select.appendChild(option);
        }
        select.onchange=()=>{if(select.value)e.continuity=select.value;else delete e.continuity;this.renderPM();a.preview();};
        li.insertBefore(select,li.querySelector('.x'));
        if((e.continuity||f.continuity||(f.tangent?'G1':'G0'))==='G1'){const reach=this.exprInput(e.reach??0,'mm',value=>{e.reach=value;a.preview();});reach.dataset.patchEdgeReach=i;reach.title='Tangent reach';li.insertBefore(reach,li.querySelector('.x'));}
      }
      li.querySelector('.x').onclick = () => { f.edges.splice(i, 1); this.renderPM(); a.updateEdgeHighlights(); a.preview(); };
      li.onpointerenter = () => { a.hoverEdge = a.viewport.edgeIndexForPoint(e.p); a.updateEdgeHighlights(); };
      li.onpointerleave = () => { a.hoverEdge = null; a.updateEdgeHighlights(); };
      ul.appendChild(li);
    });
    body.appendChild(ul);
    const row = el('div', { style: 'display:flex;gap:6px;align-items:center' });
    row.appendChild(el('button', { class: 'pm-btn', onclick: () => { f.edges.length = 0; this.renderPM(); a.updateEdgeHighlights(); a.preview(); } }, 'Clear'));
    body.appendChild(row);
  }

  // Fix References: every feature that failed to rebuild, what went wrong, and the ways to fix it. A feature
  // whose picked edges / faces are no longer found can drop just those (keeping the others), be edited to pick
  // them again, or be suppressed. The list follows each rebuild while it is open.
  showFixReferences(focusId = null) {
    const a = this.app;
    if (a.mode === 'drawing' && a.drawing?.showBrokenMates) { a.drawing.showBrokenMates(); return; }
    if (a.mode === 'drawing' || !a.result) { a.toast('Open a part to see its feature errors', true); return; }
    this._fix?.close();
    const body = el('div', { class: 'fixrefs' });
    const what = (path) => {
      const key = String(path.find((k) => typeof k === 'string') || '');
      return /edge/i.test(key) ? 'edge' : /face/i.test(key) ? 'face' : /vert/i.test(key) ? 'vertex' : 'reference';
    };
    const render = () => {
      const errs = a.result?.errors || new Map();
      const feats = a.doc.features.filter((f) => errs.has(f.id));
      if (!feats.length) { body.innerHTML = '<p>Every feature rebuilds without errors.</p>'; return; }
      body.innerHTML = `<p class="pm-hint">${feats.length} feature${feats.length > 1 ? 's have' : ' has'} errors. Features below a failed one may fail only because of it: fix them from the top.</p>`;
      const tbl = el('table', { class: 'grid' });
      tbl.innerHTML = '<tr><th>Feature</th><th>Problem</th><th></th></tr>';
      for (const f of feats) {
        const miss = a.result.missing?.get(f.id) || [];
        const kinds = {};
        for (const p of miss) kinds[what(p)] = (kinds[what(p)] || 0) + 1;
        const lost = Object.entries(kinds).map(([k, n]) => `${n} ${k}${n > 1 ? (k === 'vertex' ? 'es' : 's') : ''}`).join(', ');
        const tr = el('tr');
        if (f.id === focusId) tr.className = 'focus';
        tr.innerHTML = `<td>${icon(iconFor(f))} ${esc(f.name)}</td><td>${esc(errs.get(f.id))}${lost ? `<div class="pm-hint">Not found in the model: ${esc(lost)}</div>` : ''}</td>`;
        const td = el('td', { class: 'fix-acts' });
        const btn = (label, title, fn) => { const b = el('button', { title }, esc(label)); b.onclick = fn; td.appendChild(b); };
        btn(f.type === 'sketch' ? 'Edit Sketch' : 'Edit', 'Open the feature to pick its references again', () => { this._fix?.close(); a.editFeature(f.id); });
        if (miss.some((p) => typeof p[p.length - 1] === 'number')) btn('Remove missing', 'Keep the references that are still found and drop the others', () => a.removeMissingRefs(f.id));
        btn(a.isSuppressed(f) ? 'Unsuppress' : 'Suppress', 'Leave the feature out of the model for now', () => a.toggleSuppress(f.id));
        tr.appendChild(td);
        tbl.appendChild(tr);
      }
      body.appendChild(tbl);
      tbl.querySelector('tr.focus')?.scrollIntoView({ block: 'nearest' });
    };
    render();
    const dlg = this.modal('Fix References', 'fix', body, [{ label: 'Close', primary: true }]);
    const close0 = dlg.close;
    this._fix = { render, close: () => { this._fix = null; close0(); } };
    // (closed with ✕, Escape or a click outside: forget it too)
    new MutationObserver((_, obs) => { if (!body.isConnected) { if (this._fix?.render === render) this._fix = null; obs.disconnect(); } }).observe($('#modal-root'), { childList: true });
  }
  refreshFixReferences() { this._fix?.render(); }

  showMassProps() {
    const a = this.app, geo = a.viewport.bodyGeo;
    if (!geo) { a.toast('There is no solid body to evaluate', true); return; }
    const whole = G.massProps(geo);
    const partMat = materialById(a.doc.material);
    // each body uses its own material, or the part material
    const solidsOnly = (a.result.bodies || []).filter((b) => b.kind !== 'surface');
    if (a.result.bodies?.length && !solidsOnly.length) { a.toast('There are only surface bodies; mass properties need a solid body', true); return; }
    const bodies = solidsOnly.length ? solidsOnly : [{ name: a.doc.name, material: partMat, index: -1 }];
    const rows = bodies.map((b) => {
      const mp = b.index >= 0 ? G.massProps(a.viewport.bodyInfo(b.index).geometry) : whole;
      const density = b.material ? b.material.density : 1.0;
      return { b, mp, mass: (mp.volume / 1000) * density };
    });
    const mass = rows.reduce((t, r) => t + r.mass, 0);
    const volume = rows.reduce((t, r) => t + r.mp.volume, 0);
    const area = rows.reduce((t, r) => t + r.mp.area, 0);
    const com = rows.reduce((c, r) => c.addScaledVector(r.mp.com, r.mass), whole.com.clone().set(0, 0, 0)).divideScalar(mass || 1);
    const mats = new Set(rows.map((r) => r.b.material?.id ?? null));
    const one = mats.size === 1 ? rows[0].b.material : undefined;
    const size = whole.bbox.getSize(new (whole.bbox.min.constructor)());
    const matRow = one !== undefined
      ? `<div class="k">Material</div><div>${one ? esc(one.name) : '<i>not specified</i> (using 1.00 g/cm³)'}</div><div class="k">Density</div><div>${fmt(one ? one.density : 1, 3)} g/cm³</div>`
      : `<div class="k">Material</div><div>Several (per body, see below)</div>`;
    const bodyTable = rows.length > 1 ? `<div class="bp-sec">Bodies</div><table class="grid"><tr><th>Body</th><th>Material</th><th>Volume (mm³)</th><th>Mass (g)</th></tr>${rows.map((r) => `<tr><td>${esc(r.b.name)}</td><td>${r.b.material ? esc(r.b.material.name) : '<i>not specified</i>'}${r.b.ownMaterial ? '' : ' <span class="pm-hint">(part)</span>'}</td><td class="num">${fmt(r.mp.volume, 2)}</td><td class="num">${fmt(r.mass, 2)}</td></tr>`).join('')}</table>` : '';
    const U = a.units, L = (x) => fmtLen(x, U);
    // (in the user's axes, wcs.js)
    const uc = W.toUser([com.x, com.y, com.z]), us = W.toUser([size.x, size.y, size.z]).map(Math.abs);
    const html = `
      <div class="kv">
        ${matRow}
        <div class="k">Mass</div><div><b>${fmt(mass, 2)} g</b>${U === 'in' ? ` (${fmt(mass / 453.59237, 4)} lb)` : ''}</div>
        <div class="k">Volume</div><div>${volWithUnit(volume, U, 2)}</div>
        <div class="k">Surface area</div><div>${areaWithUnit(area, U, 2)}</div>
        <div class="k">Center of mass</div><div>X ${L(uc[0])} &nbsp; Y ${L(uc[1])} &nbsp; Z ${L(uc[2])} ${U}</div>
        <div class="k">Bounding box</div><div>${L(us[0])} × ${L(us[1])} × ${L(us[2])} ${U}</div>
        <div class="k">Bodies</div><div>${rows.length}</div>
        <div class="k">Mesh triangles</div><div>${whole.triangles}</div>
      </div>${bodyTable}`;
    this.modal('Mass Properties', 'mass', html, [
      { label: 'Edit Material…', action: () => { setTimeout(() => this.showMaterial(), 0); } },
      { label: 'Close', primary: true },
    ]);
  }

  showMaterial() {
    const a = this.app;
    let chosen = a.doc.material;
    const wrap = el('div');
    const list = el('div', { class: 'pm-list', style: 'max-height:320px;min-width:340px' });
    const render = () => {
      list.innerHTML = '';
      for (const m of [{ id: null, name: '<not specified>', density: null, color: 0xc3cad4 }, ...MATERIALS]) {
        const li = el('div', { class: 'li' + (chosen === m.id ? ' sel' : '') },
          `<span style="width:14px;height:14px;border-radius:2px;border:1px solid #889;background:#${m.color.toString(16).padStart(6, '0')}"></span><span style="flex:1">${esc(m.name)}</span><span class="pm-hint">${m.density ? m.density + ' g/cm³' : ''}</span>`);
        li.onclick = () => { chosen = m.id; render(); };
        li.ondblclick = () => { chosen = m.id; apply(); dlg.close(); };
        list.appendChild(li);
      }
    };
    const apply = () => { a.doc.material = chosen; a.commit(); a.refresh(); };
    render();
    wrap.appendChild(list);
    if (a.result?.bodies?.some((b) => b.ownMaterial)) wrap.appendChild(el('p', { class: 'pm-hint', style: 'margin:8px 0 0' }, 'Bodies with their own material (set in Body Properties) keep it; all other bodies use this material.'));
    const dlg = this.modal('Part Material', 'material', wrap, [{ label: 'Apply', primary: true, action: apply }, { label: 'Cancel' }]);
  }

  // ---- Command search (Ctrl+K or /): type part of a command's name, Enter runs it. Every command of the menus
  // and toolbars of the document in front (part, sketch, assembly or drawing); the ones used lately first.
  commandList() {
    const a = this.app, out = [], seen = new Set();
    const add = (d, where) => {
      if (!d || d === 'sep' || typeof d.action !== 'function' || d.disabled) return;
      const label = String(d.label || '').replace(/…/g, '').replace(/^[●\u3000\s]+/, '').trim();
      if (!label) return;
      // (a menu's "Features ▸ Fillet" and the toolbar's "Fillet" are one command)
      const k = label.split('▸').pop().trim().toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      const own = Object.entries(this.shortcutPrefs()).find(([, v]) => v.k === k)?.[0];
      out.push({ label, where, icon: d.icon || '', key: own || d.key || '', action: d.action, k });
    };
    for (const [name, items] of Object.entries(this.menuDefs() || {})) for (const d of items || []) add(d, name + ' menu');
    let defs = {};
    try { defs = a.mode === 'drawing' && a.drawing ? a.drawing.commandDefs?.() || {} : this.commandDefs(); } catch { defs = {}; }
    const tabName = (t) => t.charAt(0).toUpperCase() + t.slice(1).replace(/([A-Z])/g, ' $1');
    for (const [tab, list] of Object.entries(defs)) for (const d of list || []) add(d, `${tabName(tab)} toolbar`);
    return out;
  }
  commandSearch() {
    document.querySelector('#cmd-search')?.remove();
    this.closeDropdown?.(); this.closeContext?.();
    const all = this.commandList();
    let recent = [];
    try { recent = JSON.parse(localStorage.getItem('razorcad.recentCommands') || '[]'); } catch { recent = []; }
    const back = el('div', { id: 'cmd-search' });
    const box = el('div', { class: 'cs-box' });
    const input = el('input', { type: 'text', spellcheck: 'false', placeholder: `Search ${all.length} commands…` });
    const list = el('div', { class: 'cs-list' });
    box.append(input, list);
    back.appendChild(box);
    document.body.appendChild(back);
    let shown = [], at = 0;
    const close = () => back.remove();
    const run = (c) => {
      close();
      try { localStorage.setItem('razorcad.recentCommands', JSON.stringify([c.k, ...recent.filter((x) => x !== c.k)].slice(0, 8))); } catch { /* no storage */ }
      this.app.macros?.note(c.label);
      setTimeout(() => c.action(), 0);
    };
    const find = (q) => {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return [...recent.map((k) => all.find((c) => c.k === k)).filter(Boolean), ...all.filter((c) => !recent.includes(c.k))].slice(0, 12);
      const scored = [];
      for (const c of all) {
        const name = tr(c.label).replace(/\u00ad/g, '').toLowerCase(), text = name + ' ' + c.label.toLowerCase() + ' ' + c.where.toLowerCase();
        if (!words.every((w) => text.includes(w))) continue;
        const q0 = words.join(' '), last = c.k;
        let s = last.startsWith(q0) ? 0 : name.startsWith(q0) ? 1 : words.every((w) => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(name)) ? 2 : 3;
        s += (recent.includes(c.k) ? -0.5 : 0) + name.length / 1000;
        scored.push([s, c]);
      }
      return scored.sort((x, y) => x[0] - y[0]).slice(0, 12).map((x) => x[1]);
    };
    const render = () => {
      shown = find(input.value);
      at = Math.min(at, Math.max(0, shown.length - 1));
      list.innerHTML = '';
      if (!shown.length) list.appendChild(el('div', { class: 'cs-none' }, 'No command found'));
      shown.forEach((c, i) => {
        const row = el('div', { class: 'cs-row' + (i === at ? ' on' : '') }, `<span class="cs-ic">${icon(c.icon)}</span><span class="cs-l">${esc(tr(c.label))}</span><span class="cs-w">${esc(c.where)}${c.key ? ` · ${esc(c.key)}` : ''}</span>`);
        row.onpointerdown = (e) => { e.preventDefault(); run(c); };
        row.onpointerenter = () => { at = i; list.querySelectorAll('.cs-row').forEach((r, j) => r.classList.toggle('on', j === at)); };
        list.appendChild(row);
      });
    };
    input.addEventListener('input', () => { at = 0; render(); });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); at = Math.min(shown.length - 1, at + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); at = Math.max(0, at - 1); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (shown[at]) run(shown[at]); }
    });
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
    render();
    input.focus();
  }

  // ---- Custom keyboard shortcuts: { "Ctrl+Shift+F": { k (the command, as the command search names it), label } }
  shortcutPrefs() { this.prefs ||= {}; return (this.prefs.shortcuts ||= {}); }
  // A key press with a shortcut of the user's own: its command run (when the document in front has it). true: used.
  runShortcut(e) {
    const map = this.prefs?.shortcuts;
    if (!map || !Object.keys(map).length) return false;
    const combo = comboOf(e), b = combo && map[combo];
    if (!b) return false;
    const c = this.commandList().find((x) => x.k === b.k);
    if (!c) { this.app.status(`${combo}: "${b.label}" is not available here.`); return true; }
    this.app.macros?.note(c.label);
    c.action();
    return true;
  }
  showShortcutEditor() {
    const map = this.shortcutPrefs();
    const cmds = this.commandList();
    // (commands with a shortcut that this kind of document doesn't have: listed too)
    for (const [combo, b] of Object.entries(map)) if (!cmds.some((c) => c.k === b.k)) cmds.push({ label: b.label, where: 'elsewhere', k: b.k, icon: '', missing: true, combo });
    const body = el('div', { class: 'sc-edit' });
    const filter = el('input', { type: 'text', placeholder: 'Filter commands…', spellcheck: 'false' });
    const msg = el('div', { class: 'pm-hint' }, 'Click Set, then press the keys (for example Ctrl+Shift+F, G or F6). Esc, Enter, Tab and Backspace stay as they are.');
    const list = el('div', { class: 'sc-list' });
    body.append(filter, msg, list);
    let waiting = null;
    const comboFor = (k) => Object.entries(map).find(([, v]) => v.k === k)?.[0] || '';
    const render = () => {
      const q = filter.value.toLowerCase().trim();
      list.innerHTML = '';
      const rows = cmds.filter((c) => !q || (c.label + ' ' + c.where).toLowerCase().includes(q)).sort((x, y) => (comboFor(y.k) ? 1 : 0) - (comboFor(x.k) ? 1 : 0) || x.label.localeCompare(y.label));
      for (const c of rows.slice(0, 300)) {
        const combo = comboFor(c.k);
        const row = el('div', { class: 'sc-row' }, `<span class="cs-ic">${icon(c.icon)}</span><span class="sc-l">${esc(c.label)}<small>${esc(c.where)}</small></span><span class="sc-k">${waiting === c.k ? '<i>press the keys…</i>' : esc(combo)}</span>`);
        const set = el('button', { class: 'pm-btn' }, waiting === c.k ? 'Cancel' : 'Set');
        set.onclick = () => { waiting = waiting === c.k ? null : c.k; render(); };
        row.appendChild(set);
        if (combo) { const x = el('button', { class: 'pm-btn', title: 'Remove this shortcut' }, '✕'); x.onclick = () => { delete map[combo]; this.savePrefs(); render(); }; row.appendChild(x); }
        list.appendChild(row);
      }
    };
    const onKey = (e) => {
      if (!waiting) return;
      const combo = comboOf(e);
      if (!combo) return;
      e.preventDefault(); e.stopPropagation();
      if (combo === 'Escape') { waiting = null; render(); return; }
      if (RESERVED_KEYS.has(combo)) { msg.textContent = `${combo} can't be a shortcut (it closes, accepts or moves between fields).`; return; }
      const c = cmds.find((x) => x.k === waiting);
      const old = map[combo];
      for (const [kk, v] of Object.entries(map)) if (v.k === waiting) delete map[kk];
      map[combo] = { k: c.k, label: c.label };
      this.savePrefs();
      msg.textContent = `${combo} → ${c.label}.` + (old && old.k !== c.k ? ` (It was ${old.label}'s.)` : '') + (BUILTIN_KEYS[combo] ? ` It takes the place of RazorCAD's own ${combo} (${BUILTIN_KEYS[combo]}).` : '');
      waiting = null;
      render();
    };
    document.addEventListener('keydown', onKey, true);
    filter.oninput = render;
    render();
    const dlg = this.modal('Keyboard Shortcuts: Customize', 'select', body, [
      { label: 'Remove All', action: () => { if (!Object.keys(map).length || !confirm('Remove all your own shortcuts?')) return false; for (const k of Object.keys(map)) delete map[k]; this.savePrefs(); render(); return false; } },
      { label: 'Close', primary: true },
    ]);
    // (the key catcher goes when the window does)
    new MutationObserver((_, obs) => { if (!body.isConnected) { document.removeEventListener('keydown', onKey, true); obs.disconnect(); } }).observe($('#modal-root'), { childList: true });
    setTimeout(() => filter.focus(), 0);
    void dlg;
  }

  // ---- Keyboard in the tree (feature tree, assembly tree, drawing tree): once the tree has been clicked, ↑ / ↓
  // move from row to row (selecting it, as a click does), ← closes a folder (or goes to the row it is in),
  // → opens it, Enter opens the item (as a double-click), Home / End go to the first / last row.
  initTreeKeys() {
    const root = $('#tree');
    if (!root || root.dataset.keys) return;
    root.dataset.keys = '1';
    root.tabIndex = 0;
    root.addEventListener('pointerdown', (e) => {
      if (e.target.closest('input, textarea, select')) return;
      const row = e.target.closest('.tn');
      if (row) {
        this._treeCursor = this.treeRows().indexOf(row);
        root.querySelectorAll('.tree-cursor').forEach((x) => x.classList.remove('tree-cursor'));
        row.classList.add('tree-cursor');
      }
      root.focus({ preventScroll: true });
    });
  }
  treeRows() { return [...$('#tree').querySelectorAll('.tn')].filter((r) => r.offsetParent !== null); }
  treeKey(e) {
    const rows = this.treeRows();
    if (!rows.length) return false;
    let i = rows.findIndex((r) => r.classList.contains('tree-cursor'));
    if (i < 0) i = rows.findIndex((r) => r.classList.contains('selected'));
    if (i < 0) i = Math.min(this._treeCursor ?? -1, rows.length - 1);
    const go = (j) => {
      j = Math.max(0, Math.min(rows.length - 1, j));
      this._treeCursor = j;
      rows[j].click();
      // (the click may draw the tree again: mark the row of that place in the new one)
      const now = this.treeRows(), r = now[Math.min(j, now.length - 1)];
      now.forEach((x) => x.classList.remove('tree-cursor'));
      r?.classList.add('tree-cursor');
      r?.scrollIntoView({ block: 'nearest' });
      // (and again if the tree is drawn once more just after)
      setTimeout(() => { const n2 = this.treeRows(); if (!n2.some((x) => x.classList.contains('tree-cursor'))) n2[Math.min(j, n2.length - 1)]?.classList.add('tree-cursor'); }, 40);
    };
    const twisty = (r) => r?.querySelector('.tw')?.textContent.trim();
    const indent = (r) => parseFloat(r.style.paddingLeft) || 0;
    switch (e.key) {
      case 'ArrowDown': go(i < 0 ? 0 : i + 1); return true;
      case 'ArrowUp': go(i < 0 ? rows.length - 1 : i - 1); return true;
      case 'Home': go(0); return true;
      case 'End': go(rows.length - 1); return true;
      case 'ArrowLeft': {
        if (i < 0) return true;
        if (twisty(rows[i]) === '▼') { rows[i].querySelector('.tw').click(); this.treeRows()[i]?.classList.add('tree-cursor'); return true; }
        for (let j = i - 1; j >= 0; j--) if (indent(rows[j]) < indent(rows[i])) { go(j); break; }
        return true;
      }
      case 'ArrowRight': {
        if (i < 0) return true;
        if (twisty(rows[i]) === '▶') { rows[i].querySelector('.tw').click(); this.treeRows()[i]?.classList.add('tree-cursor'); }
        else if (rows[i + 1] && indent(rows[i + 1]) > indent(rows[i])) go(i + 1);
        return true;
      }
      case 'Enter': if (i >= 0) rows[i].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true;
      default: return false;
    }
  }

  showShortcuts() {
    const own = Object.entries(this.prefs?.shortcuts || {});
    const rows = [
      ...own.map(([combo, b]) => [`${esc(b.label)} <small>(yours)</small>`, esc(combo)]),
      ['Search commands', 'Ctrl+K or /'],
      ['Move through the tree', 'Click the tree, then ↑ / ↓ · ← / → close / open folders · Enter opens · Home / End'],
      ['Rotate view (free, about the point under the cursor)', 'Middle-drag (or left-drag outside sketches)'], ['Pan', 'Shift + right-drag, or Ctrl + middle-drag'],
      ['Zoom', 'Mouse wheel (toward the cursor), or Shift + middle-drag'], ['Roll', 'Alt + middle-drag, or Alt + ←/→'],
      ['Rotate in steps', 'Arrow keys 15° · Shift + arrows 90°'], ['Pan in steps', 'Ctrl + arrow keys'],
      ['Zoom to fit', 'F'], ['Standard views', 'Ctrl+1 … Ctrl+7'], ['Normal to', 'Ctrl+8'],
      ['Undo / Redo', 'Ctrl+Z / Ctrl+Y'], ['Rebuild', 'Ctrl+B'], ['Save / Open / New', 'Ctrl+S / Ctrl+O / Ctrl+N'],
      ['Delete feature or entity', 'Delete'], ['Accept / Cancel Property panel', 'Enter / Esc'],
      ['Sketch tools (in sketch)', 'L line · R rectangle · C circle · A arc · N spline · P polygon · S select · D dims'],
      ['Sketch tool wheel (in sketch)', 'Hold the right mouse button (or drag with it), move toward a tool, release · a quick right click opens the menu'],
      ['Selection filters (part)', 'X faces · E edges · V vertices · B bodies · F5 clear'],
      ['Hide / show a body', 'Tab hides the body under the cursor · Shift+Tab shows the hidden body under the cursor'],
      ['Body properties / rename', 'Right-click a body in Solid Bodies (or on the model) · double-click to rename'],
      ['Edit a feature', 'Double-click it in the tree, or right-click ▸ Edit Feature'],
      ['Sketch on a face', 'Click a flat face, then Sketch (or right-click the face)'],
    ];
    const html = `<table class="grid">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;
    this.modal('Keyboard & Mouse', 'select', html, [{ label: 'Customize…', action: () => { setTimeout(() => this.showShortcutEditor(), 0); } }, { label: 'Close', primary: true }]);
  }

  // Windows file types: .rcad / .rasm / .rdrw opened by double-clicking them in Explorer.
  async showFileTypes() {
    let info = null;
    try { info = await platform.fileTypesInfo(); } catch { /* the browser version */ }
    const body = () => {
      const state = !info ? '<p class="pm-hint">This works in the desktop app (RazorCAD.exe).</p>'
        : info.current ? `<p>✔ <b>.rcad</b>, <b>.rasm</b> and <b>.rdrw</b> files open with this RazorCAD.${info.thumbnails ? '<br>✔ Explorer shows their previews.' : '<br>Explorer previews are not set up yet: click Register Again.'}</p>`
        : info.registered ? `<p>These files are set to open with another copy of RazorCAD:<br><code>${esc(info.registered)}</code></p>`
        : '<p>These file types are not registered with Windows yet.</p>';
      return `<p style="margin-top:0">RazorCAD saves parts as <b>.rcad</b>, assemblies as <b>.rasm</b> and drawings as <b>.rdrw</b>. Double-click one in Explorer to open it; when RazorCAD is already running it opens in a new tab there.</p>
        <p>Each file keeps a preview of the view (a drawing: its sheet) from when it was last saved. Explorer and the Open dialogs show it as the file's thumbnail once the file types are registered; files saved before this version show it after their next save.</p>
        ${state}
        <p class="pm-hint">Register makes them open with ${info?.exe ? `<code>${esc(info.exe)}</code>` : 'this RazorCAD.exe'} for your Windows user (the installer does this too). Instead, you can right-click a file ▸ Open with ▸ Choose another app, pick RazorCAD.exe and tick “Always”.</p>`;
    };
    const buttons = info?.exe ? [{
      label: info.current ? 'Register Again' : 'Register', primary: !info.current,
      action: () => {
        platform.registerFileTypes().then((r) => { info = r; this.app.toast('.rcad, .rasm and .rdrw files now open with RazorCAD'); })
          .catch((err) => this.app.toast('Could not register the file types: ' + (err?.message || err), true));
      },
    }, { label: 'Close', primary: !!info.current }] : [{ label: 'Close', primary: true }];
    this.modal('Open Files With RazorCAD', 'open', body(), buttons);
  }

  // ------------------------------------------------------------ New Drawing: set it up from a template
  // The standard templates and the user's own (Documents\RazorCAD\Templates, or browsed for), the drawing's
  // name, title block entries and first sheet (filled from the template, can be changed), and whether the
  // template becomes the default (chosen first next time). Resolves { template, name, props, sheet } or null.
  // change: { key, sheet } switches an existing drawing's template instead (its current template is
  // chosen first; only the sheet size, orientation and projection are asked): resolves { template, sheet }.
  async newDrawingSetup({ name = 'Drawing1', title = '', change = null } = {}) {
    const a = this.app;
    const prefs = (await platform.getPrefs().catch(() => ({}))) || {};
    const extra = Array.isArray(prefs.templatePaths) ? prefs.templatePaths : [];
    let mine = [], folder = null;
    try { const r = await platform.listTemplates(extra); mine = r?.templates || []; folder = r?.folder || null; } catch { /* none */ }
    // a user template's full content is read when it is chosen
    const loaded = new Map();
    const load = async (t) => {
      if (t.builtin) return t;
      if (loaded.has(t.path)) return loaded.get(t.path);
      const f = await platform.readTemplate(t.path);
      let doc = null;
      try { doc = f ? JSON.parse(f.content) : null; } catch { doc = null; }
      if (!isTemplate(doc)) throw new Error('That file is not a drawing template');
      doc.path = t.path;
      loaded.set(t.path, doc);
      return doc;
    };
    const keyOf = (t) => (t.builtin ? t.id : t.path);
    // a drawing's own template that isn't listed (browsed for elsewhere): listed while it is still there
    if (change?.key && !String(change.key).startsWith('builtin:') && !mine.some((t) => t.path === change.key)) {
      try {
        const f = await platform.readTemplate(change.key);
        const doc = f ? JSON.parse(f.content) : null;
        if (isTemplate(doc)) mine.push({ path: change.key, name: doc.name, description: doc.description, sheets: doc.sheets, thumb: doc.thumbnail });
      } catch { /* gone */ }
    }
    let current = null, chosenKey = change?.key || prefs.defaultDrawingTemplate || DEFAULT_TEMPLATE_ID;
    if (![...BUILTIN_TEMPLATES, ...mine].some((t) => keyOf(t) === chosenKey)) chosenKey = prefs.defaultDrawingTemplate || DEFAULT_TEMPLATE_ID;
    if (![...BUILTIN_TEMPLATES, ...mine].some((t) => keyOf(t) === chosenKey)) chosenKey = DEFAULT_TEMPLATE_ID;

    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const wrap = el('div', { class: 'nd' });
      const list = el('div', { class: 'nd-list' });
      const form = el('div', { class: 'nd-form' });
      wrap.append(list, form);
      form.innerHTML = `<div class="nd-tname"></div><div class="pm-hint nd-tdesc"></div>
        <div class="kv">
          <div class="k">Drawing name</div><div><input type="text" class="nd-name"></div>
          <div class="k">Title</div><div><input type="text" class="nd-title"></div>
          <div class="k">Drawing No.</div><div><input type="text" class="nd-number"></div>
          <div class="k">Drawn by</div><div><input type="text" class="nd-drawn"></div>
          <div class="k">Company</div><div><input type="text" class="nd-company"></div>
          <div class="k">Sheet size</div><div><select class="nd-size">${Object.keys(DW_SIZES).map((k) => `<option value="${k}">${k} (${DW_SIZES[k][0]} × ${DW_SIZES[k][1]} mm)</option>`).join('')}</select></div>
          <div class="k">Orientation</div><div><select class="nd-or"><option value="landscape">Landscape</option><option value="portrait">Portrait</option></select></div>
          <div class="k">Scale</div><div class="s-scale-row"><input type="number" class="nd-s1" min="0.001" step="any"> : <input type="number" class="nd-s2" min="0.001" step="any"></div>
          <div class="k">Projection</div><div><select class="nd-proj"><option value="first">First angle (ISO / Europe)</option><option value="third">Third angle (ANSI / USA)</option></select></div>
        </div>
        <label class="nd-def"><input type="checkbox" class="nd-default"> Use this template as my default</label>
        ${change ? '<div class="pm-hint">The drawing keeps its views, dimensions and title block entries. The template brings its sheet format, sheet size and projection (on every sheet), drawing settings and notes.</div>' : ''}`;
      const q = (c) => form.querySelector(c);
      // switching templates: only the sheet is asked
      if (change) {
        for (const c of ['.nd-name', '.nd-title', '.nd-number', '.nd-drawn', '.nd-company', '.nd-s1']) {
          const v = q(c).closest('div'), k = v.previousElementSibling;
          v.style.display = 'none'; if (k?.classList.contains('k')) k.style.display = 'none';
        }
        q('.nd-def').style.display = 'none';
      }
      q('.nd-name').value = name;
      q('.nd-title').value = title;
      const fill = (t) => {
        const s = t.sheets?.[0] || {};
        q('.nd-tname').textContent = t.name;
        q('.nd-tdesc').textContent = t.builtin ? templateSummary(t) : [t.description, templateSummary(t)].filter(Boolean).join(' — ');
        q('.nd-size').value = DW_SIZES[s.size] ? s.size : 'A3';
        q('.nd-or').value = s.orientation === 'portrait' ? 'portrait' : 'landscape';
        q('.nd-s1').value = s.scale?.[0] ?? 1;
        q('.nd-s2').value = s.scale?.[1] ?? 1;
        q('.nd-proj').value = s.projection === 'third' ? 'third' : 'first';
        // the template's standing entries (what was typed stays when the template has none)
        if (t.props?.drawnBy || !q('.nd-drawn').dataset.typed) q('.nd-drawn').value = t.props?.drawnBy || '';
        if (t.props?.company || !q('.nd-company').dataset.typed) q('.nd-company').value = t.props?.company || '';
        q('.nd-default').checked = keyOf(t) === (prefs.defaultDrawingTemplate || DEFAULT_TEMPLATE_ID);
      };
      for (const c of ['.nd-drawn', '.nd-company']) q(c).addEventListener('input', () => { q(c).dataset.typed = '1'; });
      const choose = async (t) => {
        try { current = await load(t); } catch (err) { a.toast(err.message, true); return; }
        chosenKey = keyOf(t);
        fill(current);
        list.querySelectorAll('.nd-item').forEach((n) => n.classList.toggle('active', n.dataset.key === chosenKey));
      };
      const item = (t) => {
        const isDefault = keyOf(t) === (prefs.defaultDrawingTemplate || DEFAULT_TEMPLATE_ID);
        const n = el('div', { class: 'nd-item', 'data-key': keyOf(t), title: t.path || t.description || '' },
          `${t.thumb ? `<img class="nd-thumb" src="${esc(t.thumb)}" alt="">` : `<span class="nd-thumb nd-noth">${icon(t.builtin ? 'sheetProps' : 'titleBlock')}</span>`}<span class="nd-t"><b>${esc(t.name)}${isDefault ? ' <span class="nd-badge">default</span>' : ''}</b><small>${esc(templateSummary(t))}</small></span>`);
        n.onclick = () => choose(t);
        n.ondblclick = () => { choose(t).then(() => create()); };
        return n;
      };
      const render = () => {
        list.innerHTML = '';
        list.appendChild(el('div', { class: 'bp-sec' }, 'My templates'));
        if (mine.length) for (const t of mine) list.appendChild(item(t));
        else list.appendChild(el('div', { class: 'pm-hint nd-empty' }, 'None yet. Set a drawing up the way you like it (sheet, title block, notes), then File ▸ Save as Template… adds it here.'));
        const row = el('div', { class: 'nd-row' });
        const browse = el('button', { class: 'pm-btn' }, 'Browse…');
        browse.onclick = async () => {
          const f = await platform.pickTemplate().catch(() => null);
          if (!f) return;
          let doc = null;
          try { doc = JSON.parse(f.content); } catch { doc = null; }
          if (!isTemplate(doc)) { a.toast('That file is not a drawing template (.rdrt)', true); return; }
          const t = { path: f.path || `browsed:${Date.now()}`, name: doc.name, description: doc.description, sheets: doc.sheets, thumb: doc.thumbnail };
          if (!mine.some((m) => m.path === t.path)) mine.push(t);
          loaded.set(t.path, { ...doc, path: t.path });
          if (f.path && !extra.includes(f.path)) { extra.push(f.path); platform.setPrefs({ ...prefs, templatePaths: extra }).catch(() => {}); prefs.templatePaths = extra; }
          render();
          choose(t);
        };
        row.appendChild(browse);
        if (folder) { const of = el('button', { class: 'pm-btn', title: folder }, 'Open Templates Folder'); of.onclick = () => platform.openTemplatesFolder(); row.appendChild(of); }
        list.appendChild(row);
        list.appendChild(el('div', { class: 'bp-sec' }, 'Standard templates'));
        for (const t of BUILTIN_TEMPLATES) list.appendChild(item(t));
        list.querySelectorAll('.nd-item').forEach((n) => n.classList.toggle('active', n.dataset.key === chosenKey));
      };
      const create = () => {
        if (!current) return false;
        if (change) {
          finish({ template: current, sheet: { size: q('.nd-size').value, orientation: q('.nd-or').value, projection: q('.nd-proj').value } });
          dlg.close();
          return true;
        }
        const s1 = +q('.nd-s1').value, s2 = +q('.nd-s2').value;
        if (!(s1 > 0 && s2 > 0)) { a.toast('Enter a scale like 1 : 2', true); return false; }
        const props = {};
        if (q('.nd-title').value.trim()) props.title = q('.nd-title').value.trim();
        if (q('.nd-number').value.trim()) props.number = q('.nd-number').value.trim();
        props.drawnBy = q('.nd-drawn').value.trim();
        props.company = q('.nd-company').value.trim();
        if (q('.nd-default').checked && prefs.defaultDrawingTemplate !== chosenKey) platform.setPrefs({ ...prefs, defaultDrawingTemplate: chosenKey }).catch(() => {});
        else if (!q('.nd-default').checked && prefs.defaultDrawingTemplate === chosenKey) { const p2 = { ...prefs }; delete p2.defaultDrawingTemplate; platform.setPrefs(p2).catch(() => {}); }
        finish({ template: current, name: q('.nd-name').value.trim() || name, props, sheet: { size: q('.nd-size').value, orientation: q('.nd-or').value, scale: [s1, s2], projection: q('.nd-proj').value } });
        dlg.close();
        return true;
      };
      const dlg = this.modal(change ? 'Change Template' : 'New Drawing', change ? 'titleBlock' : 'drawing', wrap, [
        { label: 'Cancel', action: () => finish(null) },
        { label: change ? 'Apply Template' : 'Create Drawing', primary: true, action: () => { create(); return false; } },
      ]);
      dlg.body.parentElement.classList.add('modal-wide');
      const obs = new MutationObserver(() => { if (!document.contains(dlg.body)) { obs.disconnect(); finish(null); } });
      obs.observe(document.getElementById('modal-root'), { childList: true });
      render();
      const first = [...BUILTIN_TEMPLATES, ...mine].find((t) => keyOf(t) === chosenKey) || BUILTIN_TEMPLATES[2];
      choose(first);
    });
  }

  // Updates: Help ▸ Check for Updates (manual: says what it found), and once a day at start (only when a newer
  // version is out, and not one the user chose to skip: a notice with Download / Later / Skip this version).
  async checkForUpdates(manual = false) {
    const a = this.app;
    let r = null;
    try { r = await platform.checkUpdate(manual); } catch (e) { r = { error: e.message }; }
    if (!manual) {
      if (!r?.newer || r.skipped) return;
      document.querySelector('#update-banner')?.remove();
      const b = el('div', { id: 'update-banner' }, `${icon('rebuild')}<span>RazorCAD <b>${esc(r.latest)}</b> is out (you have ${esc(r.current)}).</span>`);
      const btn = (label, fn, primary = false) => { const x = el('button', { class: primary ? 'primary' : '' }, esc(label)); x.onclick = () => { fn(); b.remove(); }; b.appendChild(x); };
      if (r.setup && r.installed) btn('Update Now', () => this.updateNow(r), true);
      else btn('Download', () => platform.openUrl(r.url), true);
      btn('Later', () => {});
      btn('Skip this version', () => platform.updateSettings({ skip: r.latest }));
      document.body.appendChild(b);
      return;
    }
    if (!platform.desktop) { a.toast('The update check is part of the desktop app (RazorCAD.exe)'); return; }
    const st = (await platform.updateSettings()) || { auto: true };
    const body = el('div');
    body.innerHTML = r?.error ? `<p>Could not reach GitHub to check: ${esc(r.error)}</p><p class="pm-hint">You have RazorCAD ${esc(r.current || '?')}.</p>`
      : r?.newer ? `<p><b>RazorCAD ${esc(r.latest)}</b> is out. You have ${esc(r.current)}.</p><p class="pm-hint">${esc(r.name || '')}${r.published ? ` — released ${esc(new Date(r.published).toLocaleDateString())}` : ''}. The download page lists what changed; run the new setup to update (your parts and settings stay).</p>`
      : `<p>You have the newest version: RazorCAD ${esc(r?.current || '?')}.</p>`;
    const auto = el('label', {}, `<input type="checkbox" ${st.auto !== false ? 'checked' : ''}> Check for updates when RazorCAD starts (once a day; only GitHub is asked)`);
    auto.querySelector('input').onchange = (e) => platform.updateSettings({ auto: e.target.checked });
    body.appendChild(auto);
    this.modal('Check for Updates', 'rebuild', body, [
      ...(r?.newer && r.setup && r.installed ? [{ label: 'Update Now', primary: true, action: () => { setTimeout(() => this.updateNow(r), 0); } }] : []),
      ...(r?.newer ? [{ label: 'Open the Download Page', primary: !(r.setup && r.installed), action: () => { platform.openUrl(r.url); } }] : []),
      { label: 'Close', primary: !r?.newer },
    ]);
  }

  // Update Now: the new setup downloaded (checked against the release) and run silently into this installation;
  // RazorCAD closes and starts again once it is installed. Unsaved work is saved first, or the update waits.
  async updateNow(r) {
    const a = this.app;
    if (a.dirtyTabs().length) {
      const c = await this.choose('Update RazorCAD', 'rebuild', '<p>Some parts, assemblies or drawings have unsaved changes. RazorCAD closes to update, so save them first.</p>', [['save', 'Save All and Update', true], ['cancel', 'Cancel']]);
      if (c !== 'save') return;
      const ok = await a.saveAll();
      if (!ok || a.dirtyTabs().length) { a.toast('Not everything was saved: the update waits', true); return; }
    }
    const res = await a.withProgress(`Downloading RazorCAD ${r.latest}…`, () => platform.startUpdate(r.setup)).catch((e) => ({ error: e.message }));
    if (!res?.ok) { a.toast(`${res?.error || 'The update could not start'}`, true); return; }
    a.status(`Installing RazorCAD ${r.latest}… RazorCAD restarts after the update is verified${res.allUsers ? ' (Windows asks for permission first)' : ''}.`);
    setTimeout(() => platform.closeApp(), 600);
  }

  // ---- Reporting a problem (opt-in): a crash report, or none, as a GitHub issue. The text is shown (and can be
  // edited) first, with personal details already taken out; the issue page then opens in the browser, filled in,
  // and nothing is sent unless it is submitted there.
  async reportProblemMenu() {
    const list = await platform.crashReports().catch(() => []);
    if (!list.length) return this.reportProblem('');
    const pick = await this.choose('Report a Problem', 'error', '<p>Report one of the crash reports RazorCAD kept, or a problem without one.</p>',
      [...list.slice(0, 6).map((r, i) => [r.name, `${(r.time || r.name).replace('T', ' ').slice(0, 16)} · ${r.kind}${r.message ? ': ' + r.message.slice(0, 50) : ''}`, i === 0]), ['', 'Without a crash report']]);
    if (pick === null) return;
    return this.reportProblem(pick);
  }
  async reportProblem(name = '') {
    const r = await platform.crashIssue(name).catch((e) => ({ error: e.message }));
    if (!r || r.error) { this.app.toast(r?.error || 'The report could not be read', true); return; }
    const box = el('div', { class: 'report-issue' });
    box.innerHTML = `<p class="pm-hint" style="margin-top:0">This opens a new issue on RazorCAD's GitHub page in your browser, filled in with the text below. Nothing is sent until you submit it there (with a GitHub account). Your user name and folders are taken out, and your part is not included. Read it, and add what you were doing.</p>
      <label class="pm-label">Title</label><input type="text" class="ri-title">
      <label class="pm-label" style="margin-top:6px">Text</label><textarea class="ri-body" spellcheck="false" data-own-escape></textarea>`;
    const ti = box.querySelector('.ri-title'), tb = box.querySelector('.ri-body');
    ti.value = r.title; tb.value = r.body;
    for (const x of [ti, tb]) x.addEventListener('keydown', (e) => e.stopPropagation());
    const url = () => {
      let body = tb.value;
      const make = () => 'https://github.com/Labs9119/RazorCAD/issues/new?' + new URLSearchParams({ title: ti.value.slice(0, 200), body }).toString();
      let u = make();
      while (u.length > 7000 && body.length > 500) { body = body.slice(0, Math.floor(body.length * 0.85)) + '\n\n(shortened)'; u = make(); }
      return u;
    };
    this.modal('Report a Problem', 'error', box, [
      { label: 'Open GitHub Issue', primary: true, action: () => { platform.openUrl(url()); platform.markCrashesSeen?.(); this.app.status('The issue page opened in your browser: submit it there to send the report.'); } },
      { label: 'Copy Text', action: () => { navigator.clipboard?.writeText(`${ti.value}\n\n${tb.value}`); this.app.status('Report copied.'); return false; } },
      { label: 'Cancel' },
    ]);
  }

  async showAbout() {
    const ver = (await platform.updateSettings().catch(() => null))?.version || '';
    this.modal('About RazorCAD', 'part', `
      <img class="about-mark" src="razorcad.svg" alt="">
      <p style="margin-top:0"><b>RazorCAD${ver ? ` ${esc(ver)}` : ''}</b> — a parametric 3D part, assembly and drawing modeler.</p>
      <p>History-based features, sketches with relations and equations, sheet metal, assemblies and 2D drawings, with STEP, STL and DXF import and export.</p>
      <p>RazorCAD is free software under the GNU General Public License v3.0 or later and comes with no warranty. Source code, the license and bug reports: github.com/Labs9119/RazorCAD</p>
      <p class="pm-hint">Geometry kernel: OpenCascade (via replicad, LGPL-2.1) · Display: three.js (MIT). See THIRD-PARTY-NOTICES.md.</p>`, [{ label: 'Close', primary: true }]);
  }
}
