import { defineConfig } from "vitest/config";

// In dev, /api is forwarded to the Python server (server/), which proxies the
// bandleader to the LLM on the DGX Spark. In production the Python server
// serves the built app itself, so the page and /api share an origin.
const apiTarget = process.env.HOUSEBAND_API ?? "http://localhost:8765";

export default defineConfig({
  server: {
    port: 5173,
    proxy: { "/api": { target: apiTarget, changeOrigin: true } },
    // Genre packs live in ../genres (shared with the server).
    fs: { allow: [".."] },
  },
  build: { outDir: "dist", target: "es2022" },
  test: { include: ["test/**/*.test.ts"] },
});
