fn main() {
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
    cc::Build::new()
      .file("src/macos_quit.m")
      .flag("-fobjc-arc")
      .compile("artdaddy_macos_quit");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rerun-if-changed=src/macos_quit.m");
  }
  tauri_build::build()
}
