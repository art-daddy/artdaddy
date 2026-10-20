use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
use std::os::windows::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const MAX_PEERS: usize = 8;
const MAX_COMMANDS: u64 = 512;
const MAX_LINE: usize = 4096;
const POLL: Duration = Duration::from_millis(100);
const FILE_SHARE_READ: u32 = 1;
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x00200000;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 2;

#[link(name = "bcrypt")]
extern "system" {
  fn BCryptGenRandom(
    algorithm: *mut std::ffi::c_void,
    buffer: *mut u8,
    size: u32,
    flags: u32,
  ) -> i32;
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct Statistics {
  pub cap: u64,
  pub high_water: u64,
  pub written: u64,
  pub uploads: u64,
  pub completed_uploads: u64,
  pub readbacks: u64,
  pub rejected: u64,
  pub peers: usize,
  pub tasks: usize,
  pub file_open: bool,
}

struct Shared {
  file: Mutex<Option<File>>,
  cap: u64,
  deadline: Instant,
  closing: AtomicBool,
  cancelled: AtomicBool,
  error: Mutex<Option<String>>,
  peers: Mutex<HashMap<u64, TcpStream>>,
  next_peer: AtomicU64,
  commands: AtomicU64,
  tasks: Mutex<usize>,
  settled: Condvar,
  high_water: AtomicU64,
  written: AtomicU64,
  uploads: AtomicU64,
  completed_uploads: AtomicU64,
  readbacks: AtomicU64,
  rejected: AtomicU64,
}

enum PeerError {
  Capacity,
  Failed(String),
}

impl Shared {
  fn check(&self) -> Result<(), String> {
    if self.cancelled.load(Ordering::Acquire) {
      return Err("native output sink was cancelled".into());
    }
    if Instant::now() >= self.deadline {
      return Err("native output sink execution deadline expired".into());
    }
    Ok(())
  }

  fn fail(&self, error: String) {
    let mut first = self.error.lock().unwrap_or_else(|error| error.into_inner());
    if first.is_none() {
      *first = Some(error);
    }
    drop(first);
    self.cancel();
  }

  fn cancel(&self) {
    self.cancelled.store(true, Ordering::Release);
    let peers = self.peers.lock().unwrap_or_else(|error| error.into_inner());
    for socket in peers.values() {
      if let Err(error) = socket.shutdown(Shutdown::Both) {
        if !matches!(
          error.kind(),
          io::ErrorKind::NotConnected
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
        ) {
          let mut first = self.error.lock().unwrap_or_else(|error| error.into_inner());
          if first.is_none() {
            *first = Some(format!("native output socket shutdown failed: {error}"));
          }
        }
      }
    }
  }

  fn register(self: &Arc<Self>, socket: TcpStream) -> Result<Peer, PeerError> {
    self.check().map_err(PeerError::Failed)?;
    if socket
      .peer_addr()
      .map_err(|error| PeerError::Failed(error.to_string()))?
      .ip()
      != Ipv4Addr::LOCALHOST
    {
      return Err(PeerError::Failed(
        "native output refused a non-loopback peer".into(),
      ));
    }
    socket
      .set_read_timeout(Some(POLL))
      .map_err(|error| PeerError::Failed(error.to_string()))?;
    socket
      .set_write_timeout(Some(POLL))
      .map_err(|error| PeerError::Failed(error.to_string()))?;
    socket
      .set_nodelay(true)
      .map_err(|error| PeerError::Failed(error.to_string()))?;
    let mut peers = self.peers.lock().unwrap_or_else(|error| error.into_inner());
    if peers.len() >= MAX_PEERS {
      return Err(PeerError::Capacity);
    }
    let id = self.next_peer.fetch_add(1, Ordering::Relaxed);
    peers.insert(
      id,
      socket
        .try_clone()
        .map_err(|error| PeerError::Failed(error.to_string()))?,
    );
    Ok(Peer {
      socket,
      id,
      shared: self.clone(),
    })
  }

  fn task(self: &Arc<Self>) -> Task {
    *self.tasks.lock().unwrap_or_else(|error| error.into_inner()) += 1;
    Task(self.clone())
  }

  fn wait_tasks(&self) {
    let mut tasks = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
    while *tasks != 0 {
      tasks = self
        .settled
        .wait(tasks)
        .unwrap_or_else(|error| error.into_inner());
    }
  }

  fn extent(&self) -> Result<u64, String> {
    let file = self.file.lock().unwrap_or_else(|error| error.into_inner());
    file
      .as_ref()
      .ok_or("native output file is closed")?
      .metadata()
      .map(|metadata| metadata.len())
      .map_err(|error| error.to_string())
  }

  fn write_at(&self, bytes: &[u8], mut offset: u64) -> Result<(), String> {
    let file = self.file.lock().unwrap_or_else(|error| error.into_inner());
    let file = file.as_ref().ok_or("native output file is closed")?;
    let mut remaining = bytes;
    while !remaining.is_empty() {
      self.check()?;
      if offset > self.cap || remaining.len() as u64 > self.cap - offset {
        return Err(format!(
          "native output capacity exceeded: offset={offset}, bytes={}, cap={}",
          remaining.len(),
          self.cap
        ));
      }
      let written = file
        .seek_write(remaining, offset)
        .map_err(|error| format!("native output write failed: {error}"))?;
      if written == 0 {
        return Err("native output write made no progress".into());
      }
      offset += written as u64;
      self.written.fetch_add(written as u64, Ordering::Relaxed);
      self.high_water.fetch_max(offset, Ordering::Relaxed);
      remaining = &remaining[written..];
    }
    Ok(())
  }

  fn read_at(&self, bytes: &mut [u8], offset: u64) -> Result<usize, String> {
    let file = self.file.lock().unwrap_or_else(|error| error.into_inner());
    self.check()?;
    file
      .as_ref()
      .ok_or("native output file is closed")?
      .seek_read(bytes, offset)
      .map_err(|error| format!("native output readback failed: {error}"))
  }

  fn statistics(&self) -> Statistics {
    Statistics {
      cap: self.cap,
      high_water: self.high_water.load(Ordering::Acquire),
      written: self.written.load(Ordering::Acquire),
      uploads: self.uploads.load(Ordering::Acquire),
      completed_uploads: self.completed_uploads.load(Ordering::Acquire),
      readbacks: self.readbacks.load(Ordering::Acquire),
      rejected: self.rejected.load(Ordering::Acquire),
      peers: self
        .peers
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .len(),
      tasks: *self.tasks.lock().unwrap_or_else(|error| error.into_inner()),
      file_open: self
        .file
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .is_some(),
    }
  }
}

struct Peer {
  socket: TcpStream,
  id: u64,
  shared: Arc<Shared>,
}

impl Drop for Peer {
  fn drop(&mut self) {
    self
      .shared
      .peers
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .remove(&self.id);
  }
}

struct Task(Arc<Shared>);
impl Drop for Task {
  fn drop(&mut self) {
    let mut tasks = self
      .0
      .tasks
      .lock()
      .unwrap_or_else(|error| error.into_inner());
    *tasks -= 1;
    self.0.settled.notify_all();
  }
}

fn timeout(error: &io::Error) -> bool {
  matches!(
    error.kind(),
    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
  )
}

fn peer_closed(error: &io::Error) -> bool {
  matches!(
    error.kind(),
    io::ErrorKind::ConnectionReset
      | io::ErrorKind::ConnectionAborted
      | io::ErrorKind::BrokenPipe
      | io::ErrorKind::NotConnected
      | io::ErrorKind::UnexpectedEof
  )
}

#[derive(Clone, Copy, PartialEq)]
enum Delivery {
  Sent,
  Closed,
}

struct Replies {
  socket: Mutex<TcpStream>,
}

impl Replies {
  fn send(&self, code: u16, text: &str) -> Result<Delivery, String> {
    self.write(format!("{code} {text}\r\n").as_bytes())
  }

  fn write(&self, bytes: &[u8]) -> Result<Delivery, String> {
    let mut socket = self
      .socket
      .lock()
      .unwrap_or_else(|error| error.into_inner());
    match socket.write_all(bytes) {
      Ok(()) => Ok(Delivery::Sent),
      Err(error) if peer_closed(&error) => Ok(Delivery::Closed),
      Err(error) => Err(format!("native output control reply failed: {error}")),
    }
  }
}

struct Lines {
  pending: Vec<u8>,
}

enum Line {
  Command(String),
  Closed,
  Rejected,
}

impl Lines {
  fn next(&mut self, socket: &mut TcpStream, shared: &Shared) -> Result<Line, String> {
    loop {
      if let Some(end) = self.pending.windows(2).position(|bytes| bytes == b"\r\n") {
        let valid = end <= MAX_LINE
          && self.pending[..end]
            .iter()
            .all(|byte| (32..=126).contains(byte));
        let bytes = self.pending.drain(..end + 2).collect::<Vec<_>>();
        if !valid {
          return Ok(Line::Rejected);
        }
        return String::from_utf8(bytes[..end].to_vec())
          .map(Line::Command)
          .map_err(|error| error.to_string());
      }
      if self.pending.len() > MAX_LINE {
        return Ok(Line::Rejected);
      }
      shared.check()?;
      let mut bytes = [0u8; 1024];
      match socket.read(&mut bytes) {
        Ok(0) => {
          return Ok(if self.pending.is_empty() {
            Line::Closed
          } else {
            Line::Rejected
          })
        }
        Ok(count) => self.pending.extend_from_slice(&bytes[..count]),
        Err(error) if timeout(&error) => {
          if shared.closing.load(Ordering::Acquire) {
            return Ok(if self.pending.is_empty() {
              Line::Closed
            } else {
              Line::Rejected
            });
          }
        }
        Err(error) if peer_closed(&error) => return Ok(Line::Closed),
        Err(error) => return Err(format!("native output control read failed: {error}")),
      }
    }
  }
}

fn virtual_file(value: &str) -> bool {
  matches!(value, "output.mp4" | "/output.mp4")
}

fn offset(value: &str, cap: u64) -> Option<u64> {
  if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
    return None;
  }
  value.parse::<u64>().ok().filter(|offset| *offset <= cap)
}

