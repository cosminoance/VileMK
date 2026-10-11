import { useContext, useEffect, useRef } from "react";

import { label } from "../lib/labels";
import { KEY_FIELD } from "../lib/fields";
import { useStore } from "../state/store";
import { StudioPickCtx } from "./Picker";

export function KeyEditor({ layer }: { layer: any }) {
  const { s, d } = useStore();
  const sp = useContext(StudioPickCtx);
  const pos = sp ? sp.editing! : s.editing!;
  const val = sp ? sp.cur : s.keyVal;
  const el = useRef<HTMLInputElement>(null);
  // Clicking a second key reuses this component, so the caret has to be moved
  // again rather than arriving with a fresh mount.
  useEffect(() => { el.current?.focus(); }, [pos]);

  // In Studio, Reset puts back what the keyboard held at its last save.
  const orig = sp ? sp.saved : layer ? layer.bindings[pos] : "";
  const apply = sp ? () => sp.pick(val)
    : () => d({ t: "assign", pos, v: val, close: true, msg: null });
  const close = sp ? sp.close : () => d({ t: "closeKey" });

  return (
    <div className="panel" style={{ margin: "0 0 16px" }}>
      <h3>Key {pos} &middot; layer {sp ? sp.layer : s.layer} &middot; now <code>{orig || ""}</code></h3>
      <div className="slot">
        <span>Binding</span>
        <input className="kb wide" ref={el} value={val} autoComplete="off"
               onFocus={() => sp || d({ t: "field", key: KEY_FIELD })}
               onChange={(e) => sp ? sp.setField(e.target.value)
                                   : d({ t: "keyVal", v: e.target.value })}
               onKeyDown={(e) => {
                 if (e.key === "Enter") apply();
                 if (e.key === "Escape") close();
               }} />
      </div>
      <div className="rowbtns">
        <button className="act" onClick={apply}>Apply</button>
        <button className="ghost"
                onClick={() => sp ? sp.pick(orig)
                                  : d({ t: "assign", pos, v: "", close: true })}>
          Reset to {label(orig || "")}
        </button>
        <button className="ghost" onClick={close}>Cancel</button>
      </div>
      <div className="hint">
        Pick from the menu below - a key, a saved VileDance, a macro, a modifier
        or a layer - and it is assigned straight away, no Apply. Or type any ZMK
        binding here - <code>&amp;kp A</code>, <code>&amp;mo 2</code>,{" "}
        <code>&amp;none</code> - and press Apply or Enter.{" "}
        {sp ? <>Either way it goes to the keyboard straight away; <b>Save to
                keyboard</b> keeps it across a restart.</>
            : <>Either way nothing touches disk until you save a variant.</>}
      </div>
    </div>
  );
}
