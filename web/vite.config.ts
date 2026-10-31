import { defineConfig } from "vitest/config";

// The build is static and relative (base "./"), so it plays from any host or
// folder with no jamstate server (ADR-0015). In dev, /api is forwarded to the
// optional companion server (server/) for its relays and session sync.
const apiTarget = process.env.JAMSTATE_API ?? "http://localhost:8765";

export default defineConfig({
  base: "./",
  server: {
    port: 5173,
    proxy: { "/api": { target: apiTarget, changeOrigin: true } },
    // Genre packs live in ../genres (shared with the server).
    fs: { allow: [".."] },
  },
  build: { outDir: "dist", target: "es2022" },
  test: { include: ["test/**/*.test.ts"] },
});
