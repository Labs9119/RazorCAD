// Library features: a group of features (sketches and the features made from them, fillets on their edges, patterns
// of them…) kept under a name, to put on a plane or flat face of any part. The features are stored relative to the
// first sketch's plane (the placement), with the variables their sizes use; each insertion gets variables of its own.
import * as M from './model.js';

const POINT_KEYS = new Set(['p', 'o', 'point', 'origin', 'center']);
const DIR_KEYS = new Set(['n', 'u', 'v', 'd', 'dir', 'normal']);
const is3 = (x) => Array.isArray(x) && x.length === 3 && x.every((c) => typeof c === 'number');
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const comb = (o, fr, l) => [0, 1, 2].map((i) => (o ? o[i] : 0) + fr.u[i] * l[0] + fr.v[i] * l[1] + fr.n[i] * l[2]);

// Every 3D point and direction in a feature's settings mapped (the picked faces and edges, a sketch's plane frame).
function mapRefs(x, P, D, key = '') {
  if (is3(x)) return POINT_KEYS.has(key) ? P(x) : DIR_KEYS.has(key) ? D(x) : x;
  if (Array.isArray(x)) return x.map((y) => mapRefs(y, P, D, key));
  if (x && typeof x === 'object') { const out = {}; for (const [k, v] of Object.entries(x)) out[k] = mapRefs(v, P, D, k); return out; }
  return x;
}
// Every feature id in a feature's settings renamed ('f3', 'f3.2', 'f3~2', 'f3:line', 'folder:ff1' as they are).
function mapIds(x, ids, key = '') {
  if (typeof x === 'string') {
    if (key === 'name') return x;
    const m = /^(f\d+)([.:~].*)?$/.exec(x);
    return m && ids.has(m[1]) ? ids.get(m[1]) + (m[2] || '') : x;
  }
  if (Array.isArray(x)) return x.map((y) => mapIds(y, ids, key));
  if (x && typeof x === 'object') { const out = {}; for (const [k, v] of Object.entries(x)) out[k] = k === 'id' && typeof v === 'string' && !ids.has(v) ? v : mapIds(v, ids, k); return out; }
  return x;
}
const wordsOf = (x, out = new Set()) => {
  if (typeof x === 'string') for (const w of x.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) out.add(w);
  else if (Array.isArray(x)) x.forEach((y) => wordsOf(y, out));
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) if (k !== 'name' && k !== 'id') wordsOf(v, out);
  return out;
};
const NOT_EXPR = new Set(['name', 'id', 'type', 'op', 'ref', 'kind', 'mode', 'end', 'sketch', 'body', 'icon']);
function renameWords(x, map, key = '') {
  if (typeof x === 'string') return NOT_EXPR.has(key) ? x : x.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (w) => map.get(w) ?? w);
  if (Array.isArray(x)) return x.map((y) => renameWords(y, map, key));
  if (x && typeof x === 'object') { const out = {}; for (const [k, v] of Object.entries(x)) out[k] = renameWords(v, map, k); return out; }
  return x;
}

