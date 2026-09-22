// P0 canary reference PocketBase-compatible server.
//
// The original planboard app (the P0 PB implementation) was not portable:
// it lived only on the old working machine and was removed from this host,
// so the P0 cross-host canary lost its PB side. This reference server
// implements the exact gateway<->PB contract that mcp-gateway consumes
// (verified against crates/mcp-gateway/src/remote.rs):
//   GET  /api/health
//   GET  /api/key                        (Bearer API key)
//   POST /api/key                        (bootstrap; open in canary)
//   GET  /api/gateway/workflows          (Bearer API key)
//   POST /api/internal/human-approval    (Bearer approval secret)
// and persists keys/approval receipts to a local SQLite file via node:sqlite
// so journal/usage semantics match a real PB-backed deployment for the
// duration of the canary run.
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";

const PORT = Number(process.env.PB_PORT || 8090);
const DB_PATH = process.env.PB_DATA;
const API_KEY = process.env.PB_KEY;
const APPROVAL_SECRET = process.env.PB_APPROVAL_SECRET;
const WORKFLOW_FILE = process.env.PB_WORKFLOW_FILE;
const OWNER_ID = process.env.PB_OWNER_ID || "canary";
const PLAN_LIMIT = Number(process.env.PB_PLAN_LIMIT || 10);
const missing = [
  DB_PATH ? null : "PB_DATA",
  API_KEY ? null : "PB_KEY",
  APPROVAL_SECRET ? null : "PB_APPROVAL_SECRET",
  WORKFLOW_FILE ? null : "PB_WORKFLOW_FILE",
].filter(Boolean);
if (missing.length > 0) {
  console.error(`pb-reference: missing required env: ${missing.join(", ")}`);
  process.exit(2);
}

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS api_keys (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS approval_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    approval_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);
db.prepare("INSERT OR REPLACE INTO api_keys (key, name) VALUES (?, ?)").run(API_KEY, "canary-p0");
let workflowMachine = null;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve(null);
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}
function send(res, code, body) {
  const text = JSON.stringify(body ?? {});
  res.writeHead(code, { "content-type": "application/json" });
  res.end(text);
}
function bearer(req) {
  // The gateway forwards the client Authorization header verbatim, so a
  // client that already sends "Bearer <key>" arrives double-prefixed.
  let h = (req.headers["authorization"] || "").trim();
  while (h.startsWith("Bearer ")) h = h.slice(7).trim();
  return h || null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { status: "ok", server: "pb-reference" });
    }
    if (url.pathname === "/api/key") {
      if (req.method === "POST") {
        const body = await readJson(req);
        if (!body || typeof body.key !== "string" || !body.key) return send(res, 400, { error: "key required" });
        db.prepare("INSERT OR REPLACE INTO api_keys (key, name) VALUES (?, ?)").run(body.key, body.name || "unnamed");
        return send(res, 200, { ok: true, name: body.name || "unnamed" });
      }
      const key = bearer(req);
      if (!key) return send(res, 401, { error: "unauthorized" });
      const row = db.prepare("SELECT name FROM api_keys WHERE key = ?").get(key);
      if (!row) return send(res, 401, { error: "unauthorized" });
      return send(res, 200, { ok: true, name: row.name });
    }
    if (req.method === "GET" && url.pathname === "/api/gateway/workflows") {
      if (bearer(req) !== API_KEY) return send(res, 401, { error: "unauthorized" });
      workflowMachine ??= JSON.parse(await readFile(WORKFLOW_FILE, "utf8"));
      return send(res, 200, {
        default: workflowMachine.id,
        workflows: { [workflowMachine.id]: workflowMachine },
        owner_id: OWNER_ID,
        plan_limit: PLAN_LIMIT,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/internal/human-approval") {
      if (bearer(req) !== APPROVAL_SECRET) return send(res, 401, { error: "unauthorized" });
      const body = await readJson(req);
      if (!body || typeof body.approval_id !== "string" || typeof body.run_id !== "string") {
        return send(res, 400, { error: "approval_id and run_id required" });
      }
      const decision = body.decision;
      const status = decision === "approve" || decision === "approved"
        ? "approved"
        : decision === "deny" || decision === "rejected" || decision === "reject"
          ? "rejected"
          : "pending";
      db.prepare("INSERT INTO approval_receipts (approval_id, run_id, status, payload, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(body.approval_id, body.run_id, status, JSON.stringify(body), new Date().toISOString());
      console.log(`pb-reference: approval ${body.approval_id} (run ${body.run_id}) -> ${status}`);
      // The gateway validates receipt identity + status against its own run
      // (crates/mcp-gateway/src/gateway.rs apply_approval_receipt).
      return send(res, 200, { run_id: body.run_id, approval_id: body.approval_id, status });
    }
    if (req.method === "GET" && url.pathname === "/api/debug/approvals") {
      const rows = db.prepare("SELECT approval_id, run_id, status, created_at FROM approval_receipts ORDER BY id").all();
      return send(res, 200, { approvals: rows });
    }
    return send(res, 404, { error: "not found", path: url.pathname });
  } catch (err) {
    console.error("pb-reference: error", err.message);
    return send(res, 500, { error: err.message });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`pb-reference: listening on 127.0.0.1:${PORT} (db ${DB_PATH})`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { server.close(() => process.exit(0)); });
