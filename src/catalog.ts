// Catalog of models, harnesses, machine tiers, capabilities.
// Prices are USD per 1M tokens (input / output).

export interface ModelInfo {
  id: string;
  label: string;
  priceIn: number;
  priceOut: number;
  /** OpenAI-compatible host serving this model. */
  provider: Provider;
  /** Upstream's own name for the model, when it differs from our catalog id. */
  upstreamId?: string;
  /** Served by a subscription token rather than a provider key: no rate to show. */
  oauth?: boolean;
}

/** OpenAI-compatible providers, reached by swapping base_url (no lock-in).
 *  Add one here plus its key in Env to offer its models. */
export type Provider = "moonshot";
export const PROVIDERS: Record<Provider, { baseUrl: string; keyVar: string }> = {
  moonshot: { baseUrl: "https://api.moonshot.ai/v1", keyVar: "MOONSHOT_API_KEY" },
};

// Only models a configured provider can actually serve.
export const MODELS: Record<string, ModelInfo> = {
  "kimi-k3": { id: "kimi-k3", label: "Kimi K3", priceIn: 3, priceOut: 15, provider: "moonshot" },

  // Claude Code authenticates with a subscription OAuth token, so the model
  // comes from whatever that token grants rather than from a provider key.
  // There is no base URL and no per-token rate to quote here.
  "claude-opus-4.8": {
    id: "claude-opus-4.8",
    label: "Claude Opus 4.8",
    priceIn: 0,
    priceOut: 0,
    provider: "moonshot",
    oauth: true,
  },
};

/**
 * Which models each harness can actually drive.
 *
 * Claude Code speaks Anthropic's /v1/messages, so it runs Claude and nothing
 * else. Kimi is listed in no harness at all: the two CLIs that could drive an
 * OpenAI-compatible model (pi, opencode) both worked locally and failed inside
 * the VM, so they were removed rather than shipped broken. It stays in the
 * catalog, rendered unselectable, so the provider wiring survives for whichever
 * harness replaces them.
 */
export const HARNESS_MODELS: Record<string, string[]> = {
  "claude-code": ["claude-opus-4.8"],
  // pi carries its own model catalog and speaks each provider's API directly,
  // so it drives the OpenAI-compatible models Claude Code cannot reach.
  pi: ["kimi-k3"],
};

/**
 * `ready` marks what a given deployment can actually run, so the builder can
 * say so rather than presenting stubs and real code as equal choices.
 *
 * It is computed per request from that deployment's secrets, never stored: a
 * hardcoded flag describes whoever wrote it, and every other deployer sees a
 * builder that is wrong about their own setup — offering what they cannot run
 * and greying out what they can.
 */
export interface CatalogEntry { desc: string; ready: boolean }

/** A catalog entry before readiness is known: the parts that never change. */
interface Described { desc: string; needs: (env: KeyEnv) => boolean }

/** The subset of Env this file reads. Keeps the catalog free of the Worker's
 *  binding types, which it has no other reason to know about. */
export type KeyEnv = Record<string, unknown>;

const has = (env: KeyEnv, key: string): boolean => {
  const v = env[key];
  return typeof v === "string" && v.trim() !== "";
};

// A harness is the agent program that runs in the agent's VM, and it can only
// run on a model whose provider this deployment holds a key for.
const HARNESS_DEFS: Record<string, Described> = {
  "claude-code": {
    desc: "Anthropic's Claude Code CLI.",
    // A subscription token, or any key that can serve a model it drives.
    needs: (env) => has(env, "CLAUDE_CODE_OAUTH_TOKEN"),
  },
  pi: {
    desc: "The pi coding agent — runs the OpenAI-compatible models.",
    // Ready when any provider serving a model pi drives has a key.
    needs: (env) =>
      (HARNESS_MODELS.pi ?? []).some((id) => {
        const info = MODELS[id];
        return info && !info.oauth && has(env, PROVIDERS[info.provider].keyVar);
      }),
  },
};

/** Descriptions only — for code that needs the list without an env. */
export const HARNESSES: Record<string, { desc: string }> = Object.fromEntries(
  Object.entries(HARNESS_DEFS).map(([id, d]) => [id, { desc: d.desc }]),
);

/** What this deployment can actually run, given the secrets it has. */
export function harnessCatalog(env: KeyEnv): Record<string, CatalogEntry> {
  return Object.fromEntries(
    Object.entries(HARNESS_DEFS).map(([id, d]) => [id, { desc: d.desc, ready: d.needs(env) }]),
  );
}

