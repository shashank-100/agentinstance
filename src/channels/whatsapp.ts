// WhatsApp, via the Meta Cloud API.
import type { Env } from "../types.js";
import type { ChannelAdapter, Inbound } from "./index.js";

export class WhatsAppAdapter implements ChannelAdapter {
  name = "whatsapp";

  async parse(request: Request): Promise<Inbound | null> {
    const url = new URL(request.url);
    const agentId = url.pathname.split("/").filter(Boolean).pop() ?? "default";
    const body = (await request.json()) as {
      entry?: {
        changes?: { value?: { messages?: { from?: string; id?: string; text?: { body?: string } }[] } }[];
      }[];
    };
    const msg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const text = msg?.text?.body;
    if (!text || !msg?.from) return null;
    return {
      agentId,
      text,
      channel: "whatsapp",
      replyTo: msg.from,
      idempotencyKey: `wa:${msg.id}`,
    };
  }

  async send(env: Env, to: string, text: string, idempotencyKey: string): Promise<void> {
    if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_ID) return;
    await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        "content-type": "application/json",
        "x-idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    });
  }
}
