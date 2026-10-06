// Runs the page's sidecar commands — ffmpeg, ffprobe, yt-dlp, whisper-cli and the browser
// helper — in the app process, and hands the page ONE result per run (2026-10-07).
//
// The shell plugin's page-side spawn turned every chunk a process wrote into its own webview
// eval, and each eval is a message posted to the UI thread. Windows caps one thread's queue at
// 10,000 posted messages. A chatty process (ffmpeg's per-frame loudness log over a 10-minute
// span, four at once) overflowed it. A lost message was an index in the plugin's ordered
// channel, so the run's exit never reached the page and the tool never returned; and the posts
// lost alongside it included IPC replies, so the whole app stopped answering until restarted.
//
// Here a process's output stays in Rust until it ends. A caller that wants live stdout (a
// render's progress) gets it coalesced: at most one message per PROGRESS_INTERVAL per run,
// however fast the process writes. The process is started exactly as the plugin started it for
// the page: a bundled sidecar only, piped stdio, no console window, and the app's environment.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tauri::async_runtime::Receiver;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

/// The most often one run's live stdout reaches the page.
pub const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Text for the page: lossy UTF-8 (a stray byte becomes U+FFFD instead of failing the run) with
/// no leading byte-order mark — what the page's TextDecoder made of the same bytes.
fn decode(bytes: &[u8]) -> String {
  let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
  String::from_utf8_lossy(b).into_owned()
}

/// How many bytes at the end of `buf` begin a UTF-8 character whose other bytes have not
/// arrived yet. A read can split a character; decoding the halves apart would print two U+FFFD.
fn incomplete_tail(buf: &[u8]) -> usize {
  for back in 1..=buf.len().min(3) {
    let b = buf[buf.len() - back];
    if b & 0xC0 == 0x80 {
      continue; // a continuation byte: its lead byte is further back
    }
    let len = match b {
      0xC0..=0xDF => 2,
      0xE0..=0xEF => 3,
      0xF0..=0xF7 => 4,
      _ => 1,
    };
    return if len > back { back } else { 0 };
  }
  0
}

/// One run's live stdout, held between progress messages.
pub struct Coalescer {
  interval: Duration,
  start: Instant,
  pending: Vec<u8>,
  last_sent: Option<Instant>,
}

impl Coalescer {
  pub fn new(interval: Duration, now: Instant) -> Self {
    Self { interval, start: now, pending: Vec::new(), last_sent: None }
  }

  fn sendable(&self) -> usize {
    self.pending.len() - incomplete_tail(&self.pending)
  }

  /// Take a chunk; the text to send now, when a message is due.
  pub fn push(&mut self, chunk: &[u8], now: Instant) -> Option<String> {
    self.pending.extend_from_slice(chunk);
    self.due(now)
  }

  /// The held text, when the interval since the last message has passed.
  pub fn due(&mut self, now: Instant) -> Option<String> {
    let n = self.sendable();
    if n == 0 {
      return None;
    }
    if let Some(t) = self.last_sent {
      if now < t + self.interval {
        return None;
      }
    }
    self.last_sent = Some(now);
    let rest = self.pending.split_off(n);
    Some(decode(&std::mem::replace(&mut self.pending, rest)))
  }

  /// When the held text may go; None while nothing whole is held.
  pub fn deadline(&self) -> Option<Instant> {
    if self.sendable() == 0 {
      return None;
    }
    Some(self.last_sent.map_or(self.start, |t| t + self.interval))
  }

  /// Everything still held: the process has ended.
  pub fn finish(&mut self) -> Option<String> {
    if self.pending.is_empty() {
      return None;
    }
    Some(decode(&std::mem::take(&mut self.pending)))
  }
}

#[derive(Default)]
struct Slot {
  pid: Option<u32>,
  cancelled: bool,
}

/// The page's runs, by the id the page gave each one, so Stop can find the process.
#[derive(Default)]
pub struct Runs(Mutex<HashMap<String, Slot>>);

