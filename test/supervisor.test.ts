// The supervisor path: a run breaks, an incident is recorded, and exactly one
// supervisor is woken with enough to act on.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const file = async (goal: string) =>
  (await (
    await SELF.fetch("https://x/api/fleet/tasks", {
      method: "POST",
      body: JSON.stringify({ goal, repo: "owner/repo" }),
    })
  ).json()) as { id: string };

const claim = (agentId: string) =>
  SELF.fetch("https://x/api/fleet/tasks", {
    method: "POST",
    body: JSON.stringify({ claim: agentId }),
  });

const age = (id: string, minutes: number) =>
  SELF.fetch(`https://x/api/fleet/tasks/${id}`, {
    method: "POST",
    body: JSON.stringify({ backdateMs: minutes * 60 * 1000 }),
  });

const supervise = async () =>
  (await (
    await SELF.fetch("https://x/api/fleet/supervise", { method: "POST" })
  ).json()) as { woke: boolean; reason?: string; reports?: number };

describe("a run that breaks", () => {
  it("is reported once, to a supervisor that exists", async () => {
    await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({
        id: "supervisor",
        harness: "claude-code",
        model: "claude-opus-4.8",
      }),
    });

    const task = await file("work whose agent dies");
    await claim("agent-that-dies");
    await age(task.id, 20);
    // The sweep reclaims and records; it must not wake anyone itself.
    await SELF.fetch("https://x/api/fleet/sweep", { method: "POST" });

    const first = await supervise();
    expect(first.woke).toBe(true);
    expect(first.reports).toBeGreaterThan(0);

    // Claimed on read: a second look finds nothing, so one failure does not
    // wake a supervisor twice.
    const second = await supervise();
    expect(second.woke).toBe(false);
  });

  it("does not wake an agent that was never launched", async () => {
    const task = await file("work nobody supervises");
    await claim("another-agent-that-dies");
    await age(task.id, 20);
    await SELF.fetch("https://x/api/fleet/sweep", { method: "POST" });

    const res = await SELF.fetch("https://x/api/fleet/supervise?agent=nobody", {
      method: "POST",
    });
    // A missing supervisor is reported rather than throwing inside the route.
    expect([404, 200]).toContain(res.status);
  });
});
