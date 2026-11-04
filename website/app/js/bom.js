// Bill of materials of an assembly document: one row per part / sub-assembly and configuration used (a
// sub-assembly's own rows under it, indented, with the quantities in one of it); suppressed components left
// out. Used by the assembly's Bill of Materials window and by the BOM table and balloons on drawings.
//
// Masses: each part's, from its built mesh's volume and its material's density, kept on the assembly's part entry
// (p.mass: { config id or '': kg }) by the assembly when it builds the part; a sub-assembly's is the sum of its
// rows'. Costs: the part's "Cost" custom property (a number; a sub-assembly: the sum of its rows' too).
import { materialById } from './model.js';
import { propsOf } from './custprops.js';

const isAsm = (doc) => doc?.kind === 'assembly';
// An envelope: a component that is a reference for modelling, shown see-through and always first in the tree, in no
// BOM, mass, drawing, export or interference check.
export const withoutEnvelope = (doc) => (doc.components?.some((c) => c.envelope) ? { ...doc, components: doc.components.filter((c) => !c.envelope) } : doc);
const configName = (p, id) => (id ? (p?.doc?.configs || []).find((c) => c.id === id)?.name || '?' : 'Default');
// a component as the document's active configuration shows it
function effIn(doc, c) {
  const o = (doc.activeConfig ? (doc.configs || []).find((x) => x.id === doc.activeConfig) : null)?.comps?.[c.id] || {};
  return { config: 'config' in o ? o.config : (c.config ?? null), suppressed: 'suppressed' in o ? o.suppressed : !!c.suppressed };
}
// a cost written as text ("12.50", "$ 1,200", "R12,50") as a number, or null
export function costValue(text) {
  if (text == null || text === '') return null;
  let s = String(text).replace(/[^\d.,-]/g, '');
  if (/,\d{1,2}$/.test(s) && !/\.\d/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, '');
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}
// the volume (mm³) of a closed triangle mesh, and a part's mass (kg) from it
export function meshVolume(m) {
  const V = m?.vertices, T = m?.triangles;
  if (!V || !T) return 0;
  let s = 0;
  for (let i = 0; i < T.length; i += 3) {
    const a = T[i] * 3, b = T[i + 1] * 3, c = T[i + 2] * 3;
    s += V[a] * (V[b + 1] * V[c + 2] - V[b + 2] * V[c + 1]) - V[a + 1] * (V[b] * V[c + 2] - V[b + 2] * V[c]) + V[a + 2] * (V[b] * V[c + 1] - V[b + 1] * V[c]);
  }
  return Math.abs(s) / 6;
}
export const massOf = (volumeMm3, materialId) => { const d = materialById(materialId)?.density; return d ? volumeMm3 * d * 1e-6 : null; };

// [{ item ('1', '2.1'…), depth, name, qty, material, file, sub, part (its part id), config, props (its custom
// properties), mass (kg each, or null), cost (each, or null), key (the same for the row however the list changes) }]
export function bomRows(asm) {
  const rows = [];
  // the rows of one level; returns its total mass and cost (null when one is unknown)
  const level = (doc, prefix, depth, parentKey = '') => {
    let k = 0, mass = 0, cost = 0;
    for (const p of doc.parts || []) {
      const by = new Map();
      for (const c of doc.components || []) {
        const e = effIn(doc, c);
        if (c.part !== p.id || e.suppressed || c.envelope) continue;
        by.set(e.config, (by.get(e.config) || 0) + 1);
      }
      for (const [cfgId, n] of by) {
        const item = prefix + ++k, sub = isAsm(p.doc);
        const key = `${parentKey}${p.id}|${cfgId ?? ''}`, props = propsOf(p.doc);
        const row = { item, depth, name: (p.name || 'Part') + ((p.doc?.configs || []).length ? ` (${configName(p, cfgId)})` : ''), qty: n,
          material: sub ? '' : materialById(p.doc?.material)?.name || '', file: p.path ? String(p.path).split(/[\\/]/).pop() : '(not saved)', sub,
          part: p.id, config: cfgId, configName: (p.doc?.configs || []).length ? configName(p, cfgId) : '', props, key,
          mass: sub ? null : (p.mass?.[cfgId ?? ''] ?? null), cost: costValue(props.Cost) };
        rows.push(row);
        if (sub && depth < 16) {
          const sd = { ...p.doc, activeConfig: cfgId && (p.doc.configs || []).some((x) => x.id === cfgId) ? cfgId : null };
          const t = level(sd, item + '.', depth + 1, key + '/');
          row.mass = t.mass;
          if (row.cost == null) row.cost = t.cost;
        }
        mass = mass == null || row.mass == null ? null : mass + n * row.mass;
        cost = cost == null || row.cost == null ? null : cost + n * row.cost;
      }
    }
    return { mass: k ? mass : null, cost: k ? cost : null };
  };
  if (isAsm(asm)) level(asm, '', 0);
  return rows;
}

// What a BOM column can show: these, a custom property ('prop:<name>'), or values typed into the table ('text').
export const BOM_FIELDS = [['item', 'Item'], ['qty', 'Qty'], ['name', 'Part'], ['material', 'Material'], ['file', 'File'], ['config', 'Configuration'],
  ['mass', 'Mass (kg)'], ['totalMass', 'Total mass (kg)'], ['cost', 'Cost'], ['totalCost', 'Total cost']];
