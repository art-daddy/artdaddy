use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_FAILURES: usize = 8;
const MAX_RECORD_BYTES: u64 = 64 * 1024;
const MAX_RECOVERY_RECORDS: usize = 3;
const RECOVERY_PREFIX: &str = "health-recovery-";
/// A mark of a launch this record knows nothing about is left alone for this long: it may belong to another copy that is running.
const STALE_MARK: std::time::Duration = std::time::Duration::from_secs(365 * 86_400);

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanExit {
  Quit,
  UpdateRestart,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
  UncleanExit,
  RustPanic,
  RendererExited,
  RendererUnresponsive,
  WebContentTerminated,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeAuth {
  #[default]
  Checking,
  Unlocked,
  Locked,
  Offline,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct RuntimeContext {
  pub project_id: String,
  pub user_id: String,
  pub activity: String,
  pub auth_state: RuntimeAuth,
  pub has_stored_session: bool,
  pub heap_mb: Option<u32>,
  pub heap_limit_mb: Option<u32>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct Session {
  launch_id: String,
  release: String,
  started_at: u64,
  alive_at: u64,
  exit: Option<CleanExit>,
  #[serde(default)]
  renderer_epoch: u64,
  #[serde(default)]
  heartbeat_revision: u64,
  /// Which start of the PC it ran in, to tell "the PC restarted since" from "something ended it" on macOS and Linux. Kept on this
  /// disk only: compared with the next start's, never sent.
  #[serde(default)]
  boot_id: String,
  context: RuntimeContext,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct RuntimeFailure {
  pub id: String,
  pub kind: FailureKind,
  pub at: u64,
  #[serde(default)]
  pub eligible: bool,
  session: Session,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct Record {
  current: Session,
  failures: Vec<RuntimeFailure>,
  sequence: u64,
  #[serde(default)]
  revision: u64,
}

struct HealthState {
  record: Record,
  previous_exit: Option<CleanExit>,
  storage_ok: bool,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct RendererToken {
  pub launch_id: String,
  pub renderer_epoch: u64,
}

#[derive(serde::Serialize)]
pub struct RuntimeStatus {
  #[serde(flatten)]
  pub token: RendererToken,
  pub previous_exit: Option<CleanExit>,
  pub failures: Vec<RuntimeFailure>,
  pub storage_ok: bool,
}

pub struct RuntimeHealth {
  path: PathBuf,
  state: Mutex<HealthState>,
}

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_millis() as u64)
    .unwrap_or(0)
}

fn append_failure(record: &mut Record, kind: FailureKind) {
  record.sequence = record.sequence.saturating_add(1);
  record.failures.push(RuntimeFailure {
    id: format!("{}-{}", record.current.launch_id, record.sequence),
    kind,
    at: now_ms(),
    eligible: reportable(&record.current.context),
    session: record.current.clone(),
  });
  if record.failures.len() > MAX_FAILURES {
    record
      .failures
      .drain(..record.failures.len() - MAX_FAILURES);
  }
}

fn reportable(context: &RuntimeContext) -> bool {
  context.auth_state != RuntimeAuth::Locked
    && (context.auth_state != RuntimeAuth::Offline || context.has_stored_session)
}

fn read_record(path: &Path) -> Option<Record> {
  std::fs::File::open(path)
    .ok()
    .and_then(|file| serde_json::from_reader(file.take(MAX_RECORD_BYTES)).ok())
}

fn recovery_paths(path: &Path) -> Vec<PathBuf> {
  let Some(parent) = path.parent() else {
    return Vec::new();
  };
  let Ok(entries) = std::fs::read_dir(parent) else {
    return Vec::new();
  };
  entries
    .flatten()
    .filter_map(|entry| {
      let name = entry.file_name();
      let name = name.to_str()?;
      (name.starts_with(RECOVERY_PREFIX) && name.ends_with(".json")).then(|| entry.path())
    })
    .collect()
}

fn latest_record(path: &Path) -> Option<Record> {
  read_record(path)
    .into_iter()
    .chain(
      recovery_paths(path)
        .iter()
        .filter_map(|checkpoint| read_record(checkpoint)),
    )
    .max_by_key(|record| record.revision)
}

impl RuntimeHealth {
  pub fn open(path: PathBuf, launch_id: String, release: String) -> Self {
    Self::open_in_boot(path, launch_id, release, crate::os_exit_cause::unix_end::current_boot_id())
  }

  /// Like `open`, for a session that ran in the given start of the PC (tests give it; the app asks the system).
  pub fn open_in_boot(path: PathBuf, launch_id: String, release: String, boot_id: String) -> Self {
    let previous = latest_record(&path);
    let mut previous_exit = previous.as_ref().and_then(|record| record.current.exit);
    let now = now_ms();
    let current = Session {
      launch_id: launch_id.clone(),
      release,
      started_at: now,
      alive_at: now,
      exit: None,
      renderer_epoch: 0,
      heartbeat_revision: 0,
      boot_id,
      context: RuntimeContext::default(),
    };
    let mut finished: Vec<String> = Vec::new();
    let mut record = match previous {
      Some(mut old) => {
        if old.current.launch_id != launch_id {
          if old.current.exit.is_none() {
            // An update ends the process without a mark when the app that ran it had no before-exit hook (every app built
            // before it) or the installer did not wait for it: only an update changes the release between two launches, so
            // the first start of another release after an unmarked end is that update, not a crash (UJ-001).
            if old.current.release != current.release {
              previous_exit = Some(CleanExit::UpdateRestart);
              finished.push(old.current.launch_id.clone());
            } else {
              append_failure(&mut old, FailureKind::UncleanExit);
            }
          } else {
            finished.push(old.current.launch_id.clone());
          }
          old.current = current;
        }
        old
      }
      None => Record {
        current,
        failures: Vec::new(),
        sequence: 0,
        revision: 0,
      },
    };
    if record.failures.len() > MAX_FAILURES {
      record
        .failures
        .drain(..record.failures.len() - MAX_FAILURES);
    }
    let health = Self {
      path,
      state: Mutex::new(HealthState {
        record,
        previous_exit,
        storage_ok: false,
      }),
    };
    health.forget_marks(&finished);
    health.sweep_old_marks(&health.lock().record);
    health.persist(&mut health.lock());
    health
  }

  /// Removes the marks of launches that are known to be over and have nothing waiting on them: one that ended with a mark of its
  /// own, one an update ended, one whose unexpected exit has been dealt with. A mark of a launch this record does not know is not
  /// removed here: another copy of the app may be running, and it is that copy's.
  fn forget_marks(&self, launch_ids: &[String]) {
    let Some(parent) = self.path.parent() else { return };
    for launch_id in launch_ids {
      let _ = std::fs::remove_file(parent.join(crate::os_exit_cause::unix_end::marker_file_name(launch_id)));
    }
  }

  /// Removes marks nobody has touched for a year and nothing refers to (a launch whose record was lost): the only case a mark of an
  /// unknown launch is removed, so what another running copy holds is safe for as long as a copy runs.
  fn sweep_old_marks(&self, record: &Record) {
    let Some(parent) = self.path.parent() else { return };
    let keep: Vec<String> = std::iter::once(&record.current.launch_id)
      .chain(record.failures.iter().map(|failure| &failure.session.launch_id))
      .map(|launch_id| crate::os_exit_cause::unix_end::marker_file_name(launch_id))
      .collect();
    let Ok(entries) = std::fs::read_dir(parent) else { return };
    for entry in entries.flatten() {
      let name = entry.file_name();
      let Some(name) = name.to_str() else { continue };
      if !(name.starts_with("exit-") && name.ends_with(".mark")) || keep.iter().any(|kept| kept == name) {
        continue;
      }
      let age = entry.metadata().and_then(|meta| meta.modified()).ok().and_then(|at| SystemTime::now().duration_since(at).ok());
      if age.is_some_and(|age| age > STALE_MARK) {
        let _ = std::fs::remove_file(entry.path());
      }
    }
  }

  fn lock(&self) -> MutexGuard<'_, HealthState> {
    self
      .state
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner())
  }

  fn persist(&self, state: &mut HealthState) {
    match self.save(&mut state.record) {
      Ok(()) => state.storage_ok = true,
      Err(error) => {
        state.storage_ok = false;
        log::warn!(
          "runtime-health: could not persist the health marker (kind {:?}, os {:?})",
          error.kind(),
          error.raw_os_error()
        );
      }
    }
  }

  fn save(&self, record: &mut Record) -> std::io::Result<()> {
    let parent = self
      .path
      .parent()
      .ok_or_else(|| std::io::Error::other("missing marker directory"))?;
    std::fs::create_dir_all(parent)?;
    record.revision = record
      .revision
      .checked_add(1)
      .ok_or_else(|| std::io::Error::other("health record revision exhausted"))?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(&mut staged, &*record).map_err(std::io::Error::other)?;
    staged.as_file().sync_all()?;
    let checkpoint = parent.join(format!(
      "{RECOVERY_PREFIX}{:020}-{}.json",
      record.revision,
      staged
        .path()
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
    ));
    let primary_written = match staged.persist(&self.path) {
      Ok(_) => true,
      Err(error) => {
        error
          .file
          .persist_noclobber(checkpoint)
          .map_err(|failure| failure.error)?;
        false
      }
    };
    self.prune_recovery(record.revision, primary_written);
    Ok(())
  }

  fn prune_recovery(&self, revision: u64, primary_written: bool) {
    let mut checkpoints: Vec<_> = recovery_paths(&self.path)
      .into_iter()
      .filter_map(|path| read_record(&path).map(|record| (record.revision, path)))
      .filter(|(saved, _)| *saved <= revision)
      .collect();
    checkpoints.sort_by(|left, right| right.0.cmp(&left.0));
    let keep = if primary_written {
      0
    } else {
      MAX_RECOVERY_RECORDS
    };
    for (_, path) in checkpoints.into_iter().skip(keep) {
      let _ = std::fs::remove_file(path);
    }
  }

  fn matches(state: &HealthState, token: &RendererToken) -> bool {
    token.renderer_epoch != 0
      && token.launch_id == state.record.current.launch_id
      && token.renderer_epoch == state.record.current.renderer_epoch
  }

  fn snapshot(state: &HealthState) -> RuntimeStatus {
    RuntimeStatus {
      token: RendererToken {
        launch_id: state.record.current.launch_id.clone(),
        renderer_epoch: state.record.current.renderer_epoch,
      },
      previous_exit: state.previous_exit,
      failures: state.record.failures.clone(),
      storage_ok: state.storage_ok,
    }
  }

  pub fn bind_renderer(&self) -> RuntimeStatus {
    let mut state = self.lock();
    if state.record.current.exit.is_none() {
      state.record.current.renderer_epoch = state.record.current.renderer_epoch.saturating_add(1);
      state.record.current.heartbeat_revision = 0;
      self.persist(&mut state);
    }
    Self::snapshot(&state)
  }

  pub fn heartbeat(
    &self,
    token: &RendererToken,
    revision: u64,
    mut context: RuntimeContext,
  ) -> bool {
    let mut state = self.lock();
    if !Self::matches(&state, token)
      || state.record.current.exit.is_some()
      || revision <= state.record.current.heartbeat_revision
    {
      return false;
    }
    context.project_id = context.project_id.chars().take(200).collect();
    context.user_id = context.user_id.chars().take(200).collect();
    context.activity = context.activity.chars().take(100).collect();
    for failure in &mut state.record.failures {
      let previous_user = &failure.session.context.user_id;
      if !reportable(&context)
        || (!context.user_id.is_empty()
          && !previous_user.is_empty()
          && *previous_user != context.user_id)
      {
        failure.eligible = false;
      }
    }
    state.record.current.context = context;
    state.record.current.alive_at = now_ms();
    state.record.current.heartbeat_revision = revision;
    self.persist(&mut state);
    state.storage_ok
  }

  pub fn mark_exit(&self, exit: CleanExit) {
    let mut state = self.lock();
    if state.record.current.exit != Some(CleanExit::UpdateRestart) {
      state.record.current.exit = Some(exit);
    }
    self.persist(&mut state);
  }

  pub fn record_failure(&self, kind: FailureKind) {
    let mut state = self.lock();
    append_failure(&mut state.record, kind);
    self.persist(&mut state);
  }

  fn record_panic(&self) {
    let mut state = match self.state.try_lock() {
      Ok(state) => state,
      Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
      Err(TryLockError::WouldBlock) => return,
    };
    append_failure(&mut state.record, FailureKind::RustPanic);
    self.persist(&mut state);
  }

  #[cfg(test)]
  pub fn status(&self) -> RuntimeStatus {
    let state = self.lock();
    Self::snapshot(&state)
  }

  pub fn renderer_status(&self, token: &RendererToken) -> Option<RuntimeStatus> {
    let state = self.lock();
    Self::matches(&state, token).then(|| Self::snapshot(&state))
  }

  /// What the cause lookup is told about the session that ended in one unexpected exit: when it was last seen alive, which launch
  /// it was (the name of the mark a signal may have left), which start of the PC it ran in and when a panic was recorded in it.
  /// Answered only to the page that holds the current token, and only for a recorded `UncleanExit` that has not been
  /// acknowledged yet: no other failure, id or page gets an answer.
  pub fn unexpected_exit_session(
    &self,
    token: &RendererToken,
    id: &str,
  ) -> Option<crate::os_exit_cause::EndSession> {
    let state = self.lock();
    if !Self::matches(&state, token) {
      return None;
    }
    let failures = &state.record.failures;
    let ended = failures
      .iter()
      .find(|failure| failure.id == id && failure.kind == FailureKind::UncleanExit)?;
    let launch_id = ended.session.launch_id.clone();
    let panic_at = failures
      .iter()
      .filter(|failure| failure.kind == FailureKind::RustPanic && failure.session.launch_id == launch_id)
      .map(|failure| failure.at)
      .max();
    Some(crate::os_exit_cause::EndSession {
      started_at: ended.session.started_at,
      alive_at: ended.session.alive_at,
      detected_at: ended.at,
      launch_id,
      boot_id: ended.session.boot_id.clone(),
      panic_at,
      dir: self.path.parent().map(Path::to_path_buf).unwrap_or_default(),
    })
  }

  #[cfg(test)]
  pub fn unexpected_exit_alive_at(&self, token: &RendererToken, id: &str) -> Option<u64> {
    self.unexpected_exit_session(token, id).map(|session| session.alive_at)
  }

  pub fn acknowledge(&self, token: &RendererToken, ids: &[String]) -> bool {
    let mut state = self.lock();
    if !Self::matches(&state, token) {
      return false;
    }
    let mut next = state.record.clone();
    next.failures.retain(|failure| !ids.contains(&failure.id));
    if next.failures.len() == state.record.failures.len() {
      return false;
    }
    if self.save(&mut next).is_err() {
      state.storage_ok = false;
      return false;
    }
    // The launches whose last waiting failure this was: nothing will ask for their mark again.
    let settled: Vec<String> = state
      .record
      .failures
      .iter()
      .filter(|failure| ids.contains(&failure.id))
      .map(|failure| failure.session.launch_id.clone())
      .filter(|launch_id| {
        *launch_id != next.current.launch_id && !next.failures.iter().any(|failure| failure.session.launch_id == *launch_id)
      })
      .collect();
    state.record = next;
    state.storage_ok = true;
    self.forget_marks(&settled);
    true
  }
}

pub fn install_panic_hook(health: Arc<RuntimeHealth>) {
  let previous = std::panic::take_hook();
  std::panic::set_hook(Box::new(move |info| {
    health.record_panic();
    previous(info);
  }));
}

pub fn initialize<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
  use tauri::Manager;
  let Some(jobs) = app.try_state::<crate::jobs::Supervisor>() else {
    log::warn!("runtime-health: the process launch identity is unavailable");
    return;
  };
  let Ok(root) = app.path().app_local_data_dir() else {
    log::warn!("runtime-health: the app data directory is unavailable");
    return;
  };
  let health = Arc::new(RuntimeHealth::open(
    root.join("observability").join("health.json"),
    jobs.launch_id(),
    format!("artdaddy@{}", app.package_info().version),
  ));
  install_panic_hook(health.clone());
  // The mark a signal leaves when it ends the app (macOS and Linux; Windows has an event log to ask). Without it the next start
  // still reports the end, with less to say about it.
  #[cfg(unix)]
  if let Err(error) = crate::exit_signal::install(&root.join("observability"), &jobs.launch_id()) {
    log::warn!("runtime-health: could not open the exit mark (kind {:?}, os {:?})", error.kind(), error.raw_os_error());
  }
  app.manage(health);
}

pub fn observe_failure<R: tauri::Runtime>(app: &tauri::AppHandle<R>, kind: FailureKind) {
  use tauri::Manager;
  if let Some(health) = app.try_state::<Arc<RuntimeHealth>>() {
    health.record_failure(kind);
  } else {
    log::warn!("runtime-health: could not record a native failure");
  }
}

pub fn mark_exit<R: tauri::Runtime>(app: &tauri::AppHandle<R>, exit: CleanExit) {
  use tauri::Manager;
  if let Some(health) = app.try_state::<Arc<RuntimeHealth>>() {
    health.mark_exit(exit);
  }
}

pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
  tauri::plugin::Builder::new("runtime-health")
    .on_event(|app, event| {
      if let tauri::RunEvent::Exit = event {
        mark_exit(app, CleanExit::Quit);
      }
    })
    .build()
}

