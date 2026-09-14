// Frame-accurate video decode for the preview. mp4box.js parses the file's INDEX (moov)
// and a WebCodecs VideoDecoder decodes samples read straight off disk by byte range.
// frameAt(t) seeks to the nearest keyframe <= t, decodes forward, and returns the
// VideoFrame at t (a valid WebGL TexImageSource). Browser-only (WebCodecs); unit-coverage
// excluded and validated by preview-probe-video.html in a real browser.
//
// Memory is O(the window being viewed), NOT O(the file): we keep the sample TABLE (a few
// numbers each) and fetch a sample's bytes only to hand them to the decoder. Reading the
// whole file instead is what crashed the app on a 1.84 GB recording — and on desktop the
// asset fetch is served by the Rust process, which read_to_end's the file, so the fatal
// allocation happened before any JS could catch it. Range requests are capped at ~1 MB by
// Tauri's asset protocol, so every read here is inherently bounded.
//
// A fresh decoder per frameAt (decode keyframe->target each call) keeps this
// simple + correct; a persistent forward-decoding decoder is a later optimisation.
import MP4Box, { type MP4ArrayBuffer, type MP4Info } from "mp4box";

interface Sample {
  cts: number; // timescale units
  duration: number;
  isSync: boolean;
  offset: number; // byte position of this sample's data in the file
  size: number; // its length in bytes
}

export interface VideoDims {
  w: number;
  h: number;
}

interface Pending {
  ts: number;
  resolve: (frame: VideoFrame | null) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const BUFFER_CAP = 8; // max decoded frames held open at once — MUST stay under the
// WebCodecs decoder's output-frame pool, else it stalls (preview freezes mid-clip)
const PUMP_MARGIN = 12; // samples fed past the target to flush the reorder buffer
const LOOKAHEAD = 4; // frames kept decoded ahead of the on-screen frame during playback
const INDEX_CHUNK = 1 << 20; // bytes per read while hunting the moov (Tauri caps a range at ~1 MB)
const INDEX_BUDGET = 64 << 20; // give up looking for an index after this much; a file whose
// moov never appears is not decodable here anyway, and an unbounded hunt is the bug we are fixing

export class VideoSource {
  private samples: Sample[] = [];
  private config: VideoDecoderConfig | null = null;
  private timescale = 1;
  private startCts = 0; // min composition time (B-frame reorder offset)
  private readonly ready: Promise<void>;
  dims: VideoDims = { w: 0, h: 0 };
  duration = 0;
  decoderStarts = 0; // diagnostic: number of decoder (re)configurations

  // Persistent decode state: one running decoder + a bounded frame buffer.
  private decoder: VideoDecoder | null = null;
  private buffer = new Map<number, VideoFrame>(); // timestamp(micros) -> frame
  private fedIndex = -1; // last sample actually handed to the decoder
  private requestedIndex = -1; // last sample QUEUED for feeding; reads are async, so a pump
  // that scheduled from fedIndex would re-request the same span every frame
  private feeding: Promise<void> = Promise.resolve();
  private feedEpoch = 0; // bumped on restart/seek so in-flight reads drop their output
  private runStart = -1; // keyframe index the current run began at
  private pending: Pending | null = null;
  private maxOutputTs = -1; // highest presentation timestamp output in this run
  private keepTs = -1; // ts currently wanted on screen; protected from lookahead eviction

