"""Checks the website as it is served: the home page, the browser version's headers (cross-origin isolated, which its
multi-threaded geometry kernel needs: website/_headers), and the browser version itself in headless Microsoft Edge
(it starts, the page is isolated, a multi-threaded kernel starts and builds a part).

    python tools/check_site.py                          https://razorcad.com, once
    python tools/check_site.py https://example.test     another address (e.g. a local server of website/)
    python tools/check_site.py --wait 600               first wait (up to 600 s) until the site serves this
                                                        checkout's browser version (after a push: the host
                                                        deploys it a little later)

Exit code 1 on any failure. Run by .github/workflows/site-check.yml after each push that changes the website.
Needs Python's playwright package; it uses the Edge already on the PC.
"""
import argparse
import os
import re
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HEADERS = {'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin'}


def get(url):
    req = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'RazorCAD site check'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()


def kernel_sig(html):
    """The kernel signature the browser version's page carries (window.RAZORCAD_WEB = { …, kernel: '…' })."""
    m = re.search(r"RAZORCAD_WEB\s*=\s*\{[^}]*kernel:\s*'([^']+)'", html)
    return m.group(1) if m else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('base', nargs='?', default='https://razorcad.com')
    ap.add_argument('--wait', type=int, default=0, help="seconds to wait for this checkout's browser version to be served")
    ap.add_argument('--headed', action='store_true')
    args = ap.parse_args()
    try: sys.stdout.reconfigure(encoding='utf-8')
    except Exception: pass
    base = args.base.rstrip('/')
    fails = []

    if args.wait:
        with open(os.path.join(ROOT, 'website', 'app', 'index.html'), encoding='utf-8') as f:
            want = kernel_sig(f.read())
        t0, seen = time.time(), None
        while True:
            try:
                seen = kernel_sig(get(f'{base}/app/?v={int(time.time())}')[2].decode('utf-8', 'replace'))
            except Exception as e:
                seen = f'({e})'
            # (at least a minute: a push that leaves the browser version as it was has its other files deployed too)
            if (seen == want and time.time() - t0 >= min(60, args.wait)) or time.time() - t0 > args.wait:
                break
            time.sleep(min(15, max(1, args.wait // 10)))
        print(f'browser version served: kernel {seen}' + ('' if seen == want else f' (this checkout has {want})'))
        if seen != want:
            fails.append(f'the site did not serve this checkout\'s browser version within {args.wait} s')

    # the pages and the browser version's headers
    # (the kernel is published gzipped: tools/build_web_app.py pack_kernels)
    for path in ['/', '/docs/', '/app/', '/app/js/kernel.worker.js', '/app/vendor/replicad/replicad_multi.wasm.gz']:
        try:
            status, h, body = get(base + path)
        except Exception as e:
            fails.append(f'{path}: {e}')
            continue
        if status != 200:
            fails.append(f'{path}: status {status}')
        if path.startswith('/app/'):
            bad = [f'{k}: {h.get(k)!r}' for k, v in HEADERS.items() if h.get(k) != v]
            if bad:
                fails.append(f'{path}: not isolated ({", ".join(bad)})')
        print(f'{path}: {status}, {len(body):,} bytes')

    # the browser version itself
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=not args.headed)
        page = browser.new_page(viewport={'width': 1400, 'height': 900})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.add_init_script("try { const p = JSON.parse(localStorage.getItem('razorcad.prefs') || '{}'); p.tourDone = true; localStorage.setItem('razorcad.prefs', JSON.stringify(p)); } catch (e) {}")
        page.goto(f'{base}/app/')
        try:
            page.wait_for_function("window.app && window.app.doc && !window.app.kernel.pending && document.querySelector('#status-msg')?.textContent === 'Ready'", timeout=180000)
        except Exception:
            fails.append('the browser version did not get to Ready within 3 minutes: ' + str(page.evaluate("document.querySelector('#status-msg')?.textContent ?? '(no status line)'")))
        r = page.evaluate("""async () => {
          const out = { isolated: !!self.crossOriginIsolated, web: !!window.RAZORCAD_WEB };
          try {
            out.app = await window.app.kernel.request('stats', {});
            // (a kernel with threads, whatever the PC: the runner may have too few for the app to use them)
            const { KernelClient } = await import('./js/kernelclient.js'), M = await import('./js/model.js');
            const k = new KernelClient({ threads: 4 });
            try {
              await k.ready;
              const d = M.newDoc(); d.name = 'Site check';
              const s = M.createFeature(d, 'sketch', { plane: { ref: 'top' } });
              const pts = [[-10, -5], [10, -5], [10, 5], [-10, 5]];
              Object.assign(s, { points: pts.map(([x, y], i) => ({ id: 'p' + (i + 1), x, y })), curves: pts.map((_, i) => ({ id: 'c' + (i + 1), type: 'line', p1: 'p' + (i + 1), p2: 'p' + ((i + 1) % 4 + 1), construction: false })) });
              d.features.push(s, M.createFeature(d, 'extrude', { sketch: s.id, depth: 3 }));
              const b = await k.request('rebuild', { doc: JSON.stringify(d) });
              out.multi = await k.request('stats', {});
              out.part = { bodies: b.body?.bodies?.length || 0, errors: b.errors?.length || 0 };
            } finally { k.dispose(); }
          } catch (e) { out.error = String(e?.message || e); }
          return out;
        }""")
        browser.close()
    print(f"browser version: isolated {r.get('isolated')}, app kernel {r.get('app', {}).get('build')} ({r.get('app', {}).get('threads')} threads), "
          f"a 4-thread kernel {r.get('multi', {}).get('build')} ({r.get('multi', {}).get('threads')} threads), part {r.get('part')}")
    if not r.get('isolated'):
        fails.append('the browser version is not cross-origin isolated (no shared memory: single-thread kernel only)')
    if r.get('error'):
        fails.append('kernel: ' + r['error'])
    if r.get('multi', {}).get('build') != 'replicad_multi':
        fails.append(f"a kernel asked for 4 threads started as {r.get('multi', {}).get('build')}")
    if (r.get('part') or {}).get('bodies') != 1 or (r.get('part') or {}).get('errors'):
        fails.append(f"the test part did not build: {r.get('part')}")
    for e in errors[:10]:
        fails.append('page error: ' + e[:300])

    print('\n' + ('SITE OK' if not fails else f'{len(fails)} PROBLEM(S):\n  ' + '\n  '.join(fails)))
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
