import { defineConfig } from "vitest/config";

// Standalone config for OFFLINE transcript mining (Mode A) — `npm run mine`.
// Reads recorded sessions from ARTDADDY_MINE_DIR (default the desktop app data dir)
// and writes reports/eval/transcript-mining.md. No model, no server, no spend.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/eval/mine.e2e.ts"],
    testTimeout: 60_000,
    env: { ARTDADDY_MINE: "1" },
  },
});
