"""Build the online user manual for razorcad.com from Manual/manual_source.md.

Writes website/docs/index.html (contents) and one page per chapter (website/docs/<slug>.html,
served by Cloudflare Pages as /docs/<slug>), and rewrites website/sitemap.xml.

The source uses the same small Markdown subset as Manual/build_manual.py: # chapter, ## section,
### subsection, paragraphs, **bold**, *italic*, `code`, [[Key]], bullets ("- ", "  - "), numbered
items ("1. "), tables, "> Note:/Tip:/Warning:" boxes, ``` code blocks and {idx:term} index marks.

Sections about the PDF itself, the "Not yet available" lists and the revision history are left out.

Usage:  python tools/build_website_docs.py
"""
import datetime
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "Manual" / "manual_source.md"
SITE = ROOT / "website"
OUT = SITE / "docs"
BASE = "https://razorcad.com"
VERSION = (ROOT / "version.txt").read_text(encoding="utf-8").strip()

SKIP_CHAPTERS = {"Appendix C: Manual Revision History"}
SKIP_SECTIONS = {"About this manual", "Not yet available"}


def slug(text):
    text = re.sub(r"^appendix [a-z]:\s*", "", text.lower())
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def inline(text):
    text = re.sub(r"\{idx:[^}]*\}", "", text)
    parts = re.split(r"(`[^`]+`)", text)
    out = []
    for p in parts:
        if p.startswith("`") and p.endswith("`") and len(p) > 1:
            out.append("<code>" + html.escape(p[1:-1]) + "</code>")
            continue
        p = html.escape(p, quote=False)
        p = re.sub(r"\[\[(.+?)\]\]", r"<kbd>\1</kbd>", p)
        p = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", p)
        p = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<em>\1</em>", p)
        out.append(p)
    return "".join(out).strip()


def plain(text):
    text = re.sub(r"\{idx:[^}]*\}", "", text)
    text = re.sub(r"\[\[(.+?)\]\]", r"\1", text)
    return re.sub(r"[*`]", "", text).strip()


def parse(src):
    """Chapters: [{title, slug, blocks: [lines], sections: [(title, id)]}]"""
    lines = src.splitlines()
    if lines and lines[0].strip() == "---":
        end = lines.index("---", 1)
        lines = lines[end + 1:]
    chapters, cur, skip_sec = [], None, False
    for ln in lines:
        if ln.startswith("# "):
            title = ln[2:].strip()
            cur = {"title": title, "slug": slug(title), "lines": [], "sections": []}
            skip_sec = False
            if title not in SKIP_CHAPTERS:
                chapters.append(cur)
            continue
        if cur is None:
            continue
        if ln.startswith("## "):
            title = ln[3:].strip()
            skip_sec = title in SKIP_SECTIONS
            if not skip_sec:
                cur["sections"].append((plain(title), slug(title)))
        if not skip_sec:
            cur["lines"].append(ln)
    return chapters


