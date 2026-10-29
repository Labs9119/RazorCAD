"""RazorCAD regression tests: rebuilds the test parts with the real geometry kernel and runs a few UI
checks, in headless Microsoft Edge, then compares the results with tests/expected.json.

    python tests/run_tests.py                 run everything, compare, exit code 1 on any failure
    python tests/run_tests.py --update        run and store the results as the new expected ones
    python tests/run_tests.py --make-parts    rebuild tests/parts/*.rcad from tests/make_parts.js first
    python tests/run_tests.py --only NAME ... run just these parts / UI tests
    python tests/run_tests.py --perf          also list every test's time against its usual time
    python tests/run_tests.py --perf-strict   exit code 1 when something got slower too
    python tests/run_tests.py --jobs N        split the run over N pages at once (default: by the PC's threads, at
                                              most 4; --jobs 1 runs everything in one page, one after another)
    python tests/run_tests.py --shard I/N     run only share I of N (CI: N machines side by side): the UI tests
                                              shared out by tests/test-weights.json; share 1 also runs the parts,
                                              drawings and desktop tests
    python tests/run_tests.py --weights LOG   write tests/test-weights.json from a run's output (a CI log)

Every run's times (part rebuilds, drawings, UI tests) are kept in tests/perf-history.json, per machine (the last
10 of each; not in git): a test markedly slower than its usual time (the median of those, 1.5x and 300 ms more)
is reported under Performance. Times are kept apart per number of jobs (tests run side by side take longer).

With several jobs, each is a page of its own (its own storage, its own geometry kernels) in one browser: the first
runs the parts and drawings, and the UI tests are shared out by their usual times so the pages finish together.

With --shard, every machine must share the tests out the same way, so the shares come from the times kept in
tests/test-weights.json (in git; the UI tests' times on a CI runner), not from each machine's own history. A test not
in it counts as the median of those that are. Refresh it now and then from a CI run's log (--weights).

Needs Python's playwright package (pip install playwright); it uses the Edge already on the PC.
"""
import argparse
import functools
import http.server
import json
import math
import os
import platform
import statistics
import socketserver
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
APP = os.path.join(ROOT, 'app')
PARTS = os.path.join(HERE, 'parts')
EXPECTED = os.path.join(HERE, 'expected.json')
REL = 1e-6  # relative tolerance for volumes, areas and flat sizes
PERF = os.path.join(HERE, 'perf-history.json')
WEIGHTS = os.path.join(HERE, 'test-weights.json')
PERF_RUNS, PERF_MIN_RUNS = 10, 3   # times kept per test; runs needed before a time is judged
SLOW_RATIO, SLOW_MS = 1.5, 300     # slower than usual: this many times the median, and this much more


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.wasm': 'application/wasm'}

    def translate_path(self, path):
        p = path.split('?', 1)[0].split('#', 1)[0]
        if p.startswith('/tests/'):
            return os.path.join(HERE, *p[len('/tests/'):].split('/'))
        return super().translate_path(path)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        # (cross-origin isolation: the multi-threaded geometry kernel needs it for shared memory)
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def serve():
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer.daemon_threads = True
    # (the connections waiting to be taken: Python's 5 are too few for pages loading side by side, and the browser
    # is refused the rest)
    socketserver.ThreadingTCPServer.request_queue_size = 128
    httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 0), functools.partial(Handler, directory=APP))
    # (a page closed while a file is still being sent: nothing wrong)
    quiet = httpd.handle_error
    httpd.handle_error = lambda request, address: None if isinstance(sys.exc_info()[1], (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)) else quiet(request, address)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def same_num(a, b):
    if a is None or b is None:
        return a is b
    return math.isclose(a, b, rel_tol=REL, abs_tol=1e-6)


