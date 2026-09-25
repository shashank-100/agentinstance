# Working on agentinstance

Instructions for a coding agent working **on this repository**.

Not to be confused with the `AGENTS.md` this project *writes*: that one is
per-agent standing instructions, kept in KV and written into a running agent's
VM at `/workspace/AGENTS.md` (see `src/harnesses/index.ts`). This file is for
whoever is editing the source.

## The shape of the thing

One agent = one Cloudflare Durable Object. A DO is single-threaded, has its own
SQLite, and is addressed by name, so `agents/live` routes to the same instance
every time. That is why there is no session store, no connection pool and no
locking — two requests to one agent queue on their own.

Each agent's work happens in a container (`SandboxSmall|Medium|Large`), one
class per machine tier, running a real coding CLI. Read `ARCHITECTURE.md`
before changing how those fit together.

## Before you push

```sh
npm test          # worker suite, in workerd
npm run test:ui   # UI suite, in node
npm run typecheck
```

**Read the output, not the exit code.** `vitest` has exited 0 while running
zero tests here; a green checkmark is not the same as a passing suite. Confirm
the test count is what you expect.

Tests run serially on purpose (`fileParallelism: false`). `singleWorker: true`
means every file shares one worker, and parallel runners deadlock competing to
start it — the suite hangs until the pool times out and reports "no tests".

## How to test

**Never write unit tests after writing the code.** A test written to cover code
that already exists is shaped by that code, so it agrees with whatever the code
does — including the bugs. It reports success and proves nothing.

**Prefer end-to-end tests as the sole testing mechanism.** Drive the real thing:
file a task, dispatch it, watch the output, read the result. Use them to verify
that complex features actually work rather than that their parts are callable.

**End an E2E test with a verifiable, repeatable artifact** — a created task with
an id, a branch, a pull request, a row you can query. "The assertion passed" is
not an artifact; something you can go and look at afterwards is.

**If a system must be tested in isolation, write down every way it could fail
first, then write the code.** The failure list is the specification. Deriving it
from finished code inverts the order and produces tests that cannot fail.

A worked example of why, from this repo: the output buffer shipped with a test
asserting its byte bound. The test posted to a capability that did not exist, so
every write returned 400, the table stayed empty, and `0 <= 262144` passed. The
feature was entirely untested and two real bugs — a coalesce that hid data from
watchers, and a large chunk that wiped the whole buffer — shipped behind a green
suite.

## Git

Work goes **direct to `main`**: merge locally, push. No PR, no branch
protection, no CI. That means `npm test` is the only gate there is, which is
the whole reason the point above matters.

**One commit, one change.** A subject with an "and" in it is usually two
commits: `git log` stops being a record of what happened and becomes a list of
afternoons. Reverting one of them takes the other with it.

Commit messages are one line, no body, no trailers, in the form:

```
type(scope): what changed, in the imperative
```

`type` is one of `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`.
`scope` is the area — `fleet`, `agent`, `board`, `github`, `harness`,
`sandbox`, `catalog` — and is omitted when a change is genuinely repo-wide.

```
feat(fleet): sweep abandoned work on a timer
fix(agent): stop a failed restore from deleting the agent it replaces
refactor(board): read the diff from the pull request instead of the task
docs: say what deploying actually needs
```

Write the subject for someone reading `git log` a year from now with no memory
of the day. Say what changed, not what you did: "sweep abandoned work on a
timer", not "added a sweep". Where the *why* does not fit, it belongs in a
comment next to the code, which is where someone will actually be standing when
they need it.

## Containers

`wrangler deploy` builds the image and pushes it to `registry.cloudflare.com`.
Two things to know:

- **Docker must be running.** This machine uses colima, not Docker Desktop:
  `colima start`. A first start can exceed its own 5s hostagent deadline and
  report failure while the VM is actually up — `colima delete -f` and start
  again rather than debugging the log.
- **The push is the fragile part.** A layer uploads as a single request, so a
  reset at 90% discards all of it. Keep layers small and separate; one
  `RUN npm install -g` for several large CLIs produces a single blob that a
  flaky link will never land. Each CLI gets its own `RUN`.

`wrangler deploy --containers-rollout=none` ships the worker alone. Useful when
the worker change is what matters and the image has not changed — but it leaves
agents on the previously published image, so do not use it to "get around" a
failing push and then assume the new image is live.

`wrangler deploy` can exit 0 after the image push has failed. Check the output
for `Current Version ID`.

## Secrets

The deployment reads its own secrets to decide what to offer: `catalog.ts`
gates each capability behind `needs(env)`, so a missing key means the capability
is never offered rather than failing at run time. `/catalog` reports what is
actually ready.

