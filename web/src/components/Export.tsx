// "Export as…" - the board as a picture, with the keymap's name, the VileMK
// wordmark and as many layers as are ticked. It hangs off a row in the
// sidebar, so any keymap in the list exports without being opened first.
//
// A picture of a layer that is not on screen still has to be drawn, so the
// dialog renders one off-screen <Board> per ticked layer and hands those SVG
// elements to `sheetSvg()`. Rendering them as ordinary React children (rather
// than through a second root) is what keeps the boards identical to the one in
// the page: same component, same stylesheet, same theme.

import { useMemo, useRef, useState } from "react";

import { saveFile } from "../lib/download";
import { copySheet, sheetBlob, sheetPng, sheetSvg,
         type Sheet, type SheetLayer } from "../lib/image";
import { slugify } from "../lib/keymaps";
import { layersOf, type Layer } from "../lib/layers";
import { useStore } from "../state/store";
import { Board } from "./Board";
import { PictureIcon } from "./Icons";
import { Toggle } from "./Toggle";

const caption = (l: Layer, i: number) =>
  `${i} · ${l.display}${l.reserved ? " (reserved)" : ""}`;

export function ExportButton({ km }: { km: any }) {
  const [open, setOpen] = useState(false);
  return <>
    <button className="xbtn" title={`Export ${km.name} as an image`}
            aria-label={`Export ${km.name} as an image`}
            onClick={(e) => { e.stopPropagation(); setOpen(true); }}><PictureIcon /></button>
    {open && <ExportDialog km={km} close={() => setOpen(false)} />}
  </>;
}

function ExportDialog({ km, close }: { km: any; close: () => void }) {
  const { s, d } = useStore();
  // The dialog opens on a row, not on the page: everything the board needs
  // comes off `km`, and only the keymap that *is* on screen carries pending
  // edits or a layer the user is looking at.
  const mine = km.id === s.id;
  const lay = km.layouts[Math.min(s.layout, km.layouts.length - 1)];
  const layers = layersOf(km, s.newLayers[km.id], s.layout);

  const [title, setTitle] = useState(km.name);
  const [pick, setPick] = useState<number[]>(layers.map((_, i) => i));
  const [nums, setNums] = useState(false);
  const [busy, setBusy] = useState(false);
  const boards = useRef<Record<number, SVGSVGElement | null>>({});

  const chosen = useMemo(
    () => pick.filter((i) => i < layers.length).sort((a, b) => a - b),
    [pick, layers.length]);
  const stem = slugify(title || km.name)
             + (chosen.length === 1 ? `-${slugify(layers[chosen[0]].display)}`
                                    : "");
  const msg = (text: string, bad?: boolean) => d({ t: "msg", msg: { text, bad } });

  const toggle = (i: number) =>
    setPick((p) => p.includes(i) ? p.filter((n) => n !== i) : [...p, i]);

  // The boards are in the tree already; this only collects them.
  const build = async (): Promise<Sheet> => {
    const parts: SheetLayer[] = [];
    for (const i of chosen) {
      const svg = boards.current[i];
      if (svg) parts.push({ name: caption(layers[i], i), svg });
    }
    return sheetSvg(parts, {
      title: title || km.name, subtitle: km.path,
      captions: chosen.length > 1,
    });
  };

  const run = (fn: (sheet: Sheet) => Promise<string | null>) => async () => {
    setBusy(true);
    try {
      const said = await fn(await build());
      if (said) { msg(said); close(); }
    } catch (e) {
      msg((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal" onClick={close}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="bar">
          <h2>Export {km.name} as an image</h2>
          <span className="path">{km.path}</span>
        </div>

        <label className="bar">
          <span className="path">title on the picture</span>
          <input className="kb wide" autoComplete="off" value={title}
                 placeholder={km.name}
                 onChange={(e) => setTitle(e.target.value)} />
        </label>

        <div className="bar">
          <span className="path">layers</span>
        </div>
        <ul className="xlayers">
          {layers.map((l, i) => (
            <li key={i}>
              <Toggle checked={chosen.includes(i)} onChange={() => toggle(i)}>
                {caption(l, i)}
              </Toggle>
            </li>
          ))}
        </ul>

        <div className="bar">
          <Toggle checked={nums} onChange={setNums}>key positions</Toggle>
        </div>

        <div className="rowbtns">
          <button className="act" disabled={busy || !chosen.length}
                  onClick={run(async (sheet) => {
                    await copySheet(sheet);
                    return "copied as a PNG";
                  })}>Copy image</button>
          <button className="ghost" disabled={busy || !chosen.length}
                  onClick={run(async (sheet) => {
                    const png = await sheetPng(sheet);
                    return await saveFile(`${stem}.png`, png,
                      [{ description: "PNG image",
                         accept: { "image/png": [".png"] } }])
                      ? `saved ${stem}.png` : null;
                  })}>Save PNG</button>
          <button className="ghost" disabled={busy || !chosen.length}
                  onClick={run(async (sheet) => {
                    return await saveFile(`${stem}.svg`, sheetBlob(sheet),
                      [{ description: "SVG image",
                         accept: { "image/svg+xml": [".svg"] } }])
                      ? `saved ${stem}.svg` : null;
                  })}>Save SVG</button>
          <button className="ghost" onClick={close}>Cancel</button>
          {!chosen.length &&
            <span className="path">tick at least one layer</span>}
        </div>

        {/* The boards the export reads. Off-screen rather than hidden: they
            have to be laid out and styled like the real one. */}
        <div className="offscreen" aria-hidden="true">
          {chosen.map((i) => (
            <Board key={i} km={km} lay={lay}
                   bindings={layers[i].bindings} baseBindings={null}
                   assign={mine ? (s.assign[i] || {}) : {}} nums={nums}
                   hot={null} sel={[]} editing={null} onKey={null}
                   svgRef={{ get current() { return boards.current[i] || null; },
                             set current(el) { boards.current[i] = el; } }} />
          ))}
        </div>
      </div>
    </div>
  );
}
