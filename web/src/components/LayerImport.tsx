import { useState } from "react";

import { recordLabels } from "../lib/cards";
import { keyCount, slugify } from "../lib/keymaps";
import { label } from "../lib/labels";
import { fitLayer, layersOf, namesLayer } from "../lib/layers";
import { useStore } from "../state/store";
import { Board } from "./Board";
import { askText } from "./Confirm";
import { Dropdown } from "./Dropdown";
import { Help } from "./Help";
import { Modal } from "./Modal";

/** `+ layer` after the layer tabs: an empty layer, or a copy of one from a
 *  saved variation. Either is pending until the variant is saved. */
export function AddLayerButton({ km }: { km: any }) {
  const { s, d } = useStore();
  const [importing, setImporting] = useState(false);
  const at = layersOf(km, s.newLayers[km.id], s.layout).length;
  const none = !donors(s.data.keymaps, km).length;

  const empty = async () => {
    const name = await askText({ title: "New layer", ok: "Add layer",
      field: { value: `layer_${at}`, placeholder: "layer name" } });
    if (name) d({ t: "addLayer", kmId: km.id, name, at });
  };

  return <>
    <Dropdown className="ghost sm" label="+ layer" items={[
      { label: "Empty layer", onPick: empty },
      { label: <>Layer from another keyboard…
                 {none && <small>no saved variations yet</small>}</>,
        disabled: none, onPick: () => setImporting(true) },
    ]} />
    {importing && <LayerImportDialog km={km} at={at}
                                     close={() => setImporting(false)} />}
  </>;
}

/** The saved variations a layer can be copied from: every one but `km`. */
const donors = (keymaps: any[], km: any): any[] =>
  keymaps.filter((k) => k.kind === "variant" && k.id !== km.id);

/** Labels a keymap's own file defines: its hand-written behaviors and macros,
 *  plus whatever its generated block holds. */
const defined = (km: any): Set<string> =>
  new Set([...(km.behaviors || []), ...(km.macros || [])].map((b: any) => b.label));

