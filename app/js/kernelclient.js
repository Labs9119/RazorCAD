import { platform } from './platform.js';
import { packText, unpackText } from './modelcache.js';
// More geometry kernels at once, for work that doesn't touch the part being edited: an assembly's parts (built
// side by side), drawing views, picks and cut lists. Each is a worker of its own, started when first needed, up to
// `size` (set from what the PC has: machine.js; until that is known, a quarter of its threads, at most 4). A job
// with an affinity (a model) goes to the worker that had it before, so that worker's cached build of it is used
// again. Workers idle for IDLE_MS are stopped (their memory given back), one kept.
const IDLE_MS = 180000;
export class KernelPool {
  constructor(main, size = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 4)))) {
    this.main = main;
    this.size = size;
    this.workers = []; // { client, jobs, used }
    this.affinity = new Map(); // affinity key → worker
    this._reap = setInterval(() => this.reap(), 30000);
  }
  // (workers idle a while stopped, the most recently used one kept)
  reap(now = performance.now()) {
    const idle = this.workers.filter((w) => !w.jobs && now - (w.used || 0) > IDLE_MS).sort((a, b) => (a.used || 0) - (b.used || 0));
    if (idle.length === this.workers.length) idle.pop();
    for (const w of idle) this.drop(w);
    return idle.length;
  }
  drop(w) {
    if (!this.workers.includes(w)) return;
    this.workers.splice(this.workers.indexOf(w), 1);
    for (const [k, x] of this.affinity) if (x === w) this.affinity.delete(k);
    w.client.dispose();
  }
  pick(aff) {
    const w = aff && this.affinity.get(aff);
    if (w && this.workers.includes(w)) return w;
    let best = this.workers.find((x) => !x.jobs);
    if (!best && this.workers.length < this.size) {
      best = { client: new KernelClient({ fonts: this.main.fonts }), jobs: 0 };
      best.client.ready.then(() => { for (const [k, d] of this.main.fonts) best.client.sendFont(k, d); }).catch(() => {});
      this.workers.push(best);
    }
    best ||= this.workers.reduce((a, b) => (b.jobs < a.jobs ? b : a));
    if (aff) { this.affinity.set(aff, best); if (this.affinity.size > 200) this.affinity.delete(this.affinity.keys().next().value); }
    return best;
  }
  async request(type, data = {}, aff = null) {
    const w = this.pick(aff);
    w.jobs++;
    try {
      try {
        await w.client.ready;
      } catch (err) {
        this.drop(w); // (a kernel that couldn't start: the next job starts a fresh one)
        throw err;
      }
      for (const [k, d] of this.main.fonts) await w.client.sendFont(k, d);
      return await w.client.request(type, data);
    } finally { w.jobs--; w.used = performance.now(); }
  }
  // as many jobs at once as there are workers (fn(item) runs each); resolves when all are done
  async each(items, fn) {
    let i = 0;
    const lane = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
    await Promise.all(Array.from({ length: Math.min(this.size, items.length) }, lane));
  }
  stats() { return { size: this.size, started: this.workers.length, busy: this.workers.filter((w) => w.jobs).length }; }
}

// Main-thread client for the geometry worker. Rebuild requests are coalesced:
// while one rebuild runs, only the most recent document is queued.
// If the kernel breaks (it aborted, or its worker died), the worker is replaced by a fresh one
// and the request is repeated once, so one kernel failure doesn't take the whole model down.
const RECYCLE_MB = 3600; // the kernel can address 4 GB
const reading = new Map(); // big imports just read from the store or written to it: key → promise of the text, kept
// a moment (every kernel of the page)
export const forgetImportTexts = () => reading.clear(); // (tests: the next read is from the store itself)
const START_TRIES = 3;   // starts tried before a kernel that keeps failing is given up on

