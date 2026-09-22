# Features

Everything this project does today, and what is next. Working notes.

---

# Shipped

## The core idea

**One agent = one Cloudflare Durable Object.** A DO is a single-threaded
JavaScript object with its own SQLite database, addressed by name. Ask for
`agents/live` and Cloudflare routes you to the *same* instance every time, from
anywhere.

That is the whole architecture, and it is why there is no session store, no
connection pool, and no locking. Two requests to one agent queue automatically.

**Idle is free.** A DO with no traffic costs nothing and its container sleeps
after five idle minutes, so an agent nobody is talking to genuinely costs
nothing — no switch to flip, nothing to remember to turn off.

**Always-on without a server.** Alarms fire and agents act with no client
connected and nothing running anywhere. This is the one thing the comparable
tools (agent-orchestrator, T3 Code) cannot do — they stop when the laptop closes.

## Agents

- **Build an agent from parts** — a harness, a model, capabilities, and a
  machine tier, checked for coherence before anything is created
  (`checkCompatible`). Invalid pairings are refused at launch rather than
  failing later.
- **A real agent CLI, not a chat loop** — every agent runs a coding CLI inside
  its own micro-VM with its own shell, filesystem and editing tools. The CLI
  owns its planning, its tools and its retries.
- **Launch never clobbers.** Creating is not editing: a name that exists
  returns 409, and `configure` is the route for changing an agent.
- **An agent that was never launched is not an agent.** Cloudflare routes any
  name to a DO, so existence is defined by having a spec. Without that check a
  typo in a URL would boot a VM and spend quota.
- **Delete means gone** — history, notes, kv and the alarm, plus the container
  stopped immediately rather than left to time out.

## Harnesses

| Harness | Models | Auth |
|---|---|---|
| `claude-code` | `claude-opus-4.8` | `CLAUDE_CODE_OAUTH_TOKEN` — a Claude subscription |
| `pi` | `kimi-k3` | `MOONSHOT_API_KEY` |
| `codex` | `kimi-k3` | `MOONSHOT_API_KEY` |

- **Subscription passthrough.** Claude Code authenticates against Anthropic with
  a subscription token, so there is no provider key and no per-token rate.
- **pi makes a cheap model reachable.** It needs no config file: its own catalog
  already lists `moonshot/kimi-k3`, and it reads each provider's key from that
  provider's conventional env var. `providerKeyVar` selects that style.
- **codex runs any OpenAI-compatible provider** through repeated
  `--config key=value` arguments, which define and select a provider inline —
  no `~/.codex/config.toml` to rewrite every session on a filesystem that does
  not survive sleeping. `codex exec` is the non-interactive mode; bare `codex`
  opens a TUI that would block forever on a terminal the container lacks.
- **Adding a harness is one table row** plus one `Dockerfile` package. The table
  supports env-var, OAuth-token, config-file and provider-catalog styles.
- **Hardened invocation**: a 120s timeout (a hung CLI otherwise surfaces as an
  empty reply with nothing in the logs), explicit `HOME`, closed stdin (a CLI
  falling back to its TUI blocks forever on a terminal the container lacks), and
  a drop to an unprivileged user.
- **Keys go in the command's environment, never the prompt** — a prompt is
  echoed back in the CLI's own logs.

## Memory

- **Conversation history** in the agent's own SQLite, unified across every
  channel: a Telegram message and a web message land in the same table, so the
  agent has one memory wherever it is reached.
- **Durable notes** (`remember` / `recall`) — separate from the transcript, so a
  scheduled agent can recall what it already did without re-reading and
  re-paying for its whole history.
- **History is fed back to the CLI each turn.** Each invocation is a fresh
  process; without this the agent was amnesiac between messages. Older turns are
  dropped past a character budget so a long-running agent does not pay for an
  ever-growing prompt.
