import { useState } from "react";

import { deleteVariant, deleteVendor } from "../state/actions";
import { LIVE, useStore } from "../state/store";
import { Dropdown, type DropItem } from "./Dropdown";
import { ExportDialog } from "./Export";
import { GearIcon } from "./Icons";

/** The settings button beside a sidebar row: export as a picture, and delete
 *  for a variant or a vendor keyboard. A read-only page offers export only. */
export function KeymapMenu({ km }: { km: any }) {
  const { s, d } = useStore();
  const [exporting, setExporting] = useState(false);
  const items: DropItem[] = [
    { label: "Export as picture", onPick: () => setExporting(true) }];
  if (LIVE(s) && km.kind === "variant")
    items.push({ label: "Delete", danger: true, onPick: () => deleteVariant(s, d, km) });
  if (LIVE(s) && km.board)
    items.push({ label: "Delete", danger: true, onPick: () => deleteVendor(s, d, km) });
  return <>
    <Dropdown className="xbtn" label={<GearIcon />} caret={false} end
              title={`${km.name}: settings`} items={items} />
    {exporting && <ExportDialog km={km} close={() => setExporting(false)} />}
  </>;
}
