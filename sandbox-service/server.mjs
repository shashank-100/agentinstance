#!/usr/bin/env node
// Self-hostable sandbox service for agentinstance.
//
// A tiny HTTP API that runs shell commands and does file I/O inside an isolated
// per-workspace directory. Run it anywhere (Docker, a VPS, your laptop) and
// point agentinstance at it via SANDBOX_URL. This is the vendor-neutral alternative to
// a proprietary sandbox cloud.
//
// Security notes (READ before exposing publicly):
//  - Set SANDBOX_TOKEN and it will require `Authorization: Bearer <token>`.
//  - Commands run as the container user; run this in a locked-down container.
//  - Each workspace is a subdir under ROOT; path traversal is blocked.
import { createServer } from "node:http";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join, sep } from "node:path";

const pexec = promisify(exec);
const ROOT = resolve(process.env.SANDBOX_ROOT || "/workspaces");
const TOKEN = process.env.SANDBOX_TOKEN || "";
const PORT = Number(process.env.PORT || 8080);
const TIMEOUT_MS = Number(process.env.SANDBOX_TIMEOUT_MS || 30000);
const MAX_BUFFER = 1024 * 1024 * 8; // 8MB

function wsDir(workspace) {
  // Confine every workspace under ROOT; reject traversal.
  const safe = String(workspace || "default").replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = resolve(join(ROOT, safe));
  if (dir !== ROOT && !dir.startsWith(ROOT + sep)) throw new Error("bad workspace");
  return dir;
}
function safePath(dir, path) {
  const p = resolve(join(dir, path || ""));
  if (p !== dir && !p.startsWith(dir + sep)) throw new Error("path escapes workspace");
  return p;
}

async function readBody(req) {
  let b = "";
  for await (const chunk of req) b += chunk;
  return b ? JSON.parse(b) : {};
}
function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  try {
    if (TOKEN) {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${TOKEN}`) return json(res, 401, { error: "unauthorized" });
    }
    if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });

    const body = await readBody(req);

    if (req.method === "POST" && req.url === "/exec") {
      const dir = wsDir(body.workspace);
      await mkdir(dir, { recursive: true });
      try {
        const { stdout, stderr } = await pexec(body.command, {
          cwd: dir,
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_BUFFER,
        });
        return json(res, 200, { stdout, stderr, exitCode: 0, success: true });
      } catch (e) {
        return json(res, 200, {
          stdout: e.stdout || "",
          stderr: e.stderr || String(e),
          exitCode: typeof e.code === "number" ? e.code : 1,
          success: false,
        });
      }
    }

    if (req.method === "POST" && req.url === "/files/write") {
      const dir = wsDir(body.workspace);
      const p = safePath(dir, body.path);
      await mkdir(dir, { recursive: true });
      await writeFile(p, body.content ?? "", "utf8");
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && req.url === "/files/read") {
      const dir = wsDir(body.workspace);
      const p = safePath(dir, body.path);
      const content = await readFile(p, "utf8");
      return json(res, 200, { content });
    }

    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 400, { error: String(e) });
  }
});

server.listen(PORT, () => {
  console.log(`[agentinstance-sandbox] listening on :${PORT} root=${ROOT} auth=${TOKEN ? "on" : "off"}`);
});
