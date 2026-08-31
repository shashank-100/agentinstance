// A2A — one agent messaging another, unified per-agent history.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("A2A protocol", () => {
  it("agent A can message agent B and get a reply", async () => {
    const res = await SELF.fetch("https://x/agents/bob/a2a", {
      method: "POST",
      body: JSON.stringify({ from: "alice", text: "can you help with X?" }),
    });
    const data = (await res.json()) as { from: string; to: string; reply: string };
    expect(res.status).toBe(200);
    expect(data.from).toBe("alice");
    expect(data.to).toBe("bob");
    expect(data.reply.length).toBeGreaterThan(0);
  });

  it("the exchange lands in the target agent's history on the a2a channel", async () => {
    await SELF.fetch("https://x/agents/carol/a2a", {
      method: "POST",
      body: JSON.stringify({ from: "dave", text: "ping" }),
    });
    const hist = (await (await SELF.fetch("https://x/agents/carol/history")).json()) as {
      channel: string;
      content: string;
    }[];
    expect(hist[0].channel).toBe("a2a");
    expect(hist[0].content).toContain("from agent dave");
  });

});
