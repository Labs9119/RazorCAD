// Revisions of a part or assembly (doc.revisionLog: [{ rev, date, desc, by, snapshot }]): a new revision takes the
// next letter (A, B … Z, AA …) or number, is dated, keeps a copy of the document as it was (to open again later) and
// sets the document's Revision property (for title blocks and bills of materials).
export function nextRev(rev) {
  const s = String(rev || '').trim();
  if (!s) return 'A';
  if (/^\d+$/.test(s)) return String(+s + 1);
  if (/^[A-Z]+$/.test(s)) {
    const d = [...s].map((c) => c.charCodeAt(0) - 64);
    let i = d.length - 1;
    while (i >= 0 && d[i] === 26) { d[i] = 1; i--; }
    if (i < 0) d.unshift(1); else d[i]++;
    return d.map((x) => String.fromCharCode(64 + x)).join('');
  }
  const m = /^(.*?)(\d+)$/.exec(s);
  return m ? m[1] + (+m[2] + 1) : s + '1';
}
export const currentRev = (doc) => doc.revisionLog?.at(-1)?.rev || '';
// (the copy kept: the document without its log, thumbnail or undo state; very large ones are not kept)
const SNAPSHOT_MAX = 4 << 20;
export function newRevision(doc, { rev = null, desc = '', by = '', date = new Date().toISOString().slice(0, 10) } = {}) {
  const r = rev || nextRev(currentRev(doc));
  const { revisionLog: _l, thumbnail: _t, ...rest } = doc;
  const json = JSON.stringify(rest);
  const entry = { rev: r, date, desc, by, ...(json.length <= SNAPSHOT_MAX ? { snapshot: json } : {}) };
  (doc.revisionLog ||= []).push(entry);
  const props = (doc.customProps ||= []), p = props.find((x) => x.name === 'Revision');
  if (p) p.value = r; else props.push({ name: 'Revision', value: r });
  return entry;
}

// The Revisions dialog: the log, each kept copy opened as a new document, and New Revision. commit: saves the change.
export function revisionsDialog(app, doc, commit, ext = '.rcad') {
  const ui = app.ui, box = document.createElement('div');
  const render = () => {
    box.innerHTML = '';
    const list = doc.revisionLog || [];
    if (!list.length) box.insertAdjacentHTML('beforeend', '<div class="pm-hint">No revisions yet. New Revision releases the document as it is now as revision A.</div>');
    const t = document.createElement('table');
    t.className = 'bom-table';
    if (list.length) t.innerHTML = '<tr><th>Rev</th><th>Date</th><th>Description</th><th>By</th><th></th></tr>';
    for (const r of list) {
      const tr = document.createElement('tr');
      for (const k of ['rev', 'date', 'desc', 'by']) { const td = document.createElement('td'); td.textContent = r[k] || ''; tr.appendChild(td); }
      const td = document.createElement('td');
      if (r.snapshot) { const b = document.createElement('button'); b.textContent = 'Open'; b.title = 'Open the document as it was at this revision (a new, unsaved copy)'; b.onclick = () => app.openFromFile({ name: `${doc.name || 'Part'} rev ${r.rev}${ext}`, content: r.snapshot, path: null }); td.appendChild(b); }
      tr.appendChild(td);
      t.appendChild(tr);
    }
    box.appendChild(t);
  };
  render();
  ui.modal('Revisions', 'revTable', box, [
    { label: 'New Revision…', primary: true, action: () => {
      ui.promptFields('New Revision', 'revTable', [
        { key: 'rev', label: 'Revision', type: 'text', value: nextRev(currentRev(doc)) },
        { key: 'desc', label: 'Description', type: 'text', value: (doc.revisionLog || []).length ? '' : 'Initial release' },
        { key: 'by', label: 'By', type: 'text', value: '' },
      ], 'The document as it is now is kept with the revision.').then((v) => { if (!v) return; newRevision(doc, { rev: v.rev.trim() || null, desc: v.desc.trim(), by: v.by.trim() }); commit(); render(); app.status(`Revision ${currentRev(doc)} recorded.`); });
      return false;
    } },
    { label: 'Close' },
  ]);
  return { box, render };
}
