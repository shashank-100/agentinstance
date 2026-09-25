# agentinstance ⚡

**An agent that is still working when you close the laptop.**

Give it a goal. It gets a micro-VM with a real coding CLI, clones your
repository, makes the change, and opens a pull request. Nothing runs on your
machine — the agent lives in a Cloudflare Durable Object, so closing the tab
that filed the work has no effect on the work.

**One agent is one Durable Object.** Addressed by name, its own SQLite, its own
container, woken by its own alarms. That is the whole architecture, and it is
why there is no session store, no connection pool and no locking anywhere in
this repository.

[Deploy it](./DEPLOY.md) · [What every file does](./ARCHITECTURE.md) · [Read the loop](src/agent-instance.ts)

## The shape of it

```text
  you                Worker                 Durable Object          container
   │                   │                          │                     │
   ├─ file a task ────→│                          │                     │
   │                   ├─ idFromName("alice/x") ─→│                     │
   │                   │                          ├─ claude-code ──────→│
   │← task id ─────────┤                          │                     │
   │                                              │   git clone         │
  (close the laptop)                              │   edit, commit      │
                                                  │   push, open PR     │
   │                                              │←────────────────────┤
   ├─ read the board ─→ settled · PR #4           │
```

The agent is not a chat loop calling tools. It is **Claude Code or pi running
in a real shell**, with a filesystem, `git`, and the editing tools those CLIs
already have. Capabilities that live in the Worker — `search_web`,
`browse_page`, `remember`, `send_to_agent` — are installed into the VM as
commands on `PATH` that post back through the front door, so the CLI calls
`search_web "..."` like any other program.

## Try it

```bash
git clone https://github.com/shashank-100/agentinstance.git
cd agentinstance
npm install
npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN   # claude setup-token
npm run deploy
```

Deploying builds a container image and pushes it to Cloudflare's registry, so
it needs Docker running and takes a few minutes the first time.
[DEPLOY.md](./DEPLOY.md) covers the parts that bite — the image push is the
fragile step.

Then file work against a repository:

```bash
curl -X POST "$URL/api/fleet/tasks" -H 'content-type: application/json' \
  -H "authorization: Bearer $FLEET_TOKEN" \
  -d '{"goal":"Fix slugify: punctuation, repeated spaces, leading/trailing dashes.",
       "repo":"you/your-repo","dispatch":true}'
```

`dispatch: true` launches an agent for the task and starts it. Without it the
task waits on the board until something picks it up.

## Why it keeps working

- **A task outlives the request that filed it.** It carries a branch, a pull
  request, and a terminal *settled* state. Nothing has to stay connected.
- **A dead run is noticed and retried.** An agent that crashes leaves its task
  `running` with nobody working it. A lease expires, a sweep requeues it, and
  after three attempts it fails with the reason recorded rather than silently
  disappearing.
- **A supervisor hears about it.** Broken runs become incidents, claimed on
  read so two supervisors cannot act on the same one, capped at five an hour so
  a crash loop is one conversation rather than a storm.
- **Idle is free.** Containers sleep after five idle minutes and bill per 10ms
  of active time, so an always-on agent costs nothing while it waits.
- **Agents reach each other.** `send_to_agent` is a capability like any other,
  so a supervisor delegating to workers is the same primitive as two agents
  reviewing each other. `from` is stamped by the Worker, so an agent cannot
  claim to be another one, and hops are capped.
- **Two people are two objects.** `idFromName("alice/reviewer")` and
  `idFromName("bob/reviewer")` are different objects — isolation holds by
  construction, not by a `WHERE` clause somebody might forget.

Credentials never reach the model. A GitHub token is passed to `git` through a
credential helper rather than written into `.git/config` or a remote URL, and
tool output is data: nothing the model writes becomes a shell command.

## Small enough to read

| File | Job |
| --- | --- |
| [agent-instance.ts](src/agent-instance.ts) | One agent: memory, alarms, capabilities, the run loop |
| [index.ts](src/index.ts) | The Worker gateway — every route, and who may call it |
| [fleet-do.ts](src/fleet-do.ts) | The board: queue, leases, the sweep, incidents |
| [harnesses/](src/harnesses/) | Running a real CLI in the VM, and the tool bridge |
| [scope.ts](src/scope.ts) | Whose object is this — 76 lines, mostly comment |
| [catalog.ts](src/catalog.ts) | Models, machines, capabilities, and what is ready |

About 5,900 lines of TypeScript in 19 files, and 20 test files.

## Evidence and limits

Agents on this deployment have opened real pull requests, each authored by the
GitHub App rather than by a person:
[#2 on a playground repo](https://github.com/shashank-100/agent-playground/pull/2)
fixed a slugify bug from a one-sentence goal and is still open;
[#3](https://github.com/shashank-100/agentinstance/pull/3) verified the App
could push at all and [#4](https://github.com/shashank-100/agentinstance/pull/4)
added a CONTRIBUTING.md, both since closed. The supervisor has woken unattended
in production and reported a broken run.

**What is not proven.** Two people have never used one deployment at once — the
isolation above is tested at the object level, not demonstrated with two real
accounts. `pi` reports ready and has never produced a pull request. There is no
general benchmark here: these are individual runs on small repositories, not a
reliability measurement.

**What does not exist.** Inbound GitHub webhooks (no issue → task), outbound
notifications (no "your pull request is ready" anywhere), and `browse_page`
reads one URL with no session — it cannot click or type. Containers are a pool
shared by everyone on a deployment; a per-user cap divides it, but the pool is
finite.

## Harnesses

| Harness | State |
| --- | --- |
| `claude-code` | working — on a Claude subscription token |
| `pi` | runs; never verified end to end. Pinned at 0.84.0 because 0.86.0 offers the model no tools |
| `codex` | defined, not in the image |

## Development

```bash
npm test          # worker suite, in workerd
npm run test:ui   # UI suite, in node
npm run typecheck
```

Read the output, not the exit code: `vitest` has exited 0 here while running
zero tests. [AGENTS.md](./AGENTS.md) is the working agreement for editing this
repository — how to test, how to commit, and which version pins are
load-bearing and why.

---

[DEPLOY.md](./DEPLOY.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [ROADMAP.md](./ROADMAP.md) · MIT
