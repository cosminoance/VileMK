"""A local backend for the keymap UI, so the page can save what you design.

The viewer on its own is a static file and a static file cannot write to disk.
This adds the smallest possible server that lets it: `http.server` from the
standard library, bound to loopback, with a handful of JSON endpoints over the
`custom/` store. No dependencies, no build step, nothing listening off-machine.

    python3 -m vilemk.webui.server            # http://127.0.0.1:7879
    python3 -m vilemk.webui.server --port 9000 --no-open

Endpoints:
    GET    /...                   the app from `dist/` (see below)
    GET    /api/state             keymaps + custom items + project path + ZMK source
    GET    /api/export?id=        one keymap's text to share (a variant gets its
                                  records manifest; `positions=1` adds a map of
                                  the key positions for layout `layout=N`)
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
                                  `reset: true` adds the settings_reset entries,
                                  `parts` picks the add-on shields)
    DELETE /api/variant/<name>    remove variants/<name>/
    POST   /api/import/inspect    read a shared keymap, report record collisions
                                  and, for a keyboard not added here, the module
                                  its `// zmk-module:` line names
    POST   /api/import            restore its records, then write variants/<name>/
    POST   /api/zmk               fetch ZMK's board data at {url, ref} and pin it
    GET    /api/keyboards         what can be added (catalog entries with a keymap),
                                  the controller boards a shield can sit on, and
                                  the modules in west.yml
    POST   /api/module            fetch a module from GitHub ({url, ref, name}) and
                                  add it to west.yml
    POST   /api/module/<name>     update it: resolve its ref again, refetch, and swap
                                  in only if no variant breaks ({overwrite, sha}
                                  installs a checked commit anyway)
    DELETE /api/module/<name>     drop it from west.yml and .zmk/modules/; `left`
                                  lists files that could not be deleted
    POST   /api/module-name       {module, alias}: the name the page shows for a
                                  module (custom/module-names.json); blank resets
    POST   /api/keyboard          add one ({id, source, controller}); `dry: true`
                                  returns the plan and writes nothing
    DELETE /api/keyboard/<id>     drop its build.yaml entries and config/ files
                                  (`?files=0` keeps the files)
    DELETE /api/vendor/<id>?source=S  take a keyboard out of the project: its
                                  build.yaml entries, config/ files, and its module
                                  once nothing else in build.yaml uses it. 409 with
                                  `variants` while variants build it
    POST   /api/build             start building one variant ({name}); with
                                  `reset` (and `parts`) it rewrites the variant's
                                  build.yaml from those choices first
    POST   /api/build/open        open the variant's firmware folder ({name})
                                  in the system file manager
    GET    /api/build?since=N     the build's state and its log from line N
                                  (`variant=` names whose targets and files to list;
                                  `reset=0|1&parts=<json>` lists the targets those
                                  choices would build)
    DELETE /api/build             cancel the running build
    GET    /api/flash?variant=X   X's firmware files, whether they are fresh, and
                                  the UF2 bootloader drives mounted now (the
                                  flash sheet polls it)
    POST   /api/flash             copy one file onto one drive ({name, file, drive})

The page is the React app under `dist/`, which is not in the repo - `make web`
writes it, and the static route says so when it is missing.
"""

from __future__ import annotations

import argparse
import atexit
import errno
import json
import mimetypes
import os
import posixpath
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

from .. import (PROJECT_DIR, check, custom, firmware, flash, keyboards, keymap,
               keypos, workspace)

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
MAX_IMPORT = 2 << 20

# `mimetypes` reads /etc/mime.types, which varies by machine and has been seen
# to call .js `text/plain`. A module script with the wrong type is refused by
# the browser, so the types the build actually emits are pinned here.
CTYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript",
          ".mjs": "text/javascript", ".css": "text/css; charset=utf-8",
          ".json": "application/json", ".map": "application/json",
          ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp",
          ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2"}

QUIET = False


