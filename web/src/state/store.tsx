import {
  createContext, useContext, useEffect, useReducer,
  type Dispatch, type ReactNode,
} from "react";

import { BLANK, isUnsaved, type Mode } from "../lib/drafts";
import type { Importing } from "../lib/transfer";

// ---------------------------------------------------------------- the state
//
// There is one screen. `editing` (a key position) and `emode` (a creation
// panel) are the two things that can occupy the editor area above the menu, and
// they are mutually exclusive - opening one closes the other. `ptab` is which
// of the menu tabs below it is showing, and it is independent of both.
// `reset` holds "include reset" per keymap id once it is clicked. Until then
// the box shows what the variant's build.yaml has, else whether the keymap
// binds `&studio_unlock` - the keymaps whose keyboards can end up ignoring the
// compiled keymap at the positions Studio wrote.
//
// `parts` holds the add-on shields ticked in the variant bar, per keymap id and
// part id. A part not in it falls back to `km.parts[].on`, which the server read
// from the build list that builds this keymap now.
//
// `prep` holds a prepared module's choices per keymap id, once clicked: the
// shield folder, the vendor entries ticked for it, and the vendor confs
// changed from their defaults. Picking a folder drops the entry clicks, since
// another folder offers other entries. Unclicked, `km.prep` has what the
// variant's build.yaml has.
//
// `activeField` names the input the menu fills - the field's key, not the
// element, so its value is read back out of the draft it belongs to. `null`
// means nothing has been clicked yet, which `activeFieldOf()` resolves to the
// first field the open editor has.
//
// `keyVal` is the key editor's live text. It is here rather than in the input
// because the picker highlights against it.
export interface Msg { text: string; bad?: boolean }

export interface Prep {
  folder?: string;
  entries?: Record<string, boolean>;
  confs?: Record<string, boolean>;
}

export interface State {
  /** The `/api/state` payload, `any` by decision (react-migration.md Phase 2). */
  data: any;
  /** `data.custom`, kept separate because every write returns a fresh one. */
  store: any;
  filter: string;
  /** Sidebar open. Collapsing it gives the board the whole width. */
  rail: boolean;

  id: string | null;
  layer: number;
  layout: number;
  base: string;
  nums: boolean;
  hot: number[] | null;

  emode: Mode | null;
  drafts: Partial<Record<Mode, any>>;
  assign: Record<number, Record<number, string>>;
  msg: Msg | null;
  dts: string | null;
  editing: number | null;
  picker: boolean;
  ptab: string;
  newLayers: Record<string, { name: string }[]>;
  /** Layer indices marked for deletion, per keymap id, until the next save. */
  dropLayers: Record<string, number[]>;
  reset: Record<string, boolean>;
  parts: Record<string, Record<string, boolean>>;
  prep: Record<string, Prep>;
  /** The build panel under the variant bar is open. */
  build: boolean;

  activeField: string | null;
  keyVal: string;

  /** The import dialog, from the file being read to the checks on what it wrote. */
  imp: Importing | null;
}

// The keymap shown, the sidebar and the key-position toggle survive a reload.
// Per browser; storage can be missing or refuse, and then the defaults apply.
const VIEW = "vilemk.view";
type View = Partial<Pick<State, "id" | "rail" | "nums">>;
function readView(): View {
  try { return JSON.parse(localStorage.getItem(VIEW) || "{}") || {}; }
  catch { return {}; }
}

export const initialState = (data: any): State => {
  const v = readView();
  const known = data.keymaps.some((k: any) => k.id === v.id);
  return {
    data,
    store: data.custom || {viledance:[], combo:[], modifier:[], layer:[], macro:[]},
    filter: "",
    rail: v.rail ?? true,
    id: known ? v.id! : (data.keymaps[0] || {}).id || null,
    layer: 0, layout: 0, base: "", nums: v.nums ?? true, hot: null,
    emode: null, drafts: {}, assign: {}, msg: null, dts: null,
    editing: null, picker: true, ptab: "keyboard",
    newLayers: {}, dropLayers: {}, reset: {}, parts: {}, prep: {}, build: false,
    activeField: null, keyVal: "",
    imp: null,
  };
};

