//! The update feed as the app reads it, on every system.
//!
//! An installed app learns about an update from one file, the endpoint in tauri.conf.json
//! (https://artdaddy.app/updates/latest.json). That file is written in the landing site's repository
//! (`landing/updates/latest.json`: the version, notes and date by hand, each platform's entry by its
//! `scripts/add-platform-update.mjs`) and goes live when that repository's `main` is deployed.
//! `fixtures/updater/latest-0.29.1.json` is the live file of 26 Nov 2026, byte for byte.
//!
//! The app reads it the way `Updater::check` does: the body as JSON, then the updater plugin's own
//! `RemoteRelease`. So a plugin update that reads the feed differently fails here, and so does a feed the app
//! cannot read. scripts/updateFeed.test.mjs holds the writer's side to the same bytes; what the app then does
//! with a feed it has read (offer, download, verify the signature) is tests/update_signature.rs.

#![cfg(not(any(target_os = "android", target_os = "ios")))]

use serde_json::{json, Value};
use tauri_plugin_updater::RemoteRelease;

const GOLDEN: &str = include_str!("fixtures/updater/latest-0.29.1.json");
const REPOSITORY: &str = "art-daddy/artdaddy";
/// Each platform key an installed app looks itself up by, and the version-less asset the release carries.
const PLATFORMS: [(&str, &str); 3] = [
  ("windows-x86_64", "ArtDaddy-windows-x64-setup.exe"),
  ("darwin-aarch64", "ArtDaddy-macos-arm64.app.tar.gz"),
  ("linux-x86_64", "ArtDaddy-linux-x86_64.AppImage"),
];

/// What the app does with the body of the feed's response.
fn read(body: &[u8]) -> Result<RemoteRelease, serde_json::Error> {
  serde_json::from_slice::<Value>(body).and_then(serde_json::from_value::<RemoteRelease>)
}

fn golden() -> Value {
  serde_json::from_str(GOLDEN).expect("the live feed is JSON")
}

fn entry<'a>(release: &'a RemoteRelease, platform: &str) -> Option<(String, &'a str)> {
  match (release.download_url(platform), release.signature(platform)) {
    (Ok(url), Ok(signature)) => Some((url.to_string(), signature.as_str())),
    _ => None,
  }
}

#[test]
fn the_shipped_app_asks_for_the_live_feed_over_https() {
  let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
  assert_eq!(conf["plugins"]["updater"]["endpoints"], json!(["https://artdaddy.app/updates/latest.json"]));
  assert_ne!(conf["plugins"]["updater"]["dangerousInsecureTransportProtocol"], json!(true));
  assert_ne!(conf["plugins"]["updater"]["dangerousAcceptInvalidCerts"], json!(true));
  assert_ne!(conf["plugins"]["updater"]["dangerousAcceptInvalidHostnames"], json!(true));
}

#[test]
fn the_live_feed_is_read_as_the_release_wrote_it() {
  let release = read(GOLDEN.as_bytes()).expect("the app reads the live feed");
  let written = golden();
  assert_eq!(release.version.to_string(), "0.29.1");
  assert_eq!(release.notes.as_deref(), written["notes"].as_str());
  let date = release.pub_date.expect("the live feed carries its date");
  assert_eq!((date.year(), date.month() as u8, date.day(), date.hour(), date.minute()), (2026, 11, 21, 11, 29));
  for (platform, asset) in PLATFORMS {
    let (url, signature) = entry(&release, platform).unwrap_or_else(|| panic!("the live feed offers {platform}"));
    assert_eq!(url, format!("https://github.com/{REPOSITORY}/releases/download/v0.29.1/{asset}"));
    assert_eq!(Some(signature), written["platforms"][platform]["signature"].as_str());
    // The updater first asks for `<platform>-<installer>`; the feed has none, so the entries above are what serve.
    for installer in ["nsis", "msi", "app", "appimage", "deb"] {
      assert!(entry(&release, &format!("{platform}-{installer}")).is_none(), "{platform}-{installer}");
    }
  }
}

/// A cut-off download (a proxy, a full disk on the host) is never half-read into an offer.
#[test]
fn every_cut_off_copy_of_the_live_feed_is_refused() {
  let bytes = GOLDEN.as_bytes();
  let complete = GOLDEN.trim_end().len();
  for cut in 0..bytes.len() {
    let result = read(&bytes[..cut]);
    if cut < complete {
      assert!(result.is_err(), "the first {cut} bytes were read as a feed");
    } else {
      assert!(result.is_ok(), "the feed without its final newline is still the feed");
    }
  }
}

