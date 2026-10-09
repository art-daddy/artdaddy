// Phase 4 closure: exercise the shipping tool path with disposable stand-in media.
// fixtures <media-dir> <speech-dir>
// setup <swiss|japanese|arabic|external|long> <media-dir>
// verify <scenario>
// call <scenario> <tool> [args.json]
// status <scenario>
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { connect as connectPage, evaluate, pageTarget } from "../cdp.mjs";

const output = path.resolve(import.meta.dirname, "../../reports/qa/phase4");
mkdirSync(output, { recursive: true });
const statePath = path.join(output, "state.json");
const readState = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {});

function verifyDelivered(scenario, filename) {
  assert.ok(existsSync(filename), `missing delivered file: ${filename}`);
  const ffprobe = path.resolve(import.meta.dirname, "../../src-tauri/binaries/artdaddy-ffprobe-x86_64-pc-windows-msvc.exe");
  const probe = spawnSync(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", filename], {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(probe.status, 0, probe.error?.message ?? probe.stderr);
  const facts = JSON.parse(probe.stdout);
  const video = facts.streams.find((stream) => stream.codec_type === "video");
  assert.ok(video?.width > 0 && video?.height > 0, "delivered video must have a picture");
  assert.ok(facts.streams.some((stream) => stream.codec_type === "audio"), "spoken sound must survive export");
  assert.ok(Number(facts.format.duration) > 0 && Number(facts.format.size) > 0, "delivered file must contain media");
  writeFileSync(path.join(output, `${scenario}.artifact.json`), JSON.stringify({ filename, ...facts }, null, 2));
  console.log(`ARTIFACT ${video.width}x${video.height}, ${facts.format.duration} s, ${facts.format.size} bytes, audio present`);
  return facts;
}

function verifyCaptionPixels(scenario, filename) {
  verifyDelivered(scenario, filename);
  const records = readFileSync(path.join(output, `${scenario}.jsonl`), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const captions = records.filter((record) => record.name === "add_captions").at(-1)?.result.clips ?? [];
  const cue = captions.find((clip) => Array.isArray(clip.content) && clip.content[1]?.t_in > 0.12 && clip.timeline_out - clip.timeline_in > 8);
  assert.ok(cue, "fixture needs a caption with two separately timed words");
  const frames = [cue.timeline_in + 1, cue.timeline_out - 2];
  const ffmpeg = path.resolve(import.meta.dirname, "../../src-tauri/binaries/artdaddy-ffmpeg-x86_64-pc-windows-msvc.exe");
  const width = 360;
  const height = 640;
  const decoded = spawnSync(ffmpeg, ["-v", "error", "-i", filename, "-vf",
    `select=eq(n\\,${frames[0]})+eq(n\\,${frames[1]}),scale=${width}:${height}:flags=area`,
    "-fps_mode", "passthrough", "-frames:v", "2", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(decoded.status, 0, decoded.error?.message ?? String(decoded.stderr));
  const frameBytes = width * height * 3;
  assert.equal(decoded.stdout.length, frameBytes * 2, "both caption frames must decode");
  const ink = (offset) => {
    let count = 0;
    for (let row = Math.floor(height * 0.78); row < height * 0.94; row++)
      for (let column = 0; column < width * 0.78; column++) {
        const pixel = offset + (row * width + column) * 3;
        if (Math.min(...decoded.stdout.subarray(pixel, pixel + 3)) > 215) count++;
      }
    return count;
  };
  const counts = [ink(0), ink(frameBytes)];
  assert.ok(counts[0] > 0, "the first revealed word must render");
  assert.ok(counts[1] > counts[0], `later words must appear in the same cue: ${counts}`);
  const proof = { filename, captionId: cue.id, frames, ink: counts };
  writeFileSync(path.join(output, `${scenario}.pixels.json`), JSON.stringify(proof, null, 2));
  console.log(`CAPTION PIXELS ${JSON.stringify(proof)}`);
}

async function verifyPreview(scenario, source, label) {
  const page = await connectPage(await pageTarget());
  try {
    await evaluate(page, `(async () => {
      const url = performance.getEntriesByType('resource').map(entry => entry.name)
        .filter(name => new URL(name).pathname === '/src/store/editor.ts').pop() ?? '/src/store/editor.ts';
      const editor = (await import(url)).useEditor;
      editor.setState({ activeMediaTab: null });
      editor.getState().select(null);
      editor.getState().setPlayhead(0.5);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
    const rect = await evaluate(page, `(() => {
      const canvas = [...document.querySelectorAll('canvas')].sort((left, right) =>
        right.clientWidth * right.clientHeight - left.clientWidth * left.clientHeight)[0];
      const box = canvas.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 };
    })()`);
    const filename = path.join(output, `${scenario}.preview.${label ?? "check"}.png`);
    const ffmpeg = path.resolve(import.meta.dirname, "../../src-tauri/binaries/artdaddy-ffmpeg-x86_64-pc-windows-msvc.exe");
    const decode = (input, seek) => {
      const decoded = spawnSync(ffmpeg, ["-v", "error", ...(seek ? ["-ss", "0.5"] : []), "-i", input, "-frames:v", "1",
        "-vf", "scale=64:64", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1024 * 1024 });
      assert.equal(decoded.status, 0, String(decoded.stderr));
      assert.equal(decoded.stdout.length, 64 * 64 * 3, "a complete picture must decode");
      return [[16, 16], [48, 16], [16, 48], [48, 48]].map(([column, row]) =>
        [...decoded.stdout.subarray((row * 64 + column) * 3, (row * 64 + column) * 3 + 3)]);
    };
    const expected = decode(source, true);
    const matches = (colors) => colors.every((color, index) =>
      Math.hypot(...color.map((channel, offset) => channel - expected[index][offset])) < 40);
    const started = Date.now();
    let actual;
    do {
      await evaluate(page, `new Promise(resolve => requestAnimationFrame(resolve))`);
      const shot = await page.send("Page.captureScreenshot", { format: "png", clip: rect });
      writeFileSync(filename, Buffer.from(shot.data, "base64"));
      actual = decode(filename, false);
      if (matches(actual)) break;
    } while (Date.now() - started < 15_000);
    for (const [index, color] of actual.entries())
      assert.ok(Math.hypot(...color.map((channel, offset) => channel - expected[index][offset])) < 40,
        `preview quadrant ${index}: ${color}, expected ${expected[index]}`);
    const proof = { label, source, screenshot: filename, readyMs: Date.now() - started, actual, expected };
    writeFileSync(path.join(output, `${scenario}.preview.jsonl`), `${JSON.stringify(proof)}\n`, { flag: "a" });
    console.log(`PREVIEW PIXELS ${JSON.stringify(proof)}`);
  } finally { page.close(); }
}

function verifySwissRotation(filename, directory, state) {
  verifyDelivered("swiss", filename);
  const timeline = JSON.parse(readFileSync(path.join(process.env.APPDATA, "ArtDaddy", "projects", state.swiss.projectId, "internals", "timeline.json"), "utf8"));
  const ffmpeg = path.resolve(import.meta.dirname, "../../src-tauri/binaries/artdaddy-ffmpeg-x86_64-pc-windows-msvc.exe");
  const corners = (input, frame) => {
    const decoded = spawnSync(ffmpeg, ["-v", "error", "-i", input, "-vf",
      `select=eq(n\\,${frame}),scale=64:64:flags=area`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1024 * 1024 });
    assert.equal(decoded.status, 0, String(decoded.stderr));
    assert.equal(decoded.stdout.length, 64 * 64 * 3);
    const rgb = (column, row) => [...decoded.stdout.subarray((row * 64 + column) * 3, (row * 64 + column) * 3 + 3)];
    const colored = (column, row) => {
      const pixel = rgb(column, row);
      return Math.max(...pixel) - Math.min(...pixel) > 100;
    };
    const rows = Array.from({ length: 64 }, (_, row) => row).filter((row) =>
      Array.from({ length: 64 }, (_, column) => colored(column, row)).filter(Boolean).length > 25);
    assert.ok(rows.length, "coloured fixture must be visible");
    const palette = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
    return [[16, 0.25], [48, 0.25], [16, 0.75], [48, 0.75]].map(([column, fraction]) => {
      const color = rgb(column, Math.floor(rows[0] + fraction * (rows.at(-1) - rows[0])));
      const distances = palette.map((reference) => Math.hypot(...color.map((channel, offset) => channel - reference[offset])));
      return distances.indexOf(Math.min(...distances));
    });
  };
  const proofs = [90, 180, 270].map((rotation) => {
    const file = `de_${rotation}.mp4`;
    const ref = state.swiss.media[file];
    const clip = timeline.tracks.flatMap((track) => track.clips ?? []).find((entry) => entry.kind === "video" && entry.media_ref === ref);
    assert.ok(clip, `missing ${file}`);
    const frame = clip.timeline_in + Math.floor((clip.timeline_out - clip.timeline_in) / 2);
    return { file, addedRotate: clip.rotate ?? 0, frame, expected: corners(path.join(directory, file), 0), actual: corners(filename, frame) };
  });
  writeFileSync(path.join(output, "swiss.rotation.json"), JSON.stringify(proofs, null, 2));
  for (const proof of proofs) assert.deepEqual(proof.actual, proof.expected, `extra rotation changed ${proof.file}`);
  console.log(`SWISS ROTATION ${JSON.stringify(proofs)}`);
}

function rpc(body, sessionId) {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(body);
    const request = http.request("http://127.0.0.1:19787/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "content-length": Buffer.byteLength(encoded),
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        sessionId: response.headers["mcp-session-id"] ?? sessionId,
        text,
      }));
    });
    request.on("error", reject);
    request.end(encoded);
  });
}

function result(response) {
  assert.equal(response.status, 200, response.text.slice(0, 300));
  const events = response.text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  const message = JSON.parse(events.length ? events.at(-1).slice(5) : response.text);
  assert.equal(message.error, undefined, JSON.stringify(message.error));
  const text = (message.result?.content ?? []).filter((part) => part.type === "text")
    .map((part) => part.text).join("");
  const payload = text ? JSON.parse(text) : message.result;
  assert.notEqual(message.result?.isError, true, JSON.stringify(payload));
  assert.notEqual(payload?.ok, false, JSON.stringify(payload));
  return payload;
}

let callId = 1;
let sessionId;
async function connect() {
  const response = await rpc({
    jsonrpc: "2.0", id: callId++, method: "initialize",
    params: {
      protocolVersion: "2025-03-26", capabilities: {},
      clientInfo: { name: "phase4-closure", version: "1" },
    },
  });
  assert.equal(response.status, 200, response.text);
  sessionId = response.sessionId;
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
}

async function call(scenario, name, args) {
  const started = Date.now();
  const response = await rpc({
    jsonrpc: "2.0", id: callId++, method: "tools/call",
    params: { name, arguments: args },
  }, sessionId);
  const payload = result(response);
  const record = { at: new Date().toISOString(), name, args, ms: Date.now() - started, result: payload };
  writeFileSync(path.join(output, `${scenario}.jsonl`), `${JSON.stringify(record)}\n`, { flag: "a" });
  console.log(`${name}: ${record.ms} ms ${JSON.stringify(payload).slice(0, 650)}`);
  return payload;
}

const scenarios = {
  swiss: ["de_0.mp4", "de_90.mp4", "de_180.mp4", "de_270.mp4", "silent.mp4"],
  japanese: ["ja.mp4"],
  arabic: ["ar.mp4"],
  external: ["ssd_clip.mp4"],
  long: ["recording80.mp4"],
};

const [action, scenario, first, second] = process.argv.slice(2);
if (action === "fixtures") {
  const directory = path.resolve(scenario);
  const speech = path.resolve(first);
  mkdirSync(directory, { recursive: true });
  const binaryRoot = path.resolve(import.meta.dirname, "../../src-tauri/binaries");
  const ffmpeg = path.join(binaryRoot, "artdaddy-ffmpeg-x86_64-pc-windows-msvc.exe");
  const ffprobe = path.join(binaryRoot, "artdaddy-ffprobe-x86_64-pc-windows-msvc.exe");
  const run = (program, args) => {
    const command = spawnSync(program, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    assert.equal(command.status, 0, command.error?.message ?? command.stderr.slice(-2000));
    return command.stdout;
  };
  const encode = (name, args, replace = false) => {
    const destination = path.join(directory, name);
    if (replace || !existsSync(destination)) run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args, destination]);
    return destination;
  };
  const pattern = "color=c=black:size=640x360:rate=30," +
    "drawbox=x=0:y=0:w=320:h=180:color=red:t=fill," +
    "drawbox=x=320:y=0:w=320:h=180:color=lime:t=fill," +
    "drawbox=x=0:y=180:w=320:h=180:color=blue:t=fill," +
    "drawbox=x=320:y=180:w=320:h=180:color=yellow:t=fill";
  const videoArgs = ["-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"];
  for (const [index, rotation] of [0, 90, 180, 270].entries()) {
    const base = encode(`de_base_${rotation}.mp4`, [
      "-f", "lavfi", "-i", pattern, "-ss", String(index * 12),
      "-i", path.join(speech, "b_de.wav"), "-t", "12", ...videoArgs,
    ]);
    encode(`de_${rotation}.mp4`, ["-display_rotation", String(rotation), "-i", base, "-c", "copy"], true);
  }
  encode("silent.mp4", ["-f", "lavfi", "-i", pattern, "-t", "2", "-an", "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p"]);
  for (const language of ["ja", "ar"]) encode(`${language}.mp4`, [
    "-f", "lavfi", "-i", pattern, "-i", path.join(speech, `b_${language}.wav`),
    "-t", language === "ar" ? "29" : "35", ...videoArgs,
  ]);
  encode("ssd_clip.mp4", ["-i", path.join(directory, "de_90.mp4"), "-c", "copy"], true);
  encode("recording80.mp4", [
    "-stream_loop", "-1", "-i", path.join(os.tmpdir(), "artdaddy-e2e-fixtures", "long840_1080p30_g120.mp4"),
    "-stream_loop", "-1", "-i", path.join(speech, "b_es.wav"), "-t", "4800",
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart",
  ]);
  const measured = {};
  for (const file of Object.values(scenarios).flat()) {
    measured[file] = JSON.parse(run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", path.join(directory, file)]));
  }
  for (const rotation of [0, 90, 180, 270]) {
    const actual = measured[`de_${rotation}.mp4`].streams[0].side_data_list
      ?.find((entry) => entry.rotation !== undefined)?.rotation ?? 0;
    assert.equal((actual + 360) % 360, rotation, `missing display matrix for ${rotation}`);
  }
  writeFileSync(path.join(output, "fixtures.json"), JSON.stringify(measured, null, 2));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(measured).map(([name, value]) => [name, {
    duration: value.format.duration, width: value.streams[0].width, height: value.streams[0].height,
    rotation: value.streams[0].side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation ?? 0,
    audio: value.streams.some((stream) => stream.codec_type === "audio"),
  }])), null, 2));
  process.exit(0);
}
assert.ok(Object.hasOwn(scenarios, scenario), "scenario must be swiss, japanese, arabic, external or long");
const state = readState();

if (action === "status") {
  console.log(JSON.stringify(state[scenario], null, 2));
} else if (action === "artifact") {
  verifyDelivered(scenario, first ?? state[scenario]?.exportPath);
} else if (action === "pixels") {
  verifyCaptionPixels(scenario, first ?? state[scenario]?.exportPath);
} else if (action === "rotation") {
  verifySwissRotation(first, second, state);
} else {
  await connect();
  if (action === "setup") {
    assert.ok(first, "setup needs the fixture folder");
    for (const file of scenarios[scenario]) assert.ok(existsSync(path.join(first, file)), `missing ${file}`);
    const created = await call(scenario, "manage_project", { action: "create", name: `qa phase4 ${scenario}` });
    assert.ok(created.created && created.ready, JSON.stringify(created));
    state[scenario] = { projectId: created.created, media: {}, videoClipIds: [], nextFrame: 0 };
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    await call(scenario, "get_timeline", {});
    for (const file of scenarios[scenario]) {
      const imported = await call(scenario, "import_media", { source: { path: path.resolve(first, file) } });
      assert.ok(imported.media_ref, JSON.stringify(imported));
      state[scenario].media[file] = imported.media_ref;
      writeFileSync(statePath, JSON.stringify(state, null, 2));
      const added = await call(scenario, "add_clips", {
        entries: [{ media_ref: imported.media_ref, timeline_in: state[scenario].nextFrame }],
      });
      const changed = added.clips ?? added.changes?.clips ?? [];
      assert.ok(changed.length, `no placed clips in ${JSON.stringify(added)}`);
      for (const clip of changed) {
        if (clip.kind === "video") state[scenario].videoClipIds.push(clip.id);
        state[scenario].nextFrame = Math.max(state[scenario].nextFrame, clip.timeline_out ?? 0);
      }
      writeFileSync(statePath, JSON.stringify(state, null, 2));
    }
    console.log(`PROJECT ${created.created}`);
  } else if (action === "preview") {
    await call(scenario, "manage_project", { action: "open", id: state[scenario].projectId });
    await verifyPreview(scenario, first, second);
  } else if (action === "verify") {
    assert.ok(state[scenario]?.projectId, "run setup first");
    await call(scenario, "manage_project", { action: "open", id: state[scenario].projectId });
    const refs = Object.entries(state[scenario].media);
    if (scenario === "long") {
      const before = Date.now();
      const overview = await call(scenario, "inspect_media", { media_ref: refs[0][1], overview: true });
      assert.ok(overview.overview, JSON.stringify(overview).slice(0, 1000));
      assert.ok(Date.now() - before < 120_000, "an overview must not wait on an 80-minute transcript");
      const window = await call(scenario, "inspect_media", {
        media_ref: refs[0][1], start_seconds: 3600, end_seconds: 3620, max_frames: 1,
      });
      assert.ok(window.transcript, JSON.stringify(window).slice(0, 1000));
      const again = await call(scenario, "inspect_media", {
        media_ref: refs[0][1], start_seconds: 3600, end_seconds: 3620, max_frames: 1,
      });
      assert.deepEqual(again.transcript, window.transcript);
    } else {
      const language = scenario === "japanese" ? "ja" : scenario === "arabic" ? "ar" : "de";
      const inspected = await call(scenario, "inspect_media", { media_ref: refs[0][1], max_frames: 1 });
      assert.equal(inspected.transcript?.language, language, JSON.stringify(inspected.transcript));
      const segments = inspected.transcript?.segments ?? [];
      assert.ok(segments.length, "speech must produce words");
      const spoken = segments.map((segment) => Array.isArray(segment) ? segment[0] : segment.text).join(" ");
      const scripts = { de: /hören|Artikel|Wikipedia/u, ja: /[\u3040-\u30ff\u4e00-\u9fff]/u, ar: /[\u0600-\u06ff]/u };
      assert.match(spoken, scripts[language], "the transcript must contain words in the spoken language");
      const transcript = await call(scenario, "get_transcript", {});
      assert.ok(transcript, "the timeline transcript must answer");
      if (scenario === "japanese" || scenario === "arabic") {
        await call(scenario, "add_captions", {
          animation: { build: "word-by-word", timing: "transcript" },
        });
        const exported = await call(scenario, "export", {
          output_path: path.join(os.homedir(), "Downloads", `qa_phase4_${scenario}.mp4`),
          quality: "medium",
        });
        assert.ok(exported.job_id, JSON.stringify(exported));
        const page = await connectPage(await pageTarget());
        try {
          const ended = await evaluate(page, `(async () => {
            const url = performance.getEntriesByType('resource').map(e => e.name)
              .filter(n => new URL(n).pathname === '/src/timeline/exportQueue.ts').pop() ?? '/src/timeline/exportQueue.ts';
            const queue = await import(url);
            return await queue.whenExportEnds(${JSON.stringify(exported.job_id)});
          })()`);
          assert.equal(ended?.state, "done", JSON.stringify(ended));
          state[scenario].exportPath = ended.destPath;
          writeFileSync(statePath, JSON.stringify(state, null, 2));
          console.log(`DELIVERED ${ended.destPath}`);
          verifyDelivered(scenario, ended.destPath);
        } finally { page.close(); }
      }
    }
  } else if (action === "call") {
    assert.ok(state[scenario]?.projectId, "run setup first");
    await call(scenario, "manage_project", { action: "open", id: state[scenario].projectId });
    await call(scenario, first, second ? JSON.parse(readFileSync(second, "utf8")) : {});
  } else {
    throw new Error("usage: setup <scenario> <media-dir> | call <scenario> <tool> [args.json] | status <scenario>");
  }
}