impl Runs {
  fn map(&self) -> MutexGuard<'_, HashMap<String, Slot>> {
    self.0.lock().unwrap_or_else(|e| e.into_inner())
  }

  /// Claim `id` for a run about to start. False when it must not start: its Stop got here
  /// first (the cancel is used up), or the id is already taken.
  pub fn begin(&self, id: &str) -> bool {
    let mut m = self.map();
    match m.get(id) {
      Some(s) if s.cancelled && s.pid.is_none() => {
        m.remove(id);
        false
      }
      Some(_) => false,
      None => {
        m.insert(id.to_string(), Slot::default());
        true
      }
    }
  }

  /// The run's process exists. False when Stop arrived while it was starting: kill it now.
  pub fn started(&self, id: &str, pid: u32) -> bool {
    let mut m = self.map();
    let slot = m.entry(id.to_string()).or_default();
    slot.pid = Some(pid);
    !slot.cancelled
  }

  /// Stop: the pid to kill when the process exists. Otherwise the cancel is kept, so a start
  /// that has not happened yet never happens.
  pub fn cancel(&self, id: &str) -> Option<u32> {
    let mut m = self.map();
    let slot = m.entry(id.to_string()).or_default();
    slot.cancelled = true;
    slot.pid
  }

  pub fn end(&self, id: &str) {
    self.map().remove(id);
  }

  /// Every process still running, for the app's exit.
  pub fn pids(&self) -> Vec<u32> {
    self.map().values().filter_map(|s| s.pid).collect()
  }
}

/// What a run produced, as the page's runner reports it.
#[derive(Debug, Default, serde::Serialize)]
pub struct RunOutput {
  /// None when the process died by a signal or its exit was never reported.
  pub code: Option<i32>,
  pub stdout: String,
  pub stderr: String,
  /// Progress messages sent, so the page can wait for the last of them before it resolves.
  pub progress_sent: u32,
}

/// Collect a process's events until it ends. With `progress`, stdout also goes to `send`,
/// coalesced; `send` reports whether the message went out.
pub async fn collect(
  mut rx: Receiver<CommandEvent>,
  progress: bool,
  mut send: impl FnMut(String) -> bool,
) -> RunOutput {
  let mut stdout = Vec::new();
  let mut stderr = Vec::new();
  let mut code = None;
  let mut error = None;
  let mut sent = 0u32;
  let mut held = Coalescer::new(PROGRESS_INTERVAL, Instant::now());
  loop {
    let next = match held.deadline().filter(|_| progress) {
      Some(at) => match tokio::time::timeout_at(at.into(), rx.recv()).await {
        Ok(ev) => ev,
        Err(_) => {
          if let Some(text) = held.due(Instant::now()) {
            sent += u32::from(send(text));
          }
          continue;
        }
      },
      None => rx.recv().await,
    };
    let Some(ev) = next else { break };
    match ev {
      CommandEvent::Stdout(b) => {
        stdout.extend_from_slice(&b);
        if progress {
          if let Some(text) = held.push(&b, Instant::now()) {
            sent += u32::from(send(text));
          }
        }
      }
      CommandEvent::Stderr(b) => stderr.extend_from_slice(&b),
      // As the page's runner did: the first error ends the run as a failure.
      CommandEvent::Error(e) => {
        error = Some(e);
        break;
      }
      CommandEvent::Terminated(p) => code = p.code,
      _ => {}
    }
  }
  if progress {
    if let Some(text) = held.finish() {
      sent += u32::from(send(text));
    }
  }
  match error {
    Some(e) => RunOutput {
      code: None,
      stdout: decode(&stdout),
      stderr: format!("command error: {e}"),
      progress_sent: sent,
    },
    None => RunOutput { code, stdout: decode(&stdout), stderr: decode(&stderr), progress_sent: sent },
  }
}

