use super::{JobSpec, ProcEvent};
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use shared_child::SharedChild;

mod pipe;
mod output;

pub(super) type StartGuard = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;
pub(super) type Registry = Arc<Mutex<HashMap<(String, u32), Arc<Control>>>>;
type Observer = Arc<dyn Fn(ProcEvent) + Send + Sync>;

struct ManifestScratch {
  owned: Option<(tempfile::TempDir, super::workspace::Charge)>,
}

impl ManifestScratch {
  fn open(cwd: &Path, workspace: &Arc<super::Workspace>, key: &str, entries: u64) -> Result<Self, String> {
    let (bytes, existing_entries) = super::scratch_usage(cwd, Path::new(""))?;
    workspace.account_existing(key, bytes, existing_entries)?;
    let charge = workspace.reserve(key, 0, entries)?;
    let directory = tempfile::Builder::new().prefix("native-stream-").tempdir_in(cwd).map_err(|error| error.to_string())?;
    let scratch = Self { owned: Some((directory, charge)) };
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      if let Err(error) = std::fs::set_permissions(scratch.path(), std::fs::Permissions::from_mode(0o700)) {
        return Err(scratch.cleanup_error(error.to_string()));
      }
    }
    Ok(scratch)
  }

  fn path(&self) -> &Path { self.owned.as_ref().expect("live streaming scratch owner").0.path() }

  fn admit_manifest(&mut self, bytes: u64) -> Result<(), String> {
    self.owned.as_mut().expect("live streaming scratch owner").1.grow(bytes)
  }

  fn close(mut self) -> Result<(), String> {
    let (directory, charge) = self.owned.take().expect("live streaming scratch owner");
    match directory.close() {
      Ok(()) => { drop(charge); Ok(()) }
      Err(error) => {
        charge.retain();
        Err(format!("native streaming scratch cleanup failed; workspace reservation retained: {error}"))
      }
    }
  }

  fn cleanup_error(self, primary: String) -> String {
    match self.close() {
      Ok(()) => primary,
      Err(cleanup) => format!("{primary}\n{cleanup}"),
    }
  }

  fn retain(&mut self) {
    if let Some((directory, charge)) = self.owned.take() {
      directory.keep();
      charge.retain();
    }
  }
}

impl Drop for ManifestScratch {
  fn drop(&mut self) {
    if self.owned.is_some() {
      self.retain();
      log::warn!("native streaming scratch abandoned before confirmed settlement; files and workspace reservation retained");
    }
  }
}

fn with_cleanup(primary: Result<(), String>, cleanup: Result<(), String>) -> Result<(), String> {
  match (primary, cleanup) {
    (Err(primary), Err(cleanup)) => Err(format!("{primary}\n{cleanup}")),
    (Err(primary), Ok(())) => Err(primary),
    (Ok(()), cleanup) => cleanup,
  }
}

struct FinalOutput {
  path: std::path::PathBuf,
  key: String,
  limit: u64,
  workspace: Arc<super::Workspace>,
  charge: Option<super::workspace::Charge>,
  output_limit: Option<output::OutputLimit>,
}

impl FinalOutput {
  fn open(spec: &JobSpec, args: &mut Vec<String>, workspace: Arc<super::Workspace>) -> Result<Option<Self>, String> {
    let Some(path) = spec.meta.get("_native_final_stage") else { return Ok(None) };
    let path = path.as_str().ok_or("native pending output has no stage path")?;
    let output = args.last().ok_or("native pending output command has no target")?;
    if Path::new(output).canonicalize().map_err(|error| error.to_string())? !=
      Path::new(path).canonicalize().map_err(|error| error.to_string())? {
      return Err("native pending output does not target its admitted stage".into());
    }
    let key = super::Supervisor::workspace_key(Path::new(path));
    let (limit, charge) = workspace.reserve_output(&key)?;
    let mut reserved = Self { path: path.into(), key, limit, workspace, charge: Some(charge), output_limit: None };
    reserved.output_limit = Some(output::OutputLimit::open(Path::new(path), limit)?);
    let output_index = args.len() - 1;
    args.splice(output_index..output_index, ["-fs".into(), limit.to_string()]);
    Ok(Some(reserved))
  }

  fn finish(&mut self, producer_complete: bool) -> Result<(), String> {
    self.output_limit.take();
    let Some(charge) = self.charge.take() else { return Ok(()) };
    let measured = std::fs::symlink_metadata(&self.path).map_err(|error| error.to_string());
    let metadata = match measured {
      Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => metadata,
      Ok(_) => { charge.retain(); return Err("native pending output is not a regular file".into()); }
      Err(error) => { charge.retain(); return Err(error); }
    };
    let actual = metadata.len();
    let capped = actual >= self.limit;
    let discard = capped || !producer_complete;
    if discard {
      if let Err(error) = std::fs::remove_file(&self.path) {
        charge.retain();
        return Err(format!("native incomplete output could not be cleaned: {error}"));
      }
    }
    charge.retain();
    self.workspace.release(&self.key, self.limit.saturating_sub(if discard { 0 } else { actual }), u64::from(discard));
    self.workspace.settle_output_writer(&self.key);
    if discard { Err(format!("native output write boundary refused completion: {}",
      serde_json::json!({ "limit": self.limit, "observed": actual, "producer_complete": producer_complete, "cleaned": true }))) }
    else { Ok(()) }
  }
}

impl Drop for FinalOutput {
  fn drop(&mut self) { let _ = self.finish(false); }
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
enum WorkerRole { Single, PartitionProducer, ContinuousAudio, FinalEncoder }

#[derive(Clone)]
struct RegisteredWorker {
  child: Arc<SharedChild>,
  role: WorkerRole,
}

#[derive(serde::Serialize)]
struct ResidentWorker {
  pid: u32,
  role: WorkerRole,
  bytes: u64,
}

#[derive(Default)]
struct State {
  cancelled: bool,
  input_closed: bool,
  last_producer_started: bool,
  consumer_completed: bool,
  settled: bool,
  expired: bool,
  resource_failure: Option<String>,
  resident_peak: u64,
  resident_workers: Vec<ResidentWorker>,
  children: HashMap<u32, RegisteredWorker>,
  final_output: Option<FinalOutput>,
}

pub(super) struct Control {
  state: Mutex<State>,
  wake: pipe::Wake,
  budget: super::budget::Budget,
  deadline: Instant,
  settled: Condvar,
  resident_limit: u64,
}

impl Control {
  fn new(deadline_ms: u64, final_output: Option<FinalOutput>) -> Result<Self, String> {
    let remaining = deadline_ms.checked_sub(super::now_ms()).filter(|remaining| *remaining > 0)
      .ok_or("render execution deadline has already expired")?;
    let deadline = Instant::now().checked_add(Duration::from_millis(remaining)).ok_or("render execution deadline overflow")?;
    Ok(Self { state: Mutex::new(State { final_output, ..State::default() }), wake: pipe::Wake::new().map_err(|error| error.to_string())?,
      budget: super::budget::Budget::new(super::budget::RENDER_COMMIT_LIMIT)?, deadline, settled: Condvar::new(),
      resident_limit: super::budget::RENDER_RESIDENT_LIMIT })
  }

  fn spawn(self: &Arc<Self>, executable: &Path, args: &[String], cwd: Option<&str>,
    input: bool, role: WorkerRole, guard: &StartGuard) -> Result<TrackedChild, String> {
    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    if state.cancelled { return Err("streaming render was cancelled before worker start".into()); }
    if Instant::now() >= self.deadline { return Err("render execution deadline expired before worker start".into()); }
    guard()?;
    let mut command = Command::new(executable);
    command.args(args).stdin(if input { Stdio::piped() } else { Stdio::null() })
      .stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(cwd) = cwd { command.current_dir(cwd); }
    if let Some(output) = state.final_output.as_ref() {
      output.output_limit.as_ref().ok_or("native output write limit is missing")?.configure(&mut command);
    }
    #[cfg(windows)]
    {
      use std::os::windows::process::CommandExt;
      command.creation_flags(0x08000000);
    }
    let child = Arc::new(self.budget.spawn(&mut command)?);
    state.children.insert(child.id(), RegisteredWorker { child: child.clone(), role });
    Ok(TrackedChild { child: Some(child), control: self.clone() })
  }

  fn stop(&self) {
    let children = {
      let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
      if state.cancelled { return; }
      state.cancelled = true;
      state.children.values().map(|worker| worker.child.clone()).collect::<Vec<_>>()
    };
    self.wake.signal();
    for child in children {
      if let Err(error) = child.kill() { log::warn!("could not stop owned streaming worker: {error}"); }
    }
  }

  fn watch(self: &Arc<Self>) {
    let control = self.clone();
    std::thread::spawn(move || {
      let mut state = control.state.lock().unwrap_or_else(|error| error.into_inner());
      while !state.settled {
        let remaining = control.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
          state.expired = true;
          drop(state);
          control.stop();
          return;
        }
        let workers = state.children.values().cloned().collect::<Vec<_>>();
        let children = workers.iter().map(|worker| worker.child.clone()).collect::<Vec<_>>();
        drop(state);
        let resident = super::budget::resident_samples(&children);
        state = control.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.settled { return; }
        match resident {
          Ok((bytes, samples)) => {
            if bytes >= state.resident_peak {
              state.resident_peak = bytes;
              state.resident_workers = workers.iter().filter_map(|worker|
                samples.iter().find(|(pid, _)| *pid == worker.child.id()).map(|(pid, bytes)|
                  ResidentWorker { pid: *pid, role: worker.role, bytes: *bytes })).collect();
              state.resident_workers.sort_by_key(|worker| worker.pid);
            }
            if bytes > control.resident_limit {
              state.resource_failure = Some(format!("render resident memory budget exceeded: sampled={bytes}, limit={}", control.resident_limit));
            }
          }
          Err(error) => { state.resource_failure = Some(format!("render resident memory accounting failed: {error}")); }
        }
        if state.resource_failure.is_some() {
          drop(state);
          control.stop();
          return;
        }
        state = control.settled.wait_timeout(state, remaining.min(Duration::from_millis(100)))
          .unwrap_or_else(|error| error.into_inner()).0;
      }
    });
  }

