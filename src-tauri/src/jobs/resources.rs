#[derive(Clone, Debug, serde::Serialize)]
pub struct LinuxMemoryCgroup {
  version: u8,
  path: String,
  identity: String,
  process_id: u32,
  memory_max_bytes: Option<u64>,
  swap_max_bytes: Option<u64>,
}

#[cfg(any(target_os = "linux", test))]
fn membership(text: &str) -> Result<&str, String> {
  let mut groups = text.split('\n').filter_map(|line| line.strip_prefix("0::"));
  let group = groups.next().ok_or("unified cgroup membership is unavailable")?;
  if groups.next().is_some() || !group.starts_with('/') || group.contains(['\0', '\r', '\n']) ||
    group != "/" && group[1..].split('/').any(|part| part.is_empty() || part == "." || part == "..") {
    return Err("unified cgroup membership is malformed".into());
  }
  Ok(group)
}

#[cfg(any(target_os = "linux", test))]
fn memory_limit(text: &str) -> Result<Option<u64>, String> {
  let value = text.trim();
  if value == "max" { return Ok(None); }
  if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
    return Err("cgroup memory limit is malformed".into());
  }
  value.parse::<u64>().ok().filter(|bytes| *bytes <= 9_007_199_254_740_991)
    .map(Some).ok_or_else(|| "cgroup memory limit is outside the supported range".into())
}

#[cfg(target_os = "linux")]
fn current() -> Result<LinuxMemoryCgroup, String> {
  use std::os::unix::fs::MetadataExt;
  use std::path::Path;
  let proc_group = std::fs::read_to_string("/proc/self/cgroup").map_err(|error| error.to_string())?;
  let group = membership(&proc_group)?;
  let mounts = std::fs::read_to_string("/proc/self/mountinfo").map_err(|error| error.to_string())?;
  if !mounts.lines().any(|line| line.split_once(" - ").is_some_and(|(left, right)| {
    let fields = left.split_whitespace().collect::<Vec<_>>();
    fields.get(3) == Some(&"/") && fields.get(4) == Some(&"/sys/fs/cgroup") &&
      right.split_whitespace().next() == Some("cgroup2")
  })) { return Err("standard unified cgroup mount is unavailable".into()); }
  let root = Path::new("/sys/fs/cgroup");
  let directory = root.join(group.trim_start_matches('/'));
  if directory.canonicalize().map_err(|error| error.to_string())? != directory {
    return Err("cgroup directory is not canonical".into());
  }
  let before = std::fs::metadata(&directory).map_err(|error| error.to_string())?;
  let mut memory = None::<u64>;
  let mut swap = None::<u64>;
  let mut ancestor = directory.as_path();
  loop {
    for (file, limit) in [("memory.max", &mut memory), ("memory.swap.max", &mut swap)] {
      let text = match std::fs::read_to_string(ancestor.join(file)) {
        Ok(text) => text,
        Err(error) if ancestor == root && error.kind() == std::io::ErrorKind::NotFound => continue,
        Err(error) => return Err(format!("cannot read cgroup {file}: {error}")),
      };
      if let Some(bytes) = memory_limit(&text)? { *limit = Some(limit.map_or(bytes, |previous| previous.min(bytes))); }
    }
    if ancestor == root { break; }
    ancestor = ancestor.parent().filter(|parent| parent.starts_with(root))
      .ok_or("cgroup ancestor escaped the unified mount")?;
  }
  let after = std::fs::metadata(&directory).map_err(|error| error.to_string())?;
  if before.dev() != after.dev() || before.ino() != after.ino() ||
    membership(&std::fs::read_to_string("/proc/self/cgroup").map_err(|error| error.to_string())?)? != group {
    return Err("cgroup identity changed during resource measurement".into());
  }
  Ok(LinuxMemoryCgroup { version: 2, path: group.to_string(),
    identity: format!("{}:{}", after.dev(), after.ino()), process_id: std::process::id(),
    memory_max_bytes: memory, swap_max_bytes: swap })
}

pub(super) fn memory_cgroup() -> Option<LinuxMemoryCgroup> {
  #[cfg(target_os = "linux")]
  {
    match current() {
      Ok(measured) => Some(measured),
      Err(error) => { log::warn!("Export cgroup measurement unavailable: {error}"); None }
    }
  }
  #[cfg(not(target_os = "linux"))]
  { None }
}

/// A whole-percent reading as a share of `total` bytes. A number outside 0..=100 is not a reading.
#[cfg(any(target_os = "macos", test))]
fn share_of(total: u64, percent: i64) -> Option<u64> {
  let percent = u64::try_from(percent).ok().filter(|percent| *percent <= 100)?;
  u64::try_from(u128::from(total) * u128::from(percent) / 100).ok()
}

