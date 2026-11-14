// What an export's processes have used so far, printed on the job's output so the page can tell an export that is
// busy from one that has stopped (src/timeline/exportActivity.ts reads the line). One mark at once and then one every
// few seconds: `artdaddy_cpu=<processor ms>,<bytes read>`, both counted from the first process's start and never
// going down.
//
// It runs on a thread of its own, beside `Control::watch` and never inside it: `watch` is the memory guard, the PC
// floor and the execution deadline, and a reader that blocks or panics here must not be able to delay any of them.
// A reading that cannot be taken says nothing, and the page reads silence as "unknown": it never stops an export for
// being idle on silence.
use super::{Control, JobSpec, Observer, ProcEvent};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

/// How often a mark is printed. The page wants one at least every 20 s and keeps the last 48.
pub(super) const MARK_EVERY: Duration = Duration::from_secs(5);
/// The largest counter the page takes as real (2^53, `ACTIVITY_COUNTER_MAX`): a bigger one is brought down to it.
const COUNTER_MAX: u64 = 1 << 53;
/// Processor ticks in /proc are in USER_HZ, 100 a second on every Linux the app runs on.
const MS_PER_TICK: u64 = 10;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Used {
  /// Processor time, user plus kernel, in milliseconds.
  pub cpu_ms: u64,
  /// Bytes the processes have read.
  pub read_bytes: u64,
}

/// The line the page reads, newline included.
pub(super) fn mark_line(used: Used) -> String {
  format!("artdaddy_cpu={},{}\n", used.cpu_ms.min(COUNTER_MAX), used.read_bytes.min(COUNTER_MAX))
}

/// Whether this job prints marks: an export (the page reads them nowhere else) that the page has not switched off
/// (`activityMarks`, the `idle_rule` switch; silence means on).
pub(super) fn wanted(spec: &JobSpec) -> bool {
  spec.lane == super::super::EXPORT_LANE &&
    spec.meta.get("activityMarks").and_then(|value| value.as_bool()).unwrap_or(true)
}

/// Totals over workers that come and go. A worker that exits keeps what it had used at the last look in the total, so
/// the total never goes down; a counter that went down belongs to a new process under a reused id, which counts from
/// zero again.
#[derive(Default)]
pub(super) struct Tally {
  total: Used,
  seen: HashMap<u32, Used>,
}

fn rise(before: u64, now: u64) -> u64 { if now >= before { now - before } else { now } }

impl Tally {
  pub(super) fn fold(&mut self, live: &[(u32, Used)]) -> Used {
    for (id, now) in live {
      let before = self.seen.insert(*id, *now).unwrap_or_default();
      self.total.cpu_ms = self.total.cpu_ms.saturating_add(rise(before.cpu_ms, now.cpu_ms));
      self.total.read_bytes = self.total.read_bytes.saturating_add(rise(before.read_bytes, now.read_bytes));
    }
    let live: HashSet<u32> = live.iter().map(|(id, _)| *id).collect();
    self.seen.retain(|id, _| live.contains(id));
    self.total
  }
}

/// Processor time, in ms, from the text of `/proc/<pid>/stat`: the user and system ticks, fields 14 and 15, counted
/// after the command name, which may hold spaces and brackets of its own.
fn parse_stat(text: &str) -> Option<u64> {
  let after_name = &text[text.rfind(')')? + 1..];
  let mut fields = after_name.split_whitespace();
  let user: u64 = fields.nth(11)?.parse().ok()?;
  let system: u64 = fields.next()?.parse().ok()?;
  user.checked_add(system)?.checked_mul(MS_PER_TICK)
}

/// Bytes read, from the text of `/proc/<pid>/io`: `rchar`, every byte the process asked to read, the ones the page cache
/// served included (the Windows counter counts the same).
fn parse_io(text: &str) -> Option<u64> {
  text.lines().find_map(|line| line.strip_prefix("rchar:")).and_then(|rest| rest.trim().parse().ok())
}

