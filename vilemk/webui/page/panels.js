// ------------------------------------------------------- the editor area
// One slot, directly under the board and above the menu. It holds at most one
// thing: the clicked key's editor, or a creation panel for one of the five
// kinds. Opening either closes the other - there is nowhere to put two.
const BLANK = {
  viledance: () => ({name:"", tap:"", hold:"", double_tap:"", tap_hold:"",
                    tapping_term_ms:200, flavor:"tap-preferred"}),
  macro:    () => ({name:"", steps:[{action:"text", text:""}],
                    wait_ms:0, tap_ms:0}),
  combo:    () => ({name:"", binding:"", timeout_ms:50, key_positions:[],
                    layers:[], scopes:{}}),
  modifier: () => ({name:"", mods:[], param:""}),
  layer:    () => ({name:"", mode:"lt", layer:0, key:"", tapping_term_ms:0,
                    flavor:""}),
  conditional: () => ({name:"", mode:"conditional", if_layers:[], then_layer:0,
                    scopes:{}})
};
const SLOTS = [["tap","On tap"], ["hold","On hold"],
               ["double_tap","On double tap"], ["tap_hold","On tap + hold"]];

// A conditional layer is its own editor mode even though it saves as kind
// "layer": the two shapes share nothing but a name, and after the merge they
// live in different tabs. This is the one place the two vocabularies meet.
const KIND_OF = {viledance:"viledance", macro:"macro", combo:"combo",
                 modifier:"modifier", layer:"layer", conditional:"layer"};

// Drafts are per mode, not one shared `pick`. Clicking a key, or switching to
// another kind's tab, must not throw away a half-typed combo.
function draftOf(mode){
  if (!state.drafts[mode]) state.drafts[mode] = BLANK[mode]();
  return state.drafts[mode];
}

// The saved record behind a card or a board-wide row. `conditional` and `layer`
// share one store and are told apart by `mode`, the same split `layerHtml()` and
// `conditionalHtml()` make when they list them.
function recordOf(mode, name){
  const items = STORE[KIND_OF[mode]] || [];
  if (mode === "layer")
    return items.find(r => r.name === name && (r.mode||"lt") !== "conditional");
  if (mode === "conditional")
    return items.find(r => r.name === name && (r.mode||"lt") === "conditional");
  return items.find(r => r.name === name);
}

const PANEL_TITLES = {viledance:"VileDance", macro:"Macro", combo:"Combo",
                      modifier:"Modifier", layer:"Layer-tap",
                      conditional:"Conditional layer"};

function editorHtml(km, layer){
  if (state.editing !== null) return keyEditor(km, layer);
  if (!state.emode) return "";
  const d = draftOf(state.emode);
  const panel = state.emode === "viledance" ? viledancePanel(d)
              : state.emode === "macro" ? macroPanel(d)
              : state.emode === "combo" ? comboPanel(d)
              : state.emode === "modifier" ? modifierPanel(d)
              : state.emode === "conditional" ? condPanel(d, km)
              : layerTapPanel(d, km);
  return `<div class="editor" style="margin-bottom:16px">` + panel + `</div>`
       + (state.dts ? `<pre class="dts">${esc(state.dts)}</pre>` : "");
}

function viledancePanel(d){
  return `<div class="panel"><h3>${PANEL_TITLES.viledance}</h3>`
    + `<div class="slot"><span>Name</span>`
    + `<input class="kb wide" id="f-name" value="${esc(d.name)}" placeholder="e.g. bkspshift"></div>`
    + SLOTS.map(([k, lbl]) =>
        `<div class="slot"><span>${lbl}</span>`
        + `<input class="kb" data-f="${k}" value="${esc(d[k]||"")}"`
        + ` placeholder="${k==="tap"?"&kp BSPC":""}"></div>`).join("")
    + `<div class="slot"><span>Tapping term (ms)</span>`
    + `<input class="kb sm" data-f="tapping_term_ms" value="${esc(d.tapping_term_ms??200)}"></div>`
    + `<div class="slot"><span>Flavor</span><select class="kb wide" data-f="flavor">`
    + ["tap-preferred","hold-preferred","balanced","tap-unless-interrupted"].map(f =>
        `<option ${f===d.flavor?"selected":""}>${f}</option>`).join("")
    + `</select></div>`
    + `<div class="hint">Fill <b>on tap</b> alone and it is just a key. Add <b>on hold</b>`
    + ` and it becomes a hold-tap. Add <b>on double tap</b> and it becomes a VileDance`
    + ` holding one or two hold-taps - <b>on tap + hold</b> needs <b>on double tap</b>`
    + ` filled too, since they're the same second press. Each slot takes a full ZMK`
    + ` binding (<code>&amp;kp BSPC</code>, <code>&amp;mo 2</code>) and, in a hold slot,`
    + ` must be a behavior of exactly one parameter. The <b>on tap + hold</b> row always`
    + ` uses the <code>balanced</code> flavor regardless of the setting above, so a held`
    + ` layer key engages right away instead of waiting out the term twice. Click a slot,`
    + ` then pick from the menu below.</div>`
    + buttons() + `</div>`;
}