fn authenticated(value: &str, expected: &str) -> bool {
  if value.len() != expected.len() {
    return false;
  }
  value
    .bytes()
    .zip(expected.bytes())
    .fold(0, |different, (left, right)| different | (left ^ right))
    == 0
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
  Upload,
  Readback,
}

#[derive(Default)]
struct End {
  abort_requested: bool,
  terminal: bool,
}

struct Transfer {
  kind: Kind,
  abort: Arc<AtomicBool>,
  end: Arc<Mutex<End>>,
  socket: TcpStream,
  worker: JoinHandle<Result<(), String>>,
}

impl Transfer {
  fn finish(self, abort: bool, replies: &Replies) -> Result<(), String> {
    let terminal_before_abort = {
      let mut end = self.end.lock().unwrap_or_else(|error| error.into_inner());
      let terminal = end.terminal;
      if abort {
        end.abort_requested = true;
      }
      terminal
    };
    if abort && self.kind == Kind::Readback {
      self.abort.store(true, Ordering::Release);
      if let Err(error) = self.socket.shutdown(Shutdown::Both) {
        if !peer_closed(&error) {
          return Err(format!("native output readback abort failed: {error}"));
        }
      }
    }
    let ended = self
      .worker
      .join()
      .map_err(|_| "native output transfer thread panicked".to_string())?;
    if ended.is_ok() && abort && terminal_before_abort {
      replies.send(225, "Data transfer aborted")?;
    }
    ended
  }
}

