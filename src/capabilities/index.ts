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


export const fetchJson: Capability = {
  name: "fetch_json",
  describe:
    "Call an HTTP API and return its parsed JSON response. Use this for any " +
    "public REST endpoint — weather, prices, GitHub, status pages — when you " +
    "need structured data rather than page text.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute https URL of the endpoint." },
      method: { type: "string", enum: ["GET", "POST"], description: "Defaults to GET." },
      body: { type: "object", description: "JSON body, for POST only." },
    },
    required: ["url"],
  },
  async run(_env, input) {
    const url = String(input.url ?? "");
    if (!url) throw new Error("fetch_json requires { url }");
    // Only http(s): a Worker can otherwise be pointed at internal addresses.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`fetch_json: '${url}' is not a valid URL`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("fetch_json only supports http(s) URLs");
    }

    const method = input.method === "POST" ? "POST" : "GET";
    const res = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        "user-agent": "AgentInstanceBot/0.1",
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" && input.body ? { body: JSON.stringify(input.body) } : {}),
    });

    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      // Not JSON — hand back a truncated body so the model can see what came out.
      return { url, status: res.status, json: null, body: text.slice(0, 2000) };
    }
    // Cap the payload: an unbounded API response can blow the context window.
    // Hand back the serialized prefix rather than a mangled object.
    const serialized = JSON.stringify(data);
    if (serialized.length > 8000) {
      return {
        url,
        status: res.status,
        json: null,
        body: serialized.slice(0, 8000),
        truncated: `response was ${serialized.length} chars, showing the first 8000`,
      };
    }
    return { url, status: res.status, json: data };
  },
};

/**
 * remember / recall are declared here so the model sees their schemas, but they
 * are executed by AgentInstance.runTool — they need that agent's own SQLite,
 * which the env-only Capability contract cannot reach.
 */
export const remember: Capability = {
  name: "remember",
  describe:
    "Save a durable note under a key, for yourself to read in a later session. " +
    "Use it for findings, decisions, and anything you should not have to " +
    "rediscover. Writing the same key again replaces it.",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "Short identifier, e.g. 'last-reported-story'." },
      value: { type: "string", description: "What to remember." },
    },
    required: ["key", "value"],
  },
  async run() {
    throw new Error("remember is handled by the agent runtime");
  },
};

export const recall: Capability = {
  name: "recall",
  describe:
    "Read notes you saved earlier. Pass a key for one note, or omit it to list " +
    "your most recent notes. Check this before repeating work.",
  parameters: {
    type: "object",
    properties: { key: { type: "string", description: "Omit to list recent notes." } },
  },
  async run() {
    throw new Error("recall is handled by the agent runtime");
  },
};

const REGISTRY: Record<string, Capability> = {
  scrape_web: scrapeWeb,
  search_web: searchWeb,
  fetch_json: fetchJson,
  remember,
  recall,
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
