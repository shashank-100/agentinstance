// Feature #13 — capabilities registry + enablement gating.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getCapability, runCapability } from "../src/capabilities/index.js";
import type { Env } from "../src/types.js";

const fakeEnv = {} as Env;

describe("capabilities", () => {
  it("registry resolves known capabilities", () => {
    expect(getCapability("scrape_web")?.name).toBe("scrape_web");
    expect(getCapability("email")?.name).toBe("email");
    expect(getCapability("nope")).toBeNull();
  });

  it("rejects a capability that is not enabled", async () => {
    await expect(runCapability(fakeEnv, [], "scrape_web", {})).rejects.toThrow(/not enabled/);
  });

  it("search_serp degrades gracefully without a key", async () => {
    const out = (await runCapability(fakeEnv, ["search_serp"], "search_serp", {
      query: "cats",
    })) as { note?: string };
    expect(out.note).toMatch(/not set/);
  });

  it("tool route respects the agent's configured capabilities", async () => {
    // configure an agent WITH search_serp enabled
    await SELF.fetch("https://x/agents/toolA/configure", {
      method: "POST",
      body: JSON.stringify({ capabilities: ["search_serp"] }),
    });
    const ok = await SELF.fetch("https://x/agents/toolA/tool/search_serp", {
      method: "POST",
      body: JSON.stringify({ query: "hi" }),
    });
    expect(ok.status).toBe(200);

    // a capability NOT enabled is rejected
    const denied = await SELF.fetch("https://x/agents/toolA/tool/generate_image", {
      method: "POST",
      body: JSON.stringify({ prompt: "x" }),
    });
    expect(denied.status).toBe(400);
  });
});
