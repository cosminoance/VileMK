import type { ReactNode } from "react";

/** A checkbox with its label, the app's one on/off control inside a bar. */
export function Toggle({ checked, onChange, children }:
    { checked: boolean; onChange: (on: boolean) => void; children: ReactNode }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked}
             onChange={(e) => onChange(e.target.checked)} />
      {" "}{children}
    </label>
  );
}
