import { useRef, useState } from "react";

import { saveFile } from "../lib/download";
import { rowKey, summarise, unresolved, type ImportRow, type Needed } from "../lib/transfer";
import { exportText, openImport, runImport } from "../state/actions";
import { useStore } from "../state/store";
import { Modal } from "./Modal";
import { Toggle } from "./Toggle";

/** "Export keymap" from a sidebar row's menu: the `.keymap` to hand someone,
 *  saved through the file picker or copied as text. */
export function KeymapExportDialog({ km, close }: { km: any; close: () => void }) {
  const { s, d } = useStore();
  const [nums, setNums] = useState(false);
  const [busy, setBusy] = useState(false);
  const layout = Math.min(s.layout, km.layouts.length - 1);
  const pending = km.id === s.id && (
    Object.values(s.assign).some((o: any) => Object.keys(o).length)
    || !!(s.newLayers[km.id] || []).length);

  const run = (fn: (r: { filename: string; text: string }) =>
                 Promise<string | null>) => async () => {
    setBusy(true);
    try {
      const said = await fn(await exportText(km, nums, layout));
      if (said) { d({ t: "msg", msg: { text: said } }); close(); }
    } catch (e) {
      d({ t: "msg", msg: { text: (e as Error).message, bad: true } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={close}>
      <div className="bar">
        <h2>Export {km.name}</h2>
        <span className="path">{km.path}</span>
      </div>

      {km.kind === "variant" &&
        <p className="legend">
          The file carries the VileMK records it uses, so importing it restores
          them.
        </p>}
      {pending &&
        <div className="warn">unsaved edits are not in the file; Save first to
          include them</div>}

      <div className="bar">
        <Toggle checked={nums} onChange={setNums}>
          include key positions
        </Toggle>
        <span className="path">
          a comment drawing the {km.layouts[layout].display
            || km.layouts[layout].label} layout with each key's number
        </span>
      </div>

      <div className="rowbtns">
        <button className="act" disabled={busy}
                onClick={run(async (r) =>
                  await saveFile(r.filename,
                    new Blob([r.text], { type: "text/plain;charset=utf-8" }),
                    [{ description: "ZMK keymap",
                       accept: { "text/plain": [".keymap"] } }])
                    ? `saved ${r.filename}` : null)}>Save as…</button>
        <button className="ghost" disabled={busy}
                onClick={run(async (r) => {
                  await navigator.clipboard.writeText(r.text);
                  return `copied ${r.filename}`;
                })}>Copy to clipboard</button>
        <button className="ghost" onClick={close}>Cancel</button>
      </div>
    </Modal>
  );
}

export function ImportButton() {
  const { d } = useStore();
  const input = useRef<HTMLInputElement>(null);
  return <>
    <button className="ghost sm impbtn" onClick={() => input.current?.click()}>
      Import a .keymap
    </button>
    <input ref={input} type="file" accept=".keymap,text/plain" hidden
           onChange={(e) => {
             const f = e.target.files?.[0];
             e.target.value = "";
             if (f) openImport(d, f);
           }} />
  </>;
}

function Row({ row }: { row: ImportRow }) {
  const { s, d } = useStore();
  const imp = s.imp!;
  const key = rowKey(row);
  const [open, setOpen] = useState(false);

  if (row.status !== "clash")
    return (
      <li className="irow">
        <span className="nm">{row.kind} <code>{row.name}</code></span>
        <span className="path">
          {row.status === "new" ? "new here" : "identical, reusing yours"}
        </span>
      </li>
    );

  const choice = imp.choices[key];
  const pick = (v: "rename" | "drop") =>
    d({ t: "impPatch", patch: { choices: { ...imp.choices, [key]: v } } });

  return (
    <li className="irow clash">
      <div className="bar">
        <span className="nm">{row.kind} <code>{row.name}</code></span>
        <span className="path">exists here and differs</span>
        <button className={"tgl " + (choice === "rename" ? "on" : "off")}
                onClick={() => pick("rename")}>rename</button>
        <button className={"tgl " + (choice === "drop" ? "on" : "off")}
                onClick={() => pick("drop")}>use mine</button>
        <button className="ghost sm" onClick={() => setOpen(!open)}>
          {open ? "hide" : "compare"}
        </button>
      </div>
      {choice === "rename" &&
        <label className="bar">
          <span className="path">save the incoming one as</span>
          <input className="kb wide" autoComplete="off"
                 value={imp.renames[key] ?? `${row.name}_2`}
                 onChange={(e) => d({ t: "impPatch", patch:
                   { renames: { ...imp.renames, [key]: e.target.value } } })} />
        </label>}
      {choice === "drop" &&
        <p className="path">
          nothing is written; <code>&amp;{row.name}</code> in the imported keymap
          resolves to yours
        </p>}
      {open &&
        <div className="cmp">
          <div><h4>incoming</h4><pre>{summarise(row.incoming)}</pre></div>
          <div><h4>yours</h4><pre>{summarise(row.local)}</pre></div>
        </div>}
    </li>
  );
}

export function ImportDialog() {
  const { s, d } = useStore();
  const imp = s.imp;
  if (!imp) return null;
  const close = () => d({ t: "imp", imp: null });
  const left = unresolved(imp);
  const done = imp.result;

  return (
    <Modal onClose={close}>
      <div className="bar">
        <h2>Import {imp.filename}</h2>
        <span className="path">{imp.board || "unknown keyboard"}</span>
      </div>

      {!imp.known
        ? <>
            <MissingBoard board={imp.board} mod={imp.module} />
            <div className="rowbtns"><button className="ghost" onClick={close}>
              Close
            </button></div>
          </>
        : done
        ? <>
            <div className="msg ok">wrote {done.folder || done.wrote}</div>
            {!!done.renamed.length &&
              <ul className="ilist">{done.renamed.map((r) =>
                <li key={r} className="irow"><span className="nm">{r}</span></li>)}
              </ul>}
            {done.errors.map((e) => <div className="warn" key={e}>{e}</div>)}
            {done.warnings.map((w) => <div className="legend" key={w}>{w}</div>)}
            {!done.errors.length &&
              <p className="legend">The checks found no errors.</p>}
            <div className="rowbtns">
              <button className="act" onClick={close}>Done</button>
            </div>
          </>
        : <>
            <label className="bar">
              <span className="path">save as variant</span>
              <input className="kb wide" autoComplete="off" value={imp.name}
                     onChange={(e) => d({ t: "impPatch",
                                          patch: { name: e.target.value } })} />
              {imp.taken && <span className="path">overwrites the existing one</span>}
            </label>

            {imp.records.length
              ? <ul className="ilist">
                  {imp.records.map((r) => <Row key={rowKey(r)} row={r} />)}
                </ul>
              : <p className="legend">
                  This keymap carries no VileMK records, so there is nothing to
                  restore alongside it.
                </p>}

            {imp.error && <div className="msg bad">{imp.error}</div>}
            <div className="rowbtns">
              <button className="act" disabled={imp.busy || !!left.length}
                      onClick={() => runImport(s, d)}>
                {imp.busy ? "Importing…" : "Import"}
              </button>
              <button className="ghost" onClick={close}>Cancel</button>
              {!!left.length &&
                <span className="path">
                  decide what to do with {left.length} record(s) first
                </span>}
            </div>
          </>}
    </Modal>
  );
}

/** Why a keymap cannot be imported yet, and what to add so it can. */
function MissingBoard({ board, mod }: { board: string; mod: Needed | null }) {
  const kb = <code>{board || "its keyboard"}</code>;
  if (!mod)
    return <>
      <div className="msg bad">
        This keymap is for {kb}, which is not added to this project. Without the
        keyboard's physical layout there is nothing to import into.
      </div>
      <p className="legend">
        The file does not say where the keyboard comes from. Ask whoever sent it
        which ZMK module has the keyboard, add it under <b>Add a keyboard</b> →{" "}
        <b>Add a module from GitHub</b>, add the keyboard, and import again.
      </p>
    </>;
  return <>
    <div className="msg bad">
      This keymap is for {kb}, from the vendor module <code>{mod.name}</code> (
      <code>{mod.url}</code>). {!mod.listed
        ? "This project does not have that module."
        : !mod.fetched
        ? "The module is in config/west.yml but has not been fetched."
        : "The module is here but has no layout for this keyboard."}
    </div>
    <p className="legend">
      {!mod.listed
        ? <>Open <b>Add a keyboard</b>, fetch <code>{mod.url}</code> at{" "}
            <code>{mod.ref || "main"}</code> under <b>Add a module from GitHub</b>,
            add the keyboard, then import the file again.</>
        : <>Open <b>Add a keyboard</b>, press {mod.fetched ? "Update" : "Fetch"} on{" "}
            <code>{mod.name}</code> under <b>Modules</b>, then import the file
            again.</>}
    </p>
  </>;
}
