// An in-memory project disk for the chat-file tests. It behaves like the real one where the chat files
// depend on it: a folder exists because a file is under it, `readDir` and `remove` on a path that is not
// there throw (as the desktop fs does), and `rename` is atomic, so a write is a temp file then a rename.
// What a test needs beyond that is injected: a write that throws, and a write held until released.
import { joinPath, ProjectStoreAccess, type DirEntry, type FsLike } from "../tools/store";

export class ChatDiskFs implements FsLike {
  files = new Map<string, string>();
  /** The final path of every file written (a temp's rename), in order. */
  writes: string[] = [];
  /** Makes the write of a path throw, as a full or read-only disk does. Checked on the temp too. */
  failWrite: ((path: string) => boolean) | null = null;
  /** Holds the write of a path until the returned promise is released. */
  holdWrite: ((path: string) => Promise<void> | null) | null = null;
  /** Makes a directory listing throw even though the folder exists. */
  failList: ((path: string) => boolean) | null = null;
  /** Makes the removal of a path throw. */
  failRemove: ((path: string) => boolean) | null = null;
  /** Every text read, for asserting what a feature did NOT read. */
  reads: string[] = [];

  private norm = (p: string): string => joinPath(p);

  async exists(p: string): Promise<boolean> {
    const n = this.norm(p);
    return this.files.has(n) || [...this.files.keys()].some((k) => k.startsWith(`${n}/`));
  }
  async readTextFile(p: string): Promise<string> {
    const n = this.norm(p);
    const v = this.files.get(n);
    if (v === undefined) throw new Error(`ENOENT: ${n}`);
    this.reads.push(n);
    return v;
  }
  async writeTextFile(p: string, c: string): Promise<void> {
    const n = this.norm(p);
    if (this.failWrite?.(n)) throw new Error(`EIO: ${n}`);
    const held = this.holdWrite?.(n);
    if (held) await held;
    this.files.set(n, c);
  }
  async mkdir(): Promise<void> {}
  async rename(from: string, to: string): Promise<void> {
    const f = this.norm(from);
    const t = this.norm(to);
    const v = this.files.get(f);
    if (v === undefined) throw new Error(`ENOENT: ${f}`);
    this.files.delete(f);
    this.files.set(t, v);
    if (!/\.tmp-[a-z0-9]+$/i.test(t)) this.writes.push(t);
  }
  async readDir(p: string): Promise<DirEntry[]> {
    const base = this.norm(p);
    if (!(await this.exists(base))) throw new Error(`ENOENT: ${base}`);
    if (this.failList?.(base)) throw new Error(`EACCES: ${base}`);
    const seen = new Map<string, boolean>();
    for (const k of this.files.keys()) {
      if (!k.startsWith(`${base}/`)) continue;
      const rest = k.slice(base.length + 1);
      const slash = rest.indexOf("/");
      if (slash === -1) seen.set(rest, false);
      else seen.set(rest.slice(0, slash), true);
    }
    return [...seen].map(([name, isDirectory]) => ({ name, isDirectory }));
  }
  async remove(p: string): Promise<void> {
    const n = this.norm(p);
    if (this.failRemove?.(n)) throw new Error(`EBUSY: ${n}`);
    if (!(await this.exists(n))) throw new Error(`ENOENT: ${n}`);
    for (const k of [...this.files.keys()])
      if (k === n || k.startsWith(`${n}/`)) this.files.delete(k);
  }

  /** The files under a folder, by name (a test's quick look at what is on disk). */
  names(dir: string): string[] {
    const base = this.norm(dir);
    return [...this.files.keys()]
      .filter((k) => k.startsWith(`${base}/`))
      .map((k) => k.slice(base.length + 1))
      .sort();
  }
  json(path: string): unknown {
    const v = this.files.get(this.norm(path));
    return v === undefined ? undefined : JSON.parse(v);
  }
}

export const CHAT_DIR = "C:/proj/chat-p1";

/** A project store over an in-memory disk. */
export function chatDisk(dir = CHAT_DIR): {
  fs: ChatDiskFs;
  store: ProjectStoreAccess;
  dir: string;
} {
  const fs = new ChatDiskFs();
  return { fs, store: new ProjectStoreAccess(dir, fs), dir };
}
