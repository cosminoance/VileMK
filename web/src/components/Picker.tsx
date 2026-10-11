import { createContext, useContext } from "react";

import {
  bindOf, layerBinding, layerTitle, modBinding, usesLayer,
} from "../lib/bindings";
import { PICKER, PICKER_EXTRA, SYSTEM, type PickerEntry } from "../lib/keycodes";
import { label } from "../lib/labels";
import { byId, scopeOf, scopeOn } from "../lib/keymaps";
import { BLANK, isDirty, recordOf, type Mode } from "../lib/drafts";
import {
  activeFieldOf, applyField, fieldValue, KEY_FIELD,
} from "../lib/fields";
import { layerRows, layersOf, ltCode } from "../lib/layers";
import {
  macroBinding, macroSummary, macroTitle, usesVd, vdTitle,
} from "../lib/cards";
import { previewBinding, toggleScope } from "../state/actions";
import { draftOf, useStore } from "../state/store";

// --------------------------------------------------------------- studio mode
/** Provided by Studio mode: picks go to the keyboard, and whatever its firmware
 *  has no behavior for is dimmed. */
export interface StudioPick {
  /** The open key, or null. */
  editing: number | null;
  /** Layer index shown, for the key editor's heading. */
  layer: number;
  /** What the open key held at the keyboard's last save. */
  saved: string;
  close: () => void;
  pick: (v: string) => void;
  setField: (v: string) => void;
  cur: string;
  /** Why a binding cannot go on this keyboard, or null when it can. */
  why: (v: string) => string | null;
  layers: [number, string][];
}
export const StudioPickCtx = createContext<StudioPick | null>(null);

const BUILD_TIP = "Studio cannot add behaviors to the keyboard. Create or edit "
  + "this in Firmware mode, build and flash, and it can be bound here.";

// ----------------------------------------------------------- filling a field
// With the key editor open a pick is already the whole answer - clicking A on
// the Keyboard tab cannot mean anything but `&kp A` - so it is assigned and the
// editor closes. Anywhere else it fills the focused field of a panel that still
// has its own Save. The layer-tap buttons use `setField` instead: they compose
// with what is in the field, so they are not finished bindings.
export function usePick() {
  const { s, d } = useStore();
  const sp = useContext(StudioPickCtx);
  const field = activeFieldOf(s);
  if (sp) return { pick: sp.pick, setField: sp.setField, field: KEY_FIELD, cur: sp.cur };

  const setField = (v: string) => {
    if (!field)
      return d({ t: "msg", msg: { text: "click the field to fill in first", bad: true } });
    if (field === KEY_FIELD) return d({ t: "keyVal", v });
    if (!s.emode) return;
    d({ t: "draft", mode: s.emode,
        draft: (prev: any) => applyField(prev, field, v) });
  };

  const pick = (v: string) => {
    if (s.editing === null || field !== KEY_FIELD) return setField(v);
    d({ t: "assign", pos: s.editing, v, close: true,
        msg: { text: `key ${s.editing} → ${label(v)}` } });
  };

  return { pick, setField, field, cur: fieldValue(s, field) };
}

// ------------------------------------------------------------ the key grids
function PickerKey({ ent, cur, off, onPick }:
    { ent: PickerEntry; cur: string; off?: boolean; onPick: (b: string) => void }) {
  const sp = useContext(StudioPickCtx);
  const [lbl, code, w] = ent;
  const width = { width: w * 36 - 4 };
  if (!code) return <span className="sp" style={width} />;
  const b = bindOf(code);
  const why = sp && sp.why(b);
  const parts = Array.isArray(lbl) ? lbl : lbl.split("|");
  return (
    <button type="button" title={why ? `${b}: ${why}` : b} style={width} disabled={!!why}
            className={"pk" + (b === cur ? " sel" : "") + (off ? " off" : "") + (why ? " na" : "")}
            onClick={() => onPick(b)}>
      {parts.length > 1 && <span className="up">{parts[0]}</span>}
      <span>{parts.length > 1 ? parts[1] : parts[0]}</span>
    </button>
  );
}

