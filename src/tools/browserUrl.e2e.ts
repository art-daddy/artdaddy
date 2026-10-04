// The browser sidecar opens web pages only. Until 2026-10-04 it rendered file:///C:/Windows/win.ini
// to a PNG of the file's text, so get_page_image could read any local text file as an image. This
// drives the STAGED sidecar (the bundle the app ships, rebuilt by `npm run build:sidecar`) and reads
// the artifact: no screenshot of a local file, while a page served over http still gets one.
//   npx vitest run --config vitest.smoke.config.ts src/tools/browserUrl.e2e.ts
import { existsSync, promises as fsp } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { nodeRunner } from "./__e2e";
import { BROWSER_BIN } from "./sidecar";
import { shippedSidecar } from "../test/sidecars";

const ROOT = path.resolve("src-tauri");
const BIN = shippedSidecar(BROWSER_BIN);
const SCRIPT = path.join(ROOT, "resources", `${BROWSER_BIN}.mjs`);
const STAGED = BIN !== null && existsSync(SCRIPT);

const dir = path.join(os.tmpdir(), `artdaddy-browser-url-${process.pid}`);
let server: http.Server;
let pageUrl = "";

beforeAll(async () => {
  await fsp.mkdir(dir, { recursive: true });
  server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<html><body><h1>a web page</h1></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fsp.rm(dir, { recursive: true, force: true });
});

const shot = (url: string, out: string) =>
  nodeRunner.run(
    BIN!,
    [
      SCRIPT,
      "shot",
      "--url",
      url,
      "--viewport",
      "800x600",
      "--dsf",
      "1",
      "--mobile",
      "0",
      "--out",
      out,
    ],
    undefined,
    ROOT,
  );

describe.skipIf(!STAGED)("the browser sidecar opens web pages only", () => {
  it("refuses a file:// URL and writes no screenshot of the file", async () => {
    const secret = path.join(dir, "secret.txt");
    await fsp.writeFile(secret, "TOP SECRET: the local file an agent must not see");
    const out = path.join(dir, "secret.png");
    const r = await shot(pathToFileURL(secret).href, out);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stdout.trim()).ok).toBe(false);
    expect(existsSync(out)).toBe(false);
  }, 60_000);

  it("control: a page served over http is captured", async () => {
    const out = path.join(dir, "page.png");
    const r = await shot(pageUrl, out);
    expect(r.code, r.stderr.slice(-400)).toBe(0);
    expect(JSON.parse(r.stdout.trim()).ok).toBe(true);
    expect((await fsp.stat(out)).size).toBeGreaterThan(0);
  }, 90_000);
});
