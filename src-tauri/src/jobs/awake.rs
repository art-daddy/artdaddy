//! Keeps the machine awake while an export is in progress.
//!
//! An export is the longest thing the app does and its user usually walks away from it. With no request an idle timer puts the
//! machine to sleep, or into Modern Standby, in the middle of the render. A request holds off ONLY that idle sleep: a closed lid, the
//! power button, a critical battery or an explicit Sleep still win, as the user expects.
//!
//! Two things hold the request. An export job of the export lane that is Running, followed from the supervisor's own job notices
//! however the job ends. And the supervisor's own delivery work between jobs (admitting an export, verifying and publishing it, and
//! re-checking an interrupted copy's source after a restart), which re-reads every source and the finished file to prove them
//! unchanged: minutes on a large project or a slow drive, with no job running, and a machine whose idle timer ran out during the
//! render sleeps the instant nothing holds it. That work takes a counted claim (`ExportAwake::busy`) for exactly as long as it runs.
//! Work that is not export work, such as the recovery pass of an ordinary launch with nothing to recover, takes none.
//!
//! The request is dropped a few minutes AFTER the last of that work ends, not at that instant. Windows does not restart its idle timer
//! when a request is cleared, so a user who left long ago would otherwise have the machine sleep in the seconds between one export and
//! the next of a batch, or between the page's calls to verify and to publish, which is exactly when nothing holds it.
//!
//! Windows only for now: other platforms hold nothing, which is the behaviour they had before this module existed.

use super::{JobState, Notice, EXPORT_LANE};
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
/// Long enough to bridge the page's turnaround between two pieces of export work (the verify and the publish of one export, the next
/// queued export); short enough to cost nothing after the last.
const GRACE: Duration = Duration::from_secs(300);
/// How long a refused request waits before it is asked for again while export work is in progress.
const RETRY: Duration = Duration::from_secs(30);

#[derive(Default)]
struct State {
  running: HashSet<String>,
  /// Supervisor work that is not a job and is in progress now (see `ExportAwake::busy`).
  busy: usize,
  held: Option<Box<dyn Request>>,
  /// When the request is to be dropped if no export work has started by then; Some exactly when something is held and no work runs.
  release_at: Option<Instant>,
  /// When a refused request is next asked for; Some exactly when work runs and nothing could be held.
  retry_at: Option<Instant>,
  /// Something is waiting to call `tick`.
  timer: bool,
}

impl State {
  fn active(&self) -> bool { !self.running.is_empty() || self.busy > 0 }
}

/// Tracks which jobs of one lane are running, and how much other export work is in progress, and holds one OS request while any is,
/// plus the grace after the last.
pub(super) struct ExportAwake {
  lane: &'static str,
  acquire: Acquire,
  grace: Duration,
  timer: Timer,
  /// True where the platform has no request to take: nothing is tracked, no timer is started and nothing is ever retried.
  inert: bool,
  state: Mutex<State>,
}

impl ExportAwake {
  pub(super) fn new() -> Arc<Self> {
    Self::build(EXPORT_LANE, Box::new(platform::request), GRACE, Box::new(wait_then_release), !platform::AVAILABLE)
  }

  #[cfg(test)]
  fn with(lane: &'static str, acquire: Acquire, grace: Duration, timer: Timer) -> Arc<Self> {
    Self::build(lane, acquire, grace, timer, false)
  }

  fn build(lane: &'static str, acquire: Acquire, grace: Duration, timer: Timer, inert: bool) -> Arc<Self> {
    Arc::new(Self { lane, acquire, grace, timer, inert, state: Mutex::new(State::default()) })
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
    self.change(now, |tracked| {
      if state == JobState::Running { tracked.running.insert(id.to_owned()); } else { tracked.running.remove(id); }
    });
  }

  /// A claim on the machine's wakefulness for export work that is not a job and so sends no notice: hashing sources and the finished
  /// file to verify and publish an export, or to admit or recover one. Held until the returned value is dropped, on any path.
  pub(super) fn busy(self: &Arc<Self>) -> Busy {
    self.busy_at(Instant::now())
  }

  fn busy_at(self: &Arc<Self>, now: Instant) -> Busy {
    self.change(now, |tracked| tracked.busy += 1);
    Busy { awake: self.clone(), ended: false }
  }

  /// Applies one change and brings the request in line with it. The timer, when one is now needed, starts outside the lock.
  fn change(self: &Arc<Self>, now: Instant, edit: impl FnOnce(&mut State)) {
    if self.inert { return; }
    let start = {
      let mut guard = self.locked();
      edit(&mut *guard);
      self.settle(&mut guard, now)
    };
    if start && !(self.timer)(self.clone()) {
      // With no one to act later, a request nobody needs is released now and a refused one is not retried; it never fails the export.
      let mut guard = self.locked();
      guard.timer = false;
      guard.release_at = None;
      guard.retry_at = None;
      if !guard.active() && guard.held.take().is_some() { log::info!("export keep-awake released"); }
    }
  }

