//! Local MCP server, so an external agent (Claude Code, Cursor, Codex, Copilot) can drive the
//! editor's tools against the project the user has open.
//!
//! Rust owns ONLY the transport: an HTTP listener on loopback, JSON-RPC framing, and sessions.
//! It deliberately knows nothing about which tools exist — `tools/list` and `tools/call` are
//! forwarded to the webview, which already owns the contract and the tool registry. Any other
//! arrangement would make this a second (or third) definition of the tool surface, which is the
//! drift hazard the contract codegen exists to prevent.
//!
//! SECURITY: bound to 127.0.0.1 so it is never reachable from the LAN, and `Origin` is rejected
//! unless it is a loopback origin — without that check any web page the user visits could drive
//! their editor. There is no token (matching established desktop NLEs); the
//! defence for what an individual tool permits belongs inside that tool.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

pub const DEFAULT_PORT: u16 = 19787;
/// Negotiated per the MCP spec; echoed back to the client on initialize.
const PROTOCOL_VERSION: &str = "2025-06-18";
/// A tool call can legitimately take minutes (render, transcribe), but a wedged bridge must not
/// hold the connection forever.
const CALL_TIMEOUT: Duration = Duration::from_secs(600);

/// One in-flight request to the webview.
type Pending = Arc<Mutex<HashMap<u64, std::sync::mpsc::Sender<Value>>>>;

/// Longest a name or version is kept, in characters. A client names itself in one line; anything longer
/// is not a name.
const CLIENT_TEXT_MAX: usize = 64;

/// What a connecting program says about itself in `initialize` (`params.clientInfo`): the name and
/// version of a PROGRAM (Claude Code, Visual Studio Code, ...), never anything about the person. Kept
/// per session and carried with every request to the webview, so the app can say which program is
/// driving the editor.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ClientInfo {
  name: String,
  version: String,
}

impl ClientInfo {
  /// Read it out of an `initialize` request's params. Anything that is not a string is absent, and a
  /// long string is cut: a hostile client must not be able to push a megabyte through this.
  fn from_params(params: &Value) -> Self {
    let info = params.get("clientInfo");
    let text = |key: &str| -> String {
      info
        .and_then(|i| i.get(key))
        .and_then(Value::as_str)
        .map(|s| s.trim().chars().take(CLIENT_TEXT_MAX).collect())
        .unwrap_or_default()
    };
    Self { name: text("name"), version: text("version") }
  }

  fn to_json(&self) -> Value {
    json!({ "name": self.name, "version": self.version })
  }
}

#[derive(Clone)]
pub struct McpState {
  pending: Pending,
  /// JSON-RPC request id (as text) -> the bridge id running it, so `notifications/cancelled`
  /// can reach the actual work. Keyed by session too: two clients may both use id 1.
  in_flight: Arc<Mutex<HashMap<String, u64>>>,
  /// Each session and what its client said about itself when it connected.
  sessions: Arc<Mutex<HashMap<String, ClientInfo>>>,
  next_id: Arc<AtomicU64>,
  running: Arc<AtomicBool>,
  port: Arc<AtomicU64>,
  /// The instruction text the webview composes (shared system prompt + MCP-only sections).
  instructions: Arc<Mutex<Option<String>>>,
  /// Told when the accept thread has closed the listening socket (see `listen`). Present only while the server runs.
  accepting: Arc<Mutex<Option<std::sync::mpsc::Receiver<()>>>>,
}

impl Default for McpState {
  fn default() -> Self {
    Self {
      pending: Arc::new(Mutex::new(HashMap::new())),
      in_flight: Arc::new(Mutex::new(HashMap::new())),
      sessions: Arc::new(Mutex::new(HashMap::new())),
      next_id: Arc::new(AtomicU64::new(1)),
      running: Arc::new(AtomicBool::new(false)),
      port: Arc::new(AtomicU64::new(DEFAULT_PORT as u64)),
      instructions: Arc::new(Mutex::new(None)),
      accepting: Arc::new(Mutex::new(None)),
    }
  }
}

impl McpState {
  /// Everything a connection thread needs, minus the way to stop the listener, which only `mcp_stop` uses.
  fn inner_clone(&self) -> Self {
    Self {
      pending: self.pending.clone(),
      in_flight: self.in_flight.clone(),
      sessions: self.sessions.clone(),
      next_id: self.next_id.clone(),
      running: self.running.clone(),
      port: self.port.clone(),
      instructions: self.instructions.clone(),
      accepting: Arc::new(Mutex::new(None)),
    }
  }
}

/// Ask the webview to answer an MCP method. Blocks the connection thread until the webview
/// replies via `mcp_reply`, or the call times out. `cancel_key` (session + JSON-RPC id) lets a
/// later `notifications/cancelled` find and abort this exact call. `client` is who is asking, so
/// the app can tell which program is driving it.
fn ask_webview(
  app: &AppHandle,
  state: &McpState,
  method: &str,
  params: Value,
  cancel_key: Option<String>,
  client: &ClientInfo,
) -> Result<Value, String> {
  let id = state.next_id.fetch_add(1, Ordering::SeqCst);
  let (tx, rx) = std::sync::mpsc::channel::<Value>();
  state.pending.lock().map_err(|_| "bridge poisoned")?.insert(id, tx);
  if let Some(key) = cancel_key.clone() {
    state.in_flight.lock().map_err(|_| "bridge poisoned")?.insert(key, id);
  }

  app
    .emit(
      "artdaddy://mcp-request",
      json!({ "id": id, "method": method, "params": params, "client": client.to_json() }),
    )
    .map_err(|e| format!("emit failed: {e}"))?;

  let out = rx.recv_timeout(CALL_TIMEOUT);
  state.pending.lock().map_err(|_| "bridge poisoned")?.remove(&id);
  if let Some(key) = cancel_key {
    state.in_flight.lock().map_err(|_| "bridge poisoned")?.remove(&key);
  }
  match out {
    Ok(v) => bridge_payload(v),
    // The webview never answered: it is closing, reloading, or the tool wedged.
    Err(_) => Err("the editor did not respond (is a project open?)".into()),
  }
}

