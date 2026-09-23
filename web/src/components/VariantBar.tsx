import { useState } from "react";

import { slugify } from "../lib/keymaps";
import { deleteVariant, saveVariant } from "../state/actions";
import { useStore } from "../state/store";
import { BuildPanel, buildChoices } from "./Build";
import { Dropdown } from "./Dropdown";

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
  const save = (over: string | null, typed: string) =>
    saveVariant(s, d, km, over, typed, reset, parts);

  return <>
    <div className="bar">
      <span className="path">click a key to assign a VileDance or any binding</span>
      {!!dirty &&
        <span className="path">
          {n} pending change(s){nl ? `, ${nl} new layer(s)` : ""}
        </span>}
      {own
        ? <Dropdown label="Save" items={[
            { label: <>Overwrite {km.name}</>, onPick: () => save(km.name, km.name) },
            { label: "Save as…", onPick: () => setAsking(true) },
          ]} />
        : <button className="act" onClick={() => setAsking(true)}>Save as{"…"}</button>}
      {!!dirty &&
        <button className="ghost"
                onClick={() => d({ t: "clearAssign", kmId: km.id })}>Discard</button>}
      {own &&
        <button className="ghost danger"
                onClick={() => deleteVariant(s, d, km)}>Delete variant</button>}
    </div>
    <BuildPanel km={km} dirty={n + nl} />
    {s.msg &&
      <div className={"msg " + (s.msg.bad ? "bad" : "ok")}>{s.msg.text}</div>}
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
    <div className="modal" onClick={busy ? undefined : close}>
      <div className="sheet saveas" onClick={(e) => e.stopPropagation()}
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
      </div>
    </div>
  );
}
