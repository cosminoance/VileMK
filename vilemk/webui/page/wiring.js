// The input the picker writes into: whichever binding field was focused last.
let activeField = null;

function markPicker(){
  const p = $("#kb-picker");
  if (!p) return;
  const v = ((activeField && activeField.value) || "").trim();
  const t = $("#kb-target"), slot = activeField && activeField.closest(".slot");
  // With the key editor open a pick is not a fill, it is the assignment - say so,
  // or the row promises an Apply step that no longer happens (see `pickBinding()`).
  if (t) t.textContent =
      state.editing !== null && activeField && activeField.id === "kb-val"
        ? `\u2192 assigns key ${state.editing}`
        : slot ? "\u2192 fills " + slot.querySelector("span").textContent
       : "\u2192 nothing to fill: click a key on the board, or open a panel above";
  p.querySelectorAll(".pk[data-bind]").forEach(el =>
      el.classList.toggle("sel", el.dataset.bind === v));
  p.querySelectorAll(".pk[data-vd]").forEach(el =>
      el.classList.toggle("sel", usesVd(v, el.dataset.vd)));
  p.querySelectorAll(".pk[data-mod]").forEach(el => {
    const rec = (STORE.modifier || []).find(x => x.name === el.dataset.mod);
    el.classList.toggle("sel", !!rec && modBinding(rec) === v);
  });
  p.querySelectorAll(".pk[data-lt]").forEach(el => {
    const code = ltCode(v);
    el.classList.toggle("sel", v === `&lt ${el.dataset.lt}${code ? " " + code : ""}`);
  });
  p.querySelectorAll(".pk[data-lay]").forEach(el => {
    const rec = (STORE.layer || []).find(x => x.name === el.dataset.lay);
    el.classList.toggle("sel", !!rec && usesLayer(v, rec));
  });
}

function setField(v){
  if (!activeField){ say("click the field to fill in first", true); return render(); }
  activeField.value = v;
  activeField.dispatchEvent(new Event("input", {bubbles:true}));
  activeField.focus();
  markPicker();
}

// The pending edit for one key. Apply calls this and so does `pickBinding()`,
// so the typed path and the picked one cannot drift apart.
function assignKey(pos, v){
  const b = (v || "").trim();
  const a = state.assign[state.layer] = state.assign[state.layer] || {};
  if (!b) delete a[pos]; else a[pos] = b;
  if (!Object.keys(a).length) delete state.assign[state.layer];
}

// Where a menu pick goes. With the key editor open the pick is already the
// whole answer - clicking A on the Keyboard tab cannot mean anything but
// `&kp A` - so it is assigned and the editor closes; there is nothing Apply
// would have added. Anywhere else it fills the focused field of a panel that
// still has its own Save. Not used by the layer-tap buttons: those compose
// with what is in the field, so they are not finished bindings.
function pickBinding(v){
  if (state.editing === null || !activeField || activeField.id !== "kb-val")
    return setField(v);
  const pos = state.editing;
  assignKey(pos, v);
  state.editing = null;
  say(`key ${pos} \u2192 ${label(v)}`);
  render();
}

