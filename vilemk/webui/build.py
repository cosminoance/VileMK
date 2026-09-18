"""Fill `template.html` with one keymap payload, and write it out.

The template is a plain HTML file, not a Python string: it is edited, linted and
diffed as HTML. This module is the only seam between it and the data - four
placeholders, substituted once, no template engine. It is read from disk on
every call, so editing `template.html` shows up on the next page load without
restarting the server.

The page this writes never writes back - it is a reader. For the editable
version, see `vilemk.webui.server`.

Usage:
    python3 -m vilemk.webui.build                       # -> keymap-ui.html
    python3 -m vilemk.webui.build --open                # ...and open it
    python3 -m vilemk.webui.build -o /tmp/keymaps.html
    python3 -m vilemk.webui.build --all                 # also every in-tree board
    python3 -m vilemk.webui.build --include corne       # add one board/shield
    python3 -m vilemk.webui.build --json                # dump the data, no HTML
"""

from __future__ import annotations

import argparse
import html
import json
import os
import sys

from .. import keymap, keypos

TEMPLATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "template.html")


def template() -> str:
    """The raw page, placeholders unfilled."""
    with open(TEMPLATE_PATH, encoding="utf-8") as fh:
        return fh.read()


def build_html(data: dict) -> str:
    payload = json.dumps(data, separators=(",", ":")).replace("</", "<\\/")
    return (template()
            .replace("__REPO__", html.escape(data["repo"]))
            .replace("__REPOPATH__", html.escape(data.get("repo_path", data["repo"])))
            .replace("__GENERATED__", html.escape(data["generated"]))
            .replace("__DATA__", payload))


# --------------------------------------------------------------------- command

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-o", "--out", default="keymap-ui.html", help="output HTML file")
    ap.add_argument("--json", action="store_true", help="print the data as JSON instead")
    ap.add_argument("--open", action="store_true", dest="open_it",
                    help="open the result in your default browser when it is written")
    ap.add_argument("--all", action="store_true",
                    help="include every in-tree ZMK board/shield keymap, not just yours")
    ap.add_argument("--include", action="append", default=[], metavar="NAME",
                    help="also include this in-tree board/shield (repeatable)")
    ap.add_argument("--zmk", default=".zmk", help="path to the ZMK CLI cache")
    ap.add_argument("--root", action="append", default=[], metavar="DIR",
                    help="extra directory to search for layouts")
    keypos.add_repo_argument(ap)
    args = ap.parse_args()

    args.out = os.path.abspath(args.out)
    repo, how = keypos.find_config_repo(args.repo)
    os.chdir(repo)

    data = keymap.collect_data(args)
    data["repo_path"] = repo
    data["repo_found_via"] = how
    if not data["keymaps"]:
        print("no keymaps found (looked in config/, variants/, and the ZMK cache)",
              file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(data, indent=2))
        return 0

    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(build_html(data))
    n = len(data["keymaps"])
    kinds = {}
    for k in data["keymaps"]:
        kinds[k["kind"]] = kinds.get(k["kind"], 0) + 1
    detail = ", ".join(f"{v} {k}" for k, v in sorted(kinds.items()))
    print(f"# repo: {repo}  (found via {how})")
    print(f"wrote {args.out}  ({n} keymap(s): {detail})")
    if args.open_it:
        # `webbrowser` picks the desktop's default handler - xdg-open on Linux,
        # `open` on macOS - so this is not tied to any one browser.
        import webbrowser
        webbrowser.open(f"file://{args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
