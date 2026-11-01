import { useEffect, useState } from "react";
import { PhaserGame } from "./game/PhaserGame";

export function App() {
  const [apiStatus, setApiStatus] = useState("Connecting to API…");

  useEffect(() => {
    const controller = new AbortController();
    const base = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
    fetch(`${base}/api/health`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("API unavailable");
        setApiStatus("API connected");
      })
      .catch(() => {
        if (!controller.signal.aborted) setApiStatus("API offline");
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="app">
      <header>
        <div>
          <p className="eyebrow">SIMCITY</p>
          <h1>Your town starts here.</h1>
          <p className="description">
            The canvas is ready for the simulation engine.
          </p>
        </div>
        <span className="status" role="status">
          {apiStatus}
        </span>
      </header>
      <PhaserGame />
      <footer>React · Vite · Phaser / Bun · Hono</footer>
    </main>
  );
}