def render(lines):
    out, i, n = [], 0, len(lines)

    def para_end(j):
        return j >= n or not lines[j].strip() or re.match(r"(#{2,3} |- |\s+- |\d+\. |\||> |```)", lines[j])

    while i < n:
        ln = lines[i]
        s = ln.strip()
        if not s or re.fullmatch(r"(\{idx:[^}]*\})+", s):
            i += 1
        elif ln.startswith("### "):
            t = ln[4:].strip()
            out.append(f'<h3 id="{slug(t)}">{inline(t)}</h3>')
            i += 1
        elif ln.startswith("## "):
            t = ln[3:].strip()
            out.append(f'<h2 id="{slug(t)}">{inline(t)}</h2>')
            i += 1
        elif s.startswith("```"):
            j = i + 1
            while j < n and not lines[j].strip().startswith("```"):
                j += 1
            out.append("<pre><code>" + html.escape("\n".join(lines[i + 1:j])) + "</code></pre>")
            i = j + 1
        elif s.startswith("|"):
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                rows.append(lines[i].strip())
                i += 1
            cells = lambda r: [c.strip() for c in r.strip("|").split("|")]
            head, body = cells(rows[0]), [cells(r) for r in rows[1:] if not re.fullmatch(r"\|[\s|:-]+\|", r)]
            t = ['<div class="table-wrap"><table>', "<thead><tr>" + "".join(f"<th>{inline(c)}</th>" for c in head) + "</tr></thead><tbody>"]
            t += ["<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in body]
            out.append("".join(t) + "</tbody></table></div>")
        elif s.startswith("> "):
            text = []
            while i < n and lines[i].strip().startswith(">"):
                text.append(lines[i].strip().lstrip(">").strip())
                i += 1
            body = " ".join(text)
            m = re.match(r"(Note|Tip|Warning):\s*(.*)", body)
            kind, body = (m.group(1), m.group(2)) if m else ("Note", body)
            out.append(f'<aside class="callout callout-{kind.lower()}"><strong>{kind}:</strong> {inline(body)}</aside>')
        elif re.match(r"\d+\. ", s):
            items = []
            while i < n and re.match(r"\d+\. ", lines[i].strip()):
                items.append(re.sub(r"^\d+\.\s+", "", lines[i].strip()))
                i += 1
            out.append('<ol class="steps-list">' + "".join(f"<li>{inline(x)}</li>" for x in items) + "</ol>")
        elif re.match(r"\s*- ", ln):
            html_items, depth = [], 0
            while i < n and re.match(r"\s*- ", lines[i]):
                d = 1 if lines[i].startswith(" ") else 0
                text = inline(lines[i].strip()[2:])
                if d > depth:
                    html_items[-1] = html_items[-1][:-5] + "<ul>"
                    html_items.append(f"<li>{text}</li>")
                elif d < depth:
                    html_items.append(f"</ul></li><li>{text}</li>")
                else:
                    html_items.append(f"<li>{text}</li>")
                depth = d
                i += 1
            if depth:
                html_items.append("</ul></li>")
            out.append("<ul>" + "".join(html_items) + "</ul>")
        else:
            j = i
            text = []
            while j < n and (j == i or not para_end(j)):
                text.append(lines[j].strip())
                j += 1
            out.append(f"<p>{inline(' '.join(text))}</p>")
            i = j
    return "\n".join(out)


def description(ch):
    for ln in ch["lines"]:
        s = ln.strip()
        if s and not re.match(r"(#|- |\s*- |\d+\. |\||> |```|\{idx)", s):
            text = plain(s)
            if len(text) > 150:
                text = text[:150].rsplit(" ", 1)[0].rstrip(",;:") + "…"
            return text
    return f"{ch['title']} in the RazorCAD user manual."


GITHUB_ICON = '<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>'
ZONES = ("".join(f"<span>{k}</span>" for k in "12345678"), "".join(f"<span>{k}</span>" for k in "ABCDEF"))


def page(title, desc, path, body, sheet, crumbs):
    url = BASE + path
    crumb_ld = {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
        {"@type": "ListItem", "position": k + 1, "name": name, "item": BASE + href} for k, (name, href) in enumerate(crumbs)]}
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<meta name="description" content="{html.escape(desc)}">
<link rel="canonical" href="{url}">
<meta name="theme-color" content="#a81616">
<meta property="og:type" content="article">
<meta property="og:site_name" content="RazorCAD">
<meta property="og:url" content="{url}">
<meta property="og:title" content="{html.escape(title)}">
<meta property="og:description" content="{html.escape(desc)}">
<meta property="og:image" content="{BASE}/img/social.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/img/razorcad-512.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
<script type="application/ld+json">{json.dumps(crumb_ld)}</script>
</head>
<body>

<a class="skip" href="#main">Skip to content</a>

<header class="top">
  <a class="brand" href="/" aria-label="RazorCAD home">
    <img src="/favicon.svg" alt="" width="34" height="34">
    <span>RazorCAD</span>
  </a>
  <nav aria-label="Main">
    <a href="/#features">Features</a>
    <a href="/docs/"{' aria-current="page"' if path == '/docs/' else ''}>Manual</a>
    <a href="/#download">Download</a>
    <a class="nav-gh" href="https://github.com/Labs9119/RazorCAD">{GITHUB_ICON} GitHub</a>
  </nav>
</header>

<div class="frame">
  <div class="zones zones-top" aria-hidden="true">{ZONES[0]}</div>
  <div class="zones zones-bottom" aria-hidden="true">{ZONES[0]}</div>
  <div class="zones zones-left" aria-hidden="true">{ZONES[1]}</div>
  <div class="zones zones-right" aria-hidden="true">{ZONES[1]}</div>
  <div class="sheet">
{body}
  <footer class="titleblock" aria-label="About this page">
    <div class="tb-cell tb-logo"><img src="/favicon.svg" alt="" width="44" height="44"></div>
    <div class="tb-cell tb-title"><span class="tb-label">Title</span><span class="tb-value tb-big">RazorCAD user manual</span></div>
    <div class="tb-cell"><span class="tb-label">Rev</span><span class="tb-value">{VERSION}</span></div>
    <div class="tb-cell"><span class="tb-label">Licence</span><span class="tb-value"><a href="https://github.com/Labs9119/RazorCAD/blob/main/LICENSE">GPL-3.0</a></span></div>
    <div class="tb-cell"><span class="tb-label">Source</span><span class="tb-value"><a href="https://github.com/Labs9119/RazorCAD">Labs9119/RazorCAD</a></span></div>
    <div class="tb-cell"><span class="tb-label">Kernel</span><span class="tb-value">OpenCascade</span></div>
    <div class="tb-cell"><span class="tb-label">Support</span><span class="tb-value"><a href="https://github.com/Labs9119/RazorCAD/issues">Issues</a></span></div>
    <div class="tb-cell"><span class="tb-label">Sheet</span><span class="tb-value">{sheet}</span></div>
  </footer>
  </div>
