import { describe, expect, it, vi } from "vitest";
import type { ClientToolContext } from "./context";
import { joinPath, ProjectStoreAccess, type FsLike } from "./store";
import { withAssScratch } from "./assScratch";
import { endProjectSession } from "./coordinator";
import { FakeJobs } from "../test/fakeJobs";
import { localDeliveryPort } from "../timeline/exportQueue";
import { supervisedRunner } from "./jobSupervisor";

// Pretend to be the desktop app, whose bundled fonts live in resources/fonts.
vi.mock("@tauri-apps/api/path", () => ({ resolveResource: async () => "C:/res/fonts" }));

/** In-memory fs that can see a DIRECTORY (prefix-aware exists, recursive remove), so a test can
 *  prove the scratch dir itself is gone, not just one file in it. */
class DirFs implements FsLike {
  files = new Map<string, string | Uint8Array>();
  async exists(p: string): Promise<boolean> {
    const k = joinPath(p);
    if (this.files.has(k)) return true;
    for (const f of this.files.keys()) if (f.startsWith(`${k}/`)) return true;
    return false;
  }
  async readTextFile(p: string): Promise<string> {
    const v = this.files.get(joinPath(p));
    if (typeof v !== "string") throw new Error(`ENOENT ${p}`);
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    this.files.set(joinPath(p), c);
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const v = this.files.get(joinPath(p));
    if (!(v instanceof Uint8Array)) throw new Error(`ENOENT ${p}`);
    return v;
  }
  async writeBytes(p: string, d: Uint8Array): Promise<void> {
    this.files.set(joinPath(p), d);
  }
  async mkdir(): Promise<void> {}
  async rename(from: string, to: string): Promise<void> {
    const value = this.files.get(joinPath(from));
    if (value === undefined) throw new Error(`ENOENT ${from}`);
    this.files.set(joinPath(to), value);
    this.files.delete(joinPath(from));
  }
  async remove(p: string): Promise<void> {
    const k = joinPath(p);
    for (const f of [...this.files.keys()])
      if (f === k || f.startsWith(`${k}/`)) this.files.delete(f);
  }
  under(dir: string): string[] {
    return [...this.files.keys()].filter((f) => f.startsWith(`${joinPath(dir)}/`));
  }
}

function setup(): { fs: DirFs; ctx: ClientToolContext } {
  const fs = new DirFs();
  fs.files.set("C:/res/fonts/Poppins-Regular.ttf", new Uint8Array([1, 2, 3]));
  const ctx = {
    store: new ProjectStoreAccess("C:/scratch-proj", fs),
    runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
  } as ClientToolContext;
  return { fs, ctx };
}

