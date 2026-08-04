// Features #7-#11 — channel adapters. Every channel normalizes an inbound
// webhook into { agentId, text, channel } and sends the reply back out. History
// is unified at the agent level; a channel only replies where the request came.
//
// Idempotency: outbound sends carry a stable key generated before the attempt,
// so a resumed/retried agent never double-sends (see design insights).
import type { Env } from "../types.js";

export interface Inbound {
  agentId: string;
  text: string;
  channel: string;
  replyTo?: string; // channel-specific address (chat id, channel id, phone, ...)
  idempotencyKey?: string;
}

export interface ChannelAdapter {
  name: string;
  /** Parse a raw webhook Request into a normalized Inbound (or null to ignore). */
  parse(request: Request): Promise<Inbound | null>;
  /** Deliver the agent's reply back to the origin channel. */
  send(env: Env, to: string, text: string, idempotencyKey: string): Promise<void>;
}

async function agentReply(env: Env, msg: Inbound): Promise<string> {
  const stub = env.AGENT.get(env.AGENT.idFromName(msg.agentId)) as unknown as {
    send(t: string, c?: string): Promise<{ reply?: string; parked?: boolean }>;
  };
  const res = await stub.send(msg.text, msg.channel);
  return res.parked ? "(agent is parked)" : (res.reply ?? "");
}

/** Shared pipeline: parse -> run agent -> reply back. Used by every channel. */
export async function handleChannel(
  adapter: ChannelAdapter,
  request: Request,
  env: Env,
): Promise<Response> {
  const inbound = await adapter.parse(request);
  if (!inbound) return new Response("ignored", { status: 200 });
  const reply = await agentReply(env, inbound);
  if (inbound.replyTo) {
    const key = inbound.idempotencyKey ?? crypto.randomUUID();
    await adapter.send(env, inbound.replyTo, reply, key);
  }
  return Response.json({ ok: true, reply });
}

export { TelegramAdapter } from "./telegram.js";
export { DiscordAdapter } from "./discord.js";
export { SlackAdapter } from "./slack.js";
export { WhatsAppAdapter } from "./whatsapp.js";
export { WebAdapter } from "./web.js";
