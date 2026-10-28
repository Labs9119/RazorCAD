"""Build the manual RazorCAD shows itself (Help ▸ User Manual, F1) from Manual/manual_source.md.

Writes app/help/manual.json: the manual cut into its sections (## and ###, a chapter's opening text as one of its
own), each with its HTML (as the online manual renders it), its words as plain text for searching and its {idx:}
index terms. The help panel (app/js/help.js) searches these and shows one section at a time.

Run by tools/build_website_docs.py, or by itself:  python tools/build_app_help.py
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import build_website_docs as docs  # noqa: E402

OUT = ROOT / "app" / "help" / "manual.json"


def sections(chapter):
    """[(level, title, lines)] of a chapter: its opening text (level 1, the chapter's title), then each ## and ###"""
    out, cur = [], (1, chapter["title"], [])
    fence = False
    for ln in chapter["lines"]:
        if ln.strip().startswith("```"):
            fence = not fence
        if not fence and (ln.startswith("## ") or ln.startswith("### ")):
            out.append(cur)
            level = 2 if ln.startswith("## ") else 3
            cur = (level, ln[level + 1:].strip(), [])
            continue
        cur[2].append(ln)
    out.append(cur)
    return [s for s in out if s[0] > 1 or any(x.strip() for x in s[2])]


def build():
    chapters = docs.parse(docs.SRC.read_text(encoding="utf-8"))
    items, used = [], set()
    for ch in chapters:
        parent = ""
        for level, title, lines in sections(ch):
            text = "\n".join(lines)
            terms = sorted({t.strip() for t in re.findall(r"\{idx:([^}]*)\}", title + "\n" + text) if t.strip()})
            name = docs.plain(title)
            if level == 2:
                parent = name
            sid = ch["slug"] if level == 1 else docs.slug(f"{ch['slug']} {name}")
            base, k = sid, 2
            while sid in used:
                sid, k = f"{base}-{k}", k + 1
            used.add(sid)
            words = docs.plain(re.sub(r"<[^>]+>", " ", text))
            words = re.sub(r"^\s*(#{2,3} |- |\d+\. |> )", "", words, flags=re.M)
            words = re.sub(r"[|]+", " ", words)
            items.append({
                "id": sid,
                "chapter": ch["title"],
                "parent": parent if level == 3 else "",
                "title": name,
                "level": level,
                "terms": terms,
                "text": re.sub(r"\s+", " ", words).strip(),
                "html": docs.render(lines),
            })
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"version": docs.VERSION, "sections": items}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(items)} manual sections written to {OUT}")


if __name__ == "__main__":
    build()
