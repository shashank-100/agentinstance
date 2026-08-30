// Feature #4 — pluggable harnesses + 3-piece AgentSpec with compatibility check.
import type { Message } from "../types.js";
import type { Model, ToolDef } from "../models/index.js";
import type { Sandbox } from "../sandbox/index.js";
import { CAPABILITIES, HARNESSES, MACHINES, MODELS, DEFAULT_MACHINE } from "../catalog.js";

/** Optional execution context passed to harnesses that can run code. */
export interface HarnessContext {
  sandbox?: Sandbox | null;
  agentId?: string;
  /** Tools the model may call this turn, with a runner for each. */
  tools?: ToolDef[];
  runTool?: (name: string, input: Record<string, unknown>) => Promise<unknown>;
}

export interface Harness {
  name: string;
  run(model: Model, history: Message[], system: string, ctx?: HarnessContext): Promise<string>;
}

/** Cap on model<->tool round trips, so a looping model can't run forever. */
const MAX_TOOL_STEPS = 5;

// Default: one model completion per turn — unless capabilities are enabled and
// the model supports tool calls, in which case run a bounded tool loop.
export class ChatHarness implements Harness {
  name = "chat";

  async run(
    model: Model,
    history: Message[],
    system: string,
    ctx?: HarnessContext,
  ): Promise<string> {
    const tools = ctx?.tools ?? [];
    if (!tools.length || !model.turn || !ctx?.runTool) {
      return model.complete(history, system);
    }

    const priorTurns: unknown[] = [];
    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      const turn = await model.turn(history, system, tools, priorTurns);
      if (!turn.toolCalls.length) {
        return turn.text || "(no reply)";
      }
      priorTurns.push(turn.raw);
      for (const call of turn.toolCalls) {
        // A failing tool must come back as an observation, not blow up the
        // turn — the model can then apologise or try something else.
        let result: unknown;
        try {
          result = await ctx.runTool(call.name, call.input);
        } catch (e) {
          result = { error: String(e) };
        }
        priorTurns.push(toolResultMessage(model, call.id, call.name, result));
      }
    }
    // Out of steps: ask for a final answer with no tools offered.
    const final = await model.turn(history, system, [], priorTurns);
    return final.text || "(stopped after too many tool steps)";
  }
}

/** Tool results use different shapes on Claude vs OpenAI-compatible APIs. */
function toolResultMessage(
  model: Model,
  id: string,
  name: string,
  result: unknown,
): unknown {
  const content = JSON.stringify(result).slice(0, 8000);
  return { role: "tool", tool_call_id: id, name, content };
}

// CLI-wrapping harness. If a sandbox is available, the
// model can act: it may emit a fenced ```sh block, which the harness runs in the
// sandbox and feeds the output back for a final answer. Without a sandbox it
// falls back to a single model call — so it always works, just less capable.
export class CliHarness implements Harness {
  constructor(public name: string) {}

  async run(
    model: Model,
    history: Message[],
    system: string,
    ctx?: HarnessContext,
  ): Promise<string> {
    const sandbox = ctx?.sandbox;
    const agentId = ctx?.agentId;
    if (!sandbox || !agentId) return model.complete(history, system);

    const toolSystem =
      system +
      "\n\nYou can run shell commands. To run one, reply with a single fenced " +
      "```sh code block containing the command. I will run it and give you the output.";
    const first = await model.complete(history, toolSystem);

    const cmd = extractShell(first);
    if (!cmd) return first; // model chose to just answer

    const result = await sandbox.exec(agentId, cmd);
    const observation: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content:
        `Command output (exit ${result.exitCode}):\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}\n` +
        `Now give the user a final answer.`,
      channel: "sandbox",
      ts: Date.now(),
    };
    return model.complete([...history, { ...msgFrom("assistant", first) }, observation], system);
  }
}

function msgFrom(role: "assistant" | "user", content: string): Message {
  return { id: crypto.randomUUID(), role, content, channel: "core", ts: Date.now() };
}

/** Pull the command out of the first ```sh / ```bash / ```shell fenced block. */
export function extractShell(text: string): string | null {
  const m = text.match(/```(?:sh|bash|shell)\s*\n([\s\S]*?)```/);
  return m ? m[1].trim() : null;
}

export function getHarness(name: string): Harness {
  if (name === "chat") return new ChatHarness();
  if (name in HARNESSES) return new CliHarness(name);
  throw new Error(`unknown harness '${name}'`);
}

export interface AgentSpec {
  harness: string;
  model: string;
  capabilities: string[];
  machine: string;
  system: string;
}

export function defaultSpec(partial: Partial<AgentSpec> = {}): AgentSpec {
  // Drop undefined keys so they don't clobber defaults via spread.
  const clean = Object.fromEntries(
    Object.entries(partial).filter(([, v]) => v !== undefined),
  );
  return {
    harness: "chat",
    model: "gpt-5.6-terra",
    capabilities: [],
    machine: DEFAULT_MACHINE,
    system: "You are a helpful always-on agent.",
    ...clean,
  };
}

export class IncompatibleSpec extends Error {}

export function checkCompatible(spec: AgentSpec): void {
  if (!(spec.harness in HARNESSES)) throw new IncompatibleSpec(`unknown harness '${spec.harness}'`);
  if (!(spec.model in MODELS)) throw new IncompatibleSpec(`unknown model '${spec.model}'`);
  if (!(spec.machine in MACHINES)) throw new IncompatibleSpec(`unknown machine '${spec.machine}'`);
  for (const cap of spec.capabilities) {
    if (!(cap in CAPABILITIES)) throw new IncompatibleSpec(`unknown capability '${cap}'`);
  }
}