export const LIVE = (s: State): boolean => !!s.data.live;

/** New layers plus layers marked for deletion on keymap `id`. */
export const layerEdits = (s: State, id: string | null): number =>
  id ? (s.newLayers[id] || []).length + (s.dropLayers[id] || []).length : 0;

/** Edits that exist only in the page: assignments, new or deleted layers, and
 *  creation panel drafts that are neither blank nor a saved record as opened. */
export const unsaved = (s: State): boolean =>
  Object.keys(s.assign).length > 0
  || Object.keys({ ...s.newLayers, ...s.dropLayers }).some((id) => layerEdits(s, id) > 0)
  || (Object.keys(s.drafts) as Mode[]).some((m) => isUnsaved(s.store, m, s.drafts[m]));

// --------------------------------------------------------------- the actions
export type Action =
  | { t: "data"; data: any }
  | { t: "store"; store: any }
  | { t: "filter"; v: string }
  | { t: "rail"; on: boolean }
  | { t: "select"; id: string | null }
  | { t: "layer"; n: number }
  | { t: "layout"; n: number }
  | { t: "base"; id: string }
  | { t: "nums"; on: boolean }
  | { t: "hot"; keys: number[] | null }
  | { t: "msg"; msg: Msg | null }
  | { t: "dts"; dts: string | null }
  | { t: "picker"; on: boolean }
  | { t: "ptab"; tab: string }
  | { t: "reset"; kmId: string; on: boolean }
  | { t: "part"; kmId: string; id: string; on: boolean }
  | { t: "prepFolder"; kmId: string; folder: string }
  | { t: "prepEntry"; kmId: string; id: string; on: boolean }
  | { t: "prepConf"; kmId: string; id: string; on: boolean }
  | { t: "build"; on: boolean }
  | { t: "field"; key: string | null }
  | { t: "keyVal"; v: string }
  | { t: "editKey"; pos: number; ptab: string; cur: string }
  | { t: "closeKey" }
  | { t: "assign"; pos: number; v: string; close?: boolean; msg?: Msg | null }
  | { t: "swap"; from: number; to: number; file: (string | undefined)[] }
  | { t: "clearAssign"; kmId: string }
  | { t: "openPanel"; mode: Mode; draft?: any }
  | { t: "closePanel" }
  | { t: "draft"; mode: Mode; draft: any | ((prev: any) => any) }
  | { t: "leavePanel"; mode: Mode; store?: any; msg?: Msg | null }
  | { t: "addLayer"; kmId: string; name: string; at: number;
      assign?: Record<number, string> }
  | { t: "dropLayer"; kmId: string; n: number; on: boolean }
  | { t: "savedVariant"; data: any; store: any; id: string | null;
      kmId: string; msg: Msg | null }
  | { t: "deletedKeymap"; data: any; store: any; kmId: string; msg: Msg | null }
  | { t: "imp"; imp: Importing | null }
  | { t: "impPatch"; patch: Partial<Importing> }
  | { t: "imported"; data: any; store: any; id: string | null; msg: Msg | null };

