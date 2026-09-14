import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

import pkg from "./package.json";

// Web-first dev/build config. The API base URL is configurable via VITE_API_BASE_URL
// (defaults to http://127.0.0.1:8000). Test config lives in vitest.config.ts.
//
// `tauri dev` serves the webview from http://localhost:5173, and the server's CORS allowlist
// only holds the origins a shipped app uses (http://tauri.localhost, tauri://localhost,
// https://artdaddy.app). A dev build calling the DEPLOYED server directly is therefore blocked
// by the browser as "Failed to fetch" — sign-in included. Point VITE_API_BASE_URL at /api and
// set ARTDADDY_DEV_API_TARGET to the real server to route through this proxy instead, which makes
// the calls same-origin without widening the production allowlist. Dev only: `build` never
// reads ARTDADDY_DEV_API_TARGET, so a bundle always bakes in whatever VITE_API_BASE_URL says.
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const devApiTarget = command === "serve" ? env.ARTDADDY_DEV_API_TARGET?.trim() : undefined;
  const configuredBase = env.VITE_API_BASE_URL?.trim() ?? "";
  // The same .env drives dev AND a local build, so the dev-proxy base can silently end up
  // inlined in a bundle that then talks to a dev server no user is running.
  if (
    command === "build" &&
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/api\/?$/i.test(configuredBase)
  ) {
    throw new Error(
      `VITE_API_BASE_URL is the dev proxy (${configuredBase}); a build must point at a real server.`,
    );
  }
  // The e2e auth bypass is inlined at build time, so refusing the build is the only way to
  // guarantee a shipped app cannot carry it. e2e builds with --mode e2e instead.
  if (command === "build" && mode === "production" && env.VITE_E2E_AUTH_BYPASS) {
    throw new Error(
      "VITE_E2E_AUTH_BYPASS is set for a production build; unset it, or build e2e with --mode e2e.",
    );
  }
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: false,
      ...(devApiTarget
        ? {
            proxy: {
              "/api": {
                target: devApiTarget,
                changeOrigin: true,
                rewrite: (p: string) => p.replace(/^\/api/, ""),
              },
            },
          }
        : {}),
    },
    // The Sentry release must track the version the user installed, or every build's
    // errors pile into one bucket. Derived here so it cannot drift from package.json.
    define: { __ARTDADDY_RELEASE__: JSON.stringify(`artdaddy@${pkg.version}`) },
    // ES-module workers so the preview worker can code-split (its dependency graph
    // includes dynamic imports); it's also instantiated with { type: "module" }.
    worker: { format: "es" },
    build: { outDir: "dist", sourcemap: true },
  };
});
