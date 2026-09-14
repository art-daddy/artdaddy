#!/usr/bin/env node
// Publish auth-broker/ at the /auth path on artdaddy.app.
//
//   npm run auth-broker:deploy
//
// Same origin as landing/'s artdaddy.app: Azure Static Web Apps needs the SWA CLI (npm
// registry is TLS-blocked here) or a GitHub/DevOps pipeline (Actions is billing-suspended),
// so this uploads into the SAME artdaddysite storage account's $web container that
// npm run landing:deploy does, under an auth/ prefix, fronted by the same Cloudflare setup
// for artdaddy.app — not a separate account/domain.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, extname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const src = join(root, "auth-broker");

const ACCOUNT = "artdaddysite";
const CONTAINER = "$web";
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
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
  const name = posix.join("auth", relative(src, file).split("\\").join(posix.sep));
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  // The page itself must never be cached hard: it embeds the API host and Clerk key, and a
  // release that rotates either must reach every visitor immediately, not after a stale TTL.
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
  console.log(`[auth-broker] ${name}  ${type}`);
}

const endpoint = az(["storage", "account", "show", "--name", ACCOUNT, "--query", "primaryEndpoints.web", "-o", "tsv"]).trim();
console.log(`[auth-broker] published -> ${endpoint}auth/`);
