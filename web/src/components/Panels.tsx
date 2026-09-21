// The editor area's creation panels. One slot, directly under the board and
// above the menu, holding at most one thing: the clicked key's editor, or a
// panel for one of the six kinds. Opening either closes the other - there is
// nowhere to put two.

import { useCallback, useState, type ReactNode } from "react";

import { MODS, MOD_LABELS, modChainText } from "../lib/bindings";
import {
  BLANK_STEP, PANEL_TITLES, SLOTS, STEP_ADD, STEP_LABELS, stepField,
  type Mode,
} from "../lib/drafts";
import { applyField } from "../lib/fields";
import { layersOf } from "../lib/layers";
import { deleteItem, previewItem, saveItem } from "../state/actions";
import { draftOf, useStore } from "../state/store";

// ------------------------------------------------------------- the plumbing
interface Bound {
  draft: any;
  /** Write one field, by the same name the menu uses. */
  set: (f: string, v: string) => void;
  /** Rewrite the whole draft, for the list edits a field name cannot express. */
  put: (next: (prev: any) => any) => void;
  focus: (f: string) => void;
  /** Put the caret in this field once it exists. */
  focusSoon: (f: string | null) => void;
  /** Every input calls this as its ref; the one that was asked for takes focus. */
  claim: (f: string, el: HTMLInputElement | null) => void;
}

// Adding a macro step, moving one or clicking a modifier should carry the caret
// into the row that appeared or changed place. `claim` is each input's ref
// callback and re-runs whenever `want` changes, so it catches both a fresh
// mount and a row that merely swapped index. The focus fires the input's own
// `onFocus`, which re-points the menu the same way a click on the row does.
function useBound(mode: Mode): Bound {
  const { s, d } = useStore();
  const draft = draftOf(s, mode);
  const [want, setWant] = useState<string | null>(null);
  const claim = useCallback((f: string, el: HTMLInputElement | null) => {
    if (el && f === want) { el.focus(); setWant(null); }
  }, [want]);
  return {
    draft,
    set: (f, v) => d({ t: "draft", mode, draft: (prev: any) => applyField(prev, f, v) }),
    put: (next) => d({ t: "draft", mode, draft: next }),
    focus: (f) => d({ t: "field", key: f }),
    focusSoon: setWant,
    claim,
  };
}

