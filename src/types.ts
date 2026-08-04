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
  DEFAULT_MODEL: string;
  DEFAULT_HARNESS: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
}
