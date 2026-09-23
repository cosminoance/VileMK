"""Read the ZMK keymaps in the project and turn them into plain data.

Parsing only: devicetree in, dicts and lists out. Nothing here knows that a
web page exists — rendering lives in `vilemk.webui`. `collect_data()` is the
one entry point both the static builder and the live server call.

Sources, in the order they are discovered: vendor default keymaps from the
fetched board data in `.zmk/`, your own `config/*.keymap`, and any saved
variations in `variants/*.keymap`. Each one's physical layout is resolved
through `vilemk.keypos`, so key positions are the real ones.
"""

from __future__ import annotations

import datetime
import os
import re

from . import keypos
from .keypos import (binding_tokens, funclike_defines, node_bodies, prop_value,
                     strip_comments)

# ---------------------------------------------------------------- keymap parsing

BINDING_MACRO_RE = re.compile(
    r"(?m)^[ \t]*#[ \t]*define[ \t]+(\w+)\(([^)]*)\)[ \t]*(.*(?:\\\n.*)*)$")


def binding_macros(src: str):
    """Local `#define NAME(a,b) &x a &y b` macros - the ones that expand to
    bindings, e.g. cradio's HRML(). Ones without a `&` are keycode aliases and
    are left alone."""
    out = {}
    for m in BINDING_MACRO_RE.finditer(src):
        body = m.group(3).replace("\\\n", " ")
        if "&" in body:
            out[m.group(1)] = ([p.strip() for p in m.group(2).split(",")], body)
    return out


def _split_args(text: str):
    """The arguments between a call's parentheses, split on top-level commas.

    `A, B, LS(C)` -> ['A', 'B', 'LS(C)']. A comma nested inside parentheses
    belongs to the inner call, so depth is tracked rather than splitting on
    every comma.
    """
    args, depth, cur = [], 0, ""
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            args.append(cur.strip())
            cur = ""
        else:
            cur += ch
    args.append(cur.strip())
    return args


def _closing_paren(text: str, open_idx: int) -> int:
    """Index of the `)` matching the `(` at `open_idx`, or -1 if never closed."""
    depth = 0
    for j in range(open_idx, len(text)):
        if text[j] == "(":
            depth += 1
        elif text[j] == ")":
            depth -= 1
            if depth == 0:
                return j
    return -1


def _expand_calls(text: str, name: str, params, body: str):
    """Replace every `NAME(...)` in `text` with `body`. -> (new_text, how_many).

    Each expansion is padded with spaces so the body cannot fuse onto the token
    beside it, and scanning resumes *after* the inserted body rather than
    re-reading it: a macro whose body names itself would otherwise expand
    forever inside this one call.
    """
    pattern = re.compile(r"\b" + re.escape(name) + r"\s*\(")
    done, cursor, count = [], 0, 0
    while True:
        call = pattern.search(text, cursor)
        if not call:
            break
        close = _closing_paren(text, call.end() - 1)
        if close == -1:
            break                       # unbalanced - leave the rest as it is
        args = _split_args(text[call.end():close])
        expansion = body
        for param, arg in zip(params, args):
            expansion = re.sub(r"\b" + re.escape(param) + r"\b", arg, expansion)
        done.append(text[cursor:call.start()])
        done.append(" " + expansion + " ")
        cursor = close + 1
        count += 1
    return "".join(done) + text[cursor:], count


# A macro body may name another macro, so expansion repeats until a pass changes
# nothing. The cap is what stops `#define X(a) X(a)` from running forever; four
# is well past anything a real keymap nests, and a deeper chain comes back partly
# expanded instead of hanging the tool.
MAX_EXPANSION_ROUNDS = 4


def expand_macros(text: str, macros, rounds: int = MAX_EXPANSION_ROUNDS) -> str:
    """Inline binding macros so each one contributes its real number of keys.

    A layer holding `bindings = <HRML(A,S,D,F) &kp G>;` has eight bindings, not
    two: `HRML` stands for four of them. Counting tokens without expanding first
    would make every layer that uses one look short, so the text is rewritten
    before it is split:

        >>> macros = {"HRML": (["k1", "k2"], "&ht LGUI k1 &ht LALT k2")}
        >>> expand_macros("<HRML(A,S) &kp G>", macros)
        '< &ht LGUI A &ht LALT S  &kp G>'

    The result is only ever fed back to `split_bindings`, so the loose spacing
    costs nothing.
    """
    if not macros:
        return text
    for _ in range(rounds):
        expanded = 0
        for name, (params, body) in macros.items():
            text, n = _expand_calls(text, name, params, body)
            expanded += n
        if not expanded:
            break
    return text


