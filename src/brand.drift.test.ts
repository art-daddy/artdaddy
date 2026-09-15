// Static config files can't import src/brand.ts — the tools that read them (tauri,
// vite, cargo, npm) run before any bundler. So they carry copies of the app's names.
// This walks every copy and fails if one drifts.
//
// It is deliberately a CONFORMANCE test over the real files on disk, not a snapshot:
// a snapshot would happily record the drift and go green.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND, IDENTITY } from "./brand";
import { brandRatio, endcardFile, watermarkFile } from "./timeline/branding";

const root = resolve(__dirname, "..");
const read = (p: string): string => readFileSync(resolve(root, p), "utf8");
const readJson = (p: string): any => JSON.parse(read(p));

describe("the app's names have one source of truth", () => {
  it("tauri.conf.json matches brand.json", () => {
    const conf = readJson("src-tauri/tauri.conf.json");
    expect(conf.productName).toBe(BRAND.productName);
    expect(conf.identifier).toBe(IDENTITY.bundleIdentifier);
    expect(conf.app.windows[0].title).toBe(BRAND.displayName);
  });

  it("every filesystem scope points at the current data folder", () => {
    const want = [`$DATA/${IDENTITY.dataFolder}`, `$DATA/${IDENTITY.dataFolder}/**`];

    const asset = readJson("src-tauri/tauri.conf.json").app.security.assetProtocol.scope;
    expect(asset).toEqual(expect.arrayContaining(want));

    const fsScope = readJson("src-tauri/capabilities/default.json")
      .permissions.flatMap((p: any) => (typeof p === "object" && p.allow ? p.allow : []))
      .map((e: any) => (typeof e === "object" ? e.path : e))
      .filter(Boolean);
    expect(fsScope).toEqual(expect.arrayContaining(want));

    // A scope left pointing at a previous name silently keeps the old folder
    // reachable, which is exactly how two data roots start diverging.
    for (const old of IDENTITY.legacyDataFolders) {
      expect(asset).not.toContain(`$DATA/${old}`);
      expect(fsScope).not.toContain(`$DATA/${old}`);
    }
  });

  it("the sidecar is declared under the name that is actually staged", () => {
    const bin = `binaries/${IDENTITY.sidecarPrefix}-browser`;
    const conf = readJson("src-tauri/tauri.conf.json");
    expect(conf.bundle.externalBin).toContain(bin);
    expect(conf.bundle.resources).toContain(`resources/${IDENTITY.sidecarPrefix}-browser.mjs`);

    const named = JSON.stringify(readJson("src-tauri/capabilities/default.json"));
    expect(named).toContain(`"${bin}"`);
      // The legacy sidecar name, kept deliberately: this guard exists to prove no capability or
      // config still names it. Renaming it to the CURRENT prefix empties the filter and the loop
      // asserts nothing at all.
      for (const legacy of ["akaru-browser"].filter(
      (n) => n !== `${IDENTITY.sidecarPrefix}-browser`,
    )) {
      expect(named).not.toContain(legacy);
      expect(JSON.stringify(conf)).not.toContain(legacy);
    }
  });

  it("package name and window title match the brand", () => {
    expect(readJson("package.json").name).toBe(`${BRAND.productName}-client`);
    expect(read("index.html")).toContain(`<title>${BRAND.displayName}</title>`);
  });

  it("the MCP server advertises the brand name", () => {
    // Users paste this into their Claude/Cursor config, so it is user-visible. Anchored to the
    // one const rather than an inline literal: mcp.rs's own test spelled the name out a second
    // time and went on asserting the pre-rename value for weeks, red and unrun.
    expect(read("src-tauri/src/mcp.rs")).toContain(
      `const SERVER_NAME: &str = "${BRAND.mcpServerName}";`,
    );
  });

  it("the native macOS menu carries the brand name", () => {
    // Rust can't import brand.json, and this menu is the first thing a Mac user reads.
    const rs = read("src-tauri/src/lib.rs");
    expect(rs).toContain(`"${BRAND.displayName}"`);
    expect(rs).toContain(`"About ${BRAND.displayName}"`);
  });

  it("the startup migration knows the same folder names as the resolver", () => {
    // These two disagreeing is the one bug that loses people's projects: the app would
    // move the data somewhere the TypeScript side never looks.
    const rs = read("src-tauri/src/lib.rs");
    expect(rs).toContain(`const DATA_FOLDER: &str = "${IDENTITY.dataFolder}";`);
    const legacy = IDENTITY.legacyDataFolders.map((n) => `"${n}"`).join(", ");
    expect(rs).toContain(`const LEGACY_DATA_FOLDERS: &[&str] = &[${legacy}];`);
  });

  it("the bundled browser sidecar keeps its profile under the same data folder", () => {
    // esbuild inlines this script into a standalone resource, so it can't read brand.json
    // at runtime and has to carry a literal.
    const mjs = read(`scripts/${IDENTITY.sidecarPrefix}-browser.mjs`);
    for (const old of IDENTITY.legacyDataFolders) {
      expect(mjs).not.toContain(`"${old}", "browser-profiles"`);
    }
    expect(mjs).toContain(`"${IDENTITY.dataFolder}", "browser-profiles"`);
  });

  it("no desktop e2e lane looks for projects under a retired data folder", () => {
    // Every one of them had `APPDATA/ArtDaddy/projects` frozen in. Reads got ENOENT (the MCP
    // behaviour lane failed on it) and cleanups silently deleted nothing, so each run left
    // its projects behind in the REAL root. They derive the path now; this stops the next
    // rename from re-freezing it.
    const dir = resolve(root, "e2e/desktop");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".mjs"))) {
      const src = readFileSync(resolve(dir, f), "utf8");
      for (const old of [...IDENTITY.legacyDataFolders, IDENTITY.dataFolder]) {
        expect(`${f}: ${src}`).not.toContain(`"${old}", "projects"`);
      }
    }
  });

  it("no desktop e2e lane hardcodes the app binary name either", () => {
    // Same failure, different constant: the product rename left `app.exe` in target/debug,
    // and the lanes went on driving that stale build.
    const dir = resolve(root, "e2e/desktop");
    const binary = `${readJson("src-tauri/tauri.conf.json").productName}.exe`;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".mjs"))) {
      const src = readFileSync(resolve(dir, f), "utf8");
      // The hint text in an error message may name it; a path built from it may not.
      expect(`${f}: ${src}`).not.toContain(`profile, "app.exe"`);
      expect(`${f}: ${src}`).not.toContain(`profile, "${binary}"`);
    }
  });

  it("the OS-level helpers look for the process the app actually runs as", () => {
    // `-Process app` / `Get-Process app` found no window after the rename, so raise.ps1 printed
    // "noapp" and exited 1. Every lane that needs the real window — OS drag-and-drop, the import
    // progress and hang watchers — had been failing on that, not on the product.
    const dir = resolve(root, "e2e/desktop");
    const name = readJson("src-tauri/tauri.conf.json").productName;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".mjs") || n.endsWith(".ps1"))) {
      const src = readFileSync(resolve(dir, f), "utf8");
      expect(`${f}: ${src}`).not.toContain(`"-Process", "app"`);
      expect(`${f}: ${src}`).not.toContain(`$Process = "app"`);
      expect(`${f}: ${src}`).not.toContain("Get-Process app ");
    }
    // ...and the default the scripts fall back to is the real one.
    for (const f of ["raise.ps1", "hangWatch.ps1", "osDrop.ps1"]) {
      expect(`${f}`).toBeTruthy();
      expect(readFileSync(resolve(dir, f), "utf8")).toContain(`$Process = "${name}"`);
    }
  });

  // The landing page moved to its own repository, taking three guards with it: that it
  // advertises the version actually shipped (its installer URLs carry the version and 404 on
  // release day if they lead), that its social card is byte-identical to the shipped end card,
  // and that its palette matches the tokens here. Nothing in THIS repo can assert those any
  // more. They are a release-checklist item now, which is weaker than a test, and saying so is
  // better than leaving a skipped test that reads as covered.

  it("everything that names the website names the same one", () => {
    // artdaddy.in went dead while the end card, the Claude Desktop manifest and the landing
    // page each kept their own copy of it, so every export advertised a domain that did not
    // resolve. The domain is a brand token now; these are the copies that cannot import it.
    const site = BRAND.site;
    expect(site).toMatch(/^[a-z0-9-]+\.[a-z.]+$/);

    const mcpb = readJson("mcpb/manifest.json");
    expect(mcpb.homepage).toBe(`https://${site}`);
    expect(mcpb.author.url).toBe(`https://${site}`);

    // The end card renders WORD + the site's suffix. Nothing else re-renders that video, so
    // without this the generator could keep emitting a domain the rest of the repo retired.
    const gen = read("scripts/brand-video.mjs");
    expect(gen).not.toMatch(/const SUFFIX = "\./);
    expect(gen).toContain("cfg.brand.site");
  });

  it("the updater polls a host we own, not a storage vendor's", () => {
    // The endpoint is baked in at BUILD time, so every installed copy asks the URL it shipped
    // with, forever. Point it at a vendor hostname and leaving that vendor silently ends
    // updates for everyone already installed — a failed check is deliberately non-fatal, so
    // nothing surfaces and there is no way to reach them. A rename already put a
    // `*.blob.core.windows.net` hostname here that did not even resolve.
    const endpoints: string[] = readJson("src-tauri/tauri.conf.json").plugins.updater.endpoints;
    expect(endpoints.length).toBeGreaterThan(0);
    for (const ep of endpoints) {
      expect(new URL(ep).host, `${ep} is not on a domain we control`).toBe(BRAND.site);
    }
  });

  it("every build path talks to the same backend", () => {
    // The backend hostname is inlined at BUILD time and lives in nine copies no bundler can
    // reach: the production default, three CI lanes, codemagic and the auth broker. The brand
    // rename rewrote all of them to a host that was never created, so a released build would
    // 404 on every call and sign-in would be impossible — while a developer's .env kept
    // pointing at the real one, so nothing looked wrong locally.
    const files = [
      "src/api/config.ts",
      "auth-broker/index.html",
      "scripts/auth-broker.test.ts",
      ".github/workflows/macos-release.yml",
      ".github/workflows/macos-e2e.yml",
      "codemagic.yaml",
    ];
    const hosts = new Map<string, string[]>();
    for (const file of files) {
      for (const [, host] of read(file).matchAll(/https:\/\/([a-z0-9.-]+\.azurecontainerapps\.io)/g)) {
        hosts.set(host, [...(hosts.get(host) ?? []), file]);
      }
    }
    expect(hosts.size, `these name different backends: ${JSON.stringify([...hosts])}`).toBe(1);
  });

  it("the sign-in page the website serves is the one this repo maintains", () => {
    // The broker is coupled to the deep-link scheme and the server's /auth/desktop routes,
    // so it is maintained here — but artdaddy.app is published from the landing repo, which
    // carries the copy users actually load. Two copies of one page: a fix applied here and
    // not there leaves the app opening a stale sign-in flow, and nothing local looks wrong.
    const served = resolve(root, "../akaru-landing/landing/auth/index.html");
    if (!existsSync(served)) return; // sibling checkout absent (CI); the pre-push hook has it
    expect(readFileSync(served, "utf8")).toBe(read("auth-broker/index.html"));
  });

  it("the installer hook, if wired, uninstalls every product name the app shipped under", () => {
    // NSIS keys its uninstall entry and install dir by PRODUCT NAME, not by the bundle
    // identifier — a real 0.6.0 install registers under "akaru" at %LOCALAPPDATA%\artdaddy, so
    // the rename lands a SECOND app unless the installer removes the old one.
    //
    // Deliberately NOT wired for 0.7.0: the hook runs BEFORE install, and a 0.6.0 user's
    // projects are still under the old data folder that the app only migrates at first launch.
    // Until a real upgrade proves the uninstaller leaves app data alone, two Add/Remove entries
    // beat deleting someone's work. The file stays so the next release can enable it.
    const hookFile = "src-tauri/installer-hooks.nsh";
    expect(() => read(hookFile), "the hook was deleted rather than parked").not.toThrow();
    const hook = read(hookFile);
    for (const old of IDENTITY.legacyProductNames ?? []) {
      expect(hook, `installer never uninstalls '${old}'`).toContain(`Uninstall\\${old}"`);
    }
    expect(hook).not.toContain(`Uninstall\\${BRAND.productName}"`);

    // If it IS wired, it must point at the file above rather than a stale path.
    const nsis = readJson("src-tauri/tauri.conf.json").bundle?.windows?.nsis;
    if (nsis?.installerHooks) expect(`src-tauri/${nsis.installerHooks}`).toBe(hookFile);
  });

  it("the bundled brand assets are the ones in brand/video, byte for byte", () => {
    // src-tauri/resources/brand is a STAGED COPY: `tauri build` bundles from there, and
    // nothing in the build regenerates it. Re-authoring the end card and forgetting to stage
    // it ships the OLD branding to every user while the repo shows the new one — the same
    // trap the browser sidecar already paid for once.
    const ratios = ["16x9", "1x1", "9x16"];
    const names = ratios.flatMap((r) => [`watermark-${r}.png`, `endcard-${r}.mp4`]);
    for (const name of names) {
      const source = readFileSync(resolve(root, "brand/video", name));
      const staged = readFileSync(resolve(root, "src-tauri/resources/brand", name));
      expect(staged.equals(source), `${name} in resources/brand is stale`).toBe(true);
    }
  });

  it("every ratio the renderer can choose has an asset staged for it", () => {
    // The picker is a table; verifying one entry is evidence about that entry only. A canvas
    // whose ratio maps to a file nobody staged exports unbranded and says so in a warning
    // nobody reads.
    const cases: [number, number][] = [
      [1920, 1080],
      [1080, 1080],
      [1080, 1920],
      [720, 1280],
      [3840, 2160],
      [0, 0],
    ];
    for (const [w, h] of cases) {
      const r = brandRatio(w, h);
      expect(() =>
        readFileSync(resolve(root, "src-tauri/resources/brand", watermarkFile(r))),
      ).not.toThrow();
      expect(() =>
        readFileSync(resolve(root, "src-tauri/resources/brand", endcardFile(r))),
      ).not.toThrow();
    }
  });
});
