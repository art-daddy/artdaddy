// What the app tells us about getting SIGNED IN, before it knows who the person is (T-20, D4).
//
// Until now the app reported nothing unless a session existed, so everything that goes wrong on the way to one
// was invisible: someone who installed, opened the app and never signed in, a sign-in that finished in the
// browser and never reached the app (18% of the finished ones in a month), a saved session the server refused.
// These are the steps of that path, each with the few reasons it can end for.
//
// They are ANONYMOUS ON PURPOSE. There is no account yet, so a step carries a random id for this install and a
// random id for this attempt, and nothing else about anyone: no account, no e-mail, no address, no file, no
// message text, and no part of anything the sign-in handles (the code, the state, the verifier, a token). Every
// value sent is a word from the closed table below, an id of exactly 12 characters, a bool, or a number. The
// server stores only what matches those shapes, so a mistake here cannot put a secret on disk; the tests walk
// every flow and look for the secrets in every body that leaves.
//
// Reporting is a hint, never a dependency: it is never awaited by the sign-in code, never throws, and a server
// that is down or an old one that does not know the event changes nothing about whether a person gets in.
import { platform } from "../platform";
import { hostInfo } from "../platform/host";
import { apiBase } from "./config";

/** Written down again on the server (analytics.py AUTH_APP_STEPS), and held equal by a test that reads this file.
 *  A step may only carry a reason from its own list. */
export const AUTH_APP_STEPS = {
  // The sign-in screen was shown: to someone who never signed in here, to someone who did, or offline.
  screen: ["new", "returning", "offline"],
  // The person pressed "Log in or sign up". ok=false: the browser could not be opened.
  start: ["open_failed"],
  // The browser handed a code back. ok=true: signed in. ok=false: why not.
  callback: [
    "no_attempt",
    "unrecognized",
    "missing_params",
    "state_mismatch",
    "exchange_network",
    "exchange_rejected",
    "exchange_server",
    "exchange_unreadable",
    "cancelled",
    "not_saved",
    "error",
  ],
  // A saved session could not be renewed. Reported when it fails, never when it works.
  refresh: ["rejected", "network", "timeout", "server_error", "keychain", "not_saved", "error"],
} as const;

export type AuthStep = keyof typeof AUTH_APP_STEPS;
export type AuthReason<S extends AuthStep> = (typeof AUTH_APP_STEPS)[S][number];

/** An id is exactly this many characters: 72 random bits, and shorter than every secret the sign-in handles (a
 *  code is at least 20), so a secret put in an id by a bug cannot pass the server's check. */
export const AUTH_ID_LENGTH = 12;
export const MAX_AUTH_MS = 3_600_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{12}$/;

const INSTALL_KEY = "artdaddy.install_id";
const SIGNED_IN_BEFORE_KEY = "artdaddy.signed_in_before";
/** The same step and reason is reported at most once in this long: a sign-in screen that remounts, or a renewal
 *  that fails on every request while the server is down, is one fact and not a hundred. */
const QUIET_MS: Partial<Record<AuthStep, number>> = { screen: 30 * 60_000, refresh: 10 * 60_000 };
/** A bug that reported in a loop must cost the public route nothing: never more than this many in a minute. */
const MAX_PER_MINUTE = 20;
const SEND_TIMEOUT_MS = 8_000;

/** 9 random bytes, which is exactly 12 base64url characters and needs no padding. */
export function newAuthId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
}

export function isAuthId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

let memoryInstallId = "";

/** This install's random id. It is not the account and is never joined to it; it is only what lets several steps
 *  by the same install be counted as one install. Kept on this machine, and thrown away on sign-out. */
export function getInstallId(): string {
  try {
    const stored = localStorage.getItem(INSTALL_KEY);
    if (isAuthId(stored)) return stored;
    const fresh = newAuthId();
    localStorage.setItem(INSTALL_KEY, fresh);
    return fresh;
  } catch {
    // Storage is off: the id then lasts as long as the process, which still groups one run's steps.
    memoryInstallId ||= newAuthId();
    return memoryInstallId;
  }
}

