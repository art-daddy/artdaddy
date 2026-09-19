mod mcp;

/// Move a file or directory to the OS Recycle Bin / Trash (recoverable) instead of
/// deleting it irreversibly. Backs the client's project-delete path (`fs.trash`).
#[tauri::command]
fn trash_path(path: String) -> Result<(), String> {
  trash::delete(&path).map_err(|e| e.to_string())
}

/// Terminate a process AND everything it spawned. The shell plugin's `Child::kill`
/// signals only the direct child, so a tool that re-execs itself (yt-dlp spawns a
/// worker, which spawns ffmpeg to merge) keeps running after Stop and finishes the
/// job the user cancelled.
#[tauri::command]
fn kill_process_tree(pid: u32) -> Result<(), String> {
  kill_tree(pid)
}

/// Commit a staged file onto its final path, for destinations the fs plugin cannot reach.
///
/// Its scope is $DATA/$DOWNLOAD/$HOME. Sidecars ignore that, so ffmpeg renders happily onto a
/// second drive and the fs plugin then refuses to rename the result into place — every export
/// off the home volume failed and left its `.part` file behind. Encoding straight to the
/// destination "fixes" it by making a half-written file visible under the user's chosen name,
/// which is the thing staging exists to prevent. So the MOVE is what belongs down here.
///
/// `rename` first (atomic, same volume); copy+remove only when that fails across volumes.
#[tauri::command]
fn commit_file(from: String, to: String) -> Result<(), String> {
  if let Some(parent) = std::path::Path::new(&to).parent() {
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  if std::fs::rename(&from, &to).is_ok() {
    return Ok(());
  }
  std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
  // The copy IS the commit; failing to tidy the staging file must not fail the export.
  let _ = std::fs::remove_file(&from);
  Ok(())
}

/// Delete a file outright, for the same out-of-scope destinations as `commit_file` — a failed
/// export must not leave its staging file sitting in the user's folder.
#[tauri::command]
fn remove_file(path: String) -> Result<(), String> {
  match std::fs::remove_file(&path) {
    Ok(()) => Ok(()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(e.to_string()),
  }
}

/// Everything the importer needs to know about a media file WITHOUT the webview ever
/// holding it: the content-hash id, the size, and enough leading bytes to check the
/// header. Reading a 1 GB file through `arrayBuffer()` killed the renderer outright.
#[derive(serde::Serialize)]
pub struct MediaProbe {
  id12: String,
  size: u64,
  head: Vec<u8>,
}

/// SHA-256 over the whole file, so this is seconds of work for a large import. Declared
/// `async` and moved onto a blocking thread deliberately: a SYNC `#[tauri::command]` runs on
/// the MAIN thread, where hashing a 1.75 GB file froze the window for ~20s ("Not Responding").
///
/// `on_progress` reports bytes read so the UI can show a real percentage rather than a spinner
/// that says nothing for a minute.
#[tauri::command]
async fn probe_media_file(
  path: String,
  head_bytes: usize,
  on_progress: tauri::ipc::Channel<ProbeProgress>,
) -> Result<MediaProbe, String> {
  tauri::async_runtime::spawn_blocking(move || probe_media_blocking(path, head_bytes, on_progress))
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, serde::Serialize)]
struct ProbeProgress {
  read: u64,
  total: u64,
}

fn probe_media_blocking(
  path: String,
  head_bytes: usize,
  on_progress: tauri::ipc::Channel<ProbeProgress>,
) -> Result<MediaProbe, String> {
  use sha2::{Digest, Sha256};
  use std::io::Read;

  let file = std::fs::File::open(&path).map_err(|e| format!("{path}: {e}"))?;
  let size = file.metadata().map_err(|e| e.to_string())?.len();
  let mut reader = std::io::BufReader::with_capacity(1 << 20, file);
  let mut hasher = Sha256::new();
  let mut head = Vec::with_capacity(head_bytes.min(size as usize));
  let mut buf = vec![0u8; 1 << 20];
  let mut read_total: u64 = 0;
  // Coalesced to ~1% so a 1.75 GB file sends ~100 messages, not 1750.
  let step = (size / 100).max(8 << 20);
  let mut next_report = step;
  loop {
    let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
    if n == 0 {
      break;
    }
    if head.len() < head_bytes {
      let want = (head_bytes - head.len()).min(n);
      head.extend_from_slice(&buf[..want]);
    }
    hasher.update(&buf[..n]);
    read_total += n as u64;
    if read_total >= next_report {
      next_report = read_total + step;
      let _ = on_progress.send(ProbeProgress { read: read_total, total: size });
    }
  }
  let digest = hasher.finalize();
  Ok(MediaProbe {
    id12: digest.iter().map(|b| format!("{b:02x}")).collect::<String>()[..12].to_string(),
    size,
    head,
  })
}

#[cfg(windows)]
fn kill_tree(pid: u32) -> Result<(), String> {
  use std::os::windows::process::CommandExt;
  const CREATE_NO_WINDOW: u32 = 0x0800_0000;
  let status = std::process::Command::new("taskkill")
    .args(["/PID", &pid.to_string(), "/T", "/F"])
    .creation_flags(CREATE_NO_WINDOW)
    .status()
    .map_err(|e| e.to_string())?;
  match status.code() {
    // 128 = "process not found": it already exited, which is the state we wanted.
    Some(0) | Some(128) | None => Ok(()),
    Some(code) => Err(format!("taskkill exited with {code}")),
  }
}

#[cfg(not(windows))]
fn kill_tree(pid: u32) -> Result<(), String> {
  // Depth-first: descendants before the parent, so killing the parent can't
  // reparent grandchildren out of reach before we get to them.
  for child in child_pids(pid) {
    let _ = kill_tree(child);
  }
  let _ = std::process::Command::new("kill")
    .args(["-9", &pid.to_string()])
    .status();
  Ok(())
}

#[cfg(not(windows))]
fn child_pids(pid: u32) -> Vec<u32> {
  std::process::Command::new("pgrep")
    .args(["-P", &pid.to_string()])
    .output()
    .ok()
    .map(|out| {
      String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| line.trim().parse().ok())
        .collect()
    })
    .unwrap_or_default()
}

