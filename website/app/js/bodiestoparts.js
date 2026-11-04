// Bodies to Parts: top-down modelling. The bodies of a master part become parts of their own, and if asked an assembly
// of them, which stay linked to the master.
//   In the master: one Bodies to Parts feature, always the last in the tree, building nothing. It lists the links:
//     links: [{ id, name, bodies, places, path, rel, config, stamp, partNumber, frame }]
//       bodies: what the part holds; places: where it goes in the assembly, when several identical bodies share one part
//       (the first is where the part is modelled); path / rel: its file, whole and from the master's folder; frame:
//       { pos, rot }, where the part sits when it isn't modelled where its body is (Make Independent)
//     assembly: { path, rel, envelope, folders } when one was made
//     publish: the ids of planes and sketches every part also takes, the skeleton to model against
//   In a part: the first feature is Imported from Master (the bodies' exact shapes and sheet metal data as text, in
//   the master's coordinates, so origin and planes are where they are in the master), then whatever the part adds.
//     master: { path, rel, link, config, name }; stamp: the state it holds; inherited: what the master last gave
//     The published planes and sketches come under it, read-only (published: { key }, the master's feature), and keep
//     their ids through updates, so what is built on them in the part follows them.
// Saving the master carries its changes into the parts. A property or appearance follows the master while it still is
// what the master last gave; changed in the part it is an override, and stays (pullInherited). Nothing goes back up.
import * as THREE from 'three';
import * as M from './model.js';
import { platform } from './platform.js';
import { hashText } from './modelcache.js';
import { groupBodies } from './bodygroups.js';
import { newAssembly } from './assembly.js';