  constructor(private readonly url: string) {
    this.ready = this.load();
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  private load(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const file = MP4Box.createFile();
      file.onError = (e) => reject(new Error(`mp4box(${this.url}): ${e}`));
      file.onReady = (info: MP4Info) => {
        const track = info.videoTracks[0];
        if (!track) {
          reject(new Error("no video track in file"));
          return;
        }
        this.timescale = track.timescale;
        this.dims = { w: track.video.width, h: track.video.height };
        this.duration = track.duration / track.timescale;
        this.config = {
          codec: track.codec,
          codedWidth: track.video.width,
          codedHeight: track.video.height,
          description: this.description(file, track.id),
        };
        // The moov alone carries the sample table (mp4box fills offsets/sizes from stco+stsz
        // before onReady), so the index costs a few numbers per frame and NO media bytes.
        for (const s of file.getTrackById(track.id).samples) {
          this.samples.push({
            cts: s.cts,
            duration: s.duration,
            isSync: s.is_sync,
            offset: s.offset,
            size: s.size,
          });
        }
      };
      void (async () => {
        try {
          // Walk the file's BOX structure, not its bytes: appendBuffer returns the next
          // position mp4box wants, which skips a whole mdat in one step — so a
          // moov-at-the-end recording costs two reads, not the file.
          let pos = 0;
          let read = 0;
          while (!this.samples.length && read < INDEX_BUDGET) {
            const chunk = await this.readRange(pos, pos + INDEX_CHUNK - 1);
            if (!chunk.bytes.length) break;
            read += chunk.bytes.length;
            const buf = chunk.bytes.buffer as MP4ArrayBuffer;
            buf.fileStart = chunk.start;
            const next = file.appendBuffer(buf);
            pos =
              typeof next === "number" && next > chunk.start
                ? next
                : chunk.start + chunk.bytes.length;
            if (pos >= chunk.total) break;
          }
          file.flush();
          if (!this.samples.length) {
            reject(new Error("no sample index found (no moov)"));
            return;
          }
          this.startCts = this.samples.reduce((m, s) => Math.min(m, s.cts), Infinity);
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      })();
    });
  }

  /** Read [start,end] inclusive. Ranges come back SHORT by design — Tauri's asset protocol
   *  caps a range response at ~1 MB — so this loops until the span is complete rather than
   *  silently decoding a truncated sample. */
  private async readRange(
    start: number,
    end: number,
  ): Promise<{ bytes: Uint8Array; start: number; total: number }> {
    const out: Uint8Array[] = [];
    let at = start;
    let total = Number.POSITIVE_INFINITY;
    while (at <= end) {
      const resp = await fetch(this.url, { headers: { Range: `bytes=${at}-${end}` } });
      if (!resp.ok && resp.status !== 206) throw new Error(`range read failed: ${resp.status}`);
      const cr = resp.headers.get("content-range");
      const slash = cr?.lastIndexOf("/") ?? -1;
      if (slash >= 0) total = Number(cr!.slice(slash + 1)) || total;
      const part = new Uint8Array(await resp.arrayBuffer());
      if (!part.length) break;
      out.push(part);
      at += part.length;
      // A server that ignores Range answers with the WHOLE file (200): one part is all of it.
      if (resp.status !== 206) {
        total = part.length;
        break;
      }
      if (Number.isFinite(total) && at >= total) break;
    }
    if (out.length === 1) return { bytes: out[0], start, total };
    const merged = new Uint8Array(out.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of out) {
      merged.set(p, o);
      o += p.length;
    }
    return { bytes: merged, start, total };
  }

  private description(file: ReturnType<typeof MP4Box.createFile>, trackId: number): Uint8Array {
    const trak = file.getTrackById(trackId);
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
      if (box) {
        const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
        box.write(stream);
        return new Uint8Array(stream.buffer, 8); // skip the 8-byte box header
      }
    }
    throw new Error("no codec description (avcC/hvcC) in file");
  }

  private toMicros(cts: number): number {
    return Math.round((cts * 1e6) / this.timescale);
  }

  /** The VideoFrame at source time `tSec`, or null. The frame is OWNED by this
   *  VideoSource (buffered for reuse) — upload it, do NOT close it. Sequential
   *  (forward) calls reuse the running decoder + its lookahead buffer; a
   *  backward seek or a jump to another GOP restarts from the nearest keyframe. */
  async frameAt(tSec: number): Promise<VideoFrame | null> {
    await this.ready;
    if (!this.config || this.samples.length === 0) return null;
    // Abandon any in-flight request (rapid seeks); its caller skips that frame.
    if (this.pending) this.settle(this.pending, null, false);

    const ti = this.targetIndex(tSec);
    const targetTs = this.toMicros(this.samples[ti].cts);
    const cached = this.buffer.get(targetTs);
    if (cached) return cached;

    const ki = this.keyframeBefore(ti);
    if (
      !this.decoder ||
      this.runStart < 0 ||
      ti < this.runStart ||
      targetTs <= this.maxOutputTs ||
      ki > this.requestedIndex + 1
    ) {
      this.restartAt(ki);
    }
    return new Promise<VideoFrame | null>((resolve) => {
      const req: Pending = { ts: targetTs, resolve, timer: undefined };
      this.pending = req;
      const end = Math.min(ti + PUMP_MARGIN, this.samples.length - 1);
      this.feedRange(this.fedIndex + 1, end);
      // Near the stream end the target may still be held in the reorder buffer — drain it
      // once the reads land. (flush requires a keyframe next, so the run is marked to restart.)
      if (end >= this.samples.length - 1) {
        void this.feeding.then(() => {
          if (this.pending !== req || !this.decoder) return;
          return this.decoder
            .flush()
            .then(() => this.settle(req, this.buffer.get(targetTs) ?? null, true))
            .catch(() => this.settle(req, null, true));
        });
      }
      // Safety net: never hang if the frame is never emitted.
      req.timer = setTimeout(
        () => this.settle(req, this.buffer.get(targetTs) ?? null, false),
        3000,
      );
    });
  }

