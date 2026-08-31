// A harness is the agent's loop: what it does between receiving a message and
// producing a reply. ChatHarness asks the model and runs any tools it calls;
// CliHarness gives the model a shell. The spec (harness + model + capabilities)
// is checked for coherence before an agent is created.
import type { Message } from "../types.js";
import type { Model, ToolDef } from "../models/index.js";
import type { Sandbox } from "../sandbox/index.js";
import { CAPABILITIES, HARNESSES, MACHINES, MODELS, DEFAULT_MACHINE } from "../catalog.js";

/** Optional execution context passed to harnesses that can run code. */
export interface HarnessContext {
  sandbox?: Sandbox | null;
  agentId?: string;
  /** Standing instructions for this agent, written into its VM as AGENTS.md. */
  agentsMd?: string;
  /** API key for the CLI this harness runs, read from the Worker's secrets. */
  cliKey?: string;
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

/**
 * Runs a real agent CLI inside the agent's VM — Claude Code, Pi — rather than
 * driving the model directly. The CLI owns its own loop, prompt and tools; this
 * class only starts it, gives it the task, and returns what it printed.
 *
 * Each CLI needs its own key in the VM's environment, which is why `envVar`
 * exists: without it the binary starts and immediately fails to authenticate.
 */
export class AgentCliHarness implements Harness {
  constructor(
    public name: string,
    /** How to invoke it. `{task}` is replaced with the shell-quoted prompt. */
    private template: string,
    /** Env var the CLI authenticates with, forwarded from the Worker's secrets. */
    private envVar: string,
  ) {}

  async run(
    model: Model,
    history: Message[],
    system: string,
    ctx?: HarnessContext,
  ): Promise<string> {
    const { sandbox, agentId } = ctx ?? {};
    if (!sandbox || !agentId) {
      throw new Error(`${this.name} needs a sandbox — no container is bound`);
    }
    const key = ctx?.cliKey;
    if (!key) {
      throw new Error(`${this.name} needs ${this.envVar} set as a Worker secret`);
    }

    // The VM's filesystem is discarded when it sleeps, so AGENTS.md is written
    // in at the start of every session rather than once.
    if (ctx.agentsMd) {
      await sandbox.writeFile(agentId, "/workspace/AGENTS.md", ctx.agentsMd).catch(() => {});
    }

    const task = lastUserText(history);
    if (!task) return "(nothing to do)";

    // The key goes in the command's environment, not the prompt: anything in the
    // prompt is echoed back in the CLI's own logs.
    const cmd =
      `cd /workspace && ${this.envVar}=${shellQuote(key)} ` +
      this.template.replace("{task}", shellQuote(task));

    const out = await sandbox.exec(agentId, cmd);
    if (out.exitCode !== 0) {
      return `${this.name} exited ${out.exitCode}:\n${out.stderr.slice(0, 2000) || out.stdout.slice(0, 2000)}`;
    }
    return out.stdout.trim() || "(no output)";
  }
}

function lastUserText(history: Message[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") return history[i].content;
  }
  return null;
}

/** Single-quote for POSIX sh, so a prompt cannot break out of the command. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Every harness is a real agent CLI running in the agent's own VM. */
const CLI_HARNESSES: Record<string, { template: string; envVar: string }> = {
  "claude-code": { template: 'claude -p {task}', envVar: "ANTHROPIC_API_KEY" },
  pi: { template: 'pi -p {task}', envVar: "PI_API_KEY" },
};

export function getHarness(name: string, offline = false): Harness {
  const cli = CLI_HARNESSES[name];
  if (!cli) throw new Error(`unknown harness '${name}'`);
  // Tests have no sandbox and no CLI key, so they answer from the model alone.
  // Gated on an explicit flag so this can never be reached in production.
  return offline ? new EchoHarness(name) : new AgentCliHarness(name, cli.template, cli.envVar);
}

/** Offline stand-in: replies from the model, skipping the CLI entirely. */
class EchoHarness implements Harness {
  constructor(public name: string) {}
  run(model: Model, history: Message[], system: string): Promise<string> {
    return model.complete(history, system);
  }
}

export function harnessEnvVar(name: string): string | null {
  return CLI_HARNESSES[name]?.envVar ?? null;
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
    harness: "claude-code",
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
