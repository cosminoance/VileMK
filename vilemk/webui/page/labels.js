// ZMK's keycode names are not what is printed on the key: `N1` is the 1 key,
// `SQT` the apostrophe, `FSLH` the slash (see the "Keymaps > List of keycodes"
// page on zmk.dev). The picker already carries the legend for every one of them,
// so KEY_LABELS is derived from it rather than typed out a second time - a
// "shifted|plain" label keeps its plain half, since a tile shows what the key
// sends unshifted. Anything the picker does not name keeps its ZMK spelling.
const KEY_LABELS = {}, KEY_SHIFTED = {};
// The same idea for a binding that is not a `&kp` at all - `&bt BT_SEL 0`,
// `&mkp LCLK`, `&rgb_ug RGB_TOG`. Keyed by the whole binding text, filled from
// SYSTEM below (`_learnSystem()`), read by `label()`.
const BIND_LABELS = {};
const normBind = b => String(b).trim().replace(/\s+/g, " ");
function _learnLabels(rows){
  for (const ent of rows){
    const [lbl, code] = ent;
    if (!code || code.startsWith("&")) continue;
    const parts = Array.isArray(lbl) ? lbl : String(lbl).split("|");
    const plain = parts.length > 1 ? parts[1] : parts[0];
    if (plain && !(code in KEY_LABELS)) KEY_LABELS[code] = plain;
    if (parts.length > 1 && !(code in KEY_SHIFTED)) KEY_SHIFTED[code] = parts[0];
  }
}

// ZMK gives most keys several names and the picker only carries one of them.
// These are the long forms that turn up in a real keymap, mapped back to the
// picker's spelling: https://zmk.dev/docs/keymaps/list-of-keycodes
const KEY_ALIASES = {
  ENTER:"RET", RETURN:"RET", ESCAPE:"ESC", BACKSPACE:"BSPC", DELETE:"DEL",
  INSERT:"INS", PAGE_UP:"PG_UP", PAGE_DOWN:"PG_DN", CAPSLOCK:"CAPS",
  PRINTSCREEN:"PSCRN", UP_ARROW:"UP", DOWN_ARROW:"DOWN", LEFT_ARROW:"LEFT",
  RIGHT_ARROW:"RIGHT", LEFT_SHIFT:"LSHFT", RIGHT_SHIFT:"RSHFT",
  LEFT_CONTROL:"LCTRL", RIGHT_CONTROL:"RCTRL", LEFT_ALT:"LALT", RIGHT_ALT:"RALT",
  LEFT_GUI:"LGUI", RIGHT_GUI:"RGUI", LEFT_WIN:"LGUI", RIGHT_WIN:"RGUI",
  LEFT_COMMAND:"LGUI", RIGHT_COMMAND:"RGUI",
  SINGLE_QUOTE:"SQT", APOSTROPHE:"SQT", SEMICOLON:"SEMI", SLASH:"FSLH",
  BACKSLASH:"BSLH", PERIOD:"DOT", LEFT_BRACKET:"LBKT", RIGHT_BRACKET:"RBKT",
  NUMBER_1:"N1", NUMBER_2:"N2", NUMBER_3:"N3", NUMBER_4:"N4", NUMBER_5:"N5",
  NUMBER_6:"N6", NUMBER_7:"N7", NUMBER_8:"N8", NUMBER_9:"N9", NUMBER_0:"N0",
  SPACEBAR:"SPACE", GRAVE_ACCENT:"GRAVE", EQUALS:"EQUAL",
  // media/consumer codes: keys.h names most of these three ways and the
  // Media & system tab carries the short one (see SYSTEM).
  C_VOLUME_UP:"C_VOL_UP", C_VOLUME_DOWN:"C_VOL_DN", C_PLAY_PAUSE:"C_PP",
  C_PREVIOUS:"C_PREV", C_BRIGHTNESS_INC:"C_BRI_UP", C_BRI_INC:"C_BRI_UP",
  C_BRIGHTNESS_DEC:"C_BRI_DN", C_BRI_DEC:"C_BRI_DN", C_FAST_FORWARD:"C_FF",
  C_REWIND:"C_RW", C_POWER:"C_PWR", C_AL_CALCULATOR:"C_AL_CALC",
  C_AL_FILE_BROWSER:"C_AL_FILES", C_AL_EMAIL:"C_AL_MAIL", C_AC_FIND:"C_AC_SEARCH",
  K_APPLICATION:"K_APP"
};
const _code = c => KEY_ALIASES[c] || c;

// The legend on the *upper* half of a keycap, for a bare `&kp <code>` that has
// one: `&kp N1` -> "!". Nothing for a letter, and nothing for a code that is
// already a modified one (`LS(SQT)` types the shifted glyph itself, so there is
// no second thing to print). What the key does with shift is the host's doing,
// not the keymap's - hence a legend rather than a binding hint.
function shiftLegend(b){
  const kp = /^&?kp\s+([A-Z0-9_]+)$/.exec(String(b).trim());
  return (kp && KEY_SHIFTED[_code(kp[1])]) || "";
}

