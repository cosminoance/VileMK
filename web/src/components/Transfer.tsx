import { useRef, useState } from "react";

import { rowKey, summarise, unresolved, type ImportRow, type Needed } from "../lib/transfer";
import { exportVariant, openImport, runImport } from "../state/actions";
import { useStore } from "../state/store";

export function ExportBar({ km }: { km: any }) {
  const { d } = useStore();
  if (km.kind !== "variant") return null;
  // A config or vendor keymap is a file the user already has.
  return <button className="ghost" onClick={() => exportVariant(d, km)}>
    Export keymap
  </button>;
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
    <div className="modal" onClick={close}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
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
      </div>
    </div>
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
        which ZMK module has the keyboard, add that module to{" "}
        <code>config/west.yml</code>, run <code>make module ARGS=&lt;name&gt;</code>,
        and import again.
      </p>
    </>;
  const entry = [
    `    - name: ${mod.name}`,
    `      url: ${mod.url}`,
    `      path: modules/${mod.name}`,
    `      revision: ${mod.ref || "main"}`,
  ].join("\n");
  return <>
    <div className="msg bad">
      This keymap is for {kb}, from the vendor module <code>{mod.name}</code> (
      <code>{mod.url}</code>). {!mod.listed
        ? "This project does not have that module. Add it, then import the file again."
        : !mod.fetched
        ? "The module is in config/west.yml but has not been fetched. Fetch it, then import the file again."
        : "The module is here but has no layout for this keyboard. Update it, then import the file again."}
    </div>
    {!mod.listed && <>
      <p className="legend">
        1. Add it under <code>projects:</code> in <code>config/west.yml</code>:
      </p>
      <pre className="dts">{entry}</pre>
    </>}
    <p className="legend">
      {mod.listed ? "" : "2. "}{mod.fetched ? "Update it:" : "Fetch it:"}
    </p>
    <pre className="dts">make module ARGS={mod.name}</pre>
  </>;
}
