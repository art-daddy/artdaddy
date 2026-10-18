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
