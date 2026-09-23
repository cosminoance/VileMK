import { useId, type ReactNode } from "react";

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
  return (
    <span className="qhelp" tabIndex={0} aria-label={label} aria-describedby={id}>
      <QMark />
      <span className="tip" id={id} role="tooltip">{children}</span>
    </span>
  );
}
