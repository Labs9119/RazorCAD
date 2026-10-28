// RazorCAD's manual inside RazorCAD: searched by what you type (Help ▸ User Manual, F1, the command search, a
// panel's ?), one section at a time, in a panel docked at the right of the window or in a window of its own that can
// go anywhere, onto another monitor too. app/help/manual.json is built from Manual/manual_source.md
// (tools/build_app_help.py): { version, sections: [{ id, chapter, parent, title, level, terms, text, html }] }.
let loading = null;
export function loadManual() {
  loading ||= fetch(new URL('../help/manual.json', import.meta.url)).then((r) => {
    if (!r.ok) throw new Error('The manual could not be loaded');
    return r.json();
  }).then((m) => {
    for (const s of m.sections) {
      s._title = s.title.toLowerCase();
      s._terms = s.terms.join(' | ').toLowerCase();
      s._text = s.text.toLowerCase();
    }
    return m;
  });
  loading.catch(() => { loading = null; });
  return loading;
}

const escRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (q) => String(q || '').toLowerCase().replace(/[“”"]/g, ' ').split(/[^\p{L}\p{N}.+-]+/u).filter((w) => w.length > 1 || /\d/.test(w));

// The sections that have every word, best first: [{ s, score }]. A word in the title counts most, then in an index
// term, then in the text (whole words more than parts of words; often more than once).
export function searchManual(m, q, max = 40) {
  const ws = words(q), phrase = ws.join(' ');
  if (!ws.length) return [];
  const out = [];
  for (const s of m.sections) {
    let score = 0, ok = true;
    for (const w of ws) {
      const inTitle = s._title.includes(w), inTerms = s._terms.includes(w), whole = new RegExp(`(^|[^\\p{L}\\p{N}])${escRe(w)}`, 'u');
      const n = Math.min(12, s._text.split(w).length - 1);
      if (!inTitle && !inTerms && !n) { ok = false; break; }
      score += (inTitle ? (whole.test(s._title) ? 30 : 15) : 0) + (inTerms ? (whole.test(s._terms) ? 12 : 6) : 0) + n * (whole.test(s._text) ? 1 : 0.4);
    }
    if (!ok) continue;
    if (s._title === phrase) score += 80;
    else if (s._title.startsWith(phrase)) score += 40;
    else if (s._title.includes(phrase)) score += 25;
    if (s._terms.split(' | ').includes(phrase)) score += 30;
    if (ws.length > 1 && s._text.includes(phrase)) score += 10;
    score -= s.level === 1 ? 2 : 0;
    out.push({ s, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}

// Text around the first of the words in a section, the words marked (HTML).
function snippet(s, ws) {
  const t = s.text, lo = s._text;
  let at = -1;
  for (const w of ws) { const i = lo.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const from = Math.max(0, at - 60), part = (from ? '…' : '') + t.slice(from, from + 170) + (from + 170 < t.length ? '…' : '');
  const html = part.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  return ws.length ? html.replace(new RegExp(`(${ws.map(escRe).join('|')})`, 'gi'), '<mark>$1</mark>') : html;
}

const h = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k.startsWith('on')) e[k] = v; else e.setAttribute(k, v); } if (html) e.innerHTML = html; return e; };

// The manual's view: a search box, the sections found, one section shown (its words marked), back and forward.
// tools: buttons for the header ([{ label, title, onclick }]). onShow(id, query): the section shown.
export class HelpView {
  constructor(root, { tools = [], onShow = null } = {}) {
    this.root = root; this.onShow = onShow; this.history = []; this.at = -1; this.query = ''; this.current = null;
    root.classList.add('help-view');
    const head = h('div', { class: 'hv-head' });
    this.back = h('button', { class: 'hv-nav', title: 'Back', 'aria-label': 'Back', onclick: () => this.step(-1) }, '‹');
    this.fwd = h('button', { class: 'hv-nav', title: 'Forward', 'aria-label': 'Forward', onclick: () => this.step(1) }, '›');
    this.input = h('input', { type: 'search', class: 'hv-q', placeholder: 'Search the manual…', spellcheck: 'false', 'aria-label': 'Search the manual' });
    head.append(this.back, this.fwd, this.input);
    for (const t of tools) head.appendChild(h('button', { class: 'hv-tool', title: t.title, 'aria-label': t.title, onclick: t.onclick, ...(t.attrs || {}) }, t.label));
    this.body = h('div', { class: 'hv-body' });
    root.append(head, this.body);
    let timer = 0;
    this.input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => this.search(this.input.value, true), 120); });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // (typing here is not a RazorCAD shortcut)
      if (e.key === 'Enter') { e.preventDefault(); const first = this.body.querySelector('.hv-hit'); if (first) first.click(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); this.body.querySelector('.hv-hit')?.focus(); }
    });
    this.body.addEventListener('keydown', (e) => {
      const hit = e.target.closest?.('.hv-hit');
      if (!hit) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); (hit.nextElementSibling || hit).focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); (hit.previousElementSibling?.classList.contains('hv-hit') ? hit.previousElementSibling : this.input).focus(); }
    });
    this.body.addEventListener('click', (e) => {
      const a = e.target.closest?.('a[data-help]');
      if (a) { e.preventDefault(); this.show(a.dataset.help); }
    });
    this.updateNav();
  }
  async manual() { return loadManual(); }
  // Where it is: { id } a section shown, { q } a search; for a window opened at the same place
  get place() { return this.current ? { id: this.current, q: this.query } : { q: this.query }; }
  // A section by its id, or the best section for some words (a feature's name, say). false: nothing found.
  async go(x, { q = null } = {}) {
    const m = await this.manual();
    if (x && m.sections.some((s) => s.id === x)) { if (q != null) this.query = q; this.show(x); return true; }
    if (!x) { this.search(q ?? ''); return true; }
    const hits = searchManual(m, x, 5);
    if (!hits.length) { this.search(x); return false; }
    this.query = x;
    this.show(hits[0].s.id);
    return true;
  }
  async search(q, typed = false) {
    const m = await this.manual();
    this.query = q;
    if (!typed) this.input.value = q;
    this.current = null;
    const ws = words(q), hits = searchManual(m, q);
    this.body.innerHTML = '';
    this.body.scrollTop = 0;
    if (!ws.length) {
      // (nothing typed: the chapters)
      const list = h('div', { class: 'hv-toc' }, `<div class="hv-note">RazorCAD ${m.version} user manual. Type what you are looking for, or open a chapter.</div>`);
      const seen = new Set();
      for (const s of m.sections) if (!seen.has(s.chapter)) { seen.add(s.chapter); list.appendChild(h('a', { href: '#' + s.id, 'data-help': s.id, class: 'hv-ch' }, s.chapter.replace(/[&<]/g, ''))); }
      this.body.appendChild(list);
      this.onShow?.(null, q);
      return;
    }
    if (!hits.length) { this.body.appendChild(h('div', { class: 'hv-note' }, 'Nothing in the manual has all of those words. Try fewer words, or other ones.')); this.onShow?.(null, q); return; }
    this.body.appendChild(h('div', { class: 'hv-note' }, `${hits.length === 40 ? 'The first 40' : hits.length} section${hits.length === 1 ? '' : 's'} found`));
    for (const { s } of hits) {
      const where = [s.chapter, s.parent].filter(Boolean).join(' › ').replace(/[&<]/g, '');
      const row = h('a', { href: '#' + s.id, 'data-help': s.id, class: 'hv-hit', tabindex: '0' }, `<b>${s.title.replace(/[&<]/g, '')}</b><span class="hv-where">${where}</span><span class="hv-snip">${snippet(s, ws)}</span>`);
      this.body.appendChild(row);
    }
    this.onShow?.(null, q);
  }
  async show(id, { record = true } = {}) {
    const m = await this.manual(), s = m.sections.find((x) => x.id === id);
    if (!s) return false;
    if (record) { this.history = this.history.slice(0, this.at + 1); this.history.push(id); this.at = this.history.length - 1; }
    this.current = id;
    this.body.innerHTML = '';
    const crumbs = [s.chapter, s.parent].filter(Boolean).join(' › ').replace(/[&<]/g, '');
    const art = h('article', { class: 'hv-article' }, `<div class="hv-crumbs">${crumbs}</div>${s.level === 1 ? '' : `<h2>${s.title.replace(/[&<]/g, '')}</h2>`}${s.html}`);
    this.body.appendChild(art);
    // (the sections next to it: of the same chapter)
    const same = m.sections.filter((x) => x.chapter === s.chapter), i = same.indexOf(s);
    const nav = h('div', { class: 'hv-pager' });
    if (same[i - 1]) nav.appendChild(h('a', { href: '#' + same[i - 1].id, 'data-help': same[i - 1].id }, `‹ ${same[i - 1].title.replace(/[&<]/g, '')}`));
    if (same[i + 1]) nav.appendChild(h('a', { href: '#' + same[i + 1].id, 'data-help': same[i + 1].id, class: 'hv-next' }, `${same[i + 1].title.replace(/[&<]/g, '')} ›`));
    this.body.appendChild(nav);
    this.mark(art, words(this.query));
    this.body.scrollTop = 0;
    art.querySelector('mark')?.scrollIntoView?.({ block: 'center' });
    this.updateNav();
    this.onShow?.(id, this.query);
    return true;
  }
  step(d) {
    const to = this.at + d;
    if (to < 0) { if (this.current) this.search(this.query); return; }
    if (to >= this.history.length) return;
    this.at = to;
    this.show(this.history[to], { record: false });
  }
  updateNav() { this.back.disabled = this.at < 0 && !this.current; this.fwd.disabled = this.at >= this.history.length - 1; }
  // The words marked where they are in the section's text
  mark(root, ws) {
    if (!ws.length) return;
    const re = new RegExp(`(${ws.map(escRe).join('|')})`, 'gi'), walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [];
    while (walker.nextNode()) if (re.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const span = document.createElement('span');
      span.innerHTML = n.nodeValue.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]).replace(re, '<mark>$1</mark>');
      n.replaceWith(...span.childNodes);
    }
  }
  focus() { this.input.focus(); this.input.select(); }
}