  fn memory_diagnostics(&self) -> String {
    let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    format!("native render resident: {}\n", serde_json::json!({ "sampled_peak": state.resident_peak,
      "limit": self.resident_limit, "workers_at_peak": state.resident_workers }))
  }

  fn finish_output(&self, producer: Result<(), String>) -> Result<(), String> {
    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    let cleanup = if !state.children.is_empty() { Err("native output still has unsettled writers".into()) }
      else if let Some(output) = state.final_output.as_mut() { output.finish(producer.is_ok()) }
      else { Ok(()) };
    with_cleanup(producer, cleanup)
  }

  fn finish_scratch(&self, mut scratch: ManifestScratch) -> Result<(), String> {
    let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    if !state.settled || !state.children.is_empty() {
      scratch.retain();
      return Err("native streaming scratch still has unsettled workers; files and workspace reservation retained".into());
    }
    drop(state);
    scratch.close()
  }

  fn settle(&self) -> Result<(), String> {
    let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
    state.settled = true;
    state.expired |= Instant::now() >= self.deadline;
    self.settled.notify_all();
    if let Some(error) = &state.resource_failure { return Err(error.clone()); }
    if state.expired { Err("render execution deadline expired; worker group stopped".into()) } else { Ok(()) }
  }
}

fn execution_deadline(spec: &JobSpec) -> Result<u64, String> {
  spec.meta.get("_native_execution_deadline").and_then(|value| value.as_u64())
    .ok_or_else(|| "native render has no admitted execution deadline".into())
}

fn temporary_diagnostics(workspace: &super::Workspace, key: &str) -> String {
  format!("native render temporary: {}\n", serde_json::json!({ "accounted_peak_payload_bytes": workspace.peak_bytes(key) }))
}

#[derive(Clone, serde::Deserialize)]
pub(super) struct AudioProducer {
  pub args: Vec<String>,
  pub duration: f64,
}

pub(super) fn audio_producer(spec: &JobSpec) -> Result<Option<AudioProducer>, String> {
  let Some(value) = spec.meta.get("renderAudio") else { return Ok(None) };
  if !super::is_streamed(spec) || spec.program != "ffmpeg" || spec.lane != "export" || spec.steps.is_empty() {
    return Err("continuous audio requires an admitted streaming render".into());
  }
  let audio: AudioProducer = serde_json::from_value(value.clone()).map_err(|error| format!("invalid continuous audio contract: {error}"))?;
  if !audio.duration.is_finite() || audio.duration <= 0.0 || audio.args.last().map(String::as_str) != Some("audio.nut") ||
    !audio.args.iter().any(|arg| arg == "-vn") ||
    !audio.args.windows(2).any(|pair| pair == ["-c:a", "pcm_f64le"]) ||
    !audio.args.windows(2).any(|pair| pair == ["-f", "nut"]) {
    return Err("continuous audio must emit a finite lossless audio-only NUT stream".into());
  }
  Ok(Some(audio))
}

struct TrackedChild {
  child: Option<Arc<SharedChild>>,
  control: Arc<Control>,
}

impl TrackedChild {
  fn child(&self) -> &SharedChild { self.child.as_ref().expect("tracked worker exists") }

  fn wait(mut self) -> Result<(), String> {
    let status = self.child().wait().map_err(|error| error.to_string())?;
    let pid = self.child().id();
    self.control.state.lock().unwrap_or_else(|error| error.into_inner()).children.remove(&pid);
    self.child.take();
    if status.success() { Ok(()) } else { Err(format!("worker exited with {status}")) }
  }
}

impl Drop for TrackedChild {
  fn drop(&mut self) {
    if let Some(child) = self.child.take() {
      let _ = child.kill();
      if child.wait().is_ok() {
        self.control.state.lock().unwrap_or_else(|error| error.into_inner()).children.remove(&child.id());
      }
    }
  }
}

fn consumer_args(args: &[String], manifest: &Path, audio: Option<&str>) -> Result<Vec<String>, String> {
  let input = args.windows(6).position(|part| part == ["-f", "concat", "-safe", "1", "-i", "segments.ffconcat"])
    .ok_or("streaming final command has no supported composed input")?;
  let mut args = args.to_vec();
  args.splice(input..input + 6, ["-f".into(), "concat".into(), "-safe".into(), "0".into(), "-i".into(), manifest.to_string_lossy().into_owned()]);
  if let Some(audio) = audio {
    let input = args.windows(2).position(|pair| pair == ["-i", "audio.nut"])
      .ok_or("continuous audio final command has no admitted audio input")?;
    args[input + 1] = audio.to_owned();
  }
  Ok(args)
}

fn pump_audio(executable: &Path, cwd: Option<&str>, audio: AudioProducer, pipe: pipe::Pipe,
  control: Arc<Control>, observer: Observer, guard: StartGuard) -> JoinHandle<Result<(), String>> {
  let executable = executable.to_path_buf();
  let cwd = cwd.map(str::to_owned);
  std::thread::spawn(move || {
    let result = (|| -> Result<(), String> {
      let args = super::captured_output_args(&audio.args)?;
      let producer = control.spawn(&executable, &args, cwd.as_deref(), false, WorkerRole::ContinuousAudio, &guard)?;
      let mut bytes = producer.child().take_stdout().ok_or("continuous audio producer has no output")?;
      let errors = producer.child().take_stderr().ok_or("continuous audio producer has no diagnostics")?;
      let diagnostics = reader(errors, observer, control.clone(), None, true);
      let copied = match pipe.copy(&mut bytes, &control.wake) {
        Err(error) if matches!(error.kind(), std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::Interrupted) &&
          control.state.lock().unwrap_or_else(|error| error.into_inner()).consumer_completed =>
            std::io::copy(&mut bytes, &mut std::io::sink()).map(|_| ()).map_err(|error| error.to_string()),
        result => result.map_err(|error| error.to_string()),
      };
      if copied.is_err() { control.stop(); }
      let ended = producer.wait();
      let errors = join(diagnostics);
      copied.and(ended).and(errors)
    })();
    if result.is_err() { control.stop(); }
    result.map_err(|error| format!("continuous audio producer failed: {error}"))
  })
}

fn join(reader: JoinHandle<Result<(), String>>) -> Result<(), String> {
  reader.join().map_err(|_| "streaming worker thread panicked".to_string())?
}

fn reader(input: impl Read + Send + 'static, observer: Observer, control: Arc<Control>,
  progress: Option<(Option<usize>, Arc<AtomicBool>)>, diagnostic: bool) -> JoinHandle<Result<(), String>> {
  std::thread::spawn(move || {
    let mut input = input;
    let mut buffer = [0u8; 8192];
    loop {
      let count = match input.read(&mut buffer) {
        Ok(0) => return Ok(()),
        Ok(count) => count,
        Err(error) => { control.stop(); return Err(error.to_string()); }
      };
      let text = String::from_utf8_lossy(&buffer[..count]).into_owned();
      if let Some((step, enabled)) = &progress {
        if enabled.load(Ordering::Acquire) {
          observer(ProcEvent::Stdout(if let Some(step) = step { format!("artdaddy_step={step}\n{text}") } else { text.clone() }));
        }
      }
      if diagnostic { observer(ProcEvent::Stderr(text)); }
    }
  })
}

pub(super) fn cancel(registry: &Registry, id: &str, pid: u32) -> bool {
  let control = registry.lock().unwrap_or_else(|error| error.into_inner()).get(&(id.to_owned(), pid)).cloned();
  if let Some(control) = control { control.stop(); true } else { false }
}

pub(super) fn spawn_single(executable: &Path, spec: &JobSpec, observer: Observer, registry: Registry, workspace: Arc<super::Workspace>) -> Result<u32, String> {
  let deadline = execution_deadline(spec)?;
  let workspace_key = spec.cwd.as_deref().map(|cwd| super::Supervisor::workspace_key(Path::new(cwd)));
  let (mut capture, mut args) = match super::ScratchOutput::capture(spec, workspace.clone())? {
    Some((capture, args)) => (Some(capture), args),
    None => (None, spec.args.clone()),
  };
  let captured = capture.is_some();
  let started = (|| -> Result<_, String> {
    let final_output = FinalOutput::open(spec, &mut args, workspace.clone())?;
    let control = Arc::new(Control::new(deadline, final_output)?);
    let guard: StartGuard = Arc::new(|| Ok(()));
    let worker = control.spawn(executable, &args, spec.cwd.as_deref(), false, WorkerRole::Single, &guard)?;
    let output = worker.child().take_stdout().ok_or("native worker has no output stream")?;
    let errors = worker.child().take_stderr().ok_or("native worker has no error stream")?;
    Ok((control, worker, output, errors))
  })();
  let (control, worker, mut output, errors) = match started {
    Ok(started) => started,
    Err(error) => return Err(match capture { Some(capture) => capture.abort(error), None => error }),
  };
  let pid = worker.child().id();
  let key = (spec.id.clone(), pid);
  registry.lock().unwrap_or_else(|error| error.into_inner()).insert(key.clone(), control.clone());
  control.watch();
  std::thread::spawn(move || {
    let stderr = reader(errors, observer.clone(), control.clone(),
      captured.then(|| (None, Arc::new(AtomicBool::new(true)))), true);
    let output_observer = observer.clone();
    let output_control = control.clone();
    let stdout = std::thread::spawn(move || {
      let read = (|| -> Result<(), String> {
        let mut buffer = [0u8; 65536];
        loop {
          let count = output.read(&mut buffer).map_err(|error| error.to_string())?;
          if count == 0 { break; }
          if let Some(writer) = capture.as_mut() { writer.write(&buffer[..count])?; }
          else { output_observer(ProcEvent::Stdout(String::from_utf8_lossy(&buffer[..count]).into_owned())); }
        }
        Ok(())
      })();
      if read.is_err() { output_control.stop(); }
      (read, capture)
    });
    let ended = worker.wait();
    let (read, capture) = stdout.join().unwrap_or_else(|_| (Err("native output reader panicked".into()), None));
    let diagnostics = join(stderr);
    let mut result = control.settle().and(read).and(diagnostics).and(ended);
    if let Some(capture) = capture {
      result = match result {
        Ok(()) => capture.finish(Some(0)),
        Err(error) => Err(capture.abort(error)),
      };
    }
    result = control.finish_output(result);
    observer(ProcEvent::Stderr(control.memory_diagnostics()));
    if let Some(key) = workspace_key { observer(ProcEvent::Stderr(temporary_diagnostics(&workspace, &key))); }
    if let Ok((limit, peak)) = control.budget.commit_accounting() {
      observer(ProcEvent::Stderr(format!("native render budget: configured_commit={limit}, reported_peak={peak}; peak is accounting, not an exact physical ceiling\n")));
    }
    registry.lock().unwrap_or_else(|error| error.into_inner()).remove(&key);
    match result {
      Ok(()) => observer(ProcEvent::Exit(Some(0))),
      Err(error) => {
        observer(ProcEvent::Stderr(format!("native render failed: {error}\n")));
        observer(ProcEvent::Exit(Some(-1)));
      }
    }
  });
  Ok(pid)
}