  /** Non-blocking playback driver: keep the decoder running FORWARD around `tSec`,
   *  topping up a small look-ahead so nearestFrame() always has something to show.
   *  Restarts only on a backward seek or a jump into a different GOP. Pair with
   *  nearestFrame() + a render loop instead of awaiting frameAt() during playback. */
  pump(tSec: number): void {
    if (!this.config || this.samples.length === 0) return;
    const ti = this.targetIndex(tSec);
    this.keepTs = this.toMicros(this.samples[ti].cts);
    this.trimPast(); // free already-shown frames every tick so the decoder pool never fills
    const end = Math.min(ti + LOOKAHEAD, this.samples.length - 1);
    if (this.buffer.has(this.keepTs) && this.fedIndex >= end) return; // target + lookahead ready
    const ki = this.keyframeBefore(ti);
    if (!this.decoder || this.runStart < 0 || ti < this.runStart || ki > this.requestedIndex + 1) {
      this.restartAt(ki);
    }
    this.feedRange(this.fedIndex + 1, end);
  }

  /** Sync: the buffered frame with the greatest ts <= `tSec` (the one to display
   *  right now), or null if nothing at/behind the target is decoded yet. OWNED by
   *  this VideoSource — upload it, do NOT close it. */
  nearestFrame(tSec: number): VideoFrame | null {
    if (this.samples.length === 0) return null;
    const targetTs = this.toMicros(this.samples[this.targetIndex(tSec)].cts);
    let best: VideoFrame | null = null;
    let bestTs = -Infinity;
    for (const [ts, f] of this.buffer) {
      if (ts <= targetTs && ts > bestTs) {
        bestTs = ts;
        best = f;
      }
    }
    return best;
  }

  /** Release the decoder + buffered frames but keep the demuxed samples, so an
   *  off-screen clip stops using memory yet can re-pump instantly. No-op if idle. */
  idle(): void {
    if (this.decoder || this.buffer.size) this.disposeDecoder();
  }

  private settle(req: Pending, frame: VideoFrame | null, endReached: boolean): void {
    if (this.pending !== req) return;
    this.pending = null;
    if (req.timer !== undefined) clearTimeout(req.timer);
    if (endReached) this.runStart = -1;
    req.resolve(frame);
  }

  private targetIndex(tSec: number): number {
    const targetCts = Math.max(0, tSec) * this.timescale + this.startCts;
    // Samples are in DECODE order — cts is non-monotonic with B-frames — so scan
    // all and pick the greatest cts <= target to display.
    let ti = 0;
    let best = -Infinity;
    for (let i = 0; i < this.samples.length; i++) {
      const c = this.samples[i].cts;
      if (c <= targetCts && c > best) {
        best = c;
        ti = i;
      }
    }
    return ti;
  }

  private keyframeBefore(ti: number): number {
    let ki = ti;
    while (ki > 0 && !this.samples[ki].isSync) ki--;
    return ki;
  }

  private ensureDecoder(): void {
    if (this.decoder) return;
    this.decoder = new VideoDecoder({
      output: (frame) => this.onOutput(frame),
      error: () => {
        if (this.pending) this.settle(this.pending, null, false);
        this.disposeDecoder();
      },
    });
    this.decoder.configure(this.config as VideoDecoderConfig);
    this.decoderStarts += 1;
    this.runStart = -1;
    this.fedIndex = -1;
    this.requestedIndex = -1;
    this.maxOutputTs = -1;
  }

