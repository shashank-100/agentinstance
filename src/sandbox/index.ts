// Code execution for agents. A Worker cannot spawn processes, so commands run
// in a container attached to the agent's own Durable Object.
//
// The Sandbox interface stays deliberately small — exec, readFile, writeFile —
// so a different backend can be dropped in without touching the harnesses.
import type { Env } from "../types.js";
import { MACHINES, DEFAULT_MACHINE } from "../catalog.js";
import {
  getSandbox as getCloudflareSandbox,
  type Sandbox as CfSandbox,
} from "@cloudflare/sandbox";

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
  /** Shut the container down and release its slot. */
  destroy(agentId: string): Promise<void>;
}

/**
 * ContainerSandbox — a Cloudflare Container attached to its own Durable Object.
 * Unlike HttpSandbox there is no public endpoint: the Worker reaches the
 * container through a binding, so nothing is addressable from the internet.
 * One sandbox per agentId, matching how agent memory is addressed.
 */
export class ContainerSandbox implements Sandbox {
  name = "container";
  constructor(private ns: DurableObjectNamespace<CfSandbox>) {}

  private box(agentId: string) {
    // A DO id stringifies to 64 hex chars, one over the SDK's 63-char cap.
    // Trim rather than hash: the id is already unique well inside 63 chars,
    // and keeping the prefix stable keeps one workspace per agent.
    return getCloudflareSandbox(this.ns, agentId.slice(0, 63));
  }

  async exec(agentId: string, command: string): Promise<ExecResult> {
    const r = await this.box(agentId).exec(command);
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.exitCode ?? 0,
      success: r.exitCode === 0,
    };
  }

  async writeFile(agentId: string, path: string, content: string): Promise<void> {
    await this.box(agentId).writeFile(path, content);
  }

  async readFile(agentId: string, path: string): Promise<string> {
    const r = await this.box(agentId).readFile(path);
    return typeof r === "string" ? r : (r?.content ?? "");
  }

  async destroy(agentId: string): Promise<void> {
    await this.box(agentId).destroy();
  }
}

/**
 * The agent's sandbox for a given machine tier, or null when that tier's
 * container is not bound.
 *
 * The tier selects which container class the agent runs on, and each class is
 * pinned to one Cloudflare instance type. Routing here is what gives the
 * machine picker real effect — the same agent id on a different tier is a
 * different container, with its own CPU and memory.
 */
export function getSandbox(env: Env, machine: string = DEFAULT_MACHINE): Sandbox | null {
  const tier = MACHINES[machine] ?? MACHINES[DEFAULT_MACHINE];
  const ns = (env as unknown as Record<string, DurableObjectNamespace<CfSandbox> | undefined>)[
    tier.binding
  ];
  return ns ? new ContainerSandbox(ns) : null;
}
