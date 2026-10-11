// The vile slots settings of a variant's build: how the hidden slots layer is
// split between four-way viledances, two-way ones and combo outputs, and the
// timing every slot viledance shares.

import { useState } from "react";

import { buildChoices, keyCount } from "../lib/keymaps";
import {
  FLAVORS, offTiming, slotDefaults, slotsBlock, slotsUsed, vdShape, type Slots,
} from "../lib/slots";
import { useStore } from "../state/store";
import { Help } from "./Help";
import { Modal } from "./Modal";

export function SlotsSheet({ km, close }: { km: any; close: () => void }) {
  const { s, d } = useStore();
  const keys = keyCount(km);
  const [v, setV] = useState<Slots>(buildChoices(s, km).slots || slotDefaults(keys));
  const block = slotsBlock(v, keys);
  const recs = km.records || { viledance: [], combo: [] };
  const has = {
    four: recs.viledance.filter((r: any) => vdShape(r) === "four").length,
    two: recs.viledance.filter((r: any) => vdShape(r) === "two").length,
    combos: recs.combo.length,
  };
  const off = offTiming(recs.viledance, v);
  const set = (k: keyof Slots, x: string) =>
    setV({ ...v, [k]: k.startsWith("flavor") ? x : x === "" ? 0 : Number(x) });

  const count = (k: "four" | "two" | "combos", label: string, each: number) => (
    <div className="slot">
      <span>{label}</span>
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
        {count("four", "Four-way viledances", 4)}
        {count("two", "Two-way viledances", 2)}
        {count("combos", "Combo outputs", 1)}
        <p className={block ? "msg bad" : "legend"}>
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
        <p className="legend">A viledance with a second press (double tap) takes a four-way
          container; one with only tap and hold takes two slots. One that does not fit stays
          compiled, and changing it needs a build.</p>
      </div>
      <div className="bar actions">
        <button className="ghost" onClick={() => setV(slotDefaults(keys))}>Defaults</button>
        <button className="ghost push" onClick={close}>Cancel</button>
        <button className="act" disabled={!!block}
                onClick={() => { d({ t: "slots", kmId: km.id, slots: v }); close(); }}>
          Use these</button>
      </div>
    </Modal>
  );
}