const TOTALS = ['totalMass', 'totalCost', 'qty'];
// the custom property names the assembly's parts and sub-assemblies have (in the order first met)
export function bomPropNames(asm) {
  const out = [];
  for (const r of bomRows(asm)) for (const k of Object.keys(r.props || {})) if (!out.includes(k)) out.push(k);
  return out;
}
const kg = (v) => (v == null ? '' : v < 1 ? String(+v.toPrecision(3)) : v < 10 ? v.toFixed(3) : v < 1000 ? v.toFixed(2) : v.toFixed(0));
const money = (v) => (v == null ? '' : v.toFixed(2));
// a row's text in a column { key, values }
export function bomCell(row, col) {
  const k = col?.key || '';
  if (k === 'config') return row.configName || '';
  if (k.startsWith('prop:')) return row.props?.[k.slice(5)] ?? '';
  if (k === 'text') return col.values?.[row.key] ?? '';
  if (k === 'mass') return kg(row.mass);
  if (k === 'totalMass') return kg(row.mass == null ? null : row.mass * row.qty);
  if (k === 'cost') return money(row.cost);
  if (k === 'totalCost') return money(row.cost == null ? null : row.cost * row.qty);
  return row[k] ?? '';
}
// The totals row (top level rows only), or null when no column sums: { [column index]: text } with "TOTAL" in the
// first column that doesn't sum.
export function bomTotals(rows, cols) {
  if (!cols.some((c) => c.key === 'totalMass' || c.key === 'totalCost')) return null;
  const top = rows.filter((r) => !r.depth), out = {};
  cols.forEach((c, i) => {
    if (c.key === 'qty') out[i] = String(top.reduce((s, r) => s + r.qty, 0));
    else if (c.key === 'totalMass') out[i] = top.some((r) => r.mass == null) ? '' : kg(top.reduce((s, r) => s + r.mass * r.qty, 0));
    else if (c.key === 'totalCost') out[i] = top.some((r) => r.cost == null) ? '' : money(top.reduce((s, r) => s + r.cost * r.qty, 0));
  });
  const label = cols.findIndex((c) => !TOTALS.includes(c.key));
  if (label >= 0) out[label] = 'TOTAL';
  return out;
}
// what can be chosen for a column: [key, label]
export function bomSources(props = [], cols = []) {
  const names = [...new Set([...props, ...cols.filter((c) => c.key?.startsWith('prop:')).map((c) => c.key.slice(5))])];
  return [...BOM_FIELDS, ...names.map((n) => ['prop:' + n, `Property: ${n}`]), ['text', 'Typed in the table']];
}
// the heading a column gets for what it shows
export const bomHeading = (key, sources) => (sources.find((x) => x[0] === key)?.[1] || key).replace(/^Property: /, '').toUpperCase();
// A column's menu (assembly BOM window header, drawing BOM table): what it shows, insert / rename / remove.
// cols is changed in place; done() after a change; rename(old) → new heading (or null).
export function bomColumnMenu(cols, i, sources, done, rename) {
  const c = cols[i];
  const set = (key) => { c.key = key; c.title = bomHeading(key, sources); if (key === 'text') c.values ||= {}; else delete c.values; done(); }; // (the heading follows; rename it after)
  const fresh = () => { const used = new Set(cols.map((x) => x.key)); const s = sources.find(([k]) => !used.has(k) && k !== 'text'); return s ? { key: s[0], title: bomHeading(s[0], sources), w: 25 } : { key: 'text', title: 'NOTES', w: 30, values: {} }; };
  return [
    ...sources.map(([k, l]) => ({ label: `Shows ▸ ${c.key === k ? '● ' : ''}${l}`, icon: 'bom', action: () => set(k) })),
    'sep',
    { label: 'Insert Column Left', icon: 'bom', action: () => { cols.splice(i, 0, fresh()); done(); } },
    { label: 'Insert Column Right', icon: 'bom', action: () => { cols.splice(i + 1, 0, fresh()); done(); } },
    { label: 'Move Left', icon: 'bom', disabled: i === 0, action: () => { [cols[i - 1], cols[i]] = [cols[i], cols[i - 1]]; done(); } },
    { label: 'Move Right', icon: 'bom', disabled: i === cols.length - 1, action: () => { [cols[i + 1], cols[i]] = [cols[i], cols[i + 1]]; done(); } },
    { label: 'Rename Heading…', icon: 'note', action: async () => { const t = await rename(c.title); if (t != null) { c.title = t; done(); } } },
    { label: 'Remove Column', icon: 'trash', disabled: cols.length < 2, action: () => { cols.splice(i, 1); done(); } },
  ];
}

// The (top level) item number of a component of the assembly, or null.
export function bomItemOf(asm, compId, rows = bomRows(asm)) {
  const c = (asm?.components || []).find((x) => x.id === compId);
  if (!c) return null;
  const e = effIn(asm, c);
  return rows.find((r) => !r.depth && r.part === c.part && (r.config ?? null) === (e.config ?? null))?.item || null;
}