fn upload(socket: &mut TcpStream, shared: &Shared, mut offset: u64) -> Result<(), String> {
  let mut bytes = [0u8; 65536];
  loop {
    shared.check()?;
    match socket.read(&mut bytes) {
      Ok(0) => {
        if let Err(error) = socket.shutdown(Shutdown::Write) {
          if !peer_closed(&error) {
            return Err(format!(
              "native output upload EOF acknowledgement failed: {error}"
            ));
          }
        }
        shared.completed_uploads.fetch_add(1, Ordering::Release);
        return Ok(());
      }
      Ok(count) => {
        shared.write_at(&bytes[..count], offset)?;
        offset += count as u64;
      }
      Err(error) if timeout(&error) && !shared.closing.load(Ordering::Acquire) => {}
      Err(error) => return Err(format!("native output upload ended without EOF: {error}")),
    }
  }
}

fn readback(
  socket: &mut TcpStream,
  shared: &Shared,
  mut offset: u64,
  end: u64,
  abort: &AtomicBool,
) -> Result<(), String> {
  let mut bytes = [0u8; 65536];
  while offset < end && !abort.load(Ordering::Acquire) {
    let count = (end - offset).min(bytes.len() as u64) as usize;
    let count = shared.read_at(&mut bytes[..count], offset)?;
    if count == 0 {
      return Err("native output readback ended before its admitted extent".into());
    }
    let mut remaining = &bytes[..count];
    while !remaining.is_empty() && !abort.load(Ordering::Acquire) {
      shared.check()?;
      match socket.write(remaining) {
        Ok(0) => return Err("native output readback write made no progress".into()),
        Ok(count) => remaining = &remaining[count..],
        Err(error) if timeout(&error) && !shared.closing.load(Ordering::Acquire) => {}
        Err(_) if abort.load(Ordering::Acquire) => return Ok(()),
        Err(error) => return Err(format!("native output readback transport failed: {error}")),
      }
    }
    offset += count as u64;
  }
  if !abort.load(Ordering::Acquire) {
    socket
      .shutdown(Shutdown::Write)
      .map_err(|error| format!("native output readback EOF failed: {error}"))?;
  }
  Ok(())
}

