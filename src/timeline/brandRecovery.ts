import manifest from "../../src-tauri/resources/brand/manifest.json";
import { authedFetch } from "../api/auth";
import { apiBase } from "../api/config";
import { settledWithin } from "../lib/settledWithin";
import { appCacheRoot } from "../tools/dataRoot";
import { joinPath } from "../tools/store";

type AssetName = keyof typeof manifest.assets;
const pending = new Map<string, Promise<string | null>>();

async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function download(name: AssetName, signal: AbortSignal): Promise<Uint8Array> {
  const expected = manifest.assets[name];
  const base = apiBase();
  const response = await authedFetch(`${base}/exports/branding/${manifest.version}/${name}`,
    { signal, redirect: "error", cache: "no-store" }, (url, init) => {
      if (apiBase() !== base) throw new Error("branding backend changed during authorization");
      return fetch(url, init);
    });
  if (!response.ok || signal.aborted) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("branding download unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("branding download has no body");
  const bytes = new Uint8Array(expected.bytes);
  let received = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (signal.aborted) throw new Error("branding download expired");
      if (chunk.done) break;
      if (received + chunk.value.length > bytes.length) throw new Error("branding download exceeded byte limit");
      bytes.set(chunk.value, received);
      received += chunk.value.length;
    }
  } finally { await reader.cancel().catch(() => undefined); }
  if (received !== expected.bytes || await digest(bytes) !== expected.sha256 || signal.aborted)
    throw new Error("branding download integrity differs");
  return bytes;
}

async function recover(name: AssetName): Promise<string | null> {
  try {
    const directory = joinPath(await appCacheRoot(), "branding", manifest.version);
    const { TauriFs } = await import("../tools/tauri");
    const fs = new TauriFs();
    const target = joinPath(directory, name);
    const expected = manifest.assets[name];
    const valid = async (file: string) => {
      try {
        if ((await fs.stat(file)).size !== expected.bytes) return false;
        const probe = await fs.probeMedia(file, 0);
        return probe.size === expected.bytes && probe.sha256 === expected.sha256;
      } catch { return false; }
    };
    if (await valid(target)) return target;
    for (let attempt = 0; attempt < 4; attempt++) {
      const controller = new AbortController();
      let bytes: Uint8Array | null;
      try { bytes = await settledWithin(download(name, controller.signal), 3000); }
      finally { controller.abort(); }
      if (!bytes) continue;
      const temporary = joinPath(directory, `.${name}.${crypto.randomUUID()}.partial`);
      try {
        await fs.mkdir(directory);
        await fs.writeBytes(temporary, bytes);
        if (!await valid(temporary)) throw new Error("staged branding asset differs");
        await fs.rename(temporary, target);
        if (await valid(target)) return target;
      } catch {
        continue;
      } finally { await fs.remove(temporary).catch(() => undefined); }
    }
  } catch {
    return null;
  }
  return null;
}

export function recoverBrandAsset(name: string): Promise<string | null> {
  if (!Object.hasOwn(manifest.assets, name)) return Promise.resolve(null);
  const existing = pending.get(name);
  if (existing) return existing;
  const task = recover(name as AssetName);
  pending.set(name, task);
  void task.finally(() => { if (pending.get(name) === task) pending.delete(name); });
  return task;
}