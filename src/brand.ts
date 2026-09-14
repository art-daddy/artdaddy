// The one place the app's names live. Two groups, and the split is the point.
//
//   BRAND    — what people read. Change any of it freely; nothing on disk moves.
//   IDENTITY — what the OS, the updater and existing installs match on. Changing
//              one of these is a migration, not a rename.
//
// Static files can't import this module (tauri.conf.json, index.html, Cargo.toml,
// package.json, capabilities/default.json are read by tools that run before any
// bundler). They carry copies, and `brand.drift.test.ts` fails if a copy disagrees
// — without that guard this file would be decorative the first time someone edits
// a config directly.
import brand from "./brand.json";

export const BRAND = brand.brand;

/** Frozen names. Each one has a cost written next to it; pay it deliberately.
 *
 *  - `bundleIdentifier` — how Windows and macOS decide "same app?". Still
 *    `com.artdaddy.app` on purpose: changing it strands every install that can
 *    currently auto-update, and they would need a manual reinstall, forever.
 *    It is invisible to users, so there is nothing to gain by touching it.
 *  - `dataFolder` — `<appData>/<dataFolder>` holds every project. Renaming it
 *    hides people's work unless `legacyDataFolders` carries the old name and the
 *    startup migration moves it (src-tauri/src/lib.rs).
 *  - `legacyDataFolders` — every name this app has ever stored data under, oldest
 *    last. Only ever append; dropping an entry orphans whoever is still on it.
 *  - `legacyProductNames` — every `productName` this app has been INSTALLED under.
 *    Windows NSIS keys its uninstall entry and install directory by product name,
 *    not by `bundleIdentifier`, so a rename installs a SECOND copy unless the
 *    installer uninstalls the old one first (src-tauri/installer-hooks.nsh).
 *    Only ever append.
 *  - `sidecarPrefix` — must equal the filename prefix actually staged in
 *    src-tauri/binaries. A mismatch fails at runtime, not at build.
 *  - `envPrefix` — dev/CI overrides (`*_DATA_DIR`) and the deployed server's
 *    variables share it. Deliberately still `ARTDADDY`: renaming it is a production
 *    deploy change, not a client rebrand.
 */
export const IDENTITY = brand.identity;

/** Extension for an exported project bundle, e.g. `My Reel.artdaddy.zip`. */
export const PACKAGE_EXT = `${BRAND.packageInfix}.zip`;
