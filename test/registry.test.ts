// Agent registry + GET /agents dashboard list.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("agent registry", () => {
  it("launched agents appear in GET /agents with status", async () => {
    await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({ id: "reg-1", harness: "chat", model: "kimi-k3", machine: "2gb" }),
    });
    const list = (await (await SELF.fetch("https://x/api/agents")).json()) as {
      id: string;
      model: string;
      machine: string;
      parked: boolean;
    }[];
    const rec = list.find((a) => a.id === "reg-1");
    expect(rec).toBeTruthy();
    expect(rec!.model).toBe("kimi-k3");
    expect(rec!.machine).toBe("2gb");
    expect(rec!.parked).toBe(false);
  });

  it("reflects park state in the listing", async () => {
    await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({ id: "reg-2", harness: "chat", model: "kimi-k2.6" }),
    });
    await SELF.fetch("https://x/agents/reg-2/park", { method: "POST" });
    const list = (await (await SELF.fetch("https://x/api/agents")).json()) as {
      id: string;
      parked: boolean;
    }[];
    expect(list.find((a) => a.id === "reg-2")!.parked).toBe(true);
  });

  it("DELETE removes an agent from the listing and wipes state", async () => {
    await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({ id: "reg-del", harness: "chat", model: "kimi-k2.6" }),
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
});
