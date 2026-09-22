// Builder backend — /catalog and /api/launch.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("builder API", () => {
  it("catalog returns harnesses, models, capabilities, machines", async () => {
    const cat = (await (await SELF.fetch("https://x/catalog")).json()) as {
      harnesses: { id: string }[];
      models: { id: string; priceIn: number }[];
      capabilities: { id: string }[];
      machines: { id: string }[];
      defaultMachine: string;
    };
    expect(cat.harnesses.some((h) => h.id === "claude-code")).toBe(true);
    expect(cat.models.some((m) => m.id === "claude-opus-4.8")).toBe(true);
    expect(cat.capabilities.some((c) => c.id === "scrape_web")).toBe(true);
    expect(cat.machines.some((m) => m.id === "half-cpu")).toBe(true);
    expect(cat.defaultMachine).toBe("half-cpu");
  });

  it("launch configures an agent and returns spec + cost", async () => {
    const res = await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({
        id: "builtA",
        harness: "pi",
        model: "claude-opus-4.8",
        capabilities: ["scrape_web"],
        machine: "half-cpu",
      }),
    });
    const data = (await res.json()) as { id: string; usdPerHour: number; spec: { model: string } };
    expect(res.status).toBe(200);
    expect(data.id).toBe("builtA");
    expect(data.spec.model).toBe("claude-opus-4.8");
    expect(data.usdPerHour).toBeGreaterThan(0);
  });

  it("launch rejects an incompatible spec", async () => {
    const res = await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({
        harness: "pi",
        model: "claude-opus-4.8",
        capabilities: ["not_a_capability"],
        machine: "two-cpu",
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/unknown capability/);
  });

  it("launch auto-generates an id when omitted", async () => {
    const res = await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code", model: "claude-opus-4.8" }),
    });
    const data = (await res.json()) as { id: string };
    expect(data.id).toMatch(/^agent-/);
  });
});
