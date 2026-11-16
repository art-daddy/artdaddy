import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { NATIVE_RENDER_PROGRAM, nativeRenderCargoArgs } from "./nativeRenderCommand";
import {
  mentionsNativeCases,
  warmNativeTestProgram,
  warmupDecision,
  warmupForRun,
  type WarmChild,
  type WarmupRunDeps,
} from "./nativeWarmup";
import { setupWith } from "./smokeGlobalSetup";

// The smoke lane builds the native test program once before any case starts, so that no case pays
// for a rebuild inside its own deadline. These tests judge what a run ends up doing: whether the
// program is built, whether a run that cannot need it is left alone, and that a build that goes
// wrong never takes the lane down with it.

class FakeChild extends EventEmitter {
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit("close", null);
    return true;
  }
}

function rig(script: (child: FakeChild) => void, timeoutMs = 60_000) {
  const logs: string[] = [];
  const spawned: { program: string; args: string[]; cwd: string }[] = [];
  const child = new FakeChild();
  let clock = 0;
  const deps = {
    cwd: "C:/app/src-tauri",
    timeoutMs,
    log: (line: string) => void logs.push(line),
    now: () => (clock += 1_500),
    spawn: (program: string, args: string[], options: { cwd: string }) => {
      spawned.push({ program, args, cwd: options.cwd });
      queueMicrotask(() => script(child));
      return child as unknown as WarmChild;
    },
  };
  return { deps, logs, spawned, child };
}

const NATIVE_FILE = 'import { ff, runNativeRenderSequence } from "../tools/__e2e";\n';
const PLAIN_FILE = 'import { ff, have } from "../tools/__e2e";\n';

describe("the cargo command behind the native smoke cases", () => {
  it("is the command the cases ran before it was shared", () => {
    expect(NATIVE_RENDER_PROGRAM).toBe("cargo");
    expect(nativeRenderCargoArgs("run")).toEqual([
      "test",
      "--lib",
      "jobs::tests::render_sequence_real_artifact",
      "--",
      "--ignored",
      "--exact",
      "--nocapture",
    ]);
  });

  it("builds the same compiled unit it later runs: only the tail after the unit differs", () => {
    const run = nativeRenderCargoArgs("run");
    const build = nativeRenderCargoArgs("build");
    const unit = run.indexOf("--");
    expect(unit).toBeGreaterThan(0);
    expect(build.slice(0, unit)).toEqual(run.slice(0, unit));
    expect(build.slice(unit)).toEqual(["--no-run"]);
  });
});

describe("warming the native test program", () => {
  it("builds it once, in the crate folder, and says so", async () => {
    const { deps, logs, spawned } = rig((child) => child.emit("close", 0));
    const outcome = await warmNativeTestProgram(deps);
    expect(outcome.state).toBe("built");
    expect(spawned).toEqual([
      { program: "cargo", args: nativeRenderCargoArgs("build"), cwd: "C:/app/src-tauri" },
    ]);
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs[0]).toContain("--no-run");
    expect(logs.at(-1)).toMatch(/ready in \d+(\.\d)? s/);
    expect(outcome.seconds).toBeGreaterThan(0);
  });

  it("does not throw when the build fails: the cases then report their own error", async () => {
    const { deps, logs } = rig((child) => child.emit("close", 101));
    const outcome = await warmNativeTestProgram(deps);
    expect(outcome).toMatchObject({ state: "failed", code: 101 });
    expect(logs.at(-1)).toContain("exit code 101");
  });

  it("does not throw when cargo is missing and says the cases will fail as they did before", async () => {
    const { deps, logs } = rig((child) =>
      child.emit("error", Object.assign(new Error("spawn cargo ENOENT"), { code: "ENOENT" })),
    );
    const outcome = await warmNativeTestProgram(deps);
    expect(outcome.state).toBe("no-cargo");
    expect(logs.at(-1)).toMatch(/not found/i);
  });

  it("reports a missing cargo once, although node also closes the child with a negative code", async () => {
    const { deps, logs } = rig((child) => {
      child.emit("error", Object.assign(new Error("spawn cargo ENOENT"), { code: "ENOENT" }));
      child.emit("close", -4058);
    });
    const outcome = await warmNativeTestProgram(deps);
    expect(outcome.state).toBe("no-cargo");
    expect(
      logs.filter((line) => /not found|ended with exit code|ready in|gave up/.test(line)),
    ).toHaveLength(1);
  });

  it("reports another spawn error as a failed build, not as a missing cargo", async () => {
    const { deps } = rig((child) =>
      child.emit("error", Object.assign(new Error("spawn cargo EACCES"), { code: "EACCES" })),
    );
    expect((await warmNativeTestProgram(deps)).state).toBe("failed");
  });

  it("survives a spawn that throws", async () => {
    const { deps } = rig(() => undefined);
    const outcome = await warmNativeTestProgram({
      ...deps,
      spawn: () => {
        throw new Error("EPERM");
      },
    });
    expect(outcome.state).toBe("failed");
  });

  it("stops a build that never ends and lets the run go on", async () => {
    const { deps, child, logs } = rig(() => undefined, 20);
    const outcome = await warmNativeTestProgram(deps);
    expect(outcome.state).toBe("timed-out");
    expect(child.killed).toBe(true);
    expect(logs.at(-1)).toMatch(/gave up/i);
  });
});