/**
 * A machine tier maps to a Cloudflare container instance type, and each
 * instance type needs its own container class — `instance_type` is fixed per
 * class and cannot be picked per request. `binding` names the Worker binding
 * for that class; see the `containers` array in wrangler.jsonc.
 *
 * Tiers are named for vCPU because that is what limits an agent. The harness
 * itself is I/O-bound waiting on the model, but anything run_shell does —
 * installing packages, compiling, processing data — is CPU-bound and
 * single-core. Memory and disk come along with the instance type and are kept
 * here for the record, not as the thing being chosen.
 */
export interface MachineTier {
  label: string;
  vcpu: number;
  ramGb: number;
  diskGb: number;
  usdPerHour: number;
  binding: "SANDBOX_SMALL" | "SANDBOX_MEDIUM" | "SANDBOX_LARGE";
}

// Specs are Cloudflare's published instance types; the rates are their
// per-hour active figures for each.
export const MACHINES: Record<string, MachineTier> = {
  "half-cpu": {
    label: "½ vCPU", vcpu: 0.5, ramGb: 4, diskGb: 8,
    usdPerHour: 0.038, binding: "SANDBOX_SMALL",
  },
  "one-cpu": {
    label: "1 vCPU", vcpu: 1, ramGb: 6, diskGb: 12,
    usdPerHour: 0.071, binding: "SANDBOX_MEDIUM",
  },
  "two-cpu": {
    label: "2 vCPU", vcpu: 2, ramGb: 8, diskGb: 16,
    usdPerHour: 0.104, binding: "SANDBOX_LARGE",
  },
};
export const DEFAULT_MACHINE = "half-cpu";

// Every capability here is implemented; `ready` says whether this particular
// deployment holds the key or binding it needs.
const CAPABILITY_DEFS: Record<string, Described> = {
  scrape_web: { desc: "Fetch and extract page text.", needs: () => true },
  search_web: { desc: "Web search via Tavily.", needs: (env) => has(env, "TAVILY_API_KEY") },
  fetch_json: { desc: "Call any JSON HTTP API.", needs: () => true },
  run_shell: { desc: "Run shell commands in the agent's VM.", needs: () => true },
  // A binding rather than a secret, so presence is the test, not emptiness.
  browse_page: {
    desc: "Render a page in headless Chrome.",
    needs: (env) => env.BROWSER != null,
  },
  remember: { desc: "Save a durable note for later sessions.", needs: () => true },
  recall: { desc: "Read notes saved in earlier sessions.", needs: () => true },
  // Agent-to-agent. Needs nothing beyond the deployment itself: the message
  // goes to another agent in this same Worker, over its own front door.
  send_to_agent: { desc: "Message another agent and get its reply.", needs: () => true },
  list_agents: { desc: "List the other agents on this deployment.", needs: () => true },
  // The work queue, from inside the VM: claim a task, record a branch or a
  // pull request against it, and settle it.
  fleet_task: { desc: "Claim and complete tasks from the work queue.", needs: () => true },
  // Git against a real remote. Without a token an agent can still clone a
  // public repo but cannot push, so this is offered only when one is set.
  git_repo: {
    desc: "Clone, branch, commit and push a repository.",
    needs: (env) => has(env, "GITHUB_TOKEN"),
  },
  open_pr: {
    desc: "Open a pull request on GitHub.",
    needs: (env) => has(env, "GITHUB_TOKEN"),
  },
};

/** Descriptions only — for code that needs the list without an env. */
export const CAPABILITIES: Record<string, { desc: string }> = Object.fromEntries(
  Object.entries(CAPABILITY_DEFS).map(([id, d]) => [id, { desc: d.desc }]),
);

/** What this deployment can actually run, given the secrets it has. */
export function capabilityCatalog(env: KeyEnv): Record<string, CatalogEntry> {
  return Object.fromEntries(
    Object.entries(CAPABILITY_DEFS).map(([id, d]) => [id, { desc: d.desc, ready: d.needs(env) }]),
  );
}

/**
 * What the machine costs per hour while it is running.
 *
 * Not a monthly figure: containers sleep when idle and bill per 10ms of active
 * time, so a 24×30 projection describes the one case that never happens and
 * overstates a typical agent by orders of magnitude.
 */
export function hourlyCost(machine = DEFAULT_MACHINE): number {
  return MACHINES[machine]?.usdPerHour ?? 0;
}
