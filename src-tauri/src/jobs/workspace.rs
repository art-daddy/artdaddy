use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct State {
  used: u64,
  entries: u64,
  roots: HashMap<String, (u64, u64)>,
}

pub struct Workspace {
  limit: u64,
  entry_limit: u64,
  state: Mutex<State>,
}

impl Workspace {
  pub fn new(limit: u64) -> Arc<Self> { Arc::new(Self { limit, entry_limit: 16384, state: Mutex::new(State::default()) }) }

  pub(super) fn available_bytes(&self) -> u64 {
    self.limit.saturating_sub(self.state.lock().unwrap_or_else(|error| error.into_inner()).used)
  }

  pub fn account_existing(&self, root: &str, bytes: u64, entries: u64) -> Result<(), String> {
    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    let previous = state.roots.get(root).copied().unwrap_or((0, 0));
    let bytes = bytes.max(previous.0);
    let entries = entries.max(previous.1);
    let used = state.used.checked_add(bytes - previous.0).ok_or("export workspace size overflow")?;
    let count = state.entries.checked_add(entries - previous.1).ok_or("export workspace entry overflow")?;
    if used > self.limit { return Err("export workspace budget exceeded by retained scratch".into()); }
    if count > self.entry_limit { return Err("export workspace entry budget exceeded by retained scratch".into()); }
    state.roots.insert(root.to_string(), (bytes, entries));
    state.used = used;
    state.entries = count;
    Ok(())
  }

  pub(super) fn reserve(self: &Arc<Self>, root: &str, bytes: u64, entries: u64) -> Result<Charge, String> {
    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    let used = state.used.checked_add(bytes).ok_or("export workspace size overflow")?;
    if used > self.limit { return Err("export workspace budget exceeded before write".into()); }
    let count = state.entries.checked_add(entries).ok_or("export workspace entry overflow")?;
    if count > self.entry_limit { return Err("export workspace entry budget exceeded before write".into()); }
    let previous = state.roots.get(root).copied().unwrap_or((0, 0));
    let owned = (previous.0.checked_add(bytes).ok_or("owned export workspace size overflow")?,
      previous.1.checked_add(entries).ok_or("owned export entry size overflow")?);
    state.roots.insert(root.to_string(), owned);
    state.used = used;
    state.entries = count;
    Ok(Charge { owner: self.clone(), root: root.to_string(), bytes, entries, retained: false })
  }

  pub fn release(&self, root: &str, bytes: u64, entries: u64) {
    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    let owned = state.roots.get(root).copied().unwrap_or((0, 0));
    let released = bytes.min(owned.0);
    let released_entries = entries.min(owned.1);
    state.used = state.used.saturating_sub(released);
    state.entries = state.entries.saturating_sub(released_entries);
    if released == owned.0 && released_entries == owned.1 { state.roots.remove(root); }
    else { state.roots.insert(root.to_string(), (owned.0 - released, owned.1 - released_entries)); }
  }

  pub fn release_root(&self, root: &str) {
    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    if let Some((bytes, entries)) = state.roots.remove(root) {
      state.used = state.used.saturating_sub(bytes);
      state.entries = state.entries.saturating_sub(entries);
    }
  }

  #[cfg(test)]
  fn used(&self) -> u64 { self.state.lock().unwrap().used }
}

pub(super) struct Charge {
  owner: Arc<Workspace>,
  root: String,
  bytes: u64,
  entries: u64,
  retained: bool,
}

impl Charge {
  pub fn grow(&mut self, bytes: u64) -> Result<(), String> {
    let total = self.bytes.checked_add(bytes).ok_or("temporary workspace charge overflow")?;
    self.owner.reserve(&self.root, bytes, 0)?.retain();
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
  use std::sync::Barrier;

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
    assert_eq!(owner.used(), 56);
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