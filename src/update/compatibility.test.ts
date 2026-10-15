import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import { catalogIdentity } from "../contract";
import { apiBase, setApiBase } from "../api/config";
import { useCompatibility, markUpdateRequired } from "./compatibility";
import { inferRound, inferRoundStreaming } from "../agent/api";
import { callAiProxy } from "../api/ai";

vi.mock("../platform", () => ({ platform: { name: "tauri" } }));
const authentication = vi.hoisted(() => ({ pause: null as Promise<void> | null }));
vi.mock("../api/auth", () => ({
  authedFetch: (url: string, init: RequestInit, requester: typeof fetch = fetch) =>
    authentication.pause ? authentication.pause.then(() => requester(url, init)) : requester(url, init),
}));

let serviceNumber = 0;
beforeEach(() => {
  localStorage.clear();
  setApiBase(`https://compatibility-${++serviceNumber}.example`);
  authentication.pause = null;
  useCompatibility.setState({ status: "checking", error: null });
});
afterEach(() => {
  setApiBase(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const result = (supported: boolean): Response => new Response(JSON.stringify({
  catalog_id: catalogIdentity(), supported, required_update: !supported,
}));

it("only a verified supported build stays usable when the service later becomes unreachable", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  await useCompatibility.getState().check();
  expect(useCompatibility.getState().status).toBe("unverified");
  vi.stubGlobal("fetch", vi.fn(async () => result(true)));
  await useCompatibility.getState().check();
  expect(useCompatibility.getState().status).toBe("allowed");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  await useCompatibility.getState().check();
  expect(useCompatibility.getState().status).toBe("allowed");
});

it("a required update persists and cannot become offline permission", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => result(true)));
  await useCompatibility.getState().check();
  markUpdateRequired();
  useCompatibility.setState({ status: "checking" });
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  await useCompatibility.getState().check();
  expect(useCompatibility.getState().status).toBe("required");
});

it("a late supported response cannot undo a newer required-update decision", async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  const pending = useCompatibility.getState().check();
  markUpdateRequired();
  finish(result(true));
  await pending;
  expect(useCompatibility.getState().status).toBe("required");
});

it("failure to persist a required update never revives an earlier supported receipt", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => result(true)));
  await useCompatibility.getState().check();
  const disk = localStorage;
  const write = vi.fn(() => { throw new Error("storage refused"); });
  vi.stubGlobal("localStorage", { getItem: (cacheKey: string) => disk.getItem(cacheKey), setItem: write, removeItem: (cacheKey: string) => disk.removeItem(cacheKey) });
  markUpdateRequired();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  await useCompatibility.getState().check();
  expect(useCompatibility.getState().status).toBe("required");
  expect(write).toHaveBeenCalled();
});

it("a stalled check releases a verified build to offline work and ignores the late result", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => result(true)));
  await useCompatibility.getState().check();
  vi.useFakeTimers();
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  const pending = useCompatibility.getState().check();
  await vi.advanceTimersByTimeAsync(15_000);
  await pending;
  expect(useCompatibility.getState().status).toBe("allowed");
  finish(result(false));
  await Promise.resolve();
  expect(useCompatibility.getState().status).toBe("allowed");
  vi.useRealTimers();
});

it("no receipt for another catalog unlocks an unverified build", async () => {
  await fc.assert(fc.asyncProperty(fc.string().filter((identity) => identity !== catalogIdentity()), async (identity) => {
    localStorage.clear();
    setApiBase(`https://foreign-catalog-${++serviceNumber}.example`);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ catalog_id: identity, supported: true, required_update: false }))));
    await useCompatibility.getState().check();
    expect(useCompatibility.getState().status).not.toBe("allowed");
  }), { numRuns: 30 });
});

it("switching service removes permission and discards the former service's delayed result", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => result(true)));
  await useCompatibility.getState().check();
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  const pending = useCompatibility.getState().check();
  setApiBase("https://different-service.example");
  expect(useCompatibility.getState().status).toBe("unverified");
  finish(result(true));
  await pending;
  expect(useCompatibility.getState().status).toBe("unverified");
  expect(localStorage.getItem(`artdaddy.compatibility:${apiBase()}:${catalogIdentity()}:${__ARTDADDY_RELEASE__}`)).toBeNull();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  await useCompatibility.getState().check();
  expect(useCompatibility.getState().status).toBe("unverified");
});

it.each(["checking", "unverified", "required"] as const)("the %s lock refuses every paid sender before transport", async (status) => {
  useCompatibility.setState({ status });
  const transport = vi.fn();
  vi.stubGlobal("fetch", transport);
  await expect(inferRound({ round_input: { user_text: "hi" } })).rejects.toThrow();
  await expect(inferRoundStreaming({ round_input: { user_text: "hi" } }, () => undefined)).rejects.toThrow();
  await expect(callAiProxy("generate_image", { args: {} })).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});

