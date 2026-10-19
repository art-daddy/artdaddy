use std::path::Path;

#[derive(Clone, Copy)]
pub(super) struct AllocationUnit(u64);

impl AllocationUnit {
  pub(super) fn for_directory(path: &Path) -> Result<Self, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
      return Err("export allocation volume needs a regular directory".into());
    }
    let bytes = volume_unit(path)?;
    if bytes == 0 { return Err("export filesystem reported a zero allocation unit".into()); }
    Ok(Self(bytes))
  }

  pub(super) fn bytes(self) -> u64 { self.0 }

  pub(super) fn from_admitted(bytes: u64) -> Self {
    assert!(bytes > 0, "admitted export allocation unit is nonzero");
    Self(bytes)
  }

  #[cfg(test)]
  pub(super) fn logical_fixture() -> Self { Self(1) }
}

#[cfg(test)]
pub(super) fn fixture_bytes(length: usize) -> Vec<u8> {
  use sha2::{Digest, Sha256};
  let mut bytes = Vec::with_capacity(length);
  for block in 0..length.div_ceil(32) {
    bytes.extend_from_slice(&Sha256::digest(u64::try_from(block).unwrap().to_le_bytes()));
  }
  bytes.truncate(length);
  bytes
}

#[derive(Clone, Copy, Default)]
pub(super) struct Usage {
  pub bytes: u64,
  pub allocated: u64,
}

pub(super) fn usage(path: &Path) -> Result<Usage, String> {
  let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
  if metadata.file_type().is_symlink() || !(metadata.is_file() || metadata.is_dir()) {
    return Err("export allocation entry must be a regular file or directory".into());
  }
  #[cfg(unix)]
  {
    use std::os::unix::fs::MetadataExt;
    let allocated = metadata.blocks().checked_mul(512).ok_or("export allocated size overflow")?;
    return Ok(Usage { bytes: if metadata.is_file() { metadata.len() } else { 0 }, allocated });
  }
  #[cfg(windows)]
  {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandleEx, FileStandardInfo,
      FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_STANDARD_INFO};
    let file = std::fs::OpenOptions::new().read(true)
      .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
      .open(path).map_err(|error| error.to_string())?;
    let mut info: FILE_STANDARD_INFO = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<FILE_STANDARD_INFO>().try_into().map_err(|_| "export allocation ABI size overflow")?;
    if unsafe { GetFileInformationByHandleEx(file.as_raw_handle(), FileStandardInfo,
      std::ptr::addr_of_mut!(info).cast(), size) } == 0 {
      return Err(format!("could not measure export allocated size: {}", std::io::Error::last_os_error()));
    }
    let allocated = info.AllocationSize.try_into().map_err(|_| "export filesystem reported a negative allocation")?;
    let bytes = info.EndOfFile.try_into().map_err(|_| "export filesystem reported a negative file size")?;
    return Ok(Usage { bytes: if !info.Directory { bytes } else { 0 }, allocated });
  }
  #[cfg(not(any(unix, windows)))]
  Err("export allocated-size measurement is unavailable on this platform".into())
}

#[cfg(unix)]
fn volume_unit(path: &Path) -> Result<u64, String> {
  use std::os::unix::ffi::OsStrExt;
  let path = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|error| error.to_string())?;
  let mut info: libc::statvfs = unsafe { std::mem::zeroed() };
  if unsafe { libc::statvfs(path.as_ptr(), &mut info) } != 0 {
    return Err(format!("could not measure export allocation unit: {}", std::io::Error::last_os_error()));
  }
  info.f_frsize.try_into().map_err(|_| "export filesystem allocation unit is outside the supported range".into())
}

#[cfg(windows)]
fn volume_unit(path: &Path) -> Result<u64, String> {
  use std::os::windows::ffi::OsStrExt;
  use windows_sys::Win32::Storage::FileSystem::{GetDiskFreeSpaceW, GetVolumePathNameW};
  let path: Vec<_> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
  let mut root = vec![0u16; 32768];
  if unsafe { GetVolumePathNameW(path.as_ptr(), root.as_mut_ptr(), 32768) } == 0 {
    return Err(format!("could not locate export allocation volume: {}", std::io::Error::last_os_error()));
  }
  let (mut sectors, mut sector_bytes, mut free, mut total) = (0, 0, 0, 0);
  if unsafe { GetDiskFreeSpaceW(root.as_ptr(), &mut sectors, &mut sector_bytes, &mut free, &mut total) } == 0 {
    return Err(format!("could not measure export allocation unit: {}", std::io::Error::last_os_error()));
  }
  u64::from(sectors).checked_mul(u64::from(sector_bytes)).ok_or("export allocation unit overflow".into())
}

#[cfg(not(any(unix, windows)))]
fn volume_unit(_path: &Path) -> Result<u64, String> {
  Err("export allocation-unit measurement is unavailable on this platform".into())
}