/// What an available update looks like to the UI. `None` from the check means
/// "already current" — not an error.
#[derive(serde::Serialize)]
pub struct UpdateInfo {
  version: String,
  current_version: String,
  notes: String,
  date: String,
}

/// Ask the update endpoint whether a newer signed build exists. Never throws on a
/// network failure — being offline is not an error worth interrupting anyone for.
#[cfg(desktop)]
#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
  use tauri_plugin_updater::UpdaterExt;
  let updater = app.updater().map_err(|e| e.to_string())?;
  match updater.check().await {
    Ok(Some(update)) => Ok(Some(UpdateInfo {
      version: update.version.clone(),
      current_version: update.current_version.clone(),
      notes: update.body.clone().unwrap_or_default(),
      date: update.date.map(|d| d.to_string()).unwrap_or_default(),
    })),
    Ok(None) => Ok(None),
    Err(e) => Err(e.to_string()),
  }
}

/// Download + install the update, then relaunch. Re-checks rather than holding the
/// Update handle between calls, so the install is driven by whatever is CURRENT at
/// the moment the user consents, not by a stale check from app start.
#[cfg(desktop)]
#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
  use tauri_plugin_updater::UpdaterExt;
  let updater = app.updater().map_err(|e| e.to_string())?;
  let update = updater
    .check()
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "no update available".to_string())?;
  update
    .download_and_install(|_chunk, _total| {}, || {})
    .await
    .map_err(|e| e.to_string())?;
  app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default();

  // MUST be the first plugin registered, and must come before deep-link: it is what makes a
  // second launch hand its argv to the running app instead of starting a rival instance.
  //
  // The forwarding is NOT free with the `deep-link` feature: it lives in the plugin's DEFAULT
  // callback, and init() replaces that callback wholesale. Focus the window and forget this
  // line and the app raises on a callback while the URL is silently dropped.
  #[cfg(desktop)]
  let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
    use tauri::Manager;
    if let Some(deep_link) = app.try_state::<tauri_plugin_deep_link::DeepLink<tauri::Wry>>() {
      deep_link.handle_cli_arguments(argv.iter());
    }
    if let Some(w) = app.webview_windows().values().next() {
      let _ = w.set_focus();
    }
  }));

  let builder = builder
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_deep_link::init());

  #[cfg(desktop)]
  let builder = builder
    .plugin(tauri_plugin_updater::Builder::new().build())
    .invoke_handler(tauri::generate_handler![
      trash_path,
      kill_process_tree,
      commit_file,
      remove_file,
      probe_media_file,
      host_platform,
      check_for_update,
      install_update,
      open_install_link,
      open_community_link,
      reveal_mcp_bundle,
      open_desktop_auth,
      store_refresh_token,
      load_refresh_token,
      clear_refresh_token,
      mcp::mcp_start,
      mcp::mcp_stop,
      mcp::mcp_status,
      mcp::mcp_reply,
      mcp::mcp_set_instructions
    ]);

  #[cfg(not(desktop))]
  let builder = builder.invoke_handler(tauri::generate_handler![
    trash_path,
    kill_process_tree,
    commit_file,
    remove_file,
    probe_media_file,
    host_platform
  ]);

  builder
    .setup(|app| {
      // Release builds log too: a beta tester whose MCP server or export dies at boot has no
      // console to read, and "it just didn't work" is the only report we would otherwise get.
      app.handle().plugin(
        tauri_plugin_log::Builder::default()
          .level(log::LevelFilter::Info)
          .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3))
          .max_file_size(2_000_000)
          .build(),
      )?;
      #[cfg(desktop)]
      migrate_data_folder(app.handle());
      #[cfg(desktop)]
      if cfg!(target_os = "macos") {
        install_macos_menu(app.handle())?;
      }
      // macOS registers the scheme from tauri.conf.json at BUILD time; Linux/Windows only pick
      // it up once the app is installed unless we force it here too — otherwise the desktop-auth
      // deep link works in a packaged build but silently does nothing in dev on those platforms.
      #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
      {
        use tauri_plugin_deep_link::DeepLinkExt;
        app.deep_link().register_all()?;
      }
      mcp::init(app.handle());
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

/// The only URLs the webview may hand to the OS. Prefixes, not schemes: `vscode:` alone would
/// let any vscode command through, and a bare host match on cursor.com would allow any page.
#[cfg(desktop)]
const INSTALL_LINK_PREFIXES: &[&str] = &[
  "https://cursor.com/en/install-mcp?",
  "vscode:mcp/install?",
  "vscode-insiders:mcp/install?",
];

#[cfg(desktop)]
fn is_install_link(url: &str) -> bool {
  INSTALL_LINK_PREFIXES.iter().any(|p| url.starts_with(p))
}

/// Hand an MCP install link to the OS so the target editor registers the server itself.
///
/// Deliberately a command of ours calling the shell plugin's RUST api, not the plugin's own
/// command: `Shell::open` passes no scope, so the frontend gains no `shell:allow-open`
/// capability and cannot open anything `is_install_link` did not approve.
#[cfg(desktop)]
#[tauri::command]
fn open_install_link(app: tauri::AppHandle, url: String) -> Result<(), String> {
  if !is_install_link(&url) {
    return Err("refused: not an MCP install link".to_string());
  }
  #[allow(deprecated)]
  {
    use tauri_plugin_shell::ShellExt;
    app.shell().open(url, None).map_err(|e| e.to_string())
  }
}