// `&kp N1` -> "1", `&kp LS(SQT)` -> the double quote it actually types. Only a
// bare `&kp <code>` is renamed - any other behavior keeps its own text,
// shortened.
function label(b){
  // A behavior with its own legend - `&bt BT_SEL 0` is "BT 0", not "bt BT_SEL 0".
  const named = BIND_LABELS[normBind(b)];
  if (named) return named;
  const kp = /^&?kp\s+(\S+)$/.exec(String(b).trim());
  if (kp){
    const shift = /^(?:LS|RS)\((\w+)\)$/.exec(kp[1]);
    if (shift && KEY_SHIFTED[_code(shift[1])]) return KEY_SHIFTED[_code(shift[1])];
    if (KEY_LABELS[_code(kp[1])]) return KEY_LABELS[_code(kp[1])];
  }
  return b.replace(/^&/, "")
          .replace(/^kp /, "")
          .replace(/_ARROW\b/g, "")
          .replace(/\bLEFT_/g, "L").replace(/\bRIGHT_/g, "R")
          .replace(/\bBACKSPACE\b/, "BSPC").replace(/\bCONTROL\b/, "CTRL");
}

const behaviorOf = (km, lbl) => (km.behaviors || []).find(x => x.label === lbl);

// Where a behavior is actually used: the first key bound to it, as
// {layer, pos, binding}. A hold-tap declares `bindings = <&kp>, <&kp>;` and
// nothing else - the keys it sends are the *parameters given at the key*
// (`&ht_bkspcshift LSHFT BSPC`), so the node on its own genuinely says "kp, kp".
// This is what lets the Behaviors table show the real keys instead.
function usageOf(km, lbl){
  const layers = km.layers || [];
  for (let li = 0; li < layers.length; li++){
    const bs = layers[li].bindings || [];
    for (let pos = 0; pos < bs.length; pos++)
      if (String(bs[pos]).trim().split(/\s+/)[0].replace(/^&/, "") === lbl)
        return {layer: li, pos, binding: bs[pos]};
  }
  return null;
}

// Resolve a binding through hold-tap / tap-dance / mod-morph nodes to what it
// actually sends, so a board tile for `&vd_x` or `&ht_x_1 LSHIFT BSPC` shows the
// real keys instead of the generated label - a VileDance's tap and hold-tap
// nodes both live in `km.behaviors` (see parse_keymap()), so this walks either
// ours or a hand-written one the same way. `depth` bounds the recursion against
// a malformed or self-referential keymap.
function resolveBinding(km, text, depth){
  text = (text || "").trim();
  if (!text) return null;
  const parts = text.split(/\s+/);
  const head = parts[0].replace(/^&/, "");
  const params = parts.slice(1);
  const beh = depth > 0 ? behaviorOf(km, head) : null;
  // A macro node lives in `km.macros`, not `km.behaviors`, and its `bindings` are
  // a controls-and-keys sequence rather than something to resolve into a tap and a
  // hold - so the tile carries the macro's name and the title carries the sequence.
  const mac = !beh && depth > 0 ? (km.macros || []).find(x => x.label === head) : null;
  // The `mc_` test is for the pending case: a macro assigned but not yet written
  // has no node in this file to find, and the tile should still read `email`
  // rather than `mc_email` while the change is unsaved.
  if (mac || /^mc_/.test(head))
    return {short: head.replace(/^mc_/, ""),
            full: ((mac && mac.bindings || []).join(" ") || text).slice(0, 200)};
  // `shift` rides along with whatever ends up on the tile's main line: the tap
  // of a hold-tap, the first press of a tap-dance. A mod-morph gets none - its
  // second binding already *is* what a modifier turns it into, and that is the
  // `.hint` corner's job, not the legend's.
  if (!beh) return {short: label(text), full: text, shift: shiftLegend(text)};
  if (beh.kind === "hold-tap" && beh.bindings.length === 2){
    const hold = resolveBinding(km, [beh.bindings[0], params[0]].filter(Boolean).join(" "), depth - 1);
    const tap  = resolveBinding(km, [beh.bindings[1], params[1]].filter(Boolean).join(" "), depth - 1);
    return {short: tap ? tap.short : label(text), hint: hold ? hold.short : null,
            shift: tap ? tap.shift : "",
            full: `tap: ${tap ? tap.full : "?"}\nhold: ${hold ? hold.full : "?"}`};
  }
  if (beh.kind === "tap-dance"){
    const rows = beh.bindings.map(e => resolveBinding(km, e, depth - 1));
    return {short: rows[0] ? rows[0].short : label(text), hint: rows[1] ? rows[1].short : null,
            shift: rows[0] ? rows[0].shift : "",
            full: rows.map((r, i) => `${i + 1}\u00d7: ${r ? r.full : "?"}`).join("\n")};
  }
  if (beh.kind === "mod-morph" && beh.bindings.length === 2){
    const plain = resolveBinding(km, beh.bindings[0], depth - 1);
    const mod   = resolveBinding(km, beh.bindings[1], depth - 1);
    return {short: plain ? plain.short : label(text), hint: mod ? mod.short : null,
            full: `plain: ${plain ? plain.full : "?"}\nmodified: ${mod ? mod.full : "?"}`};
  }
  return {short: label(text), full: text, shift: shiftLegend(text)};
}

