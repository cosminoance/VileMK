"""Named VileDances, macros, combos, modifiers and layer entries designed in the UI,
stored under `custom/`.

One JSON file per item - `custom/viledance/<name>.json`, `custom/macro/<name>.json`,
`custom/combo/<name>.json`, `custom/modifier/<name>.json` and
`custom/layer/<name>.json` - so they diff, merge and can be hand-edited when the UI
can't say it. This module owns the schema, the validation,
and the translation into devicetree.

A **VileDance** is VileMK's own construct, not a ZMK behavior. It is deliberately
not called a tap-dance: ZMK's `zmk,behavior-tap-dance` indexes only by *press
count*, so it cannot on its own tell a hold from a tap. Vial's four-slot key can,
and reproducing that shape takes a composition of two ZMK behaviors. Naming ours
after Vial's would send the next reader looking for a single ZMK behavior with
four slots, which does not exist - and inventing one (`zmk,behavior-tap-dance-
extended`) is a popular wrong answer on the internet.

The composition, and why it nests in this direction and not the other:

  Vial slot        ZMK
  ---------        ---
  on tap           \\
  on hold           }  one `zmk,behavior-hold-tap` (hold binding first)
  on double tap    \\
  on tap + hold     }  a second hold-tap
                       ...both held by a `zmk,behavior-tap-dance`

Press count is the *outer* discriminator and duration the inner one, which is
what yields four outcomes (2 counts x 2 durations). A hold-tap on the outside
would decide duration once, on the first press, collapsing `on hold` and
`on tap + hold` into the same result - three outcomes, not four.

It also only compiles in this direction. A tap-dance's `bindings` is a
phandle-array, so its entries may carry their own parameters
(`<&ht_x LSHIFT BSPC>`). A hold-tap's `bindings` is a plain phandle list
(`type: phandles`), so its two entries take the parameters given at the key
instead - which is why a hold-tap slot needs behaviors of exactly one parameter
each, and why a zero-parameter tap-dance can never sit inside a hold-tap.
"""

from __future__ import annotations

import json
import os
import re

from . import PROJECT_DIR, keymap
from .check import DISPLAY_SHIELD_RE, _conf_turns_off, _defconfig_turns_on
CUSTOM_DIR = os.path.join(PROJECT_DIR, "custom")
DIRS = {"viledance": os.path.join(CUSTOM_DIR, "viledance"),
        "combo": os.path.join(CUSTOM_DIR, "combo"),
        "modifier": os.path.join(CUSTOM_DIR, "modifier"),
        "layer": os.path.join(CUSTOM_DIR, "layer"),
        "macro": os.path.join(CUSTOM_DIR, "macro")}

VILE_SLOTS = ("tap", "hold", "double_tap", "tap_hold")
FLAVORS = ("hold-preferred", "balanced", "tap-preferred", "tap-unless-interrupted")
# https://zmk.dev/docs/keymaps/modifiers - left/right shift, control, alt, gui.
MODS = ("LS", "RS", "LC", "RC", "LA", "RA", "LG", "RG")
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_]*$")
# See emit_viledance() for why the two rows do not share a flavor.
SECOND_ROW_FLAVOR = "balanced"

BEGIN_MARK = "// BEGIN vilemk custom - generated, edits here are overwritten"
END_MARK = "// END vilemk custom"
# The records the block was generated from, so import can restore them. Must
# stay on one line: `//` ends at the newline, and `/* */` is unusable because a
# macro's `text` step can contain `*/`.
RECORDS_MARK = "// vilemk-records: "


# ------------------------------------------------------------------ storage

def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(name).strip().lower()).strip("_")


# ------------------------------------------------------------------- scopes
# A combo and a conditional layer go on no key, so nothing in a keymap can ever
# reference one and the "only what a key uses" rule cannot decide whether to
# write it. The decision is made per *keymap file* instead: `scopes` on the
# record is `{scope_key: true}`, and a scope key is `<kind>:<file stem>` - the
# same identity the page's sidebar shows, stable across repo moves in a way an
# absolute path is not. Absent or false means off; there is no board-wide
# default, so a record created today is off everywhere until it is switched on.
def scope_key(kind: str, name: str) -> str:
    return f"{kind}:{slug(name)}"


def scoped_on(rec: dict, scope: str) -> bool:
    return bool(scope) and bool((rec.get("scopes") or {}).get(scope))


def path_for(kind: str, name: str) -> str:
    return os.path.join(DIRS[kind], f"{slug(name)}.json")


def load_all(kind: str) -> list:
    out = []
    d = DIRS[kind]
    if not os.path.isdir(d):
        return out
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(d, fn), encoding="utf-8") as fh:
                rec = json.load(fh)
        except (OSError, ValueError) as exc:
            out.append({"name": fn[:-5], "kind": kind, "broken": str(exc)})
            continue
        rec.setdefault("name", fn[:-5])
        rec["kind"] = kind
        out.append(rec)
    return out


def load_everything() -> dict:
    return {k: load_all(k) for k in DIRS}


def save(kind: str, rec: dict) -> str:
    name = slug(rec.get("name", ""))
    if not NAME_RE.match(name or ""):
        raise ValueError("name must be letters, digits and underscores")
    rec["name"] = name
    rec.pop("kind", None)
    os.makedirs(DIRS[kind], exist_ok=True)
    p = path_for(kind, name)
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(rec, fh, indent=2, sort_keys=True)
        fh.write("\n")
    return p


def delete(kind: str, name: str) -> bool:
    p = path_for(kind, name)
    if os.path.isfile(p):
        os.remove(p)
        return True
    return False


# ------------------------------------------------------------- binding bits

def split_binding(text: str):
    """`&kp LS(A)` -> ("&kp", ["LS(A)"]). Parameters may contain parentheses."""
    toks, depth, cur = [], 0, ""
    for ch in str(text).strip():
        if ch in "([":
            depth += 1
        elif ch in ")]":
            depth -= 1
        if ch.isspace() and depth == 0:
            if cur:
                toks.append(cur)
                cur = ""
            continue
        cur += ch
    if cur:
        toks.append(cur)
    if not toks:
        return "", []
    head = toks[0] if toks[0].startswith("&") else "&" + toks[0]
    return head, toks[1:]


def arity(binding: str) -> int:
    return len(split_binding(binding)[1])


def normalise(text: str) -> str:
    head, params = split_binding(text)
    return " ".join([head] + params) if head else ""


# ------------------------------------------------------------ devicetree out

class EmitError(ValueError):
    pass


def _holdtap(label, hold, tap, term, flavor, extra=""):
    """A hold-tap node plus the parameterised reference that uses it."""
    for side, b in (("hold", hold), ("tap", tap)):
        if arity(b) != 1:
            raise EmitError(
                f"`{b}` takes {arity(b)} parameter(s); a hold-tap {side} slot needs "
                "a behavior of exactly one, e.g. &kp / &mo / &sk. Wrap a 0-parameter "
                "behavior in a `zmk,behavior-macro-one-param` first.")
    hb, hp = split_binding(hold)
    tb, tp = split_binding(tap)
    node = (f"        {label}: {label} {{\n"
            f"            compatible = \"zmk,behavior-hold-tap\";\n"
            f"            #binding-cells = <2>;\n"
            f"            tapping-term-ms = <{term}>;\n"
            f"            flavor = \"{flavor}\";\n"
            f"{extra}"
            f"            bindings = <{hb}>, <{tb}>;\n"
            f"        }};\n")
    return node, f"&{label} {hp[0]} {tp[0]}"


