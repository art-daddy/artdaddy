// The export lane's stand-in for the ArtDaddy server. The desktop app will not unlock until a server says
// its build is supported (CompatibilityGate), and an export reads a few things from the server on the way
// (its switches, the watermark policy) and reports its end there. This answers the one question the gate
// asks and refuses everything else, so a run can reach no model, no vendor and no real account: an AI
// request fails at once instead of billing. With the switches refused the app keeps its compiled defaults
// (api/exportFlags.ts), which is what the server's file says too; with the policy refused the export is
// branded, as it is for every account not marked exempt.
//
// It records the method and path of every request (no bodies), so the run's report shows what the app
// asked for.
import http from "node:http";

export const BACKEND_PORT = Number(process.env.ARTDADDY_QA_EXPORT_API_PORT || 8287);

export async function startBackend(port = BACKEND_PORT) {
  const seen = [];
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stand-in");
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    seen.push(`${req.method} ${url.pathname}`);
    let body = "";
    req.on("data", (chunk) => {
      if (body.length < 65536) body += chunk;
    });
    req.on("end", () => {
      if (req.method === "POST" && url.pathname === "/client/compatibility") {
        let catalog = null;
        try {
          catalog = JSON.parse(body).catalog_id ?? null;
        } catch {
          /* answered as unsupported below */
        }
        const supported = typeof catalog === "string" && catalog.length > 0;
        res.writeHead(200, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ catalog_id: catalog, supported, required_update: !supported }));
        return;
      }
      res.writeHead(503, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not served by the export lane's stand-in server" }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