fn with(change: impl FnOnce(&mut Value)) -> Vec<u8> {
  let mut feed = golden();
  change(&mut feed);
  serde_json::to_vec_pretty(&feed).unwrap()
}

#[test]
fn a_broken_or_hostile_feed_is_refused_whole() {
  let mut bom = b"\xEF\xBB\xBF".to_vec();
  bom.extend_from_slice(GOLDEN.as_bytes());
  let cases: Vec<(&str, Vec<u8>)> = vec![
    ("an empty body", Vec::new()),
    ("a gateway's HTML page", b"<html><body>502 Bad Gateway</body></html>".to_vec()),
    ("the live feed behind a byte-order mark", bom),
    ("JSON that is not an object", b"[\"0.30.0\"]".to_vec()),
    ("null", b"null".to_vec()),
    ("a number for the version", with(|f| f["version"] = json!(30))),
    ("a version with two parts", with(|f| f["version"] = json!("0.30"))),
    ("a version with four parts", with(|f| f["version"] = json!("0.30.0.0"))),
    ("a version that is a word", with(|f| f["version"] = json!("latest"))),
    ("an empty version", with(|f| f["version"] = json!(""))),
    ("no version", with(|f| drop(f.as_object_mut().unwrap().remove("version")))),
    ("a date without a time", with(|f| f["pub_date"] = json!("2026-11-21"))),
    ("a date with no time zone", with(|f| f["pub_date"] = json!("2026-11-21T11:29:40"))),
    ("a date in another order", with(|f| f["pub_date"] = json!("21/11/2026 11:29:40Z"))),
    ("a date that does not exist", with(|f| f["pub_date"] = json!("2026-02-30T11:29:40Z"))),
    ("a number for the date", with(|f| f["pub_date"] = json!(1_795_258_631))),
    ("notes that are not text", with(|f| f["notes"] = json!({ "en": "notes" }))),
    ("platforms as a list", with(|f| f["platforms"] = json!([]))),
    ("no platforms and no url", with(|f| drop(f.as_object_mut().unwrap().remove("platforms")))),
    ("an entry with no signature", with(|f| drop(f["platforms"]["linux-x86_64"].as_object_mut().unwrap().remove("signature")))),
    ("an entry with no url", with(|f| drop(f["platforms"]["linux-x86_64"].as_object_mut().unwrap().remove("url")))),
    ("a url that is not a url", with(|f| f["platforms"]["linux-x86_64"]["url"] = json!("not a url"))),
    ("a number for a signature", with(|f| f["platforms"]["linux-x86_64"]["signature"] = json!(7))),
    ("an entry that is text", with(|f| f["platforms"]["linux-x86_64"] = json!("https://example.com/x"))),
  ];
  for (label, body) in cases {
    assert!(read(&body).is_err(), "{label} was read as a feed");
  }
}

/// The feed is one file for every system: a broken entry for one platform stops the update on all of them.
/// Worth knowing when a single platform's entry is edited by hand.
#[test]
fn one_broken_platform_entry_stops_the_update_for_every_platform() {
  let feed = with(|f| f["platforms"]["linux-x86_64"]["url"] = json!("ArtDaddy-linux-x86_64.AppImage"));
  assert!(read(&feed).is_err());
  let feed = with(|f| f["pub_date"] = json!("2026-11-21"));
  assert!(read(&feed).is_err(), "and so does a date written without its time");
}

/// What a later feed may add without stranding the apps already installed: they must still read it.
#[test]
fn a_feed_with_fields_and_platforms_this_app_does_not_know_is_still_read() {
  let feed = with(|f| {
    f["minimum_version"] = json!("0.20.0");
    f["mandatory"] = json!(true);
    f["platforms"]["windows-aarch64"] = json!({ "url": "https://example.com/a", "signature": "c2ln" });
    f["platforms"]["linux-x86_64"]["size"] = json!(476_674_552);
  });
  let release = read(&feed).expect("an addition to the feed is ignored by this app");
  for (platform, _) in PLATFORMS {
    assert_eq!(entry(&release, platform).map(|(_, s)| s.to_string()), golden()["platforms"][platform]["signature"].as_str().map(String::from));
  }
}

#[test]
fn very_long_notes_are_read_whole() {
  let notes = "Ünïcode \"quoted\" notes, <b>not</b> markup, with a \\ and a\nnew line. ".repeat(80_000);
  let release = read(&with(|f| f["notes"] = json!(notes))).expect("read");
  assert_eq!(release.notes.as_deref(), Some(notes.as_str()));
}

// ---------------------------------------------------------------------------------------------------------------
// Fuzz, both ways, with a seeded generator so a failure can be replayed: nothing the network can do to the feed
// crashes the reader, and nothing a release can legitimately write is refused or changed.

