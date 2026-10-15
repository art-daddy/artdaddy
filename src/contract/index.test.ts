// The contract is bundled, so the thing worth asserting is no longer "does the fetch recover" —
// it is that the committed catalog is REAL and complete. A bundle regenerated against a broken
// server, or hand-edited, would still import fine and only fail later at a user's tool call.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { allEffects, allTools, catalogIdentity, contractVersion, paramSchema, setContract, toolByName } from ".";
import catalog from "./catalog.json";
import { expensiveToolNames, paramsByTool, toolNames } from "./views";

describe("the bundled catalog", () => {
  it("is populated at import, with no load step to wait for", () => {
    // No await anywhere in this test: an empty catalog here means the app boots with no tools
    // and every MCP call answers "unknown tool".
    expect(allTools().length).toBeGreaterThan(0);
    expect(contractVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("carries descriptions and schemas, not just names", () => {
    // The old fetch existed because the bundle was names-only. If the committed file ever
    // regressed to that, an external agent would get an unusable tool list.
    const withDescription = allTools().filter((t) => t.description.trim().length > 20);
    expect(withDescription.length).toBe(allTools().length);

    const withSchema = allTools().filter((t) => paramSchema(t.name) !== undefined);
    expect(withSchema.length).toBeGreaterThan(allTools().length / 2);
  });

  it("offers only active app tools from the canonical definitions", () => {
    const active = catalog.tools.filter((tool) => tool.status === "active" && tool.surfaces.includes("app"));
    expect(allTools().map((tool) => tool.name).sort()).toEqual(active.map((tool) => tool.name).sort());
    const refused = catalog.tools.filter((tool) => tool.status !== "active" || !tool.surfaces.includes("app"));
    expect(refused.length).toBeGreaterThan(0);
    for (const tool of refused) expect(toolByName(tool.name)).toBeUndefined();
    expect(toolByName("clip_video")).toBeUndefined();
    expect(toolByName("manage_project")).toBeUndefined();
  });

  it("names every tool exactly once", () => {
    const names = toolNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it("marks some tools expensive and not all of them", () => {
    // Both directions: an empty set silently disarms the approval gate, and a full one would
    // make every edit prompt for confirmation.
    const paid = expensiveToolNames();
    expect(paid.length).toBeGreaterThan(0);
    expect(paid.length).toBeLessThan(allTools().length);
    for (const n of paid) expect(toolByName(n)?.expensive).toBe(true);
  });

  it("ships the effect registry the renderer clamps with", () => {
    expect(allEffects().length).toBeGreaterThan(0);
    for (const e of allEffects()) expect(typeof e.id).toBe("string");
  });

  it("derives param views for every offered tool", () => {
    expect(Object.keys(paramsByTool()).sort()).toEqual(toolNames());
  });
});

describe("setContract", () => {
  it("replaces the catalog so a test can drive a specific one", () => {
    setContract({
      version: "1.2.3",
      tools: [{ name: "apply_color", expensive: false, description: "adjust color" }],
    });
    expect(contractVersion()).toBe("1.2.3");
    expect(toolByName("apply_color")?.description).toBe("adjust color");
    expect(toolByName("add_clips")).toBeUndefined();

    setContract(catalog as Parameters<typeof setContract>[0]);
    expect(toolByName("add_clips")).toBeTruthy();
  });
});

describe("generated trusted catalog artifacts", () => {
  const script = join(__dirname, "../../scripts/codegen.mjs");
  const canonical = join(__dirname, "catalog.json");

  it("the compiled identity matches the exact authored source, even without a server checkout", () => {
    const source = readFileSync(canonical, "utf8").replace(/\r\n/g, "\n");
    expect(catalogIdentity()).toBe(createHash("sha256").update(source).digest("hex"));
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "artdaddy-catalog-"));
    const client = join(root, "client");
    const server = join(root, "server");
    const source = join(client, "src/contract/catalog.json");
    const artifacts = join(server, "src/akaru/turn/tools/generated");
    mkdirSync(join(client, "scripts"), { recursive: true });
    mkdirSync(join(client, "src/contract"), { recursive: true });
    mkdirSync(artifacts, { recursive: true });
    copyFileSync(script, join(client, "scripts/codegen.mjs"));
    copyFileSync(canonical, source);
    const run = (check = false) => spawnSync(process.execPath, [join(client, "scripts/codegen.mjs"), ...(check ? ["--check"] : [])], {
      cwd: root, encoding: "utf8", env: { ...process.env, ARTDADDY_SERVER_DIR: server },
    });
    return { root, client, source, artifacts, run };
  }

  it("writes exact source bytes, preserves the old snapshot, and detects artifact drift", () => {
    const environment = fixture();
    try {
      expect(environment.run().status).toBe(0);
      const source = readFileSync(environment.source, "utf8").replace(/\r\n/g, "\n");
      const oldId = createHash("sha256").update(source).digest("hex");
      const identity = JSON.parse(readFileSync(join(environment.client, "src/contract/identity.json"), "utf8"));
      expect(identity.id).toBe(oldId);
      expect(readFileSync(join(environment.artifacts, "catalog.json"), "utf8")).toBe(source);
      expect(readFileSync(join(environment.artifacts, `catalogs/${oldId}.json`), "utf8")).toBe(source);
      const changed = JSON.parse(source);
      changed.version = "3.0.1";
      writeFileSync(environment.source, JSON.stringify(changed, null, 2) + "\n");
      expect(environment.run(true).status).toBe(1);
      expect(environment.run().status).toBe(0);
      expect(readFileSync(join(environment.artifacts, `catalogs/${oldId}.json`), "utf8")).toBe(source);
      writeFileSync(join(environment.artifacts, `catalogs/${oldId}.json`), "{}\n");
      expect(environment.run(true).status).toBe(1);
      expect(environment.run().status).toBe(1);
      expect(readFileSync(join(environment.artifacts, `catalogs/${oldId}.json`), "utf8")).toBe("{}\n");
    } finally {
      rmSync(environment.root, { recursive: true, force: true });
    }
  });

  it.each(["status", "surfaces", "effect", "compatibility"])("refuses invalid %s before emitting a trusted artifact", (field) => {
    const environment = fixture();
    try {
      const source = JSON.parse(readFileSync(environment.source, "utf8"));
      if (field === "compatibility") source.compatibility.minimum_generation = 2;
      else source.tools[0][field] = field === "surfaces" ? ["unknown"] : "unknown";
      writeFileSync(environment.source, JSON.stringify(source) + "\n");
      const result = environment.run();
      expect(result.status).toBe(1);
      expect(() => readFileSync(join(environment.artifacts, "catalog.json"))).toThrow();
    } finally {
      rmSync(environment.root, { recursive: true, force: true });
    }
  });

  it("generates and checks the client identity with the private server checkout absent", () => {
    const environment = fixture();
    try {
      rmSync(join(environment.root, "server"), { recursive: true, force: true });
      expect(environment.run().status).toBe(0);
      const source = readFileSync(environment.source, "utf8").replace(/\r\n/g, "\n");
      const identity = JSON.parse(readFileSync(join(environment.client, "src/contract/identity.json"), "utf8"));
      expect(identity.id).toBe(createHash("sha256").update(source).digest("hex"));
      expect(environment.run(true).status).toBe(0);
    } finally {
      rmSync(environment.root, { recursive: true, force: true });
    }
  });
});
