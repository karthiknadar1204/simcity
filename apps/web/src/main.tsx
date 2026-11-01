import { CaptureScene } from "./game/CaptureScene";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {new URLSearchParams(location.search).has("capture") ? (
      <CaptureScene />
    ) : (
      <App />
    )}
  </StrictMode>,
);
