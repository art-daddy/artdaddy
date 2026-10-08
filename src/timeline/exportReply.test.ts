// What the export tool tells the agent about the file it will deliver. The watermark and the end
// card are added to every export, so the file runs longer than the timeline; an agent that is not
// told reads that as a broken export (QA 2026-10-06: "11 s for a 9 s timeline ... a discrepancy").
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/path", () => ({ resolveResource: async (r: string) => `C:/res/${r}` }));

import { MemFs, registerTestDocument, resetTestDocuments } from "../test/timelineKit";
import { ensureTimeline } from "./engine";
import { __resetExportQueue, whenExportsSettle } from "./exportQueue";
import { addClipsTool } from "./placement";
import { exportTimelineTool } from "./render";
import { ProjectStoreAccess } from "../tools/store";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

afterEach(async () => {
  await whenExportsSettle();
  __resetExportQueue();
  await resetTestDocuments();
});

/** Exports a 9 s timeline (270 frames at 30 fps); the end card measures 2.033 s. */
async function exportNineSeconds(o: { brandAssets: boolean; outputPath?: string }): Promise<Any> {
  const fs = new MemFs();
  if (o.brandAssets)
    for (const r of ["16x9", "1x1", "9x16"])
      for (const f of [`watermark-${r}.png`, `endcard-${r}.mp4`])
        await fs.writeTextFile(`C:/res/resources/brand/${f}`, "asset");
  if (o.outputPath) await fs.writeTextFile("D:/Videos/keep.txt", "x");
  const store = new ProjectStoreAccess("C:/proj", fs);
  registerTestDocument("C:/proj");
  await ensureTimeline(store);
  const runner = {
    run: async (program: string, args: string[]) => {
      if (program === "ffprobe" && args.includes("format=duration"))
        // The end card measures 2.033 s; a.mp4 is long enough for its 9 s clip (a clip is never
        // placed longer than its media).
        return {
          code: 0,
          stdout: /endcard-/.test(args[args.length - 1]) ? "2.033\n" : "60\n",
          stderr: "",
        };
      if (program === "ffmpeg") await fs.writeTextFile(args[args.length - 1], "video");
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const ctx = { store, runner };
  await addClipsTool({ entries: [{ media_ref: "a.mp4", timeline_in: 0, timeline_out: 270 }] }, ctx);
  return exportTimelineTool(o.outputPath ? { output_path: o.outputPath } : {}, ctx);
}

describe("the export reply", () => {
  it("says the watermark and end card are always added, and what that does to the length", async () => {
    const r = await exportNineSeconds({ brandAssets: true });
    expect(r.ok).toBe(true);
    expect(r.duration_s).toBeCloseTo(11.033, 3);
    expect(r.branding).toEqual({ watermark: true, end_card_s: 2.033, timeline_s: 9 });
    const note = String(r.note);
    expect(note).toMatch(/watermark and end card are always added to an export/i);
    expect(note).toContain("11.0 s");
    expect(note).toContain("9.0 s of timeline");
    expect(note).toContain("2.0 s end card");
    expect(note).toContain("Downloads"); // the destination note survives alongside it
  });

  it("says it for an export to a path the caller chose as well", async () => {
    const r = await exportNineSeconds({ brandAssets: true, outputPath: "D:/Videos/cut.mp4" });
    expect(r.ok).toBe(true);
    expect(String(r.note)).toMatch(/always added to an export/i);
    expect(String(r.note)).not.toContain("Downloads");
  });

  // The failure direction: when the brand assets are unavailable the export goes out unbranded,
  // and a reply claiming a watermark and end card would be false.
  it("claims nothing about branding for an export that went out without it", async () => {
    const r = await exportNineSeconds({ brandAssets: false });
    expect(r.ok).toBe(true);
    expect(r.branding).toBeUndefined();
    expect(String(r.note ?? "")).not.toMatch(/end card|watermark/i);
    expect((r.warnings as string[]).join(" ")).toMatch(/unbranded/);
    expect(r.duration_s).toBeCloseTo(9, 3);
  });
});
