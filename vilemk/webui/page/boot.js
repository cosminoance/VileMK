// The binding inputs the menu below may write into: whichever of the six things
// the editor area has open, or none.
function menuFields(){
  if (state.editing !== null) return [$("#kb-val")].filter(Boolean);
  if (state.emode === "viledance")
    return SLOTS.map(([k]) => $(`[data-f="${k}"]`)).filter(Boolean);
  if (state.emode === "macro")
    return [...document.querySelectorAll('[data-f^="step:"]')];
  if (state.emode === "combo") return [$('[data-f="binding"]')].filter(Boolean);
  if (state.emode === "modifier") return [$('[data-f="param"]')].filter(Boolean);
  if (state.emode === "layer") return [$('[data-f="key"]')].filter(Boolean);
  return [];
}

function wireEditor(km, layer){
  wireKeyEditor(km);
  if (state.editing === null && state.emode) wirePanel(km);
  wireMenu(menuFields());
}

function wirePanel(km){
  const mode = state.emode, kind = KIND_OF[mode], d = draftOf(mode);
  const nameEl = $("#f-name");
  if (nameEl) nameEl.oninput = e => { d.name = e.target.value; };
  $("#main").querySelectorAll("[data-f]").forEach(el => {
    el.oninput = el.onchange = e => {
      const f = el.dataset.f, v = e.target.value;
      // A macro step: the only `data-f` that carries an index.
      const st = /^(step|text|ms):(\d+)$/.exec(f);
      if (st){
        const step = (d.steps || [])[+st[2]];
        if (!step) return;
        if (st[1] === "step") step.binding = v;
        else if (st[1] === "text") step.text = v;
        else step.ms = +v || 0;
        return;
      }
      if (f === "key_positions" || f === "layers" || f === "if_layers")
        d[f] = v.split(/[\s,]+/).filter(Boolean).map(Number);
      else if (f === "timeout_ms" || f === "tapping_term_ms" || f === "layer"
               || f === "then_layer" || f === "wait_ms" || f === "tap_ms")
        d[f] = +v || 0;
      else if (f === "mod") d.mods = parseModChain(v);
      else d[f] = v;
      // The board's `.pick` highlighting mirrors this field, so it has to redraw.
      if (f === "key_positions"){ state.refocus = f; render(); }
    };
  });
  $("#main").querySelectorAll(".modrow [data-mkey]").forEach(el => el.onclick = () => {
    if ((d.mods||[]).length >= 3) return;
    d.mods = [...(d.mods||[]), el.dataset.mkey];
    state.refocus = "mod"; render();
  });
  // The steps list. Every one of these re-renders the page, so the caret is put
  // back the same way the modifier chain does it - `state.refocus`.
  $("#main").querySelectorAll("[data-add]").forEach(el => el.onclick = () => {
    const a = el.dataset.add;
    d.steps = [...(d.steps || []), BLANK_STEP(a)];
    state.refocus = stepField(a, d.steps.length - 1);
    render();
  });
  $("#main").querySelectorAll("[data-rm]").forEach(el => el.onclick = () => {
    d.steps = (d.steps || []).filter((_, i) => i !== +el.dataset.rm);
    render();
  });
  $("#main").querySelectorAll("[data-mv]").forEach(el => el.onclick = () => {
    const [dir, at] = el.dataset.mv.split(":");
    const steps = d.steps || [], i = +at, j = dir === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    state.refocus = stepField(steps[j].action, j);
    render();
  });
  const undo = $("#mod-undo");
  if (undo) undo.onclick = () => {
    d.mods = (d.mods||[]).slice(0,-1); state.refocus = "mod"; render(); };
  const clr = $("#mod-clear");
  if (clr) clr.onclick = () => { d.mods = []; state.refocus = "mod"; render(); };
  $("#save").onclick = () => saveItem(mode, kind, d);
  $("#preview").onclick = () => previewItem(kind, d);
  $("#del").onclick = () => deleteItem(mode, kind, d);
  $("#close").onclick = () => { state.emode = null; state.dts = null; say(null); render(); };
}

async function saveItem(mode, kind, d){
  // A brand-new board-wide record is switched on for the keymap it was designed
  // against and nowhere else - that is the "off unless you say so" rule, minus
  // the pointless step of switching on the one you are obviously making it for.
  // An existing record's scopes are left exactly as they are.
  if (BOARD_TABS.includes(mode) && !recordOf(mode, d.name)){
    const scope = scopeOf(byId(state.id));
    if (scope) d.scopes = {...(d.scopes || {}), [scope]: true};
  }
  try {
    const r = await api("POST", "/api/" + kind, {...d, kind});
    STORE = r.custom; say("saved " + r.saved);
    // It is a saved record now, so the panel has nothing left to say: close the
    // editor area and put the menu on that kind's own tab, where the thing just
    // saved is a card (or a row). The draft goes back to blank with it - leaving
    // it would grow a **Resume** button for something already saved.
    state.emode = null; state.dts = null;
    state.drafts[mode] = BLANK[mode]();
    state.ptab = mode; state.picker = true;
  } catch (e){ say(e.message, true); }
  render();
}

async function previewItem(kind, d){
  try {
    const r = await api("POST", "/api/preview", {...d, kind});
    state.dts = r.dts || "(nothing to generate - this is just a plain key)";
    say(null);
  } catch (e){ state.dts = null; say(e.message, true); }
  render();
}

async function deleteItem(mode, kind, d){
  if (!d.name) return;
  if (!confirm(`Delete ${kind} "${d.name}"?`)) return;
  try {
    const r = await api("DELETE", `/api/${kind}/${encodeURIComponent(d.name)}`);
    STORE = r.custom; state.drafts[mode] = BLANK[mode](); say("deleted");
  } catch (e){ say(e.message, true); }
  render();
}

$("#filter").oninput = sidebar;
state.id = (DATA.keymaps[0] || {}).id || null;
sidebar(); render();
