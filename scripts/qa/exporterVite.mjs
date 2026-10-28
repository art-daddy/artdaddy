// The page the native QA harness loads is served by a Vite dev server, and Vite's client reloads that page whenever its hot-module
// socket closes uncleanly ("server connection lost. Polling for restart...", then location.reload()). A reload restarts the harness
// page's script from the top while the app keeps running its export, so the second pass reads the first one's leftovers. An OS
// sleep or hibernate is enough to drop the socket: on 2026-10-21 a hibernated run's page reloaded 35 s after the machine woke, and
// the run died with a misleading "export intent cannot be verified" while its export was still encoding at full speed.
// The harness never edits source while it runs, so it has no use for hot reload and must not be exposed to its reload path.
//
// The page's ORIGIN is the other thing a run must not share with another run. Vite 5.4 reads a configured port of 0 as "not set" and
// serves on its default, 5173, so every run on every machine served its page from http://127.0.0.1:5173. A web view whose storage
// outlives the app then handed one run's export history to the next: macOS keeps ONE WebKit store for every unbundled debug build
// (Windows keeps one per app identifier, which is why only a Mac showed it). On 2026-10-25 the two long heavy lines on a Mac were
// never asked about the export, because the pilot run before them had left a comparable sample behind. Every run therefore asks the
// operating system for its own free port, and the page's origin belongs to that run alone.
import net from "node:net";

export async function freeLoopbackPort(host = "127.0.0.1") {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, host, resolve); });
    return probe.address().port;
  } finally {
    await new Promise((resolve) => probe.close(resolve));
  }
}

const fixedServerOptions = { host: "127.0.0.1", strictPort: true, hmr: false, ws: false };

/** The harness's dev-server options for ONE run. There is deliberately no bare constant: without a port Vite serves on 5173. */
export async function qaServerOptionsForRun() {
  return { ...fixedServerOptions, port: await freeLoopbackPort(fixedServerOptions.host) };
}
