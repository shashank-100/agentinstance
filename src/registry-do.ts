// A single registry Durable Object that records every agent created, so the
// dashboard can list them (individual agent DOs can't enumerate each other).
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types.js";

export interface AgentRecord {
  id: string;
  model: string;
  harness: string;
  machine: string;
  createdAt: number;
}

export class RegistryDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          model TEXT NOT NULL,
          harness TEXT NOT NULL,
          machine TEXT NOT NULL,
          createdAt INTEGER NOT NULL
        )
      `);
    });
  }

  async register(rec: AgentRecord): Promise<void> {
    this.sql.exec(
      "INSERT INTO agents (id,model,harness,machine,createdAt) VALUES (?,?,?,?,?) " +
        "ON CONFLICT(id) DO UPDATE SET model=excluded.model, harness=excluded.harness, machine=excluded.machine",
      rec.id,
      rec.model,
      rec.harness,
      rec.machine,
      rec.createdAt,
    );
  }

  async list(): Promise<AgentRecord[]> {
    return this.sql
      .exec("SELECT id,model,harness,machine,createdAt FROM agents ORDER BY createdAt DESC")
      .toArray() as unknown as AgentRecord[];
  }

  async remove(id: string): Promise<void> {
    this.sql.exec("DELETE FROM agents WHERE id = ?", id);
  }
}
