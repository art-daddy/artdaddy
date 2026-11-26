//! What the app's updater does with a feed it has read: offer, download, verify the signature (macOS and Linux).
//!
//! The updater plugin the app ships (the locked version), on tauri's mock runtime, with the updater settings of
//! tauri.conf.json. Three of them differ, for this test only: the feed's address is a loopback server, so the
//! feed is whatever the test says; plain http is allowed for that address, because a test cannot make a
//! certificate the system trusts; and the trusted public key is a throwaway key made here, never the release
//! key, so that a payload the test signs can be accepted at all. Nothing is ever installed: what `download`
//! returns is what `install` would run.
//!
//! Not on Windows: a test binary there that links the Tauri runtime does not start (it lacks the Common Controls
//! v6 manifest that only the app binary is given). The feed reader is fuzzed on every system in update_feed.rs;
//! the release signature check, with throwaway keys too, is scripts/verify-release-signature.test.mjs.

#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{json, Map, Value};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri_plugin_updater::{Update, UpdaterExt};

const FEED_PATH: &str = "/updates/latest.json";
/// The live feed of 26 Nov 2026, byte for byte (update_feed.rs says where it comes from).
const GOLDEN: &str = include_str!("fixtures/updater/latest-0.29.1.json");
const PAYLOAD: &[u8] = b"stand-in update bytes: never installed, only downloaded and verified";

// ---------------------------------------------------------------------------------------------------------------
// Throwaway minisign keys, in the format of the release key.

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(bytes: &[u8]) -> String {
  let mut out = String::new();
  for chunk in bytes.chunks(3) {
    let n = (u32::from(chunk[0]) << 16)
      | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
      | u32::from(*chunk.get(2).unwrap_or(&0));
    for i in 0..4 {
      if i <= chunk.len() {
        out.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
      } else {
        out.push('=');
      }
    }
  }
  out
}

struct TestKey {
  pair: Ed25519KeyPair,
  id: [u8; 8],
}

impl TestKey {
  fn generate(id: [u8; 8]) -> Self {
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).expect("a fresh key pair");
    Self { pair: Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("the key pair just made"), id }
  }

  /// The public key the way tauri.conf.json carries one: base64 of a minisign public key file.
  fn pubkey(&self) -> String {
    let mut key = b"Ed".to_vec();
    key.extend_from_slice(&self.id);
    key.extend_from_slice(self.pair.public_key().as_ref());
    base64(format!("untrusted comment: minisign public key of a throwaway test key\n{}\n", base64(&key)).as_bytes())
  }

  /// A minisign signature of `data` (legacy mode, which the updater accepts), wrapped the way a feed carries one.
  /// `signed` is the trusted comment the global signature covers; `shown` the one written into the file.
  fn sign_with_comment(&self, data: &[u8], signed: &str, shown: &str) -> String {
    let signature = self.pair.sign(data);
    let mut line = b"Ed".to_vec();
    line.extend_from_slice(&self.id);
    line.extend_from_slice(signature.as_ref());
    let mut global = signature.as_ref().to_vec();
    global.extend_from_slice(signed.as_bytes());
    let global = self.pair.sign(&global);
    let text = format!(
      "untrusted comment: signature from a throwaway test key\n{}\ntrusted comment: {shown}\n{}\n",
      base64(&line),
      base64(global.as_ref())
    );
    base64(text.as_bytes())
  }

  fn sign(&self, data: &[u8]) -> String {
    let comment = "timestamp:1795258631\tfile:test-payload";
    self.sign_with_comment(data, comment, comment)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A loopback web server: what it answers on each path, and every path it was asked for.

#[derive(Clone)]
struct Loopback {
  base: String,
  routes: Arc<Mutex<HashMap<String, (u16, Vec<u8>)>>>,
  hits: Arc<Mutex<Vec<String>>>,
}

impl Loopback {
  fn start() -> Self {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
    let server = Self {
      base: format!("http://{}", listener.local_addr().unwrap()),
      routes: Arc::default(),
      hits: Arc::default(),
    };
    let shared = server.clone();
    std::thread::spawn(move || {
      for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let shared = shared.clone();
        std::thread::spawn(move || {
          let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
          let Ok(reading) = stream.try_clone() else { return };
          let mut reader = BufReader::new(reading);
          let mut request = String::new();
          if reader.read_line(&mut request).unwrap_or(0) == 0 {
            return;
          }
          loop {
            let mut header = String::new();
            if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" {
              break;
            }
          }
          let path = request.split_whitespace().nth(1).unwrap_or_default().to_string();
          shared.hits.lock().unwrap_or_else(PoisonError::into_inner).push(path.clone());
          let (status, body) = shared
            .routes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&path)
            .cloned()
            .unwrap_or((404, b"not found".to_vec()));
          let head = format!(
            "HTTP/1.1 {status} X\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
          );
          let _ = stream.write_all(head.as_bytes());
          let _ = stream.write_all(&body);
        });
      }
    });
    server
  }

  fn answer(&self, path: &str, status: u16, body: impl Into<Vec<u8>>) -> String {
    self.routes.lock().unwrap_or_else(PoisonError::into_inner).insert(path.to_string(), (status, body.into()));
    format!("{}{path}", self.base)
  }

  fn hits(&self, path: &str) -> usize {
    self.hits.lock().unwrap_or_else(PoisonError::into_inner).iter().filter(|hit| hit.as_str() == path).count()
  }
}

