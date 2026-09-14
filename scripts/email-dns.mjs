// Apply the mail DNS for artdaddy.app via the Cloudflare API.
//
// Reconciles each logical record as a SET, so switching provider replaces the old records
// instead of adding to them — two providers' MX live side by side otherwise and mail keeps
// arriving at the one you thought you left. Re-running is a no-op.
//
// DKIM and the ownership token are generated inside the provider's admin console and are
// unique per account, so they arrive as flags once you have signed up.
//
//   $env:CLOUDFLARE_API_TOKEN = "..."           # scoped Zone:DNS:Edit
//   node scripts/email-dns.mjs --dry-run
//   node scripts/email-dns.mjs                  # defaults: --provider=zoho --region=in
//   node scripts/email-dns.mjs --provider=google
//   node scripts/email-dns.mjs --verify=zoho-verification=zb12345678.zmverify.zoho.in
//   node scripts/email-dns.mjs --dkim="v=DKIM1; k=rsa; p=MIIBI..." --selector=zoho

const ZONE_NAME = "artdaddy.app";
const API = "https://api.cloudflare.com/client/v4";

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) {
  console.error("CLOUDFLARE_API_TOKEN is not set (needs Zone:DNS:Edit on " + ZONE_NAME + ")");
  process.exit(1);
}

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

async function cf(path, init = {}) {
  const r = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.success === false) {
    const msg = (body.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ");
    throw new Error(`${init.method ?? "GET"} ${path} -> ${r.status} ${msg || "unknown error"}`);
  }
  return body.result;
}

/** The API returns TXT content wrapped in quotes but accepts it either way. */
const unquote = (s) => s.replace(/^"(.*)"$/s, "$1");

/** Zoho's MX hosts are per DATA CENTRE and the centre is fixed when the account is created.
 *  Pointing DNS at a centre the account does not live in fails silently — mail is simply
 *  rejected — so --region must match the domain you signed up on (zoho.in vs zoho.com). */
const REGION = flag("region") ?? "in";
const PROVIDER = flag("provider") ?? "zoho";

const PROVIDERS = {
  google: {
    mx: [{ content: "smtp.google.com", priority: 1 }],
    spf: "include:_spf.google.com",
    dkimHost: `google._domainkey.${ZONE_NAME}`,
    verifyTag: "google-site-verification",
  },
  zoho: {
    mx: [
      { content: `mx.zoho.${REGION}`, priority: 10 },
      { content: `mx2.zoho.${REGION}`, priority: 20 },
      { content: `mx3.zoho.${REGION}`, priority: 50 },
    ],
    spf: `include:zoho.${REGION}`,
    // Zoho issues the selector with the domain; ours came back as zmail, not the zoho the
    // docs use as an example. Wrong selector = DKIM silently never validates.
    dkimHost: `${flag("selector") ?? "zmail"}._domainkey.${ZONE_NAME}`,
    verifyTag: "zoho-verification",
  },
};

const p = PROVIDERS[PROVIDER];
if (!p) throw new Error(`unknown --provider=${PROVIDER} (expected google or zoho)`);

const GROUPS = [
  { label: "MX", type: "MX", name: ZONE_NAME, match: () => true, want: p.mx },
  {
    label: "SPF",
    type: "TXT",
    name: ZONE_NAME,
    // ~all (softfail) not -all: while rolling out, a legitimate forwarder that breaks SPF
    // should land in spam rather than vanish. Tighten once DMARC reports look clean.
    match: (r) => unquote(r.content).startsWith("v=spf1"),
    want: [{ content: `v=spf1 ${p.spf} ~all` }],
  },
  {
    label: "DMARC",
    type: "TXT",
    name: `_dmarc.${ZONE_NAME}`,
    // p=none observes only: it changes NO delivery, it asks receivers for reports so we can
    // see who sends as us before enforcing.
    match: (r) => unquote(r.content).startsWith("v=DMARC1"),
    want: [{ content: "v=DMARC1; p=none; rua=mailto:dmarc@artdaddy.app; fo=1" }],
  },
];

const verify = flag("verify");
if (verify) {
  GROUPS.push({
    label: "verify",
    type: "TXT",
    name: ZONE_NAME,
    match: (r) => unquote(r.content).includes(p.verifyTag),
    want: [{ content: verify }],
  });
}

const dkim = flag("dkim");
if (dkim) {
  GROUPS.push({
    label: "DKIM",
    type: "TXT",
    name: p.dkimHost,
    match: (r) => unquote(r.content).includes("DKIM1"),
    want: [{ content: dkim }],
  });
}

const zones = await cf(`/zones?name=${encodeURIComponent(ZONE_NAME)}`);
if (!zones.length) throw new Error(`zone ${ZONE_NAME} not found — is the token scoped to it?`);
const zone = zones[0];
console.log(`zone ${zone.name} (${zone.id})  provider=${PROVIDER}`);
if (PROVIDER === "zoho") console.log(`data centre: zoho.${REGION}`);
console.log("");

const existing = await cf(`/zones/${zone.id}/dns_records?per_page=200`);

const short = (s) => (s.length > 56 ? s.slice(0, 53) + "..." : s);

for (const g of GROUPS) {
  // Reconcile the whole SET, never one record: switching provider turns 1 MX into 3 (or 3
  // into 1), and an update-in-place would leave the old host live alongside the new one —
  // mail would keep flowing to the provider we just left.
  const have = existing.filter((r) => r.type === g.type && r.name === g.name && g.match(r));
  const pending = [...g.want];
  const spare = [];

  for (const r of have) {
    const i = pending.findIndex(
      (w) =>
        unquote(r.content) === unquote(w.content) && (w.priority ?? null) === (r.priority ?? null),
    );
    if (i >= 0) {
      pending.splice(i, 1);
      console.log(`ok      ${g.label.padEnd(6)} ${short(unquote(r.content))}`);
    } else spare.push(r);
  }

  const body = (w) => ({
    type: g.type,
    name: g.name,
    content: w.content,
    ttl: 1,
    ...(w.priority !== undefined ? { priority: w.priority } : {}),
  });

  while (pending.length && spare.length) {
    const w = pending.shift();
    const r = spare.shift();
    if (DRY) console.log(`UPDATE  ${g.label.padEnd(6)} ${short(w.content)}`);
    else {
      await cf(`/zones/${zone.id}/dns_records/${r.id}`, {
        method: "PUT",
        body: JSON.stringify(body(w)),
      });
      console.log(`updated ${g.label.padEnd(6)} ${short(w.content)}`);
    }
  }
  for (const w of pending) {
    if (DRY) console.log(`CREATE  ${g.label.padEnd(6)} ${short(w.content)}`);
    else {
      await cf(`/zones/${zone.id}/dns_records`, { method: "POST", body: JSON.stringify(body(w)) });
      console.log(`created ${g.label.padEnd(6)} ${short(w.content)}`);
    }
  }
  for (const r of spare) {
    if (DRY) console.log(`DELETE  ${g.label.padEnd(6)} ${short(unquote(r.content))} (stale)`);
    else {
      await cf(`/zones/${zone.id}/dns_records/${r.id}`, { method: "DELETE" });
      console.log(`deleted ${g.label.padEnd(6)} ${short(unquote(r.content))} (stale)`);
    }
  }
}

const admin = PROVIDER === "zoho" ? "Zoho Mail Admin" : "Google Admin";
if (!dkim) console.log(`\nDKIM not applied — generate it in ${admin}, then re-run with --dkim=`);
if (!verify) console.log(`Ownership TXT not applied — pass --verify= when ${admin} asks for one.`);