def _numeric_defines(src: str):
    out = {}
    for m in re.finditer(r"(?m)^[ \t]*#[ \t]*define[ \t]+(\w+)[ \t]+(-?\d+)[ \t]*$", src):
        out[m.group(1)] = int(m.group(2))
    return out


def split_bindings(value: str, funclike, macros=None) -> list:
    """A `bindings = <...>` value -> ['&kp Q', '&mt LSHFT A', ...].

    Binding macros are inlined first, so one `HRML(A,S,D,F)` contributes its four
    real keys rather than a single token.
    """
    return binding_tokens(expand_macros(value, macros or {}), funclike)


def _prop(body: str, name: str):
    """The value of `name = ...;`, stripped. Nothing here reports positions, so
    the offset `keypos.prop_value` also returns is dropped."""
    value = prop_value(body, name)[0]
    return value.strip() if value is not None else None


def _ints(value: str, defines):
    nums, unresolved = [], []
    for tok in re.findall(r"[\w]+", value.strip("<> ")):
        if re.fullmatch(r"\d+", tok):
            nums.append(int(tok))
        elif tok in defines:
            nums.append(defines[tok])
        else:
            unresolved.append(tok)
    return nums, unresolved


def parse_keymap(path: str) -> dict:
    """-> {layers: [...], combos: [...], behaviors: [...], macros: [...], warnings: [...]}"""
    try:
        raw = open(path, encoding="utf-8", errors="replace").read()
    except OSError as exc:
        return {"layers": [], "combos": [], "behaviors": [], "macros": [],
                "warnings": [str(exc)]}
    src = strip_comments(raw)
    funclike = funclike_defines(src)
    bmacros = binding_macros(src)
    defines = _numeric_defines(src)
    warnings = []

    layers, combos, behaviors, macros = [], [], [], []
    for _label, _name, body in node_bodies(src):
        compat = _prop(body, "compatible") or ""
        if '"zmk,keymap"' in compat:
            for _ll, lname, lbody in node_bodies(body):
                value = _prop(lbody, "bindings")
                status = _prop(lbody, "status")
                if value is None:
                    if status and "reserved" in status:
                        layers.append({"name": lname, "display": "(reserved)",
                                       "bindings": [], "reserved": True})
                    continue
                dn = re.search(r'display-name\s*=\s*"([^"]*)"', lbody)
                layers.append({
                    "name": lname,
                    "display": dn.group(1) if dn else lname,
                    "bindings": split_bindings(value, funclike, bmacros),
                    "reserved": False,
                })
        elif '"zmk,combos"' in compat:
            for _cl, cname, cbody in node_bodies(body):
                kp = _prop(cbody, "key-positions")
                if kp is None:
                    continue
                positions, unresolved = _ints(kp, defines)
                if unresolved:
                    warnings.append(
                        f"combo {cname}: unresolved key-positions {' '.join(unresolved)}")
                lay = _prop(cbody, "layers")
                lay_nums = _ints(lay, defines)[0] if lay else []
                timeout = _prop(cbody, "timeout-ms")
                combos.append({
                    "name": cname,
                    "positions": positions,
                    "bindings": " ".join(split_bindings(
                        _prop(cbody, "bindings") or "", funclike, bmacros)),
                    "timeout": int(timeout.strip("<> ")) if timeout and
                    timeout.strip("<> ").isdigit() else None,
                    "layers": lay_nums,
                })

    # user-defined behaviors and macros, wherever they are declared
    for label, name, body in node_bodies(src):
        compat = _prop(body, "compatible") or ""
        m = re.search(r'"zmk,behavior-([\w-]+)"', compat)
        if not m or not label:
            continue
        kind = m.group(1)
        entry = {
            "label": label,
            "kind": kind,
            "bindings": split_bindings(_prop(body, "bindings") or "", funclike, bmacros),
            "props": {k: v for k, v in (
                ("tapping-term-ms", _prop(body, "tapping-term-ms")),
                ("quick-tap-ms", _prop(body, "quick-tap-ms")),
                ("require-prior-idle-ms", _prop(body, "require-prior-idle-ms")),
                ("flavor", _prop(body, "flavor")),
                ("mods", _prop(body, "mods")),
                ("keep-mods", _prop(body, "keep-mods")),
                ("wait-ms", _prop(body, "wait-ms")),
                ("tap-ms", _prop(body, "tap-ms")),
            ) if v},
        }
        (macros if kind.startswith("macro") else behaviors).append(entry)

    return {"layers": layers, "combos": combos, "behaviors": behaviors,
            "macros": macros, "warnings": warnings}