class Args:
    """The subset of the keymap collector's and checker's options the server needs."""
    def __init__(self):
        self.zmk = ".zmk"
        self.root = []
        self.include = []
        self.all = False
        self.keys = None


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
        self.path, _, query = self.path.split("#", 1)[0].partition("?")
        if self.path == "/api/build":
            return self._build_status(parse_qs(query))
        if self.path == "/api/flash":
            name = (parse_qs(query).get("variant") or [""])[0]
            try:
                files = firmware.firmware_files(name)
            except ValueError as exc:
                return self._send(400, {"error": str(exc)})
            return self._send(200, {"files": files, "drives": flash.drives(),
                                    **firmware.firmware_state(name)})
        if self.path == "/api/keyboards":
            kbs, boards = keyboards.offer(Args().zmk)
            return self._send(200, {"keyboards": kbs, "controllers": boards,
                                    "default_controller": keyboards.DEFAULT_CONTROLLER,
                                    "modules": workspace.modules(Args().zmk),
                                    "module_names": custom.module_names()})
        if self.path == "/api/state":
            data = keymap.collect_data(Args())
            data["custom"] = custom.load_everything()
            for km in data["keymaps"]:
                km["parts"] = _parts(km)
                if km.get("kind") == "variant":
                    try:
                        km["firmware"] = firmware.firmware_state(km["name"])
                    except (ValueError, OSError):
                        pass
            data["repo_path"] = PROJECT_DIR
            data["zmk"] = workspace.zmk_info()
            data["module_names"] = custom.module_names()
            data["build"] = firmware.docker_status()
            # `live` is what makes the write controls render at all.
            data["live"] = True
            return self._send(200, data)
        if self.path == "/api/export":
            return self._export(parse_qs(query))
        parts = self.path.strip("/").split("/")
        if parts and parts[0] == "api":
            return self._send(404, {"error": "not found"})
        return self._static(self.path)

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

    # --------------------------------------------------------------- export
    def _export(self, q):
        """One keymap's text to share. A variant carries the records it uses."""
        kid = (q.get("id") or [""])[0]
        km = next((k for k in keymap.collect_data(Args())["keymaps"]
                   if k["id"] == kid), None)
        if km is None:
            return self._send(404, {"error": f"no keymap with id {kid!r}"})
        try:
            text = open(km["path"], encoding="utf-8").read()
        except OSError as exc:
            return self._send(500, {"error": str(exc)})

        if km["kind"] == "variant":
            store = custom.load_everything()
            text = custom.with_manifest(text, store["viledance"], store["combo"],
                                        store["layer"], store["macro"],
                                        scope=custom.scope_key("variant", km["name"]))
        elif not keypos.KEYBOARD_HINT_RE.search(text) and km.get("keyboard"):
            text = f"// zmk-keyboard: {km['keyboard']}\n" + text
        text = _with_module_line(text)
        text = POSITIONS_RE.sub("", text)
        if (q.get("positions") or ["0"])[0] == "1":
            try:
                n = int((q.get("layout") or ["0"])[0])
            except ValueError:
                n = 0
            layouts = km.get("layouts") or []
            if layouts:
                text = _with_positions(text, layouts[max(0, min(n, len(layouts) - 1))])
        return self._send(200, {"name": km["name"],
                                "filename": os.path.basename(km["path"]),
                                "text": text})

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

        if self.path == "/api/module-name":
            try:
                names = custom.set_module_name(str(rec.get("module") or ""),
                                               str(rec.get("alias") or ""))
            except (ValueError, OSError) as exc:
                return self._send(400, {"error": str(exc)})
            return self._send(200, {"module_names": names})

        if self.path == "/api/import/inspect":
            return self._import_inspect(rec)

        if self.path == "/api/import":
            return self._import(rec)

        if self.path == "/api/zmk":
            return self._zmk(rec)

        if self.path == "/api/keyboard":
            return self._keyboard_add(rec)

        if self.path == "/api/module" or self.path.startswith("/api/module/"):
            return self._module(rec, self.path[len("/api/module/"):])

        if self.path == "/api/build":
            name = str(rec.get("name") or "")
            try:
                text = (firmware.build_yaml(name, Args().zmk, bool(rec["reset"]),
                                            _parts_choice(rec.get("parts")))
                        if "reset" in rec else None)
                firmware.JOB.start(name, yaml_text=text)
            except firmware.Busy as exc:
                return self._send(409, {"error": str(exc)})
            except firmware.NotInstalled as exc:
                return self._send(400, {"error": str(exc), "missing": exc.missing})
            except (firmware.BuildError, ValueError, OSError) as exc:
                return self._send(400, {"error": str(exc)})
            return self._send(202, firmware.JOB.since(0))

        if self.path == "/api/flash":
            try:
                flash.flash(str(rec.get("name") or ""), str(rec.get("file") or ""),
                            str(rec.get("drive") or ""))
            except (flash.FlashError, ValueError, OSError) as exc:
                return self._send(400, {"error": str(exc)})
            return self._send(200, {})

        if self.path == "/api/build/open":
            try:
                firmware.open_folder(str(rec.get("name") or ""))
            except (firmware.BuildError, ValueError, OSError) as exc:
                return self._send(400, {"error": str(exc)})
            return self._send(200, {})

        self._send(404, {"error": "not found"})

    def do_DELETE(self):
        if not self._guard():
            return
        self.path, _, query = self.path.partition("?")
        if self.path == "/api/build":
            return self._send(200, {"cancelled": firmware.JOB.cancel()})
        parts = self.path.strip("/").split("/")
        if len(parts) == 3 and parts[:2] == ["api", "module"]:
            try:
                r = keyboards.remove_module(parts[2], zmk_dir=Args().zmk)
            except workspace.Busy as exc:
                return self._send(409, {"error": str(exc)})
            except (keyboards.KeyboardError, workspace.WorkspaceError) as exc:
                return self._send(400, {"error": str(exc)})
            return self._send(200, r)
        if len(parts) == 3 and parts[:2] == ["api", "vendor"]:
            source = (parse_qs(query).get("source") or ["zmk"])[0]
            try:
                r = keyboards.remove_vendor(parts[2], source, zmk_dir=Args().zmk)
            except keyboards.InUse as exc:
                return self._send(409, {"error": str(exc), "variants": exc.variants})
            except workspace.Busy as exc:
                return self._send(409, {"error": str(exc)})
            except (keyboards.KeyboardError, workspace.WorkspaceError) as exc:
                return self._send(400, {"error": str(exc)})
            return self._send(200, r)
        if len(parts) == 3 and parts[:2] == ["api", "keyboard"]:
            files = (parse_qs(query).get("files") or ["1"])[0] != "0"
            try:
                r = keyboards.remove(parts[2], files=files, zmk_dir=Args().zmk)
            except keyboards.KeyboardError as exc:
                return self._send(400, {"error": str(exc)})
            return self._send(200, r)
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
        data = keymap.collect_data(Args())
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
                zmk_dir=Args().zmk, reset=bool(rec.get("reset")),
                parts=_parts_choice(rec.get("parts")))
        except (custom.EmitError, ValueError) as exc:
            return self._send(400, {"error": str(exc)})
        return self._send(200, {"wrote": _rel(path),
                                "build": _rel(build_path),
                                "folder": _rel(os.path.dirname(path)),
                                "warnings": errors + notes,
                                "custom": custom.load_everything()})

    # ------------------------------------------------------------------ zmk
    def _zmk(self, rec):
        """Resolve ZMK's ref, fetch its board data and pin the commit in west.yml.

        Blocks for the download (a few seconds); the server is threaded, and a
        second fetch while one runs is a 409.
        """
        try:
            r = workspace.install_zmk(str(rec.get("url") or ""), str(rec.get("ref") or ""))
        except workspace.Busy as exc:
            return self._send(409, {"error": str(exc)})
        except workspace.WorkspaceError as exc:
            return self._send(400, {"error": str(exc)})
        return self._send(200, {"was": r["was"], "files": r["files"],
                                "zmk": workspace.zmk_info()})

    # --------------------------------------------------------------- module
    def _module(self, rec, name):
        """Add a module from GitHub, or update one by name. Blocks for the
        download, like `_zmk`. `keyboards` counts what the module offers, so the
        page can say when it has none VileMK can add."""
        try:
            if name:
                # `overwrite` installs the commit a failed check named, unchecked.
                sha = str(rec.get("sha") or "") if rec.get("overwrite") else ""
                r = workspace.install_module(
                    name, Args().zmk, sha=sha,
                    check=None if sha else keyboards.update_check(name, Args().zmk))
            else:
                r = workspace.add_module(str(rec.get("url") or ""),
                                         str(rec.get("ref") or ""),
                                         str(rec.get("name") or ""), Args().zmk)
        except workspace.Busy as exc:
            return self._send(409, {"error": str(exc)})
        except workspace.CheckFailed as exc:
            return self._send(200, {"name": name, "updated": False,
                                    "problems": exc.problems, "sha": exc.sha})
        except workspace.WorkspaceError as exc:
            return self._send(400, {"error": str(exc)})
        r["updated"] = True
        kbs, _ = keyboards.offer(Args().zmk)
        r["keyboards"] = sum(1 for k in kbs if k["source"] == r["name"])
        return self._send(200, r)

    # ------------------------------------------------------------- keyboard
    def _keyboard_add(self, rec):
        """Copy a keyboard's keymap into config/ and append its build.yaml entries."""
        args = (str(rec.get("id") or ""), str(rec.get("source") or ""),
                str(rec.get("controller") or ""))
        try:
            if rec.get("dry"):
                p = keyboards.plan(*args, zmk_dir=Args().zmk)
                p.pop("_copies", None)
            else:
                p = keyboards.add(*args, zmk_dir=Args().zmk)
        except keyboards.KeyboardError as exc:
            return self._send(400, {"error": str(exc)})
        except OSError as exc:
            return self._send(500, {"error": str(exc)})
        return self._send(200, p)

    # ---------------------------------------------------------------- build
    def _build_status(self, q):
        """The job, plus what `variant` would build and has built.

        The page polls this once a second while a build runs. `variant` is the
        one the sheet is open for, which need not be the one running.
        """
        try:
            since = int((q.get("since") or ["0"])[0])
        except ValueError:
            since = 0
        out = firmware.JOB.since(since)
        name = (q.get("variant") or [""])[0]
        if name:
            try:
                text = None
                if "reset" in q:
                    parts = json.loads((q.get("parts") or ["null"])[0])
                    text = firmware.build_yaml(name, Args().zmk,
                                               q["reset"][0] == "1", _parts_choice(parts))
                out["targets"] = [t["artifact"] for t in
                                  firmware.targets(name, text, Args().zmk)]
            except (firmware.BuildError, ValueError) as exc:
                out["targets"], out["problem"] = [], str(exc)
                out["missing"] = getattr(exc, "missing", [])
            out["files"] = firmware.firmware_files(name)
            out["folder"] = _rel(firmware.firmware_dir(name))
            out["path"] = os.path.abspath(firmware.firmware_dir(name))
            out["docker"] = firmware.docker_status()
        return self._send(200, out)

    # --------------------------------------------------------------- import
    def _import_inspect(self, rec):
        """What importing this file would mean, before anything is written."""
        text = rec.get("text") or ""
        if len(text) > MAX_IMPORT:
            return self._send(400, {"error": "that file is too big to be a keymap"})
        board, known = _resolve_board(text, rec.get("filename") or "")
        stem = os.path.splitext(os.path.basename(rec.get("filename") or ""))[0]
        suggested = custom.slug(stem or board or "imported") or "imported"
        return self._send(200, {
            "board": board, "known": known,
            "module": None if known else _wanted_module(text),
            "name": suggested,
            "taken": os.path.isdir(custom.variant_dir(suggested))
                     if custom.NAME_RE.match(suggested) else False,
            "records": _incoming(text),
        })

    def _import(self, rec):
        """Restore the file's records, then write it as variants/<name>/.

        Records first: a run that wrote the keymap and not the records would
        leave bindings naming behaviors nothing can regenerate.
        """
        text = rec.get("text") or ""
        if len(text) > MAX_IMPORT:
            return self._send(400, {"error": "that file is too big to be a keymap"})
        name = rec.get("name") or ""
        try:
            name = custom.variant_slug(name)
        except ValueError as exc:
            return self._send(400, {"error": str(exc)})

        board, known = _resolve_board(text, rec.get("filename") or "")
        if not known:
            return self._send(400, {"error":
                f"this keymap is for {board or 'an unknown keyboard'}, which is not "
                f"added to this project. Add it first - without its physical layout "
                f"there is nothing to import into."})

        plan, scope_on, errors = _import_plan(
            _incoming(text), rec.get("choices") or {}, rec.get("renames") or {})
        if errors:
            return self._send(400, {"error": "; ".join(errors)})

        renamed = [(kind, was, r["name"]) for kind, r, was in plan if was]
        for kind, r, _was in plan:
            for tk, was, now in renamed:
                r.update(custom.rename_in_record(r, kind, tk, was, now))
            try:
                EMIT[kind](r)
            except (custom.EmitError, ValueError) as exc:
                return self._send(400, {"error": f"{kind} {r.get('name')}: {exc}"})

        scope = custom.scope_key("variant", name)
        try:
            for kind, r, _was in plan:
                custom.save(kind, dict(r))
            _scope_on(scope, scope_on)
        except (ValueError, OSError) as exc:
            return self._send(400, {"error": str(exc)})

        out = custom.strip_block(text)
        for kind, was, now in renamed:
            out = custom.rename_refs(out, kind, was, now)
        if not out.lstrip().startswith("// zmk-keyboard"):
            out = f"// zmk-keyboard: {board}\n" + out

        store = custom.load_everything()
        try:
            out, notes = custom.build_variant(
                out, [], {}, store["viledance"], store["combo"], store["layer"],
                macros=store["macro"], scope=scope)
            path, build_path, more = custom.write_variant(
                name, out, keyboard=board, zmk_dir=Args().zmk,
                reset=bool(rec.get("reset")))
        except (custom.EmitError, ValueError) as exc:
            return self._send(400, {"error": str(exc)})

        km, _combos, stopped = check.check_text(path, out, Args())
        return self._send(200, {
            "wrote": _rel(path), "build": _rel(build_path),
            "folder": _rel(os.path.dirname(path)),
            "saved": [f"{k}/{r['name']}" for k, r, _w in plan],
            "renamed": [f"{k} {was} -> {now}" for k, was, now in renamed],
            "warnings": notes + more + km.rep.warnings,
            "errors": km.rep.errors + ([f"checks stopped: {stopped}"] if stopped else []),
            "custom": store})


