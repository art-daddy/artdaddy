//! Which graphics chips the PC has, by maker: what the export's graphics-chip step reads to decide which encoder to test
//! (exporter document 19.7). Windows only; every other system reports none, so the processor encodes there.
//!
//! Only the maker, the PCI device number and the driver version leave this module. A device's marketing name, its
//! serial or any path does not: the page keys its local cache on the three, and reports the maker alone.

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct GraphicsAdapter {
  /// "amd", "nvidia" or "intel": the three whose encoders the exporter knows.
  pub maker: &'static str,
  /// The PCI device number in lower-case hex ("15bf"), so two cards of one maker can be told apart.
  pub device: String,
  /// The installed driver's version ("32.0.22024.4008"), or empty when the registry does not say.
  pub driver: String,
}

/// The maker and device number of a PCI hardware id as Windows spells it (`PCI\VEN_1002&DEV_15BF&SUBSYS_...&REV_DD`).
/// None for any other bus, any other maker (the software renderer is one), or a malformed id.
#[cfg(any(windows, test))]
fn parse_pci_id(id: &str) -> Option<(&'static str, String)> {
  let upper = id.trim().to_ascii_uppercase();
  let rest = upper.strip_prefix("PCI\\")?;
  let mut vendor = None;
  let mut device = None;
  for part in rest.split('&') {
    if let Some(value) = part.strip_prefix("VEN_") { vendor = Some(value); }
    else if let Some(value) = part.strip_prefix("DEV_") { device = Some(value); }
  }
  let (vendor, device) = (vendor?, device?);
  let hex = |text: &str| text.len() == 4 && text.bytes().all(|byte| byte.is_ascii_hexdigit());
  if !hex(vendor) || !hex(device) { return None; }
  let maker = match vendor {
    "1002" => "amd",
    "10DE" => "nvidia",
    "8086" => "intel",
    _ => return None,
  };
  Some((maker, device.to_ascii_lowercase()))
}

/// The registry path, under the local machine, of a display adapter's driver values, from the `DeviceKey` Windows gives
/// (`\Registry\Machine\System\CurrentControlSet\Control\Video\{GUID}\0000`). None for anything that is not that shape:
/// the value is read from the registry, so it is never taken from a string that could point somewhere else.
#[cfg(any(windows, test))]
fn driver_registry_path(device_key: &str) -> Option<String> {
  const PREFIX: &str = "\\registry\\machine\\";
  let lower = device_key.trim().to_ascii_lowercase();
  if !lower.starts_with(PREFIX) || device_key.len() > 260 { return None; }
  let path = &device_key.trim()[PREFIX.len()..];
  let lower_path = path.to_ascii_lowercase();
  if !lower_path.starts_with("system\\currentcontrolset\\control\\video\\") { return None; }
  let parts: Vec<&str> = path.split('\\').collect();
  // system, currentcontrolset, control, video, {guid}, 0000
  if parts.len() != 6 || parts.iter().any(|part| part.is_empty() || *part == "." || *part == "..") { return None; }
  let guid = parts[4];
  let index = parts[5];
  let guid_ok = guid.len() == 38
    && guid.starts_with('{')
    && guid.ends_with('}')
    && guid[1..37].bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-');
  let index_ok = !index.is_empty() && index.len() <= 4 && index.bytes().all(|byte| byte.is_ascii_digit());
  (guid_ok && index_ok).then(|| path.to_string())
}

#[cfg(windows)]
fn wide_to_string(text: &[u16]) -> String {
  let length = text.iter().position(|character| *character == 0).unwrap_or(text.len());
  String::from_utf16_lossy(&text[..length])
}

