"""Physical layouts and matrix transforms.

Key positions are the indices used by `key-positions` (combos),
`hold-trigger-key-positions` (positional hold-taps) and the order of a layer's
`bindings`. They come from the keyboard's physical layout (or, on older
keyboards, its matrix transform) - never from counting rows by eye. This module
finds those layouts and resolves a keymap to one; `vilemk.scripts.keypos` is
the command that prints them.

Search roots (first that exist): ./boards, ./config, ./.zmk/modules/*,
./.zmk/zmk/app/boards, ./.zmk/zmk/app/dts/layouts, plus --zmk/--root.

Usage:
    python3 -m vilemk.keypos                    # every keymap in ./config
    python3 -m vilemk.keypos config/foo.keymap  # layout + current bindings
    python3 -m vilemk.keypos corne              # by board/shield name
    python3 -m vilemk.keypos --list             # every layout found locally
"""

from __future__ import annotations

import argparse
import os
import re
import sys

from . import PROJECT_DIR

DTS_SUFFIXES = (".dtsi", ".dts", ".overlay", ".keymap")


def strip_comments(src: str) -> str:
    """Blank out comments while preserving every byte offset and newline.

    Offsets survive so a caller that found something in the stripped text can
    report it against the line it is on in the original.
    """
    out = list(src)
    i, n = 0, len(src)
    while i < n:
        if src.startswith("/*", i):
            j = src.find("*/", i + 2)
            j = n if j == -1 else j + 2
            for k in range(i, j):
                if out[k] != "\n":
                    out[k] = " "
            i = j
        elif src.startswith("//", i):
            j = src.find("\n", i)
            j = n if j == -1 else j
            for k in range(i, j):
                out[k] = " "
            i = j
        else:
            i += 1
    return "".join(out)


def search_roots(extra_roots=(), zmk_dir=None):
    roots = []
    for r in extra_roots:
        if r and os.path.isdir(r):
            roots.append(r)
    for r in ("boards", "config"):
        if os.path.isdir(r):
            roots.append(r)
    zmk = zmk_dir or ".zmk"
    for r in (
        os.path.join(zmk, "modules"),
        os.path.join(zmk, "zmk", "app", "boards"),
        os.path.join(zmk, "zmk", "app", "dts", "layouts"),
    ):
        if os.path.isdir(r):
            roots.append(r)
    return roots


def iter_dts_files(roots):
    seen = set()
    for root in roots:
        for base, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d not in (".git", "build", "__pycache__")]
            for fn in files:
                if fn.endswith(DTS_SUFFIXES):
                    path = os.path.join(base, fn)
                    real = os.path.realpath(path)
                    if real not in seen:
                        seen.add(real)
                        yield path


class Layout:
    def __init__(self, label, display_name, source, keys):
        self.label = label
        self.display_name = display_name
        self.source = source
        self.keys = keys          # list of (w, h, x, y, rot, rx, ry)

    @property
    def count(self):
        return len(self.keys)


class Transform:
    """Older keyboards: a matrix transform with an RC() map and no physical layout."""

    def __init__(self, label, source, cells, rows):
        self.label = label
        self.source = source
        self.cells = cells        # ["RC(0,0)", ...]
        self.rows = rows          # same, grouped by source line

    @property
    def count(self):
        return len(self.cells)


KEY_ATTR_RE = re.compile(
    r"&key_physical_attrs\s+([\d()x+-]+)\s+([\d()x+-]+)\s+([\d()x+-]+)\s+"
    r"([\d()x+-]+)\s+([\d()x+-]+)\s+([\d()x+-]+)\s+([\d()x+-]+)\s*>"
)
NODE_OPEN_RE = re.compile(r"(?:([A-Za-z_][\w-]*)\s*:\s*)?([A-Za-z_][\w,@.-]*)\s*\{")


def _num(tok: str) -> int:
    tok = tok.strip().strip("()")
    try:
        return int(tok, 0)
    except ValueError:
        return 0


