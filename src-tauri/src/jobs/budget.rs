use std::process::Command;
use shared_child::SharedChild;
use std::sync::Arc;

pub(super) const RENDER_COMMIT_LIMIT: usize = 4 * 1024 * 1024 * 1024;
pub(super) const RENDER_RESIDENT_LIMIT: u64 = 7 * 1024 * 1024 * 1024 / 2;
/// The most an export's resident limit is raised to while the exporter plan's own ceilings do not exist yet.
pub(super) const RENDER_RESIDENT_CEILING: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct RenderLimits {
  /// Where the watcher stops an export: the working set of the export's own processes.
  pub resident: u64,
  /// What Windows enforces: the committed (promised) memory of the export's processes.
  pub commit: usize,
}

/// The memory limits of one export, from the memory a new process can get right now (`None`: unknown).
///
/// Never below the fixed limits every earlier release had (`RENDER_RESIDENT_LIMIT`, `RENDER_COMMIT_LIMIT`), so
/// nothing that passed before can fail because of this. On a PC with room they rise to three quarters of the free
/// memory, up to `RENDER_RESIDENT_CEILING`, so an export is no longer stopped at numbers chosen for the smallest
/// PC. Commit keeps the old ratio to resident (4 GiB to 3.5 GiB): decoders and encoders promise more memory than
/// they touch, and a refused promise ("Cannot allocate memory") ended exports that never reached the working-set
/// limit.
pub(super) fn render_limits(available_memory: Option<u64>) -> RenderLimits {
  let share = available_memory.map_or(0, |bytes| bytes / 4 * 3);
  let resident = share.clamp(RENDER_RESIDENT_LIMIT, RENDER_RESIDENT_CEILING);
  let commit = usize::try_from(resident / 7 * 8).unwrap_or(usize::MAX).max(RENDER_COMMIT_LIMIT);
  RenderLimits { resident, commit }
}

/// The least memory the PC keeps for itself while an export runs.
const PC_FLOOR_MIN: u64 = 3 * 1024 * 1024 * 1024 / 4;
/// How many looks in a row the PC must be under its floor before the export is stopped: a browser tab that opens
/// and closes is not a squeeze.
pub(super) const PC_FLOOR_LOOKS: u32 = 3;

/// What the PC keeps free for itself and the person's other work while an export runs: 0.75 GiB or 6% of the PC's
/// memory, whichever is more, and never more than a quarter of what was free when the export started (the exporter
/// plan's "PC floor"). The quarter is what keeps the floor and the plan agreeing: the plan lets an export use three
/// quarters of the free memory (`render_limits` takes the same share), so an export that stays inside its share leaves
/// at least the floor; a larger floor would stop an export the plan had accepted. It also means a PC that began tight
/// can still export at all. The memory the export's own processes may use is a separate limit (`render_limits`); this
/// one protects the PC whatever took the memory.
pub(super) fn pc_floor(total: u64, free_at_start: u64) -> u64 {
  (total / 100 * 6).max(PC_FLOOR_MIN).min(free_at_start / 4)
}

/// A watch over the memory the PC has available, one look at a time.
pub(super) struct FloorWatch {
  floor: u64,
  under: u32,
}

impl FloorWatch {
  pub(super) fn new(floor: u64) -> Self { Self { floor, under: 0 } }

  #[cfg(test)]
  pub(super) fn floor(&self) -> u64 { self.floor }

  /// A PC that does not say how much memory it has is not stopped for it: the run of looks starts again.
  pub(super) fn unknown(&mut self) { self.under = 0; }

  /// One look at the memory the PC has available. Once it has been under the floor on `PC_FLOOR_LOOKS` looks in a
  /// row, the words to stop the export with. The page reads them as a memory limit (src/api/exportReason.ts).
  pub(super) fn look(&mut self, available: u64) -> Option<String> {
    if available >= self.floor { self.under = 0; return None; }
    self.under = self.under.saturating_add(1);
    (self.under >= PC_FLOOR_LOOKS).then(|| format!(
      "render memory floor crossed: the PC has {} MiB left and keeps {} MiB for itself", available >> 20, self.floor >> 20))
  }
}

