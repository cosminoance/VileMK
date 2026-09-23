// A physical layout gives each key `[w, h, x, y, rot, rx, ry]` in keyboard
// units, with `rot` in hundredths of a degree about the point `(rx, ry)`. In
// board coordinates that point is `((rx-x0)*S, (ry-y0)*S)`, which is what
// `rotate(deg cx cy)` takes.

import type { RefObject } from "react";

import { resolveBinding } from "../lib/labels";

const S = 0.50;   // keyboard units to pixels
const PAD = 6;

const LBL = 11, SHIFT = 9, SMALL = 9;
const LINE = 1.15;
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

// SVG text does not wrap, so labels are measured and broken here. A canvas
// context reports the advance widths the renderer will use, which beats
// guessing an average character width and breaking a word that would have fit.
const CTX = document.createElement("canvas").getContext("2d");
function width(text: string, size: number): number {
  if (!CTX) return text.length * size * 0.6;
  CTX.font = `${size}px ${MONO}`;
  return CTX.measureText(text).width;
}

// How many characters of `text` fit in `innerW`, at least one.
function cut(text: string, innerW: number, size: number): number {
  let n = text.length;
  while (n > 1 && width(text.slice(0, n), size) > innerW) n--;
  return n;
}

// Break between words where that works, through a word when it does not.
// Three lines is what a key this size can show.
function fit(text: string, innerW: number): string[] {
  const lines: string[] = [];
  let rest = text;
  while (rest && lines.length < 3) {
    if (width(rest, LBL) <= innerW) { lines.push(rest); rest = ""; break; }
    const hard = cut(rest, innerW, LBL);
    const space = rest.lastIndexOf(" ", hard);
    const at = space > 0 ? space : hard;
    lines.push(rest.slice(0, at));
    rest = rest.slice(space > 0 ? at + 1 : at);
  }
  if (rest && lines.length === 3)
    lines[2] = lines[2].slice(0, Math.max(1, cut(lines[2], innerW - width("…", LBL), LBL))) + "…";
  return lines.length ? lines : [""];
}

// One line, cut to fit.
function clip(text: string, innerW: number, size: number): string {
  if (width(text, size) <= innerW) return text;
  const n = cut(text, innerW - width("…", size), size);
  return text.slice(0, Math.max(1, n)) + "…";
}

// The extent of the board in keyboard units. A rotated key sticks out past its
// own origin, so the box is the four corners of every key *after* rotation -
// taking the min/max of the origins alone cuts the thumb clusters off.
function bounds(keys: number[][]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [kw, kh, kx, ky, rot, rx, ry] of keys) {
    const a = ((rot || 0) / 100) * (Math.PI / 180);
    const cos = Math.cos(a), sin = Math.sin(a);
    const corners = [[kx, ky], [kx + kw, ky], [kx, ky + kh], [kx + kw, ky + kh]];
    for (const [px, py] of corners) {
      let X = px, Y = py;
      if (a) {
        const dx = px - rx, dy = py - ry;
        X = rx + dx * cos - dy * sin;
        Y = ry + dx * sin + dy * cos;
      }
      x0 = Math.min(x0, X); x1 = Math.max(x1, X);
      y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
    }
  }
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

export interface BoardProps {
  km: any;
  lay: any;
  bindings: string[];
  baseBindings: string[] | null;
  /** Pending edits for the layer on screen, by key position. */
  assign: Record<number, string>;
  nums: boolean;
  hot: number[] | null;
  /** The combo draft's positions, when a combo panel is open. */
  sel: number[];
  editing: number | null;
  /** Null when the page is read-only: no key is clickable. */
  onKey: ((pos: number) => void) | null;
  /** Taken by the export dialog, which serialises the board it renders. */
  svgRef?: RefObject<SVGSVGElement | null>;
}

export function Board({ km, lay, bindings, baseBindings, assign, nums, hot,
                        sel, editing, onKey, svgRef }: BoardProps) {
  const keys: number[][] = lay.keys;
  const { x0, y0, w, h } = bounds(keys);

  return (
    <svg ref={svgRef} className="board" width={w * S + PAD} height={h * S + PAD}
         viewBox={`0 0 ${w * S + PAD} ${h * S + PAD}`}>
      <g transform={`translate(${PAD / 2} ${PAD / 2})`}>
      {keys.map((k, i) => {
        const [kw, kh, kx, ky, rot, rx, ry] = k;
        const pend = assign[i];
        const b = pend !== undefined ? pend : bindings[i];
        const old = baseBindings ? baseBindings[i] : undefined;

        const cls = ["k"];
        if (b === undefined) cls.push("empty");
        const diff = old !== undefined && old !== b;
        if (diff) cls.push("diff");
        if (hot && hot.includes(i)) cls.push("hot");
        if (sel.includes(i)) cls.push("pick");
        if (pend !== undefined) cls.push("asg");
        if (onKey) cls.push("clickable");
        if (editing === i) cls.push("hot");

        const res = b !== undefined ? resolveBinding(km, b, 3) : null;
        if (res && res.hint) cls.push("compound");
        const oldRes = old !== undefined ? resolveBinding(km, old, 3) : null;
        const tip = res
          ? (res.full !== b ? `${res.full}\n\n${b}  @ ${i}` : `${b}  @ ${i}`)
          : `@ ${i}`;

        const x = (kx - x0) * S, y = (ky - y0) * S;
        const W = kw * S - 2, H = kh * S - 2;
        const cx = x + W / 2;
        // `.k.diff .lbl` lifted the label block 4px to clear the `was` line.
        const cy = y + H / 2 - (diff ? 4 : 0);
        const shift = res && res.shift && res.shift !== res.short ? res.shift : "";
        const lines = fit(res ? res.short : "", W - 4);
        // The label block centres on `cy`; a shift legend sits one line above
        // it, so the block itself moves down by half a line to compensate.
        const step = LBL * LINE;
        const top = cy - ((lines.length - 1) * step) / 2 + (shift ? SHIFT * 0.6 : 0);

        return (
          <g key={i} className={cls.join(" ")}
             transform={rot ? `rotate(${rot / 100} ${(rx - x0) * S} ${(ry - y0) * S})` : undefined}
             onClick={onKey ? () => onKey(i) : undefined}>
            <title>{tip}</title>
            <rect x={x} y={y} width={W} height={H} rx={5} />
            {nums && <text className="pos" x={x + 3} y={y + 9}>{i}</text>}
            {res?.hint &&
              <text className="hint" x={x + W - 3} y={y + 9} textAnchor="end">
                {res.hint}
              </text>}
            {shift &&
              <text className="shift" x={cx} y={top - step} fontSize={SHIFT}
                    textAnchor="middle" dominantBaseline="central">{shift}</text>}
            {lines.map((ln, li) => (
              <text key={li} className="lbl" x={cx} y={top + li * step}
                    fontSize={LBL} textAnchor="middle"
                    dominantBaseline="central">{ln}</text>
            ))}
            {diff &&
              <text className="was" x={cx} y={y + H - SMALL / 2 - 2} fontSize={SMALL}
                    textAnchor="middle" dominantBaseline="central">
                {clip(`was ${oldRes ? oldRes.short : ""}`, W - 2, SMALL)}
              </text>}
          </g>
        );
      })}
      </g>
    </svg>
  );
}
