# Architecture — what each file does, and why

A map of the codebase. Every file is listed with its job and the reason it
exists as a separate piece.

**The one idea to hold onto:** each agent is a single Cloudflare Durable Object.
A DO is a single-threaded JavaScript object with its own SQLite database,
addressed by name. Ask for `agents/live` and Cloudflare routes you to the *same*
instance every time, from anywhere. That is what makes an agent persistent
without running a server, and it is why the code has no session store, no
connection pool, and no locking.

---

## Request flow

```
POST /agents/live/send   { text: "..." }
  │
  ├─ src/index.ts ............ match the URL, get the DO stub by name
  ├─ src/agent-instance.ts ... record the message, build the model, run the harness
  ├─ src/harnesses/ .......... loop: ask model → run tools → feed results back
  ├─ src/models/ ............. HTTP POST to the provider
  └─ reply saved to SQLite, returned as JSON
```

---

## `src/` — the Worker

| File | What it does | Why it's separate |
|---|---|---|
| `index.ts` | The HTTP router. Plain URL matching, no framework: `/agents/:id/:action` becomes an RPC call on a Durable Object stub. Also serves `/catalog`, `/api/launch`, `/api/agents`, and channel webhooks. | The only file that knows about HTTP. Everything below it works in plain objects, which is why the DO can be driven from tests without a server. |
| `agent-instance.ts` | **One agent.** A Durable Object holding three SQLite tables — `messages` (history), `kv` (spec, alarm cadence) and `notes` (what the agent chose to remember). Owns `send`, `history`, `snapshot`/`restore`, `schedule`, `releaseSandbox`, and the alarm handler. | The single-threaded DO *is* the concurrency model. Two requests to one agent queue automatically, so nothing here needs locks or transactions. |
| `registry-do.ts` | A second, singleton DO that records every agent created. | Agent DOs cannot enumerate each other — each only knows itself. Something has to keep the list for the dashboard, so it's one extra DO rather than an external database. |
| `catalog.ts` | The menu: models (with provider + estimated price), providers (base URL + key name), harnesses, capabilities, machine tiers. Pure data. | One place to answer "what can this thing run?". Adding a provider is a row here plus a key in `types.ts` — no other file changes. |
| `types.ts` | `Env` (every binding and secret), `Message`, `Role`. | The Worker's contract with Cloudflare. If a secret isn't declared here, TypeScript won't let you read it. |
| `parts.ts` | Message content as `{ parts: [{ type, index, text }] }` plus helpers to convert to and from plain strings. | A multimodal-ready shape. Text is the only part type today, but the format leaves room for images and files without a migration. |

### `src/models/` — talking to an LLM

| File | What it does |
|---|---|
| `index.ts` | `Model` interface (`complete` for plain text, `turn` for tool calling), `OpenAICompatModel`, `EchoModel`, and `UnusedModel`. |

**Why one adapter:** every provider we use speaks OpenAI's `/chat/completions`
shape, so the only difference between Moonshot and socheap is a base URL.
`OpenAICompatModel` takes that URL as a constructor argument. Adding DeepSeek or
Z.ai later is a catalog row, not a new class.

**`EchoModel`** exists only so tests run offline — it needs no key and returns
the input back. It is reachable *only* when `USE_ECHO_MODEL=1` is set, which is
bound in `vitest.config.ts` and nowhere else. That is deliberate: an accidental
fallback to a canned responder makes a broken deployment look healthy.

### `src/harnesses/` — running the agent CLI

| File | What it does |
|---|---|
| `index.ts` | `AgentCliHarness` — runs Claude Code inside the agent's VM. Also `AgentSpec` and `checkCompatible`. |
| `vm-tools.ts` | Installs the agent's capabilities into the VM as commands, and writes the instructions telling the CLI when to use them. |

**The agent is a real CLI, not a loop we wrote.** `AgentCliHarness` shells into
the container, runs `claude -p "<message>"`, and returns what it printed. Claude
Code owns its own planning, its own tools, and its own retries; this class only
starts it and gets out of the way.

**Why the VM tools exist:** the CLI runs inside the container, and capabilities
like web search live outside it in the Worker. Nothing bridges that gap on its
own — an earlier version passed a tool list to the harness, which silently
discarded it, so the builder advertised seven capabilities and the agent could
use one. `vm-tools.ts` installs each capability as a script on `PATH` that posts
back to `/agents/:id/tool/:name`, so the CLI reaches them the way it reaches any
other command.

Three details that each failed silently before they were right: the scripts are
installed base64-encoded (a nested heredoc hangs the sandbox's exec waiting on
stdin), their JSON is built by Python from argv rather than escaped through two
shells, and requests carry an explicit user agent because Cloudflare's bot
protection answers urllib's default with a 403. Instructions are written as both
`AGENTS.md` and `CLAUDE.md` — Claude Code reads the latter, and with only the
former it ignored the tools entirely.

`ChatHarness` is also in this file: the model-driven tool loop, kept for the
tests and for whenever an OpenAI-compatible harness lands. It is not reachable
in production — `getHarness` never returns it.

### `src/capabilities/` — the tools

| File | What it does |
|---|---|
| `index.ts` | `scrape_web` (fetch a URL, extract text) and `search_web` (Tavily), plus the registry and the enabled-capability gate. |

