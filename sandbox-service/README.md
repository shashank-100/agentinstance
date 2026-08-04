# Nimbus self-hostable sandbox

A tiny HTTP service that gives Nimbus agents a real place to run commands and
files — **self-hosted**, so you're not locked to any sandbox cloud.

## Run it

```bash
cd sandbox-service
docker build -t nimbus-sandbox .
docker run -p 8080:8080 -e SANDBOX_TOKEN=your-secret nimbus-sandbox
```

Or without Docker (Node 20+):

```bash
SANDBOX_TOKEN=your-secret node server.mjs
```

## Point Nimbus at it

Set on the Worker (or in `.dev.vars` for local dev):

```bash
npx wrangler secret put SANDBOX_URL     # e.g. https://sandbox.yourhost.com
npx wrangler secret put SANDBOX_TOKEN   # same secret as above
```

When `SANDBOX_URL` is set, the `claude-code` / `codex` harnesses execute real
commands in the sandbox. When it's unset, agents fall back to a plain model call.

## API

```
GET  /health                              -> { ok: true }
POST /exec        { workspace, command }  -> { stdout, stderr, exitCode, success }
POST /files/write { workspace, path, content }
POST /files/read  { workspace, path }     -> { content }
```

Each `workspace` (the agent id) gets an isolated directory; path traversal is
blocked. If `SANDBOX_TOKEN` is set, all requests require
`Authorization: Bearer <token>`.

## Security

Commands run as a non-root user inside the container, but they **do** run real
shell commands. Only expose this to your trusted Nimbus deployment: keep the
token secret, run it in an isolated container/VM, and don't put it on the open
internet without a firewall.
