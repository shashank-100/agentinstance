// Feature #13 — capabilities registry + enablement gating.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getCapability, runCapability } from "../src/capabilities/index.js";
import type { Env } from "../src/types.js";

const fakeEnv = {} as Env;

describe("capabilities", () => {
  it("registry resolves known capabilities", () => {
    expect(getCapability("scrape_web")?.name).toBe("scrape_web");
    expect(getCapability("search_web")?.name).toBe("search_web");
    expect(getCapability("nope")).toBeNull();
  });

  it("only implemented capabilities are registered", () => {
    // Removed stubs must not linger in the registry — the catalog claims
    // everything it lists actually works.
    for (const name of ["generate_video", "crm", "browser_use", "email", "generate_image"]) {
      expect(getCapability(name)).toBeNull();
    }
  });

  it("rejects a capability that is not enabled", async () => {
    await expect(runCapability(fakeEnv, [], "scrape_web", {})).rejects.toThrow(/not enabled/);
  });

  it("search_web degrades gracefully without a key", async () => {
    const out = (await runCapability(fakeEnv, ["search_web"], "search_web", {
      query: "cats",
    })) as { note?: string };
    expect(out.note).toMatch(/not set/);
  });

  it("tool route respects the agent's configured capabilities", async () => {
    // configure an agent WITH search_web enabled
    await SELF.fetch("https://x/agents/toolA/configure", {
      method: "POST",
      body: JSON.stringify({ capabilities: ["search_web"] }),
    });
    const ok = await SELF.fetch("https://x/agents/toolA/tool/search_web", {
      method: "POST",
      body: JSON.stringify({ query: "hi" }),
    });
    expect(ok.status).toBe(200);

    // a capability NOT enabled is rejected
    const denied = await SELF.fetch("https://x/agents/toolA/tool/crm", {
      method: "POST",
      body: JSON.stringify({ prompt: "x" }),
    });
    expect(denied.status).toBe(400);
  });

  it("every catalog capability has an implementation", async () => {
    const { CAPABILITIES } = await import("../src/catalog");
    const { getCapability } = await import("../src/capabilities/index");
    for (const name of Object.keys(CAPABILITIES)) {
      expect(getCapability(name), name).not.toBeNull();
    }
  });

  it("remember and recall persist notes across calls", async () => {
    await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({
        id: "memo",
        harness: "chat",
        model: "gpt-5.6-terra",
        capabilities: ["remember", "recall"],
      }),
    });

    await SELF.fetch("https://x/agents/memo/tool/remember", {
      method: "POST",
      body: JSON.stringify({ key: "last-story", value: "Alibaba Accio Work" }),
    });

    const one = (await (
      await SELF.fetch("https://x/agents/memo/tool/recall", {
        method: "POST",
        body: JSON.stringify({ key: "last-story" }),
      })
    ).json()) as { result: { notes: { key: string; value: string }[] } };
    expect(one.result.notes[0].value).toBe("Alibaba Accio Work");

    // Listing with no key returns recent notes.
    const all = (await (
      await SELF.fetch("https://x/agents/memo/tool/recall", {
        method: "POST",
        body: JSON.stringify({}),
      })
    ).json()) as { result: { notes: unknown[] } };
    expect(all.result.notes.length).toBeGreaterThan(0);
  });
});

