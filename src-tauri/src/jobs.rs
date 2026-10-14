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
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use std::path::{Path, PathBuf};
use std::io::{Read, Write};
use sha2::{Digest, Sha256};

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
  /// Start the job's process and return its pid. Output and the exit arrive through `on_event`,
  /// from any thread, possibly before this returns.
  fn spawn(&self, spec: &JobSpec, on_event: Arc<dyn Fn(ProcEvent) + Send + Sync>)
    -> Result<u32, String>;
  /// Kill the process and everything it started.
  fn kill(&self, pid: u32);
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
  export_root: Option<PathBuf>,
  export_work_root: Option<PathBuf>,
  copying: Arc<Mutex<HashSet<String>>>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ArtifactIdentity {
  pub sha256: String,
  pub size: u64,
}

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
}

fn artifact_identity(path: &Path) -> Result<ArtifactIdentity, String> {
  let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
  let before = file.metadata().map_err(|error| error.to_string())?;
  if !before.is_file() || before.len() == 0 { return Err("export artifact is empty or not a file".into()); }
  let mut hash = Sha256::new();
  let mut buffer = vec![0u8; 1024 * 1024];
  let mut size = 0;
  loop {
    let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
    if count == 0 { break; }
    size += count as u64;
    hash.update(&buffer[..count]);
  }
  let after = file.metadata().map_err(|error| error.to_string())?;
  if size != before.len() || size != after.len() || before.modified().ok() != after.modified().ok() {
    return Err("export artifact changed while hashing".into());
  }
  Ok(ArtifactIdentity { sha256: format!("{:x}", hash.finalize()), size })
}

fn persist_delivery(root: &Path, delivery: &ExportDelivery) -> Result<(), String> {
  std::fs::create_dir_all(root).map_err(|error| error.to_string())?;
  let mut file = tempfile::NamedTempFile::new_in(root).map_err(|error| error.to_string())?;
  serde_json::to_writer(&mut file, delivery).map_err(|error| error.to_string())?;
  file.as_file().sync_all().map_err(|error| error.to_string())?;
  file.persist(root.join(format!("{}.json", delivery.id))).map_err(|error| error.to_string())?;
  Ok(())
}

const EXPORT_SCRATCH_LIMIT_BYTES: u64 = 20_000_000_000;

struct ScratchOutput {
  file: tempfile::NamedTempFile,
  target: PathBuf,
  used: u64,
  limit: u64,
  failed: bool,
}

impl ScratchOutput {
  fn open(path: &Path, used: u64, limit: u64) -> Result<Self, String> {
    if used > limit { return Err("export scratch budget already exceeded".into()); }
    if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_file()) {
      return Err("scratch output must be an owned regular file".into());
    }
    let previous = std::fs::metadata(path).map(|metadata| metadata.len()).unwrap_or(0);
    let used = used.checked_add(previous).ok_or("scratch size overflow")?;
    if used > limit { return Err("export scratch budget already exceeded".into()); }
    let file = tempfile::NamedTempFile::new_in(path.parent().ok_or("scratch output has no parent")?).map_err(|error| error.to_string())?;
    Ok(Self { file, target: path.to_path_buf(), used, limit, failed: false })
  }

  fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
    if self.failed { return Err("temporary output is already failed".into()); }
    let Some(next) = self.used.checked_add(bytes.len() as u64) else {
      self.failed = true; return Err("export scratch byte count overflow".into());
    };
    if next > self.limit { self.failed = true; return Err("export scratch budget exceeded before write".into()); }
    if let Err(error) = self.file.write_all(bytes) { self.failed = true; return Err(error.to_string()); }
    self.used = next;
    Ok(())
  }

  fn finish(self, exit_code: Option<i32>) -> Result<(), String> {
    if self.failed { return Err("failed temporary output cannot be installed".into()); }
    if exit_code != Some(0) { return Err("unsuccessful worker cannot install temporary output".into()); }
    self.file.as_file().sync_all().map_err(|error| error.to_string())?;
    self.file.persist(&self.target).map_err(|error| error.to_string())?;
    Ok(())
  }
}

