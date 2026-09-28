import { ask } from "./Confirm";

/** Tells the user which files of a removed module could not be deleted. */
export function askLeftover(module: string, left: string[]) {
  const shown = left.slice(0, 20);
  return ask({
    info: true, title: `Some of ${module} was not deleted`,
    body: <>The module is out of <code>config/west.yml</code>, but these files are
      still on disk. Delete them by hand:
      <ul>{shown.map((f) => <li key={f}><code>{f}</code></li>)}</ul>
      {left.length > shown.length && <>and {left.length - shown.length} more.</>}
    </> });
}
