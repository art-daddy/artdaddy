//! What the operating system says ended the app's last session, for the report of an exit nobody marked.
//!
//! A session that ends without an exit mark is recorded as an unexpected exit, and the record on its own cannot say whether
//! the PC lost power, Windows restarted to update, the app crashed or a person ended it. Windows keeps those facts in its
//! event log. After such an exit the app reads the few entries that fall in the minutes around it and boils them down to ONE
//! short word (`power_loss`, `os_update`, `app_crash:c0000005`, ...). Only that word leaves the PC: the log entries carry
//! user names, machine names and paths, and none of it is kept or sent.
//!
//! Windows only. Everywhere else there is nothing to read and no word.
#![cfg_attr(not(windows), allow(dead_code))]

/// A line of the event log, as far as this module reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogEvent {
  pub id: u32,
  pub provider: String,
  /// When it was written, in milliseconds since 1970 (UTC).
  pub at_ms: u64,
  /// Its fields in the order the log gives them: the name when it has one, and the text.
  pub data: Vec<(String, String)>,
}

/// The words this module can answer with, besides `app_crash:<code>` and `webview_crash:<code>`. The tests walk them.
#[cfg(test)]
pub const WORDS: [&str; 8] = [
  "power_loss",
  "bugcheck",
  "app_hang",
  "os_update",
  "os_shutdown",
  "os_restart",
  "unexpected_shutdown",
  "unknown",
];

// What is read ------------------------------------------------------------------------------------------------------

/// Days since 1970-01-01 of a civil date (proleptic Gregorian); the standard days-from-civil count.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
  let year = if month <= 2 { year - 1 } else { year };
  let era = if year >= 0 { year } else { year - 399 } / 400;
  let year_of_era = year - era * 400;
  let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
  let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
  era * 146_097 + day_of_era - 719_468
}

/// The civil date of a count of days since 1970-01-01.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
  let days = days + 719_468;
  let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
  let day_of_era = days - era * 146_097;
  let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
  let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
  let shifted_month = (5 * day_of_year + 2) / 153;
  let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
  let month = if shifted_month < 10 { shifted_month + 3 } else { shifted_month - 9 };
  (year_of_era + era * 400 + if month <= 2 { 1 } else { 0 }, month, day)
}

/// `2026-10-26T06:00:18.4625836Z` as milliseconds since 1970. Only a UTC time of that shape is believed.
pub fn iso_to_ms(text: &str) -> Option<u64> {
  let text = text.trim();
  let text = text.strip_suffix('Z')?;
  let (date, time) = text.split_once('T')?;
  let mut date = date.split('-');
  let (year, month, day) = (date.next()?, date.next()?, date.next()?);
  if date.next().is_some() {
    return None;
  }
  let (clock, fraction) = match time.split_once('.') {
    Some((clock, fraction)) => (clock, fraction),
    None => (time, ""),
  };
  let mut clock = clock.split(':');
  let (hour, minute, second) = (clock.next()?, clock.next()?, clock.next()?);
  if clock.next().is_some() || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
    return None;
  }
  let number = |text: &str, digits: usize| -> Option<i64> {
    (text.len() == digits && text.bytes().all(|byte| byte.is_ascii_digit())).then(|| text.parse().ok())?
  };
  let (year, month, day) = (number(year, 4)?, number(month, 2)?, number(day, 2)?);
  let (hour, minute, second) = (number(hour, 2)?, number(minute, 2)?, number(second, 2)?);
  if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
    return None;
  }
  let millis: i64 = format!("{:0<3}", &fraction[..fraction.len().min(3)]).parse().ok()?;
  let seconds = days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second;
  u64::try_from(seconds * 1_000 + millis).ok()
}

/// Milliseconds since 1970 as the log's own query time, `2026-10-26T06:00:18.000Z` (whole seconds, rounded down).
pub fn ms_to_iso(ms: u64) -> String {
  let seconds = (ms / 1_000) as i64;
  let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
  let rest = seconds.rem_euclid(86_400);
  format!(
    "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
    rest / 3_600,
    rest % 3_600 / 60,
    rest % 60
  )
}

fn unescape(text: &str) -> String {
  text
    .replace("&lt;", "<")
    .replace("&gt;", ">")
    .replace("&quot;", "\"")
    .replace("&apos;", "'")
    .replace("&amp;", "&")
}

/// The value of `name='...'` (or `name="..."`) inside one tag's text.
fn attribute(tag: &str, name: &str) -> Option<String> {
  for quote in ['\'', '"'] {
    let key = format!("{name}={quote}");
    if let Some(start) = tag.find(&key) {
      let rest = &tag[start + key.len()..];
      if let Some(end) = rest.find(quote) {
        return Some(unescape(&rest[..end]));
      }
    }
  }
  None
}

/// The text of the first `<tag ...>text</tag>` in `xml`.
fn element<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
  let open = xml.find(&format!("<{tag}"))?;
  let after = &xml[open..];
  let start = after.find('>')? + 1;
  if after[..start].ends_with("/>") {
    return Some("");
  }
  let end = after[start..].find(&format!("</{tag}>"))?;
  Some(&after[start..start + end])
}

/// The opening tag of the first `<tag ...>` in `xml`, brackets included.
fn opening<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
  let open = xml.find(&format!("<{tag}"))?;
  let after = &xml[open..];
  Some(&after[..after.find('>')? + 1])
}

/// The events in what `wevtutil qe <log> /f:xml` prints: one `<Event>` after another. Anything it does not understand is
/// skipped rather than guessed at; it never fails.
pub fn parse_events(xml: &str) -> Vec<LogEvent> {
  let mut events = Vec::new();
  for piece in xml.split("<Event ").skip(1) {
    let piece = piece.split("</Event>").next().unwrap_or(piece);
    let Some(id) = element(piece, "EventID").and_then(|text| text.trim().parse::<u32>().ok()) else {
      continue;
    };
    let provider = opening(piece, "Provider").and_then(|tag| attribute(tag, "Name")).unwrap_or_default();
    let Some(at_ms) = opening(piece, "TimeCreated")
      .and_then(|tag| attribute(tag, "SystemTime"))
      .and_then(|text| iso_to_ms(&text))
    else {
      continue;
    };
    let mut data = Vec::new();
    if let Some(body) = element(piece, "EventData") {
      let mut rest = body;
      while let Some(open) = rest.find("<Data") {
        let after = &rest[open..];
        let Some(end_of_tag) = after.find('>') else { break };
        let tag = &after[..=end_of_tag];
        let name = attribute(tag, "Name").unwrap_or_default();
        if tag.ends_with("/>") {
          data.push((name, String::new()));
          rest = &after[end_of_tag + 1..];
        } else {
          let value_start = end_of_tag + 1;
          let Some(value_end) = after[value_start..].find("</Data>") else { break };
          data.push((name, unescape(&after[value_start..value_start + value_end])));
          rest = &after[value_start + value_end + "</Data>".len()..];
        }
      }
    }
    events.push(LogEvent { id, provider, at_ms, data });
  }
  events
}

