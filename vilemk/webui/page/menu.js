// One menu, six tabs. The first four fill the binding field open above them; the
// last two are board-wide and fill nothing, so a separator sits between the sets.
const PTABS = [["keyboard","Keyboard"], ["system","Media & system"],
               ["viledance","VileDance"], ["macro","Macros"],
               ["modifier","Modifiers"], ["layer","Layers"],
               ["combo","Combos"], ["conditional","Conditional layers"]];
const BOARD_TABS = ["combo", "conditional"];

// The picker body is re-rendered on its own when you switch tabs, so that
// whatever is half-typed in the field it writes into survives the switch.
// `ptab` defaults to `state.ptab`; a caller with a narrowed tab set passes the
// resolved one instead, since `state.ptab` may be pointing at a tab this call
// excludes (see `menuHtml()`).
function pickerBody(cur, ptab){
  ptab = ptab || state.ptab;
  return ptab === "system" ? systemHtml(cur)
       : ptab === "viledance" ? viledanceHtml(cur)
       : ptab === "macro" ? macroHtml(cur)
       : ptab === "modifier" ? modifierHtml(cur)
       : ptab === "layer" ? layerHtml(cur)
       : ptab === "combo" ? comboHtml()
       : ptab === "conditional" ? conditionalHtml()
       : gridHtml(cur);
}

// What the menu is filling right now, and which tabs this context forbids. Two
// contexts narrow: a VileDance's own slots cannot take another VileDance, and a
// layer-tap's tap key can take neither a layer nor a VileDance (see
// views/viledance.md and views/layer.md). With nothing open in the editor area
// there is no field at all, and the menu still draws: the board-wide tabs never
// had one.
function menuTarget(km, layer){
  if (state.editing !== null){
    const orig = layer ? layer.bindings[state.editing] : "";
    const cur = (state.assign[state.layer] || {})[state.editing] ?? orig ?? "";
    return {cur: String(cur).trim(), exclude: []};
  }
  const d = state.emode ? draftOf(state.emode) : null;
  if (state.emode === "viledance") return {cur:(d.tap||"").trim(),
                                           exclude:["viledance"]};
  if (state.emode === "macro"){
    const st = (d.steps || []).find(x => x.binding);
    return {cur:(st ? st.binding : "").trim(), exclude:["macro"]};
  }
  if (state.emode === "combo")     return {cur:(d.binding||"").trim(), exclude:[]};
  if (state.emode === "modifier")  return {cur:(d.param||"").trim(), exclude:[]};
  if (state.emode === "layer")     return {cur:(d.key||"").trim(),
                                           exclude:["viledance","layer","macro"]};
  return {cur:"", exclude:[]};
}

// The one menu. Always rendered in LIVE mode, below whatever the editor area
// holds; a separator splits the four field-filling tabs from the two board-wide
// ones, because those two mean something else entirely.
function menuHtml(km, layer){
  const t = menuTarget(km, layer);
  const tabs = PTABS.filter(([v]) => !t.exclude.includes(v));
  const ptab = t.exclude.includes(state.ptab) ? "keyboard" : state.ptab;
  return `<div class="menu"><div class="tabs picktabs">`
    + tabs.map(([v,l]) =>
        (v === BOARD_TABS[0] ? `<span class="sep"></span>` : "")
        + `<button data-ptab="${v}" class="${ptab===v?"sel":""}">${esc(l)}</button>`).join("")
    + `<button class="ghost sm" id="kb-toggle">`
    + `${state.picker ? "Hide" : "Show"}</button>`
    + `<span class="ptarget" id="kb-target"></span></div>`
    + `<div class="picker${state.picker ? "" : " hidden"}" id="kb-picker">`
    + pickerBody(t.cur, ptab) + `</div></div>`;
}

// Which tab a binding belongs to. Clicking a key on the board opens its editor,
// and the menu underneath follows it there: a thumb key holding a VileDance
// lands on the VileDance tab with that card already highlighted, rather than on
// whichever tab the last click left behind.
//
// The tests are the same ones `markPicker()` highlights with, in the same order,
// so the tab that opens is always the tab holding the selected card. The saved
// kinds go first - a record's own label is the most specific thing a binding can
// be - then ZMK's built-in layer bindings, then the Media & system set (looked up
// once, from the same table that draws it), and everything left is a keycode.
const SYSTEM_BINDS = new Set(
    SYSTEM.flatMap(g => g.rows.flat()).filter(e => e[1]).map(e => bindOf(e[1])));

function tabForBinding(v){
  const t = (v || "").trim();
  if (!t) return "keyboard";
  if ((STORE.macro || []).some(m => macroBinding(m) === t)) return "macro";
  if ((STORE.modifier || []).some(m => modBinding(m) === t)) return "modifier";
  if ((STORE.layer || []).some(r => (r.mode||"lt") !== "conditional"
                                 && usesLayer(t, r))) return "layer";
  if ((STORE.viledance || []).some(x => usesVd(t, x.name))) return "viledance";
  if (/^&(mo|lt|sl|tog|to)\b/.test(t)) return "layer";
  if (SYSTEM_BINDS.has(t)) return "system";
  // A modifier chain that is nobody's saved record - `&kp LC(LS(A))`, typed in or
  // baked in by a record since edited. The Keyboard grid has no button for it
  // either; the Modifiers tab is at least where one gets made.
  if (CHAIN_RE.test(codeOf(t))) return "modifier";
  return "keyboard";
}
