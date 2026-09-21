"""A local backend for the keymap UI, so the page can save what you design.

The viewer on its own is a static file and a static file cannot write to disk.
This adds the smallest possible server that lets it: `http.server` from the
standard library, bound to loopback, with a handful of JSON endpoints over the
`custom/` store. No dependencies, no build step, nothing listening off-machine.

    python3 -m vilemk.webui.server            # http://127.0.0.1:7879
    python3 -m vilemk.webui.server --port 9000 --no-open

Endpoints:
    GET    /                      the viewer, regenerated on every load
    GET    /app/...               the React app from `dist/` (see below)
    GET    /api/state             keymaps + custom items + repo info
    POST   /api/viledance         save one (JSON body, `name` required)
    POST   /api/macro             save one (a list of steps)
    POST   /api/combo             save one
    POST   /api/modifier          save one
    POST   /api/layer             save one (momentary / layer-tap / conditional)
    DELETE /api/viledance/<name>  remove one
    DELETE /api/macro/<name>      remove one
    DELETE /api/combo/<name>      remove one
    DELETE /api/modifier/<name>   remove one
    DELETE /api/layer/<name>      remove one
    POST   /api/preview           devicetree for an unsaved item
    POST   /api/variant           write variants/<name>/ (keymap + build.yaml;
                                  `reset: true` adds the settings_reset entries)
    DELETE /api/variant/<name>    remove variants/<name>/

`/` and `/app/` are two front ends over the same endpoints while the React
port is in progress (docs/react-migration.md). `/` is the string-rendered page
`build.py` generates; `/app/` is the built React app under `dist/`, which is
not in the repo - `make web` writes it. When the port lands, `/app/` becomes
`/` and everything behind the first route goes away.
"""

from __future__ import annotations

import argparse
import errno
import json
import mimetypes
import os
import posixpath
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .. import custom, keymap, keypos
from .build import build_html

EMIT = {"viledance": custom.emit_viledance, "combo": custom.emit_combo,
        "modifier": custom.emit_modifier, "layer": custom.emit_layer,
        "macro": custom.emit_macro}

PORT = 7879          # fixed, so the page is always at the same address

# Where `npm run build` in web/ puts its output. Unlike `page/`, this is not in
# the repo and not in a fresh clone: it is generated, `.gitignore`'s bare
# `dist/` matches it at any depth, and `make web` is what creates it. Missing
# is therefore an ordinary state with an ordinary answer, not an error to
# swallow - `_static()` says which command fixes it.
DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")
APP = "/app"         # served under a prefix so the old page keeps `/`

# `mimetypes` reads /etc/mime.types, which varies by machine and has been seen
# to call .js `text/plain`. A module script with the wrong type is refused by
# the browser, so the types the build actually emits are pinned here.
CTYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript",
          ".mjs": "text/javascript", ".css": "text/css; charset=utf-8",
          ".json": "application/json", ".map": "application/json",
          ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp",
          ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2"}

REPO, HOW, QUIET = ".", "", False


class Args:
    """The subset of the keymap collector's options the server needs."""
    def __init__(self, repo=None):
        self.zmk = ".zmk"
        self.root = []
        self.include = []
        self.all = False
        self.repo = repo


def page(args) -> bytes:
    data = keymap.collect_data(args)
    data["repo_path"] = REPO
    data["repo_found_via"] = HOW
    data["live"] = True
    data["custom"] = custom.load_everything()
    return build_html(data).encode("utf-8")