#[tauri::command]
pub fn runtime_health_begin(health: tauri::State<'_, Arc<RuntimeHealth>>) -> RuntimeStatus {
  health.bind_renderer()
}

#[tauri::command]
pub fn runtime_health_status(
  health: tauri::State<'_, Arc<RuntimeHealth>>,
  token: RendererToken,
) -> Option<RuntimeStatus> {
  health.renderer_status(&token)
}

#[tauri::command]
pub fn runtime_health_update(
  health: tauri::State<'_, Arc<RuntimeHealth>>,
  token: RendererToken,
  revision: u64,
  context: RuntimeContext,
) -> bool {
  health.heartbeat(&token, revision, context)
}

#[tauri::command]
pub fn runtime_health_ack(
  health: tauri::State<'_, Arc<RuntimeHealth>>,
  token: RendererToken,
  ids: Vec<String>,
) -> bool {
  health.acknowledge(&token, &ids)
}

/// What ended the session that an unexpected exit belongs to, as one short word (`os_exit_cause.rs`): from the operating system's
/// own log where it keeps one (Windows), and from the mark a signal left, a panic, the PC's start and the system's crash report
/// where it does not. Reads off the page's thread, and the page does not wait for it for long.
#[tauri::command]
pub async fn runtime_health_cause(
  health: tauri::State<'_, Arc<RuntimeHealth>>,
  token: RendererToken,
  id: String,
) -> Result<Option<String>, String> {
  let Some(session) = health.unexpected_exit_session(&token, &id) else {
    return Ok(None);
  };
  let exe = std::env::current_exe()
    .ok()
    .and_then(|path| path.file_name().map(|name| name.to_string_lossy().into_owned()))
    .unwrap_or_else(|| "artdaddy.exe".to_string());
  Ok(
    tauri::async_runtime::spawn_blocking(move || crate::os_exit_cause::lookup_session(&session, &exe))
      .await
      .ok(),
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn recovery_uses_the_newest_committed_record_not_a_stale_primary_or_partial_file() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let health = RuntimeHealth::open(path.clone(), "first".into(), "test".into());
    let original = std::fs::read(&path).unwrap();
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    health.record_failure(FailureKind::RustPanic);
    health.mark_exit(CleanExit::UpdateRestart);
    std::fs::write(
      directory.path().join("health-recovery-partial.json"),
      "{\"revision\":999999,",
    )
    .unwrap();
    std::fs::remove_dir(&path).unwrap();
    std::fs::write(&path, original).unwrap();
    drop(health);
    let next = RuntimeHealth::open(path.clone(), "next".into(), "test".into());
    assert_eq!(next.status().previous_exit, Some(CleanExit::UpdateRestart));
    assert_eq!(next.status().failures.len(), 1);
    assert_eq!(next.status().failures[0].kind, FailureKind::RustPanic);
    let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["failures"][0]["kind"], "rust_panic");
    assert_eq!(saved["current"]["launch_id"], "next");
  }

  #[test]
  fn repeated_blocked_writes_keep_a_bounded_recovery_set_and_compact_after_recovery() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let health = RuntimeHealth::open(path.clone(), "first".into(), "test".into());
    let token = health.bind_renderer().token;
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    for revision in 1..=20 {
      assert!(health.heartbeat(
        &token,
        revision,
        RuntimeContext {
          activity: format!("activity-{revision}"),
          user_id: "account_a".into(),
          auth_state: RuntimeAuth::Unlocked,
          has_stored_session: true,
          ..Default::default()
        }
      ));
      assert!(recovery_paths(&path).len() <= MAX_RECOVERY_RECORDS);
    }
    health.record_failure(FailureKind::RendererExited);
    health.mark_exit(CleanExit::Quit);
    drop(health);
    std::fs::remove_dir(&path).unwrap();
    let next = RuntimeHealth::open(path.clone(), "next".into(), "test".into());
    assert_eq!(next.status().previous_exit, Some(CleanExit::Quit));
    assert_eq!(next.status().failures.len(), 1);
    assert_eq!(
      next.status().failures[0].session.context.activity,
      "activity-20"
    );
    assert!(recovery_paths(&path).is_empty());
  }

  #[test]
  fn an_existing_health_record_without_a_revision_keeps_its_exit_and_pending_failures() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let health = RuntimeHealth::open(path.clone(), "first".into(), "test".into());
    health.record_failure(FailureKind::WebContentTerminated);
    health.mark_exit(CleanExit::Quit);
    drop(health);
    let mut old: serde_json::Value =
      serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    old.as_object_mut().unwrap().remove("revision");
    std::fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
    let next = RuntimeHealth::open(path, "next".into(), "test".into());
    assert_eq!(next.status().previous_exit, Some(CleanExit::Quit));
    assert_eq!(next.status().failures.len(), 1);
    assert_eq!(
      next.status().failures[0].kind,
      FailureKind::WebContentTerminated
    );
  }

  #[cfg(windows)]
  #[test]
  fn a_locked_primary_does_not_block_a_stored_acknowledgement_or_clean_exit() {
    use std::os::windows::fs::OpenOptionsExt;

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let health = RuntimeHealth::open(path.clone(), "first".into(), "test".into());
    let token = health.bind_renderer().token;
    health.record_failure(FailureKind::RendererExited);
    let failure = health.status().failures[0].id.clone();
    let before = std::fs::read(&path).unwrap();
    let reader = std::fs::OpenOptions::new()
      .read(true)
      .share_mode(1)
      .open(&path)
      .unwrap();
    assert!(health.acknowledge(&token, &[failure]));
    assert!(health.status().failures.is_empty());
    health.mark_exit(CleanExit::Quit);
    assert_eq!(std::fs::read(&path).unwrap(), before);
    drop(health);
    let next = RuntimeHealth::open(path.clone(), "next".into(), "test".into());
    assert_eq!(next.status().previous_exit, Some(CleanExit::Quit));
    assert!(next.status().failures.is_empty());
    drop(reader);
    next.bind_renderer();
    let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert!(saved["failures"].as_array().unwrap().is_empty());
    assert_eq!(saved["current"]["launch_id"], "next");
  }

  #[test]
  fn a_native_clean_exit_survives_a_missing_webview_unload() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let first = RuntimeHealth::open(path.clone(), "first".into(), "test".into());
    first.mark_exit(CleanExit::Quit);
    drop(first);
    let next = RuntimeHealth::open(path, "next".into(), "test".into());
    let status = next.status();
    assert!(status.failures.is_empty());
    assert_eq!(status.previous_exit, Some(CleanExit::Quit));
  }

  #[test]
  fn a_clean_exit_does_not_erase_an_observed_renderer_failure() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let first = RuntimeHealth::open(path.clone(), "first".into(), "test".into());
    first.record_failure(FailureKind::RendererExited);
    first.mark_exit(CleanExit::Quit);
    drop(first);
    let next = RuntimeHealth::open(path, "next".into(), "test".into());
    let status = next.status();
    assert_eq!(status.failures.len(), 1);
    assert_eq!(status.failures[0].kind, FailureKind::RendererExited);
  }

  #[test]
  fn reading_the_status_does_not_consume_an_undelivered_failure() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let health = RuntimeHealth::open(path.clone(), "first".into(), "test".into());
    health.record_failure(FailureKind::RendererExited);
    let before = std::fs::read(&path).unwrap();
    let first = health.status();
    let second = health.status();
    assert_eq!(first.failures.len(), 1);
    assert_eq!(second.failures.len(), 1);
    assert_eq!(first.failures[0].id, second.failures[0].id);
    assert_eq!(std::fs::read(path).unwrap(), before);
  }

  #[test]
  fn a_superseded_page_cannot_update_context_or_acknowledge_failures() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let health = RuntimeHealth::open(path.clone(), "first".into(), "test".into());
    let old = health.bind_renderer().token;
    assert!(health.heartbeat(
      &old,
      1,
      RuntimeContext {
        project_id: "old_project".into(),
        ..Default::default()
      }
    ));
    health.record_failure(FailureKind::RendererExited);
    let failure = health.status().failures[0].id.clone();
    let current = health.bind_renderer().token;
    assert!(health.heartbeat(
      &current,
      1,
      RuntimeContext {
        project_id: "current_project".into(),
        ..Default::default()
      }
    ));
    assert!(!health.heartbeat(
      &old,
      99,
      RuntimeContext {
        project_id: "stale_project".into(),
        ..Default::default()
      }
    ));
    assert!(!health.acknowledge(&old, &[failure]));
    let before = std::fs::read(&path).unwrap();
    assert!(health.renderer_status(&old).is_none());
    assert!(health.renderer_status(&current).is_some());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(health.status().failures.len(), 1);
    health.record_failure(FailureKind::RustPanic);
    let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(saved["current"]["context"]["project_id"], "current_project");
    assert_eq!(
      saved["failures"][1]["session"]["context"]["project_id"],
      "current_project"
    );
  }

  #[test]
  fn signing_out_permanently_disqualifies_waiting_reports() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let health = RuntimeHealth::open(path.clone(), "first".into(), "test".into());
    let token = health.bind_renderer().token;
    health.heartbeat(
      &token,
      1,
      RuntimeContext {
        user_id: "account_a".into(),
        auth_state: RuntimeAuth::Unlocked,
        has_stored_session: true,
        ..Default::default()
      },
    );
    health.record_failure(FailureKind::RendererExited);
    assert!(health.status().failures[0].eligible);
    health.heartbeat(
      &token,
      2,
      RuntimeContext {
        auth_state: RuntimeAuth::Locked,
        ..Default::default()
      },
    );
    health.record_failure(FailureKind::RustPanic);
    health.heartbeat(
      &token,
      3,
      RuntimeContext {
        user_id: "account_a".into(),
        auth_state: RuntimeAuth::Unlocked,
        has_stored_session: true,
        ..Default::default()
      },
    );
    assert!(health
      .status()
      .failures
      .iter()
      .all(|failure| !failure.eligible));
    let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert!(saved["failures"]
      .as_array()
      .unwrap()
      .iter()
      .all(|failure| failure["eligible"] == false));
  }

  #[test]
  fn a_different_account_does_not_receive_the_first_accounts_failure() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let health = RuntimeHealth::open(path, "first".into(), "test".into());
    let token = health.bind_renderer().token;
    health.heartbeat(
      &token,
      1,
      RuntimeContext {
        user_id: "account_a".into(),
        auth_state: RuntimeAuth::Unlocked,
        has_stored_session: true,
        ..Default::default()
      },
    );
    health.record_failure(FailureKind::RendererExited);
    health.heartbeat(
      &token,
      2,
      RuntimeContext {
        user_id: "account_b".into(),
        auth_state: RuntimeAuth::Unlocked,
        has_stored_session: true,
        ..Default::default()
      },
    );
    health.record_failure(FailureKind::WebContentTerminated);
    let failures = health.status().failures;
    assert!(!failures[0].eligible);
    assert!(failures[1].eligible);
    assert_eq!(failures[1].session.context.user_id, "account_b");
  }

  #[test]
  fn acknowledging_one_failure_keeps_a_sibling_and_failed_storage_keeps_both() {
    let directory = tempfile::tempdir().unwrap();
    let parent = directory.path().join("records");
    let path = parent.join("health.json");
    let health = RuntimeHealth::open(path.clone(), "first".into(), "test".into());
    let token = health.bind_renderer().token;
    health.record_failure(FailureKind::RendererExited);
    health.record_failure(FailureKind::WebContentTerminated);
    let first = health.status().failures[0].id.clone();
    let second = health.status().failures[1].id.clone();
    let parked = directory.path().join("parked");
    std::fs::rename(&parent, &parked).unwrap();
    std::fs::write(&parent, "blocks writes").unwrap();
    assert!(!health.acknowledge(&token, &[first.clone()]));
    assert_eq!(health.status().failures.len(), 2);
    std::fs::remove_file(&parent).unwrap();
    std::fs::rename(parked, &parent).unwrap();
    assert!(health.acknowledge(&token, &[first.clone()]));
    assert!(!health.acknowledge(&token, &[first]));
    let next = RuntimeHealth::open(path, "next".into(), "test".into());
    assert!(next
      .status()
      .failures
      .iter()
      .any(|failure| failure.id == second));
  }

  #[test]
  fn late_heartbeats_cannot_revive_a_clean_exit_or_overwrite_newer_context() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let health = RuntimeHealth::open(path.clone(), "first".into(), "test".into());
    let token = health.bind_renderer().token;
    assert!(health.heartbeat(
      &token,
      2,
      RuntimeContext {
        activity: "newer".into(),
        ..Default::default()
      }
    ));
    assert!(!health.heartbeat(
      &token,
      1,
      RuntimeContext {
        activity: "older".into(),
        ..Default::default()
      }
    ));
    health.mark_exit(CleanExit::UpdateRestart);
    health.mark_exit(CleanExit::Quit);
    assert!(!health.heartbeat(&token, 3, RuntimeContext::default()));
    let next = RuntimeHealth::open(path, "next".into(), "test".into());
    assert_eq!(next.status().previous_exit, Some(CleanExit::UpdateRestart));
    assert!(next.status().failures.is_empty());
  }

  #[test]
  fn every_native_failure_kind_survives_persistence_and_history_is_bounded() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let health = RuntimeHealth::open(path.clone(), "first".into(), "test".into());
    let kinds = [
      FailureKind::UncleanExit,
      FailureKind::RustPanic,
      FailureKind::RendererExited,
      FailureKind::RendererUnresponsive,
      FailureKind::WebContentTerminated,
    ];
    for kind in kinds {
      health.record_failure(kind);
    }
    health.mark_exit(CleanExit::Quit);
    let next = RuntimeHealth::open(path, "next".into(), "test".into());
    for kind in kinds {
      assert!(next
        .status()
        .failures
        .iter()
        .any(|failure| failure.kind == kind));
    }
    for _ in 0..20 {
      next.record_failure(FailureKind::RendererExited);
    }
    assert_eq!(next.status().failures.len(), MAX_FAILURES);
  }

  // UJ-001. An update that ends the process without a mark (every app built before the updater's before-exit hook, and
  // any installer that does not wait for the app) leaves a session with no exit. The first start of ANOTHER release after
  // such an end is the update, not a crash: only an update changes the release between two launches.
  #[test]
  fn an_unmarked_end_followed_by_another_release_is_an_update_restart_not_a_crash() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let first = RuntimeHealth::open(path.clone(), "first".into(), "artdaddy@0.23.0".into());
    drop(first); // the installer ended the process: no exit was marked
    let next = RuntimeHealth::open(path, "next".into(), "artdaddy@0.24.0".into());
    assert_eq!(next.status().previous_exit, Some(CleanExit::UpdateRestart));
    assert!(next.status().failures.is_empty(), "recorded as {:?}", next.status().failures);
  }

  #[test]
  fn an_unmarked_end_followed_by_the_same_release_is_still_a_crash() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let first = RuntimeHealth::open(path.clone(), "first".into(), "artdaddy@0.23.0".into());
    drop(first);
    let next = RuntimeHealth::open(path, "next".into(), "artdaddy@0.23.0".into());
    assert_eq!(next.status().previous_exit, None);
    assert_eq!(next.status().failures.len(), 1);
    assert_eq!(next.status().failures[0].kind, FailureKind::UncleanExit);
  }

  #[test]
  fn an_update_restart_keeps_a_failure_seen_before_it_and_adds_none() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let first = RuntimeHealth::open(path.clone(), "first".into(), "artdaddy@0.23.0".into());
    first.record_failure(FailureKind::RendererExited);
    drop(first);
    let next = RuntimeHealth::open(path, "next".into(), "artdaddy@0.24.0".into());
    let kinds: Vec<_> = next.status().failures.iter().map(|failure| failure.kind).collect();
    assert_eq!(kinds, vec![FailureKind::RendererExited]);
  }

  #[test]
  fn a_crash_after_an_update_is_still_recorded() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    drop(RuntimeHealth::open(path.clone(), "old".into(), "artdaddy@0.23.0".into()));
    let updated = RuntimeHealth::open(path.clone(), "new".into(), "artdaddy@0.24.0".into());
    assert!(updated.status().failures.is_empty());
    drop(updated); // the new release then dies without a mark: that one is a crash
    let after = RuntimeHealth::open(path, "later".into(), "artdaddy@0.24.0".into());
    assert_eq!(after.status().failures.len(), 1);
    assert_eq!(after.status().failures[0].kind, FailureKind::UncleanExit);
  }

  #[test]
  fn an_unexpected_exit_gives_up_when_it_was_last_alive_to_the_page_that_holds_the_token_and_to_nobody_else() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let first = RuntimeHealth::open(path.clone(), "first".into(), "artdaddy@0.23.0".into());
    let token = first.bind_renderer().token;
    assert!(first.heartbeat(&token, 1, RuntimeContext { activity: "idle".into(), ..Default::default() }));
    let last_alive = first.status().failures.len() as u64; // none yet: the failure is recorded by the next launch
    assert_eq!(last_alive, 0);
    drop(first); // no mark: an unexpected exit
    let next = RuntimeHealth::open(path, "next".into(), "artdaddy@0.23.0".into());
    let current = next.bind_renderer().token;
    let failure = next.status().failures[0].clone();
    assert_eq!(failure.kind, FailureKind::UncleanExit);
    let alive = next.unexpected_exit_alive_at(&current, &failure.id);
    assert!(alive.is_some_and(|at| at > 0), "{alive:?}");
    // Nobody else may ask: a page that was replaced, or a token that was never issued.
    let stale = RendererToken { launch_id: current.launch_id.clone(), renderer_epoch: current.renderer_epoch + 1 };
    assert_eq!(next.unexpected_exit_alive_at(&stale, &failure.id), None);
    let foreign = RendererToken { launch_id: "other".into(), renderer_epoch: current.renderer_epoch };
    assert_eq!(next.unexpected_exit_alive_at(&foreign, &failure.id), None);
    // Nothing else is asked about: not an id nobody recorded, and not a failure that is not an unexpected exit.
    assert_eq!(next.unexpected_exit_alive_at(&current, "no-such-failure"), None);
    next.record_failure(FailureKind::RendererExited);
    let other = next.status().failures.iter().find(|f| f.kind == FailureKind::RendererExited).unwrap().id.clone();
    assert_eq!(next.unexpected_exit_alive_at(&current, &other), None);
    // Once it was reported and acknowledged there is nothing left to ask about.
    assert!(next.acknowledge(&current, &[failure.id.clone()]));
    assert_eq!(next.unexpected_exit_alive_at(&current, &failure.id), None);
  }

  #[test]
  fn native_panic_child() {
    let Ok(path) = std::env::var("ARTDADDY_HEALTH_PANIC_TEST") else {
      return;
    };
    let health = std::sync::Arc::new(RuntimeHealth::open(
      path.into(),
      "panic-child".into(),
      "test".into(),
    ));
    install_panic_hook(health);
    panic!("PRIVATE_PANIC_PAYLOAD_CANARY");
  }

  #[test]
  fn native_panic_leaves_a_marker_without_the_panic_payload() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let child = std::process::Command::new(std::env::current_exe().unwrap())
      .args(["--exact", "runtime_health::tests::native_panic_child"])
      .env("ARTDADDY_HEALTH_PANIC_TEST", &path)
      .output()
      .unwrap();
    assert!(!child.status.success());
    let bytes = std::fs::read(&path).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("PRIVATE_PANIC_PAYLOAD_CANARY"));
    let next = RuntimeHealth::open(path, "next".into(), "test".into());
    assert!(next
      .status()
      .failures
      .iter()
      .any(|failure| failure.kind == FailureKind::RustPanic));
  }

  // What the cause lookup is told about a session that ended without a mark (macOS and Linux have no log to ask).

  fn ended_without_a_mark(
    directory: &Path,
    boot: &str,
  ) -> (PathBuf, RuntimeHealth, RendererToken, String) {
    let path = directory.join("health.json");
    let first = RuntimeHealth::open_in_boot(path.clone(), "first".into(), "artdaddy@0.24.0".into(), boot.into());
    let token = first.bind_renderer().token;
    assert!(first.heartbeat(&token, 1, RuntimeContext { activity: "export".into(), ..Default::default() }));
    drop(first); // no exit mark
    let next = RuntimeHealth::open_in_boot(path.clone(), "next".into(), "artdaddy@0.24.0".into(), "boot-b".into());
    let id = next.status().failures[0].id.clone();
    let token = next.bind_renderer().token;
    (path, next, token, id)
  }

  #[test]
  fn an_unmarked_end_hands_over_the_launch_the_start_of_the_pc_and_when_it_was_last_alive() {
    let directory = tempfile::tempdir().unwrap();
    let (_, next, token, id) = ended_without_a_mark(directory.path(), "boot-a");
    let session = next.unexpected_exit_session(&token, &id).unwrap();
    assert_eq!(session.launch_id, "first");
    assert_eq!(session.boot_id, "boot-a");
    assert_eq!(session.panic_at, None);
    assert_eq!(session.dir, directory.path());
    // The span the session lived in, which is all a crash report of it can be looked for inside.
    assert!(session.started_at > 0 && session.started_at <= session.alive_at, "{session:?}");
    let noticed = next.status().failures.iter().find(|failure| failure.id == id).unwrap().at;
    assert_eq!(session.detected_at, noticed);
    assert!(session.detected_at >= session.alive_at, "{session:?}");
  }

  #[test]
  fn only_the_page_that_holds_the_token_is_told_and_only_of_an_unexpected_exit() {
    let directory = tempfile::tempdir().unwrap();
    let (_, next, token, id) = ended_without_a_mark(directory.path(), "boot-a");
    let stale = RendererToken { launch_id: token.launch_id.clone(), renderer_epoch: token.renderer_epoch + 1 };
    assert!(next.unexpected_exit_session(&stale, &id).is_none());
    assert!(next.unexpected_exit_session(&token, "no-such-failure").is_none());
    next.record_failure(FailureKind::RendererExited);
    let other = next.status().failures.iter().find(|f| f.kind == FailureKind::RendererExited).unwrap().id.clone();
    assert!(next.unexpected_exit_session(&token, &other).is_none());
    assert!(next.acknowledge(&token, &[id.clone()]));
    assert!(next.unexpected_exit_session(&token, &id).is_none());
  }

  #[test]
  fn a_panic_in_the_session_that_ended_is_handed_over_with_its_time() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let first = RuntimeHealth::open_in_boot(path.clone(), "first".into(), "artdaddy@0.24.0".into(), "boot-a".into());
    first.record_failure(FailureKind::RustPanic);
    let panicked_at = first.status().failures.last().unwrap().at;
    drop(first); // then it ended without a mark
    let next = RuntimeHealth::open_in_boot(path, "next".into(), "artdaddy@0.24.0".into(), "boot-a".into());
    let id = next
      .status()
      .failures
      .iter()
      .find(|failure| failure.kind == FailureKind::UncleanExit)
      .unwrap()
      .id
      .clone();
    let token = next.bind_renderer().token;
    let session = next.unexpected_exit_session(&token, &id).unwrap();
    assert_eq!(session.panic_at, Some(panicked_at));
  }

  #[test]
  fn a_panic_of_another_launch_is_not_the_panic_of_the_session_that_ended() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let old = RuntimeHealth::open_in_boot(path.clone(), "older".into(), "artdaddy@0.24.0".into(), "boot-a".into());
    old.record_failure(FailureKind::RustPanic); // an earlier launch's panic, still waiting to be reported
    old.mark_exit(CleanExit::Quit);
    drop(old);
    let first = RuntimeHealth::open_in_boot(path.clone(), "first".into(), "artdaddy@0.24.0".into(), "boot-a".into());
    drop(first); // this one ended without a mark and without a panic of its own
    let next = RuntimeHealth::open_in_boot(path, "next".into(), "artdaddy@0.24.0".into(), "boot-a".into());
    let id = next
      .status()
      .failures
      .iter()
      .find(|failure| failure.kind == FailureKind::UncleanExit)
      .unwrap()
      .id
      .clone();
    let token = next.bind_renderer().token;
    assert_eq!(next.unexpected_exit_session(&token, &id).unwrap().panic_at, None);
  }

  #[test]
  fn a_record_written_before_the_start_of_the_pc_was_kept_still_reads() {
    let directory = tempfile::tempdir().unwrap();
    let (path, next, _, _) = ended_without_a_mark(directory.path(), "boot-a");
    drop(next);
    let mut record: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    record["current"].as_object_mut().unwrap().remove("boot_id");
    for failure in record["failures"].as_array_mut().unwrap() {
      failure["session"].as_object_mut().unwrap().remove("boot_id");
    }
    std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    let again = RuntimeHealth::open_in_boot(path, "again".into(), "artdaddy@0.24.0".into(), "boot-c".into());
    let kinds: Vec<_> = again.status().failures.iter().map(|failure| failure.kind).collect();
    assert!(kinds.contains(&FailureKind::UncleanExit), "{kinds:?}");
    let token = again.bind_renderer().token;
    let id = again.status().failures[0].id.clone();
    assert_eq!(again.unexpected_exit_session(&token, &id).unwrap().boot_id, "");
  }

  fn marks_in(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(directory)
      .unwrap()
      .flatten()
      .map(|entry| entry.file_name().to_string_lossy().into_owned())
      .filter(|name| name.starts_with("exit-") && name.ends_with(".mark"))
      .collect();
    names.sort();
    names
  }

  #[test]
  fn a_mark_is_removed_only_when_its_launch_is_known_to_be_over_and_nothing_waits_on_it() {
    use crate::os_exit_cause::unix_end::marker_file_name;
    let directory = tempfile::tempdir().unwrap();
    let put = |launch: &str| std::fs::write(directory.path().join(marker_file_name(launch)), b"signal_term\n").unwrap();
    let open = |path: &Path, launch: &str, release: &str| {
      RuntimeHealth::open_in_boot(path.to_path_buf(), launch.into(), release.into(), "boot-a".into())
    };
    let path = directory.path().join("health.json");
    // Another copy of the app may be running beside this one: a mark of a launch this record does not know is not ours to remove.
    put("stranger");
    // A mark is made by a launch after it has started, so each is put down after its own `open`.
    let clean = open(&path, "clean", "artdaddy@0.24.0");
    put("clean");
    clean.mark_exit(CleanExit::Quit);
    drop(clean);
    let crashed = open(&path, "crashed", "artdaddy@0.24.0");
    put("crashed");
    drop(crashed);
    let next = open(&path, "next", "artdaddy@0.24.0");
    put("next");
    // Files that only look like marks are not marks: nothing but `exit-<launch>.mark` is ever removed.
    std::fs::write(directory.path().join("exit-notes.txt"), b"keep").unwrap();
    std::fs::write(directory.path().join("notes.mark"), b"keep").unwrap();
    // The launch that ended with a mark of its own is over, and its mark goes; the one that ended without one keeps its mark until
    // its unexpected exit is dealt with.
    assert_eq!(marks_in(directory.path()), vec![marker_file_name("crashed"), marker_file_name("next"), marker_file_name("stranger")]);
    let token = next.bind_renderer().token;
    let id = next.status().failures[0].id.clone();
    assert!(next.acknowledge(&token, &[id]));
    assert_eq!(marks_in(directory.path()), vec![marker_file_name("next"), marker_file_name("stranger")]);
    // Nothing but marks is ever removed.
    assert!(directory.path().join("health.json").exists());
    assert!(directory.path().join("exit-notes.txt").exists() && directory.path().join("notes.mark").exists());
  }

  #[test]
  fn a_mark_nobody_has_touched_for_a_year_and_nothing_refers_to_is_swept_and_a_newer_one_is_not() {
    use crate::os_exit_cause::unix_end::marker_file_name;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let age = |launch: &str, days: u64| {
      let file = directory.path().join(marker_file_name(launch));
      std::fs::write(&file, b"").unwrap();
      let at = std::time::SystemTime::now() - std::time::Duration::from_secs(days * 86_400);
      std::fs::File::options().write(true).open(file).unwrap().set_modified(at).unwrap();
    };
    age("ancient", 400);
    age("last-spring", 300);
    let health = RuntimeHealth::open_in_boot(path, "now".into(), "artdaddy@0.24.0".into(), "boot-a".into());
    drop(health);
    assert_eq!(marks_in(directory.path()), vec![marker_file_name("last-spring")]);
  }

  #[test]
  fn the_mark_of_a_launch_an_update_ended_is_removed_too() {
    use crate::os_exit_cause::unix_end::marker_file_name;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("health.json");
    let old = RuntimeHealth::open_in_boot(path.clone(), "old".into(), "artdaddy@0.23.0".into(), "boot-a".into());
    std::fs::write(directory.path().join(marker_file_name("old")), b"signal_term\n").unwrap();
    drop(old); // the installer ended it: no exit mark, and a different release starts next
    let updated = RuntimeHealth::open_in_boot(path, "new".into(), "artdaddy@0.24.0".into(), "boot-a".into());
    assert!(updated.status().failures.is_empty());
    assert!(marks_in(directory.path()).is_empty());
  }
}
