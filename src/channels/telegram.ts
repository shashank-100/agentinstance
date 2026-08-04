// Feature #8 — Telegram. Webhook: setWebhook to /channels/telegram/:agentId.
import type { Env } from "../types.js";
import type { ChannelAdapter, Inbound } from "./index.js";

export class TelegramAdapter implements ChannelAdapter {
  name = "telegram";

  async parse(request: Request): Promise<Inbound | null> {
    const url = new URL(request.url);
    const agentId = url.pathname.split("/").filter(Boolean).pop() ?? "default";
    const update = (await request.json()) as {
      message?: { text?: string; chat?: { id: number }; message_id?: number };
    };
    const text = update.message?.text;
    const chatId = update.message?.chat?.id;
    if (!text || chatId == null) return null;
    return {
      agentId,
      text,
      channel: "telegram",
      replyTo: String(chatId),
      idempotencyKey: `tg:${chatId}:${update.message?.message_id}`,
    };
  }

  async send(env: Env, to: string, text: string, idempotencyKey: string): Promise<void> {
    if (!env.TELEGRAM_BOT_TOKEN) return;
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ chat_id: to, text }),
    });
  }
}