/// `__mcpError` is the webview saying the REQUEST failed, not that a tool ran and returned
/// ok:false. It belongs in JSON-RPC's error, which a client retries, rather than in a result it
/// would cache as this server's answer.
fn bridge_payload(v: Value) -> Result<Value, String> {
  match v.get("__mcpError").and_then(Value::as_str) {
    Some(msg) => Err(msg.to_string()),
    None => Ok(v),
  }
}

/// The webview's answer to one bridged request.
#[tauri::command]
pub fn mcp_reply(state: tauri::State<'_, McpState>, id: u64, payload: Value) {
  let sender = state.pending.lock().ok().and_then(|mut p| p.remove(&id));
  if let Some(tx) = sender {
    let _ = tx.send(payload);
  }
}

#[tauri::command]
pub fn mcp_status(state: tauri::State<'_, McpState>) -> Value {
  json!({
    "running": state.running.load(Ordering::SeqCst),
    "port": state.port.load(Ordering::SeqCst),
  })
}

/// The webview composes the instruction text (shared system prompt + MCP-only sections) and
/// hands it over, because `initialize` is answered here before any bridge round-trip exists.
#[tauri::command]
pub fn mcp_set_instructions(state: tauri::State<'_, McpState>, text: String) {
  if let Ok(mut slot) = state.instructions.lock() {
    *slot = Some(text);
  }
}

/// Only loopback origins may drive the editor. A missing Origin is a native client (curl, an
/// MCP CLI), which is fine; a present one must be localhost, which is what stops a random web
/// page in the user's browser from reaching the port.
///
/// The host must match EXACTLY. A `starts_with("http://127.0.0.1")` test accepts
/// `http://127.0.0.1.evil.com` — an attacker only has to own that subdomain.
fn origin_allowed(origin: Option<&str>) -> bool {
  let Some(origin) = origin else { return true };
  let origin = origin.trim();
  if origin == "null" {
    return true;
  }
  let rest = match origin.split_once("://") {
    Some(("http", rest)) | Some(("https", rest)) => rest,
    _ => return false,
  };
  // Strip the port/path, keeping `[::1]` intact.
  let host = if let Some(stripped) = rest.strip_prefix('[') {
    match stripped.split_once(']') {
      Some((inner, tail)) => {
        if !(tail.is_empty() || tail.starts_with(':') || tail.starts_with('/')) {
          return false;
        }
        return inner == "::1";
      }
      None => return false,
    }
  } else {
    rest.split(['/', ':']).next().unwrap_or("")
  };
  host == "127.0.0.1" || host == "localhost"
}

/// What we call ourselves over MCP. Users paste this into their Claude/Cursor config, so it is
/// user-visible and `brand.drift.test.ts` checks this exact literal against brand.json.
const SERVER_NAME: &str = "artdaddy";

fn server_info(state: &McpState) -> Value {
  let instructions = state
    .instructions
    .lock()
    .ok()
    .and_then(|s| s.clone())
    .unwrap_or_else(|| FALLBACK_INSTRUCTIONS.to_string());
  json!({
    "protocolVersion": PROTOCOL_VERSION,
    "capabilities": { "tools": { "listChanged": true } },
    "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
    "instructions": instructions
  })
}

/// Used only until the webview supplies the real prompt (offline, or before it has loaded).
const FALLBACK_INSTRUCTIONS: &str = "ArtDaddy is a video editor. These tools act on the project \
currently open in the ArtDaddy window. A session may start with no project open — call \
manage_project with action='list' then action='open' before reading or editing a timeline. Clip \
and timeline times are PROJECT FRAMES at the canvas fps; raw source media times are SECONDS.";

/// Two clients may each call their request "1", so a cancellation must be scoped to its session.
fn cancel_key_for(session: &str, id: &Value) -> String {
  format!("{session}|{id}")
}

fn cancel_request(app: &AppHandle, state: &McpState, session: &str, request_id: &Value) {
  let key = cancel_key_for(session, request_id);
  let bridge_id = state.in_flight.lock().ok().and_then(|m| m.get(&key).copied());
  let Some(bridge_id) = bridge_id else { return };
  // Tell the webview to abort the tool, then unblock the waiting connection thread.
  let _ = app.emit("artdaddy://mcp-cancel", json!({ "id": bridge_id }));
  let sender = state.pending.lock().ok().and_then(|mut p| p.remove(&bridge_id));
  if let Some(tx) = sender {
    let _ = tx.send(json!({
      "content": [{ "type": "text", "text": "cancelled by the client" }],
      "isError": true
    }));
  }
}

/// Remember what a session's client said about itself. Re-sent on a repeat `initialize` (a client may
/// connect again on the same session), and the newest wins.
fn remember_client(state: &McpState, session: &str, params: &Value) -> ClientInfo {
  let info = ClientInfo::from_params(params);
  if let Ok(mut sessions) = state.sessions.lock() {
    sessions.insert(session.to_string(), info.clone());
  }
  info
}

/// Who a session's client said it was; empty for a session that never said (or never initialised).
fn client_of(state: &McpState, session: &str) -> ClientInfo {
  state
    .sessions
    .lock()
    .ok()
    .and_then(|sessions| sessions.get(session).cloned())
    .unwrap_or_default()
}

/// Dispatch one JSON-RPC request. `initialize`/`ping` are answered here; anything about tools is
/// the webview's business. Returns None for notifications, which must never be answered.
fn handle_rpc(app: &AppHandle, state: &McpState, req: &Value, session: &str) -> Option<Value> {
  let id = req.get("id").cloned();
  let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
  let params = req.get("params").cloned().unwrap_or(json!({}));

  if id.is_none() {
    // The client's Stop button. Abort the in-flight call rather than letting a render carry on
    // after the user gave up on it.
    if method == "notifications/cancelled" {
      if let Some(rid) = params.get("requestId") {
        cancel_request(app, state, session, rid);
      }
    }
    return None;
  }

  let cancel_key = id.as_ref().map(|i| cancel_key_for(session, i));
  let result = match method {
    "initialize" => {
      // A program has connected: say which, so the app can record it (and which one is behind the
      // calls that follow).
      let client = remember_client(state, session, &params);
      let _ = app.emit(
        "artdaddy://mcp-session",
        json!({ "session": session, "client": client.to_json() }),
      );
      Ok(server_info(state))
    }
    "ping" => Ok(json!({})),
    "tools/list" | "tools/call" => {
      let client = client_of(state, session);
      ask_webview(app, state, method, params, cancel_key, &client)
    }
    "resources/list" => Ok(json!({ "resources": [] })),
    "prompts/list" => Ok(json!({ "prompts": [] })),
    _ => Err(format!("method not found: {method}")),
  };

  Some(match result {
    Ok(v) => json!({ "jsonrpc": "2.0", "id": id, "result": v }),
    Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": e } }),
  })
}

