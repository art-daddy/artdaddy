#!/usr/bin/env node
// Publish landing/ to the static-website origin behind artdaddy.app.
//
//   npm run landing:deploy
//
// Azure Static Web Apps would be the obvious host, but it can only be fed by the SWA CLI
// (npm registry is TLS-blocked here) or a GitHub/DevOps pipeline (Actions is billing-
// suspended), so the origin is a storage account's $web container instead. Cloudflare sits
// in front of it for artdaddy.app and its certificate; blob static hosting cannot terminate
// HTTPS for a custom domain on its own.
//
// The proxy MUST rewrite the Host header to the endpoint below. Blob static hosting routes
// by Host, and answers a request carrying any other one with a 400 InvalidUri page — so a
// plain proxied CNAME serves an Azure error to every visitor, which reads as broken DNS
// rather than a misconfigured origin. Confirmed live: the apex returned exactly that until
// the rewrite was in place.
//
// An Origin Rule is the obvious way to do it and is NOT available to us — Cloudflare answers
// "not entitled to use the HostHeader override" on the Free plan. The rewrite therefore lives
// in a Worker, `artdaddy-site`, routed on artdaddy.app/* and www.artdaddy.app/* (it also 301s
// www to the apex). Two things it learned the hard way: setting a Host header on the outbound
// fetch is ignored, so the ORIGIN URL's hostname is what the origin sees; and a Response built
// from another Response has immutable headers, so touching cache-control there threw and every
// HTML request 500'd while assets served fine.
//
// Content types are set explicitly. `upload-batch` guesses from the extension and a wrong
// guess on index.html makes the browser DOWNLOAD the page instead of rendering it, which
// looks like the site being broken rather than a metadata problem.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, extname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const src = join(root, "landing");

const ACCOUNT = "artdaddysite";
const CONTAINER = "$web";
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

// `az` is a .cmd on Windows and needs a shell, which then re-splits arguments on spaces —
// so anything containing one is quoted here. The account key travels in the ENVIRONMENT,
// never in argv: a failing execFileSync prints the whole command line, which would spill the
// key into the terminal and into any CI log.
const az = (args, env) => {
  const win = process.platform === "win32";
  const safe = win ? args.map((a) => (/[\s,]/.test(a) ? `"${a}"` : a)) : args;
  return execFileSync("az", safe, {
    encoding: "utf8",
    shell: win,
    env: { ...process.env, ...env },
  });
};

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const key = az(["storage", "account", "keys", "list", "--account-name", ACCOUNT, "--query", "[0].value", "-o", "tsv"]).trim();
if (!key) throw new Error(`could not read a key for ${ACCOUNT} — is the Azure CLI logged in?`);
const auth = { AZURE_STORAGE_ACCOUNT: ACCOUNT, AZURE_STORAGE_KEY: key };

for (const file of walk(src)) {
  const name = relative(src, file).split("\\").join(posix.sep);
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  // The page itself must never be cached hard, or a release ships and visitors keep seeing
  // the previous version's download links. The fingerprint-free assets are equally exposed,
  // so they get a short TTL rather than a year.
  const cache = name.endsWith(".html") ? "no-cache, max-age=0" : "public, max-age=3600";
  az(
    [
      "storage", "blob", "upload",
      "--container-name", CONTAINER, "--name", name, "--file", file,
      "--content-type", type, "--content-cache-control", cache,
      "--overwrite", "--only-show-errors",
    ],
    auth,
  );
  console.log(`[landing] ${name}  ${type}`);
}

const endpoint = az(["storage", "account", "show", "--name", ACCOUNT, "--query", "primaryEndpoints.web", "-o", "tsv"]).trim();
console.log(`[landing] published -> ${endpoint}`);