</div>
</body>
</html>
"""


def sidebar(chapters, current):
    items = []
    for ch in chapters:
        here = ch["slug"] == current
        sub = ""
        if here and ch["sections"]:
            sub = "<ul>" + "".join(f'<li><a href="#{sid}">{html.escape(t)}</a></li>' for t, sid in ch["sections"]) + "</ul>"
        cur = ' aria-current="page"' if here else ""
        items.append(f'<li><a href="/docs/{ch["slug"]}"{cur}>{html.escape(ch["title"])}</a>{sub}</li>')
    return "<ol>" + "".join(items) + "</ol>"


def main():
    chapters = parse(SRC.read_text(encoding="utf-8"))
    OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.html"):
        old.unlink()
    total = len(chapters) + 1
    pdf = f"https://github.com/Labs9119/RazorCAD/releases/download/v{VERSION}/RazorCAD-User-Manual-{VERSION}.pdf"

    for k, ch in enumerate(chapters):
        prev_ch = chapters[k - 1] if k else None
        next_ch = chapters[k + 1] if k + 1 < len(chapters) else None
        pager = '<nav class="pager" aria-label="Chapters">'
        pager += f'<a class="pager-prev" href="/docs/{prev_ch["slug"]}"><span>Previous</span>{html.escape(prev_ch["title"])}</a>' if prev_ch else '<a class="pager-prev" href="/docs/"><span>Back to</span>Contents</a>'
        if next_ch:
            pager += f'<a class="pager-next" href="/docs/{next_ch["slug"]}"><span>Next</span>{html.escape(next_ch["title"])}</a>'
        pager += "</nav>"
        body = f"""  <div class="docs">
    <details class="docs-nav">
      <summary>Chapters</summary>
      <nav aria-label="Manual chapters">{sidebar(chapters, ch["slug"])}</nav>
    </details>
    <script>if (matchMedia("(min-width: 1000px)").matches) document.querySelector(".docs-nav").open = true;</script>
    <main id="main" class="docs-main">
      <p class="crumbs"><a href="/docs/">User manual</a> / {html.escape(ch["title"])}</p>
      <article class="prose">
        <h1>{html.escape(ch["title"])}</h1>
{render(ch["lines"])}
      </article>
      {pager}
    </main>
  </div>"""
        path = f"/docs/{ch['slug']}"
        (OUT / f"{ch['slug']}.html").write_text(
            page(f"{ch['title']} | RazorCAD user manual", description(ch), path, body, f"{k + 2} of {total}",
                 [("User manual", "/docs/"), (ch["title"], path)]),
            encoding="utf-8")

    cards = "".join(
        f'<li><a href="/docs/{ch["slug"]}">{html.escape(ch["title"])}</a>'
        + ("<p>" + ", ".join(html.escape(t) for t, _ in ch["sections"][:6]) + ("…" if len(ch["sections"]) > 6 else "") + "</p>" if ch["sections"] else "")
        + "</li>" for ch in chapters)
    body = f"""  <main id="main" class="docs-index">
    <h1>RazorCAD user manual</h1>
    <p class="lede">How to install RazorCAD, sketch, build parts, sheet metal and surfaces, and make drawings.
      This is the manual for version {VERSION}. You can also <a href="{pdf}">download it as a PDF</a>.</p>
    <ol class="chapter-list">{cards}</ol>
  </main>"""
    (OUT / "index.html").write_text(
        page("RazorCAD user manual", f"The RazorCAD {VERSION} user manual online: installing, sketching, solid features, sheet metal, surfaces, drawings and keyboard shortcuts.",
             "/docs/", body, f"1 of {total}", [("User manual", "/docs/")]),
        encoding="utf-8")

    today = datetime.date.today().isoformat()
    urls = ["/", "/app/", "/docs/"] + [f"/docs/{ch['slug']}" for ch in chapters]
    sm = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    sm += [f"  <url>\n    <loc>{BASE}{u}</loc>\n    <lastmod>{today}</lastmod>\n  </url>" for u in urls]
    sm.append("</urlset>")
    (SITE / "sitemap.xml").write_text("\n".join(sm) + "\n", encoding="utf-8")
    print(f"{len(chapters)} chapters written to {OUT}")
    # the manual RazorCAD shows itself (Help > User Manual, F1), before the browser version is copied from the app
    import importlib.util
    spec = importlib.util.spec_from_file_location("build_app_help", Path(__file__).with_name("build_app_help.py"))
    app_help = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(app_help)
    app_help.build()
    # the browser version (razorcad.com/app/), brought up to date with the website
    import importlib.util
    spec = importlib.util.spec_from_file_location("build_web_app", Path(__file__).with_name("build_web_app.py"))
    web = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(web)
    web.main()


if __name__ == "__main__":
    main()
