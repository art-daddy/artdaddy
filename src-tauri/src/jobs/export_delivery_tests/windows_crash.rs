use super::*;
use std::io::{BufRead, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{GetLastError, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, ERROR_SHARING_VIOLATION,
  FILETIME, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW,
  PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, TerminateProcess, WaitForSingleObject,
  PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE};

const HOST_ROOT: &str = "ARTDADDY_TEST_WINDOWS_SUPERVISOR_ROOT";
const HOST_ROLE: &str = "ARTDADDY_TEST_WINDOWS_SUPERVISOR_ROLE";
const BUDGET: u64 = 32 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(30);
const PREVIOUS: &[u8] = b"previous complete destination";

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
enum FailureOrder { OwnerFirst, CancelLiveFirst, CancelSettledFirst }

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
struct Case { streamed: bool, replayed: bool, order: FailureOrder }

fn cases() -> Vec<Case> {
  [false, true].into_iter().flat_map(|streamed| [false, true].into_iter().flat_map(move |replayed|
    [FailureOrder::OwnerFirst, FailureOrder::CancelLiveFirst, FailureOrder::CancelSettledFirst]
      .map(move |order| Case { streamed, replayed, order }))).collect()
}

fn ffmpeg() -> PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join("artdaddy-ffmpeg-x86_64-pc-windows-msvc.exe")
}

fn receipt(root: &Path) -> String { std::fs::read_to_string(root.join("journal").join("owned.json")).unwrap() }

fn write_json(path: &Path, value: &impl serde::Serialize) {
  let pending = path.with_extension("pending");
  std::fs::write(&pending, serde_json::to_vec(value).unwrap()).unwrap();
  std::fs::rename(pending, path).unwrap();
}

fn snapshot(path: &Path) -> Option<serde_json::Value> {
  match std::fs::read(path) {
    Ok(bytes) => Some(serde_json::json!({ "bytes": bytes.len(), "sha256": format!("{:x}", Sha256::digest(&bytes)) })),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
    Err(error) => panic!("could not read native test artifact {}: {error}", path.display()),
  }
}

fn supervisor(root: &Path) -> Supervisor {
  let mut jobs = Supervisor::new(Arc::new(NativeDeliverySpawner(ffmpeg(), Arc::default())), Arc::new(|_| {}));
  jobs.workspace = Workspace::new(BUDGET);
  jobs.with_export_work_root(root.join("work")).unwrap().with_export_root(root.join("journal")).unwrap()
}

fn wait_for<T>(label: &str, mut observe: impl FnMut() -> Option<T>) -> T {
  let started = Instant::now();
  loop {
    if let Some(value) = observe() { return value; }
    assert!(started.elapsed() < DEADLINE, "timed out waiting for {label}");
    std::thread::sleep(Duration::from_millis(5));
  }
}

fn live_stage(jobs: &Supervisor, stage: &Path) -> u32 {
  wait_for("real native stage bytes with a running producer", || {
    let state = jobs.lock();
    let job = &state.jobs["owned"];
    assert_ne!(job.state, JobState::Exited, "{}{}", job.stderr_head, job.stderr);
    let length = match stage.metadata() {
      Ok(metadata) => metadata.len(),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
      Err(error) => panic!("could not observe native pending output: {error}"),
    };
    assert!(length <= BUDGET);
    if length > 0 && job.state == JobState::Running { job.pid } else { None }
  })
}

fn wait_exited(jobs: &Supervisor) -> JobView {
  wait_for("native producer settlement", || jobs.list().into_iter()
    .find(|job| job.id == "owned" && job.state == JobState::Exited))
}

fn input_line(expected: &str) {
  let mut line = String::new();
  assert!(std::io::stdin().lock().read_line(&mut line).unwrap() > 0, "native test owner lost its driver");
  assert_eq!(line.trim_end(), expected);
}

fn retained_bytes(delivery: &ExportDelivery) -> u64 {
  let staged = snapshot(Path::new(&delivery.stage_path)).map(|value| value["bytes"].as_u64().unwrap()).unwrap_or(0);
  staged + delivery.render_scratch.as_ref().filter(|scratch| Path::new(&scratch.path).exists())
    .map(|scratch| scratch_usage(Path::new(&scratch.path), Path::new("")).unwrap().0).unwrap_or(0)
}

