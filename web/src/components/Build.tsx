// Building a variant's firmware: the build panel under the variant bar, the
// Build button in it, and the sheet it opens. The build itself runs on the server (`POST /api/build`) and
// outlives the sheet; closing it only stops the polling, and reopening picks
// the log up again from the first line.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { buildChoices, choicesBody, type VendorConf } from "../lib/keymaps";
import { useStore, type State } from "../state/store";
import { ask } from "./Confirm";
import { DriverList, fetchDrivers, type Driver, type Picked } from "./Drivers";
import { FlashSheet, flashBlock } from "./Flash";
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
  /** A module keeps the keyboard in several folders and none is picked. */
  need_folder?: { module: string; folders: string[] };
  /** The vendor's `config/*.conf` files, for a keyboard from a prepared module. */
  confs?: VendorConf[] | null;
  /** Keymap edits the module's own CI makes for this folder. */
  rewrites?: CiRewrite[];
  /** What the prepared modules' own builds fetch that west.yml lacks. */
  drivers?: ModDriver[];
  folder?: string;
  path?: string;
  docker?: { ok: boolean; reason: string };
};

type CiRewrite = { module: string; old: string; new: string; file: string };
type ModDriver = Driver & { module: string };

/** Asked before a build whose modules' own builds fetch drivers west.yml
 *  lacks: without them it fails late, on an undefined Kconfig symbol or an
 *  unknown `compatible`. The status lists them without refs (no API calls on
 *  every sheet open); the refs are asked for here. `done(true)` after the
 *  ticked ones are fetched, `done(false)` for Build without. */
