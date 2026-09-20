// A harness runs the agent: it takes a message and produces a reply. There is
// one, AgentCliHarness, which runs a real agent CLI inside the agent's VM.
//
// An earlier version also had a model-driven tool loop here, on the theory that
// agent styles differ in how they decide what to do next. Nothing ever selected
// it — the CLI brings its own loop — so it was two abstractions where one was
// used. The spec (harness + model + capabilities) is still checked for coherence
// before an agent is created.
import type { Message } from "../types.js";
import type { Model } from "../models/index.js";
import type { Sandbox } from "../sandbox/index.js";
import {
  CAPABILITIES,
  HARNESSES,
  HARNESS_MODELS,
  MACHINES,
  MODELS,
  DEFAULT_MACHINE,
} from "../catalog.js";
import { installVmTools, toolInstructions } from "./vm-tools.js";

/** Optional execution context passed to harnesses that can run code. */
export interface HarnessContext {
  sandbox?: Sandbox | null;
  agentId?: string;
  /** Standing instructions for this agent, written into its VM as AGENTS.md. */
  agentsMd?: string;
  /** Capabilities to install as commands in the VM. */
  capabilities?: string[];
  /** This agent's own REST base, so tools in the VM can call back to it. */
  agentUrl?: string;
  /** Provider credentials for the CLI: taken from the agent's own model. */
  cliKey?: string;
  cliBaseUrl?: string;
  cliModel?: string;
  /** Subscription token for CLIs that accept one instead of a provider key. */
  oauthToken?: string;
  /** The provider this agent's model belongs to, and the env var its key is
   *  conventionally read from. CLIs with their own model catalog (pi) want
   *  both by name rather than a base URL. */
  cliProvider?: string;
  cliKeyVar?: string;
  /** False when this agent's model is not served by the OAuth token's vendor. */
  cliOauthOk?: boolean;
}

export interface Harness {
  name: string;
  run(model: Model, history: Message[], system: string, ctx?: HarnessContext): Promise<string>;
}

/** How long a CLI harness may run before it is killed. Comfortably above a
 *  normal run (a few seconds) and safely inside the request's own lifetime. */
const CLI_TIMEOUT_SECONDS = 120;

