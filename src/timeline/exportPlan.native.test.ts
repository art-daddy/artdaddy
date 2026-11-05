// The plan (this module's TypeScript) and the native watcher (src-tauri/src/jobs/budget.rs) state three numbers twice, because
// they run in different processes: the most an export may use (8 GiB), the share of the free memory it may use (three
// quarters), and the quarter of the free memory the PC floor may take. If the two drift, the plan promises an export a ceiling
// the watcher then stops it at (or the floor stops an export the plan accepted). This reads the Rust source itself, so the
// pair cannot fall out of step unnoticed; it asserts what must hold between the two, not what either says on its own.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CEILING_CAP_BYTES, CEILING_SHARE, GIB, ceilingBytes } from "./exportPlan";

const rust = readFileSync(
  path.resolve(__dirname, "../../src-tauri/src/jobs/budget.rs"),
  "utf8",
).replace(/\r\n/g, "\n");

describe("the plan and the native watcher agree on the numbers they share", () => {
  it("allow an export the same most memory: the plan never counts on more than the watcher allows", () => {
    const found = /RENDER_RESIDENT_CEILING: u64 = (\d+) \* 1024 \* 1024 \* 1024;/.exec(rust);
    expect(found, "budget.rs no longer declares RENDER_RESIDENT_CEILING in GiB").not.toBeNull();
    expect(Number(found![1]) * GIB).toBe(CEILING_CAP_BYTES);
  });

  it("allow an export the same share of the free memory", () => {
    // `render_limits`: let share = available_memory.map_or(0, |bytes| bytes / 4 * 3);
    expect(rust).toMatch(/available_memory\.map_or\(0, \|bytes\| bytes \/ 4 \* 3\)/);
    expect(CEILING_SHARE).toBe(3 / 4);
  });

  it("leave the PC its floor: the plan's share and the floor's share of what is free fit in all of it", () => {
    // `pc_floor`: ... .min(free_at_start / 4)
    const found = /\.min\(free_at_start \/ (\d+)\)/.exec(rust);
    expect(
      found,
      "budget.rs no longer caps the floor by a share of the free memory",
    ).not.toBeNull();
    expect(CEILING_SHARE + 1 / Number(found![1])).toBeLessThanOrEqual(1);
    // And in bytes, for the PCs the review found it failing on: the plan's ceiling leaves at least the floor.
    for (const [freeGiB, floorBytes] of [
      [2, 0.5 * GIB], // an 8 GiB PC with 2 GiB free: the floor is a quarter of what was free
      [3, 0.75 * GIB],
      [4, 0.96 * GIB],
    ] as const)
      expect(freeGiB * GIB - ceilingBytes(freeGiB * GIB)).toBeGreaterThanOrEqual(floorBytes);
  });
});
