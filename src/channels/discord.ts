// Discord, via the interaction webhook.
import type { Env } from "../types.js";
import type { ChannelAdapter, Inbound } from "./index.js";

export class DiscordAdapter implements ChannelAdapter {
  name = "discord";

  async parse(request: Request): Promise<Inbound | null> {
    const url = new URL(request.url);
    const agentId = url.pathname.split("/").filter(Boolean).pop() ?? "default";
    const body = (await request.json()) as {
      type?: number;
      id?: string;
      channel_id?: string;
      data?: { options?: { value?: string }[] };
      content?: string;
    };
    // type 1 = PING (Discord verification)
    if (body.type === 1) return null;
    const text = body.data?.options?.[0]?.value ?? body.content;
    if (!text || !body.channel_id) return null;
    return {
      agentId,
      text,
      channel: "discord",
      replyTo: body.channel_id,
      idempotencyKey: `dc:${body.id}`,
    };
  }

  async send(env: Env, to: string, text: string, idempotencyKey: string): Promise<void> {
    if (!env.DISCORD_BOT_TOKEN) return;
    await fetch(`https://discord.com/api/v10/channels/${to}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "content-type": "application/json",
        "x-idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ content: text }),
    });
  }
}
