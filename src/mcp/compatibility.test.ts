import { beforeEach, expect, it, vi } from "vitest";
import { useCompatibility } from "../update/compatibility";
import { useAuth } from "../store/auth";
import { dispatch } from "./bridge";

vi.mock("../platform", () => ({ platform: { name: "tauri" } }));
const projects = vi.hoisted(() => ({ getState: vi.fn(), create: vi.fn() }));
const host = vi.hoisted(() => ({ ready: Promise.resolve(), run: vi.fn(), open: vi.fn() }));
vi.mock("../store/projects", () => ({ useProjects: { getState: () => projects.getState() } }));
vi.mock("../tools/host", () => ({ openToolHost: () => { host.open(); return host; } }));

beforeEach(() => {
  useCompatibility.setState({ status: "required" });
  useAuth.setState({ status: "unlocked", hasStoredSession: true });
  projects.getState.mockReset().mockReturnValue({ activeId: "p1", create: projects.create });
  projects.create.mockReset();
  host.open.mockReset();
  host.run.mockReset();
  host.ready = Promise.resolve();
});

it.each(["tools/list", "tools/call"])("a mandatory update refuses MCP %s before opening a project", async (method) => {
  const response = await dispatch({ id: 1, method, params: { name: "manage_project", arguments: { action: "create" } } } as never);
  expect(response.isError).toBe(true);
  const content = response.content as Array<{ type: string; text: string }>;
  const outcome = JSON.parse(content[0].text) as { ran: boolean; reason: string };
  expect(outcome.ran).toBe(false);
  expect(outcome.reason).toContain("required update");
  expect(projects.getState).not.toHaveBeenCalled();
  expect(projects.create).not.toHaveBeenCalled();
  expect(host.run).not.toHaveBeenCalled();
});

it("a lock while the host is loading refuses before project activation or handler execution", async () => {
  useCompatibility.setState({ status: "allowed" });
  let ready!: () => void;
  host.ready = new Promise<void>((resolve) => { ready = resolve; });
  const navigation = vi.spyOn(window.history, "pushState");
  const pending = dispatch({ id: 2, method: "tools/call", params: { name: "undo", arguments: {} } } as never);
  await vi.waitFor(() => expect(host.open).toHaveBeenCalled());
  useCompatibility.setState({ status: "required" });
  ready();
  const response = await pending;
  const content = response.content as Array<{ text: string }>;
  expect(JSON.parse(content[0].text).ran).toBe(false);
  expect(navigation).not.toHaveBeenCalled();
  expect(host.run).not.toHaveBeenCalled();
});