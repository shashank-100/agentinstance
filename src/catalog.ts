// Catalog of models, harnesses, machine tiers, capabilities.
// Prices are USD per 1M tokens (input / output).
import { hasGitHubCredentials } from "./github-app.js";

export interface ModelInfo {
  id: string;
  label: string;
  priceIn: number;
  priceOut: number;
  /** OpenAI-compatible host serving this model. */
  provider: Provider;
  /** Upstream's own name for the model, when it differs from our catalog id. */
  upstreamId?: string;
  /** Served by a subscription token rather than a provider key: no rate to show. */
  oauth?: boolean;
}

/** OpenAI-compatible providers, reached by swapping base_url (no lock-in).
 *  Add one here plus its key in Env to offer its models. */
export type Provider = "anthropic";
export const PROVIDERS: Record<Provider, { baseUrl: string; keyVar: string }> = {
  // Anthropic's own endpoint. Claude Code reaches it with a subscription token
  // and no base URL; pi reaches it with this key, which is why a Claude model
  // can be served either way depending on which harness is running.
  anthropic: { baseUrl: "https://api.anthropic.com/v1", keyVar: "ANTHROPIC_API_KEY" },
};

// Only models a configured provider can actually serve.
export const MODELS: Record<string, ModelInfo> = {
  // Claude Code authenticates with a subscription OAuth token, so the model
  // comes from whatever that token grants rather than from a provider key.
  // There is no base URL and no per-token rate to quote here.
  // Served two ways: claude-code authenticates with a subscription token and
  // never consults the provider, while pi calls Anthropic directly with a key.
  // `oauth` marks the first case — there is no per-token rate to quote for it.
  "claude-opus-4.8": {
    id: "claude-opus-4.8",
    label: "Claude Opus 4.8",
    priceIn: 0,
    priceOut: 0,
    provider: "anthropic",
    // Anthropic spells it with hyphens.
    upstreamId: "claude-opus-4-8",
    oauth: true,
  },
};

/**
 * Which models each harness can actually drive.
 *
 * Both harnesses speak to Anthropic, so both run Claude and nothing else.
 *
 * Kimi (and the moonshotai provider behind it) is gone: an agent launched on it
 * got `401 Incorrect API key` from Moonshot, and a model that cannot answer is
 * worse than a model that is not offered. Restoring it means restoring the
 * provider entry, the model entry, and a working MOONSHOT_API_KEY together —
 * the wiring alone was what made a dead option look selectable.
 */
export const HARNESS_MODELS: Record<string, string[]> = {
  "claude-code": ["claude-opus-4.8"],
  pi: ["claude-opus-4.8"],
};

/**
 * `ready` marks what a given deployment can actually run, so the builder can
 * say so rather than presenting stubs and real code as equal choices.
 *
 * It is computed per request from that deployment's secrets, never stored: a
 * hardcoded flag describes whoever wrote it, and every other deployer sees a
 * builder that is wrong about their own setup — offering what they cannot run
 * and greying out what they can.
 */
export interface CatalogEntry { desc: string; ready: boolean }

/** A catalog entry before readiness is known: the parts that never change. */
interface Described { desc: string; needs: (env: KeyEnv) => boolean }

/** The subset of Env this file reads. Keeps the catalog free of the Worker's
 *  binding types, which it has no other reason to know about. */
export type KeyEnv = Record<string, unknown>;

const has = (env: KeyEnv, key: string): boolean => {
  const v = env[key];
  return typeof v === "string" && v.trim() !== "";
};

/**
 * Either credential will do: the App is preferred, a PAT still works.
 *
 * Delegates to github-app.ts rather than repeating the rule. Both existed for
 * a while — this one gating the catalog, the other exported and tested — which
 * meant the tested copy was the one nothing ran.
 */
const gitHubReady = (env: KeyEnv): boolean => hasGitHubCredentials(env);

/**
 * Can this deployment serve any model this harness drives?
 *
 * Two credentials can do it. A provider key serves that provider's models, and
 * a Claude subscription token serves the `oauth` ones — which is not only
 * claude-code's business: pi reads the same token, so one subscription makes
 * both harnesses usable.
 */
const driveable = (env: KeyEnv, harness: string): boolean =>
  (HARNESS_MODELS[harness] ?? []).some((id) => {
    const info = MODELS[id];
    if (!info) return false;
    if (info.oauth && has(env, "CLAUDE_CODE_OAUTH_TOKEN")) return true;
    return has(env, PROVIDERS[info.provider].keyVar);
  });

// A harness is the agent program that runs in the agent's VM, and it can only
// run on a model whose provider this deployment holds a key for.
const HARNESS_DEFS: Record<string, Described> = {
  "claude-code": {
    desc: "Anthropic's Claude Code CLI.",
    // A subscription token, or a key for a provider serving a model it drives.
    needs: (env) => driveable(env, "claude-code"),
  },
  // codex is paused: it speaks OpenAI's wire format and so cannot use a Claude
  // subscription, which leaves it needing a provider key nothing else here
  // needs. The CLI_HARNESSES row and its Dockerfile package stay, so bringing
  // it back is re-adding this entry and its HARNESS_MODELS line.
  pi: {
    desc: "The pi coding agent — runs Claude and the OpenAI-compatible models.",
    // Ready when any provider serving a model pi drives has a key.
    needs: (env) => driveable(env, "pi"),
  },
};

