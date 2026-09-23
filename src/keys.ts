// Provider keys a user enters from the cockpit, rather than through
// `wrangler secret put`.
//
// They live in the registry, which is one per deployment, so a key saved
// once applies to every agent. A saved key overrides a secret with the same
// name: whoever pasted it into the cockpit most recently meant it.
import type { Env } from "./types.js";
import type { RegistryDO } from "./registry-do.js";

/** Keys that can be set from the cockpit. Only Anthropic's for now. */
export const SETTABLE_KEYS = ["ANTHROPIC_API_KEY"] as const;
export type SettableKey = (typeof SETTABLE_KEYS)[number];

const registry = (env: Env) =>
  env.REGISTRY.get(env.REGISTRY.idFromName("global")) as unknown as DurableObjectStub<RegistryDO>;

/** The saved keys, keyed by env var name. */
export const storedKeys = (env: Env): Promise<Record<string, string>> =>
  registry(env).storedKeys();

export const setStoredKey = (env: Env, name: SettableKey, value: string | null): Promise<void> =>
  registry(env).setKey(name, value);

/** `env` with saved keys laid over it: what every readiness check and every
 *  agent run should see. */
export async function withStoredKeys<E extends Env>(env: E): Promise<E> {
  const stored = await storedKeys(env);
  return { ...env, ...stored };
}

/**
 * Check a key with Anthropic before saving it.
 *
 * A bad key otherwise saves fine and fails minutes later, inside a VM, as
 * an error from the CLI. Only an explicit refusal counts as bad. If
 * Anthropic can't be reached, the key is given the benefit of the doubt.
 */
export async function anthropicRejects(key: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    return res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}
