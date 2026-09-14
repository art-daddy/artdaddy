// POST-based SSE reader. Native EventSource is GET-only, so we stream the POST
// response body and parse `event:` / `data:` frames ourselves. Works in the
// browser and the Tauri webview.
export interface SSEMessage {
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

/** Parse SSE frames off an already-open response body. Split out from `streamSSE`
 *  so a caller that needs its own status/error handling (the inference stream maps
 *  401/402/429 to typed errors) reuses this parser instead of growing a second one. */
export async function readSSE(
  body: ReadableStream<Uint8Array>,
  onEvent: (msg: SSEMessage) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
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

  for (;;) {
    const { done, value } = await reader.read();
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
