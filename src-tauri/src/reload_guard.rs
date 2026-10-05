// Release builds never reload the page: a reload throws away everything the page owns (the
// agent's turn, an export's progress, a transcript being saved). F5, Ctrl+R, the context menu's
// Reload and `location.reload()` all arrive here as a navigation to the app's own origin, so
// once the window has loaded, those are refused. Other origins pass (macOS iframes use this hook).
// ARTDADDY_RELOAD_GUARD=1 turns it on in a dev build, for QA; Vite's hot reload needs it off.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::webview::PageLoadEvent;
use tauri::{Runtime, Url};

/// Whether the guard runs in this build.
pub fn enabled() -> bool {
  !cfg!(debug_assertions) || std::env::var("ARTDADDY_RELOAD_GUARD").as_deref() == Ok("1")
}

fn same_origin(a: &Url, b: &Url) -> bool {
  a.scheme() == b.scheme()
    && a.host_str() == b.host_str()
    && a.port_or_known_default() == b.port_or_known_default()
}

/// Refuse a navigation to the loaded page's own origin; allow anything before the first load.
pub fn navigation_allowed(loaded: Option<&Url>, to: &Url) -> bool {
  !loaded.is_some_and(|page| same_origin(page, to))
}

pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
  let loaded: Arc<Mutex<HashMap<String, Url>>> = Arc::default();
  let record = loaded.clone();
  tauri::plugin::Builder::new("reload-guard")
    .on_page_load(move |webview, payload| {
      if matches!(payload.event(), PageLoadEvent::Finished) {
        if let Ok(mut pages) = record.lock() {
          pages.insert(webview.label().to_string(), payload.url().clone());
        }
      }
    })
    .on_navigation(move |webview, to| {
      let allowed = match loaded.lock() {
        Ok(pages) => navigation_allowed(pages.get(webview.label()), to),
        Err(_) => true, // a poisoned lock must never stop the app loading
      };
      if !allowed {
        log::info!("reload-guard: refused a reload of the app ({to})");
      }
      allowed
    })
    .build()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn u(s: &str) -> Url {
    Url::parse(s).unwrap()
  }

  #[test]
  fn nothing_is_refused_before_the_window_has_loaded() {
    assert!(navigation_allowed(None, &u("http://tauri.localhost/")));
    assert!(navigation_allowed(None, &u("tauri://localhost/p/abc")));
  }

  #[test]
  fn a_reload_of_the_running_app_is_refused_on_every_platform_scheme() {
    // Windows serves the app from http://tauri.localhost; macOS and Linux from tauri://localhost.
    for page in ["http://tauri.localhost/p/abc", "tauri://localhost/p/abc"] {
      let loaded = u(page);
      assert!(!navigation_allowed(Some(&loaded), &loaded), "reload of {page}");
      let root = u(&format!("{}://{}/", loaded.scheme(), loaded.host_str().unwrap()));
      assert!(!navigation_allowed(Some(&loaded), &root), "navigation to the app root from {page}");
    }
  }

  #[test]
  fn the_dev_server_page_counts_as_the_app_when_the_guard_is_on_in_dev() {
    let loaded = u("http://localhost:5173/p/abc");
    assert!(!navigation_allowed(Some(&loaded), &u("http://localhost:5173/")));
    // A different port is a different origin.
    assert!(navigation_allowed(Some(&loaded), &u("http://localhost:5174/")));
  }

  #[test]
  fn other_origins_pass_through() {
    let loaded = u("tauri://localhost/p/abc");
    assert!(navigation_allowed(Some(&loaded), &u("about:blank")));
    assert!(navigation_allowed(Some(&loaded), &u("https://example.com/")));
    assert!(navigation_allowed(Some(&loaded), &u("http://localhost/")));
  }
}
