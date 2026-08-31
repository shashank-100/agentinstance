// End-to-end: Worker gateway routes channel webhooks + REST + snapshot/restore.
import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";


/** Agents must be launched before they answer: a DO exists for every name, so
 *  `send` refuses one that was never configured. */
async function launch(id: string): Promise<void> {
  await SELF.fetch("https://x/api/launch", {
    method: "POST",
    body: JSON.stringify({ id, harness: "claude-code", model: "claude-opus-4.8" }),
  });
}

describe("worker gateway", () => {
  it("web channel round-trips through the agent", async () => {
    await launch("agentW");
    const res = await SELF.fetch("https://x/channels/web/agentW", {
      method: "POST",
      body: JSON.stringify({ text: "hello there" }),
    });
    const data = (await res.json()) as { reply: string };
    expect(data.reply.length).toBeGreaterThan(0);
  });

  it("send accepts AgentSky-style parts[] body", async () => {
    await launch("agentParts");
    const res = await SELF.fetch("https://x/agents/agentParts/send", {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", index: 0, text: "via parts" }] }),
    });
    const data = (await res.json()) as { reply: string };
    expect(data.reply.length).toBeGreaterThan(0);
  });

  it("telegram webhook drives the agent (unified history)", async () => {
    await launch("agentT");
    await SELF.fetch("https://x/channels/telegram/agentT", {
      method: "POST",
      body: JSON.stringify({ message: { text: "tg hi", chat: { id: 1 }, message_id: 1 } }),
    });
    const hist = (await (
      await SELF.fetch("https://x/agents/agentT/history")
    ).json()) as { channel: string }[];
    expect(hist[0].channel).toBe("telegram");
  });



  it("REST send + configure works", async () => {
    await SELF.fetch("https://x/agents/agentR/configure", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.6-terra" }),
    });
    const res = await SELF.fetch("https://x/agents/agentR/send", {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
    });
    expect(((await res.json()) as { reply: string }).reply.length).toBeGreaterThan(0); // mock fallback
  });

  it("snapshot then restore recovers history", async () => {
    await launch("snapA");
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