# --------------------------------------------------------------------- import
# A shared `.keymap` carries its own records in the manifest comment
# `build_variant()` writes (see custom.RECORDS_MARK). Restoring them is part of
# importing: without them the first re-save strips the behaviors out from under
# the bindings that still name them.

def _resolve_board(text: str, filename: str):
    """-> (board name, is it added here).

    A `// zmk-keyboard:` line is taken as the whole answer. Falling back to the
    filename after that would let a keymap declaring a board nobody has import
    anyway, on a stem that happens to appear in some other keyboard's path.
    """
    names = []
    m = keypos.KEYBOARD_HINT_RE.search(text or "")
    if m:
        names.append(m.group(1))
    stem = os.path.splitext(os.path.basename(filename or ""))[0]
    if stem and not names:
        names.append(stem)
        for sep in ("-", "."):
            while sep in names[-1]:
                names.append(names[-1].rsplit(sep, 1)[0])

    args = Args()
    roots = keypos.search_roots(args.root, args.zmk)
    layouts, transforms, chosen = keypos.collect(roots)
    for n in names:
        ls, ts = keypos.candidates_for(n, roots, layouts, transforms, chosen)
        if ls or ts:
            return n, True
    return (names[0] if names else ""), False


# The recipient of a shared keymap may not have its keyboard. The layout comes
# from a module in config/west.yml, so export names that module and import tells
# the recipient which one to add. A board built into ZMK or defined in config/
# gets no line: the first every project has, the second nobody else can fetch.
MODULE_HINT_RE = re.compile(r"(?im)^\s*//\s*zmk-module\s*:\s*(\S+)[ \t]+(\S+)(?:[ \t]+(\S+))?")


