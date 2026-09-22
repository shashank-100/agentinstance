export type Harness = "claude-code" | "pi";
export type TaskStatus = "queued" | "provisioning" | "running" | "review" | "merged" | "failed";
export type Runtime = "node-22" | "bun-1.2" | "python-3.12";

export interface CheckRun {
  id: string;
  name: string;
  status: "pass" | "fail" | "running" | "queued";
  duration: string;
  detail: string;
}

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk";
  old?: number;
  new?: number;
  text: string;
}

export interface FileDiff {
  path: string;
  added: number;
  removed: number;
  lines: DiffLine[];
}

export interface LogLine {
  t: string;
  stream: "stdout" | "stderr" | "event" | "tool";
  text: string;
}

export interface GraphNode {
  id: string;
  label: string;
  kind: "plan" | "tool" | "test" | "commit" | "handoff";
  status: "done" | "active" | "pending" | "failed";
  meta: string;
}

export interface Task {
  id: string;
  number: number;
  title: string;
  prompt: string;
  /** The pull request an agent opened, or null before there is one. */
  prUrl?: string | null;
  /**
   * The queue's own word for where this task is, unmapped.
   *
   * `status` above is the UI's vocabulary, which has `review` and
   * `provisioning` that the queue never produces and lacks `settled`. Actions
   * that must match what the API will accept — requeueing, which the API
   * allows only from `running` or `failed` — read this instead.
   */
  state?: "queued" | "running" | "settled" | "failed";
  harness: Harness;
  runtime: Runtime;
  status: TaskStatus;
  repo: string;
  branch: string;
  vm: string;
  boot: string;
  tokens: number;
  cost: string;
  elapsed: string;
  updated: string;
  filesChanged: number;
  added: number;
  removed: number;
  checks: CheckRun[];
  files: FileDiff[];
  logs: LogLine[];
  graph: GraphNode[];
}

export const harnessLabel: Record<Harness, string> = {
  "claude-code": "Claude Code",
  pi: "Pi Harness",
};

export const runtimeLabel: Record<Runtime, string> = {
  "node-22": "Node 22",
  "bun-1.2": "Bun 1.2",
  "python-3.12": "Python 3.12",
};

// `merged` is the UI's key for the API's `settled`, which means "over, and not
// a failure" — a pull request opened and closed is as settled as one merged.
// Labelling it "Merged" asserted something the queue never records.
export const statusLabel: Record<TaskStatus, string> = {
  queued: "Queued",
  provisioning: "Provisioning",
  running: "Running",
  review: "Review required",
  merged: "Settled",
  failed: "Failed",
};

