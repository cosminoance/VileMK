import { useId, useState, type CSSProperties, type ReactNode } from "react";

/** The `?` circle. Inherits its colour from the text around it. */
export function QMark() {
  return <span className="q" aria-hidden="true">?</span>;
}

/**
 * A `?` that shows `children` on hover or keyboard focus. Place it beside the
 * control it explains, not inside its `<label>`, or clicking it toggles that
 * control.
 */
export function Help({ children, label = "help" }:
    { children: ReactNode; label?: string }) {
  const id = useId();
  const [at, setAt] = useState<CSSProperties>({});
  // Fixed and clamped inside the window, so a scrolling or clipped parent
  // cannot cut it off. Below the mark, or above when there is no room.
  const place = (e: { currentTarget: HTMLElement }) => {
    const r = e.currentTarget.getBoundingClientRect();
    const w = Math.min(300, window.innerWidth * 0.8);
    const left = Math.max(8, Math.min(r.right + 8 - w, window.innerWidth - w - 8));
    setAt(window.innerHeight - r.bottom > 200
      ? { left, top: r.bottom + 6, bottom: "auto" }
      : { left, top: "auto", bottom: window.innerHeight - r.top + 6 });
  };
  return (
    <span className="qhelp" tabIndex={0} aria-label={label} aria-describedby={id}
          onMouseEnter={place} onFocus={place}>
      <QMark />
      <span className="tip" id={id} role="tooltip" style={at}>{children}</span>
    </span>
  );
}
