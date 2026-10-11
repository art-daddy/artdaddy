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

function waitFor<T>(
  read: () => T | Promise<T>,
  accept: (value: T) => boolean,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let reading = false;
    const finish = () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
    const inspect = async () => {
      if (reading) return;
      reading = true;
      try {
        const value = await read();
        if (accept(value)) {
          finish();
          resolve(value);
        }
      } catch (error) {
        finish();
        reject(error);
      } finally {
        reading = false;
      }
    };
    const interval = setInterval(() => void inspect(), 100);
    const timeout = setTimeout(() => {
      finish();
      reject(new Error(`${label} timed out`));
    }, 60_000);
    void inspect();
  });
}

interface HealthRecord {
  current: { context: { activity: string } };
  failures: unknown[];
}

async function exerciseMac(qa: {
  projectId: string;
  checking: () => void;
  signIn: () => Promise<void>;
  timeline: () => Promise<string>;
  openSource: (ref: string | null) => void;
  health: () => Promise<Record<string, unknown>>;
  prepareCrash: () => void;
}): Promise<void> {
  const proofPath = joinPath(root, "mac-ui-proof.json");
  qa.prepareCrash();
  if (await exists(proofPath)) return;
  const before = await qa.timeline();
  await writeTextFile(joinPath(root, "timeline-before.json"), before);
  qa.checking();
  const early = (await (await fetch(`${backend}/qa/rows`)).json()) as { reason?: string }[];
  check(
    !early.some((row) => row.reason === "phase6 early startup witness"),
    "Early event sent before sign-in",
  );
  await qa.signIn();
  const composer = await waitFor(
    () => document.querySelector<HTMLTextAreaElement>("textarea[placeholder]"),
    Boolean,
    "native composer",
  );
  check(composer, "No native composer");
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  check(setValue, "No textarea value setter");
  setValue.call(composer, "Phase six read the timeline then fail");
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  composer.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }),
  );
  await waitFor(
    async () =>
      (await (await fetch(`${backend}/qa/rows`)).json()) as {
        surface?: string;
        events?: { call_id?: string; ok?: boolean }[];
      }[],
    (rows) =>
      rows.some(
        (row) =>
          row.surface === "app" &&
          row.events?.some((event) => event.call_id === "phase6_app_read" && event.ok),
      ),
    "app trace storage",
  );
  const after = await qa.timeline();
  check(before === after, "A read changed the persisted timeline");
  await writeTextFile(joinPath(root, "timeline-after-read.json"), after);
  const audioPath = joinPath(root, "qa-mono.wav");
  const imported = await dispatch({
    id: 2,
    method: "tools/call",
    params: { name: "import_media", arguments: { source: { path: audioPath } } },
  });
  const content = imported.content as { text: string }[];
  const asset = JSON.parse(content[0].text) as { ok?: boolean; media_ref?: string };
  check(asset.ok && asset.media_ref, "Native source import failed");
  qa.openSource(asset.media_ref);
  const player = await waitFor(
    () => document.querySelector<HTMLAudioElement>("audio"),
    Boolean,
    "native audio source",
  );
  check(player, "No native audio player");
  player.muted = true;
  const play = await waitFor(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="play"]'),
    Boolean,
    "native play control",
  );
  check(play, "No native play control");
  const sourceStartTime = player.currentTime;
  play.click();
  const playedSeconds = await waitFor(
    () => player.currentTime,
    (time) => time > sourceStartTime + 0.1,
    "native audio advancement",
  );
  const playing = await waitFor(
    async () => (await qa.health()) as unknown as HealthRecord,
    (health) => health.current.context.activity === "source-playback",
    "playing health artifact",
  );
  const pause = document.querySelector<HTMLButtonElement>('button[aria-label="pause"]');
  check(pause, "No native pause control");
  pause.click();
  const paused = await waitFor(
    async () => (await qa.health()) as unknown as HealthRecord,
    (health) => health.current.context.activity !== "source-playback",
    "paused health artifact",
  );
  qa.openSource(null);
  qa.prepareCrash();
  await writeTextFile(
    proofPath,
    JSON.stringify({
      ok: true,
      projectId: qa.projectId,
      playing,
      paused,
      sourceStartTime,
      playedSeconds,
      recoveryUrl: location.href,
    }),
  );
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
  if (params.has("mac")) await exerciseMac(qa);
}

if (!params.has("warmup"))
  void setup().catch(async (error) => {
    console.error(error);
    await writeTextFile(
      joinPath(root, "failure.json"),
      JSON.stringify({ error: String(error) }),
    ).catch(() => undefined);
  });
