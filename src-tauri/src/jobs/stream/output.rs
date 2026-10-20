use std::path::Path;
use std::process::Command;
use std::time::Instant;

#[cfg(windows)]
#[path = "output\\broker.rs"]
mod broker;

pub(super) struct OutputLimit {
  #[cfg(windows)]
  broker: broker::Broker,
  #[cfg(unix)]
  bytes: libc::rlim_t,
}

impl OutputLimit {
  pub(super) fn open(_path: &Path, bytes: u64, _args: &mut Vec<String>, _deadline: Instant) -> Result<Self, String> {
    if bytes == 0 || bytes > i64::MAX as u64 {
      return Err("native output limit is outside the supported file range".into());
    }
    #[cfg(windows)]
    {
      let index = _args.len().checked_sub(1).ok_or("native output command has no target")?;
      if Path::new(&_args[index]).canonicalize().map_err(|error| error.to_string())? !=
        _path.canonicalize().map_err(|error| error.to_string())? {
        return Err("native output sink does not match its admitted command target".into());
      }
      let broker = broker::Broker::open(_path, bytes, _deadline)?;
      _args[index] = broker.url().to_owned();
      _args.splice(index..index, ["-ftp-write-seekable".into(), "1".into(),
        "-protocol_whitelist".into(), "ftp,tcp".into()]);
      return Ok(Self { broker });
    }
    #[cfg(unix)]
    {
      let bytes = bytes.try_into().map_err(|_| "native output limit does not fit the platform")?;
      return Ok(Self { bytes });
    }
    #[cfg(not(any(windows, unix)))]
    Err("native output write limits are unavailable on this platform".into())
  }

  pub(super) fn cancel(&self) {
    #[cfg(windows)]
    self.broker.cancel();
  }

  pub(super) fn finish(&mut self, _complete: bool) -> Result<(), String> {
    #[cfg(windows)]
    return self.broker.finish(_complete).map_err(|error| format!("{error}\n{}", self.diagnostics()));
    #[cfg(not(windows))]
    if _complete { Ok(()) } else { Err("native output producer did not complete".into()) }
  }

  pub(super) fn diagnostics(&self) -> String {
    #[cfg(windows)]
    {
      let statistics = self.broker.statistics();
      return format!("native output sink: cap={} high_water={} written={} uploads={} completed_uploads={} readbacks={} rejected={} peers={} tasks={} file_open={}",
        statistics.cap, statistics.high_water, statistics.written, statistics.uploads,
        statistics.completed_uploads, statistics.readbacks, statistics.rejected,
        statistics.peers, statistics.tasks, statistics.file_open);
    }
    #[cfg(unix)]
    { format!("native output sink: child-owned file-size limit={}", self.bytes) }
    #[cfg(not(any(windows, unix)))]
    { "native output sink is unavailable".into() }
  }

  pub(super) fn redactor(&self) -> Redactor {
    #[cfg(windows)]
    return Redactor { secret: Some(self.broker.password().as_bytes().to_vec()), ..Redactor::default() };
    #[cfg(not(windows))]
    Redactor::default()
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

#[derive(Default)]
pub(super) struct Redactor {
  secret: Option<Vec<u8>>,
  pending: Vec<u8>,
  masking: Option<u8>,
}

impl Redactor {
  pub(super) fn push(&mut self, bytes: &[u8], eof: bool) -> Vec<u8> {
    let Some(secret) = &self.secret else { return bytes.to_vec() };
    let pass = [b"PASS ".as_slice(), &secret[..16]].concat();
    let markers: [(&[u8], &[u8], Option<u8>); 3] = [(secret, b"", None),
      (b"ftp://export:", b"ftp://export:", Some(b'@')), (&pass, b"PASS ", Some(b'\n'))];
    self.pending.extend_from_slice(bytes);
    let mut output = Vec::new();
    loop {
      if let Some(terminator) = self.masking {
        let end = self.pending.iter().position(|byte| *byte == terminator);
        if let Some(end) = end {
          self.pending.drain(..end + 1);
          output.push(terminator);
          self.masking = None;
        } else { self.pending.clear(); break; }
      }
      let found = markers.iter().filter_map(|(marker, prefix, terminator)|
        self.pending.windows(marker.len()).position(|bytes| bytes == *marker)
          .map(|index| (index, *marker, *prefix, *terminator))).min_by_key(|(index, _, _, _)| *index);
      if let Some((index, marker, prefix, terminator)) = found {
        output.extend_from_slice(&self.pending[..index]);
        output.extend_from_slice(prefix);
        output.extend_from_slice(b"<redacted>");
        self.pending.drain(..index + marker.len());
        self.masking = terminator;
      } else {
        let mut count = if eof { self.pending.len() } else { self.pending.len().saturating_sub(secret.len().max(13) - 1) };
        if !eof {
          while count > 0 && self.pending.get(count).is_some_and(|byte| byte & 0xc0 == 0x80) { count -= 1; }
        }
        output.extend(self.pending.drain(..count));
        break;
      }
    }

    output
  }
}

#[cfg(test)]
mod tests {
  use super::Redactor;

  fn filter(bytes: &[u8], secret: &[u8], width: usize) -> Vec<u8> {
    let mut redactor = Redactor { secret: Some(secret.to_vec()), ..Redactor::default() };
    let mut result = Vec::new();
    for bytes in bytes.chunks(width) { result.extend(redactor.push(bytes, false)); }
    result.extend(redactor.push(&[], true));
    result
  }

  #[test]
  fn diagnostic_filter_preserves_legitimate_bytes_for_every_chunk_width() {
    let secret = b"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let mut legitimate = (0..=255).cycle().take(8192).collect::<Vec<u8>>();
    legitimate.extend_from_slice("PASS harmless\nframes=144\nmedia \u{1f3ac} \u{65e5}\n".as_bytes());
    for width in 1..=256 {
      assert_eq!(filter(&legitimate, secret, width), legitimate, "chunk width {width}");
    }
  }

  #[test]
  fn diagnostic_credentials_are_redacted_across_all_chunk_and_truncation_boundaries() {
    let secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let input = format!("before\nftp://export:{secret}@127.0.0.1/output.mp4\nPASS {secret}\nraw={secret}\nafter\n");
    let expected = b"before\nftp://export:<redacted>@127.0.0.1/output.mp4\nPASS <redacted>\nraw=<redacted>\nafter\n";
    for width in 1..=input.len() {
      assert_eq!(filter(input.as_bytes(), secret.as_bytes(), width), expected, "chunk width {width}");
    }
    let prefix = b"ftp://export:";
    let complete = format!("ftp://export:{secret}");
    for end in prefix.len()..=complete.len() {
      assert_eq!(filter(&complete.as_bytes()[..end], secret.as_bytes(), 1), b"ftp://export:<redacted>");
    }
  }
}