use std::process::Command;
use shared_child::SharedChild;
use std::sync::Arc;

pub(super) const RENDER_COMMIT_LIMIT: usize = 4 * 1024 * 1024 * 1024;
pub(super) const RENDER_RESIDENT_LIMIT: u64 = 7 * 1024 * 1024 * 1024 / 2;

pub(super) fn resident_samples(children: &[Arc<SharedChild>]) -> Result<(u64, Vec<(u32, u64)>), String> {
  if !sysinfo::IS_SUPPORTED_SYSTEM { return Err("resident memory accounting is unavailable on this platform".into()); }
  let mut system = sysinfo::System::new();
  let mut total = 0u64;
  let mut samples = Vec::with_capacity(children.len());
  for child in children {
    if child.try_wait().map_err(|error| error.to_string())?.is_some() { continue; }
    let pid = sysinfo::Pid::from_u32(child.id());
    let found = system.refresh_process_specifics(pid, sysinfo::ProcessRefreshKind::new().with_memory());
    if child.try_wait().map_err(|error| error.to_string())?.is_some() { continue; }
    if !found { return Err("cannot measure a live owned render worker".into()); }
    let memory = system.process(pid).ok_or("owned render worker has no memory sample")?.memory();
    total = total.checked_add(memory).ok_or("resident memory accounting overflow")?;
    samples.push((child.id(), memory));
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
    let mut system = sysinfo::System::new();
    let pid = sysinfo::Pid::from_u32(std::process::id());
    let kind = sysinfo::ProcessRefreshKind::new().with_memory();
    assert!(system.refresh_process_specifics(pid, kind));
    let before = system.process(pid).unwrap().memory();
    let mut bytes = vec![0u8; 32 * 1024 * 1024];
    for offset in (0..bytes.len()).step_by(4096) { bytes[offset] = 37; }
    std::hint::black_box(&bytes);
    assert!(system.refresh_process_specifics(pid, kind));
    let after = system.process(pid).unwrap().memory();
    assert!(after >= before + 16 * 1024 * 1024, "resident sampling did not observe touched memory: before={before}, after={after}");
    assert!(bytes.iter().step_by(4096).all(|byte| *byte == 37));
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