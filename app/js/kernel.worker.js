// Geometry kernel worker: replays the feature history with OpenCascade (via
// replicad) and returns render meshes, exact edge data and solved sketches.
// The geometry library: replicad's multi-threaded build when this kernel may use threads (?threads=N, given by the
// app from the PC: machine.js) and the page is cross-origin isolated (shared memory), else the single-thread one.
const THREADS = Math.max(1, Math.min(64, Math.round(Number(new URL(self.location.href).searchParams.get('threads')) || 1)));
const MULTI = THREADS > 1 && !!self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
const KERNEL_BUILD = MULTI ? 'replicad_multi' : 'replicad_single';
import * as R from '../vendor/replicad/replicad.js';
import { evaluate, evalEquations } from './expr.js';
import * as S from './sketchmodel.js';
import * as LR from './loftrefs.js';
import { solveSketch } from './solver.js';
import { inferPlaneType, planeRefs } from './refgeom.js';
import { solveReferenceDatum, defaultReferenceRelations } from './refconstraints.js';
import {locateAlongPath,sketchPath,cadPath} from './pathlocation.js';
import * as LC from './loftcorrespondence.js';
import { threadList, minorDiameter, nearestThread } from './threads.js';
import * as SM from './sheetmetal.js';
import { holeSpec, holeProfile } from './holes.js';
import { asmPartFeatures } from './asmcuts.js';
import { profileDims, profileSection, piercePoint } from './profiles.js';
import { pipeOf, bundleDiameter } from './routing.js';
import { ductSpec, ductPatterns, lateral as ductLateral } from './ducts.js';
import { normalize3d, solve3d, splineGeom } from './sketch3dmodel.js';
import { decimate } from './meshdecimate.js';
import { installRealDelete, freeStats } from './ocfree.js';
import { compareSurfaceContinuity, surfaceNormalAtUV } from './surfacecontinuity.js';
import { guideScaleLaw } from './sweepguides.js';
import { sweepWithOrientation, scaleLaw } from './sweepoptions.js';
import * as SO from './sketchoffset.js';
import {extrusionInterval,revolutionInterval} from './featuredirections.js';
import {buildSurfacePatch,verifyPatch,patchContinuity,patchBoundary} from './surfacepatch.js';
import { hasLoftEnds, endConstrainedLoft, checkLoftEndGuides, tensorFaceDistance } from './loftends.js';

// sheet metal features (they keep a body's flat pattern up to date)
// sheet metal features that make new bodies (from sketches)
const SHEET_NEW = new Set(['smBase', 'smExtrude', 'smLoft', 'smTransition']);
const SHEET_TYPES = new Set(['smBase', 'smFlange', 'smCornerRelief', 'smClosedCorner', 'smUnfold', 'smFold', 'smConvert', 'smLoft', 'smTransition', 'smHem', 'smExtrude', 'smSketchBend', 'smJog', 'smCrossBreak', 'smTabSlot', 'smForm', 'smGusset', 'smProfileFlange']);

// Crash reports: keep enough of the call stack to see where a deep kernel recursion started.
Error.stackTraceLimit = 80;

// Kernel stack. When an OpenCascade error (a C++ exception) escapes a kernel call into JavaScript,
// the kernel's stack pointer is not put back: every failed fillet, boolean or shell attempt
// leaves it 32 bytes lower, and given enough failures it would run into the kernel's own data.
// No kernel code is running between requests, so the stack pointer is reset to its starting
// value around each request.
// If the kernel breaks anyway (it aborted, e.g. after a stack overflow deep inside OpenCascade),
// requests answer with `fatal` and the client replaces the worker; a broken kernel otherwise
// makes every feature fail and the bodies vanish until the program is restarted.
let stack = null;      // { get, set, top }
let stackLost = 0;     // bytes of kernel stack recovered so far (for crash reports)
let kernelDead = null; // why the kernel stopped (abort); the worker must then be replaced

// Stack functions: the module's explicitly exported ones first (RazorCAD's surface kernels export them), then the
// pair found by its code in the wasm (any build), then the legacy minified names. Each candidate is tested first.
// emscripten_stack_get_current / _emscripten_stack_restore: plain names in unminified builds,
// 'Ra' / 'Pa' in the bundled replicad_single.wasm, 'lb' / 'jb' in replicad_multi.wasm. Checked before use.
// The stack functions' export names, found by their code: emscripten_stack_get_current is `global.get G; end`,
// _emscripten_stack_restore `local.get 0; global.set G; end`, G the same global (the stack pointer). null if not found.
async function stackNamesFromWasm(url) {
  const b = await wasmBytes(url);
  let i = 8;
  const leb = () => { let r = 0, s = 0, x; do { x = b[i++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return r >>> 0; };
  const lebAt = (k) => { let r = 0, s = 0, x; do { x = b[k++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return [r >>> 0, k]; };
  let nImp = 0;
  const exports = new Map(); // function index → name
  const get = new Map(), set = new Map(); // global → name
  while (i < b.length) {
    const id = b[i++], size = leb(), end = i + size;
    if (id === 2) {
      for (let n = leb(); n--;) {
        for (let k = 0; k < 2; k++) { const ln = leb(); i += ln; } // (leb() moves i: read it first)
        const kind = b[i++];
        if (kind === 0) { leb(); nImp++; } else if (kind === 1) { i++; const fl = b[i++]; leb(); if (fl & 1) leb(); }
        else if (kind === 2) { const fl = b[i++]; leb(); if (fl & 1) leb(); } else if (kind === 3) i += 2; else if (kind === 4) { i++; leb(); }
      }
    } else if (id === 7) {
      for (let n = leb(); n--;) {
        const ln = leb(), name = new TextDecoder().decode(b.subarray(i, i + ln)); i += ln;
        const kind = b[i++], idx = leb();
        if (kind === 0) exports.set(idx, name);
      }
    } else if (id === 10) {
      const n = leb();
      for (let f = 0; f < n; f++) {
        const sz = leb(), start = i;
        i = start + sz;
        const name = exports.get(f + nImp);
        if (!name) continue;
        let [nl, k] = lebAt(start);
        for (; nl--;) { [, k] = lebAt(k); k++; }
        if (b[k] === 0x23) { const [g, k2] = lebAt(k + 1); if (k2 === i - 1 && b[k2] === 0x0b) get.set(g, name); }
        if (b[k] === 0x20 && b[k + 1] === 0x00 && b[k + 2] === 0x24) { const [g, k2] = lebAt(k + 3); if (k2 === i - 1 && b[k2] === 0x0b) set.set(g, name); }
      }
    }
    i = end;
  }
  for (const [g, name] of get) if (set.has(g)) return [name, set.get(g)];
  return null;
}
function findStackFns(x, oc, found = null) {
  const names = [...(found ? [found] : []), ['emscripten_stack_get_current', '_emscripten_stack_restore'], ...(MULTI ? [['lb', 'jb']] : [['Ra', 'Pa']])];
  const pairs = [[oc?._emscripten_stack_get_current, oc?.__emscripten_stack_restore], ...names.map(([g, s]) => [x[g], x[s]])];
  for (const [get, set] of pairs) {
    if (typeof get !== 'function' || typeof set !== 'function' || get.length !== 0 || set.length !== 1) continue;
    try {
      const sp = get();
      if (!Number.isInteger(sp) || sp <= 1024 || sp % 16 || get() !== sp) continue;
      set(sp - 16);
      const moved = get() === sp - 16;
      set(sp);
      if (moved && get() === sp) return { get, set, top: sp };
    } catch { /* not these */ }
  }
  console.warn('RazorCAD: kernel stack functions not found; the stack is not reset between requests');
  return null;
}

function resetStack() {
  if (!stack) return;
  const sp = stack.get();
  if (sp !== stack.top) { stackLost += stack.top - sp; stack.set(stack.top); }
}

// Errors after which the kernel can't be trusted any more (the worker is replaced).
function isFatal(e) {
  if (kernelDead) return true;
  if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) return true;
  const msg = String(e?.message || '');
  return /Maximum call stack|Aborted\(|memory access out of bounds|unreachable|table index is out of bounds|Out of memory/i.test(msg);
}

// (the browser version: ?k=<kernel signature>, the same for the kernel's script, so cached files of another version are never used)
const KERNEL_QUERY = (() => { const k = new URL(self.location.href).searchParams.get('k'); return k ? `?k=${encodeURIComponent(k)}` : ''; })();
const wasmUrl = new URL(`../vendor/replicad/${KERNEL_BUILD}.wasm${KERNEL_QUERY}`, import.meta.url);
// The kernel's wasm: the whole file, or, where the website's host limits a file's size, its parts name.part0,
// name.part1… joined (tools/build_web_app.py). Fetched once.
const wasmFetched = new Map();
function wasmBytes(url) {
  const key = String(url);
  if (!wasmFetched.has(key)) wasmFetched.set(key, (async () => {
    const r = await fetch(url);
    if (r.ok) return new Uint8Array(await r.arrayBuffer());
    const parts = [];
    for (let i = 0; ; i++) {
      const part = new URL(key); part.pathname += `.part${i}`;
      const p = await fetch(part);
      if (!p.ok) break;
      parts.push(new Uint8Array(await p.arrayBuffer()));
    }
    if (!parts.length) throw new Error(`The geometry kernel could not be loaded (${r.status})`);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  })());
  return wasmFetched.get(key);
}
// The browser version's kernel (?z): its wasm gzipped into one file, name.wasm.gz (tools/build_web_app.py), a third
// of the download; unpacked as it arrives and compiled while it downloads, its bytes kept too (stackNamesFromWasm).
const PACKED = new URL(self.location.href).searchParams.has('z');
const packedUrl = new URL(`../vendor/replicad/${KERNEL_BUILD}.wasm.gz${KERNEL_QUERY}`, import.meta.url);
async function packedWasm() {
  const r = await fetch(packedUrl);
  if (!r.ok) throw new Error(`The geometry kernel could not be loaded (${r.status})`);
  // (a host that sends it as Content-Encoding: gzip has the browser unpack it already)
  const reader = r.body.getReader(), first = await reader.read(), head = first.value || new Uint8Array(0);
  let body = new ReadableStream({
    start(c) { if (head.length) c.enqueue(head); if (first.done) c.close(); },
    async pull(c) { const { done, value } = await reader.read(); if (done) c.close(); else c.enqueue(value); },
    cancel(why) { return reader.cancel(why); },
  });
  if (head[0] === 0x1f && head[1] === 0x8b) body = body.pipeThrough(new DecompressionStream('gzip'));
  const [compile, keep] = body.tee();
  wasmFetched.set(String(wasmUrl), new Response(keep).arrayBuffer().then((b) => new Uint8Array(b)));
  return new Response(compile, { headers: { 'Content-Type': 'application/wasm' } });
}
let kernelThreads = 1; // (threads the kernel runs with: for the status and crash reports)
const ready = (async () => {
  let exportsOf = null;
  const Module = (await import(`../vendor/replicad/${KERNEL_BUILD}.js${KERNEL_QUERY}`)).default;
  const oc = await new Promise((resolve, reject) => {
    Module({
      ...(MULTI ? { razorcadThreads: THREADS } : {}),
      instantiateWasm(imports, done) {
        (PACKED ? packedWasm() : fetch(wasmUrl)).then((r) => WebAssembly.instantiateStreaming(r, imports))
          .catch(() => { if (PACKED) wasmFetched.delete(String(wasmUrl)); return wasmBytes(wasmUrl).then((b) => WebAssembly.instantiate(b, imports)); })
          .then((r) => { exportsOf = r.instance.exports; done(r.instance, r.module); }, reject);
        return {};
      },
      onAbort(what) { kernelDead = `the geometry kernel aborted${what ? ` (${what})` : ''}`; },
    }).then(resolve, reject);
  });
  stack = findStackFns(exportsOf, oc, await stackNamesFromWasm(wasmUrl).catch(() => null));
  // (type information and vtables are static data, below the stack)
  installRealDelete(oc, exportsOf, stack?.top ?? 12 * 1048576);
  R.setOC(oc);
  // (with threads: OpenCascade's booleans and the algorithms built on them split their work over the threads)
  if (MULTI) {
    try { oc.BOPAlgo_Options.SetParallelMode(true); kernelThreads = THREADS; } catch (e) { console.warn('RazorCAD: parallel mode not set', e); }
  }
})();

// Progress for long operations (value 0..1, or null when it can't be measured).
let quietProgress = 0; // > 0 while a helper rebuild runs (e.g. for a shell), which reports no progress
let progressFeature = null; // the feature being built (so a long one can be stopped and suppressed)
const progress = (value, label) => { if (!quietProgress) self.postMessage({ type: 'progress', value, label, feature: progressFeature }); };

// For highlighting a feature's faces: the solid before/after every feature of the last rebuild,
// one sample point per face of the final model, and the model size.
let lastFeatureDiffs = new Map();
let rebuildCache = null; // { eqKey, entries: [{ json, snap }] }: the state after each feature of the last rebuild
let lastSketchBodies = new Map();
let lastFacePts = [];
let lastDiag = 1;
let lastMeshTol = 0.01;

let lastBody = null;
let lastSolids = [];
let lastContext = new Set(); // (the ids of the context bodies in the last rebuild)
let lastSurfaces = [];
let lastName = 'Part';
const importCache = new Map();
// A body still exactly as a big STEP import made it (its shape: the one the import's splitting gave): the import's
// key in the store and its place there ({ key, k, kind }), so other kernels can mesh it from the store (meshHelped)
const importedFrom = new WeakMap();
const importReadMs = new Map(); // store key → how long reading the import's text takes (ms; the page has the text)

// ------------------------------------------------------------ vector helpers
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Sketch-plane frame for a plane through point p with normal n. The in-plane "up" axis
// follows world Y where possible, and the origin is the part origin projected onto the plane.
function frameOnPlane(p, n) {
  n = unit(n);
  const v = Math.abs(n[1]) > 0.999 ? [0, 0, -1] : unit([-n[0] * n[1], 1 - n[1] * n[1], -n[2] * n[1]]);
  const u = unit(cross(v, n));
  const o = mul(n, n[0] * p[0] + n[1] * p[1] + n[2] * p[2]);
  return { o, u, v, n };
}

// Line where two planes {p, n} meet.
function planeIntersection(A, B) {
  const d = cross(A.n, B.n);
  const h1 = A.n[0] * A.p[0] + A.n[1] * A.p[1] + A.n[2] * A.p[2];
  const h2 = B.n[0] * B.p[0] + B.n[1] * B.p[1] + B.n[2] * B.p[2];
  const n11 = 1, n22 = 1, n12 = A.n[0] * B.n[0] + A.n[1] * B.n[1] + A.n[2] * B.n[2];
  const det = n11 * n22 - n12 * n12;
  const c1 = (h1 * n22 - h2 * n12) / det, c2 = (h2 * n11 - h1 * n12) / det;
  return { o: [c1 * A.n[0] + c2 * B.n[0], c1 * A.n[1] + c2 * B.n[1], c1 * A.n[2] + c2 * B.n[2]], d: unit(d) };
}
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const vec = (v) => (Array.isArray(v) ? v : v.toTuple());

const STD = {
  front: { o: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
  top: { o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] },
  right: { o: [0, 0, 0], u: [0, 0, -1], v: [0, 1, 0], n: [1, 0, 0] },
};
// (the negative ones: a part shown Z up names its Y axis RazorCAD's −Z, see wcs.js)
const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], '-x': [-1, 0, 0], '-y': [0, -1, 0], '-z': [0, 0, -1] };
// the part's up axis as the user sees it (doc.upAxis): files are exported in those axes
let docUp = 'y';

const rPlane = (fr, origin = fr.o) => new R.Plane(origin, fr.u, fr.n);

// ------------------------------------------------------------ profiles
function loopDrawing(loop) {
  const segs = loop.segs;
  if (segs.length === 1 && segs[0].type === 'circle') return R.drawSingleCircle(segs[0].r).translate(segs[0].c[0], segs[0].c[1]);
  // arcs that together make a whole circle (e.g. after trimming and re-joining) are one circle too
  if (segs.length > 1 && segs.every((x) => x.type === 'arc')) {
    const c = arcCenter(segs[0]);
    if (c && segs.every((x) => { const k = arcCenter(x); return k && Math.hypot(k.c[0] - c.c[0], k.c[1] - c.c[1]) < 1e-7 * (1 + c.r) && Math.abs(k.r - c.r) < 1e-7 * (1 + c.r); }))
      return R.drawSingleCircle(c.r).translate(c.c[0], c.c[1]);
  }
  const pen = R.draw(segs[0].a);
  segs.forEach((s, i) => {
    const last = i === segs.length - 1;
    if (s.type === 'line') { if (!last) pen.lineTo(s.b); }
    else if (s.type === 'arc') pen.threePointsArcTo(s.b, s.m);
    else if (s.type === 'bezier') pen.cubicBezierCurveTo(s.b, s.c1, s.c2);
  });
  return pen.close();
}

// center and radius of an arc segment { a, m, b } (start, middle, end)
function arcCenter({ a, m, b }) {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, m2 = m[0] ** 2 + m[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2;
  const c = [(a2 * (m[1] - b[1]) + m2 * (b[1] - a[1]) + b2 * (a[1] - m[1])) / d, (a2 * (b[0] - m[0]) + m2 * (a[0] - b[0]) + b2 * (m[0] - a[0])) / d];
  return { c, r: Math.hypot(a[0] - c[0], a[1] - c[1]) };
}

// Merge faces that lie on the same surface (e.g. the halves of a cylinder) into one face.
function unify(shape) {
  try { return shape.simplify(); } catch { return shape; }
}

// Seam edges: where a closed surface (cylinder, cone, torus, sphere) meets itself. Such an
// edge appears twice in its own face's boundary. They are not drawn or picked.
function seamEdges(shape) {
  const oc = R.getOC();
  const T = oc.TopAbs_ShapeEnum;
  const seams = [];
  for (const face of shape.faces) {
    if (face.geomType === 'PLANE') continue;
    const seen = [];
    const ex = new oc.TopExp_Explorer(face.wrapped, T.TopAbs_EDGE, T.TopAbs_SHAPE);
    while (ex.More()) {
      const e = ex.Current();
      const i = seen.findIndex((x) => x.IsSame(e));
      if (i >= 0) seams.push(seen[i]); else seen.push(e);
      ex.Next();
    }
    ex.delete();
  }
  return seams;
}

function regionsDrawing(regions) {
  let all = null;
  for (const r of regions) {
    let d = loopDrawing(r.outer);
    for (const h of r.holes) d = d.cut(loopDrawing(h));
    all = all ? all.fuse(d) : d;
  }
  return all;
}

// ------------------------------------------------------------ body queries
// Shapes never change once made, so their bounding boxes (and the edge/face lists below) are cached.
const bboxCache = new WeakMap();
function bbox(shape) {
  let r = bboxCache.get(shape);
  if (!r && shape._parts) { r = bboxOfAll(shape._parts); bboxCache.set(shape, r); }
  if (!r) {
    const b = faceBoxUnion(shape) || shape.boundingBox.bounds;
    r = { min: b[0], max: b[1], center: mul(add(b[0], b[1]), 0.5), diag: len(sub(b[1], b[0])) };
    bboxCache.set(shape, r);
  }
  return r;
}
// The precise box of a shape made of faces, as the union of its faces' precise boxes, each kept with its face (a
// feature leaves most faces as they were, so only the new ones are worked out: OpenCascade's precise box of a whole
// big body takes a while). null for anything with loose edges or vertices (they are boxed the usual way).
function faceBoxUnion(shape) {
  const raw = shape.wrapped;
  if (hasLooseEdges(raw)) return null;
  const faces = exploreAll(raw, 'TopAbs_FACE');
  if (!faces.length) return null;
  labPrefetchBoxes(faces); // (Kernel Lab k5)
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  try {
    for (const f of faces) {
      const b = faceBox(f);
      if (b) for (let k = 0; k < 3; k++) { if (b[0][k] < min[k]) min[k] = b[0][k]; if (b[1][k] > max[k]) max[k] = b[1][k]; }
    }
  } finally { faces.forEach((f) => f.delete()); }
  return min[0] <= max[0] ? [min, max] : null;
}
// (edges outside any face, or vertices outside any edge)
function hasLooseEdges(raw) {
  const oc = R.getOC(), T = oc.TopAbs_ShapeEnum;
  for (const [t, avoid] of [['TopAbs_EDGE', 'TopAbs_FACE'], ['TopAbs_VERTEX', 'TopAbs_EDGE']]) {
    const ex = new oc.TopExp_Explorer(raw, T[t], T[avoid]);
    const loose = ex.More();
    ex.delete();
    if (loose) return true;
  }
  return false;
}
// (Kernel Lab k5) the precise boxes of the faces given that are not kept yet, from one kernel call, put where
// faceBox finds them (a face the kernel could not box is left to faceBox, as before)
const LAB_BOXES = (globalThis.LAB_BOXES = { calls: 0, faces: 0, ms: 0 });
function labPrefetchBoxes(faces) {
  const oc = R.getOC();
  if (!oc.LabShapeInfo?.faceBoxes || faces.length < 8) return;
  const miss = faces.filter((f) => keptFind(FACE_BOXES, f, 'box') === undefined);
  if (miss.length < 8) return;
  const t0 = performance.now();
  const builder = new oc.TopoDS_Builder(), comp = new oc.TopoDS_Compound();
  let raw = null;
  try {
    builder.MakeCompound(comp);
    for (const f of miss) builder.Add(comp, f);
    raw = oc.LabShapeInfo.faceBoxes(comp, true);
    const D = new Float64Array(oc.wasmMemory.buffer, raw.getDoublesPtr() >>> 0, raw.getDoublesSize());
    if (D.length !== miss.length * 7) return;
    miss.forEach((f, i) => {
      const k = D[i * 7];
      if (k < 0) return;
      const b = k ? [[D[i * 7 + 1], D[i * 7 + 2], D[i * 7 + 3]], [D[i * 7 + 4], D[i * 7 + 5], D[i * 7 + 6]]] : null;
      keptAdd(FACE_BOXES, f, 'box', b, (x) => oc.TopoDS.Face(x));
    });
  } finally {
    raw?.delete(); builder.delete(); comp.delete();
    LAB_BOXES.calls++; LAB_BOXES.faces += miss.length; LAB_BOXES.ms += performance.now() - t0;
  }
}
// a face's precise box ([min, max], null when empty), kept with the face
function faceBox(f) {
  let b = keptFind(FACE_BOXES, f, 'box');
  if (b !== undefined) return b;
  const oc = R.getOC(), bx = new oc.Bnd_Box();
  try {
    oc.BRepBndLib.AddOptimal(f, bx, false, false);
    if (bx.IsVoid()) b = null;
    else { const lo = bx.CornerMin(), hi = bx.CornerMax(); b = [[lo.X(), lo.Y(), lo.Z()], [hi.X(), hi.Y(), hi.Z()]]; lo.delete(); hi.delete(); }
  } finally { bx.delete(); }
  keptAdd(FACE_BOXES, f, 'box', b, (x) => oc.TopoDS.Face(x));
  return b;
}

// Smallest possible distance from point p to anything inside box (0 when p is inside).
function boxDist(box, p) {
  let s = 0;
  for (let i = 0; i < 3; i++) { const d = Math.max(box.min[i] - p[i], 0, p[i] - box.max[i]); s += d * d; }
  return Math.sqrt(s);
}

// Union of the boxes of several shapes.
function bboxOfAll(shapes) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const s of shapes) { const b = bbox(s); for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], b.min[i]); max[i] = Math.max(max[i], b.max[i]); } }
  return { min, max, center: mul(add(min, max), 0.5), diag: len(sub(max, min)) };
}
// The same box as bboxOfAll, worked out with less: each face's quick box first (it holds the face; OpenCascade's
// usual box), and the precise box only for the faces whose quick box reaches past the precise boxes found so far.
// The bodies' own boxes are left to be worked out when needed. (A big imported part, 342 bodies of 6642 faces:
// its size for meshing in about 0.1 s instead of 2.4 s.) The quick box is trusted to hold the face only for
// surfaces it is worked out exactly for (planes, cylinders, cones, spheres, tori, B-spline and Bezier patches);
// other faces get their precise box straight away.
function bboxOfAllQuick(shapes, fresh = false) {
  const oc = R.getOC(), ST = oc.GeomAbs_SurfaceType;
  const sure = new Set(['GeomAbs_Plane', 'GeomAbs_Cylinder', 'GeomAbs_Cone', 'GeomAbs_Sphere', 'GeomAbs_Torus', 'GeomAbs_BezierSurface', 'GeomAbs_BSplineSurface'].map((k) => ST[k]));
  const known = [], quick = []; // known: precise boxes; quick: { f, b } (a face and its quick box)
  const faces = [];
  const flat = (s) => ((!fresh && bboxCache.has(s)) || !s._parts ? [s] : s._parts.flatMap(flat));
  try {
    for (const s of shapes.flatMap(flat)) {
      const c = fresh ? null : bboxCache.get(s);
      if (c) { known.push([c.min, c.max]); continue; }
      const fs = hasLooseEdges(s.wrapped) ? [] : exploreAll(s.wrapped, 'TopAbs_FACE');
      if (!fs.length) { const b = bbox(s); known.push([b.min, b.max]); continue; }
      for (const f of fs) {
        faces.push(f);
        const kept = keptFind(FACE_BOXES, f, 'box');
        if (kept !== undefined) { if (kept) known.push(kept); continue; }
        let b = null;
        const fc = oc.TopoDS.Face(f), ad = new oc.BRepAdaptor_Surface(fc, false);
        const ok = sure.has(ad.GetType());
        ad.delete(); fc.delete();
        if (ok) {
          const bx = new oc.Bnd_Box();
          try {
            oc.BRepBndLib.Add(f, bx, false);
            if (!bx.IsVoid()) { const lo = bx.CornerMin(), hi = bx.CornerMax(); b = [[lo.X(), lo.Y(), lo.Z()], [hi.X(), hi.Y(), hi.Z()]]; lo.delete(); hi.delete(); }
          } finally { bx.delete(); }
        }
        if (b && b.flat().every(Number.isFinite)) quick.push({ f, b });
        else { const p = faceBox(f); if (p) known.push(p); }
      }
    }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const take = (b) => { for (let k = 0; k < 3; k++) { if (b[0][k] < min[k]) min[k] = b[0][k]; if (b[1][k] > max[k]) max[k] = b[1][k]; } };
    known.forEach(take);
    // each side in turn: the faces whose quick box reaches furthest, until none could reach past what is found
    for (let k = 0; k < 3; k++) {
      for (const hi of [false, true]) {
        const order = quick.filter((q) => !q.done).sort((a, b) => (hi ? b.b[1][k] - a.b[1][k] : a.b[0][k] - b.b[0][k]));
        for (const q of order) {
          if (hi ? q.b[1][k] <= max[k] : q.b[0][k] >= min[k]) break;
          q.done = true;
          const p = faceBox(q.f);
          if (p) take(p);
        }
      }
    }
    if (!(min[0] <= max[0])) return bboxOfAll(shapes);
    return { min, max, center: mul(add(min, max), 0.5), diag: len(sub(max, min)) };
  } finally { faces.forEach((f) => f.delete()); }
}

// ------------------------------------------------------------ solid bodies
// A part can hold several solid bodies. Each body keeps a stable id across rebuilds: the id
// of the feature that created it ("f3"; "f3.2" for a second body made by the same feature;
// "f3~2" for the smaller piece when a cut splits body f3). Body names and materials are
// stored in the document under these ids.
function solidsOf(shape) {
  if (!shape) return [];
  const list = shape.solids;
  if (list.length) return list;
  // no solid inside: an open (shell) STL import is kept as one body; an empty result is nothing
  return R.iterTopo(shape.wrapped, 'shell').next().done ? [] : [shape];
}

// All bodies as one shape. (replicad's makeCompound deletes its inputs; the bodies must stay alive.)
function compoundOf(list) {
  if (!list.length) return null;
  if (list.length === 1) return list[0].shape;
  const oc = R.getOC();
  const builder = new oc.TopoDS_Builder(), comp = new oc.TopoDS_Compound();
  builder.MakeCompound(comp);
  for (const b of list) builder.Add(comp, b.shape.wrapped);
  builder.delete();
  const c = R.cast(comp);
  c._parts = list.map((b) => b.shape); // per-body caches (edges, faces, meshes) stay valid
  return c;
}

// shape cut by several tools at once, given to Open CASCADE as a list (tools may overlap each other), the result
// simplified as replicad's cut does
function cutByList(shape, toolShapes) { return boolByList('cut', shape, toolShapes); }
// (the same for the material the tools have in common with the shape: kind 'common')
function boolByList(kind, shape, toolShapes) {
  const oc = R.getOC();
  const builder = kind === 'common' ? new oc.BRepAlgoAPI_Common() : new oc.BRepAlgoAPI_Cut(), args = new oc.NCollection_List_TopoDS_Shape(), tl = new oc.NCollection_List_TopoDS_Shape(), progress = new oc.Message_ProgressRange();
  try {
    args.Append(shape.wrapped);
    for (const t of toolShapes) tl.Append(t.wrapped);
    builder.SetArguments(args);
    builder.SetTools(tl);
    builder.Build(progress);
    if (!builder.IsDone()) throw new Error(kind === 'common' ? 'The intersection could not be made' : 'The cut could not be made');
    builder.SimplifyResult(true, true, 0.001);
    return R.cast(builder.Shape());
  } finally { builder.delete(); args.delete(); tl.delete(); progress.delete(); }
}

const LAB_SHEETS = (globalThis.LAB_SHEETS = { deferred: 0, refolds: 0, ms: 0 }); // (Kernel Lab: sheet metal folds put off / made)
const LAB_CUT_CHUNK = 8; // (Kernel Lab: features per chunk of waiting cuts)
function boxesTouch(a, b, tol) {
  for (let k = 0; k < 3; k++) if (a.min[k] > b.max[k] + tol || b.min[k] > a.max[k] + tol) return false;
  return true;
}

// A body's volume. With faces of free-form kinds (B-spline, Bezier, offset, swept: imported NURBS, IGES) by an
// adaptive integration to a small relative error, as the fixed rule the plain measure uses can be off by up to
// about 1% on rational B-spline faces; otherwise the plain (exact for planes, cylinders, cones…) measure.
const FREEFORM = new Set(['BSPLINE_SURFACE', 'BEZIER_SURFACE', 'OFFSET_SURFACE', 'REVOLUTION_SURFACE', 'EXTRUSION_SURFACE', 'OTHER_SURFACE']);
// (Kernel Lab) volumes and areas as shown (measuring, the cut list, the BOM's mass): adaptive integration to a
// relative error of eps (OpenCascade's default fixed rule can be percents off on trimmed faces). shapes: replicad
// shapes. [{ volume, area }] (NaN where it failed: the caller falls back).
function exactProps(shapes, eps = 1e-9) {
  const oc = R.getOC();
  if (!shapes.length) return [];
  if (oc.LabShapeInfo?.solidProps) {
    const builder = new oc.TopoDS_Builder(), comp = new oc.TopoDS_Compound();
    let raw = null;
    try {
      builder.MakeCompound(comp);
      for (const s of shapes) builder.Add(comp, s.wrapped);
      raw = oc.LabShapeInfo.solidProps(comp, eps, true);
      const D = new Float64Array(oc.wasmMemory.buffer, raw.getDoublesPtr() >>> 0, raw.getDoublesSize());
      if (D.length === shapes.length * 2) return shapes.map((s, i) => ({ volume: D[i * 2], area: D[i * 2 + 1] }));
    } finally { raw?.delete(); builder.delete(); comp.delete(); }
  }
  return shapes.map((s) => {
    const out = { volume: NaN, area: NaN };
    try { const p = new oc.GProp_GProps(); oc.BRepGProp.VolumePropertiesGK(s.wrapped, p, eps, false, true, false, false, false); out.volume = Math.abs(p.Mass()); p.delete(); } catch (e) { if (isFatal(e)) throw e; }
    try { const p = new oc.GProp_GProps(); oc.BRepGProp.SurfaceProperties(s.wrapped, p, eps, false); out.area = p.Mass(); p.delete(); } catch (e) { if (isFatal(e)) throw e; }
    return out;
  });
}
const finite = (x, fallback) => (Number.isFinite(x) ? x : fallback());
// (Kernel Lab) a face's exact area, as Measure shows it, kept with the face: worked out again for every measure of
// the face, it took 174 of 176 ms on a guided loft's B-spline patch
function faceArea(face) {
  let a = keptFind(FACE_AREAS, face.wrapped, 'area');
  if (a === undefined) {
    a = exactProps([face])[0]?.area;
    if (Number.isFinite(a)) keptAdd(FACE_AREAS, face.wrapped, 'area', a, (x) => R.getOC().TopoDS.Face(x));
  }
  return a;
}
function preciseVolume(shape) {
  let free = false;
  try { free = shape.faces.some((f) => FREEFORM.has(f.geomType)); } catch { free = false; }
  if (!free) return R.measureVolume(shape);
  try {
    const oc = R.getOC(), props = new oc.GProp_GProps();
    // (span by span: a B-spline face integrated as a whole made the adaptive rule refine endlessly at the joins
    // between its knot spans, e.g. 16 s for a sheet metal tray's closed corners; 0.1 s span by span, the same volume)
    oc.BRepGProp.VolumePropertiesGK(shape.wrapped, props, 1e-9, false, true, false, false, false);
    const v = props.Mass();
    props.delete();
    if (Number.isFinite(v) && v !== 0) return Math.abs(v);
  } catch { /* the plain measure */ }
  return R.measureVolume(shape);
}

// a body record's box: worked out when first asked for (also on a copy of a record, or one read back from the
// feature states kept between sessions)
function boxOf(rec) { return rec.box || (rec.box = bbox(rec.shape)); }
function volumeOf(rec) {
  if (rec.vol == null) { try { rec.vol = R.measureVolume(rec.shape); } catch { rec.vol = NaN; } }
  return rec.vol;
}

// ------------------------------------------------------------ persistent edge references
// An edge reference is { p: point on edge, t: curve type, d: line direction, box: body
// bounding box when last found }. Edges are re-found after the model changes by
// matching type/direction near the stored point, or near the point remapped into the
// new bounding box, and only accepted when the match is unambiguous.
const edgeInfoCache = new WeakMap();
// Edges of one body (kept per body, so an unchanged body is never enumerated again).
function edgeInfosOne(shape) {
  let info = edgeInfoCache.get(shape);
  if (!info) {
    // seams of closed surfaces are not real edges: never match (or fillet) them
    const seams = seamEdges(shape);
    info = shape.edges.filter((e) => !seams.some((x) => x.IsSame(e.wrapped))).map((e) => {
      const t = e.geomType;
      let d = null;
      if (t === 'LINE') { const v = vec(e.tangentAt(0.5)); const l = len(v) || 1; d = mul(v, 1 / l); }
      return { e, t, d, box: bbox(e), part: shape, circ: t === 'CIRCLE' ? circleOf(e) : null };
    });
    edgeInfoCache.set(shape, info);
  }
  return info;
}
function edgeInfos(body) {
  if (!body._parts) return edgeInfosOne(body);
  let info = edgeInfoCache.get(body);
  if (!info) { info = body._parts.flatMap(edgeInfosOne); edgeInfoCache.set(body, info); }
  return info;
}

function mapIntoBox(p, from, to) {
  return [0, 1, 2].map((i) => {
    const s0 = from.max[i] - from.min[i], s1 = to.max[i] - to.min[i];
    return s0 > 1e-9 ? to.min[i] + ((p[i] - from.min[i]) / s0) * s1 : p[i] + (to.min[i] - from.min[i]);
  });
}

// The nearest and second-nearest of `cands` (with .box and shapeOf(c)) to p. Candidates are
// tried nearest box first and the search stops once no box can beat the second best.
function nearestTwo(cands, p, shapeOf) {
  const list = cands.map((c) => [boxDist(c.box, p), c]).sort((a, b) => a[0] - b[0]);
  let q = null, best = null, bd = Infinity, second = Infinity;
  for (const [lb, c] of list) {
    if (lb > second) break;
    q ||= new R.DistanceQuery(R.makeVertex(p));
    const dd = q.distanceTo(shapeOf(c));
    if (dd < bd) { second = bd; bd = dd; best = c; } else if (dd < second) second = dd;
  }
  return { best, bd, second };
}

const findEdge = (body, ref) => findEdgeInfo(body, ref)?.e ?? null;

// What the reference searches found and missed while one feature is rebuilt (set by rebuild): references
// not found are reported (res.missing) so they can be fixed; when one was found again only by a looser
// search (it moved), the feature's references are written back so they follow the model from then on.
let refLog = null;
const refFound = (ref, hit, moved) => { if (refLog) { refLog.found.add(ref); if (moved) refLog.moved = true; } return hit; };
const refLost = (ref) => { if (refLog) refLog.lost.push(ref); return null; };

// The faces on the two sides of an edge, [{ t: surface type, n: outward normal (planes) }], and between
// two planes whether the edge is convex (an outside corner, cv: 1) or concave (an inside one, cv: -1): an
// edge reference keeps them (fn), so a moved edge is found again and a different one is not taken for it.
function sidesOf(shape, e) {
  const faces = adjacentFaces(shape, e);
  const out = faces.map((face) => (face.geomType === 'PLANE' ? { t: 'PLANE', n: unit(vec(face.normalAt())) } : { t: face.geomType }));
  if (out.length === 2 && out[0].n && out[1].n && Math.abs(dot(out[0].n, out[1].n)) < 0.999) {
    // (the other face's middle lies behind this face's plane at an outside corner)
    const m = vec(e.pointAt(0.5)), k = dot(sub(vec(faces[1].center), m), out[0].n);
    if (Math.abs(k) > 1e-9) out[0].cv = out[1].cv = k < 0 ? 1 : -1;
  }
  return out;
}
function edgeSides(c) {
  if (!c.sides) c.sides = sidesOf(c.part, c.e);
  return c.sides;
}
// The same kinds of faces on the sides (planes facing the same way, to within about 25°; the same corner)?
function sameSides(a, b) {
  if (a.length !== b.length) return false;
  if (a[0]?.cv && b[0]?.cv && a[0].cv !== b[0].cv) return false;
  const left = [...a];
  for (const s of b) {
    const i = left.findIndex((x) => x.t === s.t && (s.t !== 'PLANE' || !x.n || !s.n || dot(x.n, s.n) > 0.9));
    if (i < 0) return false;
    left.splice(i, 1);
  }
  return true;
}

// The edge a reference points at, with the body it belongs to (info.part).
function findEdgeInfo(body, ref) {
  if (!body) return null;
  const b = bbox(body);
  const candidates = edgeInfos(body).filter((c) => (!ref.t || c.t === ref.t) && (!ref.d || !c.d || Math.abs(dot(c.d, ref.d)) > 0.98));
  const search = (p) => nearestTwo(candidates, p, (c) => c.e);
  const tol = Math.max(0.05, b.diag * 0.15);
  const ok = (r) => r.best && r.bd < tol && (r.bd < 1e-3 || r.second > r.bd * 1.6);
  // (an edge found near, not at, the old place must have the same faces on its sides, when they are known)
  const fits = (c) => !Array.isArray(ref.fn) || sameSides(edgeSides(c), ref.fn);
  const raw = search(ref.p);
  if (raw.best && raw.bd < Math.max(1e-3, b.diag * 1e-4)) return refFound(ref, raw.best, false);
  const mapped = ref.box ? search(mapIntoBox(ref.p, ref.box, b)) : null;
  const choices = [raw, mapped].filter((r) => r && ok(r) && fits(r.best)).sort((x, y) => x.bd - y.bd);
  if (choices.length) return refFound(ref, choices[0].best, true);
  // a circular edge that moved further (e.g. a hole whose position changed): the one circle of the
  // same radius lying in the same plane as before
  if (ref.t === 'CIRCLE' && ref.r && ref.c && ref.n) {
    const tolR = Math.max(1e-6, ref.r * 1e-6), tolP = Math.max(1e-4, b.diag * 1e-6);
    const same = candidates.filter((c) => c.circ && Math.abs(c.circ.r - ref.r) < tolR && Math.abs(Math.abs(dot(c.circ.n, ref.n)) - 1) < 1e-6
      && Math.abs(dot(sub(c.circ.c, ref.c), ref.n)) < tolP);
    if (same.length === 1) return refFound(ref, same[0], true);
  }
  // an edge that moved further, or that other edges now lie nearer to: the edge of the same kind and
  // direction with the same faces on its sides that is clearly nearest its old place (remapped into the
  // model's new box)
  if (Array.isArray(ref.fn)) {
    const p = ref.box ? mapIntoBox(ref.p, ref.box, b) : ref.p;
    const near = candidates.map((c) => [boxDist(c.box, p), c]).sort((x, y) => x[0] - y[0]).slice(0, 80).map((x) => x[1]).filter(fits);
    if (near.length === 1 && candidates.length <= 80) return refFound(ref, near[0], true);
    const r = nearestTwo(near, p, (c) => c.e);
    if (r.best && r.second > r.bd * 1.6 + b.diag * 1e-6) return refFound(ref, r.best, true);
  }
  return refLost(ref);
}

// Radius, centre and normal of a circular edge.
function circleOf(e) {
  const oc = R.getOC();
  const ad = new oc.BRepAdaptor_Curve(e.wrapped);
  try {
    const c = ad.Circle(), L = c.Location(), D = c.Axis().Direction();
    return { r: c.Radius(), c: [L.X(), L.Y(), L.Z()], n: unit([D.X(), D.Y(), D.Z()]) };
  } catch { return null; } finally { ad.delete(); }
}

// Refresh a reference from the edge it was matched to.
function updateEdgeRef(ref, e, body) {
  const b = bbox(body);
  const was = ref.p;
  ref.p = vec(e.pointAt(0.5));
  // the faces on its sides (looked up when new or moved: it means going through the body's faces)
  if (!Array.isArray(ref.fn) || !was || len(sub(was, ref.p)) > 1e-6) ref.fn = sidesOf(body, e);
  ref.t = e.geomType;
  if (ref.t === 'LINE') { const v = vec(e.tangentAt(0.5)); const l = len(v) || 1; ref.d = mul(v, 1 / l); } else delete ref.d;
  // circles also remember radius, centre and plane, so they can be found again after a bigger move
  const circ = ref.t === 'CIRCLE' ? circleOf(e) : null;
  if (circ) Object.assign(ref, { r: circ.r, c: circ.c, n: circ.n }); else { delete ref.r; delete ref.c; delete ref.n; }
  ref.box = { min: b.min, max: b.max };
}

// ------------------------------------------------------------ persistent face references
// A planar face reference is { p: point on the face, n: normal, box }. Faces are re-found
// like edges: same orientation, nearest to the stored (or bounding-box-remapped) point.
const faceInfoCache = new WeakMap();
function faceInfosOne(shape) {
  let info = faceInfoCache.get(shape);
  if (!info) {
    info = [];
    for (const face of shape.faces) {
      if (face.geomType !== 'PLANE') continue;
      const n = vec(face.normalAt());
      info.push({ face, n: mul(n, 1 / (len(n) || 1)), box: bbox(face) });
    }
    faceInfoCache.set(shape, info);
  }
  return info;
}
function faceInfos(body) {
  if (!body._parts) return faceInfosOne(body);
  let info = faceInfoCache.get(body);
  if (!info) { info = body._parts.flatMap(faceInfosOne); faceInfoCache.set(body, info); }
  return info;
}

// All faces of a body with their boxes (cached per body).
const faceListCache = new WeakMap();
function facesWithBox(shape) {
  let l = faceListCache.get(shape);
  if (!l) {
    // (Kernel Lab: each face's precise box worked out when first asked for: findFaceAny needs few of them)
    l = shape._parts ? shape._parts.flatMap(facesWithBox) : shape.faces.map((face) => {
      const e = { face, quick: undefined, precise: undefined };
      Object.defineProperty(e, 'box', { get() { if (this.precise === undefined) this.precise = bbox(face); return this.precise; } });
      return e;
    });
    faceListCache.set(shape, l);
  }
  return l;
}
// (Kernel Lab) a face list entry's quick box: its precise box when known; else, for the surface kinds whose usual
// box holds the face (as bboxOfAllQuick), BRepBndLib::Add's; else the precise box
const LAB_QUICK_SURFS = new Map();
// (k10) the quick boxes of these face list entries not known yet, from one kernel call; a face of another surface
// kind is marked for its precise box, and one the kernel could not box is left to labQuickBox
function labPrefetchQuick(list) {
  const oc = R.getOC();
  if (!oc.LabShapeInfo?.quickBoxes) return;
  const miss = list.filter((e) => e.precise === undefined && e.quick === undefined && !e.notSure);
  if (miss.length < 8) return;
  const builder = new oc.TopoDS_Builder(), comp = new oc.TopoDS_Compound();
  let raw = null;
  try {
    builder.MakeCompound(comp);
    for (const e of miss) builder.Add(comp, e.face.wrapped);
    raw = oc.LabShapeInfo.quickBoxes(comp, true);
    const D = new Float64Array(oc.wasmMemory.buffer, raw.getDoublesPtr() >>> 0, raw.getDoublesSize());
    if (D.length !== miss.length * 7) return;
    miss.forEach((e, i) => {
      const k = D[i * 7];
      if (k === 2) { e.notSure = true; return; }
      if (k !== 1) return; // (void, or failed: as labQuickBox works it out)
      const b = { min: [D[i * 7 + 1], D[i * 7 + 2], D[i * 7 + 3]], max: [D[i * 7 + 4], D[i * 7 + 5], D[i * 7 + 6]] };
      if ([...b.min, ...b.max].every(Number.isFinite)) e.quick = b;
    });
  } finally { raw?.delete(); builder.delete(); comp.delete(); }
}
function labQuickBox(e) {
  if (e.precise !== undefined) return e.precise;
  if (e.quick !== undefined) return e.quick;
  if (e.notSure) return (e.quick = e.box);
  const oc = R.getOC(), f = e.face.wrapped;
  const kept = bboxCache.get(e.face) || keptFind(FACE_BOXES, f, 'box');
  if (kept !== undefined && kept !== null && !Array.isArray(kept)) return (e.quick = kept);
  if (Array.isArray(kept)) return (e.quick = { min: kept[0], max: kept[1] });
  let sure = LAB_QUICK_SURFS.get(oc);
  if (!sure) { const ST = oc.GeomAbs_SurfaceType; sure = new Set(['GeomAbs_Plane', 'GeomAbs_Cylinder', 'GeomAbs_Cone', 'GeomAbs_Sphere', 'GeomAbs_Torus', 'GeomAbs_BezierSurface', 'GeomAbs_BSplineSurface'].map((k) => ST[k])); LAB_QUICK_SURFS.set(oc, sure); }
  const fc = oc.TopoDS.Face(f), ad = new oc.BRepAdaptor_Surface(fc, false);
  const ok = sure.has(ad.GetType());
  ad.delete(); fc.delete();
  let b = null;
  if (ok) {
    const bx = new oc.Bnd_Box();
    try {
      oc.BRepBndLib.Add(f, bx, false);
      if (!bx.IsVoid()) { const lo = bx.CornerMin(), hi = bx.CornerMax(); b = { min: [lo.X(), lo.Y(), lo.Z()], max: [hi.X(), hi.Y(), hi.Z()] }; lo.delete(); hi.delete(); }
    } finally { bx.delete(); }
  }
  if (!b || ![...b.min, ...b.max].every(Number.isFinite)) return (e.quick = e.box);
  return (e.quick = b);
}

function findFace(body, ref) {
  if (!body) return null;
  const b = bbox(body);
  const cands = faceInfos(body).filter((c) => Math.abs(dot(c.n, ref.n)) > 0.999);
  const search = (p) => nearestTwo(cands, p, (c) => c.face);
  const tol = Math.max(0.05, b.diag * 0.15);
  const ok = (r) => r.best && r.bd < tol && (r.bd < 1e-3 || r.second > r.bd * 1.6);
  let hit = null, moved = false;
  const raw = search(ref.p);
  if (raw.best && raw.bd < 1e-3) hit = raw.best;
  else {
    moved = true;
    const mapped = ref.box ? search(mapIntoBox(ref.p, ref.box, b)) : null;
    const choices = [raw, mapped].filter((r) => r && ok(r)).sort((x, y) => x.bd - y.bd);
    if (choices.length) hit = choices[0].best;
    // further away: the only face facing that way, or the one clearly nearest the old place
    else if (cands.length === 1) hit = cands[0];
    else if (mapped?.best && mapped.bd < b.diag * 0.5 && mapped.second > mapped.bd * 2.5) hit = mapped.best;
  }
  if (!hit) return refLost(ref);
  refFound(ref, hit, moved);
  // a point on the found face's plane: project the reference point onto it
  const c = vec(hit.face.center);
  const p = add(ref.p, mul(hit.n, dot(sub(c, ref.p), hit.n)));
  ref.p = p;
  ref.n = hit.n;
  ref.box = { min: b.min, max: b.max };
  return { p, n: hit.n };
}

// ------------------------------------------------------------ meshes of bodies (cached per body)
const KERNEL_SESSION = Math.random().toString(36).slice(2, 10); // mesh keys from an earlier kernel never match
// cuts made together (rebuild's flushCuts), by the bodies and tools they were made of: their results, the latest few
const cutMemo = new Map();
const shapeIds = new WeakMap();
let shapeSeq = 0;
const shapeId = (s) => { let id = shapeIds.get(s); if (!id) { id = ++shapeSeq; shapeIds.set(s, id); } return id; };
const meshCache = new WeakMap();

// Mesh, edge polylines and face sample points of one body. A body with thousands of faces (a
// triangulated STL) is "dense": its faces/edges are not enumerated (the view draws mesh edges).
// How many faces a shape has (quick: no wrappers, no check for repeats).
function faceCount(shape) {
  const oc = R.getOC(), T = oc.TopAbs_ShapeEnum, ex = new oc.TopExp_Explorer(shape.wrapped, T.TopAbs_FACE, T.TopAbs_SHAPE);
  let n = 0;
  try { for (; ex.More(); ex.Next()) n++; } finally { ex.delete(); }
  return n;
}
// The display mesh of a body made of triangle faces (an imported mesh): each face's three corners, read
// straight off it. (Meshing tens of thousands of faces through the kernel runs it out of memory.) null when
// a face is not a triangle.
function triangleFacesMesh(shape) {
  const oc = R.getOC(), T = oc.TopAbs_ShapeEnum;
  const fx = new oc.TopExp_Explorer(shape.wrapped, T.TopAbs_FACE, T.TopAbs_SHAPE);
  const V = [], N = [], I = [], groups = [];
  try {
    for (let fi = 0; fx.More(); fx.Next(), fi++) {
      const face = fx.Current();
      const vx = new oc.TopExp_Explorer(face, T.TopAbs_VERTEX, T.TopAbs_SHAPE);
      const pts = [];
      try {
        for (; vx.More(); vx.Next()) {
          const p = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(vx.Current()));
          const q = [p.X(), p.Y(), p.Z()];
          p.delete();
          if (!pts.some((r) => r[0] === q[0] && r[1] === q[1] && r[2] === q[2])) pts.push(q);
          if (pts.length > 3) break;
        }
      } finally { vx.delete(); }
      if (pts.length !== 3) return null;
      // (its corners in the face's own turn: reversed faces turned round)
      if (face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) pts.reverse();
      const [a, b, c] = pts, n = unit(cross(sub(b, a), sub(c, a)));
      const base = V.length / 3;
      for (const q of pts) { V.push(q[0], q[1], q[2]); N.push(n[0], n[1], n[2]); }
      I.push(base, base + 1, base + 2);
      groups.push({ start: fi, count: 1, faceId: fi });
    }
  } finally { fx.delete(); }
  return { vertices: new Float32Array(V), normals: new Float32Array(N), triangles: new Uint32Array(I), faceGroups: groups };
}

// What a face is, for mates: { t: 'PLANE', p, n } (n the face's outward normal), { t: 'CYLINDER' | 'CONE', p, d, r }
// (a point on the axis, its direction), { t: 'SPHERE', p, r } or { t: 'OTHER' }.
// A flat face's centre of area by the plain integration (the faces' boundaries, with fixed Gauss points): the same
// centre as the adaptive one (face.center) to about 1e-8 mm, four times quicker (2 s → 0.5 s for a dust collector's
// 3081 flat faces); the adaptive one for a face of no area
function flatCentre(face) {
  const oc = R.getOC(), pr = new oc.GProp_GProps();
  try {
    oc.BRepGProp.SurfaceProperties(face.wrapped, pr, false, false);
    if (!(Math.abs(pr.Mass()) > 1e-12)) return vec(face.center);
    const c = pr.CentreOfMass(), out = [c.X(), c.Y(), c.Z()];
    c.delete();
    return out;
  } finally { pr.delete(); }
}
function surfOf(face) {
  const oc = R.getOC();
  let ad = null;
  try {
    const t = face.geomType;
    if (t === 'PLANE') return { t, p: flatCentre(face), n: unit(vec(face.normalAt())) };
    ad = new oc.BRepAdaptor_Surface(face.wrapped, true);
    const ax = (a) => { const L = a.Location(), D = a.Direction(); return { p: [L.X(), L.Y(), L.Z()], d: unit([D.X(), D.Y(), D.Z()]) }; };
    if (t === 'CYLINDER' || t === 'CYLINDRE') { const c = ad.Cylinder(); return { t: 'CYLINDER', ...ax(c.Axis()), r: c.Radius() }; }
    if (t === 'CONE') { const c = ad.Cone(); return { t, ...ax(c.Axis()), r: c.RefRadius() }; }
    if (t === 'TORUS') { const c = ad.Torus(); return { t, ...ax(c.Axis()), r: c.MajorRadius(), r2: c.MinorRadius() }; } // (Kernel Lab k8)
    if (t === 'SPHERE') { const c = ad.Sphere(), L = c.Location(); return { t, p: [L.X(), L.Y(), L.Z()], r: c.Radius() }; }
    return { t: 'OTHER' };
  } catch { return { t: 'OTHER' }; } finally { ad?.delete(); }
}

// ------------------------------------------------------------ meshing only what changed
// A feature usually leaves most of a body's faces and edges as they were: the same OpenCascade faces and edges,
// shared by the body before and after. Their triangles and edge points are kept (by the face or edge itself:
// the same one, in the same place, the same way round), and only the new ones are meshed and sampled.
// replicad's mesh extractor meshes every face again each time, which on a big body (a golf ball: 114 000
// triangles) takes over a second. Kept for the faces and edges of the last few bodies meshed.
const FACE_MESHES = new Map(), EDGE_POINTS = new Map(), FACE_BOXES = new Map(), FACE_AREAS = new Map(); // hash → [{ shape, key, data, used }]
let meshGen = 0;
const KEEP_GENS = 6, KEEP_MAX = 60000;
const hashOf = (raw) => R.getOC().ReplicadShapeHasher.HashCode(raw, R.HASH_CODE_MAX);
function keptFind(store, raw, key) {
  const list = store.get(hashOf(raw));
  const hit = list?.find((x) => x.key === key && x.shape.IsEqual(raw));
  if (hit) hit.used = meshGen;
  return hit ? hit.data : undefined;
}
function keptAdd(store, raw, key, data, copy) {
  const h = hashOf(raw);
  if (!store.has(h)) store.set(h, []);
  store.get(h).push({ shape: copy(raw), key, data, used: meshGen });
}
// (what was not used in the last few meshings let go)
function keptPrune(store) {
  let n = 0;
  for (const [h, list] of store) {
    const keep = list.filter((x) => meshGen - x.used < KEEP_GENS);
    for (const x of list) if (!keep.includes(x)) x.shape.delete();
    if (keep.length) store.set(h, keep); else store.delete(h);
    n += keep.length;
  }
  if (n > KEEP_MAX) { for (const list of store.values()) for (const x of list) x.shape.delete(); store.clear(); }
}
// A body's mesh as replicad's mesh() gives it ({ vertices, normals, triangles, faceGroups }), its faces in the
// same order, with the faces met before taken from what was kept.
function meshKept(shape, tol, ang) {
  const oc = R.getOC(), T = oc.TopAbs_ShapeEnum, key = `${tol}|${ang}`;
  const faces = exploreAll(shape.wrapped, 'TopAbs_FACE');
  try {
    const per = faces.map((f) => keptFind(FACE_MESHES, f, key) || null);
    const missing = faces.filter((_, i) => !per[i]);
    // (the new faces meshed together, as one compound)
    let gsNew = null;
    if (missing.length) {
      const builder = new oc.TopoDS_Builder(), comp = new oc.TopoDS_Compound();
      let m, byId;
      const X = LAB_PREMESHED && LAB_EXTRACTED;
      if (X && missing.every((f) => X.byId.has(hashOf(f)))) {
        // (Kernel Lab) from the rebuild's one extraction
        builder.delete(); comp.delete();
        m = X.m; byId = X.byId; gsNew = X.gs;
      } else {
        try {
          builder.MakeCompound(comp);
          for (const f of missing) builder.Add(comp, f);
          m = LAB_PREMESHED ? labExtract(comp) : R.cast(comp).mesh({ tolerance: tol, angularTolerance: ang });
        } finally { builder.delete(); }
        const total = m.faceGroups.reduce((n, g) => n + g.count, 0);
        gsNew = total === m.triangles.length ? 1 : 3;
        byId = new Map(m.faceGroups.map((g) => [g.faceId, g]));
      }
      for (const f of missing) {
        const g = byId.get(hashOf(f));
        let data = { vertices: [], normals: [], triangles: [], gs: gsNew };
        if (g) {
          const t0 = g.start * gsNew, t1 = (g.start + g.count) * gsNew;
          let lo = Infinity, hi = -1;
          for (let k = t0; k < t1; k++) { const v = m.triangles[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
          if (hi >= lo) data = { vertices: m.vertices.slice(lo * 3, hi * 3 + 3), normals: m.normals.slice(lo * 3, hi * 3 + 3), triangles: m.triangles.slice(t0, t1).map((v) => v - lo), gs: gsNew };
        }
        per[faces.indexOf(f)] = data;
        keptAdd(FACE_MESHES, f, key, data, (x) => oc.TopoDS.Face(x));
      }
    }
    // (the faces one after another, as the extractor lists them)
    const gs = gsNew ?? per.find(Boolean)?.gs ?? 1;
    // (Kernel Lab: arrays sized once, filled by block copies)
    let nv = 0, nn = 0, nt = 0;
    for (const d of per) { nv += d.vertices.length; nn += d.normals.length; nt += d.triangles.length; }
    const out = { vertices: new Float32Array(nv), normals: new Float32Array(nn), triangles: new Uint32Array(nt), faceGroups: [] };
    let ov = 0, on = 0, ot = 0;
    faces.forEach((f, i) => {
      const d = per[i], base = ov / 3, start = ot;
      out.vertices.set(d.vertices, ov); out.normals.set(d.normals, on);
      const T = d.triangles, n = T.length;
      for (let k = 0; k < n; k++) out.triangles[ot + k] = T[k] + base;
      ov += d.vertices.length; on += d.normals.length; ot += n;
      if (n) out.faceGroups.push({ start: start / gs, count: n / gs, faceId: hashOf(f) });
    });
    return out;
  } finally { faces.forEach((f) => f.delete()); }
}
// (Kernel Lab 3b) premeshing: true while the rebuild's bodies are meshed after labPremesh made their triangles
let LAB_PREMESHED = false;
// (Kernel Lab) the extraction of all the faces premeshed: { m, byId: faceId → face group, gs }, or null
let LAB_EXTRACTED = null;
const LAB_MESH = (globalThis.LAB_MESH = { calls: 0, faces: 0, meshMs: 0, extractMs: 0, brepMs: 0, infoMs: 0, infoBodies: 0 });
function labPremesh(parts, tol, diagQ, ang) {
  const oc = R.getOC();
  if (!oc.LabMeshExtractor) return false;
  const t0 = performance.now(), key = `${tol}|${ang}`;
  const builder = new oc.TopoDS_Builder(), comp = new oc.TopoDS_Compound();
  let n = 0;
  const infoOf = []; // (k3: the bodies whose faces and edges are read in one call)
  const groups = []; // (k7: each body's faces to mesh)
  try {
    builder.MakeCompound(comp);
    for (const s of parts) {
      // (as meshPart decides: a body meshed before with these settings, or one taking the many-faces path, is left)
      const c = meshCache.get(s.shape);
      if (c && c.tol === tol && c.ang === ang && c.diagQ === diagQ && c.kind === s.kind && c.look === (s.look || null)) continue;
      if (faceCount(s.shape) > 2500) continue;
      infoOf.push(s.shape);
      // (k7: each body's faces in a compound of its own)
      const sub = new oc.TopoDS_Compound();
      builder.MakeCompound(sub);
      let m = 0;
      for (const f of exploreAll(s.shape.wrapped, 'TopAbs_FACE')) {
        if (keptFind(FACE_MESHES, f, key) === undefined) { builder.Add(sub, f); n++; m++; }
        f.delete();
      }
      if (m) groups.push({ sub, m }); else sub.delete();
    }
    if (n) {
      const tm = performance.now();
      // (k7) many bodies: each body on one thread, the bodies shared out over the threads (the edge work in parallel
      // too); a big body (an eighth of the faces or more) and few bodies (under 32): OpenCascade's own parallel
      // meshing of one call, over the faces. The same triangles either way.
      const per = oc.LabMeshExtractor.meshBodies && groups.length >= 32;
      const big = new oc.TopoDS_Compound(), small = new oc.TopoDS_Compound();
      builder.MakeCompound(big); builder.MakeCompound(small);
      let nb = 0, ns = 0;
      for (const g of groups) { if (per && g.m < n / 8) { builder.Add(small, g.sub); ns++; } else { builder.Add(big, g.sub); nb++; } }
      try {
        if (nb) oc.LabMeshExtractor.mesh(big, tol, ang);
        if (ns) oc.LabMeshExtractor.meshBodies(small, tol, ang);
      } finally { big.delete(); small.delete(); }
      LAB_MESH.brepMs = (LAB_MESH.brepMs || 0) + performance.now() - tm;
      // (Kernel Lab) the triangles of all these faces, in one extraction (meshKept takes each face's slice)
      if (groups.length > 1) {
        const all = new oc.TopoDS_Compound();
        builder.MakeCompound(all);
        try {
          for (const g of groups) builder.Add(all, g.sub);
          const m = labExtract(all);
          const byId = new Map(), dup = new Set();
          for (const g of m.faceGroups) { if (byId.has(g.faceId)) dup.add(g.faceId); else byId.set(g.faceId, g); }
          for (const id of dup) byId.delete(id);
          const total = m.faceGroups.reduce((t, g) => t + g.count, 0);
          LAB_EXTRACTED = { m, byId, gs: total === m.triangles.length ? 1 : 3 };
        } finally { all.delete(); }
      }
    }  } finally { builder.delete(); comp.delete(); for (const g of groups) g.sub.delete(); }
  LAB_MESH.calls++; LAB_MESH.faces += n; LAB_MESH.meshMs += performance.now() - t0;
  if (infoOf.length && oc.LabShapeInfo) labShapeInfo(infoOf, diagQ);
  return n > 0;
}
// (Kernel Lab k3) every body's faces' surfaces and edges' points, as surfOf / seamEdges + edgeKept make them, from
// one kernel call; kept for meshPart (once), by body shape
const LAB_INFO = new WeakMap();
const LAB_CURVES = ['LINE', 'CIRCLE', 'ELLIPSE', 'HYPERBOLA', 'PARABOLA', 'BEZIER_CURVE', 'BSPLINE_CURVE', 'OFFSET_CURVE', 'OTHER_CURVE'];
function labShapeInfo(shapes, diagQ) {
  const oc = R.getOC(), t0 = performance.now();
  const builder = new oc.TopoDS_Builder(), comp = new oc.TopoDS_Compound();
  let raw = null;
  try {
    builder.MakeCompound(comp);
    for (const s of shapes) builder.Add(comp, s.wrapped);
    raw = oc.LabShapeInfo.facesAndEdges(comp, diagQ, true);
    const buf = oc.wasmMemory.buffer;
    const D = new Float64Array(buf, raw.getDoublesPtr() >>> 0, raw.getDoublesSize());
    const I = new Int32Array(buf, raw.getIntsPtr() >>> 0, raw.getIntsSize());
    let ii = 0, di = 0;
    // (Kernel Lab: n numbers from D at a, as a plain array; Array.from on a view is slower)
    const take = (a, n) => { const r = new Array(n); for (let k = 0; k < n; k++) r[k] = D[a + k]; return r; };
    const nb = I[ii++], counts = [];
    for (let b = 0; b < nb; b++) counts.push([I[ii++], I[ii++]]);
    if (nb !== shapes.length) return;
    const cones = !!oc.gp_Cone;
    // (k8: tori, and 8 numbers per face; before, 7)
    const tori = !!oc.gp_Torus, faceN = tori ? 8 : 7;
    const out = counts.map(([nf]) => {
      const surfs = [];
      for (let k = 0; k < nf; k++) {
        const kind = I[ii++], d = take(di, faceN); di += faceN;
        // (cones as surfOf gives them with this kernel: their axis when it has gp_Cone, else 'OTHER' (ad.Cone() throws))
        surfs.push(kind === 0 ? { t: 'PLANE', p: d.slice(0, 3), n: unit(d.slice(3, 6)) }
          : kind === 1 ? { t: 'CYLINDER', p: d.slice(0, 3), d: unit(d.slice(3, 6)), r: d[6] }
            : kind === 2 && cones ? { t: 'CONE', p: d.slice(0, 3), d: unit(d.slice(3, 6)), r: d[6] }
            : kind === 5 && tori ? { t: 'TORUS', p: d.slice(0, 3), d: unit(d.slice(3, 6)), r: d[6], r2: d[7] }
            : kind === 3 ? { t: 'SPHERE', p: d.slice(0, 3), r: d[6] } : { t: 'OTHER' });
      }
      return { diagQ, surfs, edges: [] };
    });
    counts.forEach(([, ne], b) => {
      for (let k = 0; k < ne; k++) {
        const type = I[ii++], circ = I[ii++], np = I[ii++];
        const c = take(di, 7); di += 7;
        const mid = take(di, 3); di += 3;
        const pts = take(di, np * 3); di += np * 3;
        out[b].edges.push(type < 0 ? null : { pts, mid, type: LAB_CURVES[type], ...(type === 1 && circ ? { circ: { r: c[0], c: c.slice(1, 4), n: unit(c.slice(4, 7)) } } : {}) });
      }
    });
    shapes.forEach((s, b) => LAB_INFO.set(s, out[b]));
  } finally {
    raw?.delete(); builder.delete(); comp.delete();
    LAB_MESH.infoMs = (LAB_MESH.infoMs || 0) + performance.now() - t0; LAB_MESH.infoBodies = (LAB_MESH.infoBodies || 0) + shapes.length;
  }
}
// the triangles already on a shape's faces, as replicad's mesh() returns them
function labExtract(shape) {
  const oc = R.getOC(), t0 = performance.now();
  const raw = oc.LabMeshExtractor.extract(shape.wrapped ?? shape, false, true);
  try {
    const buf = oc.wasmMemory.buffer, F = new Float32Array(buf), U = new Uint32Array(buf), I = new Int32Array(buf);
    const take = (heap, p, n) => { const a = (p >>> 0) / heap.BYTES_PER_ELEMENT; return heap.slice(a, a + n); }; // (Kernel Lab: a typed copy)
    const vertices = take(F, raw.getVerticesPtr(), raw.getVerticesSize());
    const normals = take(F, raw.getNormalsPtr(), raw.getNormalsSize());
    const triangles = take(U, raw.getTrianglesPtr(), raw.getTrianglesSize());
    const g = take(I, raw.getFaceGroupsPtr(), raw.getFaceGroupsSize());
    const faceGroups = [];
    for (let i = 0; i < g.length; i += 3) faceGroups.push({ start: g[i], count: g[i + 1], faceId: g[i + 2] });
    return { triangles, vertices, normals, faceGroups };
  } finally { raw.delete(); LAB_MESH.extractMs += performance.now() - t0; }
}
// an edge's points as shown (sampleEdge), kept like the faces' meshes
function edgeKept(e, diagQ) {
  const key = String(diagQ), got = keptFind(EDGE_POINTS, e.wrapped, key);
  if (got) return got;
  const type = e.geomType, circ = type === 'CIRCLE' ? circleOf(e) : null;
  const data = { pts: sampleEdge(e, diagQ, type).flat(), mid: curvePoints(e, 2)[1], type, ...(circ ? { circ } : {}) };
  keptAdd(EDGE_POINTS, e.wrapped, key, data, (x) => R.getOC().TopoDS.Edge(x));
  return data;
}

// (ang: the angular tolerance: 0.2 rad, or coarser for an assembly's speed mode)
function meshPart(s, tol, diagQ, onWork, ang = 0.2) {
  const c = meshCache.get(s.shape);
  if (c && c.tol === tol && c.ang === ang && c.diagQ === diagQ && c.kind === s.kind && c.look === (s.look || null)) return c;
  onWork?.();
  meshGen++;
  const many = faceCount(s.shape) > 2500;
  const m = (many && triangleFacesMesh(s.shape)) || (many ? s.shape.mesh({ tolerance: tol, angularTolerance: ang }) : meshKept(s.shape, tol, ang));
  const dense = m.faceGroups.length > 2500;
  const gs = m.faceGroups.reduce((n, g) => n + g.count, 0) === m.triangles.length ? 1 : 3;
  // a few points spread over each face (triangle centroids), for finding which feature made it
  const facePts = m.faceGroups.map((g) => {
    if (dense || s.kind !== 'solid') return null;
    const V = m.vertices, T = m.triangles, nTri = Math.max(1, Math.floor((g.count * gs) / 3));
    const pts = [];
    const take = Math.min(7, nTri);
    for (let q = 0; q < take; q++) {
      const t = g.start * gs + Math.floor(((q + 0.5) * nTri) / take) * 3;
      pts.push([0, 1, 2].map((j) => (V[T[t] * 3 + j] + V[T[t + 1] * 3 + j] + V[T[t + 2] * 3 + j]) / 3));
    }
    return pts;
  });
  const edges = [];
  // (Kernel Lab k3: what one kernel call read for this body, if it did)
  const labInfo = LAB_INFO.get(s.shape)?.diagQ === diagQ ? LAB_INFO.get(s.shape) : null;
  LAB_INFO.delete(s.shape);
  if (!dense) {
    if (labInfo && labInfo.edges.every(Boolean)) { for (const d of labInfo.edges) edges.push(d); }
    else {
      const seams = seamEdges(s.shape);
      for (const e of s.shape.edges) {
        if (seams.some((x) => x.IsSame(e.wrapped))) continue;
        edges.push(edgeKept(e, diagQ));
      }
    }
  }
  // (faces as the mesh numbers them: their surfaces, for assembly mates)
  let surfs = null;
  if (!dense) {
    const faces = s.shape.faces;
    // (a face group knows its face by hash code; the mesh lists them in the same order as the faces)
    const byHash = new Map();
    for (const f of faces) { try { byHash.set(f.hashCode, f); } catch { /* no hash */ } }
    const at = labInfo && labInfo.surfs.length === faces.length ? new Map(faces.map((f, i) => [f, i])) : null;
    surfs = m.faceGroups.map((g, gi) => { const f = byHash.get(g.faceId) || faces[gi]; return f ? (at ? labInfo.surfs[at.get(f)] : surfOf(f)) : { t: 'OTHER' }; });
  }
  // the looks an import gave single faces, each face found by its vertex box
  let faceLooks = null;
  if (s.look?.faces?.length) {
    const faces = s.shape.faces, byHash = new Map();
    for (const f of faces) { try { byHash.set(f.hashCode, f); } catch { /* no hash */ } }
    faceLooks = m.faceGroups.map((g, gi) => {
      const f = byHash.get(g.faceId) || faces[gi];
      const b = f && vertexBox(f.wrapped);
      const e = b && s.look.faces.find((x) => boxNear(b, x.b, lookTol(x.b)));
      return e ? { c: e.c ?? null, t: e.t || 0 } : null;
    });
  }
  const out = { tol, ang, diagQ, kind: s.kind, look: s.look || null, m, gs, dense, facePts, edges, surfs, faceLooks };
  meshCache.set(s.shape, out);
  keptPrune(FACE_MESHES); keptPrune(EDGE_POINTS); keptPrune(FACE_BOXES); keptPrune(FACE_AREAS);
  return out;
}

// Meshing a big import's bodies over more kernels. The bodies not meshed yet that are still as a stored STEP import
// made them: this kernel meshes them for a moment (MESH_PROBE_MS) to see how long the rest will take; when other
// kernels would finish sooner, though each first reads the whole import (the page hands them the text it just
// read or wrote for this kernel: as long as reading it took here, and a moment to start), the rest is shared out by faces between this kernel and the pool's free ones (asked
// of the page, up to MESH_HELPERS), this kernel's share sized so all finish together. Their meshes are kept as this
// kernel's own (meshPart then finds them); one that fails leaves its bodies to this kernel. mode 'always' (tests):
// helpers whatever the times. Returns how many kernels helped.
const MESH_PROBE_MS = 300, MESH_HELP_MIN_MS = 1500, MESH_HELPER_START_MS = 400, MESH_HELPERS = 7;
async function meshHelped(parts, tol, diagQ, ang, mode = null) {
  const todo = parts.filter((s) => {
    if (!importedFrom.has(s.shape)) return false;
    const c = meshCache.get(s.shape);
    return !(c && c.tol === tol && c.ang === ang && c.diagQ === diagQ && c.kind === s.kind && c.look === (s.look || null));
  });
  if (todo.length < 4) return 0;
  const faces = new Map(todo.map((s) => [s, faceCount(s.shape)]));
  // (a moment's meshing here: the time a face takes)
  const t0 = performance.now();
  let done = 0, doneFaces = 0;
  while (done < todo.length - 1 && (mode === 'always' ? done < 1 : performance.now() - t0 < MESH_PROBE_MS)) {
    meshPart(todo[done], tol, diagQ, null, ang);
    doneFaces += faces.get(todo[done++]);
  }
  const rest = todo.slice(done), restFaces = rest.reduce((n, s) => n + faces.get(s), 0);
  const perFace = (performance.now() - t0) / Math.max(1, doneFaces), work = perFace * restFaces;
  const ready = Math.max(...rest.map((s) => importReadMs.get(importedFrom.get(s.shape).key) ?? 2000)) + MESH_HELPER_START_MS;
  // (h helpers and this kernel all done together: this kernel's time with them, (work + h × ready) / (h + 1))
  const timeWith = (h) => (work + h * ready) / (h + 1);
  let want = Math.min(MESH_HELPERS, rest.length - 1);
  if (mode !== 'always') {
    if (work < MESH_HELP_MIN_MS || timeWith(1) > 0.8 * work) return 0;
    while (want > 1 && timeWith(want - 1) - timeWith(want) < 150) want--;
  }
  const free = want > 0 ? (await askPage('meshHelpers', { want }, 5000)) || 0 : 0;
  if (!(free > 0)) return 0;
  const h = Math.min(free, want), mine = mode === 'always' ? 1 / (h + 1) : timeWith(h) / work;
  // (the biggest first, each to the share furthest below its size; this kernel's share is the first)
  const shares = Array.from({ length: h + 1 }, (_, i) => ({ items: [], faces: 0, size: (i ? (1 - mine) / h : mine) * restFaces }));
  [...rest].sort((a, b) => faces.get(b) - faces.get(a)).forEach((s) => {
    const sh = shares.reduce((a, b) => (b.faces - b.size < a.faces - a.size ? b : a));
    sh.items.push(s); sh.faces += faces.get(s);
  });
  progress(null, `Meshing ${todo.length} bodies in ${shares.length} kernels…`);
  const asks = shares.slice(1).map((sh, slot) => (sh.items.length ? askPage('meshHelp', {
    slot, tol, ang, diagQ, items: sh.items.map((s) => ({ ...importedFrom.get(s.shape), look: s.look || null })),
  }, 600000) : null));
  for (const s of shares[0].items) meshPart(s, tol, diagQ, null, ang);
  const outs = await Promise.all(asks);
  let helped = 0;
  outs.forEach((o, j) => {
    if (!Array.isArray(o?.meshes)) return;
    helped++;
    shares[j + 1].items.forEach((s, q) => { const m = o.meshes[q]; if (m) meshCache.set(s.shape, { tol, ang, diagQ, kind: s.kind, look: s.look || null, ...m }); });
  });
  return helped;
}
// (a helper's side: the import read from the store and split as the import feature splits it, the last two kept)
const helpImports = new Map();
async function helpImport(key) {
  if (helpImports.has(key)) return helpImports.get(key);
  const got = await askPage('importGet', { key });
  if (!got?.brep) return null;
  const nl = got.brep.indexOf('\n');
  const parts = splitImported(R.cast(R.getOC().BRepToolsWrapper.Read(got.brep.slice(nl + 1))));
  helpImports.set(key, parts);
  while (helpImports.size > 2) helpImports.delete(helpImports.keys().next().value);
  return parts;
}
async function meshImportBodies({ items, tol, ang, diagQ }) {
  const meshes = [], transfer = [];
  for (const it of items) {
    const parts = await helpImport(it.key);
    const shape = parts?.[it.kind === 'solid' ? 'solids' : 'surfaces']?.[it.k];
    if (!shape) { meshes.push(null); continue; }
    const r = meshPart({ shape, kind: it.kind, look: it.look }, tol, diagQ, null, ang);
    // (the arrays packed, as copies: the kept mesh stays whole here)
    const m = { ...r.m, vertices: Float32Array.from(r.m.vertices), normals: Float32Array.from(r.m.normals), triangles: Uint32Array.from(r.m.triangles) };
    transfer.push(m.vertices.buffer, m.normals.buffer, m.triangles.buffer);
    meshes.push({ m, gs: r.gs, dense: r.dense, facePts: r.facePts, edges: r.edges, surfs: r.surfs, faceLooks: r.faceLooks });
  }
  return { result: { meshes }, transfer };
}

// ------------------------------------------------------------ previews
function meshData(shapes, diag) {
  const parts = [];
  for (const s of shapes) {
    if (!s) continue;
    try { parts.push(s.mesh({ tolerance: Math.max(0.01, diag * 0.001), angularTolerance: 0.3 })); } catch { /* skip */ }
  }
  if (!parts.length) return null;
  let nv = 0, nt = 0;
  for (const m of parts) { nv += m.vertices.length; nt += m.triangles.length; }
  if (!nt) return null;
  const vertices = new Float32Array(nv), normals = new Float32Array(nv), triangles = new Uint32Array(nt);
  let ov = 0, ot = 0;
  for (const m of parts) {
    vertices.set(m.vertices, ov); normals.set(m.normals, ov);
    for (let i = 0; i < m.triangles.length; i++) triangles[ot + i] = m.triangles[i] + ov / 3;
    ov += m.vertices.length; ot += m.triangles.length;
  }
  return { vertices, normals, triangles };
}

// Preview geometry for the feature being edited: material it adds (yellow) and removes (red).
function makePreview(f, before, after, applied, pair = null) {
  // (the size from the body before: its faces' boxes are known already; the body after is new, and boxing its big
  // faces took 0.3 s on the golf ball)
  const ref = before || after;
  const diag = ref ? bbox(ref).diag : 100;
  const tryOp = (fn) => { try { return fn(); } catch (e) { if (isFatal(e)) throw e; return null; } };
  if (pair) { before = pair.before; after = pair.after; } // only the body that changed
  if (['fillet', 'chamfer', 'shell', 'combine'].includes(f.type) || f.op === 'intersect') {
    if (!before || !after || before === after) return null;
    return {
      add: meshData([tryOp(() => after.cut(before))], diag),
      remove: meshData([tryOp(() => before.cut(after))], diag),
    };
  }
  const shown = (a) => (a.view && tryOp(a.view)) || a.tool; // `view`: how the tool should look (e.g. a thread trimmed flat)
  const adds = applied.filter((a) => a.op === 'add').map(shown);
  const cuts = applied.filter((a) => a.op === 'cut'), cutTools = cuts.map(shown);
  if (!adds.length && !cutTools.length) return null;
  // material a cut removes (solid red), plus the cut volume itself (faint red) so the cut is
  // visible even where it misses the solid. Very long tools (Through All) are clipped to the model.
  // (`inside`: the tool is known to lie in the material, e.g. a thread, so it is shown as it is.)
  // (the tools that may miss the material in one intersection, given as a list: the body is prepared once, not once
  // per tool, e.g. 1.7 s -> 0.2 s for a pattern of 19 dimples on a golf ball; one by one if that fails)
  const loose = cuts.filter((a) => !a.inside), parts = loose.flatMap((a) => solidsOf(a.tool));
  const together = before && loose.length && parts.length > 1 && loose.every((a) => a.tool.solids.length)
    ? tryOp(() => boolByList('common', before, parts)) : null;
  const removed = meshData(together
    ? [...cuts.map((a, i) => (a.inside ? cutTools[i] : null)), together]
    : cuts.map((a, i) => (a.inside ? cutTools[i] : before ? tryOp(() => before.intersect(a.tool)) : null)), diag);
  let clip = null;
  if (before) {
    const b = bbox(before), m = b.diag * 0.05;
    clip = R.makeBox(sub(b.min, [m, m, m]), add(b.max, [m, m, m]));
  }
  const ghost = cutTools.map((t) => (clip && bbox(t).diag > 1.5 * diag ? tryOp(() => t.intersect(clip)) : t));
  return {
    add: meshData(adds, diag),
    remove: removed,
    tool: meshData(ghost, diag),
    missed: cutTools.length > 0 && !removed, // the cut removes nothing
  };
}

// Fillet/chamfer several groups of edges in a single kernel operation on `base`.
// items: [{ refs: [edge refs], value }]. Returns the new shape or null.
function combinedBlend(base, items, type) {
  const sel = [];
  for (const it of items) {
    for (const ref of it.refs) {
      const e = findEdge(base, ref);
      if (!e) return null; // never silently drop an edge
      sel.push({ e, value: ref.value ?? it.value });
    }
  }
  if (!sel.length) return null;
  const radius = (edge) => {
    const m = sel.find((s) => s.e.isSame(edge));
    return m ? m.value : null;
  };
  try {
    return type === 'fillet' ? base.fillet(radius) : base.chamfer(radius);
  } catch (e) {
    if (isFatal(e)) throw e;
    return null;
  }
}

// Recompute a failing blend together with ALL earlier blends of the same type: start from
// the body before the first of them, apply every blend in one kernel call, then replay the
// features that came in between (their boolean tools, or other-type blends via edge refs).
function reorderedBlend(steps, type, item) {
  const first = steps.findIndex((s) => s.blend?.type === type);
  if (first < 0 || !steps[first].before) return null;
  const base = steps[first].before;
  const later = steps.slice(first);
  const items = [...later.filter((s) => s.blend?.type === type).map((s) => s.blend.item), item];
  let body = combinedBlend(base, items, type);
  if (!body) return null;
  try {
    for (const s of later) {
      if (s.opaque) return null;
      if (s.blend?.type === type) continue;
      if (s.blend) {
        const edges = s.blend.item.refs.map((r) => findEdge(body, r));
        if (edges.some((e) => !e)) return null;
        const radius = (edge) => (edges.some((e) => e.isSame(edge)) ? s.blend.item.value : null);
        body = s.blend.type === 'fillet' ? body.fillet(radius) : body.chamfer(radius);
        continue;
      }
      for (const a of s.applied) body = a.op === 'add' ? body.fuse(a.tool) : body.cut(a.tool);
    }
  } catch (e) {
    if (isFatal(e)) throw e;
    return null;
  }
  return { body, base, items };
}

function findVertex(body, ref) {

  if (!body) return null;
  const b = bbox(body);
  const pts = [];
  const seen = new Set();
  for (const { e } of edgeInfos(body)) {
    const s = vec(e.startPoint), t = vec(e.endPoint);
    if (len(sub(s, t)) < 1e-6) continue; // seam of a closed edge
    for (const q of [s, t]) {
      const k = q.map((x) => Math.round(x * 1e5)).join(',');
      if (!seen.has(k)) { seen.add(k); pts.push(q); }
    }
  }
  const search = (p) => {
    let best = null, bd = Infinity, second = Infinity;
    for (const q of pts) {
      const dd = len(sub(q, p));
      if (dd < bd) { second = bd; bd = dd; best = q; } else if (dd < second) second = dd;
    }
    return { best, bd, second };
  };
  const tol = Math.max(0.05, b.diag * 0.15);
  const ok = (r) => r.best && r.bd < tol && (r.bd < 1e-3 || r.second > r.bd * 1.6);
  const raw = search(ref.p);
  if (raw.best && raw.bd < 1e-3) return raw.best;
  const mapped = ref.box ? search(mapIntoBox(ref.p, ref.box, b)) : null;
  const choices = [raw, mapped].filter((r) => r && ok(r)).sort((x, y) => x.bd - y.bd);
  return choices.length ? choices[0].best : null;
}

function sampleEdge(e, diag, type = e.geomType) {
  if (type === 'LINE') return curvePoints(e, 1, true);
  const L = e.length;
  // (free-form curves, e.g. a closed corner's lens, get more points: drawn with few they look kinked up close)
  const nMin = type === 'BSPLINE_CURVE' || type === 'BEZIER_CURVE' || type === 'OTHER_CURVE' ? 160 : 24;
  const n = Math.max(nMin, Math.min(128, Math.ceil(L / Math.max(diag * 0.004, 0.05))));
  return curvePoints(e, n);
}
// An edge's points at i/n of its parameter range (i = 0..n): the same points as e.pointAt(i / n), from one curve
// adaptor (pointAt makes one per point: a fifth of the time of meshing a big imported part went there). ends: the
// last point at the end parameter itself, as e.endPoint gives it (u0 + (u1 - u0) can differ from u1 in the last bit)
function curvePoints(e, n, ends = false) {
  const c = new (R.getOC()).BRepAdaptor_Curve(e.wrapped), pts = [];
  try {
    const u0 = c.FirstParameter(), u1 = c.LastParameter();
    for (let i = 0; i <= n; i++) {
      const p = c.Value(ends && i === n ? u1 : u0 + (u1 - u0) * (i / n));
      pts.push([p.X(), p.Y(), p.Z()]);
      p.delete();
    }
  } finally { c.delete(); }
  return pts;
}

function edgeGeom(e, diag) {
  return S.classifyPolyline3(sampleEdge(e, diag));
}

// ------------------------------------------------------------ STL import
function parseSTL(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tris = [];
  const isBinary = bytes.length >= 84 && 84 + dv.getUint32(80, true) * 50 === bytes.length;
  if (isBinary) {
    const n = dv.getUint32(80, true);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      tris.push([0, 1, 2].map((k) => [dv.getFloat32(o + k * 12, true), dv.getFloat32(o + k * 12 + 4, true), dv.getFloat32(o + k * 12 + 8, true)]));
    }
  } else {
    const text = new TextDecoder().decode(bytes);
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
    let m, cur = [];
    while ((m = re.exec(text))) {
      cur.push([+m[1], +m[2], +m[3]]);
      if (cur.length === 3) { tris.push(cur); cur = []; }
    }
  }
  return tris;
}

// Build a shape directly from triangles with shared vertices/edges (much faster than sewing loose
// faces): a solid when every edge joins exactly two triangles, otherwise an open shell.
// P: [[x, y, z]]; T: [[a, b, c]] point indices (degenerate and repeated triangles are skipped).
// Returns { shape, open (edges with one triangle), closed }.
function meshShape(P, T) {
  const oc = R.getOC();
  const verts = new Array(P.length).fill(null);
  const vtx = (i) => {
    if (!verts[i]) {
      const g = new oc.gp_Pnt(P[i][0], P[i][1], P[i][2]);
      const mv = new oc.BRepBuilderAPI_MakeVertex(g);
      verts[i] = mv.Vertex();
      mv.delete(); g.delete();
    }
    return verts[i];
  };
  const emap = new Map();
  const oedge = (a, b) => {
    const k = a < b ? a + '|' + b : b + '|' + a;
    let rec = emap.get(k);
    if (!rec) {
      const mk = new oc.BRepBuilderAPI_MakeEdge(vtx(a), vtx(b));
      const e = mk.Edge();
      mk.delete();
      rec = { e, from: a, rev: oc.TopoDS.Edge(e.Reversed()), uses: 0 };
      emap.set(k, rec);
    }
    rec.uses++;
    return rec.from === a ? rec.e : rec.rev;
  };
  const shell = new oc.TopoDS_Shell();
  const builder = new oc.TopoDS_Builder();
  builder.MakeShell(shell);
  let faces = 0;
  const seen = new Set();
  for (const [a, b, c] of T) {
    if (a === b || b === c || a === c) continue;
    const key = [a, b, c].sort((x, y) => x - y).join(',');
    if (seen.has(key)) continue; // (the same triangle twice)
    seen.add(key);
    const w = new oc.BRepBuilderAPI_MakeWire(oedge(a, b), oedge(b, c), oedge(c, a));
    const f = new oc.BRepBuilderAPI_MakeFace(w.Wire(), true);
    if (f.IsDone()) { builder.Add(shell, f.Face()); faces++; }
    w.delete(); f.delete();
  }
  if (!faces) throw new Error('The mesh contains only degenerate triangles');
  // closed only when every edge joins exactly two triangles (the kernel would orient an open shell too)
  const uses = [...emap.values()].map((r) => r.uses);
  const open = uses.filter((u) => u === 1).length;
  const watertight = uses.every((u) => u === 2);
  const ms = new oc.BRepBuilderAPI_MakeSolid(shell);
  const solid = ms.Solid();
  ms.delete();
  const closed = watertight && oc.BRepLib.OrientClosedSolid(solid);
  let shape = R.cast(closed ? solid : shell); // open mesh: keep it as a shell
  // merge coplanar triangles back into single planar faces: a big win for CAD-made STLs (flat faces of many
  // triangles), but slow and of no use on organic meshes (e.g. a scanned or sculpted model): done only when
  // a good share of neighbouring triangles lie in one plane
  if (faces <= 20000 || coplanarShare(P, T) > 0.3) { try { shape = shape.simplify(); } catch { /* as built */ } }
  return { shape, open, closed };
}
// The share of a mesh's inner edges whose two triangles lie in one plane.
function coplanarShare(P, T) {
  const nrm = T.map(([a, b, c]) => { const n = cross(sub(P[b], P[a]), sub(P[c], P[a])), l = len(n); return l > 0 ? mul(n, 1 / l) : null; });
  const first = new Map();
  let inner = 0, flat = 0;
  T.forEach((t, ti) => {
    for (let k = 0; k < 3; k++) {
      const a = t[k], b = t[(k + 1) % 3], key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      const o = first.get(key);
      if (o === undefined) { first.set(key, ti); continue; }
      inner++;
      if (nrm[o] && nrm[ti] && Math.abs(dot(nrm[o], nrm[ti])) > 0.99999) flat++;
    }
  });
  return inner ? flat / inner : 0;
}
function stlToShape(bytes, maxTris) {
  return trisToShape(parseSTL(bytes), 'STL', maxTris);
}
// Triangles ([[x, y, z] × 3]) of a mesh file → a shape (solid when it closes, else a shell).
// Meshes with more than maxTris triangles are simplified first (the kernel runs out of memory with a few
// hundred thousand faces); 0: never.
const MESH_MAX_TRIS = 80000;
function trisToShape(tris, what = 'mesh', maxTris = MESH_MAX_TRIS) {
  if (!tris.length) throw new Error(`The ${what} file contains no triangles`);
  if (tris.length > 5000000) throw new Error(`The ${what} has ${tris.length.toLocaleString()} triangles; the limit is 5,000,000`);
  const vmap = new Map(), P = [];
  const vid = (p) => {
    const k = `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)},${Math.round(p[2] * 1e5)}`;
    let id = vmap.get(k);
    if (id === undefined) { id = P.length; vmap.set(k, id); P.push(p); }
    return id;
  };
  let T = tris.map((t) => t.map(vid)), mesh = { P, T };
  const limit = maxTris > 0 ? Math.max(1000, maxTris) : 0;
  if (limit && T.length > limit) {
    progress(null, `Simplifying the mesh (${T.length.toLocaleString()} triangles)…`);
    mesh = decimate(P, T, limit);
  } else if (!limit && T.length > 300000) throw new Error(`The ${what} has ${T.length.toLocaleString()} triangles: too many to convert without simplifying (set a triangle limit in the import)`);
  const out = meshShape(mesh.P, mesh.T);
  out.reduced = mesh.T.length < T.length ? { from: T.length, to: mesh.T.length } : null;
  return out;
}

// Triangles of flat-faced shapes (e.g. an STL import), points closer than tol welded into one.
function meshTris(shapes, tol) {
  const P = [], T = [], grid = new Map(), cell = Math.max(tol, 1e-9);
  const weld = (p) => {
    const c = p.map((v) => Math.floor(v / cell));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const l = grid.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`);
      if (l) for (const i of l) if (Math.hypot(P[i][0] - p[0], P[i][1] - p[1], P[i][2] - p[2]) <= tol) return i;
    }
    const i = P.length, k = `${c[0]},${c[1]},${c[2]}`;
    P.push(p);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
    return i;
  };
  for (const s of shapes) {
    const m = (faceCount(s) > 2500 && triangleFacesMesh(s)) || s.mesh({ tolerance: Math.max(tol, 1e-3), angularTolerance: 0.2 });
    const v = m.vertices, t = m.triangles, ids = [];
    for (let i = 0; i < v.length / 3; i++) ids.push(weld([v[3 * i], v[3 * i + 1], v[3 * i + 2]]));
    for (let k = 0; k < t.length; k += 3) T.push([ids[t[k]], ids[t[k + 1]], ids[t[k + 2]]]);
  }
  return { P, T };
}
// A shape made only of flat faces (a mesh): repaired triangle by triangle. (Asking a face its type is
// slow: a big body is judged by a sample of its faces.)
const isMeshLike = (shapes) => shapes.every((s) => {
  const fs = s.faces;
  const pick = fs.length <= 300 ? fs : Array.from({ length: 60 }, (_, i) => fs[Math.floor((i * fs.length) / 60)]);
  return pick.every((f) => f.geomType === 'PLANE');
});

// Repair a triangle mesh: degenerate and repeated triangles dropped, the triangles turned to run the
// same way round (neighbours cross their shared edge in opposite directions), and (with fill) every
// hole (loop of edges with a triangle on one side only) up to maxHole across closed with triangles.
// May add a centre point to P; returns the new triangles with what was done.
function repairTris(P, T0, { maxHole = 0, fill = true } = {}) {
  const T = [], seen = new Set();
  for (const t of T0) {
    if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) continue;
    const k = [...t].sort((a, b) => a - b).join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    T.push([...t]);
  }
  const ek = (a, b) => (a < b ? a + ',' + b : b + ',' + a);
  const edges = new Map();
  T.forEach((t, i) => { for (let k = 0; k < 3; k++) { const key = ek(t[k], t[(k + 1) % 3]); if (!edges.has(key)) edges.set(key, []); edges.get(key).push(i); } });
  const runs = (t, a, b) => (t[0] === a && t[1] === b) || (t[1] === a && t[2] === b) || (t[2] === a && t[0] === b);
  // the same way round, spreading from each triangle across edges shared by exactly two
  const done = new Uint8Array(T.length);
  let flipped = 0;
  for (let s = 0; s < T.length; s++) {
    if (done[s]) continue;
    done[s] = 1;
    const stack = [s];
    while (stack.length) {
      const i = stack.pop(), t = T[i];
      for (let k = 0; k < 3; k++) {
        const a = t[k], b = t[(k + 1) % 3], l = edges.get(ek(a, b));
        if (l.length !== 2) continue;
        const j = l[0] === i ? l[1] : l[0];
        if (done[j]) continue;
        if (runs(T[j], a, b)) { T[j] = [T[j][0], T[j][2], T[j][1]]; flipped++; }
        done[j] = 1;
        stack.push(j);
      }
    }
  }
  const nonManifold = [...edges.values()].filter((l) => l.length > 2).length;
  // the holes: each open edge taken the way a patch runs along it (against its triangle)
  const next = new Map();
  let openEdges = 0;
  for (const [key, l] of edges) {
    if (l.length !== 1) continue;
    openEdges++;
    const [u, v] = key.split(',').map(Number), t = T[l[0]];
    const [a, b] = runs(t, u, v) ? [u, v] : [v, u];
    if (!next.has(b)) next.set(b, []);
    next.get(b).push(a);
  }
  const loops = [];
  let chains = 0;
  for (const start of [...next.keys()]) {
    while (next.get(start)?.length) {
      const loop = [start];
      let cur = next.get(start).pop(), ok = false;
      for (let guard = 0; guard <= openEdges; guard++) {
        if (cur === start) { ok = true; break; }
        loop.push(cur);
        const l = next.get(cur);
        if (!l?.length) break;
        cur = l.pop();
      }
      if (ok && loop.length >= 3) loops.push(loop); else chains++;
    }
  }
  let filled = 0, tooBig = 0, failed = 0;
  if (fill) {
    for (const loop of loops) {
      const pts = loop.map((i) => P[i]);
      const lo = [0, 1, 2].map((j) => Math.min(...pts.map((p) => p[j]))), hi = [0, 1, 2].map((j) => Math.max(...pts.map((p) => p[j])));
      if (maxHole > 0 && len(sub(hi, lo)) > maxHole) { tooBig++; continue; }
      const tri = triangulateIdx(pts);
      if (!tri) { failed++; continue; }
      let centre = null;
      for (const t of tri) {
        T.push(t.map((k) => {
          if (k < loop.length) return loop[k];
          if (centre == null) { P.push(tri.centre); centre = P.length - 1; }
          return centre;
        }));
      }
      filled++;
    }
  }
  return { T, filled, tooBig, failed, holes: loops.length, chains, openEdges, nonManifold, flipped };
}
// Triangles closing a polygon (3D points in order), as index triples running the polygon's way round:
// ear clipping in its best-fit plane, or a fan from the centre (index n, the point in .centre).
function triangulateIdx(pts) {
  const n = pts.length;
  let N = [0, 0, 0];
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; N = add(N, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]); }
  if (len(N) < 1e-12) return null;
  N = unit(N);
  const U = unit(cross(N, Math.abs(N[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), V = cross(N, U);
  const q = pts.map((p) => [dot(p, U), dot(p, V)]);
  const area2 = (a, b, c) => (q[b][0] - q[a][0]) * (q[c][1] - q[a][1]) - (q[b][1] - q[a][1]) * (q[c][0] - q[a][0]);
  const inside = (p, a, b, c) => area2(a, b, p) >= 0 && area2(b, c, p) >= 0 && area2(c, a, p) >= 0;
  if (n <= 2000) {
    const idx = Array.from({ length: n }, (_, i) => i), tris = [];
    while (idx.length > 3) {
      let cut = false;
      for (let k = 0; k < idx.length; k++) {
        const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
        if (area2(a, b, c) <= 1e-12) continue;
        if (idx.some((p) => p !== a && p !== b && p !== c && inside(p, a, b, c))) continue;
        tris.push([a, b, c]);
        idx.splice(k, 1);
        cut = true;
        break;
      }
      if (!cut) break;
    }
    if (idx.length === 3) { tris.push([...idx]); return tris; }
  }
  const out = pts.map((_, i) => [i, (i + 1) % n, n]);
  out.centre = mul(pts.reduce((acc, p) => add(acc, p), [0, 0, 0]), 1 / n);
  return out;
}

// ------------------------------------------------------------ closing surfaces into solids
// Sew faces / shells together, joining edges closer than tol.
function sewShapes(shapes, tol) {
  const oc = R.getOC();
  const sw = new oc.BRepBuilderAPI_Sewing(Math.max(1e-7, tol), true, true, true, false);
  try {
    for (const s of shapes) sw.Add(s.wrapped);
    sw.Perform(new oc.Message_ProgressRange());
    return R.cast(sw.SewedShape());
  } finally { sw.delete(); }
}
// The edges of a (sewn) shape used by only one face: the edges of its holes, chained into loops.
// Each loop: { edges (in order), pts (polyline round it), size (its box diagonal) }; chains that do not
// close (e.g. a dangling edge) come back in `open`.
function holeLoops(shape) {
  const P = (v) => vec(v);
  const key = (p) => p.map((x) => Math.round(x * 1e5)).join(',');
  const items = new Map();
  for (const face of shape.faces) {
    // (every use of an edge: a seam, e.g. down a cylinder's side, is used twice by its one face)
    const T = R.getOC().TopAbs_ShapeEnum, ex = new (R.getOC().TopExp_Explorer)(face.wrapped, T.TopAbs_EDGE, T.TopAbs_SHAPE);
    const uses = [];
    for (; ex.More(); ex.Next()) uses.push(ex.Current());
    ex.delete();
    for (const raw of uses) {
      const e = R.cast(raw);
      const a = P(e.startPoint), b = P(e.endPoint), m = P(e.pointAt(0.5));
      const k = [key(a), key(b)].sort().join('|') + '|' + key(m);
      const it = items.get(k);
      if (it) it.n++; else items.set(k, { e, a, b, n: 1 });
    }
  }
  const free = [...items.values()].filter((it) => it.n === 1);
  const at = new Map();
  free.forEach((it, i) => { for (const p of [it.a, it.b]) { const k = key(p); if (!at.has(k)) at.set(k, []); at.get(k).push(i); } });
  const used = new Set(), loops = [], open = [];
  for (let s = 0; s < free.length; s++) {
    if (used.has(s)) continue;
    used.add(s);
    const startK = key(free[s].a);
    const chain = [{ it: free[s], rev: false }];
    let endP = free[s].b, closed = key(endP) === startK;
    while (!closed) {
      const nx = (at.get(key(endP)) || []).find((j) => !used.has(j));
      if (nx == null) break;
      used.add(nx);
      const it = free[nx], rev = key(it.b) === key(endP);
      chain.push({ it, rev });
      endP = rev ? it.a : it.b;
      closed = key(endP) === startK;
    }
    // the points round it (curved edges sampled)
    const pts = [];
    for (const { it, rev } of chain) {
      const m = it.e.geomType === 'LINE' ? 1 : 16;
      const q = Array.from({ length: m + 1 }, (_, i) => P(it.e.pointAt(i / m)));
      if (rev) q.reverse();
      pts.push(...q.slice(pts.length ? 1 : 0));
    }
    if (closed && pts.length > 1) pts.pop();
    const lo = [0, 1, 2].map((j) => Math.min(...pts.map((p) => p[j]))), hi = [0, 1, 2].map((j) => Math.max(...pts.map((p) => p[j])));
    const rec = { edges: chain.map((c) => c.it.e), pts, size: len(sub(hi, lo)), curved: chain.some((c) => c.it.e.geomType !== 'LINE') };
    (closed && pts.length >= 3 ? loops : open).push(rec);
  }
  return { loops, open, freeEdges: free.length };
}
// Triangles closing a polygon (3D points in order): ear clipping in its best-fit plane; a fan from the
// centre when that fails (a hole that is far from flat).
function triangulateLoop(pts) {
  const n = pts.length;
  let N = [0, 0, 0];
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; N = add(N, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]); }
  if (len(N) < 1e-12) return null;
  N = unit(N);
  const U = unit(cross(N, Math.abs(N[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), V = cross(N, U);
  const q = pts.map((p) => [dot(p, U), dot(p, V)]);
  const idx = Array.from({ length: n }, (_, i) => i);
  const area2 = (a, b, c) => (q[b][0] - q[a][0]) * (q[c][1] - q[a][1]) - (q[b][1] - q[a][1]) * (q[c][0] - q[a][0]);
  const inside = (p, a, b, c) => area2(a, b, p) >= 0 && area2(b, c, p) >= 0 && area2(c, a, p) >= 0;
  const tris = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
      if (area2(a, b, c) <= 1e-12) continue;
      if (idx.some((p) => p !== a && p !== b && p !== c && inside(p, a, b, c))) continue;
      tris.push([pts[a], pts[b], pts[c]]);
      idx.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) { tris.push(idx.map((i) => pts[i])); return tris; }
  // (fallback) a fan from the centre
  const c = mul(pts.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / n);
  return pts.map((p, i) => [p, pts[(i + 1) % n], c]);
}
// Faces closing one hole: the exact flat face when it lies in a plane, a filling surface for a curved
// hole, triangles for a hole in a mesh.
function holePatch(loop, tol) {
  const wire = () => R.assembleWire(loop.edges.map((e) => e.clone()));
  if (loop.curved) {
    try { return [R.makeFace(wire())]; } catch { /* not flat */ }
    try { return [R.makeNonPlanarFace(wire())]; } catch { /* triangles below */ }
  } else {
    // flat (within the gap tolerance): one face
    const n = loop.pts.length;
    if (n > 3) {
      try {
        const f = R.makeFace(wire());
        if (f && f.faces?.length !== 0) return [f];
      } catch { /* not flat */ }
    }
  }
  const tris = triangulateLoop(loop.pts);
  if (!tris) return null;
  return tris.filter((t) => len(cross(sub(t[1], t[0]), sub(t[2], t[0]))) > tol * tol * 1e-3).map((t) => R.makePolygon(t));
}
// A closed sewn shape as one solid (or null when it is not closed or not one shell).
// A point in the middle of a flat face (for a dome's top): its centre of area when that lies on the face,
// else the point of a grid on the face farthest from its outline.
function domeCentre(face, wire, fallback, n) {
  const onFace = (p) => new R.DistanceQuery(R.makeVertex(p)).distanceTo(face) < 1e-6;
  let c = null;
  try { const q = R.measureShapeSurfaceProperties(face); c = q.centerOfMass; q.delete?.(); } catch { c = null; }
  if (c && onFace(c)) return c;
  // a grid over the face, in its own plane
  const u = unit(cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), v = cross(n, u), bb = bbox(face);
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((m) => [m & 1 ? bb.max[0] : bb.min[0], m & 2 ? bb.max[1] : bb.min[1], m & 4 ? bb.max[2] : bb.min[2]]);
  const ru = corners.map((q) => dot(sub(q, fallback), u)), rv = corners.map((q) => dot(sub(q, fallback), v));
  const u0 = Math.min(...ru), u1 = Math.max(...ru), v0 = Math.min(...rv), v1 = Math.max(...rv);
  const wq = (p) => new R.DistanceQuery(R.makeVertex(p)).distanceTo(wire);
  let best = fallback, bd = -1;
  for (let i = 1; i < 16; i++) for (let j = 1; j < 16; j++) {
    const p = add(fallback, add(mul(u, u0 + ((u1 - u0) * i) / 16), mul(v, v0 + ((v1 - v0) * j) / 16)));
    if (!onFace(p)) continue;
    const d = wq(p);
    if (d > bd) { bd = d; best = p; }
  }
  return best;
}

function solidFromSewn(sewn) {
  const oc = R.getOC();
  const shells = [...R.iterTopo(sewn.wrapped, 'shell')];
  if (shells.length !== 1) return null;
  const ms = new oc.BRepBuilderAPI_MakeSolid(shells[0]);
  const solid = R.cast(ms.Solid());
  ms.delete();
  if (!oc.BRepLib.OrientClosedSolid(solid.wrapped)) return null;
  const v = R.measureVolume(solid);
  if (!(Math.abs(v) > 0)) return null;
  return v < 0 ? R.cast(solid.wrapped.Reversed()) : solid;
}

// Wavefront OBJ: vertices and faces (polygons fanned into triangles; v, v/vt, v/vt/vn, negative indices).
function parseOBJ(text) {
  const V = [], tris = [];
  for (const raw of text.split(/\r?\n/)) {
    const ln = raw.trim();
    if (ln.startsWith('v ')) { const q = ln.slice(2).trim().split(/\s+/).map(Number); V.push([q[0] || 0, q[1] || 0, q[2] || 0]); }
    else if (ln.startsWith('f ')) {
      const idx = ln.slice(2).trim().split(/\s+/).map((t) => { const i = parseInt(t.split('/')[0], 10); return i < 0 ? V.length + i : i - 1; });
      for (let k = 1; k + 1 < idx.length; k++) { const a = V[idx[0]], b = V[idx[k]], c = V[idx[k + 1]]; if (a && b && c) tris.push([a, b, c]); }
    }
  }
  return tris;
}
// A zip archive's files (stored or deflated) → Map(name → bytes).
async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = new Map();
  // the central directory, from the end record
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('The 3MF file is not a valid zip archive');
  let at = dv.getUint32(eocd + 16, true);
  const n = dv.getUint16(eocd + 10, true);
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(at, true) !== 0x02014b50) break;
    const method = dv.getUint16(at + 10, true), csize = dv.getUint32(at + 20, true);
    const nl = dv.getUint16(at + 28, true), xl = dv.getUint16(at + 30, true), cl = dv.getUint16(at + 32, true), lo = dv.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nl));
    at += 46 + nl + xl + cl;
    const ds = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    const data = bytes.subarray(ds, ds + csize);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()));
  }
  return out;
}
// 3MF: the meshes of the model's objects, placed by the build items (units to millimetres).
async function parse3MF(bytes) {
  const files = await unzip(bytes);
  const key = [...files.keys()].find((k) => /3dmodel\.model$/i.test(k));
  if (!key) throw new Error('The 3MF file has no 3D model');
  const xml = new TextDecoder().decode(files.get(key));
  const unit = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }[(/<model[^>]*\sunit="([a-z]+)"/i.exec(xml) || [])[1] || 'millimeter'] || 1;
  const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? m[1] : null; };
  const objects = new Map();
  for (const m of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const id = attr(m[1], 'id'), body = m[2];
    const V = [...body.matchAll(/<vertex\b([^>]*)\/?>/g)].map((v) => ['x', 'y', 'z'].map((a) => +attr(v[1], a) * unit));
    const T = [...body.matchAll(/<triangle\b([^>]*)\/?>/g)].map((t) => ['v1', 'v2', 'v3'].map((a) => +attr(t[1], a)));
    const comps = [...body.matchAll(/<component\b([^>]*)\/?>/g)].map((c) => ({ id: attr(c[1], 'objectid'), tf: attr(c[1], 'transform') }));
    objects.set(id, { V, T, comps });
  }
  const mat = (tf) => (tf ? tf.trim().split(/\s+/).map(Number) : null);
  const apply = (M, q) => (M ? [M[0] * q[0] + M[3] * q[1] + M[6] * q[2] + M[9] * unit, M[1] * q[0] + M[4] * q[1] + M[7] * q[2] + M[10] * unit, M[2] * q[0] + M[5] * q[1] + M[8] * q[2] + M[11] * unit] : q);
  const tris = [];
  const emit = (id, M, depth = 0) => {
    const o = objects.get(id);
    if (!o || depth > 8) return;
    for (const t of o.T) { const pts = t.map((i) => o.V[i]); if (pts.every(Boolean)) tris.push(pts.map((q) => apply(M, q))); }
    for (const c of o.comps) emit(c.id, c.tf ? mat(c.tf) : M, depth + 1);
  };
  const items = [...xml.matchAll(/<item\b([^>]*)\/?>/g)].map((m) => ({ id: attr(m[1], 'objectid'), tf: attr(m[1], 'transform') }));
  if (items.length) for (const it of items) emit(it.id, mat(it.tf));
  else for (const id of objects.keys()) emit(id, null);
  return tris;
}

// Mesh export: OBJ text, or a 3MF package (zip, stored).
function meshArrays(shape) {
  const b = bbox(shape), m = shape.mesh({ tolerance: Math.max(0.002, b.diag * 0.0002), angularTolerance: 0.1 });
  return { V: m.vertices, T: m.triangles };
}
function objText(parts) {
  const L = ['# RazorCAD OBJ export (millimetres)'];
  let base = 1;
  for (const { name, V, T } of parts) {
    L.push(`o ${String(name || 'Body').replace(/\s+/g, '_')}`);
    for (let i = 0; i < V.length; i += 3) L.push(`v ${+V[i].toFixed(6)} ${+V[i + 1].toFixed(6)} ${+V[i + 2].toFixed(6)}`);
    for (let i = 0; i < T.length; i += 3) L.push(`f ${T[i] + base} ${T[i + 1] + base} ${T[i + 2] + base}`);
    base += V.length / 3;
  }
  return L.join('\n') + '\n';
}
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zipStore(files) {
  const enc = new TextEncoder(), chunks = [], central = [];
  let off = 0;
  for (const [name, data0] of files) {
    const data = typeof data0 === 'string' ? enc.encode(data0) : data0, nb = enc.encode(name), crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true);
    chunks.push(new Uint8Array(h.buffer), nb, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nb.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), nb);
    off += 30 + nb.length + data.length;
  }
  const csize = central.reduce((s2, x) => s2 + x.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  const all = [...chunks, ...central, new Uint8Array(e.buffer)], out = new Uint8Array(all.reduce((s2, x) => s2 + x.length, 0));
  let at = 0;
  for (const x of all) { out.set(x, at); at += x.length; }
  return out;
}
function threeMF(parts) {
  const objs = parts.map((pt, i) => {
    const vs = [], ts = [];
    for (let k = 0; k < pt.V.length; k += 3) vs.push(`<vertex x="${+pt.V[k].toFixed(6)}" y="${+pt.V[k + 1].toFixed(6)}" z="${+pt.V[k + 2].toFixed(6)}"/>`);
    for (let k = 0; k < pt.T.length; k += 3) ts.push(`<triangle v1="${pt.T[k]}" v2="${pt.T[k + 1]}" v3="${pt.T[k + 2]}"/>`);
    return `<object id="${i + 1}" name="${String(pt.name || 'Body').replace(/[<>&"]/g, '_')}" type="model"><mesh><vertices>${vs.join('')}</vertices><triangles>${ts.join('')}</triangles></mesh></object>`;
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">RazorCAD</metadata><resources>${objs.join('')}</resources><build>${parts.map((_, i) => `<item objectid="${i + 1}"/>`).join('')}</build></model>`;
  return zipStore([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'],
    ['3D/3dmodel.model', model],
  ]);
}

// Interference: where solid bodies overlap (volume and a mesh of each overlap).
function interference() {
  const list = lastSolids.filter((r) => r.shape);
  const out = [], shapes = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j], ba = bbox(a.shape), bb = bbox(b.shape);
    if (!boxesTouch(ba, bb, 1e-6)) continue;
    let common = null;
    try { common = a.shape.intersect(b.shape); } catch (e) { if (isFatal(e)) throw e; continue; }
    const v = solidsOf(common).reduce((acc, x) => acc + R.measureVolume(x), 0);
    if (v > Math.max(1e-9, Math.min(volumeOf(a), volumeOf(b)) * 1e-9)) { out.push({ a: a.id, b: b.id, volume: v }); shapes.push(common); }
  }
  const diag = list.length ? bboxOfAll(list.map((r) => r.shape)).diag : 1;
  return { pairs: out, mesh: shapes.length ? meshData(shapes, diag) : null };
}

// Where the components of an assembly overlap: every two bodies of different components whose common volume
// is more than a hair (faces that only touch, as mated faces do, are no interference). Bodies are named by
// their path ("<component>/…/<body>"). Returns { pairs: [{ a, b, volume }], mesh (the overlaps) }.
async function asmInterference(docJson) {
  const { solids } = await assemblySolids(JSON.parse(docJson));
  const list = solids.map((r) => ({ ...r, owner: String(r.id).split('/').slice(0, -1).join('/'), box: bbox(r.shape) }));
  const out = [], shapes = [];
  for (let i = 0; i < list.length; i++) {
    progress(i / Math.max(1, list.length), 'Checking for interference…');
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.owner === b.owner || !boxesTouch(a.box, b.box, 1e-6)) continue;
      let common = null;
      try { common = a.shape.intersect(b.shape); } catch (e) { if (isFatal(e)) throw e; continue; }
      const v = solidsOf(common).reduce((acc, x) => acc + R.measureVolume(x), 0);
      if (v > Math.max(1e-6, Math.min(R.measureVolume(a.shape), R.measureVolume(b.shape)) * 1e-9)) { out.push({ a: a.id, b: b.id, volume: v }); shapes.push(common); }
    }
  }
  const diag = list.length ? bboxOfAll(list.map((r) => r.shape)).diag : 1;
  return { pairs: out, mesh: shapes.length ? meshData(shapes, diag) : null };
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The bodies in an imported STEP file: every solid on its own (a solid made of several separate
// closed shells is split into one body per shell), plus loose shells/faces as surface bodies.
function splitImported(shape) {
  const oc = R.getOC(), T = oc.TopAbs_ShapeEnum;
  const solids = [];
  for (const sol of shape.solids) {
    const shells = [...R.iterTopo(sol.wrapped, 'shell')];
    if (shells.length < 2) { solids.push(sol); continue; }
    const parts = shells.map((sh) => {
      const ms = new oc.BRepBuilderAPI_MakeSolid(sh);
      const s = R.cast(ms.Solid());
      ms.delete();
      oc.BRepLib.OrientClosedSolid(s.wrapped);
      return s;
    });
    // a shell inside another one is a cavity: keep that solid whole
    const boxes = parts.map((x) => bbox(x));
    const inside = (a, b) => [0, 1, 2].every((k) => a.min[k] >= b.min[k] - 1e-6 && a.max[k] <= b.max[k] + 1e-6);
    const nested = boxes.some((a, i) => boxes.some((b, j) => i !== j && inside(a, b)));
    if (nested) solids.push(sol); else solids.push(...parts);
  }
  const free = (kind, avoid) => {
    const out = [];
    const ex = new oc.TopExp_Explorer(shape.wrapped, T[kind], T[avoid]);
    while (ex.More()) { out.push(R.cast(ex.Current())); ex.Next(); }
    ex.delete();
    return out;
  };
  // shells outside any solid: a closed one is a solid all the same (some programs write their parts as a surface
  // model of closed shells); one that isn't closed is a surface
  const surfaces = [];
  for (const sh of free('TopAbs_SHELL', 'TopAbs_SOLID')) {
    const s = closedShellSolid(sh);
    if (s) solids.push(s); else surfaces.push(sh);
  }
  const faces = free('TopAbs_FACE', 'TopAbs_SHELL');
  if (faces.length) surfaces.push(asShape(faces));
  return { solids, surfaces };
}

// A shell as a solid when it is closed (every edge is used twice: by two faces, or a seam by its face both ways
// round), with its faces outward; null when it isn't, or the solid comes out with no volume.
function closedShellSolid(sh) {
  const oc = R.getOC(), T = oc.TopAbs_ShapeEnum;
  const uses = new Map(); // hash → [[edge, count]]
  const ex = new oc.TopExp_Explorer(sh.wrapped, T.TopAbs_EDGE, T.TopAbs_SHAPE);
  const held = [];
  try {
    for (; ex.More(); ex.Next()) {
      const e = ex.Current(), h = oc.ReplicadShapeHasher.HashCode(e, R.HASH_CODE_MAX);
      const list = uses.get(h) || [];
      const hit = list.find((x) => x[0].IsSame(e));
      if (hit) hit[1]++; else { const c = oc.TopoDS.Edge(e); held.push(c); list.push([c, 1]); uses.set(h, list); }
    }
    for (const list of uses.values()) for (const [, n] of list) if (n !== 2) return null;
  } finally { ex.delete(); held.forEach((x) => x.delete()); }
  try {
    const ms = new oc.BRepBuilderAPI_MakeSolid(oc.TopoDS.Shell(sh.wrapped));
    const s = R.cast(ms.Solid());
    ms.delete();
    oc.BRepLib.OrientClosedSolid(s.wrapped);
    return R.measureVolume(s) > 0 ? s : null;
  } catch (e) { if (isFatal(e)) throw e; return null; }
}

// The box round a shape's vertices: [x0, y0, z0, x1, y1, z1], or null when it has none (as stepasm.js
// measures a STEP solid or face, so the two can be matched).
function vertexBox(shape) {
  const oc = R.getOC(), T = oc.TopAbs_ShapeEnum;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const ex = new oc.TopExp_Explorer(shape, T.TopAbs_VERTEX, T.TopAbs_SHAPE);
  try {
    for (; ex.More(); ex.Next()) {
      const p = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(ex.Current()));
      const q = [p.X(), p.Y(), p.Z()];
      p.delete();
      for (let k = 0; k < 3; k++) { if (q[k] < lo[k]) lo[k] = q[k]; if (q[k] > hi[k]) hi[k] = q[k]; }
    }
  } finally { ex.delete(); }
  return isFinite(lo[0]) ? [...lo, ...hi] : null;
}
const boxNear = (a, b, tol) => !!a && !!b && a.every((v, k) => Math.abs(v - b[k]) <= tol);
const boxWithin = (a, b, tol) => !!a && !!b && [0, 1, 2].every((k) => a[k] >= b[k] - tol && a[k + 3] <= b[k + 3] + tol);
const lookTol = (box) => Math.max(1e-4, (box ? Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]) : 0) * 1e-6);

// An import's appearances (f.appearance) with their boxes turned as the import is into a part shown Z up: the
// file's (x, y, z) RazorCAD's (x, z, −y).
function turnedLooks(app) {
  if (!app) return app;
  const t = (b) => (b ? [b[0], b[2], -b[4], b[3], b[5], -b[1]] : b);
  return { ...app, ...(app.solids ? { solids: app.solids.map((e) => ({ ...e, b: t(e.b) })) } : {}), ...(app.faces ? { faces: app.faces.map((e) => ({ ...e, b: t(e.b) })) } : {}) };
}

// The look of each imported body (f.appearance from stepasm.js): { c, t, faces } or null, by shape.
// Solids are found by their vertex box (those without vertices, e.g. spheres, in file order); face looks go
// with the bodies they lie in, and meshPart finds each face by its own vertex box.
function importedLooks(app, shapes) {
  if (!app.solids) return shapes.map(() => (app.c != null || app.t ? { c: app.c ?? null, t: app.t || 0 } : null));
  const boxes = shapes.map((s) => vertexBox(s.wrapped));
  const out = shapes.map(() => null);
  const used = new Set();
  app.solids.forEach((e, ei) => {
    if (!e.b) return;
    const tol = lookTol(e.b);
    const i = boxes.findIndex((b, k) => !out[k] && boxNear(b, e.b, tol));
    if (i >= 0) { out[i] = { c: e.c ?? null, t: e.t || 0 }; used.add(ei); }
  });
  const restE = app.solids.filter((e, ei) => !used.has(ei)), restS = out.map((o, i) => (o ? -1 : i)).filter((i) => i >= 0);
  if (restE.length && restE.length === restS.length) restS.forEach((i, k) => { out[i] = { c: restE[k].c ?? null, t: restE[k].t || 0 }; });
  for (const e of app.faces || []) {
    if (!e.b) continue;
    const tol = lookTol(e.b);
    boxes.forEach((b, i) => { if (boxWithin(e.b, b, tol)) { out[i] ||= { c: null, t: 0 }; (out[i].faces ||= []).push(e); } });
  }
  return out;
}

// The corners where three or more of the given edges meet (their shared end points).
function cornersOf(edges, tol = 1e-5) {
  const ends = [];
  for (const e of edges) for (const q of [vec(e.startPoint), vec(e.endPoint)]) ends.push(q);
  const out = [];
  for (const q of ends) {
    if (out.some((c) => len(sub(c, q)) < tol)) continue;
    if (ends.filter((x) => len(sub(x, q)) < tol).length >= 3) out.push(q);
  }
  return out;
}
// Setback corners: round each corner where fillets meet, a ball of radius s is taken out of the filleted solid and
// the opening filled with a patch tangent to the faces round it, so the fillets run into the corner smoothly from
// that distance on. The solid (or an error when an opening could not be closed).
function setbackCorners(shape, corners, s) {
  if (!corners.length || !(s > 0)) return shape;
  let cut = shape;
  for (const c of corners) cut = cut.cut(R.makeSphere(s).translate(c));
  const tol = 1e-4 * Math.max(1, s);
  const onBall = (fc) => fc.geomType === 'SPHERE' && corners.some((c) => fc.edges.every((e) => [0, 0.5, 1].every((u) => Math.abs(len(sub(vec(e.pointAt(u)), c)) - s) < tol)));
  const keep = cut.faces.filter((fc) => !onBall(fc));
  if (keep.length === cut.faces.length) return shape; // (the balls did not reach the solid: nothing to blend)
  let sewn = sewShapes(keep, 1e-6);
  const { loops } = holeLoops(sewn), oc = R.getOC(), patches = [];
  for (const loop of loops) {
    const mk = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9);
    try {
      for (const e of loop.edges) {
        const sup = sewn.faces.find((fc) => fc.edges.some((x) => x.isSame(e)));
        if (sup) mk.Add(e.wrapped, sup.wrapped, oc.GeomAbs_Shape.GeomAbs_G1, true); else mk.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
      }
      mk.Build();
      patches.push(R.cast(mk.Shape()));
    } catch (e) { if (isFatal(e)) throw e; throw new Error('A setback corner could not be filled (try a smaller or larger setback)'); } finally { mk.delete(); }
  }
  sewn = sewShapes([sewn, ...patches], 1e-4);
  const sol = holeLoops(sewn).freeEdges === 0 ? solidFromSewn(sewn) : null;
  if (!sol) throw new Error('The setback corners could not be closed (try another setback)');
  return unify(sol);
}
// A fillet with its radius set at the vertices: each edge (in its run of edges) from the radius at its start to the
// one at its end. radAt(point) → the radius there. ptsOf(edge) (optional): points along that edge with a radius of
// their own, [{ t (share of its length from its start, 0 to 1), r }]: the radius then runs smoothly from the start
// through them to the end. The filleted shape, the vertices of the runs and where the points are.
function filletByVertex(shape, edges, radAt, ptsOf = null) {
  const oc = R.getOC();
  const mf = new oc.BRepFilletAPI_MakeFillet(shape.wrapped, oc.ChFi3d_FilletShape.ChFi3d_Rational);
  const vertices = [];
  const P = (v) => { const g = oc.BRep_Tool.Pnt(v); const q = [g.X(), g.Y(), g.Z()]; g.delete?.(); return q; };
  const note = (q) => { if (!vertices.some((x) => len(sub(x, q)) < 1e-6)) vertices.push(q); };
  const points = [];
  try {
    for (const e of edges) mf.Add(radAt(vec(e.startPoint)), e.wrapped);
    for (let ic = 1; ic <= mf.NbContours(); ic++) {
      let cur = P(mf.FirstVertex(ic));
      for (let k = 1; k <= mf.NbEdges(ic); k++) {
        const E = R.cast(mf.Edge(ic, k)), a = vec(E.startPoint), b = vec(E.endPoint);
        const own = len(sub(a, cur)) <= len(sub(b, cur)); // (the run goes the edge's own way)
        const [p0, p1] = own ? [a, b] : [b, a];
        const pts = (ptsOf?.(E) || []).filter((q) => q.t > 1e-6 && q.t < 1 - 1e-6);
        if (pts.length) {
          // the radius law along the edge, in the run's direction: (share of the length, radius) from end to end
          const law = [{ s: 0, r: radAt(p0) }, ...pts.map((q) => ({ s: own ? q.t : 1 - q.t, r: q.r })).sort((x, y) => x.s - y.s), { s: 1, r: radAt(p1) }];
          const arr = new oc.NCollection_Array1_gp_Pnt2d(1, law.length);
          law.forEach((q, i) => { const g = new oc.gp_Pnt2d(q.s, q.r); arr.SetValue(i + 1, g); g.delete(); });
          mf.SetRadius(arr, ic, k);
          arr.delete();
          for (const q of pts) points.push(atLength(E, q.t));
        } else mf.SetRadius(radAt(p0), radAt(p1), ic, k);
        note(p0); note(p1);
        cur = p1;
      }
    }
    mf.Build(new oc.Message_ProgressRange());
    if (!mf.IsDone()) throw new Error('The fillet could not be computed with these radii');
    return { shape: R.cast(mf.Shape()), vertices, points };
  } finally { mf.delete(); }
}
// An edge's length (along points close together, as atLength measures it).
function edgeLength(E) {
  const n = 64;
  let L = 0, prev = vec(E.pointAt(0));
  for (let i = 1; i <= n; i++) { const q = vec(E.pointAt(i / n)); L += len(sub(q, prev)); prev = q; }
  return L;
}
// The point of an edge a share t (0 to 1) of its length from its start.
function atLength(E, t) {
  const n = 64, q = Array.from({ length: n + 1 }, (_, i) => vec(E.pointAt(i / n))), L = [0];
  for (let i = 1; i <= n; i++) L.push(L[i - 1] + len(sub(q[i], q[i - 1])));
  const s = t * L[n];
  let i = 1;
  while (i < n && L[i] < s) i++;
  const f = (s - L[i - 1]) / ((L[i] - L[i - 1]) || 1);
  return vec(E.pointAt((i - 1 + f) / n)).map((x) => +x.toFixed(6));
}

// Faces sewn into shells (edges closer than tol joined); when nothing is left open, each shell made a solid. The
// sewn shape (the solid, or a compound of them).
function sewFaces(shape, tol = 0.01) {
  const oc = R.getOC();
  const sw = new oc.BRepBuilderAPI_Sewing(Math.max(1e-6, tol), true, true, true, false);
  sw.Add(shape.wrapped);
  sw.Perform(new oc.Message_ProgressRange());
  const sewn = R.cast(sw.SewedShape());
  const free = sw.NbFreeEdges();
  sw.delete();
  if (free) return sewn;
  const solids = [];
  for (const sh of R.iterTopo(sewn.wrapped, 'shell')) {
    try {
      const ms = new oc.BRepBuilderAPI_MakeSolid(sh);
      const solid = R.cast(ms.Solid());
      ms.delete();
      oc.BRepLib.OrientClosedSolid(solid.wrapped);
      if (R.measureVolume(solid) > 0) solids.push(solid);
    } catch { /* stays a surface */ }
  }
  if (!solids.length) return sewn;
  if (solids.length === 1) return solids[0];
  const builder = new oc.TopoDS_Builder(), comp = new oc.TopoDS_Compound();
  builder.MakeCompound(comp);
  for (const x of solids) builder.Add(comp, x.wrapped);
  builder.delete();
  return R.cast(comp);
}

// Asking the page while a request runs (kernelclient.js answers): { what, data } → its answer, or null when there is
// none in time
const asks = new Map();
let askSeq = 0;
function askPage(what, data, ms = 60000) {
  return new Promise((resolve) => {
    const id = ++askSeq;
    asks.set(id, resolve);
    self.postMessage({ type: 'ask', id, what, data });
    setTimeout(() => { if (asks.delete(id)) resolve(null); }, ms);
  });
}
// A big import is kept in the store of models built (the desktop app's model cache, the browser version's store) in
// OpenCascade's own format, keyed by a hash of the file (and, for a mesh, the triangle limit): read back several times
// quicker than the file (a dust collector's STEP, 342 bodies: 0.95 s instead of 4.6 s; 3DBenchy's STL, simplified and
// joined into a solid: 1.1 s instead of 8.1 s), wherever the part is built again (an assembly's part kernels, drawing
// views…; a part's tab keeps its feature states anyway). Smaller files are read as they are.
const IMPORT_STORE_MIN = 2e6; // characters of the file's text (a mesh's: base64)
async function importKey(text, extra) {
  try {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(extra + '|' + text));
    return 'imp' + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}
// Big feature data sent once, then named by the page ({ blob: id }: kernelclient.js packFeature): id → text, the texts
// the last rebuild's document names.
const BLOBS = new Map();
const featureData = (f) => (typeof f.data === 'object' && f.data?.blob ? BLOBS.get(f.data.blob) : f.data);
// (before a rebuild: the texts it was sent kept, the ones its document no longer names dropped; one it names but this
// kernel hasn't got: the page sends them all again)
function takeBlobs(doc, sent) {
  for (const [id, text] of sent || []) BLOBS.set(id, text);
  const named = new Set((doc.features || []).map((f) => (typeof f.data === 'object' && f.data?.blob) || null).filter(Boolean));
  for (const id of named) if (!BLOBS.has(id)) throw new Error(`Missing feature data (${id})`);
  for (const id of [...BLOBS.keys()]) if (!named.has(id)) BLOBS.delete(id);
}
async function importShape(f, timing = null) {
  const data = featureData(f);
  f = { ...f, data };
  const key = `${f.format}:${f.data.length}:${f.data.slice(0, 64)}:${f.data.slice(-64)}:${f.maxTris ?? ''}`;
  const hit = importCache.get(f.id);
  if (hit && hit.key === key) return hit.rec;
  progress(null, `Reading ${f.fileName || 'the imported file'}…`);
  const lim = f.maxTris == null || f.maxTris === '' ? MESH_MAX_TRIS : +f.maxTris;
  // (kept: the shape, and what the reading noted: a mesh simplified, left open)
  const sk = f.data.length >= IMPORT_STORE_MIN ? await importKey(f.data, f.format === 'step' ? 'step' : `${f.format}|${lim}`) : null;
  const got = sk ? await askPage('importGet', { key: sk }) : null;
  let rec = null;
  if (got?.brep) {
    try {
      const nl = got.brep.indexOf('\n'), meta = JSON.parse(got.brep.slice(0, nl));
      const tRead = performance.now();
      const shape = R.cast(R.getOC().BRepToolsWrapper.Read(got.brep.slice(nl + 1)));
      if (shape.faces.length) rec = { shape, dense: !!meta.dense, open: meta.open || 0, reduced: meta.reduced || null, stored: sk };
      if (rec) importReadMs.set(sk, performance.now() - tRead);
    } catch { rec = null; }
  }
  if (rec) timing?.imports.push([f.id, 'store']);
  else {
    let shape, dense = false, open = 0, reduced = null;
    if (f.format === 'step') shape = await R.importSTEP(new Blob([f.data]));
    else {
      if (f.format === 'obj') ({ shape, open, reduced } = trisToShape(parseOBJ(new TextDecoder().decode(b64ToBytes(f.data))), 'OBJ', lim));
      else if (f.format === '3mf') ({ shape, open, reduced } = trisToShape(await parse3MF(b64ToBytes(f.data)), '3MF', lim));
      else ({ shape, open, reduced } = stlToShape(b64ToBytes(f.data), lim));
      dense = faceCount(shape) > 2500;
    }
    rec = { shape, dense, open: open || 0, reduced: reduced || null };
    timing?.imports.push([f.id, 'file']);
    // (written for next time only where there is a store)
    if (got?.store) {
      try {
        const tw = performance.now(), brep = R.getOC().BRepToolsWrapper.Write(shape.wrapped);
        importReadMs.set(sk, performance.now() - tw); // (read back about as quickly)
        self.postMessage({ type: 'ask', id: 0, what: 'importPut', data: { key: sk, brep: JSON.stringify({ dense, open: rec.open, reduced: rec.reduced }) + '\n' + brep } });
        rec.stored = sk;
      } catch { /* not kept */ }
    }
  }
  importCache.set(f.id, { key, rec });
  return rec;
}

// ------------------------------------------------------------ rebuild
// previewId: the feature open in the Property panel. The model is rolled back to just
// before it and its effect is returned separately as preview meshes.
// opts.partial: only replay the features and return { solids, surfaces } (used by Shell to get
// the body without its small fillets); no meshing, no change to the exported state.
// After a feature is rebuilt: its references that could not be found (paths into the feature, for the
// Fix References dialog), and, when one was found again only after it moved, the feature's references
// sent back to the document.
function noteRefs(f, res) {
  const log = refLog;
  refLog = null;
  if (!log || f.type === 'sketch') return;
  const lost = new Set(log.lost.filter((r) => !log.found.has(r)));
  if (lost.size) {
    const paths = [];
    const walk = (x, path) => {
      if (!x || typeof x !== 'object' || path.length > 4) return;
      if (lost.has(x)) { paths.push(path); return; }
      for (const [k, v] of Object.entries(x)) walk(v, [...path, Array.isArray(x) ? +k : k]);
    };
    walk(f, []);
    if (paths.length) (res.missing ||= {})[f.id] = paths;
  }
  if (log.moved) {
    const u = {};
    for (const [k, v] of Object.entries(f)) if (v && typeof v === 'object') u[k] = v;
    res.features[f.id] = { ...u, ...(res.features[f.id] || {}) };
  }
}

async function rebuild(doc, previewId = null, opts = {}) {
  docUp = doc.upAxis === 'z' ? 'z' : 'y';
  const t0 = performance.now();
  // the active configuration: its variable values and the features it suppresses (or un-suppresses)
  const cfg = doc.activeConfig ? (doc.configs || []).find((c) => c.id === doc.activeConfig) : null;
  if (cfg) {
    const vals = cfg.vals || {}, sup = new Set(cfg.suppressed || []), unsup = new Set(cfg.unsuppressed || []);
    doc = {
      ...doc,
      equations: (doc.equations || []).map((e) => (e.name in vals && String(vals[e.name]).trim() !== '' ? { ...e, expr: String(vals[e.name]) } : e)),
      features: doc.features.map((f) => (sup.has(f.id) && !f.suppressed ? { ...f, suppressed: true } : unsup.has(f.id) && f.suppressed ? { ...f, suppressed: false } : f)),
    };
  }
  const { vars, errors: eqErrors } = evalEquations(doc.equations || []);
  const ev = (x) => evaluate(x, vars);
  // threads: cosmetic threads (shown and called out, not modelled) per feature: [{ internal, o, d, len, r, D, D1, P, label }]
  const res = { errors: [], sketches: {}, planes: {}, axes: {}, points: {}, curves: {}, notes: {}, detected: {}, features: {}, threads: {}, missing: {}, eqErrors: [...eqErrors], preview: null };
  const curves = new Map(); // curve features (helices): id -> { wire, axis, r, pitch, height }
  const planes = new Map();
  const sketches = new Map();
  const axes = new Map();
  const points = new Map();
  const tools = new Map();
  // (import features holding other parts of an assembly, for reference: Edit in Context; from the list, as features
  // restored from the rebuild cache are not run again)
  const contextFeats = new Set((doc.features || []).filter((f) => f.type === 'import' && f.context).map((f) => f.id));
  let applied = []; // tools applied by the current feature (for previews)
  let blendPair = null; // a fillet/chamfer on one body: that body before and after (for its preview)
  let body = null;    // all bodies together (one solid, or a compound of several)
  let solids = [];    // the bodies: [{ id, shape, box, last, feats }], `last` = feature that last changed it, `feats` = all that did
  let surfaces = [];  // surface bodies, same records (they don't take part in solid booleans)
  let cur = null;     // feature being rebuilt
  const usedIds = new Set();
  const newId = (base) => { let id = base, k = 2; while (usedIds.has(id)) id = `${base}.${k++}`; usedIds.add(id); return id; };
  // `from`: the records this body comes from (default: the body with this id, or the one it was split off)
  // (cull: a box known to hold the body, for skipping tools that can't reach it, e.g. the body's box before a cut;
  // the exact box is only worked out when it is asked for: OpenCascade's precise box is slow on big bodies)
  const bodyRec = (id, shape, last, from = null, cull = null) => {
    usedIds.add(id);
    const base = String(id).split('~')[0], find = (x) => solids.find((b) => b.id === x) || surfaces.find((b) => b.id === x);
    const feats = new Set();
    const prev = from || [find(id) || find(base)];
    for (const r of prev) for (const k of r?.feats || []) feats.add(k);
    feats.add(last);
    // sheet metal: the flat pattern goes along; when another kind of feature changes the body, the
    // pattern no longer matches it (it is kept, marked with that feature)
    let sheet = prev[0]?.sheet || null;
    if (sheet && last === cur?.id && !SHEET_TYPES.has(cur.type) && !sheet.stale) sheet = { ...sheet, stale: cur.name };
    const member = prev[0]?.member || null;
    // (the appearance an imported body came with: { c, t, faces } — kept through later features)
    const look = prev[0]?.look || null;
    const rec = { id, shape, last, feats: [...feats], sheet, ...(member ? { member } : {}), ...(look ? { look } : {}) };
    // (box: worked out on first use, then kept as a plain value; not written out with the feature states before)
    const keep = (b) => { Object.defineProperty(rec, 'box', { value: b, writable: true, enumerable: true, configurable: true }); return b; };
    Object.defineProperty(rec, 'box', { get: () => keep(bbox(shape)), set: keep, enumerable: false, configurable: true });
    if (cull) rec.cull = cull;
    return rec;
  };
  const cullBox = (rec) => rec.cull || boxOf(rec);
  let dense = false; // body contains a triangulated (STL) import with thousands of faces
  const needEdges = (what) => { if (dense) throw new Error(`${what} is not available on bodies made from dense STL meshes`); };

  const resolveFrame = (ref, plane) => {
    if (STD[ref]) return STD[ref];
    if (ref === 'face') return plane.frame;
    const fr = planes.get(ref);
    if (!fr) throw new Error('The reference plane is missing or failed');
    return fr;
  };
  // Add or cut a tool. Added material fuses with the bodies it touches (merge) or becomes
  // new bodies; a cut acts on every body it reaches and may split one into several.
  // scope: for a cut, the ids of the only bodies it may cut (null: every body it reaches)
  const inScope = (s, scope) => !scope || scope.some((b) => s.id === b || s.id.startsWith(b + '~'));
  const apply = (op, tool, merge = true, scope = null) => {
    applied.push({ op, tool });
    // (a cut that can wait: made with the others, in one boolean, when the body is next needed)
    if (op === 'cut' && deferNow && !scope && solids.length) { pending.push({ tool, fid: cur.id }); return; }
    const fid = cur.id;
    if (op === 'add') {
      for (const t of solidsOf(tool)) {
        // (the box only when there are bodies it could merge with)
        let merged = t, mbox = merge && solids.length ? bbox(t) : null;
        const tol = mbox ? Math.max(1e-6, mbox.diag * 1e-7) : 0;
        const touched = [];
        if (mbox) {
          for (const s of solids) {
            if (s.sheet || !boxesTouch(boxOf(s), mbox, tol)) continue;
            const r = merged.fuse(s.shape);
            if (solidsOf(r).length === 1) { merged = r; mbox = bbox(r); touched.push(s); }
          }
        }
        if (touched.length) {
          const at = solids.indexOf(touched[0]);
          const next = solids.filter((s) => !touched.includes(s));
          next.splice(Math.min(at, next.length), 0, bodyRec(touched[0].id, merged, fid, touched));
          solids = next;
        } else solids.push(bodyRec(newId(fid), t, fid));
      }
    } else if (op === 'intersect') {
      // (Intersect: each body the tool overlaps keeps only what lies inside it, bodies it misses stay as they are;
      // with a scope, the chosen bodies are intersected and one the tool misses is removed)
      if (!solids.length) throw new Error('There is no body to intersect');
      const tb = bbox(tool), tol = Math.max(1e-6, tb.diag * 1e-7);
      const next = [];
      let kept = 0;
      for (const s of solids) {
        const chosen = scope ? inScope(s, scope) : boxesTouch(cullBox(s), tb, tol);
        if (!chosen) { next.push(s); continue; }
        if (s.sheet) throw new Error('Intersect does not work on sheet metal bodies');
        const pieces = solidsOf(s.shape.intersect(tool)).map((shape) => ({ shape, vol: null }));
        if (!pieces.length) { if (!scope) next.push(s); continue; }
        if (pieces.length > 1) pieces.sort((x, y) => volumeOf(y) - volumeOf(x));
        kept++;
        pieces.forEach((pc, k) => next.push(bodyRec(k ? newId(`${s.id}~${k + 1}`) : s.id, pc.shape, fid)));
      }
      if (!kept) throw new Error('The feature does not overlap any body to intersect');
      solids = next;
    } else {
      if (!solids.length) throw new Error('There is no body to cut');
      const tb = bbox(tool), tol = Math.max(1e-6, tb.diag * 1e-7);
      const next = [];
      for (const s of solids) {
        if (!inScope(s, scope) || !boxesTouch(cullBox(s), tb, tol)) { next.push(s); continue; }
        if (s.sheet && !s.sheet.stale) {
          // sheet metal: the cut becomes a hole in the flat pattern, and the part is folded again
          try {
            const r = SM.cutSheet(s.sheet, tool);
            if (!r.hit) { next.push(s); continue; }
            // (Kernel Lab: folded later when the next feature can do without the folded body)
            const wait = labSheetCanWait(labNext);
            const rec = wait ? bodyRec(s.id, s.shape, fid) : bodyRec(s.id, SM.toSolid(r.sheet), fid);
            rec.sheet = r.sheet;
            if (wait) { rec.sheetPending = true; LAB_SHEETS.deferred++; }
            next.push(rec);
            continue;
          } catch (e) {
            if (isFatal(e)) throw e;
            // fall back to an ordinary cut; the flat pattern no longer matches (see below)
          }
          // (Kernel Lab: the ordinary cut needs the body as it is: its waiting fold made, in place)
          if (s.sheetPending) { s.shape = SM.toSolid(s.sheet); s.box = bbox(s.shape); delete s.sheetPending; LAB_SHEETS.refolds++; }
        }
        // (a tool of several solids, e.g. a pattern's copies or cuts made together: cut as a list, so copies that
        // overlap each other are cut right; in one compound the overlap would be left standing)
        const parts = solidsOf(tool);
        const pieces = solidsOf(parts.length > 1 ? cutByList(s.shape, parts) : s.shape.cut(tool)).map((shape) => ({ shape, vol: null }));
        if (pieces.length > 1) pieces.sort((x, y) => volumeOf(y) - volumeOf(x));
        const cull = cullBox(s);
        pieces.forEach((pc, k) => {
          let last = fid;
          // (the cut missed this body: as many faces and the same volume; a cut that changed the faces hit it)
          if (pieces.length === 1 && faceCount(pc.shape) === faceCount(s.shape)) {
            const v0 = volumeOf(s), v1 = volumeOf(pc);
            if (Math.abs(v1 - v0) <= Math.abs(v0) * 1e-9) last = s.last;
          }
          next.push(bodyRec(k ? newId(`${s.id}~${k + 1}`) : s.id, pc.shape, last, null, cull));
        });
      }
      solids = next;
    }
    body = compoundOf(solids);
  };
  // Many copies of an added shape at once (a pattern): each body fused with all the copies that reach it in one
  // boolean (one after another, the body grows with every copy and each fuse gets slower), copies that reach
  // no body made bodies of their own. Throws when it is not that simple (a copy reaching two bodies, loose
  // copies reaching each other, a copy left apart by the fuse): the caller then adds them one by one.
  const addAll = (copies) => {
    const fid = cur.id;
    const pieces = copies.flatMap((c) => solidsOf(c)).map((shape) => ({ shape, box: bbox(shape) }));
    const tolOf = (b) => Math.max(1e-6, b.diag * 1e-7);
    const groups = new Map(), free = [];
    for (const pc of pieces) {
      const hit = solids.filter((x) => !x.sheet && boxesTouch(boxOf(x), pc.box, tolOf(pc.box)));
      if (hit.length > 1) throw new Error('A copy reaches two bodies');
      if (hit.length) { if (!groups.has(hit[0])) groups.set(hit[0], []); groups.get(hit[0]).push(pc); } else free.push(pc);
    }
    for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) if (boxesTouch(free[i].box, free[j].box, tolOf(free[i].box))) throw new Error('Loose copies reach each other');
    const next = [...solids];
    for (const [rec, ps] of groups) {
      const r = rec.shape.fuse(compoundOf(ps));
      if (solidsOf(r).length !== 1) throw new Error('A copy stays apart from the body');
      next[next.indexOf(rec)] = bodyRec(rec.id, r, fid, [rec]);
    }
    for (const pc of free) next.push(bodyRec(newId(fid), pc.shape, fid));
    solids = next;
    body = compoundOf(solids);
    for (const c of copies) applied.push({ op: 'add', tool: c });
  };
  // After an operation on all bodies together (fillet, chamfer), find each body again.
  const remapSolids = (shape, changedPts) => {
    const parts = solidsOf(shape);
    const near = (box, p) => boxesTouch(box, { min: p, max: p }, box.diag * 1e-3 + 1e-6);
    if (parts.length === solids.length) {
      const pool = parts.map((shape) => ({ shape, box: bbox(shape) }));
      solids = solids.map((s) => {
        let bi = 0, bd = Infinity;
        pool.forEach((q, i) => { if (!q) return; const d = len(sub(q.box.center, boxOf(s).center)) + Math.abs(q.box.diag - boxOf(s).diag); if (d < bd) { bd = d; bi = i; } });
        const q = pool[bi]; pool[bi] = null;
        return bodyRec(s.id, q.shape, changedPts.some((p) => near(boxOf(s), p)) ? cur.id : s.last);
      });
    } else solids = parts.map((shape, i) => bodyRec(solids[i]?.id ?? newId(cur.id), shape, cur.id));
    body = compoundOf(solids);
  };
  const sweepWire=(ref,label,owned)=>{
    if(!ref)throw new Error(`Select the sweep ${label}`);
    if(typeof ref==='string'&&curves.has(ref)){const curve=curves.get(ref);return {wire:curve.wire,helical:!curve.route};}
    const source=sketches.get(LR.sourceId(ref));
    if(!source)throw new Error(`The sweep ${label} is missing, suppressed or has errors`);
    const subset=typeof ref==='string'?source.sk:LR.resolveContour(source.sk,ref,true).sketch;
    const wires=sketchWires(subset,source.frame);owned.push(...wires);
    if(wires.length!==1)throw new Error(`The sweep ${label} must be one connected chain of curves`);
    return {wire:wires[0],helical:false};
  };
  const checkSweepRefs=f=>{
    if(f.profileType!=='circle'&&LR.overlappingRefs(f.profile,f.path))throw new Error('Choose different entities for the sweep profile and path');
    if(f.guide&&(LR.overlappingRefs(f.guide,f.path)||f.profileType!=='circle'&&LR.overlappingRefs(f.guide,f.profile)))throw new Error('Choose different sources or entities for the sweep profile, path and guide');
  };

  // thin: { t, dir } makes walls along the sketch curves instead of filling closed profiles
  // drawing: the 2D profile (closed regions, with any text) to extrude / revolve / project
  const getSketch = (id, thin = null) => {
    if (!id) throw new Error('Select a sketch');
    let s = sketches.get(LR.sourceId(id));
    if (!s) throw new Error('The sketch is missing, suppressed or has errors');
    const sourceSketch = s.sk;
    let selected = null;
    if (typeof id !== 'string') {
      selected = LR.resolveContour(s.sk, id);
      s = { ...s, sk: selected.sketch };
    }
    if (thin) { const regions = S.thinRegions(s.sk, thin.t, thin.dir); return { ...s, sourceSketch, regions, drawing: regionsDrawing(regions) }; }
    const regions = selected?.region ? [selected.region] : S.profileRegions(s.sk);
    const text = selected ? null : textDrawing(s.sk);
    const gears = selected ? [] : [...gearDrawings(s.sk), ...airfoilDrawings(s.sk)]; // (generated outlines, each made on its own)
    if (!regions.length && !text && !gears.length) throw new Error(s.sk.curves.some((c) => !c.construction) ? 'The sketch has no closed profile — tick Thin Feature to use open curves' : 'The sketch has no closed profile');
    return { ...s, sourceSketch, regions, drawing: regions.length ? regionsDrawing(regions) : null, text, gears };
  };
  // A flat model face as a profile (a profiles entry { kind: 'modelFace', p, n, body }): the face itself, holes and
  // all, in place of a sketch's regions. Its plane is the profile plane, facing out of its body; `drawing` stands in
  // for a sketch drawing (sketchOnPlane(plane).extrude(d) / .revolve(axis, { origin, angle })), the face moved to
  // the plane's origin along its normal
  const faceSection = (ref, thin) => {
    if (thin) throw new Error('Thin Feature works on sketch curves: a model face cannot be a thin profile');
    needEdges('Picking a model face');
    const hit = findFaceAny(solids, ref);
    if (!hit) throw new Error('A profile face could not be found in the model');
    if (hit.face.geomType !== 'PLANE') throw new Error('A profile face must be flat');
    const face = hit.face, n = unit(vec(face.normalAt())), frame = frameOnPlane(vec(face.center), n);
    ref.n = n; if (hit.body?.id) ref.body = hit.body.id;
    const drawing = {
      sketchOnPlane: (pl) => {
        const shift = sub([pl.origin.x, pl.origin.y, pl.origin.z], frame.o), at = len(shift) > 1e-12 ? face.clone().translate(shift) : face.clone();
        return {
          extrude: (d) => { const v = new R.Vector(mul([pl.zDir.x, pl.zDir.y, pl.zDir.z], d)); try { return R.basicFaceExtrusion(at, v); } finally { v.delete(); at.delete(); } },
          revolve: (axis, { origin, angle } = {}) => { try { return R.revolution(at, origin, axis, angle ?? 360); } finally { at.delete(); } },
        };
      },
    };
    // (how far it reaches from the plane's origin, and points round its edges: for the revolve axis check)
    const b = bbox(face);
    let reach = 0;
    for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) reach = Math.max(reach, len(sub([x, y, z], frame.o)));
    const pts = face.edges.flatMap((e) => Array.from({ length: 17 }, (_, i) => vec(e.pointAt(i / 16))));
    return { frame, faceProfile: true, regions: [], drawing, text: null, gears: [], reach, pts };
  };
  const isFaceProfile = (ref) => !!ref && typeof ref === 'object' && ref.kind === 'modelFace';
  const sectionOf = (ref, thin) => (isFaceProfile(ref) ? faceSection(ref, thin) : getSketch(ref, thin));
  // A surface extrusion's or revolution's contours: { frame, planar, wires: [{ wire, closed }], pts? } for each sketch
  // contour, flat model face (its outer and inner edges) and the chains of the picked model edges (f.edges)
  const surfaceSections = (f, revolve = false) => {
    const refs = Array.isArray(f.profiles) ? f.profiles : f.sketch ? [f.sketch] : [], out = [];
    if (!refs.length && !f.edges?.length) throw new Error('Select one or more surface contours, or model edges');
    for (const ref of refs) {
      if (isFaceProfile(ref)) {
        needEdges('Picking a model face');
        const hit = findFaceAny([...solids, ...surfaces], ref);
        if (!hit) throw new Error('A contour face could not be found in the model');
        if (hit.face.geomType !== 'PLANE') throw new Error('A contour face must be flat');
        const n = unit(vec(hit.face.normalAt())), frame = frameOnPlane(vec(hit.face.center), n);
        ref.n = n; if (hit.body?.id) ref.body = hit.body.id;
        const wires = [hit.face.clone().outerWire(), ...hit.face.clone().innerWires()];
        const pts = hit.face.edges.flatMap((e) => Array.from({ length: 17 }, (_, i) => vec(e.pointAt(i / 16))));
        out.push({ frame, planar: true, wires: wires.map((wire) => ({ wire, closed: true })), pts });
        continue;
      }
      const source = sketches.get(LR.sourceId(ref));
      if (!source) throw new Error('A surface profile sketch is missing');
      const subset = typeof ref === 'string' ? source.sk : LR.resolveContour(source.sk, ref).sketch;
      // (a revolve's axis line, when it is in the sketch, is not part of the surface)
      const axisLine = revolve ? (f.axis === 'sketchLine' ? (f.axisSketch?.sketch === LR.sourceId(ref) ? f.axisSketch.curve : null) : f.axis) : null;
      const curvesOf = axisLine ? { ...subset, curves: subset.curves.filter((c) => c.id !== axisLine) } : subset;
      const chains = S.curveChains(curvesOf), wires = sketchWires(curvesOf, source.frame);
      out.push({ ...source, sk: subset, sourceSketch: source.sk, id: LR.sourceId(ref), planar: true, chains, wires: wires.map((wire, i) => ({ wire, closed: !!chains[i]?.closed })) });
    }
    if (f.edges?.length) out.push(edgeSection(f));
    return out;
  };
  // The picked model edges (f.edges: { p, body }) joined end to end into chains, open or closed, without branches; their
  // plane when they lie in one (facing out of the face it is, when it is one; else none: planar false)
  const edgeSection = (f) => {
    needEdges('Picking a model edge');
    const all = [...solids, ...surfaces], edges = [];
    for (const ref of f.edges) {
      const owners = ref.body ? all.filter((b) => b.id === ref.body) : all;
      const found = owners.map((b) => ({ body: b, hit: findEdgeInfo(b.shape, ref) })).filter((x) => x.hit);
      if (found.length !== 1) throw new Error('A selected model edge is missing or ambiguous');
      const { body, hit } = found[0];
      if (edges.some((x) => x.edge.isSame(hit.e))) throw new Error('A model edge is selected more than once');
      ref.body = body.id; updateEdgeRef(ref, hit.e, body.shape); edges.push({ edge: hit.e, body });
    }
    res.features[f.id] = { ...(res.features[f.id] || {}), edges: f.edges };
    const near = (p, q) => len(sub(p, q)) < 1e-5, ends = (e) => [vec(e.startPoint), vec(e.endPoint)];
    // (each chain's edges in order, each with reverse: whether it is followed from its curve's end to its start)
    const left = [...edges], chains = [];
    while (left.length) {
      const chain = [{ ...left.shift(), reverse: false }];
      let [head, tail] = ends(chain[0].edge);
      while (!near(head, tail)) {
        const at = (q) => left.flatMap((x, i) => (ends(x.edge).some((p) => near(p, q)) ? [i] : []));
        const t = at(tail), h = at(head);
        if (t.length > 1 || h.length > 1) throw new Error('The selected model edges branch: pick chains without branches');
        if (t.length) { const [x] = left.splice(t[0], 1), [s, e] = ends(x.edge), reverse = !near(s, tail); chain.push({ ...x, reverse }); tail = reverse ? s : e; }
        else if (h.length) { const [x] = left.splice(h[0], 1), [s, e] = ends(x.edge), reverse = !near(e, head); chain.unshift({ ...x, reverse }); head = reverse ? e : s; }
        else break;
      }
      chains.push({ edges: chain, closed: near(head, tail), start: head, end: tail });
    }
    const pts = edges.flatMap(({ edge }) => Array.from({ length: 17 }, (_, i) => vec(edge.pointAt(i / 16))));
    const c = mul(pts.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / pts.length), b = bbox(asShape(edges.map((x) => x.edge))), scale = b.diag || 1;
    const p1 = pts.reduce((best, p) => (len(sub(p, c)) > len(sub(best, c)) ? p : best), pts[0]);
    const p2 = pts.reduce((best, p) => (len(cross(sub(p1, c), sub(p, c))) > len(cross(sub(p1, c), sub(best, c))) ? p : best), pts[0]);
    let n = cross(sub(p1, c), sub(p2, c));
    const planar = len(n) > 1e-9 * scale * scale && pts.every((p) => Math.abs(dot(sub(p, c), unit(n))) < 1e-6 * (1 + scale));
    let frame = null;
    if (planar) {
      n = unit(n);
      // (facing out of a flat face of the body that the first edge borders, in the edges' plane; else up)
      const face = adjacentFaces(edges[0].body.shape, edges[0].edge).find((fc) => fc.geomType === 'PLANE' && Math.abs(dot(unit(vec(fc.normalAt())), n)) > 1 - 1e-9);
      if (face) n = unit(vec(face.normalAt()));
      else { const k = [0, 1, 2].reduce((m, i) => (Math.abs(n[i]) > Math.abs(n[m]) ? i : m), 0); if (n[k] < 0) n = mul(n, -1); }
      frame = frameOnPlane(c, n);
    }
    return { frame, planar, centre: c, pts, chains, wires: chains.map((ch) => ({ wire: chainWire(ch), closed: ch.closed })) };
  };
  // A chain of model edges as a wire, followed from its start (or, backwards, from its end)
  const chainWire = (chain, backwards = false) => {
    const list = backwards ? [...chain.edges].reverse().map((x) => ({ ...x, reverse: !x.reverse })) : chain.edges, flipped = [];
    try {
      return R.assembleWire(list.map(({ edge, reverse }) => { if ((edge.orientation === 'backward') === reverse) return edge; const e = edge.flipOrientation(); flipped.push(e); return e; }));
    } finally { flipped.forEach((e) => e.delete()); }
  };
  // A sweep's path: its sketch or curve, or the picked model edges (f.edges) joined into one chain, followed from the end
  // in the profile's plane (frame) when only that one is
  const sweepPath = (f, owned, frame = null) => {
    if (!f.edges?.length) return sweepWire(f.path, 'path', owned);
    if (f.path) throw new Error('Choose one path: a sketch or curve, or model edges');
    const sec = edgeSection(f);
    sec.wires.forEach((w) => w.wire.delete());
    if (sec.chains.length !== 1) throw new Error('The path’s model edges must join into one chain');
    const ch = sec.chains[0], off = (p) => (frame ? Math.abs(dot(sub(p, frame.o), frame.n)) : 0);
    const wire = chainWire(ch, !ch.closed && off(ch.end) < 1e-6 && off(ch.start) > 1e-6);
    owned.push(wire);
    return { wire, helical: false };
  };
  // A Sweep's or Surface Sweep's options: orientation 'perpendicular' (twistAngle, twistLaw), 'parallel' or 'surface' (the
  // profile kept square to the picked supportFaces), and the profile scaled along the path to scaleEnd (scaleLaw)
  const sweepOptions = (f, spine, guide) => {
    const orientation = guide ? 'perpendicular' : f.orientation || 'perpendicular';
    if (!['perpendicular', 'parallel', 'surface'].includes(orientation)) throw new Error('Select Perpendicular, Parallel or Square to faces as the sweep orientation');
    const twist = guide || orientation !== 'perpendicular' ? 0 : ev(f.twistAngle ?? 0), end = ev(f.scaleEnd ?? 1);
    if (!Number.isFinite(twist)) throw new Error('The twist angle must be finite');
    if (!(Number.isFinite(end) && end > 0)) throw new Error('The end scale must be greater than zero');
    const scaled = Math.abs(end - 1) > 1e-12;
    if (scaled && guide) throw new Error('A guide sets the section’s size: leave the end scale at 1 with a guide');
    let support = null;
    if (orientation === 'surface') {
      const refs = f.supportFaces || [];
      if (!refs.length) throw new Error('Select the faces the profile follows');
      needEdges('Picking a model face');
      const hits = refs.map((r) => findFaceAny([...solids, ...surfaces], r));
      if (hits.some((h) => !h)) throw new Error('A face the profile follows could not be found');
      support = hits.length > 1 ? asShape(hits.map((h) => h.face)) : hits[0].face;
      res.features[f.id] = { ...(res.features[f.id] || {}), supportFaces: refs };
    }
    return { orientation, twist, twistLaw: f.twistLaw || 'linear', support, scale: scaled ? scaleLaw(R, spine, end, f.scaleLaw || 'linear') : null };
  };
  const sweepAlong = (w, spine, o, { surface = false, helical = false } = {}) => {
    if (o.orientation === 'parallel' || o.twist !== 0) return sweepWithOrientation(R, w, spine, o.orientation, o.twist, surface, nearFacePoint, { scale: o.scale, twistLaw: o.twistLaw });
    for (const transitionMode of ['right', 'round', 'transformed']) {
      try { const r = R.genericSweep(w, spine, { frenet: helical && !o.support, transitionMode, law: o.scale?.law || null, support: o.support?.wrapped }, surface); return surface ? r[0] : r; } catch (e) { if (isFatal(e)) throw e; }
    }
    throw new Error(o.support ? 'The profile could not be swept along the path following those faces (the path should lie on them)' : 'The profile could not be swept along the path (place the profile at the start of the path, across it)');
  };
  // The solid a feature makes from a sketch profile: make(drawing) for the outlines and for the text,
  // combined so text inside an outline is cut out of it (and text outside it is added).
  const profileSolid = (sk, make) => {
    const a = sk.drawing ? make(sk.drawing) : null;
    let t = sk.text ? make(sk.text) : null;
    // gears: each made on its own (one 2D boolean over hundreds of tooth edges would be slow), bores cut in 3D
    if (sk.gears?.length) {
      const gs = sk.gears.map((g) => { let sol = make(g.outline); if (g.bore) sol = sol.cut(make(g.bore)); return sol; });
      const all = asShape(gs);
      t = t ? t.fuse(all) : all;
    }
    if (!a || !t) return a || t;
    let out = a.cut(t);
    try { const outside = t.cut(a); if (solidsOf(outside).length) out = out.fuse(outside); } catch (e) { if (isFatal(e)) throw e; }
    return out;
  };
  // An extrusion's side walls drafted: every face but its two flat ends tilted by `ang` degrees about where it meets
  // the plane through `o` square to `up` (the profile's plane), narrowing along `up` (a negative angle: widening).
  // ends: the planes { p, n } of its ends when they are not square to `up` (an end on an angled surface), and
  // neutral: the plane { p, n } the walls tilt about when it is not the one square to `up` (an angled start)
  const draftPrism = (tool, o, up, ang, ends = null, neutral = null) => {
    const oc = R.getOC();
    const nn = neutral ? unit(neutral.n) : up, np = neutral ? neutral.p : o;
    const D = new oc.gp_Dir(up[0], up[1], up[2]), N = new oc.gp_Dir(nn[0], nn[1], nn[2]), P = new oc.gp_Pnt(np[0], np[1], np[2]);
    const pln = new oc.gp_Pln(P, N);
    const mk = new oc.BRepOffsetAPI_DraftAngle(tool.wrapped);
    const onPlane = (face, e) => face.geomType === 'PLANE' && Math.abs(dot(unit(vec(face.normalAt())), unit(e.n))) > 1 - 1e-9 && Math.abs(dot(sub(flatCentre(face), e.p), unit(e.n))) < 1e-6;
    const isEnd = (face) => (ends ? ends.some((e) => onPlane(face, e)) : face.geomType === 'PLANE' && Math.abs(dot(unit(vec(face.normalAt())), up)) > 1 - 1e-9);
    // (an end's faces: their area, and whether they lie wholly on the far side of the neutral plane, along `up`)
    const endAreas = (shape) => ends.map((e) => {
      let area = 0, far = true;
      for (const face of shape.faces) {
        if (!onPlane(face, e)) continue;
        area += R.measureArea(face);
        const b = bbox(face);
        for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) if (dot(sub([x, y, z], np), nn) * Math.sign(dot(nn, up)) < 1e-7) far = false;
      }
      return { area, far };
    });
    try {
      const before = ends ? endAreas(tool) : null;
      for (const face of tool.faces) {
        if (isEnd(face)) continue;
        mk.Add(face.wrapped, D, (ang * Math.PI) / 180, pln, true);
        if (!mk.AddDone()) throw new Error('A wall of this profile cannot be drafted');
      }
      mk.Build();
      const out = R.cast(mk.Shape());
      // (walls tilted until they cross make a shape that is not a solid, or one that runs through itself past the
      // point where they meet: OpenCascade's self-interference check, LabToolCheck, finds those)
      const check = new oc.BRepCheck_Analyzer(out.wrapped, true);
      try { if (!solidsOf(out).length || !check.IsValid()) throw new Error('The draft could not be made'); } finally { check.delete(); }
      if (oc.LabToolCheck && oc.LabToolCheck.Interferences(out.wrapped, 0) > 0) throw new Error('The draft could not be made');
      if (ends) {
        // (angled ends: each end wholly past the neutral plane smaller than before, or larger drafted outward; and no
        // wall's cone may have its tip on the shape, where walls that meet and go on touch)
        endAreas(out).forEach((a, k) => { if (before[k].far && before[k].area > 0 && !(ang > 0 ? a.area < before[k].area : a.area > before[k].area)) throw new Error('The draft could not be made'); });
        for (const face of out.faces) {
          if (face.geomType !== 'CONE') continue;
          const ad = new oc.BRepAdaptor_Surface(face.wrapped, true);
          let A = null;
          try { const c = ad.Cone(); if (typeof c.Apex === 'function') { const q = c.Apex(); A = [q.X(), q.Y(), q.Z()]; q.delete?.(); } } finally { ad.delete(); }
          if (!A) continue;
          const g = new oc.gp_Pnt(A[0], A[1], A[2]), mv = new oc.BRepBuilderAPI_MakeVertex(g), t = new oc.BRepExtrema_DistShapeShape();
          try {
            t.LoadS1(mv.Vertex()); t.LoadS2(out.wrapped); t.Perform();
            if (t.IsDone() && t.NbSolution() > 0 && t.Value() < 1e-6) throw new Error('The draft could not be made');
          } finally { t.delete(); mv.delete(); g.delete(); }
        }
        return out;
      }
      // (nor do walls that meet and go on: a cone through its tip, which leaves a valid double cone. So no wall's cone
      // may have its tip between the ends, and the far end must be smaller than the profile, or larger drafted outward)
      const height = (face) => dot(sub(flatCentre(face), o), up);
      let far = 0, near = 0, top = 0;
      const caps = [];
      for (const face of out.faces) {
        if (face.geomType === 'PLANE' && Math.abs(dot(unit(vec(face.normalAt())), up)) > 1 - 1e-9) { const h = height(face); caps.push([h, R.measureArea(face)]); top = Math.max(top, h); }
      }
      for (const [h, a] of caps) { if (h > top - 1e-7) far += a; else if (Math.abs(h) < 1e-7) near += a; }
      if (!(ang > 0 ? far < near : far > near)) throw new Error('The draft could not be made');
      for (const face of out.faces) {
        if (face.geomType !== 'CONE') continue;
        const ad = new oc.BRepAdaptor_Surface(face.wrapped, true);
        let h = null;
        try { const c = ad.Cone(); if (typeof c.Apex === 'function') { const A = c.Apex(); h = dot(sub([A.X(), A.Y(), A.Z()], o), up); } } finally { ad.delete(); }
        if (h != null && h > 1e-7 && h < top - 1e-7) throw new Error('The draft could not be made');
      }
      return out;
    } catch (e) {
      if (isFatal(e)) throw e;
      throw new Error(e.message?.startsWith('A wall') ? e.message : 'The draft could not be made (the walls meet too soon at this angle and depth, or one of them cannot tilt)');
    } finally { mk.delete(); pln.delete(); P.delete(); N.delete(); D.delete(); }
  };
  // A solid between angled ends drafted away from its neutral plane { p, n } along `axis` on each side of it: one
  // side as it is, a solid across the plane split there and each half drafted away from it (as a symmetric one)
  const draftAway = (tool, neutral, axis, ang, ends) => {
    const n = unit(mul(neutral.n, dot(neutral.n, axis) < 0 ? -1 : 1)), b = bbox(tool), big = b.diag + len(sub(b.center, neutral.p)) + 100;
    const half = (s) => {
      const nn = mul(n, s), u = unit(cross(nn, Math.abs(nn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
      return solidsOf(tool.intersect(R.drawRectangle(2 * big, 2 * big).sketchOnPlane(new R.Plane(neutral.p, u, nn)).extrude(2 * big)));
    };
    const parts = [];
    for (const s of [1, -1]) {
      const pieces = half(s);
      if (!pieces.length) continue;
      const piece = pieces.length > 1 ? compoundOf(pieces.map((shape) => ({ shape }))) : pieces[0];
      parts.push(draftPrism(piece, neutral.p, mul(axis, s * Math.sign(dot(n, axis))), ang, [...ends, neutral], neutral));
    }
    if (!parts.length) throw new Error('The draft could not be made');
    return parts.slice(1).reduce((acc, x) => acc.fuse(x), parts[0]);
  };

  // world-space point from a reference: reference point feature or model vertex ref
  const resolvePoint = (featureId, vertexRef) => {
    if (featureId) {
      const p = points.get(featureId);
      if (!p) throw new Error('The reference point is missing or failed');
      return p;
    }
    if (!vertexRef) throw new Error('Select a vertex or reference point');
    needEdges('Picking a model vertex');
    const v = findVertex(body, vertexRef);
    if (!v) throw new Error('The selected vertex could not be found in the model');
    vertexRef.p = v;
    const b = bbox(body);
    vertexRef.box = { min: b.min, max: b.max };
    return v;
  };
  // plane { p, n } from a plane reference or a planar model face ref
  const resolveSurface = (planeId, faceRef) => {
    if (planeId) { const fr = resolveFrame(planeId); return { p: fr.o, n: fr.n }; }
    if (!faceRef) throw new Error('Select a surface (plane or flat model face)');
    needEdges('Picking a model face');

    const hit = findFace(body, faceRef);
    if (!hit) throw new Error('The selected face could not be found in the model');
    return hit;
  };
  // geometry of a plane reference: { kind: 'plane', p, n, frame? } | { kind: 'line', d, start, end, mid } | { kind: 'point', p }
  const resolveRefGeom = (r) => {
    if (r.kind === 'plane') { const fr = resolveFrame(r.id); return { kind: 'plane', p: fr.o, n: fr.n, frame: fr }; }
    if (r.kind === 'face' && !r.n) {
      // a cylindrical face: its axis and radius
      const hit = findFaceAny([...solids, ...surfaces], r);
      const s = hit && surfOf(hit.face);
      if (s?.t !== 'CYLINDER') throw new Error('Pick a flat or cylindrical face');
      return { kind: 'cylinder', o: s.p, d: unit(s.d), r: s.r };
    }
    if (r.kind === 'face') return { kind: 'plane', ...resolveSurface(null, r) };
    if (r.kind === 'axis') {
      const a = axes.get(r.id);
      if (!a) throw new Error('The reference axis is missing or failed');
      return { kind: 'line', d: a.d, start: a.o, end: add(a.o, a.d), mid: a.o };
    }
    if (r.kind === 'edge') {
      needEdges('Picking a model edge');
      const e = findEdge(body, r);
      if (!e) throw new Error('A selected edge could not be found in the model');
      updateEdgeRef(r, e, body);
      const g = edgeGeom(e, bbox(body).diag);
      if (g?.type === 'line') return { kind: 'line', d: unit(sub(g.b, g.a)), start: g.a, end: g.b, mid: mul(add(g.a, g.b), 0.5),curve:{type:'line'} };
      if (g?.type === 'circle' || g?.type === 'arc') return { kind: 'line', d: g.normal, start: g.c, end: add(g.c, g.normal), mid: g.c,curve:{type:g.type,c:g.c,start:vec(e.startPoint),end:vec(e.endPoint),mid:vec(e.pointAt(.5))} };
      throw new Error('Select a straight or circular edge');
    }
    if (r.kind === 'point') return { kind: 'point', p: resolvePoint(r.id) };
    if (r.kind === 'vertex') return { kind: 'point', p: resolvePoint(null, r) };
    if (r.kind === 'sketch') {
      // a sketch's point, line, or circle / arc (its axis), where the sketch has it now
      const s = sketches.get(r.sketch);
      if (!s) throw new Error('The sketch of a reference is missing, suppressed or has errors');
      const W = (q) => S.fromFrame2D(s.frame, q.x, q.y);
      if (r.point) { const q = r.point === 'O' ? { x: 0, y: 0 } : S.getPoint(s.sk, r.point); if (!q) throw new Error('A sketch point used as a reference is gone'); return { kind: 'point', p: W(q) }; }
      const c = S.getCurve(s.sk, r.curve);
      if (!c) throw new Error('A sketch entity used as a reference is gone');
      if (c.type === 'line') { const a = W(S.getPoint(s.sk, c.p1)), b = W(S.getPoint(s.sk, c.p2)); return { kind: 'line', d: unit(sub(b, a)), start: a, end: b, mid: mul(add(a, b), 0.5),curve:{type:'line'} }; }
      if (c.type === 'circle' || c.type === 'arc') {
        const center=S.getPoint(s.sk,c.c),o=W(center),arc=c.type==='arc'?S.arcAngles(s.sk,c):{a0:0,span:2*Math.PI,r:c.r},at=t=>W({x:center.x+arc.r*Math.cos(arc.a0+t*arc.span),y:center.y+arc.r*Math.sin(arc.a0+t*arc.span)});
        return {kind:'line',d:s.frame.n,start:o,end:add(o,s.frame.n),mid:o,curve:{type:c.type,c:o,start:at(0),end:at(1),mid:at(.5)}};
      }
      throw new Error('Pick a line, circle or arc of the sketch (or one of its points)');
    }
    throw new Error('Unknown reference');
  };
  const referenceDatum=f=>{
    const signature=JSON.stringify(f);
    try{
      const pathGeometry=r=>{
        let path,sourceType='path';
        try{
          if(r.kind==='sketch'){
            const source=sketches.get(r.sketch),curve=source&&S.getCurve(source.sk,r.curve);
            if(!curve)throw new Error('The selected path sketch or curve is missing, suppressed or has errors');
            path=sketchPath(S,source.sk,curve,source.frame);sourceType=curve.type;
          }else if(r.kind==='edge'){
            needEdges('Along path from a model edge');const edge=findEdge(body,r);if(!edge)throw new Error('The selected path edge could not be found');
            updateEdgeRef(r,edge,body);path=cadPath(R,edge);sourceType=edgeGeom(edge,bbox(body).diag)?.type||'curve';
          }else if(r.kind==='curve'){
            const source=curves.get(r.id);if(!source)throw new Error('The selected path feature is missing, suppressed or has errors');
            if(source.wires?.length>1)throw new Error('Select one connected path; this feature contains multiple paths');
            path=cadPath(R,source.wire,true);
          }else throw new Error('Along path requires a sketch curve, model edge or curve feature');
          const positionMode=r.positionMode||'fraction',options={...r,positionMode};
          if(positionMode==='fraction')options.fraction=ev(r.fraction??.5);
          if(positionMode==='distance')options.distance=ev(r.distance??0);
          return {kind:'path',sample:locateAlongPath(path,options,f.type==='plane'),curve:{type:sourceType}};
        }finally{path?.delete?.();}
      };
      const refs=f.refs||[],geo=refs.map(r=>{
        if(['plane','point'].includes(f.type)){
          const sketchCurve=r.kind==='sketch'&&r.curve&&S.getCurve(sketches.get(r.sketch)?.sk||{curves:[]},r.curve);
          if(r.relation==='alongPath'||r.kind==='curve'||!r.relation&&sketchCurve?.type==='spline')return pathGeometry(r);
          if(f.type==='plane'&&r.kind==='edge'&&!r.relation){const edge=findEdge(body,r);if(edge&&!['line','circle','arc'].includes(edgeGeom(edge,bbox(body).diag)?.type))return pathGeometry(r);}
        }
        if(f.type==='axis'&&r.kind==='face'&&!r.n){const hit=findFaceAny([...solids,...surfaces],r),axis=hit&&faceAxis(hit.face);if(!axis)throw new Error('Select a cylindrical or conical face');return {kind:'cylinder',o:axis.o,d:axis.d};}
        if(f.type==='point'&&r.kind==='edge'){
          needEdges('Reference point from an edge');const edge=findEdge(body,r);if(!edge)throw new Error('The selected edge could not be found in the model');
          updateEdgeRef(r,edge,body);const g=edgeGeom(edge,bbox(body).diag),start=vec(edge.startPoint),end=vec(edge.endPoint),mid=vec(edge.pointAt(.5));
          return {kind:'line',d:unit(vec(edge.tangentAt(.5))),start,end,mid,curve:{type:g?.type||'curve',c:g?.c,start,end,mid}};
        }
        return resolveRefGeom(r);
      });
      const defaults=defaultReferenceRelations(f.type,geo,f),evaluated=refs.map((r,i)=>{
        const relation=r.relation||defaults[i],out={...r,relation};
        for(const key of relation==='angle'?['angle']:relation==='offset'?['offset']:relation==='distance'?['distance']:[])if(r[key]!=null)out[key]=ev(r[key]);
        return out;
      });
      const relations=evaluated.map(r=>r.relation),opts={...f};
      if(f.type==='plane')for(const key of ['offset','angle','along','around']){const active=key==='along'?relations.includes('normal')&&f.position==='distance':key==='around'?relations.includes('tangent')&&!geo.some(g=>g.kind==='plane'):relations.includes(key==='offset'?'offset':'angle');opts[key]=active?ev(f[key]??0):0;}
      const solved=solveReferenceDatum(f.type,geo,evaluated,opts);
      const datumAnchor=f.type==='plane'?(geo.find(g=>g.kind==='path')?.sample?.p||geo.find(g=>g.kind==='line')?.mid||geo.find(g=>g.kind==='point')?.p):null;
      (res.info ||= {})[f.id]={datum:solved,datumSignature:signature,datumAnchor,relations,geometry:geo.map(g=>({kind:g.kind,curve:g.curve?{type:g.curve.type}:null})),pathLocations:geo.map(g=>g.sample||null)};
      if(solved.status!=='defined')throw new Error(solved.status==='under'?`Under Defined: ${solved.message}`:`Conflicting: ${solved.message}`);
      res.features[f.id]={refs};
      return {solved,geo,relations};
    }catch(e){if(!res.info?.[f.id]?.datum)(res.info ||= {})[f.id]={datum:{status:'conflict',message:e.message},datumSignature:signature};throw e;}
  };
  const loftConnectionControls=(f,ids)=>{
    if(!LC.hasManualConnections(f))return null;
    return ids.map(ref=>{
      const source=sketches.get(LR.sourceId(ref));if(!source||curves.has(ref))throw new Error('Manual connectors require sketch profile contours; use Automatic for 3D curve profiles');
      const control=LC.connectionFor(f,ref);
      return {anchor:LC.connectionAnchor(source.sk,ref,source.frame,control,ev),reverse:!!control?.reverse,control,source,ref};
    });
  };
  const loftConnectionInfo=(f,ids,sections,closed)=>{
    if(!LC.hasManualConnections(f))return;
    (res.info ||= {})[f.id]={...(res.info?.[f.id]||{}),loftConnections:{signature:JSON.stringify(f),closed,sections:sections.map((s,i)=>({ref:ids[i],points:closed?s.segs.map(g=>g.a):[s.segs[0].a,s.segs.at(-1).b]}))}};
  };
  const manualLoft=(wires,f,surface=false)=>{
    const oc=R.getOC(),builder=new oc.BRepOffsetAPI_ThruSections(!surface,!!f.ruled,1e-6);let shape;
    try{
      builder.CheckCompatibility(false);
      builder.SetMutableInput(false);
      if(!f.ruled){builder.SetContinuity(oc.GeomAbs_Shape[f.continuity==='C1'?'GeomAbs_C1':'GeomAbs_C2']);if(f.smoothing)builder.SetSmoothing(true);}
      for(const w of wires)builder.AddWire(w.wrapped);builder.Build();shape=R.cast(builder.Shape());
      const validity=new oc.BRepCheck_Analyzer(shape.wrapped,true);try{if(!validity.IsValid()||!surface&&!solidsOf(shape).length)throw new Error('The manual loft correspondence creates an invalid shape; choose different connector positions or directions');}finally{validity.delete();}
      return shape;
    }catch(e){shape?.delete();throw e;}finally{builder.delete();}
  };
  // axis { o, d } from X/Y/Z or a reference axis feature
  const resolveAxis = (key) => {
    if (AXES[key]) return { o: [0, 0, 0], d: AXES[key] };
    const a = axes.get(key);
    if (!a) throw new Error('The reference axis is missing or failed');
    return a;
  };

  const buildEndLoft = (f, ids, wires, surface = false, options = {}) => {
    if (f.ruled) throw new Error('Endpoint conditions require a smooth loft; untick Straight (ruled)');
    if (options.guides?.length && f.guideMethod === 'constrained') throw new Error('Endpoint conditions with guide curves currently require Adaptive approximation; CAD guide seams remain available without endpoint conditions');
    const settings = [], allocated = [];
    try {
      for (const [i, key] of ['start', 'end'].entries()) {
        const mode = f[key + 'Condition'] || 'none';
        if (!['none', 'normal', 'direction', 'tangent', 'curvature'].includes(mode)) throw new Error('Select a supported loft endpoint condition');
        const strength = mode === 'none' ? 1 : ev(f[key + 'Strength'] ?? 1);
        if (!(Number.isFinite(strength) && strength > 0)) throw new Error('Endpoint influence must be finite and greater than zero');
        let direction, faces = [];
        if (mode === 'normal') {
          const sk = sketches.get(LR.sourceId(ids[i === 0 ? 0 : ids.length - 1]));
          if (!sk) throw new Error('Normal to profile requires a planar sketch; use Direction for a 3D curve');
          direction = sk.frame.n;
        } else if (mode === 'direction') direction = resolveAxis(f[key + 'Direction'] || 'y').d;
        else if (mode === 'tangent' || mode === 'curvature') {
          const refs = f[key + 'Faces'] || [];
          if (!refs.length) throw new Error(`Select adjacent support faces for the ${key} profile`);
          faces = refs.map(ref => {
            const sources = [...solids, ...surfaces].filter(b => !ref.body || b.id === ref.body);
            let hit = findFaceAny(sources, ref);
            // After a dimensional edit, a curved face may move away from the
            // old pick. Rebind only within its saved body and geometric type,
            // and only to a unique side face adjacent to the new profile.
            if (!hit && ref.body && ref.loftType) {
              const endpoint = i === 0 ? 0 : wires.length - 1, neighbor = i === 0 ? 1 : endpoint - 1;
              const allLoops = [wires, ...(options.holes || [])], loops = Number.isInteger(ref.loftLoop) && allLoops[ref.loftLoop] ? [allLoops[ref.loftLoop]] : allLoops;
              const edges = loops.flatMap(loop => loop[endpoint].edges), others = loops.flatMap(loop => loop[neighbor].edges), candidates = [];
              const gap = (point, shape) => { const vertex = R.makeVertex(point), query = new R.DistanceQuery(vertex); try { return query.distanceTo(shape); } finally { query.delete(); vertex.delete(); } };
              const point = (edge, t) => { const p = edge.pointAt(t); try { return vec(p); } finally { p.delete(); } };
              try {
                for (const source of sources) for (const { face } of facesWithBox(source.shape)) {
                  if (face.geomType !== ref.loftType) continue;
                  const boundary = face.edges;
                  try {
                    const adjacent = edges.some((edge, j) => {
                      if (!others[j] || ![.19, .53, .83].every(t => boundary.some(e => gap(point(edge, t), e) <= 1e-4))) return false;
                      const p = point(edge, .5), n = face.normalAt(p), t = edge.tangentAt(.5);
                      try { return Math.abs(dot(cross(unit(vec(t)), unit(vec(n))), sub(point(others[j], .5), p))) > 1e-7; }
                      finally { n.delete(); t.delete(); }
                    });
                    if (adjacent) candidates.push({ body: source, face });
                  } finally { boundary.forEach(edge => edge.delete()); }
                }
                if (candidates.length === 1) {
                  const candidate = candidates[0], vertex = R.makeVertex(ref.p), query = new R.DistanceQuery(vertex);
                  try { query.distanceTo(candidate.face); const p = query.wrapped.PointOnShape2(1); try { ref.p = [p.X(), p.Y(), p.Z()]; } finally { p.delete(); } }
                  finally { query.delete(); vertex.delete(); }
                  hit = refFound(ref, candidate, true);
                }
              } finally { edges.forEach(edge => edge.delete()); others.forEach(edge => edge.delete()); }
            }
            if (!hit) throw new Error(`A ${key} support face is missing or could not be resolved`);
            ref.loftType = hit.face.geomType;
            if (!Number.isInteger(ref.loftLoop)) {
              const boundary = hit.face.edges, loops = [wires, ...(options.holes || [])], matches = [];
              const onEdge = (p, edge) => { const vertex = R.makeVertex(p), query = new R.DistanceQuery(vertex); try { return query.distanceTo(edge) <= 1e-4; } finally { query.delete(); vertex.delete(); } };
              try { loops.forEach((loop, index) => {
                const edges = loop[i === 0 ? 0 : loop.length - 1].edges;
                try { if (edges.some(edge => [.19,.53,.83].every(t => { const p = edge.pointAt(t); try { return boundary.some(other => onEdge(vec(p), other)); } finally { p.delete(); } }))) matches.push(index); }
                finally { edges.forEach(edge => edge.delete()); }
              }); } finally { boundary.forEach(edge => edge.delete()); }
              if (matches.length === 1) ref.loftLoop = matches[0];
            }
            const face = hit.face.clone(); allocated.push(face); return face;
          });
        }
        settings.push({ mode, direction, faces, strength, reverse: !!f[key + 'Reverse'] });
      }
    } catch (e) { allocated.forEach(face => face.delete()); throw e; }
    let guideBase;
    try {
      const build = (outer, holes) => endConstrainedLoft(R, outer, settings, { surface, sew: sewShapes, solid: solidFromSewn, holes, constraintWires: guideBase?.outer || wires, constraintHoles: guideBase?.holes || options.holes || [] });
      let result, guideError = 0;
      if (options.guides?.length) {
        guideBase = guidedLoftWires(options.matched, options.guides, options.names, options.holesMatched || [], options.slack || 0, { open: options.open, profileWires: options.profileWires, stations: 0, includeJunctions: false, smoothPull: true, tolerance: 1e-4 });
        checkLoftEndGuides(R, options.guides, guideBase.outer, settings, options.slack || 0);
        for (const stations of [8, 16, 32, 64, 128]) {
          const g = guidedLoftWires(options.matched, options.guides, options.names, options.holesMatched || [], options.slack || 0, { open: options.open, profileWires: options.profileWires, stations, includeJunctions: !settings.some(c => c.mode === 'curvature'), smoothPull: true, tolerance: 1e-4 });
          let candidate;
          try {
            candidate = build(g.outer, g.holes);
            // (Kernel Lab) the faces skipped by their quick boxes (labQuickBox: they hold the face, so a face the precise box
            // keeps is kept), not their precise ones: those took 5.7 of 23.5 s in loft-end-options-cases
            const faces = candidate.shape.faces.map(face => { const e = { face, quick: undefined, precise: undefined }; Object.defineProperty(e, 'box', { get() { if (this.precise === undefined) this.precise = bbox(face); return this.precise; } }); return { face, box: labQuickBox(e), spline: face.geomType === 'BSPLINE_SURFACE' }; }), oc = R.getOC(); guideError = 0;
            try {
              for (const { p } of g.checkPoints) {
                const point = new oc.gp_Pnt(...p); let error = Infinity;
                try { for (const { face, box, spline } of faces) {
                  if (boxDist(box, p) > 1e-4) continue;
                  const hit = oc.RazorCADSurfacePatch.NearPoint(face.wrapped, point, 1e-4);
                  try { const q = [hit.X(), hit.Y(), hit.Z()]; if (q.every(Number.isFinite)) error = Math.min(error, len(sub(q, p))); if (spline && error > 1e-4) error = Math.min(error, tensorFaceDistance(R, face, p, 1e-5)); } finally { hit.delete(); }
                  if (error <= 1e-4) break;
                }} finally { point.delete(); }
                guideError = Math.max(guideError, error); if (!(guideError <= 1e-4)) break;
              }
            } finally { faces.forEach(({ face }) => face.delete()); }
            if (guideError <= 1e-4) { result = candidate; candidate = null; break; }
          } finally {
            candidate?.shape.delete();
            g.outer.filter(wire => !wires.includes(wire)).forEach(wire => wire.delete());
            g.holes.flat().forEach(wire => wire.delete());
          }
        }
        if (!result) throw new Error(`The guides and endpoint conditions could not be followed within 0.0001 mm after bounded refinement (last sampled error ${Number.isFinite(guideError)?guideError.toExponential(2):'unresolved'} mm); add a profile near the tightest bend`);
      } else result = build(wires, options.holes || []);
      res.features[f.id] = { ...(res.features[f.id] || {}), startFaces: f.startFaces || [], endFaces: f.endFaces || [] };
      res.notes[f.id] = `Endpoint CAD constraints · contact ${result.contact.toExponential(2)} mm · normal mismatch ${result.angle.toFixed(4)} deg` + (settings.some(c => c.mode === 'curvature') ? ` · G2 curvature mismatch ${result.curvature.toExponential(2)} 1/mm` : '') + (options.guides?.length ? ` · Adaptive guides: CAD contact ${guideError.toExponential(2)} mm` : '');
      return result.shape;
    } finally {
      allocated.forEach(face => face.delete());
      guideBase?.outer.filter(wire => !wires.includes(wire)).forEach(wire => wire.delete());
      guideBase?.holes.flat().forEach(wire => wire.delete());
    }
  };

  // axis of a revolve: an axis feature, a straight model edge or cylindrical face picked on the
  // model ('edge' / 'face'), or a line of the sketch ('v' / 'u' = the sketch axes)
  const resolveRevolveAxis = (f, sk) => {
    if(f.axis==='sketchLine'){
      const source=sketches.get(f.axisSketch?.sketch);if(!source)throw new Error('The axis sketch is missing');
      const axis=S.revolveAxis({axis:f.axisSketch.curve},source.sk),fr=source.frame;
      return {o:S.fromFrame2D(fr,...axis.a),d:add(mul(fr.u,axis.d[0]),mul(fr.v,axis.d[1]))};
    }
    if (axes.has(f.axis)) return axes.get(f.axis);
    if (f.axis === 'edge') {
      if (!f.axisEdge) throw new Error('Click a straight edge on the model for the axis');
      needEdges('Picking a model edge');
      const e = findEdge(body, f.axisEdge);
      if (!e) throw new Error('The axis edge could not be found in the model');
      updateEdgeRef(f.axisEdge, e, body);
      res.features[f.id] = { ...(res.features[f.id] || {}), axisEdge: f.axisEdge };
      const g = edgeGeom(e, bbox(body).diag);
      if (g?.type === 'line') return { o: g.a, d: unit(sub(g.b, g.a)) };
      if (g?.type === 'circle' || g?.type === 'arc') return { o: g.c, d: g.normal };
      throw new Error('Select a straight or circular edge for the axis');
    }
    if (f.axis === 'face') {
      if (!f.axisFace) throw new Error('Click a cylindrical face on the model for the axis');
      const hit = findFaceAny([...solids, ...surfaces], f.axisFace);
      const ax = hit && faceAxis(hit.face);
      if (!ax) throw new Error('The axis face could not be found (use a cylindrical or conical face)');
      return ax;
    }
    if (sk.faceProfile || !sk.sk) throw new Error('To revolve a model face or model edges, choose a reference axis, a model edge or face, or a sketch line as the axis');
    const fr = sk.frame, ax = S.revolveAxis(f, sk.sourceSketch || sk.sk);
    return { o: S.fromFrame2D(fr, ax.a[0], ax.a[1]), d: add(mul(fr.u, ax.d[0]), mul(fr.v, ax.d[1])) };
  };

  const revolveAxisOf=(f,sk)=>{
    const axis=resolveRevolveAxis(f,sk);if(!f.projectAxis)return axis;
    const n=sk.frame.n,d=sub(axis.d,mul(n,dot(axis.d,n)));
    if(len(d)<1e-9)throw new Error('An axis perpendicular to the profile plane cannot be projected into it');
    return {o:sub(axis.o,mul(n,dot(sub(axis.o,sk.frame.o),n))),d:unit(d)};
  };

  const checkRevolveAxis=(sk,axis)=>{
    const n=sk.frame.n;
    if(Math.abs(dot(axis.d,n))>1e-7||Math.abs(dot(sub(axis.o,sk.frame.o),n))>1e-5)return;
    const across=unit(cross(axis.d,n));
    const polygons=sk.pts?[sk.pts]:(sk.regions?.length?sk.regions.map(r=>r.outer.poly):sk.sk.curves.filter(c=>!c.construction&&!c.ctrlOf).map(c=>S.curvePoints(sk.sk,c))).map(poly=>poly.map(p=>S.fromFrame2D(sk.frame,...p)));
    for(const polygon of polygons){const distances=polygon.map(p=>dot(sub(p,axis.o),across));if(Math.min(...distances)<-1e-6&&Math.max(...distances)>1e-6)throw new Error('A revolution profile must not cross its axis');}
  };

  // A revolve's extent up to a vertex or a surface (extent 'upToVertex' / 'upToSurface', toPoint / toVertex,
  // toPlane / toFace): the angle round the axis from the profile to it (the other way round with reverse). An end
  // plane through the axis stops it at the half of the plane it reaches first; any other plane trims it instead
  // (clip: the plane, the revolution taken nearly all the way round and cut there, see clipRevolution)
  // (a profile's middle: its box's, of a thin slab of it, or of its curves' points for a surface's open contours)
  const profileCentre = (sk) => {
    if (sk.drawing || sk.text || sk.gears?.length) {
      const probe = profileSolid(sk, (dr) => dr.sketchOnPlane(rPlane(sk.frame)).extrude(1e-3));
      try { return sub(bbox(probe).center, mul(sk.frame.n, 5e-4)); } finally { probe.delete(); }
    }
    if (sk.pts) { const b = bbox(asShape(sk.wires.map((w) => w.wire))); return b.center; }
    const pts = sk.sk.curves.filter((c) => !c.construction).flatMap((c) => S.curvePoints(sk.sk, c));
    if (!pts.length) throw new Error('The profile has no curves');
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return S.fromFrame2D(sk.frame, (Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2);
  };
  const revolveExtent = (f, sk, axis) => {
    if (!['upToVertex', 'upToSurface'].includes(f.extent)) return revolutionInterval(f, ev);
    const s = f.reverse ? -1 : 1, perp = (q) => { const r = sub(q, axis.o); return sub(r, mul(axis.d, dot(r, axis.d))); };
    const r0 = perp(profileCentre(sk));
    if (len(r0) < 1e-9) throw new Error('The profile lies on the revolution axis');
    const angleTo = (q) => {
      const r = perp(q);
      if (len(r) < 1e-9) return Infinity;
      let t = (s * Math.atan2(dot(cross(r0, r), axis.d), dot(r0, r)) * 180) / Math.PI;
      if (t <= 1e-7) t += 360;
      return t;
    };
    const span = (t) => ({ start: s < 0 ? -t : 0, angle: t });
    if (f.extent === 'upToVertex') {
      const p = resolvePoint(f.toPoint, f.toVertex);
      if (f.toVertex) res.features[f.id] = { ...(res.features[f.id] || {}), toVertex: f.toVertex };
      const t = angleTo(p);
      if (!Number.isFinite(t)) throw new Error('The vertex lies on the revolution axis');
      if (t >= 360 - 1e-7) throw new Error('The vertex lies on the profile’s side of the axis in its plane: it does not stop the revolution');
      return span(t);
    }
    const pl = resolveSurface(f.toPlane, f.toFace);
    if (f.toFace) res.features[f.id] = { ...(res.features[f.id] || {}), toFace: f.toFace };
    if (Math.abs(dot(pl.n, axis.d)) < 1e-9 && Math.abs(dot(sub(axis.o, pl.p), pl.n)) < 1e-6) {
      const w = unit(cross(pl.n, axis.d)), ts = [angleTo(add(axis.o, w)), angleTo(sub(axis.o, w))];
      if (ts.some((t) => t >= 360 - 1e-7)) throw new Error('The end surface passes through the profile');
      return span(Math.min(...ts));
    }
    return { ...span(359), clip: pl };
  };
  // The revolution (359° from the profile) cut by the end plane: of what lies on the profile's side of it, the pieces
  // that start at the profile; a piece that also reaches the far end goes all the way round without meeting the plane
  const clipRevolution = (tool, sections, axis, pl, reverse) => {
    const s = reverse ? -1 : 1, c = profileCentre(sections[0]), side = Math.sign(dot(sub(c, pl.p), pl.n));
    if (!side) throw new Error('The end surface passes through the profile');
    const nIn = mul(unit(pl.n), side), b = bbox(tool), big = b.diag + len(sub(b.center, pl.p)) + 100;
    const u = unit(cross(nIn, Math.abs(nIn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    const kept = solidsOf(tool.intersect(R.drawRectangle(2 * big, 2 * big).sketchOnPlane(new R.Plane(pl.p, u, nIn)).extrude(2 * big)));
    // (thin slabs on each profile, just outside where the revolution starts, and the same where it ends)
    const r = sub(c, axis.o), sweep = mul(cross(axis.d, sub(r, mul(axis.d, dot(r, axis.d)))), s);
    const slabs = sections.map((sk) => profileSolid(sk, (dr) => dr.sketchOnPlane(rPlane(sk.frame)).extrude(-1e-4 * (Math.sign(dot(sweep, sk.frame.n)) || 1))));
    const start = slabs.length > 1 ? compoundOf(slabs.map((shape) => ({ shape }))) : slabs[0], end = start.clone().rotate(s * 359, axis.o, axis.d);
    const touches = (piece, slab) => { const q = new R.DistanceQuery(piece); try { return q.distanceTo(slab) < 1e-7; } finally { q.delete(); } };
    const pieces = kept.filter((piece) => touches(piece, start));
    if (!pieces.length) throw new Error('The end surface leaves nothing of the revolution');
    if (pieces.some((piece) => touches(piece, end))) throw new Error('The end surface does not stop the revolution all the way round (a profile on the axis needs an end plane through it)');
    return pieces.length > 1 ? compoundOf(pieces.map((shape) => ({ shape }))) : pieces[0];
  };

  // A sheet's K-factor: given (bendCalc 'k'), or the one that a bend allowance or a bend deduction for a 90° bend
  // (bendCalc 'ba' / 'bd': bendAllowance / bendDeduction, mm) gives with this radius and thickness, so that every flat
  // length agrees with it at 90° (and other angles in proportion). A deduction with the outside setbacks: BA = 2(R + t) − BD
  const sheetKFactor = (f, R0, t) => {
    const m = f.bendCalc || 'k';
    if (!['k', 'ba', 'bd', 'table'].includes(m)) throw new Error('Select a supported bend calculation');
    if (m === 'table') {
      // (a bend table: 'angle: allowance' pairs; the K-factor the 90° allowance gives, carrying the table)
      const rows = String(f.bendTable || '').split(/[;\n]+/).map((x) => x.trim()).filter(Boolean).map((x) => {
        const m2 = x.match(/^(-?[\d.]+)\s*°?\s*[:=,\s]\s*(-?[\d.]+)$/);
        if (!m2) throw new Error(`“${x}” is not a bend table row (an angle and its allowance, such as 90: 4.2)`);
        const a = Number(m2[1]), b = Number(m2[2]);
        if (!(a > 0 && a <= 180 && b > 0)) throw new Error(`Bend table row “${x}”: the angle must be from 0° to 180° and the allowance more than zero`);
        return [(a * Math.PI) / 180, b];
      }).sort((x, y) => x[0] - y[0]);
      if (!rows.length) throw new Error('The bend table is empty: give a row for each angle, such as 90: 4.2');
      if (rows.some((r, i) => i && Math.abs(r[0] - rows[i - 1][0]) < 1e-12)) throw new Error('The bend table gives an angle twice');
      const K90 = (SM.tableAllowance(rows, Math.PI / 2) / (Math.PI / 2) - R0) / t;
      if (!(K90 >= 0 && K90 <= 1)) throw new Error(`The bend table's 90° allowance gives a K-factor of ${Number.isFinite(K90) ? +K90.toFixed(4) : K90}: it must give one between 0 and 1`);
      return Object.assign(new Number(K90), { table: { R: R0, t, rows } });
    }
    let K;
    if (m === 'k') K = ev(f.kFactor);
    else {
      const BA = m === 'ba' ? ev(f.bendAllowance) : 2 * (R0 + t) - ev(f.bendDeduction);
      K = (BA / (Math.PI / 2) - R0) / t;
    }
    if (!(K >= 0 && K <= 1)) throw new Error(m === 'k' ? 'The K-factor must be between 0 and 1' : `That bend ${m === 'ba' ? 'allowance' : 'deduction'} gives a K-factor of ${Number.isFinite(K) ? +K.toFixed(4) : K}: it must give one between 0 and 1`);
    return K;
  };

  // consecutive fillets (or chamfers) applied since the last other solid feature
  let blendChain = null;
  // every solid-changing feature so far, so blends can be recomputed in a different order
  const steps = [];
  let pending = []; // cuts waiting to be made together: [{ tool, fid }] (see flushCuts)
  let deferNow = false; // the feature being built may leave its cuts waiting
  let blendStep = null;

  // replace a solid body by the pieces of `shape` (largest keeps the id)
  const replaceSolid = (rec, shape, fid) => {
    const pieces = solidsOf(shape).map((sh) => ({ shape: sh, vol: null }));
    if (pieces.length > 1) pieces.sort((x, y) => volumeOf(y) - volumeOf(x));
    const at = solids.indexOf(rec);
    const recs = pieces.map((pc, k) => bodyRec(k ? newId(`${rec.id}~${k + 1}`) : rec.id, pc.shape, fid));
    solids = [...solids.slice(0, at), ...recs, ...solids.slice(at + 1)];
    body = compoundOf(solids);
    return recs;
  };
  const anyBody = (id) => solids.find((b) => b.id === id) || surfaces.find((b) => b.id === id) || null;
  // ---- sheet metal
  const sheetRecs = () => solids.filter((r) => r.sheet);
  const sheetOf = (bodyId) => {
    const recs = sheetRecs();
    if (!recs.length) throw new Error('There is no sheet metal body — start with a Base Flange or Convert to Sheet Metal');
    if (bodyId) {
      const r = recs.find((x) => x.id === bodyId);
      if (!r) throw new Error('The selected sheet metal body no longer exists');
      return r;
    }
    if (recs.length === 1) return recs[0];
    throw new Error('Select the sheet metal body');
  };
  const sheetChecked = (rec) => {
    if (rec.sheet.stale) throw new Error(`${rec.sheet.stale} changed this sheet metal body in a way its flat pattern can't follow, so sheet metal features can't be added after it`);
    return rec.sheet;
  };
  // replace a sheet metal body by the one folded from a new pattern
  const setSheet = (rec, sheet) => {
    const shape = SM.toSolid(sheet);
    const before = rec.shape;
    const recs = replaceSolid(rec, shape, cur.id);
    for (const r of recs) r.sheet = sheet;
    applied.push({ op: 'add', tool: shape, view: () => shape.cut(before) });
    return recs[0];
  };
  // straight model edges picked on one sheet metal body: { rec, edges: [{ a, b }] }
  const sheetEdges = (refs) => {
    let rec = null;
    const edges = [];
    const recs = sheetRecs();
    const all = compoundOf(recs);
    for (const ref of refs) {
      const hit = all && findEdgeInfo(all, ref);
      const owner = hit && (recs.length === 1 ? recs[0] : recs.find((s) => s.shape === hit.part));
      if (!hit || !owner) throw new Error('A selected edge is not on a sheet metal body');
      if (rec && owner !== rec) throw new Error('All the edges must be on the same sheet metal body');
      rec = owner;
      updateEdgeRef(ref, hit.e, all);
      const g = edgeGeom(hit.e, bbox(owner.shape).diag);
      if (g?.type !== 'line') throw new Error('Edge flanges need straight edges');
      edges.push({ a: g.a, b: g.b });
    }
    return { rec, edges };
  };
  // the profile of a sketch as flat faces in the sketch's own coordinates (z = 0)
  const sketchRegion = (sk) => {
    const prism = profileSolid(sk, (dr) => dr.sketchOnPlane('XY').extrude(1));
    const bottom = prism.faces.filter((fc) => fc.geomType === 'PLANE' && Math.abs(vec(fc.center)[2]) < 1e-7);
    if (!bottom.length) throw new Error('The sketch has no closed profile');
    return SM.upFaces(asShape(bottom));
  };
  const needBody = (id, what = 'body') => { const b = anyBody(id); if (!b) throw new Error(`A selected ${what} no longer exists`); return b; };
  // geometry + owning body of a mate entity
  const mateEntity = (ref) => {
    if (!ref) throw new Error('Pick both entities of every mate');
    if (ref.kind === 'plane') { const fr = resolveFrame(ref.id); return { geo: { kind: 'plane', p: fr.o, n: fr.n }, body: null }; }
    if (ref.kind === 'axis') { const a = axes.get(ref.id); if (!a) throw new Error('A reference axis is missing'); return { geo: { kind: 'line', p: a.o, d: a.d }, body: null }; }
    if (ref.kind === 'point') { const q = points.get(ref.id); if (!q) throw new Error('A reference point is missing'); return { geo: { kind: 'point', p: q }, body: null }; }
    const all = [...solids, ...surfaces];
    if (ref.kind === 'vertex') return { geo: { kind: 'point', p: ref.p }, body: bodyAt(all, ref.p) };
    if (ref.kind === 'edge') {
      const q = new R.DistanceQuery(R.makeVertex(ref.p));
      let best = null, bd = Infinity;
      for (const b of all) { if (b.dense) continue; for (const e of b.shape.edges) { const d = q.distanceTo(e); if (d < bd) { bd = d; best = { b, e }; } } }
      if (!best || bd > Math.max(1e-3, bbox(best.b.shape).diag * 2e-3)) throw new Error('A mate edge could not be found in the model');
      const g = edgeGeom(best.e, bbox(best.b.shape).diag);
      if (g?.type === 'line') return { geo: { kind: 'line', p: g.a, d: unit(sub(g.b, g.a)) }, body: best.b };
      if (g?.type === 'circle' || g?.type === 'arc') return { geo: { kind: 'line', p: g.c, d: unit(g.normal) }, body: best.b };
      throw new Error('Use straight or circular edges for mates');
    }
    const hit = findFaceAny(all, ref);
    if (!hit) throw new Error('A mate face could not be found in the model');
    const t = hit.face.geomType;
    if (t === 'PLANE') {
      const n = ref.n ? unit(ref.n) : unit(vec(hit.face.normalAt()));
      return { geo: { kind: 'plane', p: ref.p, n }, body: hit.body };
    }
    const oc = R.getOC();
    const ad = new oc.BRepAdaptor_Surface(hit.face.wrapped, false);
    try {
      if (t === 'CYLINDRE' || t === 'CONE' || t === 'TORUS') {
        const ax = (t === 'CYLINDRE' ? ad.Cylinder() : t === 'CONE' ? ad.Cone() : ad.Torus()).Axis(), L = ax.Location(), D = ax.Direction();
        return { geo: { kind: 'line', p: [L.X(), L.Y(), L.Z()], d: unit([D.X(), D.Y(), D.Z()]) }, body: hit.body };
      }
      if (t === 'SPHERE') { const L = ad.Sphere().Location(); return { geo: { kind: 'point', p: [L.X(), L.Y(), L.Z()] }, body: hit.body }; }
    } finally { ad.delete(); }
    throw new Error('Use flat, cylindrical, conical or spherical faces for mates');
  };

  // (cutsMade: the waiting cuts this rebuild really made, not taken from cutMemo or a saved state: for the tests)
  // (imports: [feature id, 'file' | 'store'] for each STEP import read, for the tests)
  const timing = { features: [], cutsMade: 0, imports: [] }; // where the time went (for tuning)
  const featureDiffs = new Map();
  const sketchBodies = new Map(); // sketch id -> { body before it, its frame }
  const nFeat = doc.features.length || 1;

  // Incremental rebuild: the state after every feature is kept. The next rebuild starts after
  // the last feature that is unchanged since then (same feature data, same equations), so a
  // preview or an edit only recomputes the feature being changed and what comes after it.
  const copyMap = (to, from) => { to.clear(); for (const [a, b] of from) to.set(a, b); };
  const takeSnap = () => ({
    body, solids: [...solids], surfaces: [...surfaces], dense, blendChain, steps: [...steps], pending: [...pending],
    planes: new Map(planes), sketches: new Map(sketches), axes: new Map(axes), points: new Map(points), tools: new Map(tools), curves: new Map(curves),
    usedIds: new Set(usedIds), featureDiffs: new Map(featureDiffs), sketchBodies: new Map(sketchBodies),
    res: { info:{...res.info}, errors: [...res.errors], sketches: { ...res.sketches }, planes: { ...res.planes }, axes: { ...res.axes }, points: { ...res.points }, curves: { ...res.curves }, notes: { ...res.notes }, detected: { ...res.detected }, features: { ...res.features }, threads: { ...res.threads }, missing: { ...res.missing } },
    timing: [...timing.features],
  });
  const restoreSnap = (s) => {
    ({ body, dense, blendChain } = s);
    solids = [...s.solids]; surfaces = [...s.surfaces];
    pending = [...(s.pending || [])];
    steps.length = 0; steps.push(...s.steps);
    copyMap(planes, s.planes); copyMap(sketches, s.sketches); copyMap(axes, s.axes); copyMap(points, s.points); copyMap(tools, s.tools); copyMap(curves, s.curves);
    copyMap(featureDiffs, s.featureDiffs); copyMap(sketchBodies, s.sketchBodies);
    usedIds.clear(); for (const id of s.usedIds) usedIds.add(id);
    res.errors = [...s.res.errors];
    for (const key of ['sketches', 'planes', 'axes', 'points', 'curves', 'notes', 'detected', 'features', 'threads', 'missing', 'info']) res[key] = { ...s.res[key] };
    timing.features = [...s.timing];
  };
  // ---- cuts made together
  // A run of cut features (cuts in sketch-shaped extrudes and revolves, holes, patterns and mirrors of cuts) only
  // takes material away from the body: one cut after another, each on a body with more faces than the last, takes
  // much longer than all of them at once (a golf ball's 178 dimples: 3.4 s one by one, 0.4 s together). So these
  // cuts wait (`pending`) while the features after them don't need the body; the next feature that does (a fillet,
  // a hole ending on a face, anything that picks model geometry), and the end of the rebuild, makes them in one
  // boolean. The waiting cuts are part of each feature's saved state.
  const DEFER_ENDS = new Set(['blind', 'midplane', 'through', 'through2']);
  // (an extrusion's ends: its second side's too)
  const endsDefer = (f) => DEFER_ENDS.has(f.end || 'blind') && (!f.side2 || DEFER_ENDS.has(f.end2 || 'blind'));
  // (opts.batchCuts false: every cut made as its feature comes, as before; for comparisons in the tests)
  const canDefer = (f) => {
    if (opts.batchCuts === false || f.id === previewId || dense || !solids.length || solids.some((x) => x.sheet)) return false;
    if (f.type === 'sketch') return !(f.constraints || []).some((k) => k.type === 'projected' && ['edge', 'vertex', 'section'].includes(k.src?.kind));
    if ((f.type === 'extrude' || f.type === 'revolve') && f.op === 'cut') {
      if (f.scopeAll === false) return false;
      if (f.type === 'extrude' && !endsDefer(f)) return false;
      if (f.type === 'revolve' && (f.axis === 'edge' || f.axis === 'face')) return false;
      return true;
    }
    if (f.type === 'hole') return f.holeType !== 'tapped'; // (a tapped hole finds its thread's length in the body)
    if (['lpattern', 'cpattern', 'mirror', 'spattern'].includes(f.type)) {
      if (f.features?.length || f.faces?.length || f.bodies?.length) return false;
      const t = tools.get(f.feature); return !!t && t.op === 'cut' && !t.scope;
    }
    return false;
  };
  // (Kernel Lab) sheet metal folded once for a run of cuts: can feature g work on sheet bodies whose fold waits?
  // (the features the app's own deferred cuts allow, whatever the bodies are)
  let labNext = null; // the next feature to be built after the one running
  const labSheetCanWait = (g) => {
    if (!g || g.id === previewId) return false;
    if (g.type === 'sketch') return !(g.constraints || []).some((k) => k.type === 'projected' && ['edge', 'vertex', 'section'].includes(k.src?.kind));
    if ((g.type === 'extrude' || g.type === 'revolve') && g.op === 'cut') {
      if (g.scopeAll === false) return false;
      if (g.type === 'extrude' && !endsDefer(g)) return false;
      if (g.type === 'revolve' && (g.axis === 'edge' || g.axis === 'face')) return false;
      return true;
    }
    if (g.type === 'hole') return g.holeType !== 'tapped';
    if (['lpattern', 'cpattern', 'mirror', 'spattern'].includes(g.type)) { const t = tools.get(g.feature); return !!t && t.op === 'cut' && !t.scope; }
    return false;
  };
  // the waiting folds made (new records: the folded body, its box worked out from it)
  const labFlushSheets = () => {
    if (!solids.some((r) => r.sheetPending)) return false;
    solids = solids.map((r) => {
      if (!r.sheetPending) return r;
      const t0 = performance.now();
      const nr = bodyRec(r.id, SM.toSolid(r.sheet), r.last, [r]);
      nr.sheet = r.sheet;
      LAB_SHEETS.refolds++; LAB_SHEETS.ms += performance.now() - t0;
      return nr;
    });
    body = compoundOf(solids);
    return true;
  };
  // The waiting cuts made: in one boolean (if that fails, one by one, so the feature that fails is named). Made in
  // two steps, the cuts of the last feature apart from the others: that feature is the one most often edited, and
  // then "all the others" is the same as last time (cutMemo), so only its own cut is made again and the faces left
  // as they were keep their meshes.
  // whole: in one step (for the feature being previewed, which needs the body as it is before it: then the same
  // step as "all the others" of the last feature in a full rebuild, and the same at each preview while it is edited)
  const flushCuts = (whole = false) => {
    if (!pending.length) return;
    const lastFid = pending[pending.length - 1].fid;
    const earlier = whole ? [] : pending.filter((x) => x.fid !== lastFid), own = whole ? pending : pending.filter((x) => x.fid === lastFid);
    pending = [];
    // (Kernel Lab: the earlier features' cuts in fixed chunks of LAB_CUT_CHUNK features, each found again in cutMemo
    // after an edit of a later one)
    if (earlier.length) {
      const fids = [...new Set(earlier.map((x) => x.fid))];
      for (let i = 0; i < fids.length; i += LAB_CUT_CHUNK) { const ids = new Set(fids.slice(i, i + LAB_CUT_CHUNK)); cutTogether(earlier.filter((x) => ids.has(x.fid))); }
    }
    cutTogether(own);
  };
  const cutTogether = (list) => {
    const t0 = performance.now();
    const keep = { cur, applied, deferNow };
    deferNow = false;
    const before = body, solidsBefore = solids, lastId = list[list.length - 1].fid;
    const featOf = (id) => doc.features.find((x) => x.id === id) || { id, type: 'cut', name: id };
    // (the same bodies and the same tools as a cut made before: its result, with the same faces)
    const memoKey = solids.map((r) => `${r.id}:${shapeId(r.shape)}`).join(',') + '|' + list.map((x) => `${x.fid}:${shapeId(x.tool)}`).join(',');
    try {
      cur = featOf(lastId);
      applied = [];
      const hit = cutMemo.get(memoKey);
      if (hit) {
        solids = [...hit.solids]; body = hit.body; applied = [...hit.applied];
        for (const r of solids) usedIds.add(r.id);
        cutMemo.delete(memoKey); cutMemo.set(memoKey, hit);
      } else try {
        apply('cut', list.length === 1 ? list[0].tool : compoundOf(list.map((x) => ({ shape: x.tool }))), true, null);
        timing.cutsMade += list.length;
        cutMemo.set(memoKey, { solids: [...solids], body, applied: [...applied] });
        while (cutMemo.size > 8) cutMemo.delete(cutMemo.keys().next().value);
      } catch (e) {
        if (isFatal(e)) throw e;
        solids = solidsBefore; body = compoundOf(solids); applied = [];
        for (const x of list) {
          cur = featOf(x.fid);
          try { apply('cut', x.tool, true, null); } catch (e2) { if (isFatal(e2)) throw e2; res.errors.push([x.fid, e2?.message || 'The geometry kernel could not compute this cut']); }
        }
      }
      if (body !== before) {
        // (each body changed counts every feature cut together, for its feature list; each feature keeps its own
        // tool, so its faces can be told apart; one step for features recomputed later)
        const ids = [...new Set(list.map((x) => x.fid))];
        for (const r of solids) if (!solidsBefore.includes(r)) for (const id of ids) if (!r.feats.includes(id)) r.feats.push(id);
        steps.push({ before, applied: [...applied], blend: null, opaque: false });
        for (const x of list) featureDiffs.set(x.fid, { before, after: body, tool: x.tool });
      }
    } finally { ({ cur, applied, deferNow } = keep); }
    timing.features.push([`(${list.length} cut${list.length === 1 ? '' : 's'} made together)`, Math.round(performance.now() - t0)]);
  };
  // ---- patterns: instance transforms { pt, dir, shape } and running them
  const xMove = (t) => ({ pt: (p) => add(p, t), dir: (n) => n, shape: (sh) => sh.translate(t) });
  const rotV = (p, deg, o, d) => {
    const a = (deg * Math.PI) / 180, k = unit(d), v = sub(p, o), c = Math.cos(a), sn = Math.sin(a);
    return add(o, add(add(mul(v, c), mul(cross(k, v), sn)), mul(k, dot(k, v) * (1 - c))));
  };
  const xTurn = (deg, o, d) => ({ pt: (p) => rotV(p, deg, o, d), dir: (n) => rotV(n, deg, [0, 0, 0], d), shape: (sh) => sh.rotate(deg, o, d) });
  const xMirror = (o, n0) => { const n = unit(n0); return { pt: (p) => sub(p, mul(n, 2 * dot(sub(p, o), n))), dir: (d) => sub(d, mul(n, 2 * dot(d, n))), shape: (sh) => sh.mirror(n, o) }; };
  // a transform as a 3×4 matrix (columns: where the axes go; last: where the origin goes)
  const xMatrix = (X) => {
    const o = X.pt([0, 0, 0]), [a, b, c] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((d) => X.dir(d));
    return [a[0], b[0], c[0], o[0], a[1], b[1], c[1], o[1], a[2], b[2], c[2], o[2]];
  };
  const xChain = (A, B) => ({ pt: (p) => B.pt(A.pt(p)), dir: (n) => B.dir(A.dir(n)), shape: (sh) => B.shape(A.shape(sh)) });
  // a copy of a feature with its picked points (edges, faces, vertices) moved
  const moveRefs = (o, X) => {
    if (Array.isArray(o)) { o.forEach((x) => moveRefs(x, X)); return; }
    if (!o || typeof o !== 'object') return;
    const v3 = (x) => Array.isArray(x) && x.length === 3 && x.every((q) => typeof q === 'number');
    if (v3(o.p)) {
      o.p = X.pt(o.p);
      if (v3(o.n)) o.n = X.dir(o.n);
      if (v3(o.d)) o.d = X.dir(o.d);
      if (v3(o.c)) o.c = X.pt(o.c);
      if (Array.isArray(o.fn)) o.fn = o.fn.map((x) => (v3(x?.n) ? { ...x, n: X.dir(x.n) } : x));
      delete o.box;
    }
    for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') moveRefs(o[k], X);
  };
  // where a feature is: its tool's centre, or the middle of the points it was picked at
  const sourceCentre = (id) => {
    const t = tools.get(id);
    if (t) { const b = bbox(t.shape); return mul(add(b.min, b.max), 0.5); }
    const src = doc.features.find((x) => x.id === id), ps = [];
    const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (Array.isArray(o.p) && o.p.length === 3) ps.push(o.p); Object.values(o).forEach(walk); } };
    walk(src);
    if (!ps.length) throw new Error('That feature has no position to pattern from');
    return mul(ps.reduce((acc, q) => add(acc, q), [0, 0, 0]), 1 / ps.length);
  };
  // The segments of a weldment path: lines { type: 'line', a, b } and arcs { type: 'arc', a, b, t0, t1, wire,
  // length } (3D), from a sketch's curves (construction left out) or a 3D sketch's edges.
  const memberPath = (id) => {
    const out = [];
    const addEdge = (e) => {
      const a = vec(e.startPoint), b = vec(e.endPoint);
      if (e.geomType === 'LINE') { if (len(sub(b, a)) > 1e-9) out.push({ type: 'line', a, b }); }
      else out.push({ type: 'arc', a, b, t0: unit(vec(e.tangentAt(0))), t1: unit(vec(e.tangentAt(1))), wire: R.assembleWire([e.clone()]), length: R.measureLength(e) });
    };
    if (curves.has(id)) { const c = curves.get(id); for (const w of c.wires || [c.wire]) for (const e of w.edges) addEdge(e); return out; }
    const sk = sketches.get(id);
    if (!sk) return out;
    for (const w of sketchWires(sk.sk, sk.frame)) for (const e of w.edges) addEdge(e);
    return out;
  };
  // a path as a 3D polyline (sketch chains, 3D sketches, helices)
  const pathPolyline = (id) => {
    if (!id) return null;
    const c = curves.get(id);
    if (c?.wire) {
      const out = [];
      for (const e of c.wire.edges) for (let i = 0; i <= 24; i++) { const q = vec(e.pointAt(i / 24)); if (!out.length || len(sub(q, out[out.length - 1])) > 1e-9) out.push(q); }
      return out.length > 1 ? out : null;
    }
    const s2 = sketches.get(id);
    if (!s2) return null;
    const ch = S.curveChains(s2.sk).filter((x) => !x.items.every((it) => it.c.construction))[0];
    if (!ch) return null;
    const out = [];
    for (const g of S.chainSegs(s2.sk, ch)) {
      let pts;
      if (g.type === 'line') pts = [g.a, g.b];
      else if (g.type === 'bezier') pts = Array.from({ length: 17 }, (_, i) => S.bezierAt(g, i / 16));
      else if (g.type === 'circle') pts = Array.from({ length: 97 }, (_, i) => [g.c[0] + g.r * Math.cos((i / 96) * 2 * Math.PI), g.c[1] + g.r * Math.sin((i / 96) * 2 * Math.PI)]);
      else {
        const C = S.circleThrough(g.a, g.b, g.m);
        if (!C) pts = [g.a, g.b];
        else {
          const a0 = Math.atan2(g.a[1] - C.cy, g.a[0] - C.cx), am = Math.atan2(g.m[1] - C.cy, g.m[0] - C.cx), a1 = Math.atan2(g.b[1] - C.cy, g.b[0] - C.cx);
          const nm = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          let sp = nm(a1 - a0);
          if (nm(am - a0) > sp) sp -= 2 * Math.PI;
          pts = Array.from({ length: 33 }, (_, i) => [C.cx + C.r * Math.cos(a0 + (sp * i) / 32), C.cy + C.r * Math.sin(a0 + (sp * i) / 32)]);
        }
      }
      for (const q of pts) { const Q = S.fromFrame2D(s2.frame, q[0], q[1]); if (!out.length || len(sub(Q, out[out.length - 1])) > 1e-9) out.push(Q); }
    }
    return out.length > 1 ? out : null;
  };
  // arc-length lookups on a polyline
  const polyAt = (P) => {
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + len(sub(P[i], P[i - 1])));
    const total = cum[cum.length - 1];
    const seg = (s) => { let i = 1; while (i < P.length - 1 && cum[i] < s) i++; return i; };
    return {
      length: total,
      point: (s) => { const i = seg(s), t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1); return add(P[i - 1], mul(sub(P[i], P[i - 1]), t)); },
      tangent: (s) => { const i = seg(s); return unit(sub(P[i], P[i - 1])); },
      nearest: (q) => {
        let best = 0, bd = Infinity;
        for (let i = 1; i < P.length; i++) {
          const d = sub(P[i], P[i - 1]), L2 = dot(d, d) || 1, t = Math.max(0, Math.min(1, dot(sub(q, P[i - 1]), d) / L2));
          const x = add(P[i - 1], mul(d, t)), dd = len(sub(q, x));
          if (dd < bd) { bd = dd; best = cum[i - 1] + t * (cum[i] - cum[i - 1]); }
        }
        return best;
      },
    };
  };
  const useCache = !opts.partial;
  const eqKey = JSON.stringify(doc.equations || []);
  // (a pattern naming a feature folder: what is in the folder counts as part of it, so a change to the folder builds it again)
  const folderKey = (x) => ((x.features || []).some((r) => String(r).startsWith('folder:')) ? JSON.stringify((x.features || []).map((r) => (doc.featureFolders || []).find((g) => 'folder:' + g.id === r)?.ids || r)) : '');
  const fjson = useCache ? doc.features.map((x) => JSON.stringify(x) + folderKey(x)) : null;
  const prev = useCache && rebuildCache?.eqKey === eqKey ? rebuildCache.entries : [];
  let start = 0;
  if (useCache) {
    while (start < prev.length && start < fjson.length && prev[start].json === fjson[start] && doc.features[start].id !== previewId
      && !(doc.rollbackAt && doc.features[start].id === doc.rollbackAt)) start++;
  }
  if (start > 0) restoreSnap(prev[start - 1].snap);
  const entries = useCache ? prev.slice(0, start) : null;
  timing.reused = start;
  for (let fi = start; fi < doc.features.length; fi++) {
    const f = doc.features[fi];
    if (doc.rollbackAt && f.id === doc.rollbackAt) break; // the rollback bar: nothing below it is built
    if (!opts.partial) progressFeature = f.id;
    progress((0.8 * fi) / nFeat, `Rebuilding ${f.name}…`);
    if (f.suppressed) { if (entries) entries[fi] = { id: f.id, json: fjson[fi], snap: takeSnap() }; continue; }
    // (a feature that needs the body as it really is: the waiting cuts made first)
    // (Kernel Lab: the folds waiting since a sheet metal cut made now, unless this feature can do without them)
    if (f.id === previewId || !labSheetCanWait(f)) labFlushSheets();
    labNext = null;
    for (let j = fi + 1; j < doc.features.length; j++) { const g = doc.features[j]; if (doc.rollbackAt && g.id === doc.rollbackAt) break; if (!g.suppressed) { labNext = g; break; } }
    deferNow = canDefer(f);
    if (!deferNow) { try { flushCuts(f.id === previewId); } catch (e) { if (isFatal(e)) throw e; } }
    const bodyIn = body, solidsIn = solids, surfacesIn = surfaces;
    const tf = performance.now();
    cur = f;
    applied = [];
    blendStep = null;
    blendPair = null;
    refLog = { lost: [], found: new Set(), moved: false };
    try {
      // (a function, so that patterns can run a copy of another feature)
      const runFeature = async (f) => {
      // copies of feature `srcId`, one per transform: its tool shape moved (features that add or cut a
      // shape), or the feature itself run again with its picked edges / faces moved (fillets, chamfers,
      // drafts, domes, forms…)
      const instances = async (pf, srcId, xs) => {
        const src = doc.features.find((x) => x.id === srcId);
        if (!src) throw new Error('Select the feature to pattern');
        if (src.suppressed) throw new Error('The feature to pattern is suppressed');
        const t = tools.get(srcId);
        if (t?.op === 'intersect') throw new Error('An Intersect feature cannot be patterned or mirrored');
        // a feature that makes sheet metal bodies from a sketch has no tool to move (and running it again
        // would only make its body again in the same place): its bodies are copied as they are here (with
        // the flanges, cuts… done to them since), each with its flat pattern carried along
        const made = !t && SHEET_NEW.has(src.type) ? [...solids, ...surfaces].filter((r) => r.feats[0] === srcId) : null;
        if (made && !made.length) throw new Error('The bodies that feature made are no longer there');
        let flatLost = 0;
        // copies of a cut: all cut out in one boolean (much faster than one after another, as the body
        // gets more faces with every cut); sheet metal bodies keep the one-by-one way (their flat patterns)
        // copies of an added shape (merged with the bodies): all at once as well, falling back to one by one
        if (t && t.op === 'add' && t.merge !== false && xs.length > 1) {
          const n0 = applied.length, before = solids;
          try {
            addAll(xs.map((X) => X.shape(t.shape.clone())));
            return;
          } catch (e) {
            if (isFatal(e)) throw e;
            applied.length = n0; solids = before; body = compoundOf(solids); // (then one by one)
          }
        }
        if (t && t.op === 'cut' && xs.length > 1 && !solids.some((s) => s.sheet && inScope(s, t.scope))) {
          const n0 = applied.length, before = solids;
          try {
            const copies = xs.map((X) => ({ shape: X.shape(t.shape.clone()) }));
            const comp = compoundOf(copies);
            apply('cut', comp, t.merge, t.scope);
            applied.splice(n0, applied.length - n0, ...copies.map((c) => ({ op: 'cut', tool: c.shape })));
            return;
          } catch (e) {
            if (isFatal(e)) throw e;
            applied.length = n0; solids = before; body = compoundOf(solids); // (then one by one)
          }
        }
        for (const [k, X] of xs.entries()) {
          if (t) { apply(t.op, X.shape(t.shape.clone()), t.merge, t.scope); continue; }
          if (made) {
            const M = xMatrix(X);
            for (const rec of made) {
              const shape = X.shape(rec.shape.clone());
              const nr = bodyRec(newId(pf.id), shape, pf.id, []);
              if (rec.sheet) { nr.sheet = SM.transformSheet(rec.sheet, M); if (!nr.sheet) flatLost++; }
              if (surfaces.includes(rec)) surfaces.push(nr); else solids.push(nr);
              applied.push({ op: 'add', tool: shape });
            }
            body = compoundOf(solids);
            continue;
          }
          const c = JSON.parse(JSON.stringify(src));
          c.id = `${src.id}@${pf.id}.${k + 1}`;
          moveRefs(c, X);
          try { await runFeature(c); } catch (e) { if (isFatal(e)) throw e; throw new Error(`Copy ${k + 1}: ${e.message || e}`); }
        }
        if (flatLost) res.notes[pf.id] = `${flatLost} mirrored lofted bend${flatLost > 1 ? 's are' : ' is a'} plain solid${flatLost > 1 ? 's' : ''} (no flat pattern)`;
      };
      // What a pattern copies: its feature, more features, the features that made the faces picked, and bodies
      // (copied whole, as new bodies). A picked face brings the latest feature whose tool has that face on it.
      const faceFeature = (r, i) => {
        let found = null;
        const tol = Math.max(1e-4, (body ? bbox(body).diag : 1) * 1e-6), q = new R.DistanceQuery(R.makeVertex(r.p));
        for (const [id, t] of tools) {
          const x = doc.features.find((y) => y.id === id);
          if (!x) continue;
          if (t.shape.faces.some((fc) => q.distanceTo(fc) < tol)) found = id;
        }
        if (!found) throw new Error(`Face ${i + 1} was not made by a feature that can be patterned: pick the feature in the list instead`);
        return found;
      };
      // (a folder named in the features: what is in it, before the pattern, that a pattern can copy)
      const FOLDER_SKIP = new Set(['sketch', 'sketch3d', 'plane', 'axis', 'point', 'helix', 'compCurve', 'projCurve', 'lpattern', 'cpattern', 'mirror', 'spattern', 'curvePattern', 'fillPattern', 'tablePattern']);
      const patternSources = (pf) => {
        const at = doc.features.findIndex((x) => x.id === pf.id);
        const fromFolders = (x) => {
          if (!String(x).startsWith('folder:')) return [x];
          const g = (doc.featureFolders || []).find((y) => 'folder:' + y.id === x);
          if (!g) throw new Error('A feature folder to pattern no longer exists');
          return doc.features.filter((y, i) => g.ids.includes(y.id) && (at < 0 || i < at) && !y.suppressed && !FOLDER_SKIP.has(y.type)).map((y) => y.id);
        };
        const ids = [...new Set([pf.feature, ...(pf.features || []).flatMap(fromFolders)].filter(Boolean))];
        (pf.faces || []).forEach((r, i) => { const id = faceFeature(r, i); if (!ids.includes(id)) ids.push(id); });
        const bodyRecs = (pf.bodies || []).map((id) => needBody(id));
        if (!ids.length && !bodyRecs.length) throw new Error('Select the features, faces or bodies to pattern');
        return { ids, bodyRecs };
      };
      // (where the copies are placed from: the first feature's place, or the first body's middle)
      const patternCentre = (pf) => {
        const { ids, bodyRecs } = patternSources(pf);
        if (ids.length) return sourceCentre(ids[0]);
        const b = bbox(bodyRecs[0].shape);
        return mul(add(b.min, b.max), 0.5);
      };
      // A pattern's instances left out (f.skip: '3, 5' or, with a second direction or rings, '3.2'; numbered from 1 at the
      // feature, -2 the first the other way): as index keys ('i' or 'i.j', the feature 0)
      const patternSkips = (pf, two) => {
        const out = new Set();
        for (const raw of String(pf.skip || '').split(/[,;\s]+/).filter(Boolean)) {
          const parts = raw.split('.').map(Number);
          if (parts.length !== (two ? 2 : 1) || parts.some((x) => !Number.isInteger(x) || x === 0)) throw new Error(`“${raw}” is not an instance number to skip (${two ? 'such as 3.2' : 'such as 3'})`);
          out.add(parts.map((x) => (x > 0 ? x - 1 : x + 1)).join('.'));
        }
        return out;
      };
      const patternAll = async (pf, xs) => {
        const { ids, bodyRecs } = patternSources(pf);
        for (const id of ids) await instances(pf, id, xs);
        let flatLost = 0;
        for (const rec of bodyRecs) {
          for (const X of xs) {
            const shape = X.shape(rec.shape.clone());
            const nr = bodyRec(newId(pf.id), shape, pf.id, []);
            if (rec.sheet) { nr.sheet = SM.transformSheet(rec.sheet, xMatrix(X)); if (!nr.sheet) flatLost++; }
            if (surfaces.includes(rec)) surfaces.push(nr); else solids.push(nr);
            applied.push({ op: 'add', tool: shape });
          }
        }
        if (bodyRecs.length) body = compoundOf(solids);
        const n = ids.length + bodyRecs.length;
        if (n > 1) res.notes[pf.id] = `${ids.length ? `${ids.length} feature${ids.length > 1 ? 's' : ''}` : ''}${ids.length && bodyRecs.length ? ' and ' : ''}${bodyRecs.length ? `${bodyRecs.length} bod${bodyRecs.length > 1 ? 'ies' : 'y'}` : ''} patterned`;
        if (flatLost) res.notes[pf.id] = `${flatLost} mirrored lofted bend${flatLost > 1 ? 's are' : ' is a'} plain solid${flatLost > 1 ? 's' : ''} (no flat pattern)`;
      };
      switch (f.type) {
        case 'sketch': {
          const frame = orientFrame(resolveFrame(f.plane.ref, f.plane), f.plane.rot);
          // (with cuts waiting: the body it was drawn on is worked out only if asked for, by sectionCurves)
          sketchBodies.set(f.id, pending.length ? { body: null, lazy: { base: body, tools: pending.map((x) => x.tool) }, frame, surfaces: surfaces.map((x) => x.shape) } : { body, frame, surfaces: surfaces.map((x) => x.shape) });
          if (f.entities) S.migrateSketch(f, vars);
          if (f.constraints?.some((k) => k.type === 'equation')) S.updateEquationCurves(f, vars);
          const lost = updateProjections(f, frame, dense ? null : body, sketches, surfaces.map((x) => x.shape));
          const sol = solveSketch(f, ev);
          sketches.set(f.id, { frame, sk: f });
          res.sketches[f.id] = { frame, rev: f.rev, data: { points: f.points, curves: f.curves, constraints: f.constraints, nextSid: f.nextSid, ...(f.patterns ? { patterns: f.patterns } : {}) } };
          if (f.texts?.length) res.sketches[f.id].textPolys = textOutlines(f.texts);
          for (const tr of f.gearTrains || []) {
            for (const mm of S.trainMeshes(f, tr)) {
              if (Math.abs(mm.need - mm.have) > 1e-3) res.notes[f.id] = `Gear train: a mesh is ${(mm.have - mm.need).toFixed(3)} mm off its centre distance (${mm.need.toFixed(3)} mm) — tick "Set the line lengths" in the gear train`;
            }
          }
          if (sol.bad.length) throw new Error(sol.bad[0]);
          if (!sol.ok) throw new Error('The sketch cannot be solved (conflicting relations or dimensions)');
          if (lost) throw new Error(`${lost} projected reference${lost > 1 ? 's' : ''} could not be found in the model`);
          break;
        }
        case 'plane': {
          const refs = planeRefs(f);
          const type = inferPlaneType(refs, !!f.through);
          if (!type&&!f.referenceDefinition) throw new Error('These references do not define a plane — pick a face/plane, an edge/axis or points');
          const geo = f.referenceDefinition?[]:refs.map(resolveRefGeom);
          if (f.refs?.length) res.features[f.id] = { refs: f.refs };
          const planesOf = geo.filter((g) => g.kind === 'plane');
          const lineOf = geo.find((g) => g.kind === 'line');
          const pointsOf = geo.filter((g) => g.kind === 'point');
          let fr;
          if(f.referenceDefinition&&!f.referenceLegacy){
            const {solved,geo}=referenceDatum(f),{n,h}=solved.value;
            const pathAnchor=geo.find(g=>g.kind==='path')?.sample?.p;
            const source=geo.find(g=>g.kind==='plane'&&g.frame&&Math.abs(dot(n,g.n))>1-1e-8);
            fr=pathAnchor?{...frameOnPlane(pathAnchor,n),o:[...pathAnchor]}:source?{...source.frame,o:add(source.frame.o,mul(n,h-dot(n,source.frame.o)))}:frameOnPlane(mul(n,h),n);
            if(dot(fr.n,n)<0)fr={...fr,v:mul(fr.v,-1),n};
          } else if (type === 'offset') {
            const g = planesOf[0];
            const d = ev(f.offset) * (f.flip ? -1 : 1);
            fr = g.frame
              ? { o: add(g.frame.o, mul(g.frame.n, d)), u: g.frame.u, v: g.frame.v, n: g.frame.n }
              : frameOnPlane(add(g.p, mul(g.n, d)), g.n);
          } else if (type === 'midPlane') {
            const [A, B] = planesOf;
            const c = dot(A.n, B.n);
            if (Math.abs(c) > 0.99999) {
              // parallel: halfway between them
              const n = A.n;
              const h = (dot(n, A.p) + dot(n, B.p)) / 2;
              fr = A.frame ? { o: add(A.frame.o, mul(n, h - dot(n, A.frame.o))), u: A.frame.u, v: A.frame.v, n } : frameOnPlane(mul(n, h), n);
            } else {
              // intersecting: bisector plane through their line of intersection
              const s = c > 0 ? -1 : 1;
              let n = unit(add(A.n, mul(B.n, s)));
              if (f.bisector) n = unit(add(A.n, mul(B.n, -s)));
              const line = planeIntersection(A, B);
              fr = frameOnPlane(line.o, n);
            }
          } else if (type === 'atAngle') {
            const P = planesOf[0], L = lineOf;
            let n0 = sub(P.n, mul(L.d, dot(P.n, L.d)));
            if (len(n0) < 1e-6) throw new Error('The edge is perpendicular to the plane — use "Normal to an edge" instead');
            n0 = unit(n0);
            const a = (ev(f.angle) * (f.flipAngle ? -1 : 1) * Math.PI) / 180;
            const n = unit(add(mul(n0, Math.cos(a)), mul(cross(L.d, n0), Math.sin(a))));
            fr = frameOnPlane(L.mid, n);
          } else if (type === 'normalToEdge') {
            const L = lineOf;
            const at = pointsOf[0]?.p || (f.position === 'start' ? L.start : f.position === 'end' ? L.end
              : f.position === 'distance' ? add(L.start, mul(L.d, ev(f.along))) : L.mid);
            fr = frameOnPlane(at, L.d);
          } else if (type === 'lineAndPoint') {
            const L = lineOf, p = pointsOf[0].p;
            const n = cross(L.d, sub(p, L.mid));
            if (len(n) < 1e-9) throw new Error('The point lies on the edge: pick a point off it');
            fr = frameOnPlane(L.mid, unit(n));
          } else if (type === 'twoLines') {
            const [A, B] = geo.filter((g) => g.kind === 'line');
            let n = cross(A.d, B.d);
            if (len(n) < 1e-9) {
              // parallel: the plane they both lie in
              n = cross(A.d, sub(B.mid, A.mid));
              if (len(n) < 1e-9) throw new Error('The two edges lie on one line: pick edges that are apart');
            } else if (Math.abs(dot(unit(n), sub(B.mid, A.mid))) > 1e-6 * (1 + len(sub(B.mid, A.mid)))) {
              throw new Error('The two edges are skew (not in one plane): pick edges that meet or are parallel');
            }
            fr = frameOnPlane(A.mid, unit(n));
          } else if (type === 'tangent') {
            // tangent to a cylinder: parallel to a picked plane (on the side flip chooses), or at an angle round it
            const C = geo.find((g) => g.kind === 'cylinder'), P = planesOf[0];
            const base = Math.abs(C.d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
            const e1 = unit(sub(base, mul(C.d, dot(base, C.d)))), e2 = cross(C.d, e1);
            let rad;
            if (P) {
              rad = sub(P.n, mul(C.d, dot(P.n, C.d)));
              if (len(rad) < 1e-6) throw new Error('The plane is square to the cylinder\'s axis: no tangent plane is parallel to it');
              rad = mul(unit(rad), f.flip ? -1 : 1);
            } else {
              const t = (ev(f.around) * Math.PI) / 180;
              rad = add(mul(e1, Math.cos(t)), mul(e2, Math.sin(t)));
            }
            fr = frameOnPlane(add(C.o, mul(rad, C.r)), rad);
          } else if (type === 'parallelThrough') {
            const P = planesOf[0];
            const p = pointsOf[0].p;
            fr = P.frame ? { o: add(P.frame.o, mul(P.frame.n, dot(sub(p, P.frame.o), P.frame.n))), u: P.frame.u, v: P.frame.v, n: P.frame.n } : frameOnPlane(p, P.n);
          } else if (type === 'threePoints') {
            const [a, b, c] = pointsOf.map((g) => g.p);
            const n = cross(sub(b, a), sub(c, a));
            if (len(n) < 1e-9) throw new Error('The three points are in a line');
            fr = frameOnPlane(a, unit(n));
          }
          // (any type: moved along its normal, its axes turned in it, its normal turned round)
          const offsetMode=f.referenceDefinition&&!f.referenceLegacy?(res.info?.[f.id]?.relations||[]).includes('offset'):type==='offset';
          const moveBy = offsetMode ? 0 : ev(f.moveBy ?? 0), turn = ((ev(f.turn ?? 0) || 0) * Math.PI) / 180;
          if (moveBy) fr = { ...fr, o: add(fr.o, mul(fr.n, moveBy)) };
          if (turn) fr = { ...fr, u: add(mul(fr.u, Math.cos(turn)), mul(fr.v, Math.sin(turn))), v: add(mul(fr.v, Math.cos(turn)), mul(fr.u, -Math.sin(turn))) };
          if (f.reverse) fr = { ...fr, v: mul(fr.v, -1), n: mul(fr.n, -1) };
          if(f.referenceDefinition&&![...fr.o,...fr.u,...fr.v,...fr.n].every(Number.isFinite))throw new Error('Plane placement must be finite');
          if(f.referenceLegacy)(res.info ||= {})[f.id]={datum:{status:'defined',dof:0,alternatives:1,legacy:true},datumSignature:JSON.stringify(f)};
          planes.set(f.id, fr);
          res.planes[f.id] = fr;
          break;
        }
        case 'extrude': {
          if(f.op==='cut'&&!solids.length)throw new Error('A cut requires an existing solid body');
          const refs = Array.isArray(f.profiles) ? f.profiles : f.sketch ? [f.sketch] : [];
          if (!refs.length) throw new Error('Select one or more sketch profiles');
          const sections = refs.map((ref) => sectionOf(ref, f.thin ? { t: ev(f.thinT), dir: f.thinDir || 'one' } : null));
          if (refs.some(isFaceProfile)) res.features[f.id] = { ...(res.features[f.id] || {}), profiles: refs };
          const firstFrame = sections[0].frame;
          for (const sk of sections) {
            if (Math.abs(dot(sk.frame.n, firstFrame.n)) < 1 - 1e-7 || Math.abs(dot(sub(sk.frame.o, firstFrame.o), firstFrame.n)) > 1e-5) throw new Error('Extrude profiles must lie in the same plane');
            // Opposite sketch normals still extrude in the direction of the first selected profile.
            sk.extrudeSign = dot(sk.frame.n, firstFrame.n) < 0 ? -1 : 1;
          }
          const extrusions = [];
          // (draft: the side walls tilted about the profile's plane by the angle, narrowing away from it, or widening
          // with draftOutward; the walls of holes tilt with them. Each side of the profile drafted away from it)
          // (draft2Own: the second side — side2, or Two sides' second depth — drafted by draft2 / draftOutward2 instead)
          const draftOf = (g) => {
            const a = ev(g.draft ?? 0);
            if (!Number.isFinite(a) || Math.abs(a) >= 89) throw new Error('The draft angle must be between 0° and 89°');
            return { drafted: Math.abs(a) > 1e-9, ang: g.draftOutward ? -a : a };
          };
          const draft2 = f.draft2Own ? { draft: f.draft2 ?? 0, draftOutward: !!f.draftOutward2 } : { draft: f.draft, draftOutward: f.draftOutward };
          draftOf(f); draftOf(draft2);
          const startMode=f.startFrom||'profile';
          if(!['profile','offset','surface'].includes(startMode))throw new Error('Select a supported extrusion start');
          const startSurface=startMode==='surface'?resolveSurface(f.startPlane,f.startFace):null;
          const startOffset=startMode==='offset'?ev(f.startOffset??0):0;
          if(!Number.isFinite(startOffset))throw new Error('Start offset must be finite');
          if(startSurface&&Math.abs(dot(startSurface.n,firstFrame.n))<1e-7)throw new Error('The start surface is parallel to the extrusion direction');
          if(f.startFace&&startSurface)res.features[f.id]={...(res.features[f.id]||{}),startFace:f.startFace};
          // (a second side, side2: its own end condition — end2, depth2, toPlane2 / toFace2, toPoint2 / toVertex2,
          // toOffset2, toFlip2 — going the other way from the start; the same start, operation and draft)
          const SIDE_ENDS=['blind','through','upToVertex','upToSurface','offsetSurface'];
          const twoEnds=!!f.side2&&SIDE_ENDS.includes(f.end||'blind');
          if(twoEnds&&!SIDE_ENDS.includes(f.end2||'blind'))throw new Error('Select a supported end for the second side');
          const second=twoEnds?{...f,...draft2,end:f.end2||'blind',depth:f.depth2,toPlane:f.toPlane2,toFace:f.toFace2,toPoint:f.toPoint2,toVertex:f.toVertex2,toOffset:f.toOffset2,toFlip:f.toFlip2,refKey:'2'}:null;
          // which way along `axis` a side goes from o: +1 or -1
          const sideDir=(g,axis,o)=>{
            if(g.end==='upToVertex'){const d=dot(sub(resolvePoint(g.toPoint,g.toVertex),o),axis);if(Math.abs(d)<1e-6)throw new Error('The vertex lies in the sketch plane');return Math.sign(d);}
            if(g.end==='upToSurface'||g.end==='offsetSurface'){const s=resolveSurface(g.toPlane,g.toFace),c=dot(axis,s.n);if(Math.abs(c)<1e-7)throw new Error('The end surface is parallel to the extrusion direction');return Math.sign(dot(sub(s.p,o),s.n)/c)||1;}
            return g.reverse?-1:1;
          };
          const sidesOf=(axis,o)=>{
            if(!second)return [f];
            const d1=sideDir(f,axis,o);
            if(['blind','through'].includes(second.end))return [f,{...second,reverse:d1>0}];
            if(sideDir(second,axis,o)===d1)throw new Error('The second side’s end lies on the same side of the profile as the first');
            return [f,second];
          };
          const note=(g,key,ref)=>{if(ref)res.features[f.id]={...(res.features[f.id]||{}),[key+(g.refKey||'')]:ref};};
          for (const sourceSection of sections) {
            let sk=sourceSection;
            const axis=mul(sk.frame.n,sk.extrudeSign);
            if(startMode==='offset'||startSurface&&Math.abs(dot(startSurface.n,axis))>1-1e-7){
              const distance=startSurface?dot(sub(startSurface.p,sk.frame.o),startSurface.n)/dot(axis,startSurface.n):startOffset;
              sk={...sk,frame:{...sk.frame,o:add(sk.frame.o,mul(axis,distance))}};
            }
            if(startSurface&&Math.abs(dot(startSurface.n,axis))<=1-1e-7){
              // Clip a prism with two independent planar boundaries. Keep the
              // sketch frame fixed; only the generated feature changes origin.
              const fr=sk.frame,probe=profileSolid(sk,dr=>dr.sketchOnPlane(rPlane(fr)).extrude(1));let box;
              try{box=bbox(probe);}finally{probe.delete();}
              const corners=[];for(const x of [box.min[0],box.max[0]])for(const y of [box.min[1],box.max[1]])for(const z of [box.min[2],box.max[2]]){const p=[x,y,z];corners.push(sub(p,mul(axis,dot(sub(p,fr.o),axis))));}
              const height=(surface,p)=>dot(sub(surface.p,p),surface.n)/dot(axis,surface.n);
              const atStart=height(startSurface,fr.o),startCenter=add(fr.o,mul(axis,atStart));
              for(const g of sidesOf(axis,startCenter)){
                const {drafted,ang}=draftOf(g);
                let lower,upper;
                if(['blind','midplane','twoSides'].includes(g.end||'blind')){
                  const interval=extrusionInterval(g,ev);lower={p:add(startSurface.p,mul(axis,interval.start)),n:startSurface.n};upper={p:add(startSurface.p,mul(axis,interval.end)),n:startSurface.n};
                }else if(['upToSurface','offsetSurface','upToVertex'].includes(g.end)){
                  let end;
                  if(g.end==='upToVertex'){const p=resolvePoint(g.toPoint,g.toVertex);note(g,'toVertex',g.toVertex);end={p,n:axis};}
                  else{end=resolveSurface(g.toPlane,g.toFace);note(g,'toFace',g.toFace);if(Math.abs(dot(end.n,axis))<1e-7)throw new Error('The end surface is parallel to the extrusion direction');if(g.end==='offsetSurface'){const offset=ev(g.toOffset)*(g.toFlip?-1:1),side=Math.sign(dot(sub(startCenter,end.p),end.n))||1;end={...end,p:add(end.p,mul(end.n,side*offset))};}}
                  const direction=height(end,fr.o)>atStart?1:-1;lower=direction>0?startSurface:end;upper=direction>0?end:startSurface;
                }else if(['through','through2'].includes(g.end)){
                  if(f.op==='add'&&!body)throw new Error('Through All needs an existing body');
                  const bounds=body?bbox(body):{center:fr.o,diag:1000},length=len(sub(bounds.center,startCenter))+bounds.diag+box.diag+10;
                  const below={p:add(startCenter,mul(axis,-length)),n:axis},above={p:add(startCenter,mul(axis,length)),n:axis};
                  lower=g.end==='through2'||g.reverse?below:startSurface;upper=g.end==='through2'||!g.reverse?above:startSurface;
                }else throw new Error('Select a supported extrusion end');
                for(const p of corners)if(height(upper,p)-height(lower,p)<=1e-6)throw new Error('The start and end surfaces cross or leave no extrusion thickness over the profile');
                const low=Math.min(...corners.map(p=>height(lower,p))),high=Math.max(...corners.map(p=>height(upper,p))),big=box.diag+Math.max(Math.abs(low),Math.abs(high))+len(fr.o)+100;
                let tool=profileSolid(sk,dr=>dr.sketchOnPlane(rPlane(fr,add(fr.o,mul(axis,low-5)))).extrude((high-low+10)*sk.extrudeSign));
                for(const [surface,sign] of [[lower,1],[upper,-1]]){
                  const n=mul(surface.n,(dot(surface.n,axis)>0?1:-1)*sign),base=Math.abs(n[0])<.9?[1,0,0]:[0,1,0],u=unit(cross(n,base)),center=add(fr.o,mul(axis,height(surface,fr.o)));
                  const block=R.drawRectangle(2*big,2*big).sketchOnPlane(new R.Plane(center,u,n)).extrude(2*big);tool=tool.intersect(block);
                }
                if(!solidsOf(tool).length)throw new Error('The start and end references leave no solid extrusion');
                // (drafted about the start surface: the profile's outline kept where the extrusion starts)
                if(drafted)tool=draftAway(tool,startSurface,axis,ang,[lower,upper]);
                extrusions.push(tool);
              }
              continue;
            }
            for (const g of sidesOf(axis, sk.frame.o)) {
              const { drafted, ang } = draftOf(g);
              let z0 = 0, z1 = 0;
              if(['blind','midplane','twoSides'].includes(g.end||'blind'))({start:z0,end:z1}=extrusionInterval(g,ev));
              else if(g.end==='through'||g.end==='through2'){
                if(f.op==='add'&&!body)throw new Error('Through All needs an existing body');
                const box=body?bbox(body):{center:[0,0,0],diag:1000},length=len(sub(box.center,sk.frame.o))+box.diag+5;
                if(g.end==='through')z1=length;else{z0=-length;z1=length;}
                if(g.reverse&&g.end==='through')[z0,z1]=[-z1,-z0];
              }
              if (sk.extrudeSign < 0) [z0, z1] = [-z1, -z0];
              const fr = sk.frame;
              let tool = null;
              if (g.end === 'upToVertex') {
                const P = resolvePoint(g.toPoint, g.toVertex);
                note(g, 'toVertex', g.toVertex);
                const d = dot(sub(P, fr.o), fr.n);
                if (Math.abs(d) < 1e-6) throw new Error('The vertex lies in the sketch plane');
                z0 = Math.min(0, d); z1 = Math.max(0, d);
              } else if (g.end === 'upToSurface' || g.end === 'offsetSurface') {
                const tgt = resolveSurface(g.toPlane, g.toFace);
                note(g, 'toFace', g.toFace);
                const off = g.end === 'offsetSurface' ? ev(g.toOffset) * (g.toFlip ? -1 : 1) : 0;
                const cosA = dot(tgt.n, fr.n);
                if (Math.abs(cosA) < 1e-6) throw new Error('The surface is parallel to the extrusion direction');
                // signed distance along the sketch normal from the sketch origin to the surface
                const t = dot(sub(tgt.p, fr.o), tgt.n) / cosA;
                if (Math.abs(cosA) > 0.99999) {
                  // parallel: a plain blind extrusion, offset back toward the sketch
                  const d = t - Math.sign(t) * off;
                  if (Math.abs(d) < 1e-6) throw new Error('The surface lies in the sketch plane');
                  z0 = Math.min(0, d); z1 = Math.max(0, d);
                } else {
                  // angled surface: extrude past it, then keep the part on the sketch's side
                  const dir = Math.sign(t) || 1;
                  let rProf = sk.reach || 0;
                  for (const r of sk.regions) for (const q of r.outer.poly) rProf = Math.max(rProf, Math.hypot(q[0], q[1]));
                  const tan = Math.sqrt(1 - cosA * cosA) / Math.abs(cosA);
                  const L = Math.abs(t) + rProf * tan + 10;
                  const long = profileSolid(sk, (dr) => dr.sketchOnPlane(rPlane(fr)).extrude(dir * L));
                  const side = Math.sign(dot(sub(fr.o, tgt.p), tgt.n)) || 1;
                  const nIn = mul(tgt.n, side); // points toward the sketch
                  const pOff = add(tgt.p, mul(nIn, off));
                  const big = L + rProf * (1 + tan) + 100;
                  const tmp = Math.abs(nIn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
                  const uT = (() => { const c = [nIn[1] * tmp[2] - nIn[2] * tmp[1], nIn[2] * tmp[0] - nIn[0] * tmp[2], nIn[0] * tmp[1] - nIn[1] * tmp[0]]; const l = len(c); return mul(c, 1 / l); })();
                  const block = R.drawRectangle(2 * big, 2 * big).sketchOnPlane(new R.Plane(pOff, uT, nIn)).extrude(2 * big);
                  tool = long.intersect(block);
                  // (drafted the same way as a blind one: about the profile's plane, the angled end trimmed with it)
                  if (drafted) tool = draftPrism(tool, fr.o, mul(fr.n, dir), ang, [{ p: fr.o, n: fr.n }, { p: pOff, n: nIn }]);
                }
              }
              if (!tool) {
                if (z1 - z0 <= 1e-9) throw new Error('Depth must be greater than zero');
                // (Two sides: the second depth drafted as the second side; the first depth lies along the extrusion)
                const other = g.end === 'twoSides' ? draftOf({ ...f, ...draft2 }) : { drafted, ang };
                const [dUp, dDown] = sk.extrudeSign < 0 !== !!(g.reverse && g.end !== 'midplane') ? [other, { drafted, ang }] : [{ drafted, ang }, other];
                if ((dUp.drafted || dDown.drafted) && z0 < -1e-9 && z1 > 1e-9) {
                  // (both sides of the profile: each drafted away from it, then joined)
                  let up = profileSolid(sk, (dr) => dr.sketchOnPlane(rPlane(fr)).extrude(z1));
                  let down = profileSolid(sk, (dr) => dr.sketchOnPlane(rPlane(fr, add(fr.o, mul(fr.n, z0)))).extrude(-z0));
                  if (dUp.drafted) up = draftPrism(up, fr.o, fr.n, dUp.ang);
                  if (dDown.drafted) down = draftPrism(down, fr.o, mul(fr.n, -1), dDown.ang);
                  tool = up.fuse(down);
                } else {
                  tool = profileSolid(sk, (dr) => dr.sketchOnPlane(rPlane(fr, add(fr.o, mul(fr.n, z0)))).extrude(z1 - z0));
                  if (drafted) tool = draftPrism(tool, fr.o, mul(fr.n, z1 > 1e-9 ? 1 : -1), ang);
                }
              }
              extrusions.push(tool);
            }
          }
          let tool = extrusions[0];
          for (const next of extrusions.slice(1)) tool = tool.fuse(next);
          tool = unify(tool);
          const scope = (f.op === 'cut' || f.op === 'intersect') && f.scopeAll === false ? f.scope || [] : null;
          tools.set(f.id, { shape: tool, op: f.op, merge: f.merge !== false, scope });
          apply(f.op, tool, f.merge !== false, scope);
          break;
        }
        case 'revolve': {
          if(f.op==='cut'&&!solids.length)throw new Error('A cut requires an existing solid body');
          const refs=Array.isArray(f.profiles)?f.profiles:f.sketch?[f.sketch]:[];
          if(!refs.length)throw new Error('Select one or more revolution profiles');
          const sections=refs.map(ref=>sectionOf(ref,f.thin?{t:ev(f.thinT),dir:f.thinDir||'one'}:null)),first=sections[0];
          if(refs.some(isFaceProfile))res.features[f.id]={...(res.features[f.id]||{}),profiles:refs};
          for(const sk of sections)if(Math.abs(dot(sk.frame.n,first.frame.n))<1-1e-7||Math.abs(dot(sub(sk.frame.o,first.frame.o),first.frame.n))>1e-5)throw new Error('Revolve profiles must lie in the same plane');
          const revAxis=revolveAxisOf(f,first),{o:origin,d:dir}=revAxis;
          sections.forEach(sk=>checkRevolveAxis(sk,revAxis));
          const extent=revolveExtent(f,first,revAxis),{angle,start}=extent;
          const revolutions=sections.map(sk=>profileSolid(sk,dr=>dr.sketchOnPlane(rPlane(sk.frame)).revolve(dir,{origin,angle})));
          let tool=revolutions[0];for(const next of revolutions.slice(1))tool=tool.fuse(next);
          if(start)tool=tool.rotate(start,origin,dir);
          if(extent.clip)tool=clipRevolution(tool,sections,revAxis,extent.clip,f.reverse);
          tool = unify(tool);
          const scope = (f.op === 'cut' || f.op === 'intersect') && f.scopeAll === false ? f.scope || [] : null;
          tools.set(f.id, { shape: tool, op: f.op, merge: f.merge !== false, scope });
          apply(f.op, tool, f.merge !== false, scope);
          break;
        }
        case 'lpattern': {
          // (spacing1 / spacing2 'total': the distance is from the first instance to the last; sym1 / sym2: as many again
          // the other way; seedOnly2: the second direction copies only the feature, not the first direction's row;
          // skip: instances left out, by number: 3, or 3.2 with two directions, -2 the other way)
          const c1 = Math.max(1, Math.round(ev(f.count1)));
          const two = f.dir2 && f.dir2 !== 'none';
          const c2 = two ? Math.max(1, Math.round(ev(f.count2))) : 1;
          const step = (k, c) => { const d = ev(f['dist' + k]); return f['spacing' + k] === 'total' ? (c > 1 ? d / (c - 1) : 0) : d; };
          // (inc1 / inc2: each spacing that much more than the one before; the i-th instance at i·spacing + inc·i(i−1)/2,
          // the other way the same)
          const at = (k, s, i) => { const n = Math.abs(i), inc = ev(f['inc' + k] ?? 0) || 0; return Math.sign(i) * (n * s + (inc * n * (n - 1)) / 2); };
          const s1 = step(1, c1), s2 = two ? step(2, c2) : 0;
          const u1 = mul(resolveAxis(f.dir1).d, f.rev1 ? -1 : 1), u2 = two ? mul(resolveAxis(f.dir2).d, f.rev2 ? -1 : 1) : [0, 0, 0];
          const range = (c, sym) => Array.from({ length: sym ? 2 * c - 1 : c }, (_, k) => (sym ? k - (c - 1) : k));
          const skip = patternSkips(f, two);
          const xs = [];
          for (const i of range(c1, f.sym1)) for (const j of range(c2, two && f.sym2)) {
            if (!i && !j) continue;
            if (two && f.seedOnly2 && i && j) continue;
            if (skip.has(two ? `${i}.${j}` : `${i}`)) continue;
            xs.push(xMove(add(mul(u1, at(1, s1, i)), mul(u2, at(2, s2, j)))));
          }
          if (xs.length > 400) throw new Error('Too many instances (max 400)');
          await patternAll(f, xs);
          break;
        }
        case 'cpattern': {
          // (sym: as many again the other way round; rings / ringStep: rings of copies further out from the axis, each
          // ringStep further, out through the feature's middle; skip: instances left out, by number, 3.2 with rings)
          const n = Math.max(1, Math.round(ev(f.count)));
          const total = ev(f.angle);
          const step = f.equal ? (Math.abs(total) >= 360 ? total / n : total / Math.max(1, n - 1)) : total;
          const ax = resolveAxis(f.axis);
          const rings = Math.max(1, Math.round(ev(f.rings ?? 1)));
          let out = [0, 0, 0];
          if (rings > 1) {
            const c = sub(patternCentre(f), ax.o), r = sub(c, mul(ax.d, dot(c, ax.d)));
            if (len(r) < 1e-9) throw new Error('Rings go out from the axis through the feature: the feature is on the axis');
            out = mul(unit(r), ev(f.ringStep));
          }
          const skip = patternSkips(f, rings > 1), xs = [];
          // (a whole turn has no other way round: symmetric only with less)
          const sym = f.sym && Math.abs(step * (n - 1) * 2) < 360 + 1e-9;
          for (let k = 0; k < rings; k++) for (let i = sym ? -(n - 1) : 0; i < n; i++) {
            if (!i && !k) continue;
            if (skip.has(rings > 1 ? `${i}.${k}` : `${i}`)) continue;
            // (angleInc: each angle between copies that much more than the one before)
            const ai = Math.abs(i), inc = ev(f.angleInc ?? 0) || 0, turn = xTurn(Math.sign(i) * (step * ai + (inc * ai * (ai - 1)) / 2), ax.o, ax.d);
            xs.push(k ? (i ? xChain(xMove(mul(out, k)), turn) : xMove(mul(out, k))) : turn);
          }
          if (xs.length > 400) throw new Error('Too many instances (max 400)');
          await patternAll(f, xs);
          break;
        }
        case 'mirror': {
          const fr = resolveFrame(f.plane);
          await patternAll(f, [xMirror(fr.o, fr.n)]);
          break;
        }
        case 'spattern': {
          // Sketch-driven pattern: a copy at each point of a sketch (the point nearest the feature is the
          // feature itself)
          const s2 = sketches.get(f.sketch);
          if (!s2) throw new Error('Select a sketch with points (or circles) where the copies go');
          const used = new Set(s2.sk.curves.filter((c) => c.type !== 'circle').flatMap((c) => [c.p1, c.p2, c.a, ...(c.pts || [])]).filter(Boolean));
          const centres = new Set(s2.sk.curves.filter((c) => c.type === 'circle' || c.type === 'arc').map((c) => c.c));
          const pts = s2.sk.points.filter((q) => q.id !== 'O' && (centres.has(q.id) || !used.has(q.id))).map((q) => S.fromFrame2D(s2.frame, q.x, q.y));
          if (pts.length < 2) throw new Error('The sketch needs at least two points (one at the feature, one for each copy)');
          const c0 = patternCentre(f);
          const base = pts.reduce((b, q) => (len(sub(q, c0)) - dot(sub(q, c0), s2.frame.n) * 0 < len(sub(b, c0)) ? q : b), pts[0]);
          await patternAll(f, pts.filter((q) => q !== base).map((q) => xMove(sub(q, base))));
          res.notes[f.id] = `${pts.length - 1} cop${pts.length === 2 ? 'y' : 'ies'} at the sketch points`;
          break;
        }
        case 'tablePattern': {
          // Table-driven pattern: a copy at each row of a table (x, y and optionally an angle, from the feature, in the
          // plane's directions; the angle turns the copy about the plane's normal through the feature). The plane: one
          // chosen, or the feature's own sketch plane (else Front)
          let fr;
          if (f.plane) fr = resolveFrame(f.plane);
          else { const sd = patternSources(f).ids[0], sf = sd && doc.features.find((x) => x.id === sd); fr = (sf?.sketch && sketches.get(sf.sketch)?.frame) || STD.front; }
          const rows = String(f.table || '').split(/[\n;]+/).map((r) => r.trim()).filter((r) => r && !/^[#/]/.test(r));
          const xs = [];
          for (const [i, r] of rows.entries()) {
            const cells = r.split(/[,\t]/.test(r) ? /\s*[,\t]\s*/ : /\s+/).filter(Boolean); // (spaces part the cells only when there are no commas or tabs)
            if (i === 0 && cells.some((c) => /^[A-Za-z]/.test(c) && !(c in vars))) continue; // (a header row)
            if (cells.length < 2 || cells.length > 3) throw new Error(`Row ${i + 1} of the table needs x, y and optionally an angle`);
            const [x, y, a = 0] = cells.map((c) => ev(c));
            if (![x, y, a].every(Number.isFinite)) throw new Error(`Row ${i + 1} of the table is not numbers`);
            if (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12 && Math.abs(a) < 1e-12) continue; // (the feature itself)
            const t = add(mul(fr.u, x), mul(fr.v, y));
            xs.push(Math.abs(a) > 1e-12 ? xChain(xTurn(a, patternCentre(f), fr.n), xMove(t)) : xMove(t));
          }
          if (!xs.length) throw new Error('Give the table rows: x, y (and an angle) from the feature for each copy');
          if (xs.length > 400) throw new Error('Too many instances (max 400)');
          await patternAll(f, xs);
          res.notes[f.id] = `${xs.length} cop${xs.length === 1 ? 'y' : 'ies'} from the table`;
          break;
        }
        case 'curvePattern': {
          // Curve-driven pattern: copies spaced along a sketch / 3D sketch / helix, moved or turned with it
          const path = pathPolyline(f.path);
          if (!path) throw new Error('Select the curve to pattern along (a sketch, 3D sketch or helix)');
          const n = Math.max(2, Math.round(ev(f.count)));
          if (n > 400) throw new Error('Too many instances (max 400)');
          const c0 = patternCentre(f);
          const at = polyAt(path), s0 = at.nearest(c0);
          const total = at.length, closed = len(sub(path[0], path[path.length - 1])) < 1e-6 * (total || 1);
          const step = f.spacing === 'equal' ? (closed ? total / n : (total - s0) / (n - 1)) : ev(f.distance) * (f.reverse ? -1 : 1);
          if (!(Math.abs(step) > 1e-9)) throw new Error('The spacing must not be zero');
          const P0 = at.point(s0), T0 = at.tangent(s0), xs = [];
          for (let k = 1; k < n; k++) {
            let sk = s0 + step * k;
            if (closed) sk = ((sk % total) + total) % total;
            else if (sk > total + 1e-9 || sk < -1e-9) break;
            const P = at.point(sk), T = at.tangent(sk);
            if (f.align === 'tangent') {
              const ax = cross(T0, T), sn = len(ax), cs = dot(T0, T), ang = (Math.atan2(sn, cs) * 180) / Math.PI;
              xs.push(sn > 1e-9 ? xChain(xTurn(ang, P0, unit(ax)), xMove(sub(P, P0))) : xMove(sub(P, P0)));
            } else xs.push(xMove(sub(P, P0)));
          }
          if (!xs.length) throw new Error('No copies fit on the curve with that spacing');
          await patternAll(f, xs);
          res.notes[f.id] = `${xs.length} cop${xs.length === 1 ? 'y' : 'ies'} along the curve`;
          break;
        }
        case 'fillPattern': {
          // Fill pattern: copies on a square or staggered grid over a flat face, kept a margin from its edges
          if (!f.face?.n) throw new Error('Click the flat face to fill');
          const hit = findFaceAny(solids, f.face);
          if (!hit) throw new Error('The face to fill could not be found');
          const sp = ev(f.spacing), margin = ev(f.margin || 0);
          if (!(sp > 0)) throw new Error('The spacing must be greater than zero');
          const n = unit(f.face.n), c0 = patternCentre(f);
          const o = sub(c0, mul(n, dot(sub(c0, f.face.p), n)));
          const fr0 = frameOnPlane(f.face.p, n), a = ((ev(f.angle || 0)) * Math.PI) / 180;
          const u = add(mul(fr0.u, Math.cos(a)), mul(fr0.v, Math.sin(a))), v = cross(n, u);
          const bb = bbox(hit.face), corners = [0, 1, 2, 3, 4, 5, 6, 7].map((m) => [m & 1 ? bb.max[0] : bb.min[0], m & 2 ? bb.max[1] : bb.min[1], m & 4 ? bb.max[2] : bb.min[2]]);
          const us = corners.map((q) => dot(sub(q, o), u)), vs = corners.map((q) => dot(sub(q, o), v));
          const stag = f.layout === 'staggered', dv = stag ? (sp * Math.sqrt(3)) / 2 : sp;
          const edges = R.makeCompound(hit.face.edges);
          const xs = [];
          for (let j = Math.floor(Math.min(...vs) / dv) - 1; j <= Math.ceil(Math.max(...vs) / dv) + 1; j++) {
            const off = stag && j % 2 ? sp / 2 : 0;
            for (let i = Math.floor((Math.min(...us) - off) / sp) - 1; i <= Math.ceil((Math.max(...us) - off) / sp) + 1; i++) {
              const q = add(o, add(mul(u, i * sp + off), mul(v, j * dv)));
              if (len(sub(q, o)) < sp * 1e-6) continue;
              const dq = new R.DistanceQuery(R.makeVertex(q));
              if (dq.distanceTo(hit.face) > 1e-6) continue;
              if (margin > 0 && dq.distanceTo(edges) < margin) continue;
              xs.push(xMove(sub(q, o)));
              if (xs.length > 400) throw new Error('Too many instances (max 400): use a larger spacing');
            }
          }
          if (!xs.length) throw new Error('No copies fit on the face with that spacing and margin');
          await patternAll(f, xs);
          res.notes[f.id] = `${xs.length} cop${xs.length === 1 ? 'y' : 'ies'} over the face`;
          break;
        }
        case 'fillet':
        case 'chamfer': {
          if (!body) throw new Error('There is no body');
          needEdges(f.type === 'fillet' ? 'Fillet' : 'Chamfer');
          if (f.type === 'fillet' && (f.filletType === 'variable' || f.filletType === 'face' || f.filletType === 'fullRound')) {
            // variable radius (start → end along each edge), a fillet between two picked faces, or a full round: the
            // middle of three faces (faces: side, middle, side) rounded off into one round meeting both sides
            const full = f.filletType === 'fullRound';
            let r1 = full ? 1 : ev(f.radius);
            const r2 = f.filletType === 'variable' ? ev(f.radius2) : r1;
            if (!(r1 > 0) || !(r2 > 0)) throw new Error('The radii must be greater than zero');
            const picked = [], pickedAt = new Map(); // (the edges found, and by their place in f.edges)
            let rec = null;
            if (full) {
              if ((f.faces || []).length !== 3) throw new Error('Click three faces: a side face, the face to round off, then the other side face');
              const hits = f.faces.map((r) => findFaceAny(solids, r));
              if (hits.some((h) => !h)) throw new Error('A selected face could not be found in the model');
              rec = hits[0].body;
              if (hits.some((h) => h.body !== rec)) throw new Error('The faces must be on the same body');
              const [a, mid, b] = hits.map((h) => h.face);
              if (a.geomType !== 'PLANE' || b.geomType !== 'PLANE') throw new Error('A full round needs flat side faces');
              const na = unit(vec(a.normalAt())), nb = unit(vec(b.normalAt()));
              if (dot(na, nb) > -1 + 1e-9) throw new Error('A full round needs side faces facing away from each other, parallel (a wall of even thickness)');
              const w = Math.abs(dot(sub(flatCentre(b), flatCentre(a)), na));
              if (!(w > 1e-9)) throw new Error('The side faces of a full round must be apart');
              r1 = w / 2;
              for (const side of [a, b]) for (const e of mid.edges) if (side.edges.some((x) => x.isSame(e)) && !picked.some((x) => x.isSame(e))) picked.push(e);
              if (picked.length < 2) throw new Error('The face to round off must meet both side faces at edges');
              res.notes[f.id] = `Full round R${+r1.toFixed(4)} (half the ${+w.toFixed(4)} mm wall)`;
            } else if (f.filletType === 'face') {
              if ((f.faces || []).length < 2) throw new Error('Click the faces to blend: two (or more) faces that meet at edges');
              const hits = f.faces.map((r) => findFaceAny(solids, r));
              if (hits.some((h) => !h)) throw new Error('A selected face could not be found in the model');
              rec = hits[0].body;
              if (hits.some((h) => h.body !== rec)) throw new Error('The faces must be on the same body');
              // the edges where two of the faces meet
              for (let i = 0; i < hits.length; i++) for (const e of hits[i].face.edges) {
                if (picked.some((x) => x.isSame(e))) continue;
                if (hits.some((h, j) => j !== i && h.face.edges.some((x) => x.isSame(e)))) picked.push(e);
              }
              if (!picked.length) throw new Error('The selected faces do not meet at an edge (a face fillet here blends faces that share edges)');
            } else {
              if (!f.edges?.length) throw new Error('Select edges on the model');
              f.edges.forEach((e, i) => {
                const hit = findEdgeInfo(body, e);
                if (!hit) return;
                updateEdgeRef(e, hit.e, body);
                picked.push(hit.e);
                pickedAt.set(i, hit.e);
                rec = solids.find((s) => s.shape === hit.part) || rec;
              });
              if (!picked.length) throw new Error('The selected edges no longer exist');
            }
            res.features[f.id] = { edges: f.edges || [] };
            const input = rec ? rec.shape : body;
            const rad = f.filletType === 'variable' ? (f.flipRadii ? [r2, r1] : [r1, r2]) : r1;
            let out = null;
            if (f.filletType === 'variable' && f.radiusMode === 'vertices') {
              // (a radius at each vertex of the runs of edges; the ones not given: the fillet's radius)
              const vr = (f.vertexRadii || []).map((x) => ({ p: x.p, r: ev(x.r) }));
              if (vr.some((x) => !(x.r > 0))) throw new Error('The radii must be greater than zero');
              const radAt = (q) => vr.find((x) => len(sub(x.p, q)) < 1e-4)?.r ?? r1;
              // points along the edges: { edge (its place in the edge list), t (% of its length from its start), r }
              // (a distance in mm from the edge's start: a share of its length)
              const ep = (f.edgePoints || []).map((x) => { const e = pickedAt.get(x.edge); return { e, t: x.unit === 'mm' ? (e ? ev(x.t) / edgeLength(e) : NaN) : ev(x.t) / 100, r: ev(x.r) }; });
              if (ep.some((x) => !(x.r > 0))) throw new Error('The radii must be greater than zero');
              if (ep.some((x) => !(x.t > 0 && x.t < 1))) throw new Error('A point along an edge must lie between its ends (more than 0 % and less than 100 %)');
              const ptsOf = (E) => ep.filter((x) => x.e && x.e.isSame(E)).map((x) => ({ t: x.t, r: x.r }));
              const r = filletByVertex(input, picked, radAt, ep.length ? ptsOf : null);
              out = r.shape;
              (res.info ||= {})[f.id] = { vertices: r.vertices.map((q) => q.map((x) => +x.toFixed(6))), points: r.points };
            }
            // (a full round's two fillets meet exactly: a hair smaller leaves the same round with a sliver of flat,
            // as thin as can be made)
            if (!out) for (const shrink of full ? [1e-8, 1e-7, 1e-6, 1e-5, 1e-4] : [0, 2e-5, 2e-4]) {
              try {
                const k = 1 - shrink;
                out = input.fillet((e) => (picked.some((x) => x.isSame(e)) ? (Array.isArray(rad) ? [rad[0] * k, rad[1] * k] : rad * k) : null));
                if (out && solidsOf(out).length) break;
                out = null;
              } catch (e) { if (isFatal(e)) throw e; out = null; }
            }
            if (!out) throw new Error('The fillet could not be computed (radius too large for the edges?)');
            // (the edges' end points, for the Property panel's radius at each vertex)
            if (!res.info?.[f.id]) (res.info ||= {})[f.id] = { vertices: [...new Map(picked.flatMap((e) => [vec(e.startPoint), vec(e.endPoint)]).map((q) => [q.map((x) => x.toFixed(4)).join(), q.map((x) => +x.toFixed(6))])).values()] };
            if (ev(f.setback ?? 0) > 0) out = setbackCorners(unify(out), cornersOf(picked), ev(f.setback));
            if (rec) replaceSolid(rec, unify(out), f.id);
            else remapSolids(unify(out), picked.map((e) => e.pointAt(0.5)));
            blendChain = null;
            const nPts = res.info?.[f.id]?.points?.length || 0;
            if (!full) res.notes[f.id] = f.filletType === 'variable' && f.radiusMode === 'vertices' ? `${picked.length} edge${picked.length === 1 ? '' : 's'}: radii at the vertices${nPts ? ` and ${nPts} point${nPts === 1 ? '' : 's'} along the edges` : ''}` : f.filletType === 'variable' ? `${picked.length} edge${picked.length === 1 ? '' : 's'}: R${+rad[0].toFixed(3)} → R${+rad[1].toFixed(3)}` : `${picked.length} edge${picked.length === 1 ? '' : 's'} where the faces meet, R${+r1.toFixed(3)}`;
            break;
          }
          if (f.type === 'chamfer' && f.chamferType === 'vertex') {
            // (a corner cut off: at each picked vertex where three straight edges meet, the plane through the points the
            // distances along them; distance for all three, or distance, distance2, distance3 for the edges running
            // most along X, Y and Z)
            if (!f.vertices?.length) throw new Error('Click the corners (vertices) to chamfer');
            const d0 = ev(f.distance), ds = f.vertexDistances ? [d0, ev(f.distance2), ev(f.distance3)] : [d0, d0, d0];
            if (ds.some((d) => !(d > 0))) throw new Error('The distances must be greater than zero');
            let out = null, recOf = null;
            for (const ref of f.vertices) {
              const p = findVertex(body, ref);
              if (!p) throw new Error('A selected corner could not be found in the model');
              ref.p = p;
              const rec = solids.find((s) => edgeInfos(s.shape).some(({ e }) => [vec(e.startPoint), vec(e.endPoint)].some((q) => len(sub(q, p)) < 1e-6)));
              if (!rec) throw new Error('A selected corner is not on a solid body');
              if (recOf && rec !== recOf) throw new Error('The corners of one vertex chamfer must be on the same body');
              recOf = rec;
              const shape = out || rec.shape, at = [];
              for (const { e } of edgeInfos(shape)) {
                const s = vec(e.startPoint), t = vec(e.endPoint);
                if (len(sub(s, p)) < 1e-6) at.push({ e, d: sub(t, s) }); else if (len(sub(t, p)) < 1e-6) at.push({ e, d: sub(s, t) });
              }
              if (at.length !== 3 || at.some(({ e }) => e.geomType !== 'LINE')) throw new Error('A vertex chamfer needs a corner where three straight edges meet');
              const axisOf = (d) => [0, 1, 2].reduce((m, k) => (Math.abs(d[k]) > Math.abs(d[m]) ? k : m), 0);
              const order = f.vertexDistances ? [...at].sort((x, y) => axisOf(x.d) - axisOf(y.d)) : at;
              const q = order.map(({ d }, k) => { if (!(ds[k] < len(d) - 1e-9)) throw new Error('A chamfer distance is as long as its edge, or longer'); return add(p, mul(unit(d), ds[k])); });
              const faces = [[p, q[0], q[1]], [p, q[1], q[2]], [p, q[2], q[0]], [q[0], q[1], q[2]]].map((t) => R.makePolygon(t));
              const tetra = R.makeSolid(faces), vol = Math.abs(R.measureVolume(tetra));
              // (only a corner that sticks out: all of the cut-off piece must be in the body)
              const inside = shape.intersect(tetra);
              if (Math.abs(Math.abs(R.measureVolume(inside)) - vol) > vol * 1e-7) throw new Error('A vertex chamfer cuts off a corner that sticks out (not one in a recess)');
              out = shape.cut(tetra);
            }
            res.features[f.id] = { vertices: f.vertices };
            replaceSolid(recOf, unify(out), f.id);
            blendChain = null;
            res.notes[f.id] = `${f.vertices.length} corner${f.vertices.length === 1 ? '' : 's'} cut off`;
            break;
          }
          if (!f.edges?.length) throw new Error('Select edges on the model');
          const v = ev(f.type === 'fillet' ? f.radius : f.distance);
          if (v <= 0) throw new Error('Value must be greater than zero');
          // (an edge's own size, edges[i].size: its radius or distance instead of the feature's; or, sizeBy 'chord', the
          // feature's value a chord width: each edge's radius from the angle its faces turn through at its middle)
          const chord = f.type === 'fillet' && f.sizeBy === 'chord';
          const sizeOf = (ref, edge) => {
            let s = v;
            if (ref.size != null && ref.size !== '') { s = ev(ref.size); if (!(s > 0)) throw new Error('An edge’s own size must be greater than zero'); }
            if (!chord) return s;
            const m = vec(edge.pointAt(0.5)), fs = adjacentFaces(body, edge);
            if (fs.length !== 2) throw new Error('A fillet by chord width needs edges between two faces');
            const turn = Math.acos(Math.max(-1, Math.min(1, dot(unit(vec(fs[0].normalAt(m))), unit(vec(fs[1].normalAt(m)))))));
            if (!(turn > 1e-6)) throw new Error('The faces at an edge meet smoothly: it has no chord to fillet');
            return s / (2 * Math.sin(turn / 2));
          };
          const pts = [];
          const found = [];
          const edgeShapes = [];
          const owners = new Set();
          let missing = 0;
          const sizes = [];
          for (const e of f.edges) {
            const hit = findEdgeInfo(body, e);
            if (!hit) { missing++; continue; }
            updateEdgeRef(e, hit.e, body);
            pts.push(e.p);
            const size = sizeOf(e, hit.e);
            found.push({ ...e, value: size });
            sizes.push(size);
            edgeShapes.push(hit.e);
            owners.add(hit.part);
          }
          const uneven = sizes.some((s) => Math.abs(s - v) > 1e-12);
          res.features[f.id] = { edges: f.edges };
          if (!pts.length) throw new Error('The selected edges no longer exist — an earlier fillet may already have rounded them (fillets continue along smoothly connected edges)');
          const filter = (fd) => fd.either(pts.map((p) => (x) => x.near(p, 1e-4)));
          // blend only the body that has the edges: much faster than blending every body together
          const rec = owners.size === 1 ? solids.find((s) => s.shape === [...owners][0]) || null : null;
          const input = rec ? rec.shape : body;
          const applyBlend = (shape, whole = false) => {
            if (rec && !whole) { const recs = replaceSolid(rec, shape, f.id); blendPair = { before: rec.shape, after: compoundOf(recs) }; }
            else remapSolids(shape, pts);
          };
          if (f.type === 'chamfer' && (f.chamferType === 'angleDist' || f.chamferType === 'twoDist') && uneven) throw new Error('Edges of their own size take equal-distance chamfers');
          if (f.type === 'chamfer' && (f.chamferType === 'angleDist' || f.chamferType === 'twoDist')) {
            // distance + angle, or two distances: measured from one of the two faces at each edge
            const x = ev(f.chamferType === 'twoDist' ? f.distance2 : f.angle);
            if (f.chamferType === 'twoDist' && x <= 0) throw new Error('Both distances must be greater than zero');
            if (f.chamferType === 'angleDist' && (x <= 0 || x >= 90)) throw new Error('The angle must be between 0° and 90°');
            let out;
            try { out = chamferAsym(input, edgeShapes, f.chamferType, v, x, !!f.flip); } catch (e) { if (isFatal(e)) throw e; out = null; }
            if (!out || !solidsOf(out).length) throw new Error('The chamfer could not be computed (values too large for the selected edges?)');
            applyBlend(unify(out));
            blendChain = null;
            if (missing) throw new Error(`${missing} selected edge${missing > 1 ? 's' : ''} could not be found and ${missing > 1 ? 'were' : 'was'} skipped`);
            break;
          }
          const item = { refs: found, value: v };
          let result = null;
          // (edges of different sizes: each edge's own, by the edge)
          const blend = (k) => {
            if (!uneven) return f.type === 'fillet' ? input.fillet(v * k, filter) : input.chamfer(v * k, filter);
            const size = (edge) => { const i = edgeShapes.findIndex((x) => x.isSame(edge)); return i < 0 ? null : sizes[i] * k; };
            return f.type === 'fillet' ? input.fillet(size) : input.chamfer(size);
          };
          try {
            result = blend(1);
          } catch (e) { if (isFatal(e)) throw e; /* try a combined blend below */ }
          // Blends that exactly meet (e.g. R2 on both edges of a 4 mm wall: a full round) would leave
          // a face of zero width, which the kernel rejects; a hair smaller value gives the same shape.
          for (const shrink of [2e-5, 2e-4, 2e-3]) {
            if (result) break;
            try { result = blend(1 - shrink); } catch (e) { if (isFatal(e)) throw e; }
          }
          // Edges that end on earlier fillets (e.g. a corner where three blends meet) can't be
          // filleted afterwards. Fallbacks, each computing the corner blend in one kernel call:
          let chain = blendChain?.type === f.type && blendChain.partId === (rec?.id ?? null) ? { base: blendChain.base, items: [...blendChain.items, item] } : null;
          let whole = false;
          if (!result && chain) {
            // 1. combine with the run of blends directly before this one
            result = combinedBlend(chain.base, chain.items, f.type);
          }
          if (!result) {
            // 2. combine with every earlier blend of this type, then replay the features in between
            const r = reorderedBlend(steps, f.type, item);
            if (r) { result = r.body; chain = { base: r.base, items: r.items }; whole = true; }
          }
          if (!result) throw new Error(`The ${f.type} could not be computed (value too large for the selected edges?)`);
          result = unify(result);
          if (f.type === 'fillet' && ev(f.setback ?? 0) > 0) {
            const cs = cornersOf(edgeShapes);
            result = setbackCorners(result, cs, ev(f.setback));
            res.notes[f.id] = `${cs.length} corner${cs.length === 1 ? '' : 's'} blended from ${+ev(f.setback).toFixed(3)} mm`;
          }
          applyBlend(result, whole);
          blendChain = chain || { type: f.type, base: input, items: [item] };
          blendChain.type = f.type;
          blendChain.partId = whole ? null : rec?.id ?? null;
          blendStep = { type: f.type, item };
          if (missing) throw new Error(`${missing} selected edge${missing > 1 ? 's' : ''} could not be found and ${missing > 1 ? 'were' : 'was'} skipped`);
          break;
        }
        case 'import': {
          const rec = await importShape(f, timing);
          // (Kernel Lab k14: a STEP file's PMI (dimensions, geometric tolerances, datums) read once, for 3D annotations)
          if (f.format === 'step' && !f.pmiRead && R.getOC().LabPMI) {
            const text = featureData(f);
            if (typeof text === 'string' && /DIMENSIONAL_|GEOMETRIC_TOLERANCE|DATUM_FEATURE|DATUM\(/.test(text)) {
              try { const lines = R.getOC().LabPMI.ReadStep(text); res.features[f.id] = { pmiRead: true, pmi: String(lines || '').split('\n').filter(Boolean) }; } catch (e) { if (isFatal(e)) throw e; }
            }
          }
          let shape = rec.shape.clone();
          // (an IGES file's faces, each on its own: sewn together, a solid where they close)
          if (f.sew && !shape.solids.length) shape = sewFaces(shape, f.sewTolerance ?? 0.01);
          // imported into a part shown Z up (f.upAxis, set when it was imported): the file's Z made RazorCAD's Y
          // (turned −90° about X), its appearances' boxes with it
          const turned = f.upAxis === 'z';
          if (turned) shape = shape.rotate(-90, [0, 0, 0], [1, 0, 0]);
          const appearance = turned ? turnedLooks(f.appearance) : f.appearance;
          if (rec.dense) dense = true;
          // imported bodies stay separate unless "Merge touching bodies" is ticked
          const mergeBodies = f.mergeBodies === true;
          tools.set(f.id, { shape, op: 'add', merge: mergeBodies });
          if (f.format === 'step') {
            progress(null, 'Separating the imported bodies…');
            const parts = splitImported(shape);
            if (!parts.solids.length && !parts.surfaces.length) throw new Error('The file contains no solids or surfaces');
            const n0 = solids.length;
            for (const s of parts.solids) apply('add', s, mergeBodies);
            const s0 = surfaces.length;
            for (const s of parts.surfaces) { surfaces.push(bodyRec(newId(f.id), s, f.id)); applied.push({ op: 'add', tool: s }); }
            // (bodies each as the file has them: other kernels can mesh them from the store)
            if (rec.stored && !turned && !mergeBodies && !f.sew && solids.length - n0 === parts.solids.length) {
              solids.slice(n0).forEach((r, k) => importedFrom.set(r.shape, { key: rec.stored, k, kind: 'solid' }));
              surfaces.slice(s0).forEach((r, k) => importedFrom.set(r.shape, { key: rec.stored, k, kind: 'surface' }));
            }
            // the appearances the file gave its solids and faces (f.appearance, from stepasm.js)
            if (appearance) {
              const recs = [...(mergeBodies ? [] : solids.slice(n0)), ...surfaces.slice(s0)];
              const looks = importedLooks(appearance, recs.map((r) => r.shape));
              recs.forEach((r, i) => { if (looks[i]) r.look = looks[i]; });
              if (mergeBodies && appearance.c != null) for (const r of solids.slice(n0)) r.look = { c: appearance.c, t: appearance.t || 0 };
            }
          } else if (shape.solids.length) apply('add', shape, mergeBodies);
          else {
            // a mesh that is not closed: a surface body (Repair Mesh / Convert to Solid can close it)
            const mrec = bodyRec(newId(f.id), shape, f.id);
            mrec.mesh = true;
            surfaces.push(mrec);
            applied.push({ op: 'add', tool: shape });
            const freeEdges = rec.open;
            res.notes[f.id] = `The mesh is not closed (${freeEdges} open edge${freeEdges === 1 ? '' : 's'}): it came in as a surface body. Use Repair Mesh to close it, or Convert to Solid.`;
          }
          if (rec.reduced) res.notes[f.id] = `Simplified from ${rec.reduced.from.toLocaleString()} to ${rec.reduced.to.toLocaleString()} triangles (the shape kept within a hair; set the limit in the import's properties).` + (res.notes[f.id] ? ' ' + res.notes[f.id] : '');
          break;
        }
        case 'shell': {
          needEdges('Shell');
          const t = ev(f.thickness);
          if (!Number.isFinite(t) || t <= 0) throw new Error('Thickness must be a finite number greater than zero');
          // (thickFaces: walls of a thickness of their own, { p, n, t }: inward, the material behind each flat face down
          // to its own depth is kept, the piece of it that touches the face)
          const own = (f.thickFaces || []).map((r) => ({ r, t: ev(r.t) }));
          if (own.some((x) => !(Number.isFinite(x.t) && x.t > 0))) throw new Error('A wall’s own thickness must be greater than zero');
          if (own.length && f.outward) throw new Error('Walls of their own thickness need an inward shell');
          const thicken = (rec, shape, removed) => {
            let out = shape;
            for (const { r, t: ti } of own) {
              if (ti <= t + 1e-12) throw new Error('A wall’s own thickness must be more than the shell’s (it adds to the wall)');
              const hit = findFaceAny([rec], r);
              if (!hit || hit.face.geomType !== 'PLANE') throw new Error('A wall of its own thickness must be a flat face of the body');
              if (removed.some((x) => x.isSame(hit.face))) throw new Error('A removed face cannot have a thickness of its own');
              const n = unit(vec(hit.face.normalAt())), c = flatCentre(hit.face), b = bbox(rec.shape), big = b.diag + len(sub(b.center, c)) + 100;
              const nn = mul(n, -1), u = unit(cross(nn, Math.abs(nn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
              const slab = R.drawRectangle(2 * big, 2 * big).sketchOnPlane(new R.Plane(c, u, nn)).extrude(ti);
              const behind = solidsOf(rec.shape.intersect(slab)).filter((piece) => { const q = new R.DistanceQuery(piece); try { return q.distanceTo(hit.face) < 1e-7; } finally { q.delete(); } });
              for (const piece of behind) out = out.fuse(piece);
            }
            return out;
          };
          if (!f.faces?.length) {
            // (no faces removed: hollow, the body offset inward by the thickness cut out of it, a closed void inside)
            if (f.outward) throw new Error('A hollow shell (no faces removed) goes inward');
            const rec0 = solids.length === 1 ? solids[0] : solids.find((s) => s.id === f.body);
            if (!rec0) throw new Error(solids.length ? 'Hollowing (no faces removed) works on a part of one body: select faces to remove' : 'There is no body to shell');
            const oc = R.getOC();let inner = null;
            for (const join of [oc.GeomAbs_JoinType.GeomAbs_Arc, oc.GeomAbs_JoinType.GeomAbs_Intersection]) {
              const mk = new oc.BRepOffsetAPI_MakeOffsetShape();
              try {
                mk.PerformByJoin(rec0.shape.wrapped, -t, Math.max(1e-7, Math.min(1e-4, t * 1e-3)), oc.BRepOffset_Mode.BRepOffset_Skin, false, false, join, false);
                if (!mk.IsDone()) continue;
                const raw = mk.Shape(); let s; try { s = R.cast(raw); } finally { raw.delete(); }
                const solid = solidsOf(s).length ? s : (() => { try { return R.makeSolid([s]); } catch (e) { if (isFatal(e)) throw e; return null; } })();
                const v = solid ? Math.abs(preciseVolume(solid)) : 0, v0 = preciseVolume(rec0.shape);
                // (and a full thickness in from the outside everywhere: an offset through itself is not a void)
                if (solid && v > 0 && v < v0 - 1e-9) {
                  const q = new R.DistanceQuery(solid);let gap = 0;
                  try { gap = Math.min(...rec0.shape.faces.map((fc) => q.distanceTo(fc))); } finally { q.delete(); }
                  if (gap > t * (1 - 1e-6) && Math.abs(preciseVolume(solid.cut(rec0.shape))) < v0 * 1e-9) { inner = solid; break; }
                }
              } catch (e) { if (isFatal(e)) throw e; } finally { mk.delete(); }
            }
            if (!inner) throw new Error('The body could not be hollowed at this thickness (its walls would run into each other)');
            const out = thicken(rec0, rec0.shape.cut(inner), []);
            replaceSolid(rec0, unify(out), f.id);
            res.notes[f.id] = 'Hollow: a closed void inside';
            break;
          }
          const pickedHits=f.faces.map((r)=>findFaceAny(solids,r));
          if(pickedHits.some((h)=>!h))throw new Error('A selected face could not be found in the model');
          const hits=pickedHits.filter((hit,i)=>pickedHits.findIndex((other)=>other.body===hit.body&&other.face.isSame(hit.face))===i);
          const rec = hits[0].body;
          if (hits.some((h) => h.body !== rec)) throw new Error('All removed faces must be on the same body');
          // OCCT can report completion while returning the original body or an
          // open shell. Neither is a successful hollowing operation.
          const validShell = (shape, candidate, removed) => {
            if (!candidate) return false;
            const oc=R.getOC(),check=new oc.BRepCheck_Analyzer(candidate.wrapped,true);
            const solids=candidate.solids,faces=candidate.faces;
            try {
              if(!check.IsValid()||!solids.length||removed.some((r)=>faces.some((face)=>face.isSame(r))))return false;
              const volume=preciseVolume(candidate),before=preciseVolume(shape);
              if(!Number.isFinite(volume)||!(volume>0))return false;
              if(!f.outward&&!(volume<before-Math.max(1e-9,before*1e-9)))return false;
              return true;
            } finally {check.delete();solids.forEach((s)=>s.delete());faces.forEach((face)=>face.delete());}
          };
          let sharpJoins=false;
          const thick = (shape, faces) => {
            const oc=R.getOC(),L=ocList(faces),tolerance=Math.max(1e-7,Math.min(1e-4,t*1e-3));
            try {
              for(const join of [oc.GeomAbs_JoinType.GeomAbs_Arc,oc.GeomAbs_JoinType.GeomAbs_Intersection])for(const intersect of [false,true]){
                const sp=stack?.get(),mk=new oc.BRepOffsetAPI_MakeThickSolid();let candidate;
                try {
                  mk.MakeThickSolidByJoin(shape.wrapped,L,f.outward?t:-t,tolerance,oc.BRepOffset_Mode.BRepOffset_Skin,intersect,false,join,false);
                  if(!mk.IsDone())continue;
                  const raw=mk.Shape();try{candidate=R.cast(raw);}finally{raw.delete();}
                  if(validShell(shape,candidate,faces)){sharpJoins=join===oc.GeomAbs_JoinType.GeomAbs_Intersection;const result=candidate;candidate=null;return result;}
                } catch(e){if(isFatal(e))throw e;}
                finally{candidate?.delete();mk.delete();if(sp!=null)stack.set(sp);}
              }
              return null;
            }finally{L.delete();}
          };
          let out = thick(rec.shape, hits.map((h) => h.face));
          if (!out && !f.outward) {
            // A fillet (or chamfer) smaller than the wall collapses when it is offset, and the kernel
            // gives up. Shell the body as it would be without those small blends instead, and cut that
            // cavity out of the real body: the outside keeps its fillets, the inside has sharp corners.
            const at = doc.features.indexOf(f);
            const size = (x) => { try { return ev(x.type === 'fillet' ? x.radius : x.distance); } catch { return Infinity; } };
            const before = doc.features.slice(0, at);
            const small = (types) => before.filter((x) => types.includes(x.type) && !x.suppressed && size(x) < t + 1e-9);
            for (const types of [['fillet'], ['fillet', 'chamfer']]) {
              const skip = new Set(small(types).map((x) => x.id));
              if (!skip.size) continue;
              const sub = JSON.parse(JSON.stringify({ ...doc, features: before.map((x) => (skip.has(x.id) ? { ...x, suppressed: true } : x)) }));
              let part;
              quietProgress++;
              try { part = await rebuild(sub, null, { partial: true }); } catch (e) { if (isFatal(e)) throw e; part = null; } finally { quietProgress--; }
              const plain = part?.solids.find((x) => x.id === rec.id);
              if (!plain) continue;
              const plainFaces = f.faces.map((r) => findFaceAny([plain], r)?.face).filter((face,i,all)=>!face||all.findIndex((other)=>other&&other.isSame(face))===i);
              if (plainFaces.some((x) => !x)) continue;
              const shelled = thick(plain.shape, plainFaces);
              if (!shelled) continue;
              let cavity,res2;
              try {
                cavity=plain.shape.cut(shelled);res2=rec.shape.cut(cavity);
                if(validShell(rec.shape,res2,hits.map((h)=>h.face))){
                  out=res2;res2=null;res.notes[f.id]='Small blends retained outside; sharp corners inside';break;
                }
              } catch(e){if(isFatal(e))throw e;}
              finally{res2?.delete();cavity?.delete();shelled.delete();}
            }
          }
          if (!out) throw new Error('The shell could not be built with a valid cavity — try a smaller thickness, remove different faces, or place Shell before fillets and chamfers');
          if(sharpJoins&&!res.notes[f.id])res.notes[f.id]='Sharp joins used between offset faces';
          if (own.length) out = thicken(rec, out, hits.map((h) => h.face));
          replaceSolid(rec, unify(out), f.id);
          break;
        }
        case 'surfPlanar': {
          const profiles=Array.isArray(f.profiles)?f.profiles:f.sketch?[f.sketch]:[],parts=[],owned=[];
          if(!profiles.length&&!f.edges?.length)throw new Error('Select closed sketch profiles or a coplanar loop of model edges');
          try{
            for(const ref of profiles){
              const sk=sketches.get(LR.sourceId(ref));if(!sk)throw new Error('A planar surface sketch is missing, suppressed or has errors');
              const selected=typeof ref==='string'?null:LR.resolveContour(sk.sk,ref);
              if(selected?.chain&&!selected.chain.closed)throw new Error('Planar Surface requires a closed contour');
              const regions=selected?.region?[selected.region]:S.profileRegions(selected?.sketch||sk.sk);
              if(!regions.length)throw new Error('The selected entities do not form a closed profile');
              for(const region of regions){
                const outer=loopWire(sk.frame,region.outer.segs),holes=region.holes.map(h=>loopWire(sk.frame,h.segs));
                try{let face=R.makeFace(outer);if(holes.length){const original=face;try{face=R.addHolesInFace(original,holes);}finally{original.delete();}}parts.push(face);owned.push(face);}finally{outer.delete();holes.forEach(w=>w.delete());}
              }
            }
            if(f.edges?.length){
              const all=[...solids,...surfaces],entries=[];
              for(const ref of f.edges){
                const owners=ref.body?all.filter(b=>b.id===ref.body):all;
                const found=owners.map(b=>({body:b,hit:findEdgeInfo(b.shape,ref)})).filter(x=>x.hit);
                if(found.length!==1)throw new Error('A planar boundary edge is missing or ambiguous');
                const {body,hit}=found[0];if(entries.some(e=>e.edge.isSame(hit.e)))throw new Error('A planar boundary edge is selected more than once');
                ref.body=body.id;updateEdgeRef(ref,hit.e,body.shape);entries.push({edge:hit.e});
              }
              const wire=patchBoundary(R,entries),oc=R.getOC();let maker;
              try{maker=new oc.BRepBuilderAPI_MakeFace(wire.wrapped,true);if(!maker.IsDone())throw new Error('All selected boundary edges must be coplanar and form a closed loop');const raw=maker.Face();try{const face=R.cast(raw);parts.push(face);owned.push(face);}finally{raw.delete();}}finally{maker?.delete();wire.delete();}
            }
            for(const face of parts){const check=new (R.getOC()).BRepCheck_Analyzer(face.wrapped,true);try{if(!check.IsValid())throw new Error('The selected entities do not form a valid planar surface');}finally{check.delete();}}
            // asShape retains these faces as its cached component shapes.
            const shape=asShape(parts);owned.length=0;surfaces.push(bodyRec(newId(f.id),shape,f.id));applied.push({op:'add',tool:shape});
            res.features[f.id]={...(res.features[f.id]||{}),edges:f.edges||[]};
            res.notes[f.id]=`Planar Surface · ${parts.length} selected region${parts.length===1?'':'s'}`;
          }finally{owned.forEach(face=>face.delete());}
          break;
        }
        case 'surfExtrude': {
          // (sketch contours, flat model faces' edges and chains of picked model edges, extruded along their plane's
          // normal or along Direction; a start and an end as for a solid extrusion, angled ones trimming it; a draft
          // for closed contours, each drafted as a solid by draftAway and its walls kept)
          const sections=surfaceSections(f),parts=[],oc=R.getOC();
          try{
            const along=f.direction&&f.direction!=='none'?unit(resolveAxis(f.direction).d):null;
            if(!along&&sections.some(s=>!s.planar))throw new Error('Model edges that do not lie in one plane need a Direction');
            const first=sections.find(s=>s.planar)||sections[0];
            if(!along)for(const s of sections)if(Math.abs(dot(s.frame.n,first.frame.n))<1-1e-7||Math.abs(dot(sub(s.frame.o,first.frame.o),first.frame.n))>1e-5)throw new Error('Surface profiles must lie in the same plane');
            const a=along||first.frame.n;
            const draftAng=ev(f.draft??0);
            if(!Number.isFinite(draftAng)||Math.abs(draftAng)>=89)throw new Error('The draft angle must be between 0° and 89°');
            const drafted=Math.abs(draftAng)>1e-9,ang=f.draftOutward?-draftAng:draftAng;
            const startMode=f.startFrom||'profile';
            if(!['profile','offset','surface'].includes(startMode))throw new Error('Select a supported extrusion start');
            const startSurface=startMode==='surface'?resolveSurface(f.startPlane,f.startFace):null,startOffset=startMode==='offset'?ev(f.startOffset??0):0;
            if(!Number.isFinite(startOffset))throw new Error('Start offset must be finite');
            if(startSurface&&Math.abs(dot(startSurface.n,a))<1e-7)throw new Error('The start surface is parallel to the extrusion direction');
            if(f.startFace&&startSurface)res.features[f.id]={...(res.features[f.id]||{}),startFace:f.startFace};
            const end=f.end||'blind';
            if(!['blind','midplane','twoSides','upToVertex','upToSurface','offsetSurface'].includes(end))throw new Error('Select a supported extrusion end');
            for(const s of sections){
              const fr=s.frame||frameOnPlane(s.centre,a),n=fr.n;
              if(Math.abs(dot(a,n))<1e-7)throw new Error('The extrusion direction lies in the contours’ plane');
              // (heights along a from p to a plane; planes parallel to the contours' plane at a height above its origin)
              const height=(pl,p)=>dot(sub(pl.p,p),pl.n)/dot(a,pl.n),at=(h)=>({p:add(fr.o,mul(a,h)),n});
              const start=startSurface||at(startOffset);
              let lower,upper;
              if(['blind','midplane','twoSides'].includes(end)){
                const iv=extrusionInterval(f,ev);lower={p:add(start.p,mul(a,iv.start)),n:start.n};upper={p:add(start.p,mul(a,iv.end)),n:start.n};
              }else{
                let E;
                if(end==='upToVertex'){E={p:resolvePoint(f.toPoint,f.toVertex),n};if(f.toVertex)res.features[f.id]={...(res.features[f.id]||{}),toVertex:f.toVertex};}
                else{
                  E=resolveSurface(f.toPlane,f.toFace);if(f.toFace)res.features[f.id]={...(res.features[f.id]||{}),toFace:f.toFace};
                  if(Math.abs(dot(E.n,a))<1e-7)throw new Error('The end surface is parallel to the extrusion direction');
                  if(end==='offsetSurface'){const offset=ev(f.toOffset)*(f.toFlip?-1:1),side=Math.sign(dot(sub(start.p,E.p),E.n))||1;E={...E,p:add(E.p,mul(E.n,side*offset))};}
                }
                const hs=height(start,fr.o),he=height(E,fr.o);
                if(Math.abs(he-hs)<1e-6)throw new Error('The end lies on the start');
                [lower,upper]=he>hs?[start,E]:[E,start];
              }
              const flat=(pl)=>Math.abs(dot(unit(pl.n),n))>1-1e-12;
              for(const [wi,{wire,closed}] of s.wires.entries()){
                const b=bbox(wire),corners=[];
                for(const x of [b.min[0],b.max[0]])for(const y of [b.min[1],b.max[1]])for(const z of [b.min[2],b.max[2]]){const p=[x,y,z];corners.push(sub(p,mul(a,dot(sub(p,fr.o),n)/dot(a,n))));}
                for(const p of corners)if(height(upper,p)-height(lower,p)<=1e-6)throw new Error('The start and end cross or leave no extrusion height over the contour');
                const parallel=flat(lower)&&flat(upper),low=Math.min(...corners.map(p=>height(lower,p))),high=Math.max(...corners.map(p=>height(upper,p)));
                const [h0,h1]=parallel?[height(lower,fr.o),height(upper,fr.o)]:[low-5,high+5];
                // (the wire's plane: its contour's, at height 0; moved to h0 and swept to h1)
                const sweep=(shape,g0=h0,g1=h1)=>{const v=new R.Vector(mul(a,g1-g0)),moved=shape.clone().translate(mul(a,g0)),mk=new oc.BRepPrimAPI_MakePrism(moved.wrapped,v.wrapped,false,true);try{return R.cast(mk.Shape());}finally{mk.delete();v.delete();moved.delete();}};
                const big=b.diag+Math.max(Math.abs(low),Math.abs(high))+len(fr.o)+100;
                const trim=(shape,always=false)=>{
                  if(parallel&&!always)return shape;
                  for(const [pl,sign] of [[lower,1],[upper,-1]]){
                    const nn=mul(pl.n,(dot(pl.n,a)>0?1:-1)*sign),u=unit(cross(nn,Math.abs(nn[0])<.9?[1,0,0]:[0,1,0]));
                    const block=R.drawRectangle(2*big,2*big).sketchOnPlane(new R.Plane(add(fr.o,mul(a,height(pl,fr.o))),u,nn)).extrude(2*big);
                    try{shape=boolByList('common',shape,[block]);}finally{block.delete();}
                  }
                  return shape;
                };
                if(!drafted){parts.push(trim(sweep(wire)));continue;}
                if(!closed){
                  // (an open contour, lines and arcs of a sketch: leaning to its left as drawn (Draft outward: its right)
                  // away from where it starts; the contour offset in its plane by the height times the angle's tangent,
                  // below and above the start (sketchoffset.js: lines stay lines, arcs arcs), joined by ruled faces (flat
                  // and conical), then trimmed to the ends)
                  const chain=s.chains?.[wi];
                  if(!chain||!s.sk)throw new Error('A draft of an open contour takes a sketch’s lines and arcs (not model edges)');
                  if(chain.items.some((it)=>!['line','arc'].includes(it.c.type)))throw new Error('A draft of an open contour takes lines and arcs');
                  if(along&&Math.abs(Math.abs(dot(a,n))-1)>1e-9)throw new Error('A draft of an open contour extrudes square to it (Along: None)');
                  if(!flat(start))throw new Error('A draft of an open contour starts from a plane parallel to it');
                  const hs=height(start,fr.o),tn=Math.tan((ang*Math.PI)/180),sgn=dot(a,n)>0?1:-1;
                  const level=(h)=>{
                    const d=Math.abs(h-hs)*tn,pl=rPlane(fr,add(fr.o,mul(fr.n,sgn*h)));
                    const pieces=Math.abs(d)<1e-12?null:SO.geometry(s.sk,chain,d).pieces;
                    if(!pieces)return wire.clone().translate(mul(a,h));
                    let pen=R.draw(pieces[0].a);
                    for(const g of pieces){
                      if(g.type==='line')pen=pen.lineTo(g.b);
                      else{const a0=Math.atan2(g.a[1]-g.c[1],g.a[0]-g.c[0]),sw=g.span*(g.rev?-1:1);pen=pen.threePointsArcTo(g.b,[g.c[0]+g.r*Math.cos(a0+sw/2),g.c[1]+g.r*Math.sin(a0+sw/2)]);}
                    }
                    return pen.done().sketchOnPlane(pl).wire;
                  };
                  let shell;
                  const ws=[level(low-5),level(hs),level(high+5)];
                  try{shell=R.loft(ws,{ruled:true},true);}catch(e){if(isFatal(e))throw e;throw new Error('The open contour could not be drafted at this angle (an arc would shrink to nothing?)');}
                  finally{ws.forEach((w)=>w.delete());}
                  parts.push(trim(shell,true));
                  continue;
                }
                const face=R.makeFace(wire);let solid;
                try{solid=trim(sweep(face));}finally{face.delete();}
                if(!solidsOf(solid).length)throw new Error('The start and end leave no extrusion');
                const out=draftAway(solid,start,a,ang,[lower,upper]);
                const onEnd=(fc)=>fc.geomType==='PLANE'&&[lower,upper].some(pl=>Math.abs(dot(unit(vec(fc.normalAt())),unit(pl.n)))>1-1e-9&&Math.abs(dot(sub(flatCentre(fc),pl.p),unit(pl.n)))<1e-6);
                const walls=out.faces.filter(fc=>!onEnd(fc));
                if(!walls.length)throw new Error('The draft could not be made');
                parts.push(asShape(walls));
              }
            }
          }finally{sections.forEach(s=>s.wires.forEach(w=>w.wire.delete()));}
          for(const part of parts){const check=new oc.BRepCheck_Analyzer(part.wrapped,true);try{if(!check.IsValid())throw new Error('The selected contour cannot form a valid surface with this direction and these ends');}finally{check.delete();}}
          const shape=asShape(parts);
          if(!shape.faces.length)throw new Error('The start and end leave no surface');
          surfaces.push(bodyRec(newId(f.id),shape,f.id));
          applied.push({op:'add',tool:shape});
          break;
        }
        case 'surfRevolve': {
          const sections=surfaceSections(f,true),parts=[];
          try{
            const first=sections.find(s=>s.planar)||sections[0];
            for(const sk of sections)if(sk.planar&&first.planar&&(Math.abs(dot(sk.frame.n,first.frame.n))<1-1e-7||Math.abs(dot(sub(sk.frame.o,first.frame.o),first.frame.n))>1e-5))throw new Error('Surface profiles must lie in the same plane');
            if(!first.planar&&f.projectAxis)throw new Error('Model edges that do not lie in one plane cannot have the axis projected into their plane');
            const oc=R.getOC(),axis=revolveAxisOf(f,first),revolution=revolveExtent(f,first,axis);
            for(const sk of sections){
              if(sk.planar)checkRevolveAxis(sk,axis);
              for(const {wire} of sk.wires){
                const ax=R.makeAx1(axis.o,axis.d),maker=new oc.BRepPrimAPI_MakeRevol(wire.wrapped,ax,revolution.angle*Math.PI/180,false);
                try{let shape=R.cast(maker.Shape());if(revolution.start)shape=shape.rotate(revolution.start,axis.o,axis.d);parts.push(shape);}finally{maker.delete();ax.delete();}
              }
            }
            if(revolution.clip){
              // (up to a plane beside the axis: the surface turned 359°, cut by the plane; of what lies on the profile's side,
              // the pieces (faces joined by edges) that start at the profile and do not reach the far end)
              const pl=revolution.clip,c=profileCentre(first),side=Math.sign(dot(sub(c,pl.p),pl.n)),sgn=f.reverse?-1:1;
              if(!side)throw new Error('The end surface passes through the profile');
              const nIn=mul(unit(pl.n),side),all=asShape(parts),b=bbox(all),big=b.diag+len(sub(b.center,pl.p))+100,u=unit(cross(nIn,Math.abs(nIn[0])<.9?[1,0,0]:[0,1,0]));
              const block=R.drawRectangle(2*big,2*big).sketchOnPlane(new R.Plane(pl.p,u,nIn)).extrude(2*big);
              let kept;try{kept=boolByList('common',all,[block]);}finally{block.delete();}
              const faces=kept.faces,group=faces.map((_,i)=>i),root=(i)=>(group[i]===i?i:(group[i]=root(group[i])));
              const edgesOf=faces.map((fc)=>fc.edges);
              for(let i=0;i<faces.length;i++)for(let j=i+1;j<faces.length;j++)if(edgesOf[i].some((e)=>edgesOf[j].some((x)=>x.isSame(e))))group[root(i)]=root(j);
              const pieces=new Map();faces.forEach((fc,i)=>{const r=root(i);if(!pieces.has(r))pieces.set(r,[]);pieces.get(r).push(fc);});
              const start=asShape(sections.flatMap((s)=>s.wires.map((w)=>w.wire))),end=start.clone().rotate(sgn*359,axis.o,axis.d);
              const touches=(shape,other)=>{const q=new R.DistanceQuery(shape);try{return q.distanceTo(other)<1e-7;}finally{q.delete();}};
              const keep=[...pieces.values()].map((fs)=>asShape(fs)).filter((p)=>touches(p,start));
              if(!keep.length)throw new Error('The end surface leaves nothing of the revolution');
              if(keep.some((p)=>touches(p,end)))throw new Error('The end surface does not stop the revolution all the way round');
              parts.length=0;parts.push(...keep);
            }
            for(const part of parts){const check=new oc.BRepCheck_Analyzer(part.wrapped,true);try{if(!check.IsValid())throw new Error('The selected contour cannot form a valid surface with this axis and direction');}finally{check.delete();}}
          }finally{sections.forEach(s=>s.wires.forEach(w=>w.wire.delete()));}
          const shape = asShape(parts);
          surfaces.push(bodyRec(newId(f.id), shape, f.id));
          applied.push({ op: 'add', tool: shape });
          break;
        }
        case 'surfLoft': {
          // a surface through two or more profiles (open or closed chains of sketches / 3D sketches)
          const ids = (f.profiles || []).filter(Boolean);
          if (ids.length < 2) throw new Error('Select at least two profiles (in order)');
          const connectorControls=loftConnectionControls(f,ids);
          const wires = ids.map((id) => {
            if (curves.has(id)) return curves.get(id).wire;
            const sk = sketches.get(LR.sourceId(id));
            if (!sk) throw new Error('A profile is missing, suppressed or has errors');
            const resolved = typeof id === 'string' ? { sketch: sk.sk } : LR.resolveContour(sk.sk, id);
            if (resolved.region) return sectionWire(loftSection(sk.frame, resolved.region.outer.segs));
            const subset = resolved.sketch;
            const ws = sketchWires(subset, sk.frame);
            if (ws.length !== 1) throw new Error(`${sk.sk.name} must be one connected chain of curves (it has ${ws.length})`);
            return ws[0];
          });
          // (a sketch's chain says itself whether it is closed; a curve is when its ends meet, to a thousandth of a mm)
          const ends = wires.map((w) => len(sub(vec(w.startPoint), vec(w.endPoint))));
          // (a profile: a sketch, a contour of one (loftrefs.js), or a curve)
          const pname = (id, i) => (curves.has(id) ? doc.features.find((x) => x.id === id)?.name : sketches.get(LR.sourceId(id))?.sk.name) || `Profile ${i + 1}`;
          const closed = ids.map((id, i) => {
            if (curves.has(id)) return ends[i] < 1e-3;
            const sk = sketches.get(LR.sourceId(id)), resolved = typeof id === 'string' ? { sketch: sk.sk } : LR.resolveContour(sk.sk, id);
            return !!resolved.region || S.curveChains(resolved.sketch).some((c) => c.closed);
          });
          if (closed.some((c) => c !== closed[0])) {
            const nm = (i) => pname(ids[i], i);
            const io = closed.indexOf(false), ic = closed.indexOf(true);
            throw new Error(`The profiles must all be open, or all closed: ${nm(ic)} is closed but ${nm(io)} is open (its ends are ${ends[io] < 0.01 ? ends[io].toExponential(1) : ends[io].toFixed(2)} mm apart)`);
          }
          let list = wires, closedSecs = null;
          if (closed[0]) {
            // closed profiles: matched like a solid loft (same start points, same way round)
            const secs = ids.map((id, i) => {
              if (curves.has(id)) return null;
              const sk = sketches.get(LR.sourceId(id)), resolved = typeof id === 'string' ? { sketch: sk.sk } : LR.resolveContour(sk.sk, id);
              if (resolved.region) return loftSection(sk.frame, resolved.region.outer.segs);
              const subset = resolved.sketch;
              const ch = S.curveChains(subset).find((c) => c.closed);
              return loftSection(sk.frame, S.chainSegs(subset, ch));
            });
            if (secs.every(Boolean)) {
              if (connectorControls) secs.forEach((s, i) => { secs[i] = LC.splitSectionAt(s, connectorControls[i].anchor); });
              closedSecs = matchLoftSections(secs, ids.map((id) => sketches.get(LR.sourceId(id)).sk.name));
              if(connectorControls)closedSecs=LC.applySectionConnections(closedSecs,secs,connectorControls,true);
              list = closedSecs.map(sectionWire);
              if(connectorControls)loftConnectionInfo(f,ids,closedSecs,true);
            }
          } else {
            // open profiles: each one runs the same way as the one before it
            list = [wires[0]];
            for (let i = 1; i < wires.length; i++) {
              const prev = list[i - 1], w = wires[i];
              const a = vec(prev.startPoint), b = vec(prev.endPoint);
              const same = len(sub(vec(w.startPoint), a)) + len(sub(vec(w.endPoint), b)), flipped = len(sub(vec(w.endPoint), a)) + len(sub(vec(w.startPoint), b));
              list.push(flipped < same ? R.cast(w.wrapped.Reversed()) : w);
            }
            if(connectorControls){
              const sections=ids.map((ref,i)=>{
                const source=sketches.get(LR.sourceId(ref)),subset=typeof ref==='string'?source.sk:LR.resolveContour(source.sk,ref).sketch,chain=S.curveChains(subset)[0];
                let section=loftSection(source.frame,S.chainSegs(subset,chain));const start=vec(list[i].startPoint);
                if(len(sub(section.segs.at(-1).b,start))<len(sub(section.segs[0].a,start)))section=LC.reverseSection(section);
                const control=connectorControls[i];if(control.anchor){
                  if(control.reverse)throw new Error('For an open profile choose a start endpoint or reverse traversal, not both');
                  if(len(sub(control.anchor,section.segs.at(-1).b))<=1e-5)section=LC.reverseSection(section);
                  else if(len(sub(control.anchor,section.segs[0].a))>1e-5)throw new Error('An open profile connector must attach to one of its endpoints');
                }
                return control.reverse?LC.reverseSection(section):section;
              });
              if(sections.some(s=>s.segs.length!==sections[0].segs.length))throw new Error('Manual connectors require matching curve counts in open profiles; split the curves so the counts match');
              list=sections.map(sectionWire);loftConnectionInfo(f,ids,sections,false);
            }
          }
          // guide curves (as the solid loft's: sketches, contours of them or curves, each through every profile): the
          // surface follows them
          const guides = (f.guides || []).filter(Boolean).map((id) => {
            if (curves.has(id)) return { name: doc.features.find((x) => x.id === id)?.name || 'A guide curve', wire: curves.get(id).wire };
            const s = sketches.get(LR.sourceId(id));
            if (!s) throw new Error('A guide curve is missing, suppressed or has errors');
            const ws = sketchWires(typeof id === 'string' ? s.sk : LR.resolveContour(s.sk, id, true).sketch, s.frame);
            if (ws.length !== 1) throw new Error(`The guide ${s.sk.name} must be one connected chain of curves`);
            return { name: s.sk.name, wire: ws[0] };
          });
          if (guides.length && f.ruled) throw new Error('Guide curves shape a smooth surface: untick "Straight (ruled) between profiles"');
          if (hasLoftEnds(f)) {
            const endWires = closedSecs ? closedSecs.map(sectionWire) : list;
            const shape = buildEndLoft(f, ids, endWires, true, { guides, matched: closedSecs || wireSections(list, !closed[0]), names: ids.map(pname), open: !closed[0], profileWires: closed[0] ? null : list });
            surfaces.push(bodyRec(newId(f.id), shape, f.id)); applied.push({ op: 'add', tool: shape }); break;
          }
          if (guides.length) {
            const names = ids.map(pname);
            // (closed sketch profiles: their matched segments; otherwise the profiles as they are, as runs of points)
            const g = buildGuidedLoft(closedSecs || wireSections(list, !closed[0]), guides, names, [], 0,
              { surface: true, open: !closed[0], profileWires: list, constrained: f.guideMethod === 'constrained', guideContinuity: f.guideContinuity || 'C0', build: (wires) => connectorControls?manualLoft(wires,f,true):R.loft(wires, { ruled: false }, true) });
            res.notes[f.id] = `${ids.length} profiles, ${guides.length} guide curve${guides.length === 1 ? '' : 's'}` + guideConstraintNote(g);
            surfaces.push(bodyRec(newId(f.id), g.shape, f.id));
            applied.push({ op: 'add', tool: g.shape });
            break;
          }
          let shape;
          try { shape = connectorControls?manualLoft(list,f,true):R.loft(list, { ruled: !!f.ruled }, true); } catch (e) { if (isFatal(e)) throw e; throw new Error(guides.length ? 'The surface could not be lofted through these profiles and guide curves' : `The surface could not be lofted through these profiles${connectorControls?': '+e.message:''}`); }
          surfaces.push(bodyRec(newId(f.id), shape, f.id));
          applied.push({ op: 'add', tool: shape });
          break;
        }
        case 'surfSweep': {
          const owned=[];
          try{
          checkSweepRefs(f);
          const ps=f.profileType==='circle'||!f.profile?null:sketches.get(LR.sourceId(f.profile));
          const {wire:spine,helical}=sweepPath(f,owned,ps?.frame);
          let profile;
          if (f.profileType === 'circle') {
            const dia = ev(f.diameter);
            if (!(dia > 0)) throw new Error('The diameter must be greater than zero');
            profile = R.assembleWire([R.makeCircle(dia / 2, vec(spine.startPoint), unit(vec(spine.tangentAt(0))))]);owned.push(profile);
          } else {
            if(!f.profile)throw new Error('Select a surface sweep profile');
            if(!ps)throw new Error('The profile sketch is missing, suppressed or has errors');
            const subset=typeof f.profile==='string'?ps.sk:LR.resolveContour(ps.sk,f.profile).sketch;
            const ws=sketchWires(subset,ps.frame);owned.push(...ws);
            if(ws.length!==1)throw new Error('The surface profile must be one connected chain of curves without holes');
            profile=ws[0];
          }
          const guide=f.guide?sweepWire(f.guide,'guide',owned).wire:null;
          const options = sweepOptions(f, spine, guide);
          let shape = guide ? sweepWithGuide(profile, spine, guide, f.guideMode || 'orientation', true) : sweepAlong(profile, spine, options, { surface: true, helical });
          if (guide) res.notes[f.id] = `Path and one guide · ${f.guideMode === 'contact' ? 'Section size; CAD guide contact ≤ 0.0001 mm' : 'Orientation; constant profile size'} · Uncapped surface`;
          if (!shape) throw new Error('The profile could not be swept along the path (place it at the start of the path, across it)');
          surfaces.push(bodyRec(newId(f.id), shape, f.id));
          applied.push({ op: 'add', tool: shape });
          }finally{owned.reverse().forEach(w=>w.delete());}
          break;
        }
        case 'surfFill': {
          if (!(f.edges || []).length) throw new Error('Click the edges round the hole to fill');
          const all=[...solids,...surfaces],whole=compoundOf(all),mode=patchContinuity(f);
          if(!['G0','G1','G2'].includes(mode))throw new Error('Select a supported patch continuity (G0, G1 or G2)');
          const found=f.edges.map(ref=>{
            const candidates=ref.body?all.filter(b=>b.id===ref.body):all;
            const body=candidates.length===all.length?whole:compoundOf(candidates);
            const hit=findEdgeInfo(body,ref);
            if(body&&body!==whole&&candidates.length>1)body.delete();
            return hit;
          });
          if(found.some(x=>!x))throw new Error('A boundary edge could not be found in the model');
          const constrained=f.edges.some(ref=>(ref.continuity||mode)!=='G0');
          const selected=(constrained?(f.supportFaces||[]):[]).map(ref=>{
            const hit=findFaceAny(all.filter(b=>!ref.body||b.id===ref.body),ref);
            if(!hit)throw new Error('A patch support face is missing');return hit.face;
          });
          const entries=[],recs=new Set(),used=new Set();
          for(let i=0;i<found.length;i++){
            const edge=found[i].e,ref=f.edges[i],continuity=ref.continuity||mode;
            if(!['G0','G1','G2'].includes(continuity))throw new Error('Select a supported patch edge continuity (G0, G1 or G2)');
            if(entries.some(x=>x.edge.isSame(edge)))throw new Error('A patch boundary edge is selected more than once');
            const owners=all.filter(b=>edgeInfos(b.shape).some(x=>x.e.isSame(edge)));
            owners.forEach(b=>recs.add(b));
            const adjacent=[];
            for(const body of owners)for(const {face} of facesWithBox(body.shape)){
              const edges=face.edges;
              try{if(edges.some(e=>e.isSame(edge))&&!adjacent.some(f=>f.isSame(face)))adjacent.push(face);}finally{edges.forEach(e=>e.delete());}
            }
            let support=null;
            if(continuity!=='G0'){
              const choices=selected.length?adjacent.filter(face=>selected.some(f=>f.isSame(face))):adjacent;
              if(choices.length!==1)throw new Error(choices.length?'The patch support is ambiguous; select one adjacent support face for each constrained edge':'Select an adjacent support face for each G1/G2 patch edge');
              support=choices[0];used.add(support);
            }
            if(owners.length===1){ref.body=owners[0].id;updateEdgeRef(ref,edge,owners[0].shape);}
            const reach=ref.reach==null||ref.reach===''?0:ev(ref.reach);
            if(!(Number.isFinite(reach)&&reach>=0))throw new Error('The tangent reach must be zero or more');
            entries.push({edge,support,continuity,reach});
          }
          // (curves and points inside the opening that the patch passes through: sketches, 3D sketches and curves;
          // reference points and the standalone points of sketches)
          const interior={edges:[],points:[]};
          for(const id of f.throughCurves||[]){
            if(curves.has(id)){interior.edges.push(...curves.get(id).wire.edges);continue;}
            const s=sketches.get(id);if(!s)throw new Error('A curve the patch passes through is missing, suppressed or has errors');
            for(const w of sketchWires(s.sk,s.frame))interior.edges.push(...w.edges);
          }
          for(const id of f.throughPoints||[]){
            if(points.has(id)){interior.points.push(points.get(id));continue;}
            const s=sketches.get(id);if(!s)throw new Error('A point the patch passes through is missing, suppressed or has errors');
            const used=new Set(s.sk.curves.flatMap(c=>[c.p1,c.p2,c.c,c.a,...(c.pts||[])]).filter(Boolean)),pts=s.sk.points.filter(q=>q.id!=='O'&&!used.has(q.id));
            if(!pts.length)throw new Error(`${s.sk.name} has no points of its own (points not on its curves) for the patch to pass through`);
            interior.points.push(...pts.map(q=>S.fromFrame2D(s.frame,q.x,q.y)));
          }
          if(entries.some(e=>e.continuity!=='G0')&&selected.some(face=>![...used].some(f=>f.isSame(face))))throw new Error('A selected patch support face is not adjacent to a constrained boundary edge');
          const result=buildSurfacePatch(R,entries,{fatal:isFatal,message:e=>e instanceof WebAssembly.Exception?R.getOC().getExceptionMessage(e).join(': '):e.message||String(e),stack,interior:interior.edges.length||interior.points.length?interior:null});
          const patch=result.shape,surfRec=recs.size===1&&surfaces.includes([...recs][0])?[...recs][0]:null;
          let note='';
          try{
            if(f.merge!==false&&surfRec){
              const sewn=sewShapes([surfRec.shape,patch],1e-4);let transferred=false;
              try{
                verifyPatch(R,sewn,entries,patch);
                const sol=f.solid&&holeLoops(sewn).freeEdges===0?solidFromSewn(sewn):null;
                surfaces=surfaces.filter(r=>r!==surfRec);
                if(sol)apply('add',unify(sol),true);
                else{surfaces.push(bodyRec(surfRec.id,sewn,f.id));transferred=true;if(f.solid)note=' · Surface remains open';}
              }finally{if(!transferred)sewn.delete();}
            }else surfaces.push(bodyRec(newId(f.id),patch,f.id));
            applied.push({op:'add',tool:patch});
            res.features[f.id]={...(res.features[f.id]||{}),edges:f.edges,supportFaces:f.supportFaces||[]};
            const modes=[...new Set(entries.map(e=>e.continuity))].join('/');
            res.notes[f.id]=`Patch ${modes} · CAD contact ${result.contact.toExponential(2)} mm · normal mismatch ${result.angle.toFixed(4)} deg`+(entries.some(e=>e.continuity==='G2')?` · curvature mismatch ${result.curvature.toExponential(2)} 1/mm`:'')+note;
          }catch(e){patch.delete();throw e;}
          break;
        }
        case 'surfTrim': {
          // surfaces cut by a plane, a surface body or a sketch; the clicked pieces are kept (or removed)
          let tool = null, toolRec = null;
          if (f.tool && (STD[f.tool] || planes.has(f.tool))) { const fr = resolveFrame(f.tool); tool = planeFace(fr.o, fr.n); }
          else if (f.tool && sketches.get(f.tool)) {
            const sk = sketches.get(f.tool), L = 2 * ([...solids, ...surfaces].length ? bboxOfAll([...solids, ...surfaces].map((r) => r.shape)).diag : 100) + 10;
            const ws = sketchWires(sk.sk, sk.frame);
            if (!ws.length) throw new Error('The trim sketch has no curves');
            const oc = R.getOC();
            tool = asShape(ws.map((w) => { const v = new R.Vector(mul(sk.frame.n, 2 * L)), mk = new oc.BRepPrimAPI_MakePrism(w.clone().translate(mul(sk.frame.n, -L)).wrapped, v.wrapped, false, true); const sh = R.cast(mk.Shape()); mk.delete(); v.delete(); return sh; }));
          } else if (f.tool) { toolRec = surfaces.find((r) => r.id === f.tool); if (!toolRec) throw new Error('The trim tool surface no longer exists'); tool = toolRec.shape; }
          else throw new Error('Choose the trim tool: a plane, a surface body or a sketch');
          if (!(f.faces || []).length) throw new Error('Click the pieces to keep (or to remove)');
          // the surfaces clicked on (and the tool surface too, for a mutual trim)
          const targets = [...new Set(f.faces.map((r) => findFaceAny(surfaces, r)?.body).filter(Boolean))];
          if (f.mutual && toolRec && !targets.includes(toolRec)) targets.push(toolRec);
          if (!targets.length) throw new Error('Click on the surface bodies to trim');
          let cut = false;
          for (const rec of targets) {
            const other = rec === toolRec ? asShape(targets.filter((x) => x !== rec).map((x) => x.shape)) : tool;
            const oc = R.getOC(), sp = new oc.BRepAlgoAPI_Splitter(), A = ocList([rec.shape]), T = ocList([other]);
            sp.SetArguments(A); sp.SetTools(T); sp.Build(new oc.Message_ProgressRange());
            const bad = sp.HasErrors(), split = bad ? null : R.cast(sp.Shape());
            sp.delete(); A.delete(); T.delete();
            if (!split) throw new Error('The surface could not be trimmed with that tool');
            // pieces: faces joined except across edges lying on the tool
            const faces = [...R.iterTopo(split.wrapped, 'face')].map((x) => R.cast(x));
            const onTool = (e) => new R.DistanceQuery(R.makeVertex(vec(e.pointAt(0.5)))).distanceTo(other) < 1e-5;
            const parent = faces.map((_, i) => i), find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
            for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length; j++) {
              const sh = faces[i].edges.filter((e) => faces[j].edges.some((x) => x.isSame(e)));
              if (sh.some((e) => !onTool(e))) parent[find(i)] = find(j);
            }
            const groups = new Map();
            faces.forEach((fc, i) => { const k = find(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(fc); });
            if (groups.size < 2) continue;
            cut = true;
            const picked = (fs) => f.faces.some((r) => fs.some((fc) => new R.DistanceQuery(R.makeVertex(r.p)).distanceTo(fc) < Math.max(1e-3, bbox(rec.shape).diag * 1e-4)));
            const keep = [...groups.values()].filter((fs) => (f.mode === 'remove' ? !picked(fs) : picked(fs)));
            // (a mutual trim: on the tool surface with nothing clicked, the side facing the others' kept pieces is not guessed: all of it stays)
            const kept = keep.length ? keep : rec === toolRec ? [...groups.values()] : [];
            surfaces = surfaces.filter((r) => r !== rec);
            if (kept.length) surfaces.push(bodyRec(rec.id, sewShapes(kept.flat(), 1e-6), f.id));
          }
          if (!cut) throw new Error('The tool does not cut the surfaces into pieces');
          break;
        }
        case 'surfExtend': {
          // surface edges extended straight on (tangent to the surface) by a distance
          if (!(f.edges || []).length) throw new Error('Click the edges of a surface to extend');
          const d = ev(f.distance);
          if (!(d > 0)) throw new Error('The distance must be greater than zero');
          const whole = compoundOf(surfaces);
          if (!surfaces.length) throw new Error('There is no surface body to extend');
          const byRec = new Map();
          for (const ref of f.edges) {
            const hit = findEdgeInfo(whole, ref);
            if (!hit) throw new Error('A selected edge could not be found on a surface body');
            const rec = surfaces.find((r) => r.shape.edges.some((x) => x.isSame(hit.e)));
            const face = rec?.shape.faces.find((fc) => fc.edges.some((x) => x.isSame(hit.e)));
            if (!face) throw new Error('A selected edge is not on a surface body');
            if (rec.shape.faces.filter((fc) => fc.edges.some((x) => x.isSame(hit.e))).length > 1) throw new Error('Extend the open edges of a surface (an edge between two faces cannot be extended)');
            const e = hit.e, n = 9, P = [], Q = [];
            for (let i = 0; i <= n; i++) {
              const t = i / n, p0 = vec(e.pointAt(t)), tg = unit(vec(e.tangentAt(t))), nm = unit(vec(face.normalAt(p0)));
              let o = unit(cross(tg, nm));
              // outward: away from the face
              const probe = add(p0, mul(o, -Math.max(1e-3, d * 1e-3)));
              if (new R.DistanceQuery(R.makeVertex(probe)).distanceTo(face) > Math.max(1e-4, d * 1e-4)) o = mul(o, -1);
              P.push(p0); Q.push(add(p0, mul(o, d)));
            }
            const straight = e.geomType === 'LINE' && len(sub(sub(Q[0], P[0]), sub(Q[n], P[n]))) < 1e-9 * (1 + d);
            const far = straight ? R.makeLine(Q[0], Q[n]) : R.makeBSplineApproximation(Q.map((q) => new R.Vector(q)));
            const ext = R.loft([R.assembleWire([e.clone()]), R.assembleWire([far])], { ruled: true }, true);
            if (!byRec.has(rec)) byRec.set(rec, []);
            byRec.get(rec).push(ext);
          }
          for (const [rec, exts] of byRec) {
            surfaces = surfaces.map((r) => (r === rec ? bodyRec(rec.id, sewShapes([rec.shape, ...exts], 1e-5), f.id) : r));
            for (const x of exts) applied.push({ op: 'add', tool: x });
          }
          break;
        }
        case 'deleteFace': {
          // faces taken out of a solid or surface: left open (a surface body), or each hole patched over
          if (!(f.faces || []).length) throw new Error('Click the faces to delete');
          const hits = f.faces.map((r) => findFaceAny([...solids, ...surfaces], r));
          if (hits.some((h) => !h)) throw new Error('A selected face could not be found in the model');
          const rec = hits[0].body;
          if (hits.some((h) => h.body !== rec)) throw new Error('The faces must be on the same body');
          const keep = rec.shape.faces.filter((fc) => !hits.some((h) => h.face.isSame(fc)));
          if (!keep.length) throw new Error('That would delete every face of the body (use Delete Body instead)');
          if (f.mode === 'heal') {
            // (Kernel Lab k14: the faces round them grown or shrunk to close the gap)
            if (!R.getOC().LabDefeature) throw new Error('Delete and heal needs the geometry kernel with defeaturing');
            if (!solids.includes(rec)) throw new Error('Delete and heal works on solids');
            const out = labDefeature(rec.shape, hits.map((h) => h.face));
            if (!out) throw new Error(`The faces could not be taken out: ${labDefeatureError() || 'the faces round them cannot close the gap'}`);
            replaceSolid(rec, unify(out), f.id);
            res.notes[f.id] = `${hits.length} face${hits.length === 1 ? '' : 's'} deleted, the faces round them carried on to close the gap`;
            break;
          }
          let sewn = sewShapes(keep, 1e-6);
          let note = `${hits.length} face${hits.length === 1 ? '' : 's'} deleted`;
          if (f.mode === 'patch') {
            const { loops } = holeLoops(sewn), oc = R.getOC(), patches = [];
            for (const loop of loops) {
              const mk = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9);
              try {
                for (const e of loop.edges) {
                  const sup = f.tangent ? keep.find((fc) => fc.edges.some((x) => x.isSame(e))) : null;
                  if (sup) mk.Add(e.wrapped, sup.wrapped, oc.GeomAbs_Shape.GeomAbs_G1, true); else mk.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
                }
                mk.Build();
                patches.push(R.cast(mk.Shape()));
              } catch (e) { if (isFatal(e)) throw e; const hp = holePatch(loop, 1e-6); if (!hp) throw new Error('A hole left by the deleted faces could not be patched'); patches.push(...hp); } finally { mk.delete(); }
            }
            sewn = sewShapes([sewn, ...patches], 1e-4);
            note += `, ${patches.length} hole${patches.length === 1 ? '' : 's'} patched`;
          }
          // (a solid only when nothing is left open)
          const sol = holeLoops(sewn).freeEdges === 0 ? solidFromSewn(sewn) : null;
          solids = solids.filter((r) => r !== rec);
          surfaces = surfaces.filter((r) => r !== rec);
          if (sol) solids.push(bodyRec(rec.id, unify(sol), f.id));
          else { surfaces.push(bodyRec(rec.id, sewn, f.id)); if (solidsOf(rec.shape).length) note += ' (the body is now a surface body)'; }
          body = compoundOf(solids);
          res.notes[f.id] = note;
          break;
        }
        case 'editFillet': {
          // Delete Fillet / Resize Fillet (direct editing, e.g. of an imported part): each picked fillet or chamfer face
          // taken back to the sharp edge its neighbours meet at (mode 'delete'), or then rounded or chamfered again at
          // radius (mode 'resize')
          if (!(f.faces || []).length) throw new Error('Click the fillet or chamfer faces');
          const resize = f.mode === 'resize', r = resize ? ev(f.radius) : 0;
          if (resize && !(r > 0)) throw new Error('The new size must be more than zero');
          let rec = null;
          const sharp = [];
          // (Kernel Lab k14: all the faces at once by the kernel's defeaturing, exact for any blend; else one by one)
          if (R.getOC().LabDefeature) {
            const hits = f.faces.map((r0) => findFaceAny(solids, r0));
            if (hits.every(Boolean) && hits.every((h) => h.body === hits[0].body)) {
              const kinds = hits.map((h) => surfOf(h.face)), cham = kinds.every((x) => x.t === 'PLANE');
              const r0 = hits[0].body, out = labDefeature(r0.shape, hits.map((h) => h.face));
              if (out) {
                const before = r0.shape;
                rec = replaceSolid(r0, unify(out), f.id)[0];
                if (resize) {
                  const edges = newEdgesNear(before, rec.shape, hits.map((h) => h.face));
                  if (!edges.length) throw new Error('The sharp edge could not be found to round again');
                  let o2;
                  try { o2 = rec.shape[cham ? 'chamfer' : 'fillet']((x) => (edges.some((y) => y.isSame(x)) ? r : null)); } catch (e) { if (isFatal(e)) throw e; throw new Error(`The edge${edges.length > 1 ? 's' : ''} could not be ${cham ? 'chamfered' : 'rounded'} at ${r} (too big for the faces beside ${edges.length > 1 ? 'them' : 'it'}?)`); }
                  replaceSolid(rec, unify(o2), f.id);
                }
                const was = [...new Set(kinds.map((x) => (x.t === 'PLANE' ? 'chamfered' : x.t === 'TORUS' ? `R${+x.r2.toFixed(4)}` : x.r ? `R${+x.r.toFixed(4)}` : 'blended')))].join(', ');
                res.notes[f.id] = `${f.faces.length} face${f.faces.length === 1 ? '' : 's'} ${resize ? `resized to ${r}` : 'deleted'} exactly (was ${was})`;
                break;
              }
            }
          }
          for (const ref of f.faces) {
            const hit = findFaceAny(rec ? [rec] : solids, ref);
            if (!hit) throw new Error(rec ? 'The faces must be on the same body' : 'A selected face could not be found on a solid body');
            rec = hit.body;
            const b = blendCorner(rec.shape, hit.face), out = unify(b.convex ? rec.shape.fuse(b.tool) : rec.shape.cut(b.tool));
            if (solidsOf(out).length !== solidsOf(rec.shape).length) throw new Error('Taking out that face would split the body');
            rec = replaceSolid(rec, out, f.id)[0];
            sharp.push(b);
          }
          if (resize) {
            const edges = sharp.flatMap((b) => edgesAlong(rec.shape, b.edge)), cham = sharp.every((b) => b.chamfer);
            if (!edges.length) throw new Error('The sharp edge could not be found to round again');
            let out;
            try { out = rec.shape[cham ? 'chamfer' : 'fillet']((x) => (edges.some((y) => y.isSame(x)) ? r : null)); } catch (e) { if (isFatal(e)) throw e; throw new Error(`The edge${edges.length > 1 ? 's' : ''} could not be ${cham ? 'chamfered' : 'rounded'} at ${r} (too big for the faces beside ${edges.length > 1 ? 'them' : 'it'}?)`); }
            replaceSolid(rec, unify(out), f.id);
          }
          res.notes[f.id] = `${f.faces.length} ${sharp.every((b) => b.chamfer) ? 'chamfer' : 'fillet'}${f.faces.length === 1 ? '' : 's'} ${resize ? `resized to ${r}` : 'deleted'} (was ${[...new Set(sharp.map((b) => (b.chamfer ? 'chamfered' : `R${+b.r.toFixed(4)}`)))].join(', ')})`;
          break;
        }
        case 'defeature': {
          // Defeature: fillets up to filletR and holes up to holeD across taken out of a body (or every solid), for a
          // simpler part to send on or analyse; each one exactly (the faces round it carried back to meet)
          const maxR = f.fillets === false ? 0 : ev(f.filletR ?? 0), maxD = f.holes === false ? 0 : ev(f.holeD ?? 0);
          if (!(maxR > 0) && !(maxD > 0)) throw new Error('Give a fillet radius or a hole size to take out');
          const recs = f.body ? solids.filter((x) => x.id === f.body) : [...solids];
          if (!recs.length) throw new Error(f.body ? 'The body is missing' : 'There is no solid to defeature');
          let nf = 0, nh = 0, exact = false;
          for (const rec of recs) {
            // (Kernel Lab k14: every such face at once by the kernel's defeaturing; else one by one with booleans)
            if (R.getOC().LabDefeature) {
              const faces = defeatureFaces(rec.shape, maxR, maxD), kinds = faces.map((x) => ({ ...surfOf(x), seam: faceHasSeam(x) }));
              const done = faces.length ? labDefeature(rec.shape, faces) : null;
              if (done) {
                nf += kinds.filter((x) => (x.t === 'CYLINDER' && !x.seam) || x.t === 'TORUS' || x.t === 'SPHERE').length;
                nh += kinds.filter((x) => x.t === 'CYLINDER' && x.seam).length;
                replaceSolid(rec, unify(done), f.id);
                exact = true;
                continue;
              }
            }
            const out = defeatureShape(rec.shape, maxR, maxD);
            nf += out.fillets; nh += out.holes;
            if (out.fillets || out.holes) replaceSolid(rec, out.shape, f.id);
          }
          res.notes[f.id] = exact ? `${nf} fillet face${nf === 1 ? '' : 's'} and ${nh} hole${nh === 1 ? '' : 's'} taken out exactly` : `${nf} fillet${nf === 1 ? '' : 's'} and ${nh} hole${nh === 1 ? '' : 's'} taken out`;
          break;
        }
        case 'replaceFace': {
          // a flat face of a solid moved onto a surface body: the body is carried through the face and cut back
          // to the surface (the surface must reach past the face's outline)
          if (!(f.faces || []).length) throw new Error('Click the flat faces to replace');
          const tool = surfaces.find((r) => r.id === f.tool);
          if (!tool) throw new Error('Choose the replacement surface body');
          const hits = f.faces.map((r) => findFaceAny(solids, r));
          if (hits.some((h) => !h)) throw new Error('A selected face could not be found on a solid body');
          const rec = hits[0].body;
          if (hits.some((h) => h.body !== rec)) throw new Error('The faces must be on the same body');
          if (f.faces.some((r) => !r.n)) throw new Error('Replace Face works on flat faces');
          const L = bboxOfAll([rec.shape, tool.shape]).diag * 2 + 10;
          let grown = rec.shape;
          for (const [i, h] of hits.entries()) grown = grown.fuse(R.basicFaceExtrusion(h.face, new R.Vector(mul(unit(f.faces[i].n), L))));
          const pieces = splitBy(unify(grown), tool.shape);
          if (pieces.length < 2) throw new Error('The surface does not cut across the face (it must reach past the face all round)');
          // the piece holding the inside of the body, well away from the faces
          const inside = (sh, q) => new R.DistanceQuery(R.makeVertex(q)).distanceTo(sh) < 1e-9 && R.measureVolume(sh.intersect(R.makeBox(sub(q, [1e-3, 1e-3, 1e-3]), add(q, [1e-3, 1e-3, 1e-3])))) > 1e-10;
          const n0 = unit(f.faces[0].n), bb = bbox(rec.shape);
          const depth = Math.max(...[0, 1, 2, 3, 4, 5, 6, 7].map((m) => dot(sub([m & 1 ? bb.max[0] : bb.min[0], m & 2 ? bb.max[1] : bb.min[1], m & 4 ? bb.max[2] : bb.min[2]], f.faces[0].p), mul(n0, -1))));
          let probe = null;
          for (const k of [0.75, 0.5, 0.9, 0.25]) { const q = add(f.faces[0].p, mul(n0, -depth * k)); if (inside(rec.shape, q)) { probe = q; break; } }
          if (!probe) throw new Error('Could not tell which side of the surface the body is on');
          const kept = pieces.filter((pc) => inside(pc, probe));
          if (!kept.length) throw new Error('The replacement surface cuts through the inside of the body');
          replaceSolid(rec, unify(asShape(kept)), f.id);
          applied.push({ op: 'add', tool: tool.shape });
          if (f.hideTool !== false) res.notes[f.id] = `${hits.length} face${hits.length === 1 ? '' : 's'} replaced by ${tool.id}`;
          break;
        }
        case 'ruledSurface': {
          // surfaces standing on edges: square to the face along the edge, or along a direction (optionally tilted)
          if (!(f.edges || []).length) throw new Error('Click the edges to rule from');
          const d = ev(f.distance);
          if (!(d > 0)) throw new Error('The distance must be greater than zero');
          const all = [...solids, ...surfaces], whole = compoundOf(all);
          const parts = [];
          const fixed = f.ruleType === 'direction' ? unit(resolveAxis(f.direction || 'y').d) : null;
          const tilt = ((f.angle ? ev(f.angle) : 0) * Math.PI) / 180;
          for (const ref of f.edges) {
            const hit = findEdgeInfo(whole, ref);
            if (!hit) throw new Error('A selected edge could not be found');
            const e = hit.e, owner = all.find((r) => r.shape.edges.some((x) => x.isSame(e)));
            const face = owner?.shape.faces.find((fc) => fc.edges.some((x) => x.isSame(e)));
            const n = 12, sides = f.both ? [1, -1] : [f.flip ? -1 : 1];
            for (const sd of sides) {
              const Q = [];
              let straight = e.geomType === 'LINE';
              for (let i = 0; i <= n; i++) {
                const t = i / n, p0 = vec(e.pointAt(t));
                let dir;
                if (fixed) {
                  dir = fixed;
                  if (tilt && face) {
                    // tilted away from the face, about the edge
                    const tg = unit(vec(e.tangentAt(t))), side = unit(cross(tg, dir));
                    const o = dot(side, unit(vec(face.normalAt(p0)))) >= 0 ? side : mul(side, -1);
                    dir = unit(add(mul(dir, Math.cos(tilt)), mul(o, Math.sin(tilt))));
                  }
                } else {
                  if (!face) throw new Error('A normal ruled surface needs edges of faces');
                  dir = unit(vec(face.normalAt(p0)));
                  if (face.geomType !== 'PLANE') straight = false;
                }
                Q.push(add(p0, mul(dir, sd * d)));
              }
              const far = straight ? R.makeLine(Q[0], Q[n]) : R.makeBSplineApproximation(Q.map((q) => new R.Vector(q)));
              parts.push(R.loft([R.assembleWire([e.clone()]), R.assembleWire([far])], { ruled: true }, true));
            }
          }
          const shape = parts.length > 1 ? sewShapes(parts, 1e-5) : parts[0];
          surfaces.push(bodyRec(newId(f.id), shape, f.id));
          applied.push({ op: 'add', tool: shape });
          break;
        }
        case 'untrim': {
          // faces of a surface body given back their holes (inner loops), or their whole natural extent
          const rec = surfaces.find((r) => r.id === f.body) || ((f.faces || []).length ? findFaceAny(surfaces, f.faces[0])?.body : null);
          if (!rec) throw new Error('Choose the surface body to untrim (or click its faces)');
          const picked = (f.faces || []).map((r) => findFaceAny([rec], r)?.face).filter(Boolean);
          const targets = picked.length ? picked : rec.shape.faces;
          const oc = R.getOC();
          let n = 0;
          const out = rec.shape.faces.map((fc) => {
            if (!targets.some((t) => t.isSame(fc))) return fc;
            if (f.mode === 'all') {
              const b = fc.UVBounds, srf = oc.BRep_Tool.Surface(fc.wrapped);
              const mk = new oc.BRepBuilderAPI_MakeFace(srf, b.uMin, b.uMax, b.vMin, b.vMax, 1e-6);
              try { const nf = R.cast(mk.Face()); n++; return nf; } finally { mk.delete(); }
            }
            const inner = fc.clone().innerWires();
            if (!inner.length) return fc;
            n++;
            return R.makeNewFaceWithinFace(fc, fc.clone().outerWire());
          });
          if (!n) throw new Error(f.mode === 'all' ? 'Nothing to untrim' : 'The faces have no holes to fill (choose Natural extent to untrim the outline)');
          surfaces = surfaces.map((r) => (r === rec ? bodyRec(rec.id, out.length > 1 ? sewShapes(out, 1e-5) : out[0], f.id) : r));
          res.notes[f.id] = `${n} face${n === 1 ? '' : 's'} untrimmed`;
          break;
        }
        case 'projCurve':
        case 'splitLine': {
          // a sketch projected along its normal onto faces: as a 3D curve, or splitting the faces along it
          // (Split Line can also split with a plane or a surface body)
          const all = [...solids, ...surfaces];
          const hits = (f.faces || []).map((r) => findFaceAny(all, r));
          if (hits.some((h) => !h)) throw new Error('A selected face could not be found in the model');
          if (f.type === 'splitLine' && !hits.length) throw new Error('Click the faces to split');
          const L = (all.length ? bboxOfAll(all.map((r) => r.shape)).diag : 100) * 2 + 10;
          let tool;
          const sk = sketches.get(f.type === 'projCurve' ? f.sketch : f.tool);
          if (sk) {
            const ws = sketchWires(sk.sk, sk.frame);
            if (!ws.length) throw new Error('The sketch has no curves to project');
            const oc = R.getOC();
            tool = asShape(ws.map((w) => { const v = new R.Vector(mul(sk.frame.n, 2 * L)), mk = new oc.BRepPrimAPI_MakePrism(w.clone().translate(mul(sk.frame.n, -L)).wrapped, v.wrapped, false, true); const sh = R.cast(mk.Shape()); mk.delete(); v.delete(); return sh; }));
          } else if (f.type === 'splitLine' && f.tool && (STD[f.tool] || planes.has(f.tool))) { const fr = resolveFrame(f.tool); tool = planeFace(fr.o, fr.n); }
          else if (f.type === 'splitLine' && f.tool) { const tr = surfaces.find((r) => r.id === f.tool); if (!tr) throw new Error('The split tool no longer exists'); tool = tr.shape; }
          else throw new Error(f.type === 'projCurve' ? 'Select the sketch to project' : 'Choose what to split with: a sketch, a plane or a surface body');
          const targets = hits.length ? hits.map((h) => h.face) : all.flatMap((r) => r.shape.faces);
          const oc = R.getOC(), edges = [];
          for (const face of targets) {
            const op = new oc.BRepAlgoAPI_Section(face.wrapped, tool.wrapped, false);
            try { op.Build(new oc.Message_ProgressRange()); if (!op.HasErrors()) edges.push(...R.cast(op.Shape()).edges); } catch (e) { if (isFatal(e)) throw e; } finally { op.delete(); }
          }
          if (!edges.length) throw new Error(f.type === 'projCurve' ? 'The sketch does not project onto the faces' : 'The tool does not cross the faces');
          if (f.type === 'projCurve') {
            const chains = chainEdges(edges);
            const wire = chains.length === 1 ? chains[0].wire : null;
            if (wire) curves.set(f.id, { wire, route: true });
            res.curves[f.id] = chains.map((c) => c.pts);
            res.notes[f.id] = `${edges.length} edge${edges.length === 1 ? '' : 's'}${chains.length > 1 ? ` in ${chains.length} separate curves (one connected curve can be a sweep path)` : ''}`;
          } else {
            // split the faces along the edges (the body stays one body, with more faces)
            const byRec = new Map();
            for (const h of hits) { if (!byRec.has(h.body)) byRec.set(h.body, []); }
            for (const rec of byRec.keys()) {
              const sp = new oc.BRepAlgoAPI_Splitter(), A = ocList([rec.shape]), T = ocList(edges);
              sp.SetArguments(A); sp.SetTools(T); sp.Build(new oc.Message_ProgressRange());
              const bad = sp.HasErrors(), out = bad ? null : R.cast(sp.Shape());
              sp.delete(); A.delete(); T.delete();
              if (!out) throw new Error('The faces could not be split');
              if (solids.includes(rec)) {
                const sol = solidsOf(out);
                if (sol.length !== 1) throw new Error('Splitting the faces broke the body');
                solids = solids.map((r) => (r === rec ? bodyRec(rec.id, sol[0], f.id) : r));
              } else surfaces = surfaces.map((r) => (r === rec ? bodyRec(rec.id, out, f.id) : r));
            }
            body = compoundOf(solids);
            res.notes[f.id] = `${hits.length} face${hits.length === 1 ? '' : 's'} split`;
          }
          break;
        }
        case 'compCurve': {
          // edges of the model joined into one curve (e.g. a sweep path along a part's edges)
          if (!(f.edges || []).length) throw new Error('Click the edges to join, end to end');
          const whole = compoundOf([...solids, ...surfaces]);
          const edges = f.edges.map((r) => findEdgeInfo(whole, r)?.e);
          if (edges.some((e) => !e)) throw new Error('A selected edge could not be found');
          const chains = chainEdges(edges);
          if (chains.length !== 1) throw new Error(`The edges do not join end to end (they make ${chains.length} separate pieces)`);
          curves.set(f.id, { wire: chains[0].wire, route: true });
          res.curves[f.id] = [chains[0].pts];
          res.notes[f.id] = `${edges.length} edges, ${+R.measureLength(chains[0].wire).toFixed(3)} long`;
          break;
        }
        case 'boundarySurf': {
          // a surface through curves in two directions: the first and last of each direction bound it, the
          // ones between shape it
          const wireOf = (id) => {
            if (curves.has(id)) return curves.get(id).wire;
            const sk = sketches.get(id);
            if (!sk) throw new Error('A curve is missing, suppressed or has errors');
            const ws = sketchWires(sk.sk, sk.frame);
            if (ws.length !== 1) throw new Error(`${sk.sk.name} must be one connected chain of curves`);
            return ws[0];
          };
          const d1 = (f.dir1 || []).filter(Boolean).map(wireOf), d2 = (f.dir2 || []).filter(Boolean).map(wireOf);
          if (d1.length < 2) throw new Error('Select at least two curves in direction 1');
          if (d2.length < 2) throw new Error('Select at least two curves in direction 2 (with curves in one direction only, use Lofted Surface)');
          const bound = [d1[0], d1[d1.length - 1], d2[0], d2[d2.length - 1]];
          // the four bounding curves must meet at their ends
          const ends = bound.flatMap((w) => [vec(w.startPoint), vec(w.endPoint)]);
          const tol = Math.max(1e-3, bboxOfAll(bound).diag * 1e-5);
          for (const q of ends) if (ends.filter((x) => len(sub(x, q)) < tol).length < 2) throw new Error('The first and last curves of the two directions must meet at their ends (they bound the surface)');
          const oc = R.getOC(), mk = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9);
          let shape;
          try {
            for (const w of bound) for (const e of w.edges) mk.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
            for (const w of [...d1.slice(1, -1), ...d2.slice(1, -1)]) for (const e of w.edges) mk.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, false);
            mk.Build();
            shape = R.cast(mk.Shape());
          } catch (e) { if (isFatal(e)) throw e; throw new Error('The boundary surface could not be made through these curves'); } finally { mk.delete(); }
          surfaces.push(bodyRec(newId(f.id), shape, f.id));
          applied.push({ op: 'add', tool: shape });
          break;
        }
        case 'flattenSurf': {
          // faces unrolled flat: exact for surfaces that unroll (cylinders, cones, bent sheets); a doubly curved
          // surface is spread out keeping its edge lengths as well as it can (the stretch is reported)
          if (!(f.faces || []).length) throw new Error('Click the faces to flatten');
          const all = [...solids, ...surfaces];
          const hits = f.faces.map((r) => findFaceAny(all, r));
          if (hits.some((h) => !h)) throw new Error('A selected face could not be found in the model');
          const faces = [];
          for (const h of hits) if (!faces.some((x) => x.isSame(h.face))) faces.push(h.face);
          const fl = flattenFaces(faces, Math.max(1, Math.min(5000, Math.round(ev(f.iterations ?? 1000)))));
          // laid flat beside the model, on a plane parallel to Top
          const bb = bboxOfAll(all.map((r) => r.shape)), o = [bb.max[0] + 20, bb.min[1], bb.min[2]];
          const to3 = (q) => [o[0] + q[0] - fl.min[0], o[1], o[2] - (q[1] - fl.min[1])];
          let face = R.makePolygon(fl.outer.map(to3));
          if (fl.holes.length) face = R.addHolesInFace(face, fl.holes.map((h) => R.makePolygon(h.map(to3)).outerWire()));
          surfaces.push(bodyRec(newId(f.id), face, f.id));
          applied.push({ op: 'add', tool: face });
          res.notes[f.id] = `Flat ${+(fl.max[0] - fl.min[0]).toFixed(2)} × ${+(fl.max[1] - fl.min[1]).toFixed(2)} mm, area ${+fl.area2.toFixed(2)} (surface ${+fl.area3.toFixed(2)}, ${fl.area2 >= fl.area3 ? '+' : ''}${(((fl.area2 - fl.area3) / fl.area3) * 100).toFixed(2)}%), edge lengths changed ${(fl.rmsStrain * 100).toFixed(2)}% on average (at most ${(fl.maxStrain * 100).toFixed(1)}%)`;
          break;
        }
        case 'weldBead': {
          // weld beads (round, the weld size across) along the lines where bodies meet; each joint its own body
          const sz = ev(f.size);
          if (!(sz > 0)) throw new Error('The weld size must be greater than zero');
          const pool = (f.bodies || []).length ? f.bodies.map((id) => solids.find((r) => r.id === id)).filter(Boolean) : solids.filter((r) => r.member && r.member.type !== 'weld');
          if (pool.length < 2) throw new Error('Select two or more bodies that touch (none: every weldment member)');
          const oc = R.getOC();
          let n0 = 0, total = 0;
          for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
            const A = pool[i], B = pool[j];
            if (!boxesTouch(boxOf(A), boxOf(B), 1e-4)) continue;
            let sec = null;
            const op = new oc.BRepAlgoAPI_Section(A.shape.wrapped, B.shape.wrapped, false);
            try { op.Build(new oc.Message_ProgressRange()); if (!op.HasErrors()) sec = R.cast(op.Shape()); } catch (e) { if (isFatal(e)) throw e; } finally { op.delete(); }
            const edges = sec ? sec.edges.filter((e) => R.measureLength(e) > 1e-6) : [];
            if (!edges.length) continue;
            const beads = [];
            for (const ch of chainEdges(edges)) {
              const w = ch.wire, st = vec(w.startPoint), t0 = unit(vec(w.tangentAt(0)));
              const prof = R.assembleWire([R.makeCircle(sz / 2, st, t0)]);
              for (const tm of ['round', 'right', 'transformed']) { try { beads.push(R.genericSweep(prof, w, { frenet: false, transitionMode: tm })); break; } catch (e) { if (isFatal(e)) throw e; } }
              total += R.measureLength(w);
            }
            if (!beads.length) continue;
            let shape = beads[0];
            for (const b of beads.slice(1)) { try { shape = shape.fuse(b); } catch (e) { if (isFatal(e)) throw e; shape = asShape([shape, b]); } }
            const rec = bodyRec(newId(f.id), shape, f.id);
            const L = beads.length ? edges.reduce((acc, e) => acc + R.measureLength(e), 0) : 0;
            rec.member = { label: `Weld ${+sz.toFixed(1)}`, type: 'weld', length: +L.toFixed(1), angles: [null, null], feature: f.id, between: [A.member?.label || A.id, B.member?.label || B.id] };
            solids.push(rec);
            applied.push({ op: 'add', tool: shape });
            n0++;
          }
          if (!n0) throw new Error('None of the bodies touch each other');
          body = compoundOf(solids);
          res.notes[f.id] = `${n0} weld${n0 === 1 ? '' : 's'}, ${+total.toFixed(1)} mm of weld in all`;
          break;
        }
        case 'weldTrim': {
          // members trimmed (or extended) to a boundary: a plane, a flat face or another body
          const recs = (f.bodies || []).map((id) => solids.find((r) => r.id === id)).filter(Boolean);
          if (!recs.length) throw new Error('Select the members to trim / extend');
          let plane = null, boundary = null;
          if (f.tool && (STD[f.tool] || planes.has(f.tool))) { const fr = resolveFrame(f.tool); plane = { p: fr.o, n: fr.n }; }
          else if (f.face?.n) plane = { p: f.face.p, n: unit(f.face.n) };
          else if (f.tool) { boundary = solids.find((r) => r.id === f.tool) || surfaces.find((r) => r.id === f.tool); if (!boundary) throw new Error('The boundary body no longer exists'); }
          else throw new Error('Choose the boundary: a plane, a flat face (click it) or a body');
          const diag = bboxOfAll([...recs.map((r) => r.shape), ...(boundary ? [boundary.shape] : [])]).diag;
          const big = (p0, n) => {
            const nn = unit(n), u = unit(cross(nn, Math.abs(nn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), w = cross(nn, u), S2 = diag * 4 + 100;
            const sq = [add(add(p0, mul(u, -S2)), mul(w, -S2)), add(add(p0, mul(u, S2)), mul(w, -S2)), add(add(p0, mul(u, S2)), mul(w, S2)), add(add(p0, mul(u, -S2)), mul(w, S2))];
            return R.basicFaceExtrusion(R.makePolygon(sq), new R.Vector(mul(nn, S2)));
          };
          let n0 = 0;
          for (const rec of recs) {
            const ax = rec.member?.axis;
            if (!ax) throw new Error(`${rec.member?.label || rec.id} is not a straight structural member`);
            const d = unit(sub(ax.b, ax.a)), mid = mul(add(ax.a, ax.b), 0.5);
            // the end toward the boundary
            const target = plane ? plane.p : bbox(boundary.shape).center;
            const toward = dot(sub(target, mid), d) >= 0 ? d : mul(d, -1);
            let sh = rec.shape;
            // extend: the end face carried on well past the boundary
            if (f.extend !== false) {
              const ts = [];
              for (const e of sh.edges) for (const t of [0, 0.5, 1]) ts.push(dot(sub(vec(e.pointAt(t)), mid), toward));
              const endAt = Math.max(...ts);
              const endFace = sh.faces.find((fc) => fc.geomType === 'PLANE' && dot(unit(vec(fc.normalAt())), toward) > 0.9999 && Math.abs(dot(sub(vec(fc.center), mid), toward) - endAt) < 1e-4);
              if (endFace) sh = unify(sh.fuse(R.basicFaceExtrusion(endFace, new R.Vector(mul(toward, diag * 2 + 10)))));
            }
            if (plane) {
              // square cut at the plane (or along it), keeping the member's side
              const side = Math.sign(dot(sub(mid, plane.p), plane.n)) || 1;
              sh = sh.cut(big(plane.p, mul(plane.n, -side)));
            } else if (f.trimType === 'cope' || ['chs', 'round'].includes(rec.member.type)) {
              const pieces = solidsOf(sh.cut(boundary.shape));
              const q = new R.DistanceQuery(R.makeVertex(mid));
              sh = pieces.sort((x, y) => q.distanceTo(x) - q.distanceTo(y))[0] || sh;
            } else {
              // square on the boundary body's near face
              const pts = [];
              for (const e of boundary.shape.edges) for (const t of [0, 0.25, 0.5, 0.75, 1]) pts.push(vec(e.pointAt(t)));
              const reach = Math.min(...pts.map((q) => dot(sub(q, mid), toward)).filter((x) => x > 0));
              if (!Number.isFinite(reach)) throw new Error(`The boundary is not ahead of ${rec.member.label}`);
              sh = sh.cut(big(add(mid, mul(toward, reach)), toward));
            }
            const one = solidsOf(sh);
            if (!one.length) throw new Error('Trimming removed a whole member');
            const q = new R.DistanceQuery(R.makeVertex(mid));
            const keep = unify(one.sort((x, y) => q.distanceTo(x) - q.distanceTo(y))[0]);
            const ts = [];
            for (const e of keep.edges) for (const t of [0, 0.5, 1]) ts.push(dot(sub(vec(e.pointAt(t)), ax.a), d));
            const recs2 = replaceSolid(rec, keep, f.id);
            for (const r2 of recs2) r2.member = { ...rec.member, length: +(Math.max(...ts) - Math.min(...ts)).toFixed(3) };
            n0++;
          }
          res.notes[f.id] = `${n0} member${n0 === 1 ? '' : 's'} trimmed / extended`;
          break;
        }
        case 'endCap': {
          // a plate on the open end of a hollow member: outside (on the end) or inside (in the end, flush)
          if (!(f.faces || []).length) throw new Error('Click the end faces of hollow members');
          const t = ev(f.thickness);
          if (!(t > 0)) throw new Error('The thickness must be greater than zero');
          let n0 = 0;
          for (const r of f.faces) {
            const hit = findFaceAny(solids, r);
            if (!hit || !r.n) throw new Error('A cap goes on a flat end face');
            const n = unit(r.n), inner = hit.face.clone().innerWires();
            let plate;
            if (f.capType === 'inside') {
              if (!inner.length) throw new Error('An inside cap needs a hollow member (its end face a ring)');
              plate = R.basicFaceExtrusion(R.makeFace(inner[0]), new R.Vector(mul(n, -t)));
            } else {
              plate = R.basicFaceExtrusion(R.makeFace(hit.face.clone().outerWire()), new R.Vector(mul(n, t)));
            }
            const rec = bodyRec(newId(f.id), plate, f.id);
            const bb = bbox(plate);
            const dims = [0, 1, 2].map((k) => bb.max[k] - bb.min[k]).sort((x, y) => y - x);
            rec.member = { label: `End cap ${+dims[0].toFixed(1)}x${+dims[1].toFixed(1)}x${+t.toFixed(1)}`, type: 'plate', length: null, angles: [null, null], feature: f.id };
            solids.push(rec);
            applied.push({ op: 'add', tool: plate });
            n0++;
          }
          body = compoundOf(solids);
          res.notes[f.id] = `${n0} end cap${n0 === 1 ? '' : 's'}`;
          break;
        }
        case 'weldGusset': {
          // a triangular plate in the corner between two flat faces (of two members)
          if ((f.faces || []).length !== 2) throw new Error('Click two flat faces that meet at a corner (one on each member)');
          const [A, B] = f.faces;
          if (!A.n || !B.n) throw new Error('A gusset needs two flat faces');
          const na = unit(A.n), nb = unit(B.n), L = cross(na, nb);
          if (len(L) < 1e-6) throw new Error('The two faces are parallel: they do not make a corner');
          const ld = unit(L);
          // a point on the line where the two planes meet, across from the picked points
          const pa = A.p, pb = B.p, da = dot(na, pa), db = dot(nb, pb), nn = dot(na, nb);
          const c1 = (da - db * nn) / (1 - nn * nn), c2 = (db - da * nn) / (1 - nn * nn);
          const base = add(mul(na, c1), mul(nb, c2));
          const q0 = add(base, mul(ld, dot(sub(mul(add(pa, pb), 0.5), base), ld)));
          const along = ev(f.offset || 0);
          const Q = add(q0, mul(ld, along));
          // each leg runs along its face, away from the corner toward the picked point
          let ua = unit(cross(ld, na)), ub = unit(cross(ld, nb));
          if (dot(sub(pa, Q), ua) < 0) ua = mul(ua, -1);
          if (dot(sub(pb, Q), ub) < 0) ub = mul(ub, -1);
          const d1 = ev(f.d1), d2 = ev(f.d2 ?? f.d1), t = ev(f.thickness), ch = ev(f.chamfer || 0);
          if (!(d1 > 0 && d2 > 0 && t > 0)) throw new Error('The leg lengths and thickness must be greater than zero');
          const pts = ch > 0 ? [add(Q, mul(ua, ch)), add(Q, mul(ua, d1)), add(Q, mul(ub, d2)), add(Q, mul(ub, ch))] : [Q, add(Q, mul(ua, d1)), add(Q, mul(ub, d2))];
          const start = (f.position === 'start' ? 0 : f.position === 'end' ? -t : -t / 2);
          const plate = R.basicFaceExtrusion(R.makePolygon(pts.map((q) => add(q, mul(ld, start)))), new R.Vector(mul(ld, t)));
          const rec = bodyRec(newId(f.id), plate, f.id);
          rec.member = { label: `Gusset ${+d1.toFixed(1)}x${+d2.toFixed(1)}x${+t.toFixed(1)}`, type: 'plate', length: null, angles: [null, null], feature: f.id };
          solids.push(rec);
          body = compoundOf(solids);
          applied.push({ op: 'add', tool: plate });
          break;
        }
        case 'structMember': {
          // Weldment structural members: a standard (or custom) profile along every segment of a sketch / 3D
          // sketch, each segment its own body; corners mitred or butted, ends on another member coped to it
          const prof = profileDims(f, ev), sec = profileSection(prof);
          const pp = piercePoint(sec.box, f.pierce || 'mc'), rot = ((f.rotate ? ev(f.rotate) : 0) * Math.PI) / 180;
          const segs = [...new Set([f.path, ...(f.paths || [])].filter(Boolean))].flatMap((id) => memberPath(id).map((g) => ({ ...g, src: id })));
          if (!segs.length) throw new Error('Select a sketch or 3D sketch with the lines (and arcs) for the members');
          const size = Math.hypot(sec.box.x1 - sec.box.x0, sec.box.y1 - sec.box.y0), ext = size * 1.5 + 1;
          const tol = Math.max(1e-4, size * 1e-5);
          const shiftSegs = (list) => list.map((g) => (g.type === 'circle' ? { ...g, c: [g.c[0] - pp[0], g.c[1] - pp[1]] } : { ...g, a: [g.a[0] - pp[0], g.a[1] - pp[1]], b: [g.b[0] - pp[0], g.b[1] - pp[1]], ...(g.m ? { m: [g.m[0] - pp[0], g.m[1] - pp[1]] } : {}) }));
          const outerSegs = shiftSegs(sec.outer), innerSegs = sec.inner ? shiftSegs(sec.inner) : null;
          // the profile's frame where a member leaves point A in direction d (its height kept upright)
          const frameAt = (A, d) => {
            let v = rej([0, 1, 0], d);
            if (len(v) < 1e-6) v = rej(f.vertRef === 'x' ? [1, 0, 0] : [0, 0, -1], d);
            v = unit(v);
            let u = cross(v, d);
            if (rot) { const c = Math.cos(rot), sn = Math.sin(rot), u2 = add(mul(u, c), mul(v, sn)), v2 = add(mul(v, c), mul(u, -sn)); u = u2; v = v2; }
            if (f.mirror) u = mul(u, -1);
            return { o: A, u, v, n: d };
          };
          const faceAt = (fr, withHole) => {
            let face = R.makeFace(loopWire(fr, outerSegs));
            if (withHole && innerSegs) face = R.addHolesInFace(face, [loopWire(fr, innerSegs)]);
            return face;
          };
          // the members' ends and how they meet
          const ms = segs.map((g, i) => ({ i, g, line: g.type === 'line', ends: [g.a, g.b], out: g.type === 'line' ? [unit(sub(g.a, g.b)), unit(sub(g.b, g.a))] : [mul(g.t0, -1), g.t1], trim: [null, null], cut: [0, 0] }));
          const near = (x, y) => len(sub(x, y)) < tol;
          const groups = [];
          for (const m of ms) for (const k of [0, 1]) {
            const q = m.ends[k];
            let gr = groups.find((x) => near(x.p, q));
            if (!gr) groups.push((gr = { p: q, ends: [] }));
            gr.ends.push({ m, k });
          }
          const corner = f.corner || 'mitre';
          // a corner between two ends: mitred or butted
          const cornerPair = (E1, E2, gr) => {
            const straight = dot(E1.m.out[E1.k], E2.m.out[E2.k]) < -0.9999;
            if (straight || !E1.m.line || !E2.m.line) return;
            if (corner === 'mitre') {
              const n = unit(sub(mul(E1.m.out[E1.k], -1), mul(E2.m.out[E2.k], -1)));
              E1.m.trim[E1.k] = { kind: 'plane', p: gr.p, n }; E2.m.trim[E2.k] = { kind: 'plane', p: gr.p, n: mul(n, -1) };
            } else {
              const [T, C] = corner === 'butt1' ? [E1, E2] : [E2, E1];
              T.m.trim[T.k] = { kind: 'cope', hosts: [C.m], p: gr.p };
              C.m.trim[C.k] = { kind: 'cover', other: T.m, p: gr.p };
            }
          };
          for (const gr of groups) {
            if (gr.ends.length >= 3 && corner !== 'none') {
              // e.g. a table's corner: the two rails of one sketch make the corner, the leg is trimmed to both
              const bySrc = new Map();
              for (const E of gr.ends) { if (!bySrc.has(E.m.g.src)) bySrc.set(E.m.g.src, []); bySrc.get(E.m.g.src).push(E); }
              const pair = [...bySrc.values()].find((l) => l.length === 2);
              if (pair) {
                cornerPair(pair[0], pair[1], gr);
                for (const E of gr.ends) if (!pair.includes(E) && E.m.line) E.m.trim[E.k] = { kind: 'cope', hosts: pair.map((x) => x.m), p: gr.p };
              }
              continue;
            }
            if (gr.ends.length === 2 && corner !== 'none') {
              cornerPair(gr.ends[0], gr.ends[1], gr);
              continue;
            }
            if (gr.ends.length === 1) {
              // an end on the middle of another member: coped to it
              const E = gr.ends[0];
              const host = ms.find((o) => o !== E.m && o.line && (() => { const ab = sub(o.g.b, o.g.a), L2 = dot(ab, ab), t = dot(sub(gr.p, o.g.a), ab) / L2; return t > 1e-6 && t < 1 - 1e-6 && len(sub(gr.p, add(o.g.a, mul(ab, t)))) < tol; })());
              if (host && E.m.line) E.m.trim[E.k] = { kind: 'cope', hosts: [host], p: gr.p };
            }
          }
          // solids: extended at the ends to be trimmed (and the envelope of each, the profile filled, for coping)
          const halfSpace = (p0, n) => {
            const nn = unit(n), u = unit(cross(nn, Math.abs(nn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), w = cross(nn, u), S2 = size * 4 + len(sub(segs[0].a, segs[0].b)) * 2 + 100;
            const sq = [add(add(p0, mul(u, -S2)), mul(w, -S2)), add(add(p0, mul(u, S2)), mul(w, -S2)), add(add(p0, mul(u, S2)), mul(w, S2)), add(add(p0, mul(u, -S2)), mul(w, S2))];
            return R.basicFaceExtrusion(R.makePolygon(sq), new R.Vector(mul(nn, S2)));
          };
          for (const m of ms) {
            if (m.line) {
              const d = unit(sub(m.g.b, m.g.a)), L = len(sub(m.g.b, m.g.a));
              const e0 = m.trim[0] ? ext : 0, e1 = m.trim[1] ? ext : 0;
              const fr = frameAt(sub(m.g.a, mul(d, e0)), d);
              m.d = d; m.L = L; m.fr = frameAt(m.g.a, d);
              m.solid = R.basicFaceExtrusion(faceAt(fr, true), new R.Vector(mul(d, L + e0 + e1)));
              m.env = R.basicFaceExtrusion(faceAt(fr, false), new R.Vector(mul(d, L + e0 + e1)));
              m.env0 = R.basicFaceExtrusion(faceAt(m.fr, false), new R.Vector(mul(d, L))); // (to the sketch ends)
            } else {
              // an arc: swept (no end trimming)
              const fr = frameAt(m.g.a, m.g.t0), spine = m.g.wire;
              const sw = (w) => { for (const tm of ['right', 'round', 'transformed']) { try { return R.genericSweep(w, spine, { frenet: false, transitionMode: tm }); } catch (e) { if (isFatal(e)) throw e; } } throw new Error('A curved member could not be swept'); };
              m.env = sw(loopWire(fr, outerSegs));
              m.solid = innerSegs ? m.env.cut(sw(loopWire(fr, innerSegs))) : m.env;
              m.env0 = m.env; m.L = m.g.length;
            }
          }
          for (const m of ms) for (const k of [0, 1]) {
            const tr = m.trim[k];
            if (!tr) continue;
            if (tr.kind === 'plane') {
              m.solid = m.solid.cut(halfSpace(tr.p, mul(tr.n, -1)));
              m.cut[k] = +((Math.acos(Math.min(1, Math.abs(dot(tr.n, m.d)))) * 180) / Math.PI).toFixed(2); // (0: square)
            } else if (tr.kind === 'cover') {
              // runs on over the trimmed member: to the far side of its section
              const o = m.out[k], ends = [];
              for (const e of tr.other.env0.edges) for (const t of [0, 0.5, 1]) ends.push(vec(e.pointAt(t)));
              const reach = Math.max(0, ...ends.map((q) => dot(sub(q, tr.p), o)));
              m.solid = m.solid.cut(halfSpace(add(tr.p, mul(o, reach)), o));
            } else if (tr.kind === 'cope' && f.trim !== 'cope' && prof.type !== 'chs' && prof.type !== 'round') {
              // a square cut on the face of the member it meets (as cut in the shop)
              const o = m.out[k], toward = mul(o, -1), pts = [];
              for (const h of tr.hosts) for (const e of h.env0.edges) for (const t of [0, 0.25, 0.5, 0.75, 1]) pts.push(vec(e.pointAt(t)));
              const reach = Math.max(...pts.map((q) => dot(sub(q, tr.p), toward)));
              m.solid = m.solid.cut(halfSpace(sub(tr.p, mul(o, reach)), o));
              m.cut[k] = 0;
            } else if (tr.kind === 'cope') {
              // coped: cut to the outside of the member it meets (e.g. a fish-mouth on a pipe)
              const mid = add(m.g.a, mul(sub(m.g.b, m.g.a), 0.5));
              let cutBy = tr.hosts[0].env;
              for (const h of tr.hosts.slice(1)) cutBy = cutBy.fuse(h.env);
              const pieces = solidsOf(m.solid.cut(cutBy));
              const keep = pieces.sort((x, y) => new R.DistanceQuery(R.makeVertex(mid)).distanceTo(x) - new R.DistanceQuery(R.makeVertex(mid)).distanceTo(y))[0];
              if (keep) m.solid = keep;
              m.cut[k] = null; // (a coped end)
            }
          }
          // one body per member
          for (const m of ms) {
            const sh = unify(m.solid);
            let length = m.L;
            if (m.line) {
              const ts = [];
              for (const e of sh.edges) for (const t of [0, 0.5, 1]) ts.push(dot(sub(vec(e.pointAt(t)), m.g.a), m.d));
              length = Math.max(...ts) - Math.min(...ts);
            }
            const rec = bodyRec(newId(f.id), sh, f.id);
            rec.member = { label: prof.label, type: prof.type, length: +length.toFixed(3), angles: m.cut.map((x) => (x === null ? null : +x)), feature: f.id, ...(m.line ? { axis: { a: m.g.a, b: m.g.b } } : {}), size };
            solids.push(rec);
            applied.push({ op: 'add', tool: sh });
          }
          body = compoundOf(solids);
          res.notes[f.id] = `${ms.length} member${ms.length === 1 ? '' : 's'}: ${prof.label}`;
          break;
        }
        case 'pipeRoute': {
          // Pipe / tube route along the straight lines of a sketch or 3D sketch: straight pipes between the fittings, the
          // corners long radius elbows (fittings, each a body of its own) or bends (bent tube); a tee where a line branches
          // square off a straight run; a concentric reducer at an open end if asked; flanges at the other open ends if
          // asked. The straight pipes are weldment members, so they are on the cut list with their lengths
          const segs = memberPath(f.path);
          if (!segs.length) throw new Error('Select the sketch or 3D sketch of the route (straight lines)');
          if (segs.some((g) => g.type !== 'line')) throw new Error('Draw the route with straight lines: its corners get the elbows or bends');
          const pipe = pipeOf(f, ev), ro = pipe.D / 2, ri = ro - pipe.t, tol = Math.max(1e-6, pipe.D * 1e-7), short = pipe.label.replace(/^Pipe |^Tube /, '');
          // (the route as a graph: its points, and for each line the points at its ends)
          const nodes = [], nodeOf = (q) => { let k = nodes.findIndex((x) => len(sub(x.p, q)) < tol); if (k < 0) { nodes.push({ p: q, lines: [] }); k = nodes.length - 1; } return k; };
          const lines = segs.map((g, li) => { const a = nodeOf(g.a), b = nodeOf(g.b); nodes[a].lines.push(li); nodes[b].lines.push(li); return { a, b, d: unit(sub(g.b, g.a)), L: len(sub(g.b, g.a)), cut: [0, 0] }; });
          const away = (li, k) => (lines[li].a === k ? lines[li].d : mul(lines[li].d, -1)); // (the line's direction leaving node k)
          const setCut = (li, k, c) => { lines[li].cut[lines[li].a === k ? 0 : 1] = c; };
          const corners = [], tees = [], ends = [];
          for (const [k, nd] of nodes.entries()) {
            const m = nd.lines.length;
            if (m === 1) ends.push({ k, out: mul(away(nd.lines[0], k), -1), li: nd.lines[0] });
            else if (m === 2) {
              const [l1, l2] = nd.lines, d1 = mul(away(l1, k), -1), d2 = away(l2, k), th = Math.acos(Math.max(-1, Math.min(1, dot(d1, d2))));
              if (th < 1e-9) continue;
              if (th > Math.PI - 1e-6) throw new Error('The route turns back on itself at a corner');
              const c = pipe.R * Math.tan(th / 2);
              setCut(l1, k, c); setCut(l2, k, c);
              corners.push({ k, d1, d2, th, c });
            } else if (m === 3) {
              const ds = nd.lines.map((li) => away(li, k));
              const run = [[0, 1], [0, 2], [1, 2]].find(([x, y]) => dot(ds[x], ds[y]) < -1 + 1e-9);
              const bi = run ? 3 - run[0] - run[1] : -1;
              if (!run || Math.abs(dot(ds[bi], ds[run[0]])) > 1e-6) throw new Error('A branch must leave a straight run square to it (a tee): other branches are not made');
              nd.lines.forEach((li) => setCut(li, k, pipe.tee));
              tees.push({ k, r: ds[run[0]], b: ds[bi] });
            } else throw new Error('Four or more lines meet at a point: crosses are not made (use two tees)');
          }
          if (!ends.length) throw new Error('The route must have open ends (not a closed loop)');
          // (a reducer at the first or last open end, in the order the lines were drawn)
          const rd = f.reduceAt && f.reduceAt !== 'none' ? pipeOf({ ...f, size: f.reduceSize, corner: 'elbow', radius: 'auto' }, ev) : null;
          if (rd && !(rd.D < pipe.D)) throw new Error('The reducer must go down to a smaller size');
          const endOrder = [...ends].sort((x, y) => x.li - y.li || (lines[x.li].a === x.k ? -1 : 1));
          const reduced = rd ? (f.reduceAt === 'start' ? [endOrder[0]] : f.reduceAt === 'end' ? [endOrder.at(-1)] : [endOrder[0], endOrder.at(-1)]).filter((x, q, a) => a.indexOf(x) === q) : [];
          for (const e of reduced) setCut(e.li, e.k, pipe.reducer);
          for (const [li, l] of lines.entries()) if (l.L < l.cut[0] + l.cut[1] - 1e-9) throw new Error(`Line ${li + 1} of the route is too short for the fittings at its ends (it needs ${+(l.cut[0] + l.cut[1]).toFixed(3)})`);
          const tube = (A, B, r1 = ro, r0 = ri) => { const L = len(sub(B, A)), d = unit(sub(B, A)); return R.makeCylinder(r1, L, A, d).cut(R.makeCylinder(r0, L + 2, sub(A, d), d)); };
          const disc = (r, p, d) => { const u = unit(cross(d, Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])); return R.drawCircle(r).sketchOnPlane(new R.Plane(p, u, d)).face(); };
          const elbow = ({ k, d1, d2, th, c }) => {
            const T1 = sub(nodes[k].p, mul(d1, c)), ax = unit(cross(d1, d2)), C = add(T1, mul(unit(cross(ax, d1)), pipe.R)), a = (th * 180) / Math.PI;
            return R.revolution(disc(ro, T1, d1), C, ax, a).cut(R.revolution(disc(ri, T1, d1), C, ax, a));
          };
          const tee = ({ k, r, b }) => {
            const O = nodes[k].p, C = pipe.tee;
            const outer = R.makeCylinder(ro, 2 * C, sub(O, mul(r, C)), r).fuse(R.makeCylinder(ro, C, O, b));
            return unify(outer.cut(R.makeCylinder(ri, 2 * C + 2, sub(O, mul(r, C + 1)), r).fuse(R.makeCylinder(ri, C + 1, O, b))));
          };
          // (a reducer: its big end on the pipe, its small end at the route's end)
          const reducer = ({ k, out }) => {
            const E = nodes[k].p, H = pipe.reducer, A = sub(E, mul(out, H)), u = unit(cross(out, Math.abs(out[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
            const P2 = (rho, z) => add(add(A, mul(u, rho)), mul(out, z)), r2o = rd.D / 2, r2i = r2o - rd.t;
            return R.revolution(R.makePolygon([P2(ri, 0), P2(ro, 0), P2(r2o, H), P2(r2i, H)]), A, out, 360);
          };
          const add1 = (shape, name, member) => { const rec = bodyRec(newId(f.id), shape, f.id); rec.name = name; if (member) rec.member = member; solids.push(rec); applied.push({ op: 'add', tool: shape }); };
          const straights = [];
          for (const l of lines) { const A = add(nodes[l.a].p, mul(l.d, l.cut[0])), B = sub(nodes[l.b].p, mul(l.d, l.cut[1])); if (len(sub(B, A)) > 1e-6) straights.push({ A, B, L: len(sub(B, A)) }); }
          const fits = corners.map(elbow);
          if (f.corner === 'bend') {
            let all = null;
            for (const sh of [...straights.map((x) => tube(x.A, x.B)), ...fits]) all = all ? all.fuse(sh) : sh;
            const L = straights.reduce((t, x) => t + x.L, 0) + corners.reduce((t, c) => t + pipe.R * c.th, 0);
            for (const piece of solidsOf(unify(all))) add1(piece, `${pipe.label} bent`, { label: `${pipe.label}, bent R${+pipe.R.toFixed(3)}`, type: 'chs', length: +L.toFixed(3), angles: [null, null], feature: f.id, size: pipe.D });
          } else {
            for (const x of straights) add1(tube(x.A, x.B), `${pipe.label} ${+x.L.toFixed(1)}`, { label: pipe.label, type: 'chs', length: +x.L.toFixed(3), angles: [0, 0], feature: f.id, size: pipe.D, axis: { a: x.A, b: x.B } });
            corners.forEach((c, q) => add1(fits[q], `Elbow ${+((c.th * 180) / Math.PI).toFixed(1)}° ${short}`));
          }
          for (const t of tees) add1(tee(t), `Tee ${short}`);
          for (const e of reduced) add1(reducer(e), `Reducer ${short} × ${rd.label.replace(/^Pipe |^Tube /, '')}`);
          // (flanges at the open ends without a reducer: rings on the pipe, flush with its end)
          if (f.flanges) {
            const FD = ev(f.flangeD), FT = ev(f.flangeT);
            if (!(FD > pipe.D) || !(FT > 0)) throw new Error('The flanges need an outside diameter bigger than the pipe’s and a thickness');
            for (const e of ends.filter((x) => !reduced.includes(x))) { const E = nodes[e.k].p, d = mul(e.out, -1); add1(R.makeCylinder(FD / 2, FT, E, d).cut(R.makeCylinder(ro, FT + 2, sub(E, d), d)), `Flange ${short}`); }
          }
          body = compoundOf(solids);
          const total = straights.reduce((t, x) => t + x.L, 0), nf = f.flanges ? ends.length - reduced.length : 0;
          const parts = [f.corner === 'bend' ? `bent tube, ${corners.length} bend${corners.length === 1 ? '' : 's'}` : `${straights.length} straight pipe${straights.length === 1 ? '' : 's'} (${+total.toFixed(1)} mm in all), ${corners.length} elbow${corners.length === 1 ? '' : 's'}`];
          if (tees.length) parts.push(`${tees.length} tee${tees.length === 1 ? '' : 's'}`);
          if (reduced.length) parts.push(`${reduced.length} reducer${reduced.length === 1 ? '' : 's'}`);
          if (nf) parts.push(`${nf} flange${nf === 1 ? '' : 's'}`);
          res.notes[f.id] = `${pipe.label}: ${parts.join(', ')}`;
          break;
        }
        case 'ductFitting': {
          // Duct fitting (thin sheet, outside sizes; ducts.js): a segmented elbow in the XY plane about the Z axis, a cone,
          // a round-to-rectangle transition or an offset along Z, or a lateral (the main along Z, the branch towards +X)
          const s = ductSpec(f, ev), ro = s.D / 2, ri = ro - s.t, big = 4 * (s.D + s.L + s.R + s.W + s.H + s.branchL);
          const block = (p, n) => { const u = unit(cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])); return R.drawRectangle(2 * big, 2 * big).sketchOnPlane(new R.Plane(p, u, n)).extrude(big); };
          const tube = (r1, r0, A, d, L) => R.makeCylinder(r1, L, A, d).cut(R.makeCylinder(r0, L + 2, sub(A, d), d));
          const loftTube = (wireAt) => { const o = R.loft([wireAt(0, 0), wireAt(1, 0)], { ruled: true }), i = R.loft([wireAt(0, s.t), wireAt(1, s.t)], { ruled: true }); return o.cut(i); };
          let shape;
          if (s.kind === 'elbow') {
            const A = (s.angle * Math.PI) / 180, a = A / (s.gores - 1), cuts = [0, ...Array.from({ length: s.gores - 1 }, (_, k) => a / 2 + k * a).slice(0, s.gores - 1), A].filter((x, k, l) => k === 0 || x > l[k - 1] + 1e-12);
            const dirAt = (th) => [-Math.sin(th), Math.cos(th), 0], at = (th, r) => [r * Math.cos(th), r * Math.sin(th), 0];
            for (let g = 0; g + 1 < cuts.length; g++) {
              const c0 = cuts[g], c1 = cuts[g + 1], end0 = g === 0, end1 = g + 2 === cuts.length, m = end0 ? 0 : end1 ? A : (c0 + c1) / 2;
              const d = dirAt(m), Lg = (s.R + ro) * Math.tan(a) * 2 + 2, A0 = sub(at(m, s.R), mul(d, Lg / 2));
              let gore = tube(ro, ri, A0, d, Lg);
              // (between the cut planes through the Z axis at c0 and c1: kept on their inner sides)
              gore = gore.intersect(block([0, 0, 0], dirAt(c0))).intersect(block([0, 0, 0], mul(dirAt(c1), -1)));
              shape = shape ? shape.fuse(gore) : gore;
            }
            shape = unify(shape);
          } else if (s.kind === 'cone') {
            const r2o = s.D2 / 2, r2i = r2o - s.t, P = (rho, z) => [rho, 0, z];
            shape = R.revolution(R.makePolygon([P(ri, 0), P(ro, 0), P(r2o, s.L), P(r2i, s.L)]), [0, 0, 0], [0, 0, 1], 360);
          } else if (s.kind === 'transition') {
            shape = loftTube((top, inset) => top ? R.assembleWire([R.makeCircle(ro - inset, [0, 0, s.L + (inset ? 1e-3 : 0)], [0, 0, 1])]) : R.makePolygon([[s.W / 2 - inset, -(s.H / 2 - inset), inset ? -1e-3 : 0], [s.W / 2 - inset, s.H / 2 - inset, inset ? -1e-3 : 0], [-(s.W / 2 - inset), s.H / 2 - inset, inset ? -1e-3 : 0], [-(s.W / 2 - inset), -(s.H / 2 - inset), inset ? -1e-3 : 0]]).outerWire());
          } else if (s.kind === 'offset') {
            shape = loftTube((top, inset) => R.assembleWire([R.makeCircle(ro - inset, [top ? s.offset : 0, 0, top ? s.L + (inset ? 1e-3 : 0) : inset ? -1e-3 : 0], [0, 0, 1])]));
          } else if (s.kind === 'lateral') {
            const L = ductLateral(s), b = (s.branchAngle * Math.PI) / 180, d = [Math.sin(b), 0, Math.cos(b)], O = [0, 0, s.L / 2], rbo = s.branchD / 2, rbi = rbo - s.t;
            const outer = R.makeCylinder(ro, s.L, [0, 0, 0], [0, 0, 1]).fuse(R.makeCylinder(rbo, L.len, O, d));
            const inner = R.makeCylinder(ri, s.L + 2, [0, 0, -1], [0, 0, 1]).fuse(R.makeCylinder(rbi, L.len + 1, O, d));
            shape = unify(outer.cut(inner));
          }
          if (!shape || !solidsOf(shape).length) throw new Error('The fitting could not be made');
          const rec = bodyRec(newId(f.id), shape, f.id);
          rec.name = { elbow: `Elbow ${s.angle}° Ø${s.D}`, cone: `Cone Ø${s.D} × Ø${s.D2}`, transition: `Transition ${s.W}×${s.H} to Ø${s.D}`, offset: `Offset Ø${s.D}`, lateral: `Lateral Ø${s.D} × Ø${s.branchD}` }[s.kind];
          solids.push(rec); applied.push({ op: 'add', tool: shape });
          body = compoundOf(solids);
          const pats = ductPatterns(s);
          res.notes[f.id] = `${rec.name}: ${pats.map((p) => `${p.qty} × ${p.name} ${+p.size[0].toFixed(1)} × ${+p.size[1].toFixed(1)}`).join(', ')} (flat, File ▸ Export ▸ Duct Patterns)`;
          break;
        }
        case 'cable': {
          // Cable / harness: a round bundle swept along a sketch or 3D sketch (a spline route follows its curves): its
          // diameter given, or from its wires (count, wire diameter); its length with slack added in the note
          let w = null;
          const c3 = curves.get(f.path), s2 = sketches.get(f.path);
          if (c3?.wire) w = c3.wire;
          else if (s2) w = sketchWires(s2.sk, s2.frame).find((x) => !x.isClosed?.()) || sketchWires(s2.sk, s2.frame)[0];
          if (!w) throw new Error('Select the sketch or 3D sketch of the cable’s route');
          const D = f.sizeBy === 'wires' ? bundleDiameter(Math.round(ev(f.wires)), ev(f.wireD)) : ev(f.diameter);
          if (!(D > 0)) throw new Error('The cable needs a diameter (or wires of a diameter)');
          const st = vec(w.startPoint), t0 = unit(vec(w.tangentAt(0))), prof = R.assembleWire([R.makeCircle(D / 2, st, t0)]);
          let sh = null;
          for (const tm of ['round', 'right', 'transformed']) { try { sh = R.genericSweep(prof, w, { frenet: false, transitionMode: tm }); break; } catch (e) { if (isFatal(e)) throw e; } }
          if (!sh || !solidsOf(sh).length) throw new Error('The cable could not follow the route (a corner tighter than its radius?)');
          const L = R.measureLength(w), slack = ev(f.slack ?? 0) / 100;
          const rec = bodyRec(newId(f.id), sh, f.id); rec.name = `Cable Ø${+D.toFixed(2)}`;
          solids.push(rec); applied.push({ op: 'add', tool: sh });
          body = compoundOf(solids);
          res.notes[f.id] = `Cable Ø${+D.toFixed(2)}${f.sizeBy === 'wires' ? ` (${Math.round(ev(f.wires))} wires Ø${ev(f.wireD)})` : ''}: route ${+L.toFixed(1)} mm, cut length ${+(L * (1 + slack)).toFixed(1)} mm${slack ? ` with ${+(slack * 100).toFixed(2)} % slack` : ''}`;
          break;
        }
        case 'surfOffset': {
          if (!f.faces?.length) throw new Error('Select faces on the model to offset');
          const dd = ev(f.distance) * (f.flip ? -1 : 1);
          const hits = f.faces.map((r) => findFaceAny([...solids, ...surfaces], r));
          if (hits.some((h) => !h)) throw new Error('A selected face could not be found in the model');
          const parts = hits.map((h) => (Math.abs(dd) < 1e-12 ? h.face.clone() : offsetFace(h.face, dd)));
          const shape = asShape(parts);
          surfaces.push(bodyRec(newId(f.id), shape, f.id));
          applied.push({ op: 'add', tool: shape });
          break;
        }
        case 'surfCopy': {
          // copies of picked faces (of solids or surfaces) as new surface bodies; the bodies are left as they are
          if (!f.faces?.length) throw new Error('Select faces on the model to copy');
          const hits = f.faces.map((r) => findFaceAny([...solids, ...surfaces], r));
          if (hits.some((h) => !h)) throw new Error('A selected face could not be found in the model');
          const oc = R.getOC();
          // (shapes are never changed in place, so the copies can share the faces' geometry; a face picked twice once)
          const picked = [];
          for (const h of hits) if (!picked.some((x) => x.isSame(h.face))) picked.push(h.face);
          const copies = picked.map((fc) => fc.clone());
          const out = [];
          if (f.knit !== false && copies.length > 1) {
            // faces that touch along an edge become one surface body (separate patches stay separate)
            const sw = new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false);
            for (const c of copies) sw.Add(c.wrapped);
            sw.Perform(new oc.Message_ProgressRange());
            const sewn = R.cast(sw.SewedShape());
            sw.delete();
            const shells = [...R.iterTopo(sewn.wrapped, 'shell')].map((s) => R.cast(s));
            const loose = [...R.iterTopo(sewn.wrapped, 'face')].map((x) => R.cast(x)).filter((fc) => !shells.some((s) => s.faces.some((g) => g.isSame(fc))));
            out.push(...shells, ...loose);
          } else out.push(...copies);
          for (const s of out) {
            surfaces.push(bodyRec(newId(f.id), s, f.id));
            applied.push({ op: 'add', tool: s });
          }
          res.notes[f.id] = `${picked.length} face${picked.length === 1 ? '' : 's'} copied · ${out.length} surface bod${out.length === 1 ? 'y' : 'ies'}`;
          break;
        }
        case 'knit': {
          if ((f.bodies || []).length < 1) throw new Error('Select the surface bodies to knit');
          const recs = f.bodies.map((id) => needBody(id, 'surface body'));
          if (recs.some((r) => !surfaces.includes(r))) throw new Error('Only surface bodies can be knit');
          const oc = R.getOC();
          const sw = new oc.BRepBuilderAPI_Sewing(Math.max(1e-6, ev(f.tolerance ?? 0.01)), true, true, true, false);
          for (const r of recs) sw.Add(r.shape.wrapped);
          sw.Perform(new oc.Message_ProgressRange());
          const sewn = R.cast(sw.SewedShape());
          const free = sw.NbFreeEdges();
          sw.delete();
          surfaces = surfaces.filter((r) => !recs.includes(r));
          if (f.solid && free === 0) {
            const shells = [...R.iterTopo(sewn.wrapped, 'shell')];
            if (shells.length !== 1) throw new Error('The knit surfaces do not form a single closed volume');
            const ms = new oc.BRepBuilderAPI_MakeSolid(shells[0]);
            const solid = R.cast(ms.Solid());
            ms.delete();
            oc.BRepLib.OrientClosedSolid(solid.wrapped);
            apply('add', unify(solid), f.merge !== false);
          } else {
            surfaces.push(bodyRec(recs[0].id, sewn, f.id));
            applied.push({ op: 'add', tool: sewn });
            if (f.solid) throw new Error(`The surfaces are not closed (${free} open edge${free === 1 ? '' : 's'}), so no solid was made`);
          }
          break;
        }
        case 'surfSolid': {
          // surfaces that enclose a volume (and meshes such as STL imports) made into one solid
          if (!(f.bodies || []).length) throw new Error('Select the surface bodies that enclose the volume');
          const recs = f.bodies.map((id) => needBody(id, 'surface body'));
          if (recs.some((r) => !surfaces.includes(r))) throw new Error('Only surface bodies can be converted (a solid already is one)');
          const tol = ev(f.tolerance ?? 0.01);
          if (!(tol > 0)) throw new Error('The gap tolerance must be greater than zero');
          if (recs.every((r) => r.mesh) || isMeshLike(recs.map((r) => r.shape))) {
            // a mesh (flat faces only, e.g. an STL): points within the tolerance welded, triangles turned
            // the same way round, and closed only when every edge joins two triangles
            progress(null, 'Joining the triangles…');
            const { P, T } = meshTris(recs.map((r) => r.shape), tol);
            const rp = repairTris(P, T, { fill: false });
            if (rp.openEdges) throw new Error(`The mesh does not close: ${rp.openEdges} open edge${rp.openEdges === 1 ? '' : 's'} round ${rp.holes + rp.chains} hole${rp.holes + rp.chains === 1 ? '' : 's'}. Raise the gap tolerance, or close the holes with Repair Mesh.`);
            if (rp.nonManifold) throw new Error(`The mesh has ${rp.nonManifold} edge${rp.nonManifold === 1 ? '' : 's'} shared by more than two triangles, so it is not one closed volume`);
            const built = meshShape(P, rp.T);
            if (!built.closed) throw new Error('The mesh closes, but not as one volume');
            surfaces = surfaces.filter((r) => !recs.includes(r));
            apply('add', built.shape, f.merge === true);
            res.notes[f.id] = `Solid of ${+R.measureVolume(built.shape).toFixed(3)} mm³ from ${rp.T.length} triangle${rp.T.length === 1 ? '' : 's'}` + (rp.flipped ? ` · ${rp.flipped} turned the right way round` : '');
            break;
          }
          progress(null, 'Sewing the surfaces…');
          const sewn = sewShapes(recs.map((r) => r.shape), tol);
          const { loops, open, freeEdges } = holeLoops(sewn);
          if (freeEdges) {
            const big = Math.max(0, ...loops.map((l) => l.size));
            throw new Error(`The surfaces do not close: ${freeEdges} open edge${freeEdges === 1 ? '' : 's'} round ${loops.length + open.length} gap${loops.length + open.length === 1 ? '' : 's'}${loops.length ? ` (the largest ${+big.toFixed(2)} mm across)` : ''}. Raise the gap tolerance, or close the holes with Repair Mesh.`);
          }
          const solid = solidFromSewn(sewn);
          if (!solid) throw new Error('The surfaces close, but not as one volume (several shells, or they cross themselves)');
          surfaces = surfaces.filter((r) => !recs.includes(r));
          apply('add', unify(solid), f.merge === true);
          res.notes[f.id] = `Solid of ${+R.measureVolume(solid).toFixed(3)} mm³ from ${solid.faces.length} face${solid.faces.length === 1 ? '' : 's'}`;
          break;
        }
        case 'meshRepair': {
          // close the holes of a surface body (e.g. an STL with small missing pieces), then make it a solid
          if (!(f.bodies || []).length) throw new Error('Select the surface body (mesh) to repair');
          const recs = f.bodies.map((id) => needBody(id, 'surface body'));
          if (recs.some((r) => !surfaces.includes(r))) throw new Error('Select surface bodies (a solid is already closed)');
          const tol = ev(f.tolerance ?? 0.01), maxHole = ev(f.maxHole ?? 0);
          if (!(tol > 0)) throw new Error('The gap tolerance must be greater than zero');
          if (!(maxHole >= 0)) throw new Error('The largest hole can\'t be negative');
          const pl = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
          if (recs.every((r) => r.mesh) || isMeshLike(recs.map((r) => r.shape))) {
            progress(null, 'Repairing the mesh…');
            const { P, T } = meshTris(recs.map((r) => r.shape), tol);
            const rp = repairTris(P, T, { maxHole });
            const built = meshShape(P, rp.T);
            surfaces = surfaces.filter((r) => !recs.includes(r));
            const solid = f.solid !== false && built.closed ? built.shape : null;
            if (solid) apply('add', solid, f.merge === true);
            else { const rec = bodyRec(recs[0].id, built.shape, f.id); rec.mesh = true; surfaces.push(rec); applied.push({ op: 'add', tool: built.shape }); }
            const parts = [rp.holes ? `${pl(rp.filled, 'hole')} closed` : 'No holes found'];
            if (rp.tooBig) parts.push(`${rp.tooBig} larger than ${+maxHole.toFixed(3)} mm left open`);
            if (rp.failed) parts.push(`${rp.failed} could not be closed`);
            if (rp.chains) parts.push(`${pl(rp.chains, 'open edge chain')} not round a hole`);
            if (rp.flipped) parts.push(`${pl(rp.flipped, 'triangle')} turned the right way round`);
            if (rp.nonManifold) parts.push(`${pl(rp.nonManifold, 'edge')} shared by more than two triangles`);
            parts.push(solid ? `solid of ${+R.measureVolume(solid).toFixed(3)} mm³` : built.open ? `still ${pl(built.open, 'open edge')}: kept as a surface body` : f.solid === false ? 'closed (kept as a surface body)' : 'closed, but not as one volume: kept as a surface body');
            res.notes[f.id] = parts.join(' · ');
            break;
          }
          progress(null, 'Sewing the surfaces…');
          let sewn = sewShapes(recs.map((r) => r.shape), tol);
          const { loops, open } = holeLoops(sewn);
          const patches = [];
          let filled = 0, tooBig = 0, failed = 0;
          progress(null, `Closing ${loops.length} hole${loops.length === 1 ? '' : 's'}…`);
          for (const loop of loops) {
            if (maxHole > 0 && loop.size > maxHole) { tooBig++; continue; }
            let faces = null;
            try { faces = holePatch(loop, tol); } catch (e) { if (isFatal(e)) throw e; faces = null; }
            if (!faces?.length) { failed++; continue; }
            patches.push(...faces);
            filled++;
          }
          if (patches.length) sewn = sewShapes([sewn, ...patches], tol);
          const left = holeLoops(sewn);
          surfaces = surfaces.filter((r) => !recs.includes(r));
          let solid = null;
          if (f.solid !== false && !left.freeEdges) solid = solidFromSewn(sewn);
          if (solid) apply('add', unify(solid), f.merge === true);
          else { surfaces.push(bodyRec(recs[0].id, sewn, f.id)); applied.push({ op: 'add', tool: sewn }); }
          const parts = [`${pl(filled, 'hole')} closed`];
          if (tooBig) parts.push(`${tooBig} larger than ${+maxHole.toFixed(3)} mm left open`);
          if (failed) parts.push(`${failed} could not be closed`);
          if (open.length) parts.push(`${pl(open.length, 'dangling edge chain')} (not round a hole)`);
          parts.push(solid ? `solid of ${+R.measureVolume(solid).toFixed(3)} mm³` : left.freeEdges ? `still ${pl(left.freeEdges, 'open edge')}: kept as a surface body` : f.solid === false ? 'closed (kept as a surface body)' : 'closed, but not as one volume: kept as a surface body');
          res.notes[f.id] = parts.join(' · ');
          if (!loops.length && !open.length) res.notes[f.id] = solid ? `No holes found · solid of ${+R.measureVolume(solid).toFixed(3)} mm³` : 'No holes found';
          break;
        }
        case 'thicken': {
          if (!f.body) throw new Error('Click the surface body to thicken');
          const rec = needBody(f.body, 'surface body');
          if (!surfaces.includes(rec)) throw new Error('Select a surface body to thicken');
          const t = ev(f.thickness);
          if (t <= 0) throw new Error('Thickness must be greater than zero');
          const oc = R.getOC();
          let src = rec.shape;
          if (f.side === 'both') src = offsetFace(src, f.flip ? t / 2 : -t / 2);
          const mk = new oc.BRepOffsetAPI_MakeThickSolid();
          mk.MakeThickSolidBySimple(src.wrapped, f.side === 'both' ? (f.flip ? -t : t) : f.flip ? -t : t);
          const solid = R.cast(mk.Shape());
          mk.delete();
          if (!solidsOf(solid).length) throw new Error('The surface could not be thickened');
          surfaces = surfaces.filter((r) => r !== rec);
          // each solid facing out: thickened one way the solid can come out inside-out (negative volume),
          // and then Combine / cuts with it give the material round it instead (OrientClosedSolid can't
          // turn it round through the binding, so it is reversed here)
          for (const sol of solidsOf(solid)) {
            oc.BRepLib.OrientClosedSolid(sol.wrapped);
            apply('add', R.measureVolume(sol) < 0 ? R.cast(sol.wrapped.Reversed()) : sol, f.merge !== false);
          }
          break;
        }
        case 'helix': {
          // the sketch's circle gives the axis (its normal), the centre and the diameter
          const s = sketches.get(f.sketch);
          if (!s) throw new Error('Select a sketch with a circle (it sets the helix axis and diameter)');
          const circ = s.sk.curves.find((c) => (c.type === 'circle' || c.type === 'arc') && !c.construction) || s.sk.curves.find((c) => c.type === 'circle' || c.type === 'arc');
          if (!circ) throw new Error('The sketch needs a circle: its centre and diameter set the helix axis and size');
          const fr = s.frame, C = S.getPoint(s.sk, circ.c), r = S.radiusOf(s.sk, circ);
          const c0 = S.fromFrame2D(fr, C.x, C.y), d = f.reverse ? mul(fr.n, -1) : fr.n;
          let pitch = ev(f.pitch), revs = ev(f.revolutions), height = ev(f.height);
          if (f.definedBy === 'pitchHeight') revs = height / pitch;
          else if (f.definedBy === 'heightRev') pitch = height / revs;
          else height = pitch * revs;
          if (!(pitch > 0) || !(revs > 0) || !(height > 0)) throw new Error('Pitch, revolutions and height must be greater than zero');
          if (revs > 1000) throw new Error('Too many revolutions (max 1000)');
          let w = R.makeHelix(pitch, height, r, c0, d, !!f.clockwise);
          // start angle measured from the sketch's horizontal direction, about the axis
          const sp = vec(w.startPoint), e = unit(rej(sub(sp, c0), d));
          const a = ((ev(f.startAngle) || 0) * Math.PI) / 180;
          const t = add(mul(fr.u, Math.cos(a)), mul(cross(d, fr.u), Math.sin(a)));
          const turn = (Math.atan2(dot(cross(e, t), d), dot(e, t)) * 180) / Math.PI;
          if (Math.abs(turn) > 1e-9) w = w.rotate(turn, c0, d);
          curves.set(f.id, { wire: w, axis: { o: c0, d }, r, pitch, height });
          const n = Math.min(6000, Math.ceil(revs * 64) + 1), edge = w.edges[0];
          res.curves[f.id] = Array.from({ length: n + 1 }, (_, i) => vec(edge.pointAt(i / n)));
          res.notes[f.id] = `Pitch ${+pitch.toFixed(4)} mm · ${+revs.toFixed(3)} revolutions · height ${+height.toFixed(3)} mm · Ø${+(2 * r).toFixed(3)} mm`;
          break;
        }
        case 'sketch3d': {
          // a 3D sketch: points anywhere in space and lines between them. Each connected run of lines is one
          // curve: straight runs (rounded at the corners by the bend radius, e.g. a pipe or duct route) or a
          // smooth spline through its points. (Older 3D sketches: a list of points joined in order.)
          const coords = (q, i) => {
            const v = [ev(q.x ?? 0), ev(q.y ?? 0), ev(q.z ?? 0)];
            if (!v.every(Number.isFinite)) throw new Error(`Point ${i + 1} has an invalid coordinate`);
            return v;
          };
          // converted entities follow the model's edges: their fixed points (and circle radii) are taken from the
          // edges found again now, and the sketch is solved so what is attached to them follows too
          let fresh = null;
          if (Array.isArray(f.segs) && f.segs.some((g) => g.link)) {
            normalize3d(f, ev);
            const fixOf = (g, pid) => f.rels.find((r) => r.type === 'fix' && r.link === g.id && r.refs[0] === pid);
            const setFix = (g, pid, q) => { const r = fixOf(g, pid); if (r) r.value = q.map((x) => Math.round(x * 1e6) / 1e6); };
            const was = (g, pid) => fixOf(g, pid)?.value || null;
            const lost = [];
            for (const g of f.segs) {
              if (!g.link) continue;
              const e = body ? findEdge(body, g.link) : null;
              if (!e) { lost.push(g.id); continue; }
              updateEdgeRef(g.link, e, body);
              const A = vec(e.startPoint), B = vec(e.endPoint);
              const flipOf = (pid) => { const o = was(g, pid); return o ? len(sub(B, o)) < len(sub(A, o)) : false; };
              if (g.type === 'circle') {
                const ci = circleOf(e);
                if (ci) { setFix(g, g.c, ci.c); g.r = ci.r; g.n = dot(ci.n, g.n) < 0 ? mul(ci.n, -1) : ci.n; const rr = f.rels.find((r) => r.type === 'radius' && r.link === g.id); if (rr) rr.value = ci.r; }
              } else if (g.type === 'arc') {
                const flip = flipOf(g.a);
                setFix(g, g.a, flip ? B : A); setFix(g, g.b, flip ? A : B);
                const ci = circleOf(e);
                if (ci) { setFix(g, g.c, ci.c); g.n = dot(ci.n, g.n) < 0 ? mul(ci.n, -1) : ci.n; }
              } else if (g.type === 'spline') {
                const k = g.pts.length, flip = flipOf(g.pts[0]), end = g.closed ? k : k - 1;
                g.pts.forEach((pid, i) => setFix(g, pid, vec(e.pointAt(flip ? 1 - i / end : i / end))));
              } else {
                const flip = flipOf(g.a);
                setFix(g, g.a, flip ? B : A); setFix(g, g.b, flip ? A : B);
              }
            }
            for (const r of f.rels) if (r.type === 'fix' && r.link) { const q = f.pts.find((x) => x.id === r.refs[0]); if (q) [q.x, q.y, q.z] = r.value; }
            const solvedOk = solve3d(f, ev).ok;
            fresh = {
              pts: f.pts.map((q) => ({ id: q.id, x: q.x, y: q.y, z: q.z })),
              radii: Object.fromEntries(f.segs.filter((g) => g.type === 'circle').map((g) => [g.id, g.r])),
              normals: Object.fromEntries(f.segs.filter((g) => g.n).map((g) => [g.id, g.n])),
              values: Object.fromEntries(f.rels.filter((r) => r.link).map((r) => [r.id, r.value])),
              links: Object.fromEntries(f.segs.filter((g) => g.link).map((g) => [g.id, g.link])),
            };
            if (!solvedOk) fresh.warn = 'the converted edges moved where the sketch\'s relations can\'t follow';
            if (lost.length) fresh.warn = `${lost.length} converted edge${lost.length === 1 ? ' is' : 's are'} no longer in the model (kept where ${lost.length === 1 ? 'it was' : 'they were'})`;
          }
          const P = (f.pts || []).map(coords);
          res.detected[f.id] = { pts: P, ...(fresh ? { s3: fresh } : {}) };
          let chains = [];
          const closedSplines = [];
          const circles3d = [];
          // an arc's middle point (counterclockwise round its normal from a to b)
          const arcMid = (g, at) => {
            const Cc = at.get(g.c), A = at.get(g.a), B = at.get(g.b), n = unit(g.n);
            const u = sub(A, Cc), w = sub(B, Cc);
            let th = Math.atan2(dot(n, cross(u, w)), dot(u, w));
            if (th <= 1e-9) th += 2 * Math.PI;
            const h = th / 2, c = Math.cos(h), s = Math.sin(h), k = dot(n, u), nu = cross(n, u);
            return u.map((x, i) => Cc[i] + x * c + nu[i] * s + n[i] * k * (1 - c));
          };
          if (!Array.isArray(f.segs)) chains = [{ Q: P, closed: !!f.closed }];
          else {
            const at = new Map((f.pts || []).map((q, i) => [q.id, P[i]]));
            // (construction geometry shapes the sketch but makes no curve; circles are curves of their own)
            for (const g of f.segs) if (!g.construction && g.type === 'spline' && g.closed && g.pts.every((x) => at.has(x)) && g.pts.length > 2) closedSplines.push(g);
            const segs = f.segs
              .filter((g) => !g.construction && g.type !== 'circle' && !(g.type === 'spline' && g.closed))
              .map((g) => (g.type === 'spline' ? { ...g, a: g.pts[0], b: g.pts[g.pts.length - 1] } : g))
              .filter((g) => at.has(g.a) && at.has(g.b) && g.a !== g.b && (g.type !== 'arc' || at.has(g.c)) && (g.type !== 'spline' || g.pts.every((x) => at.has(x))));
            for (const g of f.segs) if (!g.construction && g.type === 'circle' && at.has(g.c) && g.r > 0) circles3d.push({ C: at.get(g.c), r: g.r, n: unit(g.n) });
            const ends = new Map();
            segs.forEach((g, k) => { for (const id of [g.a, g.b]) { if (!ends.has(id)) ends.set(id, []); ends.get(id).push(k); } });
            const used = new Set();
            // walk from a point along unused lines while the way on is clear (a point with two lines)
            const walk = (start, k0) => {
              const ids = [start], ks = [];
              let cur = start, k = k0;
              for (;;) {
                used.add(k);
                ks.push(k);
                const g = segs[k], next = g.a === cur ? g.b : g.a;
                if (next === start) return { ids, ks, closed: true };
                ids.push(next);
                cur = next;
                const on = ends.get(cur);
                if (on.length !== 2) break;
                k = on.find((x) => !used.has(x));
                if (k === undefined) break;
              }
              return { ids, ks, closed: false };
            };
            for (const [id, ks] of ends) if (ks.length !== 2) for (const k of ks) if (!used.has(k)) chains.push(walk(id, k));
            for (let k = 0; k < segs.length; k++) if (!used.has(k)) chains.push(walk(segs[k].a, k));
            chains = chains.map((c) => ({ Q: c.ids.map((id) => at.get(id)), closed: c.closed, segs: c.ks.map((k) => segs[k]), ids: c.ids }));
            chains.at = at;
          }
          const buildRoute = (P0, closed0) => {
            // (repeated points dropped)
            const Q = P0.filter((q, i) => !i || len(sub(q, P0[i - 1])) > 1e-9);
            const closed = !!closed0 && Q.length > 2;
            if (closed && len(sub(Q[0], Q[Q.length - 1])) < 1e-9) Q.pop();
            if (Q.length < 2) throw new Error('A 3D sketch needs at least two different points');
            let wire, edgesOut = [];
            if (f.kind === 'spline') {
              if (Q.length < 3) {
                wire = R.assembleWire([R.makeLine(Q[0], Q[1])]);
              } else if (!closed) {
                wire = R.assembleWire([R.makeBSplineApproximation(Q, { tolerance: 1e-4, degMin: 3, degMax: 5, smoothing: null })]);
              } else {
                // closed: cubic pieces through the points, each point's tangent along the chord of its
                // neighbours, so it runs smoothly all the way round (no kink where it closes)
                const m = Q.length, at = (i) => Q[((i % m) + m) % m];
                const tg = (i) => unit(sub(at(i + 1), at(i - 1)));
                wire = R.assembleWire(Q.map((q, i) => {
                  const b = at(i + 1), d = len(sub(b, q)) / 3;
                  return R.makeBezierCurve([q, add(q, mul(tg(i), d)), sub(b, mul(tg(i + 1), d)), b]);
                }));
              }
            } else {
              const Rb = ev(f.radius ?? 0);
              if (!(Rb >= 0)) throw new Error('The bend radius can\'t be negative');
              const V = closed ? [...Q, Q[0]] : Q, n = V.length;
              // the corner at point k (k = 0: where a closed loop meets itself): how far its bend takes from
              // the runs on either side (R tan(θ/2)) and the bend itself
              const corner = (k) => {
                if (!(Rb > 0)) return null;
                if (k === 0 && !closed) return null;
                if (k === n - 1) return null;
                const prev = k === 0 ? V[n - 2] : V[k - 1], at = V[k], next = V[k + 1];
                const d1 = unit(sub(at, prev)), d2 = unit(sub(next, at));
                const th = Math.acos(Math.max(-1, Math.min(1, dot(d1, d2))));
                if (th < 1e-6) return null;
                if (th > Math.PI - 1e-6) throw new Error(`The route turns right back on itself at point ${k + 1}`);
                const s = Rb * Math.tan(th / 2);
                const T1 = sub(at, mul(d1, s)), T2 = add(at, mul(d2, s));
                const ctr = add(at, mul(unit(sub(d2, d1)), Rb / Math.cos(th / 2)));
                return { s, arc: () => R.makeThreePointArc(T1, add(ctr, mul(unit(sub(at, ctr)), Rb)), T2) };
              };
              const C = V.map((_, k) => corner(k));
              for (let i = 0; i < n - 1; i++) {
                const a = V[i], b = V[i + 1], L = len(sub(b, a)), d = unit(sub(b, a));
                const cs = C[i], ce = i + 1 === n - 1 ? (closed ? C[0] : null) : C[i + 1];
                const s0 = cs?.s || 0, s1 = ce?.s || 0;
                if (s0 + s1 > L + 1e-9) throw new Error(`The bend radius is too big for the run from point ${i + 1} to point ${i + 2 > Q.length ? 1 : i + 2} (${+L.toFixed(3)} mm long)`);
                const pa = add(a, mul(d, s0)), pb = sub(b, mul(d, s1));
                if (len(sub(pb, pa)) > 1e-9) edgesOut.push(R.makeLine(pa, pb));
                if (ce) edgesOut.push(ce.arc());
              }
              wire = R.assembleWire(edgesOut);
            }
            return { wire, edgesOut, Q };
          };
          if (!chains.length && !circles3d.length && !closedSplines.length) {
            res.notes[f.id] = (f.pts || []).length ? `${f.pts.length} point${f.pts.length === 1 ? '' : 's'}, no lines` : 'Empty 3D sketch';
            break;
          }
          // runs with arcs: each line and arc as it is (the bend radius rounds runs of lines only)
          const routes = chains.map((c) => {
            if (!c.segs?.some((g) => g.type === 'arc' || g.type === 'spline')) return buildRoute(c.Q, c.closed);
            const at = chains.at, edgesOut = [];
            c.segs.forEach((g, i) => {
              const A = at.get(c.ids[i]), B = at.get(c.ids[(i + 1) % c.ids.length]);
              if (g.type === 'arc') edgesOut.push(R.makeThreePointArc(A, arcMid(g, at), B));
              else if (g.type === 'spline') {
                // (walked from its last point: the pieces the other way round)
                const fwd = c.ids[i] === g.pts[0];
                const pieces = splineGeom(f, g).pieces;
                for (const q of fwd ? pieces : pieces.slice().reverse()) edgesOut.push(R.makeBezierCurve(fwd ? q : q.slice().reverse()));
              } else if (len(sub(B, A)) > 1e-9) edgesOut.push(R.makeLine(A, B));
            });
            return { wire: R.assembleWire(edgesOut), edgesOut, Q: c.Q };
          });
          for (const ci of circles3d) routes.push({ wire: R.assembleWire([R.makeCircle(ci.r, ci.C, ci.n)]), edgesOut: [], Q: [] });
          for (const g of closedSplines) routes.push({ wire: R.assembleWire(splineGeom(f, g).pieces.map((q) => R.makeBezierCurve(q))), edgesOut: [], Q: [] });
          curves.set(f.id, { wire: routes[0].wire, wires: routes.map((r) => r.wire), route: true });
          // drawn as polylines (curves finely)
          const shownAll = routes.map(({ wire }) => {
            const shown = [];
            for (const e of wire.edges) {
              const m = e.geomType === 'LINE' ? 1 : 24;
              for (let i = shown.length ? 1 : 0; i <= m; i++) shown.push(vec(e.pointAt(i / m)));
            }
            return shown;
          });
          res.curves[f.id] = shownAll.length === 1 ? shownAll[0] : shownAll;
          const L = routes.reduce((t, r) => t + R.measureLength(r.wire), 0);
          const bends = routes.reduce((t, r) => t + r.edgesOut.filter((e) => e.geomType !== 'LINE').length, 0);
          res.notes[f.id] = `${P.length} points · ${routes.length > 1 ? routes.length + ' curves · ' : ''}length ${+L.toFixed(3)} mm` + (f.kind === 'spline' ? ' (spline)' : bends ? ` · ${bends} bend${bends === 1 ? '' : 's'}` : '') + (fresh?.warn ? ' — ' + fresh.warn : '');
          break;
        }
        case 'sweep': {
          const owned=[];
          try{
          checkSweepRefs(f);
          const sk = f.profileType === 'circle' ? null : getSketch(f.profile, f.thin ? { t: ev(f.thinT), dir: f.thinDir || 'one' } : null);
          const {wire:spine,helical}=sweepPath(f,owned,sk?.frame);
          const start = vec(spine.startPoint), tan0 = unit(vec(spine.tangentAt(0)));
          let profiles;
          if (f.profileType === 'circle') {
            const dia = ev(f.diameter);
            if (!(dia > 0)) throw new Error('The diameter must be greater than zero');
            profiles = [{ outer: R.assembleWire([R.makeCircle(dia / 2, start, tan0)]), holes: [] }];
          } else {
            profiles = sk.regions.map((rg) => ({ outer: loopWire(sk.frame, rg.outer.segs), holes: rg.holes.map((h) => loopWire(sk.frame, h.segs)) }));
          }
          profiles.forEach(p=>owned.push(p.outer,...p.holes));
          const guide=f.guide?sweepWire(f.guide,'guide',owned).wire:null;
          if(guide&&(f.profileType!=='circle'&&f.thin||profiles.length!==1||profiles[0].holes.length))throw new Error('A guided sweep requires one closed profile without holes or Thin Feature');
          const options = sweepOptions(f, spine, guide);
          const sweepOne = (w) => (guide ? sweepWithGuide(w, spine, guide, f.guideMode || 'orientation') : sweepAlong(w, spine, options, { helical }));
          let tool = null;
          for (const pr of profiles) {
            let s = sweepOne(pr.outer);
            for (const h of pr.holes) s = s.cut(sweepOne(h));
            tool = tool ? tool.fuse(s) : s;
          }
          tool = unify(tool);
          if (guide) res.notes[f.id] = `Path and one guide · ${f.guideMode === 'contact' ? 'Section size; CAD guide contact ≤ 0.0001 mm' : 'Orientation; constant profile size'}`;
          const scope = (f.op === 'cut' || f.op === 'intersect') && f.scopeAll === false ? f.scope || [] : null;
          tools.set(f.id, { shape: tool, op: f.op, merge: f.merge !== false, scope });
          apply(f.op, tool, f.merge !== false, scope);
          }finally{owned.reverse().forEach(w=>w.delete());}
          break;
        }
        case 'loft': {
          const ids = (f.profiles || []).filter(Boolean);
          if (ids.length < 2) throw new Error('Select at least two profiles (in order)');
          const connectorControls=loftConnectionControls(f,ids);
          const thin = f.thin ? { t: ev(f.thinT), dir: f.thinDir || 'one' } : null;
          // each profile: one region (outline + holes), as 3D sections
          const profs = ids.map((id) => {
            const s = sketches.get(LR.sourceId(id));
            if (!s) throw new Error('A profile sketch is missing, suppressed or has errors');
            const resolved = typeof id === 'string' ? { sketch: s.sk } : LR.resolveContour(s.sk, id);
            const regions = thin ? S.thinRegions(resolved.sketch, thin.t, thin.dir) : resolved.region ? [resolved.region] : S.profileRegions(resolved.sketch);
            if (regions.length !== 1) throw new Error(`${s.sk.name} must have exactly one closed profile (it has ${regions.length})`);
            return { name: s.sk.name, outer: loftSection(s.frame, regions[0].outer.segs), holes: regions[0].holes.map((h) => loftSection(s.frame, h.segs)), holeKeys: regions[0].holes.map(LC.holeKey) };
          });
          // (manual connectors: a connector inside a curve splits it there, so the profile gains a point; holes paired
          // and started by hand; a Thin loft's walls each start at their vertex nearest the connector)
          const holeControls = profs.map(() => []);
          if (connectorControls) profs.forEach((p, i) => {
            const c = connectorControls[i];
            if (thin) {
              const nearest = (sec, q) => (q && sec.segs ? sec.segs.reduce((b, g) => (len(sub(g.a, q)) < len(sub(b, q)) ? g.a : b), sec.segs[0].a) : null);
              if (c.anchor) { holeControls[i] = p.holes.map((h) => ({ anchor: nearest(h, c.anchor), reverse: c.reverse })); connectorControls[i] = { ...c, anchor: nearest(p.outer, c.anchor) }; }
              return;
            }
            p.outer = LC.splitSectionAt(p.outer, c.anchor);
            const order = LC.holeOrder(c.control, p.holeKeys);
            p.holes = order.map((k) => p.holes[k]); p.holeKeys = order.map((k) => p.holeKeys[k]);
            holeControls[i] = p.holeKeys.map((key, k) => { const anchor = LC.holeAnchor(c.source.sk, c.ref, c.source.frame, c.control, key, ev); if (anchor) p.holes[k] = LC.splitSectionAt(p.holes[k], anchor); return { anchor, reverse: false }; });
          });
          // (continuity C2: curvature-continuous through the profiles, the kernel's usual; C1: tangent-continuous;
          // smoothing: the surface evened out, with its own builder when either is asked for)
          const custom = !f.ruled && ((f.continuity && f.continuity !== 'C2') || f.smoothing);
          // guide curves (sketches or curves, each running from the first profile to the last): the outline
          // follows them (guidedLoftWires); not with straight (ruled) sides
          const guides = (f.guides || []).filter(Boolean).map((id) => {
            if (curves.has(id)) return { name: doc.features.find((x) => x.id === id)?.name || 'A guide curve', wire: curves.get(id).wire };
            const s = sketches.get(LR.sourceId(id));
            if (!s) throw new Error('A guide curve is missing, suppressed or has errors');
            const subset = typeof id === 'string' ? s.sk : LR.resolveContour(s.sk, id, true).sketch;
            const ws = sketchWires(subset, s.frame);
            if (ws.length !== 1) throw new Error(`The guide ${s.sk.name} must be one connected chain of curves`);
            return { name: s.sk.name, wire: ws[0] };
          });
          if (guides.length && f.ruled) throw new Error('Guide curves shape a smooth loft: untick "Straight (ruled) sides"');
          const buildLoft = (wires) => {
            if(connectorControls)return manualLoft(wires,f);
            if (!custom) return R.loft(wires, { ruled: !!f.ruled });
            const oc = R.getOC(), mk = new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6);
            try {
              mk.SetContinuity(oc.GeomAbs_Shape[f.continuity === 'C1' ? 'GeomAbs_C1' : 'GeomAbs_C2']);
              if (f.smoothing) mk.SetSmoothing(true);
              for (const w of wires) mk.AddWire(w.wrapped);
              mk.Build();
              const sh = R.cast(mk.Shape());
              if (!solidsOf(sh).length) throw new Error('The loft could not be made with these options');
              return sh;
            } finally { mk.delete(); }
          };
          const names = profs.map((p) => p.name);
          const nh = profs[0].holes.length;
          if (profs.some((p) => p.holes.length !== nh)) throw new Error('Every profile needs the same number of holes (inner loops)');
          let outerM = matchLoftSections(profs.map((p) => p.outer), names);
          if(connectorControls){outerM=LC.applySectionConnections(outerM,profs.map(p=>p.outer),connectorControls,true);loftConnectionInfo(f,ids,outerM,true);}
          const holesM = Array.from({ length: nh }, (_, i) => {
            const m = matchLoftSections(profs.map((p) => p.holes[i]), names), cs = holeControls.map((h) => h[i] || { anchor: null, reverse: false });
            return cs.some((c) => c.anchor) ? LC.applySectionConnections(m, profs.map((p) => p.holes[i]), cs.map((c) => ({ ...c, reverse: cs[0].reverse })), true) : m;
          });
          if (hasLoftEnds(f)) {
            const endWires = outerM.map(sectionWire);
            const tool = buildEndLoft(f, ids, endWires, false, { holes: holesM.map(loop => loop.map(sectionWire)), guides, matched: outerM, holesMatched: holesM, names, slack: thin ? thin.t : 0 });
            const scope = (f.op === 'cut' || f.op === 'intersect') && f.scopeAll === false ? f.scope || [] : null;
            tools.set(f.id, { shape: tool, op: f.op, merge: f.merge !== false, scope });
            apply(f.op, tool, f.merge !== false, scope); break;
          }
          // with guides: the outline follows them and the holes (a thin loft's inside) move with it
          const g = guides.length ? buildGuidedLoft(outerM, guides, names, holesM, thin ? thin.t : 0, { constrained: f.guideMethod === 'constrained', guideContinuity: f.guideContinuity || 'C0', build: buildLoft }) : null;
          let tool = g ? g.shape : buildLoft(outerM.map(sectionWire));
          if (guides.length) res.notes[f.id] = `${profs.length} profiles, ${guides.length} guide curve${guides.length === 1 ? '' : 's'}` + guideConstraintNote(g);
          for (let i = 0; i < nh; i++) tool = tool.cut(g ? g.holes[i] : buildLoft(holesM[i].map(sectionWire)));
          tool = unify(tool);
          const scope = (f.op === 'cut' || f.op === 'intersect') && f.scopeAll === false ? f.scope || [] : null;
          tools.set(f.id, { shape: tool, op: f.op, merge: f.merge !== false, scope });
          apply(f.op, tool, f.merge !== false, scope);
          break;
        }
        case 'cosmeticThread': {
          // A thread that is shown (in the model and on drawings) and called out, not modelled: the body keeps
          // its plain bore or shaft, so it costs nothing to rebuild.
          if (!f.face) throw new Error('Click the cylindrical face to thread (a bore or a shaft)');
          const hit = findFaceAny(solids, f.face);
          if (!hit) throw new Error('The selected face could not be found in the model');
          const ax = faceAxis(hit.face);
          if (!ax || hit.face.geomType !== 'CYLINDRE') throw new Error('Select a cylindrical face (a bore or a shaft)');
          const rF = radiusOfFace(hit.face);
          const p = f.face.p, axisPt = (q) => add(ax.o, mul(ax.d, dot(sub(q, ax.o), ax.d)));
          const internal = dot(unit(vec(hit.face.normalAt(p))), unit(sub(p, axisPt(p)))) < 0; // (the face looks at the axis: a bore)
          const ts = [];
          for (const e of hit.face.edges) for (const u of [0, 0.25, 0.5, 0.75, 1]) ts.push(dot(sub(vec(e.pointAt(u)), ax.o), ax.d));
          const tMin = Math.min(...ts), tMax = Math.max(...ts), tp = dot(sub(p, ax.o), ax.d);
          let std;
          if (f.size === 'custom') {
            const D = ev(f.diameter), Pc = ev(f.pitch);
            if (!(D > 0) || !(Pc > 0)) throw new Error('Enter the custom diameter and pitch');
            std = { label: `Custom Ø${+D.toFixed(3)}×${+Pc.toFixed(3)}`, D, P: Pc };
          } else if (f.size && f.size !== 'auto') {
            std = threadList(f.system).find((t) => t.id === f.size);
            if (!std) throw new Error('Choose a thread size');
          } else std = nearestThread(f.system || 'metric', 2 * rF, internal);
          const pitchOverride = f.size !== 'custom' && f.pitch !== '' && f.pitch != null ? ev(f.pitch) : null;
          const Pt = pitchOverride > 0 ? pitchOverride : std.P, D = std.D, D1 = minorDiameter(D, Pt);
          if (D1 <= 0) throw new Error('The pitch is too large for this diameter');
          // from the end nearest the picked point (Reverse: the other end)
          const fromMax = (Math.abs(tp - tMax) < Math.abs(tp - tMin)) !== !!f.reverse;
          const t0 = fromMax ? tMax : tMin, sgn = fromMax ? -1 : 1, full = tMax - tMin;
          let L = full;
          if (f.end === 'blind') L = ev(f.depth);
          else if (f.end === 'upTo') {
            const sf = resolveSurface(f.toPlane, f.toFace);
            if (f.toFace) res.features[f.id] = { ...(res.features[f.id] || {}), toFace: f.toFace };
            const den = dot(ax.d, sf.n);
            if (Math.abs(den) < 1e-9) throw new Error('The end reference is parallel to the thread axis');
            L = (dot(sub(sf.p, ax.o), sf.n) / den - t0) * sgn;
          }
          if (!(L > 1e-6)) throw new Error('The thread length must be greater than zero (check the end condition and the direction)');
          L = Math.min(L, full);
          const label = `${std.label}${pitchOverride ? ` (pitch ${+pitchOverride.toFixed(4)})` : ''}${f.leftHand ? ' LH' : ''}`;
          res.threads[f.id] = [{ internal, o: add(ax.o, mul(ax.d, t0)), d: mul(ax.d, sgn), len: L, full: L > full - 1e-6, r: rF, D, D1, P: Pt, label }];
          // (a bore is drilled to about the minor diameter, a shaft turned to the major one)
          const want = internal ? D1 : D, off = Math.abs(2 * rF - want) > Math.max(0.05, 0.03 * want);
          res.notes[f.id] = `${label}, ${internal ? 'internal (bore)' : 'external (shaft)'}, ${+L.toFixed(3)} long — shown, not modelled${off ? ` (the face is Ø${+(2 * rF).toFixed(3)}; this thread expects Ø${+want.toFixed(3)})` : ''}`;
          break;
        }
        case 'thread': {
          if (!f.face) throw new Error('Click the cylindrical face to thread (a bore or a shaft)');
          needEdges('Thread');
          const hit = findFaceAny(solids, f.face);
          if (!hit) throw new Error('The selected face could not be found in the model');
          const ax = faceAxis(hit.face);
          if (!ax || hit.face.geomType !== 'CYLINDRE') throw new Error('Select a cylindrical face (a bore or a shaft)');
          const rF = radiusOfFace(hit.face);
          const p = f.face.p, axisPt = (q) => add(ax.o, mul(ax.d, dot(sub(q, ax.o), ax.d)));
          const radial = unit(sub(p, axisPt(p)));
          const internal = dot(unit(vec(hit.face.normalAt(p))), radial) < 0; // the face looks at the axis: a bore
          // the face's extent along the axis
          const ts = [];
          for (const e of hit.face.edges) for (const u of [0, 0.25, 0.5, 0.75, 1]) ts.push(dot(sub(vec(e.pointAt(u)), ax.o), ax.d));
          const tMin = Math.min(...ts), tMax = Math.max(...ts), tp = dot(sub(p, ax.o), ax.d);
          // the standard (or custom size)
          let std;
          if (f.size === 'custom') {
            const D = ev(f.diameter), Pc = ev(f.pitch);
            if (!(D > 0) || !(Pc > 0)) throw new Error('Enter the custom diameter and pitch');
            std = { label: `Custom Ø${+D.toFixed(3)}×${+Pc.toFixed(3)}`, D, P: Pc };
          } else if (f.size && f.size !== 'auto') {
            std = threadList(f.system).find((t) => t.id === f.size);
            if (!std) throw new Error('Choose a thread size');
          } else std = nearestThread(f.system || 'metric', 2 * rF, internal);
          const pitchOverride = f.size !== 'custom' && f.pitch !== '' && f.pitch != null ? ev(f.pitch) : null;
          const Pt = pitchOverride > 0 ? pitchOverride : std.P, D = std.D, D1 = minorDiameter(D, Pt);
          if (D1 <= 0) throw new Error('The pitch is too large for this diameter');
          // where the face must be (bore at the minor diameter for a cut, at the major for a ridge; shafts the other way)
          const rBase = f.op === 'cut' ? (internal ? D1 / 2 : D / 2) : (internal ? D / 2 : D1 / 2);
          const rTip = f.op === 'cut' ? (internal ? D / 2 : D1 / 2) : (internal ? D1 / 2 : D / 2);
          // start at the end nearest to the picked point (Reverse: the other end)
          const fromMax = (Math.abs(tp - tMax) < Math.abs(tp - tMin)) !== !!f.reverse;
          const t0 = fromMax ? tMax : tMin, sgn = fromMax ? -1 : 1, full = tMax - tMin;
          let L = full;
          if (f.end === 'blind') L = ev(f.depth);
          else if (f.end === 'upTo') {
            const sf = resolveSurface(f.toPlane, f.toFace);
            if (f.toFace) res.features[f.id] = { ...(res.features[f.id] || {}), toFace: f.toFace };
            const den = dot(ax.d, sf.n);
            if (Math.abs(den) < 1e-9) throw new Error('The end reference is parallel to the thread axis');
            L = (dot(sub(sf.p, ax.o), sf.n) / den - t0) * sgn;
          }
          if (!(L > 1e-6)) throw new Error('The thread length must be greater than zero (check the end condition and the direction)');
          L = Math.min(L, full); // never past the end of the face
          const notes = [`${std.label}${pitchOverride ? ` (pitch ${pitchOverride})` : ''}`, internal ? 'internal (bore)' : 'external (shaft)'];
          let shape = hit.body.shape;
          const lo = Math.min(t0, t0 + sgn * L), hi = Math.max(t0, t0 + sgn * L);
          const cylAt = (r, a, b) => R.makeCylinder(r, b - a, add(ax.o, mul(ax.d, a)), ax.d);
          // 1) bring the bore / shaft to the thread size (within the body)
          if (f.autoSize !== false && Math.abs(rF - rBase) > 1e-4) {
            const big = Math.max(rF, rBase), small = Math.min(rF, rBase);
            const ring = cylAt(big, lo, hi).cut(cylAt(small, lo - 1, hi + 1));
            const removing = internal ? rBase > rF : rBase < rF;
            if (removing) {
              if (internal) {
                const inside = R.measureVolume(shape.intersect(ring)), whole = R.measureVolume(ring);
                if (inside < whole * 0.999) throw new Error(`${std.label}: the bore would have to grow from Ø${+(2 * rF).toFixed(3)} to Ø${+(2 * rBase).toFixed(3)}, which breaks out of the body`);
              }
              shape = shape.cut(ring);
            } else shape = shape.fuse(ring);
            notes.push(`${internal ? 'bore' : 'shaft'} Ø${+(2 * rF).toFixed(3)} → Ø${+(2 * rBase).toFixed(3)}`);
          } else if (Math.abs(rF - rBase) > 1e-4) notes.push(`face Ø${+(2 * rF).toFixed(3)} (thread expects Ø${+(2 * rBase).toFixed(3)})`);
          // 2) the thread: an ISO 60° trapezoid swept along a helix
          // narrow at the major diameter for a cut in a bore or a ridge on a shaft, the other way round otherwise
          const narrowAtMajor = (f.op === 'cut') === internal;
          const half = (r) => { const atMinor = narrowAtMajor ? 0.375 * Pt : 0.125 * Pt, atMajor = narrowAtMajor ? 0.0625 * Pt : 0.4375 * Pt; return atMinor + ((r - D1 / 2) / (D / 2 - D1 / 2)) * (atMajor - atMinor); };
          const ov = 0.15 * Pt, rOv = rBase + Math.sign(rBase - rTip) * ov; // overlaps the face for a clean boolean
          const corners = [[rOv, -half(rOv)], [rTip, -half(rTip)], [rTip, half(rTip)], [rOv, half(rOv)]];
          // The ends: the thread runs all the way to each end, with nothing sticking out past it. A groove
          // opening into air runs out past the end (it opens cleanly, e.g. at a nut's mouth); otherwise the
          // coil runs past the end and is cut off flush with it before it is applied. Should that fail, a
          // ridge into material runs out instead and the rest stop just short of the end.
          const maxHalf = Math.max(...corners.map((c) => Math.abs(c[1])));
          const u1 = radial, u2 = cross(ax.d, radial), rTest = rTip + 0.15 * (rBase - rTip), box = 0.08 * Pt;
          const solidAt = (t) => {
            let n = 0;
            for (let k = 0; k < 4; k++) {
              const a = (k * Math.PI) / 2, q = add(add(ax.o, mul(ax.d, t)), mul(add(mul(u1, Math.cos(a)), mul(u2, Math.sin(a))), rTest));
              const cube = R.makeBox(sub(q, [box, box, box]), add(q, [box, box, box]));
              if (R.measureVolume(hit.body.shape.intersect(cube)) > 4 * box ** 3) n++; // more than half the cube
            }
            return n >= 2;
          };
          const tEnd = t0 + sgn * L;
          const beyond = [solidAt(t0 - sgn * 0.25 * Pt), solidAt(tEnd + sgn * 0.25 * Pt)]; // material just past each end
          const harmless = (solid) => solid === (f.op !== 'cut');
          // A run-out goes far enough that the coil's flat end lies wholly past the end (a tooth is up to ~0.44
          // pitch wide: less leaves a hard step where the groove or ridge stops). Stopping short leaves the
          // widest corner a hair inside the end (a corner exactly on an end face upsets the boolean).
          const run = maxHalf + 0.1 * Pt;
          const kinds = (flush) => beyond.map((solid) => (harmless(solid) && (f.op === 'cut' || !flush) ? 'over' : flush ? 'flush' : harmless(solid) ? 'over' : 'short'));
          const insets = (flush) => kinds(flush).map((k) => (k === 'short' ? maxHalf + 0.02 * Pt : -run));
          // OCCT occasionally mis-classifies a coil against the body without any error: it adds or removes
          // nothing, or leaves the whole coil as a loose solid / a sealed cavity. Check for that and retry
          // with the coil turned a little.
          const rFace = f.autoSize !== false ? rBase : rF;
          const profileVol = (keep) => {
            // ∫ r dA over the profile part where keep(r) (Pappus: proportional to the volume)
            const pts = [corners[0], corners[1], corners[2], corners[3]], out = [];
            for (let k = 0; k < 4; k++) {
              const a = pts[k], b = pts[(k + 1) % 4], ia = keep(a[0]), ib = keep(b[0]);
              if (ia) out.push(a);
              if (ia !== ib) { const u = (rFace - a[0]) / (b[0] - a[0]); out.push([rFace, a[1] + u * (b[1] - a[1])]); }
            }
            let m = 0;
            for (let k = 0; k < out.length; k++) { const [r1, z1] = out[k], [r2, z2] = out[(k + 1) % out.length]; m += (r1 * z2 - r2 * z1) * (r1 + r2); }
            return Math.abs(m) / 6;
          };
          const inMaterial = (r) => (internal ? r > rFace : r < rFace);
          const share = profileVol(f.op === 'cut' ? inMaterial : (r) => !inMaterial(r)) / profileVol(() => true);
          const before = shape, vBefore = R.measureVolume(before);
          const topo = (sh) => `${solidsOf(sh).length}/${[...R.iterTopo(sh.wrapped, 'shell')].length}`, topoBefore = topo(before);
          const rCap = Math.max(rOv, rTip) + 4 * Pt;
          const attempt = (flush) => {
            const [inStart, inEnd] = insets(flush), kd = kinds(flush), len = L - inStart - inEnd;
            if (!(len > 0.25 * Pt)) throw new Error(`The thread is too short for a ${+Pt.toFixed(3)} pitch (it must be longer than about one pitch)`);
            // flush ends: the coil is cut off flat at the end before it is fused
            const flushEnds = [[kd[0], t0, -sgn], [kd[1], tEnd, sgn]].filter(([k]) => k === 'flush');
            for (const turn of [41, 67, 23, 97]) { // never 0°: the coil's ends would line up with the faces' seams
              let c = threadCoil(add(ax.o, mul(ax.d, t0 + sgn * inStart)), mul(ax.d, sgn), Pt, len, corners, !!f.leftHand);
              if (turn) c = c.rotate(turn, ax.o, ax.d);
              // (0.02 mm off the end: just past it for a groove, just inside for a ridge, as an end face's edges
              // exactly on the cut-off plane upset the boolean)
              for (const [, tE0, o] of flushEnds) {
                const tE = tE0 + o * (f.op === 'cut' ? 0.02 : -0.02);
                c = c.cut(cylAt(rCap, Math.min(tE, tE + o * 2 * run), Math.max(tE, tE + o * 2 * run)));
              }
              const vc = R.measureVolume(c);
              const result = f.op === 'cut' ? before.cut(c) : before.fuse(c);
              const change = Math.abs(R.measureVolume(result) - vBefore);
              if (change < 0.25 * share * vc || topo(result) !== topoBefore) continue;
              return { coil: c, result };
            }
            return null;
          };
          const out = attempt(true) || (kinds(true).includes('flush') ? attempt(false) : null);
          if (!out) throw new Error('The geometry kernel could not apply this thread to the face (try another size, pitch or length)');
          const coil = out.coil;
          shape = out.result;
          // the preview shows the thread trimmed flat at its ends (display only)
          const view = () => coil.cut(cylAt(rCap, hi, hi + 2 * Pt)).cut(cylAt(rCap, lo - 2 * Pt, lo));
          applied.push({ op: f.op, tool: coil, view, inside: true }); // the coil lies in the material it removes
          replaceSolid(hit.body, shape, f.id);
          res.notes[f.id] = notes.join(' · ');
          break;
        }
        case 'wrap': {
          // project the sketch (outlines and text) along its normal onto a face, raised or sunk by the depth
          const sk = getSketch(f.sketch);
          if (!f.face) throw new Error('Click the face to emboss or deboss onto');
          const hit = findFaceAny(solids, f.face);
          if (!hit) throw new Error('The selected face could not be found in the model');
          const dpt = ev(f.depth);
          if (!(dpt > 0)) throw new Error('The depth must be greater than zero');
          const deboss = f.method === 'deboss';
          const oc = R.getOC(), mk = new oc.BRepOffsetAPI_MakeThickSolid();
          let slab;
          try {
            mk.MakeThickSolidBySimple(hit.face.wrapped, (deboss ? -dpt : dpt) * (f.flip ? -1 : 1));
            slab = R.cast(mk.Shape());
          } finally { mk.delete(); }
          if (!slab || !solidsOf(slab).length) throw new Error('The face could not be offset by that depth (try a smaller depth)');
          // an outward offset of a curved face can come out inside out (negative volume): turn it round
          if (R.measureVolume(slab) < 0) slab = R.cast(slab.wrapped.Reversed());
          // project from the sketch plane toward the picked face only (not through to the far side of the part)
          const fr = sk.frame, side = Math.sign(dot(sub(f.face.p, fr.o), fr.n)) || 1;
          const bb = bbox(hit.body.shape), L = bb.diag + len(sub(bb.center, fr.o)) + 10;
          const prism = profileSolid(sk, (dr) => dr.sketchOnPlane(rPlane(fr)).extrude(side * L));
          let tool = prism.intersect(slab);
          // drop pieces behind the face (e.g. the back of a cylinder seen through it)
          const fb = bbox(hit.face), reach = Math.abs(dot(sub(f.face.p, fr.o), fr.n)) + Math.abs(dot(sub(fb.max, fb.min), fr.n)) / 2 + dpt;
          const near = solidsOf(tool).filter((sol) => Math.abs(dot(sub(bbox(sol).center, fr.o), fr.n)) <= reach);
          if (!near.length) throw new Error('The sketch does not project onto the selected face');
          tool = near.length === solidsOf(tool).length ? tool : asShape(near);
          applied.push({ op: deboss ? 'cut' : 'add', tool });
          replaceSolid(hit.body, unify(deboss ? hit.body.shape.cut(tool) : hit.body.shape.fuse(tool)), f.id);
          break;
        }
        case 'deleteBody':
        case 'deleteSurface': {
          const recs = (f.bodies || []).map((id) => needBody(id));
          if (!recs.length) throw new Error(f.type === 'deleteSurface' ? 'Select the surface bodies to delete' : 'Select the bodies to delete');
          if (f.type === 'deleteSurface' && recs.some((r) => !surfaces.includes(r))) throw new Error('Only surface bodies can be deleted with Delete Surface');
          for (const r of recs) applied.push({ op: 'cut', tool: r.shape });
          solids = solids.filter((x) => !recs.includes(x));
          surfaces = surfaces.filter((x) => !recs.includes(x));
          body = compoundOf(solids);
          break;
        }
        case 'combine': {
          if (!f.main) throw new Error('Click the main body on the model (or choose it in the list)');
          const main = needBody(f.main, 'main body');
          if (!solids.includes(main)) throw new Error('The main body must be a solid body');
          const tools = (f.bodies || []).filter((id) => id !== f.main).map((id) => needBody(id));
          if (!tools.length) throw new Error('Select the bodies to combine with the main body');
          if (tools.some((t) => !solids.includes(t))) throw new Error('Only solid bodies can be combined');
          let shape = main.shape;
          for (const t of tools) shape = f.op === 'subtract' ? shape.cut(t.shape) : f.op === 'common' ? shape.intersect(t.shape) : shape.fuse(t.shape);
          applied.push(...tools.map((t) => ({ op: f.op === 'add' ? 'add' : 'cut', tool: t.shape })));
          if (f.consume !== false) solids = solids.filter((s) => !tools.includes(s)); // else the tool bodies are kept
          if (!solidsOf(shape).length) {
            solids = solids.filter((s) => s !== main);
            body = compoundOf(solids);
            throw new Error('The result is empty (the bodies do not overlap?)');
          }
          replaceSolid(main, unify(shape), f.id);
          break;
        }
        case 'split': {
          let tool, plane = null;
          if (f.tool && (STD[f.tool] || planes.has(f.tool))) { const fr = resolveFrame(f.tool); plane = { p: fr.o, n: fr.n }; tool = planeFace(fr.o, fr.n); }
          else if (f.tool) { const sb = needBody(f.tool, 'surface'); if (!surfaces.includes(sb)) throw new Error('Choose a plane or a surface body to split with'); tool = sb.shape; }
          else if (f.toolFace) { const hit = findFace(body, f.toolFace); if (!hit) throw new Error('The selected face could not be found'); plane = hit; tool = planeFace(hit.p, hit.n); }
          else throw new Error('Choose a plane, a flat face or a surface body to split with');
          const targets = f.bodies?.length ? f.bodies.map((id) => needBody(id)).filter((b) => solids.includes(b)) : [...solids];
          if (!targets.length) throw new Error('There is no solid body to split');
          let splitAny = false;
          for (const rec of targets) {
            let pieces = splitBy(rec.shape, tool);
            if (pieces.length > 1) splitAny = true;
            if (plane && f.keep !== 'all') {
              const side = (sh) => Math.sign(dot(sub(bbox(sh).center, plane.p), plane.n));
              const want = f.keep === 'negative' ? -1 : 1;
              const kept = pieces.filter((sh) => side(sh) === want);
              if (kept.length) pieces = kept;
            }
            replaceSolid(rec, compoundOf(pieces.map((shape) => ({ shape }))), f.id);
          }
          if (!splitAny) throw new Error('The tool does not cut through the selected bodies');
          break;
        }
        case 'moveBody': {
          const recs = (f.bodies || []).map((id) => needBody(id));
          if (!recs.length) throw new Error('Select the bodies to move');
          let r = [0, 0, 0], t = [0, 0, 0];
          if (f.mode === 'mates') {
            if (!f.mates?.length) throw new Error('Add at least one mate');
            const mates = f.mates.map((m, i) => {
              const e1 = mateEntity(m.a), e2 = mateEntity(m.b);
              const isMoving = (e) => !!e.body && recs.includes(e.body);
              let A = e1, B = e2;
              if (!isMoving(A) && isMoving(B)) [A, B] = [B, A];
              if (!isMoving(A) || isMoving(B)) throw new Error(`Mate ${i + 1}: one entity must be on a moving body and the other on something fixed`);
              const n1 = A.geo.n || A.geo.d, n2 = B.geo.n || B.geo.d;
              let align = 1;
              if (m.type === 'coincident' || m.type === 'distance') align = A.geo.kind === 'plane' && B.geo.kind === 'plane' ? -1 : 1;
              else if (n1 && n2) align = dot(n1, n2) >= 0 ? 1 : -1;
              if (m.flip) align = -align;
              return { type: m.type, A: A.geo, B: B.geo, v: m.type === 'distance' || m.type === 'angle' ? ev(m.value ?? 0) : 0, align };
            });
            ({ r, t } = solveMates(mates, bbox(compoundOf(recs)).center));
          } else {
            const ang = ev(f.angle || 0);
            if (Math.abs(ang) > 1e-12 && f.rotAxis && f.rotAxis !== 'none') {
              const ax = resolveAxis(f.rotAxis);
              let c = ax.o;
              if (f.rotCenter === 'body') c = bbox(compoundOf(recs)).center;
              r = mul(unit(ax.d), (ang * Math.PI) / 180);
              const M = rotMat(r);
              t = sub(c, mv(M, c)); // rotate about c
            }
            t = add(t, [ev(f.dx || 0), ev(f.dy || 0), ev(f.dz || 0)]);
          }
          const copies = f.copy ? Math.max(1, Math.min(100, Math.round(ev(f.copies || 1)))) : 0;
          for (const rec of recs) {
            const list = solids.includes(rec) ? 'solids' : 'surfaces';
            const smM = rec.sheet ? (() => { const Rm = rotMat(r); return [Rm[0][0], Rm[0][1], Rm[0][2], t[0], Rm[1][0], Rm[1][1], Rm[1][2], t[1], Rm[2][0], Rm[2][1], Rm[2][2], t[2]]; })() : null;
            if (!copies) {
              const moved = moveShape(rec.shape, r, t);
              const nr = bodyRec(rec.id, moved, f.id);
              if (rec.sheet) nr.sheet = SM.moveSheet(rec.sheet, smM);
              if (list === 'solids') solids = solids.map((x) => (x === rec ? nr : x)); else surfaces = surfaces.map((x) => (x === rec ? nr : x));
              applied.push({ op: 'add', tool: moved });
            } else {
              // copy k: the motion applied k times (only translations/rotations repeat; mates copy once)
              let shape = rec.shape, smCur = rec.sheet;
              for (let k = 1; k <= (f.mode === 'mates' ? 1 : copies); k++) {
                shape = moveShape(shape, r, t);
                const nr = bodyRec(newId(f.id), shape, f.id);
                if (smCur) { smCur = SM.moveSheet(smCur, smM); nr.sheet = smCur; }
                if (list === 'solids') solids.push(nr); else surfaces.push(nr);
                applied.push({ op: 'add', tool: shape });
              }
            }
          }
          body = compoundOf(solids);
          break;
        }
        case 'smBase': {
          const sk = getSketch(f.sketch);
          const t = ev(f.thickness), R0 = ev(f.radius), K = sheetKFactor(f, R0, t);
          if (!(t > 0)) throw new Error('The thickness must be greater than zero');
          if (!(R0 > 0)) throw new Error('The bend radius must be greater than zero');
          if (!(K >= 0 && K <= 1)) throw new Error('The K-factor must be between 0 and 1');
          const sheet = SM.baseFlange({ region: sketchRegion(sk), frame: sk.frame, t, R: R0, K, reverse: !!f.reverse });
          const shape = SM.toSolid(sheet);
          const rec = bodyRec(newId(f.id), shape, f.id);
          rec.sheet = sheet;
          solids.push(rec);
          body = compoundOf(solids);
          applied.push({ op: 'add', tool: shape });
          break;
        }
        case 'smLoft': {
          // a sheet between two open profiles (one sketch each), bent from flat facets or formed smooth
          if (!f.profileA || !f.profileB) throw new Error('Select the two open profile sketches');
          if (f.profileA === f.profileB) throw new Error('Select two different sketches');
          const t = ev(f.thickness), R0 = ev(f.radius ?? 0), K = sheetKFactor(f, R0, t);
          if (!(t > 0)) throw new Error('The thickness must be greater than zero');
          const bent = f.method !== 'formed';
          // formed: the surface finer, a whole number of strips per forming line in the flat pattern
          const nDiv = Math.round(ev(f.bends ?? 12));
          if (!(nDiv >= 1 && nDiv <= 200)) throw new Error('The divisions along the profiles must be 1 to 200');
          const perLine = bent ? 1 : Math.max(1, Math.ceil(64 / nDiv)), nSeg = nDiv * perLine;
          // each profile as a fine polyline in model space, with where its corners are (fraction of its length)
          const profile = (id, which) => {
            const s = sketches.get(id);
            if (!s) throw new Error(`The ${which} profile sketch is missing, suppressed or has errors`);
            const chains = S.curveChains(s.sk);
            if (chains.length !== 1) throw new Error(`The ${which} profile sketch must hold one chain of lines / arcs joined end to end (it has ${chains.length})`);
            if (chains[0].closed) throw new Error(`The ${which} profile must be open: leave a gap where the seam of the part goes`);
            const pts = [], cornerAt = [];
            chains[0].items.forEach(({ c, rev }, k) => {
              let q = S.curvePoints(s.sk, c, 256);
              if (rev) q = [...q].reverse();
              if (k) { cornerAt.push(pts.length - 1); q = q.slice(1); }
              pts.push(...q);
            });
            const fr = s.frame, W3 = pts.map(([x, y]) => add(add(fr.o, mul(fr.u, x)), mul(fr.v, y)));
            const S0 = [0];
            for (let i = 1; i < W3.length; i++) S0.push(S0[i - 1] + len(sub(W3[i], W3[i - 1])));
            const total = S0[S0.length - 1];
            if (!(total > 0)) throw new Error(`The ${which} profile has no length`);
            // only real corners (not where a line runs smoothly into an arc)
            const corners = cornerAt.filter((i) => {
              const d0 = unit(sub(W3[i], W3[i - 1])), d1 = unit(sub(W3[i + 1], W3[i]));
              return dot(d0, d1) < Math.cos((1 * Math.PI) / 180);
            }).map((i) => S0[i] / total);
            const at = (fq) => {
              const target = fq * total;
              let i = 1;
              while (i < S0.length - 1 && S0[i] < target) i++;
              const k = (target - S0[i - 1]) / ((S0[i] - S0[i - 1]) || 1);
              return add(W3[i - 1], mul(sub(W3[i], W3[i - 1]), Math.max(0, Math.min(1, k))));
            };
            return { at, corners, first: W3[0], last: W3[W3.length - 1] };
          };
          const PA = profile(f.profileA, 'first'), PB0 = profile(f.profileB, 'second');
          // the profiles run the same way (the nearer ends together)
          const swapB = len(sub(PA.first, PB0.first)) + len(sub(PA.last, PB0.last)) > len(sub(PA.first, PB0.last)) + len(sub(PA.last, PB0.first));
          const PB = swapB ? { at: (q) => PB0.at(1 - q), corners: PB0.corners.map((q) => 1 - q) } : PB0;
          // matched points: evenly along both, plus every corner of either profile (so corners stay sharp)
          const fr = [...Array.from({ length: nSeg + 1 }, (_, i) => i / nSeg), ...PA.corners, ...PB.corners].sort((x, y) => x - y)
            .filter((q, i, arr) => !i || q - arr[i - 1] > 0.2 / nSeg || PA.corners.includes(q) || PB.corners.includes(q));
          const fracs = fr.filter((q, i, arr) => !i || q - arr[i - 1] > 1e-9);
          const A = fracs.map((q) => PA.at(q)), B = fracs.map((q) => PB.at(q));
          // where either profile has a corner (a formed part is smooth between them, sharp at them)
          const breaks = fracs.map((q, i) => (PA.corners.some((c) => Math.abs(c - q) < 1e-9) || PB.corners.some((c) => Math.abs(c - q) < 1e-9) ? i : -1)).filter((i) => i > 0);
          const sheet = SM.loftedSheet(A, B, { t, K, R: R0, method: bent ? 'bent' : 'formed', side: f.flip ? -1 : 1, breaks });
          if (!bent) sheet.lofted.bendLines = SM.formLines(sheet.lofted, { breaks });
          const shape = SM.toSolid(sheet);
          const rec = bodyRec(newId(f.id), shape, f.id);
          rec.sheet = sheet;
          solids.push(rec);
          body = compoundOf(solids);
          applied.push({ op: 'add', tool: shape });
          res.notes[f.id] = bent ? `${sheet.lofted.bendLines.length} bend${sheet.lofted.bendLines.length === 1 ? '' : 's'} between ${A.length - 1} strips (bent from flat facets)` : `Formed (smooth) — rolled from a flat pattern developed from the surface${sheet.lofted.bendLines.length ? `, with ${sheet.lofted.bendLines.length} sharp fold${sheet.lofted.bendLines.length === 1 ? '' : 's'} at its corners` : ''}`;
          break;
        }
        case 'draft': {
          // Draft: faces tilted by an angle about where they meet the neutral plane, along its normal
          needEdges('Draft');
          if (!f.face?.n) throw new Error('Click the neutral plane: a flat face that keeps its size');
          if (!f.faces?.length) throw new Error('Click the faces to draft');
          const ang = ev(f.angle);
          if (!(Math.abs(ang) > 1e-6 && Math.abs(ang) < 89)) throw new Error('The draft angle must be between 0° and 89°');
          const neutral = findFaceAny(solids, f.face);
          if (!neutral) throw new Error('The neutral plane face could not be found');
          const rec = neutral.body;
          const hits = f.faces.map((r) => findFaceAny([rec], r));
          if (hits.some((h) => !h)) throw new Error('Each face to draft must be on the body of the neutral plane');
          const n = unit(f.face.n), dir = f.reverse ? mul(n, -1) : n, p = f.face.p;
          const oc = R.getOC();
          const D = new oc.gp_Dir(dir[0], dir[1], dir[2]), N = new oc.gp_Dir(n[0], n[1], n[2]), P = new oc.gp_Pnt(p[0], p[1], p[2]);
          const pln = new oc.gp_Pln(P, N);
          const mk = new oc.BRepOffsetAPI_DraftAngle(rec.shape.wrapped);
          let out = null;
          try {
            for (const h of hits) {
              if (h.face.isSame(neutral.face)) continue;
              mk.Add(h.face.wrapped, D, (ang * Math.PI) / 180, pln, true);
              if (!mk.AddDone()) throw new Error('A face cannot be drafted from this neutral plane (it must not be parallel to the plane)');
            }
            mk.Build();
            out = R.cast(mk.Shape());
          } catch (e) {
            if (isFatal(e)) throw e;
            throw new Error(e.message?.startsWith('A face') ? e.message : 'The draft could not be made (a face that cannot tilt, or one whose neighbours cannot follow it)');
          } finally { mk.delete(); pln.delete(); P.delete(); N.delete(); D.delete(); }
          if (!out || !solidsOf(out).length) throw new Error('The draft could not be made');
          replaceSolid(rec, unify(out), f.id);
          res.notes[f.id] = `${hits.length} face${hits.length === 1 ? '' : 's'} drafted ${ang}°`;
          break;
        }
        case 'rib': {
          // Rib: an open sketch thickened and run out until it meets the model, in the sketch plane
          // (parallel) or square to it (normal)
          const s = sketches.get(f.sketch);
          if (!s) throw new Error('Select an open sketch for the rib (a line from face to face)');
          if (!body) throw new Error('There is no body for the rib to join');
          const t = ev(f.thickness);
          if (!(t > 0)) throw new Error('The thickness must be greater than zero');
          const fr = s.frame, n = unit(fr.n), L = 2 * bbox(body).diag + 10;
          const P3 = (q) => S.fromFrame2D(fr, q[0], q[1]);
          const runs = [];
          for (const ch of S.curveChains(s.sk)) {
            for (const g of S.chainSegs(s.sk, ch)) {
              if (g.type === 'line') { runs.push([g.a, g.b]); continue; }
              let pts = [];
              if (g.type === 'bezier') pts = Array.from({ length: 9 }, (_, i) => S.bezierAt(g, i / 8));
              else if (g.type === 'arc' && g.m) {
                const C = S.circleThrough(g.a, g.b, g.m);
                if (!C) { runs.push([g.a, g.b]); continue; }
                const a0 = Math.atan2(g.a[1] - C.cy, g.a[0] - C.cx), am = Math.atan2(g.m[1] - C.cy, g.m[0] - C.cx), a1 = Math.atan2(g.b[1] - C.cy, g.b[0] - C.cx);
                let sp = a1 - a0, sm = am - a0;
                const norm = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
                sp = norm(sp); sm = norm(sm);
                if (sm > sp) sp -= 2 * Math.PI;
                pts = Array.from({ length: 9 }, (_, i) => [C.cx + C.r * Math.cos(a0 + (sp * i) / 8), C.cy + C.r * Math.sin(a0 + (sp * i) / 8)]);
              } else continue;
              for (let i = 0; i + 1 < pts.length; i++) runs.push([pts[i], pts[i + 1]]);
            }
          }
          if (!runs.length) throw new Error('The sketch has no lines for the rib');
          const prism = (poly, v) => R.basicFaceExtrusion(R.makePolygon(poly), new R.Vector(v));
          const parts = [];
          for (const [a, b] of runs) {
            const A = P3(a), B = P3(b), u = unit(sub(B, A)), w = unit(cross(n, u)), M = mul(add(A, B), 0.5);
            const signs = f.flip ? [-1, 1] : [1, -1];
            let got = null;
            for (const sg of signs) {
              let tool, d;
              if (f.ribDir === 'normal') {
                d = mul(n, sg);
                tool = prism([add(A, mul(w, -t / 2)), add(B, mul(w, -t / 2)), add(B, mul(w, t / 2)), add(A, mul(w, t / 2))], mul(d, L));
              } else {
                d = mul(w, sg);
                const lo = mul(n, -t / 2);
                tool = prism([add(A, lo), add(B, lo), add(add(B, mul(d, L)), lo), add(add(A, mul(d, L)), lo)], mul(n, t));
              }
              // the piece next to the sketch line, short of the far end (closed in by the model)
              const q = new R.DistanceQuery(R.makeVertex(add(M, mul(d, 1e-3 * t))));
              const pcs = solidsOf(tool.cut(body)).filter((pc) => q.distanceTo(pc) < 1e-6);
              const ok = pcs.filter((pc) => {
                const bb = bbox(pc), corners = [0, 1, 2, 3, 4, 5, 6, 7].map((m) => [m & 1 ? bb.max[0] : bb.min[0], m & 2 ? bb.max[1] : bb.min[1], m & 4 ? bb.max[2] : bb.min[2]]);
                return Math.max(...corners.map((c) => dot(sub(c, M), d))) < 0.9 * L;
              });
              if (ok.length) { got = ok; break; }
            }
            if (!got) throw new Error('The rib is not closed in by the model: draw its line so both ends meet faces of the body (or flip the side)');
            parts.push(...got);
          }
          let tool = parts[0];
          for (const pc of parts.slice(1)) tool = tool.fuse(pc);
          tools.set(f.id, { shape: tool, op: 'add', merge: true, scope: null });
          apply('add', tool, true, null);
          res.notes[f.id] = `${runs.length} segment${runs.length === 1 ? '' : 's'}, ${t} thick, volume ${+parts.reduce((v, pc) => v + R.measureVolume(pc), 0).toFixed(3)}`;
          break;
        }
        case 'dome': {
          // Dome: a rounded cap on flat faces (exact sphere / ellipsoid on a round face, a filled surface on
          // any other outline); reversed it is pressed in
          needEdges('Dome');
          if (!f.faces?.length) throw new Error('Click the flat faces for the dome');
          const h = ev(f.height);
          if (!(h > 0)) throw new Error('The height must be greater than zero');
          for (const r of f.faces) {
            if (!r.n) throw new Error('A dome goes on a flat face');
            const hit = findFaceAny(solids, r);
            if (!hit) throw new Error('A dome face could not be found in the model');
            const n0 = unit(r.n), n = f.reverse ? mul(n0, -1) : n0;
            const wire = hit.face.clone().outerWire(), edges = wire.edges;
            let tool = null;
            if (edges.length === 1 && edges[0].geomType === 'CIRCLE') {
              const e = edges[0], bb = bbox(e), C = mul(add(bb.min, bb.max), 0.5), rr = R.measureLength(e) / (2 * Math.PI);
              const x = unit(cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
              const Q = (rad, ax) => add(add(C, mul(x, rad)), mul(n, ax));
              let arc;
              if (f.elliptical) {
                const pts = Array.from({ length: 13 }, (_, i) => { const th = (i / 12) * (Math.PI / 2); return Q(rr * Math.cos(th), h * Math.sin(th)); });
                arc = R.makeBSplineApproximation(pts.map((q) => new R.Vector(q)));
              } else {
                const Rs = (rr * rr + h * h) / (2 * h), zc = h - Rs, a0 = Math.atan2(-zc, rr), am = (a0 + Math.PI / 2) / 2;
                arc = R.makeThreePointArc(Q(rr, 0), Q(Rs * Math.cos(am), zc + Rs * Math.sin(am)), Q(0, h));
              }
              const prof = R.makeFace(R.assembleWire([R.makeLine(C, Q(rr, 0)), arc, R.makeLine(Q(0, h), C)]));
              tool = R.revolution(prof, C, n, 360);
            } else {
              // a filled surface through the outline, up to the height over the middle of the face
              const oc = R.getOC();
              const mk = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 0.01, 0.1, 8, 9);
              let top;
              try {
                for (const e of edges) mk.Add(e.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
                const ctr = domeCentre(hit.face, wire, r.p, n0);
                const g = new oc.gp_Pnt(...add(ctr, mul(n, h)));
                mk.Add(g);
                mk.Build();
                top = R.cast(mk.Shape());
              } catch (e) { if (isFatal(e)) throw e; throw new Error('The dome surface could not be made over that outline'); } finally { mk.delete(); }
              // the dome takes the face's place in the body (sewn in along the same edges)
              const rec = solids.find((x) => x.id === hit.body.id);
              const keep = rec.shape.faces.filter((x) => !x.isSame(hit.face));
              const sol = solidFromSewn(sewShapes([...keep, top], Math.max(1e-5, bbox(rec.shape).diag * 1e-6)));
              if (!sol) throw new Error('The dome could not be joined to the body (a face with holes, or a dome running into other faces?)');
              replaceSolid(rec, unify(sol), f.id);
              continue;
            }
            if (f.reverse) apply('cut', tool, true, [hit.body.id]);
            else apply('add', tool, true, null);
          }
          res.notes[f.id] = `${f.faces.length} dome${f.faces.length === 1 ? '' : 's'}, ${h} ${f.reverse ? 'deep' : 'high'}`;
          break;
        }
        case 'scale': {
          // Scale: every body (solids and surfaces) by one factor about the origin or their centre
          const k = ev(f.factor);
          if (!(k > 0)) throw new Error('The scale factor must be greater than zero');
          const all = [...solids, ...surfaces];
          if (!all.length) throw new Error('There is no body to scale');
          let ctr = [0, 0, 0];
          if (f.about === 'centroid') { const bb = bboxOfAll(all.map((b) => b.shape)); ctr = mul(add(bb.min, bb.max), 0.5); }
          solids = solids.map((rec) => bodyRec(rec.id, rec.shape.clone().scale(k, ctr), f.id));
          surfaces = surfaces.map((rec) => { const nr = bodyRec(rec.id, rec.shape.clone().scale(k, ctr), f.id); if (rec.mesh) nr.mesh = true; return nr; });
          body = compoundOf(solids);
          res.notes[f.id] = `Scaled ×${k} about ${f.about === 'centroid' ? 'the centre of the bodies' : 'the origin'}`;
          break;
        }
        case 'moveFace': {
          // Move Face: flat faces pushed / pulled along their normal, or turned about an edge
          needEdges('Move Face');
          if (!f.faces?.length) throw new Error('Click the flat faces to move');
          const hits = f.faces.map((r) => findFaceAny(solids, r));
          if (hits.some((h) => !h)) throw new Error('A selected face could not be found in the model');
          if (f.faces.some((r) => !r.n)) throw new Error('Move Face works on flat faces');
          if (f.mode === 'rotate') {
            if (!f.edge) throw new Error('Click the edge to turn the face about (an edge of the face)');
            const ang = ev(f.angle);
            if (!(Math.abs(ang) > 1e-6 && Math.abs(ang) < 89)) throw new Error('The angle must be between 0° and 89°');
            const rec = hits[0].body;
            if (hits.some((h) => h.body !== rec)) throw new Error('The faces must be on the same body');
            const eh = findEdgeInfo(rec.shape, f.edge);
            if (!eh || eh.e.geomType !== 'LINE') throw new Error('The hinge must be a straight edge');
            const a = eh.e.startPoint.toTuple ? eh.e.startPoint.toTuple() : [eh.e.startPoint.x, eh.e.startPoint.y, eh.e.startPoint.z];
            const b = eh.e.endPoint.toTuple ? eh.e.endPoint.toTuple() : [eh.e.endPoint.x, eh.e.endPoint.y, eh.e.endPoint.z];
            const hd = unit(sub(b, a)), fn = unit(f.faces[0].n);
            // pull direction: in the face, square to the hinge, towards the face
            let pd = unit(cross(fn, hd));
            if (dot(sub(f.faces[0].p, a), pd) < 0) pd = mul(pd, -1);
            if (f.reverse) pd = mul(pd, -1);
            const oc = R.getOC();
            const D = new oc.gp_Dir(...pd), P = new oc.gp_Pnt(...a), pln = new oc.gp_Pln(P, D);
            const mk = new oc.BRepOffsetAPI_DraftAngle(rec.shape.wrapped);
            let out = null;
            try {
              for (const h of hits) {
                mk.Add(h.face.wrapped, D, (ang * Math.PI) / 180, pln, true);
                if (!mk.AddDone()) throw new Error('The face cannot turn about that edge');
              }
              mk.Build();
              out = R.cast(mk.Shape());
            } catch (e) { if (isFatal(e)) throw e; throw new Error(e.message?.startsWith('The face') ? e.message : 'The face could not be turned (its neighbours cannot follow it)'); } finally { mk.delete(); pln.delete(); P.delete(); D.delete(); }
            if (!out || !solidsOf(out).length) throw new Error('The face could not be turned');
            replaceSolid(rec, unify(out), f.id);
            break;
          }
          const d = ev(f.distance);
          if (!(Math.abs(d) > 1e-9)) throw new Error('The distance must not be zero');
          for (const [i, h] of hits.entries()) {
            const nn = unit(f.faces[i].n);
            const tool = R.basicFaceExtrusion(h.face, new R.Vector(mul(nn, d)));
            const rec = solids.find((x) => x.id === h.body.id);
            if (!rec) continue;
            const out = d > 0 ? rec.shape.fuse(tool) : rec.shape.cut(tool);
            if (!solidsOf(out).length) throw new Error('Moving the face removed the whole body');
            replaceSolid(rec, unify(out), f.id);
          }
          res.notes[f.id] = `${hits.length} face${hits.length === 1 ? '' : 's'} moved ${d > 0 ? 'out' : 'in'} ${Math.abs(d)}`;
          break;
        }
        case 'asmCut': {
          // a rectangular cut made in an assembly (asmcuts.js): rectangles at points, w along u, l across, cut
          // along d (into the material) through all or to a depth
          if (!body) throw new Error('There is no body to cut');
          const through = f.end !== 'blind', bb = bbox(body);
          let tool = null;
          for (const c of f.cuts || []) {
            if (!(c.w > 0 && c.l > 0)) throw new Error('The cut needs a width and a length');
            const d = unit(c.d), v = unit(cross(d, c.u)), u = cross(v, d);
            const depth = through ? 2 * bb.diag + 1 + len(sub(c.o, bb.center)) : ev(f.depth);
            if (!(depth > 0)) throw new Error('The cut depth must be greater than zero');
            const o = sub(c.o, mul(d, 0.05));
            const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b2]) => add(o, add(mul(u, (a * c.w) / 2), mul(v, (b2 * c.l) / 2))));
            const one = R.basicFaceExtrusion(R.makePolygon(corners), new R.Vector(mul(d, depth + 0.05)));
            tool = tool ? tool.fuse(one) : one;
          }
          if (!tool) throw new Error('The cut has no position');
          tools.set(f.id, { shape: tool, op: 'cut', merge: true, scope: null });
          apply('cut', tool, true, null);
          res.features[f.id] = {};
          res.notes[f.id] = `${f.cuts.length} cut${f.cuts.length === 1 ? '' : 's'} made in the assembly${through ? ', through all' : ''}`;
          break;
        }
        case 'boss':
        case 'snapHook': {
          // Plastic part features at points (clicked on flat faces, or a sketch's points / circle centres), rising out of
          // the face along its normal (reverse: the other way). boss: a post outerD across, height high, its wall drafted
          // by draft, a hole holeD × holeDepth down from its top, ribs (count, ribWidth, ribLength, ribHeight) out from
          // its foot. snapHook: a beam (thickness across, width wide, length high) with a hook at its tip, overhang out,
          // its lead-in at insertAngle from the beam and its catch at retainAngle (90: square); turned angle about the
          // normal from the face's X direction
          const locs = [];
          if (f.sketch) {
            const s = sketches.get(f.sketch);
            if (!s) throw new Error('The placement sketch is missing, suppressed or has errors');
            const used = new Set(s.sk.curves.flatMap((c) => [c.p1, c.p2, ...(c.pts || [])]).filter(Boolean));
            const centres = new Set(s.sk.curves.filter((c) => (c.type === 'circle' || c.type === 'arc') && !c.construction).map((c) => c.c));
            for (const pt of s.sk.points) if (pt.id !== 'O' && (centres.has(pt.id) || !used.has(pt.id))) locs.push({ p: S.fromFrame2D(s.frame, pt.x, pt.y), n: mul(s.frame.n, f.reverse ? -1 : 1) });
          }
          for (const fc of f.faces || []) if (fc.n) locs.push({ p: fc.p, n: mul(unit(fc.n), f.reverse ? -1 : 1) });
          if (!locs.length) throw new Error('Click points on a flat face for them, or select a sketch with points on the face');
          if (!body) throw new Error('There is no body to put them on');
          const poly = (fr, pts) => R.makePolygon(pts.map(([x, y]) => add(add(fr.o, mul(fr.x, x)), mul(fr.z, y))));
          let tool = null;
          for (const { p, n } of locs) {
            const base = frameOnPlane(p, n), a = ((ev(f.angle ?? 0) || 0) * Math.PI) / 180;
            const X = add(mul(base.u, Math.cos(a)), mul(base.v, Math.sin(a))), Y = cross(n, X);
            let one;
            if (f.type === 'boss') {
              const D = ev(f.outerD), H = ev(f.height), d = ev(f.holeD ?? 0), hd = f.holeDepth === '' || f.holeDepth == null ? H : ev(f.holeDepth), dr = ev(f.draft ?? 0);
              if (!(D > 0 && H > 0)) throw new Error('The boss needs a diameter and a height');
              if (!(d >= 0 && d < D)) throw new Error('The boss’s hole must be narrower than the boss');
              if (!(hd > 0 && hd <= H + 1e-9) && d > 0) throw new Error('The boss’s hole depth must be more than zero and no more than its height');
              if (!(dr >= 0 && dr < 45)) throw new Error('The boss’s draft must be from 0° to 45°');
              const R0 = D / 2, Rt = R0 - H * Math.tan((dr * Math.PI) / 180);
              if (!(Rt > d / 2 + 1e-6)) throw new Error('The boss’s draft leaves no wall round its hole at the top');
              const fr = { o: p, x: X, z: n };
              one = R.revolution(poly(fr, [[0, -0.05], [R0, -0.05], [R0, 0], [Rt, H], [0, H]]), p, n, 360);
              const nr = Math.round(ev(f.ribs ?? 0) || 0);
              if (nr > 0) {
                const w = ev(f.ribWidth), L = ev(f.ribLength), h = ev(f.ribHeight ?? H * 0.75);
                if (!(w > 0 && L > 0 && h > 0 && h <= H)) throw new Error('The ribs need a width, a length out from the boss and a height up to the boss’s');
                for (let i = 0; i < nr; i++) {
                  const t = (2 * Math.PI * i) / nr, rx = add(mul(X, Math.cos(t)), mul(Y, Math.sin(t))), side = cross(n, rx), rf = { o: add(p, mul(side, -w / 2)), x: rx, z: n };
                  const tri = poly(rf, [[0, -0.05], [R0 + L, -0.05], [R0 + L, 0], [R0 - h * Math.tan((dr * Math.PI) / 180), h], [0, h]]);
                  const v = new R.Vector(mul(side, w));
                  try { one = one.fuse(R.basicFaceExtrusion(tri, v)); } finally { v.delete(); }
                }
              }
              if (d > 0) one = one.cut(R.revolution(poly(fr, [[0, H + 0.05], [d / 2, H + 0.05], [d / 2, H - hd], [0, H - hd]]), p, n, 360));
            } else {
              const L = ev(f.length), t = ev(f.thickness), w = ev(f.width), h = ev(f.overhang), ai = ev(f.insertAngle ?? 30), ar = ev(f.retainAngle ?? 90);
              if (!(L > 0 && t > 0 && w > 0 && h > 0)) throw new Error('The snap hook needs a length, a thickness, a width and an overhang');
              if (!(ai > 0 && ai < 90) || !(ar > 0 && ar <= 90)) throw new Error('The snap hook’s lead-in angle must be between 0° and 90°, its catch angle above 0° and up to 90°');
              const hh = h / Math.tan((ai * Math.PI) / 180), dd = ar >= 90 ? 0 : h / Math.tan((ar * Math.PI) / 180);
              if (!(hh + dd < L - 1e-6)) throw new Error('The hook is taller than the beam: make the beam longer or the lead-in steeper');
              const fr = { o: add(p, mul(Y, -w / 2)), x: X, z: n };
              const prof = poly(fr, [[-t / 2, -0.05], [t / 2, -0.05], [t / 2, L - hh - dd], [t / 2 + h, L - hh], [t / 2, L], [-t / 2, L]]);
              const v = new R.Vector(mul(Y, w));
              try { one = R.basicFaceExtrusion(prof, v); } finally { v.delete(); }
            }
            tool = tool ? tool.fuse(one) : one;
          }
          tools.set(f.id, { shape: tool, op: 'add', merge: true, scope: null });
          apply('add', tool, true, null);
          res.features[f.id] = { faces: f.faces || [] };
          res.notes[f.id] = `${locs.length} ${f.type === 'boss' ? 'boss' : 'snap hook'}${locs.length === 1 ? '' : f.type === 'boss' ? 'es' : 's'}`;
          break;
        }
        case 'mold': {
          // Core and cavity: a block round the part (margin beyond it every way), the part grown by shrink % (the plastic
          // shrinks as it cools) taken out of it, split by a parting plane square to the pull direction: at the part's
          // largest section along it (parting 'auto'), or at partingAt from the part's lowest point. The half the pull
          // direction points into is the cavity, the other the core; holes along the pull become shut-offs where the
          // plane crosses them. keepPart: the part stays as a body too
          const rec = solids.length === 1 ? solids[0] : solids.find((s) => s.id === f.body);
          if (!rec) throw new Error(solids.length ? 'Choose the body to make the mould for' : 'There is no part to make a mould for');
          const AX = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, key = f.dir || 'y', d = key.startsWith('-') ? mul(AX[key[1]], -1) : AX[key];
          const margin = ev(f.margin ?? 10), shrink = ev(f.shrink ?? 0) / 100;
          if (!(margin > 0)) throw new Error('The block margin must be more than zero');
          if (!(shrink > -0.5 && shrink < 0.5)) throw new Error('The shrinkage must be a few per cent');
          const b0 = bbox(rec.shape), c0 = b0.center;
          let part = rec.shape.clone();
          if (Math.abs(shrink) > 1e-12) part = part.scale(1 + shrink, c0);
          const b = bbox(part), corners = [];
          for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) corners.push([x, y, z]);
          const lo = Math.min(...corners.map((q) => dot(q, d))), hi = Math.max(...corners.map((q) => dot(q, d)));
          let h;
          if ((f.parting || 'auto') === 'at') h = lo + ev(f.partingAt);
          else {
            // (the largest section: the part's area in slabs across the pull direction, the middle of the largest run)
            const u = unit(cross(d, Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), big = b.diag + 10, N = 40, areas = [];
            for (let i = 0; i < N; i++) {
              const t = lo + ((i + 0.5) * (hi - lo)) / N, slab = R.drawRectangle(2 * big, 2 * big).sketchOnPlane(new R.Plane(add(mul(d, t - 1e-3), sub(c0, mul(d, dot(c0, d)))), u, d)).extrude(2e-3);
              let a = 0; try { a = Math.abs(R.measureVolume(part.intersect(slab))) / 2e-3; } catch (e) { if (isFatal(e)) throw e; } finally { slab.delete(); }
              areas.push(a);
            }
            const top = Math.max(...areas), runs = areas.map((a) => a >= top * (1 - 1e-6));
            const first = runs.indexOf(true), last = runs.lastIndexOf(true);
            h = lo + ((first + last + 1) / 2 / N) * (hi - lo);
          }
          if (!(h > lo + 1e-6 && h < hi - 1e-6)) throw new Error('The parting plane must cross the part');
          const ub = unit(cross(d, Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), vb = cross(d, ub);
          const spans = (v) => [Math.min(...corners.map((q) => dot(q, v))) - margin, Math.max(...corners.map((q) => dot(q, v))) + margin];
          const [u0, u1] = spans(ub), [v0, v1] = spans(vb), base = (t) => add(add(mul(ub, (u0 + u1) / 2), mul(vb, (v0 + v1) / 2)), mul(d, t));
          const half = (t0, t1) => R.drawRectangle(u1 - u0, v1 - v0).sketchOnPlane(new R.Plane(base(t0), ub, d)).extrude(t1 - t0);
          const cavity = half(h, hi + margin).cut(part), core = half(lo - margin, h).cut(part);
          const recs = [bodyRec(newId(f.id + 'cav'), cavity, f.id), bodyRec(newId(f.id + 'core'), core, f.id)];
          recs[0].name = 'Cavity'; recs[1].name = 'Core';
          if (f.keepPart === false) solids = solids.filter((s) => s !== rec);
          solids.push(...recs);
          body = compoundOf(solids);
          applied.push({ op: 'add', tool: cavity }, { op: 'add', tool: core });
          res.notes[f.id] = `Core and cavity, parting ${+(h - lo).toFixed(3)} mm up the part along the pull${shrink ? `, ${+(shrink * 100).toFixed(3)} % shrinkage` : ''}`;
          break;
        }
        case 'lipGroove': {
          // A lip (raised) or a groove (sunk) along a flat rim face (a shelled part's open edge): the band of the face
          // width wide along its inner edge (side 'inner') or its outer one, raised height or sunk that deep
          if (!f.face?.n) throw new Error('Click the flat rim face for the lip or groove');
          const hit = findFaceAny(solids, f.face);
          if (!hit || hit.face.geomType !== 'PLANE') throw new Error('The rim face could not be found (a flat face)');
          const w = ev(f.width), h = ev(f.height);
          if (!(w > 0 && h > 0)) throw new Error('The lip or groove needs a width and a height');
          const n = unit(vec(hit.face.normalAt())), outer = hit.face.clone().outerWire(), inners = hit.face.clone().innerWires();
          const area = (wire) => { const fc = R.makeFace(wire.clone()); try { return R.measureArea(fc); } finally { fc.delete(); } };
          let band;
          if ((f.side || 'inner') === 'inner') {
            if (!inners.length) throw new Error('The rim face has no inner edge (choose the outer side)');
            const inner = inners[0], a0 = area(inner);
            // (the inner edge offset out into the face)
            const bigger = [w, -w].map((d) => { try { return inner.clone().offset2D(d, 'intersection'); } catch (e) { if (isFatal(e)) throw e; return null; } }).filter(Boolean).sort((x, y) => area(y) - area(x))[0];
            if (!bigger || !(area(bigger) > a0)) throw new Error('The lip is wider than the rim');
            band = R.addHolesInFace(R.makeFace(bigger), [inner]);
          } else {
            const a0 = area(outer);
            const smaller = [w, -w].map((d) => { try { return outer.clone().offset2D(d, 'intersection'); } catch (e) { if (isFatal(e)) throw e; return null; } }).filter(Boolean).sort((x, y) => area(x) - area(y))[0];
            if (!smaller || !(area(smaller) < a0)) throw new Error('The lip is wider than the rim');
            band = R.addHolesInFace(R.makeFace(outer), [smaller]);
          }
          // (the band must lie on the rim face)
          const onRim = Math.abs(R.measureArea(band) - R.measureArea(boolByList('common', band, [hit.face]))) < 1e-6 * R.measureArea(band);
          if (!onRim) throw new Error('The band runs off the rim face: make the lip narrower');
          const groove = f.kind === 'groove', v = new R.Vector(mul(n, groove ? -(h + 0.05) : h + 0.05));
          let tool;
          try { tool = R.basicFaceExtrusion(groove ? band.clone().translate(mul(n, 0.05)) : band.clone().translate(mul(n, -0.05)), v); } finally { v.delete(); }
          tools.set(f.id, { shape: tool, op: groove ? 'cut' : 'add', merge: true, scope: null });
          apply(groove ? 'cut' : 'add', tool, true, null);
          res.features[f.id] = { face: f.face };
          break;
        }
        case 'vent': {
          // A vent: slots slotWidth wide, barWidth apart, at angle, across a sketch's closed outline kept margin in from
          // it, cut depth deep into the body (through: right through), along the sketch's normal (reverse: the other way)
          const sk = getSketch(f.sketch);
          if (!sk.drawing) throw new Error('The vent sketch needs a closed outline');
          const sw = ev(f.slotWidth), bw = ev(f.barWidth), m = ev(f.margin ?? 0), ang = ev(f.angle ?? 0) || 0;
          if (!(sw > 0 && bw > 0 && m >= 0)) throw new Error('The vent needs a slot width and a bar width (and a margin of zero or more)');
          let zone = m > 0 ? sk.drawing.offset(-m) : sk.drawing;
          const pts = sk.regions.flatMap((r) => r.outer.poly), cx = pts.reduce((s, q) => s + q[0], 0) / pts.length, cy = pts.reduce((s, q) => s + q[1], 0) / pts.length;
          const span = 2 * Math.max(...pts.map((q) => Math.hypot(q[0] - cx, q[1] - cy))) + 2 * (sw + bw), pitch = sw + bw, count = Math.ceil(span / pitch) + 1;
          let strips = null;
          for (let i = 0; i < count; i++) {
            const off = (i - (count - 1) / 2) * pitch, rect = R.drawRectangle(span, sw).translate(0, off).rotate(ang, [0, 0]).translate(cx, cy);
            strips = strips ? strips.fuse(rect) : rect;
          }
          const slots = zone.intersect(strips);
          const n = mul(sk.frame.n, f.reverse ? 1 : -1), through = f.end === 'through';
          const bb = body ? bbox(body) : null, depth = through ? 2 * (bb?.diag || 100) + len(sub(bb?.center || [0, 0, 0], sk.frame.o)) : ev(f.depth);
          if (!(depth > 0)) throw new Error('The vent depth must be greater than zero');
          const start = through ? add(sk.frame.o, mul(n, -depth / 2)) : add(sk.frame.o, mul(n, -0.05));
          const tool = slots.sketchOnPlane(rPlane(sk.frame, start)).extrude((through ? depth : depth + 0.05) * (dot(n, sk.frame.n) > 0 ? 1 : -1));
          tools.set(f.id, { shape: tool, op: 'cut', merge: true, scope: null });
          apply('cut', tool, true, null);
          break;
        }
        case 'hole': {
          // Hole: simple, counterbored, countersunk or tapped holes at sketch points / circle centres
          // or clicked points on a flat face, square into the material
          const spec = holeSpec(f, ev);
          if (!(spec.d > 0)) throw new Error('The hole diameter must be greater than zero');
          if (spec.type === 'cbore' && !(spec.cbD > spec.d && spec.cbDepth > 0)) throw new Error('The counterbore must be wider than the hole and have a depth');
          if (spec.type === 'csink' && !(spec.csD > spec.d && spec.csAng > 0 && spec.csAng < 180)) throw new Error('The countersink must be wider than the hole, at an angle between 0° and 180°');
          if (spec.type === 'cdrill' && !(spec.cdD > spec.d && spec.cdDepth > 0 && spec.cdAng > 0 && spec.cdAng < 180)) throw new Error('The counterdrill must be wider than the hole, have a depth, and a point angle between 0° and 180°');
          const locs = [];
          if (f.sketch) {
            const s = sketches.get(f.sketch);
            if (!s) throw new Error('The placement sketch is missing, suppressed or has errors');
            const P3 = (id) => { const q = S.getPoint(s.sk, id); return S.fromFrame2D(s.frame, q.x, q.y); };
            const used = new Set(s.sk.curves.flatMap((c) => [c.p1, c.p2, ...(c.pts || [])]).filter(Boolean));
            const centres = new Set(s.sk.curves.filter((c) => (c.type === 'circle' || c.type === 'arc') && !c.construction).map((c) => c.c));
            const dir = mul(s.frame.n, f.reverse ? 1 : -1);
            for (const pt of s.sk.points) if (pt.id !== 'O' && (centres.has(pt.id) || !used.has(pt.id))) locs.push({ p: P3(pt.id), dir });
          }
          for (const fc of f.faces || []) {
            if (fc.n) { locs.push({ p: fc.p, dir: mul(unit(fc.n), f.reverse ? 1 : -1) }); continue; }
            // (a point on a curved face: moved onto it, the hole square to it there)
            if (!body) break;
            const hit = findFaceAny(solids, fc);
            if (!hit) throw new Error('A hole’s face could not be found in the model');
            const oc = R.getOC(), g = new oc.gp_Pnt(...fc.p), mv = new oc.BRepBuilderAPI_MakeVertex(g), dq = new oc.BRepExtrema_DistShapeShape();
            let q = fc.p;
            try { dq.LoadS1(mv.Vertex()); dq.LoadS2(hit.face.wrapped); dq.Perform(); if (dq.IsDone() && dq.NbSolution() > 0) { const t = dq.PointOnShape2(1); q = [t.X(), t.Y(), t.Z()]; t.delete?.(); } } finally { dq.delete(); mv.delete(); g.delete(); }
            locs.push({ p: q, dir: mul(unit(vec(hit.face.normalAt(q))), f.reverse ? 1 : -1) });
          }
          if (!locs.length) throw new Error('Click points on a face for the holes, or select a sketch with points (or circles) on the face');
          if (!body) throw new Error('There is no body to put holes in');
          // ends: blind, through (all), upToNext (where the axis first leaves the material), upToSurface /
          // offsetSurface (toPlane / toFace, toOffset, toFlip) and upToVertex (toPoint / toVertex): a depth for each hole
          const end = f.end || 'blind';
          if (!['blind', 'through', 'upToNext', 'upToSurface', 'offsetSurface', 'upToVertex'].includes(end)) throw new Error('Select a supported hole end');
          const through = end === 'through';
          const bb = bbox(body), far = 2 * bb.diag + 1 + Math.max(0, ...locs.map((l) => len(sub(l.p, bb.center))));
          // (where the axis runs in the material: the pieces of it inside the body, [from, to] along it)
          const runs = ({ p, dir }) => {
            const e = R.makeLine(add(p, mul(dir, -1e-3)), add(p, mul(dir, far))), parts = [];
            try {
              const inside = boolByList('common', e, [body]);
              for (const piece of inside.edges) { const a = dot(sub(vec(piece.startPoint), p), dir), b = dot(sub(vec(piece.endPoint), p), dir); parts.push([Math.min(a, b), Math.max(a, b)]); }
            } finally { e.delete(); }
            return parts.sort((x, y) => x[0] - y[0]);
          };
          let endPlane = null;
          if (end === 'upToSurface' || end === 'offsetSurface') {
            endPlane = resolveSurface(f.toPlane, f.toFace);
            if (f.toFace) res.features[f.id] = { ...(res.features[f.id] || {}), toFace: f.toFace };
          }
          const depthOf = (loc) => {
            if (through) return far;
            if (end === 'blind') return ev(f.depth);
            if (end === 'upToNext') {
              const r = runs(loc).filter(([, b]) => b > 1e-6);
              if (!r.length) throw new Error('A hole does not go into the material (Up To Next: reverse it?)');
              return r[0][1];
            }
            if (end === 'upToVertex') return dot(sub(resolvePoint(f.toPoint, f.toVertex), loc.p), loc.dir);
            const c = dot(loc.dir, endPlane.n);
            if (Math.abs(c) < 1e-9) throw new Error('The end surface is parallel to the hole');
            let d = dot(sub(endPlane.p, loc.p), endPlane.n) / c;
            if (end === 'offsetSurface') d -= ev(f.toOffset ?? 0) * (f.toFlip ? -1 : 1);
            return d;
          };
          const depths = locs.map(depthOf);
          if (depths.some((d) => !(d > 0))) throw new Error(end === 'blind' ? 'The hole depth must be greater than zero' : 'A hole’s end lies behind where it starts (reverse it, or choose another end)');
          const depth = depths[0];
          if (spec.type === 'cbore' && depths.some((d) => d <= spec.cbDepth)) throw new Error('The hole must be deeper than its counterbore');
          if (spec.type === 'cdrill' && depths.some((d) => d <= spec.cdDepth + (spec.cdD - spec.d) / 2 / Math.tan((spec.cdAng * Math.PI) / 360))) throw new Error('The hole must be deeper than its counterdrill');
          // (a drill point at a blind hole's end, of drillAngle; open ends go a hair past where they leave the material,
          // less than half way to where it starts again)
          const point = end === 'blind' && f.drillPoint !== false, pointAngle = ev(f.drillAngle ?? 118);
          if (point && !(pointAngle > 0 && pointAngle < 180)) throw new Error('The drill point angle must be between 0° and 180°');
          const over = (loc, d) => { if (end !== 'upToNext') return 0; const next = runs(loc).find(([a]) => a > d + 1e-6); return Math.min(0.05, next ? (next[0] - d) / 2 : 0.05); };
          // (far-side countersink: a cone at the far side, where the hole leaves the material: the first wall for Up To
          // Next, the last for Through All)
          const farSink = f.farCsink && (through || end === 'upToNext') ? { D: ev(f.farCsinkD), ang: ev(f.farCsinkAngle ?? 90) } : null;
          if (farSink && !(farSink.D > spec.d && farSink.ang > 0 && farSink.ang < 180)) throw new Error('The far-side countersink must be wider than the hole, at an angle between 0° and 180°');
          const slot = spec.type === 'slot';
          let tool = null;
          locs.forEach((loc, i) => {
            const { p, dir } = loc, u = unit(cross(dir, Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), d = depths[i] + over(loc, depths[i]);
            let one;
            if (slot) {
              // (a slot: two half circles of the hole's diameter joined, slotLength between their centres, turned slotAngle
              // about the hole's axis from the face's X direction, as a sketch on it has it)
              const L = ev(f.slotLength), w = spec.d / 2, a = (ev(f.slotAngle ?? 0) * Math.PI) / 180, fr = frameOnPlane(p, mul(dir, -1)), x = add(mul(fr.u, Math.cos(a)), mul(fr.v, Math.sin(a)));
              if (!(L >= 0)) throw new Error('The slot length must be zero or more');
              const outline = L > 1e-9 ? R.draw([-L / 2, -w]).lineTo([L / 2, -w]).threePointsArcTo([L / 2, w], [L / 2 + w, 0]).lineTo([-L / 2, w]).threePointsArcTo([-L / 2, -w], [-L / 2 - w, 0]).close() : R.drawCircle(w);
              one = outline.sketchOnPlane(new R.Plane(add(p, mul(dir, -0.05)), x, dir)).extrude(d + 0.05);
            } else {
              const prof = holeProfile(spec, d, point, pointAngle);
              one = R.revolution(R.makePolygon(prof.map(([r, z]) => add(add(p, mul(u, r)), mul(dir, z)))), p, dir, 360);
            }
            if (farSink) {
              const r = runs(loc).filter(([, b]) => b > 1e-6), exit = (end === 'upToNext' ? r[0] : r.at(-1))?.[1];
              if (exit != null) {
                const rc = farSink.D / 2, rr = spec.d / 2, h = (rc - rr) / Math.tan((farSink.ang * Math.PI) / 360);
                const cone = [[0, exit - h], [rr, exit - h], [rc + 0.05 * Math.tan((farSink.ang * Math.PI) / 360), exit + 0.05], [0, exit + 0.05]];
                one = one.fuse(R.revolution(R.makePolygon(cone.map(([r2, z]) => add(add(p, mul(u, r2)), mul(dir, z)))), p, dir, 360));
              }
            }
            tool = tool ? tool.fuse(one) : one;
          });
          tools.set(f.id, { shape: tool, op: 'cut', merge: true, scope: null });
          apply('cut', tool, true, null);
          res.features[f.id] = { ...(res.features[f.id] || {}), faces: f.faces || [], holes: locs.map((l) => ({ p: l.p, dir: l.dir })), spec: spec.label, sizes: { type: spec.type, d: spec.d, cbD: spec.cbD, cbDepth: spec.cbDepth, csD: spec.csD, csAng: spec.csAng }, through, depth: through ? null : depth, thread: spec.thread ? { label: spec.thread.label, depth: f.threadDepth === '' || f.threadDepth == null ? null : ev(f.threadDepth) } : null };
          res.notes[f.id] = `${locs.length} ${slot ? 'slot' : 'hole'}${locs.length === 1 ? '' : 's'}: ${spec.label}${through ? ', through all' : end === 'upToNext' ? ', up to the next face' : `, ${+depth.toFixed(3)} deep`}${farSink ? `, far-side countersink Ø${+farSink.D.toFixed(3)}` : ''}${spec.thread ? ' (cosmetic thread: add Thread Cut on the hole for a modelled one)' : ''}`;
          // a tapped hole's thread, shown like a cosmetic thread: as deep as asked, else the bore in the material
          if (spec.thread) {
            const th = spec.thread, D1 = minorDiameter(th.D, th.P), tDepth = f.threadDepth === '' || f.threadDepth == null ? null : ev(f.threadDepth);
            res.threads[f.id] = locs.map(({ p, dir }) => {
              let len = tDepth;
              if (!(len > 0)) {
                // (where the bore leaves the material: the far end of its wall)
                const u = unit(cross(dir, Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
                const wall = findFaceAny(solids, { p: add(add(p, mul(dir, Math.min(0.05, depth / 4))), mul(u, spec.d / 2)) });
                let far = through ? 0 : depth;
                if (wall) for (const e of wall.face.edges) for (const k of [0, 0.5, 1]) far = Math.max(far, dot(sub(vec(e.pointAt(k)), p), dir));
                len = through ? far : Math.min(depth, far || depth);
              }
              return { internal: true, o: p, d: dir, len, full: true, r: spec.d / 2, D: th.D, D1, P: th.P, label: th.label };
            }).filter((t) => t.len > 1e-6);
          }
          break;
        }
        case 'smProfileFlange': {
          // a flange of several segments (lengths / angles) along the picked edges, corners mitred
          needEdges('Profile flange');
          if (!f.edges?.length) throw new Error('Click the edges to add the flange to (straight edges on the top or bottom face of the sheet)');
          const { rec, edges } = sheetEdges(f.edges);
          res.features[f.id] = { edges: f.edges };
          const sheet = sheetChecked(rec);
          const R0 = f.useDefaultRadius !== false ? sheet.R : ev(f.radius);
          if (!(R0 > 0)) throw new Error('The bend radius must be greater than zero');
          const n = Math.max(1, Math.min(4, Math.round(+f.segments || 1)));
          const segs = Array.from({ length: n }, (_, i) => ({ L: ev(f['len' + (i + 1)]), ang: ev(f['ang' + (i + 1)]) }));
          const out = SM.addProfileFlanges(sheet, edges, segs, { R: R0, position: f.position || 'inside', flip: !!f.flip, gap: f.corner === 'open' ? null : ev(f.cornerGap ?? 0.1), relief: { type: f.reliefType || 'rect', ratio: ev(f.reliefRatio ?? 0.5) } });
          setSheet(rec, out);
          res.notes[f.id] = `${n} segment${n === 1 ? '' : 's'} on ${edges.length} edge${edges.length === 1 ? '' : 's'}: ${out.bends.length - sheet.bends.length} bends`;
          break;
        }
        case 'smForm': {
          // dimples / extruded holes at sketch points or clicked points, louvers on sketch lines
          const kind = f.formType || 'dimple', flip = !!f.flip;
          const par = kind === 'dimple' ? { D: ev(f.diameter), h: ev(f.depth) }
            : kind === 'louver' ? { W: ev(f.width), H: ev(f.height), side: !!f.side }
              : { D: ev(f.holeDiameter), h: ev(f.collarHeight), R: f.useDefaultRadius !== false ? 0 : ev(f.radius) };
          const items = [];
          if (f.sketch) {
            const s = sketches.get(f.sketch);
            if (!s) throw new Error('The placement sketch is missing, suppressed or has errors');
            const P3 = (id) => { const q = S.getPoint(s.sk, id); return S.fromFrame2D(s.frame, q.x, q.y); };
            if (kind === 'louver') {
              for (const c of s.sk.curves) if (c.type === 'line' && !c.construction) items.push({ kind, line: { a: P3(c.p1), b: P3(c.p2) }, ...par, flip });
            } else {
              // circle centres, and points of their own (not the ends of lines or arcs)
              const used = new Set(s.sk.curves.flatMap((c) => [c.p1, c.p2, ...(c.pts || [])]).filter(Boolean));
              const at = new Set(s.sk.curves.filter((c) => c.type === 'circle' && !c.construction).map((c) => c.c));
              for (const pt of s.sk.points) if (pt.id !== 'O' && (at.has(pt.id) || !used.has(pt.id))) items.push({ kind, p: P3(pt.id), ...par, flip });
            }
          }
          if (kind !== 'louver') for (const fc of f.faces || []) items.push({ kind, p: fc.p, ...par, flip });
          if (!items.length) throw new Error(kind === 'louver' ? 'Select a sketch with lines on a face of the sheet: each line is a louver\'s slit' : 'Click points on a flat face of the sheet, or select a sketch with points (or circles) on it');
          const first = items[0];
          const rec = sheetRecs().find((r) => !r.sheet.stale && (first.line ? SM.lineOnSheet(r.sheet, first.line.a, first.line.b) : SM.pointOnSheet(r.sheet, first.p)));
          if (!rec) throw new Error('The form is not on a flat face of a sheet metal body');
          setSheet(rec, SM.addForms(sheetChecked(rec), items));
          res.features[f.id] = { faces: f.faces || [] };
          res.notes[f.id] = `${items.length} ${{ dimple: 'dimple', louver: 'louver', exthole: 'extruded hole' }[kind]}${items.length === 1 ? '' : 's'}`;
          break;
        }
        case 'smGusset': {
          // a stiffening dart across a bend at each clicked point on its round face
          if (!f.faces?.length) throw new Error('Click a bend (its round face) where each gusset goes');
          const rec = sheetRecs().find((r) => !r.sheet.stale && SM.onBend(r.sheet, f.faces[0].p));
          if (!rec) throw new Error('Click on a bend (its round face) of a sheet metal body');
          setSheet(rec, SM.addForms(sheetChecked(rec), f.faces.map((fc) => ({ kind: 'gusset', p: fc.p, L: ev(f.size), w: ev(f.width) }))));
          res.features[f.id] = { faces: f.faces };
          res.notes[f.id] = `${f.faces.length} gusset${f.faces.length === 1 ? '' : 's'}`;
          break;
        }
        case 'smTabSlot': {
          // tabs on an edge of one sheet metal part, slots through the face of the other where they meet
          if (!f.edge) throw new Error('Click the edge of the part that gets the tabs (where it meets the other part)');
          if (!f.face) throw new Error('Now click the face of the other part that gets the slots');
          needEdges('Tab and slot');
          const { rec: A, edges } = sheetEdges([f.edge]);
          const B = sheetRecs().find((r) => r !== A && !r.sheet.stale && SM.pointOnSheet(r.sheet, f.face.p));
          if (!B) throw new Error('The slot face must be a flat face of another sheet metal body');
          res.features[f.id] = { edges: [f.edge] };
          const opt = (v) => (v === '' || v == null ? null : ev(v));
          const out = SM.addTabsSlots(sheetChecked(A), edges[0], sheetChecked(B), { count: ev(f.count), length: ev(f.length), height: opt(f.height) ?? 0, clearance: ev(f.clearance ?? 0.1), margin: opt(f.margin) });
          setSheet(A, out.a);
          setSheet(B, out.b);
          res.notes[f.id] = `${out.starts.length} tab${out.starts.length === 1 ? '' : 's'} ${+ev(f.length).toFixed(3)} × ${+out.h.toFixed(3)} mm, slots ${+ev(f.clearance ?? 0.1).toFixed(3)} mm clearance`;
          break;
        }
        case 'smCrossBreak': {
          // an X of shallow folds across each picked flat face: marks in the flat pattern and DXF
          if (!f.faces?.length) throw new Error('Click the flat faces of the sheet to cross break');
          let rec = null;
          f.faces.forEach((fc, i) => {
            const r = sheetRecs().find((x) => !x.sheet.stale && SM.pointOnSheet(x.sheet, fc.p));
            if (!r) throw new Error(`Face ${i + 1} is not a flat face of a sheet metal body`);
            if (rec && r !== rec) throw new Error('Pick faces of one sheet metal body at a time');
            rec = r;
          });
          const out = SM.addCrossBreaks(sheetChecked(rec), f.faces.map((x) => x.p), { up: !f.flip });
          setSheet(rec, out);
          res.features[f.id] = { faces: f.faces };
          res.notes[f.id] = `${f.faces.length} cross break${f.faces.length === 1 ? '' : 's'} (in the flat pattern and DXF)`;
          break;
        }
        case 'smEtch': {
          // lines marked on the sheet (etched or scribed: part numbers, bend marks, outlines): the sketch's curves
          // and text, drawn on a flat face of the sheet, kept as marks in the flat pattern and its DXF (ETCH)
          if (!f.sketch) throw new Error('Select the sketch with the etch lines or text, drawn on a flat face of the sheet');
          const s = sketches.get(f.sketch);
          if (!s) throw new Error('The sketch is missing, suppressed or has errors');
          const polys = [];
          const arcPts = (c, r, a0, sweep, n) => Array.from({ length: n + 1 }, (_, i) => { const t = a0 + (sweep * i) / n; return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]; });
          for (const ch of S.curveChains(s.sk)) for (const g of S.chainSegs(s.sk, ch)) {
            if (g.type === 'line') polys.push([g.a, g.b]);
            else if (g.type === 'circle') polys.push(arcPts(g.c, g.r, 0, 2 * Math.PI, 64));
            else if (g.type === 'arc') {
              // (the circle through its ends and middle; the way round that passes the middle)
              const C = S.circleThrough(g.a, g.m, g.b);
              if (!C) { polys.push([g.a, g.b]); continue; }
              const c = [C.cx, C.cy], r = C.r, ang = (p) => Math.atan2(p[1] - c[1], p[0] - c[0]);
              const a0 = ang(g.a), am = ang(g.m), a1 = ang(g.b), norm = (x) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
              let sweep = norm(a1 - a0);
              if (norm(am - a0) > sweep) sweep -= 2 * Math.PI;
              polys.push(arcPts(c, r, a0, sweep, Math.max(8, Math.ceil(Math.abs(sweep) * 12))));
            } else if (g.type === 'bezier') {
              polys.push(Array.from({ length: 17 }, (_, i) => { const t = i / 16, u = 1 - t; return [0, 1].map((k) => u * u * u * g.a[k] + 3 * u * u * t * g.c1[k] + 3 * u * t * t * g.c2[k] + t * t * t * g.b[k]); }));
            }
          }
          for (const list of Object.values(textOutlines(s.sk.texts || []))) for (const pl of list) polys.push(pl);
          if (!polys.length) throw new Error('The sketch has no curves or text to etch');
          const P3 = polys.map((pl) => pl.map(([x, y]) => S.fromFrame2D(s.frame, x, y)));
          const rec = sheetRecs().find((r) => !r.sheet.stale && P3.some((pl) => pl.some((p) => SM.pointOnSheet(r.sheet, p))));
          if (!rec) throw new Error('The etch sketch is not on a sheet metal body: draw it on the top or bottom face of a flat part of the sheet');
          const out = SM.addEtch(sheetChecked(rec), P3, f.id);
          if (!out.count) throw new Error('The etch lines are all off the face they were drawn on');
          // (the solid stays as it is, and keeps its name: only its flat pattern gets the marks; a new record, as the
          // rebuild cache's earlier states hold the old one)
          solids = solids.map((x) => (x === rec ? { ...rec, sheet: out.sheet } : x));
          body = compoundOf(solids);
          res.curves[f.id] = P3;
          res.notes[f.id] = `${out.count} etch line segment${out.count === 1 ? '' : 's'} in the flat pattern and DXF`;
          break;
        }
        case 'smSketchBend':
        case 'smJog': {
          // bend lines drawn on a flat face of a sheet metal body (a jog: one line, two opposite bends)
          const jog = f.type === 'smJog';
          if (!f.sketch) throw new Error(`Select the sketch with the ${jog ? 'jog line' : 'bend line(s)'}, drawn on a flat face of the sheet`);
          const s = sketches.get(f.sketch);
          if (!s) throw new Error('The sketch is missing, suppressed or has errors');
          const lines = s.sk.curves.filter((c) => c.type === 'line' && !c.construction);
          if (!lines.length) throw new Error(`Draw ${jog ? 'the jog line' : 'the bend line(s)'} in the sketch (straight lines on the sheet's face)`);
          if (jog && lines.length !== 1) throw new Error('A jog is made from one line: keep one line in the sketch');
          const segs = lines.map((c) => { const p = S.getPoint(s.sk, c.p1), q = S.getPoint(s.sk, c.p2); return { a: S.fromFrame2D(s.frame, p.x, p.y), b: S.fromFrame2D(s.frame, q.x, q.y) }; });
          const rec = sheetRecs().find((r) => !r.sheet.stale && SM.lineOnSheet(r.sheet, segs[0].a, segs[0].b));
          if (!rec) throw new Error('The line is not on a flat face of a sheet metal body: draw the sketch on the top or bottom face of the sheet');
          const sheet = sheetChecked(rec);
          const R0 = f.useDefaultRadius !== false ? sheet.R : ev(f.radius);
          const common = { angle: ev(f.angle ?? 90), R: R0, position: f.position || (jog ? 'start' : 'center'), flip: !!f.flip, swapFixed: !!f.swapFixed };
          const out = jog ? SM.addJog(sheet, segs[0], { ...common, height: ev(f.height), ref: f.heightRef || 'face' }) : SM.addSketchedBends(sheet, segs, common);
          setSheet(rec, out);
          res.notes[f.id] = jog ? `Two ${+ev(f.angle ?? 90).toFixed(2)}° bends, ${+out.jogFlat.toFixed(3)} mm of flat between them` : `${segs.length} bend${segs.length === 1 ? '' : 's'}`;
          break;
        }
        case 'smExtrude': {
          // sheet metal extruded from an open sketch profile (drawn arcs are bends; sharp corners get the bend
          // radius) or a lone circle (rolled, with a seam gap)
          if (!f.sketch) throw new Error('Select the sketch: an open chain of lines / arcs, or a circle');
          const s = sketches.get(f.sketch);
          if (!s) throw new Error('The sketch is missing, suppressed or has errors');
          const chains = S.curveChains(s.sk);
          if (chains.length !== 1) throw new Error(`The sketch must hold one chain of lines / arcs joined end to end, or one circle (it has ${chains.length || 'none'})`);
          const segs = S.chainSegs(s.sk, chains[0]);
          if (chains[0].closed && !(segs.length === 1 && segs[0].type === 'circle')) throw new Error('The profile is closed: leave a gap where the seam goes (only a lone circle is rolled closed, with its seam gap)');
          const t = ev(f.thickness), R0 = ev(f.radius), K = sheetKFactor(f, R0, t), depth = ev(f.depth);
          if (!(R0 >= 0)) throw new Error('The bend radius can\'t be negative');
          if (!(depth > 0)) throw new Error('The depth must be greater than zero');
          const [z0, z1] = f.direction === 'mid' ? [-depth / 2, depth / 2] : f.direction === 'reverse' ? [-depth, 0] : [0, depth];
          const out = SM.extrudedSheet(segs, { frame: s.frame, z0, z1, t, K, R: R0, side: f.side || 'one', gap: ev(f.seamGap ?? 0.5) });
          const shape = SM.toSolid(out.sheet);
          const rec = bodyRec(newId(f.id), shape, f.id);
          rec.sheet = out.sheet;
          solids.push(rec);
          body = compoundOf(solids);
          applied.push({ op: 'add', tool: shape });
          const pl = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
          res.notes[f.id] = out.rolled ? 'Rolled from flat (a cylinder with its seam gap)' : !out.sheet.bends.length ? 'A flat plate (no bends)' : [out.drawn ? pl(out.drawn, 'drawn bend') : '', out.corners ? `${pl(out.corners, 'bend')} at sharp corners` : ''].filter(Boolean).join(' · ');
          break;
        }
        case 'smTransition': {
          // a transition / reducer: two ends (round or a polygon) on the axis of a sketch line (bottom centre
          // to top centre: its length is the height), in equal parts, each a sheet metal body of its own
          if (!f.sketch) throw new Error('Select the sketch with the axis line (or sketch one: bottom centre to top centre)');
          const s = sketches.get(f.sketch);
          if (!s) throw new Error('The sketch is missing, suppressed or has errors');
          const lines = s.sk.curves.filter((c) => c.type === 'line'), solid = lines.filter((c) => !c.construction);
          const line = lines.length === 1 ? lines[0] : solid.length === 1 ? solid[0] : null;
          if (!line) throw new Error(lines.length ? 'The sketch has more than one line: keep one line for the axis (bottom centre to top centre)' : 'Draw a line in the sketch from the bottom centre to the top centre (its length is the height)');
          const q1 = S.getPoint(s.sk, line.p1), q2 = S.getPoint(s.sk, line.p2), fr = s.frame;
          const W3 = (q) => add(add(fr.o, mul(fr.u, q.x)), mul(fr.v, q.y));
          let o = W3(q1), tp = W3(q2);
          if (f.reverse) [o, tp] = [tp, o];
          const h = len(sub(tp, o));
          if (!(h > 1e-6)) throw new Error('The axis line has no length');
          const d = unit(sub(tp, o));
          // X: in the sketch plane, square to the line; turned about the axis by the rotation
          const X0 = unit(cross(d, fr.n)), Y0 = cross(d, X0), rot = (ev(f.rotation ?? 0) * Math.PI) / 180;
          const X = add(mul(X0, Math.cos(rot)), mul(Y0, Math.sin(rot))), Y = cross(d, X);
          const t = ev(f.thickness), R0 = ev(f.radius ?? 0), K = sheetKFactor(f, R0, t);
          if (!(t > 0)) throw new Error('The thickness must be greater than zero');
          const spec = (k) => ({ shape: f[k + 'Shape'], d: ev(f[k + 'D']), w: ev(f[k + 'W']), l: ev(f[k + 'L']), size: ev(f[k + 'Size']), basis: f[k + 'Basis'] });
          const raw = [SM.transitionEnd(spec('b')), SM.transitionEnd(spec('t'))];
          // the sizes are of the inside (material outward), the outside (material inward) or the middle of
          // the thickness (the outside surface half a thickness out, across the slope of the wall)
          const dims = f.dims || 'inside';
          const rEq = (e) => (e.kind === 'round' ? e.r : e.corners.reduce((a, c) => a + Math.hypot(c[0], c[1]), 0) / e.M);
          const slope = Math.hypot(h, rEq(raw[0]) - rEq(raw[1])) / h;
          const grow = dims === 'mean' ? (t / 2) * slope : 0;
          const [bot, top] = grow ? [SM.transitionEnd(spec('b'), grow), SM.transitionEnd(spec('t'), grow)] : raw;
          const bent = f.method === 'bent', rr = bot.kind === 'round' && top.kind === 'round';
          // bent: one fold per division; formed: the surface finer (a whole number of facets a line) and the
          // division count the forming lines in the flat pattern
          const nLines = Math.round(ev(rr ? f.divsRound ?? 24 : f.divs ?? 6));
          if (!(nLines >= 1 && nLines <= 200)) throw new Error(bent ? 'The number of bends must be 1 to 200' : 'The number of forming lines must be 1 to 200');
          const perLine = bent ? 1 : Math.max(1, Math.ceil((rr ? 96 : 16) / nLines)), div = nLines * perLine;
          const pieces = SM.transitionParts({
            o, d, X, Y, h, bot, top, off: [ev(f.offX ?? 0), ev(f.offY ?? 0)], parts: ev(f.parts), seamAt: f.seamAt || 'mid',
            seamShift: !!f.seamShift, seamAngle: (ev(f.seamAngle ?? 0) * Math.PI) / 180, div, gap: ev(f.seamGap ?? 0),
          });
          let nb = 0;
          for (const pc of pieces) {
            const sheet = SM.loftedSheet(pc.A, pc.B, { t, K, R: R0, method: bent ? 'bent' : 'formed', side: dims === 'inside' ? 1 : -1, breaks: pc.breaks });
            if (!bent) sheet.lofted.bendLines = SM.formLines(sheet.lofted, { breaks: pc.breaks });
            nb += sheet.lofted.bendLines.length;
            const shape = SM.toSolid(sheet);
            const rec = bodyRec(newId(f.id), shape, f.id);
            rec.sheet = sheet;
            solids.push(rec);
            applied.push({ op: 'add', tool: shape });
          }
          body = compoundOf(solids);
          const n = pieces.length;
          res.notes[f.id] = `${n} part${n === 1 ? '' : 's'}, height ${+h.toFixed(3)} mm` + (bent ? ` · ${nb / n} bend${nb / n === 1 ? '' : 's'} a part` : ` · formed (rolled)${nb ? `, ${nb / n} sharp fold${nb / n === 1 ? '' : 's'} a part` : ''}`);
          break;
        }
        case 'smHem': {
          needEdges('Hem');
          if (!f.edges?.length) throw new Error('Click the edges to hem (straight edges on the top or bottom face of the sheet)');
          const { rec, edges } = sheetEdges(f.edges);
          res.features[f.id] = { edges: f.edges };
          const sheet = sheetChecked(rec);
          const out = SM.addHems(sheet, edges, {
            type: f.hemType || 'closed', length: ev(f.length), gap: ev(f.gap ?? 0), R: ev(f.radius ?? 1), angle: f.hemType === 'teardrop' ? ev(f.tearAngle ?? 225) : ev(f.angle ?? 270),
            position: f.position || 'inside', flip: !!f.flip, relief: { type: f.reliefType || 'rect', ratio: ev(f.reliefRatio ?? 0.5) },
          });
          setSheet(rec, out);
          break;
        }
        case 'smFlange': {
          needEdges('Edge flange');
          if (!f.edges?.length) throw new Error('Click the edges to add flanges to (straight edges on the top or bottom face of the sheet)');
          const { rec, edges } = sheetEdges(f.edges);
          res.features[f.id] = { edges: f.edges };
          const sheet = sheetChecked(rec);
          const R0 = f.useDefaultRadius !== false ? sheet.R : ev(f.radius);
          if (!(R0 > 0)) throw new Error('The bend radius must be greater than zero');
          let out = SM.addFlanges(sheet, edges, {
            length: ev(f.length), lengthRef: f.lengthRef, angle: ev(f.angle), position: f.position, offset: ev(f.offset || 0),
            R: R0, flip: !!f.flip, relief: { type: f.reliefType || 'rect', ratio: ev(f.reliefRatio ?? 0.5) },
            extent: { type: f.widthType || 'full', a: ev(f.startOffset ?? 0), b: ev(f.endOffset ?? 0), width: ev(f.flangeWidth ?? 0), swap: !!f.swapEnds },
          });
          // corners between these flanges: closed with the gap (older parts: open)
          if ((f.corner === 'closed' || f.corner === 'butt' || f.corner === 'square') && edges.length > 1) {
            const gap = ev(f.cornerGap ?? 0.1);
            if (!(gap >= 0)) throw new Error('The corner gap can\'t be negative');
            const only = new Set(out.bends.slice(sheet.bends.length).map((b) => b.id));
            out = SM.closedCorner(out, { gap, swap: !!f.cornerSwap, only, quiet: true, type: f.corner === 'closed' ? 'overlap' : f.corner, bend: f.cornerBend || 'vcut' });
            if (out.cornerCount) res.notes[f.id] = `${out.cornerCount} corner${out.cornerCount === 1 ? '' : 's'} closed`;
          }
          setSheet(rec, out);
          break;
        }
        case 'smCornerRelief': {
          const rec = sheetOf(f.body);
          const out = SM.cornerRelief(sheetChecked(rec), { type: f.reliefType || 'rect', size: ev(f.size) });
          setSheet(rec, out);
          res.notes[f.id] = `${out.cornerCount} corner${out.cornerCount === 1 ? '' : 's'}`;
          break;
        }
        case 'smClosedCorner': {
          // picked flange faces: each closes the corner nearest to it (the matching flange is found);
          // none picked: every corner of the body
          let rec = null, picks = null;
          if (f.faces?.length) {
            picks = [];
            f.faces.forEach((fc, i) => {
              let best = null;
              for (const r of sheetRecs()) {
                if (!r.sheet || r.sheet.flat) continue;
                const c = SM.cornerAt(r.sheet, fc.p);
                if (c && (!best || c.dist < best.c.dist)) best = { r, c };
              }
              if (!best || best.c.dist > Math.max(0.5, best.r.sheet.t)) throw new Error(`Corner ${i + 1}: click a face of a flange next to a corner`);
              if (rec && best.r !== rec) throw new Error('Pick corners on one sheet metal body at a time');
              rec = best.r;
              picks.push(best.c);
            });
          } else rec = sheetOf(f.body);
          const gap = ev(f.gap || 0);
          if (!(gap >= 0)) throw new Error('The gap can\'t be negative');
          const out = SM.closedCorner(sheetChecked(rec), { gap, swap: !!f.swap, type: f.cornerType || 'overlap', picks, bend: f.bendCorner || 'vcut' });
          setSheet(rec, out);
          res.notes[f.id] = `${out.cornerCount} corner${out.cornerCount === 1 ? '' : 's'} closed`;
          break;
        }
        case 'smUnfold': {
          let rec, pt = null;
          if (f.face) {
            const hit = findFaceAny(sheetRecs(), f.face);
            if (!hit) throw new Error('The fixed face could not be found on a sheet metal body');
            rec = hit.body; pt = f.face.p;
          } else rec = sheetOf(f.body);
          setSheet(rec, SM.unfoldSheet(sheetChecked(rec), pt));
          break;
        }
        case 'smFold': {
          const recs = f.body ? [sheetOf(f.body)] : sheetRecs().filter((r) => r.sheet.flat);
          if (!recs.length) throw new Error('No sheet metal body is unbent (use Unbend first)');
          for (const rec of recs) {
            if (!rec.sheet.flat) throw new Error('This sheet metal body is not unbent');
            setSheet(rec, SM.refoldSheet(sheetChecked(rec)));
          }
          break;
        }
        case 'smConvert': {
          if (!f.face) throw new Error('Click the face of the body that stays fixed (it becomes the flat reference)');
          // (surfaces first: a face copied from a solid lies on the solid's face)
          const hit = findFaceAny([...surfaces, ...solids], f.face);
          if (!hit) throw new Error('The selected face could not be found');
          const rec = hit.body;
          if (rec.sheet) throw new Error('This body is already sheet metal');
          const isSurface = surfaces.includes(rec);
          // a curved surface is rolled from the flat (its bends follow its own curvature)
          const rolledSurf = isSurface && rec.shape.faces.some((fc) => fc.geomType !== 'PLANE');
          // a solid's thickness and bend radii are read from it unless set instead (autoThickness / autoRadius off)
          const autoT = f.autoThickness !== false, autoR = f.autoRadius !== false;
          const R0 = ev(f.radius), K = ev(f.kFactor);
          if (((isSurface && !rolledSurf) || (!isSurface && !autoR)) && !(R0 > 0)) throw new Error('The bend radius must be greater than zero');
          if (!(K >= 0 && K <= 1)) throw new Error('The K-factor must be between 0 and 1');
          let faces, t;
          const normalOf = (fc) => { const nv = fc.normalAt(); const n = vec(nv); nv.delete?.(); return unit(n); };
          // a surface's thickness goes behind it ('one', against the face normals), in front ('other') or
          // half each side ('mid'); older parts: the Flip tick box
          const thickSide = f.thickSide || (f.flip ? 'other' : 'one');
          let flatSurf = rec.shape, fixedAt = null;
          if (isSurface) {
            res.detected[f.id] = { kind: 'surface', curved: rolledSurf };
            t = ev(f.thickness);
            if (!(t > 0)) throw new Error('The thickness must be greater than zero');
            if (rolledSurf && rec.shape.faces.length > 1) throw new Error('A curved surface can be converted when it is one face: copy just the face you want (Surfaces ▸ Copy Surface) and convert the copy');
            if (!rolledSurf && thickSide === 'mid') {
              // symmetric: the sheet's own side is the surface moved half a thickness forward (its faces still
              // meeting at their edges); the picked face is then the moved face nearest the click
              try { flatSurf = offsetShell(rec.shape, t / 2); } catch { flatSurf = null; }
              if (!flatSurf?.faces?.length) throw new Error('The surface could not be offset by half the thickness: put the thickness on one side');
              const q = new R.DistanceQuery(R.makeVertex(f.face.p));
              try { let bd = Infinity; for (const fc of flatSurf.faces) { const d = q.distanceTo(fc); if (d < bd) { bd = d; fixedAt = fc; } } } finally { q.delete?.(); }
            }
            if (!rolledSurf) faces = flatSurf.faces.map((fc) => {
              if (fc.geomType !== 'PLANE') throw new Error('A surface of flat faces and curved faces together cannot be converted: convert a curved face on its own (copy it with Copy Surface)');
              const n = normalOf(fc);
              return { face: fc, n: thickSide === 'other' ? mul(n, -1) : n };
            });
          }
          let sheet, exact = false, detected = null, rolled = null;
          if (rolledSurf) {
            const tol = ev(f.rollTol ?? SM.ROLL_TOL);
            if (!(tol > 0)) throw new Error('The arc fit tolerance must be greater than zero');
            ({ sheet, rolled } = SM.fromCurvedFace(rec.shape.faces[0], { t, K, side: thickSide, tol, trim: f.trimSelf !== false }));
            res.detected[f.id] = { kind: 'surface', curved: true, ...rolled };
          } else if (isSurface) {
            const fixed = faces.findIndex((x) => x.face.isSame(fixedAt || hit.face));
            if (fixed < 0) throw new Error('Pick a flat face of the sheet (not one of its edge faces)');
            sheet = SM.fromFaces(faces, fixed, { t, R: R0, K });
          } else {
            // a solid: follow the picked side of the sheet through its flat faces and bends
            const tSet = autoT ? null : ev(f.thickness);
            if (!autoT && !(tSet > 0)) throw new Error('The thickness must be greater than zero');
            ({ sheet, exact, detected } = SM.fromSolid(rec.shape, hit.face, { R: R0, K, t: tSet, Rset: autoR ? null : R0 }));
            res.detected[f.id] = detected;
            if (detected.sharp && !(R0 > 0)) throw new Error('The bend radius for sharp edges must be greater than zero');
            t = sheet.t;
          }
          const shape = SM.toSolid(sheet);
          // does the sheet account for the whole body? (only when all its bends are the body's own: sharp
          // edges turned into bends change the corners)
          let match = '';
          if (exact) {
            try {
              const v0 = R.measureVolume(rec.shape), v1 = R.measureVolume(shape), dv = (v1 - v0) / v0;
              if (Math.abs(dv) > 0.005) match = ` · ⚠ ${dv > 0 ? 'more' : 'less'} material than the body (${(dv * 100).toFixed(1)} %): check for features that are not part of the sheet`;
            } catch { /* no check */ }
          }
          if (isSurface) {
            surfaces = surfaces.filter((x) => x !== rec);
            const nr = bodyRec(newId(f.id), shape, f.id);
            nr.sheet = sheet;
            solids.push(nr);
            body = compoundOf(solids);
          } else {
            const recs = replaceSolid(rec, shape, f.id);
            for (const r of recs) r.sheet = sheet;
          }
          applied.push({ op: 'add', tool: shape });
          const set = (auto, what) => (isSurface ? '' : auto ? ` (${what} the body)` : ' (set)');
          const radii = [...new Set(sheet.bends.map((b) => +b.R.toFixed(3)))].map((r) => 'R' + r).join(', ');
          // (radii from the body with a thickness set instead: the picked side's radii are kept, so a bend
          // whose outside was picked has a different inside radius than in the body)
          const sharp = detected?.sharp || 0, formed = detected?.bends || 0;
          const rWhy = isSurface ? '' : !autoR ? ' (set)' : !formed ? ' (sharp edges: the radius set)'
            : `${autoT ? ' (as in the body)' : ' (the picked side\'s bends kept)'}${sharp ? `, sharp edges R${+R0.toFixed(3)}` : ''}`;
          res.notes[f.id] = rolled
            ? `Thickness ${+t.toFixed(4)} mm · rolled: ${rolled.bends} bend${rolled.bends === 1 ? '' : 's'}${rolled.bends ? ` R${+rolled.rMin.toFixed(2)}${rolled.rMax - rolled.rMin > 0.005 ? `–R${+rolled.rMax.toFixed(2)}` : ''}` : ''}${rolled.straight ? ` + ${rolled.straight} straight run${rolled.straight === 1 ? '' : 's'}` : ''}, following the surface to within ${rolled.tol} mm${rolled.trimmed?.at ? ` · trimmed back ${+rolled.trimmed.length.toFixed(2)} mm at its ${rolled.trimmed.at} (it would run into itself)` : rolled.trimmed?.overlaps ? ' · ⚠ the sheet runs into itself (tick "Trim where it would run into itself")' : ''}`
            : detected?.developed
              ? `Thickness ${+t.toFixed(4)} mm${set(autoT, 'from')} · unrolled: ${detected.developed} curved face${detected.developed === 1 ? '' : 's'} laid flat at the neutral layer (K ${+K.toFixed(3)})${match}`
              : `Thickness ${+t.toFixed(4)} mm${set(autoT, 'from')} · ${sheet.bends.length} bend${sheet.bends.length === 1 ? '' : 's'}${radii ? ` ${radii}${rWhy}` : ''}${match}`;
          break;
        }
        case 'axis': {
          if(f.referenceDefinition&&!f.referenceLegacy){const {solved}=referenceDatum(f),value=solved.value;axes.set(f.id,value);res.axes[f.id]=value;break;}
          let o, d;
          if (f.axisType === 'twoPlanes') {
            const A = resolveFrame(f.planeA), B = resolveFrame(f.planeB);
            const n1 = A.n, n2 = B.n, h1 = dot(n1, A.o), h2 = dot(n2, B.o);
            d = cross(n1, n2);
            const det = dot(n1, n1) * dot(n2, n2) - dot(n1, n2) ** 2;
            if (len(d) < 1e-9 || det < 1e-12) throw new Error('The two planes are parallel');
            o = add(mul(n1, (h1 * dot(n2, n2) - h2 * dot(n1, n2)) / det), mul(n2, (h2 * dot(n1, n1) - h1 * dot(n1, n2)) / det));
          } else if (f.axisType === 'twoPoints') {
            const a = resolvePoint(f.pointA), b = resolvePoint(f.pointB);
            o = a; d = sub(b, a);
            if (len(d) < 1e-9) throw new Error('The two points coincide');
          } else if (f.axisType === 'edge') {
            if (!f.edge) throw new Error('Select a straight or circular edge on the model');
            needEdges('Axis from an edge');
            const e = findEdge(body, f.edge);
            if (!e) throw new Error('The selected edge could not be found in the model');
            updateEdgeRef(f.edge, e, body);
            res.features[f.id] = { edge: f.edge };
            const g = edgeGeom(e, bbox(body).diag);
            if (g?.type === 'line') { o = g.a; d = sub(g.b, g.a); }
            else if (g?.type === 'circle' || g?.type === 'arc') { o = g.c; d = g.normal; }
            else throw new Error('Select a straight or circular edge');
          } else if (f.axisType === 'cylinder') {
            if (!f.face) throw new Error('Click a cylindrical or conical face on the model');
            const hit = findFaceAny([...solids, ...surfaces], f.face);
            if (!hit) throw new Error('The selected face could not be found in the model');
            const ax = faceAxis(hit.face);
            if (!ax) throw new Error('Select a cylindrical or conical face');
            const c = vec(hit.face.center); // centre the axis on the face
            o = add(ax.o, mul(ax.d, dot(sub(c, ax.o), ax.d)));
            d = ax.d;
          } else if (f.axisType === 'sketchLine') {
            const [fid, cid] = String(f.sketchLine || '').split(':');
            const s = sketches.get(fid);
            const c = s && S.getCurve(s.sk, cid);
            if (!c || c.type !== 'line') throw new Error('Select a sketch line');
            const p1 = S.getPoint(s.sk, c.p1), p2 = S.getPoint(s.sk, c.p2);
            o = S.fromFrame2D(s.frame, p1.x, p1.y); d = sub(S.fromFrame2D(s.frame, p2.x, p2.y), o);
          } else throw new Error('Choose how to define the axis');
          if(len(d)<1e-9)throw new Error('The selected axis direction has zero length');
          d = mul(d, 1 / len(d));
          axes.set(f.id, { o, d });
          res.axes[f.id] = { o, d };
          if(f.referenceLegacy)(res.info ||= {})[f.id]={datum:{status:'defined',dof:0,alternatives:1,legacy:true},datumSignature:JSON.stringify(f)};
          break;
        }
        case 'point': {
          if(f.referenceDefinition&&f.pointType!=='coords'){const {solved}=referenceDatum(f);points.set(f.id,solved.value);res.points[f.id]=solved.value;break;}
          let p;
          if (f.pointType === 'coords') {
            try{p=[ev(f.x),ev(f.y),ev(f.z)];if(!p.every(Number.isFinite))throw new Error('Point coordinates must be finite');
              if(f.referenceDefinition)(res.info ||= {})[f.id]={datum:{status:'defined',dof:0,alternatives:1},datumSignature:JSON.stringify(f)};
            }catch(e){if(f.referenceDefinition)(res.info ||= {})[f.id]={datum:{status:'conflict',message:e.message},datumSignature:JSON.stringify(f)};throw e;}
          }
          else if (f.pointType === 'vertex') p = resolvePoint(null, f.vertex);
          else if (f.pointType === 'arcCenter' || f.pointType === 'edgeMid') {
            if (!f.edge) throw new Error('Select an edge on the model');
            needEdges('Point from an edge');
            const e = findEdge(body, f.edge);
            if (!e) throw new Error('The selected edge could not be found in the model');
            updateEdgeRef(f.edge, e, body);
            if (f.pointType === 'edgeMid') p = vec(e.pointAt(0.5));
            else {
              const g = edgeGeom(e, bbox(body).diag);
              if (g?.type !== 'circle' && g?.type !== 'arc') throw new Error('Select a circular edge (arc or circle)');
              p = g.c;
            }
          } else throw new Error('Choose how to define the point');
          if (f.vertex || f.edge) res.features[f.id] = { vertex: f.vertex, edge: f.edge };
          points.set(f.id, p);
          res.points[f.id] = p;
          break;
        }
      }
      };
      await runFeature(f);
    } catch (e) {
      // a broken kernel is not a feature error: stop, so the worker is replaced and the rebuild retried
      if (isFatal(e)) throw e;
      if(f.referenceDefinition&&res.info?.[f.id]?.datum?.status!=='under')(res.info ||= {})[f.id]={datum:{status:'conflict',message:e.message},datumSignature:JSON.stringify(f)};
      resetStack();
      // OpenCascade failures arrive as WebAssembly exceptions (or numbers) without a message
      const raw = typeof e === 'number' || (typeof WebAssembly !== 'undefined' && WebAssembly.Exception && e instanceof WebAssembly.Exception) || !e?.message;
      const hint = { shell: ' — try a smaller thickness (inward shells fail where a fillet radius is smaller than the wall), or remove different faces',
        thicken: ' — try a smaller thickness', surfOffset: ' — try a smaller distance', split: ' — check that the tool cuts right through the bodies' }[f.type] || '';
      res.errors.push([f.id, raw ? `The geometry kernel could not compute this ${f.type === 'moveBody' ? 'move' : 'feature'}${hint}` : e.message]);
    }
    noteRefs(f, res);
    timing.features.push([f.name, Math.round(performance.now() - tf)]);
    // any other feature that changes the solid ends the run of blends
    if (body !== bodyIn && f.type !== 'fillet' && f.type !== 'chamfer') blendChain = null;
    // a blend recomputed in a different order replays the features in between; only boolean
    // features (and blends) can be replayed that way
    if (body !== bodyIn) steps.push({ before: bodyIn, applied: [...applied], blend: blendStep, opaque: !blendStep && (!['extrude', 'revolve', 'lpattern', 'cpattern', 'mirror'].includes(f.type) || f.op === 'intersect') });
    if (body !== bodyIn) featureDiffs.set(f.id, { before: bodyIn, after: body });
    if (f.id === previewId) {
      // show the model as it was before this feature, with the feature's effect as a preview
      const tp = performance.now();
      try { res.preview = makePreview(f, bodyIn, body, applied, blendPair); } catch (e) { if (isFatal(e)) throw e; res.preview = null; }
      timing.preview = performance.now() - tp;
      body = bodyIn;
      solids = solidsIn;
      surfaces = surfacesIn;
      break;
    }
    if (entries) entries[fi] = { id: f.id, json: fjson[fi], snap: takeSnap() };
  }
  // (Kernel Lab: the waiting folds made; the last feature's saved state then holds the folded body)
  if (labFlushSheets()) {
    const k = entries ? entries.length - 1 : -1;
    if (k >= 0 && entries[k]) entries[k] = { ...entries[k], snap: takeSnap() };
  }
  // (the waiting cuts made; the last feature's saved state then holds the body as it is)
  if (pending.length) {
    deferNow = false;
    flushCuts();
    const k = entries ? entries.length - 1 : -1;
    if (k >= 0 && entries[k]) entries[k] = { ...entries[k], snap: takeSnap() };
  }
  deferNow = false;
  if (useCache) rebuildCache = { eqKey, entries };


  // (the context bodies of a part edited in context are references only: left out where the part is used, in an
  // assembly, a drawing or an export)
  const isContext = (s) => contextFeats.has(String(s.id).split(/[.~]/)[0]);
  if ((opts.partial || opts.noContext) && contextFeats.size) {
    solids = solids.filter((s) => !isContext(s));
    surfaces = surfaces.filter((s) => !isContext(s));
    body = solids.length ? compoundOf(solids) : null;
  }
  lastContext = new Set([...solids, ...surfaces].filter(isContext).map((s) => s.id));
  if (opts.partial) return { solids, surfaces, features: res.features, threads: res.threads };
  lastFeatureDiffs = featureDiffs;
  lastSketchBodies = sketchBodies;
  lastFacePts = [];
  lastBody = body;
  lastSolids = solids;
  lastSurfaces = surfaces;
  lastName = doc.name || 'Part';
  const transfer = [];
  if (body || surfaces.length) {
    const parts = [...(solids.length ? solids : body ? [{ id: 'body', shape: body, last: null }] : []).map((x) => ({ ...x, kind: 'solid' })), ...surfaces.map((x) => ({ ...x, kind: 'surface' }))];
    const b = bboxOfAllQuick(parts.map((s) => s.shape));
    // tolerances in steps of 2x, so they (and the cached meshes) only change when the model size really does
    // (opts.coarse: a simplified display mesh, for an assembly's speed mode: the same faces and edges, fewer triangles)
    const tol = 2 ** Math.round(Math.log2(Math.max(0.005, b.diag * (opts.coarse ? 0.005 : 0.0004)))), ang = opts.coarse ? 0.7 : 0.2;
    const diagQ = 2 ** Math.round(Math.log2(Math.max(1e-3, b.diag)));
    // each body is meshed on its own (so every face and edge knows its body), and only when it changed
    timing.meshStart = performance.now();
    progressFeature = null; // (meshing: no one feature to blame)
    // (Kernel Lab 3b: the faces not meshed yet, of all these bodies, meshed in one call first: in parallel with threads.
    // A multi-threaded kernel does that before the mesh helpers, whose quick probe then sees little left to share; a
    // single-thread one asks for helpers first, as before, and premeshes what is left)
    let meshes;
    try {
      if (MULTI) LAB_PREMESHED = labPremesh(parts, tol, diagQ, ang);
      timing.meshHelpers = await meshHelped(parts, tol, diagQ, ang, opts.meshHelp);
      if (!MULTI) LAB_PREMESHED = labPremesh(parts, tol, diagQ, ang);
      meshes = parts.map((s, i) => meshPart(s, tol, diagQ, () => progress(0.8 + (0.2 * i) / parts.length, parts.length > 1 ? `Meshing body ${i + 1} of ${parts.length}…` : 'Meshing…'), ang));
    } finally { LAB_PREMESHED = false; LAB_EXTRACTED = null; }
    const key = `${KERNEL_SESSION}|${tol}|${ang}|` + parts.map((s) => `${shapeId(s.shape)}:${s.id}:${s.kind}:${s.last}`).join('|');
    const dense = meshes.some((m) => m.dense);
    const bodies = [];
    let nv = 0, nt = 0, nf = 0, ne = 0;
    parts.forEach((s, i) => {
      const m = meshes[i];
      // (color / transparency: the look an import gave the body)
      // (meshKey: the same for a body meshed the same as before: the page keeps what it works out from the triangles)
      bodies.push({ id: s.id, kind: s.kind, last: s.last, feats: s.feats, meshKey: `${KERNEL_SESSION}|${tol}|${ang}|${diagQ}|${shapeId(s.shape)}`, sheet: s.sheet ? SM.sheetInfo(s.sheet) : null, member: s.member || null, ...(s.name ? { kname: s.name } : {}), ...(s.look ? { color: s.look.c, transparency: s.look.t } : {}), faceStart: nf, faceCount: m.m.faceGroups.length, triStart: nt, triCount: m.m.triangles.length, edgeStart: ne, edgeCount: m.edges.length });
      for (const pts of m.facePts) lastFacePts.push(pts);
      nv += m.m.vertices.length; nt += m.m.triangles.length; nf += m.m.faceGroups.length; ne += m.edges.length;
    });
    if (opts.haveMesh && opts.haveMesh === key) {
      // the interface already shows exactly this mesh
      res.body = { same: true, key, bodies, dense };
    } else {
      const vertices = new Float32Array(nv), normals = new Float32Array(nv), triangles = new Uint32Array(nt);
      const faceGroups = [], edges = [];
      let ov = 0, ot = 0;
      parts.forEach((s, i) => {
        const { m, gs } = meshes[i];
        vertices.set(m.vertices, ov); normals.set(m.normals, ov);
        const base = ov / 3;
        for (let q = 0; q < m.triangles.length; q++) triangles[ot + q] = m.triangles[q] + base;
        // face groups in index units (replicad may count triangles or indices)
        m.faceGroups.forEach((g, gi) => faceGroups.push({ start: ot + g.start * gs, count: g.count * gs, faceId: g.faceId, ...(meshes[i].surfs?.[gi] ? { surf: meshes[i].surfs[gi] } : {}), ...(meshes[i].faceLooks?.[gi] ? { look: meshes[i].faceLooks[gi] } : {}) }));
        for (const e of meshes[i].edges) edges.push(e);
        ov += m.vertices.length; ot += m.triangles.length;
      });
      res.body = { key, vertices, normals, triangles, faceGroups, edges, dense, bodies };
      transfer.push(vertices.buffer, normals.buffer, triangles.buffer);
    }
    lastDiag = b.diag;
    lastMeshTol = tol;
  } else res.body = null;
  if (res.body) timing.mesh = Math.round(performance.now() - (timing.meshStart ?? performance.now()));
  res.time = performance.now() - t0;
  res.timing = timing;
  return { res, transfer };
}

// Refresh the targets of projected (linked) geometry from their sources.
function updateProjections(f, frame, body, sketches, surfaceShapes = []) {
  let lost = 0;
  const cache = new Map();
  // (the body's size: only worked out when a projection needs it, the exact box is slow on a big body)
  let diagV = null;
  const diag = () => (diagV ??= body ? bbox(body).diag : 100);
  for (const k of f.constraints) {
    if (k.type !== 'projected' || !k.src) continue;
    const src = k.src;
    let prims = null;
    try {
      if (src.kind === 'sketch') {
        const key = 's:' + src.fid + ':' + src.cid + ':' + !!src.spline + ':' + !!src.intersection;
        if (!cache.has(key)) {
          const s = sketches.get(src.fid);
          const c = s && S.getCurve(s.sk, src.cid);
          cache.set(key, c ? (src.intersection ? S.intersectCurve(frame, S.curve3D(s.sk, c, s.frame)) : S.projectCurve(frame, S.curve3D(s.sk, c, s.frame), { preserveSpline: !!src.spline })) : null);
        }
        prims = cache.get(key);
      } else if (src.kind === 'sketchPoint') {
        const s = sketches.get(src.fid);
        const p = s && S.getPoint(s.sk, src.pid);
        prims = p ? [{ type: 'point', p: S.toFrame2D(frame, S.fromFrame2D(s.frame, p.x, p.y)) }] : null;
      } else if (src.kind === 'edge') {
        const key = 'e:' + src.p.join(',');
        if (!cache.has(key)) {
          const e = findEdge(body, src);
          cache.set(key, e ? { e, prims: S.projectCurve(frame, edgeGeom(e, diag())) } : null);
        }
        const hit = cache.get(key);
        if (hit) { prims = hit.prims; updateEdgeRef(src, hit.e, body); }
      } else if (src.kind === 'section') {
        // intersection curves: where the sketch plane cuts the bodies
        if (!cache.has('section')) cache.set('section', sectionPrims([...(body ? solidsOf(body) : []), ...surfaceShapes], frame, diag()));
        prims = cache.get('section');
      } else if (src.kind === 'vertex') {
        const best = findVertex(body, src);
        if (best) {
          src.p = best;
          const b = bbox(body);
          src.box = { min: b.min, max: b.max };
          prims = [{ type: 'point', p: S.toFrame2D(frame, best) }];
        }
      }

    } catch { prims = null; }
    if (!prims || !S.updateProjected(f, k, prims)) lost++;
  }
  if (!lost) S.splitProjectedPoints(f);
  return lost;
}

// Export all bodies, or just one (bodyId). `info` maps body ids to { name, color } so the
// STEP file carries each body's name and material colour.
async function exportBody(format, bodyId = null, info = {}) {
  if (!lastBody && !lastSurfaces.length) throw new Error('There is no body to export');
  let list = [...(lastSolids.length ? lastSolids : lastBody ? [{ id: 'body', shape: lastBody }] : []), ...lastSurfaces];
  if (!bodyId && lastContext.size) list = list.filter((s) => !lastContext.has(s.id));
  if (bodyId) {
    list = list.filter((s) => s.id === bodyId);
    if (!list.length) throw new Error('That body no longer exists');
  }
  // (a part shown Z up: written in its axes, turned +90° about X: RazorCAD's (x, y, z) is the file's (x, −z, y))
  if (docUp === 'z') list = list.map((s) => ({ ...s, shape: s.shape.clone().rotate(90, [0, 0, 0], [1, 0, 0]) }));
  const shape = compoundOf(list);
  let blob;
  if (format === 'step') {
    blob = R.exportSTEP(list.map((s) => ({ shape: s.shape, name: info[s.id]?.name || lastName, ...(info[s.id]?.color ? { color: linearHex(info[s.id].color) } : {}) })), { unit: 'mm' });
  } else if (format === 'obj' || format === '3mf') {
    const parts = list.map((r) => ({ name: info[r.id]?.name || lastName, ...meshArrays(r.shape) }));
    return format === 'obj' ? new TextEncoder().encode(objText(parts)) : threeMF(parts);
  } else {
    const b = bbox(shape);
    blob = shape.blobSTL({ binary: true, tolerance: Math.max(0.002, b.diag * 0.0002), angularTolerance: 0.1 });
  }
  return new Uint8Array(await blob.arrayBuffer());
}

// ------------------------------------------------------------ surfaces, shells, splitting, moving
const ocList = (shapes) => { const L = new (R.getOC()).NCollection_List_TopoDS_Shape(); for (const x of shapes) L.Append(x.wrapped || x); return L; };

// ---- measure
// refs: { kind: 'vertex' | 'point', p } | { kind: 'edge' | 'face', p } | { kind: 'body', id } |
// { kind: 'seg', a, b } (a sketch line) | { kind: 'plane', o, n }. One entity: its size; two:
// the shortest distance between them (with the closest points) and the angle when there is one.
function measureRefs(refs) {
  const all = [...(lastSolids.length ? lastSolids : lastBody ? [{ id: 'body', shape: lastBody }] : []), ...lastSurfaces];
  const allShape = all.length ? compoundOf(all) : null;
  const diag = allShape ? bbox(allShape).diag : 100;
  const dirOf = (g) => (g?.type === 'line' ? unit(sub(g.b, g.a)) : null);
  const item = (r) => {
    if (r.kind === 'vertex' || r.kind === 'point') return { shape: R.makeVertex(r.p), info: { type: 'point', p: r.p } };
    if (r.kind === 'edge') {
      const e = allShape && findEdge(allShape, r);
      if (!e) throw new Error('A selected edge could not be found');
      const g = edgeGeom(e, diag);
      return { shape: e, dir: dirOf(g), info: { type: 'edge', length: R.measureLength(e), curve: g?.type, radius: g?.r ?? null } };
    }
    if (r.kind === 'face') {
      const h = findFaceAny(all, r);
      if (!h) throw new Error('A selected face could not be found');
      const planar = h.face.geomType === 'PLANE';
      const n = planar ? unit(vec(h.face.normalAt())) : null;
      const ax = planar ? null : faceAxis(h.face);
      return { shape: h.face, normal: n, axis: ax, info: { type: 'face', area: finite(faceArea(h.face), () => R.measureArea(h.face)), planar, radius: ax ? radiusOfFace(h.face) : null } };
    }
    if (r.kind === 'body') {
      const b = all.find((x) => x.id === r.id);
      if (!b) throw new Error('A selected body no longer exists');
      const solid = lastSolids.includes(b);
      const x = exactProps([b.shape])[0] || {};
      return { shape: b.shape, info: { type: 'body', solid, volume: solid ? finite(x.volume, () => preciseVolume(b.shape)) : null, area: finite(x.area, () => R.measureArea(b.shape)) } };
    }
    if (r.kind === 'seg') return { shape: R.makeLine(r.a, r.b), dir: unit(sub(r.b, r.a)), info: { type: 'edge', length: len(sub(r.b, r.a)), curve: 'line' } };
    if (r.kind === 'plane') return { shape: planeFace(r.o, r.n), normal: unit(r.n), info: { type: 'plane' } };
    throw new Error('That item cannot be measured');
  };
  const items = refs.map(item);
  const out = { items: items.map((i) => i.info) };
  if (items.length === 2) {
    const oc = R.getOC();
    const pointIndex = refs.findIndex((r) => r.kind === 'point' || r.kind === 'vertex');
    const faceIndex = refs.findIndex((r) => r.kind === 'face');
    const contact = pointIndex >= 0 && faceIndex >= 0 ? nearFacePoint(items[faceIndex].shape, refs[pointIndex].p) : null;
    if (contact) {
      const p = refs[pointIndex].p;
      out.distance = len(sub(p, contact));
      out.a = pointIndex === 0 ? p : contact;
      out.b = pointIndex === 0 ? contact : p;
    } else {
      const t = new oc.BRepExtrema_DistShapeShape();
      try {
        t.LoadS1(items[0].shape.wrapped);
        t.LoadS2(items[1].shape.wrapped);
        t.Perform();
        if (t.IsDone() && t.NbSolution() > 0) {
          const p1 = t.PointOnShape1(1), p2 = t.PointOnShape2(1);
          out.distance = t.Value();
          out.a = [p1.X(), p1.Y(), p1.Z()];
          out.b = [p2.X(), p2.Y(), p2.Z()];
        }
      } finally { t.delete(); }
    }
    // the angle between two lines, two flat faces/planes, or a line and a flat face
    const [A, B] = items;
    const ang = (u, v) => (Math.acos(Math.min(1, Math.abs(dot(u, v)))) * 180) / Math.PI;
    if (A.dir && B.dir) out.angle = ang(A.dir, B.dir);
    else if (A.normal && B.normal) out.angle = ang(A.normal, B.normal);
    else if (A.dir && B.normal) out.angle = 90 - ang(A.dir, B.normal);
    else if (A.normal && B.dir) out.angle = 90 - ang(B.dir, A.normal);
    // centre to centre for two round faces / circular edges
    if (A.axis && B.axis) out.centerDistance = len(rej(sub(B.axis.o, A.axis.o), A.axis.d));
  }
  return out;
}

function radiusOfFace(face) {
  const oc = R.getOC();
  const ad = new oc.BRepAdaptor_Surface(face.wrapped, false);
  try { return face.geomType === 'CYLINDRE' ? ad.Cylinder().Radius() : null; } finally { ad.delete(); }
}

// Sketch frame with its axes turned by `rot` degrees (multiples of 90) about the normal.
function orientFrame(fr, rot) {
  let { o, u, v, n } = fr;
  for (let i = 0; i < ((((rot || 0) / 90) % 4) + 4) % 4; i++) [u, v] = [v, mul(u, -1)];
  return { o, u, v, n };
}

// Curves where a sketch plane cuts solid and surface bodies, as 2D primitives in the sketch.
function sectionPrims(shapes, fr, diag) {
  const oc = R.getOC(), face = planeFace(fr.o, fr.n);
  const out = [];
  for (const s of shapes) {
    let sec = null;
    const op = new oc.BRepAlgoAPI_Section(s.wrapped, face.wrapped, false);
    try { op.Build(new oc.Message_ProgressRange()); if (!op.HasErrors()) sec = R.cast(op.Shape()); } catch (e) { if (isFatal(e)) throw e; } finally { op.delete(); }
    if (sec) for (const e of sec.edges) out.push(...S.projectCurve(fr, edgeGeom(e, diag)));
  }
  return out.filter((g) => g.type !== 'point');
}

// ------------------------------------------------------------ drawings
// Views of a part for a drawing (drawing.js). views: [{ id, dir, up, section: { o, n } | null }]:
// dir points from the model toward the viewer, up is the view's vertical. A section view cuts the
// part with the plane through o with normal n (the part on the n side is removed) and also returns
// the cut faces (for hatching). Output per view, in view coordinates (x right, y up, model mm):
// { edges: [{ k, g }], cut: [[loop, hole loops…]…], box } where k: 'v' visible, 't' visible tangent,
// 'h' hidden, 'ht' hidden tangent, and g: { t: 'l', a, b } | { t: 'c', c, r } | { t: 'a', c, r, a0, a1 }
// (counter-clockwise, radians) | { t: 'p', pts }.
let drawingCache = { key: null, shape: null, solids: [], doc: null };
async function drawingViews(docJson, views) {
  await ensureDrawingCache(docJson);
  const shape = drawingCache.shape;
  if (!shape) throw new Error(drawingCache.doc?.kind === 'assembly' ? 'The assembly has no solid bodies to draw (or all its components are hidden)' : 'The part has no solid body to draw');
  return drawingViewsOf(shape, views);
}
async function ensureDrawingCache(docJson) {
  if (drawingCache.key !== docJson) {
    const doc = JSON.parse(docJson);
    if (doc.kind === 'assembly') {
      const { solids: list, holes, threads } = await assemblySolids(doc);
      drawingCache = { key: docJson, shape: list.length ? compoundOf(list) : null, solids: list, doc, holes, threads };
      return;
    }
    doc.rollbackAt = null;
    const part = await rebuild(doc, null, { partial: true });
    const list = part.solids.length ? part.solids : [];
    // holes made by the Hole feature (for hole callouts)
    const holes = [];
    for (const r of Object.values(part.features || {})) for (const h of r.holes || []) if (r.sizes) holes.push({ p: h.p, dir: h.dir, sizes: r.sizes, through: r.through, depth: r.depth, thread: r.thread });
    const threads = Object.values(part.threads || {}).flat();
    drawingCache = { key: docJson, shape: list.length ? compoundOf(list) : null, solids: list, doc, holes, threads };
  }
}

// An assembly's parts as its components place them, through its sub-assemblies (for drawing views and cut
// lists): every component shown in the configuration the assembly (and each sub-assembly) shows, suppressed and
// hidden ones left out. Each part is built once (by its content, in the configuration used) and its solids are
// placed by location, so a part used many times shares its geometry. Hole callout data are placed with them.
const asmPartsBuilt = new Map(); // part document (as built) → { solids, holes, threads }: the latest few, kept
// A part of an assembly built (key: its document as built, in the configuration used), from the latest few kept.
async function builtPart(key, name, why = 'the drawing') {
  let b = asmPartsBuilt.get(key);
  if (b) return b;
  progress(null, `Building ${name || 'a part'} for ${why}…`);
  const part = await rebuild(JSON.parse(key), null, { partial: true });
  const hs = [];
  for (const r of Object.values(part.features || {})) for (const h of r.holes || []) if (r.sizes) hs.push({ p: h.p, dir: h.dir, sizes: r.sizes, through: r.through, depth: r.depth, thread: r.thread });
  b = { solids: part.solids || [], holes: hs, threads: Object.values(part.threads || {}).flat() };
  asmPartsBuilt.set(key, b);
  while (asmPartsBuilt.size > 60) asmPartsBuilt.delete(asmPartsBuilt.keys().next().value);
  return b;
}
// Two versions of a part compared: the material this version (b) has that the other one (a) doesn't (added), and
// the other way round (removed): their volumes and meshes (to show on the model), and both versions' volumes.
async function compareParts(aJson, bJson) {
  const A = await builtPart(aJson, 'the other version', 'the comparison'), B = await builtPart(bJson, 'this version', 'the comparison');
  progress(null, 'Comparing the two versions…');
  const solidList = (b) => b.solids.filter((r) => r.shape && solidsOf(r.shape).length).map((r) => r.shape);
  const sa = solidList(A), sb = solidList(B);
  const vol = (list) => list.reduce((t, s) => t + solidsOf(s).reduce((u, x) => u + preciseVolume(x), 0), 0);
  const va = vol(sa), vb = vol(sb), tiny = Math.max(1e-6, Math.max(va, vb) * 1e-7);
  // (each body less every body of the other version it reaches)
  const less = (from, minus) => {
    const out = [];
    for (const s of from) {
      let cur = s;
      for (const m of minus) {
        if (!boxesTouch(bbox(cur), bbox(m), 1e-6)) continue;
        try { cur = cur.cut(m); } catch (e) { if (isFatal(e)) throw e; }
      }
      for (const x of solidsOf(cur)) if (R.measureVolume(x) > tiny) out.push(x);
    }
    return out;
  };
  const added = less(sb, sa), removed = less(sa, sb);
  const all = [...sa, ...sb], boxes = all.map((x) => bbox(x));
  const diag = boxes.length ? Math.hypot(...[0, 1, 2].map((k) => Math.max(...boxes.map((b) => b.max[k])) - Math.min(...boxes.map((b) => b.min[k])))) : 1;
  return { volumeA: va, volumeB: vb, added: vol(added), removed: vol(removed), addedPieces: added.length, removedPieces: removed.length,
    mesh: { add: added.length ? meshData(added, diag) : null, remove: removed.length ? meshData(removed, diag) : null } };
}

async function assemblySolids(asm) {
  const oc = R.getOC();
  const built = asmPartsBuilt;
  const solids = [], holes = [], threads = [];
  const cuts = asmPartFeatures(asm); // (the assembly's own holes and cuts, by top component)
  const effIn = (d, c) => {
    const o = (d.activeConfig ? (d.configs || []).find((x) => x.id === d.activeConfig) : null)?.comps?.[c.id] || {};
    return { config: 'config' in o ? o.config : (c.config ?? null), hidden: 'hidden' in o ? o.hidden : !!c.hidden, suppressed: 'suppressed' in o ? o.suppressed : !!c.suppressed };
  };
  // a component's placement as a 3×4 matrix (rows), and two of them combined
  const poseM = (c) => {
    const [x, y, z, w] = c.rot || [0, 0, 0, 1], l = Math.hypot(x, y, z, w) || 1, [qx, qy, qz, qw] = [x / l, y / l, z / l, w / l], p = c.pos || [0, 0, 0];
    return [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw), p[0],
      2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw), p[1],
      2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy), p[2]];
  };
  const mul = (A, B) => {
    const o = new Array(12);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) o[r * 4 + c] = A[r * 4] * B[c] + A[r * 4 + 1] * B[4 + c] + A[r * 4 + 2] * B[8 + c] + (c === 3 ? A[r * 4 + 3] : 0);
    return o;
  };
  const ptM = (M, p) => [0, 1, 2].map((r) => M[r * 4] * p[0] + M[r * 4 + 1] * p[1] + M[r * 4 + 2] * p[2] + M[r * 4 + 3]);
  const dirM = (M, d) => [0, 1, 2].map((r) => M[r * 4] * d[0] + M[r * 4 + 1] * d[1] + M[r * 4 + 2] * d[2]);
  const placed = (shape, M) => {
    const t = new oc.gp_Trsf();
    try {
      t.SetValues(M[0], M[1], M[2], M[3], M[4], M[5], M[6], M[7], M[8], M[9], M[10], M[11]);
      const loc = new oc.TopLoc_Location(t);
      // (Moved(location, raise on a scaled location): the second argument only in newer kernels)
      try { let s; try { s = shape.wrapped.Moved(loc, false); } catch { s = shape.wrapped.Moved(loc); } return R.cast(s); } finally { loc.delete(); }
    } finally { t.delete(); }
  };
  const walk = async (d, M, prefix, depth) => {
    if (depth > 16) return;
    for (const c of d.components || []) {
      const e = effIn(d, c);
      if (e.suppressed || e.hidden) continue;
      const p = (d.parts || []).find((x) => x.id === c.part);
      if (!p?.doc) continue;
      const Mc = mul(M, poseM(c)), cfg = e.config && (p.doc.configs || []).some((x) => x.id === e.config) ? e.config : null;
      if (p.doc.kind === 'assembly') { await walk({ ...p.doc, activeConfig: cfg }, Mc, `${prefix}${c.id}/`, depth + 1); continue; }
      // (a top component cut by the assembly's holes and cuts: its part with them)
      const extra = depth === 0 && cuts.get(c.id);
      const pd = { ...p.doc, activeConfig: cfg, rollbackAt: null, ...(extra ? { features: [...p.doc.features, ...extra] } : {}) };
      const b = await builtPart(JSON.stringify(pd), p.name || pd.name);
      void built;
      for (const s of b.solids) solids.push({ ...s, id: `${prefix}${c.id}/${s.id}`, shape: placed(s.shape, Mc), comp: c.name });
      for (const h of b.holes) holes.push({ ...h, p: ptM(Mc, h.p), dir: dirM(Mc, h.dir) });
      for (const t of b.threads) threads.push({ ...t, o: ptM(Mc, t.o), d: dirM(Mc, t.d) });
    }
  };
  await walk(asm, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], '', 0);
  return { solids, holes, threads };
}
// A colour (#rrggbb, as shown) as the kernel's linear RGB: STEP files hold the colour as shown, and the
// kernel converts its linear values to that when it writes them (given the shown values, it wrote them lighter).
function linearRGB(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
}
// (the same as a hex colour, for the part exporter, which passes hex colours straight on)
const linearHex = (hex) => '#' + linearRGB(hex).map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');

// STEP export of an assembly with its structure: each part once, as a shape of its own in the configuration used
// (with its colour, p.exportColor, and its bodies' own colours); each (sub-)assembly an assembly of its
// components, placed as they are and named after them. Suppressed components are left out.
async function exportAssemblySTEP(docJson) {
  const asm = JSON.parse(docJson);
  const oc = R.getOC();
  const keep = [];
  const str = (s) => { const x = new oc.TCollection_ExtendedString(String(s || ''), true); keep.push(x); return x; };
  const rgb = (hex) => { const [r, g, b] = linearRGB(hex); const x = new oc.Quantity_ColorRGBA(r, g, b, 1); keep.push(x); return x; };
  const doc = new oc.TDocStd_Document(str('XmlOcaf'));
  oc.XCAFDoc_ShapeTool.SetAutoNaming(false);
  const main = doc.Main(), tool = oc.XCAFDoc_DocumentTool.ShapeTool(main), ctool = oc.XCAFDoc_DocumentTool.ColorTool(main);
  const SURF = oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf;
  const effIn = (d, c) => {
    const o = (d.activeConfig ? (d.configs || []).find((x) => x.id === d.activeConfig) : null)?.comps?.[c.id] || {};
    return { config: 'config' in o ? o.config : (c.config ?? null), suppressed: 'suppressed' in o ? o.suppressed : !!c.suppressed };
  };
  // (turn: the assembly shown Z up, written in its axes: each top-level component turned +90° about X with it, so
  // RazorCAD's (x, y, z) is the file's (x, −z, y), as a part's export does)
  const location = (c, turn = false) => {
    const [x, y, z, w] = c.rot || [0, 0, 0, 1], l = Math.hypot(x, y, z, w) || 1, [qx, qy, qz, qw] = [x / l, y / l, z / l, w / l], p = c.pos || [0, 0, 0];
    const t = new oc.gp_Trsf();
    const rows = [[1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw), p[0]],
      [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw), p[1]],
      [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy), p[2]]];
    const [r0, r1, r2] = turn ? [rows[0], rows[2].map((v) => -v), rows[1]] : rows;
    t.SetValues(...r0, ...r1, ...r2);
    keep.push(t);
    const loc = new oc.TopLoc_Location(t);
    keep.push(loc);
    return loc;
  };
  const labels = new Map(); // part / sub-assembly (as used) → its label
  const stats = { parts: 0, assemblies: 0, components: 0 };
  const partLabel = async (p, cfg) => {
    const key = JSON.stringify({ ...p.doc, activeConfig: cfg, rollbackAt: null });
    if (labels.has(key)) return labels.get(key);
    const b = await builtPart(key, p.name, 'the STEP file');
    const list = b.solids.filter((s) => s.shape);
    let label = null;
    if (list.length) {
      const shape = list.length === 1 ? list[0].shape : compoundOf(list);
      label = tool.AddShape(shape.wrapped, false, false);
      oc.TDataStd_Name.Set(label, str(p.name || p.doc.name || 'Part'));
      if (p.exportColor) ctool.SetColor(label, rgb(p.exportColor), SURF);
      // (bodies with a colour of their own)
      if (list.length > 1) for (const s of list) {
        const c = p.doc.bodies?.[s.id]?.color;
        if (!c) continue;
        try { const sub = tool.AddSubShape(label, s.shape.wrapped); if (sub && !sub.IsNull?.()) ctool.SetColor(sub, rgb(c), SURF); } catch (e) { if (isFatal(e)) throw e; }
      }
      stats.parts++;
    }
    labels.set(key, label);
    return label;
  };
  const asmLabel = async (d, name, depth) => {
    const key = 'asm:' + JSON.stringify(d);
    if (labels.has(key)) return labels.get(key);
    const label = tool.NewShape();
    oc.TDataStd_Name.Set(label, str(name || 'Assembly'));
    let any = false;
    for (const c of d.components || []) {
      const e = effIn(d, c);
      if (e.suppressed) continue;
      const p = (d.parts || []).find((x) => x.id === c.part);
      if (!p?.doc) continue;
      const cfg = e.config && (p.doc.configs || []).some((x) => x.id === e.config) ? e.config : null;
      const child = p.doc.kind === 'assembly'
        ? (depth < 16 ? await asmLabel({ ...p.doc, activeConfig: cfg, parts: (p.doc.parts || []).map((q) => ({ ...q, exportColor: q.exportColor })) }, p.name || p.doc.name, depth + 1) : null)
        : await partLabel(p, cfg);
      if (!child) continue;
      const cl = tool.AddComponent(label, child, location(c, depth === 0 && asm.upAxis === 'z'));
      oc.TDataStd_Name.Set(cl, str(c.name || p.name));
      stats.components++;
      any = true;
    }
    stats.assemblies++;
    labels.set(key, any ? label : null);
    return any ? label : null;
  };
  const top = await asmLabel(asm, asm.name, 0);
  if (!top) throw new Error('The assembly has no parts to export');
  tool.UpdateAssemblies();
  progress(null, 'Writing the STEP file…');
  oc.Interface_Static.SetCVal('xstep.cascade.unit', 'MM');
  oc.Interface_Static.SetCVal('write.step.unit', 'MM');
  const session = new oc.XSControl_WorkSession();
  const writer = new oc.STEPCAFControl_Writer(session, false);
  try {
    writer.SetColorMode(true);
    writer.SetLayerMode(true);
    writer.SetNameMode(true);
    oc.Interface_Static.SetIVal('write.surfacecurve.mode', 1);
    oc.Interface_Static.SetIVal('write.precision.mode', 0);
    oc.Interface_Static.SetIVal('write.step.assembly', 1);
    oc.Interface_Static.SetIVal('write.step.schema', 5);
    const pr = new oc.Message_ProgressRange();
    keep.push(pr);
    if (!writer.Perform(doc, 'asm-export.step', pr)) throw new Error('The STEP file could not be written');
    const file = oc.FS.readFile('/asm-export.step');
    oc.FS.unlink('/asm-export.step');
    return { bytes: file, ...stats };
  } finally {
    writer.delete(); session.delete(); doc.delete();
    for (const x of keep) { try { x.delete(); } catch { /* gone */ } }
  }
}

function drawingViewsOf(shape, views) {
  const box = bbox(shape);
  return views.map((v) => {
    try {
      const out = { id: v.id, ...(v.flat ? flatView(drawingCache.solids, v) : projectView(shape, box, v, drawingCache.solids)) };
      if (!v.flat) {
        // holes seen end on in this view: their centres in view coordinates
        const dir = unit(v.dir), x = unit(cross(v.up || [0, 1, 0], dir)), y = cross(dir, x);
        out.holes = drawingCache.holes.filter((h) => Math.abs(dot(unit(h.dir), dir)) > 0.999).map((h) => ({ c: [dot(h.p, x), dot(h.p, y)], sizes: h.sizes, through: h.through, depth: h.depth, thread: h.thread, near: dot(h.dir, dir) < 0 }));
        threadLines(out, drawingCache.threads || [], dir, x, y, v.section);
      }
      return out;
    } catch (e) { if (isFatal(e)) throw e; return { id: v.id, error: e?.message || String(e), edges: [], cut: [] }; }
  });
}

// The body seen at a point of a drawing view (view coordinates; v: { dir, up }): the one a line along the view
// direction meets first from the viewer's side. Returns its id (in an assembly: "<component>/…/<body>") or null.
async function drawingPick(docJson, v, p2) {
  await ensureDrawingCache(docJson);
  const list = drawingCache.solids || [];
  if (!list.length) return null;
  const dir = unit(v.dir), x = unit(cross(v.up || [0, 1, 0], dir)), y = cross(dir, x);
  const L = bbox(drawingCache.shape).diag * 2 + 10;
  const c = add(mul(x, p2[0]), mul(y, p2[1]));
  const line = R.makeLine(add(c, mul(dir, L)), add(c, mul(dir, -L)));
  let best = null, depth = -Infinity;
  for (const r of list) {
    // (quick: the body's box must reach the line)
    const b = bbox(r.shape);
    const corners = [];
    for (const cx of [b.min[0], b.max[0]]) for (const cy of [b.min[1], b.max[1]]) for (const cz of [b.min[2], b.max[2]]) corners.push([dot([cx, cy, cz], x) - p2[0], dot([cx, cy, cz], y) - p2[1]]);
    if (Math.min(...corners.map((k) => k[0])) > 1e-6 || Math.max(...corners.map((k) => k[0])) < -1e-6 || Math.min(...corners.map((k) => k[1])) > 1e-6 || Math.max(...corners.map((k) => k[1])) < -1e-6) continue;
    let inside;
    try { inside = r.shape.intersect(line); } catch (e) { if (isFatal(e)) throw e; continue; }
    for (const e of inside?.edges || []) for (const u of [0, 1]) {
      const d = dot(vec(e.pointAt(u)), dir);
      if (d > depth) { depth = d; best = r.id; }
    }
  }
  return best;
}

// Cosmetic threads in a view, as drawn by convention (thin lines, 'th'; hidden ones dashed, 'thd'): seen from
// the side, two lines at the thread's other diameter (a shaft: the minor one; a bore: the major one, hidden
// unless the section cuts through it) and a line across where the thread ends; seen end on, a three-quarter
// circle. A bore with a cosmetic thread (not one made by the Hole feature) also gets a hole callout entry.
function threadLines(out, threads, dir, x, y, section) {
  const to2 = (p) => [dot(p, x), dot(p, y)];
  for (const t of threads) {
    const d = unit(t.d), c = dot(d, dir), rT = (t.internal ? t.D : t.D1) / 2, R = t.D / 2;
    const cut = section && Math.abs(dot(sub(t.o, section.o), unit(section.n))) < R;
    if (Math.abs(c) > 0.999) {
      // end on: the circle from the side the thread opens to (else hidden)
      const near = c < 0;
      out.edges.push({ k: near || cut ? 'th' : 'thd', g: { t: 'a', c: to2(t.o), r: rT, a0: 0, a1: 1.5 * Math.PI } });
      if (t.internal && !(out.holes || []).some((h) => Math.hypot(h.c[0] - dot(t.o, x), h.c[1] - dot(t.o, y)) < 1e-6)) {
        (out.holes ||= []).push({ c: to2(t.o), sizes: { type: 'simple', d: 2 * t.r }, through: t.full, depth: t.full ? null : t.len, thread: { label: t.label, depth: t.len }, near });
      }
      continue;
    }
    if (Math.abs(c) > 1e-3) continue; // (at an angle to the view: not drawn)
    const a2 = unit([dot(d, x), dot(d, y), 0]), n2 = [-a2[1], a2[0]];
    const S = to2(t.o), E = [S[0] + a2[0] * t.len, S[1] + a2[1] * t.len];
    const k = t.internal && !cut ? 'thd' : 'th';
    for (const s of [1, -1]) out.edges.push({ k, g: { t: 'l', a: [S[0] + n2[0] * rT * s, S[1] + n2[1] * rT * s], b: [E[0] + n2[0] * rT * s, E[1] + n2[1] * rT * s] } });
    out.edges.push({ k, g: { t: 'l', a: [E[0] + n2[0] * R, E[1] + n2[1] * R], b: [E[0] - n2[0] * R, E[1] - n2[1] * R] } });
  }
}

// A flat pattern view: the unfolded sheet metal body (v.body, or the first one) in flat coordinates.
// Edge kinds: 'v' outline and holes, 'bu' / 'bd' bend lines up / down, 'br' bend region lines;
// notes: the bend notes ({ p, rot, text } — the drawing sizes the text).
function flatView(solids, v) {
  const sheets = solids.filter((r) => r.sheet);
  if (!sheets.length) throw new Error('The part has no sheet metal body');
  const rec = (v.body && sheets.find((r) => r.id === v.body)) || sheets[0];
  const flip = drawingCache.doc?.bodies?.[rec.id]?.flatSide === 'bottom';
  const { ents, fp, bends } = flatEnts(rec.sheet, flip);
  const edges = [];
  for (const e of ents) {
    const k = e.layer === 'OUTLINE' || e.layer === 'HOLES' ? 'v' : e.layer === 'BEND_UP' ? 'bu' : e.layer === 'BEND_DOWN' ? 'bd' : e.layer === 'BEND_REGION' ? 'br' : e.layer === 'FORMING' ? 'fm' : e.layer === 'ETCH' ? 'et' : null;
    if (!k) continue;
    if (e.type === 'LINE') edges.push({ k, g: { t: 'l', a: e.a, b: e.b } });
    else if (e.type === 'CIRCLE') edges.push({ k, g: { t: 'c', c: e.c, r: e.r } });
    else if (e.type === 'ARC') edges.push({ k, g: { t: 'a', c: e.c, r: e.r, a0: (e.a0 * Math.PI) / 180, a1: (e.a1 * Math.PI) / 180 } });
    else if (e.type === 'POLYLINE') edges.push({ k, g: { t: 'p', pts: e.closed ? [...e.pts, e.pts[0]] : e.pts } });
  }
  const notes = bends.map((b, i) => ({ p: [(b.a[0] + b.b[0]) / 2, (b.a[1] + b.b[1]) / 2], rot: b.rot, text: b.note, len: b.len, n: i + 1, up: b.up, deg: b.deg, R: b.R }));
  return {
    edges, cut: [], notes, box: { min: [0, 0], max: [fp.size[0], fp.size[1]] },
    flat: { size: fp.size, area: fp.area, cut: (({ length, loops }) => ({ length: length + SM.cutLines(rec.sheet), loops }))(SM.cutInfo(fp.region)), t: rec.sheet.t, K: rec.sheet.K, R: rec.sheet.R, bends: bends.length, body: rec.id, bodies: sheets.map((r) => r.id), stale: rec.sheet.stale || null, flip },
  };
}

function projectView(shape, box, v, solids = null) {
  const oc = R.getOC();
  const dir = unit(v.dir), up0 = v.up || [0, 1, 0];
  const x = unit(cross(up0, dir)), y = cross(dir, x);
  const to2 = (p) => [dot(p, x), dot(p, y)];
  let s = shape, cut = [];
  const cutBody = []; // which body each cut region is of (its index), for its own hatching
  if (v.section) {
    const n = unit(v.section.n), o = v.section.o;
    // remove everything on the n side of the plane (a big box)
    const L = box.diag * 4 + 10;
    const u = unit(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0])), w = cross(n, u);
    const c0 = add(o, add(mul(u, -L), mul(w, -L)));
    const pts = [c0, add(c0, mul(u, 2 * L)), add(add(c0, mul(u, 2 * L)), mul(w, 2 * L)), add(c0, mul(w, 2 * L))];
    const makeTool = () => R.basicFaceExtrusion(R.makePolygon(pts), new R.Vector(mul(n, L)));
    s = shape.cut(makeTool());
    // the cut faces: planar faces of the result lying in the plane
    const cutFaces = (sh, k) => {
      for (const f of sh.faces) {
        if (f.geomType !== 'PLANE') continue;
        const c = vec(f.center), nf = vec(f.normalAt());
        if (Math.abs(dot(sub(c, o), n)) > 1e-4 * Math.max(1, box.diag) || Math.abs(dot(nf, n)) < 0.9999) continue;
        const loops = [f.clone().outerWire(), ...f.clone().innerWires()].map((wire) => loopPts2(wire, to2, box.diag));
        cut.push(loops);
        cutBody.push(k);
      }
    };
    let done = false;
    if (solids && solids.length > 1) {
      // several bodies: each cut on its own, so each region is hatched as its body
      try { solids.forEach((sol, k) => cutFaces((sol.shape || sol).cut(makeTool()), k)); done = true; } catch (e) { if (isFatal(e)) throw e; cut = []; cutBody.length = 0; }
    }
    if (!done) cutFaces(s, 0);
  }
  const hlr = new oc.HLRBRep_Algo();
  hlr.Add(s.wrapped, 0);
  const ax = new oc.gp_Ax2(new oc.gp_Pnt(0, 0, 0), new oc.gp_Dir(dir[0], dir[1], dir[2]), new oc.gp_Dir(x[0], x[1], x[2]));
  const proj = new oc.HLRAlgo_Projector(ax);
  hlr.Projector(proj);
  hlr.Update();
  hlr.Hide();
  const shapes = new oc.HLRBRep_HLRToShape(hlr);
  const edges = [];
  const take = (comp, k) => {
    if (comp.IsNull()) return;
    for (const e of R.cast(comp).edges) {
      oc.BRepLib.BuildCurves3d(e.wrapped);
      const g = edge2(e, box.diag);
      if (g) edges.push({ k, g });
    }
  };
  try {
    take(shapes.VCompound(), 'v');
    take(shapes.OutLineVCompound(), 'v');
    take(shapes.Rg1LineVCompound(), 't');
    take(shapes.HCompound(), 'h');
    take(shapes.OutLineHCompound(), 'h');
    take(shapes.Rg1LineHCompound(), 'ht');
  } finally {
    shapes.delete(); proj.delete(); ax.delete(); hlr.delete();
  }
  // (an edge reaching far outside the part itself is a projection fault, e.g. a swept bead seen end on: dropped)
  {
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((m) => [m & 1 ? box.max[0] : box.min[0], m & 2 ? box.max[1] : box.min[1], m & 4 ? box.max[2] : box.min[2]]);
    const xs = corners.map((q) => dot(q, x)), ys = corners.map((q) => dot(q, y)), mg = box.diag * 0.002 + 0.01;
    const lo = [Math.min(...xs) - mg, Math.min(...ys) - mg], hi = [Math.max(...xs) + mg, Math.max(...ys) + mg];
    const inside = (q) => q[0] >= lo[0] && q[0] <= hi[0] && q[1] >= lo[1] && q[1] <= hi[1];
    const ok = ({ g }) => (g.t === 'l' ? inside(g.a) && inside(g.b) : g.t === 'p' ? g.pts.every(inside) : inside([g.c[0] - g.r, g.c[1] - g.r]) && inside([g.c[0] + g.r, g.c[1] + g.r]));
    for (let i = edges.length - 1; i >= 0; i--) if (!ok(edges[i])) edges.splice(i, 1);
  }
  // the view's extent (visible and hidden lines)
  const b2 = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
  const grow = (p) => { b2.min[0] = Math.min(b2.min[0], p[0]); b2.min[1] = Math.min(b2.min[1], p[1]); b2.max[0] = Math.max(b2.max[0], p[0]); b2.max[1] = Math.max(b2.max[1], p[1]); };
  for (const { g } of edges) {
    if (g.t === 'l') { grow(g.a); grow(g.b); } else if (g.t === 'p') g.pts.forEach(grow);
    else if (g.t === 'c') { grow([g.c[0] - g.r, g.c[1] - g.r]); grow([g.c[0] + g.r, g.c[1] + g.r]); }
    else {
      // an arc: its ends and the quadrant points it passes
      const span = ((g.a1 - g.a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      const at = (t) => [g.c[0] + g.r * Math.cos(t), g.c[1] + g.r * Math.sin(t)];
      grow(at(g.a0)); grow(at(g.a0 + span));
      for (let q = Math.ceil(g.a0 / (Math.PI / 2)) * (Math.PI / 2); q < g.a0 + span; q += Math.PI / 2) grow(at(q));
    }
  }
  return { edges, cut, cutBody, box: isFinite(b2.min[0]) ? b2 : { min: [0, 0], max: [0, 0] } };
}

// An HLR result edge (already in the projection plane: x, y) as a 2D primitive.
function edge2(e, diag) {
  const pts = sampleEdge(e, diag).map((p) => [p[0], p[1], 0]);
  if (pts.length < 2) return null;
  const g = S.classifyPolyline3(pts);
  const p2 = (p) => [p[0], p[1]];
  if (!g) return null;
  if (g.type === 'line') return Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) < 1e-9 ? null : { t: 'l', a: p2(g.a), b: p2(g.b) };
  if (g.type === 'circle') return { t: 'c', c: p2(g.c), r: g.r };
  if (g.type === 'arc') {
    const ang = (p) => Math.atan2(p[1] - g.c[1], p[0] - g.c[0]);
    let a0 = ang(g.a), a1 = ang(g.b);
    const am = ang(g.m), TAU = 2 * Math.PI, norm = (t) => ((t % TAU) + TAU) % TAU;
    if (norm(am - a0) > norm(a1 - a0)) [a0, a1] = [a1, a0];
    return { t: 'a', c: p2(g.c), r: g.r, a0, a1 };
  }
  return { t: 'p', pts: pts.map(p2) };
}

// A wire's points in view coordinates (a closed loop). The wire's edges do not always come in order
// round the loop: each next edge is the unused one with an end nearest the loop's end so far (and the
// first edge is turned round when the rest join at its start), else the loop crosses itself.
function loopPts2(wire, to2, diag) {
  const segs = wire.edges.map((e) => sampleEdge(e, diag)).filter((s) => s.length);
  if (!segs.length) return [];
  const gap = (s, p) => Math.min(len(sub(s[0], p)), len(sub(s[s.length - 1], p)));
  const out = segs[0].slice();
  if (segs.length > 1) {
    const near = (p) => Math.min(...segs.slice(1).map((s) => gap(s, p)));
    if (near(out[0]) < near(out[out.length - 1])) out.reverse();
  }
  const used = new Set([0]);
  while (used.size < segs.length) {
    const last = out[out.length - 1];
    let best = -1, bd = Infinity, rev = false;
    segs.forEach((s, i) => {
      if (used.has(i)) return;
      const d0 = len(sub(s[0], last)), d1 = len(sub(s[s.length - 1], last));
      if (d0 < bd) { bd = d0; best = i; rev = false; }
      if (d1 < bd) { bd = d1; best = i; rev = true; }
    });
    used.add(best);
    const pts = rev ? segs[best].slice().reverse() : segs[best];
    for (const p of pts.slice(1)) out.push(p);
  }
  return out.map(to2);
}

// ---- threads
// A thread coil: the profile corners (radius, axial offset) each follow a helix; neighbouring helices
// are joined by ruled faces and the ends are capped. (A profile swept along a helix gives a solid that
// booleans often fail to cut; this one cuts cleanly.)
function threadCoil(center, dir, pitch, length, corners, leftHand) {
  const oc = R.getOC();
  const hel = corners.map(([r, z]) => R.makeHelix(pitch, length, r, add(center, mul(dir, z)), dir, leftHand));
  const sw = new oc.BRepBuilderAPI_Sewing(1e-5, true, true, true, false);
  try {
    for (let i = 0; i < hel.length; i++) sw.Add(R.loft([hel[i], hel[(i + 1) % hel.length]], { ruled: true }, true).wrapped);
    sw.Add(R.makePolygon(hel.map((w) => vec(w.startPoint))).wrapped);
    sw.Add(R.makePolygon(hel.map((w) => vec(w.endPoint))).wrapped);
    sw.Perform(new oc.Message_ProgressRange());
    const shell = R.iterTopo(sw.SewedShape(), 'shell').next().value;
    if (!shell) throw new Error('The thread could not be built');
    const ms = new oc.BRepBuilderAPI_MakeSolid(shell);
    const solid = R.cast(ms.Solid());
    ms.delete();
    oc.BRepLib.OrientClosedSolid(solid.wrapped);
    return solid;
  } finally { sw.delete(); }
}

// ---- loft
// One closed outline of a loft profile in 3D: { circle: { c, r, n, u } } or { segs: [{ type, a, m, b }] }.
function loftSection(fr, segs) {
  const P3 = (q) => S.fromFrame2D(fr, q[0], q[1]);
  if (segs.length === 1 && segs[0].type === 'circle') return { circle: { c: P3(segs[0].c), r: segs[0].r, n: fr.n, u: fr.u } };
  return { segs: segs.map((g) => (g.type === 'line' ? { type: 'line', a: P3(g.a), b: P3(g.b) } : g.type === 'bezier' ? { type: 'bezier', a: P3(g.a), c1: P3(g.c1), c2: P3(g.c2), b: P3(g.b) } : { type: 'arc', a: P3(g.a), m: P3(g.m), b: P3(g.b) })) };
}

// Give every section the same number of segments, starting at matching points and running the same
// way round, so the loft twists as little as possible. A circle is split into as many equal arcs as
// the other profiles have segments; profiles with different segment counts are an error.
function matchLoftSections(secs, names) {
  const counts = secs.map((s) => s.segs?.length ?? 0);
  const N = Math.max(...counts);
  if (N === 0) return secs.map((s) => ({ circle: s.circle }));
  const ref = counts.findIndex((n) => n > 0);
  secs.forEach((s, i) => {
    if (s.segs && s.segs.length !== N) throw new Error(`${names[i]} has ${s.segs.length} segments but ${names[counts.indexOf(N)]} has ${N}. A loft needs the same number of points on every profile (circles are split automatically) — split the curves so the counts match, or attach a connector inside a curve (Edit profile connectors) to add a point there.`);
  });
  const centroid = (pts) => mul(pts.reduce((a, b) => add(a, b), [0, 0, 0]), 1 / pts.length);
  const newell = (pts) => { let n = [0, 0, 0]; pts.forEach((p, i) => { n = add(n, cross(p, pts[(i + 1) % pts.length])); }); return n; };
  const refPts = secs[ref].segs.map((g) => g.a), refC = centroid(refPts), refN = unit(newell(refPts));
  const dirs = (pts, c) => pts.map((q) => unit(sub(q, c)));
  const refDirs = dirs(refPts, refC);
  return secs.map((s) => {
    if (s.circle) {
      const { c, r, n } = s.circle;
      const w = dot(n, refN) >= 0 ? n : mul(n, -1);
      let e1 = rej(refDirs[0], w);
      e1 = len(e1) > 1e-9 ? unit(e1) : unit(rej(s.circle.u, w));
      const e2 = cross(w, e1);
      const at = (t) => add(c, add(mul(e1, r * Math.cos(t)), mul(e2, r * Math.sin(t))));
      // equal arcs, starting at the reference's first point; their ends follow the reference's directions
      const ang = refDirs.map((d) => { const x = dot(d, e1), y = dot(d, e2); return Math.atan2(y, x); });
      const segs = [];
      for (let i = 0; i < N; i++) {
        const t0 = (2 * Math.PI * i) / N, t1 = (2 * Math.PI * (i + 1)) / N;
        segs.push({ type: 'arc', a: at(t0), m: at((t0 + t1) / 2), b: at(t1) });
      }
      void ang;
      return { segs };
    }
    let segs = s.segs;
    const pts = segs.map((g) => g.a);
    // (turned round: each segment's ends swap, and a Bézier's two control points too)
    if (dot(newell(pts), refN) < 0) segs = segs.slice().reverse().map((g) => ({ ...g, a: g.b, b: g.a, ...(g.type === 'bezier' ? { c1: g.c2, c2: g.c1 } : {}) }));
    const d = dirs(segs.map((g) => g.a), centroid(segs.map((g) => g.a)));
    let best = 0, bd = Infinity;
    for (let m = 0; m < N; m++) {
      let sum = 0;
      for (let i = 0; i < N; i++) sum += len(sub(d[(i + m) % N], refDirs[i]));
      if (sum < bd) { bd = sum; best = m; }
    }
    return { segs: [...segs.slice(best), ...segs.slice(0, best)] };
  });
}

// A loft's sections with guide curves: between each two profiles, intermediate sections,
// each first the two profiles blended point by point, then moved so that where the guides touch the profiles it
// lies on the guides (at the same share of each guide's length between the two profiles): one guide moves the
// section, several move it by amounts that change smoothly round it between them. The profiles stay as they are;
// each section in between is fitted segment by segment (the profiles' corners stay corners). matched: the
// sections as matchLoftSections gives them (the same segments, starting at matching points); guides: [{ name, wire }].
// holeSets: each hole (or a thin loft's inside) the same way, one matched list per hole: its sections in between
// are moved with the outline, each point by the outline's pulls nearby (weighted by how near), so a thin wall
// keeps its thickness and a hole moves with the shape round it. slack: how far a guide may pass from the outline
// and still touch it (a thin loft: the wall's thickness, the guide drawn on the sketched line); the outline keeps
// that offset from the guide. open: the sections are open (a surface's: from one end to the other, not round);
// profileWires: the wires lofted through at the profiles (else made from the sections). Returns { outer, holes }:
// the wires to loft.
// Guide positions are evaluated on the original CAD edges. Refinement is checked against BRep faces by
// buildGuidedLoft below. These sampled checks are not a mathematical bound over the continuous curve.
const GUIDE_TOLERANCE = 0.01, GUIDE_CONTACT_TOLERANCE = 1e-5, GUIDE_SAMPLES = 16;
function guidedLoftWires(matched, guides, names, holeSets = [], slack = 0, { open = false, profileWires = null, stations = 16, includeJunctions = true, smoothPull = false, tolerance: guideTolerance = GUIDE_TOLERANCE } = {}) {
  // (a loft of circles: each made four arcs, to have points to follow the guides with)
  const asSegs = (s) => {
    if (s.segs) return s;
    const { c, r, n, u } = s.circle, e1 = unit(rej(u, n)), e2 = cross(n, e1);
    const at = (t) => add(c, add(mul(e1, r * Math.cos(t)), mul(e2, r * Math.sin(t))));
    return { segs: [0, 1, 2, 3].map((i) => ({ type: 'arc', a: at((i * Math.PI) / 2), m: at(((i + 0.5) * Math.PI) / 2), b: at(((i + 1) * Math.PI) / 2) })) };
  };
  const secs = matched.map(asSegs);
  const N = secs[0].segs.length, M = GUIDE_SAMPLES, NM = N * M + (open ? 1 : 0);
  const segPt = (g, t) => {
    if (g.type === 'line') return add(g.a, mul(sub(g.b, g.a), t));
    if (g.type === 'pts') {
      // (points along a curve: at that share of their length)
      const L = g.L, s = t * L[L.length - 1];
      let i = 1;
      while (i < L.length - 1 && L[i] < s) i++;
      const u = (s - L[i - 1]) / ((L[i] - L[i - 1]) || 1);
      return add(g.pts[i - 1], mul(sub(g.pts[i], g.pts[i - 1]), Math.max(0, Math.min(1, u))));
    }
    if (g.type === 'bezier') { const u = 1 - t; return add(add(mul(g.a, u * u * u), mul(g.c1, 3 * u * u * t)), add(mul(g.c2, 3 * u * t * t), mul(g.b, t * t * t))); }
    // a three-point arc: its circle, from a through m to b
    const A = g.a, B = g.m, C = g.b, ab = sub(B, A), ac = sub(C, A), nn = cross(ab, ac), d = 2 * dot(nn, nn);
    if (d < 1e-18) return add(A, mul(sub(C, A), t));
    const o = add(A, mul(add(mul(cross(nn, ab), dot(ac, ac)), mul(cross(ac, nn), dot(ab, ab))), 1 / d));
    const x = unit(sub(A, o)), y = unit(cross(unit(nn), x)), r = len(sub(A, o));
    let span = Math.atan2(dot(sub(C, o), y), dot(sub(C, o), x));
    if (span <= 0) span += 2 * Math.PI;
    return add(o, add(mul(x, r * Math.cos(span * t)), mul(y, r * Math.sin(span * t))));
  };
  const sampled = (s) => {
    const out = [];
    for (const g of s.segs) for (let j = 0; j < M; j++) out.push(segPt(g, j / M));
    if (open) out.push(segPt(s.segs[s.segs.length - 1], 1));
    return out;
  };
  const P = secs.map(sampled);
  let size = 0;
  for (const s of P) for (const q of s) size = Math.max(size, len(sub(q, P[0][0])));
  const tol = Math.max(0.05, size * 2e-3);
  // each guide as points along it, in order, with the length up to each
  const polyOf = (wire) => {
    const nativePoint = (edge, t) => { const p = edge.pointAt(t); try { return vec(p); } finally { p.delete(); } };
    const runs = wire.edges.map((edge) => {
      const points = [{ p: nativePoint(edge, 0), edge, t: 0 }];
      const split = (a, b, depth) => {
        const middle = { p: nativePoint(edge, (a.t + b.t) / 2), edge, t: (a.t + b.t) / 2 };
        const error = len(sub(middle.p, mul(add(a.p, b.p), 0.5)));
        if (error > guideTolerance / 40) {
          if (depth >= 10 || points.length > 4096) throw new Error('A guide is too complex to sample at the required tolerance; split it into shorter curves');
          split(a, middle, depth + 1); split(middle, b, depth + 1);
        } else points.push(b);
      };
      // Seed intervals also detect curves whose midpoint alone lies on their endpoint chord.
      for (let i = 1; i <= 16; i++) split(points[points.length - 1], { p: nativePoint(edge, i / 16), edge, t: i / 16 }, 0);
      return points;
    });
    const out = runs.shift();
    while (runs.length) {
      const end = out[out.length - 1].p, start = out[0].p;
      let k = runs.findIndex((r) => len(sub(r[0].p, end)) < GUIDE_CONTACT_TOLERANCE || len(sub(r[r.length - 1].p, end)) < GUIDE_CONTACT_TOLERANCE);
      if (k >= 0) { const r = runs.splice(k, 1)[0]; out.push(...(len(sub(r[0].p, end)) < GUIDE_CONTACT_TOLERANCE ? r : r.reverse())); continue; }
      k = runs.findIndex((r) => len(sub(r[0].p, start)) < GUIDE_CONTACT_TOLERANCE || len(sub(r[r.length - 1].p, start)) < GUIDE_CONTACT_TOLERANCE);
      if (k < 0) throw new Error('A guide contains disconnected edges');
      const r = runs.splice(k, 1)[0];
      out.unshift(...(len(sub(r[r.length - 1].p, start)) < GUIDE_CONTACT_TOLERANCE ? r : r.reverse()));
    }
    const pts = out.map((q) => q.p);
    const L = [0];
    for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + len(sub(pts[i], pts[i - 1])));
    return { pts, L, samples: out };
  };
  // (a guide drawn from the last profile to the first: turned round)
  const G = guides.map((g) => {
    const q = polyOf(g.wire);
    const near = (sec) => Math.min(...sec.map((x) => len(sub(x, q.pts[0]))));
    if (near(P[P.length - 1]) < near(P[0])) {
      q.pts.reverse();
      q.samples.reverse();
      q.L = [0];
      for (let i = 1; i < q.pts.length; i++) q.L.push(q.L[i - 1] + len(sub(q.pts[i], q.pts[i - 1])));
    }
    return { ...g, ...q };
  });
  const atLen = (g, s) => {
    let i = 1;
    while (i < g.L.length - 1 && g.L[i] < s) i++;
    const t = (s - g.L[i - 1]) / ((g.L[i] - g.L[i - 1]) || 1);
    const a = g.samples[i - 1], b = g.samples[i];
    const start = a.edge === b.edge ? a.t : b.t < 0.5 ? 0 : 1;
    const p = b.edge.pointAt(start + (b.t - start) * Math.max(0, Math.min(1, t)));
    try { return vec(p); } finally { p.delete(); }
  };
  // Locate guide/profile contacts on the exact CAD wires, then map them to section indices and guide lengths.
  const clamp01 = (t) => Math.max(0, Math.min(1, t));
  const touch = G.map((g) => P.map((sec, k) => {
    const best = {};
    // Check attachment on the exact wires, rather than accepting a gap based on model size or retaining
    // the sampling polygon's offset. Thin walls deliberately keep their offset from the sketched guide.
    const wire = profileWires?.[k] || sectionWire(secs[k]), query = new (R.getOC()).BRepExtrema_DistShapeShape();
    try {
      query.LoadS1(g.wire.wrapped); query.LoadS2(wire.wrapped); query.Perform();
      if (!query.IsDone() || !query.NbSolution()) throw new Error(`Could not locate the guide ${g.name} on ${names[k]}`);
      const distance = query.Value();
      if (distance > GUIDE_CONTACT_TOLERANCE + slack) throw new Error(`The guide ${g.name} doesn't touch ${names[k]} (CAD gap ${distance.toFixed(6)} mm): each guide must run through every profile`);
      const guidePoint = query.PointOnShape1(1), sectionPoint = query.PointOnShape2(1);
      let Q, X;
      try { Q = [guidePoint.X(), guidePoint.Y(), guidePoint.Z()]; X = [sectionPoint.X(), sectionPoint.Y(), sectionPoint.Z()]; }
      finally { guidePoint.delete(); sectionPoint.delete(); }
      const closest = (p, pts, closed) => {
        let d = Infinity, index = 0;
        for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) {
          const a = pts[i], ab = sub(pts[(i + 1) % pts.length], a), t = clamp01(dot(sub(p, a), ab) / (dot(ab, ab) || 1));
          const gap = len(sub(p, add(a, mul(ab, t))));
          if (gap < d) { d = gap; index = i + t; }
        }
        return index;
      };
      best.i = closest(X, sec, !open);
      const position = closest(Q, g.pts, false), i = Math.min(g.L.length - 2, Math.floor(position)), fraction = position - i;
      best.s = g.L[i] + (g.L[i + 1] - g.L[i]) * fraction;
      best.off = slack ? sub(X, Q) : [0, 0, 0];
    } finally { query.delete(); if (!profileWires) wire.delete(); }
    return best;
  }));
  touch.forEach((tg, gi) => { for (let k = 1; k < tg.length; k++) if (tg[k].s < tg[k - 1].s - tol) throw new Error(`The guide ${G[gi].name} doesn't run from one profile to the next in order`); });
  const lerp = (a, b, t) => add(a, mul(sub(b, a), t));
  // (an index along a section: round a closed one, kept to the ends of an open one)
  const cyc = (i) => (open ? Math.max(0, Math.min(NM - 1, i)) : ((i % NM) + NM) % NM);
  const pointAt = (sec, x) => { const i = Math.floor(x), t = x - i; return lerp(sec[cyc(i)], sec[cyc(i + 1)], t); };
  // a section in between from its points (n segments of M each, round): fitted segment by segment
  const fitWire = (pts, n, anchors = [], evaluate = null) => {
    const edges = [];
    for (let si = 0; si < n; si++) {
      const indices = [...Array.from({ length: M + 1 }, (_, j) => si * M + j), ...anchors.filter((x) => x > si * M && x < (si + 1) * M)].sort((a, b) => a - b).filter((x, i, all) => !i || x - all[i - 1] > 1e-8);
      const run = indices.map((i) => evaluate ? evaluate(i) : pts[open ? i : i % (n * M)]);
      const end = run.length - 1, chord = sub(run[end], run[0]), cl = len(chord);
      const straight = cl > 1e-9 && run.every((q) => len(cross(sub(q, run[0]), chord)) / cl < size * 1e-7);
      edges.push(straight ? R.makeLine(run[0], run[end]) : R.makeBSplineApproximation(run, { tolerance: Math.min(guideTolerance / 20, Math.max(1e-6, size * 1e-7)), degMax: 5 }));
    }
    return R.assembleWire(edges);
  };
  // the holes: their sections as segments and points
  const H = holeSets.map((hs) => { const s = hs.map(asSegs); return { secs: s, n: s[0].segs.length, P: s.map(sampled) }; });
  const holeWires = H.map(() => []);
  const wires = [];
  for (let k = 0; k < secs.length; k++) {
    wires.push(profileWires ? profileWires[k] : sectionWire(secs[k]));
    H.forEach((h, hi) => holeWires[hi].push(sectionWire(h.secs[k])));
    if (k === secs.length - 1) break;
    const fractions = new Set(Array.from({ length: stations }, (_, st) => (st + 1) / (stations + 1)));
    if (includeJunctions) G.forEach((g, gi) => g.samples.forEach((q, i) => {
      if (i && q.edge !== g.samples[i - 1].edge) {
        const fraction = (g.L[i - 1] - touch[gi][k].s) / (touch[gi][k + 1].s - touch[gi][k].s);
        if (fraction > 1e-8 && fraction < 1 - 1e-8) fractions.add(fraction);
      }
    }));
    for (const lam of [...fractions].sort((a, b) => a - b)) {
      const base = P[k].map((q, i) => lerp(q, P[k + 1][i], lam));
      // each guide's pull: where it touches this section (between the two profiles' touch points) and by how much
      const knots = G.map((g, gi) => {
        const a = touch[gi][k].i, b = touch[gi][k + 1].i;
        let dI = b - a;
        if (!open) { if (dI > NM / 2) dI -= NM; else if (dI < -NM / 2) dI += NM; }
        const at = a + dI * lam;
        // (the outline kept as far from the guide as at the two profiles: a thin wall's offset)
        const off = lerp(touch[gi][k].off, touch[gi][k + 1].off, lam);
        return { at: cyc(at), d: sub(add(atLen(g, touch[gi][k].s + (touch[gi][k + 1].s - touch[gi][k].s) * lam), off), pointAt(base, at)) };
      }).sort((x, y) => x.at - y.at);
      const blend = (t) => smoothPull ? t*t*t*(10+t*(-15+6*t)) : t;
      const pull = (i) => {
        if (knots.length === 1) return knots[0].d;
        if (open) {
          // (along an open section: between the two guides either side of it, as the first / last one past them)
          if (i <= knots[0].at) return knots[0].d;
          const hi = knots.findIndex((q) => q.at >= i);
          if (hi < 0) return knots[knots.length - 1].d;
          const A = knots[hi - 1], B = knots[hi];
          return lerp(A.d, B.d, blend((i - A.at) / ((B.at - A.at) || 1)));
        }
        let hi = knots.findIndex((q) => q.at >= i);
        if (hi < 0) hi = 0;
        const lo = (hi - 1 + knots.length) % knots.length, A = knots[lo], B = knots[hi];
        const span = cyc(B.at - A.at) || NM, t = cyc(i - A.at) / span;
        return lerp(A.d, B.d, blend(t));
      };
      const pulls = base.map((_, i) => pull(i));
      wires.push(fitWire(base.map((q, i) => add(q, pulls[i])), N, knots.map((q) => q.at), (i) => add(pointAt(base, i), pull(cyc(i)))));
      // each hole point: the outline's pulls, weighted by 1 / distance⁴ (the nearest outline points count most)
      H.forEach((h, hi) => {
        const pts = h.P[k].map((q, i) => {
          const x = lerp(q, h.P[k + 1][i], lam);
          let sw = 0, d = [0, 0, 0];
          for (let j = 0; j < NM; j++) {
            const r2 = dot(sub(x, base[j]), sub(x, base[j])), w = 1 / (r2 * r2 + 1e-12 * size ** 4);
            sw += w; d = add(d, mul(pulls[j], w));
          }
          return add(x, mul(d, 1 / sw));
        });
        holeWires[hi].push(fitWire(pts, h.n));
      });
    }
  }
  const checkPoints = [];
  G.forEach((g, gi) => {
    for (let k = 0; k + 1 < secs.length; k++) {
      const a = touch[gi][k], b = touch[gi][k + 1];
      const lengths = new Set(Array.from({ length: 65 }, (_, i) => a.s + (b.s - a.s) * i / 64));
      for (let i = 1; i < g.L.length; i++) {
        const s = (g.L[i - 1] + g.L[i]) / 2;
        if (s > a.s && s < b.s) lengths.add(s);
      }
      for (const s of lengths) checkPoints.push({ p: add(atLen(g, s), lerp(a.off, b.off, (s - a.s) / ((b.s - a.s) || 1))), name: g.name });
    }
  });
  return { outer: wires, holes: holeWires, checkPoints };
}

// Refine the intermediate sections until independent points on the native guide edges are within 0.01 mm
// of the resulting CAD faces. Never silently accept a fit that fails this sampled tolerance check.
function buildGuidedLoft(matched, guides, names, holeSets, slack, options) {
  if (options.constrained && holeSets.length && !slack && matched.length === 2) {
    // (holes with CAD guide constraints: the outline made from the guides, each hole lofted between the two profiles
    // without them, for the caller to cut out)
    const g = constrainedGuideLoft(matched, guides, names, [], 0, options);
    return { ...g, holes: holeSets.map((set) => R.loft(set.map(sectionWire), { ruled: false })) };
  }
  if (options.constrained) return constrainedGuideLoft(matched, guides, names, holeSets, slack, options);
  let worst = 0, worstName = '';
  for (const stations of [16, 32, 64, 128]) {
    const g = guidedLoftWires(matched, guides, names, holeSets, slack, { ...options, stations });
    let shape;
    const holes = [];
    try {
      shape = options.build(g.outer);
      const faces = facesWithBox(shape), edges = shape.edges.map((edge) => ({ edge, box: bbox(edge) }));
      worst = 0;
      try { for (const { p, name } of g.checkPoints) {
        // (first quick bounds: the kernel's local projection onto the faces near the point, then the edges near it
        // (guides mostly run along the loft's seams, where the projection gives up), either nearer than the true
        // distance never; within the tolerance the point passes, else the full distance search to the faces, which
        // takes some 10 ms a point on these faces)
        let distance = Infinity;
        for (const { face, box } of faces) {
          if (boxDist(box, p) > GUIDE_TOLERANCE) continue;
          const q = nearFacePoint(face, p, GUIDE_TOLERANCE);
          if (q) distance = Math.min(distance, len(sub(q, p)));
          if (distance <= GUIDE_TOLERANCE) break;
        }
        if (distance > GUIDE_TOLERANCE) {
          const vertex = R.makeVertex(p), query = new R.DistanceQuery(vertex);
          try {
            for (const { edge, box } of edges) {
              if (boxDist(box, p) > GUIDE_TOLERANCE) continue;
              distance = Math.min(distance, query.distanceTo(edge));
              if (distance <= GUIDE_TOLERANCE) break;
            }
          } finally { query.delete(); vertex.delete(); }
        }
        if (distance > GUIDE_TOLERANCE) {
          const vertex = R.makeVertex(p), query = new R.DistanceQuery(vertex);
          try {
            for (const { face, box } of faces) if (boxDist(box, p) <= distance) distance = Math.min(distance, query.distanceTo(face));
          } finally { query.delete(); vertex.delete(); }
        }
        if (!Number.isFinite(distance)) throw new Error(`Could not verify the guide ${name} against the CAD faces`);
        if (distance > worst) { worst = distance; worstName = name; }
        if (worst > GUIDE_TOLERANCE) break; // refine immediately; a failing candidate needs no further checks
      } } finally { edges.forEach(({ edge }) => edge.delete()); }
      if (worst <= GUIDE_TOLERANCE) {
        for (const wires of g.holes) holes.push(options.build(wires));
        return { shape, holes };
      }
    } catch (e) { shape?.delete(); holes.forEach((h) => h.delete()); throw e; }
    finally {
      for (const wire of [...g.outer, ...g.holes.flat()]) if (!options.profileWires?.includes(wire)) wire.delete();
    }
    shape.delete();
  }
  throw new Error(`The guide ${worstName} could not be followed within ${GUIDE_TOLERANCE} mm (sampled CAD deviation ${worst.toFixed(4)} mm). Add a section profile near the tightest bend`);
}

// Native edge constraints, rather than interpolating a finite sequence of displaced cross-sections.
// The loft supplies a patch layout; affected patches are rebuilt with the original guide edges as C0
// constraints. Guides at patch seams replace those boundaries on both sides, using the same CAD edges.
const CONSTRAINED_GUIDE_TOLERANCE = 1e-4;
function guideConstraintNote(g) {
  if (!g?.guideQuality) return '';
  const q = g.guideQuality;
  return ` · CAD guide constraints: ${q.continuity}, ${q.seams} seams; normal mismatch ${q.maxAngle.toFixed(4)} deg${q.continuity === 'G2' ? `; curvature mismatch ${q.maxCurvature.toExponential(3)} 1/mm` : ''}`;
}
// Auxiliary-spine sweep. The native builder controls the moving section; no
// sampled loft or silent fallback to an unguided sweep is used.
function sweepWithGuide(profile, spine, originalGuide, mode, surface = false) {
  if (!['orientation','contact'].includes(mode)) throw new Error('Select Orientation or Section size for the sweep guide');
  if (spine.isClosed || originalGuide.isClosed) throw new Error('A guided sweep currently requires an open path and an open guide');
  const tolerance=1e-4,oc=R.getOC();let reversed,shape;
  const point=(wire,t)=>{const p=wire.pointAt(t);try{return vec(p);}finally{p.delete();}};
  const tangent=(wire,t)=>{const p=wire.tangentAt(t);try{return unit(vec(p));}finally{p.delete();}};
  const start=point(spine,0),end=point(spine,1),first=tangent(spine,0),last=tangent(spine,1);
  const endpoints=[point(originalGuide,0),point(originalGuide,1)];
  const planeError=(points)=>Math.abs(dot(sub(points[0],start),first))+Math.abs(dot(sub(points[1],end),last));
  let guide=originalGuide;
  try {
    if(planeError([...endpoints].reverse())+tolerance<planeError(endpoints)){
      const edges=originalGuide.edges,flipped=edges.reverse().map((e)=>e.flipOrientation());
      try{reversed=R.assembleWire(flipped);guide=reversed;}finally{edges.forEach((e)=>e.delete());flipped.forEach((e)=>e.delete());}
    }
    const a=point(guide,0),b=point(guide,1);
    if(Math.abs(dot(sub(a,start),first))>tolerance||Math.abs(dot(sub(b,end),last))>tolerance)
      throw new Error('The guide must start and end in the normal planes at the path endpoints');
    if(len(sub(a,start))<=tolerance||len(sub(b,end))<=tolerance)
      throw new Error('The guide must stay separate from the path');
    const separation=new R.DistanceQuery(guide);
    try{if(separation.distanceTo(spine)<=tolerance)throw new Error('The sweep guide crosses or approaches the path too closely');}finally{separation.delete();}
    const edges=profile.edges;
    try{for(const edge of edges)for(const t of [0,0.25,0.5,0.75,1])
      if(Math.abs(dot(sub(point(edge,t),start),first))>tolerance)
        throw new Error('Place the profile in the normal plane at the start of the path');
    }finally{edges.forEach((e)=>e.delete());}
    if(mode==='contact'){
      const vertex=R.makeVertex(a),query=new R.DistanceQuery(vertex);
      try{if(query.distanceTo(profile)>tolerance)throw new Error(surface ? 'For Section size, the guide must start on the profile curve' : 'For Section size, the guide must start on the profile boundary');}
      finally{query.delete();vertex.delete();}
    }
    const builder=new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);let law;
    try{
      builder.SetTolerance(1e-6,1e-6,1e-3);builder.SetMaxDegree(12);builder.SetMaxSegments(128);
      builder.SetMode(guide.wrapped,false,oc.BRepFill_TypeOfContact.BRepFill_NoContact);
      if(mode==='contact'){law=guideScaleLaw(R,spine,guide,len(sub(a,start)),tolerance);builder.SetLaw(profile.wrapped,law,false,false);}
      else builder.Add(profile.wrapped,false,false);
      builder.Build();
      if(!builder.IsDone()||!surface&&!builder.MakeSolid())throw new Error(`The path and guide could not produce a ${surface ? 'surface' : 'solid'} sweep; check that every normal section meets the guide`);
      if(!Number.isFinite(builder.ErrorOnSurface())||builder.ErrorOnSurface()>tolerance)throw new Error('The guided sweep exceeds the 0.0001 mm construction tolerance');
      const raw=builder.Shape();try{shape=R.cast(raw);}finally{raw.delete();}
    }catch(e){
      if(isFatal(e)||e?.message)throw e;
      throw new Error('The path and guide are incompatible: check their normal sections and avoid sharp corners or crossings');
    }finally{builder.delete();law?.delete();}
    const validity=new oc.BRepCheck_Analyzer(shape.wrapped,true);
    try{if(!validity.IsValid()||!surface&&!solidsOf(shape).length)throw new Error(`The guided sweep produced an invalid ${surface ? 'surface' : 'solid'}`);}
    finally{validity.delete();}
    if(mode==='contact'){
      const faces=shape.faces;
      try{for(let i=0;i<=32;i++){
        const p=point(guide,i/32),vertex=R.makeVertex(p),query=new R.DistanceQuery(vertex);
        let error=Infinity;
        try{for(const face of faces){const contact=nearFacePoint(face,p);error=Math.min(error,contact?len(sub(contact,p)):query.distanceTo(face));}}
        finally{query.delete();vertex.delete();}
        if(!Number.isFinite(error)||error>tolerance)throw new Error('The sweep does not follow the guide within 0.0001 mm');
      }}finally{faces.forEach((f)=>f.delete());}
    }
    return shape;
  }catch(e){shape?.delete();throw e;}finally{reversed?.delete();}
}
function constrainedGuideLoft(matched, guides, names, holeSets, slack, options) {
  if (matched.length !== 2 || holeSets.length || slack) throw new Error('CAD guide constraints currently require two profiles, without Thin Feature. Select Adaptive approximation for this loft');
  const continuity = options.guideContinuity || 'C0', seams = [];
  if (continuity === 'G2' && (typeof R.getOC().RazorCADSurfacePatch?.BuildNetwork !== 'function' || typeof R.getOC().RazorCADSurfacePatch?.BuildNetworkOnSurface !== 'function')) throw new Error('G2 guide continuity is not available in the loaded kernel. Reload RazorCAD to load the updated kernel');
  if (!['C0', 'G1', 'G2'].includes(continuity)) throw new Error('Select C0, G1 or G2 guide continuity');
  const contact = guidedLoftWires(matched, guides, names, [], 0, { ...options, stations: 0 });
  const owned = [], patches = [];
  const guideEdges = guides.flatMap((g) => g.wire.edges);
  let scaffold, sewn, result, resultFaces = [], stage = 'patch layout';
  const point = (edge, t) => { const p = edge.pointAt(t); try { return vec(p); } finally { p.delete(); } };
  const ends = (edge) => [point(edge, 0), point(edge, 1)];
  const near = (a, b) => len(sub(a, b)) <= GUIDE_CONTACT_TOLERANCE;
  const distance = (p, shape) => {
    const vertex = R.makeVertex(p), query = new R.DistanceQuery(vertex);
    try { return query.distanceTo(shape); } finally { query.delete(); vertex.delete(); }
  };
  const order = (edges) => {
    const pool = edges.map((edge) => ({ edge, ends: ends(edge) })), out = [];
    let at = pool[0].ends[0]; const start = at;
    while (pool.length) {
      const i = pool.findIndex((q) => q.ends.some((p) => near(p, at)));
      if (i < 0) throw new Error('CAD guide constraints could not form a connected patch boundary');
      const q = pool.splice(i, 1)[0], reverse = !near(q.ends[0], at);
      const edge = reverse === (q.edge.orientation === 'backward') ? q.edge : q.edge.flipOrientation();
      if (edge !== q.edge) owned.push(edge);
      out.push(edge); at = q.ends[reverse ? 0 : 1];
    }
    if (!near(at, start)) throw new Error('CAD guide constraints left an open patch boundary');
    return out;
  };
  const splitAt = (edge, contacts) => {
    const [a, b] = ends(edge), cuts = [0, 1];
    for (const p of contacts) {
      if (near(a, p) || near(b, p) || distance(p, edge) > GUIDE_CONTACT_TOLERANCE) continue;
      let index = 0, best = Infinity;
      for (let j = 0; j <= 32; j++) { const d = len(sub(point(edge, j / 32), p)); if (d < best) { best = d; index = j; } }
      let lo = Math.max(0, (index - 1) / 32), hi = Math.min(1, (index + 1) / 32);
      for (let j = 0; j < 70; j++) {
        const x = lo + (hi - lo) / 3, y = hi - (hi - lo) / 3;
        if (len(sub(point(edge, x), p)) < len(sub(point(edge, y), p))) hi = y; else lo = x;
      }
      cuts.push((lo + hi) / 2);
    }
    if (cuts.length === 2) return [edge];
    cuts.sort((x, y) => x - y);
    const oc = R.getOC(), geometry = oc.BRep_Tool.Curve(edge.wrapped, 0, 0), curve = geometry.returnValue;
    try {
      const first = geometry.First, span = geometry.Last - first;
      return cuts.slice(1).map((t, i) => {
        const mk = new oc.BRepBuilderAPI_MakeEdge(curve, first + span * cuts[i], first + span * t);
        let piece;
        try { const raw = mk.Edge(); try { piece = R.cast(raw); } finally { raw.delete(); } } finally { mk.delete(); }
        owned.push(piece);
        if (!near(point(piece, 0), point(edge, cuts[i])) || !near(point(piece, 1), point(edge, t))) throw new Error('The profile edge could not be split in world coordinates for CAD guide constraints');
        return piece;
      });
    } finally { curve.delete(); }
  };
  // Circular quarter boundaries are artificial. Keep guide contacts inside a
  // patch where possible, so a smooth circular profile does not acquire an
  // arbitrary sequential G2 boundary condition through a guide.
  let circlePhase=0;
  if(continuity==='G2'&&matched.every((section)=>section.circle)){
    const quarter=Math.PI/2,tau=2*Math.PI,contacts=[];
    for(const guide of guides){
      const pair=matched.map((section)=>{
        const {c,r,n,u}=section.circle,x=unit(rej(u,n)),y=cross(n,x);
        const p=ends(guide.wire).find((p)=>Math.abs(dot(sub(p,c),n))<=GUIDE_CONTACT_TOLERANCE&&Math.abs(len(sub(p,c))-r)<=GUIDE_CONTACT_TOLERANCE);
        return p?Math.atan2(dot(sub(p,c),y),dot(sub(p,c),x)):null;
      });
      if(pair.every((angle)=>angle!=null))contacts.push(pair);
    }
    const angles=contacts.flat().map((angle)=>((angle%quarter)+quarter)%quarter).sort((a,b)=>a-b);
    let best=-1;
    for(let i=0;i<angles.length;i++){
      const gap=(i+1<angles.length?angles[i+1]:angles[0]+quarter)-angles[i],phase=(angles[i]+gap/2)%quarter;
      const patch=(angle)=>Math.floor((((angle-phase)%tau)+tau)%tau/quarter);
      if(gap>best&&contacts.every(([a,b])=>patch(a)===patch(b))){best=gap;circlePhase=phase;}
    }
  }
  try {
    // Split circular sections into patches: a periodic cylindrical face is not a disk-like filling domain.
    const original = matched.map((section, i) => {
      if (!section.circle) return options.profileWires?.[i] || sectionWire(section);
      const { c, r, n, u } = section.circle, x = unit(rej(u, n)), y = cross(n, x);
      const at = (t) => add(c, add(mul(x, r * Math.cos(t)), mul(y, r * Math.sin(t))));
      return R.assembleWire([0, 1, 2, 3].map((j) => R.makeThreePointArc(at(circlePhase+j * Math.PI / 2), at(circlePhase+(j + 0.5) * Math.PI / 2), at(circlePhase+(j + 1) * Math.PI / 2))));
    });
    owned.push(...original.filter((wire) => !options.profileWires?.includes(wire)));
    if(continuity==='G2'){
      const angular=Math.sin(0.5*Math.PI/180);
      for(const wire of original){
        const edges=wire.edges;
        try{
          for(const guide of guides)for(const t of [0,1]){
            const p=point(guide.wire,t),tangents=[];
            for(const edge of edges)for(const end of [0,1])if(near(point(edge,end),p)){
              const tangent=edge.tangentAt(end);try{tangents.push(unit(vec(tangent)));}finally{tangent.delete();}
            }
            if(tangents.length!==2)continue;
            const normal=cross(tangents[0],tangents[1]);
            if(len(normal)<=angular)continue;
            const tangent=guide.wire.tangentAt(t);let transverse;
            try{transverse=Math.abs(dot(unit(normal),unit(vec(tangent))))>angular;}finally{tangent.delete();}
            if(transverse)throw new Error('G2 continuity is incompatible with a sharp profile corner crossed transversely by the guide. Choose C0 or move the guide contact onto a smooth profile segment');
          }
        }finally{edges.forEach((edge)=>edge.delete());}
      }
    }
    scaffold = options.build(original);
    const faces = scaffold.faces, assignments = faces.map(() => []);
    for (const guide of guides) {
      const endpoints = ends(guide.wire);
      const connects = (a, b) => distance(endpoints[a], original[0]) <= GUIDE_CONTACT_TOLERANCE && distance(endpoints[b], original[1]) <= GUIDE_CONTACT_TOLERANCE;
      if (!connects(0, 1) && !connects(1, 0)) throw new Error(`The guide ${guide.name} must start on one profile and end on the other for CAD constraints`);
      let assigned = false;
      faces.forEach((face, i) => {
        if (endpoints.every((p) => distance(p, face) <= GUIDE_CONTACT_TOLERANCE)) { assignments[i].push(guide); assigned = true; }
      });
      if (!assigned) throw new Error(`The guide ${guide.name} must start and end on corresponding profile patches for CAD constraints; split the profiles at its contacts`);
    }
    let constraintError = 0;
    for (let i = 0; i < faces.length; i++) {
      if (!assignments[i].length) { patches.push(faces[i]); continue; }
      const face = faces[i], boundary = face.edges, internal = [], replaced = new Map();
      for (const guide of assignments[i]) {
        const [a, b] = ends(guide.wire);
        const seam = boundary.find((edge) => { const [x, y] = ends(edge); return (near(x, a) && near(y, b)) || (near(x, b) && near(y, a)); });
        if (seam) {
          if (replaced.has(seam)) throw new Error('Two guides compete for the same patch boundary');
          replaced.set(seam, guide.wire.edges);
        } else internal.push(guide.wire);
      }
      const domains = [boundary.flatMap((edge) => replaced.get(edge) || [edge])];
      for (const guide of internal) {
        const contacts = ends(guide);
        const domain = domains.findIndex((edges) => contacts.every((p) => edges.some((edge) => distance(p, edge) <= GUIDE_CONTACT_TOLERANCE)));
        if (domain < 0) throw new Error('The guide network crosses patch boundaries incompatibly; split the profiles at guide contacts');
        const edges = order(domains[domain].flatMap((edge) => splitAt(edge, contacts)));
        const starts = edges.map((edge) => point(edge, edge.orientation === 'backward' ? 1 : 0));
        const [a, b] = contacts.map((p) => starts.findIndex((q) => near(p, q)));
        if (a < 0 || b < 0 || a === b) throw new Error('The guide could not split the patch at two distinct profile contacts');
        const path = (from, to) => { const out = []; for (let j = from; j !== to; j = (j + 1) % edges.length) out.push(edges[j]); return out; };
        domains.splice(domain, 1, [...path(a, b), ...guide.edges], [...path(b, a), ...guide.edges]);
      }
      if (continuity !== 'C0' && internal.length && !replaced.size && typeof R.getOC().RazorCADSurfacePatch?.BuildNetwork === 'function') {
        // Solve internal guides on one smooth surface, then trim its domains. Building
        // both sides independently imposes arbitrary curvature from the first side.
        const oc=R.getOC(), wires=domains.map((domain)=>R.assembleWire(order(domain)));
        const network=R.makeCompound(wires);let group,failure;
        try {
          // A guide already on the scaffold should not deform an exact plane,
          // cylinder or cone. Project its trimming curves and verify them first.
          if(typeof oc.RazorCADSurfacePatch.BuildNetworkOnSurface==='function'){
            const sp=stack?.get();
            try{
              const raw=oc.RazorCADSurfacePatch.BuildNetworkOnSurface(network.wrapped,face.wrapped,CONSTRAINED_GUIDE_TOLERANCE);
              try{group=R.cast(raw);}finally{raw.delete();}
            }catch(e){if(isFatal(e))throw e;}finally{if(sp!=null)stack.set(sp);}
          }
          for(const resolution of group?[]:[16,32,64,128]) {
            const sp=stack?.get();
            try {
              stage=`solving the ${continuity} guide network (${resolution} subdivisions)`;
              const raw=oc.RazorCADSurfacePatch.BuildNetwork(network.wrapped,2,CONSTRAINED_GUIDE_TOLERANCE,resolution,12);
              try{group=R.cast(raw);}finally{raw.delete();}break;
            }catch(e){if(isFatal(e))throw e;failure=e instanceof WebAssembly.Exception?oc.getExceptionMessage(e).join(': '):e.message||String(e);if(/native guide constraints did not converge|no matching support boundary/.test(failure))break;}
            finally{if(sp!=null)stack.set(sp);}
          }
          if(!group)throw new Error(`${continuity} guide network failed bounded refinement: ${failure}`);
          const faces=group.faces;owned.push(...faces);patches.push(...faces);
          for(const guide of internal)for(const edge of guide.edges){
            const [a,b]=ends(edge);
            const adjacent=faces.filter((face)=>face.edges.some((other)=>{
              const [x,y]=ends(other);
              return ((near(a,x)&&near(b,y))||(near(a,y)&&near(b,x)))&&[0.25,0.5,0.75].every((t)=>distance(point(edge,t),other)<=GUIDE_CONTACT_TOLERANCE);
            }));
            if(adjacent.length!==2)throw new Error(`A ${continuity} internal guide did not split two native domains`);
            seams.push({edge,a:adjacent[0],b:adjacent[1]});
          }
        }finally{group?.delete();network.delete();wires.forEach((wire)=>wire.delete());}
        continue;
      }
      for (const domain of domains) {
        const edges = order(domain);
        const oc = R.getOC(), filling = new oc.BRepOffsetAPI_MakeFilling(3, 25, 3, false, 1e-7, 1e-6, continuity === 'G1' ? 0.001 : 0.01, 0.1, 10, 16);
        const supports = [], nativeEdges = [];
        try {
          stage = 'adding ' + continuity + ' constraints';
          for (const edge of edges) {
            let support = null;
            if (continuity !== 'C0' && guideEdges.some((g) => g.isSame(edge))) {
              const [a, b] = ends(edge);
              for (const face of patches) {
                const candidate = face.edges.find((other) => {
                  const [x, y] = ends(other);
                  return ((near(a, x) && near(b, y)) || (near(a, y) && near(b, x))) && [0.25, 0.5, 0.75].every((t) => distance(point(edge, t), other) <= GUIDE_CONTACT_TOLERANCE);
                });
                if (candidate) { support = { face, edge: candidate }; break; }
              }
            }
            nativeEdges.push(support?.edge || edge);
            if (support) {
              if (continuity !== 'G2') filling.Add(support.edge.wrapped, support.face.wrapped, oc.GeomAbs_Shape.GeomAbs_G1, true);
              supports.push(support);
            } else if (continuity !== 'G2') filling.Add(edge.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
          }
          if (continuity === 'G2') {
            const wire = R.assembleWire(order(nativeEdges)), references = R.makeCompound([...new Set(supports.map((s) => s.face))]);
            let patch, failure;
            try {
              for (const resolution of [16,32,64,128]) {
                const sp = stack?.get();
                try {
                  stage = `solving G2 constraints (${supports.length} support edges, ${resolution} subdivisions)`;
                  const raw = oc.RazorCADSurfacePatch.Build(wire.wrapped,references.wrapped,2,CONSTRAINED_GUIDE_TOLERANCE,resolution,12,1);
                  try { patch=R.cast(raw); } finally { raw.delete(); }
                  break;
                } catch (e) {
                  if (isFatal(e)) throw e;
                  failure = e instanceof WebAssembly.Exception ? oc.getExceptionMessage(e).join(': ') : e.message || String(e);
                  if (/native guide constraints did not converge|no matching support boundary/.test(failure)) break;
                } finally { if (sp != null) stack.set(sp); }
              }
              if (!patch) throw new Error(`G2 guide constraints failed bounded refinement while ${stage}: ${failure}`);
              owned.push(patch); patches.push(patch);
              for (const support of supports) seams.push({edge:support.edge,a:support.face,b:patch});
            } finally { references.delete(); wire.delete(); }
            continue;
          }
          stage = `solving ${continuity} constraints (${supports.length} support edges)`; filling.Build();
          if (!filling.IsDone()) throw new Error('The CAD guide constraints could not be solved');
          stage = 'checking kernel constraint errors'; const error = filling.G0Error();
          if (!Number.isFinite(error) || error > CONSTRAINED_GUIDE_TOLERANCE) throw new Error(`The CAD guide constraints exceed ${CONSTRAINED_GUIDE_TOLERANCE} mm (kernel error ${error})`);
          constraintError = Math.max(constraintError, error);
          if (supports.length) {
            if (!Number.isFinite(filling.G1Error()) || filling.G1Error() > 0.5 * Math.PI / 180) throw new Error('The requested guide tangency could not be satisfied');
          }
          const patch = R.cast(filling.Shape()); owned.push(patch); patches.push(patch);
          for (const support of supports) seams.push({ edge: support.edge, a: support.face, b: patch });
        } finally { filling.delete(); }
      }
    }
    stage = 'sewing CAD patches'; sewn = sewShapes(patches, CONSTRAINED_GUIDE_TOLERANCE);
    if (options.surface) result = sewn;
    else {
      if (holeLoops(sewn).freeEdges) throw new Error('The constrained guide patches could not be sewn into a closed solid');
      result = solidFromSewn(sewn);
      if (!result) throw new Error('The constrained guide patches did not make a valid solid');
    }
    stage = 'validating CAD shape'; const validity = new (R.getOC()).BRepCheck_Analyzer(result.wrapped, true);
    try { if (!validity.IsValid()) throw new Error('The CAD guide constraints produced an invalid boundary representation'); }
    finally { validity.delete(); }
    // Find every shared guide edge, including C0 seams, so an unmatched support cannot silently bypass G1.
    const sameEdge = (a, b) => {
      const [x, y] = ends(a), [u, v] = ends(b);
      return ((near(x, u) && near(y, v)) || (near(x, v) && near(y, u))) && [0.25, 0.5, 0.75].every((t) => distance(point(a, t), b) <= GUIDE_CONTACT_TOLERANCE);
    };
    const joined = [];
    for (const edge of guideEdges) {
      const adjacent = patches.filter((face) => face.edges.some((other) => sameEdge(edge, other)));
      if (!adjacent.length || adjacent.length > 2) throw new Error('A guide did not form a valid patch boundary');
      if (adjacent.length === 2) {
        if (continuity !== 'C0' && !seams.some((s) => ((s.a === adjacent[0] && s.b === adjacent[1]) || (s.a === adjacent[1] && s.b === adjacent[0])) && sameEdge(edge, s.edge))) throw new Error(`The ${continuity} guide seam has no matching CAD support surface`);
        joined.push({ edge, a: adjacent[0], b: adjacent[1] });
      }
    }
    let maxAngle = 0, maxCurvature = 0;
    // Independent normal checks on native surfaces, rather than only the filling builder's errors.
    stage = 'checking CAD surface normals';
    resultFaces = result.faces;
    if (continuity === 'G2') {
      for (const seam of joined) {
        const adjacent=resultFaces.filter((face)=>{
          const edges=face.edges;
          try{return edges.some((edge)=>sameEdge(seam.edge,edge));}finally{edges.forEach((edge)=>edge.delete());}
        });
        if(adjacent.length!==2)throw new Error('A sewn G2 seam lost its two adjacent faces');
        const [faceA,faceB]=adjacent,edgesA=faceA.edges,edgesB=faceB.edges;
        try {
          const a=edgesA.find((e)=>sameEdge(seam.edge,e)),b=edgesB.find((e)=>sameEdge(seam.edge,e));
          if (!a || !b) throw new Error('A final G2 seam lost its native boundary');
          for (let j=0;j<33;j++) {
            const t=(1-Math.cos(Math.PI*(j+0.5)/33))/2,p=point(seam.edge,t), tangent=seam.edge.tangentAt(t);
            const uv=(edge,face)=>{const q=R.getOC().RazorCADSurfacePatch.UV(edge.wrapped,face.wrapped,t);try{return [q.X(),q.Y()];}finally{q.delete();}};
            let q;
            try { q=compareSurfaceContinuity(R,faceA,faceB,p,vec(tangent),{leftUV:uv(a,faceA),rightUV:uv(b,faceB)}); }
            finally { tangent.delete(); }
            if (q.positionError>CONSTRAINED_GUIDE_TOLERANCE || q.angle>0.5 || q.curvatureError>0.001)
              throw new Error(`The final G2 guide seam failed verification (${q.positionError} mm, ${q.angle} deg, ${q.curvatureError} 1/mm)`);
            constraintError=Math.max(constraintError,q.positionError); maxAngle=Math.max(maxAngle,q.angle); maxCurvature=Math.max(maxCurvature,q.curvatureError);
          }
        } finally {edgesA.forEach((e)=>e.delete());edgesB.forEach((e)=>e.delete());}
      }
    } else {
      const normalAtSeam=(face,edge,t,p)=>{
        const oc=R.getOC();
        if(continuity === 'C0' || typeof oc.RazorCADSurfacePatch?.UV!=='function'){
          const n=face.normalAt(p);try{return unit(vec(n));}finally{n.delete();}
        }
        const edges=face.edges;let uv;
        try {
          const native=edges.find((e)=>sameEdge(edge,e));
          if(!native)throw new Error('A guide seam lost its native parameter curve');
          const parameter=len(sub(point(native,t),p))<=CONSTRAINED_GUIDE_TOLERANCE?t:1-t;
          uv=oc.RazorCADSurfacePatch.UV(native.wrapped,face.wrapped,parameter);
          const value=surfaceNormalAtUV(R,face,[uv.X(),uv.Y()]);
          if(len(sub(value.position,p))>CONSTRAINED_GUIDE_TOLERANCE){
            // Legacy filling surfaces may reparameterize their boundary curves.
            const n=face.normalAt(p);try{return unit(vec(n));}finally{n.delete();}
          }
          return value.normal;
        }finally{uv?.delete();edges.forEach((e)=>e.delete());}
      };
      for (const seam of joined) for (let j = 0; j < 9; j++) {
        const t=(j+0.5)/9,p=point(seam.edge,t);
        const a=normalAtSeam(seam.a,seam.edge,t,p),b=normalAtSeam(seam.b,seam.edge,t,p);
        const angle=Math.acos(Math.min(1,Math.abs(dot(a,b))));
        if (!Number.isFinite(angle) || (continuity !== 'C0' && angle > 0.5 * Math.PI / 180)) throw new Error(`The ${continuity} guide seam failed the CAD normal check (${angle * 180 / Math.PI} degrees)`);
        maxAngle = Math.max(maxAngle, angle * 180 / Math.PI);
      }
    }
    // Independent face-distance checks catch incompatible/ignored constraints and trimming problems.
    // (Kernel Lab) a point passes as soon as it is shown to be within the tolerance of a face: first of an edge of the
    // faces (the guide points lie on the seams; an edge is within its own tolerance of its faces, so that is added),
    // then by the local contact search (nearFacePoint: only ever a point on the face), nearest by box first; otherwise
    // the general distance to every face, as before. The same verdicts: the general queries took 16 of 17 s on a
    // tight G2 spline loft.
    const oc = R.getOC(), seamEdges = [];
    try {
      for (const face of resultFaces) for (const edge of face.edges) {
        if (seamEdges.some((x) => x.edge.isSame(edge))) { edge.delete(); continue; }
        seamEdges.push({ edge, box: bbox(edge), tol: oc.BRep_Tool.Tolerance(edge.wrapped) });
      }
      const boxes = resultFaces.map((face) => bbox(face));
      const nearest = (items, p) => items.map((x, i) => [boxDist(x.box ?? x, p), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      for (const { p, name } of contact.checkPoints) {
        if (nearest(seamEdges, p).some(([d, i]) => d <= CONSTRAINED_GUIDE_TOLERANCE && distance(p, seamEdges[i].edge) + seamEdges[i].tol <= CONSTRAINED_GUIDE_TOLERANCE)) continue;
        if (nearest(boxes, p).some(([, i]) => { const q = nearFacePoint(resultFaces[i], p, CONSTRAINED_GUIDE_TOLERANCE); return !!q && len(sub(q, p)) <= CONSTRAINED_GUIDE_TOLERANCE; })) continue;
        const error = Math.min(...resultFaces.map((face) => distance(p, face)));
        if (!Number.isFinite(error) || error > CONSTRAINED_GUIDE_TOLERANCE) throw new Error(`The guide ${name} failed the final CAD constraint check (${error} mm)`);
      }
    } finally { seamEdges.forEach((x) => x.edge.delete()); }
    return { shape: result, holes: [], constraintError, guideQuality: { continuity, seams: joined.length, maxAngle, maxCurvature } };
  } catch (e) { result?.delete(); if (isFatal(e) || e?.message) throw e; throw new Error(`${continuity} guide construction failed while ${stage}; the constraints could not be computed`); }
  finally {
    if (sewn && sewn !== result) sewn.delete();
    scaffold?.delete(); owned.forEach((shape) => shape.delete()); resultFaces.forEach((face)=>face.delete());
    for (const wire of [...contact.outer, ...contact.holes.flat()]) if (!options.profileWires?.includes(wire)) wire.delete();
  }
}

// Wires (a surface loft's profiles, in order, each running the same way as the one before) as sections of points
// for guidedLoftWires: each edge one segment when every profile has as many edges, else each profile cut into
// WIRE_PIECES equal lengths. open: open wires (from one end to the other).
const WIRE_PIECES = 8;
function wireSections(wires, open) {
  const runsOf = (w) => {
    const runs = w.edges.map((e) => Array.from({ length: 33 }, (_, i) => vec(e.pointAt(i / 32))));
    const out = [runs.shift()];
    const tol = 1e-4 * Math.max(1, ...out[0].map((q) => len(q)));
    while (runs.length) {
      const end = out[out.length - 1].at(-1), start = out[0][0];
      let k = runs.findIndex((r) => len(sub(r[0], end)) < tol || len(sub(r.at(-1), end)) < tol);
      if (k >= 0) { const r = runs.splice(k, 1)[0]; out.push(len(sub(r[0], end)) < tol ? r : r.reverse()); continue; }
      k = runs.findIndex((r) => len(sub(r[0], start)) < tol || len(sub(r.at(-1), start)) < tol);
      if (k < 0) { out.push(runs.shift()); continue; }
      const r = runs.splice(k, 1)[0];
      out.unshift(len(sub(r.at(-1), start)) < tol ? r : r.reverse());
    }
    return out;
  };
  const all = wires.map(runsOf);
  // (an open profile: from its wire's start, the way the wire runs, as lofted)
  for (let k = 0; k < all.length && open; k++) {
    const st = vec(wires[k].startPoint);
    if (len(sub(all[k].at(-1).at(-1), st)) < len(sub(all[k][0][0], st))) all[k] = all[k].reverse().map((r) => r.slice().reverse());
  }
  const seg = (pts) => { const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + len(sub(pts[i], pts[i - 1]))); return { type: 'pts', pts, L }; };
  if (all.every((r) => r.length === all[0].length)) return all.map((runs) => ({ segs: runs.map(seg) }));
  return all.map((runs) => {
    const whole = seg(runs.flatMap((r, i) => (i ? r.slice(1) : r))), T = whole.L.at(-1), pts = whole.pts, L = whole.L;
    const at = (s) => { let i = 1; while (i < L.length - 1 && L[i] < s) i++; const u = (s - L[i - 1]) / ((L[i] - L[i - 1]) || 1); return add(pts[i - 1], mul(sub(pts[i], pts[i - 1]), u)); };
    return { segs: Array.from({ length: WIRE_PIECES }, (_, p) => seg(Array.from({ length: 17 }, (_, j) => at((T * (p + j / 16)) / WIRE_PIECES)))) };
  });
}

function sectionWire(s) {
  if (s.circle) return R.assembleWire([R.makeCircle(s.circle.r, s.circle.c, s.circle.n)]);
  return R.assembleWire(s.segs.map((g) => (g.type === 'line' ? R.makeLine(g.a, g.b) : g.type === 'bezier' ? R.makeBezierCurve([g.a, g.c1, g.c2, g.b]) : R.makeThreePointArc(g.a, g.m, g.b))));
}

// A closed loop of 2D sketch segments as a 3D wire.
function loopWire(fr, segs) {
  const sec = loftSection(fr, segs);
  return sectionWire(sec);
}

// ---- text
// Fonts are sent by the interface (from the PC's font folder) and registered under "Family|BI".
const fontKey = (t) => `${t.font || 'Arial'}|${t.bold ? 'B' : ''}${t.italic ? 'I' : ''}`;
function fontFor(t) {
  const f = R.getFont(fontKey(t));
  if (!f) throw new Error(`The font "${t.font || 'Arial'}" is not available`);
  return f;
}
// The text height is the height of capital letters.
const fontSizeFor = (font, h) => (h * font.unitsPerEm) / (font.tables.os2?.sCapHeight || font.unitsPerEm * 0.7);

// One drawing per gear of the sketch's gear trains: { outline, bore }.
function gearDrawings(sk) {
  const out = [];
  for (const tr of sk.gearTrains || []) {
    const probs = S.trainProblems(sk, tr);
    if (probs.length) throw new Error(`The gear train in the sketch doesn't work: ${probs[0]}. Edit the sketch and click Fit gears to the lines`);
    for (const g of S.trainGears(sk, tr)) {
      const pts = S.gearOutline(g);
      const pen = R.draw(pts[0]);
      for (let i = 1; i < pts.length; i++) pen.lineTo(pts[i]);
      out.push({ outline: pen.close(), bore: g.bore > 0 ? R.drawSingleCircle(g.bore / 2).translate(g.cx, g.cy) : null });
    }
  }
  return out;
}

// One drawing per airfoil of the sketch (smooth Bézier pieces): { outline }.
function airfoilDrawings(sk) {
  const out = [];
  for (const af of sk.airfoils || []) {
    const why = S.airfoilProblem(sk, af);
    if (why) throw new Error(`An airfoil in the sketch can't be drawn: ${why}`);
    const pieces = S.airfoilPieces(sk, af);
    const pen = R.draw(pieces[0].a);
    pieces.forEach((q, i) => {
      const last = i === pieces.length - 1;
      if (last && !q.c1) return; // (the straight piece across a blunt trailing edge: close() draws it)
      if (q.c1) pen.cubicBezierCurveTo(q.b, q.c1, q.c2); else pen.lineTo(q.b);
    });
    out.push({ outline: pen.close(), bore: null });
  }
  return out;
}

function textDrawing(sk) {
  let all = null;
  for (const t of sk.texts || []) {
    if (!t.text?.trim()) continue;
    const font = fontFor(t);
    let d = R.drawText(t.text, { fontSize: fontSizeFor(font, t.h), fontFamily: fontKey(t) });
    if (t.angle) d = d.rotate(t.angle, [0, 0]);
    d = d.translate(t.x, t.y);
    all = all ? all.fuse(d) : d;
  }
  return all;
}

// Outlines of texts as polylines in sketch coordinates: { textId: [[x, y], ...][] }.
function textOutlines(texts) {
  const out = {};
  for (const t of texts || []) {
    let font;
    try { font = fontFor(t); } catch { out[t.id] = []; continue; }
    const size = fontSizeFor(font, t.h), a = ((t.angle || 0) * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const P2 = (x, y) => [t.x + x * ca - y * sa, t.y + x * sa + y * ca];
    const polys = [];
    let cur = null, lx = 0, ly = 0;
    for (const c of font.getPath(t.text || '', 0, 0, size).commands) {
      if (c.type === 'M') { if (cur?.length > 1) polys.push(cur); cur = [P2(c.x, -c.y)]; lx = c.x; ly = c.y; }
      else if (c.type === 'L') { cur?.push(P2(c.x, -c.y)); lx = c.x; ly = c.y; }
      else if (c.type === 'Q') {
        for (let i = 1; i <= 8; i++) { const s = i / 8, u = 1 - s; cur?.push(P2(u * u * lx + 2 * u * s * c.x1 + s * s * c.x, -(u * u * ly + 2 * u * s * c.y1 + s * s * c.y))); }
        lx = c.x; ly = c.y;
      } else if (c.type === 'C') {
        for (let i = 1; i <= 10; i++) { const s = i / 10, u = 1 - s; cur?.push(P2(u * u * u * lx + 3 * u * u * s * c.x1 + 3 * u * s * s * c.x2 + s * s * s * c.x, -(u * u * u * ly + 3 * u * u * s * c.y1 + 3 * u * s * s * c.y2 + s * s * s * c.y))); }
        lx = c.x; ly = c.y;
      } else if (c.type === 'Z' && cur?.length) { cur.push(cur[0]); polys.push(cur); cur = null; }
    }
    if (cur?.length > 1) polys.push(cur);
    out[t.id] = polys;
  }
  return out;
}

// Axis { o, d } of a cylindrical or conical face (null for other faces).
function faceAxis(face) {
  const t = face.geomType;
  if (t !== 'CYLINDRE' && t !== 'CONE' && t !== 'TORUS') return null;
  const oc = R.getOC();
  const ad = new oc.BRepAdaptor_Surface(face.wrapped, false);
  try {
    const ax = (t === 'CYLINDRE' ? ad.Cylinder() : t === 'CONE' ? ad.Cone() : ad.Torus()).Axis(), L = ax.Location(), D = ax.Direction();
    return { o: [L.X(), L.Y(), L.Z()], d: unit([D.X(), D.Y(), D.Z()]) };
  } catch {
    return null; // (this kernel build cannot read a cone's axis: the face is measured without it)
  } finally { ad.delete(); }
}

// ------------------------------------------------------------ direct editing: fillets, chamfers and holes taken out
// The faces of `shape` sharing an edge with `face`, each once, with the edges they share.
function faceNeighbours(shape, face) {
  const out = [], all = shape.faces;
  for (const e of face.edges) for (const g of all) {
    if (g.isSame(face) || !g.edges.some((x) => x.isSame(e))) continue;
    let nb = out.find((x) => x.face.isSame(g));
    if (!nb) out.push((nb = { face: g, edges: [] }));
    nb.edges.push(e);
  }
  return out;
}
const solidAt = (shape, p) => new R.DistanceQuery(R.makeVertex(p)).distanceTo(shape) < 1e-9;
const edgeEnds = (edges) => edges.flatMap((x) => [vec(x.startPoint), vec(x.endPoint)]);
function faceHasSeam(face) {
  const oc = R.getOC(), T = oc.TopAbs_ShapeEnum, seen = [];
  const ex = new oc.TopExp_Explorer(face.wrapped, T.TopAbs_EDGE, T.TopAbs_SHAPE);
  try {
    while (ex.More()) { const e = ex.Current(); if (seen.some((x) => x.IsSame(e))) return true; seen.push(e); ex.Next(); }
    return false;
  } finally { ex.delete(); }
}
// The corner a fillet or chamfer face cut off (or filled in): { tool, convex, edge, chamfer, r }. A round on a straight
// edge (a cylinder tangent to two flat faces), a ring round (a full torus between a flat face and a coaxial round face)
// or a chamfer (a flat strip between two flat faces). The tool is the piece between the face and the sharp corner where
// its neighbours meet, extended (plus the round's own sector): fused back on (a convex edge) or cut away (a concave
// one) it leaves the sharp edge `edge` ({ kind: 'line', p, d } or { kind: 'circle', o, d, r }).
function blendCorner(shape, face) {
  const s = surfOf(face), nb = faceNeighbours(shape, face), big = bbox(shape).diag + 10;
  if (s.t === 'TORUS') {
    const pl = nb.find((x) => x.face.geomType === 'PLANE'), cy = nb.find((x) => x.face.geomType === 'CYLINDRE');
    if (nb.length !== 2 || !pl || !cy) throw new Error('A round on a circular edge must go all the way round, between a flat face and a round face');
    const d = s.d, o = s.p, sp = surfOf(pl.face), sc = surfOf(cy.face);
    if (len(cross(sp.n, d)) > 1e-6 || len(cross(sc.d, d)) > 1e-6 || len(cross(sub(sc.p, o), d)) > 1e-6) throw new Error('The faces either side of the round are not square to it and on its axis');
    const zA = dot(sub(sp.p, o), d), rB = sc.r;
    if (Math.abs(Math.abs(zA) - s.r2) > 1e-6 || Math.abs(Math.abs(rB - s.r) - s.r2) > 1e-6) throw new Error('The round is not tangent to the faces either side');
    const u = unit(cross(d, Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), P = (rho, z) => add(add(o, mul(u, rho)), mul(d, z));
    const tool = R.revolution(R.makePolygon([P(s.r, 0), P(s.r, zA), P(rB, zA), P(rB, 0)]), o, d, 360);
    return { tool, convex: !solidAt(shape, P(rB, zA)), edge: { kind: 'circle', o: add(o, mul(d, zA)), d, r: rB }, chamfer: false, r: s.r2 };
  }
  if (s.t !== 'CYLINDER' && s.t !== 'PLANE') throw new Error('That face is not a fillet or a chamfer');
  const lineDir = (x) => unit(sub(vec(x.endPoint), vec(x.startPoint)));
  let e = s.d;
  if (s.t === 'PLANE') {
    const lines = face.edges.filter((x) => x.geomType === 'LINE').sort((a, b) => edgeLength(b) - edgeLength(a));
    if (!lines.length) throw new Error('A chamfer face has straight edges');
    e = lineDir(lines[0]);
  }
  const along = (x) => x.geomType === 'LINE' && len(cross(lineDir(x), e)) < 1e-6;
  const sides = nb.filter((x) => x.face.geomType === 'PLANE' && x.edges.some(along) && Math.abs(dot(surfOf(x.face).n, e)) < 1e-6);
  if (sides.length !== 2 || (s.t === 'PLANE' && sides.some((x) => Math.abs(dot(surfOf(x.face).n, s.n)) < 1e-6))) throw new Error(s.t === 'PLANE' ? 'That face is not a chamfer between two flat faces' : 'That round does not run between two flat faces');
  const p0 = s.t === 'CYLINDER' ? s.p : vec(sides[0].edges.find(along).startPoint), proj = (q) => sub(q, mul(e, dot(sub(q, p0), e)));
  const [A, B] = sides.map((x) => ({ n: surfOf(x.face).n, T: proj(vec(x.edges.find(along).startPoint)) }));
  if (s.t === 'CYLINDER') for (const X of [A, B]) if (Math.abs(Math.abs(dot(sub(X.T, s.p), X.n)) - s.r) > 1e-6 || len(cross(X.n, unit(sub(X.T, proj(s.p))))) > 1e-6) throw new Error('The round is not tangent to the faces either side');
  const tA = cross(e, A.n), den = dot(tA, B.n);
  if (Math.abs(den) < 1e-9) throw new Error('The faces either side are parallel (a full round): there is no corner to go back to');
  const C = add(A.T, mul(tA, dot(sub(B.T, A.T), B.n) / den));
  const ts = edgeEnds(face.edges).map((q) => dot(sub(q, p0), e)), t0 = Math.min(...ts), t1 = Math.max(...ts), mid = (t0 + t1) / 2;
  const convex = !solidAt(shape, add(C, mul(e, mid)));
  if (s.t === 'CYLINDER' && solidAt(shape, add(proj(s.p), mul(e, mid))) !== convex) throw new Error('That face is not a fillet');
  const prof = (s.t === 'CYLINDER' ? [proj(s.p), A.T, C, B.T] : [A.T, C, B.T]).map((q) => add(q, mul(e, t0 - big)));
  let tool = R.basicFaceExtrusion(R.makePolygon(prof), new R.Vector(mul(e, t1 - t0 + 2 * big)));
  // (cut back to the planes of the faces at its ends, kept on the side the face is on)
  const fc = vec(face.center);
  let lo = false, hi = false;
  for (const x of nb) {
    if (sides.includes(x)) continue;
    if (x.face.geomType !== 'PLANE') throw new Error('The ends of the fillet or chamfer must meet flat faces');
    const sx = surfOf(x.face);
    if (Math.abs(dot(sx.n, e)) < 1e-6) continue;
    const k = mul(sx.n, Math.sign(dot(sub(fc, sx.p), sx.n)) || 1), u = unit(cross(k, Math.abs(k[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    tool = tool.intersect(R.drawRectangle(4 * big, 4 * big).sketchOnPlane(new R.Plane(sx.p, u, k)).extrude(4 * big));
    if (dot(k, e) > 0) lo = true; else hi = true;
  }
  if (!lo || !hi) throw new Error('The ends of the fillet or chamfer must meet flat faces');
  return { tool, convex, edge: { kind: 'line', p: C, d: e }, chamfer: s.t === 'PLANE', r: s.r };
}
// The edges of `shape` along a sharp edge left by blendCorner.
function edgesAlong(shape, g) {
  return shape.edges.filter((x) => {
    const q = [vec(x.startPoint), vec(x.endPoint)];
    if (g.kind === 'line') return x.geomType === 'LINE' && q.every((p) => len(cross(sub(p, g.p), g.d)) < 1e-6);
    return x.geomType === 'CIRCLE' && q.every((p) => Math.abs(dot(sub(p, g.o), g.d)) < 1e-6 && Math.abs(len(cross(sub(p, g.o), g.d)) - g.r) < 1e-6);
  });
}
// A hole filled in: the coaxial cylinders and cones round a concave cylinder face (its counterbore, countersink, drill
// point), every one ending at circles, none wider than maxD. null: not such a hole.
function holeFill(shape, face, maxD) {
  const s = surfOf(face);
  if (s.t !== 'CYLINDER' || !faceHasSeam(face)) return null;
  const { p: o, d } = s, onAxis = (x) => { const a = faceAxis(x); return a && len(cross(a.d, d)) < 1e-6 && len(cross(sub(a.o, o), d)) < 1e-6; };
  const group = [face], todo = [face];
  while (todo.length) {
    for (const nb of faceNeighbours(shape, todo.pop())) {
      if (group.some((g) => g.isSame(nb.face))) continue;
      const t = nb.face.geomType;
      if ((t === 'CYLINDRE' || t === 'CONE') && onAxis(nb.face)) { group.push(nb.face); todo.push(nb.face); }
      // (a counterbore's floor: a flat ring square to the axis, between coaxial circles)
      else if (t === 'PLANE' && len(cross(surfOf(nb.face).n, d)) < 1e-6 && nb.face.edges.every((x) => x.geomType === 'CIRCLE' && len(cross(sub(circleOf(x)?.c ?? [NaN, NaN, NaN], o), d)) < 1e-6)) { group.push(nb.face); todo.push(nb.face); }
    }
  }
  let tool = null;
  for (const g of group) {
    if (g.geomType === 'PLANE') continue;
    for (const x of g.edges) {
      if (x.geomType === 'CIRCLE') { const q = vec(x.startPoint); if (len(cross(sub(q, o), d)) * 2 > maxD + 1e-9) return null; continue; }
      // (else only its seam: a line in a plane through the axis)
      if (!(x.geomType === 'LINE' && Math.abs(dot(cross(unit(sub(vec(x.endPoint), vec(x.startPoint))), d), sub(vec(x.startPoint), o))) < 1e-6 && faceHasSeam(g))) return null;
    }
    const pts = edgeEnds(g.edges).map((q) => [dot(sub(q, o), d), len(cross(sub(q, o), d))]);
    const a = pts.reduce((m, q) => (q[0] < m[0] ? q : m)), b = pts.reduce((m, q) => (q[0] > m[0] ? q : m));
    if (!(b[0] - a[0] > 1e-9)) continue;
    if (g === face && solidAt(shape, add(o, mul(d, (a[0] + b[0]) / 2)))) return null; // (a shaft, not a hole)
    const u = unit(cross(d, Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), P = (rho, z) => add(add(o, mul(u, rho)), mul(d, z));
    const prof = [[0, a[0]], [a[1], a[0]], [b[1], b[0]], [0, b[0]]].filter((q, i, l) => i === 0 || Math.hypot(q[0] - l[i - 1][0], q[1] - l[i - 1][1]) > 1e-9); // (a point: no corner there)
    const piece = R.revolution(R.makePolygon(prof.map(([rho, z]) => P(rho, z))), o, d, 360);
    tool = tool ? tool.fuse(piece) : piece;
  }
  return tool && { tool, count: group.length };
}
// (Kernel Lab k14) faces taken out of a solid by OpenCascade's defeaturing: their neighbours grown or shrunk to close the
// gap, any faces (fillet chains with their corner blends, holes, bosses, faces of imported parts). null: this kernel
// has no defeaturing, or it could not be done.
function labDefeature(shape, faces) {
  const oc = R.getOC();
  if (!oc.LabDefeature || !faces.length) return null;
  const comp = R.makeCompound(faces.map((x) => x.clone())); // (copies: the compound takes what it is given)
  let out = null;
  try {
    out = oc.LabDefeature.Remove(shape.wrapped, comp.wrapped, kernelThreads > 1);
    if (!out || out.IsNull()) { out?.delete?.(); return null; }
    const sh = R.cast(out);
    return solidsOf(sh).length ? sh : null;
  } catch (e) { if (isFatal(e)) throw e; return null; }
}
const labDefeatureError = () => { try { return R.getOC().LabDefeature?.LastError() || ''; } catch { return ''; } };
// The edges of `after` made where faces were taken out of `before`: not on before's faces, near the faces removed.
function newEdgesNear(before, after, removed) {
  const skin = R.makeCompound(before.faces), boxes = removed.map((fc) => { const b = bbox(fc), g = b.diag * 0.5 + 1e-6; return { min: b.min.map((x) => x - g), max: b.max.map((x) => x + g) }; });
  return after.edges.filter((e) => {
    const m = vec(e.pointAt(0.5));
    if (!boxes.some((b) => m.every((x, i) => x >= b.min[i] && x <= b.max[i]))) return false;
    return new R.DistanceQuery(R.makeVertex(m)).distanceTo(skin) > 1e-6;
  });
}
// The faces a defeature takes out: fillets up to maxR (round strips: open cylinders, tori, spheres at corners) and holes
// up to maxD (closed concave cylinders with their counterbores, countersinks and drill points).
function defeatureFaces(shape, maxR, maxD) {
  const out = [], have = (fc) => out.some((x) => x.isSame(fc));
  for (const fc of shape.faces) {
    if (have(fc)) continue;
    const s = surfOf(fc);
    if (maxR > 0 && ((s.t === 'CYLINDER' && s.r <= maxR + 1e-9 && !faceHasSeam(fc)) || (s.t === 'TORUS' && s.r2 <= maxR + 1e-9) || (s.t === 'SPHERE' && s.r <= maxR + 1e-9))) { out.push(fc); continue; }
    if (maxD > 0 && s.t === 'CYLINDER' && 2 * s.r <= maxD + 1e-9 && faceHasSeam(fc)) {
      const mid = holeFill(shape, fc, maxD);
      if (!mid) continue;
      // (the hole's faces: the cylinder and its coaxial neighbours)
      const { p: o, d } = s, onAxis = (x) => { const a = faceAxis(x); return a && len(cross(a.d, d)) < 1e-6 && len(cross(sub(a.o, o), d)) < 1e-6; };
      const group = [fc], todo = [fc];
      while (todo.length) for (const nb of faceNeighbours(shape, todo.pop())) {
        if (group.some((g) => g.isSame(nb.face))) continue;
        const t = nb.face.geomType;
        if ((t === 'CYLINDRE' || t === 'CONE') && onAxis(nb.face)) { group.push(nb.face); todo.push(nb.face); }
        else if (t === 'PLANE' && len(cross(surfOf(nb.face).n, d)) < 1e-6 && nb.face.edges.every((x) => x.geomType === 'CIRCLE' && len(cross(sub(circleOf(x)?.c ?? [NaN, NaN, NaN], o), d)) < 1e-6)) { group.push(nb.face); todo.push(nb.face); }
      }
      for (const g of group) if (!have(g)) out.push(g);
    }
  }
  return out;
}

// Fillets (radius up to maxR) and holes (up to maxD across) taken out of a solid, one at a time, as many as can be.
function defeatureShape(shape, maxR, maxD) {
  const bad = new Set(), key = (fc) => vec(fc.center).map((x) => x.toFixed(5)).join();
  const one = (sh) => { const l = solidsOf(sh); return l.length === 1 ? l[0] : sh; }; // (a solid, so points inside it are found)
  shape = one(shape);
  let fillets = 0, holes = 0;
  for (let pass = 0; pass < 1000; pass++) {
    let done = false;
    for (const fc of shape.faces) {
      const k = key(fc);
      if (bad.has(k)) continue;
      const s = surfOf(fc);
      try {
        if (maxR > 0 && ((s.t === 'CYLINDER' && s.r <= maxR + 1e-9 && !faceHasSeam(fc)) || (s.t === 'TORUS' && s.r2 <= maxR + 1e-9))) {
          const b = blendCorner(shape, fc), out = unify(b.convex ? shape.fuse(b.tool) : shape.cut(b.tool));
          if (solidsOf(out).length !== solidsOf(shape).length) throw new Error('split');
          shape = one(out); fillets++; done = true; break;
        }
        if (maxD > 0 && s.t === 'CYLINDER' && 2 * s.r <= maxD + 1e-9) {
          const h = holeFill(shape, fc, maxD);
          if (!h) { bad.add(k); continue; }
          shape = one(unify(shape.fuse(h.tool))); holes++; done = true; break;
        }
      } catch (e) { if (isFatal(e)) throw e; }
      bad.add(k);
    }
    if (!done) break;
  }
  return { shape, fillets, holes };
}

// DFM check of solids for machining: sharp inside corners (a concave straight edge between flat faces: a cutter
// leaves its radius there), inside rounds smaller than the smallest cutter (minR), holes smaller than minHole or
// deeper than maxRatio × their diameter, hole sizes that are not standard drills (whole or half millimetres up to
// 20, whole above), and very small faces (below tiny mm²). [{ kind, level: 'warn' | 'info', text, p }]
function dfmCheck(list, { minR = 1, minHole = 1, maxRatio = 10, tiny = 0.01 } = {}) {
  const out = [], f3 = (x) => +x.toFixed(3);
  for (const rec of list) {
    const shape = rec.shape, faces = shape.faces;
    if (faces.length > 4000) { out.push({ kind: 'size', level: 'info', text: `${rec.id}: ${faces.length} faces, too many to check here` }); continue; }
    for (const fc of faces) {
      const s = surfOf(fc), area = faceArea(fc);
      if (area < tiny) out.push({ kind: 'tiny', level: 'info', text: `A very small face (${f3(area)} mm²): an import artefact or a sliver?`, p: vec(fc.center) });
      if (s.t !== 'CYLINDER') continue;
      const closed = faceHasSeam(fc), ends = edgeEnds(fc.edges), ts = ends.map((q) => dot(sub(q, s.p), s.d)), t0 = Math.min(...ts), t1 = Math.max(...ts);
      const mid = add(s.p, mul(s.d, (t0 + t1) / 2)), concave = !solidAt(shape, mid);
      if (!concave) continue;
      const D = 2 * s.r;
      if (!closed) { if (s.r < minR - 1e-9) out.push({ kind: 'radius', level: 'warn', text: `An inside round R${f3(s.r)} is smaller than the smallest cutter (R${minR})`, p: vec(fc.center) }); continue; }
      const depth = t1 - t0;
      if (D < minHole - 1e-9) out.push({ kind: 'hole', level: 'warn', text: `A hole Ø${f3(D)} is smaller than Ø${minHole}`, p: vec(fc.center) });
      if (depth > maxRatio * D + 1e-9) out.push({ kind: 'deep', level: 'warn', text: `A hole Ø${f3(D)} is ${f3(depth)} deep: ${f3(depth / D)} × its diameter (more than ${maxRatio} ×)`, p: vec(fc.center) });
      const std = D <= 20 ? Math.abs(D * 2 - Math.round(D * 2)) < 1e-6 : Math.abs(D - Math.round(D)) < 1e-6;
      if (!std) out.push({ kind: 'drill', level: 'info', text: `A hole Ø${f3(D)} is not a standard drill size (reamed, bored or a clearance hole?)`, p: vec(fc.center) });
    }
    // (sharp inside corners: concave straight edges between flat faces)
    const edges = shape.edges;
    if (edges.length > 20000) continue;
    for (const e of edges) {
      if (e.geomType !== 'LINE') continue;
      const fs = adjacentFaces(shape, e);
      if (fs.length !== 2 || fs.some((x) => x.geomType !== 'PLANE')) continue;
      const a = vec(e.startPoint), b = vec(e.endPoint), d = unit(sub(b, a)), m = mul(add(a, b), 0.5), L = len(sub(b, a));
      const [nA, nB] = fs.map((x) => unit(vec(x.normalAt())));
      if (len(cross(nA, nB)) < 1e-6) continue;
      // (the direction into face A from the edge: concave when it runs the way face B looks)
      let tA = unit(cross(nA, d));
      const eps = Math.max(1e-4, L * 1e-3);
      if (new R.DistanceQuery(R.makeVertex(add(m, mul(tA, eps)))).distanceTo(fs[0]) > eps * 0.5) tA = mul(tA, -1);
      if (dot(nB, tA) > 1e-6) out.push({ kind: 'corner', level: 'warn', text: `A sharp inside corner ${f3(L)} long: a cutter leaves its radius (add one of R${minR} or more, or plan for EDM)`, p: m });
    }
  }
  return out;
}

// The faces of `body` that contain `edge`, in a stable order (by face centre).
function adjacentFaces(body, edge) {
  const oc = R.getOC(), T = oc.TopAbs_ShapeEnum;
  const out = [];
  for (const face of body.faces) {
    const ex = new oc.TopExp_Explorer(face.wrapped, T.TopAbs_EDGE, T.TopAbs_SHAPE);
    let hit = false;
    while (ex.More()) { if (ex.Current().IsSame(edge.wrapped)) { hit = true; break; } ex.Next(); }
    ex.delete();
    if (hit) out.push({ face, c: vec(face.center) });
  }
  const r = (x) => Math.round(x * 1e4);
  out.sort((a, b) => r(a.c[0]) - r(b.c[0]) || r(a.c[1]) - r(b.c[1]) || r(a.c[2]) - r(b.c[2]));
  return out.map((x) => x.face);
}

// Chamfer by two distances (type 'twoDist', x = second distance) or a distance and an angle
// ('angleDist', x in degrees). The first distance is measured on one of the edge's two faces;
// flip uses the other one.
function chamferAsym(body, edges, type, d1, x, flip) {
  const oc = R.getOC();
  const mk = new oc.BRepFilletAPI_MakeChamfer(body.wrapped);
  try {
    for (const e of edges) {
      const faces = adjacentFaces(body, e);
      const face = faces[flip && faces.length > 1 ? 1 : 0];
      if (!face) throw new Error('A chamfer edge has no face');
      if (type === 'twoDist') mk.Add(d1, x, e.wrapped, face.wrapped);
      else mk.AddDA(d1, (x * Math.PI) / 180, e.wrapped, face.wrapped);
    }
    return R.cast(mk.Shape());
  } finally { mk.delete(); }
}

// Local exact-surface contact avoids the global extrema grid on dense splines.
// Only accept points within tol (1e-7 mm unless given); all other distances use the global solver.
function nearFacePoint(face, point, tol = 1e-7) {
  const oc = R.getOC();
  if (!oc.RazorCADSurfacePatch?.NearPoint || face.geomType !== 'BSPLINE_SURFACE') return null;
  const p = new oc.gp_Pnt(...point); let hit;
  try {
    hit = oc.RazorCADSurfacePatch.NearPoint(face.wrapped, p, tol);
    const q = [hit.X(), hit.Y(), hit.Z()];
    return q.every(Number.isFinite) ? q : null;
  } catch (e) { if (isFatal(e)) throw e; return null; }
  finally { hit?.delete(); p.delete(); }
}
// A face of any body near a picked point (faces of dense STL bodies are not searched).
function findFaceAny(bodies, ref) {
  // (Kernel Lab) the faces are tried in order of the distance to their precise boxes (ties: as listed), until no
  // remaining box is nearer than the best distance. A precise box is worked out only when needed: a face's quick box
  // holds its precise one, so its quick distance is never more than its precise one, and faces are taken from the
  // quick order until none can come before the next precise one. The same faces in the same order as boxing every
  // face precisely first (a big import: 6486 precise boxes for one face), so the same face, whatever the boxes are
  // worth as bounds (a point on a guide edge can lie just outside its face's box).
  const entries = [];
  for (const b of bodies) {
    if (b.dense) continue;
    for (const x of facesWithBox(b.shape)) entries.push([b, x]);
  }
  let q = null;
  const dist = new Map();
  // (a face's distance: the contact point on it when the point lies on the face, else the general distance query)
  const distOf = (x) => {
    let d = dist.get(x);
    if (d === undefined) {
      const contact = nearFacePoint(x.face, ref.p);
      if (contact) d = len(sub(contact, ref.p));
      else { q ||= new R.DistanceQuery(R.makeVertex(ref.p)); d = q.distanceTo(x.face); }
      dist.set(x, d);
    }
    return d;
  };
  let best = null, bd = Infinity;
  try {
    labPrefetchQuick(entries.map(([, x]) => x)); // (k10)
    const byQuick = entries.map(([b, x], i) => ({ b, x, i, q: boxDist(labQuickBox(x), ref.p), p: 0 }))
      .sort((u, v) => u.q - v.q || u.i - v.i);
    let next = 0;
    const known = []; // (faces whose precise distance is worked out, not tried yet)
    const resolveUpTo = (v) => {
      const batch = [];
      while (next < byQuick.length && byQuick[next].q <= v) batch.push(byQuick[next++]);
      { const fs = batch.filter((e) => e.x.precise === undefined).map((e) => e.x.face.wrapped); if (fs.length >= 8) labPrefetchBoxes(fs); }
      for (const e of batch) { e.p = boxDist(e.x.box, ref.p); known.push(e); }
    };
    // the next face in the precise order (null: none left)
    const take = () => {
      for (;;) {
        if (!known.length) { if (next >= byQuick.length) return null; resolveUpTo(byQuick[next].q); continue; }
        let k = 0;
        for (let j = 1; j < known.length; j++) if (known[j].p < known[k].p || (known[j].p === known[k].p && known[j].i < known[k].i)) k = j;
        // (a face not worked out yet could still come first: its quick distance is no more than this one)
        if (next < byQuick.length && byQuick[next].q <= known[k].p) { resolveUpTo(known[k].p); continue; }
        return known.splice(k, 1)[0];
      }
    };
    for (let e = take(); e; e = take()) {
      if (e.p > bd + 1e-9) break; // no remaining face can be nearer
      const d = distOf(e.x);
      // (faces on top of each other, e.g. a copied surface on its solid: the body that was clicked)
      if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && ref.body && e.b.id === ref.body)) { bd = d; best = { body: e.b, face: e.x.face }; }
    }
  } finally { q?.delete(); }
  if (best && bd < Math.max(1e-3, bbox(best.body.shape).diag * 2e-3)) return refFound(ref, best, false);
  // a planar face that moved (a dimension before it changed): the face facing the same way clearly
  // nearest the old point; the reference is moved onto it, so it follows the face from now on
  if (Array.isArray(ref.n) && ref.n.length === 3) {
    const pl = [];
    for (const b of bodies) {
      if (b.dense) continue;
      for (const c of faceInfos(b.shape)) if (dot(c.n, ref.n) > 0.999) pl.push({ ...c, body: b });
    }
    const r = nearestTwo(pl, ref.p, (c) => c.face);
    const diag = r.best ? bbox(r.best.body.shape).diag : 0;
    if (r.best && r.bd < diag * 0.5 && r.second > r.bd * 1.6) {
      const c = vec(r.best.face.center);
      ref.p = add(ref.p, mul(r.best.n, dot(sub(c, ref.p), r.best.n)));
      // (and onto the face itself, when the old point is now beside it)
      try { const q = new R.DistanceQuery(R.makeVertex(ref.p)); if (q.distanceTo(r.best.face) > 1e-6) ref.p = vec(r.best.face.center); } catch (e) { if (isFatal(e)) throw e; }
      return refFound(ref, { body: r.best.body, face: r.best.face }, true);
    }
  }
  return refLost(ref);
}

// The body nearest to a point (for vertices).
function bodyAt(bodies, p) {
  const q = new R.DistanceQuery(R.makeVertex(p));
  let best = null, bd = Infinity;
  for (const b of bodies) { const d = q.distanceTo(b.shape); if (d < bd) { bd = d; best = b; } }
  return best && bd < Math.max(1e-3, bbox(best.shape).diag * 1e-4) ? best : null;
}

// Wires of a sketch's (non-construction) chains, on the sketch plane.
function sketchWires(sk, fr) {
  const wires = [];
  for (const ch of S.curveChains(sk)) {
    const segs = S.chainSegs(sk, ch);
    if (segs.length === 1 && segs[0].type === 'circle') {
      wires.push(R.drawSingleCircle(segs[0].r).translate(segs[0].c[0], segs[0].c[1]).sketchOnPlane(rPlane(fr)).wire);
      continue;
    }
    const pen = R.draw(segs[0].a);
    segs.forEach((g, i) => {
      const last = i === segs.length - 1;
      if (g.type === 'line') { if (!(ch.closed && last)) pen.lineTo(g.b); }
      else if (g.type === 'bezier') pen.cubicBezierCurveTo(g.b, g.c1, g.c2);
      else pen.threePointsArcTo(g.b, g.m);
    });
    wires.push((ch.closed ? pen.close() : pen.done()).sketchOnPlane(rPlane(fr)).wire);
  }
  if (!wires.length) throw new Error('The sketch has no (non-construction) curves');
  return wires;
}

function asShape(list) { return compoundOf(list.map((shape) => ({ shape }))); }

// A surface (one or more faces) moved d along its faces' normals, the moved faces trimmed or extended to
// meet again at their edges (sharp, not rounded).
function offsetShell(shape, d) {
  const oc = R.getOC();
  const mk = new oc.BRepOffsetAPI_MakeOffsetShape();
  try {
    mk.PerformByJoin(shape.wrapped, d, 1e-6, oc.BRepOffset_Mode.BRepOffset_Skin, true, false, oc.GeomAbs_JoinType.GeomAbs_Intersection, false);
    return R.cast(mk.Shape());
  } finally { mk.delete(); }
}
function offsetFace(face, d) {
  const oc = R.getOC();
  const mk = new oc.BRepOffsetAPI_MakeOffsetShape();
  mk.PerformByJoin(face.wrapped, d, 1e-6, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false);
  const out = R.cast(mk.Shape());
  mk.delete();
  return out;
}

// Split shape by a tool (an infinite plane face or a surface). Returns the solid pieces.
function splitBy(shape, tool) {
  const oc = R.getOC();
  const sp = new oc.BRepAlgoAPI_Splitter();
  const A = ocList([shape]), T = ocList([tool]);
  sp.SetArguments(A);
  sp.SetTools(T);
  sp.Build(new oc.Message_ProgressRange());
  if (sp.HasErrors()) { sp.delete(); throw new Error('The body could not be split'); }
  const res = R.cast(sp.Shape());
  sp.delete(); A.delete(); T.delete();
  return solidsOf(res);
}

// Edges sorted into connected chains: [{ wire, pts }] (each chain joined end to end; pts for showing it).
function chainEdges(edges) {
  const left = [...edges], out = [];
  const tol = 1e-5;
  const near = (a, b) => len(sub(a, b)) < tol;
  while (left.length) {
    const chain = [left.shift()];
    let grew = true;
    while (grew) {
      grew = false;
      const s0 = vec(chain[0].startPoint), e0 = vec(chain[chain.length - 1].endPoint);
      for (let i = 0; i < left.length; i++) {
        const e = left[i], a = vec(e.startPoint), b = vec(e.endPoint);
        if (near(a, e0)) chain.push(e);
        else if (near(b, e0)) chain.push(R.cast(e.wrapped.Reversed()));
        else if (near(b, s0)) chain.unshift(e);
        else if (near(a, s0)) chain.unshift(R.cast(e.wrapped.Reversed()));
        else continue;
        left.splice(i, 1); grew = true; break;
      }
    }
    let wire = null;
    try { wire = R.assembleWire(chain.map((e) => e.clone())); } catch { wire = null; }
    const pts = [];
    for (const e of chain) { const m = e.geomType === 'LINE' ? 1 : 24; for (let i = pts.length ? 1 : 0; i <= m; i++) pts.push(vec(e.pointAt(i / m))); }
    out.push({ wire, pts });
  }
  return out.filter((c) => c.wire);
}

// Faces unrolled into the plane: their (welded) triangles laid out one after another across shared edges,
// then relaxed so every edge keeps its length. Returns { outer, holes (2D loops), min, max, area2, area3, maxStrain }.
function flattenFaces(faces, iterations = 300) {
  const diag = bboxOfAll(faces).diag;
  const P = [], T = [], grid = new Map(), tol = Math.max(1e-6, diag * 1e-7);
  // (points are joined with other faces' points only: a face's own seam, e.g. down a tube, stays open so it can unroll)
  const weld = (q, fi, local) => {
    const k = q.map((v) => Math.round(v / tol)).join(',');
    const lk = local.get(k);
    if (lk !== undefined) return lk;
    const g = grid.get(k);
    let i;
    if (g && g.face !== fi) i = g.i;
    else { i = P.length; P.push(q); if (!g) grid.set(k, { i, face: fi }); }
    return i;
  };
  for (const [fi, fc] of faces.entries()) {
    const m = fc.mesh({ tolerance: Math.max(5e-4, diag * 1e-4), angularTolerance: 0.04 });
    const ids = [], local = new Map();
    for (let i = 0; i < m.vertices.length / 3; i++) ids.push(weld([m.vertices[3 * i], m.vertices[3 * i + 1], m.vertices[3 * i + 2]], fi, local));
    // a pole (e.g. the top of a dome) has many nodes at one point, joined by edges of no length: one point
    const root = new Map(), find = (i) => { while (root.has(i)) i = root.get(i); return i; };
    for (let k = 0; k < m.triangles.length; k += 3) for (let e = 0; e < 3; e++) {
      const a = find(ids[m.triangles[k + e]]), b = find(ids[m.triangles[k + ((e + 1) % 3)]]);
      if (a !== b && len(sub(P[a], P[b])) <= tol * 2) root.set(Math.max(a, b), Math.min(a, b));
    }
    for (let k = 0; k < m.triangles.length; k += 3) { const t = [find(ids[m.triangles[k]]), find(ids[m.triangles[k + 1]]), find(ids[m.triangles[k + 2]])]; if (t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2]) T.push(t); }
  }
  if (!T.length) throw new Error('The faces could not be meshed');
  if (T.length > 120000) throw new Error('The faces are too finely detailed to flatten (over 120,000 triangles)');
  // edges → triangles
  const ek = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  const edgeTris = new Map();
  T.forEach((t, ti) => { for (let k = 0; k < 3; k++) { const key = ek(t[k], t[(k + 1) % 3]); if (!edgeTris.has(key)) edgeTris.set(key, []); edgeTris.get(key).push(ti); } });
  const d3 = (a, b) => len(sub(P[a], P[b]));
  // lay the triangles out, breadth first from the largest one
  const U = new Array(P.length).fill(null), placed = new Array(T.length).fill(false);
  const area3 = (t) => len(cross(sub(P[t[1]], P[t[0]]), sub(P[t[2]], P[t[0]]))) / 2;
  let t0 = 0;
  T.forEach((t, i) => { if (area3(t) > area3(T[t0])) t0 = i; });
  const third = (A, B, la, lb, away) => {
    // the point la from A and lb from B, on the side away from `away`
    const dx = B[0] - A[0], dy = B[1] - A[1], dd = Math.hypot(dx, dy) || 1e-12;
    const x = (la * la - lb * lb + dd * dd) / (2 * dd), h = Math.sqrt(Math.max(0, la * la - x * x));
    const ux = dx / dd, uy = dy / dd, m = [A[0] + ux * x, A[1] + uy * x];
    const c1 = [m[0] - uy * h, m[1] + ux * h], c2 = [m[0] + uy * h, m[1] - ux * h];
    if (!away) return c1;
    const s1 = (c1[0] - A[0]) * dy - (c1[1] - A[1]) * dx, sa = (away[0] - A[0]) * dy - (away[1] - A[1]) * dx;
    return Math.sign(s1) !== Math.sign(sa) ? c1 : c2;
  };
  const queue = [];
  let comp = 0;
  const seed = (ti, offset) => {
    const [a, b, c] = T[ti];
    U[a] = [offset, 0]; U[b] = [offset + d3(a, b), 0]; U[c] = third(U[a], U[b], d3(a, c), d3(b, c), null);
    placed[ti] = true; queue.push(ti);
  };
  seed(t0, 0);
  for (;;) {
    while (queue.length) {
      const ti = queue.shift(), t = T[ti];
      for (let k = 0; k < 3; k++) {
        const a = t[k], b = t[(k + 1) % 3], c0 = t[(k + 2) % 3];
        for (const nj of edgeTris.get(ek(a, b))) {
          if (placed[nj]) continue;
          const c = T[nj].find((v) => v !== a && v !== b);
          if (!U[c]) U[c] = third(U[a], U[b], d3(a, c), d3(b, c), U[c0]);
          placed[nj] = true; queue.push(nj);
        }
      }
    }
    const next = placed.indexOf(false);
    if (next < 0) break;
    // a separate piece: laid out to the right
    comp++;
    const xs = U.filter(Boolean).map((q) => q[0]);
    seed(next, Math.max(...xs) + diag * 0.1);
  }
  // Two starts, each relaxed so every edge keeps its length as well as it can:
  //  - the triangles laid out one after another (exact for surfaces that unroll; seams stay open)
  //  - the surface projected onto its best plane, seams closed (better for doubly curved ones, e.g. a dome)
  // The one with the smaller length change (and nothing folded over) wins.
  const topo = (TT) => {
    const et = new Map();
    TT.forEach((t, ti) => { for (let k = 0; k < 3; k++) { const key = ek(t[k], t[(k + 1) % 3]); if (!et.has(key)) et.set(key, []); et.get(key).push(ti); } });
    return { T: TT, et, edges: [...et.keys()].map((k) => { const [x, y] = k.split(',').map(Number); return [x, y, d3(x, y)]; }) };
  };
  const score = (tp, V) => {
    let rms = 0, mx = 0;
    for (const [x, y, L] of tp.edges) { const st2 = Math.abs(Math.hypot(V[y][0] - V[x][0], V[y][1] - V[x][1]) - L) / (L || 1); rms += st2 * st2; mx = Math.max(mx, st2); }
    let pos = 0, neg = 0;
    for (const t of tp.T) { const A = V[t[0]], B = V[t[1]], C = V[t[2]], ar = ((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])) / 2; if (ar >= 0) pos += ar; else neg -= ar; }
    const flip = Math.min(pos, neg) / ((pos + neg) || 1);
    rms = Math.sqrt(rms / tp.edges.length);
    return { rms, mx, flip, s: rms + 3 * flip };
  };
  const relax = (tp, V, damp = 1) => {
    const snap = () => V.map((q) => (q ? [...q] : null));
    let best = { ...score(tp, V), V: snap(), tp };
    for (let it = 0; it < iterations; it++) {
      let worst = 0;
      for (const [x, y, L] of tp.edges) {
        const dx = V[y][0] - V[x][0], dy = V[y][1] - V[x][1], d = Math.hypot(dx, dy) || 1e-12, e = ((d - L) / d / 2) * damp;
        worst = Math.max(worst, Math.abs(d - L) / (L || 1));
        V[x][0] += dx * e; V[x][1] += dy * e; V[y][0] -= dx * e; V[y][1] -= dy * e;
      }
      if (worst < 1e-7 || (it + 1) % 50 === 0 || it === iterations - 1) {
        const sc = score(tp, V);
        if (sc.s < best.s) best = { ...sc, V: snap(), tp };
        if (worst < 1e-7) break;
      }
    }
    return best;
  };
  const runs = [relax(topo(T), U.map((q) => (q ? [...q] : null)))];
  {
    let nrm = [0, 0, 0], cen = [0, 0, 0], wsum = 0;
    for (const t of T) { const c3 = cross(sub(P[t[1]], P[t[0]]), sub(P[t[2]], P[t[0]])), w = len(c3) / 2; nrm = add(nrm, c3); cen = add(cen, mul(add(add(P[t[0]], P[t[1]]), P[t[2]]), w / 3)); wsum += w; }
    if (len(nrm) > 0.2 * 2 * wsum && !comp) {
      // seams closed: points at the same place joined
      const firstAt = new Map(), canon = P.map((q, i) => { const k = q.map((v) => Math.round(v / tol)).join(','); if (!firstAt.has(k)) firstAt.set(k, i); return firstAt.get(k); });
      const Tc = T.map((t) => t.map((i) => canon[i])).filter((t) => t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2]);
      const n0 = unit(nrm), c0 = mul(cen, 1 / wsum), u = unit(cross(n0, Math.abs(n0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), v = cross(n0, u);
      const proj = () => P.map((q, i) => (canon[i] === i ? [dot(sub(q, c0), u), dot(sub(q, c0), v)] : null)), tc = topo(Tc);
      runs.push(relax(tc, proj()), relax(tc, proj(), 0.35));
    }
  }
  runs.sort((x, y) => x.s - y.s);
  const win = runs[0], V = win.V, maxStrain = win.mx, rmsStrain = win.rms;
  // the outline: edges of one triangle, chained into loops
  const bnd = win.tp.edges.filter(([x, y]) => win.tp.et.get(ek(x, y)).length === 1).map(([x, y]) => [x, y]);
  const nextOf = new Map();
  for (const [x, y] of bnd) { if (!nextOf.has(x)) nextOf.set(x, []); nextOf.get(x).push(y); if (!nextOf.has(y)) nextOf.set(y, []); nextOf.get(y).push(x); }
  const used = new Set(), loops = [];
  for (const [a0, b0] of bnd) {
    if (used.has(ek(a0, b0))) continue;
    const loop = [a0];
    let prev = a0, cur = b0;
    used.add(ek(a0, b0));
    while (cur !== a0 && loop.length < bnd.length + 2) {
      loop.push(cur);
      const nx = (nextOf.get(cur) || []).find((x) => x !== prev && !used.has(ek(cur, x)));
      if (nx === undefined) break;
      used.add(ek(cur, nx));
      prev = cur; cur = nx;
    }
    if (loop.length >= 3) loops.push(loop.map((i) => V[i]));
  }
  if (!loops.length) throw new Error('The faces form a closed surface: there is no edge to open it out from (split it first)');
  const sArea = (l) => l.reduce((acc, q, i) => { const r = l[(i + 1) % l.length]; return acc + q[0] * r[1] - r[0] * q[1]; }, 0) / 2;
  // (straight runs merged)
  const simplify = (l) => l.filter((q, i) => { const a = l[(i - 1 + l.length) % l.length], b = l[(i + 1) % l.length]; return Math.abs((q[0] - a[0]) * (b[1] - a[1]) - (q[1] - a[1]) * (b[0] - a[0])) > 1e-9 * diag * diag; });
  loops.sort((x, y) => Math.abs(sArea(y)) - Math.abs(sArea(x)));
  if (comp) throw new Error('The faces are not joined into one piece (flatten each piece on its own)');
  // turned to its smallest bounding rectangle (straight sides along x / y)
  {
    for (let k = 0; k < loops.length; k++) loops[k] = loops[k].map((q) => [...q]); // (own copies: turned once each)
    const L0 = loops[0];
    let best = 0, bestA = Infinity;
    const step = Math.max(1, Math.floor(L0.length / 720));
    for (let i = 0; i < L0.length; i += step) {
      const q = L0[i], r = L0[(i + 1) % L0.length], ang = -Math.atan2(r[1] - q[1], r[0] - q[0]);
      const c = Math.cos(ang), sn = Math.sin(ang);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p2 of L0) { const x = p2[0] * c - p2[1] * sn, y = p2[0] * sn + p2[1] * c; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const A = (x1 - x0) * (y1 - y0) * (1 + 1e-9 * i);
      if (A < bestA) { bestA = A; best = ang; }
    }
    const c = Math.cos(best), sn = Math.sin(best);
    for (const l of loops) for (const p2 of l) { const x = p2[0] * c - p2[1] * sn, y = p2[0] * sn + p2[1] * c; p2[0] = x; p2[1] = y; }
  }
  const outer = simplify(loops[0]), holes = loops.slice(1).map(simplify);
  const xs = outer.map((q) => q[0]), ys = outer.map((q) => q[1]);
  const area2 = Math.abs(sArea(loops[0])) - holes.reduce((acc, h) => acc + Math.abs(sArea(h)), 0);
  const a3 = T.reduce((acc, t) => acc + area3(t), 0);
  return { outer, holes, min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)], area2, area3: a3, maxStrain, rmsStrain };
}

function planeFace(p, n) {
  const oc = R.getOC();
  const pln = new oc.gp_Pln(new oc.gp_Pnt(p[0], p[1], p[2]), new oc.gp_Dir(n[0], n[1], n[2]));
  const mk = new oc.BRepBuilderAPI_MakeFace(pln);
  const f = R.cast(mk.Face());
  mk.delete(); pln.delete();
  return f;
}

// ---- rigid transforms and mates
function rotMat(r) {
  const th = len(r);
  if (th < 1e-14) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [x, y, z] = mul(r, 1 / th), c = Math.cos(th), sn = Math.sin(th), v = 1 - c;
  return [[c + x * x * v, x * y * v - z * sn, x * z * v + y * sn], [y * x * v + z * sn, c + y * y * v, y * z * v - x * sn], [z * x * v - y * sn, z * y * v + x * sn, c + z * z * v]];
}
const mv = (M, p) => [M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2], M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2], M[2][0] * p[0] + M[2][1] * p[1] + M[2][2] * p[2]];
const rej = (v, d) => sub(v, mul(d, dot(v, d)));

// Residuals of one mate between a moved entity A and a fixed entity B.
// Entities: { kind: 'plane', p, n } | { kind: 'line', p, d } | { kind: 'point', p }.
function mateResidual(type, A, B, v, align) {
  let a = A, b = B, swapped = false;
  const order = { plane: 0, line: 1, point: 2 };
  if (order[a.kind] > order[b.kind]) { [a, b] = [b, a]; swapped = true; }
  const k = a.kind + '-' + b.kind;
  const dist = type === 'distance' ? v : 0;
  void swapped;
  switch (k) {
    case 'plane-plane':
      if (type === 'coincident' || type === 'distance') return [...sub(a.n, mul(b.n, align)), dot(sub(A.p, B.p), B.kind === 'plane' ? B.n : A.n) - dist];
      if (type === 'parallel') return sub(a.n, mul(b.n, align));
      if (type === 'perpendicular') return [dot(a.n, b.n)];
      if (type === 'angle') return [dot(a.n, b.n) - align * Math.cos((v * Math.PI) / 180)];
      break;
    case 'plane-line':
      if (type === 'coincident') return [dot(b.d, a.n), dot(sub(b.p, a.p), a.n)];
      if (type === 'distance') return [dot(b.d, a.n), dot(sub(b.p, a.p), a.n) - v];
      if (type === 'parallel') return [dot(b.d, a.n)];
      if (type === 'perpendicular') return cross(b.d, a.n);
      if (type === 'angle') return [Math.abs(dot(b.d, a.n)) - Math.sin((v * Math.PI) / 180)];
      break;
    case 'plane-point':
      if (type === 'coincident' || type === 'distance') return [dot(sub(b.p, a.p), a.n) - dist];
      break;
    case 'line-line':
      if (type === 'coincident' || type === 'concentric') return [...cross(a.d, b.d), ...rej(sub(A.p, B.p), B.d)];
      if (type === 'distance') return [...cross(a.d, b.d), len(rej(sub(A.p, B.p), B.d)) - v];
      if (type === 'parallel') return cross(a.d, b.d);
      if (type === 'perpendicular') return [dot(a.d, b.d)];
      if (type === 'angle') return [Math.abs(dot(a.d, b.d)) - Math.cos((v * Math.PI) / 180)];
      break;
    case 'line-point':
      if (type === 'coincident' || type === 'concentric') return rej(sub(b.p, a.p), a.d);
      if (type === 'distance') return [len(rej(sub(b.p, a.p), a.d)) - v];
      break;
    case 'point-point':
      if (type === 'coincident' || type === 'concentric') return sub(a.p, b.p);
      if (type === 'distance') return [len(sub(a.p, b.p)) - v];
      break;
  }
  throw new Error(`A ${type} mate can't be made between a ${A.kind === 'line' ? 'axis/edge' : A.kind} and a ${B.kind === 'line' ? 'axis/edge' : B.kind}`);
}

// Find the rigid motion that satisfies the mates, moving as little as possible: a rotation r
// about the moving bodies' center c, then a translation. Several starting orientations avoid
// wrong flips. Returns the motion as rotation vector r about the origin plus translation t.
function solveMates(mates, c = [0, 0, 0]) {
  const P = (M, p, t) => add(add(mv(M, sub(p, c)), c), t);
  const moved = (e, M, t) => (e.kind === 'plane' ? { kind: 'plane', p: P(M, e.p, t), n: mv(M, e.n) }
    : e.kind === 'line' ? { kind: 'line', p: P(M, e.p, t), d: mv(M, e.d) } : { kind: 'point', p: P(M, e.p, t) });
  const resid = (x) => {
    const M = rotMat([x[0], x[1], x[2]]), t = [x[3], x[4], x[5]];
    const out = [];
    for (const m of mates) out.push(...mateResidual(m.type, moved(m.A, M, t), m.B, m.v, m.align));
    return out;
  };
  const norm2 = (r) => r.reduce((s, v) => s + v * v, 0);
  const run = (x0) => {
    const x = [...x0];
    let r = resid(x), err = norm2(r), lambda = 1e-6;
    for (let it = 0; it < 200 && err > 1e-22; it++) {
      const J = [];
      for (let j = 0; j < 6; j++) {
        const h = 1e-7 * Math.max(1, Math.abs(x[j]));
        const xp = [...x]; xp[j] += h; const xm = [...x]; xm[j] -= h;
        const rp = resid(xp), rm = resid(xm);
        J.push(rp.map((v, i) => (v - rm[i]) / (2 * h)));
      }
      const A = [...Array(6)].map((_, i) => [...Array(6)].map((__, j) => J[i].reduce((s, v, k) => s + v * J[j][k], 0)));
      const g = [...Array(6)].map((_, i) => J[i].reduce((s, v, k) => s + v * r[k], 0));
      let improved = false;
      for (let tries = 0; tries < 10; tries++) {
        const Ad = A.map((row, i) => row.map((v, j) => v + (i === j ? lambda * (1 + v) + 1e-12 : 0)));
        const dx = gauss(Ad, g.map((v) => -v));
        const xn = x.map((v, i) => v + dx[i]);
        const rn = resid(xn), en = norm2(rn);
        if (Number.isFinite(en) && en < err) { x.splice(0, 6, ...xn); r = rn; err = en; lambda = Math.max(lambda / 10, 1e-15); improved = true; break; }
        lambda *= 10;
      }
      if (!improved) break;
    }
    return { x, err };
  };
  const starts = [[0, 0, 0]];
  for (const ax of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) for (const a of [Math.PI, Math.PI / 2, -Math.PI / 2]) starts.push(mul(ax, a));
  let best = null;
  for (const r0 of starts) {
    const res = run([...r0, 0, 0, 0]);
    const motion = len(res.x.slice(0, 3)) * 1000 + len(res.x.slice(3));
    if (!best || res.err < best.err - 1e-12 || (Math.abs(res.err - best.err) <= 1e-12 && motion < best.motion)) best = { ...res, motion };
    if (best.err < 1e-20 && r0 === starts[0]) break;
  }
  if (best.err > 1e-8) throw new Error('The mates cannot all be satisfied (check the entities, values and alignments)');
  const r = best.x.slice(0, 3), M = rotMat(r);
  return { r, t: add(sub(c, mv(M, c)), best.x.slice(3)) }; // x -> M(x - c) + c + t  ==  M x + (c - M c + t)
}

function gauss(A, b) {
  const n = b.length, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-300) continue;
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let sum = M[r][n]; for (let k = r + 1; k < n; k++) sum -= M[r][k] * x[k]; x[r] = Math.abs(M[r][r]) < 1e-300 ? 0 : sum / M[r][r]; }
  return x;
}

// Apply rotation vector r (about the origin, radians) then translation t to a shape.
function moveShape(shape, r, t) {
  let out = shape.clone();
  const th = len(r);
  if (th > 1e-14) out = out.rotate((th * 180) / Math.PI, [0, 0, 0], mul(r, 1 / th));
  if (len(t) > 1e-14) out = out.translate(t);
  return out;
}

// ------------------------------------------------------------ DXF export of a flat face
// The face's outer boundary and holes are written as a 2D drawing in the face's own plane,
// seen from outside the part (x right, y up). Lines, arcs and circles are exact; other
// curves (splines, ellipses) become fine polylines unless they are really lines or arcs.
function findPlanarFace(body, ref) {
  const n = unit(ref.n);
  const cands = faceInfos(body).filter((c) => Math.abs(dot(c.n, n)) > 0.999);
  const q = new R.DistanceQuery(R.makeVertex(ref.p));
  let best = null, bd = Infinity;
  for (const c of cands) {
    const d = q.distanceTo(c.face);
    if (d < bd) { bd = d; best = c; }
  }
  return best && bd < Math.max(1e-3, bbox(body).diag * 1e-5) ? best.face : null;
}

function faceToDXF(face, n, diag) {
  const c = vec(face.center);
  const fr = frameOnPlane(c, n); // origin: the part origin projected onto the face's plane
  const to2 = (pt) => { const d = sub(vec(pt), fr.o); return [dot(d, fr.u), dot(d, fr.v)]; };
  const pointAt = (e, t) => { const v = e.pointAt(t); const r = to2(v); v.delete?.(); return r; };
  const ents = [];
  const tol = Math.max(1e-6, diag * 1e-7);
  const circleFrom3 = (a, b, m) => {
    const d = 2 * (a[0] * (b[1] - m[1]) + b[0] * (m[1] - a[1]) + m[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-12) return null;
    const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, m2 = m[0] ** 2 + m[1] ** 2;
    const cx = (a2 * (b[1] - m[1]) + b2 * (m[1] - a[1]) + m2 * (a[1] - b[1])) / d;
    const cy = (a2 * (m[0] - b[0]) + b2 * (a[0] - m[0]) + m2 * (b[0] - a[0])) / d;
    return { c: [cx, cy], r: Math.hypot(a[0] - cx, a[1] - cy) };
  };
  const arc = (layer, p0, pm, p1, k) => {
    // DXF arcs run counter-clockwise from the start angle to the end angle
    const ccw = (pm[0] - p0[0]) * (p1[1] - p0[1]) - (pm[1] - p0[1]) * (p1[0] - p0[0]) > 0;
    const ang = (q) => (Math.atan2(q[1] - k.c[1], q[0] - k.c[0]) * 180) / Math.PI;
    const [s0, s1] = ccw ? [p0, p1] : [p1, p0];
    ents.push({ type: 'ARC', layer, c: k.c, r: k.r, a0: ang(s0), a1: ang(s1) });
  };
  const fitTol = Math.max(1e-4, diag * 1e-6);
  const offLine = (q, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return Math.abs((q[0] - a[0]) * dy - (q[1] - a[1]) * dx) / l; };
  const wires = [['OUTLINE', face.clone().outerWire()], ...face.clone().innerWires().map((w) => ['HOLES', w])];
  for (const [layer, wire] of wires) {
    for (const e of wire.edges) {
      const type = e.geomType;
      const p0 = pointAt(e, 0), p1 = pointAt(e, 1);
      const closed = e.isClosed || Math.hypot(p0[0] - p1[0], p0[1] - p1[1]) < tol;
      if (type === 'LINE') {
        ents.push({ type: 'LINE', layer, a: p0, b: p1 });
      } else if (type === 'CIRCLE') {
        if (closed) {
          const k = circleFrom3(p0, pointAt(e, 1 / 3), pointAt(e, 2 / 3));
          if (k) ents.push({ type: 'CIRCLE', layer, c: k.c, r: k.r });
        } else {
          const pm = pointAt(e, 0.5);
          const k = circleFrom3(p0, p1, pm);
          if (k) arc(layer, p0, pm, p1, k); else ents.push({ type: 'LINE', layer, a: p0, b: p1 });
        }
      } else {
        // splines, ellipses, intersection curves: keep them exact when they are really lines or arcs
        const L = e.length;
        const nSeg = Math.max(16, Math.min(720, Math.ceil(L / Math.max(diag * 0.002, 0.01))));
        const pts = [];
        for (let i = 0; i <= nSeg; i++) pts.push(pointAt(e, i / nSeg));
        if (!closed && pts.every((q) => offLine(q, p0, p1) < fitTol)) { ents.push({ type: 'LINE', layer, a: p0, b: p1 }); continue; }
        const pm = pts[Math.round(nSeg / 2)];
        const k = closed ? circleFrom3(pts[0], pts[Math.round(nSeg / 3)], pts[Math.round((2 * nSeg) / 3)]) : circleFrom3(p0, p1, pm);
        if (k && pts.every((q) => Math.abs(Math.hypot(q[0] - k.c[0], q[1] - k.c[1]) - k.r) < fitTol)) {
          if (closed) ents.push({ type: 'CIRCLE', layer, c: k.c, r: k.r }); else arc(layer, p0, pm, p1, k);
          continue;
        }
        ents.push({ type: 'POLYLINE', layer, pts, closed });
      }
    }
  }
  return writeDXF(ents);
}

function writeDXF(ents) {
  const out = [];
  const intCode = (c) => (c >= 60 && c <= 99) || (c >= 170 && c <= 179) || (c >= 270 && c <= 289);
  const num = (c, v) => (intCode(c) ? String(Math.round(v)) : Math.abs(v) < 1e-12 ? '0.0' : String(+v.toFixed(9)));
  const g = (code, v) => out.push(String(code), typeof v === 'number' ? num(code, v) : String(v));
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  const ext = (p, r = 0) => { xmin = Math.min(xmin, p[0] - r); ymin = Math.min(ymin, p[1] - r); xmax = Math.max(xmax, p[0] + r); ymax = Math.max(ymax, p[1] + r); };
  for (const e of ents) {
    if (e.type === 'LINE') { ext(e.a); ext(e.b); } else if (e.c) ext(e.c, e.r); else e.pts.forEach((p) => ext(p));
  }
  if (!isFinite(xmin)) { xmin = ymin = 0; xmax = ymax = 1; }
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, 4); // millimetres
  g(9, '$EXTMIN'); g(10, xmin); g(20, ymin); g(30, 0);
  g(9, '$EXTMAX'); g(10, xmax); g(20, ymax); g(30, 0);
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, 2);
  for (const [name, color] of [['OUTLINE', 7], ['HOLES', 1]]) { g(0, 'LAYER'); g(2, name); g(70, 0); g(62, color); g(6, 'CONTINUOUS'); }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  for (const e of ents) {
    if (e.type === 'LINE') { g(0, 'LINE'); g(8, e.layer); g(10, e.a[0]); g(20, e.a[1]); g(30, 0); g(11, e.b[0]); g(21, e.b[1]); g(31, 0); }
    else if (e.type === 'CIRCLE') { g(0, 'CIRCLE'); g(8, e.layer); g(10, e.c[0]); g(20, e.c[1]); g(30, 0); g(40, e.r); }
    else if (e.type === 'ARC') { g(0, 'ARC'); g(8, e.layer); g(10, e.c[0]); g(20, e.c[1]); g(30, 0); g(40, e.r); g(50, e.a0); g(51, e.a1); }
    else {
      g(0, 'POLYLINE'); g(8, e.layer); g(66, 1); g(10, 0); g(20, 0); g(30, 0); g(70, e.closed ? 1 : 0);
      const pts = e.closed ? e.pts.slice(0, -1) : e.pts;
      for (const p of pts) { g(0, 'VERTEX'); g(8, e.layer); g(10, p[0]); g(20, p[1]); g(30, 0); }
      g(0, 'SEQEND'); g(8, e.layer);
    }
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}

// ------------------------------------------------------------ sheet metal flat pattern
// 2D drawing entities of a sheet metal body's flat pattern (top face up, lower-left corner at 0,0):
// OUTLINE / HOLES (the cut), BEND_UP / BEND_DOWN (bend centre lines), BEND_REGION (where the bends
// start and end) and NOTES (bend notes, as TEXT). Also a mesh of the flat part where it lies in the
// model (the panel that stays put when folding), for showing it in the view.
function sheetFlatData(bodyId, flip = false) {
  const rec = lastSolids.find((r) => r.id === bodyId && r.sheet);
  if (!rec) throw new Error('That body is not sheet metal');
  const sheet = rec.sheet;
  const { ents, fp, bends, x0, y0 } = flatEnts(sheet, flip);
  // the flat part in the model, for the Flatten view
  const flatSolid = SM.toSolid({ ...sheet, flat: { pt: sheet.rootPt } });
  const mesh = meshData([flatSolid], bbox(flatSolid).diag);
  return {
    ents, size: fp.size, area: fp.area, bends, t: sheet.t, R: sheet.R, K: sheet.K,
    cut: (({ length, loops }) => ({ length: length + SM.cutLines(sheet), loops }))(SM.cutInfo(fp.region)),
    frame: sheet.frame, origin: [x0, y0], mesh, stale: sheet.stale || null, flip: !!flip,
  };
}

// The flat pattern of a sheet as DXF-style entities (flat coordinates, from its lower-left corner):
// OUTLINE / HOLES, BEND_UP / BEND_DOWN lines (with their notes), BEND_REGION lines and NOTES texts.
// flip: seen from the other face of the sheet (mirrored left to right; up bends become down bends).
function flatEnts(sheet, flip = false) {
  const out = flatEntsTop(sheet);
  if (flip) mirrorFlat(out);
  return out;
}
function mirrorFlat(out) {
  const W = out.fp.size[0];
  const mx = (p) => [W - p[0], p[1]];
  const swapNote = (s) => s.replace(/^UP\b/, '\u0001').replace(/^DOWN\b/, 'UP').replace('\u0001', 'DOWN');
  const layer = (l) => (l === 'BEND_UP' ? 'BEND_DOWN' : l === 'BEND_DOWN' ? 'BEND_UP' : l);
  const readable = (r) => { let x = -(r || 0); if (x > 90.001) x -= 180; if (x < -89.999) x += 180; return x; };
  out.ents = out.ents.map((e) => {
    const r = { ...e, layer: layer(e.layer) };
    if (e.a) r.a = mx(e.a);
    if (e.b) r.b = mx(e.b);
    if (e.c) r.c = mx(e.c);
    if (e.p) r.p = mx(e.p);
    if (e.pts) r.pts = e.pts.map(mx);
    if (e.type === 'ARC') { r.a0 = 180 - e.a1; r.a1 = 180 - e.a0; }
    if (e.type === 'TEXT') { r.rot = readable(e.rot); r.text = swapNote(e.text); }
    if (e.note) r.note = swapNote(e.note);
    return r;
  });
  out.bends = out.bends.map((b) => ({ ...b, up: !b.up, a: mx(b.a), b: mx(b.b), rot: readable(b.rot), note: swapNote(b.note) }));
}
function flatEntsTop(sheet) {
  const fp = SM.flatPattern(sheet);
  const [x0, y0] = fp.min;
  const to2 = (p) => { const v = vec(p); return [v[0] - x0, v[1] - y0]; };
  const diag = Math.hypot(fp.size[0], fp.size[1]) || 1;
  const ents = [];
  for (const face of SM.facesOf(fp.region)) {
    const wires = [['OUTLINE', face.clone().outerWire()], ...face.clone().innerWires().map((w) => ['HOLES', w])];
    for (const [layer, wire] of wires) for (const e of wire.edges) edgeEnts(e, layer, to2, diag, ents);
  }
  const sh = (p) => [p[0] - x0, p[1] - y0];
  const bends = [];
  for (const bl of fp.bendLines) {
    const a = sh(bl.a), b = sh(bl.b);
    const deg = +((bl.ang * 180) / Math.PI).toFixed(2);
    const note = `${bl.up ? 'UP' : 'DOWN'} ${deg}° R${+bl.R.toFixed(3)}`;
    ents.push({ type: 'LINE', layer: bl.up ? 'BEND_UP' : 'BEND_DOWN', a, b, note });
    for (const seg of [...bl.t0, ...bl.t1]) ents.push({ type: 'LINE', layer: 'BEND_REGION', a: sh(seg[0]), b: sh(seg[1]) });
    const len2 = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let rot = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    if (rot > 90.001) rot -= 180; if (rot < -89.999) rot += 180; // readable: never upside down
    const h = Math.min(Math.max(diag * 0.012, 1.5), 6);
    const r = (rot * Math.PI) / 180, nrm = [-Math.sin(r), Math.cos(r)];
    const mid = [(a[0] + b[0]) / 2 + nrm[0] * h * 0.4, (a[1] + b[1]) / 2 + nrm[1] * h * 0.4];
    if (len2 > h * 3) ents.push({ type: 'TEXT', layer: 'NOTES', p: mid, h, rot, text: note, align: 'center' });
    bends.push({ up: bl.up, deg, R: bl.R, len: len2, a, b, note, rot });
  }
  // forming marks (cross breaks, forms; a louver's slit is cut), with one note per mark
  const noted = new Set();
  for (const mk of fp.marks || []) {
    const a = sh(mk.a), b = sh(mk.b);
    ents.push({ type: 'LINE', layer: mk.kind === 'slit' || mk.kind === 'rip' ? 'HOLES' : mk.kind === 'etch' ? 'ETCH' : 'FORMING', a, b });
    const text = mk.kind === 'crossbreak' ? `CROSS BREAK ${mk.up ? 'UP' : 'DOWN'}` : mk.note;
    if (text && !noted.has(mk.id)) {
      noted.add(mk.id);
      const h = Math.min(Math.max(diag * 0.012, 1.5), 6), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      ents.push({ type: 'TEXT', layer: 'NOTES', p: [m[0], m[1] + h * 0.8], h, rot: 0, text, align: 'center' });
    }
  }
  return { ents, fp, bends, x0, y0 };
}

// DXF entities of one edge (lines, arcs and circles exact; other curves as fine polylines).
function edgeEnts(e, layer, to2, diag, ents) {
  const pointAt = (t) => { const v = e.pointAt(t); const r = to2(v); v.delete?.(); return r; };
  const tol = Math.max(1e-6, diag * 1e-7), fitTol = Math.max(1e-4, diag * 1e-6);
  const circleFrom3 = (a, b, m) => {
    const d = 2 * (a[0] * (b[1] - m[1]) + b[0] * (m[1] - a[1]) + m[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-12) return null;
    const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, m2 = m[0] ** 2 + m[1] ** 2;
    const cx = (a2 * (b[1] - m[1]) + b2 * (m[1] - a[1]) + m2 * (a[1] - b[1])) / d;
    const cy = (a2 * (m[0] - b[0]) + b2 * (a[0] - m[0]) + m2 * (b[0] - a[0])) / d;
    return { c: [cx, cy], r: Math.hypot(a[0] - cx, a[1] - cy) };
  };
  const arc = (p0, pm, p1, k) => {
    const ccw = (pm[0] - p0[0]) * (p1[1] - p0[1]) - (pm[1] - p0[1]) * (p1[0] - p0[0]) > 0;
    const ang = (q) => (Math.atan2(q[1] - k.c[1], q[0] - k.c[0]) * 180) / Math.PI;
    const [s0, s1] = ccw ? [p0, p1] : [p1, p0];
    ents.push({ type: 'ARC', layer, c: k.c, r: k.r, a0: ang(s0), a1: ang(s1) });
  };
  const offLine = (q, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return Math.abs((q[0] - a[0]) * dy - (q[1] - a[1]) * dx) / l; };
  const type = e.geomType;
  const p0 = pointAt(0), p1 = pointAt(1);
  const closed = e.isClosed || Math.hypot(p0[0] - p1[0], p0[1] - p1[1]) < tol;
  if (type === 'LINE') { ents.push({ type: 'LINE', layer, a: p0, b: p1 }); return; }
  if (type === 'CIRCLE') {
    if (closed) { const k = circleFrom3(p0, pointAt(1 / 3), pointAt(2 / 3)); if (k) ents.push({ type: 'CIRCLE', layer, c: k.c, r: k.r }); }
    else { const pm = pointAt(0.5); const k = circleFrom3(p0, p1, pm); if (k) arc(p0, pm, p1, k); else ents.push({ type: 'LINE', layer, a: p0, b: p1 }); }
    return;
  }
  const L = e.length;
  const nSeg = Math.max(16, Math.min(720, Math.ceil(L / Math.max(diag * 0.002, 0.01))));
  const pts = [];
  for (let i = 0; i <= nSeg; i++) pts.push(pointAt(i / nSeg));
  if (!closed && pts.every((q) => offLine(q, p0, p1) < fitTol)) { ents.push({ type: 'LINE', layer, a: p0, b: p1 }); return; }
  const pm = pts[Math.round(nSeg / 2)];
  const k = closed ? circleFrom3(pts[0], pts[Math.round(nSeg / 3)], pts[Math.round((2 * nSeg) / 3)]) : circleFrom3(p0, p1, pm);
  if (k && pts.every((q) => Math.abs(Math.hypot(q[0] - k.c[0], q[1] - k.c[1]) - k.r) < fitTol)) {
    if (closed) ents.push({ type: 'CIRCLE', layer, c: k.c, r: k.r }); else arc(p0, pm, p1, k);
    return;
  }
  ents.push({ type: 'POLYLINE', layer, pts, closed });
}

function exportFaceDXF(ref) {
  if (!lastBody) throw new Error('There is no solid body');
  const face = findPlanarFace(lastBody, ref);
  if (!face) throw new Error('Select a flat face to export as DXF');
  return new TextEncoder().encode(faceToDXF(face, unit(ref.n), bbox(lastBody).diag));
}

// Faces of the current model that a feature made: they lie on the solid's surface after the
// feature but not before it. Returns face-group indices (as in the mesh).
function featureFaces(id) {
  const d = lastFeatureDiffs.get(id);
  if (!d?.after || !lastFacePts.length) return [];
  // sample points are triangle centroids, up to the mesh tolerance off the true surface
  // (the same tight tolerance both ways, so faces of later blends near this feature's corners don't count)
  const onTol = Math.max(1e-5, lastMeshTol * 1.5), offTol = onTol;
  if (!d.cache) {
    // only the faces this feature made or changed: a face it left alone has the same centre and area
    // before and after (a large model, e.g. an imported assembly, has thousands that need no checking)
    const boxed = (shape) => (shape ? shape.faces.map((face) => {
      const b = face.boundingBox.bounds, c = vec(face.center);
      return { face, lo: b[0].map((x) => x - onTol), hi: b[1].map((x) => x + onTol), key: `${c.map((x) => Math.round(x * 1e5)).join(',')},${Math.round(R.measureArea(face) * 1e5)}` };
    }) : []);
    const before = boxed(d.before), had = new Set(before.map((f) => f.key));
    let after = boxed(d.after).filter((f) => !had.has(f.key));
    // (cuts made together: only the faces on this feature's own tool)
    if (d.tool) {
      after = after.filter((f) => {
        const q = new R.DistanceQuery(f.face);
        try { return q.distanceTo(d.tool) <= onTol; } catch (e) { if (isFatal(e)) throw e; return true; } finally { q.delete?.(); }
      });
    }
    d.cache = { after, before };
  }
  if (!d.cache.after.length) return [];
  // distance from p to the nearest of the faces whose box holds it (Infinity: none near)
  const dist = (p, faces) => {
    let best = Infinity, v = null;
    for (const f of faces) {
      if (p[0] < f.lo[0] || p[1] < f.lo[1] || p[2] < f.lo[2] || p[0] > f.hi[0] || p[1] > f.hi[1] || p[2] > f.hi[2]) continue;
      v ||= R.makeVertex(p);
      const q = new R.DistanceQuery(v);
      try { best = Math.min(best, q.distanceTo(f.face)); } finally { q.delete?.(); }
      if (best <= 1e-12) break;
    }
    v?.delete?.();
    return best;
  };
  const out = [];
  lastFacePts.forEach((pts, i) => {
    if (!pts) return;
    // the face lies on the surface the feature made, and part of it was not there before
    const onAfter = pts.filter((p) => dist(p, d.cache.after) <= onTol).length;
    if (onAfter * 2 < pts.length) return;
    if (d.before && !pts.some((p) => dist(p, d.cache.before) > offTol)) return;
    out.push(i);
  });
  return out;
}

// Follow exact CAD endpoints. Open surface boundaries exclude shared edges;
// solid vertices with several possible continuations stop the selection.
function patchChainSelection({bodyId,ref,supportFaces=[]}){
  const bodies=[...lastSolids,...lastSurfaces],body=bodies.find(b=>b.id===bodyId);
  if(!body)throw new Error('The patch boundary body is no longer available');
  const hit=findEdgeInfo(body.shape,ref);if(!hit)throw new Error('The clicked patch edge could not be found');
  const read=p=>{try{return vec(p);}finally{p.delete();}};
  const entries=edgeInfos(body.shape).map(info=>({edge:info.e,a:read(info.e.startPoint),b:read(info.e.endPoint),uses:0})),byHash=new Map();
  for(const entry of entries){const key=entry.edge.hashCode;if(!byHash.has(key))byHash.set(key,[]);byHash.get(key).push(entry);}
  const selectedIndex=entries.findIndex(e=>e.edge.isSame(hit.e)),oc=R.getOC();
  for(const {face} of facesWithBox(body.shape)){
    const ex=new oc.TopExp_Explorer(face.wrapped,oc.TopAbs_ShapeEnum.TopAbs_EDGE,oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    try{for(;ex.More();ex.Next()){
      const raw=ex.Current();let edge;try{edge=R.cast(raw);const entry=byHash.get(edge.hashCode)?.find(e=>e.edge.isSame(edge));if(entry)entry.uses++;}finally{edge?.delete();raw.delete();}
    }}finally{ex.delete();}
  }
  let candidates=entries;
  if(entries[selectedIndex].uses===1)candidates=entries.filter(e=>e.uses===1);
  else{
    const faces=supportFaces.filter(r=>!r.body||r.body===bodyId).map(r=>findFaceAny([body],r)?.face).filter(Boolean);
    const adjacent=faces.filter(face=>{const es=face.edges;try{return es.some(e=>e.isSame(hit.e));}finally{es.forEach(e=>e.delete());}});
    if(adjacent.length===1){const es=adjacent[0].edges;try{candidates=entries.filter(e=>es.some(x=>x.isSame(e.edge)));}finally{es.forEach(e=>e.delete());}}
  }
  const near=(a,b)=>len(sub(a,b))<1e-5,selected=new Set([entries[selectedIndex]]);let ambiguous=false;
  const walk=start=>{
    let p=start;
    for(let n=0;n<candidates.length;n++){
      const incident=candidates.filter(e=>near(e.a,p)||near(e.b,p));
      if(incident.length!==2){if(incident.length>2)ambiguous=true;break;}
      const next=incident.filter(e=>!selected.has(e));if(next.length!==1)break;
      const edge=next[0];selected.add(edge);p=near(edge.a,p)?edge.b:edge.a;
    }
  };
  const seed=entries[selectedIndex];if(!near(seed.a,seed.b)){walk(seed.a);walk(seed.b);}
  const refs=[...selected].map(({edge})=>{const r={body:body.id,p:read(edge.pointAt(.5))};updateEdgeRef(r,edge,body.shape);return r;});
  return {refs,ambiguous};
}

// ------------------------------------------------------------ the rebuild cache, kept between sessions
// The state after each feature (bodies, tools, sketches, planes… as the rebuild cache holds it) written out
// so that opening the part again restores it instead of rebuilding every feature: the first change after
// opening is then as quick as any later one. The shapes go into one BRep compound (geometry that the
// states share, such as the faces a feature left alone, is written once); everything else into a graph of
// plain values (objects shared between states stay shared). A state holding anything else is not kept.
const SNAP_VERSION = 2;
function encodeGraph(root, shapes) {
  const nodes = [], ids = new Map(), path = [];
  const enc = (x, key = '') => {
    if (x === undefined) return { $u: 1 };
    if (x === null || typeof x === 'boolean' || typeof x === 'string') return x;
    if (typeof x === 'number') return Number.isFinite(x) ? x : { $n: String(x) };
    // (a tool's `view`: how its preview looks, worked out when shown; not needed again)
    if (typeof x === 'function' && key === 'view') return { $u: 1 };
    if (typeof x !== 'object') throw new Error(`a ${typeof x} cannot be kept (${[...path, key].join('.')})`);
    let id = ids.get(x);
    if (id !== undefined) return { $r: id };
    id = nodes.length;
    ids.set(x, id);
    nodes.push(null);
    path.push(key);
    let node;
    if (x instanceof R.Shape) {
      // (a shape: by its place in the compound, with what the kernel keeps on it, e.g. a body's parts)
      const extra = {};
      for (const k of Object.keys(x)) if (k !== 'oc' && k !== '_wrapped') extra[k] = enc(x[k], k);
      node = { t: 'S', i: shapes.push(x) - 1, x: extra };
    } else if (Array.isArray(x)) node = { t: 'a', v: x.map((v, i) => enc(v, i)) };
    else if (x instanceof Map) node = { t: 'm', v: [...x].map(([k, v]) => [enc(k), enc(v, String(k))]) };
    else if (x instanceof Set) node = { t: 's', v: [...x].map((v) => enc(v)) };
    else if (ArrayBuffer.isView(x)) node = { t: 'ta', c: x.constructor.name, v: x.slice() }; // (kept as it is: packed as bytes)
    else {
      const proto = Object.getPrototypeOf(x);
      if (proto !== Object.prototype && proto !== null) throw new Error(`a ${proto?.constructor?.name || 'value'} cannot be kept (${[...path, key].join('.')})`);
      const o = {};
      for (const k of Object.keys(x)) o[k] = enc(x[k], k);
      node = { t: 'o', v: o };
    }
    path.pop();
    nodes[id] = node;
    return { $r: id };
  };
  return { nodes, root: enc(root) };
}
function decodeGraph(nodes, root, shapes) {
  const T = { Float32Array, Float64Array, Uint32Array, Int32Array, Uint16Array, Int16Array, Uint8Array, Int8Array };
  const objs = nodes.map((n) => (n.t === 'a' ? [] : n.t === 'm' ? new Map() : n.t === 's' ? new Set() : n.t === 'S' ? shapes[n.i] : n.t === 'ta' ? (ArrayBuffer.isView(n.v) ? n.v : new T[n.c](n.v)) : {}));
  const dec = (v) => (v === null || typeof v !== 'object' ? v : '$r' in v ? objs[v.$r] : '$u' in v ? undefined : '$n' in v ? Number(v.$n) : v);
  nodes.forEach((n, i) => {
    const o = objs[i];
    if (n.t === 'a') for (const x of n.v) o.push(dec(x));
    else if (n.t === 'm') for (const [k, v] of n.v) o.set(dec(k), dec(v));
    else if (n.t === 's') for (const v of n.v) o.add(dec(v));
    else if (n.t === 'o') for (const [k, v] of Object.entries(n.v)) o[k] = dec(v);
    else if (n.t === 'S') for (const [k, v] of Object.entries(n.x)) o[k] = dec(v);
  });
  return dec(root);
}
// The shapes are found again in the compound read back by where an explorer meets them: the explorer goes
// through a shape the same way before and after it is written and read, and this kernel has no way to list
// a compound's own children. A compound is put together again from what it holds (its solids, loose shells,
// faces…), each found the same way.
const TOPO_TYPES = ['TopAbs_COMPSOLID', 'TopAbs_SOLID', 'TopAbs_SHELL', 'TopAbs_FACE', 'TopAbs_WIRE', 'TopAbs_EDGE', 'TopAbs_VERTEX'];
const TOPO_AVOID = { TopAbs_COMPSOLID: 'TopAbs_SHAPE', TopAbs_SOLID: 'TopAbs_COMPSOLID', TopAbs_SHELL: 'TopAbs_SOLID', TopAbs_FACE: 'TopAbs_SHELL', TopAbs_WIRE: 'TopAbs_FACE', TopAbs_EDGE: 'TopAbs_WIRE', TopAbs_VERTEX: 'TopAbs_EDGE' };
const topoType = (raw) => { const T = R.getOC().TopAbs_ShapeEnum, t = raw.ShapeType(); return ['TopAbs_COMPOUND', ...TOPO_TYPES].find((n) => T[n] === t); };
function exploreAll(raw, type, avoid = 'TopAbs_SHAPE') {
  const oc = R.getOC(), T = oc.TopAbs_ShapeEnum, ex = new oc.TopExp_Explorer(raw, T[type], T[avoid]);
  const out = [];
  try { for (; ex.More(); ex.Next()) out.push(ex.Current()); } finally { ex.delete(); }
  return out;
}
// what a compound holds: its compsolids, solids, shells not in a solid, faces not in a shell…
const compoundLeaves = (raw) => TOPO_TYPES.flatMap((t) => exploreAll(raw, t, TOPO_AVOID[t]));

// The rebuild cache, written out — when it is of this part (ids: its features' ids, in order). null: nothing
// to keep (another part was built last); { v: 0, error }: a state holds something that cannot be written.
function exportSnaps(ids) {
  const c = rebuildCache;
  if (!c?.entries?.length || c.entries.length > ids.length || c.entries.some((e, i) => !e?.snap || e.id !== ids[i])) return null;
  const shapes = [];
  let graph;
  // (with the meshes of the bodies as last shown, so they are not worked out again either)
  const meshes = [];
  for (const sh of [...(lastSolids.length ? lastSolids.map((r) => r.shape) : lastBody ? [lastBody] : []), ...lastSurfaces.map((r) => r.shape)]) {
    const m = meshCache.get(sh);
    if (m) meshes.push([sh, m]);
  }
  try { graph = encodeGraph({ entries: c.entries.map((e) => ({ id: e.id, json: e.json, snap: e.snap })), meshes }, shapes); } catch (e) { if (isFatal(e)) throw e; return { v: 0, error: e.message }; }
  const oc = R.getOC(), builder = new oc.TopoDS_Builder(), comp = new oc.TopoDS_Compound();
  const temp = [];
  try {
    builder.MakeCompound(comp);
    for (const sh of shapes) builder.Add(comp, sh.wrapped);
    // where each shape is met: [type, index] (a compound: the places of what it holds)
    const lists = {};
    const place = (raw) => {
      const t = topoType(raw);
      if (!lists[t]) {
        const all = exploreAll(comp, t), byHash = new Map();
        temp.push(...all);
        all.forEach((x, i) => { const h = oc.ReplicadShapeHasher.HashCode(x, R.HASH_CODE_MAX); if (!byHash.has(h)) byHash.set(h, []); byHash.get(h).push(i); });
        lists[t] = { all, byHash };
      }
      const L = lists[t], i = (L.byHash.get(oc.ReplicadShapeHasher.HashCode(raw, R.HASH_CODE_MAX)) || []).find((k) => L.all[k].IsEqual(raw));
      if (i === undefined) throw new Error('a shape was not found in the written compound');
      return [t, i];
    };
    const places = shapes.map((sh) => {
      const raw = sh.wrapped;
      if (topoType(raw) !== 'TopAbs_COMPOUND') return place(raw);
      const leaves = compoundLeaves(raw);
      try { return { c: leaves.map(place) }; } finally { leaves.forEach((x) => x.delete()); }
    });
    return { v: SNAP_VERSION, eqKey: c.eqKey, n: shapes.length, places, ...graph, brep: oc.BRepToolsWrapper.Write(comp) };
  } catch (e) { if (isFatal(e)) throw e; return { v: 0, error: e.message }; } finally { temp.forEach((x) => x.delete()); comp.delete(); builder.delete(); }
}
// Put a written-out rebuild cache back. The next rebuild uses each state only while the features up to it
// are exactly as they were (as with the cache in memory).
function importSnaps(data) {
  if (data?.v !== SNAP_VERSION || typeof data.brep !== 'string' || data.places?.length !== data.n) return false;
  const oc = R.getOC();
  const whole = oc.BRepToolsWrapper.Read(data.brep);
  const lists = {};
  const at = ([t, i]) => (lists[t] ||= exploreAll(whole, t))[i];
  let shapes;
  try {
    shapes = data.places.map((pl) => {
      if (!pl.c) { const raw = at(pl); if (!raw) throw new Error('missing'); return R.cast(raw); }
      const builder = new oc.TopoDS_Builder(), comp = new oc.TopoDS_Compound();
      try {
        builder.MakeCompound(comp);
        for (const q of pl.c) { const raw = at(q); if (!raw) throw new Error('missing'); builder.Add(comp, raw); }
        return R.cast(comp);
      } finally { comp.delete(); builder.delete(); }
    });
  } catch (e) { if (isFatal(e)) throw e; return false; } finally { for (const l of Object.values(lists)) l.forEach((x) => x.delete()); whole.delete(); }
  const { entries, meshes } = decodeGraph(data.nodes, data.root, shapes) || {};
  if (!Array.isArray(entries) || !entries.length) return false;
  rebuildCache = { eqKey: data.eqKey, entries };
  for (const [sh, m] of meshes || []) meshCache.set(sh, m);
  return true;
}

// Requests are handled strictly one after another, in the order they came. A request that waits part way
// (a STEP or 3MF import, an export being packed) would otherwise let the next one start in that pause, on a
// half-built model and with the kernel's stack reset under it.
let queue = Promise.resolve();
const queueStats = { waiting: 0, done: 0 };
self.onmessage = (e) => {
  // (the page's answer to a question asked while a request runs: not a request of its own)
  if (e.data?.type === 'answer') { const r = asks.get(e.data.id); if (r) { asks.delete(e.data.id); r(e.data.data); } return; }
  queueStats.waiting++;
  queue = queue.then(() => handleMessage(e)).catch(() => { /* (each request reports its own errors) */ }).finally(() => { queueStats.waiting--; queueStats.done++; });
};

async function handleMessage(e) {
  const { id, type, data } = e.data;
  try {
    await ready;
    if (kernelDead) throw new Error(kernelDead);
    resetStack();
    let result, transfer = [];
    if (type === 'rebuild') {
      const doc = JSON.parse(data.doc);
      takeBlobs(doc, data.blobs);
      ({ res: result, transfer } = await rebuild(doc, data.previewId || null, { haveMesh: data.haveMesh || null, batchCuts: data.batchCuts, meshHelp: data.meshHelp || null }));
      for (const k of ['add', 'remove', 'tool']) {
        const m = result.preview?.[k];
        if (m) transfer.push(m.vertices.buffer, m.normals.buffer, m.triangles.buffer);
      }
      result.kernelMemoryMB = Math.round(R.getOC().wasmMemory.buffer.byteLength / 1048576);
    } else if (type === 'export') {
      result = await exportBody(data.format, data.bodyId || null, data.info || {});
      transfer = [result.buffer];
    } else if (type === 'exportFaceDXF') {
      result = exportFaceDXF(data.ref);
      transfer = [result.buffer];
    } else if (type === 'faceEdges') {
      // (a face's edges, for picking them all at once: their middles and bodies)
      const hit = findFaceAny(lastSolids, data.ref);
      if (!hit) throw new Error('The face could not be found');
      result = hit.face.edges.map((e) => { const r = { p: vec(e.pointAt(0.5)), body: hit.body.id }; updateEdgeRef(r, e, hit.body.shape); return r; });
    } else if (type === 'patchChain') {
      result = patchChainSelection(data);
    } else if (type === 'featureFaces') {
      result = featureFaces(data.id);
    } else if (type === 'loadFont') {
      await R.loadFont(data.data, data.key, true);
      result = true;
    } else if (type === 'textOutlines') {
      result = textOutlines(data.texts || []);
    } else if (type === 'measure') {
      result = measureRefs(data.refs || []);
    } else if (type === 'sectionCurves') {
      const sb = lastSketchBodies.get(data.sketchId);
      if (sb && !sb.body && sb.lazy) {
        const { base, tools: ts } = sb.lazy;
        const parts = ts.flatMap((x) => solidsOf(x));
        try { sb.body = base ? (parts.length > 1 ? cutByList(base, parts) : base.cut(ts[0])) : null; } catch (e) { if (isFatal(e)) throw e; sb.body = base; }
        sb.lazy = null;
      }
      const shapes = [...(sb?.body ? solidsOf(sb.body) : []), ...(sb?.surfaces || [])];
      if (!shapes.length) throw new Error('There is no body or surface for the sketch plane to cut');
      result = sectionPrims(shapes, sb.frame, bboxOfAll(shapes).diag);
    } else if (type === 'meshImport') {
      ({ result, transfer } = await meshImportBodies(data));
    } else if (type === 'stats') {
      // for crash reports: kernel memory and stack state
      resetStack();
      result = { memoryMB: Math.round(R.getOC().wasmMemory.buffer.byteLength / 1048576), stackReset: !!stack, stackRecovered: stackLost, freeing: freeStats.installed, freed: freeStats.freed, queued: queueStats.waiting - 1, handled: queueStats.done, build: KERNEL_BUILD, threads: kernelThreads };
    } else if (type === 'partMesh') {
      const doc = JSON.parse(data.doc);
      doc.rollbackAt = null;
      const out = await rebuild(doc, null, { coarse: !!data.coarse, noContext: true });
      const r = out.res;
      result = { body: r.body, errors: [...(r.errors instanceof Map ? r.errors : Object.entries(r.errors || {}))].length };
      // (Kernel Lab: the solids' volume, for the BOM's mass, instead of the display mesh's)
      if (data.withVolume && r.body && lastSolids.length) { const ex = exactProps(lastSolids.map((x) => x.shape), 1e-6); r.body.volume = ex.reduce((t, x, i) => t + finite(x.volume, () => preciseVolume(lastSolids[i].shape)), 0); }
      transfer = out.transfer;
    } else if (type === 'stepPMI') {
      // (Kernel Lab k14) the part's solids (not its context bodies) as AP242 STEP with semantic PMI from spec
      const oc = R.getOC();
      if (!oc.LabPMI) throw new Error('This geometry kernel cannot write PMI');
      const list = lastSolids.filter((s) => !lastContext.has(s.id));
      if (!list.length) throw new Error('There is no solid to export');
      const shape = list.length === 1 ? list[0].shape : compoundOf(list);
      // (a writer made once first: the first one made sets OpenCascade's STEP parameters up, the schema too)
      if (!self.stepWriterReady) { const ss = new oc.XSControl_WorkSession(), w = new oc.STEPCAFControl_Writer(ss, false); w.delete(); ss.delete(); self.stepWriterReady = true; }
      const text = oc.LabPMI.WriteStep(shape.wrapped, data.name || lastName, data.spec || '');
      if (!text) throw new Error('The STEP file could not be written');
      result = { text };
    } else if (type === 'partSTEP') {
      // a part's solids as a STEP file, placed by pose { p, q: [x, y, z, w] } (Edit in Context: another part, where it is
      // from the part being edited)
      const doc = JSON.parse(data.doc);
      doc.rollbackAt = null;
      const part = await rebuild(doc, null, { partial: true });
      if (!part.solids.length) throw new Error('The part has no solids');
      const [qx, qy, qz, qw] = data.pose?.q || [0, 0, 0, 1], s = Math.hypot(qx, qy, qz), ang = (2 * Math.atan2(s, qw) * 180) / Math.PI, t = data.pose?.p || [0, 0, 0];
      const placed = part.solids.map((r) => { let sh = r.shape.clone(); if (s > 1e-12 && Math.abs(ang) > 1e-9) sh = sh.rotate(ang, [0, 0, 0], [qx / s, qy / s, qz / s]); return { shape: sh.translate(t), name: data.name || 'Context' }; });
      const blob = R.exportSTEP(placed, { unit: 'mm' });
      result = { text: await blob.text() };
    } else if (type === 'exportAssemblySTEP') {
      result = await exportAssemblySTEP(data.doc);
      transfer = [result.bytes.buffer];
    } else if (type === 'asmInterference') {
      result = await asmInterference(data.doc);
      if (result.mesh) transfer = [result.mesh.vertices.buffer, result.mesh.normals.buffer, result.mesh.triangles.buffer];
    } else if (type === 'drawingPick') {
      result = await drawingPick(data.doc, data.view, data.p);
    } else if (type === 'drawingViews') {
      result = await drawingViews(data.doc, data.views || []);
    } else if (type === 'dfmCheck') {
      const list = data.bodyId ? lastSolids.filter((r) => r.id === data.bodyId) : lastSolids;
      if (!list.length) throw new Error('There is no solid to check');
      result = dfmCheck(list, data.opts || {});
    } else if (type === 'sheetCheck') {
      const rec = lastSolids.find((r) => r.id === data.bodyId && r.sheet);
      if (!rec) throw new Error('That body is not sheet metal');
      result = SM.sheetCheck(rec.sheet);
    } else if (type === 'sheetFlat') {
      result = sheetFlatData(data.bodyId, !!data.flip);
      transfer = [result.mesh.vertices.buffer, result.mesh.normals.buffer, result.mesh.triangles.buffer];
    } else if (type === 'cutList') {
      let list = lastSolids;
      if (data.doc) { await ensureDrawingCache(data.doc); list = drawingCache.solids; }
      const members = list.filter((r) => r.member), ex = exactProps(members.map((r) => r.shape));
      result = members.map((r, i) => ({ id: r.id, ...r.member, axis: undefined, volume: finite(ex[i]?.volume, () => R.measureVolume(r.shape)) }));
    } else if (type === 'compareParts') {
      result = await compareParts(data.a, data.b);
    } else if (type === 'interference') {
      result = interference();
      if (result.mesh) transfer = [result.mesh.vertices.buffer, result.mesh.normals.buffer, result.mesh.triangles.buffer];
    } else if (type === 'exportSnaps') {
      result = exportSnaps(data.ids || []);
    } else if (type === 'importSnaps') {
      result = importSnaps(data.snaps);
    } else if (type === 'ping') {
      result = 'ready';
    } else if (type === 'boxCheck') {
      // (for the tests: the quick box of the bodies last built, against the box of every face's precise box)
      const shapes = [...lastSolids, ...lastSurfaces].map((r) => r.shape).filter(Boolean), oc = R.getOC();
      FACE_BOXES.clear();
      let t = performance.now();
      const quick = bboxOfAllQuick(shapes, true), quickMs = performance.now() - t;
      const precise = FACE_BOXES.size;
      FACE_BOXES.clear();
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      t = performance.now();
      let nf = 0;
      for (const sh of shapes) for (const f of exploreAll(sh.wrapped, 'TopAbs_FACE')) { const b = faceBox(f); nf++; if (b) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], b[0][k]); max[k] = Math.max(max[k], b[1][k]); } f.delete(); }
      result = { quick: [quick.min, quick.max], full: [min, max], faces: nf, precise, quickMs: Math.round(quickMs), fullMs: Math.round(performance.now() - t) };
    } else if (type === 'centreCheck') {
      // (for the tests: each flat face's centre as the meshes give it, against the adaptive one)
      const faces = lastSolids.flatMap((r) => r.shape.faces).filter((f) => f.geomType === 'PLANE');
      const r6 = (x) => Math.round(x * 1e6) / 1e6;
      let worst = 0, roundDiff = 0;
      for (const f of faces) {
        const a = vec(f.center), b = flatCentre(f);
        worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
        if (a.some((x, k) => r6(x) !== r6(b[k]))) roundDiff++;
      }
      result = { faces: faces.length, worst, roundDiff };
    } else if (type === 'ocHas') {
      // (diagnostics) which kernel classes this build has
      const oc = R.getOC();
      result = (data.names || []).filter((n) => n in oc);
      if (data.proto) result = Object.fromEntries(result.map((n) => [n, oc[n].prototype ? Object.getOwnPropertyNames(oc[n].prototype) : Object.keys(oc[n])]));
    }
    // the kernel aborted while handling this (the error was swallowed somewhere): don't trust the result
    if (kernelDead) throw new Error(kernelDead);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    const fatal = isFatal(err);
    if (fatal && !kernelDead) kernelDead = `the geometry kernel failed: ${err?.message || err}`;
    self.postMessage({ id, ok: false, fatal, error: err?.message || String(err), stack: err?.stack || null });
  } finally {
    try { if (!kernelDead) resetStack(); } catch { /* ignore */ }
  }
}
