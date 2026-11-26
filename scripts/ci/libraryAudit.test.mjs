// The library audit (libraryAudit.mjs): report every advisory, fail only on a high one in a library the change
// added or moved. Both directions are tested: what must fail fails, and what must only be reported never fails.
// Runs under vitest (CI's `npm test`) and under `node --test` (the pre-push quick check), so it imports no test
// library beyond the runner: assertions are node:assert, and the random cases come from a seeded generator.
import assert from "node:assert/strict";

import { advisories, changedLibraries, judge, lockVersions, run } from "./libraryAudit.mjs";

const { describe, it } = process.env.VITEST ? await import("vitest") : await import("node:test");

const lock = (packages) => ({
  lockfileVersion: 3,
  packages: {
    "": { name: "app" },
    ...Object.fromEntries(Object.entries(packages).map(([path, version]) => [path, { version }])),
  },
});

const advisory = (name, severity, id) => ({
  source: id,
  name,
  dependency: name,
  title: `${severity} problem in ${name}`,
  url: `https://github.com/advisories/GHSA-${id}`,
  severity,
  range: "<9",
});

/** An `npm audit --json` report: entries of [library, [advisory, ...]]. */
const audit = (entries) => {
  const vulnerabilities = {};
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const [name, list] of entries) {
    vulnerabilities[name] = { name, severity: list[0]?.severity ?? "low", via: list, effects: [], range: "*" };
    for (const item of list) {
      counts[item.severity] += 1;
      counts.total += 1;
    }
  }
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: counts } };
};

const HEAD = lock({
  "node_modules/react": "19.1.0",
  "node_modules/@scope/kit": "2.0.0",
  "node_modules/vite": "6.3.5",
  "node_modules/vite/node_modules/esbuild": "0.25.5",
  "node_modules/esbuild": "0.24.0",
});
const CANARY = audit([["lodash", [advisory("lodash", "high", "35jh-r3h4-6jhm")]]]);

function execute(files, packageName) {
  const printed = [];
  let summary = "";
  const argv = Object.keys(files).flatMap((name) => [`--${name}`, name]);
  if (packageName !== undefined) argv.push("--canary-package", packageName);
  const code = run(argv, {
    read: (name) => (typeof files[name] === "string" ? files[name] : JSON.stringify(files[name])),
    print: (line) => printed.push(line),
    summary: (text) => {
      summary += text;
    },
  });
  return { code, printed: printed.join("\n"), summary };
}

describe("which libraries a change touched", () => {
  it("reads every install path, scoped names and nested copies included", () => {
    const versions = lockVersions(HEAD);
    assert.deepEqual([...versions.get("esbuild")].sort(), ["0.24.0", "0.25.5"]);
    assert.deepEqual([...versions.get("@scope/kit")], ["2.0.0"]);
    assert.equal(versions.has(""), false);
  });

  it("counts a library added or moved to a new version, and nothing else", () => {
    const base = lock({
      "node_modules/react": "19.0.0",
      "node_modules/vite": "6.3.5",
      "node_modules/vite/node_modules/esbuild": "0.25.5",
      "node_modules/esbuild": "0.24.0",
      "node_modules/left-pad": "1.3.0",
    });
    assert.deepEqual([...changedLibraries(HEAD, base)].sort(), ["@scope/kit", "react"]);
    assert.equal(changedLibraries(HEAD, undefined).size, 0, "without a base lockfile nothing changed");
    assert.equal(changedLibraries(HEAD, HEAD).size, 0);
  });
});

