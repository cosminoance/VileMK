import { useEffect, useRef, useState } from "react";

import { buildChoices, choicesChanged, slugify } from "../lib/keymaps";
import { layersOf } from "../lib/layers";
import { deleteVariant, saveVariant } from "../state/actions";
import { reducer, useStore, type Action, type State } from "../state/store";
import { BuildPanel } from "./Build";
import { Dropdown } from "./Dropdown";
import { Modal } from "./Modal";
import { Notice } from "./Notice";

export function VariantBar({ km }: { km: any }) {
  const { s, d } = useStore();
  // Only `variants/` is ours to write. A config or vendor keymap can be saved
  // *from*, never over - so "Overwrite" exists for a variant and nothing else.
  const own = km.kind === "variant";
  const [asking, setAsking] = useState(false);

  const n = Object.values(s.assign)
    .reduce((a, o) => a + Object.keys(o).length, 0);
  const nl = (s.newLayers[km.id] || []).length;
  const dirty = n || nl;
  const { reset, parts } = buildChoices(s, km);
  // Text typed into the key editor but not applied goes into the save, as Enter
  // would have put it there. Blank text, or what the key already holds, does not.
  const withKey = (): State => {
    if (s.editing === null) return s;
    const v = s.keyVal.trim();
    const cur = (s.assign[s.layer] || {})[s.editing]
      ?? layersOf(km, s.newLayers[km.id], s.layout)[s.layer]?.bindings[s.editing];
    if (!v || v === String(cur ?? "").trim()) return s;
    const a: Action = { t: "assign", pos: s.editing, v, close: true, msg: null };
    d(a);
    return reducer(s, a);
  };
  const save = (over: string | null, typed: string, st = withKey()) =>
    saveVariant(st, d, km, over, typed, reset, parts);

  // Ctrl/Cmd+S: Overwrite on a variant, Save as… elsewhere. Not while a sheet
  // is open, since it may be one that saves on Enter, or not about saving.
  const saving = useRef(false);
  const quick = useRef(() => {});
  quick.current = async () => {
    if (saving.current || document.querySelector(".modal")) return;
    if (!own) return setAsking(true);
    const st = withKey();
    if (!Object.keys(st.assign).length && !nl && !choicesChanged(st, km))
      return d({ t: "msg", msg: { text: "nothing to save" } });
    saving.current = true;
    await save(km.name, km.name, st);
    saving.current = false;
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey
          || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      quick.current();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);

  return <>
    <div className="bar">
      <span className="path">click a key to assign a VileDance or any binding</span>
      {!!dirty &&
        <span className="path">
          {n} pending change(s){nl ? `, ${nl} new layer(s)` : ""}
        </span>}
      {own
        ? <Dropdown label="Save" items={[
            { label: <>Overwrite {km.name}</>, title: "Ctrl+S",
              onPick: () => save(km.name, km.name) },
            { label: "Save as…", onPick: () => setAsking(true) },
          ]} />
        : <button className="act" title="Ctrl+S" onClick={() => setAsking(true)}>Save as{"…"}</button>}
      {!!dirty &&
        <button className="ghost"
                onClick={() => d({ t: "clearAssign", kmId: km.id })}>Discard</button>}
      {own &&
        <button className="ghost danger"
                onClick={() => deleteVariant(s, d, km)}>Delete variant</button>}
    </div>
    <BuildPanel km={km} dirty={n + nl} />
    {s.msg && <Notice msg={s.msg} close={() => d({ t: "msg", msg: null })} />}
    {asking &&
      <SaveAsSheet start={slugify(km.name) + (own ? "_2" : "_custom")} from={km.name}
                   save={(name) => save(null, name)} close={() => setAsking(false)} />}
  </>;
}

function SaveAsSheet({ start, from, save, close }:
    { start: string; from: string; save: (name: string) => Promise<boolean>;
      close: () => void }) {
  const { s } = useStore();
  const [name, setName] = useState(start);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const go = async () => {
    setBusy(true);
    const ok = await save(name);
    setBusy(false);
    setTried(true);
    if (ok) close();
  };
  return (
    <Modal onClose={busy ? undefined : close} className="saveas"
           onKeyDown={(e) => { if (e.key === "Escape" && !busy) close(); }}>
      <div className="bar">
        <h2>Save as a new variant</h2>
        <span className="path">from {from}</span>
      </div>
      <div className="bar">
        <span className="path">variants/</span>
        <input className="kb wide" value={name} autoFocus autoComplete="off"
               placeholder="letters, digits, underscores"
               onChange={(e) => setName(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter" && !busy) go(); }} />
      </div>
      {tried && s.msg?.bad && <div className="msg bad">{s.msg.text}</div>}
      <div className="rowbtns">
        <button className="act" disabled={busy || !name.trim()} onClick={go}>Save</button>
        <button className="ghost" disabled={busy} onClick={close}>Cancel</button>
      </div>
    </Modal>
  );
}
