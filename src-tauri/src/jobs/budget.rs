use std::process::Command;
use shared_child::SharedChild;
use std::sync::Arc;

pub(super) const RENDER_COMMIT_LIMIT: usize = 4 * 1024 * 1024 * 1024;
pub(super) const RENDER_RESIDENT_LIMIT: u64 = 7 * 1024 * 1024 * 1024 / 2;

#[cfg(target_os = "macos")]
#[derive(Debug)]
enum TaskInfoError {
  MissingProcess(String),
  Unavailable(String),
}

#[cfg(target_os = "macos")]
fn macos_resident_bytes(pid: u32) -> Result<u64, TaskInfoError> {
  let process: libc::c_int = pid.try_into().map_err(|_| TaskInfoError::Unavailable(
    format!("owned render worker {pid} PID is outside the supported range")))?;
  let mut info = std::mem::MaybeUninit::<libc::proc_taskinfo>::uninit();
  let expected = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
  let observed = unsafe { libc::proc_pidinfo(process, libc::PROC_PIDTASKINFO, 0, info.as_mut_ptr().cast(), expected) };
  if observed != expected {
    let error = std::io::Error::last_os_error();
    let detail = format!("cannot measure owned render worker {pid}: task bytes={observed}, expected={expected}, error={error}");
    return Err(if observed == 0 && error.raw_os_error() == Some(libc::ESRCH) {
      TaskInfoError::MissingProcess(detail)
    } else { TaskInfoError::Unavailable(detail) });
  }
  Ok(unsafe { info.assume_init() }.pti_resident_size)
}

#[cfg(target_os = "macos")]
fn macos_missing_process_sample(child: &SharedChild, detail: String) -> Result<Option<u64>, String> {
  let pid = child.id();
  let process: libc::c_int = pid.try_into().map_err(|_| format!("owned render worker {pid} PID is outside the supported range"))?;
  let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
  let expected = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
  let observed = unsafe { libc::proc_pidinfo(process, libc::PROC_PIDTBSDINFO, 1, info.as_mut_ptr().cast(), expected) };
  let error = std::io::Error::last_os_error();
  let status = if observed == expected { Some(unsafe { info.assume_init() }.pbi_status) } else { None };
  // Darwin task lookup excludes zombies while another waiter can still own exit
  // notification. A complete zombie record permits joining this owned child.
  if status == Some(libc::SZOMB) {
    child.wait().map_err(|error| format!("cannot confirm owned render worker {pid} exit: {error}"))?;
    return Ok(None);
  }
  if child.try_wait().map_err(|error| error.to_string())?.is_some() { return Ok(None); }
  let exit_detail = match status {
    Some(status) => format!("BSD status={status}"),
    None => format!("BSD bytes={observed}, expected={expected}, error={error}"),
  };
  Err(format!("{detail}; owned worker exit is unconfirmed: {exit_detail}"))
}

pub(super) fn resident_samples(children: &[Arc<SharedChild>]) -> Result<(u64, Vec<(u32, u64)>), String> {
  if !sysinfo::IS_SUPPORTED_SYSTEM { return Err("resident memory accounting is unavailable on this platform".into()); }
  #[cfg(not(target_os = "macos"))]
  let mut system = sysinfo::System::new();
  let mut total = 0u64;
  let mut samples = Vec::with_capacity(children.len());
  for child in children {
    if child.try_wait().map_err(|error| error.to_string())?.is_some() { continue; }
    let pid = child.id();
    #[cfg(target_os = "macos")]
    let measured = match macos_resident_bytes(pid) {
      Ok(bytes) => Ok(Some(bytes)),
      Err(TaskInfoError::MissingProcess(detail)) => macos_missing_process_sample(child, detail),
      Err(TaskInfoError::Unavailable(detail)) => Err(detail),
    };
    #[cfg(not(target_os = "macos"))]
    let measured = {
      let process = sysinfo::Pid::from_u32(pid);
      if system.refresh_process_specifics(process, sysinfo::ProcessRefreshKind::new().with_memory()) {
        system.process(process).map(|process| process.memory())
          .ok_or_else(|| format!("owned render worker {pid} has no memory sample"))
      } else { Err(format!("cannot measure a live owned render worker {pid}")) }
    }.map(Some);
    if child.try_wait().map_err(|error| error.to_string())?.is_some() { continue; }
    let Some(memory) = measured? else { continue; };
    total = total.checked_add(memory).ok_or("resident memory accounting overflow")?;
    samples.push((pid, memory));
  }
  Ok((total, samples))
}

