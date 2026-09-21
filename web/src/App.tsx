import { useEffect, useState } from "react";

import { getState } from "./lib/api";
import { KeymapView } from "./components/KeymapView";
import { Sidebar } from "./components/Sidebar";
import { ImportDialog } from "./components/Transfer";
import { LIVE, StoreProvider, useStore } from "./state/store";
import logo from "../../vilemk/webui/assets/logo.png";

function Shell() {
  const { s } = useStore();
  return <>
    <header>
      <span className="brand"><img src={logo} alt="VileMK" /></span>
      <span className="meta">
        {s.data.repo_path} &middot; generated {s.data.generated} &middot;{" "}
        {LIVE(s) ? "live · saving to custom/" : "read-only"}
      </span>
    </header>
    <div className={s.rail ? "wrap" : "wrap closed"}>
      <Sidebar />
      <KeymapView />
    </div>
    <ImportDialog />
  </>;
}

export function App() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getState().then(setData, (e: Error) => setError(e.message));
  }, []);

  if (error)
    return (
      <main className="boot">
        <h1>VileMK</h1>
        <p className="bad">Could not read <code>/api/state</code>: {error}</p>
        <p>The Python server has to be running: <code>make design</code>.</p>
      </main>
    );
  if (!data)
    return <main className="boot"><h1>VileMK</h1><p>Reading the config repo…</p></main>;

  return <StoreProvider data={data}><Shell /></StoreProvider>;
}