pub(super) fn spawn(executable: &Path, spec: &JobSpec, observer: Observer,
  guard: StartGuard, registry: Registry, workspace: Arc<super::Workspace>) -> Result<u32, String> {
  let (final_args, remaining) = spec.steps.split_last().ok_or("streaming render needs producers and a final command")?;
  let audio = audio_producer(spec)?;
  let deadline = execution_deadline(spec)?;
  let mut producers = Vec::new();
  let mut durations = Vec::new();
  for args in std::iter::once(&spec.args).chain(remaining.iter()) {
    if !args.windows(2).any(|pair| pair == ["-f", "nut"]) {
      return Err("streaming producer must emit lossless NUT".into());
    }
    let duration = args.windows(2).rfind(|pair| pair[0] == "-t")
      .and_then(|pair| pair[1].parse::<f64>().ok()).filter(|duration| duration.is_finite() && *duration > 0.0)
      .ok_or("streaming producer has no finite positive duration")?;
    if producers.len() >= 4096 { return Err("streaming partition count exceeds its native handle budget".into()); }
    durations.push(duration);
    producers.push(super::captured_output_args(args)?);
  }
  let cwd_path = Path::new(spec.cwd.as_deref().ok_or("streaming render needs owned scratch")?);
  let key = super::Supervisor::workspace_key(cwd_path);
  let mut scratch_guard = ManifestScratch::open(cwd_path, &workspace, &key, producers.len() as u64 + 2 + u64::from(audio.is_some()))?;
  let started = (|| -> Result<_, String> {
    let manifest = scratch_guard.path().join("segments.ffconcat");
    let mut pipes = Vec::new();
    let mut manifest_content = "ffconcat version 1.0\n".to_owned();
    for (index, duration) in durations.iter().enumerate() {
      let pipe = pipe::Pipe::new(scratch_guard.path(), index).map_err(|error| error.to_string())?;
      manifest_content.push_str(&format!("file '{}'\nduration {duration:.9}\n", pipe.path().replace('\'', "'\\''")));
      pipes.push(pipe);
    }
    let audio_pipe = audio.as_ref().map(|_| pipe::Pipe::new(scratch_guard.path(), producers.len())).transpose().map_err(|error| error.to_string())?;
    let mut final_args = consumer_args(final_args, &manifest, audio_pipe.as_ref().map(|pipe| pipe.path()))?;
    scratch_guard.admit_manifest(manifest_content.len() as u64)?;
    std::fs::write(&manifest, manifest_content).map_err(|error| error.to_string())?;
    let final_budget = FinalOutput::open(spec, &mut final_args, workspace.clone())?;
    let control = Arc::new(Control::new(deadline, final_budget)?);
    let consumer = control.spawn(executable, &final_args, spec.cwd.as_deref(), false, WorkerRole::FinalEncoder, &guard)?;
    let output = consumer.child().take_stdout().ok_or("streaming consumer has no progress stream")?;
    let errors = consumer.child().take_stderr().ok_or("streaming consumer has no error stream")?;
    Ok((control, consumer, output, errors, pipes, audio_pipe))
  })();
  let (control, consumer, output, errors, pipes, audio_pipe) = match started {
    Ok(started) => started,
    Err(error) => return Err(scratch_guard.cleanup_error(error)),
  };
  let pid = consumer.child().id();
  let child_key = (spec.id.clone(), pid);
  registry.lock().unwrap_or_else(|error| error.into_inner()).insert(child_key.clone(), control.clone());
  control.watch();
  let executable = executable.to_path_buf();
  let cwd = spec.cwd.clone();
  std::thread::spawn(move || {
    let audio_worker = audio.zip(audio_pipe).map(|(audio, pipe)|
      pump_audio(&executable, cwd.as_deref(), audio, pipe, control.clone(), observer.clone(), guard.clone()));
    let final_phase = Arc::new(AtomicBool::new(false));
    let final_output = reader(output, observer.clone(), control.clone(), Some((Some(producers.len()), final_phase.clone())), false);
    let final_errors = reader(errors, observer.clone(), control.clone(), None, true);
    let waiting_control = control.clone();
    let waiter = std::thread::spawn(move || {
      let result = consumer.wait();
      let expected_end = {
        let mut state = waiting_control.state.lock().unwrap_or_else(|error| error.into_inner());
        state.consumer_completed = result.is_ok();
        state.input_closed || state.last_producer_started
      };
      if result.is_err() || !expected_end { waiting_control.stop(); }
      else { waiting_control.wake.signal(); }
      result.and_then(|_| if expected_end { Ok(()) } else { Err("final worker exited before its producer input completed".into()) })
    });
    let produced = (|| -> Result<(), String> {
      for (step, (args, pipe)) in producers.iter().zip(pipes).enumerate() {
        let last = step + 1 == producers.len();
        if last { control.state.lock().unwrap_or_else(|error| error.into_inner()).last_producer_started = true; }
        observer(ProcEvent::Stdout(format!("artdaddy_step={step}\n")));
        let producer = control.spawn(&executable, args, cwd.as_deref(), false, WorkerRole::PartitionProducer, &guard)
          .map_err(|error| format!("producer {} could not start: {error}", step + 1))?;
        let mut bytes = producer.child().take_stdout().ok_or("streaming producer has no media output")?;
        let errors = producer.child().take_stderr().ok_or("streaming producer has no error output")?;
        let progress = reader(errors, observer.clone(), control.clone(), Some((Some(step), Arc::new(AtomicBool::new(true)))), true);
        let copied = match pipe.copy(&mut bytes, &control.wake) {
          Err(error) if last && error.kind() == std::io::ErrorKind::BrokenPipe =>
            std::io::copy(&mut bytes, &mut std::io::sink()).map(|_| ()).map_err(|error| error.to_string()),
          Err(error) if last && error.kind() == std::io::ErrorKind::Interrupted &&
              control.state.lock().unwrap_or_else(|error| error.into_inner()).consumer_completed =>
            std::io::copy(&mut bytes, &mut std::io::sink()).map(|_| ()).map_err(|error| error.to_string()),
          result => result.map_err(|error| error.to_string()),
        };
        if copied.is_err() { control.stop(); }
        let ended = producer.wait();
        let read = join(progress);
        copied.and(ended).and(read).map_err(|error| format!("producer {} failed: {error}", step + 1))?;
      }
      control.state.lock().unwrap_or_else(|error| error.into_inner()).input_closed = true;
      final_phase.store(true, Ordering::Release);
      observer(ProcEvent::Stdout(format!("artdaddy_step={}\n", producers.len())));
      Ok(())
    })();
    if produced.is_err() { control.stop(); }
    let audio_result = audio_worker.map(join).unwrap_or(Ok(()));
    let consumed = join(waiter);
    let output_read = join(final_output);
    let errors_read = join(final_errors);
    let mut result = control.settle().and(audio_result).and(produced).and(consumed).and(output_read).and(errors_read);
    result = control.finish_output(result);
    observer(ProcEvent::Stderr(control.memory_diagnostics()));
    observer(ProcEvent::Stderr(temporary_diagnostics(&workspace, &key)));
    if let Ok((limit, peak)) = control.budget.commit_accounting() {
      observer(ProcEvent::Stderr(format!("native render budget: configured_commit={limit}, reported_peak={peak}; peak is accounting, not an exact physical ceiling\n")));
    }
    result = with_cleanup(result, control.finish_scratch(scratch_guard));
    registry.lock().unwrap_or_else(|error| error.into_inner()).remove(&child_key);
    match result {
      Ok(()) => observer(ProcEvent::Exit(Some(0))),
      Err(error) => {
        observer(ProcEvent::Stderr(format!("native streaming render failed: {error}\n")));
        observer(ProcEvent::Exit(Some(-1)));
      }
    }
  });
  Ok(pid)
}

#[cfg(test)]
mod tests {
  use super::*;
  use super::super::{ArtifactIdentity, DeliverySource, JobState, Notice, Spawner, Supervisor};
  use std::sync::mpsc;
  use std::time::Duration;

  fn strings(args: &[&str]) -> Vec<String> { args.iter().map(|arg| (*arg).to_owned()).collect() }

  fn ffmpeg() -> std::path::PathBuf {
    let target = if cfg!(target_os = "windows") { "x86_64-pc-windows-msvc.exe" }
      else if cfg!(target_os = "macos") { "aarch64-apple-darwin" } else { "x86_64-unknown-linux-gnu" };
    Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join(format!("artdaddy-ffmpeg-{target}"))
  }

