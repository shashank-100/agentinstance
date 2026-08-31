// One agent = one Durable Object. It owns that agent's conversation, its
// notes, its configuration and its alarm, all in the DO's own SQLite.
//
// A DO is single-threaded and addressed by name, so two requests to the same
// agent queue automatically — there are no locks or transactions here, and
// none are needed.
import { DurableObject } from "cloudflare:workers";
import type { Env, Message, Role } from "./types.js";
import { makeMessage } from "./types.js";
import { getHarness, type AgentSpec, defaultSpec } from "./harnesses/index.js";
import { MODELS, PROVIDERS } from "./catalog.js";
import { EchoModel, OpenAICompatModel, UnusedModel, type Model } from "./models/index.js";

export class AgentInstance extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
          channel TEXT NOT NULL, ts INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        -- Durable notes the agent writes for itself, separate from the
        -- transcript: a scheduled agent needs to recall what it already did
        -- without re-reading (and re-paying for) its whole history.
        CREATE TABLE IF NOT EXISTS notes (
          key TEXT PRIMARY KEY, value TEXT NOT NULL, ts INTEGER NOT NULL
        );
      `);
    });
  }

  // --- state helpers -------------------------------------------------------
  private getKV<T>(key: string, def: T): T {
    const row = this.sql.exec("SELECT value FROM kv WHERE key = ?", key).toArray()[0] as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : def;
  }
  private setKV(key: string, value: unknown): void {
    this.sql.exec(
      "INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  }

  private get spec(): AgentSpec {
    return this.getKV<AgentSpec>("spec", defaultSpec());
  }

  private buildModel(): Model {
    // Tests run offline; USE_ECHO_MODEL must be set explicitly so a real
    // deployment can never silently fall back to a canned responder.
    if (this.env.USE_ECHO_MODEL === "1") return new EchoModel();
    // Otherwise fail loudly on a missing model or key rather than inventing a
    // reply: a silent stand-in makes a broken deployment look like a working one.
    const info = MODELS[this.spec.model];
    if (!info) throw new Error(`unknown model '${this.spec.model}'`);
    // An OAuth model has no provider key by design — the CLI authenticates
    // itself with a subscription token and never consults this object. Return a
    // model that throws only if something actually tries to call it.
    if (info.oauth) return new UnusedModel(info.id);
    const { baseUrl, keyVar } = PROVIDERS[info.provider];
    const key = (this.env as unknown as Record<string, string | undefined>)[keyVar];
    if (!key) throw new Error(`${keyVar} is not set — cannot run '${info.id}'`);
    return new OpenAICompatModel(info.provider, key, info.upstreamId ?? info.id, baseUrl);
  }

  // --- history -------------------------------------------------------------
  private history(): Message[] {
    return (
      this.sql
        .exec("SELECT id,role,content,channel,ts FROM messages ORDER BY seq ASC")
        .toArray() as unknown[]
    ).map((r) => r as Message);
  }
  private record(m: Message): void {
    this.sql.exec(
      "INSERT INTO messages (id,role,content,channel,ts) VALUES (?,?,?,?,?)",
      m.id,
      m.role,
      m.content,
      m.channel,
      m.ts,
    );
  }

  /**
   * The provider behind this agent's model. The CLI harness points its agent
   * program at this, so Claude Code runs on whatever model the agent is
   * configured with rather than requiring an Anthropic subscription.
   */
  private provider(): { key?: string; baseUrl?: string; model?: string } {
    const info = MODELS[this.spec.model];
    // No provider credentials for an OAuth model: the CLI uses its own token,
    // and handing it a mismatched base URL would point it at the wrong API.
    if (!info || info.oauth) return {};
    const { baseUrl, keyVar } = PROVIDERS[info.provider];
    const key = (this.env as unknown as Record<string, string | undefined>)[keyVar];
    return { key, baseUrl, model: info.upstreamId ?? info.id };
  }

  // --- the conversation -----------------------------------------------------
  async configure(spec: Partial<AgentSpec>): Promise<AgentSpec> {
    const merged = { ...this.spec, ...spec };
    this.setKV("spec", merged);
    return merged;
  }

  /** Core message loop: unified across channels (history is per-agent). */
  async send(text: string, channel = "core"): Promise<{ reply?: string }> {
    this.record(makeMessage("user", text, channel));
    const harness = getHarness(this.spec.harness, this.env.USE_ECHO_MODEL === "1");
    const { getSandbox } = await import("./sandbox/index.js");
    const { getCapability } = await import("./capabilities/index.js");

    // Expose this agent's enabled capabilities as model-callable tools, so it
    // can search/scrape mid-conversation instead of only via POST /tool/:name.
    const tools = this.spec.capabilities
      .map((name) => {
        const cap = getCapability(name);
        return cap?.parameters
          ? { name: cap.name, description: cap.describe, parameters: cap.parameters }
          : null;
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);

    const reply = await harness.run(this.buildModel(), this.history(), this.spec.system, {
      sandbox: getSandbox(this.env, this.spec.machine),
      agentId: this.ctx.id.toString(), // stable per-agent workspace key
      agentsMd: this.getKV<string | null>("agents_md", null) ?? undefined,
      capabilities: this.spec.capabilities,
      // The VM's tools call back in over the public URL: a container has no
      // route to a Durable Object except through the Worker's own front door.
      agentUrl:
        this.env.WORKER_URL && this.spec.name
          ? `${this.env.WORKER_URL}/agents/${this.spec.name}`
          : undefined,
      ...(() => {
        const p = this.provider();
        return {
          cliKey: p.key,
          cliBaseUrl: p.baseUrl,
          cliModel: p.model,
          oauthToken: this.env.CLAUDE_CODE_OAUTH_TOKEN,
        };
      })(),
      tools,
      runTool: async (name, input) => {
        const out = await this.runTool(name, input);
        if (out.error) throw new Error(out.error);
        return out.result;
      },
    });
    this.record(makeMessage("assistant", reply, channel));
    // health != progress: advance last-progress only when a unit of work completes.
    this.setKV("last_progress", Date.now());
    return { reply };
  }

  async getHistory(): Promise<Message[]> {
    return this.history();
  }

  /** Standing instructions for this agent, written into its VM as AGENTS.md. */
  async getAgentsMd(): Promise<{ content: string | null }> {
    return { content: this.getKV<string | null>("agents_md", null) };
  }

  async setAgentsMd(content: string | null): Promise<{ ok: true }> {
    this.setKV("agents_md", content && content.trim() ? content : null);
    return { ok: true };
  }

  // --- backup ---------------------------------------------------------------
  /** Export full agent state (spec + history + kv) for backup. */
  async snapshot(): Promise<{ spec: AgentSpec; history: Message[]; kv: Record<string, unknown> }> {
    const kv: Record<string, unknown> = {};
    for (const r of this.sql.exec("SELECT key,value FROM kv").toArray() as {
      key: string;
      value: string;
    }[]) {
      kv[r.key] = JSON.parse(r.value);
    }
    return { spec: this.spec, history: this.history(), kv };
  }

  /** Restore from a snapshot (best-effort recovery — replaces current state). */
  async restore(snap: {
    spec?: AgentSpec;
    history?: Message[];
    kv?: Record<string, unknown>;
  }): Promise<void> {
    this.sql.exec("DELETE FROM messages");
    this.sql.exec("DELETE FROM kv");
    if (snap.spec) this.setKV("spec", snap.spec);
    for (const [k, v] of Object.entries(snap.kv ?? {})) this.setKV(k, v);
    for (const m of snap.history ?? []) this.record(m);
  }


  /** Permanently erase this agent's history + state. */
  async wipe(): Promise<void> {
    this.sql.exec("DELETE FROM messages");
    this.sql.exec("DELETE FROM kv");
    await this.ctx.storage.deleteAlarm();
  }

  /** health!=progress: report both heartbeat and last real progress + cadence. */
  async status(): Promise<{
    lastProgress: number | null;
    expectedCadenceMs: number | null;
    stalled: boolean;
  }> {

    const lastProgress = this.getKV<number | null>("last_progress", null);
    const cadence = this.getKV<number | null>("expected_cadence_ms", null);
    const stalled =
      cadence != null && lastProgress != null && Date.now() - lastProgress > cadence;
    return { lastProgress, expectedCadenceMs: cadence, stalled };
  }

  // --- tools ----------------------------------------------------------------
  /**
   * Run one of this agent's enabled capabilities.
   * Returns { error } for expected failures rather than throwing across RPC,
   * so the harness can hand the model an observation and let it recover.
   */
  async runTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ result?: Record<string, unknown>; error?: string }> {
    if (!this.spec.capabilities.includes(name)) {
      return { error: `capability '${name}' not enabled for this agent` };
    }
    try {
      if (name === "run_shell") {
        const { getSandbox } = await import("./sandbox/index.js");
        const sandbox = getSandbox(this.env, this.spec.machine);
        if (!sandbox) return { error: "no sandbox is configured for this agent" };
        const command = String(input.command ?? "").trim();
        if (!command) return { error: "run_shell requires { command }" };
        const out = await sandbox.exec(this.ctx.id.toString(), command);
        return {
          result: {
            stdout: out.stdout.slice(0, 8000),
            stderr: out.stderr.slice(0, 4000),
            exitCode: out.exitCode,
          },
        };
      }

      const memo = this.runMemoryTool(name, input);
      if (memo) return { result: memo };

      const { getCapability } = await import("./capabilities/index.js");
      const cap = getCapability(name);
      if (!cap) return { error: `capability '${name}' has no implementation` };
      return { result: (await cap.run(this.env, input)) as Record<string, unknown> };
    } catch (e) {
      return { error: String(e) };
    }
  }

  /**
   * remember / recall, which the ordinary Capability contract cannot serve:
   * they need this agent's own SQLite, and a capability only receives `env`.
   * Returns null for any other tool name so the caller falls through.
   */
  private runMemoryTool(
    name: string,
    input: Record<string, unknown>,
  ): Record<string, unknown> | null {
    if (name === "remember") {
      const key = String(input.key ?? "").trim();
      if (!key) throw new Error("remember requires { key, value }");
      this.sql.exec(
        "INSERT INTO notes (key,value,ts) VALUES (?,?,?) " +
          "ON CONFLICT(key) DO UPDATE SET value=excluded.value, ts=excluded.ts",
        key,
        String(input.value ?? ""),
        Date.now(),
      );
      return { saved: key };
    }

    if (name === "recall") {
      const key = input.key ? String(input.key).trim() : null;
      const rows = key
        ? this.sql.exec("SELECT key,value,ts FROM notes WHERE key = ?", key).toArray()
        : this.sql.exec("SELECT key,value,ts FROM notes ORDER BY ts DESC LIMIT 50").toArray();
      return { notes: rows };
    }

    return null;
  }

  // --- acting on its own ----------------------------------------------------
  /** Set (or replace) the standing task. Pass cadenceMs to make it recurring. */
  async scheduleWakeup(atMs: number, prompt: string, cadenceMs?: number): Promise<void> {
    this.setKV("wakeup_prompt", prompt);
    this.setKV("expected_cadence_ms", cadenceMs ?? null);
    this.setKV("next_wake", atMs);
    await this.ctx.storage.setAlarm(atMs);
  }

  /** Clear the standing task so the agent stops acting on its own. */
  async unschedule(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    this.setKV("wakeup_prompt", null);
    this.setKV("expected_cadence_ms", null);
    this.setKV("next_wake", null);
  }

  /** What the agent will do on its own, and when. */
  async getSchedule(): Promise<{
    prompt: string | null;
    cadenceMs: number | null;
    nextWake: number | null;
  }> {
    return {
      prompt: this.getKV<string | null>("wakeup_prompt", null),
      cadenceMs: this.getKV<number | null>("expected_cadence_ms", null),
      nextWake: this.getKV<number | null>("next_wake", null),
    };
  }

  /** Public wakeup logic, callable over RPC (the reserved `alarm` delegates here). */
  async fireWakeup(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    const prompt = this.getKV<string | null>("wakeup_prompt", null);
    const cadence = this.getKV<number | null>("expected_cadence_ms", null);

    // Re-arm BEFORE running the task: if the model call throws, a recurring
    // agent must still wake next cycle rather than silently stopping forever.
    if (cadence && cadence > 0) {
      const next = Date.now() + cadence;
      this.setKV("next_wake", next);
      await this.ctx.storage.setAlarm(next);
    } else {
      this.setKV("next_wake", null);
    }

    if (prompt) {
      await this.send(prompt, "scheduler");
    }
  }

  async alarm(): Promise<void> {
    await this.fireWakeup();
  }
}
