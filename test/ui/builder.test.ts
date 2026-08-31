// Builder UI logic — section by section (pure functions, node env).
import { describe, it, expect } from "vitest";
import {
  createState,
  selectHarness,
  selectModel,
  modelsFor,
  supportsModel,
  selectMachine,
  estimateMonthly,
  compatibility,
  toSpec,
  summary,
} from "../../public/agents/builder.js";

// Two harnesses so the model-filtering logic stays covered. `other-cli` is a
// stand-in, not a shipped harness: the real catalog has only claude-code, and
// this file tests the mapping rather than the roster.
const catalog = {
  harnesses: [{ id: "claude-code", desc: "x" }, { id: "other-cli", desc: "y" }],
  models: [
    { id: "claude-opus-4.8", label: "Claude Opus 4.8", priceIn: 0, priceOut: 0, oauth: true },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", priceIn: 3, priceOut: 15 },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", priceIn: 3, priceOut: 15 },
  ],
  harnessModels: {
    "claude-code": ["claude-opus-4.8"],
    "other-cli": ["gpt-5.6-terra", "gpt-5.4-mini"],
  },
  capabilities: [
    { id: "scrape_web", desc: "" },
    { id: "run_shell", desc: "" },
  ],
  machines: [
    { id: "1gb", label: "1 GB", usdPerHour: 0.021 },
    { id: "2gb", label: "2 GB", usdPerHour: 0.038 },
    { id: "4gb", label: "4 GB", usdPerHour: 0.071 },
  ],
  defaultMachine: "4gb",
};
const fresh = () => createState(catalog, { preselect: false });
const oneClick = () => createState(catalog); // defaults pre-selected

describe("one-click", () => {
  it("is launch-ready immediately with defaults", () => {
    const s = oneClick();
    expect(s.harness).toBe("claude-code");
    expect(s.model).toBe("claude-opus-4.8");
    expect(s.machine).toBe("4gb");
    expect(compatibility(s)).toBeNull(); // ready with zero clicks
    expect(summary(s).ready).toBe(true);
  });
});

describe("section 1 — harness", () => {
  it("selects a harness", () => {
    const s = selectHarness(fresh(), "shell");
    expect(s.harness).toBe("shell");
  });
  it("blocks compatibility until chosen", () => {
    expect(compatibility(fresh())).toBe("Choose a harness");
  });
});

describe("section 2 — model", () => {
  it("selects a model and reflects it in summary", () => {
    const s = selectModel(selectHarness(fresh(), "chat"), "gpt-5.6-terra");
    expect(summary(s).model).toBe("GPT-5.6 Terra");
  });
  it("still blocks until a model is chosen", () => {
    const s = fresh();
    s.harness = "claude-code"; // set directly: selectHarness picks a model for you
    expect(compatibility(s)).toBe("Pick a model");
  });

  it("marks models the harness cannot drive as unsupported", () => {
    // They stay in the list — rendered disabled rather than hidden.
    expect(supportsModel(catalog, "other-cli", "claude-opus-4.8")).toBe(false);
    expect(supportsModel(catalog, "other-cli", "gpt-5.6-terra")).toBe(true);
    expect(supportsModel(catalog, "claude-code", "claude-opus-4.8")).toBe(true);
    expect(supportsModel(catalog, "claude-code", "gpt-5.6-terra")).toBe(false);
  });

  it("offers only the models a harness can actually drive", () => {
    const s = selectHarness(fresh(), "other-cli");
    expect(modelsFor(catalog, "other-cli").map((m: { id: string }) => m.id)).toEqual([
      "gpt-5.6-terra",
      "gpt-5.4-mini",
    ]);
    expect(s.model).toBe("gpt-5.6-terra");
  });

  it("moves off a model the new harness cannot run", () => {
    const s = oneClick();
    expect(s.model).toBe("claude-opus-4.8");
    selectHarness(s, "other-cli");
    // Claude Code speaks a different API, so its model cannot carry over.
    expect(s.model).toBe("gpt-5.6-terra");
  });
});

describe("section 3 — capabilities", () => {
  it("gives every agent every capability", () => {
    // Not a menu: a shell and the web are what make it an agent.
    expect([...oneClick().capabilities]).toEqual(["scrape_web", "run_shell"]);
    expect([...fresh().capabilities]).toEqual(["scrape_web", "run_shell"]);
  });
});

describe("section 4 — machine", () => {
  it("selects a machine and recomputes cost", () => {
    const s = selectMachine(fresh(), "2gb");
    expect(s.machine).toBe("2gb");
    expect(estimateMonthly(s)).toBe(Math.round(0.038 * 24 * 30 * 100) / 100);
  });
  it("defaults to 4gb", () => {
    expect(fresh().machine).toBe("4gb");
  });
});

describe("section 5 — summary + cost", () => {
  it("summarizes a complete build as ready", () => {
    const s = selectHarness(fresh(), "other-cli");
    selectModel(s, "gpt-5.4-mini");
    const sum = summary(s);
    expect(sum.ready).toBe(true);
    expect(sum.capabilities).toEqual(["scrape_web", "run_shell"]);
    expect(sum.estMonthly).toBeGreaterThan(0);
  });
});

describe("section 6 — launch/compat (mirrors server)", () => {
  it("toSpec produces the server payload shape", () => {
    const s = selectHarness(fresh(), "other-cli");
    selectModel(s, "gpt-5.6-terra");
    expect(toSpec(s)).toEqual({
      harness: "other-cli",
      model: "gpt-5.6-terra",
      capabilities: ["scrape_web", "run_shell"],
      machine: "4gb",
    });
  });
});