export function Grid({ cur, onPick }: { cur: string; onPick: (b: string) => void }) {
  return <>
    {PICKER.map((r, i) => (
      <div className="prow" key={i}>
        {r.map((e, j) => <PickerKey key={j} ent={e} cur={cur} onPick={onPick} />)}
      </div>
    ))}
    <div className="prow extra">
      {PICKER_EXTRA.map((e, j) => <PickerKey key={j} ent={e} cur={cur} onPick={onPick} />)}
    </div>
  </>;
}

// One group per SYSTEM entry: a heading, the note that says what a board needs
// for the group to work, then its rows.
//
// One context dims rather than hides: a layer-tap's tap key is a *keycode*,
// since `&lt <n> <code>` wraps whatever the field holds - `&mkp LCLK` there
// would emit `&lt 2 LCLK` and build into nonsense. The media half of this tab is
// perfectly valid in that slot, so the tab stays (unlike VileDance and Layers,
// which `menuTarget()` excludes outright) and only the behaviors go dim.
export function System({ cur, onPick, kpOnly }:
    { cur: string; onPick: (b: string) => void; kpOnly: boolean }) {
  return <>
    {kpOnly &&
      <div className="pnote">A layer-tap's tap key has to be a plain keycode, so
        everything that is a behavior of its own is dimmed here.</div>}
    {SYSTEM.map((g) => (
      <div className="pgroup" key={g.name}>
        <h4>{g.name}</h4>
        {/* Authored in keycodes.ts, never user input. */}
        <div className="pnote" dangerouslySetInnerHTML={{ __html: g.note }} />
        {g.rows.map((r, i) => (
          <div className="prow" key={i}>
            {r.map((e, j) => (
              <PickerKey key={j} ent={e} cur={cur} onPick={onPick}
                         off={kpOnly && !!e[1] && e[1].startsWith("&")} />
            ))}
          </div>
        ))}
      </div>
    ))}
    <div className="hint">
      Every button here is a whole binding: with a key open it assigns straight
      away, exactly like the Keyboard tab. Nothing needs to be added to the
      keymap's <code>#include</code> lines by hand - saving a variant adds the{" "}
      <code>dt-bindings</code> headers the bindings you used need.
    </div>
  </>;
}

// ------------------------------------------------------------- saved things
// The bottom row of every tab that lists saved things. It opens that kind's
// creation panel in the editor area above - no navigation, nothing lost: the
// field you came from is still up there, and this menu still fills it.
//
// Clicking a key on the board closes whatever panel was open, so a half-typed
// draft would otherwise have no way back: `+ New` blanks it. Hence Resume,
// which appears when there is a dirty draft for this kind that is not on
// screen.
export function NewRow({ mode, label: lbl }: { mode: Mode; label: string }) {
  const { s, d } = useStore();
  const sp = useContext(StudioPickCtx);
  const draft = s.drafts[mode];
  const dirty = !sp && s.emode !== mode && isDirty(mode, draft);
  return (
    <div className="rowbtns">
      {dirty &&
        <button type="button" className="ghost sm"
                onClick={() => d({ t: "openPanel", mode })}>
          Resume {draft.name || "unnamed " + lbl}…
        </button>}
      <button type="button" className="ghost sm" disabled={!!sp} title={sp ? BUILD_TIP : undefined}
              onClick={() => d({ t: "openPanel", mode, draft: BLANK[mode]() })}>
        + New {lbl}…
      </button>
    </div>
  );
}

// A saved-things tab: click the card to fill the field, click its pencil to open
// the record in the editor area above.
function CardEdit({ mode, name }: { mode: Mode; name: string }) {
  const { s, d } = useStore();
  const sp = useContext(StudioPickCtx);
  const rec = recordOf(s.store, mode, name);
  return (
    <button type="button" className="pkedit" disabled={!!sp}
            title={sp ? BUILD_TIP : "edit " + name}
            onClick={() => rec && d({ t: "openPanel", mode,
                                      draft: JSON.parse(JSON.stringify(rec)) })}>
      ✎
    </button>
  );
}

