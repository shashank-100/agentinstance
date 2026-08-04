// Features #7-#11 — channel adapters parse their webhook shapes correctly.
import { describe, it, expect } from "vitest";
import { TelegramAdapter } from "../src/channels/telegram.js";
import { DiscordAdapter } from "../src/channels/discord.js";
import { SlackAdapter } from "../src/channels/slack.js";
import { WhatsAppAdapter } from "../src/channels/whatsapp.js";
import { WebAdapter } from "../src/channels/web.js";

function req(url: string, body: unknown): Request {
  return new Request(url, { method: "POST", body: JSON.stringify(body) });
}

describe("channel adapters", () => {
  it("telegram parses a message", async () => {
    const inbound = await new TelegramAdapter().parse(
      req("https://x/channels/telegram/bot9", {
        message: { text: "hi", chat: { id: 42 }, message_id: 7 },
      }),
    );
    expect(inbound).toMatchObject({ agentId: "bot9", text: "hi", channel: "telegram", replyTo: "42" });
    expect(inbound?.idempotencyKey).toBe("tg:42:7");
  });

  it("telegram ignores non-text updates", async () => {
    expect(await new TelegramAdapter().parse(req("https://x/channels/telegram/b", {}))).toBeNull();
  });

  it("discord ignores PING (type 1)", async () => {
    expect(
      await new DiscordAdapter().parse(req("https://x/channels/discord/b", { type: 1 })),
    ).toBeNull();
  });

  it("discord parses a slash command option", async () => {
    const inbound = await new DiscordAdapter().parse(
      req("https://x/channels/discord/b", {
        id: "m1",
        channel_id: "c1",
        data: { options: [{ value: "ping" }] },
      }),
    );
    expect(inbound).toMatchObject({ text: "ping", channel: "discord", replyTo: "c1" });
  });

  it("slack skips bot messages and parses user messages", async () => {
    const bot = await new SlackAdapter().parse(
      req("https://x/channels/slack/b", { event: { type: "message", text: "x", channel: "C", bot_id: "B" } }),
    );
    expect(bot).toBeNull();
    const user = await new SlackAdapter().parse(
      req("https://x/channels/slack/b", { event: { type: "message", text: "yo", channel: "C", ts: "1.2" } }),
    );
    expect(user).toMatchObject({ text: "yo", replyTo: "C" });
  });

  it("whatsapp parses a nested cloud-api message", async () => {
    const inbound = await new WhatsAppAdapter().parse(
      req("https://x/channels/whatsapp/b", {
        entry: [{ changes: [{ value: { messages: [{ from: "1555", id: "wamid", text: { body: "hey" } }] } }] }],
      }),
    );
    expect(inbound).toMatchObject({ text: "hey", replyTo: "1555", channel: "whatsapp" });
  });

  it("web parses a plain text post", async () => {
    const inbound = await new WebAdapter().parse(
      req("https://x/channels/web/b", { text: "hello" }),
    );
    expect(inbound).toMatchObject({ text: "hello", channel: "web", agentId: "b" });
  });
});
