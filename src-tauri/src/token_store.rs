//! Where the desktop sign-in's refresh token is kept.
//!
//! The OS credential store (Keychain, Credential Manager, Secret Service) when the OS has one. On
//! Linux with no Secret Service at all, a file only the user can read, as the GitHub CLI does
//! (owner decision 2026-10-06): the alternative was signing in again at every launch.
//!
//! Refresh tokens rotate on every use and the server revokes the whole sign-in when an old one is
//! replayed, so the rule here is that a stale copy can never be the one handed out:
//! - the file is written only while there is no keyring, and every keyring write removes the file
//!   first (failing if it cannot), so a file that exists is always the newest copy;
//! - a load therefore prefers the file, and never writes: the next rotation moves the session
//!   into the keyring by itself;
//! - a file that exists but cannot be read is no session, never a reason to fall back to the
//!   keyring, whose copy would be older.

use std::io::{Read, Write};
use std::path::PathBuf;

/// A place a token can be kept.
pub trait Vault {
  /// `Ok(None)` only when there is definitely nothing there.
  fn load(&self) -> Result<Option<String>, String>;
  fn store(&self, token: &str) -> Result<(), String>;
  /// Idempotent: nothing there is not an error.
  fn clear(&self) -> Result<(), String>;
}

/// The token, or None for "no session": a keyring that cannot be read is not an error worth
/// surfacing, as before.
pub fn load(keyring: Option<&dyn Vault>, file: Option<&dyn Vault>) -> Option<String> {
  if let Some(file) = file {
    match file.load() {
      Ok(Some(token)) => return Some(token),
      Ok(None) => {}
      Err(_) => return None,
    }
  }
  keyring.and_then(|k| k.load().ok().flatten())
}

/// `keyring` is None when the OS has no credential store; `file` is None where none is allowed.
pub fn store(keyring: Option<&dyn Vault>, file: Option<&dyn Vault>, token: &str) -> Result<(), String> {
  match (keyring, file) {
    (Some(keyring), file) => {
      if let Some(file) = file {
        file.clear()?;
      }
      keyring.store(token)
    }
    (None, Some(file)) => file.store(token),
    (None, None) => Err("no credential store is available".to_string()),
  }
}

/// Clears every copy, trying all of them before reporting the first failure.
pub fn clear(keyring: Option<&dyn Vault>, file: Option<&dyn Vault>) -> Result<(), String> {
  let from_file = file.map_or(Ok(()), |f| f.clear());
  let from_keyring = keyring.map_or(Ok(()), |k| k.clear());
  from_file.and(from_keyring)
}

/// One entry of the OS credential store.
pub struct KeyringVault<'a> {
  pub service: &'a str,
  pub account: &'a str,
}

impl Vault for KeyringVault<'_> {
  fn load(&self) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(self.service, self.account).map_err(|e| e.to_string())?;
    match entry.get_password() {
      Ok(token) => Ok(Some(token)),
      Err(keyring::Error::NoEntry) => Ok(None),
      Err(e) => Err(e.to_string()),
    }
  }

  fn store(&self, token: &str) -> Result<(), String> {
    keyring::Entry::new(self.service, self.account)
      .and_then(|e| e.set_password(token))
      .map_err(|e| e.to_string())
  }

  fn clear(&self) -> Result<(), String> {
    match keyring::Entry::new(self.service, self.account) {
      Ok(e) => match e.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
      },
      Err(e) => Err(e.to_string()),
    }
  }
}

/// A token in a file only its owner can read: the folder 0700, the file 0600, written whole
/// under a temporary name and renamed into place, so it is never readable by anyone else, nor
/// seen half-written.
pub struct FileVault {
  pub path: PathBuf,
}

/// Far more than any refresh token; a bigger file is not one of ours.
const MAX_TOKEN_BYTES: u64 = 8 * 1024;

impl Vault for FileVault {
  fn load(&self) -> Result<Option<String>, String> {
    let file = match std::fs::File::open(&self.path) {
      Ok(f) => f,
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
      Err(e) => return Err(e.to_string()),
    };
    let mut text = String::new();
    file
      .take(MAX_TOKEN_BYTES + 1)
      .read_to_string(&mut text)
      .map_err(|e| e.to_string())?;
    let token = text.trim();
    if token.is_empty() || text.len() as u64 > MAX_TOKEN_BYTES {
      return Err("the saved sign-in is not a token".to_string());
    }
    Ok(Some(token.to_string()))
  }

