"""Static checks for a ZMK keymap and for the build list that decides what
ships.

Catches the mistakes that otherwise cost a full firmware build.

In the keymap: wrong number of bindings in a layer, out-of-range key positions,
references to undefined behaviors, parameter counts that don't match
#binding-cells, and unbalanced braces/angle brackets.

In `build.yaml`: halves of a split keyboard built from different keymaps, a
leftover KEYMAP_FILE, a part the vendor builds that your entry leaves out, and
two entries producing the same firmware file.

Text in, findings out: `check_file()` and `check_build_list()` print a report
and return 1 if they found any ERROR. Neither writes anything - they print the
line to add, and you edit.

Usage:
    python3 -m vilemk.check config/eyelash_sofle.keymap [--keys 64]
    python3 -m vilemk.check          # build.yaml, then every keymap
    python3 -m vilemk.check --no-build-list

Exit status 1 if any ERROR was reported.
"""

from __future__ import annotations

import argparse
import glob
import os
import re
import sys
from typing import NamedTuple

from . import PROJECT_DIR, keypos
from .keypos import NODE_OPEN_RE, prop_value, strip_comments
from .keymap import (WORKSPACE_RE, find_build_yaml, parse_build_yaml,
                     read_text, split_half, vendor_build_entries)

# label -> #binding-cells, for behaviors ZMK defines in behaviors.dtsi / dt-bindings.
BUILTIN_CELLS = {
    "kp": 1, "kt": 1, "key_repeat": 0, "caps_word": 0, "gresc": 0,
    "trans": 0, "none": 0,
    "mo": 1, "to": 1, "tog": 1, "sl": 1, "sk": 1, "mt": 2, "lt": 2,
    "bt": 2, "out": 1, "rgb_ug": 2, "bl": 2, "ext_power": 1,
    "mkp": 1, "mmv": 1, "msc": 1,
    "sys_reset": 0, "bootloader": 0, "soft_off": 0, "studio_unlock": 0,
    "inc_dec_kp": 2, "inc_dec_cp": 2,
    "macro_tap": 0, "macro_press": 0, "macro_release": 0,
    "macro_pause_for_release": 0,
    "macro_tap_time": 1, "macro_wait_time": 1,
    "macro_param_1to1": 0, "macro_param_1to2": 0,
    "macro_param_2to1": 0, "macro_param_2to2": 0,
    # input listeners / nodes commonly referenced with & but never as bindings
    "mmv_input_listener": None, "msc_input_listener": None,
    "mkp_input_listener": None,
}

CELLS_BY_COMPATIBLE = {
    "zmk,behavior-key-press": 1,
    "zmk,behavior-key-toggle": 1,
    "zmk,behavior-hold-tap": 2,
    "zmk,behavior-tap-dance": 0,
    "zmk,behavior-mod-morph": 0,
    "zmk,behavior-sticky-key": 1,
    "zmk,behavior-macro": 0,
    "zmk,behavior-macro-one-param": 1,
    "zmk,behavior-macro-two-param": 2,
    "zmk,behavior-caps-word": 0,
}

# Node compatibles whose `bindings` are templates (`<&kp>, <&kp>`) rather than
# fully-specified invocations, so parameter arity must not be checked there.
TEMPLATE_COMPATIBLES = {
    "zmk,behavior-hold-tap",
    "zmk,behavior-sticky-key",
    "zmk,behavior-sensor-rotate-var",
}
ARITY_CHECKED_COMPATIBLES = {
    "zmk,behavior-tap-dance",
    "zmk,behavior-mod-morph",
    "zmk,behavior-macro",
    "zmk,behavior-macro-one-param",
    "zmk,behavior-macro-two-param",
}


class Report:
    def __init__(self, text: str, path: str):
        self.text = text
        self.path = path
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def line_of(self, pos: int) -> int:
        return self.text.count("\n", 0, max(pos, 0)) + 1

    def error(self, pos: int, msg: str) -> None:
        self.errors.append(f"{self.path}:{self.line_of(pos)}: ERROR {msg}")

    def warn(self, pos: int, msg: str) -> None:
        self.warnings.append(f"{self.path}:{self.line_of(pos)}: warning {msg}")


def check_balance(rep: Report, src: str) -> bool:
    ok = True
    stack = []
    for m in re.finditer(r"[{}]", src):
        if m.group() == "{":
            stack.append(m.start())
        elif stack:
            stack.pop()
        else:
            rep.error(m.start(), "unmatched '}'")
            ok = False
    for pos in stack:
        rep.error(pos, "unclosed '{' — missing '}'")
        ok = False
    depth = 0
    for m in re.finditer(r"[<>]", src):
        depth += 1 if m.group() == "<" else -1
        if depth < 0:
            rep.error(m.start(), "unmatched '>'")
            ok = False
            depth = 0
    if depth > 0:
        rep.error(len(src) - 1, f"{depth} unclosed '<' in a bindings/property value")
        ok = False
    return ok


