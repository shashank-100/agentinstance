// A2A — one agent messaging another, unified per-agent history.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";


/** Agents must be launched before they answer: a DO exists for every name, so
 *  `send` refuses one that was never configured. */
async function launch(id: string): Promise<void> {
  await SELF.fetch("https://x/api/launch", {
    method: "POST",
    body: JSON.stringify({ id, harness: "claude-code", model: "claude-opus-4.8" }),
  });
}

describe("A2A protocol", () => {
  it("agent A can message agent B and get a reply", async () => {
    await launch("bob");
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
    await launch("carol");
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
