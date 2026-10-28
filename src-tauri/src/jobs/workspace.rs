use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use super::allocation::{AllocationUnit, Inventory};

#[derive(Clone, Copy, Default)]
struct RootUsage {
  bytes: u64,
  entries: u64,
  peak_bytes: u64,
  observed_from_creation: bool,
  allocation_unit: u64,
  allocated_excess: u64,
}

impl RootUsage {
  fn allocated(&self) -> Result<u64, String> {
    self.entries.checked_mul(self.allocation_unit).and_then(|rounding| self.bytes.checked_add(rounding))
      .and_then(|bytes| bytes.checked_add(self.allocated_excess)).ok_or("export workspace allocation size overflow".into())
  }
}

#[derive(Default)]
struct OutputUsage {
  users: u64,
  execution: bool,
  reserved: bool,
}

#[derive(Default)]
struct State {
  used: u64,
  allocated: u64,
  entries: u64,
  roots: HashMap<String, RootUsage>,
  metadata: HashMap<String, RootUsage>,
  metadata_allocated: u64,
  metadata_active: bool,
  metadata_fault: Option<String>,
  output_claims: HashMap<String, OutputUsage>,
}

pub struct Workspace {
  limit: u64,
  allocation_limit: u64,
  metadata_limit: u64,
  entry_limit: u64,
  state: Mutex<State>,
  changed: Condvar,
}

impl Workspace {
  pub fn new(limit: u64) -> Arc<Self> { Arc::new(Self { limit, allocation_limit: super::EXPORT_WORKSPACE_PAYLOAD_BYTES,
    metadata_limit: super::EXPORT_SCRATCH_LIMIT_BYTES - super::EXPORT_WORKSPACE_PAYLOAD_BYTES,
    entry_limit: 16384, state: Mutex::new(State::default()), changed: Condvar::new() }) }

  pub(super) fn temporary_space(&self) -> super::ExportTemporarySpace {
    let payload_bytes = self.limit.min(self.allocation_limit);
    super::ExportTemporarySpace { scope: "app-managed-allocation-v1",
      total_bytes: payload_bytes + self.metadata_limit, payload_bytes,
      infrastructure_bytes: self.metadata_limit, entry_limit: self.entry_limit }
  }

  pub(super) fn available_bytes(&self) -> u64 {
    let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    self.limit.saturating_sub(state.used).min(self.allocation_limit.saturating_sub(state.allocated))
  }

  fn metadata_fit(&self, state: &State) -> Result<(), String> {
    if let Some(error) = &state.metadata_fault { return Err(format!("export infrastructure allocation is unavailable: {error}")); }
    if state.metadata_allocated > self.metadata_limit { return Err("export infrastructure allocation budget exceeded".into()); }
    if state.entries > self.entry_limit { return Err("export workspace entry budget exceeded by retained infrastructure".into()); }
    Ok(())
  }

  pub(super) fn require_metadata_fit(&self) -> Result<(), String> {
    self.metadata_fit(&self.state.lock().unwrap_or_else(|error| error.into_inner()))
  }

  pub(super) fn metadata_unavailable(&self, error: &str) {
    self.state.lock().unwrap_or_else(|error| error.into_inner()).metadata_fault = Some(error.to_string());
  }

  pub(super) fn inventory_metadata(&self, scopes: &[String], inventory: &HashMap<String, Inventory>, complete: bool) -> Result<(), String> {
    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    state.metadata_active = true;
    let mut next = state.metadata.clone();
    if complete {
      next.retain(|key, _| !scopes.iter().any(|scope| super::export_paths_overlap(key, scope)) || inventory.contains_key(key));
    }
    let observed = (|| -> Result<(u64, u64), String> {
      for (key, actual) in inventory {
        if actual.entries != 1 { return Err("native export infrastructure inventory must describe one entry".into()); }
        let previous = next.get(key).copied().unwrap_or_default();
        let rounded = actual.bytes.checked_add(actual.volume.bytes()).ok_or("export infrastructure inventory size overflow")?;
        next.insert(key.clone(), RootUsage { bytes: previous.bytes.max(actual.bytes), entries: 1,
          allocation_unit: previous.allocation_unit.max(actual.volume.bytes()),
          allocated_excess: previous.allocated_excess.max(actual.allocated.saturating_sub(rounded)), ..previous });
      }
      let allocated = next.values().try_fold(0u64, |total, usage| total.checked_add(usage.allocated()?)
        .ok_or_else(|| "export infrastructure allocation total overflow".to_string()))?;
      let payload_entries = state.roots.values().try_fold(0u64, |total, usage| total.checked_add(usage.entries)
        .ok_or_else(|| "export workspace entry total overflow".to_string()))?;
      let entries = payload_entries.checked_add(next.len() as u64).ok_or("export infrastructure entry total overflow")?;
      Ok((allocated, entries))
    })();
    state.metadata = next;
    match observed {
      Ok((allocated, entries)) => {
        state.metadata_allocated = allocated;
        state.entries = entries;
        if complete { state.metadata_fault = None; }
        Ok(())
      }
      Err(error) => {
        state.metadata_fault = Some(error.clone());
        Err(error)
      }
    }
  }

  pub(super) fn reserve_metadata_in(self: &Arc<Self>, key: &str, bytes: u64, volume: AllocationUnit,
    replacing: Option<&str>) -> Result<MetadataCharge, String> {
    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    state.metadata_active = true;
    self.metadata_fit(&state)?;
    if state.metadata.contains_key(key) { return Err("export infrastructure entry already has an allocation owner".into()); }
    let replacement = replacing.is_some_and(|target| state.metadata.contains_key(target));
    if replacing.is_some() && !replacement { return Err("export receipt replacement has no retained allocation owner".into()); }
    let entries = state.entries.checked_add(1).ok_or("export infrastructure entry size overflow")?;
    if entries > self.entry_limit.saturating_sub(u64::from(!replacement)) {
      return Err("export workspace entry budget exceeded before infrastructure creation".into());
    }
    let owned = RootUsage { bytes, entries: 1, allocation_unit: volume.bytes(), ..RootUsage::default() };
    let allocated = state.metadata_allocated.checked_add(owned.allocated()?).ok_or("export infrastructure allocation total overflow")?;
    if allocated > self.metadata_limit { return Err("export infrastructure allocation budget exceeded before creation".into()); }
    state.metadata.insert(key.to_string(), owned);
    state.metadata_allocated = allocated;
    state.entries = entries;
    Ok(MetadataCharge { owner: self.clone(), key: key.to_string(), retained: false })
  }