#[cfg(windows)]
fn read_driver_version(device_key: &str) -> String {
  use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
  let Some(path) = driver_registry_path(device_key) else { return String::new() };
  let wide = |text: &str| -> Vec<u16> { text.encode_utf16().chain(std::iter::once(0)).collect() };
  let (path, value) = (wide(&path), wide("DriverVersion"));
  let mut buffer = [0u16; 64];
  let mut size = (buffer.len() * 2) as u32;
  let status = unsafe {
    RegGetValueW(HKEY_LOCAL_MACHINE, path.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buffer.as_mut_ptr().cast(), &mut size)
  };
  if status != 0 { return String::new(); }
  let version = wide_to_string(&buffer);
  // A version is digits and dots; anything else is not one and is not passed on.
  if !version.is_empty() && version.len() <= 40 && version.bytes().all(|byte| byte.is_ascii_digit() || byte == b'.') { version } else { String::new() }
}

/// The graphics chips of the three makers whose encoders the exporter knows, one entry per device, in the order Windows lists them.
#[cfg(windows)]
pub(super) fn graphics_adapters() -> Vec<GraphicsAdapter> {
  use windows_sys::Win32::Graphics::Gdi::{EnumDisplayDevicesW, DISPLAY_DEVICEW};
  let mut found: Vec<GraphicsAdapter> = Vec::new();
  // Windows lists one entry per output of an adapter, so the same device repeats; sixteen is far more than any PC has.
  for index in 0..16 {
    let mut display: DISPLAY_DEVICEW = unsafe { std::mem::zeroed() };
    display.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
    if unsafe { EnumDisplayDevicesW(std::ptr::null(), index, &mut display, 0) } == 0 { break; }
    let Some((maker, device)) = parse_pci_id(&wide_to_string(&display.DeviceID)) else { continue };
    if found.iter().any(|adapter| adapter.maker == maker && adapter.device == device) { continue; }
    let driver = read_driver_version(&wide_to_string(&display.DeviceKey));
    found.push(GraphicsAdapter { maker, device, driver });
  }
  found
}