#[derive(Debug)]
enum ResidentObservation {
  Live(u64),
  #[cfg(target_os = "macos")]
  Retiring,
}

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
fn macos_missing_task_observation(child: &SharedChild, detail: String) -> Result<ResidentObservation, String> {
  // Public Darwin proc_info.h ABI; the pinned libc does not expose this flag.
  const PROC_FLAG_INEXIT: u32 = 4;
  let pid = child.id();
  let process: libc::c_int = pid.try_into().map_err(|_| format!("owned render worker {pid} PID is outside the supported range"))?;
  let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
  let expected = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
  let observed = unsafe { libc::proc_pidinfo(process, libc::PROC_PIDTBSDINFO, 1, info.as_mut_ptr().cast(), expected) };
  let error = std::io::Error::last_os_error();
  let info = if observed == expected { Some(unsafe { info.assume_init() }) } else { None };
  // Kernel exit starts before SZOMB. Observe it without waiting here: Control
  // retains the child and its output reservation until the actual waiter settles.
  if info.as_ref().is_some_and(|info| info.pbi_flags & PROC_FLAG_INEXIT != 0) ||
    observed == 0 && error.raw_os_error() == Some(libc::ESRCH) {
    return Ok(ResidentObservation::Retiring);
  }
  if child.try_wait().map_err(|error| error.to_string())?.is_some() { return Ok(ResidentObservation::Retiring); }
  let exit_detail = match info {
    Some(info) => format!("BSD status={}, flags={:#x}", info.pbi_status, info.pbi_flags),
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
      Ok(bytes) => Ok(ResidentObservation::Live(bytes)),
      Err(TaskInfoError::MissingProcess(detail)) => macos_missing_task_observation(child, detail),
      Err(TaskInfoError::Unavailable(detail)) => Err(detail),
    };
    #[cfg(not(target_os = "macos"))]
    let measured = {
      let process = sysinfo::Pid::from_u32(pid);
      if system.refresh_process_specifics(process, sysinfo::ProcessRefreshKind::new().with_memory()) {
        system.process(process).map(|process| process.memory())
          .ok_or_else(|| format!("owned render worker {pid} has no memory sample"))
      } else { Err(format!("cannot measure a live owned render worker {pid}")) }
    }.map(ResidentObservation::Live);
    if child.try_wait().map_err(|error| error.to_string())?.is_some() { continue; }
    let memory = match measured? {
      ResidentObservation::Live(memory) => memory,
      #[cfg(target_os = "macos")]
      ResidentObservation::Retiring => continue,
    };
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

// The floor is a pure function of the PC's memory and the watch over it is a small state machine, so the rules
// that keep it from locking a tight PC out, or stopping an export for a blip, are properties of those two.
#[cfg(test)]
mod floor_tests {
  use super::*;
  const GIB: u64 = 1024 * 1024 * 1024;
  const MIB: u64 = 1024 * 1024;

  fn machines() -> Vec<(u64, u64)> {
    let mut all = vec![(0, 0), (1, 0), (GIB, GIB), (8 * GIB, 0), (8 * GIB, GIB), (u64::MAX, u64::MAX)];
    for total in [2 * GIB, 4 * GIB, 8 * GIB, 16 * GIB, 24 * GIB, 64 * GIB, 128 * GIB, 1024 * GIB] {
      for free in [total / 20, total / 8, total / 4, total / 2, total * 3 / 4, total] {
        all.push((total, free));
      }
    }
    let mut seed = 0xD1B5_4A32_D192_ED03u64;
    for _ in 0..3000 {
      seed ^= seed << 13;
      seed ^= seed >> 7;
      seed ^= seed << 17;
      let total = seed >> (seed % 36);
      seed ^= seed << 13;
      seed ^= seed >> 7;
      seed ^= seed << 17;
      all.push((total, if total == 0 { 0 } else { seed % total }));
    }
    all
  }

  #[test]
  fn the_floor_never_locks_out_a_pc_that_began_tight() {
    for (total, free) in machines() {
      assert!(pc_floor(total, free) <= free / 4, "{total} total, {free} free");
    }
  }

  // The plan lets an export use three quarters of the free memory (`exportPlan.ts`, the same share `render_limits` takes).
  // An export that keeps to that must never be stopped by the floor for keeping to it: the share and the floor fit in
  // what was free, on every PC. Found by review: with a floor of half the free memory, an 8 GiB PC with 2 GiB free planned
  // an export up to 1.5 GiB and then stopped it at 1.25.
  #[test]
  fn an_export_that_keeps_to_the_plans_share_never_trips_the_floor_by_doing_so() {
    for (total, free) in machines() {
      assert!(free / 4 * 3 + pc_floor(total, free) <= free, "{total} total, {free} free");
    }
    // The review's own cases: the plan accepts up to 75% of free, so the PC must still have the floor left over.
    for (total, free) in [(8 * GIB, 2 * GIB), (16 * GIB, 3 * GIB), (32 * GIB, 4 * GIB), (8 * GIB, 19 * GIB / 10)] {
      let allowed = free / 4 * 3;
      assert!(free - allowed >= pc_floor(total, free), "{total} total, {free} free: {allowed} allowed");
    }
  }

  #[test]
  fn the_floor_is_what_the_pc_keeps_for_itself_and_no_more() {
    for (total, free) in machines() {
      let floor = pc_floor(total, free);
      let wanted = (total / 100 * 6).max(3 * GIB / 4);
      assert!(floor <= wanted, "{total} total, {free} free: {floor}");
      // Unless a tight start capped it, it is at least the smallest floor there is.
      if free / 4 >= 3 * GIB / 4 { assert!(floor >= 3 * GIB / 4, "{total} total, {free} free: {floor}"); }
    }
  }

  #[test]
  fn the_floor_never_falls_as_the_pc_has_more_memory_or_more_of_it_free() {
    let mut last_by_total = 0;
    for total in (1..=2000u64).map(|step| step * 512 * MIB) {
      let floor = pc_floor(total, total);
      assert!(floor >= last_by_total, "{total}");
      last_by_total = floor;
    }
    let mut last_by_free = 0;
    for free in (0..=2000u64).map(|step| step * 16 * MIB) {
      let floor = pc_floor(32 * GIB, free);
      assert!(floor >= last_by_free, "{free}");
      last_by_free = floor;
    }
  }

  #[test]
  fn known_machines() {
    let near = |a: u64, b: u64| a.abs_diff(b) <= 8;
    assert!(near(pc_floor(64 * GIB, 50 * GIB), 64 * GIB / 100 * 6)); // 3.84 GiB
    assert!(near(pc_floor(16 * GIB, 8 * GIB), 16 * GIB / 100 * 6)); // 0.96 GiB
    assert_eq!(pc_floor(8 * GIB, 3 * GIB), 3 * GIB / 4); // 6% would be 0.48 GiB: the smallest floor holds
    assert_eq!(pc_floor(8 * GIB, 5 * GIB / 4), 5 * GIB / 16); // began with 1.25 GiB free: a quarter of it, not 0.75 GiB
    assert_eq!(pc_floor(8 * GIB, 0), 0);
  }

  #[test]
  fn the_pc_must_stay_under_its_floor_for_every_one_of_the_looks_in_a_row() {
    let floor = GIB;
    for pattern in 0u32..(1 << 12) {
      let mut watch = FloorWatch::new(floor);
      let under = |index: usize| pattern >> index & 1 == 1;
      let first_run = (0..12 - (PC_FLOOR_LOOKS as usize - 1))
        .find(|start| (*start..*start + PC_FLOOR_LOOKS as usize).all(under));
      let mut tripped_at = None;
      for index in 0..12 {
        let available = if under(index) { floor - 1 } else { floor };
        if watch.look(available).is_some() { tripped_at = Some(index); break; }
      }
      assert_eq!(tripped_at, first_run.map(|start| start + PC_FLOOR_LOOKS as usize - 1), "pattern {pattern:012b}");
    }
  }

  #[test]
  fn exactly_the_floor_is_not_under_it() {
    let mut watch = FloorWatch::new(GIB);
    for _ in 0..50 { assert!(watch.look(GIB).is_none()); }
  }

  #[test]
  fn the_message_says_what_the_pc_has_and_what_it_keeps_in_words_the_page_reads_as_a_memory_limit() {
    let mut watch = FloorWatch::new(768 * MIB);
    let message = (0..PC_FLOOR_LOOKS).filter_map(|_| watch.look(410 * MIB)).last().unwrap();
    assert_eq!(message, "render memory floor crossed: the PC has 410 MiB left and keeps 768 MiB for itself");
    let lowered = message.to_lowercase();
    assert!(lowered.contains("memory floor crossed"), "the page names this stop by these words");
    assert!(!lowered.contains("resident memory budget"), "and never mistakes it for the job's own limit");
  }
}

// The limits are a pure function of the free memory, so the rules that make a raise safe are properties
// of that function, checked over the edges and a deterministic spread of every magnitude.
#[cfg(test)]
mod limit_tests {
  use super::*;
  const GIB: u64 = 1024 * 1024 * 1024;

  fn inputs() -> Vec<Option<u64>> {
    let mut all = vec![None, Some(0), Some(1), Some(GIB), Some(4 * GIB), Some(u64::MAX), Some(u64::MAX - 1)];
    for edge in [RENDER_RESIDENT_LIMIT, RENDER_RESIDENT_LIMIT / 3 * 4, RENDER_RESIDENT_CEILING, RENDER_RESIDENT_CEILING / 3 * 4] {
      all.extend([edge - 1, edge, edge + 1].map(Some));
    }
    let mut seed = 0x9E37_79B9_7F4A_7C15u64;
    for _ in 0..4000 {
      seed ^= seed << 13;
      seed ^= seed >> 7;
      seed ^= seed << 17;
      all.push(Some(seed >> (seed % 40)));
    }
    all
  }

  #[test]
  fn a_limit_is_never_below_the_fixed_limits_every_earlier_release_had() {
    for free in inputs() {
      let limits = render_limits(free);
      assert!(limits.resident >= RENDER_RESIDENT_LIMIT, "{free:?}: {limits:?}");
      assert!(limits.commit >= RENDER_COMMIT_LIMIT, "{free:?}: {limits:?}");
    }
  }

  #[test]
  fn an_unknown_or_small_amount_of_free_memory_gives_exactly_the_old_limits() {
    for free in [None, Some(0), Some(GIB), Some(RENDER_RESIDENT_LIMIT / 3 * 4)] {
      assert_eq!(render_limits(free), RenderLimits { resident: RENDER_RESIDENT_LIMIT, commit: RENDER_COMMIT_LIMIT }, "{free:?}");
    }
  }

  #[test]
  fn limits_never_fall_as_free_memory_rises() {
    let mut sorted = inputs().into_iter().flatten().collect::<Vec<_>>();
    sorted.sort_unstable();
    let mut last = render_limits(None);
    for free in sorted {
      let limits = render_limits(Some(free));
      assert!(limits.resident >= last.resident && limits.commit >= last.commit, "{free}: {limits:?} after {last:?}");
      last = limits;
    }
  }

  #[test]
  fn a_raised_limit_leaves_a_quarter_of_the_free_memory_and_stays_under_the_ceiling() {
    for free in inputs().into_iter().flatten() {
      let limits = render_limits(Some(free));
      assert!(limits.resident <= RENDER_RESIDENT_CEILING, "{free}: {limits:?}");
      if limits.resident > RENDER_RESIDENT_LIMIT {
        assert!(u128::from(limits.resident) * 4 <= u128::from(free) * 3, "{free}: {limits:?}");
      }
    }
  }

  #[test]
  fn commit_never_falls_below_resident_and_keeps_the_old_ratio() {
    for free in inputs().into_iter().flatten() {
      let limits = render_limits(Some(free));
      assert!(limits.commit as u64 >= limits.resident, "{free}: {limits:?}");
      assert!(limits.commit as u64 <= limits.resident / 7 * 8 + RENDER_COMMIT_LIMIT as u64, "{free}: {limits:?}");
    }
    assert_eq!(render_limits(None).commit as u64, RENDER_RESIDENT_LIMIT / 7 * 8);
  }

  #[test]
  fn known_machines() {
    assert_eq!(render_limits(Some(60 * GIB)).resident, 8 * GIB);
    assert_eq!(render_limits(Some(40 * GIB)).commit as u64, 8 * GIB / 7 * 8);
    assert_eq!(render_limits(Some(6 * GIB)).resident, 4 * GIB + GIB / 2);
    assert_eq!(render_limits(Some(6 * GIB)).commit as u64, (4 * GIB + GIB / 2) / 7 * 8);
    assert_eq!(render_limits(Some(4 * GIB)).resident, RENDER_RESIDENT_LIMIT);
  }
}

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
  fn a_terminal_writer_preserves_its_exit_and_output_without_a_live_zero_sample() {
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
    assert!(matches!(macos_missing_task_observation(&child, missing).unwrap(), ResidentObservation::Retiring));
    assert!(child.wait().unwrap().success());
    let (total, live) = resident_samples(&[Arc::new(child)]).unwrap();
    assert_eq!(total, 0);
    assert!(live.is_empty());
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
    let result = macos_missing_task_observation(&child, "controlled missing task measurement".into());
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
    for iteration in 0..256 {
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