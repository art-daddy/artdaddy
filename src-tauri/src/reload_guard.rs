// Release builds never reload the page: a reload throws away everything the page owns (the
// agent's turn, an export's progress, a transcript being saved). F5, Ctrl+R, the context menu's
// Reload and `location.reload()` all arrive here as a navigation to the app's own origin, so
// once the window has loaded, those are refused. Other origins pass (macOS iframes use this hook).
// ARTDADDY_RELOAD_GUARD=1 turns it on in a dev build, for QA; Vite's hot reload needs it off.
//
// The one reload that must get through is the one that brings a CRASHED page back (3h part 7):
// on Windows WebView2 shows its own error page whose Refresh is that reload, and macOS reloads by
// itself. Measured 2026-10-05: with the guard on, the error page's Refresh was refused and the
// window stayed dead until the app was restarted. So the platform's own "the renderer died" signal
// marks the page, and the next reload of it passes, once.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

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

/// A crashed page reloads itself at most this often, so a page that crashes as it loads cannot
/// spin; the error page's Refresh still works in between.
const AUTO_RELOAD_EVERY: Duration = Duration::from_secs(30);

/// What the guard knows per window: the page it loaded, and whether that page's renderer died.
#[derive(Default)]
pub struct GuardState {
  loaded: Mutex<HashMap<String, Url>>,
  crashed: Mutex<HashSet<String>>,
  auto_reloaded: Mutex<HashMap<String, Instant>>,
}

// A poisoned lock must never stop the app loading or recovering.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
  m.lock().unwrap_or_else(|e| e.into_inner())
}

impl GuardState {
  pub fn page_loaded(&self, label: &str, url: &Url) {
    lock(&self.loaded).insert(label.to_string(), url.clone());
  }

  /// The page's renderer died: the reload that recovers it may pass.
  pub fn renderer_died(&self, label: &str) {
    lock(&self.crashed).insert(label.to_string());
  }

  /// Decide a navigation. The recovery reload of a crashed page passes and uses up the mark, so the
  /// recovered page is guarded again.
  pub fn allow(&self, label: &str, to: &Url) -> bool {
    let loaded = lock(&self.loaded).get(label).cloned();
    if navigation_allowed(loaded.as_ref(), to) {
      return true;
    }
    lock(&self.crashed).remove(label)
  }

  /// Whether a crashed page may be reloaded by the app itself now.
  #[cfg_attr(not(windows), allow(dead_code))]
  pub fn may_auto_reload(&self, label: &str, now: Instant) -> bool {
    let mut last = lock(&self.auto_reloaded);
    match last.get(label) {
      Some(at) if now.duration_since(*at) < AUTO_RELOAD_EVERY => false,
      _ => {
        last.insert(label.to_string(), now);
        true
      }
    }
  }
}

pub fn plugin<R: Runtime>(state: Arc<GuardState>) -> tauri::plugin::TauriPlugin<R> {
  let record = state.clone();
  let decide = state.clone();
  #[cfg_attr(not(windows), allow(unused_variables))]
  let watch = state;
  tauri::plugin::Builder::new("reload-guard")
    .on_page_load(move |webview, payload| {
      if matches!(payload.event(), PageLoadEvent::Finished) {
        record.page_loaded(webview.label(), payload.url());
      }
    })
    .on_navigation(move |webview, to| {
      let allowed = decide.allow(webview.label(), to);
      if !allowed {
        log::info!("reload-guard: refused a reload of the app ({to})");
      }
      allowed
    })
    .on_webview_ready(move |webview| {
      #[cfg(windows)]
      windows::watch_renderer(webview, watch.clone());
      #[cfg(not(windows))]
      let _ = webview;
    })
    .build()
}