/// One live worker's use. Only Linux has /proc; a Mac says nothing for now, and so does a worker whose files cannot be read.
fn worker_use(pid: u32) -> Option<Used> {
  if !cfg!(target_os = "linux") { return None; }
  let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
  let io = std::fs::read_to_string(format!("/proc/{pid}/io")).ok()?;
  Some(Used { cpu_ms: parse_stat(&stat)?, read_bytes: parse_io(&io)? })
}

/// Every live worker, looked at one by one. One that cannot be read spoils the look: half a total would read as idle.
fn per_worker(control: &Control, tally: &mut Tally) -> Option<Used> {
  let children = control.state.lock().unwrap_or_else(|error| error.into_inner())
    .children.values().map(|worker| worker.child.clone()).collect::<Vec<_>>();
  let mut live = Vec::with_capacity(children.len());
  for child in &children {
    if child.try_wait().ok()?.is_some() { continue; }
    let pid = child.id();
    live.push((pid, worker_use(pid)?));
  }
  Some(tally.fold(&live))
}

/// What the export's processes have used so far, or nothing when it cannot be read.
fn read_use(control: &Control, tally: &mut Tally) -> Option<Used> {
  match control.budget.accounting() {
    Ok((cpu_ms, read_bytes)) => Some(Used { cpu_ms, read_bytes }),
    // The job object counts the processes that have exited too; a failed query there is a failed look, not a reason to
    // count the workers by hand.
    Err(_) if cfg!(windows) => None,
    Err(_) => per_worker(control, tally),
  }
}

/// One look now, then one every `every`, until the export settles. `read` runs without the control's lock, and `say`
/// is not called under it either.
fn run(control: &Control, every: Duration, mut read: impl FnMut() -> Option<Used>, say: impl Fn(String)) {
  let mut state = control.state.lock().unwrap_or_else(|error| error.into_inner());
  while !state.settled {
    drop(state);
    if let Some(used) = read() { say(mark_line(used)); }
    state = control.state.lock().unwrap_or_else(|error| error.into_inner());
    if state.settled { return; }
    state = control.settled.wait_timeout_while(state, every, |state| !state.settled)
      .unwrap_or_else(|error| error.into_inner()).0;
  }
}

/// Start the sampler for an export whose memory watch has just been started. A thread that cannot be made prints no
/// marks, which is the same as no reading.
pub(super) fn start(control: &Arc<Control>, observer: Observer) -> Option<JoinHandle<()>> {
  let control = control.clone();
  std::thread::Builder::new().name("export-activity".into()).spawn(move || {
    let mut tally = Tally::default();
    run(&control, MARK_EVERY, || read_use(&control, &mut tally), |text| observer(ProcEvent::Stdout(text)));
  }).ok()
}

#[cfg(test)]
mod tests {
  use super::*;
  use super::super::{spawn_single, StartGuard, TrackedChild, WorkerRole};
  use std::io::{BufRead, BufReader, Read, Write};
  use std::path::Path;
  use std::process::{ChildStderr, ChildStdin, ChildStdout};
  use std::sync::atomic::{AtomicU64, Ordering};
  use std::sync::{mpsc, Mutex};
  use std::time::Instant;

  const CHILD: [&str; 4] = ["--exact", "jobs::stream::activity::tests::activity_child", "--ignored", "--nocapture"];

  fn deadline() -> u64 { super::super::super::now_ms() + 120_000 }

  /// Whether this platform can read a live export's use at all (a Mac says nothing for now).
  fn readable() -> bool { cfg!(any(windows, target_os = "linux")) }

