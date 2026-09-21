import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/board.css";
// Last: `.k.pick` and `.k.asg` have to beat `.k.diff` and `.k.hot`.
import "./styles/editor.css";
import favicon from "../../vilemk/webui/assets/favicon.png";
import { App } from "./App";

// The icons live with the Python package; importing them keeps one copy in the
// tree rather than a second under web/.
const icon = document.createElement("link");
icon.rel = "icon";
icon.type = "image/png";
icon.href = favicon;
document.head.appendChild(icon);

const root = document.getElementById("root");
if (!root) throw new Error("no #root in index.html");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
