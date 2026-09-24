import { useSyncExternalStore, type ReactNode } from "react";

import { Modal } from "./Modal";

export interface Ask {
  title: string; body?: ReactNode; ok?: string; danger?: boolean;
}

type Pending = Ask & { done: (yes: boolean) => void };

let pending: Pending | null = null;
const subs = new Set<() => void>();
const set = (p: Pending | null) => { pending = p; subs.forEach((f) => f()); };

/** The page's `confirm()`: resolves true on the confirm button, false otherwise.
 *  Needs `<ConfirmHost />` mounted once. */
export function ask(a: Ask): Promise<boolean> {
  pending?.done(false);
  return new Promise((resolve) => set({ ...a, done: (yes) => {
    set(null);
    resolve(yes);
  } }));
}

export function ConfirmHost() {
  const p = useSyncExternalStore(
    (f) => { subs.add(f); return () => { subs.delete(f); }; }, () => pending);
  if (!p) return null;
  const no = () => p.done(false);
  return (
    <Modal onClose={no} className="confirm"
           onKeyDown={(e) => { if (e.key === "Escape") no(); }}>
      <h2>{p.title}</h2>
      {p.body && <div className="body">{p.body}</div>}
      <div className="bar actions">
        <button className="ghost" autoFocus={p.danger} onClick={no}>Cancel</button>
        <button className={p.danger ? "ghost danger" : "act"} autoFocus={!p.danger}
                onClick={() => p.done(true)}>{p.ok ?? "OK"}</button>
      </div>
    </Modal>);
}