/**
 * Runs a real agent CLI inside the agent's VM — Claude Code — rather than
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
    /** This CLI knows the provider already and reads its key from that
     *  provider's own env var, so pass the key under that name. */
    private providerKeyVar?: boolean,
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
    // The token authenticates against its own vendor, so it only applies to a
    // model that vendor serves. Handing an Anthropic subscription to a Moonshot
    // model would authenticate successfully against the wrong API.
    const useOauth = !!(this.oauthVar && oauthToken && ctx?.cliOauthOk !== false);
    if (!useOauth && !cliKey) {
      throw new Error(
        `${this.name} has no credentials — set its OAuth token, or a key for this agent's model`,
      );
    }

    // The CLI cannot see capabilities that live in the Worker, so install them
    // as commands it can run, and tell it in AGENTS.md when to reach for each.
    // Both are redone every session: a container's filesystem does not survive
    // sleeping, so nothing written here is still present next message.
    const capabilities = ctx?.capabilities ?? [];
    if (ctx?.agentUrl && capabilities.length) {
      await installVmTools(sandbox, agentId, ctx.agentUrl, capabilities);
    }
    const guidance = [ctx?.agentsMd, ctx?.agentUrl ? toolInstructions(capabilities) : ""]
      .filter(Boolean)
      .join("\n\n");
    if (guidance) {
      // Both names: AGENTS.md is the cross-vendor convention, but Claude Code
      // reads CLAUDE.md, and instructions it never loads are instructions that
      // do not exist — it looked for a memory directory rather than running
      // the recall command sitting on its PATH.
      await Promise.all([
        sandbox.writeFile(agentId, "/workspace/AGENTS.md", guidance).catch(() => {}),
        sandbox.writeFile(agentId, "/workspace/CLAUDE.md", guidance).catch(() => {}),
      ]);
    }

    const task = buildPrompt(history);
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
    const { cliKeyVar } = ctx ?? {};
    const envs = (
      useOauth
        ? // Only the credential changes on this path — a CLI that resolves its
          // endpoint from a provider name still needs that name passed to it.
          [`${this.oauthVar}=${shellQuote(oauthToken as string)}`]
        : this.providerKeyVar
          ? // The CLI resolves the endpoint itself from the provider name, so
            // the key is all it needs — under the name that provider uses.
            [cliKeyVar ? `${cliKeyVar}=${shellQuote(cliKey as string)}` : ""]
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
    // HOME must be set explicitly: runuser does not reliably carry it over, and
    // every one of these CLIs resolves its config relative to the home dir.
    // stdin is closed — a CLI that falls back to its interactive mode would
    // otherwise block forever on a terminal the container does not have.
    const inner =
      `HOME=/home/agent ${envs} ` +
      this.template
        .replace("{task}", shellQuote(task))
        .replace("{model}", shellQuote(cliModel ?? ""))
        .replace("{provider}", shellQuote(ctx?.cliProvider ?? ""))
        // A config *value* rather than an env var: codex takes the endpoint on
        // the command line, so the base URL is substituted into the template.
        .replace("{baseUrlValue}", shellQuote(cliBaseUrl ?? "")) +
      " </dev/null 2>&1";
    // Claude Code refuses to skip permission prompts while running as root.
    // The VM is already an isolated sandbox, so drop to an unprivileged user
    // rather than leaving the CLI blocked on prompts it cannot answer.
    //
    // The timeout is the backstop: without it a hung CLI holds the request
    // until the platform kills it, which surfaces as an empty reply with
    // nothing in the logs to explain it.
    const cmd =
      `cd /workspace && (id -u agent >/dev/null 2>&1 || useradd -m agent) && ` +
      `chown -R agent /workspace /home/agent && ` +
      `timeout ${CLI_TIMEOUT_SECONDS} runuser -u agent -- sh -c ${shellQuote(inner)}`;

    const out = await sandbox.exec(agentId, cmd);
    // 124 is what `timeout` returns when it kills the command.
    if (out.exitCode === 124) {
      return `${this.name} timed out after ${CLI_TIMEOUT_SECONDS}s.`;
    }
    if (out.exitCode !== 0) {
      return `${this.name} exited ${out.exitCode}:\n${out.stderr.slice(0, 2000) || out.stdout.slice(0, 2000)}`;
    }
    return out.stdout.trim() || "(no output)";
  }
}

/**
 * The prompt for this turn: the new message, preceded by the conversation so
 * far.
 *
 * Each CLI invocation is a fresh process with no knowledge of the last one, so
 * passing only the newest message made the agent amnesiac between turns — it
 * would answer "what colour did I just say?" with "you haven't mentioned a
 * colour". The history is already in SQLite and was already being loaded; it
 * simply never reached the CLI.
 *
 * Older turns are dropped once the transcript grows past `maxChars`, keeping
 * the most recent ones: a long-running agent would otherwise send an
 * ever-growing prompt and pay for it on every message.
 */
