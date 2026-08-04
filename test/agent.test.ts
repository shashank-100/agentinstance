// Features #1, #2, #14, #5 — via the Worker HTTP surface (clean pool isolation).
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

async function send(id: string, text: string, channel?: string) {
  const res = await SELF.fetch(`https://x/agents/${id}/send`, {
    method: "POST",
    body: JSON.stringify({ text, channel }),
  });
  return res;
}
async function history(id: string) {
  return (await (await SELF.fetch(`https://x/agents/${id}/history`)).json()) as {
    role: string;
    content: string;
    channel: string;
  }[];
}

describe("AgentDO runtime + memory", () => {
  it("replies with the mock model by default (no key)", async () => {
    const res = await send("a1", "hello");
    const reply = ((await res.json()) as { reply: string }).reply;
    expect(reply.length).toBeGreaterThan(0);
    expect(reply).not.toBe("hello"); // it generated, not echoed verbatim
  });

  it("records both turns in history", async () => {
    await send("a2", "hi");
    expect((await history("a2")).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("persists across calls (same DO name)", async () => {
    await send("a3", "remember me");
    const hist = await history("a3");
    expect(hist).toHaveLength(2);
    expect(hist[0].content).toBe("remember me");
  });

  it("keeps agents isolated", async () => {
    await send("iso-a", "secret");
    expect(await history("iso-b")).toHaveLength(0);
  });

  it("shares one history across channels (unified per-agent)", async () => {
    await send("multi", "from slack", "slack");
    await send("multi", "from whatsapp", "whatsapp");
    const hist = await history("multi");
    expect(hist).toHaveLength(4);
    expect(hist[0].channel).toBe("slack");
    expect(hist[2].channel).toBe("whatsapp");
  });

  it("park blocks sends, unpark restores", async () => {
    await SELF.fetch("https://x/agents/park1/park", { method: "POST" });
    const blocked = await send("park1", "x");
    expect(blocked.status).toBe(409);
    await SELF.fetch("https://x/agents/park1/unpark", { method: "POST" });
    const reply = ((await (await send("park1", "x")).json()) as { reply: string }).reply;
    expect(reply.length).toBeGreaterThan(0); // sends work again after unpark
  });

  it("status reports last-progress and stall detection", async () => {
    await send("stat1", "work");
    const st = (await (await SELF.fetch("https://x/agents/stat1/status")).json()) as {
      parked: boolean;
      lastProgress: number;
      stalled: boolean;
    };
    expect(st.parked).toBe(false);
    expect(st.lastProgress).toBeTypeOf("number");
    expect(st.stalled).toBe(false);
  });

  it("scheduled wakeup fires and advances history", async () => {
    await SELF.fetch("https://x/agents/wake1/schedule", {
      method: "POST",
      body: JSON.stringify({ atMs: Date.now() + 1000, prompt: "tick", cadenceMs: 60000 }),
    });
    await SELF.fetch("https://x/agents/wake1/wake", { method: "POST" });
    const hist = await history("wake1");
    expect(hist.some((m) => m.content === "tick")).toBe(true);
  });
});
