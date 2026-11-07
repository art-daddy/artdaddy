//! A mark for the signal that ends the app, so the next start can say why it ended on macOS and Linux.
//!
//! Windows keeps an event log that names why a program ended; macOS and Linux keep none the app may read. So when a signal that
//! ends a process reaches the app, a handler writes ONE word of `os_exit_cause::unix_end::SIGNAL_WORDS` to a file opened at start
//! (`exit-<launch>.mark`, in the health folder) and then lets the signal do exactly what it would have done. The next start reads
//! that word only if the session also left no exit mark (`runtime_health.rs`), and only a word of a fixed list ever leaves the PC.
//!
//! What a handler may do is small, and this one stays inside it: it reads atomics, writes a static byte string to a descriptor
//! that was opened for the life of the process, and calls `signal`, `raise` or the previous handler. No allocation, no lock, no
//! logging. It never swallows a signal: if somebody handled the signal before, that handler runs as it would have; if nobody did,
//! the default action is restored and the signal sent again, so the process dies of the same signal, and the system still makes
//! its own record of it (a core file, a crash report, the status its parent sees). A signal that was ignored stays ignored.

use std::ffi::c_void;
use std::os::raw::c_int;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::IntoRawFd;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicUsize, Ordering};

use crate::os_exit_cause::unix_end::marker_file_name;

/// Set it to anything to start without the marks (a way out if a handler ever disagrees with something on a PC).
const OFF: &str = "ARTDADDY_NO_EXIT_MARKS";

/// The signals that end a process, each with the word written for it and its newline: the crash signals, the abort a panic ends in,
/// and the requests to end (the system shutting down, a closed terminal, a person at a terminal).
pub(crate) const SIGNALS: [(c_int, &[u8]); 9] = [
  (libc::SIGSEGV, b"signal_segv\n"),
  (libc::SIGBUS, b"signal_bus\n"),
  (libc::SIGILL, b"signal_ill\n"),
  (libc::SIGFPE, b"signal_fpe\n"),
  (libc::SIGABRT, b"signal_abrt\n"),
  (libc::SIGTERM, b"signal_term\n"),
  (libc::SIGHUP, b"signal_hup\n"),
  (libc::SIGINT, b"signal_int\n"),
  (libc::SIGQUIT, b"signal_quit\n"),
];

static INSTALLED: AtomicBool = AtomicBool::new(false);
static MARK_FD: AtomicI32 = AtomicI32::new(-1);
// What each signal did before the handler took it: the address (0 is the default action, 1 is "ignore") and its flags.
static PREVIOUS_HANDLER: [AtomicUsize; 9] = [
  AtomicUsize::new(0),
  AtomicUsize::new(0),
  AtomicUsize::new(0),
  AtomicUsize::new(0),
  AtomicUsize::new(0),
  AtomicUsize::new(0),
  AtomicUsize::new(0),
  AtomicUsize::new(0),
  AtomicUsize::new(0),
];
static PREVIOUS_FLAGS: [AtomicI32; 9] = [
  AtomicI32::new(0),
  AtomicI32::new(0),
  AtomicI32::new(0),
  AtomicI32::new(0),
  AtomicI32::new(0),
  AtomicI32::new(0),
  AtomicI32::new(0),
  AtomicI32::new(0),
  AtomicI32::new(0),
];

