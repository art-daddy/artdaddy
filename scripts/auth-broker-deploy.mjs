#!/usr/bin/env node
// Retired. artdaddy.app moved from the artdaddysite storage account to Cloudflare Pages,
// served out of the akaru-landing repo — so this script's upload target is no longer read
// by anyone. Kept as a refusal rather than deleted because it used to WORK, and a deploy
// that reports success while reaching nobody is the worst way to discover the move.
//
// The page itself still lives here, at auth-broker/index.html: it is coupled to the app's
// deep-link scheme and to the server's /auth/desktop endpoints, and its test sits beside it.
// Publishing is the landing repo's job now, and a drift guard in brand.drift.test.ts fails
// if the copy that repo serves falls behind this one.
console.error(
  [
    "auth-broker:deploy is retired - artdaddy.app is served from Cloudflare Pages now.",
    "",
    "  1. copy auth-broker/index.html -> <akaru-landing>/landing/auth/index.html",
    "  2. cd <akaru-landing> && npm run deploy",
    "",
    "Uploading to the artdaddysite storage account would succeed and reach nobody.",
  ].join("\n"),
);
process.exit(1);