export function resetInstallId(): void {
  memoryInstallId = "";
  try {
    localStorage.removeItem(INSTALL_KEY);
  } catch {
    /* nothing stored, nothing to forget */
  }
}

/** Whether a sign-in has ever succeeded on this machine, so "never signed in" and "had a session and lost it" are
 *  told apart on the sign-in screen. A local flag that is never sent on its own, and that sign-out leaves alone. */
export function hasSignedInBefore(): boolean {
  try {
    return localStorage.getItem(SIGNED_IN_BEFORE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markSignedInBefore(): void {
  try {
    localStorage.setItem(SIGNED_IN_BEFORE_KEY, "1");
  } catch {
    /* a flag that cannot be kept only costs the new/returning split */
  }
}

export interface AuthStepDetail<S extends AuthStep> {
  ok?: boolean;
  reason?: AuthReason<S>;
  /** The attempt this step belongs to (from the pending sign-in). Dropped unless it has the id shape. */
  attempt?: string;
  /** How long the attempt had been going, in milliseconds. */
  ms?: number;
}

const lastReported = new Map<string, number>();
let recent: number[] = [];

/** Tests only. */
export function __resetAuthEvents(): void {
  lastReported.clear();
  recent = [];
  memoryInstallId = "";
}

/** Report one step. Returns at once, never throws, and is safe to call from anywhere in the sign-in path. */
export function reportAuthStep<S extends AuthStep>(step: S, detail: AuthStepDetail<S> = {}): void {
  try {
    if (platform.name !== "tauri") return;
    // The types already say a step can only carry its own reasons; this is the same rule at run time, because
    // this is the last place before the network. A step or a reason that is not in the table is not sent.
    // (An own-property check: on a plain object `constructor` and `__proto__` are not missing.)
    if (!Object.prototype.hasOwnProperty.call(AUTH_APP_STEPS, step)) return;
    const words: readonly string[] = AUTH_APP_STEPS[step];
    const reason =
      typeof detail.reason === "string" && words.includes(detail.reason)
        ? detail.reason
        : undefined;
    const now = Date.now();
    const quiet = QUIET_MS[step];
    const key = `${step}:${reason ?? ""}:${typeof detail.ok === "boolean" ? detail.ok : ""}`;
    if (quiet !== undefined) {
      const before = lastReported.get(key);
      if (before !== undefined && now - before < quiet) return;
    }
    recent = recent.filter((at) => now - at < 60_000);
    if (recent.length >= MAX_PER_MINUTE) return;
    recent.push(now);
    if (quiet !== undefined) lastReported.set(key, now);

    const { os, arch } = hostInfo();
    const body: Record<string, unknown> = {
      event: "auth",
      source: "app",
      step,
      install: getInstallId(),
      app_version: __ARTDADDY_RELEASE__,
      os,
      arch,
    };
    if (isAuthId(detail.attempt)) body.attempt = detail.attempt;
    if (typeof detail.ok === "boolean") body.ok = detail.ok;
    if (reason) body.reason = reason;
    if (typeof detail.ms === "number" && Number.isFinite(detail.ms)) {
      body.ms = Math.min(MAX_AUTH_MS, Math.max(0, Math.round(detail.ms)));
    }
    void send(body);
  } catch {
    /* a report that cannot be made is not worth a failed sign-in */
  }
}

async function send(body: Record<string, unknown>): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    // A plain-text body and no custom header make this a "simple" request: no preflight, and the route that
    // takes it answers 204 to everything, so there is nothing to read back.
    await fetch(`${apiBase()}/e`, {
      method: "POST",
      body: JSON.stringify(body),
      mode: "no-cors",
      keepalive: true,
      signal: controller.signal,
    });
  } catch {
    /* offline, or the server is down: the step is simply not recorded */
  } finally {
    clearTimeout(timer);
  }
}
