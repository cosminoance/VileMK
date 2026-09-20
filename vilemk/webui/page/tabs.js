function pickerKey(ent, cur, off){
  const [lbl, code, w] = ent;
  const width = `width:${w*36-4}px`;
  if (!code) return `<span class="sp" style="${width}"></span>`;
  const b = bindOf(code);
  const parts = Array.isArray(lbl) ? lbl : lbl.split("|");
  const body = parts.length > 1
    ? `<span class="up">${esc(parts[0])}</span><span>${esc(parts[1])}</span>`
    : `<span>${esc(parts[0])}</span>`;
  return `<button type="button" class="pk${b === cur ? " sel" : ""}`
       + `${off ? " off" : ""}" style="${width}" data-bind="${esc(b)}"`
       + ` title="${esc(b)}">${body}</button>`;
}

function gridHtml(cur){
  return PICKER.map(r =>
      `<div class="prow">${r.map(e => pickerKey(e, cur)).join("")}</div>`).join("")
    + `<div class="prow extra">`
    + PICKER_EXTRA.map(e => pickerKey(e, cur)).join("") + `</div>`;
}

// The Media & system tab. One group per SYSTEM entry: a heading, the note that
// says what a board needs for the group to work, then its rows - the same
// `.pk[data-bind]` buttons the Keyboard tab draws, so `pickBinding()` assigns
// them with no extra wiring.
//
// One context dims rather than hides: a layer-tap's tap key is a *keycode*,
// since `&lt <n> <code>` wraps whatever the field holds - `&mkp LCLK` there
// would emit `&lt 2 LCLK` and build into nonsense. The media half of this tab is
// perfectly valid in that slot, so the tab stays (unlike VileDance and Layers,
// which `menuTarget()` excludes outright) and only the behaviors go dim.
function systemHtml(cur){
  const kpOnly = state.editing === null && state.emode === "layer";
  return (kpOnly ? `<div class="pnote">A layer-tap's tap key has to be a plain`
                 + ` keycode, so everything that is a behavior of its own is`
                 + ` dimmed here.</div>` : "")
    + SYSTEM.map(g =>
        `<div class="pgroup"><h4>${esc(g.name)}</h4>`
      + `<div class="pnote">${g.note}</div>`
      + g.rows.map(r => `<div class="prow">` + r.map(e =>
            pickerKey(e, cur, kpOnly && !!e[1] && e[1].startsWith("&"))).join("")
          + `</div>`).join("")
      + `</div>`).join("")
    + `<div class="hint">Every button here is a whole binding: with a key open it`
    + ` assigns straight away, exactly like the Keyboard tab. Nothing needs to be`
    + ` added to the keymap's <code>#include</code> lines by hand - saving a variant`
    + ` adds the <code>dt-bindings</code> headers the bindings you used need.</div>`;
}

// A saved-things tab: click the card to fill the field, click its \u270e to open
// the record in the editor area above. `+ New \u2026` opens a blank one there.
const cardEdit = (mode, name) =>
  `<button type="button" class="pkedit" data-edit="${mode}" data-name="${esc(name)}"`
  + ` title="edit ${esc(name)}">\u270e</button>`;

function viledanceHtml(cur){
  const items = STORE.viledance || [];
  if (!items.length)
    return `<div class="hint">No VileDances saved yet.</div>`
         + newRow("viledance", "viledance");
  return `<div class="tdlist">` + items.map(t =>
      `<span class="pkg"><button type="button" class="pk td${usesVd(cur, t.name)?" sel":""}"`
      + ` data-vd="${esc(t.name)}" title="${esc(vdTitle(t))}">`
      + `<span>&amp;${esc(t.name)}</span><span class="up">`
      + esc([t.tap, t.hold, t.double_tap, t.tap_hold].filter(Boolean).join("  /  "))
      + `</span></button>` + cardEdit("viledance", t.name) + `</span>`).join("")
    + `</div>` + newRow("viledance", "viledance");
}

// A saved VileDance is emitted under a generated label (`&ht_<name>`, `&vd_<name>`),
// so match on the reference's last name part, not on the raw name.
const usesVd = (v, name) => {
  const t = (v||"").trim().split(/\s+/)[0].replace(/^&/, "");
  return t === name || t.endsWith("_" + name);
};

