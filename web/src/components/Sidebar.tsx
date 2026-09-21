import { useStore } from "../state/store";

const KINDS: Record<string, string> = {
  config: "In this config",
  variant: "Saved variations",
  vendor: "Vendor defaults",
};

export function Sidebar() {
  const { s, d } = useStore();
  const q = s.filter.toLowerCase();
  const groups = (["config", "variant", "vendor"] as const)
    .map((kind) => ({
      kind,
      rows: s.data.keymaps.filter((k: any) => k.kind === kind &&
        (k.name.toLowerCase().includes(q) || k.path.toLowerCase().includes(q))),
    }))
    .filter((g) => g.rows.length);

  return (
    <aside>
      <input placeholder="filter keyboards…" autoComplete="off" value={s.filter}
             onChange={(e) => d({ t: "filter", v: e.target.value })} />
      <div>
        {groups.length
          ? groups.map((g) => (
              <div key={g.kind}>
                <div className="group">{KINDS[g.kind]}</div>
                {g.rows.map((k: any) => (
                  <button key={k.id} className={k.id === s.id ? "sel" : ""}
                          onClick={() => d({ t: "select", id: k.id })}>
                    {k.name}<small>{k.path}</small>
                  </button>
                ))}
              </div>
            ))
          : <div className="group">no matches</div>}
      </div>
    </aside>
  );
}
