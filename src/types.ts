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
  /** Anthropic's own key. Lets pi run Claude without a subscription token. */
  ANTHROPIC_API_KEY?: string;
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
  /**
   * GitHub App credentials, preferred over GITHUB_TOKEN. The App declares its
   * own permissions and mints hour-long installation tokens, so nobody hand-
   * picks permission boxes and a leaked credential expires by itself.
   * The key must be PKCS#8 ("BEGIN PRIVATE KEY") — WebCrypto imports no other.
   */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** The app's URL name, e.g. `my-agents` in github.com/apps/my-agents.
   *  Only needed to offer /github/install; tokens do not depend on it. */
  GITHUB_APP_SLUG?: string;
  /**
   * The App's OAuth credentials, for signing people in. A GitHub App can do
   * this itself — no separate OAuth App — so the client id is the one on the
   * App's own settings page and the secret is generated there.
   */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /**
   * GitHub logins allowed to sign in, comma separated.
   *
   * Closed by default: every agent spends this deployment's subscription and
   * boots a container, so a deployment that has not said who may in has not
   * said "anyone".
   */
  ALLOWED_LOGINS?: string;
  /**
   * Where the board lives, for the redirect at `/`.
   *
   * The board is a separate Worker, so this Worker cannot know its address.
   * Unset, `/` reports what this service is instead of redirecting nowhere.
   */
  BOARD_URL?: string;
  /**
   * Origins allowed to call this API from a browser with a session cookie,
   * comma separated.
   *
   * Only needed when the board is served from a different host than the API.
   * Unset means same-origin only, which is how this deployment runs — and an
   * origin is never reflected unless it is on this list, because reflecting one
   * while allowing credentials is how a hostile page reads somebody's board
   * with their own cookie.
   */
  CORS_ORIGINS?: string;
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