/// macOS answers "how much memory can a new process get" with one number: `kern.memorystatus_level`, the percentage of memory that is free
/// or can be reclaimed without paging out a running app. The kernel derives its own pressure levels and low-memory warnings from it.
#[cfg(target_os = "macos")]
fn kernel_available_percent() -> Result<i64, String> {
  let name = std::ffi::CString::new("kern.memorystatus_level").map_err(|error| error.to_string())?;
  let mut level: libc::c_int = 0;
  let mut size = std::mem::size_of::<libc::c_int>() as libc::size_t;
  // SAFETY: `name` is a NUL-terminated string that outlives the call, and `level` and `size` are valid for exactly the sizes passed.
  let status = unsafe {
    libc::sysctlbyname(name.as_ptr(), (&mut level as *mut libc::c_int).cast(), &mut size, std::ptr::null_mut(), 0)
  };
  if status != 0 { return Err(std::io::Error::last_os_error().to_string()); }
  if size != std::mem::size_of::<libc::c_int>() { return Err(format!("the kernel answered with {size} bytes")); }
  Ok(i64::from(level))
}

/// The memory a new process can get, as the export preflight compares its estimate with it. `sysinfo` 0.30 computes macOS "available" memory
/// as free + speculative + inactive + purgeable pages MINUS the compressor's pages, clamped at zero. Through two 30-minute exports on a 24 GB
/// Mac it read 0.00 GiB (median) while the kernel reported 50-59 % available and normal pressure the whole time, so every repeat export was
/// told there was no memory. On macOS the kernel is asked instead. When it cannot be, or answers something that is not a percentage, the
/// figure stays `sysinfo`'s own: headroom is never invented.
#[cfg(any(target_os = "macos", test))]
fn available_from(total: u64, reported: u64, kernel: impl FnOnce() -> Result<i64, String>) -> u64 {
  match kernel() {
    Ok(percent) => share_of(total, percent).unwrap_or_else(|| {
      log::warn!("Export memory figure: the kernel answered {percent}, which is not a percentage; using the library figure");
      reported
    }),
    Err(error) => {
      log::warn!("Export memory figure: the kernel could not be asked ({error}); using the library figure");
      reported
    }
  }
}

