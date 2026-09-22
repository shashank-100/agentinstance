// The work queue's failure handling: what happens to a task whose agent dies.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

type Task = {
  id: string;
  state: string;
  assignedTo: string | null;
  attempts?: number;
  result: string | null;
};

const file = async (goal: string): Promise<Task> =>
  (await (
    await SELF.fetch("https://x/api/fleet/tasks", {
      method: "POST",
      body: JSON.stringify({ goal }),
    })
  ).json()) as Task;

const claim = async (agentId: string): Promise<Task | null> =>
  (await (
    await SELF.fetch("https://x/api/fleet/tasks", {
      method: "POST",
      body: JSON.stringify({ claim: agentId }),
    })
  ).json()) as Task | null;

const get = async (id: string): Promise<Task> =>
  (await (await SELF.fetch(`https://x/api/fleet/tasks/${id}`)).json()) as Task;

/** Push a running task past the 15-minute lease, so it reads as abandoned
 *  without the test waiting fifteen real minutes for it. */
const age = (id: string, minutes: number) =>
  SELF.fetch(`https://x/api/fleet/tasks/${id}`, {
    method: "POST",
    body: JSON.stringify({ backdateMs: minutes * 60 * 1000 }),
  });

describe("a claim whose agent dies", () => {
  it("comes back to the queue instead of being lost", async () => {
    const task = await file("work that outlives its first agent");

    const first = await claim("agent-that-dies");
    expect(first?.id).toBe(task.id);
    expect((await get(task.id)).state).toBe("running");

    // The agent dies here: no settle, no progress, nothing.
    await age(task.id, 20);

    const second = await claim("agent-that-lives");
    expect(second?.id).toBe(task.id);
    expect(second?.assignedTo).toBe("agent-that-lives");
    expect((await get(task.id)).attempts).toBe(1);
  });

  it("is failed rather than retried forever", async () => {
    const task = await file("work that can never finish");

    // A task that is always requeued occupies a worker on every pass and never
    // completes, so the queue degrades while looking busy. The limit is what
    // stops one poisonous task doing that.
    for (let i = 0; i < 3; i++) {
      await claim(`agent-${i}`);
      await age(task.id, 20);
    }
    await claim("agent-final");

    const final = await get(task.id);
    expect(final.state).toBe("failed");
    expect(final.result).toMatch(/abandoned/i);
  });
});

describe("a claim whose agent is alive", () => {
  it("is not handed to a second agent", async () => {
    const task = await file("slow but healthy work");

    const mine = await claim("busy-agent");
    expect(mine?.id).toBe(task.id);

    // Fresh claim, no ageing: another agent asking for work must not get this.
    const other = await claim("other-agent");
    expect(other?.id).not.toBe(task.id);

    const still = await get(task.id);
    expect(still.assignedTo).toBe("busy-agent");
    expect(still.state).toBe("running");
  });
});