struct Request {
  method: String,
  path: String,
  headers: HashMap<String, String>,
  body: String,
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
  // Read through a borrow: a `try_clone` here would be one more duplicate of the connection that a child process could inherit.
  let mut reader = BufReader::new(&*stream);
  let mut line = String::new();
  reader.read_line(&mut line).ok()?;
  let mut parts = line.split_whitespace();
  let method = parts.next()?.to_string();
  let path = parts.next()?.split('?').next()?.to_string();

  let mut headers = HashMap::new();
  loop {
    let mut h = String::new();
    if reader.read_line(&mut h).ok()? == 0 {
      break;
    }
    let h = h.trim_end();
    if h.is_empty() {
      break;
    }
    if let Some((k, v)) = h.split_once(':') {
      headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
    }
  }

  let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
  let mut body = vec![0u8; len];
  if len > 0 {
    reader.read_exact(&mut body).ok()?;
  }
  Some(Request { method, path, headers, body: String::from_utf8_lossy(&body).to_string() })
}

/// The bytes of one HTTP reply. One builder, so what the probe in `probe_holder` recognises is exactly what `serve` writes.
fn http_reply(status: u16, reason: &str, extra: &[(&str, &str)], body: &str) -> String {
  let mut reply = format!("HTTP/1.1 {status} {reason}\r\n");
  reply.push_str("Content-Type: application/json\r\n");
  for (k, v) in extra {
    reply.push_str(&format!("{k}: {v}\r\n"));
  }
  reply.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", body.len()));
  reply.push_str(body);
  reply
}

fn send(stream: &mut TcpStream, reply: &str) {
  let _ = stream.write_all(reply.as_bytes());
  let _ = stream.flush();
}

fn respond(stream: &mut TcpStream, status: u16, reason: &str, extra: &[(&str, &str)], body: &str) {
  send(stream, &http_reply(status, reason, extra, body));
}

/// The reply to a GET, which this server declines because it pushes nothing. `probe_holder` recognises another copy of the
/// app by exactly this, so `serve` and the probe's test both take it from here.
fn event_stream_declined() -> String {
  http_reply(405, "Method Not Allowed", &[], NO_EVENT_STREAM_BODY)
}