  /// The one rule: while export work runs hold a request (asking again later if it is refused), and once none does, drop it after the
  /// grace. Returns whether a timer must now be started.
  fn settle(&self, tracked: &mut State, now: Instant) -> bool {
    if tracked.active() {
      // Work running cancels any release still pending from the work before it.
      tracked.release_at = None;
      tracked.retry_at = None;
      if tracked.held.is_none() {
        tracked.held = (self.acquire)(REASON);
        if tracked.held.is_some() { log::info!("export keep-awake held while export work runs"); } else { tracked.retry_at = Some(now + RETRY); }
      }
    } else {
      tracked.retry_at = None;
      if tracked.held.is_some() && tracked.release_at.is_none() { tracked.release_at = Some(now + self.grace); }
    }
    (tracked.release_at.is_some() || tracked.retry_at.is_some()) && !std::mem::replace(&mut tracked.timer, true)
  }

  /// Asks again for a refused request once its wait has passed, and drops the request once its grace has passed with no work running.
  /// Returns how long to wait before asking again, or None when nothing is pending any more (and then the caller stops).
  fn tick(&self, now: Instant) -> Option<Duration> {
    let mut guard = self.locked();
    if guard.retry_at.is_some_and(|at| now >= at) {
      guard.retry_at = None;
      self.settle(&mut guard, now);
    }
    if guard.release_at.is_some_and(|at| now >= at) {
      guard.release_at = None;
      if !guard.active() && guard.held.take().is_some() { log::info!("export keep-awake released after its grace"); }
    }
    let next = guard.release_at.into_iter().chain(guard.retry_at).min().map(|at| at - now);
    if next.is_none() { guard.timer = false; }
    next
  }
}

/// One piece of export work in progress. Dropping it, on any path, ends the claim.
pub(super) struct Busy {
  awake: Arc<ExportAwake>,
  ended: bool,
}

impl Busy {
  fn end_at(&mut self, now: Instant) {
    if !std::mem::replace(&mut self.ended, true) {
      self.awake.change(now, |tracked| tracked.busy = tracked.busy.saturating_sub(1));
    }
  }
}