/** Descriptions only — for code that needs the list without an env. */
export const HARNESSES: Record<string, { desc: string }> = Object.fromEntries(
  Object.entries(HARNESS_DEFS).map(([id, d]) => [id, { desc: d.desc }]),
);

/** What this deployment can actually run, given the secrets it has. */
export function harnessCatalog(env: KeyEnv): Record<string, CatalogEntry> {
  return Object.fromEntries(
    Object.entries(HARNESS_DEFS).map(([id, d]) => [id, { desc: d.desc, ready: d.needs(env) }]),
  );
}

/**
 * A machine tier maps to a Cloudflare container instance type, and each
 * instance type needs its own container class — `instance_type` is fixed per
 * class and cannot be picked per request. `binding` names the Worker binding
 * for that class; see the `containers` array in wrangler.jsonc.
 *
 * Tiers are named for vCPU because that is what limits an agent. The harness
 * itself is I/O-bound waiting on the model, but anything run_shell does —
 * installing packages, compiling, processing data — is CPU-bound and
 * single-core. Memory and disk come along with the instance type and are kept
 * here for the record, not as the thing being chosen.
 */
export interface MachineTier {
  label: string;
  vcpu: number;
  ramGb: number;
  diskGb: number;
  usdPerHour: number;
  binding: "SANDBOX_SMALL" | "SANDBOX_MEDIUM" | "SANDBOX_LARGE";
}

// Specs are Cloudflare's published instance types; the rates are their
// per-hour active figures for each.
export const MACHINES: Record<string, MachineTier> = {
  "half-cpu": {
    label: "½ vCPU", vcpu: 0.5, ramGb: 4, diskGb: 8,
    usdPerHour: 0.038, binding: "SANDBOX_SMALL",
  },
  "one-cpu": {
    label: "1 vCPU", vcpu: 1, ramGb: 6, diskGb: 12,
    usdPerHour: 0.071, binding: "SANDBOX_MEDIUM",
  },
  "two-cpu": {
    label: "2 vCPU", vcpu: 2, ramGb: 8, diskGb: 16,
    usdPerHour: 0.104, binding: "SANDBOX_LARGE",
  },
};
export const DEFAULT_MACHINE = "half-cpu";

// Every capability here is implemented; `ready` says whether this particular
// deployment holds the key or binding it needs.
const CAPABILITY_DEFS: Record<string, Described> = {
  scrape_web: { desc: "Fetch and extract page text.", needs: () => true },
  search_web: { desc: "Web search via Tavily.", needs: (env) => has(env, "TAVILY_API_KEY") },
  fetch_json: { desc: "Call any JSON HTTP API.", needs: () => true },
  run_shell: { desc: "Run shell commands in the agent's VM.", needs: () => true },
  // A binding rather than a secret, so presence is the test, not emptiness.
  browse_page: {
    desc: "Render a page in headless Chrome.",
    needs: (env) => env.BROWSER != null,
  },
  remember: { desc: "Save a durable note for later sessions.", needs: () => true },
  recall: { desc: "Read notes saved in earlier sessions.", needs: () => true },
  // Agent-to-agent. Needs nothing beyond the deployment itself: the message
  // goes to another agent in this same Worker, over its own front door.
  send_to_agent: { desc: "Message another agent and get its reply.", needs: () => true },
  list_agents: { desc: "List the other agents on this deployment.", needs: () => true },
  // The work queue, from inside the VM: claim a task, record a branch or a
  // pull request against it, and settle it.
  fleet_task: { desc: "Claim and complete tasks from the work queue.", needs: () => true },
  // Git against a real remote. Without a credential an agent can still clone a
  // public repo but cannot push, so these are offered only when one is set —
  // either a GitHub App (preferred) or a personal access token.
  git_repo: {
    desc: "Clone, branch, commit and push a repository.",
    needs: gitHubReady,
  },
  open_pr: {
    desc: "Open a pull request on GitHub.",
    needs: gitHubReady,
  },
};

/** Descriptions only — for code that needs the list without an env. */
export const CAPABILITIES: Record<string, { desc: string }> = Object.fromEntries(
  Object.entries(CAPABILITY_DEFS).map(([id, d]) => [id, { desc: d.desc }]),
);

/** What this deployment can actually run, given the secrets it has. */
export function capabilityCatalog(env: KeyEnv): Record<string, CatalogEntry> {
  return Object.fromEntries(
    Object.entries(CAPABILITY_DEFS).map(([id, d]) => [id, { desc: d.desc, ready: d.needs(env) }]),
  );
}

/**
 * What the machine costs per hour while it is running.
 *
 * Not a monthly figure: containers sleep when idle and bill per 10ms of active
 * time, so a 24×30 projection describes the one case that never happens and
 * overstates a typical agent by orders of magnitude.
 */
export function hourlyCost(machine = DEFAULT_MACHINE): number {
  return MACHINES[machine]?.usdPerHour ?? 0;
}
