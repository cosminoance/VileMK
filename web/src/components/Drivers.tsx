// The drivers a module's own `config/west.yml` fetches that ours lacks: a tick
// and a branch or tag per driver. The keyboards sheet shows them after a module
// is added, the build sheet before a build that needs them.

import { useState, type ReactNode } from "react";

import { api } from "../lib/api";
import { Toggle } from "./Toggle";

export interface Driver {
  name: string; url: string; revision: string;
  refs: { ref: string; kind: "vendor" | "zmk" | "release" }[];
  pick: string; why: string; error?: string;
}

export type Picked = { d: Driver; ref: string }[];

const REF_LABEL: Record<Driver["refs"][number]["kind"], string> = {
  vendor: "the vendor's", zmk: "for a ZMK version", release: "release",
};

/** Fetches each picked driver as a module, in turn. `done` gets each name as
 *  it lands; a failure throws and stops there. */
export async function fetchDrivers(picked: Picked, done: (name: string) => void) {
  for (const { d, ref } of picked) {
    await api("POST", "/api/module", { url: d.url, ref, name: d.name });
    done(d.name);
  }
}

/** The rows, with `actions` given what is ticked. `on` is every tick's start. */
export function DriverList({ list, busy, on: start = false, actions }:
    { list: Driver[]; busy: boolean; on?: boolean;
      actions: (picked: Picked) => ReactNode }) {
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [refs, setRefs] = useState<Record<string, string>>({});
  const refOf = (dr: Driver) => refs[dr.name] ?? dr.pick;
  const ticked = (dr: Driver) => on[dr.name] ?? start;
  const picked = list.filter((dr) => ticked(dr) && refOf(dr))
    .map((dr) => ({ d: dr, ref: refOf(dr) }));
  return <>
    <ul className="ilist drivers">
      {list.map((dr) => (
        <li key={dr.name} className="irow">
          <Toggle checked={ticked(dr)} disabled={busy}
                  onChange={(v) => setOn((o) => ({ ...o, [dr.name]: v }))}>
            <span className="nm">{dr.name}</span>
          </Toggle>
          <span className="path">{dr.url.replace(/^https:\/\/github\.com\//, "")}</span>
          <select className="push" value={refOf(dr)} disabled={busy}
                  aria-label={`branch or tag of ${dr.name}`}
                  onChange={(e) => setRefs((r) => ({ ...r, [dr.name]: e.target.value }))}>
            {dr.refs.map((r) => <option key={r.ref} value={r.ref}>
              {r.ref} · {REF_LABEL[r.kind]}
            </option>)}
          </select>
          {dr.why && <span className="note">{dr.why}</span>}
          {dr.error && <span className="note">could not list its branches: {dr.error}</span>}
        </li>))}
    </ul>
    {actions(picked)}
  </>;
}
