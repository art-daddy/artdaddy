//! Keeps the machine awake while an export is running.
//!
//! An export is the longest thing the app does and its user usually walks away from it. With no request an idle timer puts the
//! machine to sleep, or into Modern Standby, in the middle of the render. A request holds off ONLY that idle sleep: a closed lid, the
//! power button, a critical battery or an explicit Sleep still win, as the user expects. The hold follows the supervisor's own job
//! notices, so it exists while an export job is Running, however the job ends.
//!
//! The request is dropped a few minutes AFTER the last export ends, not at that instant. Windows does not restart its idle timer when
//! a request is cleared, so a user who left long ago would otherwise have the machine sleep in the seconds between one export and the
//! next of a batch, which is exactly when nothing holds it.
//!
//! Windows only for now: other platforms hold nothing, which is the behaviour they had before this module existed.

use super::{JobState, Notice};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A live request to the OS. Dropping it releases the request.
pub(super) trait Request: Send {}

type Acquire = Box<dyn Fn(&str) -> Option<Box<dyn Request>> + Send + Sync>;
/// Starts whatever will call `tick` until nothing is pending. False when it could not, in which case the request is dropped at once
/// rather than left with no one to release it.
type Timer = Box<dyn Fn(Arc<ExportAwake>) -> bool + Send + Sync>;

const REASON: &str = "Akaru is exporting a video";
/// Long enough to bridge the verify, publish and hand-over between two queued exports; short enough to cost nothing after the last.
const GRACE: Duration = Duration::from_secs(300);

#[derive(Default)]
struct State {
  running: HashSet<String>,
  held: Option<Box<dyn Request>>,
  /// When the request is to be dropped if nothing has started by then; None while an export runs or nothing is held.
  release_at: Option<Instant>,
  /// Something is waiting to call `tick`.
  timer: bool,
}

/// Tracks which jobs of one lane are running and holds one OS request while any of them is, plus the grace after the last.
pub(super) struct ExportAwake {
  lane: &'static str,
  acquire: Acquire,
  grace: Duration,
  timer: Timer,
  state: Mutex<State>,
}

impl ExportAwake {
  pub(super) fn new() -> Arc<Self> {
    Self::with("export", Box::new(platform::request), GRACE, Box::new(wait_then_release))
  }

  fn with(lane: &'static str, acquire: Acquire, grace: Duration, timer: Timer) -> Arc<Self> {
    Arc::new(Self { lane, acquire, grace, timer, state: Mutex::new(State::default()) })
  }

  fn locked(&self) -> std::sync::MutexGuard<'_, State> {
    self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
  }

  /// Feed every job change here. Only a RUNNING job of the watched lane counts; any other state ends that job's claim.
  pub(super) fn observe(self: &Arc<Self>, id: &str, lane: &str, state: JobState) {
    self.observe_at(Instant::now(), id, lane, state);
  }

  fn observe_at(self: &Arc<Self>, now: Instant, id: &str, lane: &str, state: JobState) {
    if lane != self.lane { return; }
    let wait = {
      let mut guard = self.locked();
      if state == JobState::Running { guard.running.insert(id.to_owned()); } else { guard.running.remove(id); }
      if !guard.running.is_empty() {
        // An export running cancels any release still pending from the one before it.
        guard.release_at = None;
        if guard.held.is_none() {
          // A refused request is retried on the next notice; it never blocks or fails the export itself.
          guard.held = (self.acquire)(REASON);
          if guard.held.is_some() { log::info!("export keep-awake held while an export runs"); }
        }
        false
      } else if guard.held.is_some() && guard.release_at.is_none() {
        guard.release_at = Some(now + self.grace);
        !std::mem::replace(&mut guard.timer, true)
      } else {
        false
      }
    };
    if wait && !(self.timer)(self.clone()) {
      let mut guard = self.locked();
      guard.timer = false;
      guard.release_at = None;
      if guard.running.is_empty() && guard.held.take().is_some() { log::info!("export keep-awake released"); }
    }
  }

  /// Drops the request once its grace has passed with nothing running. Returns how long to wait before asking again, or None when
  /// nothing is pending any more (and then the caller stops).
  fn tick(&self, now: Instant) -> Option<Duration> {
    let mut guard = self.locked();
    match guard.release_at {
      Some(at) if now < at => Some(at - now),
      Some(_) => {
        guard.release_at = None;
        guard.timer = false;
        if guard.running.is_empty() && guard.held.take().is_some() { log::info!("export keep-awake released after its grace"); }
        None
      }
      None => {
        guard.timer = false;
        None
      }
    }
  }
}