fn start_transfer(
  listener: TcpListener,
  kind: Kind,
  offset: u64,
  shared: &Arc<Shared>,
  replies: &Arc<Replies>,
) -> Result<Transfer, String> {
  let mut peer = loop {
    shared.check()?;
    if shared.closing.load(Ordering::Acquire) {
      return Err("native output transfer started after producer settlement".into());
    }
    match listener.accept() {
      Ok((socket, _)) => {
        break shared.register(socket).map_err(|error| match error {
          PeerError::Capacity => "native output data peer capacity exceeded".into(),
          PeerError::Failed(error) => error,
        })?
      }
      Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
        thread::sleep(Duration::from_millis(5))
      }
      Err(error) => return Err(format!("native output data accept failed: {error}")),
    }
  };
  let extent = if kind == Kind::Readback {
    shared.extent()?
  } else {
    0
  };
  if replies.send(150, "Opening bounded data channel")? == Delivery::Closed {
    return Err("native output control closed before data admission".into());
  }
  let socket = peer.socket.try_clone().map_err(|error| error.to_string())?;
  let end = Arc::new(Mutex::new(End::default()));
  let abort = Arc::new(AtomicBool::new(false));
  let state = shared.clone();
  let reply = replies.clone();
  let terminal = end.clone();
  let aborted = abort.clone();
  if kind == Kind::Upload {
    shared.uploads.fetch_add(1, Ordering::Release);
  } else {
    shared.readbacks.fetch_add(1, Ordering::Release);
  }
  let task = shared.task();
  let worker = thread::Builder::new()
    .name("native-output-data".into())
    .spawn(move || {
      let _task = task;
      let result = if kind == Kind::Upload {
        upload(&mut peer.socket, &state, offset)
      } else {
        readback(&mut peer.socket, &state, offset, extent, &aborted)
      };
      if let Err(error) = &result {
        state.fail(error.clone());
        return result;
      }
      let mut end = terminal.lock().unwrap_or_else(|error| error.into_inner());
      let sent = reply.send(
        if end.abort_requested { 225 } else { 226 },
        "Transfer complete",
      );
      end.terminal = true;
      sent.map(|_| ())
    })
    .map_err(|error| format!("could not start native output data owner: {error}"))?;
  Ok(Transfer {
    kind,
    abort,
    end,
    socket,
    worker,
  })
}

