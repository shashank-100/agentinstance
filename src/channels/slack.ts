// Slack, via the Events API.
import type { Env } from "../types.js";
import type { ChannelAdapter, Inbound } from "./index.js";

export class SlackAdapter implements ChannelAdapter {
  name = "slack";

  async parse(request: Request): Promise<Inbound | null> {
    const url = new URL(request.url);
    const agentId = url.pathname.split("/").filter(Boolean).pop() ?? "default";
    const body = (await request.json()) as {
      type?: string;
      challenge?: string;
      event?: { type?: string; text?: string; channel?: string; ts?: string; bot_id?: string };
    };
    // url_verification handshake is handled in the router (needs challenge echo).
    if (body.type === "url_verification") return null;
    const ev = body.event;
    if (!ev || ev.type !== "message" || ev.bot_id || !ev.text || !ev.channel) return null;
    return {
      agentId,
      text: ev.text,
      channel: "slack",
      replyTo: ev.channel,
      idempotencyKey: `sl:${ev.channel}:${ev.ts}`,
    };
  }

  async send(env: Env, to: string, text: string, idempotencyKey: string): Promise<void> {
    if (!env.SLACK_BOT_TOKEN) return;
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: to, text, client_msg_id: idempotencyKey }),
    });
  }
}
