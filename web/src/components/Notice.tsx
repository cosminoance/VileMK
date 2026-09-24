import type { Msg } from "../state/store";

/** A status line with a button that dismisses it. */
export function Notice({ msg, close }: { msg: Msg; close: () => void }) {
  return (
    <div className={"msg notice " + (msg.bad ? "bad" : "ok")}>
      <span>{msg.text}</span>
      <button className="x" title="Dismiss" aria-label="Dismiss" onClick={close}>×</button>
    </div>
  );
}