fn host_start(root: &Path, case: Case, source: &Path) {
  let mut jobs = supervisor(root);
  let delivery = jobs.prepare_delivery("owned".into(), "synthetic-project".into(),
    root.join("stage.partial").to_string_lossy().into(), root.join("destination.mp4").to_string_lossy().into(),
    DeliverySource::Render { paths: vec![source.to_string_lossy().into()] }).unwrap();
  let mut spec = final_mp4_spec(&jobs, &delivery, source, case.streamed);
  let final_args = if case.streamed { spec.steps.last_mut().unwrap() } else { &mut spec.args };
  let output = final_args.len() - 1;
  final_args.splice(output..output, ["-movflags".into(), "+faststart".into()]);
  let pace = |args: &mut Vec<String>| { args.splice(0..0, ["-readrate".into(), "0.125".into()]); };
  pace(&mut spec.args);
  if case.streamed {
    pace(&mut spec.steps[0]);
    let mut audio: Vec<String> = serde_json::from_value(spec.meta["renderAudio"]["args"].clone()).unwrap();
    pace(&mut audio);
    spec.meta["renderAudio"]["args"] = serde_json::json!(audio);
  }
  if case.replayed {
    jobs.retain_render_job(&spec).unwrap();
    drop(jobs);
    jobs = supervisor(root);
    assert!(jobs.recover_exports().is_empty());
  } else { jobs.submit(spec).unwrap(); }
  let pid = live_stage(&jobs, Path::new(&delivery.stage_path));
  let delivery = jobs.delivery_list().pop().unwrap();
  assert_eq!(delivery.recovery_attempts, if case.replayed { 1 } else { 0 });
  write_json(&root.join("ready.json"), &serde_json::json!({ "pid": pid, "delivery": delivery,
    "receipt": receipt(root), "stage": snapshot(Path::new(&delivery.stage_path)) }));
  if case.order != FailureOrder::OwnerFirst {
    input_line("cancel");
    assert!(jobs.cancel_delivery("owned").unwrap());
    if case.order == FailureOrder::CancelSettledFirst {
      assert!(jobs.kill("owned"));
      assert_ne!(wait_exited(&jobs).code, Some(0));
      assert!(!Path::new(&delivery.stage_path).exists());
    } else {
      assert_eq!(jobs.list().into_iter().find(|job| job.id == "owned").unwrap().state, JobState::Running);
    }
    write_json(&root.join("cancelled.json"), &serde_json::json!({ "receipt": receipt(root),
      "worker_still_running": case.order == FailureOrder::CancelLiveFirst,
      "stage": snapshot(Path::new(&delivery.stage_path)) }));
  }
  input_line("owner must be terminated, not shut down cooperatively");
  panic!("native test owner was not terminated");
}