  fn spin_for(duration: Duration) {
    let end = Instant::now() + duration;
    let mut x = 1u64;
    while Instant::now() < end {
      for _ in 0..10_000 { x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); }
      std::hint::black_box(x);
    }
  }

  // The worker the real-process tests start again and again: this test binary, named by the folder it runs in. In any
  // other folder it does nothing, so a plain run of the ignored tests is harmless.
  #[test]
  #[ignore = "worker child of the activity tests; started by them"]
  fn activity_child() {
    let dir = std::env::current_dir().unwrap();
    let name = dir.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let Some(role) = name.strip_prefix("artdaddy-activity-qa-").and_then(|rest| rest.split('-').next()).map(str::to_owned) else { return };
    println!("activity-child-ready");
    std::io::stdout().flush().unwrap();
    match role.as_str() {
      "spin" => spin_for(Duration::from_secs(30)),
      "burst" => spin_for(Duration::from_millis(1500)),
      "pause" => std::thread::sleep(Duration::from_millis(1200)),
      "sleep" => { let _ = std::io::stdin().read(&mut [0u8; 1]); }
      "read" => {
        let end = Instant::now() + Duration::from_secs(30);
        let mut buffer = vec![0u8; 1 << 20];
        while Instant::now() < end {
          let mut file = std::fs::File::open("data.bin").unwrap();
          while file.read(&mut buffer).unwrap() != 0 {}
        }
      }
      _ => {}
    }
  }

  fn directory(role: &str) -> tempfile::TempDir {
    tempfile::Builder::new().prefix(&format!("artdaddy-activity-qa-{role}-")).tempdir().unwrap()
  }

  /// A worker started the way the engines start one, through the control, so it is in the control's job.
  struct Worker {
    tracked: TrackedChild,
    _input: ChildStdin,
    _errors: ChildStderr,
    _output: BufReader<ChildStdout>,
  }

  fn worker(control: &Arc<Control>, dir: &Path, role: WorkerRole) -> Worker {
    let args = CHILD.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
    let guard: StartGuard = Arc::new(|| Ok(()));
    let tracked = control.spawn(&std::env::current_exe().unwrap(), &args, dir.to_str(), true, role, &guard).unwrap();
    let input = tracked.child().take_stdin().unwrap();
    let output = tracked.child().take_stdout().unwrap();
    let errors = tracked.child().take_stderr().unwrap();
    let mut output = BufReader::new(output);
    let mut line = String::new();
    loop {
      line.clear();
      assert_ne!(output.read_line(&mut line).unwrap(), 0, "the activity child exited before it was ready");
      if line.contains("activity-child-ready") { break; }
    }
    Worker { tracked, _input: input, _errors: errors, _output: output }
  }

  fn control() -> Arc<Control> { Arc::new(Control::new(deadline(), None).unwrap()) }

  fn sample(control: &Control, tally: &mut Tally) -> Used {
    read_use(control, tally).expect("a live export's use can be read on this platform")
  }

  fn rose(after: u64, before: u64) -> u64 { after.checked_sub(before).expect("a counter went down") }

  /// Takes a look every 50 ms until `done` says what was wanted has happened, for at most 30 s; the last look and whether it
  /// happened. A PC under load may give a worker a small share of a core, so a test waits for the work to be done and does
  /// not wait for a time to pass.
  fn wait_for(control: &Control, tally: &mut Tally, done: impl Fn(Used) -> bool) -> (Used, bool) {
    let end = Instant::now() + Duration::from_secs(30);
    loop {
      let used = sample(control, tally);
      if done(used) { return (used, true); }
      if Instant::now() >= end { return (used, false); }
      std::thread::sleep(Duration::from_millis(50));
    }
  }

  fn parse(line: &str) -> Option<(u64, u64)> {
    let (cpu, read) = line.strip_prefix("artdaddy_cpu=")?.strip_suffix('\n')?.split_once(',')?;
    Some((cpu.parse().ok()?, read.parse().ok()?))
  }

  fn xorshift(seed: &mut u64) -> u64 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    *seed
  }

  #[test]
  fn the_mark_is_one_line_of_two_whole_numbers_and_never_passes_what_the_page_takes_as_real() {
    assert_eq!(mark_line(Used { cpu_ms: 1500, read_bytes: 42 }), "artdaddy_cpu=1500,42\n");
    assert_eq!(mark_line(Used::default()), "artdaddy_cpu=0,0\n");
    assert_eq!(mark_line(Used { cpu_ms: u64::MAX, read_bytes: COUNTER_MAX + 1 }), "artdaddy_cpu=9007199254740992,9007199254740992\n");
    let mut seed = 0x2545_F491_4F6C_DD1Du64;
    for _ in 0..2000 {
      let used = Used { cpu_ms: xorshift(&mut seed) >> (xorshift(&mut seed) % 64), read_bytes: xorshift(&mut seed) >> (xorshift(&mut seed) % 64) };
      let line = mark_line(used);
      assert_eq!(parse(&line), Some((used.cpu_ms.min(COUNTER_MAX), used.read_bytes.min(COUNTER_MAX))), "{line:?}");
      assert_eq!(line.matches('\n').count(), 1, "one line: {line:?}");
    }
  }

  #[test]
  fn a_tally_counts_a_worker_it_first_sees_at_what_it_has_already_used_and_never_falls_whatever_the_workers_do() {
    let mut tally = Tally::default();
    assert_eq!(tally.fold(&[(7, Used { cpu_ms: 400, read_bytes: 9 })]), Used { cpu_ms: 400, read_bytes: 9 });
    assert_eq!(tally.fold(&[(7, Used { cpu_ms: 900, read_bytes: 9 })]), Used { cpu_ms: 900, read_bytes: 9 });
    // The worker is gone: what it used stays.
    assert_eq!(tally.fold(&[]), Used { cpu_ms: 900, read_bytes: 9 });
    let mut seed = 0x9E37_79B9_7F4A_7C15u64;
    for _ in 0..400 {
      let mut tally = Tally::default();
      let mut total = Used::default();
      let mut live: Vec<(u32, Used)> = Vec::new();
      for _ in 0..60 {
        match xorshift(&mut seed) % 5 {
          0 if live.len() < 3 => {
            let id = (xorshift(&mut seed) % 6) as u32;
            if live.iter().all(|(other, _)| *other != id) {
              live.push((id, Used { cpu_ms: xorshift(&mut seed) % 50, read_bytes: xorshift(&mut seed) % 50 }));
            }
          }
          1 if !live.is_empty() => { let index = xorshift(&mut seed) as usize % live.len(); live.remove(index); }
          // An id reused by a new process: its counters start again from a small number.
          2 if !live.is_empty() => {
            let index = xorshift(&mut seed) as usize % live.len();
            live[index].1 = Used { cpu_ms: xorshift(&mut seed) % 20, read_bytes: xorshift(&mut seed) % 20 };
          }
          _ => for (_, used) in live.iter_mut() {
            used.cpu_ms += xorshift(&mut seed) % 100;
            used.read_bytes += xorshift(&mut seed) % 100;
          },
        }
        let now = tally.fold(&live);
        assert!(now.cpu_ms >= total.cpu_ms && now.read_bytes >= total.read_bytes, "the total fell from {total:?} to {now:?}");
        total = now;
      }
    }
  }

  #[test]
  fn proc_text_is_read_by_field_and_a_command_name_cannot_move_the_fields() {
    let stat = "4242 (a b) c) S 1 4242 4242 0 -1 4194304 1000 0 0 0 150 50 0 0 20 0 1 0 12345 123456 789 18446744073709551615";
    assert_eq!(parse_stat(stat), Some(2000));
    assert_eq!(parse_stat("1 (x) R 0 0 0 0 0 0 0 0 0 0 0 0 0 0"), Some(0));
    let io = "rchar: 1234\nwchar: 5\nsyscr: 1\nsyscw: 1\nread_bytes: 77\nwrite_bytes: 0\ncancelled_write_bytes: 0\n";
    assert_eq!(parse_io(io), Some(1234));
  }

  #[test]
  fn text_that_is_not_proc_text_reads_as_nothing() {
    for text in ["", "no brackets here", "1 (x)", "1 (x) S 1 2", "1 (x) S 1 2 3 4 5 6 7 8 9 10 11 a b", "1 (x) S 1 2 3 4 5 6 7 8 9 10 11 -5 7"] {
      assert_eq!(parse_stat(text), None, "{text:?}");
    }
    for text in ["", "rchar:", "rchar: x", "rchar: -1", "wchar: 5\nread_bytes: 7\n", "rchar:99999999999999999999999"] {
      assert_eq!(parse_io(text), None, "{text:?}");
    }
  }

  #[test]
  fn the_sampler_prints_its_first_mark_at_once_and_stops_the_moment_the_export_settles() {
    let control = control();
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let kept = lines.clone();
    let reads = Arc::new(AtomicU64::new(0));
    let counted = reads.clone();
    let sampler = {
      let control = control.clone();
      std::thread::spawn(move || run(&control, Duration::from_secs(60),
        || { let n = counted.fetch_add(1, Ordering::SeqCst); Some(Used { cpu_ms: n, read_bytes: n }) },
        |text| kept.lock().unwrap().push(text)))
    };
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(lines.lock().unwrap().clone(), vec!["artdaddy_cpu=0,0\n".to_owned()], "the first mark is not left waiting for the interval");
    let settled = Instant::now();
    control.settle().unwrap();
    sampler.join().unwrap();
    assert!(settled.elapsed() < Duration::from_secs(5), "a settled export waited out the interval before its sampler ended");
    assert_eq!(lines.lock().unwrap().len(), 1);
    assert_eq!(reads.load(Ordering::SeqCst), 1, "no look is taken after the export settled");
  }

  #[test]
  fn the_sampler_prints_one_mark_a_look_and_says_nothing_for_a_look_that_failed() {
    let control = control();
    let lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let kept = lines.clone();
    let reads = Arc::new(AtomicU64::new(0));
    let counted = reads.clone();
    let sampler = {
      let control = control.clone();
      std::thread::spawn(move || run(&control, Duration::from_millis(30),
        || { let n = counted.fetch_add(1, Ordering::SeqCst); (n % 2 == 0).then_some(Used { cpu_ms: n * 10, read_bytes: n }) },
        |text| kept.lock().unwrap().push(text)))
    };
    std::thread::sleep(Duration::from_millis(500));
    control.settle().unwrap();
    sampler.join().unwrap();
    let lines = lines.lock().unwrap().clone();
    let reads = reads.load(Ordering::SeqCst);
    assert!(reads >= 6, "the sampler looked {reads} times in half a second at a 30 ms interval");
    assert_eq!(lines.len() as u64, (reads + 1) / 2, "a failed look printed something, or a good one did not: {lines:?}");
    let numbers = lines.iter().map(|line| parse(line).unwrap_or_else(|| panic!("not a mark: {line:?}"))).collect::<Vec<_>>();
    assert!(numbers.windows(2).all(|pair| pair[0].0 <= pair[1].0 && pair[0].1 <= pair[1].1), "{numbers:?}");
  }

  #[test]
  fn a_spinning_worker_reads_as_busy_and_a_sleeping_one_as_idle() {
    if !readable() { return; }
    let spin_dir = directory("spin");
    let spinning = control();
    let _spinner = worker(&spinning, spin_dir.path(), WorkerRole::Single);
    let mut tally = Tally::default();
    let before = sample(&spinning, &mut tally);
    let (after, busy) = wait_for(&spinning, &mut tally, |used| used.cpu_ms >= before.cpu_ms + 200);
    assert!(busy, "a worker that spins never showed 200 ms of processor: {before:?} then {after:?}");
    spinning.stop();

    let sleep_dir = directory("sleep");
    let sleeping = control();
    let _sleeper = worker(&sleeping, sleep_dir.path(), WorkerRole::Single);
    let mut tally = Tally::default();
    let before = sample(&sleeping, &mut tally);
    std::thread::sleep(Duration::from_millis(1500));
    let after = sample(&sleeping, &mut tally);
    let cpu = rose(after.cpu_ms, before.cpu_ms);
    assert!(cpu <= 150, "a worker that slept for 1.5 s used {cpu} ms of processor");
    sleeping.stop();
  }

  #[test]
  fn a_worker_that_reads_a_file_is_counted_in_bytes() {
    if !readable() { return; }
    let dir = directory("read");
    std::fs::write(dir.path().join("data.bin"), vec![7u8; 8 << 20]).unwrap();
    let control = control();
    let _worker = worker(&control, dir.path(), WorkerRole::Single);
    let mut tally = Tally::default();
    let before = sample(&control, &mut tally);
    let (after, read) = wait_for(&control, &mut tally, |used| used.read_bytes >= before.read_bytes + (8 << 20));
    assert!(read, "a worker that reads a file over and over never showed 8 MiB read: {before:?} then {after:?}");
    control.stop();
  }

  #[test]
  fn the_total_never_falls_when_a_worker_exits() {
    if !readable() { return; }
    let dir = directory("burst");
    let control = control();
    let worker = worker(&control, dir.path(), WorkerRole::PartitionProducer);
    let mut tally = Tally::default();
    let before = sample(&control, &mut tally);
    let Worker { tracked, .. } = worker;
    tracked.wait().unwrap();
    let after = sample(&control, &mut tally);
    assert!(after.cpu_ms >= before.cpu_ms && after.read_bytes >= before.read_bytes, "{before:?} then {after:?}");
    // The job object keeps the whole life of a worker that has gone, so the export has used something by now.
    if cfg!(windows) { assert!(after.cpu_ms > 0, "{before:?} then {after:?}"); }
  }

  // Each kind of worker the engines start (the single encoder, a partition producer, the continuous audio, the final
  // encoder) adds its own use to the export's total: one at a time, so that what rises is that worker's.
  #[test]
  fn a_worker_of_every_role_is_counted() {
    if !readable() { return; }
    let dir = directory("spin");
    let control = control();
    let mut tally = Tally::default();
    for role in [WorkerRole::Single, WorkerRole::PartitionProducer, WorkerRole::ContinuousAudio, WorkerRole::FinalEncoder] {
      let worker = worker(&control, dir.path(), role);
      let before = sample(&control, &mut tally);
      let (after, counted) = wait_for(&control, &mut tally, |used| used.cpu_ms >= before.cpu_ms + 100);
      assert!(counted, "a spinning {} worker never added 100 ms to the export: {before:?} then {after:?}",
        match role { WorkerRole::Single => "single", WorkerRole::PartitionProducer => "producer", WorkerRole::ContinuousAudio => "audio", WorkerRole::FinalEncoder => "final" });
      drop(worker);
    }
    control.stop();
  }

  // The reason the sampler is a thread of its own. Its reading never returns, as a hung query would leave it; the memory
  // guard still stops a worker that goes over its limit, and the export still settles.
  #[test]
  fn a_sampler_that_never_returns_cannot_hold_back_the_memory_guard() {
    let dir = tempfile::Builder::new().prefix("artdaddy-memory-qa-").tempdir().unwrap();
    let mut control = Control::new(deadline(), None).unwrap();
    control.resident_limit = 32 * 1024 * 1024;
    let control = Arc::new(control);
    let args = ["--exact", "jobs::stream::tests::resident_allocator_child", "--ignored", "--nocapture"].iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
    let guard: StartGuard = Arc::new(|| Ok(()));
    let tracked = control.spawn(&std::env::current_exe().unwrap(), &args, dir.path().to_str(), true, WorkerRole::Single, &guard).unwrap();
    let _input = tracked.child().take_stdin().unwrap();
    let _output = tracked.child().take_stdout().unwrap();
    let _errors = tracked.child().take_stderr().unwrap();
    control.watch();
    let (release, held) = mpsc::channel::<()>();
    let sampler = {
      let control = control.clone();
      std::thread::spawn(move || run(&control, Duration::from_millis(10), move || { let _ = held.recv(); None }, |_| {}))
    };
    assert!(tracked.wait().is_err(), "the guard let a worker over its limit run on while the sampler was stuck");
    let settled = control.settle();
    assert!(settled.unwrap_err().contains("resident memory budget exceeded"));
    drop(release);
    sampler.join().unwrap();
  }

  #[test]
  fn an_export_prints_marks_unless_the_page_switched_them_off_and_nothing_else_does() {
    let with = |lane: &str, meta: serde_json::Value| {
      let spec = JobSpec { id: "a".into(), lane: lane.into(), program: "ffmpeg".into(), args: vec![], steps: vec![], cwd: None, meta };
      wanted(&spec)
    };
    assert!(with("export", serde_json::json!({})));
    assert!(with("export", serde_json::json!({ "activityMarks": true })));
    assert!(!with("export", serde_json::json!({ "activityMarks": false })));
    assert!(with("export", serde_json::json!({ "activityMarks": "no" })), "only a real false switches it off");
    assert!(with("export", serde_json::json!({ "activityMarks": 0 })), "only a real false switches it off");
    // A thumbnail or a waveform is also an ffmpeg job; its output is read by code that knows nothing of marks.
    assert!(!with("media", serde_json::json!({})));
    assert!(!with("", serde_json::json!({})));
  }

  // From the app's own entry, with this test binary standing in for the worker: the mark comes with the first look,
  // before any progress, and the page's switch removes it.
  #[test]
  fn a_single_export_job_prints_its_first_mark_at_once_and_the_pages_switch_removes_it() {
    if !readable() { return; }
    for (meta, marked) in [(serde_json::json!({}), true), (serde_json::json!({ "activityMarks": false }), false)] {
      let dir = directory("pause");
      let mut spec = JobSpec { id: "activity".into(), lane: "export".into(), program: "ffmpeg".into(),
        args: CHILD.iter().map(|arg| (*arg).to_owned()).collect(), steps: vec![],
        cwd: Some(dir.path().to_string_lossy().into_owned()), meta };
      spec.meta["_native_execution_deadline"] = serde_json::json!(deadline());
      let (sender, receiver) = mpsc::channel();
      let seen = Arc::new(Mutex::new(String::new()));
      let kept = seen.clone();
      let observer: Observer = Arc::new(move |event| match event {
        ProcEvent::Exit(code) => { let _ = sender.send(code.unwrap_or(-1)); }
        ProcEvent::Stdout(text) => kept.lock().unwrap().push_str(&text),
        ProcEvent::Stderr(_) => {}
      });
      spawn_single(&std::env::current_exe().unwrap(), &spec, observer, Arc::default(), super::super::super::Workspace::new(20_000_000_000)).unwrap();
      assert_eq!(receiver.recv_timeout(Duration::from_secs(60)).expect("the job settled"), 0);
      let text = seen.lock().unwrap().clone();
      let marks = text.lines().filter(|line| line.starts_with("artdaddy_cpu=")).count();
      assert_eq!(marks > 0, marked, "{text}");
      for line in text.lines().filter(|line| line.starts_with("artdaddy_cpu=")) {
        assert!(parse(&format!("{line}\n")).is_some(), "not a mark the page can read: {line:?}");
      }
    }
  }

  // Both engines hold their export to the memory watch; both must start the sampler beside it. A new engine that copies
  // the watch and forgets the sampler would leave its exports silent, and the page would read silence as unknown.
  #[test]
  fn every_engine_starts_the_sampler_beside_its_memory_watch() {
    let source = include_str!("../stream.rs");
    let production = &source[..source.find("\nmod tests {").expect("the test module follows the engines")];
    let lines = production.lines().collect::<Vec<_>>();
    let mut watches = 0;
    for (index, line) in lines.iter().enumerate() {
      if line.trim() != "control.watch();" { continue; }
      watches += 1;
      let next = lines[index + 1..].iter().find(|line| !line.trim().is_empty()).copied().unwrap_or("");
      assert!(next.contains("activity::start("), "line {}: the memory watch is not followed by the sampler: {next:?}", index + 1);
    }
    assert_eq!(watches, 2, "the single engine and the streamed engine each start a watch");
  }

  #[cfg(target_os = "macos")]
  #[test]
  fn a_mac_says_nothing_for_now() {
    let dir = directory("sleep");
    let control = control();
    let _worker = worker(&control, dir.path(), WorkerRole::Single);
    assert_eq!(read_use(&control, &mut Tally::default()), None);
    control.stop();
  }
}