/// The ArtDaddy Discord, and nothing else. Two forms because they do different jobs: the invite
/// is what someone who is not a member yet needs, while the channels URL jumps an existing member
/// straight into the server. Prefixes, so the invite code can be reissued without a rebuild, and
/// the same reasoning as `is_install_link`: a bare `discord.com` host match would allow any page
/// on it, including someone else's server.
#[cfg(desktop)]
const COMMUNITY_LINK_PREFIXES: &[&str] = &[
  "https://discord.gg/",
  "https://discord.com/channels/1550040801680302192",
];

#[cfg(desktop)]
fn is_community_link(url: &str) -> bool {
  COMMUNITY_LINK_PREFIXES.iter().any(|p| url.starts_with(p))
}

#[cfg(desktop)]
#[tauri::command]
fn open_community_link(app: tauri::AppHandle, url: String) -> Result<(), String> {
  if !is_community_link(&url) {
    return Err("refused: not the community link".to_string());
  }
  #[allow(deprecated)]
  {
    use tauri_plugin_shell::ShellExt;
    app.shell().open(url, None).map_err(|e| e.to_string())
  }
}

/// The real OS and CPU, which the webview cannot tell us: its user-agent reports an Intel Mac on
/// Apple Silicon, and that distinction decides which native sidecar build is running — exactly the
/// thing we need to know when transcription or export dies on one machine and not another.
#[tauri::command]
fn host_platform() -> (String, String) {
  (
    std::env::consts::OS.to_string(),
    std::env::consts::ARCH.to_string(),
  )
}

/// The one page the desktop-auth flow is ever allowed to open: Clerk cannot run inside this
/// webview at all (wrong origin for a `pk_live_` key), so sign-in happens in the SYSTEM browser
/// on the real, verified domain instead, and hands a one-time code back via the `artdaddy://`
/// deep link. A prefix match, not a bare host check, for the same reason as the MCP links above.
#[cfg(desktop)]
const DESKTOP_AUTH_PREFIX: &str = "https://artdaddy.app/auth?";

#[cfg(desktop)]
fn is_desktop_auth_url(url: &str) -> bool {
  url.starts_with(DESKTOP_AUTH_PREFIX)
}

#[cfg(desktop)]
#[tauri::command]
fn open_desktop_auth(app: tauri::AppHandle, url: String) -> Result<(), String> {
  if !is_desktop_auth_url(&url) {
    return Err("refused: not the desktop-auth URL".to_string());
  }
  #[allow(deprecated)]
  {
    use tauri_plugin_shell::ShellExt;
    app.shell().open(url, None).map_err(|e| e.to_string())
  }
}

/// Where the desktop-auth refresh token lives: the OS's own secure credential store (macOS
/// Keychain / Windows Credential Manager / Linux Secret Service), never a plain file — a JSON
/// file next to the rest of app data would be no more protected than writing it in plaintext.
#[cfg(desktop)]
const KEYCHAIN_SERVICE: &str = "com.artdaddy.app";
#[cfg(desktop)]
const KEYCHAIN_ACCOUNT: &str = "desktop-auth-refresh-token";

#[cfg(desktop)]
fn store_refresh_token_at(service: &str, account: &str, token: &str) -> Result<(), String> {
  keyring::Entry::new(service, account)
    .and_then(|e| e.set_password(token))
    .map_err(|e| e.to_string())
}

#[cfg(desktop)]
fn load_refresh_token_at(service: &str, account: &str) -> Option<String> {
  keyring::Entry::new(service, account)
    .ok()
    .and_then(|e| e.get_password().ok())
}

#[cfg(desktop)]
fn clear_refresh_token_at(service: &str, account: &str) -> Result<(), String> {
  match keyring::Entry::new(service, account) {
    Ok(e) => match e.delete_credential() {
      Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
      Err(e) => Err(e.to_string()),
    },
    Err(e) => Err(e.to_string()),
  }
}

#[cfg(desktop)]
#[tauri::command]
fn store_refresh_token(token: String) -> Result<(), String> {
  store_refresh_token_at(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, &token)
}

