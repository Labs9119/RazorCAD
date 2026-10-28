// Platform layer: native desktop services (via the pywebview Python bridge when
// running as RazorCAD.exe) with browser fallbacks for development.
const AUTOSAVE_KEY = 'razorcad.autosave.v2';
const wantsDesktop = new URLSearchParams(location.search).has('desktop') || navigator.userAgent.includes('RazorCAD-Desktop');

const ready = new Promise((resolve) => {
  if (window.pywebview?.api?.get_start_info) return resolve(true);
  if (!wantsDesktop) return resolve(false);
  window.addEventListener('pywebviewready', () => resolve(true), { once: true });
  setTimeout(() => resolve(!!window.pywebview?.api), 8000);
});

let desktop = false;
ready.then((d) => (desktop = d));

const api = () => window.pywebview.api;
// (the browser: the PC's fonts only where a development server offers them at _fonts/; the website doesn't, and
// after the first miss they are not asked for again)
let noLocalFonts = false;
const localFonts = () => !noLocalFonts && !window.RAZORCAD_WEB;

// The browser version's store of models as last built (the desktop app keeps them on disk): in the browser's
// own database, under the website's kernel signature (written in by tools/build_web_app.py; without one, as in
// development, nothing is kept), the least recently used let go past WEB_STORE_MB. Each model's size and last use
// are also kept apart ('meta'), so letting the old ones go reads only those, not every model (an assembly writes
// many at once).
const WEB_STORE_MB = 400;
const webKernel = () => window.RAZORCAD_WEB?.kernel || null;
let webDb = null;
function webStore() {
  if (!webKernel() || typeof indexedDB === 'undefined') return Promise.resolve(null);
  return (webDb ||= new Promise((resolve) => {
    const rq = indexedDB.open('razorcad-models', 2);
    rq.onupgradeneeded = (ev) => {
      const db = rq.result;
      // (version 1 had no sizes apart: its models are let go, as a store of models built before is only a cache)
      if (ev.oldVersion >= 1 && db.objectStoreNames.contains('m')) db.deleteObjectStore('m');
      db.createObjectStore('m', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => resolve(null);
  }));
}
const idb = (rq) => new Promise((resolve, reject) => { rq.onsuccess = () => resolve(rq.result); rq.onerror = () => reject(rq.error); });
async function webRead(key) {
  const db = await webStore();
  if (!db) return null;
  const e = await idb(db.transaction('m', 'readonly').objectStore('m').get(key));
  if (!e || e.kernel !== webKernel()) return null;
  db.transaction('meta', 'readwrite').objectStore('meta').put({ key, kernel: e.kernel, size: e.size, used: Date.now() });
  return e.data;
}
let webWrites = Promise.resolve();
function webWrite(key, data) {
  // (one after another, so two writes don't both let the same old models go)
  const run = webWrites.then(async () => {
    const db = await webStore();
    if (!db) return null;
    const tx = db.transaction(['m', 'meta'], 'readwrite'), used = Date.now();
    tx.objectStore('m').put({ key, kernel: webKernel(), data, size: data.length, used });
    tx.objectStore('meta').put({ key, kernel: webKernel(), size: data.length, used });
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    // (another kernel's models, and the oldest past the limit, let go)
    const all = (await idb(db.transaction('meta', 'readonly').objectStore('meta').getAll())).sort((a, b) => b.used - a.used);
    let total = 0;
    const del = db.transaction(['m', 'meta'], 'readwrite');
    for (const e of all) {
      total += e.size;
      if (e.kernel !== webKernel() || total > WEB_STORE_MB * 1048576) { del.objectStore('m').delete(e.key); del.objectStore('meta').delete(e.key); }
    }
    return true;
  });
  webWrites = run.catch(() => null);
  return run;
}

function b64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

function browserDownload(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const platform = {
  ready,
  get desktop() { return desktop; },

  // Start window: { recent: [{ path, name, folder, exists, modified, autosave }], legacy: { modified } | null }
  async getStartInfo() {
    if (desktop) return api().get_start_info();
    let legacy = null;
    try { if (localStorage.getItem(AUTOSAVE_KEY)) legacy = { modified: null }; } catch { /* no storage */ }
    return { recent: [], legacy };
  },

  async removeRecent(path) {
    if (desktop) return api().remove_recent(path);
  },

  // The single session auto-save of earlier versions (offered once in the start window).
  async loadLegacySession() {
    if (desktop) return (await api().load_legacy_session()) || null;
    try { return localStorage.getItem(AUTOSAVE_KEY); } catch { return null; }
  },

  async retireLegacySession() {
    if (desktop) return api().retire_legacy_session();
    try { localStorage.setItem(AUTOSAVE_KEY + '.recovered', localStorage.getItem(AUTOSAVE_KEY) || ''); localStorage.removeItem(AUTOSAVE_KEY); } catch { /* ignore */ }
  },

  // Auto-save next to the saved part (desktop only: the browser version has no folders).
  async saveAutosave(text, path) {
    if (desktop && path) return api().save_autosave(text, path);
    return null;
  },

  async discardAutosave(path) {
    if (desktop && path) return api().discard_autosave(path);
  },

  // Returns the saved path (desktop) or the file name (browser); null if cancelled.
  async saveText(name, text, path = null, oldPath = null, kind = 'part') {
    if (desktop) return api().save_file(name, text, path || '', oldPath || '', kind);
    browserDownload(text, name, 'application/json');
    return name;
  },

  // An assembly's part or sub-assembly saved as a file of its own, beside the assembly just saved (desktop only):
  // its path, or null. besideExists: which of these file names are there already.
  async saveBeside(mainPath, name, text) { return desktop && mainPath ? api().save_beside(mainPath, name, text) : null; },
  async besideExists(mainPath, names) { return desktop && mainPath ? (await api().beside_exists(mainPath, names)) || [] : []; },

  // The text of a part file by path (a drawing reading its parts), or null.
  async readText(path) {
    if (desktop) return api().read_text(path);
    return null;
  },

  // Drawing templates (desktop: Documents\RazorCAD\Templates). { folder, templates: [{ path, name, description, sheets, thumb }] }
  async listTemplates(extra = []) { return desktop ? api().list_templates(extra) : { folder: null, templates: [] }; },
  async readTemplate(path) { return desktop && path ? api().read_template(path) : null; },
  async pickTemplate() {
    if (desktop) return api().pick_template();
    const f = await this.openText().catch(() => null);
    return f && !f.format ? { path: null, content: f.content } : null;
  },
  async openTemplatesFolder() { return desktop ? api().open_templates_folder() : false; },

  // The model as last built (modelcache.js), by key: base64 text or null. On disk in the desktop app; in the
  // browser's database in the browser version (when the website build gave it a kernel signature).
  get modelStore() { return desktop || !!webKernel(); },
  // The PC's processor threads and memory (machine.js): { threads, totalMB, freeMB } in the desktop app, else null.
  async systemInfo() { return desktop ? api().system_info() : null; },
  async readModelCache(key) { if (!key) return null; if (desktop) return api().read_model_cache(key); try { return await webRead(key); } catch { return null; } },
  async writeModelCache(key, b64) { if (!key) return null; if (desktop) return api().write_model_cache(key, b64); try { return await webWrite(key, b64); } catch { return null; } },

  // Files to open that Windows started RazorCAD with (double-click / Open with); [] in the browser.
  async takeOpenRequests() {
    if (desktop) return (await api().take_open_requests()) || [];
    return [];
  },
  async fileTypesInfo() { return desktop ? api().file_types_info() : null; },
  async registerFileTypes() { return api().register_file_types(); },

  // Open a part by path (recent files). Returns { name, content, path, autosave? }.
  async openPath(path) {
    if (desktop) return api().open_path(path);
    throw new Error('Opening by path needs the desktop app');
  },

  // ---- user preferences (toolbar layout, ...): kept by the desktop app (by the browser for development)
  async getPrefs() {
    if (desktop) return (await api().get_prefs()) || {};
    try { return JSON.parse(localStorage.getItem('razorcad.prefs') || '{}'); } catch { return {}; }
  },
  async setPrefs(prefs) {
    const text = JSON.stringify(prefs);
    if (desktop) return api().set_prefs(text);
    try { localStorage.setItem('razorcad.prefs', text); } catch { /* no storage */ }
    return true;
  },

  // ---- Claude: the API key is kept by the desktop app (by the browser for development)
  async claudeStatus() {
    if (desktop) return api().claude_status();
    let s = {};
    try { s = JSON.parse(localStorage.getItem('razorcad.claude') || '{}'); } catch { /* no storage */ }
    return { hasKey: !!s.key, model: s.model || '', backend: 'api', cli: '', ready: !!s.key };
  },
  // backend: 'api' (API key) | 'cli' (Claude Code on the user's Claude subscription: desktop app only)
  async claudeSet({ key = null, model = null, clear = false, backend = null }) {
    if (desktop) return api().claude_set(key, model, clear, backend);
    let s = {};
    try { s = JSON.parse(localStorage.getItem('razorcad.claude') || '{}'); } catch { /* no storage */ }
    if (clear) delete s.key; else if (key) s.key = key.trim();
    if (model) s.model = model;
    try { localStorage.setItem('razorcad.claude', JSON.stringify(s)); } catch { /* no storage */ }
    return { hasKey: !!s.key, model: s.model || '', backend: 'api', cli: '', ready: !!s.key };
  },
  // Updates (desktop): this version, a check for a newer GitHub release (null when not due: at most once a day
  // when automatic, never when turned off), and the settings { auto, skip }
  async updateSettings(changes = null) { return desktop ? api().update_settings(changes) : null; },
  async checkUpdate(force = false) { return desktop ? api().check_update(force) : null; },
  // Update now (desktop, installed with the setup): { ok } once the setup is downloaded and started, else { error }
  async startUpdate(setup) { return desktop ? api().start_update(setup.url, setup.size, setup.digest) : { error: 'The browser version updates by itself' }; },
  // a RazorCAD page (on GitHub) in the web browser
  // crash reports as GitHub issues (desktop): the reports kept, and one (or none: a plain problem report) as
  // { title, body, url } with personal details taken out
  async crashReports() { return desktop ? api().crash_reports() : []; },
  async crashIssue(name = '') {
    if (desktop) return api().crash_issue(name);
    const body = `**What happened** (and what you expected):\n\n\n\n**Steps to repeat it**\n\n1. \n\n**Report**\n\n- RazorCAD in the browser${window.RAZORCAD_WEB?.version ? ' ' + window.RAZORCAD_WEB.version : ''}\n- Browser: ${navigator.userAgent}\n`;
    return { title: 'Problem: ', body, url: 'https://github.com/Labs9119/RazorCAD/issues/new' };
  },

  async openUrl(url) {
    if (desktop) return api().open_url(url);
    window.open(url, '_blank', 'noopener');
    return true;
  },
  // Claude Code CLI: where it is, its version and whether it is signed in ({ cli, version, loggedIn, authMethod })
  async claudeCliCheck() {
    return desktop ? api().claude_cli_check() : { cli: '', version: '', loggedIn: false, authMethod: '' };
  },
  // Opens a console running `claude auth login` (sign in to the Claude subscription in the browser)
  async claudeCliLogin() {
    return desktop ? api().claude_cli_login() : false;
  },
  // One Messages API call. Returns the response object; throws with the API's message on errors.
  async claudeMessages(body) {
    let res;
    if (desktop) res = JSON.parse(await api().claude_messages(JSON.stringify(body)));
    else {
      let s = {};
      try { s = JSON.parse(localStorage.getItem('razorcad.claude') || '{}'); } catch { /* no storage */ }
      if (!s.key) throw new Error('No Anthropic API key is set (Ask Claude ▸ settings).');
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': s.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify(body),
      });
      res = await r.json();
    }
    if (res?.error) throw new Error(res.error.message || 'Claude request failed');
    return res;
  },

  // Choose a folder (bulk exports). Returns its path, or null if cancelled. In the browser files are
  // downloaded instead, so any non-null value goes.
  async pickFolder() {
    if (desktop) return (await api().pick_folder()) || null;
    return 'Downloads';
  },

  // Write a file into the folder chosen with pickFolder (no dialog). Returns the path, or null.
  async saveInto(folder, name, bytes) {
    if (desktop) return api().save_into(folder, name, b64(bytes));
    browserDownload(bytes, name, 'application/dxf');
    return name;
  },

  async saveBinary(name, bytes, kind) {
    if (desktop) return api().save_binary(name, b64(bytes), kind);
    browserDownload(bytes, name, 'application/octet-stream');
    return name;
  },

  // Returns {name, content, path} for a part, {name, format, data} for a STEP/STL file, or null.
  // A DXF file's text (for importing into a sketch): { name, text } or null.
  async openDXF() {
    if (desktop) return api().open_dxf();
    return new Promise((resolve) => {
      const input = document.getElementById('file-input');
      input.value = '';
      input.accept = '.dxf';
      input.onchange = async () => {
        const f = input.files[0];
        input.accept = '.rcad,.rasm,.rdrw';
        resolve(f ? { name: f.name, text: await f.text() } : null);
      };
      input.click();
    });
  },

  // A picture: { name, url (a data URL) } or null.
  async openImage() {
    if (desktop) { const r = await api().open_image(); return r ? { name: r.name, url: `data:${r.mime};base64,${r.data}` } : null; }
    return new Promise((resolve) => {
      const input = document.getElementById('file-input');
      input.value = '';
      input.accept = 'image/png,image/jpeg,image/bmp,image/gif,image/webp';
      input.onchange = () => {
        const f = input.files[0];
        input.accept = '.rcad,.rasm,.rdrw';
        if (!f) return resolve(null);
        const rd = new FileReader();
        rd.onload = () => resolve({ name: f.name, url: rd.result });
        rd.onerror = () => resolve(null);
        rd.readAsDataURL(f);
      };
      input.click();
    });
  },

  // A macro file (.js): { name, content } or null.
  async openMacro() {
    if (desktop) return api().open_macro();
    return new Promise((resolve) => {
      const input = document.getElementById('file-input');
      input.value = '';
      input.accept = '.js';
      input.onchange = async () => {
        const f = input.files[0];
        input.accept = '.rcad,.rasm,.rdrw';
        resolve(f ? { name: f.name, content: await f.text() } : null);
      };
      input.click();
    });
  },

  async openText() {
    if (desktop) return api().open_file();
    return new Promise((resolve) => {
      const input = document.getElementById('file-input');
      input.value = '';
      input.accept = '.rcad,.rasm,.rdrw,.step,.stp,.stl,.igs,.iges';
      input.onchange = async () => {
        const f = input.files[0];
        input.accept = '.rcad,.rasm,.rdrw';
        if (!f) return resolve(null);
        if (/\.(step|stp|stl|igs|iges)$/i.test(f.name)) {
          const isStl = /\.stl$/i.test(f.name), isIges = /\.(igs|iges)$/i.test(f.name);
          return resolve({ name: f.name, format: isStl ? 'stl' : isIges ? 'iges' : 'step', data: isStl ? b64(new Uint8Array(await f.arrayBuffer())) : await f.text() });
        }
        resolve({ name: f.name, content: await f.text(), path: null });
      };
      input.click();
    });
  },

  // STEP / STL import. Returns {name, format, data} (STEP as text, STL as base64) or null.
  async openImport() {
    if (desktop) return api().open_import();
    return new Promise((resolve) => {
      const input = document.getElementById('file-input');
      input.value = '';
      input.accept = '.step,.stp,.igs,.iges,.stl,.obj,.3mf';
      input.onchange = async () => {
        const f = input.files[0];
        input.accept = '.rcad,.rasm,.rdrw';
        if (!f) return resolve(null);
        const ext = (/\.(stl|obj|3mf)$/i.exec(f.name) || [])[1]?.toLowerCase();
        const data = ext ? b64(new Uint8Array(await f.arrayBuffer())) : await f.text();
        resolve({ name: f.name, format: ext || (/\.(igs|iges)$/i.test(f.name) ? 'iges' : 'step'), data });
      };
      input.click();
    });
  },

  // ---- crash reports (written by the desktop shell to %APPDATA%\RazorCAD\crashes)
  async logEvent(text) {
    if (desktop) return api().log_event(String(text));
  },

  async rememberPart(text) {
    if (desktop) return api().remember_part(text);
  },

  async reportError(report) {
    if (desktop) return api().report_error(report);
    console.error('RazorCAD crash report', report);
    try {
      const list = JSON.parse(localStorage.getItem('razorcad.crashes') || '[]');
      list.push({ ...report, part: undefined });
      localStorage.setItem('razorcad.crashes', JSON.stringify(list.slice(-5)));
    } catch { /* ignore */ }
    return 'the browser console';
  },

  async getCrashInfo() {
    if (desktop) return api().get_crash_info();
    return { folder: null, recent: [] };
  },

  async markCrashesSeen() {
    if (desktop) return api().mark_crashes_seen();
  },

  async openCrashFolder(name = '') {
    if (desktop) return api().open_crash_folder(name);
    return false;
  },

  // Sketch text fonts: which of these files the PC has, and a file's bytes (ArrayBuffer) or null.
  // (In the browser, fonts placed in app/_fonts are used, for development.)
  async fontsAvailable(files) {
    if (desktop) return api().fonts_available(files);
    const out = [];
    for (const f of files) { if (!localFonts()) break; try { const r = await fetch('_fonts/' + f, { method: 'HEAD' }); if (r.ok) out.push(f); else if (r.status === 404 && !out.length) noLocalFonts = true; } catch { /* not there */ } }
    return out;
  },

  async fontData(file) {
    // (the fonts that come with RazorCAD are in the app itself)
    if (/^DejaVu[\w-]*\.ttf$/.test(String(file || ''))) {
      try { const r = await fetch('fonts/' + file); return r.ok ? await r.arrayBuffer() : null; } catch { return null; }
    }
    if (desktop) {
      const b64s = await api().read_font(file);
      if (!b64s) return null;
      const bin = atob(b64s), out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out.buffer;
    }
    if (!localFonts()) return null;
    try { const r = await fetch('_fonts/' + file); if (r.status === 404) noLocalFonts = true; return r.ok ? await r.arrayBuffer() : null; } catch { return null; }
  },

  setTitle(t) {
    document.title = t;
    if (desktop) api().set_title(t).catch(() => {});
  },

  setDirty(d, hasFile = false) {
    if (desktop) api().set_dirty(!!d, !!hasFile).catch(() => {});
  },

  // closing the window with unsaved parts: the interface asks, then closes (or not)
  closeAck() { if (desktop) api().close_ack().catch(() => {}); },
  closeCancel() { if (desktop) api().close_cancel().catch(() => {}); },
  closeApp() { if (desktop) api().close_app().catch(() => {}); else window.close(); },
};
