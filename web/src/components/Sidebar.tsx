import { useState } from "react";

import { openImport } from "../state/actions";
import { LIVE, useStore } from "../state/store";
import { KeymapMenu } from "./KeymapMenu";
import { KeyboardsButton } from "./Keyboards";
import { ImportButton } from "./Transfer";

const KINDS: Record<string, string> = {
  variant: "Saved variations",
  vendor: "Vendor defaults",
};

/** A keymap with a `parent` (a module's `config/` keymap) goes right under
 *  that keyboard's own keymap, one level in; with its parent filtered out it
 *  stands alone. */
function tree(rows: any[]) {
  const shown = new Set(rows.map((k) => k.id));
  const out: any[] = [];
  for (const k of rows) {
    if (k.parent && shown.has(k.parent)) continue;
    out.push(k);
    for (const c of rows)
      if (c.parent === k.id) out.push({ ...c, child: true });
  }
  return out;
}

export function Sidebar() {
  const { s, d } = useStore();
  const [over, setOver] = useState(false);
  const q = s.filter.toLowerCase();
  const groups = (["variant", "vendor"] as const)
    .map((kind) => ({
      kind,
      rows: tree(s.data.keymaps.filter((k: any) => k.kind === kind &&
        (k.name.toLowerCase().includes(q) || k.path.toLowerCase().includes(q)))),
    }))
    .filter((g) => g.rows.length);

  const drop = !LIVE(s) ? {} : {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setOver(true); },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      const f = e.dataTransfer.files[0];
      if (f) openImport(d, f);
    },
  };

  return (<>
    <aside id="kblist" className={over ? "dropping" : ""} {...drop}>
      <input placeholder="filter keyboards…" autoComplete="off" value={s.filter}
             onChange={(e) => d({ t: "filter", v: e.target.value })} />
      {LIVE(s) && <><KeyboardsButton /><ImportButton /></>}
      <div>
        {groups.length
          ? groups.map((g) => (
              <div key={g.kind}>
                <div className="group">{KINDS[g.kind]}</div>
                {/* The row is a pair: the name selects, the settings menu beside
                    it exports or deletes without opening the keymap. */}
                {g.rows.map((k: any) => (
                  <div key={k.id}
                       className={"kbrow" + (k.child ? " child" : "")
                                  + (k.id === s.id ? " sel" : "")}>
                    <button className={k.id === s.id ? "sel" : ""}
                            onClick={() => d({ t: "select", id: k.id })}>
                      {k.name}<small title={k.path}>{k.note ? k.note + " · " : ""}{k.path}</small>
                    </button>
                    <KeymapMenu km={k} />
                  </div>
                ))}
              </div>
            ))
          : <div className="group">no matches</div>}
      </div>
    </aside>
    {/* The handle sits on the panel's own border rather than in the header, so
        it reads as belonging to the panel. It is outside `aside` because the
        collapsed state hides `aside`, and the handle is what brings it back. */}
    <button className="railtab" onClick={() => d({ t: "rail", on: !s.rail })}
            aria-expanded={s.rail} aria-controls="kblist"
            title={s.rail ? "Hide the keyboard list" : "Show the keyboard list"}>
      {s.rail ? "\u2039" : "\u203a"}
    </button>
  </>);
}
