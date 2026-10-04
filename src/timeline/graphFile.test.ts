// A long timeline's filter graph goes to a file (3f): Windows refuses a command line over 32,767
// characters, and every clip adds an input and a chain, so ~80 clips stopped exports starting.
// The pixel proof is longTimeline.smoke.e2e.ts; these pin the rule at its one boundary.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { graphFromFile } from "./render";

const shortArgs = [
  "-y",
  "-i",
  "/a.mp4",
  "-filter_complex",
  "[0:v]null[o]",
  "-map",
  "[o]",
  "/o.mp4",
];

describe("graphFromFile", () => {
  it("leaves a short command exactly as it was", () => {
    const caps = [{ name: "cap_band0.ass", content: "X" }];
    const r = graphFromFile(shortArgs, caps);
    expect(r.args).toEqual(shortArgs);
    expect(r.files).toEqual(caps);
  });

  it("moves a long graph into a staged file, keeping every other argument and caption file", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 20_000, max: 400_000 }),
        fc.array(
          fc.record({ name: fc.constantFrom("cap_band0.ass", "grid.ass"), content: fc.string() }),
          {
            maxLength: 2,
          },
        ),
        (len, caps) => {
          const graph = "[0:v]" + "null,".repeat(Math.ceil(len / 5)) + "null[o]";
          const args = ["-y", "-i", "/a.mp4", "-filter_complex", graph, "-map", "[o]", "/o.mp4"];
          const r = graphFromFile(args, caps);
          // The command line no longer carries the graph...
          expect(r.args.join(" ").length).toBeLessThan(200);
          expect(r.args).not.toContain(graph);
          // ...it names the file that does, and nothing else changed around it.
          const at = r.args.indexOf("-/filter_complex");
          expect(at).toBe(3);
          const file = r.files.find((f) => f.name === r.args[at + 1]);
          expect(file?.content).toBe(graph);
          expect([...r.args.slice(0, at), ...r.args.slice(at + 2)]).toEqual([
            ...args.slice(0, 3),
            ...args.slice(5),
          ]);
          // Caption files survive, and the graph's name cannot be a caption band's.
          for (const c of caps) expect(r.files).toContainEqual(c);
          expect(caps.some((c) => c.name === file?.name)).toBe(false);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("a command with no filter graph is left alone however long it is", () => {
    const args = ["-y", "-metadata", `c=${"x".repeat(50_000)}`, "/o.mp4"];
    expect(graphFromFile(args, []).args).toEqual(args);
  });
});