describe("withAssScratch", () => {
  it.each(["submission", "font staging"])(
    "keeps %s failure scratch owned until terminal acknowledgement",
    async (failure) => {
      const { fs, ctx } = setup();
      const jobs = new FakeJobs();
      jobs.delivery = localDeliveryPort(ctx.store);
      const id = `reserved-${failure.replace(/ /g, "-")}`;
      await jobs.delivery.prepare(
        id,
        ctx.store.projectDir,
        "C:/outputs/.reserved.partial",
        "C:/outputs/reserved.mp4",
        { kind: "render", paths: [] },
      );
      const runner = supervisedRunner(ctx.runner, jobs, {
        id,
        lane: "export",
        meta: { kind: "export" },
      });
      let invoked = false;
      await expect(
        withAssScratch(
          { ...ctx, runner },
          [{ name: "captions.ass", content: "captured caption bytes" }],
          failure === "font staging" ? ["Missing.ttf"] : [],
          async () => {
            invoked = true;
            throw new Error("submission refused before binding");
          },
        ),
      ).rejects.toThrow();
      expect(invoked).toBe(failure === "submission");
      expect(fs.under(ctx.store.projectDir).some((file) => file.endsWith("/captions.ass"))).toBe(
        true,
      );
      expect(jobs.submitted).toEqual([]);
      await jobs.delivery.fail(id);
      await jobs.delivery.complete(id);
      expect(fs.under(ctx.store.projectDir)).toEqual([]);
      expect((await jobs.delivery.list())[0].followups_done).toBe(true);
    },
  );

  it("stages native work outside the project and cleans it after the project session ends", async () => {
    class WorkFs extends DirFs {
      async workDir(): Promise<string> {
        return "C:/owned-app/work";
      }
    }
    const fs = new WorkFs();
    const store = new ProjectStoreAccess("C:/scratch-proj", fs);
    const ctx = { store, runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) } };
    let scratch = "";
    await withAssScratch(
      ctx,
      [{ name: "graph.ffgraph", content: "real staged graph" }],
      [],
      async (cwd) => {
        scratch = cwd!;
        expect(scratch.startsWith("C:/owned-app/work/")).toBe(true);
        expect(await fs.readTextFile(joinPath(scratch, "graph.ffgraph"))).toBe("real staged graph");
        expect(fs.under(store.projectDir)).toEqual([]);
        endProjectSession(store.projectDir);
      },
    );
    expect(fs.under(store.projectDir)).toEqual([]);
    expect(await fs.exists(scratch)).toBe(false);
  });

  it("stages every .ass file and its fonts BEFORE the run, then removes the dir", async () => {
    const { fs, ctx } = setup();
    let seen: string[] = [];
    let cwd: string | undefined;
    const out = await withAssScratch(
      ctx,
      [
        { name: "cap_band0.ass", content: "A" },
        { name: "grid_f0.ass", content: "G" },
      ],
      ["Poppins-Regular.ttf"],
      async (dir) => {
        cwd = dir;
        seen = fs.under(dir!).map((f) => f.slice(joinPath(dir!).length + 1));
        expect(await fs.readTextFile(joinPath(dir!, "grid_f0.ass"))).toBe("G");
        return 7;
      },
    );
    expect(out).toBe(7);
    expect(seen.sort()).toEqual(["cap_band0.ass", "fonts/Poppins-Regular.ttf", "grid_f0.ass"]);
    expect(await fs.exists(cwd!)).toBe(false);
  });

  it("makes no scratch dir at all when nothing is drawn by libass", async () => {
    const { fs, ctx } = setup();
    const before = fs.files.size;
    await withAssScratch(ctx, [], ["Poppins-Regular.ttf"], async (dir) => {
      expect(dir).toBeUndefined();
    });
    expect(fs.files.size).toBe(before);
  });

  it("removes the dir when the run THROWS, and rethrows", async () => {
    const { fs, ctx } = setup();
    let cwd: string | undefined;
    await expect(
      withAssScratch(ctx, [{ name: "a.ass", content: "A" }], [], async (dir) => {
        cwd = dir;
        throw new Error("ffmpeg went away");
      }),
    ).rejects.toThrow("ffmpeg went away");
    expect(cwd).toBeTruthy();
    expect(await fs.exists(cwd!)).toBe(false);
  });

  it("stages a name shared by identical files once", async () => {
    const { fs, ctx } = setup();
    let files: string[] = [];
    await withAssScratch(
      ctx,
      [
        { name: "cap_band0.ass", content: "same" },
        { name: "cap_band0.ass", content: "same" },
      ],
      ["Poppins-Regular.ttf", "Poppins-Regular.ttf"],
      async (dir) => {
        files = fs.under(dir!);
      },
    );
    expect(files).toHaveLength(2); // one .ass, one font
  });

  it("refuses two DIFFERENT files under one name before anything runs or is written", async () => {
    const { fs, ctx } = setup();
    const before = new Map(fs.files);
    const run = vi.fn(async () => undefined);
    await expect(
      withAssScratch(
        ctx,
        [
          { name: "cap_band0.ass", content: "frame 10 captions" },
          { name: "cap_band0.ass", content: "frame 900 captions" },
        ],
        [],
        run,
      ),
    ).rejects.toThrow(/cap_band0\.ass/);
    expect(run).not.toHaveBeenCalled();
    expect(fs.files).toEqual(before);
  });

  it("still runs when a bundled font is missing (libass falls back for that family)", async () => {
    const { fs, ctx } = setup();
    let files: string[] = [];
    await withAssScratch(ctx, [{ name: "a.ass", content: "A" }], ["Missing.ttf"], async (dir) => {
      files = fs.under(dir!);
    });
    expect(files.map((f) => f.split("/").pop())).toEqual(["a.ass"]);
  });
});