/// Is `name` one of the sidecars this build bundles? `external_bin` is tauri.conf.json's list
/// (`binaries/<name>`), the same list the shell plugin checked for the page.
pub fn is_bundled(external_bin: &[String], name: &str) -> bool {
  !name.is_empty()
    && !name.contains(['/', '\\'])
    && external_bin.iter().any(|b| b.strip_prefix("binaries/") == Some(name))
}

/// Run a bundled sidecar to its end and return what it wrote. `run_id` is the page's handle
/// for Stop (`sidecar_kill`); `progress` sends stdout to `on_stdout` as it arrives, coalesced.
#[tauri::command]
pub async fn sidecar_run<R: Runtime>(
  app: AppHandle<R>,
  run_id: String,
  program: String,
  args: Vec<String>,
  cwd: Option<String>,
  progress: bool,
  on_stdout: Channel<String>,
) -> Result<RunOutput, String> {
  let bundled = app.config().bundle.external_bin.clone().unwrap_or_default();
  if !is_bundled(&bundled, &program) {
    return Err(format!("'{program}' is not a bundled program"));
  }
  let runs = app.state::<Runs>();
  if !runs.begin(&run_id) {
    return Ok(RunOutput { code: None, stderr: "cancelled".into(), ..Default::default() });
  }
  let spawned = app.shell().sidecar(&program).map_err(|e| e.to_string()).and_then(|cmd| {
    // The environment is INHERITED, as the plugin did for the page (its `env` option defaults to
    // an empty map: nothing added, nothing removed). Clearing it is not a hardening: yt-dlp's
    // bundle cannot make its temp dir without TEMP, and Playwright's tmpdir becomes
    // "undefined\temp" (both seen live, 2026-10-07).
    let mut cmd = cmd.args(args).set_raw_out(true);
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
      cmd = cmd.current_dir(dir);
    }
    cmd.spawn().map_err(|e| e.to_string())
  });
  let (rx, child) = match spawned {
    Ok(x) => x,
    Err(e) => {
      runs.end(&run_id);
      return Err(e);
    }
  };
  let pid = child.pid();
  if !runs.started(&run_id, pid) {
    if let Err(e) = crate::kill_tree(pid) {
      log::warn!("sidecar {program} (pid {pid}) was stopped while starting and could not be killed: {e}");
    }
  }
  let out = collect(rx, progress, |text| on_stdout.send(text).is_ok()).await;
  // Held until the end, as the plugin held it for the page: the child owns its stdin pipe.
  drop(child);
  runs.end(&run_id);
  Ok(out)
}

/// Stop a run: kill its process and everything it started, or make sure it never starts.
/// Ok(true) when a running process was killed, Ok(false) when it had not started.
#[tauri::command]
pub fn sidecar_kill(runs: State<'_, Runs>, run_id: String) -> Result<bool, String> {
  match runs.cancel(&run_id) {
    Some(pid) => crate::kill_tree(pid).map(|()| true),
    None => Ok(false),
  }
}

/// Holds the runs and kills any still running when the app exits (the shell plugin did that
/// for the processes the page spawned through it).
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
  tauri::plugin::Builder::new("sidecar-runs")
    .setup(|app, _api| {
      app.manage(Runs::default());
      Ok(())
    })
    .on_event(|app, event| {
      if let tauri::RunEvent::Exit = event {
        if let Some(runs) = app.try_state::<Runs>() {
          for pid in runs.pids() {
            let _ = crate::kill_tree(pid);
          }
        }
      }
    })
    .build()
}

#[cfg(test)]
mod tests {
  use super::*;
  use tauri_plugin_shell::process::TerminatedPayload;

  const MS: Duration = Duration::from_millis(1);