function NeedDrivers({ list, cancel, done }:
    { list: ModDriver[]; cancel: () => void; done: (fetched: boolean) => void }) {
  const [full, setFull] = useState<ModDriver[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [left, setLeft] = useState(list);
  const { s } = useStore();
  const mods = [...new Set(list.map((dr) => dr.module))];

  useEffect(() => {
    Promise.all(mods.map((m) =>
      api<{ drivers: Driver[] }>("GET", `/api/module/${encodeURIComponent(m)}/drivers`)
        .then((r) => r.drivers.map((dr) => ({ ...dr, module: m })))
        .catch(() => list.filter((dr) => dr.module === m))))
      .then((rs) => setFull(rs.flat().filter((dr) =>
        list.some((l) => l.name === dr.name && l.module === dr.module))));
  }, []);

  const fetchTicked = async (picked: Picked) => {
    setBusy(true);
    setErr(null);
    try {
      await fetchDrivers(picked, (n) => setLeft((l) => l.filter((dr) => dr.name !== n)));
      done(true);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const shown = (full ?? list).filter((dr) => left.some((l) => l.name === dr.name));
  return (
    <Modal onClose={busy ? undefined : cancel} className="confirm needdrivers"
           onKeyDown={(e) => { if (e.key === "Escape" && !busy) cancel(); }}>
      <h2>Add the drivers first</h2>
      <div className="body">
        <p>{mods.map((m) => s.data.module_names?.[m] || m).join(", ")}'s own build also fetches these, and this project
          does not have them yet. Without the ones the keyboard uses, the build
          fails partway through.
          Each ticked one is added as a module, like one added in <b>Add a
          keyboard</b>, then the build starts.</p>
        {!full && <p>Listing their branches{"\u2026"}</p>}
      </div>
      <DriverList key={full ? "full" : "bare"} list={shown} busy={busy || !full} on
                  actions={(picked) => <>
        {err && <div className="msg bad">{err}</div>}
        <div className="bar actions">
          <button className="ghost" disabled={busy} onClick={cancel}>Cancel</button>
          <button className="ghost danger" disabled={busy} onClick={() => done(false)}>
            Build without</button>
          <Help label="what Build without does">
            Builds with what this project has. Only for a driver the keyboard
            does not use.
          </Help>
          <button className="act" disabled={busy || !full || !picked.length}
                  onClick={() => fetchTicked(picked)}>
            {busy ? "Fetching\u2026" : "Fetch and build"}
          </button>
        </div>
      </>} />
    </Modal>);
}

/** Whether to make the CI's keymap edits: true, false, or null to not build. */
async function confirmRewrites(rw: CiRewrite[]): Promise<boolean | null> {
  const a = await ask({
    title: "Apply the vendor's keymap changes?",
    ok: "Apply and build",
    extra: { label: "Build without",
             tip: "Builds your keymap unchanged, for when the vendor's step does not fit your keyboard." },
    body: <>
      <p>{rw[0].module}'s own build changes its keymap for this folder before
        building ({rw.map((r) => r.file).filter((f, i, a) => a.indexOf(f) === i)
          .map((f) => <code key={f}>{f}</code>)}). Your keymap started from theirs:</p>
      <ul>{rw.map((r) => (
        <li key={r.old}><code>{r.old}</code> becomes <code>{r.new}</code></li>))}</ul>
      <p>The change goes into the build only; your variant's keymap stays as it is.</p>
    </> });
  return a === "extra" ? false : a ? true : null;
}

/** Why a prepared module's choices cannot build yet, or null. Like
 *  `flashBlock()`, said beside the disabled button. */
export function buildBlock(s: State, km: any): string | null {
  const { prep, folder, vendor, entries } = buildChoices(s, km);
  if (!prep) return null;
  if (prep.folders.length && !folder) return "pick the shield folder first";
  const ticked = vendor.filter((e) => entries[e.id]);
  if (!ticked.length) return "tick at least one entry to build";
  const seen = new Set<string>();
  for (const e of ticked) {
    const half = `${e.shields.join(" ")} on ${e.board}`;
    if (seen.has(half)) return `${half} is ticked twice; untick one`;
    seen.add(half);
  }
  return null;
}

export function BuildPanel({ km, dirty }: { km: any; dirty: number }) {
  const { s, d } = useStore();
  const [sheet, setSheet] = useState<"build" | "flash" | null>(null);
  const own = km.kind === "variant";
  const choice = buildChoices(s, km);
  const { reset, offered, parts, prep, folder, vendor, entries } = choice;
  const block = own ? buildBlock(s, km) : null;
  const has = offered.filter((p) => parts[p.id]).map((p) => p.shield);
  const docker = s.data.build;
  const noDocker = !!docker && !docker.ok;
  // Why Build is off, or what it will leave out, said where it is seen:
  // under the button, and in the heading while the panel is closed.
  const note = !own
    ? "Save this keymap as a variant first (Save as\u2026), then build the variant."
    : noDocker ? `Building needs Docker: ${docker.reason}. Everything else works without it.`
    : block ? `Build: ${block}.`
    : dirty ? `${dirty} unsaved change(s) are not in the build. Save first to include them.`
    : null;
  const short = !own ? "save as a variant first"
    : noDocker ? "needs Docker"
    : block ? block
    : dirty ? "save first" : null;
  const choices = [folder, reset ? "with reset" : "", ...has]
    .filter(Boolean).join(" \u00b7 ");
  const noFlash = own ? flashBlock(s, km) : "save as a variant first";
  return <>
    <Fold title="Build" accent open={s.build} onToggle={(on) => d({ t: "build", on })}
          actions={<button className="act sm buildbtn" disabled={!!noFlash}
                           title={noFlash ? `Flash: ${noFlash}` : "Copy the firmware onto the keyboard"}
                           onClick={() => setSheet("flash")}>Flash</button>}
          summary={<>{choices}{short &&
            <span className="foldwarn">{choices ? " \u00b7 " : ""}{short}</span>}</>}>
      {prep && own && <PrepChoices km={km} prep={prep} folder={folder} vendor={vendor}
                                   entries={entries} />}
      <div className="bar">
        {/* A keyboard ZMK Studio has written to ignores the compiled keymap at
            those key positions, on every boot, until the partition is wiped - and
            the keys that stick are the ones carrying a generated behavior, so the
            board looks almost right. Default this on when the keymap binds
            `&studio_unlock`, since that is the keymap that can hit it. */}
        <Toggle checked={reset} onChange={(on) => d({ t: "reset", kmId: km.id, on })}>
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
          <button className="act sm buildbtn" disabled={!own || noDocker || !!block}
                  onClick={() => setSheet("build")}>
            Build firmware
          </button>
        </span>
      </div>
      {note && <div className="warn">{note}</div>}
      <div className="hint">These go into the variant's build.yaml when you save or build.</div>
    </Fold>
    {sheet === "build" &&
      <BuildSheet name={km.name} kmId={km.id} dirty={dirty} choices={choicesBody(choice)}
                  confs={choice.confs} noFlash={noFlash}
                  close={() => setSheet(null)} flash={() => setSheet("flash")} />}
    {sheet === "flash" && <FlashSheet name={km.name} close={() => setSheet(null)} />}
  </>;
}

/** A prepared module's shield folder and vendor entries. The user picks: a
 *  repo that builds several ways has no one right answer VileMK could infer. */
function PrepChoices({ km, prep, folder, vendor, entries }:
    { km: any; prep: any; folder: string; vendor: any[];
      entries: Record<string, boolean> }) {
  const { d } = useStore();
  return <>
    {!!prep.folders.length &&
      <div className="bar">
        <span className="path">folder</span>
        <select value={folder} aria-label="shield folder"
                onChange={(e) => d({ t: "prepFolder", kmId: km.id, folder: e.target.value })}>
          {!folder && <option value="">pick one{"\u2026"}</option>}
          {prep.folders.map((f: string) => <option key={f} value={f}>{f}</option>)}
        </select>
        <Help label="what the folder is">
          {prep.module} keeps this keyboard in more than one folder, one for each
          way it can be built (for example Bluetooth only, or with a dongle). Its
          own build deletes the others first. Pick the one your keyboard is built
          as; VileMK builds from a copy with only that folder.
        </Help>
      </div>}
    {!!vendor.length &&
      <div className="bar">
        <span className="path">builds</span>
        {vendor.map((e) => (
          <Toggle key={e.id} checked={entries[e.id]}
                  onChange={(on) => d({ t: "prepEntry", kmId: km.id, id: e.id, on })}>
            {e.shields.join(" ")} <span className="path">
              {e.board}{e.snippet ? ` \u00b7 ${e.snippet}` : ""}</span>
          </Toggle>
        ))}
        <Help label="what the entries are">
          The firmware files in {prep.module}'s own build list for this folder.
          Each ticked one is built. The vendor lists some halves more than once,
          for example with and without ZMK Studio; tick one of each.
        </Help>
      </div>}
  </>;
}

type Choices = Record<string, unknown>;

/** The guard for a build whose keyboard is not in the project. */
const notInstalled = (missing: string[]) => ask({
  info: true, title: missing.length > 1 ? "Boards not installed" : "Board not installed",
  body: <>This variant builds <code>{missing.join(", ")}</code>, which{" "}
    {missing.length > 1 ? "are" : "is"} not in ZMK or any installed module. Add the
    keyboard, or the module it comes from, with <b>Add a keyboard</b> in the sidebar,
    then build again.</> });

/** The guard for a build whose module needs a folder picked. */
const needFolder = (need: { module: string; folders: string[] }) => ask({
  info: true, title: "Pick the shield folder",
  body: <>{need.module} keeps this keyboard in {need.folders.join(" and ")}. Pick
    one in the Build panel, then build again.</> });

function BuildSheet({ name, kmId, dirty, choices, confs, noFlash, close, flash }:
    { name: string; kmId: string; dirty: number; choices: Choices;
      confs: Record<string, boolean>; noFlash: string | null;
      close: () => void; flash: () => void }) {
  const { d } = useStore();
  const [job, setJob] = useState<Job | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const next = useRef(0);
  const log = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  const [copied, setCopied] = useState(false);
  const [needDrivers, setNeedDrivers] = useState(false);

  // The choices make the listed targets the ones the build will run, saved or
  // not.
  const q = (since: number, full: boolean) =>
    `/api/build?since=${since}` + (full ? `&variant=${encodeURIComponent(name)}`
      + `&reset=${choices.reset ? 1 : 0}`
      + Object.entries(choices).filter(([k]) => k !== "reset").map(([k, v]) =>
          `&${k}=${encodeURIComponent(typeof v === "string" ? v : JSON.stringify(v))}`)
        .join("") : "");

  const pull = async (full: boolean) => {
    const r: Job = await api("GET", q(next.current, full));
    setLines((prev) => next.current === 0 ? r.lines : prev.concat(r.lines));
    next.current = r.next;
    setJob((prev) => ({ ...prev, ...r }));
    return r;
  };

  useEffect(() => {
    pull(true).then(async (r) => {
      if (r.need_folder) { await needFolder(r.need_folder); close(); }
      else if (r.missing?.length) { await notInstalled(r.missing); close(); }
    }).catch((e) => setErr(e.message));
  }, []);

  const running = job?.state === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(async () => {
      try {
        const r = await pull(false);
        if (r.state !== "running") {
          await pull(true);                              // the files it wrote
          // and the sidebar's and panel's idea of whether they are fresh
          d({ t: "data", data: await api("GET", "/api/state") });
        }
      } catch (e: any) { setErr(e.message); }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [running]);

  // Follow the log unless the user has scrolled up to read it.
  useLayoutEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const start = () => {
    setErr(null);
    if (job?.drivers?.length) setNeedDrivers(true);
    else go();
  };

  const driversDone = async (fetched: boolean) => {
    setNeedDrivers(false);
    if (fetched) {
      try {
        d({ t: "data", data: await api("GET", "/api/state") });
        await pull(true);
      } catch (e: any) { setErr(e.message); return; }
    }
    go();
  };

  const go = async () => {
    let rewrites = true;
    if (job?.rewrites?.length) {
      const a = await confirmRewrites(job.rewrites);
      if (a === null) return;
      rewrites = a;
    }
    try {
      next.current = 0;
      const r: Job = await api("POST", "/api/build", { name, ...choices, rewrites });
      setLines(r.lines);
      next.current = r.next;
      setJob((prev) => ({ ...prev, ...r }));
    } catch (e: any) {
      if (e.body?.need_folder) await needFolder(e.body.need_folder);
      else if (e.body?.missing?.length) await notInstalled(e.body.missing);
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

      {!!job?.confs?.length &&
        <VendorConfs kmId={kmId} confs={job.confs} changed={confs} />}

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
      {needDrivers && job?.drivers &&
        <NeedDrivers list={job.drivers} cancel={() => setNeedDrivers(false)}
                     done={driversDone} />}

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
        {mine && job!.state === "ok" &&
          <button className="act push" onClick={flash} disabled={!!noFlash}
                  title={noFlash ? `Flash: ${noFlash}` : undefined}>
            Flash
          </button>}
      </div>
    </Modal>
  );
}

/** The vendor's `config/*.conf` files for a prepared module, each going into
 *  the shields ZMK's own rule would apply it to. Our build never reads the
 *  vendor's `config/`, so a ticked file is appended to those shields' conf. */
function VendorConfs({ kmId, confs, changed }:
    { kmId: string; confs: VendorConf[]; changed: Record<string, boolean> }) {
  const { d } = useStore();
  return <>
    <div className="bar">
      <span className="path">vendor settings</span>
      {confs.map((c) => (
        <Toggle key={c.id} checked={changed[c.id] ?? c.on} disabled={!c.shields.length}
                onChange={(on) => d({ t: "prepConf", kmId, id: c.id, on })}>
          {c.file} <span className="path">
            {c.shields.length ? `into ${c.shields.join(", ")}` : "fits no part built"}
          </span>
        </Toggle>
      ))}
      <Help label="what the vendor settings are">
        Settings files from the vendor's <code>config/</code> folder, such as the
        one that turns a trackball on. The vendor's own build reads them; this
        one only does when they are ticked.
      </Help>
    </div>
    <div className="warn">
      These are ticked the way the vendor's own build uses them. Leave them as
      they are unless you know what they change, or the vendor has told you
      otherwise.
    </div>
  </>;
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
      Built. <b>Flash</b> copies it onto the keyboard for you. By hand: put the
      keyboard into its bootloader (on most boards, double-tap reset) and copy
      its <code>.uf2</code> onto the drive that appears. A split
      keyboard has one file per half; flash each half with its own.
      {reset && " Flash the settings_reset files first, then the firmware, then re-pair."}
      {bin && " A .bin file does not copy across; flash it with the board's own tool."}
    </div>
  );
}