fn control(mut peer: Peer, shared: &Arc<Shared>, password: &str) -> Result<(), String> {
  let replies = Arc::new(Replies {
    socket: Mutex::new(peer.socket.try_clone().map_err(|error| error.to_string())?),
  });
  if replies.send(220, "Native single-file output")? == Delivery::Closed {
    return Ok(());
  }
  let mut lines = Lines {
    pending: Vec::new(),
  };
  let mut user = false;
  let mut allowed = false;
  let mut restart = 0;
  let mut passive = None;
  let mut transfer: Option<Transfer> = None;
  let result = (|| loop {
    let line = match lines.next(&mut peer.socket, shared)? {
      Line::Closed => return Ok(()),
      Line::Rejected => {
        shared.rejected.fetch_add(1, Ordering::Relaxed);
        replies.send(500, "Invalid bounded control frame")?;
        return Ok(());
      }
      Line::Command(line) => line,
    };
    if shared.commands.fetch_add(1, Ordering::Relaxed) >= MAX_COMMANDS {
      shared.rejected.fetch_add(1, Ordering::Relaxed);
      replies.send(421, "Native output command capacity exceeded")?;
      return Ok(());
    }
    let (verb, value) = line.split_once(' ').unwrap_or((&line, ""));
    let verb = verb.to_ascii_uppercase();
    let (code, message): (u16, String) = match verb.as_str() {
      "USER" => {
        allowed = false;
        user = value == "export";
        (if user { 331 } else { 530 }, "User status".into())
      }
      "PASS" => {
        allowed = user && authenticated(value, password);
        (
          if allowed { 230 } else { 530 },
          "Authentication status".into(),
        )
      }
      _ if !allowed => {
        shared.rejected.fetch_add(1, Ordering::Relaxed);
        (530, "Authentication required".into())
      }
      "TYPE" => (
        if value == "I" { 200 } else { 504 },
        "Binary transfer required".into(),
      ),
      "FEAT" => {
        if replies.write(b"211-Features\r\n SIZE\r\n REST STREAM\r\n211 End\r\n")?
          == Delivery::Closed
        {
          return Ok(());
        }
        continue;
      }
      "PWD" => (257, "\"/\"".into()),
      "CWD" => (
        if value == "/" { 250 } else { 550 },
        "Virtual root only".into(),
      ),
      "SYST" => (215, "UNIX Type: L8".into()),
      "SIZE" if virtual_file(value) => (213, shared.extent()?.to_string()),
      "SIZE" => (550, "Unknown virtual file".into()),
      "REST" => match offset(value, shared.cap) {
        Some(offset) => {
          restart = offset;
          (350, "Bounded restart accepted".into())
        }
        None => {
          shared.rejected.fetch_add(1, Ordering::Relaxed);
          (501, "Invalid bounded offset".into())
        }
      },
      "EPSV" | "PASV" => {
        if passive.is_some() {
          passive.take();
        }
        let listener =
          TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|error| error.to_string())?;
        listener
          .set_nonblocking(true)
          .map_err(|error| error.to_string())?;
        let port = listener
          .local_addr()
          .map_err(|error| error.to_string())?
          .port();
        passive = Some(listener);
        if verb == "EPSV" {
          (229, format!("Entering Extended Passive Mode (|||{port}|)"))
        } else {
          (
            227,
            format!(
              "Entering Passive Mode (127,0,0,1,{},{})",
              port >> 8,
              port & 255
            ),
          )
        }
      }
      "STOR" | "RETR" => {
        if !virtual_file(value) || passive.is_none() {
          passive.take();
          shared.rejected.fetch_add(1, Ordering::Relaxed);
          (550, "Unknown virtual file or missing data channel".into())
        } else {
          if let Some(previous) = transfer.take() {
            previous.finish(false, &replies)?;
          }
          let listener = passive
            .take()
            .ok_or("native output data admission was lost")?;
          let kind = if verb == "STOR" {
            Kind::Upload
          } else {
            Kind::Readback
          };
          transfer = Some(start_transfer(listener, kind, restart, shared, &replies)?);
          restart = 0;
          continue;
        }
      }
      "ABOR" => {
        if let Some(previous) = transfer.take() {
          previous.finish(true, &replies)?;
          continue;
        }
        (225, "Data transfer aborted".into())
      }
      "QUIT" => {
        replies.send(221, "Done")?;
        return Ok(());
      }
      _ => {
        shared.rejected.fetch_add(1, Ordering::Relaxed);
        (502, "Command not supported".into())
      }
    };
    if replies.send(code, &message)? == Delivery::Closed {
      return Ok(());
    }
  })();
  drop(passive);
  let settled = match transfer {
    Some(transfer) => transfer.finish(false, &replies),
    None => Ok(()),
  };
  result.and(settled)
}