function buildPrompt(history: Message[], maxChars = 24_000): string | null {
  let latest: string | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") {
      latest = history[i].content;
      break;
    }
  }
  if (latest === null) return null;

  // Everything before the message being answered.
  //
  // System messages are included when they are handoff notes: the whole point
  // of a handoff is that the next model picks up where the last left off, and
  // it cannot do that if the one line explaining the switch is the one line
  // filtered out of its prompt.
  const prior = history.slice(0, history.length - 1).filter(
    (m) =>
      m.role === "user" || m.role === "assistant" || (m.role === "system" && m.channel === "handoff"),
  );
  if (!prior.length) return latest;

  const lines: string[] = [];
  let used = 0;
  for (let i = prior.length - 1; i >= 0; i--) {
    const m = prior[i];
    const line =
      m.role === "system"
        ? `[${m.content}]`
        : `${m.role === "user" ? "User" : "You"}: ${m.content}`;
    if (used + line.length > maxChars) break;
    lines.unshift(line);
    used += line.length;
  }
  if (!lines.length) return latest;

  return (
    `Here is the conversation so far, for context:\n\n${lines.join("\n\n")}\n\n` +
    `---\n\nThe user now says:\n\n${latest}`
  );
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
    /** Set when the CLI has its own model catalog and wants the provider key
     *  under that provider's conventional env var. */
    providerKeyVar?: boolean;
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

  // pi ships its own model catalog — `pi --list-models` already lists
  // `moonshot/kimi-k3` — and reads each provider's key straight from the
  // environment under that provider's own name. So it needs no base URL and no
  // config file: naming the provider and model is enough.
  //
  // An earlier version of this harness wrote ~/.pi/agent/models.json to define
  // a custom provider, which is why `configFile` exists on this type. That is
  // no longer necessary for a provider pi already knows.
  //
  // --no-session because the container's filesystem is discarded when it
  // sleeps, so a session written there is never read again; and PI_OFFLINE=1
  // to skip the startup catalog fetch, which has no route out of a sandbox
  // that blocks it and is the most likely cause of an earlier hang.
  pi: {
    template: "PI_OFFLINE=1 pi --provider {provider} --model {model} --no-session -p {task}",
    env: { key: "", baseUrl: "", model: "" },
    providerKeyVar: true,
    // pi reads ANTHROPIC_OAUTH_TOKEN as an alternative to an API key
    // (verified: a bad one comes back "OAuth access token is invalid"), so one
    // Claude subscription serves this harness as well as claude-code. Only
    // meaningful for a Claude model; for anything else the provider key path
    // applies, which is why oauthVar alone does not decide.
    oauthVar: "ANTHROPIC_OAUTH_TOKEN",
  },

  // `codex exec` is the non-interactive mode; bare `codex` opens a TUI that
  // would block forever on a terminal the container does not have.
  //
  // Provider config goes through repeated `--config key=value` rather than a
  // ~/.codex/config.toml, because `--config` sets any config key inline and a
  // file would have to be rewritten every session — the VM's filesystem does
  // not survive sleeping. The provider is defined and selected in one command.
  //
  // --skip-git-repo-check because /workspace is not a repository until an
  // agent clones one, and codex otherwise refuses to run outside a checkout.
  // --ephemeral keeps no session state, for the same reason pi gets
  // --no-session: a session written here is never read again.
  // -s danger-full-access because the container *is* the sandbox; codex's own
  // sandbox inside it would block the edits the agent was asked to make.
  codex: {
    template:
      "codex exec --ephemeral --skip-git-repo-check -s danger-full-access " +
      "--model {model} " +
      // Bare `key=value`. The double quotes t3code writes around its own
      // --config values are stripped by the shell before codex sees them, so
      // adding them here would only make this line inconsistent with itself.
      "--config model_provider=agentinstance " +
      "--config model_providers.agentinstance.name=agentinstance " +
      "--config model_providers.agentinstance.base_url={baseUrlValue} " +
      "--config model_providers.agentinstance.env_key=OPENAI_API_KEY " +
      "--config model_providers.agentinstance.wire_api=chat " +
      "-- {task}",
    // codex reads the key from whatever env_key names above.
    env: { key: "OPENAI_API_KEY", baseUrl: "", model: "" },
  },
};

export function getHarness(name: string, offline = false): Harness {
  const cli = CLI_HARNESSES[name];
  if (!cli) throw new Error(`unknown harness '${name}'`);
  // Tests have no sandbox and no CLI key, so they answer from the model alone.
  // Gated on an explicit flag so this can never be reached in production.
  return offline
    ? new EchoHarness(name)
    : new AgentCliHarness(
        name,
        cli.template,
        cli.env,
        cli.oauthVar,
        cli.configFile,
        cli.providerKeyVar,
      );
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
  /** The name this agent is addressed by — `/agents/<name>`. Recorded because
   *  a DO id is a one-way hash: the agent cannot derive its own URL without it. */
  name?: string;
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
    model: "claude-opus-4.8",
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
  // Each field existing is not enough: the harness has to be able to drive the
  // model. Claude Code speaks Anthropic's /v1/messages and pi speaks OpenAI's,
  // so a valid harness beside a valid model can still be a pairing that fails
  // at run time with an error pointing at neither.
  const drivable = HARNESS_MODELS[spec.harness];
  if (drivable && !drivable.includes(spec.model)) {
    throw new IncompatibleSpec(
      `${spec.harness} cannot run '${spec.model}' — it runs: ${drivable.join(", ")}`,
    );
  }
}
