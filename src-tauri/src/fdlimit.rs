//! The open-file limit every sidecar inherits (UJ-020).
//!
//! An export opens one input per clip. macOS gives an app launched from the Finder a SOFT limit
//! of 256 open files and ffmpeg inherits it, so a timeline of ~250 clips failed with EMFILE
//! (exit 232) on every render. The soft limit may be raised up to the hard limit without
//! privileges, so it is raised once, at startup, before anything can spawn.

/// macOS refuses a soft limit above OPEN_MAX (10240) even when the hard limit says unlimited.
#[cfg(unix)]
const CAP: u64 = 10_240;

/// Raise the soft limit toward the hard limit. `Some((was, now))` when it rose, `None` when it
/// was already high enough (or the platform has no such limit).
#[cfg(unix)]
pub fn raise() -> std::io::Result<Option<(u64, u64)>> {
  let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
  // SAFETY: `lim` is a valid, writable rlimit for the duration of the call.
  if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) } != 0 {
    return Err(std::io::Error::last_os_error());
  }
  let was = lim.rlim_cur as u64;
  let want = (lim.rlim_max as u64).min(CAP);
  if want <= was {
    return Ok(None);
  }
  lim.rlim_cur = want as libc::rlim_t;
  // SAFETY: `lim` is a valid rlimit; raising the soft limit up to the hard one needs no privilege.
  if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &lim) } != 0 {
    return Err(std::io::Error::last_os_error());
  }
  Ok(Some((was, want)))
}

/// Windows has no inherited per-process descriptor cap of this kind.
#[cfg(not(unix))]
pub fn raise() -> std::io::Result<Option<(u64, u64)>> {
  Ok(None)
}

#[cfg(all(test, unix))]
mod tests {
  use super::*;

  fn soft() -> u64 {
    let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) }, 0);
    lim.rlim_cur as u64
  }

  fn set_soft(n: u64) {
    let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) }, 0);
    lim.rlim_cur = n as libc::rlim_t;
    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &lim) }, 0);
  }

  /// One test, not several: the limit is per PROCESS and the harness runs tests on threads.
  #[test]
  fn a_child_spawned_after_raise_inherits_the_raised_limit() {
    // Start where a Finder-launched app starts.
    set_soft(256);
    let raised = raise().expect("raise failed");
    let now = soft();
    assert!(now > 256, "soft limit still {now} after raise ({raised:?})");
    assert_eq!(raised, Some((256, now)));
    // The outcome that matters: what a spawned process (ffmpeg) is given.
    let out = std::process::Command::new("/bin/sh")
      .args(["-c", "ulimit -Sn"])
      .output()
      .expect("spawn sh");
    let child: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().expect("ulimit output");
    assert_eq!(child, now, "the child must inherit the raised limit");
    // Idempotent: a second call has nothing to do.
    assert_eq!(raise().expect("second raise"), None);
  }
}