fn serve(mut stream: TcpStream, app: AppHandle, state: McpState) {
  let req = match read_request(&mut stream) {
    Some(r) => r,
    None => return,
  };

  if !origin_allowed(req.headers.get("origin").map(|s| s.as_str())) {
    respond(&mut stream, 403, "Forbidden", &[], r#"{"error":"origin not allowed"}"#);
    return;
  }
  if req.path != "/mcp" && req.path != "/" {
    respond(&mut stream, 404, "Not Found", &[], r#"{"error":"not found"}"#);
    return;
  }
  // The optional server->client stream. Nothing is pushed today, so decline rather than hold
  // the socket open: clients treat this as "no server-initiated messages" and carry on.
  if req.method == "GET" {
    send(&mut stream, &event_stream_declined());
    return;
  }
  if req.method == "DELETE" {
    if let Some(s) = req.headers.get("mcp-session-id") {
      if let Ok(mut m) = state.sessions.lock() {
        m.remove(s);
      }
    }
    respond(&mut stream, 200, "OK", &[], "{}");
    return;
  }
  if req.method != "POST" {
    respond(&mut stream, 405, "Method Not Allowed", &[], r#"{"error":"use POST"}"#);
    return;
  }

  let parsed: Value = match serde_json::from_str(&req.body) {
    Ok(v) => v,
    Err(e) => {
      let body = json!({ "jsonrpc": "2.0", "id": Value::Null,
        "error": { "code": -32700, "message": format!("parse error: {e}") } });
      respond(&mut stream, 400, "Bad Request", &[], &body.to_string());
      return;
    }
  };

  // A batch is an array; a single call is an object. Both are legal JSON-RPC.
  // Each client gets its OWN session id: a shared constant makes two clients' request ids
  // collide, so one client's Stop would cancel the other's render.
  let claimed = req.headers.get("mcp-session-id").cloned();
  let is_init = matches!(&parsed, Value::Object(o) if o.get("method").and_then(|m| m.as_str()) == Some("initialize"));
  let session_id = match claimed {
    Some(s) if state.sessions.lock().map(|m| m.contains_key(&s)).unwrap_or(false) => s,
    _ if is_init => {
      let fresh = format!("artdaddy-{}", state.next_id.fetch_add(1, Ordering::SeqCst));
      if let Ok(mut m) = state.sessions.lock() {
        m.insert(fresh.clone(), ClientInfo::default());
      }
      fresh
    }
    // An unknown session on a non-initialize call: accept it rather than 404, so a client that
    // reconnects after an app restart keeps working instead of silently losing its tools.
    Some(s) => s,
    None => "artdaddy-0".to_string(),
  };

  let responses: Vec<Value> = match &parsed {
    Value::Array(items) => items
      .iter()
      .filter_map(|r| handle_rpc(&app, &state, r, &session_id))
      .collect(),
    single => handle_rpc(&app, &state, single, &session_id).into_iter().collect(),
  };

  let session = ("Mcp-Session-Id", session_id.as_str());
  if responses.is_empty() {
    // Notification-only payload: 202 with no body, per spec.
    respond(&mut stream, 202, "Accepted", &[session], "");
    return;
  }
  let body = if parsed.is_array() {
    Value::Array(responses).to_string()
  } else {
    responses[0].to_string()
  };
  respond(&mut stream, 200, "OK", &[session], &body);
}

/// Drive an accept loop, handing each accepted connection to `on_stream`.
///
/// An `Err` item is a PER-CONNECTION failure — a client that reset between connect and accept, a
/// momentary descriptor/buffer limit — and must NOT end the server. Ending on it silently retired
/// the whole external-agent surface for the rest of the session while `running` still reported
/// true, so nothing could tell the user their agent had stopped working. A deliberate stop is the
/// only exit: it clears `running` before unblocking the accept.
///
/// Generic over the item so the policy is testable without a real socket.
fn accept_loop<T, I, F>(streams: I, running: &AtomicBool, mut on_stream: F)
where
  I: IntoIterator<Item = std::io::Result<T>>,
  F: FnMut(T),
{
  for item in streams {
    if !running.load(Ordering::SeqCst) {
      break;
    }
    match item {
      Ok(s) => on_stream(s),
      Err(_) => {
        if !running.load(Ordering::SeqCst) {
          break;
        }
        // Don't spin hot if the condition persists.
        std::thread::sleep(std::time::Duration::from_millis(50));
      }
    }
  }
}

/// What a GET on `/mcp` is answered with: this server pushes nothing, so it declines. It is also how ANOTHER copy of
/// ArtDaddy is recognised when the port is taken (`probe_holder`), so there is exactly one spelling of it.
const NO_EVENT_STREAM_BODY: &str = r#"{"error":"no event stream"}"#;

/// Bind the loopback port and accept on a thread that is the socket's ONLY owner. Returns the channel that says the socket has
/// been closed.
///
/// There is deliberately no second handle kept somewhere else to close it with. `try_clone` hands back a handle that a child
/// process inherits (measured: a listener cloned this way stays open after every handle in this process is closed, for as long as
/// a child started in between lives), and the old design cloned it for the accept thread. A transcription child lives for minutes,
/// so switching the server off and on again, and relaunching the app, found the port "in use" until it finished. The listener that
/// `bind` creates, and a connection it accepts, are not inherited; the clone is. Stopping is simply this thread ending.
fn listen(
  port: u16,
  running: &Arc<AtomicBool>,
  mut on_stream: impl FnMut(TcpStream) + Send + 'static,
) -> std::io::Result<std::sync::mpsc::Receiver<()>> {
  let listener = TcpListener::bind(("127.0.0.1", port))?;
  // Before the thread exists: its first look at the flag must already say "running".
  running.store(true, Ordering::SeqCst);
  let (closed_tx, closed_rx) = std::sync::mpsc::channel();
  let running = running.clone();
  std::thread::spawn(move || {
    accept_loop(listener.incoming(), &running, |stream| on_stream(stream));
    // The socket is closed HERE, and only then is anyone told: `stop_listening` returns after this, so a start that follows it
    // finds the port free.
    drop(listener);
    let _ = closed_tx.send(());
  });
  Ok(closed_rx)
}

/// Switch the listener off: clear the flag, wake the accept loop with one connection to itself (it is blocked in `accept`), and
/// wait until the socket is really closed. Nothing is woken when nothing was listening, so a port held by someone else is never
/// poked.
fn stop_listening(running: &AtomicBool, port: u16, closed: Option<std::sync::mpsc::Receiver<()>>) {
  running.store(false, Ordering::SeqCst);
  let Some(closed) = closed else { return };
  let _ = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(500));
  if closed.recv_timeout(Duration::from_secs(2)).is_err() {
    log::warn!("[mcp] the listening socket was not closed within 2 s of the stop");
  }
}

/// How long to wait on whatever holds the port: a person is reading the message this is for.
const PROBE_TIMEOUT: Duration = Duration::from_millis(800);

/// Who is answering on the port ArtDaddy could not bind.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Holder {
  /// Another copy of this app: a second window, or another Windows user's session (loopback ports are machine-wide).
  ArtDaddy,
  /// Some other program.
  Other,
  /// Nothing answers: it was let go a moment ago.
  Nobody,
}

impl Holder {
  fn word(self) -> &'static str {
    match self {
      Holder::ArtDaddy => "artdaddy",
      Holder::Other => "other",
      Holder::Nobody => "none",
    }
  }
}

/// Is this reply the one our own server writes to a GET? Compared with the whole reply it is built from (`http_reply`),
/// so a rewording of that reply cannot quietly turn every other ArtDaddy into "another program".
fn holder_from_response(text: &str) -> Holder {
  if text.starts_with("HTTP/1.1 405") && text.contains(NO_EVENT_STREAM_BODY) {
    Holder::ArtDaddy
  } else {
    Holder::Other
  }
}

/// Ask whatever is on 127.0.0.1:`port` who it is, with a request that changes nothing anywhere (a GET, which this server
/// declines; an `initialize` would register a client in the other copy and be recorded there as one).
fn probe_holder(port: u16) -> Holder {
  let addr = SocketAddr::from(([127, 0, 0, 1], port));
  let Ok(mut stream) = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT) else { return Holder::Nobody };
  let _ = stream.set_read_timeout(Some(PROBE_TIMEOUT));
  let _ = stream.set_write_timeout(Some(PROBE_TIMEOUT));
  let request = format!("GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
  if stream.write_all(request.as_bytes()).is_err() {
    return Holder::Other;
  }
  let mut reply = Vec::new();
  // A timeout after some bytes keeps those bytes; a holder that never answers leaves nothing, which is "another program".
  let _ = (&mut stream).take(2048).read_to_end(&mut reply);
  holder_from_response(&String::from_utf8_lossy(&reply))
}

/// The process id of whatever LISTENS on `port`, from `netstat -ano -p tcp`. A listener is the row whose foreign address
/// ends in `:0`: the state column is translated into the user's language, that one is not.
fn pid_listening_on(netstat: &str, port: u16) -> Option<u32> {
  let suffix = format!(":{port}");
  netstat.lines().find_map(|line| {
    let cols: Vec<&str> = line.split_whitespace().collect();
    if cols.len() < 5 || !cols[0].eq_ignore_ascii_case("TCP") {
      return None;
    }
    if !cols[1].ends_with(&suffix) || !cols[2].ends_with(":0") {
      return None;
    }
    cols[4].parse().ok()
  })
}