fn host_recover(root: &Path, case: Case, source: &Path) {
  let jobs = supervisor(root);
  let before = jobs.delivery_list().pop().unwrap();
  let available = jobs.workspace.available_bytes();
  let retained = retained_bytes(&before);
  assert!(available.checked_add(retained).unwrap() <= BUDGET, "restart made retained output or scratch free");
  assert!(!before.producer_complete);
  assert!(jobs.verify_delivery("owned").is_err());
  assert!(jobs.publish_delivery("owned").is_err());
  assert_eq!(std::fs::read(&before.dest_path).unwrap(), PREVIOUS);
  write_json(&root.join("adopted.json"), &serde_json::json!({ "receipt": receipt(root),
    "available": available, "retained_bytes": retained }));
  input_line("recover");
  let failures = jobs.recover_exports();
  let mut decoded = None;
  let mut exhausted = None;
  if case.order != FailureOrder::OwnerFirst {
    assert!(failures.is_empty(), "{failures:?}");
    let completed = jobs.delivery_list().pop().unwrap();
    assert_eq!(completed.state, "cancelled");
    assert!(completed.followups_done);
    assert!(jobs.list().is_empty(), "restart dispatched a worker for a cancelled intent");
  } else if case.replayed {
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].0, "owned");
    assert!(failures[0].1.contains("automatic recovery attempt budget exhausted"));
    assert_eq!(jobs.delivery_list()[0].recovery_attempts, 1);
    assert!(!jobs.delivery_list()[0].producer_complete);
    exhausted = Some(receipt(root));
    assert!(jobs.verify_delivery("owned").is_err());
    assert!(jobs.publish_delivery("owned").is_err());
    assert!(jobs.cancel_delivery("owned").unwrap());
    assert!(jobs.complete_delivery("owned").unwrap());
  } else {
    assert!(failures.is_empty(), "{failures:?}");
    let pid = live_stage(&jobs, Path::new(&before.stage_path));
    write_json(&root.join("recovery-live.json"), &serde_json::json!({ "pid": pid }));
    input_line("continue");
    let ended = wait_exited(&jobs);
    assert_eq!(ended.code, Some(0), "{}{}", ended.stderr_head, ended.stderr_tail);
    assert_eq!(jobs.delivery_list()[0].recovery_attempts, 1);
    assert_eq!(std::fs::read(&before.dest_path).unwrap(), PREVIOUS);
    jobs.verify_delivery("owned").unwrap();
    jobs.publish_delivery("owned").unwrap();
    let decode = |path: &Path, audio: bool| {
      let mut command = Command::new(ffmpeg());
      command.args(["-v", "error", "-i"]).arg(path);
      if audio { command.args(["-map", "0:a:0", "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_f64le", "-f", "f64le", "pipe:1"]); }
      else { command.args(["-map", "0:v:0", "-an", "-f", "framemd5", "pipe:1"]); }
      let output = command.output().unwrap();
      assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
      output.stdout
    };
    let mut results = Vec::new();
    for audio in [false, true] {
      let original = decode(source, audio);
      let published = decode(Path::new(&before.dest_path), audio);
      assert_eq!(published, original);
      if audio { assert_eq!(published.len(), 96_000 * 2 * 8); }
      else { assert_eq!(String::from_utf8(published.clone()).unwrap().lines().filter(|line| !line.starts_with('#')).count(), 60); }
      results.push(serde_json::json!({ "audio": audio, "bytes": published.len(),
        "sha256": format!("{:x}", Sha256::digest(&published)) }));
    }
    decoded = Some(results);
    assert!(jobs.complete_delivery("owned").unwrap());
  }
  let after = jobs.delivery_list().pop().unwrap();
  assert!(after.followups_done);
  assert!(!Path::new(&after.stage_path).exists());
  if let Some(scratch) = &after.render_scratch { assert!(!Path::new(&scratch.path).exists()); }
  assert_eq!(jobs.workspace.available_bytes(), BUDGET);
  if case.order != FailureOrder::OwnerFirst || case.replayed {
    assert_eq!(std::fs::read(&after.dest_path).unwrap(), PREVIOUS);
  }
  write_json(&root.join("recovered.json"), &serde_json::json!({ "receipt": receipt(root),
    "available": jobs.workspace.available_bytes(), "decoded": decoded, "exhausted_receipt": exhausted,
    "destination": snapshot(Path::new(&after.dest_path)) }));
}

fn creation_time(process: &impl AsRawHandle) -> Result<u64, String> {
  let (mut created, mut exited, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
  if unsafe { GetProcessTimes(process.as_raw_handle(), &mut created, &mut exited, &mut kernel, &mut user) } == 0 {
    return Err(format!("could not identify owned native test process: {}", std::io::Error::last_os_error()));
  }
  Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

struct PinnedProcess { pid: u32, created: u64, process: OwnedHandle, terminate: Option<OwnedHandle> }

impl PinnedProcess {
  fn capture(pid: u32, process: OwnedHandle) -> Result<Self, String> {
    let created = creation_time(&process)?;
    if unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } == WAIT_OBJECT_0 {
      return Ok(Self { pid, created, process, terminate: None });
    }
    let raw = unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | 0x0010_0000, 0, pid) };
    let terminate = if raw.is_null() {
      let error = std::io::Error::last_os_error();
      if error.raw_os_error() != Some(ERROR_INVALID_PARAMETER as i32) ||
        unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } != WAIT_OBJECT_0 {
        return Err(format!("could not pin owned native test process {pid}: {error}"));
      }
      None
    } else {
      let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
      if creation_time(&handle)? != created { return Err("owned native test process identity changed".into()); }
      Some(handle)
    };
    Ok(Self { pid, created, process, terminate })
  }

  fn running(&self) -> bool {
    match unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) } {
      WAIT_TIMEOUT => true,
      WAIT_OBJECT_0 => false,
      result => panic!("owned native test process {} could not be observed: {result}", self.pid),
    }
  }

  fn settled(&self) {
    assert_eq!(unsafe { WaitForSingleObject(self.process.as_raw_handle(), 5000) }, WAIT_OBJECT_0,
      "owned native test process {} survived its owner", self.pid);
  }
}