export function reducer(s: State, a: Action): State {
  switch (a.t) {
    case "data": return { ...s, data: a.data };
    case "store": return { ...s, store: a.store };
    case "filter": return { ...s, filter: a.v };
    case "rail": return { ...s, rail: a.on };

    case "select":
      return { ...s, id: a.id, layer: 0, layout: 0, hot: null, msg: null };

    case "layer": return { ...s, layer: a.n, msg: null };
    case "layout": return { ...s, layout: a.n, msg: null };
    case "base": return { ...s, base: a.id, msg: null };
    case "nums": return { ...s, nums: a.on };
    case "hot": return { ...s, hot: a.keys };
    case "msg": return { ...s, msg: a.msg };
    case "dts": return { ...s, dts: a.dts };
    case "picker": return { ...s, picker: a.on };
    case "ptab": return { ...s, ptab: a.tab };
    case "reset": return { ...s, reset: { ...s.reset, [a.kmId]: a.on } };
    case "part":
      return { ...s, parts: { ...s.parts,
                              [a.kmId]: { ...s.parts[a.kmId], [a.id]: a.on } } };
    case "prepFolder":
      return { ...s, prep: { ...s.prep, [a.kmId]: { ...s.prep[a.kmId], folder: a.folder,
                                                    entries: {} } } };
    case "prepEntry": {
      const p = s.prep[a.kmId] || {};
      return { ...s, prep: { ...s.prep,
        [a.kmId]: { ...p, entries: { ...p.entries, [a.id]: a.on } } } };
    }
    case "prepConf": {
      const p = s.prep[a.kmId] || {};
      return { ...s, prep: { ...s.prep,
        [a.kmId]: { ...p, confs: { ...p.confs, [a.id]: a.on } } } };
    }
    case "build": return { ...s, build: a.on };
    case "field": return { ...s, activeField: a.key };
    case "keyVal": return { ...s, keyVal: a.v };

    // One editor area, one occupant. The menu follows the key: `ptab` is
    // whichever tab holds what the key binds.
    case "editKey":
      return { ...s, emode: null, editing: a.pos, dts: null, msg: null,
               ptab: a.ptab, keyVal: a.cur, activeField: null };

    case "closeKey":
      return { ...s, editing: null, activeField: null, keyVal: "" };

    case "assign": {
      const layer = { ...(s.assign[s.layer] || {}) };
      const v = (a.v || "").trim();
      if (!v) delete layer[a.pos]; else layer[a.pos] = v;
      const assign = { ...s.assign };
      if (Object.keys(layer).length) assign[s.layer] = layer;
      else delete assign[s.layer];
      return { ...s, assign,
               ...(a.close ? { editing: null, activeField: null, keyVal: "" } : {}),
               ...(a.msg !== undefined ? { msg: a.msg } : {}) };
    }

    // `file` is the layer's bindings as saved. A key that ends up holding its
    // saved binding again drops out of `assign`, so swapping back is no edit.
    case "swap": {
      const layer = { ...(s.assign[s.layer] || {}) };
      const now = (p: number) => layer[p] ?? a.file[p] ?? "&none";
      const put = (p: number, v: string) => {
        if (v === (a.file[p] ?? "&none")) delete layer[p]; else layer[p] = v;
      };
      const vFrom = now(a.from), vTo = now(a.to);
      put(a.from, vTo);
      put(a.to, vFrom);
      const assign = { ...s.assign };
      if (Object.keys(layer).length) assign[s.layer] = layer;
      else delete assign[s.layer];
      const ed = s.editing === a.from ? vTo : s.editing === a.to ? vFrom : null;
      return { ...s, assign,
               ...(ed !== null ? { keyVal: ed } : {}) };
    }

    case "clearAssign":
      return { ...s, assign: {}, msg: null,
               newLayers: { ...s.newLayers, [a.kmId]: [] },
               dropLayers: { ...s.dropLayers, [a.kmId]: [] } };

    // `+ New …`, a card's pencil and Resume all land here. Drafts are per
    // mode, so opening one kind never touches another kind's half-typed one.
    case "openPanel":
      return { ...s, emode: a.mode, editing: null, dts: null, msg: null,
               activeField: null, keyVal: "",
               drafts: a.draft === undefined
                 ? s.drafts : { ...s.drafts, [a.mode]: a.draft } };

    case "closePanel":
      return { ...s, emode: null, dts: null, msg: null, activeField: null };

    // `draft` may be an updater, and anything deriving the next draft from the
    // current one has to use that form: a handler closes over the state of the
    // render it was created in, so two clicks landing before the next render
    // would both start from the same draft and one would be lost.
    case "draft": {
      const prev = s.drafts[a.mode] ?? BLANK[a.mode]();
      const next = typeof a.draft === "function" ? a.draft(prev) : a.draft;
      return { ...s, drafts: { ...s.drafts, [a.mode]: next } };
    }

    // What both a save and a delete end with. The panel has nothing left to
    // say about a record that is now on disk or gone from it, so the editor
    // area closes and the menu lands on that kind's own tab - where the new
    // card is, or where the deleted one no longer is. The draft goes back to
    // blank with it, or Resume would offer something already dealt with.
    case "leavePanel":
      return { ...s, emode: null, dts: null,
               drafts: { ...s.drafts, [a.mode]: BLANK[a.mode]() },
               ptab: a.mode, picker: true, activeField: null,
               ...(a.store ? { store: a.store } : {}),
               ...(a.msg !== undefined ? { msg: a.msg } : {}) };

    // `assign` is a layer imported from another keymap: its keys arrive as
    // pending edits on the new layer, exactly as if each had been set by hand.
    case "addLayer": {
      const assign = { ...s.assign };
      if (a.assign && Object.keys(a.assign).length) assign[a.at] = a.assign;
      else delete assign[a.at];
      return { ...s, layer: a.at, assign,
               newLayers: { ...s.newLayers,
                 [a.kmId]: [...(s.newLayers[a.kmId] || []), { name: a.name }] } };
    }

    // A marked layer stays on screen, struck through, so the indices `assign`
    // is filed by do not move until the save renumbers everything at once.
    case "dropLayer": {
      const cur = (s.dropLayers[a.kmId] || []).filter((n) => n !== a.n);
      return { ...s, dropLayers: { ...s.dropLayers,
                 [a.kmId]: a.on ? [...cur, a.n].sort((x, y) => x - y) : cur },
               ...(a.on && s.layer === a.n
                 ? { editing: null, activeField: null, keyVal: "" } : {}) };
    }

    case "savedVariant":
      return { ...s, data: a.data, store: a.store, msg: a.msg,
               assign: {}, newLayers: { ...s.newLayers, [a.kmId]: [] },
               dropLayers: { ...s.dropLayers, [a.kmId]: [] },
               ...(a.id ? { id: a.id, layer: 0 } : {}) };

    case "imp": return { ...s, imp: a.imp };

    case "impPatch":
      return s.imp ? { ...s, imp: { ...s.imp, ...a.patch } } : s;

    case "imported":
      return { ...s, data: a.data, store: a.store, msg: a.msg,
               assign: {}, ...(a.id ? { id: a.id, layer: 0, layout: 0 } : {}) };

    case "deletedKeymap": {
      const newLayers = { ...s.newLayers }, dropLayers = { ...s.dropLayers };
      delete newLayers[a.kmId];
      delete dropLayers[a.kmId];
      return { ...s, data: a.data, store: a.store, msg: a.msg,
               assign: {}, newLayers, dropLayers,
               id: (a.data.keymaps[0] || {}).id || null, layer: 0, layout: 0 };
    }
  }
}

// --------------------------------------------------------------- the context
const Ctx = createContext<{ s: State; d: Dispatch<Action> } | null>(null);

export function StoreProvider({ data, children }:
    { data: any; children: ReactNode }) {
  const [s, d] = useReducer(reducer, data, initialState);
  useEffect(() => {
    try { localStorage.setItem(VIEW, JSON.stringify({ id: s.id, rail: s.rail, nums: s.nums })); }
    catch { /* no storage: the defaults apply next time */ }
  }, [s.id, s.rail, s.nums]);
  return <Ctx.Provider value={{ s, d }}>{children}</Ctx.Provider>;
}

export function useStore() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStore outside StoreProvider");
  return v;
}

/** The current draft for a mode, created blank on first read. */
export const draftOf = (s: State, mode: Mode): any =>
  s.drafts[mode] ?? BLANK[mode]();
