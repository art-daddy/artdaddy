// What the app registers once at start-up (estimateStart.ts): the project the person has open is what the estimate prices, the ONE provider answers the route side, and the PC check starts in the
// desktop app only. The module starts things by being imported, so each test imports everything afresh, under a platform it chooses.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emptyTimeline, type Clip, type Timeline } from "./model";
import { summarizeRenderWorkload } from "./renderPlan";

const clip = (id: string, from: number, to: number): Clip => ({
  id,
  kind: "video",
  media_ref: `${id}.mp4`,
  source_in: 0,
  source_out: to - from,
  timeline_in: from,
  timeline_out: to,
});
const talk: Timeline = (() => {
  const raw = emptyTimeline(1920, 1080, 30);
  raw.tracks = [{ id: "v1", kind: "video", z: 0, clips: [clip("a", 0, 3600)] }];
  return raw;
})();
const request = {
  workload: summarizeRenderWorkload(talk),
  settings: { resolution: "source" as const, quality: "medium" as const, fps: null },
  explicit: { size: false, fps: false },
  chipMaker: null,
};

const stoppers: Array<() => void> = [];

/** A fresh copy of every module the start-up touches, on the platform given: what the app has when it starts. `start()` is the app importing the start-up module. */
async function app(platform: "tauri" | "web", over: { failingCheck?: boolean } = {}) {
  vi.resetModules();
  vi.doMock("../platform", () => ({ platform: { name: platform } }));
  if (over.failingCheck)
    vi.doMock("./pcCheckStart", () => ({
      startPcCheck: () => {
        throw new Error("no app process");
      },
    }));
  const port = await import("./routeEstimatesPort");
  const handle = await import("./pcCheckHandle");
  const deps = await import("./estimateDeps");
  const { useEditor } = await import("../store/editor");
  let started: { stopEstimateStart(): void } | null = null;
  const start = async () => (started = await import("./estimateStart"));
  stoppers.push(() => started?.stopEstimateStart());
  return { port, handle, deps, editor: useEditor, start };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const stop of stoppers.splice(0)) stop();
  vi.doUnmock("../platform");
  vi.doUnmock("./pcCheckStart");
  vi.useRealTimers();
});

describe("what the app registers at start-up", () => {
  it("answers the route side with the honest estimate, priced on the project the person has open, and it is the one the Export dialog reads", async () => {
    const world = await app("web");
    await world.start();
    world.editor.setState({ projectId: "p", timeline: talk });
    const open = world.port.routeEstimatesNow(request);
    expect(open.standard).not.toBeNull();
    expect(open.standard!.basis).toBe("guess");
    // the project is read through the open editor: with none open its shape is unknown and the estimate says it could take much longer
    expect(open.standard!.muchLonger).toBe(false);
    world.editor.setState({ projectId: null, timeline: null });
    expect(world.port.routeEstimatesNow(request).standard!.muchLonger).toBe(true);
    world.editor.setState({ projectId: "p", timeline: talk });
    expect(world.port.routeEstimatesNow(request)).toEqual(world.deps.routeEstimatesHere(request));
  });

  it("is not in effect before the app starts it, and not after it is taken back", async () => {
    const world = await app("web");
    expect(world.port.routeEstimatesNow(request).standard).toBeNull();
    const module = await world.start();
    expect(world.port.routeEstimatesNow(request).standard).not.toBeNull();
    module.stopEstimateStart();
    expect(world.port.routeEstimatesNow(request).standard).toBeNull();
  });

  it("starts the PC check in the desktop app, and not on the web, where its probe cannot run", async () => {
    const web = await app("web");
    await web.start();
    expect(web.handle.pcCheckService()).toBeNull();
    const desktop = await app("tauri");
    const module = await desktop.start();
    expect(desktop.handle.pcCheckService()).not.toBeNull();
    expect(desktop.handle.pcCheckService()!.pcClass()).toBe("unknown");
    module.stopEstimateStart();
    expect(desktop.handle.pcCheckService()).toBeNull();
  });

  it("leaves the estimate registered, and the app starting, when the check cannot start", async () => {
    const world = await app("tauri", { failingCheck: true });
    await world.start();
    expect(world.port.routeEstimatesNow(request).standard).not.toBeNull();
    expect(world.handle.pcCheckService()).toBeNull();
  });
});
