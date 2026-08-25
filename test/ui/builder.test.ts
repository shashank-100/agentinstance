// Builder UI logic — section by section (pure functions, node env).
import { describe, it, expect } from "vitest";
import {
  createState,
  selectHarness,
  selectModel,
  toggleCapability,
  selectMachine,
  estimateMonthly,
  compatibility,
  toSpec,
  summary,
} from "../../public/agents/builder.js";

const catalog = {
  harnesses: [{ id: "chat", desc: "x" }, { id: "shell", desc: "y" }],
  models: [
    { id: "kimi-k2.6", label: "Kimi K2.6", priceIn: 3, priceOut: 15 },
    { id: "kimi-k3", label: "Kimi K3", priceIn: 3, priceOut: 15 },
  ],
  capabilities: [
    { id: "scrape_web", desc: "" },
    { id: "generate_video", desc: "" },
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
  it("is launch-ready immediately with defaults (chat + sonnet + 4gb)", () => {
    const s = oneClick();
    expect(s.harness).toBe("chat");
    expect(s.model).toBe("kimi-k2.6");
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
    const s = selectModel(selectHarness(fresh(), "chat"), "kimi-k3");
    expect(summary(s).model).toBe("Kimi K3");
  });
  it("still blocks until a model is chosen", () => {
    expect(compatibility(selectHarness(fresh(), "chat"))).toBe("Pick a model");
  });
});

describe("section 3 — capabilities", () => {
  it("toggles on and off", () => {
    const s = fresh();
    toggleCapability(s, "scrape_web");
    expect([...s.capabilities]).toEqual(["scrape_web"]);
    toggleCapability(s, "scrape_web");
    expect([...s.capabilities]).toEqual([]);
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
    let s = fresh();
    selectHarness(s, "chat");
    selectModel(s, "kimi-k2.6");
    toggleCapability(s, "scrape_web");
    const sum = summary(s);
    expect(sum.ready).toBe(true);
    expect(sum.capabilities).toEqual(["scrape_web"]);
    expect(sum.estMonthly).toBeGreaterThan(0);
  });
});

describe("section 6 — launch/compat (mirrors server)", () => {
  it("flags heavy capability on 1gb", () => {
    let s = fresh();
    selectHarness(s, "chat");
    selectModel(s, "kimi-k2.6");
    selectMachine(s, "1gb");
    toggleCapability(s, "generate_video");
    expect(compatibility(s)).toMatch(/2gb/);
  });
  it("is compatible on 2gb", () => {
    let s = fresh();
    selectHarness(s, "chat");
    selectModel(s, "kimi-k2.6");
    selectMachine(s, "2gb");
    toggleCapability(s, "generate_video");
    expect(compatibility(s)).toBeNull();
  });
  it("toSpec produces the server payload shape", () => {
    let s = fresh();
    selectHarness(s, "shell");
    selectModel(s, "kimi-k3");
    expect(toSpec(s)).toEqual({
      harness: "shell",
      model: "kimi-k3",
      capabilities: [],
      machine: "4gb",
    });
  });
});
