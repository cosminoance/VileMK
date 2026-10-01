import { useStore } from "../state/store";

export function LayoutSelect({ km }: { km: any }) {
  const { s, d } = useStore();
  const at = Math.min(s.layout, km.layouts.length - 1);
  const lay = km.layouts[at];
  if (km.layouts.length < 2)
    return <span className="path">{lay.display || lay.label} &middot; {lay.count} keys</span>;
  const flag = km.layouts.some((l: any) => l.reordered);
  return (
    <select value={at} className={flag ? "flag" : undefined}
            onChange={(e) => d({ t: "layout", n: +e.target.value })}>
      {km.layouts.map((l: any, i: number) => (
        <option key={i} value={i}>
          {l.display || l.label} &middot; {l.count} keys
        </option>
      ))}
    </select>
  );
}

// Sits right under the bar holding LayoutSelect, which it refers to as "above".
export function LayoutOrderWarn({ km }: { km: any }) {
  const { s } = useStore();
  if (!km.layouts.some((l: any) => l.reordered)) return null;
  const lay = km.layouts[Math.min(s.layout, km.layouts.length - 1)];
  return (
    <div className="warn forsel">
      {lay.reordered
        ? <>This keyboard's layout file lists its keys in a different order than
            its wiring, so the board is drawn in wiring order, where the firmware
            puts each key. The layout menu above switches to the file's order.</>
        : <>This picture follows the keyboard's layout file, which lists keys in a
            different order than the wiring, so some keys are drawn in the wrong
            place. Pick <b>wiring order</b> in the layout menu above.</>}
    </div>
  );
}
