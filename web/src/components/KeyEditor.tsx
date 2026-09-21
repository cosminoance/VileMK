import { useEffect, useRef } from "react";

import { label } from "../lib/labels";
import { KEY_FIELD } from "../lib/fields";
import { useStore } from "../state/store";

export function KeyEditor({ layer }: { layer: any }) {
  const { s, d } = useStore();
  const pos = s.editing!;
  const el = useRef<HTMLInputElement>(null);
  // Clicking a second key reuses this component, so the caret has to be moved
  // again rather than arriving with a fresh mount.
  useEffect(() => { el.current?.focus(); }, [pos]);

  const orig = layer ? layer.bindings[pos] : "";
  const apply = () => d({ t: "assign", pos, v: s.keyVal, close: true, msg: null });

  return (
    <div className="panel" style={{ margin: "0 0 16px" }}>
      <h3>Key {pos} &middot; layer {s.layer} &middot; now <code>{orig || ""}</code></h3>
      <div className="slot">
        <span>Binding</span>
        <input className="kb wide" ref={el} value={s.keyVal} autoComplete="off"
               onFocus={() => d({ t: "field", key: KEY_FIELD })}
               onChange={(e) => d({ t: "keyVal", v: e.target.value })}
               onKeyDown={(e) => {
                 if (e.key === "Enter") apply();
                 if (e.key === "Escape") d({ t: "closeKey" });
               }} />
      </div>
      <div className="rowbtns">
        <button className="act" onClick={apply}>Apply</button>
        <button className="ghost"
                onClick={() => d({ t: "assign", pos, v: "", close: true })}>
          Reset to {label(orig || "")}
        </button>
        <button className="ghost" onClick={() => d({ t: "closeKey" })}>Cancel</button>
      </div>
      <div className="hint">
        Pick from the menu below - a key, a saved VileDance, a macro, a modifier
        or a layer - and it is assigned straight away, no Apply. Or type any ZMK
        binding here - <code>&amp;kp A</code>, <code>&amp;mo 2</code>,{" "}
        <code>&amp;none</code> - and press Apply or Enter. Either way nothing
        touches disk until you save a variant.
      </div>
    </div>
  );
}
