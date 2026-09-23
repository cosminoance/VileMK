import { resolveBinding, usageOf } from "../lib/labels";
import { useStore } from "../state/store";

export function Tables({ km }: { km: any }) {
  const { s, d } = useStore();
  const hot = (keys: number[] | null) => ({
    onMouseEnter: () => d({ t: "hot", keys }),
    onMouseLeave: () => d({ t: "hot", keys: null }),
  });

  return (
    <div className="cols">
      {!!km.combos.length &&
        <section className="card">
          <h3>Combos</h3>
          <table><tbody>
            <tr><th>name</th><th>keys</th><th>sends</th><th>ms</th><th>layers</th></tr>
            {km.combos.map((c: any, i: number) => (
              <tr key={i} className="combo" {...hot(c.positions)}>
                <td>{c.name}</td>
                <td className="mono">{c.positions.join(" ")}</td>
                <td className="mono">{c.bindings}</td>
                <td>{c.timeout ?? ""}</td>
                <td>{c.layers.length ? c.layers.join(" ") : "all"}</td>
              </tr>
            ))}
          </tbody></table>
        </section>}

      {!!km.behaviors.length &&
        <section className="card">
          <h3>Behaviors</h3>
          <table><tbody>
            <tr><th>&amp;label</th><th>type</th><th>sends</th></tr>
            {km.behaviors.map((b: any) => {
              const use = usageOf(km, b.label);
              const res = use ? resolveBinding(km, use.binding, 3) : null;
              // With a key to read the parameters off, show what it sends;
              // without one, the node's own `bindings` is all there is to show,
              // and it is worth saying why that reads as `&kp, &kp`.
              const sends = res ? res.full : b.bindings.join(", ");
              // A hold-tap or a mod-morph declares `bindings = <&kp>, <&kp>;`
              // and takes its keys from the key - so when no key uses it there
              // is genuinely nothing more to show, and that is worth saying.
              // Every other kind carries its own complete bindings.
              const note = use
                ? `${use.binding} · key ${use.pos}, layer ${use.layer}`
                : b.kind === "hold-tap" || b.kind === "mod-morph"
                  ? "on no key here – its keys come from the key it is put on"
                  : b.kind === "sensor-rotate" ? "on an encoder, not a key"
                  : "on no key here";
              const props = Object.entries(b.props)
                .map(([k, v]) => k + "=" + v).join("  ");
              // The highlight only means something while that key's own layer
              // is the one on screen.
              const rowHot = use && use.layer === s.layer ? hot([use.pos]) : {};
              return (
                <tr key={b.label} className={use ? "usedby" : undefined} {...rowHot}>
                  <td className="mono">&amp;{b.label}</td>
                  <td>{b.kind}</td>
                  <td className="mono">
                    {sends.split("\n").map((l: string, i: number) => (
                      <span key={i}>{i ? <br /> : null}{l}</span>
                    ))}
                    <br /><span style={{ color: "var(--muted)" }}>{note}</span>
                    {!!props.length && <>
                      <br /><span style={{ color: "var(--muted)" }}>{props}</span>
                    </>}
                  </td>
                </tr>
              );
            })}
          </tbody></table>
        </section>}

      {!!km.macros.length &&
        <section className="card">
          <h3>Macros</h3>
          <table><tbody>
            <tr><th>&amp;label</th><th>type</th><th>bindings</th></tr>
            {km.macros.map((b: any) => (
              <tr key={b.label}>
                <td className="mono">&amp;{b.label}</td>
                <td>{b.kind}</td>
                <td className="mono">{b.bindings.join(" ")}</td>
              </tr>
            ))}
          </tbody></table>
        </section>}
    </div>
  );
}
