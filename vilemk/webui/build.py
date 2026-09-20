"""Fill `template.html` with one keymap payload, and write it out.

The page is plain HTML, CSS and JavaScript on disk, not Python strings: it is
edited, linted and diffed as what it is. `template.html` is the shell (head,
body markup, the six placeholders) and `page/` holds the sixteen files its
`<!--#include name-->` directives pull in, concatenated into the page's one
<style> and its one <script>.

This module is the only seam between that and the data. Two passes, in order:
expand the includes, then substitute the six placeholders. No template engine
beyond those twelve lines, and no bundler - the output has to be one
self-contained file (see `_data_uri()`), so the parts cannot be separate files
at runtime in either emitter.

Everything is read from disk on every call, so editing `template.html` or any
part shows up on the next page load without restarting the server.

The include list in `template.html` is the concatenation order, and the parts
are one classic script sharing one scope. Top-level `const` does not hoist, so
reordering that list is the one edit that breaks the page silently. See
`docs/ui-split.md`.

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
import base64
import html
import json
import os
import re
import sys

from .. import keymap, keypos

_HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS_DIR = os.path.join(_HERE, "assets")
PAGE_DIR = os.path.join(_HERE, "page")
TEMPLATE_PATH = os.path.join(_HERE, "template.html")

# `<!--#include name.css-->` on a line of its own, inside the page's one <style>
# or its one <script>. The name pattern has no "/" in it, so a directive cannot
# climb out of `page/`.
INCLUDE_RE = re.compile(r"^[ \t]*<!--#include ([\w.-]+)-->[ \t]*\r?\n", re.M)


def _part(match: "re.Match") -> str:
    """One `page/` file, under a banner naming it.

    `/* name */` is a comment in CSS and in JavaScript both, which is what lets
    the same directive work in either block - and what makes a line in an error
    trace findable again, since the assembled document matches no file on disk.
    """
    name = match.group(1)
    with open(os.path.join(PAGE_DIR, name), encoding="utf-8") as fh:
        return "/* %s */\n%s" % (name, fh.read())


def template() -> str:
    """The raw page, includes expanded, placeholders unfilled."""
    with open(TEMPLATE_PATH, encoding="utf-8") as fh:
        return INCLUDE_RE.sub(_part, fh.read())


def _data_uri(asset_name: str) -> str:
    """A small PNG under `assets/`, as a `data:` URI.

    The page is emitted as one self-contained HTML file with no static-file
    route (see `server.Handler.do_GET`), so an `<img src="assets/logo.png">`
    would 404 the moment the page is served live or copied away from the
    repo. Inlining keeps the *output* self-contained without putting the
    base64 itself in `template.html`, which is edited and diffed as HTML.
    """
    with open(os.path.join(ASSETS_DIR, asset_name), "rb") as fh:
        encoded = base64.b64encode(fh.read()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def build_html(data: dict) -> str:
    payload = json.dumps(data, separators=(",", ":")).replace("</", "<\\/")
    return (template()
            .replace("__FAVICON__", _data_uri("favicon.png"))
            .replace("__LOGO__", _data_uri("logo.png"))
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
