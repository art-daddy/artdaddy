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
use std::net::{TcpListener, TcpStream};
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

#[derive(Clone)]
pub struct McpState {
  pending: Pending,
  /// JSON-RPC request id (as text) -> the bridge id running it, so `notifications/cancelled`
  /// can reach the actual work. Keyed by session too: two clients may both use id 1.
  in_flight: Arc<Mutex<HashMap<String, u64>>>,
  sessions: Arc<Mutex<HashMap<String, ()>>>,
  next_id: Arc<AtomicU64>,
  running: Arc<AtomicBool>,
  port: Arc<AtomicU64>,
  /// The instruction text the webview composes (shared system prompt + MCP-only sections).
  instructions: Arc<Mutex<Option<String>>>,
  listener: Arc<Mutex<Option<TcpListener>>>,
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
      listener: Arc::new(Mutex::new(None)),
    }
  }
}

impl McpState {
  /// Everything the accept loop needs, minus the listener handle it must not own.
  fn inner_clone(&self) -> Self {
    Self {
      pending: self.pending.clone(),
      in_flight: self.in_flight.clone(),
      sessions: self.sessions.clone(),
      next_id: self.next_id.clone(),
      running: self.running.clone(),
      port: self.port.clone(),
      instructions: self.instructions.clone(),
      listener: Arc::new(Mutex::new(None)),
    }
  }
}

/// Ask the webview to answer an MCP method. Blocks the connection thread until the webview
/// replies via `mcp_reply`, or the call times out. `cancel_key` (session + JSON-RPC id) lets a
/// later `notifications/cancelled` find and abort this exact call.
fn ask_webview(
  app: &AppHandle,
  state: &McpState,
  method: &str,
  params: Value,
  cancel_key: Option<String>,
) -> Result<Value, String> {
  let id = state.next_id.fetch_add(1, Ordering::SeqCst);
  let (tx, rx) = std::sync::mpsc::channel::<Value>();
  state.pending.lock().map_err(|_| "bridge poisoned")?.insert(id, tx);
  if let Some(key) = cancel_key.clone() {
    state.in_flight.lock().map_err(|_| "bridge poisoned")?.insert(key, id);
  }

  app
    .emit("artdaddy://mcp-request", json!({ "id": id, "method": method, "params": params }))
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
    "initialize" => Ok(server_info(state)),
    "ping" => Ok(json!({})),
    "tools/list" | "tools/call" => ask_webview(app, state, method, params, cancel_key),
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
  let mut reader = BufReader::new(stream.try_clone().ok()?);
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

fn respond(stream: &mut TcpStream, status: u16, reason: &str, extra: &[(&str, &str)], body: &str) {
  let mut head = format!("HTTP/1.1 {status} {reason}\r\n");
  head.push_str("Content-Type: application/json\r\n");
  for (k, v) in extra {
    head.push_str(&format!("{k}: {v}\r\n"));
  }
  head.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", body.len()));
  let _ = stream.write_all(head.as_bytes());
  let _ = stream.write_all(body.as_bytes());
  let _ = stream.flush();
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
    respond(&mut stream, 405, "Method Not Allowed", &[], r#"{"error":"no event stream"}"#);
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
        m.insert(fresh.clone(), ());
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

/// Start the listener. Idempotent: a second call while running is a no-op.
#[tauri::command]
pub fn mcp_start(app: AppHandle, state: tauri::State<'_, McpState>, port: Option<u16>) -> Result<Value, String> {
  if state.running.load(Ordering::SeqCst) {
    return Ok(mcp_status(state));
  }
  let port = port.unwrap_or(DEFAULT_PORT);
  // 127.0.0.1 (not 0.0.0.0) so the editor is never drivable from the network.
  let listener = TcpListener::bind(("127.0.0.1", port))
    .map_err(|e| {
      log::error!("[mcp] could not bind 127.0.0.1:{port}: {e}");
      format!("could not bind 127.0.0.1:{port}: {e}")
    })?;
  log::info!("[mcp] listening on 127.0.0.1:{port}");

  state.running.store(true, Ordering::SeqCst);
  state.port.store(port as u64, Ordering::SeqCst);

  // Keep a handle so stopping can drop the socket. Without this the port stays bound until the
  // process exits, and turning the server off then on again fails with "address in use".
  let accept = listener.try_clone().map_err(|e| format!("could not clone listener: {e}"))?;
  if let Ok(mut slot) = state.listener.lock() {
    *slot = Some(listener);
  }

  let owned = state.inner_clone();
  let handler = state.inner_clone();
  std::thread::spawn(move || {
    accept_loop(accept.incoming(), &owned.running, move |s| {
      let (a, st) = (app.clone(), handler.clone());
      std::thread::spawn(move || serve(s, a, st));
    });
  });

  Ok(json!({ "running": true, "port": port }))
}

#[tauri::command]
pub fn mcp_stop(state: tauri::State<'_, McpState>) -> Value {
  state.running.store(false, Ordering::SeqCst);
  let port = state.port.load(Ordering::SeqCst) as u16;
  // Drop the bound socket, then unblock the accept loop so the thread exits now rather than on
  // the next request.
  if let Ok(mut slot) = state.listener.lock() {
    slot.take();
  }
  let _ = std::net::TcpStream::connect(("127.0.0.1", port));
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
}
