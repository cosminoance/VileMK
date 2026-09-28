import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/** `title` says why a `disabled` item is off. */
export type DropItem = { label: ReactNode; onPick: () => void; danger?: boolean;
                         disabled?: boolean; title?: string };

/** A button that opens a short list of actions under it. Closes on a pick,
 *  a click elsewhere, or Escape. An icon-only button passes `title` (its name)
 *  and `caret={false}`; `end` aligns the menu to the button's right edge. */
export function Dropdown({ label, items, className = "act", title, caret = true, end }:
    { label: ReactNode; items: DropItem[]; className?: string; title?: string;
      caret?: boolean; end?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <span className="drop" ref={box}>
      <button className={className} aria-haspopup="menu" aria-expanded={open}
              aria-controls={id} title={title} aria-label={title}
              onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        {label}{caret && <> <span className="caret">{"▾"}</span></>}
      </button>
      {open &&
        <div className={"dropmenu" + (end ? " end" : "")} role="menu" id={id}>
          {items.map((it, i) => (
            <button key={i} role="menuitem" className={it.danger ? "danger" : ""}
                    disabled={it.disabled} title={it.title}
                    onClick={() => { setOpen(false); it.onPick(); }}>
              {it.label}
            </button>
          ))}
        </div>}
    </span>
  );
}