// ---------------------------------------------------------------------------------------------------------------

struct Harness {
  app: tauri::App<MockRuntime>,
  server: Loopback,
  trusted: TestKey,
}

fn harness() -> Harness {
  let _ = rustls::crypto::ring::default_provider().install_default();
  let server = Loopback::start();
  let trusted = TestKey::generate(*b"trusted!");
  let shipped: Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
  let mut updater = shipped["plugins"]["updater"].clone();
  assert!(updater.is_object(), "tauri.conf.json configures the updater");
  updater["endpoints"] = json!([format!("{}{FEED_PATH}", server.base)]);
  updater["dangerousInsecureTransportProtocol"] = json!(true);
  updater["pubkey"] = json!(trusted.pubkey());
  let mut context = mock_context(noop_assets());
  context.config_mut().plugins.0.insert("updater".to_string(), updater);
  context.package_info_mut().version = shipped["version"].as_str().expect("a version").parse().expect("x.y.z");
  let app = mock_builder()
    .plugin(tauri_plugin_updater::Builder::new().build())
    .build(context)
    .expect("the updater plugin starts with the shipped configuration");
  Harness { app, server, trusted }
}

impl Harness {
  fn check(&self) -> Result<Option<Update>, String> {
    let updater = self.app.updater_builder().build().map_err(|e| e.to_string())?;
    tauri::async_runtime::block_on(updater.check()).map_err(|e| e.to_string())
  }

  fn offered(&self) -> Result<Option<String>, String> {
    self.check().map(|update| update.map(|update| update.version))
  }

  /// What `install` would be handed: the downloaded bytes, once their signature verified.
  fn download(&self) -> Result<Vec<u8>, String> {
    let update = self.check()?.ok_or("nothing offered")?;
    tauri::async_runtime::block_on(update.download(|_, _| {}, || {})).map_err(|e| e.to_string())
  }

  fn installed(&self) -> String {
    self.app.package_info().version.to_string()
  }

  fn newer(&self) -> String {
    let v = &self.app.package_info().version;
    format!("{}.{}.0", v.major, v.minor + 1)
  }

  fn serve_feed(&self, feed: impl Into<Vec<u8>>) {
    self.server.answer(FEED_PATH, 200, feed);
  }
}

/// The key this system's app looks itself up by in the feed (after `<key>-<installer>`, which our feed never has).
fn this_platform() -> String {
  let os = if cfg!(target_os = "macos") { "darwin" } else { "linux" };
  format!("{os}-{}", std::env::consts::ARCH)
}

