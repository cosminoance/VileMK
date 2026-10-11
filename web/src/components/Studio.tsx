import { useEffect, useState } from "react";

import { api } from "../lib/api";
import {
  behaviorFor, bindingText, boardLayout, canonical, fileBindings, fileDiff, fileDiffers,
  fileLayer, namesMatch, parseBinding, writeBackEdits, type FileDiff,
  type StudioBehavior, type StudioBinding, type StudioKey, type StudioLayer,
} from "../lib/studio";
import {
  slotBoard, SlotView, splitSlots, vdKey, vdRows, vdShape,
} from "../lib/slots";
import { recordOf, type Mode } from "../lib/drafts";
import { tabForBinding } from "../lib/cards";
import { buildChoices, byId, choicesBody, slugify } from "../lib/keymaps";
import { label } from "../lib/labels";
import { HEADS } from "../lib/zmkcodes";
import { saveItem, saveVariant } from "../state/actions";
import type { AppMode, Msg } from "../state/store";
import { useStore } from "../state/store";
import { Board } from "./Board";
import { ask, askText } from "./Confirm";
import { Dropdown } from "./Dropdown";
import { Help } from "./Help";
import { LayerNameMove } from "./LayerImport";
import { Modal } from "./Modal";
import { KeyEditor } from "./KeyEditor";
import { Menu } from "./Menu";
import { Notice } from "./Notice";
import { Panel } from "./Panels";
import { BUILD_TIP, StudioPickCtx, type StudioPick } from "./Picker";
import { Tables } from "./Tables";
import { Toggle } from "./Toggle";

const MODES: [AppMode, string, string][] = [
  ["firmware", "Firmware", "Edit the keymap compiled into the firmware, build and flash"],
  ["studio", "Studio", "Edit a connected keyboard live through ZMK Studio"],
];

/** The header's Firmware / Studio switch. Firmware state is kept while in Studio. */
export function ModeSwitch() {
  const { s, d } = useStore();
  return (
    <span className="modesw" role="radiogroup" aria-label="Mode">
      {MODES.map(([m, label, tip]) =>
        <button key={m} role="radio" aria-checked={s.mode === m} title={tip}
                className={s.mode === m ? "on" : ""}
                onClick={async () => {
                  if (m !== s.mode && (s.mode !== "studio" || await settleUnsaved()))
                    d({ t: "mode", mode: m });
                }}>{label}</button>)}
    </span>
  );
}

/** Before leaving Studio mode or disconnecting: when the keyboard holds unsaved
 *  changes, save or discard them, or stay. True when it is fine to go. */
export async function settleUnsaved(): Promise<boolean> {
  const lk = await api("GET", "/api/studio/lock").catch(() => null);
  if (!lk?.unsaved) return true;
  const a = await ask({
    title: "Unsaved changes on the keyboard",
    body: "The keyboard has Studio changes that are not saved. Unsaved, they are "
      + "lost when it restarts.",
    ok: "Save to keyboard",
    extra: { label: "Discard", tip: "Put back the bindings the keyboard had at its last save." },
  });
  if (!a) return false;
  try { await api("POST", a === "extra" ? "/api/studio/discard" : "/api/studio/save"); }
  catch (e: any) {
    await ask({ title: "The keyboard refused", body: e.message, info: true });
    return false;
  }
  return true;
}

/** Asks, then erases the Studio changes stored on the open keyboard. With
 *  `writeFirst` the dialog also offers to write them to the variant first.
 *  Resolves to whether it reset. */
export async function resetKeyboard(device: string,
                                    writeFirst?: () => Promise<boolean>): Promise<boolean> {
  const a = await ask({
    title: `Reset ${device || "the keyboard"} to its flashed firmware?`,
    body: <>Erases every Studio change stored on it: keys, layer names, layer order and
      layers turned on with + layer. It then runs the keymap it was flashed with. Bluetooth
      pairings stay and no flash is needed; this is lighter than the settings_reset
      firmware. Flash the variant afterwards if it changed since the keyboard was last
      flashed. This cannot be undone.</>,
    ok: "Reset", danger: true,
    ...(writeFirst ? { extra: { label: "Save as variant first",
                                tip: "Save the keyboard's keymap as a new variant, then reset." } }
                   : {}),
  });
  if (!a) return false;
  if (a === "extra" && writeFirst && !await writeFirst()) return false;
  const r = await api("POST", "/api/studio/reset");
  if (!r.reset) throw new Error("the keyboard refused the reset");
  return true;
}

/** Why the keyboard's keymap cannot be saved as a variant of `km`, or null. */
function writeBlock(km: any, diff: FileDiff | null, unsaved: boolean, total: number) {
  if (!km || !diff) return "pick the keymap this keyboard runs first";
  if (unsaved) return "Save to keyboard first";
  if (km.layers.length !== total)
    return `${km.name} has ${km.layers.length} layers and the keyboard's firmware ${total}: `
      + "the file changed since it was flashed, or the keyboard runs another keymap";
  if (km.firmware?.uf2 && !km.firmware.fresh)
    return `${km.name} was saved after its last build, so the keyboard may run an older `
      + "version of it; build and flash it first";
  if (diff.beyond.length)
    return `${km.name} has fewer layers than the keyboard: it is not the file this keyboard `
      + "was flashed with";
  if (diff.missing.length)
    return `${km.name} does not define ${diff.missing.join(", ")}, bound on the keyboard`;
  if (!fileDiffers(diff)) return `the keyboard already matches ${km.name}`;
  return null;
}

