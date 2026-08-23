// Pluggable code-execution sandbox. The default backend is HttpSandbox, which
// talks to a SELF-HOSTABLE sandbox service (a Docker container you run anywhere)
// over a tiny HTTP API. This keeps agentinstance vendor-neutral: swap the backend
// without touching agents/harnesses.
import type { Env } from "../types.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

export interface Sandbox {
  name: string;
  /** Run a shell command in the sandbox for this agent id. */
  exec(agentId: string, command: string): Promise<ExecResult>;
  writeFile(agentId: string, path: string, content: string): Promise<void>;
  readFile(agentId: string, path: string): Promise<string>;
}

/**
 * HttpSandbox — calls a self-hosted sandbox service (see sandbox-service/).
 * Configure with SANDBOX_URL (+ optional SANDBOX_TOKEN). One workspace per
 * agentId keeps agents isolated from each other.
 */
export class HttpSandbox implements Sandbox {
  name = "http";
  constructor(
    private baseUrl: string,
    private token?: string,
  ) {}

  private headers() {
    return {
      "content-type": "application/json",
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    };
  }

  async exec(agentId: string, command: string): Promise<ExecResult> {
    const res = await fetch(`${this.baseUrl}/exec`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ workspace: agentId, command }),
    });
    if (!res.ok) throw new Error(`sandbox exec ${res.status}: ${await res.text()}`);
    return (await res.json()) as ExecResult;
  }

  async writeFile(agentId: string, path: string, content: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/files/write`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ workspace: agentId, path, content }),
    });
    if (!res.ok) throw new Error(`sandbox write ${res.status}: ${await res.text()}`);
  }

  async readFile(agentId: string, path: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/files/read`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ workspace: agentId, path }),
    });
    if (!res.ok) throw new Error(`sandbox read ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { content: string }).content;
  }
}

/** Resolve the configured sandbox backend, or null if none is set. */
export function getSandbox(env: Env): Sandbox | null {
  if (env.SANDBOX_URL) {
    return new HttpSandbox(env.SANDBOX_URL.replace(/\/$/, ""), env.SANDBOX_TOKEN);
  }
  return null;
}
