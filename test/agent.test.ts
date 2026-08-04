// Features #1, #2, #14 — agent DO runtime, persistent memory, scheduling.
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

function stub(id: string) {
  return env.AGENT.get(env.AGENT.idFromName(id));
}

describe("AgentDO runtime + memory", () => {
  it("echoes with the offline model by default", async () => {
    const reply = await stub("a1").send("hello");
    expect(reply).toBe("echo: hello");
  });

  it("records both turns in history", async () => {
    const s = stub("a2");
    await s.send("hi");
    const hist = await s.getHistory();
    expect(hist.map((m: any) => m.role)).toEqual(["user", "assistant"]);
  });

  it("persists across a simulated eviction (same DO name)", async () => {
    await stub("a3").send("remember me");
    // fresh stub for the same name = same durable storage
    const hist = await stub("a3").getHistory();
    expect(hist).toHaveLength(2);
    expect(hist[0].content).toBe("remember me");
  });

  it("keeps agents isolated", async () => {
    await stub("iso-a").send("secret");
    const other = await stub("iso-b").getHistory();
    expect(other).toHaveLength(0);
  });

  it("shares one history across channels (unified per-agent)", async () => {
    const s = stub("multi");
    await s.send("from slack", "slack");
    await s.send("from whatsapp", "whatsapp");
    const hist = await s.getHistory();
    expect(hist).toHaveLength(4);
    expect(hist[0].channel).toBe("slack");
    expect(hist[2].channel).toBe("whatsapp");
  });

  it("park blocks sends, unpark restores", async () => {
    const s = stub("park1");
    await s.park();
    await expect(s.send("x")).rejects.toThrow(/parked/);
    await s.unpark();
    expect(await s.send("x")).toBe("echo: x");
  });

  it("status reports last-progress and stall detection", async () => {
    const s = stub("stat1");
    await s.send("work");
    const st = await s.status();
    expect(st.parked).toBe(false);
    expect(st.lastProgress).toBeTypeOf("number");
    expect(st.stalled).toBe(false);
  });

  it("scheduled alarm wakes the agent and advances history", async () => {
    const s = stub("wake1");
    await s.scheduleWakeup(Date.now() + 1000, "tick", 60_000);
    // Invoke the alarm handler via its public RPC method (deterministic).
    await s.fireWakeup();
    const hist = await s.getHistory();
    expect(hist.some((m: any) => m.content === "tick")).toBe(true);
    // cadence was recorded for the health!=progress signal
    const st = await s.status();
    expect(st.expectedCadenceMs).toBe(60_000);
  });
});