const clone = (x) => JSON.parse(JSON.stringify(x ?? null));
// where a component goes: a place in the master, seen through a part's frame
function inFrame(frame, at) {
  if (!frame) return { pos: at.pos, rot: at.rot };
  const q = new THREE.Quaternion(...frame.rot), p = new THREE.Vector3(...at.pos).applyQuaternion(q).add(new THREE.Vector3(...frame.pos));
  return { pos: p.toArray().map((x) => +x.toFixed(9)), rot: q.multiply(new THREE.Quaternion(...at.rot)).toArray().map((x) => +x.toFixed(12)) };
}
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const norm = (p) => String(p || '').replace(/\//g, '\\');
export const sameFile = (a, b) => !!a && !!b && norm(a).toLowerCase() === norm(b).toLowerCase();
export const dirOf = (p) => norm(p).replace(/\\[^\\]*$/, '');
const baseOf = (p) => norm(p).split('\\').pop();
const stemOf = (p) => baseOf(p).replace(/\.[^.]+$/, '');
export const masterFeature = (doc) => (doc?.features || []).find((f) => f.type === 'bodiesToParts') || null;
export const masterImports = (doc) => (doc?.features || []).filter((f) => f.type === 'masterImport');
// the ids of the bodies an Imported from Master feature makes (the kernel numbers them this way)
export const importedBodyIds = (f, n) => Array.from({ length: n }, (_, i) => (i ? `${f.id}.${i + 1}` : f.id));

// path from a folder, so a folder of linked files can be moved as a whole; null on another drive
export function relPath(fromDir, path) {
  const a = norm(fromDir).split('\\'), b = norm(path).split('\\');
  if (!a[0] || a[0].toLowerCase() !== b[0].toLowerCase()) return null;
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('\\');
}
export function fromRel(dir, rel) {
  const out = norm(dir).split('\\');
  for (const s of norm(rel).split('\\')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
  return out.join('\\');
}

// a name from the template: {part} the master, {body} the body, {n} its number, two digits
export function fromTemplate(template, part, body, n) {
  const text = String(template || '{part}-{body}').replace(/\{part\}/g, part).replace(/\{body\}/g, body).replace(/\{n\}/g, String(n).padStart(2, '0'));
  return text.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/\[(\d+)\]/g, '-$1').replace(/[. ]+$/, '').trim() || 'Part';
}

// ---- what a part takes from its master besides the shapes
// (a body's own Part Number and Description aren't the master's: its custom properties go to each part without them)
const NOT_PASSED_ON = new Set(['part number']);
export function inheritedOf(doc, ids, names, partNumber = '') {
  const bodies = ids.map((id, i) => {
    const s = doc.bodies?.[id] || {};
    return { name: names[i] || '', material: s.material || null, description: s.description || '', color: s.color ?? null, look: s.look ?? null, transparent: s.transparent ?? null };
  });
  const props = new Map((doc.customProps || []).filter((p) => p?.name && !NOT_PASSED_ON.has(p.name.toLowerCase())).map((p) => [p.name, p.value ?? '']));
  if (ids.length === 1) {
    for (const p of doc.bodies?.[ids[0]]?.props || []) if (p?.name) props.set(p.name, p.value ?? '');
    if (bodies[0].description) props.set('Description', bodies[0].description);
  }
  if (partNumber) props.set('Part Number', partNumber);
  const only = (x) => x.target === 'bodies' ? x.bodies?.filter((b) => ids.includes(b)).length : x.target === 'faces' ? x.faces?.filter((q) => ids.includes(q.b)).length : x.target === 'part';
  const appearances = (doc.appearances || []).filter((x) => !x.suppressed && only(x)).map((x) => ({ ...clone(x), id: `m-${x.id}` }));
  return { material: ids.length === 1 ? M.bodyMaterialId(doc, ids[0]) : doc.material || null, props: [...props].map(([name, value]) => ({ name, value })), bodies, appearances, ids };
}
// the master's body ids in an appearance, as this part's
const appearanceHere = (ap, map) => ({ ...clone(ap), ...(ap.bodies ? { bodies: ap.bodies.filter((b) => map.has(b)).map((b) => map.get(b)) } : {}), ...(ap.faces ? { faces: ap.faces.filter((q) => map.has(q.b)).map((q) => ({ ...q, b: map.get(q.b) })) } : {}) });
const hereMap = (f, inh) => new Map(inh.ids.map((id, i) => [id, importedBodyIds(f, inh.ids.length)[i]]));

// Every place a value is taken from the master: [label, its value in the part, what the master gave, set it]
function fields(doc, f, inh) {
  const out = [['material', doc.material ?? null, inh.material ?? null, (v) => { doc.material = v; }]];
  const here = importedBodyIds(f, inh.bodies.length);
  inh.bodies.forEach((b, i) => {
    const id = here[i], s = doc.bodies?.[id] || {};
    const put = (k) => (v) => { const st = M.ensureBodySettings(doc, id); st[k] = v; };
    out.push(['body name', s.name || '', b.name || '', put('name')], ['body material', s.material || null, b.material || null, put('material')],
      ['colour', s.color ?? null, b.color ?? null, put('color')], ['look', s.look ?? null, b.look ?? null, put('look')], ['transparency', s.transparent ?? null, b.transparent ?? null, put('transparent')]);
  });
  for (const p of inh.props) {
    const cur = (doc.customProps || []).find((x) => x.name === p.name);
    out.push([p.name, cur ? cur.value ?? '' : null, p.value ?? '', (v) => {
      const list = (doc.customProps ||= []), c = list.find((x) => x.name === p.name);
      if (v == null) { doc.customProps = list.filter((x) => x !== c); if (!doc.customProps.length) delete doc.customProps; } else if (c) c.value = v; else list.push({ name: p.name, value: v });
    }]);
  }
  const map = hereMap(f, inh);
  for (const ap of inh.appearances) {
    const want = appearanceHere(ap, map), cur = (doc.appearances || []).find((x) => x.id === ap.id);
    out.push([`appearance ${ap.name || ''}`.trim(), cur ?? null, want, (v) => {
      const list = (doc.appearances ||= []), i = list.findIndex((x) => x.id === ap.id);
      if (v == null) list.splice(i, 1); else if (i >= 0) list[i] = v; else list.push(v);
      if (!list.length) delete doc.appearances;
    }]);
  }
  return out;
}
// What was changed in this part: the labels of its overrides.
export function overridesOf(doc, f) {
  if (!f.inherited) return [];
  return fields(doc, f, f.inherited).filter(([, cur, was]) => !same(cur, was)).map(([label]) => label);
}
// The master's new values taken in, the overrides left alone.
export function pullInherited(doc, f, next) {
  const old = f.inherited, wasValue = new Map();
  if (old) for (const [label, cur, was] of fields(doc, f, old)) wasValue.set(label, same(cur, was));
  for (const [label, , want, set] of fields(doc, f, next)) if (!old || wasValue.get(label) !== false) set(want);
  // (what the master no longer gives goes, unless the part changed it)
  if (old) {
    const now = new Set(fields(doc, f, next).map(([label]) => label));
    for (const [label, , , set] of fields(doc, f, old)) if (!now.has(label) && wasValue.get(label)) set(null);
  }
  f.inherited = next;
}
export function resetToMaster(doc, f) {
  for (const [, , want, set] of fields(doc, f, f.inherited)) set(want);
}

// A new part holding the bodies. payload: { data, stamp, inherited }
export function partFrom(master, name, link, payload, paths) {
  const d = M.newDoc();
  d.name = name;
  if (master.units) d.units = master.units;
  if (master.upAxis) d.upAxis = master.upAxis;
  const f = M.createFeature(d, 'masterImport', { name: 'Imported from Master', data: payload.data, stamp: payload.stamp, inherited: null, master: { link: link.id, config: link.config ?? null, name: master.name, ...paths } });
  d.features.push(f);
  pullInherited(d, f, payload.inherited);
  pullRefs(d, f, payload.refs, payload.stamp);
  return d;
}

// ---- planes and sketches the parts take as well
// (reference planes, and the sketches no feature has used: layouts. What is published stays listed. publishedIds: those)
export const publishable = (doc, publishedIds = []) => (doc?.features || []).filter((f) => !f.published && (publishedIds.includes(f.id) || f.type === 'plane' || (f.type === 'sketch' && !M.consumersOf(doc, f.id).length)));
// (a published sketch is its geometry where it is solved: no relations, no dimensions)
const NOT_A_COPY = new Set(['id', 'type', 'name', 'plane', 'rev', 'suppressed', 'parent', 'pictures', 'patterns', 'gearTrains', 'constraints']);
function sketchCopy(f, data) {
  const out = Object.fromEntries(Object.entries(clone(f)).filter(([k]) => !NOT_A_COPY.has(k)));
  return { ...out, points: clone(data.points), curves: clone(data.curves), constraints: [] };
}
// a frame as a part modelled at `frame` in the master holds it
function intoFrame(fr, frame) {
  if (!frame) return fr;
  const back = new THREE.Quaternion(...frame.rot).invert(), turn = (v) => new THREE.Vector3(...v).applyQuaternion(back).toArray();
  return { ...fr, o: new THREE.Vector3(...fr.o).sub(new THREE.Vector3(...frame.pos)).applyQuaternion(back).toArray(), u: turn(fr.u), v: turn(fr.v), n: turn(fr.n) };
}
export function refsOf(doc, ids, built, frame = null) {
  return (ids || []).flatMap((id) => {
    const f = M.findFeature(doc, id);
    if (f?.type === 'plane' && built.planes?.[id]) return [{ key: id, kind: 'plane', name: f.name, frame: intoFrame(clone(built.planes[id]), frame) }];
    if (f?.type === 'sketch' && built.sketches?.[id]) return [{ key: id, kind: 'sketch', name: f.name, frame: intoFrame(clone(built.sketches[id].frame), frame), sketch: sketchCopy(f, built.sketches[id].data) }];
    return [];
  });
}
// They come straight after the import, ids kept, so the features of the part built on them follow.
export function pullRefs(doc, g, refs = [], rev = '') {
  for (const r of refs) {
    const want = r.kind === 'plane' ? { fixedFrame: r.frame } : { ...clone(r.sketch), plane: { ref: 'face', frame: r.frame } };
    const cur = doc.features.find((x) => x.published?.key === r.key && x.parent === g.id);
    if (cur) { Object.assign(cur, want, { rev }); continue; }
    const f = M.createFeature(doc, r.kind, { name: r.name, ...want, parent: g.id, published: { key: r.key }, rev });
    let at = doc.features.indexOf(g) + 1;
    while (doc.features[at]?.parent === g.id) at++;
    doc.features.splice(at, 0, f);
  }
}

export class BodiesToParts {
  constructor(app) {
    this.app = app;
    this.status = new Map(); // link id or part feature id → { state, text }
    this.pushing = false;
    // (the files; tests put a folder of their own here)
    this.files = {
      desktop: () => platform.desktop,
      read: (path) => platform.readText(path),
      write: (path, text) => platform.writeLinked(path, text, false),
      create: (path, text) => platform.writeLinked(path, text, true),
      open: async (path) => { const f = await platform.openPath(path); if (f) await this.app.openFromFile(f); return !!f; },
      pick: () => platform.pickFolder(),
      pickFile: () => platform.openText(),
    };
  }
  get doc() { return this.app.doc; }

  // Why the master can't give its bodies as they are now, or null. A rolled-back part hasn't all its features.
  notPublishable() {
    const a = this.app, f = masterFeature(this.doc);
    if (a.doc.rollbackAt && a.doc.rollbackAt !== f?.id) return 'the part is rolled back';
    if (a.result?.errors?.size) return 'the part has rebuild errors';
    return null;
  }
  // (the kernel's last model must be this part: another tab's or a test's rebuild may have come since)
  async built() { this.lastBuilt = await this.app.kernel.rebuild(this.app.doc, null, null); }
  async payload(link) {
    const a = this.app, names = (a.result?.bodies || []);
    const got = await a.kernel.request('publishBodies', { ids: link.bodies, frame: link.frame || null });
    const gone = got.filter((b) => b.missing).map((b) => b.id);
    if (gone.length) return { gone };
    const inherited = inheritedOf(a.doc, link.bodies, link.bodies.map((id) => names.find((b) => b.id === id)?.name || ''), link.partNumber);
    const data = JSON.stringify({ bodies: got }), refs = refsOf(a.doc, masterFeature(a.doc)?.publish, this.lastBuilt || {}, link.frame);
    return { data, inherited, refs, stamp: (await hashText(data + JSON.stringify(inherited) + JSON.stringify(refs))) || String(data.length) };
  }
  async ensureFeature() {
    const a = this.app;
    let f = masterFeature(a.doc);
    if (!f) { f = M.createFeature(a.doc, 'bodiesToParts', { name: 'Bodies to Parts' }); a.doc.features.push(f); M.pinLast(a.doc); }
    return f;
  }

  // Makes the parts of plan.rows: [{ name, file, bodies, places }], then the assembly if asked; plan.folder, plan.template…
  async make(plan) {
    const a = this.app, master = a.doc, masterPath = a.filePath;
    const f = await this.ensureFeature();
    const made = [];
    if (plan.publish) f.publish = plan.publish;
    await this.built();
    // (bodies that look identical but can't be laid on each other get parts of their own)
    for (const row of [...plan.rows]) {
      for (const body of row.places?.slice(1) || []) {
        if (await a.kernel.request('bodyPlacement', { from: row.places[0], to: body }).catch(() => null)) continue;
        row.places = row.places.filter((x) => x !== body);
        plan.rows.push({ ...row, name: `${row.name}-${plan.rows.length + 1}`, file: `${row.file}-${plan.rows.length + 1}`, bodies: [body], places: [body] });
      }
    }
    for (const row of plan.rows) {
      const n = (f.nextLink = (f.nextLink || 0) + 1);
      const link = { id: `l${n}`, name: row.name, bodies: row.bodies, places: row.places || row.bodies.slice(0, 1), config: master.activeConfig ?? null, partNumber: row.partNumber || '' };
      const path = await this.freePath(plan.folder, row.file, M.PART_EXT);
      Object.assign(link, { path, rel: relPath(dirOf(masterPath), path) });
      const p = await this.payload(link);
      if (p.gone) { a.toast(`${row.name}: its body is no longer in the part`, true); continue; }
      link.stamp = p.stamp;
      const doc = partFrom(master, stemOf(path), link, p, { path: masterPath, rel: relPath(dirOf(path), masterPath) });
      await this.files.create(path, M.docJSON(doc, null, 2));
      f.links.push(link);
      made.push({ link, doc });
    }
    if (plan.assembly) f.assembly = await this.makeAssembly(plan.assembly, made, masterPath, plan.folder, f.assembly);
    a.commit();
    this.pushing = true;
    try { await a.saveFile(); } finally { this.pushing = false; }
    await this.refreshStatus();
    a.ui.renderTree();
    return made;
  }
  // (a file is never written over: the next free name)
  async freePath(folder, name, ext) {
    for (let k = 1; k < 1000; k++) {
      const path = `${folder}\\${name}${k > 1 ? `-${k}` : ''}${ext}`;
      if ((await this.files.read(path).catch(() => null)) == null) return path;
    }
    throw new Error(`No free file name for ${name}`);
  }

  // An assembly of the parts just made, each fixed where its body is (added to the one made before, if there is one).
  // plan: { name, envelope, folders }
  async makeAssembly(plan, made, masterPath, folder, before = null) {
    const a = this.app, oldPath = before && (await this.readable((before.rel && fromRel(dirOf(masterPath), before.rel)) || before.path));
    const asm = oldPath ? JSON.parse(await this.files.read(oldPath)) : newAssembly(plan.name);
    const part = (doc, path, into = asm) => { const id = 'pt' + into.nextId++; into.parts.push({ id, name: doc.name, path, doc: M.stripThumbnail(clone(doc)) }); return id; };
    const place = (into, partId, name, extra = {}) => into.components.push({ id: 'c' + into.nextId++, part: partId, name, config: null, pos: [0, 0, 0], rot: [0, 0, 0, 1], fixed: true, hidden: false, ...extra });
    if (plan.envelope && !asm.components.some((c) => c.envelope)) {
      place(asm, part(a.doc, masterPath), a.doc.name, { envelope: true });
      asm.components = [asm.components.at(-1), ...asm.components.slice(0, -1)]; // (always at the top)
    }
    const subs = new Map();
    const levelOf = (body) => {
      const g = plan.folders ? M.folderOfBody(a.doc, body) : null;
      if (!g) return asm;
      if (!subs.has(g.id)) { const sub = newAssembly(g.name); subs.set(g.id, sub); }
      return subs.get(g.id);
    };
    for (const { link, doc } of made) {
      const into = levelOf(link.bodies[0]), id = part(doc, link.path, into);
      for (const [i, body] of link.places.entries()) {
        const at = i ? await a.kernel.request('bodyPlacement', { from: link.places[0], to: body }) : null;
        place(into, id, `${doc.name}<${i + 1}>`, { master: { link: link.id, body }, ...(at ? { pos: at.pos, rot: at.rot } : {}) });
      }
    }
    for (const sub of subs.values()) {
      const old = asm.parts.find((p) => p.name === sub.name && p.doc?.kind === 'assembly');
      if (old) { old.doc.components.push(...sub.components); old.doc.parts.push(...sub.parts); old.doc.nextId = Math.max(old.doc.nextId, sub.nextId); if (old.path) await this.files.write(old.path, JSON.stringify(old.doc, null, 2)); continue; }
      const path = await this.freePath(folder, sub.name, '.rasm'), id = 'pt' + asm.nextId++;
      await this.files.create(path, JSON.stringify(sub, null, 2));
      asm.parts.push({ id, name: sub.name, path, doc: sub });
      place(asm, id, sub.name);
    }
    const path = oldPath || (await this.freePath(folder, plan.name, '.rasm'));
    await (oldPath ? this.files.write(path, JSON.stringify(asm, null, 2)) : this.files.create(path, JSON.stringify(asm, null, 2)));
    return { path, rel: relPath(dirOf(masterPath), path), envelope: !!plan.envelope, folders: !!plan.folders };
  }

  // ---- saving the master
  // The links whose parts no longer hold what the master gives: [{ link, payload }]
  async changes() {
    const f = masterFeature(this.doc), out = [];
    await this.built();
    for (const link of f?.links || []) {
      if ((link.config ?? null) !== (this.doc.activeConfig ?? null)) continue;
      const payload = await this.payload(link);
      if (!payload.gone && payload.stamp !== link.stamp) out.push({ link, payload });
    }
    return out;
  }
  async afterSave() {
    const a = this.app, f = masterFeature(this.doc);
    if (!this.pushing && masterImports(this.doc).length) await this.refreshStatus(); // (a part: its overrides, as saved)
    if (this.pushing || !f?.links.length || !this.files.desktop()) return;
    const why = this.notPublishable();
    if (why) { a.status(`Linked parts not updated: ${why}`); return; }
    const list = await this.changes();
    if (!list.length) { await this.refreshStatus(); a.ui.renderTree(); return; }
    if (!a.ui.prefs?.b2pAuto && !(await this.confirm(list))) return;
    await this.push(list);
  }
  async confirm(list) {
    const a = this.app, f = masterFeature(this.doc);
    const items = list.map((x) => `<li>${esc(x.link.name)}</li>`).join('') + (f.assembly ? `<li>${esc(stemOf(f.assembly.path))}</li>` : '');
    const body = document.createElement('div');
    body.innerHTML = `<p>These change with this save:</p><ul style="margin:6px 0 10px 18px;padding:0">${items}</ul>`;
    const box = document.createElement('label');
    box.innerHTML = '<input type="checkbox"> Update them without asking';
    body.appendChild(box);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; if (v && box.querySelector('input').checked) { a.ui.prefs.b2pAuto = true; a.ui.savePrefs?.(); } resolve(v); };
      a.ui.modal('Update Linked Parts', 'part', body, [{ label: 'Later', action: () => finish(false) }, { label: 'Update', primary: true, action: () => finish(true) }]);
    });
  }
  async push(list) {
    const a = this.app, f = masterFeature(this.doc);
    this.pushing = true;
    try {
      for (const { link, payload } of list) {
        const path = await this.linkedPath(link);
        const done = path && (await this.updatePart(path, link, payload));
        if (done) link.stamp = payload.stamp;
        else this.status.set(link.id, { state: 'missing', text: 'its file was not found' });
      }
      if (f.assembly) await this.updateAssembly(f);
      await a.saveFile();
    } finally { this.pushing = false; }
    await this.refreshStatus();
    a.ui.renderTree();
    a.status(`${list.length} linked part${list.length === 1 ? '' : 's'} updated`);
  }
  // the file of a link: beside the master as it was (moved together), else where it was
  async linkedPath(link) {
    for (const p of [link.rel && fromRel(dirOf(this.app.filePath), link.rel), link.path]) {
      if (p && (await this.files.read(p).catch(() => null)) != null) return p;
    }
    return null;
  }
  async updatePart(path, link, payload) {
    const a = this.app, tab = a.tabs.find((t) => t.kind !== 'drawing' && t.filePath && sameFile(t.filePath, path));
    const take = (doc) => {
      const f = masterImports(doc).find((x) => x.master?.link === link.id);
      if (!f) return false;
      f.data = payload.data;
      f.stamp = payload.stamp;
      pullInherited(doc, f, payload.inherited);
      pullRefs(doc, f, payload.refs, payload.stamp);
      return true;
    };
    if (tab) {
      if (!take(tab.doc)) return false;
      tab.model = null;
      if (tab.dirty) return true; // (its unsaved edits are the user's to save, with this in)
      await this.files.write(path, JSON.stringify(tab.doc, null, 2));
      return true;
    }
    const doc = JSON.parse(await this.files.read(path));
    if (!take(doc)) return false;
    await this.files.write(path, JSON.stringify(doc, null, 2));
    return true;
  }
  // Goes through an assembly and the sub-assemblies in it, in files or inside it: fn(doc) → changed
  async eachAssembly(path, fn) {
    const tab = this.app.tabs.find((t) => t.kind === 'drawing' && t.drawing?.doc?.kind === 'assembly' && sameFile(t.drawing.filePath, path));
    const text = tab ? null : await this.files.read(path).catch(() => null);
    if (!tab && text == null) return;
    const doc = tab ? tab.drawing.doc : JSON.parse(text);
    const walk = async (d) => {
      let changed = await fn(d);
      for (const p of d.parts || []) {
        if (p.doc?.kind !== 'assembly') continue;
        if (p.path) { await this.eachAssembly(p.path, fn); const t = await this.files.read(p.path).catch(() => null); if (t != null) { const fresh = JSON.parse(t); if (!same(fresh, p.doc)) { p.doc = fresh; changed = true; } } } else if (await walk(p.doc)) changed = true;
      }
      return changed;
    };
    const changed = await walk(doc);
    if (tab) { tab.drawing.dirty = tab.drawing.dirty || changed; await tab.drawing.refreshParts?.(); } else if (changed) await this.files.write(path, JSON.stringify(doc, null, 2));
  }
  assemblyPath(f) { return (f.assembly.rel && fromRel(dirOf(this.app.filePath), f.assembly.rel)) || f.assembly.path; }
  // The assembly's components of these parts go where their bodies now are, unless mated or moved by hand there.
  async updateAssembly(f) {
    const a = this.app;
    await this.eachAssembly(this.assemblyPath(f), async (doc) => {
      const mated = new Set((doc.mates || []).flatMap((m) => [m.a?.comp, m.b?.comp]));
      let moved = false;
      for (const c of doc.components) {
        const link = c.master && f.links.find((l) => l.id === c.master.link);
        if (!link || mated.has(c.id) || !c.fixed || c.master.body === link.places[0]) continue;
        const at = await a.kernel.request('bodyPlacement', { from: link.places[0], to: c.master.body }).catch(() => null);
        const pose = at && inFrame(link.frame, at);
        if (pose && !same(pose.pos, c.pos)) { c.pos = pose.pos; c.rot = pose.rot; moved = true; }
      }
      return moved;
    });
  }

  // Make Independent: a component of a part shared by identical bodies gets a part file of its own, a copy of the
  // shared one with all that was added to it, to change on its own. It stays linked to its body in the master, and
  // stays modelled where the shared part is, so the component doesn't move and the copied features still fit.
  async makeIndependent(ed, c) {
    const a = this.app, p = ed.part(c.part), doc = clone(p.doc), g = masterImports(doc).find((x) => x.master?.link === c.master?.link);
    if (!g || !p.path) { a.toast('This part is not linked to a master', true); return null; }
    const masterPath = (g.master.rel && (await this.readable(fromRel(dirOf(p.path), g.master.rel)))) || (await this.readable(g.master.path));
    if (!masterPath) { a.toast('The master part was not found', true); return null; }
    const tab = a.tabs.find((t) => t.kind !== 'drawing' && t.filePath && sameFile(t.filePath, masterPath));
    const master = tab ? tab.doc : JSON.parse(await this.files.read(masterPath)), f = masterFeature(master), link = f?.links.find((l) => l.id === c.master.link);
    if (!link || !link.places.includes(c.master.body)) { a.toast('The master no longer has this body', true); return null; }
    const path = await this.freePath(dirOf(p.path), `${stemOf(p.path)}-${link.places.indexOf(c.master.body) + 1}`, M.PART_EXT);
    const n = (f.nextLink = (f.nextLink || 0) + 1), id = `l${n}`;
    const isFirst = c.master.body === link.places[0], moved = !same(c.pos, [0, 0, 0]) || !same(c.rot, [0, 0, 0, 1]);
    // (a part of its own has a number of its own)
    const number = link.partNumber ? `${link.partNumber}-${link.places.indexOf(c.master.body) + 1}` : '';
    if (number) {
      for (const list of [doc.customProps, g.inherited?.props]) { const row = list?.find((x) => x.name === 'Part Number'); if (row) row.value = number; }
    }
    const own = { id, name: stemOf(path), bodies: [c.master.body], places: [c.master.body], config: link.config ?? null, partNumber: number, path, rel: relPath(dirOf(masterPath), path), stamp: g.stamp, ...(moved ? { frame: { pos: c.pos.slice(), rot: c.rot.slice() } } : {}) };
    link.places = link.places.filter((b) => b !== c.master.body);
    // (the one that was modelled in place goes: the shared part stays as it is, now following the next body)
    if (isFirst && link.places.length) {
      const next = ed.doc.components.find((x) => x.master?.link === link.id && x.master.body === link.places[0]);
      link.bodies = [link.places[0]];
      if (next && (!same(next.pos, [0, 0, 0]) || !same(next.rot, [0, 0, 0, 1]))) link.frame = { pos: next.pos.slice(), rot: next.rot.slice() };
    }
    f.links.push(own);
    doc.name = stemOf(path);
    g.master = { ...g.master, link: id, rel: relPath(dirOf(path), masterPath), path: masterPath };
    await this.files.create(path, JSON.stringify(doc, null, 2));
    if (tab) { tab.dirty = true; tab.model = null; } else await this.files.write(masterPath, JSON.stringify(master, null, 2));
    ed.begin();
    c.part = ed.addPart(doc, path, null);
    c.master = { link: id, body: c.master.body };
    c.name = c.name.replace(/^.*(?=<)/, doc.name);
    ed.change(`${doc.name} is a part of its own now. It is still linked to its body in ${master.name}.`);
    ed.loadParts?.();
    return path;
  }
  async readable(path) { return path && (await this.files.read(path).catch(() => null)) != null ? path : null; }

  // ---- what each link is doing, for the tree
  async refreshStatus() {
    if (!this.files.desktop()) return;
    const a = this.app, f = masterFeature(this.doc), hasLinks = f?.links?.length, imports = masterImports(this.doc);
    if (!hasLinks && !imports.length) return;
    const bodies = new Set((a.result?.bodies || []).map((b) => b.id));
    for (const link of f?.links || []) {
      if (a.result?.bodies && link.bodies.some((id) => !bodies.has(id))) { this.status.set(link.id, { state: 'gone', text: 'its body is gone from this part' }); continue; }
      const path = await this.linkedPath(link);
      if (!path) { this.status.set(link.id, { state: 'missing', text: 'its file was not found' }); continue; }
      const tab = a.tabs.find((t) => t.kind !== 'drawing' && t.filePath && sameFile(t.filePath, path));
      const doc = tab ? tab.doc : JSON.parse(await this.files.read(path)), g = masterImports(doc).find((x) => x.master?.link === link.id);
      this.status.set(link.id, !g ? { state: 'broken', text: 'its link was broken' } : g.stamp === link.stamp ? { state: 'ok', text: 'up to date' } : { state: 'stale', text: 'out of date' });
    }
    for (const g of imports) {
      const over = overridesOf(this.doc, g).length, more = over ? `, ${over} override${over === 1 ? '' : 's'}` : '';
      if (!g.master) { this.status.set(g.id, { state: 'broken', text: 'link broken' }); continue; }
      const path = await this.masterPath(g);
      if (!path) { this.status.set(g.id, { state: 'missing', text: 'master not found' + more }); continue; }
      const link = masterFeature(JSON.parse(await this.files.read(path)))?.links?.find((x) => x.id === g.master.link);
      this.status.set(g.id, !link ? { state: 'broken', text: 'no longer in the master' + more } : link.stamp === g.stamp ? { state: 'ok', text: 'up to date' + more } : { state: 'stale', text: 'out of date' + more });
    }
    a.ui.renderTree();
  }
  statusOf(id) { return this.status.get(id) || null; }
  async masterPath(g) {
    for (const p of [g.master?.rel && this.app.filePath && fromRel(dirOf(this.app.filePath), g.master.rel), g.master?.path]) {
      if (p && (await this.files.read(p).catch(() => null)) != null) return p;
    }
    return null;
  }

  // ---- commands in the trees
  async openPart(link) { const p = await this.linkedPath(link); if (p) return this.files.open(p); this.app.toast(`${link.name}: its file was not found`, true); return false; }
  async openMaster(g) { const p = await this.masterPath(g); if (p) return this.files.open(p); this.app.toast('The master part was not found', true); return false; }
  // A published plane or sketch: on or off (the parts keep what they have when it goes off, as it was).
  togglePublish(id) {
    const a = this.app, f = masterFeature(a.doc);
    if (!f) return;
    f.publish = (f.publish || []).includes(id) ? f.publish.filter((x) => x !== id) : [...(f.publish || []), id];
    a.commit();
    a.ui.renderTree();
    a.status('The linked parts take this when this part is saved');
  }
  // Relink: a body that went (a master edit replaced it) gets another in its place; a file that moved is found again.
  async relink(link) {
    const st = this.statusOf(link.id)?.state;
    if (st === 'gone') return this.relinkBodies(link);
    return this.relinkFile(link);
  }
  async relinkBodies(link) {
    const a = this.app, f = masterFeature(a.doc), all = a.result?.bodies || [], here = new Set(all.map((b) => b.id));
    const taken = new Set(f.links.flatMap((l) => [...l.bodies, ...(l.places || [])]));
    const free = all.filter((b) => !taken.has(b.id));
    const gone = link.bodies.filter((id) => !here.has(id));
    if (!free.length) { a.toast('Every body of this part is linked already: there is none to relink to', true); return false; }
    const names = link.bodies.length === 1 ? [link.name] : gone;
    const v = await a.ui.promptFields(`Relink ${link.name}`, 'part', gone.map((id, i) => ({ key: id, label: names[i], type: 'select', value: free[0].id, options: free.map((b) => [b.id, b.name]) })), 'The body this part followed is no longer in the master. Choose the one it follows now.');
    if (!v) return false;
    const swap = (id) => v[id] ?? id;
    link.bodies = link.bodies.map(swap);
    link.places = (link.places || []).map(swap);
    await this.swapComponents(f, link, swap);
    this.status.delete(link.id);
    a.commit();
    a.status(`${link.name} follows its new body once this part is saved`);
    await this.refreshStatus();
    a.ui.renderTree();
    return true;
  }
  // (the assembly knows its components by body too)
  async swapComponents(f, link, swap) {
    if (!f.assembly) return;
    await this.eachAssembly(this.assemblyPath(f), async (doc) => {
      let changed = false;
      for (const c of doc.components) if (c.master?.link === link.id && swap(c.master.body) !== c.master.body) { c.master.body = swap(c.master.body); changed = true; }
      return changed;
    });
  }
  async relinkFile(link) {
    const a = this.app, got = await this.files.pickFile();
    if (!got?.path) return false;
    const doc = JSON.parse(got.content);
    if (!masterImports(doc).some((g) => g.master?.link === link.id)) { a.toast(`${baseOf(got.path)} isn't the part linked here`, true); return false; }
    Object.assign(link, { path: got.path, rel: relPath(dirOf(a.filePath), got.path) });
    a.commit();
    await this.refreshStatus();
    a.ui.renderTree();
    return true;
  }
  // In a part: the master found again, when it moved.
  async relinkMaster(g) {
    const a = this.app, got = await this.files.pickFile();
    if (!got?.path) return false;
    const f = masterFeature(JSON.parse(got.content));
    if (!f?.links.some((l) => l.id === g.master.link)) { a.toast(`${baseOf(got.path)} isn't this part's master`, true); return false; }
    g.master = { ...g.master, path: got.path, rel: a.filePath ? relPath(dirOf(a.filePath), got.path) : null };
    a.commit();
    await this.refreshStatus();
    a.ui.renderTree();
    return true;
  }
  // The part keeps its geometry and stops following the master.
  async breakLink(g) {
    const a = this.app;
    const c = await a.ui.choose('Break Link', 'part', '<p>This part keeps its shape and stops following the master. The link can\'t be made again.</p>', [['break', 'Break Link', true], ['cancel', 'Cancel']]);
    if (c !== 'break') return;
    g.master = null;
    g.name = 'Imported Body';
    a.commit();
    this.status.set(g.id, { state: 'broken', text: 'link broken' });
    a.ui.renderTree();
  }
  // In the master: the part is left as it is; only the link goes.
  removeLink(link) {
    const a = this.app, f = masterFeature(a.doc);
    f.links = f.links.filter((x) => x !== link);
    this.status.delete(link.id);
    a.commit();
    a.ui.renderTree();
  }
  reset(g) {
    const a = this.app;
    resetToMaster(a.doc, g);
    a.commit();
    a.rebuild?.();
    this.refreshStatus();
  }

  // ---- the dialog
  // only: the ids of the bodies to tick (the body the command was started from), the rest left for the user to tick
  async start(only = null) {
    const a = this.app;
    if (!this.files.desktop()) { a.toast('Bodies to Parts needs real files: it is part of the desktop app', true); return; }
    if (a.mode === 'drawing') return;
    if (!a.filePath) { await a.saveFile(); if (!a.filePath) return; }
    const why = this.notPublishable();
    if (why) { a.toast(`Bodies to Parts: ${why}`, true); return; }
    const linked = new Set((masterFeature(a.doc)?.links || []).flatMap((l) => [...l.bodies, ...(l.places || [])]));
    const free = (a.result?.bodies || []).filter((b) => !linked.has(b.id));
    if (!free.length) { a.toast('Every body of this part is linked to a part already'); return; }
    const rows = groupBodies(free).map((g, i) => ({ on: !only || g.members.some((b) => only.includes(b.id)), each: false, members: g.members, name: g.rep.name, n: i + 1 }));
    const plan = await this.dialog(rows, free);
    if (plan) await a.withProgress('Making the parts…', () => this.make(plan));
    if (plan?.assembly && masterFeature(a.doc)?.assembly) await this.files.open(masterFeature(a.doc).assembly.path);
  }
  // From the dialog's rows: the parts to make. Rows with the same file name are one multi-body part.
  static planRows(rows, master, template, numbers) {
    const out = new Map();
    let k = 0;
    for (const r of rows) {
      if (!r.on) continue;
      const list = r.each ? r.members.map((b, i) => ({ b, members: [b], suffix: r.members.length > 1 ? `-${i + 1}` : '' })) : [{ b: r.members[0], members: r.members, suffix: '' }];
      for (const { b, members, suffix } of list) {
        const file = (r.file ?? fromTemplate(template, master, r.name, r.n)) + suffix;
        const at = out.get(file.toLowerCase());
        if (at) { at.bodies.push(b.id); continue; }
        k++;
        out.set(file.toLowerCase(), { name: file, file, bodies: [b.id], places: members.map((m) => m.id), partNumber: numbers ? fromTemplate(numbers, master, r.name, k) : '' });
      }
    }
    return [...out.values()];
  }
  dialog(rows, free) {
    const a = this.app, master = a.doc.name, ui = a.ui;
    return new Promise((resolve) => {
      let folder = dirOf(a.filePath), template = '{body}', numbers = '';
      const body = document.createElement('div');
      body.className = 'b2p';
      const multi = free.length > 1;
      const render = () => {
        body.innerHTML = '';
        const put = (html) => { const d = document.createElement('div'); d.innerHTML = html; body.appendChild(d); return d; };
        put('<p class="pm-hint" style="margin-top:0">Each ticked body becomes a part of its own, linked to this part: saving this part updates it, and what you add in it stays there. Give several bodies the same file name to put them in one part.</p>');
        const f = put(`<div class="pm-field"><label>Folder</label> <span class="b2p-folder"></span> <button class="pm-btn" data-pick>Choose…</button></div>
          <div class="pm-field"><label>File names</label><input data-template style="width:100%"></div>
          <div class="pm-field"><label>Part numbers</label><input data-numbers style="width:100%" placeholder="none"></div>
          <p class="pm-hint">{part} is this part, {body} the body, {n} its number.</p>`);
        f.querySelector('.b2p-folder').textContent = folder;
        const t = f.querySelector('[data-template]'), n = f.querySelector('[data-numbers]');
        t.value = template; n.value = numbers;
        t.onchange = () => { template = t.value; rows.forEach((r) => delete r.file); render(); };
        n.onchange = () => { numbers = n.value; };
        f.querySelector('[data-pick]').onclick = async () => { const p = await this.files.pick(); if (p) { folder = norm(p); render(); } };
        const list = put('');
        rows.forEach((r) => {
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;gap:8px;align-items:center;margin:3px 0';
          row.innerHTML = `<input type="checkbox" ${r.on ? 'checked' : ''}><input class="b2p-name" style="flex:1">${r.members.length > 1 ? `<select><option value="one">One part, ${r.members.length} places</option><option value="each">A part for each</option></select>` : ''}`;
          const [on, name] = row.querySelectorAll('input'), sel = row.querySelector('select');
          on.onchange = () => { r.on = on.checked; };
          name.value = r.file ?? fromTemplate(template, master, r.name, r.n);
          name.onchange = () => { r.file = name.value.trim() || undefined; };
          if (sel) { sel.value = r.each ? 'each' : 'one'; sel.onchange = () => { r.each = sel.value === 'each'; }; }
          list.appendChild(row);
        });
        const asm = put(`<label><input type="checkbox" data-asm ${opts.asm ? 'checked' : ''}> Make Assembly</label>
          <div class="pm-field" ${opts.asm ? '' : 'hidden'}><label>Name</label><input data-asmname style="width:100%"></div>
          <div ${opts.asm ? '' : 'hidden'}><label><input type="checkbox" data-env ${opts.envelope ? 'checked' : ''}> Add this part as an envelope (at the top, kept out of the BOM and mass)</label></div>
          ${(a.doc.bodyFolders || []).length ? `<div ${opts.asm ? '' : 'hidden'}><label><input type="checkbox" data-folders ${opts.folders ? 'checked' : ''}> Body folders become sub-assemblies</label></div>` : ''}`);
        asm.querySelector('[data-asm]').onchange = (e) => { opts.asm = e.target.checked; render(); };
        asm.querySelector('[data-env]').onchange = (e) => { opts.envelope = e.target.checked; };
        const nm = asm.querySelector('[data-asmname]');
        nm.value = opts.name;
        nm.onchange = () => { opts.name = nm.value.trim() || opts.name; };
        const fb = asm.querySelector('[data-folders]');
        if (fb) fb.onchange = (e) => { opts.folders = e.target.checked; };
        const refs = publishable(a.doc, [...opts.publish]);
        if (refs.length) {
          const box = put(`<details ${opts.publish.size ? 'open' : ''}><summary>Planes and sketches for the parts (${refs.length})</summary><p class="pm-hint" style="margin:4px 0">Every part takes the ones you tick, read-only, to model against. Sketches a feature has used aren't listed.</p></details>`);
          const pub = box.querySelector('details');
          for (const f of refs) {
            const row = document.createElement('label');
            row.style.display = 'block';
            row.innerHTML = `<input type="checkbox" ${opts.publish.has(f.id) ? 'checked' : ''}> `;
            row.appendChild(document.createTextNode(f.name));
            row.querySelector('input').onchange = (e) => { if (e.target.checked) opts.publish.add(f.id); else opts.publish.delete(f.id); };
            pub.appendChild(row);
          }
        }
      };
      const opts = { asm: multi, envelope: multi, folders: false, name: `${master} Assembly`, publish: new Set(masterFeature(a.doc)?.publish || []) };
      render();
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const dlg = ui.modal('Bodies to Parts', 'part', body, [
        { label: 'Cancel', action: () => finish(null) },
        { label: 'Make Parts', primary: true, action: () => {
          const list = BodiesToParts.planRows(rows, master, template, numbers);
          if (!list.length) { a.toast('Tick the bodies to make parts of'); return false; }
          finish({ folder, rows: list, publish: [...opts.publish], assembly: opts.asm ? { name: opts.name, envelope: opts.envelope, folders: opts.folders } : null });
          return true;
        } },
      ]);
      dlg.body?.parentElement?.classList.add('modal-wide');
    });
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