// The one panel whose fields are a *list*, which is the one thing the panel
// machinery had no shape for. Each row is still an ordinary `.slot` with a
// `data-f` input, so the menu fills whichever was focused last and `markPicker()`
// can name it - the only new part is that `data-f` carries an index here
// (`step:2`, `text:0`, `ms:1`), parsed by `wirePanel()`.
const STEP_LABELS = {tap:"Tap", press:"Press", release:"Release",
                     wait:"Wait (ms)", pause:"Pause", text:"Text"};
const STEP_ADD = ["text", "tap", "press", "release", "wait", "pause"];
const BLANK_STEP = a => a === "text" ? {action:"text", text:""}
                      : a === "wait" ? {action:"wait", ms:50}
                      : a === "pause" ? {action:"pause"} : {action:a, binding:""};
// Where the caret goes after a step is added - each kind of row has its own
// field name, and `pause` has no field at all.
const stepField = (a, i) => a === "text" ? `text:${i}` : a === "wait" ? `ms:${i}`
                          : a === "pause" ? null : `step:${i}`;

function stepRow(s, i, n){
  const field =
      s.action === "text"
        ? `<input class="kb wide" data-f="text:${i}" value="${escA(s.text||"")}"`
          + ` placeholder="type the text here">`
    : s.action === "wait"
        ? `<input class="kb sm" data-f="ms:${i}" value="${esc(s.ms ?? 50)}">`
    : s.action === "pause"
        ? `<div class="path">holds here until the key is released</div>`
        : `<input class="kb" data-f="step:${i}" value="${escA(s.binding||"")}"`
          + ` placeholder="&kp A">`;
  return `<div class="slot"><span>${i+1}. ${esc(STEP_LABELS[s.action] || s.action)}`
    + `</span>` + field
    + `<button type="button" class="ghost sm" data-mv="up:${i}"`
    + `${i ? "" : " disabled"}>&uarr;</button>`
    + `<button type="button" class="ghost sm" data-mv="down:${i}"`
    + `${i < n-1 ? "" : " disabled"}>&darr;</button>`
    + `<button type="button" class="ghost sm danger" data-rm="${i}">&times;</button>`
    + `</div>`;
}

function macroPanel(d){
  const steps = d.steps || [];
  return `<div class="panel"><h3>${PANEL_TITLES.macro}</h3>`
    + `<div class="slot"><span>Name</span>`
    + `<input class="kb wide" id="f-name" value="${esc(d.name)}" placeholder="e.g. email">`
    + `</div>`
    + (steps.length ? steps.map((s, i) => stepRow(s, i, steps.length)).join("")
                    : `<div class="hint">No steps yet - add one below.</div>`)
    + `<div class="modrow">` + STEP_ADD.map(a =>
        `<button type="button" class="ghost sm" data-add="${a}">+ ${a}</button>`).join("")
    + `</div>`
    + `<div class="slot"><span>Wait between (ms)</span>`
    + `<input class="kb sm" data-f="wait_ms" value="${esc(d.wait_ms||"")}"`
    + ` placeholder="15 - built-in"></div>`
    + `<div class="slot"><span>Tap length (ms)</span>`
    + `<input class="kb sm" data-f="tap_ms" value="${esc(d.tap_ms||"")}"`
    + ` placeholder="30 - built-in"></div>`
    + `<div class="hint"><b>Text</b> is the short way to say "type this": it is`
    + ` expanded into one tap per character when the keymap is written, so`
    + ` <code>a@b.com</code> stays one step here instead of seven.`
    + ` <b>Tap</b>, <b>Press</b> and <b>Release</b> each take a whole binding - click`
    + ` the row, then pick it from the menu below - and press/release come in pairs`
    + ` around the keys they apply to. <b>Wait</b> pauses mid-sequence;`
    + ` <b>Pause</b> stops there until the key the macro is on is released, which is`
    + ` how a macro holds something down for as long as you do. ZMK's queue holds 64`
    + ` behaviors and a tap costs two - go over and saving says so rather than`
    + ` letting the firmware stop half way.</div>`
    + buttons() + `</div>`;
}

