// 3D annotations (model based definition): notes, dimensions with tolerances, geometric tolerances (feature control
// frames), datums and surface finish, kept in the part (doc.annotations) and shown in the view with a leader to the point
// on the model they are about. A STEP export of an annotated part carries each annotation as a
// property of the part (its kind and text), for the next program to read (the kernel writes STEP as AP242).
import * as THREE from 'three';

// doc.annotations: [{ id, kind: 'note' | 'dim' | 'gdt' | 'datum' | 'finish', p (the point on the model), q (a dimension's
// second point), at (the label), text, value, plus, minus, symbol, tol, datums, letter, ra }]
export const GDT_SYMBOLS = [
  ['position', '⌖', 'Position'], ['flatness', '⏥', 'Flatness'], ['straightness', '⏤', 'Straightness'], ['circularity', '○', 'Circularity'],
  ['cylindricity', '⌭', 'Cylindricity'], ['profileLine', '⌒', 'Profile of a line'], ['profileSurface', '⌓', 'Profile of a surface'],
  ['perpendicularity', '⟂', 'Perpendicularity'], ['parallelism', '∥', 'Parallelism'], ['angularity', '∠', 'Angularity'],
  ['concentricity', '◎', 'Concentricity'], ['symmetry', '⌯', 'Symmetry'], ['runout', '↗', 'Circular runout'], ['totalRunout', '⌰', 'Total runout'],
];
const fmtN = (x) => (Number.isFinite(+x) ? String(+(+x).toFixed(4)) : String(x ?? ''));
// The annotation's text as shown (and as written to STEP).
export function annotationText(a) {
  if (a.kind === 'dim') {
    const p = +a.plus || 0, m = +a.minus || 0;
    const tol = !p && !m ? '' : p === m ? ` ±${fmtN(p)}` : ` +${fmtN(p)}/−${fmtN(m)}`;
    return `${a.prefix || ''}${fmtN(a.value)}${tol}`;
  }
  if (a.kind === 'gdt') {
    const s = GDT_SYMBOLS.find((x) => x[0] === a.symbol);
    return [s ? s[1] : '?', `${a.dia ? 'Ø' : ''}${fmtN(a.tol)}`, ...String(a.datums || '').split(/[\s,|]+/).filter(Boolean)].join(' | ');
  }
  if (a.kind === 'datum') return String(a.letter || 'A');
  if (a.kind === 'finish') return `√ Ra ${fmtN(a.ra)}${a.text ? ` ${a.text}` : ''}`;
  return String(a.text || '');
}
const KIND_NAME = { note: 'Note', dim: 'Dimension', gdt: 'Geometric tolerance', datum: 'Datum', finish: 'Surface finish' };

// The STEP text with the annotations added as properties of the part (PROPERTY_DEFINITION on its product definition,
// each with a DESCRIPTIVE_REPRESENTATION_ITEM holding the kind and the text, and where it points).
export function stepWithAnnotations(text, list) {
  if (!list?.length) return text;
  const pd = /#(\d+)\s*=\s*PRODUCT_DEFINITION\s*\(/.exec(text);
  const end = text.lastIndexOf('ENDSEC;');
  if (!pd || end < 0) return text;
  let n = Math.max(...[...text.matchAll(/#(\d+)\s*=/g)].map((m) => +m[1])) + 1;
  // (STEP strings: ' doubled; anything past ASCII as \X2\…\X0\)
  const str = (s) => "'" + String(s).replace(/'/g, "''").replace(/\\/g, '\\\\').replace(/[^\x20-\x7e]+/g, (m) => '\\X2\\' + [...m].map((c) => c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join('') + '\\X0\\') + "'";
  const ctx = n++, lines = [`#${ctx}=REPRESENTATION_CONTEXT('PMI','3D annotations');`];
  for (const a of list) {
    const at = (v) => (v ? `(${v.map((x) => +x.toFixed(4)).join(', ')})` : '');
    const desc = `${KIND_NAME[a.kind] || a.kind}: ${annotationText(a)}${a.p ? ` at ${at(a.p)}` : ''}${a.q ? ` to ${at(a.q)}` : ''}`;
    const P = n++, D = n++, Rp = n++, PR = n++;
    lines.push(`#${P}=PROPERTY_DEFINITION(${str('PMI ' + (KIND_NAME[a.kind] || a.kind))},${str(annotationText(a))},#${pd[1]});`);
    lines.push(`#${D}=DESCRIPTIVE_REPRESENTATION_ITEM(${str(a.kind)},${str(desc)});`);
    lines.push(`#${Rp}=REPRESENTATION(${str(a.id)},(#${D}),#${ctx});`);
    lines.push(`#${PR}=PROPERTY_DEFINITION_REPRESENTATION(#${P},#${Rp});`);
  }
  return text.slice(0, end) + lines.join('\n') + '\n' + text.slice(end);
}

// The labels and leaders in the view, following it.
export class Annotations3D {
  constructor(app) {
    this.app = app;
    this.items = [];
    this.svg = null;
    this.place = () => this.position();
  }
  get vp() { return this.app.viewport; }
  clear() {
    for (const it of this.items) it.el.remove();
    this.items = [];
    this.svg?.remove();
    this.svg = null;
    this.vp.frameCallbacks.delete(this.place);
  }
  refresh() {
    this.clear();
    const doc = this.app.doc, list = doc?.annotations || [];
    if (!list.length || doc.annotationsHidden || this.app.mode === 'sketch') return;
    const NS = 'http://www.w3.org/2000/svg';
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('class', 'annot3d-leaders');
    this.vp.labelsEl.appendChild(this.svg);
    for (const a of list) {
      const el = document.createElement('div');
      el.className = `annot3d annot3d-${a.kind}`;
      const t = annotationText(a);
      el.innerHTML = a.kind === 'gdt' ? t.split(' | ').map((c) => `<b>${c.replace(/[&<>]/g, '')}</b>`).join('') : t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
      el.title = `${KIND_NAME[a.kind]}: ${t}`;
      this.vp.labelsEl.appendChild(el);
      const lines = [a.p, a.q].filter(Boolean).map(() => { const l = document.createElementNS(NS, 'line'); this.svg.appendChild(l); return l; });
      this.items.push({ a, el, lines, P: a.p && new THREE.Vector3(...a.p), Q: a.q && new THREE.Vector3(...a.q), A: new THREE.Vector3(...(a.at || a.p)) });
    }
    this.vp.frameCallbacks.add(this.place);
    this.position();
  }
  position() {
    for (const it of this.items) {
      const s = this.vp.project(it.A);
      it.el.style.left = s.x + 'px'; it.el.style.top = s.y + 'px';
      [it.P, it.Q].filter(Boolean).forEach((W, k) => { const q = this.vp.project(W), l = it.lines[k]; l.setAttribute('x1', s.x); l.setAttribute('y1', s.y); l.setAttribute('x2', q.x); l.setAttribute('y2', q.y); });
    }
  }
  // Where a new label goes: up and to the right of its point, by a share of the model's size, as the view is now.
  labelAt(p, q = null) {
    const cam = this.vp.camera, up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion), right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const size = this.vp.bodyGeo?.boundingSphere?.radius || 50;
    const base = q ? new THREE.Vector3(...p).add(new THREE.Vector3(...q)).multiplyScalar(0.5) : new THREE.Vector3(...p);
    return base.addScaledVector(up, size * 0.25).addScaledVector(right, size * 0.15).toArray();
  }
}
