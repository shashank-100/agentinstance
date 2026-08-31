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
 * The two CLIs speak different wire formats: Claude Code talks Anthropic's
 * /v1/messages, Pi talks OpenAI's /chat/completions. Pairing a harness with a
 * model it cannot reach produces a 404 at run time, so the builder offers only
 * the combinations that work instead of letting the pairing fail later.
 */
export const HARNESS_MODELS: Record<string, string[]> = {
  "claude-code": ["claude-opus-4.8"],
  pi: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
};

/** The model a harness starts on. */
export function defaultModelFor(harness: string): string {
  return HARNESS_MODELS[harness]?.[0] ?? "gpt-5.6-terra";
}

/** `ready` marks what is actually implemented, so the builder can say so
 *  rather than presenting stubs and real code as equal choices. */
export interface CatalogEntry { desc: string; ready: boolean }

// A harness is the agent program that runs in the agent's VM. Each needs its
// own API key set as a Worker secret; `ready` says whether that key is present.
export const HARNESSES: Record<string, CatalogEntry> = {
  "claude-code": { desc: "Anthropic's Claude Code CLI.", ready: false },
  pi: { desc: "The Pi agent CLI.", ready: false },
};

export interface MachineTier { label: string; ramGb: number; usdPerHour: number; }
export const MACHINES: Record<string, MachineTier> = {
  "1gb": { label: "1 GB", ramGb: 1, usdPerHour: 0.021 },
  "2gb": { label: "2 GB", ramGb: 2, usdPerHour: 0.038 },
  "4gb": { label: "4 GB", ramGb: 4, usdPerHour: 0.071 },
};
export const DEFAULT_MACHINE = "4gb";

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

export function estimateMonthCost(machine = DEFAULT_MACHINE): number {
  const tier = MACHINES[machine];
  return Math.round(tier.usdPerHour * 24 * 30 * 100) / 100;
}