- **Standing instructions** per agent (`agents-md`), written into the VM as both
  `AGENTS.md` and `CLAUDE.md` — Claude Code reads the latter, and instructions
  it never loads are instructions that do not exist.
- **Snapshot and restore** — spec, history, kv and notes. Restore re-arms the
  alarm, because an alarm is DO state rather than a table: without that a
  restored agent knew its task and never ran it.

## Capabilities

Enabled per agent, gated on every call — `runTool` refuses anything not in the
agent's own spec.

| Capability | What it does |
|---|---|
| `search_web` | Web search via Tavily |
| `scrape_web` | Fetch a URL and extract its text |
| `browse_page` | Render a JS-heavy page in headless Chrome |
| `fetch_json` | Call any JSON HTTP API |
| `run_shell` | Run commands in the agent's VM |
| `remember` / `recall` | Durable notes across sessions |
| `send_to_agent` | Message another agent, get its reply |
| `list_agents` | Discover the other agents on this deployment |
| `fleet_task` | Claim and complete work from the queue |
| `git_repo` | Clone, branch, commit and push a repository |
| `open_pr` | Open a pull request on GitHub |

**Capabilities reach into the VM as real commands.** Each becomes a script on
`PATH` that posts back to the Worker, so the CLI calls `search_web "..."` like
any other program. Three details each failed silently before they were right:
scripts are installed base64-encoded (a nested heredoc hangs the sandbox's exec
on stdin), their JSON is built by Python from argv rather than escaped through
two shells, and requests carry an explicit user agent because Cloudflare's bot
protection answers urllib's default with a 403.

## Agent-to-agent

- **Any agent can message any other.** There is no supervisor type and no worker
  type — a supervisor is an agent whose instructions tell it to delegate.
  `docs/topologies.md` shows supervisor/workers, peer review and a pipeline
  built on the same primitive.
- **`from` cannot be forged** — it is stamped from the sending agent's own spec,
  never from tool input.
- **Hops are capped at three.** Two agents that message each other run until
  something stops them, and every hop is a model call on a booted container.
- **Async fan-out** (`{ async: true }`) returns immediately, so messaging five
  agents does not block for the sum of five replies.
- **Exchanges land in normal history** on the `a2a` channel, so an agent's
  memory of another agent is the same memory it has of a person.

## Scheduling

- **Standing tasks** — a prompt plus a cadence; the agent wakes and acts on its
  own via DO alarms.
- **Re-armed before the task runs**, so a model call that throws does not
  silently stop a recurring agent forever.
- **Health ≠ progress.** `status` reports last *progress*, not last heartbeat,
  with a declared cadence — so a responsive-but-stuck agent is distinguishable
  from an idle one.

## Channels

- **Web chat** and **Telegram**, behind one adapter contract (`parse` a webhook,
  `send` a reply). History is unified at the agent level; only the reply is
  routed back to wherever the request came from.
- **Webhook failures return 2xx** with the error in the body — a non-2xx reads
  as failed delivery and retries with backoff until the platform suspends the
  hook.

## Machines

Three tiers — ½, 1 and 2 vCPU — each a separate container class, because
`instance_type` is fixed per class and cannot be chosen per request. With one
class the picker recorded a choice and billed three rates for identical
hardware. Tiers are named for vCPU because that is what limits real work.

## Self-hosting

- **One-click deploy to Cloudflare**, or `npm run deploy`.
- **A deployment is self-contained.** The Worker takes its own address from the
  request it is serving. That value gets baked into the tool scripts inside
  every agent's VM, so a hardcoded one meant every other deployer shipped agents
  whose tool calls and memory writes pointed at someone else's Worker.
- **An honest builder.** Readiness is computed from the environment per request,
  so it shows what *your* keys can run. A hardcoded flag describes whoever wrote
  it.
- **Optional auth** (`FLEET_TOKEN`) on every route that spends money. Optional
  so local dev needs no setup; required in practice for anything public.
