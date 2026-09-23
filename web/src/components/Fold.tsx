import { useId, type ReactNode } from "react";

/** A `section.card` whose body collapses under a clickable heading. `summary`
 *  shows beside the heading while it is closed. */
export function Fold({ title, open, onToggle, summary, children }:
    { title: string; open: boolean; onToggle: (open: boolean) => void;
      summary?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className={open ? "card fold open" : "card fold"}>
      <button className="foldhead" aria-expanded={open} aria-controls={id}
              onClick={() => onToggle(!open)}>
        <span className="chev">{"›"}</span>
        <h3>{title}</h3>
        {!open && summary && <span className="foldsum">{summary}</span>}
      </button>
      {open && <div id={id} className="foldbody">{children}</div>}
    </section>
  );
}
