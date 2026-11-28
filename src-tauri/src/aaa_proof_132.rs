// TEMPORARY: lives only on the throwaway branch work/flaky-rust-proof (art-daddy/backlog#132) and is never merged.
//
// `storm` starts child processes one after another from two threads for PROOF_132_STORM seconds, beside the tests under
// proof, as the other tests of the full suite do; without the variable it does nothing. Its name sorts first, so it starts
// before them.
//
// `fork_window` shows the mechanism on its own: a child that is between being created (fork) and starting its program
// (exec) holds a copy of a listener this process has already closed, so the port still accepts until the child starts
// its program, and is refused after.
#[cfg(all(test, unix))]
mod tests {
  use std::net::{SocketAddr, TcpListener, TcpStream};
  use std::os::unix::process::CommandExt;
  use std::process::Stdio;
  use std::time::{Duration, Instant};

  fn accepting(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300)).is_ok()
  }

  #[test]
  fn storm() {
    let Some(seconds) = std::env::var("PROOF_132_STORM").ok().and_then(|text| text.parse::<u64>().ok()) else { return };
    let end = Instant::now() + Duration::from_secs(seconds);
    let threads: Vec<_> = (0..2)
      .map(|_| {
        std::thread::spawn(move || {
          let mut started = 0u64;
          while Instant::now() < end {
            let _ = std::process::Command::new("true").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
            started += 1;
          }
          started
        })
      })
      .collect();
    let started: u64 = threads.into_iter().map(|thread| thread.join().unwrap()).sum();
    println!("PROOF-132 storm: {started} children in {seconds} s");
  }

  #[test]
  fn fork_window() {
    // A port outside the range the system hands out, free a moment ago.
    let port = (29_500..29_600).find(|port| TcpListener::bind(("127.0.0.1", *port)).is_ok()).unwrap();
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    assert!(accepting(port));
    // Another thread starts a child that stays 1.5 s between fork and exec (every child is there for a moment).
    let spawner = std::thread::spawn(|| {
      let mut command = std::process::Command::new("true");
      unsafe {
        command.pre_exec(|| {
          std::thread::sleep(Duration::from_millis(1500));
          Ok(())
        });
      }
      command.status().unwrap()
    });
    std::thread::sleep(Duration::from_millis(500));
    drop(listener);
    let right_after = accepting(port);
    let rebind_right_after = TcpListener::bind(("127.0.0.1", port)).is_ok();
    spawner.join().unwrap();
    let after_exec = accepting(port);
    let rebind_after_exec = TcpListener::bind(("127.0.0.1", port)).is_ok();
    println!(
      "PROOF-132 fork window: after this process closed its listener, while a child was between fork and exec: \
       a connection got through = {right_after}, a new bind worked = {rebind_right_after}; after the child's exec: \
       a connection got through = {after_exec}, a new bind worked = {rebind_after_exec}"
    );
    assert!(right_after && !after_exec && rebind_after_exec);
  }
}
