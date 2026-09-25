// Flashing a built variant: the sheet lists its firmware files, looks for a
// keyboard in its UF2 bootloader over USB, and copies a file onto it. The
// server does the finding and the copy (`/api/flash`).

import { useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import type { State } from "../state/store";
import { ask } from "./Confirm";
import { Help } from "./Help";
import { Modal } from "./Modal";

const POLL_MS = 1000;
const LOOK_MS = 10000;
const STUCK_MS = 15000;

type Drive = { path: string; board: string };

/** settings_reset files first: they go on before the firmware. */
const order = (files: string[]) => [
  ...files.filter((f) => f.startsWith("settings_reset")),
  ...files.filter((f) => !f.startsWith("settings_reset")),
];

/** Why `km`'s firmware should not be flashed now, or null. `km.firmware` is
 *  `firmware.firmware_state()` from `/api/state`. */
export function flashBlock(s: State, km: any): string | null {
  const fw = km.firmware;
  if (!fw?.uf2) return "not built yet";
  const edits = (km.id === s.id ? Object.keys(s.assign).length : 0)
    + (s.newLayers[km.id] || []).length;
  if (edits) return "unsaved changes; save and build first";
  if (!fw.fresh) return "changed since the last build; build again first";
  return null;
}

export function FlashSheet({ name, close }: { name: string; close: () => void }) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [fresh, setFresh] = useState(true);
  const [drive, setDrive] = useState<Drive | null>(null);
  const [looking, setLooking] = useState(false);
  const [left, setLeft] = useState(LOOK_MS / 1000);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [wait, setWait] = useState<string | null>(null);
  const [stuck, setStuck] = useState(false);
  const [flashed, setFlashed] = useState<string | null>(null);
  const until = useRef(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const q = `/api/flash?variant=${encodeURIComponent(name)}`;

  const look = () => {
    setDrive(null);
    setFlashed(null);
    until.current = Date.now() + LOOK_MS;
    setLeft(LOOK_MS / 1000);
    setLooking(true);
  };

  useEffect(() => {
    api("GET", q).then((r) => {
      setFiles(r.files);
      setFresh(r.fresh);
      if (r.files.some((f: string) => f.endsWith(".uf2"))) look();
    }).catch((e) => setErr(e.message));
  }, []);

  useEffect(() => {
    if (!looking) return;
    const t = setInterval(async () => {
      let found: Drive | undefined;
      try { found = (await api("GET", q)).drives[0]; }
      catch (e: any) { setErr(e.message); }
      if (!alive.current) return;
      if (found) { setDrive(found); setLooking(false); return; }
      const ms = until.current - Date.now();
      setLeft(Math.max(0, Math.ceil(ms / 1000)));
      if (ms > 0) return;
      setLooking(false);
      const again = await ask({
        title: "Keyboard not found", ok: "Look again",
        body: <>No keyboard in its bootloader showed up over USB. Check the cable
          carries data (some only charge), double-tap reset, and make sure the
          drive it shows is mounted.</> });
      if (again && alive.current) look();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [looking]);

  // The board reboots once it has taken the file, and its drive goes away.
  useEffect(() => {
    if (!wait) return;
    const since = Date.now();
    const t = setInterval(async () => {
      let drives: Drive[] | undefined;
      try { drives = (await api("GET", q)).drives; }
      catch (e: any) { setErr(e.message); }
      if (!alive.current || !drives) return;
      if (drives.length) { setStuck(Date.now() - since > STUCK_MS); return; }
      setWait(null);
      setStuck(false);
      setDrive(null);
      if (wait.startsWith("settings_reset")) {
        const fw = (files || []).find((f) => f.endsWith(".uf2")
          && !f.startsWith("settings_reset") && wait.endsWith(f));
        await ask({
          title: "Settings reset", info: true, ok: "Look for it",
          body: <>The keyboard's stored settings are cleared, and it is running the
            reset firmware, which does nothing else. Keep the cable connected,
            double-tap reset to put it in its bootloader again, then
            copy {fw ? <code>{fw}</code> : "its firmware"}.</> });
        if (alive.current) look();
      } else {
        await ask({
          title: "Flashed", info: true,
          body: <><code>{wait}</code> is on the keyboard. You can disconnect the
            cable.{split && " Flash the other half the same way."}</> });
        if (alive.current) setFlashed(wait);
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [wait]);

  const copy = async (file: string) => {
    setErr(null);
    setBusy(file);
    try {
      await api("POST", "/api/flash", { name, file, drive: drive!.path });
      setDone((d) => [...d, file]);
      setWait(file);
    } catch (e: any) {
      setErr(e.message);
      look();
    }
    setBusy(null);
  };

  const split = (files || []).filter((f) => f.endsWith(".uf2")
    && !f.startsWith("settings_reset")).length > 1;

  return (
    <Modal onClose={close} className="build flash">
      <div className="bar"><h2>Flash {name}</h2></div>

      {files && !files.length &&
        <div className="msg bad">{name} has not been built yet. Build it first.</div>}

      {!!files?.length && !fresh &&
        <div className="warn">This firmware was built before the variant was
          last saved. Build it again to flash what you saved.</div>}

      {!!files?.length && <>
        <ol className="steps">
          <li>Connect the keyboard{split ? " half" : ""} to this computer with a USB
            cable. Firmware cannot be copied over Bluetooth.</li>
          <li>Put it in its bootloader: on most boards, press reset twice quickly.
            It shows up as a small USB drive.</li>
          <li>Once it is found, click <b>Copy</b> beside the file for
            that {split ? "half" : "board"}.
            {split && " Then do the same with the other half and its own file."}</li>
        </ol>

        <div className={"msg " + (wait ? (stuck ? "bad" : "")
            : drive || flashed ? "ok" : looking ? "" : "bad")}>
          {wait ? (stuck
              ? <>The drive is still there, so the board did not take{" "}
                  <code>{wait}</code>. Check it is the file for this half.</>
              : <>Copied <code>{wait}</code>. Waiting for the keyboard to restart…</>)
            : flashed ? <>Flashed <code>{flashed}</code>.</>
            : drive ? <>Found {drive.board || "a UF2 bootloader"} at <code>{drive.path}</code>.</>
            : looking ? <>Looking for the keyboard over USB… {left}s</>
            : <>No keyboard found.</>}
          {!drive && !looking && !wait &&
            <button className="ghost sm push" onClick={look}>Look again</button>}
        </div>

        <div className="files">
          <div className="bar">
            <span className="path">firmware</span>
            <Help label="which file goes where">
              A split keyboard has one file per half, named after it. Flash the
              settings_reset files first if there are any, then the firmware, then
              re-pair the keyboard with your computer.
            </Help>
          </div>
          <ul className="flashlist">
            {order(files).map((f) => (
              <li key={f}>
                <code>{f}</code>
                {done.includes(f) && <span className="flashed">✓ flashed</span>}
                {f.endsWith(".uf2")
                  ? <button className="act sm push" disabled={!drive || !!busy || !!wait}
                            onClick={() => copy(f)}>
                      {busy === f ? "Copying…" : "Copy"}
                    </button>
                  : <span className="path push">flash with the board's own tool</span>}
              </li>
            ))}
          </ul>
        </div>
      </>}

      {err && <div className="msg bad">{err}</div>}

      <div className="rowbtns">
        <button className="ghost" onClick={close}>Close</button>
      </div>
    </Modal>
  );
}
