"""Renders the colored output of `bun run demo` as a terminal-looking PNG (docs/demo.png).

    FORCE_COLOR=1 bun run --silent demo | python scripts/render_terminal.py docs/demo.png

Needs `pip install playwright` and a Chromium for Playwright; set CHROMIUM_PATH if your Chromium lives elsewhere.
"""
import html
import os
import re
import sys

from playwright.sync_api import sync_playwright

COLORS = {"90": "#6b7280", "31": "#f87171", "32": "#4ade80", "33": "#fbbf24", "34": "#60a5fa", "35": "#c084fc", "36": "#22d3ee", "1": None}


def ansi_to_html(text: str) -> str:
    out, stack = [], 0
    for part in re.split(r"(\x1b\[[0-9;]*m)", text):
        m = re.fullmatch(r"\x1b\[([0-9;]*)m", part)
        if not m:
            out.append(html.escape(part))
        elif m.group(1) in ("0", ""):
            out.append("</span>" * stack)
            stack = 0
        elif m.group(1) == "1":
            out.append('<span style="font-weight:700;color:#f3f4f6">')
            stack += 1
        elif m.group(1) in COLORS:
            out.append(f'<span style="color:{COLORS[m.group(1)]}">')
            stack += 1
    return "".join(out) + "</span>" * stack


def main(dest: str) -> None:
    body = ansi_to_html(sys.stdin.read())
    page = f"""<!doctype html><meta charset=utf-8><body style="margin:0;background:#0b0f14">
<div style="margin:0;padding:22px 26px;width:max-content;background:#0f141b;color:#d1d5db;font:14px/1.5 'DejaVu Sans Mono',monospace">
<div style="color:#6b7280;margin-bottom:12px">$ bun run demo</div><pre style="margin:0;font:inherit">{body}</pre></div>"""
    exe = os.environ.get("CHROMIUM_PATH")
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
        pg = browser.new_page(device_scale_factor=2)
        pg.set_content(page)
        pg.locator("div").first.screenshot(path=dest)
        browser.close()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "docs/demo.png")