// title text for a VileDance card: the resolved four slots, so hovering shows
// exactly what tap / hold / double tap / tap+hold will send, not just the name.
const vdTitle = t => SLOTS.map(([k, lbl]) => t[k] ? `${lbl}: ${t[k]}` : null)
  .filter(Boolean).join("\n");

// The Macros tab. A macro's key binding is always `&mc_<name>` - it does not
// depend on which fields are filled, the way a VileDance's does - so a card is an
// ordinary `data-bind` pick with no `/api/preview` round trip behind it.
// `macroBinding()` is the hand-kept mirror of `emit_macro()`'s label, exactly as
// `layerBinding()` is of `_emit_layer()`.
const macroBinding = m => `&mc_${m.name}`;
const stepText = s =>
    s.action === "text" ? `"${s.text || ""}"`
  : s.action === "wait" ? `wait ${s.ms || 0}ms`
  : s.action === "pause" ? "pause until release"
  : `${s.action} ${s.binding || "?"}`;
const macroTitle = m => (m.steps || []).map(stepText).join("\n");
const macroSummary = m => {
  const t = (m.steps || []).map(stepText).join("  \u00b7  ");
  return t.length > 46 ? t.slice(0, 45) + "\u2026" : t;
};

function macroHtml(cur){
  const items = STORE.macro || [];
  if (!items.length)
    return `<div class="hint">No macros saved yet. A macro is a sequence the keyboard`
         + ` plays back from one key: text, taps, a modifier held across them, a wait.`
         + `</div>` + newRow("macro", "macro");
  return `<div class="tdlist">` + items.map(m =>
      `<span class="pkg"><button type="button" class="pk td`
      + `${macroBinding(m) === cur ? " sel" : ""}" data-bind="${esc(macroBinding(m))}"`
      + ` title="${escA(macroTitle(m))}"><span>&amp;mc_${esc(m.name)}</span>`
      + `<span class="up">${esc(macroSummary(m))}</span></button>`
      + cardEdit("macro", m.name) + `</span>`).join("")
    + `</div>` + newRow("macro", "macro");
}

function modifierHtml(cur){
  const items = STORE.modifier || [];
  if (!items.length)
    return `<div class="hint">No modifiers saved yet.</div>`
         + newRow("modifier", "modifier");
  return `<div class="tdlist">` + items.map(m =>
      `<span class="pkg"><button type="button" class="pk td${modBinding(m)===cur?" sel":""}"`
      + ` data-mod="${esc(m.name)}" title="${esc(modBinding(m))}">`
      + `<span>${esc(m.name)}</span><span class="up">${esc(modBinding(m))}</span>`
      + `</button>` + cardEdit("modifier", m.name) + `</span>`).join("")
    + `</div>` + newRow("modifier", "modifier");
}

// A blank layer's bindings: `&trans` at every position this keyboard has. Read
// off an existing layer's length when there is one - the source of truth for
// key count - and fall back to the selected layout only for a keyboard with no
// layers at all.
function blankBindings(km){
  const n = km.layers.length ? km.layers[0].bindings.length
          : (km.layouts[Math.min(state.layout, km.layouts.length-1)] || {}).count || 0;
  return Array.from({length:n}, () => "&trans");
}

// This keyboard's layers, its own plus any added-but-not-yet-saved ones from
// `state.newLayers` - the two are indistinguishable everywhere else in the page
// (the tab bar, the picker's Layers tab, a layer entry's layer-number select),
// since a pending layer edits and previews exactly like a real one; only "Save
// as variant" needs to tell them apart.
function layersOf(km){
  if (!km) return [];
  const pending = state.newLayers[km.id] || [];
  return km.layers.concat(pending.map(p =>
      ({name:p.name, display:p.name, bindings: blankBindings(km),
        reserved:false, pending:true})));
}

// The layers this keyboard has, or 0-9 when no keymap is selected - a layer number
// is a number, and the picker should not refuse to offer one just because nothing
// on the left is highlighted.
function layerRows(){
  const km = byId(state.id);
  const all = layersOf(km);
  return all.length ? all.map((l, i) => [i, l.display])
                    : Array.from({length:10}, (_, i) => [i, ""]);
}

