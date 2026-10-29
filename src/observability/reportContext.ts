// What a problem report says about the app it came from: build, machine class, model, credit state and the last few
// failures' codes and request ids. Facts only: no message, prompt, path or project content. Every source is read
// defensively, because a report is something the person chose to send and must never be lost to a failure to describe
// the app. The server normalises what it receives again (src/akaru/server/report_context.py).
import { getUsage } from "../api/usage";
import { platform } from "../platform";
import { hostInfo } from "../platform/host";
import { recentFailures } from "./recentFailures";

export interface ReportFailure {
  at: number;
  where: string;
  code: string;
  request_id?: string;
  status?: number;
}

export interface ReportContext {
  app_version: string;
  os: string;
  arch: string;
  shell: string;
  surface: string;
  model: string;
  credit?: {
    metered: boolean;
    used: number;
    limit: number;
    remaining: number;
    over: boolean;
    paused: boolean;
  };
  failures: ReportFailure[];
}

function guarded<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

export function buildReportContext(facts: { model: string; surface?: string }): ReportContext {
  const { os, arch } = guarded(() => hostInfo(), { os: "", arch: "" });
  const usage = guarded(() => getUsage(), null);
  return {
    app_version: __ARTDADDY_RELEASE__,
    os,
    arch,
    shell: guarded(() => platform.name, ""),
    surface: facts.surface ?? "app",
    model: facts.model,
    ...(usage
      ? {
          credit: {
            metered: usage.metered,
            used: usage.used,
            limit: usage.limit,
            remaining: usage.remaining,
            over: usage.over,
            paused: usage.globalPaused === true,
          },
        }
      : {}),
    failures: guarded(
      () =>
        recentFailures().map((failure) => ({
          at: failure.at,
          where: failure.where,
          code: failure.code,
          ...(failure.requestId ? { request_id: failure.requestId } : {}),
          ...(failure.status !== undefined ? { status: failure.status } : {}),
        })),
      [],
    ),
  };
}