/// `None` covers BOTH "never signed in" and "the OS has no entry" identically — callers must
/// treat either as "no session", not as an error worth surfacing.
#[cfg(desktop)]
#[tauri::command]
fn load_refresh_token() -> Option<String> {
  load_refresh_token_at(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
}

/// Idempotent: signing out (or a rejected/rotated token) clears the entry even if none exists.
#[cfg(desktop)]
#[tauri::command]
fn clear_refresh_token() -> Result<(), String> {
  clear_refresh_token_at(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
}

/// Where Claude Desktop lives, or None when it is not installed.
///
/// This is the difference between "we handed the OS a path" and "the user got a connector".
/// Opening the bundle when Claude is absent does nothing visible on Windows, so the UI has to
/// be able to ASK before it claims anything.
#[cfg(desktop)]
fn claude_desktop_path() -> Option<std::path::PathBuf> {
  #[cfg(target_os = "windows")]
  {
    // The classic per-user installer.
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
      let exe = std::path::Path::new(&local)
        .join("AnthropicClaude")
        .join("claude.exe");
      if exe.exists() {
        return Some(exe);
      }
    }
    // ...and the Microsoft Store build, which lives under a VERSIONED WindowsApps folder that
    // cannot be globbed (listing that directory is denied) — so ask the package registry for the
    // root instead. Checking only the path above reported "Claude Desktop was not found" to
    // someone who had it installed and running.
    return msix_claude_exe();
  }
  #[cfg(target_os = "macos")]
  {
    for candidate in ["/Applications/Claude.app"] {
      let p = std::path::PathBuf::from(candidate);
      if p.exists() {
        return Some(p);
      }
    }
    // Also honour a per-user install.
    if let Some(home) = std::env::var_os("HOME") {
      let p = std::path::Path::new(&home).join("Applications/Claude.app");
      if p.exists() {
        return Some(p);
      }
    }
    return None;
  }
  #[cfg(not(any(target_os = "windows", target_os = "macos")))]
  {
    None
  }
}

/// The Store (MSIX) Claude's executable, via `reg.exe` — no registry crate, and no dependency on
/// a version number that changes with every update.
#[cfg(all(desktop, target_os = "windows"))]
fn msix_claude_exe() -> Option<std::path::PathBuf> {
  use std::os::windows::process::CommandExt;
  const PACKAGES: &str = r"HKCU\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages";
  const NO_WINDOW: u32 = 0x0800_0000; // CREATE_NO_WINDOW — never flash a console

  let reg = |args: &[&str]| -> Option<String> {
    let out = std::process::Command::new("reg.exe")
      .args(args)
      .creation_flags(NO_WINDOW)
      .output()
      .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
  };

  let keys = reg(&["query", PACKAGES, "/f", "Claude_*", "/k"])?;
  // Several versions can be registered at once; take whichever actually has the exe on disk.
  for key in claude_package_keys(&keys) {
    let Some(values) = reg(&["query", key, "/v", "PackageRootFolder"]) else {
      continue;
    };
    let Some(root) = package_root_folder(&values) else {
      continue;
    };
    let exe = std::path::Path::new(root).join("app").join("Claude.exe");
    if exe.exists() {
      return Some(exe);
    }
  }
  None
}

/// Package keys from `reg query ... /f Claude_* /k` output, skipping the blank lines and the
/// "End of search:" footer it also prints.
#[cfg(all(desktop, target_os = "windows"))]
fn claude_package_keys(out: &str) -> impl Iterator<Item = &str> {
  out
    .lines()
    .map(str::trim)
    .filter(|l| l.starts_with("HKEY_") && l.contains(r"\Claude_"))
}

/// The path out of a `reg query ... /v PackageRootFolder` line. The value can contain spaces
/// ("C:\Program Files\..."), so it is everything after the type, not a whitespace split.
#[cfg(all(desktop, target_os = "windows"))]
fn package_root_folder(out: &str) -> Option<&str> {
  out
    .lines()
    .find(|l| l.contains("PackageRootFolder"))
    .and_then(|l| l.split_once("REG_SZ"))
    .map(|(_, v)| v.trim())
    .filter(|v| !v.is_empty())
}

#[cfg(all(test, desktop, target_os = "windows"))]
mod claude_msix_tests {
  use super::{claude_package_keys, package_root_folder};

  // Captured verbatim from reg.exe on a machine with the Store build installed — a fixture we
  // invent could just encode our own misreading of the format.
  const KEYS: &str = "\r\nHKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages\\Claude_1.37937.3.0_x64__pzs8sxrjxfjjc\r\n\r\nEnd of search: 1 match(es) found.\r\n";
  const VALUES: &str = "\r\nHKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages\\Claude_1.37937.3.0_x64__pzs8sxrjxfjjc\r\n    PackageRootFolder    REG_SZ    C:\\Program Files\\WindowsApps\\Claude_1.37937.3.0_x64__pzs8sxrjxfjjc\r\n\r\n";

  #[test]
  fn finds_the_package_key_and_ignores_the_footer() {
    let keys: Vec<&str> = claude_package_keys(KEYS).collect();
    assert_eq!(keys.len(), 1, "the 'End of search' footer must not be treated as a key");
    assert!(keys[0].ends_with("Claude_1.37937.3.0_x64__pzs8sxrjxfjjc"));
  }

  #[test]
  fn a_value_line_naming_the_package_is_not_a_key() {
    // VALUES holds a key line AND a value line whose PATH also contains "\Claude_". Matching on
    // the package name alone would yield two "keys" and send a reg query at a value.
    let keys: Vec<&str> = claude_package_keys(VALUES).collect();
    assert_eq!(keys.len(), 1, "only the HKEY_ line is a key");
    assert!(keys[0].starts_with("HKEY_"));
  }

  #[test]
  fn reads_a_root_path_that_contains_spaces() {
    // The whole point: "Program Files" has a space, so a whitespace split loses the path.
    assert_eq!(
      package_root_folder(VALUES),
      Some(r"C:\Program Files\WindowsApps\Claude_1.37937.3.0_x64__pzs8sxrjxfjjc")
    );
  }

  #[test]
  fn refuses_output_that_names_no_package() {
    assert_eq!(claude_package_keys("\r\nEnd of search: 0 match(es) found.\r\n").count(), 0);
    assert_eq!(package_root_folder("ERROR: The system was unable to find the specified registry key"), None);
  }
}

/// Put the bundled `.mcpb` somewhere the user can reach and show it to them.
///
/// It used to hand the file straight to Claude Desktop and report success the moment `spawn`
/// returned. That is not evidence of anything: with Claude already running the argument was
/// silently dropped (the window just came forward), and against the Store build Claude opened
/// and immediately exited. Both looked like success in the UI and installed nothing.
///
/// Revealing the file works on every install type, running or not, and the one manual step
/// that follows is honest about what the user still has to do.
#[cfg(desktop)]
#[tauri::command]
fn reveal_mcp_bundle(app: tauri::AppHandle) -> Result<String, String> {
  use tauri::Manager;

  let bundle = app
    .path()
    .resolve("resources/artdaddy.mcpb", tauri::path::BaseDirectory::Resource)
    .map_err(|e| format!("could not locate the connector bundle: {e}"))?;
  if !bundle.exists() {
    return Err(format!(
      "the connector bundle is missing from this build ({})",
      bundle.display()
    ));
  }

  // Downloads is where a user expects to find something they were just handed; the resource
  // lives inside the install directory, which is awkward to browse and may be read-only.
  let dest = app
    .path()
    .download_dir()
    .ok()
    .map(|d| d.join("artdaddy.mcpb"))
    .unwrap_or_else(|| std::env::temp_dir().join("artdaddy.mcpb"));
  std::fs::copy(&bundle, &dest).map_err(|e| format!("could not save the connector: {e}"))?;

  reveal_in_file_manager(&dest);
  // Not a refusal: the file is saved and shown either way. Saying so up front is kinder than
  // letting someone hunt through Claude's settings for an app they have not installed.
  let Some(_claude) = claude_desktop_path() else {
    return Ok(format!("{} (Claude Desktop was not found on this machine)", dest.display()));
  };

  #[cfg(target_os = "macos")]
  {
    // `open -a <app> <file>` is the documented way to force a handler, and macOS delivers the
    // file to an app that is ALREADY running. Windows has no equivalent: there is no `.mcpb`
    // association to shell out to (verified: HKCR, UserChoice and `assoc` all have none), and
    // exec'ing the packaged exe directly is what opened Claude and immediately closed it.
    let _ = std::process::Command::new("open")
      .arg("-a")
      .arg(&_claude)
      .arg(&dest)
      .spawn();
    return Ok(format!(
      "{} - Claude should show an install dialog. If it does not: Settings > Extensions > Install Extension.",
      dest.display()
    ));
  }
  #[cfg(not(target_os = "macos"))]
  Ok(dest.to_string_lossy().into_owned())
}

/// Best-effort: the path is returned to the UI either way, so a file manager that refuses to
/// open must not turn into a failed install.
#[cfg(desktop)]
fn reveal_in_file_manager(path: &std::path::Path) {
  #[cfg(target_os = "windows")]
  {
    use std::os::windows::process::CommandExt;
    const NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("explorer.exe")
      .arg(format!("/select,{}", path.display()))
      .creation_flags(NO_WINDOW)
      .spawn();
  }
  #[cfg(target_os = "macos")]
  {
    let _ = std::process::Command::new("open").arg("-R").arg(path).spawn();
  }
  #[cfg(not(any(target_os = "windows", target_os = "macos")))]
  {
    if let Some(dir) = path.parent() {
      let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
    }
  }
}

/// Must match `identity.dataFolder` in src/brand.json (brand.drift.test.ts enforces it).
#[cfg(desktop)]
const DATA_FOLDER: &str = "ArtDaddy";
/// Must match `identity.legacyDataFolders`. Only ever append: dropping a name orphans
/// whoever is still on it.
#[cfg(desktop)]
const LEGACY_DATA_FOLDERS: &[&str] = &["Akaru"];

/// Every project lives in `<appData>/<DATA_FOLDER>`, and that folder is named after the
/// app — so renaming the app would hide all of someone's work. This moves the old folder
/// into place before the webview exists, which is the only point where nothing can be
/// holding a path yet.
///
/// Deliberately re-checked on EVERY launch rather than recorded as done once: the guard is
/// "the new name is absent and an old one is present", so a rename that loses to a lock
/// (antivirus, a stale sidecar) just retries next launch instead of stranding the projects.
/// `rename` is atomic within a volume and both paths sit under the same one, so a failure
/// leaves the old folder fully intact rather than half-moved.
///
/// If BOTH names exist someone has already migrated and then restored an old folder by hand;
/// merging them could silently overwrite, so this leaves them alone and says so.
#[cfg(desktop)]
fn migrate_data_folder(app: &tauri::AppHandle) {
  use tauri::Manager;
  if let Ok(base) = app.path().data_dir() {
    migrate_data_folder_in(&base);
  }
}

/// Split from the Tauri handle so it can be driven against a real directory in tests —
/// the thing worth proving is that the files arrive, not that the call was made.
#[cfg(desktop)]
fn migrate_data_folder_in(base: &std::path::Path) {
  let current = base.join(DATA_FOLDER);
  let stale: Vec<&&str> = LEGACY_DATA_FOLDERS
    .iter()
    .filter(|n| base.join(n).is_dir())
    .collect();

  if current.exists() {
    for old in stale {
      log::warn!("project data exists under both {old} and {DATA_FOLDER}; leaving {old} untouched");
    }
    return;
  }

  let Some(old) = stale.first() else { return };
  match std::fs::rename(base.join(old), &current) {
    Ok(()) => log::info!("moved project data from {old} to {DATA_FOLDER}"),
    // Not fatal: the projects are still under the old name and the next launch retries.
    Err(e) => log::error!("could not move project data from {old} to {DATA_FOLDER}: {e}"),
  }
}

/// The app draws its own File/Edit/View/Window/Help bar inside the window on every
/// platform, and macOS always renders a native bar too — Tauri's default duplicates
/// those exact labels with different contents. This shrinks the native bar to the one
/// item macOS insists on. The clipboard items live INSIDE it, unshown but present, so
/// Cmd+C/V/X still reach the webview (macOS routes them through menu accelerators).
#[cfg(desktop)]
fn install_macos_menu(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
  use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};

  let app_menu = Submenu::with_items(
    app,
    "ArtDaddy",
    true,
    &[
      &PredefinedMenuItem::about(app, Some("About ArtDaddy"), Some(AboutMetadata::default()))?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::undo(app, None)?,
      &PredefinedMenuItem::redo(app, None)?,
      &PredefinedMenuItem::cut(app, None)?,
      &PredefinedMenuItem::copy(app, None)?,
      &PredefinedMenuItem::paste(app, None)?,
      &PredefinedMenuItem::select_all(app, None)?,
      &PredefinedMenuItem::separator(app)?,
      &PredefinedMenuItem::hide(app, None)?,
      &PredefinedMenuItem::quit(app, None)?,
    ],
  )?;

  app.set_menu(Menu::with_items(app, &[&app_menu])?)?;
  Ok(())
}