it.each(["plain", "stream", "proxy"])("the %s sender rechecks a lock after pending authentication completes", async (sender) => {
  vi.stubGlobal("fetch", vi.fn(async () => result(true)));
  await useCompatibility.getState().check();
  let authorize!: () => void;
  authentication.pause = new Promise<void>((resolve) => { authorize = resolve; });
  const transport = vi.fn();
  vi.stubGlobal("fetch", transport);
  const body = { round_input: { user_text: "hi" } };
  const pending = sender === "plain" ? inferRound(body) :
    sender === "stream" ? inferRoundStreaming(body, () => undefined) : callAiProxy("generate_music", { args: {} });
  markUpdateRequired();
  authorize();
  await expect(pending).rejects.toThrow(/requires an update/);
  expect(transport).not.toHaveBeenCalled();
});

it("one successful request cannot repersist offline permission while a sibling can still refuse the build", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => result(true)));
  await useCompatibility.getState().check();
  const replies: Array<(response: Response) => void> = [];
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { replies.push(resolve); })));
  const first = inferRound({ round_input: { user_text: "hi" } });
  const second = callAiProxy("generate_image", { args: {} });
  expect(replies).toHaveLength(2);
  const cacheKey = `artdaddy.compatibility:${apiBase()}:${catalogIdentity()}:${__ARTDADDY_RELEASE__}`;
  replies[0](new Response(JSON.stringify({ kind: "text", final_text: "done" })));
  await first;
  expect(localStorage.getItem(cacheKey)).toBeNull();
  replies[1](new Response("update required", { status: 426 }));
  await expect(second).rejects.toThrow(/requires an update/);
  expect(useCompatibility.getState().status).toBe("required");
  expect(JSON.parse(localStorage.getItem(cacheKey)!).supported).toBe(false);
});

it("a service switch preserves a successful already-admitted result without unlocking the new service", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => result(true)));
  await useCompatibility.getState().check();
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  const pending = callAiProxy("generate_image", { args: {} });
  setApiBase("https://new-service.example");
  const output = { result: { ok: true }, media: [{ b64: "Y29tcGxldGU=", ext: "png", kind: "image" }] };
  finish(new Response(JSON.stringify(output)));
  await expect(pending).resolves.toEqual(output);
  expect(useCompatibility.getState().status).toBe("unverified");
  expect(localStorage.getItem(`artdaddy.compatibility:${apiBase()}:${catalogIdentity()}:${__ARTDADDY_RELEASE__}`)).toBeNull();
});

it("unreadable storage cannot hide an old positive receipt before a potentially revoking request", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => result(true)));
  await useCompatibility.getState().check();
  const disk = localStorage;
  const cacheKey = `artdaddy.compatibility:${apiBase()}:${catalogIdentity()}:${__ARTDADDY_RELEASE__}`;
  expect(JSON.parse(disk.getItem(cacheKey)!).supported).toBe(true);
  vi.stubGlobal("localStorage", {
    getItem: () => { throw new Error("read refused"); },
    setItem: () => { throw new Error("write refused"); },
    removeItem: () => { throw new Error("delete refused"); },
  });
  const transport = vi.fn();
  vi.stubGlobal("fetch", transport);
  await expect(callAiProxy("generate_video", { args: {} })).rejects.toThrow(/read offline permission safely/);
  expect(transport).not.toHaveBeenCalled();
  expect(useCompatibility.getState().status).toBe("unverified");
});

it("a refusal with all storage writes failing leaves no old permission to revive after restart", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => result(true)));
  await useCompatibility.getState().check();
  const disk = localStorage;
  const write = vi.fn(() => { throw new Error("write refused"); });
  const remove = vi.fn(() => { throw new Error("delete refused"); });
  vi.stubGlobal("fetch", vi.fn(async () => {
    vi.stubGlobal("localStorage", { getItem: (cacheKey: string) => disk.getItem(cacheKey), setItem: write, removeItem: remove });
    return new Response("update required", { status: 426 });
  }));
  try {
    await expect(callAiProxy("generate_image", { args: {} })).rejects.toThrow(/requires an update/);
    expect(localStorage.getItem(`artdaddy.compatibility:${apiBase()}:${catalogIdentity()}:${__ARTDADDY_RELEASE__}`)).toBeNull();
    expect(write).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
  vi.resetModules();
  const restarted = await import("./compatibility");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  await restarted.useCompatibility.getState().check();
  expect(restarted.useCompatibility.getState().status).not.toBe("allowed");
});