import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";

const envDir = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, "");
  return {
    plugins: [react()],
    envDir,
    server: {
      proxy: {
        "/api": {
          target: env.API_PROXY_TARGET || "http://127.0.0.1:3001",
          changeOrigin: true,
        },
      },
    },
    build: {
      rolldownOptions: {
        output: {
          manualChunks(id) {
            if (id.includes("/phaser/")) return "phaser";
          },
        },
      },
    },
  };
});