#[cfg(not(windows))]
pub(super) fn graphics_adapters() -> Vec<GraphicsAdapter> { Vec::new() }

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_three_makers_are_told_apart_by_their_pci_vendor_number() {
    assert_eq!(parse_pci_id("PCI\\VEN_1002&DEV_15BF&SUBSYS_50DA17AA&REV_DD"), Some(("amd", "15bf".to_string())));
    assert_eq!(parse_pci_id("PCI\\VEN_10DE&DEV_2504&SUBSYS_00001043&REV_A1"), Some(("nvidia", "2504".to_string())));
    assert_eq!(parse_pci_id("PCI\\VEN_8086&DEV_9A49&SUBSYS_0A01&REV_01"), Some(("intel", "9a49".to_string())));
    // Case and surrounding space do not matter; the device number is always lower case.
    assert_eq!(parse_pci_id("  pci\\ven_10de&dev_ABCD  "), Some(("nvidia", "abcd".to_string())));
  }

  #[test]
  fn anything_else_is_no_graphics_chip_the_exporter_knows() {
    for id in [
      "",
      "PCI\\VEN_1414&DEV_008C&SUBSYS_0000&REV_00", // the software renderer
      "ROOT\\BasicDisplay\\0000",
      "USB\\VEN_1002&DEV_15BF",
      "PCI\\VEN_1002",
      "PCI\\DEV_15BF",
      "PCI\\VEN_100&DEV_15BF",
      "PCI\\VEN_ZZZZ&DEV_15BF",
      "PCI\\VEN_1002&DEV_15B",
      "VEN_1002&DEV_15BF",
    ] {
      assert_eq!(parse_pci_id(id), None, "{id:?}");
    }
  }

  #[test]
  fn whatever_a_device_id_says_nothing_but_a_known_maker_and_four_hex_digits_comes_out() {
    // A small sweep of the shapes a hardware id could take: nothing outside the closed set may be produced.
    for vendor in ["1002", "10de", "8086", "1414", "abcd", "ABCD", "00000", "", "10 02"] {
      for device in ["15bf", "15BF", "", "15", "15bfx", "zzzz"] {
        let id = format!("PCI\\VEN_{vendor}&DEV_{device}&SUBSYS_1&REV_1");
        if let Some((maker, found)) = parse_pci_id(&id) {
          assert!(["amd", "nvidia", "intel"].contains(&maker), "{id}");
          assert_eq!(found.len(), 4, "{id}");
          assert!(found.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()), "{id}");
        }
      }
    }
  }

  #[test]
  fn the_driver_is_read_only_from_a_display_adapters_own_registry_key() {
    let guid = "{A532272A-A5F1-11F0-8044-9306FB32665D}";
    assert_eq!(
      driver_registry_path(&format!("\\Registry\\Machine\\System\\CurrentControlSet\\Control\\Video\\{guid}\\0000")),
      Some(format!("System\\CurrentControlSet\\Control\\Video\\{guid}\\0000"))
    );
    assert_eq!(
      driver_registry_path(&format!("\\REGISTRY\\MACHINE\\SYSTEM\\CURRENTCONTROLSET\\CONTROL\\VIDEO\\{guid}\\0003")),
      Some(format!("SYSTEM\\CURRENTCONTROLSET\\CONTROL\\VIDEO\\{guid}\\0003"))
    );
  }

  #[test]
  fn a_key_that_points_anywhere_else_is_not_followed() {
    let guid = "{A532272A-A5F1-11F0-8044-9306FB32665D}";
    for key in [
      String::new(),
      "System\\CurrentControlSet\\Control\\Video\\{A532272A-A5F1-11F0-8044-9306FB32665D}\\0000".to_string(),
      format!("\\Registry\\User\\S-1-5-18\\Control\\Video\\{guid}\\0000"),
      format!("\\Registry\\Machine\\Software\\Evil\\Control\\Video\\{guid}\\0000"),
      format!("\\Registry\\Machine\\System\\CurrentControlSet\\Control\\Video\\{guid}\\..\\..\\Services"),
      format!("\\Registry\\Machine\\System\\CurrentControlSet\\Control\\Video\\{guid}\\0000\\Extra"),
      "\\Registry\\Machine\\System\\CurrentControlSet\\Control\\Video\\{not-a-guid}\\0000".to_string(),
      format!("\\Registry\\Machine\\System\\CurrentControlSet\\Control\\Video\\{guid}\\00x0"),
      format!("\\Registry\\Machine\\System\\CurrentControlSet\\Control\\Video\\{guid}\\"),
      format!("\\Registry\\Machine\\System\\CurrentControlSet\\Control\\Video\\{guid}\\00000"),
      format!("\\Registry\\Machine\\System\\CurrentControlSet\\Control\\Video\\{}\\0000", "a".repeat(300)),
    ] {
      assert_eq!(driver_registry_path(&key), None, "{key:?}");
    }
  }

  #[test]
  fn an_adapter_reports_only_its_maker_its_device_number_and_its_driver() {
    let adapter = GraphicsAdapter { maker: "amd", device: "15bf".into(), driver: "32.0.22024.4008".into() };
    let json = serde_json::to_value(&adapter).unwrap();
    assert_eq!(json, serde_json::json!({ "maker": "amd", "device": "15bf", "driver": "32.0.22024.4008" }));
  }

  /// This PC has a graphics chip of a maker the exporter knows, each listed once; the same call is what the app makes.
  /// Hardware-dependent, so it runs on request (`cargo test -- --ignored adapters_of_this_pc`).
  #[test]
  #[ignore = "reads this PC's graphics adapters"]
  fn adapters_of_this_pc() {
    let found = graphics_adapters();
    eprintln!("adapters: {found:?}");
    for (index, adapter) in found.iter().enumerate() {
      assert!(["amd", "nvidia", "intel"].contains(&adapter.maker));
      assert!(!found[..index].iter().any(|other| other.maker == adapter.maker && other.device == adapter.device), "listed twice: {adapter:?}");
    }
  }
}
