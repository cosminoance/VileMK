// Building a variant's firmware: the build panel under the variant bar, the
// Build button in it, and the sheet it opens. The build itself runs on the server (`POST /api/build`) and
// outlives the sheet; closing it only stops the polling, and reopening picks
// the log up again from the first line.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { bindsStudioUnlock } from "../lib/keymaps";
import { useStore, type State } from "../state/store";
import { ask } from "./Confirm";
import { Fold } from "./Fold";
import { Help } from "./Help";
import { Toggle } from "./Toggle";
import { Modal } from "./Modal";

const POLL_MS = 1000;

type Job = {
  state: "idle" | "running" | "ok" | "failed" | "cancelled";
  variant: string;
  lines: string[];
  next: number;
  files: string[];
  targets?: string[];
  problem?: string;
  /** Boards or shields the build names that `.zmk/` does not have. */
  missing?: string[];
  folder?: string;
  path?: string;
  docker?: { ok: boolean; reason: string };
};

/** What the variant's build.yaml gets on save: the reset entries, and which
 *  of the vendor's add-on parts this keyboard has. */
export function buildChoices(s: State, km: any) {
  const reset = s.reset === null ? bindsStudioUnlock(km) : s.reset;
  const offered: any[] = km.parts || [];
  const parts: Record<string, boolean> = Object.fromEntries(
    offered.map((p) => [p.id, (s.parts[km.id] || {})[p.id] ?? p.on]));
  return { reset, offered, parts };
}

export function BuildPanel({ km, dirty }: { km: any; dirty: number }) {
  const { s, d } = useStore();
  const own = km.kind === "variant";
  const { reset, offered, parts } = buildChoices(s, km);
  const has = offered.filter((p) => parts[p.id]).map((p) => p.shield);
  const docker = s.data.build;
  const noDocker = !!docker && !docker.ok;
  // Why Build is off, or what it will leave out, said where it is seen:
  // under the button, and in the heading while the panel is closed.
  const note = !own
    ? "Save this keymap as a variant first (Save as\u2026), then build the variant."
    : noDocker ? `Building needs Docker: ${docker.reason}. Everything else works without it.`
    : dirty ? `${dirty} unsaved change(s) are not in the build. Save first to include them.`
    : null;
  const short = !own ? "save as a variant first"
    : noDocker ? "needs Docker"
    : dirty ? "save first" : null;
  const choices = [reset ? "with reset" : "", ...has].filter(Boolean).join(" \u00b7 ");
  return (
    <Fold title="Build" accent open={s.build} onToggle={(on) => d({ t: "build", on })}
          summary={<>{choices}{short &&
            <span className="foldwarn">{choices ? " \u00b7 " : ""}{short}</span>}</>}>
      <div className="bar">
        {/* A keyboard ZMK Studio has written to ignores the compiled keymap at
            those key positions, on every boot, until the partition is wiped - and
            the keys that stick are the ones carrying a generated behavior, so the
            board looks almost right. Default this on when the keymap binds
            `&studio_unlock`, since that is the keymap that can hit it. */}
        <Toggle checked={reset} onChange={(on) => d({ t: "reset", on })}>
          include reset
        </Toggle>
        <Help label="what include reset does">
          Also builds a reset firmware for the keyboard. Flash it (to both halves
          on a split) before the actual reflash.
        </Help>
        {/* The vendor's build list covers every way the keyboard is sold, so
            it names parts this one may not have. Only the user knows. */}
        {!!offered.length && <>
          <span className="path">has</span>
          {offered.map((p) => (
            <Toggle key={p.id} checked={parts[p.id]}
                    onChange={(on) => d({ t: "part", kmId: km.id, id: p.id, on })}>
              {p.shield} <span className="path">{p.slot}</span>
            </Toggle>
          ))}
          <Help label="what the parts are">
            Add-ons the keyboard's maker lists for each half, such as a screen.
            Tick the ones your keyboard has. An unticked screen also turns the
            display off in the build.
          </Help>
        </>}
        <span className="buildgo">
          <BuildButton km={km} dirty={dirty} off={!own || noDocker}
                       reset={reset} parts={parts} />
        </span>
      </div>
      {note && <div className="warn">{note}</div>}
      <div className="hint">These go into the variant's build.yaml when you save or build.</div>
    </Fold>
  );
}

