// Agent registry + GET /agents dashboard list.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("agent registry", () => {
  it("launched agents appear in GET /agents with status", async () => {
    await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({ id: "reg-1", harness: "claude-code", model: "gpt-5.6-terra", machine: "one-cpu" }),
    });
    const list = (await (await SELF.fetch("https://x/api/agents")).json()) as {
      id: string;
      model: string;
      machine: string;
    }[];
    const rec = list.find((a) => a.id === "reg-1");
    expect(rec).toBeTruthy();
    expect(rec!.model).toBe("gpt-5.6-terra");
    expect(rec!.machine).toBe("one-cpu");
  });


  it("DELETE removes an agent from the listing and wipes state", async () => {
    await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({ id: "reg-del", harness: "claude-code", model: "gpt-5.4-mini" }),
    });
    await SELF.fetch("https://x/agents/reg-del/send", {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
    });
    const res = await SELF.fetch("https://x/agents/reg-del", { method: "DELETE" });
    expect(res.status).toBe(200);
    const list = (await (await SELF.fetch("https://x/api/agents")).json()) as { id: string }[];
    expect(list.find((a) => a.id === "reg-del")).toBeUndefined();
    // history wiped
    const hist = (await (await SELF.fetch("https://x/agents/reg-del/history")).json()) as unknown[];
    expect(hist).toHaveLength(0);
  });

  it("DELETE releases the agent's container before erasing its state", async () => {
    // The tier lives in the spec, and the tier is what says which container
    // class holds this agent — so the release has to happen while the spec is
    // still readable. Deleting an agent whose sandbox cannot be reached must
    // still succeed: an undeleteable agent is worse than an idle machine.
    await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({ id: "reg-vm", harness: "claude-code", model: "claude-opus-4.8" }),
    });
    const res = await SELF.fetch("https://x/agents/reg-vm", { method: "DELETE" });
    expect(res.status).toBe(200);
    const list = (await (await SELF.fetch("https://x/api/agents")).json()) as { id: string }[];
    expect(list.find((a) => a.id === "reg-vm")).toBeUndefined();
  });

  it("DELETE on a sub-path clears that resource, not the whole agent", async () => {
    await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({ id: "keep-me", harness: "claude-code", model: "gpt-5.6-terra" }),
    });
    await SELF.fetch("https://x/agents/keep-me/send", {
      method: "POST",
      body: JSON.stringify({ text: "remember this" }),
    });

    // Clearing the schedule must not wipe the agent's history or registry entry.
    await SELF.fetch("https://x/agents/keep-me/schedule", { method: "DELETE" });

    const hist = (await (await SELF.fetch("https://x/agents/keep-me/history")).json()) as unknown[];
    expect(hist.length).toBeGreaterThan(0);
    const list = (await (await SELF.fetch("https://x/api/agents")).json()) as { id: string }[];
    expect(list.some((a) => a.id === "keep-me")).toBe(true);
  });
});
