// The Tauri boundary, exercised through the REAL packaged app.
//
// What only this lane can prove: the Rust shell starts, the webview loads the
// production bundle, the capabilities allowlist actually permits the commands the
// client calls, and `trash_path` — the single custom IPC command, and the only
// recoverable-delete a user has — really reaches the OS from the webview.
//
// The unit lane mocks `invoke`; a capabilities typo or a missing
// `generate_handler!` entry passes every one of those tests and breaks only here.
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Run an expression inside the webview and return its (serialisable) result. */
async function evalInApp(fn, ...args) {
  return browser.execute(fn, ...args);
}

function scratchFile(tag) {
  const p = path.join(os.tmpdir(), `artdaddy_e2e_${tag}_${Date.now()}_${process.pid}`);
  fs.writeFileSync(p, "delete me");
  return p;
}

// A dev build's first load waits on a cold vite (measured at ~50 s), so it gets the lanes' raised ceiling when set.
const BOOT_MS = Number(process.env.ARTDADDY_E2E_TIMEOUT_MS || 30_000);

/** What the webview shows, for a failure message: a blank or error page says why the bundle never mounted. */
async function whatTheWebviewShows() {
  try {
    const [href, title, text] = await evalInApp(() => [
      location.href,
      document.title,
      (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    ]);
    const windows = (await browser.getWindowHandles()).length;
    return `${href} ("${title}") in ${windows} window(s): ${text || "(no text)"}`;
  } catch (error) {
    return `nothing readable (${error.message})`;
  }
}

describe("packaged app boot", () => {
  it("mounts the production bundle into #root (not a blank webview)", async () => {
    try {
      await browser.waitUntil(
        async () => (await evalInApp(() => document.getElementById("root")?.innerHTML.length ?? 0)) > 50,
        { timeout: BOOT_MS, interval: 500 },
      );
    } catch {
      assert.fail(`#root stayed missing or empty for ${BOOT_MS / 1000} s; the webview shows ${await whatTheWebviewShows()}`);
    }
  });

  it("loaded the built bundle, not an error page or a bare shell", async () => {
    // A webview that failed to resolve the frontend still shows a document; what it
    // does NOT have is the app's own title plus mounted, interactive chrome.
    const title = await browser.getTitle();
    assert.ok(title && title.length > 0, "the webview has no document title");
    const buttons = await evalInApp(() => document.querySelectorAll("#root button").length);
    assert.ok(buttons > 0, "no interactive chrome rendered — the bundle did not boot");
  });

  it("exposes the Tauri IPC bridge to the webview", async () => {
    const wired = await evalInApp(
      () => typeof window.__TAURI_INTERNALS__ === "object" && window.__TAURI_INTERNALS__ !== null,
    );
    assert.equal(wired, true, "no Tauri IPC bridge — the app is running as a plain web page");
  });

  it("reports the desktop platform, so the fs fast-path is actually taken", async () => {
    // If this is false at runtime the client silently falls back to the server for
    // every file read — the exact split-brain desktop.ts exists to avoid.
    const isDesktop = await evalInApp(() => "__TAURI_INTERNALS__" in window);
    assert.equal(isDesktop, true);
  });
});

describe("trash_path IPC command", () => {
  it("moves a real file to the OS trash from inside the webview", async () => {
    const p = scratchFile("file");
    assert.equal(fs.existsSync(p), true, "fixture was not created");

    const err = await evalInApp(async (target) => {
      try {
        await window.__TAURI_INTERNALS__.invoke("trash_path", { path: target });
        return null;
      } catch (e) {
        return String(e);
      }
    }, p);

    assert.equal(err, null, `trash_path failed over IPC: ${err}`);
    // The OUTCOME: the path is gone from disk. (The bytes live in the Recycle Bin —
    // that is the difference between this and an irreversible remove.)
    assert.equal(fs.existsSync(p), false, "the file is still on disk after trash_path");
  });

  it("moves a directory tree, the way a project delete does", async () => {
    const dir = path.join(os.tmpdir(), `artdaddy_e2e_dir_${Date.now()}`);
    fs.mkdirSync(path.join(dir, "internals"), { recursive: true });
    fs.writeFileSync(path.join(dir, "internals", "timeline.json"), "{}");

    const err = await evalInApp(async (target) => {
      try {
        await window.__TAURI_INTERNALS__.invoke("trash_path", { path: target });
        return null;
      } catch (e) {
        return String(e);
      }
    }, dir);

    assert.equal(err, null, `trash_path failed for a directory: ${err}`);
    assert.equal(fs.existsSync(dir), false, "the project directory survived the delete");
  });

  it("surfaces a failure as a rejected promise, not a hung call", async () => {
    const missing = path.join(os.tmpdir(), `artdaddy_e2e_missing_${Date.now()}`);
    const err = await evalInApp(async (target) => {
      try {
        await window.__TAURI_INTERNALS__.invoke("trash_path", { path: target });
        return null;
      } catch (e) {
        return String(e);
      }
    }, missing);
    assert.notEqual(err, null, "trashing a non-existent path silently succeeded");
  });

  it("rejects an unregistered command (the handler list is a real allowlist)", async () => {
    const err = await evalInApp(async () => {
      try {
        await window.__TAURI_INTERNALS__.invoke("definitely_not_a_command", {});
        return null;
      } catch (e) {
        return String(e);
      }
    });
    assert.notEqual(err, null, "an unknown IPC command was accepted");
  });
});

describe("plugin capabilities", () => {
  // Both checks call the IPC the bundled plugins call. A script injected into the page cannot `import()` a package by
  // its bare name (the page has no import map), so the import these checks used to make failed whatever the
  // capabilities said, and proved nothing either way.
  it("the fs plugin is permitted (a capabilities typo breaks every project read)", async () => {
    const probe = path.join(os.homedir(), `artdaddy_e2e_exists_${Date.now()}`);
    const answer = await evalInApp(async (target) => {
      try {
        return { exists: await window.__TAURI_INTERNALS__.invoke("plugin:fs|exists", { path: target }) };
      } catch (e) {
        return { error: String(e) };
      }
    }, probe);
    // The ANSWER (false: nothing is there) matters less than being allowed to ask at all.
    assert.deepEqual(answer, { exists: false }, `the fs plugin is not permitted by the capabilities: ${answer.error}`);
  });

  it("the page cannot run programs through the shell plugin (sidecars run through the app's own sidecar_run)", async () => {
    const err = await evalInApp(async () => {
      try {
        await window.__TAURI_INTERNALS__.invoke("plugin:shell|execute", {
          program: "cmd",
          args: ["/c", "exit", "0"],
          options: {},
        });
        return null;
      } catch (e) {
        return String(e);
      }
    });
    assert.notEqual(err, null, "the page ran a program through the shell plugin: no capability grants that");
  });
});
