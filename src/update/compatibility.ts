import { create } from "zustand";
import { authedFetch } from "../api/auth";
import { apiBase, onApiBaseChange } from "../api/config";
import { catalogIdentity } from "../contract";
import { ArtDaddyError } from "../lib/errors";
import { platform } from "../platform";

type CompatibilityStatus = "checking" | "allowed" | "required" | "unverified";
type SavedCompatibility = { id: string; build: string; supported: boolean };
interface CompatibilityState {
  status: CompatibilityStatus;
  error: string | null;
  check: () => Promise<void>;
}

let epoch = 0;
const requiredBuilds = new Set<string>();
const supportedBuilds = new Set<string>();
const pendingChecks = new Map<string, number>();
const key = (): string =>
  `artdaddy.compatibility:${apiBase()}:${catalogIdentity()}:${__ARTDADDY_RELEASE__}`;
function saved(cacheKey: string): SavedCompatibility | null {
  try {
    const value = JSON.parse(localStorage.getItem(cacheKey) ?? "null") as SavedCompatibility | null;
    return value?.id === catalogIdentity() &&
      value.build === __ARTDADDY_RELEASE__ &&
      typeof value.supported === "boolean"
      ? value
      : null;
  } catch {
    throw new CompatibilityStorageError(
      "Couldn't read offline permission safely. Restore app storage access and retry.",
    );
  }
}

function persist(cacheKey: string, supported: boolean): void {
  try {
    localStorage.setItem(
      cacheKey,
      JSON.stringify({ id: catalogIdentity(), build: __ARTDADDY_RELEASE__, supported }),
    );
  } catch {
    if (!supported) {
      try {
        localStorage.removeItem(cacheKey);
      } catch {}
    }
  }
}

class CompatibilityStorageError extends Error {}

function beginCheck(cacheKey: string, alreadyAllowed: boolean): void {
  const previous = saved(cacheKey);
  if (previous?.supported) {
    try {
      localStorage.removeItem(cacheKey);
      if (localStorage.getItem(cacheKey) !== null)
        throw new Error("the old receipt was not cleared");
    } catch {
      throw new CompatibilityStorageError(
        "Couldn't clear offline permission safely. Restore app storage access and retry.",
      );
    }
    supportedBuilds.add(cacheKey);
  } else if (previous?.supported === false) {
    requiredBuilds.add(cacheKey);
    supportedBuilds.delete(cacheKey);
  }
  if (alreadyAllowed && !requiredBuilds.has(cacheKey)) supportedBuilds.add(cacheKey);
  pendingChecks.set(cacheKey, (pendingChecks.get(cacheKey) ?? 0) + 1);
}

function remember(cacheKey: string, supported: boolean): void {
  if (supported) {
    requiredBuilds.delete(cacheKey);
    supportedBuilds.add(cacheKey);
    if (!pendingChecks.has(cacheKey)) persist(cacheKey, true);
  } else {
    requiredBuilds.add(cacheKey);
    supportedBuilds.delete(cacheKey);
    persist(cacheKey, false);
  }
}

function finishCheck(cacheKey: string): void {
  const remaining = (pendingChecks.get(cacheKey) ?? 1) - 1;
  if (remaining > 0) pendingChecks.set(cacheKey, remaining);
  else {
    pendingChecks.delete(cacheKey);
    if (requiredBuilds.has(cacheKey)) persist(cacheKey, false);
    else if (supportedBuilds.has(cacheKey)) persist(cacheKey, true);
  }
}

export const useCompatibility = create<CompatibilityState>((set) => ({
  status: "checking",
  error: null,
  check: async () => {
    const token = ++epoch;
    const service = apiBase();
    const cacheKey = key();
    const alreadyAllowed = useCompatibility.getState().status === "allowed";
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let started = false;
    set({ status: "checking", error: null });
    try {
      beginCheck(cacheKey, alreadyAllowed);
      started = true;
      const request = async (): Promise<{
        catalog_id?: unknown;
        supported?: unknown;
        required_update?: unknown;
      }> => {
        const response = await authedFetch(`${service}/client/compatibility`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ catalog_id: catalogIdentity() }),
        });
        if (!response.ok)
          throw new Error("Couldn't verify this build. Check your connection and retry.");
        return response.json();
      };
      const result = await Promise.race([
        request(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(
              new Error("The compatibility check timed out. Check your connection and retry."),
            );
          }, 15_000);
        }),
      ]);
      if (
        result.catalog_id !== catalogIdentity() ||
        typeof result.supported !== "boolean" ||
        result.required_update !== !result.supported
      ) {
        throw new Error("The service returned an invalid compatibility result.");
      }
      if (token !== epoch || service !== apiBase()) return;
      remember(cacheKey, result.supported);
      set({ status: result.supported ? "allowed" : "required", error: null });
    } catch (error) {
      if (token !== epoch || service !== apiBase()) return;
      set({
        status: requiredBuilds.has(cacheKey)
          ? "required"
          : error instanceof CompatibilityStorageError
            ? "unverified"
            : supportedBuilds.has(cacheKey)
              ? "allowed"
              : "unverified",
        error: error instanceof Error ? error.message : "Couldn't verify this build.",
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (started) finishCheck(cacheKey);
    }
  },
}));

onApiBaseChange(() => {
  epoch += 1;
  useCompatibility.setState({
    status: "unverified",
    error: "Verify this build with the selected service before continuing.",
  });
});

export function markUpdateRequired(): void {
  epoch += 1;
  remember(key(), false);
  useCompatibility.setState({ status: "required", error: null });
}

export function compatibilityAllowsWork(): boolean {
  return platform.name !== "tauri" || useCompatibility.getState().status === "allowed";
}

export class ClientUpdateRequiredError extends ArtDaddyError {
  readonly code = "client_update_required";
  readonly expected = true;
  constructor() {
    super(
      "This build requires an update. The request was not submitted; do not retry AI tools on this build.",
    );
    markUpdateRequired();
  }
  get userMessage(): string {
    return "Update ArtDaddy before continuing. This request was not submitted.";
  }
}

export function assertCompatibleClient(): void {
  if (compatibilityAllowsWork()) return;
  if (useCompatibility.getState().status === "required") throw new ClientUpdateRequiredError();
  throw new Error(
    "ArtDaddy is checking build compatibility. No tool was run; retry after the check completes.",
  );
}

export async function fetchCompatibleClient(url: string, init: RequestInit): Promise<Response> {
  assertCompatibleClient();
  if (platform.name !== "tauri") return fetch(url, init);
  const service = apiBase();
  const cacheKey = key();
  try {
    beginCheck(cacheKey, true);
  } catch (error) {
    useCompatibility.setState({ status: "unverified", error: String(error) });
    throw error;
  }
  try {
    const response = await fetch(url, init);
    if (response.status === 426) {
      remember(cacheKey, false);
      if (service === apiBase()) markUpdateRequired();
    }
    if (!response.ok && service !== apiBase())
      throw new Error(
        "The previous service refused this request after the selected service changed.",
      );
    return response;
  } finally {
    finishCheck(cacheKey);
  }
}
