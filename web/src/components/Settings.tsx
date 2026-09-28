import { useEffect, useState } from "react";

import { api } from "../lib/api";
import { useStore } from "../state/store";
import { ask } from "./Confirm";
import { Help } from "./Help";
import { Modal } from "./Modal";

const short = (sha: string) => sha.slice(0, 7);

type Ref = { ref: string; kind: "latest" | "release" | "development" };
const OTHER = "\u0000other";

const LABEL: Record<Ref["kind"], string> = {
  latest: "latest release",
  release: "older release",
  development: "development",
};

const NOTE: Record<Ref["kind"] | "other", string> = {
  latest: "The newest release. Most keyboard modules and drivers are written for it.",
  release: "An older release, for keyboards that do not build on the newest one.",
  development: "Where the next release is made: newer features, and some boards "
    + "are named differently. Keyboards written for the release may not build, "
    + "and each Update can bring changes.",
  other: "Any branch, tag or commit of the repository above, such as a fork's "
    + "feature branch.",
};

/** `ZMK v0.3` under the wordmark, beside the version chip. Opens the settings. */
export function SettingsChip() {
  const { s } = useStore();
  const [open, setOpen] = useState(false);
  const zmk = s.data.zmk;
  if (!zmk) return null;
  return <>
    <button className="verchip" onClick={() => setOpen(true)} title="settings">
      ZMK {zmk.ref}
    </button>
    {open && <SettingsSheet close={() => setOpen(false)} />}
  </>;
}

function SettingsSheet({ close }: { close: () => void }) {
  const { s, d } = useStore();
  const zmk = s.data.zmk;
  const [url, setUrl] = useState<string>(zmk.url);
  const [ref, setRef] = useState<string>(zmk.ref);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [refs, setRefs] = useState<Ref[] | null>(null);
  const [refsErr, setRefsErr] = useState("");
  const [other, setOther] = useState(false);

  // The select lists what GitHub has for the URL in the field, refetched a
  // moment after it stops changing.
  useEffect(() => {
    const u = url.trim();
    setRefs(null);
    setRefsErr("");
    if (!u) return;
    let live = true;
    const t = setTimeout(() => {
      api("GET", "/api/zmk/refs?url=" + encodeURIComponent(u))
        .then((r) => { if (live) setRefs(r.refs); })
        .catch((e) => { if (live) setRefsErr(e.message); });
    }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [url]);

  const listed = refs?.find((r) => r.ref === ref.trim());
  const typing = other || !refs || !refs.length || !listed;

  const switching = url.trim() !== zmk.url || ref.trim() !== zmk.ref;
  const isDefault = url.trim() === zmk.default_url && ref.trim() === zmk.default_ref;

  const run = async () => {
    if (switching && !await ask({
        title: `Switch ZMK to ${url.trim()} at ${ref.trim()}?`, ok: "Switch",
        body: "Every keyboard and variant here is checked and built against it." }))
      return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api("POST", "/api/zmk", { url: url.trim(), ref: ref.trim() });
      const fresh = await api("GET", "/api/state");
      d({ t: "data", data: fresh });
      setUrl(r.zmk.url);
      setRef(r.zmk.ref);
      setMsg({ text: r.was === r.zmk.revision
        ? `already at ${short(r.zmk.revision)}, fetched again`
        : `pinned ${short(r.zmk.revision)}, ${r.files} files` });
    } catch (e: any) {
      setMsg({ text: e.message, bad: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={busy ? undefined : close} className="settings">
      <div className="bar">
        <h2>Settings</h2>
        <span className="path">config/west.yml</span>
      </div>

      <h3>ZMK source</h3>
      <div className="warn">
        Every keyboard and variant in this project is checked and built against
        this. Changing it can break all of them, and there is normally no reason
        to.
      </div>

      <div className="fields">
        <label htmlFor="zmk-url">repository</label>
        <input id="zmk-url" className="kb wide" autoComplete="off"
               spellCheck={false} value={url} disabled={busy}
               onChange={(e) => setUrl(e.target.value)} />
        <label htmlFor="zmk-ref">branch or tag</label>
        {refs && refs.length > 0
          ? <select id="zmk-ref" className="kb wide" disabled={busy}
                    value={typing ? OTHER : ref.trim()}
                    onChange={(e) => {
                      const v = e.target.value;
                      setOther(v === OTHER);
                      if (v !== OTHER) setRef(v);
                    }}>
              {refs.map((r) => <option key={r.ref} value={r.ref}>
                {r.ref} · {LABEL[r.kind]}
              </option>)}
              <option value={OTHER}>another branch, tag or commit…</option>
            </select>
          : <span className="path">
              {refsErr ? `could not list them: ${refsErr}` : "looking them up…"}
            </span>}
        {typing && <>
          <span />
          <input className="kb wide" autoComplete="off" spellCheck={false}
                 aria-label="branch, tag or commit" value={ref} disabled={busy}
                 onChange={(e) => setRef(e.target.value)} />
        </>}
        {refs && refs.length > 0 && <>
          <span />
          <span className="note">{NOTE[typing ? "other" : listed!.kind]}</span>
        </>}
        <span>commit</span>
        <span className="path">
          {zmk.pinned
            ? <code>{short(zmk.revision)}</code>
            : `not pinned yet (west.yml says ${zmk.revision || "nothing"})`}
          {!zmk.fetched && " · board data not fetched"}
        </span>
      </div>

      {zmk.error && <div className="msg bad">{zmk.error}</div>}
      {msg && <div className={"msg " + (msg.bad ? "bad" : "ok")}>{msg.text}</div>}

      <div className="rowbtns">
        <button className="act" disabled={busy || !url.trim() || !ref.trim()}
                onClick={run}>
          {busy ? "Fetching…" : switching ? "Switch" : "Update"}
        </button>
        <Help label="what update does">
          Resolves the branch or tag to the commit it names now, downloads ZMK's
          board data at that commit into <code>.zmk/zmk/</code>, and records the
          commit in <code>config/west.yml</code>. A build compiles that commit.
          GitHub repositories only.
        </Help>
        {!isDefault &&
          <button className="ghost" disabled={busy}
                  onClick={() => {
                    setUrl(zmk.default_url); setRef(zmk.default_ref); setOther(false);
                  }}>
            Use the default
          </button>}
        <button className="ghost" disabled={busy} onClick={close}>Close</button>
      </div>
    </Modal>
  );
}