struct OwnedHost { child: Child, created: u64, processes: Vec<PinnedProcess>, root: PathBuf, role: &'static str }

impl OwnedHost {
  fn launch(root: &Path, role: &'static str, test: &str) -> Self {
    let child = Command::new(std::env::current_exe().unwrap()).args(["--exact", test, "--nocapture", "--test-threads=1"])
      .env(HOST_ROOT, root).env(HOST_ROLE, role).stdin(Stdio::piped())
      .stdout(std::fs::File::create(root.join(format!("{role}.stdout"))).unwrap())
      .stderr(std::fs::File::create(root.join(format!("{role}.stderr"))).unwrap()).spawn().unwrap();
    let created = creation_time(&child).unwrap();
    Self { child, created, processes: Vec::new(), root: root.to_path_buf(), role }
  }

  fn capture(&mut self) -> Result<(), String> {
    let tree = crate::windows_process_tree(self.child.id())?;
    if let Some((_, process)) = tree.iter().find(|(pid, _)| *pid == self.child.id()) {
      if creation_time(process)? != self.created { return Err("native test owner PID was reused".into()); }
    } else if self.child.try_wait().map_err(|error| error.to_string())?.is_none() {
      return Err("running native test owner is missing from its pinned tree".into());
    }
    for (pid, process) in tree {
      let process = PinnedProcess::capture(pid, process)?;
      if !self.processes.iter().any(|old| old.pid == process.pid && old.created == process.created) {
        self.processes.push(process);
      }
    }
    Ok(())
  }

  fn capture_late_children(&mut self) -> Result<(), String> {
    if self.child.try_wait().map_err(|error| error.to_string())?.is_none() {
      return Err("late native child observation requires the pinned owner to have exited".into());
    }
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if raw == INVALID_HANDLE_VALUE { return Err(format!("late native child snapshot failed: {}", std::io::Error::last_os_error())); }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>().try_into().map_err(|_| "native process snapshot size overflow")?;
    let mut found = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) };
    loop {
      if found == 0 {
        let error = unsafe { GetLastError() };
        if error == ERROR_NO_MORE_FILES { break; }
        return Err(format!("late native child enumeration failed: Windows error {error}"));
      }
      if entry.th32ParentProcessID == self.child.id() {
        if let Some((process, created)) = crate::observe_windows_process(entry.th32ProcessID)? {
          if created >= self.created &&
            !self.processes.iter().any(|old| old.pid == entry.th32ProcessID && old.created == created) {
            self.processes.push(PinnedProcess::capture(entry.th32ProcessID, process)?);
          }
        }
      }
      found = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) };
    }
    Ok(())
  }

  fn artifact(&mut self, name: &str) -> serde_json::Value {
    wait_for(name, || {
      match std::fs::read(self.root.join(name)) {
        Ok(bytes) => Some(serde_json::from_slice(&bytes).unwrap()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
          if let Some(status) = self.child.try_wait().unwrap() {
            panic!("native {} owner ended before {name}: {status}\n{}\n{}", self.role,
              std::fs::read_to_string(self.root.join(format!("{}.stdout", self.role))).unwrap(),
              std::fs::read_to_string(self.root.join(format!("{}.stderr", self.role))).unwrap());
          }
          None
        }
        Err(error) => panic!("native owner evidence could not be read: {error}"),
      }
    })
  }

  fn command(&mut self, value: &str) { writeln!(self.child.stdin.as_mut().unwrap(), "{value}").unwrap(); }

  fn require_live(&self, pid: u32) {
    assert!(self.processes.iter().any(|process| process.pid == pid && process.running()), "native producer was not pinned alive");
  }

  fn terminate(&mut self) {
    self.capture().unwrap();
    assert!(self.child.try_wait().unwrap().is_none());
    self.child.kill().unwrap();
    assert!(!self.child.wait().unwrap().success());
    self.capture_late_children().unwrap();
    for process in &self.processes { process.settled(); }
  }

  fn normal_exit(&mut self) {
    let status = wait_for("recovery owner exit", || self.child.try_wait().unwrap());
    assert!(status.success(), "native recovery owner failed: {}\n{}",
      std::fs::read_to_string(self.root.join("recover.stdout")).unwrap(),
      std::fs::read_to_string(self.root.join("recover.stderr")).unwrap());
    self.capture_late_children().unwrap();
    for process in &self.processes { process.settled(); }
  }

  fn identities(&self) -> Vec<serde_json::Value> {
    self.processes.iter().map(|process| serde_json::json!({ "pid": process.pid, "created": process.created.to_string() })).collect()
  }
}