#[cfg(test)]
mod tests {
  #[cfg(windows)]
  use super::kill_tree;
  use super::trash_path;
  use std::fs;
  use std::path::PathBuf;
  use std::time::{SystemTime, UNIX_EPOCH};

  fn scratch(tag: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().subsec_nanos();
    let mut p = std::env::temp_dir();
    p.push(format!("artdaddy_trash_test_{tag}_{nanos}"));
    p
  }

  /// A video editor's footage lives on the big second drive, and the folder picker already lets
  /// anyone choose one. Reading the capability JSON cannot tell you whether its globs actually
  /// MATCH such a path -- a project on `D:\` failed every read with "forbidden path" while the
  /// file looked perfectly correct -- so this evaluates the shipped patterns with the same
  /// matcher and options tauri uses (`require_literal_separator: true`, which is why a bare `*`
  /// is not enough on its own).
  mod fs_scope {
    use glob::{MatchOptions, Pattern};

    fn allow_patterns() -> Vec<String> {
      let raw = include_str!("../capabilities/default.json");
      let v: serde_json::Value = serde_json::from_str(raw).expect("capability json must parse");
      let perms = v["permissions"].as_array().expect("permissions array");
      let scope = perms
        .iter()
        .find(|p| p["identifier"] == "fs:scope")
        .expect("an fs:scope entry must exist");
      scope["allow"]
        .as_array()
        .expect("allow array")
        .iter()
        .map(|e| e["path"].as_str().expect("path string").to_string())
        .collect()
    }

