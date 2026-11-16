// A REAL HTTP server on this machine's loopback address that plays the places the speech model is fetched from,
// and a disk that really keeps the bytes it is given, for tests that drive the app's own download
// (`ensureWhisperModel`, and the `downloadModel` and `transferModel` under it) end to end over a socket.
//
// What is real: the server and the client are both Node's HTTP, so a Range request, a truncated body, a reset and
// a stall are what a socket does, not what a fake says. What is a stand-in: there is no network, so the addresses
// the app asks for (the compiled first and second places, or any address a remote answer named) are pointed at this
// server by `fetch`; an address it cannot point here is refused, never fetched. Which place the app asked, in which
// order and with which Range is read back from `seen` and `asked`, so a test checks the order the app used and not
// the order it was told.
import { createHash } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Readable } from "node:stream";

import { PRIMARY_BASE, SECOND_PLACE_BASE } from "../tools/modelManifest";
import { joinPath, type FsLike } from "../tools/store";

/** Where a request went: the compiled first place, the compiled second place, or any other address. */
export type PlaceName = "first" | "second" | "other";

/** What a place does with ONE request. A place with no turn left serves properly ("good"). */
export type Turn =
  /** Honours Range: 206 with the tail it was asked for, or 200 with the whole file when there was no Range. */
  | "good"
  /** The right length with every byte changed, honouring Range as "good" does. */
  | "wrong"
  /** Answers 200 with the WHOLE file whatever Range says. */
  | "ignore-range"
  /** Accepts the connection and then closes it with no answer at all. */
  | "reset"
  /** Accepts the request and never answers it. */
  | "silent"
  /** Answers with this status and no body. */
  | { status: number }
  /** Sends the first `cut` bytes of what was asked for, then closes the connection or goes quiet. */
  | { cut: number; then: "close" | "stall" }
  /** Answers properly, but with the bytes of ANOTHER file this server holds: a place that mixes its files up. */
  | { instead: string };

/** What one request did, as the server saw it. */
export interface Seen {
  place: PlaceName;
  revision: string;
  file: string;
  /** The Range header as the app wrote it, or null. */
  range: string | null;
  status: number;
  /** Bytes of body written to the socket. */
  sent: number;
  end: "complete" | "cut" | "stalled" | "reset" | "refused";
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "Content-Length, Content-Range, Accept-Ranges",
  "accept-ranges": "bytes",
  "cache-control": "public, max-age=31536000, immutable",
};

/** `length` bytes that look like a model: no repeating pattern, and different for every `seed`, so that a
 *  shifted copy, a wrong prefix or another file's bytes cannot pass for the right ones. */
export function fakeModelBytes(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let at = 0, block = 0; at < length; block++, at += 32) {
    const digest = createHash("sha256").update(`${seed}:${block}`).digest();
    digest.copy(out, at, 0, Math.min(32, length - at));
  }
  return out;
}

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The same length, no byte the same. */
export const corrupted = (bytes: Uint8Array): Buffer =>
  Buffer.from(bytes.map((byte) => byte ^ 0x5a));

const listening = new Set<LoopbackPlaces>();
/** How many servers of this module are still listening: a run must leave none. */
export const serversListening = (): number => listening.size;

export class LoopbackPlaces {
  /** Every request the server answered or dropped, in order. */
  readonly seen: Seen[] = [];
  /** The addresses the app asked for, exactly as it wrote them, before they were pointed at this server. */
  readonly asked: string[] = [];
  /** Addresses `fetch` could not point at this server: refused, so nothing here ever leaves the machine. */
  readonly refused: string[] = [];
  private readonly turns: Record<PlaceName, Turn[]> = { first: [], second: [], other: [] };
  private readonly sockets = new Set<Socket>();

  private constructor(
    private readonly server: Server,
    private readonly origin: string,
    private readonly files: ReadonlyMap<string, Buffer>,
  ) {
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    server.on("request", (req, res) => this.answer(req, res));
  }