// What it means -----------------------------------------------------------------------------------------------------

/// How long after the session's last sign of life a request to shut down may have been made and still be what ended it.
const SHUTDOWN_GRACE_MS: u64 = 5 * 60_000;

fn field<'a>(event: &'a LogEvent, name: &str, position: usize) -> Option<&'a str> {
  // An entry's fields have names or only places; an empty name asks for the place.
  let named = (!name.is_empty()).then(|| event.data.iter().find(|(key, _)| key == name)).flatten();
  named.or_else(|| event.data.get(position)).map(|(_, value)| value.as_str())
}

/// A hexadecimal exception code, as the log writes it, or None for anything else (so no free text from the log can pass).
fn exception_code(text: &str) -> Option<String> {
  let text = text.trim().trim_start_matches("0x").to_ascii_lowercase();
  (!text.is_empty() && text.len() <= 8 && text.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(text)
}

fn names(event: &LogEvent, exe: &str) -> bool {
  field(event, "AppName", 0).is_some_and(|name| name.trim().eq_ignore_ascii_case(exe))
}

/// The one short word that says what ended the session, from the entries the log holds for the minutes around it. `ended_ms`
/// is when the session was last seen alive and `app_exe` this app's own file name. The order is the order of trust: a PC that
/// died, then a crash of this app or its web view, then something the operating system asked for, then a hang, then
/// "unexpected" with nothing more to say. A shutdown that was asked for long after the session had stopped is not what ended it
/// (a PC restarted by hand an hour after the app was killed): the apps are closed within moments of the request.
pub fn classify(events: &[LogEvent], ended_ms: u64, app_exe: &str) -> String {
  let kernel_power = events.iter().find(|event| event.id == 41 && event.provider.contains("Kernel-Power"));
  if let Some(event) = kernel_power {
    let bugcheck = field(event, "BugcheckCode", usize::MAX).map(str::trim).unwrap_or("0");
    let blue_screen = bugcheck != "0" && bugcheck != "0x0" && !bugcheck.is_empty();
    return if blue_screen { "bugcheck" } else { "power_loss" }.to_string();
  }
  for event in events.iter().filter(|event| event.id == 1000 && event.provider == "Application Error") {
    let code = field(event, "ExceptionCode", 6).and_then(exception_code);
    if names(event, app_exe) {
      return code.map_or_else(|| "app_crash".to_string(), |code| format!("app_crash:{code}"));
    }
    if names(event, "msedgewebview2.exe") {
      return code.map_or_else(|| "webview_crash".to_string(), |code| format!("webview_crash:{code}"));
    }
  }
  let asked = events
    .iter()
    .find(|event| event.id == 1074 && event.provider == "User32" && event.at_ms <= ended_ms.saturating_add(SHUTDOWN_GRACE_MS));
  if let Some(event) = asked {
    let reason = field(event, "param3", 2).unwrap_or("");
    let action = field(event, "param5", 4).unwrap_or("").to_ascii_lowercase();
    let update = reason.contains("Operating System") && (reason.contains("Upgrade") || reason.contains("Update"));
    return if update {
      "os_update"
    } else if action.contains("restart") || action.contains("reboot") {
      "os_restart"
    } else {
      "os_shutdown"
    }
    .to_string();
  }
  if events
    .iter()
    .any(|event| event.id == 1002 && event.provider == "Application Hang" && names(event, app_exe))
  {
    return "app_hang".to_string();
  }
  if events.iter().any(|event| event.id == 6008) {
    return "unexpected_shutdown".to_string();
  }
  "unknown".to_string()
}

// The log itself ----------------------------------------------------------------------------------------------------

/// How long the log may be asked: the app does not wait for it longer than this, so a slow or stuck log costs a word, never a start.
#[cfg(windows)]
const QUERY_DEADLINE: std::time::Duration = std::time::Duration::from_secs(4);

/// The entries of one log from `since_ms` on that can explain an end, as text.
#[cfg(windows)]
fn read_log(channel: &str, ids: &[u32], since_ms: u64) -> String {
  use std::io::Read;
  use std::os::windows::process::CommandExt;
  use std::process::{Command, Stdio};
  const CREATE_NO_WINDOW: u32 = 0x0800_0000;
  let any = ids.iter().map(|id| format!("EventID={id}")).collect::<Vec<_>>().join(" or ");
  let query = format!("*[System[({any}) and TimeCreated[@SystemTime>='{}']]]", ms_to_iso(since_ms));
  let Ok(mut child) = Command::new("wevtutil.exe")
    .args(["qe", channel, &format!("/q:{query}"), "/c:20", "/rd:true", "/f:xml"])
    .creation_flags(CREATE_NO_WINDOW)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .spawn()
  else {
    return String::new();
  };
  let Some(mut stdout) = child.stdout.take() else { return String::new() };
  // The output is read on its own thread so a full pipe cannot stall the wait; the wait ends at the deadline whatever the log does.
  let reader = std::thread::spawn(move || {
    let mut bytes = Vec::new();
    let _ = stdout.read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
  });
  let deadline = std::time::Instant::now() + QUERY_DEADLINE;
  loop {
    match child.try_wait() {
      Ok(Some(_)) => break,
      Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(15)),
      _ => {
        let _ = child.kill();
        let _ = child.wait();
        break;
      }
    }
  }
  reader.join().unwrap_or_default()
}

/// What the Windows event log says ended a session whose last sign of life was at `alive_ms`. Blocks for up to a few seconds.
#[cfg(windows)]
pub fn lookup(alive_ms: u64, app_exe: &str) -> String {
  // The entry that explains an end can come before the last sign of life (a shutdown is announced first) or after it (the next
  // start writes down that the last one was unexpected), so the window opens two minutes before it and stays open until now.
  let since = alive_ms.saturating_sub(120_000);
  let mut events = parse_events(&read_log("System", &[41, 6008, 1074], since));
  events.extend(parse_events(&read_log("Application", &[1000, 1002], since)));
  classify(&events, alive_ms, app_exe)
}

#[cfg(not(windows))]
pub fn lookup(_alive_ms: u64, _app_exe: &str) -> String {
  "unknown".to_string()
}

/// What the cause lookup is told about the session that ended without a mark.
#[derive(Debug, Clone)]
pub struct EndSession {
  /// When it started, in milliseconds since 1970: nothing it left behind is older than this.
  pub started_at: u64,
  /// When it was last seen alive, in milliseconds since 1970.
  pub alive_at: u64,
  /// When the next start noticed it had ended without a mark: it ended no later than this.
  pub detected_at: u64,
  /// Its launch: the name of the mark a signal may have left for it.
  pub launch_id: String,
  /// Which start of the PC it ran in (`unix_end::current_boot_id`); empty when that could not be read.
  pub boot_id: String,
  /// When a Rust panic was recorded in it, if one was.
  pub panic_at: Option<u64>,
  /// The folder the app keeps its health record and its marks in.
  pub dir: std::path::PathBuf,
}

