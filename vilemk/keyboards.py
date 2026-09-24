"""Adding and removing keyboards: `build.yaml` entries plus the files in `config/`.

The offer is `workspace.catalog()`: every board or shield in ZMK or an installed
module that ships a `.keymap`. Adding one copies `<id>.conf`, if the vendor
ships one, into `config/` (never over an existing file) and appends one
`build.yaml` entry per half. The keymap stays with the vendor: variants start
from it, and a variant build names its own keymap. A shield also needs the controller it is soldered to, picked from the
boards whose `exposes` cover its `requires`. `west.yml` is not touched: ZMK is
already in it, and so is an installed module.

    python3 -m vilemk.keyboards list [--all]
    python3 -m vilemk.keyboards add <id> [--source S] [--controller BOARD]
    python3 -m vilemk.keyboards remove <id> [--keep-files]

Remove drops the keyboard's entries and its `config/` files (the `.conf`, and a
`.keymap` left there by earlier versions). It does not
uninstall a module, and it leaves variants alone. `remove_module()` uninstalls
one, and refuses while `build.yaml` or a variant still builds its keyboards.
"""

from __future__ import annotations

import argparse
import glob
import os
import re
import sys

from . import PROJECT_DIR, check, custom, keymap, keypos, workspace

CONFIG_DIR = "config"
BUILD_YAML = "build.yaml"
DEFAULT_CONTROLLER = "nice_nano_v2"

BUILD_HEADER = """\
# The keyboards in this project, one entry per half. Written by VileMK when a
# keyboard is added or removed; edit it freely. A variant's own build list
# starts from the entries here for its keyboard.
---
include:
"""


class KeyboardError(Exception):
    """An add or remove that did not happen, with a reason a user can act on."""


def _names(entry: dict) -> set:
    """What a keyboard is called in a build list: its id and each half."""
    return {entry["id"], *entry.get("siblings", [])}


def _build_path() -> str:
    return keymap.find_build_yaml() or BUILD_YAML


def _entries_of(names: set, entries):
    return [e for e in entries if any(n in names for n in [e.board] + e.shields)]


def _config_files(kid: str) -> list:
    return [p for p in (os.path.join(CONFIG_DIR, kid + ".keymap"),
                        os.path.join(CONFIG_DIR, kid + ".conf"))
            if os.path.isfile(p)]


def offer(zmk_dir: str = workspace.ZMK_DIR):
    """-> (keyboards, controllers). A keyboard is a catalog entry with a keymap;
    `added` says whether the build list already builds it."""
    cat = workspace.catalog(zmk_dir)
    path = keymap.find_build_yaml()
    built = keymap.parse_build_yaml(keymap.read_text(path)) if path else []
    boards = []
    for e in cat:
        if e["type"] == "board" and not e["keymap"]:
            boards.append({"id": e["id"], "name": e["name"] or e["id"],
                           "source": e["source"], "exposes": e["exposes"]})
    kbs = []
    for e in cat:
        if e["type"] not in ("board", "shield") or not e["keymap"]:
            continue
        needs = e["requires"] if e["type"] == "shield" else []
        kbs.append({
            "id": e["id"], "name": e["name"] or e["id"], "type": e["type"],
            "source": e["source"], "url": e["url"], "siblings": e["siblings"],
            "requires": e["requires"], "features": e["features"],
            "controllers": [b["id"] for b in boards
                            if e["type"] == "shield"
                            and all(r in b["exposes"] for r in needs)],
            "added": bool(_entries_of(_names(e), built)),
            "files": _config_files(e["id"]),
        })
    kbs.sort(key=lambda k: (k["name"].lower(), k["source"]))
    return kbs, boards


def _find(kid: str, source: str = "", zmk_dir: str = workspace.ZMK_DIR) -> dict:
    hits = [e for e in workspace.catalog(zmk_dir)
            if e["id"] == kid and e["type"] in ("board", "shield") and e["keymap"]
            and (not source or e["source"] == source)]
    if not hits:
        raise KeyboardError(f"no keyboard {kid!r}"
                            + (f" in {source}" if source else "")
                            + " with a keymap in .zmk/")
    if len(hits) > 1:
        raise KeyboardError(f"{kid!r} is in {', '.join(h['source'] for h in hits)}; "
                            f"say which")
    return hits[0]


