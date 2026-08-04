// Feature #13 — built-in capabilities ("the hands that reach").
// Each capability is a callable tool. Only capabilities enabled in the agent's
// spec are exposed. Implementations use plain fetch so they run on Workers.
import type { Env } from "../types.js";

export interface Capability {
  name: string;
  describe: string;
  run(env: Env, input: Record<string, unknown>): Promise<unknown>;
}

export const scrapeWeb: Capability = {
  name: "scrape_web",
  describe: "Fetch a URL and return its text content.",
  async run(_env, input) {
    const url = String(input.url ?? "");
    if (!url) throw new Error("scrape_web requires { url }");
    const res = await fetch(url, { headers: { "user-agent": "NimbusBot/0.1" } });
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

export const searchSerp: Capability = {
  name: "search_serp",
  describe: "Search the web (requires SERP_API_KEY).",
  async run(env, input) {
    const q = String(input.query ?? "");
    if (!env.SERP_API_KEY) return { query: q, results: [], note: "SERP_API_KEY not set" };
    const res = await fetch(
      `https://serpapi.com/search.json?q=${encodeURIComponent(q)}&api_key=${env.SERP_API_KEY}`,
    );
    const data = (await res.json()) as { organic_results?: unknown[] };
    return { query: q, results: (data.organic_results ?? []).slice(0, 5) };
  },
};

export const generateImage: Capability = {
  name: "generate_image",
  describe: "Generate an image from a prompt (requires OPENAI_API_KEY).",
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

export const sendEmail: Capability = {
  name: "email",
  describe: "Send an email (requires RESEND_API_KEY).",
  async run(env, input) {
    const { to, subject, body } = input as { to?: string; subject?: string; body?: string };
    if (!env.RESEND_API_KEY) return { sent: false, note: "RESEND_API_KEY not set" };
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: env.EMAIL_FROM ?? "nimbus@example.com", to, subject, text: body }),
    });
    return { sent: res.ok, status: res.status };
  },
};

const REGISTRY: Record<string, Capability> = {
  scrape_web: scrapeWeb,
  search_serp: searchSerp,
  generate_image: generateImage,
  email: sendEmail,
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