fn wait_then_release(awake: Arc<ExportAwake>) -> bool {
  std::thread::Builder::new().name("export-keep-awake".into()).spawn(move || {
    while let Some(wait) = awake.tick(Instant::now()) { std::thread::sleep(wait); }
  }).is_ok()
}

/// Wraps the supervisor's notifier so every job change also feeds the tracker. The notice itself is forwarded untouched.
pub(super) fn observing(awake: Arc<ExportAwake>, forward: Arc<dyn Fn(Notice) + Send + Sync>) -> Arc<dyn Fn(Notice) + Send + Sync> {
  Arc::new(move |notice| {
    if let Notice::Changed(view) = &notice { awake.observe(&view.id, &view.lane, view.state); }
    forward(notice);
  })
}

#[cfg(windows)]
mod platform {
  use super::Request;
  use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
  use windows_sys::Win32::System::Threading::{POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT};

  // The power-request calls sit behind a windows-sys feature this crate does not enable. Four declarations are cheaper than a
  // new feature in a frozen manifest, and the struct they take keeps its generated layout.
  #[link(name = "kernel32")]
  extern "system" {
    fn PowerCreateRequest(context: *const REASON_CONTEXT) -> HANDLE;
    fn PowerSetRequest(request: HANDLE, kind: i32) -> i32;
    fn PowerClearRequest(request: HANDLE, kind: i32) -> i32;
  }

  /// POWER_REQUEST_TYPE values and POWER_REQUEST_CONTEXT_VERSION, as Windows documents them.
  const SYSTEM_REQUIRED: i32 = 1;
  const EXECUTION_REQUIRED: i32 = 3;
  const CONTEXT_VERSION: u32 = 0;

  struct Held(HANDLE);

  // A power-request handle is a kernel object that any thread may set, clear and close.
  unsafe impl Send for Held {}
  impl Request for Held {}

  impl Drop for Held {
    fn drop(&mut self) {
      unsafe {
        PowerClearRequest(self.0, EXECUTION_REQUIRED);
        PowerClearRequest(self.0, SYSTEM_REQUIRED);
        CloseHandle(self.0);
      }
    }
  }

  /// The system request stops idle sleep. The execution request keeps this process running through Modern Standby's throttling
  /// of desktop apps; Windows 7 has no such type, so a refusal of that one is not a failure.
  pub(super) fn request(reason: &str) -> Option<Box<dyn Request>> {
    let mut text: Vec<u16> = reason.encode_utf16().chain(Some(0)).collect();
    let mut context = REASON_CONTEXT::default();
    context.Version = CONTEXT_VERSION;
    context.Flags = POWER_REQUEST_CONTEXT_SIMPLE_STRING;
    context.Reason.SimpleReasonString = text.as_mut_ptr();
    let handle = unsafe { PowerCreateRequest(&context) };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
      log::warn!("export keep-awake unavailable; the machine may sleep during this export: {}", std::io::Error::last_os_error());
      return None;
    }
    if unsafe { PowerSetRequest(handle, SYSTEM_REQUIRED) } == 0 {
      log::warn!("export keep-awake refused; the machine may sleep during this export: {}", std::io::Error::last_os_error());
      unsafe { CloseHandle(handle) };
      return None;
    }
    unsafe { PowerSetRequest(handle, EXECUTION_REQUIRED) };
    Some(Box::new(Held(handle)))
  }
}

#[cfg(not(windows))]
mod platform {
  use super::Request;

