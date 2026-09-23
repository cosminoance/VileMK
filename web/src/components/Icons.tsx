/** Line icons drawn in `currentColor`, so they follow the text color and the
 *  theme. Decorative: the button carrying one names itself. */
export function PictureIcon() {
  return (
    <svg className="icon" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"
         fill="none" stroke="currentColor" strokeWidth="1.4"
         strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <circle cx="5.5" cy="6" r="1.3" />
      <path d="M14.5 11 10.5 7 3 13.5" />
    </svg>
  );
}