function Slot({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <div className="slot"><span>{label}</span>{children}</div>;
}

// The menu never writes into these, so focusing one leaves `activeField` alone.
function Text({ b, f, cls = "kb wide", ph, value }:
    { b: Bound; f: string; cls?: string; ph?: string; value: any }) {
  return <input className={cls} value={value ?? ""} placeholder={ph}
                autoComplete="off" ref={(el) => b.claim(f, el)}
                onChange={(e) => b.set(f, e.target.value)} />;
}

// Focusing one of these points the menu below at it.
function BindIn({ b, f, cls = "kb", ph, value }:
    { b: Bound; f: string; cls?: string; ph?: string; value: any }) {
  return <input className={cls} value={value ?? ""} placeholder={ph}
                autoComplete="off" ref={(el) => b.claim(f, el)}
                onFocus={() => b.focus(f)}
                onChange={(e) => b.set(f, e.target.value)} />;
}

function Name({ b, ph }: { b: Bound; ph: string }) {
  return <Slot label="Name"><Text b={b} f="name" ph={ph} value={b.draft.name} /></Slot>;
}

function Buttons({ mode, draft }: { mode: Mode; draft: any }) {
  const { s, d } = useStore();
  return (
    <div className="rowbtns">
      <button className="act" onClick={() => saveItem(s, d, mode, draft)}>Save</button>
      <button className="ghost" onClick={() => previewItem(d, mode, draft)}>Devicetree</button>
      <button className="ghost" onClick={() => d({ t: "closePanel" })}>Close</button>
      <button className="ghost danger" onClick={() => deleteItem(d, mode, draft)}>Delete</button>
    </div>
  );
}

const Shell = ({ mode, draft, children }:
    { mode: Mode; draft: any; children: ReactNode }) => (
  <div className="panel">
    <h3>{PANEL_TITLES[mode]}</h3>
    {children}
    <Buttons mode={mode} draft={draft} />
  </div>
);

// ---------------------------------------------------------------- VileDance
export function ViledancePanel() {
  const b = useBound("viledance");
  const d = b.draft;
  return (
    <Shell mode="viledance" draft={d}>
      <Name b={b} ph="e.g. bkspshift" />
      {SLOTS.map(([k, lbl]) => (
        <Slot key={k} label={lbl}>
          <BindIn b={b} f={k} ph={k === "tap" ? "&kp BSPC" : undefined}
                  value={d[k]} />
        </Slot>
      ))}
      <Slot label="Tapping term (ms)">
        <Text b={b} f="tapping_term_ms" cls="kb sm" value={d.tapping_term_ms ?? 200} />
      </Slot>
      <Slot label="Flavor">
        <select className="kb wide" value={d.flavor}
                onChange={(e) => b.set("flavor", e.target.value)}>
          {["tap-preferred","hold-preferred","balanced","tap-unless-interrupted"]
            .map((f) => <option key={f}>{f}</option>)}
        </select>
      </Slot>
      <div className="hint">
        Fill <b>on tap</b> alone and it is just a key. Add <b>on hold</b> and it
        becomes a hold-tap. Add <b>on double tap</b> and it becomes a VileDance
        holding one or two hold-taps - <b>on tap + hold</b> needs <b>on double
        tap</b> filled too, since they're the same second press. Each slot takes
        a full ZMK binding (<code>&amp;kp BSPC</code>, <code>&amp;mo 2</code>)
        and, in a hold slot, must be a behavior of exactly one parameter. The
        {" "}<b>on tap + hold</b> row always uses the <code>balanced</code>{" "}
        flavor regardless of the setting above, so a held layer key engages right
        away instead of waiting out the term twice. Click a slot, then pick from
        the menu below.
      </div>
    </Shell>
  );
}

// -------------------------------------------------------------------- Macro
// The one panel whose fields are a *list*. Each row is an ordinary slot with a
// named field, so the menu fills whichever was focused last; the name carries
// an index (`step:2`, `text:0`, `ms:1`).
function StepRow({ b, s, i, n }: { b: Bound; s: any; i: number; n: number }) {
  const steps: any[] = b.draft.steps || [];
  const move = (dir: "up" | "down") => {
    const j = dir === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= steps.length) return;
    b.put((prev) => {
      const next = [...(prev.steps || [])];
      [next[i], next[j]] = [next[j], next[i]];
      return { ...prev, steps: next };
    });
    b.focusSoon(stepField(steps[j].action, j));
  };
  const field =
      s.action === "text"
        ? <Text b={b} f={`text:${i}`} ph="type the text here" value={s.text} />
    : s.action === "wait"
        ? <Text b={b} f={`ms:${i}`} cls="kb sm" value={s.ms ?? 50} />
    : s.action === "pause"
        ? <div className="path">holds here until the key is released</div>
        : <BindIn b={b} f={`step:${i}`} ph="&kp A" value={s.binding} />;
  return (
    <Slot label={`${i + 1}. ${STEP_LABELS[s.action] || s.action}`}>
      {field}
      <button type="button" className="ghost sm" disabled={!i}
              onClick={() => move("up")}>&uarr;</button>
      <button type="button" className="ghost sm" disabled={i >= n - 1}
              onClick={() => move("down")}>&darr;</button>
      <button type="button" className="ghost sm danger"
              onClick={() => b.put((prev) => ({ ...prev,
                steps: (prev.steps || []).filter((_: any, j: number) => j !== i) }))}>
        &times;
      </button>
    </Slot>
  );
}

export function MacroPanel() {
  const b = useBound("macro");
  const d = b.draft;
  const steps: any[] = d.steps || [];
  const add = (a: string) => {
    b.put((prev) => ({ ...prev, steps: [...(prev.steps || []), BLANK_STEP(a)] }));
    b.focusSoon(stepField(a, steps.length));
  };
  return (
    <Shell mode="macro" draft={d}>
      <Name b={b} ph="e.g. email" />
      {steps.length
        ? steps.map((s, i) => <StepRow key={i} b={b} s={s} i={i} n={steps.length} />)
        : <div className="hint">No steps yet - add one below.</div>}
      <div className="modrow">
        {STEP_ADD.map((a) => (
          <button key={a} type="button" className="ghost sm"
                  onClick={() => add(a)}>+ {a}</button>
        ))}
      </div>
      <Slot label="Wait between (ms)">
        <Text b={b} f="wait_ms" cls="kb sm" ph="15 - built-in" value={d.wait_ms || ""} />
      </Slot>
      <Slot label="Tap length (ms)">
        <Text b={b} f="tap_ms" cls="kb sm" ph="30 - built-in" value={d.tap_ms || ""} />
      </Slot>
      <div className="hint">
        <b>Text</b> is the short way to say "type this": it is expanded into one
        tap per character when the keymap is written, so <code>a@b.com</code>{" "}
        stays one step here instead of seven. <b>Tap</b>, <b>Press</b> and{" "}
        <b>Release</b> each take a whole binding - click the row, then pick it
        from the menu below - and press/release come in pairs around the keys
        they apply to. <b>Wait</b> pauses mid-sequence; <b>Pause</b> stops there
        until the key the macro is on is released, which is how a macro holds
        something down for as long as you do. ZMK's queue holds 64 behaviors and
        a tap costs two - go over and saving says so rather than letting the
        firmware stop half way.
      </div>
    </Shell>
  );
}

