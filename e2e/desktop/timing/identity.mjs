// The identity the timed desktop lanes' app is built and run under: its own identifier and sign-in link scheme, never
// the installed app's (qa skill, rule 12). A debug build with the shipped config shares the installed ArtDaddy's web
// view storage and single-instance key, and on Windows takes over its `artdaddy://` sign-in link: on 26 Nov such runs
// pointed the owner's link at a lab build. Not separated by an identifier: the saved sign-in itself, which every build
// keeps under the installed app's keychain entry (KEYCHAIN_SERVICE in src-tauri/src/lib.rs; see standInServer.mjs).
// The pattern of e2e/desktop/export/app.mjs: TAURI_CONFIG at build time (`cargo build` reads it, as `tauri dev` does).
// scripts/qa/nightlyTiming.ps1 and the desktop-e2e job in .github/workflows/ci.yml build with it and serve the page
// where devUrl says:
//   node e2e/desktop/timing/identity.mjs          prints the TAURI_CONFIG JSON
//   node e2e/desktop/timing/identity.mjs --port   prints the page's port
import { pathToFileURL } from "node:url";

export const IDENTIFIER = "com.artdaddy.qa.timing";
export const LINK_SCHEME = "artdaddy-qa-timing";
/** The page's own port, apart from the 5173 a developer's `npm run dev` holds, on 127.0.0.1 so there is no question
 *  which loopback "localhost" means. */
export const PAGE_PORT = 5289;

export function tauriConfig() {
  return {
    identifier: IDENTIFIER,
    build: { devUrl: `http://127.0.0.1:${PAGE_PORT}`, beforeDevCommand: "", beforeBuildCommand: "" },
    plugins: { "deep-link": { desktop: { schemes: [LINK_SCHEME] } } },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(process.argv.includes("--port") ? String(PAGE_PORT) : JSON.stringify(tauriConfig()));
}