A capability with a `parameters` JSON Schema is offered to the model as a
callable tool; without one it is only reachable via `POST /agents/:id/tool/:name`.
`runCapability` refuses anything not in the agent's own spec, so enabling a tool
is per-agent, not global.

Everything listed here works with the keys that are actually configured. Stubs
that returned "configure a provider" were deleted — presenting a placeholder and
a working tool as equal choices is worse than offering less.

### `src/channels/` — reaching users where they are

| File | What it does |
|---|---|
| `index.ts` | The `ChannelAdapter` contract (`parse` a webhook → `Inbound`, `send` a reply) and the shared pipeline. |
| `web.ts` | Browser chat. `send` is a no-op because the reply rides the HTTP response. |
| `telegram.ts` | Parses Telegram's webhook shape and pushes the reply back via its API. |

**Why an adapter per platform:** each has a different webhook body and a
different send call, but the agent should not care. History is unified at the
agent level — a Telegram message and a web message land in the same SQLite
table, so the agent has one memory across all of them, and only the reply is
routed back to wherever the request came from.

> Telegram is written but unconfigured: no `TELEGRAM_BOT_TOKEN` is set.

### `src/sandbox/` — running real code

| File | What it does |
|---|---|
| `index.ts` | The `Sandbox` interface (`exec`, `readFile`, `writeFile`, `destroy`) and `ContainerSandbox`, which reaches a Cloudflare Container through a binding. |

Workers cannot spawn processes, so everything the agent does happens in a
container attached to its own Durable Object — a Firecracker micro-VM with bash,
python3, git and the Claude Code CLI. It has no public endpoint: the Worker
reaches it through a binding.

**One container class per machine tier.** `instance_type` is fixed per class and
cannot be chosen per request, so ½/1/2 vCPU means three classes over the same
image, and `getSandbox(env, machine)` picks the binding from the agent's spec.
With a single class the picker recorded a choice and billed three rates for
identical hardware.

`destroy()` is called when an agent is deleted. A container holds its slot
against `max_instances` whether or not its agent still exists, so without this
every deleted agent left a machine running until the idle timer expired.

---

## `public/` — the UI

Static assets served straight from the Worker. No build step, no framework —
plain HTML with a `<script>` block, so the deploy is a file upload.

| File | What it does |
|---|---|
| `chat.html` | The playground: agent sidebar, header, conversation, composer. Includes a small hand-rolled markdown renderer that HTML-escapes first, so a model reply can never inject markup. |
| `agents/index.html` | Dashboard listing every agent, with delete/chat links. |
| `agents/new.html` | The builder: pick harness + model + capabilities + machine, check compatibility, launch. |
| `agents/builder.js` | The builder's state machine, kept separate so it can be unit-tested in Node without a browser (see `test/ui/builder.test.ts`). |

---

## `test/`

Two suites, two runners, because they need different environments:

- **`vitest.config.ts`** → the Worker suite, running inside Miniflare (real
  Durable Objects, real SQLite). Binds `USE_ECHO_MODEL=1` so no network or API
  key is needed.
- **`vitest.ui.config.ts`** → plain Node, for the pure-logic UI modules.

| File | Covers |
|---|---|
| `agent.test.ts` | Memory, persistence across calls, agent isolation. |
| `registry.test.ts` | The agent list, delete, and that delete releases the container. |
| `integration.test.ts` | The REST surface end to end. |
| `builder-api.test.ts` | `/catalog` and `/api/launch`, including rejection of invalid specs. |
| `capabilities.test.ts` | The registry, the enabled-capability gate, and that deleted stubs stay deleted. |
| `channels.test.ts` | Webhook parsing and unified history. |
| `a2a.test.ts` | Agent-to-agent messaging. |
| `tools.test.ts` | The tool loop: multiple calls, failures as observations, the step cap. |
| `ui/*.test.ts` | Builder state machine, parts helpers, sandbox harness. |

---

## Container image

| Path | What it does |
|---|---|
| `Dockerfile` | The sandbox image: Cloudflare's base plus python3 and git. |

---

## Config

| File | What it does |
|---|---|
| `wrangler.jsonc` | Worker name, DO bindings and migrations, static assets, `DEFAULT_MODEL`/`DEFAULT_HARNESS`. Secrets are *not* here — they go in `wrangler secret put`. |
| `tsconfig.json` | Strict TypeScript against `@cloudflare/workers-types`. |
| `.dev.vars.example` | Every secret name the app reads, with empty values. Copy to `.dev.vars` for local dev; that file is gitignored. |
| `package.json` | Scripts: `dev`, `deploy`, `test`, `test:ui`, `typecheck`. |

---

## Two decisions worth knowing

**Fail loudly.** `buildModel()` throws when a model is unknown or its key is
missing, rather than substituting a stand-in. An earlier version silently fell
back to a mock, which meant a completely unconfigured deployment produced
plausible-looking replies and appeared to work. Errors that surface as
`moonshot 401: Incorrect API key provided` are the point.

**Idle = free.** A Durable Object with no traffic costs nothing and its
container sleeps after a few idle minutes, so an agent nobody is talking to
genuinely costs nothing. There is no park switch: idling is the default, not
something to opt into.