  pub(super) fn release_metadata(&self, key: &str) {
    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(usage) = state.metadata.remove(key) {
      state.metadata_allocated = state.metadata_allocated.saturating_sub(usage.allocated().expect("admitted infrastructure allocation fits"));
      state.entries = state.entries.saturating_sub(1);
    }
  }

  pub(super) fn install_metadata(&self, temporary: &str, target: &str) -> Result<(), String> {
    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    let installed = state.metadata.remove(temporary).ok_or("installed export receipt lost its temporary allocation owner")?;
    if let Some(previous) = state.metadata.insert(target.to_string(), installed) {
      state.metadata_allocated = state.metadata_allocated.checked_sub(previous.allocated()?)
        .ok_or("export infrastructure replacement allocation underflow")?;
      state.entries = state.entries.checked_sub(1).ok_or("export infrastructure replacement entry underflow")?;
    }
    Ok(())
  }

  pub(super) fn peak_bytes(&self, root: &str) -> Option<u64> {
    self.state.lock().unwrap_or_else(|error| error.into_inner()).roots.get(root)
      .filter(|usage| usage.observed_from_creation).map(|usage| usage.peak_bytes)
  }

  pub(super) fn account_allocated(&self, root: &str, inventory: Inventory) -> Result<(), String> {
    self.account_usage(root, inventory, 0, 0, true)
  }

  pub(super) fn restore_allocated(&self, root: &str, inventory: Inventory, reserved_bytes: u64, reserved_entries: u64) -> Result<(), String> {
    self.account_usage(root, inventory, reserved_bytes, reserved_entries, false)
  }

  fn account_usage(&self, root: &str, inventory: Inventory, reserved_bytes: u64, reserved_entries: u64, require_fit: bool) -> Result<(), String> {
    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    let previous = state.roots.get(root).copied().unwrap_or_default();
    let observed_payload = inventory.entries.checked_mul(inventory.volume.bytes())
      .and_then(|rounding| inventory.bytes.checked_add(rounding)).ok_or("export observed allocation size overflow")?;
    let allocated_excess = inventory.allocated.saturating_sub(observed_payload);
    let bytes = inventory.bytes.max(reserved_bytes).max(previous.bytes);
    let entries = inventory.entries.max(reserved_entries).max(previous.entries);
    let used = state.used.checked_add(bytes - previous.bytes).ok_or("export workspace size overflow")?;
    let count = state.entries.checked_add(entries - previous.entries).ok_or("export workspace entry overflow")?;
    let owned = RootUsage { bytes, entries, peak_bytes: previous.peak_bytes.max(bytes),
      observed_from_creation: previous.observed_from_creation, allocation_unit: previous.allocation_unit.max(inventory.volume.bytes()),
      allocated_excess: previous.allocated_excess.max(allocated_excess) };
    let previous_allocated = previous.allocated()?;
    let owned_allocated = owned.allocated()?;
    let total_allocated = state.allocated.checked_sub(previous_allocated).and_then(|bytes| bytes.checked_add(owned_allocated))
      .ok_or("export workspace allocation total overflow")?;
    state.roots.insert(root.to_string(), owned);
    state.used = used;
    state.allocated = total_allocated;
    state.entries = count;
    if count > self.entry_limit { return Err("export workspace entry budget exceeded by retained scratch".into()); }
    if require_fit { self.metadata_fit(&state)?; }
    if require_fit && used > self.limit { return Err("export workspace budget exceeded by retained scratch".into()); }
    if require_fit && total_allocated > self.allocation_limit { return Err("export workspace allocation budget exceeded by retained scratch".into()); }
    Ok(())
  }

  pub(super) fn reserve_in(self: &Arc<Self>, root: &str, bytes: u64, entries: u64, volume: AllocationUnit) -> Result<Charge, String> {
    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    self.metadata_fit(&state)?;
    let used = state.used.checked_add(bytes).ok_or("export workspace size overflow")?;
    if used > self.limit { return Err("export workspace budget exceeded before write".into()); }
    let count = state.entries.checked_add(entries).ok_or("export workspace entry overflow")?;
    if count > self.entry_limit.saturating_sub(u64::from(state.metadata_active && entries > 0)) {
      return Err("export workspace entry budget exceeded before write".into());
    }
    let previous = state.roots.get(root).copied().unwrap_or(RootUsage { observed_from_creation: true, ..RootUsage::default() });
    let owned_bytes = previous.bytes.checked_add(bytes).ok_or("owned export workspace size overflow")?;
    let owned = RootUsage { bytes: owned_bytes,
      entries: previous.entries.checked_add(entries).ok_or("owned export entry size overflow")?, peak_bytes: previous.peak_bytes.max(owned_bytes),
      observed_from_creation: previous.observed_from_creation, allocation_unit: previous.allocation_unit.max(volume.bytes()),
      allocated_excess: previous.allocated_excess };
    let previous_allocated = previous.allocated()?;
    let owned_allocated = owned.allocated()?;
    let total_allocated = state.allocated.checked_sub(previous_allocated).and_then(|bytes| bytes.checked_add(owned_allocated))
      .ok_or("export workspace allocation total overflow")?;
    if total_allocated > self.allocation_limit { return Err("export workspace allocation budget exceeded before write".into()); }
    state.roots.insert(root.to_string(), owned);
    state.used = used;
    state.allocated = total_allocated;
    state.entries = count;
    Ok(Charge { owner: self.clone(), root: root.to_string(), bytes, entries, volume, retained: false })
  }