fn run(listener: TcpListener, shared: Arc<Shared>, password: String) {
  let mut workers: Vec<JoinHandle<()>> = Vec::new();
  while !shared.closing.load(Ordering::Acquire) && !shared.cancelled.load(Ordering::Acquire) {
    if let Err(error) = shared.check() {
      shared.fail(error);
      break;
    }
    let mut index = 0;
    while index < workers.len() {
      if workers[index].is_finished() {
        if workers.swap_remove(index).join().is_err() {
          shared.fail("native output control thread panicked".into());
        }
      } else {
        index += 1;
      }
    }
    match listener.accept() {
      Ok((socket, _)) => {
        let peer = match shared.register(socket) {
          Ok(peer) => peer,
          Err(PeerError::Capacity) => {
            shared.rejected.fetch_add(1, Ordering::Relaxed);
            continue;
          }
          Err(PeerError::Failed(error)) => {
            shared.fail(error);
            continue;
          }
        };
        let state = shared.clone();
        let credential = password.clone();
        let task = shared.task();
        match thread::Builder::new()
          .name("native-output-control".into())
          .spawn(move || {
            let _task = task;
            if let Err(error) = control(peer, &state, &credential) {
              state.fail(error);
            }
          }) {
          Ok(worker) => workers.push(worker),
          Err(error) => shared.fail(format!(
            "could not start native output control owner: {error}"
          )),
        }
      }
      Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
        thread::sleep(Duration::from_millis(5))
      }
      Err(error) => {
        shared.fail(format!("native output accept failed: {error}"));
        break;
      }
    }
  }
  drop(listener);
  for worker in workers {
    if worker.join().is_err() {
      shared.fail("native output control thread panicked".into());
    }
  }
}

pub(super) struct Broker {
  shared: Arc<Shared>,
  worker: Option<JoinHandle<()>>,
  password: String,
  url: String,
}