interface Port { port: string; name: string; serial: string }
interface Loaded {
  info: { name: string; serial: string };
  /** The keyboard's layers without the vile slots layer. */
  layers: StudioLayer[];
  /** The vile slots layer, kept out of the tabs. */
  slots: StudioLayer | null;
  /** Reserved layers the firmware can still turn on. */
  available: number;
  /** The longest layer name the firmware stores. */
  maxName: number;
  behaviors: StudioBehavior[];
  layouts: { active: number; layouts: { name: string; keys: StudioKey[] }[] };
}

/** What a keyboard's match is filed under: its serial, or its name without one. */
const keyOf = (info: { name: string; serial: string }) => info.serial || info.name;

/** First connect of a keyboard: which keymap it runs. Keymaps named like the
 *  device come first. Closing it records "none"; the bar's select repicks. */
function MatchDialog({ device, keymaps, pick, close }:
    { device: string; keymaps: any[]; pick: (id: string) => void; close: () => void }) {
  const likely = keymaps.filter((k) => namesMatch(device, k));
  const rest = keymaps.filter((k) => !likely.includes(k));
  const Row = ({ k }: { k: any }) => (
    <button onClick={() => pick(k.id)}>
      {k.name}<small>{k.kind} · {k.keyboard} · {k.layers.length} layers</small>
    </button>);
  return (
    <Modal onClose={close} className="layerimport">
      <div className="bar"><h2>Which keymap is on {device || "this keyboard"}?</h2></div>
      <p className="legend">The board is drawn in its layouts and compared with it. You can
        change it later from the keymap select above the board.</p>
      <div className="items">
        {likely.map((k) => <Row key={k.id} k={k} />)}
        {!!likely.length && !!rest.length && <hr />}
        {rest.map((k) => <Row key={k.id} k={k} />)}
      </div>
      <div className="rowbtns">
        <button className="ghost" onClick={close}>None of these</button>
      </div>
    </Modal>
  );
}

/** The nodes Firmware mode would generate for a slot viledance, so `Board` and
 *  `Tables` read it the same way. */
function slotNodes(r: any) {
  const head = (t: string) => (t || "&none").trim().split(/\s+/)[0];
  if (vdShape(r) === "two")
    return [{ label: `ht_${r.name}`, kind: "hold-tap", props: {},
              bindings: [head(r.hold), head(r.tap)] }];
  const [hold, tap, th, dbl] = vdRows(r);
  return [
    { label: `vd_${r.name}`, kind: "tap-dance", props: {},
      bindings: [`&ht_${r.name}_1`, `&ht_${r.name}_2`] },
    { label: `ht_${r.name}_1`, kind: "hold-tap", props: {}, bindings: [hold, tap] },
    { label: `ht_${r.name}_2`, kind: "hold-tap", props: {}, bindings: [th, dbl] },
  ];
}

/** Behaviors only the vile slots machinery uses. */
const SLOT_PARTS = /^(vslot|vht1|vht2|vd_s\d+)$/;

/** The layer tabs: the keyboard's layers with the removed ones back at `at`. */
function tabsOf(layers: StudioLayer[], removed: { layer: StudioLayer; at: number }[]) {
  const tabs = layers.map((l) => ({ l, gone: false }));
  for (const r of [...removed].sort((a, b) => a.at - b.at))
    tabs.splice(Math.min(r.at, tabs.length), 0, { l: r.layer, gone: true });
  return tabs;
}

/** Studio mode's page: connect to a keyboard, show its keymap and edit it with
 *  the same board, key editor and menu as Firmware mode. Each pick goes to the
 *  keyboard at once; Save to keyboard makes it survive a restart. */