// `bind` is what the card puts on a key, checked against the keyboard in Studio mode.
function Card({ mode, name, sel, title, main, up, bind, onClick }: {
  mode: Mode; name: string; sel: boolean; title: string;
  main: string; up: string; bind: string | string[]; onClick: () => void;
}) {
  const sp = useContext(StudioPickCtx);
  const whys = sp ? [bind].flat().map(sp.why) : [];
  const why = whys.length && whys.every(Boolean) ? whys[0] : null;
  return (
    <span className="pkg">
      <button type="button" className={"pk td" + (sel ? " sel" : "") + (why ? " na" : "")}
              disabled={!!why} title={why ? `${title}\n\n${why}` : title} onClick={onClick}>
        <span>{main}</span><span className="up">{up}</span>
      </button>
      <CardEdit mode={mode} name={name} />
    </span>
  );
}

export function ViledanceTab({ cur }: { cur: string }) {
  const { s, d } = useStore();
  const { pick } = usePick();
  const items: any[] = s.store.viledance || [];
  if (!items.length)
    return <>
      <div className="hint">No VileDances saved yet.</div>
      <NewRow mode="viledance" label="viledance" />
    </>;
  return <>
    <div className="tdlist">
      {items.map((t) => (
        <Card key={t.name} mode="viledance" name={t.name}
              sel={usesVd(cur, t.name)} title={vdTitle(t)}
              main={"&" + t.name} bind={[`&vd_${t.name}`, `&ht_${t.name}`]}
              up={[t.tap, t.hold, t.double_tap, t.tap_hold].filter(Boolean).join("  /  ")}
              onClick={async () => {
                const b = await previewBinding(d, "viledance", t);
                if (b !== null) pick(b);
              }} />
      ))}
    </div>
    <NewRow mode="viledance" label="viledance" />
  </>;
}

// A macro's key binding is always `&mc_<name>` - it does not depend on which
// fields are filled, the way a VileDance's does - so a card is an ordinary pick
// with no `/api/preview` round trip behind it.
export function MacroTab({ cur }: { cur: string }) {
  const { s } = useStore();
  const { pick } = usePick();
  const items: any[] = s.store.macro || [];
  if (!items.length)
    return <>
      <div className="hint">No macros saved yet. A macro is a sequence the
        keyboard plays back from one key: text, taps, a modifier held across
        them, a wait.</div>
      <NewRow mode="macro" label="macro" />
    </>;
  return <>
    <div className="tdlist">
      {items.map((m) => (
        <Card key={m.name} mode="macro" name={m.name}
              sel={macroBinding(m) === cur} title={macroTitle(m)}
              main={"&mc_" + m.name} up={macroSummary(m)} bind={macroBinding(m)}
              onClick={() => pick(macroBinding(m))} />
      ))}
    </div>
    <NewRow mode="macro" label="macro" />
  </>;
}

export function ModifierTab({ cur }: { cur: string }) {
  const { s, d } = useStore();
  const { pick } = usePick();
  const items: any[] = s.store.modifier || [];
  if (!items.length)
    return <>
      <div className="hint">No modifiers saved yet.</div>
      <NewRow mode="modifier" label="modifier" />
    </>;
  return <>
    <div className="tdlist">
      {items.map((m) => (
        <Card key={m.name} mode="modifier" name={m.name}
              sel={modBinding(m) === cur} title={modBinding(m)}
              main={m.name} up={modBinding(m)} bind={modBinding(m)}
              onClick={async () => {
                const b = await previewBinding(d, "modifier", m);
                if (b !== null) pick(b);
              }} />
      ))}
    </div>
    <NewRow mode="modifier" label="modifier" />
  </>;
}

