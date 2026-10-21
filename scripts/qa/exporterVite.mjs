// The page the native QA harness loads is served by a Vite dev server, and Vite's client reloads that page whenever its hot-module
// socket closes uncleanly ("server connection lost. Polling for restart...", then location.reload()). A reload restarts the harness
// page's script from the top while the app keeps running its export, so the second pass reads the first one's leftovers. An OS
// sleep or hibernate is enough to drop the socket: on 2026-10-21 a hibernated run's page reloaded 35 s after the machine woke, and
// the run died with a misleading "export intent cannot be verified" while its export was still encoding at full speed.
// The harness never edits source while it runs, so it has no use for hot reload and must not be exposed to its reload path.
export const qaServerOptions = { host: "127.0.0.1", port: 0, strictPort: true, hmr: false, ws: false };
