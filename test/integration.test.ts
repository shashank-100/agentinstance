// End-to-end: Worker gateway routes channel webhooks + REST + snapshot/restore.
import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("worker gateway", () => {
  it("web channel round-trips through the agent", async () => {
    const res = await SELF.fetch("https://x/channels/web/agentW", {
      method: "POST",
      body: JSON.stringify({ text: "hello there" }),
    });
    const data = (await res.json()) as { reply: string };
    expect(data.reply.length).toBeGreaterThan(0);
  });

  it("send accepts AgentSky-style parts[] body", async () => {
    const res = await SELF.fetch("https://x/agents/agentParts/send", {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", index: 0, text: "via parts" }] }),
    });
    const data = (await res.json()) as { reply: string };
    expect(data.reply.length).toBeGreaterThan(0);
  });

  it("telegram webhook drives the agent (unified history)", async () => {
    await SELF.fetch("https://x/channels/telegram/agentT", {
      method: "POST",
      body: JSON.stringify({ message: { text: "tg hi", chat: { id: 1 }, message_id: 1 } }),
    });
    const hist = (await (
      await SELF.fetch("https://x/agents/agentT/history")
    ).json()) as { channel: string }[];
    expect(hist[0].channel).toBe("telegram");
  });

  it("slack url_verification echoes the challenge", async () => {
    const res = await SELF.fetch("https://x/channels/slack/a", {
      method: "POST",
      body: JSON.stringify({ type: "url_verification", challenge: "abc123" }),
    });
    expect(await res.json()).toEqual({ challenge: "abc123" });
  });

  it("discord PING returns PONG", async () => {
    const res = await SELF.fetch("https://x/channels/discord/a", {
      method: "POST",
      body: JSON.stringify({ type: 1 }),
    });
    expect(await res.json()).toEqual({ type: 1 });
  });

  it("REST send + configure works", async () => {
    await SELF.fetch("https://x/agents/agentR/configure", {
      method: "POST",
      body: JSON.stringify({ model: "kimi-k3" }),
    });
    const res = await SELF.fetch("https://x/agents/agentR/send", {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
    });
    expect(((await res.json()) as { reply: string }).reply.length).toBeGreaterThan(0); // mock fallback
  });

  it("snapshot then restore recovers history", async () => {
    await SELF.fetch("https://x/agents/snapA/send", {
      method: "POST",
      body: JSON.stringify({ text: "keep me" }),
    });
    const snap = await (await SELF.fetch("https://x/agents/snapA/snapshot")).json();

    // restore that snapshot into a fresh agent
    await SELF.fetch("https://x/agents/snapB/restore", {
      method: "POST",
      body: JSON.stringify(snap),
    });
    const hist = (await (
      await SELF.fetch("https://x/agents/snapB/history")
    ).json()) as { content: string }[];
    expect(hist.some((m) => m.content === "keep me")).toBe(true);
  });
});
