// Features #1, #2, #14, #5 — via the Worker HTTP surface (clean pool isolation).
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

/** Agents must be launched before they answer: a DO exists for every name, so
 *  `send` refuses one that was never configured. Launching is idempotent, so
 *  doing it here keeps each test to the behaviour it is actually about. */
const launched = new Set<string>();
async function launch(id: string) {
  if (launched.has(id)) return;
  launched.add(id);
  await SELF.fetch("https://x/api/launch", {
    method: "POST",
    body: JSON.stringify({
      id,
      harness: "claude-code",
      model: "claude-opus-4.8",
      capabilities: ["remember", "recall"],
    }),
  });
}

async function send(id: string, text: string, channel?: string) {
  await launch(id);
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

describe("AgentInstance runtime + memory", () => {
  it("replies with a generated answer, not an echo of the input", async () => {
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


  it("status reports last-progress and stall detection", async () => {
    await send("stat1", "work");
    const st = (await (await SELF.fetch("https://x/agents/stat1/status")).json()) as {
      lastProgress: number;
      stalled: boolean;
    };
    expect(st.lastProgress).toBeTypeOf("number");
    expect(st.stalled).toBe(false);
  });

  it("scheduled wakeup fires and advances history", async () => {
    // A scheduled agent still has to exist: the alarm calls send(), which
    // refuses an agent that was never launched.
    await launch("wake1");
    await SELF.fetch("https://x/agents/wake1/schedule", {
      method: "POST",
      body: JSON.stringify({ atMs: Date.now() + 1000, prompt: "tick", cadenceMs: 60000 }),
    });
    await SELF.fetch("https://x/agents/wake1/wake", { method: "POST" });
    const hist = await history("wake1");
    expect(hist.some((m) => m.content === "tick")).toBe(true);
  });

  it("wipe clears notes, so a reused name cannot read the old agent's memory", async () => {
    // A DO is addressed by name: recreating a deleted agent lands on the same
    // object, so anything wipe() misses is readable by whoever takes that name.
    await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({
        id: "wipe-notes",
        harness: "claude-code",
        model: "claude-opus-4.8",
        capabilities: ["remember", "recall"],
      }),
    });
    await SELF.fetch("https://x/agents/wipe-notes/tool/remember", {
      method: "POST",
      body: JSON.stringify({ key: "secret", value: "private" }),
    });
    await SELF.fetch("https://x/agents/wipe-notes", { method: "DELETE" });

    await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({
        id: "wipe-notes",
        harness: "claude-code",
        model: "claude-opus-4.8",
        capabilities: ["remember", "recall"],
      }),
    });
    const res = await SELF.fetch("https://x/agents/wipe-notes/tool/recall", {
      method: "POST",
      body: JSON.stringify({}),
    });
    const out = (await res.json()) as { result: { notes: unknown[] } };
    expect(out.result.notes).toEqual([]);
  });
});
