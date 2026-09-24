import { useEffect, useMemo, useState } from "react";

import { api } from "../lib/api";
import { useStore } from "../state/store";
import { ask } from "./Confirm";
import { Help } from "./Help";
import { Modal } from "./Modal";

interface Kb {
  id: string; name: string; type: "board" | "shield"; source: string; url: string;
  siblings: string[]; requires: string[]; features: string[];
  controllers: string[]; added: boolean; files: string[];
}
interface Ctl { id: string; name: string; source: string }
interface Offer { keyboards: Kb[]; controllers: Ctl[]; default_controller: string }
interface Plan { build: string; entries: string[]; copy: string[]; kept: string[] }

const key = (k: Kb) => `${k.source}:${k.id}`;
const from = (source: string) => source === "zmk" ? "ZMK" : source;

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

  const load = async () => setOffer(await api<Offer>("GET", "/api/keyboards"));
  useEffect(() => {
    load().catch((e) => setMsg({ text: e.message, bad: true }));
  }, []);

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

  const add = async () => {
    if (!cur) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<Plan>("POST", "/api/keyboard",
                                { id: cur.id, source: cur.source, controller: ctl });
      await after(`added ${cur.name}: ${r.entries.length} entries in ${r.build}`
        + (r.copy.length ? `, copied ${r.copy.join(", ")}` : ""));
    } catch (e: any) {
      setMsg({ text: e.message, bad: true });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (k: Kb) => {
    if (!await ask({ title: `Remove ${k.name}?`, ok: "Remove", danger: true,
        body: "Its entries leave build.yaml"
          + (k.files.length ? ` and ${k.files.join(" and ")} are deleted,`
                            + " including any edits made to them" : "")
          + ". Variants of it are kept." }))
      return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api("DELETE", `/api/keyboard/${encodeURIComponent(k.id)}`);
      await after(`removed ${k.name}: ${r.entries} entries`
        + (r.deleted.length ? `, deleted ${r.deleted.join(", ")}` : ""));
    } catch (e: any) {
      setMsg({ text: e.message, bad: true });
    } finally {
      setBusy(false);
    }
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
              <span className="path">{k.id} · {from(k.source)}</span>
              <button className="ghost sm danger push" disabled={busy}
                      onClick={() => remove(k)}>Remove</button>
            </li>))}
        </ul>
      </>}

      {offer && <>
        <h3>Add</h3>
        <div className="bar">
          <input className="kb wide" placeholder="filter by name or module…" autoComplete="off"
                 spellCheck={false} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="items kbpick">
          {groups.length
            ? groups.map((g) => <div key={g.src}>
                <div className="group">
                  {g.src === "zmk" ? "Built into ZMK" : `From module ${g.src}`}
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
            copies its default keymap to <code>{f}</code></p>)}
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