def emit_viledance(rec: dict):
    """-> (nodes, key_binding). `key_binding` is what you put on a key.

    The second-press hold-tap gets `SECOND_ROW_FLAVOR` rather than the record's
    own `flavor`. They want opposite things: the first press is in the typing
    path, so an interrupting key there must resolve to a *tap* or fast typing
    produces stray modifiers - `tap-preferred`. The second press is already a
    deliberate gesture, and its hold is usually a layer, which is only useful if
    it engages as soon as the next key arrives instead of waiting out the timer -
    `balanced`. Set `flavor_tap_hold` in the JSON to override it by hand.
    """
    name = slug(rec.get("name", ""))
    if not name:
        raise EmitError("VileDance has no name")
    tap = normalise(rec.get("tap", ""))
    hold = normalise(rec.get("hold", ""))
    dbl = normalise(rec.get("double_tap", ""))
    th = normalise(rec.get("tap_hold", ""))
    term = int(rec.get("tapping_term_ms") or 200)
    flavor = rec.get("flavor") or "tap-preferred"
    if flavor not in FLAVORS:
        raise EmitError(f"flavor must be one of {', '.join(FLAVORS)}")
    flavor2 = rec.get("flavor_tap_hold") or SECOND_ROW_FLAVOR
    if flavor2 not in FLAVORS:
        raise EmitError(f"flavor_tap_hold must be one of {', '.join(FLAVORS)}")
    if not tap:
        raise EmitError("`on tap` is required")
    if th and not dbl:
        raise EmitError("`on tap + hold` needs `on double tap` filled in too - they "
                        "are the two halves of the same second-tap behavior")

    if not dbl and not th:
        if not hold:
            # Nothing to build: it is just a key.
            return "", tap
        node, ref = _holdtap(f"ht_{name}", hold, tap, term, flavor)
        return node, ref

    nodes = ""
    if hold:
        n, first = _holdtap(f"ht_{name}_1", hold, tap, term, flavor)
        nodes += n
    else:
        first = tap
    if th:
        n, second = _holdtap(f"ht_{name}_2", th, dbl, term, flavor2)
        nodes += n
    else:
        second = dbl
    nodes += (f"        vd_{name}: vd_{name} {{\n"
              f"            compatible = \"zmk,behavior-tap-dance\";\n"
              f"            #binding-cells = <0>;\n"
              f"            tapping-term-ms = <{term}>;\n"
              f"            bindings = <{first}>, <{second}>;\n"
              f"        }};\n")
    return nodes, f"&vd_{name}"


def emit_combo(rec: dict) -> str:
    name = slug(rec.get("name", ""))
    positions = [int(p) for p in rec.get("key_positions") or []]
    binding = normalise(rec.get("binding", ""))
    if len(positions) < 2:
        raise EmitError("a combo needs at least two key positions")
    if not binding:
        raise EmitError("`output key` is required")
    body = (f"        combo_{name} {{\n"
            f"            timeout-ms = <{int(rec.get('timeout_ms') or 50)}>;\n"
            f"            key-positions = <{' '.join(str(p) for p in positions)}>;\n"
            f"            bindings = <{binding}>;\n")
    layers = rec.get("layers")
    if layers:
        body += f"            layers = <{' '.join(str(int(l)) for l in layers)}>;\n"
    if rec.get("require_prior_idle_ms"):
        body += f"            require-prior-idle-ms = <{int(rec['require_prior_idle_ms'])}>;\n"
    if rec.get("slow_release"):
        body += "            slow-release;\n"
    return body + "        };\n"


def emit_modifier(rec: dict):
    """-> (nodes, key_binding). `nodes` is always "" - modifiers are macros, not
    devicetree behaviors, so there is nothing to declare, only the resolved
    reference to put on a key.

    `mods` nests outermost-first: ["LS","LA","LC"] wraps innermost-out into
    `LS(LA(LC(<code>)))` - the order the UI's modifier keyboard is clicked in, and
    the order the on-screen chain reads left to right.
    """
    name = slug(rec.get("name", ""))
    if not name:
        raise EmitError("modifier has no name")
    mods = rec.get("mods") or []
    if not (1 <= len(mods) <= 3):
        raise EmitError("pick 1 to 3 modifiers")
    bad = [m for m in mods if m not in MODS]
    if bad:
        raise EmitError(f"unknown modifier {bad[0]!r} - must be one of {', '.join(MODS)}")
    param = normalise(rec.get("param", ""))
    if not param:
        raise EmitError("parameter is required")
    head, params = split_binding(param)
    if head != "&kp" or len(params) != 1:
        raise EmitError(
            f"`{param}` is not a keycode - a modifier can only wrap a plain key or "
            "another modifier, not a behavior like a VileDance")
    code = params[0]
    for m in reversed(mods):
        code = f"{m}({code})"
    return "", f"&kp {code}"


# ------------------------------------------------------------------- macros
# A macro is a *sequence*, which is what makes it the one kind here whose record
# is a list rather than a handful of fields. Each step is one of six actions:
#
#   tap / press / release   a control plus a binding - `&macro_tap &kp A`
#   wait                    `&macro_wait_time <ms>`, a pause mid-sequence
#   pause                   `&macro_pause_for_release`, hold here until the key
#                           the macro is on is let go
#   text                    not a ZMK control at all - VileMK expands a string
#                           into one `&macro_tap &kp <code>` per character
#
# `text` is why this exists at all: "type my email address" is the thing macros
# are wanted for, and spelling it out as thirty tap steps in the UI would be a
# worse editor than the devicetree it replaces. The expansion happens here, in
# the emitter, so the record stays one short string and the keymap stays honest.
MACRO_ACTIONS = ("tap", "press", "release", "wait", "pause", "text")
MACRO_CONTROL = {"tap": "&macro_tap", "press": "&macro_press",
                 "release": "&macro_release"}
# CONFIG_ZMK_BEHAVIORS_QUEUE_SIZE, `.zmk/zmk/app/Kconfig`. A tap is two events
# (press and release), a press or a release is one; exceed the queue and the
# macro silently stops part-way through, which is the worst way to find out.
MACRO_QUEUE = 64
# ZMK's own defaults, same file: CONFIG_ZMK_MACRO_DEFAULT_WAIT_MS / _TAP_MS. A
# record leaves both at 0 meaning "say nothing", so the firmware's default wins
# and the generated node carries no property at all.
MACRO_WAIT_MS = 15
MACRO_TAP_MS = 30

# char -> ZMK keycode, for a `text` step. Letters and digits are mechanical;
# the shifted symbols use the names ZMK gives them in their own right
# (`EXCL`, `DQT`, ...) rather than `LS(N1)`, because those are what the keymap
# would say if a person wrote it. An uppercase letter has no such name, so it
# is the one case that needs the `LS()` wrapper.
_TEXT_SYMBOLS = {
    " ": "SPACE", "\t": "TAB", "\n": "RET",
    "-": "MINUS", "=": "EQUAL", "[": "LBKT", "]": "RBKT", "\\": "BSLH",
    ";": "SEMI", "'": "SQT", ",": "COMMA", ".": "DOT", "/": "FSLH", "`": "GRAVE",
    "!": "EXCL", "@": "AT", "#": "HASH", "$": "DLLR", "%": "PRCNT", "^": "CARET",
    "&": "AMPS", "*": "STAR", "(": "LPAR", ")": "RPAR", "_": "UNDER", "+": "PLUS",
    "{": "LBRC", "}": "RBRC", "|": "PIPE", ":": "COLON", '"': "DQT", "<": "LT",
    ">": "GT", "?": "QMARK", "~": "TILDE",
}


def text_keycode(ch: str):
    """One character -> the keycode that types it, or None if nothing does."""
    if "a" <= ch <= "z":
        return ch.upper()
    if "A" <= ch <= "Z":
        return "LS(%s)" % ch
    if "0" <= ch <= "9":
        return "N" + ch
    return _TEXT_SYMBOLS.get(ch)


def _macro_ms(value, what: str) -> int:
    try:
        n = int(value or 0)
    except (TypeError, ValueError):
        raise EmitError("`%s` must be a number of milliseconds, not %r" % (what, value))
    if n < 0:
        raise EmitError("`%s` cannot be negative" % what)
    return n


