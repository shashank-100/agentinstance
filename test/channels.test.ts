// Channel adapters parse their webhook shapes correctly.
import { describe, it, expect } from "vitest";
import { TelegramAdapter } from "../src/channels/telegram.js";
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

  it("web parses a message and needs no outbound send", async () => {
    const adapter = new WebAdapter();
    const inbound = await adapter.parse(req("https://x/channels/web/a1", { text: "hello" }));
    expect(inbound).toMatchObject({ agentId: "a1", text: "hello", channel: "web" });
    // The reply rides the HTTP response, so send is a no-op.
    await expect(adapter.send({} as never, "", "", "")).resolves.toBeUndefined();
  });
});