// Big feature data (an imported file's text, a mesh's base64: f.data) goes to each kernel once and is named after
// that, { blob: id }, by a hash of its content: a 342-body STEP's 18 MB were stringified, posted, parsed and
// stringified again by the kernel at every edit. The id is the same in every session (the kernel's stored feature
// states hold it); a kernel without the text asks for it again (kernel.worker.js featureData).
const BLOB_MIN = 1e6;
const blobIds = new Map(); // text → id, the last few (the same text is found again by comparing, not by hashing it)
function blobId(text) {
  let id = blobIds.get(text);
  if (!id) {
    let h1 = 0x811c9dc5, h2 = 0x9747b28c;
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822507) ^ (h2 >>> 15); }
    id = `${text.length.toString(36)}.${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}`;
  }
  blobIds.delete(text); blobIds.set(text, id);
  while (blobIds.size > 8) blobIds.delete(blobIds.keys().next().value);
  return id;
}
// a feature as the kernel is sent it (blobs: id → text, filled with the texts it names)
export function packFeature(f, blobs = null) {
  if (f?.pictures?.length) { const { pictures: _p, ...g } = f; f = g; } // (a sketch's pictures are for tracing over: not geometry)
  if (typeof f?.data !== 'string' || f.data.length < BLOB_MIN) return f;
  const id = blobId(f.data);
  blobs?.set(id, f.data);
  return { ...f, data: { blob: id } };
}
const packFeatures = (doc, blobs) => (doc.features?.some((f) => (typeof f?.data === 'string' && f.data.length >= BLOB_MIN) || f?.pictures?.length) ? { ...doc, features: doc.features.map((f) => packFeature(f, blobs)) } : doc);
// (decals are pictures for the view and renders: not geometry)
const packDoc = (doc, blobs) => { const d = packFeatures(doc, blobs); if (!d.decals) return d; const { decals: _d, ...rest } = d; return rest; };

export class KernelClient {
  // threads: how many threads the kernel may use (more than 1: the multi-threaded kernel, where the page allows it)
  constructor({ fonts = null, threads = 1 } = {}) {
    this.threads = threads;
    this.seq = 0;
    this.calls = new Map();
    this.busy = false;
    this.nextDoc = null;
    this.waiters = [];
    this.lastDoc = null;     // last document rebuilt, to restore a replaced worker's state
    this.fonts = fonts || new Map();  // font key -> bytes, sent again to a replaced worker (a pool's workers share the main one's)
    this.restarts = 0;
    this.spawn();
  }