  #[test]
  fn the_first_chunk_goes_at_once_and_the_next_waits_for_the_interval() {
    let t0 = Instant::now();
    let mut c = Coalescer::new(PROGRESS_INTERVAL, t0);
    assert_eq!(c.push(b"frame=1\n", t0).as_deref(), Some("frame=1\n"));
    assert_eq!(c.push(b"frame=2\n", t0 + 10 * MS), None);
    assert_eq!(c.push(b"frame=3\n", t0 + 20 * MS), None);
    assert_eq!(c.deadline(), Some(t0 + PROGRESS_INTERVAL));
    assert_eq!(c.due(t0 + 99 * MS), None);
    assert_eq!(c.due(t0 + PROGRESS_INTERVAL).as_deref(), Some("frame=2\nframe=3\n"));
    assert_eq!(c.deadline(), None);
    assert_eq!(c.finish(), None);
  }

  #[test]
  fn a_chunk_after_a_quiet_spell_goes_at_once() {
    let t0 = Instant::now();
    let mut c = Coalescer::new(PROGRESS_INTERVAL, t0);
    assert!(c.push(b"a", t0).is_some());
    assert_eq!(c.push(b"b", t0 + 500 * MS).as_deref(), Some("b"));
  }

  #[test]
  fn what_is_held_when_the_process_ends_is_not_lost() {
    let t0 = Instant::now();
    let mut c = Coalescer::new(PROGRESS_INTERVAL, t0);
    c.push(b"one\n", t0);
    assert_eq!(c.push(b"progress=end\n", t0 + MS), None);
    assert_eq!(c.finish().as_deref(), Some("progress=end\n"));
    assert_eq!(c.finish(), None);
  }

  #[test]
  fn a_character_split_across_two_reads_is_held_until_it_is_whole() {
    let t0 = Instant::now();
    let mut c = Coalescer::new(PROGRESS_INTERVAL, t0);
    let e = "é".as_bytes(); // two bytes
    assert_eq!(c.push(&[b'x', e[0]], t0).as_deref(), Some("x"));
    assert_eq!(c.deadline(), None, "half a character is not sendable");
    assert_eq!(c.push(&e[1..], t0 + 200 * MS).as_deref(), Some("é"));
    // A four-byte character arriving one byte at a time.
    let g = "😀".as_bytes();
    for (i, b) in g.iter().enumerate() {
      let got = c.push(&[*b], t0 + (400 + 200 * i as u32) * MS);
      assert_eq!(got.as_deref(), if i == 3 { Some("😀") } else { None });
    }
  }

  #[test]
  fn bytes_that_are_not_utf8_become_replacement_characters_not_a_failure() {
    let t0 = Instant::now();
    let mut c = Coalescer::new(PROGRESS_INTERVAL, t0);
    // cp1252's curly quote, as yt-dlp prints it on Windows, then plain text.
    assert_eq!(c.push(b"don\x92t\n", t0).as_deref(), Some("don\u{FFFD}t\n"));
    assert_eq!(decode(b"\xEF\xBB\xBFhello"), "hello");
    // A truncated character at the very end still comes out when the process ends.
    c.push(&[0xE2, 0x82], t0 + 10 * MS);
    assert_eq!(c.finish().as_deref(), Some("\u{FFFD}"));
  }

  /// A deterministic xorshift, so the chunkings below are many and reproducible.
  fn rng(seed: u64) -> impl FnMut() -> u64 {
    let mut s = seed;
    move || {
      s ^= s << 13;
      s ^= s >> 7;
      s ^= s << 17;
      s
    }
  }