extern "C" fn on_signal(signal: c_int, info: *mut libc::siginfo_t, context: *mut c_void) {
  let Some(slot) = SIGNALS.iter().position(|(number, _)| *number == signal) else {
    return;
  };
  let fd = MARK_FD.load(Ordering::Relaxed);
  if fd >= 0 {
    let word = SIGNALS[slot].1;
    // SAFETY: a write of a static byte string to a descriptor that stays open for the life of the process. Its result is not
    // used: a mark that could not be written must not change what the signal does.
    unsafe { libc::write(fd, word.as_ptr().cast(), word.len()) };
  }
  let previous = PREVIOUS_HANDLER[slot].load(Ordering::Relaxed);
  if previous != libc::SIG_DFL && previous != libc::SIG_IGN {
    // Somebody handled this signal before the app did, and still does, exactly as they would have.
    let flags = PREVIOUS_FLAGS[slot].load(Ordering::Relaxed);
    // SAFETY: the address is the handler `sigaction` reported for this signal, called with the signature its flags say it has.
    unsafe {
      if flags & libc::SA_SIGINFO != 0 {
        let handler: extern "C" fn(c_int, *mut libc::siginfo_t, *mut c_void) = std::mem::transmute(previous);
        handler(signal, info, context);
      } else {
        let handler: extern "C" fn(c_int) = std::mem::transmute(previous);
        handler(signal);
      }
    }
    return;
  }
  // Nobody did: the default action, as if the app had never been in the way. Delivered again, it ends the process the way the
  // signal would have, and the system keeps its own record of that.
  // SAFETY: `signal` and `raise` may be called from a handler.
  unsafe {
    libc::signal(signal, libc::SIG_DFL);
    libc::raise(signal);
  }
}

