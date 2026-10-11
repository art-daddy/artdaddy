import { getIdentifier } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { appLocalDataDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "../../src/App";
import { setClerkTokenProvider } from "../../src/api/auth";
import { reportAppEvent } from "../../src/api/appEvents";
import { setApiBase } from "../../src/api/config";
import { dispatch, startMcpBridge } from "../../src/mcp/bridge";
import { setMcpEnabledPreference } from "../../src/mcp/service";
import { installCrashWatch } from "../../src/observability/crashWatch";
import { useAuth } from "../../src/store/auth";
import { useChat } from "../../src/store/chat";
import { useEditor } from "../../src/store/editor";
import { useProjects } from "../../src/store/projects";
import { dataRoot, projectsRoot } from "../../src/tools/dataRoot";
import { joinPath } from "../../src/tools/store";
import "../../src/index.css";

const originalUrl = location.href;
const params = new URLSearchParams(location.search);
const root = params.get("root") ?? "";
const identifier = params.get("identifier") ?? "";
const backend = params.get("backend") ?? "";
const mcpPort = Number(params.get("mcp"));
const checkpoint = (stage: string) => {
  (globalThis as unknown as { phase6BootCheckpoint: string }).phase6BootCheckpoint = stage;
};
checkpoint("module-loaded");

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function setup(): Promise<void> {
  checkpoint("native-identifier");
  check(identifier.startsWith("com.artdaddy.qa.phase6"), "Refusing a non-QA identifier");
  check((await getIdentifier()) === identifier, "Refusing the user's app instance");
  check(root.includes("artdaddy-phase6-"), "Refusing a non-QA project folder");
  check(backend.startsWith("http://127.0.0.1:"), "Refusing a non-local server");
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (
      (target.protocol === "http:" || target.protocol === "https:") &&
      target.origin !== backend &&
      target.origin !== location.origin &&
      target.origin !== "http://ipc.localhost" &&
      target.hostname !== "asset.localhost"
    ) {
      throw new Error("External network is disabled in telemetry QA");
    }
    return nativeFetch(input, init);
  };
  checkpoint("native-filesystem");
  await mkdir(root, { recursive: true });
  check((await dataRoot()) === root, "Refusing QA outside its temporary data root");
  check(
    (await projectsRoot()) === joinPath(root, "projects"),
    "Refusing QA outside its temporary projects root",
  );
  checkpoint("mount-app");
  setApiBase(backend);
  setMcpEnabledPreference(false);
  localStorage.setItem("artdaddy.session", JSON.stringify({ startedAt: 1, aliveAt: 50_000 }));
  installCrashWatch({ release: __ARTDADDY_RELEASE__ });
  history.replaceState({}, "", "/");
  createRoot(document.getElementById("root")!).render(
    createElement(BrowserRouter, null, createElement(App)),
  );
  checkpoint("restore-auth");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      off();
      reject(new Error("QA auth did not resolve"));
    }, 15_000);
    const ready = () => {
      if (useAuth.getState().profile?.user_id === "phase6_qa") {
        off();
        clearTimeout(timeout);
        resolve();
      }
    };
    const off = useAuth.subscribe(ready);
    ready();
  });
  checkpoint("create-project");
  const projectFile = joinPath(root, "qa-project.json");
  const projectId = (await exists(projectFile))
    ? (JSON.parse(await readTextFile(projectFile)).projectId as string)
    : (await useProjects.getState().create("Phase Six Telemetry QA")).id;
  await writeTextFile(projectFile, JSON.stringify({ projectId }));
  checkpoint("open-project");
  const opened = await dispatch({
    id: 1,
    method: "tools/call",
    params: { name: "manage_project", arguments: { action: "open", id: projectId } },
  });
  check(!opened.isError, JSON.stringify(opened));
  checkpoint("start-mcp");
  await startMcpBridge();
  await invoke("mcp_start", { port: mcpPort });
  const healthPath = joinPath(await appLocalDataDir(), "observability", "health.json");
  const timelinePath = joinPath(root, "projects", projectId, "internals", "timeline.json");
  const realNow = Date.now;
  let early: Promise<unknown> | undefined;
  const qa = {
    ready: true,
    projectId,
    healthPath,
    timelinePath,
    checking: () => {
      setClerkTokenProvider(null);
      useAuth.setState({ status: "checking", profile: null, hasStoredSession: true });
      early = reportAppEvent("app_error", { reason: "phase6 early startup witness", projectId });
    },
    signIn: async () => {
      setClerkTokenProvider(async () => "phase6-local-session");
      useAuth.setState({
        status: "unlocked",
        hasStoredSession: true,
        profile: {
          user_id: "phase6_qa",
          email: "qa@example.invalid",
          display_name: "Local QA",
          image_url: "",
          metered: false,
        },
      });
      await early;
    },
    clock: (seconds: number) => {
      Date.now = () => realNow() + seconds * 1000;
    },
    prepareCrash: () => history.replaceState({}, "", originalUrl),
    health: async () => JSON.parse(await readTextFile(healthPath)) as Record<string, unknown>,
    timeline: () => readTextFile(timelinePath),
    chat: () => useChat.getState().turns,
    close: () => getCurrentWindow().close(),
    editor: () => ({
      projectId: useEditor.getState().projectId,
      dirty: useEditor.getState().dirty,
    }),
    openSource: (ref: string | null) =>
      ref
        ? useEditor.getState().openMediaTab(ref, { pin: true })
        : useEditor.getState().setActiveMediaTab(null),
  };
  (window as unknown as { phase6: typeof qa }).phase6 = qa;
  checkpoint("ready");
  await writeTextFile(
    joinPath(root, "ready.json"),
    JSON.stringify({ projectId, healthPath, timelinePath, at: realNow() }),
  );
}

if (!params.has("warmup"))
  void setup().catch(async (error) => {
    console.error(error);
    await writeTextFile(
      joinPath(root, "failure.json"),
      JSON.stringify({ error: String(error) }),
    ).catch(() => undefined);
  });