impl Broker {
  pub(super) fn open(path: &Path, cap: u64, deadline: Instant) -> Result<Self, String> {
    if cap == 0 || cap > i64::MAX as u64 || Instant::now() >= deadline {
      return Err("native output sink has no live bounded admission".into());
    }
    let mut random = [0u8; 32];
    let status = unsafe {
      BCryptGenRandom(
        std::ptr::null_mut(),
        random.as_mut_ptr(),
        random.len() as u32,
        BCRYPT_USE_SYSTEM_PREFERRED_RNG,
      )
    };
    if status < 0 {
      return Err(format!(
        "native output capability generation failed: NTSTATUS {status:#x}"
      ));
    }
    let password = random
      .iter()
      .map(|byte| format!("{byte:02x}"))
      .collect::<String>();
    let listener =
      TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|error| error.to_string())?;
    listener
      .set_nonblocking(true)
      .map_err(|error| error.to_string())?;
    let port = listener
      .local_addr()
      .map_err(|error| error.to_string())?
      .port();
    // No write/delete sharing and no inherited file handle: FFmpeg can only reach the capped sink.
    let file = OpenOptions::new()
      .read(true)
      .write(true)
      .share_mode(FILE_SHARE_READ)
      .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
      .open(path)
      .map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
      return Err("native output sink requires an existing regular non-reparse file".into());
    }
    if Instant::now() >= deadline {
      return Err("native output sink expired before file preparation".into());
    }
    file.set_len(0).map_err(|error| error.to_string())?;
    let shared = Arc::new(Shared {
      file: Mutex::new(Some(file)),
      cap,
      deadline,
      closing: AtomicBool::new(false),
      cancelled: AtomicBool::new(false),
      error: Mutex::new(None),
      peers: Mutex::new(HashMap::new()),
      next_peer: AtomicU64::new(0),
      commands: AtomicU64::new(0),
      tasks: Mutex::new(0),
      settled: Condvar::new(),
      high_water: AtomicU64::new(0),
      written: AtomicU64::new(0),
      uploads: AtomicU64::new(0),
      completed_uploads: AtomicU64::new(0),
      readbacks: AtomicU64::new(0),
      rejected: AtomicU64::new(0),
    });
    let state = shared.clone();
    let credential = password.clone();
    let worker = thread::Builder::new()
      .name("native-output-sink".into())
      .spawn(move || run(listener, state, credential))
      .map_err(|error| format!("could not start native output owner: {error}"))?;
    Ok(Self {
      shared,
      worker: Some(worker),
      url: format!("ftp://export:{password}@127.0.0.1:{port}/output.mp4"),
      password,
    })
  }

  pub(super) fn url(&self) -> &str {
    &self.url
  }
  pub(super) fn password(&self) -> &str {
    &self.password
  }
  pub(super) fn cancel(&self) {
    self.shared.cancel();
  }
  pub(super) fn statistics(&self) -> Statistics {
    self.shared.statistics()
  }

  pub(super) fn finish(&mut self, complete: bool) -> Result<(), String> {
    self.shared.closing.store(true, Ordering::Release);
    if !complete {
      self.cancel();
    }
    if let Some(worker) = self.worker.take() {
      if worker.join().is_err() {
        self.shared.fail("native output sink owner panicked".into());
      }
    }
    self.shared.wait_tasks();
    if complete && self.shared.uploads.load(Ordering::Acquire) == 0 {
      self
        .shared
        .fail("native output producer completed without an accepted upload".into());
    }
    if self.shared.uploads.load(Ordering::Acquire)
      != self.shared.completed_uploads.load(Ordering::Acquire)
    {
      self
        .shared
        .fail("native output has an accepted upload without confirmed EOF".into());
    }
    let file = self
      .shared
      .file
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .take();
    if let Some(file) = file {
      if complete {
        if let Err(error) = file.sync_all() {
          self
            .shared
            .fail(format!("native output flush failed: {error}"));
        }
      }
      drop(file);
    }
    if let Some(error) = self
      .shared
      .error
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .as_ref()
    {
      return Err(error.clone());
    }
    if !complete || self.shared.cancelled.load(Ordering::Acquire) {
      return Err("native output sink did not complete".into());
    }
    Ok(())
  }
}

