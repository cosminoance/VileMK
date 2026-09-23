import { useState } from "react";

import { bindsStudioUnlock, slugify } from "../lib/keymaps";
import { deleteVariant, saveVariant } from "../state/actions";
import { useStore } from "../state/store";
import { Help } from "./Help";
import { Toggle } from "./Toggle";

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
  const offered: any[] = km.parts || [];
  const parts: Record<string, boolean> = Object.fromEntries(
    offered.map((p) => [p.id, (s.parts[km.id] || {})[p.id] ?? p.on]));

  return <>
    <div className="bar">
      <span className="path">click a key to assign a VileDance or any binding</span>
      {!!dirty &&
        <span className="path">
          {n} pending change(s){nl ? `, ${nl} new layer(s)` : ""}
        </span>}
      {own &&
        <button className="act"
                onClick={() => saveVariant(s, d, km, km.name, name, resetOn, parts)}>
          Save to {km.name}
        </button>}
      <span className="path">save as</span>
      <input className="kb wide" value={name} autoComplete="off"
             placeholder="letters, digits, underscores"
             onChange={(e) => setName(e.target.value)} />
      <button className={own ? "ghost" : "act"}
              onClick={() => saveVariant(s, d, km, null, name, resetOn, parts)}>
        Save as new variant
      </button>
      {/* A keyboard ZMK Studio has written to ignores the compiled keymap at
          those key positions, on every boot, until the partition is wiped - and
          the keys that stick are the ones carrying a generated behavior, so the
          board looks almost right. Default this on when the keymap binds
          `&studio_unlock`, since that is the keymap that can hit it. */}
      <Toggle checked={resetOn} onChange={(on) => d({ t: "reset", on })}>
        include reset
      </Toggle>
      <Help label="what include reset does">
        Also builds a reset firmware for the keyboard. Flash it (to both halves
        on a split) before the actual reflash.
      </Help>
      {/* The vendor's build list covers every way the keyboard is sold, so
          it names parts this one may not have. Only the user knows. */}
      {!!offered.length && <>
        <span className="path">has</span>
        {offered.map((p) => (
          <Toggle key={p.id} checked={parts[p.id]}
                  onChange={(on) => d({ t: "part", kmId: km.id, id: p.id, on })}>
            {p.shield} <span className="path">{p.slot}</span>
          </Toggle>
        ))}
        <Help label="what the parts are">
          Add-ons the keyboard's maker lists for each half, such as a screen.
          Tick the ones your keyboard has. An unticked screen also turns the
          display off in the build.
        </Help>
      </>}
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