impl Drop for OwnedHost {
  fn drop(&mut self) {
    if let Err(error) = self.capture() { eprintln!("native test process cleanup snapshot failed: {error}"); }
    match self.child.try_wait() {
      Ok(None) => {
        if let Err(error) = self.child.kill() { eprintln!("native test owner cleanup termination failed: {error}"); }
        if let Err(error) = self.child.wait() { eprintln!("native test owner cleanup wait failed: {error}"); }
      }
      Ok(Some(_)) => {}
      Err(error) => eprintln!("native test owner cleanup observation failed: {error}"),
    }
    if let Err(error) = self.capture_late_children() { eprintln!("late native child cleanup snapshot failed: {error}"); }
    for process in &self.processes {
      match unsafe { WaitForSingleObject(process.process.as_raw_handle(), 0) } {
        WAIT_OBJECT_0 => {}
        WAIT_TIMEOUT => {
          if let Some(handle) = &process.terminate {
            if unsafe { TerminateProcess(handle.as_raw_handle(), 1) } == 0 {
              eprintln!("native test process {} cleanup termination failed: {}", process.pid, std::io::Error::last_os_error());
            }
          }
          if unsafe { WaitForSingleObject(process.process.as_raw_handle(), 5000) } != WAIT_OBJECT_0 {
            eprintln!("native test process {} did not settle after cleanup", process.pid);
          }
        }
        result => eprintln!("native test process {} cleanup observation failed: {result}", process.pid),
      }
    }
  }
}

struct EvidenceDirectory(Option<tempfile::TempDir>);
impl Drop for EvidenceDirectory {
  fn drop(&mut self) {
    let directory = self.0.take().unwrap();
    if std::thread::panicking() { eprintln!("native supervisor failure evidence retained at {}", directory.keep().display()); }
    else { directory.close().expect("native supervisor evidence cleanup failed"); }
  }
}

