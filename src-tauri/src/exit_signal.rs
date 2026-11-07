//! A mark for the signal that ends the app, so the next start can say why it ended on macOS and Linux.
//!
//! Windows keeps an event log that names why a program ended; macOS and Linux keep none the app may read. So when a signal that
//! ends a process reaches the app, a handler writes ONE word of `os_exit_cause::unix_end::SIGNAL_WORDS` to a file opened at start
//! (`exit-<launch>.mark`, in the health folder) and then lets the signal do exactly what it would have done. The next start reads
//! that word only if the session also left no exit mark (`runtime_health.rs`), and only a word of a fixed list ever leaves the PC.
//!
//! What a handler may do is small, and this one stays inside it: it reads atomics, writes a static byte string to a descriptor
//! that was opened for the life of the process, and calls `signal`, `raise` or the previous handler. No allocation, no lock, no
//! logging.
//!
//! It does not change what a signal does, with one exception it cannot close: if another thread sets the handler of the same
//! signal in the few instructions between the app reading it and taking it (nothing does that while the app starts), the app's
//! handler is taken with the mask and flags of what it read, and an ignore set in that instant is passed on as "do nothing" rather
//! than as an ignore. Two kinds of signal are taken differently:
//!  * the crash signals (SIGSEGV, SIGBUS, SIGILL, SIGFPE) and the abort a panic or a stack overflow ends in (SIGABRT) end the
//!    process anyway. The runtime has its own handler for the first two (it recognises a stack overflow), so the app's handler
//!    takes the signal under the same mask and flags as what was there (the alternate stack is added only where nothing was
//!    there: a handler that did not ask for one is not given one), runs first, and passes the signal on to what was there, called
//!    as it would have been; with nothing there it restores the default and sends the signal again, so the process dies of the
//!    same signal and the system makes its own record of it (a core file, a crash report, the status its parent sees). What it
//!    passes on to is recorded BEFORE the kernel is told to call the app's handler, so there is no instant at which a signal
//!    finds nothing recorded;
//!  * the requests to end (SIGTERM, SIGHUP, SIGINT, SIGQUIT) are taken ONLY when nobody handles them: a handler somebody else
//!    installed carries a signal mask and flags (restart a system call, reset after one use) that cannot be copied faithfully
//!    from here, so it is left alone and that signal leaves no mark. A signal that is ignored stays ignored.

use std::ffi::c_void;
use std::os::raw::c_int;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::IntoRawFd;
use std::path::Path;
use std::sync::atomic::{AtomicI32, AtomicPtr, Ordering};
use std::sync::Mutex;

use crate::os_exit_cause::unix_end::marker_file_name;

/// Set it to anything to start without the marks (a way out if a handler ever disagrees with something on a PC).
const OFF: &str = "ARTDADDY_NO_EXIT_MARKS";

/// The signals that end a process: the word written for each (with its newline) and whether it is a crash, which the app's handler
/// passes on to what was there before it. The requests to end (the system shutting down, a closed terminal, a person at a
/// terminal) are taken only from the default action.
pub(crate) const SIGNALS: [(c_int, &[u8], bool); 9] = [
  (libc::SIGSEGV, b"signal_segv\n", true),
  (libc::SIGBUS, b"signal_bus\n", true),
  (libc::SIGILL, b"signal_ill\n", true),
  (libc::SIGFPE, b"signal_fpe\n", true),
  (libc::SIGABRT, b"signal_abrt\n", true),
  (libc::SIGTERM, b"signal_term\n", false),
  (libc::SIGHUP, b"signal_hup\n", false),
  (libc::SIGINT, b"signal_int\n", false),
  (libc::SIGQUIT, b"signal_quit\n", false),
];

/// Whether the handlers have been installed. A lock, not a flag, so a second caller waits for the first and never sees "done" for an
/// install that then failed. The handler itself never touches it: it reads only the atomics below.
static INSTALLED: Mutex<bool> = Mutex::new(false);
static MARK_FD: AtomicI32 = AtomicI32::new(-1);

/// What a signal did before the app took it: the address of its handler (0 is the default action, 1 is "ignore") and its flags.
struct Previous {
  handler: libc::sighandler_t,
  flags: c_int,
}

#[allow(clippy::declare_interior_mutable_const)] // only ever used to fill the array below
const NOT_TAKEN: AtomicPtr<Previous> = AtomicPtr::new(std::ptr::null_mut());
/// One slot per signal of `SIGNALS`, null until that signal is taken. A record is never changed and never freed (a correction is a
/// new record), so a handler may read it, and its two fields are published by ONE store: a handler never sees half of a change.
static PREVIOUS: [AtomicPtr<Previous>; SIGNALS.len()] = [NOT_TAKEN; SIGNALS.len()];

