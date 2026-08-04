# Deploying Nimbus

Nimbus runs entirely on Cloudflare Workers + Durable Objects. One agent = one
Durable Object with its own SQLite storage.

## 1. Prerequisites

- A Cloudflare account (free tier works; Durable Objects with SQLite storage are included).
- Node 18+ and `npm`.

## 2. Install & authenticate

```bash
npm install
npx wrangler login
```

## 3. Deploy

```bash
npm run deploy
```

This publishes the Worker, creates the `AgentDO` Durable Object namespace (via the
`v1` migration in `wrangler.jsonc`), and serves the landing page from `public/`.

## 4. Add secrets (optional)

Without any model key, agents use an offline echo model. To use real models/channels:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
# ...and any channel/capability keys you need (see .dev.vars.example)
```

## 5. Create and talk to an agent

```bash
export NIMBUS_URL=https://nimbus.<your-subdomain>.workers.dev

node cli/nimbus.mjs launch mybot --harness chat --model claude-sonnet-4-6
node cli/nimbus.mjs send mybot "hello"
node cli/nimbus.mjs status mybot
```

## 6. Wire a channel (Telegram example)

Point Telegram's webhook at your deployment:

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=$NIMBUS_URL/channels/telegram/mybot"
```

Now messages to your bot drive the `mybot` agent, and its reply is sent back to
the same chat. History is unified at the agent level, so the same `mybot` can
also be reached on Slack/Discord/WhatsApp/web/CLI with shared context.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in any keys
npm run dev                       # http://localhost:8787
npm test                          # Workers test suite
```

## Cost model

Durable Objects hibernate when idle — a **parked agent costs nothing**. You pay
for model tokens and active compute only. See `src/catalog.ts` for the modeled
per-model pricing and machine tiers.