impl Drop for Busy {
  fn drop(&mut self) {
    self.end_at(Instant::now());
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

  // The power-request calls sit behind a windows-sys feature this crate does not enable. Three declarations are cheaper than a
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

  /// A request can be taken here.
  pub(super) const AVAILABLE: bool = true;

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

  /// No request can be taken here: the tracker is inert, as this platform was before the module existed.
  pub(super) const AVAILABLE: bool = false;

  pub(super) fn request(_reason: &str) -> Option<Box<dyn Request>> { None }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::jobs::{supervisor_with_awake, ArtifactIdentity, DeliverySource, JobSpec, ProcEvent, Spawner, Supervisor, Workspace};
  use sha2::{Digest, Sha256};
  use std::collections::HashMap;
  use std::sync::atomic::{AtomicUsize, Ordering};

  const TEST_GRACE: Duration = Duration::from_secs(60);

  #[derive(Default)]
  struct Ledger {
    acquired: AtomicUsize,
    released: AtomicUsize,
    timers: AtomicUsize,
    /// Every request taken (true) and released (false), with when, for tests that must see WHEN a request let go.
    events: Mutex<Vec<(Instant, bool)>>,
  }

  impl Ledger {
    fn held(&self) -> bool { self.acquired.load(Ordering::SeqCst) > self.released.load(Ordering::SeqCst) }
    fn live(&self) -> usize { self.acquired.load(Ordering::SeqCst) - self.released.load(Ordering::SeqCst) }
    fn counts(&self) -> (usize, usize) { (self.acquired.load(Ordering::SeqCst), self.released.load(Ordering::SeqCst)) }
    fn events(&self) -> Vec<(Instant, bool)> { self.events.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone() }

    /// The OS grants a request.
    fn grant(self: &Arc<Self>) -> Option<Box<dyn Request>> {
      self.acquired.fetch_add(1, Ordering::SeqCst);
      self.events.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push((Instant::now(), true));
      Some(Box::new(Token(self.clone())))
    }
  }

  struct Token(Arc<Ledger>);
  impl Request for Token {}
  impl Drop for Token {
    fn drop(&mut self) {
      self.0.released.fetch_add(1, Ordering::SeqCst);
      self.0.events.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push((Instant::now(), false));
    }
  }

  /// A tracker whose clock and timer the test drives by hand: the timer only counts its requests, and `tick` is called explicitly.
  fn tracker(lane: &'static str) -> (Arc<ExportAwake>, Arc<Ledger>) {
    let ledger = Arc::new(Ledger::default());
    let (made, started) = (ledger.clone(), ledger.clone());
    let acquire: Acquire = Box::new(move |_| made.grant());
    let timer: Timer = Box::new(move |_| { started.timers.fetch_add(1, Ordering::SeqCst); true });
    (ExportAwake::with(lane, acquire, TEST_GRACE, timer), ledger)
  }

  /// Like `tracker`, but the OS refuses the first `refusals` requests before it grants one. Also returns how often it was asked.
  fn stubborn(refusals: usize) -> (Arc<ExportAwake>, Arc<Ledger>, Arc<AtomicUsize>) {
    let asked = Arc::new(AtomicUsize::new(0));
    let ledger = Arc::new(Ledger::default());
    let (counted, made, started) = (asked.clone(), ledger.clone(), ledger.clone());
    let acquire: Acquire = Box::new(move |_| {
      if counted.fetch_add(1, Ordering::SeqCst) < refusals { return None; }
      made.grant()
    });
    let timer: Timer = Box::new(move |_| { started.timers.fetch_add(1, Ordering::SeqCst); true });
    (ExportAwake::with("export", acquire, TEST_GRACE, timer), ledger, asked)
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
  fn a_refused_request_is_asked_for_again_while_the_export_runs() {
    // The supervisor notices an export job only when it is queued, starts and ends, so a request refused when the job starts would
    // otherwise leave the whole export unprotected: the timer asks again.
    let (awake, ledger, asked) = stubborn(2);
    let t0 = Instant::now();
    awake.observe_at(t0, "a", "export", JobState::Running);
    assert!(!ledger.held(), "the first request was refused, and the export itself carries on");
    assert_eq!(ledger.timers.load(Ordering::SeqCst), 1, "a retry needs someone to make it");
    assert_eq!(awake.tick(t0 + RETRY - Duration::from_secs(1)), Some(Duration::from_secs(1)));
    assert_eq!(asked.load(Ordering::SeqCst), 1, "not asked again before the wait is over");
    assert_eq!(awake.tick(t0 + RETRY), Some(RETRY), "refused again: wait the full interval");
    assert_eq!(asked.load(Ordering::SeqCst), 2);
    assert!(!ledger.held());
    assert_eq!(awake.tick(t0 + RETRY * 2), None, "granted: nothing is pending while the export runs");
    assert!(ledger.held());
    awake.observe_at(t0 + RETRY * 2, "a", "export", JobState::Exited);
    assert_eq!(awake.tick(t0 + RETRY * 2 + TEST_GRACE), None);
    assert!(!ledger.held());
    assert_eq!(ledger.counts(), (1, 1));
  }

  #[test]
  fn a_request_that_is_never_granted_leaves_nothing_behind_when_the_export_ends() {
    let (awake, ledger, asked) = stubborn(usize::MAX);
    let t0 = Instant::now();
    awake.observe_at(t0, "a", "export", JobState::Running);
    assert_eq!(awake.tick(t0 + RETRY), Some(RETRY), "still refused, still trying while the export runs");
    awake.observe_at(t0 + RETRY + Duration::from_secs(5), "a", "export", JobState::Exited);
    assert_eq!(awake.tick(t0 + RETRY * 2), None, "the export is over: nothing left to ask for, and the timer stops");
    let state = awake.locked();
    assert!(state.retry_at.is_none() && state.release_at.is_none() && !state.timer && state.held.is_none());
    assert_eq!(asked.load(Ordering::SeqCst), 2, "no further attempts once the export has ended");
    assert_eq!(ledger.counts(), (0, 0));
  }

  #[test]
  fn a_refusal_with_no_timer_to_retry_it_leaves_no_pending_retry() {
    let awake = ExportAwake::with("export", Box::new(|_| None), TEST_GRACE, Box::new(|_| false));
    awake.observe("a", "export", JobState::Running);
    let state = awake.locked();
    assert!(state.retry_at.is_none() && !state.timer, "a retry nobody will run must not be left pending");
    assert!(state.running.contains("a"), "the export is still tracked and will be protected by its next notice");
  }

  /// The gap that matters: the export has rendered for hours, its user left long ago and the machine's idle timer ran out during the
  /// render. The hashing that verifies and publishes it runs with no job, so it must hold a request of its own, however long it takes.
  #[test]
  fn delivery_work_takes_a_fresh_request_after_the_machine_went_idle_and_keeps_it_however_long_it_runs() {
    let (awake, ledger) = tracker("export");
    let t0 = Instant::now();
    awake.observe_at(t0, "render", "export", JobState::Running);
    awake.observe_at(t0 + TEST_GRACE * 100, "render", "export", JobState::Exited);
    let verify_starts = t0 + TEST_GRACE * 102;
    assert_eq!(awake.tick(verify_starts), None, "the page asked for the verification only after the grace had passed");
    assert!(!ledger.held(), "so nothing holds the machine at that moment");
    let mut verify = awake.busy_at(verify_starts);
    assert_eq!(ledger.counts(), (2, 1), "the verification takes a request of its own");
    let verify_ends = verify_starts + TEST_GRACE * 500;
    assert_eq!(awake.tick(verify_ends), None, "and nothing releases it while the hashing runs, however long that takes");
    assert!(ledger.held());
    verify.end_at(verify_ends);
    assert!(ledger.held(), "the page's next call, to publish, follows a moment later");
    assert_eq!(awake.tick(verify_ends + TEST_GRACE - Duration::from_secs(1)), Some(Duration::from_secs(1)));
    let mut publish = awake.busy_at(verify_ends + Duration::from_secs(30));
    assert_eq!(ledger.counts(), (2, 1), "publish arrived inside the grace and reuses the request");
    assert_eq!(awake.tick(verify_ends + TEST_GRACE), None, "the cancelled release does nothing while publish runs");
    assert!(ledger.held());
    let published = verify_ends + Duration::from_secs(90);
    publish.end_at(published);
    assert_eq!(awake.tick(published + TEST_GRACE - Duration::from_secs(1)), Some(Duration::from_secs(1)));
    assert!(ledger.held());
    assert_eq!(awake.tick(published + TEST_GRACE), None);
    assert!(!ledger.held(), "dropped a grace after the last piece of work");
    assert_eq!(ledger.counts(), (2, 2));
  }

  #[test]
  fn a_running_job_and_delivery_work_share_one_request_and_the_last_to_end_starts_the_grace() {
    let (awake, ledger) = tracker("export");
    let t0 = Instant::now();
    awake.observe_at(t0, "a", "export", JobState::Running);
    let mut publishing_the_previous_export = awake.busy_at(t0 + Duration::from_secs(5));
    assert_eq!(ledger.counts(), (1, 0));
    awake.observe_at(t0 + Duration::from_secs(10), "a", "export", JobState::Exited);
    assert_eq!(awake.tick(t0 + TEST_GRACE * 10), None, "the work still runs, so no release is pending");
    assert!(ledger.held());
    publishing_the_previous_export.end_at(t0 + TEST_GRACE * 10);
    assert_eq!(awake.tick(t0 + TEST_GRACE * 11 - Duration::from_secs(1)), Some(Duration::from_secs(1)));
    assert_eq!(awake.tick(t0 + TEST_GRACE * 11), None);
    assert!(!ledger.held());
    let later = t0 + TEST_GRACE * 20;
    let mut admitting = awake.busy_at(later);
    awake.observe_at(later, "b", "export", JobState::Running);
    admitting.end_at(later + Duration::from_secs(5));
    assert_eq!(awake.tick(later + TEST_GRACE * 10), None, "the job still runs after the work before it ended");
    assert!(ledger.held());
    assert_eq!(ledger.counts(), (2, 1));
  }

  #[test]
  fn a_claim_ends_exactly_once_however_it_is_ended_or_dropped() {
    let (awake, ledger) = tracker("export");
    let t0 = Instant::now();
    let mut first = awake.busy_at(t0);
    let second = awake.busy_at(t0);
    assert_eq!(awake.locked().busy, 2);
    assert_eq!(ledger.counts(), (1, 0), "two pieces of work share one request");
    first.end_at(t0 + Duration::from_secs(1));
    first.end_at(t0 + Duration::from_secs(2));
    drop(first);
    assert_eq!(awake.locked().busy, 1, "ending a claim again, or dropping it once ended, must not end the other one");
    assert!(awake.locked().release_at.is_none(), "the other piece of work still runs");
    drop(second);
    assert_eq!(awake.locked().busy, 0);
    assert!(awake.locked().release_at.is_some(), "the last claim to end starts the grace");
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

  /// A rule that survives a rewrite: over ANY sequence of notices, work claims and timer ticks the machine is held exactly while some
  /// export runs or some export work is in progress, or the grace after the last of them has not yet passed, never by more than one
  /// request, a pending release always has a timer, and nothing is left held once everything has ended and the grace is over.
  #[test]
  fn over_random_notice_and_claim_sequences_the_hold_tracks_the_work_and_the_grace() {
    for seed in 1..=60u64 {
      let (awake, ledger) = tracker("export");
      let mut random = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
      let mut next = move || { random = random.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (random >> 33) as usize };
      let t0 = Instant::now();
      let mut clock = Duration::ZERO;
      let mut running: HashSet<usize> = HashSet::new();
      let mut claims: Vec<Busy> = Vec::new();
      let mut idle_since: Option<Duration> = None;
      let mut ever_held = false;
      let mut seen = Vec::new();
      for _ in 0..500 {
        clock += Duration::from_secs((next() % 40) as u64);
        let now = t0 + clock;
        let was_active = !running.is_empty() || !claims.is_empty();
        match next() % 8 {
          0 => { awake.tick(now); seen.push((clock.as_secs(), "tick".to_string())); }
          1 => { claims.push(awake.busy_at(now)); seen.push((clock.as_secs(), "claim".to_string())); }
          2 if !claims.is_empty() => {
            let index = next() % claims.len();
            let mut claim = claims.swap_remove(index);
            claim.end_at(now);
            seen.push((clock.as_secs(), "end claim".to_string()));
          }
          _ => {
            let (job, lane, state) = (next() % 4, ["export", "working"][next() % 2], [JobState::Queued, JobState::Running, JobState::Exited][next() % 3]);
            awake.observe_at(now, &format!("job-{job}"), lane, state);
            seen.push((clock.as_secs(), format!("{lane} job-{job} {state:?}")));
            if lane == "export" { if state == JobState::Running { running.insert(job); } else { running.remove(&job); } }
          }
        }
        let active = !running.is_empty() || !claims.is_empty();
        if active { idle_since = None; ever_held = true; } else if was_active { idle_since = Some(clock); }
        awake.tick(now);
        let expected = active || (ever_held && idle_since.is_some_and(|since| clock < since + TEST_GRACE));
        assert_eq!(ledger.held(), expected, "seed {seed} at {}s: {seen:?}", clock.as_secs());
        assert!(ledger.live() <= 1, "seed {seed}: more than one live request");
        let state = awake.locked();
        assert_eq!(state.busy, claims.len(), "seed {seed}: the tracker's count of claims differs from the claims alive");
        assert_eq!(state.release_at.is_some(), state.held.is_some() && !state.active(), "seed {seed}: a release is pending exactly when idle and held");
        assert!(state.retry_at.is_none(), "seed {seed}: this OS never refuses");
        assert!(state.release_at.is_none() || state.timer, "seed {seed}: a pending release has no timer");
      }
      for job in 0..4 { awake.observe_at(t0 + clock, &format!("job-{job}"), "export", JobState::Exited); }
      for mut claim in claims.drain(..) { claim.end_at(t0 + clock); }
      assert_eq!(awake.tick(t0 + clock + TEST_GRACE), None);
      assert!(!ledger.held(), "seed {seed}: left held after everything ended and the grace passed");
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

  /// The tracker is fed by the REAL supervisor's notices, through the same constructor production uses: it holds while a job runs,
  /// bridges the hand-over to the queued one with ONE request, and lets go a grace after the last ends, whether that job succeeded,
  /// failed or was cancelled. Run on a stand-in lane, because admitted export jobs need a journal.
  #[test]
  fn a_real_supervisor_holds_the_machine_awake_exactly_while_its_job_runs() {
    for ending in ["succeeds", "fails", "is cancelled"] {
      let (awake, ledger) = tracker("working");
      let hands = Arc::new(Hands::default());
      let supervisor = supervisor_with_awake(hands.clone(), Arc::new(|_| {}), awake.clone());
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

  /// Every piece of delivery work the supervisor does between jobs takes a claim on the machine's wakefulness and gives it back on
  /// whatever path it ends. Each is driven on a machine that has gone idle (nothing held), with no journal, so each fails at once:
  /// the claim has to be taken before that, and must not outlive the call.
  #[test]
  fn every_piece_of_delivery_work_takes_a_fresh_claim_on_an_idle_machine_and_gives_it_back() {
    type Work = Box<dyn Fn(&Supervisor)>;
    fn step(call: impl Fn(&Supervisor) + 'static) -> Work { Box::new(call) }
    let export_spec = || JobSpec { id: "export-1".into(), lane: EXPORT_LANE.into(), program: "ffmpeg".into(), args: Vec::new(), steps: Vec::new(),
      cwd: None, meta: serde_json::json!({ "kind": "export" }) };
    let work: Vec<(&str, Work)> = vec![
      ("admitting an export's sources", step(move |supervisor| { assert!(supervisor.submit(export_spec()).is_err()); })),
      ("preparing an export", step(|supervisor| {
        assert!(supervisor.prepare_delivery("not a valid id".into(), String::new(), String::new(), String::new(), DeliverySource::default()).is_err());
      })),
      ("verifying an export", step(|supervisor| { assert!(supervisor.verify_delivery("none").is_err()); })),
      ("publishing an export", step(|supervisor| { assert!(supervisor.publish_delivery("none").is_err()); })),
    ];
    for (name, call) in work {
      let (awake, ledger) = tracker("working");
      let supervisor = supervisor_with_awake(Arc::new(Hands::default()), Arc::new(|_| {}), awake.clone());
      assert_eq!(ledger.counts(), (0, 0), "{name}: the machine starts idle");
      call(&supervisor);
      assert_eq!(ledger.counts().0, 1, "{name} did not hold the machine awake");
      assert_eq!(awake.locked().busy, 0, "{name} kept its claim after it returned");
      assert!(ledger.held(), "{name}: the grace after its work");
      assert_eq!(awake.tick(Instant::now() + TEST_GRACE), None);
      assert!(!ledger.held(), "{name}: nothing is left held once the grace is over");
    }
  }

  /// Admitting a render hashes every source before its job can start. Observed from INSIDE the hashing (the spawner's own identity
  /// check), not just counted afterwards: a claim taken and dropped within the same statement would be counted and still be useless.
  #[test]
  fn admitting_a_render_hashes_its_sources_inside_the_claim() {
    struct Probe { awake: Arc<ExportAwake>, claims_while_hashing: Mutex<Vec<usize>> }
    impl Spawner for Probe {
      fn identity(&self, program: &str) -> Result<ArtifactIdentity, String> {
        Ok(ArtifactIdentity { sha256: format!("{:x}", Sha256::digest(program.as_bytes())), size: program.len() as u64 })
      }
      fn dependency_identity(&self, path: &std::path::Path, check: &dyn Fn() -> Result<(), String>) -> Result<ArtifactIdentity, String> {
        self.claims_while_hashing.lock().unwrap().push(self.awake.locked().busy);
        crate::jobs::artifact_identity_checked(path, check)
      }
      fn spawn(&self, _: &JobSpec, _: Arc<dyn Fn(ProcEvent) + Send + Sync>, _: Arc<Workspace>) -> Result<u32, String> { Ok(4242) }
      fn kill(&self, _: &str, _: u32) {}
    }
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("media.bin");
    std::fs::write(&source, b"actual media bytes").unwrap();
    let (awake, ledger) = tracker("export");
    let probe = Arc::new(Probe { awake: awake.clone(), claims_while_hashing: Mutex::default() });
    let jobs = supervisor_with_awake(probe.clone(), Arc::new(|_| {}), awake.clone())
      .with_export_work_root(dir.path().join("work")).unwrap()
      .with_export_root(dir.path().join("journal")).unwrap();
    let delivery = jobs.prepare_delivery("render-1".into(), "project".into(), dir.path().join("render-1.partial").to_string_lossy().into(),
      dir.path().join("render-1.mp4").to_string_lossy().into(), DeliverySource::Render { paths: Vec::new() }).unwrap();
    let spec = JobSpec { id: delivery.id.clone(), lane: EXPORT_LANE.into(), program: "ffmpeg".into(),
      args: vec!["-i".into(), source.to_string_lossy().into(), delivery.stage_path.clone()], steps: Vec::new(), cwd: None,
      meta: serde_json::json!({ "kind": "export", "plan": { "sources": [{ "path": source }] } }) };
    jobs.retain_render_job(&spec).unwrap();
    assert_eq!(*probe.claims_while_hashing.lock().unwrap(), [1], "the source was hashed outside the supervisor's claim");
    assert_eq!(awake.locked().busy, 0, "the claim outlived the admission");
    assert!(ledger.counts().0 >= 1, "admission took no request");
  }

  /// Not export work, so no claim, however briefly: submitting a transcription, and the recovery pass of every ordinary launch, which
  /// has nothing to recover. A request here would keep the machine awake for the whole grace after every start of the app.
  #[test]
  fn work_that_is_not_export_work_takes_no_claim() {
    let (awake, ledger) = tracker("export");
    let supervisor = supervisor_with_awake(Arc::new(Hands::default()), Arc::new(|_| {}), awake.clone());
    supervisor.submit(spec("not-an-export")).unwrap();
    assert!(supervisor.recover_exports().is_empty());
    assert_eq!(ledger.counts(), (0, 0));
    assert_eq!(awake.locked().busy, 0);
    assert!(ledger.events().is_empty());
  }

  #[test]
  fn the_production_tracker_watches_the_lane_the_supervisor_admits_exports_on() {
    assert_eq!(ExportAwake::new().lane, EXPORT_LANE);
  }

  /// Where no request can be taken (every platform but Windows, for now) the production tracker does nothing at all: it tracks
  /// nothing, starts no timer thread and never retries, which is how those platforms behaved before this module existed.
  #[cfg(not(windows))]
  #[test]
  fn where_no_request_can_be_taken_the_production_tracker_is_inert() {
    let awake = ExportAwake::new();
    awake.observe("a", EXPORT_LANE, JobState::Running);
    let claim = awake.busy();
    {
      let state = awake.locked();
      assert!(state.running.is_empty() && state.busy == 0 && state.held.is_none());
      assert!(!state.timer && state.retry_at.is_none() && state.release_at.is_none());
    }
    drop(claim);
    assert!(!awake.locked().timer);
  }

  /// Runs `work`, waits for the request to be released after it, and returns when the work began and ended and every request event
  /// since it began (true = taken, false = released). No thread watches the work: the ledger stamps the events itself, so a busy
  /// machine cannot make the observation miss its window, and a panic in the work simply fails the test.
  fn watched(ledger: &Ledger, work: impl FnOnce()) -> (Instant, Instant, Vec<(Instant, bool)>) {
    let before = ledger.events().len();
    let began = Instant::now();
    work();
    let ended = Instant::now();
    until_idle(ledger);
    (began, ended, ledger.events().split_off(before))
  }

  fn until_idle(ledger: &Ledger) {
    let began = Instant::now();
    while ledger.held() {
      assert!(began.elapsed() < Duration::from_secs(10), "the request was never released");
      std::thread::sleep(Duration::from_millis(2));
    }
  }

  /// The effect, not the call. Admitting, verifying, publishing and recovering a REAL export hash real files for far longer than the
  /// grace, with no job running (the copy itself is a job and holds its own request); the tracker here runs on its real timer thread
  /// with a grace of milliseconds, so a request that lasted only by the grace would be gone long before the work ends. For each, ONE
  /// request is taken inside the work and let go only after most of the work's length has passed.
  #[test]
  fn real_hashing_with_no_job_running_keeps_the_request_held_for_all_of_it() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("large.bin");
    {
      let chunk: Vec<u8> = (0..1usize << 20).map(|index| (index * 31 + 7) as u8).collect();
      let mut file = std::fs::File::create(&source).unwrap();
      for _ in 0..64 { file.write_all(&chunk).unwrap(); }
    }
    let ledger = Arc::new(Ledger::default());
    let made = ledger.clone();
    let grace = Duration::from_millis(5);
    let awake = ExportAwake::with(EXPORT_LANE, Box::new(move |_| made.grant()), grace, Box::new(wait_then_release));
    let build = || supervisor_with_awake(Arc::new(Hands::default()), Arc::new(|_| {}), awake.clone())
      .with_export_work_root(dir.path().join("work")).unwrap()
      .with_export_root(dir.path().join("journal")).unwrap();
    let jobs = build();
    let places = |id: &str| (dir.path().join(format!("{id}.partial")), dir.path().join(format!("{id}.mp4")));
    let admit = |supervisor: &Supervisor, id: &str, from: &std::path::Path| {
      let (stage, dest) = places(id);
      supervisor.prepare_delivery(id.into(), "project".into(), stage.to_string_lossy().into(), dest.to_string_lossy().into(),
        DeliverySource::Copy { path: from.to_string_lossy().into(), media_ref: "media_large".into() }).unwrap();
    };
    let check = |name: &str, (began, ended, events): (Instant, Instant, Vec<(Instant, bool)>)| {
      let took = ended - began;
      assert!(took >= grace * 4, "{name} took {took:?}: too short to show a request outliving its grace");
      assert_eq!(events.iter().map(|event| event.1).collect::<Vec<_>>(), [true, false], "{name}: one request, taken once and released once");
      let (taken, released) = (events[0].0, events[1].0);
      assert!(taken >= began && taken <= ended, "{name}: the request was not taken by the work itself");
      assert!(released - began >= took.mul_f64(0.6), "{name}: the request was released {:?} into work that took {took:?}", released - began);
    };
    until_idle(&ledger);
    check("admitting a copy export", watched(&ledger, || admit(&jobs, "copy-1", &source)));
    jobs.copy_delivery("copy-1").unwrap();
    until_idle(&ledger);
    check("verifying it", watched(&ledger, || { jobs.verify_delivery("copy-1").unwrap(); }));
    check("publishing it", watched(&ledger, || { jobs.publish_delivery("copy-1").unwrap(); }));
    // The next start of the app finds an export that was admitted and never ran.
    admit(&jobs, "copy-2", &source);
    until_idle(&ledger);
    let restarted = build();
    check("recovering it after a restart", watched(&ledger, || { assert!(restarted.recover_exports().is_empty()); }));
    // And one whose source changed meanwhile: recovery re-reads it, finds it different and refuses. That re-read is all the work
    // there is, and it must hold the request too.
    let changed = dir.path().join("changed.bin");
    std::fs::copy(&source, &changed).unwrap();
    admit(&jobs, "copy-3", &changed);
    std::fs::OpenOptions::new().append(true).open(&changed).unwrap().write_all(b"x").unwrap();
    until_idle(&ledger);
    let restarted_again = build();
    check("re-reading a changed source after a restart", watched(&ledger, || {
      let failures = restarted_again.recover_exports();
      assert!(failures.len() == 1 && failures[0].1.contains("copy source changed"), "unexpected recovery outcome: {failures:?}");
    }));
    assert_eq!(ledger.counts().0, ledger.counts().1, "every request taken was released");
    for id in ["copy-1", "copy-2"] {
      assert_eq!(std::fs::metadata(places(id).1).unwrap().len(), 64 << 20, "{id} really was published");
    }
  }

  /// The real timer thread, on a short grace: gone shortly after the export ends and never before its grace, and a new export asks
  /// again. That the request is still held just after the export ends is asserted on the virtual clock; here it would depend on this
  /// thread not being descheduled for a second.
  #[test]
  fn the_real_timer_thread_releases_the_request_after_the_grace() {
    let ledger = Arc::new(Ledger::default());
    let made = ledger.clone();
    let acquire: Acquire = Box::new(move |_| { made.acquired.fetch_add(1, Ordering::SeqCst); Some(Box::new(Token(made.clone()))) });
    let awake = ExportAwake::with("export", acquire, Duration::from_millis(1000), Box::new(wait_then_release));
    awake.observe("a", "export", JobState::Running);
    awake.observe("a", "export", JobState::Exited);
    let began = Instant::now();
    while ledger.held() && began.elapsed() < Duration::from_secs(10) { std::thread::sleep(Duration::from_millis(20)); }
    assert!(!ledger.held(), "the timer thread never released the request");
    assert!(began.elapsed() >= Duration::from_millis(500), "released before its grace: {:?}", began.elapsed());
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
  /// is dropped. Another program may legitimately hold its own request (the publishing gate does), and then Windows' single aggregate
  /// cannot tell this request from that one: the test says so instead of passing silently as if it had checked.
  #[cfg(windows)]
  #[test]
  fn the_real_request_is_visible_to_windows_while_held_and_gone_after_the_drop() {
    const ES_SYSTEM_REQUIRED: u32 = 1;
    let before = system_execution_state() & ES_SYSTEM_REQUIRED != 0;
    let hold = platform::request(REASON).expect("Windows must grant a power request to an ordinary process");
    eventually("Windows does not report a system-required request while the hold lives", || system_execution_state() & ES_SYSTEM_REQUIRED != 0);
    drop(hold);
    if before {
      eprintln!("another program already held a system-required request, so Windows' report cannot show this request going away here");
    } else {
      eventually("the system-required request outlived its hold", || system_execution_state() & ES_SYSTEM_REQUIRED == 0);
    }
  }

  /// The real request through the tracker, on the virtual clock so no wall-clock margin can fail it: in force while an export runs
  /// and just after it ends, gone once the grace has passed. The tracker's own account is asserted unconditionally; Windows' report
  /// only when no other program holds a request of its own.
  #[cfg(windows)]
  #[test]
  fn the_real_request_follows_an_export_through_the_tracker_and_is_gone_after_the_grace() {
    const ES_SYSTEM_REQUIRED: u32 = 1;
    let before = system_execution_state() & ES_SYSTEM_REQUIRED != 0;
    let awake = ExportAwake::with("export", Box::new(platform::request), TEST_GRACE, Box::new(|_| true));
    let t0 = Instant::now();
    awake.observe_at(t0, "a", "export", JobState::Running);
    assert!(awake.locked().held.is_some(), "Windows refused a power request to an ordinary process");
    eventually("Windows does not report the request while an export runs", || system_execution_state() & ES_SYSTEM_REQUIRED != 0);
    awake.observe_at(t0, "a", "export", JobState::Exited);
    assert!(awake.locked().held.is_some(), "the request must outlive the export that took it");
    assert!(system_execution_state() & ES_SYSTEM_REQUIRED != 0, "Windows stopped reporting the request before its grace was over");
    assert_eq!(awake.tick(t0 + TEST_GRACE), None);
    assert!(awake.locked().held.is_none(), "the tracker kept the request past its grace");
    if before {
      eprintln!("another program already held a system-required request, so Windows' report cannot show this request going away here");
    } else {
      eventually("Windows still reports the request after the tracker dropped it", || system_execution_state() & ES_SYSTEM_REQUIRED == 0);
    }
  }

  /// Delivery work holds a real request too, with no job running at all.
  #[cfg(windows)]
  #[test]
  fn the_real_request_is_held_for_delivery_work_with_no_job_running() {
    const ES_SYSTEM_REQUIRED: u32 = 1;
    let before = system_execution_state() & ES_SYSTEM_REQUIRED != 0;
    let awake = ExportAwake::with("export", Box::new(platform::request), TEST_GRACE, Box::new(|_| true));
    let t0 = Instant::now();
    let mut verifying = awake.busy_at(t0);
    assert!(awake.locked().held.is_some(), "delivery work took no real request");
    eventually("Windows does not report the request while delivery work runs", || system_execution_state() & ES_SYSTEM_REQUIRED != 0);
    verifying.end_at(t0 + Duration::from_secs(1));
    assert_eq!(awake.tick(t0 + Duration::from_secs(1) + TEST_GRACE), None);
    assert!(awake.locked().held.is_none());
    if !before {
      eventually("Windows still reports the request after delivery work ended and its grace passed", || system_execution_state() & ES_SYSTEM_REQUIRED == 0);
    }
  }

  /// The production constructor is wired to the real request: a running export job takes one.
  #[cfg(windows)]
  #[test]
  fn the_production_tracker_takes_a_real_request_for_a_running_export_job() {
    let awake = ExportAwake::new();
    awake.observe("job", EXPORT_LANE, JobState::Running);
    assert!(awake.locked().held.is_some(), "the production tracker holds nothing for a running export job on Windows");
  }

  /// Everything real at once: the real request, the real timer thread and Windows' own report of both, until the request is gone. The
  /// moments just after the export ends are asserted on the virtual clock above, where no wall-clock margin can fail them.
  #[cfg(windows)]
  #[test]
  fn the_real_request_is_dropped_by_the_real_timer_once_the_grace_has_passed() {
    const ES_SYSTEM_REQUIRED: u32 = 1;
    let before = system_execution_state() & ES_SYSTEM_REQUIRED != 0;
    let awake = ExportAwake::with("export", Box::new(platform::request), Duration::from_millis(1500), Box::new(wait_then_release));
    awake.observe("a", "export", JobState::Running);
    eventually("Windows does not report the request while an export runs", || system_execution_state() & ES_SYSTEM_REQUIRED != 0);
    awake.observe("a", "export", JobState::Exited);
    eventually("the real timer never let go of the request", || awake.locked().held.is_none());
    if before {
      eprintln!("another program already held a system-required request, so Windows' report cannot show this request going away here");
    } else {
      eventually("Windows still reports the request after the real timer dropped it", || system_execution_state() & ES_SYSTEM_REQUIRED == 0);
    }
  }
}
