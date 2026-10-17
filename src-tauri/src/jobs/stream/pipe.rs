use std::io::{self, Read};
use std::path::Path;

#[cfg(unix)]
mod platform {
  use super::*;
  use std::io::Write;
  use std::fs::{File, OpenOptions};
  use std::os::fd::AsRawFd;
  use std::os::unix::{fs::OpenOptionsExt, net::UnixStream};
  use std::os::unix::ffi::OsStrExt;

  pub struct Wake { input: UnixStream, output: UnixStream }

  impl Wake {
    pub fn new() -> io::Result<Self> {
      let (input, output) = UnixStream::pair()?;
      Ok(Self { input, output })
    }

    pub fn signal(&self) { let _ = (&self.output).write_all(&[1]); }
  }

  pub struct Pipe { file: File, path: String }

  impl Pipe {
    pub fn new(root: &Path, index: usize) -> io::Result<Self> {
      let path = root.join(format!("part{index}.nut"));
      let name = std::ffi::CString::new(path.as_os_str().as_bytes())?;
      if unsafe { libc::mkfifo(name.as_ptr(), 0o600) } != 0 { return Err(io::Error::last_os_error()); }
      let file = OpenOptions::new().read(true).write(true).custom_flags(libc::O_NONBLOCK).open(&path)?;
      Ok(Self { file, path: format!("file:{}", path.to_string_lossy()) })
    }

    pub fn path(&self) -> &str { &self.path }

    pub fn copy(mut self, source: &mut impl Read, wake: &Wake) -> io::Result<()> {
      let mut buffer = [0u8; 65536];
      loop {
        let count = source.read(&mut buffer)?;
        if count == 0 { return Ok(()); }
        let mut remaining = &buffer[..count];
        while !remaining.is_empty() {
          let mut descriptors = [libc::pollfd { fd: wake.input.as_raw_fd(), events: libc::POLLIN, revents: 0 },
            libc::pollfd { fd: self.file.as_raw_fd(), events: libc::POLLOUT, revents: 0 }];
          let ready = unsafe { libc::poll(descriptors.as_mut_ptr(), descriptors.len() as _, -1) };
          if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted { continue; }
            return Err(error);
          }
          if descriptors[0].revents != 0 { return Err(io::Error::new(io::ErrorKind::Interrupted, "streaming pipe cancelled")); }
          match self.file.write(remaining) {
            Ok(0) => return Err(io::Error::new(io::ErrorKind::WriteZero, "streaming pipe made no progress")),
            Ok(count) => remaining = &remaining[count..],
            Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) => {},
            Err(error) => return Err(error),
          }
        }
      }
    }
  }
}

