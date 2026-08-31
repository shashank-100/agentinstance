export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  id: string;
  role: Role;
  content: string;
  channel: string; // web, telegram, discord, core, ...
  ts: number;
}

export function makeMessage(
  role: Role,
  content: string,
  channel = "core",
): Message {
  return { id: crypto.randomUUID(), role, content, channel, ts: Date.now() };
}

export interface Env {
  AGENT: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
  ASSETS: { fetch(request: Request): Promise<Response> };
  DEFAULT_MODEL: string;
  DEFAULT_HARNESS: string;
  /** Keys the agent CLIs authenticate with, forwarded into the VM. */
  ANTHROPIC_API_KEY?: string;
  PI_API_KEY?: string;
  SOCHEAP_API_KEY?: string;
  MOONSHOT_API_KEY?: string;
  /** Test-only: serve replies from the offline EchoModel. */
  USE_ECHO_MODEL?: string;
  // Capability keys.
  TELEGRAM_BOT_TOKEN?: string;
  TAVILY_API_KEY?: string;
  /** Headless Chrome via Browser Rendering Quick Actions. */
  BROWSER?: { quickAction(action: string, opts: Record<string, unknown>): Promise<Response> };
  /** Container-backed sandbox (Cloudflare Containers). */
  SANDBOX?: DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>;
}
