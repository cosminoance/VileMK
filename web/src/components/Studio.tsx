import type { AppMode } from "../state/store";
import { useStore } from "../state/store";

const MODES: [AppMode, string, string][] = [
  ["firmware", "Firmware", "Edit the keymap compiled into the firmware, build and flash"],
  ["studio", "Studio", "Edit a connected keyboard live through ZMK Studio"],
];

/** The header's Firmware / Studio switch. Firmware state is kept while in Studio. */
export function ModeSwitch() {
  const { s, d } = useStore();
  return (
    <span className="modesw" role="radiogroup" aria-label="Mode">
      {MODES.map(([m, label, tip]) =>
        <button key={m} role="radio" aria-checked={s.mode === m} title={tip}
                className={s.mode === m ? "on" : ""}
                onClick={() => d({ t: "mode", mode: m })}>{label}</button>)}
    </span>
  );
}

/** Studio mode's page. Nothing connects to a keyboard yet. */
export function StudioView() {
  return (
    <main className="studio">
      <h2>ZMK Studio</h2>
      <p>Editing a connected keyboard live is not built yet.</p>
    </main>
  );
}
