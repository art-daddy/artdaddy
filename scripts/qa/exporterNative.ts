import { getIdentifier } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { mkdir, exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { appWorkRoot, dataRoot } from "../../src/tools/dataRoot";
import { EXPORT_PROTOCOL_VERSION, jobSupervisor, whenJobEnds } from "../../src/tools/jobSupervisor";
import { joinPath } from "../../src/tools/store";

const params = new URLSearchParams(location.search);
const root = params.get("root") ?? "";
const identifier = params.get("identifier") ?? "";
const reportPath = joinPath(root, "native-report.json");
const armedPath = joinPath(root, "native-armed.json");
const status = document.getElementById("status")!;

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function exercise(): Promise<void> {
  check(root.includes("artdaddy-export-native-"), "Not an isolated exporter directory");
  check(await getIdentifier() === identifier && identifier.startsWith("com.artdaddy.qa.exporter-"), "Wrong native app identity");
  check((await dataRoot()).replace(/\\/g, "/") === root.replace(/\\/g, "/"), "Native project root is not isolated");
  const supervisor = await jobSupervisor();
  check(supervisor?.delivery, "Missing required native delivery owner");
  check(await supervisor.delivery.protocol() === EXPORT_PROTOCOL_VERSION, "Native protocol mismatch");
  if (!(await exists(armedPath))) {
    const cwd = joinPath(await appWorkRoot(), "renderer", "native-recovery");
    await mkdir(cwd, { recursive: true });
    const id = "native_capture_recovery";
    const stage = joinPath(root, ".delivered.nut.partial");
    const destination = joinPath(root, "delivered.nut");
    const source = joinPath(root, "source.nut");
    await supervisor.delivery.prepare(id, joinPath(root, "project"), stage, destination, { kind: "render", paths: [source] });
    await supervisor.submit({ id, lane: "export", program: "ffmpeg", cwd,
      args: ["-y", "-nostdin", "-hide_banner", "-loglevel", "error", "-readrate", "0.1", "-i", source,
        "-map", "0:v:0", "-map", "0:a:0", "-c:v", "ffv1", "-pix_fmt", "yuv420p", "-c:a", "pcm_f64le",
        "-progress", "pipe:1", "-f", "nut", "captured.nut"],
      steps: [["-y", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", "captured.nut",
        "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-progress", "pipe:1", "-f", "nut", stage]],
      meta: { kind: "export", qa: "native_capture_recovery", projectDir: joinPath(root, "project"), stagePath: stage, destPath: destination },
    });
    const progress = await new Promise<string>((resolve, reject) => {
      let unsubscribe = () => {};
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error("No native render progress before crash")); }, 60_000);
      const accept = (text: string) => {
        if (/(?:^|\n)frame=\s*[1-9]\d*/.test(text)) { clearTimeout(timeout); unsubscribe(); resolve(text); }
      };
      unsubscribe = supervisor.subscribe(() => {}, (jobId, chunk) => { if (jobId === id) accept(chunk); });
      void supervisor.list().then((jobs) => accept(jobs.find((entry) => entry.id === id)?.stdout_tail ?? ""), reject);
    });
    const job = (await supervisor.list()).find((entry) => entry.id === id);
    check(job?.state === "running", `Crash target is not running: ${JSON.stringify(job)}`);
    await writeTextFile(armedPath, JSON.stringify({ id, cwd, source, stage, destination, identifier, progress, protocol: EXPORT_PROTOCOL_VERSION }));
    status.textContent = "Native job armed";
    return;
  }
  const armed = JSON.parse(await readTextFile(armedPath)) as { id: string; cwd: string; destination: string; source: string };
  const ended = await whenJobEnds(supervisor, armed.id);
  check(ended?.state === "exited" && ended.code === 0 && !ended.killed, `Recovered worker failed: ${JSON.stringify(ended)}`);
  const verified = await supervisor.delivery.verify(armed.id);
  const published = await supervisor.delivery.publish(armed.id);
  check(verified.identity?.sha256 === published.identity?.sha256 && published.state === "published", "Publication identity mismatch");
  const receipt = (await invoke<Array<{ id: string; producer_complete: boolean; recovery_attempts: number;
    worker_identity: { sha256: string; size: number }; command_sha256: string }>>("jobs_export_intents")).find((entry) => entry.id === armed.id);
  check(receipt?.producer_complete && receipt.recovery_attempts === 1, "Missing native recovery/producer receipt");
  await writeTextFile(reportPath, JSON.stringify({ ok: true, protocol: EXPORT_PROTOCOL_VERSION, launch: await supervisor.launchId(),
    delivered: armed.destination, captured: joinPath(armed.cwd, "captured.nut"), source: armed.source, identity: published.identity,
    producerComplete: receipt.producer_complete, recoveryAttempts: receipt.recovery_attempts,
    workerIdentity: receipt.worker_identity, commandSha256: receipt.command_sha256,
    progress: ended.stdout_tail, scope: "native-owner-capture-and-crash-recovery" }));
  status.textContent = "Native recovery delivered";
}

void exercise().catch(async (error) => {
  status.textContent = String(error);
  await writeTextFile(reportPath, JSON.stringify({ ok: false, error: String(error), scope: "native-owner-capture-and-crash-recovery" }));
});