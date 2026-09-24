// Every call that writes to `custom/` or `variants/`, and the preview round
// trip. The server's reply carries the whole `custom/` store back on every
// write, which is why so many of these end in one `store` dispatch.

import type { Dispatch } from "react";

import { ask } from "../components/Confirm";
import { api } from "../lib/api";
import { readTextFile, saveFile } from "../lib/download";
import { BOARD_TABS, KIND_OF, PANEL_TITLES, recordOf, type Mode } from "../lib/drafts";
import { scopeOf, scopeOn, slugify, byId } from "../lib/keymaps";
import type { Action, State } from "./store";

type D = Dispatch<Action>;
const bad = (e: unknown) => ({ text: (e as Error).message, bad: true });

// A brand-new board-wide record is switched on for the keymap it was designed
// against and nowhere else - that is the "off unless you say so" rule, minus
// the pointless step of switching on the one you are obviously making it for.
// An existing record's scopes are left exactly as they are.
export async function saveItem(s: State, d: D, mode: Mode, draft: any) {
  const kind = KIND_OF[mode];
  let body = { ...draft, kind };
  if (BOARD_TABS.includes(mode) && !recordOf(s.store, mode, draft.name)) {
    const scope = scopeOf(byId(s.data.keymaps, s.id));
    if (scope) body = { ...body, scopes: { ...(draft.scopes || {}), [scope]: true } };
  }
  try {
    const r = await api("POST", "/api/" + kind, body);
    d({ t: "leavePanel", mode, store: r.custom, msg: { text: "saved " + r.saved } });
  } catch (e) { d({ t: "msg", msg: bad(e) }); }
}

export async function previewItem(d: D, mode: Mode, draft: any) {
  try {
    const r = await api("POST", "/api/preview", { ...draft, kind: KIND_OF[mode] });
    d({ t: "dts", dts: r.dts || "(nothing to generate - this is just a plain key)" });
    d({ t: "msg", msg: null });
  } catch (e) { d({ t: "dts", dts: null }); d({ t: "msg", msg: bad(e) }); }
}

export async function deleteItem(d: D, mode: Mode, draft: any) {
  const kind = KIND_OF[mode];
  if (!draft.name) return;
  if (!await ask({ title: `Delete ${PANEL_TITLES[mode]} "${draft.name}"?`,
                   body: "Its record is removed from custom/.",
                   ok: "Delete", danger: true })) return;
  try {
    const r = await api("DELETE", `/api/${kind}/${encodeURIComponent(draft.name)}`);
    d({ t: "leavePanel", mode, store: r.custom,
        msg: { text: "deleted " + draft.name } });
  } catch (e) { d({ t: "msg", msg: bad(e) }); }
}

// The board-wide switch. `scopes` lives in the record, so flipping it is an
// ordinary save - and the response carries the whole store back, as always.
export async function toggleScope(s: State, d: D, mode: Mode, name: string) {
  const rec = recordOf(s.store, mode, name);
  const scope = scopeOf(byId(s.data.keymaps, s.id));
  if (!rec) return;
  if (!scope) return d({ t: "msg", msg: { text: "pick a keyboard first", bad: true } });
  const kind = KIND_OF[mode], now = !scopeOn(rec, scope);
  try {
    const r = await api("POST", "/api/" + kind,
                        { ...rec, kind, scopes: { ...(rec.scopes || {}), [scope]: now } });
    d({ t: "store", store: r.custom });
    d({ t: "msg", msg: { text: `${rec.name} is now ${now ? "on" : "off"} for ${scope}` } });
  } catch (e) { d({ t: "msg", msg: bad(e) }); }
}

// A card on the VileDance, Modifiers or Layers tab is not a finished binding
// until the server says what label it will be emitted under, so picking one is
// a round trip. Null means the call failed and the message is already out.
export async function previewBinding(d: D, kind: string, rec: any): Promise<string | null> {
  try {
    const r = await api("POST", "/api/preview", { ...rec, kind });
    return r.binding || "";
  } catch (e) { d({ t: "msg", msg: bad(e) }); return null; }
}

