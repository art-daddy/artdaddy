//! How long the app process has been running, for the start-up timing on the launch marker: the page asks, at the moment
//! its session has settled, and works out how long the process took to get the page in front of the person.
//! One clock per process, set once, first thing in `run()`.

use std::sync::OnceLock;
use std::time::Instant;

pub struct ProcessClock {
  started: OnceLock<Instant>,
}

impl ProcessClock {
  pub const fn new() -> Self {
    Self { started: OnceLock::new() }
  }

  /// Starts the clock. A second call changes nothing: the process started once.
  pub fn mark(&self) {
    let _ = self.started.set(Instant::now());
  }

  /// Milliseconds since `mark`, or None when it was never called (an age nobody can vouch for is not reported as 0).
  pub fn age_ms(&self) -> Option<u64> {
    self
      .started
      .get()
      .map(|started| u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX))
  }
}

static CLOCK: ProcessClock = ProcessClock::new();

/// Called as the first thing `run()` does, before anything slow.
pub fn mark_process_start() {
  CLOCK.mark();
}

#[tauri::command]
pub fn process_age_ms() -> Option<u64> {
  CLOCK.age_ms()
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::Duration;

  #[test]
  fn a_clock_nobody_started_has_no_age_rather_than_a_zero_one() {
    assert_eq!(ProcessClock::new().age_ms(), None);
  }

  #[test]
  fn the_age_grows_from_the_moment_of_the_mark() {
    let clock = ProcessClock::new();
    clock.mark();
    let first = clock.age_ms().expect("started");
    assert!(first < 1_000, "a fresh clock is not old: {first}");
    std::thread::sleep(Duration::from_millis(30));
    let later = clock.age_ms().expect("started");
    assert!(later >= first + 25, "30 ms went by: {first} then {later}");
  }

  #[test]
  fn a_second_mark_does_not_start_the_process_again() {
    let clock = ProcessClock::new();
    clock.mark();
    std::thread::sleep(Duration::from_millis(30));
    clock.mark();
    assert!(clock.age_ms().expect("started") >= 25, "the first mark stands");
  }

  #[test]
  fn the_age_never_goes_backwards() {
    let clock = ProcessClock::new();
    clock.mark();
    let mut last = 0;
    for _ in 0..200 {
      let now = clock.age_ms().expect("started");
      assert!(now >= last);
      last = now;
    }
  }

  // The process's own clock is the one the page asks, and `run()` is what starts it: read the one place both happen.
  #[test]
  fn run_starts_the_clock_before_anything_else_and_hands_the_page_its_age() {
    let source = include_str!("lib.rs");
    let body = source.split("pub fn run() {").nth(1).expect("run() exists");
    let first = body.find("startup::mark_process_start();").expect("run() marks the process start");
    let slow = body.find("fdlimit::raise()").expect("run() raises the file limit");
    assert!(first < slow, "the clock starts before the first thing that does any work");
    assert!(body.contains("startup::process_age_ms"), "the page can ask for the age");
  }
}
