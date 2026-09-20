export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  id: string;
  role: Role;
  content: string;
  channel: string; // web, telegram, discord, core, ...
  ts: number;
}

export function makeMessage(
  role: Role,
  content: string,
  channel = "core",
): Message {
  return { id: crypto.randomUUID(), role, content, channel, ts: Date.now() };
}

export interface Env {
  AGENT: DurableObjectNamespace;
  REGISTRY: DurableObjectNamespace;
  /** The work queue. One singleton, addressed by a fixed name. */
  FLEET: DurableObjectNamespace;
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Public base URL of this Worker, so tools inside a VM can call back in. */
  WORKER_URL?: string;
  /** Claude subscription token — lets claude-code skip a provider key. */
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  /** Provider key, forwarded into the VM for models served over HTTP. */
  MOONSHOT_API_KEY?: string;
  /**
   * Shared secret guarding the management API. Optional so local dev needs no
   * setup; required in practice for any deployment reachable from the
   * internet, where its absence lets anyone spend the model keys above.
   */
  FLEET_TOKEN?: string;
  /**
   * GitHub token, forwarded into an agent's VM so it can clone, push and open
   * pull requests. Never baked into the image — it reaches the container in
   * the command's environment, for the life of that command only.
   */
  GITHUB_TOKEN?: string;
  /** Test-only: serve replies from the offline EchoModel. */
  USE_ECHO_MODEL?: string;
  // Capability keys.
  TELEGRAM_BOT_TOKEN?: string;
  TAVILY_API_KEY?: string;
  /** Headless Chrome via Browser Rendering Quick Actions. */
  BROWSER?: { quickAction(action: string, opts: Record<string, unknown>): Promise<Response> };
  /** Container-backed sandbox (Cloudflare Containers). */
  // One binding per machine tier: a container class carries a fixed
  // instance_type, so different hardware means a different class.
  SANDBOX_SMALL?: DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>;
  SANDBOX_MEDIUM?: DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>;
  SANDBOX_LARGE?: DurableObjectNamespace<import("@cloudflare/sandbox").Sandbox>;
}