  #[test]
  fn output_write_limit_blocks_encoder_overshoot_and_preserves_a_fitting_movie() {
    let root = tempfile::tempdir().unwrap();
    let encode = |path: &Path, limit: u64, guarded: bool| {
      std::fs::File::create(path).unwrap();
      let bound = guarded.then(|| output::OutputLimit::open(path, limit).unwrap());
      let mut command = Command::new(ffmpeg());
      command.args(["-y", "-v", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=3",
        "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-an", "-fs", &limit.to_string(), "-movflags", "+faststart"])
        .arg(path);
      if let Some(bound) = bound.as_ref() { bound.configure(&mut command); }
      let result = command.output().unwrap();
      let bytes = std::fs::metadata(path).unwrap().len();
      (result, bytes)
    };
    let (control, control_bytes) = encode(&root.path().join("control.mp4"), 65536, false);
    assert!(control.status.success(), "{}", String::from_utf8_lossy(&control.stderr));
    assert!(control_bytes > 65536, "control cannot exhibit the original packet/trailer overshoot: {control_bytes}");
    let (capped, capped_bytes) = encode(&root.path().join("capped.mp4"), 65536, true);
    assert!(capped_bytes <= 65536, "native output crossed its admitted write boundary: {capped_bytes}");
    assert!(!capped.status.success(), "bounded incomplete output must not claim producer success");
    let fitting = root.path().join("fitting.mp4");
    let (completed, bytes) = encode(&fitting, 2 * 1024 * 1024, true);
    assert!(completed.status.success(), "{}", String::from_utf8_lossy(&completed.stderr));
    assert!(bytes > 65536 && bytes <= 2 * 1024 * 1024);
    let decoded = Command::new(ffmpeg()).args(["-v", "error", "-i"]).arg(&fitting)
      .args(["-map", "0:v:0", "-pix_fmt", "yuv420p", "-f", "rawvideo", "-"]).output().unwrap();
    assert!(decoded.status.success(), "{}", String::from_utf8_lossy(&decoded.stderr));
    let frame_bytes = 320 * 180 * 3 / 2;
    assert_eq!(decoded.stdout.len(), frame_bytes * 90);
    assert_ne!(&decoded.stdout[..frame_bytes], &decoded.stdout[frame_bytes * 89..]);
    println!("native output bytes: unguarded={control_bytes}, guarded={capped_bytes}, fitting={bytes}; fitting_frames=90");
  }

  fn spec(root: &Path) -> JobSpec {
    let producer = |pattern: &str, tones: &str, name: &str| strings(&["-y", "-v", "error", "-nostdin",
      "-f", "lavfi", "-i", pattern, "-f", "lavfi", "-i", tones,
      "-c:v", "ffv1", "-pix_fmt", "yuv420p", "-c:a", "pcm_f64le", "-t", "1", "-f", "nut", name]);
    JobSpec { id: "pipe".into(), lane: "export".into(), program: "ffmpeg".into(),
      args: producer("testsrc2=s=320x180:r=30:d=1", "aevalsrc=0.1*sin(2*PI*440*t)|0.08*sin(2*PI*880*t):s=48000:d=1", "part0.nut"),
      steps: vec![producer("testsrc=s=320x180:r=30:d=1", "aevalsrc=0.1*sin(2*PI*660*t)|0.08*sin(2*PI*1320*t):s=48000:d=1", "part1.nut"),
        strings(&["-y", "-v", "error", "-nostdin", "-f", "concat", "-safe", "1", "-i", "segments.ffconcat",
          "-vf", "null", "-af", "asetpts=N/SR/TB", "-c:v", "ffv1", "-pix_fmt", "yuv420p", "-c:a", "pcm_f64le", "-t", "2", "-f", "nut", "delivered.nut"])],
      cwd: Some(root.to_string_lossy().into_owned()),
      meta: serde_json::json!({ "_native_execution_deadline": super::super::now_ms() + 60_000 }) }
  }

  fn observed(start: impl FnOnce(Observer, Registry) -> Result<u32, String>) -> (i32, String) {
    let (sender, receiver) = mpsc::channel();
    let errors = Arc::new(Mutex::new(String::new()));
    let saved_errors = errors.clone();
    let observer: Observer = Arc::new(move |event| match event {
      ProcEvent::Exit(code) => { sender.send(code.unwrap_or(-1)).unwrap(); },
      ProcEvent::Stderr(text) | ProcEvent::Stdout(text) => { saved_errors.lock().unwrap().push_str(&text); },
    });
    start(observer, Arc::default()).unwrap();
    let code = receiver.recv_timeout(Duration::from_secs(30)).expect("streaming render did not settle");
    let errors = errors.lock().unwrap().clone();
    (code, errors)
  }

  fn run(spec: &JobSpec, guard: StartGuard) -> (i32, String) {
    observed(|observer, registry| spawn(&ffmpeg(), spec, observer, guard, registry, super::super::Workspace::new(20_000_000_000)))
  }

  fn continuous_spec(root: &Path) -> JobSpec {
    let mut spec = spec(root);
    let video = |pattern: &str, filename: &str| strings(&["-y", "-v", "error", "-nostdin", "-f", "lavfi", "-i", pattern,
      "-c:v", "ffv1", "-pix_fmt", "yuv420p", "-an", "-t", "1", "-f", "nut", filename]);
    spec.args = video("testsrc2=s=320x180:r=30:d=1", "part0.nut");
    spec.steps[0] = video("testsrc=s=320x180:r=30:d=1", "part1.nut");
    *spec.steps.last_mut().unwrap() = strings(&["-y", "-v", "error", "-nostdin", "-f", "concat", "-safe", "1", "-i", "segments.ffconcat",
      "-f", "nut", "-i", "audio.nut", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "ffv1", "-pix_fmt", "yuv420p",
      "-c:a", "pcm_f64le", "-t", "2", "-f", "nut", "delivered.nut"]);
    spec.meta["renderTransport"] = serde_json::json!("partition-pipes-v1");
    spec.meta["renderAudio"] = serde_json::json!({ "duration": 2,
      "args": strings(&["-y", "-v", "error", "-nostdin", "-f", "lavfi", "-i",
        "aevalsrc=0.1*sin(2*PI*440*t)|0.08*sin(2*PI*880*t):s=48000:d=2", "-map", "0:a:0", "-vn", "-c:a", "pcm_f64le",
        "-ar", "48000", "-t", "2", "-f", "nut", "audio.nut"]) });
    spec
  }

  use super::super::export_delivery_tests::CleanupBlocker;

  fn stream_directory(cwd: &Path) -> std::path::PathBuf {
    let found = std::fs::read_dir(cwd).unwrap().map(|entry| entry.unwrap().path())
      .filter(|path| path.file_name().unwrap().to_string_lossy().starts_with("native-stream-")).collect::<Vec<_>>();
    assert_eq!(found.len(), 1);
    found[0].clone()
  }

  #[test]
  fn stream_entry_refusal_and_late_invalid_producers_cannot_create_staging() {
    for audio in [false, true] {
      for refusal in ["entries", "late-producer"] {
        let directory = tempfile::tempdir().unwrap();
        let workspace = super::super::Workspace::new(1024 * 1024);
        let mut spec = if audio { continuous_spec(directory.path()) } else { spec(directory.path()) };
        if refusal == "entries" {
          workspace.reserve("entry-pressure", 0, 16382).unwrap().retain();
        } else {
          let format = spec.steps[0].iter().rposition(|arg| arg == "nut").unwrap();
          spec.steps[0][format] = "mp4".into();
        }
        let stamp = super::super::export_delivery_tests::journal_write_clock(directory.path());
        let result = spawn(&directory.path().join("must-not-start"), &spec, Arc::new(|_| panic!("refused staging emitted a worker event")),
          Arc::new(|| panic!("refused staging reached worker admission")), Arc::default(), workspace.clone());
        let error = result.unwrap_err();
        assert!(error.contains(if refusal == "entries" { "entry budget" } else { "lossless NUT" }), "{error}");
        assert_eq!(directory.path().metadata().unwrap().modified().unwrap(), stamp, "{refusal}: staging was created before admission");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        assert_eq!(workspace.available_bytes(), 1024 * 1024);
        if refusal == "entries" {
          let last = workspace.reserve("still-available", 0, 1).unwrap();
          assert!(workspace.reserve("overflow", 0, 1).is_err());
          drop(last);
        }
      }
    }
  }

