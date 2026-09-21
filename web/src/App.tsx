import { useEffect, useState } from "react";

import { getState, type State } from "./lib/api";

// Phase 1 shell. It exists to prove the data path: the page is served by
// Vite or by `vilemk.webui.server`, and either way the payload arrives from
// `GET /api/state` instead of a baked `<script id="data">`. The board, the
// editor and the menu land in Phase 3; the old page keeps working until then.
export function App() {
  const [data, setData] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getState().then(setData, (e: Error) => setError(e.message));
  }, []);

  if (error) {
    return (
      <main className="shell">
        <h1>VileMK</h1>
        <p className="bad">
          Could not read <code>/api/state</code>: {error}
        </p>
        <p>
          The Python server has to be running: <code>make design</code>.
        </p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="shell">
        <h1>VileMK</h1>
        <p>Reading the config repo…</p>
      </main>
    );
  }

  const keymaps = data.keymaps ?? [];
  return (
    <main className="shell">
      <h1>VileMK</h1>
      <p>
        Repo <code>{data.repo_path}</code>, {keymaps.length} keymap
        {keymaps.length === 1 ? "" : "s"}, writes{" "}
        {data.live ? "enabled" : "disabled"}.
      </p>
      <ul>
        {keymaps.map((km: any) => (
          <li key={km.id}>
            <code>{km.id}</code> — {(km.layers ?? []).length} layers
          </li>
        ))}
      </ul>
    </main>
  );
}
