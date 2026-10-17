use std::path::Path;
use std::process::Command;

pub(super) struct OutputLimit {
  #[cfg(windows)]
  _file: std::fs::File,
  #[cfg(unix)]
  bytes: libc::rlim_t,
}

impl OutputLimit {
  pub(super) fn open(_path: &Path, bytes: u64) -> Result<Self, String> {
    if bytes == 0 || bytes > i64::MAX as u64 {
      return Err("native output limit is outside the supported file range".into());
    }
    #[cfg(windows)]
    {
      use std::os::windows::fs::OpenOptionsExt;
      use std::os::windows::io::AsRawHandle;
      use windows_sys::Win32::Storage::FileSystem::{LockFileEx, FILE_SHARE_READ, FILE_SHARE_WRITE,
        LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY};
      use windows_sys::Win32::System::IO::OVERLAPPED;

      let file = std::fs::OpenOptions::new().read(true).write(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE).open(_path).map_err(|error| error.to_string())?;
      let mut overlap: OVERLAPPED = unsafe { std::mem::zeroed() };
      overlap.Anonymous.Anonymous.Offset = bytes as u32;
      overlap.Anonymous.Anonymous.OffsetHigh = (bytes >> 32) as u32;
      let length = i64::MAX as u64 - bytes;
      if unsafe { LockFileEx(file.as_raw_handle(), LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
        0, length as u32, (length >> 32) as u32, &mut overlap) } == 0 {
        return Err(format!("could not install native output write limit: {}", std::io::Error::last_os_error()));
      }
      return Ok(Self { _file: file });
    }
    #[cfg(unix)]
    {
      let bytes = bytes.try_into().map_err(|_| "native output limit does not fit the platform")?;
      return Ok(Self { bytes });
    }
    #[cfg(not(any(windows, unix)))]
    Err("native output write limits are unavailable on this platform".into())
  }

  pub(super) fn configure(&self, _command: &mut Command) {
    #[cfg(unix)]
    {
      use std::os::unix::process::CommandExt;
      let bytes = self.bytes;
      unsafe {
        _command.pre_exec(move || {
          let mut previous: libc::rlimit = std::mem::zeroed();
          if libc::getrlimit(libc::RLIMIT_FSIZE, &mut previous) != 0 {
            return Err(std::io::Error::last_os_error());
          }
          let limit = bytes.min(previous.rlim_cur).min(previous.rlim_max);
          let bounded = libc::rlimit { rlim_cur: limit, rlim_max: limit };
          if libc::setrlimit(libc::RLIMIT_FSIZE, &bounded) != 0 {
            return Err(std::io::Error::last_os_error());
          }
          Ok(())
        });
      }
    }
  }
}