def compare(name, got, want):
    """Differences between a part's results and the expected ones (list of strings)."""
    diffs = []
    if 'crash' in got:
        return [f'crashed: {got["crash"]}']
    for cfg, w in want.items():
        g = got.get(cfg)
        if g is None:
            diffs.append(f'{cfg}: not built')
            continue
        if g['errors'] != w['errors']:
            diffs.append(f'{cfg}: errors {g["errors"]} (expected {w["errors"]})')
        if len(g['bodies']) != len(w['bodies']):
            diffs.append(f'{cfg}: {len(g["bodies"])} bodies (expected {len(w["bodies"])})')
            continue
        for i, (gb, wb) in enumerate(zip(g['bodies'], w['bodies'])):
            for k in ('kind', 'faces', 'edges'):
                if gb.get(k) != wb.get(k):
                    diffs.append(f'{cfg} body {i + 1}: {k} {gb.get(k)} (expected {wb.get(k)})')
            for k in ('volume', 'area'):
                if not same_num(gb.get(k), wb.get(k)):
                    diffs.append(f'{cfg} body {i + 1}: {k} {gb.get(k)} (expected {wb.get(k)})')
            if 'flat' in wb or 'flat' in gb:
                gf, wf = gb.get('flat') or {}, wb.get('flat') or {}
                if gf.get('bends') != wf.get('bends') or not all(same_num(x, y) for x, y in zip(gf.get('size', []), wf.get('size', []))):
                    diffs.append(f'{cfg} body {i + 1}: flat pattern {gf} (expected {wf})')
    for cfg in got:
        if cfg not in want:
            diffs.append(f'{cfg}: new configuration (not in expected.json)')
    return diffs


def compare_drawing(got, want):
    """Differences between a part's drawing views and the expected ones (line counts exact, sizes to REL)."""
    if 'crash' in got:
        return [f'crashed: {got["crash"]}']
    diffs = []
    for vid, w in want.items():
        g = got.get(vid)
        if g is None:
            diffs.append(f'{vid}: no view')
        elif g.get('error') or w.get('error'):
            if g.get('error') != w.get('error'):
                diffs.append(f'{vid}: error {g.get("error")} (expected {w.get("error")})')
        else:
            if g['counts'] != w['counts']:
                diffs.append(f'{vid}: lines {g["counts"]} (expected {w["counts"]})')
            gs, ws = g.get('size') or [], w.get('size') or []
            if len(gs) != len(ws) or not all(same_num(x, y) for x, y in zip(gs, ws)):
                diffs.append(f'{vid}: size {gs} (expected {ws})')
    for vid in got:
        if vid not in want:
            diffs.append(f'{vid}: new view (not in expected.json)')
    return diffs


def machine(jobs=1):
    """This PC (times are only compared with its own), and how many jobs ran side by side."""
    return f'{platform.node()}|{platform.processor() or platform.machine()}|{os.cpu_count()}' + (f'|jobs {jobs}' if jobs > 1 else '')