  fn store(&self, token: &str) -> Result<(), String> {
    let dir = self.path.parent().ok_or("the token file has no folder")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    let tmp = dir.join(format!(".refresh-token.{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
      use std::os::unix::fs::OpenOptionsExt;
      options.mode(0o600);
    }
    let written = options.open(&tmp).and_then(|mut f| {
      f.write_all(token.as_bytes())?;
      f.sync_all()
    });
    let renamed = written.and_then(|()| std::fs::rename(&tmp, &self.path));
    if let Err(e) = renamed {
      let _ = std::fs::remove_file(&tmp);
      return Err(e.to_string());
    }
    Ok(())
  }

  fn clear(&self) -> Result<(), String> {
    match std::fs::remove_file(&self.path) {
      Ok(()) => Ok(()),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
      Err(e) => Err(e.to_string()),
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::cell::RefCell;

  /// An in-memory vault whose operations can be made to fail, and which records what it saw.
  #[derive(Default)]
  struct Fake {
    token: RefCell<Option<String>>,
    load_fails: bool,
    store_fails: bool,
    clear_fails: bool,
    stores: RefCell<Vec<String>>,
  }

  impl Fake {
    fn holding(token: &str) -> Self {
      Fake { token: RefCell::new(Some(token.to_string())), ..Fake::default() }
    }
    fn get(&self) -> Option<String> {
      self.token.borrow().clone()
    }
  }

  impl Vault for Fake {
    fn load(&self) -> Result<Option<String>, String> {
      if self.load_fails {
        return Err("locked".into());
      }
      Ok(self.get())
    }
    fn store(&self, token: &str) -> Result<(), String> {
      if self.store_fails {
        return Err("write refused".into());
      }
      self.stores.borrow_mut().push(token.to_string());
      *self.token.borrow_mut() = Some(token.to_string());
      Ok(())
    }
    fn clear(&self) -> Result<(), String> {
      if self.clear_fails {
        return Err("cannot remove".into());
      }
      *self.token.borrow_mut() = None;
      Ok(())
    }
  }

  #[test]
  fn without_a_keyring_the_session_lives_in_the_file() {
    let file = Fake::default();
    store(None, Some(&file), "rt-1").unwrap();
    assert_eq!(load(None, Some(&file)), Some("rt-1".to_string()));
    store(None, Some(&file), "rt-2").unwrap();
    assert_eq!(load(None, Some(&file)), Some("rt-2".to_string()));
    clear(None, Some(&file)).unwrap();
    assert_eq!(load(None, Some(&file)), None);
  }

  #[test]
  fn where_no_file_is_allowed_a_missing_keyring_fails_the_store_as_before() {
    assert!(store(None, None, "rt").is_err());
    assert_eq!(load(None, None), None);
    assert!(clear(None, None).is_ok());
  }

  // The opposite ordering of the danger below: a keyring write must never leave an older file
  // behind to win the next load.
  #[test]
  fn a_keyring_write_removes_the_file_first_and_fails_if_it_cannot() {
    let keyring = Fake::default();
    let file = Fake::holding("rt-old");
    store(Some(&keyring), Some(&file), "rt-new").unwrap();
    assert_eq!(file.get(), None);
    assert_eq!(keyring.get(), Some("rt-new".to_string()));
    assert_eq!(load(Some(&keyring), Some(&file)), Some("rt-new".to_string()));

    let stuck = Fake { clear_fails: true, ..Fake::holding("rt-old") };
    let keyring = Fake::holding("rt-keyring");
    assert!(store(Some(&keyring), Some(&stuck), "rt-new").is_err());
    assert!(keyring.stores.borrow().is_empty(), "the keyring must not be written past a stale file");
    assert_eq!(keyring.get(), Some("rt-keyring".to_string()));
  }

  // A session saved while the keyring was missing, then the keyring is back holding an OLDER,
  // already rotated token: handing that one out would get the whole sign-in revoked.
  #[test]
  fn a_file_saved_without_a_keyring_wins_over_an_older_keyring_entry() {
    let keyring = Fake::holding("rt-rotated-away");
    let file = Fake::holding("rt-newest");
    assert_eq!(load(Some(&keyring), Some(&file)), Some("rt-newest".to_string()));
    // Loading writes nothing; the next rotation moves the session into the keyring.
    assert!(keyring.stores.borrow().is_empty());
    store(Some(&keyring), Some(&file), "rt-rotated").unwrap();
    assert_eq!(file.get(), None);
    assert_eq!(load(Some(&keyring), Some(&file)), Some("rt-rotated".to_string()));
  }

  #[test]
  fn an_unreadable_file_is_no_session_never_the_keyrings_older_copy() {
    let keyring = Fake::holding("rt-older");
    let file = Fake { load_fails: true, ..Fake::holding("rt-newer") };
    assert_eq!(load(Some(&keyring), Some(&file)), None);
  }

  #[test]
  fn an_unreadable_keyring_is_no_session() {
    let keyring = Fake { load_fails: true, ..Fake::holding("rt") };
    assert_eq!(load(Some(&keyring), Some(&Fake::default())), None);
    assert_eq!(load(Some(&keyring), None), None);
  }

  #[test]
  fn clear_tries_every_copy_before_reporting_a_failure() {
    let keyring = Fake::holding("rt-a");
    let file = Fake { clear_fails: true, ..Fake::holding("rt-b") };
    assert!(clear(Some(&keyring), Some(&file)).is_err());
    assert_eq!(keyring.get(), None, "the keyring is cleared even though the file could not be");

    let keyring = Fake { clear_fails: true, ..Fake::holding("rt-a") };
    let file = Fake::holding("rt-b");
    assert!(clear(Some(&keyring), Some(&file)).is_err());
    assert_eq!(file.get(), None);
  }

  fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("artdaddy-token-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
  }

  #[test]
  fn the_file_round_trips_rotates_and_clears() {
    let dir = scratch("roundtrip");
    let vault = FileVault { path: dir.join("auth").join("refresh-token") };
    assert_eq!(vault.load(), Ok(None));
    vault.store("rt-first").unwrap();
    assert_eq!(vault.load(), Ok(Some("rt-first".to_string())));
    vault.store("rt-second").unwrap();
    assert_eq!(vault.load(), Ok(Some("rt-second".to_string())));
    // Written whole and renamed into place: nothing else is left in the folder.
    let names: Vec<_> = std::fs::read_dir(dir.join("auth")).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, vec![std::ffi::OsString::from("refresh-token")]);
    vault.clear().unwrap();
    assert_eq!(vault.load(), Ok(None));
    assert!(vault.clear().is_ok(), "clearing twice is not an error");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_file_that_is_not_a_token_is_refused_not_trusted() {
    let dir = scratch("garbage");
    let path = dir.join("refresh-token");
    std::fs::create_dir_all(&dir).unwrap();
    let vault = FileVault { path: path.clone() };
    std::fs::write(&path, "  \n").unwrap();
    assert!(vault.load().is_err());
    std::fs::write(&path, vec![b'x'; (MAX_TOKEN_BYTES + 1) as usize]).unwrap();
    assert!(vault.load().is_err());
    std::fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
    assert!(vault.load().is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[cfg(unix)]
  #[test]
  fn only_its_owner_can_read_the_file_or_list_its_folder() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch("modes");
    let auth = dir.join("auth");
    // A folder that already exists, open to everyone, is closed before anything is written.
    std::fs::create_dir_all(&auth).unwrap();
    std::fs::set_permissions(&auth, std::fs::Permissions::from_mode(0o755)).unwrap();
    let vault = FileVault { path: auth.join("refresh-token") };
    vault.store("rt").unwrap();
    let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&auth), 0o700);
    assert_eq!(mode(&auth.join("refresh-token")), 0o600);
    vault.store("rt-2").unwrap();
    assert_eq!(mode(&auth.join("refresh-token")), 0o600, "a rotation keeps it private");
    let _ = std::fs::remove_dir_all(&dir);
  }
}