  pub(super) fn reserve_output(self: &Arc<Self>, root: &str) -> Result<(u64, Charge), String> {
    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    self.metadata_fit(&state)?;
    let output = state.output_claims.get(root).ok_or("pending output has no admitted workspace claim")?;
    if output.reserved { return Err("pending output already has a native writer".into()); }
    let remaining = self.limit.checked_sub(state.used).ok_or("export workspace already exceeds its temporary budget")?
      .min(self.allocation_limit.checked_sub(state.allocated).ok_or("export workspace already exceeds its allocation budget")?);
    let previous = state.roots.get(root).copied().ok_or("pending output has no admitted allocation volume")?;
    if previous.allocation_unit == 0 { return Err("pending output has no admitted allocation unit".into()); }
    let limit = previous.bytes.checked_add(remaining).filter(|bytes| *bytes > 0)
      .ok_or("export has no temporary capacity for its pending output")?;
    let owned = RootUsage { bytes: limit, peak_bytes: previous.peak_bytes.max(limit), ..previous };
    let previous_allocated = previous.allocated()?;
    let owned_allocated = owned.allocated()?;
    let allocated = state.allocated.checked_sub(previous_allocated).and_then(|bytes| bytes.checked_add(owned_allocated))
      .filter(|bytes| *bytes <= self.allocation_limit).ok_or("pending output exceeds its allocation budget")?;
    state.used += remaining;
    state.allocated = allocated;
    state.roots.insert(root.to_string(), owned);
    state.output_claims.get_mut(root).ok_or("pending output lost its workspace claim")?.reserved = true;
    Ok((limit, Charge { owner: self.clone(), root: root.to_string(), bytes: remaining, entries: 0,
      volume: super::allocation::AllocationUnit::from_admitted(previous.allocation_unit), retained: false }))
  }

  pub(super) fn claim_output(self: &Arc<Self>, root: &str, check: &dyn Fn() -> Result<(), String>) -> Result<OutputClaim, String> {
    loop {
      check()?;
      let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
      if state.output_claims.keys().all(|owner| owner == root) {
        let output = state.output_claims.entry(root.to_string()).or_default();
        output.users = output.users.checked_add(1).ok_or("output workspace claim overflow")?;
        return Ok(OutputClaim { owner: self.clone(), root: root.to_string() });
      }
      let (state, _) = self.changed.wait_timeout(state, std::time::Duration::from_millis(100))
        .unwrap_or_else(|error| error.into_inner());
      drop(state);
    }
  }

  pub(super) fn finish_output_claim(&self, root: &str) {
    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(output) = state.output_claims.get_mut(root) {
      output.execution = false;
      if output.users == 0 && !output.reserved { state.output_claims.remove(root); }
    }
    drop(state);
    self.changed.notify_all();
  }

  pub(super) fn settle_output_writer(&self, root: &str) {
    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(output) = state.output_claims.get_mut(root) {
      output.reserved = false;
      if output.users == 0 && !output.execution { state.output_claims.remove(root); }
    }
    drop(state);
    self.changed.notify_all();
  }

  pub fn release(&self, root: &str, bytes: u64, entries: u64) {
    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    let owned = state.roots.get(root).copied().unwrap_or_default();
    let released = bytes.min(owned.bytes);
    let released_entries = entries.min(owned.entries);
    state.used = state.used.saturating_sub(released);
    state.entries = state.entries.saturating_sub(released_entries);
    let remaining = if released == owned.bytes && released_entries == owned.entries && owned.allocated_excess == 0 { None }
      else { Some(RootUsage { bytes: owned.bytes - released, entries: owned.entries - released_entries, ..owned }) };
    let released_allocated = owned.allocated().expect("admitted allocation fits")
      - remaining.map(|usage| usage.allocated().expect("smaller allocation fits")).unwrap_or(0);
    state.allocated = state.allocated.saturating_sub(released_allocated);
    if let Some(remaining) = remaining { state.roots.insert(root.to_string(), remaining); }
    else { state.roots.remove(root); }
  }

  pub fn release_root(&self, root: &str) {
    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(usage) = state.roots.remove(root) {
      state.used = state.used.saturating_sub(usage.bytes);
      state.allocated = state.allocated.saturating_sub(usage.allocated().expect("admitted allocation fits"));
      state.entries = state.entries.saturating_sub(usage.entries);
    }
    state.output_claims.remove(root);
    drop(state);
    self.changed.notify_all();
  }

  #[cfg(test)]
  fn used(&self) -> u64 { self.state.lock().unwrap().used }

  #[cfg(test)]
  pub(super) fn allocation_fixture(limit: u64, allocation_limit: u64) -> Arc<Self> {
    let mut owner = Self::new(limit);
    Arc::get_mut(&mut owner).unwrap().allocation_limit = allocation_limit;
    owner
  }

  #[cfg(test)]
  pub(super) fn metadata_fixture(limit: u64, metadata_limit: u64) -> Arc<Self> {
    let mut owner = Self::new(limit);
    Arc::get_mut(&mut owner).unwrap().metadata_limit = metadata_limit;
    owner
  }

  #[cfg(test)]
  pub(super) fn available_entries(&self) -> u64 {
    let state = self.state.lock().unwrap();
    self.entry_limit.saturating_sub(state.entries).saturating_sub(u64::from(state.metadata_active))
  }

  #[cfg(test)]
  pub(super) fn metadata_allocated(&self) -> u64 { self.state.lock().unwrap().metadata_allocated }

  #[cfg(test)]
  pub(super) fn account_existing(&self, root: &str, bytes: u64, entries: u64) -> Result<(), String> {
    self.account_allocated(root, Inventory { bytes, entries, allocated: bytes, volume: AllocationUnit::logical_fixture() })
  }

  #[cfg(test)]
  pub(super) fn reserve(self: &Arc<Self>, root: &str, bytes: u64, entries: u64) -> Result<Charge, String> {
    self.reserve_in(root, bytes, entries, AllocationUnit::logical_fixture())
  }
}

