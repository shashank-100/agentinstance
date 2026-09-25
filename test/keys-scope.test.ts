import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { storedKeys, setStoredKey, withStoredKeys } from "../src/keys.js";
import type { Env } from "../src/types.js";
import { DEPLOYMENT } from "../src/scope.js";

// Failure #3 and #6 from the list: keys used to live at idFromName("global"),
// shared by construction. These assert the separation directly rather than
// through a route, because the separation *is* the feature.
describe("a key belongs to one person", () => {
  it("is not visible to another person", async () => {
    await setStoredKey(env as never, "ANTHROPIC_API_KEY", "sk-ant-alice", "alice");
    const bob = await storedKeys(env as never, "bob");
    expect(bob["ANTHROPIC_API_KEY"]).toBeUndefined();
    const alice = await storedKeys(env as never, "alice");
    expect(alice["ANTHROPIC_API_KEY"]).toBe("sk-ant-alice");
  });

  it("does not leak into the deployment's own namespace", async () => {
    await setStoredKey(env as never, "ANTHROPIC_API_KEY", "sk-ant-carol", "carol");
    const deployment = await storedKeys(env as never, DEPLOYMENT);
    expect(deployment["ANTHROPIC_API_KEY"]).not.toBe("sk-ant-carol");
  });

  it("does not fall back to the deployment's credential under BYOK", async () => {
    // The whole point of BYOK: a stranger who has saved nothing must not end up
    // running on whoever deployed this.
    const byok = { ...env, BYOK: "1", ANTHROPIC_API_KEY: "sk-ant-deployer" } as unknown as Env;
    const seen = await withStoredKeys(byok, "dave");
    expect(seen.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("still gives the deployment its own credential", async () => {
    // Failure #2: the deployer already works and must keep working.
    const byok = { ...env, BYOK: "1", ANTHROPIC_API_KEY: "sk-ant-deployer" } as unknown as Env;
    const seen = await withStoredKeys(byok, DEPLOYMENT);
    expect(seen.ANTHROPIC_API_KEY).toBe("sk-ant-deployer");
  });
});
