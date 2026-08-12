// The chat harness tool loop: a model that asks for a tool should get the
// result fed back and produce a final answer.
import { describe, it, expect } from "vitest";
import { ChatHarness } from "../src/harnesses/index.js";
import type { Model, Turn, ToolDef } from "../src/models/index.js";
import type { Message } from "../src/types.js";

const history: Message[] = [
  { id: "1", role: "user", content: "what is result.dev?", channel: "web", ts: 1 },
];

const searchTool: ToolDef = {
  name: "search_serp",
  description: "Search the web.",
  parameters: { type: "object", properties: { query: { type: "string" } } },
};

/** Model that requests a tool on the first turn, then answers. */
function scriptedModel(turns: Turn[]): Model & { calls: number } {
  return {
    name: "openai",
    calls: 0,
    async complete() {
      return "complete() was used";
    },
    async turn(): Promise<Turn> {
      return turns[Math.min(this.calls++, turns.length - 1)];
    },
  } as Model & { calls: number };
}

describe("ChatHarness tool loop", () => {
  it("runs a requested tool and feeds the result back", async () => {
    const model = scriptedModel([
      { text: "", toolCalls: [{ id: "c1", name: "search_serp", input: { query: "result.dev" } }] },
      { text: "result.dev is a YC company.", toolCalls: [] },
    ]);
    const ran: { name: string; input: Record<string, unknown> }[] = [];

    const reply = await new ChatHarness().run(model, history, "sys", {
      tools: [searchTool],
      runTool: async (name, input) => {
        ran.push({ name, input });
        return { results: [{ title: "result.dev" }] };
      },
    });

    expect(ran).toEqual([{ name: "search_serp", input: { query: "result.dev" } }]);
    expect(reply).toBe("result.dev is a YC company.");
  });

  it("falls back to complete() when no tools are enabled", async () => {
    const model = scriptedModel([{ text: "unused", toolCalls: [] }]);
    const reply = await new ChatHarness().run(model, history, "sys", {
      tools: [],
      runTool: async () => ({}),
    });
    expect(reply).toBe("complete() was used");
  });

  it("surfaces a failing tool as an observation instead of throwing", async () => {
    const model = scriptedModel([
      { text: "", toolCalls: [{ id: "c1", name: "search_serp", input: {} }] },
      { text: "Search failed, sorry.", toolCalls: [] },
    ]);
    const reply = await new ChatHarness().run(model, history, "sys", {
      tools: [searchTool],
      runTool: async () => {
        throw new Error("serpapi 429");
      },
    });
    expect(reply).toBe("Search failed, sorry.");
  });

  it("stops after the step cap instead of looping forever", async () => {
    // Always asks for a tool — the loop must bail out and still answer.
    const model = scriptedModel([
      { text: "", toolCalls: [{ id: "c", name: "search_serp", input: {} }] },
    ]);
    const reply = await new ChatHarness().run(model, history, "sys", {
      tools: [searchTool],
      runTool: async () => ({ ok: true }),
    });
    expect(reply).toBe("(stopped after too many tool steps)");
    expect(model.calls).toBeLessThanOrEqual(7);
  });
});
