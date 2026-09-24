import { useState, useSyncExternalStore, type ReactNode } from "react";

import { Help } from "./Help";
import { Modal } from "./Modal";

export interface Ask {
  title: string; body?: ReactNode; ok?: string; danger?: boolean;
  /** Only an OK button: the dialog tells, it does not ask. */
  info?: boolean;
  /** A second action beside OK, in the danger colour, explained by `tip`. */
  extra?: { label: string; tip: ReactNode };
  /** A text box under the body; `askText` resolves with what it holds. */
  field?: { value: string; placeholder?: string };
}

/** `"extra"` when the `extra` button was clicked. */
export type Answer = boolean | "extra";

type Pending = Ask & { done: (a: Answer, text?: string) => void };

let pending: Pending | null = null;
const subs = new Set<() => void>();
const set = (p: Pending | null) => { pending = p; subs.forEach((f) => f()); };

/** The page's `confirm()`: resolves true on the confirm button, false otherwise.
 *  Needs `<ConfirmHost />` mounted once. */
export function ask(a: Ask & { extra?: undefined }): Promise<boolean>;
export function ask(a: Ask): Promise<Answer>;
export function ask(a: Ask): Promise<Answer> {
  pending?.done(false);
  return new Promise((resolve) => set({ ...a, done: (ans) => {
    set(null);
    resolve(ans);
  } }));
}

/** The page's `prompt()`: the trimmed text on OK, null on cancel or empty. */
export function askText(a: Ask & { field: NonNullable<Ask["field"]> }):
    Promise<string | null> {
  pending?.done(false);
  return new Promise((resolve) => set({ ...a, done: (ans, text) => {
    set(null);
    resolve(ans === true && text?.trim() ? text.trim() : null);
  } }));
}

export function ConfirmHost() {
  const p = useSyncExternalStore(
    (f) => { subs.add(f); return () => { subs.delete(f); }; }, () => pending);
  const [text, setText] = useState("");
  const [shown, setShown] = useState<Pending | null>(null);
  if (p !== shown) { setShown(p); setText(p?.field?.value ?? ""); }
  if (!p) return null;
  const no = () => p.done(false);
  const yes = () => p.done(true, text);
  return (
    <Modal onClose={no} className="confirm"
           onKeyDown={(e) => { if (e.key === "Escape") no(); }}>
      <h2>{p.title}</h2>
      {p.body && <div className="body">{p.body}</div>}
      {p.field &&
        <input className="kb wide field" value={text} autoFocus autoComplete="off"
               placeholder={p.field.placeholder}
               onFocus={(e) => e.target.select()}
               onChange={(e) => setText(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) yes(); }} />}
      <div className="bar actions">
        {!p.info &&
          <button className="ghost" autoFocus={p.danger} onClick={no}>Cancel</button>}
        {p.extra && <>
          <button className="ghost danger" onClick={() => p.done("extra")}>
            {p.extra.label}</button>
          <Help label={`what ${p.extra.label} does`}>{p.extra.tip}</Help>
        </>}
        <button className={p.danger ? "ghost danger" : "act"}
                autoFocus={!p.danger && !p.field}
                disabled={!!p.field && !text.trim()} onClick={yes}>{p.ok ?? "OK"}</button>
      </div>
    </Modal>);
}
