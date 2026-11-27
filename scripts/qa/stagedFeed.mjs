// A STAGED update feed for a candidate release, served on a disposable CI runner at the very address every installed
// app asks (https://artdaddy.app/updates/latest.json, compiled into the app), so that an installed previous release
// updates itself to the candidate through its own updater BEFORE the live feed offers the candidate to anyone.
// .github/workflows/updater-canary.yml runs it when `to_version` is given (row 7 of the release checklist).
//
// How. The runner's hosts file sends artdaddy.app to this machine, and a certificate authority made here, for this
// run only, signs a certificate for artdaddy.app; only this runner trusts it. The app's updater trusts the system's
// certificate store (reqwest with rustls-platform-verifier, in every release since 0.21.6), so it reads the staged
// feed exactly as it reads the live one, and still downloads the candidate from GitHub and checks its signature
// against the public key compiled into it. Nothing is published and the live feed is never touched; the runner is
// thrown away after the job.
//
//   node scripts/qa/stagedFeed.mjs serve    needs TO_VERSION, GITHUB_REPOSITORY, RUNNER_TEMP, GITHUB_ENV and GH_TOKEN
//
// The feed it serves is written to $STAGED_FEED and every request the server answers, one JSON line each, to
// $STAGED_FEED_LOG (both set for the later steps of the job, and both under reports/qa/updater-canary/staged-feed,
// which the job uploads): a canary proves with them that the app read THIS feed.
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FEED_URL, PLATFORMS, feedText, isVersion } from "../updateFeed.mjs";

const HOST = new URL(FEED_URL).hostname;
const FEED_PATH = new URL(FEED_URL).pathname;
const SELF = fileURLToPath(import.meta.url);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw new Error(`${command} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    const said = (result.stderr || result.stdout || "").trim().slice(0, 2000);
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}: ${said}`);
  }
  return result.stdout;
}

