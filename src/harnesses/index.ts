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
  /** Provider credentials for the CLI: taken from the agent's own model. */
  cliKey?: string;
  cliBaseUrl?: string;
  cliModel?: string;
  /** Subscription token for CLIs that accept one instead of a provider key. */
  oauthToken?: string;
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
    /** Env vars the CLI reads: its key, and the endpoint to talk to. */
    private env: { key: string; baseUrl: string; model: string },
    private oauthVar?: string,
    private configFile?: {
      path: string;
      build: (baseUrl: string, key: string, model: string) => string;
    },
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
    const { cliKey, cliBaseUrl, cliModel, oauthToken } = ctx ?? {};
    // An OAuth token authenticates against the CLI's own vendor, so it wins:
    // the agent's provider may not speak that CLI's API format at all.
    const useOauth = !!(this.oauthVar && oauthToken);
    if (!useOauth && !cliKey) {
      throw new Error(
        `${this.name} has no credentials — set its OAuth token, or a key for this agent's model`,
      );
    }

    // The VM's filesystem is discarded when it sleeps, so AGENTS.md is written
    // in at the start of every session rather than once.
    if (ctx?.agentsMd) {
      await sandbox.writeFile(agentId, "/workspace/AGENTS.md", ctx.agentsMd).catch(() => {});
    }

    const task = lastUserText(history);
    if (!task) return "(nothing to do)";

    // A CLI that reads its provider from disk needs that file written first —
    // and rewritten every session, since the VM's filesystem is not durable.
    //
    // Written through `exec` rather than `writeFile`: the file has to land in
    // the CLI user's home with that user owning it, and its parent directories
    // may not exist yet. A failure here is reported rather than swallowed —
    // silently skipping it leaves the CLI to fail later with a confusing
    // "unknown provider", pointing at the flag instead of the missing file.
    if (this.configFile && cliKey && cliBaseUrl && cliModel) {
      const dest = `/home/agent/${this.configFile.path}`;
      const body = this.configFile.build(cliBaseUrl, cliKey, cliModel);
      const write = await sandbox.exec(
        agentId,
        `(id -u agent >/dev/null 2>&1 || useradd -m agent) && ` +
          `mkdir -p ${shellQuote(dirname(dest))} && ` +
          `cat > ${shellQuote(dest)} <<'AGENTINSTANCE_EOF'\n${body}\nAGENTINSTANCE_EOF\n` +
          `chown -R agent /home/agent`,
      );
      if (write.exitCode !== 0) {
        return `${this.name} could not write its provider config:\n${write.stderr.slice(0, 1000)}`;
      }
    }

    // These CLIs default to their vendor's endpoint. Pointing them at the
    // agent's own provider is what lets Claude Code run on any OpenAI-compatible
    // model rather than requiring an Anthropic subscription.
    //
    // Keys go in the command's environment, never the prompt: a prompt is echoed
    // back in the CLI's own logs.
    const envs = (
      useOauth
        ? [`${this.oauthVar}=${shellQuote(oauthToken as string)}`]
        : [
            this.env.key ? `${this.env.key}=${shellQuote(cliKey as string)}` : "",
            this.env.baseUrl && cliBaseUrl
              ? `${this.env.baseUrl}=${shellQuote(cliBaseUrl)}`
              : "",
            this.env.model && cliModel ? `${this.env.model}=${shellQuote(cliModel)}` : "",
          ]
    )
      .filter(Boolean)
      .join(" ");
    // Claude Code refuses to skip permission prompts while running as root.
    // The VM is already an isolated sandbox, so drop to an unprivileged user
    // rather than leaving the CLI blocked on prompts it cannot answer.
    const inner =
      `${envs} ` +
      this.template.replace("{task}", shellQuote(task)).replace("{model}", shellQuote(cliModel ?? ""));
    const cmd =
      `cd /workspace && (id -u agent >/dev/null 2>&1 || useradd -m agent) && ` +
      `chown -R agent /workspace /home/agent && ` +
      `runuser -u agent -- sh -c ${shellQuote(inner)}`;

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

/** Parent directory of a POSIX path, so it can be created before writing. */
function dirname(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

/**
 * Every harness is a real agent CLI running in the agent's own VM.
 *
 * Each entry names the env vars that CLI reads for its key, its endpoint and
 * its model. Setting all three points the CLI at whatever provider the agent's
 * model belongs to, so `claude-code` runs on any OpenAI-compatible API.
 */
const CLI_HARNESSES: Record<
  string,
  {
    template: string;
    env: { key: string; baseUrl: string; model: string };
    /** Set when the CLI accepts a subscription token instead of a provider key. */
    oauthVar?: string;
    /** Set when the CLI reads its provider from a config file, not the env. */
    configFile?: {
      path: string;
      build: (baseUrl: string, key: string, model: string) => string;
    };
  }
> = {
  "claude-code": {
    template: "claude --dangerously-skip-permissions -p {task}",
    env: {
      key: "ANTHROPIC_AUTH_TOKEN",
      baseUrl: "ANTHROPIC_BASE_URL",
      model: "ANTHROPIC_MODEL",
    },
    // Claude Code speaks Anthropic's /v1/messages, which OpenAI-compatible
    // providers do not serve. A subscription OAuth token bypasses that: it
    // authenticates against Anthropic directly, so no base URL is passed.
    oauthVar: "CLAUDE_CODE_OAUTH_TOKEN",
  },
  pi: {
    // Pi resolves providers from ~/.pi/agent/models.json rather than env vars,
    // so the harness writes that file before invoking it.
    template: "pi --provider agentinstance --model {model} -p {task}",
    env: { key: "", baseUrl: "", model: "" },
    configFile: {
      path: ".pi/agent/models.json",
      build: (baseUrl, key, model) =>
        JSON.stringify({
          providers: {
            agentinstance: {
              baseUrl,
              api: "openai-completions",
              apiKey: key,
              models: [{ id: model, name: model }],
            },
          },
        }),
    },
  },
};

export function getHarness(name: string, offline = false): Harness {
  const cli = CLI_HARNESSES[name];
  if (!cli) throw new Error(`unknown harness '${name}'`);
  // Tests have no sandbox and no CLI key, so they answer from the model alone.
  // Gated on an explicit flag so this can never be reached in production.
  return offline
    ? new EchoHarness(name)
    : new AgentCliHarness(name, cli.template, cli.env, cli.oauthVar, cli.configFile);
}

/** Offline stand-in: replies from the model, skipping the CLI entirely. */
class EchoHarness implements Harness {
  constructor(public name: string) {}
  run(model: Model, history: Message[], system: string): Promise<string> {
    return model.complete(history, system);
  }
}

/** Is this a harness we know how to run? */
export function isHarness(name: string): boolean {
  return name in CLI_HARNESSES;
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