// The manual docked at the right of RazorCAD's window: its left edge dragged to make it wider or narrower, ⧉ to put it
// in a window of its own (which can go anywhere, onto another monitor too), ✕ to close it. Closing it leaves the
// parts, assemblies and drawings open as they are.
export class HelpPanel {
  constructor(app) {
    this.app = app;
    this.popped = false; // (shown in a window of its own: help goes there)
    this.el = document.getElementById('helppanel');
    this.split = document.getElementById('help-splitter');
    this.view = new HelpView(this.el, {
      tools: [
        { label: '⧉', title: 'Open in a window of its own (move it anywhere, onto another monitor too)', onclick: () => this.popOut(), attrs: { 'data-help-pop': '' } },
        { label: '✕', title: 'Close the manual (your files stay open)', onclick: () => this.close(), attrs: { 'data-help-close': '' } },
      ],
    });
    let w = 420;
    try { w = +localStorage.getItem('razorcad.helpWidth') || 420; } catch { /* no storage */ }
    this.setWidth(w);
    this.split.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.split.setPointerCapture(e.pointerId);
      const x0 = e.clientX, w0 = this.width; // (from where it was taken hold of)
      const move = (ev) => this.setWidth(w0 + x0 - ev.clientX);
      const up = () => {
        this.split.removeEventListener('pointermove', move); this.split.removeEventListener('pointerup', up);
        try { localStorage.setItem('razorcad.helpWidth', String(this.width)); } catch { /* no storage */ }
      };
      this.split.addEventListener('pointermove', move);
      this.split.addEventListener('pointerup', up);
    });
    // (the pop-out window, in a browser: asked to dock again, or gone)
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || e.data?.razorcadHelp !== 'dock') return;
      this.dock(e.data.place);
    });
  }
  get isOpen() { return !this.el.hidden; }
  setWidth(w) {
    const ws = document.getElementById('workspace'), max = Math.max(320, (ws?.clientWidth || window.innerWidth) - 420);
    this.width = Math.round(Math.max(280, Math.min(max, w)));
    document.documentElement.style.setProperty('--help-width', this.width + 'px');
  }
  // Open at a section (its id) or the best section for some words; nothing: the search box. In its own window when
  // it was put in one.
  async open(x = null, { q = null } = {}) {
    if (this.popped && await this.toWindow(x || q ? { id: x, q } : null, false)) return;
    this.popped = false;
    this.el.hidden = false; this.split.hidden = false;
    document.getElementById('workspace').classList.add('help-open');
    if (x) await this.view.go(x, { q });
    else if (!this.view.current && !this.view.body.childElementCount) await this.view.search(q || '');
    else if (q != null) await this.view.search(q);
    if (!x) this.view.focus();
  }
  // Help on something by its name (a feature's panel, a command): the section about it
  forTopic(name) { return this.open(String(name || '').replace(/[…]/g, '').trim()); }
  close() {
    this.el.hidden = true; this.split.hidden = true;
    document.getElementById('workspace').classList.remove('help-open');
  }
  // Put it in a window of its own, at the place shown
  async popOut() {
    const place = this.view.place;
    if (!(await this.toWindow(place, true))) { this.app.toast?.('The manual could not be opened in a window of its own', true); return; }
    this.popped = true;
    this.close();
  }
  // Show `place` ({ id, q }) in the manual's own window; create: opened if it is not open. false: it is not (closed
  // by its ✕: help is docked again), or could not be opened.
  async toWindow(place, create) {
    const url = new URL('help.html', location.href);
    if (place?.id) url.hash = place.id;
    if (place?.q) url.searchParams.set('q', place.q);
    url.searchParams.set('theme', document.documentElement.dataset.theme || 'light');
    try { const { platform } = await import('./platform.js'); return !!(await platform.helpWindow(url.href, place || {}, create)); } catch { return false; }
  }
  // Back in the panel (the window's ⇤ button)
  dock(place) {
    this.popped = false;
    this.open(place?.id || null, { q: place?.q ?? null });
  }
  // (the desktop window was closed by its ✕: help comes back here next time)
  windowClosed() { this.popped = false; }
}
