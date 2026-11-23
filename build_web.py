"""Builds docs/index.html: one self-contained web page (GitHub Pages serves /docs).

It inlines web/style.css, web/engine.js, web/app.js, policy.json and the 12
borrower files into web/template.html. Run it again after changing any of them:

    python3 build_web.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).parent
WEB = ROOT / "web"


def main():
    policy = json.loads((ROOT / "policy.json").read_text())
    borrowers = [json.loads(p.read_text()) for p in sorted((ROOT / "data" / "borrowers").glob("B*.json"))]
    data = json.dumps({"policy": policy, "borrowers": borrowers}).replace("</", "<\\/")
    html = (WEB / "template.html").read_text()
    for marker, content in [("/*__STYLE__*/", (WEB / "style.css").read_text()),
                            ("/*__DATA__*/", data),
                            ("/*__ENGINE__*/", (WEB / "engine.js").read_text()),
                            ("/*__APP__*/", (WEB / "app.js").read_text())]:
        assert marker in html, marker
        html = html.replace(marker, content)
    out = ROOT / "docs" / "index.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(html)
    print(f"Built {out} ({len(html) // 1024} KB)")


if __name__ == "__main__":
    main()
