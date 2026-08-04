// Feature #4 — pluggable harnesses + 3-piece AgentSpec with compatibility check.
import type { Message } from "../types.js";
import type { Model } from "../models/index.js";
import { CAPABILITIES, HARNESSES, MACHINES, MODELS, DEFAULT_MACHINE } from "../catalog.js";

export interface Harness {
  name: string;
  run(model: Model, history: Message[], system: string): Promise<string>;
}

// Default: one model completion per turn.
export class ChatHarness implements Harness {
  name = "chat";
  run(model: Model, history: Message[], system: string): Promise<string> {
    return model.complete(history, system);
  }
}

// Base for CLI-wrapping harnesses (claude-code, codex). Falls back to a single
// model call so composition works without the external binary.
export class CliHarness implements Harness {
  constructor(public name: string) {}
  run(model: Model, history: Message[], system: string): Promise<string> {
    return model.complete(history, system);
  }
}

export function getHarness(name: string): Harness {
  if (name === "chat") return new ChatHarness();
  if (name in HARNESSES) return new CliHarness(name);
  throw new Error(`unknown harness '${name}'`);
}

export interface AgentSpec {
  harness: string;
  model: string;
  capabilities: string[];
  machine: string;
  system: string;
}

export function defaultSpec(partial: Partial<AgentSpec> = {}): AgentSpec {
  // Drop undefined keys so they don't clobber defaults via spread.
  const clean = Object.fromEntries(
    Object.entries(partial).filter(([, v]) => v !== undefined),
  );
  return {
    harness: "chat",
    model: "claude-sonnet-4-6",
    capabilities: [],
    machine: DEFAULT_MACHINE,
    system: "You are a helpful always-on agent.",
    ...clean,
  };
}

export class IncompatibleSpec extends Error {}

export function checkCompatible(spec: AgentSpec): void {
  if (!(spec.harness in HARNESSES)) throw new IncompatibleSpec(`unknown harness '${spec.harness}'`);
  if (!(spec.model in MODELS)) throw new IncompatibleSpec(`unknown model '${spec.model}'`);
  if (!(spec.machine in MACHINES)) throw new IncompatibleSpec(`unknown machine '${spec.machine}'`);
  for (const cap of spec.capabilities) {
    if (!(cap in CAPABILITIES)) throw new IncompatibleSpec(`unknown capability '${cap}'`);
  }
  const heavy = new Set(["generate_video", "image_to_video", "browser_use"]);
  const usesHeavy = spec.capabilities.some((c) => heavy.has(c));
  if (usesHeavy && spec.machine === "1gb") {
    throw new IncompatibleSpec("video/browser capabilities require at least the 2gb machine");
  }
}
