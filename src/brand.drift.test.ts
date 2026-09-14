// Static config files can't import src/brand.ts — the tools that read them (tauri,
// vite, cargo, npm) run before any bundler. So they carry copies of the app's names.
// This walks every copy and fails if one drifts.
//
// It is deliberately a CONFORMANCE test over the real files on disk, not a snapshot:
// a snapshot would happily record the drift and go green.
import { readdirSync, readFileSync } from "node:fs";
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

  it("the landing page offers the version that actually shipped", () => {
    // It is a standalone page with no build step, so nothing else would notice it still
    // advertising an old release — including the installer URLs, which carry the version.
    const version = readJson("src-tauri/tauri.conf.json").version;
    const html = read("landing/index.html");
    expect(html).toContain(`<span id="ver">${version}</span>`);
    const cmp = (v: string) => v.split(".").map(Number);
    const ahead = (a: number[], b: number[]) =>
      a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])));
    let current = 0;
    for (const m of html.matchAll(/updates\/(\w+)_(\d+\.\d+\.\d+)_/g)) {
      // The NAME as well as the version: `\w+` used to swallow the product name here, so the
      // links still pointed at the pre-rename installer and would have 404'd on release day.
      expect(m[1]).toBe(BRAND.productName);
      // A platform may LAG — 0.9.0 shipped Windows-only because macOS cannot be built without
      // CI or a Mac — but it must never LEAD, which is the case that 404s on release day. The
      // page has to name the older version next to that button; see `mac-meta`.
      expect(ahead(cmp(m[2]), cmp(version)), `${m[1]} ${m[2]} is ahead of ${version}`).toBe(false);
      if (m[2] === version) current += 1;
    }
    // ...and at least one link must actually be the release, or the page advertises a version
    // nobody can download.
    expect(current).toBeGreaterThan(0);
  });

  it("everything that names the website names the same one", () => {
    // artdaddy.in went dead while the end card, the Claude Desktop manifest and the landing
    // page each kept their own copy of it, so every export advertised a domain that did not
    // resolve. The domain is a brand token now; these are the copies that cannot import it.
    const site = BRAND.site;
    expect(site).toMatch(/^[a-z0-9-]+\.[a-z.]+$/);

    const html = read("landing/index.html");
    expect(html).toContain(`<link rel="canonical" href="https://${site}/" />`);
    expect(html).toContain(`<meta property="og:url" content="https://${site}/" />`);
    // Relative og:image is not fetched by link unfurlers, so it has to be absolute — which
    // means it carries the domain too.
    expect(html).toMatch(new RegExp(`og:image" content="https://${site}/`));

    const mcpb = readJson("mcpb/manifest.json");
    expect(mcpb.homepage).toBe(`https://${site}`);
    expect(mcpb.author.url).toBe(`https://${site}`);

    // The end card renders WORD + the site's suffix. Nothing else re-renders that video, so
    // without this the generator could keep emitting a domain the rest of the repo retired.
    const gen = read("scripts/brand-video.mjs");
    expect(gen).not.toMatch(/const SUFFIX = "\./);
    expect(gen).toContain("cfg.brand.site");
  });

  it("the landing page's social card is the end card that ships", () => {
    // A hand-copied still: it drifted silently once already. Same class as the staged-brand
    // check below — a copy nothing regenerates.
    const still = readFileSync(resolve(root, "brand/video/endcard-16x9-still.png"));
    const shipped = readFileSync(resolve(root, "landing/assets/endcard.png"));
    expect(shipped.equals(still), "landing/assets/endcard.png is stale").toBe(true);
  });

  it("the landing page palette matches the tokens", () => {
    // Read as TEXT rather than imported: tailwind.config.js is plain JS with no declaration
    // file, so importing it fails `tsc --noEmit` under noImplicitAny even though vitest is
    // happy to run it — green tests, broken build.
    const tokens = new Map(
      [...read("tailwind.config.js").matchAll(/^const (\w+) = "(#[0-9a-fA-F]{6})";/gm)].map(
        ([, name, hex]) => [name.toLowerCase(), hex.toLowerCase()],
      ),
    );
    expect(tokens.size).toBeGreaterThan(4);

    const html = read("landing/index.html").toLowerCase();
    for (const name of ["bg", "surface", "raised", "edge", "brand", "ink"]) {
      const hex = tokens.get(name);
      expect(hex, `no token named ${name} in tailwind.config.js`).toBeDefined();
      expect(html).toContain(`--${name}: ${hex};`);
    }
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
