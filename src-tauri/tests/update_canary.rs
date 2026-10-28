//! In-place update canary for macOS: the updater half. It is run by scripts/qa/macUpdateCanary.mjs on a
//! disposable GitHub runner, never by a plain `cargo test` (it is #[ignore]d).
//!
//! macOS cannot be driven the way the Windows and Linux canaries drive the app: WKWebView has no remote
//! debugging port, tauri-driver has no macOS backend, and a signed-out app never mounts the update banner.
//! So this runs the SAME updater plugin the app ships (the locked version, with the endpoint and the public
//! key read from tauri.conf.json) against a real installed copy of the previous release's .app: it asks the
//! live manifest, downloads the signed tarball, verifies the signature against the committed key and
//! installs over the running app's bundle, which is what the app's own `install_update` does before it
//! restarts. What it does not cover is the app's command wrappers and `app.restart()`.
//!
//! The Node half installs the old release, starts it, checks the bundle that is left, and starts that.

#![cfg(target_os = "macos")]

use std::{env, path::PathBuf};

use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri_plugin_updater::UpdaterExt;

fn required(name: &str) -> String {
  env::var(name).unwrap_or_else(|_| panic!("{name} is required: this test is driven by scripts/qa/macUpdateCanary.mjs"))
}

#[test]
#[ignore = "needs a disposable macOS runner with the previous release installed; run it through scripts/qa/macUpdateCanary.mjs"]
fn the_installed_app_is_updated_in_place_through_the_live_manifest() {
  let executable = PathBuf::from(required("ARTDADDY_CANARY_EXECUTABLE"));
  let installed_version = required("ARTDADDY_CANARY_FROM");
  assert!(
    executable.to_string_lossy().contains("Contents/MacOS/") && executable.is_file(),
    "{} is not the executable of an installed .app",
    executable.display()
  );

  let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json parses");
  let mut context = mock_context(noop_assets());
  context.config_mut().plugins.0.insert("updater".to_string(), conf["plugins"]["updater"].clone());
  context.package_info_mut().version = installed_version.parse().expect("ARTDADDY_CANARY_FROM is a version");

  let app = mock_builder()
    .plugin(tauri_plugin_updater::Builder::new().build())
    .build(context)
    .expect("the updater plugin starts with the shipped configuration");
  let updater = app
    .updater_builder()
    .executable_path(&executable)
    .build()
    .expect("the updater is built for the installed bundle");

  let update = tauri::async_runtime::block_on(updater.check())
    .expect("the live manifest is readable")
    .expect("the live manifest offers an update to the installed version");
  println!(
    "CANARY-OFFERED {}",
    serde_json::json!({
      "version": update.version,
      "currentVersion": update.current_version,
      "target": update.target,
      "url": update.download_url.to_string(),
      "signatureLength": update.signature.len(),
    })
  );

  let bytes = tauri::async_runtime::block_on(update.download(|_, _| {}, || {})).expect("the update downloads and its signature verifies");
  println!("CANARY-DOWNLOADED {}", bytes.len());

  update.install(&bytes).expect("the update installs over the installed app");
  println!("CANARY-INSTALLED {}", serde_json::json!({ "version": update.version }));
}
