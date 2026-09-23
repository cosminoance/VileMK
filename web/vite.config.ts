import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The build writes into the Python package, because that is what
// `vilemk.webui.server` serves and what a wheel would carry. `dist/` is not
// committed: a bare `dist/` in .gitignore matches at any depth and covers it.
// `emptyOutDir` needs saying out loud since the directory is outside this root.
//
// The proxy means the dev server and the built page take the same data path,
// so there is no CORS and no second fetch story to keep working.
// `changeOrigin` rewrites the Host header to the target. Without it Vite
// forwards `Host: localhost:5173`, which `Handler._guard()` in server.py
// happens to accept today only because it splits on ":" and allows
// `localhost`. Setting it means the guard keeps working if either side
// changes.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../vilemk/webui/dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:7879", changeOrigin: true },
    },
    // The logo and the favicon are imported from vilemk/webui/assets/, which
    // is outside this root: they belong to the Python package. `vite build`
    // resolves them anyway; the dev server needs to be told they are readable.
    fs: { allow: [".."] },
  },
});