def _vendor_entries(entry: dict, zmk_dir: str):
    """The module's own plain entries for this keyboard: its build list is how
    the vendor builds it (which halves, which screens, which flags)."""
    if entry["source"] == "zmk":
        return []
    for fn in ("build.yaml", "build.yml"):
        path = os.path.join(zmk_dir, "modules", entry["source"], fn)
        if os.path.isfile(path):
            return [e for e in _entries_of(_names(entry),
                                           keymap.parse_build_yaml(keymap.read_text(path)))
                    if not e.get("snippet") and not e.get("artifact-name")
                    and not any(s in keymap.UTILITY_SHIELDS for s in e.shields)]
    return []


def entries_for(entry: dict, controller: str = "", zmk_dir: str = workspace.ZMK_DIR):
    """-> [{key: value}] the build list gains for `entry`, one per half."""
    halves = entry["siblings"] or [entry["id"]]
    shield = entry["type"] == "shield"
    vendor = _vendor_entries(entry, zmk_dir)
    out = []
    if vendor:
        for v in vendor:
            e = {k: v.get(k) for k in custom.BUILD_YAML_KEYS if v.get(k)}
            if shield:
                e["board"] = controller
            args = custom._without_keymap_file(v.get("cmake-args") or "")
            if args:
                e["cmake-args"] = args
            out.append(e)
    else:
        for h in halves:
            out.append({"board": controller, "shield": h} if shield else {"board": h})
    return out


def _entry_text(e: dict) -> str:
    lines = []
    for k in custom.BUILD_YAML_KEYS + ("cmake-args",):
        if e.get(k):
            lines.append(f"{'  - ' if not lines else '    '}{k}: {e[k]}")
    return "\n".join(lines)


def plan(kid: str, source: str = "", controller: str = "",
         zmk_dir: str = workspace.ZMK_DIR) -> dict:
    """What adding would do, without doing it."""
    entry = _find(kid, source, zmk_dir)
    kbs, _boards = offer(zmk_dir)
    me = next(k for k in kbs if k["id"] == entry["id"] and k["source"] == entry["source"])
    if me["added"]:
        raise KeyboardError(f"{kid} is already in {_build_path()}")
    if entry["type"] == "shield":
        controller = controller or ""
        if controller not in me["controllers"]:
            raise KeyboardError(
                f"{kid} is a shield and needs a controller that exposes "
                f"{', '.join(entry['requires']) or 'its connector'}"
                + (f"; {controller!r} does not" if controller else ""))
    else:
        controller = ""
    entries = entries_for(entry, controller, zmk_dir)
    copies, kept = [], []
    src = os.path.join(entry["dir"], entry["id"] + ".conf")
    if os.path.isfile(src):
        dst = os.path.join(CONFIG_DIR, entry["id"] + ".conf")
        (kept if os.path.exists(dst) else copies).append((src, dst))
    return {"id": entry["id"], "source": entry["source"], "controller": controller,
            "build": _build_path(), "entries": [_entry_text(e) for e in entries],
            "copy": [d for _s, d in copies], "kept": [d for _s, d in kept],
            "_copies": copies}


def _insert_at(text: str) -> int:
    """Where new `include:` items go: the end of that section, before whatever
    top-level key follows it. -1 when the file has no `include:`."""
    lines = text.splitlines(True)
    at, inside = 0, False
    end = -1
    for raw in lines:
        body = keymap._yaml_uncomment(raw).rstrip()
        top = body and not body[0].isspace() and not body.startswith("-")
        if top and inside:
            break
        if top and body.split(":")[0].strip() == "include":
            inside = True
        at += len(raw)
        if inside and body.strip() and not top:
            end = at
    if not inside:
        return -1
    return end if end != -1 else at


def add(kid: str, source: str = "", controller: str = "",
        zmk_dir: str = workspace.ZMK_DIR) -> dict:
    p = plan(kid, source, controller, zmk_dir)
    block = "\n".join(p["entries"]) + "\n"
    path = p["build"]
    text = keymap.read_text(path) if os.path.isfile(path) else ""
    if not text.strip():
        text = BUILD_HEADER + block
    else:
        at = _insert_at(text)
        if at == -1:
            text = text.rstrip("\n") + "\ninclude:\n" + block
        else:
            if at and text[at - 1] != "\n":
                block = "\n" + block
            text = text[:at] + block + text[at:]
    os.makedirs(CONFIG_DIR, exist_ok=True)
    for src, dst in p.pop("_copies"):
        with open(src, "rb") as fi, open(dst, "wb") as fo:
            fo.write(fi.read())
    _write(path, text)
    return p


