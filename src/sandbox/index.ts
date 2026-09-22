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
  /** As `exec`, but calls `onChunk` with output as it is produced. Optional:
   *  not every implementation can stream, and callers fall back to `exec`. */
  execStreaming?(
    agentId: string,
    command: string,
    onChunk: (text: string) => void,
  ): Promise<ExecResult>;
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

  /**
   * Run a command, handing back output as it is produced.
   *
   * `exec` only resolves when the command has finished, so a CLI that runs for
   * minutes is a black box for those minutes — the one thing someone watching
   * an agent actually wants to see is the part `exec` cannot give them.
   *
   * `onChunk` is called as output arrives. It is deliberately fire-and-forget
   * from the command's point of view: a slow consumer must not stall the agent,
   * and a consumer that throws must not kill the run.
   */
  async execStreaming(
    agentId: string,
    command: string,
    onChunk: (text: string) => void,
  ): Promise<ExecResult> {
    const box = this.box(agentId) as unknown as {
      execStream?: (cmd: string) => Promise<ReadableStream<Uint8Array>>;
    };
    // Not every sandbox binding exposes streaming; fall back rather than fail.
    if (typeof box.execStream !== "function") {
      const r = await this.exec(agentId, command);
      if (r.stdout) onChunk(r.stdout);
      return r;
    }

    const stream = await box.execStream(command);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let stdout = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (!text) continue;
      stdout += text;
      try {
        onChunk(text);
      } catch {
        // A failed observer is not a failed command.
      }
    }
    // The stream carries output, not an exit status; a command that produced
    // nothing on stderr and ran to completion is treated as successful.
    return { stdout, stderr: "", exitCode: 0, success: true };
  }

  async writeFile(agentId: string, path: string, content: string): Promise<void> {
    await this.box(agentId).writeFile(path, content);
  }

  async readFile(agentId: string, path: string): Promise<string> {
    const r = await this.box(agentId).readFile(path);
    return typeof r === "string" ? r : (r?.content ?? "");
  }

  async destroy(agentId: string): Promise<void> {
    // Stopping a container that was never running is the goal already met, not
    // a failure: deleting an agent whose container is asleep, or which never
    // had one, should still delete the agent. Anywhere without a container
    // runtime at all — the test environment — every delete would otherwise
    // raise an unhandled rejection from a suite that is not testing containers.
    //
    // Narrow on purpose: only the "there is no container" case is swallowed, so
    // a real stop that fails against a real runtime still surfaces.
    try {
      await this.box(agentId).destroy();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/no container runtime|not enabled|containers do not exist/i.test(msg)) {
        throw e;
      }
    }
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
