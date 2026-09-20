// `over` is the variant's own name when saving in place, and undefined when
// saving as a new one. `scope` is the keymap the board-wide switches were
// flipped under: the server carries those flags across to the variant it writes,
// so combos switched on while composing land in the file (see ui-server.md).
// `reset` adds a `settings_reset` entry per board to the build.yaml. See the
// "include reset" box in the variant bar, and `_reset_body()` in custom.py.
async function saveVariant(km, over, reset){
  const name = over || ($("#vname").value || "").trim();
  if (!name) return say("give the variant a name", true) || render();
  if (!over && DATA.keymaps.some(k => k.kind === "variant" && k.name === slugify(name))
      && !confirm(`variants/${slugify(name)}/ already exists. Overwrite it?`))
    return render();
  try {
    const r = await api("POST", "/api/variant",
                        {name, base: km.id, assignments: state.assign,
                         scope: scopeOf(km), reset: !!reset,
                         new_layers: state.newLayers[km.id] || []});
    if (r.custom) STORE = r.custom;
    state.assign = {};
    state.newLayers[km.id] = [];
    // Pull the fresh keymap list so the new file shows up in "Saved
    // variations" without a page reload, and jump straight to it - matching
    // by filename since `r.wrote` is project-relative while a keymap's `id`
    // carries the full discovered path (see discover() in the Python half).
    const fresh = await api("GET", "/api/state");
    DATA.keymaps = fresh.keymaps;
    DATA.generated = fresh.generated;
    STORE = fresh.custom || STORE;
    const fn = r.wrote.split("/").pop();
    const created = DATA.keymaps.find(k => k.kind === "variant" && k.path.split("/").pop() === fn);
    if (created){ state.id = created.id; state.layer = 0; }
    // A variant is a folder: the keymap, and the build.yaml that builds it.
    say(`wrote ${r.folder || r.wrote}`
        + (r.build ? " (keymap + build.yaml)" : "")
        + (r.warnings && r.warnings.length ? " - " + r.warnings.join("; ") : ""));
  } catch (e){ say(e.message, true); }
  sidebar(); render();
}

// Deleting is ours to offer only because `variants/` is ours to write: the
// server's `delete_variant()` builds the path itself, so nothing outside that
// directory is reachable from here. It removes the two files a variant is made
// of and the folder only if that empties it, so anything else you put in there
// survives. The keymap list is pulled fresh afterwards and the selection moves
// to whatever is left.
async function deleteVariant(km){
  if (km.kind !== "variant") return;
  if (!confirm(`Delete variants/${km.name}/ - keymap and build.yaml? `
               + `This cannot be undone.`)) return;
  try {
    const r = await api("DELETE", `/api/variant/${encodeURIComponent(km.name)}`);
    if (r.custom) STORE = r.custom;
    const fresh = await api("GET", "/api/state");
    DATA.keymaps = fresh.keymaps; DATA.generated = fresh.generated;
    STORE = fresh.custom || STORE;
    state.assign = {}; delete state.newLayers[km.id];
    state.id = (DATA.keymaps[0] || {}).id || null;
    state.layer = 0; state.layout = 0;
    say(`deleted variants/${km.name}/`);
  } catch (e){ say(e.message, true); }
  sidebar(); render();
}

