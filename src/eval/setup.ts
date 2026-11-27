// What a campaign runs against, read once before its first model round: the client's commit,
// the server's version and build, and a fingerprint of the base prompt the server reports. None
// of these reads calls a model: git is local, and /health and /contract/instructions are plain
// GETs. A value that cannot be read is null, never guessed.
//
// The server does not report the prompt a round actually ran under. /contract/instructions
// returns the base prompt without the provider's strict-null line and without a project's style
// or workflow layer, so its hash moves whenever the base text moves, which is what a before/after
// comparison needs, but it is not the per-round text. For that the /inference reply would have to
// carry, beside `usage`: `prompt_sha256` (sha256 of the exact instructions string sent to the
// provider for that round), `served_model` (the model that ran after the server's alias table) and
// `served_effort` (the effort it ran at). It carries none of them today.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import type { RunSetup } from "./types";

/** The parts of a run's setup that are the same for every run of a campaign. */
export type CampaignSetup = Pick<
  RunSetup,
  "appGitSha" | "appGitDirty" | "server" | "serverVersion" | "serverBuild" | "promptSha256"
>;

type Git = (args: string[]) => string;
type Get = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

const defaultGit: Git = (args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** The commit the client code runs from, and whether the working tree differs from it. */
export function gitState(git: Git = defaultGit): Pick<CampaignSetup, "appGitSha" | "appGitDirty"> {
  let appGitSha: string | null = null;
  let appGitDirty: boolean | null = null;
  try {
    const sha = git(["rev-parse", "HEAD"]).trim();
    appGitSha = /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    appGitSha = null;
  }
  try {
    appGitDirty = git(["status", "--porcelain", "--untracked-files=no"]).trim().length > 0;
  } catch {
    appGitDirty = null;
  }
  return { appGitSha, appGitDirty };
}

const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

async function readJson(get: Get, url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await get(url);
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** What the server says about itself: /health's version and build, and the sha256 of the base
 *  prompt it serves to the app (`host_notifies=true`, the in-app wording). */
export async function serverState(
  server: string,
  get: Get,
): Promise<Pick<CampaignSetup, "server" | "serverVersion" | "serverBuild" | "promptSha256">> {
  const base = server.replace(/\/+$/, "");
  const health = await readJson(get, `${base}/health`);
  const prompt = await readJson(get, `${base}/contract/instructions?host_notifies=true`);
  const instructions = text(prompt?.instructions);
  return {
    server: base,
    serverVersion: text(health?.version),
    serverBuild: text(health?.build),
    promptSha256: instructions ? createHash("sha256").update(instructions).digest("hex") : null,
  };
}

/** Everything a campaign records once, before its first model round. */
export async function campaignSetup(
  server: string,
  get: Get,
  git: Git = defaultGit,
): Promise<CampaignSetup> {
  return { ...gitState(git), ...(await serverState(server, get)) };
}