  #[test]
  fn however_the_output_is_chunked_and_timed_every_byte_arrives_once_in_order_at_a_bounded_rate() {
    let text = "ffmpeg: I: -23.0 LUFS · ünïcödé · 😀 ·\n".repeat(400);
    let bytes = text.as_bytes();
    for seed in 1..200u64 {
      let mut next = rng(seed);
      let t0 = Instant::now();
      let mut c = Coalescer::new(PROGRESS_INTERVAL, t0);
      let (mut i, mut at, mut out, mut messages) = (0usize, t0, String::new(), 0u32);
      while i < bytes.len() {
        let n = 1 + (next() % 64) as usize;
        let end = (i + n).min(bytes.len());
        at += Duration::from_micros(next() % 3_000); // up to 3 ms apart: a flood
        if let Some(s) = c.push(&bytes[i..end], at) {
          out.push_str(&s);
          messages += 1;
        }
        if next() % 7 == 0 {
          if let Some(d) = c.deadline() {
            if let Some(s) = c.due(d) {
              at = at.max(d);
              out.push_str(&s);
              messages += 1;
            }
          }
        }
        i = end;
      }
      if let Some(s) = c.finish() {
        out.push_str(&s);
        messages += 1;
      }
      assert_eq!(out, text, "seed {seed}: bytes lost, duplicated or reordered");
      let allowed = (at - t0).as_millis() as u32 / PROGRESS_INTERVAL.as_millis() as u32 + 2;
      assert!(messages <= allowed, "seed {seed}: {messages} messages in {:?}", at - t0);
    }
  }

  #[test]
  fn a_stop_that_beats_the_start_means_it_never_starts() {
    let r = Runs::default();
    assert_eq!(r.cancel("a"), None);
    assert!(!r.begin("a"), "a cancelled run must not start");
    assert!(r.begin("a"), "the cancel is used up; the id is free again");
  }

  #[test]
  fn a_stop_while_the_process_starts_gets_it_killed_once_it_exists() {
    let r = Runs::default();
    assert!(r.begin("a"));
    assert_eq!(r.cancel("a"), None, "no process yet");
    assert!(!r.started("a", 42), "it must be killed as soon as it exists");
  }

  #[test]
  fn a_stop_while_it_runs_hands_back_its_pid_and_exit_sees_every_running_pid() {
    let r = Runs::default();
    assert!(r.begin("a") && r.begin("b"));
    assert!(r.started("a", 7) && r.started("b", 8));
    let mut pids = r.pids();
    pids.sort_unstable();
    assert_eq!(pids, vec![7, 8]);
    assert_eq!(r.cancel("a"), Some(7));
    assert!(!r.begin("a"), "an id in use cannot be claimed twice");
    r.end("a");
    r.end("b");
    assert!(r.pids().is_empty());
  }

  #[test]
  fn only_the_bundled_sidecars_run() {
    let bins: Vec<String> = ["ffmpeg", "ffprobe", "yt-dlp", "whisper-cli", "browser"]
      .iter()
      .map(|n| format!("binaries/artdaddy-{n}"))
      .collect();
    for ok in ["artdaddy-ffmpeg", "artdaddy-ffprobe", "artdaddy-browser"] {
      assert!(is_bundled(&bins, ok), "{ok}");
    }
    for bad in [
      "",
      "cmd",
      "ffmpeg",
      "binaries/artdaddy-ffmpeg",
      "../artdaddy-ffmpeg",
      "..\\artdaddy-ffmpeg",
      "artdaddy-ffmpeg.exe",
      "C:\\Windows\\System32\\cmd.exe",
    ] {
      assert!(!is_bundled(&bins, bad), "{bad}");
    }
  }

  fn events(list: Vec<CommandEvent>) -> Receiver<CommandEvent> {
    let (tx, rx) = tauri::async_runtime::channel(list.len().max(1));
    for ev in list {
      tx.try_send(ev).unwrap();
    }
    rx
  }

  fn exit(code: Option<i32>) -> CommandEvent {
    CommandEvent::Terminated(TerminatedPayload { code, signal: None })
  }

  #[test]
  fn a_run_reports_its_exit_code_and_both_streams_and_sends_nothing_unasked() {
    let rx = events(vec![
      CommandEvent::Stdout(b"{\"streams\":[]}".to_vec()),
      CommandEvent::Stderr(b"warning\n".to_vec()),
      exit(Some(3)),
    ]);
    let mut sends = 0;
    let out = tauri::async_runtime::block_on(collect(rx, false, |_| {
      sends += 1;
      true
    }));
    assert_eq!(out.code, Some(3));
    assert_eq!(out.stdout, "{\"streams\":[]}");
    assert_eq!(out.stderr, "warning\n");
    assert_eq!((out.progress_sent, sends), (0, 0));
  }