def _write(path: str, text: str) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def _spans(text: str, names: set):
    """(start, end) character spans of the `include:` items that build `names`,
    each with the comment lines directly above it."""
    lines = text.splitlines(True)
    offs, o = [], 0
    for raw in lines:
        offs.append(o)
        o += len(raw)
    offs.append(o)

    items, section, cur = [], None, None
    for i, raw in enumerate(lines):
        body = keymap._yaml_uncomment(raw).rstrip()
        if not body.strip():
            continue
        indent = len(body) - len(body.lstrip())
        s = body.strip()
        if indent == 0 and not s.startswith("-"):
            section, cur = s.split(":")[0].strip(), None
            continue
        if section != "include":
            continue
        if s.startswith("-"):
            cur = {"start": i, "end": i + 1, "indent": indent, "names": set()}
            items.append(cur)
            s = s[1:].strip()
        elif cur is None or indent <= cur["indent"]:
            continue
        else:
            cur["end"] = i + 1
        key, _, val = s.partition(":")
        if key.strip() in ("board", "shield"):
            cur["names"] |= set(keymap._yaml_unquote(val).split())

    out = []
    for it in items:
        if not it["names"] & names:
            continue
        start = it["start"]
        while start > 0 and lines[start - 1].strip().startswith("#") \
                and len(lines[start - 1]) - len(lines[start - 1].lstrip()) <= it["indent"]:
            start -= 1
        out.append((offs[start], offs[it["end"]]))
    return out


def remove(kid: str, files: bool = True, zmk_dir: str = workspace.ZMK_DIR) -> dict:
    """Drop the keyboard's entries from the build list, and its `config/` files
    when `files`. Refuses an entry written as the top-level board/shield matrix,
    since removing one name there changes what else gets built."""
    hits = [e for e in workspace.catalog(zmk_dir) if e["id"] == kid]
    names = set().union(*(_names(e) for e in hits)) if hits else {kid}
    path = keymap.find_build_yaml()
    text = keymap.read_text(path) if path else ""
    spans = _spans(text, names)
    built = _entries_of(names, keymap.parse_build_yaml(text))
    if len(built) > len(spans):
        raise KeyboardError(f"{path} lists {kid} in its top-level board/shield "
                            f"lists; remove it there by hand")
    if not spans and not (files and _config_files(kid)):
        raise KeyboardError(f"{kid} is not in {path or BUILD_YAML}")
    for a, b in reversed(spans):
        text = text[:a] + text[b:]
    if spans:
        _write(path, text)
    gone = []
    if files:
        for f in _config_files(kid):
            os.remove(f)
            gone.append(f)
    return {"id": kid, "build": path or BUILD_YAML, "entries": len(spans),
            "deleted": gone}


class InUse(KeyboardError):
    """A removal refused because variants still build the keyboard."""

    def __init__(self, what: str, variants: list):
        super().__init__(f"{what} is used by {', '.join(variants)}; delete those "
                         f"variants first")
        self.variants = variants


def variants_using(names: set) -> list:
    """Names of the variants whose build.yaml builds any of `names`."""
    out = []
    for path in sorted(glob.glob(os.path.join(custom.VARIANT_DIR, "*", "build.yaml"))):
        if _entries_of(names, keymap.parse_build_yaml(keymap.read_text(path))):
            out.append(os.path.basename(os.path.dirname(path)))
    return out


def remove_vendor(kid: str, source: str, zmk_dir: str = workspace.ZMK_DIR) -> dict:
    """Take a keyboard out of the project: its build.yaml entries and `config/`
    files, and its module when no other keyboard in build.yaml comes from it.
    Refused, naming them, while a variant builds the keyboard."""
    entry = _find(kid, source, zmk_dir)
    users = variants_using(_names(entry))
    if users:
        raise InUse(kid, users)
    r = {"id": kid, "entries": 0, "deleted": [], "module": None, "left": []}
    path = keymap.find_build_yaml()
    built = keymap.parse_build_yaml(keymap.read_text(path)) if path else []
    if _entries_of(_names(entry), built) or _config_files(kid):
        r.update(remove(kid, zmk_dir=zmk_dir))
    if source != "zmk":
        built = keymap.parse_build_yaml(keymap.read_text(path)) if path else []
        still = [e["id"] for e in workspace.catalog(zmk_dir)
                 if e["source"] == source and e["type"] in ("board", "shield")
                 and _entries_of(_names(e), built)]
        if not still:
            r["left"] = remove_module(source, zmk_dir)["left"]
            r["module"] = source
    return r


def _module_names(entries) -> set:
    return {n for e in entries if e["type"] in ("board", "shield") for n in _names(e)}


class _CheckArgs:
    def __init__(self, zmk_dir, roots=None):
        self.zmk, self.roots, self.keys = zmk_dir, roots, None