def _board_module(board: str):
    """{name, url, ref} of the west.yml module `board`'s layout is in, or None."""
    if not board:
        return None
    args = Args()
    roots = keypos.search_roots(args.root, args.zmk)
    layouts, transforms, chosen = keypos.collect(roots)
    ls, ts = keypos.candidates_for(board, roots, layouts, transforms, chosen)
    mods = os.path.realpath(os.path.join(args.zmk, "modules"))
    for obj in ls + ts:
        src = os.path.realpath(obj.source)
        if not src.startswith(mods + os.sep):
            continue
        name = os.path.relpath(src, mods).split(os.sep)[0]
        try:
            data = workspace.west_yml_read()
        except (workspace.WorkspaceError, OSError):
            data = None
        if data and workspace.project(data, name) is not None:
            info = workspace.project_info(data, name)
            return {"name": name, "url": info["url"], "ref": info["ref"]}
        return {"name": name, "url": "", "ref": ""}
    return None


POSITIONS_RE = re.compile(r"(?m)^// key positions \(.*\n(?://.*\n)*?// end key positions\n")


def _with_positions(text: str, lay: dict) -> str:
    """`text` with a comment drawing `lay`'s key positions, under the header lines."""
    layout = keypos.Layout(lay["label"], lay.get("display") or "", lay.get("source") or "",
                           [tuple(k) for k in lay["keys"]])
    art = keypos.render_layout(layout)
    block = (f"// key positions ({lay.get('display') or lay['label']}, {layout.count} keys)\n"
             + "".join(f"//  {line}".rstrip() + "\n" for line in art.splitlines())
             + "// end key positions\n")
    lines = text.splitlines(keepends=True)
    at = 0
    while at < len(lines) and lines[at].startswith("//"):
        at += 1
    return "".join(lines[:at]) + block + "".join(lines[at:])