#[cfg(windows)]
mod platform {
  use super::*;
  use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
  use std::os::windows::process::CommandExt;
  use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
  use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, THREADENTRY32, TH32CS_SNAPTHREAD};
  use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW,
    QueryInformationJobObject, SetInformationJobObject, JobObjectExtendedLimitInformation,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};
  use windows_sys::Win32::System::Threading::{OpenProcess, OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED,
    PROCESS_SET_QUOTA, PROCESS_TERMINATE, THREAD_SUSPEND_RESUME};

  pub struct Budget { job: OwnedHandle }

  impl Budget {
    pub fn new(limit: usize) -> Result<Self, String> {
      if limit == 0 { return Err("render commit limit must be positive".into()); }
      let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
      if job.is_null() { return Err(std::io::Error::last_os_error().to_string()); }
      let job = unsafe { OwnedHandle::from_raw_handle(job) };
      let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
      limits.BasicLimitInformation.ActiveProcessLimit = 3;
      limits.JobMemoryLimit = limit;
      if unsafe { SetInformationJobObject(job.as_raw_handle(), JobObjectExtendedLimitInformation,
        (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), std::mem::size_of_val(&limits) as u32) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
      }
      Ok(Self { job })
    }

    pub fn spawn(&self, command: &mut Command) -> Result<SharedChild, String> {
      command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
      let child = SharedChild::spawn(command).map_err(|error| error.to_string())?;
      let admitted = (|| -> Result<(), String> {
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, child.id()) };
        if process.is_null() { return Err(std::io::Error::last_os_error().to_string()); }
        let process = unsafe { OwnedHandle::from_raw_handle(process) };
        if unsafe { AssignProcessToJobObject(self.job.as_raw_handle(), process.as_raw_handle()) } == 0 {
          return Err(format!("could not enforce render commit budget: {}", std::io::Error::last_os_error()));
        }
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE { return Err(std::io::Error::last_os_error().to_string()); }
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
        let mut entry = THREADENTRY32 { dwSize: std::mem::size_of::<THREADENTRY32>() as u32, ..Default::default() };
        let mut present = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } != 0;
        while present {
          if entry.th32OwnerProcessID == child.id() {
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() { return Err(std::io::Error::last_os_error().to_string()); }
            let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
            if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX { return Err(std::io::Error::last_os_error().to_string()); }
            return Ok(());
          }
          present = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } != 0;
        }
        Err("suspended render worker has no owned thread".into())
      })();
      if let Err(error) = admitted {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
      }
      Ok(child)
    }

    pub fn commit_accounting(&self) -> Result<(usize, usize), String> {
      let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
      if unsafe { QueryInformationJobObject(self.job.as_raw_handle(), JobObjectExtendedLimitInformation,
        (&mut limits as *mut JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), std::mem::size_of_val(&limits) as u32, std::ptr::null_mut()) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
      }
      Ok((limits.JobMemoryLimit, limits.PeakJobMemoryUsed))
    }
  }
}

#[cfg(not(windows))]
mod platform {
  use super::*;

  pub struct Budget;

  impl Budget {
    pub fn new(limit: usize) -> Result<Self, String> {
      if limit == 0 { return Err("render commit limit must be positive".into()); }
      Ok(Self)
    }
    pub fn spawn(&self, command: &mut Command) -> Result<SharedChild, String> {
      SharedChild::spawn(command).map_err(|error| error.to_string())
    }
    pub fn commit_accounting(&self) -> Result<(usize, usize), String> {
      Err("aggregate commit accounting is not available on this platform".into())
    }
  }
}

pub(super) use platform::Budget;