type Choices = { reset: boolean; parts: Record<string, boolean> };

function BuildButton({ km, dirty, off, ...choices }:
    { km: any; dirty: number; off: boolean } & Choices) {
  const [open, setOpen] = useState(false);
  return <>
    <button className="act" disabled={off} onClick={() => setOpen(true)}>
      Build firmware
    </button>
    {open && <BuildSheet name={km.name} dirty={dirty} choices={choices}
                         close={() => setOpen(false)} />}
  </>;
}

/** The guard for a build whose keyboard is not in the project. */
const notInstalled = (missing: string[]) => ask({
  info: true, title: missing.length > 1 ? "Boards not installed" : "Board not installed",
  body: <>This variant builds <code>{missing.join(", ")}</code>, which{" "}
    {missing.length > 1 ? "are" : "is"} not in ZMK or any installed module. Add the
    keyboard, or the module it comes from, with <b>Add a keyboard</b> in the sidebar,
    then build again.</> });

function BuildSheet({ name, dirty, choices, close }:
    { name: string; dirty: number; choices: Choices; close: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const next = useRef(0);
  const log = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const [copied, setCopied] = useState(false);

  // `reset` and `parts` make the listed targets the ones the build will run,
  // saved or not.
  const q = (since: number, full: boolean) =>
    `/api/build?since=${since}` + (full ? `&variant=${encodeURIComponent(name)}`
      + `&reset=${choices.reset ? 1 : 0}`
      + `&parts=${encodeURIComponent(JSON.stringify(choices.parts))}` : "");

  const pull = async (full: boolean) => {
    const r: Job = await api("GET", q(next.current, full));
    setLines((prev) => next.current === 0 ? r.lines : prev.concat(r.lines));
    next.current = r.next;
    setJob((prev) => ({ ...prev, ...r }));
    return r;
  };

  useEffect(() => {
    pull(true).then(async (r) => {
      if (r.missing?.length) { await notInstalled(r.missing); close(); }
    }).catch((e) => setErr(e.message));
  }, []);

  const running = job?.state === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      try {
        const r = await pull(false);
        if (r.state !== "running") await pull(true);   // the files it wrote
      } catch (e: any) { setErr(e.message); }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [running]);

  // Follow the log unless the user has scrolled up to read it.
  useLayoutEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const start = async () => {
    setErr(null);
    try {
      next.current = 0;
      const r: Job = await api("POST", "/api/build", { name, ...choices });
      setLines(r.lines);
      next.current = r.next;
      setJob((prev) => ({ ...prev, ...r }));
    } catch (e: any) {
      if (e.body?.missing?.length) await notInstalled(e.body.missing);
      else setErr(e.message);
    }
  };

  const openFolder = async () => {
    setErr(null);
    try { await api("POST", "/api/build/open", { name }); }
    catch (e: any) { setErr(e.message); }
  };

  const copyPath = async () => {
    setErr(null);
    try {
      await navigator.clipboard.writeText(job!.path!);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e: any) { setErr(`could not copy: ${e.message}`); }
  };

  const cancel = async () => {
    try { await api("DELETE", "/api/build"); } catch (e: any) { setErr(e.message); }
  };

  const other = job && job.variant && job.variant !== name;
  const mine = job && job.variant === name;
  const docker = job?.docker;

  return (
    <Modal onClose={close} className="build">
      <div className="bar">
        <h2>Build {name}</h2>
        <span className="path">{job?.folder || `variants/${name}/firmware`}/</span>
      </div>

      {docker && !docker.ok &&
        <div className="warn">Building needs Docker: {docker.reason}.</div>}
      {job?.problem && <div className="warn">{job.problem}</div>}
      {!!dirty &&
        <div className="warn">
          {dirty} unsaved change(s) are not in the build. It compiles the saved
          variant; save it first to include them.
        </div>}

      {!!job?.targets?.length &&
        <div className="bar">
          <span className="path">builds</span>
          {job.targets.map((t) => <code key={t} className="next">{t}</code>)}
          <Help label="what the build does">
            Every entry in <code>variants/{name}/build.yaml</code>, compiled in
            ZMK's build container against <code>config/</code> and the ZMK commit
            pinned in <code>config/west.yml</code>. The first build downloads
            the container image and all of ZMK and Zephyr, which takes several
            minutes; later ones reuse them.
          </Help>
        </div>}

      {other && running &&
        <div className="msg bad">{job!.variant} is building. One build runs at a time.</div>}

      {mine && lines.length > 0 &&
        <pre className="dts log" ref={log}
             onScroll={(e) => {
               const el = e.currentTarget;
               stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
             }}>{lines.join("\n")}</pre>}

      {mine && job!.state === "ok" && <FlashNote files={job!.files} />}
      {mine && job!.state === "failed" &&
        <div className="msg bad">The build failed; the log above says where.
          The firmware folder is unchanged.</div>}
      {mine && job!.state === "cancelled" &&
        <div className="msg bad">Cancelled. The firmware folder is unchanged.</div>}
      {err && <div className="msg bad">{err}</div>}

      {!!job?.files?.length && !running &&
        <FileList files={job.files} targets={job.targets || []}>
          <button className="ghost sm" onClick={openFolder}>Open folder</button>
          <button className="ghost sm" disabled={!job.path} onClick={copyPath}>
            {copied ? "Copied" : "Copy path"}
          </button>
        </FileList>}

      <div className="rowbtns">
        {running && mine
          ? <button className="ghost danger" onClick={cancel}>Cancel build</button>
          : <button className="act"
                    disabled={!job || running || !docker?.ok || !job.targets?.length}
                    onClick={start}>
              {job?.files?.length ? "Build again" : "Build"}
            </button>}
        <button className="ghost" onClick={close}>
          {running ? "Close (keeps building)" : "Close"}
        </button>
      </div>
    </Modal>
  );
}