class Handler(BaseHTTPRequestHandler):
    server_version = "vilemk"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------- plumbing
    def log_message(self, fmt, *a):
        if not QUIET:
            sys.stderr.write("  %s %s\n" % (self.command, self.path))

    def _guard(self) -> bool:
        """Refuse requests that did not come from this machine by name.

        Loopback binding already keeps other hosts out; this also blocks a
        malicious page in your browser from reaching the server through a
        rebound DNS name.
        """
        host = (self.headers.get("Host") or "").split(":")[0]
        if host in ("127.0.0.1", "localhost", "[::1]", "::1", ""):
            return True
        self._send(403, {"error": f"refusing request for host {host!r}"})
        return False

    def _send(self, code, obj=None, body=None, ctype="application/json",
              cache="no-store"):
        if body is None:
            body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    # ---------------------------------------------------------------- verbs
    def do_GET(self):
        if not self._guard():
            return
        if self.path in ("/", "/index.html"):
            try:
                return self._send(200, body=page(Args(REPO)), ctype="text/html; charset=utf-8")
            except Exception as exc:  # noqa: BLE001 - show it in the browser
                return self._send(500, body=f"<pre>{exc}</pre>".encode(),
                                  ctype="text/html; charset=utf-8")
        if self.path == APP or self.path.startswith(APP + "/"):
            return self._static(self.path[len(APP):])
        if self.path == "/api/state":
            data = keymap.collect_data(Args(REPO))
            data["custom"] = custom.load_everything()
            data["repo_path"] = REPO
            # `page()` sets these three on the baked payload; the React app
            # reads the same fields over the wire, so send them here too.
            # `live` is what makes the write controls render at all.
            data["repo_found_via"] = HOW
            data["live"] = True
            return self._send(200, data)
        self._send(404, {"error": "not found"})

    # --------------------------------------------------------------- the app
    def _static(self, rel: str):
        """Serve `dist/` under /app, with an SPA fallback to index.html.

        Three cases, in order: the file exists and is served; the request has
        no file extension, so it is a client-side route and gets index.html;
        anything else is a genuine 404 (a missing asset must not come back as
        HTML, or the browser reports a syntax error in a script instead of a
        missing one).
        """
        index = os.path.join(DIST, "index.html")
        if not os.path.isfile(index):
            return self._send(503, cache="no-store", ctype="text/html; charset=utf-8",
                              body=b"<!doctype html><meta charset=utf-8>"
                                   b"<title>VileMK</title>"
                                   b"<style>body{font:14px/1.6 system-ui;margin:3rem auto;"
                                   b"max-width:34rem}code{background:#eee;padding:2px 5px}"
                                   b"</style><h1>The app is not built yet</h1>"
                                   b"<p>This page is compiled from <code>web/</code> into "
                                   b"<code>vilemk/webui/dist/</code>, which is not in the "
                                   b"repository. Build it once:</p>"
                                   b"<pre><code>make web</code></pre>"
                                   b"<p>It needs Node. The old page is still at "
                                   b"<a href=\"/\">/</a>.</p>")

        # posixpath, not os.path: the URL is always "/" separated, whatever the
        # platform. normpath collapses "..", and the prefix check below is what
        # actually refuses to leave dist/ - do not drop it.
        clean = posixpath.normpath(posixpath.join("/", rel)).lstrip("/")
        path = os.path.normpath(os.path.join(DIST, *clean.split("/"))) if clean else index
        if os.path.commonpath([os.path.realpath(path), os.path.realpath(DIST)]) \
                != os.path.realpath(DIST):
            return self._send(403, {"error": "outside dist"})

        if not os.path.isfile(path):
            if os.path.splitext(clean)[1]:
                return self._send(404, {"error": "not found"})
            path = index                       # a client-side route

        try:
            with open(path, "rb") as fh:
                body = fh.read()
        except OSError as exc:
            return self._send(500, {"error": str(exc)})

        ext = os.path.splitext(path)[1].lower()
        ctype = CTYPES.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream"
        # Vite fingerprints everything under assets/, so those are immutable and
        # index.html must never be cached or a rebuild keeps serving old script
        # tags.
        cache = ("public, max-age=31536000, immutable"
                 if clean.startswith("assets/") else "no-store")
        self._send(200, body=body, ctype=ctype, cache=cache)

    def do_POST(self):
        if not self._guard():
            return
        try:
            rec = self._body()
        except ValueError as exc:
            return self._send(400, {"error": f"bad JSON: {exc}"})

        if self.path in ("/api/viledance", "/api/macro", "/api/combo",
                         "/api/modifier", "/api/layer"):
            kind = self.path.rsplit("/", 1)[1]
            try:
                EMIT[kind](rec)                    # validate before writing
                path = custom.save(kind, rec)
            except (custom.EmitError, ValueError) as exc:
                return self._send(400, {"error": str(exc)})
            return self._send(200, {"saved": os.path.relpath(path, custom.PROJECT_DIR),
                                    "custom": custom.load_everything()})

        if self.path == "/api/preview":
            binding = None
            try:
                kind = rec.get("kind")
                if kind == "combo":
                    dts = custom.emit_combo(rec)
                else:
                    nodes, binding = EMIT[kind if kind in EMIT else "viledance"](rec)
                    # A conditional layer has no binding - it goes on no key.
                    dts = (nodes or "") + (f"\n// on the key:  {binding}\n"
                                           if binding else "")
            except custom.EmitError as exc:
                return self._send(400, {"error": str(exc)})
            return self._send(200, {"dts": dts, "binding": binding})

        if self.path == "/api/variant":
            return self._variant(rec)

        self._send(404, {"error": "not found"})

    def do_DELETE(self):
        if not self._guard():
            return
        parts = self.path.strip("/").split("/")
        if len(parts) == 3 and parts[0] == "api" and parts[1] == "variant":
            try:
                gone = custom.delete_variant(parts[2])
            except ValueError as exc:
                return self._send(400, {"error": str(exc)})
            # The variant is gone, so every combo / conditional layer switched on
            # for it is pointing at a file that no longer exists. Drop the flag
            # rather than leaving a scope key nothing will ever match again.
            if gone:
                _forget_scope(custom.scope_key("variant", parts[2]))
            return self._send(200 if gone else 404,
                              {"deleted": gone, "custom": custom.load_everything()})
        if len(parts) == 3 and parts[0] == "api" and parts[1] in custom.DIRS:
            gone = custom.delete(parts[1], parts[2])
            return self._send(200 if gone else 404,
                              {"deleted": gone, "custom": custom.load_everything()})
        self._send(404, {"error": "not found"})

    # -------------------------------------------------------------- variant
    def _variant(self, rec):
        """Write variants/<name>/ from a base keymap + key assignments.

        The folder is the deliverable: the keymap, and the one `build.yaml`
        that builds it on this keyboard and nothing else (see ui-server.md,
        "The variant folder").
        """
        name = rec.get("name") or ""
        base_id = rec.get("base")
        # Which board-wide switches apply. The page toggles them under whatever
        # keymap is on screen; the file being written is `variant:<name>`, which
        # is a different scope whenever a variant is created from a config
        # keymap. Carrying the flags over is what makes "save as new variant"
        # keep the combos you just switched on (see ui-server.md, "Scopes").
        scope = custom.scope_key("variant", name)
        if not custom.NAME_RE.match(scope.split(":", 1)[1] or ""):
            return self._send(400, {"error": "variant name must be letters, digits"
                                             " and underscores"})
        _carry_scope(rec.get("scope") or "", scope)
        assignments = {int(k): {int(p): v for p, v in d.items()}
                       for k, d in (rec.get("assignments") or {}).items()}
        new_layers = [{"name": nl.get("name") or ""}
                      for nl in (rec.get("new_layers") or [])]
        data = keymap.collect_data(Args(REPO))
        km = next((k for k in data["keymaps"] if k["id"] == base_id), None)
        if km is None:
            return self._send(400, {"error": f"no keymap with id {base_id!r}"})
        try:
            base_text = open(km["path"], encoding="utf-8").read()
        except OSError as exc:
            return self._send(400, {"error": str(exc)})

        store = custom.load_everything()
        expanded = [lay["bindings"] for lay in km["layers"]]
        try:
            layouts = km.get("layouts") or []
            rows = custom.row_sizes(layouts[0]["keys"]) if layouts else None
            if new_layers:
                key_count = (len(expanded[0]) if expanded
                            else (layouts[0]["count"] if layouts else 0))
                expanded += [["&trans"] * key_count for _ in new_layers]
            text, errors = custom.build_variant(
                base_text, expanded, assignments,
                store["viledance"], store["combo"], store["layer"],
                macros=store["macro"], rows=rows,
                new_layers=new_layers, scope=scope)
            header = (f"// zmk-keyboard: {km.get('keyboard') or ''}\n"
                      f"// variant of {km['path']} - written by VileMK\n")
            if not text.lstrip().startswith("// zmk-keyboard"):
                text = header + text
            path, build_path, notes = custom.write_variant(
                name, text, keyboard=km.get("keyboard") or "",
                zmk_dir=Args(REPO).zmk, reset=bool(rec.get("reset")))
        except (custom.EmitError, ValueError) as exc:
            return self._send(400, {"error": str(exc)})
        return self._send(200, {"wrote": _rel(path),
                                "build": _rel(build_path),
                                "folder": _rel(os.path.dirname(path)),
                                "warnings": errors + notes,
                                "custom": custom.load_everything()})


