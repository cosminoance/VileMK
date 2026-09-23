// The first six tabs fill the binding field open above them; the last two are
// board-wide and fill nothing, so a separator sits between the sets.

import { menuFields, menuTarget, activeFieldOf, KEY_FIELD } from "../lib/fields";
import type { Mode } from "../lib/drafts";
import { useStore } from "../state/store";
import { PickerBody } from "./Picker";

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
  const t = menuTarget(s, layer);
  const tabs = PTABS.filter(([v]) => !t.exclude.includes(v as Mode));
  const ptab = t.exclude.includes(s.ptab as Mode) ? "keyboard" : s.ptab;
  const field = activeFieldOf(s);
  const label = menuFields(s).find((f) => f.key === field)?.label;

  return (
    <div className="menu">
      <div className="tabs picktabs">
        {tabs.map(([v, l]) => (
          <span key={v} style={{ display: "contents" }}>
            {v === FIRST_BOARD_TAB && <span className="sep" />}
            <button className={ptab === v ? "sel" : ""}
                    onClick={() => d({ t: "ptab", tab: v })}>{l}</button>
          </span>
        ))}
        <button className="ghost sm"
                onClick={() => d({ t: "picker", on: !s.picker })}>
          {s.picker ? "Hide" : "Show"}
        </button>
        <span className="ptarget">{targetText(s.editing, field, label)}</span>
      </div>
      <div className={"picker" + (s.picker ? "" : " hidden")}>
        <PickerBody cur={t.cur} ptab={ptab} />
      </div>
    </div>
  );
}