  #[test]
  fn stream_setup_failures_clean_actual_artifacts_before_releasing_capacity() {
    for audio in [false, true] {
      for refusal in ["bytes", "consumer", "spawn"] {
        let directory = tempfile::tempdir().unwrap();
        let retained = directory.path().join("retained.bin");
        std::fs::write(&retained, [37u8; 32]).unwrap();
        let limit = if refusal == "bytes" { 32 } else { 1024 * 1024 };
        let workspace = super::super::Workspace::new(limit);
        let mut spec = if audio { continuous_spec(directory.path()) } else { spec(directory.path()) };
        if refusal == "consumer" {
          let args = spec.steps.last_mut().unwrap();
          let manifest = args.iter().position(|arg| arg == "segments.ffconcat").unwrap();
          args[manifest] = "unadmitted.ffconcat".into();
        }
        let result = spawn(&directory.path().join("missing-worker"), &spec, Arc::new(|_| panic!("failed setup emitted a worker event")),
          Arc::new(|| Ok(())), Arc::default(), workspace.clone());
        let error = result.unwrap_err();
        assert!(!error.is_empty());
        if refusal == "bytes" { assert!(error.contains("workspace budget exceeded"), "{error}"); }
        if refusal == "consumer" { assert!(error.contains("composed input"), "{error}"); }
        assert_eq!(std::fs::read(&retained).unwrap(), vec![37u8; 32]);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1, "{refusal}: failed setup left staging behind");
        assert_eq!(workspace.available_bytes(), limit - 32);
        let remaining_entries = workspace.reserve("entry-reuse", 0, 16382).unwrap();
        assert!(workspace.reserve("one-too-many", 0, 1).is_err());
        drop(remaining_entries);
      }
    }
  }

  #[test]
  fn failed_stream_setup_cleanup_keeps_both_errors_bytes_and_restart_charge() {
    for audio in [false, true] {
      let directory = tempfile::tempdir().unwrap();
      let work = directory.path().join("work");
      let journal = directory.path().join("journal");
      let mut jobs = Supervisor::new(Arc::new(super::super::export_delivery_tests::NoSpawn), Arc::new(|_| {}))
        .with_export_work_root(work.clone()).with_export_root(journal.clone()).unwrap();
      jobs.workspace = super::super::Workspace::new(1024 * 1024);
      let delivery = jobs.prepare_delivery("retained-stream".into(), "original-project".into(),
        directory.path().join("render.partial").to_string_lossy().into(), directory.path().join("previous.mp4").to_string_lossy().into(),
        DeliverySource::Render { paths: vec![] }).unwrap();
      std::fs::write(&delivery.dest_path, b"previous complete destination").unwrap();
      let cwd = jobs.stage_render_scratch(&delivery.id, vec![], vec![]).unwrap();
      let cwd = Path::new(&cwd);
      let spec = if audio { continuous_spec(cwd) } else { spec(cwd) };
      let blocked = Arc::new(Mutex::new(None));
      let obstruction = blocked.clone();
      let manifest_before = Arc::new(Mutex::new(Vec::new()));
      let saved = manifest_before.clone();
      let inspected = cwd.to_path_buf();
      let result = spawn(&directory.path().join("must-not-start"), &spec, Arc::new(|_| panic!("refused worker emitted an event")),
        Arc::new(move || {
          let manifest = stream_directory(&inspected).join("segments.ffconcat");
          *saved.lock().unwrap() = std::fs::read(&manifest).unwrap();
          *obstruction.lock().unwrap() = Some(CleanupBlocker::open(&manifest));
          Err("primary worker-admission refusal".into())
        }), Arc::default(), jobs.workspace.clone());
      drop(blocked.lock().unwrap().take());
      let error = result.unwrap_err();
      assert!(error.contains("primary worker-admission refusal"), "{error}");
      assert!(error.contains("scratch cleanup failed; workspace reservation retained"), "{error}");
      let before = manifest_before.lock().unwrap().clone();
      assert!(!before.is_empty());
      assert_eq!(std::fs::read(stream_directory(cwd).join("segments.ffconcat")).unwrap(), before);
      assert_eq!(jobs.workspace.available_bytes(), 1024 * 1024 - before.len() as u64);
      drop(jobs);
      let limit = before.len() as u64 - 1;
      let mut recovered = Supervisor::new(Arc::new(super::super::export_delivery_tests::NoSpawn), Arc::new(|_| {}));
      recovered.workspace = super::super::Workspace::new(limit);
      let recovered = recovered.with_export_work_root(work).with_export_root(journal).unwrap();
      assert_eq!(recovered.workspace.available_bytes(), 0);
      assert!(recovered.workspace.reserve("cannot-reuse-retained-bytes", 1, 1).is_err());
      recovered.cancel_delivery(&delivery.id).unwrap();
      recovered.complete_delivery(&delivery.id).unwrap();
      assert!(!cwd.exists());
      assert_eq!(recovered.workspace.available_bytes(), limit);
      assert_eq!(std::fs::read(&delivery.dest_path).unwrap(), b"previous complete destination");
    }
  }

  #[test]
  fn abandoned_or_unsettled_stream_staging_never_releases_a_live_reservation() {
    for unsettled in [false, true] {
      let directory = tempfile::tempdir().unwrap();
      let workspace = super::super::Workspace::new(64);
      let key = super::super::Supervisor::workspace_key(directory.path());
      let mut scratch = ManifestScratch::open(directory.path(), &workspace, &key, 2).unwrap();
      scratch.admit_manifest(16).unwrap();
      let path = scratch.path().to_path_buf();
      let manifest = path.join("segments.ffconcat");
      std::fs::write(&manifest, [37u8; 16]).unwrap();
      if unsettled {
        let control = Control::new(super::super::now_ms() + 60_000, None).unwrap();
        assert!(control.finish_scratch(scratch).unwrap_err().contains("unsettled workers"));
      } else { drop(scratch); }
      assert_eq!(std::fs::read(&manifest).unwrap(), vec![37u8; 16]);
      assert_eq!(workspace.available_bytes(), 48);
      assert!(workspace.reserve("cannot-reuse", 49, 1).is_err());
      std::fs::remove_dir_all(&path).unwrap();
      workspace.release(&key, 16, 2);
      assert_eq!(workspace.available_bytes(), 64);
    }
  }

  #[test]
  fn successful_stream_workers_cannot_report_success_after_failed_scratch_cleanup() {
    for audio in [false, true] {
      let directory = tempfile::tempdir().unwrap();
      let spec = if audio { continuous_spec(directory.path()) } else { spec(directory.path()) };
      let workspace = super::super::Workspace::new(1024 * 1024);
      let inspected = directory.path().to_path_buf();
      let blocked = Arc::new(Mutex::new(None));
      let obstruction = blocked.clone();
      let guard: StartGuard = Arc::new(move || {
        let mut blocked = obstruction.lock().unwrap();
        if blocked.is_none() {
          *blocked = Some(CleanupBlocker::open(&stream_directory(&inspected).join("segments.ffconcat")));
        }
        Ok(())
      });
      let watched: Registry = Arc::default();
      let registry = watched.clone();
      let owner = workspace.clone();
      let (code, diagnostics) = observed(|observer, _| spawn(&ffmpeg(), &spec, observer, guard, registry, owner));
      drop(blocked.lock().unwrap().take());
      assert_ne!(code, 0, "successful workers hid a failed cleanup");
      assert!(diagnostics.contains("scratch cleanup failed; workspace reservation retained"), "{diagnostics}");
      assert!(watched.lock().unwrap().is_empty(), "cleanup failure left owned workers running");
      let manifest = stream_directory(directory.path()).join("segments.ffconcat");
      let bytes = std::fs::read(&manifest).unwrap();
      assert!(!bytes.is_empty());
      assert_eq!(workspace.available_bytes(), 1024 * 1024 - bytes.len() as u64);
      let delivered = directory.path().join("delivered.nut");
      let decoded = Command::new(ffmpeg()).args(["-v", "error", "-i"]).arg(&delivered)
        .args(["-map", "0:v:0", "-pix_fmt", "yuv420p", "-f", "rawvideo", "-"]).output().unwrap();
      assert!(decoded.status.success(), "{}", String::from_utf8_lossy(&decoded.stderr));
      let frame_bytes = 320 * 180 * 3 / 2;
      assert_eq!(decoded.stdout.len(), frame_bytes * 60);
      assert_ne!(&decoded.stdout[..frame_bytes], &decoded.stdout[frame_bytes * 59..]);
      std::fs::remove_dir_all(manifest.parent().unwrap()).unwrap();
      let key = super::super::Supervisor::workspace_key(directory.path());
      workspace.release(&key, bytes.len() as u64, 4 + u64::from(audio));
      assert_eq!(workspace.available_bytes(), 1024 * 1024);
      println!("native streaming cleanup refusal: audio={audio}, workers_reaped=true, decoded_frames=60, retained_manifest_bytes={}", bytes.len());
    }
  }

  #[test]
  #[ignore = "requires the real bundled ffmpeg"]
  fn continuous_audio_runs_once_and_preserves_every_sample_without_a_scratch_media_file() {
    let dir = tempfile::tempdir().unwrap();
    let spec = continuous_spec(dir.path());
    let starts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = starts.clone();
    let (code, diagnostics) = run(&spec, Arc::new(move || { counted.fetch_add(1, Ordering::Relaxed); Ok(()) }));
    assert_eq!(code, 0, "{diagnostics}");
    assert_eq!(starts.load(Ordering::Relaxed), 4, "one final worker, one audio worker and two video workers must suffice");
    for name in ["audio.nut", "part0.nut", "part1.nut"] { assert!(!dir.path().join(name).exists()); }
    let audio = audio_producer(&spec).unwrap().unwrap();
    let reference = Command::new(ffmpeg()).args(&audio.args).current_dir(dir.path()).output().unwrap();
    assert!(reference.status.success());
    let decode = |filename: &str| {
      let output = Command::new(ffmpeg()).args(["-nostdin", "-v", "error", "-i", filename, "-map", "0:a:0", "-f", "f64le", "pipe:1"])
        .current_dir(dir.path()).output().unwrap();
      assert!(output.status.success());
      assert_eq!(output.stdout.len(), 1_536_000);
      output.stdout
    };
    assert!(decode("delivered.nut") == decode("audio.nut"), "continuous stereo sample bytes changed");
  }

  #[test]
  #[ignore = "requires the real bundled ffmpeg"]
  fn continuous_audio_failure_stops_the_entire_worker_group() {
    let dir = tempfile::tempdir().unwrap();
    let mut spec = continuous_spec(dir.path());
    let mut audio = audio_producer(&spec).unwrap().unwrap();
    let input = audio.args.iter().position(|arg| arg == "-i").unwrap();
    audio.args[input + 1] = "nonexistent_continuous_audio_source".into();
    spec.meta["renderAudio"]["args"] = serde_json::json!(audio.args);
    let registry: Registry = Arc::default();
    let watched = registry.clone();
    let (code, diagnostics) = observed(|observer, _| spawn(&ffmpeg(), &spec, observer, Arc::new(|| Ok(())), watched,
      super::super::Workspace::new(20_000_000_000)));
    assert_ne!(code, 0);
    assert!(diagnostics.contains("continuous audio producer failed"), "{diagnostics}");
    assert!(diagnostics.contains("nonexistent_continuous_audio_source"), "{diagnostics}");
    assert!(registry.lock().unwrap().is_empty());
    assert!(!dir.path().join("audio.nut").exists());
  }

  #[test]
  #[ignore = "requires the real bundled ffmpeg"]
  fn continuous_audio_cancellation_reaps_audio_video_and_final_encoding() {
    let dir = tempfile::tempdir().unwrap();
    let mut spec = continuous_spec(dir.path());
    spec.args.splice(0..0, strings(&["-re", "-progress", "pipe:1"]));
    let pattern = spec.args.iter().position(|arg| arg == "testsrc2=s=320x180:r=30:d=1").unwrap();
    spec.args[pattern] = "testsrc2=s=320x180:r=30:d=60".into();
    let duration = spec.args.iter().rposition(|arg| arg == "-t").unwrap();
    spec.args[duration + 1] = "60".into();
    let (armed, progress) = mpsc::channel();
    let (ended, completion) = mpsc::channel();
    let observer: Observer = Arc::new(move |event| match event {
      ProcEvent::Stdout(text) if text.contains("frame=") => { let _ = armed.send(()); },
      ProcEvent::Exit(code) => { let _ = ended.send(code); },
      _ => {},
    });
    let registry: Registry = Arc::default();
    let pid = spawn(&ffmpeg(), &spec, observer, Arc::new(|| Ok(())), registry.clone(), super::super::Workspace::new(20_000_000_000)).unwrap();
    let control = registry.lock().unwrap().get(&(spec.id.clone(), pid)).unwrap().clone();
    progress.recv_timeout(Duration::from_secs(10)).expect("continuous render did not reach actual producer progress");
    assert!(cancel(&registry, &spec.id, pid));
    assert_ne!(completion.recv_timeout(Duration::from_secs(10)).expect("continuous audio cancellation left workers running"), Some(0));
    assert!(control.state.lock().unwrap().children.is_empty());
    assert!(registry.lock().unwrap().is_empty());
    assert!(!dir.path().join("audio.nut").exists());
  }

  #[test]
  #[ignore = "requires the real bundled ffmpeg"]
  fn single_worker_capture_preserves_video_stereo_and_progress() {
    let dir = tempfile::tempdir().unwrap();
    let mut spec = spec(dir.path());
    spec.steps.clear();
    spec.args.splice(0..0, strings(&["-progress", "pipe:1"]));
    let baseline = Command::new(ffmpeg()).args(&spec.args).current_dir(dir.path()).output().unwrap();
    assert!(baseline.status.success());
    let target = dir.path().join("captured.nut");
    spec.meta["_native_scratch_capture"] = serde_json::json!({ "path": target, "used": 0, "limit": 2_000_000 });
    let (code, diagnostics) = observed(|observer, registry| spawn_single(&ffmpeg(), &spec, observer, registry, super::super::Workspace::new(20_000_000_000)));
    assert_eq!(code, 0, "{diagnostics}");
    assert!(diagnostics.contains("frame="));
    assert!(!diagnostics.contains("artdaddy_step="), "single-worker capture must not change the sequence's active step");
    for (stream, format, expected) in [("0:v:0", "rawvideo", 2_592_000), ("0:a:0", "f64le", 768_000)] {
      let decode = |path: &Path| {
        let output = Command::new(ffmpeg()).args(["-nostdin", "-v", "error", "-i"]).arg(path)
          .args(["-map", stream, "-f", format, "pipe:1"]).output().unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout.len(), expected);
        output.stdout
      };
      assert!(decode(&target) == decode(&dir.path().join("part0.nut")), "captured {stream} bytes differ");
    }
  }

  #[test]
  fn capture_setup_refusal_cleans_its_actual_file_before_reusing_capacity() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("captured.nut");
    std::fs::write(&target, b"previous verified target").unwrap();
    let workspace = super::super::Workspace::new(2_000_000);
    let mut spec = spec(directory.path());
    spec.steps.clear();
    spec.meta["_native_scratch_capture"] = serde_json::json!({ "path": target, "used": 0, "limit": 2_000_000 });
    let error = spawn_single(&directory.path().join("absent-native-worker"), &spec, Arc::new(|_| {}),
      Arc::default(), workspace.clone()).unwrap_err();
    assert!(!error.is_empty());
    assert_eq!(std::fs::read(&target).unwrap(), b"previous verified target");
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    assert_eq!(workspace.available_bytes() + std::fs::metadata(&target).unwrap().len(), 2_000_000);
  }

  #[test]
  fn complete_captured_media_cannot_hide_failed_install_and_cleanup() {
    let directory = tempfile::tempdir().unwrap();
    let mut spec = spec(directory.path());
    spec.steps.clear();
    spec.args.splice(0..0, strings(&["-progress", "pipe:1"]));
    let baseline = Command::new(ffmpeg()).args(&spec.args).current_dir(directory.path()).output().unwrap();
    assert!(baseline.status.success(), "{}", String::from_utf8_lossy(&baseline.stderr));
    let target = directory.path().join("captured.nut");
    std::fs::write(&target, b"previous verified target").unwrap();
    spec.meta["_native_scratch_capture"] = serde_json::json!({ "path": target, "used": 0, "limit": 2_000_000 });
    let workspace = super::super::Workspace::new(4_000_000);
    let blocker = Arc::new(Mutex::new(None));
    let retained = Arc::new(Mutex::new(None));
    let install_blocker = blocker.clone();
    let save_path = retained.clone();
    let cwd = directory.path().to_path_buf();
    let registry: Registry = Arc::default();
    let watched = registry.clone();
    let owner = workspace.clone();
    let (code, diagnostics) = observed(|observer, _| {
      let blocked: Observer = Arc::new(move |event| {
        if matches!(&event, ProcEvent::Stdout(text) | ProcEvent::Stderr(text) if text.contains("progress=end")) {
          let mut blocker = install_blocker.lock().unwrap();
          if blocker.is_none() {
            let files = std::fs::read_dir(&cwd).unwrap().map(|entry| entry.unwrap().path())
              .filter(|path| path.file_name().unwrap().to_string_lossy().starts_with(".tmp")).collect::<Vec<_>>();
            assert_eq!(files.len(), 1);
            *blocker = Some(CleanupBlocker::open(&files[0]));
            *save_path.lock().unwrap() = Some(files[0].clone());
          }
        }
        observer(event);
      });
      spawn_single(&ffmpeg(), &spec, blocked, watched, owner)
    });
    assert_ne!(code, 0, "complete encoded bytes cannot make failed installation look successful");
    assert!(diagnostics.contains("temporary output cleanup failed; workspace reservation retained"), "{diagnostics}");
    assert!(registry.lock().unwrap().is_empty());
    assert_eq!(std::fs::read(&target).unwrap(), b"previous verified target");
    let temporary = retained.lock().unwrap().clone().expect("the real producer never reached completion");
    let payload = std::fs::metadata(&temporary).unwrap().len();
    assert!(payload > 0);
    assert!(workspace.reserve("cannot-reuse-orphan", 4_000_000 - payload + 1, 1).is_err());
    for (stream, format, expected) in [("0:v:0", "rawvideo", 2_592_000), ("0:a:0", "f64le", 768_000)] {
      let decode = |path: &Path| {
        let output = Command::new(ffmpeg()).args(["-nostdin", "-v", "error", "-i"]).arg(path)
          .args(["-map", stream, "-f", format, "pipe:1"]).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(output.stdout.len(), expected);
        output.stdout
      };
      let actual = decode(&temporary);
      assert_eq!(actual, decode(&directory.path().join("part0.nut")), "retained {stream} is incomplete or different");
      if stream == "0:v:0" {
        assert_ne!(&actual[..320 * 180 * 3 / 2], &actual[actual.len() - 320 * 180 * 3 / 2..]);
      }
    }
    drop(blocker.lock().unwrap().take());
    let key = super::super::Supervisor::workspace_key(directory.path());
    directory.close().unwrap();
    workspace.release_root(&key);
    assert_eq!(workspace.available_bytes(), 4_000_000);
  }

  #[test]
  #[ignore = "requires the real bundled ffmpeg"]
  fn single_worker_quota_failure_preserves_previous_target_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let mut spec = spec(dir.path());
    spec.steps.clear();
    let target = dir.path().join("captured.nut");
    std::fs::write(&target, b"previous verified target").unwrap();
    spec.meta["_native_scratch_capture"] = serde_json::json!({ "path": target, "used": 0, "limit": 50_000 });
    let (code, diagnostics) = observed(|observer, registry| spawn_single(&ffmpeg(), &spec, observer, registry, super::super::Workspace::new(20_000_000_000)));
    assert_ne!(code, 0);
    assert!(diagnostics.contains("scratch budget exceeded"), "{diagnostics}");
    assert_eq!(std::fs::read(&target).unwrap(), b"previous verified target");
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "failed capture left unowned temporary output");
  }

  #[test]
  #[ignore = "requires the real bundled ffmpeg"]
  fn shared_workspace_refusal_preserves_previous_bytes_and_other_owned_allocations() {
    let dir = tempfile::tempdir().unwrap();
    let peer = tempfile::tempdir().unwrap();
    let workspace = super::super::Workspace::new(50_000);
    std::fs::write(peer.path().join("retained.bin"), vec![37u8; 32_000]).unwrap();
    workspace.account_existing("peer-render", 32_000, 1).unwrap();
    let mut spec = spec(dir.path());
    spec.steps.clear();
    let target = dir.path().join("captured.nut");
    std::fs::write(&target, b"previous verified target").unwrap();
    spec.meta["_native_scratch_capture"] = serde_json::json!({ "path": target, "used": 0, "limit": 2_000_000 });
    let owner = workspace.clone();
    let (code, diagnostics) = observed(|observer, registry| spawn_single(&ffmpeg(), &spec, observer, registry, owner));
    assert_ne!(code, 0);
    assert!(diagnostics.contains("workspace budget exceeded"), "{diagnostics}");
    assert_eq!(std::fs::read(&target).unwrap(), b"previous verified target");
    assert_eq!(std::fs::read(peer.path().join("retained.bin")).unwrap(), vec![37u8; 32_000]);
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    let remaining = 50_000 - 32_000 - b"previous verified target".len() as u64;
    assert!(workspace.reserve("after-failed-capture", remaining, 1).is_ok(), "failed temporary bytes were not released");
  }

  #[test]
  #[ignore = "requires the real bundled ffmpeg"]
  fn execution_deadline_stops_single_and_streamed_workers_before_success() {
    for streamed in [false, true] {
      let dir = tempfile::tempdir().unwrap();
      let mut spec = spec(dir.path());
      spec.args.splice(0..0, strings(&["-re"]));
      let pattern = spec.args.iter().position(|arg| arg == "testsrc2=s=320x180:r=30:d=1").unwrap();
      spec.args[pattern] = "testsrc2=s=320x180:r=30:d=60".into();
      let duration = spec.args.iter().rposition(|arg| arg == "-t").unwrap();
      spec.args[duration + 1] = "60".into();
      spec.meta["_native_execution_deadline"] = serde_json::json!(super::super::now_ms() + 2000);
      let previous = dir.path().join("previous-delivery.nut");
      std::fs::write(&previous, b"previous complete output").unwrap();
      if streamed {
        let final_args = spec.steps.last_mut().unwrap();
        let duration = final_args.iter().rposition(|arg| arg == "-t").unwrap();
        final_args[duration + 1] = "61".into();
      } else {
        spec.steps.clear();
        spec.meta["_native_scratch_capture"] = serde_json::json!({ "path": previous, "used": 0, "limit": 20_000_000 });
      }
      let registry: Registry = Arc::default();
      let watched = registry.clone();
      let (code, diagnostics) = observed(|observer, _| {
        if streamed { spawn(&ffmpeg(), &spec, observer, Arc::new(|| Ok(())), watched, super::super::Workspace::new(20_000_000_000)) }
        else { spawn_single(&ffmpeg(), &spec, observer, watched, super::super::Workspace::new(20_000_000_000)) }
      });
      assert_ne!(code, 0, "expired worker reported successful production");
      assert!(diagnostics.contains("execution deadline expired"), "{diagnostics}");
      assert!(registry.lock().unwrap().is_empty());
      assert_eq!(std::fs::read(previous).unwrap(), b"previous complete output");
    }
  }

  #[test]
  #[ignore = "controlled allocation child; invoked by its ownership test"]
  fn resident_allocator_child() {
    use std::io::Write;
    let root = std::env::current_dir().unwrap();
    if !root.file_name().unwrap_or_default().to_string_lossy().starts_with("artdaddy-memory-qa-") { return; }
    let bytes = vec![37u8; 64 * 1024 * 1024];
    println!("resident-child-ready");
    std::io::stdout().flush().unwrap();
    let mut input = [0u8; 1];
    std::io::stdin().read_exact(&mut input).unwrap();
    std::hint::black_box(&bytes);
    std::fs::write(root.join("completed.bin"), &bytes[..32]).unwrap();
  }

  #[test]
  fn resident_guard_stops_real_owned_allocations_without_allowing_a_final_side_effect() {
    use std::io::{BufRead, Write};
    for (limit, refused) in [(512 * 1024 * 1024, false), (32 * 1024 * 1024, true)] {
      let dir = tempfile::Builder::new().prefix("artdaddy-memory-qa-").tempdir().unwrap();
      let mut control = Control::new(super::super::now_ms() + 10_000, None).unwrap();
      control.resident_limit = limit;
      let control = Arc::new(control);
      let args = strings(&["--exact", "jobs::stream::tests::resident_allocator_child", "--ignored", "--nocapture"]);
      let guard: StartGuard = Arc::new(|| Ok(()));
      let worker = control.spawn(&std::env::current_exe().unwrap(), &args, dir.path().to_str(), true, WorkerRole::Single, &guard).unwrap();
      let pid = worker.child().id();
      let mut input = worker.child().take_stdin().unwrap();
      let output = worker.child().take_stdout().unwrap();
      let _errors = worker.child().take_stderr().unwrap();
      control.watch();
      if !refused {
        let mut output = std::io::BufReader::new(output);
        let mut line = String::new();
        loop {
          line.clear();
          assert_ne!(output.read_line(&mut line).unwrap(), 0, "allocation control exited before its outcome");
          if line.contains("resident-child-ready") { break; }
        }
        input.write_all(&[1]).unwrap();
        assert!(worker.wait().is_ok());
        assert!(control.settle().is_ok());
        assert_eq!(std::fs::read(dir.path().join("completed.bin")).unwrap(), vec![37; 32]);
      } else {
        assert!(worker.wait().is_err());
        assert!(control.settle().unwrap_err().contains("resident memory budget exceeded"));
        let state = control.state.lock().unwrap();
        assert!(state.resident_peak > limit);
        assert_eq!(state.resident_workers.len(), 1);
        assert_eq!(state.resident_workers[0].pid, pid);
        assert!(state.resident_workers[0].bytes > limit);
        assert!(state.children.is_empty());
        assert!(!dir.path().join("completed.bin").exists());
        drop(state);
        let diagnostic = control.memory_diagnostics();
        let parsed: serde_json::Value = serde_json::from_str(diagnostic.trim().strip_prefix("native render resident: ").unwrap()).unwrap();
        assert_eq!(parsed["workers_at_peak"][0]["role"], "single");
        assert_eq!(parsed["workers_at_peak"][0]["bytes"], parsed["sampled_peak"]);
      }
    }
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn terminal_sampling_cannot_release_a_final_writer_or_its_output_capacity() {
    use std::io::{BufRead, Write};
    let dir = tempfile::tempdir().unwrap();
    let stage = dir.path().join("completed.bin");
    std::fs::File::create(&stage).unwrap();
    let workspace = super::super::Workspace::new(64);
    let key = super::super::Supervisor::workspace_key(&stage);
    let _claim = workspace.claim_output(&key, &|| Ok(())).unwrap();
    let mut admitted = spec(dir.path());
    admitted.meta["_native_final_stage"] = serde_json::json!(stage.to_string_lossy());
    let mut final_args = vec![stage.to_string_lossy().into_owned()];
    let final_output = FinalOutput::open(&admitted, &mut final_args, workspace.clone()).unwrap().unwrap();
    let control = Arc::new(Control::new(super::super::now_ms() + 10_000, Some(final_output)).unwrap());
    let args = strings(&["-c", "printf 'ready\\n'; read -r finish; printf completed > completed.bin"]);
    let guard: StartGuard = Arc::new(|| Ok(()));
    let worker = control.spawn(Path::new("/bin/sh"), &args, dir.path().to_str(), true, WorkerRole::FinalEncoder, &guard).unwrap();
    let pid = worker.child().id();
    let mut input = worker.child().take_stdin().unwrap();
    let mut output = std::io::BufReader::new(worker.child().take_stdout().unwrap());
    let mut ready = String::new();
    output.read_line(&mut ready).unwrap();
    assert_eq!(ready.trim(), "ready");
    let (_, live) = super::super::budget::resident_samples(&[worker.child.as_ref().unwrap().clone()]).unwrap();
    assert_eq!(live.len(), 1);
    assert!(live[0].1 > 0);
    input.write_all(b"finish\n").unwrap();
    drop(input);
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
      let (_, live) = super::super::budget::resident_samples(&[worker.child.as_ref().unwrap().clone()]).unwrap();
      if live.is_empty() { break; }
      assert!(Instant::now() < deadline, "terminal writer remained a live memory sample");
      std::thread::yield_now();
    }
    assert!(control.state.lock().unwrap().children.contains_key(&pid));
    assert!(control.finish_output(Ok(())).unwrap_err().contains("unsettled writers"));
    assert_eq!(workspace.available_bytes(), 0);
    assert!(workspace.reserve("peer", 1, 1).is_err(), "sampling released a writer's reserved output capacity");
    worker.wait().unwrap();
    control.finish_output(Ok(())).unwrap();
    assert_eq!(std::fs::read(&stage).unwrap(), b"completed");
    let _peer = workspace.reserve("peer", 55, 1).unwrap();
    assert!(workspace.reserve("overflow", 1, 1).is_err());
    control.settle().unwrap();
  }

  #[test]
  fn refuses_unknown_transport_before_starting_workers() {
    let dir = tempfile::tempdir().unwrap();
    let mut spec = spec(dir.path());
    spec.steps.last_mut().unwrap().retain(|arg| arg != "segments.ffconcat");
    let started = Arc::new(AtomicBool::new(false));
    let guard_started = started.clone();
    let guard: StartGuard = Arc::new(move || { guard_started.store(true, Ordering::Release); Ok(()) });
    assert!(spawn(Path::new("absent-worker"), &spec, Arc::new(|_| {}), guard, Arc::default(), super::super::Workspace::new(20_000_000_000)).is_err());
    assert!(!started.load(Ordering::Acquire));
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
  }

  #[test]
  #[ignore = "requires the real bundled ffmpeg"]
  fn streamed_frames_and_stereo_samples_match_file_transport() {
    let dir = tempfile::tempdir().unwrap();
    let spec = spec(dir.path());
    let checks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let guarded = checks.clone();
    for _attempt in 0..5 {
      let guarded = guarded.clone();
      let (code, errors) = run(&spec, Arc::new(move || { guarded.fetch_add(1, Ordering::Relaxed); Ok(()) }));
      assert_eq!(code, 0, "{errors}");
      for (stream, format, expected) in [("0:v:0", "rawvideo", 5_184_000), ("0:a:0", "f64le", 1_536_000)] {
        let output = Command::new(ffmpeg()).args(["-nostdin", "-v", "error", "-i", "delivered.nut", "-map", stream, "-f", format, "pipe:1"])
          .current_dir(dir.path()).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(output.stdout.len(), expected, "streamed artifact {stream} attempt {_attempt}");
      }
    }
    assert_eq!(checks.load(Ordering::Relaxed), 15);
    assert!(!dir.path().join("part0.nut").exists());
    assert!(!dir.path().join("part1.nut").exists());
    std::fs::rename(dir.path().join("delivered.nut"), dir.path().join("streamed.nut")).unwrap();
    for args in std::iter::once(&spec.args).chain(spec.steps.iter().take(1)) {
      let output = Command::new(ffmpeg()).args(args).current_dir(dir.path()).output().unwrap();
      assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }
    std::fs::write(dir.path().join("segments.ffconcat"), "ffconcat version 1.0\nfile 'part0.nut'\nduration 1\nfile 'part1.nut'\nduration 1\n").unwrap();
    assert!(Command::new(ffmpeg()).args(spec.steps.last().unwrap()).current_dir(dir.path()).status().unwrap().success());
    for (stream, format, expected) in [("0:v:0", "rawvideo", 5_184_000), ("0:a:0", "f64le", 1_536_000)] {
      let decode = |name: &str| {
        let output = Command::new(ffmpeg()).args(["-nostdin", "-v", "error", "-i", name, "-map", stream, "-f", format, "pipe:1"])
          .current_dir(dir.path()).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(output.stdout.len(), expected, "{name} {stream}");
        output.stdout
      };
      assert_eq!(decode("streamed.nut"), decode("delivered.nut"), "{stream} decoded bytes differ");
    }
  }

  #[test]
  #[ignore = "requires the real bundled ffmpeg"]
  fn rejects_a_later_guard_failure_without_running_that_producer() {
    let dir = tempfile::tempdir().unwrap();
    let spec = spec(dir.path());
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let saved = calls.clone();
    let (code, errors) = run(&spec, Arc::new(move || {
      if saved.fetch_add(1, Ordering::Relaxed) == 2 { Err("request superseded".into()) } else { Ok(()) }
    }));
    assert_ne!(code, 0);
    assert!(errors.contains("request superseded"), "{errors}");
    assert_eq!(calls.load(Ordering::Relaxed), 3);
    assert!(!dir.path().join("part1.nut").exists());
  }

  #[test]
  #[ignore = "requires the real bundled ffmpeg"]
  fn producer_failure_is_not_hidden_by_a_successful_partial_consumer() {
    let dir = tempfile::tempdir().unwrap();
    let mut spec = spec(dir.path());
    let input = spec.steps[0].iter().position(|arg| arg == "-i").unwrap();
    spec.steps[0][input + 1] = "nonexistent_stream_source".into();
    let (code, errors) = run(&spec, Arc::new(|| Ok(())));
    assert_ne!(code, 0);
    assert!(errors.contains("producer 2 failed"), "{errors}");
    assert!(errors.contains("nonexistent_stream_source"), "{errors}");
    assert!(!dir.path().join("part0.nut").exists());
    assert!(!dir.path().join("part1.nut").exists());
  }

  #[test]
  #[ignore = "requires the real bundled ffmpeg"]
  fn consumer_failure_stops_the_producers_and_settles() {
    let dir = tempfile::tempdir().unwrap();
    let mut spec = spec(dir.path());
    let final_args = spec.steps.last_mut().unwrap();
    let encoder = final_args.iter().position(|arg| arg == "-c:v").unwrap();
    final_args[encoder + 1] = "nonexistent_stream_encoder".into();
    let (code, errors) = run(&spec, Arc::new(|| Ok(())));
    assert_ne!(code, 0);
    assert!(errors.contains("nonexistent_stream_encoder"), "{errors}");
    assert!(errors.contains("native streaming render failed"), "{errors}");
  }

  #[test]
  #[ignore = "requires the real bundled ffmpeg"]
  fn cancellation_reaps_every_worker_before_reporting_exit() {
    let dir = tempfile::tempdir().unwrap();
    let mut spec = spec(dir.path());
    spec.args.splice(0..0, strings(&["-re", "-progress", "pipe:1"]));
    let input = spec.args.iter().position(|arg| arg == "testsrc2=s=320x180:r=30:d=1").unwrap();
    spec.args[input] = "testsrc2=s=320x180:r=30:d=60".into();
    let (armed, progress) = mpsc::channel();
    let (ended, completion) = mpsc::channel();
    let observer: Observer = Arc::new(move |event| match event {
      ProcEvent::Stdout(text) if text.contains("frame=") => { let _ = armed.send(()); },
      ProcEvent::Exit(code) => { ended.send(code).unwrap(); },
      _ => {},
    });
    let registry: Registry = Arc::default();
    let pid = spawn(&ffmpeg(), &spec, observer, Arc::new(|| Ok(())), registry.clone(), super::super::Workspace::new(20_000_000_000)).unwrap();
    let control = registry.lock().unwrap().get(&(spec.id.clone(), pid)).unwrap().clone();
    progress.recv_timeout(Duration::from_secs(10)).expect("producer never made real progress");
    assert!(!cancel(&registry, "unrelated-job", pid));
    assert!(!control.state.lock().unwrap().cancelled);
    assert!(cancel(&registry, &spec.id, pid));
    assert_ne!(completion.recv_timeout(Duration::from_secs(10)).expect("cancelled workers did not settle"), Some(0));
    assert!(control.state.lock().unwrap().children.is_empty());
    assert!(registry.lock().unwrap().is_empty());
    assert!(!cancel(&registry, &spec.id, pid));
    assert!(!dir.path().join("part0.nut").exists());
    assert!(!dir.path().join("part1.nut").exists());
  }

  struct NativeStreamSpawner { registry: Registry, legacy_starts: Arc<std::sync::atomic::AtomicUsize> }

  impl Spawner for NativeStreamSpawner {
    fn identity(&self, _: &str) -> Result<ArtifactIdentity, String> { super::super::artifact_identity(&ffmpeg()) }
    fn spawn(&self, _: &JobSpec, _: Observer, _: Arc<super::super::Workspace>) -> Result<u32, String> {
      self.legacy_starts.fetch_add(1, Ordering::Relaxed);
      Err("streaming export must not replay through the retained-file transport".into())
    }
    fn spawn_stream(&self, spec: &JobSpec, observer: Observer, guard: StartGuard, workspace: Arc<super::super::Workspace>) -> Result<u32, String> {
      spawn(&ffmpeg(), spec, observer, guard, self.registry.clone(), workspace)
    }
    fn kill(&self, id: &str, pid: u32) { let _ = cancel(&self.registry, id, pid); }
  }

  #[test]
  #[ignore = "requires the real bundled ffmpeg"]
  fn supervisor_recovery_owns_stream_completion_and_publication() {
    let dir = tempfile::tempdir().unwrap();
    let journal = dir.path().join("journal");
    let work = dir.path().join("work");
    let legacy_starts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let worker = Arc::new(NativeStreamSpawner { registry: Arc::default(), legacy_starts: legacy_starts.clone() });
    let original = Supervisor::new(worker.clone(), Arc::new(|_| {})).with_export_work_root(work.clone()).with_export_root(journal.clone()).unwrap();
    let mut spec = spec(&work);
    spec.meta = serde_json::json!({ "kind": "export", "renderTransport": "partition-pipes-v1" });
    let stage = dir.path().join("delivered.partial");
    *spec.steps.last_mut().unwrap().last_mut().unwrap() = stage.to_string_lossy().into_owned();
    let destination = dir.path().join("delivered.nut");
    std::fs::write(&destination, b"old destination").unwrap();
    original.prepare_delivery(spec.id.clone(), "isolated-project".into(), stage.to_string_lossy().into(),
      destination.to_string_lossy().into(), DeliverySource::Render { paths: Vec::new() }).unwrap();
    let scratch = std::path::PathBuf::from(original.stage_render_scratch(&spec.id, vec![super::super::RenderScratchFile {
      name: "segments.ffconcat".into(), content: "ffconcat version 1.0\nfile 'part0.nut'\nduration 1\nfile 'part1.nut'\nduration 1\n".into(),
    }], vec![]).unwrap());
    spec.cwd = Some(scratch.to_string_lossy().into());
    original.retain_render_job(&spec).unwrap();
    drop(original);
    let (sender, receiver) = mpsc::channel();
    let recovered = Supervisor::new(worker, Arc::new(move |notice| {
      if let Notice::Changed(job) = notice { if job.state == JobState::Exited { sender.send(job).unwrap(); } }
    })).with_export_work_root(work).with_export_root(journal).unwrap();
    assert!(recovered.recover_exports().is_empty());
    let job = receiver.recv_timeout(Duration::from_secs(30)).expect("recovered stream did not settle");
    assert_eq!(job.code, Some(0), "{}{}", job.stderr_head, job.stderr_tail);
    assert!(!job.killed);
    assert_eq!(legacy_starts.load(Ordering::Relaxed), 0);
    let delivery = recovered.delivery_list().pop().unwrap();
    assert!(delivery.producer_complete);
    assert_eq!(delivery.recovery_attempts, 1);
    assert_eq!(delivery.render_job.unwrap().steps.len(), 2);
    assert!(!scratch.join("part0.nut").exists());
    assert!(!scratch.join("part1.nut").exists());
    assert_eq!(std::fs::read(&destination).unwrap(), b"old destination");
    recovered.verify_delivery(&spec.id).unwrap();
    let published = recovered.publish_delivery(&spec.id).unwrap();
    assert_eq!(published.identity.unwrap().sha256, super::super::artifact_identity(&destination).unwrap().sha256);
    let decoded = Command::new(ffmpeg()).args(["-v", "error", "-i"]).arg(&destination)
      .args(["-map", "0:v:0", "-f", "rawvideo", "pipe:1"]).output().unwrap();
    assert!(decoded.status.success());
    assert_eq!(decoded.stdout.len(), 5_184_000);
  }

  #[test]
  #[ignore = "requires the real bundled ffmpeg"]
  fn supervisor_rechecks_the_retained_identity_after_the_first_producer() {
    let dir = tempfile::tempdir().unwrap();
    let manifest = Arc::new(Mutex::new(None::<std::path::PathBuf>));
    let changed_manifest = manifest.clone();
    let legacy_starts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let worker = Arc::new(NativeStreamSpawner { registry: Arc::default(), legacy_starts: legacy_starts.clone() });
    let changed = Arc::new(AtomicBool::new(false));
    let changed_once = changed.clone();
    let (sender, receiver) = mpsc::channel();
    let owner = Supervisor::new(worker, Arc::new(move |notice| match notice {
      Notice::Stdout { chunk, .. } if chunk.contains("frame=") && !changed_once.swap(true, Ordering::AcqRel) => {
        std::fs::write(changed_manifest.lock().unwrap().as_ref().unwrap(), "changed after producer admission").unwrap();
      },
      Notice::Changed(job) if job.state == JobState::Exited => { sender.send(job).unwrap(); },
      _ => {},
    })).with_export_work_root(dir.path().join("work")).with_export_root(dir.path().join("journal")).unwrap();
    let mut spec = spec(dir.path());
    spec.args.splice(0..0, strings(&["-progress", "pipe:1"]));
    spec.meta = serde_json::json!({ "kind": "export", "renderTransport": "partition-pipes-v1" });
    let stage = dir.path().join("delivered.partial");
    let destination = dir.path().join("delivered.nut");
    *spec.steps.last_mut().unwrap().last_mut().unwrap() = stage.to_string_lossy().into_owned();
    std::fs::write(&destination, b"prior output").unwrap();
    owner.prepare_delivery(spec.id.clone(), "isolated-project".into(), stage.to_string_lossy().into(), destination.to_string_lossy().into(),
      DeliverySource::Render { paths: Vec::new() }).unwrap();
    let scratch = std::path::PathBuf::from(owner.stage_render_scratch(&spec.id, vec![super::super::RenderScratchFile {
      name: "segments.ffconcat".into(), content: "ffconcat version 1.0\nfile 'part0.nut'\nduration 1\nfile 'part1.nut'\nduration 1\n".into(),
    }], vec![]).unwrap());
    *manifest.lock().unwrap() = Some(scratch.join("segments.ffconcat"));
    spec.cwd = Some(scratch.to_string_lossy().into());
    owner.submit(spec).unwrap();
    let job = receiver.recv_timeout(Duration::from_secs(30)).expect("changed stream did not settle");
    assert!(changed.load(Ordering::Acquire));
    assert_ne!(job.code, Some(0));
    assert!(format!("{}{}", job.stderr_head, job.stderr_tail).contains("staged input changed"));
    assert!(!owner.delivery_list()[0].producer_complete);
    assert_eq!(std::fs::read(destination).unwrap(), b"prior output");
    assert_eq!(legacy_starts.load(Ordering::Relaxed), 0);
  }
}