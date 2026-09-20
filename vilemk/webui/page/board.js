function sidebar(){
  const q = ($("#filter").value || "").toLowerCase();
  let html = "";
  for (const kind of ["config","variant","vendor"]){
    const rows = DATA.keymaps.filter(k => k.kind === kind &&
      (k.name.toLowerCase().includes(q) || k.path.toLowerCase().includes(q)));
    if (!rows.length) continue;
    html += `<div class="group">${KINDS[kind]}</div>`;
    for (const k of rows)
      html += `<button data-id="${esc(k.id)}" class="${k.id===state.id?"sel":""}">`
            + `${esc(k.name)}<small>${esc(k.path)}</small></button>`;
  }
  $("#list").innerHTML = html || `<div class="group">no matches</div>`;
  $("#list").querySelectorAll("button").forEach(b => b.onclick = () => {
    state.id = b.dataset.id; state.layer = 0; state.layout = 0; state.hot = null;
    sidebar(); render();
  });
}

function board(km, lay, bindings, baseBindings){
  const s = 0.50, pad = 6;
  const xs = lay.keys.map(k => k[2]), ys = lay.keys.map(k => k[3]);
  const w = Math.max(...lay.keys.map(k => k[2]+k[0])) - Math.min(...xs);
  const h = Math.max(...lay.keys.map(k => k[3]+k[1])) - Math.min(...ys);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  let html = `<div class="board" style="width:${w*s+pad}px;height:${h*s+pad}px">`;
  lay.keys.forEach((k, i) => {
    const [kw,kh,kx,ky,rot,rx,ry] = k;
    let b = bindings[i];
    const pend = (state.assign[state.layer] || {})[i];
    if (pend !== undefined) b = pend;
    const old = baseBindings ? baseBindings[i] : undefined;
    const cls = ["k"];
    if (b === undefined) cls.push("empty");
    if (old !== undefined && old !== b) cls.push("diff");
    if (state.hot && state.hot.includes(i)) cls.push("hot");
    if (state.emode === "combo" && state.sel.includes(i)) cls.push("pick");
    const pending = (state.assign[state.layer] || {})[i];
    if (pending !== undefined) cls.push("asg");
    if (LIVE) cls.push("clickable");
    if (state.emode !== "combo" && state.editing === i) cls.push("hot");
    let st = `left:${(kx-x0)*s}px;top:${(ky-y0)*s}px;`
           + `width:${kw*s-2}px;height:${kh*s-2}px;`;
    if (rot) st += `transform:rotate(${rot/100}deg);`
                 + `transform-origin:${(rx-kx)*s}px ${(ry-ky)*s}px;`;
    const res = b !== undefined ? resolveBinding(km, b, 3) : null;
    if (res && res.hint) cls.push("compound");
    const oldRes = old !== undefined ? resolveBinding(km, old, 3) : null;
    const tip = res
      ? (res.full !== b ? `${res.full}\n\n${b}  @ ${i}` : `${b}  @ ${i}`)
      : `@ ${i}`;
    html += `<div class="${cls.join(" ")}" style="${st}" data-pos="${i}"`
          + ` title="${esc(tip)}">`
          + (state.nums ? `<span class="pos">${i}</span>` : "")
          + (res && res.hint ? `<span class="hint">${esc(res.hint)}</span>` : "")
          + (res && res.shift && res.shift !== res.short
              ? `<span class="shift">${esc(res.shift)}</span>` : "")
          + `<span class="lbl">${esc(res ? res.short : "")}</span>`
          + (cls.includes("diff") ? `<span class="was">was ${esc(oldRes ? oldRes.short : "")}</span>` : "")
          + `</div>`;
  });
  return html + "</div>";
}

// One view, one render. The header carries no nav any more: the board, the
// editor area and the menu are all on this page at once.
function render(){
  $("#mode").textContent = LIVE ? "live \u00b7 saving to custom/" : "read-only";
  renderKeymap();
}

