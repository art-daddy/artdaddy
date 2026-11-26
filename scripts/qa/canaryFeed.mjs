// What the three update canaries (scripts/qa/{windows,linux,mac}UpdateCanary.mjs) share about the feed an installed
// app updates through: the staged feed of a candidate when this run serves one (stagedFeed.mjs, before the switch),
// else the live feed (after it); and the release to install first.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { FEED_URL, isVersion, previousRelease } from "../updateFeed.mjs";

/** The staged feed this runner serves at the live feed's address, if any. */
export const STAGED_FEED = process.env.STAGED_FEED ?? "";

/** The feed an installed app on this runner reads: the staged one when this run serves one, else the live one. */
export async function feedTheAppReads() {
  if (STAGED_FEED) return JSON.parse(readFileSync(STAGED_FEED, "utf8"));
  const response = await fetch(FEED_URL, { headers: { "cache-control": "no-cache" } });
  if (!response.ok) throw new Error(`${FEED_URL} answered ${response.status}`);
  return response.json();
}

/** The release to install first: FROM_VERSION when given, else the latest shipped release older than `target`. */
export function releaseToUpdateFrom(repository, target) {
  const given = process.env.FROM_VERSION ?? "";
  if (given) {
    if (!isVersion(given)) throw new Error(`FROM_VERSION must be x.y.z, not "${given}"`);
    return given;
  }
  // Only the fields the rule reads: a full release (its notes, every asset) is about 13 KB, so a page of them would
  // outgrow spawnSync's default 1 MB buffer at about 80 releases.
  const listed = spawnSync(
    "gh",
    [
      "api",
      `repos/${repository}/releases?per_page=100`,
      "--jq",
      "[.[] | {tag_name, draft, prerelease}]",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (listed.error || listed.status !== 0) {
    throw new Error(
      `could not list the releases of ${repository}: ${listed.error?.message ?? listed.stderr}`,
    );
  }
  const from = previousRelease(JSON.parse(listed.stdout), target);
  if (!from) throw new Error(`no shipped release of ${repository} is older than ${target}`);
  return from;
}

/** Every request the staged feed's server answered, oldest first. */
export function stagedFeedRequests() {
  const log = process.env.STAGED_FEED_LOG;
  if (!log) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** The app's own updater (it names itself in its user agent) asked this runner's staged feed for the update. */
export const updaterReadTheStagedFeed = () =>
  stagedFeedRequests().some(
    (request) =>
      request.path === new URL(FEED_URL).pathname &&
      request.userAgent.startsWith("tauri-plugin-updater/"),
  );
