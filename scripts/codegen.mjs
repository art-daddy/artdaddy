// Codegen: generate the bundled tool catalog from the server's registry.
//
//   catalog.py -> src/contract/catalog.json   (needs the SERVER REPO, not a running server)
//
// The catalog is generated from the server SOURCE rather than fetched from a deployment, so it
// can be regenerated, tested and committed in one pass instead of only after a deploy. The
// committed JSON is what the app reads at runtime; contributors without the server repo consume
// it as-is and never run this.
//
// There used to be a second half here generating src/api/schema.d.ts from the server's OpenAPI.
// Nothing imported the result -- src/api/types.ts is hand-written -- so it was a live-server
// dependency with no consumer, and /openapi.json has been removed from the server.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const SERVER_DIR = resolve(process.env.ARTDADDY_SERVER_DIR || "../Akaru");

const WRITTEN = [];

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  WRITTEN.push(path);
  console.log("wrote", path);
}

/** Serialize the catalog straight from the server's tool registry. */
function buildCatalog() {
  if (!existsSync(join(SERVER_DIR, "src", "akaru", "turn", "tools", "catalog.py"))) {
    throw new Error(
      `server repo not found at ${SERVER_DIR} — set ARTDADDY_SERVER_DIR, or skip this step and ` +
        `use the committed src/contract/catalog.json`,
    );
  }
  const venv = join(SERVER_DIR, ".venv", "Scripts", "python.exe");
  const python = existsSync(venv) ? venv : process.env.PYTHON || "python";
  // Descriptions contain non-ASCII (e.g. "→"), which a cp1252 stdout refuses to encode.
  const stdout = execFileSync(python, ["-m", "akaru.turn.tools.catalog"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PYTHONPATH: "src", PYTHONIOENCODING: "utf-8" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const catalog = JSON.parse(stdout);
  if (!catalog.tools?.length) throw new Error("catalog came back with no tools");
  return catalog;
}

async function main() {
  console.log("codegen: catalog from", SERVER_DIR);

  const catalog = buildCatalog();
  // The drift check compares PARSED objects, not bytes: Python and JS JSON writers agree on
  // content but not always on escaping, and a byte comparison would fail on that alone.
  write(
    "src/contract/catalog.json",
    JSON.stringify(catalog, null, 2).replace(/\r\n/g, "\n") + "\n",
  );
  console.log(`  version ${catalog.version}, ${catalog.tools.length} tools`);
  console.log("codegen complete.");
}

main().catch((err) => {
  console.error("codegen failed:", err.message);
  process.exit(1);
});