/// A feed in the shape of the live one, with one entry per given platform.
fn feed(version: &str, entries: &[(&str, &str, &str)]) -> Vec<u8> {
  let mut platforms = Map::new();
  for (platform, url, signature) in entries {
    platforms.insert(platform.to_string(), json!({ "signature": signature, "url": url }));
  }
  serde_json::to_vec_pretty(&json!({
    "version": version,
    "notes": "What changed, in plain words.",
    "pub_date": "2026-11-21T11:29:40.636Z",
    "platforms": platforms,
  }))
  .unwrap()
}

// ---------------------------------------------------------------------------------------------------------------

/// The control: without it, every refusal below could be a harness that refuses everything.
#[test]
fn a_newer_release_signed_with_the_trusted_key_is_offered_and_its_bytes_verify() {
  let h = harness();
  let url = h.server.answer("/download/release", 200, PAYLOAD);
  let version = h.newer();
  h.serve_feed(feed(&version, &[(&this_platform(), &url, &h.trusted.sign(PAYLOAD))]));

  let update = h.check().expect("a well-formed feed is read").expect("a newer version is offered");
  assert_eq!(update.version, version);
  assert_eq!(update.current_version, h.installed());
  assert_eq!(update.body.as_deref(), Some("What changed, in plain words."));
  assert!(update.date.is_some());
  assert_eq!(update.download_url.as_str(), url);
  assert_eq!(h.download().expect("bytes signed by the trusted key verify"), PAYLOAD);
}

#[test]
fn a_payload_not_signed_by_the_trusted_key_is_never_handed_to_the_installer() {
  let h = harness();
  let elsewhere = Loopback::start();
  let other = TestKey::generate(*b"other-k!");
  // The trusted key's id with another key: only the signature itself can tell them apart.
  let impostor = TestKey::generate(h.trusted.id);
  let comment = "timestamp:1795258631\tfile:test-payload";
  let cases: Vec<(&str, &Loopback, String)> = vec![
    ("signed with another key", &h.server, other.sign(PAYLOAD)),
    ("signed with another key, served from another host", &elsewhere, other.sign(PAYLOAD)),
    ("signed by a key that claims the trusted key's id", &h.server, impostor.sign(PAYLOAD)),
    ("the trusted key's signature of other bytes", &h.server, h.trusted.sign(b"some other file")),
    ("the trusted key's signature with its trusted comment changed", &h.server, h.trusted.sign_with_comment(PAYLOAD, comment, "timestamp:1\tfile:test-payload")),
    ("an empty signature", &h.server, String::new()),
    ("a signature that is not base64", &h.server, "not base64 at all!".to_string()),
    ("base64 that is not a signature", &h.server, base64(b"hello")),
    ("the public key instead of a signature", &h.server, h.trusted.pubkey()),
  ];
  for (label, host, signature) in cases {
    let path = format!("/download/{}", label.replace(' ', "-"));
    let url = host.answer(&path, 200, PAYLOAD);
    h.serve_feed(feed(&h.newer(), &[(&this_platform(), &url, &signature)]));
    assert_eq!(h.offered(), Ok(Some(h.newer())), "{label}: the feed itself is well formed");
    let result = h.download();
    assert!(result.is_err(), "{label}: the bytes were accepted for install");
    assert_eq!(host.hits(&path), 1, "{label}: the signature is checked on the downloaded bytes");
  }
}

#[test]
fn the_same_or_an_older_version_is_never_offered() {
  let h = harness();
  let installed = h.installed();
  let older = {
    let v = &h.app.package_info().version;
    assert!(v.minor > 0, "the test needs an installed version above x.0.y");
    format!("{}.{}.{}", v.major, v.minor - 1, v.patch + 7)
  };
  let url = h.server.answer("/download/release", 200, PAYLOAD);
  for version in [installed.clone(), format!("v{installed}"), older] {
    h.serve_feed(feed(&version, &[(&this_platform(), &url, &h.trusted.sign(PAYLOAD))]));
    assert_eq!(h.offered(), Ok(None), "{version} offered to an app at {installed}");
  }
  assert_eq!(h.server.hits("/download/release"), 0, "nothing may be fetched");
}