    fn options() -> MatchOptions {
      // Mirrors tauri::scope::fs (tauri-2.11.5 src/scope/fs.rs).
      MatchOptions { case_sensitive: false, require_literal_separator: true, require_literal_leading_dot: false }
    }

    fn allowed(path: &str) -> bool {
      let opts = options();
      allow_patterns()
        .iter()
        .filter_map(|p| Pattern::new(p).ok())
        .any(|p| p.matches_with(path, opts))
    }

    #[test]
    fn the_capability_still_declares_a_scope() {
      // Without this the checks below would pass vacuously if the entry were ever renamed.
      assert!(!allow_patterns().is_empty());
    }

    #[test]
    fn a_project_on_a_second_windows_drive_is_allowed() {
      // The exact path from the crash report that prompted this.
      assert!(allowed("D:/AIVEDIOEDITING/MAHESH/internals/project.json"));
      assert!(allowed("E:/footage/clip.mp4"));
    }

    #[test]
    fn a_project_on_a_mounted_volume_is_allowed() {
      // The same rule has to hold where our mac and Linux users keep external media.
      assert!(allowed("/Volumes/Scratch/project/internals/project.json"));
      assert!(allowed("/mnt/media/footage/clip.mp4"));
    }

    #[test]
    fn the_default_location_is_still_covered() {
      // What this proves is that the SHIPPED scope admits a default-location project, which is
      // the user-visible outcome. It does not prove the `$DATA`/`$HOME` entries specifically
      // still work: tauri expands those at runtime and this test does not, so today they are
      // admitted by the catch-all above. Kept because the outcome is what must not regress.
      assert!(allowed("C:/Users/someone/AppData/Roaming/ArtDaddy/projects/p/internals/project.json"));
      assert!(allowed("/home/someone/.local/share/ArtDaddy/projects/p/timeline.json"));
    }
  }

  #[test]
  fn trashes_a_file_so_the_path_is_gone() {
    let p = scratch("file");
    fs::write(&p, b"delete me").unwrap();
    assert!(p.exists());

    trash_path(p.to_string_lossy().into_owned()).expect("trash should succeed");

    // The OUTCOME, not the call: the path must no longer resolve. (The bytes still
    // exist in the Recycle Bin — that is the whole point of using trash over remove.)
    assert!(!p.exists(), "the file is still at its original path");
  }

  #[test]
  fn trashes_a_directory_and_its_contents() {
    let dir = scratch("dir");
    fs::create_dir_all(dir.join("internals")).unwrap();
    fs::write(dir.join("internals/timeline.json"), b"{}").unwrap();

    trash_path(dir.to_string_lossy().into_owned()).expect("trash should succeed");

    assert!(!dir.exists(), "the project directory survived");
  }

  #[test]
  fn a_missing_path_is_an_error_not_a_panic() {
    // The frontend awaits this across IPC; a panic would poison the webview call
    // instead of surfacing a message the delete flow can show the user.
    let p = scratch("missing");
    let err = trash_path(p.to_string_lossy().into_owned())
      .expect_err("trashing a non-existent path must fail");
    assert!(!err.is_empty(), "the error must carry a message");
  }

  #[test]
  fn an_empty_path_is_rejected_rather_than_deleting_the_cwd() {
    assert!(trash_path(String::new()).is_err());
  }

  // ── kill_process_tree ──────────────────────────────────────────────────────

  /// The bug this exists for: Stop killed only the direct child, so yt-dlp's
  /// re-exec'd worker finished the download the user had cancelled. The test
  /// asserts the OUTCOME (a grandchild is gone), not that a kill was requested.
  #[test]
  #[cfg(windows)]
  fn kills_a_grandchild_not_just_the_direct_child() {
    use std::process::{Command, Stdio};
    use std::thread::sleep;
    use std::time::Duration;

    // parent cmd -> child cmd -> a long ping; killing only the parent would leave
    // the ping running, which is exactly the yt-dlp shape.
    let parent = Command::new("cmd")
      .args(["/C", "cmd /C ping -n 120 127.0.0.1 > nul"])
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .spawn()
      .expect("spawn parent");
    let pid = parent.id();
    sleep(Duration::from_millis(1500)); // let the grandchild come up

    let descendants = descendant_pids(pid);
    assert!(!descendants.is_empty(), "expected at least one descendant to kill");

    kill_tree(pid).expect("kill_tree should succeed");
    sleep(Duration::from_millis(1500));

    for d in descendants {
      assert!(!pid_alive(d), "descendant {d} survived the tree kill");
    }
    assert!(!pid_alive(pid), "the parent survived the tree kill");
  }

