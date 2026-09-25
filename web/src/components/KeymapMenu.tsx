import { useState } from "react";

import { deleteVariant, deleteVendor } from "../state/actions";
import { LIVE, useStore } from "../state/store";
import { Dropdown, type DropItem } from "./Dropdown";
import { ExportDialog } from "./Export";
import { FlashSheet, flashBlock } from "./Flash";
import { MoreIcon } from "./Icons";
import { KeymapExportDialog } from "./Transfer";

/** The actions button (⋮) beside a sidebar row: export the keymap or a picture of
 *  it, flash a variant's firmware, and delete for a variant or a vendor keyboard. A read-only page has no
 *  server to export the file from, so it offers the picture only. */
export function KeymapMenu({ km }: { km: any }) {
  const { s, d } = useStore();
  const [exporting, setExporting] = useState<"keymap" | "picture" | null>(null);
  const [flashing, setFlashing] = useState(false);
  const items: DropItem[] = [];
  const block = km.kind === "variant" ? flashBlock(s, km) : null;
  if (LIVE(s))
    items.push({ label: "Export keymap", onPick: () => setExporting("keymap") });
  items.push({ label: "Export as picture", onPick: () => setExporting("picture") });
  if (LIVE(s) && km.kind === "variant")
    items.push({ label: <>Flash firmware{block && <small>{block}</small>}</>,
                 disabled: !!block, onPick: () => setFlashing(true) },
               { label: "Delete", danger: true, onPick: () => deleteVariant(s, d, km) });
  if (LIVE(s) && km.board)
    items.push({ label: "Delete", danger: true, onPick: () => deleteVendor(s, d, km) });
  return <>
    <Dropdown className="xbtn" label={<MoreIcon />} caret={false} end
              title={`${km.name}: more actions`} items={items} />
    {exporting === "keymap" &&
      <KeymapExportDialog km={km} close={() => setExporting(null)} />}
    {exporting === "picture" &&
      <ExportDialog km={km} close={() => setExporting(null)} />}
    {flashing && <FlashSheet name={km.name} close={() => setFlashing(false)} />}
  </>;
}