  private restartAt(ki: number): void {
    this.disposeDecoder();
    this.ensureDecoder();
    this.runStart = ki;
    this.fedIndex = ki - 1;
    this.requestedIndex = ki - 1;
    this.feedEpoch += 1; // strand any read still in flight for the previous run
    this.maxOutputTs = -1;
  }

  /** Fetch samples [from..to] and hand them to the decoder, in order. Serialised on one
   *  chain: two overlapping pumps must not interleave chunks into the decoder. The bytes
   *  are released as soon as they are queued — EncodedVideoChunk copies them. */
  private feedRange(from: number, to: number): void {
    from = Math.max(from, this.requestedIndex + 1);
    if (from > to) return;
    this.requestedIndex = to;
    const run = this.feedEpoch; // NOT bumped here: sequential feeds append to the same run
    this.feeding = this.feeding
      .then(async () => {
        if (run !== this.feedEpoch) return; // a restart/seek superseded this batch
        for (let i = from; i <= to;) {
          // Samples are contiguous in the file, so one read covers a span of them; readRange
          // already loops over the server's ~1 MB cap.
          let j = i;
          let bytes = this.samples[i].size;
          while (
            j + 1 <= to &&
            this.samples[j + 1].offset === this.samples[j].offset + this.samples[j].size &&
            bytes + this.samples[j + 1].size <= INDEX_CHUNK
          ) {
            j++;
            bytes += this.samples[j].size;
          }
          const start = this.samples[i].offset;
          const { bytes: buf } = await this.readRange(start, start + bytes - 1);
          if (run !== this.feedEpoch || !this.decoder) return;
          for (let k = i; k <= j; k++) {
            const s = this.samples[k];
            const at = s.offset - start;
            if (at + s.size > buf.length) return; // short read: stop rather than decode garbage
            this.decoder.decode(
              new EncodedVideoChunk({
                type: s.isSync ? "key" : "delta",
                timestamp: this.toMicros(s.cts),
                duration: this.toMicros(s.duration),
                data: buf.subarray(at, at + s.size),
              }),
            );
            this.fedIndex = k;
          }
          i = j + 1;
        }
      })
      .catch(() => undefined);
  }

  private onOutput(frame: VideoFrame): void {
    if (frame.timestamp > this.maxOutputTs) this.maxOutputTs = frame.timestamp;
    this.buffer.set(frame.timestamp, frame);
    this.evict();
    if (this.pending && frame.timestamp === this.pending.ts)
      this.settle(this.pending, frame, false);
  }

  // Bound the buffer. Prefer dropping PAST frames (ts < keepTs, already scrolled
  // past) so a forward look-ahead never evicts the frame that's on screen; never
  // drop the awaited pending frame. Falls back to oldest-first (keepTs = -1 for
  // pure frameAt callers reproduces the original FIFO behaviour).
  private evict(): void {
    while (this.buffer.size > BUFFER_CAP) {
      let victim = -1;
      for (const ts of this.buffer.keys()) {
        if (ts !== this.pending?.ts && ts < this.keepTs) {
          victim = ts;
          break;
        }
      }
      if (victim < 0) {
        for (const ts of this.buffer.keys()) {
          if (ts !== this.pending?.ts) {
            victim = ts;
            break;
          }
        }
      }
      if (victim < 0) break;
      this.buffer.get(victim)?.close();
      this.buffer.delete(victim);
    }
  }

  // Close every buffered frame strictly before the on-screen target (keepTs).
  // Called each pump so a forward run holds only the target + a small look-ahead,
  // keeping the count under the decoder's pool. The displayed frame is already
  // copied into its GL texture, so closing it here doesn't blank the canvas.
  private trimPast(): void {
    for (const [ts, f] of this.buffer) {
      if (ts < this.keepTs && ts !== this.pending?.ts) {
        f.close();
        this.buffer.delete(ts);
      }
    }
  }

  private disposeDecoder(): void {
    if (this.decoder && this.decoder.state !== "closed") {
      try {
        this.decoder.close();
      } catch {
        /* already closed */
      }
    }
    this.decoder = null;
    for (const f of this.buffer.values()) f.close();
    this.buffer.clear();
    this.runStart = -1;
    this.fedIndex = -1;
  }

  close(): void {
    if (this.pending) this.settle(this.pending, null, false);
    this.disposeDecoder();
    this.samples = [];
    this.config = null;
  }
}