def emit_macro(rec: dict):
    """-> (nodes, key_binding). The binding is always `&mc_<name>`.

    `mc_` and not `macro_`: ZMK's own controls are `&macro_tap`, `&macro_press`,
    `&macro_wait_time`, so a generated `&macro_email` would read as one of them
    at a glance. The other generated labels are prefixed the same way - `vd_`,
    `ht_`, `lt_`.
    """
    name = slug(rec.get("name", ""))
    if not name:
        raise EmitError("macro has no name")
    steps = rec.get("steps") or []
    if not steps:
        raise EmitError("a macro needs at least one step")

    binds, events = [], 0
    for i, step in enumerate(steps, 1):
        action = (step.get("action") or "tap").strip()
        if action not in MACRO_ACTIONS:
            raise EmitError("step %d: unknown action %r - one of %s"
                            % (i, action, ", ".join(MACRO_ACTIONS)))
        if action == "pause":
            binds.append("&macro_pause_for_release")
        elif action == "wait":
            binds.append("&macro_wait_time %d" % _macro_ms(step.get("ms"),
                                                           "step %d wait" % i))
        elif action == "text":
            text = str(step.get("text") or "")
            if not text:
                raise EmitError("step %d: the text is empty" % i)
            for ch in text:
                code = text_keycode(ch)
                if not code:
                    raise EmitError(
                        "step %d: no keycode types %r - a text step is plain ASCII, "
                        "and anything else needs its own tap step" % (i, ch))
                binds.append("&macro_tap &kp %s" % code)
                events += 2
        else:
            binding = normalise(step.get("binding", ""))
            if not binding:
                raise EmitError("step %d: `%s` needs a binding" % (i, action))
            binds.append("%s %s" % (MACRO_CONTROL[action], binding))
            events += 2 if action == "tap" else 1

    if events > MACRO_QUEUE:
        raise EmitError(
            "this macro queues %d behaviors and ZMK's queue holds %d - it would stop "
            "part-way through. Shorten it, or raise CONFIG_ZMK_BEHAVIORS_QUEUE_SIZE in "
            "the board's .conf (a tap costs two, a press or release one)."
            % (events, MACRO_QUEUE))

    wait = _macro_ms(rec.get("wait_ms"), "wait_ms")
    tap = _macro_ms(rec.get("tap_ms"), "tap_ms")
    node = ("        mc_{n}: mc_{n} {{\n"
            "            compatible = \"zmk,behavior-macro\";\n"
            "            #binding-cells = <0>;\n").format(n=name)
    if wait:
        node += "            wait-ms = <%d>;\n" % wait
    if tap:
        node += "            tap-ms = <%d>;\n" % tap
    node += ("            bindings\n                = <" + ">\n                , <".join(binds)
             + ">\n                ;\n        };\n")
    return node, "&mc_%s" % name


# ------------------------------------------------------------------- layers

LAYER_MODES = ("lt", "conditional")
# ZMK's layer state is a 32-bit mask - layer 31 is the highest index that can
# ever be active, so a keymap can hold at most 32 layers, full stop.
MAX_LAYERS = 32
# ZMK's own `&lt` is a balanced hold-tap with a 200ms term. A custom node only
# exists to change one of those two, so it starts from the same defaults.
LT_FLAVOR = "balanced"
LT_TERM = 200


def _layer_no(value, what: str) -> int:
    if value in (None, "", []):
        raise EmitError(f"`{what}` is required")
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise EmitError(f"`{what}` must be a layer number, not {value!r}")
    if n < 0:
        raise EmitError(f"`{what}` must be 0 or higher")
    return n


def _emit_layer(rec: dict):
    """-> (section, nodes, key_binding). `section` says where `nodes` belongs.

    Two shapes behind one kind, because they are one subject:

      mode          section              what comes out
      ----          -------              --------------
      lt            behaviors            `&lt <layer> <code>`; only a custom
                                         tapping term or flavor needs a node
      conditional   conditional_layers   a `zmk,conditional-layers` child, and
                                         no binding at all - a conditional layer
                                         is not something a key can hold

    There is no `mo` mode: `&mo <n>` is built into ZMK and takes one parameter,
    a layer number - there is nothing about it worth a saved record, and the
    picker's Layers tab builds one in a single click with no record at all (see
    "Saving is optional" in views/layer.md). `&lt` is the same built-in for the
    other two shapes, and normally emits nothing either - a node appears only
    when `tapping_term_ms` or `flavor` is set, because timing is the one thing
    built-in `&lt` cannot express, and then it is an ordinary hold-tap holding
    `&mo` over the tap key, which is what `&lt` itself is.

    A conditional layer is the odd one: it binds to no key (`key_binding` is
    None) and lives under its own root node, not `behaviors {}`. Hence the
    three-part return - `emit_layer()` is the two-part view the server uses.
    """
    name = slug(rec.get("name", ""))
    if not name:
        raise EmitError("layer entry has no name")
    mode = rec.get("mode") or "lt"
    if mode not in LAYER_MODES:
        raise EmitError(f"mode must be one of {', '.join(LAYER_MODES)}")

    if mode == "conditional":
        ifs = [_layer_no(v, "if-layers") for v in (rec.get("if_layers") or [])]
        if len(ifs) < 2:
            raise EmitError("a conditional layer needs at least two `if` layers - "
                            "it activates when all of them are held at once")
        if len(set(ifs)) != len(ifs):
            raise EmitError("the same layer appears twice in `if-layers`")
        then = _layer_no(rec.get("then_layer"), "then-layer")
        if then in ifs:
            raise EmitError(f"`then-layer` {then} is also one of the `if` layers - a "
                            "conditional layer cannot depend on itself")
        node = (f"        {name} {{\n"
                f"            if-layers = <{' '.join(str(i) for i in ifs)}>;\n"
                f"            then-layer = <{then}>;\n"
                f"        }};\n")
        return "conditional_layers", node, None

    layer = _layer_no(rec.get("layer"), "layer")
    key = normalise(rec.get("key", ""))
    if not key:
        raise EmitError("`tap key` is required for a layer-tap")
    term = rec.get("tapping_term_ms")
    flavor = rec.get("flavor") or ""
    if flavor and flavor not in FLAVORS:
        raise EmitError(f"flavor must be one of {', '.join(FLAVORS)}")
    if not term and not flavor:
        head, params = split_binding(key)
        if head != "&kp" or len(params) != 1:
            raise EmitError(
                f"`{key}` is not a plain keycode, and built-in `&lt` can only tap a "
                "keycode. Set a tapping term or a flavor: that emits a hold-tap node "
                "instead, which taps any behavior of exactly one parameter.")
        return "behaviors", "", f"&lt {layer} {params[0]}"
    node, ref = _holdtap(f"lt_{name}", f"&mo {layer}", key,
                         int(term or LT_TERM), flavor or LT_FLAVOR)
    return "behaviors", node, ref


def emit_layer(rec: dict):
    """-> (nodes, key_binding), the shape every other emitter has.

    `key_binding` is None for a conditional layer - there is nothing to put on a
    key. See `_emit_layer()` for which node goes where.
    """
    _, nodes, binding = _emit_layer(rec)
    return nodes, binding


# --------------------------------------------------------- the record manifest
# Modifiers are absent because they emit no node: they resolve to `LS(LA(A))` on
# the key, so the keymap already carries everything it needs.

def portable(rec: dict) -> dict:
    """A record without the fields that only mean something on this machine."""
    return {k: v for k, v in rec.items() if k not in ("kind", "scopes", "broken")}


def manifest(viledances=(), combos=(), layers=(), macros=()) -> str:
    """The `// vilemk-records:` line for a block built from these records."""
    payload = {"viledance": [portable(r) for r in viledances],
               "combo": [portable(r) for r in combos],
               "layer": [portable(r) for r in layers],
               "macro": [portable(r) for r in macros]}
    return RECORDS_MARK + json.dumps(payload, separators=(",", ":"), sort_keys=True)