// `fields` are the binding inputs this menu may write into - whatever the editor
// area has open, or none at all. The first one is the default target so a
// single-field editor needs no click to get going.
function wireMenu(fields){
  const wrap = $("#kb-picker");
  if (!wrap) return;
  activeField = fields[0] || null;
  fields.forEach(el => {
    el.addEventListener("focus", () => { activeField = el; markPicker(); });
    el.addEventListener("input", markPicker);
  });
  const wireKeys = () => {
    wrap.querySelectorAll(".pk[data-bind]").forEach(el =>
        el.onclick = () => pickBinding(el.dataset.bind));
    wrap.querySelectorAll(".pk[data-vd]").forEach(el => el.onclick = async () => {
      const t = STORE.viledance.find(x => x.name === el.dataset.vd);
      if (!t) return;
      try {
        const r = await api("POST", "/api/preview", {...t, kind:"viledance"});
        pickBinding(r.binding || "");
      } catch (err){ say(err.message, true); render(); }
    });
    wrap.querySelectorAll(".pk[data-mod]").forEach(el => el.onclick = async () => {
      const m = (STORE.modifier || []).find(x => x.name === el.dataset.mod);
      if (!m) return;
      try {
        const r = await api("POST", "/api/preview", {...m, kind:"modifier"});
        pickBinding(r.binding || "");
      } catch (err){ say(err.message, true); render(); }
    });
    wrap.querySelectorAll(".pk[data-lt]").forEach(el => el.onclick = () => {
      const code = ltCode(activeField && activeField.value);
      setField(`&lt ${el.dataset.lt}${code ? " " + code : ""}`);
      // The hint line and every other layer-tap button quote that keycode.
      wrap.innerHTML = pickerBody(((activeField && activeField.value) || "").trim());
      wireKeys();
    });
    wrap.querySelectorAll(".pk[data-lay]").forEach(el => el.onclick = async () => {
      const l = (STORE.layer || []).find(x => x.name === el.dataset.lay);
      if (!l) return;
      try {
        const r = await api("POST", "/api/preview", {...l, kind:"layer"});
        pickBinding(r.binding || "");
      } catch (err){ say(err.message, true); render(); }
    });
    // `+ New \u2026` and a card's \u270e both open the real creation panel in the
    // editor area above - which closes the key editor, since only one of the two
    // can be up there at a time. The draft is per-kind, so nothing else is lost.
    wrap.querySelectorAll("[data-new]").forEach(el => el.onclick = () => {
      const m = el.dataset.new;
      state.emode = m; state.drafts[m] = BLANK[m]();
      state.editing = null; state.dts = null; say(null); render();
    });
    // Same slot, the draft that is already there - see `newRow()`.
    wrap.querySelectorAll("[data-open]").forEach(el => el.onclick = () => {
      state.emode = el.dataset.open;
      state.editing = null; state.dts = null; say(null); render();
    });
    wrap.querySelectorAll("[data-edit]").forEach(el => el.onclick = () => {
      const m = el.dataset.edit, rec = recordOf(m, el.dataset.name);
      if (!rec) return;
      state.emode = m; state.drafts[m] = JSON.parse(JSON.stringify(rec));
      state.editing = null; state.dts = null; say(null); render();
    });
    // The board-wide switch. `scopes` lives in the record, so flipping it is an
    // ordinary save - and the response carries the whole store back, as always.
    wrap.querySelectorAll("[data-tgl]").forEach(el => el.onclick = async () => {
      const m = el.dataset.tgl, rec = recordOf(m, el.dataset.name);
      const scope = scopeOf(byId(state.id));
      if (!rec) return;
      if (!scope){ say("pick a keyboard first", true); return render(); }
      const kind = KIND_OF[m], now = !scopeOn(rec, scope);
      try {
        const r = await api("POST", "/api/" + kind,
                            {...rec, kind, scopes: {...(rec.scopes||{}), [scope]: now}});
        STORE = r.custom;
        say(`${rec.name} is now ${now ? "on" : "off"} for ${scope}`);
      } catch (err){ say(err.message, true); }
      render();
    });
    markPicker();
  };
  wireKeys();
  $("#kb-toggle").onclick = e => {
    state.picker = !state.picker;
    wrap.classList.toggle("hidden", !state.picker);
    e.target.textContent = state.picker ? "Hide" : "Show";
  };
  document.querySelectorAll("[data-ptab]").forEach(b => b.onclick = () => {
    state.ptab = b.dataset.ptab;
    document.querySelectorAll("[data-ptab]").forEach(o =>
        o.classList.toggle("sel", o.dataset.ptab === state.ptab));
    wrap.innerHTML = pickerBody(((activeField && activeField.value) || "").trim());
    wireKeys();
  });
}

function keyEditor(km, layer){
  const pos = state.editing;
  if (pos === null || pos === undefined) return "";
  const orig = layer ? layer.bindings[pos] : "";
  const cur = (state.assign[state.layer] || {})[pos] ?? orig;
  return `<div class="panel" id="keyed" style="margin:0 0 16px">`
    + `<h3>Key ${pos} &middot; layer ${state.layer} &middot; now <code>${esc(orig||"")}</code></h3>`
    + `<div class="slot"><span>Binding</span>`
    + `<input class="kb wide" id="kb-val" value="${esc(cur||"")}" autocomplete="off"></div>`
    + `<div class="rowbtns"><button class="act" id="kb-ok">Apply</button>`
    + `<button class="ghost" id="kb-reset">Reset to ${esc(label(orig||""))}</button>`
    + `<button class="ghost" id="kb-cancel">Cancel</button></div>`
    + `<div class="hint">Pick from the menu below - a key, a saved VileDance, a`
    + ` macro, a modifier or a layer - and it is assigned straight away, no Apply.`
    + ` Or type any ZMK binding here - <code>&amp;kp A</code>,`
    + ` <code>&amp;mo 2</code>, <code>&amp;none</code> - and press Apply or Enter.`
    + ` Either way nothing touches disk until you save a variant.</div></div>`;
}

function wireKeyEditor(km){
  const val = $("#kb-val");
  if (!val) return;
  val.focus();
  val.onkeydown = e => { if (e.key === "Enter") $("#kb-ok").click();
                         if (e.key === "Escape") $("#kb-cancel").click(); };
  $("#kb-ok").onclick = () => {
    assignKey(state.editing, val.value);
    state.editing = null; say(null); render();
  };
  $("#kb-reset").onclick = () => {
    delete (state.assign[state.layer] || {})[state.editing];
    if (state.assign[state.layer] && !Object.keys(state.assign[state.layer]).length)
      delete state.assign[state.layer];
    state.editing = null; render();
  };
  $("#kb-cancel").onclick = () => { state.editing = null; render(); };
}