describe("deciding whether a smoke run needs the native test program", () => {
  const base = {
    env: {},
    hasCrate: true,
    runFiles: ["src/a.smoke.e2e.ts"] as readonly string[] | undefined,
    readText: (file: string) => (file.includes("native") ? NATIVE_FILE : PLAIN_FILE),
  };

  it("warms when a file of the run calls the native render harness", () => {
    const decision = warmupDecision({ ...base, runFiles: ["src/a.ts", "src/native.e2e.ts"] });
    expect(decision.warm).toBe(true);
  });

  it("leaves a run alone when no file of it can start a native case", () => {
    expect(warmupDecision(base).warm).toBe(false);
  });

  it("warms when it cannot tell which files the run holds, or cannot read one", () => {
    expect(warmupDecision({ ...base, runFiles: undefined }).warm).toBe(true);
    expect(warmupDecision({ ...base, readText: () => undefined }).warm).toBe(true);
  });

  it("is switched off by the opt-out and never by a value that is not 1", () => {
    const native = { ...base, runFiles: ["native.e2e.ts"] };
    expect(warmupDecision({ ...native, env: { ARTDADDY_SMOKE_NO_WARMUP: "1" } }).warm).toBe(false);
    for (const value of ["0", "", "false", undefined])
      expect(warmupDecision({ ...native, env: { ARTDADDY_SMOKE_NO_WARMUP: value } }).warm).toBe(
        true,
      );
  });

  it("builds nothing where there is no crate", () => {
    expect(warmupDecision({ ...base, runFiles: ["native.e2e.ts"], hasCrate: false }).warm).toBe(
      false,
    );
  });

  it("never skips a run that holds a native case, wherever it sits and whatever else is set", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ maxLength: 40 }).filter((t) => !mentionsNativeCases(t)),
          { maxLength: 12 },
        ),
        fc.nat(12),
        fc.dictionary(
          fc
            .string({ minLength: 1, maxLength: 12 })
            .filter((k) => k !== "ARTDADDY_SMOKE_NO_WARMUP"),
          fc.string({ maxLength: 6 }),
        ),
        (others, at, env) => {
          const texts = [...others];
          texts.splice(Math.min(at, texts.length), 0, NATIVE_FILE);
          const decision = warmupDecision({
            env,
            hasCrate: true,
            runFiles: texts.map((_, i) => `f${i}`),
            readText: (file) => texts[Number(file.slice(1))],
          });
          return decision.warm;
        },
      ),
    );
  });

  it("never warms a run of readable files none of which can start a native case", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ maxLength: 60 }).filter((t) => !mentionsNativeCases(t)),
          { maxLength: 12 },
        ),
        (texts) =>
          !warmupDecision({
            env: {},
            hasCrate: true,
            runFiles: texts.map((_, i) => `f${i}`),
            readText: (file) => texts[Number(file.slice(1))],
          }).warm,
      ),
    );
  });
});

describe("warming for a vitest run", () => {
  function run(overrides: Partial<Parameters<typeof warmupForRun>[0]> = {}, exit = 0) {
    const built = rig((child) => child.emit("close", exit));
    const deps = {
      ...built.deps,
      env: {},
      root: "C:/app",
      runFiles: () => ["C:/app/src/native.e2e.ts"],
      readText: (file: string) => (file.includes("native") ? NATIVE_FILE : PLAIN_FILE),
      exists: () => true,
      ...overrides,
    };
    delete (deps as { cwd?: string }).cwd;
    return { ...built, result: warmupForRun(deps) };
  }

  it("builds in <root>/src-tauri when the run holds a native case", async () => {
    const { result, spawned } = run();
    expect((await result).warmed).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toEqual(nativeRenderCargoArgs("build"));
    expect(spawned[0].cwd.replace(/\\/g, "/")).toBe("C:/app/src-tauri");
  });

  it("builds anyway when vitest cannot list the run's files", async () => {
    const { result, spawned } = run({
      runFiles: () => {
        throw new Error("state moved");
      },
    });
    expect((await result).warmed).toBe(true);
    expect(spawned).toHaveLength(1);
  });

  it("does not start cargo for a run of files that cannot need it, and logs why", async () => {
    const { result, spawned, logs } = run({ runFiles: () => ["C:/app/src/orientation.e2e.ts"] });
    expect((await result).warmed).toBe(false);
    expect(spawned).toHaveLength(0);
    expect(logs.join("\n")).toMatch(/skipped/i);
  });

  it("does not start cargo under the opt-out", async () => {
    const { result, spawned } = run({ env: { ARTDADDY_SMOKE_NO_WARMUP: "1" } });
    expect((await result).warmed).toBe(false);
    expect(spawned).toHaveLength(0);
  });

  it("lets the run go on after a failed build", async () => {
    const { result } = run({}, 101);
    await expect(result).resolves.toMatchObject({ warmed: true, outcome: { state: "failed" } });
  });

  it("builds when the file list is not a list, or when reading a file of it throws", async () => {
    const notAList = run({ runFiles: (() => 42) as unknown as () => string[] });
    expect((await notAList.result).warmed).toBe(true);
    const unreadable = run({
      readText: () => {
        throw new Error("EBUSY");
      },
    });
    expect((await unreadable.result).warmed).toBe(true);
  });
});