/// The program's file name (never its folder) from `tasklist /FO CSV /NH`, whose rows start with a quote. The message
/// "No tasks are running" does not, and is translated.
fn image_name(tasklist_csv: &str) -> Option<String> {
  let line = tasklist_csv.lines().find(|l| l.starts_with('"'))?;
  let name = line.trim_start_matches('"').split('"').next()?;
  let clean: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || " ._-()".contains(*c)).take(64).collect();
  (!clean.is_empty()).then_some(clean)
}

/// The name of the program that listens on `port`, where the system will say. Best effort: the answer is only read by the
/// person looking at a message, so no answer costs nothing.
#[cfg(windows)]
fn listener_process(port: u16) -> Option<String> {
  use std::os::windows::process::CommandExt;
  use std::process::Command;
  const CREATE_NO_WINDOW: u32 = 0x0800_0000;
  // From System32 by full path, so nothing earlier on PATH can stand in for either tool.
  let system32 = std::path::PathBuf::from(std::env::var_os("SystemRoot")?).join("System32");
  let run = |exe: &str, args: &[&str]| -> Option<String> {
    let out = Command::new(system32.join(exe)).args(args).creation_flags(CREATE_NO_WINDOW).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
  };
  let pid = pid_listening_on(&run("netstat.exe", &["-ano", "-p", "tcp"])?, port)?;
  image_name(&run("tasklist.exe", &["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])?)
}

#[cfg(not(windows))]
fn listener_process(_port: u16) -> Option<String> {
  None
}

fn holder_report(port: u16) -> Value {
  let holder = probe_holder(port);
  let process = if holder == Holder::Nobody { None } else { listener_process(port) };
  match process {
    Some(name) => json!({ "holder": holder.word(), "process": name }),
    None => json!({ "holder": holder.word() }),
  }
}

/// Who holds `port` (default: ours), for the message shown when the server could not start. Off the main thread: it waits
/// on a socket and, on Windows, on two system tools.
#[tauri::command]
pub async fn mcp_port_holder(port: Option<u16>) -> Result<Value, String> {
  let port = port.unwrap_or(DEFAULT_PORT);
  tauri::async_runtime::spawn_blocking(move || holder_report(port)).await.map_err(|error| error.to_string())
}

/// Start the listener. Idempotent: a second call while running is a no-op.
#[tauri::command]
pub fn mcp_start(app: AppHandle, state: tauri::State<'_, McpState>, port: Option<u16>) -> Result<Value, String> {
  if state.running.load(Ordering::SeqCst) {
    return Ok(mcp_status(state));
  }
  let port = port.unwrap_or(DEFAULT_PORT);
  let handler = state.inner_clone();
  // 127.0.0.1 (not 0.0.0.0) so the editor is never drivable from the network.
  let closed = listen(port, &state.running, move |stream| {
    let (a, st) = (app.clone(), handler.clone());
    std::thread::spawn(move || serve(stream, a, st));
  })
  .map_err(|e| {
    log::error!("[mcp] could not bind 127.0.0.1:{port}: {e}");
    format!("could not bind 127.0.0.1:{port}: {e}")
  })?;
  log::info!("[mcp] listening on 127.0.0.1:{port}");
  state.port.store(port as u64, Ordering::SeqCst);
  if let Ok(mut slot) = state.accepting.lock() {
    *slot = Some(closed);
  }
  Ok(json!({ "running": true, "port": port }))
}

#[tauri::command]
pub fn mcp_stop(state: tauri::State<'_, McpState>) -> Value {
  let port = state.port.load(Ordering::SeqCst) as u16;
  let closed = state.accepting.lock().ok().and_then(|mut slot| slot.take());
  stop_listening(&state.running, port, closed);
  if let Ok(mut m) = state.sessions.lock() {
    m.clear();
  }
  json!({ "running": false, "port": port })
}

pub fn init(app: &AppHandle) {
  app.manage(McpState::default());
}

#[cfg(test)]
mod tests {
  use super::*;

  fn io_err() -> std::io::Result<u32> {
    Err(std::io::Error::new(std::io::ErrorKind::ConnectionAborted, "reset before accept"))
  }

  #[test]
  fn a_failed_accept_does_not_retire_the_server() {
    // Found by a QA sweep: one transient accept error used to `break`, killing the whole
    // external-agent surface for the rest of the session while `running` still reported true —
    // so Claude Desktop simply stopped working with nothing in the app to say why. The rule is
    // that a per-connection failure costs that ONE connection and nothing else.
    let running = AtomicBool::new(true);
    let mut served = Vec::new();
    accept_loop(vec![Ok(1), io_err(), Ok(2), io_err(), Ok(3)], &running, |s| served.push(s));
    assert_eq!(served, vec![1, 2, 3], "connections after a failed accept must still be served");
  }

  #[test]
  fn a_deliberate_stop_ends_the_loop() {
    // The opposite direction, so the fix above cannot become "never stops": `stop` clears
    // `running` and then unblocks the accept, and that must actually end the thread rather than
    // spin forever on a dropped socket.
    let running = AtomicBool::new(false);
    let mut served = Vec::new();
    accept_loop(vec![Ok(1), io_err(), Ok(2)], &running, |s| served.push(s));
    assert!(served.is_empty(), "nothing may be served once the server is stopped");

    // And a stop DURING the loop takes effect on the next item.
    let running = AtomicBool::new(true);
    let mut served = Vec::new();
    accept_loop(vec![Ok(1), Ok(2), Ok(3)], &running, |s| {
      served.push(s);
      running.store(false, Ordering::SeqCst);
    });
    assert_eq!(served, vec![1], "the loop must notice a stop between connections");
  }

  #[test]
  fn bridge_error_marker_becomes_a_protocol_error_not_a_result() {
    // A catalog the app could not load must not be answered as an empty-but-valid tool list:
    // clients cache tools/list, and a cached empty surface never recovers.
    let err = bridge_payload(json!({ "__mcpError": "no catalog" }));
    assert_eq!(err, Err("no catalog".to_string()));

    // A tool that RAN and failed is a normal result — isError lives in the payload, and turning
    // it into a protocol error would tell the client the server itself is broken.
    let ran = json!({ "content": [{ "type": "text", "text": "ok:false" }], "isError": true });
    assert_eq!(bridge_payload(ran.clone()), Ok(ran));

    // A tool result that merely mentions the marker as data is still a result.
    let listed = json!({ "tools": [{ "name": "__mcpError" }] });
    assert_eq!(bridge_payload(listed.clone()), Ok(listed));
  }

  #[test]
  fn origin_must_be_loopback_or_absent() {
    // A native MCP client sends no Origin at all.
    assert!(origin_allowed(None));
    assert!(origin_allowed(Some("http://127.0.0.1:19787")));
    assert!(origin_allowed(Some("http://localhost:3000")));
    assert!(origin_allowed(Some("http://localhost")));
    assert!(origin_allowed(Some("http://[::1]:19787")));
    assert!(origin_allowed(Some("null")));
    // The whole point: a web page must not be able to drive the editor.
    assert!(!origin_allowed(Some("https://evil.example.com")));
    // Prefix matching would accept every one of these.
    assert!(!origin_allowed(Some("http://127.0.0.1.evil.com")));
    assert!(!origin_allowed(Some("http://localhost.evil.com")));
    assert!(!origin_allowed(Some("http://127.0.0.1evil.com")));
    assert!(!origin_allowed(Some("http://[::1].evil.com")));
    assert!(!origin_allowed(Some("file://")));
  }

  #[test]
  fn notifications_get_no_response() {
    // No id => a notification. Answering one is a protocol violation.
    let req = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    assert!(req.get("id").is_none());
  }

  #[test]
  fn initialize_advertises_tools_and_protocol() {
    let state = McpState::default();
    let info = server_info(&state);
    assert_eq!(info["protocolVersion"], PROTOCOL_VERSION);
    assert!(info["capabilities"]["tools"].is_object());
    assert_eq!(info["serverInfo"]["name"], SERVER_NAME);
    // Pin it to something a rename actually moves. Spelling the name out a second time is how
    // this assertion went on claiming "akaru" long after the server said otherwise.
    assert_eq!(SERVER_NAME, env!("CARGO_PKG_NAME"));
  }

  #[test]
  fn instructions_come_from_the_webview_once_it_supplies_them() {
    // Before the webview loads the shared system prompt there is still something useful to say;
    // afterwards the real prompt must win, or external agents run under different rules than
    // the in-app agent.
    let state = McpState::default();
    assert_eq!(server_info(&state)["instructions"], FALLBACK_INSTRUCTIONS);
    *state.instructions.lock().unwrap() = Some("SHARED PROMPT".into());
    assert_eq!(server_info(&state)["instructions"], "SHARED PROMPT");
  }

  #[test]
  fn a_cancellation_is_scoped_to_its_session() {
    // Two clients each number their first request "1". Keying the in-flight map on the id alone
    // means one client's Stop aborts the other client's render.
    let a = cancel_key_for("artdaddy-1", &json!(1));
    let b = cancel_key_for("artdaddy-2", &json!(1));
    assert_ne!(a, b);
    assert_eq!(a, cancel_key_for("artdaddy-1", &json!(1)));
    // String and numeric ids are both legal JSON-RPC and must not collide either.
    assert_ne!(cancel_key_for("s", &json!(1)), cancel_key_for("s", &json!("1")));
  }

  #[test]
  fn cancelling_an_unknown_request_is_a_no_op() {
    // A client may cancel a request that already finished; that must not panic or block.
    let state = McpState::default();
    let key = cancel_key_for("nobody", &json!(99));
    assert!(state.in_flight.lock().unwrap().get(&key).is_none());
  }

  #[test]
  fn a_client_is_remembered_by_what_it_said_when_it_connected() {
    let state = McpState::default();
    let said = json!({
      "protocolVersion": "2025-06-18",
      "clientInfo": { "name": "claude-code", "version": "2.1.0" }
    });
    let info = remember_client(&state, "artdaddy-1", &said);
    assert_eq!(info, ClientInfo { name: "claude-code".into(), version: "2.1.0".into() });
    assert_eq!(client_of(&state, "artdaddy-1"), info);
    // Another session is its own client: two programs connected at once are never confused.
    remember_client(&state, "artdaddy-2", &json!({ "clientInfo": { "name": "codex" } }));
    assert_eq!(client_of(&state, "artdaddy-1").name, "claude-code");
    assert_eq!(client_of(&state, "artdaddy-2").name, "codex");
    assert_eq!(client_of(&state, "artdaddy-2").version, "");
    // A session that never said anything is empty, not an error.
    assert_eq!(client_of(&state, "artdaddy-9"), ClientInfo::default());
  }

  #[test]
  fn a_client_that_says_nothing_usable_is_empty_not_an_error() {
    for params in [
      json!({}),
      json!(null),
      json!({ "clientInfo": null }),
      json!({ "clientInfo": "claude" }),
      json!({ "clientInfo": { "name": 7, "version": ["x"] } }),
    ] {
      assert_eq!(ClientInfo::from_params(&params), ClientInfo::default(), "{params}");
    }
  }

  #[test]
  fn a_long_name_is_cut_on_characters_never_stored_whole() {
    let long = "x".repeat(10_000);
    let info = ClientInfo::from_params(&json!({ "clientInfo": { "name": long, "version": long } }));
    assert_eq!(info.name.chars().count(), CLIENT_TEXT_MAX);
    assert_eq!(info.version.chars().count(), CLIENT_TEXT_MAX);
    // A multi-byte name is cut between characters; cutting between bytes would panic.
    let wide = "é".repeat(200);
    let info = ClientInfo::from_params(&json!({ "clientInfo": { "name": wide } }));
    assert_eq!(info.name.chars().count(), CLIENT_TEXT_MAX);
  }

  #[test]
  fn a_second_initialize_on_a_session_replaces_what_the_first_said() {
    let state = McpState::default();
    remember_client(&state, "artdaddy-1", &json!({ "clientInfo": { "name": "old", "version": "1" } }));
    remember_client(&state, "artdaddy-1", &json!({ "clientInfo": { "name": "new", "version": "2" } }));
    assert_eq!(client_of(&state, "artdaddy-1"), ClientInfo { name: "new".into(), version: "2".into() });
  }

  #[test]
  fn the_client_reaches_the_webview_as_a_name_and_a_version_and_nothing_else() {
    let info = ClientInfo { name: "claude-code".into(), version: "2.1.0".into() };
    assert_eq!(info.to_json(), json!({ "name": "claude-code", "version": "2.1.0" }));
    assert_eq!(ClientInfo::default().to_json(), json!({ "name": "", "version": "" }));
  }

  // Who holds a port ArtDaddy could not bind. The probe has to tell another copy of this app from anything else by what this
  // server really writes, on a real socket, because a wrong answer sends a person to close the wrong thing.

  fn answer_once(reply: &'static str, hold_open: bool) -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
      if let Ok((mut stream, _)) = listener.accept() {
        let mut seen = [0u8; 512];
        let _ = stream.read(&mut seen);
        let _ = stream.write_all(reply.as_bytes());
        if hold_open {
          std::thread::sleep(Duration::from_secs(3));
        }
      }
    });
    port
  }

  #[test]
  fn another_copy_of_this_app_is_recognised_by_the_reply_this_server_really_writes() {
    // The reply `serve` writes to a GET, from the one function both use.
    assert_eq!(holder_from_response(&event_stream_declined()), Holder::ArtDaddy);
    // The reply it writes to anything that is not a GET is not the signature, and neither is anyone else's.
    assert_eq!(holder_from_response(&http_reply(200, "OK", &[], "{}")), Holder::Other);
    assert_eq!(holder_from_response(&http_reply(405, "Method Not Allowed", &[], "{}")), Holder::Other);
    assert_eq!(holder_from_response("HTTP/1.1 404 Not Found\r\n\r\nnope"), Holder::Other);
    assert_eq!(holder_from_response(""), Holder::Other);
  }

  #[test]
  fn the_probe_finds_a_copy_of_this_app_another_program_nobody_and_a_holder_that_never_answers() {
    let ours: &'static str = Box::leak(event_stream_declined().into_boxed_str());
    assert_eq!(probe_holder(answer_once(ours, false)), Holder::ArtDaddy);
    assert_eq!(probe_holder(answer_once("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi", false)), Holder::Other);
    // Accepted but silent: a program that holds the port and says nothing is still another program, and the probe gives up.
    let started = std::time::Instant::now();
    assert_eq!(probe_holder(answer_once("", true)), Holder::Other);
    assert!(started.elapsed() < Duration::from_secs(3), "the probe must not wait on a silent holder");
    // Nothing listening: a port that was bound a moment ago and let go.
    let free = TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
    assert_eq!(probe_holder(free), Holder::Nobody);
  }

  const NETSTAT: &str = "
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1180
  TCP    127.0.0.1:19787        0.0.0.0:0              ABHÖREN         4321
  TCP    127.0.0.1:19787        127.0.0.1:50321        ESTABLISHED     4321
  TCP    127.0.0.1:50321        127.0.0.1:19787        ESTABLISHED     9876
  TCP    127.0.0.1:119787       0.0.0.0:0              LISTENING       5555
  TCP    [::]:8080              [::]:0                 LISTENING       7777
  UDP    0.0.0.0:19787          *:*                                    6666
";

  #[test]
  fn the_listener_is_the_row_with_no_peer_whatever_language_the_state_is_in() {
    assert_eq!(pid_listening_on(NETSTAT, 19787), Some(4321));
    // IPv6, and a longer port that merely ends in the same digits.
    assert_eq!(pid_listening_on(NETSTAT, 8080), Some(7777));
    assert_eq!(pid_listening_on(NETSTAT, 9787), None);
    // A connection TO the port, or a UDP socket on it, is not what holds it. The first row is a connection the listener
    // accepted (local side is the port): only its peer address, not a port, tells it from the listener itself.
    assert_eq!(pid_listening_on("  TCP  127.0.0.1:19787  127.0.0.1:50321  ESTABLISHED  4321", 19787), None);
    assert_eq!(pid_listening_on("  TCP  127.0.0.1:50321  127.0.0.1:19787  ESTABLISHED  9876", 19787), None);
    assert_eq!(pid_listening_on("  UDP    0.0.0.0:19787          *:*                                    6666", 19787), None);
    assert_eq!(pid_listening_on("", 19787), None);
    assert_eq!(pid_listening_on("garbage\nTCP only three", 19787), None);
  }

  // The system's own tools, on this machine, not text a person imagined: a parser that only agrees with its author's fixture
  // finds nothing here. This process listens on a port and nobody accepts, so the probe hears silence.
  #[cfg(windows)]
  #[test]
  fn the_real_system_tools_name_this_very_program_as_the_holder_of_a_port_it_listens_on() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let me = std::env::current_exe().unwrap().file_name().unwrap().to_string_lossy().into_owned();
    assert_eq!(listener_process(port).as_deref(), Some(me.as_str()));
    let report = holder_report(port);
    assert_eq!(report["holder"], "other");
    assert_eq!(report["process"], me.as_str());
    drop(listener);
    // Let go, nothing is named and nobody answers.
    let report = holder_report(port);
    assert_eq!(report["holder"], "none");
    assert!(report.get("process").is_none());
  }

  #[test]
  fn the_program_is_named_by_its_file_and_never_by_where_it_lives() {
    assert_eq!(image_name("\"node.exe\",\"4321\",\"Console\",\"1\",\"52,344 K\"\r\n").as_deref(), Some("node.exe"));
    assert_eq!(image_name("INFO: No tasks are running which match the specified criteria.").as_deref(), None);
    assert_eq!(image_name("").as_deref(), None);
    // Only the characters a file name is made of survive, cut short: nothing else can ride into a message.
    let odd = format!("\"{}<script>.exe\",\"1\"", "a".repeat(100));
    let name = image_name(&odd).unwrap();
    assert!(name.chars().count() <= 64);
    assert!(!name.contains('<') && !name.contains('>'));
  }

  // A sidecar (speech recognition, ffmpeg, ...) is started while the server runs and lives on for minutes. It must never be what keeps
  // the port bound: with a cloned listener it did, and switching the server off and on again, or relaunching the app, then found the
  // port "in use" until the sidecar finished. These start a real child process the way a sidecar is started.

  fn accepting(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300)).is_ok()
  }

  // A port for a test to listen on. NOT one the system picks (`bind` on port 0): the moment a test frees it, another test that binds
  // port 0 can be handed the same number, and "nothing answers on it any more" was then read off that other test's listener (seen
  // once on macOS, where these tests share the last second of the run with four others that churn ports). These come from a range
  // the system never hands out for port 0, one per call, so no two tests share one and no connection's own source port is one.
  fn scratch_port() -> u16 {
    use std::sync::atomic::AtomicU16;
    const FIRST: u16 = 21_000;
    const SPAN: u16 = 8_000;
    static NEXT: AtomicU16 = AtomicU16::new(0);
    let start = (std::process::id() % u32::from(SPAN)) as u16;
    for _ in 0..SPAN {
      let port = FIRST + (start + NEXT.fetch_add(1, Ordering::SeqCst)) % SPAN;
      if TcpListener::bind(("127.0.0.1", port)).is_ok() {
        return port;
      }
    }
    panic!("no free port from {FIRST} for a test to listen on");
  }

  // For a failure message only: who listens on the port (where the system has `lsof`) and what a fresh connection to it turns out to be.
  fn who_answers(port: u16) -> String {
    let listed = std::process::Command::new("lsof")
      .args(["-nP", &format!("-iTCP:{port}")])
      .output()
      .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
      .unwrap_or_default();
    let connection = match TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300)) {
      Ok(stream) => format!("a connection succeeded: local {:?}, peer {:?}", stream.local_addr(), stream.peer_addr()),
      Err(error) => format!("a connection failed: {error}"),
    };
    format!("lsof:\n{listed}\n{connection}")
  }

  fn long_lived_child() -> std::process::Child {
    #[cfg(windows)]
    let mut command = {
      let mut c = std::process::Command::new("powershell");
      c.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]);
      c
    };
    #[cfg(not(windows))]
    let mut command = {
      let mut c = std::process::Command::new("sleep");
      c.arg("30");
      c
    };
    command
      .stdin(std::process::Stdio::null())
      .stdout(std::process::Stdio::null())
      .stderr(std::process::Stdio::null())
      .spawn()
      .expect("a child process to start")
  }

  #[test]
  fn a_stop_frees_the_port_while_a_child_started_beside_the_server_is_still_running() {
    let port = scratch_port();
    let running = Arc::new(AtomicBool::new(false));
    let closed = listen(port, &running, drop).expect("listen");
    assert!(accepting(port), "the server is up");

    let mut child = long_lived_child();
    std::thread::sleep(Duration::from_millis(300));
    let stopping = std::time::Instant::now();
    stop_listening(&running, port, Some(closed));
    let waited = stopping.elapsed();

    // The rule, from both sides: once a stop has returned nothing accepts on the port and a new bind gets it.
    let still_accepting = accepting(port);
    let rebound = TcpListener::bind(("127.0.0.1", port)).is_ok();
    let who = if still_accepting || !rebound { who_answers(port) } else { String::new() };
    let _ = child.kill();
    let _ = child.wait();
    assert!(
      !still_accepting,
      "the port still accepts connections after the stop (it waited {waited:?} for the socket to close; 2 s means it never did): {who}"
    );
    assert!(rebound, "a new bind on the port failed after the stop (waited {waited:?}): {who}");
  }

  #[test]
  fn a_connection_that_was_open_when_a_child_started_is_not_kept_open_by_it() {
    let port = scratch_port();
    let running = Arc::new(AtomicBool::new(false));
    let (accepted_tx, accepted_rx) = std::sync::mpsc::channel::<()>();
    let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
    let closed = listen(port, &running, move |mut stream| {
      let _ = accepted_tx.send(());
      // Held open until the child exists, then answered and closed: the shape of a request that is in flight when a sidecar starts.
      let _ = go_rx.recv();
      let _ = stream.write_all(b"done");
    })
    .expect("listen");
    let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
    accepted_rx.recv_timeout(Duration::from_secs(5)).expect("the server accepted the connection");

    let mut child = long_lived_child();
    std::thread::sleep(Duration::from_millis(300));
    go_tx.send(()).unwrap();

    // The client reads to the end. If the child inherited the connection, the end does not come while the child lives.
    client.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    let mut seen = Vec::new();
    let ended = client.read_to_end(&mut seen);
    let _ = child.kill();
    let _ = child.wait();
    stop_listening(&running, port, Some(closed));
    assert!(ended.is_ok(), "the connection was not closed: the child process kept it open ({ended:?})");
    assert_eq!(seen, b"done");
  }

  #[test]
  fn switching_off_and_on_again_never_finds_the_port_taken() {
    let port = scratch_port();
    let running = Arc::new(AtomicBool::new(false));
    let mut child = None;
    for round in 0..15 {
      let closed = listen(port, &running, drop).unwrap_or_else(|e| panic!("round {round}: the port was taken: {e}"));
      if round == 3 {
        // A sidecar starts partway through and lives on across every later round.
        child = Some(long_lived_child());
      }
      stop_listening(&running, port, Some(closed));
    }
    if let Some(mut child) = child {
      let _ = child.kill();
      let _ = child.wait();
    }
  }

  #[test]
  fn a_stop_when_the_server_was_not_listening_never_touches_whoever_holds_the_port() {
    // Someone else holds the port (the situation the person is told about). A stop must not so much as connect to it.
    let other = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    other.set_nonblocking(true).unwrap();
    let port = other.local_addr().unwrap().port();

    stop_listening(&AtomicBool::new(true), port, None);
    std::thread::sleep(Duration::from_millis(200));

    assert!(other.accept().is_err(), "the stop connected to a listener that is not ours");
  }

  #[test]
  fn the_server_is_up_for_the_first_connection_the_moment_it_starts() {
    // The flag the accept loop reads is already set when its first connection arrives, so that connection is served, not skipped.
    for _ in 0..20 {
      let port = scratch_port();
      let running = Arc::new(AtomicBool::new(false));
      let (seen_tx, seen_rx) = std::sync::mpsc::channel::<()>();
      let closed = listen(port, &running, move |_| {
        let _ = seen_tx.send(());
      })
      .expect("listen");
      let _client = TcpStream::connect(("127.0.0.1", port)).unwrap();
      assert!(seen_rx.recv_timeout(Duration::from_secs(3)).is_ok(), "the first connection was not served");
      stop_listening(&running, port, Some(closed));
    }
  }
}