struct Rng(u64);

impl Rng {
  fn next(&mut self) -> u64 {
    self.0 ^= self.0 << 13;
    self.0 ^= self.0 >> 7;
    self.0 ^= self.0 << 17;
    self.0
  }
  fn below(&mut self, n: usize) -> usize {
    (self.next() % n.max(1) as u64) as usize
  }
  fn chance(&mut self, percent: u64) -> bool {
    self.next() % 100 < percent
  }
}

#[test]
fn a_corrupted_feed_never_crashes_the_reader() {
  const NOISE: &[u8] = b"{}[]\":,\\0123456789-.eE \n\xFF";
  let source = GOLDEN.as_bytes();
  for seed in 1..=4_000u64 {
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let mut bytes = source.to_vec();
    for _ in 0..=rng.below(4) {
      let at = rng.below(bytes.len());
      match rng.below(5) {
        0 => bytes[at] = rng.next() as u8,
        1 => {
          let end = (at + rng.below(64)).min(bytes.len());
          bytes.drain(at..end);
        }
        2 => {
          let end = (at + rng.below(64)).min(bytes.len());
          let copy = bytes[at..end].to_vec();
          let tail = bytes.split_off(at);
          bytes.extend_from_slice(&copy);
          bytes.extend_from_slice(&tail);
        }
        3 => bytes.insert(at, NOISE[rng.below(NOISE.len())]),
        _ => bytes.truncate(at),
      }
      if bytes.is_empty() {
        break;
      }
    }
    let outcome = std::panic::catch_unwind(|| read(&bytes).map(|release| release.version.to_string()));
    assert!(outcome.is_ok(), "seed {seed}: the reader panicked");
  }
}

fn arbitrary_text(rng: &mut Rng) -> String {
  const PIECES: [&str; 12] = ["a", "Z", " ", "\n", "\t", "\"", "\\", "é", "日本", "🎬", "<b>", "\u{0}"];
  (0..rng.below(300)).map(|_| PIECES[rng.below(PIECES.len())]).collect()
}

fn arbitrary_date(rng: &mut Rng) -> String {
  let fraction = match rng.below(3) {
    0 => String::new(),
    1 => format!(".{:03}", rng.below(1000)),
    _ => format!(".{:09}", rng.below(1_000_000_000)),
  };
  let zone = if rng.chance(50) { "Z".to_string() } else { format!("{}{:02}:{:02}", if rng.chance(50) { '+' } else { '-' }, rng.below(14), [0, 30, 45][rng.below(3)]) };
  format!(
    "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{fraction}{zone}",
    2000 + rng.below(100),
    1 + rng.below(12),
    1 + rng.below(28),
    rng.below(24),
    rng.below(60),
    rng.below(60)
  )
}

#[test]
fn every_feed_a_release_can_write_is_read_unchanged() {
  for seed in 1..=1_500u64 {
    let mut rng = Rng(seed.wrapping_mul(0xD1B5_4A32_D192_ED03) | 1);
    let version = format!("{}.{}.{}", rng.below(3), rng.below(100), rng.below(100));
    let notes = arbitrary_text(&mut rng);
    let date = arbitrary_date(&mut rng);
    let mut platforms = serde_json::Map::new();
    let mut present = Vec::new();
    for (platform, asset) in PLATFORMS {
      if rng.chance(70) {
        let signature: String = (0..rng.below(600) + 1).map(|_| "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="[rng.below(65)..][..1].to_string()).collect();
        let url = format!("https://github.com/{REPOSITORY}/releases/download/v{version}/{asset}");
        platforms.insert(platform.to_string(), json!({ "signature": signature, "url": url }));
        present.push((platform, url, signature));
      }
    }
    let feed = json!({ "version": version, "notes": notes, "pub_date": date, "platforms": platforms });
    let body = if rng.chance(50) { serde_json::to_vec_pretty(&feed).unwrap() } else { serde_json::to_vec(&feed).unwrap() };

    let release = read(&body).unwrap_or_else(|e| panic!("seed {seed}: a valid feed was refused: {e}\n{feed}"));
    assert_eq!(release.version.to_string(), version, "seed {seed}");
    assert_eq!(release.notes.as_deref(), Some(notes.as_str()), "seed {seed}");
    assert!(release.pub_date.is_some(), "seed {seed}: {date}");
    for (platform, _) in PLATFORMS {
      let expected = present.iter().find(|(p, _, _)| *p == platform).map(|(_, url, signature)| (url.clone(), signature.as_str()));
      assert_eq!(entry(&release, platform), expected, "seed {seed}: {platform}");
    }
  }
}