  pub(super) fn request(_reason: &str) -> Option<Box<dyn Request>> { None }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::jobs::{ArtifactIdentity, JobSpec, ProcEvent, Spawner, Supervisor, Workspace};
  use sha2::{Digest, Sha256};
  use std::collections::HashMap;
  use std::sync::atomic::{AtomicUsize, Ordering};

  const TEST_GRACE: Duration = Duration::from_secs(60);

  #[derive(Default)]
  struct Ledger {
    acquired: AtomicUsize,
    released: AtomicUsize,
    timers: AtomicUsize,
  }

  impl Ledger {
    fn held(&self) -> bool { self.acquired.load(Ordering::SeqCst) > self.released.load(Ordering::SeqCst) }
    fn live(&self) -> usize { self.acquired.load(Ordering::SeqCst) - self.released.load(Ordering::SeqCst) }
    fn counts(&self) -> (usize, usize) { (self.acquired.load(Ordering::SeqCst), self.released.load(Ordering::SeqCst)) }
  }

  struct Token(Arc<Ledger>);
  impl Request for Token {}
  impl Drop for Token {
    fn drop(&mut self) { self.0.released.fetch_add(1, Ordering::SeqCst); }
  }

  /// A tracker whose clock and timer the test drives by hand: the timer only counts its requests, and `tick` is called explicitly.
  fn tracker(lane: &'static str) -> (Arc<ExportAwake>, Arc<Ledger>) {
    let ledger = Arc::new(Ledger::default());
    let (made, started) = (ledger.clone(), ledger.clone());
    let acquire: Acquire = Box::new(move |_| {
      made.acquired.fetch_add(1, Ordering::SeqCst);
      Some(Box::new(Token(made.clone())))
    });
    let timer: Timer = Box::new(move |_| { started.timers.fetch_add(1, Ordering::SeqCst); true });
    (ExportAwake::with(lane, acquire, TEST_GRACE, timer), ledger)
  }

  #[test]
  fn a_running_export_holds_the_machine_awake_and_lets_go_a_grace_after_it_ends() {
    let (awake, ledger) = tracker("export");
    let t0 = Instant::now();
    assert!(!ledger.held());
    awake.observe_at(t0, "a", "export", JobState::Running);
    assert!(ledger.held());
    awake.observe_at(t0, "a", "export", JobState::Exited);
    assert!(ledger.held(), "the request outlives the export that took it");
    assert_eq!(awake.tick(t0 + TEST_GRACE - Duration::from_secs(1)), Some(Duration::from_secs(1)));
    assert!(ledger.held(), "one second before the grace ends");
    assert_eq!(awake.tick(t0 + TEST_GRACE), None);
    assert!(!ledger.held(), "dropped once the grace has passed");
    assert_eq!(ledger.counts(), (1, 1));
  }

  #[test]
  fn back_to_back_exports_share_one_request_across_the_gap() {
    let (awake, ledger) = tracker("export");
    let t0 = Instant::now();
    awake.observe_at(t0, "a", "export", JobState::Running);
    awake.observe_at(t0 + Duration::from_secs(10), "a", "export", JobState::Exited);
    assert_eq!(awake.tick(t0 + Duration::from_secs(20)), Some(TEST_GRACE - Duration::from_secs(10)), "ten seconds into the gap the request is still held");
    assert!(ledger.held());
    awake.observe_at(t0 + Duration::from_secs(40), "b", "export", JobState::Running);
    assert_eq!(ledger.counts(), (1, 0), "the next export arrived inside the grace and reuses the request");
    assert_eq!(awake.tick(t0 + Duration::from_secs(10) + TEST_GRACE), None, "the cancelled release does nothing");
    assert!(ledger.held());
    awake.observe_at(t0 + Duration::from_secs(100), "b", "export", JobState::Exited);
    assert_eq!(awake.tick(t0 + Duration::from_secs(100) + TEST_GRACE), None);
    assert_eq!(ledger.counts(), (1, 1));
  }