def read_manifest(text: str):
    """The records a keymap carries -> {kind: [rec]}. Malformed reads as empty."""
    out = {k: [] for k in DIRS}
    i = text.find(RECORDS_MARK)
    if i == -1:
        return out
    line = text[i + len(RECORDS_MARK):].split("\n", 1)[0]
    try:
        got = json.loads(line)
    except ValueError:
        return out
    if not isinstance(got, dict):
        return out
    for kind in out:
        recs = got.get(kind)
        if not isinstance(recs, list):
            continue
        out[kind] = [r for r in recs if isinstance(r, dict) and slug(r.get("name", ""))]
    return out


def _outside_comments(text: str, fn):
    """Apply `fn` to the parts of `text` that are not comments."""
    out, at = [], 0
    for m in _COMMENT_RE.finditer(text):
        out.append(fn(text[at:m.start()]))
        out.append(m.group(0))
        at = m.end()
    out.append(fn(text[at:]))
    return "".join(out)


def rename_refs(text: str, kind: str, old: str, new: str) -> str:
    """Point every `&label` for one record at its renamed self, outside comments."""
    pairs = list(zip(_defines(kind, {"name": old}), _defines(kind, {"name": new})))
    if not pairs:
        return text

    def sub(part: str) -> str:
        for a, b in pairs:
            part = re.sub(r"&" + re.escape(a) + r"\b", "&" + b, part)
        return part

    return _outside_comments(text, sub)


_SLOT_FIELDS = {"viledance": VILE_SLOTS, "layer": ("key",), "combo": ("binding",)}


def rename_in_record(rec: dict, kind: str, target: str, old: str, new: str) -> dict:
    """The record with its own slots pointing at a renamed record of `target` kind."""
    pairs = list(zip(_defines(target, {"name": old}), _defines(target, {"name": new})))
    if not pairs:
        return rec

    def sub(text):
        if not isinstance(text, str):
            return text
        for a, b in pairs:
            text = re.sub(r"&" + re.escape(a) + r"\b", "&" + b, text)
        return text

    out = dict(rec)
    for field in _SLOT_FIELDS.get(kind, ()):
        if field in out:
            out[field] = sub(out[field])
    if kind == "macro":
        out["steps"] = [{**st, "binding": sub(st.get("binding", ""))}
                        if isinstance(st, dict) else st
                        for st in (out.get("steps") or [])]
    return out


def block(viledances=(), combos=(), layers=(), macros=()) -> str:
    """The whole generated root block: only what was passed in."""
    behaviors, errors = "", []
    for rec in viledances:
        try:
            nodes, _ = emit_viledance(rec)
            behaviors += nodes
        except EmitError as exc:
            errors.append(f"{rec.get('name')}: {exc}")
    # Macros are the one kind with a root node of their own that is not
    # `behaviors {}` - ZMK puts them under `macros {}`.
    macro_nodes = ""
    for rec in macros:
        try:
            nodes, _ = emit_macro(rec)
            macro_nodes += nodes
        except EmitError as exc:
            errors.append(f"{rec.get('name')}: {exc}")
    combo_nodes = ""
    for rec in combos:
        try:
            combo_nodes += emit_combo(rec)
        except EmitError as exc:
            errors.append(f"{rec.get('name')}: {exc}")
    # A layer entry lands in one of two places, and `_emit_layer()` says which.
    cond_nodes = ""
    for rec in layers:
        try:
            section, nodes, _ = _emit_layer(rec)
            if section == "conditional_layers":
                cond_nodes += nodes
            else:
                behaviors += nodes
        except EmitError as exc:
            errors.append(f"{rec.get('name')}: {exc}")
    if not behaviors and not macro_nodes and not combo_nodes and not cond_nodes:
        return "", errors
    out = [BEGIN_MARK, manifest(viledances, combos, layers, macros), "/ {"]
    if behaviors:
        out.append("    behaviors {\n" + behaviors + "    };")
    if macro_nodes:
        out.append("    macros {\n" + macro_nodes + "    };")
    if combo_nodes:
        out.append('    combos {\n        compatible = "zmk,combos";\n'
                   + combo_nodes + "    };")
    if cond_nodes:
        out.append('    conditional_layers {\n'
                   '        compatible = "zmk,conditional-layers";\n'
                   + cond_nodes + "    };")
    out.append("};")
    out.append(END_MARK)
    return "\n".join(out) + "\n", errors


# ---------------------------------------------------------- variant keymaps

VARIANT_DIR = os.path.join(PROJECT_DIR, "variants")
_KEYMAP_NODE_RE = re.compile(r"(?m)^\s*keymap\s*\{")


