import { useEffect, useRef } from "react";

import { byId } from "../lib/keymaps";
import { layersOf } from "../lib/layers";
import { tabForBinding } from "../lib/cards";
import { LIVE, draftOf, useStore } from "../state/store";
import { Board } from "./Board";
import { KeyEditor } from "./KeyEditor";
import { Menu } from "./Menu";
import { Panel } from "./Panels";
import { Tables } from "./Tables";
import { ExportBar } from "./Transfer";
import { VariantBar } from "./VariantBar";

export function KeymapView() {
  const { s, d } = useStore();
  const board = useRef<SVGSVGElement>(null);
  const km = byId(s.data.keymaps, s.id);
  if (!km) return <main><p>Pick a keyboard on the left.</p></main>;

  const live = LIVE(s);
  const lay = km.layouts[Math.min(s.layout, km.layouts.length - 1)];
  const allLayers = layersOf(km, s.newLayers[km.id], s.layout);
  // A pending layer that a save has just written and cleared leaves the index
  // past the end, and edits are filed by index - so clamp, and write the clamp
  // back so a click lands on the layer being shown.
  const li = Math.min(s.layer, Math.max(allLayers.length - 1, 0));
  const layer = allLayers[li];
  useEffect(() => { if (li !== s.layer) d({ t: "layer", n: li }); }, [li, s.layer, d]);

  // The board's `.pick` class mirrors the combo draft's positions.
  const sel = s.emode === "combo"
    ? (draftOf(s, "combo").key_positions || []).map(Number) : [];

  const base = s.base ? byId(s.data.keymaps, s.base) : null;
  const baseLayer = base && base.layers[li];
  const baseBindings =
    baseLayer && baseLayer.bindings.length === (layer ? layer.bindings.length : 0)
      ? baseLayer.bindings : null;

  const addLayer = () => {
    const n = allLayers.length;
    const name = (prompt("Layer name", `layer_${n}`) || "").trim();
    if (!name) return;
    d({ t: "addLayer", kmId: km.id, name, at: n });
  };

  // While a combo is being drafted the board *is* the chord picker; every other
  // time, clicking a key opens that key's editor.
  const onKey = !live ? null : (pos: number) => {
    if (s.emode === "combo")
      return d({ t: "draft", mode: "combo", draft: (prev: any) => {
        const list = new Set<number>((prev.key_positions || []).map(Number));
        list.has(pos) ? list.delete(pos) : list.add(pos);
        return { ...prev, key_positions: [...list].sort((a, b) => a - b) };
      } });
    // The menu follows the key: whatever this one holds, open the tab that
    // holds it back. A pending edit wins over the file, same as the editor
    // itself reads it.
    const cur = (s.assign[li] || {})[pos] ?? (layer ? layer.bindings[pos] : "");
    d({ t: "editKey", pos, cur: String(cur ?? ""),
        ptab: tabForBinding(String(cur ?? ""), s.store) });
  };

  return (
    <main>
      <div className="bar">
        <h2>{km.name}</h2><span className="path">{km.path}</span>
      </div>

      <div className="bar">
        {km.layouts.length > 1
          ? <select value={s.layout}
                    onChange={(e) => d({ t: "layout", n: +e.target.value })}>
              {km.layouts.map((l: any, i: number) => (
                <option key={i} value={i}>
                  {l.display || l.label} &middot; {l.count} keys
                </option>
              ))}
            </select>
          : <span className="path">
              {lay.display || lay.label} &middot; {lay.count} keys
            </span>}
        <select value={s.base} onChange={(e) => d({ t: "base", id: e.target.value })}>
          <option value="">compare with… (off)</option>
          {s.data.keymaps.filter((k: any) => k.id !== km.id).map((k: any) => (
            <option key={k.id} value={k.id}>{k.kind}: {k.path}</option>
          ))}
        </select>
        <label className="toggle">
          <input type="checkbox" checked={s.nums}
                 onChange={(e) => d({ t: "nums", on: e.target.checked })} />
          {" "}key positions
        </label>
        <ExportBar km={km} board={board} />
      </div>

      {live && <VariantBar key={km.id} km={km} />}

      {km.warnings.map((w: string, i: number) => (
        <div className="warn" key={i}>{w}</div>
      ))}
      {s.base && !baseBindings &&
        <div className="warn">comparison off for this layer: the two keymaps
          disagree on layer count or key count</div>}

      <div className="tabs">
        {allLayers.map((l, i) => (
          <button key={i} className={i === li ? "sel" : ""}
                  title={l.pending ? "not saved yet - Save as variant to write it"
                                   : undefined}
                  onClick={() => d({ t: "layer", n: i })}>
            {i}&nbsp;&middot;&nbsp;{l.display}{l.pending ? " *" : ""}
          </button>
        ))}
        {live && allLayers.length < 32 &&
          <button className="ghost sm" onClick={addLayer}>+ layer</button>}
      </div>

      {!layer || layer.reserved
        ? <p className="legend">
            This layer is <code>status = "reserved"</code>: empty here, available
            to fill in from ZMK Studio.
          </p>
        : <>
            {lay.approximate &&
              <div className="legend">
                No <code>zmk,physical-layout</code> for this keyboard; keys are
                drawn on a plain grid, but the numbers are still the real key
                positions.
              </div>}
            <Board km={km} lay={lay} bindings={layer.bindings}
                   baseBindings={baseBindings} assign={s.assign[li] || {}}
                   nums={s.nums} hot={s.hot} sel={sel} editing={s.editing}
                   onKey={onKey} svgRef={board} />
          </>}

      {/* The editor area holds a key's editor, a creation panel, or nothing.
          The menu below it is always there: the board-wide tabs have nothing to
          do with whichever of the three is open. */}
      {live && <>
        {s.editing !== null
          ? <KeyEditor layer={layer} />
          : s.emode &&
            <>
              <div className="editor" style={{ marginBottom: 16 }}>
                <Panel mode={s.emode} km={km} />
              </div>
              {s.dts && <pre className="dts">{s.dts}</pre>}
            </>}
        <Menu layer={layer} />
      </>}

      <Tables km={km} />
    </main>
  );
}
