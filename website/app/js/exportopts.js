// Export settings (Settings ▸ Export), kept with your settings (prefs.export): how STEP and STL files are written.

// [id, label]: the STEP application protocols the kernel writes (AP242, the newest, by default)
export const STEP_SCHEMAS = [
  ['ap242', 'AP242 (newest: model-based 3D engineering, with PMI)'],
  ['ap214', 'AP214 (automotive design: colours and layers)'],
  ['ap203', 'AP203 (configuration controlled design: geometry only)'],
];
export const STEP_UNITS = [['mm', 'Millimetres (mm)'], ['in', 'Inches (in)'], ['m', 'Metres (m)']];
export const STL_QUALITY = [['coarse', 'Coarse (small files)'], ['normal', 'Normal'], ['fine', 'Fine (smooth curves, big files)']];
export const EXPORT_DEFAULTS = { stepSchema: 'ap242', stepUnit: 'mm', stepColors: true, stepAuthor: '', stepOrg: '', stlFormat: 'binary', stlQuality: 'normal' };

export function exportOptions(prefs) {
  const o = { ...EXPORT_DEFAULTS, ...(prefs?.export || {}) };
  if (!STEP_SCHEMAS.some(([v]) => v === o.stepSchema)) o.stepSchema = 'ap242';
  if (!STEP_UNITS.some(([v]) => v === o.stepUnit)) o.stepUnit = 'mm';
  return o;
}

// What the kernel takes: { step: { schema, unit, colors }, stl: { ascii, quality } }
export function kernelExportOpts(o) {
  return { step: { schema: o.stepSchema, unit: o.stepUnit, colors: o.stepColors !== false }, stl: { ascii: o.stlFormat === 'ascii', quality: o.stlQuality } };
}

// (STEP strings: ' doubled; anything past ASCII as \X2\…\X0\)
const str = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[^\x20-\x7e]+/g, (m) => '\\X2\\' + [...m].map((c) => c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join('') + '\\X0\\') + "'";

// The fields of a STEP record's argument list (top-level commas only: not those in strings or brackets).
function fields(s) {
  const out = [];
  let depth = 0, q = false, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === "'") { if (s[i + 1] === "'") i++; else q = false; } continue; }
    if (c === "'") q = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && !depth) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

// The STEP text with its header's FILE_NAME filled in: the file's name, the author and organisation from the settings,
// and RazorCAD as the originating system.
export function stepHeader(text, o = {}, name = '') {
  const m = /FILE_NAME\s*\(/.exec(text), end = text.indexOf('ENDSEC;');
  if (!m || end < 0 || m.index > end) return text;
  const a = m.index + m[0].length, close = text.indexOf(');', a);
  if (close < 0 || close > end) return text;
  const f = fields(text.slice(a, close));
  if (f.length < 7) return text;
  if (name) f[0] = str(name);
  f[2] = `(${str(o.stepAuthor || '')})`;
  f[3] = `(${str(o.stepOrg || '')})`;
  f[5] = str('RazorCAD');
  return text.slice(0, a) + f.join(',') + text.slice(close);
}
