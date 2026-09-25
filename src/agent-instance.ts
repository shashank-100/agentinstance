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
import {
  MODELS,
  PROVIDERS,
  HARNESSES,
  HARNESS_MODELS,
  harnessCatalog,
  localBaseUrl,
  type KeyEnv,
} from "./catalog.js";
import { tokenForRepo } from "./github-app.js";
import { withStoredKeys } from "./keys.js";
import { DEPLOYMENT, fleetName, registryName, unscope } from "./scope.js";
import { EchoModel, OpenAICompatModel, UnusedModel, type Model } from "./models/index.js";

/**
 * How much live output an agent keeps.
 *
 * Enough to follow a run and scroll back through it; small enough that a CLI
 * printing a verbose build log cannot grow one agent's storage without limit.
 * Length rather than rows, because a row is anything from one character to a
 * 50KB stack trace and a row count bounds neither.
 *
 * Measured in the same unit throughout — SQLite's `LENGTH()`, which counts
 * characters. An earlier version added JavaScript's `text.length` (UTF-16 code
 * units) to a total it then overwrote from `SUM(LENGTH(text))`, so the two
 * disagreed on any text outside the BMP and the stored figure drifted.
 */
const OUTPUT_CHAR_LIMIT = 256 * 1024;

/** Ceiling on one stored row, so a single long line cannot become an
 *  unbounded row that trimming can only remove wholesale. */
const OUTPUT_CHUNK_MAX = 8 * 1024;

/**
 * The kv keys a snapshot may write back.
 *
 * What belongs in a backup is what the agent *is* — its standing instructions
 * and its schedule — not what happened to be true of the run that produced
 * the snapshot. Everything else is deliberately excluded:
 *
 * - `origin` decides where tools inside the VM call back to, and is re-learned
 *   from the next request. Restoring it would point a recovered agent's tool
 *   calls at whatever host took the snapshot.
 * - `a2a_depth` bounds agent-to-agent fan-out for one turn.
 * - `output_chars` counts a table that restore deletes, so carrying the old
 *   figure across would leave the counter describing rows that are gone.
 * - `last_progress` and `git_repo_last` describe a run that is over.
 *
 * `spec` is written separately and ahead of this, so it is not listed here.
 */