// The keycode a layer-tap would tap, taken from whatever is in the field already:
// `&kp SPACE` -> SPACE, `&lt 3 SPACE` -> SPACE (so clicking another layer moves it),
// anything else -> "". That is what makes "click SPACE on the Keyboard tab, then
// click `lt 2` here" work.
function ltCode(v){
  const t = (v || "").trim().split(/\s+/);
  if (t.length === 2 && /^&kp$/.test(t[0])) return t[1];
  if (t.length === 3 && /^&lt/.test(t[0])) return t[2];
  return "";
}

// Two ways in, and the ad-hoc one comes first: `&mo` and `&lt` are built into ZMK, so
// a layer binding needs nothing saved anywhere. The saved cards below are names for
// the ones worth reusing - a bonus, not the way in. A conditional layer is never
// listed either way: it goes on no key.
function layerHtml(cur){
  const rows = layerRows();
  const code = ltCode(cur);
  const sel = bind => bind && bind === (cur||"").trim() ? " sel" : "";
  // Four of the five rows are whole bindings, so they are ordinary `data-bind`
  // picks - the same button the Keyboard tab emits, wired and highlighted by the
  // same two lines. `&lt` is the one that cannot be: it composes with the keycode
  // the field already holds, so it keeps its own `data-lt` and its own handler.
  const cell = (n, name, bind) =>
    `<button type="button" class="pk${sel(bind)}" style="width:68px"`
    + ` data-bind="${esc(bind)}" title="${esc(bind)}">`
    + `<span class="up">${esc(name || ("layer " + n))}</span><span>${n}</span></button>`;
  const ltCell = (n, name) => {
    const bind = code ? `&lt ${n} ${code}` : "";
    return `<button type="button" class="pk${sel(bind)}" style="width:68px"`
      + ` data-lt="${n}" title="${esc(bind || `&lt ${n} <key>`)}">`
      + `<span class="up">${esc(name || ("layer " + n))}</span><span>${n}</span></button>`;
  };
  const row = (label, cells) =>
    `<div class="prow"><span class="ptarget" style="width:112px">${label}</span>`
    + cells + `</div>`;
  let h = `<div class="hint">Click a layer to fill the field - nothing has to be saved`
        + ` for this. <b>Hold</b> is <code>&amp;mo</code>, on only while it is held.`
        + ` <b>Tap key / hold layer</b> is <code>&amp;lt</code>, wrapping the key the`
        + ` field already holds`
        + (code ? ` - right now <code>${esc(code)}</code>.`
                : `, so pick one on the <b>Keyboard</b> tab first (or type it in).`)
        + ` <b>Sticky</b> is <code>&amp;sl</code>: one shot, for the next key only.`
        + ` <b>Toggle</b> is <code>&amp;tog</code>: on until it is pressed again.`
        + ` <b>Switch to</b> is <code>&amp;to</code>: on, and every other layer off -`
        + ` which is a one-way trip unless the layer you land on can get back.</div>`
    + row("Hold", rows.map(([n, name]) => cell(n, name, `&mo ${n}`)).join(""))
    + row("Tap key / hold layer", rows.map(([n, name]) => ltCell(n, name)).join(""))
    + row("Sticky", rows.map(([n, name]) => cell(n, name, `&sl ${n}`)).join(""))
    + row("Toggle", rows.map(([n, name]) => cell(n, name, `&tog ${n}`)).join(""))
    + row("Switch to", rows.map(([n, name]) => cell(n, name, `&to ${n}`)).join(""));
  const items = (STORE.layer || []).filter(r => (r.mode||"lt") !== "conditional");
  if (items.length)
    h += `<div class="tdlist">` + items.map(r =>
        `<span class="pkg"><button type="button" class="pk td${usesLayer(cur, r)?" sel":""}"`
        + ` data-lay="${esc(r.name)}" title="${esc(layerTitle(r))}">`
        + `<span>${esc(r.name)}</span><span class="up">${esc(layerBinding(r))}</span>`
        + `</button>` + cardEdit("layer", r.name) + `</span>`).join("") + `</div>`;
  return h + newRow("layer", "layer-tap");
}