/// Opens the mark for this launch and takes the signals. Safe to call twice (the second call does nothing). On an error nothing was
/// taken and every signal does what it always did. Does nothing when `ARTDADDY_NO_EXIT_MARKS` is set.
pub fn install(dir: &Path, launch_id: &str) -> std::io::Result<()> {
  if std::env::var_os(OFF).is_some() {
    return Ok(());
  }
  // Opened here, so the handler only ever writes: `open` is not something a handler may do. Close-on-exec by default, so no child
  // process the app starts keeps it.
  let file = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .mode(0o600)
    .open(dir.join(marker_file_name(launch_id)))?;
  if INSTALLED.swap(true, Ordering::SeqCst) {
    return Ok(());
  }
  MARK_FD.store(file.into_raw_fd(), Ordering::SeqCst);
  for (slot, (signal, _)) in SIGNALS.iter().enumerate() {
    // SAFETY: both are plain C structs filled in before use; `sigaction` reports what the signal did and then takes it.
    unsafe {
      let mut previous: libc::sigaction = std::mem::zeroed();
      if libc::sigaction(*signal, std::ptr::null(), &mut previous) != 0 {
        continue;
      }
      // Someone chose to ignore this signal (a program started with `nohup` ignores the hang-up): so does the app.
      if previous.sa_sigaction == libc::SIG_IGN {
        continue;
      }
      PREVIOUS_HANDLER[slot].store(previous.sa_sigaction, Ordering::SeqCst);
      PREVIOUS_FLAGS[slot].store(previous.sa_flags, Ordering::SeqCst);
      let mut ours: libc::sigaction = std::mem::zeroed();
      ours.sa_sigaction = on_signal as extern "C" fn(c_int, *mut libc::siginfo_t, *mut c_void) as libc::sighandler_t;
      // On the alternate stack where there is one: a stack that ran out is a stack the handler cannot use.
      ours.sa_flags = libc::SA_SIGINFO | libc::SA_ONSTACK;
      libc::sigemptyset(&mut ours.sa_mask);
      libc::sigaction(*signal, &ours, std::ptr::null_mut());
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::os_exit_cause::unix_end::{read_marker, SIGNAL_WORDS};
  use std::io::{BufRead, BufReader};
  use std::os::unix::process::ExitStatusExt;
  use std::path::PathBuf;
  use std::process::{Command, ExitStatus, Stdio};

  const SCENARIO: &str = "ARTDADDY_EXIT_SIGNAL_SCENARIO";
  const FOLDER: &str = "ARTDADDY_EXIT_SIGNAL_FOLDER";
  const LAUNCH: &str = "child";

  fn child_command(scenario: &str, dir: &Path) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
      .args(["--exact", "exit_signal::tests::child", "--nocapture", "--test-threads=1"])
      .env(SCENARIO, scenario)
      .env(FOLDER, dir)
      .env_remove(OFF);
    command
  }

  /// Runs this test binary again as a child that does `scenario`, so a signal can end a process for real.
  fn run_child(scenario: &str, dir: &Path) -> ExitStatus {
    child_command(scenario, dir).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap()
  }

  fn word_of(dir: &Path) -> Option<&'static str> {
    read_marker(dir, LAUNCH).map(|marker| marker.word)
  }

  /// The child's side. Does nothing unless this binary was started as a child.
  #[test]
  fn child() {
    let Ok(scenario) = std::env::var(SCENARIO) else { return };
    let dir = PathBuf::from(std::env::var(FOLDER).unwrap());
    // SAFETY: plain signal calls in a process that exists to be ended by them.
    unsafe {
      match scenario.as_str() {
        "ignored" => {
          libc::signal(libc::SIGHUP, libc::SIG_IGN);
        }
        "chained" => {
          extern "C" fn theirs(_: c_int) {
            // Their handler, installed before the app's: it leaves a file so the test can see it ran.
            let dir = std::env::var(FOLDER).unwrap();
            std::fs::write(Path::new(&dir).join("theirs-ran"), b"1").unwrap();
          }
          libc::signal(libc::SIGTERM, theirs as extern "C" fn(c_int) as libc::sighandler_t);
        }
        // A test runner started in the background of a shell inherits "ignore" for the interrupt: every other scenario starts
        // from the default action, which is the disposition a desktop app is launched with.
        _ => {
          for signal in [libc::SIGTERM, libc::SIGHUP, libc::SIGINT, libc::SIGQUIT] {
            libc::signal(signal, libc::SIG_DFL);
          }
        }
      }
    }
    let installed = install(&dir, LAUNCH);
    // SAFETY: as above.
    unsafe {
      match scenario.as_str() {
        "segv" => std::ptr::write_volatile(std::ptr::null_mut::<u8>(), 1),
        "ill" => {
          libc::raise(libc::SIGILL);
        }
        "fpe" => {
          libc::raise(libc::SIGFPE);
        }
        "abrt" => libc::abort(),
        "term" | "chained" | "twice" | "off" | "unwritable" => {
          if scenario == "twice" {
            let other = dir.join("second");
            std::fs::create_dir_all(&other).unwrap();
            install(&other, LAUNCH).unwrap();
          }
          if scenario == "unwritable" {
            assert!(installed.is_err());
          }
          libc::raise(libc::SIGTERM);
        }
        "hup" | "ignored" => {
          libc::raise(libc::SIGHUP);
        }
        "int" => {
          libc::raise(libc::SIGINT);
        }
        "quit" => {
          libc::raise(libc::SIGQUIT);
        }
        "cloexec" => {
          let flags = libc::fcntl(MARK_FD.load(Ordering::SeqCst), libc::F_GETFD);
          std::process::exit(if flags >= 0 && flags & libc::FD_CLOEXEC != 0 { 0 } else { 1 });
        }
        "wait" => {
          println!("READY");
          std::thread::sleep(std::time::Duration::from_secs(60));
        }
        other => panic!("no scenario {other}"),
      }
    }
    // Reached only when the signal did not end the process: handled by somebody else, or ignored.
    std::process::exit(if scenario == "chained" && !dir.join("theirs-ran").exists() { 2 } else { 99 });
  }

  #[test]
  fn the_words_a_handler_writes_are_exactly_the_words_the_reader_believes() {
    let written: Vec<String> =
      SIGNALS.iter().map(|(_, word)| String::from_utf8(word.to_vec()).unwrap().trim_end().to_string()).collect();
    assert_eq!(written, SIGNAL_WORDS.iter().map(|word| word.to_string()).collect::<Vec<_>>());
    let mut numbers: Vec<c_int> = SIGNALS.iter().map(|(number, _)| *number).collect();
    numbers.sort_unstable();
    numbers.dedup();
    assert_eq!(numbers.len(), SIGNALS.len());
  }

  #[test]
  fn a_crash_leaves_its_word_and_the_process_still_dies_of_the_crash() {
    // A real fault, not a signal sent by hand: that is what a crash is, and it is what the runtime's own handler is in the way of.
    let dir = tempfile::tempdir().unwrap();
    let status = run_child("segv", dir.path());
    assert_eq!(status.signal(), Some(libc::SIGSEGV), "{status:?}");
    assert_eq!(word_of(dir.path()), Some("signal_segv"));
  }

  #[test]
  fn each_signal_that_ends_a_process_leaves_its_word_and_ends_it_as_it_always_did() {
    for (scenario, signal, word) in [
      ("ill", libc::SIGILL, "signal_ill"),
      ("fpe", libc::SIGFPE, "signal_fpe"),
      ("abrt", libc::SIGABRT, "signal_abrt"),
      ("term", libc::SIGTERM, "signal_term"),
      ("hup", libc::SIGHUP, "signal_hup"),
      ("int", libc::SIGINT, "signal_int"),
      ("quit", libc::SIGQUIT, "signal_quit"),
    ] {
      let dir = tempfile::tempdir().unwrap();
      let status = run_child(scenario, dir.path());
      assert_eq!(status.signal(), Some(signal), "{scenario}: {status:?}");
      assert_eq!(word_of(dir.path()), Some(word), "{scenario}");
    }
  }

  #[test]
  fn a_signal_somebody_else_handles_still_reaches_them_and_the_process_carries_on() {
    let dir = tempfile::tempdir().unwrap();
    let status = run_child("chained", dir.path());
    assert_eq!(status.code(), Some(99), "{status:?}");
    assert!(dir.path().join("theirs-ran").exists(), "their handler must still run");
    assert_eq!(word_of(dir.path()), Some("signal_term"));
  }

  #[test]
  fn a_signal_that_is_ignored_stays_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let status = run_child("ignored", dir.path());
    assert_eq!(status.code(), Some(99), "{status:?}");
    assert_eq!(word_of(dir.path()), None);
  }

  #[test]
  fn a_kill_that_cannot_be_caught_leaves_no_word() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = child_command("wait", dir.path()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    while !line.contains("READY") {
      line.clear();
      assert!(out.read_line(&mut line).unwrap() > 0, "the child never got ready");
    }
    child.kill().unwrap();
    let status = child.wait().unwrap();
    assert_eq!(status.signal(), Some(libc::SIGKILL), "{status:?}");
    assert_eq!(word_of(dir.path()), None);
    assert!(dir.path().join(marker_file_name(LAUNCH)).exists(), "the mark itself was made at start");
  }

  #[test]
  fn the_mark_is_not_inherited_by_what_the_app_starts() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(run_child("cloexec", dir.path()).code(), Some(0));
  }

  #[test]
  fn installing_twice_changes_nothing_and_the_first_mark_keeps_the_word() {
    let dir = tempfile::tempdir().unwrap();
    let status = run_child("twice", dir.path());
    assert_eq!(status.signal(), Some(libc::SIGTERM), "{status:?}");
    assert_eq!(word_of(dir.path()), Some("signal_term"));
    assert_eq!(read_marker(&dir.path().join("second"), LAUNCH).map(|marker| marker.word), None);
  }

  #[test]
  fn a_mark_that_cannot_be_opened_takes_nothing_and_every_signal_does_what_it_always_did() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("no-such-folder");
    let status = run_child("unwritable", &missing);
    assert_eq!(status.signal(), Some(libc::SIGTERM), "{status:?}");
    assert!(!missing.exists());
  }

  #[test]
  fn the_way_out_leaves_everything_as_it_was() {
    let dir = tempfile::tempdir().unwrap();
    let status = child_command("off", dir.path()).env(OFF, "1").stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap();
    assert_eq!(status.signal(), Some(libc::SIGTERM), "{status:?}");
    assert!(!dir.path().join(marker_file_name(LAUNCH)).exists(), "not even the mark is made");
  }
}