/// The one short word for what ended `session`, from what the operating system and the app itself left behind. Blocks for up to a
/// few seconds on Windows (the event log); on macOS and Linux it only reads a few small files.
pub fn lookup_session(session: &EndSession, app_exe: &str) -> String {
  #[cfg(windows)]
  {
    lookup(session.alive_at, app_exe)
  }
  #[cfg(not(windows))]
  {
    unix_end::lookup(session, app_exe)
  }
}

// macOS and Linux ---------------------------------------------------------------------------------------------------

/// There is no event log to ask on macOS or Linux. The app leaves a mark of its own when a signal ends it (`exit_signal.rs`), and
/// the rest is read off its own record (a panic, a restart of the PC) and, on macOS, the system's crash report. Only a word of
/// {@link unix_end::WORDS} leaves the PC: a mark or a report is never copied, only matched against a fixed list.
#[cfg_attr(windows, allow(dead_code))]
pub mod unix_end {
  use super::EndSession;
  use std::io::{Read, Seek, SeekFrom};
  use std::path::{Path, PathBuf};
  use std::time::UNIX_EPOCH;

  /// The words this side answers with. The tests walk them, and each has the shape the page accepts (`[a-z_]{1,30}`).
  pub const WORDS: [&str; 21] = [
    "panic",
    "signal_segv",
    "signal_bus",
    "signal_ill",
    "signal_fpe",
    "signal_abrt",
    "signal_term",
    "signal_hup",
    "signal_int",
    "signal_quit",
    "os_shutdown",
    "crash_bad_access",
    "crash_bad_instruction",
    "crash_arithmetic",
    "crash_breakpoint",
    "crash_abort",
    "crash_resource",
    "crash_guard",
    "crash_other",
    "pc_restarted",
    "no_trace",
  ];

  /// The signals the app leaves a mark for, as the words it writes. The handler writes one of these and nothing else.
  pub const SIGNAL_WORDS: [&str; 9] = [
    "signal_segv",
    "signal_bus",
    "signal_ill",
    "signal_fpe",
    "signal_abrt",
    "signal_term",
    "signal_hup",
    "signal_int",
    "signal_quit",
  ];

  /// A mark older than this before the session's last sign of life is from a signal the process lived through (handled, or ignored
  /// by whoever handled it), not the one that ended it.
  pub const MARKER_STALE_MS: u64 = 15_000;
  /// A panic is taken as what ended the session when the session's last sign of life is no more than this after it. The page
  /// checks in about every five seconds, so a panic the app lived through is followed by a later sign of life within a beat or
  /// two, while one that ended it is not.
  pub const PANIC_NEAR_MS: u64 = 6_000;
  /// How long after the next start noticed the end a crash report of it may still be written (the system writes one a few seconds
  /// after the crash, and a person may have opened the app again at once).
  pub const REPORT_GRACE_MS: u64 = 60_000;
  const MARKER_BYTES: u64 = 512;
  const REPORT_BYTES: u64 = 64 * 1024;

  /// A word a signal handler wrote, and when.
  #[derive(Debug, Clone, Copy, PartialEq, Eq)]
  pub struct Marker {
    pub word: &'static str,
    pub at_ms: u64,
  }

  /// The name of the mark for a launch: only letters, digits, `-` and `_` of it are used, so no id can name another folder.
  pub fn marker_file_name(launch_id: &str) -> String {
    let id: String = launch_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(64).collect();
    format!("exit-{id}.mark")
  }

