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
wrangler secret put CLAUDE_CODE_OAUTH_TOKEN
```

Set `FLEET_TOKEN` too on anything reachable from the internet — without it,
anyone with the URL can launch agents and spend those keys.

See [DEPLOY.md](./DEPLOY.md).


Snap together a **harness**, a **model**, and **capabilities** — launch a long-lived
agent with persistent memory, reachable on every channel your users already use.
It sleeps when idle and you pay nothing while it does.

Each agent lives in its own [Durable Object](https://developers.cloudflare.com/durable-objects/)
with SQLite storage — one coordination atom, strongly consistent, always recoverable.

> **Note:** a model key is required. Set `CLAUDE_CODE_OAUTH_TOKEN`.
> Without one, `send`
> returns a clear error rather than a canned reply — see [DEPLOY.md](./DEPLOY.md).

## Try it

- **Your agents dashboard:** `/agents/` (`/` redirects here)
- **Task board:** `/agents/board.html`
- **Agent builder (one click):** `/agents/new.html`
- **Web chat:** `/chat?id=<agent>`

## Features

- **A real agent CLI, not a chat loop** — every agent runs a coding CLI inside
  its own micro-VM, with its own shell, filesystem, and editing tools. Two
  harnesses today: **Claude Code** (on a Claude subscription token) and **pi**
  (on any provider it has a key for, so agents can run cheaper models).
- **Agents that talk to each other** — `send_to_agent` and `list_agents` are
  capabilities like any other, so a supervisor delegating to workers, two
  agents reviewing each other, or a pipeline are all the same primitive. See
  [docs/topologies.md](./docs/topologies.md).
- **Capabilities the CLI can actually reach** — `search_web`, `browse_page`,
  `remember` and `recall` are installed into the VM as commands that call back
  into the Worker, so the agent uses them like any other program.
- **Tasks, not just messages** — hand an agent a goal and close the tab. A task
  carries a branch, a pull request and a terminal *settled* state, and outlives
  the request that filed it. Nothing has to stay running for it to finish,
  which is the whole reason for an agent that lives in a Durable Object rather
  than on your laptop.
- **Real git** — an agent clones, branches, commits, pushes and opens a pull
  request from inside its own VM. The GitHub token reaches `git` through a
  credential helper, so it is never written to `.git/config` or a remote URL.
- **Model handoff** — hit a rate limit, or find a cheap model is not up to the
  job, and move the agent to another harness or model mid-conversation. History
  lives in the agent's SQLite, so the next model starts knowing what the last
  one did.
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

Set a model key (required — agents cannot reply without it):

```bash
npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN
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
POST /agents/:id/a2a         { from, text, async? }  -> { reply } or { accepted }
POST /agents/:id/handoff     { harness?, model?, reason? } -> { from, spec }

# the work queue
POST /api/fleet/tasks        { goal, repo?, createdBy? }   -> a task
POST /api/fleet/tasks        { claim: "<agent>" }          -> the next queued task
GET  /api/fleet/tasks        ?state=queued|running|settled|failed
POST /api/fleet/tasks/:id    { assignedTo } | { branch } | { prUrl }
                             | { state: "settled"|"failed"|"queued", result? }
GET  /api/fleet/tasks/:id
DELETE /api/fleet/tasks/:id
GET  /api/fleet/status       -> counts per state

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

## Multi-agent

Agents reach each other with `send_to_agent` and `list_agents`, enabled per
agent like any other capability. There is no supervisor type and no worker
type — a supervisor is an agent whose instructions tell it to delegate, which
is why peer review and pipelines cost nothing extra. `from` is stamped by the
Worker from the sending agent's own spec, so an agent cannot claim to be
another one, and hops are capped so two agents cannot message each other
forever.

See [docs/topologies.md](./docs/topologies.md) for three worked examples.

## Roadmap

**More harnesses.** A `codex` row exists in `CLI_HARNESSES` but is not offered
in the catalog: it speaks OpenAI's wire format, so it cannot use a Claude
subscription, leaving it the one harness needing a key nothing else here needs.
Re-enabling it is two catalog lines. OpenCode is one more row, once its
contract is confirmed — note it ships `bin/opencode.exe`, so check that
resolves on Linux first.

## License

MIT