def parse_nodes(src: str, start: int, end: int):
    """Yield (label, name, header_pos, body_start, body_end) for direct children.

    Not `keypos.node_bodies`, which walks every node at every depth and hands
    back the body text alone. Two things here need more than that: findings are
    reported at a byte offset, so the header position travels with each node,
    and a node's meaning depends on its parent (`combos` vs `behaviors` vs
    `keymap`), so the caller recurses itself to keep track of the path.
    """
    i = start
    while i < end:
        m = NODE_OPEN_RE.search(src, i, end)
        if not m:
            return
        depth, j = 0, m.end() - 1
        while j < end:
            if src[j] == "{":
                depth += 1
            elif src[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        if j >= end:
            return
        yield m.group(1), m.group(2), m.start(), m.end(), j
        i = j + 1


def find_roots(src: str):
    """Every top-level `/ { ... }` block — a keymap may legitimately have several."""
    roots = []
    for m in re.finditer(r"(?m)^[ \t]*/[ \t]*\{", src):
        depth, j = 0, m.end() - 1
        while j < len(src):
            if src[j] == "{":
                depth += 1
            elif src[j] == "}":
                depth -= 1
                if depth == 0:
                    roots.append((m.end(), j))
                    break
            j += 1
    return roots


def has_flag(body: str, name: str) -> bool:
    return re.search(r"(?<![\w-])" + re.escape(name) + r"\s*;", body) is not None


def collect_defines(src: str):
    """Split #defines into object-like (name -> text) and function-like
    (name -> body, used to spot keymap macros such as `AS(N1)` that expand to a
    whole binding)."""
    defines, funclike = {}, {}
    for m in re.finditer(r"(?m)^[ \t]*#[ \t]*define[ \t]+(\w+)(\()?[ \t]*(.*)$", src):
        if m.group(2):
            funclike[m.group(1)] = m.group(3)
        else:
            defines[m.group(1)] = m.group(3).strip()
    return defines, funclike


def load_zmk_defines(keymap_path: str):
    """Object-like #defines from ZMK's dt-bindings headers, if a local ZMK
    checkout is available. Needed because `RGB_ON`/`BT_CLR` expand to *two*
    parameters, which parameter-count checking must account for."""
    starts = [os.path.abspath(os.path.dirname(keymap_path) or "."), os.path.abspath(".")]
    for here in starts:
        found = _search_up(here)
        if found:
            return found
    return None, {}, None


def _search_up(here: str):
    for _ in range(6):
        cand = os.path.join(here, ".zmk", "zmk", "app", "include", "dt-bindings", "zmk")
        if os.path.isdir(cand):
            out, funcs = {}, {}
            for fn in sorted(os.listdir(cand)):
                if not fn.endswith(".h"):
                    continue
                try:
                    text = open(os.path.join(cand, fn), encoding="utf-8",
                                errors="replace").read()
                except OSError:
                    continue
                d, f = collect_defines(strip_comments(text))
                out.update(d)
                funcs.update(f)
            return out, funcs, cand
        parent = os.path.dirname(here)
        if parent == here:
            return None
        here = parent
    return None


# Fallback when no local ZMK checkout is present: these behaviors take commands
# that are themselves multi-token macros, so parameter counts can't be verified.
UNVERIFIABLE_WITHOUT_HEADERS = {"bt", "rgb_ug", "bl"}

# Defined outside dt-bindings/zmk/*.h (behaviors.dtsi and friends).
EXTRA_KNOWN_TOKENS = {"MACRO_PLACEHOLDER"}


def expand(token: str, defines: dict, seen=()) -> str:
    if token in defines and token not in seen:
        return " ".join(
            expand(t, defines, seen + (token,)) for t in defines[token].split()
        )
    return token


def count_args(text: str) -> int:
    """Number of whitespace-separated arguments at paren depth 0.

    `(ZMK_HID_USAGE(HID_USAGE_KEY, HID_USAGE_KEY_KEYBOARD_Q))` is one argument,
    while `BT_SEL_CMD 0` is two.
    """
    depth, n, in_arg = 0, 0, False
    for ch in text:
        if ch in "([":
            depth += 1
            if not in_arg:
                in_arg, n = True, n + 1
        elif ch in ")]":
            depth = max(depth - 1, 0)
        elif ch.isspace() and depth == 0:
            in_arg = False
        elif not in_arg:
            in_arg, n = True, n + 1
    return n


def numbers(value: str, defines: dict):
    """Parse a <...> list of integers, expanding object-like defines."""
    out, bad = [], []
    for tok in re.sub(r"[<>,]", " ", value).split():
        for t in expand(tok, defines).split():
            if re.fullmatch(r"-?\d+", t):
                out.append(int(t))
            elif re.fullmatch(r"0[xX][0-9a-fA-F]+", t):
                out.append(int(t, 16))
            else:
                bad.append(t)
    return out, bad


BINDING_GROUP_RE = re.compile(r"<([^<>]*)>", re.S)
TOKEN_RE = re.compile(r"&?[\w()|.+-]+")


def split_bindings(group: str, binding_macros=()):  # -> [(label, params, offset)]
    """Split one <...> group into individual bindings.

    A binding starts at an `&label` token, or at an invocation of a keymap macro
    that expands to a binding (e.g. `AS(N1)` from `#define AS(kc) &as LS(kc) kc`).

    Not `keypos.binding_tokens`, which joins each binding back into one string.
    Checking needs the pieces kept apart: the label to look up `#binding-cells`,
    the parameters to count against it, and the offset to report a finding at.
    A leading token with no `&` in front of it is an error to report here, not
    something to quietly attach to the binding before it, so it comes back as
    `(False, [token], offset)`.
    """
    out = []
    for m in TOKEN_RE.finditer(group.replace(",", " ")):
        tok = m.group()
        head = tok.split("(")[0]
        if tok.startswith("&"):
            out.append((tok[1:], [], m.start()))
        elif head in binding_macros:
            out.append((None, [], m.start()))       # macro-expanded binding
        elif out and out[-1][0] is not None:
            out[-1][1].append(tok)
        elif out:
            pass                                     # parameter of a macro binding
        else:
            out.append((False, [tok], m.start()))    # stray token before any binding
    return out


def detect_key_count(keymap_path, zmk_dir=None):
    """Key positions for the keyboard this keymap targets, from its physical
    layout (or matrix transform). Returns (count, note, alternatives)."""
    roots = keypos.search_roots(zmk_dir=zmk_dir)
    if not roots:
        return None, None, []
    layouts, transforms, chosen = keypos.collect(roots)
    ls, ts, _name = keypos.resolve(keymap_path, roots, layouts, transforms, chosen)
    picked = (ls or ts)
    if not picked:
        return None, None, []
    first = picked[0]
    others = [(o.label, o.count) for o in picked[1:] if o.count != first.count]
    kind = "physical layout" if ls else "matrix transform"
    return first.count, f"{kind} `{first.label}` ({first.source})", others


# ------------------------------------------------------------------ the checks
#
# `check_file()` reads the file once into a `KeymapFile`, then hands it to each
# check below in turn. They share a lot - the label table, the #defines, the key
# count - and every one of them needs the same `check_group()`, so that state is
# an object rather than a run of locals threaded through eight signatures.
#
# Findings go into `rep` in the order the checks run, so the order of the calls
# in `check_file()` is the order of the printed report.


class Node(NamedTuple):
    """One devicetree node as `index_nodes()` recorded it.

    `path` is the names of the nodes above it, so `["combos"]` means a combo and
    `[]` means a direct child of a root. `pos` is where its header starts, which
    is where a finding about the node as a whole is reported.
    """
    label: str
    name: str
    pos: int
    body: str
    path: list


class KeymapFile:
    """One keymap file, read once: everything the individual checks share.

    `nodes` is every node in the file paired with the node names above it, so a
    check can say "the combos" (`path == ["combos"]`) without walking the tree
    again. It is filled by `index_nodes()` and not written to afterwards.
    """

    def __init__(self, path, raw, src, args):
        self.path = path
        self.src = src
        self.args = args
        self.rep = Report(raw, os.path.relpath(path))

        self.defines, self.funclike = collect_defines(src)
        # A `#define` whose body contains `&` expands to a whole binding rather
        # than to a keycode, so an invocation of one counts as a binding.
        self.binding_macros = {n for n, body in self.funclike.items() if "&" in body}
        self.hdr_defines, hdr_funclike, _hdr_dir = load_zmk_defines(path)
        if self.hdr_defines:
            # The file's own #defines win over the headers' on a name clash.
            self.defines = {**self.hdr_defines, **self.defines}
            self.funclike = {**hdr_funclike, **self.funclike}

        detected, self.detect_note, self.alt_layouts = detect_key_count(path, args.zmk)
        self.expected_keys = args.keys or detected or 64
        if args.keys is None and detected is None:
            self.rep.warn(0, "could not find a physical layout for this keyboard; "
                             "assuming 64 key positions — pass --keys N if that is wrong")

        self.cells: dict[str, int | None] = dict(BUILTIN_CELLS)
        self.nodes: list[Node] = []
        self.layers = []     # (name, header_pos, body), in keymap order

    @property
    def n_layers(self) -> int:
        return len(self.layers)

    def nodes_at(self, *parents):
        """Every indexed node whose immediate parent is one of `parents`."""
        return (n for n in self.nodes if n.path and n.path[-1] in parents)

    def nodes_under(self, path):
        """Every indexed node at exactly this node path, e.g. `["combos"]`."""
        return (n for n in self.nodes if n.path == path)

    def check_group(self, group_pos, where, group, check_arity=True):
        """Check one `<...>` group: every `&label` in it is defined, takes the
        number of parameters its `#binding-cells` says, is given keycodes that
        exist, and does not target a layer that was never declared."""
        rep = self.rep
        for lbl, params, toff in split_bindings(group, self.binding_macros):
            if not lbl:
                continue
            pos = group_pos + toff
            if lbl not in self.cells:
                rep.error(pos, f"{where}: `&{lbl}` is not defined in this file and is not "
                               "a built-in ZMK behavior")
                continue
            want = self.cells.get(lbl)
            if check_arity and want is not None:
                self._check_arity(pos, where, lbl, params, want)
            if self.hdr_defines:
                self._check_keycodes(pos, where, lbl, params)
            if lbl in ("mo", "to", "tog", "sl", "lt") and params:
                nums, _ = numbers(params[0], self.defines)
                if nums and nums[0] >= self.n_layers:
                    rep.error(pos, f"{where}: `&{lbl} {nums[0]}` targets layer {nums[0]} "
                                   f"but only {self.n_layers} layer(s) are defined "
                                   f"(0–{self.n_layers - 1})")

    def _check_arity(self, pos, where, lbl, params, want):
        if self.hdr_defines is None and lbl in UNVERIFIABLE_WITHOUT_HEADERS:
            n_params = want      # cannot expand command macros; skip
        else:
            n_params = sum(count_args(expand(p, self.defines)) for p in params)
        if n_params != want:
            self.rep.error(pos, f"`&{lbl}` in {where} takes {want} parameter(s) but got "
                                f"{n_params} ({' '.join(params) or 'none'})")

    def _check_keycodes(self, pos, where, lbl, params):
        for prm in params:
            if prm in EXTRA_KNOWN_TOKENS:
                continue
            if "(" in prm or re.fullmatch(r"-?\d+|0[xX][0-9a-fA-F]+", prm):
                continue
            if prm in self.defines or prm in self.funclike:
                continue
            self.rep.error(pos, f"`&{lbl}` in {where}: `{prm}` is not a known keycode "
                                "or #define — check spelling against "
                                "dt-bindings/zmk/keys.h")

    def positions_in_range(self, pos, what, nums):
        for v in nums:
            if not 0 <= v < self.expected_keys:
                self.rep.error(pos, f"{what}: key position {v} out of range "
                                    f"0–{self.expected_keys - 1}")


def index_nodes(km: KeymapFile, roots) -> None:
    """Walk every root and record each node, its path, and what it can be bound as.

    This is the pass that builds the label table the arity checks read, so it
    has to finish before any of them start: a behavior may be used above the
    line that defines it.
    """
    def walk(start, end, path):
        for label, name, hpos, bs, be in parse_nodes(km.src, start, end):
            body = km.src[bs:be]
            km.nodes.append(Node(label, name, hpos, body, path))
            if label:
                if label in seen_labels:
                    km.rep.error(hpos, f"duplicate node label `{label}:`")
                seen_labels[label] = hpos
                cells = _binding_cells(km, body)
                if cells is _UNKNOWN:
                    # Nothing says how it binds. Leave any built-in of the same
                    # name alone - a node labelled `mmv` is overriding it, not
                    # redefining what it takes.
                    km.cells.setdefault(label, None)
                else:
                    km.cells[label] = cells
            walk(bs, be, path + [name])

    seen_labels: dict[str, int] = {}
    for r_start, r_end in roots:
        walk(r_start, r_end, [])
    km.layers = [(n.name, n.pos, n.body) for n in km.nodes_under(["keymap"])]


_UNKNOWN = object()      # "the file does not say", as distinct from "takes none"


def _binding_cells(km: KeymapFile, body: str):
    """How many parameters a labelled node takes: its own `#binding-cells`, else
    the count implied by its `compatible`, else `_UNKNOWN`."""
    bc, _ = prop_value(body, "#binding-cells")
    if bc is not None:
        nums, _ = numbers(bc, km.defines)
        return nums[0] if nums else None
    comp = _compatible(body)
    if comp in CELLS_BY_COMPATIBLE:
        return CELLS_BY_COMPATIBLE[comp]
    return _UNKNOWN


def _compatible(body: str):
    comp, _ = prop_value(body, "compatible")
    return comp.strip().strip('"') if comp else None


def check_behavior_nodes(km: KeymapFile) -> None:
    """A node under `behaviors`/`macros` must say what it is and how it binds."""
    for node in km.nodes_at("behaviors", "macros"):
        name, hpos, body = node.name, node.pos, node.body
        comp = _compatible(body)
        if not node.label and comp is None:
            # A node with neither label nor compatible only overrides properties
            # of an existing behavior of the same name (devicetree merges by path),
            # e.g. the `mmv { acceleration-exponent = <1>; }` block in this keymap.
            if name not in BUILTIN_CELLS:
                km.rep.warn(hpos, f"node `{name}` overrides no known built-in behavior "
                                  "and defines none (no `label:`, no `compatible`)")
            continue
        if comp is None:
            km.rep.error(hpos, f"node `{name}` is missing a `compatible` property")
        if prop_value(body, "#binding-cells")[0] is None:
            km.rep.error(hpos, f"node `{name}` is missing `#binding-cells`")
        if not node.label:
            km.rep.warn(hpos, f"node `{name}` has no `label:` — it cannot be bound with &")
        if prop_value(body, "bindings")[0] is None and comp \
                and "macro-control" not in comp:
            km.rep.error(hpos, f"node `{name}` is missing `bindings`")


def check_layer_sizes(km: KeymapFile) -> None:
    """Every layer must bind every key position - ZMK has no short layer."""
    if not km.layers:
        km.rep.warn(0, "no layers found under `keymap` — is the node named `keymap`?")

    for idx, (name, hpos, body) in enumerate(km.layers):
        if re.search(r'status\s*=\s*"reserved"', body):
            continue
        value, off = prop_value(body, "bindings")
        if value is None:
            km.rep.error(hpos, f"layer `{name}` has no `bindings`")
            continue
        count = 0
        for lbl, params, toff in split_bindings(value, km.binding_macros):
            if lbl is False:
                km.rep.error(hpos + off + toff,
                             f"layer `{name}`: token `{params[0]}` is not preceded by an "
                             "`&behavior` (missing `&`?)")
            else:
                count += 1
        if count != km.expected_keys:
            km.rep.error(hpos + off,
                         f"layer `{name}` (index {idx}) has {count} bindings, expected "
                         f"{km.expected_keys} — every layer must cover all key positions")


def check_layer_bindings(km: KeymapFile) -> None:
    """Arity and keycodes for what the layers bind, including encoders."""
    for name, hpos, body in km.layers:
        value, off = prop_value(body, "bindings")
        if value:
            km.check_group(hpos + off, f"layer `{name}`", value)
        sensor, soff = prop_value(body, "sensor-bindings")
        if sensor:
            km.check_group(hpos + soff, f"layer `{name}` sensor-bindings", sensor,
                           check_arity=False)


def check_behavior_bindings(km: KeymapFile) -> None:
    """The same, for what user-defined behaviors and macros bind themselves.

    Arity depends on the compatible: a hold-tap's `bindings` are templates
    (`<&kp>, <&kp>`) that take their parameters from the key, so counting them
    against `#binding-cells` would report every one of them.
    """
    for node in km.nodes_at("behaviors", "macros"):
        name, hpos, body = node.name, node.pos, node.body
        comp = _compatible(body) or ""
        value, off = prop_value(body, "bindings")
        if not value:
            continue
        do_arity = comp in ARITY_CHECKED_COMPATIBLES
        for group in BINDING_GROUP_RE.findall(value):
            km.check_group(hpos + off, f"`{name}`", group, check_arity=do_arity)
        _check_hold_trigger(km, name, hpos, body)


def _check_hold_trigger(km: KeymapFile, name, hpos, body) -> None:
    """`hold-trigger-key-positions` names real keys, and is there at all if
    `hold-trigger-on-release` is."""
    htkp, hoff = prop_value(body, "hold-trigger-key-positions")
    if not htkp:
        return
    nums, bad = numbers(htkp, km.defines)
    for b in bad:
        km.rep.error(hpos + hoff, f"`{name}`: hold-trigger-key-positions contains "
                                  f"non-numeric `{b}` (undefined macro?)")
    km.positions_in_range(hpos + hoff, f"`{name}`", nums)
    # FIXME: unreachable - `htkp` is falsy above, so this never fires. To make it
    # work the test has to move out of this function, which is only entered when
    # hold-trigger-key-positions is present. Left as-is so the split changed no
    # output; fixing it will add warnings to keymaps that are quiet today.
    if has_flag(body, "hold-trigger-on-release") and not htkp:
        km.rep.warn(hpos, f"`{name}`: hold-trigger-on-release without "
                          "hold-trigger-key-positions has no effect")


def check_combos(km: KeymapFile) -> int:
    """Key positions, bindings and layers of every combo. Returns how many
    distinct position sets were seen, which is what the summary counts."""
    combo_sets: dict[frozenset, str] = {}
    for node in km.nodes_under(["combos"]):
        name, hpos, body = node.name, node.pos, node.body
        _check_combo_positions(km, name, hpos, body, combo_sets)
        _check_combo_binding(km, name, hpos, body)
        if prop_value(body, "timeout-ms")[0] is None:
            km.rep.warn(hpos, f"combo `{name}` has no `timeout-ms` (defaults to 50 ms)")
        lay, loff = prop_value(body, "layers")
        if lay:
            nums, _ = numbers(lay, km.defines)
            for v in nums:
                if v >= km.n_layers:
                    km.rep.error(hpos + loff, f"combo `{name}`: layer {v} does not exist")

    # The node itself is easy to write without its compatible, and then none of
    # the combos inside it exist as far as the firmware is concerned.
    for node in km.nodes_under([]):
        if node.name == "combos" and \
                'compatible = "zmk,combos"' not in node.body.replace("'", '"'):
            km.rep.error(node.pos, '`combos` node is missing `compatible = "zmk,combos";`')
    return len(combo_sets)


def _check_combo_positions(km: KeymapFile, name, hpos, body, combo_sets) -> None:
    kp, koff = prop_value(body, "key-positions")
    if kp is None:
        km.rep.error(hpos, f"combo `{name}` has no `key-positions`")
        return
    nums, bad = numbers(kp, km.defines)
    for b in bad:
        km.rep.error(hpos + koff, f"combo `{name}`: non-numeric key position `{b}`")
    km.positions_in_range(hpos + koff, f"combo `{name}`", nums)
    if len(nums) < 2:
        km.rep.error(hpos + koff, f"combo `{name}` needs at least 2 key positions")
    if len(set(nums)) != len(nums):
        km.rep.error(hpos + koff, f"combo `{name}` repeats a key position")
    key = frozenset(nums)
    if key in combo_sets:
        km.rep.warn(hpos, f"combo `{name}` uses the same key positions as "
                          f"`{combo_sets[key]}`")
    else:
        combo_sets[key] = name


def _check_combo_binding(km: KeymapFile, name, hpos, body) -> None:
    value, boff = prop_value(body, "bindings")
    if value is None:
        km.rep.error(hpos, f"combo `{name}` has no `bindings`")
        return
    km.check_group(hpos + boff, f"combo `{name}`", value)
    if len(split_bindings(value, km.binding_macros)) != 1:
        km.rep.error(hpos + boff, f"combo `{name}`: `bindings` must contain exactly "
                                  "one behavior")


def check_conditional_layers(km: KeymapFile) -> None:
    """Both halves present, layers that exist, and a then-layer above the ifs -
    a lower then-layer is shadowed by the if-layers that activate it."""
    for node in km.nodes_under(["conditional_layers"]):
        name, hpos, body = node.name, node.pos, node.body
        ifl, _ioff = prop_value(body, "if-layers")
        thl, _toff = prop_value(body, "then-layer")
        if ifl is None or thl is None:
            km.rep.error(hpos, f"conditional layer `{name}` needs both `if-layers` and "
                               "`then-layer`")
            continue
        ifs, _ = numbers(ifl, km.defines)
        ths, _ = numbers(thl, km.defines)
        for v in ifs + ths:
            if v >= km.n_layers:
                km.rep.error(hpos, f"conditional layer `{name}` references layer {v}, "
                                   f"but only {km.n_layers} layer(s) exist")
        if ths and ifs and ths[0] <= max(ifs):
            km.rep.warn(hpos, f"conditional layer `{name}`: then-layer {ths[0]} should be "
                              f"higher than every if-layer {ifs}")


def print_report(km: KeymapFile, n_combos: int) -> None:
    for line in km.rep.errors:
        print(line)
    for line in km.rep.warnings:
        print(line)
    print()
    src_note = f" from {km.detect_note}" if km.detect_note and km.args.keys is None else ""
    print(f"{km.n_layers} layer(s), {n_combos} combo(s), "
          f"{km.expected_keys} key positions per layer{src_note}")
    for label, count in km.alt_layouts:
        print(f"note: this keyboard also has layout `{label}` with {count} keys — "
              "pass --keys if that is the one you build")
    if km.hdr_defines is None:
        print("note: no local ZMK checkout found (.zmk/zmk); parameter counts for "
              "&bt/&rgb_ug/&bl were not verified")
    print(f"{len(km.rep.errors)} error(s), {len(km.rep.warnings)} warning(s)")


def check_text(path, raw, args):
    """Run every check over one keymap -> (KeymapFile, combo count, stopped).

    Prints nothing. `stopped` names what ended the run early (`"brackets"`,
    `"no root"`) and is empty when every check ran. Brackets are checked first
    and alone: with an unbalanced brace the node boundaries are wrong and every
    later check reports against the wrong lines.
    """
    src = strip_comments(raw)
    km = KeymapFile(path, raw, src, args)

    if not check_balance(km.rep, src):
        return km, 0, "brackets"

    roots = find_roots(src)
    if not roots:
        km.rep.error(0, "no root node `/ { ... }` found")
        return km, 0, "no root"

    index_nodes(km, roots)
    check_behavior_nodes(km)
    check_layer_sizes(km)
    check_layer_bindings(km)
    check_behavior_bindings(km)
    n_combos = check_combos(km)
    check_conditional_layers(km)
    return km, n_combos, ""


def check_file(path, args) -> int:
    """Run every check over one keymap, print the report, return 1 on any ERROR."""
    raw = open(path, encoding="utf-8").read()
    km, n_combos, stopped = check_text(path, raw, args)

    if stopped:
        print("\n".join(km.rep.errors))
        if stopped == "brackets":
            print("\nFix the bracket errors first; the remaining checks were skipped.")
        return 1

    print_report(km, n_combos)
    return 1 if km.rep.errors else 0


# ------------------------------------------------------------------ build list
#
# `build.yaml` decides what actually gets built; the keymap checks above never
# see it. Everything here is the second half of that: read the build list, the
# vendor's own build list from `.zmk/modules`, and `config/`, and report the
# mistakes that otherwise cost a firmware build ending in a compiler error that
# names nothing useful.
#
# Read-only, like every other tool here. It prints the line to add; the user
# edits.

# A shield whose name says "screen". Dropping one of these is the common
# deliberate choice (a board sold with and without a display), so it is checked
# against the board's own defconfig rather than reported on sight.
DISPLAY_SHIELD_RE = re.compile(r"nice_view|nice_oled|oled|display|epaper", re.I)


_DEFCONFIG_CACHE = {}


def _defconfig_turns_on(zmk_dir: str, board: str, symbol: str) -> bool:
    """Does the board's own defconfig switch `symbol` on for everyone?

    This is what makes a missing `shield:` fail rather than just build a
    smaller keyboard: the board says it has a screen, so the build goes looking
    for one.
    """
    key = (zmk_dir, board, symbol)
    if key in _DEFCONFIG_CACHE:
        return _DEFCONFIG_CACHE[key]
    pat = re.compile(r"(?m)^[ \t]*" + re.escape(symbol) + r"[ \t]*=[ \t]*y\b")
    wanted = {f"{board}_defconfig", f"{board}.conf", f"{board}.defconfig"}
    hit = False
    for root in (os.path.join(zmk_dir or ".zmk", "modules"),
                 os.path.join(zmk_dir or ".zmk", "zmk", "app", "boards")):
        for base, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d not in (".git", "build")]
            for fn in files:
                if fn in wanted and pat.search(read_text(os.path.join(base, fn))):
                    hit = True
                    break
            if hit:
                break
        if hit:
            break
    _DEFCONFIG_CACHE[key] = hit
    return hit