// -------------------------------------------------------------------- Combo
export function ComboPanel() {
  const b = useBound("combo");
  const d = b.draft;
  return (
    <Shell mode="combo" draft={d}>
      <Name b={b} ph="e.g. jk_quote" />
      <Slot label="Keys">
        <Text b={b} f="key_positions" ph="click the board above"
              value={(d.key_positions || []).join(" ")} />
      </Slot>
      <Slot label="Output key">
        <BindIn b={b} f="binding" ph="&kp SQT" value={d.binding} />
      </Slot>
      <Slot label="Timeout (ms)">
        <Text b={b} f="timeout_ms" cls="kb sm" value={d.timeout_ms ?? 50} />
      </Slot>
      <Slot label="Layers">
        <Text b={b} f="layers" ph="blank = all layers"
              value={(d.layers || []).join(" ")} />
      </Slot>
      <div className="hint">
        While this panel is open the <b>board above is the chord picker</b> -
        click keys on it to add and remove positions. ZMK identifies combo keys
        by position, not by what they currently send, so the positions are what
        gets written. The <b>output key</b> is an ordinary binding: fill it from
        the menu below. A combo goes on no key of its own, so it is written into
        a variant when it is switched <b>On</b> in the <b>Combos</b> tab.
      </div>
    </Shell>
  );
}

// ----------------------------------------------------------------- Modifier
// The modifier chain is built by clicking, not picked from the shared menu: it
// is eight buttons and a nesting order, nothing the keyboard grid could
// express. The menu below is left free to fill `Parameter`.
export function ModifierPanel() {
  const b = useBound("modifier");
  const d = b.draft;
  const mods: string[] = d.mods || [];
  const full = mods.length >= 3;
  return (
    <Shell mode="modifier" draft={d}>
      <Name b={b} ph="e.g. ctrl_shift_a" />
      <Slot label="Modifier">
        <Text b={b} f="mod" value={modChainText(mods)}
              ph="click a modifier below" />
      </Slot>
      <div className="modrow">
        {MODS.map((m) => (
          <button key={m} type="button"
                  className={"pk td mkey" + (full ? " off" : "")}
                  title={MOD_LABELS[m]}
                  onClick={() => { if (full) return;
                             b.put((prev) => ({ ...prev,
                               mods: [...(prev.mods || []), m] }));
                             b.focusSoon("mod"); }}>
            <span>{MOD_LABELS[m]}</span><span className="up">{m}</span>
          </button>
        ))}
        {!!mods.length && <>
          <button type="button" className="ghost sm"
                  onClick={() => { b.put((prev) => ({ ...prev,
                             mods: (prev.mods || []).slice(0, -1) }));
                           b.focusSoon("mod"); }}>
            &larr; remove last
          </button>
          <button type="button" className="ghost sm"
                  onClick={() => { b.put((prev) => ({ ...prev, mods: [] }));
                           b.focusSoon("mod"); }}>clear</button>
        </>}
      </div>
      <Slot label="Parameter">
        <BindIn b={b} f="param" ph="&kp A" value={d.param} />
      </Slot>
      <div className="hint">
        Click up to three modifiers to nest them ({full ? "three is the limit - " : ""}
        <code>LS</code>/<code>RS</code> shift, <code>LC</code>/<code>RC</code>{" "}
        control, <code>LA</code>/<code>RA</code> alt, <code>LG</code>/<code>RG</code>{" "}
        gui, left or right, outermost first), then fill <b>Parameter</b> from the
        menu below - the key they wrap. This bakes the result in as plain ZMK
        text wherever it is picked: editing a saved modifier later does not
        change keys that already used it; re-pick it to update them.
      </div>
    </Shell>
  );
}

