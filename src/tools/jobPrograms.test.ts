// The page names the programs the app process will run as a job; the app process decides. The two
// lists must be one: a program the page thinks it can hand over and Rust refuses is a job that never
// starts, and the reverse is a door nobody meant to open.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { JOB_PROGRAMS } from "./jobSupervisor";

describe("the programs a job may run", () => {
  it("are exactly Rust's SIDECARS, by their logical names", () => {
    const rust = readFileSync(
      path.join(__dirname, "..", "..", "src-tauri", "src", "jobs.rs"),
      "utf8",
    );
    const table = /pub const SIDECARS: &\[\(&str, &str\)\] =\s*&\[([\s\S]*?)\];/.exec(rust);
    expect(table, "SIDECARS in jobs.rs").not.toBeNull();
    const names = [...table![1].matchAll(/\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    expect([...names].sort()).toEqual([...JOB_PROGRAMS].sort());
  });
});