#[test]
fn a_feed_without_this_system_is_an_error_and_never_an_offer() {
  let h = harness();
  let url = h.server.answer("/download/release", 200, PAYLOAD);
  let signature = h.trusted.sign(PAYLOAD);
  let others: Vec<(&str, &str, &str)> = ["windows-x86_64", "darwin-x86_64", "darwin-aarch64", "linux-x86_64", "linux-aarch64"]
    .into_iter()
    .filter(|platform| *platform != this_platform())
    .map(|platform| (platform, url.as_str(), signature.as_str()))
    .collect();
  // Also when the feed's version is the installed one: the updater looks up its entry before it compares versions.
  for version in [h.newer(), h.installed()] {
    h.serve_feed(feed(&version, &others));
    let result = h.offered();
    assert!(result.as_ref().is_err_and(|e| e.contains(&this_platform())), "{version}: {result:?}");
  }
  assert_eq!(h.server.hits("/download/release"), 0);
}

#[test]
fn a_feed_address_that_answers_an_error_page_is_an_error_and_never_an_offer() {
  let h = harness();
  for status in [404, 500, 503] {
    h.server.answer(FEED_PATH, status, b"<html>error</html>".to_vec());
    assert!(h.offered().is_err(), "HTTP {status}");
  }
}

/// The live feed, read by the updater: an app already on its version is offered nothing, and an older app is
/// offered exactly this system's entry. Nothing is downloaded (its address is the real one).
#[test]
fn the_live_feed_offers_this_system_its_own_entry() {
  let h = harness();
  let golden: Value = serde_json::from_str(GOLDEN).unwrap();
  let entry = golden["platforms"][this_platform()].clone();
  h.serve_feed(GOLDEN);
  if entry.is_null() {
    assert!(h.offered().is_err(), "the 0.29.1 feed has no {} entry, so this system is told so", this_platform());
    return;
  }
  assert_eq!(h.offered(), Ok(None), "an app at {} is offered nothing by the 0.29.1 feed", h.installed());

  let mut newer = golden.clone();
  newer["version"] = json!(h.newer());
  h.serve_feed(serde_json::to_vec_pretty(&newer).unwrap());
  let update = h.check().expect("read").expect("offered");
  assert_eq!(update.download_url.as_str(), entry["url"].as_str().unwrap());
  assert_eq!(update.signature, entry["signature"].as_str().unwrap());
  assert_eq!(update.body.as_deref(), golden["notes"].as_str());
}

#[test]
fn very_long_notes_arrive_whole_and_change_nothing_else() {
  let h = harness();
  let url = h.server.answer("/download/release", 200, PAYLOAD);
  let mut value: Value = serde_json::from_slice(&feed(&h.newer(), &[(&this_platform(), &url, &h.trusted.sign(PAYLOAD))])).unwrap();
  let notes = "Ünïcode notes, <b>not</b> markup. ".repeat(60_000);
  value["notes"] = json!(notes);
  h.serve_feed(serde_json::to_vec(&value).unwrap());
  assert_eq!(h.check().expect("read").expect("offered").body, Some(notes));
  assert_eq!(h.download().expect("verified"), PAYLOAD);
}

/// KNOWN BUG, expected to fail until fixed: the feed's download address may be plain http, and the app then
/// fetches the update over it. The signature still protects the bytes, but the download can be watched and
/// stalled by anyone on the network. Neither the updater plugin nor the app's `available_update` checks that
/// address's scheme; only the feed's own address must be https (tauri.conf.json). Steps: a feed whose entry for
/// this system has an `http://` url. Expected: no request to it, and a clear error. Actual: the update is
/// downloaded over http (and verifies). Remove `should_panic` once the app refuses a non-https download address.
#[test]
#[should_panic(expected = "fetched an update over plain http")]
fn known_bug_an_update_is_fetched_over_plain_http() {
  let h = harness();
  let url = h.server.answer("/download/plain-http", 200, PAYLOAD);
  assert!(url.starts_with("http://"));
  h.serve_feed(feed(&h.newer(), &[(&this_platform(), &url, &h.trusted.sign(PAYLOAD))]));
  let downloaded = h.download().map(|bytes| bytes.len());
  assert_eq!(
    h.server.hits("/download/plain-http"),
    0,
    "the app fetched an update over plain http from {url} (download: {downloaded:?})"
  );
}
