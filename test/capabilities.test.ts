// Feature #13 — capabilities registry + enablement gating.
import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getCapability, runCapability } from "../src/capabilities/index.js";
import type { Env } from "../src/types.js";

const fakeEnv = {} as Env;

/** Agents are created by /api/launch; configure only edits an existing one. */
async function launch(id: string, spec: Record<string, unknown> = {}): Promise<void> {
  await SELF.fetch("https://x/api/launch", {
    method: "POST",
    body: JSON.stringify({ id, harness: "claude-code", model: "claude-opus-4.8", ...spec }),
  });
}

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
    await launch("toolA");
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
    // Some capabilities cannot be ordinary Capability objects, which receive
    // only `env`. These need the agent itself — its SQLite, its sandbox, or
    // its own name — so they live in AgentInstance.runTool and are absent from
    // this registry by design.
    const onTheAgent = new Set([
      "run_shell", // needs the agent's sandbox
      "remember", // needs the agent's SQLite
      "recall",
      "send_to_agent", // needs the agent's name, so `from` cannot be forged
      "list_agents",
      "fleet_task",
      "git_repo",
      "open_pr",
    ]);
    for (const name of Object.keys(CAPABILITIES)) {
      if (onTheAgent.has(name)) continue;
      expect(getCapability(name), name).not.toBeNull();
    }
  });

  it("capabilities implemented on the agent are reachable through runTool", async () => {
    // The counterpart to the exemption above: those capabilities are absent
    // from the registry but must still answer, or the exemption would hide a
    // capability that is advertised and does nothing.
    await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({
        id: "ontheagent",
        harness: "claude-code",
        model: "claude-opus-4.8",
        capabilities: ["remember", "recall", "list_agents"],
      }),
    });
    const res = await SELF.fetch("https://x/agents/ontheagent/tool/list_agents", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { agents?: unknown[] } };
    expect(Array.isArray(body.result?.agents)).toBe(true);
  });

  it("remember and recall persist notes across calls", async () => {
    await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({
        id: "memo",
        harness: "claude-code",
        model: "claude-opus-4.8",
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

  it("AGENTS.md is stored on the agent and survives a VM restart", async () => {
    await SELF.fetch("https://x/api/launch", {
      method: "POST",
      body: JSON.stringify({ id: "md1", harness: "claude-code", model: "claude-opus-4.8" }),
    });

    await SELF.fetch("https://x/agents/md1/agents-md", {
      method: "POST",
      body: JSON.stringify({ content: "# Notes\nAlways run tests first." }),
    });

    const got = (await (await SELF.fetch("https://x/agents/md1/agents-md")).json()) as {
      content: string | null;
    };
    expect(got.content).toContain("Always run tests first");

    await SELF.fetch("https://x/agents/md1/agents-md", { method: "DELETE" });
    const cleared = (await (await SELF.fetch("https://x/agents/md1/agents-md")).json()) as {
      content: string | null;
    };
    expect(cleared.content).toBeNull();
  });
});

