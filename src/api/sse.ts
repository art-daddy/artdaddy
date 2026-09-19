// POST-based SSE reader. Native EventSource is GET-only, so we stream the POST
// response body and parse `event:` / `data:` frames ourselves. Works in the
// browser and the Tauri webview.
export interface SSEMessage {
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

/** A stream that opened but then went quiet. Distinct from a CLOSED stream (which ends the
 *  read loop normally) — this is the case that produced no error at all: the reader simply
 *  awaited the next chunk forever, so the turn never settled and the spinner never stopped. */
export class StreamStalledError extends Error {
  constructor(public readonly idleMs: number) {
    super(`the server stopped sending data (nothing for ${Math.round(idleMs / 1000)}s)`);
    this.name = "StreamStalledError";
  }
}

async function readOrStall(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (idleMs <= 0) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StreamStalledError(idleMs)), idleMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Parse SSE frames off an already-open response body. Split out from `streamSSE`
 *  so a caller that needs its own status/error handling (the inference stream maps
 *  401/402/429 to typed errors) reuses this parser instead of growing a second one.
 *
 *  `idleMs` bounds the wait for the NEXT chunk, not the whole stream: a long round is
 *  legitimate, a silent socket is not. Any byte resets it — including an SSE `:` comment,
 *  which is what the server's keepalive sends. */
export async function readSSE(
  body: ReadableStream<Uint8Array>,
  onEvent: (msg: SSEMessage) => void,
  opts: { idleMs?: number } = {},
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const idleMs = opts.idleMs ?? 0;
  let buf = "";
  let event = "message";
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length === 0) return;
    const raw = dataLines.join("\n");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* leave as string */
    }
    onEvent({ event, data });
    event = "message";
    dataLines = [];
  };

  try {
    for (;;) {
      const { done, value } = await readOrStall(reader, idleMs);
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          flush();
          continue;
        }
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
    }
  } catch (e) {
    // Release the socket: without this a stalled round leaks its connection for the life
    // of the process, and enough of them exhaust the pool.
    void reader.cancel().catch(() => {});
    throw e;
  }
  flush();
}

export async function streamSSE(
  url: string,
  body: unknown,
  onEvent: (msg: SSEMessage) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`stream ${res.status}: ${text || res.statusText}`);
  }
  if (!res.body) throw new Error("no response body for SSE stream");
  await readSSE(res.body, onEvent);
}
