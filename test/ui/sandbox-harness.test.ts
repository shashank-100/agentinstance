// AgentCliHarness runs a real agent CLI inside the agent's VM.
import { describe, it, expect } from "vitest";
import { getHarness, isHarness } from "../../src/harnesses/index.js";
import type { Message } from "../../src/types.js";
import type { Model } from "../../src/models/index.js";

const model = { name: "unused", async complete() { return ""; } } as unknown as Model;
const msg = (content: string): Message => ({
  id: "1", role: "user", content, channel: "core", ts: 0,
});

function fakeSandbox(capture: { cmd?: string }) {
  return {
    name: "fake",
    async exec(_id: string, command: string) {
      capture.cmd = command;
      return { stdout: "done", stderr: "", exitCode: 0, success: true };
    },
    async writeFile() {},
    async readFile() { return ""; },
  };
}

describe("agent CLI harnesses", () => {
  it("knows which harnesses it can run", () => {
    expect(isHarness("claude-code")).toBe(true);
    expect(isHarness("pi")).toBe(true);
    expect(isHarness("nope")).toBe(false);
  });

  it("passes the task to the CLI and returns its output", async () => {
    const capture: { cmd?: string } = {};
    const out = await getHarness("claude-code").run(model, [msg("fix the bug")], "sys", {
      sandbox: fakeSandbox(capture),
      agentId: "a1",
      cliKey: "sk-test",
      cliBaseUrl: "https://socheap.ai/v1",
      cliModel: "gpt-5.6-terra",
    });
    expect(out).toBe("done");
    expect(capture.cmd).toContain("claude");
    expect(capture.cmd).toContain("fix the bug");
    // Credentials ride the command's environment, never the prompt. Pointing
    // the CLI at the agent's own provider is what makes it model-agnostic.
    // Nested inside runuser's quoting, so match the names and values loosely.
    expect(capture.cmd).toContain("ANTHROPIC_AUTH_TOKEN=");
    expect(capture.cmd).toContain("ANTHROPIC_BASE_URL=");
    expect(capture.cmd).toContain("https://socheap.ai/v1");
    expect(capture.cmd).toContain("gpt-5.6-terra");
    // The CLI must not run as root — it refuses to skip permission prompts.
    expect(capture.cmd).toContain("runuser -u agent");
  });

  it("quotes the task so a prompt cannot break out of the command", async () => {
    const capture: { cmd?: string } = {};
    await getHarness("pi").run(model, [msg("rm -rf /; echo pwned")], "sys", {
      sandbox: fakeSandbox(capture),
      agentId: "a1",
      cliKey: "k",
    });
    expect(capture.cmd).toContain("'rm -rf /; echo pwned'");
  });

  it("fails loudly when the CLI has no key", async () => {
    await expect(
      getHarness("claude-code").run(model, [msg("hi")], "sys", {
        sandbox: fakeSandbox({}),
        agentId: "a1",
      }),
    ).rejects.toThrow(/no credentials/);
  });
});