pub(super) struct MetadataCharge {
  owner: Arc<Workspace>,
  key: String,
  retained: bool,
}

impl MetadataCharge {
  pub(super) fn retain(mut self) { self.retained = true; }
}

impl Drop for MetadataCharge {
  fn drop(&mut self) { if !self.retained { self.owner.release_metadata(&self.key); } }
}

pub(super) struct Charge {
  owner: Arc<Workspace>,
  root: String,
  bytes: u64,
  entries: u64,
  volume: AllocationUnit,
  retained: bool,
}

impl Charge {
  pub fn grow(&mut self, bytes: u64) -> Result<(), String> {
    let total = self.bytes.checked_add(bytes).ok_or("temporary workspace charge overflow")?;
    self.owner.reserve_in(&self.root, bytes, 0, self.volume)?.retain();
    self.bytes = total;
    Ok(())
  }
  pub fn retain(mut self) { self.retained = true; }
}

impl Drop for Charge {
  fn drop(&mut self) { if !self.retained { self.owner.release(&self.root, self.bytes, self.entries); } }
}

#[cfg(test)]
mod tests {
  use super::*;
  use super::super::allocation;
  use std::io::Write;
  use std::sync::Barrier;

  fn allocation_fixture() -> (tempfile::TempDir, AllocationUnit, Vec<u8>) {
    let directory = tempfile::tempdir().unwrap();
    let volume = AllocationUnit::for_directory(directory.path()).unwrap();
    assert!(volume.bytes() <= 1024 * 1024, "fixture allocation unit exceeds its bounded write budget");
    let payload = allocation::fixture_bytes(usize::try_from(volume.bytes() + 1).unwrap());
    (directory, volume, payload)
  }