const stripeDiff: FileDiff[] = [
  {
    path: "src/server/stripe/webhook.ts",
    added: 38,
    removed: 11,
    lines: [
      { kind: "hunk", text: "@@ -18,11 +18,38 @@ export async function handleStripeEvent(" },
      {
        kind: "ctx",
        old: 18,
        new: 18,
        text: "  const event = verifySignature(rawBody, signature);",
      },
      { kind: "ctx", old: 19, new: 19, text: "" },
      { kind: "del", old: 20, text: "  if (event.type === 'customer.subscription.updated') {" },
      { kind: "del", old: 21, text: "    await setPlan(event.data.object.customer, 'pro');" },
      { kind: "del", old: 22, text: "  }" },
      { kind: "add", new: 20, text: "  switch (event.type) {" },
      { kind: "add", new: 21, text: "    case 'customer.subscription.created':" },
      { kind: "add", new: 22, text: "    case 'customer.subscription.updated': {" },
      { kind: "add", new: 23, text: "      const sub = event.data.object as Stripe.Subscription;" },
      {
        kind: "add",
        new: 24,
        text: "      const tier = resolveTier(sub.items.data[0]?.price.id);",
      },
      { kind: "add", new: 25, text: "      await setPlan(sub.customer as string, tier, {" },
      { kind: "add", new: 26, text: "        seats: sub.items.data[0]?.quantity ?? 1," },
      { kind: "add", new: 27, text: "        periodEnd: sub.current_period_end," },
      { kind: "add", new: 28, text: "      });" },
      { kind: "add", new: 29, text: "      break;" },
      { kind: "add", new: 30, text: "    }" },
      { kind: "add", new: 31, text: "    case 'customer.subscription.deleted':" },
      {
        kind: "add",
        new: 32,
        text: "      await setPlan(event.data.object.customer as string, 'free');",
      },
      { kind: "add", new: 33, text: "      break;" },
      { kind: "add", new: 34, text: "    default:" },
      { kind: "add", new: 35, text: "      logUnhandled(event.type);" },
      { kind: "add", new: 36, text: "  }" },
      { kind: "ctx", old: 23, new: 37, text: "" },
      { kind: "ctx", old: 24, new: 38, text: "  return new Response('ok');" },
    ],
  },
  {
    path: "src/server/stripe/tiers.ts",
    added: 24,
    removed: 0,
    lines: [
      { kind: "hunk", text: "@@ -0,0 +1,24 @@" },
      { kind: "add", new: 1, text: "import type Stripe from 'stripe';" },
      { kind: "add", new: 2, text: "" },
      { kind: "add", new: 3, text: "export type Tier = 'free' | 'starter' | 'pro' | 'scale';" },
      { kind: "add", new: 4, text: "" },
      { kind: "add", new: 5, text: "const PRICE_TO_TIER: Record<string, Tier> = {" },
      { kind: "add", new: 6, text: "  price_starter_monthly: 'starter'," },
      { kind: "add", new: 7, text: "  price_pro_monthly: 'pro'," },
      { kind: "add", new: 8, text: "  price_scale_monthly: 'scale'," },
      { kind: "add", new: 9, text: "};" },
      { kind: "add", new: 10, text: "" },
      { kind: "add", new: 11, text: "export function resolveTier(priceId?: string): Tier {" },
      { kind: "add", new: 12, text: "  if (!priceId) return 'free';" },
      { kind: "add", new: 13, text: "  return PRICE_TO_TIER[priceId] ?? 'free';" },
      { kind: "add", new: 14, text: "}" },
    ],
  },
  {
    path: "src/server/stripe/webhook.test.ts",
    added: 41,
    removed: 3,
    lines: [
      { kind: "hunk", text: "@@ -1,3 +1,41 @@" },
      { kind: "del", old: 1, text: "test('updates plan', async () => {" },
      { kind: "del", old: 2, text: "  await handle(fixture('sub.updated'));" },
      { kind: "del", old: 3, text: "});" },
      { kind: "add", new: 1, text: "describe('tiered subscription webhooks', () => {" },
      {
        kind: "add",
        new: 2,
        text: "  it.each(['starter', 'pro', 'scale'])('maps %s price to tier', async (tier) => {",
      },
      {
        kind: "add",
        new: 3,
        text: "    await handle(fixture('sub.updated', { price: `price_${tier}_monthly` }));",
      },
      { kind: "add", new: 4, text: "    expect(await planOf('cus_123')).toBe(tier);" },
      { kind: "add", new: 5, text: "  });" },
      { kind: "add", new: 6, text: "" },
      { kind: "add", new: 7, text: "  it('downgrades on subscription.deleted', async () => {" },
      { kind: "add", new: 8, text: "    await handle(fixture('sub.deleted'));" },
      { kind: "add", new: 9, text: "    expect(await planOf('cus_123')).toBe('free');" },
      { kind: "add", new: 10, text: "  });" },
      { kind: "add", new: 11, text: "});" },
    ],
  },
];

const scraperDiff: FileDiff[] = [
  {
    path: "scripts/scrape_changelog.py",
    added: 27,
    removed: 4,
    lines: [
      { kind: "hunk", text: "@@ -12,4 +12,27 @@ def fetch(url: str) -> str:" },
      { kind: "del", old: 12, text: "    rows = soup.select('.entry')" },
      { kind: "add", new: 12, text: "    rows = soup.select('article.changelog-entry')" },
      { kind: "add", new: 13, text: "    for row in rows:" },
      { kind: "add", new: 14, text: "        yield {" },
      { kind: "add", new: 15, text: "            'version': row.select_one('h3').text.strip()," },
      { kind: "add", new: 16, text: "            'date': parse_date(row['data-published'])," },
      { kind: "add", new: 17, text: "            'notes': md(row.select_one('.body'))," },
      { kind: "add", new: 18, text: "        }" },
      { kind: "ctx", old: 13, new: 19, text: "" },
      { kind: "ctx", old: 14, new: 20, text: "if __name__ == '__main__':" },
    ],
  },
];

const cacheDiff: FileDiff[] = [
  {
    path: "src/lib/cache/redis.ts",
    added: 9,
    removed: 16,
    lines: [
      { kind: "hunk", text: "@@ -41,16 +41,9 @@ export async function remember(" },
      { kind: "del", old: 41, text: "  const existing = await client.get(key);" },
      { kind: "del", old: 42, text: "  if (existing) return JSON.parse(existing);" },
      { kind: "del", old: 43, text: "  const fresh = await loader();" },
      {
        kind: "add",
        new: 41,
        text: "  const [existing] = await client.multi().get(key).ttl(key).exec();",
      },
      { kind: "add", new: 42, text: "  if (existing) return decode(existing);" },
      { kind: "add", new: 43, text: "  const fresh = await singleflight(key, loader);" },
      {
        kind: "ctx",
        old: 44,
        new: 44,
        text: "  await client.set(key, JSON.stringify(fresh), 'EX', ttl);",
      },
      { kind: "ctx", old: 45, new: 45, text: "  return fresh;" },
    ],
  },
];