// `over` is the variant's own name when saving in place, and undefined when
// saving as a new one. `scope` is the keymap the board-wide switches were
// flipped under: the server carries those flags across to the variant it writes,
// so combos switched on while composing land in the file (see ui-server.md).
// `reset` adds a `settings_reset` entry per board to the build.yaml. See the
// "include reset" box in the variant bar, and `_reset_body()` in custom.py.
// `parts` is `{part_id: bool}` for the add-on shields; the build.yaml keeps the
// ticked ones (`build_yaml_for(parts=)`).
export async function saveVariant(
  s: State, d: D, km: any, over: string | null, typed: string, reset: boolean,
  parts: Record<string, boolean>,
): Promise<boolean> {
  const name = over || typed.trim();
  if (!name) {
    d({ t: "msg", msg: { text: "give the variant a name", bad: true } });
    return false;
  }
  if (!over
      && s.data.keymaps.some((k: any) => k.kind === "variant" && k.name === slugify(name))
      && !await ask({ title: `variants/${slugify(name)}/ already exists`,
                      body: "Overwrite its keymap and build.yaml?",
                      ok: "Overwrite", danger: true }))
    return false;
  try {
    const r = await api("POST", "/api/variant",
                        { name, base: km.id, assignments: s.assign,
                          scope: scopeOf(km), reset: !!reset, parts,
                          new_layers: s.newLayers[km.id] || [] });
    // Pull the fresh keymap list so the new file shows up in "Saved variations"
    // without a page reload, and jump straight to it - matching by filename
    // since `r.wrote` is project-relative while a keymap's `id` carries the
    // full discovered path (see discover() in the Python half).
    const fresh = await api("GET", "/api/state");
    const fn = r.wrote.split("/").pop();
    const created = fresh.keymaps.find(
      (k: any) => k.kind === "variant" && k.path.split("/").pop() === fn);
    // A variant is a folder: the keymap, and the build.yaml that builds it.
    d({ t: "savedVariant", data: fresh, store: fresh.custom || r.custom || s.store,
        id: created ? created.id : null, kmId: km.id,
        msg: { text: `wrote ${r.folder || r.wrote}`
                 + (r.build ? " (keymap + build.yaml)" : "")
                 + (r.warnings && r.warnings.length ? " - " + r.warnings.join("; ") : "") } });
    return true;
  } catch (e) { d({ t: "msg", msg: bad(e) }); return false; }
}

// Deleting is ours to offer only because `variants/` is ours to write: the
// server's `delete_variant()` builds the path itself, so nothing outside that
// directory is reachable from here. It removes the two files a variant is made
// of and the folder only if that empties it, so anything else you put in there
// survives. The keymap list is pulled fresh afterwards and the selection moves
// to whatever is left.
export async function deleteVariant(s: State, d: D, km: any) {
  if (km.kind !== "variant") return;
  if (!await ask({ title: `Delete variants/${km.name}/?`,
                   body: "Its keymap and build.yaml are deleted. This cannot be undone.",
                   ok: "Delete", danger: true })) return;
  try {
    const r = await api("DELETE", `/api/variant/${encodeURIComponent(km.name)}`);
    const fresh = await api("GET", "/api/state");
    d({ t: "deletedVariant", data: fresh,
        store: fresh.custom || r.custom || s.store, kmId: km.id,
        msg: { text: `deleted variants/${km.name}/` } });
  } catch (e) { d({ t: "msg", msg: bad(e) }); }
}

// ------------------------------------------------------------ share and import

export async function exportVariant(d: D, km: any) {
  try {
    const r = await api("GET", `/api/export/${encodeURIComponent(km.name)}`);
    const ok = await saveFile(r.filename,
      new Blob([r.text], { type: "text/plain;charset=utf-8" }),
      [{ description: "ZMK keymap", accept: { "text/plain": [".keymap"] } }]);
    if (ok) d({ t: "msg", msg: { text: `exported ${r.filename}` } });
  } catch (e) { d({ t: "msg", msg: bad(e) }); }
}

export async function openImport(d: D, file: File) {
  try {
    const text = await readTextFile(file);
    const r = await api("POST", "/api/import/inspect",
                        { text, filename: file.name });
    d({ t: "imp", imp: {
      filename: file.name, text,
      board: r.board, known: !!r.known, module: r.module || null,
      name: r.name, taken: !!r.taken,
      records: r.records || [],
      choices: {}, renames: {}, busy: false, error: null, result: null,
    } });
  } catch (e) { d({ t: "msg", msg: bad(e) }); }
}

export async function runImport(s: State, d: D) {
  const imp = s.imp;
  if (!imp) return;
  d({ t: "impPatch", patch: { busy: true, error: null } });
  try {
    const r = await api("POST", "/api/import", {
      name: imp.name, text: imp.text, filename: imp.filename,
      choices: imp.choices, renames: imp.renames,
    });
    const fresh = await api("GET", "/api/state");
    const fn = r.wrote.split("/").pop();
    const created = fresh.keymaps.find(
      (k: any) => k.kind === "variant" && k.path.split("/").pop() === fn);
    d({ t: "impPatch", patch: { busy: false, result: r } });
    d({ t: "imported", data: fresh, store: fresh.custom || r.custom || s.store,
        id: created ? created.id : null,
        msg: { text: `imported into ${r.folder || r.wrote}` } });
  } catch (e) {
    d({ t: "impPatch", patch: { busy: false, error: (e as Error).message } });
  }
}
