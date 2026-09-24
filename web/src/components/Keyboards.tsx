import { useEffect, useMemo, useState } from "react";

import { api } from "../lib/api";
import { useStore } from "../state/store";
import { ask } from "./Confirm";
import { Help } from "./Help";
import { askLeftover } from "./Leftover";
import { Modal } from "./Modal";

interface Kb {
  id: string; name: string; type: "board" | "shield"; source: string; url: string;
  siblings: string[]; requires: string[]; features: string[];
  controllers: string[]; added: boolean; files: string[];
}
interface Ctl { id: string; name: string; source: string }
interface Mod { name: string; url: string; ref: string; revision: string; fetched: boolean }
interface Offer {
  keyboards: Kb[]; controllers: Ctl[]; default_controller: string; modules: Mod[];
  module_names: Record<string, string>;
}
interface Plan { build: string; entries: string[]; copy: string[]; kept: string[] }

const key = (k: Kb) => `${k.source}:${k.id}`;
const short = (sha: string) => sha.slice(0, 7);

/** Sidebar button that opens the keyboard sheet. */
export function KeyboardsButton() {
  const [open, setOpen] = useState(false);
  return <>
    <button className="ghost sm impbtn" onClick={() => setOpen(true)}>
      Add a keyboard
    </button>
    {open && <KeyboardsSheet close={() => setOpen(false)} />}
  </>;
}