def _with_module_line(text: str) -> str:
    """`text` with `// zmk-module: <name> <url> <ref>` under its keyboard line."""
    if MODULE_HINT_RE.search(text):
        return text
    m = keypos.KEYBOARD_HINT_RE.search(text)
    mod = _board_module(m.group(1)) if m else None
    if not mod or not mod["url"]:
        return text
    line = f"// zmk-module: {mod['name']} {mod['url']} {mod['ref']}".rstrip() + "\n"
    at = text.find("\n", m.end())
    at = len(text) if at == -1 else at + 1
    return text[:at] + line + text[at:]


def _wanted_module(text: str):
    """What the file says its keyboard needs, against this project's west.yml."""
    m = MODULE_HINT_RE.search(text or "")
    if not m or not workspace.NAME_RE.match(m.group(1)) or m.group(1) == "zmk":
        return None
    name, url, ref = m.group(1), m.group(2), m.group(3) or ""
    if not url.startswith("https://"):
        return None
    try:
        listed = workspace.project(workspace.west_yml_read(), name) is not None
    except (workspace.WorkspaceError, OSError):
        listed = False
    fetched = os.path.isdir(os.path.join(Args().zmk, "modules", name))
    return {"name": name, "url": url, "ref": ref, "listed": listed, "fetched": fetched}