// The entry vitest calls. Its one promise: whatever goes wrong inside the warm-up, the run goes on.
describe("the global setup", () => {
  const project = (paths: () => string[]) => ({ vitest: { state: { getPaths: paths } } });
  function fakes(extra: Partial<WarmupRunDeps> = {}) {
    const built = rig((child) => child.emit("close", 0));
    const { cwd, ...deps } = built.deps;
    void cwd;
    const overrides = {
      ...deps,
      env: {},
      root: "C:/app",
      exists: () => true,
      readText: () => NATIVE_FILE,
      ...extra,
    };
    return { built, overrides };
  }

  it("builds once for a run that holds a native case", async () => {
    const { built, overrides } = fakes();
    await setupWith(
      project(() => ["C:/app/src/native.e2e.ts"]),
      overrides,
    );
    expect(built.spawned).toHaveLength(1);
    expect(built.spawned[0].args).toEqual(nativeRenderCargoArgs("build"));
  });

  it("does not let an unexpected error out: the run goes on, and the log says so", async () => {
    const { built, overrides } = fakes({
      now: () => {
        throw new Error("clock broke");
      },
    });
    await expect(
      setupWith(
        project(() => ["C:/app/src/native.e2e.ts"]),
        overrides,
      ),
    ).resolves.toBeUndefined();
    expect(built.logs.join("\n")).toMatch(/unexpected error, the run goes on \(clock broke\)/);
  });

  it("does not let an error out even when it cannot be reported", async () => {
    const { overrides } = fakes({
      now: () => {
        throw "not an Error";
      },
      log: () => {
        throw new Error("stdout closed");
      },
    });
    await expect(
      setupWith(
        project(() => ["f"]),
        overrides,
      ),
    ).resolves.toBeUndefined();
  });
});

// A rule is only as good as the files it is judged against: these walk the real smoke lane (the
// e2e files, the harness and the test-support folder; reading every source file would take 11 s).
describe("the smoke lane's real files", () => {
  const src = path.resolve(process.cwd(), "src");
  const files = (readdirSync(src, { recursive: true }) as string[])
    .map((f) => f.replace(/\\/g, "/"))
    .filter(
      (f) =>
        f.endsWith(".e2e.ts") ||
        f === "tools/__e2e.ts" ||
        (/^test\/[^/]+\.ts$/.test(f) && !f.endsWith(".test.ts")),
    );
  const text = (f: string) => readFileSync(path.join(src, f), "utf8");

  it("sees the lane at all", () => {
    expect(files.filter((f) => f.endsWith(".e2e.ts")).length).toBeGreaterThan(20);
    expect(files).toContain("tools/__e2e.ts");
    expect(files).toContain("test/nativeRenderCommand.ts");
  });

  it("starts cargo from one place only, the shared command module", () => {
    const spawners = files.filter((f) => /["']cargo["']/.test(text(f)));
    expect(spawners).toEqual(["test/nativeRenderCommand.ts"]);
  });

  it("gives every smoke file that starts a native case a warm-up, and the harness still has that entry", () => {
    const harness = text("tools/__e2e.ts");
    expect(harness).toContain("export async function runNativeRenderSequence(");
    expect(harness).toContain('nativeRenderCargoArgs("run")');
    const callers = files.filter(
      (f) => f.endsWith(".e2e.ts") && /runNativeRenderSequence\(/.test(text(f)),
    );
    expect(callers).toContain("timeline/exportRange.smoke.e2e.ts");
    expect(callers).toContain("timeline/longTimeline.smoke.e2e.ts");
    for (const caller of callers) expect(mentionsNativeCases(text(caller)), caller).toBe(true);
  });

  it("registers the warm-up in the smoke config, which is the one that runs the native cases", async () => {
    const config = readFileSync(path.resolve(process.cwd(), "vitest.smoke.config.ts"), "utf8");
    expect(config).toMatch(/globalSetup:\s*\[\s*["']\.\/src\/test\/smokeGlobalSetup\.ts["']\s*\]/);
    expect(existsSync(path.join(src, "test/smokeGlobalSetup.ts"))).toBe(true);
    const module = await import("./smokeGlobalSetup");
    expect(typeof module.default).toBe("function");
  });

  it("is not part of the unit config, whose runs never need the native program", () => {
    const unit = readFileSync(path.resolve(process.cwd(), "vitest.config.ts"), "utf8");
    expect(unit).not.toContain("globalSetup");
  });
});
