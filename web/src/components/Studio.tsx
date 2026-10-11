import { useEffect, useState } from "react";

import { api } from "../lib/api";
import {
  bindingText, boardLayout, canonical, namesMatch, parseBinding,
  type StudioBehavior, type StudioBinding, type StudioKey, type StudioLayer,
} from "../lib/studio";
import { tabForBinding } from "../lib/cards";
import { byId } from "../lib/keymaps";
import { label } from "../lib/labels";
import type { AppMode, Msg } from "../state/store";
import { useStore } from "../state/store";
import { Board } from "./Board";
import { ask, askText } from "./Confirm";
import { Dropdown } from "./Dropdown";
import { Help } from "./Help";
import { Modal } from "./Modal";
import { KeyEditor } from "./KeyEditor";
import { Menu } from "./Menu";
import { Notice } from "./Notice";
import { StudioPickCtx, type StudioPick } from "./Picker";
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

interface Port { port: string; name: string; serial: string }
interface Loaded {
  info: { name: string; serial: string };
  layers: StudioLayer[];
  /** Reserved layers the firmware can still turn on. */
  available: number;
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

// Board looks behaviors up in the keymap it is given; Studio bindings arrive
// already named, so there is nothing to resolve through.
const NO_KM = { behaviors: [], macros: [] };

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
    setKb({ info, layers: km.layers, available: km.available_layers,
            behaviors: behaviors.behaviors, layouts });
    setSaved(km.layers);
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

  const tabs: { l: StudioLayer; gone: boolean }[] = kb.layers.map((l) => ({ l, gone: false }));
  for (const r of [...removed].sort((a, b) => a.at - b.at))
    tabs.splice(Math.min(r.at, tabs.length), 0, { l: r.layer, gone: true });
  const shownTab = tabs[Math.min(li, tabs.length - 1)];
  const gone = !!shownTab?.gone;
  const layer = gone ? undefined : shownTab?.l;
  const text = (l: StudioLayer | undefined, pos: number) =>
    l?.bindings[pos] ? bindingText(l.bindings[pos], kb.behaviors, kb.layers) : "";
  const bindings = layer ? layer.bindings.map((_, i) => text(layer, i)) : [];
  const locked = !!lock && !lock.unlocked;

  const baseKm = byId(s.data.keymaps, base ?? matched?.id ?? "");
  const baseLayer = baseKm && !gone ? baseKm.layers[li] : null;
  const baseBindings = baseLayer && baseLayer.bindings.length === bindings.length
    ? baseLayer.bindings.map((t: string) => canonical(t, kb.behaviors, kb.layers)) : null;

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

  const why = (v: string) => {
    const b = parseBinding(v, kb.behaviors, kb.layers);
    return typeof b === "string" ? b : null;
  };

  // Sends each [position, text] to the shown layer; stops at the first refusal.
  const write = async (keys: [number, string][]) => {
    if (!layer) return false;
    const parsed: [number, string, StudioBinding][] = [];
    for (const [pos, v] of keys) {
      const b = parseBinding(v, kb.behaviors, kb.layers);
      if (typeof b === "string") { setMsg({ text: b, bad: true }); return false; }
      parsed.push([pos, v, b]);
    }
    let bs = layer.bindings;
    const marks = { ...pending[layer.id] };
    let ok = true;
    for (const [pos, v, b] of parsed) {
      try {
        await api("POST", "/api/studio/binding", { layer_id: layer.id, position: pos, ...b });
      } catch (e: any) {
        if (e.status === 409 || e.status === 410) { lost(e); return false; }
        if (/locked/.test(e.message)) setLock({ unlocked: false, unsaved: !!lock?.unsaved });
        setMsg({ text: e.message, bad: true });
        ok = false;
        break;
      }
      bs = bs.map((x, i) => i === pos ? b : x);
      if (v === text(saved.find((l) => l.id === layer.id), pos)) delete marks[pos];
      else marks[pos] = v;
    }
    setKb({ ...kb, layers: kb.layers.map((l) => l.id === layer.id ? { ...l, bindings: bs } : l) });
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

  const finish = async (what: "save" | "discard") => {
    setBusy(true);
    try {
      await api("POST", `/api/studio/${what}`);
      if (what === "discard") {
        const km = await api("GET", "/api/studio/keymap");
        setKb({ ...kb, layers: km.layers, available: km.available_layers });
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
        <span className="end"><button className="ghost" onClick={disconnect}>Disconnect</button></span>
      </div>
      {msg && <Notice msg={msg} close={() => setMsg(null)} />}
      {err && <div className="msg bad">{err}</div>}
      {locked &&
        <div className="warn">Locked. Editing needs the key bound to
          {" "}<code>&amp;studio_unlock</code>: press it on the keyboard. A keymap without
          one can be read here but not changed.</div>}
      {lock?.unsaved &&
        <div className="warn">The keyboard is using changes that are not saved: they are
          lost when it restarts unless you <b>Save to keyboard</b>.</div>}

      {baseKm && !gone && !baseBindings &&
        <div className="warn">comparison off for this layer: the keyboard and {baseKm.name}
          {" "}disagree on layer count or key count</div>}

      <div className="tabs">
        {tabs.map(({ l, gone: g }, i) => (
          <button key={l.id} className={[i === li && "sel", g && "gone"].filter(Boolean).join(" ")}
                  title={g ? "removed until you save; Discard or Restore layer brings it back"
                         : undefined}
                  onClick={() => { setLi(i); setEditing(null); }}>
            {i}&nbsp;&middot;&nbsp;{l.name || `layer ${i}`}
            {Object.keys(pending[l.id] || {}).length ? " *" : ""}
          </button>))}
        <Dropdown className="ghost sm" label="+ layer" items={[
          { label: <>Empty layer
                     {!kb.available && <small>no reserved layer left</small>}</>,
            disabled: locked || !kb.available, onPick: addLayer,
            title: !kb.available ? "The firmware has no reserved layer left. Add reserved "
              + "layers in Firmware mode, build and flash." : undefined },
          { label: <>Layer from another keyboard…<small>not in Studio yet</small></>,
            disabled: true, onPick: () => {} },
        ]} />
      </div>
      {shownTab &&
        <div className="boardopts">
          {lay && !gone &&
            <Toggle checked={s.nums} onChange={(on) => d({ t: "nums", on })}>
              key positions
            </Toggle>}
          <span className="end">
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
        ? <Board km={NO_KM} lay={lay} bindings={bindings}
                 baseBindings={baseBindings} assign={pending[layer.id] || {}} nums={s.nums}
                 hot={null} sel={[]} editing={editing} onKey={onKey} onSwap={onSwap} />
        : <p className="legend">The keyboard sent no physical layout to draw.</p>}

      <StudioPickCtx.Provider value={studioPick}>
        {editing !== null && <KeyEditor layer={layer} />}
        <Menu layer={layer} />
      </StudioPickCtx.Provider>

      {matching &&
        <MatchDialog device={kb.info.name} keymaps={s.data.keymaps}
                     pick={match} close={() => match("")} />}
    </main>
  );
}