impl Drop for Broker {
  fn drop(&mut self) {
    if self.worker.is_some() {
      if let Err(error) = self.finish(false) {
        eprintln!("abandoned native output sink stopped: {error}");
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::{BufRead, BufReader};

  fn sink(cap: u64) -> (tempfile::TempDir, std::path::PathBuf, Broker) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("pending.mp4");
    File::create(&path).unwrap();
    let broker = Broker::open(&path, cap, Instant::now() + Duration::from_secs(30)).unwrap();
    (directory, path, broker)
  }

  fn response(control: &mut BufReader<TcpStream>) -> String {
    let mut line = String::new();
    assert!(control.read_line(&mut line).unwrap() > 0);
    line
  }

  fn request(control: &mut BufReader<TcpStream>, value: &str, code: u16) -> String {
    control
      .get_mut()
      .write_all(format!("{value}\r\n").as_bytes())
      .unwrap();
    let line = response(control);
    assert!(
      line.starts_with(&format!("{code} ")),
      "{}",
      line.replace("\r\n", "")
    );
    line
  }

  fn upload_peer(broker: &Broker) -> (BufReader<TcpStream>, TcpStream) {
    let address = broker
      .url
      .rsplit_once('@')
      .unwrap()
      .1
      .split('/')
      .next()
      .unwrap();
    let socket = TcpStream::connect(address).unwrap();
    socket
      .set_read_timeout(Some(Duration::from_secs(2)))
      .unwrap();
    socket.set_nodelay(true).unwrap();
    let mut control = BufReader::new(socket);
    assert!(response(&mut control).starts_with("220 "));
    request(&mut control, "USER export", 331);
    request(&mut control, &format!("PASS {}", broker.password), 230);
    let passive = request(&mut control, "EPSV", 229);
    let port = passive
      .split("|||")
      .nth(1)
      .unwrap()
      .split('|')
      .next()
      .unwrap()
      .parse::<u16>()
      .unwrap();
    let data = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
    data.set_nodelay(true).unwrap();
    request(&mut control, "STOR /output.mp4", 150);
    (control, data)
  }

  #[test]
  fn native_commits_preserve_every_valid_overwrite_and_refuse_every_out_of_extent_write() {
    let (_directory, path, mut broker) = sink(32);
    let mut expected = Vec::new();
    for offset in (0..=64).chain([u64::MAX]) {
      for size in 1..=64 {
        let before = std::fs::read(&path).unwrap();
        let payload = (0..size)
          .map(|index| (index as u8).wrapping_add(offset as u8))
          .collect::<Vec<_>>();
        let wrote = broker.shared.write_at(&payload, offset);
        let admitted = offset.checked_add(size).is_some_and(|end| end <= 32);
        if admitted {
          wrote.unwrap();
          expected.resize(expected.len().max((offset + size) as usize), 0);
          expected[offset as usize..(offset + size) as usize].copy_from_slice(&payload);
          assert_eq!(std::fs::read(&path).unwrap(), expected);
        } else {
          assert!(wrote.is_err());
          assert_eq!(std::fs::read(&path).unwrap(), before);
        }
        assert!(std::fs::metadata(&path).unwrap().len() <= 32);
      }
    }
    assert!(broker.finish(false).is_err());
    let statistics = broker.statistics();
    assert!(statistics.written > statistics.cap);
    assert_eq!(statistics.high_water, 32);
    assert_eq!(
      (statistics.peers, statistics.tasks, statistics.file_open),
      (0, 0, false)
    );
  }

  #[test]
  fn control_eof_before_upload_eof_drains_bytes_before_success_and_closes_every_owner() {
    let (_directory, path, mut broker) = sink(65536);
    let (control, mut data) = upload_peer(&broker);
    control.get_ref().shutdown(Shutdown::Both).unwrap();
    drop(control);
    let bytes = (0..16384).map(|index| index as u8).collect::<Vec<_>>();
    data.write_all(&bytes).unwrap();
    data.shutdown(Shutdown::Write).unwrap();
    broker.finish(true).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    let statistics = broker.statistics();
    assert_eq!((statistics.uploads, statistics.completed_uploads), (1, 1));
    assert_eq!(
      (statistics.peers, statistics.tasks, statistics.file_open),
      (0, 0, false)
    );
    std::fs::rename(&path, path.with_extension("settled")).unwrap();
  }

  #[test]
  fn producer_success_cannot_settle_an_upload_that_never_received_eof() {
    let (_directory, path, mut broker) = sink(65536);
    let (control, mut data) = upload_peer(&broker);
    data.write_all(&[0x5a; 1024]).unwrap();
    control.get_ref().shutdown(Shutdown::Both).unwrap();
    drop(control);
    let error = broker.finish(true).unwrap_err();
    assert!(error.contains("without EOF"), "{error}");
    assert!(std::fs::metadata(&path).unwrap().len() <= 65536);
    let statistics = broker.statistics();
    assert_eq!((statistics.uploads, statistics.completed_uploads), (1, 0));
    assert_eq!(
      (statistics.peers, statistics.tasks, statistics.file_open),
      (0, 0, false)
    );
    std::fs::remove_file(&path).unwrap();
  }

  #[test]
  fn cancelled_authority_refuses_the_commit_even_when_the_writer_does_not_cooperate() {
    let (_directory, path, mut broker) = sink(65536);
    let (control, mut data) = upload_peer(&broker);
    let initial = [0x41; 1024];
    data.write_all(&initial).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while std::fs::metadata(&path).unwrap().len() < initial.len() as u64 {
      assert!(
        Instant::now() < deadline,
        "first admitted upload never reached the actual file"
      );
      thread::sleep(Duration::from_millis(1));
    }
    broker.cancel();
    if let Err(error) = data.write_all(&[0x42; 1024]) {
      assert!(peer_closed(&error), "{error}");
    }
    assert!(broker.shared.write_at(&[0x43; 1024], 0).is_err());
    drop(control);
    assert!(broker.finish(true).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), initial);
    let statistics = broker.statistics();
    assert_eq!(
      (statistics.peers, statistics.tasks, statistics.file_open),
      (0, 0, false)
    );
  }
}
