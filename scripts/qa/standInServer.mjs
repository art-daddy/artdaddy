// A stand-in for the ArtDaddy service, for real-app QA runs that must not reach a real server.
//
// The desktop app will not open its editor until the service has checked the build (POST /client/compatibility,
// src/update/compatibility.ts). With no service it stops on "Verifying ArtDaddy", so a lane that points the app at a
// closed port can never get past the start screen. This answers that one check, "supported", for whatever catalog the
// app presents, and refuses every other request with 503: nothing here can reach a model or spend money. Each request
// is logged (method, path, status) so a run can show which routes the app tried.
//
//   node scripts/qa/standInServer.mjs [--port 8790] [--log <file>]
//
// Then serve the app's page with VITE_API_BASE_URL=http://127.0.0.1:<port> (scripts/qa/nightlyTiming.ps1 and the
// desktop-e2e job in .github/workflows/ci.yml do both).
import { appendFileSync } from "node:fs";
import http from "node:http";

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};
const port = Number(arg("port", "8790"));
const logFile = arg("log", "");

function cors(req, res) {
  // The dev app's page (http://localhost:5173) calls this from another origin, with its own headers.
  res.setHeader("access-control-allow-origin", req.headers.origin || "*");
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    req.headers["access-control-request-headers"] || "content-type, authorization",
  );
  res.setHeader("vary", "origin");
}

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    cors(req, res);
    const path = (req.url || "/").split("?")[0];
    let status = 503;
    if (req.method === "OPTIONS") {
      status = 204;
      res.writeHead(204);
      res.end();
    } else if (req.method === "POST" && path === "/client/compatibility") {
      let catalog = null;
      try {
        catalog = JSON.parse(body).catalog_id ?? null;
      } catch {
        /* answered below as a bad request */
      }
      status = typeof catalog === "string" && catalog ? 200 : 400;
      if (status === 200)
        reply(res, 200, { catalog_id: catalog, supported: true, required_update: false });
      else reply(res, 400, { detail: "catalog_id is required" });
    } else {
      reply(res, 503, { detail: "QA stand-in: no service here" });
    }
    const line = `${new Date().toISOString()} ${req.method} ${path} ${status}`;
    console.log(line);
    if (logFile) appendFileSync(logFile, `${line}\n`);
  });
});

server.listen(port, "127.0.0.1", () =>
  console.log(`QA stand-in service on http://127.0.0.1:${port}`),
);