def _conf_turns_off(board: str, symbol: str):
    """Your own `config/<board>.conf` switching a board-wide feature back off."""
    pat = re.compile(r"(?m)^[ \t]*" + re.escape(symbol) + r"[ \t]*=[ \t]*n\b")
    base, _half = split_half(board)
    for cand in dict.fromkeys([os.path.join("config", f"{board}.conf"),
                               os.path.join("config", f"{base}.conf")]):
        if os.path.isfile(cand) and pat.search(read_text(cand)):
            return cand
    return None


def check_build_list(args) -> int:
    """Check `build.yaml` against the vendor's build list and against `config/`.

    A repo with no build list, or one whose keyboards have no vendor module, is
    silence - plenty of setups are one board with one plain entry and there is
    nothing to say about those.
    """
    path = find_build_yaml()
    if not path:
        return 0
    text = read_text(path)
    rep = Report(text, os.path.relpath(path))
    zmk_dir = args.zmk or ".zmk"
    entries = parse_build_yaml(text)
    vendor = vendor_build_entries(zmk_dir)
    notes = []

    # ---- KEYMAP_FILE: the build supplies it, so any here is dead -------------
    for e in entries:
        raw = e.keymap_file()
        if raw is None:
            continue
        why = ("`${GITHUB_WORKSPACE}` is a GitHub Actions path and is not set here; "
               if WORKSPACE_RE.search(raw) else "")
        rep.warn(e.at("cmake-args"),
                 f"KEYMAP_FILE `{raw}`: {why}building a variant names its own keymap "
                 "and drops this flag, so it has no effect — remove it")

    # ---- parts the vendor builds that your entry leaves out -------------------
    # The vendor's *default* entry per board: the first plain one. A `snippet:`
    # or an `artifact-name:` marks an extra build (ZMK Studio, a reset firmware),
    # not what the keyboard is. Utility shields are already gone - see
    # `vendor_build_entries()`.
    default = {}
    for v in vendor:
        if v.get("snippet") or v.get("artifact-name") or not v.board:
            continue
        default.setdefault(v.board, v)

    for e in entries:
        v = default.get(e.board)
        if not v:
            continue
        for s in v.shields:
            if s in e.shields:
                continue
            if not DISPLAY_SHIELD_RE.search(s):
                rep.warn(e.pos,
                         f"the vendor builds `{e.board}` with `shield: {s}`; your entry "
                         "has none — that part is left out of the build")
                continue
            # A screen is the one part people drop on purpose. Only a board that
            # turns the display on by itself actually breaks without it.
            if not _defconfig_turns_on(zmk_dir, e.board, "CONFIG_ZMK_DISPLAY"):
                continue
            conf = _conf_turns_off(e.board, "CONFIG_ZMK_DISPLAY")
            if conf:
                notes.append(f"`{e.board}` drops the vendor's `shield: {s}` and "
                             f"{conf} turns the display off — screenless on purpose")
                continue
            rep.warn(e.pos,
                     f"`{e.board}` drops the vendor's `shield: {s}` and nothing turns "
                     f"the screen off — the board's own defconfig has "
                     f"CONFIG_ZMK_DISPLAY=y, so the build goes looking for hardware "
                     f"that is not there. Add the shield back, or put "
                     f"`CONFIG_ZMK_DISPLAY=n` in config/{e.board}.conf")

    # ---- two entries writing the same firmware file --------------------------
    outputs = {}
    for e in entries:
        outputs.setdefault(e.artifact(), []).append(e)
    for name, es in sorted(outputs.items()):
        if len(es) > 1 and name:
            rep.error(es[1].pos,
                      f"{len(es)} entries all build `{name}` — they write the same "
                      "firmware file and only one survives. Give the extra ones an "
                      "`artifact-name:`")

    # ---- keymaps in config/ that nothing builds ------------------------------
    for km in sorted(glob.glob(os.path.join("config", "*.keymap"))):
        stem = os.path.basename(km)[: -len(".keymap")].lower()
        matching = [e for e in entries
                    if stem in {e.board.lower(), split_half(e.board)[0].lower()}
                    or stem in {s.lower() for s in e.shields}]
        if not matching:
            notes.append(f"{km} is built by nothing in {rep.path}, and its name matches "
                         "no board or shield — parked on purpose, or a typo")

    # ---- report --------------------------------------------------------------
    print(f"\n{'=' * 72}\n{rep.path}\n{'=' * 72}")
    for line in rep.errors:
        print(line)
    for line in rep.warnings:
        print(line)
    if rep.errors or rep.warnings:
        print()
    print(f"{len(entries)} build entr{'y' if len(entries) == 1 else 'ies'}, "
          f"{len(vendor)} vendor entr{'y' if len(vendor) == 1 else 'ies'} compared")
    if not vendor:
        print(f"note: no vendor build list under {os.path.join(zmk_dir, 'modules')}; "
              "missing shields were not checked")
    for line in notes:
        print(f"note: {line}")
    print(f"{len(rep.errors)} error(s), {len(rep.warnings)} warning(s)")
    return 1 if rep.errors else 0