  /** Starts a server on 127.0.0.1 (a port the system picks) that holds `files`, by file name. */
  static async start(files: Record<string, Uint8Array>): Promise<LoopbackPlaces> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    const held = new Map(Object.entries(files).map(([name, bytes]) => [name, Buffer.from(bytes)]));
    const places = new LoopbackPlaces(server, `http://127.0.0.1:${port}`, held);
    listening.add(places);
    return places;
  }

  /** Queues what `place` does with its next requests, one turn per request, in order. */
  script(place: PlaceName, ...turns: Turn[]): this {
    this.turns[place].push(...turns);
    return this;
  }

  /** Closes the server and every connection still open on it, including a stalled one. */
  async stop(): Promise<void> {
    listening.delete(this);
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** `fetch`, as the app calls it: the address is pointed at this server and the request really goes out. */
  readonly fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const address =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    this.asked.push(address);
    const target = this.pointHere(address);
    if (target === null) {
      this.refused.push(address);
      return Promise.reject(new TypeError("network error: this address is not served here"));
    }
    return httpFetch(target, init);
  };

  private pointHere(address: string): string | null {
    if (address.startsWith(`${PRIMARY_BASE}/`))
      return `${this.origin}/first/${address.slice(PRIMARY_BASE.length + 1)}`;
    if (address.startsWith(`${SECOND_PLACE_BASE}/`))
      return `${this.origin}/second/${address.slice(SECOND_PLACE_BASE.length + 1)}`;
    try {
      const url = new URL(address);
      return url.protocol === "https:"
        ? `${this.origin}/other/${url.hostname}${url.pathname}`
        : null;
    } catch {
      return null;
    }
  }

  private answer(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...CORS,
        "access-control-allow-methods": "GET, HEAD",
        "access-control-allow-headers": "range",
      });
      res.end();
      return;
    }
    const parts = new URL(req.url ?? "/", "http://loopback").pathname.split("/").filter(Boolean);
    const place = (["first", "second", "other"] as const).find((name) => name === parts[0]);
    const file = parts[parts.length - 1] ?? "";
    const seen: Seen = {
      place: place ?? "other",
      revision: place === "other" ? "" : (parts[parts.length - 2] ?? ""),
      file,
      range: req.headers.range ?? null,
      status: 0,
      sent: 0,
      end: "complete",
    };
    this.seen.push(seen);
    const content = this.files.get(file);
    const turn: Turn = (place && this.turns[place].shift()) || "good";
    const refuse = (status: number): void => {
      seen.status = status;
      seen.end = "refused";
      res.writeHead(status, CORS);
      res.end();
    };
    if (!place) return refuse(404);
    if (typeof turn === "object" && "status" in turn) return refuse(turn.status);
    if (turn === "silent") {
      seen.end = "stalled";
      return;
    }
    if (turn === "reset") {
      seen.end = "reset";
      req.socket.destroy();
      return;
    }
    // A file this server does not hold is not there, whatever else was asked of it.
    if (!content) return refuse(404);

    const instead =
      typeof turn === "object" && "instead" in turn ? this.files.get(turn.instead) : null;
    const body = turn === "wrong" ? corrupted(content) : (instead ?? content);
    const total = body.length;
    const asked = turn === "ignore-range" ? null : /^bytes=(\d+)-(\d*)$/.exec(seen.range ?? "");
    const first = asked ? Number(asked[1]) : 0;
    if (asked && first >= total) {
      seen.status = 416;
      res.writeHead(416, { ...CORS, "content-range": `bytes */${total}` });
      res.end();
      return;
    }
    const last = asked && asked[2] !== "" ? Math.min(Number(asked[2]), total - 1) : total - 1;
    const piece = body.subarray(first, last + 1);
    seen.status = asked ? 206 : 200;
    res.writeHead(seen.status, {
      ...CORS,
      "content-type": "application/octet-stream",
      "content-length": String(piece.length),
      ...(asked && { "content-range": `bytes ${first}-${last}/${total}` }),
    });
    if (typeof turn === "object" && "cut" in turn) {
      const part = piece.subarray(0, Math.min(turn.cut, piece.length));
      res.flushHeaders();
      res.write(part, () => {
        seen.sent = part.length;
        if (turn.then === "stall") {
          seen.end = "stalled";
          return;
        }
        seen.end = "cut";
        // Let what was written reach the app before the connection goes.
        setTimeout(() => req.socket.destroy(), 20);
      });
      return;
    }
    seen.sent = piece.length;
    res.end(piece);
  }
}