describe("the verdict", () => {
  const base = lock({
    "node_modules/react": "19.0.0",
    "node_modules/vite": "6.3.5",
    "node_modules/vite/node_modules/esbuild": "0.25.5",
    "node_modules/esbuild": "0.24.0",
  });

  it("fails on a high advisory in a library the change moved", () => {
    const result = execute({ audit: audit([["react", [advisory("react", "high", "a")]]]), lock: HEAD, "base-lock": base });
    assert.equal(result.code, 1);
    assert.match(result.printed, /::error title=Library audit::react, which this change adds or moves, has a high/);
  });

  it("fails on a critical advisory in a library the change added", () => {
    const result = execute({ audit: audit([["@scope/kit", [advisory("@scope/kit", "critical", "b")]]]), lock: HEAD, "base-lock": base });
    assert.equal(result.code, 1);
  });

  it("only reports a high advisory in a library nobody touched", () => {
    const result = execute({ audit: audit([["vite", [advisory("vite", "high", "c")]]]), lock: HEAD, "base-lock": base });
    assert.equal(result.code, 0);
    assert.match(result.summary, /vite \| high/);
  });

  it("never fails on a moderate or low advisory, changed or not", () => {
    const found = audit([["react", [advisory("react", "moderate", "d"), advisory("react", "low", "e")]]]);
    assert.equal(execute({ audit: found, lock: HEAD, "base-lock": base }).code, 0);
  });

  it("does not blame a library that is only vulnerable through another one", () => {
    const report = audit([["esbuild", [advisory("esbuild", "high", "f")]]]);
    report.vulnerabilities.react = { name: "react", severity: "high", via: ["esbuild"], effects: [], range: "*" };
    const result = execute({ audit: report, lock: HEAD, "base-lock": base });
    assert.equal(result.code, 0, "react moved, but the advisory is esbuild's, and esbuild did not move");
  });

  it("marks which advisories are in the shipped libraries", () => {
    const all = audit([["vite", [advisory("vite", "high", "c")]], ["react", [advisory("react", "low", "g")]]]);
    const shipped = audit([["react", [advisory("react", "low", "g")]]]);
    const { summary } = execute({ audit: all, "shipped-audit": shipped, lock: HEAD });
    assert.match(summary, /\| vite \| high \| .* \| no \(dev\) \| no \|/);
    assert.match(summary, /\| react \| low \| .* \| yes \| no \|/);
  });
});

describe("an audit that cannot be trusted is never a pass", () => {
  for (const [label, canary] of [
    ["the canary came back clean", audit([])],
    ["the canary came back moderate", audit([["lodash", [advisory("lodash", "moderate", "h")]]])],
    ["the canary is not a report", "not json"],
  ]) {
    it(label, () => {
      assert.equal(execute({ audit: audit([]), lock: HEAD, "canary-audit": canary }, "lodash").code, 2);
    });
  }

  for (const [label, report] of [
    ["no report", "not json"],
    ["npm's error object", { error: { code: "ENOLOCK", summary: "no lockfile" } }],
    ["an empty object", {}],
  ]) {
    it(label, () => {
      assert.equal(execute({ audit: report, lock: HEAD, "canary-audit": CANARY }, "lodash").code, 2);
    });
  }

  it("passes with a flagged canary and a clean audit", () => {
    assert.equal(execute({ audit: audit([]), lock: HEAD, "canary-audit": CANARY }, "lodash").code, 0);
  });

  it("checks the canary against the library it names", () => {
    assert.equal(execute({ audit: audit([]), lock: HEAD, "canary-audit": CANARY }, "react").code, 2);
  });
});

describe("the rule over random changes", () => {
  // mulberry32: a small seeded generator, so a failure names a case that can be replayed.
  const random = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const NAMES = ["react", "vite", "esbuild", "@scope/kit", "zod"];
  const VERSIONS = ["1.0.0", "1.1.0", "2.0.0"];
  const SEVERITIES = ["low", "moderate", "high", "critical"];

  it("fails exactly when a high or critical advisory belongs to a library the change added or moved", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = random(seed);
      const pick = (list) => list[Math.floor(next() * list.length)];
      const packages = (count) => Object.fromEntries(NAMES.filter(() => next() < count).map((n) => [`node_modules/${n}`, pick(VERSIONS)]));
      const head = packages(0.8);
      const base = next() < 0.2 ? undefined : packages(0.7);
      const entries = NAMES.filter(() => next() < 0.5).map((n, i) => [n, [advisory(n, pick(SEVERITIES), `${seed}-${i}`)]]);
      const verdict = judge({ audit: audit(entries), lock: lock(head), baseLock: base && lock(base) });
      const moved = (name) => base !== undefined && `node_modules/${name}` in head && base[`node_modules/${name}`] !== head[`node_modules/${name}`];
      const expected = entries.some(([name, list]) => moved(name) && list.some((a) => a.severity === "high" || a.severity === "critical"));
      assert.equal(verdict.code === 1, expected, `seed ${seed}`);
      assert.equal(verdict.rows.length, advisories(audit(entries)).length, `seed ${seed}: every advisory is reported`);
    }
  });
});