const RESTORABLE_KV = new Set([
  "agents_md",
  "wakeup_prompt",
  "expected_cadence_ms",
  "next_wake",
]);

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
        -- What the CLI printed, as it printed it. The transcript records what
        -- the agent decided; this records what it was doing while deciding,
        -- which is the only view of a run that is still in progress.
        CREATE TABLE IF NOT EXISTS output (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          ts INTEGER NOT NULL
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
    // A self-hosted server lives wherever its operator put it, so its base URL
    // and the model it serves are configuration rather than constants.
    const { keyVar } = PROVIDERS[info.provider];
    const baseUrl =
      info.provider === "local" ? localBaseUrl(this.env as unknown as KeyEnv) : PROVIDERS[info.provider].baseUrl;
    const key = (this.env as unknown as Record<string, string | undefined>)[keyVar];
    if (!key) throw new Error(`${keyVar} is not set — cannot run '${info.id}'`);
    const modelId =
      info.provider === "local"
        ? ((this.env as unknown as Record<string, string | undefined>)["LOCAL_MODEL_ID"] ??
          info.upstreamId ??
          info.id)
        : (info.upstreamId ?? info.id);
    return new OpenAICompatModel(info.provider, key, modelId, baseUrl);
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
  private provider(env: Env): {
    key?: string;
    baseUrl?: string;
    model?: string;
    provider?: string;
    keyVar?: string;
  } {
    const info = MODELS[this.spec.model];
    if (!info) return {};
    // A self-hosted server lives wherever its operator put it, so its base URL
    // and the model it serves are configuration rather than constants.
    const { keyVar } = PROVIDERS[info.provider];
    const baseUrl =
      info.provider === "local" ? localBaseUrl(env as unknown as KeyEnv) : PROVIDERS[info.provider].baseUrl;
    const key = (env as unknown as Record<string, string | undefined>)[keyVar];

    // `oauth` says a subscription token *can* serve this model, not that the
    // model has no provider key: Claude is reachable either way. When a token
    // is set it wins, and the base URL is withheld — Claude Code authenticates
    // against its vendor directly, and pointing it elsewhere would send the
    // subscription to an API that does not honour it.
    //
    // The provider *name* and model survive regardless. A CLI that resolves
    // its endpoint from a name (pi) still needs that name on the command line,
    // and dropping it here rendered `--provider '' --model ''`.
    if (info.oauth && env.CLAUDE_CODE_OAUTH_TOKEN) {
      return { model: info.upstreamId ?? info.id, provider: info.provider };
    }
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
    depth?: number,
  ): Promise<{ reply?: string; missing?: boolean }> {
    // Cloudflare routes any name to a Durable Object, so an agent that was
    // never launched is indistinguishable from one that was — it just has no
    // spec. Without this check a typo in the URL boots a VM, spends the
    // subscription quota, and produces an agent no dashboard ever lists.
    if (!this.configured) return { missing: true };
    // The VM's send_to_agent runs mid-turn and has no way to know how many
    // hops preceded it, so the count is parked here for this turn to read.
    //
    // Only a caller that actually knows the hop count writes it. This used to
    // default to 0 and write unconditionally, which meant every ordinary
    // message — a channel webhook, a scheduled wakeup, a plain /send — reset
    // the counter. Two agents replying to each other through any non-a2a path
    // therefore never reached MAX_A2A_DEPTH, and each hop is a model call on a
    // booted container.
    if (depth !== undefined) this.setKV("a2a_depth", depth);
    this.record(makeMessage("user", text, channel));
    const harness = getHarness(this.spec.harness, this.env.USE_ECHO_MODEL === "1");
    const { getSandbox } = await import("./sandbox/index.js");
    // Keys saved from the board, laid over the Worker's secrets — this agent's
    // owner's keys, so an agent runs on its own person's credential and never
    // on somebody else's.
    const env = await withStoredKeys(this.env, this.owner());

    const reply = await harness.run(this.buildModel(), this.history(), this.spec.system, {
      sandbox: getSandbox(this.env, this.spec.machine),
      agentId: this.ctx.id.toString(), // stable per-agent workspace key
      agentsMd: this.getKV<string | null>("agents_md", null) ?? undefined,
      // Persisted as it arrives, so /output shows a run in progress.
      onOutput: (text: string) => this.recordOutput(text),
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
        const p = this.provider(env);
        return {
          cliKey: p.key,
          cliBaseUrl: p.baseUrl,
          cliModel: p.model,
          cliProvider: p.provider,
          cliKeyVar: p.keyVar,
          oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
          // The subscription is Anthropic's, so it can only serve a Claude
          // model. `oauth` marks exactly those.
          cliOauthOk: MODELS[this.spec.model]?.oauth === true,
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

  /**
   * Move this agent onto a different harness or model, keeping everything else.
   *
   * The point is to continue, not to restart: a subscription hits its limit
   * mid-job, or a cheap model turns out not to be up to the work. History
   * lives in this object's own SQLite and the harness rebuilds its prompt from
   * it every turn, so the next turn on the new model already knows everything
   * the last one did. Only the spec changes.
   *
   * The switch is recorded in the transcript rather than happening silently.
   * An agent whose answers change character mid-conversation, with nothing
   * saying why, is one nobody can debug — and the note is context the new
   * model reads too.
   */
  async handoff(to: {
    harness?: string;
    model?: string;
    reason?: string;
  }): Promise<{ spec?: AgentSpec; from?: { harness: string; model: string }; missing?: boolean }> {
    if (!this.configured) return { missing: true };
    const before = { harness: this.spec.harness, model: this.spec.model };
    const merged: AgentSpec = {
      ...this.spec,
      harness: to.harness ?? this.spec.harness,
      model: to.model ?? this.spec.model,
    };

    // A harness that cannot drive the model is a 404 at run time, so refuse it
    // here where the caller can still do something about it.
    const { checkCompatible } = await import("./harnesses/index.js");
    checkCompatible(merged);

    this.setKV("spec", merged);
    const why = to.reason ? ` (${to.reason})` : "";
    this.record(
      makeMessage(
        "system",
        `Handed off from ${before.harness}/${before.model} to ` +
          `${merged.harness}/${merged.model}${why}. ` +
          `The conversation above is yours to continue.`,
        "handoff",
      ),
    );
    return { spec: merged, from: before };
  }

  async getHistory(): Promise<Message[]> {
    return this.history();
  }

  /**
   * Record a chunk of live output.
   *
   * Append-only, deliberately. An earlier version coalesced small chunks into
   * the previous row to save on keys and timestamps — which quietly broke the
   * only thing this table is for. Watchers follow with `?since=<seq>`, and
   * appending to an existing row leaves its `seq` unchanged, so every byte
   * added that way is invisible to anyone already watching. The faster they
   * poll, the more they miss. A row per chunk costs a little more and is the
   * only shape that can be followed incrementally.
   *
   * Bounded by length rather than rows: a row is anything from one character to
   * a 50KB stack trace, so a row count bounds nothing.
   */
  recordOutput(text: string): void {
    if (!text) return;

    // One oversized chunk is split rather than stored whole. A single row
    // larger than the budget cannot be trimmed down to fit — evicting it takes
    // the entire buffer with it, so a `cat` of a big file would blank the very
    // output someone is watching.
    for (let i = 0; i < text.length; i += OUTPUT_CHUNK_MAX) {
      this.sql.exec(
        "INSERT INTO output (text, ts) VALUES (?, ?)",
        text.slice(i, i + OUTPUT_CHUNK_MAX),
        Date.now(),
      );
    }

    this.trimOutput();
  }

  /**
   * Evict oldest rows until the buffer is back inside its budget.
   *
   * Eviction is driven by accumulated length rather than a row fraction. The
   * old version dropped `COUNT(*)/4` rows per pass, which says nothing about
   * how much text that removes: a handful of large rows floors that quotient
   * to zero, so each pass evicted a single row and the loop leant on its
   * `count <= 1` escape — exiting with a row far over budget while recording
   * it as compliant. Choosing rows by their length ends in one pass and
   * actually restores the invariant.
   *
   * The newest row is never evicted. Trimming to nothing would mean a large
   * write blanks the screen of whoever is watching, which is worse than being
   * briefly over budget.
   */
  private trimOutput(): void {
    const total = this.sql
      .exec("SELECT COALESCE(SUM(LENGTH(text)), 0) AS n FROM output")
      .toArray()[0] as { n: number } | undefined;
    let over = (total?.n ?? 0) - OUTPUT_CHAR_LIMIT;
    if (over <= 0) {
      this.setKV("output_chars", total?.n ?? 0);
      return;
    }

    // Oldest first, stopping as soon as enough has been reclaimed. The newest
    // row is excluded from the candidates rather than special-cased, so the
    // "never blank the screen" rule holds however far over budget we are.
    const rows = this.sql
      .exec(
        "SELECT seq, LENGTH(text) AS n FROM output " +
          "WHERE seq < (SELECT MAX(seq) FROM output) ORDER BY seq ASC",
      )
      .toArray() as unknown as { seq: number; n: number }[];

    let cutoff: number | null = null;
    for (const row of rows) {
      cutoff = row.seq;
      over -= row.n;
      if (over <= 0) break;
    }
    if (cutoff !== null) {
      this.sql.exec("DELETE FROM output WHERE seq <= ?", cutoff);
    }

    const after = this.sql
      .exec("SELECT COALESCE(SUM(LENGTH(text)), 0) AS n FROM output")
      .toArray()[0] as { n: number } | undefined;
    this.setKV("output_chars", after?.n ?? 0);
  }

  /** Live output, oldest first. `since` returns only what is new. */
  async getOutput(since = 0): Promise<{ seq: number; text: string; ts: number }[]> {
    return this.sql
      .exec("SELECT seq, text, ts FROM output WHERE seq > ? ORDER BY seq ASC", since)
      .toArray() as unknown as { seq: number; text: string; ts: number }[];
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

  /**
   * Is this snapshot complete enough to restore, and what would be lost?
   *
   * A backup you have not checked is a backup you are guessing about. Restore
   * is destructive — it deletes the agent's messages, kv and notes before
   * writing — so "will this work?" has to be answerable without performing it.
   *
   * Two different things are reported. `errors` mean the snapshot cannot be
   * restored into a working agent: no spec, or a spec naming a harness or
   * model this deployment cannot run. `warnings` mean it will restore but
   * something is absent or will be dropped — an agent with no history, a
   * schedule with no prompt to run, keys the snapshot carries that restore
   * deliberately will not write back.
   *
   * Checked against *this* deployment's catalog on purpose: a snapshot taken
   * where `pi` was configured is not restorable somewhere it is not, and the
   * honest moment to say so is before the delete, not after.
   */
  async validateSnapshot(snap: {
    spec?: AgentSpec;
    history?: Message[];
    kv?: Record<string, unknown>;
    notes?: { key: string; value: string; ts: number }[];
  }): Promise<{
    ok: boolean;
    errors: string[];
    warnings: string[];
    counts: { history: number; notes: number; kv: number; restorableKv: number };
  }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!snap.spec) {
      // Without a spec there is no agent — only a Durable Object that exists
      // because something addressed its name.
      errors.push("no spec: a snapshot without one restores nothing runnable");
    } else {
      const { harness, model } = snap.spec;
      if (!HARNESSES[harness]) {
        errors.push(`harness '${harness}' is not one this deployment has`);
      } else if (!harnessCatalog((await withStoredKeys(this.env, this.owner())) as unknown as KeyEnv)[harness]?.ready) {
        // A warning, not an error. Whether a key happens to be set right now
        // says nothing about whether the snapshot is complete, and refusing
        // here would block recovery during exactly the outage — a missing or
        // rotated key — that makes someone reach for a backup. The agent
        // restores; it cannot run until the key is back.
        warnings.push(`harness '${harness}' has no key set here — the agent will restore but not run`);
      }
      if (!MODELS[model]) {
        errors.push(`model '${model}' is not in this deployment's catalog`);
      } else if (!(HARNESS_MODELS[harness] ?? []).includes(model)) {
        errors.push(`harness '${harness}' cannot drive model '${model}'`);
      }
    }

    const history = snap.history ?? [];
    const notes = snap.notes ?? [];
    const kv = snap.kv ?? {};

    if (history.length === 0) {
      warnings.push("no history: the restored agent starts with an empty transcript");
    }
    // A message missing its fields restores as a hole in the conversation the
    // next model reads, which is worse than a shorter history.
    const malformed = history.filter((m) => !m?.role || typeof m?.content !== "string").length;
    if (malformed) errors.push(`${malformed} message(s) missing a role or content`);

    // A schedule is two halves. Either alone is a restored agent that wakes up
    // with nothing to do, or knows what to do and never wakes.
    const wake = kv["next_wake"];
    const prompt = kv["wakeup_prompt"];
    if (wake && !prompt) warnings.push("a wake time with no prompt: the agent will wake and do nothing");
    if (prompt && !wake) warnings.push("a wakeup prompt with no wake time: nothing will fire it");

    const dropped = Object.keys(kv).filter((k) => k !== "spec" && !RESTORABLE_KV.has(k));
    if (dropped.length) {
      warnings.push(`${dropped.length} kv key(s) will not be restored: ${dropped.join(", ")}`);
    }

    return {
      ok: errors.length === 0,
      errors,
      warnings,
      counts: {
        history: history.length,
        notes: notes.length,
        kv: Object.keys(kv).length,
        restorableKv: Object.keys(kv).filter((k) => RESTORABLE_KV.has(k)).length,
      },
    };
  }

  /** Restore from a snapshot (best-effort recovery — replaces current state). */
  async restore(snap: {
    spec?: AgentSpec;
    history?: Message[];
    kv?: Record<string, unknown>;
    notes?: { key: string; value: string; ts: number }[];
  }): Promise<{ ok: boolean; errors: string[]; warnings: string[]; restored?: { history: number; notes: number; kv: number } }> {
    // Validate before deleting anything. Restore replaces state, so a snapshot
    // that cannot produce a working agent must not be allowed to destroy the
    // one that is there — "it failed and took the agent with it" is the worst
    // outcome a recovery path can have.
    const check = await this.validateSnapshot(snap);
    if (!check.ok) return { ok: false, errors: check.errors, warnings: check.warnings };

    this.sql.exec("DELETE FROM messages");
    this.sql.exec("DELETE FROM kv");
    this.sql.exec("DELETE FROM notes");
    // Live output belongs to the run that produced it, not to the snapshot.
    // Leaving it while kv is wiped desyncs the stored length from the table —
    // the counter resets to zero, the rows stay, and nothing trims until a
    // fresh budget has been counted on top of what is already stored.
    this.sql.exec("DELETE FROM output");
    if (snap.spec) this.setKV("spec", snap.spec);
    // Only keys a snapshot legitimately carries. `kv` used to be written
    // wholesale, which made restore a general write primitive over this
    // agent's entire internal state — including `origin`, which decides where
    // the VM's tools call back to, and `a2a_depth`, which bounds agent-to-
    // agent fan-out. Neither belongs in a backup, and an unknown key is far
    // more likely to be a mistake than something worth preserving.
    for (const [k, v] of Object.entries(snap.kv ?? {})) {
      if (RESTORABLE_KV.has(k)) this.setKV(k, v);
    }
    for (const m of snap.history ?? []) this.record(m);
    for (const n of snap.notes ?? []) {
      this.sql.exec("INSERT INTO notes (key,value,ts) VALUES (?,?,?)", n.key, n.value, n.ts);
    }
    await this.rearmAlarm();
    return {
      ok: true,
      errors: [],
      warnings: check.warnings,
      restored: check.counts,
    };
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
      if (name === "fleet_task") return await this.fleetTask(input);
      if (name === "git_repo") return await this.gitRepo(input);
      if (name === "open_pr") return await this.openPr(input);

      const memo = this.runMemoryTool(name, input);
      if (memo) return { result: memo };

      // Through runCapability rather than looking the capability up here: the
      // enabled-check and dispatch used to be written out twice, so the copy
      // with tests around it was the copy nothing called.
      const { runCapability } = await import("./capabilities/index.js");
      return {
        result: (await runCapability(
          this.env,
          this.spec.capabilities,
          name,
          input,
        )) as Record<string, unknown>,
      };
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
    // An agent's own name carries whose it is, so it reads its owner's list
    // rather than a single global one. Without this, delegation would be a way
    // to message strangers' agents.
    const { owner } = unscope(this.spec.name ?? "");
    const registry = this.env.REGISTRY.get(
      this.env.REGISTRY.idFromName(registryName(owner)),
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
   * The work queue, from inside the VM.
   *
   * An agent claims a task, records a branch or a pull request against it, and
   * settles it. `claim` stamps this agent's own name for the same reason
   * send_to_agent does: the queue should record who actually took the work.
   */
  private async fleetTask(
    input: Record<string, unknown>,
  ): Promise<{ result?: Record<string, unknown>; error?: string }> {
    // The board this agent belongs to. Asking for a single global one would
    // let one person's agent claim another person's tasks.
    const { owner: boardOwner } = unscope(this.spec.name ?? "");
    const fleet = this.env.FLEET.get(
      this.env.FLEET.idFromName(fleetName(boardOwner)),
    ) as unknown as {
      claim(agentId: string): Promise<unknown>;
      get(id: string): Promise<unknown>;
      list(state?: string): Promise<unknown[]>;
      update(id: string, patch: Record<string, unknown>): Promise<unknown>;
      settle(id: string, result: string): Promise<unknown>;
      fail(id: string, reason: string): Promise<unknown>;
    };
    const action = String(input.action ?? "claim").trim();
    const id = input.id ? String(input.id).trim() : "";
    const me = this.spec.name ?? "unknown";

    switch (action) {
      case "claim": {
        const task = await fleet.claim(me);
        return { result: { task: task ?? null } };
      }
      case "list":
        return { result: { tasks: await fleet.list(input.state ? String(input.state) : undefined) } };
      case "get":
        if (!id) return { error: "fleet_task get requires an id" };
        return { result: { task: await fleet.get(id) } };
      case "branch":
      case "pr": {
        if (!id) return { error: `fleet_task ${action} requires an id` };
        const patch =
          action === "branch"
            ? { branch: String(input.value ?? "") }
            : { prUrl: String(input.value ?? "") };
        return { result: { task: await fleet.update(id, patch) } };
      }
      case "settle":
        if (!id) return { error: "fleet_task settle requires an id" };
        return { result: { task: await fleet.settle(id, String(input.value ?? "")) } };
      case "fail":
        if (!id) return { error: "fleet_task fail requires an id" };
        return { result: { task: await fleet.fail(id, String(input.value ?? "")) } };
      default:
        return { error: `unknown fleet_task action '${action}'` };
    }
  }

  /**
   * The GitHub account whose grants this agent's repository access runs under.
   *
   * An agent's name carries its owner, so the agent already knows. `undefined`
   * for an unowned agent — everything predating sign-in — which `tokenForRepo`
   * reads as "no owner boundary", keeping those agents working as they did.
   */
  private repoOwner(): string | undefined {
    const owner = this.owner();
    return owner === DEPLOYMENT ? undefined : owner;
  }

  /**
   * Whose agent this is, as a scope name.
   *
   * `DEPLOYMENT` for everything that predates sign-in, which is what keeps
   * those agents resolving to the keys and registry they always used.
   */
  private owner(): string {
    return unscope(this.spec.name ?? "").owner;
  }

  /**
   * Git against a real remote, inside the agent's own VM.
   *
   * The token is passed to the command's environment for the life of that
   * command, never written to disk and never committed to a config file: a
   * container's filesystem outlives the command, and a credential left in
   * `.git/config` is still there for whatever runs next.
   *
   * It is also kept out of the remote URL, which git records verbatim in
   * `.git/config` and echoes back in error messages. A credential helper
   * reading it from the environment leaves nothing behind.
   */
  private async gitRepo(
    input: Record<string, unknown>,
  ): Promise<{ result?: Record<string, unknown>; error?: string }> {
    const { getSandbox } = await import("./sandbox/index.js");
    const sandbox = getSandbox(this.env, this.spec.machine);
    if (!sandbox) return { error: "no sandbox is configured for this agent" };

    const action = String(input.action ?? "").trim();
    // The VM sends one generic `arg`; the REST API may name the field for the
    // action instead. Accept either, so both callers work.
    const arg = String(input.arg ?? "").trim();
    // Only `clone` is given a repo, but a GitHub App token is scoped to the
    // installation covering one — so `push` needs to know what was cloned.
    // Remembering it here keeps the tool's shape unchanged: an agent still
    // pushes without repeating itself.
    const named = String(input.repo ?? arg).trim();
    const repo = action === "clone" ? named : named || this.getKV<string>("git_repo_last", "");
    if (action === "clone" && repo) this.setKV("git_repo_last", repo);
    const dir = "/workspace/repo";

    // A credential helper that prints the token, so it never lands in a file
    // or a URL. GIT_ASKPASS would be consulted for the password only.
    const creds =
      `git config --global credential.helper '!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f' && ` +
      `git config --global user.name 'agentinstance' && ` +
      `git config --global user.email 'agent@users.noreply.github.com' && ` +
      `git config --global --add safe.directory ${dir}`;

    let cmd: string;
    switch (action) {
      case "clone": {
        if (!repo) return { error: "git_repo clone requires { repo: 'owner/name' }" };
        // Re-cloning over an existing checkout is the normal case, not an
        // error: the filesystem is discarded when the container sleeps, so a
        // task resumed after an idle gap starts from nothing.
        // The checkout is handed to the CLI's user, not left owned by root.
        // `git_repo` runs as root; the harness runs the agent CLI as `agent`.
        // Without this the agent can clone, branch and commit — and cannot
        // edit a single file, because every path under the checkout is
        // root-owned and `touch` fails with EACCES. It reads as "the CLI is
        // broken" rather than "the clone was made by a different user".
        cmd =
          `${creds} && rm -rf ${dir} && ` +
          `git clone --depth 50 https://github.com/${repo}.git ${dir} && ` +
          `(id -u agent >/dev/null 2>&1 || useradd -m agent) && ` +
          `chown -R agent ${dir} && ` +
          `cd ${dir} && git log --oneline -1`;
        break;
      }
      case "branch": {
        const name = String(input.name ?? arg).trim();
        if (!name) return { error: "git_repo branch requires { name }" };
        cmd = `cd ${dir} && git checkout -b ${shellArg(name)} && git rev-parse --abbrev-ref HEAD`;
        break;
      }
      case "commit": {
        const message = String(input.message ?? arg).trim();
        if (!message) return { error: "git_repo commit requires { message }" };
        cmd = `cd ${dir} && git add -A && git commit -m ${shellArg(message)} && git log --oneline -1`;
        break;
      }
      case "push": {
        // -u so the branch tracks its remote, and later pushes need no args.
        cmd =
          `${creds} && cd ${dir} && ` +
          `git push -u origin HEAD 2>&1 && git rev-parse --abbrev-ref HEAD`;
        break;
      }
      case "status":
        cmd = `cd ${dir} && git status --short && git log --oneline -5`;
        break;
      case "diff":
        cmd = `cd ${dir} && git diff HEAD~1 --stat 2>/dev/null || git diff --stat`;
        break;
      default:
        return { error: `unknown git_repo action '${action}'` };
    }

    // Only the actions that reach GitHub need a credential; `status` and
    // `diff` read the checkout and would fail for no reason without one.
    let token = "";
    if (action === "clone" || action === "push") {
      if (!repo) {
        return { error: `git_repo ${action} needs a repo — clone one first` };
      }
      // Scoped to whoever owns this agent: without that, a repository is
      // reachable by anyone on a deployment the app was ever installed from.
      const got = await tokenForRepo(this.env, repo, this.repoOwner());
      if (got.error) return { error: got.error };
      token = got.token!;
    }

    // The token goes through the exec's own env, scoped to this one command,
    // rather than into the command string. A `GH_TOKEN=<token> sh -c ...`
    // assignment puts the credential in the process's argv, where anything
    // else running in the container can read it out of the process list — the
    // one place the rest of this function is careful to keep it out of.
    const out = await sandbox.exec(
      this.ctx.id.toString(),
      cmd,
      token ? { GH_TOKEN: token } : undefined,
    );
    return {
      result: {
        stdout: out.stdout.slice(0, 8000),
        stderr: out.stderr.slice(0, 4000),
        exitCode: out.exitCode,
      },
    };
  }

  /**
   * Open a pull request.
   *
   * Through GitHub's REST API from the Worker rather than `gh` in the VM: the
   * container has no CLI for it, and this keeps the token on this side of the
   * boundary entirely.
   */
  private async openPr(
    input: Record<string, unknown>,
  ): Promise<{ result?: Record<string, unknown>; error?: string }> {
    const repo = String(input.repo ?? "").trim();
    const head = String(input.head ?? "").trim();
    if (!repo || !head) {
      return { error: "open_pr requires { repo: 'owner/name', head: 'branch' }" };
    }
    const got = await tokenForRepo(this.env, repo, this.repoOwner());
    if (got.error) return { error: got.error };
    const token = got.token!;

    const res = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        // GitHub rejects requests without one.
        "user-agent": "agentinstance",
      },
      body: JSON.stringify({
        title: String(input.title ?? head),
        head,
        base: String(input.base ?? "main"),
        body: String(input.body ?? ""),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      html_url?: string;
      number?: number;
      message?: string;
    };
    if (!res.ok) return { error: body.message ?? `github returned ${res.status}` };
    return { result: { url: body.html_url ?? "", number: body.number ?? 0 } };
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

/** Single-quote for POSIX sh, so a value cannot break out of the command. */
function shellArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