fn record(slot: usize, handler: libc::sighandler_t, flags: c_int) {
  PREVIOUS[slot].store(Box::into_raw(Box::new(Previous { handler, flags })), Ordering::Release);
}

/// The flags the app's handler takes a signal with. Those of what it replaces, so the kernel treats the app's handler as it
/// treated that one (restart a system call, reset after one use, run on the alternate stack), plus the extra information the
/// handler passes on. The alternate stack is added only where nothing handled the signal: a handler that did not ask for one is
/// not given one. (The runtime's handler for a stack overflow did ask, so it keeps it.)
fn flags_for(replaced_handler: libc::sighandler_t, replaced_flags: c_int) -> c_int {
  replaced_flags | libc::SA_SIGINFO | if replaced_handler == libc::SIG_DFL { libc::SA_ONSTACK } else { 0 }
}

extern "C" fn on_signal(signal: c_int, info: *mut libc::siginfo_t, context: *mut c_void) {
  let Some(slot) = SIGNALS.iter().position(|(number, _, _)| *number == signal) else {
    return;
  };
  // SAFETY: null, or a record `record` leaked: it is never changed or freed, so reading it here is sound.
  let previous = unsafe { PREVIOUS[slot].load(Ordering::Acquire).as_ref() };
  let (address, flags) = previous.map_or((libc::SIG_DFL, 0), |previous| (previous.handler, previous.flags));
  // Ignored by whoever had it before: ignored it stays (the process does not end, so there is nothing to mark). Only reachable if
  // somebody changed the signal between the app choosing to take it and taking it.
  if address == libc::SIG_IGN {
    return;
  }
  let fd = MARK_FD.load(Ordering::Relaxed);
  if fd >= 0 {
    let word = SIGNALS[slot].1;
    // SAFETY: a write of a static byte string to a descriptor that stays open for the life of the process. Its result is not
    // used: a mark that could not be written must not change what the signal does.
    unsafe { libc::write(fd, word.as_ptr().cast(), word.len()) };
  }
  if address != libc::SIG_DFL {
    // Somebody handled this signal before the app did, and still does, exactly as they would have.
    // SAFETY: the address is the handler `sigaction` reported for this signal, called with the signature its flags say it has.
    unsafe {
      if flags & libc::SA_SIGINFO != 0 {
        let handler: extern "C" fn(c_int, *mut libc::siginfo_t, *mut c_void) = std::mem::transmute(address);
        handler(signal, info, context);
      } else {
        let handler: extern "C" fn(c_int) = std::mem::transmute(address);
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

/// Opens the mark for this launch and takes the signals. Safe to call twice, from any thread: the second call waits for the first
/// and then does nothing, not even open a file. On an error nothing was taken and every signal does what it always did. Does
/// nothing when `ARTDADDY_NO_EXIT_MARKS` is set.
pub fn install(dir: &Path, launch_id: &str) -> std::io::Result<()> {
  if std::env::var_os(OFF).is_some() {
    return Ok(());
  }
  let mut done = INSTALLED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
  if *done {
    return Ok(());
  }
  // Opened here, so the handler only ever writes: `open` is not something a handler may do. Close-on-exec by default, so no child
  // process the app starts keeps it.
  let file = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .mode(0o600)
    .open(dir.join(marker_file_name(launch_id)))?;
  MARK_FD.store(file.into_raw_fd(), Ordering::SeqCst);
  for (slot, (signal, _, crash)) in SIGNALS.iter().enumerate() {
    // SAFETY: both are plain C structs filled in before use; `sigaction` reports what the signal did and then takes it.
    unsafe {
      let mut before: libc::sigaction = std::mem::zeroed();
      if libc::sigaction(*signal, std::ptr::null(), &mut before) != 0 {
        continue;
      }
      // Someone chose to ignore this signal (a program started with `nohup` ignores the hang-up): so does the app. A request to
      // end that somebody handles is theirs (see the top of this file): it is left as it is.
      if before.sa_sigaction == libc::SIG_IGN || (!*crash && before.sa_sigaction != libc::SIG_DFL) {
        continue;
      }
      // Ours behaves for the kernel as what it replaces did (see `flags_for`): the same mask of signals held while it runs and the
      // same flags, so passing the signal on is as faithful as a call can be.
      let mut ours: libc::sigaction = std::mem::zeroed();
      ours.sa_sigaction = on_signal as extern "C" fn(c_int, *mut libc::siginfo_t, *mut c_void) as libc::sighandler_t;
      ours.sa_mask = before.sa_mask;
      ours.sa_flags = flags_for(before.sa_sigaction, before.sa_flags);
      // What the signal is passed on to is recorded BEFORE ours is taken. Until the call below the kernel does not call ours, so
      // nothing reads the record yet, and from the instant it does the record is already there: no instant at which a signal finds
      // nothing recorded and ends the process as the default action would, past a handler that should have seen it first.
      record(slot, before.sa_sigaction, before.sa_flags);
      let mut replaced: libc::sigaction = std::mem::zeroed();
      if libc::sigaction(*signal, &ours, &mut replaced) != 0 {
        continue;
      }
      // The one call that takes the signal also reports what it took it from. If that is not what was read above, somebody
      // changed it in between (not a thing that happens while the app starts, but the record must not stay wrong if it does): what
      // is passed on to becomes what was really replaced. In that case only, a signal in the instants before this line goes to what
      // was read first, never to nothing; and nothing is ever put back over somebody else's later handler.
      if replaced.sa_sigaction != before.sa_sigaction || replaced.sa_flags != before.sa_flags {
        record(slot, replaced.sa_sigaction, replaced.sa_flags);
      }
    }
  }
  *done = true;
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
  use std::sync::atomic::AtomicBool;

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

  /// Set by the handler a scenario installs as "somebody else's" before the app's, so it can be seen to have run.
  static THEIRS_RAN: AtomicBool = AtomicBool::new(false);
  extern "C" fn theirs(_: c_int) {
    THEIRS_RAN.store(true, Ordering::SeqCst);
  }

  /// A fault the hardware raises, not a signal sent by hand: a page that was mapped and then given back.
  ///
  /// # Safety
  /// Ends in a fault by design: only for a process that exists to be ended by it.
  unsafe fn fault() {
    let size = libc::sysconf(libc::_SC_PAGESIZE) as usize;
    let page = libc::mmap(std::ptr::null_mut(), size, libc::PROT_READ | libc::PROT_WRITE, libc::MAP_PRIVATE | libc::MAP_ANON, -1, 0);
    assert_ne!(page, libc::MAP_FAILED);
    assert_eq!(libc::munmap(page, size), 0);
    std::ptr::write_volatile(page.cast::<u8>(), 1);
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
        // Somebody else's handler, installed before the app's.
        "theirs_term" => {
          libc::signal(libc::SIGTERM, theirs as extern "C" fn(c_int) as libc::sighandler_t);
        }
        "theirs_abrt" => {
          libc::signal(libc::SIGABRT, theirs as extern "C" fn(c_int) as libc::sighandler_t);
        }
        // The same, having asked for a restart of a system call and for a mask, and not for the alternate stack.
        "flags_theirs" => {
          let mut action: libc::sigaction = std::mem::zeroed();
          action.sa_sigaction = theirs as extern "C" fn(c_int) as libc::sighandler_t;
          libc::sigemptyset(&mut action.sa_mask);
          libc::sigaddset(&mut action.sa_mask, libc::SIGUSR1);
          action.sa_flags = libc::SA_RESTART;
          assert_eq!(libc::sigaction(libc::SIGABRT, &action, std::ptr::null_mut()), 0);
        }
        "flags_default" => {
          libc::signal(libc::SIGABRT, libc::SIG_DFL);
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
        "segv" => fault(),
        "ill" => {
          libc::raise(libc::SIGILL);
        }
        "fpe" => {
          libc::raise(libc::SIGFPE);
        }
        "abrt" | "theirs_abrt" => {
          libc::raise(libc::SIGABRT);
        }
        "term" | "theirs_term" | "twice" | "off" | "unwritable" => {
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
        // What the kernel holds for the signal after the app took it, read back: exit 0 when it is what `flags_for` promises.
        "flags_theirs" | "flags_default" => {
          let mut now: libc::sigaction = std::mem::zeroed();
          assert_eq!(libc::sigaction(libc::SIGABRT, std::ptr::null(), &mut now), 0);
          let kept = if scenario == "flags_theirs" {
            now.sa_flags & libc::SA_ONSTACK == 0 && now.sa_flags & libc::SA_RESTART != 0 && libc::sigismember(&now.sa_mask, libc::SIGUSR1) == 1
          } else {
            now.sa_flags & libc::SA_ONSTACK != 0
          };
          std::process::exit(if kept && now.sa_flags & libc::SA_SIGINFO != 0 { 0 } else { 1 });
        }
        // The state a race would leave: the record says "ignore" while the app's handler is the one the kernel calls.
        "ignored_late" => {
          let slot = SIGNALS.iter().position(|(number, _, _)| *number == libc::SIGHUP).unwrap();
          record(slot, libc::SIG_IGN, 0);
          libc::raise(libc::SIGHUP);
        }
        "wait" => {
          println!("READY");
          std::thread::sleep(std::time::Duration::from_secs(60));
        }
        other => panic!("no scenario {other}"),
      }
    }
    // Reached only when the signal did not end the process: handled by somebody else, or ignored. 98 says their handler ran.
    std::process::exit(if THEIRS_RAN.load(Ordering::SeqCst) { 98 } else { 99 });
  }

  #[test]
  fn the_words_a_handler_writes_are_exactly_the_words_the_reader_believes() {
    let written: Vec<String> =
      SIGNALS.iter().map(|(_, word, _)| String::from_utf8(word.to_vec()).unwrap().trim_end().to_string()).collect();
    assert_eq!(written, SIGNAL_WORDS.iter().map(|word| word.to_string()).collect::<Vec<_>>());
    let mut numbers: Vec<c_int> = SIGNALS.iter().map(|(number, _, _)| *number).collect();
    numbers.sort_unstable();
    numbers.dedup();
    assert_eq!(numbers.len(), SIGNALS.len());
    // The crashes are passed on to what was there; the requests to end are taken only from the default action.
    let crashes: Vec<&str> = SIGNALS.iter().filter(|(_, _, crash)| *crash).map(|(_, word, _)| std::str::from_utf8(word).unwrap().trim_end()).collect();
    assert_eq!(crashes, ["signal_segv", "signal_bus", "signal_ill", "signal_fpe", "signal_abrt"]);
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
  fn a_request_to_end_that_somebody_else_handles_is_left_to_them_and_leaves_no_word() {
    let dir = tempfile::tempdir().unwrap();
    let status = run_child("theirs_term", dir.path());
    assert_eq!(status.code(), Some(98), "their handler must run, and the process carry on: {status:?}");
    assert_eq!(word_of(dir.path()), None);
  }

  #[test]
  fn a_crash_signal_somebody_else_handles_still_reaches_them_after_the_word_is_written() {
    let dir = tempfile::tempdir().unwrap();
    let status = run_child("theirs_abrt", dir.path());
    assert_eq!(status.code(), Some(98), "their handler must run, and the process carry on: {status:?}");
    assert_eq!(word_of(dir.path()), Some("signal_abrt"));
  }

  #[test]
  fn a_signal_that_is_ignored_stays_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let status = run_child("ignored", dir.path());
    assert_eq!(status.code(), Some(99), "{status:?}");
    assert_eq!(word_of(dir.path()), None);
  }

  #[test]
  fn a_signal_made_ignored_after_the_app_chose_to_take_it_is_still_ignored_and_leaves_no_word() {
    let dir = tempfile::tempdir().unwrap();
    let status = run_child("ignored_late", dir.path());
    assert_eq!(status.code(), Some(99), "the process must carry on, not end of the signal: {status:?}");
    assert_eq!(word_of(dir.path()), None, "nothing ended, so nothing is marked");
  }

  #[test]
  fn the_kernel_holds_the_mask_and_flags_of_what_the_app_replaced() {
    // Read back from the kernel after the app took the signal, in a process of its own: a handler that did not ask for the
    // alternate stack is not given one and keeps its mask and restart; with nothing there the app's handler asks for the stack.
    for scenario in ["flags_theirs", "flags_default"] {
      let dir = tempfile::tempdir().unwrap();
      assert_eq!(run_child(scenario, dir.path()).code(), Some(0), "{scenario}");
    }
  }

  #[test]
  fn the_flags_taken_always_keep_what_was_asked_for_and_add_the_stack_only_where_nothing_handled_the_signal() {
    let asked = [libc::SA_RESTART, libc::SA_NODEFER, libc::SA_ONSTACK, libc::SA_SIGINFO];
    for subset in 0..(1 << asked.len()) {
      let replaced_flags = asked.iter().enumerate().filter(|(bit, _)| subset & (1 << bit) != 0).fold(0, |all, (_, flag)| all | flag);
      for handler in [libc::SIG_DFL, 0x1000] {
        let taken = flags_for(handler, replaced_flags);
        assert_eq!(taken & replaced_flags, replaced_flags, "nothing that was asked for is dropped ({replaced_flags:#x})");
        assert_ne!(taken & libc::SA_SIGINFO, 0, "the handler always reads the extra information");
        let stack = replaced_flags & libc::SA_ONSTACK != 0 || handler == libc::SIG_DFL;
        assert_eq!(taken & libc::SA_ONSTACK != 0, stack, "handler {handler:#x}, flags {replaced_flags:#x}");
      }
    }
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
  fn installing_twice_changes_nothing_and_does_not_even_open_another_mark() {
    let dir = tempfile::tempdir().unwrap();
    let status = run_child("twice", dir.path());
    assert_eq!(status.signal(), Some(libc::SIGTERM), "{status:?}");
    assert_eq!(word_of(dir.path()), Some("signal_term"));
    assert!(!dir.path().join("second").join(marker_file_name(LAUNCH)).exists());
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