  #[test]
  #[cfg(windows)]
  fn killing_an_already_dead_process_is_not_an_error() {
    // Stop can land after the tool exited on its own; that must not surface as a
    // failure the user sees.
    use std::process::{Command, Stdio};
    let mut p = Command::new("cmd")
      .args(["/C", "exit"])
      .stdout(Stdio::null())
      .spawn()
      .expect("spawn");
    let pid = p.id();
    let _ = p.wait();
    assert!(kill_tree(pid).is_ok(), "a dead pid must be treated as success");
  }

  #[cfg(windows)]
  fn pid_alive(pid: u32) -> bool {
    let out = std::process::Command::new("tasklist")
      .args(["/FI", &format!("PID eq {pid}"), "/NH"])
      .output()
      .expect("tasklist");
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
  }

  #[cfg(windows)]
  fn descendant_pids(pid: u32) -> Vec<u32> {
    // NOT wmic: Windows has removed it, so this returned an empty list on a current build and the
    // test failed its own precondition ("expected at least one descendant") while kill_tree --
    // which uses taskkill, not wmic -- was working perfectly well.
    let out = std::process::Command::new("powershell")
      .args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &format!("(Get-CimInstance Win32_Process -Filter 'ParentProcessId={pid}').ProcessId"),
      ])
      .output();
    let Ok(out) = out else { return Vec::new() };
    String::from_utf8_lossy(&out.stdout)
      .lines()
      .filter_map(|l| l.trim().parse::<u32>().ok())
      .collect()
  }

  // ── data-folder migration ──────────────────────────────────────────────────
  //
  // The failure this guards against is silent: the app opens, finds no projects, and
  // looks like a fresh install to someone whose work is still on disk. So every test
  // below asserts where the BYTES ended up, never that a rename was attempted.

  #[cfg(desktop)]
  fn base_with(tag: &str, dirs: &[&str]) -> PathBuf {
    let base = scratch(tag);
    for d in dirs {
      fs::create_dir_all(base.join(d)).unwrap();
    }
    base
  }

  #[cfg(desktop)]
  fn timeline_under(base: &PathBuf, folder: &str) -> PathBuf {
    base.join(folder).join("projects/podcasts_9947b1/internals/timeline.json")
  }

  #[test]
  #[cfg(desktop)]
  fn a_project_made_under_the_old_name_is_still_there_after_the_rename() {
    let base = base_with("mig_move", &["Akaru/projects/podcasts_9947b1/internals"]);
    fs::write(timeline_under(&base, "Akaru"), b"{\"tracks\":[]}").unwrap();

    super::migrate_data_folder_in(&base);

    assert_eq!(
      fs::read(timeline_under(&base, super::DATA_FOLDER)).unwrap(),
      b"{\"tracks\":[]}",
      "the timeline did not arrive under the new name"
    );
    assert!(!base.join("Akaru").exists(), "moved, not copied — two roots must not coexist");
  }

  #[test]
  #[cfg(desktop)]
  fn a_second_launch_does_not_disturb_already_migrated_projects() {
    let base = base_with("mig_twice", &["Akaru/projects/podcasts_9947b1/internals"]);
    fs::write(timeline_under(&base, "Akaru"), b"first").unwrap();

    super::migrate_data_folder_in(&base);
    super::migrate_data_folder_in(&base);

    assert_eq!(fs::read(timeline_under(&base, super::DATA_FOLDER)).unwrap(), b"first");
  }

  /// The dangerous ordering: someone restores an old folder by hand after migrating.
  /// Merging could overwrite newer work, so both must survive untouched.
  #[test]
  #[cfg(desktop)]
  fn when_both_names_exist_neither_is_clobbered() {
    let base = base_with(
      "mig_both",
      &["Akaru/projects/podcasts_9947b1/internals", "ArtDaddy/projects/podcasts_9947b1/internals"],
    );
    fs::write(timeline_under(&base, "Akaru"), b"old").unwrap();
    fs::write(timeline_under(&base, super::DATA_FOLDER), b"new").unwrap();

    super::migrate_data_folder_in(&base);

    assert_eq!(fs::read(timeline_under(&base, "Akaru")).unwrap(), b"old");
    assert_eq!(fs::read(timeline_under(&base, super::DATA_FOLDER)).unwrap(), b"new");
  }

  #[test]
  #[cfg(desktop)]
  fn a_fresh_install_creates_nothing() {
    let base = base_with("mig_fresh", &[]);
    fs::create_dir_all(&base).unwrap();

    super::migrate_data_folder_in(&base);

    assert!(!base.join(super::DATA_FOLDER).exists(), "migration invented a data folder");
  }

  /// Only names this app has actually used may be consumed. A neighbouring vendor's
  /// folder sharing the same app-data parent must be left completely alone.
  #[test]
  #[cfg(desktop)]
  fn an_unrelated_sibling_folder_is_never_adopted() {
    let base = base_with("mig_sibling", &["SomeOtherApp/projects"]);
    fs::write(base.join("SomeOtherApp/projects/theirs.json"), b"theirs").unwrap();

    super::migrate_data_folder_in(&base);

    assert!(base.join("SomeOtherApp/projects/theirs.json").exists());
    assert!(!base.join(super::DATA_FOLDER).exists());
  }

  // ── install links ──────────────────────────────────────────────────────────
  //
  // This is the one place the webview can reach the OS handler, so the interesting cases are
  // the ones it must REFUSE, not the happy path.

  #[test]
  #[cfg(desktop)]
  fn accepts_the_editor_install_links() {
    assert!(super::is_install_link("https://cursor.com/en/install-mcp?name=a&config=e30="));
    assert!(super::is_install_link("vscode:mcp/install?%7B%7D"));
    assert!(super::is_install_link("vscode-insiders:mcp/install?%7B%7D"));
  }

  #[test]
  #[cfg(desktop)]
  fn refuses_anything_that_is_not_an_install_link() {
    for url in [
      "https://evil.example/steal",
      "file:///C:/Windows/System32/calc.exe",
      // A scheme match is not enough: these would run an editor command, not add a server.
      "vscode:extension/evil.publisher",
      "vscode://file/C:/secrets.txt",
      // Right host, wrong path — the prefix has to include the path or any page qualifies.
      "https://cursor.com/anything-else",
      // Prefix appears, but not at the START.
      "https://evil.example/?u=https://cursor.com/en/install-mcp?x",
      "",
    ] {
      assert!(!super::is_install_link(url), "should have refused {url}");
    }
  }

  // ── community link ──────────────────────────────────────────────────────────
  #[test]
  #[cfg(desktop)]
  fn accepts_our_discord_in_both_forms() {
    // What a non-member needs...
    assert!(super::is_community_link("https://discord.gg/abc123"));
    // ...and what jumps an existing member into the server.
    assert!(super::is_community_link("https://discord.com/channels/1550040801680302192"));
    assert!(super::is_community_link("https://discord.com/channels/1550040801680302192/999"));
  }

  #[test]
  #[cfg(desktop)]
  fn refuses_discord_pages_that_are_not_ours() {
    for url in [
      // The whole reason this is a prefix and not a host check: another server's id.
      "https://discord.com/channels/9999999999",
      "https://discord.com/login",
      "https://discord.com/",
      // Lookalike hosts.
      "https://discord.gg.evil.example/x",
      "https://notdiscord.gg/abc",
      "https://evil.example/?u=https://discord.gg/abc",
      // Not https.
      "http://discord.gg/abc",
      "file:///C:/Windows/System32/calc.exe",
      "",
    ] {
      assert!(!super::is_community_link(url), "should have refused {url}");
    }
  }

  // ── desktop-auth ────────────────────────────────────────────────────────────
  //
  // Same shape as the install-link allowlist above: the interesting cases are what a
  // malicious or malformed URL could try to sneak past a bare `contains`/host check.

  #[test]
  #[cfg(desktop)]
  fn accepts_the_real_desktop_auth_url() {
    assert!(super::is_desktop_auth_url(
      "https://artdaddy.app/auth?code_challenge=abc&code_challenge_method=S256&state=xyz"
    ));
  }

  #[test]
  #[cfg(desktop)]
  fn refuses_anything_that_is_not_the_desktop_auth_url() {
    for url in [
      "https://evil.example/steal",
      // Right registrable domain, wrong (attacker-controlled) subdomain.
      "https://artdaddy.app.evil.example/auth?x",
      // A DIFFERENT subdomain of the real root domain is still not this page.
      "https://sub.artdaddy.app/auth?x",
      // Right host, wrong path — the prefix has to include the path or any page qualifies.
      "https://artdaddy.app/other?x",
      // Right host and path, but missing the query-string marker the real URL always has.
      "https://artdaddy.app/auth",
      // http, not https.
      "http://artdaddy.app/auth?x",
      // Prefix appears, but not at the START.
      "https://evil.example/?u=https://artdaddy.app/auth?x",
      "",
    ] {
      assert!(!super::is_desktop_auth_url(url), "should have refused {url}");
    }
  }

  // ── desktop-auth keychain storage ───────────────────────────────────────────
  //
  // Exercises the REAL OS credential store (same backend production uses), under a service/
  // account distinct from the real app's so a test run can never read, clobber, or leave
  // behind the genuine refresh token. Cleans up unconditionally so a failed assertion never
  // leaves an orphaned entry in the developer's actual keychain.

  #[test]
  #[cfg(desktop)]
  fn refresh_token_round_trips_through_the_real_keychain() {
    let service = "com.artdaddy.app.test";
    let account = "desktop-auth-refresh-token-roundtrip";
    let _ = super::clear_refresh_token_at(service, account); // in case a prior run crashed mid-test

    assert_eq!(super::load_refresh_token_at(service, account), None);

    super::store_refresh_token_at(service, account, "rt-first").expect("store should succeed");
    assert_eq!(
      super::load_refresh_token_at(service, account),
      Some("rt-first".to_string())
    );

    // A rotation must REPLACE the value, never merely add to it.
    super::store_refresh_token_at(service, account, "rt-second").expect("re-store should succeed");
    assert_eq!(
      super::load_refresh_token_at(service, account),
      Some("rt-second".to_string())
    );

    super::clear_refresh_token_at(service, account).expect("clear should succeed");
    assert_eq!(super::load_refresh_token_at(service, account), None);
  }

  #[test]
  #[cfg(desktop)]
  fn clearing_an_absent_refresh_token_is_a_no_op_not_an_error() {
    let service = "com.artdaddy.app.test";
    let account = "desktop-auth-refresh-token-absent";
    let _ = super::clear_refresh_token_at(service, account);
    assert_eq!(super::load_refresh_token_at(service, account), None);
    // Idempotent: signing out twice, or a callback that races a manual sign-out, must not error.
    assert!(super::clear_refresh_token_at(service, account).is_ok());
  }
}