def _rel(path: str) -> str:
    """Paths go back to the page relative to the VileMK checkout, never absolute
    - the page prints them, and an absolute path is noise plus a small leak."""
    return os.path.relpath(path, custom.PROJECT_DIR) if path else ""


# ------------------------------------------------------------------- scopes
# Board-wide records (combos, conditional layers) carry `scopes`, a
# `{scope_key: true}` map saying which keymap files get them. Both helpers below
# rewrite that map across the whole store; each writes only the records that
# actually change, so a no-op costs no files.

def _scoped_records():
    store = custom.load_everything()
    for kind in ("combo", "layer"):
        for rec in store[kind]:
            if rec.get("broken"):
                continue
            if kind == "layer" and (rec.get("mode") or "lt") != "conditional":
                continue          # a layer-tap is pulled in by the key that uses it
            yield kind, rec


def _carry_scope(src: str, dst: str) -> None:
    """Copy every on/off flag from one scope key to another."""
    if not src or not dst or src == dst:
        return
    for kind, rec in _scoped_records():
        scopes = rec.get("scopes") or {}
        on = bool(scopes.get(src))
        if bool(scopes.get(dst)) == on:
            continue
        scopes[dst] = on
        rec["scopes"] = scopes
        custom.save(kind, rec)


def _forget_scope(scope: str) -> None:
    """Drop a scope key everywhere - the file it named is gone."""
    for kind, rec in _scoped_records():
        if scope in (rec.get("scopes") or {}):
            del rec["scopes"][scope]
            custom.save(kind, rec)