- **Adding a provider is one row** plus one key — every provider is reached as
  OpenAI-compatible by swapping the base URL.
- **Fail loudly.** A missing key throws rather than substituting a stand-in. An
  earlier version silently fell back to a mock, which made a completely
  unconfigured deployment produce plausible replies and look like it worked.

---

## Tasks

A task is not a message. A message is answered inside one request; a task
outlives the request that filed it — which is the only reason running an agent
in the cloud beats running one on a laptop.

- **`FleetDO`** holds the queue: `goal`, `repo`, `branch`, `prUrl`, `createdBy`,
  `assignedTo`, `state`, `result`. States are `queued | running | settled |
  failed` — *settled* rather than *done*, because a task can finish without
  succeeding and both are over.
- **Claiming is race-free without a lock.** The DO is single-threaded, so the
  SELECT and UPDATE in `claim` cannot interleave — two agents can never take
  the same task. Splitting it into peek-then-take would reintroduce exactly the
  race the platform hands us for free.
- **`release` puts work back.** A container is discarded when it sleeps, so an
  agent that claimed a task and went idle would otherwise leave it `running`
  forever with nothing working on it.
- **`fleet_task`** lets an agent work the queue from inside its VM: claim, record
  a branch or PR, settle or fail.
- `POST /api/fleet/tasks`, `GET /api/fleet/tasks?state=`, `GET /api/fleet/status`.

## Git and pull requests

- **`git_repo`** — clone, branch, commit, push, status, diff, inside the agent's
  own VM.
- **`open_pr`** — opens a PR through GitHub's REST API from the Worker, so the
  token never crosses into the container.
- **The token never touches disk.** It reaches `git` through a credential helper
  reading it from the command's environment, so it is not written to
  `.git/config` and not embedded in a remote URL — both of which outlive the
  command that set them.
- **Push before sleep.** The VM's filesystem is discarded after five idle
  minutes, so the instructions tell the agent to commit and push as it goes
  rather than saving it for the end. Unpushed work is simply gone.

## Model handoff

Hit a rate limit, or find a cheap model is not up to the job — move the agent
onto a different harness or model and keep going.

- History lives in the agent's own SQLite and the harness rebuilds its prompt
  from it every turn, so the next turn on the new model already knows
  everything the last one did.
- **The switch is recorded in the transcript**, not silent. An agent whose
  answers change character mid-conversation with nothing explaining why is one
  nobody can debug — and the note is context the new model reads too, which is
  why handoff notes are the one kind of system message that reaches the prompt.
- Refused when the new harness cannot drive the model, rather than failing at
  run time.
- `POST /agents/:id/handoff { harness?, model?, reason? }`

## Visibility

- **Agent-to-agent messages are visually distinct** in chat, with the sender
  lifted out of the message body into a label rather than left in the prose.
- **Handoffs show inline** as a marker in the conversation.
- **The dashboard shows the task queue** — goal, state, which agent has it, its
  branch and a link to its PR — hidden entirely when no tasks exist.

# Known gaps

- **No harness is verified end to end.** Everything up to the model call is
  confirmed; the call itself is not, for want of a key. pi and opencode both
  died at exactly this step before — inside the container, cause never isolated.
  If it fails again, capture the real error: a sandbox-level 500 bypasses the
  stderr path in `AgentCliHarness`, so log around `sandbox.exec` itself.
- **Tests reference removed models** (`gpt-5.6-terra`, `one-cpu`) and fail.
  Mostly stale fixtures. One — `registry.test.ts:70`, empty history after a
  `send` — may be a real regression from the `send()` signature change.
- **Concurrency caps at 5 per machine tier** (`max_instances`), so a fan-out
  wider than that queues rather than running at once.
- **codex is wired from its documented contract, not from a live run.** The
  invocation follows `codex exec` as OpenAI documents it and as t3code calls it
  in production, but like every harness here it has not been run against a real
  model.
