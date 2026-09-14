import { authHeaders, notifyAuthFailure } from "./auth";
import { apiBase } from "./config";
import { ArtDaddyError } from "../lib/errors";

export class ApiError extends ArtDaddyError {
  readonly code = "http";
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
  // The raw `message` is the server's detail (often technical); map the status to a
  // sentence a human can act on. `toUserMessage` reads this.
  get userMessage(): string {
    if (this.status === 401) return "Your session expired. Please sign in again.";
    if (this.status === 403) return "You don't have access to that.";
    if (this.status === 404) return "We couldn't find what you asked for.";
    if (this.status === 429) return "The service is busy. Please try again in a moment.";
    if (this.status >= 500) return "The service had a problem. Please try again in a moment.";
    return "Something went wrong with that request. Please try again.";
  }
}

/** Shape of GET /contract/tools (the live tool catalog). */
export interface ContractResponse {
  version?: string;
  count?: number;
  tools?: unknown[];
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(await authHeaders()),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    if (res.status === 401) notifyAuthFailure();
    let detail = res.statusText;
    try {
      const j = (await res.json()) as { detail?: string };
      detail = j?.detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  // A getter, not a snapshot: the server is user-configurable at runtime.
  get base() {
    return apiBase();
  },

  health: () => req<{ ok: boolean }>("/health"),

  // Tool catalog (contract), pulled at RUNTIME by the contract module — the
  // server's live tool registry is the source of truth (no build-time bundling).
  contract: () => req<ContractResponse>("/contract/tools"),

  // The composed system prompt, so the local MCP server hands an external agent the same
  // instructions the in-app agent runs under instead of a second, drifting summary.
  // `hostNotifies` false asks for the wording used where nothing wakes a finished turn.
  instructions: (hostNotifies = true) =>
    req<{ instructions?: string }>(
      `/contract/instructions${hostNotifies ? "" : "?host_notifies=false"}`,
    ),

  stop: () => req<{ ok: boolean }>("/stop", { method: "POST" }),

  // Client-owned agent loop (Cursor pattern): the server runs ONE stateless
  // model round; the client executes every tool locally.
  inferenceUrl: () => `${apiBase()}/inference`,

  // The same round, streamed. Additive: a server that predates it 404s and the
  // caller falls back to inferenceUrl(), so the app works against either.
  inferenceStreamUrl: () => `${apiBase()}/inference/stream`,
};