export function StudioView() {
  const { s, d } = useStore();
  const [ports, setPorts] = useState<Port[] | null>(null);
  const [kb, setKb] = useState<Loaded | null>(null);
  // The layers as of the keyboard's last save, for the key editor's Reset.
  const [saved, setSaved] = useState<StudioLayer[]>([]);
  const [lock, setLock] = useState<{ unlocked: boolean; unsaved: boolean } | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState<Msg | null>(null);
  const [busy, setBusy] = useState(false);
  const [li, setLi] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  const [keyVal, setKeyVal] = useState("");
  // Layers taken out with remove_layer, shown struck through until restored,
  // saved or discarded; `at` is the index they had.
  const [removed, setRemoved] = useState<{ layer: StudioLayer; at: number }[]>([]);
  // Compare-with and the drawn layout; null follows the matched keymap.
  const [base, setBase] = useState<string | null>(null);
  const [layoutAt, setLayoutAt] = useState<number | null>(null);
  const [matching, setMatching] = useState(false);
  // The variant save reports through the store's msg, shown here once a write starts.
  const [wrote, setWrote] = useState(false);
  const pending = s.studioPending;
  const setPending = (p: typeof pending) => d({ t: "studioPending", pending: p });

  // A call that fails on a keyboard that went away drops back to the port list.
  const lost = (e: any) => {
    setKb(null); setLock(null); setEditing(null); setPending({}); setErr(e.message); look();
  };

  const load = async (info: Loaded["info"]) => {
    const [km, behaviors, layouts, lk] = await Promise.all([
      api("GET", "/api/studio/keymap"), api("GET", "/api/studio/behaviors"),
      api("GET", "/api/studio/layouts"), api("GET", "/api/studio/lock")]);
    const sp = splitSlots(km.layers);
    setKb({ info, layers: sp.layers, slots: sp.slots, available: km.available_layers,
            maxName: km.max_layer_name_length, behaviors: behaviors.behaviors, layouts });
    setSaved(sp.layers);
    setLock(lk);
    setLi(0); setEditing(null); setMsg(null); setRemoved([]);
    setBase(null); setLayoutAt(null);
    setMatching(!(keyOf(info) in (s.data.studio_keyboards || {})));
    if (!lk.unsaved) setPending({});
  };

  const look = () => {
    setPorts(null);
    api("GET", "/api/studio/ports").then((r) => {
      setPorts(r.ports);
      const open = r.ports.find((p: Port) => p.port === r.connected);
      if (open) load({ name: open.name, serial: open.serial }).catch(lost);
    }).catch((e) => { setPorts([]); setErr(e.message); });
  };
  useEffect(look, []);

  const connect = async (port: string) => {
    setBusy(true); setErr("");
    try { await load((await api("POST", "/api/studio/connect", { port })).info); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const disconnect = async () => {
    if (!await settleUnsaved()) return;
    await api("DELETE", "/api/studio/connect").catch(() => {});
    setKb(null); setLock(null); setPending({}); look();
  };

  // Unlocking is a key press on the keyboard, so the page asks until it happens.
  useEffect(() => {
    if (!kb || !lock || lock.unlocked) return;
    const t = window.setInterval(() => {
      api("GET", "/api/studio/lock").then(setLock).catch(lost);
    }, 1000);
    return () => window.clearInterval(t);
  }, [kb, lock?.unlocked]);

  if (!kb) return (
    <main className="studio">
      <div className="bar"><h2>ZMK Studio</h2>
        <button className="ghost" disabled={ports === null || busy} onClick={look}>Look again</button>
      </div>
      {err && <div className="msg bad">{err}</div>}
      {ports === null ? <p className="legend">Looking for keyboards…</p>
        : !ports.length
        ? <p className="legend">No keyboard answers as ZMK Studio. Plug one in over USB; its
            firmware needs the <code>studio-rpc-usb-uart</code> snippet and
            {" "}<code>CONFIG_ZMK_STUDIO=y</code>. A port the official Studio app holds is not
            listed.</p>
        : <ul className="ports">
            {ports.map((p) => (
              <li key={p.port}>
                <span><b>{p.name || "keyboard"}</b> <span className="path">{p.port}</span></span>
                <button className="act" disabled={busy} onClick={() => connect(p.port)}>
                  Connect</button>
              </li>))}
          </ul>}
    </main>
  );

  const layout = kb.layouts.layouts[kb.layouts.active] || kb.layouts.layouts[0];
  const key = keyOf(kb.info);
  const matched = byId(s.data.keymaps, (s.data.studio_keyboards || {})[key] || "");
  // The matched keymap's layouts, view only: the keyboard keeps its own active one.
  const lays: any[] = matched ? matched.layouts : [];
  const at = layoutAt ?? Math.max(0, lays.findIndex((l) =>
    layout && (l.label === layout.name || l.display === layout.name)));
  const lay = lays[at] || (layout ? boardLayout(layout.keys) : null);

  const tabs = tabsOf(kb.layers, removed);
  const shownTab = tabs[Math.min(li, tabs.length - 1)];
  const gone = !!shownTab?.gone;
  const layer = gone ? undefined : shownTab?.l;

  // Vile slots: keys bound to a container or pair read as the viledance whose
  // rows its slots hold, as Firmware mode names it.
  const records: any[] = s.store.viledance || [];
  const sb = slotBoard(kb.slots, kb.behaviors, matched);
  const viewOf = (sl: StudioLayer | null) => typeof sb === "string" || !sl ? null
    : new SlotView({ ...sb, layer: sl }, kb.behaviors, kb.layers, records);
  const view = viewOf(kb.slots);
  const tx = (v: string) => view ? view.from(v) : v;
  const text = (l: StudioLayer | undefined, pos: number) =>
    l?.bindings[pos] ? tx(bindingText(l.bindings[pos], kb.behaviors, kb.layers)) : "";
  const bindings = layer ? layer.bindings.map((_, i) => text(layer, i)) : [];
  const locked = !!lock && !lock.unlocked;

  const baseKm = byId(s.data.keymaps, base ?? matched?.id ?? "");
  // The matched keymap pairs layers by id, any other by tab index.
  const byIdBase = !!baseKm && baseKm.id === matched?.id;
  const baseOf = (l: StudioLayer, i: number): string[] | null => {
    if (!baseKm) return null;
    if (byIdBase) return fileBindings(baseKm, l.id, kb.behaviors, kb.layers);
    const b = baseKm.layers[i];
    return b ? b.bindings.map((t: string) => canonical(t, kb.behaviors, kb.layers)) : null;
  };
  const fit = (b: string[] | null, n: number) => b && b.length === n ? b : null;
  const baseBindings = layer ? fit(baseOf(layer, li), bindings.length) : null;
  const changed = (l: StudioLayer, i: number) => {
    const b = fit(baseOf(l, i), l.bindings.length);
    return b ? l.bindings.filter((_, p) => text(l, p) !== b[p]).length : 0;
  };
  const known = records.flatMap((r) => [`vd_${r.name}`, `ht_${r.name}`]);
  const diff = matched ? fileDiff(matched, kb.layers, kb.behaviors, tx, known) : null;
  const differs = !!diff && fileDiffers(diff);
  const blocked = writeBlock(matched, diff, !!lock?.unsaved,
                             kb.layers.length + removed.length + kb.available);

  const match = async (id: string) => {
    try {
      const r = await api("POST", "/api/studio-keyboard", { key, id });
      d({ t: "data", data: { ...s.data, studio_keyboards: r.studio_keyboards } });
      setBase(null); setLayoutAt(null); setMatching(false);
    } catch (e: any) { setMsg({ text: e.message, bad: true }); }
  };

  // Layer calls change the keymap's shape, so they reply with what to redraw.
  const layerCall = async (path: string, body: object) => {
    try { return await api("POST", `/api/studio/${path}`, body); }
    catch (e: any) {
      if (e.status === 409 || e.status === 410) lost(e);
      else setMsg({ text: e.message, bad: true });
      return null;
    }
  };
  const addLayer = async () => {
    const name = await askText({ title: "New layer", ok: "Add layer",
      field: { value: `layer_${kb.layers.length}`, placeholder: "layer name" } });
    if (!name) return;
    const r = await layerCall("layer", {});
    if (!r) return;
    const added = { ...r.layer, name };
    if (!await layerCall("layer/name", { layer_id: added.id, name })) added.name = r.layer.name;
    const layers = [...kb.layers];
    layers.splice(r.index, 0, added);
    setKb({ ...kb, layers, available: Math.max(0, kb.available - 1) });
    setLock({ unlocked: true, unsaved: true });
    setLi(r.index + removed.filter((x) => x.at <= r.index).length);
    setMsg({ text: `added layer ${added.name}` });
  };
  const removeLayer = async () => {
    if (!layer) return;
    const index = kb.layers.findIndex((l) => l.id === layer.id);
    if (!await layerCall("layer/remove", { index })) return;
    setKb({ ...kb, layers: kb.layers.filter((l) => l.id !== layer.id) });
    setRemoved([...removed, { layer, at: index }]);
    setLock({ unlocked: true, unsaved: true });
    setEditing(null);
  };
  const restoreLayer = async () => {
    const r = removed.find((x) => x.layer.id === shownTab?.l.id);
    if (!r) return;
    const at = Math.min(r.at, kb.layers.length);
    const back = await layerCall("layer/restore", { layer_id: r.layer.id, at });
    if (!back) return;
    const layers = [...kb.layers];
    layers.splice(at, 0, back.id === undefined ? r.layer : back);
    setKb({ ...kb, layers });
    setRemoved(removed.filter((x) => x !== r));
  };

  const renameLayer = async (name: string) => {
    if (!layer || !await layerCall("layer/name", { layer_id: layer.id, name })) return;
    setKb({ ...kb, layers: kb.layers.map((l) => l.id === layer.id ? { ...l, name } : l) });
    setLock({ unlocked: true, unsaved: true });
  };
  // Keys name layers by id, so nothing needs renumbering after a move.
  const moveLayer = async (by: number) => {
    if (!layer) return;
    const start = kb.layers.findIndex((l) => l.id === layer.id);
    const r = await layerCall("layer/move", { start, dest: start + by });
    if (!r) return;
    const all: StudioLayer[] = r.layers?.length ? r.layers
      : (await api("GET", "/api/studio/keymap").catch(lost))?.layers;
    if (!all) return;
    const { layers, slots } = splitSlots(all);
    setKb({ ...kb, layers, slots });
    setLock({ unlocked: true, unsaved: true });
    setLi(Math.max(0, tabsOf(layers, removed).findIndex((x) => !x.gone && x.l.id === layer.id)));
  };
  const place = layer ? kb.layers.findIndex((l) => l.id === layer.id) : -1;

  // The tables list the keyboard's own behaviors (anything ZMK does not ship),
  // with what the matched keymap's file says each one does.
  // Slot viledances and combo outputs come from what the slots hold now.
  const custom = kb.behaviors.map((b) => b.name)
    .filter((n) => !(n in HEADS) && !SLOT_PARTS.test(n));
  const inSlots = view ? (["four", "two"] as const).flatMap((sh) =>
    view.starts(sh).map((i) => view.holder(i, sh)).filter(Boolean)) : [];
  const slotCombos = typeof sb === "string" ? [] : (matched?.combos || []).flatMap((c: any) => {
    const name = c.name.replace(/^combo_/, "");
    return name in sb.combos && view
      ? [{ ...c, bindings: view.from(view.text(sb.combos[name])) }] : [];
  });
  const tableKm = {
    combos: slotCombos,
    behaviors: [...inSlots.flatMap(slotNodes),
                ...(matched?.behaviors || []).filter((b: any) => custom.includes(b.label))],
    macros: (matched?.macros || []).filter((b: any) => custom.includes(b.label)),
    layers: tabs.map(({ l, gone: g }) => ({
      bindings: g ? [] : l.bindings.map((_, i) => text(l, i)) })),
  };
  const defined = new Set([...tableKm.behaviors, ...tableKm.macros].map((b: any) => b.label));
  const missing = custom.filter((n) => !defined.has(n));

  /** The saved viledance a picked text names, when it goes into slots here. */
  const slotRec = (v: string) => {
    const m = /^&(?:vd|ht)_(\w+)/.exec(v.trim());
    if (!m || behaviorFor(v.trim().split(/\s+/)[0].slice(1), kb.behaviors)) return null;
    const r = records.find((x) => x.name === m[1]);
    return r && vdShape(r) && vdKey(r) === v.trim().replace(/\s+/g, " ") ? r : null;
  };
  const full = (shape: string) =>
    `all ${shape}-way vile slots on the keyboard are in use: unbind one, or build with more`;

  const why = (v: string) => {
    const r = slotRec(v);
    if (r) {
      if (!view) return typeof sb === "string" ? sb : "the keyboard has no vile slots";
      const sh = vdShape(r) as "four" | "two";
      return view.where(r) >= 0 || view.free(sh, kb.layers) >= 0 ? null : full(sh);
    }
    const b = parseBinding(v, kb.behaviors, kb.layers);
    return typeof b === "string" ? b : null;
  };

  const post = (layerId: number, position: number, b: StudioBinding) =>
    api("POST", "/api/studio/binding", { layer_id: layerId, position, ...b });

  // Writes rows into the slots from `start`; the slots layer after, or why not.
  const writeSlots = async (sl: StudioLayer, start: number, rows: string[]) => {
    let bs = sl.bindings;
    for (const [k, row] of rows.entries()) {
      const b = parseBinding(row || "&none", kb.behaviors, kb.layers);
      if (typeof b === "string") return `${row}: ${b}`;
      await post(sl.id, start + k, b);
      bs = bs.map((x, i) => i === start + k ? b : x);
    }
    return { ...sl, bindings: bs };
  };

  // A viledance's container or pair on the keyboard, filled first when it has none.
  const placeVd = async (r: any, sl: StudioLayer) => {
    const v = viewOf(sl)!;
    const sh = vdShape(r) as "four" | "two";
    let i = v.where(r);
    if (i < 0) {
      i = v.free(sh, kb.layers);
      if (i < 0) return full(sh);
      const w = await writeSlots(sl, i, vdRows(r));
      if (typeof w === "string") return w;
      sl = w;
    }
    return { sl, key: v.keyText(i, sh) };
  };

  // Sends each [position, text] to the shown layer. At the first refusal the
  // keys already sent are written back, so a swap never ends half done.
  const write = async (keys: [number, string][]) => {
    if (!layer) return false;
    const parsed: [number, string, StudioBinding][] = [];
    let sl = kb.slots;
    for (const [pos, v] of keys) {
      let kt = v;
      const r = slotRec(v);
      if (r && sl && view) {
        try {
          const p = await placeVd(r, sl);
          if (typeof p === "string") { setMsg({ text: p, bad: true }); return false; }
          sl = p.sl; kt = p.key;
        } catch (e: any) {
          if (e.status === 409 || e.status === 410) lost(e);
          else setMsg({ text: e.message, bad: true });
          return false;
        }
      }
      const b = parseBinding(kt, kb.behaviors, kb.layers);
      if (typeof b === "string") { setMsg({ text: b, bad: true }); return false; }
      parsed.push([pos, v, b]);
    }
    let bs = layer.bindings;
    const marks = { ...pending[layer.id] };
    const last = saved.find((l) => l.id === layer.id);
    const mark = (pos: number, v: string) => {
      if (v === text(last, pos)) delete marks[pos];
      else marks[pos] = v;
    };
    const send = (pos: number, b: StudioBinding) =>
      api("POST", "/api/studio/binding", { layer_id: layer.id, position: pos, ...b });
    const done: [number, StudioBinding][] = [];
    let ok = true;
    for (const [pos, v, b] of parsed) {
      try { await send(pos, b); }
      catch (e: any) {
        if (e.status === 409 || e.status === 410) { lost(e); return false; }
        if (/locked/.test(e.message)) setLock({ unlocked: false, unsaved: !!lock?.unsaved });
        let note = e.message;
        for (const [p, prev] of [...done].reverse()) {
          try {
            await send(p, prev);
            bs = bs.map((x, i) => i === p ? prev : x);
            mark(p, tx(bindingText(prev, kb.behaviors, kb.layers)));
          } catch (e2: any) { note += `; key ${p} could not be put back: ${e2.message}`; }
        }
        setMsg({ text: note, bad: true });
        ok = false;
        break;
      }
      done.push([pos, bs[pos]]);
      bs = bs.map((x, i) => i === pos ? b : x);
      mark(pos, v);
    }
    setKb({ ...kb, slots: sl,
            layers: kb.layers.map((l) => l.id === layer.id ? { ...l, bindings: bs } : l) });
    setPending({ ...pending, [layer.id]: marks });
    setLock({ unlocked: lock?.unlocked ?? true, unsaved: true });
    return ok;
  };

  const pick = async (v: string) => {
    if (editing === null) return setMsg({ text: "click a key on the board first", bad: true });
    const pos = editing;
    if (await write([[pos, v]])) {
      setEditing(null);
      setMsg({ text: `key ${pos} → ${label(v)}` });
    }
  };

  // Every key bound to `from` (keyboard text) gets `to`, on every layer.
  const rebind = async (from: string, to: string, shown: string) => {
    const b = parseBinding(to, kb.behaviors, kb.layers);
    if (typeof b === "string") throw new Error(`${to}: ${b}`);
    const marks = { ...pending };
    const layers: StudioLayer[] = [];
    for (const l of kb.layers) {
      let bs = l.bindings;
      for (const [pos, x] of l.bindings.entries())
        if (bindingText(x, kb.behaviors, kb.layers) === from) {
          await post(l.id, pos, b);
          bs = bs.map((y, i) => i === pos ? b : y);
          marks[l.id] = { ...marks[l.id], [pos]: shown };
        }
      layers.push({ ...l, bindings: bs });
    }
    setPending(marks);
    return layers;
  };

  /** Why a viledance or combo cannot be made or changed here, null when it can. */
  const slotWhy = (mode: Mode, name?: string) => {
    if (mode !== "viledance" && mode !== "combo") return BUILD_TIP;
    if (typeof sb === "string") return sb;
    if (mode === "viledance") return null;
    if (!name) return "a new combo needs a build: make it in Firmware mode";
    return name in sb.combos ? null
      : `${name} is not in a vile slot on this keyboard: changing it needs a build`;
  };

  // The panel's Save: the record in custom/, then what the keyboard's slots hold.
  // A viledance that changes shape moves to a container or pair of the new shape,
  // and every key bound to it follows.
  const saveRecord = async (mode: Mode, draft: any) => {
    const old = recordOf(s.store, mode, draft.name);
    const oldShape = old ? vdShape(old) : "";
    const at = mode === "viledance" && view && old ? view.where(old) : -1;
    if (!await saveItem(s, d, mode, draft) || !view || typeof sb === "string") return;
    let sl = kb.slots!;
    let layers = kb.layers;
    try {
      if (mode === "combo") {
        const slot = sb.combos[draft.name];
        if (slot === undefined) return;
        let out = draft.binding;
        const r = slotRec(out);
        if (r) {
          const p = await placeVd(r, sl);
          if (typeof p === "string") throw new Error(p);
          sl = p.sl; out = p.key;
        }
        const w = await writeSlots(sl, slot, [out]);
        if (typeof w === "string") throw new Error(w);
        sl = w;
      } else if (at >= 0) {
        const sh = vdShape(draft);
        if (sh === oldShape) {
          const w = await writeSlots(sl, at, vdRows(draft));
          if (typeof w === "string") throw new Error(w);
          sl = w;
        } else {
          let key = draft.tap || "&none";
          if (sh) {
            const v = viewOf(sl)!;
            const i = v.free(sh, kb.layers);
            if (i < 0) throw new Error(full(sh));
            const w = await writeSlots(sl, i, vdRows(draft));
            if (typeof w === "string") throw new Error(w);
            sl = w; key = v.keyText(i, sh);
          }
          layers = await rebind(view.keyText(at, oldShape as "four" | "two"), key, vdKey(draft));
          const w = await writeSlots(sl, at, Array(oldShape === "four" ? 4 : 2).fill("&none"));
          if (typeof w === "string") throw new Error(w);
          sl = w;
        }
      } else if (behaviorFor(`vd_${draft.name}`, kb.behaviors) || behaviorFor(`ht_${draft.name}`, kb.behaviors)) {
        setMsg({ text: `${draft.name} is compiled into this keyboard's firmware: the change `
          + "reaches it with the next build and flash" });
        return;
      } else return;
      setMsg({ text: `${draft.name} sent to the keyboard; Save to keyboard keeps it` });
    } catch (e: any) {
      if (e.status === 409 || e.status === 410) return lost(e);
      setMsg({ text: e.message, bad: true });
    }
    setKb((k) => k && { ...k, slots: sl, layers });
    setLock({ unlocked: true, unsaved: true });
  };

  // The keyboard's keymap as a new variant of the matched keymap, which then
  // becomes the match. An existing variant is never overwritten from here.
  const writeBack = async (): Promise<boolean> => {
    if (!matched || blocked) return false;
    const typed = await askText({ title: "Save as variant", ok: "Save",
      field: { value: `${matched.name}_studio`, placeholder: "variant name" } });
    if (!typed) return false;
    if (s.data.keymaps.some((k: any) => k.kind === "variant" && k.name === slugify(typed))) {
      setMsg({ text: `a variant named ${slugify(typed)} exists; pick another name`, bad: true });
      return false;
    }
    setBusy(true); setMsg(null); d({ t: "msg", msg: null }); setWrote(true);
    const id = await saveVariant(s, d, matched, null, typed,
      choicesBody(buildChoices(s, matched)), writeBackEdits(matched, kb.layers, kb.behaviors, tx));
    setBusy(false);
    if (id === false) return false;
    if (id) {
      // `match()` would put back the keymap list from before the save.
      try {
        await api("POST", "/api/studio-keyboard", { key, id });
        d({ t: "data", data: await api("GET", "/api/state") });
        setBase(null); setLayoutAt(null);
      } catch (e: any) { setMsg({ text: e.message, bad: true }); }
    }
    return true;
  };
  const reset = async () => {
    try {
      if (!await resetKeyboard(kb.info.name, differs && !blocked ? writeBack : undefined)) return;
      const r = await api("GET", "/api/studio/keymap");
      const km = splitSlots(r.layers);
      setKb({ ...kb, ...km, available: r.available_layers });
      setSaved(km.layers);
      setPending({}); setEditing(null); setRemoved([]); setLi(0);
      setLock(await api("GET", "/api/studio/lock"));
      setMsg({ text: "the keyboard is back to its flashed firmware" });
    } catch (e: any) {
      if (e.status === 409 || e.status === 410) lost(e);
      else setMsg({ text: e.message, bad: true });
    }
  };

  const finish = async (what: "save" | "discard") => {
    setBusy(true);
    try {
      await api("POST", `/api/studio/${what}`);
      if (what === "discard") {
        const r = await api("GET", "/api/studio/keymap");
        const km = splitSlots(r.layers);
        setKb({ ...kb, ...km, available: r.available_layers });
        setSaved(km.layers);
        setLi(0);
      } else setSaved(kb.layers);
      setPending({}); setEditing(null); setRemoved([]);
      setMsg({ text: what === "save" ? "saved to the keyboard" : "changes discarded" });
      setLock(await api("GET", "/api/studio/lock"));
    } catch (e: any) {
      if (e.status === 409 || e.status === 410) lost(e);
      else setMsg({ text: e.message, bad: true });
    } finally { setBusy(false); }
  };

  const onKey = locked ? null : (pos: number) => {
    if (s.emode) d({ t: "closePanel" });
    setEditing(pos);
    setKeyVal(bindings[pos] || "");
    d({ t: "ptab", tab: tabForBinding(bindings[pos], s.store) });
  };
  const onSwap = locked || !layer ? null : (from: number, to: number) =>
    write([[from, bindings[to]], [to, bindings[from]]]).then((ok) => ok &&
      setMsg({ text: `swapped keys ${from} and ${to}` }));

  const studioPick: StudioPick = {
    editing, layer: li, saved: text(saved.find((l) => l.id === layer?.id), editing ?? -1),
    close: () => setEditing(null), pick, setField: setKeyVal, cur: keyVal, why,
    layers: kb.layers.map((l, i): [number, string] => [i, l.name]),
    slotWhy, saveRecord, slots: typeof sb === "string" ? null : sb.settings,
  };

  return (
    <main className="studio">
      <div className="bar">
        <h2>{kb.info.name || "keyboard"}</h2>
        {layout && <span className="path">active layout: {layout.name}</span>}
      </div>

      <div className="bar">
        <span className="path">keymap</span>
        <select value={matched?.id || ""} onChange={(e) => match(e.target.value)}
                title="Which of your keymaps this keyboard runs. Its layouts and the comparison follow it.">
          <option value="">none</option>
          {s.data.keymaps.map((k: any) => (
            <option key={k.id} value={k.id}>{k.kind}: {k.name}</option>))}
        </select>
        {lays.length > 1
          ? <select value={at} onChange={(e) => setLayoutAt(+e.target.value)}
                    title="Only how the board is drawn here; the keyboard keeps its own layout.">
              {lays.map((l: any, i: number) => (
                <option key={i} value={i}>{l.display || l.label} &middot; {l.count} keys</option>))}
            </select>
          : lays[0] && <span className="path">{lays[0].display || lays[0].label}</span>}
        <select className="grow" value={baseKm?.id || ""} onChange={(e) => setBase(e.target.value)}>
          <option value="">compare with… (off)</option>
          {s.data.keymaps.map((k: any) => (
            <option key={k.id} value={k.id}>{k.kind}: {k.path}</option>))}
        </select>
      </div>

      <div className="bar">
        <button className="act" disabled={busy || locked || !lock?.unsaved}
                onClick={() => finish("save")}>Save to keyboard</button>
        <button className="ghost" disabled={busy || locked || !lock?.unsaved}
                onClick={() => finish("discard")}>Discard</button>
        {matched &&
          <button className="ghost" disabled={busy || !!blocked} title={blocked || undefined}
                  onClick={writeBack}>
            Save as variant…
          </button>}
        <Help label="what saving as a variant does">
          Saves the keyboard's keys, layer names and layer order as a new variant of the
          matched keymap, so a build holds them. A layer turned on with + layer stops
          being reserved in it. The matched keymap is not changed, and the keyboard is
          matched to the new variant.
        </Help>
        <button className="ghost danger" disabled={busy || locked} onClick={reset}>
          Reset to flashed firmware</button>
        <Help label="what resetting does">
          Erases what Studio stored on the keyboard so it runs the keymap it was flashed
          with. Bluetooth pairings stay. The settings_reset firmware does the same and
          more (it also clears pairings) but takes two flashes.
        </Help>
        <span className="end"><button className="ghost" onClick={disconnect}>Disconnect</button></span>
      </div>
      {msg && <Notice msg={msg} close={() => setMsg(null)} />}
      {wrote && s.msg &&
        <Notice msg={s.msg} close={() => { setWrote(false); d({ t: "msg", msg: null }); }} />}
      {err && <div className="msg bad">{err}</div>}
      {locked &&
        <div className="warn">Locked. Editing needs the key bound to
          {" "}<code>&amp;studio_unlock</code>: press it on the keyboard. A keymap without
          one can be read here but not changed.</div>}
      {lock?.unsaved &&
        <div className="warn">The keyboard is using changes that are not saved: they are
          lost when it restarts unless you <b>Save to keyboard</b>.</div>}

      {diff && (differs || !!diff.missing.length
        ? <div className="warn">Differs from {matched.name}:{" "}
            {[Object.keys(diff.keys).length
                && `${Object.values(diff.keys).reduce((a, b) => a + b, 0)} keys on `
                   + `${Object.keys(diff.keys).length} layers`,
              diff.added.length && `layers turned on: ${diff.added.join(", ")}`,
              diff.removed.length && `layers removed: ${diff.removed.join(", ")}`,
              diff.renamed.length && `renamed: ${diff.renamed.map(([a, b]) => `${a} → ${b}`).join(", ")}`,
              diff.moved && "layer order changed",
              diff.beyond.length && `${diff.beyond.length} layers the file does not have`,
              diff.missing.length && `not defined in the file: ${diff.missing.join(", ")}`,
            ].filter(Boolean).join(" · ")}</div>
        : <p className="legend">The keyboard matches {matched.name}.</p>)}

      {baseKm && !gone && layer && !baseBindings &&
        <div className="warn">comparison off for this layer: {byIdBase && !fileLayer(baseKm, layer.id)
          ? `${baseKm.name} has no such layer, or it is reserved there`
          : `the keyboard and ${baseKm.name} disagree on layer count or key count`}</div>}

      <div className="tabs">
        {tabs.map(({ l, gone: g }, i) => (
          <button key={l.id} className={[i === li && "sel", g && "gone"].filter(Boolean).join(" ")}
                  title={g ? "removed until you save; Discard or Restore layer brings it back"
                         : undefined}
                  onClick={() => { setLi(i); setEditing(null); }}>
            {i}&nbsp;&middot;&nbsp;{l.name || `layer ${i}`}
            {Object.keys(pending[l.id] || {}).length ? " *" : ""}
            {!g && baseKm && changed(l, i) ? <small title={`keys that differ from ${baseKm.name}`}>
              {" "}&middot;{changed(l, i)}</small> : null}
          </button>))}
        <Dropdown className="ghost sm" label="+ layer" items={[
          { label: <>Empty layer
                     {!kb.available && <small>no reserved layer left</small>}</>,
            disabled: locked || !kb.available, onPick: addLayer,
            title: !kb.available ? "The firmware has no reserved layer left. Add reserved "
              + "layers in Firmware mode, build and flash." : undefined },
          { label: <>Layer from another keyboard…<small>in Firmware mode</small></>,
            disabled: true, onPick: () => {},
            title: "Studio cannot bring in VileDances, macros or layer entries the "
              + "firmware was not built with. Import the layer in Firmware mode, "
              + "build and flash." },
        ]} />
      </div>
      {shownTab &&
        <div className="boardopts">
          {lay && !gone &&
            <Toggle checked={s.nums} onChange={(on) => d({ t: "nums", on })}>
              key positions
            </Toggle>}
          <span className="end">
            {!gone && layer &&
              <LayerNameMove name={layer.name} disabled={locked} maxLength={kb.maxName || undefined}
                             left={place > 0} right={place < kb.layers.length - 1}
                             onRename={renameLayer} onMove={moveLayer}>
                <Help label="what renaming and moving a layer do">
                  Both reach the keyboard straight away and last once you Save to
                  keyboard. Keys that switch layers follow the layer they point at,
                  not its number. Layer 0 is the one the keyboard starts on.
                </Help>
              </LayerNameMove>}
            <button className={gone ? "ghost sm" : "ghost sm danger"}
                    disabled={locked || (!gone && kb.layers.length <= 1)}
                    onClick={gone ? restoreLayer : removeLayer}>
              {gone ? "Restore layer" : "Delete layer"}
            </button>
            <Help label="what deleting a layer does">
              The keyboard stops using the layer straight away, and the layers after it
              move down one. Save to keyboard makes it permanent and frees it for
              + layer; Discard or Restore layer brings it back. Keys that switch to
              layers keep pointing at the same layer, not the same number.
            </Help>
          </span>
        </div>}

      {gone
        ? <p className="legend">This layer is removed until you save.</p>
        : layer && lay
        ? <Board km={tableKm} lay={lay} bindings={bindings}
                 baseBindings={baseBindings} assign={pending[layer.id] || {}} nums={s.nums}
                 hot={s.hot} sel={[]} editing={editing} onKey={onKey} onSwap={onSwap} />
        : <p className="legend">The keyboard sent no physical layout to draw.</p>}

      <StudioPickCtx.Provider value={studioPick}>
        {editing !== null && <KeyEditor layer={layer} />}
        {editing === null && s.emode && <Panel mode={s.emode} km={matched} />}
        <Menu layer={layer} />
      </StudioPickCtx.Provider>

      {view
        ? <p className="legend">Vile slots: {view.usage("four").join(" of ")} four-way and
            {" "}{view.usage("two").join(" of ")} two-way viledances in use, {slotCombos.length}
            {" "}combo outputs. Viledances and combo outputs in slots change here with no
            build; conditional layers and the rest of each combo are part of the build.</p>
        : <p className="legend">Combos and conditional layers are part of the firmware build;
            Studio can neither read nor change them. Edit them in Firmware mode.</p>}
      <Tables km={tableKm} layer={li} missing={missing} from={matched?.name} />

      {matching &&
        <MatchDialog device={kb.info.name} keymaps={s.data.keymaps}
                     pick={match} close={() => match("")} />}
    </main>
  );
}