def _match_brace(text: str, open_idx: int) -> int:
    depth = 0
    for i in range(open_idx, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return i
    raise EmitError("unbalanced braces in the base keymap")


def _layer_spans(text: str):
    """-> [(name, bindings_open_idx, bindings_close_idx)] in layer order."""
    m = _KEYMAP_NODE_RE.search(text)
    if not m:
        raise EmitError("no `keymap { }` node in the base keymap")
    start = text.index("{", m.start())
    end = _match_brace(text, start)
    spans, i = [], start + 1
    node_re = re.compile(r"(?:([A-Za-z_][\w-]*)\s*:\s*)?([A-Za-z_][\w,@.-]*)\s*\{")
    while i < end:
        nm = node_re.search(text, i, end)
        if not nm:
            break
        body_open = text.index("{", nm.start())
        body_close = _match_brace(text, body_open)
        body = text[body_open:body_close]
        bm = re.search(r"bindings\s*=\s*<", body)
        if bm:
            b_open = body_open + bm.end()
            b_close = body.index(">", bm.end()) + body_open
            spans.append((nm.group(2), b_open, b_close))
        i = body_close + 1
    return spans


def _new_layer_node(name: str, display: str, bindings: list, rows) -> str:
    """A brand-new layer node, blank (`&trans` everywhere) unless the caller's
    `bindings` already carries assignments. Indent matches `_holdtap()`'s
    generated nodes (8/12), not the hand-written file's - this is generated
    content, appended once and never touched again except by us.
    """
    dn = (f'            display-name = "{display}";\n'
          if display and display != name else "")
    return (f"\n        {name} {{\n{dn}"
            f"            bindings = <{_format_bindings(bindings, rows)}>;\n"
            f"        }};\n")


def _insert_new_layers(text: str, new_layers, expanded_layers, rows) -> str:
    """Append brand-new layer nodes to the end of the `keymap {}` node, before
    the per-position substitution loop runs - once inserted, `_layer_spans()`
    finds them like any other layer and that loop needs no changes at all.
    """
    if not new_layers:
        return text
    spans = _layer_spans(text)
    existing = len(spans)
    if existing + len(new_layers) > MAX_LAYERS:
        raise EmitError(f"ZMK supports at most {MAX_LAYERS} layers - this keymap "
                        f"already has {existing}, {len(new_layers)} more was requested")
    m = _KEYMAP_NODE_RE.search(text)
    if not m:
        raise EmitError("no `keymap { }` node in the base keymap")
    body_end = _match_brace(text, text.index("{", m.start()))
    names = {nm for nm, *_ in spans}
    nodes = ""
    for i, rec in enumerate(new_layers):
        idx = existing + i
        if idx >= len(expanded_layers):
            raise EmitError(f"no bindings prepared for new layer {idx}")
        raw = str(rec.get("name") or "").strip()
        name = slug(raw) or f"layer_{idx}"
        if not NAME_RE.match(name):
            raise EmitError(f"layer name {name!r} is not a valid identifier")
        if name in names:
            raise EmitError(f"a layer named {name!r} already exists")
        names.add(name)
        nodes += _new_layer_node(name, raw or name, expanded_layers[idx], rows)
    return text[:body_end] + nodes + text[body_end:]


def row_sizes(keys) -> list:
    """How many keys are on each physical row, from a layout's key list.

    Used only to break the generated `bindings` onto the same rows the keyboard
    has, so a generated layer still reads like the hand-written one.
    """
    sizes, n, last_y = [], 0, None
    for k in keys:
        y, h = k[3], k[1]
        if last_y is not None and (y < last_y - h / 2 or y > last_y + h / 2):
            sizes.append(n)
            n = 0
        n += 1
        last_y = y
    if n:
        sizes.append(n)
    return sizes


def _format_bindings(bindings, rows=None, indent=" " * 16) -> str:
    if rows and sum(rows) != len(bindings):
        rows = None
    lines, i = [], 0
    if rows:
        grid = []
        for n in rows:
            grid.append(bindings[i:i + n])
            i += n
        # One width per column so the rows line up like a hand-written keymap.
        # Only rows of equal length share widths - a 6-key thumb row should not
        # stretch the 12-key rows above it.
        widths = {}
        for row in grid:
            w = widths.setdefault(len(row), [0] * len(row))
            for c, b in enumerate(row):
                w[c] = max(w[c], len(b))
        for row in grid:
            w = widths[len(row)]
            lines.append(" ".join(b.ljust(w[c]) for c, b in enumerate(row)).rstrip())
    else:
        line, w = [], 0
        for b in bindings:
            if w + len(b) > 66 and line:
                lines.append(" ".join(line))
                line, w = [], 0
            line.append(b)
            w += len(b) + 1
        if line:
            lines.append(" ".join(line))
    return "\n" + "\n".join(indent + r for r in lines) + "\n" + indent[:-4]


_PHANDLE_RE = re.compile(r"&([A-Za-z_][A-Za-z0-9_]*)")


# --------------------------------------------------- dt-bindings a keymap needs
# The Media & system tab hands out bindings whose parameters are #defines, not
# keycodes: `&rgb_ug RGB_TOG`, `&bt BT_SEL 0`, `&mkp LCLK`. Each of those lives in
# a header the base keymap may never have included - the stock Corne keymap
# includes `keys.h` and `bt.h` and nothing else - and a missing include is not a
# quiet problem: the build fails on an undefined token. So the finished variant is
# scanned for the tokens and told which headers it is short of.
#
# Each row is (header, headers that also define it, token pattern). `mouse.h` is
# ZMK's deprecated name for `pointing.h` and does nothing but include it, so a
# keymap carrying the old spelling already has the tokens.
_HEADER_TOKENS = [
    ("dt-bindings/zmk/keys.h", (), r"&kp\b"),
    ("dt-bindings/zmk/bt.h", (), r"\bBT_[A-Z_]+\b"),
    ("dt-bindings/zmk/outputs.h", (), r"\bOUT_(?:USB|BLE|TOG)\b"),
    ("dt-bindings/zmk/rgb.h", (), r"\bRGB_[A-Z_]+\b"),
    ("dt-bindings/zmk/backlight.h", (), r"\bBL_[A-Z_]+\b"),
    ("dt-bindings/zmk/ext_power.h", (), r"\bEP_(?:ON|OFF|TOG)\b"),
    ("dt-bindings/zmk/pointing.h", ("dt-bindings/zmk/mouse.h",),
     r"\b(?:MOVE_[A-Z]+|SCRL_[A-Z]+|MB[1-5]|LCLK|RCLK|MCLK)\b"),
    ("dt-bindings/zmk/reset.h", (), r"\bRST_[A-Z0-9]+\b"),
]
_INCLUDE_RE = re.compile(r"(?m)^[ \t]*#[ \t]*include[ \t]*[<\"]([^>\"]+)[>\"]")
_ROOT_RE = re.compile(r"(?m)^[ \t]*/[ \t]*\{")


def missing_includes(text: str) -> list:
    """Headers `text` uses tokens from but does not include."""
    have = {m.group(1) for m in _INCLUDE_RE.finditer(text)}
    out = []
    for header, alts, pattern in _HEADER_TOKENS:
        if header in have or any(a in have for a in alts):
            continue
        if re.search(pattern, text):
            out.append(header)
    return out


def add_includes(text: str, headers) -> str:
    """Add `#include <...>` lines after the ones the file already has.

    Position matters only in that they must come before the first node - the
    tokens they define are used inside it. A keymap with no includes at all is
    already broken (nothing declares `&kp`), so the fallback of putting them at
    the very top is a best effort, not a promise.
    """
    if not headers:
        return text
    lines = "\n".join(f"#include <{h}>" for h in headers)
    root = _ROOT_RE.search(text)
    last = None
    for m in _INCLUDE_RE.finditer(text):
        if root and m.start() > root.start():
            break
        last = m
    if last is None:
        return lines + "\n\n" + text.lstrip("\n")
    nl = text.find("\n", last.end())
    cut = len(text) if nl == -1 else nl + 1
    return text[:cut] + lines + "\n" + text[cut:]


# ------------------------------------------------- which records get written
# "Only what is used" is decided by *label*: a key bound to `&vd_x` is what pulls
# the VileDance `x` into the file. Two of these per kind, and they are the only
# place the generated label spellings are written down besides the emitters.

def _defines(kind: str, rec: dict):
    """The labels a record's generated nodes can be referenced by."""
    name = slug(rec.get("name", ""))
    if kind == "viledance":
        # `ht_<name>` when it is a lone hold-tap, `vd_<name>` once it is a
        # tap-dance; the `ht_<name>_1` / `_2` pair is nested inside the latter
        # and never named by a key.
        return (f"vd_{name}", f"ht_{name}")
    if kind == "macro":
        return (f"mc_{name}",)
    if kind == "layer":
        return (f"lt_{name}",)
    return ()


def _refs(kind: str, rec: dict):
    """The labels a record's own slots point at - one record referencing another.

    A VileDance slot holding `&mc_email`, a macro step holding `&vd_x`, a combo
    whose output is either: none of those appear in the keymap's own bindings, so
    without this the node they name would be left out and the variant would carry
    a phandle pointing at nothing.
    """
    if kind == "viledance":
        texts = [rec.get(slot, "") for slot in VILE_SLOTS]
    elif kind == "macro":
        texts = [st.get("binding", "") for st in (rec.get("steps") or [])]
    elif kind == "layer":
        texts = [rec.get("key", "")]
    elif kind == "combo":
        texts = [rec.get("binding", "")]
    else:
        texts = []
    return [split_binding(t)[0].lstrip("&") for t in texts if t]


def reachable_records(text, viledances, combos, layers, macros, scope=""):
    """Which records a keymap uses -> (viledances, combos, layers, macros).

    `text` must already have its generated block stripped, so the scan reads
    only what the keys name.

    The reachable set, not just the directly-bound one. Seeds: every label the
    keymap names, plus the ones the combos being written name (a combo goes on
    no key, so its output binding is nowhere in the keymap text). Then follow
    each chosen record's own slots, because a VileDance can tap a macro and a
    macro can tap a VileDance - one hop is not enough.
    """
    live_combos = [c for c in combos if scoped_on(c, scope)]
    pool = ([("viledance", r) for r in viledances]
            + [("macro", r) for r in macros]
            + [("layer", r) for r in layers
               if (r.get("mode") or "lt") != "conditional"])
    by_label = {}
    for kind, rec in pool:
        for lbl in _defines(kind, rec):
            by_label.setdefault(lbl, (kind, rec))

    pending = [m.group(1) for m in _PHANDLE_RE.finditer(text)]
    for rec in live_combos:
        pending += _refs("combo", rec)
    taken = set()
    while pending:
        hit = by_label.get(pending.pop())
        if hit is None or id(hit[1]) in taken:
            continue
        taken.add(id(hit[1]))
        pending += _refs(hit[0], hit[1])

    wanted = [r for k, r in pool if k == "viledance" and id(r) in taken]
    live_macros = [r for k, r in pool if k == "macro" and id(r) in taken]
    # A conditional layer is bound to no key - nothing could ever reference it -
    # so it follows the combo rule instead: written only where it is switched on
    # for this variant. A layer-tap follows the VileDance rule, since a key does
    # reference it (and a plain `&lt` entry emits nothing either way).
    live_layers = [r for r in layers
                   if (scoped_on(r, scope) if (r.get("mode") or "lt") == "conditional"
                       else id(r) in taken)]
    return wanted, live_combos, live_layers, live_macros


def build_variant(base_text, expanded_layers, assignments, viledances, combos,
                  layers=(), macros=(), rows=None, new_layers=(), scope=""):
    """Base keymap + key assignments + only the custom code those keys use.

    `assignments` is {layer_index: {key_position: binding}}. `expanded_layers` is
    the parsed binding list per layer, used to rewrite a layer in full - macro
    shorthand in the original layer does not survive an assignment. `new_layers`
    is `[{"name": ...}, ...]`, layers that do not exist in the base keymap at
    all yet - `expanded_layers` must already carry one `&trans`-filled entry per
    new layer, appended after the base keymap's own, so `assignments` can
    address them by the same index it uses for every other layer. `scope` is the
    scope key of the variant being written (`scope_key("variant", name)`); the
    combos and conditional layers switched on for it are the ones written, and
    nothing is written when it is blank.

    Which VileDances, macros and layer-taps come with it is not a filter over the
    keys alone: it is the set *reachable* from them, since one record may
    reference another (see `_refs()`).
    """
    text = _insert_new_layers(base_text, new_layers, expanded_layers, rows)

    for idx in sorted(assignments, reverse=True):
        spans = _layer_spans(text)
        if idx >= len(spans):
            raise EmitError(f"layer {idx} does not exist in the base keymap")
        if idx >= len(expanded_layers):
            raise EmitError(f"no parsed bindings for layer {idx}")
        bindings = list(expanded_layers[idx])
        for pos, binding in assignments[idx].items():
            pos = int(pos)
            if pos >= len(bindings):
                raise EmitError(f"key position {pos} is past the end of layer {idx}")
            bindings[pos] = normalise(binding)
        _, b_open, b_close = spans[idx]
        text = text[:b_open] + _format_bindings(bindings, rows) + text[b_close:]

    # Only what the keys actually reference. A VileDance nobody bound is dead
    # code, and dead code in a keymap is still compiled into the firmware.
    #
    # The scan reads the *finished keymap*, with the old generated block already
    # stripped - not just this save's assignments. A variant can be rebuilt on
    # top of itself (it is offered as a base like any other keymap), and then the
    # keys referencing `&ht_x` were placed by an earlier save and are absent from
    # `assignments`; scanning assignments alone would strip the node out from
    # under a binding that still points at it, and the build fails on an
    # undefined node label.
    text = strip_block(text)
    wanted, live_combos, live_layers, live_macros = reachable_records(
        text, viledances, combos, layers, macros, scope)

    gen, errors = block(wanted, live_combos, live_layers, live_macros)
    if gen:
        text = text.rstrip() + "\n\n" + gen

    # Last, so the generated block's own bindings are scanned too - a combo bound
    # to `&bt BT_CLR` needs bt.h exactly as much as a key does.
    added = missing_includes(text)
    if added:
        text = add_includes(text, added)
        errors.append("added " + ", ".join(f"#include <{h}>" for h in added))
    return text, errors


def strip_block(text: str) -> str:
    """Remove a previously generated block so regenerating does not duplicate."""
    i = text.find(BEGIN_MARK)
    if i == -1:
        return text
    j = text.find(END_MARK, i)
    if j == -1:
        return text[:i].rstrip() + "\n"
    return (text[:i].rstrip() + "\n" + text[j + len(END_MARK):].lstrip("\n")).rstrip() + "\n"


def with_manifest(text, viledances, combos, layers, macros, scope=""):
    """`text` with a manifest added to its generated block if it lacks one.

    For files written before manifests existed. The records are the ones the
    next save would write, so a store that has drifted wins over the file.
    """
    if RECORDS_MARK in text or BEGIN_MARK not in text:
        return text
    recs = reachable_records(strip_block(text), viledances, combos, layers,
                             macros, scope)
    at = text.find(BEGIN_MARK) + len(BEGIN_MARK)
    return text[:at] + "\n" + manifest(*recs) + text[at:]


def variant_slug(name: str) -> str:
    fn = slug(name)
    if not NAME_RE.match(fn or ""):
        raise ValueError("variant name must be letters, digits and underscores")
    return fn


def variant_dir(name: str) -> str:
    """`variants/<name>/` - the folder a variant is, not a file it is in."""
    return os.path.join(VARIANT_DIR, variant_slug(name))


def variant_path(name: str) -> str:
    """The keymap inside that folder. Named after the variant, so it keeps its
    identity when copied into the config repo's `config/`."""
    fn = variant_slug(name)
    return os.path.join(VARIANT_DIR, fn, f"{fn}.keymap")


def legacy_variant_path(name: str) -> str:
    """Where variants lived before they became folders: `variants/<name>.keymap`.
    Still read, so nothing saved by an earlier version disappears."""
    return os.path.join(VARIANT_DIR, f"{variant_slug(name)}.keymap")


# ------------------------------------------------- the variant's own build.yaml
#
# A variant folder is a bundle: the keymap, and the one build list that builds
# it. Copy the keymap into the config repo's `config/` and this file over the
# repo's `build.yaml`, and the keyboard builds that keymap and nothing else.
#
# The entries are not invented. They are the repo's own entries for this
# keyboard with the `KEYMAP_FILE` swapped, so a split keeps both halves, a
# `shield:` survives, and a ZMK Studio entry keeps its snippet and its extra
# cmake flags. Only when the repo has no entry at all do we fall back to the
# vendor's build list, and only when that is missing too do we guess.
#
# The one thing added on top of the repo's entries: the flags that compile in
# the feature-gated behaviors the keymap binds (`FEATURE_FLAGS` below).

BUILD_YAML_KEYS = ("board", "shield", "snippet", "artifact-name")

# Behaviors that only work when their feature is compiled in. ZMK defines the
# behavior *names* unconditionally, so a keymap binding one builds green
# everywhere - and the key dies silently on the keyboard when the feature is
# off. The keymap is the source of truth: binding `&rgb_ug` *is* the request
# for underglow, so the build list carries the switch that turns it on. ZMK
# reads `CONFIG_*` symbols from `cmake-args` like a conf file, which keeps the
# variant a two-file bundle. A redundant flag (board defconfig or a conf
# already says =y) merges to the same build; a flag the board cannot honour
# fails the build loudly, which beats the dead key it replaces.
FEATURE_FLAGS = (
    (("rgb_ug",), ("-DCONFIG_ZMK_RGB_UNDERGLOW=y", "-DCONFIG_WS2812_STRIP=y")),
    (("bl",), ("-DCONFIG_ZMK_BACKLIGHT=y",)),
    (("soft_off",), ("-DCONFIG_ZMK_PM_SOFT_OFF=y",)),
    (("mmv", "msc", "mkp"), ("-DCONFIG_ZMK_POINTING=y",)),
)

# ZMK Studio needs more than a symbol: the RPC transport is a Zephyr snippet.
# Only the central half talks to Studio, and ZMK's default central is the left.
STUDIO_SNIPPET = "studio-rpc-usb-uart"
STUDIO_FLAG = "-DCONFIG_ZMK_STUDIO=y"

# ZMK's own shield for wiping the settings partition. A Studio session writes
# edited key positions there, and those win over the compiled keymap on every
# boot - so a keyboard that has been touched by Studio can ignore the keymap you
# flash, for those positions only, forever. Reflashing does not clear them and
# neither does the reset button; flashing this build is the only thing that
# does. Worth offering next to every save, because the failure is silent: the
# keys that keep their old bindings are exactly the ones a generated behavior
# sits on, and everything else looks right.
RESET_SHIELD = "settings_reset"

_COMMENT_RE = re.compile(r"/\*.*?\*/|//[^\n]*", re.S)


def _bound_labels(keymap_text: str):
    """Every `&label` the keymap references, comments stripped."""
    code = _COMMENT_RE.sub("", keymap_text or "")
    return {m.group(1) for m in re.finditer(r"&([A-Za-z_]\w*)", code)}


def _feature_flags(keymap_text: str):
    """-> (flags every half needs, keymap binds `&studio_unlock`)."""
    bound = _bound_labels(keymap_text)
    flags = [f for labels, fs in FEATURE_FLAGS
             if any(l in bound for l in labels) for f in fs]
    return flags, "studio_unlock" in bound


def _is_central(entry) -> bool:
    """The half Studio talks to: the left of a split, or an unsplit board."""
    half = keymap.split_half(entry.board)[1]
    for s in entry.shields:
        half = half or keymap.split_half(s)[1]
    return half in (None, "left")


# Parts: the shields a vendor adds to a half on top of the keyboard itself
# (`nice_view` on `eyelash_sofle_left`). The vendor ships one build list for every
# way the keyboard is sold, so it lists them all; which ones a given keyboard
# actually has is the user's answer, ticked in the variant bar and passed in as
# `parts`. A screen dropped from a board whose defconfig turns the display on
# needs the display switched off too, or the build fails on the missing
# `zephyr,display` node.
DISPLAY_OFF_FLAG = "-DCONFIG_ZMK_DISPLAY=n"
DISPLAY_FLAG_RE = re.compile(r"\s*-DCONFIG_ZMK_DISPLAY=\S*")


def _slot(keyboard: str, entry) -> str:
    """The name that says which half an entry builds: the board for a keyboard
    that is its own board, the keyboard shield for one on a generic controller."""
    for n in [entry.board] + entry.shields:
        if n and (n == keyboard or keymap.split_half(n)[0] == keyboard):
            return n
    return entry.board


def _vendor_parts(keyboard: str, zmk_dir: str):
    """-> {slot: [shield, ...]}, the add-ons on the vendor's plain entries."""
    out = {}
    for v in _entries_for(keyboard, keymap.vendor_build_entries(zmk_dir)):
        if v.get("snippet") or v.get("artifact-name"):
            continue
        slot = _slot(keyboard, v)
        extra = [sh for sh in v.shields if sh != slot and sh not in out.get(slot, [])]
        out.setdefault(slot, []).extend(extra)
    return {k: v for k, v in out.items() if v}


def part_id(slot: str, shield: str) -> str:
    return f"{slot}:{shield}"


def parts_for(keyboard: str, zmk_dir: str = ".zmk", build_path: str = ""):
    """The parts the page offers for `keyboard`, each ticked as the current build
    list has it: the variant's own `build_path` when there is one, else the
    repo's build list, else the vendor's (everything on)."""
    vendor = _vendor_parts(keyboard, zmk_dir)
    if not vendor:
        return []
    source = []
    for path in (build_path, keymap.find_build_yaml()):
        if path and os.path.isfile(path):
            source = [e for e in _entries_for(
                          keyboard, keymap.parse_build_yaml(keymap.read_text(path)))
                      if RESET_SHIELD not in e.shields]
            if source:
                break
    have = {part_id(_slot(keyboard, e), sh) for e in source for sh in e.shields}
    return [{"id": part_id(slot, sh), "slot": slot, "shield": sh,
             "on": not source or part_id(slot, sh) in have}
            for slot, shields in vendor.items() for sh in shields]


def _add_flags(cmake_args: str, flags) -> str:
    """Append each flag whose symbol the args do not already set."""
    for f in flags:
        if f.split("=")[0] + "=" not in (cmake_args or ""):
            cmake_args = f"{cmake_args} {f}".strip()
    return cmake_args


def _entries_for(keyboard: str, entries):
    """The entries that build `keyboard`, half by half.

    A board carries the keyboard in its own name (`eyelash_sofle_left`); a
    shield on a generic controller carries it in the shield (`corne_left`).
    """
    out = []
    for e in entries:
        names = [e.board] + e.shields
        if any(n == keyboard or keymap.split_half(n)[0] == keyboard
               for n in names if n):
            out.append(e)
    return out


def _reset_body(boards):
    """The `settings_reset` entries for a build list, one per distinct board.

    `settings_reset` replaces the keyboard's shield rather than joining it - the
    build is a stub firmware that wipes the partition and stops, so it carries no
    keymap, no feature flags and none of the original shields. Boards are what
    vary: a split wired as two boards (`eyelash_sofle_left` / `_right`) needs one
    uf2 per half, while a split that is one shield on two identical controllers
    needs only one. Order follows the build list so the halves line up with the
    firmware entries above them.
    """
    seen, body = set(), []
    for b in boards:
        if not b or b in seen:
            continue
        seen.add(b)
        body.append(f"  - board: {b}\n    shield: {RESET_SHIELD}")
    if not body:
        return []
    head = ("  # Wipes the keymap stored in the settings partition. ZMK Studio\n"
            "  # writes the keys you edit there, and those override the compiled\n"
            "  # keymap on every boot - for those positions only, which is why a\n"
            "  # keyboard can look mostly right and have two dead keys. Flashing\n"
            "  # normal firmware does not clear them and neither does the reset\n"
            "  # button. Flash these to every half, then the firmware above, then\n"
            "  # re-pair: the reset drops Bluetooth bonds too.")
    return [head] + body


def _with_keymap_file(cmake_args: str, keymap_rel: str) -> str:
    """Point an entry's cmake-args at our keymap, keeping every other flag."""
    flag = f'-DKEYMAP_FILE="${{GITHUB_WORKSPACE}}/{keymap_rel}"'
    if not cmake_args:
        return flag
    if keymap.KEYMAP_FILE_RE.search(cmake_args):
        # a callable replacement: no backslash/group escaping in the path
        return keymap.KEYMAP_FILE_RE.sub(lambda _m: flag, cmake_args, count=1)
    return f"{cmake_args} {flag}"


def build_yaml_for(keyboard: str, keymap_name: str, zmk_dir: str = ".zmk",
                   keymap_text: str = "", reset: bool = False, parts=None):
    """-> (build.yaml text, warnings) for one keyboard and one keymap.

    Reads the config repo, so the caller must already be `chdir`-ed into it -
    every command here does that early. Reads only: nothing in the config repo
    is written, and this text lands in `variants/<name>/build.yaml`.

    `keymap_text` is the keymap the entries will build: the feature-gated
    behaviors it binds decide which `FEATURE_FLAGS` the entries carry.

    `reset` appends a `settings_reset` entry per board (`_reset_body()`). It is
    off by default because it doubles the artifacts, and on by default in the
    page for a keymap that binds `&studio_unlock` - the keyboards that can end up
    with a stored keymap overriding this one are exactly those.

    `parts` is `{part_id: bool}` for the add-on shields the vendor lists
    (`parts_for()`): ticked ones are kept or added, unticked ones dropped. None
    keeps the source entries' shields as they are.
    """
    keymap_rel = f"config/{keymap_name}"
    warnings, source = [], ""
    feature_flags, studio = _feature_flags(keymap_text)
    if feature_flags:
        warnings.append(
            "the keymap binds feature-gated behaviors, so the build entries "
            "carry " + " ".join(feature_flags))
    if studio:
        warnings.append(
            f"the keymap binds &studio_unlock, so the central half gets "
            f"`snippet: {STUDIO_SNIPPET}` and {STUDIO_FLAG}")

    own = keymap.find_build_yaml()
    picked = (_entries_for(keyboard, keymap.parse_build_yaml(keymap.read_text(own)))
              if own else [])
    # A `settings_reset` entry is not a firmware entry: it builds a stub that
    # wipes the partition, and stamping KEYMAP_FILE or a feature flag onto it
    # would be wrong. Drop them here and let `_reset_body()` write clean ones,
    # which also keeps the output idempotent - saving a variant from a repo whose
    # build list already carries them must not duplicate them. The caller's
    # `reset` still decides: the box in the page is an explicit answer, so
    # unticking it drops entries the source had, and says so.
    had_reset = any(RESET_SHIELD in e.shields for e in picked)
    if had_reset:
        picked = [e for e in picked if RESET_SHIELD not in e.shields]
        if not reset:
            warnings.append(
                f"the source build list has `shield: {RESET_SHIELD}` entries and "
                "this one does not - tick `include reset` to keep them")
    if picked:
        source = f"the repo's own {own}"
    else:
        vendor = [e for e in keymap.vendor_build_entries(zmk_dir)
                  if not e.get("snippet") and not e.get("artifact-name")
                  and RESET_SHIELD not in e.get("shield", "")]
        picked = _entries_for(keyboard, vendor)
        if picked:
            source = "the vendor's build list in the ZMK cache"
            warnings.append(
                f"{own or 'build.yaml'} has no entry for `{keyboard}`; the variant's "
                "build.yaml was written from the vendor's build list instead")

    if not picked:
        warnings.append(
            f"nothing in build.yaml or the ZMK cache builds `{keyboard}`, so the "
            "variant's build.yaml is a guess - check the board and shield names "
            "before pushing it")
        head = (f"# VileMK could not find an entry for `{keyboard}` in this repo's\n"
                f"# build.yaml or in any vendor module, so the entry below is a\n"
                f"# guess. Check the board name - and add a `shield:` line if this\n"
                f"# keyboard is a shield on a generic controller.\n")
        body = [f"  - board: {keyboard}"]
        if studio:
            body.append(f"    snippet: {STUDIO_SNIPPET}")
        args = _add_flags("", feature_flags + ([STUDIO_FLAG] if studio else []))
        body.append(f"    cmake-args: {_with_keymap_file(args, keymap_rel)}")
        if reset:
            body += _reset_body([keyboard])
        return _build_yaml_text(keyboard, keymap_name, head, body), warnings

    vendor_parts = _vendor_parts(keyboard, zmk_dir)
    seen, body = set(), []
    for e in picked:
        central = _is_central(e)
        slot = _slot(keyboard, e)
        offered = vendor_parts.get(slot, [])
        shields = list(e.shields)
        if parts is not None:
            shields = [sh for sh in shields
                       if sh not in offered or parts.get(part_id(slot, sh), True)]
            shields += [sh for sh in offered
                        if parts.get(part_id(slot, sh)) and sh not in shields]
        # A screen the vendor offers and this half does not get: switch the
        # display off, unless the board never turned it on or a conf already did.
        dropped_screen = any(DISPLAY_SHIELD_RE.search(sh) for sh in offered
                             if sh not in shields)
        has_screen = any(DISPLAY_SHIELD_RE.search(sh) for sh in shields)
        display_off = (dropped_screen and not has_screen
                       and _defconfig_turns_on(zmk_dir, e.board, "CONFIG_ZMK_DISPLAY")
                       and not _conf_turns_off(e.board, "CONFIG_ZMK_DISPLAY"))
        if display_off and parts is None:
            note = (f"`{slot}` has no screen shield but its defconfig turns the "
                    f"display on, so its entry carries {DISPLAY_OFF_FLAG}")
            if note not in warnings:
                warnings.append(note)
        lines = []
        for key in BUILD_YAML_KEYS:
            value = " ".join(shields) if key == "shield" else e.get(key)
            if key == "snippet" and studio and central:
                if value and value != STUDIO_SNIPPET:
                    warnings.append(
                        f"`{e.board or e.get('shield')}` already carries "
                        f"`snippet: {value}`, so `{STUDIO_SNIPPET}` could not be "
                        "added - ZMK Studio will not connect to this build")
                value = value or STUDIO_SNIPPET
            if value:
                lines.append(f"{'  - ' if not lines else '    '}{key}: {value}")
        if not lines:
            continue
        args = e.get("cmake-args") or ""
        if parts is not None:
            # the ticked parts decide the display, not a flag left over from before
            args = DISPLAY_FLAG_RE.sub("", args).strip()
        args = _add_flags(args,
                          feature_flags
                          + ([STUDIO_FLAG] if studio and central else [])
                          + ([DISPLAY_OFF_FLAG] if display_off else []))
        lines.append(f"    cmake-args: {_with_keymap_file(args, keymap_rel)}")
        block = "\n".join(lines)
        if block not in seen:            # the same half twice is one entry
            seen.add(block)
            body.append(block)

    if reset:
        added = _reset_body([e.board for e in picked])
        body += added
        if added:
            warnings.append(
                f"the build list carries a `shield: {RESET_SHIELD}` entry per board - "
                "flash those first to wipe a keymap ZMK Studio stored in flash, then "
                "the firmware, then re-pair")

    head = (f"# Entries taken from {source},\n"
            "# with the KEYMAP_FILE changed"
            + (",\n# plus the flags for the feature-gated behaviors the keymap"
               "\n# binds - a bound behavior only works when its feature is"
               "\n# compiled in.\n" if feature_flags or studio else ".\n"))
    return _build_yaml_text(keyboard, keymap_name, head, body), warnings


def _build_yaml_text(keyboard, keymap_name, head, body) -> str:
    return (
        f"# The build list for the `{keyboard}` variant in this folder.\n"
        "# Written by VileMK - read-only against your config repo.\n"
        "#\n"
        "# To use it: copy\n"
        f"#     {keymap_name}\n"
        "# into the config repo's `config/`, and this file over the repo's own\n"
        "# `build.yaml`. Every entry names the keymap explicitly, so ZMK builds\n"
        "# this one rather than whatever `config/<board>.keymap` happens to hold.\n"
        "#\n"
        + head
        + "---\n"
          "include:\n"
        + "\n".join(body) + "\n")


def delete_variant(name: str) -> bool:
    """Remove `variants/<name>/`, or the flat `variants/<name>.keymap` an older
    version wrote. `variant_dir()` is what keeps this inside our own directory -
    the config repo is never written, let alone deleted from.

    Only the two files a variant is made of are removed, and the folder only if
    that empties it. Anything else you put in there is yours and survives.
    """
    gone = False
    folder = variant_dir(name)
    if os.path.isdir(folder):
        for fn in (os.path.basename(variant_path(name)), "build.yaml"):
            p = os.path.join(folder, fn)
            if os.path.isfile(p):
                os.remove(p)
                gone = True
        if not os.listdir(folder):
            os.rmdir(folder)
    legacy = legacy_variant_path(name)
    if os.path.isfile(legacy):
        os.remove(legacy)
        gone = True
    return gone


def write_variant(name: str, text: str, keyboard: str = "", zmk_dir: str = ".zmk",
                  reset: bool = False, parts=None):
    """Write `variants/<name>/` - the keymap, and the build list that builds it.

    -> (keymap path, build.yaml path or "", warnings). The build list is skipped
    only when we were not told which keyboard this is; the keymap is always
    written, since it is the thing the user asked for.

    `reset` adds the `settings_reset` entries to that build list, and `parts`
    picks its add-on shields - see `build_yaml_for()`.
    """
    p = variant_path(name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(text)

    warnings = []
    # An earlier version wrote `variants/<name>.keymap` beside the folder.
    # Leaving it would list the same variant twice, so saving over a variant
    # moves it rather than forking it.
    legacy = legacy_variant_path(name)
    if os.path.isfile(legacy):
        os.remove(legacy)
        warnings.append(f"moved {os.path.basename(legacy)} into "
                        f"{os.path.basename(os.path.dirname(p))}/")

    build_path = ""
    if keyboard:
        yaml_text, yaml_warnings = build_yaml_for(
            keyboard, os.path.basename(p), zmk_dir, keymap_text=text, reset=reset,
            parts=parts)
        build_path = os.path.join(os.path.dirname(p), "build.yaml")
        with open(build_path, "w", encoding="utf-8") as fh:
            fh.write(yaml_text)
        warnings += yaml_warnings
    return p, build_path, warnings
