import { useId, type ReactNode } from "react";

/** A `section.card` whose body collapses under a clickable heading. `summary`
 *  shows beside the heading while it is closed; `actions` sit at the heading's
 *  right, open or closed. `accent` marks a fold the user
 *  should not miss: accent border and title, and a blinking cursor while closed. */
export function Fold({ title, open, onToggle, summary, accent, actions, children }:
    { title: string; open: boolean; onToggle: (open: boolean) => void;
      summary?: ReactNode; accent?: boolean; actions?: ReactNode; children: ReactNode }) {
  const id = useId();
  const cls = ["card fold", open && "open", accent && "accent"].filter(Boolean).join(" ");
  return (
    <section className={cls}>
      <div className="foldrow">
        <button className="foldhead" aria-expanded={open} aria-controls={id}
                onClick={() => onToggle(!open)}>
          <span className="chev">{"›"}</span>
          <h3>{title}</h3>
          {accent && !open && <span className="cursor" aria-hidden="true" />}
          {!open && summary && <span className="foldsum">{summary}</span>}
        </button>
        {actions && <span className="foldacts">{actions}</span>}
      </div>
      {open && <div id={id} className="foldbody">{children}</div>}
    </section>
  );
}