// -------------------------------------------------------------- Layer shapes
// A layer number field: this keyboard's own layers by name when one is
// selected, a plain number when none is (a layer entry is worth writing either
// way - the generated keymap only cares about the index).
function LayerSelect({ b, km, f, value }:
    { b: Bound; km: any; f: string; value: any }) {
  const { s } = useStore();
  const all = layersOf(km, km ? s.newLayers[km.id] : [], s.layout);
  if (!all.length)
    return <input className="kb sm" value={value ?? 0} placeholder="0"
                  onChange={(e) => b.set(f, e.target.value)} />;
  return (
    <select className="kb wide" value={+value || 0}
            onChange={(e) => b.set(f, e.target.value)}>
      {all.map((l, i) => <option key={i} value={i}>{i} &middot; {l.display}</option>)}
    </select>
  );
}

// A layer-tap goes on a key and is picked from the Layers tab; a conditional
// layer goes on none and is switched on in the Conditional layers tab.
export function LayerTapPanel({ km }: { km: any }) {
  const b = useBound("layer");
  const d = b.draft;
  return (
    <Shell mode="layer" draft={d}>
      <Name b={b} ph="e.g. nav_space" />
      <Slot label="Layer"><LayerSelect b={b} km={km} f="layer" value={d.layer} /></Slot>
      <Slot label="Tap key">
        <BindIn b={b} f="key" ph="&kp SPACE" value={d.key} />
      </Slot>
      <Slot label="Tapping term (ms)">
        <Text b={b} f="tapping_term_ms" cls="kb sm" ph="200 - built-in"
              value={d.tapping_term_ms || ""} />
      </Slot>
      <Slot label="Flavor">
        <select className="kb wide" value={d.flavor || ""}
                onChange={(e) => b.set("flavor", e.target.value)}>
          {[["","balanced - built-in"], ["balanced","balanced"],
            ["tap-preferred","tap-preferred"], ["hold-preferred","hold-preferred"],
            ["tap-unless-interrupted","tap-unless-interrupted"]].map(([v, l]) =>
              <option key={v} value={v}>{l}</option>)}
        </select>
      </Slot>
      <div className="hint">
        Tap it for the key, hold it for the layer - and the <b>Layers</b> tab
        below makes one of these without saving anything, so this panel is for
        the ones worth a name, and for the timing below. Leave the term and
        flavor alone and this is ZMK's own <code>&amp;lt</code> - nothing is
        generated, and the tap has to be a plain keycode. Set either one and it
        becomes a generated hold-tap (<code>lt_&lt;name&gt;</code>) holding{" "}
        <code>&amp;mo</code> over your tap key, which is what{" "}
        <code>&amp;lt</code> is anyway - that version can tap any behavior of
        exactly one parameter. Click <b>Tap key</b>, then pick from the menu
        below.
      </div>
    </Shell>
  );
}

export function CondPanel({ km }: { km: any }) {
  const b = useBound("conditional");
  const d = b.draft;
  return (
    <Shell mode="conditional" draft={d}>
      <Name b={b} ph="e.g. tri_layer" />
      <Slot label="If layers">
        <Text b={b} f="if_layers" ph="1 2" value={(d.if_layers || []).join(" ")} />
      </Slot>
      <Slot label="Then layer">
        <LayerSelect b={b} km={km} f="then_layer" value={d.then_layer} />
      </Slot>
      <div className="hint">
        Hold <b>all</b> of the <b>if</b> layers at once and <b>then layer</b>{" "}
        activates on top - the tri-layer trick: hold 1 and 2 together to get 3.
        Two or more if-layers, and the then-layer cannot be one of them. This
        goes on no key: it is a <code>zmk,conditional-layers</code> node watching
        the layers the rest of your keymap already turns on, so nothing here can
        reference it and nothing below fills a field. Whether it reaches a
        variant is the <b>On</b>/<b>Off</b> switch on its row in the{" "}
        <b>Conditional layers</b> tab.
      </div>
    </Shell>
  );
}

export function Panel({ mode, km }: { mode: Mode; km: any }) {
  switch (mode) {
    case "viledance": return <ViledancePanel />;
    case "macro": return <MacroPanel />;
    case "combo": return <ComboPanel />;
    case "modifier": return <ModifierPanel />;
    case "conditional": return <CondPanel km={km} />;
    case "layer": return <LayerTapPanel km={km} />;
  }
}
