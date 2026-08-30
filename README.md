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
Park it when idle; you pay nothing while it sleeps.

Each agent lives in its own [Durable Object](https://developers.cloudflare.com/durable-objects/)
with SQLite storage — one coordination atom, strongly consistent, always recoverable.

> **Note:** a model key is required. Without `SOCHEAP_API_KEY` set, `send`
> returns a clear error rather than a canned reply — see [DEPLOY.md](./DEPLOY.md).

## Try it

- **Your agents dashboard:** `/agents/` (`/` redirects here)
- **Agent builder (one click):** `/agents/new.html`
- **Web chat:** `/chat?id=<agent>`

## Features

- **Persistent memory** — full history + state in Durable Object SQLite, survives restarts.
- **Any model, no lock-in** — one adapter for any OpenAI-compatible provider;
  GPT (via socheap) and Kimi (Moonshot) are wired up, others are a catalog entry plus a key.
- **Harnesses** — a chat loop with tool calling, and a sandbox-backed shell loop.
- **Three-piece composition** with a compatibility check before launch.
- **Unified cross-channel history** — one agent, one memory; replies go to the
  channel that messaged, context is shared across all of them.
- **Scheduled wakeups** via alarms, with a declared cadence so *stalled* ≠ *idle*
  (health ≠ progress).
- **Park = free** — pay only while actively working.

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
POST /agents/:id/send        { text, channel? }  -> { reply }  (409 if parked)
GET  /agents/:id/history
GET  /agents/:id/status      -> { parked, lastProgress, expectedCadenceMs, stalled }
POST /agents/:id/park | /unpark
GET  /agents/:id/snapshot                          -> { spec, history, kv }
POST /agents/:id/restore     { spec, history, kv }
POST /agents/:id/schedule    { atMs, prompt, cadenceMs? }
POST /agents/:id/wake
POST /agents/:id/tool/:name  { ...input }          -> { result } (gated by capabilities)

# channel webhooks
POST /channels/telegram/:id
POST /channels/discord/:id
POST /channels/slack/:id
POST /channels/whatsapp/:id
POST /channels/web/:id       { text }              -> { reply }
```

See [DEPLOY.md](./DEPLOY.md) for one-command Cloudflare deployment and channel setup.
The `agentinstance` CLI (`cli/agentinstance.mjs`) wraps these routes, including `agentinstance clone` to
push a local agent (spec + history) into the cloud.

## Architecture

| Piece | File |
|-------|------|
| Per-agent runtime + memory + alarms | `src/agent-instance.ts` |
| Worker gateway (REST) | `src/index.ts` |
| Model adapters | `src/models/` |
| Harnesses + spec + compatibility | `src/harnesses/` |
| Catalog (models/pricing/machines/capabilities) | `src/catalog.ts` |

See [ARCHITECTURE.md](./ARCHITECTURE.md) for what every file does and why.

## Sandbox

Agents run **real shell commands** in a container attached to their own Durable
Object — a Firecracker micro-VM with bash, python3 and git. It has no public
endpoint: the Worker reaches it through a binding, so nothing that executes
arbitrary commands is addressable from the internet.

Use it by giving an agent the `shell` harness. See `Dockerfile` for the image.

## Roadmap

Channels (Telegram, Discord, Slack, WhatsApp, iMessage), `agentinstance` CLI incl. `clone`,
capabilities (scrape, search), snapshot/restore with
idempotency keys for outbound side-effects.

## License

MIT
