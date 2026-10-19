import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { connect } from "../cdp.mjs";

const originalSocket = globalThis.WebSocket;
let socket;
let opens = true;

class Socket {
  constructor() {
    socket = this;
    if (opens) queueMicrotask(() => this.onopen?.());
  }
  send(value) {
    this.sent = JSON.parse(value);
  }
  close() {
    this.onclose?.();
  }
  reply(value) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

globalThis.WebSocket = Socket;
afterEach(() => {
  opens = true;
});
process.once("exit", () => {
  globalThis.WebSocket = originalSocket;
});

test("successful replies and events survive the shared connection", async () => {
  const events = [];
  const client = await connect("ws://test", (event) => events.push(event), 100);
  const reply = client.send("Runtime.evaluate");
  socket.reply({ method: "Runtime.consoleAPICalled" });
  socket.reply({ id: socket.sent.id, result: { value: 42 } });
  assert.deepEqual(await reply, { value: 42 });
  assert.equal(events.length, 1);
  client.close();
});

test("a browser closing mid-command rejects every waiter and future command", async () => {
  const client = await connect("ws://test", undefined, 100);
  const first = assert.rejects(client.send("Runtime.evaluate"), /closed/);
  const second = assert.rejects(client.send("Page.captureScreenshot"), /closed/);
  socket.close();
  await Promise.all([first, second]);
  await assert.rejects(client.send("Page.reload"), /closed/);
});

test("a transport error after open rejects the outstanding command", async () => {
  const client = await connect("ws://test", undefined, 100);
  const failure = assert.rejects(client.send("Runtime.evaluate"), /connection failed/);
  socket.onerror();
  await failure;
});

test("a silent browser has a bounded request deadline", async () => {
  const client = await connect("ws://test", undefined, 15);
  await assert.rejects(client.send("Runtime.evaluate"), /Runtime.evaluate timed out/);
  await assert.rejects(client.send("Page.reload"), /closed/);
});

test("a browser that never opens has a bounded connection deadline", async () => {
  opens = false;
  await assert.rejects(connect("ws://test", undefined, 15), /connection timed out/);
});

test("a connection closing before open is refused immediately", async () => {
  opens = false;
  const failure = assert.rejects(connect("ws://test", undefined, 100), /closed/);
  socket.close();
  await failure;
});

test("a malformed response rejects pending work instead of crashing the callback", async () => {
  const client = await connect("ws://test", undefined, 100);
  const failure = assert.rejects(client.send("Runtime.evaluate"), /malformed JSON/);
  socket.onmessage({ data: "{" });
  await failure;
});

test("a synchronous send failure rejects the command and retires the connection", async () => {
  const client = await connect("ws://test", undefined, 100);
  socket.send = () => {
    throw new Error("transport disappeared");
  };
  await assert.rejects(client.send("Runtime.evaluate"), /transport disappeared/);
  await assert.rejects(client.send("Page.reload"), /closed/);
});

test("server command errors reject only that command, not a healthy session", async () => {
  const client = await connect("ws://test", undefined, 100);
  const failure = assert.rejects(client.send("Bad.method"), /unknown method/);
  socket.reply({ id: socket.sent.id, error: { message: "unknown method" } });
  await failure;
  const success = client.send("Page.reload");
  socket.reply({ id: socket.sent.id, result: {} });
  assert.deepEqual(await success, {});
  client.close();
});