  #[test]
  fn a_gap_longer_than_the_grace_releases_and_the_next_export_asks_again() {
    let (awake, ledger) = tracker("export");
    let t0 = Instant::now();
    awake.observe_at(t0, "a", "export", JobState::Running);
    awake.observe_at(t0, "a", "export", JobState::Exited);
    assert_eq!(awake.tick(t0 + TEST_GRACE), None);
    assert!(!ledger.held());
    awake.observe_at(t0 + TEST_GRACE * 2, "b", "export", JobState::Running);
    assert_eq!(ledger.counts(), (2, 1));
    assert!(ledger.held());
  }

  #[test]
  fn overlapping_exports_share_one_request_that_outlives_the_first_to_finish() {
    let (awake, ledger) = tracker("export");
    let t0 = Instant::now();
    awake.observe_at(t0, "a", "export", JobState::Running);
    awake.observe_at(t0, "b", "export", JobState::Running);
    assert_eq!(ledger.counts().0, 1, "one request serves every running export");
    awake.observe_at(t0, "a", "export", JobState::Exited);
    assert_eq!(awake.tick(t0 + TEST_GRACE * 10), None, "nothing is pending while the second export still runs");
    assert!(ledger.held());
    awake.observe_at(t0 + TEST_GRACE * 10, "b", "export", JobState::Exited);
    assert_eq!(awake.tick(t0 + TEST_GRACE * 11), None);
    assert!(!ledger.held());
  }

  #[test]
  fn only_a_running_job_of_the_export_lane_counts() {
    let (awake, ledger) = tracker("export");
    let t0 = Instant::now();
    awake.observe_at(t0, "a", "working", JobState::Running);
    awake.observe_at(t0, "b", "export", JobState::Queued);
    assert_eq!(ledger.counts(), (0, 0), "another lane, and a job that has not started, hold nothing");
    awake.observe_at(t0, "b", "export", JobState::Running);
    awake.observe_at(t0, "c", "working", JobState::Exited);
    assert_eq!(awake.tick(t0 + TEST_GRACE * 2), None);
    assert!(ledger.held(), "a non-export job ending cannot release an export's request");
    assert_eq!(ledger.timers.load(Ordering::SeqCst), 0, "nothing was ever idle, so no timer was needed");
  }

  #[test]
  fn repeated_late_and_unknown_notices_are_harmless() {
    let (awake, ledger) = tracker("export");
    let t0 = Instant::now();
    awake.observe_at(t0, "ghost", "export", JobState::Exited);
    awake.observe_at(t0, "a", "export", JobState::Running);
    awake.observe_at(t0, "a", "export", JobState::Running);
    assert_eq!(ledger.counts().0, 1);
    awake.observe_at(t0, "a", "export", JobState::Exited);
    awake.observe_at(t0, "a", "export", JobState::Exited);
    assert_eq!(ledger.timers.load(Ordering::SeqCst), 1, "a second end does not start a second timer");
    assert_eq!(awake.tick(t0 + TEST_GRACE), None);
    assert_eq!(ledger.counts(), (1, 1));
  }