def _incoming(text: str):
    """Each record the file carries, against what is already in the store."""
    manifest = custom.read_manifest(text)
    store = custom.load_everything()
    local = {(kind, custom.slug(r.get("name", ""))): r
             for kind, recs in store.items() for r in recs}
    rows = []
    for kind in ("viledance", "macro", "layer", "combo"):
        for rec in manifest[kind]:
            name = custom.slug(rec.get("name", ""))
            cur = local.get((kind, name))
            if cur is None:
                status = "new"
            elif custom.portable(cur) == custom.portable(rec):
                status = "same"
            else:
                status = "clash"
            rows.append({"kind": kind, "name": name, "status": status,
                         "incoming": custom.portable(rec),
                         "local": custom.portable(cur) if cur else None})
    return rows


def _board_wide(kind: str, rec: dict) -> bool:
    return kind == "combo" or (kind == "layer"
                               and (rec.get("mode") or "lt") == "conditional")


def _import_plan(rows, choices, renames):
    """-> (plan, scope_on, errors). `plan` is [(kind, record, renamed from or "")]."""
    existing = {(k, custom.slug(r.get("name", "")))
                for k, recs in custom.load_everything().items() for r in recs}
    plan, scope_on, errors = [], [], []
    for row in rows:
        kind, name, key = row["kind"], row["name"], f"{row['kind']}:{row['name']}"
        final = name
        if row["status"] == "clash":
            choice = choices.get(key)
            if choice == "drop":
                pass
            elif choice == "rename":
                final = custom.slug(renames.get(key) or (name + "_2"))
                if not custom.NAME_RE.match(final or ""):
                    errors.append(f"{kind} {name}: {final!r} is not a valid name")
                elif (kind, final) in existing:
                    errors.append(f"{kind} {name}: {final} is taken too")
                else:
                    existing.add((kind, final))
                    plan.append((kind, {**row["incoming"], "name": final}, name))
            else:
                errors.append(f"{kind} {name} exists here and differs - "
                              f"rename it or drop it")
        elif row["status"] == "new":
            existing.add((kind, name))
            plan.append((kind, row["incoming"], ""))
        if _board_wide(kind, row["incoming"]):
            scope_on.append((kind, final))
    return plan, scope_on, errors


