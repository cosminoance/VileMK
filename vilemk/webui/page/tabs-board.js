// ------------------------------------------- the two board-wide tabs
// Neither a combo nor a conditional layer goes on a key, so neither tab fills
// anything: a row is a switch plus a way into its record. `enabled` is exactly
// what `build_variant()` already reads - on means it is written into the next
// variant, off means it is left out.
function brow(mode, r, sub, scope){
  const on = scopeOn(r, scope);
  const open = state.emode === mode && (draftOf(mode).name || "") === r.name;
  const elsewhere = Object.keys(r.scopes || {}).filter(k => r.scopes[k] && k !== scope);
  return `<div class="brow${on ? "" : " off"}${open ? " sel" : ""}">`
    + `<button type="button" class="tgl ${on ? "on" : "off"}" data-tgl="${mode}"`
    + ` data-name="${esc(r.name)}" title="${on ? "written into this keymap's variant"
                                              : "left out of this keymap's variant"}`
    + `${elsewhere.length ? "\n\nalso on for: " + esc(elsewhere.join(", ")) : ""}">`
    + `${on ? "On" : "Off"}</button>`
    + `<button type="button" class="bopen" data-edit="${mode}" data-name="${esc(r.name)}">`
    + `<span class="nm">${esc(r.name)}</span><small>${esc(sub)}</small></button></div>`;
}

const boardList = (mode, items, sub, label) => {
  const scope = scopeOf(byId(state.id));
  return (items.length ? `<div class="blist">`
      + items.map(r => brow(mode, r, sub(r), scope)).join("") + `</div>`
    : `<div class="hint">nothing saved yet</div>`) + newRow(mode, label);
};

// The line both board-wide tabs end their hint with: which keymap these switches
// are answering for. A config or vendor keymap is never written to (only
// `variants/` is ours), so there the switches describe the variant about to be
// saved from it; the flags follow that variant under its own name.
function scopeNote(){
  const km = byId(state.id);
  if (!km) return `<div class="hint">Pick a keyboard on the left first.</div>`;
  return `<div class="hint">These switches are <b>for ${esc(km.name)}</b> only`
       + (km.kind === "variant"
          ? ` \u2013 each saved variant keeps its own set.`
          : ` \u2013 <code>${esc(km.kind)}</code> keymaps are never written to, so`
            + ` what is On here is what goes into the next variant you save from`
            + ` it, and stays On for that variant afterwards.`)
       + `</div>`;
}

function comboHtml(){
  return `<div class="hint">A combo is <b>board-wide</b>: press two or more keys`
       + ` together, anywhere. It sits on no key of its own, so there is nothing to`
       + ` pick here - switch one <b>On</b> and it goes into this keymap's variant,`
       + ` <b>Off</b> and it is left out. Click a row to edit it; the board above is`
       + ` where its chord is chosen.</div>`
    + scopeNote()
    + boardList("combo", STORE.combo || [],
        r => `${(r.key_positions||[]).join(" + ")} \u2192 ${r.binding || "?"}`,
        "combo");
}

function conditionalHtml(){
  const items = (STORE.layer || []).filter(r => (r.mode||"lt") === "conditional");
  return `<div class="hint">A conditional layer is <b>board-wide</b> too: hold`
       + ` <b>all</b> of its if-layers at once and the then-layer comes on top - the`
       + ` tri-layer trick. Nothing references it, so nothing can pull it in for you:`
       + ` <b>On</b> writes it into this keymap's variant, <b>Off</b> leaves it out.</div>`
    + scopeNote()
    + boardList("conditional", items,
        r => `hold ${(r.if_layers||[]).join(" + ")} \u2192 layer ${r.then_layer ?? "?"}`,
        "conditional layer");
}

// The bottom row of every tab that lists saved things. It opens that kind's real
// creation panel in the editor area above - no navigation, nothing lost: the field
// you came from is still up there, and this menu still fills it.
//
// Clicking a key on the board closes whatever panel was open (only one thing fits
// in the editor area), so a half-typed draft would otherwise have no way back:
// `+ New` blanks it. Hence **Resume**, which appears exactly when there is a
// dirty draft for this kind and it is not already on screen.
function newRow(mode, label){
  const d = state.drafts[mode];
  const dirty = d && state.emode !== mode
             && JSON.stringify(d) !== JSON.stringify(BLANK[mode]());
  return `<div class="rowbtns">`
    + (dirty ? `<button type="button" class="ghost sm" data-open="${mode}">`
               + `Resume ${esc(d.name || "unnamed " + label)}…</button>` : "")
    + `<button type="button" class="ghost sm" data-new="${mode}">+ New ${label}…</button>`
    + `</div>`;
}

