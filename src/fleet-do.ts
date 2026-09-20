// A single Durable Object holding the work queue: what has been asked for, who
// is doing it, and how it ended.
//
// This is the difference between an agent you talk to and an agent you hand a
// job to. A message is answered inside one request; a task outlives the request
// that created it, which is the only reason running an agent in the cloud beats
// running one on a laptop. Nothing here has to be running for a queued task to
// still be queued tomorrow.
//
// It lives beside RegistryDO rather than inside it: the registry answers "which
// agents exist", this answers "what is being worked on". Agent DOs cannot
// enumerate each other, so both are singletons addressed by a fixed name.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types.js";

/**
 * Where a task is in its life.
 *
 * `settled` rather than `done` because a task can finish without succeeding —
 * a PR opened and rejected is as settled as one merged, and both are over. The
 * distinction that matters operationally is "still costing money" versus "not".
 */
export type TaskState = "queued" | "running" | "settled" | "failed";

export interface Task {
  id: string;
  /** What was asked for, in the words of whoever asked. */
  goal: string;
  /** Optional: the repository this task is against. */
  repo: string | null;
  /** The branch the work lives on, once an agent has made one. */
  branch: string | null;
  /** The pull request, once there is one. */
  prUrl: string | null;
  /** Who filed it — an agent name, or a person. */
  createdBy: string | null;
  /** The agent that claimed it. Null while queued. */
  assignedTo: string | null;
  state: TaskState;
  /** What the agent reported back, or why it failed. */
  result: string | null;
  createdAt: number;
  updatedAt: number;
}

export class FleetDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          goal TEXT NOT NULL,
          repo TEXT,
          branch TEXT,
          prUrl TEXT,
          createdBy TEXT,
          assignedTo TEXT,
          state TEXT NOT NULL,
          result TEXT,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        );
        -- Claiming reads the oldest queued row on every call, which is the
        -- hot path once more than a couple of agents are working.
        CREATE INDEX IF NOT EXISTS tasks_by_state ON tasks (state, createdAt);
      `);
    });
  }

  /** File a task. It sits in `queued` until an agent claims it. */
  async enqueue(input: {
    goal: string;
    repo?: string | null;
    createdBy?: string | null;
  }): Promise<Task> {
    const now = Date.now();
    const task: Task = {
      id: crypto.randomUUID().slice(0, 8),
      goal: input.goal,
      repo: input.repo ?? null,
      branch: null,
      prUrl: null,
      createdBy: input.createdBy ?? null,
      assignedTo: null,
      state: "queued",
      result: null,
      createdAt: now,
      updatedAt: now,
    };
    this.sql.exec(
      "INSERT INTO tasks (id,goal,repo,branch,prUrl,createdBy,assignedTo,state,result,createdAt,updatedAt) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      task.id,
      task.goal,
      task.repo,
      task.branch,
      task.prUrl,
      task.createdBy,
      task.assignedTo,
      task.state,
      task.result,
      task.createdAt,
      task.updatedAt,
    );
    return task;
  }

  /**
   * Take the oldest queued task, or null when there is nothing to do.
   *
   * Read and write happen in one call on purpose. A DO is single-threaded, so
   * nothing can interleave between the SELECT and the UPDATE — which is what
   * stops two agents claiming the same task without a lock or a transaction.
   * Splitting this into `peek` then `take` would reintroduce exactly the race
   * the platform is handing us for free.
   */
  async claim(agentId: string): Promise<Task | null> {
    const row = this.sql
      .exec("SELECT id FROM tasks WHERE state = 'queued' ORDER BY createdAt ASC LIMIT 1")
      .toArray()[0] as { id: string } | undefined;
    if (!row) return null;

    this.sql.exec(
      "UPDATE tasks SET state='running', assignedTo=?, updatedAt=? WHERE id=?",
      agentId,
      Date.now(),
      row.id,
    );
    return this.get(row.id);
  }

  /** Record progress without ending the task — a branch, or a PR. */
  async update(
    id: string,
    patch: { branch?: string | null; prUrl?: string | null; repo?: string | null },
  ): Promise<Task | null> {
    const task = await this.get(id);
    if (!task) return null;
    this.sql.exec(
      "UPDATE tasks SET branch=?, prUrl=?, repo=?, updatedAt=? WHERE id=?",
      patch.branch !== undefined ? patch.branch : task.branch,
      patch.prUrl !== undefined ? patch.prUrl : task.prUrl,
      patch.repo !== undefined ? patch.repo : task.repo,
      Date.now(),
      id,
    );
    return this.get(id);
  }

  /** The work is over and it went well enough to report. */
  async settle(id: string, result: string): Promise<Task | null> {
    return this.finish(id, "settled", result);
  }

  /** The work is over and it did not go well. */
  async fail(id: string, reason: string): Promise<Task | null> {
    return this.finish(id, "failed", reason);
  }

  private async finish(id: string, state: TaskState, result: string): Promise<Task | null> {
    if (!(await this.get(id))) return null;
    this.sql.exec(
      "UPDATE tasks SET state=?, result=?, updatedAt=? WHERE id=?",
      state,
      result,
      Date.now(),
      id,
    );
    return this.get(id);
  }

  async get(id: string): Promise<Task | null> {
    const row = this.sql.exec("SELECT * FROM tasks WHERE id = ?", id).toArray()[0];
    return (row as unknown as Task) ?? null;
  }

  /** Newest first, optionally narrowed to one state. */
  async list(state?: TaskState): Promise<Task[]> {
    const rows = state
      ? this.sql
          .exec("SELECT * FROM tasks WHERE state = ? ORDER BY createdAt DESC", state)
          .toArray()
      : this.sql.exec("SELECT * FROM tasks ORDER BY createdAt DESC").toArray();
    return rows as unknown as Task[];
  }

  /** Counts per state, for a dashboard that wants the shape of the queue. */
  async stats(): Promise<Record<TaskState, number> & { total: number }> {
    const rows = this.sql
      .exec("SELECT state, COUNT(*) AS n FROM tasks GROUP BY state")
      .toArray() as unknown as { state: TaskState; n: number }[];
    const out = { queued: 0, running: 0, settled: 0, failed: 0, total: 0 };
    for (const r of rows) {
      out[r.state] = Number(r.n);
      out.total += Number(r.n);
    }
    return out;
  }

  /** Drop a task outright. */
  async remove(id: string): Promise<{ ok: boolean }> {
    if (!(await this.get(id))) return { ok: false };
    this.sql.exec("DELETE FROM tasks WHERE id = ?", id);
    return { ok: true };
  }

  /**
   * Put a task back in the queue.
   *
   * A container is discarded when it sleeps, so an agent that claimed a task
   * and then went idle leaves it `running` forever with nothing working on it.
   * Releasing it is how that work gets picked up again rather than being lost
   * silently — the one failure mode a queue exists to prevent.
   */
  async release(id: string): Promise<Task | null> {
    const task = await this.get(id);
    if (!task || task.state !== "running") return null;
    this.sql.exec(
      "UPDATE tasks SET state='queued', assignedTo=NULL, updatedAt=? WHERE id=?",
      Date.now(),
      id,
    );
    return this.get(id);
  }
}
