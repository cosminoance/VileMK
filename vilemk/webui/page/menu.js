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

