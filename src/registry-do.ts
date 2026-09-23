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
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS keys (
          name TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
    });
  }

  /** Provider keys entered from the board, by env var name. */
  async storedKeys(): Promise<Record<string, string>> {
    const rows = this.sql.exec("SELECT name, value FROM keys").toArray() as {
      name: string;
      value: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.name, r.value]));
  }

  /** Save a key, or remove it with null. */
  async setKey(name: string, value: string | null): Promise<void> {
    if (value === null) {
      this.sql.exec("DELETE FROM keys WHERE name = ?", name);
    } else {
      this.sql.exec(
        "INSERT INTO keys (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
        name,
        value,
      );
    }
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