function comboPanel(d){
  return `<div class="panel"><h3>${PANEL_TITLES.combo}</h3>`
    + `<div class="slot"><span>Name</span>`
    + `<input class="kb wide" id="f-name" value="${esc(d.name)}" placeholder="e.g. jk_quote"></div>`
    + `<div class="slot"><span>Keys</span>`
    + `<input class="kb wide" data-f="key_positions" value="${esc((d.key_positions||[]).join(" "))}"`
    + ` placeholder="click the board above"></div>`
    + `<div class="slot"><span>Output key</span>`
    + `<input class="kb" data-f="binding" value="${esc(d.binding||"")}" placeholder="&kp SQT"></div>`
    + `<div class="slot"><span>Timeout (ms)</span>`
    + `<input class="kb sm" data-f="timeout_ms" value="${esc(d.timeout_ms??50)}"></div>`
    + `<div class="slot"><span>Layers</span>`
    + `<input class="kb wide" data-f="layers" value="${esc((d.layers||[]).join(" "))}"`
    + ` placeholder="blank = all layers"></div>`
    + `<div class="hint">While this panel is open the <b>board above is the chord`
    + ` picker</b> - click keys on it to add and remove positions. ZMK identifies combo`
    + ` keys by position, not by what they currently send, so the positions are what`
    + ` gets written. The <b>output key</b> is an ordinary binding: fill it from the`
    + ` menu below. A combo goes on no key of its own, so it is written into a variant`
    + ` when it is switched <b>On</b> in the <b>Combos</b> tab.</div>`
    + buttons() + `</div>`;
}

// The modifier chain is built by clicking, not picked from the shared menu: it is
// eight buttons and a nesting order, nothing the keyboard grid could express. They
// sit in the panel itself now, so the menu below is free to fill `Parameter`.
function modifierPanel(d){
  const mods = d.mods || [];
  const full = mods.length >= 3;
  return `<div class="panel"><h3>${PANEL_TITLES.modifier}</h3>`
    + `<div class="slot"><span>Name</span>`
    + `<input class="kb wide" id="f-name" value="${esc(d.name)}" placeholder="e.g. ctrl_shift_a"></div>`
    + `<div class="slot"><span>Modifier</span>`
    + `<input class="kb wide" data-f="mod" value="${esc(modChainText(mods))}"`
    + ` placeholder="click a modifier below"></div>`
    + `<div class="modrow">`
    + MODS.map(m => `<button type="button" class="pk td mkey${full ? " off" : ""}"`
        + ` data-mkey="${m}" title="${esc(MOD_LABELS[m])}">`
        + `<span>${MOD_LABELS[m]}</span><span class="up">${m}</span></button>`).join("")
    + (mods.length
        ? `<button type="button" class="ghost sm" id="mod-undo">&larr; remove last</button>`
          + `<button type="button" class="ghost sm" id="mod-clear">clear</button>`
        : "")
    + `</div>`
    + `<div class="slot"><span>Parameter</span>`
    + `<input class="kb" data-f="param" value="${esc(d.param||"")}" placeholder="&kp A"></div>`
    + `<div class="hint">Click up to three modifiers to nest them`
    + ` (${full ? "three is the limit - " : ""}<code>LS</code>/<code>RS</code> shift,`
    + ` <code>LC</code>/<code>RC</code> control, <code>LA</code>/<code>RA</code> alt,`
    + ` <code>LG</code>/<code>RG</code> gui, left or right, outermost first), then fill`
    + ` <b>Parameter</b> from the menu below - the key they wrap. This bakes the result`
    + ` in as plain ZMK text wherever it is picked: editing a saved modifier later does`
    + ` not change keys that already used it; re-pick it to update them.</div>`
    + buttons() + `</div>`;
}