# --------------------------------------------------------------------- command

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("keymap", nargs="*",
                    help="keymap file(s) to check; with none, checks every keymap in "
                         "the repo's config/ and variants/")
    ap.add_argument("--keys", type=int, default=None,
                    help="expected bindings per layer (default: from the keyboard's "
                         "physical layout)")
    ap.add_argument("--zmk", help="path to the ZMK cache (default ./.zmk)")
    ap.add_argument("--no-build-list", action="store_true",
                    help="skip the build.yaml checks (keymaps only)")
    args = ap.parse_args()

    targets = [os.path.abspath(k) if os.path.exists(k) else k for k in args.keymap]
    os.chdir(PROJECT_DIR)

    if not targets:
        targets = (sorted(glob.glob("config/*.keymap"))
                   + sorted(glob.glob("variants/*.keymap"))
                   + sorted(glob.glob(os.path.join("variants", "*", "*.keymap"))))
        if not targets:
            print("no keymaps found in config/ or variants/", file=sys.stderr)
            return 1
    if args.keys is not None and len(targets) > 1:
        print("--keys describes one keyboard; pass a single keymap with it",
              file=sys.stderr)
        return 2

    bad = 0
    if not args.no_build_list:
        bad |= check_build_list(args)

    for path in targets:
        if len(targets) > 1 or not args.no_build_list:
            print(f"\n{'=' * 72}\n{os.path.relpath(path)}\n{'=' * 72}")
        bad |= check_file(path, args)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
