// Dimension IDs: every dimension of a part (a sketch's, a 3D sketch's, and each value of a feature: a depth, a
// radius…) has a short ID of its own (D1, D2…), given when it is made from the part's counter (doc.nextDim, never
// counted back, so an ID is never given again) and renamed as liked. A value can use another dimension by its ID
// (`D3 * 2`), as it can a global variable; reference (driven) dimensions have IDs too. Where they live:
//   a sketch dimension: constraint { type: 'dim', did }      a 3D sketch dimension: rel { did } (REL3D dim types)
//   a feature's value: f.dimIds = { key: id }                 (the keys are the values that are dimensions)
// A dimension deleted while others use it is kept as lost (doc.lostDims = { id: its last value }): those using it
// hold that value and fail (their feature shows as failing) until they no longer use it.
import { evalEquations, isValidName } from './expr.js';
import { REL3D } from './sketch3dmodel.js';

// Every dimension of the part: [{ did, f (its feature), expr (its value), driven, where: 'sketch' | 'sketch3d' |
// 'field', key (a field's key, or the constraint / rel id) }]
export function dimsOf(doc) {
  const out = [];
  for (const f of doc?.features || []) {
    if (f.type === 'sketch') for (const k of f.constraints || []) { if (k.type === 'dim') out.push({ did: k.did, f, expr: k.value, driven: !!k.driven, where: 'sketch', key: k.id, item: k }); }
    if (f.type === 'sketch3d') for (const r of f.rels || []) { if (REL3D[r.type]?.dim) out.push({ did: r.did, f, expr: r.value, driven: false, where: 'sketch3d', key: r.id, item: r }); }
    for (const [key, did] of Object.entries(f.dimIds || {})) if (f[key] !== undefined && f[key] !== null && f[key] !== '') out.push({ did, f, expr: f[key], driven: false, where: 'field', key });
  }
  return out;
}

const NUM = /^D(\d+)$/;
// Give IDs to the dimensions without one: a sketch's and a 3D sketch's dimensions, and the feature values that are
// dimensions (fieldKeys(f): the keys of a feature's values shown as dimensions). The counter only goes up (taken past
// any ID already used, so none is given twice). Returns how many were given.
export function assignDimIds(doc, fieldKeys = () => []) {
  if (!doc?.features) return 0;
  const used = new Set([...dimsOf(doc).map((d) => d.did).filter(Boolean), ...Object.keys(doc.lostDims || {}), ...(doc.equations || []).map((e) => e.name)]);
  let n = Math.max(doc.nextDim || 1, 1 + Math.max(0, ...[...used].map((x) => +(NUM.exec(x)?.[1] || 0))));
  let given = 0;
  const next = () => { while (used.has('D' + n)) n++; const id = 'D' + n++; used.add(id); given++; return id; };
  for (const f of doc.features) {
    if (f.type === 'sketch') for (const k of f.constraints || []) { if (k.type === 'dim' && !k.did) k.did = next(); }
    if (f.type === 'sketch3d') for (const r of f.rels || []) { if (REL3D[r.type]?.dim && !r.did) r.did = next(); }
    for (const key of fieldKeys(f) || []) {
      if (f[key] === undefined || f[key] === null || f[key] === '' || f.dimIds?.[key]) continue;
      (f.dimIds ||= {})[key] = next();
    }
  }
  if (given || !doc.nextDim || doc.nextDim < n) doc.nextDim = n;
  return given;
}

// The variables a value can use: the global variables (Equations), the driving dimensions by their IDs, and the lost
// ones at their last values. { vars, errors (of the equations), dimErrors }
export function docVariables(doc) {
  const eqs = doc?.equations || [], eqNames = new Set(eqs.map((e) => e.name));
  const dims = dimsOf(doc).filter((d) => d.did && !d.driven && !eqNames.has(d.did)).map((d) => ({ name: d.did, expr: d.expr }));
  const lost = Object.entries(doc?.lostDims || {}).map(([name, v]) => ({ name, expr: v }));
  const { vars, errors } = evalEquations([...eqs, ...dims, ...lost]);
  const eqErr = new Map([...errors].filter(([k]) => eqNames.has(k))), dimErrors = new Map([...errors].filter(([k]) => !eqNames.has(k)));
  return { vars, errors: eqErr, dimErrors };
}

const uses = (expr, id) => typeof expr === 'string' && new RegExp(`(^|[^\\w])${id}(?![\\w])`).test(expr);
// What uses dimension (or variable) `id`: [{ f, where, key, did, text (a short description) }]
export function usersOf(doc, id) {
  const out = dimsOf(doc).filter((d) => d.did !== id && uses(d.expr, id)).map((d) => ({ ...d, text: `${d.f.name} ${d.did || ''}`.trim() }));
  for (const e of doc?.equations || []) if (e.name !== id && uses(e.expr, id)) out.push({ where: 'equation', key: e.name, text: `Equation ${e.name}` });
  return out;
}

// Can dimension `from` be renamed `to`? null if so, else why not
export function renameProblem(doc, from, to) {
  if (!isValidName(to)) return 'An ID starts with a letter and has only letters, digits and _';
  if (to === from) return null;
  if (dimsOf(doc).some((d) => d.did === to) || (doc.equations || []).some((e) => e.name === to) || (doc.lostDims && to in doc.lostDims)) return `${to} is already used in this part`;
  if (/^(pi|e|sin|cos|tan|asin|acos|atan|sqrt|abs|min|max|round|floor|ceil|pow|mm|cm|in|inch|ft)$/i.test(to)) return `${to} is a function, constant or unit name`;
  return null;
}
// Rename dimension `from` to `to`, and every value that uses it. Returns the number of values changed.
export function renameDim(doc, from, to) {
  const d = dimsOf(doc).find((x) => x.did === from);
  if (!d) return 0;
  if (d.where === 'field') d.f.dimIds[d.key] = to; else d.item.did = to;
  const re = new RegExp(`(^|[^\\w])${from}(?![\\w])`, 'g');
  let n = 0;
  const swap = (s) => (typeof s === 'string' && uses(s, from) ? (n++, s.replace(re, `$1${to}`)) : s);
  for (const x of dimsOf(doc)) {
    if (x.where === 'field') x.f[x.key] = swap(x.f[x.key]);
    else x.item.value = swap(x.item.value);
  }
  for (const e of doc.equations || []) e.expr = swap(e.expr);
  if (doc.lostDims && from in doc.lostDims) { doc.lostDims[to] = doc.lostDims[from]; delete doc.lostDims[from]; }
  return n;
}

// Lost dimensions no longer used by anything are forgotten (their IDs stay unused: the counter never goes back)
export function pruneLost(doc) {
  if (!doc?.lostDims) return;
  for (const id of Object.keys(doc.lostDims)) if (!usersOf(doc, id).length) delete doc.lostDims[id];
  if (!Object.keys(doc.lostDims).length) delete doc.lostDims;
}

// The failures of feature f from lost dimensions: its values (or its sketch's dimensions) that use one: [message]
export function lostFailures(doc, f) {
  const lost = doc?.lostDims;
  if (!lost || !Object.keys(lost).length) return [];
  const out = [];
  for (const d of dimsOf({ features: [f] })) for (const id of Object.keys(lost)) {
    if (uses(d.expr, id)) out.push(`${d.did || 'A dimension'} uses ${id}, which was deleted: it holds ${id}'s last value (${+(+lost[id]).toFixed(4)})`);
  }
  return out;
}
// Does this dimension (its value) use a lost one?
export const usesLost = (doc, expr) => !!doc?.lostDims && Object.keys(doc.lostDims).some((id) => uses(expr, id));