  // Start a worker: `ready` resolves once it answers (and has the fonts). A worker that fails while starting (e.g.
  // the memory for the kernel not there just then) is replaced and tried again, START_TRIES in all; one that keeps
  // failing (missing files) is given up on rather than restarted in a loop.
  spawn() {
    this.ready = (async () => {
      for (let attempt = 1; ; attempt++) {
        const worker = this.newWorker();
        try {
          const r = await this.call('ping');
          for (const [key, data] of this.fonts) await this.call('loadFont', { key, data: data.slice(0) });
          worker.started = true;
          return r;
        } catch (err) {
          if (attempt >= START_TRIES || this.disposed || worker !== this.worker) throw err;
          try { worker.terminate(); } catch { /* already gone */ }
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
    })();
    this.ready.catch(() => {}); // (a kernel that can't start is reported by onCrash and by the requests that wait on it)
    return this.ready;
  }

  newWorker() {
    const url = new URL('./kernel.worker.js', import.meta.url);
    if (this.threads > 1) url.searchParams.set('threads', String(this.threads));
    // (the browser version: the kernel's files asked for by its signature, so a browser or the website's cache never
    // hands an older kernel to this worker after an update; the files are kept a day: website/_headers)
    if (globalThis.RAZORCAD_WEB?.kernel) url.searchParams.set('k', String(globalThis.RAZORCAD_WEB.kernel));
    // (and published gzipped, one file a kernel: tools/build_web_app.py)
    if (globalThis.RAZORCAD_WEB?.packed) url.searchParams.set('z', '1');
    const worker = new Worker(url, { type: 'module' });
    this.worker = worker;
    worker.onmessage = (e) => {
      if (e.data.type === 'progress') { this.onProgress?.(e.data.value, e.data.label, e.data.feature); return; }
      if (e.data.type === 'ask') { this.answer(worker, e.data); return; }
      const { id, ok, result, error, stack, fatal } = e.data;
      const c = this.calls.get(id);
      if (!c) return;
      this.calls.delete(id);
      if (ok) c.resolve(result);
      else { const err = new Error(error); err.workerStack = stack; err.fatal = !!fatal; c.reject(err); }
    };
    worker.onerror = (e) => {
      if (worker !== this.worker) return;
      e.preventDefault?.(); // reported below as a kernel crash, not again as a page error
      const err = new Error(`${e.message || 'The geometry kernel stopped'}${e.filename ? ` (${e.filename}:${e.lineno})` : ''}`);
      console.error(`Kernel worker error${worker.started ? '' : ' while starting'}: ${err.message}`);
      // (one that never started: spawn() tries again or gives up)
      err.fatal = !!worker.started;
      this.onCrash?.(err);
      this.failAll(worker, err);
      if (worker.started) this.restart(worker); // later requests go to a fresh worker, not one that may be dead
    };
    return worker;
  }

  // A question from the kernel while it works: a big import as stored before ('importGet': { store, brep }), or one
  // to store ('importPut', no answer). Kept with the models built (platform.js: the desktop app's model cache, the
  // browser version's store), which belong to this kernel build.
  // A part's kernel can also ask for help meshing a big import: 'meshHelpers' (how many pool kernels are free, of
  // { want }) and 'meshHelp' (a share of the bodies, meshed by one of them: { meshes }), through `helpers` (set by
  // the app: { free(want), mesh(data) }; none for the pool's own kernels).
  async answer(worker, { id, what, data }) {
    let out = null, transfer = [];
    try {
      if (what === 'meshHelpers') out = this.helpers ? this.helpers.free(data.want) : 0;
      else if (what === 'meshHelp') {
        out = this.helpers ? await this.helpers.mesh(data) : null;
        for (const m of out?.meshes || []) if (m) transfer.push(m.m.vertices.buffer, m.m.normals.buffer, m.m.triangles.buffer);
      } else if (what === 'importGet') {
        const store = !!platform.modelStore;
        // (kernels asking for the same one together, e.g. helping to mesh it: read once; one written just now: its
        // text as written)
        let read = reading.get(data.key);
        if (!read) {
          read = (async () => { const b64 = store ? await platform.readModelCache(data.key) : null; return b64 ? unpackText(b64) : null; })();
          reading.set(data.key, read);
          read.then((t) => setTimeout(() => reading.delete(data.key), t ? 20000 : 0), () => reading.delete(data.key));
        }
        out = { store, brep: await read };
      } else if (what === 'importPut' && platform.modelStore) {
        reading.set(data.key, Promise.resolve(data.brep));
        setTimeout(() => reading.delete(data.key), 20000);
        await platform.writeModelCache(data.key, await packText(data.brep));
        if (this.onStored) this.onStored(data.key);
      }
    } catch { out = null; }
    if (id) { try { worker.postMessage({ type: 'answer', id, data: out }, transfer); } catch { /* the worker is gone */ } }
  }

  // reject every request sent to `worker` (it is dead)
  failAll(worker, err) {
    for (const [id, c] of this.calls) {
      if (c.worker !== worker) continue;
      this.calls.delete(id);
      const e = new Error(err.message); e.workerStack = err.workerStack; e.fatal = err.fatal !== false; e.followOn = !!err.followOn; e.cancelled = !!err.cancelled;
      c.reject(e);
    }
  }

  // Stop what the kernel is doing (e.g. a cut that would take minutes): the worker is replaced by a fresh one
  // and the requests it had fail as cancelled (not as a crash).
  async cancel() {
    const w = this.worker;
    if (this._restarting) return this._restarting;
    this._restarting = (async () => {
      const stopped = Object.assign(new Error('Stopped'), { fatal: false, cancelled: true });
      // (a queued rebuild may still hold the slow feature: the caller rebuilds once it has dealt with it)
      const queued = this.waiters;
      this.nextDoc = null;
      this.waiters = [];
      queued.forEach((q) => q.reject(stopped));
      try { w.terminate(); } catch { /* already gone */ }
      this.failAll(w, stopped);
      try { await this.spawn(); } finally { this._restarting = null; }
    })();
    return this._restarting;
  }

  // Replace a broken worker (once per broken worker, however many requests noticed it).
  restart(broken) {
    if (this.worker === broken && !this._restarting) {
      this._restarting = (async () => {
        this.restarts++;
        try { broken.terminate(); } catch { /* already gone */ }
        // (requests that were waiting on the broken worker: not failures of their own)
        this.failAll(broken, Object.assign(new Error('The geometry kernel was restarted'), { followOn: true }));
        try { await this.spawn(); } finally { this._restarting = null; }
      })();
    }
    return this._restarting || this.ready;
  }

  call(type, data = {}) {
    const id = ++this.seq;
    const worker = this.worker;
    // (the big texts a document names: each sent to a worker once; all again after it said one was missing)
    if (data.blobs instanceof Map) {
      const sent = (worker.blobs ??= new Set());
      data = { ...data, blobs: [...data.blobs].filter(([k]) => !sent.has(k)) };
      for (const [k] of data.blobs) sent.add(k);
    }
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject, worker });
      worker.postMessage({ id, type, data });
    });
  }

  // A request that survives a kernel failure: on a fatal error the worker is replaced, its
  // state rebuilt from the last document if needed, and the request sent again once.
  async request(type, data = {}) {
    await this._restarting;
    // (other requests act on the model as built: they wait for a rebuild being made or queued — the
    // worker would otherwise run them in its pauses, on a half-built model)
    if (type !== 'rebuild' && type !== 'stats' && type !== 'cancel') while (this.pending || this.expecting) await new Promise((r) => setTimeout(r, 25));
    await this.ready; // (a kernel still starting: requests go to it once it answers)
    const worker = this.worker;
    try {
      try {
        return await this.call(type, data);
      } catch (err) {
        if (!/^Missing feature data/.test(err.message) || !worker.blobs) throw err;
        worker.blobs.clear();
        return await this.call(type, data);
      }
    } catch (err) {
      if (!err.fatal) throw err;
      if (!err.followOn) this.onRestart?.(err); // one report per crash, not one per waiting request
      await this.restart(worker);
      if (type !== 'rebuild' && this.lastDoc) await this.call('rebuild', { doc: this.lastDoc, previewId: null, blobs: this.lastBlobs });
      try {
        return await this.call(type, data);
      } catch (err2) {
        err2.firstError = err;
        throw err2;
      }
    }
  }

  // previewId: feature shown as a preview (model rolled back to just before it)
  // haveMesh: key of the mesh the view shows (the kernel then doesn't resend an unchanged mesh)
  rebuild(doc, previewId = null, haveMesh = null) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.nextBlobs = new Map();
      this.nextDoc = JSON.stringify(packDoc(doc, this.nextBlobs));
      this.nextPreview = previewId;
      this.nextHave = haveMesh;
      this.pump();
    });
  }

  pump() {
    if (this.busy || this.nextDoc === null) return;
    const doc = this.nextDoc;
    const previewId = this.nextPreview;
    const haveMesh = this.nextHave;
    const blobs = this.nextBlobs;
    const waiters = this.waiters;
    this.nextDoc = null;
    this.waiters = [];
    this.busy = true;
    this.runningDoc = doc; // (what is being built, so the app can tell when it has gone stale)
    this.runningSince = performance.now();
    // clear `busy` (and start any queued rebuild) before waiters resume, so they can
    // tell whether their result is already superseded
    this.request('rebuild', { doc, previewId, haveMesh, blobs }).then(
      (r) => {
        this.lastDoc = doc; this.lastBlobs = blobs; this.busy = false; this.pump(); waiters.forEach((w) => w.resolve(r));
        if (r?.kernelMemoryMB > RECYCLE_MB) this.recycle();
      },
      (err) => { this.busy = false; this.pump(); waiters.forEach((w) => w.reject(err)); },
    );
  }

  // The kernel's memory only grows (up to 4 GB, where it would fail). Past RECYCLE_MB the worker is
  // replaced by a fresh one once it's idle, and the last model rebuilt in it.
  async recycle() {
    if (this._recycling) return;
    this._recycling = true;
    try {
      while (this.busy || this.calls.size) await new Promise((r) => setTimeout(r, 250));
      const doc = this.lastDoc;
      await this.restart(this.worker);
      if (doc && !this.busy) await this.call('rebuild', { doc, previewId: null, blobs: this.lastBlobs }).catch(() => {});
    } finally {
      this._recycling = false;
    }
  }

  get pending() { return this.busy || this.nextDoc !== null; }
  // (a rebuild about to be asked for: the app marks it while it gets ready, so requests wait for it too)
  expect(on) { this.expecting = Math.max(0, (this.expecting || 0) + (on ? 1 : -1)); }

  // bodyId: export only that body; info: { [bodyId]: { name, color } }
  exportBody(format, bodyId = null, info = {}, opts = {}) {
    return this.request('export', { format, bodyId, info, opts });
  }

  featureFaces(id) {
    return this.request('featureFaces', { id });
  }

  async loadFont(key, data) {
    this.fonts.set(key, data);
    await this.ready;
    return this.call('loadFont', { key, data: data.slice(0) });
  }

  textOutlines(texts) {
    return this.request('textOutlines', { texts });
  }

  measure(refs) {
    return this.request('measure', { refs });
  }

  // curves where a sketch's plane cuts the bodies (before that sketch), in sketch coordinates
  sectionCurves(sketchId) {
    return this.request('sectionCurves', { sketchId });
  }

  exportFaceDXF(ref) {
    return this.request('exportFaceDXF', { ref });
  }

  // The worker stopped for good (its memory given back); requests still waiting fail.
  dispose() {
    this.disposed = true;
    const err = new Error('The geometry kernel was stopped'); err.fatal = false; err.cancelled = true;
    try { this.failAll(this.worker, err); } catch { /* nothing waiting */ }
    this.worker.terminate();
  }

  // (a font sent to this worker only if it doesn't have it yet: pool workers share the font list)
  async sendFont(key, data) {
    this._sent ||= new Set();
    if (this._sent.has(key)) return;
    this._sent.add(key);
    await this.ready;
    return this.call('loadFont', { key, data: data.slice(0) });
  }

  // kernel memory / stack state for crash reports (never restarts anything)
  stats() {
    return Promise.race([this.call('stats'), new Promise((r) => setTimeout(() => r(null), 1000))]).catch(() => null);
  }
}
