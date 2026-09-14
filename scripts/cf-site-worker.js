// artdaddy.app -> the Azure static-website origin.
//
// Cloudflare must proxy (blob static hosting cannot terminate HTTPS for a custom domain), but
// Azure routes by Host and answers anything else with 400 InvalidUri. The usual fix is an Origin
// Rule host_header override, which is a PAID feature ("not entitled to use the HostHeader
// override" on Free), so the rewrite happens here instead.
const ORIGIN = "artdaddysite.z13.web.core.windows.net";
const APEX = "artdaddy.app";

addEventListener("fetch", (event) => {
  event.respondWith(handle(event.request));
});

async function handle(request) {
  const url = new URL(request.url);

  if (url.hostname.startsWith("www.")) {
    url.hostname = APEX;
    return Response.redirect(url.toString(), 301);
  }

  // Rewriting the URL's hostname is what sets the Host the origin sees; setting a Host header
  // by hand is ignored by the runtime.
  const target = new URL(url.pathname + url.search, `https://${ORIGIN}`);
  const res = await fetch(target.toString(), {
    method: request.method,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "follow",
  });

  // Copy into a fresh Headers: the headers on a Response built from another Response are
  // immutable, so setting cache-control on it threw and every HTML request 500'd while the
  // assets (which skip this branch) served fine.
  const headers = new Headers();
  for (const [k, v] of res.headers) headers.set(k, v);
  const type = headers.get("content-type") || "";
  // The page itself must never be cached hard, or a release ships and visitors keep seeing the
  // previous version's download links.
  if (type.includes("text/html")) headers.set("cache-control", "no-cache, max-age=0");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