function renderKeymap(){
  const km = byId(state.id);
  if (!km){ $("#main").innerHTML = "<p>Pick a keyboard on the left.</p>"; return; }
  const lay = km.layouts[Math.min(state.layout, km.layouts.length-1)];
  const allLayers = layersOf(km);
  // Clamp `state.layer` itself, not just the lookup: `board()` and every key
  // click key `state.assign` by it, so a stale index (a pending layer that a
  // save has just written and cleared) would file edits against a layer the
  // base keymap does not have.
  state.layer = Math.min(state.layer, Math.max(allLayers.length-1, 0));
  const layer = allLayers[state.layer];
  // `.pick` on the board mirrors the combo draft's positions - do it before
  // board() is built, not after.
  state.sel = state.emode === "combo"
      ? (draftOf("combo").key_positions || []).map(Number) : [];
  const base = state.base ? byId(state.base) : null;
  const baseLayer = base && base.layers[state.layer];
  const baseBindings = baseLayer && baseLayer.bindings.length === (layer?layer.bindings.length:0)
      ? baseLayer.bindings : null;

  let h = `<div class="bar"><h2>${esc(km.name)}</h2>`
        + `<span class="path">${esc(km.path)}</span></div><div class="bar">`;
  if (km.layouts.length > 1){
    h += `<select id="layout">` + km.layouts.map((l,i) =>
      `<option value="${i}" ${i===state.layout?"selected":""}>`
      + `${esc(l.display || l.label)} &middot; ${l.count} keys</option>`).join("") + `</select>`;
  } else {
    h += `<span class="path">${esc(lay.display || lay.label)} &middot; ${lay.count} keys</span>`;
  }
  h += `<select id="base"><option value="">compare with&hellip; (off)</option>`
     + DATA.keymaps.filter(k => k.id !== km.id).map(k =>
        `<option value="${esc(k.id)}" ${k.id===state.base?"selected":""}>`
        + `${esc(k.kind)}: ${esc(k.path)}</option>`).join("") + `</select>`;
  h += `<label class="toggle"><input type="checkbox" id="nums" ${state.nums?"checked":""}>`
     + ` key positions</label></div>`;
  if (LIVE){
    const n = Object.values(state.assign).reduce((a,o) => a + Object.keys(o).length, 0);
    const nl = (state.newLayers[km.id] || []).length;
    const dirty = n || nl;
    // Only `variants/` is ours to write. A config or vendor keymap can be saved
    // *from*, never over - so "Save here" exists for a variant and nothing else.
    const own = km.kind === "variant";
    h += `<div class="bar">`
       + `<span class="path">click a key to assign a VileDance or any binding</span>`
       + (dirty ? `<span class="path">${n} pending change(s)`
            + (nl ? `, ${nl} new layer(s)` : "") + `</span>` : "")
       + (own ? `<button class="act" id="savehere">Save to ${esc(km.name)}</button>` : "")
       + `<span class="path">save as</span>`
       + `<input class="kb wide" id="vname" placeholder="letters, digits, underscores"`
       + ` value="${esc(slugify(km.name) + (own ? "_2" : "_custom"))}">`
       + `<button class="${own ? "ghost" : "act"}" id="savevar">Save as new variant</button>`
       + (dirty ? `<button class="ghost" id="clearvar">Discard</button>` : "")
       + (own ? `<button class="ghost danger" id="delvar">Delete variant</button>` : "")
       + `</div>` + msgHtml();
  }

  for (const w of km.warnings) h += `<div class="warn">${esc(w)}</div>`;
  if (state.base && !baseBindings)
    h += `<div class="warn">comparison off for this layer: the two keymaps`
       + ` disagree on layer count or key count</div>`;

  h += `<div class="tabs">` + allLayers.map((l,i) =>
      `<button data-layer="${i}" class="${i===state.layer?"sel":""}"`
      + `${l.pending ? ` title="not saved yet - Save as variant to write it"` : ""}>`
      + `${i}&nbsp;&middot;&nbsp;${esc(l.display)}${l.pending ? " *" : ""}</button>`).join("")
    + (LIVE && allLayers.length < 32
        ? `<button class="ghost sm" id="addlayer">+ layer</button>` : "")
    + `</div>`;

  if (!layer || layer.reserved){
    h += `<p class="legend">This layer is <code>status = "reserved"</code>: empty here,`
       + ` available to fill in from ZMK Studio.</p>`;
  } else {
    if (lay.approximate)
      h += `<div class="legend">No <code>zmk,physical-layout</code> for this keyboard;`
         + ` keys are drawn on a plain grid, but the numbers are still the real`
         + ` key positions.</div>`;
    h += board(km, lay, layer.bindings, baseBindings);
  }
  // The editor area holds one of three things: a key's editor, a creation panel,
  // or nothing. The menu below it is always there in LIVE mode - the board-wide
  // tabs have nothing to do with whichever of the three is open.
  if (LIVE) h += editorHtml(km, layer) + menuHtml(km, layer);

  h += `<div class="cols">`;
  if (km.combos.length){
    h += `<section class="card"><h3>Combos</h3><table><tr><th>name</th><th>keys</th>`
       + `<th>sends</th><th>ms</th><th>layers</th></tr>`
       + km.combos.map((c,i) => `<tr class="combo" data-combo="${i}">`
          + `<td>${esc(c.name)}</td><td class="mono">${c.positions.join(" ")}</td>`
          + `<td class="mono">${esc(c.bindings)}</td><td>${c.timeout ?? ""}</td>`
          + `<td>${c.layers.length ? c.layers.join(" ") : "all"}</td></tr>`).join("")
       + `</table></section>`;
  }
  if (km.behaviors.length){
    h += `<section class="card"><h3>Behaviors</h3><table><tr><th>&amp;label</th>`
       + `<th>type</th><th>sends</th></tr>`
       + km.behaviors.map(b => {
          const use = usageOf(km, b.label);
          const res = use ? resolveBinding(km, use.binding, 3) : null;
          // With a key to read the parameters off, show what it sends; without
          // one, the node's own `bindings` is all there is to show, and it is
          // worth saying why that reads as `&kp, &kp`.
          const sends = res
            ? esc(res.full).replace(/\n/g, "<br>")
            : esc(b.bindings.join(", "));
          // A hold-tap or a mod-morph declares `bindings = <&kp>, <&kp>;` and
          // takes its keys from the key - so when no key uses it there is
          // genuinely nothing more to show, and that is worth saying. Every
          // other kind carries its own complete bindings.
          const note = use
            ? `${esc(use.binding)} &middot; key ${use.pos}, layer ${use.layer}`
            : b.kind === "hold-tap" || b.kind === "mod-morph"
              ? `on no key here &ndash; its keys come from the key it is put on`
              : b.kind === "sensor-rotate" ? `on an encoder, not a key`
              : `on no key here`;
          return `<tr${use ? ` class="usedby" data-behpos="${use.pos}"`
                             + ` data-behlayer="${use.layer}"` : ""}>`
            + `<td class="mono">&amp;${esc(b.label)}</td>`
            + `<td>${esc(b.kind)}</td><td class="mono">${sends}`
            + `<br><span style="color:var(--muted)">${note}</span>`
            + (Object.keys(b.props).length ? `<br><span style="color:var(--muted)">`
               + esc(Object.entries(b.props).map(([k,v]) => k+"="+v).join("  ")) + `</span>` : "")
            + `</td></tr>`;
         }).join("") + `</table></section>`;
  }
  if (km.macros.length){
    h += `<section class="card"><h3>Macros</h3><table><tr><th>&amp;label</th>`
       + `<th>type</th><th>bindings</th></tr>`
       + km.macros.map(b => `<tr><td class="mono">&amp;${esc(b.label)}</td>`
          + `<td>${esc(b.kind)}</td><td class="mono">${esc(b.bindings.join(" "))}</td></tr>`
         ).join("") + `</table></section>`;
  }
  h += `</div>`;
  $("#main").innerHTML = h;

  $("#main").querySelectorAll("[data-layer]").forEach(b => b.onclick = () => {
    state.layer = +b.dataset.layer; render();
  });
  const ls = $("#layout"); if (ls) ls.onchange = e => { state.layout = +e.target.value; render(); };
  $("#base").onchange = e => { state.base = e.target.value; render(); };
  $("#nums").onchange = e => { state.nums = e.target.checked; render(); };
  $("#main").querySelectorAll("[data-combo]").forEach(tr => {
    tr.onmouseenter = () => { state.hot = km.combos[+tr.dataset.combo].positions; render(); };
    tr.onmouseleave = () => { state.hot = null; render(); };
  });
  // Same highlight for a behavior row: hovering it points at the key whose
  // parameters the "sends" column was read from - but only while that key's own
  // layer is the one on screen.
  $("#main").querySelectorAll("[data-behpos]").forEach(tr => {
    tr.onmouseenter = () => {
      if (+tr.dataset.behlayer !== state.layer) return;
      state.hot = [+tr.dataset.behpos]; render();
    };
    tr.onmouseleave = () => { state.hot = null; render(); };
  });
  if (LIVE){
    $("#main").querySelectorAll(".board [data-pos]").forEach(el => {
      el.onclick = () => {
        const pos = +el.dataset.pos;
        // While a combo is being drafted the board *is* the chord picker; every
        // other time, clicking a key opens that key's editor.
        if (state.emode === "combo"){
          const d = draftOf("combo");
          const list = new Set((d.key_positions || []).map(Number));
          list.has(pos) ? list.delete(pos) : list.add(pos);
          d.key_positions = [...list].sort((a,b) => a-b);
        } else {
          state.emode = null; state.editing = pos; state.dts = null; say(null);
          // The menu follows the key: whatever this one holds, open the tab that
          // holds it back. A pending edit wins over the file, same as the editor
          // itself reads it.
          const cur = (state.assign[state.layer] || {})[pos]
                   ?? (layer ? layer.bindings[pos] : "");
          state.ptab = tabForBinding(cur);
        }
        render();
      };
    });
    wireEditor(km, layer);
    const sv = $("#savevar"); if (sv) sv.onclick = () => saveVariant(km);
    const sh = $("#savehere"); if (sh) sh.onclick = () => saveVariant(km, km.name);
    const dv = $("#delvar"); if (dv) dv.onclick = () => deleteVariant(km);
    const cv = $("#clearvar");
    if (cv) cv.onclick = () => {
      state.assign = {}; state.newLayers[km.id] = []; say(null); render();
    };
    const al = $("#addlayer");
    if (al) al.onclick = () => {
      const n = allLayers.length;
      const name = (prompt("Layer name", `layer_${n}`) || "").trim();
      if (!name) return;
      (state.newLayers[km.id] = state.newLayers[km.id] || []).push({name});
      state.layer = n;
      render();
    };
    // a mod-chain click re-renders the whole page, so put the caret back
    if (state.refocus){
      const el = $(`[data-f="${state.refocus}"]`);
      state.refocus = null;
      if (el) el.focus();
    }
  }
}

