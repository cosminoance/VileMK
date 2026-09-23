import { useRef, useState } from "react";

import { rowKey, summarise, unresolved, type ImportRow } from "../lib/transfer";
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
              <div className="warn">
                <code>{imp.board}</code> is not in this config repo. Add it with{" "}
                <code>zmk keyboard add {imp.board}</code> first: without its
                physical layout there is nothing to import into.
              </div>
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
