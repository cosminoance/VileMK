import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export type DropItem = { label: ReactNode; onPick: () => void; danger?: boolean };

/** A button that opens a short list of actions under it. Closes on a pick,
 *  a click elsewhere, or Escape. */
export function Dropdown({ label, items, className = "act" }:
    { label: ReactNode; items: DropItem[]; className?: string }) {
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
              aria-controls={id} onClick={() => setOpen(!open)}>
        {label} <span className="caret">{"▾"}</span>
      </button>
      {open &&
        <div className="dropmenu" role="menu" id={id}>
          {items.map((it, i) => (
            <button key={i} role="menuitem" className={it.danger ? "danger" : ""}
                    onClick={() => { setOpen(false); it.onPick(); }}>
              {it.label}
            </button>
          ))}
        </div>}
    </span>
  );
}