# ---------------------------------------------------------------- discovery

# ------------------------------------------------------------ the build list
#
# `build.yaml` decides which board/shield combinations are actually built, and
# with which keymap. Reading it is discovery here - it decides which vendor
# keymaps are worth showing. `vilemk.check` reads the same entries to *check*
# them against the vendor's build list and against `config/`.

BUILD_YAML_CANDIDATES = ("build.yaml", "build.yml",
                         os.path.join("config", "build.yaml"),
                         os.path.join("config", "build.yml"))

YAML_KEY_RE = re.compile(r"^(?P<key>[A-Za-z_][\w-]*)[ \t]*:[ \t]*(?P<val>.*?)[ \t]*$")
KEYMAP_FILE_RE = re.compile(r"-D[ \t]*KEYMAP_FILE[ \t]*=[ \t]*(\"[^\"]*\"|'[^']*'|\S+)")
WORKSPACE_RE = re.compile(r"\$\{?GITHUB_WORKSPACE\}?")
HALF_RE = re.compile(r"^(?P<base>.+?)[_-](?P<half>left|right)$", re.I)

# Shields a vendor lists that are utilities rather than parts of the keyboard.
# `settings_reset` builds a firmware whose only job is to wipe stored settings;
# it is not a thing your entry is missing, and it never wants your keymap.
UTILITY_SHIELDS = {"settings_reset"}


def read_text(path: str) -> str:
    try:
        return open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return ""


def _yaml_uncomment(line: str) -> str:
    """Blank out a trailing `# comment`, preserving length so offsets survive."""
    out, quote = list(line), None
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "#":
            for k in range(i, len(out)):
                out[k] = " "
            break
    return "".join(out)


def _yaml_unquote(text: str) -> str:
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        return text[1:-1]
    return text


def _flow_list(value: str):
    """`[ "a", "b" ]` -> ['a', 'b']; `a` -> ['a']; empty for a block list."""
    value = value.strip()
    if not value:
        return []
    if value.startswith("["):
        return [_yaml_unquote(v) for v in value.strip("[] ").split(",") if v.strip()]
    return [_yaml_unquote(value)]


def split_half(name: str):
    """`eyelash_sofle_left` -> ('eyelash_sofle', 'left'); `corne` -> ('corne', None)."""
    m = HALF_RE.match(name or "")
    return (m.group("base"), m.group("half").lower()) if m else (name or "", None)


class BuildEntry:
    """One board/shield combination the CI would build."""

    def __init__(self, pos: int, indent: int = 0):
        self.pos = pos
        self.indent = indent
        self.props = {}                      # key -> (value, offset)

    def set(self, key, value, pos):
        self.props.setdefault(key, (value, pos))

    def get(self, key, default=None):
        return self.props.get(key, (default, None))[0]

    def at(self, key) -> int:
        """Offset to report against: the property's own line, or the entry's."""
        return self.props.get(key, (None, self.pos))[1] or self.pos

    @property
    def board(self) -> str:
        return self.get("board") or ""

    @property
    def shields(self):
        """`shield: corne_left nice_view` is two shields on one entry."""
        return (self.get("shield") or "").split()

    def keymap_file(self):
        """The `-DKEYMAP_FILE=...` value, verbatim, or None."""
        m = KEYMAP_FILE_RE.search(self.get("cmake-args") or "")
        return _yaml_unquote(m.group(1)) if m else None

    def artifact(self) -> str:
        """What the .uf2 inside firmware.zip ends up called."""
        return self.get("artifact-name") or "-".join(
            [p for p in ["+".join(self.shields), self.board] if p])


