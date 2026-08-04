// Features #1 (runtime+loop), #2 (persistent memory), #14 (alarm/wakeup),
// and the health!=progress signal from the AgentSky PH thread — all in the
// per-agent Durable Object. One DO instance == one always-on agent.
import { DurableObject } from "cloudflare:workers";
import type { Env, Message, Role } from "./types.js";
import { makeMessage } from "./types.js";
import { MODELS } from "./catalog.js";
import { ChatHarness, getHarness, type AgentSpec, defaultSpec } from "./harnesses/index.js";
import { ClaudeModel, MockModel, OpenAIModel, type Model } from "./models/index.js";

const OPENAI_BASE: Record<string, string> = {
  // OpenAI-compatible providers reached via base_url swap (no lock-in).
  openai: "https://api.openai.com/v1",
};

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
    // No API key? Fall back to the MockModel so the product is fully demoable.
    const info = MODELS[this.spec.model];
    if (!info) return new MockModel();
    if (info.backend === "claude") {
      const key = this.env.ANTHROPIC_API_KEY;
      return key ? new ClaudeModel(key, this.spec.model) : new MockModel();
    }
    const key = this.env.OPENAI_API_KEY;
    return key ? new OpenAIModel(key, this.spec.model, OPENAI_BASE.openai) : new MockModel();
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

  // --- public RPC ----------------------------------------------------------
  async configure(spec: Partial<AgentSpec>): Promise<AgentSpec> {
    const merged = { ...this.spec, ...spec };
    this.setKV("spec", merged);
    return merged;
  }

  /** Core message loop: unified across channels (history is per-agent).
   * Returns { parked: true } instead of throwing for the expected parked state. */
  async send(text: string, channel = "core"): Promise<{ reply?: string; parked?: boolean }> {
    if (this.getKV("parked", false)) return { parked: true };
    this.record(makeMessage("user", text, channel));
    const harness = getHarness(this.spec.harness) ?? new ChatHarness();
    const reply = await harness.run(this.buildModel(), this.history(), this.spec.system);
    this.record(makeMessage("assistant", reply, channel));
    // health != progress: advance last-progress only when a unit of work completes.
    this.setKV("last_progress", Date.now());
    return { reply };
  }

  async getHistory(): Promise<Message[]> {
    return this.history();
  }

  // --- Feature #5: snapshot / restore --------------------------------------
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

  async park(): Promise<void> {
    this.setKV("parked", true);
  }
  async unpark(): Promise<void> {
    this.setKV("parked", false);
  }

  /** health!=progress: report both heartbeat and last real progress + cadence. */
  async status(): Promise<{
    parked: boolean;
    lastProgress: number | null;
    expectedCadenceMs: number | null;
    stalled: boolean;
  }> {
    const parked = this.getKV("parked", false);
    const lastProgress = this.getKV<number | null>("last_progress", null);
    const cadence = this.getKV<number | null>("expected_cadence_ms", null);
    const stalled =
      !parked && cadence != null && lastProgress != null && Date.now() - lastProgress > cadence;
    return { parked, lastProgress, expectedCadenceMs: cadence, stalled };
  }

  // --- Feature #13: capabilities -------------------------------------------
  /** Run one of this agent's enabled capabilities.
   * Returns { error } for expected failures instead of throwing across RPC. */
  async runTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ result?: unknown; error?: string }> {
    if (!this.spec.capabilities.includes(name)) {
      return { error: `capability '${name}' not enabled for this agent` };
    }
    const { getCapability } = await import("./capabilities/index.js");
    const cap = getCapability(name);
    if (!cap) return { error: `capability '${name}' has no implementation` };
    return { result: await cap.run(this.env, input) };
  }

  // --- Feature #14: scheduled wakeups --------------------------------------
  async scheduleWakeup(atMs: number, prompt: string, cadenceMs?: number): Promise<void> {
    this.setKV("wakeup_prompt", prompt);
    if (cadenceMs) this.setKV("expected_cadence_ms", cadenceMs);
    await this.ctx.storage.setAlarm(atMs);
  }

  /** Public wakeup logic, callable over RPC (the reserved `alarm` delegates here). */
  async fireWakeup(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    const prompt = this.getKV<string | null>("wakeup_prompt", null);
    if (prompt) {
      await this.send(prompt, "scheduler"); // no-op if parked
    }
  }

  async alarm(): Promise<void> {
    await this.fireWakeup();
  }
}