fn scratch_bytes(path: &Path, exclude: &Path) -> Result<u64, String> {
  let mut pending = vec![path.to_path_buf()];
  let mut bytes = 0u64;
  let mut entries = 0usize;
  while let Some(directory) = pending.pop() {
    for child in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
      entries += 1;
      if entries > 16384 { return Err("export scratch entry budget exceeded".into()); }
      let child = child.map_err(|error| error.to_string())?;
      let kind = child.file_type().map_err(|error| error.to_string())?;
      if kind.is_symlink() { return Err("export scratch cannot contain symbolic links".into()); }
      if kind.is_dir() { pending.push(child.path()); }
      else if kind.is_file() && child.path() != exclude {
        bytes = bytes.checked_add(child.metadata().map_err(|error| error.to_string())?.len()).ok_or("scratch size overflow")?;
      }
    }
  }
  Ok(bytes)
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
      export_root: None,
      export_work_root: None,
      copying: Arc::default(),
    }
  }

  pub fn with_export_root(mut self, root: PathBuf) -> Result<Self, String> {
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let mut deliveries = self.deliveries.lock().map_err(|error| error.to_string())?;
    for entry in std::fs::read_dir(&root).map_err(|error| error.to_string())? {
      let path = entry.map_err(|error| error.to_string())?.path();
      if path.extension().and_then(|value| value.to_str()) != Some("json") { continue; }
      if deliveries.len() >= 4096 || std::fs::metadata(&path).map_err(|error| error.to_string())?.len() > 8 * 1024 * 1024 {
        return Err("export journal exceeds the bounded loading budget".into());
      }
      let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
      let delivery: ExportDelivery = serde_json::from_slice(&bytes).map_err(|error| format!("damaged export journal {}: {error}", path.display()))?;
      if delivery.version != 1 || delivery.id.is_empty() ||
        !delivery.id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-') ||
        path.file_stem().and_then(|value| value.to_str()) != Some(delivery.id.as_str()) {
        return Err("unsupported or invalid export journal identity".into());
      }
      deliveries.insert(delivery.id.clone(), delivery);
    }
    drop(deliveries);
    self.export_root = Some(root);
    Ok(self)
  }

  pub fn with_export_work_root(mut self, root: PathBuf) -> Self { self.export_work_root = Some(root); self }

  pub fn prepare_delivery(&self, id: String, project_dir: String, stage_path: String, dest_path: String, source: DeliverySource) -> Result<ExportDelivery, String> {
    let root = self.export_root.as_ref().ok_or("native export journal is unavailable")?;
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-') {
      return Err("invalid export intent identity".into());
    }
    let stage = PathBuf::from(&stage_path);
    let dest = PathBuf::from(&dest_path);
    if !stage.is_absolute() || !dest.is_absolute() || stage == dest || stage.parent() != dest.parent() {
      return Err("export needs a distinct destination-volume staging sibling".into());
    }
    let parent = dest.parent().ok_or("export destination has no parent")?.canonicalize().map_err(|error| error.to_string())?;
    let stage_path = parent.join(stage.file_name().ok_or("export stage has no filename")?).to_string_lossy().into_owned();
    let dest_path = parent.join(dest.file_name().ok_or("export destination has no filename")?).to_string_lossy().into_owned();
    let destination_key = |path: &str| if cfg!(target_os = "windows") { path.to_lowercase() } else { path.to_string() };
    if destination_key(&stage_path) == destination_key(&dest_path) { return Err("staging aliases the destination".into()); }
    let mut deliveries = self.deliveries.lock().map_err(|error| error.to_string())?;
    if deliveries.len() >= 4096 { return Err("export recovery-intent budget is full; finish pending follow-ups before exporting".into()); }
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
    let delivery = ExportDelivery { version: 1, id: id.clone(), project_dir, stage_path, dest_path,
      state: "prepared".into(), identity: None, created_at: now_ms(), render_job: None, sources, recovery_attempts: 0, source, followups_done: false, command_sha256: None, worker_identity: None, producer_complete: false };
    self.require_unleased_path(Path::new(&delivery.dest_path), deliveries.values().chain(std::iter::once(&delivery)))?;
    let stage = std::fs::OpenOptions::new().write(true).create_new(true).open(&delivery.stage_path).map_err(|error| error.to_string())?;
    drop(stage);
    if let Err(error) = persist_delivery(root, &delivery) { let _ = std::fs::remove_file(&delivery.stage_path); return Err(error); }
    deliveries.insert(id, delivery.clone());
    Ok(delivery)
  }

  fn require_completed_producer(&self, delivery: &ExportDelivery) -> Result<(), String> {
    if !delivery.producer_complete { return Err("export producer has no durable successful completion".into()); }
    if self.copying.lock().map_err(|error| error.to_string())?.contains(&delivery.id) {
      return Err("export copy is still running".into());
    }
    if self.lock().jobs.get(&delivery.id).is_some_and(|job| job.state != JobState::Exited || job.kill_requested || job.code != Some(0)) {
      return Err("export worker has not successfully settled".into());
    }
    Ok(())
  }

  pub fn verify_delivery(&self, id: &str) -> Result<ExportDelivery, String> {
    let root = self.export_root.as_ref().ok_or("native export journal is unavailable")?;
    let delivery = self.deliveries.lock().map_err(|error| error.to_string())?.get(id).cloned().ok_or("unknown export intent")?;
    if delivery.state != "prepared" && delivery.state != "verified" { return Err("export intent cannot be verified".into()); }
    self.require_completed_producer(&delivery)?;
    for (path, expected) in &delivery.sources {
      let actual = artifact_identity(Path::new(path))?;
      if actual.sha256 != expected.sha256 || actual.size != expected.size { return Err("export dependency changed during rendering".into()); }
    }
    let mut next = delivery.clone();
    next.identity = Some(artifact_identity(Path::new(&delivery.stage_path))?);
    if matches!(delivery.source, DeliverySource::Copy { .. }) {
      let expected = delivery.sources.first().ok_or("copy export has no source identity")?;
      let actual = next.identity.as_ref().ok_or("copy stage has no identity")?;
      if actual.sha256 != expected.1.sha256 || actual.size != expected.1.size { return Err("copied artifact differs from the admitted library source".into()); }
    }
    next.state = "verified".into();
    let mut deliveries = self.deliveries.lock().map_err(|error| error.to_string())?;
    let current = deliveries.get_mut(id).ok_or("export intent vanished")?;
    if current.state != "prepared" && current.state != "verified" { return Err("export intent was cancelled or superseded during verification".into()); }
    self.require_completed_producer(current)?;
    persist_delivery(root, &next)?;
    *current = next;
    Ok(current.clone())
  }

  pub fn publish_delivery(&self, id: &str) -> Result<ExportDelivery, String> {
    let root = self.export_root.as_ref().ok_or("native export journal is unavailable")?;
    let captured = self.deliveries.lock().map_err(|error| error.to_string())?.get(id).cloned().ok_or("unknown export intent")?;
    self.require_completed_producer(&captured)?;
    let checked_stage = Path::new(&captured.stage_path).exists() && captured.state != "published";
    let checked_path = if checked_stage { &captured.stage_path } else { &captured.dest_path };
    let actual = artifact_identity(Path::new(checked_path))?;
    let expected = captured.identity.as_ref().ok_or("export has no verified identity")?;
    if actual.sha256 != expected.sha256 || actual.size != expected.size { return Err("export artifact identity differs at publication".into()); }
    let mut deliveries = self.deliveries.lock().map_err(|error| error.to_string())?;
    if checked_stage {
      let destination = &deliveries.get(id).ok_or("unknown export intent")?.dest_path;
      self.require_unleased_path(Path::new(destination), deliveries.values())?;
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
      if actual.sha256 != expected.sha256 || actual.size != expected.size { return Err("staged export changed after verification".into()); }
      let mut publishing = delivery.clone();
      publishing.state = "publishing".into();
      persist_delivery(root, &publishing)?;
      delivery.state = "publishing".into();
      std::fs::rename(staged, &delivery.dest_path).map_err(|error| error.to_string())?;
    } else {
      if actual.sha256 != expected.sha256 || actual.size != expected.size { return Err("destination is not the verified export artifact".into()); }
    }
    let mut published = delivery.clone();
    published.state = "published".into();
    persist_delivery(root, &published)?;
    *delivery = published;
    Ok(delivery.clone())
  }

  pub fn cancel_delivery(&self, id: &str) -> Result<bool, String> {
    let root = self.export_root.as_ref().ok_or("native export journal is unavailable")?;
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
    Ok(true)
  }

  pub fn delivery_list(&self) -> Vec<ExportDelivery> {
    self.deliveries.lock().unwrap_or_else(|error| error.into_inner()).values().cloned().collect()
  }

  pub fn with_unleased_path<T>(&self, path: &Path, operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    self.with_unleased_paths(&[path], operation)
  }

  pub fn with_unleased_paths<T>(&self, paths: &[&Path], operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let deliveries = self.deliveries.lock().map_err(|error| error.to_string())?;
    for path in paths { self.require_unleased_path(path, deliveries.values())?; }
    operation()
  }

  fn require_unleased_path<'a>(&self, path: &Path, deliveries: impl Iterator<Item = &'a ExportDelivery>) -> Result<(), String> {
    let canonical = match path.canonicalize() {
      Ok(path) => path,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
      Err(error) => return Err(error.to_string()),
    };
    let key = |path: &Path| {
      let value = path.to_string_lossy().replace('\\', "/");
      if cfg!(target_os = "windows") { value.to_lowercase() } else { value }
    };
    let target = key(&canonical);
    let prefix = format!("{}/", target.trim_end_matches('/'));
    let target_file = if canonical.is_file() {
      Some(same_file::Handle::from_path(&canonical).map_err(|error| error.to_string())?)
    } else { None };
    let dependency_path = |path: &Path| -> Result<PathBuf, String> {
      for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() { break; }
        match ancestor.canonicalize() {
          Ok(mut resolved) => {
            let remainder = path.strip_prefix(ancestor).map_err(|error| error.to_string())?;
            for component in remainder.components() {
              match component {
                std::path::Component::ParentDir => { resolved.pop(); }
                std::path::Component::CurDir => {}
                std::path::Component::Normal(name) => resolved.push(name),
                _ => return Err("export dependency has an invalid absolute suffix".into()),
              }
            }
            return Ok(resolved);
          }
          Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
          Err(error) => return Err(error.to_string()),
        }
      }
      Ok(path.to_path_buf())
    };
    let state = self.lock();
    for delivery in deliveries {
      let running = state.jobs.get(&delivery.id).is_some_and(|job| job.state != JobState::Exited);
      let pending = delivery.state != "published" && !delivery.followups_done;
      if !pending && !running { continue; }
      let declared: Vec<&str> = match &delivery.source {
        DeliverySource::Render { paths } => paths.iter().map(String::as_str).collect(),
        DeliverySource::Copy { path, .. } => vec![path.as_str()],
      };
      for dependency in declared.into_iter().chain(delivery.sources.iter().map(|(path, _)| path.as_str())) {
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
      if let Some(cwd) = delivery.render_job.as_ref().and_then(|job| job.cwd.as_ref()) {
        if let Ok(cwd) = Path::new(cwd).canonicalize() {
          let cwd = key(&cwd);
          if cwd == target || cwd.starts_with(&prefix) { return Err("scratch is leased by an active export".into()); }
        }
      }
    }
    Ok(())
  }

  pub fn fail_delivery(&self, id: &str) -> Result<bool, String> {
    let root = self.export_root.as_ref().ok_or("native export journal is unavailable")?;
    let mut deliveries = self.deliveries.lock().map_err(|error| error.to_string())?;
    let Some(delivery) = deliveries.get_mut(id) else { return Ok(false) };
    if delivery.state == "published" || delivery.state == "cancelled" || delivery.state == "publishing" { return Ok(false); }
    let mut next = delivery.clone();
    next.state = "failed".into();
    persist_delivery(root, &next)?;
    *delivery = next;
    Ok(true)
  }

  fn retain_render_job(&self, spec: &JobSpec) -> Result<(), String> {
    let admitted = self.deliveries.lock().map_err(|error| error.to_string())?.contains_key(&spec.id);
    if !admitted && spec.lane != "export" && spec.meta.get("kind").and_then(|value| value.as_str()) != Some("export") { return Ok(()); }
    let worker = self.spawner.identity(&spec.program)?;
    let root = self.export_root.as_ref().ok_or("native export journal is unavailable")?;
    let mut deliveries = self.deliveries.lock().map_err(|error| error.to_string())?;
    let delivery = deliveries.get(&spec.id).ok_or("export job has no admitted delivery intent")?;
    if !matches!(&delivery.source, DeliverySource::Render { .. }) { return Err("copy intent cannot admit a render worker".into()); }
    if spec.program != "ffmpeg" { return Err("export intent requires the admitted render backend".into()); }
    if delivery.state != "prepared" { return Err("export job is not in prepared state".into()); }
    if delivery.producer_complete { return Err("completed export producer cannot be run again".into()); }
    let mut paths = Vec::new();
    if let DeliverySource::Render { paths: declared } = &delivery.source { paths.extend(declared.iter().cloned()); }
    if let Some(sources) = spec.meta.pointer("/plan/sources").and_then(|value| value.as_array()) {
      for source in sources {
        if let Some(path) = source.get("path").and_then(|value| value.as_str()) { paths.push(path.to_string()); }
      }
    }
    for command in std::iter::once(&spec.args).chain(spec.steps.iter()) {
      for pair in command.windows(2) {
        if pair[0] == "-i" && Path::new(&pair[1]).is_file() { paths.push(pair[1].clone()); }
      }
    }
    if delivery.render_job.is_none() {
      if let Some(cwd) = &spec.cwd { collect_render_dependencies(Path::new(cwd), &mut paths)?; }
    }
    paths.sort(); paths.dedup();
    let mut next = delivery.clone();
    let first_binding = next.render_job.is_none();
    let command_sha256 = format!("{:x}", Sha256::digest(serde_json::to_vec(spec).map_err(|error| error.to_string())?));
    if first_binding {
      next.sources = paths.into_iter().map(|path| artifact_identity(Path::new(&path)).map(|identity| (path, identity))).collect::<Result<Vec<_>, _>>()?;
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
        let actual = artifact_identity(Path::new(path))?;
        if actual.sha256 != expected.sha256 || actual.size != expected.size { return Err("export source changed; recovery refused".into()); }
      }
    }
    self.require_unleased_path(Path::new(&next.dest_path), deliveries.values().chain(std::iter::once(&next)))?;
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
      if let DeliverySource::Copy { path, .. } = &delivery.source {
        let recovered = (|| -> Result<(), String> {
          if delivery.recovery_attempts >= 1 { return Err("automatic copy recovery budget exhausted".into()); }
          let expected = delivery.sources.first().ok_or("copy export has no source fingerprint")?;
          let actual = artifact_identity(Path::new(path))?;
          if actual.sha256 != expected.1.sha256 || actual.size != expected.1.size { return Err("copy source changed; recovery refused".into()); }
          let root = self.export_root.as_ref().ok_or("export journal unavailable")?;
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
      let Some(spec) = delivery.render_job.clone() else { continue };
      if delivery.recovery_attempts >= 1 { failures.push((delivery.id, "automatic recovery attempt budget exhausted".into())); continue; }
      if let Err(error) = self.retain_render_job(&spec) { failures.push((delivery.id, error)); continue; }
      let retained = (|| -> Result<(), String> {
        let root = self.export_root.as_ref().ok_or("native export journal is unavailable")?;
        let mut deliveries = self.deliveries.lock().map_err(|error| error.to_string())?;
        let entry = deliveries.get_mut(&delivery.id).ok_or("missing export intent")?;
        let mut next = entry.clone(); next.recovery_attempts += 1;
        persist_delivery(root, &next)?; *entry = next;
        Ok(())
      })();
      if let Err(error) = retained { failures.push((delivery.id, error)); continue; }
      if let Err(error) = self.submit(spec) { failures.push((delivery.id, error)); }
    }
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
    if let Some(spec) = &delivery.render_job { self.restore_finished_export(spec.clone(), delivery.created_at); return; }
    if let DeliverySource::Copy { media_ref, .. } = &delivery.source {
      let filename = Path::new(&delivery.dest_path).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
      self.restore_finished_export(JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
        args: Vec::new(), steps: Vec::new(), cwd: None, meta: serde_json::json!({ "kind": "export_copy", "projectDir": delivery.project_dir,
          "destPath": delivery.dest_path, "stagePath": delivery.stage_path, "filename": filename, "copyOf": media_ref,
          "startedBy": "elsewhere", "submittedAt": delivery.created_at }) }, delivery.created_at);
    }
  }

  pub fn complete_delivery(&self, id: &str) -> Result<bool, String> {
    let root = self.export_root.as_ref().ok_or("export journal unavailable")?;
    let mut entries = self.deliveries.lock().map_err(|error| error.to_string())?;
    let Some(entry) = entries.get_mut(id) else { return Ok(false) };
    if self.copying.lock().map_err(|error| error.to_string())?.contains(id) {
      return Err("running copy dependencies cannot be released".into());
    }
    if self.lock().jobs.get(id).is_some_and(|job| job.state != JobState::Exited) {
      return Err("running export dependencies cannot be released".into());
    }
    if !["published", "cancelled", "failed"].contains(&entry.state.as_str()) { return Err("active export cannot be retired".into()); }
    if let (Some(work_root), Some(cwd)) = (&self.export_work_root, entry.render_job.as_ref().and_then(|spec| spec.cwd.as_ref())) {
      if let (Ok(work), Ok(scratch)) = (work_root.canonicalize(), Path::new(cwd).canonicalize()) {
        if scratch.starts_with(&work) && scratch != work { std::fs::remove_dir_all(scratch).map_err(|error| error.to_string())?; }
      }
    }
    let mut next = entry.clone(); next.followups_done = true;
    persist_delivery(root, &next)?; *entry = next;
    let mut terminal: Vec<(u64, String)> = entries.values().filter(|entry| entry.followups_done).map(|entry| (entry.created_at, entry.id.clone())).collect();
    terminal.sort();
    let remove_count = terminal.len().saturating_sub(50);
    for (_, old_id) in terminal.into_iter().take(remove_count) {
      std::fs::remove_file(root.join(format!("{old_id}.json"))).map_err(|error| error.to_string())?;
      entries.remove(&old_id);
    }
    Ok(true)
  }

  pub fn copy_delivery(&self, id: &str) -> Result<(), String> {
    let delivery = {
      let entries = self.deliveries.lock().map_err(|error| error.to_string())?;
      let entry = entries.get(id).ok_or("unknown copy intent")?;
      if entry.state != "prepared" { return Err("copy intent was cancelled or already settled".into()); }
      if !matches!(entry.source, DeliverySource::Copy { .. }) { return Err("render intent cannot use the copy executor".into()); }
      if entry.producer_complete { return Ok(()); }
      if !self.copying.lock().map_err(|error| error.to_string())?.insert(id.to_string()) { return Err("copy intent is already running".into()); }
      entry.clone()
    };
    struct CopyGuard<'a>(&'a Mutex<HashSet<String>>, String);
    impl Drop for CopyGuard<'_> { fn drop(&mut self) { self.0.lock().unwrap_or_else(|error| error.into_inner()).remove(&self.1); } }
    let _guard = CopyGuard(&self.copying, id.to_string());
    let DeliverySource::Copy { path, .. } = &delivery.source else { return Err("copy source unavailable".into()) };
    let expected = delivery.sources.first().ok_or("copy source has no identity")?;
    let actual = artifact_identity(Path::new(path))?;
    if actual.sha256 != expected.1.sha256 || actual.size != expected.1.size { return Err("copy source changed before execution".into()); }
    let mut source = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let previous = std::fs::metadata(&delivery.stage_path).map_err(|error| error.to_string())?.len();
    if previous > EXPORT_SCRATCH_LIMIT_BYTES { return Err("retained copy stage exceeds temporary-space budget".into()); }
    let allocation = previous.checked_add(expected.1.size).ok_or("copy allocation size overflow")?;
    let mut destination = ScratchOutput::open(Path::new(&delivery.stage_path), 0, allocation)?;
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
      if self.deliveries.lock().map_err(|error| error.to_string())?.get(id).is_none_or(|entry| entry.state != "prepared") {
        return Err("copy export cancelled".into());
      }
      let count = source.read(&mut buffer).map_err(|error| error.to_string())?;
      if count == 0 { break; }
      destination.write(&buffer[..count])?;
    }
    let root = self.export_root.as_ref().ok_or("native export journal is unavailable")?;
    let mut entries = self.deliveries.lock().map_err(|error| error.to_string())?;
    let entry = entries.get_mut(id).ok_or("copy intent vanished before completion")?;
    if entry.state != "prepared" { return Err("copy was cancelled before completion".into()); }
    destination.finish(Some(0))?;
    let mut next = entry.clone();
    next.producer_complete = true;
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
    if spec.meta.get("_native_scratch_capture").is_some() { return Err("native output capture metadata is reserved".into()); }
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
    spec.steps.clear();
    let cancelled = self.lock().jobs.get(&spec.id)
      .is_none_or(|job| job.kill_requested || job.state != JobState::Running || job.step != step);
    if cancelled {
      self.finish(&spec.id, step, None, None);
      return;
    }
    if let Err(error) = self.retain_render_job(&dependency_spec) {
      self.finish(&spec.id, step, Some(-1), Some(error));
      return;
    }
    let delivery = self.deliveries.lock().unwrap_or_else(|error| error.into_inner()).get(&spec.id).cloned();
    if let Some(delivery) = delivery {
      if matches!(&delivery.source, DeliverySource::Render { .. }) {
        if let (Some(cwd), Some(work_root)) = (&spec.cwd, &self.export_work_root) {
          let valid = Path::new(cwd).canonicalize().ok().zip(work_root.canonicalize().ok())
            .is_some_and(|(scratch, work)| scratch.starts_with(&work) && scratch != work);
          if !valid { self.finish(&spec.id, step, Some(-1), Some("export scratch is outside its owned work root".into())); return; }
        }
        match scratch_capture(&spec, &delivery.stage_path, step == dependency_spec.steps.len()) {
          Ok(Some(capture)) => { spec.meta["_native_scratch_capture"] = capture; }
          Ok(None) => {}
          Err(error) => { self.finish(&spec.id, step, Some(-1), Some(error)); return; }
        }
      }
    }
    let me = self.clone();
    let id = spec.id.clone();
    let on_event: Arc<dyn Fn(ProcEvent) + Send + Sync> = Arc::new(move |ev| me.on_event(&id, step, ev));
    match self.spawner.spawn(&spec, on_event) {
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
          self.spawner.kill(pid);
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
      if code == Some(0) && error.is_none() && !job.kill_requested && step < job.spec.steps.len() {
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
            let root = self.export_root.as_ref().ok_or("native export journal is unavailable")?;
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
          self.spawner.kill(pid);
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

struct ShellSpawner<R: Runtime> {
  app: AppHandle<R>,
  /// Held until each process ends: the child owns its stdin pipe, as it does for the page.
  children: Arc<Mutex<HashMap<u32, CommandChild>>>,
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
  ) -> Result<u32, String> {
    let file = sidecar_file(&spec.program)
      .ok_or_else(|| format!("'{}' is not a bundled program", spec.program))?;
    let mut args = spec.args.clone();
    let mut capture = if let Some(contract) = spec.meta.get("_native_scratch_capture") {
      let path = contract.get("path").and_then(|value| value.as_str()).ok_or("native scratch capture path missing")?;
      let used = contract.get("used").and_then(|value| value.as_u64()).ok_or("native scratch capture byte count missing")?;
      let limit = contract.get("limit").and_then(|value| value.as_u64()).ok_or("native scratch capture limit missing")?;
      args = captured_output_args(&args)?;
      Some(ScratchOutput::open(Path::new(path), used, limit)?)
    } else { None };
    let captured = capture.is_some();
    let mut cmd = self
      .app
      .shell()
      .sidecar(file)
      .map_err(|e| e.to_string())?
      .args(&args)
      .set_raw_out(true);
    if let Some(cwd) = spec.cwd.as_deref().filter(|c| !c.is_empty()) {
      cmd = cmd.current_dir(cwd);
    }
    let (mut rx, child) = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.pid();
    self.children.lock().unwrap_or_else(|e| e.into_inner()).insert(pid, child);
    let children = self.children.clone();
    tauri::async_runtime::spawn(async move {
      let mut ended = false;
      let mut capture_error = None;
      while let Some(ev) = rx.recv().await {
        match ev {
          CommandEvent::Stdout(bytes) => {
            if let Some(writer) = capture.as_mut() {
              if capture_error.is_none() {
                if let Err(error) = writer.write(&bytes) {
                  capture_error = Some(error);
                  if let Err(error) = crate::kill_tree(pid) { log::warn!("scratch quota could not stop worker {pid}: {error}"); }
                }
              }
            } else { on_event(ProcEvent::Stdout(String::from_utf8_lossy(&bytes).into_owned())); }
          }
          CommandEvent::Stderr(bytes) => {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            if captured { on_event(ProcEvent::Stdout(text.clone())); }
            on_event(ProcEvent::Stderr(text));
          }
          CommandEvent::Error(e) => {
            if captured && capture_error.is_none() {
              capture_error = Some(format!("temporary output reader failed: {e}"));
              if let Err(error) = crate::kill_tree(pid) { log::warn!("capture error could not stop worker {pid}: {error}"); }
            }
            on_event(ProcEvent::Stderr(format!("{e}\n")));
          }
          CommandEvent::Terminated(p) => {
            ended = true;
            children.lock().unwrap_or_else(|e| e.into_inner()).remove(&pid);
            if let Some(writer) = capture.take() {
              if capture_error.is_none() { capture_error = writer.finish(p.code).err(); }
            }
            if let Some(error) = capture_error.take() {
              on_event(ProcEvent::Stderr(format!("native temporary output failed: {error}\n")));
              on_event(ProcEvent::Exit(Some(-1)));
            } else { on_event(ProcEvent::Exit(p.code)); }
          }
          _ => {}
        }
      }
      // The waiter failed and no exit was reported: the job must still end, or its lane stalls.
      if !ended {
        children.lock().unwrap_or_else(|e| e.into_inner()).remove(&pid);
        on_event(ProcEvent::Exit(None));
      }
    });
    Ok(pid)
  }

  fn kill(&self, pid: u32) {
    if let Err(e) = crate::kill_tree(pid) {
      log::warn!("jobs: could not kill process {pid}: {e}");
    }
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
      let spawner = Arc::new(ShellSpawner { app: app.clone(), children: Arc::default() });
      let base = Supervisor::new(spawner, notify).with_export_work_root(app.path().app_cache_dir()?.join("work"));
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

#[tauri::command]
pub fn jobs_submit(jobs: tauri::State<'_, Supervisor>, spec: JobSpec) -> Result<usize, String> {
  jobs.submit(spec)
}

#[tauri::command]
pub fn jobs_submit_sequence(jobs: tauri::State<'_, Supervisor>, spec: JobSpec) -> Result<usize, String> {
  if spec.program != "ffmpeg" || spec.steps.is_empty() {
    return Err("a render sequence requires ffmpeg and continuation steps".into());
  }
  jobs.submit(spec)
}

#[tauri::command]
pub fn jobs_kill(jobs: tauri::State<'_, Supervisor>, id: String) -> bool {
  jobs.kill(&id)
}

#[tauri::command]
pub fn jobs_list(jobs: tauri::State<'_, Supervisor>) -> Vec<JobView> {
  jobs.list()
}

#[tauri::command]
pub fn jobs_commit(jobs: tauri::State<'_, Supervisor>, id: String) -> bool {
  jobs.commit(&id)
}

#[tauri::command]
pub fn jobs_forget(jobs: tauri::State<'_, Supervisor>, id: String) -> bool {
  jobs.forget(&id)
}

#[tauri::command]
pub fn jobs_launch_id(jobs: tauri::State<'_, Supervisor>) -> String {
  jobs.launch_id()
}

#[tauri::command]
pub fn jobs_export_protocol() -> u32 { 9 }

#[tauri::command]
pub async fn jobs_prepare_export(jobs: tauri::State<'_, Supervisor>, id: String, project_dir: String, stage_path: String, dest_path: String, source: DeliverySource) -> Result<ExportDelivery, String> {
  let supervisor = jobs.inner().clone();
  tauri::async_runtime::spawn_blocking(move || supervisor.prepare_delivery(id, project_dir, stage_path, dest_path, source)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn jobs_verify_export(jobs: tauri::State<'_, Supervisor>, id: String) -> Result<ExportDelivery, String> {
  let supervisor = jobs.inner().clone();
  tauri::async_runtime::spawn_blocking(move || supervisor.verify_delivery(&id)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn jobs_publish_export(jobs: tauri::State<'_, Supervisor>, id: String) -> Result<ExportDelivery, String> {
  let supervisor = jobs.inner().clone();
  tauri::async_runtime::spawn_blocking(move || supervisor.publish_delivery(&id)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn jobs_cancel_export(jobs: tauri::State<'_, Supervisor>, id: String) -> Result<bool, String> {
  jobs.cancel_delivery(&id)
}

#[tauri::command]
pub fn jobs_export_intents(jobs: tauri::State<'_, Supervisor>) -> Vec<ExportDelivery> { jobs.delivery_list() }

#[tauri::command]
pub fn jobs_fail_export(jobs: tauri::State<'_, Supervisor>, id: String) -> Result<bool, String> { jobs.fail_delivery(&id) }

#[tauri::command]
pub fn jobs_complete_export(jobs: tauri::State<'_, Supervisor>, id: String) -> Result<bool, String> { jobs.complete_delivery(&id) }

#[tauri::command]
pub async fn jobs_copy_export(jobs: tauri::State<'_, Supervisor>, id: String) -> Result<(), String> {
  let supervisor = jobs.inner().clone();
  tauri::async_runtime::spawn_blocking(move || supervisor.copy_delivery(&id)).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod export_delivery_tests {
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
    let mut writer = ScratchOutput::open(&captured, 0, EXPORT_SCRATCH_LIMIT_BYTES).unwrap();
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
    let mut writer = ScratchOutput::open(&part, 6, 12).unwrap();
    writer.write(b"1234").unwrap();
    assert!(writer.write(b"567").is_err());
    assert_eq!(writer.file.as_file().metadata().unwrap().len(), 4);
    assert!(writer.finish(Some(0)).is_err());
    assert!(!part.exists());
    assert_eq!(std::fs::read(&destination).unwrap(), b"previous delivered file");
    assert!(ScratchOutput::open(&dir.path().join("overflow.nut"), 13, 12).is_err());
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
      let mut refused = ScratchOutput::open(&part, 0, 17).unwrap();
      assert!(refused.write(b"too many new bytes").is_err());
    }
    assert_eq!(std::fs::read(&source).unwrap(), b"old source bytes");
    assert_eq!(std::fs::read(&part).unwrap(), b"old source bytes");
    let mut writer = ScratchOutput::open(&part, 0, 100).unwrap();
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
      let mut writer = ScratchOutput::open(&part, 0, 1024).unwrap();
      writer.write(b"incomplete replacement bytes").unwrap();
      assert!(writer.finish(code).is_err());
      assert_eq!(std::fs::read(&part).unwrap(), b"verified old source");
      assert_eq!(std::fs::read(&source).unwrap(), b"verified old source");
      assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }
  }
  use super::*;
  struct NoSpawn;
  impl Spawner for NoSpawn {
    fn identity(&self, program: &str) -> Result<ArtifactIdentity, String> {
      Ok(ArtifactIdentity { sha256: format!("{:x}", Sha256::digest(program.as_bytes())), size: program.len() as u64 })
    }
    fn spawn(&self, _: &JobSpec, _: Arc<dyn Fn(ProcEvent) + Send + Sync>) -> Result<u32, String> { Err("unused".into()) }
    fn kill(&self, _: u32) {}
  }
  fn owner(root: &Path) -> Supervisor {
    Supervisor::new(Arc::new(NoSpawn), Arc::new(|_| {})).with_export_root(root.to_path_buf()).unwrap()
  }
  fn intent(owner: &Supervisor, dir: &Path, id: &str) -> ExportDelivery {
    owner.prepare_delivery(id.into(), "original-project".into(), dir.join(format!("{id}.partial")).to_string_lossy().into(),
      dir.join(format!("{id}.mp4")).to_string_lossy().into(), DeliverySource::Render { paths: Vec::new() }).unwrap()
  }
  fn render_bytes(owner: &Supervisor, delivery: &ExportDelivery, bytes: &[u8]) {
    struct WritingSpawner(Vec<u8>);
    impl Spawner for WritingSpawner {
      fn identity(&self, program: &str) -> Result<ArtifactIdentity, String> { NoSpawn.identity(program) }
      fn spawn(&self, spec: &JobSpec, notify: Arc<dyn Fn(ProcEvent) + Send + Sync>) -> Result<u32, String> {
        std::fs::write(spec.args.last().ok_or("fixture output missing")?, &self.0).map_err(|error| error.to_string())?;
        notify(ProcEvent::Exit(Some(0)));
        Ok(123)
      }
      fn kill(&self, _: u32) {}
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
  fn successful_worker_with_failed_completion_record_cannot_publish() {
    struct CompletionFailingSpawner(PathBuf);
    impl Spawner for CompletionFailingSpawner {
      fn identity(&self, program: &str) -> Result<ArtifactIdentity, String> { NoSpawn.identity(program) }
      fn spawn(&self, spec: &JobSpec, notify: Arc<dyn Fn(ProcEvent) + Send + Sync>) -> Result<u32, String> {
        std::fs::write(spec.args.last().ok_or("fixture output missing")?, b"complete worker bytes").map_err(|error| error.to_string())?;
        std::fs::remove_dir_all(&self.0).map_err(|error| error.to_string())?;
        std::fs::write(&self.0, b"journal unavailable").map_err(|error| error.to_string())?;
        notify(ProcEvent::Exit(Some(0)));
        Ok(123)
      }
      fn kill(&self, _: u32) {}
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
    std::fs::remove_dir_all(&root).unwrap();
    std::fs::write(&root, b"journal unavailable").unwrap();
    assert!(jobs.copy_delivery(&delivery.id).is_err());
    assert_eq!(std::fs::read(&delivery.stage_path).unwrap(), b"admitted library bytes");
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
    persist_delivery(&root, &retained).unwrap();
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
      persist_delivery(&root, entry).unwrap();
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
    let root = dir.path().join("journal");
    let jobs = owner(&root);
    let delivery = jobs.prepare_delivery("leased1".into(), "original-project".into(), dir.path().join("render.partial").to_string_lossy().into(),
      dir.path().join("render.mp4").to_string_lossy().into(), DeliverySource::Render { paths: vec![source.to_string_lossy().into()] }).unwrap();
    let remove = || std::fs::remove_file(&source).map_err(|error| error.to_string());
    assert!(jobs.with_unleased_path(&source, remove).is_err());
    assert!(jobs.with_unleased_path(dir.path(), || Err::<(), _>("must never run".into())).unwrap_err().contains("leased"));
    assert_eq!(std::fs::read(&source).unwrap(), b"owned media needed by queued export");
    jobs.cancel_delivery(&delivery.id).unwrap();
    assert!(jobs.with_unleased_path(&source, remove).is_err());
    jobs.complete_delivery(&delivery.id).unwrap();
    jobs.with_unleased_path(&source, remove).unwrap();
    assert!(!source.exists());
    assert!(jobs.prepare_delivery("late1".into(), "original-project".into(), dir.path().join("late.partial").to_string_lossy().into(),
      dir.path().join("late.mp4").to_string_lossy().into(), DeliverySource::Render { paths: vec![source.to_string_lossy().into()] }).is_err());
  }
  #[test]
  fn process_ignoring_cancel_keeps_dependencies_until_its_actual_exit() {
    struct IgnoringSpawner;
    impl Spawner for IgnoringSpawner {
      fn identity(&self, program: &str) -> Result<ArtifactIdentity, String> {
        Ok(ArtifactIdentity { sha256: format!("{:x}", Sha256::digest(program.as_bytes())), size: program.len() as u64 })
      }
      fn spawn(&self, _: &JobSpec, _: Arc<dyn Fn(ProcEvent) + Send + Sync>) -> Result<u32, String> { Ok(123) }
      fn kill(&self, _: u32) {}
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
    persist_delivery(&root, &changed).unwrap();
    let reopened = owner(&root);
    let failures = reopened.recover_exports();
    assert_eq!(failures.len(), 1);
    assert!(failures[0].1.contains("command identity changed"));
    assert!(reopened.list().is_empty());
    assert_eq!(std::fs::read(&source).unwrap(), b"unchanged source bytes");
    assert!(!Path::new(&delivery.dest_path).exists());
  }
  #[test]
  fn changed_or_unbound_worker_cannot_replay_the_admitted_edit() {
    struct BoundWorker { path: PathBuf, started: Arc<std::sync::atomic::AtomicUsize> }
    impl Spawner for BoundWorker {
      fn identity(&self, _: &str) -> Result<ArtifactIdentity, String> { artifact_identity(&self.path) }
      fn spawn(&self, _: &JobSpec, _: Arc<dyn Fn(ProcEvent) + Send + Sync>) -> Result<u32, String> {
        self.started.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err("test worker must never start".into())
      }
      fn kill(&self, _: u32) {}
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
    assert!(reopened.list().is_empty());
    assert_eq!(started.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert_eq!(std::fs::metadata(&delivery.stage_path).unwrap().len(), 0);
    assert!(!Path::new(&delivery.dest_path).exists());
    std::fs::write(&binary, b"admitted worker version one").unwrap();
    let mut legacy = jobs.delivery_list()[0].clone();
    legacy.worker_identity = None;
    persist_delivery(&root, &legacy).unwrap();
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
  fn worker_replacement_blocks_queued_start_and_later_sequence_steps() {
    type Callback = Arc<dyn Fn(ProcEvent) + Send + Sync>;
    struct HeldWorker {
      path: PathBuf,
      started: Arc<Mutex<Vec<String>>>,
      callbacks: Arc<Mutex<HashMap<String, Callback>>>,
    }
    impl Spawner for HeldWorker {
      fn identity(&self, _: &str) -> Result<ArtifactIdentity, String> { artifact_identity(&self.path) }
      fn spawn(&self, spec: &JobSpec, callback: Callback) -> Result<u32, String> {
        self.started.lock().unwrap().push(spec.id.clone());
        self.callbacks.lock().unwrap().insert(spec.id.clone(), callback);
        Ok(123)
      }
      fn kill(&self, _: u32) {}
    }
    let dir = tempfile::tempdir().unwrap();
    let binary = dir.path().join("worker.bin");
    let source = dir.path().join("source.mp4");
    std::fs::write(&source, b"unchanged input").unwrap();
    std::fs::write(&binary, b"original worker").unwrap();
    let started = Arc::new(Mutex::new(Vec::new()));
    let callbacks = Arc::new(Mutex::new(HashMap::<String, Callback>::new()));
    let jobs = Supervisor::new(Arc::new(HeldWorker { path: binary.clone(), started: started.clone(), callbacks: callbacks.clone() }), Arc::new(|_| {}))
      .with_export_root(dir.path().join("journal")).unwrap();
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
    let scratch = dir.path().join("sequence-scratch");
    std::fs::create_dir(&scratch).unwrap();
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
    let jobs = owner(&root);
    let delivery = intent(&jobs, dir.path(), "changed1");
    let source = dir.path().join("source.mp4");
    let scratch = dir.path().join("scratch");
    std::fs::create_dir(&scratch).unwrap();
    let font = scratch.join("font.ttf");
    std::fs::write(&source, b"original source").unwrap();
    std::fs::write(&font, b"original font").unwrap();
    let spec = JobSpec { id: delivery.id.clone(), lane: "export".into(), program: "ffmpeg".into(),
      args: vec!["-i".into(), source.to_string_lossy().into(), delivery.stage_path.clone()], steps: vec![],
      cwd: Some(scratch.to_string_lossy().into()), meta: serde_json::json!({ "kind": "export", "plan": { "sources": [{ "path": source }] } }) };
    jobs.retain_render_job(&spec).unwrap();
    std::fs::write(&font, b"changed font").unwrap();
    let reopened = owner(&root);
    assert!(!reopened.recover_exports().is_empty());
    assert!(reopened.list().is_empty());
    assert_eq!(std::fs::metadata(&delivery.stage_path).unwrap().len(), 0);
    std::fs::write(&font, b"original font").unwrap();
    std::fs::write(&source, b"changed source").unwrap();
    let reopened = owner(&root);
    assert!(!reopened.recover_exports().is_empty());
    assert!(reopened.list().is_empty());
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
    let jobs = owner(&root).with_export_work_root(work);
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
  fn crash_recovery_renders_and_publishes_a_real_video() {
    struct RealSpawner(PathBuf);
    impl Spawner for RealSpawner {
      fn identity(&self, _: &str) -> Result<ArtifactIdentity, String> { artifact_identity(&self.0) }
      fn spawn(&self, spec: &JobSpec, notify: Arc<dyn Fn(ProcEvent) + Send + Sync>) -> Result<u32, String> {
        let output = std::process::Command::new(&self.0).args(&spec.args).output().map_err(|error| error.to_string())?;
        notify(ProcEvent::Stderr(String::from_utf8_lossy(&output.stderr).into_owned()));
        notify(ProcEvent::Exit(output.status.code()));
        Ok(1)
      }
      fn kill(&self, _: u32) {}
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
    fn kill(&self, pid: u32) {
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
      fn spawn(&self, _spec: &JobSpec, event: Arc<dyn Fn(ProcEvent) + Send + Sync>) -> Result<u32, String> {
        let pid = self.0.fetch_add(1, Ordering::SeqCst);
        event(ProcEvent::Exit(Some(0)));
        Ok(pid)
      }
      fn kill(&self, _pid: u32) {
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
  #[ignore = "invoked by exportRange.smoke.e2e.ts with a private real-ffmpeg fixture"]
  fn render_sequence_real_artifact() {
    struct RealSpawner(String);
    impl Spawner for RealSpawner {
      fn identity(&self, _: &str) -> Result<ArtifactIdentity, String> { artifact_identity(Path::new(&self.0)) }
      fn spawn(&self, spec: &JobSpec, on_event: Arc<dyn Fn(ProcEvent) + Send + Sync>) -> Result<u32, String> {
        let child = std::process::Command::new(&self.0)
          .args(&spec.args)
          .current_dir(spec.cwd.as_ref().ok_or("real render needs a private cwd")?)
          .stdout(std::process::Stdio::piped())
          .stderr(std::process::Stdio::piped())
          .spawn().map_err(|error| error.to_string())?;
        let pid = child.id();
        std::thread::spawn(move || match child.wait_with_output() {
          Ok(output) => {
            on_event(ProcEvent::Stdout(String::from_utf8_lossy(&output.stdout).into_owned()));
            on_event(ProcEvent::Stderr(String::from_utf8_lossy(&output.stderr).into_owned()));
            on_event(ProcEvent::Exit(output.status.code()));
          }
          Err(error) => {
            on_event(ProcEvent::Stderr(error.to_string()));
            on_event(ProcEvent::Exit(None));
          }
        });
        Ok(pid)
      }
      fn kill(&self, pid: u32) {
        crate::kill_tree(pid).expect("kill real render");
      }
    }
    let file = std::env::var("ARTDADDY_QA_RENDER_SPEC").expect("private fixture spec");
    let binary = std::env::var("ARTDADDY_QA_FFMPEG").expect("shipped ffmpeg");
    let spec: JobSpec = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    assert_eq!(spec.program, "ffmpeg");
    assert!(!spec.steps.is_empty(), "the fixture must exercise a real sequence");
    let (sender, receiver) = std::sync::mpsc::channel();
    let supervisor = Supervisor::new(Arc::new(RealSpawner(binary)), Arc::new(move |notice| {
      if let Notice::Changed(view) = notice {
        if view.state == JobState::Exited {
          sender.send(view).unwrap();
        }
      }
    }));
    let expected_steps = spec.steps.len();
    supervisor.submit(spec).unwrap();
    let result = receiver.recv_timeout(std::time::Duration::from_secs(120)).expect("real render ended");
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