def parse_build_yaml(text: str):
    """The board/shield combinations a `build.yaml` describes.

    Enough YAML for this one file shape and no more: the top-level `board:` and
    `shield:` lists, whose cross product is built, plus the `include:` list of
    explicit entries. Indentation and regex, like the rest of the project -
    there is no dependency to add for this.
    """
    entries, top, section, cur, offset = [], {}, None, None, 0
    for raw in text.splitlines(True):
        line = _yaml_uncomment(raw.rstrip("\n"))
        start, offset = offset, offset + len(raw)
        body = line.strip()
        if not body or body in ("---", "..."):
            continue
        indent = len(line) - len(line.lstrip())
        pos = start + indent

        if indent == 0 and not body.startswith("-"):
            m = YAML_KEY_RE.match(body)
            if not m:
                continue
            section, cur = m.group("key"), None
            if section in ("board", "shield"):
                top.setdefault(section, []).extend(
                    (v, pos) for v in _flow_list(m.group("val")))
        elif body.startswith("-"):
            item = body[1:].strip()
            if section == "include":
                cur = BuildEntry(pos, indent)
                entries.append(cur)
                m = YAML_KEY_RE.match(item)
                if m:
                    cur.set(m.group("key"), _yaml_unquote(m.group("val")), pos)
            elif section in ("board", "shield") and item:
                top.setdefault(section, []).append((_yaml_unquote(item), pos))
        elif cur is not None and indent > cur.indent:
            m = YAML_KEY_RE.match(body)
            if m:
                cur.set(m.group("key"), _yaml_unquote(m.group("val")), pos)

    # the top-level lists build every board against every shield
    for board, bpos in top.get("board", []):
        for shield, spos in top.get("shield", []) or [(None, None)]:
            e = BuildEntry(bpos)
            e.set("board", board, bpos)
            if shield:
                e.set("shield", shield, spos)
            entries.append(e)
    return entries


def find_build_yaml():
    """The repo's build list, at either of the two places it is written."""
    for cand in BUILD_YAML_CANDIDATES:
        if os.path.isfile(cand):
            return cand
    return None


def vendor_build_entries(zmk_dir: str, skip_utility: bool = True):
    """The build lists that ship with the keyboards, from the CLI's cache.

    `.zmk/modules/<keyboard-module>/build.yaml` is the vendor's own answer to
    "what is this keyboard": which halves, and what is plugged into each. Utility
    entries (`UTILITY_SHIELDS`) are dropped unless you ask for them - they are
    firmware you flash once, not a description of the keyboard.
    """
    out = []
    root = os.path.join(zmk_dir or ".zmk", "modules")
    if not os.path.isdir(root):
        return out
    for name in sorted(os.listdir(root)):
        for fn in ("build.yaml", "build.yml"):
            path = os.path.join(root, name, fn)
            if os.path.isfile(path):
                out += parse_build_yaml(read_text(path))
                break
    if skip_utility:
        out = [e for e in out
               if not any(s in UTILITY_SHIELDS for s in e.shields)]
    return out


def build_yaml_names(path=None):
    """Every board and shield the repo actually builds, lowercased.

    What `discover()` uses to hide the several hundred in-tree boards you do
    not care about.
    """
    path = path or find_build_yaml()
    if not path or not os.path.isfile(path):
        return set()
    names = set()
    for entry in parse_build_yaml(read_text(path)):
        for name in [entry.board] + entry.shields:
            if name:
                names.add(name.lower())
    return names