/** What is in the firmware folder now, against what the next build writes:
 *  a file a target rebuilds is amber, like the target; one no target makes
 *  any more is removed when the next build publishes. `children` are the
 *  folder actions, at the bottom where the eye is when a build ends. */
function FileList({ files, targets, children }:
    { files: string[]; targets: string[]; children: React.ReactNode }) {
  const next = new Set(targets);
  const stem = (f: string) => f.replace(/\.[^.]+$/, "");
  const gone = files.some((f) => !next.has(stem(f)));
  return (
    <div className="files">
      <div className="bar">
        <span className="path">existing files</span>
        <Help label="what the colours mean">
          Amber files are rebuilt by the next build.
          {gone && " Struck-out files are removed by it, since the current choices no longer build them."}
        </Help>
        <span className="push folderbtns">{children}</span>
      </div>
      <ul>
        {files.map((f) => (
          <li key={f}>
            <code className={next.has(stem(f)) ? "next" : "gone"}>{f}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** How to put what was built on the keyboard, for whatever shape it is. */
function FlashNote({ files }: { files: string[] }) {
  const reset = files.some((f) => f.startsWith("settings_reset"));
  const bin = files.some((f) => f.endsWith(".bin"));
  return (
    <div className="msg ok">
      Built. Put the keyboard into its bootloader (on most boards, double-tap
      reset) and copy its <code>.uf2</code> onto the drive that appears. A split
      keyboard has one file per half; flash each half with its own.
      {reset && " Flash the settings_reset files first, then the firmware, then re-pair."}
      {bin && " A .bin file does not copy across; flash it with the board's own tool."}
    </div>
  );
}
