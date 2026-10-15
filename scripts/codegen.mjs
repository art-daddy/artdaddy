// Generate identity and trusted server snapshots from the client-authored catalog.
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const CLIENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_DIR = process.env.ARTDADDY_SERVER_DIR
  ? resolve(process.env.ARTDADDY_SERVER_DIR) : resolve(CLIENT_DIR, "../Akaru");
const SOURCE = join(CLIENT_DIR, "src/contract/catalog.json");
const CHECK = process.argv.includes("--check");

function write(path, content) {
  if (CHECK) {
    if (!existsSync(path) || readFileSync(path, "utf8").replace(/\r\n/g, "\n") !== content) {
      throw new Error(`generated catalog artifact is stale: ${path}`);
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log("wrote", path);
}

function retain(path, content) {
  if (existsSync(path)) {
    if (readFileSync(path, "utf8").replace(/\r\n/g, "\n") !== content) {
      throw new Error(`immutable catalog artifact was modified: ${path}`);
    }
    return;
  }
  write(path, content);
}

function buildCatalog() {
  const source = readFileSync(SOURCE, "utf8").replace(/\r\n/g, "\n");
  const catalog = JSON.parse(source);
  const compatibility = catalog.compatibility;
  if (!/^\d+\.\d+\.\d+$/.test(catalog.version) ||
      !Number.isSafeInteger(compatibility?.generation) || compatibility.generation < 1 ||
      !Number.isSafeInteger(compatibility?.minimum_generation) || compatibility.minimum_generation < 1 ||
      compatibility.minimum_generation > compatibility.generation) {
    throw new Error("invalid catalog version or compatibility generation");
  }
  if (!Array.isArray(catalog.tools) || !Array.isArray(catalog.effects) || !Array.isArray(catalog.removed_tools)) {
    throw new Error("the client catalog requires tool, effect and removal collections");
  }
  const effects = new Set(["read", "project-mutation", "project-job", "derived-job", "app-operation", "deliverable"]);
  const names = new Set();
  for (const tool of catalog.tools ?? []) {
    if (names.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    if (typeof tool.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(tool.name) ||
        typeof tool.description !== "string" || !tool.description.trim() ||
        tool.parameters?.type !== "object" || !tool.parameters.properties ||
        typeof tool.expensive !== "boolean" || !effects.has(tool.effect) ||
        !["active", "withdrawn"].includes(tool.status) || !Array.isArray(tool.surfaces) ||
        !tool.surfaces.length || new Set(tool.surfaces).size !== tool.surfaces.length ||
        tool.surfaces.some((surface) => !["app", "mcp"].includes(surface)) ||
        (tool.omit_for_native_video !== undefined && typeof tool.omit_for_native_video !== "boolean") ||
        (tool.text_variant !== undefined && (typeof tool.text_variant.description !== "string" ||
          !tool.text_variant.description.trim() || tool.text_variant.parameters?.type !== "object" ||
          !tool.text_variant.parameters.properties))) {
      throw new Error(`incomplete client tool definition: ${tool.name}`);
    }
    names.add(tool.name);
  }
  if (!names.size || catalog.authored_in !== "src/contract/catalog.json") {
    throw new Error("the client-authored catalog is missing or incomplete");
  }
  if (new Set(catalog.removed_tools).size !== catalog.removed_tools.length ||
      catalog.removed_tools.some((name) => typeof name !== "string" || names.has(name))) {
    throw new Error("removed tool tombstones must be unique and cannot have a retained definition");
  }
  return { source, catalog, id: createHash("sha256").update(source).digest("hex") };
}

async function main() {
  const { source, catalog, id } = buildCatalog();
  write(join(CLIENT_DIR, "src/contract/identity.json"), JSON.stringify({ version: catalog.version, id }, null, 2) + "\n");
  if (existsSync(join(SERVER_DIR, "src/akaru/turn/tools"))) {
    const current = join(SERVER_DIR, "src/akaru/turn/tools/generated/catalog.json");
    const retained = join(SERVER_DIR, "src/akaru/turn/tools/generated/catalogs");
    if (existsSync(retained)) {
      for (const name of readdirSync(retained)) {
        const text = readFileSync(join(retained, name), "utf8").replace(/\r\n/g, "\n");
        if (name !== `${createHash("sha256").update(text).digest("hex")}.json`) {
          throw new Error(`immutable catalog artifact was modified: ${name}`);
        }
      }
    }
    if (!CHECK && existsSync(current)) {
      const previous = readFileSync(current, "utf8").replace(/\r\n/g, "\n");
      const previousId = createHash("sha256").update(previous).digest("hex");
      retain(join(retained, `${previousId}.json`), previous);
    }
    write(join(SERVER_DIR, "src/akaru/turn/tools/generated/catalog.json"), source);
    retain(join(retained, `${id}.json`), source);
  }
  console.log(`client catalog ${catalog.version}: ${catalog.tools.length} retained definitions, ${id}`);
  console.log("codegen complete.");
}

main().catch((err) => {
  console.error("codegen failed:", err.message);
  process.exit(1);
});
