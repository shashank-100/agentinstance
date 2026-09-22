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
    // A launched neighbour sees none of it, and an unlaunched name is not an
    // agent at all — reading it is a 404, not an empty conversation.
    await launch("iso-b");
    expect(await history("iso-b")).toHaveLength(0);
    const ghost = await SELF.fetch("https://x/agents/iso-never/history");
    expect(ghost.status).toBe(404);
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

  it("restore re-arms the alarm, so a restored agent still acts on its own", async () => {
    // The schedule lives in kv, so its values cross a restore for free. The
    // alarm does not: it is DO state. An agent that knows its task and never
    // runs it is the one failure a backup of an always-on agent must not have.
    await launch("restore-sched-src");
    const atMs = Date.now() + 3_600_000;
    await SELF.fetch("https://x/agents/restore-sched-src/schedule", {
      method: "POST",
      body: JSON.stringify({ atMs, prompt: "tick", cadenceMs: 3_600_000 }),
    });
    const snap = await (await SELF.fetch("https://x/agents/restore-sched-src/snapshot")).json();

    await SELF.fetch("https://x/agents/restore-sched-dst/restore", {
      method: "POST",
      body: JSON.stringify(snap),
    });

    const sched = (await (
      await SELF.fetch("https://x/agents/restore-sched-dst/schedule")
    ).json()) as { prompt: string | null; cadenceMs: number | null; nextWake: number | null };
    expect(sched.prompt).toBe("tick");
    expect(sched.cadenceMs).toBe(3_600_000);
    // Still in the future, so it is carried across untouched.
    expect(sched.nextWake).toBe(atMs);
  });

  it("restore advances a lapsed recurring schedule instead of firing at once", async () => {
    // A snapshot's next_wake is usually already past by the time it is
    // restored, and a past-dated alarm fires immediately — which would run a
    // recurring agent off-cadence and keep it there.
    await launch("restore-lapsed");
    const past = Date.now() - 5_000;
    await SELF.fetch("https://x/agents/restore-lapsed/restore", {
      method: "POST",
      body: JSON.stringify({
        spec: {
          harness: "claude-code",
          model: "claude-opus-4.8",
          capabilities: [],
          machine: "half-cpu",
          system: "test",
        },
        kv: { wakeup_prompt: "tick", expected_cadence_ms: 60_000, next_wake: past },
      }),
    });

    const sched = (await (
      await SELF.fetch("https://x/agents/restore-lapsed/schedule")
    ).json()) as { nextWake: number | null };
    expect(sched.nextWake).toBeGreaterThan(Date.now());
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

describe("live output", () => {
  it("is bounded by bytes, so a verbose run cannot grow without limit", async () => {
    await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({ id: "noisy", harness: "claude-code", model: "claude-opus-4.8" }),
    });

    // A row count would not bound this: 40 writes of 32KB is 1.2MB, and the
    // limit is 256KB. What matters is the bytes retained, not the rows.
    const chunk = "x".repeat(32 * 1024);
    for (let i = 0; i < 40; i++) {
      await SELF.fetch("https://x/agents/noisy/tool/__record_output_test", {
        method: "POST",
        body: JSON.stringify({ text: chunk }),
      }).catch(() => {});
    }

    const out = (await (
      await SELF.fetch("https://x/agents/noisy/output")
    ).json()) as { text: string }[];
    const bytes = out.reduce((n, r) => n + r.text.length, 0);
    // Under the cap, with room for the chunk that crossed it.
    expect(bytes).toBeLessThanOrEqual(256 * 1024 + 32 * 1024);
  });

  it("returns only what is new, so a watcher does not re-read the run", async () => {
    await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({ id: "tailer", harness: "claude-code", model: "claude-opus-4.8" }),
    });
    const first = (await (
      await SELF.fetch("https://x/agents/tailer/output")
    ).json()) as { seq: number }[];
    const last = first.at(-1)?.seq ?? 0;
    const next = (await (
      await SELF.fetch(`https://x/agents/tailer/output?since=${last}`)
    ).json()) as unknown[];
    expect(next.length).toBe(0);
  });
});
