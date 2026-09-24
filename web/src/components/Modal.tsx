import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A `.sheet` over a `.modal` backdrop, mounted on `<body>`. Mounted where it
 * is opened, a sheet inherits that place's rules and stacking: inside the
 * sidebar every button went full width and the variant bar drew over it.
 */
export function Modal({ onClose, className = "", onKeyDown, children }: {
  onClose?: () => void; className?: string;
  onKeyDown?: (e: KeyboardEvent) => void; children: ReactNode;
}) {
  return createPortal(
    <div className="modal" onClick={onClose}>
      <div className={("sheet " + className).trim()} onKeyDown={onKeyDown}
           onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body);
}