  #[test]
  fn an_exit_never_reported_is_a_failure_and_an_error_ends_the_run() {
    let rx = events(vec![CommandEvent::Stdout(b"partial".to_vec())]);
    let out = tauri::async_runtime::block_on(collect(rx, false, |_| true));
    assert_eq!(out.code, None);
    assert_eq!(out.stdout, "partial");

    let rx = events(vec![CommandEvent::Error("pipe broke".into()), exit(Some(0))]);
    let out = tauri::async_runtime::block_on(collect(rx, false, |_| true));
    assert_eq!(out.code, None, "an error is a failure whatever exit follows");
    assert_eq!(out.stderr, "command error: pipe broke");
  }

  /// The regression itself: a process that writes thousands of tiny chunks at once (ffmpeg's
  /// per-frame log) must reach the page as a handful of messages, every byte in order.
  #[test]
  fn a_flood_of_ten_thousand_chunks_reaches_the_page_as_a_few_messages() {
    let line = "[Parsed_ebur128_0] t: 1.2 M: -23.0 S: -23.0 I: -23.0 LUFS\n";
    let mut list: Vec<CommandEvent> =
      (0..10_000).map(|_| CommandEvent::Stdout(line.as_bytes().to_vec())).collect();
    list.push(exit(Some(0)));
    let rx = events(list);
    let mut got = String::new();
    let mut messages = 0u32;
    let t0 = Instant::now();
    let out = tauri::async_runtime::block_on(collect(rx, true, |text| {
      got.push_str(&text);
      messages += 1;
      true
    }));
    let allowed = t0.elapsed().as_millis() as u32 / PROGRESS_INTERVAL.as_millis() as u32 + 2;
    assert!(messages <= allowed, "{messages} messages for one run in {:?}", t0.elapsed());
    assert_eq!(out.progress_sent, messages);
    assert_eq!(got, line.repeat(10_000));
    assert_eq!(out.stdout, got);
    assert_eq!(out.code, Some(0));
  }

  #[test]
  fn held_progress_goes_out_on_time_while_the_process_is_still_running() {
    let (tx, rx) = tauri::async_runtime::channel(8);
    let sent = std::sync::Arc::new(Mutex::new(Vec::<(Duration, String)>::new()));
    let log = sent.clone();
    let t0 = Instant::now();
    let out = tauri::async_runtime::block_on(async move {
      let feeder = tauri::async_runtime::spawn(async move {
        tx.send(CommandEvent::Stdout(b"a".to_vec())).await.unwrap();
        tx.send(CommandEvent::Stdout(b"b".to_vec())).await.unwrap(); // held: too soon after "a"
        tokio::time::sleep(Duration::from_millis(600)).await; // the process says nothing for a while
        tx.send(exit(Some(0))).await.unwrap();
      });
      let out = collect(rx, true, |text| {
        log.lock().unwrap().push((t0.elapsed(), text));
        true
      })
      .await;
      feeder.await.unwrap();
      out
    });
    let sent = sent.lock().unwrap();
    assert_eq!(sent.iter().map(|(_, s)| s.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
    assert!(sent[1].0 < Duration::from_millis(400), "\"b\" waited for the exit: {:?}", sent[1].0);
    assert_eq!(out.progress_sent, 2);
  }

  #[test]
  fn a_message_that_does_not_go_out_is_not_counted() {
    let rx = events(vec![CommandEvent::Stdout(b"x".to_vec()), exit(Some(0))]);
    let out = tauri::async_runtime::block_on(collect(rx, true, |_| false));
    assert_eq!(out.progress_sent, 0);
    assert_eq!(out.stdout, "x");
  }
}
