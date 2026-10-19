// The app's long jobs, owned by the app process instead of the page (3h part 7, UJ-022; 4i).
//
// The page builds an export's ffmpeg command and, once it has ended, commits the file it wrote:
// it checks it, renames it into place and updates the project. In between, the PROCESS and the
// ORDER exports run in belong here, so a crash of the page neither kills a render nor loses its
// result: the next page lists the jobs, commits the ones that ended while no page was there and
// follows the ones still running. Whisper runs here the same way (4i): a crash of the page leaves
// the transcription running, and the next page keeps its words. Rust never writes project files.
// It runs the bundled ffmpeg and whisper-cli, one job per lane at a time, keeps each job's exit
// code and the tail of its output until a page has committed it, and kills jobs on Cancel and when
// the app exits.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use std::path::{Path, PathBuf};
use std::io::{Read, Write};
use sha2::{Digest, Sha256};

mod stream;
mod budget;
mod workspace;
mod resources;
mod allocation;
pub use workspace::Workspace;

/// The programs a job may run, as (logical name, bundled sidecar file). A command the page can
/// call must not become a way to start any process: only the sidecars the long jobs need.
pub const SIDECARS: &[(&str, &str)] =
  &[("ffmpeg", "artdaddy-ffmpeg"), ("whisper-cli", "artdaddy-whisper-cli")];

/// Bytes of each output stream kept per job: ffmpeg's last error lines and the last progress
/// block, bounded so a chatty process cannot grow memory.
pub const TAIL_BYTES: usize = 64 * 1024;
/// ...and the first bytes of stderr, where ffmpeg names the cause of a failure before its
/// per-stream noise (the page's `stderrExcerpt` keeps both ends for the same reason).
pub const HEAD_BYTES: usize = 16 * 1024;

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct JobSpec {
  pub id: String,
  pub lane: String,
  /// A logical name from `SIDECARS`.
  pub program: String,
  pub args: Vec<String>,
  #[serde(default)]
  pub steps: Vec<Vec<String>>,
  #[serde(default)]
  pub cwd: Option<String>,
  /// Whatever the page needs to commit the job later, from a page that did not start it.
  #[serde(default)]
  pub meta: serde_json::Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
  Queued,
  Running,
  Exited,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct JobView {
  pub id: String,
  pub lane: String,
  pub state: JobState,
  pub step: usize,
  /// The exit code; None while it runs, and for a job that never started or died by signal.
  pub code: Option<i32>,
  /// Ended by Cancel (or by the app exiting), whatever its exit code says.
  pub killed: bool,
  /// A page has committed its file; only the project follow-ups may still be outstanding.
  pub committed: bool,
  pub meta: serde_json::Value,
  pub stdout_tail: String,
  pub stderr_head: String,
  /// Bytes of stderr dropped between the head and the tail.
  pub stderr_elided: u64,
  pub stderr_tail: String,
  pub queued_at: u64,
  pub started_at: Option<u64>,
  pub ended_at: Option<u64>,
}

pub enum ProcEvent {
  Stdout(String),
  Stderr(String),
  Exit(Option<i32>),
}

/// Starts and kills processes. The supervisor's rules are tested against a fake; the app's
/// spawner is the shell plugin's sidecar.
pub trait Spawner: Send + Sync {
  fn identity(&self, program: &str) -> Result<ArtifactIdentity, String>;
  fn dependency_identity(&self, path: &Path, check: &dyn Fn() -> Result<(), String>) -> Result<ArtifactIdentity, String> {
    artifact_identity_checked(path, check)
  }
  /// Start the job's process and return its pid. Output and the exit arrive through `on_event`,
  /// from any thread, possibly before this returns.
  fn spawn(&self, spec: &JobSpec, on_event: Arc<dyn Fn(ProcEvent) + Send + Sync>, workspace: Arc<Workspace>)
    -> Result<u32, String>;
  fn spawn_stream(&self, _spec: &JobSpec, _on_event: Arc<dyn Fn(ProcEvent) + Send + Sync>,
    _guard: Arc<dyn Fn() -> Result<(), String> + Send + Sync>, _workspace: Arc<Workspace>) -> Result<u32, String> {
    Err("streaming export transport is unavailable".into())
  }
  /// Stop the process owned by this logical job, or every member of its streaming group.
  fn kill(&self, id: &str, pid: u32);
}

pub enum Notice {
  Changed(JobView),
  Stdout { id: String, chunk: String },
}

struct Job {
  spec: JobSpec,
  state: JobState,
  pid: Option<u32>,
  step: usize,
  code: Option<i32>,
  kill_requested: bool,
  committed: bool,
  stdout: String,
  stderr_head: String,
  stderr_elided: u64,
  stderr: String,
  queued_at: u64,
  started_at: Option<u64>,
  ended_at: Option<u64>,
}

impl Job {
  fn view(&self) -> JobView {
    JobView {
      id: self.spec.id.clone(),
      lane: self.spec.lane.clone(),
      state: self.state,
      step: self.step,
      code: self.code,
      killed: self.kill_requested,
      committed: self.committed,
      meta: self.spec.meta.clone(),
      stdout_tail: self.stdout.clone(),
      stderr_head: self.stderr_head.clone(),
      stderr_elided: self.stderr_elided,
      stderr_tail: self.stderr.clone(),
      queued_at: self.queued_at,
      started_at: self.started_at,
      ended_at: self.ended_at,
    }
  }
}

#[derive(Default)]
struct Lane {
  running: Option<String>,
  queue: VecDeque<String>,
}

#[derive(Default)]
struct State {
  jobs: HashMap<String, Job>,
  order: Vec<String>,
  lanes: HashMap<String, Lane>,
}

fn push_tail(buf: &mut String, chunk: &str) -> u64 {
  buf.push_str(chunk);
  if buf.len() <= TAIL_BYTES {
    return 0;
  }
  let mut cut = buf.len() - TAIL_BYTES;
  while !buf.is_char_boundary(cut) {
    cut += 1;
  }
  buf.drain(..cut);
  cut as u64
}

/// Fill the head first, then roll the tail.
fn push_stderr(job: &mut Job, chunk: &str) {
  let mut rest = chunk;
  if job.stderr_head.len() < HEAD_BYTES {
    let mut take = (HEAD_BYTES - job.stderr_head.len()).min(rest.len());
    while !rest.is_char_boundary(take) {
      take -= 1;
    }
    job.stderr_head.push_str(&rest[..take]);
    rest = &rest[take..];
  }
  if !rest.is_empty() {
    job.stderr_elided += push_tail(&mut job.stderr, rest);
  }
}

#[derive(Clone)]
pub struct Supervisor {
  state: Arc<Mutex<State>>,
  spawner: Arc<dyn Spawner>,
  notify: Arc<dyn Fn(Notice) + Send + Sync>,
  launch_id: Arc<str>,
  deliveries: Arc<Mutex<HashMap<String, ExportDelivery>>>,
  infrastructure: Arc<ExportInfrastructure>,
  export_root: Option<PathBuf>,
  export_work_root: Option<PathBuf>,
  export_font_root: Option<PathBuf>,
  workspace: Arc<Workspace>,
  copying: Arc<Mutex<HashSet<String>>>,
  copy_settled: Arc<Condvar>,
  #[cfg(test)]
  initial_entry_hook: Option<InitialEntryHook>,
}

fn canonical_export_path(path: &Path) -> Result<PathBuf, String> {
  if !path.is_absolute() { return Err("native filesystem ownership requires an absolute path".into()); }
  for ancestor in path.ancestors() {
    match ancestor.canonicalize() {
      Ok(mut resolved) => {
        for component in path.strip_prefix(ancestor).map_err(|error| error.to_string())?.components() {
          match component {
            std::path::Component::ParentDir => { resolved.pop(); }
            std::path::Component::CurDir => {}
            std::path::Component::Normal(name) => resolved.push(name),
            _ => return Err("native filesystem ownership has an invalid absolute suffix".into()),
          }
        }
        return Ok(resolved);
      }
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
      Err(error) => return Err(error.to_string()),
    }
  }
  Err("native filesystem ownership has no resolvable ancestor".into())
}

fn export_path_key(path: &Path) -> String {
  let value = path.to_string_lossy().trim_start_matches("\\\\?\\").replace('\\', "/");
  if cfg!(target_os = "windows") { value.to_lowercase() } else { value }
}

fn export_paths_overlap(left: &str, right: &str) -> bool {
  left == right || left.starts_with(&format!("{}/", right.trim_end_matches('/'))) ||
    right.starts_with(&format!("{}/", left.trim_end_matches('/')))
}

struct ExportNamespace {
  path: PathBuf,
  identity: Result<String, String>,
}

impl ExportNamespace {
  fn new(path: PathBuf) -> Self {
    let identity = canonical_export_path(&path).map(|path| export_path_key(&path));
    Self { path, identity }
  }

  fn key(&self) -> Result<&str, String> {
    let expected = self.identity.as_ref().map_err(Clone::clone)?;
    let actual = export_path_key(&canonical_export_path(&self.path)?);
    if actual != *expected { return Err("private export infrastructure namespace changed; restart is required".into()); }
    Ok(expected)
  }

  fn require_path(&self, path: &Path) -> Result<(), String> {
    if self.key()? != export_path_key(&canonical_export_path(path)?) {
      return Err("private export infrastructure cannot be reconfigured on an existing supervisor".into());
    }
    Ok(())
  }
}

#[derive(Default)]
struct ExportInfrastructure {
  journal: OnceLock<ExportNamespace>,
  scratch: OnceLock<ExportNamespace>,
}

#[derive(Clone, Copy)]
struct ExportJournal<'a> {
  infrastructure: &'a ExportInfrastructure,
  root: &'a Path,
  workspace: &'a Arc<Workspace>,
}

impl ExportInfrastructure {
  fn configure_journal(&self, path: PathBuf) -> Result<(), String> {
    self.journal.get_or_init(|| ExportNamespace::new(path.clone())).require_path(&path)?;
    self.validate_namespaces()
  }

  fn configure_scratch(&self, path: PathBuf) -> Result<(), String> {
    self.scratch.get_or_init(|| ExportNamespace::new(path.clone())).require_path(&path)?;
    if self.journal.get().is_some() { self.validate_namespaces()?; }
    Ok(())
  }

  fn validate_namespaces(&self) -> Result<(), String> {
    let journal = self.journal.get().ok_or("private export infrastructure is not configured; filesystem mutation refused")?.key()?;
    if let Some(scratch) = self.scratch.get() {
      if export_paths_overlap(journal, scratch.key()?) { return Err("private export infrastructure namespaces must not overlap".into()); }
    }
    Ok(())
  }

  fn journal<'a>(&'a self, workspace: &'a Arc<Workspace>) -> Result<ExportJournal<'a>, String> {
    self.validate_namespaces()?;
    Ok(ExportJournal { infrastructure: self, root: &self.journal.get().ok_or("private export journal is not configured")?.path, workspace })
  }

  fn scratch_arena(&self) -> Result<&Path, String> {
    self.validate_namespaces()?;
    Ok(&self.scratch.get().ok_or("native render work root is unavailable")?.path)
  }

  fn public_path(&self, path: &Path) -> Result<PathBuf, String> {
    self.validate_namespaces()?;
    let canonical = canonical_export_path(path)?;
    let target = export_path_key(&canonical);
    for namespace in self.journal.get().into_iter().chain(self.scratch.get()) {
      if export_paths_overlap(&target, namespace.key()?) {
        return Err("path overlaps private export infrastructure; public filesystem mutation refused".into());
      }
    }
    Ok(canonical)
  }

  fn owned_scratch(&self, delivery: &ExportDelivery) -> Result<PathBuf, String> {
    let scratch = delivery.render_scratch.as_ref().ok_or("native render directory has no admitted owner")?;
    let path = Path::new(&scratch.path);
    match std::fs::symlink_metadata(path) {
      Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() =>
        return Err("private export scratch must be an owned regular directory".into()),
      Ok(_) => {}
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
      Err(error) => return Err(error.to_string()),
    }
    let actual = canonical_export_path(path)?;
    let parent = actual.parent().ok_or("native render directory has no parent")?;
    if export_path_key(parent) != export_path_key(&canonical_export_path(self.scratch_arena()?)?) {
      return Err("render directory is outside its private export infrastructure arena".into());
    }
    if delivery.version == 3 {
      if scratch.request_sha256.len() != 64 || !scratch.request_sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("native render directory has no valid request identity".into());
      }
      let expected = format!("render-{}-{}", delivery.id, &scratch.request_sha256[..16]);
      if path.file_name().and_then(|name| name.to_str()) != Some(expected.as_str()) {
        return Err("native render directory does not match its admitted owner".into());
      }
    }
    Ok(actual)
  }

  fn validate_delivery(&self, delivery: &ExportDelivery) -> Result<(), String> {
    if !valid_delivery_id(&delivery.id) { return Err("invalid export intent identity".into()); }
    delivery.validate_initial_ownership()?;
    self.public_path(Path::new(&delivery.stage_path))?;
    self.public_path(Path::new(&delivery.dest_path))?;
    if let Some(path) = delivery.copy_scratch_path()? { self.public_path(path)?; }
    let scratch = if delivery.render_scratch.is_some() { Some(self.owned_scratch(delivery)?) } else { None };
    if let Some(cwd) = delivery.render_job.as_ref().and_then(|spec| spec.cwd.as_deref()) {
      if let Some(scratch) = scratch {
        if export_path_key(&canonical_export_path(Path::new(cwd))?) != export_path_key(&scratch) {
          return Err("retained render command differs from its private scratch owner".into());
        }
      } else { self.public_path(Path::new(cwd))?; }
    }
    Ok(())
  }

  fn authorize_path(&self, path: &Path, operation: PathLeaseOperation<'_>) -> Result<PathBuf, String> {
    match operation {
      PathLeaseOperation::Mutation => self.public_path(path),
      PathLeaseOperation::ExportDestination(owner) => {
        self.validate_delivery(owner)?;
        let canonical = self.public_path(path)?;
        if export_path_key(&canonical) != export_path_key(&canonical_export_path(Path::new(&owner.dest_path))?) {
          return Err("export destination operation does not match its admitted owner".into());
        }
        Ok(canonical)
      }
      PathLeaseOperation::RenderScratch(owner) => {
        self.validate_delivery(owner)?;
        let canonical = canonical_export_path(path)?;
        if export_path_key(&canonical) != export_path_key(&self.owned_scratch(owner)?) {
          return Err("native render directory operation does not match its admitted owner".into());
        }
        Ok(canonical)
      }
    }
  }
}

impl ExportJournal<'_> {
  fn validate_delivery(self, delivery: &ExportDelivery) -> Result<(), String> {
    self.infrastructure.validate_delivery(delivery)
  }

  fn ensure_exists(self) -> Result<(), String> {
    self.ensure_directory(self.root)
  }

  fn inventory(self) -> Result<(), String> {
    let mut scopes = Vec::new();
    let mut observed = HashMap::new();
    let result = (|| -> Result<(), String> {
      self.infrastructure.validate_namespaces()?;
      for namespace in self.infrastructure.journal.get().into_iter().chain(self.infrastructure.scratch.get()) {
        let directory = canonical_export_path(&namespace.path)?;
        scopes.push(export_path_key(&directory));
        for ancestor in directory.ancestors() {
          match std::fs::symlink_metadata(ancestor) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
              let usage = allocation::usage(ancestor)?;
              observed.insert(export_path_key(ancestor), allocation::Inventory { bytes: 0, allocated: usage.allocated,
                entries: 1, volume: allocation::AllocationUnit::for_directory(ancestor)? });
            }
            Ok(_) => return Err("export infrastructure scaffolding must contain only regular directories".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
          }
        }
      }
      let root = canonical_export_path(self.root)?;
      match std::fs::symlink_metadata(&root) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
      }
      for (index, entry) in std::fs::read_dir(&root).map_err(|error| error.to_string())?.enumerate() {
        if index > EXPORT_JOURNAL_ENTRY_LIMIT { return Err("export recovery journal exceeds its native inventory entry budget".into()); }
        let entry = entry.map_err(|error| error.to_string())?;
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if !kind.is_file() || kind.is_symlink() { return Err("export recovery journal must contain only regular files".into()); }
        let path = entry.path();
        observed.insert(export_path_key(&path), allocation::Inventory::for_file(&path)?);
      }
      Ok(())
    })();
    let accounted = self.workspace.inventory_metadata(&scopes, &observed, result.is_ok());
    match (result, accounted) {
      (Err(primary), Err(accounting)) => {
        self.workspace.metadata_unavailable(&primary);
        Err(format!("{primary}; export infrastructure inventory failed: {accounting}"))
      }
      (Err(error), Ok(())) => { self.workspace.metadata_unavailable(&error); Err(error) }
      (Ok(()), result) => result,
    }
  }

  fn observe_result(self, result: Result<(), String>) -> Result<(), String> {
    match (result, self.inventory()) {
      (Err(primary), Err(observation)) => Err(format!("{primary}; export infrastructure observation failed: {observation}")),
      (Err(error), Ok(())) => Err(error),
      (Ok(()), result) => result,
    }
  }

  fn ensure_directory(self, path: &Path) -> Result<(), String> {
    self.infrastructure.validate_namespaces()?;
    let path = canonical_export_path(path)?;
    let mut configured = false;
    for namespace in self.infrastructure.journal.get().into_iter().chain(self.infrastructure.scratch.get()) {
      configured |= namespace.key()? == export_path_key(&path);
    }
    if !configured { return Err("export infrastructure directory creation has no configured owner".into()); }
    self.inventory()?;
    for directory in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
      match std::fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => continue,
        Ok(_) => return Err("export infrastructure directory has a nonregular collision".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
      }
      let parent = directory.parent().ok_or("export infrastructure directory has no allocation parent")?;
      let volume = allocation::AllocationUnit::for_directory(parent)?;
      let charge = self.workspace.reserve_metadata_in(&export_path_key(directory), 0, volume, None)?;
      self.infrastructure.validate_namespaces()?;
      let mut builder = std::fs::DirBuilder::new();
      builder.recursive(false);
      #[cfg(unix)]
      {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
      }
      let created = match builder.create(directory) {
        Ok(()) => { charge.retain(); Ok(()) }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => { drop(charge); Ok(()) }
        Err(error) => { drop(charge); Err(format!("could not create admitted export infrastructure directory: {error}")) }
      };
      self.observe_result(created)?;
      self.workspace.require_metadata_fit()?;
    }
    self.inventory()
  }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ArtifactIdentity {
  pub sha256: String,
  pub size: u64,
}

#[derive(Debug, serde::Serialize)]
pub struct ExportResources {
  pub total_memory_bytes: Option<u64>,
  pub available_memory_bytes: Option<u64>,
  pub scratch_free_bytes: Option<u64>,
  pub destination_free_bytes: Option<u64>,
  pub budgets: ExportResourceBudgets,
  pub local_fast_candidate: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub memory_cgroup: Option<resources::LinuxMemoryCgroup>,
}

fn local_fast_candidate() -> bool {
  #[cfg(all(windows, debug_assertions))]
  {
    use windows_sys::Win32::Graphics::Gdi::{EnumDisplayDevicesW, DISPLAY_DEVICEW, DISPLAY_DEVICE_ATTACHED_TO_DESKTOP};
    for index in 0..16 {
      let mut display: DISPLAY_DEVICEW = unsafe { std::mem::zeroed() };
      display.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
      if unsafe { EnumDisplayDevicesW(std::ptr::null(), index, &mut display, 0) } == 0 { break; }
      let length = display.DeviceString.iter().position(|character| *character == 0).unwrap_or(display.DeviceString.len());
      let name = String::from_utf16_lossy(&display.DeviceString[..length]);
      if display.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP != 0 && name.contains("AMD") && name.contains("780M") { return true; }
    }
  }
  false
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResourceBudgets {
  memory_bytes: u64,
  temporary_bytes: u64,
  execution_seconds: u64,
}

fn existing_resource_directory(path: &Path) -> Option<PathBuf> {
  if !path.is_absolute() { return None; }
  let mut current = path.to_path_buf();
  loop {
    if let Ok(resolved) = current.canonicalize() {
      return if resolved.is_dir() { Some(resolved) } else { resolved.parent().map(Path::to_path_buf) };
    }
    if !current.pop() { return None; }
  }
}

fn resource_free_bytes(path: &Path, disks: &sysinfo::Disks) -> Option<u64> {
  let directory = existing_resource_directory(path)?;
  disks.iter().filter_map(|disk| disk.mount_point().canonicalize().ok().map(|mount| (disk, mount)))
    .filter(|(_, mount)| directory.starts_with(mount))
    .max_by_key(|(_, mount)| mount.components().count())
    .map(|(disk, _)| disk.available_space())
}

fn export_resources(destination: &Path, scratch: Option<&Path>, workspace: &Workspace) -> ExportResources {
  let mut system = sysinfo::System::new();
  system.refresh_memory();
  let total_memory_bytes = (system.total_memory() > 0).then(|| system.total_memory());
  let available_memory_bytes = total_memory_bytes.map(|_| system.available_memory());
  let disks = sysinfo::Disks::new_with_refreshed_list();
  ExportResources { total_memory_bytes, available_memory_bytes,
    scratch_free_bytes: scratch.and_then(|path| resource_free_bytes(path, &disks)),
    destination_free_bytes: resource_free_bytes(destination, &disks),
    budgets: ExportResourceBudgets { memory_bytes: budget::RENDER_RESIDENT_LIMIT,
      temporary_bytes: workspace.available_bytes(), execution_seconds: EXPORT_EXECUTION_LIMIT_MS / 1000 },
    local_fast_candidate: local_fast_candidate(), memory_cgroup: resources::memory_cgroup() }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct RenderScratchFile {
  pub name: String,
  pub content: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct RenderScratch {
  pub path: String,
  pub request_sha256: String,
  pub ready: bool,
  #[serde(default)]
  pub files: Vec<(String, ArtifactIdentity)>,
  #[serde(default)]
  pub reserved_bytes: u64,
  #[serde(default)]
  pub reserved_entries: u64,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub ownership: Option<InitialEntryOwnership>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InitialEntryOwnership {
  Planned,
  Created,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InitialEntryKind {
  Stage,
  RenderScratch,
}

#[derive(Clone, Copy)]
enum PathLeaseOperation<'a> {
  Mutation,
  ExportDestination(&'a ExportDelivery),
  RenderScratch(&'a ExportDelivery),
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InitialEntryPoint {
  IntentPersisted,
  Created,
}

#[cfg(test)]
type InitialEntryHook = Arc<dyn Fn(InitialEntryKind, InitialEntryPoint, &Path) -> Result<(), String> + Send + Sync>;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeliverySource {
  Render { paths: Vec<String> },
  Copy { path: String, media_ref: String },
}
impl Default for DeliverySource { fn default() -> Self { Self::Render { paths: Vec::new() } } }

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ExportDelivery {
  pub version: u32,
  pub id: String,
  pub project_dir: String,
  pub stage_path: String,
  pub dest_path: String,
  pub state: String,
  pub identity: Option<ArtifactIdentity>,
  pub created_at: u64,
  #[serde(default)]
  pub render_job: Option<JobSpec>,
  #[serde(default)]
  pub sources: Vec<(String, ArtifactIdentity)>,
  #[serde(default)]
  pub recovery_attempts: u32,
  #[serde(default)]
  pub source: DeliverySource,
  #[serde(default)]
  pub followups_done: bool,
  #[serde(default)]
  pub command_sha256: Option<String>,
  #[serde(default)]
  pub worker_identity: Option<ArtifactIdentity>,
  #[serde(default)]
  pub producer_complete: bool,
  #[serde(default)]
  pub execution_queued_at_ms: Option<u64>,
  #[serde(default)]
  pub execution_queued_ms: u64,
  #[serde(default)]
  pub render_scratch: Option<RenderScratch>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub copy_scratch: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub stage_ownership: Option<InitialEntryOwnership>,
}

impl ExportDelivery {
  fn validate_initial_ownership(&self) -> Result<(), String> {
    if self.version != 3 { return Ok(()); }
    if self.stage_ownership.is_none() || self.render_scratch.as_ref().is_some_and(|scratch| scratch.ownership.is_none()) {
      return Err("export recovery receipt has no initial-entry ownership evidence".into());
    }
    if matches!(self.state.as_str(), "prepared" | "verified" | "publishing" | "published") &&
      self.stage_ownership != Some(InitialEntryOwnership::Created) {
      return Err("active export has no confirmed staging-file ownership".into());
    }
    if self.render_scratch.as_ref().is_some_and(|scratch| scratch.ready && scratch.ownership != Some(InitialEntryOwnership::Created)) {
      return Err("ready render scratch has no confirmed directory ownership".into());
    }
    Ok(())
  }

  fn has_unconfirmed_initial_entry(&self) -> bool {
    self.stage_ownership == Some(InitialEntryOwnership::Planned) ||
      self.render_scratch.as_ref().is_some_and(|scratch| scratch.ownership == Some(InitialEntryOwnership::Planned))
  }

  fn require_confirmed_initial_entries(&self) -> Result<(), String> {
    self.validate_initial_ownership()?;
    if self.has_unconfirmed_initial_entry() { return Err("initial export entry ownership was not confirmed; export again".into()); }
    Ok(())
  }

  fn check_unconfirmed_cleanup(path: &Path, ownership: Option<InitialEntryOwnership>) -> Result<(), String> {
    if ownership != Some(InitialEntryOwnership::Planned) { return Ok(()); }
    match std::fs::symlink_metadata(path) {
      Ok(_) => Err("initial export entry has unconfirmed ownership; retained without deletion".into()),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
        let parent = path.parent().ok_or("initial export entry has no parent")?;
        if !std::fs::metadata(parent).map_err(|error| error.to_string())?.is_dir() {
          return Err("initial export entry parent is unavailable for cleanup".into());
        }
        Ok(())
      }
      Err(error) => Err(error.to_string()),
    }
  }

  fn copy_scratch_prefix(&self) -> String {
    format!(".artdaddy-copy-{:x}-", Sha256::digest(self.id.as_bytes()))
  }

  fn copy_scratch_path(&self) -> Result<Option<&Path>, String> {
    let Some(path) = &self.copy_scratch else { return Ok(None) };
    let path = Path::new(path);
    if !matches!(self.source, DeliverySource::Copy { .. }) || !path.is_absolute() ||
      path.parent() != Path::new(&self.stage_path).parent() ||
      !path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with(&self.copy_scratch_prefix())) {
      return Err("copy temporary file is outside its admitted namespace".into());
    }
    Ok(Some(path))
  }

  fn execution_deadline_ms(&self, at: u64) -> Result<u64, String> {
    if !matches!(self.version, 2 | 3) { return Err("retained export has no supported execution clock; export again".into()); }
    if at < self.created_at { return Err("export execution clock moved before admission".into()); }
    let pending = self.execution_queued_at_ms.map(|queued| at.checked_sub(queued).ok_or("export queue clock regressed")).transpose()?.unwrap_or(0);
    let queued = self.execution_queued_ms.checked_add(pending).ok_or("export queue clock overflow")?;
    let elapsed = at - self.created_at;
    if queued > elapsed { return Err("export queued duration exceeds its lifetime".into()); }
    let deadline = self.created_at.checked_add(queued).and_then(|start| start.checked_add(EXPORT_EXECUTION_LIMIT_MS))
      .ok_or("export execution deadline overflow")?;
    if at >= deadline { return Err("export exceeded its eight-hour execution budget".into()); }
    Ok(deadline)
  }

  fn enqueue_execution(&mut self, at: u64) -> Result<(), String> {
    self.execution_deadline_ms(at)?;
    if self.execution_queued_at_ms.is_none() { self.execution_queued_at_ms = Some(at); }
    Ok(())
  }

  fn resume_execution(&mut self, at: u64) -> Result<u64, String> {
    self.execution_deadline_ms(at)?;
    if let Some(queued) = self.execution_queued_at_ms.take() {
      self.execution_queued_ms = self.execution_queued_ms.checked_add(at.checked_sub(queued).ok_or("export queue clock regressed")?)
        .ok_or("export queue clock overflow")?;
    }
    self.execution_deadline_ms(at)
  }
}

fn artifact_identity(path: &Path) -> Result<ArtifactIdentity, String> {
  artifact_identity_checked(path, &|| Ok(()))
}

fn artifact_identity_checked(path: &Path, check: &dyn Fn() -> Result<(), String>) -> Result<ArtifactIdentity, String> {
  check()?;
  let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
  let before = file.metadata().map_err(|error| error.to_string())?;
  if !before.is_file() || before.len() == 0 { return Err("export artifact is empty or not a file".into()); }
  let mut hash = Sha256::new();
  let mut buffer = vec![0u8; 1024 * 1024];
  let mut size = 0;
  loop {
    check()?;
    let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
    if count == 0 { break; }
    size += count as u64;
    hash.update(&buffer[..count]);
  }
  let after = file.metadata().map_err(|error| error.to_string())?;
  check()?;
  if size != before.len() || size != after.len() || before.modified().ok() != after.modified().ok() {
    return Err("export artifact changed while hashing".into());
  }
  Ok(ArtifactIdentity { sha256: format!("{:x}", hash.finalize()), size })
}

const EXPORT_RECEIPT_LIMIT_BYTES: u64 = 8 * 1024 * 1024;
const EXPORT_JOURNAL_LIMIT_BYTES: u64 = 64 * 1024 * 1024;
const EXPORT_JOURNAL_ENTRY_LIMIT: usize = 4096;
const EXPORT_JOURNAL_TRANSIENT_BYTES: u64 = EXPORT_JOURNAL_LIMIT_BYTES + EXPORT_RECEIPT_LIMIT_BYTES;
const EXPORT_RECEIPT_TEMP_PREFIX: &str = ".receipt-";
static EXPORT_JOURNAL_IO: Mutex<()> = Mutex::new(());

fn valid_delivery_id(id: &str) -> bool {
  !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn lock_export_journal() -> Result<MutexGuard<'static, ()>, String> {
  EXPORT_JOURNAL_IO.lock().map_err(|error| format!("export recovery journal I/O lock failed: {error}"))
}

fn owned_receipt_temporary(name: &str) -> bool {
  let random = name.strip_prefix(EXPORT_RECEIPT_TEMP_PREFIX).and_then(|name| name.strip_suffix(".tmp"))
    .filter(|name| name.len() == 16)
    .or_else(|| name.strip_prefix(".tmp").filter(|name| name.len() == 6));
  random.is_some_and(|name| name.bytes().all(|byte| byte.is_ascii_alphanumeric()))
}

fn cleanup_receipt_temporaries(journal: ExportJournal<'_>) -> Result<(), String> {
  journal.infrastructure.validate_namespaces()?;
  journal.inventory()?;
  let root = journal.root;
  let cleaned = (|| -> Result<(), String> {
    for (index, entry) in std::fs::read_dir(root).map_err(|error| error.to_string())?.enumerate() {
      if index > EXPORT_JOURNAL_ENTRY_LIMIT { return Err("export recovery journal exceeds its temporary cleanup entry budget".into()); }
      let entry = entry.map_err(|error| error.to_string())?;
      if !entry.file_name().to_str().is_some_and(owned_receipt_temporary) { continue; }
      let kind = entry.file_type().map_err(|error| error.to_string())?;
      if !kind.is_file() || kind.is_symlink() { return Err("uncommitted export receipt must be an owned regular file".into()); }
      journal.infrastructure.validate_namespaces()?;
      std::fs::remove_file(entry.path()).map_err(|error| format!("could not clean uncommitted export receipt: {error}"))?;
    }
    Ok(())
  })();
  journal.observe_result(cleaned)
}

fn check_journal_capacity(journal: ExportJournal<'_>, target: Option<&Path>, next_bytes: u64, pending: Option<&Path>) -> Result<(), String> {
  journal.infrastructure.validate_namespaces()?;
  let root = canonical_export_path(journal.root)?;
  let mut installed = next_bytes;
  let mut entries = usize::from(target.is_some());
  let mut transient = next_bytes;
  let mut transient_entries = entries;
  for entry in std::fs::read_dir(root).map_err(|error| error.to_string())? {
    let entry = entry.map_err(|error| error.to_string())?;
    let path = entry.path();
    if pending == Some(path.as_path()) { continue; }
    let kind = entry.file_type().map_err(|error| error.to_string())?;
    if !kind.is_file() || kind.is_symlink() { return Err("export recovery journal must contain only regular files".into()); }
    let bytes = entry.metadata().map_err(|error| error.to_string())?.len();
    transient = transient.checked_add(bytes).ok_or("export journal transient size overflow")?;
    transient_entries = transient_entries.checked_add(1).ok_or("export journal transient entry overflow")?;
    if target != Some(path.as_path()) {
      installed = installed.checked_add(bytes).ok_or("export journal size overflow")?;
      entries = entries.checked_add(1).ok_or("export journal entry overflow")?;
    }
    if installed > EXPORT_JOURNAL_LIMIT_BYTES || entries > EXPORT_JOURNAL_ENTRY_LIMIT ||
      transient > EXPORT_JOURNAL_TRANSIENT_BYTES || transient_entries > EXPORT_JOURNAL_ENTRY_LIMIT + 1 {
      return Err("export recovery journal exceeds its aggregate admission budget; finish pending follow-ups before exporting".into());
    }
  }
  Ok(())
}

struct ReceiptWriter<'a> {
  output: &'a mut dyn Write,
  remaining: u64,
}

impl Write for ReceiptWriter<'_> {
  fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
    if bytes.len() as u64 > self.remaining {
      return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "export receipt exceeds its eight-MiB recovery budget"));
    }
    let written = self.output.write(bytes)?;
    self.remaining -= written as u64;
    Ok(written)
  }
  fn flush(&mut self) -> std::io::Result<()> { self.output.flush() }
}

fn persist_delivery(journal: ExportJournal<'_>, delivery: &ExportDelivery) -> Result<(), String> {
  persist_delivery_after_sync(journal, delivery, |_| Ok(()))
}

fn discard_receipt(journal: ExportJournal<'_>, file: tempfile::NamedTempFile, primary: String) -> String {
  let cleaned = match file.close() {
    Ok(()) => Err(primary),
    Err(error) => Err(format!("{primary}; uninstalled export receipt cleanup failed: {error}")),
  };
  journal.observe_result(cleaned).unwrap_err()
}

fn persist_delivery_after_sync(journal: ExportJournal<'_>, delivery: &ExportDelivery, after_sync: impl FnOnce(&Path) -> Result<(), String>) -> Result<(), String> {
  let _journal = lock_export_journal()?;
  journal.validate_delivery(delivery)?;
  let root = journal.root;
  let mut sink = std::io::sink();
  let mut measured = ReceiptWriter { output: &mut sink, remaining: EXPORT_RECEIPT_LIMIT_BYTES };
  serde_json::to_writer(&mut measured, delivery).map_err(|error| error.to_string())?;
  let expected_bytes = EXPORT_RECEIPT_LIMIT_BYTES - measured.remaining;
  journal.ensure_exists()?;
  cleanup_receipt_temporaries(journal)?;
  let root = canonical_export_path(root)?;
  let target = root.join(format!("{}.json", delivery.id));
  check_journal_capacity(journal, Some(&target), expected_bytes, None)?;
  let target_key = export_path_key(&target);
  let replacing = match std::fs::symlink_metadata(&target) {
    Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Some(target_key.as_str()),
    Ok(_) => return Err("export receipt replacement target must be a regular file".into()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
    Err(error) => return Err(error.to_string()),
  };
  let volume = allocation::AllocationUnit::for_directory(&root)?;
  let created = tempfile::Builder::new().prefix(EXPORT_RECEIPT_TEMP_PREFIX).rand_bytes(16).suffix(".tmp")
    .make_in(&root, |path| {
      journal.infrastructure.validate_namespaces().map_err(std::io::Error::other)?;
      match std::fs::symlink_metadata(path) {
        Ok(_) => return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "export receipt temporary collision")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
      }
      let charge = journal.workspace.reserve_metadata_in(&export_path_key(path), expected_bytes, volume, replacing)
        .map_err(std::io::Error::other)?;
      let mut options = std::fs::OpenOptions::new();
      options.read(true).write(true).create_new(true);
      #[cfg(unix)]
      {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
      }
      let output = options.open(path)?;
      charge.retain();
      Ok(output)
    });
  let mut file = match created {
    Ok(file) => file,
    Err(error) => return Err(journal.observe_result(Err(error.to_string())).unwrap_err()),
  };
  let temporary_key = export_path_key(file.path());
  let written = (|| -> Result<(), String> {
    journal.inventory()?;
    journal.workspace.require_metadata_fit()?;
    serde_json::to_writer(ReceiptWriter { output: file.as_file_mut(), remaining: expected_bytes }, delivery)
      .map_err(|error| error.to_string())?;
    if file.as_file().metadata().map_err(|error| error.to_string())?.len() != expected_bytes {
      return Err("export receipt size changed after admission".into());
    }
    file.as_file().sync_all().map_err(|error| error.to_string())?;
    after_sync(file.path())?;
    journal.inventory()?;
    journal.workspace.require_metadata_fit()?;
    journal.validate_delivery(delivery)?;
    check_journal_capacity(journal, Some(&target), expected_bytes, Some(file.path()))
  })();
  if let Err(error) = written { return Err(discard_receipt(journal, file, error)); }
  match file.persist(target) {
    Ok(installed) => {
      drop(installed);
      journal.workspace.install_metadata(&temporary_key, &target_key)
        .map_err(|error| format!("export receipt was installed but allocation settlement failed: {error}"))?;
      journal.inventory().and_then(|()| journal.workspace.require_metadata_fit())
        .map_err(|error| format!("export receipt was installed but allocation observation failed: {error}"))
    }
    Err(error) => Err(discard_receipt(journal, error.file, error.error.to_string())),
  }
}

fn remove_delivery_receipt(journal: ExportJournal<'_>, id: &str) -> Result<(), String> {
  let _journal = lock_export_journal()?;
  if !valid_delivery_id(id) { return Err("invalid export intent identity".into()); }
  journal.infrastructure.validate_namespaces()?;
  journal.inventory()?;
  let removed = std::fs::remove_file(journal.root.join(format!("{id}.json"))).map_err(|error| error.to_string());
  journal.observe_result(removed)
}

const EXPORT_SCRATCH_LIMIT_BYTES: u64 = 20_000_000_000;
const EXPORT_WORKSPACE_PAYLOAD_BYTES: u64 = EXPORT_SCRATCH_LIMIT_BYTES - 2_000_000_000;
const EXPORT_EXECUTION_LIMIT_MS: u64 = 8 * 60 * 60 * 1000;

// A persisted plan may have created its entry even when confirmation failed.
struct InitialEntryCharge(Option<workspace::Charge>);

impl InitialEntryCharge {
  fn release_uncreated(mut self) { drop(self.0.take()); }
}

impl Drop for InitialEntryCharge {
  fn drop(&mut self) {
    if let Some(charge) = self.0.take() { charge.retain(); }
  }
}

struct ScratchOutput {
  owned: Option<(tempfile::NamedTempFile, workspace::Charge)>,
  target: PathBuf,
  used: u64,
  limit: u64,
  failed: bool,
  previous_bytes: u64,
  previous_exists: bool,
  workspace: Arc<Workspace>,
  workspace_key: String,
}

impl ScratchOutput {
  fn open(path: &Path, used: u64, limit: u64, workspace: Arc<Workspace>, key: &str,
    temporary: Option<&Path>) -> Result<Self, String> {
    if used > limit { return Err("export scratch budget already exceeded".into()); }
    let previous = match std::fs::symlink_metadata(path) {
      Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Some(metadata.len()),
      Ok(_) => return Err("scratch output must be an owned regular file".into()),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
      Err(error) => return Err(error.to_string()),
    };
    let previous_exists = previous.is_some();
    let previous = previous.unwrap_or(0);
    let used = used.checked_add(previous).ok_or("scratch size overflow")?;
    if used > limit { return Err("export scratch budget already exceeded".into()); }
    let parent = path.parent().ok_or("scratch output has no parent")?;
    let volume = allocation::AllocationUnit::for_directory(parent)?;
    let charge = workspace.reserve_in(key, 0, 1, volume)?;
    let file = if let Some(temporary) = temporary {
      if !temporary.is_absolute() || temporary.parent() != Some(parent) || temporary == path {
        return Err("temporary output is outside its admitted parent".into());
      }
      let mut temporary = tempfile::TempPath::try_from_path(temporary).map_err(|error| error.to_string())?;
      temporary.disable_cleanup(true);
      let mut options = std::fs::OpenOptions::new();
      options.read(true).write(true).create_new(true);
      #[cfg(unix)]
      {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
      }
      let file = options.open(&temporary).map_err(|error| error.to_string())?;
      temporary.disable_cleanup(false);
      tempfile::NamedTempFile::from_parts(file, temporary)
    } else {
      tempfile::Builder::new().prefix(".tmp").tempfile_in(parent).map_err(|error| error.to_string())?
    };
    Ok(Self { owned: Some((file, charge)), target: path.to_path_buf(), used, limit, failed: false,
      previous_bytes: previous, previous_exists, workspace, workspace_key: key.to_string() })
  }

  fn open_workspace(path: &Path, used: u64, limit: u64, workspace: Arc<Workspace>, key: &str) -> Result<Self, String> {
    Self::open(path, used, limit, workspace, key, None)
  }

  fn capture(spec: &JobSpec, workspace: Arc<Workspace>) -> Result<Option<(Self, Vec<String>)>, String> {
    let Some(contract) = spec.meta.get("_native_scratch_capture") else { return Ok(None) };
    let path = contract.get("path").and_then(|value| value.as_str()).ok_or("native scratch capture path missing")?;
    let used = contract.get("used").and_then(|value| value.as_u64()).ok_or("native scratch capture byte count missing")?;
    let limit = contract.get("limit").and_then(|value| value.as_u64()).ok_or("native scratch capture limit missing")?;
    let args = captured_output_args(&spec.args)?;
    let cwd = Path::new(spec.cwd.as_deref().ok_or("temporary output has no admitted scratch root")?);
    let key = Supervisor::workspace_key(cwd);
    let usage = measured_scratch_usage(cwd, Path::new(""))?;
    workspace.account_allocated(&key, usage)?;
    Ok(Some((Self::open_workspace(Path::new(path), used, limit, workspace, &key)?, args)))
  }

  fn file(&self) -> &tempfile::NamedTempFile {
    &self.owned.as_ref().expect("temporary output is owned until settlement").0
  }

  fn cleanup(&mut self) -> Result<(), String> {
    let Some((file, charge)) = self.owned.take() else { return Ok(()) };
    match file.close() {
      Ok(()) => Ok(()),
      Err(error) => {
        charge.retain();
        Err(format!("temporary output cleanup failed; workspace reservation retained: {error}"))
      }
    }
  }

  fn abort(mut self, primary: String) -> String {
    match self.cleanup() {
      Ok(()) => primary,
      Err(cleanup) => format!("{primary}; {cleanup}"),
    }
  }

  fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
    if self.failed { return Err("temporary output is already failed".into()); }
    let Some(next) = self.used.checked_add(bytes.len() as u64) else {
      self.failed = true; return Err("export scratch byte count overflow".into());
    };
    if next > self.limit { self.failed = true; return Err("export scratch budget exceeded before write".into()); }
    let (file, charge) = self.owned.as_mut().expect("temporary output is owned until settlement");
    if let Err(error) = charge.grow(bytes.len() as u64) { self.failed = true; return Err(error); }
    if let Err(error) = file.write_all(bytes) { self.failed = true; return Err(error.to_string()); }
    self.used = next;
    Ok(())
  }

  fn finish(mut self, exit_code: Option<i32>) -> Result<(), String> {
    if self.failed { return Err(self.abort("failed temporary output cannot be installed".into())); }
    if exit_code != Some(0) { return Err(self.abort("unsuccessful worker cannot install temporary output".into())); }
    if let Err(error) = self.file().as_file().sync_all() { return Err(self.abort(error.to_string())); }
    let (file, charge) = self.owned.take().expect("temporary output is owned until settlement");
    match file.persist(&self.target) {
      Ok(_) => {
        charge.retain();
        self.workspace.release(&self.workspace_key, self.previous_bytes, u64::from(self.previous_exists));
        Ok(())
      }
      Err(error) => {
        let primary = error.error.to_string();
        self.owned = Some((error.file, charge));
        Err(self.abort(primary))
      }
    }
  }
}

impl Drop for ScratchOutput {
  fn drop(&mut self) {
    if let Err(error) = self.cleanup() { log::warn!("abandoned native temporary output: {error}"); }
  }
}

fn scratch_bytes(path: &Path, exclude: &Path) -> Result<u64, String> {
  scratch_usage(path, exclude).map(|usage| usage.0)
}

fn scratch_usage(path: &Path, exclude: &Path) -> Result<(u64, u64), String> {
  measured_scratch_usage(path, exclude).map(|usage| (usage.bytes, usage.entries))
}

fn measured_scratch_usage(path: &Path, exclude: &Path) -> Result<allocation::Inventory, String> {
  let volume = allocation::AllocationUnit::for_directory(path)?;
  let mut pending = vec![path.to_path_buf()];
  let mut bytes = 0u64;
  let mut allocated = allocation::usage(path)?.allocated;
  let mut entries = 0usize;
  while let Some(directory) = pending.pop() {
    for child in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
      entries += 1;
      if entries > 16384 { return Err("export scratch entry budget exceeded".into()); }
      let child = child.map_err(|error| error.to_string())?;
      let kind = child.file_type().map_err(|error| error.to_string())?;
      if kind.is_symlink() { return Err("export scratch cannot contain symbolic links".into()); }
      if kind.is_dir() {
        allocated = allocated.checked_add(allocation::usage(&child.path())?.allocated).ok_or("scratch allocation size overflow")?;
        pending.push(child.path());
      }
      else if kind.is_file() && child.path() != exclude {
        let usage = allocation::usage(&child.path())?;
        bytes = bytes.checked_add(usage.bytes).ok_or("scratch size overflow")?;
        allocated = allocated.checked_add(usage.allocated).ok_or("scratch allocation size overflow")?;
      }
    }
  }
  Ok(allocation::Inventory { bytes, allocated, entries: entries as u64 + 1, volume })
}

fn scratch_capture(spec: &JobSpec, stage_path: &str, final_step: bool) -> Result<Option<serde_json::Value>, String> {
  let output = spec.args.last().ok_or("render command has no output")?;
  let same_stage = Path::new(output) == Path::new(stage_path) || Path::new(output).canonicalize().ok()
    .zip(Path::new(stage_path).canonicalize().ok()).is_some_and(|(output, stage)| output == stage);
  if same_stage {
    if !final_step { return Err("intermediate render step cannot use the final-file allocation".into()); }
    return Ok(None);
  }
  if final_step { return Err("final render command must target its admitted stage".into()); }
  let cwd = spec.cwd.as_ref().ok_or("temporary render output needs owned scratch")?;
  let root = Path::new(cwd).canonicalize().map_err(|error| error.to_string())?;
  let relative = Path::new(output);
  if relative.is_absolute() || relative.components().count() != 1 || relative.extension().and_then(|value| value.to_str()) != Some("nut") ||
      !spec.args.windows(2).any(|pair| pair[0] == "-f" && pair[1] == "nut") {
    return Err("temporary render output is outside the bounded NUT writer contract".into());
  }
  let target = root.join(relative);
  let used = scratch_bytes(&root, &target)?;
  if used > EXPORT_SCRATCH_LIMIT_BYTES { return Err("export scratch budget already exceeded".into()); }
  Ok(Some(serde_json::json!({ "path": target, "used": used, "limit": EXPORT_SCRATCH_LIMIT_BYTES })))
}

fn captured_output_args(args: &[String]) -> Result<Vec<String>, String> {
  let mut args = args.to_vec();
  for index in 0..args.len().saturating_sub(1) {
    if args[index] == "-progress" && args[index + 1] == "pipe:1" { args[index + 1] = "pipe:2".into(); }
  }
  *args.last_mut().ok_or("captured command has no output")? = "pipe:1".into();
  Ok(args)
}

fn is_streamed(spec: &JobSpec) -> bool {
  spec.meta.get("renderTransport").and_then(|value| value.as_str()) == Some("partition-pipes-v1")
}

fn collect_render_dependencies(path: &Path, paths: &mut Vec<String>) -> Result<(), String> {
  if paths.len() >= 16384 { return Err("export dependency count exceeds journal budget".into()); }
  for entry in std::fs::read_dir(path).map_err(|error| error.to_string())? {
    let entry = entry.map_err(|error| error.to_string())?;
    let kind = entry.file_type().map_err(|error| error.to_string())?;
    if kind.is_symlink() { return Err("export scratch dependency cannot be a symbolic link".into()); }
    if kind.is_dir() { collect_render_dependencies(&entry.path(), paths)?; }
    else if kind.is_file() { paths.push(entry.path().to_string_lossy().into_owned()); }
  }
  Ok(())
}

impl Supervisor {
  pub fn new(spawner: Arc<dyn Spawner>, notify: Arc<dyn Fn(Notice) + Send + Sync>) -> Self {
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|d| d.as_nanos())
      .unwrap_or(0);
    Self {
      state: Arc::default(),
      spawner,
      notify,
      launch_id: format!("launch-{nanos:x}-{:x}", std::process::id()).into(),
      deliveries: Arc::default(),
      infrastructure: Arc::default(),
      export_root: None,
      export_work_root: None,
      export_font_root: None,
      workspace: Workspace::new(EXPORT_WORKSPACE_PAYLOAD_BYTES),
      copying: Arc::default(),
      copy_settled: Arc::default(),
      #[cfg(test)]
      initial_entry_hook: None,
    }
  }

  pub fn with_export_root(mut self, root: PathBuf) -> Result<Self, String> {
    self.infrastructure.configure_journal(root.clone())?;
    let journal = self.infrastructure.journal(&self.workspace)?;
    let mut deliveries = self.deliveries.lock().map_err(|error| error.to_string())?;
    let _journal = lock_export_journal()?;
    journal.ensure_exists()?;
    let mut loaded = HashMap::new();
    let mut installed = 0u64;
    for entry in std::fs::read_dir(&root).map_err(|error| error.to_string())? {
      let entry = entry.map_err(|error| error.to_string())?;
      let path = entry.path();
      if path.extension().and_then(|value| value.to_str()) != Some("json") { continue; }
      if !entry.file_type().map_err(|error| error.to_string())?.is_file() { return Err("export recovery receipt must be a regular file".into()); }
      let declared = std::fs::metadata(&path).map_err(|error| error.to_string())?.len();
      if loaded.len() >= EXPORT_JOURNAL_ENTRY_LIMIT || declared > EXPORT_RECEIPT_LIMIT_BYTES || installed.saturating_add(declared) > EXPORT_JOURNAL_LIMIT_BYTES {
        return Err("export journal exceeds the bounded loading budget".into());
      }
      let mut bytes = Vec::with_capacity(declared as usize + 1);
      std::fs::File::open(&path).map_err(|error| error.to_string())?.take(EXPORT_RECEIPT_LIMIT_BYTES + 1)
        .read_to_end(&mut bytes).map_err(|error| error.to_string())?;
      if bytes.len() as u64 > EXPORT_RECEIPT_LIMIT_BYTES { return Err("export receipt grew beyond its recovery budget".into()); }
      installed = installed.checked_add(bytes.len() as u64).ok_or("export journal size overflow")?;
      if installed > EXPORT_JOURNAL_LIMIT_BYTES { return Err("export journal grew beyond its aggregate recovery budget".into()); }
      let delivery: ExportDelivery = serde_json::from_slice(&bytes).map_err(|error| format!("damaged export journal {}: {error}", path.display()))?;
      if !matches!(delivery.version, 1 | 2 | 3) || !valid_delivery_id(&delivery.id) ||
        path.file_stem().and_then(|value| value.to_str()) != Some(delivery.id.as_str()) {
        return Err("unsupported or invalid export journal identity".into());
      }
      journal.validate_delivery(&delivery)?;
      loaded.insert(delivery.id.clone(), delivery);
    }
    cleanup_receipt_temporaries(journal)?;
    check_journal_capacity(journal, None, 0, None)?;
    self.account_payload_workspace(&loaded)?;
    *deliveries = loaded;
    drop(deliveries);
    self.export_root = Some(root);
    Ok(self)
  }

  pub fn with_export_work_root(mut self, root: PathBuf) -> Result<Self, String> {
    self.infrastructure.configure_scratch(root.join("exports"))?;
    self.export_work_root = Some(root);
    Ok(self)
  }

  pub fn with_export_font_root(mut self, root: PathBuf) -> Self { self.export_font_root = Some(root); self }

  fn journal(&self) -> Result<ExportJournal<'_>, String> {
    self.export_root.as_ref().ok_or("native export journal is unavailable")?;
    self.infrastructure.journal(&self.workspace)
  }

  fn workspace_key(path: &Path) -> String {
    let resolved = path.canonicalize().or_else(|error| {
      if error.kind() != std::io::ErrorKind::NotFound { return Err(error); }
      match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => parent.canonicalize().map(|parent| parent.join(name)),
        _ => Err(error),
      }
    }).unwrap_or_else(|_| path.to_path_buf());
    let normalized = resolved.to_string_lossy()
      .trim_start_matches("\\\\?\\").replace('\\', "/");
    if cfg!(target_os = "windows") { normalized.to_lowercase() } else { normalized }
  }

  fn account_workspace(&self, entries: &HashMap<String, ExportDelivery>) -> Result<(), String> {
    {
      let _journal = lock_export_journal()?;
      self.journal()?.inventory()?;
    }
    self.account_payload_workspace(entries)
  }

  fn account_payload_workspace(&self, entries: &HashMap<String, ExportDelivery>) -> Result<(), String> {
    for delivery in entries.values().filter(|delivery| delivery.state != "published" && !delivery.followups_done) {
      let mut bytes = 0u64;
      let mut allocated = 0u64;
      let mut count = 0u64;
      for path in std::iter::once(Path::new(&delivery.stage_path)).chain(delivery.copy_scratch_path()?) {
        match std::fs::metadata(path) {
          Ok(metadata) if metadata.is_file() => {
            let usage = allocation::usage(path)?;
            bytes = bytes.checked_add(usage.bytes).ok_or("export staging size overflow")?;
            allocated = allocated.checked_add(usage.allocated).ok_or("export staging allocation size overflow")?;
            count += 1;
          }
          Ok(_) => return Err("export stage is not a regular file".into()),
          Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
          Err(error) => return Err(error.to_string()),
        }
      }
      if count > 0 {
        let volume = allocation::AllocationUnit::for_directory(Path::new(&delivery.stage_path).parent().ok_or("export stage has no parent")?)?;
        self.workspace.restore_allocated(&Self::workspace_key(Path::new(&delivery.stage_path)),
          allocation::Inventory { bytes, entries: count, allocated, volume }, 0, 0)?;
      }
    }
    let Some(work) = &self.export_work_root else { return Ok(()) };
    let arena = work.join("exports");
    if !arena.exists() { return Ok(()); }
    let mut count = 0usize;
    for entry in std::fs::read_dir(&arena).map_err(|error| error.to_string())? {
      count += 1;
      if count > 4096 { return Err("export workspace directory budget exceeded".into()); }
      let entry = entry.map_err(|error| error.to_string())?;
      let kind = entry.file_type().map_err(|error| error.to_string())?;
      if !kind.is_dir() || kind.is_symlink() { return Err("export workspace contains an unowned filesystem entry".into()); }
      let key = Self::workspace_key(&entry.path());
      let held = entries.values().filter_map(|delivery| delivery.render_scratch.as_ref())
        .find(|scratch| Self::workspace_key(Path::new(&scratch.path)) == key).map(|scratch| scratch.reserved_bytes).unwrap_or(0);
      let held_entries = entries.values().filter_map(|delivery| delivery.render_scratch.as_ref())
        .find(|scratch| Self::workspace_key(Path::new(&scratch.path)) == key).map(|scratch| scratch.reserved_entries).unwrap_or(0);
      let usage = measured_scratch_usage(&entry.path(), Path::new(""))?;
      self.workspace.restore_allocated(&key, usage, held, held_entries)?;
    }
    Ok(())
  }

  fn claim_export_output(&self, id: &str) -> Result<workspace::OutputClaim, String> {
    let path = self.deliveries.lock().map_err(|error| error.to_string())?.get(id)
      .ok_or("output capacity has no admitted delivery")?.stage_path.clone();
    self.workspace.claim_output(&Self::workspace_key(Path::new(&path)), &|| {
      let entries = self.deliveries.lock().map_err(|error| error.to_string())?;
      let entry = entries.get(id).ok_or("output intent vanished while waiting for temporary capacity")?;
      self.journal()?.validate_delivery(entry)?;
      entry.require_confirmed_initial_entries()?;
      if entry.state != "prepared" || entry.producer_complete { return Err("output intent is no longer eligible while waiting for temporary capacity".into()); }
      entry.execution_deadline_ms(now_ms())?;
      if self.lock().jobs.get(id).is_some_and(|job| job.kill_requested ||
        (matches!(entry.source, DeliverySource::Render { .. }) && job.state == JobState::Exited)) {
        return Err("output was cancelled or superseded while waiting for temporary capacity".into());
      }
      Ok(())
    })
  }

  fn finish_output_claim(&self, id: &str) {
    if let Some(delivery) = self.deliveries.lock().unwrap_or_else(|error| error.into_inner()).get(id) {
      self.workspace.finish_output_claim(&Self::workspace_key(Path::new(&delivery.stage_path)));
    }
  }

  fn create_initial_entry(&self, entries: &mut HashMap<String, ExportDelivery>, planned: ExportDelivery,
    kind: InitialEntryKind) -> Result<ExportDelivery, String> {
    if planned.version != 3 { return Err("new export entries require versioned ownership evidence".into()); }
    planned.validate_initial_ownership()?;
    let previous = entries.get(&planned.id).cloned();
    let (path, bytes, count) = match kind {
      InitialEntryKind::Stage => {
        if previous.is_some() || planned.stage_ownership != Some(InitialEntryOwnership::Planned) || planned.state != "failed" {
          return Err("initial staging file has no exclusive uncreated intent".into());
        }
        (PathBuf::from(&planned.stage_path), 0, 1)
      }
      InitialEntryKind::RenderScratch => {
        if previous.as_ref().is_none_or(|entry| entry.render_scratch.is_some()) ||
          planned.state != "prepared" || !matches!(planned.source, DeliverySource::Render { .. }) {
          return Err("initial render directory has no exclusive uncreated intent".into());
        }
        let scratch = planned.render_scratch.as_ref().ok_or("render directory has no initial ownership plan")?;
        if scratch.ready || scratch.ownership != Some(InitialEntryOwnership::Planned) {
          return Err("render directory ownership plan was already used".into());
        }
        (PathBuf::from(&scratch.path), scratch.reserved_bytes, scratch.reserved_entries)
      }
    };
    if !path.is_absolute() || count == 0 { return Err("initial export entry has no admitted absolute identity".into()); }
    let operation = match kind {
      InitialEntryKind::Stage => PathLeaseOperation::Mutation,
      InitialEntryKind::RenderScratch => PathLeaseOperation::RenderScratch(&planned),
    };
    self.require_unleased_path(&path, entries.values(), operation)?;
    self.account_workspace(entries)?;
    let parent = path.parent().ok_or("initial export entry has no parent")?;
    if kind == InitialEntryKind::RenderScratch {
      let arena = self.infrastructure.scratch_arena()?.canonicalize().map_err(|error| error.to_string())?;
      if parent.canonicalize().map_err(|error| error.to_string())? != arena {
        return Err("initial render directory is outside its admitted arena".into());
      }
    }
    let volume = allocation::AllocationUnit::for_directory(parent)?;
    let admitted_path = parent.canonicalize().map_err(|error| error.to_string())?
      .join(path.file_name().ok_or("initial export entry has no filename")?);
    let charge = self.workspace.reserve_in(&Self::workspace_key(&admitted_path), bytes, count, volume)?;
    let root = self.journal()?;
    persist_delivery(root, &planned)?;
    entries.insert(planned.id.clone(), planned.clone());
    let charge = InitialEntryCharge(Some(charge));
    #[cfg(test)]
    if let Some(hook) = &self.initial_entry_hook { hook(kind, InitialEntryPoint::IntentPersisted, &path)?; }
    planned.execution_deadline_ms(now_ms())?;
    self.infrastructure.authorize_path(&path, operation)?;
    let created = match kind {
      InitialEntryKind::Stage => {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
          use std::os::unix::fs::OpenOptionsExt;
          options.mode(0o600);
        }
        options.open(&path).map(Some)
      }
      InitialEntryKind::RenderScratch => {
        let mut directory = std::fs::DirBuilder::new();
        directory.recursive(false);
        #[cfg(unix)]
        {
          use std::os::unix::fs::DirBuilderExt;
          directory.mode(0o700);
        }
        directory.create(&path).map(|_| None)
      }
    };
    let file = match created {
      Ok(file) => file,
      Err(error) => {
        let rollback = match &previous {
          Some(previous) => persist_delivery(root, previous),
          None => remove_delivery_receipt(root, &planned.id),
        };
        if let Err(rollback) = rollback {
          return Err(format!("initial export entry creation failed: {error}; ownership rollback failed and reservation is retained: {rollback}"));
        }
        if let Some(previous) = previous { entries.insert(planned.id.clone(), previous); }
        else { entries.remove(&planned.id); }
        charge.release_uncreated();
        return Err(format!("initial export entry creation failed without adopting the occupied path: {error}"));
      }
    };
    if let Some(file) = file { file.sync_all().map_err(|error| error.to_string())?; }
    #[cfg(test)]
    if let Some(hook) = &self.initial_entry_hook { hook(kind, InitialEntryPoint::Created, &path)?; }
    let mut confirmed = planned;
    match kind {
      InitialEntryKind::Stage => {
        confirmed.stage_ownership = Some(InitialEntryOwnership::Created);
        confirmed.state = "prepared".into();
      }
      InitialEntryKind::RenderScratch => {
        confirmed.render_scratch.as_mut().ok_or("render ownership plan disappeared")?.ownership = Some(InitialEntryOwnership::Created);
      }
    }
    persist_delivery(root, &confirmed)?;
    entries.insert(confirmed.id.clone(), confirmed.clone());
    Ok(confirmed)
  }

  pub fn stage_render_scratch(&self, id: &str, files: Vec<RenderScratchFile>, fonts: Vec<String>) -> Result<String, String> {
    let safe_name = |name: &str| !name.is_empty() && name != "." && name != ".." &&
      !name.chars().any(|character| character.is_control() || matches!(character, '/' | '\\' | ':' | '"' | '<' | '>' | '|' | '?' | '*')) &&
      !name.ends_with(['.', ' ']);
    if files.len().checked_add(fonts.len()).is_none_or(|count| count > 16384) {
      return Err("render staging entry budget exceeded".into());
    }
    let mut names = HashSet::new();
    let mut bytes = 0usize;
    for file in &files {
      if !safe_name(&file.name) || !names.insert(file.name.to_lowercase()) { return Err("render staging filenames must be unique contained basenames".into()); }
      bytes = bytes.checked_add(file.content.len()).ok_or("render staging size overflow")?;
      if bytes > 32 * 1024 * 1024 { return Err("render staged text budget exceeded".into()); }
    }
    names.clear();
    for font in &fonts {
      if !safe_name(font) || !names.insert(font.to_lowercase()) { return Err("render font filenames must be unique contained basenames".into()); }
    }
    let _capacity = self.claim_export_output(id)?;
    let request_sha256 = format!("{:x}", Sha256::digest(serde_json::to_vec(&(&files, &fonts)).map_err(|error| error.to_string())?));
    let root = self.journal()?;
    let mut entries = self.deliveries.lock().map_err(|error| error.to_string())?;
    self.account_workspace(&entries)?;
    let current = entries.get_mut(id).ok_or("render staging has no admitted delivery intent")?;
    if !matches!(current.source, DeliverySource::Render { .. }) || current.state != "prepared" || current.producer_complete {
      return Err("render staging intent is no longer eligible".into());
    }
    if let Some(scratch) = &current.render_scratch {
      if scratch.ready && scratch.request_sha256 == request_sha256 {
        self.validate_render_scratch(current, Some(&scratch.path))?;
        return Ok(scratch.path.clone());
      }
      return Err("render staging request changed or its previous write did not complete".into());
    }
    if current.render_job.is_some() { return Err("render staging cannot replace an admitted worker's inputs".into()); }
    self.record_execution_clock(current, false)?;
    let work = self.infrastructure.scratch_arena()?;
    {
      let _journal = lock_export_journal()?;
      root.ensure_directory(work)?;
    }
    let path = work.join(format!("render-{id}-{}", &request_sha256[..16])).to_string_lossy().into_owned();
    let font_bytes = fonts.iter().try_fold(0u64, |total, font| {
      let bytes = self.export_font_root.as_ref().and_then(|root| std::fs::metadata(root.join(font)).ok())
        .map(|metadata| metadata.len()).unwrap_or(32 * 1024 * 1024);
      total.checked_add(bytes).ok_or("render font workspace size overflow")
    })?;
    let reserved_bytes = (bytes as u64).checked_add(font_bytes).ok_or("render staging workspace size overflow")?;
    let reserved_entries = (files.len() + fonts.len() + usize::from(!fonts.is_empty()) + 1) as u64;
    let mut reserved = current.clone();
    if reserved.version == 2 {
      let stage = std::fs::symlink_metadata(&reserved.stage_path).map_err(|error| error.to_string())?;
      if !stage.is_file() || stage.file_type().is_symlink() { return Err("legacy staging ownership cannot be upgraded from an unavailable regular file".into()); }
      reserved.version = 3;
      reserved.stage_ownership = Some(InitialEntryOwnership::Created);
    }
    reserved.render_scratch = Some(RenderScratch { path: path.clone(), request_sha256, ready: false, files: Vec::new(), reserved_bytes, reserved_entries,
      ownership: Some(InitialEntryOwnership::Planned) });
    self.create_initial_entry(&mut entries, reserved, InitialEntryKind::RenderScratch)?;
    let current = entries.get_mut(id).ok_or("initial render intent disappeared")?;
    let owned = PathBuf::from(&path);
    let mut written_bytes = 0u64;
    for file in files {
      current.execution_deadline_ms(now_ms())?;
      let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(owned.join(file.name)).map_err(|error| error.to_string())?;
      output.write_all(file.content.as_bytes()).map_err(|error| error.to_string())?;
      written_bytes = written_bytes.checked_add(file.content.len() as u64).ok_or("render staging write size overflow")?;
      output.sync_all().map_err(|error| error.to_string())?;
    }
    if !fonts.is_empty() {
      let font_root = self.export_font_root.as_ref().ok_or("bundled render font root is unavailable")?;
      std::fs::create_dir(owned.join("fonts")).map_err(|error| error.to_string())?;
      for font in fonts {
        current.execution_deadline_ms(now_ms())?;
        let source = font_root.join(&font);
        let metadata = std::fs::symlink_metadata(&source).map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 32 * 1024 * 1024 {
          return Err("bundled render font is not a bounded regular file".into());
        }
        let mut input = std::fs::File::open(source).map_err(|error| error.to_string())?;
        let expected = input.metadata().map_err(|error| error.to_string())?.len();
        if expected > reserved_bytes.saturating_sub(written_bytes) { return Err("bundled font grew beyond its admitted workspace charge".into()); }
        let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(owned.join("fonts").join(font)).map_err(|error| error.to_string())?;
        let mut remaining = expected;
        let mut buffer = vec![0u8; 1024 * 1024];
        while remaining > 0 {
          current.execution_deadline_ms(now_ms())?;
          let take = remaining.min(buffer.len() as u64) as usize;
          let count = input.read(&mut buffer[..take]).map_err(|error| error.to_string())?;
          if count == 0 { return Err("bundled font changed while staging".into()); }
          output.write_all(&buffer[..count]).map_err(|error| error.to_string())?;
          remaining -= count as u64;
        }
        if input.read(&mut buffer[..1]).map_err(|error| error.to_string())? != 0 { return Err("bundled font grew while staging".into()); }
        written_bytes = written_bytes.checked_add(expected).ok_or("render font write size overflow")?;
        output.sync_all().map_err(|error| error.to_string())?;
      }
    }
    let mut ready = current.clone();
    let mut staged = Vec::new();
    collect_render_dependencies(&owned, &mut staged)?;
    let identities = staged.into_iter().map(|path| {
      let relative = Path::new(&path).strip_prefix(&owned).map_err(|error| error.to_string())?.to_string_lossy().into_owned();
      artifact_identity(Path::new(&path)).map(|identity| (relative, identity))
    }).collect::<Result<Vec<_>, _>>()?;
    ready.render_scratch.as_mut().ok_or("render scratch reservation disappeared")?.files = identities;
    ready.render_scratch.as_mut().ok_or("render scratch reservation disappeared")?.ready = true;
    persist_delivery(root, &ready)?;
    *current = ready;
    Ok(path)
  }

  fn validate_render_scratch(&self, delivery: &ExportDelivery, cwd: Option<&str>) -> Result<(), String> {
    self.journal()?.validate_delivery(delivery)?;
    let Some(cwd) = cwd else {
      if delivery.render_scratch.is_some() { return Err("render command omitted its admitted scratch directory".into()); }
      return Ok(());
    };
    let scratch = delivery.render_scratch.as_ref().ok_or("render command has no admitted scratch reservation")?;
    if !scratch.ready { return Err("render scratch staging has not completed".into()); }
    let arena = self.infrastructure.scratch_arena()?.canonicalize().map_err(|error| error.to_string())?;
    let directory = Path::new(&scratch.path);
    let metadata = std::fs::symlink_metadata(directory).map_err(|error| error.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err("admitted render scratch is not an owned regular directory".into()); }
    let actual = directory.canonicalize().map_err(|error| error.to_string())?;
    if actual.parent() != Some(arena.as_path()) || Path::new(cwd).canonicalize().map_err(|error| error.to_string())? != actual {
      return Err("render command scratch differs from its native reservation".into());
    }
    for (relative, expected) in &scratch.files {
      let path = Path::new(relative);
      if path.is_absolute() || path.components().any(|component| !matches!(component, std::path::Component::Normal(_))) {
        return Err("retained render staging manifest has an invalid relative path".into());
      }
      let path = actual.join(path);
      if std::fs::metadata(&path).map_err(|error| error.to_string())?.len() != expected.size {
        return Err("render staged input changed before worker admission".into());
      }
      let identity = artifact_identity_checked(&path, &|| delivery.execution_deadline_ms(now_ms()).map(|_| ()))?;
      if identity.sha256 != expected.sha256 || identity.size != expected.size { return Err("render staged input changed before worker admission".into()); }
    }
    Ok(())
  }

  pub fn prepare_delivery(&self, id: String, project_dir: String, stage_path: String, dest_path: String, source: DeliverySource) -> Result<ExportDelivery, String> {
    let admitted_at = now_ms();
    if !valid_delivery_id(&id) {
      return Err("invalid export intent identity".into());
    }
    let stage = PathBuf::from(&stage_path);
    let dest = PathBuf::from(&dest_path);
    if !stage.is_absolute() || !dest.is_absolute() || stage == dest {
      return Err("export needs a distinct destination-volume staging sibling".into());
    }
    let parent = dest.parent().ok_or("export destination has no parent")?.canonicalize().map_err(|error| error.to_string())?;
    let stage_parent = stage.parent().ok_or("export stage has no parent")?.canonicalize().map_err(|error| error.to_string())?;
    if stage_parent != parent { return Err("export needs a distinct destination-volume staging sibling".into()); }
    let stage_path = parent.join(stage.file_name().ok_or("export stage has no filename")?).to_string_lossy().into_owned();
    let dest_path = parent.join(dest.file_name().ok_or("export destination has no filename")?).to_string_lossy().into_owned();
    let destination_key = |path: &str| if cfg!(target_os = "windows") { path.to_lowercase() } else { path.to_string() };
    if destination_key(&stage_path) == destination_key(&dest_path) { return Err("staging aliases the destination".into()); }
    let mut deliveries = self.deliveries.lock().map_err(|error| error.to_string())?;
    if deliveries.len() >= EXPORT_JOURNAL_ENTRY_LIMIT { return Err("export recovery-intent budget is full; finish pending follow-ups before exporting".into()); }
    if deliveries.values().any(|entry| destination_key(&entry.dest_path) == destination_key(&dest_path) && entry.state != "published" && entry.state != "cancelled" && entry.state != "failed") {
      return Err("export destination is already reserved".into());
    }
    if deliveries.contains_key(&id) { return Err("export intent already exists".into()); }
    let sources = match &source {
      DeliverySource::Render { paths } => {
        if paths.len() > 16384 { return Err("export dependency count exceeds admission budget".into()); }
        for path in paths {
          if !Path::new(path).is_absolute() || !Path::new(path).is_file() { return Err("export dependency is unavailable at admission".into()); }
        }
        Vec::new()
      }
      DeliverySource::Copy { path, media_ref } => {
        if media_ref.is_empty() || !Path::new(path).is_absolute() { return Err("copy export needs an imported source identity".into()); }
        vec![(path.clone(), artifact_identity(Path::new(path))?)]
      }
    };
    let execution_queued_at_ms = Some(now_ms());
    let delivery = ExportDelivery { version: 3, id: id.clone(), project_dir, stage_path, dest_path,
      state: "failed".into(), identity: None, created_at: admitted_at, render_job: None, sources, recovery_attempts: 0, source, followups_done: false,
      command_sha256: None, worker_identity: None, producer_complete: false, execution_queued_at_ms, execution_queued_ms: 0,
      render_scratch: None, copy_scratch: None, stage_ownership: Some(InitialEntryOwnership::Planned) };
    self.require_unleased_path(Path::new(&delivery.dest_path), deliveries.values().chain(std::iter::once(&delivery)), PathLeaseOperation::Mutation)?;
    let delivery = self.create_initial_entry(&mut deliveries, delivery, InitialEntryKind::Stage)?;
    let queued = if matches!(delivery.source, DeliverySource::Copy { .. }) { Some(self.retain_copy_job(&delivery, JobState::Queued)?) } else { None };
    drop(deliveries);
    if let Some(view) = queued { (self.notify)(Notice::Changed(view)); }
    Ok(delivery)
  }

  fn require_completed_producer(&self, delivery: &ExportDelivery) -> Result<(), String> {
    self.journal()?.validate_delivery(delivery)?;
    delivery.require_confirmed_initial_entries()?;
    if !delivery.producer_complete { return Err("export producer has no durable successful completion".into()); }
    if self.copying.lock().map_err(|error| error.to_string())?.contains(&delivery.id) {
      return Err("export copy is still running".into());
    }
    if self.lock().jobs.get(&delivery.id).is_some_and(|job| job.state != JobState::Exited || job.kill_requested || job.code != Some(0)) {
      return Err("export worker has not successfully settled".into());
    }
    Ok(())
  }

  fn transition_execution_clock(&self, id: &str, queued: bool) -> Result<Option<ExportDelivery>, String> {
    let mut entries = self.deliveries.lock().map_err(|error| error.to_string())?;
    let Some(current) = entries.get_mut(id) else { return Ok(None) };
    self.record_execution_clock(current, queued).map(Some)
  }

  fn record_execution_clock(&self, current: &mut ExportDelivery, queued: bool) -> Result<ExportDelivery, String> {
    self.journal()?.validate_delivery(current)?;
    current.require_confirmed_initial_entries()?;
    if current.state != "prepared" { return Err("export job is not in prepared state".into()); }
    if current.producer_complete { return Err("completed export producer cannot be run again".into()); }
    let mut next = current.clone();
    if queued { next.enqueue_execution(now_ms())?; } else { next.resume_execution(now_ms())?; }
    if next.execution_queued_at_ms != current.execution_queued_at_ms || next.execution_queued_ms != current.execution_queued_ms {
      let root = self.journal()?;
      persist_delivery(root, &next)?;
      *current = next.clone();
    }
    Ok(next)
  }

  pub fn verify_delivery(&self, id: &str) -> Result<ExportDelivery, String> {
    let root = self.journal()?;
    let delivery = self.deliveries.lock().map_err(|error| error.to_string())?.get(id).cloned().ok_or("unknown export intent")?;
    if delivery.state != "prepared" && delivery.state != "verified" { return Err("export intent cannot be verified".into()); }
    if delivery.execution_queued_at_ms.is_some() { return Err("queued export cannot be verified".into()); }
    let check = || delivery.execution_deadline_ms(now_ms()).map(|_| ());
    check()?;
    self.require_completed_producer(&delivery)?;
    for (path, expected) in &delivery.sources {
      let actual = artifact_identity_checked(Path::new(path), &check)?;
      if actual.sha256 != expected.sha256 || actual.size != expected.size { return Err("export dependency changed during rendering".into()); }
    }
    let mut next = delivery.clone();
    next.identity = Some(artifact_identity_checked(Path::new(&delivery.stage_path), &check)?);
    if matches!(delivery.source, DeliverySource::Copy { .. }) {
      let expected = delivery.sources.first().ok_or("copy export has no source identity")?;
      let actual = next.identity.as_ref().ok_or("copy stage has no identity")?;
      if actual.sha256 != expected.1.sha256 || actual.size != expected.1.size { return Err("copied artifact differs from the admitted library source".into()); }
    }
    next.state = "verified".into();
    let mut deliveries = self.deliveries.lock().map_err(|error| error.to_string())?;
    let current = deliveries.get_mut(id).ok_or("export intent vanished")?;
    if current.state != "prepared" && current.state != "verified" { return Err("export intent was cancelled or superseded during verification".into()); }
    current.execution_deadline_ms(now_ms())?;
    self.require_completed_producer(current)?;
    persist_delivery(root, &next)?;
    *current = next;
    Ok(current.clone())
  }

  pub fn publish_delivery(&self, id: &str) -> Result<ExportDelivery, String> {
    let root = self.journal()?;
    let captured = self.deliveries.lock().map_err(|error| error.to_string())?.get(id).cloned().ok_or("unknown export intent")?;
    self.require_completed_producer(&captured)?;
    let checked_stage = Path::new(&captured.stage_path).exists() && captured.state != "published";
    let checked_path = if checked_stage { &captured.stage_path } else { &captured.dest_path };
    let actual = artifact_identity_checked(Path::new(checked_path), &|| {
      if checked_stage { captured.execution_deadline_ms(now_ms())?; }
      Ok(())
    })?;
    let expected = captured.identity.as_ref().ok_or("export has no verified identity")?;
    if actual.sha256 != expected.sha256 || actual.size != expected.size { return Err("export artifact identity differs at publication".into()); }
    let mut deliveries = self.deliveries.lock().map_err(|error| error.to_string())?;
    if checked_stage {
      let owner = deliveries.get(id).ok_or("unknown export intent")?;
      self.require_unleased_path(Path::new(&owner.dest_path), deliveries.values(), PathLeaseOperation::ExportDestination(owner))?;
    }
    let delivery = deliveries.get_mut(id).ok_or("unknown export intent")?;
    self.require_completed_producer(delivery)?;
    if delivery.state != "published" && Path::new(&delivery.stage_path).exists() != checked_stage {
      return Err("export artifact path changed during publication verification".into());
    }
    if delivery.state == "published" {
      let expected = delivery.identity.as_ref().ok_or("published export has no artifact identity")?;
      if actual.sha256 != expected.sha256 || actual.size != expected.size { return Err("published destination identity changed".into()); }
      return Ok(delivery.clone());
    }
    if delivery.state != "published" && delivery.state != "verified" && delivery.state != "publishing" { return Err("export intent is not verified or was cancelled".into()); }
    let expected = delivery.identity.as_ref().ok_or("verified export has no artifact identity")?;
    let staged = Path::new(&delivery.stage_path);
    if staged.exists() {
      delivery.execution_deadline_ms(now_ms())?;
      if actual.sha256 != expected.sha256 || actual.size != expected.size { return Err("staged export changed after verification".into()); }
      let mut publishing = delivery.clone();
      publishing.state = "publishing".into();
      persist_delivery(root, &publishing)?;
      delivery.state = "publishing".into();
      if let Err(error) = std::fs::rename(staged, &delivery.dest_path) {
        let mut retryable = delivery.clone();
        retryable.state = "verified".into();
        persist_delivery(root, &retryable)?;
        *delivery = retryable;
        return Err(error.to_string());
      }
    } else {
      if actual.sha256 != expected.sha256 || actual.size != expected.size { return Err("destination is not the verified export artifact".into()); }
    }
    let mut published = delivery.clone();
    published.state = "published".into();
    persist_delivery(root, &published)?;
    *delivery = published;
    self.workspace.release_root(&Self::workspace_key(Path::new(&delivery.stage_path)));
    Ok(delivery.clone())
  }

  pub fn cancel_delivery(&self, id: &str) -> Result<bool, String> {
    let root = self.journal()?;
    let pending_publication = self.deliveries.lock().map_err(|error| error.to_string())?.get(id)
      .is_some_and(|entry| entry.state == "publishing" && !Path::new(&entry.stage_path).exists());
    if pending_publication { self.publish_delivery(id)?; return Ok(false); }
    let mut deliveries = self.deliveries.lock().map_err(|error| error.to_string())?;
    let Some(delivery) = deliveries.get_mut(id) else { return Ok(false) };
    if delivery.state == "published" || delivery.state == "cancelled" { return Ok(false); }
    let mut next = delivery.clone();
    next.state = "cancelled".into();
    persist_delivery(root, &next)?;
    *delivery = next;
    let queued_copy = matches!(delivery.source, DeliverySource::Copy { .. }) &&
      self.lock().jobs.get(id).is_some_and(|job| job.state == JobState::Queued);
    drop(deliveries);
    if queued_copy { self.finish_copy_job(id); }
    Ok(true)
  }

  pub fn delivery_list(&self) -> Vec<ExportDelivery> {
    self.deliveries.lock().unwrap_or_else(|error| error.into_inner()).values().cloned().collect()
  }

  pub fn with_unleased_path<T>(&self, path: &Path, operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    self.with_unleased_paths(&[path], operation)
  }

  pub fn with_unleased_paths<T>(&self, paths: &[&Path], operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    self.infrastructure.validate_namespaces()?;
    if paths.is_empty() { return Err("filesystem mutation has no admitted paths".into()); }
    let deliveries = self.deliveries.lock().map_err(|error| error.to_string())?;
    for path in paths { self.require_unleased_path(path, deliveries.values(), PathLeaseOperation::Mutation)?; }
    operation()
  }

  fn require_unleased_path<'a>(&self, path: &Path, deliveries: impl Iterator<Item = &'a ExportDelivery>,
    operation: PathLeaseOperation<'_>) -> Result<(), String> {
    let key = export_path_key;
    let dependency_path = canonical_export_path;
    let canonical = self.infrastructure.authorize_path(path, operation)?;
    let target = key(&canonical);
    let destination_owner = match operation {
      PathLeaseOperation::Mutation | PathLeaseOperation::RenderScratch(_) => None,
      PathLeaseOperation::ExportDestination(owner) => {
        if key(&dependency_path(Path::new(&owner.dest_path))?) != target {
          return Err("export destination operation does not match its admitted owner".into());
        }
        Some(owner.id.as_str())
      }
    };
    let prefix = format!("{}/", target.trim_end_matches('/'));
    let target_file = if canonical.is_file() {
      Some(same_file::Handle::from_path(&canonical).map_err(|error| error.to_string())?)
    } else { None };
    let state = self.lock();
    for delivery in deliveries {
      let running = state.jobs.get(&delivery.id).is_some_and(|job| job.state != JobState::Exited);
      let pending = delivery.state != "published" && !delivery.followups_done;
      if !pending && !running { continue; }
      let stage_owned = matches!(delivery.state.as_str(), "prepared" | "verified" | "publishing") || running ||
        self.copying.lock().map_err(|error| error.to_string())?.contains(&delivery.id);
      let declared: Vec<&str> = match &delivery.source {
        DeliverySource::Render { paths } => paths.iter().map(String::as_str).collect(),
        DeliverySource::Copy { path, .. } => vec![path.as_str()],
      };
      let staged = delivery.render_scratch.as_ref().map(|scratch| scratch.files.iter()
        .map(|(relative, _)| Path::new(&scratch.path).join(relative).to_string_lossy().into_owned()).collect::<Vec<_>>()).unwrap_or_default();
      for dependency in declared.into_iter().chain(delivery.sources.iter().map(|(path, _)| path.as_str()))
        .chain(staged.iter().map(String::as_str)).chain(delivery.copy_scratch.as_deref())
        .chain(stage_owned.then_some(delivery.stage_path.as_str()))
        .chain((stage_owned && destination_owner != Some(delivery.id.as_str())).then_some(delivery.dest_path.as_str())) {
        let dependency = dependency_path(Path::new(dependency))?;
        if let Some(target_file) = &target_file {
          match same_file::Handle::from_path(&dependency) {
            Ok(source_file) if *target_file == source_file => return Err("file is leased by an active export through another path".into()),
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
          }
        }
        let dependency = key(&dependency);
        if dependency == target || dependency.starts_with(&prefix) { return Err("path is leased by an active export".into()); }
      }
      if let Some(cwd) = delivery.render_scratch.as_ref().map(|scratch| &scratch.path)
        .or_else(|| delivery.render_job.as_ref().and_then(|job| job.cwd.as_ref())) {
        if let Ok(cwd) = Path::new(cwd).canonicalize() {
          let cwd = key(&cwd);
          if cwd == target || cwd.starts_with(&prefix) || target.starts_with(&format!("{}/", cwd.trim_end_matches('/'))) {
            return Err("scratch is leased by an active export".into());
          }
        }
      }
    }
    Ok(())
  }

  pub fn fail_delivery(&self, id: &str) -> Result<bool, String> {
    let root = self.journal()?;
    let mut deliveries = self.deliveries.lock().map_err(|error| error.to_string())?;
    let Some(delivery) = deliveries.get_mut(id) else { return Ok(false) };
    if delivery.state == "published" || delivery.state == "cancelled" || delivery.state == "publishing" { return Ok(false); }
    let mut next = delivery.clone();
    next.state = "failed".into();
    persist_delivery(root, &next)?;
    *delivery = next;
    let queued_copy = matches!(delivery.source, DeliverySource::Copy { .. }) &&
      self.lock().jobs.get(id).is_some_and(|job| job.state == JobState::Queued);
    drop(deliveries);
    if queued_copy { self.finish_copy_job(id); }
    Ok(true)
  }

  fn retain_render_job(&self, spec: &JobSpec) -> Result<(), String> {
    let mut entries = self.deliveries.lock().map_err(|error| error.to_string())?;
    if !entries.contains_key(&spec.id) && spec.lane != "export" && spec.meta.get("kind").and_then(|value| value.as_str()) != Some("export") { return Ok(()); }
    self.account_workspace(&entries)?;
    let current = entries.get_mut(&spec.id);
    let root = self.journal()?;
    let current = current.ok_or("export job has no admitted delivery intent")?;
    if !matches!(&current.source, DeliverySource::Render { .. }) { return Err("copy intent cannot admit a render worker".into()); }
    if spec.program != "ffmpeg" { return Err("export intent requires the admitted render backend".into()); }
    if spec.lane != "export" { return Err("admitted render work must use the shared export lane".into()); }
    let delivery = self.record_execution_clock(current, false)?;
    drop(entries);
    self.validate_render_scratch(&delivery, spec.cwd.as_deref())?;
    let before = serde_json::to_vec(&delivery).map_err(|error| error.to_string())?;
    let check = || -> Result<(), String> {
      let entries = self.deliveries.lock().map_err(|error| error.to_string())?;
      let current = entries.get(&spec.id).ok_or("export intent disappeared during dependency checks")?;
      if current.state != "prepared" || current.producer_complete {
        return Err("export was cancelled or superseded during dependency checks".into());
      }
      current.execution_deadline_ms(now_ms())?;
      Ok(())
    };
    check()?;
    let worker = self.spawner.identity(&spec.program)?;
    check()?;
    let mut paths = Vec::new();
    if let DeliverySource::Render { paths: declared } = &delivery.source { paths.extend(declared.iter().cloned()); }
    if let Some(sources) = spec.meta.pointer("/plan/sources").and_then(|value| value.as_array()) {
      for source in sources {
        if let Some(path) = source.get("path").and_then(|value| value.as_str()) { paths.push(path.to_string()); }
      }
    }
    let audio = stream::audio_producer(spec)?;
    for command in std::iter::once(&spec.args).chain(spec.steps.iter()).chain(audio.iter().map(|audio| &audio.args)) {
      for pair in command.windows(2) {
        if pair[0] == "-i" && Path::new(&pair[1]).is_file() { paths.push(pair[1].clone()); }
      }
    }
    if delivery.render_job.is_none() {
      if let Some(cwd) = &spec.cwd { collect_render_dependencies(Path::new(cwd), &mut paths)?; }
    }
    paths.sort(); paths.dedup();
    let mut next = delivery;
    let first_binding = next.render_job.is_none();
    let command_sha256 = format!("{:x}", Sha256::digest(serde_json::to_vec(spec).map_err(|error| error.to_string())?));
    if first_binding {
      next.sources = paths.into_iter().map(|path| self.spawner.dependency_identity(Path::new(&path), &check)
        .map(|identity| (path, identity))).collect::<Result<Vec<_>, _>>()?;
      next.render_job = Some(spec.clone());
      next.command_sha256 = Some(command_sha256);
      next.worker_identity = Some(worker);
    } else {
      if next.command_sha256.as_deref() != Some(command_sha256.as_str()) { return Err("retained export command identity changed; recovery refused".into()); }
      let expected_worker = next.worker_identity.as_ref().ok_or("retained export has no supported worker identity; recovery refused")?;
      if worker.sha256 != expected_worker.sha256 || worker.size != expected_worker.size {
        return Err("export worker identity changed; recovery refused".into());
      }
      for (path, expected) in &next.sources {
        let actual = self.spawner.dependency_identity(Path::new(path), &check)?;
        if actual.sha256 != expected.sha256 || actual.size != expected.size { return Err("export source changed; recovery refused".into()); }
      }
    }
    check()?;
    let mut deliveries = self.deliveries.lock().map_err(|error| error.to_string())?;
    let current = deliveries.get(&spec.id).ok_or("export intent disappeared before dependency binding")?;
    if serde_json::to_vec(current).map_err(|error| error.to_string())? != before {
      return Err("export intent changed before dependency binding; retry refused".into());
    }
    current.execution_deadline_ms(now_ms())?;
    self.require_unleased_path(Path::new(&next.dest_path), deliveries.values().chain(std::iter::once(&next)),
      PathLeaseOperation::ExportDestination(&next))?;
    if first_binding {
      persist_delivery(root, &next)?;
      deliveries.insert(spec.id.clone(), next);
    }
    Ok(())
  }

  pub fn recover_exports(&self) -> Vec<(String, String)> {
    let mut failures = Vec::new();
    let recoverable = self.delivery_list();
    for delivery in recoverable {
      if delivery.followups_done { continue; }
      if delivery.state == "cancelled" {
        if !self.lock().jobs.get(&delivery.id).is_some_and(|job| job.state != JobState::Exited) &&
            !self.copying.lock().unwrap_or_else(|error| error.into_inner()).contains(&delivery.id) {
          if let Err(error) = self.complete_delivery(&delivery.id) { failures.push((delivery.id, error)); }
        }
        continue;
      }
      if delivery.has_unconfirmed_initial_entry() {
        failures.push((delivery.id, "export was interrupted before initial entry ownership was confirmed; existing entries are retained without adoption or deletion".into()));
        continue;
      }
      if delivery.state == "verified" || delivery.state == "publishing" {
        if let Err(error) = self.publish_delivery(&delivery.id) { failures.push((delivery.id, error)); }
        else { self.restore_delivery_view(&delivery); }
        continue;
      }
      if delivery.state == "published" {
        self.restore_delivery_view(&delivery);
        continue;
      }
      if delivery.state != "prepared" { continue; }
      if delivery.producer_complete && matches!(delivery.source, DeliverySource::Render { .. }) {
        self.restore_delivery_view(&delivery);
        continue;
      }
      if delivery.recovery_attempts < 1 && matches!(delivery.source, DeliverySource::Copy { .. }) {
        if let Err(error) = self.transition_execution_clock(&delivery.id, false) { failures.push((delivery.id, error)); continue; }
      }
      if let DeliverySource::Copy { path, .. } = &delivery.source {
        let recovered = (|| -> Result<(), String> {
          if delivery.recovery_attempts >= 1 { return Err("automatic copy recovery budget exhausted".into()); }
          let expected = delivery.sources.first().ok_or("copy export has no source fingerprint")?;
          let actual = artifact_identity(Path::new(path))?;
          if actual.sha256 != expected.1.sha256 || actual.size != expected.1.size { return Err("copy source changed; recovery refused".into()); }
          let root = self.journal()?;
          {
            let mut entries = self.deliveries.lock().map_err(|error| error.to_string())?;
            let entry = entries.get_mut(&delivery.id).ok_or("copy intent missing")?;
            let mut next = entry.clone(); next.recovery_attempts += 1;
            persist_delivery(root, &next)?; *entry = next;
          }
          self.copy_delivery(&delivery.id)?;
          self.verify_delivery(&delivery.id)?;
          self.publish_delivery(&delivery.id)?;
          self.restore_delivery_view(&delivery);
          Ok(())
        })();
        if let Err(error) = recovered { failures.push((delivery.id, error)); }
        continue;
      }
      let Some(spec) = delivery.render_job.clone() else {
        failures.push((delivery.id, "export was interrupted before its render plan was retained; export again".into()));
        continue;
      };
      if delivery.recovery_attempts >= 1 { failures.push((delivery.id, "automatic recovery attempt budget exhausted".into())); continue; }
      if let Err(error) = self.retain_render_job(&spec) { failures.push((delivery.id, error)); continue; }
      let retained = (|| -> Result<(), String> {
        let root = self.journal()?;
        let mut deliveries = self.deliveries.lock().map_err(|error| error.to_string())?;
        let entry = deliveries.get_mut(&delivery.id).ok_or("missing export intent")?;
        let mut next = entry.clone(); next.recovery_attempts += 1;
        persist_delivery(root, &next)?; *entry = next;
        Ok(())
      })();
      if let Err(error) = retained { failures.push((delivery.id, error)); continue; }
      if let Err(error) = self.submit(spec) { failures.push((delivery.id, error)); }
    }
    for (id, error) in &failures { self.restore_recovery_failure(id, error); }
    failures
  }

  fn restore_finished_export(&self, spec: JobSpec, queued_at: u64) {
    let mut state = self.lock();
    if state.jobs.contains_key(&spec.id) { return; }
    state.order.push(spec.id.clone());
    state.jobs.insert(spec.id.clone(), Job { spec, state: JobState::Exited, pid: None, step: 0, code: Some(0),
      kill_requested: false, committed: false, stdout: String::new(), stderr_head: String::new(), stderr_elided: 0,
      stderr: String::new(), queued_at, started_at: None, ended_at: Some(now_ms()) });
  }

  fn restore_delivery_view(&self, delivery: &ExportDelivery) {
    self.restore_finished_export(Self::delivery_job_spec(delivery), delivery.created_at);
  }

  fn restore_recovery_failure(&self, id: &str, error: &str) {
    let Some(delivery) = self.deliveries.lock().unwrap_or_else(|error| error.into_inner()).get(id).cloned() else { return };
    self.restore_delivery_view(&delivery);
    let view = {
      let mut state = self.lock();
      let Some(job) = state.jobs.get_mut(id) else { return };
      if job.state == JobState::Exited && !delivery.producer_complete { job.code = Some(-1); }
      push_stderr(job, error);
      job.view()
    };
    (self.notify)(Notice::Changed(view));
  }

  fn delivery_job_spec(delivery: &ExportDelivery) -> JobSpec {
    let filename = Path::new(&delivery.dest_path).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let mut spec = delivery.render_job.clone().unwrap_or_else(|| JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: Vec::new(), steps: Vec::new(), cwd: None, meta: serde_json::json!({}) });
    if !spec.meta.is_object() { spec.meta = serde_json::json!({}); }
    let meta = spec.meta.as_object_mut().expect("job metadata normalized to an object");
    meta.insert("kind".into(), serde_json::json!("export"));
    meta.insert("projectDir".into(), serde_json::json!(delivery.project_dir));
    meta.insert("destPath".into(), serde_json::json!(delivery.dest_path));
    meta.insert("stagePath".into(), serde_json::json!(delivery.stage_path));
    meta.insert("filename".into(), serde_json::json!(filename));
    meta.entry("startedBy").or_insert(serde_json::json!("elsewhere"));
    meta.entry("submittedAt").or_insert(serde_json::json!(delivery.created_at));
    if let DeliverySource::Copy { media_ref, .. } = &delivery.source {
      meta.insert("kind".into(), serde_json::json!("export_copy"));
      meta.insert("copyOf".into(), serde_json::json!(media_ref));
    }
    spec
  }

  fn retain_copy_job(&self, delivery: &ExportDelivery, phase: JobState) -> Result<JobView, String> {
    if !matches!(delivery.source, DeliverySource::Copy { .. }) { return Err("copy job requires an admitted library source".into()); }
    let spec = Self::delivery_job_spec(delivery);
    let view = {
      let mut state = self.lock();
      if !state.jobs.contains_key(&delivery.id) { state.order.push(delivery.id.clone()); }
      state.jobs.insert(delivery.id.clone(), Job { spec, state: phase, pid: None, step: 0, code: None,
        kill_requested: false, committed: false, stdout: String::new(), stderr_head: String::new(), stderr_elided: 0,
        stderr: String::new(), queued_at: delivery.created_at, started_at: (phase == JobState::Running).then(now_ms), ended_at: None });
      state.jobs[&delivery.id].view()
    };
    Ok(view)
  }

  fn finish_copy_job(&self, id: &str) {
    let (complete, cancelled) = {
      let deliveries = self.deliveries.lock().unwrap_or_else(|error| error.into_inner());
      deliveries.get(id).map(|delivery| (delivery.producer_complete && delivery.state != "cancelled" && delivery.state != "failed",
        delivery.state == "cancelled")).unwrap_or((false, false))
    };
    let view = {
      let mut state = self.lock();
      let Some(job) = state.jobs.get_mut(id) else { return };
      job.state = JobState::Exited;
      job.kill_requested |= cancelled;
      job.code = Some(if complete && !job.kill_requested { 0 } else { -1 });
      job.ended_at = Some(now_ms());
      job.view()
    };
    (self.notify)(Notice::Changed(view));
  }

  pub fn complete_delivery(&self, id: &str) -> Result<bool, String> {
    let root = self.journal()?;
    let mut entries = self.deliveries.lock().map_err(|error| error.to_string())?;
    let Some(entry) = entries.get_mut(id) else { return Ok(false) };
    root.validate_delivery(entry)?;
    if self.copying.lock().map_err(|error| error.to_string())?.contains(id) {
      return Err("running copy dependencies cannot be released".into());
    }
    if self.lock().jobs.get(id).is_some_and(|job| job.state != JobState::Exited) {
      return Err("running export dependencies cannot be released".into());
    }
    if !["published", "cancelled", "failed"].contains(&entry.state.as_str()) { return Err("active export cannot be retired".into()); }
    if let Some(scratch) = &entry.render_scratch {
      ExportDelivery::check_unconfirmed_cleanup(Path::new(&scratch.path), scratch.ownership)?;
      if self.export_work_root.is_none() { return Err("render work root is unavailable for cleanup".into()); }
    }
    if entry.state != "published" { ExportDelivery::check_unconfirmed_cleanup(Path::new(&entry.stage_path), entry.stage_ownership)?; }
    if let (Some(work_root), Some(cwd)) = (&self.export_work_root, entry.render_scratch.as_ref().map(|scratch| &scratch.path)
      .or_else(|| entry.render_job.as_ref().and_then(|spec| spec.cwd.as_ref()))) {
      let key = Self::workspace_key(Path::new(cwd));
      match std::fs::symlink_metadata(cwd) {
        Ok(metadata) => {
          if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err("render scratch cleanup requires an owned regular directory".into()); }
          let work = work_root.canonicalize().map_err(|error| error.to_string())?;
          let scratch = Path::new(cwd).canonicalize().map_err(|error| error.to_string())?;
          if !scratch.starts_with(&work) || scratch == work { return Err("render scratch cleanup is outside its admitted work root".into()); }
          std::fs::remove_dir_all(scratch).map_err(|error| error.to_string())?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
          let parent = Path::new(cwd).parent().ok_or("render scratch has no cleanup parent")?;
          if !std::fs::metadata(parent).map_err(|error| error.to_string())?.is_dir() {
            return Err("render scratch cleanup parent is unavailable".into());
          }
        }
        Err(error) => return Err(error.to_string()),
      }
      self.workspace.release_root(&key);
    }
    let stage_key = Self::workspace_key(Path::new(&entry.stage_path));
    for path in entry.copy_scratch_path()?.into_iter().chain((entry.state != "published").then_some(Path::new(&entry.stage_path))) {
      if let Err(error) = std::fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound { return Err(error.to_string()); }
      }
    }
    self.workspace.release_root(&stage_key);
    let mut next = entry.clone(); next.followups_done = true;
    next.render_scratch = None;
    next.copy_scratch = None;
    next.render_job = None;
    next.sources.clear();
    if let DeliverySource::Render { paths } = &mut next.source { paths.clear(); }
    persist_delivery(root, &next)?; *entry = next;
    let mut terminal: Vec<(u64, String)> = entries.values().filter(|entry| entry.followups_done).map(|entry| (entry.created_at, entry.id.clone())).collect();
    terminal.sort();
    let remove_count = terminal.len().saturating_sub(50);
    for (_, old_id) in terminal.into_iter().take(remove_count) {
      remove_delivery_receipt(root, &old_id)?;
      entries.remove(&old_id);
    }
    Ok(true)
  }

  pub fn copy_delivery(&self, id: &str) -> Result<(), String> {
    self.copy_delivery_after_sync(id, || Ok(()))
  }

  fn copy_delivery_after_sync(&self, id: &str, before_completion_record: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let pending = self.deliveries.lock().map_err(|error| error.to_string())?.get(id)
      .is_some_and(|entry| matches!(entry.source, DeliverySource::Copy { .. }) && entry.state == "prepared" && !entry.producer_complete);
    let _capacity = if pending { Some(self.claim_export_output(id)?) } else { None };
    let (delivery, view) = {
      let mut entries = self.deliveries.lock().map_err(|error| error.to_string())?;
      self.account_workspace(&entries)?;
      let entry = entries.get_mut(id).ok_or("unknown copy intent")?;
      if !matches!(entry.source, DeliverySource::Copy { .. }) { return Err("render intent cannot use the copy executor".into()); }
      if entry.state == "cancelled" || entry.state == "failed" { return Err("copy intent was cancelled or failed".into()); }
      let mut copying = self.copying.lock().map_err(|error| error.to_string())?;
      if copying.contains(id) || self.lock().jobs.get(id).is_some_and(|job| job.state == JobState::Running) {
        drop(entries);
        while copying.contains(id) || self.lock().jobs.get(id).is_some_and(|job| job.state == JobState::Running) {
          copying = self.copy_settled.wait(copying).map_err(|error| error.to_string())?;
        }
        drop(copying);
        let entries = self.deliveries.lock().map_err(|error| error.to_string())?;
        let entry = entries.get(id).ok_or("copy intent vanished while waiting")?;
        if entry.state == "cancelled" || entry.state == "failed" { return Err("copy intent was cancelled or failed".into()); }
        return self.require_completed_producer(entry);
      }
      if entry.producer_complete { drop(copying); return self.require_completed_producer(entry); }
      if entry.state != "prepared" { return Err("copy intent was already settled".into()); }
      self.record_execution_clock(entry, false)?;
      copying.insert(id.to_string());
      (entry.clone(), self.retain_copy_job(entry, JobState::Running)?)
    };
    struct CopyGuard<'a>(&'a Supervisor, String);
    impl Drop for CopyGuard<'_> {
      fn drop(&mut self) {
        self.0.copying.lock().unwrap_or_else(|error| error.into_inner()).remove(&self.1);
        self.0.finish_copy_job(&self.1);
        self.0.finish_output_claim(&self.1);
        self.0.copy_settled.notify_all();
      }
    }
    let _guard = CopyGuard(self, id.to_string());
    (self.notify)(Notice::Changed(view));
    let result = self.write_copy_artifact(&delivery, before_completion_record);
    if let Err(error) = &result {
      if let Some(job) = self.lock().jobs.get_mut(id) { push_stderr(job, error); }
    }
    result
  }

  fn begin_copy_output(&self, delivery: &ExportDelivery, expected_bytes: u64) -> Result<ScratchOutput, String> {
    let root = self.journal()?;
    let mut entries = self.deliveries.lock().map_err(|error| error.to_string())?;
    self.account_workspace(&entries)?;
    let current = entries.get_mut(&delivery.id).ok_or("copy intent vanished before output preparation")?;
    root.validate_delivery(current)?;
    if current.state != "prepared" || current.producer_complete || !matches!(current.source, DeliverySource::Copy { .. }) ||
      !self.copying.lock().map_err(|error| error.to_string())?.contains(&delivery.id) {
      return Err("copy output has no active admitted producer".into());
    }
    current.execution_deadline_ms(now_ms())?;
    let key = Self::workspace_key(Path::new(&current.stage_path));
    if let Some(path) = current.copy_scratch_path()? {
      let previous = match std::fs::metadata(path) {
        Ok(metadata) => Some(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.to_string()),
      };
      if let Some(previous) = previous {
        std::fs::remove_file(path).map_err(|error| error.to_string())?;
        self.workspace.release(&key, previous, 1);
      }
    }
    let previous = std::fs::metadata(&current.stage_path).map(|metadata| metadata.len()).unwrap_or(0);
    if previous > 0 {
      std::fs::remove_file(&current.stage_path).map_err(|error| error.to_string())?;
      self.workspace.release(&key, previous, 1);
    }
    let mut prepared = current.clone();
    let temporary = Path::new(&current.stage_path).with_file_name(format!("{}pending", current.copy_scratch_prefix()));
    match std::fs::symlink_metadata(&temporary) {
      Ok(_) => return Err("copy temporary namespace is already occupied".into()),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
      Err(error) => return Err(error.to_string()),
    }
    prepared.copy_scratch = Some(temporary.to_string_lossy().into_owned());
    persist_delivery(root, &prepared)?;
    *current = prepared;
    ScratchOutput::open(Path::new(&current.stage_path), 0, expected_bytes, self.workspace.clone(), &key, Some(&temporary))
  }

  fn write_copy_artifact(&self, delivery: &ExportDelivery, before_completion_record: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
    let id = &delivery.id;
    let root = self.journal()?;
    let DeliverySource::Copy { path, .. } = &delivery.source else { return Err("copy source unavailable".into()) };
    let expected = delivery.sources.first().ok_or("copy source has no identity")?;
    let check = || delivery.execution_deadline_ms(now_ms()).map(|_| ());
    let actual = artifact_identity_checked(Path::new(path), &check)?;
    if actual.sha256 != expected.1.sha256 || actual.size != expected.1.size { return Err("copy source changed before execution".into()); }
    let mut source = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut destination = self.begin_copy_output(delivery, expected.1.size)?;
    let mut buffer = vec![0u8; 1024 * 1024];
    let copied = (|| -> Result<(), String> {
      loop {
        check()?;
        if self.deliveries.lock().map_err(|error| error.to_string())?.get(id).is_none_or(|entry| entry.state != "prepared") {
          return Err("copy export cancelled".into());
        }
        let count = source.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 { return Ok(()) }
        destination.write(&buffer[..count])?;
      }
    })();
    if let Err(error) = copied { return Err(destination.abort(error)); }
    let mut entries = match self.deliveries.lock() {
      Ok(entries) => entries,
      Err(error) => return Err(destination.abort(error.to_string())),
    };
    let Some(entry) = entries.get_mut(id) else { return Err(destination.abort("copy intent vanished before completion".into())) };
    if entry.state != "prepared" { return Err(destination.abort("copy was cancelled before completion".into())); }
    if let Err(error) = entry.execution_deadline_ms(now_ms()) { return Err(destination.abort(error)); }
    destination.finish(Some(0))?;
    before_completion_record()?;
    let mut next = entry.clone();
    next.producer_complete = true;
    next.copy_scratch = None;
    persist_delivery(root, &next)?;
    *entry = next;
    Ok(())
  }

  /// Identifies this run of the app: the same for every page it shows, different after a restart.
  pub fn launch_id(&self) -> String {
    self.launch_id.to_string()
  }

  // A poisoned lock must never stop exports: the state is plain data and stays consistent.
  fn lock(&self) -> MutexGuard<'_, State> {
    self.state.lock().unwrap_or_else(|e| e.into_inner())
  }

  /// Queue a job on its lane; it starts once nothing else in the lane runs. Returns how many
  /// jobs are ahead of it.
  pub fn submit(&self, spec: JobSpec) -> Result<usize, String> {
    if !spec.meta.is_object() { return Err("native job metadata must be an object".into()); }
    if spec.meta.as_object().is_some_and(|meta| meta.keys().any(|key| key.starts_with("_native_"))) {
      return Err("native execution metadata is reserved".into());
    }
    if let Some(transport) = spec.meta.get("renderTransport") {
      if transport.as_str() != Some("partition-pipes-v1") || spec.lane != "export" || spec.program != "ffmpeg" || spec.steps.is_empty() {
        return Err("unsupported native export stream contract".into());
      }
    }
    stream::audio_producer(&spec)?;
    if !SIDECARS.iter().any(|(name, _)| *name == spec.program) {
      return Err(format!("'{}' cannot be run as a job", spec.program));
    }
    if !spec.steps.is_empty() && spec.program != "ffmpeg" {
      return Err("only ffmpeg jobs may run a render sequence".into());
    }
    if spec.id.is_empty() || spec.lane.is_empty() {
      return Err("a job needs an id and a lane".into());
    }
    self.retain_render_job(&spec)?;
    self.transition_execution_clock(&spec.id, true)?;
    let lane = spec.lane.clone();
    let (position, view) = {
      let mut st = self.lock();
      if st.jobs.contains_key(&spec.id) {
        return Err(format!("job {} already exists", spec.id));
      }
      let l = st.lanes.entry(lane.clone()).or_default();
      let position = l.queue.len() + usize::from(l.running.is_some());
      l.queue.push_back(spec.id.clone());
      let job = Job {
        spec,
        state: JobState::Queued,
        pid: None,
        step: 0,
        code: None,
        kill_requested: false,
        committed: false,
        stdout: String::new(),
        stderr_head: String::new(),
        stderr_elided: 0,
        stderr: String::new(),
        queued_at: now_ms(),
        started_at: None,
        ended_at: None,
      };
      let view = job.view();
      st.order.push(job.spec.id.clone());
      st.jobs.insert(job.spec.id.clone(), job);
      (position, view)
    };
    (self.notify)(Notice::Changed(view));
    self.pump(&lane);
    Ok(position)
  }

  /// Start the lane's next job if nothing in it runs. Never spawns or notifies under the lock:
  /// a process can exit, and its event re-enter here, before `spawn` has even returned.
  fn pump(&self, lane: &str) {
    let (spec, view) = {
      let mut st = self.lock();
      let Some(l) = st.lanes.get_mut(lane) else { return };
      if l.running.is_some() {
        return;
      }
      let Some(id) = l.queue.pop_front() else { return };
      l.running = Some(id.clone());
      let Some(job) = st.jobs.get_mut(&id) else { return };
      job.state = JobState::Running;
      job.started_at = Some(now_ms());
      (job.spec.clone(), job.view())
    };
    (self.notify)(Notice::Changed(view));
    self.start_step(&spec.id);
  }

  fn start_step(&self, job_id: &str) {
    let (mut spec, step, cancelled) = {
      let st = self.lock();
      let Some(job) = st.jobs.get(job_id) else { return };
      if job.state != JobState::Running {
        return;
      }
      (job.spec.clone(), job.step, job.kill_requested)
    };
    if cancelled {
      self.finish(&spec.id, step, None, None);
      return;
    }
    let dependency_spec = spec.clone();
    if !spec.steps.is_empty() {
      (self.notify)(Notice::Stdout {
        id: spec.id.clone(),
        chunk: format!("artdaddy_step={step}\n"),
      });
    }
    if step > 0 {
      spec.args = spec.steps[step - 1].clone();
    }
    if !is_streamed(&spec) { spec.steps.clear(); }
    let cancelled = self.lock().jobs.get(&spec.id)
      .is_none_or(|job| job.kill_requested || job.state != JobState::Running || job.step != step);
    if cancelled {
      self.finish(&spec.id, step, None, None);
      return;
    }
    let admitted_render = self.deliveries.lock().unwrap_or_else(|error| error.into_inner()).get(&spec.id)
      .is_some_and(|delivery| matches!(delivery.source, DeliverySource::Render { .. }));
    let output_claim = if admitted_render {
      match self.transition_execution_clock(&spec.id, true).and_then(|_| self.claim_export_output(&spec.id)) {
        Ok(claim) => Some(claim),
        Err(error) => { self.finish(&spec.id, step, Some(-1), Some(error)); return; }
      }
    } else { None };
    if let Err(error) = self.retain_render_job(&dependency_spec) {
      self.finish(&spec.id, step, Some(-1), Some(error));
      return;
    }
    let delivery = self.deliveries.lock().unwrap_or_else(|error| error.into_inner()).get(&spec.id).cloned();
    if let Some(delivery) = delivery {
      match delivery.execution_deadline_ms(now_ms()) {
        Ok(deadline) => { spec.meta["_native_execution_deadline"] = serde_json::json!(deadline); }
        Err(error) => { self.finish(&spec.id, step, Some(-1), Some(error)); return; }
      }
      if matches!(&delivery.source, DeliverySource::Render { .. }) {
        if let (Some(cwd), Some(work_root)) = (&spec.cwd, &self.export_work_root) {
          let valid = Path::new(cwd).canonicalize().ok().zip(work_root.canonicalize().ok())
            .is_some_and(|(scratch, work)| scratch.starts_with(&work) && scratch != work);
          if !valid { self.finish(&spec.id, step, Some(-1), Some("export scratch is outside its owned work root".into())); return; }
        }
        if is_streamed(&spec) {
          spec.meta["_native_final_stage"] = serde_json::json!(delivery.stage_path);
          for (index, args) in std::iter::once(&spec.args).chain(spec.steps.iter()).enumerate() {
            let mut command = spec.clone();
            command.args = args.clone();
            command.steps.clear();
            if let Err(error) = scratch_capture(&command, &delivery.stage_path, index == spec.steps.len()) {
              self.finish(&spec.id, step, Some(-1), Some(error)); return;
            }
          }
          let audio = match stream::audio_producer(&spec) {
            Ok(audio) => audio,
            Err(error) => { self.finish(&spec.id, step, Some(-1), Some(error)); return; }
          };
          if let Some(audio) = audio {
            let mut command = spec.clone();
            command.args = audio.args;
            command.steps.clear();
            if let Err(error) = scratch_capture(&command, &delivery.stage_path, false) {
              self.finish(&spec.id, step, Some(-1), Some(error)); return;
            }
          }
        } else {
          match scratch_capture(&spec, &delivery.stage_path, step == dependency_spec.steps.len()) {
            Ok(Some(capture)) => { spec.meta["_native_scratch_capture"] = capture; }
            Ok(None) => { spec.meta["_native_final_stage"] = serde_json::json!(delivery.stage_path); }
            Err(error) => { self.finish(&spec.id, step, Some(-1), Some(error)); return; }
          }
        }
      }
    }
    if spec.program == "ffmpeg" && spec.meta.get("_native_execution_deadline").is_none() {
      spec.meta["_native_execution_deadline"] = serde_json::json!(now_ms().saturating_add(EXPORT_EXECUTION_LIMIT_MS));
    }
    let me = self.clone();
    let id = spec.id.clone();
    let on_event: Arc<dyn Fn(ProcEvent) + Send + Sync> = Arc::new(move |ev| me.on_event(&id, step, ev));
    if let Some(output_claim) = output_claim { output_claim.retain(); }
    let started = if is_streamed(&spec) {
      let owner = self.clone();
      let retained = dependency_spec;
      let guard: stream::StartGuard = Arc::new(move || {
        owner.retain_render_job(&retained)?;
        let state = owner.lock();
        if state.jobs.get(&retained.id).is_none_or(|job| job.kill_requested || job.state != JobState::Running || job.step != step) {
          return Err("streaming export was cancelled or superseded".into());
        }
        Ok(())
      });
      self.spawner.spawn_stream(&spec, on_event, guard, self.workspace.clone())
    } else { self.spawner.spawn(&spec, on_event, self.workspace.clone()) };
    match started {
      Ok(pid) => {
        let kill_now = {
          let mut st = self.lock();
          match st.jobs.get_mut(&spec.id) {
            Some(job) if job.state == JobState::Running && job.step == step => {
              job.pid = Some(pid);
              job.kill_requested
            }
            _ => false, // it already exited
          }
        };
        if kill_now {
          self.spawner.kill(&spec.id, pid);
        }
      }
      Err(e) => self.finish(&spec.id, step, None, Some(format!("could not start {}: {e}", spec.program))),
    }
  }

  fn on_event(&self, id: &str, step: usize, ev: ProcEvent) {
    match ev {
      ProcEvent::Stdout(chunk) => {
        let current = {
          let mut st = self.lock();
          let Some(job) = st.jobs.get_mut(id) else { return };
          if job.state != JobState::Running || job.step != step {
            return;
          }
          push_tail(&mut job.stdout, &chunk);
          true
        };
        if current {
          (self.notify)(Notice::Stdout { id: id.to_string(), chunk });
        }
      }
      ProcEvent::Stderr(chunk) => {
        if let Some(job) = self.lock().jobs.get_mut(id) {
          if job.state == JobState::Running && job.step == step {
            push_stderr(job, &chunk);
          }
        }
      }
      ProcEvent::Exit(code) => self.finish(id, step, code, None),
    }
  }

  fn finish(&self, id: &str, step: usize, mut code: Option<i32>, mut error: Option<String>) {
    let (lane, view) = {
      let mut deliveries = self.deliveries.lock().unwrap_or_else(|error| error.into_inner());
      let mut st = self.lock();
      let Some(job) = st.jobs.get_mut(id) else { return };
      if job.state != JobState::Running || job.step != step {
        return;
      }
      if code == Some(0) && error.is_none() && !job.kill_requested && step < job.spec.steps.len() && !is_streamed(&job.spec) {
        job.step += 1;
        job.pid = None;
        job.stdout.clear();
        drop(st);
        drop(deliveries);
        self.start_step(id);
        return;
      }
      if code == Some(0) && error.is_none() && !job.kill_requested {
        if let Some(delivery) = deliveries.get_mut(id) {
          let completed = (|| -> Result<(), String> {
            if delivery.state != "prepared" || !matches!(delivery.source, DeliverySource::Render { .. }) {
              return Err("render intent was cancelled or superseded before completion".into());
            }
            let root = self.journal()?;
            delivery.execution_deadline_ms(now_ms())?;
            let mut next = delivery.clone();
            next.producer_complete = true;
            persist_delivery(root, &next)?;
            *delivery = next;
            Ok(())
          })();
          if let Err(reason) = completed { code = Some(-1); error = Some(format!("export completion was not recorded: {reason}")); }
        }
      }
      job.state = JobState::Exited;
      job.code = code;
      job.ended_at = Some(now_ms());
      if let Some(e) = error {
        push_stderr(job, &e);
      }
      if !job.spec.steps.is_empty() && code != Some(0) && !job.kill_requested {
        let failure = format!("\nrender step {} of {} failed\n", step + 1, job.spec.steps.len() + 1);
        push_stderr(job, &failure);
      }
      let lane = job.spec.lane.clone();
      let view = job.view();
      if let Some(l) = st.lanes.get_mut(&lane) {
        if l.running.as_deref() == Some(id) {
          l.running = None;
        }
      }
      (lane, view)
    };
    self.finish_output_claim(id);
    (self.notify)(Notice::Changed(view));
    self.pump(&lane);
  }

  /// Cancel a job: a queued one never starts, a running one is killed. False when the job is
  /// unknown or has already ended.
  pub fn kill(&self, id: &str) -> bool {
    if self.delivery_list().iter().any(|delivery| delivery.id == id) {
      if self.cancel_delivery(id).is_err() { return false; }
    }
    enum Act {
      Nothing,
      Dequeued(JobView),
      Running(Option<u32>),
    }
    let act = {
      let mut st = self.lock();
      let state = st.jobs.get(id).map(|j| j.state);
      match state {
        Some(JobState::Queued) => {
          let lane = st.jobs[id].spec.lane.clone();
          if let Some(l) = st.lanes.get_mut(&lane) {
            l.queue.retain(|q| q != id);
          }
          let job = st.jobs.get_mut(id).expect("present");
          job.kill_requested = true;
          job.state = JobState::Exited;
          job.ended_at = Some(now_ms());
          Act::Dequeued(job.view())
        }
        Some(JobState::Running) => {
          let job = st.jobs.get_mut(id).expect("present");
          job.kill_requested = true;
          Act::Running(job.pid)
        }
        _ => Act::Nothing,
      }
    };
    match act {
      Act::Nothing => false,
      Act::Dequeued(view) => {
        (self.notify)(Notice::Changed(view));
        true
      }
      Act::Running(pid) => {
        // No pid yet: `pump` kills it the moment it has one.
        if let Some(pid) = pid {
          self.spawner.kill(id, pid);
        }
        true
      }
    }
  }

  /// Every job this run of the app still holds, oldest first.
  pub fn list(&self) -> Vec<JobView> {
    let st = self.lock();
    st.order
      .iter()
      .filter_map(|id| st.jobs.get(id))
      .map(Job::view)
      .collect()
  }

  /// Record that a page committed the job's file. Only an ended job can be committed.
  pub fn commit(&self, id: &str) -> bool {
    let view = {
      let deliveries = self.deliveries.lock().unwrap_or_else(|error| error.into_inner());
      if deliveries.get(id).is_some_and(|delivery| !["published", "cancelled", "failed"].contains(&delivery.state.as_str())) {
        return false;
      }
      let mut st = self.lock();
      match st.jobs.get_mut(id) {
        Some(job) if job.state == JobState::Exited => {
          job.committed = true;
          job.view()
        }
        _ => return false,
      }
    };
    (self.notify)(Notice::Changed(view));
    true
  }

  /// Drop an ended job once a page has finished with it.
  pub fn forget(&self, id: &str) -> bool {
    let deliveries = self.deliveries.lock().unwrap_or_else(|error| error.into_inner());
    if deliveries.get(id).is_some_and(|delivery| !delivery.followups_done) { return false; }
    let mut st = self.lock();
    match st.jobs.get(id).map(|j| j.state) {
      Some(JobState::Exited) => {
        st.jobs.remove(id);
        st.order.retain(|o| o != id);
        true
      }
      _ => false,
    }
  }

  /// The app is exiting: nothing may keep running without it.
  pub fn kill_all(&self) {
    let ids: Vec<String> = {
      let st = self.lock();
      st.order
        .iter()
        .filter(|id| st.jobs.get(*id).is_some_and(|j| j.state != JobState::Exited))
        .cloned()
        .collect()
    };
    // Queued first, so an exiting running job cannot start the next one on its way out.
    let (queued, running): (Vec<String>, Vec<String>) = {
      let st = self.lock();
      ids
        .into_iter()
        .partition(|id| st.jobs.get(id).is_some_and(|j| j.state == JobState::Queued))
    };
    for id in queued.iter().chain(running.iter()) {
      self.kill(id);
    }
  }
}

/// The bundled sidecar file for a logical program name.
pub fn sidecar_file(program: &str) -> Option<&'static str> {
  SIDECARS.iter().find(|(name, _)| *name == program).map(|(_, file)| *file)
}

// ---- The app's glue: the shell plugin runs the processes, events reach every page ----------

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

type ShellChildren = Arc<Mutex<HashMap<(String, u32), CommandChild>>>;

fn stop_shell_child(children: &ShellChildren, key: &(String, u32)) -> Result<(), String> {
  let child = children.lock().unwrap_or_else(|error| error.into_inner()).remove(key);
  if let Some(child) = child { child.kill().map_err(|error| error.to_string())?; }
  Ok(())
}

struct ShellSpawner<R: Runtime> {
  app: AppHandle<R>,
  /// Held until each process ends: the child owns its stdin pipe, as it does for the page.
  children: ShellChildren,
  streams: stream::Registry,
}

impl<R: Runtime> Spawner for ShellSpawner<R> {
  fn identity(&self, program: &str) -> Result<ArtifactIdentity, String> {
    let file = sidecar_file(program).ok_or("unknown bundled worker")?;
    let command: std::process::Command = self.app.shell().sidecar(file).map_err(|error| error.to_string())?.into();
    artifact_identity(Path::new(command.get_program()))
  }
  fn spawn(
    &self,
    spec: &JobSpec,
    on_event: Arc<dyn Fn(ProcEvent) + Send + Sync>,
    workspace: Arc<Workspace>,
  ) -> Result<u32, String> {
    let file = sidecar_file(&spec.program)
      .ok_or_else(|| format!("'{}' is not a bundled program", spec.program))?;
    if spec.program == "ffmpeg" {
      let command: std::process::Command = self.app.shell().sidecar(file).map_err(|error| error.to_string())?.into();
      return stream::spawn_single(Path::new(command.get_program()), spec, on_event, self.streams.clone(), workspace);
    }
    if spec.meta.get("_native_scratch_capture").is_some() {
      return Err("native scratch capture requires the owned FFmpeg worker boundary".into());
    }
    let mut cmd = self
      .app
      .shell()
      .sidecar(file)
      .map_err(|e| e.to_string())?
      .args(&spec.args)
      .set_raw_out(true);
    if let Some(cwd) = spec.cwd.as_deref().filter(|c| !c.is_empty()) {
      cmd = cmd.current_dir(cwd);
    }
    let (mut rx, child) = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.pid();
    let child_key = (spec.id.clone(), pid);
    self.children.lock().unwrap_or_else(|e| e.into_inner()).insert(child_key.clone(), child);
    let children = self.children.clone();
    tauri::async_runtime::spawn(async move {
      let mut ended = false;
      while let Some(ev) = rx.recv().await {
        match ev {
          CommandEvent::Stdout(bytes) => {
            on_event(ProcEvent::Stdout(String::from_utf8_lossy(&bytes).into_owned()));
          }
          CommandEvent::Stderr(bytes) => {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            on_event(ProcEvent::Stderr(text));
          }
          CommandEvent::Error(e) => {
            on_event(ProcEvent::Stderr(format!("{e}\n")));
          }
          CommandEvent::Terminated(p) => {
            ended = true;
            children.lock().unwrap_or_else(|e| e.into_inner()).remove(&child_key);
            on_event(ProcEvent::Exit(p.code));
          }
          _ => {}
        }
      }
      // The waiter failed and no exit was reported: the job must still end, or its lane stalls.
      if !ended {
        children.lock().unwrap_or_else(|e| e.into_inner()).remove(&child_key);
        on_event(ProcEvent::Exit(None));
      }
    });
    Ok(pid)
  }

  fn spawn_stream(&self, spec: &JobSpec, on_event: Arc<dyn Fn(ProcEvent) + Send + Sync>,
    guard: stream::StartGuard, workspace: Arc<Workspace>) -> Result<u32, String> {
    let file = sidecar_file(&spec.program).ok_or("unknown bundled streaming worker")?;
    let command: std::process::Command = self.app.shell().sidecar(file).map_err(|error| error.to_string())?.into();
    stream::spawn(Path::new(command.get_program()), spec, on_event, guard, self.streams.clone(), workspace)
  }

  fn kill(&self, id: &str, pid: u32) {
    if stream::cancel(&self.streams, id, pid) { return; }
    if let Err(error) = stop_shell_child(&self.children, &(id.to_owned(), pid)) { log::warn!("jobs: could not stop owned process: {error}"); }
  }
}

#[derive(Clone, serde::Serialize)]
struct StdoutEvent {
  id: String,
  chunk: String,
}

/// Manages the supervisor and kills every job when the app exits.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
  tauri::plugin::Builder::new("jobs")
    .setup(|app, _api| {
      let emitter = app.clone();
      let notify: Arc<dyn Fn(Notice) + Send + Sync> = Arc::new(move |n| {
        let _ = match n {
          Notice::Changed(view) => emitter.emit("jobs:changed", view),
          Notice::Stdout { id, chunk } => emitter.emit("jobs:stdout", StdoutEvent { id, chunk }),
        };
      });
      let spawner = Arc::new(ShellSpawner { app: app.clone(), children: Arc::default(), streams: Arc::default() });
      let base = Supervisor::new(spawner, notify).with_export_work_root(app.path().app_cache_dir()?.join("work"))?;
      let base = if let Ok(root) = app.path().resolve("resources/fonts", tauri::path::BaseDirectory::Resource) { base.with_export_font_root(root) } else { base };
      let configured = app.path().app_local_data_dir().map_err(|error| error.to_string())
        .and_then(|path| base.clone().with_export_root(path.join("exports").join("intents-v1")));
      match configured {
        Ok(supervisor) => {
          for (id, error) in supervisor.recover_exports() { log::warn!("export recovery blocked for {id}: {error}"); }
          app.manage(supervisor);
        }
        Err(error) => { log::error!("native export journal unavailable; export admission disabled: {error}"); app.manage(base); }
      }
      Ok(())
    })
    .on_event(|app, event| {
      if let tauri::RunEvent::Exit = event {
        if let Some(jobs) = app.try_state::<Supervisor>() {
          jobs.kill_all();
        }
      }
    })
    .build()
}

async fn supervisor_work<T: Send + 'static>(supervisor: Supervisor,
  operation: impl FnOnce(Supervisor) -> Result<T, String> + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(move || operation(supervisor)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn jobs_submit(jobs: tauri::State<'_, Supervisor>, spec: JobSpec) -> Result<usize, String> {
  supervisor_work(jobs.inner().clone(), move |supervisor| supervisor.submit(spec)).await
}

#[tauri::command]
pub async fn jobs_submit_sequence(jobs: tauri::State<'_, Supervisor>, spec: JobSpec) -> Result<usize, String> {
  if spec.program != "ffmpeg" || spec.steps.is_empty() {
    return Err("a render sequence requires ffmpeg and continuation steps".into());
  }
  supervisor_work(jobs.inner().clone(), move |supervisor| supervisor.submit(spec)).await
}

#[tauri::command]
pub async fn jobs_kill(jobs: tauri::State<'_, Supervisor>, id: String) -> Result<bool, String> {
  supervisor_work(jobs.inner().clone(), move |supervisor| Ok(supervisor.kill(&id))).await
}

#[tauri::command]
pub async fn jobs_list(jobs: tauri::State<'_, Supervisor>) -> Result<Vec<JobView>, String> {
  supervisor_work(jobs.inner().clone(), |supervisor| Ok(supervisor.list())).await
}

#[tauri::command]
pub async fn jobs_commit(jobs: tauri::State<'_, Supervisor>, id: String) -> Result<bool, String> {
  supervisor_work(jobs.inner().clone(), move |supervisor| Ok(supervisor.commit(&id))).await
}

#[tauri::command]
pub async fn jobs_forget(jobs: tauri::State<'_, Supervisor>, id: String) -> Result<bool, String> {
  supervisor_work(jobs.inner().clone(), move |supervisor| Ok(supervisor.forget(&id))).await
}

#[tauri::command]
pub fn jobs_launch_id(jobs: tauri::State<'_, Supervisor>) -> String {
  jobs.launch_id()
}

#[tauri::command]
pub fn jobs_export_protocol() -> u32 { 20 }

#[tauri::command]
pub async fn jobs_export_resources(jobs: tauri::State<'_, Supervisor>, destination: String) -> Result<ExportResources, String> {
  supervisor_work(jobs.inner().clone(), move |supervisor|
    Ok(export_resources(Path::new(&destination), supervisor.export_work_root.as_deref(), &supervisor.workspace))).await
}

#[tauri::command]
pub async fn jobs_stage_render_scratch(jobs: tauri::State<'_, Supervisor>, id: String, files: Vec<RenderScratchFile>, fonts: Vec<String>) -> Result<String, String> {
  supervisor_work(jobs.inner().clone(), move |supervisor| supervisor.stage_render_scratch(&id, files, fonts)).await
}

#[tauri::command]
pub async fn jobs_prepare_export(jobs: tauri::State<'_, Supervisor>, id: String, project_dir: String, stage_path: String, dest_path: String, source: DeliverySource) -> Result<ExportDelivery, String> {
  supervisor_work(jobs.inner().clone(), move |supervisor| supervisor.prepare_delivery(id, project_dir, stage_path, dest_path, source)).await
}

#[tauri::command]
pub async fn jobs_verify_export(jobs: tauri::State<'_, Supervisor>, id: String) -> Result<ExportDelivery, String> {
  supervisor_work(jobs.inner().clone(), move |supervisor| supervisor.verify_delivery(&id)).await
}

#[tauri::command]
pub async fn jobs_publish_export(jobs: tauri::State<'_, Supervisor>, id: String) -> Result<ExportDelivery, String> {
  supervisor_work(jobs.inner().clone(), move |supervisor| supervisor.publish_delivery(&id)).await
}

#[tauri::command]
pub async fn jobs_cancel_export(jobs: tauri::State<'_, Supervisor>, id: String) -> Result<bool, String> {
  supervisor_work(jobs.inner().clone(), move |supervisor| supervisor.cancel_delivery(&id)).await
}

#[tauri::command]
pub async fn jobs_export_intents(jobs: tauri::State<'_, Supervisor>) -> Result<Vec<ExportDelivery>, String> {
  supervisor_work(jobs.inner().clone(), |supervisor| Ok(supervisor.delivery_list())).await
}

#[tauri::command]
pub async fn jobs_fail_export(jobs: tauri::State<'_, Supervisor>, id: String) -> Result<bool, String> {
  supervisor_work(jobs.inner().clone(), move |supervisor| supervisor.fail_delivery(&id)).await
}

#[tauri::command]
pub async fn jobs_complete_export(jobs: tauri::State<'_, Supervisor>, id: String) -> Result<bool, String> {
  supervisor_work(jobs.inner().clone(), move |supervisor| supervisor.complete_delivery(&id)).await
}

#[tauri::command]
pub async fn jobs_copy_export(jobs: tauri::State<'_, Supervisor>, id: String) -> Result<(), String> {
  supervisor_work(jobs.inner().clone(), move |supervisor| supervisor.copy_delivery(&id)).await
}

#[cfg(test)]
mod export_delivery_tests {
  fn scratch_writer(path: &Path, used: u64, limit: u64) -> Result<ScratchOutput, String> {
    let workspace = Workspace::new(EXPORT_WORKSPACE_PAYLOAD_BYTES);
    let key = Supervisor::workspace_key(path.parent().unwrap());
    if let Ok(metadata) = path.metadata() { workspace.account_existing(&key, metadata.len(), 1)?; }
    ScratchOutput::open_workspace(path, used, limit, workspace, &key)
  }

  #[test]
  fn final_file_exemption_cannot_hide_intermediate_writes() {
    let dir = tempfile::tempdir().unwrap();
    let stage = dir.path().join("final.partial").to_string_lossy().into_owned();
    let mut spec = JobSpec { id: "allocation".into(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec![stage.clone()], steps: vec![], cwd: Some(dir.path().to_string_lossy().into()), meta: serde_json::json!({}) };
    assert!(scratch_capture(&spec, &stage, false).is_err());
    assert!(scratch_capture(&spec, &stage, true).unwrap().is_none());
    spec.args = vec!["-f".into(), "nut".into(), "part.nut".into()];
    assert!(scratch_capture(&spec, &stage, true).is_err());
    let captured = scratch_capture(&spec, &stage, false).unwrap().unwrap();
    assert_eq!(captured["limit"], EXPORT_SCRATCH_LIMIT_BYTES);
    assert!(!dir.path().join("part.nut").exists());
  }
  #[test]
  fn admitted_final_stage_accepts_equivalent_real_filesystem_path() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("existing-parent")).unwrap();
    let stage = dir.path().join("final.partial");
    std::fs::write(&stage, b"").unwrap();
    let canonical = stage.canonicalize().unwrap().to_string_lossy().into_owned();
    let alias = dir.path().join("existing-parent").join("..").join("final.partial");
    let spec = JobSpec { id: "path-alias".into(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec![alias.to_string_lossy().into()], steps: vec![], cwd: None, meta: serde_json::json!({}) };
    assert!(scratch_capture(&spec, &canonical, true).unwrap().is_none());
    assert_eq!(std::fs::metadata(stage).unwrap().len(), 0);
  }
  #[test]
  #[ignore = "requires the shipped ffmpeg artifact fixture"]
  fn scratch_capture_preserves_real_nut_frames_and_audio() {
    let binary = PathBuf::from(std::env::var("ARTDADDY_QA_FFMPEG").expect("shipped binary supplied"));
    let dir = tempfile::tempdir().unwrap();
    let direct = dir.path().join("direct.nut");
    let captured = dir.path().join("captured.nut");
    let args: Vec<String> = ["-y", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      "testsrc2=s=320x180:r=30:d=1", "-f", "lavfi", "-i", "aevalsrc=0.1*sin(2*PI*440*t)|0.08*sin(2*PI*880*t):s=48000:d=1",
      "-c:v", "ffv1", "-pix_fmt", "yuv420p", "-c:a", "pcm_f64le", "-progress", "pipe:1", "-f", "nut"]
      .into_iter().map(str::to_string).chain(std::iter::once(direct.to_string_lossy().into_owned())).collect();
    let baseline = std::process::Command::new(&binary).args(&args).output().unwrap();
    assert!(baseline.status.success(), "{}", String::from_utf8_lossy(&baseline.stderr));
    let mut child = std::process::Command::new(&binary).args(captured_output_args(&args).unwrap())
      .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let errors = std::thread::spawn(move || { let mut bytes = Vec::new(); stderr.read_to_end(&mut bytes).unwrap(); bytes });
    let mut output = child.stdout.take().unwrap();
    let mut writer = scratch_writer(&captured, 0, EXPORT_SCRATCH_LIMIT_BYTES).unwrap();
    let mut buffer = [0u8; 65536];
    loop {
      let count = output.read(&mut buffer).unwrap();
      if count == 0 { break; }
      writer.write(&buffer[..count]).unwrap();
    }
    let status = child.wait().unwrap();
    let stderr = errors.join().unwrap();
    writer.finish(status.code()).unwrap();
    assert!(status.success(), "{}", String::from_utf8_lossy(&stderr));
    assert!(String::from_utf8_lossy(&stderr).contains("progress=end"));
    for (stream, format) in [("0:v", "rawvideo"), ("0:a", "f64le")] {
      let decode = |path: &Path| std::process::Command::new(&binary).args(["-nostdin", "-loglevel", "error", "-i"])
        .arg(path).args(["-map", stream, "-f", format, "-"]).output().unwrap();
      let expected = decode(&direct);
      let actual = decode(&captured);
      assert!(expected.status.success()); assert!(actual.status.success());
      assert_eq!(expected.stdout, actual.stdout, "captured {stream} differs");
      if stream == "0:v" { assert_eq!(actual.stdout.len(), 320 * 180 * 3 / 2 * 30); }
      else { assert_eq!(actual.stdout.len(), 48000 * 2 * 8); }
    }
  }
  #[test]
  fn scratch_writer_refuses_before_excess_bytes_reach_disk() {
    let dir = tempfile::tempdir().unwrap();
    let part = dir.path().join("part.nut");
    let destination = dir.path().join("previous.mp4");
    std::fs::write(&destination, b"previous delivered file").unwrap();
    let mut writer = scratch_writer(&part, 6, 12).unwrap();
    writer.write(b"1234").unwrap();
    assert!(writer.write(b"567").is_err());
    assert_eq!(writer.file().as_file().metadata().unwrap().len(), 4);
    assert!(writer.finish(Some(0)).is_err());
    assert!(!part.exists());
    assert_eq!(std::fs::read(&destination).unwrap(), b"previous delivered file");
    assert!(scratch_writer(&dir.path().join("overflow.nut"), 13, 12).is_err());
    assert!(!dir.path().join("overflow.nut").exists());
    assert_eq!(EXPORT_SCRATCH_LIMIT_BYTES, 20_000_000_000);
  }
  #[test]
  fn scratch_replay_preserves_old_alias_bytes_until_successful_finish() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.nut");
    let part = dir.path().join("part.nut");
    std::fs::write(&source, b"old source bytes").unwrap();
    std::fs::hard_link(&source, &part).unwrap();
    {
      let mut refused = scratch_writer(&part, 0, 17).unwrap();
      assert!(refused.write(b"too many new bytes").is_err());
    }
    assert_eq!(std::fs::read(&source).unwrap(), b"old source bytes");
    assert_eq!(std::fs::read(&part).unwrap(), b"old source bytes");
    let mut writer = scratch_writer(&part, 0, 100).unwrap();
    writer.write(b"complete new part").unwrap();
    assert_eq!(std::fs::read(&part).unwrap(), b"old source bytes");
    writer.finish(Some(0)).unwrap();
    assert_eq!(std::fs::read(&part).unwrap(), b"complete new part");
    assert_eq!(std::fs::read(&source).unwrap(), b"old source bytes");
  }
  #[test]
  fn unsuccessful_workers_never_replace_retained_parts() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.nut");
    let part = dir.path().join("part.nut");
    std::fs::write(&source, b"verified old source").unwrap();
    std::fs::hard_link(&source, &part).unwrap();
    for code in [Some(1), Some(-1), None] {
      let mut writer = scratch_writer(&part, 0, 1024).unwrap();
      writer.write(b"incomplete replacement bytes").unwrap();
      assert!(writer.finish(code).is_err());
      assert_eq!(std::fs::read(&part).unwrap(), b"verified old source");
      assert_eq!(std::fs::read(&source).unwrap(), b"verified old source");
      assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }
  }
  use super::*;
  pub(super) struct CleanupBlocker {
    #[cfg(windows)]
    _file: std::fs::File,
    #[cfg(unix)]
    path: PathBuf,
    #[cfg(unix)]
    permissions: std::fs::Permissions,
  }

  impl CleanupBlocker {
    pub(super) fn open(file: &Path) -> Self {
      #[cfg(windows)]
      {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
        Self { _file: std::fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE).open(file).unwrap() }
      }
      #[cfg(unix)]
      {
        use std::os::unix::fs::PermissionsExt;
        assert_ne!(unsafe { libc::geteuid() }, 0, "cleanup-failure discriminator requires the non-root CI user");
        let path = file.parent().unwrap().to_path_buf();
        let permissions = path.metadata().unwrap().permissions();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o500)).unwrap();
        Self { path, permissions }
      }
    }
  }

  impl Drop for CleanupBlocker {
    fn drop(&mut self) {
      #[cfg(unix)]
      if let Err(error) = std::fs::set_permissions(&self.path, self.permissions.clone()) {
        panic!("could not restore the cleanup-failure fixture permissions: {error}");
      }
    }
  }

  pub(super) struct NoSpawn;
  impl Spawner for NoSpawn {
    fn identity(&self, program: &str) -> Result<ArtifactIdentity, String> {
      Ok(ArtifactIdentity { sha256: format!("{:x}", Sha256::digest(program.as_bytes())), size: program.len() as u64 })
    }
    fn spawn(&self, _: &JobSpec, _: Arc<dyn Fn(ProcEvent) + Send + Sync>, _: Arc<Workspace>) -> Result<u32, String> { Err("unused".into()) }
    fn kill(&self, _: &str, _: u32) {}
  }
  fn owner(root: &Path) -> Supervisor {
    Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {})).with_export_root(root.to_path_buf()).unwrap()
  }
  fn owner_with_work(root: &Path, work: PathBuf) -> Supervisor {
    Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {})).with_export_work_root(work).unwrap()
      .with_export_root(root.to_path_buf()).unwrap()
  }
  fn intent(owner: &Supervisor, dir: &Path, id: &str) -> ExportDelivery {
    owner.prepare_delivery(id.into(), "original-project".into(), dir.join(format!("{id}.partial")).to_string_lossy().into(),
      dir.join(format!("{id}.mp4")).to_string_lossy().into(), DeliverySource::Render { paths: Vec::new() }).unwrap()
  }

  fn namespace_snapshot(root: &Path) -> Vec<(PathBuf, Option<Vec<u8>>)> {
    let mut pending = vec![root.to_path_buf()];
    let mut result = Vec::new();
    while let Some(directory) = pending.pop() {
      for entry in std::fs::read_dir(directory).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if entry.file_type().unwrap().is_dir() {
          pending.push(path.clone());
          result.push((path.strip_prefix(root).unwrap().to_path_buf(), None));
        } else {
          result.push((
            path.strip_prefix(root).unwrap().to_path_buf(),
            Some(std::fs::read(path).unwrap()),
          ));
        }
      }
    }
    result.sort_by(|left, right| left.0.cmp(&right.0));
    result
  }

  #[test]
  fn private_receipt_destination_cannot_replace_exported_bytes_with_journal_json() {
    for copy in [false, true] {
      let dir = tempfile::tempdir().unwrap();
      let root = dir.path().join("journal");
      let jobs = owner(&root);
      let source = dir.path().join("imported.bin");
      std::fs::write(&source, b"complete imported media").unwrap();
      let stage = root.join("private-receipt.partial");
      let destination = root.join("private-receipt.json");
      let source_kind = if copy {
        DeliverySource::Copy {
          path: source.to_string_lossy().into(),
          media_ref: "media_imported".into(),
        }
      } else {
        DeliverySource::Render { paths: Vec::new() }
      };
      let result = jobs.prepare_delivery(
        "private-receipt".into(),
        "original-project".into(),
        stage.to_string_lossy().into(),
        destination.to_string_lossy().into(),
        source_kind,
      );
      if let Ok(delivery) = &result {
        if copy {
          jobs.copy_delivery(&delivery.id).unwrap();
        } else {
          render_bytes(&jobs, delivery, b"complete imported media");
        }
        jobs.verify_delivery(&delivery.id).unwrap();
        jobs.publish_delivery(&delivery.id).unwrap();
        assert_eq!(
          std::fs::read(&destination).unwrap(),
          b"complete imported media",
          "receipt installation replaced the actual exported artifact"
        );
      }
      assert!(
        result.is_err(),
        "private recovery receipt was admitted as a public destination"
      );
      assert!(!stage.exists());
      assert!(!destination.exists());
      assert!(jobs.delivery_list().is_empty());
      assert_eq!(std::fs::read(&source).unwrap(), b"complete imported media");
    }
  }

  #[test]
  fn private_namespaces_refuse_both_producers_and_every_public_path_role_without_writes() {
    for copy in [false, true] {
      for journal in [false, true] {
        for stage_role in [false, true] {
          for alias in [false, true] {
            for namespace_root in [false, true] {
              let dir = tempfile::tempdir().unwrap();
              let root = dir.path().join("journal");
              let work = dir.path().join("work");
              let arena = work.join("exports");
              std::fs::create_dir_all(&arena).unwrap();
              let jobs = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {}))
                .with_export_work_root(work)
                .unwrap()
                .with_export_root(root.clone())
                .unwrap();
              let protected = if journal { root.clone() } else { arena };
              let namespace = if namespace_root {
                protected.parent().unwrap().to_path_buf()
              } else {
                protected.clone()
              };
              let parent = if alias {
                namespace.join("..").join(namespace.file_name().unwrap())
              } else {
                namespace
              };
              let source = dir.path().join("imported.bin");
              std::fs::write(&source, b"unchanged imported source").unwrap();
              std::fs::write(
                dir.path().join("previous.mp4"),
                b"previous complete destination",
              )
              .unwrap();
              let restricted = parent.join(protected.file_name().unwrap());
              let stage = if namespace_root && stage_role {
                restricted.clone()
              } else {
                parent.join(if stage_role {
                  ".receipt-abcdefghijklmnop.tmp"
                } else {
                  "private-target.partial"
                })
              };
              let destination = if namespace_root && !stage_role {
                restricted
              } else {
                parent.join(if journal {
                  "private-target.json"
                } else {
                  "private-target.mp4"
                })
              };
              if journal && !stage_role && !namespace_root {
                std::fs::write(&destination, b"previous private bytes").unwrap();
              }
              let before = namespace_snapshot(dir.path());
              let source_kind = if copy {
                DeliverySource::Copy {
                  path: source.to_string_lossy().into(),
                  media_ref: "media_imported".into(),
                }
              } else {
                DeliverySource::Render { paths: Vec::new() }
              };
              let result = jobs.prepare_delivery(
                "private-target".into(),
                "original-project".into(),
                stage.to_string_lossy().into(),
                destination.to_string_lossy().into(),
                source_kind,
              );
              assert!(result.is_err(), "private namespace admitted a public producer: copy={copy}, journal={journal}, stage={stage_role}, alias={alias}, root={namespace_root}");
              assert_eq!(
                namespace_snapshot(dir.path()),
                before,
                "refusal changed actual namespace entries or bytes"
              );
              assert!(jobs.delivery_list().is_empty());
            }
          }
        }
      }
    }
  }

  #[test]
  fn private_namespaces_survive_failed_loading_and_refuse_ordinary_mutations_and_ancestors() {
    for target in 0..5 {
      let dir = tempfile::tempdir().unwrap();
      let root = dir.path().join("journal");
      let work = dir.path().join("work");
      let arena = work.join("exports");
      std::fs::create_dir_all(&root).unwrap();
      std::fs::create_dir_all(&arena).unwrap();
      std::fs::write(
        root.join("damaged.json"),
        b"damaged retained recovery evidence",
      )
      .unwrap();
      std::fs::write(
        arena.join("retained.bin"),
        b"retained private scratch bytes",
      )
      .unwrap();
      let base = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {}))
        .with_export_work_root(work.clone())
        .unwrap();
      assert!(base.clone().with_export_root(root.clone()).is_err());
      let before = namespace_snapshot(dir.path());
      let path = match target {
        0 => root.join("..").join("journal").join("damaged.json"),
        1 => root.clone(),
        2 => arena.clone(),
        3 => work,
        _ => dir.path().to_path_buf(),
      };
      let result = base.with_unleased_path(&path, || {
        if path.is_dir() {
          std::fs::remove_dir_all(&path)
        } else {
          std::fs::remove_file(&path)
        }
        .map_err(|error| error.to_string())
      });
      assert!(
        result.is_err(),
        "failed loading forgot a private namespace or its ancestor"
      );
      assert_eq!(namespace_snapshot(dir.path()), before);
      let public = dir.path().join("public.bin");
      std::fs::write(&public, b"ordinary editing must remain available").unwrap();
      base
        .with_unleased_path(&public, || {
          std::fs::remove_file(&public).map_err(|error| error.to_string())
        })
        .unwrap();
      assert!(!public.exists());
      assert_eq!(namespace_snapshot(dir.path()), before);
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("unconfigured.bin");
    std::fs::write(&path, b"no-context mutation must be refused").unwrap();
    let bare = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {}));
    assert!(bare
      .with_unleased_path(&path, || std::fs::remove_file(&path)
        .map_err(|error| error.to_string()))
      .is_err());
    assert_eq!(
      std::fs::read(&path).unwrap(),
      b"no-context mutation must be refused"
    );
    let configured = owner(&dir.path().join("journal"));
    assert!(configured
      .with_unleased_paths(&[], || std::fs::remove_file(&path)
        .map_err(|error| error.to_string()))
      .is_err());
    assert_eq!(
      std::fs::read(path).unwrap(),
      b"no-context mutation must be refused"
    );
  }

  #[test]
  fn private_legacy_rows_are_refused_before_receipt_temporary_cleanup() {
    for version in [1, 2, 3] {
      for copy in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("journal");
        let jobs = owner(&root);
        let mut delivery = intent(&jobs, dir.path(), "unsafe-legacy");
        delivery.version = version;
        delivery.stage_path = root
          .join(".receipt-abcdefghijklmnop.tmp")
          .to_string_lossy()
          .into();
        if copy {
          delivery.source = DeliverySource::Copy {
            path: dir.path().join("imported.bin").to_string_lossy().into(),
            media_ref: "media_imported".into(),
          };
        }
        std::fs::write(
          &delivery.stage_path,
          b"unconfirmed legacy stage must not be deleted",
        )
        .unwrap();
        std::fs::write(
          root.join("unsafe-legacy.json"),
          serde_json::to_vec(&delivery).unwrap(),
        )
        .unwrap();
        let before = namespace_snapshot(dir.path());
        drop(jobs);
        let reopened = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {})).with_export_root(root);
        assert!(reopened.is_err(), "unsafe legacy row was adopted");
        assert_eq!(
          namespace_snapshot(dir.path()),
          before,
          "loader deleted a stage before recognizing its unsafe saved owner"
        );
      }
    }
  }

  #[test]
  fn private_saved_destinations_cannot_publish_replay_or_cleanup_in_either_ordering() {
    for copy in [false, true] {
      for stage_present in [false, true] {
        for cleanup in [false, true] {
          let dir = tempfile::tempdir().unwrap();
          let root = dir.path().join("journal");
          let jobs = owner(&root);
          let mut delivery = intent(&jobs, dir.path(), "unsafe-replay");
          let source = dir.path().join("imported.bin");
          std::fs::write(&source, b"verified media payload").unwrap();
          if copy {
            delivery.source = DeliverySource::Copy {
              path: source.to_string_lossy().into(),
              media_ref: "media_imported".into(),
            };
            delivery.sources = vec![(
              source.to_string_lossy().into(),
              artifact_identity(&source).unwrap(),
            )];
          }
          delivery.dest_path = root.join("private-payload.mp4").to_string_lossy().into();
          delivery.identity = Some(artifact_identity(&source).unwrap());
          delivery.producer_complete = true;
          delivery.execution_queued_at_ms = None;
          delivery.state = if cleanup {
            "cancelled".into()
          } else {
            "publishing".into()
          };
          std::fs::write(&delivery.dest_path, b"verified media payload").unwrap();
          if stage_present {
            std::fs::write(&delivery.stage_path, b"verified media payload").unwrap();
          } else {
            std::fs::remove_file(&delivery.stage_path).unwrap();
          }
          jobs
            .deliveries
            .lock()
            .unwrap()
            .insert(delivery.id.clone(), delivery.clone());
          let before = namespace_snapshot(dir.path());
          let result = if cleanup {
            jobs.complete_delivery(&delivery.id).map(|_| ())
          } else {
            jobs.publish_delivery(&delivery.id).map(|_| ())
          };
          assert!(
            result.is_err(),
            "unsafe saved row reached publication/replay/cleanup"
          );
          assert_eq!(namespace_snapshot(dir.path()), before);
        }
      }
    }
  }

  #[test]
  fn private_journal_writer_refuses_invalid_rows_before_cleaning_or_installing_receipts() {
    for stage_role in [false, true] {
      let dir = tempfile::tempdir().unwrap();
      let root = dir.path().join("journal");
      let jobs = owner(&root);
      let mut delivery = intent(&jobs, dir.path(), "writer-boundary");
      if stage_role {
        delivery.stage_path = root.join("private-stage.bin").to_string_lossy().into();
      } else {
        delivery.dest_path = root.join("writer-boundary.json").to_string_lossy().into();
      }
      std::fs::write(
        root.join(".receipt-abcdefghijklmnop.tmp"),
        b"retained ambiguous bytes",
      )
      .unwrap();
      let before = namespace_snapshot(dir.path());
      assert!(
        persist_delivery(jobs.journal().unwrap(), &delivery).is_err(),
        "journal writer accepted an unsafe row"
      );
      assert_eq!(namespace_snapshot(dir.path()), before);
    }
  }

  #[test]
  fn private_namespaces_preserve_real_public_copy_and_native_render_scratch_lifecycles() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let work = dir.path().join("work");
    let fonts = dir.path().join("fonts");
    std::fs::create_dir(&fonts).unwrap();
    std::fs::write(fonts.join("fixture.ttf"), b"actual retained font fixture").unwrap();
    let jobs = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {}))
      .with_export_work_root(work.clone())
      .unwrap()
      .with_export_font_root(fonts)
      .with_export_root(root.clone())
      .unwrap();
    let source = dir.path().join("imported.bin");
    std::fs::write(&source, b"actual copied media payload").unwrap();
    let delivery = jobs
      .prepare_delivery(
        "public-copy".into(),
        "original-project".into(),
        dir
          .path()
          .join("public-copy.partial")
          .to_string_lossy()
          .into(),
        dir.path().join("public-copy.mp4").to_string_lossy().into(),
        DeliverySource::Copy {
          path: source.to_string_lossy().into(),
          media_ref: "media_imported".into(),
        },
      )
      .unwrap();
    jobs.copy_delivery(&delivery.id).unwrap();
    jobs.verify_delivery(&delivery.id).unwrap();
    jobs.publish_delivery(&delivery.id).unwrap();
    assert_eq!(
      std::fs::read(&delivery.dest_path).unwrap(),
      b"actual copied media payload"
    );
    let render = intent(&jobs, dir.path(), "public-render");
    let scratch = jobs
      .stage_render_scratch(
        &render.id,
        vec![RenderScratchFile {
          name: "graph.ffgraph".into(),
          content: "actual generated graph".into(),
        }],
        vec!["fixture.ttf".into()],
      )
      .unwrap();
    assert_eq!(
      std::fs::read(Path::new(&scratch).join("graph.ffgraph")).unwrap(),
      b"actual generated graph"
    );
    assert_eq!(
      std::fs::read(Path::new(&scratch).join("fonts").join("fixture.ttf")).unwrap(),
      b"actual retained font fixture"
    );
    assert!(jobs
      .with_unleased_path(Path::new(&scratch), || std::fs::remove_dir_all(&scratch)
        .map_err(|error| error.to_string()))
      .is_err());
    jobs.cancel_delivery(&render.id).unwrap();
    jobs.complete_delivery(&render.id).unwrap();
    assert!(!Path::new(&scratch).exists());
    assert_eq!(
      std::fs::read(&delivery.dest_path).unwrap(),
      b"actual copied media payload"
    );
    let reopened = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {}))
      .with_export_work_root(work)
      .unwrap()
      .with_export_root(root)
      .unwrap();
    assert!(reopened.recover_exports().is_empty());
    assert_eq!(
      std::fs::read(delivery.dest_path).unwrap(),
      b"actual copied media payload"
    );
  }

  fn initial_entry_fixture(dir: &Path, kind: InitialEntryKind) -> Supervisor {
    std::fs::write(dir.join("source.bin"), b"original imported source").unwrap();
    std::fs::write(dir.join("initial-boundary.mp4"), b"previous complete destination").unwrap();
    let jobs = owner_with_work(&dir.join("journal"), dir.join("work"));
    if kind == InitialEntryKind::RenderScratch {
      initial_entry_attempt(&jobs, dir, InitialEntryKind::Stage, false).unwrap();
    }
    jobs
  }

  fn initial_entry_attempt(jobs: &Supervisor, dir: &Path, kind: InitialEntryKind, copy: bool) -> Result<PathBuf, String> {
    match kind {
      InitialEntryKind::Stage => jobs.prepare_delivery("initial-boundary".into(), "original-project".into(),
        dir.join("initial-boundary.partial").to_string_lossy().into(), dir.join("initial-boundary.mp4").to_string_lossy().into(),
        if copy { DeliverySource::Copy { path: dir.join("source.bin").to_string_lossy().into(), media_ref: "media_initial".into() } }
        else { DeliverySource::Render { paths: vec![dir.join("source.bin").to_string_lossy().into()] } })
        .map(|delivery| PathBuf::from(delivery.stage_path)),
      InitialEntryKind::RenderScratch => jobs.stage_render_scratch("initial-boundary",
        vec![RenderScratchFile { name: "graph.ffgraph".into(), content: "captured render graph".into() }], vec![]).map(PathBuf::from),
    }
  }

  fn initial_entry_limit(dir: &Path, kind: InitialEntryKind) -> u64 {
    let unit = allocation::AllocationUnit::for_directory(dir).unwrap().bytes();
    if kind == InitialEntryKind::Stage { unit } else { unit * 3 + "captured render graph".len() as u64 }
  }

  fn initial_entry_row(dir: &Path) -> ExportDelivery {
    serde_json::from_slice(&std::fs::read(dir.join("journal").join("initial-boundary.json")).unwrap()).unwrap()
  }

  fn initial_entry_reopen(dir: &Path, workspace: Arc<Workspace>) -> Supervisor {
    let mut jobs = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {})).with_export_work_root(dir.join("work")).unwrap();
    jobs.workspace = workspace;
    jobs.with_export_root(dir.join("journal")).unwrap()
  }

  fn assert_initial_sources_unchanged(dir: &Path) {
    assert_eq!(std::fs::read(dir.join("source.bin")).unwrap(), b"original imported source");
    assert_eq!(std::fs::read(dir.join("initial-boundary.mp4")).unwrap(), b"previous complete destination");
  }

  #[test]
  fn initial_entry_refusal_creates_no_stage_or_render_root_and_no_new_ownership_record() {
    for (kind, copy) in [(InitialEntryKind::Stage, false), (InitialEntryKind::Stage, true), (InitialEntryKind::RenderScratch, false)] {
      let dir = tempfile::tempdir().unwrap();
      let mut jobs = initial_entry_fixture(dir.path(), kind);
      jobs.workspace = Workspace::allocation_fixture(64, 0);
      assert!(initial_entry_attempt(&jobs, dir.path(), kind, copy).unwrap_err().contains("allocation budget"));
      if kind == InitialEntryKind::Stage {
        assert!(!dir.path().join("initial-boundary.partial").exists());
        assert!(!dir.path().join("journal").join("initial-boundary.json").exists());
        assert!(jobs.delivery_list().is_empty());
      } else {
        assert_eq!(std::fs::read_dir(dir.path().join("work").join("exports")).unwrap().count(), 0);
        assert!(initial_entry_row(dir.path()).render_scratch.is_none());
        assert!(jobs.delivery_list()[0].render_scratch.is_none());
      }
      assert_initial_sources_unchanged(dir.path());
    }
  }

  #[test]
  fn initial_entry_intent_and_full_allocation_charge_precede_real_creation_for_every_producer() {
    for (kind, copy) in [(InitialEntryKind::Stage, false), (InitialEntryKind::Stage, true), (InitialEntryKind::RenderScratch, false)] {
      let dir = tempfile::tempdir().unwrap();
      let mut jobs = initial_entry_fixture(dir.path(), kind);
      jobs.workspace = Workspace::allocation_fixture(64, initial_entry_limit(dir.path(), kind));
      let workspace = jobs.workspace.clone();
      let root = dir.path().to_path_buf();
      let visits = Arc::new(Mutex::new(Vec::new()));
      let observed = visits.clone();
      jobs.initial_entry_hook = Some(Arc::new(move |actual, point, path| {
        assert_eq!(actual, kind);
        if point == InitialEntryPoint::IntentPersisted {
          assert!(!path.exists(), "the persisted plan must precede the filesystem entry");
          let row = initial_entry_row(&root);
          assert_eq!(row.version, 3);
          match kind {
            InitialEntryKind::Stage => assert_eq!(row.stage_ownership, Some(InitialEntryOwnership::Planned)),
            InitialEntryKind::RenderScratch => assert_eq!(row.render_scratch.unwrap().ownership, Some(InitialEntryOwnership::Planned)),
          }
          let volume = allocation::AllocationUnit::for_directory(path.parent().unwrap()).unwrap();
          assert!(workspace.reserve_in("unadmitted-sibling", 0, 1, volume).is_err());
        }
        observed.lock().unwrap().push(point);
        Ok(())
      }));
      let path = initial_entry_attempt(&jobs, dir.path(), kind, copy).unwrap();
      assert_eq!(*visits.lock().unwrap(), [InitialEntryPoint::IntentPersisted, InitialEntryPoint::Created]);
      let row = initial_entry_row(dir.path());
      assert_eq!(row.state, "prepared");
      assert_eq!(row.stage_ownership, Some(InitialEntryOwnership::Created));
      match kind {
        InitialEntryKind::Stage => assert_eq!(std::fs::metadata(&path).unwrap().len(), 0),
        InitialEntryKind::RenderScratch => {
          let scratch = row.render_scratch.unwrap();
          assert_eq!(scratch.ownership, Some(InitialEntryOwnership::Created));
          assert!(scratch.ready);
          assert_eq!(std::fs::read(path.join("graph.ffgraph")).unwrap(), b"captured render graph");
        }
      }
      assert_initial_sources_unchanged(dir.path());
    }
  }

  #[test]
  fn initial_entry_collision_after_durable_intent_never_adopts_or_deletes_foreign_data() {
    for (kind, copy) in [(InitialEntryKind::Stage, false), (InitialEntryKind::Stage, true), (InitialEntryKind::RenderScratch, false)] {
      let dir = tempfile::tempdir().unwrap();
      let mut jobs = initial_entry_fixture(dir.path(), kind);
      let occupied = Arc::new(Mutex::new(None));
      let saved = occupied.clone();
      jobs.initial_entry_hook = Some(Arc::new(move |_, point, path| {
        if point == InitialEntryPoint::IntentPersisted {
          if kind == InitialEntryKind::RenderScratch {
            std::fs::create_dir(path).unwrap();
            std::fs::write(path.join("foreign.bin"), b"foreign data").unwrap();
          } else { std::fs::write(path, b"foreign data").unwrap(); }
          *saved.lock().unwrap() = Some(path.to_path_buf());
        }
        Ok(())
      }));
      assert!(initial_entry_attempt(&jobs, dir.path(), kind, copy).unwrap_err().contains("without adopting"));
      let path = occupied.lock().unwrap().clone().unwrap();
      let foreign = if kind == InitialEntryKind::Stage { path.clone() } else { path.join("foreign.bin") };
      assert_eq!(std::fs::read(&foreign).unwrap(), b"foreign data");
      if kind == InitialEntryKind::Stage {
        assert!(jobs.delivery_list().is_empty());
        assert!(!dir.path().join("journal").join("initial-boundary.json").exists());
      } else { assert!(initial_entry_row(dir.path()).render_scratch.is_none()); }
      drop(jobs);
      let reopened = initial_entry_reopen(dir.path(), Workspace::new(64));
      reopened.recover_exports();
      assert_eq!(std::fs::read(&foreign).unwrap(), b"foreign data");
      assert!(!reopened.delivery_list().iter().any(|entry| entry.render_scratch.as_ref().is_some_and(|scratch| Path::new(&scratch.path) == path)));
      assert_initial_sources_unchanged(dir.path());
    }
  }

  #[test]
  fn initial_entry_interruption_before_creation_restarts_without_inventing_or_replaying_a_write() {
    for (kind, copy) in [(InitialEntryKind::Stage, false), (InitialEntryKind::Stage, true), (InitialEntryKind::RenderScratch, false)] {
      let dir = tempfile::tempdir().unwrap();
      let mut jobs = initial_entry_fixture(dir.path(), kind);
      let path = Arc::new(Mutex::new(None));
      let saved = path.clone();
      jobs.initial_entry_hook = Some(Arc::new(move |_, point, path| {
        if point == InitialEntryPoint::IntentPersisted {
          *saved.lock().unwrap() = Some(path.to_path_buf());
          return Err("interrupted before creation".into());
        }
        Ok(())
      }));
      assert!(initial_entry_attempt(&jobs, dir.path(), kind, copy).unwrap_err().contains("interrupted before creation"));
      let path = path.lock().unwrap().clone().unwrap();
      assert!(!path.exists());
      assert!(initial_entry_row(dir.path()).has_unconfirmed_initial_entry());
      drop(jobs);
      let reopened = initial_entry_reopen(dir.path(), Workspace::new(64));
      assert!(reopened.recover_exports().iter().any(|(_, error)| error.contains("ownership was confirmed")));
      assert!(!path.exists());
      assert!(reopened.verify_delivery("initial-boundary").is_err());
      reopened.cancel_delivery("initial-boundary").unwrap();
      reopened.complete_delivery("initial-boundary").unwrap();
      assert!(initial_entry_row(dir.path()).followups_done);
      assert_initial_sources_unchanged(dir.path());
    }
  }

  #[test]
  fn unconfirmed_created_entries_remain_charged_and_untouched_through_restart_and_cancellation() {
    for (kind, copy) in [(InitialEntryKind::Stage, false), (InitialEntryKind::Stage, true), (InitialEntryKind::RenderScratch, false)] {
      let dir = tempfile::tempdir().unwrap();
      let mut jobs = initial_entry_fixture(dir.path(), kind);
      let cap = initial_entry_limit(dir.path(), kind);
      jobs.workspace = Workspace::allocation_fixture(64, cap);
      let path = Arc::new(Mutex::new(None));
      let saved = path.clone();
      jobs.initial_entry_hook = Some(Arc::new(move |_, point, path| {
        if point == InitialEntryPoint::Created {
          *saved.lock().unwrap() = Some(path.to_path_buf());
          return Err("interrupted after creation".into());
        }
        Ok(())
      }));
      assert!(initial_entry_attempt(&jobs, dir.path(), kind, copy).unwrap_err().contains("interrupted after creation"));
      let path = path.lock().unwrap().clone().unwrap();
      assert!(path.exists());
      assert!(initial_entry_row(dir.path()).has_unconfirmed_initial_entry());
      assert!(jobs.prepare_delivery("blocked-live".into(), "original-project".into(),
        dir.path().join("blocked-live.partial").to_string_lossy().into(), dir.path().join("blocked-live.mp4").to_string_lossy().into(),
        DeliverySource::Render { paths: vec![] }).unwrap_err().contains("allocation budget"));
      assert!(!dir.path().join("blocked-live.partial").exists());
      drop(jobs);
      let reopened = initial_entry_reopen(dir.path(), Workspace::allocation_fixture(64, cap));
      assert!(reopened.prepare_delivery("blocked-restart".into(), "original-project".into(),
        dir.path().join("blocked-restart.partial").to_string_lossy().into(), dir.path().join("blocked-restart.mp4").to_string_lossy().into(),
        DeliverySource::Render { paths: vec![] }).unwrap_err().contains("allocation budget"));
      assert!(!dir.path().join("blocked-restart.partial").exists());
      assert!(reopened.recover_exports().iter().any(|(_, error)| error.contains("ownership was confirmed")));
      reopened.cancel_delivery("initial-boundary").unwrap();
      assert!(reopened.complete_delivery("initial-boundary").unwrap_err().contains("unconfirmed ownership"));
      assert!(path.exists());
      if kind == InitialEntryKind::Stage { std::fs::remove_file(&path).unwrap(); }
      else { std::fs::remove_dir(&path).unwrap(); }
      reopened.complete_delivery("initial-boundary").unwrap();
      let next = reopened.prepare_delivery("after-removal".into(), "original-project".into(),
        dir.path().join("after-removal.partial").to_string_lossy().into(), dir.path().join("after-removal.mp4").to_string_lossy().into(),
        DeliverySource::Render { paths: vec![] }).unwrap();
      assert_eq!(std::fs::metadata(next.stage_path).unwrap().len(), 0);
      assert_initial_sources_unchanged(dir.path());
    }
  }

  #[test]
  fn initial_entry_confirmation_write_failure_preserves_the_planned_receipt_and_capacity_hold() {
    for (kind, copy) in [(InitialEntryKind::Stage, false), (InitialEntryKind::Stage, true), (InitialEntryKind::RenderScratch, false)] {
      let dir = tempfile::tempdir().unwrap();
      let mut jobs = initial_entry_fixture(dir.path(), kind);
      jobs.workspace = Workspace::allocation_fixture(64, initial_entry_limit(dir.path(), kind));
      let receipt = dir.path().join("journal").join("initial-boundary.json");
      let blocked = Arc::new(Mutex::new(None::<CleanupBlocker>));
      let blocker = blocked.clone();
      let saved = Arc::new(Mutex::new(None));
      let observed = saved.clone();
      jobs.initial_entry_hook = Some(Arc::new(move |_, point, path| {
        if point == InitialEntryPoint::Created {
          *observed.lock().unwrap() = Some((path.to_path_buf(), std::fs::read(&receipt).unwrap()));
          *blocker.lock().unwrap() = Some(CleanupBlocker::open(&receipt));
        }
        Ok(())
      }));
      assert!(initial_entry_attempt(&jobs, dir.path(), kind, copy).is_err());
      drop(blocked.lock().unwrap().take());
      let (path, planned) = saved.lock().unwrap().clone().unwrap();
      assert!(path.exists());
      assert_eq!(std::fs::read(dir.path().join("journal").join("initial-boundary.json")).unwrap(), planned);
      assert!(initial_entry_row(dir.path()).has_unconfirmed_initial_entry());
      drop(jobs);
      let reopened = initial_entry_reopen(dir.path(), Workspace::allocation_fixture(64, initial_entry_limit(dir.path(), kind)));
      assert!(reopened.prepare_delivery("blocked-confirmation".into(), "original-project".into(),
        dir.path().join("blocked-confirmation.partial").to_string_lossy().into(), dir.path().join("blocked-confirmation.mp4").to_string_lossy().into(),
        DeliverySource::Render { paths: vec![] }).unwrap_err().contains("allocation budget"));
      assert!(!dir.path().join("blocked-confirmation.partial").exists());
      assert_initial_sources_unchanged(dir.path());
    }
  }

  #[test]
  fn cancellation_serializes_with_initial_creation_and_releases_capacity_only_after_real_cleanup() {
    for (kind, copy) in [(InitialEntryKind::Stage, false), (InitialEntryKind::Stage, true), (InitialEntryKind::RenderScratch, false)] {
      let dir = tempfile::tempdir().unwrap();
      let mut jobs = initial_entry_fixture(dir.path(), kind);
      jobs.workspace = Workspace::allocation_fixture(64, initial_entry_limit(dir.path(), kind));
      let (reached, waiting) = std::sync::mpsc::channel();
      let (resume, go) = std::sync::mpsc::channel();
      let go = Mutex::new(go);
      jobs.initial_entry_hook = Some(Arc::new(move |_, point, _| {
        if point == InitialEntryPoint::IntentPersisted {
          reached.send(()).unwrap();
          go.lock().unwrap().recv_timeout(std::time::Duration::from_secs(10)).unwrap();
        }
        Ok(())
      }));
      let worker = jobs.clone();
      let root = dir.path().to_path_buf();
      let creating = std::thread::spawn(move || initial_entry_attempt(&worker, &root, kind, copy));
      waiting.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
      assert!(jobs.deliveries.try_lock().is_err(), "the creation commit must share the cancellation lock");
      let cancelling = jobs.clone();
      let (requested, request) = std::sync::mpsc::channel();
      let cancel = std::thread::spawn(move || {
        requested.send(()).unwrap();
        cancelling.cancel_delivery("initial-boundary")
      });
      request.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
      resume.send(()).unwrap();
      let path = creating.join().unwrap().unwrap();
      assert!(cancel.join().unwrap().unwrap());
      assert!(path.exists());
      assert_eq!(initial_entry_row(dir.path()).state, "cancelled");
      jobs.complete_delivery("initial-boundary").unwrap();
      assert!(!path.exists());
      assert!(!dir.path().join("initial-boundary.partial").exists());
      assert!(initial_entry_row(dir.path()).followups_done);
      jobs.initial_entry_hook = None;
      let next = jobs.prepare_delivery("after-cancel".into(), "original-project".into(),
        dir.path().join("after-cancel.partial").to_string_lossy().into(), dir.path().join("after-cancel.mp4").to_string_lossy().into(),
        DeliverySource::Render { paths: vec![] }).unwrap();
      assert_eq!(std::fs::metadata(next.stage_path).unwrap().len(), 0);
      assert_initial_sources_unchanged(dir.path());
    }
  }

  #[test]
  fn initial_entry_schema_refuses_missing_current_evidence_and_preserves_legacy_receipt_behavior() {
    for (kind, copy) in [(InitialEntryKind::Stage, false), (InitialEntryKind::Stage, true), (InitialEntryKind::RenderScratch, false)] {
      let dir = tempfile::tempdir().unwrap();
      let jobs = initial_entry_fixture(dir.path(), kind);
      let path = initial_entry_attempt(&jobs, dir.path(), kind, copy).unwrap();
      let receipt = dir.path().join("journal").join("initial-boundary.json");
      let original = std::fs::read(&receipt).unwrap();
      drop(jobs);
      for omit_root in [false, true] {
        if omit_root && kind != InitialEntryKind::RenderScratch { continue; }
        let mut damaged: serde_json::Value = serde_json::from_slice(&original).unwrap();
        if omit_root { damaged["render_scratch"].as_object_mut().unwrap().remove("ownership"); }
        else { damaged.as_object_mut().unwrap().remove("stage_ownership"); }
        std::fs::write(&receipt, serde_json::to_vec(&damaged).unwrap()).unwrap();
        let error = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {})).with_export_work_root(dir.path().join("work")).unwrap()
          .with_export_root(dir.path().join("journal")).err().expect("current receipt must retain its ownership evidence");
        assert!(error.contains("ownership"));
        assert!(path.exists());
      }
      let mut legacy: serde_json::Value = serde_json::from_slice(&original).unwrap();
      legacy["version"] = serde_json::json!(2);
      legacy.as_object_mut().unwrap().remove("stage_ownership");
      if let Some(scratch) = legacy["render_scratch"].as_object_mut() { scratch.remove("ownership"); }
      std::fs::write(&receipt, serde_json::to_vec(&legacy).unwrap()).unwrap();
      let reopened = initial_entry_reopen(dir.path(), Workspace::new(64));
      if !copy {
        let graph = reopened.stage_render_scratch("initial-boundary",
          vec![RenderScratchFile { name: "graph.ffgraph".into(), content: "captured render graph".into() }], vec![]).unwrap();
        assert_eq!(std::fs::read(Path::new(&graph).join("graph.ffgraph")).unwrap(), b"captured render graph");
      }
      reopened.cancel_delivery("initial-boundary").unwrap();
      reopened.complete_delivery("initial-boundary").unwrap();
      assert!(!path.exists());
      assert_initial_sources_unchanged(dir.path());
    }
  }

  #[test]
  fn initial_entry_parent_alias_keeps_one_charge_through_observation_external_removal_and_retry() {
    let dir = tempfile::tempdir().unwrap();
    let mut jobs = initial_entry_fixture(dir.path(), InitialEntryKind::RenderScratch);
    std::fs::create_dir(dir.path().join("work-alias")).unwrap();
    jobs.export_work_root = Some(dir.path().join("work-alias").join("..").join("work"));
    jobs.workspace = Workspace::allocation_fixture(64, initial_entry_limit(dir.path(), InitialEntryKind::RenderScratch));
    let path = initial_entry_attempt(&jobs, dir.path(), InitialEntryKind::RenderScratch, false).unwrap();
    jobs.account_workspace(&jobs.deliveries.lock().unwrap()).unwrap();
    assert_eq!(std::fs::read(path.join("graph.ffgraph")).unwrap(), b"captured render graph");
    std::fs::remove_dir_all(&path).unwrap();
    jobs.cancel_delivery("initial-boundary").unwrap();
    jobs.complete_delivery("initial-boundary").unwrap();
    let next = jobs.prepare_delivery("after-parent-alias".into(), "original-project".into(),
      dir.path().join("after-parent-alias.partial").to_string_lossy().into(), dir.path().join("after-parent-alias.mp4").to_string_lossy().into(),
      DeliverySource::Render { paths: vec![] }).unwrap();
    let graph = jobs.stage_render_scratch(&next.id,
      vec![RenderScratchFile { name: "graph.ffgraph".into(), content: "captured render graph".into() }], vec![]).unwrap();
    assert_eq!(std::fs::read(Path::new(&graph).join("graph.ffgraph")).unwrap(), b"captured render graph");
    assert_initial_sources_unchanged(dir.path());
  }

  #[test]
  fn initial_entry_namespace_refuses_reserved_outputs_before_either_creation_or_destination_reuse() {
    for copy in [false, true] {
      for alias_as_stage in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let jobs = initial_entry_fixture(dir.path(), InitialEntryKind::Stage);
        let reserved = jobs.prepare_delivery("namespace-owner".into(), "original-project".into(),
          dir.path().join("owner.partial").to_string_lossy().into(), dir.path().join("owner.mp4").to_string_lossy().into(),
          DeliverySource::Render { paths: vec![] }).unwrap();
        let before = std::fs::read(dir.path().join("journal").join("namespace-owner.json")).unwrap();
        assert!(!Path::new(&reserved.dest_path).exists());
        let (stage, destination) = if alias_as_stage {
          (reserved.dest_path.clone(), dir.path().join("other.mp4").to_string_lossy().into_owned())
        } else {
          (dir.path().join("other.partial").to_string_lossy().into_owned(), reserved.stage_path.clone())
        };
        let error = jobs.prepare_delivery("namespace-intruder".into(), "original-project".into(), stage, destination,
          if copy { DeliverySource::Copy { path: dir.path().join("source.bin").to_string_lossy().into(), media_ref: "media_initial".into() } }
          else { DeliverySource::Render { paths: vec![] } }).unwrap_err();
        assert!(error.contains("leased"), "{error}");
        assert!(!Path::new(&reserved.dest_path).exists());
        assert_eq!(std::fs::metadata(&reserved.stage_path).unwrap().len(), 0);
        assert!(!dir.path().join("other.partial").exists());
        assert!(!dir.path().join("journal").join("namespace-intruder.json").exists());
        assert_eq!(std::fs::read(dir.path().join("journal").join("namespace-owner.json")).unwrap(), before);
        assert_initial_sources_unchanged(dir.path());
      }
      let dir = tempfile::tempdir().unwrap();
      let jobs = initial_entry_fixture(dir.path(), InitialEntryKind::Stage);
      let alias = dir.path().join("parent-alias");
      let different = dir.path().join("different-parent");
      std::fs::create_dir(&alias).unwrap();
      std::fs::create_dir(&different).unwrap();
      let source = || if copy {
        DeliverySource::Copy { path: dir.path().join("source.bin").to_string_lossy().into(), media_ref: "media_initial".into() }
      } else {
        DeliverySource::Render { paths: vec![dir.path().join("source.bin").to_string_lossy().into()] }
      };
      let destination = dir.path().join("canonical-sibling.mp4");
      let error = jobs.prepare_delivery("different-parent".into(), "original-project".into(),
        different.join("foreign.partial").to_string_lossy().into(), destination.to_string_lossy().into(), source()).unwrap_err();
      assert!(error.contains("distinct destination-volume staging sibling"), "{error}");
      assert!(!different.join("foreign.partial").exists());
      assert!(!dir.path().join("foreign.partial").exists());
      assert!(!dir.path().join("journal").join("different-parent.json").exists());
      let delivery = jobs.prepare_delivery("canonical-sibling".into(), "original-project".into(),
        alias.join("..").join("canonical-sibling.partial").to_string_lossy().into(), destination.to_string_lossy().into(), source()).unwrap();
      assert_eq!(std::fs::metadata(&delivery.stage_path).unwrap().len(), 0);
      let receipt: ExportDelivery = serde_json::from_slice(&std::fs::read(dir.path().join("journal").join("canonical-sibling.json")).unwrap()).unwrap();
      assert_eq!(receipt.stage_ownership, Some(InitialEntryOwnership::Created));
      if copy {
        jobs.copy_delivery(&delivery.id).unwrap();
        jobs.verify_delivery(&delivery.id).unwrap();
        jobs.publish_delivery(&delivery.id).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"original imported source");
      } else {
        let scratch = jobs.stage_render_scratch(&delivery.id,
          vec![RenderScratchFile { name: "graph.ffgraph".into(), content: "captured render graph".into() }], vec![]).unwrap();
        assert_eq!(std::fs::read(Path::new(&scratch).join("graph.ffgraph")).unwrap(), b"captured render graph");
        jobs.fail_delivery(&delivery.id).unwrap();
      }
      jobs.complete_delivery(&delivery.id).unwrap();
      assert!(!Path::new(&delivery.stage_path).exists());
      assert_initial_sources_unchanged(dir.path());
    }
  }

  pub(super) fn journal_write_clock(root: &Path) -> SystemTime {
    fn stamp(root: &Path, time: SystemTime) {
      let mut options = std::fs::OpenOptions::new();
      options.read(true);
      #[cfg(windows)]
      {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_WRITE_ATTRIBUTES};
        options.access_mode(FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES).custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
      }
      options.open(root).unwrap().set_times(std::fs::FileTimes::new().set_modified(time)).unwrap();
    }
    let time = UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000);
    stamp(root, time);
    let control = root.join("directory-clock-control");
    std::fs::write(&control, b"control").unwrap();
    std::fs::remove_file(control).unwrap();
    assert_ne!(root.metadata().unwrap().modified().unwrap(), time, "filesystem control did not observe real directory writes");
    stamp(root, time);
    let observed = root.metadata().unwrap().modified().unwrap();
    assert_eq!(observed, time);
    observed
  }

  fn native_journal_fixture_entries(root: &Path, work: Option<&Path>) -> u64 {
    let mut paths = HashSet::new();
    for directory in std::iter::once(root.to_path_buf()).chain(work.map(|work| work.join("exports"))) {
      for ancestor in canonical_export_path(&directory).unwrap().ancestors() {
        if ancestor.is_dir() { paths.insert(export_path_key(ancestor)); }
      }
    }
    for entry in std::fs::read_dir(root).unwrap() {
      paths.insert(export_path_key(&entry.unwrap().path().canonicalize().unwrap()));
    }
    paths.len() as u64
  }

  #[test]
  fn native_journal_and_payload_share_one_entry_budget_before_either_producer_creates_a_stage() {
    for copy in [false, true] {
      let directory = tempfile::tempdir().unwrap();
      let root = directory.path().join("journal");
      let jobs = owner(&root);
      let prior = intent(&jobs, directory.path(), "entry-budget-owner");
      std::fs::write(root.join("operator-note.bin"), b"retained operator evidence").unwrap();
      let before = namespace_snapshot(&root);
      let source = directory.path().join("source.bin");
      std::fs::write(&source, b"complete imported media").unwrap();
      jobs.account_workspace(&jobs.deliveries.lock().unwrap()).unwrap();
      let metadata_entries = native_journal_fixture_entries(&root, None);
      let pressure = jobs.workspace.reserve("peer-payload", 0, 16384 - metadata_entries - 1 - 1).unwrap();
      let stage = directory.path().join("entry-budget-new.partial");
      let destination = directory.path().join("entry-budget-new.mp4");
      let prepare = || jobs.prepare_delivery("entry-budget-new".into(), "original-project".into(),
        stage.to_string_lossy().into(), destination.to_string_lossy().into(),
        if copy { DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_entry".into() } }
        else { DeliverySource::Render { paths: vec![source.to_string_lossy().into()] } });
      let clock = journal_write_clock(&root);
      let result = prepare();
      assert!(!stage.exists(), "new payload entry was created while journal entries already occupied the global budget");
      assert!(result.unwrap_err().contains("entry budget"));
      assert_eq!(root.metadata().unwrap().modified().unwrap(), clock);
      assert_eq!(namespace_snapshot(&root), before);
      assert_eq!(std::fs::metadata(&prior.stage_path).unwrap().len(), 0);
      assert_eq!(std::fs::read(&source).unwrap(), b"complete imported media");
      drop(pressure);
      let delivery = prepare().unwrap();
      if copy { jobs.copy_delivery(&delivery.id).unwrap(); }
      else { render_bytes(&jobs, &delivery, b"complete imported media"); }
      jobs.verify_delivery(&delivery.id).unwrap();
      jobs.publish_delivery(&delivery.id).unwrap();
      assert_eq!(std::fs::read(&destination).unwrap(), b"complete imported media");
      jobs.complete_delivery(&delivery.id).unwrap();
      assert_eq!(std::fs::read(root.join("operator-note.bin")).unwrap(), b"retained operator evidence");
    }
  }

  #[test]
  fn atomic_receipt_replacement_keeps_the_last_global_entry_out_of_live_payload_writers() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("journal");
    let jobs = owner(&root);
    let mut replacement = intent(&jobs, directory.path(), "replacement-headroom");
    let target = root.join("replacement-headroom.json");
    let before = std::fs::read(&target).unwrap();
    let metadata_entries = native_journal_fixture_entries(&root, None);
    let _entries = jobs.workspace.reserve("peer-entry-pressure", 0, 16384 - metadata_entries - 1 - 1).unwrap();
    // Leave the competing entry's one-byte fixture rounding available to isolate entry admission.
    let _bytes = jobs.workspace.reserve("peer-byte-pressure", jobs.workspace.available_bytes() - 1, 0).unwrap();
    let intruder = directory.path().join("payload-used-recovery-slot");
    let captured = Mutex::new(None);
    replacement.state = "cancelled".into();
    persist_delivery_after_sync(jobs.journal().unwrap(), &replacement, |pending| {
      *captured.lock().map_err(|error| error.to_string())? =
        Some((std::fs::read(pending).map_err(|error| error.to_string())?,
          std::fs::read(&target).map_err(|error| error.to_string())?));
      if let Ok(charge) = jobs.workspace.reserve("competing-payload", 0, 1) {
        std::fs::write(&intruder, []).map_err(|error| error.to_string())?;
        charge.retain();
      }
      Ok(())
    }).unwrap();
    assert!(!intruder.exists(), "a live payload writer consumed the entry required for durable receipt replacement");
    let (pending, installed_before_commit) = captured.into_inner().unwrap().unwrap();
    assert_eq!(installed_before_commit, before);
    assert_eq!(serde_json::from_slice::<ExportDelivery>(&pending).unwrap().state, "cancelled");
    assert_eq!(std::fs::read(&target).unwrap(), pending);
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    assert_eq!(owner(&root).delivery_list()[0].state, "cancelled");
  }

  fn metadata_fixture(jobs: &mut Supervisor, limit: u64) {
    jobs.workspace = Workspace::metadata_fixture(64, limit);
    jobs.account_workspace(&jobs.deliveries.lock().unwrap()).unwrap();
  }

  #[test]
  fn native_metadata_refusal_cannot_create_receipts_payload_or_shared_render_directories() {
    for operation in ["receipt", "copy", "render", "scratch"] {
      let directory = tempfile::tempdir().unwrap();
      let root = directory.path().join("journal");
      let work = directory.path().join("work");
      let mut jobs = owner_with_work(&root, work);
      let prior = intent(&jobs, directory.path(), "metadata-owner");
      let source = directory.path().join("source.bin");
      std::fs::write(&source, b"original imported media").unwrap();
      std::fs::write(&prior.dest_path, b"previous complete destination").unwrap();
      metadata_fixture(&mut jobs, 0);
      let before = namespace_snapshot(directory.path());
      let clock = journal_write_clock(&root);
      let result = match operation {
        "receipt" => {
          let mut replacement = prior.clone();
          replacement.state = "cancelled".into();
          persist_delivery(jobs.journal().unwrap(), &replacement)
        }
        "scratch" => jobs.stage_render_scratch(&prior.id,
          vec![RenderScratchFile { name: "graph.ffgraph".into(), content: "captured native graph".into() }], vec![]).map(|_| ()),
        _ => jobs.prepare_delivery("metadata-new".into(), "original-project".into(),
          directory.path().join("metadata-new.partial").to_string_lossy().into(),
          directory.path().join("metadata-new.mp4").to_string_lossy().into(),
          if operation == "copy" { DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_metadata".into() } }
          else { DeliverySource::Render { paths: vec![source.to_string_lossy().into()] } }).map(|_| ()),
      };
      assert!(result.unwrap_err().contains("infrastructure allocation budget"), "{operation}");
      assert_eq!(namespace_snapshot(directory.path()), before, "{operation}: refused work changed actual files");
      assert_eq!(root.metadata().unwrap().modified().unwrap(), clock);
      assert_eq!(owner(&root).delivery_list()[0].state, "prepared");
    }
  }

  #[test]
  fn native_metadata_refusal_precedes_initial_journal_and_nested_ancestor_creation() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("new-parent").join("new-child").join("journal");
    let mut jobs = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {}));
    jobs.workspace = Workspace::metadata_fixture(64, 0);
    let clock = journal_write_clock(directory.path());
    let result = jobs.with_export_root(root);
    assert!(result.err().unwrap().contains("infrastructure allocation budget"));
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    assert_eq!(directory.path().metadata().unwrap().modified().unwrap(), clock);
  }

  #[test]
  fn native_receipt_rounding_is_admitted_before_even_an_empty_temporary_exists() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("journal");
    let mut jobs = owner(&root);
    let mut replacement = intent(&jobs, directory.path(), "metadata-rounding");
    let target = root.join("metadata-rounding.json");
    let before = std::fs::read(&target).unwrap();
    let volume = allocation::AllocationUnit::for_directory(&root).unwrap();
    assert!(volume.bytes() <= 1024 * 1024, "native receipt fixture exceeds its bounded write budget");
    replacement.render_job = Some(JobSpec { id: replacement.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec![], steps: vec![], cwd: None, meta: serde_json::json!({ "payload": "x".repeat((volume.bytes() * 2 + 1) as usize) }) });
    if serde_json::to_vec(&replacement).unwrap().len() as u64 % volume.bytes() == 0 {
      replacement.render_job.as_mut().unwrap().args.push("rounding-discriminator".into());
    }
    let expected = serde_json::to_vec(&replacement).unwrap();
    let clock = journal_write_clock(&root);
    metadata_fixture(&mut jobs, EXPORT_SCRATCH_LIMIT_BYTES - EXPORT_WORKSPACE_PAYLOAD_BYTES);
    let baseline = jobs.workspace.metadata_allocated();
    metadata_fixture(&mut jobs, baseline + expected.len() as u64 + volume.bytes() - 1);
    assert!(persist_delivery(jobs.journal().unwrap(), &replacement).unwrap_err().contains("infrastructure allocation budget"));
    assert_eq!(root.metadata().unwrap().modified().unwrap(), clock, "native rounding refusal created a temporary");
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    assert_eq!(std::fs::read(&target).unwrap(), before);
    metadata_fixture(&mut jobs, EXPORT_SCRATCH_LIMIT_BYTES - EXPORT_WORKSPACE_PAYLOAD_BYTES);
    persist_delivery(jobs.journal().unwrap(), &replacement).unwrap();
    assert_eq!(std::fs::read(&target).unwrap(), expected);
    let actual = allocation::usage(&target).unwrap();
    assert_eq!(actual.bytes, expected.len() as u64);
    assert!(actual.allocated > actual.bytes, "filesystem did not exhibit native receipt allocation rounding");
    assert_eq!(serde_json::to_value(owner(&root).delivery_list()[0].render_job.as_ref()).unwrap(),
      serde_json::to_value(&replacement.render_job).unwrap());
  }

  #[test]
  fn full_payload_capacity_still_allows_a_reloadable_atomic_receipt_update() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("journal");
    let mut jobs = owner(&root);
    let mut replacement = intent(&jobs, directory.path(), "full-payload-recovery");
    metadata_fixture(&mut jobs, EXPORT_SCRATCH_LIMIT_BYTES - EXPORT_WORKSPACE_PAYLOAD_BYTES);
    let _pressure = jobs.workspace.reserve("retained-full-payload", 64, 0).unwrap();
    assert_eq!(jobs.workspace.available_bytes(), 0);
    replacement.state = "cancelled".into();
    persist_delivery(jobs.journal().unwrap(), &replacement).unwrap();
    let bytes = std::fs::read(root.join("full-payload-recovery.json")).unwrap();
    assert_eq!(serde_json::from_slice::<ExportDelivery>(&bytes).unwrap().state, "cancelled");
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    assert_eq!(owner(&root).delivery_list()[0].state, "cancelled");
    assert!(jobs.workspace.reserve("cannot-spend-receipt-headroom-as-payload", 1, 0).is_err());
  }

  #[test]
  fn native_receipt_replacement_and_removal_reuse_only_observed_owned_capacity() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("journal");
    let mut jobs = owner(&root);
    let mut replacement = intent(&jobs, directory.path(), "repeated-native-settlement");
    let volume = allocation::AllocationUnit::for_directory(&root).unwrap();
    assert!(volume.bytes() <= 1024 * 1024);
    let lengths = [0, 1, volume.bytes() - 1, volume.bytes(), volume.bytes() + 1, volume.bytes() * 2 + 1];
    replacement.render_job = Some(JobSpec { id: replacement.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec![], steps: vec![], cwd: None, meta: serde_json::json!({ "payload": "x".repeat(*lengths.last().unwrap() as usize) }) });
    metadata_fixture(&mut jobs, EXPORT_SCRATCH_LIMIT_BYTES - EXPORT_WORKSPACE_PAYLOAD_BYTES);
    let cap = jobs.workspace.metadata_allocated() + 2 * (serde_json::to_vec(&replacement).unwrap().len() as u64 + volume.bytes())
      + volume.bytes() * 4;
    metadata_fixture(&mut jobs, cap);
    for length in lengths.into_iter().chain(lengths.into_iter().rev()).cycle().take(lengths.len() * 4) {
      replacement.render_job.as_mut().unwrap().meta = serde_json::json!({ "payload": "x".repeat(length as usize) });
      persist_delivery(jobs.journal().unwrap(), &replacement).unwrap();
      assert_eq!(std::fs::read(root.join("repeated-native-settlement.json")).unwrap(), serde_json::to_vec(&replacement).unwrap());
      assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
      assert!(jobs.workspace.metadata_allocated() <= cap);
      assert_eq!(jobs.workspace.available_bytes(), 64, "journal allocation consumed the payload partition");
    }
    remove_delivery_receipt(jobs.journal().unwrap(), &replacement.id).unwrap();
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    let _pressure = jobs.workspace.reserve("reuse-observed-receipt-entry", 0, jobs.workspace.available_entries() - 1).unwrap();
    persist_delivery(jobs.journal().unwrap(), &replacement).unwrap();
    assert_eq!(std::fs::read(root.join("repeated-native-settlement.json")).unwrap(), serde_json::to_vec(&replacement).unwrap());
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
  }

  #[test]
  fn native_receipt_allocation_serializes_competing_replacements_in_both_orders() {
    for first in 0..2 {
      let directory = tempfile::tempdir().unwrap();
      let root = directory.path().join("journal");
      let mut jobs = owner(&root);
      let volume = allocation::AllocationUnit::for_directory(&root).unwrap();
      assert!(volume.bytes() <= 1024 * 1024);
      let mut replacements = Vec::new();
      let mut before = Vec::new();
      for index in 0..2 {
        let mut replacement = intent(&jobs, directory.path(), &format!("native-competing-{index}"));
        before.push(std::fs::read(root.join(format!("{}.json", replacement.id))).unwrap());
        replacement.render_job = Some(JobSpec { id: replacement.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
          args: vec![], steps: vec![], cwd: None,
          meta: serde_json::json!({ "payload": "x".repeat((volume.bytes() * 32).min(2 * 1024 * 1024) as usize) }) });
        replacements.push(replacement);
      }
      metadata_fixture(&mut jobs, EXPORT_SCRATCH_LIMIT_BYTES - EXPORT_WORKSPACE_PAYLOAD_BYTES);
      let sizes = replacements.iter().map(|delivery| serde_json::to_vec(delivery).unwrap().len() as u64).collect::<Vec<_>>();
      let allowance = sizes.iter().zip(&before).map(|(next, previous)| next - previous.len() as u64).min().unwrap();
      let cap = jobs.workspace.metadata_allocated() + sizes.iter().max().unwrap() + volume.bytes() + allowance / 2;
      metadata_fixture(&mut jobs, cap);
      let (entered, ready) = std::sync::mpsc::channel();
      let (release, continue_write) = std::sync::mpsc::channel();
      let first_owner = jobs.clone();
      let first_delivery = replacements[first].clone();
      let writer = std::thread::spawn(move || persist_delivery_after_sync(first_owner.journal()?, &first_delivery, |path| {
        entered.send(path.to_path_buf()).map_err(|error| error.to_string())?;
        continue_write.recv_timeout(std::time::Duration::from_secs(30)).map_err(|error| error.to_string())?;
        Ok(())
      }));
      let pending = ready.recv_timeout(std::time::Duration::from_secs(30)).unwrap();
      assert_eq!(serde_json::from_slice::<ExportDelivery>(&std::fs::read(pending).unwrap()).unwrap().id, replacements[first].id);
      let peer_owner = jobs.clone();
      let peer_delivery = replacements[1 - first].clone();
      let peer = std::thread::spawn(move || persist_delivery(peer_owner.journal()?, &peer_delivery));
      release.send(()).unwrap();
      writer.join().unwrap().unwrap();
      assert!(peer.join().unwrap().unwrap_err().contains("infrastructure allocation budget"));
      assert_eq!(std::fs::read(root.join(format!("{}.json", replacements[first].id))).unwrap(),
        serde_json::to_vec(&replacements[first]).unwrap());
      assert_eq!(std::fs::read(root.join(format!("{}.json", replacements[1 - first].id))).unwrap(), before[1 - first]);
      assert_eq!(std::fs::read_dir(&root).unwrap().count(), 2);
      assert!(jobs.workspace.metadata_allocated() <= cap);
      assert_eq!(owner(&root).delivery_list().iter().filter(|delivery| delivery.render_job.is_some()).count(), 1);
    }
  }

  #[test]
  fn native_unknown_journal_extents_survive_restart_and_cannot_be_reused_before_observed_removal() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("journal");
    let mut jobs = owner(&root);
    intent(&jobs, directory.path(), "unknown-extent-owner");
    metadata_fixture(&mut jobs, EXPORT_SCRATCH_LIMIT_BYTES - EXPORT_WORKSPACE_PAYLOAD_BYTES);
    let volume = allocation::AllocationUnit::for_directory(&root).unwrap();
    let cap = jobs.workspace.metadata_allocated() + volume.bytes() * 6;
    let unknown = root.join("operator-retained-native.bin");
    let native = allocation::preallocated_fixture(&unknown, volume);
    let actual = allocation::usage(&unknown).unwrap();
    assert!(actual.allocated > volume.bytes() * 6);
    drop(jobs);
    let mut reopened = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {}));
    reopened.workspace = Workspace::metadata_fixture(64, cap);
    let reopened = reopened.with_export_root(root.clone()).unwrap();
    let before = std::fs::read(root.join("unknown-extent-owner.json")).unwrap();
    let stage = directory.path().join("after-unknown.partial");
    let prepare = || reopened.prepare_delivery("after-unknown".into(), "original-project".into(),
      stage.to_string_lossy().into(), directory.path().join("after-unknown.mp4").to_string_lossy().into(),
      DeliverySource::Render { paths: vec![] });
    assert!(prepare().unwrap_err().contains("infrastructure allocation budget"));
    assert!(!stage.exists());
    assert_eq!(std::fs::read(&unknown).unwrap(), [0x5a]);
    assert_eq!(std::fs::read(root.join("unknown-extent-owner.json")).unwrap(), before);
    drop(native);
    assert!(prepare().unwrap_err().contains("infrastructure allocation budget"), "a smaller observation erased retained native excess");
    std::fs::remove_file(&unknown).unwrap();
    let delivery = prepare().unwrap();
    render_bytes(&reopened, &delivery, b"complete after observed cleanup");
    reopened.verify_delivery(&delivery.id).unwrap();
    reopened.publish_delivery(&delivery.id).unwrap();
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"complete after observed cleanup");
  }

  #[test]
  fn failed_cancelled_receipt_cleanup_retains_native_charges_until_restart_observes_absence() {
    for copy in [false, true] {
      let directory = tempfile::tempdir().unwrap();
      let root = directory.path().join("journal");
      let mut jobs = owner(&root);
      let mut replacement = intent(&jobs, directory.path(), "cancelled-native-cleanup");
      let target = root.join("cancelled-native-cleanup.json");
      let before = std::fs::read(&target).unwrap();
      let volume = allocation::AllocationUnit::for_directory(&root).unwrap();
      let outside = directory.path().join("interrupted-native-reservation");
      let orphan_writer = allocation::preallocated_fixture(&outside, volume);
      let orphan_allocation = allocation::usage(&outside).unwrap().allocated;
      replacement.state = "cancelled".into();
      metadata_fixture(&mut jobs, EXPORT_SCRATCH_LIMIT_BYTES - EXPORT_WORKSPACE_PAYLOAD_BYTES);
      let cap = jobs.workspace.metadata_allocated() + serde_json::to_vec(&replacement).unwrap().len() as u64
        + volume.bytes() + orphan_allocation / 2;
      metadata_fixture(&mut jobs, cap);
      let orphan = root.join(".receipt-0123456789abcdef.tmp");
      let mut pending = None;
      let mut blocker = None;
      let error = persist_delivery_after_sync(jobs.journal().unwrap(), &replacement, |path| {
        std::fs::rename(&outside, &orphan).map_err(|error| error.to_string())?;
        pending = Some(path.to_path_buf());
        blocker = Some(CleanupBlocker::open(path));
        Err("cancelled after native receipt write completed".into())
      }).unwrap_err();
      assert!(error.contains("cancelled after native receipt write completed"), "{error}");
      assert!(error.contains("uninstalled export receipt cleanup failed"), "{error}");
      let pending = pending.unwrap();
      assert!(pending.is_file());
      assert_eq!(std::fs::read(&orphan).unwrap(), [0x5a]);
      assert_eq!(std::fs::read(&target).unwrap(), before);
      assert!(jobs.workspace.metadata_allocated() > cap, "retained native extents were not charged after failed cleanup");
      drop(orphan_writer);
      let source = directory.path().join("source.bin");
      std::fs::write(&source, b"complete imported media").unwrap();
      let stage = directory.path().join("after-native-cleanup.partial");
      let prepare = || jobs.prepare_delivery("after-native-cleanup".into(), "original-project".into(),
        stage.to_string_lossy().into(), directory.path().join("after-native-cleanup.mp4").to_string_lossy().into(),
        if copy { DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_cleanup".into() } }
        else { DeliverySource::Render { paths: vec![source.to_string_lossy().into()] } });
      assert!(prepare().unwrap_err().contains("infrastructure allocation budget"));
      assert!(!stage.exists());
      assert!(pending.is_file());
      assert!(orphan.is_file());
      drop(blocker);
      let mut recovered = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {}));
      recovered.workspace = Workspace::metadata_fixture(64, cap);
      let recovered = recovered.with_export_root(root.clone()).unwrap();
      assert_eq!(recovered.delivery_list()[0].state, "prepared");
      assert_eq!(std::fs::read(&target).unwrap(), before);
      assert!(!pending.exists());
      assert!(!orphan.exists());
      let delivery = prepare().unwrap();
      if copy { jobs.copy_delivery(&delivery.id).unwrap(); }
      else { render_bytes(&jobs, &delivery, b"complete imported media"); }
      jobs.verify_delivery(&delivery.id).unwrap();
      jobs.publish_delivery(&delivery.id).unwrap();
      assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"complete imported media");
      assert_eq!(std::fs::read(&source).unwrap(), b"complete imported media");
    }
  }

  #[test]
  fn reserved_render_scratch_is_leased_and_cleaned_without_a_bound_producer() {
    for cancelled in [false, true] {
      let dir = tempfile::tempdir().unwrap();
      let root = dir.path().join("journal");
      let work = dir.path().join("work");
      let jobs = owner_with_work(&root, work.clone());
      let delivery = intent(&jobs, dir.path(), "reserved-before-binding");
      std::fs::write(&delivery.dest_path, b"previous complete output").unwrap();
      let files = vec![RenderScratchFile { name: "graph.ffgraph".into(), content: "testsrc2=s=320x180:r=30:d=1".into() }];
      let scratch = jobs.stage_render_scratch(&delivery.id, files.clone(), vec![]).unwrap();
      assert_eq!(std::fs::read_to_string(Path::new(&scratch).join("graph.ffgraph")).unwrap(), files[0].content);
      assert_eq!(jobs.stage_render_scratch(&delivery.id, files, vec![]).unwrap(), scratch);
      assert!(jobs.delivery_list()[0].render_job.is_none());
      assert!(jobs.with_unleased_path(Path::new(&scratch), || std::fs::remove_dir_all(&scratch).map_err(|error| error.to_string())).is_err());
      let graph = Path::new(&scratch).join("graph.ffgraph");
      assert!(jobs.with_unleased_path(&graph, || std::fs::remove_file(&graph).map_err(|error| error.to_string())).is_err());
      let alias = dir.path().join("staged-alias.ffgraph");
      std::fs::hard_link(&graph, &alias).unwrap();
      assert!(jobs.with_unleased_path(&alias, || std::fs::write(&alias, b"changed through alias").map_err(|error| error.to_string())).is_err());
      assert_eq!(std::fs::read_to_string(&alias).unwrap(), "testsrc2=s=320x180:r=30:d=1");
      if cancelled { jobs.cancel_delivery(&delivery.id).unwrap(); } else { jobs.fail_delivery(&delivery.id).unwrap(); }
      drop(jobs);
      let reopened = owner_with_work(&root, work);
      assert!(reopened.complete_delivery(&delivery.id).unwrap());
      assert!(!Path::new(&scratch).exists());
      let recorded = reopened.delivery_list().pop().unwrap();
      assert!(recorded.followups_done);
      assert!(recorded.render_scratch.is_none());
      assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous complete output");
    }
  }

  #[test]
  fn partially_staged_render_failure_retains_a_cleanup_owner() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let work = dir.path().join("work");
    let jobs = owner_with_work(&root, work.clone());
    let delivery = intent(&jobs, dir.path(), "partial-staging");
    let file = RenderScratchFile { name: "captions.ass".into(), content: "staged caption bytes".into() };
    let error = jobs.stage_render_scratch(&delivery.id, vec![file], vec!["Missing.ttf".into()]).unwrap_err();
    assert!(error.contains("font root"));
    let reserved = jobs.delivery_list().pop().unwrap().render_scratch.unwrap();
    assert!(!reserved.ready);
    assert_eq!(std::fs::read_to_string(Path::new(&reserved.path).join("captions.ass")).unwrap(), "staged caption bytes");
    jobs.fail_delivery(&delivery.id).unwrap();
    drop(jobs);
    let reopened = owner_with_work(&root, work);
    reopened.complete_delivery(&delivery.id).unwrap();
    assert!(!Path::new(&reserved.path).exists());
  }

  #[test]
  fn render_staging_refuses_unowned_and_escaping_requests_before_writing() {
    let dir = tempfile::tempdir().unwrap();
    let jobs = owner_with_work(&dir.path().join("journal"), dir.path().join("work"));
    let delivery = intent(&jobs, dir.path(), "staging-boundary");
    for name in ["../outside.ass", "..\\outside.ass", "C:alternate.ass", "two\nlines.ass", ".", ".."] {
      assert!(jobs.stage_render_scratch(&delivery.id, vec![RenderScratchFile { name: name.into(), content: "not an owned file".into() }], vec![]).is_err());
      assert!(jobs.delivery_list()[0].render_scratch.is_none());
    }
    assert!(jobs.stage_render_scratch("unknown-intent", vec![], vec![]).is_err());
    jobs.cancel_delivery(&delivery.id).unwrap();
    assert!(jobs.stage_render_scratch(&delivery.id, vec![], vec![]).is_err());
    assert!(!dir.path().join("outside.ass").exists());
    assert!(!dir.path().join("work").exists());
  }

  #[test]
  fn changed_or_unreserved_staged_inputs_cannot_bind_a_render_producer() {
    let dir = tempfile::tempdir().unwrap();
    let jobs = owner_with_work(&dir.path().join("journal"), dir.path().join("work"));
    let delivery = intent(&jobs, dir.path(), "staged-identity");
    std::fs::write(&delivery.dest_path, b"previous complete output").unwrap();
    let outside = dir.path().join("unreserved");
    std::fs::create_dir(&outside).unwrap();
    let mut spec = JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(), args: vec![delivery.stage_path.clone()],
      steps: vec![], cwd: Some(outside.to_string_lossy().into()), meta: serde_json::json!({"kind":"export"}) };
    assert!(jobs.submit(spec.clone()).unwrap_err().contains("no admitted scratch reservation"));
    let scratch = jobs.stage_render_scratch(&delivery.id, vec![RenderScratchFile { name: "graph.ffgraph".into(), content: "captured graph".into() }], vec![]).unwrap();
    spec.cwd = Some(scratch.clone());
    std::fs::write(Path::new(&scratch).join("graph.ffgraph"), b"tampered graph").unwrap();
    assert!(jobs.stage_render_scratch(&delivery.id, vec![RenderScratchFile { name: "graph.ffgraph".into(), content: "captured graph".into() }], vec![])
      .unwrap_err().contains("staged input changed"));
    assert!(jobs.submit(spec).unwrap_err().contains("staged input changed"));
    assert!(jobs.delivery_list()[0].render_job.is_none());
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous complete output");
    jobs.fail_delivery(&delivery.id).unwrap();
    jobs.complete_delivery(&delivery.id).unwrap();
    assert!(!Path::new(&scratch).exists());
  }

  #[test]
  fn retained_scratch_consumes_the_shared_budget_after_restart_until_acknowledged_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let work = dir.path().join("work");
    let mut jobs = owner_with_work(&root, work.clone());
    jobs.workspace = Workspace::new(64);
    let first = intent(&jobs, dir.path(), "space-first");
    let data = "x".repeat(40);
    let path = jobs.stage_render_scratch(&first.id, vec![RenderScratchFile { name: "graph.ffgraph".into(), content: data.clone() }], vec![]).unwrap();
    drop(jobs);
    let mut reopened = owner_with_work(&root, work);
    reopened.workspace = Workspace::new(64);
    let second = intent(&reopened, dir.path(), "space-second");
    assert!(reopened.stage_render_scratch(&second.id, vec![RenderScratchFile { name: "graph.ffgraph".into(), content: data.clone() }], vec![])
      .unwrap_err().contains("workspace budget exceeded"));
    assert_eq!(std::fs::read_to_string(Path::new(&path).join("graph.ffgraph")).unwrap(), data);
    assert!(reopened.delivery_list().iter().find(|entry| entry.id == second.id).unwrap().render_scratch.is_none());
    reopened.fail_delivery(&first.id).unwrap();
    reopened.complete_delivery(&first.id).unwrap();
    assert!(!Path::new(&path).exists());
    let next = reopened.stage_render_scratch(&second.id, vec![RenderScratchFile { name: "graph.ffgraph".into(), content: data.clone() }], vec![]).unwrap();
    assert_eq!(std::fs::read_to_string(Path::new(&next).join("graph.ffgraph")).unwrap(), data);
  }

  #[test]
  fn full_export_scratch_does_not_refuse_unrelated_transcription_admission() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    std::fs::create_dir_all(work.join("exports").join("retained-render")).unwrap();
    std::fs::write(work.join("exports").join("retained-render").join("retained.bin"), [37u8; 64]).unwrap();
    let mut jobs = owner_with_work(&dir.path().join("journal"), work);
    jobs.workspace = Workspace::new(32);
    jobs.submit(JobSpec { id: "unrelated-transcription".into(), lane: "transcription".into(), program: "whisper-cli".into(),
      args: vec![], steps: vec![], cwd: None, meta: serde_json::json!({}) }).unwrap();
    let view = jobs.list().pop().unwrap();
    assert_eq!(view.state, JobState::Exited);
    assert!(view.stderr_head.contains("unused"), "job did not reach its unrelated spawner: {}", view.stderr_head);
    assert!(!view.stderr_head.contains("workspace budget"));
  }

  #[test]
  fn oversized_receipt_cannot_replace_a_reloadable_intent_or_leave_partial_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let delivery = intent(&jobs, dir.path(), "bounded-receipt");
    let file = root.join("bounded-receipt.json");
    let before = std::fs::read(&file).unwrap();
    let mut oversized = delivery;
    oversized.render_job = Some(JobSpec { id: oversized.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec!["x".repeat(8 * 1024 * 1024)], steps: Vec::new(), cwd: None, meta: serde_json::json!({}) });
    assert!(persist_delivery(jobs.journal().unwrap(), &oversized).is_err(), "writer installed a receipt that its own loader cannot accept");
    assert_eq!(std::fs::read(&file).unwrap(), before);
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1, "refused receipt left temporary bytes");
    assert!(owner(&root).delivery_list()[0].render_job.is_none());
  }

  #[test]
  fn aggregate_receipt_budget_preserves_prior_bytes_and_refuses_oversized_legacy_loading() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let target = intent(&jobs, dir.path(), "aggregate-target");
    for index in 0..9 {
      let mut delivery = intent(&jobs, dir.path(), &format!("aggregate-{index}"));
      delivery.render_job = Some(JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
        args: vec![delivery.stage_path.clone()], steps: vec![], cwd: None, meta: serde_json::json!({ "payload": "x".repeat(7 * 1024 * 1024) }) });
      persist_delivery(jobs.journal().unwrap(), &delivery).unwrap();
    }
    let path = root.join("aggregate-target.json");
    let before = std::fs::read(&path).unwrap();
    let mut replacement = target;
    replacement.render_job = Some(JobSpec { id: replacement.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec![replacement.stage_path.clone()], steps: vec![], cwd: None, meta: serde_json::json!({ "payload": "x".repeat(2 * 1024 * 1024) }) });
    assert!(persist_delivery(jobs.journal().unwrap(), &replacement).unwrap_err().contains("aggregate admission budget"));
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 10);
    assert_eq!(owner(&root).delivery_list().len(), 10);
    std::fs::write(&path, serde_json::to_vec(&replacement).unwrap()).unwrap();
    assert!(Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {})).with_export_root(root).is_err(),
      "legacy aggregate overflow must be refused before unbounded loading");
  }

  #[test]
  fn refused_receipts_cannot_write_a_temporary_or_mutate_the_journal() {
    for reason in ["receipt", "bytes", "entries", "identity"] {
      let dir = tempfile::tempdir().unwrap();
      let root = dir.path().join("journal");
      let jobs = owner(&root);
      let original = intent(&jobs, dir.path(), "prewrite-target");
      let target = root.join("prewrite-target.json");
      let before = std::fs::read(&target).unwrap();
      let mut replacement = original.clone();
      let payload = if reason == "receipt" { 8 * 1024 * 1024 } else { 1024 };
      replacement.render_job = Some(JobSpec { id: replacement.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
        args: vec![replacement.stage_path.clone()], steps: vec![], cwd: None, meta: serde_json::json!({ "payload": "x".repeat(payload) }) });
      if reason == "bytes" {
        std::fs::File::create(root.join("retained-charge.bin")).unwrap()
          .set_len(EXPORT_JOURNAL_LIMIT_BYTES - before.len() as u64).unwrap();
      } else if reason == "entries" {
        for index in 0..EXPORT_JOURNAL_ENTRY_LIMIT - 1 {
          std::fs::File::create(root.join(format!("retained-{index}.bin"))).unwrap();
        }
        replacement.id = "additional-receipt".into();
      } else if reason == "identity" { replacement.id = "../escaped".into(); }
      let count = std::fs::read_dir(&root).unwrap().count();
      let clock = journal_write_clock(&root);
      let error = persist_delivery(jobs.journal().unwrap(), &replacement).unwrap_err();
      assert!(error.contains(match reason {
        "receipt" => "eight-MiB", "identity" => "invalid export intent identity", _ => "aggregate admission budget",
      }), "{reason}: {error}");
      assert_eq!(root.metadata().unwrap().modified().unwrap(), clock, "{reason}: refused work changed the directory");
      assert_eq!(std::fs::read(&target).unwrap(), before);
      assert_eq!(std::fs::read_dir(&root).unwrap().count(), count);
      assert!(!dir.path().join("escaped.json").exists());
      assert!(!root.join("additional-receipt.json").exists());
      assert_eq!(owner(&root).delivery_list().len(), 1);
    }
  }

  #[test]
  fn journal_recovery_removes_only_owned_uncommitted_temporaries() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    intent(&jobs, dir.path(), "retained-receipt");
    let before = std::fs::read(root.join("retained-receipt.json")).unwrap();
    let current = tempfile::Builder::new().prefix(EXPORT_RECEIPT_TEMP_PREFIX).rand_bytes(16).suffix(".tmp").tempfile_in(&root).unwrap();
    let legacy = tempfile::NamedTempFile::new_in(&root).unwrap();
    let mut templates = Vec::new();
    for file in [current, legacy] {
      let (mut file, path) = file.keep().unwrap();
      file.write_all(b"{\"interrupted\":").unwrap();
      file.sync_all().unwrap();
      templates.push(path.file_name().unwrap().to_str().unwrap().to_string());
    }
    let mut owned = HashSet::new();
    let mut unknown = HashSet::new();
    for template in templates {
      let (start, length) = if template.starts_with(EXPORT_RECEIPT_TEMP_PREFIX) { (EXPORT_RECEIPT_TEMP_PREFIX.len(), 16) } else { (4, 6) };
      owned.insert(template.clone());
      for (index, byte) in b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".iter().enumerate() {
        let mut bytes = template.as_bytes().to_vec();
        bytes[start + index % length] = *byte;
        let name = String::from_utf8(bytes).unwrap();
        std::fs::write(root.join(&name), b"interrupted receipt").unwrap();
        owned.insert(name);
      }
      for position in 0..length {
        for replacement in ["_", ".", " ", "é", "中"] {
          let name = format!("{}{}{}", &template[..start + position], replacement, &template[start + position + 1..]);
          std::fs::write(root.join(&name), b"unknown retained bytes").unwrap();
          unknown.insert(name);
        }
      }
    }
    for name in ["operator-note.bin", ".tmpkeep-this-file", ".receipt-not-owned.tmp"] {
      std::fs::write(root.join(name), b"unknown retained bytes").unwrap();
      unknown.insert(name.to_string());
    }
    for name in ["../.tmpabcdef", "..\\.tmpabcdef", ".tmpabc/ef", ".tmpabc\\ef", ".tmpabc\0ef", ".tmpabc\nef", ".tmpabc\ref"] {
      assert!(!owned_receipt_temporary(name));
    }
    let retained_count = std::fs::read_dir(&root).unwrap()
      .filter(|entry| !owned.contains(entry.as_ref().unwrap().file_name().to_str().unwrap())).count();
    let recovered = owner(&root);
    assert_eq!(recovered.delivery_list().len(), 1);
    assert_eq!(std::fs::read(root.join("retained-receipt.json")).unwrap(), before);
    for name in &owned { assert!(!root.join(name).exists(), "legitimate uncommitted receipt was not cleaned: {name}"); }
    for name in &unknown { assert_eq!(std::fs::read(root.join(name)).unwrap(), b"unknown retained bytes", "unknown file was dropped: {name}"); }
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), retained_count);
  }

  #[test]
  fn journal_cleanup_cannot_delete_an_owned_looking_directory() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    intent(&jobs, dir.path(), "safe-receipt");
    let before = std::fs::read(root.join("safe-receipt.json")).unwrap();
    let name = root.join(".receipt-0123456789abcdef.tmp");
    std::fs::create_dir(&name).unwrap();
    std::fs::write(name.join("retained.bin"), b"unowned directory content").unwrap();
    let result = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {})).with_export_root(root.clone());
    assert!(result.is_err(), "nonregular temporary was silently deleted or accepted");
    assert_eq!(std::fs::read(name.join("retained.bin")).unwrap(), b"unowned directory content");
    assert_eq!(std::fs::read(root.join("safe-receipt.json")).unwrap(), before);
  }

  #[cfg(unix)]
  #[test]
  fn journal_cleanup_cannot_follow_an_owned_looking_symbolic_link() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    intent(&jobs, dir.path(), "safe-receipt");
    let before = std::fs::read(root.join("safe-receipt.json")).unwrap();
    let outside = dir.path().join("retained-source");
    std::fs::write(&outside, b"original source").unwrap();
    let name = root.join(".receipt-0123456789abcdef.tmp");
    std::os::unix::fs::symlink(&outside, &name).unwrap();
    let result = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {})).with_export_root(root.clone());
    assert!(result.is_err(), "symbolic-link temporary was silently deleted or accepted");
    assert!(std::fs::symlink_metadata(&name).unwrap().file_type().is_symlink());
    assert_eq!(std::fs::read(&outside).unwrap(), b"original source");
    assert_eq!(std::fs::read(root.join("safe-receipt.json")).unwrap(), before);
  }

  #[test]
  fn admitted_journal_replacement_keeps_its_capacity_in_both_writer_orderings() {
    for first in 0..2 {
      let dir = tempfile::tempdir().unwrap();
      let root = dir.path().join("journal");
      let jobs = owner(&root);
      let mut deliveries = Vec::new();
      let mut before = Vec::new();
      let mut occupied = 0u64;
      let mut allowance = 0u64;
      for index in 0..2 {
        let mut delivery = intent(&jobs, dir.path(), &format!("competing-{index}"));
        let bytes = std::fs::read(root.join(format!("{}.json", delivery.id))).unwrap();
        occupied += bytes.len() as u64;
        delivery.render_job = Some(JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
          args: vec![delivery.stage_path.clone()], steps: vec![], cwd: None, meta: serde_json::json!({ "payload": "x".repeat(4096) }) });
        allowance = allowance.max(serde_json::to_vec(&delivery).unwrap().len() as u64 - bytes.len() as u64);
        before.push(bytes);
        deliveries.push(delivery);
      }
      std::fs::File::create(root.join("retained-charge.bin")).unwrap()
        .set_len(EXPORT_JOURNAL_LIMIT_BYTES - occupied - allowance).unwrap();
      let (entered, ready) = std::sync::mpsc::channel();
      let (release, continue_write) = std::sync::mpsc::channel();
      let first_owner = jobs.clone();
      let first_delivery = deliveries[first].clone();
      let writer = std::thread::spawn(move || persist_delivery_after_sync(first_owner.journal()?, &first_delivery, |path| {
        entered.send(path.to_path_buf()).map_err(|error| error.to_string())?;
        continue_write.recv_timeout(std::time::Duration::from_secs(30)).map_err(|error| error.to_string())?;
        Ok(())
      }));
      let pending = ready.recv_timeout(std::time::Duration::from_secs(30)).unwrap();
      let candidate: ExportDelivery = serde_json::from_slice(&std::fs::read(&pending).unwrap()).unwrap();
      assert_eq!(candidate.id, deliveries[first].id);
      let live: u64 = std::fs::read_dir(&root).unwrap().map(|entry| entry.unwrap().metadata().unwrap().len()).sum();
      assert!(live <= EXPORT_JOURNAL_TRANSIENT_BYTES, "actual old-plus-new journal payload exceeded its transient bound");
      for index in 0..2 { assert_eq!(std::fs::read(root.join(format!("{}.json", deliveries[index].id))).unwrap(), before[index]); }
      let (started, attempted) = std::sync::mpsc::channel();
      let peer_owner = jobs.clone();
      let peer_delivery = deliveries[1 - first].clone();
      let peer = std::thread::spawn(move || {
        started.send(()).unwrap();
        persist_delivery(peer_owner.journal()?, &peer_delivery)
      });
      attempted.recv_timeout(std::time::Duration::from_secs(30)).unwrap();
      release.send(()).unwrap();
      writer.join().unwrap().unwrap();
      assert!(peer.join().unwrap().unwrap_err().contains("aggregate admission budget"));
      let recovered = owner(&root).delivery_list();
      assert_eq!(recovered.iter().filter(|delivery| delivery.render_job.is_some()).count(), 1);
      assert!(recovered.iter().find(|delivery| delivery.id == deliveries[first].id).unwrap().render_job.is_some());
      assert_eq!(std::fs::read(root.join(format!("{}.json", deliveries[1 - first].id))).unwrap(), before[1 - first]);
      let retained: u64 = std::fs::read_dir(&root).unwrap().map(|entry| entry.unwrap().metadata().unwrap().len()).sum();
      assert!(retained <= EXPORT_JOURNAL_LIMIT_BYTES);
    }
  }

  #[test]
  fn failed_journal_install_preserves_reloadable_bytes_and_reports_retained_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let mut replacement = intent(&jobs, dir.path(), "failed-install");
    let target = root.join("failed-install.json");
    let before = std::fs::read(&target).unwrap();
    replacement.state = "cancelled".into();
    #[cfg(unix)]
    let original_permissions = root.metadata().unwrap().permissions();
    #[cfg(unix)]
    assert_ne!(unsafe { libc::geteuid() }, 0, "permission-failure discriminator requires the non-root CI user");
    #[cfg(windows)]
    let held = {
      use std::os::windows::fs::OpenOptionsExt;
      use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
      std::fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE).open(&target).unwrap()
    };
    let result = persist_delivery_after_sync(jobs.journal().unwrap(), &replacement, |path| {
      assert!(path.is_file());
      #[cfg(unix)]
      {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o500)).map_err(|error| error.to_string())?;
      }
      Ok(())
    });
    #[cfg(unix)]
    std::fs::set_permissions(&root, original_permissions).unwrap();
    #[cfg(windows)]
    drop(held);
    let error = result.unwrap_err();
    #[cfg(unix)]
    assert!(error.contains("uninstalled export receipt cleanup failed"), "failed cleanup was not surfaced: {error}");
    #[cfg(not(unix))]
    assert!(!error.is_empty());
    assert_eq!(std::fs::read(&target).unwrap(), before);
    assert_eq!(owner(&root).delivery_list()[0].state, "prepared");
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1, "restart retained or forgot an owned failed-install temporary");
  }

  #[test]
  fn successful_journal_install_survives_stale_process_memory() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let mut replacement = intent(&jobs, dir.path(), "installed-before-crash");
    replacement.state = "cancelled".into();
    persist_delivery(jobs.journal().unwrap(), &replacement).unwrap();
    assert_eq!(jobs.delivery_list()[0].state, "prepared");
    drop(jobs);
    let recovered = owner(&root).delivery_list();
    assert_eq!(recovered[0].state, "cancelled");
    assert!(!recovered[0].producer_complete);
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
  }

  #[test]
  fn journal_roundtrips_real_staging_copy_and_retirement_producers() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner_with_work(&root, dir.path().join("work"));
    let render = intent(&jobs, dir.path(), "render-journal");
    let scratch = jobs.stage_render_scratch(&render.id,
      vec![RenderScratchFile { name: "graph.ffgraph".into(), content: "null[output]".into() }], vec![]).unwrap();
    assert_eq!(std::fs::read_to_string(Path::new(&scratch).join("graph.ffgraph")).unwrap(), "null[output]");
    let source = dir.path().join("imported-source.mp4");
    std::fs::write(&source, b"exact imported source bytes").unwrap();
    let copy = jobs.prepare_delivery("copy-journal".into(), "original-project".into(),
      dir.path().join("copy-journal.partial").to_string_lossy().into(), dir.path().join("copy-journal.mp4").to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "imported-source".into() }).unwrap();
    jobs.copy_delivery(&copy.id).unwrap();
    assert_eq!(std::fs::read(&copy.stage_path).unwrap(), std::fs::read(&source).unwrap());
    jobs.cancel_delivery(&render.id).unwrap();
    jobs.complete_delivery(&render.id).unwrap();
    assert!(!Path::new(&scratch).exists());
    let recovered = owner(&root).delivery_list();
    let render = recovered.iter().find(|delivery| delivery.id == render.id).unwrap();
    let copy = recovered.iter().find(|delivery| delivery.id == copy.id).unwrap();
    assert!(render.followups_done);
    assert!(render.render_scratch.is_none());
    assert!(copy.producer_complete);
    assert!(!copy.followups_done);
    assert!(copy.copy_scratch.is_none());
    assert_eq!(std::fs::read(&copy.stage_path).unwrap(), b"exact imported source bytes");
  }

  #[test]
  fn acknowledgement_releases_large_execution_payload_but_keeps_identity_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let delivery = intent(&jobs, dir.path(), "compact-acknowledgement");
    render_bytes(&jobs, &delivery, b"complete verified output");
    jobs.verify_delivery(&delivery.id).unwrap();
    jobs.publish_delivery(&delivery.id).unwrap();
    let file = root.join("compact-acknowledgement.json");
    {
      let mut entries = jobs.deliveries.lock().unwrap();
      let current = entries.get_mut(&delivery.id).unwrap();
      current.render_job.as_mut().unwrap().meta["diagnostic_payload"] = serde_json::json!("x".repeat(1024 * 1024));
      persist_delivery(jobs.journal().unwrap(), current).unwrap();
    }
    let before: ExportDelivery = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert!(std::fs::metadata(&file).unwrap().len() > 1024 * 1024);
    jobs.complete_delivery(&delivery.id).unwrap();
    let after: ExportDelivery = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert!(std::fs::metadata(&file).unwrap().len() < 4096);
    assert!(after.followups_done && after.producer_complete);
    assert!(after.render_job.is_none() && after.sources.is_empty());
    assert_eq!(after.identity.unwrap().sha256, before.identity.unwrap().sha256);
    assert_eq!(after.command_sha256, before.command_sha256);
    assert_eq!(after.worker_identity.unwrap().sha256, before.worker_identity.unwrap().sha256);
    assert_eq!(std::fs::read(&after.dest_path).unwrap(), b"complete verified output");
    assert!(owner(&root).recover_exports().is_empty());
  }

  #[test]
  fn execution_clock_charges_active_work_but_not_queue_wait_across_serialization() {
    let dir = tempfile::tempdir().unwrap();
    let jobs = owner(&dir.path().join("journal"));
    let mut delivery = intent(&jobs, dir.path(), "execution-clock");
    delivery.created_at = 1000;
    delivery.execution_queued_at_ms = None;
    let admitted = delivery.execution_deadline_ms(1000).unwrap();
    delivery.enqueue_execution(2000).unwrap();
    delivery.enqueue_execution(3000).unwrap();
    let encoded = serde_json::to_vec(&delivery).unwrap();
    let mut reopened: ExportDelivery = serde_json::from_slice(&encoded).unwrap();
    let resumed = reopened.resume_execution(100_000).unwrap();
    assert_eq!(resumed - admitted, 98_000, "queue time must not consume execution budget");
    assert_eq!(reopened.execution_deadline_ms(resumed - 1).unwrap(), resumed);
    assert!(reopened.execution_deadline_ms(resumed).unwrap_err().contains("eight-hour"));
    reopened.enqueue_execution(resumed - 1).unwrap();
    let delayed = reopened.resume_execution(resumed + 100_000).unwrap();
    assert_eq!(delayed, resumed + 100_001);
    assert!(reopened.execution_deadline_ms(delayed).is_err(), "retry cannot reset active work already consumed");
  }

  #[test]
  fn execution_clock_refuses_legacy_and_invalid_time_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let jobs = owner(&dir.path().join("journal"));
    let mut delivery = intent(&jobs, dir.path(), "invalid-clock");
    delivery.created_at = 1000;
    delivery.execution_queued_at_ms = None;
    assert!(delivery.execution_deadline_ms(999).is_err());
    delivery.execution_queued_ms = 2000;
    assert!(delivery.execution_deadline_ms(2000).is_err());
    delivery.execution_queued_ms = 0;
    delivery.execution_queued_at_ms = Some(3000);
    assert!(delivery.resume_execution(2000).is_err());
    delivery.version = 1;
    assert!(delivery.execution_deadline_ms(4000).unwrap_err().contains("no supported execution clock"));
  }

  #[test]
  fn restart_refuses_expired_and_legacy_render_and_copy_execution_without_replacing_output() {
    for copy in [false, true] {
      for version in [1, 2] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("journal");
        let source = dir.path().join("source.bin");
        std::fs::write(&source, b"unchanged source").unwrap();
        let jobs = owner(&root);
        let delivery = jobs.prepare_delivery("expired".into(), "isolated-project".into(), dir.path().join("stage.partial").to_string_lossy().into(),
          dir.path().join("delivered.mp4").to_string_lossy().into(), if copy {
            DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_original".into() }
          } else { DeliverySource::Render { paths: vec![source.to_string_lossy().into()] } }).unwrap();
        if !copy {
          jobs.retain_render_job(&JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
            args: vec![delivery.stage_path.clone()], steps: vec![], cwd: None, meta: serde_json::json!({ "kind": "export" }) }).unwrap();
        }
        std::fs::write(&delivery.dest_path, b"previous complete destination").unwrap();
        let mut retained = jobs.delivery_list().pop().unwrap();
        retained.version = version;
        retained.created_at = now_ms() - EXPORT_EXECUTION_LIMIT_MS - 1;
        retained.execution_queued_ms = 0;
        retained.execution_queued_at_ms = None;
        assert!(retained.execution_deadline_ms(now_ms()).is_err(), "restart fixture must already be expired or unsupported");
        persist_delivery(jobs.journal().unwrap(), &retained).unwrap();
        drop(jobs);
        let reopened = owner(&root);
        let failures = reopened.recover_exports();
        let expected = if version == 1 { "supported execution clock" } else { "eight-hour execution budget" };
        assert!(failures.iter().any(|(_, error)| error.contains(expected)), "{failures:?}");
        assert_eq!(reopened.list()[0].state, JobState::Exited);
        assert_ne!(reopened.list()[0].code, Some(0));
        assert!(!reopened.delivery_list()[0].producer_complete);
        assert!(reopened.verify_delivery(&delivery.id).is_err());
        assert!(reopened.publish_delivery(&delivery.id).is_err());
        assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous complete destination");
        assert_eq!(std::fs::read(&source).unwrap(), b"unchanged source");
        assert_eq!(std::fs::metadata(&delivery.stage_path).unwrap().len(), 0);
      }
    }
  }

  #[test]
  fn completed_published_identity_remains_reconcilable_after_its_execution_budget() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let delivery = intent(&jobs, dir.path(), "published-expired-clock");
    render_bytes(&jobs, &delivery, b"complete verified output");
    jobs.verify_delivery(&delivery.id).unwrap();
    let published = jobs.publish_delivery(&delivery.id).unwrap();
    let mut retained = jobs.delivery_list().pop().unwrap();
    retained.created_at = now_ms() - EXPORT_EXECUTION_LIMIT_MS - 1;
    persist_delivery(jobs.journal().unwrap(), &retained).unwrap();
    let reopened = owner(&root);
    assert!(reopened.recover_exports().is_empty());
    assert_eq!(reopened.publish_delivery(&delivery.id).unwrap().identity.unwrap().sha256, published.identity.unwrap().sha256);
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"complete verified output");
  }

  #[test]
  fn waiting_in_the_page_queue_does_not_expire_an_unstarted_native_export() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let delivery = intent(&jobs, dir.path(), "long-page-queue");
    let shift = EXPORT_EXECUTION_LIMIT_MS + 60_000;
    {
      let mut entries = jobs.deliveries.lock().unwrap();
      let retained = entries.get_mut(&delivery.id).unwrap();
      retained.created_at -= shift;
      let queued = retained.execution_queued_at_ms.as_mut().expect("admitted render must already record page-queue waiting");
      *queued -= shift;
      persist_delivery(jobs.journal().unwrap(), retained).unwrap();
    }
    render_bytes(&jobs, &delivery, b"complete output after legitimate queue wait");
    let current = jobs.delivery_list().pop().unwrap();
    assert!(current.producer_complete);
    assert!(current.execution_queued_at_ms.is_none());
    assert!(current.execution_queued_ms >= shift);
    jobs.verify_delivery(&delivery.id).unwrap();
    jobs.publish_delivery(&delivery.id).unwrap();
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"complete output after legitimate queue wait");
  }

  fn render_bytes(owner: &Supervisor, delivery: &ExportDelivery, bytes: &[u8]) {
    struct WritingSpawner(Vec<u8>);
    impl Spawner for WritingSpawner {
      fn identity(&self, program: &str) -> Result<ArtifactIdentity, String> { NoSpawn.identity(program) }
      fn spawn(&self, spec: &JobSpec, notify: Arc<dyn Fn(ProcEvent) + Send + Sync>, _: Arc<Workspace>) -> Result<u32, String> {
        std::fs::write(spec.args.last().ok_or("fixture output missing")?, &self.0).map_err(|error| error.to_string())?;
        notify(ProcEvent::Exit(Some(0)));
        Ok(123)
      }
      fn kill(&self, _: &str, _: u32) {}
    }
    let runner = Supervisor { spawner: Arc::new(WritingSpawner(bytes.to_vec())), ..owner.clone() };
    runner.submit(JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec![delivery.stage_path.clone()], steps: Vec::new(), cwd: None, meta: serde_json::json!({"kind":"export"}) }).unwrap();
    assert_eq!(runner.list().iter().find(|job| job.id == delivery.id).unwrap().code, Some(0));
  }
  #[test]
  fn verified_bytes_publish_and_reconcile_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let delivery = intent(&jobs, dir.path(), "export1");
    render_bytes(&jobs, &delivery, b"verified rendered bytes");
    std::fs::write(&delivery.dest_path, b"old destination").unwrap();
    jobs.verify_delivery(&delivery.id).unwrap();
    let published = jobs.publish_delivery(&delivery.id).unwrap();
    assert_eq!(published.state, "published");
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"verified rendered bytes");
    let reopened = owner(&root);
    assert_eq!(reopened.publish_delivery(&delivery.id).unwrap().identity.unwrap().sha256, published.identity.unwrap().sha256);
  }
  #[test]
  fn staged_bytes_without_a_completed_producer_cannot_be_verified() {
    let dir = tempfile::tempdir().unwrap();
    let jobs = owner(&dir.path().join("journal"));
    let delivery = intent(&jobs, dir.path(), "producer-missing");
    std::fs::write(&delivery.stage_path, b"success-looking staged bytes").unwrap();
    std::fs::write(&delivery.dest_path, b"keep the old destination").unwrap();
    assert!(jobs.verify_delivery(&delivery.id).is_err());
    assert_eq!(jobs.delivery_list()[0].state, "prepared");
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"keep the old destination");
  }
  #[test]
  fn bare_export_lane_jobs_cannot_bypass_native_admission() {
    for metadata in [serde_json::json!({}), serde_json::json!({"kind":"working"})] {
      let dir = tempfile::tempdir().unwrap();
      let jobs = owner(&dir.path().join("journal"));
      let destination = dir.path().join("existing.mp4");
      std::fs::write(&destination, b"existing delivered bytes").unwrap();
      assert!(jobs.submit(JobSpec { id: "unadmitted-export".into(), lane: "export".into(), program: "ffmpeg".into(),
        args: vec![destination.to_string_lossy().into()], steps: Vec::new(), cwd: None, meta: metadata }).is_err());
      assert!(jobs.list().is_empty());
      assert_eq!(std::fs::read(destination).unwrap(), b"existing delivered bytes");
    }
  }
  #[test]
  fn identical_library_bytes_still_require_completed_native_copy() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.wav");
    std::fs::write(&source, b"complete source bytes").unwrap();
    let jobs = owner(&dir.path().join("journal"));
    let delivery = jobs.prepare_delivery("copy-not-run".into(), "original-project".into(),
      dir.path().join("copy.partial").to_string_lossy().into(), dir.path().join("copy.wav").to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_source".into() }).unwrap();
    std::fs::write(&delivery.stage_path, b"complete source bytes").unwrap();
    assert!(jobs.verify_delivery(&delivery.id).is_err());
    assert_eq!(jobs.delivery_list()[0].state, "prepared");
    assert!(!Path::new(&delivery.dest_path).exists());
    jobs.copy_delivery(&delivery.id).unwrap();
    jobs.copying.lock().unwrap().insert(delivery.id.clone());
    assert!(jobs.verify_delivery(&delivery.id).is_err());
    assert!(!Path::new(&delivery.dest_path).exists());
    jobs.copying.lock().unwrap().remove(&delivery.id);
    jobs.verify_delivery(&delivery.id).unwrap();
    jobs.publish_delivery(&delivery.id).unwrap();
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"complete source bytes");
  }
  #[test]
  fn completed_native_copy_is_visible_to_the_next_page_without_app_restart() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.wav");
    std::fs::write(&source, b"completed imported source").unwrap();
    let jobs = owner(&dir.path().join("journal"));
    let delivery = jobs.prepare_delivery("copy-next-page".into(), "original-project".into(),
      dir.path().join("copy.partial").to_string_lossy().into(), dir.path().join("copy.wav").to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_source".into() }).unwrap();
    jobs.copy_delivery(&delivery.id).unwrap();
    let visible = jobs.list().into_iter().find(|view| view.id == delivery.id).expect("a live completed copy must be adoptable after page loss");
    assert_eq!(visible.state, JobState::Exited);
    assert_eq!(visible.code, Some(0));
    assert_eq!(visible.meta["kind"], "export_copy");
    assert_eq!(visible.meta["copyOf"], "media_source");
    assert_eq!(visible.meta["projectDir"], "original-project");
    assert_eq!(std::fs::read(&delivery.stage_path).unwrap(), b"completed imported source");
    jobs.verify_delivery(&delivery.id).unwrap();
    jobs.publish_delivery(&delivery.id).unwrap();
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), std::fs::read(&source).unwrap());
    assert!(jobs.commit(&delivery.id));
    jobs.complete_delivery(&delivery.id).unwrap();
    assert!(jobs.forget(&delivery.id));
    assert!(jobs.list().is_empty());
  }
  #[test]
  fn queued_native_copy_is_adoptable_before_the_page_starts_it() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("queued.wav");
    std::fs::write(&source, b"queued source samples").unwrap();
    let jobs = owner(&dir.path().join("journal"));
    let delivery = jobs.prepare_delivery("copy-queued-page".into(), "original-project".into(),
      dir.path().join("queued.partial").to_string_lossy().into(), dir.path().join("queued-copy.wav").to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_queued".into() }).unwrap();
    let queued = jobs.list().into_iter().find(|view| view.id == delivery.id).expect("native admission must retain queued copy work");
    assert_eq!(queued.state, JobState::Queued);
    assert!(!jobs.delivery_list()[0].producer_complete);
    jobs.copy_delivery(&delivery.id).unwrap();
    jobs.verify_delivery(&delivery.id).unwrap();
    jobs.publish_delivery(&delivery.id).unwrap();
    jobs.copy_delivery(&delivery.id).unwrap();
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"queued source samples");
    assert_eq!(std::fs::read(&source).unwrap(), b"queued source samples");
    assert_eq!(jobs.list().len(), 1);
  }
  #[test]
  fn native_copy_join_and_cancellation_keep_one_producer() {
    for cancelled in [false, true] {
      let dir = tempfile::tempdir().unwrap();
      let source = dir.path().join("source.wav");
      std::fs::write(&source, b"one admitted copy source").unwrap();
      let (started, running) = std::sync::mpsc::channel();
      let (release, gate) = std::sync::mpsc::channel();
      let gate = Arc::new(Mutex::new(gate));
      let observations = Arc::new(Mutex::new(Vec::new()));
      let observed = observations.clone();
      let jobs = Supervisor::new(Arc::new(NoSpawn), Arc::new(move |notice| {
        if let Notice::Changed(view) = notice {
          observed.lock().unwrap().push(view.clone());
          if view.state == JobState::Running {
            started.send(()).unwrap();
            gate.lock().unwrap().recv_timeout(std::time::Duration::from_secs(3)).unwrap();
          }
        }
      })).with_export_root(dir.path().join("journal")).unwrap();
      let delivery = jobs.prepare_delivery("copy-joined".into(), "original-project".into(),
        dir.path().join("copy.partial").to_string_lossy().into(), dir.path().join("copy.wav").to_string_lossy().into(),
        DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_source".into() }).unwrap();
      std::fs::write(&delivery.dest_path, b"previous destination").unwrap();
      let first_owner = jobs.clone();
      let first_id = delivery.id.clone();
      let first = std::thread::spawn(move || first_owner.copy_delivery(&first_id));
      running.recv_timeout(std::time::Duration::from_secs(3)).unwrap();
      assert_eq!(jobs.list()[0].state, JobState::Running);
      assert!(jobs.complete_delivery(&delivery.id).is_err());
      let (finished, result) = std::sync::mpsc::channel();
      let second_owner = jobs.clone();
      let second_id = delivery.id.clone();
      let second = std::thread::spawn(move || {
        let outcome = second_owner.copy_delivery(&second_id);
        finished.send(outcome.clone()).unwrap();
        outcome
      });
      let early = result.recv_timeout(std::time::Duration::from_millis(100));
      if cancelled { assert!(jobs.cancel_delivery(&delivery.id).unwrap()); }
      release.send(()).unwrap();
      let original = first.join().unwrap();
      let joined = second.join().unwrap();
      assert!(matches!(early, Err(std::sync::mpsc::RecvTimeoutError::Timeout)), "joining must wait for the original producer");
      assert_eq!(original.is_ok(), !cancelled);
      assert_eq!(joined.is_ok(), !cancelled);
      assert_eq!(jobs.list()[0].state, JobState::Exited);
      assert_eq!(jobs.list()[0].killed, cancelled);
      assert_eq!(observations.lock().unwrap().iter().filter(|view| view.state == JobState::Running).count(), 1);
      assert_eq!(std::fs::read(&source).unwrap(), b"one admitted copy source");
      if cancelled {
        assert!(jobs.verify_delivery(&delivery.id).is_err());
        assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous destination");
        let persisted: ExportDelivery = serde_json::from_slice(&std::fs::read(dir.path().join("journal/copy-joined.json")).unwrap()).unwrap();
        assert_eq!(persisted.state, "cancelled");
        assert!(!persisted.producer_complete);
      } else {
        jobs.verify_delivery(&delivery.id).unwrap();
        jobs.publish_delivery(&delivery.id).unwrap();
        assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"one admitted copy source");
      }
    }
  }
  #[test]
  fn native_copy_join_waits_for_terminal_handoff_after_durable_completion() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.wav");
    std::fs::write(&source, b"complete copied source").unwrap();
    let jobs = owner(&dir.path().join("journal"));
    let delivery = jobs.prepare_delivery("copy-terminal-handoff".into(), "original-project".into(),
      dir.path().join("copy.partial").to_string_lossy().into(), dir.path().join("copy.wav").to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_source".into() }).unwrap();
    jobs.copy_delivery(&delivery.id).unwrap();
    jobs.lock().jobs.get_mut(&delivery.id).unwrap().state = JobState::Running;
    let (finished, result) = std::sync::mpsc::channel();
    let next_page = jobs.clone();
    let id = delivery.id.clone();
    let joined = std::thread::spawn(move || { finished.send(next_page.copy_delivery(&id)).unwrap(); });
    let early = result.recv_timeout(std::time::Duration::from_millis(100));
    jobs.finish_copy_job(&delivery.id);
    jobs.copy_settled.notify_all();
    joined.join().unwrap();
    assert!(matches!(early, Err(std::sync::mpsc::RecvTimeoutError::Timeout)), "durable bytes alone do not finish the running job");
    result.recv_timeout(std::time::Duration::from_secs(1)).unwrap().unwrap();
    jobs.verify_delivery(&delivery.id).unwrap();
    jobs.publish_delivery(&delivery.id).unwrap();
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), std::fs::read(&source).unwrap());
  }
  #[test]
  fn queued_native_copy_cancel_and_failure_retire_without_writing() {
    for cancelled in [false, true] {
      let dir = tempfile::tempdir().unwrap();
      let source = dir.path().join("source.wav");
      std::fs::write(&source, b"unchanged source").unwrap();
      let jobs = owner(&dir.path().join("journal"));
      let delivery = jobs.prepare_delivery("copy-retired".into(), "original-project".into(),
        dir.path().join("copy.partial").to_string_lossy().into(), dir.path().join("copy.wav").to_string_lossy().into(),
        DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_source".into() }).unwrap();
      std::fs::write(&delivery.dest_path, b"previous copied output").unwrap();
      assert!(if cancelled { jobs.cancel_delivery(&delivery.id).unwrap() } else { jobs.fail_delivery(&delivery.id).unwrap() });
      assert_eq!(jobs.list()[0].state, JobState::Exited);
      assert_eq!(jobs.list()[0].killed, cancelled);
      assert!(jobs.copy_delivery(&delivery.id).is_err());
      assert_eq!(std::fs::read(&delivery.stage_path).unwrap(), b"");
      assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous copied output");
      assert_eq!(std::fs::read(&source).unwrap(), b"unchanged source");
      jobs.complete_delivery(&delivery.id).unwrap();
      assert!(jobs.forget(&delivery.id));
    }
  }
  #[test]
  fn failed_native_copy_retains_the_original_error_for_the_next_page() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.wav");
    std::fs::write(&source, b"original source identity").unwrap();
    let jobs = owner(&dir.path().join("journal"));
    let delivery = jobs.prepare_delivery("copy-error-page".into(), "original-project".into(),
      dir.path().join("copy.partial").to_string_lossy().into(), dir.path().join("copy.wav").to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_source".into() }).unwrap();
    std::fs::write(&source, b"source changed after admission").unwrap();
    std::fs::write(&delivery.dest_path, b"previous copied output").unwrap();
    let error = jobs.copy_delivery(&delivery.id).unwrap_err();
    let failed = jobs.list().into_iter().find(|view| view.id == delivery.id).unwrap();
    assert_eq!(failed.state, JobState::Exited);
    assert_ne!(failed.code, Some(0));
    assert!(format!("{}{}", failed.stderr_head, failed.stderr_tail).contains(&error), "the next page must retain the actual source failure");
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous copied output");
    assert_eq!(std::fs::read(&source).unwrap(), b"source changed after admission");
    assert!(jobs.publish_delivery(&delivery.id).is_err());
  }
  #[test]
  fn successful_worker_with_failed_completion_record_cannot_publish() {
    struct CompletionFailingSpawner(PathBuf);
    impl Spawner for CompletionFailingSpawner {
      fn identity(&self, program: &str) -> Result<ArtifactIdentity, String> { NoSpawn.identity(program) }
      fn spawn(&self, spec: &JobSpec, notify: Arc<dyn Fn(ProcEvent) + Send + Sync>, _: Arc<Workspace>) -> Result<u32, String> {
        std::fs::write(spec.args.last().ok_or("fixture output missing")?, b"complete worker bytes").map_err(|error| error.to_string())?;
        std::fs::remove_dir_all(&self.0).map_err(|error| error.to_string())?;
        std::fs::write(&self.0, b"journal unavailable").map_err(|error| error.to_string())?;
        notify(ProcEvent::Exit(Some(0)));
        Ok(123)
      }
      fn kill(&self, _: &str, _: u32) {}
    }
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = Supervisor::new(Arc::new(CompletionFailingSpawner(root.clone())), Arc::new(|_| {}))
      .with_export_root(root).unwrap();
    let delivery = intent(&jobs, dir.path(), "completion-record-failed");
    std::fs::write(&delivery.dest_path, b"old delivered bytes").unwrap();
    jobs.submit(JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec![delivery.stage_path.clone()], steps: Vec::new(), cwd: None, meta: serde_json::json!({"kind":"export"}) }).unwrap();
    assert_eq!(jobs.list()[0].code, Some(-1));
    assert!(jobs.verify_delivery(&delivery.id).is_err());
    assert!(jobs.publish_delivery(&delivery.id).is_err());
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"old delivered bytes");
  }
  #[test]
  fn synced_copy_with_failed_completion_record_cannot_publish() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let source = dir.path().join("source.wav");
    std::fs::write(&source, b"admitted library bytes").unwrap();
    let jobs = owner(&root);
    let delivery = jobs.prepare_delivery("copy-record-failed".into(), "original-project".into(),
      dir.path().join("copy.partial").to_string_lossy().into(), dir.path().join("copy.wav").to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_source".into() }).unwrap();
    std::fs::write(&delivery.dest_path, b"old copied destination").unwrap();
    assert!(jobs.copy_delivery_after_sync(&delivery.id, || {
      assert_eq!(std::fs::read(&delivery.stage_path).unwrap(), b"admitted library bytes");
      std::fs::remove_dir_all(&root).unwrap();
      std::fs::write(&root, b"journal unavailable").unwrap();
      Ok(())
    }).is_err());
    assert_eq!(std::fs::read(&delivery.stage_path).unwrap(), b"admitted library bytes");
    assert_eq!(jobs.list()[0].state, JobState::Exited);
    assert_ne!(jobs.list()[0].code, Some(0));
    assert!(jobs.verify_delivery(&delivery.id).is_err());
    assert!(jobs.publish_delivery(&delivery.id).is_err());
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"old copied destination");
    assert_eq!(std::fs::read(&source).unwrap(), b"admitted library bytes");
  }
  #[test]
  fn completed_render_recovery_adopts_without_reexecuting_worker() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let delivery = intent(&jobs, dir.path(), "completed-before-restart");
    render_bytes(&jobs, &delivery, b"finished before the page restarted");
    drop(jobs);
    let reopened = owner(&root);
    assert!(reopened.recover_exports().is_empty());
    assert_eq!(reopened.list()[0].code, Some(0));
    reopened.verify_delivery(&delivery.id).unwrap();
    reopened.publish_delivery(&delivery.id).unwrap();
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"finished before the page restarted");
  }
  #[test]
  fn refused_native_recovery_is_visible_without_reexecuting_or_claiming_delivery() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let source = dir.path().join("source.wav");
    std::fs::write(&source, b"admitted source identity").unwrap();
    let jobs = owner(&root);
    let delivery = jobs.prepare_delivery("copy-recovery-refused".into(), "original-project".into(),
      dir.path().join("copy.partial").to_string_lossy().into(), dir.path().join("copy.wav").to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_source".into() }).unwrap();
    std::fs::write(&delivery.dest_path, b"previous complete destination").unwrap();
    std::fs::write(&source, b"source changed before restart").unwrap();
    drop(jobs);
    let reopened = owner(&root);
    let failures = reopened.recover_exports();
    assert_eq!(failures.len(), 1);
    let failed = reopened.list().into_iter().find(|view| view.id == delivery.id).expect("recovery refusals must be visible to the page");
    assert_eq!(failed.state, JobState::Exited);
    assert_ne!(failed.code, Some(0));
    assert!(format!("{}{}", failed.stderr_head, failed.stderr_tail).contains(&failures[0].1));
    assert!(!reopened.delivery_list()[0].producer_complete);
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous complete destination");
    assert_eq!(std::fs::read(&source).unwrap(), b"source changed before restart");
  }
  #[test]
  fn restart_before_worker_binding_reports_failure_without_inventing_a_render_plan() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let delivery = intent(&jobs, dir.path(), "unbound-before-restart");
    std::fs::write(&delivery.dest_path, b"previous successful output").unwrap();
    drop(jobs);
    let reopened = owner(&root);
    assert_eq!(reopened.recover_exports().len(), 1);
    let failed = reopened.list().into_iter().find(|view| view.id == delivery.id).expect("unbound intents must not disappear");
    assert_eq!(failed.state, JobState::Exited);
    assert_ne!(failed.code, Some(0));
    assert_eq!(failed.meta["kind"], "export");
    assert_eq!(failed.meta["projectDir"], "original-project");
    assert_eq!(failed.meta["destPath"], delivery.dest_path);
    assert!(failed.meta.get("plan").is_none());
    assert!(!reopened.delivery_list()[0].producer_complete);
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous successful output");
  }
  #[test]
  fn recovery_publication_failure_preserves_the_completed_producer_proof() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let source = dir.path().join("source.wav");
    std::fs::write(&source, b"completed source samples").unwrap();
    let jobs = owner(&root);
    let delivery = jobs.prepare_delivery("copy-publication-recovery".into(), "original-project".into(),
      dir.path().join("copy.partial").to_string_lossy().into(), dir.path().join("blocked.wav").to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_source".into() }).unwrap();
    jobs.copy_delivery(&delivery.id).unwrap();
    let verified = jobs.verify_delivery(&delivery.id).unwrap();
    std::fs::create_dir(&delivery.dest_path).unwrap();
    std::fs::write(Path::new(&delivery.dest_path).join("keep.txt"), b"blocking content").unwrap();
    drop(jobs);
    let reopened = owner(&root);
    assert_eq!(reopened.recover_exports().len(), 1);
    assert_eq!(reopened.list()[0].code, Some(0));
    assert!(reopened.delivery_list()[0].producer_complete);
    assert_eq!(reopened.delivery_list()[0].identity.as_ref().unwrap().sha256, verified.identity.unwrap().sha256);
    assert_eq!(std::fs::read(Path::new(&delivery.dest_path).join("keep.txt")).unwrap(), b"blocking content");
    std::fs::remove_dir_all(&delivery.dest_path).unwrap();
    reopened.publish_delivery(&delivery.id).unwrap();
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), std::fs::read(&source).unwrap());
  }
  #[test]
  fn completed_render_cannot_be_readmitted_as_a_new_producer() {
    let dir = tempfile::tempdir().unwrap();
    let jobs = owner(&dir.path().join("journal"));
    let delivery = intent(&jobs, dir.path(), "completed-producer-reentry");
    render_bytes(&jobs, &delivery, b"completed submitted edit");
    let spec = jobs.delivery_list()[0].render_job.clone().unwrap();
    assert!(jobs.retain_render_job(&spec).is_err());
    jobs.verify_delivery(&delivery.id).unwrap();
    jobs.publish_delivery(&delivery.id).unwrap();
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"completed submitted edit");
  }
  #[test]
  fn unrelated_bundled_program_cannot_become_an_export_renderer() {
    let dir = tempfile::tempdir().unwrap();
    let jobs = owner(&dir.path().join("journal"));
    let delivery = intent(&jobs, dir.path(), "wrong-render-backend");
    assert!(jobs.submit(JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "whisper-cli".into(),
      args: vec![delivery.stage_path.clone()], steps: Vec::new(), cwd: None, meta: serde_json::json!({}) }).is_err());
    assert!(jobs.list().is_empty());
    assert_eq!(std::fs::metadata(&delivery.stage_path).unwrap().len(), 0);
    assert!(!Path::new(&delivery.dest_path).exists());
  }
  #[test]
  fn page_cannot_commit_or_forget_unpublished_export() {
    let dir = tempfile::tempdir().unwrap();
    let jobs = owner(&dir.path().join("journal"));
    let delivery = intent(&jobs, dir.path(), "unpublished-page-followup");
    render_bytes(&jobs, &delivery, b"native completed edit");
    assert!(!jobs.commit(&delivery.id));
    assert!(!jobs.forget(&delivery.id));
    assert_eq!(jobs.list().len(), 1);
    jobs.verify_delivery(&delivery.id).unwrap();
    jobs.publish_delivery(&delivery.id).unwrap();
    assert!(jobs.commit(&delivery.id));
    assert!(!jobs.forget(&delivery.id));
    jobs.complete_delivery(&delivery.id).unwrap();
    assert!(jobs.forget(&delivery.id));
    assert!(jobs.list().is_empty());
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"native completed edit");
  }
  #[test]
  fn legacy_verified_receipt_without_producer_proof_cannot_publish() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let delivery = intent(&jobs, dir.path(), "legacy-producer-proof");
    render_bytes(&jobs, &delivery, b"complete old staged bytes");
    jobs.verify_delivery(&delivery.id).unwrap();
    std::fs::write(&delivery.dest_path, b"preserved previous delivery").unwrap();
    let receipt_path = root.join(format!("{}.json", delivery.id));
    let mut receipt: serde_json::Value = serde_json::from_slice(&std::fs::read(&receipt_path).unwrap()).unwrap();
    receipt.as_object_mut().unwrap().remove("producer_complete");
    std::fs::write(receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
    let reopened = owner(&root);
    assert!(reopened.publish_delivery(&delivery.id).is_err());
    assert!(!reopened.recover_exports().is_empty());
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"preserved previous delivery");
  }
  #[test]
  fn old_destination_is_not_evidence_and_cancel_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let delivery = intent(&jobs, dir.path(), "export2");
    render_bytes(&jobs, &delivery, b"new verified bytes");
    std::fs::write(&delivery.dest_path, b"unrelated old bytes").unwrap();
    jobs.verify_delivery(&delivery.id).unwrap();
    std::fs::remove_file(&delivery.stage_path).unwrap();
    assert!(jobs.publish_delivery(&delivery.id).is_err());
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"unrelated old bytes");
    jobs.cancel_delivery(&delivery.id).unwrap();
    assert!(owner(&root).publish_delivery(&delivery.id).is_err());
  }
  #[test]
  fn a_refused_rename_does_not_trap_an_intent_in_publishing() {
    let dir = tempfile::tempdir().unwrap();
    let jobs = owner(&dir.path().join("journal"));
    let delivery = intent(&jobs, dir.path(), "rename-refused");
    render_bytes(&jobs, &delivery, b"complete staged artifact");
    jobs.verify_delivery(&delivery.id).unwrap();
    std::fs::create_dir(&delivery.dest_path).unwrap();
    let marker = Path::new(&delivery.dest_path).join("keep.txt");
    std::fs::write(&marker, b"existing destination content").unwrap();
    assert!(jobs.publish_delivery(&delivery.id).is_err());
    assert!(jobs.fail_delivery(&delivery.id).unwrap(), "a refused rename must still be settleable as failure");
    jobs.complete_delivery(&delivery.id).unwrap();
    assert!(!Path::new(&delivery.stage_path).exists());
    assert_eq!(std::fs::read(&marker).unwrap(), b"existing destination content");
    assert_eq!(jobs.delivery_list().iter().find(|entry| entry.id == delivery.id).unwrap().state, "failed");
  }
  #[test]
  fn a_refused_rename_remains_retryable_after_owner_recreation() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let delivery = intent(&jobs, dir.path(), "rename-retry");
    render_bytes(&jobs, &delivery, b"complete retryable staged artifact");
    jobs.verify_delivery(&delivery.id).unwrap();
    std::fs::create_dir(&delivery.dest_path).unwrap();
    let marker = Path::new(&delivery.dest_path).join("keep.txt");
    std::fs::write(&marker, b"blocked destination marker").unwrap();
    assert!(jobs.publish_delivery(&delivery.id).is_err());
    let reopened = owner(&root);
    assert_eq!(reopened.delivery_list()[0].state, "verified");
    assert_eq!(std::fs::read(&delivery.stage_path).unwrap(), b"complete retryable staged artifact");
    assert_eq!(std::fs::read(&marker).unwrap(), b"blocked destination marker");
    std::fs::remove_file(&marker).unwrap();
    std::fs::remove_dir(&delivery.dest_path).unwrap();
    reopened.publish_delivery(&delivery.id).unwrap();
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"complete retryable staged artifact");
    assert!(!Path::new(&delivery.stage_path).exists());
    assert_eq!(reopened.delivery_list()[0].state, "published");
  }
  #[test]
  fn an_owned_stage_refuses_unrelated_writes_until_native_settlement() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("stage-source.wav");
    std::fs::write(&source, b"complete admitted copied bytes").unwrap();
    let jobs = owner(&dir.path().join("journal"));
    let delivery = jobs.prepare_delivery("stage-owner".into(), "original-project".into(),
      dir.path().join("owned.partial").to_string_lossy().into(), dir.path().join("delivered.wav").to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_stage_source".into() }).unwrap();
    let stage = Path::new(&delivery.stage_path);
    let write = || std::fs::write(stage, b"unrelated stage replacement").map_err(|error| error.to_string());
    assert!(jobs.with_unleased_path(stage, write).is_err());
    assert_eq!(std::fs::metadata(stage).unwrap().len(), 0);
    jobs.copy_delivery(&delivery.id).unwrap();
    std::fs::remove_file(stage).unwrap();
    assert!(jobs.with_unleased_path(stage, write).is_err(), "a missing owned stage name must remain reserved");
    assert!(!stage.exists());
    std::fs::write(stage, b"complete admitted copied bytes").unwrap();
    jobs.verify_delivery(&delivery.id).unwrap();
    assert!(jobs.with_unleased_path(stage, write).is_err());
    let alias = dir.path().join("owned-stage-alias.partial");
    std::fs::hard_link(stage, &alias).unwrap();
    assert!(jobs.with_unleased_path(&alias, || std::fs::write(&alias, b"alias corruption").map_err(|error| error.to_string())).is_err());
    assert_eq!(std::fs::read(stage).unwrap(), b"complete admitted copied bytes");
    jobs.cancel_delivery(&delivery.id).unwrap();
    jobs.with_unleased_path(stage, || std::fs::remove_file(stage).map_err(|error| error.to_string())).unwrap();
    assert!(!stage.exists());
    assert_eq!(std::fs::read(&source).unwrap(), b"complete admitted copied bytes");
  }
  #[test]
  fn a_hard_link_cannot_bypass_an_admitted_source_lease() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let source = dir.path().join("source.wav");
    let alias = dir.path().join("source-alias.wav");
    std::fs::write(&source, b"all original source bytes must survive").unwrap();
    std::fs::hard_link(&source, &alias).unwrap();
    let jobs = owner(&root);
    jobs.prepare_delivery("hard-link-lease".into(), "original-project".into(),
      dir.path().join("render.partial").to_string_lossy().into(), dir.path().join("render.wav").to_string_lossy().into(),
      DeliverySource::Render { paths: vec![source.to_string_lossy().into()] }).unwrap();
    let reopened = owner(&root);
    let result = reopened.with_unleased_path(&alias, || std::fs::write(&alias, b"destructive alias write").map_err(|error| error.to_string()));
    assert_eq!(std::fs::read(&source).unwrap(), b"all original source bytes must survive");
    assert_eq!(std::fs::read(&alias).unwrap(), b"all original source bytes must survive");
    assert!(result.is_err(), "an alias of a leased file must refuse mutation");
  }
  #[test]
  fn late_hard_link_copy_lease_refuses_alias_publication_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let source = dir.path().join("leased-source.wav");
    let alias = dir.path().join("destination-alias.wav");
    let replacement = dir.path().join("replacement.wav");
    std::fs::write(&source, b"leased bytes must stay under both names").unwrap();
    std::fs::hard_link(&source, &alias).unwrap();
    std::fs::write(&replacement, b"unrelated ready copied output").unwrap();
    let jobs = owner(&root);
    let delivery = jobs.prepare_delivery("alias-publisher".into(), "original-project".into(),
      dir.path().join("alias.partial").to_string_lossy().into(), alias.to_string_lossy().into(),
      DeliverySource::Copy { path: replacement.to_string_lossy().into(), media_ref: "media_replacement".into() }).unwrap();
    jobs.copy_delivery(&delivery.id).unwrap();
    jobs.verify_delivery(&delivery.id).unwrap();
    jobs.prepare_delivery("alias-source-holder".into(), "original-project".into(),
      dir.path().join("holder.partial").to_string_lossy().into(), dir.path().join("holder.wav").to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_alias_source".into() }).unwrap();
    assert!(owner(&root).publish_delivery(&delivery.id).is_err());
    assert_eq!(std::fs::read(&source).unwrap(), b"leased bytes must stay under both names");
    assert_eq!(std::fs::read(&alias).unwrap(), b"leased bytes must stay under both names");
    assert_eq!(std::fs::read(&delivery.stage_path).unwrap(), b"unrelated ready copied output");
  }
  #[test]
  fn equal_bytes_do_not_lease_an_independent_file_and_aliases_release_after_settlement() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.wav");
    let alias = dir.path().join("alias.wav");
    let independent = dir.path().join("independent.wav");
    std::fs::write(&source, b"same content does not mean same file").unwrap();
    std::fs::hard_link(&source, &alias).unwrap();
    std::fs::copy(&source, &independent).unwrap();
    let jobs = owner(&dir.path().join("journal"));
    let delivery = jobs.prepare_delivery("identity-direction".into(), "original-project".into(),
      dir.path().join("identity.partial").to_string_lossy().into(), dir.path().join("identity.wav").to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_identity".into() }).unwrap();
    jobs.with_unleased_path(&independent, || std::fs::write(&independent, b"independent edit allowed").map_err(|error| error.to_string())).unwrap();
    assert_eq!(std::fs::read(&source).unwrap(), b"same content does not mean same file");
    assert_eq!(std::fs::read(&independent).unwrap(), b"independent edit allowed");
    jobs.cancel_delivery(&delivery.id).unwrap();
    assert!(jobs.with_unleased_path(&alias, || std::fs::remove_file(&alias).map_err(|error| error.to_string())).is_err());
    jobs.complete_delivery(&delivery.id).unwrap();
    jobs.with_unleased_path(&alias, || std::fs::remove_file(&alias).map_err(|error| error.to_string())).unwrap();
    assert!(!alias.exists());
    assert_eq!(std::fs::read(&source).unwrap(), b"same content does not mean same file");
  }
  #[test]
  fn case_distinct_existing_files_use_physical_identity_when_supported() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("case-source.wav");
    let independent = dir.path().join("CASE-SOURCE.wav");
    std::fs::write(&source, b"leased lowercase file").unwrap();
    if cfg!(target_os = "linux") && std::env::var_os("CI").is_some() {
      assert!(!independent.exists(), "Linux identity QA must exercise a case-sensitive filesystem");
    }
    if independent.exists() {
      eprintln!("case-sensitive file identity scenario unavailable on this volume");
      return;
    }
    std::fs::write(&independent, b"independent uppercase file").unwrap();
    let jobs = owner(&dir.path().join("journal"));
    jobs.prepare_delivery("case-identity".into(), "original-project".into(),
      dir.path().join("case.partial").to_string_lossy().into(), dir.path().join("case-result.wav").to_string_lossy().into(),
      DeliverySource::Render { paths: vec![source.to_string_lossy().into()] }).unwrap();
    jobs.with_unleased_path(&independent, || std::fs::write(&independent, b"case-distinct mutation permitted").map_err(|error| error.to_string())).unwrap();
    assert_eq!(std::fs::read(&source).unwrap(), b"leased lowercase file");
    assert_eq!(std::fs::read(&independent).unwrap(), b"case-distinct mutation permitted");
  }
  #[test]
  fn publication_cannot_replace_another_admitted_export_source() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let source = dir.path().join("original-source.wav");
    let replacement = dir.path().join("replacement-source.wav");
    std::fs::write(&source, b"original source must survive publication").unwrap();
    std::fs::write(&replacement, b"different verified copied artifact").unwrap();
    jobs.prepare_delivery("source-holder".into(), "original-project".into(),
      dir.path().join("holder.partial").to_string_lossy().into(), dir.path().join("holder.wav").to_string_lossy().into(),
      DeliverySource::Render { paths: vec![source.to_string_lossy().into()] }).unwrap();
    let stage = dir.path().join("replacement.partial");
    assert!(jobs.prepare_delivery("source-overwrite".into(), "original-project".into(),
      stage.to_string_lossy().into(), source.to_string_lossy().into(),
      DeliverySource::Copy { path: replacement.to_string_lossy().into(), media_ref: "media_replacement".into() }).is_err());
    assert_eq!(std::fs::read(&source).unwrap(), b"original source must survive publication");
    assert!(!stage.exists(), "known source collision must refuse before stage creation");
    assert_eq!(owner(&root).delivery_list().len(), 1);
  }
  #[test]
  fn publication_rechecks_a_source_lease_admitted_after_verification() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let source = dir.path().join("late-source.wav");
    let replacement = dir.path().join("late-replacement.wav");
    std::fs::write(&source, b"late admitted source bytes").unwrap();
    std::fs::write(&replacement, b"ready replacement bytes").unwrap();
    let delivery = jobs.prepare_delivery("late-publisher".into(), "original-project".into(),
      dir.path().join("late.partial").to_string_lossy().into(), source.to_string_lossy().into(),
      DeliverySource::Copy { path: replacement.to_string_lossy().into(), media_ref: "media_late_replacement".into() }).unwrap();
    jobs.copy_delivery(&delivery.id).unwrap();
    jobs.verify_delivery(&delivery.id).unwrap();
    jobs.prepare_delivery("late-holder".into(), "original-project".into(),
      dir.path().join("late-holder.partial").to_string_lossy().into(), dir.path().join("late-holder.wav").to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_late_source".into() }).unwrap();
    let reopened = owner(&root);
    assert!(reopened.publish_delivery(&delivery.id).is_err());
    assert_eq!(std::fs::read(&source).unwrap(), b"late admitted source bytes");
    assert_eq!(std::fs::read(&delivery.stage_path).unwrap(), b"ready replacement bytes");
  }
  #[test]
  fn a_completed_copy_cannot_publish_over_its_own_admitted_source() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("own-source.wav");
    std::fs::write(&source, b"original library source").unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    assert!(jobs.prepare_delivery("early-own-source".into(), "original-project".into(),
      dir.path().join("early-own.partial").to_string_lossy().into(), source.to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_own_source".into() }).is_err());
    assert!(!dir.path().join("early-own.partial").exists());
    let delivery = jobs.prepare_delivery("own-source".into(), "original-project".into(),
      dir.path().join("own.partial").to_string_lossy().into(), dir.path().join("own-result.wav").to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_own_source".into() }).unwrap();
    jobs.copy_delivery(&delivery.id).unwrap();
    let mut retained = jobs.verify_delivery(&delivery.id).unwrap();
    retained.dest_path = source.to_string_lossy().into();
    persist_delivery(jobs.journal().unwrap(), &retained).unwrap();
    assert!(owner(&root).publish_delivery(&delivery.id).is_err());
    assert_eq!(std::fs::read(&source).unwrap(), b"original library source");
    assert_eq!(std::fs::read(&delivery.stage_path).unwrap(), b"original library source");
  }
  #[test]
  fn verified_and_unacknowledged_failed_work_keeps_its_source_lease() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("verified-source.wav");
    std::fs::write(&source, b"retained until publication or acknowledged failure").unwrap();
    let jobs = owner(&dir.path().join("journal"));
    let delivery = jobs.prepare_delivery("verified-lease".into(), "original-project".into(),
      dir.path().join("verified.partial").to_string_lossy().into(), dir.path().join("verified.wav").to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_verified_source".into() }).unwrap();
    jobs.copy_delivery(&delivery.id).unwrap();
    jobs.verify_delivery(&delivery.id).unwrap();
    let remove = || std::fs::remove_file(&source).map_err(|error| error.to_string());
    assert!(jobs.with_unleased_path(&source, remove).is_err());
    jobs.fail_delivery(&delivery.id).unwrap();
    assert!(jobs.with_unleased_path(&source, remove).is_err());
    assert_eq!(std::fs::read(&source).unwrap(), b"retained until publication or acknowledged failure");
    jobs.complete_delivery(&delivery.id).unwrap();
    jobs.with_unleased_path(&source, remove).unwrap();
    assert!(!source.exists());
  }
  #[test]
  fn retained_render_rechecks_peer_leases_before_replay() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let source = dir.path().join("replay-input.mp4");
    let destination = dir.path().join("replay-output.mp4");
    std::fs::write(&source, b"unchanged admitted render source").unwrap();
    std::fs::write(&destination, b"later admitted peer source").unwrap();
    let delivery = jobs.prepare_delivery("replay-publisher".into(), "original-project".into(),
      dir.path().join("replay.partial").to_string_lossy().into(), destination.to_string_lossy().into(),
      DeliverySource::Render { paths: vec![source.to_string_lossy().into()] }).unwrap();
    let spec = JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec!["-i".into(), source.to_string_lossy().into(), delivery.stage_path.clone()], steps: Vec::new(), cwd: None,
      meta: serde_json::json!({ "kind": "export", "plan": { "sources": [{ "path": source }] } }) };
    jobs.retain_render_job(&spec).unwrap();
    jobs.prepare_delivery("replay-peer".into(), "original-project".into(),
      dir.path().join("peer.partial").to_string_lossy().into(), dir.path().join("peer.mp4").to_string_lossy().into(),
      DeliverySource::Render { paths: vec![destination.to_string_lossy().into()] }).unwrap();
    let reopened = owner(&root);
    assert!(reopened.retain_render_job(&spec).is_err());
    assert!(reopened.list().is_empty());
    assert_eq!(std::fs::metadata(&delivery.stage_path).unwrap().len(), 0);
    assert_eq!(std::fs::read(&source).unwrap(), b"unchanged admitted render source");
    assert_eq!(std::fs::read(&destination).unwrap(), b"later admitted peer source");
  }
  #[test]
  fn unavailable_peer_source_does_not_block_an_unrelated_ready_publication() {
    let dir = tempfile::tempdir().unwrap();
    let jobs = owner(&dir.path().join("journal"));
    let unavailable = dir.path().join("unavailable.mp4");
    let source = dir.path().join("ready.wav");
    std::fs::write(&unavailable, b"peer input later disappears").unwrap();
    std::fs::write(&source, b"ready verified artifact bytes").unwrap();
    jobs.prepare_delivery("unavailable-peer".into(), "original-project".into(),
      dir.path().join("unavailable.partial").to_string_lossy().into(), dir.path().join("unavailable-result.mp4").to_string_lossy().into(),
      DeliverySource::Render { paths: vec![unavailable.to_string_lossy().into()] }).unwrap();
    let delivery = jobs.prepare_delivery("ready-independent".into(), "original-project".into(),
      dir.path().join("ready.partial").to_string_lossy().into(), dir.path().join("ready-result.wav").to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_ready".into() }).unwrap();
    jobs.copy_delivery(&delivery.id).unwrap();
    jobs.verify_delivery(&delivery.id).unwrap();
    std::fs::write(&delivery.dest_path, b"previous unrelated delivery").unwrap();
    std::fs::remove_file(&unavailable).unwrap();
    jobs.publish_delivery(&delivery.id).unwrap();
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"ready verified artifact bytes");
    assert_eq!(std::fs::read(&source).unwrap(), b"ready verified artifact bytes");
    assert!(jobs.with_unleased_path(dir.path(), || std::fs::remove_dir_all(dir.path()).map_err(|error| error.to_string())).is_err());
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"ready verified artifact bytes");
    assert_eq!(std::fs::read(&source).unwrap(), b"ready verified artifact bytes");
  }
  #[test]
  fn changed_stage_and_journal_failure_do_not_replace_destination() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let delivery = intent(&jobs, dir.path(), "export3");
    render_bytes(&jobs, &delivery, b"verified bytes");
    std::fs::write(&delivery.dest_path, b"preserved old bytes").unwrap();
    jobs.verify_delivery(&delivery.id).unwrap();
    std::fs::write(&delivery.stage_path, b"changed after verify").unwrap();
    assert!(jobs.publish_delivery(&delivery.id).is_err());
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"preserved old bytes");
    std::fs::remove_dir_all(&root).unwrap();
    std::fs::write(&root, b"not a directory").unwrap();
    assert!(jobs.cancel_delivery(&delivery.id).is_err());
    assert_eq!(jobs.delivery_list()[0].state, "verified");
  }
  #[test]
  fn crash_between_rename_and_receipt_reconciles_only_identical_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let delivery = intent(&jobs, dir.path(), "export4");
    render_bytes(&jobs, &delivery, b"complete bytes");
    jobs.verify_delivery(&delivery.id).unwrap();
    std::fs::rename(&delivery.stage_path, &delivery.dest_path).unwrap();
    let reopened = owner(&root);
    assert_eq!(reopened.publish_delivery(&delivery.id).unwrap().state, "published");
    std::fs::write(&delivery.dest_path, b"replaced unrelated destination").unwrap();
    assert!(owner(&root).publish_delivery(&delivery.id).is_err());
  }
  #[test]
  fn rename_won_cannot_be_downgraded_to_cancelled_or_failed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let delivery = intent(&jobs, dir.path(), "rename-won");
    render_bytes(&jobs, &delivery, b"verified complete bytes");
    jobs.verify_delivery(&delivery.id).unwrap();
    {
      let mut entries = jobs.deliveries.lock().unwrap();
      let entry = entries.get_mut(&delivery.id).unwrap(); entry.state = "publishing".into();
      persist_delivery(jobs.journal().unwrap(), entry).unwrap();
    }
    std::fs::rename(&delivery.stage_path, &delivery.dest_path).unwrap();
    assert!(!jobs.fail_delivery(&delivery.id).unwrap());
    assert!(!jobs.cancel_delivery(&delivery.id).unwrap());
    assert_eq!(jobs.delivery_list()[0].state, "published");
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"verified complete bytes");
  }
  #[test]
  fn admitted_dependencies_survive_removal_and_cancel_until_work_settles() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("media_source.mp4");
    std::fs::write(&source, b"owned media needed by queued export").unwrap();
    let journal = tempfile::tempdir().unwrap();
    let root = journal.path().join("journal");
    let jobs = owner(&root);
    let delivery = jobs.prepare_delivery("leased1".into(), "original-project".into(), dir.path().join("render.partial").to_string_lossy().into(),
      dir.path().join("render.mp4").to_string_lossy().into(), DeliverySource::Render { paths: vec![source.to_string_lossy().into()] }).unwrap();
    let remove = || std::fs::remove_file(&source).map_err(|error| error.to_string());
    assert!(jobs.with_unleased_path(&source, remove).is_err());
    assert!(jobs.with_unleased_path(dir.path(), || std::fs::remove_dir_all(dir.path()).map_err(|error| error.to_string())).unwrap_err().contains("leased"));
    assert_eq!(std::fs::read(&source).unwrap(), b"owned media needed by queued export");
    jobs.cancel_delivery(&delivery.id).unwrap();
    assert!(jobs.with_unleased_path(&source, remove).is_err());
    jobs.complete_delivery(&delivery.id).unwrap();
    jobs.with_unleased_path(&source, remove).unwrap();
    assert!(!source.exists());
    assert!(jobs.prepare_delivery("late1".into(), "original-project".into(), dir.path().join("late.partial").to_string_lossy().into(),
      dir.path().join("late.mp4").to_string_lossy().into(), DeliverySource::Render { paths: vec![source.to_string_lossy().into()] }).is_err());
    jobs.with_unleased_path(dir.path(), || std::fs::remove_dir(dir.path()).map_err(|error| error.to_string())).unwrap();
    assert!(!dir.path().exists());
    assert!(root.is_dir());
  }
  #[test]
  fn process_ignoring_cancel_keeps_dependencies_until_its_actual_exit() {
    struct IgnoringSpawner;
    impl Spawner for IgnoringSpawner {
      fn identity(&self, program: &str) -> Result<ArtifactIdentity, String> {
        Ok(ArtifactIdentity { sha256: format!("{:x}", Sha256::digest(program.as_bytes())), size: program.len() as u64 })
      }
      fn spawn(&self, _: &JobSpec, _: Arc<dyn Fn(ProcEvent) + Send + Sync>, _: Arc<Workspace>) -> Result<u32, String> { Ok(123) }
      fn kill(&self, _: &str, _: u32) {}
    }
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("media_kept.mp4");
    std::fs::write(&source, b"must survive ignored cancellation").unwrap();
    let root = dir.path().join("journal");
    let jobs = Supervisor::new(Arc::new(IgnoringSpawner), Arc::new(|_| {})).with_export_root(root).unwrap();
    let delivery = jobs.prepare_delivery("ignore-cancel".into(), "original-project".into(), dir.path().join("result.partial").to_string_lossy().into(),
      dir.path().join("result.mp4").to_string_lossy().into(), DeliverySource::Render { paths: vec![source.to_string_lossy().into()] }).unwrap();
    jobs.submit(JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec!["-i".into(), source.to_string_lossy().into(), delivery.stage_path.clone()], steps: Vec::new(), cwd: None,
      meta: serde_json::json!({"kind":"export", "plan":{"sources":[{"path":source}]}}) }).unwrap();
    std::fs::write(&delivery.stage_path, b"plausible bytes from a still running worker").unwrap();
    assert!(jobs.verify_delivery(&delivery.id).is_err());
    assert!(jobs.kill(&delivery.id));
    assert!(jobs.complete_delivery(&delivery.id).is_err());
    assert!(jobs.with_unleased_path(Path::new(&delivery.stage_path), || std::fs::remove_file(&delivery.stage_path).map_err(|error| error.to_string())).is_err());
    assert!(jobs.with_unleased_path(&source, || std::fs::remove_file(&source).map_err(|error| error.to_string())).is_err());
    assert_eq!(std::fs::read(&source).unwrap(), b"must survive ignored cancellation");
    jobs.finish(&delivery.id, 0, Some(0), None);
    jobs.complete_delivery(&delivery.id).unwrap();
    jobs.with_unleased_path(&source, || std::fs::remove_file(&source).map_err(|error| error.to_string())).unwrap();
    assert!(!source.exists());
  }
  #[test]
  fn copied_source_is_leased_across_owner_recreation_until_cancelled_work_settles() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let source = dir.path().join("imported.wav");
    std::fs::write(&source, b"copied source must remain readable").unwrap();
    let original = owner(&root);
    let delivery = original.prepare_delivery("copy-lease".into(), "original-project".into(), dir.path().join("copy.partial").to_string_lossy().into(),
      dir.path().join("copy.wav").to_string_lossy().into(), DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_copy_lease".into() }).unwrap();
    let reopened = owner(&root);
    let remove = || std::fs::remove_file(&source).map_err(|error| error.to_string());
    assert!(reopened.with_unleased_path(&source, remove).is_err());
    reopened.cancel_delivery(&delivery.id).unwrap();
    assert!(reopened.with_unleased_path(&source, remove).is_err());
    reopened.complete_delivery(&delivery.id).unwrap();
    reopened.with_unleased_path(&source, remove).unwrap();
    assert!(!source.exists());
  }
  #[test]
  fn native_copy_executor_preserves_source_and_delivers_identical_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("library-source.wav");
    let bytes = vec![37u8; 2 * 1024 * 1024 + 17];
    std::fs::write(&source, &bytes).unwrap();
    let jobs = owner(&dir.path().join("journal"));
    let delivery = jobs.prepare_delivery("copy-executor".into(), "original-project".into(), dir.path().join("copy.partial").to_string_lossy().into(),
      dir.path().join("copy.wav").to_string_lossy().into(), DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_source".into() }).unwrap();
    jobs.copy_delivery(&delivery.id).unwrap();
    jobs.verify_delivery(&delivery.id).unwrap();
    jobs.publish_delivery(&delivery.id).unwrap();
    assert_eq!(std::fs::read(&source).unwrap(), bytes);
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), bytes);
    jobs.complete_delivery(&delivery.id).unwrap();
  }

  fn replacement_fixture(copy: bool) -> (tempfile::TempDir, Supervisor, ExportDelivery, JobSpec) {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.wav");
    let destination = directory.path().join("delivered.wav");
    std::fs::write(&source, [37u8; 32]).unwrap();
    std::fs::write(&destination, b"previous complete file").unwrap();
    let mut jobs = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {})).with_export_work_root(directory.path().join("work")).unwrap();
    jobs.workspace = Workspace::new(64);
    let jobs = jobs.with_export_root(directory.path().join("journal")).unwrap();
    let source = if copy { DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_source".into() } }
      else { DeliverySource::Render { paths: vec![source.to_string_lossy().into()] } };
    let delivery = jobs.prepare_delivery("replacement-lifetime".into(), "original-project".into(),
      directory.path().join("result.partial").to_string_lossy().into(), destination.to_string_lossy().into(), source).unwrap();
    let mut spec = JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec!["-f".into(), "nut".into(), "part.nut".into()], steps: vec![], cwd: None, meta: serde_json::json!({}) };
    if !copy {
      let cwd = jobs.stage_render_scratch(&delivery.id,
        vec![RenderScratchFile { name: "filter.ffgraph".into(), content: "null".into() }], vec![]).unwrap();
      let part = Path::new(&cwd).join("part.nut");
      std::fs::write(&part, b"old part").unwrap();
      spec.meta["_native_scratch_capture"] = serde_json::json!({ "path": part, "used": 4, "limit": 64 });
      spec.cwd = Some(cwd);
    }
    (directory, jobs, delivery, spec)
  }

  fn replacement_output(jobs: &Supervisor, delivery: &ExportDelivery, spec: &JobSpec, copy: bool) -> Result<ScratchOutput, String> {
    if copy {
      jobs.copying.lock().unwrap().insert(delivery.id.clone());
      jobs.begin_copy_output(delivery, 32)
    } else {
      ScratchOutput::capture(spec, jobs.workspace.clone()).map(|output| output.unwrap().0)
    }
  }

  #[test]
  fn same_root_retained_extents_block_capture_until_failed_cleanup_settles() {
    let directory = tempfile::tempdir().unwrap();
    let volume = allocation::AllocationUnit::for_directory(directory.path()).unwrap();
    let mut jobs = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {}))
      .with_export_work_root(directory.path().join("work")).unwrap().with_export_root(directory.path().join("journal")).unwrap();
    let delivery = intent(&jobs, directory.path(), "same-root-allocated-capture");
    std::fs::write(&delivery.dest_path, b"previous complete file").unwrap();
    let cwd = jobs.stage_render_scratch(&delivery.id, vec![], vec![]).unwrap();
    let retained_path = Path::new(&cwd).join("retained.nut");
    let retained = allocation::preallocated_fixture(&retained_path, volume);
    let inventory = measured_scratch_usage(Path::new(&cwd), Path::new("")).unwrap();
    let cap = inventory.allocated + volume.bytes();
    jobs.workspace = Workspace::allocation_fixture(64 * volume.bytes(), cap);
    jobs.account_workspace(&jobs.deliveries.lock().unwrap()).unwrap();
    let target = Path::new(&cwd).join("not-admitted.nut");
    let spec = JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec!["-f".into(), "nut".into(), "not-admitted.nut".into()], steps: vec![], cwd: Some(cwd.clone()),
      meta: serde_json::json!({ "_native_scratch_capture": { "path": target, "used": inventory.bytes, "limit": 64 * volume.bytes() } }) };
    assert!(ScratchOutput::capture(&spec, jobs.workspace.clone()).err().unwrap().contains("allocation budget"));
    assert!(!target.exists());
    assert_eq!(std::fs::read(&retained_path).unwrap(), [0x5a]);
    let blocker = CleanupBlocker::open(&retained_path);
    drop(retained);
    jobs.fail_delivery(&delivery.id).unwrap();
    assert!(jobs.complete_delivery(&delivery.id).is_err());
    assert!(retained_path.exists());
    assert!(jobs.workspace.reserve_in("unrelated", volume.bytes() + 1, 1, volume).is_err());
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous complete file");
    drop(blocker);
    jobs.complete_delivery(&delivery.id).unwrap();
    assert!(!Path::new(&cwd).exists());
    assert!(!Path::new(&delivery.stage_path).exists());
    assert_eq!(jobs.workspace.available_bytes(), cap);
  }

  #[test]
  fn native_allocation_pressure_refuses_each_payload_producer_and_cleanup_restores_it() {
    for producer in ["text", "font", "capture", "copy"] {
      let directory = tempfile::tempdir().unwrap();
      let volume = allocation::AllocationUnit::for_directory(directory.path()).unwrap();
      let unit = volume.bytes();
      assert!(unit <= 1024 * 1024, "fixture allocation unit exceeds its bounded write budget");
      let bytes = allocation::fixture_bytes(usize::try_from(unit + 1).unwrap());
      let source = directory.path().join("source.wav");
      let fonts = directory.path().join("bundled-fonts");
      std::fs::create_dir(&fonts).unwrap();
      std::fs::write(fonts.join("Valid.ttf"), &bytes).unwrap();
      std::fs::write(&source, &bytes).unwrap();
      let mut jobs = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {}))
        .with_export_work_root(directory.path().join("work")).unwrap().with_export_font_root(fonts);
      jobs.workspace = Workspace::allocation_fixture(32 * unit, 8 * unit);
      let jobs = jobs.with_export_root(directory.path().join("journal")).unwrap();
      let destination = directory.path().join("delivered.wav");
      std::fs::write(&destination, b"previous complete file").unwrap();
      let delivery = jobs.prepare_delivery(format!("allocated-{producer}"), "original-project".into(),
        directory.path().join("result.partial").to_string_lossy().into(), destination.to_string_lossy().into(),
        if producer == "copy" { DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_source".into() } }
        else { DeliverySource::Render { paths: vec![source.to_string_lossy().into()] } }).unwrap();
      let capture = if producer == "capture" {
        let cwd = jobs.stage_render_scratch(&delivery.id, vec![], vec![]).unwrap();
        let target = Path::new(&cwd).join("part.nut");
        Some(JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
          args: vec!["-f".into(), "nut".into(), "part.nut".into()], steps: vec![], cwd: Some(cwd),
          meta: serde_json::json!({ "_native_scratch_capture": { "path": target, "used": 0, "limit": 32 * unit } }) })
      } else { None };
      let text = bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
      let stage_inputs = || {
        if producer == "font" { (vec![], vec!["Valid.ttf".into()]) }
        else { (vec![RenderScratchFile { name: "filter.ffgraph".into(), content: text.clone() }], vec![]) }
      };
      let peer = intent(&jobs, directory.path(), "allocated-retained-peer");
      let peer_bytes = allocation::fixture_bytes(usize::try_from(6 * unit + 1).unwrap());
      let mut retained = std::fs::OpenOptions::new().write(true).open(&peer.stage_path).unwrap();
      retained.write_all(&peer_bytes).unwrap();
      retained.sync_all().unwrap();
      drop(retained);
      let observed = allocation::usage(Path::new(&peer.stage_path)).unwrap();
      assert!(observed.allocated > observed.bytes, "filesystem did not exhibit allocation rounding");
      jobs.account_workspace(&jobs.deliveries.lock().unwrap()).unwrap();
      let error = match producer {
        "copy" => jobs.copy_delivery(&delivery.id).unwrap_err(),
        "capture" => ScratchOutput::capture(capture.as_ref().unwrap(), jobs.workspace.clone()).err().unwrap(),
        _ => { let (files, fonts) = stage_inputs(); jobs.stage_render_scratch(&delivery.id, files, fonts).unwrap_err() }
      };
      assert!(error.contains("allocation budget"), "{producer}: {error}");
      assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous complete file");
      assert_eq!(std::fs::read(&delivery.stage_path).unwrap(), Vec::<u8>::new());
      assert_eq!(std::fs::read(&peer.stage_path).unwrap(), peer_bytes);
      assert!(!jobs.delivery_list().iter().find(|entry| entry.id == delivery.id).unwrap().producer_complete);
      jobs.fail_delivery(&peer.id).unwrap();
      jobs.complete_delivery(&peer.id).unwrap();
      assert!(!Path::new(&peer.stage_path).exists());
      match producer {
        "copy" => {
          jobs.copy_delivery(&delivery.id).unwrap();
          assert_eq!(std::fs::read(&delivery.stage_path).unwrap(), bytes);
          jobs.verify_delivery(&delivery.id).unwrap();
          jobs.publish_delivery(&delivery.id).unwrap();
          assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), bytes);
        }
        "capture" => {
          let (mut output, _) = ScratchOutput::capture(capture.as_ref().unwrap(), jobs.workspace.clone()).unwrap().unwrap();
          output.write(&bytes).unwrap();
          output.finish(Some(0)).unwrap();
          assert_eq!(std::fs::read(Path::new(capture.as_ref().unwrap().cwd.as_ref().unwrap()).join("part.nut")).unwrap(), bytes);
          jobs.fail_delivery(&delivery.id).unwrap();
        }
        _ => {
          let (files, fonts) = stage_inputs();
          let scratch = jobs.stage_render_scratch(&delivery.id, files, fonts).unwrap();
          if producer == "font" { assert_eq!(std::fs::read(Path::new(&scratch).join("fonts").join("Valid.ttf")).unwrap(), bytes); }
          else { assert_eq!(std::fs::read_to_string(Path::new(&scratch).join("filter.ffgraph")).unwrap(), text); }
          jobs.fail_delivery(&delivery.id).unwrap();
        }
      }
      jobs.complete_delivery(&delivery.id).unwrap();
      assert_eq!(std::fs::read(source).unwrap(), bytes);
      assert_eq!(jobs.workspace.available_bytes(), 8 * unit);
    }
  }

  #[test]
  fn restart_restores_actual_extent_pressure_before_new_copy_work() {
    let directory = tempfile::tempdir().unwrap();
    let volume = allocation::AllocationUnit::for_directory(directory.path()).unwrap();
    let unit = volume.bytes();
    assert!(unit <= 1024 * 1024, "fixture allocation unit exceeds its bounded write budget");
    let journal = directory.path().join("journal");
    let original = owner(&journal);
    let peer = intent(&original, directory.path(), "crashed-allocated-peer");
    let peer_bytes = allocation::fixture_bytes(usize::try_from(6 * unit + 1).unwrap());
    let mut file = std::fs::OpenOptions::new().write(true).open(&peer.stage_path).unwrap();
    file.write_all(&peer_bytes).unwrap();
    file.sync_all().unwrap();
    drop(file);
    let actual = allocation::usage(Path::new(&peer.stage_path)).unwrap();
    assert!(actual.allocated > actual.bytes);
    drop(original);
    let mut restored = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {}));
    restored.workspace = Workspace::allocation_fixture(32 * unit, 8 * unit);
    let restored = restored.with_export_root(journal).unwrap();
    let source = directory.path().join("source.wav");
    let bytes = allocation::fixture_bytes(usize::try_from(unit + 1).unwrap());
    std::fs::write(&source, &bytes).unwrap();
    let stage = directory.path().join("result.partial");
    let destination = directory.path().join("result.wav");
    std::fs::write(&destination, b"previous complete file").unwrap();
    let prepare = || restored.prepare_delivery("copy-after-allocated-restart".into(), "original-project".into(),
      stage.to_string_lossy().into(), destination.to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_source".into() });
    assert!(prepare().unwrap_err().contains("allocation budget"));
    assert!(!stage.exists());
    assert!(!directory.path().join("journal").join("copy-after-allocated-restart.json").exists());
    assert_eq!(std::fs::read(&destination).unwrap(), b"previous complete file");
    assert_eq!(std::fs::read(&peer.stage_path).unwrap(), peer_bytes);
    restored.fail_delivery(&peer.id).unwrap();
    restored.complete_delivery(&peer.id).unwrap();
    let delivery = prepare().unwrap();
    restored.copy_delivery(&delivery.id).unwrap();
    assert_eq!(std::fs::read(&delivery.stage_path).unwrap(), bytes);
    restored.verify_delivery(&delivery.id).unwrap();
    restored.publish_delivery(&delivery.id).unwrap();
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), bytes);
    restored.complete_delivery(&delivery.id).unwrap();
    assert_eq!(restored.workspace.available_bytes(), 8 * unit);
  }

  #[test]
  fn absent_retained_stage_does_not_require_an_unavailable_previous_volume() {
    let directory = tempfile::tempdir().unwrap();
    let journal = directory.path().join("journal");
    let previous_volume = directory.path().join("previous-volume");
    std::fs::create_dir(&previous_volume).unwrap();
    let original = owner(&journal);
    let delivery = intent(&original, &previous_volume, "missing-previous-volume");
    std::fs::remove_file(&delivery.stage_path).unwrap();
    std::fs::remove_dir(&previous_volume).unwrap();
    drop(original);
    let restored = owner(&journal);
    assert_eq!(restored.delivery_list()[0].id, delivery.id);
    let failures = restored.recover_exports();
    assert!(failures.iter().any(|(id, error)| id == &delivery.id && error.contains("render plan")));
    restored.fail_delivery(&delivery.id).unwrap();
    restored.complete_delivery(&delivery.id).unwrap();
    let unrelated = intent(&restored, directory.path(), "available-volume");
    assert!(Path::new(&unrelated.stage_path).is_file());
    restored.fail_delivery(&unrelated.id).unwrap();
    restored.complete_delivery(&unrelated.id).unwrap();
  }

  #[test]
  fn replacement_entry_refusal_cannot_create_capture_or_copy_temporaries() {
    for copy in [false, true] {
      let (directory, jobs, delivery, spec) = replacement_fixture(copy);
      jobs.account_workspace(&jobs.deliveries.lock().unwrap()).unwrap();
      let pressure = jobs.workspace.reserve("entry-pressure", 0, jobs.workspace.available_entries()).unwrap();
      let parent = spec.cwd.as_deref().map(Path::new).unwrap_or(directory.path());
      let clock = journal_write_clock(parent);
      let before = std::fs::read_dir(parent).unwrap().map(|entry| entry.unwrap().file_name()).collect::<HashSet<_>>();
      let error = replacement_output(&jobs, &delivery, &spec, copy).err().unwrap();
      assert!(error.contains("entry budget"), "{error}");
      assert_eq!(std::fs::metadata(parent).unwrap().modified().unwrap(), clock, "refused entry creation touched its parent");
      assert_eq!(std::fs::read_dir(parent).unwrap().map(|entry| entry.unwrap().file_name()).collect::<HashSet<_>>(), before);
      assert!(!jobs.delivery_list()[0].producer_complete);
      assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous complete file");
      drop(pressure);
      let output = replacement_output(&jobs, &delivery, &spec, copy).unwrap();
      let temporary = output.file().path().to_path_buf();
      assert!(temporary.is_file(), "reusable capacity did not create a real temporary");
      drop(output);
      assert!(!temporary.exists());
    }
  }

  #[test]
  fn failed_replacement_cleanup_retains_payload_and_both_errors_through_restart() {
    for copy in [false, true] {
      for failure in ["abort", "install", "drop"] {
        let (directory, jobs, delivery, spec) = replacement_fixture(copy);
        let mut output = replacement_output(&jobs, &delivery, &spec, copy).unwrap();
        output.write(&[41u8; 16]).unwrap();
        let temporary = output.file().path().to_path_buf();
        let blocker = CleanupBlocker::open(&temporary);
        match failure {
          "abort" => {
            let error = output.abort("original producer refusal".into());
            assert!(error.contains("original producer refusal"), "{error}");
            assert!(error.contains("cleanup failed; workspace reservation retained"), "{error}");
          }
          "install" => {
            let error = output.finish(Some(0)).unwrap_err();
            assert!(error.contains("; temporary output cleanup failed; workspace reservation retained"), "{error}");
          }
          _ => drop(output),
        }
        assert_eq!(std::fs::read(&temporary).unwrap(), vec![41u8; 16]);
        assert!(jobs.workspace.reserve("cannot-reuse-retained-payload", 64 - 16 + 1, 1).is_err());
        if let Some(cwd) = &spec.cwd { assert_eq!(std::fs::read(Path::new(cwd).join("part.nut")).unwrap(), b"old part"); }
        assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous complete file");
        drop(jobs);
        let mut reopened = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {}))
          .with_export_work_root(directory.path().join("work")).unwrap();
        reopened.workspace = Workspace::new(15);
        let reopened = reopened.with_export_root(directory.path().join("journal")).unwrap();
        assert!(reopened.workspace.reserve("restart-cannot-reuse", 1, 1).is_err());
        assert_eq!(std::fs::read(&temporary).unwrap(), vec![41u8; 16]);
        reopened.cancel_delivery(&delivery.id).unwrap();
        assert!(reopened.complete_delivery(&delivery.id).is_err(), "failed retirement must not release retained bytes");
        assert!(reopened.workspace.reserve("failed-retirement-cannot-reuse", 1, 1).is_err());
        drop(blocker);
        reopened.complete_delivery(&delivery.id).unwrap();
        assert!(!temporary.exists());
        assert_eq!(reopened.workspace.available_bytes(), 15);
        assert_eq!(std::fs::read(directory.path().join("source.wav")).unwrap(), vec![37u8; 32]);
        assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous complete file");
      }
    }
  }

  #[test]
  fn installed_replacements_keep_only_existing_payload_charged() {
    for copy in [false, true] {
      let (_directory, jobs, delivery, spec) = replacement_fixture(copy);
      let mut output = replacement_output(&jobs, &delivery, &spec, copy).unwrap();
      output.write(&[41u8; 16]).unwrap();
      let temporary = output.file().path().to_path_buf();
      let target = output.target.clone();
      output.finish(Some(0)).unwrap();
      assert!(!temporary.exists());
      assert_eq!(std::fs::read(&target).unwrap(), vec![41u8; 16]);
      let retained = std::fs::metadata(&delivery.stage_path).unwrap().len()
        + spec.cwd.as_deref().map(|cwd| scratch_usage(Path::new(cwd), Path::new("")).unwrap().0).unwrap_or(0);
      assert_eq!(jobs.workspace.available_bytes() + retained, 64, "installed bytes were uncharged or replaced bytes stayed charged");
      let remaining = jobs.workspace.reserve("reused-only-after-install", jobs.workspace.available_bytes(), 1).unwrap();
      assert!(jobs.workspace.reserve("cannot-overbook", 1, 1).is_err());
      drop(remaining);
      assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous complete file");
    }
  }

  #[test]
  fn copy_receipt_before_creation_recovers_a_refused_private_file() {
    let (directory, jobs, delivery, spec) = replacement_fixture(true);
    let pressure = jobs.workspace.reserve("entry-pressure", 0, jobs.workspace.available_entries()).unwrap();
    assert!(replacement_output(&jobs, &delivery, &spec, true).is_err());
    let receipt: ExportDelivery = serde_json::from_slice(&std::fs::read(directory.path().join("journal")
      .join(format!("{}.json", delivery.id))).unwrap()).unwrap();
    let temporary = receipt.copy_scratch_path().unwrap().unwrap().to_path_buf();
    assert!(!temporary.exists());
    assert!(!receipt.producer_complete);
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous complete file");
    drop(pressure);
    drop(jobs);
    let recovered = owner(&directory.path().join("journal"));
    assert!(recovered.recover_exports().is_empty());
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), vec![37u8; 32]);
    assert_eq!(std::fs::read(directory.path().join("source.wav")).unwrap(), vec![37u8; 32]);
    assert!(!temporary.exists());
    assert_eq!(recovered.delivery_list()[0].state, "published");
  }

  #[test]
  fn copy_creation_refuses_an_existing_private_name_without_adopting_it() {
    let (_directory, jobs, delivery, spec) = replacement_fixture(true);
    let temporary = Path::new(&delivery.stage_path).with_file_name(format!("{}pending", delivery.copy_scratch_prefix()));
    std::fs::write(&temporary, b"unowned collision must survive").unwrap();
    assert!(replacement_output(&jobs, &delivery, &spec, true).err().unwrap().contains("namespace is already occupied"));
    assert_eq!(std::fs::read(&temporary).unwrap(), b"unowned collision must survive");
    assert!(jobs.delivery_list()[0].copy_scratch.is_none());
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous complete file");
  }
  #[test]
  fn native_copy_staging_shares_scratch_capacity_until_publication() {
    for size in [33usize, 32] {
      let directory = tempfile::tempdir().unwrap();
      let source = directory.path().join("source.wav");
      let destination = directory.path().join("delivered.wav");
      let peer = directory.path().join("retained-scratch");
      let bytes = vec![37u8; size];
      std::fs::write(&source, &bytes).unwrap();
      std::fs::write(&destination, b"previous complete file").unwrap();
      std::fs::write(&peer, [41u8; 32]).unwrap();
      let mut jobs = owner(&directory.path().join("journal"));
      jobs.workspace = Workspace::new(64);
      jobs.workspace.account_existing("peer", 32, 1).unwrap();
      let delivery = jobs.prepare_delivery("shared-copy-budget".into(), "original-project".into(),
        directory.path().join("copy.partial").to_string_lossy().into(), destination.to_string_lossy().into(),
        DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_source".into() }).unwrap();
      let copied = jobs.copy_delivery(&delivery.id);
      if size > 32 {
        assert!(copied.is_err(), "copy ignored scratch retained by another export");
        assert_eq!(std::fs::metadata(&delivery.stage_path).unwrap().len(), 0);
        assert_eq!(std::fs::read(&destination).unwrap(), b"previous complete file");
        assert_eq!(jobs.workspace.available_bytes(), 32);
      } else {
        copied.unwrap();
        assert_eq!(std::fs::read(&delivery.stage_path).unwrap(), bytes);
        let scratch = directory.path().join("blocked.nut");
        let mut blocked = ScratchOutput::open_workspace(&scratch, 0, 64, jobs.workspace.clone(), "blocked").unwrap();
        assert!(blocked.write(b"x").is_err(), "pending copy stopped counting before publication");
        drop(blocked);
        assert!(!scratch.exists());
        jobs.verify_delivery(&delivery.id).unwrap();
        jobs.publish_delivery(&delivery.id).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), bytes);
        assert_eq!(jobs.workspace.available_bytes(), 32);
      }
      assert_eq!(std::fs::read(&source).unwrap(), bytes);
      assert_eq!(std::fs::read(&peer).unwrap(), vec![41u8; 32]);
    }
  }
  #[test]
  fn caller_cannot_inject_native_output_or_execution_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let jobs = owner(&directory.path().join("journal"));
    let output = directory.path().join("must-not-be-written.mp4");
    for field in ["_native_final_stage", "_native_execution_deadline", "_native_scratch_capture", "_native_future_guard"] {
      let mut meta = serde_json::json!({ "kind": "export" });
      meta[field] = serde_json::Value::Null;
      let submitted = jobs.submit(JobSpec { id: field.into(), lane: "export".into(), program: "ffmpeg".into(),
        args: vec!["-f".into(), "mp4".into(), output.to_string_lossy().into()], steps: vec![], cwd: None, meta });
      assert!(submitted.unwrap_err().contains("native execution metadata is reserved"));
      assert!(jobs.list().is_empty());
      assert!(jobs.delivery_list().is_empty());
      assert!(!output.exists());
    }
    jobs.submit(JobSpec { id: "legitimate-metadata".into(), lane: "working".into(), program: "ffmpeg".into(),
      args: vec!["-version".into()], steps: vec![], cwd: None,
      meta: serde_json::json!({ "description": "_native_final_stage", "nested": { "_native_example": true } }) }).unwrap();
    assert_eq!(jobs.list().len(), 1);
    assert!(!output.exists());
  }
  #[test]
  fn retained_pending_output_overage_survives_restart_without_admitting_more_writes() {
    let directory = tempfile::tempdir().unwrap();
    let journal = directory.path().join("journal");
    let work = directory.path().join("work");
    let jobs = owner_with_work(&journal, work.clone());
    let delivery = jobs.prepare_delivery("interrupted-output-overage".into(), "original-project".into(),
      directory.path().join("render.partial").to_string_lossy().into(), directory.path().join("render.mp4").to_string_lossy().into(),
      DeliverySource::Render { paths: vec![] }).unwrap();
    let scratch = jobs.stage_render_scratch(&delivery.id,
      vec![RenderScratchFile { name: "filter.ffgraph".into(), content: "null".into() }], vec![]).unwrap();
    std::fs::write(&delivery.dest_path, b"previous complete file").unwrap();
    std::fs::write(&delivery.stage_path, [37u8; 72]).unwrap();
    drop(jobs);
    let mut recovered = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {}));
    recovered.workspace = Workspace::new(64);
    let recovered = recovered.with_export_work_root(work).unwrap().with_export_root(journal)
      .expect("an interrupted output must remain visible and cleanable");
    assert_eq!(recovered.delivery_list().len(), 1);
    assert_eq!(recovered.workspace.available_bytes(), 0);
    assert!(recovered.workspace.reserve("peer", 1, 1).is_err());
    assert!(recovered.verify_delivery(&delivery.id).is_err());
    assert!(recovered.publish_delivery(&delivery.id).is_err());
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous complete file");
    assert_eq!(std::fs::read(&delivery.stage_path).unwrap(), vec![37u8; 72]);
    recovered.cancel_delivery(&delivery.id).unwrap();
    recovered.complete_delivery(&delivery.id).unwrap();
    assert!(!Path::new(&delivery.stage_path).exists());
    assert!(!Path::new(&scratch).exists());
    assert_eq!(recovered.workspace.available_bytes(), 64);
    recovered.workspace.reserve("peer", 64, 1).unwrap().retain();
  }
  #[test]
  fn queued_preparation_waits_for_output_cleanup_and_cancellation_remains_available() {
    for (copying, cancelled) in [(false, false), (false, true), (true, false), (true, true)] {
      let directory = tempfile::tempdir().unwrap();
      let mut jobs = owner_with_work(&directory.path().join("journal"), directory.path().join("work"));
      jobs.workspace = Workspace::new(64);
      let active = jobs.prepare_delivery("active-output".into(), "original-project".into(),
        directory.path().join("active.partial").to_string_lossy().into(), directory.path().join("active.mp4").to_string_lossy().into(),
        DeliverySource::Render { paths: vec![] }).unwrap();
      let source = directory.path().join("source.wav");
      std::fs::write(&source, [71u8; 16]).unwrap();
      let queued = jobs.prepare_delivery("queued-output".into(), "original-project".into(),
        directory.path().join("queued.partial").to_string_lossy().into(), directory.path().join("queued.mp4").to_string_lossy().into(),
        if copying { DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_source".into() } }
        else { DeliverySource::Render { paths: vec![] } }).unwrap();
      std::fs::write(&queued.dest_path, b"previous complete file").unwrap();
      jobs.account_workspace(&jobs.deliveries.lock().unwrap()).unwrap();
      jobs.claim_export_output(&active.id).unwrap().retain();
      let key = Supervisor::workspace_key(Path::new(&active.stage_path));
      let (limit, charge) = jobs.workspace.reserve_output(&key).unwrap();
      assert_eq!(limit, 64);
      std::fs::write(&active.stage_path, [37u8; 32]).unwrap();
      charge.retain();
      let waiting = jobs.clone();
      let queued_id = queued.id.clone();
      let (sender, receiver) = std::sync::mpsc::channel();
      let worker = std::thread::spawn(move || {
        let result = if copying { waiting.copy_delivery(&queued_id).map(|()| String::new()) }
          else { waiting.stage_render_scratch(&queued_id, vec![RenderScratchFile { name: "filter.ffgraph".into(), content: "null".into() }], vec![]) };
        sender.send(result).unwrap();
      });
      assert!(matches!(receiver.recv_timeout(std::time::Duration::from_millis(100)), Err(std::sync::mpsc::RecvTimeoutError::Timeout)),
        "queued work consumed or refused another output's reserved capacity");
      assert!(jobs.delivery_list().iter().find(|entry| entry.id == queued.id).unwrap().execution_queued_at_ms.is_some());
      assert!(jobs.delivery_list().iter().find(|entry| entry.id == queued.id).unwrap().render_scratch.is_none());
      assert_eq!(std::fs::read(&queued.dest_path).unwrap(), b"previous complete file");
      if cancelled {
        jobs.cancel_delivery(&queued.id).unwrap();
        assert!(receiver.recv_timeout(std::time::Duration::from_secs(2)).unwrap().is_err());
        assert_eq!(jobs.workspace.available_bytes(), 0);
      }
      jobs.cancel_delivery(&active.id).unwrap();
      jobs.complete_delivery(&active.id).unwrap();
      assert!(!Path::new(&active.stage_path).exists());
      if !cancelled {
        let result = receiver.recv_timeout(std::time::Duration::from_secs(2)).unwrap().unwrap();
        if copying {
          assert_eq!(std::fs::read(&queued.stage_path).unwrap(), vec![71u8; 16]);
          assert_eq!(jobs.workspace.available_bytes(), 48);
          jobs.verify_delivery(&queued.id).unwrap();
          jobs.publish_delivery(&queued.id).unwrap();
        } else {
          assert_eq!(std::fs::read(Path::new(&result).join("filter.ffgraph")).unwrap(), b"null");
          jobs.cancel_delivery(&queued.id).unwrap();
        }
      }
      worker.join().unwrap();
      jobs.complete_delivery(&queued.id).unwrap();
      assert_eq!(jobs.workspace.available_bytes(), 64);
      assert_eq!(std::fs::read(&source).unwrap(), vec![71u8; 16]);
      if cancelled { assert_eq!(std::fs::read(&queued.dest_path).unwrap(), b"previous complete file"); }
    }
  }
  #[test]
  fn copy_staging_restart_restores_private_payload_charge_and_cleans_after_cancellation() {
    let directory = tempfile::tempdir().unwrap();
    let journal = directory.path().join("journal");
    let source = directory.path().join("source.wav");
    let destination = directory.path().join("delivered.wav");
    std::fs::write(&source, [37u8; 32]).unwrap();
    std::fs::write(&destination, b"previous complete file").unwrap();
    let mut jobs = owner(&journal);
    jobs.workspace = Workspace::new(64);
    let delivery = jobs.prepare_delivery("copy-restart-payload".into(), "original-project".into(),
      directory.path().join("copy.partial").to_string_lossy().into(), destination.to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_source".into() }).unwrap();
    jobs.copying.lock().unwrap().insert(delivery.id.clone());
    let mut output = jobs.begin_copy_output(&delivery, 32).unwrap();
    output.write(&[41u8; 16]).unwrap();
    let retained = jobs.delivery_list().into_iter().find(|entry| entry.id == delivery.id).unwrap().copy_scratch.unwrap();
    let (file, charge) = output.owned.take().unwrap();
    let (file, path) = file.keep().unwrap();
    drop(file);
    charge.retain();
    drop(output);
    assert_eq!(Path::new(&retained), path.as_path());
    drop(jobs);
    let mut reopened = Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {}));
    reopened.workspace = Workspace::new(64);
    let reopened = reopened.with_export_root(journal).unwrap();
    assert_eq!(reopened.workspace.available_bytes(), 48);
    assert_eq!(std::fs::read(&retained).unwrap(), vec![41u8; 16]);
    reopened.cancel_delivery(&delivery.id).unwrap();
    reopened.complete_delivery(&delivery.id).unwrap();
    assert!(!Path::new(&retained).exists());
    assert!(!Path::new(&delivery.stage_path).exists());
    assert_eq!(reopened.workspace.available_bytes(), 64);
    assert_eq!(std::fs::read(&source).unwrap(), vec![37u8; 32]);
    assert_eq!(std::fs::read(&destination).unwrap(), b"previous complete file");
  }

  #[test]
  fn copy_staging_journal_refusal_leaves_no_payload_or_unowned_temporary_file() {
    let directory = tempfile::tempdir().unwrap();
    let journal = directory.path().join("journal");
    let source = directory.path().join("source.wav");
    let destination = directory.path().join("delivered.wav");
    std::fs::write(&source, [37u8; 32]).unwrap();
    std::fs::write(&destination, b"previous complete file").unwrap();
    let mut jobs = owner(&journal);
    jobs.workspace = Workspace::new(64);
    let delivery = jobs.prepare_delivery("copy-journal-refused".into(), "original-project".into(),
      directory.path().join("copy.partial").to_string_lossy().into(), destination.to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_source".into() }).unwrap();
    jobs.copying.lock().unwrap().insert(delivery.id.clone());
    let saved = directory.path().join("saved-journal");
    std::fs::rename(&journal, &saved).unwrap();
    std::fs::write(&journal, b"journal unavailable").unwrap();
    assert!(jobs.begin_copy_output(&delivery, 32).is_err());
    assert!(saved.join(format!("{}.json", delivery.id)).exists());
    assert_eq!(std::fs::metadata(&delivery.stage_path).unwrap().len(), 0);
    assert!(!std::fs::read_dir(directory.path()).unwrap().any(|entry|
      entry.unwrap().file_name().to_string_lossy().starts_with(&delivery.copy_scratch_prefix())));
    assert_eq!(jobs.workspace.available_bytes(), 64);
    assert_eq!(std::fs::read(&source).unwrap(), vec![37u8; 32]);
    assert_eq!(std::fs::read(&destination).unwrap(), b"previous complete file");
  }

  #[test]
  fn replaced_copy_stage_cannot_truncate_its_admitted_source() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.wav");
    let bytes = vec![67u8; 1024 * 1024 + 31];
    std::fs::write(&source, &bytes).unwrap();
    let jobs = owner(&dir.path().join("journal"));
    let delivery = jobs.prepare_delivery("copy-stage-alias".into(), "original-project".into(),
      dir.path().join("copy.partial").to_string_lossy().into(), dir.path().join("copy.wav").to_string_lossy().into(),
      DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_source".into() }).unwrap();
    std::fs::remove_file(&delivery.stage_path).unwrap();
    std::fs::hard_link(&source, &delivery.stage_path).unwrap();
    jobs.copy_delivery(&delivery.id).unwrap();
    assert!(std::fs::read(&source).unwrap() == bytes, "every original source byte must survive stage replacement");
    jobs.verify_delivery(&delivery.id).unwrap();
    jobs.publish_delivery(&delivery.id).unwrap();
    assert!(std::fs::read(&delivery.dest_path).unwrap() == bytes, "every copied byte must reach the destination");
  }
  #[test]
  fn cancelled_previous_process_releases_lease_without_restarting_work() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let source = dir.path().join("media_cancelled.mp4");
    std::fs::write(&source, b"cancelled source bytes").unwrap();
    let original = owner(&root);
    let delivery = original.prepare_delivery("cancelled-reopen".into(), "original-project".into(), dir.path().join("render.partial").to_string_lossy().into(),
      dir.path().join("render.mp4").to_string_lossy().into(), DeliverySource::Render { paths: vec![source.to_string_lossy().into()] }).unwrap();
    original.cancel_delivery(&delivery.id).unwrap();
    let reopened = owner(&root);
    assert!(reopened.recover_exports().is_empty());
    assert!(reopened.list().is_empty());
    assert_eq!(reopened.delivery_list()[0].state, "cancelled");
    assert!(reopened.delivery_list()[0].followups_done);
    reopened.with_unleased_path(&source, || std::fs::remove_file(&source).map_err(|error| error.to_string())).unwrap();
    assert!(!source.exists());
    assert!(!Path::new(&delivery.dest_path).exists());
  }
  #[test]
  fn changed_retained_command_cannot_replay_even_when_sources_match() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let source = dir.path().join("source.mp4");
    std::fs::write(&source, b"unchanged source bytes").unwrap();
    let jobs = owner(&root);
    let delivery = intent(&jobs, dir.path(), "command-identity");
    let spec = JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec!["-i".into(), source.to_string_lossy().into(), delivery.stage_path.clone()], steps: Vec::new(), cwd: None,
      meta: serde_json::json!({"kind":"export", "plan":{"sources":[{"path":source}]}}) };
    jobs.retain_render_job(&spec).unwrap();
    let mut changed = jobs.delivery_list()[0].clone();
    changed.render_job.as_mut().unwrap().args.insert(0, "-an".into());
    persist_delivery(jobs.journal().unwrap(), &changed).unwrap();
    let reopened = owner(&root);
    let failures = reopened.recover_exports();
    assert_eq!(failures.len(), 1);
    assert!(failures[0].1.contains("command identity changed"));
    assert_eq!(reopened.list().len(), 1);
    assert_eq!(reopened.list()[0].state, JobState::Exited);
    assert_ne!(reopened.list()[0].code, Some(0));
    assert!(reopened.list()[0].stderr_head.contains("command identity changed"));
    assert_eq!(std::fs::read(&source).unwrap(), b"unchanged source bytes");
    assert!(!Path::new(&delivery.dest_path).exists());
  }
  #[test]
  fn changed_or_unbound_worker_cannot_replay_the_admitted_edit() {
    struct BoundWorker { path: PathBuf, started: Arc<std::sync::atomic::AtomicUsize> }
    impl Spawner for BoundWorker {
      fn identity(&self, _: &str) -> Result<ArtifactIdentity, String> { artifact_identity(&self.path) }
      fn spawn(&self, _: &JobSpec, _: Arc<dyn Fn(ProcEvent) + Send + Sync>, _: Arc<Workspace>) -> Result<u32, String> {
        self.started.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err("test worker must never start".into())
      }
      fn kill(&self, _: &str, _: u32) {}
    }
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let binary = dir.path().join("worker.bin");
    std::fs::write(&binary, b"admitted worker version one").unwrap();
    let started = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let make_owner = || Supervisor::new(Arc::new(BoundWorker { path: binary.clone(), started: started.clone() }), Arc::new(|_| {}))
      .with_export_root(root.clone()).unwrap();
    let jobs = make_owner();
    let delivery = intent(&jobs, dir.path(), "worker-bound");
    let source = dir.path().join("source.mp4");
    std::fs::write(&source, b"unchanged source bytes").unwrap();
    let spec = JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec!["-i".into(), source.to_string_lossy().into(), delivery.stage_path.clone()], steps: Vec::new(), cwd: None,
      meta: serde_json::json!({ "kind": "export", "plan": { "sources": [{ "path": source }] } }) };
    jobs.retain_render_job(&spec).unwrap();
    let admitted = jobs.delivery_list()[0].worker_identity.clone().unwrap();
    std::fs::write(&binary, b"different worker version two").unwrap();
    assert_ne!(artifact_identity(&binary).unwrap().sha256, admitted.sha256);
    let reopened = make_owner();
    let failures = reopened.recover_exports();
    assert!(failures.iter().any(|(_, error)| error.contains("worker identity changed")));
    assert_eq!(reopened.list().len(), 1);
    assert_eq!(reopened.list()[0].state, JobState::Exited);
    assert_ne!(reopened.list()[0].code, Some(0));
    assert!(reopened.list()[0].stderr_head.contains("worker identity changed"));
    assert_eq!(started.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert_eq!(std::fs::metadata(&delivery.stage_path).unwrap().len(), 0);
    assert!(!Path::new(&delivery.dest_path).exists());
    std::fs::write(&binary, b"admitted worker version one").unwrap();
    let mut legacy = jobs.delivery_list()[0].clone();
    legacy.worker_identity = None;
    persist_delivery(jobs.journal().unwrap(), &legacy).unwrap();
    let legacy_owner = make_owner();
    assert!(legacy_owner.recover_exports().iter().any(|(_, error)| error.contains("no supported worker identity")));
    assert_eq!(started.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(!Path::new(&delivery.dest_path).exists());
  }
  #[test]
  fn restart_replays_only_unchanged_sources_once_and_never_cancelled_work() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let delivery = intent(&jobs, dir.path(), "recover1");
    let source = dir.path().join("source.mp4");
    std::fs::write(&source, b"original source identity").unwrap();
    let spec = JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec!["-i".into(), source.to_string_lossy().into(), delivery.stage_path.clone()], steps: vec![], cwd: None,
      meta: serde_json::json!({ "kind": "export", "plan": { "sources": [{ "path": source }] } }) };
    jobs.retain_render_job(&spec).unwrap();
    let reopened = owner(&root);
    assert!(reopened.recover_exports().is_empty());
    assert_eq!(reopened.delivery_list()[0].recovery_attempts, 1);
    assert_eq!(reopened.list().len(), 1);
    assert!(!owner(&root).recover_exports().is_empty());
    jobs.cancel_delivery(&delivery.id).unwrap();
    assert!(owner(&root).recover_exports().is_empty());
    assert_eq!(owner(&root).list().len(), 0);
  }
  #[test]
  fn cancellation_during_dependency_reads_persists_before_the_reader_returns() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;
    struct HeldDependency {
      entered: mpsc::Sender<()>,
      release: Mutex<mpsc::Receiver<()>>,
      starts: Arc<AtomicUsize>,
      ignore_cancellation: bool,
    }
    impl Spawner for HeldDependency {
      fn identity(&self, program: &str) -> Result<ArtifactIdentity, String> { NoSpawn.identity(program) }
      fn dependency_identity(&self, path: &Path, check: &dyn Fn() -> Result<(), String>) -> Result<ArtifactIdentity, String> {
        self.entered.send(()).map_err(|error| error.to_string())?;
        self.release.lock().unwrap().recv().map_err(|error| error.to_string())?;
        if self.ignore_cancellation { artifact_identity(path) } else { artifact_identity_checked(path, check) }
      }
      fn spawn(&self, _: &JobSpec, _: Arc<dyn Fn(ProcEvent) + Send + Sync>, _: Arc<Workspace>) -> Result<u32, String> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        Err("cancelled dependencies must never start a producer".into())
      }
      fn kill(&self, _: &str, _: u32) {}
    }
    for ignore_cancellation in [false, true] {
      let dir = tempfile::tempdir().unwrap();
      let root = dir.path().join("journal");
      let source = dir.path().join("source.mp4");
      std::fs::write(&source, b"original dependency bytes").unwrap();
      let (entered, reading) = mpsc::channel();
      let (release, resume) = mpsc::channel();
      let starts = Arc::new(AtomicUsize::new(0));
      let jobs = Supervisor::new(Arc::new(HeldDependency { entered, release: Mutex::new(resume), starts: starts.clone(), ignore_cancellation }),
        Arc::new(|_| {})).with_export_root(root.clone()).unwrap();
      let delivery = intent(&jobs, dir.path(), "cancel-reading");
      std::fs::write(&delivery.dest_path, b"previous complete destination").unwrap();
      let spec = JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
        args: vec!["-i".into(), source.to_string_lossy().into(), delivery.stage_path.clone()], steps: vec![], cwd: None,
        meta: serde_json::json!({"kind":"export"}) };
      let binder = jobs.clone();
      let binding = std::thread::spawn(move || binder.submit(spec));
      reading.recv_timeout(Duration::from_secs(5)).expect("dependency reader was not reached");
      let canceller = jobs.clone();
      let id = delivery.id.clone();
      let (cancelled, acknowledged) = mpsc::channel();
      let cancellation = std::thread::spawn(move || { cancelled.send(canceller.cancel_delivery(&id)).unwrap(); });
      let outcome = acknowledged.recv_timeout(Duration::from_secs(5));
      release.send(()).unwrap();
      let bound = binding.join().unwrap();
      cancellation.join().unwrap();
      assert_eq!(outcome.expect("cancellation waited for the blocked dependency reader").unwrap(), true);
      assert!(bound.is_err(), "cancelled dependency read was admitted");
      assert_eq!(starts.load(Ordering::SeqCst), 0);
      let persisted: ExportDelivery = serde_json::from_slice(&std::fs::read(root.join("cancel-reading.json")).unwrap()).unwrap();
      assert_eq!(persisted.state, "cancelled");
      assert!(persisted.render_job.is_none());
      assert!(!persisted.producer_complete);
      assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous complete destination");
      assert_eq!(std::fs::read(source).unwrap(), b"original dependency bytes");
      assert_eq!(std::fs::metadata(delivery.stage_path).unwrap().len(), 0);
    }
  }

  #[test]
  fn worker_replacement_blocks_queued_start_and_later_sequence_steps() {
    type Callback = Arc<dyn Fn(ProcEvent) + Send + Sync>;
    struct HeldWorker {
      path: PathBuf,
      started: Arc<Mutex<Vec<String>>>,
      callbacks: Arc<Mutex<HashMap<String, Callback>>>,
    }
    impl Spawner for HeldWorker {
      fn identity(&self, _: &str) -> Result<ArtifactIdentity, String> { artifact_identity(&self.path) }
      fn spawn(&self, spec: &JobSpec, callback: Callback, _: Arc<Workspace>) -> Result<u32, String> {
        self.started.lock().unwrap().push(spec.id.clone());
        self.callbacks.lock().unwrap().insert(spec.id.clone(), callback);
        Ok(123)
      }
      fn kill(&self, _: &str, _: u32) {}
    }
    let dir = tempfile::tempdir().unwrap();
    let binary = dir.path().join("worker.bin");
    let source = dir.path().join("source.mp4");
    std::fs::write(&source, b"unchanged input").unwrap();
    std::fs::write(&binary, b"original worker").unwrap();
    let started = Arc::new(Mutex::new(Vec::new()));
    let callbacks = Arc::new(Mutex::new(HashMap::<String, Callback>::new()));
    let jobs = Supervisor::new(Arc::new(HeldWorker { path: binary.clone(), started: started.clone(), callbacks: callbacks.clone() }), Arc::new(|_| {}))
      .with_export_work_root(dir.path().join("work")).unwrap().with_export_root(dir.path().join("journal")).unwrap();
    let held = intent(&jobs, dir.path(), "lane-holder");
    let blocker = JobSpec { id: held.id, lane: "export".into(), program: "ffmpeg".into(), args: vec![held.stage_path], steps: vec![], cwd: None,
      meta: serde_json::json!({}) };
    jobs.submit(blocker).unwrap();
    let queued = intent(&jobs, dir.path(), "queued-bound");
    let spec = JobSpec { id: queued.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec!["-i".into(), source.to_string_lossy().into(), queued.stage_path.clone()], steps: vec![], cwd: None,
      meta: serde_json::json!({ "kind": "export", "plan": { "sources": [{ "path": source }] } }) };
    jobs.submit(spec).unwrap();
    std::fs::write(&binary, b"replacement before queued start").unwrap();
    let release = callbacks.lock().unwrap().get("lane-holder").unwrap().clone();
    release(ProcEvent::Exit(Some(0)));
    let queued_view = jobs.list().into_iter().find(|job| job.id == queued.id).unwrap();
    assert_eq!(queued_view.state, JobState::Exited);
    assert_ne!(queued_view.code, Some(0));
    assert!(queued_view.stderr_head.contains("worker identity changed"));
    assert_eq!(*started.lock().unwrap(), vec!["lane-holder".to_string()]);
    assert!(!Path::new(&queued.dest_path).exists());
    std::fs::write(&binary, b"original worker").unwrap();
    let sequence = intent(&jobs, dir.path(), "sequence-bound");
    let scratch = PathBuf::from(jobs.stage_render_scratch(&sequence.id, vec![], vec![]).unwrap());
    let sequence_spec = JobSpec { id: sequence.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec!["-i".into(), source.to_string_lossy().into(), "-f".into(), "nut".into(), "first-part.nut".into()],
      steps: vec![vec!["-i".into(), source.to_string_lossy().into(), sequence.stage_path.clone()]], cwd: Some(scratch.to_string_lossy().into()),
      meta: serde_json::json!({ "kind": "export", "plan": { "sources": [{ "path": source }] } }) };
    jobs.submit(sequence_spec).unwrap();
    std::fs::write(&binary, b"replacement between sequence steps").unwrap();
    let finish_first = callbacks.lock().unwrap().get(&sequence.id).unwrap().clone();
    finish_first(ProcEvent::Exit(Some(0)));
    let sequence_view = jobs.list().into_iter().find(|job| job.id == sequence.id).unwrap();
    assert_eq!(sequence_view.state, JobState::Exited);
    assert_ne!(sequence_view.code, Some(0));
    assert_eq!(started.lock().unwrap().iter().filter(|id| *id == &sequence.id).count(), 1);
    assert!(!Path::new(&sequence.dest_path).exists());
    assert_eq!(std::fs::metadata(&sequence.stage_path).unwrap().len(), 0);
  }
  #[test]
  fn changed_source_or_staged_font_blocks_recovery_without_output() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let jobs = owner_with_work(&root, dir.path().join("work"));
    let delivery = intent(&jobs, dir.path(), "changed1");
    let source = dir.path().join("source.mp4");
    let scratch = PathBuf::from(jobs.stage_render_scratch(&delivery.id,
      vec![RenderScratchFile { name: "font.ttf".into(), content: "original font".into() }], vec![]).unwrap());
    let font = scratch.join("font.ttf");
    std::fs::write(&source, b"original source").unwrap();
    std::fs::write(&font, b"original font").unwrap();
    let spec = JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec!["-i".into(), source.to_string_lossy().into(), delivery.stage_path.clone()], steps: vec![],
      cwd: Some(scratch.to_string_lossy().into()), meta: serde_json::json!({ "kind": "export", "plan": { "sources": [{ "path": source }] } }) };
    jobs.retain_render_job(&spec).unwrap();
    std::fs::write(&font, b"changed font").unwrap();
    let reopened = owner_with_work(&root, dir.path().join("work"));
    assert!(!reopened.recover_exports().is_empty());
    assert_eq!(reopened.list().len(), 1);
    assert_eq!(reopened.list()[0].state, JobState::Exited);
    assert_ne!(reopened.list()[0].code, Some(0));
    assert_eq!(reopened.list()[0].meta["projectDir"], "original-project");
    assert!(reopened.list()[0].stderr_head.contains("staged input changed"));
    assert_eq!(std::fs::metadata(&delivery.stage_path).unwrap().len(), 0);
    std::fs::write(&font, b"original font").unwrap();
    std::fs::write(&source, b"changed source").unwrap();
    let reopened = owner_with_work(&root, dir.path().join("work"));
    assert!(!reopened.recover_exports().is_empty());
    assert_eq!(reopened.list().len(), 1);
    assert_eq!(reopened.list()[0].state, JobState::Exited);
    assert_ne!(reopened.list()[0].code, Some(0));
    assert!(reopened.list()[0].stderr_head.contains("source changed"));
    assert!(!Path::new(&delivery.dest_path).exists());
    std::fs::write(&delivery.stage_path, b"success-looking rendered bytes").unwrap();
    assert!(jobs.verify_delivery(&delivery.id).is_err());
  }
  #[test]
  fn copied_library_bytes_recover_under_the_same_identity_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let source = dir.path().join("imported.wav");
    std::fs::write(&source, b"complete library asset bytes").unwrap();
    let jobs = owner(&root);
    let delivery = jobs.prepare_delivery("copy1".into(), "original-project".into(), dir.path().join("copy.partial").to_string_lossy().into(),
      dir.path().join("copy.wav").to_string_lossy().into(), DeliverySource::Copy { path: source.to_string_lossy().into(), media_ref: "media_imported".into() }).unwrap();
    std::fs::write(&delivery.stage_path, b"incomplete copy").unwrap();
    assert!(jobs.verify_delivery(&delivery.id).is_err());
    let recovered = owner(&root);
    assert!(recovered.recover_exports().is_empty());
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"complete library asset bytes");
    assert_eq!(recovered.delivery_list()[0].state, "published");
    assert_eq!(recovered.list()[0].meta["copyOf"], "media_imported");
  }
  #[test]
  fn completed_receipt_cleans_only_owned_scratch_and_does_not_readopt() {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    let scratch = work.join("renderer").join("caps-owned");
    std::fs::create_dir_all(&scratch).unwrap();
    std::fs::write(scratch.join("caption.ass"), b"caption").unwrap();
    let root = dir.path().join("journal");
    let jobs = owner_with_work(&root, work);
    let delivery = intent(&jobs, dir.path(), "retire1");
    render_bytes(&jobs, &delivery, b"verified bytes");
    jobs.verify_delivery(&delivery.id).unwrap();
    jobs.publish_delivery(&delivery.id).unwrap();
    {
      let mut entries = jobs.deliveries.lock().unwrap();
      let entry = entries.get_mut(&delivery.id).unwrap();
      entry.render_job = Some(JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
        args: vec![], steps: vec![], cwd: Some(scratch.to_string_lossy().into()), meta: serde_json::json!({"kind":"export"}) });
    }
    jobs.complete_delivery(&delivery.id).unwrap();
    assert!(!scratch.exists());
    assert!(Path::new(&delivery.dest_path).exists());
    let reopened = owner(&root);
    assert!(reopened.recover_exports().is_empty());
    assert!(reopened.list().is_empty());
  }
  #[test]
  #[ignore = "requires the shipped ffmpeg artifact fixture"]
  fn final_mp4_staging_cannot_bypass_shared_payload_budget() {
    struct RealSpawner(PathBuf, stream::Registry);
    impl Spawner for RealSpawner {
      fn identity(&self, _: &str) -> Result<ArtifactIdentity, String> { artifact_identity(&self.0) }
      fn spawn(&self, spec: &JobSpec, notify: Arc<dyn Fn(ProcEvent) + Send + Sync>, workspace: Arc<Workspace>) -> Result<u32, String> {
        stream::spawn_single(&self.0, spec, notify, self.1.clone(), workspace)
      }
      fn spawn_stream(&self, spec: &JobSpec, notify: Arc<dyn Fn(ProcEvent) + Send + Sync>,
        guard: stream::StartGuard, workspace: Arc<Workspace>) -> Result<u32, String> {
        stream::spawn(&self.0, spec, notify, guard, self.1.clone(), workspace)
      }
      fn kill(&self, id: &str, pid: u32) { assert!(stream::cancel(&self.1, id, pid)); }
    }
    let binary = PathBuf::from(std::env::var("ARTDADDY_QA_FFMPEG").expect("shipped binary supplied"));
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.mp4");
    let fixture = std::process::Command::new(&binary).args(["-y", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i",
      "testsrc2=s=640x360:r=30:d=2", "-f", "lavfi", "-i", "sine=frequency=523:sample_rate=48000:duration=2",
      "-vf", "noise=alls=30:allf=t+u", "-af", "pan=stereo|c0=c0|c1=0.25*c0", "-c:a", "alac", "-c:v", "libx264", "-threads", "1",
      "-crf", "18", "-pix_fmt", "yuv420p"]).arg(&source).output().unwrap();
    assert!(fixture.status.success(), "{}", String::from_utf8_lossy(&fixture.stderr));
    let original = artifact_identity(&source).unwrap();
    assert!(original.size > 64 * 1024 && original.size < 16 * 1024 * 1024);
    for (streamed, replayed, budget) in [(false, false), (true, false), (false, true), (true, true)].into_iter()
      .flat_map(|(streamed, replayed)| [16 * 1024 * 1024, 64 * 1024].map(move |budget| (streamed, replayed, budget))) {
      let (sender, receiver) = std::sync::mpsc::channel();
      let mut jobs = Supervisor::new(Arc::new(RealSpawner(binary.clone(), Arc::default())), Arc::new(move |notice| {
        if let Notice::Changed(view) = notice {
          if view.state == JobState::Exited { let _ = sender.send(view); }
        }
      })).with_export_work_root(dir.path().join(format!("work-{streamed}-{replayed}-{budget}"))).unwrap()
        .with_export_root(dir.path().join(format!("journal-{streamed}-{replayed}-{budget}"))).unwrap();
      jobs.workspace = Workspace::new(budget);
      let delivery = jobs.prepare_delivery(format!("bounded-mp4-{budget}"), "original-project".into(),
        dir.path().join(format!("stage-{budget}.partial")).to_string_lossy().into(),
        dir.path().join(format!("delivered-{budget}.mp4")).to_string_lossy().into(),
        DeliverySource::Render { paths: vec![source.to_string_lossy().into()] }).unwrap();
      std::fs::write(&delivery.dest_path, b"previous complete file").unwrap();
      let mut spec = JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
        args: vec!["-y".into(), "-nostdin".into(), "-loglevel".into(), "error".into(), "-i".into(), source.to_string_lossy().into(),
          "-c".into(), "copy".into(), "-f".into(), "mp4".into(), delivery.stage_path.clone()], steps: vec![], cwd: None,
        meta: serde_json::json!({ "kind": "export", "plan": { "sources": [{ "path": source }] } }) };
      if streamed {
        spec.cwd = Some(jobs.stage_render_scratch(&delivery.id, vec![RenderScratchFile { name: "segments.ffconcat".into(),
          content: "ffconcat version 1.0\nfile 'part0.nut'\nduration 1\nfile 'part1.nut'\nduration 1\n".into() }], vec![]).unwrap());
        let producer = |start: &str, name: &str| vec!["-y".into(), "-nostdin".into(), "-loglevel".into(), "error".into(),
          "-ss".into(), start.into(), "-i".into(), source.to_string_lossy().into(), "-t".into(), "1".into(),
          "-an".into(), "-c:v".into(), "ffv1".into(), "-threads".into(), "1".into(), "-f".into(), "nut".into(), name.into()];
        spec.args = producer("0", "part0.nut");
        spec.steps = vec![producer("1", "part1.nut"), vec!["-y".into(), "-nostdin".into(), "-loglevel".into(), "error".into(),
          "-f".into(), "concat".into(), "-safe".into(), "1".into(), "-i".into(), "segments.ffconcat".into(),
          "-i".into(), "audio.nut".into(), "-map".into(), "0:v:0".into(), "-map".into(), "1:a:0".into(),
          "-c:a".into(), "alac".into(), "-c:v".into(), "libx264".into(), "-threads".into(), "1".into(), "-crf".into(), "0".into(),
          "-f".into(), "mp4".into(), delivery.stage_path.clone()]];
        spec.meta["renderTransport"] = serde_json::json!("partition-pipes-v1");
        spec.meta["renderAudio"] = serde_json::json!({ "duration": 2.0, "args": ["-nostdin", "-loglevel", "error",
          "-i", source, "-map", "0:a:0", "-vn", "-ac", "2", "-ar", "48000", "-t", "2", "-c:a", "pcm_f64le", "-f", "nut", "audio.nut"] });
      }
      if replayed {
        jobs.retain_render_job(&spec).unwrap();
        let mut recovered = Supervisor::new(jobs.spawner.clone(), jobs.notify.clone());
        recovered.workspace = Workspace::new(budget);
        recovered = recovered.with_export_work_root(jobs.export_work_root.clone().unwrap()).unwrap()
          .with_export_root(jobs.export_root.clone().unwrap()).unwrap();
        drop(jobs);
        jobs = recovered;
        assert!(jobs.recover_exports().is_empty());
        assert_eq!(jobs.delivery_list()[0].recovery_attempts, 1);
      } else { jobs.submit(spec).unwrap(); }
      let ended = receiver.recv_timeout(std::time::Duration::from_secs(30)).unwrap();
      let diagnostics = {
        let state = jobs.lock();
        let job = &state.jobs[&delivery.id];
        format!("{}{}", job.stderr_head, job.stderr)
      };
      assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous complete file");
      assert_eq!(artifact_identity(&source).unwrap().sha256, original.sha256);
      let retained_scratch = jobs.delivery_list().into_iter().find(|entry| entry.id == delivery.id).unwrap().render_scratch
        .map(|scratch| scratch_usage(Path::new(&scratch.path), Path::new("")).unwrap().0).unwrap_or(0);
      let staged_bytes = std::fs::metadata(&delivery.stage_path).map(|metadata| metadata.len()).unwrap_or(0);
      assert_eq!(jobs.workspace.available_bytes(), budget.saturating_sub(retained_scratch + staged_bytes),
        "terminal output released its private bytes or invented used capacity before publication");
      if budget < original.size {
        assert_ne!(ended.code, Some(0), "pending MP4 output bypassed the shared workspace: {diagnostics}");
        let boundary = diagnostics.lines().find_map(|line| line.split_once("native output write boundary refused completion: ")
          .map(|(_, boundary)| boundary))
          .unwrap_or_else(|| panic!("bounded output lost its write-boundary failure: {diagnostics}"));
        let boundary: serde_json::Value = serde_json::from_str(boundary).unwrap();
        assert!(boundary["observed"].as_u64().unwrap() <= boundary["limit"].as_u64().unwrap());
        assert!(boundary["limit"].as_u64().unwrap() <= budget);
        assert_eq!(boundary["cleaned"], true);
        println!("pending MP4 budget: streamed={streamed}, replayed={replayed}, allowance={budget}, {}",
          boundary);
        assert!(!Path::new(&delivery.stage_path).exists(), "size-stopped private output was not cleaned");
        assert!(jobs.verify_delivery(&delivery.id).is_err());
        assert!(jobs.publish_delivery(&delivery.id).is_err());
      } else {
        assert_eq!(ended.code, Some(0), "{diagnostics}");
        let queued = jobs.prepare_delivery(format!("next-project-{budget}"), "another-project".into(),
          dir.path().join(format!("next-{streamed}-{replayed}.partial")).to_string_lossy().into(),
          dir.path().join(format!("next-{streamed}-{replayed}.mp4")).to_string_lossy().into(), DeliverySource::Render { paths: vec![] }).unwrap();
        let waiting = jobs.clone();
        let queued_id = queued.id.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
          sender.send(waiting.stage_render_scratch(&queued_id,
            vec![RenderScratchFile { name: "filter.ffgraph".into(), content: "null".into() }], vec![])).unwrap();
        });
        let prepared = receiver.recv_timeout(std::time::Duration::from_secs(2));
        if prepared.is_err() {
          jobs.cancel_delivery(&delivery.id).unwrap();
          jobs.complete_delivery(&delivery.id).unwrap();
          worker.join().unwrap();
          panic!("a completed output blocked another project's usable remaining capacity before acknowledgement");
        }
        let next_scratch = prepared.unwrap().unwrap();
        assert_eq!(std::fs::read(Path::new(&next_scratch).join("filter.ffgraph")).unwrap(), b"null");
        jobs.cancel_delivery(&queued.id).unwrap();
        jobs.complete_delivery(&queued.id).unwrap();
        worker.join().unwrap();
        let decode = |path: &Path| std::process::Command::new(&binary).args(["-v", "error", "-i"]).arg(path)
          .args(["-map", "0:v:0", "-an", "-f", "framemd5", "pipe:1"]).output().unwrap();
        let expected = decode(&source);
        let staged = decode(Path::new(&delivery.stage_path));
        assert!(expected.status.success() && staged.status.success());
        assert_eq!(staged.stdout, expected.stdout);
        let audio = |path: &Path| std::process::Command::new(&binary).args(["-v", "error", "-i"]).arg(path)
          .args(["-map", "0:a:0", "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_f64le", "-f", "f64le", "pipe:1"]).output().unwrap();
        let original_audio = audio(&source);
        let staged_audio = audio(Path::new(&delivery.stage_path));
        assert!(original_audio.status.success() && staged_audio.status.success());
        assert_eq!(original_audio.stdout.len(), 96_000 * 2 * 8);
        assert_eq!(staged_audio.stdout, original_audio.stdout);
        jobs.verify_delivery(&delivery.id).unwrap();
        jobs.publish_delivery(&delivery.id).unwrap();
      }
      if ended.code != Some(0) { jobs.fail_delivery(&delivery.id).unwrap(); }
      jobs.complete_delivery(&delivery.id).unwrap();
      assert!(!Path::new(&delivery.stage_path).exists());
      assert_eq!(jobs.workspace.available_bytes(), budget);
    }
  }
  #[test]
  #[ignore = "requires the shipped ffmpeg artifact fixture"]
  fn crash_recovery_renders_and_publishes_a_real_video() {
    struct RealSpawner(PathBuf);
    impl Spawner for RealSpawner {
      fn identity(&self, _: &str) -> Result<ArtifactIdentity, String> { artifact_identity(&self.0) }
      fn spawn(&self, spec: &JobSpec, notify: Arc<dyn Fn(ProcEvent) + Send + Sync>, _: Arc<Workspace>) -> Result<u32, String> {
        let output = std::process::Command::new(&self.0).args(&spec.args).output().map_err(|error| error.to_string())?;
        notify(ProcEvent::Stderr(String::from_utf8_lossy(&output.stderr).into_owned()));
        notify(ProcEvent::Exit(output.status.code()));
        Ok(1)
      }
      fn kill(&self, _: &str, _: u32) {}
    }
    let binary = PathBuf::from(std::env::var("ARTDADDY_QA_FFMPEG").expect("shipped binary supplied"));
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("journal");
    let source = dir.path().join("source.mp4");
    let fixture = std::process::Command::new(&binary).args(["-y", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i",
      "testsrc2=s=320x180:r=30:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p"]).arg(&source).output().unwrap();
    assert!(fixture.status.success(), "{}", String::from_utf8_lossy(&fixture.stderr));
    let original = Supervisor::new(Arc::new(RealSpawner(binary.clone())), Arc::new(|_| {})).with_export_root(root.clone()).unwrap();
    let delivery = intent(&original, dir.path(), "real-recovery");
    std::fs::write(&delivery.dest_path, b"old destination must survive until publication").unwrap();
    let spec = JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec!["-y".into(), "-nostdin".into(), "-loglevel".into(), "error".into(), "-i".into(), source.to_string_lossy().into(),
        "-c".into(), "copy".into(), "-f".into(), "mp4".into(), delivery.stage_path.clone()], steps: vec![], cwd: None,
      meta: serde_json::json!({ "kind": "export", "plan": { "sources": [{ "path": source }] } }) };
    original.retain_render_job(&spec).unwrap();
    drop(original);
    let recovered = Supervisor::new(Arc::new(RealSpawner(binary.clone())), Arc::new(|_| {})).with_export_root(root.clone()).unwrap();
    assert!(recovered.recover_exports().is_empty());
    assert_eq!(recovered.list()[0].code, Some(0));
    assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"old destination must survive until publication");
    let probe = binary.with_file_name("artdaddy-ffprobe-x86_64-pc-windows-msvc.exe");
    let output = std::process::Command::new(probe).args(["-v", "error", "-count_frames", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,nb_read_frames", "-of", "json"]).arg(&delivery.stage_path).output().unwrap();
    assert!(output.status.success());
    let metadata: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(metadata["streams"][0]["width"], 320);
    assert_eq!(metadata["streams"][0]["height"], 180);
    assert_eq!(metadata["streams"][0]["nb_read_frames"], "30");
    let verified = recovered.verify_delivery(&delivery.id).unwrap();
    recovered.publish_delivery(&delivery.id).unwrap();
    assert_eq!(artifact_identity(Path::new(&delivery.dest_path)).unwrap().sha256, verified.identity.unwrap().sha256);
    assert!(!Path::new(&delivery.stage_path).exists());
    let original_identity = artifact_identity(&source).unwrap();
    let protected = recovered.prepare_delivery("real-source-protection".into(), "original-project".into(),
      dir.path().join("protected.partial").to_string_lossy().into(), source.to_string_lossy().into(),
      DeliverySource::Render { paths: Vec::new() }).unwrap();
    let spec = JobSpec { id: protected.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec!["-y".into(), "-nostdin".into(), "-loglevel".into(), "error".into(), "-i".into(), source.to_string_lossy().into(),
        "-c".into(), "copy".into(), "-f".into(), "mp4".into(), protected.stage_path.clone()], steps: Vec::new(), cwd: None,
      meta: serde_json::json!({ "kind": "export", "plan": { "sources": [{ "path": source }] } }) };
    assert!(recovered.submit(spec).is_err(), "metadata-bound inputs must refuse before the worker starts");
    assert_eq!(artifact_identity(&source).unwrap().sha256, original_identity.sha256);
    assert_eq!(std::fs::metadata(&protected.stage_path).unwrap().len(), 0);
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::{AtomicU32, Ordering};

  type Hook = Box<dyn Fn(&JobSpec, &Arc<dyn Fn(ProcEvent) + Send + Sync>) + Send + Sync>;

  /// Records spawns and kills; a test drives each process's output and exit by hand.
  #[derive(Default)]
  struct Fake {
    next_pid: AtomicU32,
    spawned: Mutex<Vec<(String, u32)>>,
    killed: Mutex<Vec<u32>>,
    events: Mutex<HashMap<String, Arc<dyn Fn(ProcEvent) + Send + Sync>>>,
    fail: Mutex<Vec<String>>,
    during_spawn: Mutex<Option<Hook>>,
  }

  impl Spawner for Fake {
    fn identity(&self, program: &str) -> Result<ArtifactIdentity, String> {
      Ok(ArtifactIdentity { sha256: format!("{:x}", Sha256::digest(program.as_bytes())), size: program.len() as u64 })
    }
    fn spawn(
      &self,
      spec: &JobSpec,
      on_event: Arc<dyn Fn(ProcEvent) + Send + Sync>,
      _workspace: Arc<Workspace>,
    ) -> Result<u32, String> {
      if self.fail.lock().unwrap().contains(&spec.id) {
        return Err("no such file".into());
      }
      let pid = 100 + self.next_pid.fetch_add(1, Ordering::SeqCst);
      self.spawned.lock().unwrap().push((spec.id.clone(), pid));
      self.events.lock().unwrap().insert(spec.id.clone(), on_event.clone());
      if let Some(hook) = self.during_spawn.lock().unwrap().as_ref() {
        hook(spec, &on_event);
      }
      Ok(pid)
    }
    fn kill(&self, _id: &str, pid: u32) {
      self.killed.lock().unwrap().push(pid);
    }
  }

  impl Fake {
    fn emit(&self, id: &str, ev: ProcEvent) {
      let f = self.events.lock().unwrap().get(id).cloned().expect("spawned");
      f(ev);
    }
    fn spawned_ids(&self) -> Vec<String> {
      self.spawned.lock().unwrap().iter().map(|(id, _)| id.clone()).collect()
    }
    fn pid_of(&self, id: &str) -> u32 {
      self.spawned.lock().unwrap().iter().find(|(i, _)| i == id).unwrap().1
    }
  }

  fn sup() -> (Supervisor, Arc<Fake>) {
    let fake = Arc::new(Fake::default());
    (Supervisor::new(fake.clone(), Arc::new(|_| {})), fake)
  }

  fn spec(id: &str) -> JobSpec {
    JobSpec {
      id: id.into(),
      lane: "working".into(),
      program: "ffmpeg".into(),
      args: vec!["-i".into(), "in.mp4".into()],
      steps: Vec::new(),
      cwd: None,
      meta: serde_json::json!({ "dest": format!("{id}.mp4") }),
    }
  }

  fn state(s: &Supervisor, id: &str) -> JobView {
    s.list().into_iter().find(|j| j.id == id).expect("listed")
  }

  #[test]
  fn a_lane_runs_one_job_at_a_time_in_the_order_they_came() {
    let (s, fake) = sup();
    assert_eq!(s.submit(spec("a")).unwrap(), 0);
    assert_eq!(s.submit(spec("b")).unwrap(), 1);
    assert_eq!(s.submit(spec("c")).unwrap(), 2);
    assert_eq!(fake.spawned_ids(), ["a"]);
    assert_eq!(state(&s, "b").state, JobState::Queued);
    fake.emit("a", ProcEvent::Exit(Some(0)));
    assert_eq!(fake.spawned_ids(), ["a", "b"]);
    fake.emit("b", ProcEvent::Exit(Some(1)));
    assert_eq!(fake.spawned_ids(), ["a", "b", "c"]);
    let a = state(&s, "a");
    assert_eq!((a.state, a.code, a.killed), (JobState::Exited, Some(0), false));
    assert_eq!(state(&s, "b").code, Some(1));
  }

  #[test]
  fn a_render_sequence_is_one_job_until_its_final_output_ends() {
    let (s, fake) = sup();
    let mut sequence = spec("parts");
    sequence.steps = vec![vec!["second".into()], vec!["assemble".into()]];
    s.submit(sequence).unwrap();
    s.submit(spec("next")).unwrap();
    let first = fake.events.lock().unwrap()["parts"].clone();
    fake.emit("parts", ProcEvent::Exit(Some(0)));
    assert_eq!(state(&s, "parts").state, JobState::Running);
    assert!(!s.commit("parts"));
    first(ProcEvent::Exit(Some(0)));
    first(ProcEvent::Stderr("late old-step error".into()));
    assert_eq!(fake.spawned_ids(), ["parts", "parts"]);
    fake.emit("parts", ProcEvent::Exit(Some(0)));
    assert_eq!(state(&s, "next").state, JobState::Queued);
    fake.emit("parts", ProcEvent::Exit(Some(0)));
    assert_eq!(state(&s, "parts").state, JobState::Exited);
    assert_eq!(fake.spawned_ids(), ["parts", "parts", "parts", "next"]);
    assert!(!state(&s, "parts").stderr_head.contains("late old-step error"));
  }

  #[test]
  fn a_failed_or_cancelled_render_part_never_runs_assembly() {
    for cancelled in [false, true] {
      let (s, fake) = sup();
      let mut sequence = spec("parts");
      sequence.steps = vec![vec!["second".into()], vec!["assemble".into()]];
      s.submit(sequence).unwrap();
      fake.emit("parts", ProcEvent::Exit(Some(0)));
      if cancelled {
        assert!(s.kill("parts"));
      }
      fake.emit("parts", ProcEvent::Exit(Some(if cancelled { 0 } else { 1 })));
      assert_eq!(state(&s, "parts").state, JobState::Exited);
      assert_eq!(state(&s, "parts").killed, cancelled);
      assert_eq!(fake.spawned_ids(), ["parts", "parts"]);
    }
  }

  #[test]
  fn a_final_assembly_failure_and_a_continuation_spawn_failure_remain_failures() {
    for spawn_failure in [false, true] {
      let (s, fake) = sup();
      let mut sequence = spec("parts");
      sequence.steps = vec![vec!["assemble".into()]];
      s.submit(sequence).unwrap();
      if spawn_failure {
        fake.fail.lock().unwrap().push("parts".into());
      }
      fake.emit("parts", ProcEvent::Exit(Some(0)));
      if !spawn_failure {
        fake.emit("parts", ProcEvent::Exit(Some(1)));
      }
      let result = state(&s, "parts");
      assert_eq!(result.state, JobState::Exited);
      assert_ne!(result.code, Some(0));
      assert!(format!("{}{}", result.stderr_head, result.stderr_tail).contains("render step 2 of 2 failed"));
    }
  }

  #[test]
  fn a_render_sequence_can_finish_before_each_spawn_returns() {
    struct Immediate(AtomicU32);
    impl Spawner for Immediate {
      fn identity(&self, program: &str) -> Result<ArtifactIdentity, String> {
        Ok(ArtifactIdentity { sha256: format!("{:x}", Sha256::digest(program.as_bytes())), size: program.len() as u64 })
      }
      fn spawn(&self, _spec: &JobSpec, event: Arc<dyn Fn(ProcEvent) + Send + Sync>, _: Arc<Workspace>) -> Result<u32, String> {
        let pid = self.0.fetch_add(1, Ordering::SeqCst);
        event(ProcEvent::Exit(Some(0)));
        Ok(pid)
      }
      fn kill(&self, _id: &str, _pid: u32) {
        panic!("an exited render must not be killed");
      }
    }
    let spawner = Arc::new(Immediate(AtomicU32::new(100)));
    let supervisor = Supervisor::new(spawner.clone(), Arc::new(|_| {}));
    let mut sequence = spec("immediate");
    sequence.steps = vec![vec!["second".into()], vec!["assemble".into()]];
    supervisor.submit(sequence).unwrap();
    assert_eq!(state(&supervisor, "immediate").code, Some(0));
    assert_eq!(state(&supervisor, "immediate").state, JobState::Exited);
    assert_eq!(spawner.0.load(Ordering::SeqCst), 103);
  }

  #[test]
  fn cancellation_between_render_steps_prevents_the_next_spawn() {
    let fake = Arc::new(Fake::default());
    let owner = Arc::new(Mutex::new(None::<Supervisor>));
    let handle = owner.clone();
    let s = Supervisor::new(fake.clone(), Arc::new(move |notice| {
      if let Notice::Stdout { id, chunk } = notice {
        if chunk == "artdaddy_step=1\n" {
          handle.lock().unwrap().as_ref().unwrap().kill(&id);
        }
      }
    }));
    *owner.lock().unwrap() = Some(s.clone());
    let mut sequence = spec("parts");
    sequence.steps = vec![vec!["assemble".into()]];
    s.submit(sequence).unwrap();
    fake.emit("parts", ProcEvent::Exit(Some(0)));
    assert!(state(&s, "parts").killed);
    assert_eq!(fake.spawned_ids(), ["parts"], "cancelled continuation must not spawn");
  }

  #[test]
  fn export_resource_snapshot_measures_existing_volumes_without_creating_output() {
    let root = tempfile::tempdir().unwrap();
    let destination = root.path().join("not-created").join("movie.mp4");
    let workspace = Workspace::new(10_000);
    workspace.account_existing("retained", 123, 1).unwrap();
    let measured = export_resources(&destination, Some(root.path()), &workspace);
    assert_eq!(measured.budgets.temporary_bytes, 9877);
    assert_eq!(measured.budgets.memory_bytes, budget::RENDER_RESIDENT_LIMIT);
    assert_eq!(measured.budgets.execution_seconds * 1000, EXPORT_EXECUTION_LIMIT_MS);
    assert!(measured.total_memory_bytes.is_some_and(|bytes| bytes > 1024 * 1024 * 1024));
    assert!(measured.available_memory_bytes.unwrap() <= measured.total_memory_bytes.unwrap());
    assert!(measured.destination_free_bytes.is_some_and(|bytes| bytes > 0), "{measured:?}");
    assert_eq!(measured.scratch_free_bytes, measured.destination_free_bytes);
    assert!(!destination.exists());
    assert!(!destination.parent().unwrap().exists());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    let unknown = export_resources(Path::new("relative-output.mp4"), None, &workspace);
    assert!(unknown.destination_free_bytes.is_none());
    assert!(unknown.scratch_free_bytes.is_none());
    println!("native resource snapshot: {}", serde_json::to_string(&measured).unwrap());
  }

  #[test]
  #[ignore = "invoked by exportRange.smoke.e2e.ts with a private real-ffmpeg fixture"]
  fn render_sequence_real_artifact() {
    struct RealSpawner(String, stream::Registry);
    impl Spawner for RealSpawner {
      fn identity(&self, _: &str) -> Result<ArtifactIdentity, String> { artifact_identity(Path::new(&self.0)) }
      fn spawn(&self, spec: &JobSpec, on_event: Arc<dyn Fn(ProcEvent) + Send + Sync>, workspace: Arc<Workspace>) -> Result<u32, String> {
        let (mut capture, args) = match ScratchOutput::capture(spec, workspace)? {
          Some((capture, args)) => (Some(capture), args),
          None => (None, spec.args.clone()),
        };
        let mut child = std::process::Command::new(&self.0)
          .args(&args)
          .current_dir(spec.cwd.as_ref().ok_or("real render needs a private cwd")?)
          .stdout(std::process::Stdio::piped())
          .stderr(std::process::Stdio::piped())
          .spawn().map_err(|error| error.to_string())?;
        let pid = child.id();
        let mut stdout = child.stdout.take().ok_or("missing fixture stdout")?;
        let mut stderr = child.stderr.take().ok_or("missing fixture stderr")?;
        std::thread::spawn(move || {
          let errors = on_event.clone();
          let stderr_reader = std::thread::spawn(move || -> std::io::Result<()> {
            let mut buffer = [0u8; 65536];
            loop {
              let count = stderr.read(&mut buffer)?;
              if count == 0 { return Ok(()); }
              errors(ProcEvent::Stderr(String::from_utf8_lossy(&buffer[..count]).into_owned()));
            }
          });
          let copied = (|| -> Result<(), String> {
            let mut buffer = [0u8; 65536];
            loop {
              let count = stdout.read(&mut buffer).map_err(|error| error.to_string())?;
              if count == 0 { return Ok(()); }
              if let Some(writer) = capture.as_mut() { writer.write(&buffer[..count])?; }
              else { on_event(ProcEvent::Stdout(String::from_utf8_lossy(&buffer[..count]).into_owned())); }
            }
          })();
          if copied.is_err() { let _ = crate::kill_tree(pid); }
          let mut code = child.wait().ok().and_then(|status| status.code());
          let stderr_ok = stderr_reader.join().is_ok_and(|result| result.is_ok());
          if let Err(error) = copied {
            on_event(ProcEvent::Stderr(error));
            code = None;
          }
          if !stderr_ok { code = None; }
          if let Some(writer) = capture {
            if let Err(error) = writer.finish(code) { on_event(ProcEvent::Stderr(error)); code = None; }
          }
          on_event(ProcEvent::Exit(code));
        });
        Ok(pid)
      }
      fn spawn_stream(&self, spec: &JobSpec, on_event: Arc<dyn Fn(ProcEvent) + Send + Sync>,
        guard: stream::StartGuard, workspace: Arc<Workspace>) -> Result<u32, String> {
        stream::spawn(Path::new(&self.0), spec, on_event, guard, self.1.clone(), workspace)
      }
      fn kill(&self, id: &str, pid: u32) {
        if stream::cancel(&self.1, id, pid) { return; }
        crate::kill_tree(pid).expect("kill real render");
      }
    }
    let file = std::env::var("ARTDADDY_QA_RENDER_SPEC").expect("private fixture spec");
    let binary = std::env::var("ARTDADDY_QA_FFMPEG").expect("shipped ffmpeg");
    let mut spec: JobSpec = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    let trace = std::env::var("ARTDADDY_QA_RENDER_TRACE").unwrap_or_default();
    if trace == "1" || trace == "debug" {
      let producer_steps = spec.steps.len().saturating_sub(1);
      for args in std::iter::once(&mut spec.args).chain(spec.steps.iter_mut().take(producer_steps)) {
        if let Some(option) = args.iter().position(|arg| arg == "-loglevel") {
          args[option + 1] = if trace == "debug" { "debug" } else { "verbose" }.into();
        } else { args.splice(0..0, ["-loglevel".into(), if trace == "debug" { "debug" } else { "verbose" }.into()]); }
        if trace == "debug" { args.insert(0, "-debug_ts".into()); }
      }
    }
    let fixture = PathBuf::from(spec.cwd.as_ref().expect("fixture input directory"));
    assert_eq!(spec.program, "ffmpeg");
    assert!(!spec.steps.is_empty(), "the fixture must exercise a real sequence");
    let journal = tempfile::tempdir().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    let supervisor = Supervisor::new(Arc::new(RealSpawner(binary, Arc::default())), Arc::new(move |notice| {
      if let Notice::Changed(view) = notice {
        if view.state == JobState::Exited {
          sender.send(view).unwrap();
        }
      }
    })).with_export_work_root(journal.path().join("work")).unwrap().with_export_font_root(fixture.join("fonts"))
      .with_export_root(journal.path().join("journal")).unwrap();
    let stage = PathBuf::from(spec.steps.last().and_then(|args| args.last()).expect("sequence final output"));
    let destination = stage.with_file_name("native-sequence-delivered.mkv");
    let dependencies: Vec<String> = spec.meta.get("dependencies").map(|value| serde_json::from_value(value.clone()).unwrap()).unwrap_or_default();
    supervisor.prepare_delivery(spec.id.clone(), "fixture-project".into(), stage.to_string_lossy().into(), destination.to_string_lossy().into(),
      DeliverySource::Render { paths: dependencies }).unwrap();
    let mut files = Vec::new();
    for entry in std::fs::read_dir(&fixture).unwrap() {
      let entry = entry.unwrap();
      if entry.file_type().unwrap().is_file() && entry.file_name() != "native-spec.json" {
        files.push(RenderScratchFile { name: entry.file_name().to_string_lossy().into(), content: std::fs::read_to_string(entry.path()).unwrap() });
      }
    }
    let fonts = if fixture.join("fonts").is_dir() { std::fs::read_dir(fixture.join("fonts")).unwrap()
      .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect() } else { Vec::new() };
    spec.cwd = Some(supervisor.stage_render_scratch(&spec.id, files, fonts).unwrap());
    let expected_steps = if is_streamed(&spec) { 0 } else { spec.steps.len() };
    let id = spec.id.clone();
    let wait_ms = std::env::var("ARTDADDY_QA_RENDER_WAIT_MS").ok()
      .map(|value| value.parse::<u64>().expect("private fixture wait must be milliseconds")).unwrap_or(120_000);
    assert!((1_000..=120_000).contains(&wait_ms));
    supervisor.submit(spec).unwrap();
    let result = match receiver.recv_timeout(std::time::Duration::from_millis(wait_ms)) {
      Ok(result) => result,
      Err(error) => {
        let before = supervisor.list().into_iter().find(|view| view.id == id).expect("owned fixture still exists");
        supervisor.kill(&id);
        let stopped = receiver.recv_timeout(std::time::Duration::from_secs(10)).expect("timed-out fixture workers settled after cancellation");
        panic!("real render ended: {error}; last progress={}\nsettled diagnostics={}\n{}",
          before.stdout_tail, stopped.stderr_head, stopped.stderr_tail);
      }
    };
    assert_eq!(result.code, Some(0), "{}\n{}", result.stderr_head, result.stderr_tail);
    assert!(!result.killed);
    assert_eq!(result.step, expected_steps);
  }

  #[test]
  fn separate_lanes_do_not_wait_for_each_other() {
    let (s, fake) = sup();
    s.submit(spec("a")).unwrap();
    s.submit(JobSpec { lane: "other".into(), ..spec("b") }).unwrap();
    assert_eq!(fake.spawned_ids(), ["a", "b"]);
  }

  #[test]
  fn cancelling_a_queued_job_means_it_never_starts() {
    let (s, fake) = sup();
    s.submit(spec("a")).unwrap();
    s.submit(spec("b")).unwrap();
    assert!(s.kill("b"));
    let b = state(&s, "b");
    assert_eq!((b.state, b.killed, b.code), (JobState::Exited, true, None));
    fake.emit("a", ProcEvent::Exit(Some(0)));
    assert_eq!(fake.spawned_ids(), ["a"], "the cancelled job must not start");
    assert!(fake.killed.lock().unwrap().is_empty());
  }

  #[test]
  fn cancelling_a_running_job_kills_its_process_and_it_reads_killed() {
    let (s, fake) = sup();
    s.submit(spec("a")).unwrap();
    s.submit(spec("b")).unwrap();
    assert!(s.kill("a"));
    assert_eq!(*fake.killed.lock().unwrap(), [fake.pid_of("a")]);
    assert_eq!(state(&s, "a").state, JobState::Running, "ended only by its process exiting");
    fake.emit("a", ProcEvent::Exit(Some(255)));
    let a = state(&s, "a");
    assert_eq!((a.state, a.killed, a.code), (JobState::Exited, true, Some(255)));
    assert_eq!(fake.spawned_ids(), ["a", "b"], "the next job starts after the killed one ends");
  }

  #[test]
  fn cancel_wins_over_a_normal_exit_it_raced() {
    let (s, fake) = sup();
    s.submit(spec("a")).unwrap();
    assert!(s.kill("a"));
    fake.emit("a", ProcEvent::Exit(Some(0)));
    assert!(state(&s, "a").killed, "the user cancelled it; the file must not be delivered");
  }

  #[test]
  fn a_cancel_before_the_pid_is_known_still_kills_the_process() {
    let fake = Arc::new(Fake::default());
    let s = Supervisor::new(fake.clone(), Arc::new(|_| {}));
    let s2 = s.clone();
    *fake.during_spawn.lock().unwrap() = Some(Box::new(move |spec, _| {
      assert!(s2.kill(&spec.id));
    }));
    s.submit(spec("a")).unwrap();
    assert_eq!(*fake.killed.lock().unwrap(), [fake.pid_of("a")]);
  }

  #[test]
  fn an_exit_that_arrives_before_spawn_returns_is_kept() {
    let fake = Arc::new(Fake::default());
    *fake.during_spawn.lock().unwrap() = Some(Box::new(|_, on_event| on_event(ProcEvent::Exit(Some(0)))));
    let s = Supervisor::new(fake.clone(), Arc::new(|_| {}));
    s.submit(spec("a")).unwrap();
    let a = state(&s, "a");
    assert_eq!((a.state, a.code), (JobState::Exited, Some(0)));
    s.submit(spec("b")).unwrap();
    assert_eq!(fake.spawned_ids(), ["a", "b"], "the lane is free again");
  }

  #[test]
  fn a_job_that_cannot_start_ends_with_the_reason_and_the_next_one_runs() {
    let (s, fake) = sup();
    fake.fail.lock().unwrap().push("a".into());
    s.submit(spec("a")).unwrap();
    s.submit(spec("b")).unwrap();
    let a = state(&s, "a");
    assert_eq!((a.state, a.code, a.killed), (JobState::Exited, None, false));
    assert!(a.stderr_head.contains("could not start ffmpeg: no such file"), "{}", a.stderr_head);
    assert_eq!(fake.spawned_ids(), ["b"]);
  }

  #[test]
  fn only_the_bundled_sidecars_can_be_run() {
    let (s, fake) = sup();
    for program in [
      "cmd",
      "powershell",
      "/bin/sh",
      "artdaddy-ffmpeg",
      "artdaddy-whisper-cli",
      "ffprobe",
      "yt-dlp",
      "whisper",
      "",
    ] {
      assert!(s.submit(JobSpec { program: program.into(), ..spec(program) }).is_err(), "{program}");
    }
    assert!(fake.spawned_ids().is_empty());
    assert!(s.list().is_empty());
    // ...and each of those it names, by its logical name.
    for (program, _) in SIDECARS {
      s.submit(JobSpec { program: (*program).into(), lane: (*program).into(), ..spec(program) })
        .unwrap();
    }
    assert_eq!(fake.spawned_ids(), ["ffmpeg", "whisper-cli"]);
  }

  #[test]
  fn a_job_id_is_used_once() {
    let (s, _) = sup();
    s.submit(spec("a")).unwrap();
    assert!(s.submit(spec("a")).is_err());
    assert!(s.submit(JobSpec { id: String::new(), ..spec("x") }).is_err());
  }

  #[test]
  fn output_is_bounded_and_keeps_both_ends_of_stderr() {
    let (s, fake) = sup();
    s.submit(spec("a")).unwrap();
    fake.emit("a", ProcEvent::Stderr("Padded dimensions cannot be smaller\n".into()));
    let block = "é".repeat(10_000); // two bytes each: every cut must land on a char boundary
    for _ in 0..10 {
      fake.emit("a", ProcEvent::Stderr(block.clone()));
      fake.emit("a", ProcEvent::Stdout(block.clone()));
    }
    fake.emit("a", ProcEvent::Stderr("the last line".into()));
    let a = state(&s, "a");
    assert!(a.stderr_head.starts_with("Padded dimensions"), "the cause is kept");
    assert!(a.stderr_head.len() <= HEAD_BYTES);
    assert!(a.stderr_tail.len() <= TAIL_BYTES);
    assert!(a.stdout_tail.len() <= TAIL_BYTES);
    assert!(a.stderr_tail.ends_with("the last line"));
    let total = 36 + 10 * 20_000 + 13;
    assert_eq!(a.stderr_head.len() + a.stderr_elided as usize + a.stderr_tail.len(), total);
  }

  #[test]
  fn a_job_is_committed_and_forgotten_only_after_it_ended() {
    let (s, fake) = sup();
    s.submit(spec("a")).unwrap();
    assert!(!s.commit("a"));
    assert!(!s.forget("a"));
    fake.emit("a", ProcEvent::Exit(Some(0)));
    assert!(s.commit("a"));
    assert!(state(&s, "a").committed);
    assert!(s.forget("a"));
    assert!(s.list().is_empty());
    assert!(!s.forget("a"));
    assert!(!s.kill("a"), "an unknown job cannot be cancelled");
  }

  #[test]
  fn an_ended_job_cannot_be_cancelled_and_keeps_its_outcome() {
    let (s, fake) = sup();
    s.submit(spec("a")).unwrap();
    fake.emit("a", ProcEvent::Exit(Some(0)));
    assert!(!s.kill("a"));
    assert!(!state(&s, "a").killed);
    assert!(fake.killed.lock().unwrap().is_empty());
  }

  #[test]
  fn on_exit_nothing_keeps_running_and_nothing_queued_starts() {
    let (s, fake) = sup();
    s.submit(spec("a")).unwrap();
    s.submit(spec("b")).unwrap();
    s.submit(spec("c")).unwrap();
    s.kill_all();
    assert_eq!(*fake.killed.lock().unwrap(), [fake.pid_of("a")]);
    fake.emit("a", ProcEvent::Exit(Some(255)));
    assert_eq!(fake.spawned_ids(), ["a"]);
    assert!(s.list().iter().all(|j| j.state == JobState::Exited && j.killed));
  }

  #[test]
  fn every_change_is_announced_and_output_is_forwarded() {
    let fake = Arc::new(Fake::default());
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let log = seen.clone();
    let s = Supervisor::new(
      fake.clone(),
      Arc::new(move |n| {
        log.lock().unwrap().push(match n {
          Notice::Changed(v) => format!("{}:{:?}", v.id, v.state),
          Notice::Stdout { id, chunk } => format!("{id}>{chunk}"),
        })
      }),
    );
    s.submit(spec("a")).unwrap();
    fake.emit("a", ProcEvent::Stdout("out_time_ms=1000\n".into()));
    fake.emit("a", ProcEvent::Exit(Some(0)));
    assert_eq!(
      *seen.lock().unwrap(),
      ["a:Queued", "a:Running", "a>out_time_ms=1000\n", "a:Exited"]
    );
  }

  #[test]
  fn a_launch_id_is_stable_for_the_run_and_differs_between_runs() {
    let (a, _) = sup();
    std::thread::sleep(std::time::Duration::from_millis(2));
    let (b, _) = sup();
    assert_eq!(a.launch_id(), a.clone().launch_id());
    assert_ne!(a.launch_id(), b.launch_id());
  }

  #[test]
  fn every_job_program_is_a_bundled_sidecar() {
    let conf: serde_json::Value =
      serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
    let bins: Vec<String> = conf["bundle"]["externalBin"]
      .as_array()
      .expect("externalBin")
      .iter()
      .map(|v| v.as_str().unwrap().to_string())
      .collect();
    for (_, file) in SIDECARS {
      assert!(bins.contains(&format!("binaries/{file}")), "{file} is not bundled: {bins:?}");
    }
  }
}
