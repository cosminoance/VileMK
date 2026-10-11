// The vile slots settings of a variant's build: how the hidden slots layer is
// split between four-way viledances, two-way ones and combo outputs, and the
// timing every slot viledance shares.

import { useState } from "react";

import { buildChoices, keyCount, scopeOf, scopeOn, scopeReserved } from "../lib/keymaps";
import {
  FLAVORS, fitSlots, offTiming, slotDefaults, slotsBlock, slotsUsed, vdShape, type Slots,
} from "../lib/slots";
import { useStore } from "../state/store";
import { Help } from "./Help";
import { Modal } from "./Modal";
import { ReservedHelp } from "./Picker";

export function SlotsSheet({ km, close }: { km: any; close: () => void }) {
  const { s, d } = useStore();
  const keys = keyCount(km);
  // Every combo On or Reserved for this keymap gets a slot; the user picks no count.
  const scope = scopeOf(km);
  const combos = (s.store.combo || []).filter((r: any) => scopeOn(r, scope)
    || (scopeReserved(r, scope) && (r.key_positions || []).every((p: number) => p < keys)));
  const reserved = combos.filter((r: any) => !scopeOn(r, scope)).map((r: any) => r.name);
  const [raw, setV] = useState<Slots>(buildChoices(s, km).slots || slotDefaults(keys));
  const { s: v, dropped } = fitSlots({ ...raw, combos: combos.length }, keys);
  const block = combos.length > keys
    ? `${combos.length} combos need more slots than the ${keys} the keyboard has`
    : slotsBlock(v, keys);
  const recs = km.records || { viledance: [], combo: [] };
  const has = {
    four: recs.viledance.filter((r: any) => vdShape(r) === "four").length,
    two: recs.viledance.filter((r: any) => vdShape(r) === "two").length,
    combos: combos.length,
  };
  const off = offTiming(recs.viledance, v);
  const set = (k: keyof Slots, x: string) =>
    setV({ ...v, [k]: k.startsWith("flavor") ? x : x === "" ? 0 : Number(x) });
  const tie = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const count = (k: "four" | "two" | "combos", label: string, each: number,
                 help?: React.ReactNode) => (
    <div className="slot">
      <span>{label}{help}</span>
      <input className="kb sm" type="number" min={0} value={v[k]}
             max={Math.floor((keys - slotsUsed(v) + v[k] * each) / each)}
             onChange={(e) => set(k, e.target.value)} />
      <span className="path">{each} slot{each > 1 ? "s" : ""} each · {km.name} has {has[k]}
        {has[k] > v[k] ? `, ${has[k] - v[k]} stay compiled` : ""}</span>
    </div>);
  const flavor = (k: "flavor" | "flavor2", label: string) => (
    <div className="slot">
      <span>{label}</span>
      <select className="kb wide" value={v[k]} onChange={(e) => set(k, e.target.value)}>
        {FLAVORS.map((f) => <option key={f}>{f}</option>)}
      </select>
    </div>);

  return (
    <Modal onClose={close} className="confirm slotsheet"
           onKeyDown={(e) => { if (e.key === "Escape") close(); }}>
      <h2>Vile slots</h2>
      <div className="body">
        <p>The build adds one hidden layer of {keys} slots. Whatever sits in a slot can be
          changed from Studio mode with no build. Split the slots between:</p>
        {count("four", "Four-way viledances", 4,
          <Help label="which viledances take which slots">
            A viledance with a second press (double tap) takes a four-way container; one with
            only tap and hold takes two slots. One that does not fit stays compiled, and
            changing it needs a build.
          </Help>)}
        {count("two", "Two-way viledances", 2)}
        <div className="slot">
          <span>Combo outputs</span>
          <span className="kb sm">{combos.length}</span>
          <span className="path">1 slot per On or Reserved combo <ReservedHelp /></span>
        </div>
        {!!reserved.length &&
          <div className="warn">Reserved, keys pressed together do nothing:
            {" "}{reserved.join(", ")}</div>}
        {!!dropped &&
          <div className="warn">Combos take {tie(dropped, "viledance slot")} (four-way
            first).</div>}
        <p className={block ? "msg bad" : "legend slotcount"}>
          {block || `${slotsUsed(v)} of ${keys} slots used, ${keys - slotsUsed(v)} left.`}</p>
        <div className="slot">
          <span>Tapping term (ms)</span>
          <input className="kb sm" type="number" min={1} value={v.term}
                 onChange={(e) => set("term", e.target.value)} />
        </div>
        {flavor("flavor", "First press flavor")}
        {flavor("flavor2", "Second press flavor")}
        <Help label="what the flavors mean">
          A flavor decides tap or hold when another key is pressed before the tapping term
          ends. hold-preferred: hold as soon as another key is pressed. balanced: hold when
          another key is pressed and released while this one is down. tap-preferred: hold
          only once the term passes. tap-unless-interrupted: hold only if another key is
          pressed before the term ends. The second press defaults to balanced so a held
          layer on it engages at once.
        </Help>
        {!!off.length &&
          <div className="warn">{off.join(", ")} {off.length > 1 ? "have their" : "has its"} own
            timing. In slots every viledance uses the timing above.</div>}
        <p className="legend">Slots full: lower a viledance count to fit more combos.</p>
      </div>
      <div className="bar actions">
        <button className="ghost" onClick={() => setV(fitSlots({
          ...slotDefaults(keys), combos: combos.length }, keys).s)}>Defaults</button>
        <button className="ghost push" onClick={close}>Cancel</button>
        <button className="act" disabled={!!block}
                onClick={() => { d({ t: "slots", kmId: km.id, slots: v }); close(); }}>
          Use these</button>
      </div>
    </Modal>
  );
}