#[test]
fn real_supervisor_owner_death_preserves_caps_destinations_and_recovery() {
  if let Some(root) = std::env::var_os(HOST_ROOT) {
    let root = PathBuf::from(root);
    let config: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("case.json")).unwrap()).unwrap();
    let case: Case = serde_json::from_value(config["case"].clone()).unwrap();
    let source = Path::new(config["source"].as_str().unwrap());
    match std::env::var(HOST_ROLE).unwrap().as_str() {
      "start" => host_start(&root, case, source),
      "recover" => host_recover(&root, case, source),
      role => panic!("unknown native supervisor test role: {role}"),
    }
    return;
  }
  let directory = EvidenceDirectory(Some(tempfile::Builder::new().prefix("artdaddy-windows-supervisor-").tempdir().unwrap()));
  let root = directory.0.as_ref().unwrap().path();
  let binary = ffmpeg();
  let source = final_mp4_source(&binary, root);
  let original = artifact_identity(&source).unwrap();
  let thread = std::thread::current();
  let test = thread.name().expect("native supervisor fixture needs its actual test identity").to_owned();
  let schema = cases();
  let mut records = Vec::new();
  for (index, case) in schema.iter().copied().enumerate() {
    let case_root = root.join(format!("case-{index}"));
    std::fs::create_dir(&case_root).unwrap();
    std::fs::write(case_root.join("destination.mp4"), PREVIOUS).unwrap();
    write_json(&case_root.join("case.json"), &serde_json::json!({ "case": case, "source": source }));
    let writable = case_root.join("positive.bin");
    std::fs::write(&writable, b"before").unwrap();
    let probe = |path: &Path| { std::fs::OpenOptions::new().write(true).open(path)?.write_all(b"owned") };
    probe(&writable).unwrap();
    assert_eq!(std::fs::read(&writable).unwrap(), b"ownede");
    let mut host = OwnedHost::launch(&case_root, "start", &test);
    let ready = host.artifact("ready.json");
    host.capture().unwrap();
    host.require_live(u32::try_from(ready["pid"].as_u64().unwrap()).unwrap());
    let stage = Path::new(ready["delivery"]["stage_path"].as_str().unwrap());
    let refused = probe(stage).expect_err("a second writer changed the admitted live native stage");
    assert_eq!(refused.raw_os_error(), Some(ERROR_SHARING_VIOLATION as i32));
    let mut cancelled = None;
    if case.order != FailureOrder::OwnerFirst {
      host.command("cancel");
      cancelled = Some(host.artifact("cancelled.json"));
      if case.order == FailureOrder::CancelLiveFirst {
        host.require_live(u32::try_from(ready["pid"].as_u64().unwrap()).unwrap());
      }
    }
    host.terminate();
    let stopped = snapshot(stage);
    if case.order == FailureOrder::CancelSettledFirst { assert!(stopped.is_none()); }
    else { assert!(stopped.as_ref().unwrap()["bytes"].as_u64().unwrap() > 0); }
    assert!(stopped.as_ref().map(|value| value["bytes"].as_u64().unwrap() <= BUDGET).unwrap_or(true));
    assert_eq!(std::fs::read(case_root.join("destination.mp4")).unwrap(), PREVIOUS);
    let after_death_receipt = receipt(&case_root);
    let mut recovery = OwnedHost::launch(&case_root, "recover", &test);
    let adopted = recovery.artifact("adopted.json");
    recovery.capture().unwrap();
    assert_eq!(snapshot(stage), stopped);
    recovery.command("recover");
    if case.order == FailureOrder::OwnerFirst && !case.replayed {
      let live = recovery.artifact("recovery-live.json");
      recovery.capture().unwrap();
      recovery.require_live(u32::try_from(live["pid"].as_u64().unwrap()).unwrap());
      recovery.command("continue");
    }
    let recovered = recovery.artifact("recovered.json");
    recovery.normal_exit();
    assert_eq!(artifact_identity(&source).unwrap().sha256, original.sha256);
    records.push(serde_json::json!({ "case": case, "ready": ready, "positive_writer_bytes": "ownede",
      "live_stage_write_refused": true, "cancelled": cancelled, "stopped_stage": stopped,
      "after_death_receipt": after_death_receipt, "adopted": adopted, "recovered": recovered,
      "owned_processes": host.identities(), "recovery_processes": recovery.identities(),
      "all_owned_processes_settled": true, "source_sha256": original.sha256 }));
  }
  let budget_cases = exercise_final_mp4_budget(&binary);
  assert_eq!(budget_cases.len(), 8);
  assert_eq!(records.len(), schema.len());
  let proof = serde_json::json!({ "kind": "Actual Windows Supervisor recovery v1", "schema": schema, "records": records,
    "native_program": artifact_identity(&std::env::current_exe().unwrap()).unwrap(),
    "ffmpeg": artifact_identity(&binary).unwrap(), "source": original, "workspace_payload_limit": BUDGET,
    "budget_cases": budget_cases, "existing_eight_budget_cases_executed": true });
  let mut line = b"\nARTDADDY_WINDOWS_SUPERVISOR_PROOF=".to_vec();
  line.extend(serde_json::to_vec(&proof).unwrap());
  line.push(b'\n');
  // Direct stdout retains the actual ledger/artifact evidence in ordinary cargo-test CI logs.
  std::io::stdout().lock().write_all(&line).unwrap();
}
