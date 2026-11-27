// A project folder held in memory the way the desktop app reads and writes it, for tests that judge
// what ends up on disk. Files are BYTES, and text goes through the same coding as the app's own
// filesystem: TextEncoder on write, and on read the default TextDecoder, which drops a leading
// byte-order mark and turns broken UTF-8 into U+FFFD (what @tauri-apps/plugin-fs readTextFile does).
// A fake that kept JS strings would answer a different question about a file someone else wrote.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";

import { joinPath, type DirEntry, type FsLike } from "../tools/store";

/** Opening a project starts the media indexing, which prints a line for each file it looks at and,
 *  with no ffmpeg in the unit lane, one more for each poster it could not make. Call in beforeEach to
 *  keep those lines out of the run's log; anything else still prints. */
export function quietMediaLogs(): void {
  const noisy = /^\[(mediaProxy|transcode)\]/;
  for (const level of ["debug", "log", "info", "warn", "error"] as const) {
    const print = console[level].bind(console);
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === "string" && noisy.test(args[0])) return;
      print(...args);
    });
  }
}

export class ProjectDisk implements FsLike {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();

  static key(path: string): string {
    return joinPath(path);
  }

  private addParents(key: string): void {
    for (let i = key.lastIndexOf("/"); i > 2; i = key.lastIndexOf("/", i - 1))
      this.dirs.add(key.slice(0, i));
  }

  /** Put bytes (or text, encoded as the app writes it) at `path`, creating its folders. */
  put(path: string, contents: string | Uint8Array): void {
    const key = ProjectDisk.key(path);
    this.files.set(
      key,
      typeof contents === "string" ? new TextEncoder().encode(contents) : contents,
    );
    this.addParents(key);
  }

  /** The bytes at `path`, or undefined. */
  bytes(path: string): Uint8Array | undefined {
    return this.files.get(ProjectDisk.key(path));
  }

  /** Every file whose path starts with `prefix`, as path -> bytes (a copy). */
  snapshot(prefix = ""): Map<string, Uint8Array> {
    const p = prefix ? ProjectDisk.key(prefix) : "";
    return new Map(
      [...this.files]
        .filter(([k]) => !p || k === p || k.startsWith(`${p}/`))
        .map(([k, v]) => [k, v.slice()]),
    );
  }

  /** Copy a real folder (a fixture) into this disk under `at`. */
  mount(localDir: string, at: string): void {
    for (const name of readdirSync(localDir)) {
      const local = join(localDir, name);
      if (statSync(local).isDirectory()) this.mount(local, joinPath(at, name));
      else this.put(joinPath(at, name), new Uint8Array(readFileSync(local)));
    }
  }

  async exists(path: string): Promise<boolean> {
    const key = ProjectDisk.key(path);
    return this.files.has(key) || this.dirs.has(key);
  }
  async readTextFile(path: string): Promise<string> {
    const b = this.files.get(ProjectDisk.key(path));
    if (!b) throw new Error(`ENOENT: no such file, open '${path}'`);
    return new TextDecoder("utf-8").decode(b);
  }
  async writeTextFile(path: string, contents: string): Promise<void> {
    this.put(path, contents);
  }
  async mkdir(path: string): Promise<void> {
    const key = ProjectDisk.key(path);
    this.dirs.add(key);
    this.addParents(key);
  }
  async readBytes(path: string): Promise<Uint8Array> {
    const b = this.files.get(ProjectDisk.key(path));
    if (!b) throw new Error(`ENOENT: no such file, open '${path}'`);
    return b.slice();
  }
  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    this.put(path, data.slice());
  }
  async stat(path: string): Promise<{ isDirectory: boolean; size: number; mtimeMs?: number }> {
    const key = ProjectDisk.key(path);
    if (this.dirs.has(key)) return { isDirectory: true, size: 0 };
    const b = this.files.get(key);
    if (!b) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    return { isDirectory: false, size: b.length };
  }
  async rename(from: string, to: string): Promise<void> {
    const a = ProjectDisk.key(from);
    const b = this.files.get(a);
    if (!b) throw new Error(`ENOENT: no such file, rename '${from}'`);
    this.files.delete(a);
    this.put(to, b);
  }
  async remove(path: string): Promise<void> {
    const key = ProjectDisk.key(path);
    for (const k of [...this.files.keys()])
      if (k === key || k.startsWith(`${key}/`)) this.files.delete(k);
    for (const d of [...this.dirs]) if (d === key || d.startsWith(`${key}/`)) this.dirs.delete(d);
  }
  async readDir(path: string): Promise<DirEntry[]> {
    const key = ProjectDisk.key(path);
    const out = new Map<string, boolean>();
    const add = (k: string, isDir: boolean) => {
      if (!k.startsWith(`${key}/`)) return;
      const rest = k.slice(key.length + 1);
      const name = rest.split("/")[0];
      out.set(name, (out.get(name) ?? false) || isDir || rest.includes("/"));
    };
    for (const k of this.files.keys()) add(k, false);
    for (const d of this.dirs) add(d, true);
    return [...out].map(([name, isDirectory]) => ({ name, isDirectory }));
  }
  async copyFile(src: string, dst: string): Promise<void> {
    this.put(dst, await this.readBytes(src));
  }
}