def discover(zmk_dir, include=(), take_all=False):
    """-> [(kind, path)] for every keymap worth showing."""
    found = []

    # Relative to the project, which every command chdirs into.
    # A variant is a folder - `variants/<name>/<name>.keymap` beside the
    # `build.yaml` that builds it - so look one level down as well as flat.
    # Flat `.keymap` files are what earlier versions wrote, and still count.
    for base, kind in (("config", "config"), ("variants", "variant"),
                       ("keymaps", "variant")):
        if not os.path.isdir(base):
            continue
        for fn in sorted(os.listdir(base)):
            path = os.path.join(base, fn)
            if fn.endswith(".keymap"):
                found.append((kind, path))
            elif os.path.isdir(path):
                for sub in sorted(os.listdir(path)):
                    if sub.endswith(".keymap"):
                        found.append((kind, os.path.join(path, sub)))

    wanted = {n.lower() for n in include}
    if not take_all:
        wanted |= build_yaml_names()
        # a board named eyelash_sofle_left also matches eyelash_sofle
        wanted |= {re.sub(r"_(left|right)$", "", n) for n in wanted}

    for root in (os.path.join(zmk_dir, "modules"),
                 os.path.join(zmk_dir, "zmk", "app", "boards")):
        if not os.path.isdir(root):
            continue
        in_tree = root.endswith(os.path.join("app", "boards"))
        for base, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d not in (".git", "build")]
            for fn in sorted(files):
                if not fn.endswith(".keymap"):
                    continue
                path = os.path.join(base, fn)
                if in_tree and not take_all:
                    stem = fn[:-len(".keymap")].lower()
                    if stem not in wanted and not any(
                            w and w in path.lower().split(os.sep) for w in wanted):
                        continue
                found.append(("vendor", path))

    seen, out = set(), []
    for kind, path in found:
        real = os.path.realpath(path)
        if real not in seen:
            seen.add(real)
            out.append((kind, path))
    return out


def layout_payload(layout):
    return {
        "label": layout.label,
        "display": layout.display_name,
        "source": layout.source,
        "count": layout.count,
        "keys": [list(k) for k in layout.keys],
    }


def transform_payload(tr):
    """Older keyboards have no physical layout - lay the RC() map out on a grid."""
    keys, i = [], 0
    for r, row in enumerate(tr.rows):
        for c, _cell in enumerate(row):
            keys.append([100, 100, c * 100, r * 100, 0, 0, 0])
            i += 1
    return {"label": tr.label, "display": "matrix transform", "source": tr.source,
            "count": len(keys), "keys": keys, "approximate": True}


def collect_data(args):
    roots = keypos.search_roots(args.root, args.zmk)
    layouts, transforms, chosen = keypos.collect(roots)

    entries = []
    for kind, path in discover(args.zmk, args.include, args.all):
        stem = os.path.basename(path)[: -len(".keymap")]
        data = parse_keymap(path)
        ls, ts, _name = keypos.resolve(path, roots, layouts, transforms, chosen)
        counts = {len(l["bindings"]) for l in data["layers"] if not l["reserved"]}
        opts = [layout_payload(l) for l in ls] + [transform_payload(t) for t in ts]
        # put a layout that matches the keymap's own binding count first
        if counts:
            opts.sort(key=lambda o: 0 if o["count"] in counts else 1)
        if not opts:
            data["warnings"].append(
                f"no physical layout found for '{stem}' - keys are laid out in "
                f"rows. Name the file after its keyboard "
                f"(e.g. eyelash_sofle-mine.keymap) or add a "
                f"'// zmk-keyboard: <board>' comment.")
            n = max(counts) if counts else 0
            opts = [{"label": "(guessed)", "display": "no layout found",
                     "source": "", "count": n, "approximate": True,
                     "keys": [[100, 100, (i % 12) * 100, (i // 12) * 100, 0, 0, 0]
                              for i in range(n)]}]
        for c in sorted(counts):
            if c != opts[0]["count"]:
                data["warnings"].append(
                    f"a layer has {c} bindings but the layout has "
                    f"{opts[0]['count']} keys")
        entries.append({
            "id": f"{kind}:{path}",
            "name": stem,
            "kind": kind,
            "path": path,
            "keyboard": _name,
            "layouts": opts,
            **data,
        })

    order = {"config": 0, "variant": 1, "vendor": 2}
    entries.sort(key=lambda e: (order.get(e["kind"], 3), e["name"], e["path"]))
    return {
        "generated": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "repo": os.path.basename(os.path.abspath(".")),
        "keymaps": entries,
    }