function KeyboardsSheet({ close }: { close: () => void }) {
  const { d } = useStore();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState("");
  const [ctl, setCtl] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("main");
  const [renaming, setRenaming] = useState<{ mod: string; alias: string } | null>(null);

  const load = async () => setOffer(await api<Offer>("GET", "/api/keyboards"));
  useEffect(() => {
    load().catch((e) => setMsg({ text: e.message, bad: true }));
  }, []);

  // A module's alias, from custom/module-names.json; only this page uses it.
  const label = (source: string) => source === "zmk" ? "ZMK"
    : offer?.module_names[source] || source;
  const kbs = offer?.keyboards ?? [];
  const added = kbs.filter((k) => k.added);
  const ql = q.trim().toLowerCase();
  const rows = kbs.filter((k) => !k.added && (!ql || k.name.toLowerCase().includes(ql)
    || k.id.includes(ql) || k.source.toLowerCase().includes(ql)));
  // Module keyboards first: a module is there because someone chose to add it.
  const groups = [...new Set(rows.map((k) => k.source))]
    .sort((a, b) => Number(a === "zmk") - Number(b === "zmk") || a.localeCompare(b))
    .map((src) => ({ src, rows: rows.filter((k) => k.source === src) }));
  const cur = kbs.find((k) => key(k) === sel && !k.added) ?? null;
  const ctls = useMemo(() => cur ? offer!.controllers.filter(
    (c) => cur.controllers.includes(c.id)) : [], [cur, offer]);

  const pick = (k: Kb) => {
    setSel(key(k));
    setMsg(null);
    setCtl(k.type !== "shield" ? ""
      : k.controllers.includes(offer!.default_controller)
      ? offer!.default_controller : k.controllers[0] ?? "");
  };

  useEffect(() => {
    setPlan(null);
    if (!cur || (cur.type === "shield" && !ctl)) return;
    let live = true;
    api<Plan>("POST", "/api/keyboard",
              { id: cur.id, source: cur.source, controller: ctl, dry: true })
      .then((p) => live && setPlan(p))
      .catch((e) => live && setMsg({ text: e.message, bad: true }));
    return () => { live = false; };
  }, [sel, ctl]);

  const after = async (text: string) => {
    d({ t: "data", data: await api("GET", "/api/state") });
    await load();
    setSel("");
    setMsg({ text });
  };

  const act = async (run: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      await after(await run());
    } catch (e: any) {
      setMsg({ text: e.message, bad: true });
    } finally {
      setBusy(false);
    }
  };

  const add = () => cur && act(async () => {
    const r = await api<Plan>("POST", "/api/keyboard",
                              { id: cur.id, source: cur.source, controller: ctl });
    return `added ${cur.name}: ${r.entries.length} entries in ${r.build}`
      + (r.copy.length ? `, copied ${r.copy.join(", ")}` : "");
  });

  const remove = async (k: Kb) => {
    if (!await ask({ title: `Remove ${k.name}?`, ok: "Remove", danger: true,
        body: "Its entries leave build.yaml"
          + (k.files.length ? ` and ${k.files.join(" and ")} are deleted,`
                            + " including any edits made to them" : "")
          + ". Variants of it are kept." }))
      return;
    act(async () => {
      const r = await api("DELETE", `/api/keyboard/${encodeURIComponent(k.id)}`);
      return `removed ${k.name}: ${r.entries} entries`
        + (r.deleted.length ? `, deleted ${r.deleted.join(", ")}` : "");
    });
  };

  // A new module's keyboards are listed first in the catalog, under its name.
  const fetchModule = () => act(async () => {
    const r = await api("POST", "/api/module", { url: url.trim(), ref: ref.trim() });
    setUrl("");
    setRef("main");
    setQ("");
    return `added module ${r.name} at ${short(r.revision)}, ${r.files} files: `
      + (r.keyboards
        ? `${r.keyboards} keyboard(s), listed under "From module ${r.name}" below`
        : "it has no keyboard VileMK can add (none with a *.zmk.yml and a"
          + " default .keymap)");
  });

  // The server swaps the new copy in only when no variant breaks; otherwise it
  // names the problems and the commit, which Overwrite installs unchecked.
  const updateModule = (m: Mod) => act(async () => {
    const path = `/api/module/${encodeURIComponent(m.name)}`;
    const r = await api("POST", path);
    if (r.updated) {
      const text = r.was === r.revision
        ? `${m.name} is already at ${short(r.revision)}, fetched again`
        : `${m.name}: ${r.ref} is now ${short(r.revision)}, ${r.files} files`;
      await ask({ info: true, title: "Fetch check success",
                  body: `Updated the local module. ${text}.` });
      return text;
    }
    const answer = await ask({
      info: true, title: "Fetch check failure",
      body: <>Did not update the local module. {label(m.name)} at {short(r.sha)} would
        break:<ul>{r.problems.map((p: string) => <li key={p}>{p}</li>)}</ul></>,
      extra: { label: "Overwrite",
               tip: <>Installs {short(r.sha)} anyway. The variants listed will not
                 build until they are fixed to match it.</> } });
    if (answer !== "extra")
      return `${m.name} not updated, still at ${short(m.revision)}`;
    const o = await api("POST", path, { overwrite: true, sha: r.sha });
    return `${m.name}: overwritten with ${short(o.revision)}, ${o.files} files`;
  });

  const rename = async () => {
    if (!renaming) return;
    try {
      const r = await api("POST", "/api/module-name",
                          { module: renaming.mod, alias: renaming.alias });
      setOffer((o) => o && { ...o, module_names: r.module_names });
      d({ t: "data", data: await api("GET", "/api/state") });
      setRenaming(null);
    } catch (e: any) {
      setMsg({ text: e.message, bad: true });
    }
  };

  const removeModule = async (m: Mod) => {
    if (!await ask({ title: `Remove module ${m.name}?`, ok: "Remove", danger: true,
        body: `It leaves config/west.yml and .zmk/modules/${m.name}/ is deleted.`
          + " Refused while build.yaml or a variant still builds one of its"
          + " keyboards." }))
      return;
    act(async () => {
      const r = await api("DELETE", `/api/module/${encodeURIComponent(m.name)}`);
      if (r.left.length) await askLeftover(label(m.name), r.left);
      return `removed module ${m.name}` + (r.left.length
        ? `; ${r.left.length} file(s) could not be deleted` : "");
    });
  };

  return (
    <Modal onClose={busy ? undefined : close} className="keyboards">
      <div className="bar">
        <h2>Keyboards</h2>
        <span className="path">build.yaml · config/</span>
      </div>

      {!offer && !msg && <p className="legend">reading .zmk/…</p>}

      {!!added.length && <>
        <h3>In this project</h3>
        <ul className="ilist">
          {added.map((k) => (
            <li key={key(k)} className="irow">
              <span className="nm">{k.name}</span>
              <span className="path">{k.id} · {label(k.source)}</span>
              <button className="ghost sm danger push" disabled={busy}
                      onClick={() => remove(k)}>Remove</button>
            </li>))}
        </ul>
      </>}

      {!!offer?.modules.length && <>
        <h3>Modules</h3>
        <ul className="ilist">
          {offer.modules.map((m) => (
            <li key={m.name} className="irow">
              {renaming?.mod === m.name
                ? <input className="kb" autoFocus autoComplete="off" spellCheck={false}
                         aria-label={`name for ${m.name}`} placeholder={m.name}
                         value={renaming.alias}
                         onChange={(e) => setRenaming({ ...renaming, alias: e.target.value })}
                         onKeyDown={(e) => {
                           if (e.key === "Enter") rename();
                           if (e.key === "Escape") { e.stopPropagation(); setRenaming(null); }
                         }} />
                : <span className="nm">{label(m.name)}</span>}
              <span className="path">
                {label(m.name) !== m.name && `${m.name} · `}
                {m.ref || "no ref"} · {m.fetched ? short(m.revision) : "not fetched"}
              </span>
              {renaming?.mod === m.name
                ? <button className="ghost sm push" onClick={rename}>Save name</button>
                : <button className="ghost sm push" disabled={busy}
                          onClick={() => setRenaming({ mod: m.name, alias: label(m.name) })}>
                    Rename
                  </button>}
              <button className="ghost sm" disabled={busy || !m.ref}
                      onClick={() => updateModule(m)}>
                {m.fetched ? "Update" : "Fetch"}
              </button>
              <Help label="what rename and update do">
                Rename changes only the name shown here, kept in
                <code> custom/module-names.json</code>; a blank name goes back to
                the repository's. 
                Update will download the new repo shape and check it against the variants
                that build its keyboards. It replaces the local module only when
                none of them breaks.
              </Help>
              <button className="ghost sm danger" disabled={busy}
                      onClick={() => removeModule(m)}>Remove</button>
            </li>))}
        </ul>
      </>}

      {offer && <>
        <h3>Add a module from GitHub</h3>
        <div className="fields">
          <label htmlFor="mod-url">repository</label>
          <input id="mod-url" className="kb wide" autoComplete="off" spellCheck={false}
                 placeholder="https://github.com/owner/zmk-keyboard" value={url}
                 disabled={busy} onChange={(e) => setUrl(e.target.value)} />
          <label htmlFor="mod-ref">branch or tag</label>
          <span className="bar">
            <input id="mod-ref" className="kb" autoComplete="off" spellCheck={false}
                   value={ref} disabled={busy} onChange={(e) => setRef(e.target.value)} />
            <button className="act" disabled={busy || !url.trim() || !ref.trim()}
                    onClick={fetchModule}>
              {busy && url.trim() ? "Fetching…" : "Fetch"}
            </button>
            <Help label="what fetch does">
              Resolves the branch or tag to the commit it names now, downloads the
              repository at that commit into <code>.zmk/modules/</code>, and adds it
              to <code>config/west.yml</code> pinned to that commit, which is what a
              build compiles. Its keyboards then appear below. GitHub repositories
              only.
            </Help>
          </span>
        </div>

        <h3>Add a keyboard</h3>
        <div className="bar">
          <input className="kb wide" placeholder="filter by name or module…" autoComplete="off"
                 spellCheck={false} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="items kbpick">
          {groups.length
            ? groups.map((g) => <div key={g.src}>
                <div className="group">
                  {g.src === "zmk" ? "Built into ZMK" : `From module ${label(g.src)}`}
                </div>
                {g.rows.map((k) => (
                  <button key={key(k)} className={key(k) === sel ? "sel" : ""}
                          onClick={() => pick(k)}>
                    {k.name}
                    <small>
                      {k.id} · {k.type === "shield" ? "shield" : "board"}
                      {k.siblings.length ? " · split" : ""}
                    </small>
                  </button>))}
              </div>)
            : <p className="legend">nothing matches</p>}
        </div>
      </>}

      {cur && <>
        <div className="fields">
          {cur.type === "shield" && <>
            <label htmlFor="kb-ctl">controller</label>
            <span className="bar">
              <select id="kb-ctl" value={ctl} disabled={busy}
                      onChange={(e) => setCtl(e.target.value)}>
                {ctls.map((c) => <option key={c.id} value={c.id}>
                  {c.name} ({c.id})
                </option>)}
              </select>
              <Help label="what the controller is">
                {cur.name} is a shield: a PCB that a separate controller board
                plugs into, through a {cur.requires.join(" or ")} footprint. The
                build needs to know which controller that is. Only the ones with
                a matching footprint are listed.
              </Help>
            </span>
          </>}
          {!!cur.features.length && <>
            <span>has</span>
            <span className="path">{cur.features.join(", ")}</span>
          </>}
        </div>
        {plan && <>
          <p className="legend">Adds to <code>{plan.build}</code>:</p>
          <pre className="dts">{plan.entries.join("\n")}</pre>
          {plan.copy.map((f) => <p className="legend" key={f}>
            copies its settings to <code>{f}</code></p>)}
          {plan.kept.map((f) => <p className="legend" key={f}>
            keeps <code>{f}</code>, which is already there</p>)}
        </>}
      </>}

      {msg && <div className={"msg " + (msg.bad ? "bad" : "ok")}>{msg.text}</div>}

      <div className="rowbtns">
        {cur &&
          <button className="act" disabled={busy || !plan} onClick={add}>
            {busy ? "Adding…" : `Add ${cur.name}`}
          </button>}
        <button className="ghost" disabled={busy} onClick={close}>Close</button>
      </div>
    </Modal>
  );
}