function LayerImportDialog({ km, at, close }:
    { km: any; at: number; close: () => void }) {
  const { s, d } = useStore();
  const [q, setQ] = useState("");
  const [srcId, setSrcId] = useState<string | null>(null);
  const [li, setLi] = useState(0);
  const [typed, setTyped] = useState<string | null>(null);

  const all = donors(s.data.keymaps, km);
  const needle = q.trim().toLowerCase();
  const shown = all.filter((k) => !needle
    || k.name.toLowerCase().includes(needle)
    || String(k.keyboard || "").toLowerCase().includes(needle));
  const src = all.find((k) => k.id === srcId) || null;
  const layer = src?.layers[li];

  const pick = (k: any) => {
    setSrcId(k.id);
    setLi(Math.max(0, k.layers.findIndex((l: any) => !l.reserved)));
    setTyped(null);
  };

  const n = keyCount(km);
  const fit = layer ? fitLayer(layer.bindings, n) : null;
  const taken = new Set(layersOf(km, s.newLayers[km.id], s.layout)
    .map((l) => slugify(l.name || l.display)));
  const free = (base: string) => {
    let name = base, i = 2;
    while (taken.has(slugify(name))) name = `${base}_${i++}`;
    return name;
  };
  const name = typed ?? (layer ? free(layer.name || layer.display) : "");
  const clash = !!name.trim() && taken.has(slugify(name));
  const numbered = !!layer?.bindings.some(namesLayer);
  const theirs = src ? defined(src) : new Set<string>();
  const ours = defined(km), made = recordLabels(s.store);
  const strays = layer ? [...new Set<string>(layer.bindings.map((b: string) =>
    b.trim().split(/\s+/)[0].replace(/^&/, "")))]
    .filter((l) => theirs.has(l) && !ours.has(l) && !made.has(l)) : [];

  const run = () => {
    d({ t: "addLayer", kmId: km.id, name: name.trim(), at, assign: fit!.set });
    d({ t: "msg", msg: { text: `added layer ${at} from ${src!.name}; `
                                + "Save to write it" } });
    close();
  };

  return (
    <Modal onClose={close} className="layerimport">
      <div className="bar">
        <h2>Layer from another keyboard</h2>
        <span className="path">becomes layer {at} of {km.name}</span>
      </div>

      <div className="bar">
        <input className="kb wide" autoComplete="off" autoFocus
               placeholder="search variations or keyboards" value={q}
               onChange={(e) => setQ(e.target.value)} />
        <Help label="how a layer is copied">
          Key 0 of the layer goes on key 0 here, key 1 on key 1, and so on. Each
          keyboard numbers its keys by its own layout, so a key can land
          somewhere else on the board. Keys the layer does not cover stay
          transparent. The VileDances, macros and layer entries it uses come
          along when you save.
        </Help>
      </div>
      <div className="items">
        {shown.map((k) =>
          <button key={k.id} className={k.id === srcId ? "sel" : ""}
                  onClick={() => pick(k)}>
            {k.name}
            <small>{k.keyboard} · {keyCount(k)} keys · {k.layers.length} layers</small>
          </button>)}
        {!shown.length && <p className="legend">No saved variation matches.</p>}
      </div>

      {src && <>
        <div className="tabs picktabs">
          {src.layers.map((l: any, i: number) =>
            <button key={i} className={i === li ? "sel" : ""} disabled={l.reserved}
                    title={l.reserved ? "reserved: nothing to copy" : undefined}
                    onClick={() => { setLi(i); setTyped(null); }}>
              {i}&nbsp;&middot;&nbsp;{l.display}
            </button>)}
        </div>
        {layer && !layer.reserved && <>
          <Board km={src} lay={src.layouts[0]} bindings={layer.bindings}
                 baseBindings={null} assign={{}} nums={s.nums} hot={null} sel={[]}
                 editing={null} onKey={null} />
          <Fit src={src} n={n} dropped={fit!.dropped} />
          {numbered &&
            <p className="legend">
              Layer keys keep their numbers: <code>&amp;mo 2</code> on this layer
              switches to layer 2 of {km.name}.
            </p>}
          {!!strays.length &&
            <div className="warn">
              {strays.map((l) => `&${l}`).join(", ")} {strays.length === 1
                ? "is" : "are"} defined only in {src.name}'s file. Keys bound to
              {strays.length === 1 ? " it" : " them"} will not build here until
              you rebind them.
            </div>}
        </>}
      </>}

      <label className="bar">
        <span className="path">name</span>
        <input className="kb wide" autoComplete="off" value={name}
               disabled={!layer} onChange={(e) => setTyped(e.target.value)} />
        {clash && <span className="path">this keymap already has that layer</span>}
      </label>

      <div className="rowbtns">
        <button className="act" onClick={run}
                disabled={!layer || layer.reserved || !name.trim() || clash}>
          Import
        </button>
        <button className="ghost" onClick={close}>Cancel</button>
      </div>
    </Modal>
  );
}

/** How the layer's keys meet this keyboard's, and what has no key here. */
function Fit({ src, n, dropped }:
    { src: any; n: number; dropped: { pos: number; binding: string }[] }) {
  const sn = keyCount(src);
  return (
    <p className="legend">
      {sn === n
        ? <>Both keyboards have {n} keys; every key lands on the same number.</>
        : sn < n
        ? <>{src.name} has {sn} keys, this keyboard {n}: keys {sn}–{n - 1} stay
            transparent.</>
        : !dropped.length
        ? <>{src.name} has {sn} keys, this keyboard {n}. Keys {n}–{sn - 1} are
            empty on this layer, so nothing is lost.</>
        : <>{src.name} has {sn} keys, this keyboard {n}. These have no key here
            and are left out:{" "}
            {dropped.map((x) =>
              <span key={x.pos} className="lidrop" title={x.binding}>
                {x.pos} <code>{label(x.binding)}</code>
              </span>)}
          </>}
    </p>
  );
}
