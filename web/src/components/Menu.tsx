// The first six tabs fill the binding field open above them; the last two are
// board-wide and fill nothing, so a separator sits between the sets.

import { menuFields, menuTarget, activeFieldOf, KEY_FIELD } from "../lib/fields";
import type { Mode } from "../lib/drafts";
import { useContext } from "react";

import { useStore } from "../state/store";
import { PickerBody, StudioPickCtx } from "./Picker";

const PTABS: [string, string][] = [
  ["keyboard","Keyboard"], ["system","Media & system"],
  ["viledance","VileDance"], ["macro","Macros"],
  ["modifier","Modifiers"], ["layer","Layers"],
  ["combo","Combos"], ["conditional","Conditional layers"],
];
const FIRST_BOARD_TAB = "combo";

// With the key editor open a pick is the assignment rather than a fill - say
// so, or the line promises an Apply step that never happens.
function targetText(editing: number | null, field: string | null,
                    label: string | undefined): string {
  if (editing !== null && field === KEY_FIELD) return `→ assigns key ${editing}`;
  if (label) return "→ fills " + label;
  return "→ nothing to fill: click a key on the board, or open a panel above";
}

export function Menu({ layer }: { layer: any }) {
  const { s, d } = useStore();
  const sp = useContext(StudioPickCtx);
  // A panel open in Studio with no key open fills the panel, as in Firmware mode.
  const panel = !!sp && !!s.emode && sp.editing === null;
  const t = sp && !panel ? { cur: sp.cur, exclude: [] as Mode[] } : menuTarget(s, layer);
  const tabs = PTABS.filter(([v]) => !t.exclude.includes(v as Mode));
  // Studio cannot add combos or conditional layers, so their tabs are dimmed there,
  // except combos on a keyboard with vile slots.
  const board = PTABS.slice(PTABS.findIndex(([v]) => v === FIRST_BOARD_TAB)).map(([v]) => v);
  const off = (v: string) => !!sp && board.includes(v) && !(v === "combo" && sp.slots);
  const ptab = t.exclude.includes(s.ptab as Mode) || off(s.ptab) ? "keyboard" : s.ptab;
  const field = sp && !panel ? KEY_FIELD : activeFieldOf(s);
  const label = menuFields(s).find((f) => f.key === field)?.label;
  const editing = sp && !panel ? sp.editing : s.editing;

  return (
    <div className="menu">
      <div className="tabs picktabs">
        {tabs.map(([v, l]) => (
          <span key={v} style={{ display: "contents" }}>
            {v === FIRST_BOARD_TAB && <span className="sep" />}
            <button className={ptab === v ? "sel" : ""} disabled={off(v)}
                    title={off(v) ? "Studio cannot add these to the keyboard. Switch them "
                      + "on in Firmware mode, build and flash." : undefined}
                    onClick={() => d({ t: "ptab", tab: v })}>{l}</button>
          </span>
        ))}
        <button className="ghost sm"
                onClick={() => d({ t: "picker", on: !s.picker })}>
          {s.picker ? "Hide" : "Show"}
        </button>
        <span className="ptarget">{!sp || panel || editing !== null ? targetText(editing, field, label)
                                   : "→ nothing to fill: click a key on the board"}</span>
      </div>
      <div className={"picker" + (s.picker ? "" : " hidden")}>
        <PickerBody cur={t.cur} ptab={ptab} />
      </div>
    </div>
  );
}