def default_jobs():
    """Pages run at once: one per 6 processor threads, 1 to 4."""
    return max(1, min(4, (os.cpu_count() or 4) // 6))


def usual_times(jobs):
    """Each UI test's usual time on this PC (ms), from tests/perf-history.json: with this many jobs side by side,
    else run alone."""
    try:
        with open(PERF, encoding='utf-8') as f:
            hist = json.load(f)
    except (OSError, ValueError):
        return {}
    out = {}
    for mine in (hist.get(machine(), {}), hist.get(machine(jobs), {})):
        out.update({k[3:]: statistics.median(v) for k, v in mine.items() if k.startswith('ui:') and v})
    return out


def share_out(names, jobs, usual, first_extra):
    """The UI tests split over the jobs, each as long as the others by the usual times (the longest first, each to
    the job with least so far; the first job also has the parts and drawings, first_extra ms). Each job's tests keep
    the suite's order."""
    load = [first_extra] + [0] * (jobs - 1)
    shares = [set() for _ in range(jobs)]
    for n in sorted(names, key=lambda n: -usual.get(n, 1000)):
        j = min(range(jobs), key=lambda j: load[j])
        shares[j].add(n)
        load[j] += usual.get(n, 1000)
    return [[n for n in names if n in sh] for sh in shares]


def shard_weights(names):
    """Each UI test's weight for --shard (ms on a CI runner, tests/test-weights.json): the same on every machine."""
    try:
        with open(WEIGHTS, encoding='utf-8') as f:
            w = json.load(f)
    except (OSError, ValueError):
        w = {}
    known = [w[n] for n in names if isinstance(w.get(n), (int, float))]
    rest = statistics.median(known) if known else 1000
    return {n: w.get(n, rest) for n in names}


def save_weights(log):
    """tests/test-weights.json from a run's output: each UI line's time ("  PASS  name  1234 ms  ...")."""
    import re
    out, ui = {}, False
    with open(log, encoding='utf-8', errors='replace') as f:
        for line in f:
            if re.search(r'\bUI \(\d+\):', line):
                ui = True
            elif re.search(r'\b(Desktop|Performance) \(', line):
                ui = False
            m = ui and re.search(r'\s(?:PASS|FAIL)\s+(\S+)\s+(\d+) ms', line)
            if m:
                out[m.group(1)] = int(m.group(2))
    if not out:
        sys.exit(f'No UI test times found in {log}')
    with open(WEIGHTS, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(dict(sorted(out.items())), f, indent=1)
        f.write('\n')
    print(f'{len(out)} UI test times written to {WEIGHTS} ({sum(out.values()) / 1000:.0f} s in all)')


def timings(results):
    """Every timed test: {key: ms} (parts per configuration, drawings, UI tests)."""
    out = {}
    for name, got in results.get('parts', {}).items():
        for cfg, v in got.items():
            if isinstance(v, dict) and isinstance(v.get('ms'), (int, float)):
                out[f'part:{name}/{cfg}'] = v['ms']
    for name, got in results.get('drawings', {}).items():
        if isinstance(got, dict) and isinstance(got.get('ms'), (int, float)):
            out[f'drawing:{name}'] = got['ms']
    for name, r in results.get('ui', {}).items():
        if isinstance(r.get('ms'), (int, float)):
            out[f'ui:{name}'] = r['ms']
    return out


def perf_report(times, total_s, show_all=False, whole=True, jobs=1):
    """This run's times against the usual ones (printed), and stored. Returns the number markedly slower."""
    hist = {}
    if os.path.exists(PERF):
        try:
            with open(PERF, encoding='utf-8') as f:
                hist = json.load(f)
        except (OSError, ValueError):
            hist = {}
    mine = hist.setdefault(machine(jobs), {})
    rows, slower = [], []
    for key, ms in sorted(times.items()):
        past = mine.get(key, [])
        usual = statistics.median(past) if len(past) >= PERF_MIN_RUNS else None
        rows.append((key, ms, usual))
        if usual is not None and ms > usual * SLOW_RATIO and ms - usual > SLOW_MS:
            slower.append((key, ms, usual))
        mine[key] = (past + [round(ms)])[-PERF_RUNS:]
    # (the whole run's time: only from full runs)
    tot = mine.get('_total_s', [])
    usual_total = statistics.median(tot) if len(tot) >= PERF_MIN_RUNS and whole else None
    if whole:
        mine['_total_s'] = (tot + [round(total_s, 1)])[-PERF_RUNS:]
    try:
        with open(PERF, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(hist, f, indent=1)
            f.write('\n')
    except OSError:
        pass
    judged = sum(1 for _, _, u in rows if u is not None)
    print(f'\nPerformance ({len(rows)} timed; {judged} against their usual times):')
    if show_all:
        for key, ms, usual in rows:
            print(f'  {key:44} {ms:8.0f} ms' + (f'   usual {usual:.0f} ms ({ms / usual:.2f}x)' if usual else '   (no history yet)'))
    for key, ms, usual in slower:
        print(f'  SLOWER  {key:40} {ms:.0f} ms, usually {usual:.0f} ms' + (f' ({ms / usual:.1f}x)' if usual else ''))
    if not slower:
        print('  no slowdowns' if judged else f'  (no history yet: times are compared after {PERF_MIN_RUNS} runs)')
    slowest = sorted(rows, key=lambda r: -r[1])[:3]
    print('  slowest: ' + ', '.join(f'{k} {ms / 1000:.1f} s' for k, ms, _ in slowest))
    if usual_total:
        print(f'  whole run {total_s:.0f} s (usually {usual_total:.0f} s)')
    return len(slower)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--update', action='store_true')
    ap.add_argument('--make-parts', action='store_true')
    ap.add_argument('--only', nargs='*')
    ap.add_argument('--headed', action='store_true', help='show the browser window')
    ap.add_argument('--perf', action='store_true', help='list every test time against its usual time')
    ap.add_argument('--perf-strict', action='store_true', help='fail when something got markedly slower')
    ap.add_argument('--jobs', type=int, default=0, help="pages run at once (default: by the PC's threads)")
    ap.add_argument('--shard', help='I/N: run only share I of N (the UI tests shared out by tests/test-weights.json)')
    ap.add_argument('--weights', metavar='LOG', help="write tests/test-weights.json from a run's output, and stop")
    args = ap.parse_args()
    try: sys.stdout.reconfigure(encoding='utf-8')
    except Exception: pass
    if args.weights:
        save_weights(args.weights)
        return
    shard = None
    if args.shard:
        try:
            shard = tuple(int(x) for x in args.shard.split('/'))
            assert len(shard) == 2 and 1 <= shard[0] <= shard[1]
        except (ValueError, AssertionError):
            sys.exit(f'--shard takes I/N (1 <= I <= N), not {args.shard}')
        if args.only:
            sys.exit('--shard and --only do not go together')
    first = not shard or shard[0] == 1  # (the parts, drawings and desktop tests: on the first share only)

    from playwright.sync_api import sync_playwright
    httpd = serve()
    url = f'http://127.0.0.1:{httpd.server_address[1]}/index.html'
    console_errors = []
    t0 = time.time()
    with sync_playwright() as p:
        # (on a CI machine with no graphics card, WebGL needs the software renderer allowed)
        ci_args = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] if os.environ.get('CI') else []
        browser = p.chromium.launch(channel='msedge', headless=not args.headed, args=ci_args)
        # (with where it came from: a worker's failed load says nothing else). Not counted: the app's one look for
        # the PC's fonts at _fonts/ (platform.js: a server without them answers 404, and they are not asked for
        # again; the desktop app serves them itself), which the browser always reports as a failed load.
        font_probe = lambda url: '/_fonts/' in (url or '')
        ready = "window.app && window.app.doc && !window.app.kernel.pending && document.querySelector('#status-msg')?.textContent === 'Ready'"

        def open_page(tag='', threads=None):
            """A page of its own (own storage), RazorCAD loading in it; threads: the processor threads it is told the
            PC has (its share, with several jobs: else each would start kernels for the whole PC)."""
            page = browser.new_context(viewport={'width': 1400, 'height': 900}).new_page()
            if threads:
                page.add_init_script(f"Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {{ get: () => {threads} }});")
            page.on('console', lambda m: None if m.type != 'error' or font_probe((m.location or {}).get('url')) else console_errors.append(tag + m.text + (f"  [{m.location.get('url', '')}:{m.location.get('lineNumber', '')}]" if m.location and m.location.get('url') else '')))
            page.on('pageerror', lambda e: console_errors.append(tag + str(e)))
            # (the browser's "Failed to load resource" doesn't say which: the address too)
            page.on('response', lambda r: console_errors.append(f'{tag}  ({r.status} for {r.url})') if r.status >= 400 and not (r.status == 404 and font_probe(r.url)) else None)
            # (a fresh browser is a first run: no Getting Started Tour over the tests)
            page.add_init_script("try { const p = JSON.parse(localStorage.getItem('razorcad.prefs') || '{}'); p.tourDone = true; localStorage.setItem('razorcad.prefs', JSON.stringify(p)); } catch (e) {}")
            page.goto(url)
            return page

        def wait_ready(page):
            for attempt in (1, 2):
                try:
                    page.wait_for_function(ready, timeout=180000)
                    return
                except Exception:
                    # (say why RazorCAD didn't start, not just that it timed out; a CI runner now and then stalls while
                    # the page starts, so the page is loaded once more before the run fails)
                    try:
                        status = page.evaluate("document.querySelector('#status-msg')?.textContent ?? '(no status line)'")
                    except Exception as e:
                        status = f'(page not readable: {e})'
                    print(f'RazorCAD did not get to Ready within 3 minutes (try {attempt} of 2). Status line: {status}')
                    print(f'Browser console errors ({len(console_errors)}):' if console_errors else 'No browser console errors.')
                    for e in console_errors[:20]:
                        print('  ' + e[:300])
                    if attempt == 2:
                        raise
                    console_errors.clear()
                    page.reload()

        jobs = 1 if args.only else max(1, args.jobs or default_jobs())
        share_threads = max(6, (os.cpu_count() or 4) // jobs) if jobs > 1 else None
        page = open_page(threads=share_threads)
        wait_ready(page)

        if args.make_parts:
            os.makedirs(PARTS, exist_ok=True)
            made = page.evaluate("async () => (await import('/tests/make_parts.js')).makeParts().map((x) => ({ name: x.name, json: JSON.stringify(x.doc, null, 1) }))")
            for m in made:
                with open(os.path.join(PARTS, m['name'] + '.rcad'), 'w', encoding='utf-8', newline='\n') as f:
                    f.write(m['json'] + '\n')
            print(f'made {len(made)} test parts')

        parts = []
        for n in sorted(os.listdir(PARTS)):
            if n.endswith('.rcad'):
                with open(os.path.join(PARTS, n), encoding='utf-8') as f:
                    parts.append({'name': n[:-5], 'json': f.read()})

        # the jobs: the UI tests shared out (one page with --only or --jobs 1)
        names = page.evaluate("async () => (await import('/tests/suite.js')).uiTests()")
        if shard:
            # (this machine's share; the parts and drawings, on the first, weigh about 3 minutes on a CI runner)
            mine = share_out(names, shard[1], shard_weights(names), 180000)[shard[0] - 1]
            print(f'Share {shard[0]} of {shard[1]}: {len(mine)} of {len(names)} UI tests' + (', the parts and drawings' if first else ''))
            names = mine
        jobs = min(jobs, len(names) or 1)
        shares = share_out(names, jobs, usual_times(jobs), 5000) if jobs > 1 else ([names] if shard else [None])  # (parts and drawings: about 4 s)
        pages = [page] + [open_page(f'[job {j + 1}] ', share_threads) for j in range(1, jobs)]
        for pg in pages[1:]:
            wait_ready(pg)
        # every page started, then each waited for (they run side by side in the browser)
        for j, pg in enumerate(pages):
            pg.set_default_timeout(0)
            share = {} if shares[j] is None else {'parts': j == 0 and first, 'ui': shares[j]}
            pg.evaluate("([parts, only, share]) => { import('/tests/suite.js').then((m) => m.run(parts, only, share)).then((r) => { window.__testResult = r; }, (e) => { window.__testResult = { crash: String(e && (e.stack || e)) }; }).finally(() => { window.__testDone = performance.timeOrigin + performance.now(); }); }", [parts, args.only, share])
        started, runs, done = time.time() - t0, [], []
        for pg in pages:
            pg.wait_for_function("window.__testDone !== undefined", timeout=0, polling=250)
            runs.append(pg.evaluate("window.__testResult"))
            done.append(pg.evaluate("window.__testDone") - t0 * 1000 if jobs > 1 else 0)
        if jobs > 1:
            print(f'{jobs} jobs side by side: started at {started:.0f} s, done at ' + ', '.join(f'{ms / 1000:.0f}' for ms in done) + ' s')
        browser.close()
    httpd.shutdown()

    results = {'parts': {}, 'ui': {}, 'drawings': {}}
    for j, r in enumerate(runs):
        if 'crash' in r:
            results['ui'][f'(job {j + 1})'] = {'ok': False, 'detail': 'crashed: ' + r['crash']}
            continue
        results['parts'].update(r['parts'])
        results['drawings'].update(r['drawings'])
        results['ui'].update(r['ui'])
    # (the UI tests listed in the suite's order)
    results['ui'] = {n: results['ui'][n] for n in names + [k for k in results['ui'] if k not in names] if n in results['ui']}

    perf_times = timings(results)
    expected = {}
    if os.path.exists(EXPECTED):
        with open(EXPECTED, encoding='utf-8') as f:
            expected = json.load(f)
    failures = 0
    print(f'\nParts ({len(results["parts"])}):')
    for name, got in results['parts'].items():
        times = ', '.join(f'{v.get("ms", "?")} ms' for v in got.values() if isinstance(v, dict))
        if args.update:
            print(f'  {name:24} recorded ({times})')
            continue
        want = expected.get('parts', {}).get(name)
        diffs = ['not in expected.json (run with --update)'] if want is None else compare(name, got, want)
        print(f'  {"PASS" if not diffs else "FAIL"}  {name:24} {times}')
        for d in diffs:
            print(f'        {d}')
        failures += bool(diffs)
    drawings = results.get('drawings', {})
    if drawings:
        print(f'\nDrawings ({len(drawings)}):')
    for name, got in drawings.items():
        ms = got.pop('ms', '?') if isinstance(got, dict) else '?'
        if args.update:
            print(f'  {name:24} recorded ({ms} ms)')
            continue
        want = expected.get('drawings', {}).get(name)
        diffs = ['not in expected.json (run with --update)'] if want is None else compare_drawing(got, want)
        print(f'  {"PASS" if not diffs else "FAIL"}  {name:24} {ms} ms')
        for d in diffs:
            print(f'        {d}')
        failures += bool(diffs)
    print(f'\nUI ({len(results["ui"])}):')
    for name, r in results['ui'].items():
        print(f'  {"PASS" if r.get("ok") else "FAIL"}  {name:24} {r.get("ms", "?")} ms  {r.get("detail", "")}')
        failures += not r.get('ok')
    # the desktop app's own tests (Python: the updater's hand-over to the setup), with the whole run or --only updater
    if (not args.only and first) or (args.only and 'updater' in args.only):
        import unittest
        suite = unittest.defaultTestLoader.discover(os.path.dirname(os.path.abspath(__file__)), pattern='test_updater.py')
        ids = [x.id() for g in suite for s in g for x in s]  # (a suite lets go of its tests once run)
        outcome = unittest.TestResult()
        suite.run(outcome)
        bad = {t.id(): why for t, why in outcome.failures + outcome.errors}
        print(f'\nDesktop ({outcome.testsRun}):')
        for i in ids:
            print(f'  {"FAIL" if i in bad else "PASS"}  {i.split(".")[-1]}')
            if i in bad:
                print('        ' + bad[i].strip().splitlines()[-1])
        failures += len(bad)
    if console_errors:
        print(f'\nBrowser console errors ({len(console_errors)}):')
        for e in console_errors[:20]:
            print('  ' + e[:300])
    if args.update:
        merged = dict(expected)
        merged.setdefault('parts', {})
        merged['parts'].update(results['parts'])
        merged.setdefault('drawings', {})
        merged['drawings'].update(drawings)
        for v in merged['parts'].values():
            for c in v.values():
                if isinstance(c, dict):
                    c.pop('ms', None)
        with open(EXPECTED, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(merged, f, indent=1)
            f.write('\n')
        print(f'\nexpected.json updated ({len(results["parts"])} parts, {len(drawings)} drawings).')
    slower = perf_report(perf_times, time.time() - t0, args.perf, whole=not args.only and not shard, jobs=jobs)
    if args.perf_strict and slower:
        failures += slower
    print(f'\n{"ALL PASSED" if not failures else f"{failures} FAILED"}  ({time.time() - t0:.0f} s' + (f', {jobs} jobs side by side)' if jobs > 1 else ')'))
    sys.exit(1 if failures and not args.update else 0)


if __name__ == '__main__':
    main()
