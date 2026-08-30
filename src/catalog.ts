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
}

/** OpenAI-compatible providers, reached by swapping base_url (no lock-in).
 *  Add one here plus its key in Env to offer its models. */
export type Provider = "socheap" | "moonshot";
export const PROVIDERS: Record<Provider, { baseUrl: string; keyVar: string }> = {
  socheap: { baseUrl: "https://socheap.ai/v1", keyVar: "SOCHEAP_API_KEY" },
  moonshot: { baseUrl: "https://api.moonshot.ai/v1", keyVar: "MOONSHOT_API_KEY" },
};

// Only models a configured provider can actually serve. Prices are the
// provider's list rates; socheap is a reseller, so verify before relying on
// the cost estimate.
export const MODELS: Record<string, ModelInfo> = {
  "gpt-5.6-terra": { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", priceIn: 2.5, priceOut: 15, provider: "socheap" },
  "gpt-5.6-sol": { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", priceIn: 5, priceOut: 30, provider: "socheap" },
  "gpt-5.5": { id: "gpt-5.5", label: "GPT-5.5", priceIn: 2.5, priceOut: 15, provider: "socheap" },
  "gpt-5.4": { id: "gpt-5.4", label: "GPT-5.4", priceIn: 2, priceOut: 12, provider: "socheap" },
  "gpt-5.4-mini": { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", priceIn: 0.15, priceOut: 0.6, provider: "socheap" },
  "kimi-k3": { id: "kimi-k3", label: "Kimi K3", priceIn: 3, priceOut: 15, provider: "moonshot" },
};

/** `ready` marks what is actually implemented, so the builder can say so
 *  rather than presenting stubs and real code as equal choices. */
export interface CatalogEntry { desc: string; ready: boolean }

// Only harnesses that actually exist. `shell` is the sandbox-backed
// command loop (CliHarness); it needs a sandbox configured to do anything.
export const HARNESSES: Record<string, CatalogEntry> = {
  chat: { desc: "Single-loop chat with tool calling.", ready: true },
  shell: { desc: "Runs shell commands in a sandbox.", ready: false },
};

export interface MachineTier { label: string; ramGb: number; usdPerHour: number; }
export const MACHINES: Record<string, MachineTier> = {
  "1gb": { label: "1 GB", ramGb: 1, usdPerHour: 0.021 },
  "2gb": { label: "2 GB", ramGb: 2, usdPerHour: 0.038 },
  "4gb": { label: "4 GB", ramGb: 4, usdPerHour: 0.071 },
};
export const DEFAULT_MACHINE = "4gb";

// ready:false entries are stubs — selectable, but they return a "configure a
// provider" note instead of doing the work. See src/capabilities/index.ts.
export const CAPABILITIES: Record<string, CatalogEntry> = {
  scrape_web: { desc: "Fetch and extract page text.", ready: true },
  search_web: { desc: "Web search via Tavily.", ready: true },
  browser_use: { desc: "Drive a real browser.", ready: false },
  remove_image_bg: { desc: "Remove image background.", ready: false },
  generate_video: { desc: "Text-to-video generation.", ready: false },
  image_to_video: { desc: "Animate an image into video.", ready: false },
  transcribe_voice: { desc: "Speech-to-text transcription.", ready: false },
  crm: { desc: "Read/write CRM records.", ready: false },
  social_listening: { desc: "Monitor social mentions.", ready: false },
  file_management: { desc: "Store, list, fetch agent files.", ready: false },
};

export function estimateMonthCost(machine = DEFAULT_MACHINE): number {
  const tier = MACHINES[machine];
  return Math.round(tier.usdPerHour * 24 * 30 * 100) / 100;
}