  fn write_allocated(path: &std::path::Path, payload: &[u8]) -> allocation::Usage {
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path).unwrap();
    file.write_all(payload).unwrap();
    file.sync_all().unwrap();
    drop(file);
    assert_eq!(std::fs::read(path).unwrap(), payload);
    let actual = allocation::usage(path).unwrap();
    assert_eq!(actual.bytes, payload.len() as u64);
    assert!(actual.allocated > actual.bytes, "filesystem did not exhibit the allocation-rounding witness");
    actual
  }

  #[test]
  fn native_inventory_holds_live_writer_extents_without_payload_read_access() {
    let (directory, volume, payload) = allocation_fixture();
    let path = directory.path().join("live-writer.bin");
    let actual = write_allocated(&path, &payload);
    #[cfg(windows)]
    let blocker = {
      use std::os::windows::fs::OpenOptionsExt;
      std::fs::OpenOptions::new().write(true).share_mode(0).open(&path).unwrap()
    };
    #[cfg(unix)]
    let blocker = {
      use std::os::unix::fs::PermissionsExt;
      assert_ne!(unsafe { libc::geteuid() }, 0, "payload-access discriminator requires the non-root CI user");
      struct RestorePermissions(std::path::PathBuf, std::fs::Permissions);
      impl Drop for RestorePermissions {
        fn drop(&mut self) {
          std::fs::set_permissions(&self.0, self.1.clone()).expect("could not restore the payload-access fixture permissions");
        }
      }
      let permissions = path.metadata().unwrap().permissions();
      std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o200)).unwrap();
      RestorePermissions(path.clone(), permissions)
    };
    assert!(path.exists());
    let denied = std::fs::read(&path).unwrap_err();
    #[cfg(windows)]
    assert_eq!(denied.raw_os_error(), Some(32));
    #[cfg(unix)]
    assert_eq!(denied.raw_os_error(), Some(libc::EACCES));
    let inventory = Inventory::for_file(&path).unwrap();
    assert_eq!(inventory.bytes, actual.bytes);
    assert_eq!(inventory.allocated, actual.allocated);
    let cap = 3 * volume.bytes();
    let owner = Workspace::allocation_fixture(8 * volume.bytes(), cap);
    owner.restore_allocated("retained", inventory, 0, 0).unwrap();
    let next = directory.path().join("not-admitted.bin");
    assert!(owner.reserve_in("new", payload.len() as u64, 1, volume).err().unwrap().contains("allocation budget"));
    assert!(!next.exists());
    drop(blocker);
    assert_eq!(std::fs::read(&path).unwrap(), payload);
    std::fs::remove_file(path).unwrap();
    owner.release_root("retained");
    assert_eq!(owner.available_bytes(), cap);
    let charge = owner.reserve_in("after-cleanup", payload.len() as u64, 1, volume).unwrap();
    assert!(write_allocated(&next, &payload).allocated <= cap);
    std::fs::remove_file(next).unwrap();
    drop(charge);
    assert_eq!(owner.available_bytes(), cap);
  }

  fn preallocated_root() -> (tempfile::TempDir, AllocationUnit, std::fs::File, Inventory) {
    let (directory, volume, _) = allocation_fixture();
    let file = allocation::preallocated_fixture(&directory.path().join("retained.bin"), volume);
    let inventory = super::super::measured_scratch_usage(directory.path(), std::path::Path::new("")).unwrap();
    assert!(inventory.allocated > inventory.bytes + inventory.entries * volume.bytes(),
      "native root inventory did not exhibit allocation beyond payload and entry rounding");
    (directory, volume, file, inventory)
  }

  #[test]
  fn same_root_observed_excess_cannot_pay_for_another_actual_file() {
    let (directory, volume, retained, inventory) = preallocated_root();
    let cap = inventory.allocated;
    let owner = Workspace::allocation_fixture(64 * volume.bytes(), cap);
    owner.restore_allocated("shared", inventory, 0, 0).unwrap();
    let next = directory.path().join("not-admitted.bin");
    assert!(owner.reserve_in("shared", volume.bytes() + 1, 1, volume).err().unwrap().contains("allocation budget"));
    assert!(!next.exists());
    assert_eq!(std::fs::read(directory.path().join("retained.bin")).unwrap(), [0x5a]);
    assert_eq!(owner.available_bytes(), 0);
    drop(retained);
    directory.close().unwrap();
    owner.release_root("shared");
    assert_eq!(owner.available_bytes(), cap);
    let fresh = tempfile::tempdir().unwrap();
    let payload = allocation::fixture_bytes(usize::try_from(volume.bytes() + 1).unwrap());
    let charge = owner.reserve_in("after-cleanup", payload.len() as u64, 1, volume).unwrap();
    let path = fresh.path().join("admitted.bin");
    assert!(write_allocated(&path, &payload).allocated <= cap);
    std::fs::remove_file(path).unwrap();
    drop(charge);
    assert_eq!(owner.available_bytes(), cap);
  }

  #[test]
  fn unwritten_reservations_cannot_hide_native_excess_in_either_observation_order() {
    for recovered in [false, true] {
      let (directory, volume, retained, inventory) = preallocated_root();
      let cap = inventory.allocated + 2 * volume.bytes();
      let owner = Workspace::allocation_fixture(64 * volume.bytes(), cap);
      let active = if recovered {
        owner.restore_allocated("shared", inventory, 4 * volume.bytes(), inventory.entries).unwrap();
        None
      } else {
        let charge = owner.reserve_in("shared", 4 * volume.bytes(), inventory.entries, volume).unwrap();
        assert!(owner.account_allocated("shared", inventory).err().unwrap().contains("allocation budget"));
        Some(charge)
      };
      assert_eq!(owner.available_bytes(), 0);
      assert!(owner.account_allocated("shared", Inventory { bytes: 0, entries: 0, allocated: 0, volume }).is_err());
      assert!(owner.reserve_in("shared", 1, 1, volume).is_err());
      assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
      assert_eq!(std::fs::read(directory.path().join("retained.bin")).unwrap(), [0x5a]);
      drop(retained);
      directory.close().unwrap();
      drop(active);
      owner.release_root("shared");
      assert_eq!(owner.available_bytes(), cap);
    }
  }

  #[test]
  fn refused_inventory_admission_still_blocks_spending_against_actual_retained_extents() {
    let (directory, volume, retained, inventory) = preallocated_root();
    let cap = 3 * volume.bytes();
    assert!(inventory.allocated > cap);
    let owner = Workspace::allocation_fixture(64 * volume.bytes(), cap);
    let charge = owner.reserve_in("shared", 0, inventory.entries, volume).unwrap();
    assert!(owner.account_allocated("shared", inventory).err().unwrap().contains("allocation budget"));
    assert!(owner.reserve_in("unrelated", volume.bytes() + 1, 1, volume).is_err());
    assert_eq!(owner.available_bytes(), 0);
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    assert_eq!(std::fs::read(directory.path().join("retained.bin")).unwrap(), [0x5a]);
    drop(retained);
    directory.close().unwrap();
    drop(charge);
    owner.release_root("shared");
    assert_eq!(owner.available_bytes(), cap);
  }

  #[test]
  fn concurrent_same_root_writers_cannot_reuse_retained_native_extent_excess() {
    let (directory, volume, retained, inventory) = preallocated_root();
    let payload = allocation::fixture_bytes(usize::try_from(volume.bytes() + 1).unwrap());
    let cap = inventory.allocated + 2 * volume.bytes() + 1;
    let owner = Workspace::allocation_fixture(64 * volume.bytes(), cap);
    owner.restore_allocated("shared", inventory, 0, 0).unwrap();
    let gate = Arc::new(Barrier::new(3));
    let workers = ["first.bin", "second.bin"].into_iter().map(|name| {
      let owner = owner.clone();
      let gate = gate.clone();
      let payload = payload.clone();
      let path = directory.path().join(name);
      std::thread::spawn(move || {
        gate.wait();
        match owner.reserve_in("shared", payload.len() as u64, 1, volume) {
          Ok(charge) => { write_allocated(&path, &payload); charge.retain(); true }
          Err(error) => { assert!(error.contains("allocation budget"), "{error}"); false }
        }
      })
    }).collect::<Vec<_>>();
    gate.wait();
    assert_eq!(workers.into_iter().map(|worker| worker.join().unwrap()).filter(|written| *written).count(), 1);
    let files = std::fs::read_dir(directory.path()).unwrap().map(|entry| entry.unwrap().path())
      .filter(|path| path.file_name().unwrap() != "retained.bin").collect::<Vec<_>>();
    assert_eq!(files.len(), 1);
    assert_eq!(std::fs::read(&files[0]).unwrap(), payload);
    let actual = super::super::measured_scratch_usage(directory.path(), std::path::Path::new("")).unwrap();
    assert!(actual.allocated <= cap, "actual concurrent files exceeded their native allocation allowance");
    drop(retained);
    directory.close().unwrap();
    owner.release_root("shared");
    assert_eq!(owner.available_bytes(), cap);
  }

  #[test]
  fn pending_output_cannot_reuse_its_retained_native_extent_excess() {
    use std::io::{Seek, SeekFrom};
    let (directory, volume, mut retained, _) = preallocated_root();
    let path = directory.path().join("retained.bin");
    let inventory = Inventory::for_file(&path).unwrap();
    let cap = inventory.allocated + 4 * volume.bytes();
    let owner = Workspace::allocation_fixture(64 * volume.bytes(), cap);
    owner.account_allocated("stage", inventory).unwrap();
    let claim = owner.claim_output("stage", &|| Ok(())).unwrap();
    let (limit, charge) = owner.reserve_output("stage").unwrap();
    assert!(owner.reserve_in("unrelated", volume.bytes() + 1, 1, volume).is_err());
    assert_eq!(owner.available_bytes(), 0);
    let payload = allocation::fixture_bytes(usize::try_from(limit - 1).unwrap());
    retained.seek(SeekFrom::Start(0)).unwrap();
    retained.write_all(&payload).unwrap();
    retained.sync_all().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), payload);
    assert!(allocation::usage(&path).unwrap().allocated <= cap);
    drop(retained);
    directory.close().unwrap();
    drop(charge);
    drop(claim);
    owner.release_root("stage");
    assert_eq!(owner.available_bytes(), cap);
  }

  #[test]
  fn actual_allocated_inventory_keeps_payload_and_directory_extents() {
    let (directory, volume, payload) = allocation_fixture();
    let nested = directory.path().join("nested");
    std::fs::create_dir(&nested).unwrap();
    let first = directory.path().join("first.bin");
    let second = nested.join("second.bin");
    let first_usage = write_allocated(&first, &payload);
    let second_usage = write_allocated(&second, &payload);
    let inventory = super::super::measured_scratch_usage(directory.path(), std::path::Path::new("")).unwrap();
    assert_eq!(inventory.bytes, first_usage.bytes + second_usage.bytes);
    assert_eq!(inventory.allocated, first_usage.allocated + second_usage.allocated
      + allocation::usage(directory.path()).unwrap().allocated + allocation::usage(&nested).unwrap().allocated);
    assert!(inventory.allocated > inventory.bytes);
    assert_eq!(inventory.volume.bytes(), volume.bytes());
    let excluded = super::super::measured_scratch_usage(directory.path(), &first).unwrap();
    assert_eq!(excluded.bytes, second_usage.bytes);
    assert_eq!(inventory.allocated - excluded.allocated, first_usage.allocated);
    assert_eq!(std::fs::read(first).unwrap(), payload);
    assert_eq!(std::fs::read(second).unwrap(), payload);
  }

  #[test]
  fn allocation_pressure_refuses_actual_second_write_until_first_is_deleted() {
    let (directory, volume, payload) = allocation_fixture();
    let cap = 3 * volume.bytes();
    let owner = Workspace::allocation_fixture(8 * volume.bytes(), cap);
    let available = owner.available_bytes();
    let first = directory.path().join("first.bin");
    let second = directory.path().join("second.bin");
    let first_charge = owner.reserve_in("first", payload.len() as u64, 1, volume).unwrap();
    let actual = write_allocated(&first, &payload);
    assert!(actual.allocated <= cap && 2 * actual.allocated > cap);
    assert!(owner.limit - owner.used() >= payload.len() as u64);
    let clock = super::super::export_delivery_tests::journal_write_clock(directory.path());
    let error = owner.reserve_in("second", payload.len() as u64, 1, volume).err().unwrap();
    assert!(error.contains("allocation budget"), "{error}");
    assert!(!second.exists());
    assert_eq!(std::fs::metadata(directory.path()).unwrap().modified().unwrap(), clock);
    assert_eq!(std::fs::read(&first).unwrap(), payload);
    std::fs::remove_file(&first).unwrap();
    drop(first_charge);
    assert_eq!(owner.available_bytes(), available);
    let second_charge = owner.reserve_in("second", payload.len() as u64, 1, volume).unwrap();
    let second_usage = write_allocated(&second, &payload);
    assert!(owner.state.lock().unwrap().allocated >= second_usage.allocated);
    std::fs::remove_file(second).unwrap();
    drop(second_charge);
    assert_eq!(owner.available_bytes(), available);
  }

  #[test]
  fn restored_extent_pressure_blocks_new_files_until_actual_root_cleanup() {
    let (directory, volume, payload) = allocation_fixture();
    let retained = directory.path().join("retained.bin");
    let actual = write_allocated(&retained, &payload);
    let cap = 3 * volume.bytes();
    assert!(actual.allocated <= cap && 2 * actual.allocated > cap);
    let owner = Workspace::allocation_fixture(8 * volume.bytes(), cap);
    owner.restore_allocated("retained", Inventory::for_file(&retained).unwrap(), 0, 0).unwrap();
    assert_eq!(owner.peak_bytes("retained"), None);
    assert!(owner.limit - owner.used() >= payload.len() as u64);
    assert!(owner.reserve_in("next", payload.len() as u64, 1, volume).err().unwrap().contains("allocation budget"));
    owner.account_allocated("retained", Inventory { bytes: 0, entries: 0, allocated: 0, volume }).unwrap();
    assert!(owner.state.lock().unwrap().allocated >= actual.allocated);
    assert!(owner.reserve_in("next", payload.len() as u64, 1, volume).is_err());
    assert_eq!(std::fs::read(&retained).unwrap(), payload);
    std::fs::remove_file(retained).unwrap();
    owner.release_root("retained");
    let next = directory.path().join("next.bin");
    let charge = owner.reserve_in("next", payload.len() as u64, 1, volume).unwrap();
    let next_usage = write_allocated(&next, &payload);
    assert!(next_usage.allocated <= cap);
    std::fs::remove_file(next).unwrap();
    drop(charge);
    assert_eq!(owner.available_bytes(), cap);
  }

  #[test]
  fn concurrent_payload_writers_cannot_spend_the_same_allocation_capacity() {
    let (directory, volume, payload) = allocation_fixture();
    let cap = 3 * volume.bytes();
    let owner = Workspace::allocation_fixture(8 * volume.bytes(), cap);
    let gate = Arc::new(Barrier::new(3));
    let workers = ["first", "second"].into_iter().map(|name| {
      let owner = owner.clone();
      let gate = gate.clone();
      let payload = payload.clone();
      let path = directory.path().join(name);
      std::thread::spawn(move || {
        gate.wait();
        match owner.reserve_in(name, payload.len() as u64, 1, volume) {
          Ok(charge) => {
            write_allocated(&path, &payload);
            charge.retain();
            true
          }
          Err(error) => { assert!(error.contains("allocation budget"), "{error}"); false }
        }
      })
    }).collect::<Vec<_>>();
    gate.wait();
    assert_eq!(workers.into_iter().map(|worker| worker.join().unwrap()).filter(|written| *written).count(), 1);
    let files = std::fs::read_dir(directory.path()).unwrap().map(|entry| entry.unwrap().path()).collect::<Vec<_>>();
    assert_eq!(files.len(), 1);
    assert_eq!(std::fs::read(&files[0]).unwrap(), payload);
    let actual = allocation::usage(&files[0]).unwrap().allocated;
    assert!(actual <= cap && 2 * actual > cap);
    assert!(owner.state.lock().unwrap().allocated >= actual);
  }

  #[test]
  fn pending_output_reserves_only_the_physically_admitted_payload() {
    let (directory, volume, payload) = allocation_fixture();
    let retained = directory.path().join("retained.bin");
    let actual = write_allocated(&retained, &payload);
    let cap = 5 * volume.bytes();
    let owner = Workspace::allocation_fixture(8 * volume.bytes(), cap);
    owner.restore_allocated("retained", Inventory::for_file(&retained).unwrap(), 0, 0).unwrap();
    let stage = directory.path().join("stage.bin");
    std::fs::File::create(&stage).unwrap();
    owner.account_allocated("stage", Inventory::for_file(&stage).unwrap()).unwrap();
    let claim = owner.claim_output("stage", &|| Ok(())).unwrap();
    let logical_available = owner.limit - owner.used();
    let (limit, charge) = owner.reserve_output("stage").unwrap();
    assert!(limit > 1 && limit < logical_available);
    assert_eq!(owner.available_bytes(), 0);
    let bytes = allocation::fixture_bytes(usize::try_from(limit - 1).unwrap());
    let mut file = std::fs::OpenOptions::new().write(true).open(&stage).unwrap();
    file.write_all(&bytes).unwrap();
    file.sync_all().unwrap();
    drop(file);
    assert_eq!(std::fs::read(&stage).unwrap(), bytes);
    let produced = allocation::usage(&stage).unwrap();
    assert!(produced.allocated + actual.allocated <= cap);
    assert!(owner.state.lock().unwrap().allocated >= produced.allocated + actual.allocated);
    assert!(owner.reserve_in("blocked", 1, 1, volume).is_err());
    std::fs::remove_file(stage).unwrap();
    drop(charge);
    owner.release_root("stage");
    drop(claim);
    std::fs::remove_file(retained).unwrap();
    owner.release_root("retained");
    assert_eq!(owner.available_bytes(), cap);
  }

  #[test]
  fn allocation_lookup_refuses_missing_entries_without_dropping_unicode_paths() {
    let (directory, _, payload) = allocation_fixture();
    let missing = directory.path().join("not-created");
    assert!(AllocationUnit::for_directory(&missing).is_err());
    assert!(allocation::usage(&missing).is_err());
    assert!(!missing.exists());
    let legitimate = directory.path().join(format!("legitimate-{}", char::from_u32(0x03bb).unwrap()));
    std::fs::create_dir(&legitimate).unwrap();
    assert!(AllocationUnit::for_directory(&legitimate).unwrap().bytes() > 0);
    let file = legitimate.join("payload.bin");
    write_allocated(&file, &payload);
    assert!(AllocationUnit::for_directory(&file).is_err());
    assert_eq!(std::fs::read(file).unwrap(), payload);
  }

  #[test]
  fn scoped_preparation_finishes_before_a_competing_output_can_reserve_capacity() {
    let directory = tempfile::tempdir().unwrap();
    let owner = Workspace::new(64);
    let preparation = owner.claim_output("preparation", &|| Ok(())).unwrap();
    let competing = owner.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
      competing.account_existing("final-output", 0, 0).unwrap();
      let claim = competing.claim_output("final-output", &|| Ok(())).unwrap();
      let (limit, charge) = competing.reserve_output("final-output").unwrap();
      sender.send((claim, limit, charge)).unwrap();
    });
    assert!(matches!(receiver.recv_timeout(std::time::Duration::from_millis(100)), Err(std::sync::mpsc::RecvTimeoutError::Timeout)));
    let payload = directory.path().join("filter.ffgraph");
    owner.reserve("preparation", 12, 1).unwrap().retain();
    std::fs::write(&payload, b"null[output]").unwrap();
    assert_eq!(std::fs::read(&payload).unwrap(), b"null[output]");
    drop(preparation);
    let (claim, limit, charge) = receiver.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
    assert_eq!(limit, 52);
    assert_eq!(owner.available_bytes(), 0);
    drop(charge);
    drop(claim);
    owner.release_root("final-output");
    assert_eq!(owner.available_bytes(), 52);
    std::fs::remove_file(&payload).unwrap();
    owner.release_root("preparation");
    assert_eq!(owner.available_bytes(), 64);
    worker.join().unwrap();
  }

  #[test]
  fn peak_payload_survives_temporary_file_cleanup_without_holding_released_capacity() {
    let directory = tempfile::tempdir().unwrap();
    let owner = Workspace::new(64);
    let root = directory.path().to_string_lossy().into_owned();
    let first = directory.path().join("retained");
    let second = directory.path().join("temporary");
    owner.reserve(&root, 32, 1).unwrap().retain();
    std::fs::write(&first, [37u8; 32]).unwrap();
    let temporary = owner.reserve(&root, 16, 1).unwrap();
    std::fs::write(&second, [41u8; 16]).unwrap();
    let observed = std::fs::metadata(&first).unwrap().len() + std::fs::metadata(&second).unwrap().len();
    assert_eq!(owner.peak_bytes(&root), Some(observed));
    std::fs::remove_file(&second).unwrap();
    drop(temporary);
    assert_eq!(owner.peak_bytes(&root), Some(observed));
    let peer = owner.reserve("peer", 32, 1).unwrap();
    let peer_path = directory.path().join("peer");
    std::fs::write(&peer_path, [43u8; 32]).unwrap();
    assert_eq!(std::fs::read(&peer_path).unwrap(), vec![43u8; 32]);
    assert!(owner.reserve("blocked", 1, 1).is_err());
    assert_eq!(owner.peak_bytes(&root), Some(observed));
    std::fs::remove_file(&peer_path).unwrap();
    drop(peer);
    std::fs::remove_file(&first).unwrap();
    owner.release_root(&root);
    assert_eq!(owner.peak_bytes(&root), None);
  }

  #[test]
  fn recovered_files_enforce_capacity_without_inventing_an_unobserved_peak() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().to_string_lossy().into_owned();
    let retained = directory.path().join("retained");
    std::fs::write(&retained, [37u8; 32]).unwrap();
    let owner = Workspace::new(64);
    owner.account_existing(&root, std::fs::metadata(&retained).unwrap().len(), 1).unwrap();
    assert_eq!(owner.peak_bytes(&root), None);
    let temporary = owner.reserve(&root, 32, 1).unwrap();
    assert!(owner.reserve("blocked", 1, 1).is_err());
    assert_eq!(owner.peak_bytes(&root), None);
    drop(temporary);
    assert_eq!(std::fs::read(&retained).unwrap(), vec![37u8; 32]);
    owner.release_root(&root);
    let fresh = owner.reserve(&root, 16, 1).unwrap();
    assert_eq!(owner.peak_bytes(&root), Some(16));
    drop(fresh);
    assert_eq!(owner.peak_bytes(&root), None);
  }

  #[test]
  fn concurrent_owned_writers_cannot_each_spend_the_same_remaining_bytes() {
    let directory = tempfile::tempdir().unwrap();
    let owner = Workspace::new(48);
    let gate = Arc::new(Barrier::new(3));
    let threads = ["first", "second"].into_iter().map(|name| {
      let owner = owner.clone();
      let gate = gate.clone();
      let path = directory.path().join(name);
      std::thread::spawn(move || {
        gate.wait();
        let Ok(charge) = owner.reserve(name, 32, 1) else { return false; };
        std::fs::write(path, [37u8; 32]).unwrap();
        charge.retain();
        true
      })
    }).collect::<Vec<_>>();
    gate.wait();
    let written = threads.into_iter().map(|thread| thread.join().unwrap()).filter(|written| *written).count();
    assert_eq!(written, 1);
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    assert_eq!(owner.used(), 32);
  }

  #[test]
  fn failure_releases_uninstalled_bytes_but_retained_files_keep_their_charge() {
    let owner = Workspace::new(64);
    owner.account_existing("old", 32, 1).unwrap();
    {
      let _temporary = owner.reserve("new", 32, 1).unwrap();
      assert!(owner.reserve("other", 1, 1).is_err());
    }
    assert_eq!(owner.used(), 32);
    owner.reserve("new", 32, 1).unwrap().retain();
    assert!(owner.reserve("other", 1, 1).is_err());
    owner.release_root("old");
    assert_eq!(owner.used(), 32);
    owner.reserve("other", 32, 1).unwrap().retain();
    assert_eq!(owner.used(), 64);
  }

  #[test]
  fn retained_accounting_never_overwrites_a_larger_live_reservation() {
    let owner = Workspace::new(64);
    owner.reserve("render", 48, 1).unwrap().retain();
    owner.account_existing("render", 16, 1).unwrap();
    assert!(owner.reserve("other", 17, 1).is_err());
    owner.account_existing("render", 56, 1).unwrap();
    assert_eq!(owner.used(), 56);
    assert!(owner.account_existing("retained", 9, 1).is_err());
    assert_eq!(owner.used(), 65);
    assert!(owner.reserve("after-refused-inventory", 1, 1).is_err());
  }

  #[test]
  fn entry_pressure_blocks_a_write_even_when_the_byte_budget_is_empty() {
    let directory = tempfile::tempdir().unwrap();
    let mut owner = Workspace::new(64);
    Arc::get_mut(&mut owner).unwrap().entry_limit = 2;
    let retained = directory.path().join("retained");
    std::fs::write(&retained, []).unwrap();
    owner.account_existing("old", 0, 1).unwrap();
    let temporary = directory.path().join("temporary");
    let charge = owner.reserve("new", 0, 1).unwrap();
    std::fs::write(&temporary, []).unwrap();
    assert!(owner.reserve("blocked", 0, 1).err().unwrap().contains("entry budget"));
    assert_eq!(owner.used(), 0);
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
    std::fs::remove_file(&temporary).unwrap();
    drop(charge);
    let admitted = owner.reserve("after-cleanup", 1, 1).unwrap();
    std::fs::write(directory.path().join("after-cleanup"), [37]).unwrap();
    admitted.retain();
    assert!(owner.account_existing("recovered", 0, 1).is_err());
    assert_eq!(std::fs::read(&retained).unwrap(), Vec::<u8>::new());
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
  }

  #[test]
  fn concurrent_writers_cannot_each_spend_the_last_filesystem_entry() {
    let directory = tempfile::tempdir().unwrap();
    let mut owner = Workspace::new(64);
    Arc::get_mut(&mut owner).unwrap().entry_limit = 1;
    let gate = Arc::new(Barrier::new(3));
    let threads = ["first", "second"].into_iter().map(|name| {
      let owner = owner.clone();
      let gate = gate.clone();
      let target = directory.path().join(name);
      std::thread::spawn(move || {
        gate.wait();
        let Ok(charge) = owner.reserve(name, 0, 1) else { return false; };
        std::fs::write(target, []).unwrap();
        charge.retain();
        true
      })
    }).collect::<Vec<_>>();
    gate.wait();
    assert_eq!(threads.into_iter().map(|thread| thread.join().unwrap()).filter(|written| *written).count(), 1);
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    assert_eq!(owner.used(), 0);
  }
}

pub(super) struct OutputClaim {
  owner: Arc<Workspace>,
  root: String,
}

impl OutputClaim {
  pub(super) fn retain(self) {
    if let Some(output) = self.owner.state.lock().unwrap_or_else(|error| error.into_inner()).output_claims.get_mut(&self.root) {
      output.execution = true;
    }
  }
}

impl Drop for OutputClaim {
  fn drop(&mut self) {
    let mut state = self.owner.state.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(output) = state.output_claims.get_mut(&self.root) {
      output.users = output.users.saturating_sub(1);
      if output.users == 0 && !output.execution && !output.reserved { state.output_claims.remove(&self.root); }
    }
    drop(state);
    self.owner.changed.notify_all();
  }
}