/** The runner's openssl; Git for Windows carries one when PATH has none. */
function openssl() {
  for (const candidate of ["openssl", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"]) {
    if (spawnSync(candidate, ["version"], { encoding: "utf8" }).status === 0) return candidate;
  }
  throw new Error("this runner has no openssl");
}

/** A certificate authority for this run only, and a certificate it signs for the feed's host. */
function makeCertificates(dir) {
  writeFileSync(
    path.join(dir, "ca.cnf"),
    [
      "[req]",
      "prompt = no",
      "distinguished_name = dn",
      "x509_extensions = v3_ca",
      "[dn]",
      "CN = ArtDaddy update canary (this runner only)",
      "[v3_ca]",
      "basicConstraints = critical, CA:TRUE",
      "keyUsage = critical, keyCertSign, cRLSign",
      "subjectKeyIdentifier = hash",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(dir, "leaf.cnf"),
    [
      "[req]",
      "prompt = no",
      "distinguished_name = dn",
      "[dn]",
      `CN = ${HOST}`,
      "[v3_leaf]",
      "basicConstraints = critical, CA:FALSE",
      "keyUsage = critical, digitalSignature, keyEncipherment",
      "extendedKeyUsage = serverAuth",
      `subjectAltName = DNS:${HOST}`,
      "authorityKeyIdentifier = keyid,issuer",
      "subjectKeyIdentifier = hash",
      "",
    ].join("\n"),
  );
  const bin = openssl();
  const here = { cwd: dir };
  const rsa = ["-newkey", "rsa:2048", "-nodes", "-sha256"];
  run(
    bin,
    [
      "req",
      "-x509",
      ...rsa,
      "-days",
      "3",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
      "-config",
      "ca.cnf",
    ],
    here,
  );
  run(
    bin,
    ["req", "-new", ...rsa, "-keyout", "server.key", "-out", "server.csr", "-config", "leaf.cnf"],
    here,
  );
  run(
    bin,
    [
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-sha256",
    ].concat([
      "-days",
      "3",
      "-out",
      "server.pem",
      "-extfile",
      "leaf.cnf",
      "-extensions",
      "v3_leaf",
    ]),
    here,
  );
  return {
    ca: path.join(dir, "ca.pem"),
    cert: path.join(dir, "server.pem"),
    key: path.join(dir, "server.key"),
  };
}

/** Make the system (and so the app's updater) trust that authority. */
function trust(ca) {
  if (process.platform === "win32") run("certutil", ["-addstore", "-f", "Root", ca]);
  else if (process.platform === "linux") {
    run("sudo", ["-n", "cp", ca, "/usr/local/share/ca-certificates/artdaddy-update-canary.crt"]);
    run("sudo", ["-n", "update-ca-certificates"]);
  } else {
    const keychain = "/Library/Keychains/System.keychain";
    run("sudo", [
      "-n",
      "security",
      "add-trusted-cert",
      "-d",
      "-r",
      "trustRoot",
      "-k",
      keychain,
      ca,
    ]);
  }
}

/** Send the feed's host to this machine, for every program on it. */
function pointHostHere() {
  const lines = `\n127.0.0.1 ${HOST}\n::1 ${HOST}\n`;
  if (process.platform === "win32") {
    const hosts = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "drivers",
      "etc",
      "hosts",
    );
    appendFileSync(hosts, lines.replace(/\n/g, "\r\n"));
    spawnSync("ipconfig", ["/flushdns"]);
  } else {
    run("sudo", ["-n", "tee", "-a", "/etc/hosts"], { input: lines });
    if (process.platform === "darwin") {
      spawnSync("sudo", ["-n", "dscacheutil", "-flushcache"]);
      spawnSync("sudo", ["-n", "killall", "-HUP", "mDNSResponder"]);
    }
  }
}

/** Start the server in its own process: it must answer while a canary step blocks (the macOS harness does). Port 443
 *  needs root on Linux, so there it runs under sudo, and on macOS too, alike. */
function startServer({ feedFile, cert, key, log, dir }) {
  const out = openSync(path.join(dir, "server.out"), "a");
  const args = [SELF, "server", feedFile, cert, key, log];
  const child =
    process.platform === "win32"
      ? spawn(process.execPath, args, { detached: true, stdio: ["ignore", out, out] })
      : spawn("sudo", ["-n", process.execPath, ...args], {
          detached: true,
          stdio: ["ignore", out, out],
        });
  child.unref();
  closeSync(out);
}

/** The system's own client, from outside Node, gets the staged feed over https from the feed's address. */
async function verifyFromTheSystem(feedFile, dir) {
  const want = readFileSync(feedFile, "utf8");
  const curl = process.platform === "win32" ? "curl.exe" : "curl";
  // Schannel checks revocation, and a certificate made here has no revocation list; the app's verifier does not
  // count an unknown revocation status as a failure (CERT_CHAIN_POLICY_IGNORE_ALL_REV_UNKNOWN_FLAGS).
  const flags = process.platform === "win32" ? ["--ssl-no-revoke"] : [];
  let last = "";
  for (let attempt = 1; attempt <= 20; attempt++) {
    const got = spawnSync(curl, ["-fsS", ...flags, "--max-time", "10", FEED_URL], {
      encoding: "utf8",
    });
    if (got.status === 0 && got.stdout === want) return;
    last =
      got.status === 0
        ? "a different body"
        : `exit ${got.status}: ${(got.stderr || "").trim().slice(0, 400)}`;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  const server = existsSync(path.join(dir, "server.out"))
    ? readFileSync(path.join(dir, "server.out"), "utf8")
    : "";
  throw new Error(
    `${FEED_URL} does not serve the staged feed on this runner (${last}); the server said: ${server.slice(-1500)}`,
  );
}

async function serve() {
  if (process.env.GITHUB_ACTIONS !== "true") {
    throw new Error(
      "only on a disposable GitHub-hosted runner: this edits the hosts file and trusts a certificate",
    );
  }
  const to = process.env.TO_VERSION;
  const repository = process.env.GITHUB_REPOSITORY;
  const temp = process.env.RUNNER_TEMP;
  if (!isVersion(to) || !repository || !temp || !process.env.GITHUB_ENV) {
    throw new Error(
      "TO_VERSION (x.y.z), GITHUB_REPOSITORY, RUNNER_TEMP and GITHUB_ENV are required",
    );
  }
  const dir = path.join(temp, "staged-feed");
  mkdirSync(dir, { recursive: true });
  // What a person reads afterwards goes with the canary's evidence (the job uploads that folder); the keys do not.
  const kept = path.resolve("reports", "qa", "updater-canary", "staged-feed");
  mkdirSync(kept, { recursive: true });

  // 1. The candidate's files, as every app will fetch them: a draft's files are not public, so it must be published
  //    (a pre-release, not yet marked latest), and each platform needs its build and that build's updater signature.
  const release = JSON.parse(
    run("gh", [
      "release",
      "view",
      `v${to}`,
      "--repo",
      repository,
      "--json",
      "isDraft,isPrerelease,assets",
    ]),
  );
  if (release.isDraft) {
    throw new Error(
      `v${to} is still a draft: publish it as a pre-release first, or no app can download its files`,
    );
  }
  const names = new Set(release.assets.map((asset) => asset.name));
  for (const [platform, asset] of Object.entries(PLATFORMS)) {
    if (!names.has(asset))
      throw new Error(
        `v${to} has no ${asset}, so ${platform} would be offered nothing to download`,
      );
    if (!names.has(`${asset}.sig`))
      throw new Error(
        `v${to} has no ${asset}.sig: its ${platform} build is not signed for the updater`,
      );
  }
  run("gh", [
    "release",
    "download",
    `v${to}`,
    "--repo",
    repository,
    "--pattern",
    "*.sig",
    "--dir",
    dir,
    "--clobber",
  ]);
  const signatures = Object.fromEntries(
    Object.entries(PLATFORMS).map(([platform, asset]) => [
      platform,
      readFileSync(path.join(dir, `${asset}.sig`), "utf8"),
    ]),
  );

  // 2. The feed, in the live feed's format (scripts/updateFeed.mjs; its test holds it to the live bytes).
  const runId = process.env.GITHUB_RUN_ID ?? "?";
  const notes = `Staged by the update canary, run ${runId}: v${to} before the live feed offers it.`;
  const feed = feedText({
    repository,
    version: to,
    notes,
    pubDate: new Date().toISOString(),
    signatures,
  });
  const feedFile = path.join(kept, "latest.json");
  writeFileSync(feedFile, feed);

  // 3. The address, the certificate and the server.
  const { ca, cert, key } = makeCertificates(dir);
  trust(ca);
  pointHostHere();
  const log = path.join(kept, "requests.jsonl");
  writeFileSync(log, "");
  startServer({ feedFile, cert, key, log, dir: kept });
  await verifyFromTheSystem(feedFile, kept);

  appendFileSync(process.env.GITHUB_ENV, `STAGED_FEED=${feedFile}\nSTAGED_FEED_LOG=${log}\n`);
  console.log(
    `[staged feed] ${FEED_URL} serves v${to} on this runner and nowhere else (${feedFile})`,
  );
  console.log(feed);
}

/** The server itself: the staged feed at the feed's path, 404 for anything else, every request logged. */
function server([feedFile, cert, key, log]) {
  const feed = readFileSync(feedFile);
  const handler = (request, response) => {
    const entry = {
      at: new Date().toISOString(),
      method: request.method,
      path: request.url,
      userAgent: request.headers["user-agent"] ?? "",
    };
    try {
      appendFileSync(log, `${JSON.stringify(entry)}\n`);
    } catch {
      /* a log that cannot be written must not stop the answer */
    }
    if (request.method === "GET" && new URL(request.url, FEED_URL).pathname === FEED_PATH) {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": feed.length,
        "cache-control": "no-cache",
      });
      response.end(feed);
    } else {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    }
  };
  const options = { cert: readFileSync(cert), key: readFileSync(key) };
  // Loopback only. IPv6 may be off on a runner; IPv4 must work.
  createServer(options, handler).listen(443, "127.0.0.1", () =>
    console.log(`[staged feed] 127.0.0.1:443 serves ${FEED_URL}`),
  );
  createServer(options, handler)
    .on("error", (error) =>
      console.log(`[staged feed] no IPv6 listener (${error.code}); IPv4 serves`),
    )
    .listen(443, "::1", () => console.log(`[staged feed] [::1]:443 serves ${FEED_URL}`));
}

const [command, ...rest] = process.argv.slice(2);
if (command === "serve") {
  await serve();
} else if (command === "server") {
  server(rest);
} else {
  console.error("usage: node scripts/qa/stagedFeed.mjs serve");
  process.exit(2);
}