/// macOS: Tauri reloads a page whose web content process died; this does the same after marking
/// it, because the guard would otherwise refuse that reload. Registered on the builder.
#[cfg(target_os = "macos")]
pub fn on_web_content_terminated<R: Runtime>(state: &GuardState, webview: &tauri::Webview<R>) {
  state.renderer_died(webview.label());
  log::warn!("reload-guard: the page's web content process died; reloading it");
  if let Err(e) = webview.reload() {
    log::error!("reload-guard: could not reload the page: {e}");
  }
}

#[cfg(windows)]
mod windows {
  use std::sync::Arc;
  use std::time::Instant;

  use tauri::Runtime;
  use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
  };
  use webview2_com::ProcessFailedEventHandler;

  use super::GuardState;

  /// WebView2 raises ProcessFailed when the page's renderer exits or hangs. Mark the page so the
  /// error page's Refresh passes, and reload it at once when the renderer exited.
  pub fn watch_renderer<R: Runtime>(webview: tauri::Webview<R>, state: Arc<GuardState>) {
    let label = webview.label().to_string();
    let reloader = webview.clone();
    let registered = webview.with_webview(move |platform| {
      let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
        if let Some(args) = args {
          // SAFETY: a COM getter on the event's own arguments, during the event.
          let _ = unsafe { args.ProcessFailedKind(&mut kind) };
        }
        let exited = kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED;
        if exited || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE {
          state.renderer_died(&label);
          log::warn!(
            "reload-guard: the page's renderer failed (kind {}); its reload may pass",
            kind.0
          );
          if exited && state.may_auto_reload(&label, Instant::now()) {
            if let Err(e) = reloader.reload() {
              log::error!("reload-guard: could not reload the page: {e}");
            }
          }
        }
        Ok(())
      }));
      let mut token = 0i64;
      // SAFETY: the controller and its CoreWebView2 belong to this webview and are alive for the
      // duration of this callback, which runs on the thread that owns them.
      let result = unsafe {
        platform
          .controller()
          .CoreWebView2()
          .and_then(|core| core.add_ProcessFailed(&handler, &mut token))
      };
      if let Err(e) = result {
        log::warn!("reload-guard: cannot watch the page's renderer: {e}");
      }
    });
    if let Err(e) = registered {
      log::warn!("reload-guard: cannot reach the webview: {e}");
    }
  }
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

  #[test]
  fn the_reload_that_recovers_a_crashed_page_passes_once() {
    let g = GuardState::default();
    let page = u("http://tauri.localhost/p/abc");
    g.page_loaded("main", &page);
    assert!(!g.allow("main", &page), "a live page is never reloaded");
    g.renderer_died("main");
    assert!(g.allow("main", &u("http://tauri.localhost/")), "the recovery reload passes");
    assert!(!g.allow("main", &page), "the recovered page is guarded again");
  }

  #[test]
  fn a_crash_in_one_window_does_not_unguard_another() {
    let g = GuardState::default();
    let page = u("tauri://localhost/");
    g.page_loaded("main", &page);
    g.page_loaded("other", &page);
    g.renderer_died("other");
    assert!(!g.allow("main", &page));
    assert!(g.allow("other", &page));
  }

  #[test]
  fn other_origins_do_not_use_up_the_recovery_reload() {
    let g = GuardState::default();
    let page = u("http://tauri.localhost/p/abc");
    g.page_loaded("main", &page);
    g.renderer_died("main");
    assert!(g.allow("main", &u("about:blank"))); // e.g. the error page
    assert!(g.allow("main", &page), "the reload after it still passes");
  }

  #[test]
  fn a_page_that_keeps_crashing_is_not_reloaded_in_a_loop() {
    let g = GuardState::default();
    let t0 = Instant::now();
    assert!(g.may_auto_reload("main", t0));
    assert!(!g.may_auto_reload("main", t0 + Duration::from_secs(5)));
    assert!(g.may_auto_reload("main", t0 + AUTO_RELOAD_EVERY + Duration::from_secs(1)));
    assert!(g.may_auto_reload("other", t0 + Duration::from_secs(5)), "per window");
  }
}