# --------------------------------------------------------------------- serve

def run(host: str = "127.0.0.1", port: int = PORT, open_browser: bool = True) -> int:
    """Bind and serve until ctrl-c. Returns the process exit status."""
    try:
        httpd = ThreadingHTTPServer((host, port), Handler)
    except OSError as e:
        if e.errno != errno.EADDRINUSE:
            raise
        print(f"port {port} is already in use - an older server is probably"
              f" still running.\n"
              f"  stop it:  pkill -f 'vilemk.webui.server'\n"
              f"  or:       python3 -m vilemk.webui.server --port {port + 1}",
              file=sys.stderr)
        return 1
    url = f"http://{host}:{port}/"
    print(f"serving {url}  (ctrl-c to stop)")
    if open_browser:
        threading.Timer(0.4, lambda: __import__("webbrowser").open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


# --------------------------------------------------------------------- command

def main() -> int:
    global REPO, HOW, QUIET
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=PORT,
                    help=f"default {PORT}; only change it if that one is taken")
    ap.add_argument("--host", default="127.0.0.1",
                    help="loopback by default; changing this exposes a write API")
    ap.add_argument("--no-open", action="store_true", help="do not launch a browser")
    ap.add_argument("--quiet", action="store_true")
    keypos.add_repo_argument(ap)
    args = ap.parse_args()

    QUIET = args.quiet
    REPO, HOW = keypos.find_config_repo(args.repo)
    os.chdir(REPO)
    print(f"# repo: {REPO}  (found via {HOW})")
    print(f"# store: {custom.CUSTOM_DIR}")
    return run(args.host, args.port, open_browser=not args.no_open)


if __name__ == "__main__":
    sys.exit(main())
