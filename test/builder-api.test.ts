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
    expect(cat.models.some((m) => m.id === "gpt-5.6-terra")).toBe(true);
    expect(cat.capabilities.some((c) => c.id === "scrape_web")).toBe(true);
    expect(cat.machines.some((m) => m.id === "4gb")).toBe(true);
    expect(cat.defaultMachine).toBe("4gb");
  });

  it("launch configures an agent and returns spec + cost", async () => {
    const res = await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({
        id: "builtA",
        harness: "claude-code",
        model: "gpt-5.4-mini",
        capabilities: ["scrape_web"],
        machine: "4gb",
      }),
    });
    const data = (await res.json()) as { id: string; estMonthly: number; spec: { model: string } };
    expect(res.status).toBe(200);
    expect(data.id).toBe("builtA");
    expect(data.spec.model).toBe("gpt-5.4-mini");
    expect(data.estMonthly).toBeGreaterThan(0);
  });

  it("launch rejects an incompatible spec", async () => {
    const res = await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({
        harness: "claude-code",
        model: "gpt-5.4-mini",
        capabilities: ["not_a_capability"],
        machine: "1gb",
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/unknown capability/);
  });

  it("launch auto-generates an id when omitted", async () => {
    const res = await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({ harness: "claude-code", model: "gpt-5.6-terra" }),
    });
    const data = (await res.json()) as { id: string };
    expect(data.id).toMatch(/^agent-/);
  });
});
