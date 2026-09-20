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

  /** Has this agent been created? A DO exists for every name ever addressed. */
  private get configured(): boolean {
    return this.getKV<AgentSpec | null>("spec", null) !== null;
  }

  /** Public form of `configured`, so launch can refuse to clobber an agent. */
  async exists(): Promise<boolean> {
    return this.configured;
  }

  /** This agent's spec, for callers that need to register or display it. */
  async getSpec(): Promise<AgentSpec> {
    return this.spec;
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
  private provider(): {
    key?: string;
    baseUrl?: string;
    model?: string;
    provider?: string;
    keyVar?: string;
  } {
    const info = MODELS[this.spec.model];
    // No provider credentials for an OAuth model: the CLI uses its own token,
    // and handing it a mismatched base URL would point it at the wrong API.
    if (!info || info.oauth) return {};
    const { baseUrl, keyVar } = PROVIDERS[info.provider];
    const key = (this.env as unknown as Record<string, string | undefined>)[keyVar];
    // The provider's name and key var travel alongside the base URL: a CLI
    // with its own model catalog resolves the endpoint from the name and never
    // needs the URL at all.
    return {
      key,
      baseUrl,
      model: info.upstreamId ?? info.id,
      provider: info.provider,
      keyVar,
    };
  }

  // --- the conversation -----------------------------------------------------
  /**
   * Write this agent's spec.
   *
   * `create` distinguishes launching from editing. Without it, configure was
   * the way around every other guard: one POST to an arbitrary name wrote a
   * full default spec, so the agent then "existed" — schedulable, able to boot
   * a VM and spend quota — while never entering the registry or the dashboard,
   * and `launch` refused that name forever with nothing able to clear it.
   */
  async configure(
    spec: Partial<AgentSpec>,
    create = false,
  ): Promise<{ spec?: AgentSpec; missing?: boolean }> {
    if (!create && !this.configured) return { missing: true };
    const merged = { ...this.spec, ...spec };
    this.setKV("spec", merged);
    return { spec: merged };
  }

  /** Core message loop: unified across channels (history is per-agent). */
  async send(
    text: string,
    channel = "core",
    origin?: string,
    depth = 0,
  ): Promise<{ reply?: string; missing?: boolean }> {
    // Cloudflare routes any name to a Durable Object, so an agent that was
    // never launched is indistinguishable from one that was — it just has no
    // spec. Without this check a typo in the URL boots a VM, spends the
    // subscription quota, and produces an agent no dashboard ever lists.
    if (!this.configured) return { missing: true };
    // The VM's send_to_agent runs mid-turn and has no way to know how many
    // hops preceded it, so the count is parked here for this turn to read.
    this.setKV("a2a_depth", depth);
    this.record(makeMessage("user", text, channel));
    const harness = getHarness(this.spec.harness, this.env.USE_ECHO_MODEL === "1");
    const { getSandbox } = await import("./sandbox/index.js");


    const reply = await harness.run(this.buildModel(), this.history(), this.spec.system, {
      sandbox: getSandbox(this.env, this.spec.machine),
      agentId: this.ctx.id.toString(), // stable per-agent workspace key
      agentsMd: this.getKV<string | null>("agents_md", null) ?? undefined,
      capabilities: this.spec.capabilities,
      // The VM's tools call back in over the public URL: a container has no
      // route to a Durable Object except through the Worker's own front door.
      //
      // The origin comes from the request being served, so every deployment
      // calls back to itself. A hardcoded value here would be baked into the
      // tool scripts inside every user's VM, pointing their agents' tool calls
      // and memory writes at whichever deployment the value named. WORKER_URL
      // remains as an override for when the public URL differs from the
      // request host (a proxy, a custom domain).
      agentUrl: this.agentUrl(origin),
      ...(() => {
        const p = this.provider();
        return {
          cliKey: p.key,
          cliBaseUrl: p.baseUrl,
          cliModel: p.model,
          cliProvider: p.provider,
          cliKeyVar: p.keyVar,
          oauthToken: this.env.CLAUDE_CODE_OAUTH_TOKEN,
        };
      })(),
    });
    this.record(makeMessage("assistant", reply, channel));
    // health != progress: advance last-progress only when a unit of work completes.
    this.setKV("last_progress", Date.now());
    return { reply };
  }

  /**
   * This agent's own REST base, for tools running inside its VM.
   *
   * `WORKER_URL` wins when set — a deployment behind a proxy or custom domain
   * knows its public address better than the request host does. Otherwise the
   * origin of the request being served is exactly right, and costs no config.
   *
   * The last origin seen is remembered because a scheduled wakeup has no
   * request to take one from: the alarm fires on its own, and without this its
   * agent would lose every VM tool until someone next messaged it.
   */
  private agentUrl(origin?: string): string | undefined {
    if (origin) this.setKV("origin", origin);
    const base = this.env.WORKER_URL ?? origin ?? this.getKV<string | null>("origin", null);
    if (!base || !this.spec.name) return undefined;
    // The tool scripts run inside the VM and post back through the public
    // front door, so on a guarded deployment they need the token. It rides on
    // the query string because those scripts are generated python with no
    // per-call header plumbing; the URL never leaves the container.
    const auth = this.env.FLEET_TOKEN ? `?token=${encodeURIComponent(this.env.FLEET_TOKEN)}` : "";
    return `${base}/agents/${encodeURIComponent(this.spec.name)}${auth}`;
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
  /** Export full agent state (spec + history + kv + notes) for backup. */
  async snapshot(): Promise<{
    spec: AgentSpec;
    history: Message[];
    kv: Record<string, unknown>;
    notes: { key: string; value: string; ts: number }[];
  }> {
    const kv: Record<string, unknown> = {};
    for (const r of this.sql.exec("SELECT key,value FROM kv").toArray() as {
      key: string;
      value: string;
    }[]) {
      kv[r.key] = JSON.parse(r.value);
    }
    // Notes are the part of an agent that outlives its sessions, so a snapshot
    // without them restores an agent that has forgotten everything it chose to
    // keep — the opposite of what a backup is for.
    const notes = this.sql
      .exec("SELECT key,value,ts FROM notes ORDER BY ts DESC")
      .toArray() as unknown as { key: string; value: string; ts: number }[];
    return { spec: this.spec, history: this.history(), kv, notes };
  }

  /** Restore from a snapshot (best-effort recovery — replaces current state). */
  async restore(snap: {
    spec?: AgentSpec;
    history?: Message[];
    kv?: Record<string, unknown>;
    notes?: { key: string; value: string; ts: number }[];
  }): Promise<void> {
    this.sql.exec("DELETE FROM messages");
    this.sql.exec("DELETE FROM kv");
    this.sql.exec("DELETE FROM notes");
    if (snap.spec) this.setKV("spec", snap.spec);
    for (const [k, v] of Object.entries(snap.kv ?? {})) this.setKV(k, v);
    for (const m of snap.history ?? []) this.record(m);
    for (const n of snap.notes ?? []) {
      this.sql.exec("INSERT INTO notes (key,value,ts) VALUES (?,?,?)", n.key, n.value, n.ts);
    }
    await this.rearmAlarm();
  }

  /**
   * Put the alarm back in step with the schedule the kv rows describe.
   *
   * The schedule lives in kv, so a restore carries its *values* across for
   * free — but an alarm is DO state, not a table, and copying the rows does
   * not re-arm it. Without this, a restored agent knows exactly what it is
   * meant to do and when, and then never does it: the one failure a backup
   * of an always-on agent must not have.
   *
   * `next_wake` is usually already in the past by the time a snapshot is
   * restored, and a past-dated alarm fires at once. Firing immediately is
   * right for a one-shot task that was owed while the agent was away, but
   * wrong for a recurring one, where it would run off-cadence and then stay
   * off it. So a lapsed recurring schedule is advanced to the next whole
   * cycle instead.
   */
  private async rearmAlarm(): Promise<void> {
    const at = this.getKV<number | null>("next_wake", null);
    if (!at) return; // no standing task, or it was explicitly cleared

    const cadence = this.getKV<number | null>("expected_cadence_ms", null);
    const next = at <= Date.now() && cadence && cadence > 0 ? Date.now() + cadence : at;

    this.setKV("next_wake", next);
    await this.ctx.storage.setAlarm(next);
  }


  /**
   * Stop this agent's container and give its slot back.
   *
   * Only the agent knows which machine tier it runs on, and the tier decides
   * which container class holds it — so this has to happen before wipe() erases
   * the spec, or the container becomes unreachable and lingers until it times
   * out on its own.
   *
   * A failure here is logged and swallowed: the container will expire by itself,
   * and refusing to delete an agent because its VM would not stop is worse than
   * leaving one idle machine behind. The SDK notes teardown can hang, so this is
   * raced against a timeout rather than awaited indefinitely.
   */
  async releaseSandbox(): Promise<void> {
    const agentId = this.ctx.id.toString();
    try {
      const { getSandbox } = await import("./sandbox/index.js");
      const sandbox = getSandbox(this.env, this.spec.machine);
      if (!sandbox) return;
      // Resolving the binding can throw too — a test environment has no
      // containers at all — so it sits inside the try rather than beside it.
      await Promise.race([
        sandbox.destroy(agentId),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    } catch (e) {
      console.log(`releaseSandbox failed for ${agentId}: ${e}`);
    }
  }

  /**
   * Permanently erase this agent's history + state.
   *
   * `notes` has to go too. A Durable Object is addressed by name, so recreating
   * an agent with a name used before lands on the same object — and notes left
   * behind would be readable by whoever creates that name next. Deleting an
   * agent has to mean its memory is gone, not dormant.
   */
  async wipe(): Promise<void> {
    this.sql.exec("DELETE FROM messages");
    this.sql.exec("DELETE FROM kv");
    this.sql.exec("DELETE FROM notes");
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

      if (name === "send_to_agent") return await this.sendToAgent(input);
      if (name === "list_agents") return { result: await this.listAgents() };

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
   * How many agent-to-agent hops a single chain may make.
   *
   * Two agents that message each other keep going until something stops them,
   * and every hop is a model call on a booted container. The depth rides with
   * the message rather than being counted here: each agent only sees its own
   * turn, so there is nowhere local to keep a total.
   */
  private static readonly MAX_A2A_DEPTH = 3;

  /**
   * Message another agent and return its reply.
   *
   * `from` is this agent's own name, taken from its spec and never from the
   * tool input. An agent in a VM calls `send_to_agent bob "..."` and cannot
   * name itself, so the recipient's history records who actually sent it.
   *
   * The call goes back out through the Worker's front door rather than to
   * another DO stub directly: the route already records the message on the
   * `a2a` channel and enforces the target's own guards, and duplicating that
   * here would mean two paths into an agent that could drift apart.
   */
  private async sendToAgent(
    input: Record<string, unknown>,
  ): Promise<{ result?: Record<string, unknown>; error?: string }> {
    const to = String(input.to ?? "").trim();
    const text = String(input.text ?? "").trim();
    if (!to || !text) return { error: "send_to_agent requires <agent> <message>" };

    const me = this.spec.name;
    if (!me) return { error: "this agent has no name, so it cannot identify itself" };
    // A self-send is a loop with one participant, and the DO is single-threaded:
    // the inner request would wait on the outer one, which is still waiting.
    if (to === me) return { error: "an agent cannot send to itself" };

    const depth = this.getKV<number>("a2a_depth", 0) + 1;
    if (depth > AgentInstance.MAX_A2A_DEPTH) {
      return { error: `a2a depth limit (${AgentInstance.MAX_A2A_DEPTH}) reached` };
    }

    const base = this.getKV<string | null>("origin", null) ?? this.env.WORKER_URL;
    if (!base) return { error: "this deployment does not know its own URL yet" };

    // The token when the deployment has one: this request goes back through
    // the Worker's own front door, which is guarded like any other caller's.
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.env.FLEET_TOKEN) headers.authorization = `Bearer ${this.env.FLEET_TOKEN}`;
    const res = await fetch(`${base}/agents/${encodeURIComponent(to)}/a2a`, {
      method: "POST",
      headers,
      body: JSON.stringify({ from: me, text, depth }),
    });
    const body = (await res.json().catch(() => ({}))) as { reply?: string; error?: string };
    if (!res.ok) return { error: body.error ?? `agent '${to}' returned ${res.status}` };
    return { result: { from: me, to, reply: body.reply ?? "" } };
  }

  /**
   * The other agents on this deployment.
   *
   * Reads the registry rather than guessing: an agent DO cannot enumerate its
   * peers, and an agent told to delegate needs to know who actually exists.
   * This agent is filtered out — it is not someone it can send to.
   */
  private async listAgents(): Promise<Record<string, unknown>> {
    const registry = this.env.REGISTRY.get(
      this.env.REGISTRY.idFromName("global"),
    ) as unknown as { list(): Promise<{ id: string; model: string; harness: string }[]> };
    const all = await registry.list();
    const me = this.spec.name;
    return {
      agents: all
        .filter((a) => a.id !== me)
        .map((a) => ({ id: a.id, model: a.model, harness: a.harness })),
    };
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
  async fireWakeup(): Promise<{ missing?: boolean } | void> {
    if (!this.configured) return { missing: true };
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