  /// `Some(word)` when `line` is exactly one of the words a handler writes.
  pub fn marker_word(line: &str) -> Option<&'static str> {
    let line = line.trim();
    SIGNAL_WORDS.iter().copied().find(|word| *word == line)
  }

  fn modified_ms(metadata: &std::fs::Metadata) -> Option<u64> {
    let elapsed = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(elapsed.as_millis() as u64)
  }

  /// The last word the launch's mark holds, and when it was written. Reads at most the last few hundred bytes.
  pub fn read_marker(dir: &Path, launch_id: &str) -> Option<Marker> {
    let mut file = std::fs::File::open(dir.join(marker_file_name(launch_id))).ok()?;
    let metadata = file.metadata().ok()?;
    // A time that cannot be read counts as recent: a word with no date is more use than none.
    let at_ms = modified_ms(&metadata).unwrap_or(u64::MAX);
    if metadata.len() > MARKER_BYTES {
      file.seek(SeekFrom::Start(metadata.len() - MARKER_BYTES)).ok()?;
    }
    let mut bytes = Vec::new();
    file.take(MARKER_BYTES).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let words: Vec<&'static str> = text.lines().filter_map(marker_word).collect();
    let last = *words.last()?;
    // A crash the runtime turns into an abort is the crash: a stack that ran out is a fault on a guard page, and the runtime's own
    // handler then calls `abort`, so the mark ends in the abort the fault led to.
    let word = if last == "signal_abrt" {
      words.iter().rev().find(|word| matches!(**word, "signal_segv" | "signal_bus" | "signal_ill" | "signal_fpe")).copied().unwrap_or(last)
    } else {
      last
    };
    Some(Marker { word, at_ms })
  }

  /// The kind of crash a macOS crash report names, as a word; never any other text of it.
  pub fn crash_report_word(text: &str) -> Option<&'static str> {
    let head = &text.as_bytes()[..text.len().min(REPORT_BYTES as usize)];
    let start = head.windows(4).position(|window| window == b"EXC_")?;
    let kind: Vec<u8> = head[start..].iter().copied().take_while(|b| b.is_ascii_uppercase() || *b == b'_').take(32).collect();
    Some(match kind.as_slice() {
      b"EXC_BAD_ACCESS" => "crash_bad_access",
      b"EXC_BAD_INSTRUCTION" => "crash_bad_instruction",
      b"EXC_ARITHMETIC" => "crash_arithmetic",
      b"EXC_BREAKPOINT" => "crash_breakpoint",
      b"EXC_CRASH" => "crash_abort",
      b"EXC_RESOURCE" => "crash_resource",
      b"EXC_GUARD" => "crash_guard",
      _ => "crash_other",
    })
  }

  /// The word of the first crash report of `exe` written from `from_ms` to `until_ms` in `dir`: the first, because a report of a
  /// later crash (of the next run) is not this session's. A report is `<program>-<time>.ips` (or the older `.crash`): another
  /// program's, another kind of file and one of a helper with a longer name are not this app's.
  pub fn first_report_word(dir: &Path, exe: &str, from_ms: u64, until_ms: u64) -> Option<&'static str> {
    let stem = Path::new(exe).file_stem()?.to_str()?;
    let prefix = format!("{stem}-");
    let mut first: Option<(u64, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
      let name = entry.file_name();
      let Some(name) = name.to_str() else { continue };
      let rest = name.strip_prefix(&prefix).unwrap_or("");
      // `<time>` has no `-` after its date and time of day: the helper `artdaddy-helper-<time>` would leave a letter first.
      let is_report = (name.ends_with(".ips") || name.ends_with(".crash")) && rest.starts_with(|c: char| c.is_ascii_digit());
      if !is_report {
        continue;
      }
      let Some(at) = entry.metadata().ok().as_ref().and_then(modified_ms) else { continue };
      if (from_ms..=until_ms).contains(&at) && first.as_ref().map_or(true, |(best, _)| at < *best) {
        first = Some((at, entry.path()));
      }
    }
    let (_, path) = first?;
    let mut bytes = Vec::new();
    std::fs::File::open(path).ok()?.take(REPORT_BYTES).read_to_end(&mut bytes).ok()?;
    crash_report_word(&String::from_utf8_lossy(&bytes))
  }

  /// `Some(true)` when the PC has started again since, `None` when either start could not be identified.
  pub fn boot_changed(was: &str, now: &str) -> Option<bool> {
    (!was.is_empty() && !now.is_empty()).then(|| was != now)
  }

  /// Which start of the PC this is: not a secret and not sent anywhere, only compared with the one a session stored.
  #[cfg(target_os = "linux")]
  pub fn current_boot_id() -> String {
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
      .map(|id| id.trim().chars().take(64).collect())
      .unwrap_or_default()
  }

  /// Which start of the PC this is: the time it started (`kern.boottime`), to the second.
  #[cfg(target_os = "macos")]
  pub fn current_boot_id() -> String {
    let mut boot = libc::timeval { tv_sec: 0, tv_usec: 0 };
    let mut size = std::mem::size_of::<libc::timeval>();
    // SAFETY: the name is a C string, `boot` is a timeval of the size given, and nothing is written to the system.
    let ok = unsafe {
      libc::sysctlbyname(
        c"kern.boottime".as_ptr(),
        (&mut boot as *mut libc::timeval).cast(),
        &mut size,
        std::ptr::null_mut(),
        0,
      )
    } == 0;
    if ok {
      boot.tv_sec.to_string()
    } else {
      String::new()
    }
  }

  /// Not identified on other systems: the end then says only what its mark or its panic say.
  #[cfg(not(any(target_os = "linux", target_os = "macos")))]
  pub fn current_boot_id() -> String {
    String::new()
  }

  /// What is known about the end.
  #[derive(Debug, Clone, Copy)]
  pub struct EndFacts {
    pub marker: Option<Marker>,
    pub alive_at: u64,
    pub panic_at: Option<u64>,
    pub boot_changed: Option<bool>,
    pub report: Option<&'static str>,
  }

  /// The word for an end, from what is known about it. The order is the order of trust: what the process itself wrote when a
  /// signal ended it, then a panic near the end, then the system's crash report, then what can be said of the PC.
  pub fn classify(facts: &EndFacts) -> &'static str {
    let panic_near = facts.panic_at.is_some_and(|at| at.saturating_add(PANIC_NEAR_MS) >= facts.alive_at);
    if let Some(marker) = facts.marker.filter(|marker| marker.at_ms.saturating_add(MARKER_STALE_MS) >= facts.alive_at) {
      return match marker.word {
        // A panic that ends in an abort is the panic.
        "signal_abrt" if panic_near => "panic",
        // A request to end, with the PC started again since, is the PC being shut down (a person who ended the app and restarted
        // the PC much later is rare, and the word says no more than that it was asked to end).
        "signal_term" | "signal_hup" if facts.boot_changed == Some(true) => "os_shutdown",
        word => word,
      };
    }
    if panic_near {
      return "panic";
    }
    if let Some(word) = facts.report {
      return word;
    }
    match facts.boot_changed {
      Some(true) => "pc_restarted",
      Some(false) => "no_trace",
      None => "unknown",
    }
  }

  pub fn lookup(session: &EndSession, app_exe: &str) -> String {
    let marker = read_marker(&session.dir, &session.launch_id);
    let boot = boot_changed(&session.boot_id, &current_boot_id());
    // Only a report written while the session ran, or just after it ended, can be about it.
    let report = if cfg!(target_os = "macos") {
      std::env::var_os("HOME").map(PathBuf::from).and_then(|home| {
        first_report_word(
          &home.join("Library/Logs/DiagnosticReports"),
          app_exe,
          session.started_at,
          session.detected_at.saturating_add(REPORT_GRACE_MS),
        )
      })
    } else {
      None
    };
    classify(&EndFacts { marker, alive_at: session.alive_at, panic_at: session.panic_at, boot_changed: boot, report }).to_string()
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  // A real entry from a Windows 11 PC (names and paths as they were written: none of it may reach a report).
  const SHUTDOWN: &str = "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='User32' Guid='{b0aa8734-56f7-41cc-b2f4-de228e98b946}' EventSourceName='User32'/><EventID Qualifiers='32768'>1074</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8080000000000000</Keywords><TimeCreated SystemTime='2026-10-26T06:00:18.4625836Z'/><EventRecordID>122217</EventRecordID><Correlation/><Execution ProcessID='1552' ThreadID='2376'/><Channel>System</Channel><Computer>AKSHAY_MS_NEW</Computer><Security UserID='S-1-12-1-4108874888-1185848233-3288970143-1712493729'/></System><EventData><Data Name='param1'>C:\\Windows\\SystemApps\\Microsoft.Windows.StartMenuExperienceHost_cw5n1h2txyewy\\StartMenuExperienceHost.exe (AKSHAY_MS_NEW)</Data><Data Name='param2'>AKSHAY_MS_NEW</Data><Data Name='param3'>Other (Unplanned)</Data><Data Name='param4'>0x0</Data><Data Name='param5'>power off</Data><Data Name='param6'></Data><Data Name='param7'>FAREAST\\akshaydagar</Data></EventData></Event>";

  fn event(id: u32, provider: &str, data: &[(&str, &str)]) -> LogEvent {
    LogEvent {
      id,
      provider: provider.to_string(),
      at_ms: 1_000,
      data: data.iter().map(|(name, value)| (name.to_string(), value.to_string())).collect(),
    }
  }
  fn crash(app: &str, code: &str) -> LogEvent {
    event(
      1000,
      "Application Error",
      &[("", app), ("", "0.23.0.0"), ("", "6720a1b2"), ("", "KERNELBASE.dll"), ("", "10.0.26100.1"), ("", "8f3c2b11"), ("", code)],
    )
  }

  #[test]
  fn times_are_read_and_written_to_the_millisecond_and_second() {
    assert_eq!(iso_to_ms("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(iso_to_ms("2026-10-26T06:00:18.4625836Z"), Some(1_792_994_418_462));
    assert_eq!(iso_to_ms("2000-02-29T23:59:59Z"), Some(951_868_799_000));
    assert_eq!(iso_to_ms("2038-01-19T03:14:08.000Z"), Some(2_147_483_648_000));
    assert_eq!(ms_to_iso(1_794_054_896_000), "2026-11-07T12:34:56.000Z");
    assert_eq!(ms_to_iso(1_792_994_418_462), "2026-10-26T06:00:18.000Z");
  }

  #[test]
  fn a_time_that_is_not_a_utc_time_of_that_shape_is_not_believed() {
    for bad in ["", "yesterday", "2026-10-26", "2026-10-26T06:00:18", "2026-13-26T06:00:18Z", "2026-10-32T06:00:18Z",
      "2026-10-26T25:00:18Z", "2026-10-26T06:00:18+01:00", "2026-1-26T06:00:18Z", "2026-10-26T06:00:18.12x4Z"] {
      assert_eq!(iso_to_ms(bad), None, "{bad}");
    }
  }

  #[test]
  fn writing_a_time_and_reading_it_back_loses_nothing_but_the_sub_second() {
    for ms in [0u64, 1, 999, 86_399_999, 951_868_799_000, 1_792_994_418_462, 4_102_444_799_999] {
      assert_eq!(iso_to_ms(&ms_to_iso(ms)), Some(ms - ms % 1_000), "{ms}");
    }
  }

  #[test]
  fn a_real_entry_is_read_with_its_id_provider_time_and_fields() {
    let events = parse_events(SHUTDOWN);
    assert_eq!(events.len(), 1);
    assert_eq!((events[0].id, events[0].provider.as_str(), events[0].at_ms), (1074, "User32", 1_792_994_418_462));
    assert_eq!(field(&events[0], "param3", 2), Some("Other (Unplanned)"));
    assert_eq!(field(&events[0], "param5", 4), Some("power off"));
    assert_eq!(events[0].data.len(), 7);
  }

  #[test]
  fn several_entries_are_read_in_order_and_an_unreadable_one_is_skipped() {
    let xml = format!("{SHUTDOWN}<Event garbage</Event>{SHUTDOWN}<Event ><System><EventID>x</EventID></System></Event>");
    assert_eq!(parse_events(&xml).len(), 2);
    assert!(parse_events("").is_empty() && parse_events("not xml at all").is_empty());
  }

  #[test]
  fn a_real_shutdown_entry_says_the_pc_was_shut_down_and_not_who_by() {
    let word = classify(&parse_events(SHUTDOWN), 1_792_994_418_462, "artdaddy.exe");
    assert_eq!(word, "os_shutdown");
    for private in ["AKSHAY", "akshaydagar", "StartMenu", "FAREAST", "C:\\"] {
      assert!(!word.contains(private));
    }
  }

  #[test]
  fn a_real_crash_entry_with_named_fields_gives_the_programs_name_and_its_exception_code() {
    // From a Windows 11 PC: a system program that crashed, as the log wrote it.
    let xml = "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Application Error'/><EventID Qualifiers='0'>1000</EventID><TimeCreated SystemTime='2026-11-01T10:00:00.1Z'/></System><EventData><Data Name='AppName'>wmiprvse.exe</Data><Data Name='AppVersion'>10.0.26100.9711</Data><Data Name='AppTimeStamp'>1de116a5</Data><Data Name='ModuleName'>ntdll.dll</Data><Data Name='ModuleVersion'>10.0.26100.9711</Data><Data Name='ModuleTimeStamp'>5fd39a05</Data><Data Name='ExceptionCode'>c0000374</Data><Data Name='FaultingOffset'>0000000000118095</Data><Data Name='ProcessId'>0x119c</Data><Data Name='AppPath'>C:\\WINDOWS\\system32\\wbem\\wmiprvse.exe</Data></EventData></Event>";
    let events = parse_events(xml);
    assert_eq!(events.len(), 1);
    assert_eq!(classify(&events, events[0].at_ms, "wmiprvse.exe"), "app_crash:c0000374");
    // The same entry is somebody else's crash to an app of another name, and its path never reaches the answer.
    assert_eq!(classify(&events, events[0].at_ms, "artdaddy.exe"), "unknown");
    assert!(!classify(&events, events[0].at_ms, "wmiprvse.exe").contains("WINDOWS"));
  }

  #[test]
  fn each_thing_the_log_can_say_has_its_word() {
    let exe = "artdaddy.exe";
    let restart = event(1074, "User32", &[("param3", "Other (Unplanned)"), ("param5", "restart")]);
    let update = event(1074, "User32", &[("param3", "Operating System: Upgrade (Planned)"), ("param5", "restart")]);
    let power = event(41, "Microsoft-Windows-Kernel-Power", &[("BugcheckCode", "0")]);
    let blue = event(41, "Microsoft-Windows-Kernel-Power", &[("BugcheckCode", "159")]);
    let hang = event(1002, "Application Hang", &[("", exe)]);
    let unexpected = event(6008, "EventLog", &[]);
    let table: [(&[LogEvent], &str); 9] = [
      (&[restart], "os_restart"),
      (&[update], "os_update"),
      (&[power], "power_loss"),
      (&[blue], "bugcheck"),
      (&[crash(exe, "c0000005")], "app_crash:c0000005"),
      (&[crash("msedgewebview2.exe", "80000003")], "webview_crash:80000003"),
      (&[hang], "app_hang"),
      (&[unexpected], "unexpected_shutdown"),
      (&[], "unknown"),
    ];
    for (events, word) in table {
      assert_eq!(classify(events, 1_000, exe), word);
    }
  }

  #[test]
  fn another_program_crashing_is_not_this_apps_crash() {
    assert_eq!(classify(&[crash("notepad.exe", "c0000005")], 1_000, "artdaddy.exe"), "unknown");
    assert_eq!(classify(&[event(1002, "Application Hang", &[("", "notepad.exe")])], 1_000, "artdaddy.exe"), "unknown");
  }

  #[test]
  fn the_pc_dying_outranks_everything_that_followed_from_it() {
    let events = [
      crash("artdaddy.exe", "c0000005"),
      event(1074, "User32", &[("param5", "restart")]),
      event(41, "Microsoft-Windows-Kernel-Power", &[("BugcheckCode", "0")]),
    ];
    assert_eq!(classify(&events, 1_000, "artdaddy.exe"), "power_loss");
    // ...and this app's own crash outranks an operating-system shutdown that was announced at the same time.
    assert_eq!(classify(&events[..2], 1_000, "artdaddy.exe"), "app_crash:c0000005");
  }

  // A PC restarted by hand an hour after the app was killed did not end the app: apps are closed within moments of the request.
  #[test]
  fn a_shutdown_asked_for_long_after_the_session_stopped_is_not_what_ended_it() {
    let late = LogEvent { at_ms: 1_000 + SHUTDOWN_GRACE_MS + 1, ..event(1074, "User32", &[("param5", "restart")]) };
    let prompt = LogEvent { at_ms: 1_000 + SHUTDOWN_GRACE_MS, ..event(1074, "User32", &[("param5", "restart")]) };
    assert_eq!(classify(&[late], 1_000, "artdaddy.exe"), "unknown");
    assert_eq!(classify(&[prompt], 1_000, "artdaddy.exe"), "os_restart");
    // The PC dying is written down at the next start, however long after: that one stays.
    let boot = LogEvent { at_ms: 10 * 3_600_000, ..event(41, "Microsoft-Windows-Kernel-Power", &[("BugcheckCode", "0")]) };
    assert_eq!(classify(&[boot], 1_000, "artdaddy.exe"), "power_loss");
  }

  #[test]
  fn a_code_that_is_not_hexadecimal_is_left_out_so_no_text_of_the_logs_gets_through() {
    for bad in ["", "NotACode", "c0000005 and a user name", "123456789", "0xzz", "c0000005\n"] {
      let word = classify(&[crash("artdaddy.exe", bad)], 1_000, "artdaddy.exe");
      let trimmed = bad.trim();
      if trimmed.len() == 8 && trimmed.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        continue; // "c0000005\n" is a code once trimmed
      }
      assert_eq!(word, "app_crash", "{bad:?}");
    }
  }

  fn allowed(word: &str) -> bool {
    WORDS.contains(&word)
      || ["app_crash:", "webview_crash:"].iter().any(|prefix| {
        word.strip_prefix(prefix).is_some_and(|code| {
          (1..=8).contains(&code.len()) && code.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
      })
      || word == "app_crash"
      || word == "webview_crash"
  }

  #[test]
  fn whatever_the_log_holds_the_answer_is_one_of_the_words_and_never_the_logs_own_text() {
    // Nothing injectable survives, and nothing is thrown at a malformed log: arbitrary text in every field.
    let mut seed = 0x9e37_79b9_7f4a_7c15u64;
    let mut next = move || {
      seed ^= seed << 13;
      seed ^= seed >> 7;
      seed ^= seed << 17;
      seed
    };
    let texts = ["", "0", "159", "c0000005", "artdaddy.exe", "msedgewebview2.exe", "restart", "power off", "Operating System: Update",
      "<Data>", "&amp;", "FAREAST\\someone", "C:\\Users\\someone\\x", "\u{1F4A5}"];
    let providers = ["User32", "Application Error", "Application Hang", "Microsoft-Windows-Kernel-Power", "EventLog", "Other"];
    let ids = [41u32, 1000, 1002, 1074, 6008, 7, 0, u32::MAX];
    for _ in 0..2_000 {
      let count = (next() % 5) as usize;
      let events: Vec<LogEvent> = (0..count)
        .map(|_| LogEvent {
          id: ids[(next() % ids.len() as u64) as usize],
          provider: providers[(next() % providers.len() as u64) as usize].to_string(),
          at_ms: next() % 10_000,
          data: (0..(next() % 9))
            .map(|_| {
              let name = if next() % 2 == 0 { "" } else { ["param3", "param5", "BugcheckCode"][(next() % 3) as usize] };
              (name.to_string(), texts[(next() % texts.len() as u64) as usize].to_string())
            })
            .collect(),
        })
        .collect();
      let word = classify(&events, 5_000, "artdaddy.exe");
      assert!(allowed(&word), "{word:?} from {events:?}");
      for private in ["FAREAST", "someone", "C:\\"] {
        assert!(!word.contains(private), "{word:?}");
      }
    }
  }

  #[test]
  fn whatever_text_the_log_tool_prints_is_read_without_failing() {
    let mut seed = 0x1234_5678_9abc_def1u64;
    for round in 0..300 {
      let mut text = String::new();
      for _ in 0..(round % 40) {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        text.push_str(["<Event ", "</Event>", "<EventID>41</EventID>", "<Provider Name='", "<Data Name='x'>", "</Data>", "'/>", "<TimeCreated SystemTime='2026-10-26T06:00:18Z'/>", "é", "\u{0}"][(seed >> 33) as usize % 10]);
      }
      let _ = classify(&parse_events(&text), 0, "artdaddy.exe");
    }
  }

  // The real log of this PC, through the real tool: it answers within the deadline with one of the words, whatever it holds.
  #[cfg(windows)]
  #[test]
  fn the_real_event_log_answers_in_time_with_one_of_the_words() {
    let started = std::time::Instant::now();
    let now_ms = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|elapsed| elapsed.as_millis() as u64)
      .unwrap();
    // The last thirty days: whatever this machine has had in them.
    let word = lookup(now_ms - 30 * 86_400_000, "artdaddy.exe");
    eprintln!("the real log, last thirty days: {word} in {:?}", started.elapsed());
    assert!(allowed(&word), "{word:?}");
    assert!(started.elapsed() < std::time::Duration::from_secs(12), "{:?}", started.elapsed());
  }
}

// What ended a session on macOS or Linux: the same questions as above, answered from the app's own marks instead of a log.
#[cfg(test)]
mod unix_end_tests {
  use super::unix_end::*;
  use super::EndSession;
  use std::path::Path;

  const ALIVE: u64 = 1_000_000;

  fn facts(marker: Option<(&'static str, u64)>) -> EndFacts {
    EndFacts {
      marker: marker.map(|(word, at_ms)| Marker { word, at_ms }),
      alive_at: ALIVE,
      panic_at: None,
      boot_changed: Some(false),
      report: None,
    }
  }

  #[test]
  fn a_signal_that_ended_the_process_is_its_word() {
    for word in SIGNAL_WORDS {
      let said = classify(&facts(Some((word, ALIVE + 3_000))));
      // A request to end is a request to end; every other signal is itself.
      assert_eq!(said, word, "{word}");
    }
  }

  #[test]
  fn a_signal_the_process_lived_through_did_not_end_it() {
    // Written well before the last sign of life: whoever handled it let the process carry on, and something else ended it.
    let early = ALIVE - MARKER_STALE_MS - 1;
    assert_eq!(classify(&facts(Some(("signal_hup", early)))), "no_trace");
    // ...but right at the edge it still counts: heartbeats are seconds apart.
    assert_eq!(classify(&facts(Some(("signal_hup", ALIVE - MARKER_STALE_MS)))), "signal_hup");
  }

  #[test]
  fn a_panic_is_what_ended_it_with_or_without_the_abort_it_ends_in() {
    let mut f = facts(None);
    f.panic_at = Some(ALIVE + 2_000);
    assert_eq!(classify(&f), "panic");
    f.marker = Some(Marker { word: "signal_abrt", at_ms: ALIVE + 2_100 });
    assert_eq!(classify(&f), "panic");
    // Another crash after a panic is the crash.
    f.marker = Some(Marker { word: "signal_segv", at_ms: ALIVE + 2_100 });
    assert_eq!(classify(&f), "signal_segv");
    // A panic long before the end did not end it; an abort with no panic is an abort.
    f.panic_at = Some(ALIVE - PANIC_NEAR_MS - 1);
    f.marker = None;
    assert_eq!(classify(&f), "no_trace");
    assert_eq!(classify(&facts(Some(("signal_abrt", ALIVE + 1)))), "signal_abrt");
  }

  #[test]
  fn a_request_to_end_while_the_pc_restarted_is_a_shutdown() {
    for word in ["signal_term", "signal_hup"] {
      let mut f = facts(Some((word, ALIVE + 1_000)));
      f.boot_changed = Some(true);
      assert_eq!(classify(&f), "os_shutdown", "{word}");
      f.boot_changed = None;
      assert_eq!(classify(&f), word, "{word} with no boot to compare");
    }
    // Interrupt and quit come from a person at a terminal; a crash is a crash whatever happened to the PC after it.
    for word in ["signal_int", "signal_quit", "signal_segv", "signal_abrt"] {
      let mut f = facts(Some((word, ALIVE + 1_000)));
      f.boot_changed = Some(true);
      assert_eq!(classify(&f), word, "{word}");
    }
  }

  #[test]
  fn nothing_left_behind_says_only_what_the_data_can_tell_apart() {
    let mut f = facts(None);
    f.boot_changed = Some(true);
    assert_eq!(classify(&f), "pc_restarted");
    f.boot_changed = Some(false);
    assert_eq!(classify(&f), "no_trace");
    f.boot_changed = None;
    assert_eq!(classify(&f), "unknown");
  }

  #[test]
  fn a_crash_report_speaks_only_when_nothing_of_ours_does() {
    let mut f = facts(None);
    f.report = Some("crash_bad_access");
    f.boot_changed = Some(true);
    assert_eq!(classify(&f), "crash_bad_access");
    f.marker = Some(Marker { word: "signal_segv", at_ms: ALIVE + 1 });
    assert_eq!(classify(&f), "signal_segv");
    // A panic is the more exact word than the report of the abort it ended in.
    f.marker = None;
    f.panic_at = Some(ALIVE + 1);
    assert_eq!(classify(&f), "panic");
  }

  #[test]
  fn whatever_is_known_the_answer_is_one_of_the_words_and_has_the_shape_the_page_accepts() {
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut next = move || {
      seed ^= seed << 13;
      seed ^= seed >> 7;
      seed ^= seed << 17;
      seed
    };
    let reports: [Option<&'static str>; 4] = [None, Some("crash_other"), Some("crash_resource"), Some("crash_abort")];
    for _ in 0..5_000 {
      let marker = match next() % 3 {
        0 => None,
        _ => Some(Marker { word: SIGNAL_WORDS[(next() % 9) as usize], at_ms: next() % (2 * ALIVE) }),
      };
      let f = EndFacts {
        marker,
        alive_at: next() % (2 * ALIVE),
        panic_at: if next() % 2 == 0 { None } else { Some(next() % (2 * ALIVE)) },
        boot_changed: [None, Some(true), Some(false)][(next() % 3) as usize],
        report: reports[(next() % 4) as usize],
      };
      let word = classify(&f);
      assert!(WORDS.contains(&word) || word == "unknown", "{word:?}");
      assert!((1..=30).contains(&word.len()) && word.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'), "{word:?}");
    }
    for word in WORDS {
      assert!((1..=30).contains(&word.len()) && word.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'), "{word:?}");
    }
  }

  #[test]
  fn a_mark_holds_only_words_the_handler_writes_and_nothing_else_is_believed() {
    for word in SIGNAL_WORDS {
      assert_eq!(marker_word(word), Some(word));
      assert_eq!(marker_word(&format!("{word}\n")), Some(word));
      assert_eq!(marker_word(&format!("  {word}  ")), Some(word));
    }
    for bad in ["", "signal_", "SIGNAL_SEGV", "signal_segv extra", "signal_kill", "panic", "/home/someone/x", "signal_se"] {
      assert_eq!(marker_word(bad), None, "{bad:?}");
    }
  }

  #[test]
  fn the_name_of_a_mark_cannot_name_another_place() {
    assert_eq!(marker_file_name("launch-1a2b-3c"), "exit-launch-1a2b-3c.mark");
    for hostile in ["../../etc/passwd", "a/b", "a\\b", "..", "a.b", "con:", "x\0y", "\u{1F4A5}"] {
      let name = marker_file_name(hostile);
      assert!(name.starts_with("exit-") && name.ends_with(".mark"), "{name}");
      assert!(!name.contains('/') && !name.contains('\\') && !name.contains(".."), "{name}");
      assert!(name.len() <= "exit-".len() + 64 + ".mark".len(), "{name}");
    }
  }

  fn write_mark(dir: &Path, launch: &str, content: &[u8]) {
    std::fs::write(dir.join(marker_file_name(launch)), content).unwrap();
  }

  #[test]
  fn the_last_word_of_the_launchs_mark_is_the_one_that_counts() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(read_marker(dir.path(), "none"), None);
    write_mark(dir.path(), "empty", b"");
    assert_eq!(read_marker(dir.path(), "empty"), None);
    write_mark(dir.path(), "one", b"signal_term\n");
    assert_eq!(read_marker(dir.path(), "one").map(|m| m.word), Some("signal_term"));
    write_mark(dir.path(), "two", b"signal_hup\nsignal_segv\n");
    assert_eq!(read_marker(dir.path(), "two").map(|m| m.word), Some("signal_segv"));
    // Lines it does not know are skipped, not believed; a word cut off by the end of the file is not a word.
    write_mark(dir.path(), "junk", b"signal_int\nC:\\Users\\someone\\x\nsignal_se");
    assert_eq!(read_marker(dir.path(), "junk").map(|m| m.word), Some("signal_int"));
    write_mark(dir.path(), "binary", &[0xff, 0xfe, 0x00, b's', b'i']);
    assert_eq!(read_marker(dir.path(), "binary"), None);
  }

  #[test]
  fn a_crash_the_runtime_turns_into_an_abort_is_the_crash() {
    let dir = tempfile::tempdir().unwrap();
    // A stack that ran out is a fault on a guard page; the runtime's own handler then aborts. The abort is its consequence.
    for (content, word) in [
      (&b"signal_segv\nsignal_abrt\n"[..], "signal_segv"),
      (b"signal_bus\nsignal_abrt\n", "signal_bus"),
      (b"signal_term\nsignal_segv\nsignal_abrt\n", "signal_segv"),
      // An abort that follows nothing, or only a request to end, is an abort; a crash that came after one is the later word.
      (b"signal_abrt\n", "signal_abrt"),
      (b"signal_term\nsignal_abrt\n", "signal_abrt"),
      (b"signal_abrt\nsignal_segv\n", "signal_segv"),
    ] {
      write_mark(dir.path(), "chain", content);
      assert_eq!(read_marker(dir.path(), "chain").map(|m| m.word), Some(word), "{:?}", String::from_utf8_lossy(content));
    }
  }

  #[test]
  fn a_mark_is_dated_by_when_it_was_written() {
    let dir = tempfile::tempdir().unwrap();
    write_mark(dir.path(), "dated", b"signal_term\n");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let at = read_marker(dir.path(), "dated").unwrap().at_ms;
    assert!(at <= now + 2_000 && at + 120_000 >= now, "{at} vs {now}");
  }

  #[test]
  fn only_the_end_of_a_long_mark_is_read() {
    let dir = tempfile::tempdir().unwrap();
    let mut long = "signal_hup\n".repeat(5_000).into_bytes();
    long.extend_from_slice(b"signal_quit\n");
    write_mark(dir.path(), "long", &long);
    assert_eq!(read_marker(dir.path(), "long").map(|m| m.word), Some("signal_quit"));
  }

  const IPS: &str = "{\"app_name\":\"artdaddy\",\"timestamp\":\"2026-11-07 12:34:56.00 +0000\",\"bug_type\":\"309\",\"os_version\":\"macOS 15.1 (24B83)\"}\n{\"uptime\":1200,\"procName\":\"artdaddy\",\"procPath\":\"/Users/someone/Applications/ArtDaddy.app/Contents/MacOS/artdaddy\",\"exception\":{\"codes\":\"0x0000000000000001, 0x0000000000000000\",\"rawCodes\":[1,0],\"type\":\"EXC_BAD_ACCESS\",\"signal\":\"SIGSEGV\",\"subtype\":\"KERN_INVALID_ADDRESS at 0x0000000000000000\"},\"termination\":{\"flags\":0,\"code\":11,\"namespace\":\"SIGNAL\",\"indicator\":\"Segmentation fault: 11\"}}";
  const LEGACY: &str = "Process:               artdaddy [4242]\nPath:                  /Users/someone/Applications/ArtDaddy.app/Contents/MacOS/artdaddy\nIdentifier:            com.artdaddy.app\nException Type:        EXC_CRASH (SIGABRT)\nException Codes:       0x0000000000000000, 0x0000000000000000\n";

  #[test]
  fn a_crash_report_gives_the_kind_of_crash_and_nothing_else_of_itself() {
    assert_eq!(crash_report_word(IPS), Some("crash_bad_access"));
    assert_eq!(crash_report_word(LEGACY), Some("crash_abort"));
    for (kind, word) in [
      ("EXC_BAD_INSTRUCTION", "crash_bad_instruction"),
      ("EXC_ARITHMETIC", "crash_arithmetic"),
      ("EXC_BREAKPOINT", "crash_breakpoint"),
      ("EXC_RESOURCE", "crash_resource"),
      ("EXC_GUARD", "crash_guard"),
      ("EXC_SOMETHING_NEW", "crash_other"),
    ] {
      assert_eq!(crash_report_word(&format!("Exception Type: {kind} (SIGTRAP)")), Some(word), "{kind}");
    }
    assert_eq!(crash_report_word(""), None);
    assert_eq!(crash_report_word("nothing about exceptions here /Users/someone"), None);
    for text in [IPS, LEGACY] {
      let word = crash_report_word(text).unwrap();
      for private in ["someone", "artdaddy", "ArtDaddy", "/Users", "4242", "0x"] {
        assert!(!word.contains(private), "{word}");
      }
    }
  }

  #[test]
  fn a_crash_report_is_read_from_the_start_only() {
    let mut text = "x".repeat(70_000);
    text.push_str("Exception Type: EXC_BAD_ACCESS");
    assert_eq!(crash_report_word(&text), None);
  }

  /// Writes a report of `text` that looks as if it was written `at_ms` after 1970.
  fn put_report(dir: &Path, name: &str, text: &str, at_ms: u64) {
    let path = dir.join(name);
    std::fs::write(&path, text).unwrap();
    std::fs::File::options()
      .write(true)
      .open(&path)
      .unwrap()
      .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(at_ms))
      .unwrap();
  }

  #[test]
  fn the_first_report_of_this_app_inside_the_sessions_span_is_the_one_read() {
    let dir = tempfile::tempdir().unwrap();
    let (from, until) = (1_000_000u64, 2_000_000u64);
    assert_eq!(first_report_word(dir.path(), "artdaddy", from, until), None);
    // Other programs' reports, other kinds of file and a report of a helper with a longer name are not this app's.
    for name in ["Safari-2026-11-07-120000.ips", "artdaddy-helper-2026-11-07-120000.ips", "artdaddy-2026-11-07-120000.diag", "artdaddy.ips"] {
      put_report(dir.path(), name, "Exception Type: EXC_GUARD", 1_500_000);
    }
    assert_eq!(first_report_word(dir.path(), "artdaddy", from, until), None, "only artdaddy-<time>.ips or .crash count");
    // A report from before the session started is an earlier run's crash; one from after it ended is a later run's: with only
    // those about, there is no report of this session.
    put_report(dir.path(), "artdaddy-2026-11-07-100000.ips", "Exception Type: EXC_RESOURCE", from - 1);
    put_report(dir.path(), "artdaddy-2026-11-07-130000.ips", "Exception Type: EXC_ARITHMETIC", until + 1);
    assert_eq!(first_report_word(dir.path(), "artdaddy", from, until), None);
    put_report(dir.path(), "artdaddy-2026-11-07-120000.crash", "Exception Type: EXC_BAD_INSTRUCTION", 1_500_000);
    assert_eq!(first_report_word(dir.path(), "artdaddy", from, until), Some("crash_bad_instruction"));
    assert_eq!(first_report_word(dir.path(), "artdaddy.exe", from, until), Some("crash_bad_instruction"));
    // Both ends of the span are inside it.
    put_report(dir.path(), "artdaddy-2026-11-07-110000.ips", "Exception Type: EXC_BREAKPOINT", until);
    assert_eq!(first_report_word(dir.path(), "artdaddy", from, until), Some("crash_bad_instruction"));
    put_report(dir.path(), "artdaddy-2026-11-07-110500.ips", "Exception Type: EXC_GUARD", from);
    // With several inside the span, the first: the later ones are of runs after this one.
    assert_eq!(first_report_word(dir.path(), "artdaddy", from, until), Some("crash_guard"));
    assert_eq!(first_report_word(Path::new("/no/such/folder"), "artdaddy", from, until), None);
  }

  #[test]
  fn two_starts_of_the_pc_are_compared_only_when_both_are_known() {
    assert_eq!(boot_changed("a", "a"), Some(false));
    assert_eq!(boot_changed("a", "b"), Some(true));
    assert_eq!(boot_changed("", "b"), None);
    assert_eq!(boot_changed("a", ""), None);
    assert_eq!(boot_changed("", ""), None);
  }

  #[cfg(any(target_os = "linux", target_os = "macos"))]
  #[test]
  fn this_pc_knows_which_start_it_is_and_says_the_same_twice() {
    let first = current_boot_id();
    assert!(!first.is_empty() && first.len() <= 64);
    assert_eq!(first, current_boot_id());
  }

  #[test]
  fn the_whole_lookup_reads_the_mark_and_the_panic_of_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let session = |launch: &str, panic_at: Option<u64>| EndSession {
      started_at: 0,
      alive_at: 1,
      detected_at: 2,
      launch_id: launch.to_string(),
      boot_id: String::new(),
      panic_at,
      dir: dir.path().to_path_buf(),
    };
    write_mark(dir.path(), "crashed", b"signal_segv\n");
    // The mark was just written, so it is not older than the session's last sign of life (alive_at is long ago).
    assert_eq!(lookup(&session("crashed", None), "artdaddy"), "signal_segv");
    assert_eq!(lookup(&session("vanished", Some(2)), "artdaddy"), "panic");
    // No mark, no panic, and no start of the PC to compare: it says it does not know rather than guess.
    assert_eq!(lookup(&session("vanished", None), "artdaddy"), "unknown");
  }
}