#[cfg(test)]
mod resident_tests {
  #[test]
  fn memory_only_sampling_observes_a_real_touched_allocation() {
    let resident = || {
      #[cfg(target_os = "macos")]
      { super::macos_resident_bytes(std::process::id()).unwrap() }
      #[cfg(not(target_os = "macos"))]
      {
        let mut system = sysinfo::System::new();
        let pid = sysinfo::Pid::from_u32(std::process::id());
        assert!(system.refresh_process_specifics(pid, sysinfo::ProcessRefreshKind::new().with_memory()));
        system.process(pid).unwrap().memory()
      }
    };
    let before = resident();
    let mut bytes = vec![0u8; 32 * 1024 * 1024];
    for offset in (0..bytes.len()).step_by(4096) { bytes[offset] = 37; }
    std::hint::black_box(&bytes);
    let after = resident();
    assert!(after >= before + 16 * 1024 * 1024, "resident sampling did not observe touched memory: before={before}, after={after}");
    assert!(bytes.iter().step_by(4096).all(|byte| *byte == 37));
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn unavailable_task_information_is_an_error_not_a_zero_memory_sample() {
    assert!(super::macos_resident_bytes(i32::MAX as u32).is_err());
    assert!(super::macos_resident_bytes(u32::MAX).is_err());
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn a_real_zombie_is_joined_as_exited_not_reported_as_zero_memory() {
    use super::*;
    let root = tempfile::tempdir().unwrap();
    let child = SharedChild::spawn(Command::new("/bin/sh")
      .args(["-c", "printf completed > completed.bin"]).current_dir(root.path())).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let missing = loop {
      match macos_resident_bytes(child.id()) {
        Err(TaskInfoError::MissingProcess(detail)) => break detail,
        Err(TaskInfoError::Unavailable(detail)) => {
          child.wait().unwrap();
          panic!("{detail}");
        }
        Ok(_) => {}
      }
      if std::time::Instant::now() >= deadline {
        child.kill().unwrap();
        child.wait().unwrap();
        panic!("short owned writer did not reach its zombie state");
      }
      std::thread::yield_now();
    };
    assert!(macos_missing_process_sample(&child, missing).unwrap().is_none());
    assert!(child.try_wait().unwrap().unwrap().success());
    assert_eq!(std::fs::read(root.path().join("completed.bin")).unwrap(), b"completed");
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn a_missing_task_report_for_a_live_owned_child_stays_an_error() {
    use super::*;
    use std::io::Write;
    let child = SharedChild::spawn(Command::new("/bin/sh").args(["-c", "read -r finish"])
      .stdin(std::process::Stdio::piped())).unwrap();
    let mut input = child.take_stdin().unwrap();
    let (release, released) = std::sync::mpsc::channel();
    let releaser = std::thread::spawn(move || {
      let signal = released.recv_timeout(std::time::Duration::from_secs(2));
      assert!(matches!(signal, Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Timeout)));
      input.write_all(b"finish\n").unwrap();
    });
    let result = macos_missing_process_sample(&child, "controlled missing task measurement".into());
    let live = child.try_wait().unwrap().is_none();
    let signal = release.send(());
    releaser.join().unwrap();
    assert!(child.wait().unwrap().success());
    assert!(live, "measurement error blocked until a genuinely live worker exited");
    assert!(result.unwrap_err().contains("exit is unconfirmed"));
    signal.unwrap();
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn concurrent_owned_waiters_preserve_every_short_writer_outcome() {
    use super::*;
    use std::io::{BufRead, Write};
    let root = tempfile::tempdir().unwrap();
    for iteration in 0..64 {
      let child = Arc::new(SharedChild::spawn(Command::new("/bin/sh")
        .args(["-c", "printf 'ready\\n'; read -r finish; printf completed > completed.bin"])
        .current_dir(root.path()).stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())).unwrap());
      let mut input = child.take_stdin().unwrap();
      let mut output = std::io::BufReader::new(child.take_stdout().unwrap());
      let mut ready = String::new();
      output.read_line(&mut ready).unwrap();
      assert_eq!(ready.trim(), "ready");
      let (_, live) = resident_samples(&[child.clone()]).unwrap();
      assert_eq!(live.len(), 1);
      assert!(live[0].1 > 0);
      let waiting = child.clone();
      let waiter = std::thread::spawn(move || waiting.wait().unwrap());
      input.write_all(b"finish\n").unwrap();
      drop(input);
      let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
      let mut failure = None;
      loop {
        if let Err(error) = resident_samples(&[child.clone()]) { failure = Some(error); break; }
        if child.try_wait().unwrap().is_some() { break; }
        if std::time::Instant::now() >= deadline {
          failure = Some("short owned writer did not exit".into());
          child.kill().unwrap();
          break;
        }
        std::thread::yield_now();
      }
      assert!(waiter.join().unwrap().success());
      assert!(failure.is_none(), "iteration {iteration}: {failure:?}");
      assert_eq!(std::fs::read(root.path().join("completed.bin")).unwrap(), b"completed");
      std::fs::remove_file(root.path().join("completed.bin")).unwrap();
    }
  }
}

#[cfg(all(test, windows))]
mod tests {
  use super::*;
  use std::io::{BufRead, Read, Write};
  use std::process::Stdio;

  #[test]
  #[ignore = "allocation discriminator child; launched by the parent test"]
  fn allocation_child() {
    let Some(expected) = std::env::var_os("ARTDADDY_BUDGET_ALLOCATION") else { return; };
    if expected == "hold" {
      println!("worker-ready");
      std::io::stdout().flush().unwrap();
      let mut input = [0u8; 1];
      let read = std::io::stdin().read_exact(&mut input);
      std::fs::write(std::env::var_os("ARTDADDY_BUDGET_SURVIVAL").unwrap(), b"worker survived closure").unwrap();
      read.unwrap();
      panic!("owned worker unexpectedly survived job closure");
    }
    let mut bytes = Vec::<u8>::new();
    let allocated = bytes.try_reserve_exact(256 * 1024 * 1024);
    if expected == "refused" {
      assert!(allocated.is_err(), "OS commit budget did not reject the real allocation");
      println!("allocation-refused");
    } else {
      allocated.unwrap();
      bytes.resize(256 * 1024 * 1024, 37);
      std::hint::black_box(&bytes);
      println!("allocation-complete");
    }
  }

  #[test]
  fn real_allocation_fits_the_control_and_is_refused_by_the_smaller_job_budget() {
    for (limit, expected) in [(512 * 1024 * 1024, "complete"), (128 * 1024 * 1024, "refused")] {
      let budget = Budget::new(limit).unwrap();
      let mut command = Command::new(std::env::current_exe().unwrap());
      command.args(["--exact", "jobs::budget::tests::allocation_child", "--ignored", "--nocapture"])
        .env("ARTDADDY_BUDGET_ALLOCATION", expected).stdout(Stdio::piped()).stderr(Stdio::piped());
      let child = budget.spawn(&mut command).unwrap();
      let mut output = String::new();
      child.take_stdout().unwrap().read_to_string(&mut output).unwrap();
      let result = child.wait().unwrap();
      assert!(result.success(), "allocation child failed before its outcome: {output}");
      assert!(output.contains(&format!("allocation-{expected}")), "{output}");
      let (configured, peak) = budget.commit_accounting().unwrap();
      println!("allocation outcome={expected}; configured_limit={limit}; reported_peak={peak}");
      assert_eq!(configured, limit, "OS did not retain its admitted allocation limit");
      if expected == "complete" { assert!(peak >= 256 * 1024 * 1024, "control did not exhibit the allocation"); }
    }
  }

  #[test]
  fn dropping_the_budget_terminates_its_still_running_worker() {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};
    let dir = tempfile::tempdir().unwrap();
    let survived = dir.path().join("survived.txt");
    let budget = Budget::new(128 * 1024 * 1024).unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", "jobs::budget::tests::allocation_child", "--ignored", "--nocapture"])
      .env("ARTDADDY_BUDGET_ALLOCATION", "hold").env("ARTDADDY_BUDGET_SURVIVAL", &survived)
      .stdin(Stdio::piped()).stdout(Stdio::piped());
    let child = budget.spawn(&mut command).unwrap();
    let _input = child.take_stdin().unwrap();
    let mut output = std::io::BufReader::new(child.take_stdout().unwrap());
    let mut line = String::new();
    loop {
      line.clear();
      assert_ne!(output.read_line(&mut line).unwrap(), 0, "worker exited before proving it was running");
      if line.contains("worker-ready") { break; }
    }
    assert!(child.try_wait().unwrap().is_none());
    let process = unsafe { OpenProcess(0x00100000, 0, child.id()) };
    assert!(!process.is_null());
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    drop(budget);
    assert_eq!(unsafe { WaitForSingleObject(process.as_raw_handle(), 10_000) }, 0, "job closure did not terminate its live worker");
    child.wait().unwrap();
    assert!(!survived.exists(), "worker reached the side effect after its owning budget closed");
  }
}