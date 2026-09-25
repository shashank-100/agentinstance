import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { FleetDO } from "../src/fleet-do.js";

const fleet = (name: string) =>
  env.FLEET.get(env.FLEET.idFromName(name)) as unknown as DurableObjectStub<FleetDO>;

// Failure #1, #2, #3 and #6 from the list. The cap is only meaningful if the
// count it reads is the number of slots actually occupied on *this* board.
describe("how much of the pool one person holds", () => {
  it("counts only running tasks, not queued or settled ones", async () => {
    const id = env.FLEET.idFromName("limit-count");
    await runInDurableObject(env.FLEET.get(id), async (f: FleetDO) => {
      const a = await f.enqueue({ goal: "one" });
      const b = await f.enqueue({ goal: "two" });
      await f.enqueue({ goal: "three" });

      expect(await f.running()).toBe(0); // filed, nothing started

      await f.assign(a.id, "agent-a");
      await f.assign(b.id, "agent-b");
      expect(await f.running()).toBe(2);

      await f.settle(a.id, "done");
      expect(await f.running()).toBe(1); // a settled task frees its slot
    });
  });

  it("is counted per board, so one person's runs are not another's", async () => {
    const alice = fleet("fleet/alice");
    const bob = fleet("fleet/bob");
    const t = await alice.enqueue({ goal: "alice's work" });
    await alice.assign(t.id, "agent-alice");

    expect(await alice.running()).toBe(1);
    expect(await bob.running()).toBe(0);
  });
});
