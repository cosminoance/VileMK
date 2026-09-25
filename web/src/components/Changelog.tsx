import { useState, type ReactNode } from "react";

import ver from "../../../version/version.json";
import { QMark } from "./Help";
import { Modal } from "./Modal";

// The notes live in changelog/x.y.z.md at the repo root, one file per version,
// hand-written in the pull request that ships them. They are bundled here
// rather than fetched, so the page has them without a server round trip and a
// wheel carries them.
const FILES = import.meta.glob("../../../changelog/*.md",
  { query: "?raw", eager: true, import: "default" }) as Record<string, string>;

type Entry = { version: string; lines: string[] };

const rank = (v: string) =>
  v.split(".").reduce((n, part) => n * 1000 + Number(part), 0);

const ENTRIES: Entry[] = Object.entries(FILES)
  .map(([path, text]) => ({
    version: path.slice(path.lastIndexOf("/") + 1, -3),
    lines: text.split("\n").map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  }))
  .sort((a, b) => rank(b.version) - rank(a.version));

// Inline markdown only: `code`, **bold**, *italic*, [text](url).
const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|\*([^*\s][^*]*?)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    const k = m.index;
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k}>{inline(m[2])}</strong>);
    else if (m[3] !== undefined) out.push(<em key={k}>{inline(m[3])}</em>);
    else out.push(<a key={k} href={m[5]} target="_blank" rel="noreferrer">{inline(m[4])}</a>);
    at = k + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export function VersionChip() {
  const [open, setOpen] = useState(false);
  return <>
    <button className="verchip" onClick={() => setOpen(true)}
            title="what changed">
      v{ver.version}<QMark />
    </button>
    {open && <ChangelogSheet close={() => setOpen(false)} />}
  </>;
}

function ChangelogSheet({ close }: { close: () => void }) {
  return (
    <Modal onClose={close}>
      <div className="bar">
        <h2>What changed</h2>
        <span className="path">running v{ver.version}</span>
      </div>
      <div className="clog">
        {ENTRIES.length
          ? ENTRIES.map((e) => (
              <section key={e.version}>
                <h3>{e.version}</h3>
                <ul>{e.lines.map((line, i) =>
                  <li key={i}>{inline(line.replace(/^[-*]\s+/, ""))}</li>)}</ul>
              </section>
            ))
          : <p className="muted">No entries yet.</p>}
      </div>
      <div className="rowbtns">
        <button className="ghost" onClick={close}>Close</button>
      </div>
    </Modal>
  );
}