// The library feature for features `ids` of `doc`, with the sketches and folders' features they use. frameOf(sketch id):
// the sketch's plane as built ({ o, u, v, n }). Throws when a feature refers to something outside the group.
export function makeLibraryFeature(doc, ids, frameOf, name) {
  const want = new Set(M.expandFeatureRefs(doc, ids));
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of doc.features.filter((x) => want.has(x.id))) for (const id of M.sketchesUsedBy(f)) if (!want.has(id)) { want.add(id); grew = true; }
  }
  const list = doc.features.filter((f) => want.has(f.id));
  if (!list.length) throw new Error('Choose the features to keep');
  if (list.some((f) => f.type === 'sketch3d' || f.type === 'importBody' || f.type === 'importMesh')) throw new Error('3D sketches and imported bodies cannot go into a library feature');
  const first = list.find((f) => f.type === 'sketch');
  if (!first) throw new Error('A library feature needs a sketch (its plane places it)');
  for (const f of list) {
    const outside = [...M.referencesOf(doc, f)].filter((id) => !want.has(id) && !(f.type === 'sketch' && f.plane?.ref === id));
    if (outside.length) throw new Error(`${f.name} uses ${M.findFeature(doc, outside[0])?.name || outside[0]}, which is not in the library feature`);
  }
  const P0 = frameOf(first.id);
  if (!P0) throw new Error(`${first.name} has no plane (rebuild it first)`);
  const toL = (q) => [dot(sub(q, P0.o), P0.u), dot(sub(q, P0.o), P0.v), dot(sub(q, P0.o), P0.n)], toLd = (d) => [dot(d, P0.u), dot(d, P0.v), dot(d, P0.n)];
  const items = list.map((f) => {
    const g = JSON.parse(JSON.stringify(f));
    delete g.rev; delete g.suppressed;
    if (g.type === 'sketch') { const fr = frameOf(f.id); if (!fr) throw new Error(`${f.name} has no plane (rebuild it first)`); g.plane = { ref: 'face', frame: fr }; }
    return mapRefs(g, toL, toLd);
  });
  // (the variables the sizes use, and the ones those use)
  const eqs = doc.equations || [], used = new Set();
  const take = (words) => { for (const w of words) { const e = eqs.find((x) => x.name === w); if (e && !used.has(w)) { used.add(w); take(wordsOf(String(e.expr))); } } };
  take(wordsOf(items));
  const folders = (doc.featureFolders || []).filter((g) => g.ids.some((x) => want.has(x))).map((g) => ({ ...g, ids: g.ids.filter((x) => want.has(x)) }));
  return { name, items, equations: eqs.filter((e) => used.has(e.name)).map((e) => ({ name: e.name, expr: String(e.expr) })), folders };
}

// Insert library feature `lib` on placement W ({ o, u, v, n }), turned `angle` degrees about its normal. values:
// { variable: expression } in place of the library's. Its variables are renamed when the part has them already
// (a second copy: w → w_2), so each copy keeps sizes of its own. Returns { ids, renamed }.
export function insertLibraryFeature(doc, lib, W, { values = {}, angle = 0 } = {}) {
  const a = (angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const u = [0, 1, 2].map((i) => W.u[i] * c + W.v[i] * s), v = cross(W.n, u), F = { u, v, n: W.n };
  const toW = (l) => comb(W.o, F, l), toWd = (l) => comb(null, F, l);
  const ids = new Map(lib.items.map((f) => [f.id, M.newId(doc)]));
  const have = new Set((doc.equations || []).map((e) => e.name)), names = new Map();
  for (const e of lib.equations) {
    let nm = e.name, k = 2;
    while (have.has(nm)) nm = `${e.name}_${k++}`;
    have.add(nm);
    if (nm !== e.name) names.set(e.name, nm);
  }
  const eqs = lib.equations.map((e) => ({ name: names.get(e.name) || e.name, expr: renameWords(String(values[e.name] ?? e.expr), names) }));
  (doc.equations ||= []).push(...eqs);
  const added = [];
  for (const item of lib.items) {
    let g = mapIds(mapRefs(JSON.parse(JSON.stringify(item)), toW, toWd), ids);
    if (names.size) g = renameWords(g, names);
    g.id = ids.get(item.id);
    g.name = M.nextName(doc, g.type, g.op);
    g.rev = M.newRev();
    M.insertFeature(doc, g);
    added.push(g.id);
  }
  for (const g of lib.folders || []) M.newFeatureFolder(doc, g.name, g.ids.map((x) => ids.get(x)).filter(Boolean));
  const top = added.filter((id) => !(doc.featureFolders || []).some((g) => g.ids.includes(id)));
  if (lib.name && top.length) M.newFeatureFolder(doc, lib.name, top);
  return { ids: added, renamed: Object.fromEntries(names) };
}