// A layer number field: this keyboard's own layers by name when one is selected,
// a plain number when none is (a layer entry is worth writing either way - the
// generated keymap only cares about the index).
function layerSelect(km, field, value){
  const all = layersOf(km);
  if (!all.length)
    return `<input class="kb sm" data-f="${field}" value="${esc(value ?? 0)}"`
         + ` placeholder="0">`;
  return `<select class="kb wide" data-f="${field}">` + all.map((l,i) =>
      `<option value="${i}" ${i === (+value||0) ? "selected" : ""}>`
      + `${i} &middot; ${esc(l.display)}</option>`).join("") + `</select>`;
}

// The two layer shapes have their own panels now, because they have their own
// tabs: a layer-tap goes on a key and is picked from the Layers tab, a
// conditional layer goes on none and is switched on in the Conditional layers
// tab. There is no "kind" select left to get them confused.
function layerTapPanel(d, km){
  return `<div class="panel"><h3>${PANEL_TITLES.layer}</h3>`
    + `<div class="slot"><span>Name</span>`
    + `<input class="kb wide" id="f-name" value="${esc(d.name)}"`
    + ` placeholder="e.g. nav_space"></div>`
    + `<div class="slot"><span>Layer</span>` + layerSelect(km, "layer", d.layer) + `</div>`
    + `<div class="slot"><span>Tap key</span>`
    + `<input class="kb" data-f="key" value="${esc(d.key||"")}"`
    + ` placeholder="&kp SPACE"></div>`
    + `<div class="slot"><span>Tapping term (ms)</span>`
    + `<input class="kb sm" data-f="tapping_term_ms"`
    + ` value="${esc(d.tapping_term_ms||"")}" placeholder="200 - built-in"></div>`
    + `<div class="slot"><span>Flavor</span><select class="kb wide" data-f="flavor">`
    + [["","balanced - built-in"], ["balanced","balanced"],
       ["tap-preferred","tap-preferred"], ["hold-preferred","hold-preferred"],
       ["tap-unless-interrupted","tap-unless-interrupted"]].map(([v,l]) =>
        `<option value="${v}" ${v===(d.flavor||"")?"selected":""}>${l}</option>`).join("")
    + `</select></div>`
    + `<div class="hint">Tap it for the key, hold it for the layer - and the`
    + ` <b>Layers</b> tab below makes one of these without saving anything, so this`
    + ` panel is for the ones worth a name, and for the timing below. Leave the term`
    + ` and flavor alone and this is ZMK's own <code>&amp;lt</code> - nothing is`
    + ` generated, and the tap has to be a plain keycode. Set either one and it becomes`
    + ` a generated hold-tap (<code>lt_&lt;name&gt;</code>) holding <code>&amp;mo</code>`
    + ` over your tap key, which is what <code>&amp;lt</code> is anyway - that version`
    + ` can tap any behavior of exactly one parameter. Click <b>Tap key</b>, then pick`
    + ` from the menu below.</div>`
    + buttons() + `</div>`;
}

function condPanel(d, km){
  return `<div class="panel"><h3>${PANEL_TITLES.conditional}</h3>`
    + `<div class="slot"><span>Name</span>`
    + `<input class="kb wide" id="f-name" value="${esc(d.name)}"`
    + ` placeholder="e.g. tri_layer"></div>`
    + `<div class="slot"><span>If layers</span>`
    + `<input class="kb wide" data-f="if_layers"`
    + ` value="${esc((d.if_layers||[]).join(" "))}" placeholder="1 2"></div>`
    + `<div class="slot"><span>Then layer</span>`
    + layerSelect(km, "then_layer", d.then_layer) + `</div>`
    + `<div class="hint">Hold <b>all</b> of the <b>if</b> layers at once and <b>then`
    + ` layer</b> activates on top - the tri-layer trick: hold 1 and 2 together to get`
    + ` 3. Two or more if-layers, and the then-layer cannot be one of them. This goes`
    + ` on no key: it is a <code>zmk,conditional-layers</code> node watching the layers`
    + ` the rest of your keymap already turns on, so nothing here can reference it and`
    + ` nothing below fills a field. Whether it reaches a variant is the <b>On</b>/`
    + `<b>Off</b> switch on its row in the <b>Conditional layers</b> tab.</div>`
    + buttons() + `</div>`;
}

const buttons = () => `<div class="rowbtns">`
  + `<button class="act" id="save">Save</button>`
  + `<button class="ghost" id="preview">Devicetree</button>`
  + `<button class="ghost" id="close">Close</button>`
  + `<button class="ghost danger" id="del">Delete</button></div>`;