#[cfg(windows)]
mod platform {
  use super::*;
  use std::ffi::c_void;
  use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};

  #[repr(C)]
  struct Security { length: u32, descriptor: *mut c_void, inherit: i32 }

  #[repr(C)]
  struct Overlapped { internal: usize, internal_high: usize, offset: u32, offset_high: u32, event: RawHandle }

  #[link(name = "kernel32")]
  extern "system" {
    fn CreateEventW(security: *const c_void, manual: i32, initial: i32, name: *const u16) -> RawHandle;
    fn SetEvent(event: RawHandle) -> i32;
    fn CreateNamedPipeW(name: *const u16, access: u32, mode: u32, instances: u32, output: u32,
      input: u32, timeout: u32, security: *const Security) -> RawHandle;
    fn ConnectNamedPipe(pipe: RawHandle, operation: *mut Overlapped) -> i32;
    fn WriteFile(file: RawHandle, buffer: *const c_void, length: u32, written: *mut u32, operation: *mut Overlapped) -> i32;
    fn WaitForMultipleObjects(count: u32, handles: *const RawHandle, all: i32, timeout: u32) -> u32;
    fn WaitForSingleObject(handle: RawHandle, timeout: u32) -> u32;
    fn GetOverlappedResult(file: RawHandle, operation: *mut Overlapped, transferred: *mut u32, wait: i32) -> i32;
    fn CancelIoEx(file: RawHandle, operation: *mut Overlapped) -> i32;
    fn LocalFree(memory: *mut c_void) -> *mut c_void;
  }

  #[link(name = "advapi32")]
  extern "system" {
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(text: *const u16, revision: u32,
      descriptor: *mut *mut c_void, length: *mut u32) -> i32;
  }

  fn event() -> io::Result<OwnedHandle> {
    let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if handle.is_null() { Err(io::Error::last_os_error()) } else { Ok(unsafe { OwnedHandle::from_raw_handle(handle) }) }
  }

  pub struct Wake { event: OwnedHandle }

  impl Wake {
    pub fn new() -> io::Result<Self> { Ok(Self { event: event()? }) }
    pub fn signal(&self) { unsafe { SetEvent(self.event.as_raw_handle()); } }
  }

  pub struct Pipe { handle: OwnedHandle, path: String }

  impl Pipe {
    pub fn new(root: &Path, index: usize) -> io::Result<Self> {
      let token = root.file_name().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "streaming pipe has no owned name"))?.to_string_lossy();
      let path = format!(r"\\.\pipe\artdaddy-export-{}-{token}-{index}", std::process::id());
      let name = path.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
      let acl = "D:P(A;;GA;;;SY)(A;;GA;;;OW)".encode_utf16().chain(Some(0)).collect::<Vec<_>>();
      let mut descriptor = std::ptr::null_mut();
      if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(acl.as_ptr(), 1, &mut descriptor, std::ptr::null_mut()) } == 0 {
        return Err(io::Error::last_os_error());
      }
      let security = Security { length: std::mem::size_of::<Security>() as u32, descriptor, inherit: 0 };
      let handle = unsafe { CreateNamedPipeW(name.as_ptr(), 2 | 0x40000000 | 0x00080000, 8, 1, 4096, 0, 0, &security) };
      let error = io::Error::last_os_error();
      unsafe { LocalFree(descriptor); }
      if handle == (-1isize) as RawHandle { return Err(error); }
      Ok(Self { handle: unsafe { OwnedHandle::from_raw_handle(handle) }, path: format!("file:{path}") })
    }

    pub fn path(&self) -> &str { &self.path }

    fn operation(&self, wake: &Wake, start: impl FnOnce(*mut Overlapped, &mut u32) -> bool) -> io::Result<u32> {
      let completed = event()?;
      let mut operation = Overlapped { internal: 0, internal_high: 0, offset: 0, offset_high: 0, event: completed.as_raw_handle() };
      let mut transferred = 0;
      if start(&mut operation, &mut transferred) { return Ok(transferred); }
      let error = io::Error::last_os_error();
      if error.raw_os_error() != Some(997) { return Err(error); }
      let handles = [wake.event.as_raw_handle(), completed.as_raw_handle()];
      let ready = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, u32::MAX) };
      if ready != 1 {
        unsafe { CancelIoEx(self.handle.as_raw_handle(), &mut operation); WaitForSingleObject(completed.as_raw_handle(), u32::MAX); }
        return Err(if ready == 0 { io::Error::new(io::ErrorKind::Interrupted, "streaming pipe cancelled") } else { io::Error::last_os_error() });
      }
      if unsafe { GetOverlappedResult(self.handle.as_raw_handle(), &mut operation, &mut transferred, 0) } == 0 {
        return Err(io::Error::last_os_error());
      }
      Ok(transferred)
    }

    pub fn copy(self, source: &mut impl Read, wake: &Wake) -> io::Result<()> {
      self.operation(wake, |operation, _| {
        (unsafe { ConnectNamedPipe(self.handle.as_raw_handle(), operation) }) != 0 || io::Error::last_os_error().raw_os_error() == Some(535)
      })?;
      let mut buffer = [0u8; 65536];
      loop {
        let count = source.read(&mut buffer)?;
        if count == 0 { return Ok(()); }
        let mut remaining = &buffer[..count];
        while !remaining.is_empty() {
          let count = self.operation(wake, |operation, transferred| unsafe {
            WriteFile(self.handle.as_raw_handle(), remaining.as_ptr().cast(), remaining.len() as u32, transferred, operation) != 0
          })? as usize;
          if count == 0 { return Err(io::Error::new(io::ErrorKind::WriteZero, "streaming pipe made no progress")); }
          remaining = &remaining[count..];
        }
      }
    }
  }
}

pub(super) use platform::{Pipe, Wake};