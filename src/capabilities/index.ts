// Feature #13 — built-in capabilities ("the hands that reach").
// Each capability is a callable tool. Only capabilities enabled in the agent's
// spec are exposed. Implementations use plain fetch so they run on Workers.
import type { Env } from "../types.js";

export interface Capability {
  name: string;
  describe: string;
  /** JSON Schema for the tool input, when this capability is model-callable. */
  parameters?: Record<string, unknown>;
  run(env: Env, input: Record<string, unknown>): Promise<unknown>;
}

export const scrapeWeb: Capability = {
  name: "scrape_web",
  describe: "Fetch a URL and return its readable text content.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute URL to fetch." } },
    required: ["url"],
  },
  async run(_env, input) {
    const url = String(input.url ?? "");
    if (!url) throw new Error("scrape_web requires { url }");
    const res = await fetch(url, { headers: { "user-agent": "AgentInstanceBot/0.1" } });
    const html = await res.text();
    // crude text extraction: strip tags, collapse whitespace
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { url, status: res.status, text: text.slice(0, 8000) };
  },
};

export const searchWeb: Capability = {
  name: "search_web",
  describe:
    "Search the web and return the top results (title, url, snippet). " +
    "Use for current facts, companies, people, or anything not in your training data.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "The search query." } },
    required: ["query"],
  },
  async run(env, input) {
    const q = String(input.query ?? "");
    if (!q) throw new Error("search_web requires { query }");
    if (!env.TAVILY_API_KEY) return { query: q, results: [], note: "TAVILY_API_KEY not set" };
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query: q,
        max_results: 5,
        include_answer: true,
      }),
    });
    if (!res.ok) throw new Error(`tavily ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      answer?: string | null;
      results?: { title?: string; url?: string; content?: string }[];
    };
    // Keep only what a model needs — raw search payloads are enormous.
    return {
      query: q,
      answer: data.answer ?? null,
      results: (data.results ?? []).slice(0, 5).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content?.slice(0, 400),
      })),
    };
  },
};

export const generateImage: Capability = {
  name: "generate_image",
  describe:
    "Generate an image from a text prompt and return its URL. " +
    "Describe the desired image in full; the prompt is not rewritten.",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What the image should depict." },
    },
    required: ["prompt"],
  },
  async run(env, input) {
    const prompt = String(input.prompt ?? "");
    if (!env.OPENAI_API_KEY) return { prompt, url: null, note: "OPENAI_API_KEY not set" };
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "gpt-image-1", prompt, n: 1 }),
    });
    const data = (await res.json()) as { data?: { url?: string }[] };
    return { prompt, url: data.data?.[0]?.url ?? null };
  },
};

// Lightweight stubs for capabilities that need an external provider/config.
// They return a clear "configure me" result rather than failing, so the whole
// catalog is selectable and the wiring is testable without third-party keys.
function stub(name: string, note: string): Capability {
  return {
    name,
    describe: note,
    async run(_env, input) {
      return { capability: name, note: `${note} (stub — configure a provider to enable)`, input };
    },
  };
}

export const generateVideo = stub("generate_video", "Text-to-video generation.");
export const crm = stub("crm", "Read/write CRM records.");
export const socialListening = stub("social_listening", "Monitor social mentions.");
export const fileManagement = stub("file_management", "Store/list/fetch agent files.");
export const browserUse = stub("browser_use", "Drive a real browser.");
export const removeImageBg = stub("remove_image_bg", "Remove image background.");
export const imageToVideo = stub("image_to_video", "Animate an image into video.");
export const transcribeVoice = stub("transcribe_voice", "Speech-to-text transcription.");

const REGISTRY: Record<string, Capability> = {
  scrape_web: scrapeWeb,
  search_web: searchWeb,
  generate_image: generateImage,
  generate_video: generateVideo,
  crm,
  social_listening: socialListening,
  file_management: fileManagement,
  browser_use: browserUse,
  remove_image_bg: removeImageBg,
  image_to_video: imageToVideo,
  transcribe_voice: transcribeVoice,
};

export function getCapability(name: string): Capability | null {
  return REGISTRY[name] ?? null;
}

/** Run a capability if it is enabled for this agent, else throw. */
export async function runCapability(
  env: Env,
  enabled: string[],
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (!enabled.includes(name)) throw new Error(`capability '${name}' not enabled for this agent`);
  const cap = getCapability(name);
  if (!cap) throw new Error(`capability '${name}' has no implementation`);
  return cap.run(env, input);
}
