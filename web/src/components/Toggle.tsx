import type { ReactNode } from "react";

/** A checkbox with its label, the app's one on/off control inside a bar. */
export function Toggle({ checked, onChange, disabled, children }:
    { checked: boolean; onChange: (on: boolean) => void; disabled?: boolean;
      children: ReactNode }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} disabled={disabled}
             onChange={(e) => onChange(e.target.checked)} />
      {" "}{children}
    </label>
  );
}
