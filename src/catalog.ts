// Catalog of models (with real pricing), harnesses, machine tiers, capabilities.
// Prices are USD per 1M tokens (input / output). Modeled on the public AgentSky catalog.

export interface ModelInfo {
  id: string;
  label: string;
  priceIn: number;
  priceOut: number;
  backend: "claude" | "openai" | "echo";
}

export const MODELS: Record<string, ModelInfo> = {
  "claude-fable-5": { id: "claude-fable-5", label: "Claude Fable 5", priceIn: 10, priceOut: 50, backend: "claude" },
  "claude-opus-5": { id: "claude-opus-5", label: "Claude Opus 5", priceIn: 5, priceOut: 25, backend: "claude" },
  "claude-sonnet-4-6": { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", priceIn: 3, priceOut: 15, backend: "claude" },
  "gpt-5.6-sol": { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", priceIn: 5, priceOut: 30, backend: "openai" },
  "gpt-5.6-terra": { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", priceIn: 2.5, priceOut: 15, backend: "openai" },
  "gpt-5.6-luna": { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", priceIn: 1, priceOut: 6, backend: "openai" },
  "deepseek-v4-pro": { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", priceIn: 0.44, priceOut: 0.87, backend: "openai" },
  "deepseek-v4-flash": { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", priceIn: 0.14, priceOut: 0.28, backend: "openai" },
  "gemini-3.5-flash": { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", priceIn: 1.5, priceOut: 9, backend: "openai" },
  "glm-5.2": { id: "glm-5.2", label: "GLM-5.2", priceIn: 1.4, priceOut: 4.4, backend: "openai" },
  "kimi-k3": { id: "kimi-k3", label: "Kimi K3", priceIn: 3, priceOut: 15, backend: "openai" },
};

export const HARNESSES: Record<string, string> = {
  chat: "Simple single-loop chat harness (default).",
  "claude-code": "Claude Code harness — best for coding & tool use.",
  codex: "Codex harness — fast, lightweight loop.",
  hermes: "Hermes — multi-agent orchestration.",
  openclaw: "OpenClaw — always-on autonomy.",
};

export interface MachineTier { label: string; ramGb: number; usdPerHour: number; }
export const MACHINES: Record<string, MachineTier> = {
  "1gb": { label: "1 GB", ramGb: 1, usdPerHour: 0.021 },
  "2gb": { label: "2 GB", ramGb: 2, usdPerHour: 0.038 },
  "4gb": { label: "4 GB", ramGb: 4, usdPerHour: 0.071 },
};
export const DEFAULT_MACHINE = "4gb";

export const CAPABILITIES: Record<string, string> = {
  scrape_web: "Fetch and extract content from web pages.",
  browser_use: "Drive a real browser.",
  search_serp: "Search-engine results.",
  generate_image: "Text-to-image generation.",
  remove_image_bg: "Remove image background.",
  generate_video: "Text-to-video generation.",
  image_to_video: "Animate an image into video.",
  transcribe_voice: "Speech-to-text transcription.",
  email: "Send/receive email.",
};

export function estimateMonthCost(machine = DEFAULT_MACHINE): number {
  const tier = MACHINES[machine];
  return Math.round(tier.usdPerHour * 24 * 30 * 100) / 100;
}
