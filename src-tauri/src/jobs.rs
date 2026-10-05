// The app's long jobs, owned by the app process instead of the page (3h part 7, UJ-022).
//
// The page builds an export's ffmpeg command and, once it has ended, commits the file it wrote:
// it checks it, renames it into place and updates the project. In between, the PROCESS and the
// ORDER exports run in belong here, so a crash of the page neither kills a render nor loses its
// result: the next page lists the jobs, commits the ones that ended while no page was there and
// follows the ones still running. Rust never writes project files. It runs the bundled ffmpeg,
// one job per lane at a time, keeps each job's exit code and the tail of its output until a page
// has committed it, and kills jobs on Cancel and when the app exits.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

/// The programs a job may run, as (logical name, bundled sidecar file). A command the page can
/// call must not become a way to start any process: only the sidecar the export path needs.
pub const SIDECARS: &[(&str, &str)] = &[("ffmpeg", "artdaddy-ffmpeg")];

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

#[derive(Clone, Debug, serde::Deserialize)]
pub struct JobSpec {
  pub id: String,
  pub lane: String,
  /// A logical name from `SIDECARS`.
  pub program: String,
  pub args: Vec<String>,
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
    }
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
    if !SIDECARS.iter().any(|(name, _)| *name == spec.program) {
      return Err(format!("'{}' cannot be run as a job", spec.program));
    }
    if spec.id.is_empty() || spec.lane.is_empty() {
      return Err("a job needs an id and a lane".into());
    }
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
    let me = self.clone();
    let id = spec.id.clone();
    let on_event: Arc<dyn Fn(ProcEvent) + Send + Sync> = Arc::new(move |ev| me.on_event(&id, ev));
    match self.spawner.spawn(&spec, on_event) {
      Ok(pid) => {
        let kill_now = {
          let mut st = self.lock();
          match st.jobs.get_mut(&spec.id) {
            Some(job) if job.state == JobState::Running => {
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
      Err(e) => self.finish(&spec.id, None, Some(format!("could not start {}: {e}", spec.program))),
    }
  }

  fn on_event(&self, id: &str, ev: ProcEvent) {
    match ev {
      ProcEvent::Stdout(chunk) => {
        if let Some(job) = self.lock().jobs.get_mut(id) {
          push_tail(&mut job.stdout, &chunk);
        }
        (self.notify)(Notice::Stdout { id: id.to_string(), chunk });
      }
      ProcEvent::Stderr(chunk) => {
        if let Some(job) = self.lock().jobs.get_mut(id) {
          push_stderr(job, &chunk);
        }
      }
      ProcEvent::Exit(code) => self.finish(id, code, None),
    }
  }

  fn finish(&self, id: &str, code: Option<i32>, error: Option<String>) {
    let (lane, view) = {
      let mut st = self.lock();
      let Some(job) = st.jobs.get_mut(id) else { return };
      if job.state == JobState::Exited {
        return;
      }
      job.state = JobState::Exited;
      job.code = code;
      job.ended_at = Some(now_ms());
      if let Some(e) = error {
        push_stderr(job, &e);
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
  fn spawn(
    &self,
    spec: &JobSpec,
    on_event: Arc<dyn Fn(ProcEvent) + Send + Sync>,
  ) -> Result<u32, String> {
    let file = sidecar_file(&spec.program)
      .ok_or_else(|| format!("'{}' is not a bundled program", spec.program))?;
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
    self.children.lock().unwrap_or_else(|e| e.into_inner()).insert(pid, child);
    let children = self.children.clone();
    tauri::async_runtime::spawn(async move {
      let mut ended = false;
      while let Some(ev) = rx.recv().await {
        match ev {
          CommandEvent::Stdout(b) => on_event(ProcEvent::Stdout(String::from_utf8_lossy(&b).into_owned())),
          CommandEvent::Stderr(b) => on_event(ProcEvent::Stderr(String::from_utf8_lossy(&b).into_owned())),
          CommandEvent::Error(e) => on_event(ProcEvent::Stderr(format!("{e}\n"))),
          CommandEvent::Terminated(p) => {
            ended = true;
            children.lock().unwrap_or_else(|e| e.into_inner()).remove(&pid);
            on_event(ProcEvent::Exit(p.code));
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
      app.manage(Supervisor::new(spawner, notify));
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
      lane: "export".into(),
      program: "ffmpeg".into(),
      args: vec!["-i".into(), "in.mp4".into()],
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
  fn only_the_bundled_ffmpeg_can_be_run() {
    let (s, fake) = sup();
    for program in ["cmd", "powershell", "/bin/sh", "artdaddy-ffmpeg", "ffprobe", ""] {
      assert!(s.submit(JobSpec { program: program.into(), ..spec(program) }).is_err(), "{program}");
    }
    assert!(fake.spawned_ids().is_empty());
    assert!(s.list().is_empty());
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