def node_bodies(src: str):
    """Yield (label, name, body) for every node in a file, at any depth."""
    for m in NODE_OPEN_RE.finditer(src):
        depth, j = 0, m.end() - 1
        while j < len(src):
            if src[j] == "{":
                depth += 1
            elif src[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        yield m.group(1), m.group(2), src[m.end():j]


def prop_value(body: str, name: str):
    """Return (raw_value, offset_within_body) for `name = ...;`, else (None, None).

    The offset is what lets a caller report a finding against the property's own
    line rather than the node header, so it is part of the result even for the
    callers that only want the value.
    """
    m = re.search(r"(?<![\w-])" + re.escape(name) + r"\s*=\s*(.*?);", body, re.S)
    if not m:
        return None, None
    return m.group(1), m.start(1)


def funclike_defines(src: str):
    """Names of `#define NAME(...)` macros - the ones an invocation can hide a
    whole binding behind, e.g. `AS(N1)` from `#define AS(kc) &as LS(kc) kc`."""
    return {m.group(1) for m in
            re.finditer(r"(?m)^[ \t]*#[ \t]*define[ \t]+(\w+)\(", src)}


def scan_file(path):
    """Return (layouts, transforms, chosen_layout_label) for one dts file."""
    try:
        src = strip_comments(open(path, encoding="utf-8", errors="replace").read())
    except OSError:
        return [], [], None

    layouts, transforms = [], []
    for label, name, body in node_bodies(src):
        if 'compatible = "zmk,physical-layout"' in body:
            keys = [tuple(_num(g) for g in m.groups())
                    for m in KEY_ATTR_RE.finditer(body)]
            if keys:
                dn = re.search(r'display-name\s*=\s*"([^"]*)"', body)
                layouts.append(Layout(label or name, dn.group(1) if dn else "",
                                      path, keys))
        elif 'compatible = "zmk,matrix-transform"' in body:
            mm = re.search(r"map\s*=\s*<(.*?)>\s*;", body, re.S)
            if mm:
                rows = [re.findall(r"RC\(\s*\d+\s*,\s*\d+\s*\)", line)
                        for line in mm.group(1).splitlines()]
                rows = [r for r in rows if r]
                cells = [c for r in rows for c in r]
                if cells:
                    transforms.append(Transform(label or name, path, cells, rows))

    chosen = re.search(r"zmk,physical-layout\s*=\s*&(\w+)", src)
    return layouts, transforms, chosen.group(1) if chosen else None


def collect(roots):
    """Every layout/transform found, keyed by (label, file).

    Labels are NOT unique across keyboards - `physical_layout0` is used by
    dozens of in-tree shields - so the defining file is part of the key.
    """
    layouts, transforms, chosen = {}, {}, {}
    for path in iter_dts_files(roots):
        ls, ts, ch = scan_file(path)
        for l in ls:
            layouts.setdefault((l.label, os.path.realpath(l.source)), l)
        for t in ts:
            transforms.setdefault((t.label, os.path.realpath(t.source)), t)
        if ch:
            chosen.setdefault(path, ch)
    return layouts, transforms, chosen


KEYBOARD_HINT_RE = re.compile(r"(?im)^\s*(?://|/\*)?\s*zmk-keyboard\s*:\s*([\w.-]+)")


def keyboard_names(keymap_path):
    """Names to try when hunting for a keymap's keyboard, best guess first.

    In order: an explicit `// zmk-keyboard: <name>` comment, the file stem,
    progressively shorter stems (`eyelash_sofle-colemak` -> `eyelash_sofle`),
    the stem with a `_revN`/`_vN` suffix removed (`kyria_rev3` -> `kyria`), and
    the name of the directory holding the keymap (in-tree shields live in
    `boards/shields/<keyboard>/`).
    """
    stem = os.path.splitext(os.path.basename(keymap_path))[0]
    names = []
    try:
        m = KEYBOARD_HINT_RE.search(
            open(keymap_path, encoding="utf-8", errors="replace").read())
        if m:
            names.append(m.group(1))
    except OSError:
        pass
    names.append(stem)
    for sep in ("-", "."):
        while sep in names[-1]:
            names.append(names[-1].rsplit(sep, 1)[0])
    trimmed = re.sub(r"_(rev|v)\d+$", "", names[-1])
    if trimmed != names[-1]:
        names.append(trimmed)
    parent = os.path.basename(os.path.dirname(os.path.abspath(keymap_path)))
    if parent not in ("config", "variants", "keymaps", ""):
        names.append(parent)
    seen, out = set(), []
    for n in names:
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def candidates_for(name, roots, layouts, transforms, chosen):
    """Layouts/transforms belonging to board or shield `name`."""
    name = name.lower()
    hits_l, hits_t = [], []

    # 1. a `chosen zmk,physical-layout` in a file belonging to this keyboard.
    #    Resolve the label against layouts defined near that file first: the
    #    same label may exist under a dozen other keyboards.
    for path, label in chosen.items():
        if name in os.path.basename(path).lower() or name in path.lower().split(os.sep):
            near = os.path.dirname(os.path.realpath(path))
            for (lbl, src), layout in sorted(
                    layouts.items(),
                    key=lambda kv: 0 if os.path.dirname(kv[0][1]) == near else 1):
                if lbl == label:
                    hits_l.append(layout)
                    break

    # 2. layouts/transforms defined in files whose path mentions the keyboard
    for store, hits in ((layouts, hits_l), (transforms, hits_t)):
        for obj in store.values():
            parts = [p.lower() for p in obj.source.split(os.sep)]
            if name in os.path.basename(obj.source).lower() or name in parts:
                if obj not in hits:
                    hits.append(obj)

    # de-dup, keep order
    seen, out_l = set(), []
    for l in hits_l:
        key = (l.label, os.path.realpath(l.source))
        if key not in seen:
            seen.add(key)
            out_l.append(l)
    return out_l, hits_t


def resolve(keymap_path, roots, layouts, transforms, chosen):
    """(layouts, transforms, name_used) for the keyboard a keymap belongs to."""
    for name in keyboard_names(keymap_path):
        ls, ts = candidates_for(name, roots, layouts, transforms, chosen)
        if ls or ts:
            return ls, ts, name
    return [], [], os.path.splitext(os.path.basename(keymap_path))[0]


# ---------------------------------------------------------------- rendering

def cluster_rows(ys, gap=40, span=90):
    """Group y coordinates into visual rows.

    Column-staggered boards offset each column vertically, so a row is a run of
    close y values rather than one exact value.
    """
    rows = []
    for y in sorted(set(ys)):
        if rows and y - rows[-1][-1] <= gap and y - rows[-1][0] <= span:
            rows[-1].append(y)
        else:
            rows.append([y])
    return {y: i for i, row in enumerate(rows) for y in row}


def render_layout(layout: Layout, labels=None, cell=None):
    """ASCII map placed by each key's real x/y coordinates."""
    texts = []
    for i in range(layout.count):
        t = labels[i] if labels and i < len(labels) else str(i)
        texts.append(t)
    width = cell or (max(len(t) for t in texts) + 2)
    xs = [k[2] for k in layout.keys]
    minx = min(xs)
    row_of = cluster_rows([k[3] for k in layout.keys])
    canvas = {}
    for i, (w, h, x, y, rot, rx, ry) in enumerate(layout.keys):
        row = row_of[y]
        col = int(round((x - minx) / 100.0 * width))
        text = texts[i].center(width - 1)[: width - 1]
        line = canvas.setdefault(row, {})
        while any(c in line for c in range(col, col + width - 1)):
            col += 1
        for off, ch in enumerate(text):
            line[col + off] = ch
    out = []
    for row in sorted(canvas):
        cells = canvas[row]
        end = max(cells) + 1
        out.append("".join(cells.get(c, " ") for c in range(end)).rstrip())
    return "\n".join(out)


def position_defines(layout: Layout):
    """Heuristic KEYS_L / KEYS_R / KEYS_T groups for positional hold-taps.

    Left/right split on the horizontal midpoint, thumbs = the bottom visual row.
    Eyeball the result against the map before using it.
    """
    xs = [k[2] for k in layout.keys]
    mid = (min(xs) + max(xs)) / 2.0
    row_of = cluster_rows([k[3] for k in layout.keys])
    last_row = max(row_of.values())
    left, right, thumbs = [], [], []
    for i, (w, h, x, y, *_rest) in enumerate(layout.keys):
        if row_of[y] == last_row:
            thumbs.append(i)
        elif x < mid:
            left.append(i)
        else:
            right.append(i)
    def fmt(name, vals):
        return f"#define {name:<8}" + " ".join(str(v) for v in vals)
    return "\n".join([fmt("KEYS_L", left), fmt("KEYS_R", right),
                       fmt("KEYS_T", thumbs)])


def render_transform(tr: Transform):
    out, i = [], 0
    for row in tr.rows:
        cells = []
        for _ in row:
            cells.append(str(i).rjust(3))
            i += 1
        out.append(" ".join(cells))
    return "\n".join(out)


# ---------------------------------------------------------------- keymaps

BINDING_TOKEN_RE = re.compile(r"&?[\w()|.+-]+")


def binding_tokens(value: str, funclike=()):
    """A `bindings = <...>` value -> one string per binding, `&` kept.

    A binding starts at an `&label`, or at an invocation of a function-like
    `#define` that expands to one (`funclike`); every other token is a parameter
    of the binding before it. See `vilemk.check.split_bindings` for the variant
    that also reports each binding's offset.
    """
    out = []
    for m in BINDING_TOKEN_RE.finditer(value.replace(",", " ").strip("<> ")):
        tok = m.group()
        if tok.startswith("&") or tok.split("(")[0] in funclike:
            out.append(tok)
        elif out:
            out[-1] = (out[-1] + " " + tok).strip()
    return out


def first_layer_labels(keymap_path, layer_index=0):
    """Short labels for each binding of one layer, for overlaying on the map."""
    try:
        src = strip_comments(open(keymap_path, encoding="utf-8",
                                  errors="replace").read())
    except OSError:
        return None
    funclike = funclike_defines(src)
    layers = []
    for label, name, body in node_bodies(src):
        if 'compatible = "zmk,keymap"' in body:
            for llabel, lname, lbody in node_bodies(body):
                m = re.search(r"(?<![\w-])bindings\s*=\s*(.*?);", lbody, re.S)
                if m:
                    layers.append((lname, m.group(1)))
            break
    if layer_index >= len(layers):
        return None
    name, value = layers[layer_index]
    out = [b[1:] if b.startswith("&") else b
           for b in binding_tokens(value, funclike)]
    return name, [shorten(b) for b in out]


ABBREV = [
    (r"^kp ", ""), (r"_ARROW$", ""), (r"^LEFT_", "L"), (r"^RIGHT_", "R"),
    (r"^BACKSPACE$", "BSPC"), (r"^C_VOLUME_UP$", "VOL+"), (r"^C_VOL_DN$", "VOL-"),
    (r"^CONTROL$", "CTRL"), (r"^SHIFT$", "SHFT"), (r"^ENTER$", "RET"),
]


def shorten(binding: str, limit: int = 10) -> str:
    b = binding.strip()
    for pat, rep in ABBREV:
        b = re.sub(pat, rep, b)
    return b if len(b) <= limit else b[: limit - 1] + "\u2026"


def keymaps_in_config():
    out = []
    for base in ("config", "."):
        if os.path.isdir(base):
            for fn in sorted(os.listdir(base)):
                if fn.endswith(".keymap"):
                    out.append(os.path.join(base, fn))
        if out:
            break
    return out


# ---------------------------------------------------------------- main

def report(target_name, keymap_path, roots, layouts, transforms, chosen, args):
    ls, ts = candidates_for(target_name, roots, layouts, transforms, chosen)
    print(f"### {target_name}" + (f"  ({keymap_path})" if keymap_path else ""))
    if not ls and not ts:
        print("  no physical layout or matrix transform found in the local ZMK "
              "checkout — is the board module fetched into .zmk/modules?")
        print()
        return None
    labels = None
    if keymap_path and not args.numbers:
        got = first_layer_labels(keymap_path, args.layer)
        if got:
            lname, labels = got
            print(f"  overlaying bindings from layer {args.layer} (`{lname}`)")
    count = None
    for l in ls:
        count = count or l.count
        title = l.display_name or l.label
        print(f"\n  layout `{l.label}` — {title}: {l.count} key positions")
        print(f"  source: {l.source}")
        print()
        print(render_layout(l, labels if l.count == len(labels or []) else None))
        print()
        if args.defines:
            print("  heuristic position groups (check them against the map):")
            print(position_defines(l))
            print()
    for t in ts:
        if ls:
            break
        count = count or t.count
        print(f"\n  matrix transform `{t.label}`: {t.count} key positions "
              "(no physical layout — older keyboard)")
        print(f"  source: {t.source}")
        print()
        print(render_transform(t))
        print()
    if labels and count and count != len(labels):
        print(f"  !! layer {args.layer} has {len(labels)} bindings but the layout has "
              f"{count} key positions")
    return count


# --------------------------------------------------------------------- command

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("target", nargs="?",
                    help="a .keymap path, or a board/shield name; default: every "
                         "keymap in ./config")
    ap.add_argument("--list", action="store_true", help="list all layouts found")
    ap.add_argument("--layer", type=int, default=0,
                    help="which layer's bindings to overlay (default 0)")
    ap.add_argument("--defines", action="store_true",
                    help="also emit KEYS_L/KEYS_R/KEYS_T groups for positional "
                         "hold-taps")
    ap.add_argument("--numbers", action="store_true",
                    help="always show position numbers, never bindings")
    ap.add_argument("--zmk", help="path to the ZMK cache (default ./.zmk)")
    ap.add_argument("--root", action="append", default=[],
                    help="extra directory to search (repeatable)")
    args = ap.parse_args()

    if args.target and args.target.endswith(".keymap") and os.path.exists(args.target):
        args.target = os.path.abspath(args.target)
    os.chdir(PROJECT_DIR)

    roots = search_roots(args.root, args.zmk)
    if not roots:
        print(f"no search roots found under {PROJECT_DIR} — is .zmk/ fetched?",
              file=sys.stderr)
        return 1
    layouts, transforms, chosen = collect(roots)

    if args.list:
        print(f"{len(layouts)} physical layout(s), {len(transforms)} matrix "
              f"transform(s) under: {', '.join(roots)}\n")
        for l in sorted(layouts.values(), key=lambda l: l.source):
            print(f"{l.count:4d}  {l.label:<40} {l.display_name:<18} {l.source}")
        for t in sorted(transforms.values(), key=lambda t: t.source):
            print(f"{t.count:4d}  {t.label:<40} {'(transform)':<18} {t.source}")
        return 0

    targets = []
    if args.target and args.target.endswith(".keymap"):
        targets.append((os.path.splitext(os.path.basename(args.target))[0], args.target))
    elif args.target:
        targets.append((args.target, None))
    else:
        for km in keymaps_in_config():
            targets.append((os.path.splitext(os.path.basename(km))[0], km))
        if not targets:
            print("no .keymap files in ./config — pass a board/shield name instead")
            return 1

    for name, km in targets:
        report(name, km, roots, layouts, transforms, chosen, args)
    return 0



if __name__ == "__main__":
    sys.exit(main())