/// Total and available memory in bytes, or `None` for both when the system reports no memory at all. The one place either figure is decided.
pub(super) fn memory_figures() -> (Option<u64>, Option<u64>) {
  let mut system = sysinfo::System::new();
  system.refresh_memory();
  let total = system.total_memory();
  if total == 0 { return (None, None); }
  #[cfg(target_os = "macos")]
  let available = available_from(total, system.available_memory(), kernel_available_percent);
  #[cfg(not(target_os = "macos"))]
  let available = system.available_memory();
  (Some(total), Some(available))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn legitimate_nested_memberships_and_limit_values_are_not_discarded() {
    for name in ["worker", "space name", "quote'name", "colon:name", "ümlaut", ".not-dot", "max"] {
      for depth in 1..=32 {
        let path = format!("/{}", vec![name; depth].join("/"));
        let record = format!("5:cpu:/other\n0::{path}\n");
        assert_eq!(membership(&record).unwrap(), path);
      }
    }
    assert_eq!(membership("0::/\n").unwrap(), "/");
    assert_eq!(memory_limit("max\n").unwrap(), None);
    for bytes in (0..=65536).step_by(257).chain([9_007_199_254_740_991]) {
      assert_eq!(memory_limit(&format!("{bytes}\n")).unwrap(), Some(bytes));
    }
  }

  #[test]
  fn ambiguous_paths_and_unknown_limits_cannot_become_profile_proof() {
    for path in ["", "relative", "/../peer", "/a/../peer", "/./a", "/a//b", "/a/", "/a\0b", "/a\rb", "/a\r"] {
      assert!(membership(&format!("0::{path}\n")).is_err(), "{path:?}");
    }
    assert!(membership("0::/one\n0::/two\n").is_err());
    assert!(membership("1:memory:/legacy\n").is_err());
    for value in ["", "-1", "+1", "NaN", "Infinity", "1.5", "1 2", "9007199254740992", "18446744073709551616"] {
      assert!(memory_limit(value).is_err(), "{value}");
    }
  }

  #[test]
  fn a_percentage_of_memory_is_exact_never_decreasing_and_never_more_than_all_of_it() {
    for total in [0, 1, 99, 100, 101, 8 << 30, 24 << 30, u64::MAX - 1, u64::MAX] {
      let mut last = 0;
      for percent in 0..=100 {
        let bytes = share_of(total, percent).unwrap();
        assert_eq!(u128::from(bytes), u128::from(total) * percent as u128 / 100, "{total} {percent}");
        assert!(bytes >= last && bytes <= total, "{total} {percent}");
        last = bytes;
      }
      assert_eq!(share_of(total, 0), Some(0));
      assert_eq!(share_of(total, 100), Some(total));
    }
  }

  #[test]
  fn a_number_that_is_not_a_percentage_is_not_a_reading() {
    for percent in [-1, -100, 101, 255, 1_000, i64::from(i32::MIN), i64::from(i32::MAX), i64::MIN, i64::MAX] {
      assert_eq!(share_of(24 << 30, percent), None, "{percent}");
    }
  }

  #[test]
  fn the_kernels_answer_decides_the_figure_and_nothing_invents_headroom() {
    let total = 24u64 << 30;
    // The measured case: the library read zero while the kernel said 59 % of this machine's memory was available.
    let measured = available_from(total, 0, || Ok(59));
    assert_eq!(u128::from(measured), u128::from(total) * 59 / 100);
    assert!(measured > 3 * (1 << 30) + (1 << 29), "a Mac this idle must clear the 3.5 GiB worker cutoff");
    // A kernel that reports shortage is believed even when the library figure is higher, and zero percent is a reading, not a failure.
    assert_eq!(available_from(total, 20 << 30, || Ok(4)), share_of(total, 4).unwrap());
    assert_eq!(available_from(total, 20 << 30, || Ok(0)), 0);
    // When the kernel cannot be asked, or answers something that is not a percentage, the figure stays the library's.
    assert_eq!(available_from(total, 3 << 30, || Err("denied".into())), 3 << 30);
    for nonsense in [-1, 101, i64::MAX] {
      assert_eq!(available_from(total, 3 << 30, || Ok(nonsense)), 3 << 30, "{nonsense}");
    }
    // The kernel is asked once per figure.
    let mut asked = 0;
    available_from(total, 0, || { asked += 1; Ok(50) });
    assert_eq!(asked, 1);
  }

  #[test]
  fn the_snapshot_never_offers_more_memory_than_the_machine_has() {
    let (total, available) = memory_figures();
    assert_eq!(total.is_some(), available.is_some());
    if let (Some(total), Some(available)) = (total, available) { assert!(available <= total, "{available} > {total}"); }
  }

  #[test]
  fn only_this_module_decides_the_available_memory_figure() {
    // V2-D114: the preflight compares an estimate with ONE figure, decided in `memory_figures`. A second reader of the library's own
    // available-memory number would bring back the macOS reading of zero without any test noticing, so no other file may call it.
    fn rust_files(directory: &std::path::Path, found: &mut Vec<std::path::PathBuf>) {
      for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
          rust_files(&path, found);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
          found.push(path);
        }
      }
    }
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&source, &mut files);
    assert!(files.len() > 5, "the walk found {} source files", files.len());
    let mut readers: Vec<String> = files
      .iter()
      .filter(|path| std::fs::read_to_string(path).unwrap().contains(".available_memory()"))
      .map(|path| path.strip_prefix(&source).unwrap().to_string_lossy().replace('\\', "/"))
      .collect();
    readers.sort();
    assert_eq!(readers, ["jobs/resources.rs"], "another file reads the library's available-memory figure");
    let jobs = std::fs::read_to_string(source.join("jobs.rs")).unwrap();
    assert!(jobs.contains("resources::memory_figures()"), "export_resources must take its memory figures from memory_figures");
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn the_kernel_answers_with_a_percentage_and_the_snapshot_follows_it() {
    let before = kernel_available_percent().unwrap();
    assert!((0..=100).contains(&before), "{before}");
    let (total, available) = memory_figures();
    let (total, available) = (total.unwrap(), available.unwrap());
    let after = kernel_available_percent().unwrap();
    // The kernel's figure moves slowly: the snapshot lies between two readings taken around it, give or take rounding and drift.
    let low = share_of(total, (before.min(after) - 5).max(0)).unwrap();
    let high = share_of(total, (before.max(after) + 5).min(100)).unwrap();
    assert!(low <= available && available <= high, "{low} <= {available} <= {high} (kernel {before}% then {after}%)");
  }

  #[cfg(target_os = "linux")]
  #[test]
  #[ignore = "requires the supported cgroup v2 QA host; the profile launcher independently checks actual app observations"]
  fn actual_kernel_snapshot_retains_its_process_and_directory_identity() {
    let snapshot = current().unwrap();
    assert_eq!(snapshot.process_id, std::process::id());
    assert_eq!(snapshot.version, 2);
    let serialized = serde_json::to_value(&snapshot).unwrap();
    assert!(serialized["identity"].as_str().unwrap().contains(':'));
    println!("native cgroup snapshot: {serialized}");
  }
}
