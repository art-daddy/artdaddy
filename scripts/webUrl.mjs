// The one rule for which URLs the app's network tools may open: http and https pages only.
// Shared by the browser sidecar (it checks before page.goto, the deepest point) and the tools that
// pass a URL on. Chromium will happily render file:///C:/... to a screenshot, so without this an
// agent could read any local text file the user can, as an image.

/** True for an absolute http:// or https:// URL with a host; everything else is refused. */
export function isWebUrl(url) {
  if (typeof url !== "string") return false;
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return false;
  }
  return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
}
