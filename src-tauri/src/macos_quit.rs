use std::sync::OnceLock;
use tauri::{plugin::TauriPlugin, AppHandle, Manager};

static APP: OnceLock<AppHandle> = OnceLock::new();

extern "C" {
  fn artdaddy_install_quit_delegate(request_close: extern "C" fn() -> bool) -> bool;
}

fn coordinate_window_close<F>(window_exists: bool, close: F) -> bool
where
  F: FnOnce() -> Result<(), String>,
{
  if !window_exists {
    return false;
  }
  if let Err(error) = close() {
    log::error!("could not route macOS quit through the project close coordinator: {error}");
  }
  true
}

extern "C" fn request_close() -> bool {
  let Some(app) = APP.get() else {
    log::error!("macOS quit requested before the close coordinator was installed");
    return true;
  };
  match app.get_webview_window("main") {
    Some(window) => coordinate_window_close(true, || window.close().map_err(|error| error.to_string())),
    None => false,
  }
}

pub fn plugin() -> TauriPlugin<tauri::Wry> {
  tauri::plugin::Builder::new("macos-quit-guard")
    .setup(|app, _| {
      APP.set(app.clone()).map_err(|_| std::io::Error::other("macOS quit coordinator already installed"))?;
      if !unsafe { artdaddy_install_quit_delegate(request_close) } {
        return Err(std::io::Error::other("could not install the macOS application quit coordinator").into());
      }
      Ok(())
    })
    .build()
}

#[cfg(test)]
mod tests {
  use super::coordinate_window_close;
  use std::cell::Cell;

  #[test]
  fn native_quit_requests_the_existing_close_owner_once() {
    let calls = Cell::new(0);
    assert!(coordinate_window_close(true, || {
      calls.set(calls.get() + 1);
      Ok(())
    }));
    assert_eq!(calls.get(), 1);
  }

  #[test]
  fn a_closed_window_does_not_restart_the_close_lifecycle() {
    assert!(!coordinate_window_close(false, || panic!("closed window must not be closed again")));
  }

  #[test]
  fn a_native_close_error_keeps_the_app_alive_for_recovery() {
    assert!(coordinate_window_close(true, || Err("fixture close failure".into())));
  }
}
