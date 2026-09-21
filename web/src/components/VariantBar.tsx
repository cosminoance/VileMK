import { useState } from "react";

import { bindsStudioUnlock, slugify } from "../lib/keymaps";
import { deleteVariant, saveVariant } from "../state/actions";
import { useStore } from "../state/store";

export function VariantBar({ km }: { km: any }) {
  const { s, d } = useStore();
  // Only `variants/` is ours to write. A config or vendor keymap can be saved
  // *from*, never over - so "Save here" exists for a variant and nothing else.
  const own = km.kind === "variant";
  const [name, setName] = useState(slugify(km.name) + (own ? "_2" : "_custom"));

  const n = Object.values(s.assign)
    .reduce((a, o) => a + Object.keys(o).length, 0);
  const nl = (s.newLayers[km.id] || []).length;
  const dirty = n || nl;
  const resetOn = s.reset === null ? bindsStudioUnlock(km) : s.reset;

  return <>
    <div className="bar">
      <span className="path">click a key to assign a VileDance or any binding</span>
      {!!dirty &&
        <span className="path">
          {n} pending change(s){nl ? `, ${nl} new layer(s)` : ""}
        </span>}
      {own &&
        <button className="act"
                onClick={() => saveVariant(s, d, km, km.name, name, resetOn)}>
          Save to {km.name}
        </button>}
      <span className="path">save as</span>
      <input className="kb wide" value={name} autoComplete="off"
             placeholder="letters, digits, underscores"
             onChange={(e) => setName(e.target.value)} />
      <button className={own ? "ghost" : "act"}
              onClick={() => saveVariant(s, d, km, null, name, resetOn)}>
        Save as new variant
      </button>
      {/* A keyboard ZMK Studio has written to ignores the compiled keymap at
          those key positions, on every boot, until the partition is wiped - and
          the keys that stick are the ones carrying a generated behavior, so the
          board looks almost right. Default this on when the keymap binds
          `&studio_unlock`, since that is the keymap that can hit it. */}
      <label className="toggle"
             title={"adds a settings_reset build per board - flash it to wipe a "
                  + "keymap ZMK Studio stored in flash, then reflash"}>
        <input type="checkbox" checked={resetOn}
               onChange={(e) => d({ t: "reset", on: e.target.checked })} />
        {" "}include reset
      </label>
      {!!dirty &&
        <button className="ghost"
                onClick={() => d({ t: "clearAssign", kmId: km.id })}>Discard</button>}
      {own &&
        <button className="ghost danger"
                onClick={() => deleteVariant(s, d, km)}>Delete variant</button>}
    </div>
    {s.msg &&
      <div className={"msg " + (s.msg.bad ? "bad" : "ok")}>{s.msg.text}</div>}
  </>;
}
