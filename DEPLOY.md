# Deploying agentinstance

agentinstance runs entirely on Cloudflare Workers + Durable Objects. One agent = one
Durable Object with its own SQLite storage.

## 1. Prerequisites

- A Cloudflare account on a **paid Workers plan** — containers are not on the
  free tier, and every agent runs in one.
- Node 18+ and `npm`.
- **A running Docker daemon.** `wrangler deploy` builds the agent's image and
  pushes it to Cloudflare's registry, and fails without one. Docker Desktop
  works; on macOS, [colima](https://github.com/abiosoft/colima) is a lighter
  alternative (`brew install colima && colima start`). If colima's first start
  reports that the hostagent missed its deadline, the VM is usually up anyway —
  `colima delete -f` and start again rather than reading the log.
- A Claude subscription, for the model an agent runs on.

## 2. Install & authenticate

```bash
npm install
npx wrangler login
```

## 3. Deploy

```bash
npm run deploy
```

This publishes the Worker, creates the Durable Object namespaces, builds the
container image from `Dockerfile`, and serves the landing page from `public/`.

The first deploy takes a while: the image is ~700MB and is uploaded to
Cloudflare's registry. Two things to know if it fails.

**`connection reset by peer` during the push.** A layer uploads as a single
request, so a reset partway through discards it and the retry starts over. On a
slow or flaky link a large layer may never land. Retrying usually works;
keeping each `RUN npm install -g` to one CLI keeps layers small enough to
resume. `wrangler deploy --containers-rollout=none` ships the Worker alone if
you need the code out while sorting the image — but it leaves agents on the
previously published image, so do not treat it as a successful deploy.

**`wrangler deploy` can exit 0 after the image push failed.** Check the output
for `Current Version ID`; its absence means the deploy did not complete.

## 4. Add secrets

A model key is required — without one, `send` returns an error instead of a
reply. Everything else is optional, and each capability is offered to agents
only when its key is present (`/catalog` reports what is actually ready).

```bash
# Required: the model agents run on. A Claude subscription token, which both
# harnesses authenticate with — so there is no per-token API rate to pay.
npx wrangler secret put CLAUDE_CODE_OAUTH_TOKEN

# The machine credential: an agent's tools call back from inside a container
# over plain HTTP with no cookie, and carry this. It is also what protects a
# deployment that has no sign-in configured — with neither this nor
# GITHUB_CLIENT_ID set, every route is open to anyone with the URL.
# Any long random string: `openssl rand -hex 32`.
npx wrangler secret put FLEET_TOKEN

# Optional: lets agents clone, push and open pull requests.
# Either a GitHub App (preferred — see below) or a personal access token.
npx wrangler secret put GITHUB_TOKEN

# Optional: channels and capabilities. See .dev.vars.example for the full list.
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

Secrets apply to the running Worker, but a deploy already in flight will not
pick up one set after it started — redeploy if you add a secret mid-deploy.

### Giving agents GitHub access

A **personal access token** works, but is easy to get subtly wrong: a
fine-grained token needs **Contents: read+write** and **Pull requests:
read+write**. Without write, an agent clones and commits happily and then fails
at `git push` with a 403. You cannot verify this from the API — the
`permissions` block on `GET /repos/:owner/:repo` describes *your account's*
access, not the token's grants, so a read-only token looks identical to a
writable one until a push fails.

A **GitHub App** avoids that entirely: it declares its own permissions, so
installing is a consent screen rather than a form, and the tokens it mints
expire in an hour.

```bash
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY   # PKCS#8 — see below
npx wrangler secret put GITHUB_APP_SLUG          # the name in github.com/apps/<slug>
```

GitHub issues private keys in PKCS#1 (`BEGIN RSA PRIVATE KEY`); WebCrypto reads
only PKCS#8. Convert before setting it, or authentication fails later with
nothing pointing here:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in downloaded.pem -out key.pem
```

Then visit `/github/install` on your deployment to install the App on the
repositories agents may touch. `/github/status` reports which credential is in
use.

### Letting people sign in

Sign-in is GitHub's, through the App above — a GitHub App can authenticate
people itself, so there is no separate OAuth App. Both values come from the
App's own settings page:

```bash
npx wrangler secret put GITHUB_CLIENT_ID       # shown on the App settings page
npx wrangler secret put GITHUB_CLIENT_SECRET   # generate it there
```

**The App must know the callback URL** or GitHub refuses the redirect. Add it
under *Callback URL* on the App settings page:

```
https://<your-worker>.workers.dev/auth/callback
```

A GitHub App accepts several callback URLs. If you run more than one
deployment, **add** each one rather than replacing the existing entry —
replacing it breaks sign-in on the deployment that was working.

Then decide who may in. Two ways, and a deployment must pick one:

```bash
# Invite-only: a comma-separated list of GitHub logins.
npx wrangler secret put ALLOWED_LOGINS

# Or open sign-up, where everyone brings their own model key (see below).
npx wrangler secret put BYOK        # any non-empty value
```

With neither, nobody can sign in. That is deliberate: every agent otherwise
runs on this deployment's subscription and boots a container on its account, so
a deployment that has not said who may in has not said "everyone".

### A second, public deployment

To run a deployment open to other people alongside your own, deploy a second
Worker from the same repo with `wrangler.public.jsonc`:

```bash
npx wrangler deploy --config wrangler.public.jsonc
```

It is a separate Worker with its own Durable Objects, so its agents, boards and
keys are entirely separate from yours. The reason it is a config file rather
than a `--name` override: a container application's name is account-global and
is fixed at first deploy, so the two deployments need distinct container names
or the second collides with the first.

`wrangler.public.jsonc` is generated from `wrangler.jsonc` — regenerate it after
changing the base rather than editing both.

Its secrets differ from a private deployment in one important way: **it holds no
model credential**. That is what makes open sign-up affordable.

```bash
A=agentinstance-app

npx wrangler secret put BYOK --name $A               # open sign-up, own key
npx wrangler secret put RUN_LIMIT --name $A          # concurrent runs per person
npx wrangler secret put GITHUB_CLIENT_ID --name $A
npx wrangler secret put GITHUB_CLIENT_SECRET --name $A
npx wrangler secret put FLEET_TOKEN --name $A        # its own, not shared
npx wrangler secret put BOARD_URL --name $A          # where its board lives
npx wrangler secret put CORS_ORIGINS --name $A       # that board's origin
```

`BOARD_URL` and `CORS_ORIGINS` matter when the board is a separate Worker from
the API. `BOARD_URL` is where `/` redirects and where sign-in returns to;
`CORS_ORIGINS` is the allowlist of origins that may call the API with a session
cookie. Without the latter the browser drops the cookie on every request and a
signed-in person sees 401s.

`/catalog` on such a deployment reports **no harness ready** until a signed-in
person saves their own key on the board. If it ever reports one ready before
that, `BYOK` is not taking effect and strangers are spending your subscription.

## 5. Create and talk to an agent

Dispatch a task from the board, which launches an agent for it, or use the API:

```bash
export AGENTINSTANCE_URL=https://agentinstance.<your-subdomain>.workers.dev

curl -X POST "$AGENTINSTANCE_URL/api/launch" -H 'content-type: application/json' \
  -d '{"id":"mybot","harness":"claude-code","model":"claude-opus-5","capabilities":["search_web","remember","recall"]}'

curl -X POST "$AGENTINSTANCE_URL/agents/mybot/send" -H 'content-type: application/json' \
  -d '{"text":"hello"}'
```

## 6. Wire a channel (Telegram example)

Point Telegram's webhook at your deployment:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=$AGENTINSTANCE_URL/channels/telegram/mybot"
```

Now messages to your bot drive the `mybot` agent, and its reply goes back to the
same chat. History is unified at the agent level, so the same `mybot` reached
over the web UI or the API shares that context.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in any keys
npm run dev                       # http://localhost:8787
npm test                          # Workers test suite
```

## Cost model

Durable Objects hibernate when idle — an **idle agent costs nothing**. You pay
for model tokens and active compute only. See `src/catalog.ts` for the modeled
per-model pricing and machine tiers.