// Two ways in, and the ad-hoc one comes first: `&mo` and `&lt` are built into
// ZMK, so a layer binding needs nothing saved anywhere. The saved cards below
// are names for the ones worth reusing. A conditional layer is never listed
// either way: it goes on no key.
export function LayerTab({ cur }: { cur: string }) {
  const { s, d } = useStore();
  const { pick, setField } = usePick();
  const sp = useContext(StudioPickCtx);
  const km = byId(s.data.keymaps, s.id);
  const rows = sp ? sp.layers
    : layerRows(layersOf(km, km ? s.newLayers[km.id] : [], s.layout));
  const code = ltCode(cur);
  const sel = (bind: string) => !!bind && bind === (cur || "").trim();

  // Four of the five rows are whole bindings, so they are ordinary picks. `&lt`
  // composes with the keycode the field already holds, so it has its own.
  const Cell = ({ n, name, bind }: { n: number; name: string; bind: string }) => {
    const why = sp && sp.why(bind);
    return (
      <button type="button" className={"pk" + (sel(bind) ? " sel" : "") + (why ? " na" : "")}
              style={{ width: 68 }} title={why ? `${bind}: ${why}` : bind} disabled={!!why}
              onClick={() => pick(bind)}>
        <span className="up">{name || "layer " + n}</span><span>{n}</span>
      </button>
    );
  };
  const LtCell = ({ n, name }: { n: number; name: string }) => {
    const bind = code ? `&lt ${n} ${code}` : "";
    const why = sp && sp.why(`&lt ${n} ${code || "A"}`);
    return (
      <button type="button" className={"pk" + (sel(bind) ? " sel" : "") + (why ? " na" : "")}
              style={{ width: 68 }} disabled={!!why}
              title={why ? `&lt: ${why}` : bind || `&lt ${n} <key>`}
              onClick={() => setField(`&lt ${n}${code ? " " + code : ""}`)}>
        <span className="up">{name || "layer " + n}</span><span>{n}</span>
      </button>
    );
  };
  const Row = ({ label: l, children }: { label: string; children: any }) => (
    <div className="prow">
      <span className="ptarget" style={{ width: 112 }}>{l}</span>{children}
    </div>
  );

  const items: any[] = (s.store.layer || [])
    .filter((r: any) => (r.mode || "lt") !== "conditional");

  return <>
    <div className="hint">
      Click a layer to fill the field - nothing has to be saved for this.{" "}
      <b>Hold</b> is <code>&amp;mo</code>, on only while it is held.{" "}
      <b>Tap key / hold layer</b> is <code>&amp;lt</code>, wrapping the key the
      field already holds
      {code ? <> - right now <code>{code}</code>.</>
            : <>, so pick one on the <b>Keyboard</b> tab first (or type it in).</>}
      {" "}<b>Sticky</b> is <code>&amp;sl</code>: one shot, for the next key only.{" "}
      <b>Toggle</b> is <code>&amp;tog</code>: on until it is pressed again.{" "}
      <b>Switch to</b> is <code>&amp;to</code>: on, and every other layer off -
      which is a one-way trip unless the layer you land on can get back.
    </div>
    <Row label="Hold">{rows.map(([n, nm]) =>
      <Cell key={n} n={n} name={nm} bind={`&mo ${n}`} />)}</Row>
    <Row label="Tap key / hold layer">{rows.map(([n, nm]) =>
      <LtCell key={n} n={n} name={nm} />)}</Row>
    <Row label="Sticky">{rows.map(([n, nm]) =>
      <Cell key={n} n={n} name={nm} bind={`&sl ${n}`} />)}</Row>
    <Row label="Toggle">{rows.map(([n, nm]) =>
      <Cell key={n} n={n} name={nm} bind={`&tog ${n}`} />)}</Row>
    <Row label="Switch to">{rows.map(([n, nm]) =>
      <Cell key={n} n={n} name={nm} bind={`&to ${n}`} />)}</Row>
    {!!items.length &&
      <div className="tdlist">
        {items.map((r) => (
          <Card key={r.name} mode="layer" name={r.name}
                sel={usesLayer(cur, r)} title={layerTitle(r)}
                main={r.name} up={layerBinding(r)} bind={layerBinding(r)}
                onClick={async () => {
                  const b = await previewBinding(d, "layer", r);
                  if (b !== null) pick(b);
                }} />
        ))}
      </div>}
    <NewRow mode="layer" label="layer-tap" />
  </>;
}