  #[test]
  fn a_refused_request_is_retried_and_never_fails_the_job() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let ledger = Arc::new(Ledger::default());
    let (counted, made) = (attempts.clone(), ledger.clone());
    let acquire: Acquire = Box::new(move |_| {
      if counted.fetch_add(1, Ordering::SeqCst) == 0 { return None; }
      made.acquired.fetch_add(1, Ordering::SeqCst);
      Some(Box::new(Token(made.clone())))
    });
    let awake = ExportAwake::with("export", acquire, TEST_GRACE, Box::new(|_| true));
    let t0 = Instant::now();
    awake.observe_at(t0, "a", "export", JobState::Running);
    assert!(!ledger.held(), "the first request was refused");
    awake.observe_at(t0, "a", "export", JobState::Running);
    assert!(ledger.held(), "the next notice for the still-running export asks again");
  }

  #[test]
  fn a_timer_that_cannot_start_releases_at_once_instead_of_leaking_the_request() {
    let ledger = Arc::new(Ledger::default());
    let made = ledger.clone();
    let acquire: Acquire = Box::new(move |_| { made.acquired.fetch_add(1, Ordering::SeqCst); Some(Box::new(Token(made.clone()))) });
    let awake = ExportAwake::with("export", acquire, TEST_GRACE, Box::new(|_| false));
    awake.observe("a", "export", JobState::Running);
    awake.observe("a", "export", JobState::Exited);
    assert!(!ledger.held(), "with no one to release it later, it is released now");
    assert!(!awake.locked().timer);
    awake.observe("b", "export", JobState::Running);
    assert_eq!(ledger.counts(), (2, 1), "and the next export can still take a new one");
  }

  /// A rule that survives a rewrite: over ANY sequence of notices and timer ticks the machine is held exactly while some export runs
  /// or the grace after the last one has not yet passed, never by more than one request, a pending release always has a timer, and
  /// nothing is left held once every export has ended and the grace is over.
  #[test]
  fn over_random_notice_sequences_the_hold_tracks_the_running_exports_and_the_grace() {
    for seed in 1..=60u64 {
      let (awake, ledger) = tracker("export");
      let mut random = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
      let mut next = move || { random = random.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (random >> 33) as usize };
      let t0 = Instant::now();
      let mut clock = Duration::ZERO;
      let mut running: HashSet<usize> = HashSet::new();
      let mut idle_since: Option<Duration> = None;
      let mut ever_held = false;
      let mut seen = Vec::new();
      for _ in 0..500 {
        clock += Duration::from_secs((next() % 40) as u64);
        let now = t0 + clock;
        if next() % 4 == 0 {
          awake.tick(now);
        } else {
          let (job, lane, state) = (next() % 4, ["export", "working"][next() % 2], [JobState::Queued, JobState::Running, JobState::Exited][next() % 3]);
          awake.observe_at(now, &format!("job-{job}"), lane, state);
          seen.push((clock.as_secs(), job, lane, state));
          if lane == "export" {
            let was_running = !running.is_empty();
            if state == JobState::Running { running.insert(job); } else { running.remove(&job); }
            if running.is_empty() && was_running { idle_since = Some(clock); }
            if !running.is_empty() { idle_since = None; ever_held = true; }
          }
        }
        awake.tick(now);
        let expected = !running.is_empty() || (ever_held && idle_since.is_some_and(|since| clock < since + TEST_GRACE));
        assert_eq!(ledger.held(), expected, "seed {seed} at {}s: {seen:?}", clock.as_secs());
        assert!(ledger.live() <= 1, "seed {seed}: more than one live request");
        let state = awake.locked();
        assert_eq!(state.release_at.is_some(), state.held.is_some() && state.running.is_empty(), "seed {seed}: a release is pending exactly when idle and held");
        assert!(state.release_at.is_none() || state.timer, "seed {seed}: a pending release has no timer");
      }
      for job in 0..4 { awake.observe_at(t0 + clock, &format!("job-{job}"), "export", JobState::Exited); }
      assert_eq!(awake.tick(t0 + clock + TEST_GRACE), None);
      assert!(!ledger.held(), "seed {seed}: left held after every export ended and the grace passed");
      assert_eq!(ledger.counts().0, ledger.counts().1, "seed {seed}");
    }
  }

  fn view(id: &str, lane: &str, state: JobState) -> crate::jobs::JobView {
    crate::jobs::JobView { id: id.into(), lane: lane.into(), state, step: 0, code: None, killed: false, committed: false, meta: serde_json::Value::Null,
      stdout_tail: String::new(), stderr_head: String::new(), stderr_elided: 0, stderr_tail: String::new(), queued_at: 0, started_at: None, ended_at: None }
  }

  #[test]
  fn the_wrapper_forwards_every_notice_untouched_and_feeds_the_tracker() {
    let (awake, ledger) = tracker("export");
    let forwarded = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = forwarded.clone();
    let notify = observing(awake.clone(), Arc::new(move |notice| sink.lock().unwrap().push(match notice {
      Notice::Changed(view) => format!("changed {} {:?}", view.id, view.state),
      Notice::Stdout { id, chunk } => format!("stdout {id} {chunk}"),
    })));
    notify(Notice::Changed(view("a", "export", JobState::Running)));
    notify(Notice::Stdout { id: "a".into(), chunk: "frame=1".into() });
    assert!(ledger.held());
    notify(Notice::Changed(view("a", "export", JobState::Exited)));
    assert_eq!(awake.tick(Instant::now() + TEST_GRACE), None);
    assert!(!ledger.held());
    assert_eq!(*forwarded.lock().unwrap(), ["changed a Running", "stdout a frame=1", "changed a Exited"]);
  }

  #[derive(Default)]
  struct Hands {
    events: Mutex<HashMap<String, Arc<dyn Fn(ProcEvent) + Send + Sync>>>,
  }

  impl Spawner for Hands {
    fn identity(&self, program: &str) -> Result<ArtifactIdentity, String> {
      Ok(ArtifactIdentity { sha256: format!("{:x}", Sha256::digest(program.as_bytes())), size: program.len() as u64 })
    }
    fn spawn(&self, spec: &JobSpec, on_event: Arc<dyn Fn(ProcEvent) + Send + Sync>, _: Arc<Workspace>) -> Result<u32, String> {
      self.events.lock().unwrap().insert(spec.id.clone(), on_event);
      Ok(4242)
    }
    fn kill(&self, id: &str, _: u32) {
      let end = self.events.lock().unwrap().get(id).cloned();
      if let Some(end) = end { end(ProcEvent::Exit(None)); }
    }
  }

  impl Hands {
    fn finish(&self, id: &str, code: i32) {
      let end = self.events.lock().unwrap().get(id).cloned().expect("spawned");
      end(ProcEvent::Exit(Some(code)));
    }
  }

  fn spec(id: &str) -> JobSpec {
    JobSpec { id: id.into(), lane: "working".into(), program: "ffmpeg".into(), args: vec!["-i".into(), "in.mp4".into()], steps: Vec::new(), cwd: None,
      meta: serde_json::json!({}) }
  }

  /// The tracker is fed by the REAL supervisor's notices: it holds while a job runs, bridges the hand-over to the queued one with ONE
  /// request, and lets go a grace after the last ends, whether that job succeeded, failed or was cancelled. Run on a stand-in lane,
  /// because admitted export jobs need a journal; the export lane's own name is what `ExportAwake::new` watches.
  #[test]
  fn a_real_supervisor_holds_the_machine_awake_exactly_while_its_job_runs() {
    for ending in ["succeeds", "fails", "is cancelled"] {
      let (awake, ledger) = tracker("working");
      let hands = Arc::new(Hands::default());
      let supervisor = Supervisor::new(hands.clone(), observing(awake.clone(), Arc::new(|_| {})));
      supervisor.submit(spec("first")).unwrap();
      supervisor.submit(spec("second")).unwrap();
      assert!(ledger.held(), "the first job is running");
      match ending {
        "succeeds" => hands.finish("first", 0),
        "fails" => hands.finish("first", 1),
        _ => assert!(supervisor.kill("first")),
      }
      assert_eq!(supervisor.list().iter().find(|job| job.id == "second").unwrap().state, JobState::Running);
      assert_eq!(ledger.counts(), (1, 0), "the hand-over to the queued job never let go of the request ({ending})");
      hands.finish("second", 0);
      assert!(ledger.held(), "the grace after the last job ({ending})");
      assert_eq!(awake.tick(Instant::now() + TEST_GRACE), None);
      assert!(!ledger.held(), "nothing runs and the grace is over ({ending})");
      assert_eq!(ledger.counts(), (1, 1));
    }
  }

  /// The real timer thread, on a short grace: held right after the export ends, gone shortly after, and a new export asks again.
  #[test]
  fn the_real_timer_thread_releases_the_request_after_the_grace() {
    let ledger = Arc::new(Ledger::default());
    let made = ledger.clone();
    let acquire: Acquire = Box::new(move |_| { made.acquired.fetch_add(1, Ordering::SeqCst); Some(Box::new(Token(made.clone()))) });
    let awake = ExportAwake::with("export", acquire, Duration::from_millis(150), Box::new(wait_then_release));
    awake.observe("a", "export", JobState::Running);
    awake.observe("a", "export", JobState::Exited);
    assert!(ledger.held(), "held at the instant the export ends");
    let began = Instant::now();
    while ledger.held() && began.elapsed() < Duration::from_secs(10) { std::thread::sleep(Duration::from_millis(20)); }
    assert!(!ledger.held(), "the timer thread never released the request");
    assert!(began.elapsed() >= Duration::from_millis(100), "released before its grace: {:?}", began.elapsed());
    awake.observe("b", "export", JobState::Running);
    assert_eq!(ledger.counts(), (2, 1));
    awake.observe("b", "export", JobState::Exited);
    let again = Instant::now();
    while ledger.held() && again.elapsed() < Duration::from_secs(10) { std::thread::sleep(Duration::from_millis(20)); }
    assert!(!ledger.held(), "a second burst is released too");
  }

  #[cfg(windows)]
  fn system_execution_state() -> u32 {
    #[link(name = "powrprof")]
    extern "system" {
      fn CallNtPowerInformation(level: i32, input: *const std::ffi::c_void, input_len: u32, output: *mut std::ffi::c_void, output_len: u32) -> i32;
    }
    const SYSTEM_EXECUTION_STATE: i32 = 16;
    let mut state = 0u32;
    let status = unsafe { CallNtPowerInformation(SYSTEM_EXECUTION_STATE, std::ptr::null(), 0, (&mut state as *mut u32).cast(), 4) };
    assert_eq!(status, 0, "CallNtPowerInformation(SystemExecutionState) failed: {status:#x}");
    state
  }

  #[cfg(windows)]
  fn eventually(what: &str, mut condition: impl FnMut() -> bool) {
    for _ in 0..200 {
      if condition() { return; }
      std::thread::sleep(Duration::from_millis(50));
    }
    panic!("{what}");
  }

  /// The outcome, not the call: ask Windows itself whether a system-required request is in force while the hold lives and after it
  /// is dropped. Another program may legitimately hold its own request, so "gone after the drop" is only asserted when none did.
  #[cfg(windows)]
  #[test]
  fn the_real_request_is_visible_to_windows_while_held_and_gone_after_the_drop() {
    const ES_SYSTEM_REQUIRED: u32 = 1;
    let before = system_execution_state() & ES_SYSTEM_REQUIRED != 0;
    let hold = platform::request(REASON).expect("Windows must grant a power request to an ordinary process");
    eventually("Windows does not report a system-required request while the hold lives", || system_execution_state() & ES_SYSTEM_REQUIRED != 0);
    drop(hold);
    if !before {
      eventually("the system-required request outlived its hold", || system_execution_state() & ES_SYSTEM_REQUIRED == 0);
    }
  }

  /// Everything real at once: the real request, the real timer thread and Windows' own report of both. In force while an export runs
  /// and just after it ends, gone once the grace has passed.
  #[cfg(windows)]
  #[test]
  fn the_real_request_is_dropped_by_the_real_timer_once_the_grace_has_passed() {
    const ES_SYSTEM_REQUIRED: u32 = 1;
    let before = system_execution_state() & ES_SYSTEM_REQUIRED != 0;
    let awake = ExportAwake::with("export", Box::new(platform::request), Duration::from_millis(1500), Box::new(wait_then_release));
    awake.observe("a", "export", JobState::Running);
    eventually("Windows does not report the request while an export runs", || system_execution_state() & ES_SYSTEM_REQUIRED != 0);
    awake.observe("a", "export", JobState::Exited);
    assert!(system_execution_state() & ES_SYSTEM_REQUIRED != 0, "the request must outlive the export that took it");
    if !before {
      eventually("the real timer never dropped the real request", || system_execution_state() & ES_SYSTEM_REQUIRED == 0);
    }
    assert!(awake.locked().held.is_none(), "the tracker still thinks it holds a request");
  }
}
