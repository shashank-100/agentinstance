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
export type Provider = "socheap" | "moonshot";
export const PROVIDERS: Record<Provider, { baseUrl: string; keyVar: string }> = {
  socheap: { baseUrl: "https://socheap.ai/v1", keyVar: "SOCHEAP_API_KEY" },
  moonshot: { baseUrl: "https://api.moonshot.ai/v1", keyVar: "MOONSHOT_API_KEY" },
};

// Only models a configured provider can actually serve.
//
// socheap is a reseller and publishes no rate card (its /v1/models returns no
// pricing), so these are the upstream OpenAI list prices for the equivalent
// tier — an estimate, surfaced as "Est. rate" in the UI, not a billed figure.
export const MODELS: Record<string, ModelInfo> = {
  "gpt-5.6-terra": { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", priceIn: 2.5, priceOut: 15, provider: "socheap" },
  "gpt-5.6-sol": { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", priceIn: 5, priceOut: 30, provider: "socheap" },
  "gpt-5.5": { id: "gpt-5.5", label: "GPT-5.5", priceIn: 2.5, priceOut: 15, provider: "socheap" },
  "gpt-5.4": { id: "gpt-5.4", label: "GPT-5.4", priceIn: 2, priceOut: 12, provider: "socheap" },
  "gpt-5.4-mini": { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", priceIn: 0.15, priceOut: 0.6, provider: "socheap" },
  "kimi-k3": { id: "kimi-k3", label: "Kimi K3", priceIn: 3, priceOut: 15, provider: "moonshot" },

  // Claude Code authenticates with a subscription OAuth token, so the model
  // comes from whatever that token grants rather than from a provider key.
  // There is no base URL and no per-token rate to quote here.
  "claude-opus-4.8": {
    id: "claude-opus-4.8",
    label: "Claude Opus 4.8",
    priceIn: 0,
    priceOut: 0,
    provider: "socheap",
    oauth: true,
  },
};

/**
 * Which models each harness can actually drive.
 *
 * Claude Code speaks Anthropic's /v1/messages, so it runs Claude and nothing
 * else. The OpenAI-compatible models below it are listed in no harness at all:
 * the two CLIs that could drive them (pi, opencode) both worked locally and
 * failed inside the VM, so they were removed rather than shipped broken. The
 * models stay in the catalog, rendered unselectable, so the provider wiring
 * survives for whichever harness replaces them.
 */
export const HARNESS_MODELS: Record<string, string[]> = {
  "claude-code": ["claude-opus-4.8"],
};

/** `ready` marks what is actually implemented, so the builder can say so
 *  rather than presenting stubs and real code as equal choices. */
export interface CatalogEntry { desc: string; ready: boolean }

// A harness is the agent program that runs in the agent's VM. Each needs its
// own API key set as a Worker secret; `ready` says whether that key is present.
export const HARNESSES: Record<string, CatalogEntry> = {
  "claude-code": { desc: "Anthropic's Claude Code CLI.", ready: false },
};

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

// Every capability here is implemented and works with the configured keys.
export const CAPABILITIES: Record<string, CatalogEntry> = {
  scrape_web: { desc: "Fetch and extract page text.", ready: true },
  search_web: { desc: "Web search via Tavily.", ready: true },
  fetch_json: { desc: "Call any JSON HTTP API.", ready: true },
  run_shell: { desc: "Run shell commands in the agent's VM.", ready: true },
  browse_page: { desc: "Render a page in headless Chrome.", ready: true },
  remember: { desc: "Save a durable note for later sessions.", ready: true },
  recall: { desc: "Read notes saved in earlier sessions.", ready: true },
};

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