// ------------------------------------------------------ the board-wide tabs
// Neither a combo nor a conditional layer goes on a key, so neither tab fills
// anything: a row is a switch plus a way into its record. `enabled` is exactly
// what `build_variant()` already reads - on means it is written into the next
// variant, off means it is left out.
function BRow({ mode, r, sub, scope }:
    { mode: Mode; r: any; sub: string; scope: string }) {
  const { s, d } = useStore();
  const on = scopeOn(r, scope);
  const open = s.emode === mode && (draftOf(s, mode).name || "") === r.name;
  const elsewhere = Object.keys(r.scopes || {})
    .filter((k) => r.scopes[k] && k !== scope);
  return (
    <div className={"brow" + (on ? "" : " off") + (open ? " sel" : "")}>
      <button type="button" className={"tgl " + (on ? "on" : "off")}
              title={(on ? "written into this keymap's variant"
                         : "left out of this keymap's variant")
                     + (elsewhere.length ? "\n\nalso on for: " + elsewhere.join(", ") : "")}
              onClick={() => toggleScope(s, d, mode, r.name)}>
        {on ? "On" : "Off"}
      </button>
      <button type="button" className="bopen"
              onClick={() => d({ t: "openPanel", mode,
                                 draft: JSON.parse(JSON.stringify(r)) })}>
        <span className="nm">{r.name}</span><small>{sub}</small>
      </button>
    </div>
  );
}

// Which keymap these switches are answering for. A config or vendor keymap is
// never written to (only `variants/` is ours), so there the switches describe
// the variant about to be saved from it; the flags follow that variant under
// its own name.
function ScopeNote() {
  const { s } = useStore();
  const km = byId(s.data.keymaps, s.id);
  if (!km) return <div className="hint">Pick a keyboard on the left first.</div>;
  return (
    <div className="hint">
      These switches are <b>for {km.name}</b> only
      {km.kind === "variant"
        ? <> – each saved variant keeps its own set.</>
        : <> – <code>{km.kind}</code> keymaps are never written to, so what is On
            here is what goes into the next variant you save from it, and stays
            On for that variant afterwards.</>}
    </div>
  );
}

function BoardList({ mode, items, sub, label: lbl }:
    { mode: Mode; items: any[]; sub: (r: any) => string; label: string }) {
  const { s } = useStore();
  const scope = scopeOf(byId(s.data.keymaps, s.id));
  return <>
    {items.length
      ? <div className="blist">
          {items.map((r) => (
            <BRow key={r.name} mode={mode} r={r} sub={sub(r)} scope={scope} />
          ))}
        </div>
      : <div className="hint">nothing saved yet</div>}
    <NewRow mode={mode} label={lbl} />
  </>;
}

export function ComboTab() {
  const { s } = useStore();
  return <>
    <div className="hint">
      A combo is <b>board-wide</b>: press two or more keys together, anywhere. It
      sits on no key of its own, so there is nothing to pick here - switch one{" "}
      <b>On</b> and it goes into this keymap's variant, <b>Off</b> and it is left
      out. Click a row to edit it; the board above is where its chord is chosen.
    </div>
    <ScopeNote />
    <BoardList mode="combo" items={s.store.combo || []} label="combo"
               sub={(r) => `${(r.key_positions || []).join(" + ")} → ${r.binding || "?"}`} />
  </>;
}

export function ConditionalTab() {
  const { s } = useStore();
  const items = (s.store.layer || [])
    .filter((r: any) => (r.mode || "lt") === "conditional");
  return <>
    <div className="hint">
      A conditional layer is <b>board-wide</b> too: hold <b>all</b> of its
      if-layers at once and the then-layer comes on top - the tri-layer trick.
      Nothing references it, so nothing can pull it in for you: <b>On</b> writes
      it into this keymap's variant, <b>Off</b> leaves it out.
    </div>
    <ScopeNote />
    <BoardList mode="conditional" items={items} label="conditional layer"
               sub={(r) => `hold ${(r.if_layers || []).join(" + ")} → layer ${r.then_layer ?? "?"}`} />
  </>;
}

export function PickerBody({ cur, ptab }: { cur: string; ptab: string }) {
  const { s } = useStore();
  const { pick } = usePick();
  const sp = useContext(StudioPickCtx);
  const kpOnly = !sp && s.editing === null && s.emode === "layer";
  switch (ptab) {
    case "system": return <System cur={cur} onPick={pick} kpOnly={kpOnly} />;
    case "viledance": return <ViledanceTab cur={cur} />;
    case "macro": return <MacroTab cur={cur} />;
    case "modifier": return <ModifierTab cur={cur} />;
    case "layer": return <LayerTab cur={cur} />;
    case "combo": return <ComboTab />;
    case "conditional": return <ConditionalTab />;
    default: return <Grid cur={cur} onPick={pick} />;
  }
}
