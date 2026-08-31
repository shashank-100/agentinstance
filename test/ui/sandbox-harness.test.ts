// AgentCliHarness runs a real agent CLI inside the agent's VM.
import { describe, it, expect } from "vitest";
import { getHarness, harnessEnvVar } from "../../src/harnesses/index.js";
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
  it("each harness names the env var its CLI authenticates with", () => {
    expect(harnessEnvVar("claude-code")).toBe("ANTHROPIC_API_KEY");
    expect(harnessEnvVar("pi")).toBe("PI_API_KEY");
    expect(harnessEnvVar("nope")).toBeNull();
  });

  it("passes the task to the CLI and returns its output", async () => {
    const capture: { cmd?: string } = {};
    const out = await getHarness("claude-code").run(model, [msg("fix the bug")], "sys", {
      sandbox: fakeSandbox(capture),
      agentId: "a1",
      cliKey: "sk-test",
    });
    expect(out).toBe("done");
    expect(capture.cmd).toContain("claude -p");
    expect(capture.cmd).toContain("fix the bug");
    // The key rides the command's environment, never the prompt.
    expect(capture.cmd).toContain("ANTHROPIC_API_KEY=");
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
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
