// Sandbox-wired CLI harness (pure logic, node env).
import { describe, it, expect } from "vitest";
import { CliHarness, extractShell } from "../../src/harnesses/index.js";
import type { Message } from "../../src/types.js";
import type { Sandbox, ExecResult } from "../../src/sandbox/index.js";

const hist = (content: string): Message[] => [
  { id: "1", role: "user", content, channel: "core", ts: 1 },
];

describe("extractShell", () => {
  it("pulls a command from a ```sh block", () => {
    expect(extractShell("sure:\n```sh\nls -la\n```")).toBe("ls -la");
  });
  it("returns null when there is no block", () => {
    expect(extractShell("just an answer")).toBeNull();
  });
});

describe("CliHarness with sandbox", () => {
  it("falls back to a plain model call when no sandbox", async () => {
    const model = { name: "m", complete: async () => "plain answer" };
    const h = new CliHarness("claude-code");
    expect(await h.run(model, hist("hi"), "sys")).toBe("plain answer");
  });

  it("runs the emitted command in the sandbox and answers from output", async () => {
    const calls: string[] = [];
    const model = {
      name: "m",
      complete: async (_msgs: Message[]) => {
        calls.push("call");
        // first call: emit a command; second call: final answer using output
        return calls.length === 1 ? "```sh\necho hi\n```" : "the command printed hi";
      },
    };
    const ran: string[] = [];
    const sandbox: Sandbox = {
      name: "fake",
      async exec(_id, cmd): Promise<ExecResult> {
        ran.push(cmd);
        return { stdout: "hi\n", stderr: "", exitCode: 0, success: true };
      },
      async writeFile() {},
      async readFile() {
        return "";
      },
    };
    const h = new CliHarness("claude-code");
    const out = await h.run(model, hist("say hi via shell"), "sys", { sandbox, agentId: "a1" });
    expect(ran).toEqual(["echo hi"]);
    expect(out).toBe("the command printed hi");
    expect(calls).toHaveLength(2); // emit + finalize
  });
});