def update_check(name: str, zmk_dir: str = workspace.ZMK_DIR):
    """A `fetch()` check for updating module `name`: what the new copy would break
    in the variants that build its keyboards. Only problems the current copy does
    not already have are reported."""
    def run(staged: str) -> list:
        mods = os.path.join(zmk_dir, "modules")
        was = _module_names(workspace.scan(name, os.path.join(mods, name)))
        now = _module_names(workspace.scan(name, staged))
        others = [os.path.join(mods, m) for m in sorted(os.listdir(mods))
                  if m != name and not m.startswith(".")] if os.path.isdir(mods) else []
        roots = [r for r in keypos.search_roots(zmk_dir=zmk_dir)
                 if os.path.normpath(r) != os.path.normpath(mods)] + others + [staged]
        out = []
        for path in sorted(glob.glob(os.path.join(custom.VARIANT_DIR, "*", "build.yaml"))):
            variant = os.path.basename(os.path.dirname(path))
            used = {n for e in keymap.parse_build_yaml(keymap.read_text(path))
                    for n in [e.board] + e.shields} & was
            if not used:
                continue
            for n in sorted(used - now):
                out.append(f"{variant}: {n} is not in the new version")
            km_path = os.path.join(os.path.dirname(path), variant + ".keymap")
            if not os.path.isfile(km_path):
                continue
            raw = keymap.read_text(km_path)
            old, _, _ = check.check_text(km_path, raw, _CheckArgs(zmk_dir))
            new, _, _ = check.check_text(km_path, raw, _CheckArgs(zmk_dir, roots))
            if old.expected_keys != new.expected_keys:
                out.append(f"{variant}: the layout has {new.expected_keys} keys, "
                           f"was {old.expected_keys}")
            seen = set(old.rep.errors)
            out += [re.sub(r"^.*?:(\d+): ERROR ", rf"{variant} line \1: ", e)
                    for e in new.rep.errors if e not in seen]
        return out
    return run


def remove_module(name: str, zmk_dir: str = workspace.ZMK_DIR) -> dict:
    """Uninstall a module, refused while `build.yaml` or a variant still builds one
    of its keyboards: both would stop building, and the variant would lose its
    layout."""
    names = set()
    for e in workspace.catalog(zmk_dir):
        if e["source"] == name and e["type"] in ("board", "shield"):
            names |= _names(e)
    users = []
    for path in [keymap.find_build_yaml() or ""] + sorted(
            glob.glob(os.path.join(custom.VARIANT_DIR, "*", "build.yaml"))):
        if names and os.path.isfile(path) and _entries_of(
                names, keymap.parse_build_yaml(keymap.read_text(path))):
            users.append(os.path.relpath(path))
    if users:
        raise KeyboardError(f"{name} is still used by {', '.join(users)}; remove "
                            f"its keyboards and variants first")
    return workspace.remove_module(name, zmk_dir)


# ----------------------------------------------------------------- command

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    ls = sub.add_parser("list", help="keyboards that can be added")
    ls.add_argument("--all", action="store_true", help="include the added ones")
    a = sub.add_parser("add", help="copy its keymap and append its build entries")
    a.add_argument("id")
    a.add_argument("--source", default="", help="`zmk` or a module name")
    a.add_argument("--controller", default="", help="for a shield: the board it sits on")
    r = sub.add_parser("remove", help="drop its build entries and config/ files")
    r.add_argument("id")
    r.add_argument("--keep-files", action="store_true", help="leave config/ alone")
    args = ap.parse_args()
    os.chdir(PROJECT_DIR)

    try:
        if args.cmd == "list":
            kbs, _ = offer()
            for k in kbs:
                if k["added"] and not args.all:
                    continue
                flag = "added " if k["added"] else ""
                print(f"{flag}{k['source']:<20} {k['type']:<7} {k['id']:<28} {k['name']}")
        elif args.cmd == "add":
            ctl = args.controller
            if not ctl:
                e = _find(args.id, args.source)
                if e["type"] == "shield":
                    ctl = DEFAULT_CONTROLLER
            p = add(args.id, args.source, ctl)
            for f in p["copy"]:
                print(f"copied {f}")
            for f in p["kept"]:
                print(f"kept   {f} (already there)")
            print(f"{p['build']}: +{len(p['entries'])} entries")
            print("\n".join(p["entries"]))
        else:
            r = remove(args.id, files=not args.keep_files)
            print(f"{r['build']}: -{r['entries']} entries")
            for f in r["deleted"]:
                print(f"deleted {f}")
    except (KeyboardError, workspace.WorkspaceError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
