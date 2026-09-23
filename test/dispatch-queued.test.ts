// Starting a task that was filed without `dispatch`.
//
// Nothing polls the board: the alarm only reclaims *abandoned* running tasks,
// and `claim` has to be called by an agent that is already inside a VM. So a
// task filed without `dispatch` had no route that could ever start it — it sat
// in `queued` forever while the board showed it as unclaimed.
//
// The failure list, written before the route:
//   1. a queued task cannot be started at all
//   2. dispatching twice creates a second agent for the same work
//   3. dispatching an id that is not on the board reports success
//   4. an already-running task can be hijacked out from under its agent
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index.js";

const post = async (path: string, body: unknown) => {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://example.com${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  // The dispatched agent runs in waitUntil; let it settle so a failure there
  // surfaces here rather than as a stray rejection in a later test.
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const file = async (goal: string) => {
  const out = await post("/api/fleet/tasks", { goal });
  return out.body as { id: string; state: string };
};

describe("dispatching a queued task", () => {
  it("files as queued with nobody on it", async () => {
    const task = await file("report the node version");
    // This is the state the board renders as "unclaimed". Filing is not
    // starting, and nothing in the system will pick this up on its own.
    expect(task.state).toBe("queued");
    expect(task.id).toBeTruthy();
  });

  it("starts a queued task and puts an agent on it", async () => {
    const task = await file("report the node version");
    const out = await post(`/api/fleet/tasks/${task.id}`, { dispatch: true });

    expect(out.status).toBe(200);
    expect(out.body.state).toBe("running");
    // The agent is named for the task, so the board can link the two.
    expect(out.body.assignedTo).toBe(`task-${task.id}`);
    expect(out.body.dispatched).toBe(true);
  });

  it("refuses to dispatch a task that is already running", async () => {
    const task = await file("report the node version");
    await post(`/api/fleet/tasks/${task.id}`, { dispatch: true });
    const second = await post(`/api/fleet/tasks/${task.id}`, { dispatch: true });

    // Two agents on one task would both clone, both commit, and both push to
    // the same branch. Refusing is the only safe answer.
    expect(second.status).toBe(409);
    expect(String(second.body.error)).toMatch(/already running/);
  });

  it("404s on a task that is not on the board", async () => {
    const out = await post("/api/fleet/tasks/nope-1234", { dispatch: true });
    expect(out.status).toBe(404);
    expect(String(out.body.error)).toMatch(/no task/);
  });
});