/** One GET over a real socket, answered as the app's fetch is: status, headers and a body it reads a chunk at a time. */
function httpFetch(target: string, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? undefined;
    const aborted = (): Error =>
      Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const request = httpRequest(
      target,
      { method: "GET", headers: init?.headers as Record<string, string> | undefined, agent: false },
      (answer) => {
        const status = answer.statusCode ?? 0;
        const ok = status >= 200 && status < 300;
        const headers = new Headers();
        for (const [name, value] of Object.entries(answer.headers))
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        // The app reads no body of a refusal; drain it so the connection is released.
        if (!ok) answer.resume();
        resolve({
          ok,
          status,
          headers,
          body: ok ? (Readable.toWeb(answer) as unknown as ReadableStream<Uint8Array>) : null,
        } as unknown as Response);
      },
    );
    request.on("error", reject);
    signal?.addEventListener(
      "abort",
      () => {
        request.destroy();
        reject(aborted());
      },
      { once: true },
    );
    request.end();
  });
}

/** A disk that keeps the bytes it is given, where the one the other download tests use cannot tell a prefix from a
 *  whole file: sizes and SHA-256 are measured on what was really appended. */
export class MemoryModelFs implements FsLike {
  readonly bytes = new Map<string, Buffer>();
  readonly texts = new Map<string, string>();
  /** Every file moved into place by a rename, with the size and SHA-256 of what was moved: what ever became a model. */
  readonly moved: Array<{ to: string; size: number; sha256: string }> = [];

  async exists(p: string): Promise<boolean> {
    const n = joinPath(p);
    return this.bytes.has(n) || this.texts.has(n);
  }
  async readTextFile(p: string): Promise<string> {
    const text = this.texts.get(joinPath(p));
    if (text === undefined) throw new Error("ENOENT");
    return text;
  }
  async writeTextFile(p: string, contents: string): Promise<void> {
    this.texts.set(joinPath(p), contents);
  }
  async mkdir(): Promise<void> {}
  async writeBytes(p: string, data: Uint8Array): Promise<void> {
    this.bytes.set(joinPath(p), Buffer.from(data));
  }
  async readBytes(p: string): Promise<Uint8Array> {
    const held = this.bytes.get(joinPath(p));
    if (!held) throw new Error("ENOENT");
    return held;
  }
  async appendBytes(p: string, data: Uint8Array): Promise<void> {
    const n = joinPath(p);
    this.bytes.set(n, Buffer.concat([this.bytes.get(n) ?? Buffer.alloc(0), data]));
  }
  async stat(p: string): Promise<{ isDirectory: boolean; size: number; mtimeMs?: number }> {
    const n = joinPath(p);
    const held = this.bytes.get(n);
    if (held) return { isDirectory: false, size: held.length, mtimeMs: 1 };
    const text = this.texts.get(n);
    if (text !== undefined) return { isDirectory: false, size: text.length, mtimeMs: 1 };
    throw new Error("ENOENT");
  }
  async probeMedia(p: string, headBytes: number) {
    const held = this.bytes.get(joinPath(p));
    if (!held) throw new Error("ENOENT");
    const sha256 = sha256Hex(held);
    return {
      id12: sha256.slice(0, 12),
      sha256,
      size: held.length,
      head: held.subarray(0, headBytes),
    };
  }
  async remove(p: string): Promise<void> {
    const n = joinPath(p);
    this.bytes.delete(n);
    this.texts.delete(n);
  }
  async rename(from: string, to: string): Promise<void> {
    const src = joinPath(from);
    const dst = joinPath(to);
    const held = this.bytes.get(src);
    if (!held) throw new Error("ENOENT");
    this.moved.push({ to: dst, size: held.length, sha256: sha256Hex(held) });
    this.bytes.set(dst, held);
    this.bytes.delete(src);
  }

  /** The files of this disk that are parts of a download. */
  parts(): string[] {
    return [...this.bytes.keys()].filter((name) => name.endsWith(".part"));
  }
}