def _rel(path: str) -> str:
    """Paths go back to the page relative to the VileMK checkout, never absolute
    - the page prints them, and an absolute path is noise plus a small leak."""
    return os.path.relpath(path, custom.PROJECT_DIR) if path else ""


def _parts(km) -> list:
    """The add-on shields the variant bar offers for this keymap's keyboard,
    ticked from the variant's own build.yaml when it has one."""
    if not km.get("keyboard"):
        return []
    own = (os.path.join(os.path.dirname(km["path"]), "build.yaml")
           if km["kind"] == "variant" else "")
    return custom.parts_for(km["keyboard"], Args().zmk, own)


def _parts_choice(raw):
    """`{part_id: bool}` from the page, or None to keep the source shields."""
    if not isinstance(raw, dict):
        return None
    return {str(k): bool(v) for k, v in raw.items()}


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


def _scope_on(scope: str, wanted) -> None:
    """Switch named board-wide records on for one scope.

    An imported file carries its combos and conditional layers in the manifest
    because they were written into it, so they belong to the variant being
    written here whether the record was restored, renamed or already local.
    """
    want = {(k, custom.slug(n)) for k, n in wanted}
    for kind, rec in _scoped_records():
        if (kind, custom.slug(rec.get("name", ""))) not in want:
            continue
        scopes = rec.get("scopes") or {}
        if scopes.get(scope):
            continue
        scopes[scope] = True
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
    global QUIET
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=PORT,
                    help=f"default {PORT}; only change it if that one is taken")
    ap.add_argument("--host", default="127.0.0.1",
                    help="loopback by default; changing this exposes a write API")
    ap.add_argument("--no-open", action="store_true", help="do not launch a browser")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    QUIET = args.quiet
    os.chdir(PROJECT_DIR)
    # `docker run` outlives its client, so a build must not outlive the server.
    atexit.register(firmware.JOB.cancel)
    print(f"# project: {PROJECT_DIR}")
    print(f"# store: {custom.CUSTOM_DIR}")
    return run(args.host, args.port, open_browser=not args.no_open)


if __name__ == "__main__":
    sys.exit(main())
