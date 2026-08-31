# ⌇ agentinstance

**Open-source, self-hostable always-on AI agents on Cloudflare.**

## 🚀 Deploy in one click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/shashank-100/agentinstance)

Click the button → sign in to Cloudflare → it forks this repo to your account,
provisions the Durable Objects, and deploys the Worker with CI wired up. No
local setup.

Agents need a model key before they can reply — add one as a secret after the
first deploy:

```sh
wrangler secret put SOCHEAP_API_KEY
```

See [DEPLOY.md](./DEPLOY.md).


Snap together a **harness**, a **model**, and **capabilities** — launch a long-lived
agent with persistent memory, reachable on every channel your users already use.
It sleeps when idle and you pay nothing while it does.

Each agent lives in its own [Durable Object](https://developers.cloudflare.com/durable-objects/)
with SQLite storage — one coordination atom, strongly consistent, always recoverable.

> **Note:** a model key is required. Without `SOCHEAP_API_KEY` set, `send`
> returns a clear error rather than a canned reply — see [DEPLOY.md](./DEPLOY.md).

## Try it

- **Your agents dashboard:** `/agents/` (`/` redirects here)
- **Agent builder (one click):** `/agents/new.html`
- **Web chat:** `/chat?id=<agent>`

## Features

- **A real agent CLI, not a chat loop** — every agent runs Claude Code inside
  its own micro-VM, with its own shell, filesystem, and editing tools.
- **Capabilities the CLI can actually reach** — `search_web`, `browse_page`,
  `remember` and `recall` are installed into the VM as commands that call back
  into the Worker, so the agent uses them like any other program.
- **Persistent memory** — history and notes in Durable Object SQLite. The VM's
  filesystem is discarded between sessions; what the agent chose to `remember`
  is not.
- **Machine tiers that mean something** — ½, 1, or 2 vCPU, each a separate
  container class, because CPU is what limits real work in the VM.
- **Scheduled wakeups** via alarms, with a declared cadence so *stalled* ≠ *idle*
  (health ≠ progress).
- **Idle is free** — containers sleep after five idle minutes and bill per 10ms
  of active time.

## Quick start

```bash
npm install
npm test          # runs the Workers test suite
npm run dev       # local dev server
npm run deploy    # deploy to your Cloudflare account
```

Set the model key (required — agents cannot reply without it):

```bash
npx wrangler secret put SOCHEAP_API_KEY
```

## API

```
POST /agents/:id/configure   { harness, model, capabilities, machine, system }
POST /agents/:id/send        { text, channel? }  -> { reply }
GET  /agents/:id/history
GET  /agents/:id/status      -> { lastProgress, expectedCadenceMs, stalled }
GET  /agents/:id/snapshot                          -> { spec, history, kv }
POST /agents/:id/restore     { spec, history, kv }
POST /agents/:id/schedule    { atMs, prompt, cadenceMs? }
POST /agents/:id/wake
POST /agents/:id/tool/:name  { ...input }          -> { result } (gated by capabilities)

# channel webhooks
POST /channels/telegram/:id
POST /channels/web/:id       { text }              -> { reply }
```

See [DEPLOY.md](./DEPLOY.md) for Cloudflare deployment and setup.

## Architecture

| Piece | File |
|-------|------|
| Per-agent runtime + memory + alarms | `src/agent-instance.ts` |
| Worker gateway (REST) | `src/index.ts` |
| Model adapters | `src/models/` |
| Agent CLI runner + VM tool bridge | `src/harnesses/` |
| Catalog (models/pricing/machines/capabilities) | `src/catalog.ts` |

See [ARCHITECTURE.md](./ARCHITECTURE.md) for what every file does and why.

## The VM

Every agent gets a container attached to its own Durable Object — a Firecracker
micro-VM with bash, python3, git and the Claude Code CLI. It has no public
endpoint: the Worker reaches it through a binding, so nothing that executes
arbitrary commands is addressable from the internet.

This is where the agent actually runs. A Worker cannot spawn processes, which
is why the VM exists at all.

Capabilities that live in the Worker — web search, page rendering, the agent's
notes — are installed into the VM as small scripts on `PATH` that post back to
`/agents/:id/tool/:name`. The CLI calls `search_web "..."` like any other
command, and the endpoint enforces the same per-agent capability gate the REST
API does.

Deleting an agent stops its container immediately rather than leaving it to
time out. See `Dockerfile` for the image.

## Roadmap

An OpenAI-compatible harness: pi and opencode both worked locally and failed
inside the VM, so the GPT models are in the catalog but unselectable until one
of them (or a replacement) runs there.

## License

MIT
