/**
 * Which pushes run the whole local gate. A push of main runs all of it (build + vitest, the Node exporter QA controls,
 * cargo test, the real-ffmpeg goldens and the server's tool-contract test); any other push runs a quick check (the
 * spend check, prettier and the type check on what changed, and the tests of the changed files), because CI runs the
 * suite on the pull request. The real hook runs in a real POSIX shell against a sandbox git repository, with stand-ins
 * for npm, npx, node, cargo, ffmpeg, ffprobe and python that write down the command they were given and do nothing
 * else. What is asserted is what the push ran, and whether it was stopped.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOOK = resolve(process.cwd(), ".githooks", "pre-push");
const ZEROS = "0".repeat(40);
const SLOW = 120_000;
const STAND_INS = ["npm", "npx", "node", "cargo", "ffmpeg", "ffprobe", "python", "python3"];
// What only the whole gate runs.
const WHOLE_GATE = [
  "npm run build",
  "npm test",
  "node --test scripts/qa/exporterPromiseReport.test.mjs scripts/qa/exporterSources.test.mjs scripts/qa/exporterLinuxMemory.test.mjs scripts/qa/exporterQualification.test.mjs",
  "cargo test",
  "npm run smoke",
  "python tests/pytest_without_spend_keys.py tests/unit/turn/tools/test_client_bundle.py -q",
];

const posix = (path: string): string => path.replace(/\\/g, "/");

function which(command: string): string | null {
  const found = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
    encoding: "utf8",
  });
  return found.status === 0 ? (found.stdout.split(/\r?\n/)[0]?.trim() ?? null) || null : null;
}

function posixShell(): string | null {
  const sh = which("sh");
  if (sh) return sh;
  const git = which("git");
  if (!git) return null;
  const gitRoot = dirname(dirname(git));
  return (
    [join(gitRoot, "usr", "bin", "sh.exe"), join(gitRoot, "bin", "sh.exe")].find((candidate) =>
      existsSync(candidate),
    ) ?? null
  );
}

const SHELL = posixShell();

// Writes "<name>\t<arguments>\t<ARTDADDY_SPEND_KEYS or unset>" and fails when the call matches HOOK_TEST_FAIL.
const standIn = (name: string): string => `#!/bin/sh
printf '%s\\t%s\\t%s\\n' "${name}" "$*" "\${ARTDADDY_SPEND_KEYS-unset}" >> "$HOOK_TEST_LOG"
if [ -n "$HOOK_TEST_FAIL" ]; then
  case "${name} $*" in
    $HOOK_TEST_FAIL) exit 1 ;;
  esac
fi
exit 0
`;

interface Call {
  command: string;
  optIn: string;
}

interface Pushed {
  status: number | null;
  output: string;
  calls: Call[];
}

function write(root: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
}

const GIT = [
  "-c",
  "user.name=hook test",
  "-c",
  "user.email=hook-test",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.hooksPath=no-hooks",
];

// The environment with nothing that points git at another repository. Git exports GIT_DIR (and more) to the hook it runs,
// and this file runs inside the hook's quick check: without this, the sandbox's git would commit into, re-initialise and
// move the refs of the repository being pushed (it happened once, in the server's twin of this test). The ceiling stops
// git looking above the sandbox.
function isolated(ceiling: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^GIT_/i.test(name)) env[name] = value;
  }
  env.GIT_CEILING_DIRECTORIES = existsSync(ceiling) ? realpathSync.native(ceiling) : ceiling;
  return env;
}

function git(repo: string, ...args: string[]): string {
  const done = spawnSync("git", [...GIT, ...args], {
    cwd: repo,
    env: isolated(dirname(repo)),
    encoding: "utf8",
  });
  if (done.status !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr}`);
  return done.stdout.trim();
}

// A repository whose base commit is on origin/main, beside a fake wiki and a fake server checkout.
function build(top: string): void {
  write(join(top, "wiki"), { "scripts/spend_guard.py": "" });
  write(join(top, "server"), {
    "src/akaru/turn/tools/catalog.py": "",
    "tests/pytest_without_spend_keys.py": "",
  });
  const repo = join(top, "repo");
  write(repo, {
    "package.json": "{}\n",
    "src/feature/thing.ts": "export const thing = 1;\n",
    "src/feature/thing.test.ts": "export {};\n",
    "src/feature/thing.property.test.ts": "export {};\n",
    "src/feature/other.ts": "export const other = 1;\n",
    "src/feature/lonely.ts": "export const lonely = 1;\n",
    "src/styles/app.css": "body {}\n",
    "scripts/qa/tool.mjs": "export {};\n",
    "scripts/qa/tool.test.mjs": "export {};\n",
    "e2e/ui/area/flow.spec.ts": "export {};\n",
    "docs/notes.md": "notes\n",
    "src-tauri/Cargo.toml": "\n",
  });
  const before = spawnSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: repo,
    env: isolated(top),
    encoding: "utf8",
  });
  if (before.status === 0)
    throw new Error(`before init, the sandbox's git acts on ${before.stdout.trim()}`);
  git(repo, "init", "-q", "-b", "main");
  const found = realpathSync.native(git(repo, "rev-parse", "--absolute-git-dir"));
  if (found !== realpathSync.native(join(repo, ".git"))) {
    throw new Error(`the sandbox's git acts on ${found}, not on the sandbox`);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
}

class Sandbox {
  readonly repo: string;
  readonly log: string;
  readonly wiki: string;
  readonly server: string;
  readonly base: string;

  constructor(
    readonly top: string,
    private readonly shim: string,
  ) {
    this.repo = join(top, "repo");
    this.log = join(top, "hook.log");
    this.wiki = join(top, "wiki");
    this.server = join(top, "server");
    this.base = git(this.repo, "rev-parse", "HEAD");
  }

  change(message: string, files: Record<string, string>, remove: string[] = []): string {
    write(this.repo, files);
    for (const name of remove) unlinkSync(join(this.repo, name));
    git(this.repo, "add", "-A");
    git(this.repo, "commit", "-q", "-m", message);
    return git(this.repo, "rev-parse", "HEAD");
  }

  push(lines: string[], environment: Record<string, string> = {}): Pushed {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(isolated(this.top))) {
      if (/^path$/i.test(name) || /^(ARTDADDY_|HOOK_TEST_)/i.test(name)) continue;
      env[name] = value;
    }
    env.PATH = this.shim + delimiter + (process.env.PATH ?? process.env.Path ?? "");
    env.HOOK_TEST_LOG = posix(this.log);
    env.ARTDADDY_WIKI_DIR = posix(this.wiki);
    env.ARTDADDY_SERVER_DIR = posix(this.server);
    Object.assign(env, environment);
    rmSync(this.log, { force: true });
    const done = spawnSync(SHELL as string, [posix(HOOK)], {
      cwd: this.repo,
      env,
      input: lines.map((line) => `${line}\n`).join(""),
      encoding: "utf8",
      timeout: SLOW,
    });
    const calls = existsSync(this.log)
      ? readFileSync(this.log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((entry) => {
            const [name, args, optIn] = entry.split("\t");
            return { command: `${name} ${args}`.trim(), optIn: optIn ?? "" };
          })
      : [];
    return { status: done.status, output: `${done.stdout}${done.stderr}`, calls };
  }
}

// One line of what git writes on the hook's stdin.
const line = (remoteRef: string, localSha: string, remoteSha = ZEROS, localRef?: string): string =>
  `${localRef ?? remoteRef} ${localSha} ${remoteRef} ${remoteSha}`;

const commands = (pushed: Pushed): string[] => pushed.calls.map((call) => call.command);
const ranWholeGate = (pushed: Pushed): string[] =>
  WHOLE_GATE.filter((step) => commands(pushed).includes(step));
const ran = (pushed: Pushed, prefix: string): string[] =>
  commands(pushed).filter((call) => call.startsWith(prefix));

describe.skipIf(SHELL === null)(
  "the pre-push hook: the whole gate for a push of main, a quick check otherwise",
  () => {
    let root = "";
    let template = "";
    let shim = "";
    let count = 0;

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "pre-push-"));
      shim = join(root, "shim");
      mkdirSync(shim);
      for (const name of STAND_INS) {
        writeFileSync(join(shim, name), standIn(name));
        chmodSync(join(shim, name), 0o755);
      }
      template = join(root, "template");
      build(template);
    }, SLOW);

    afterAll(() => {
      if (root) rmSync(root, { recursive: true, force: true });
    });

    const sandbox = (): Sandbox => {
      const top = join(root, `box-${++count}`);
      cpSync(template, top, { recursive: true });
      return new Sandbox(top, shim);
    };

    it(
      "a work-branch push runs the quick check on what changed, and none of the whole gate",
      () => {
        const box = sandbox();
        const tip = box.change("work", {
          "src/feature/thing.ts": "export const thing = 2;\n",
          "src/styles/app.css": "body { margin: 0; }\n",
          "scripts/qa/tool.mjs": "export const tool = 1;\n",
        });

        const pushed = box.push([line("refs/heads/work/x", tip)]);

        expect(pushed.status, pushed.output).toBe(0);
        expect(ranWholeGate(pushed), "a work-branch push ran part of the whole gate").toEqual([]);
        expect(pushed.output).toContain("whole gate is skipped");
        expect(commands(pushed)).toContain(
          `python3 ${posix(box.wiki)}/scripts/spend_guard.py check --name client --repo . --rev ${tip}`,
        );
        expect(ran(pushed, "npx prettier")).toEqual([
          "npx prettier --check src/feature/thing.ts src/styles/app.css",
        ]);
        expect(ran(pushed, "npx tsc")).toHaveLength(1);
        const vitest = ran(pushed, "npx vitest");
        expect(vitest).toHaveLength(1);
        expect(
          vitest[0]?.split(" ").slice(4).sort(),
          "not the tests beside the changed file",
        ).toEqual(["src/feature/thing.property.test.ts", "src/feature/thing.test.ts"]);
        expect(ran(pushed, "node")).toEqual(["node --test scripts/qa/tool.test.mjs"]);
      },
      SLOW,
    );

    it(
      "the git settings a hook inherits never reach another repository",
      () => {
        // Git exports GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE to the hook whose quick check runs this file. They point at
        // a decoy while a sandbox is built and pushed: the decoy's config, index, refs and HEAD must not change at all.
        const decoy = join(root, "decoy");
        write(decoy, { "keep.txt": "keep\n" });
        git(decoy, "init", "-q", "-b", "main");
        git(decoy, "add", "-A");
        git(decoy, "commit", "-q", "-m", "decoy");
        const snapshot = (): string[] => [
          readFileSync(join(decoy, ".git", "config"), "utf8"),
          readFileSync(join(decoy, ".git", "index")).toString("base64"),
          git(decoy, "for-each-ref"),
          git(decoy, "rev-parse", "HEAD"),
        ];
        const before = snapshot();
        const poison: Record<string, string> = {
          GIT_DIR: join(decoy, ".git"),
          GIT_WORK_TREE: decoy,
          GIT_INDEX_FILE: join(decoy, ".git", "index"),
        };
        const saved = Object.keys(poison).map((name) => [name, process.env[name]] as const);
        const pushed = ((): Pushed => {
          Object.assign(process.env, poison);
          try {
            const top = join(root, "poisoned");
            build(top);
            const box = new Sandbox(top, shim);
            const tip = box.change("work", { "src/feature/thing.ts": "export const thing = 2;\n" });
            return box.push([line("refs/heads/work/x", tip)]);
          } finally {
            for (const [name, value] of saved) {
              if (value === undefined) delete process.env[name];
              else process.env[name] = value;
            }
          }
        })();

        expect(pushed.status, pushed.output).toBe(0);
        expect(
          ran(pushed, "npx vitest"),
          "the sandbox's hook read another repository",
        ).toHaveLength(1);
        expect(snapshot(), "a sandbox's git reached the decoy repository").toEqual(before);
      },
      SLOW,
    );

    it(
      "a push of main runs the whole gate, and the server test without the spend opt-in",
      () => {
        const box = sandbox();
        const tip = box.change("work", { "src/feature/thing.ts": "export const thing = 2;\n" });

        const pushed = box.push([line("refs/heads/main", tip, box.base)], {
          ARTDADDY_SPEND_KEYS: "1",
        });

        expect(pushed.status, pushed.output).toBe(0);
        expect(ranWholeGate(pushed), "a push of main skipped part of the whole gate").toEqual(
          WHOLE_GATE,
        );
        expect(ran(pushed, "npx"), "a push of main ran the quick check instead").toEqual([]);
        const contract = pushed.calls.find((call) =>
          call.command.includes("test_client_bundle.py"),
        );
        expect(contract?.optIn).toBe("unset");
      },
      SLOW,
    );

    it(
      "a server checkout without the key-blanking helper still runs the contract test without the opt-in",
      () => {
        const box = sandbox();
        rmSync(join(box.server, "tests", "pytest_without_spend_keys.py"));

        const pushed = box.push([line("refs/heads/main", box.base, box.base)], {
          ARTDADDY_SPEND_KEYS: "1",
        });

        expect(pushed.status, pushed.output).toBe(0);
        const contract = pushed.calls.find((call) =>
          call.command.includes("test_client_bundle.py"),
        );
        expect(contract).toEqual({
          command: "python -m pytest tests/unit/turn/tools/test_client_bundle.py -q",
          optIn: "unset",
        });
      },
      SLOW,
    );

    it(
      "main on any line of the push makes it a push of main",
      () => {
        const box = sandbox();
        const tip = box.change("work", { "src/feature/thing.ts": "export const thing = 2;\n" });

        const pushed = box.push([
          line("refs/heads/work/x", tip),
          line("refs/heads/main", tip, box.base),
          line("refs/tags/v1", tip),
        ]);

        expect(pushed.status, pushed.output).toBe(0);
        expect(ranWholeGate(pushed)).toEqual(WHOLE_GATE);
      },
      SLOW,
    );

    it(
      "no other ref counts as main: a longer name, a tag, another case, or local main pushed to a work branch",
      () => {
        const box = sandbox();
        const tip = box.change("work", { "src/feature/thing.ts": "export const thing = 2;\n" });

        const pushed = box.push([
          line("refs/heads/mainline", tip),
          line("refs/heads/work/main", tip),
          line("refs/heads/Main", tip),
          line("refs/tags/main", tip),
          line("refs/heads/work/x", tip, ZEROS, "refs/heads/main"),
        ]);

        expect(pushed.status, pushed.output).toBe(0);
        expect(ranWholeGate(pushed)).toEqual([]);
        expect(ran(pushed, "npx vitest")).toHaveLength(1);
      },
      SLOW,
    );

    it(
      "run by hand with nothing on stdin, the hook runs the whole gate",
      () => {
        const pushed = sandbox().push([]);

        expect(pushed.status, pushed.output).toBe(0);
        expect(ranWholeGate(pushed)).toEqual(WHOLE_GATE);
      },
      SLOW,
    );

    it(
      "a push of browser tests only (a QA worker's) runs neither the type check nor a unit test",
      () => {
        const box = sandbox();
        const tip = box.change("qa", {
          "e2e/ui/area/flow.spec.ts": "export const flow = 1;\n",
          "docs/notes.md": "more\n",
        });

        const pushed = box.push([line("refs/heads/work/qa", tip)]);

        expect(pushed.status, pushed.output).toBe(0);
        expect(ran(pushed, "npx")).toEqual([]);
        expect(ran(pushed, "node")).toEqual([]);
        expect(ranWholeGate(pushed)).toEqual([]);
        expect(pushed.output).toContain("type check skipped");
      },
      SLOW,
    );

    it(
      "a push that only deletes a source file still gets the type check: an import of it may now be broken",
      () => {
        const box = sandbox();
        const tip = box.change("drop one", {}, ["src/feature/other.ts"]);

        const pushed = box.push([line("refs/heads/work/x", tip)]);

        expect(pushed.status, pushed.output).toBe(0);
        expect(ran(pushed, "npx tsc")).toHaveLength(1);
        expect(ran(pushed, "npx prettier")).toEqual([]);
        expect(ran(pushed, "npx vitest")).toEqual([]);
      },
      SLOW,
    );

    it(
      "a changed source file with no test beside it is formatted and type-checked, and runs no unit test",
      () => {
        const box = sandbox();
        const tip = box.change("lonely", { "src/feature/lonely.ts": "export const lonely = 2;\n" });

        const pushed = box.push([line("refs/heads/work/x", tip)]);

        expect(pushed.status, pushed.output).toBe(0);
        expect(ran(pushed, "npx tsc")).toHaveLength(1);
        expect(ran(pushed, "npx prettier")).toEqual(["npx prettier --check src/feature/lonely.ts"]);
        expect(ran(pushed, "npx vitest")).toEqual([]);
        expect(pushed.output).toContain("no unit test file belongs to the changed files");
      },
      SLOW,
    );

    it.each([
      ["the spend check", "python3 */spend_guard.py*", ["npx", "node"]],
      ["the format check", "npx prettier*", ["npx tsc", "npx vitest", "node"]],
      ["the type check", "npx tsc*", ["npx vitest", "node"]],
      ["a unit test", "npx vitest*", ["node"]],
      ["a Node test", "node --test*", []],
    ])(
      "a failure of %s stops the push before the steps after it",
      (_step, failing, notAfter) => {
        const box = sandbox();
        const tip = box.change("work", {
          "src/feature/thing.ts": "export const thing = 2;\n",
          "scripts/qa/tool.mjs": "export const tool = 1;\n",
        });

        const pushed = box.push([line("refs/heads/work/x", tip)], { HOOK_TEST_FAIL: failing });

        expect(pushed.status, pushed.output).not.toBe(0);
        expect(pushed.output).toMatch(/FAILED/);
        for (const step of notAfter)
          expect(ran(pushed, step), `${step} ran after the failure`).toEqual([]);
        expect(ranWholeGate(pushed)).toEqual([]);
      },
      SLOW,
    );

    it(
      "without the companion checkout the spend check says it is skipped and the rest goes on",
      () => {
        const box = sandbox();
        const tip = box.change("work", { "src/feature/thing.ts": "export const thing = 2;\n" });

        const pushed = box.push([line("refs/heads/work/x", tip)], {
          ARTDADDY_WIKI_DIR: posix(join(box.top, "nowhere")),
        });

        expect(pushed.status, pushed.output).toBe(0);
        expect(pushed.output).toContain("spend check skipped");
        expect(ran(pushed, "python")).toEqual([]);
        expect(ran(pushed, "npx vitest")).toHaveLength(1);
      },
      SLOW,
    );
  },
);