`GITHUB_TOKEN` gates `git_repo` and `open_pr`. A fine-grained token needs
**Contents: read+write** and **Pull requests: read+write** — without write, an
agent clones and commits fine and then fails at push with a 403. Checking the
`permissions` block on `GET /repos/:owner/:repo` does **not** verify this: that
field describes the account's access, not the token's grants. Test with a real
push.

Never put a token in a command argument or a file the repo tracks. `.dev.vars`
is local only; `.dev.vars.example` documents the names.

**Set `WORKER_URL` on any deployment where an alarm wakes an agent.** The VM
tool scripts post back through the public front door, so an agent needs to know
its own address to install them. That address normally comes from the request
being served, and an alarm has no request — `agentUrl()` falls back to the last
origin the agent saw, which a brand-new agent woken first by an alarm has never
had. The result is an agent that runs with no tools and says so: the supervisor
reported "there is no `fleet_task` tool in this environment" on its first
unattended wake, while its spec listed one.

## Who may use a deployment

A deployment holds more than one person. That is an addressing property, not a
permissions one: Durable Objects are reached by name, so two people who both
call an agent `reviewer` do not get two agents with a visibility bug between
them — `idFromName` hands them **one object**, sharing its memory, container and
conversation. No `WHERE owner = ?` fixes that, because the collision happens
before any query runs. So the owner goes in the address (`src/scope.ts`) and
isolation holds by construction.

Everything that predates sign-in is addressed under `DEPLOYMENT` (`~`) and keeps
resolving to exactly the objects it always did, so an existing deployment does
not need migrating.

Sign-in is GitHub's, through the App the deployment already owns, and it is
**invite-only**: `ALLOWED_LOGINS` is closed by default, because every agent
spends this deployment's subscription and boots a container.

Three credentials reach the API, and they are not interchangeable:

| Caller | Credential | Used by |
|---|---|---|
| a person | session cookie | the board |
| a machine | `FLEET_TOKEN` | an agent's tools calling back from a container |
| anyone | none | only when neither `FLEET_TOKEN` nor `GITHUB_CLIENT_ID` is set |

**Reads need a credential too.** They were open once, on the grounds that a
listing costs nothing — true of a deployment with one person on it. Once a board
belongs to somebody, reading it is reading their work, and an agent's transcript
is the most private thing here behind a guessable name.

**Do not break the machine path.** The VM tools have no cookie and no browser;
`test/machine-credential.test.ts` exists to catch that, because the failure is
silent — every running agent's callbacks start failing at once.

A repository is reachable only through an installation its **owner** made.
Without that check an installation *is* the permission, and on a two-person
deployment one person can name the other's private repo and be handed a working
token for it.

## What a run costs

Containers are the bill; the Worker and Durable Objects are rounding error.
Cloudflare charges per 10ms of runtime, so an idle slot costs nothing and
`max_instances` sets a ceiling rather than a spend.

Memory and disk are billed on *provisioned* resources for as long as the
container lives; CPU only on active use. So a slow agent that is mostly waiting
on the model still pays full memory — which is why run length, not CPU, is what
moves the bill.

| Tier | Instance | Per container-hour |
|---|---|---|
| one-cpu | standard-1 | $0.045 |
| two-cpu | standard-2 | $0.071 |
| four-cpu | standard-3 | $0.105 |

A typical 10-minute agent run on one-cpu is about **0.75 cents**. The $5/month
Workers Paid plan includes roughly 6 container-hours before anything is charged
(memory is the binding allowance, not CPU).

The exposure worth knowing: 20 one-cpu slots saturated 24/7 is about **$650 a
month**. That is what `max_instances` permits, not what anything is expected to
cost — but it is the reason `RUN_LIMIT` exists on a public deployment. The cap
bounds concurrency per person, not their total monthly spend; a hard budget
would need separate accounting.

## Harnesses

| Harness | State |
|---|---|
| `claude-code` | working |
| `pi` | working; pinned |
| `codex` | paused — harness defined, CLI not in the image |

Version pins in the `Dockerfile` are deliberate and load-bearing. pi is held at
0.84.0 because 0.86.0 offers the model no tools at all — same token, same
prompt, only the version differs. Re-test tool use before raising it, and do
not treat a pin as stale just because a newer version exists.

pi needs Node >= 22.19. The base image ships Node 20 at `/usr/local/bin`, which
precedes NodeSource's `/usr/bin` on PATH, so the upgrade is invisible unless
`node` is repointed — that is what the symlink in the `Dockerfile` is for.

## Style

Match the surrounding code: plain routing, comments that explain *why* a thing
is the way it is (usually because the obvious version broke), and no framework
where a handful of `if`s will do.
