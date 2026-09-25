// Provider keys a user enters from the board, rather than through
// `wrangler secret put`.
//
// They live in the registry, and a registry belongs to one person
// (`registryName`), so a key is that person's own: their agents run on it and
// nobody else's do. A saved key overrides a secret with the same name, because
// whoever pasted it into the board most recently meant it.
//
// That scoping is what makes an open deployment affordable. Without it every
// signed-up stranger runs on whatever the deployment itself holds — a
// subscription token or an ANTHROPIC_API_KEY belonging to the person who
// deployed it.
import type { Env } from "./types.js";
import type { RegistryDO } from "./registry-do.js";
import { DEPLOYMENT, registryName } from "./scope.js";

/** Keys that can be set from the board. Only Anthropic's for now. */
export const SETTABLE_KEYS = ["ANTHROPIC_API_KEY"] as const;
export type SettableKey = (typeof SETTABLE_KEYS)[number];

const registry = (env: Env, owner: string) =>
  env.REGISTRY.get(
    env.REGISTRY.idFromName(registryName(owner)),
  ) as unknown as DurableObjectStub<RegistryDO>;

/**
 * The saved keys for one owner.
 *
 * `DEPLOYMENT` resolves to the same `"global"` registry it always did, so the
 * deployer's existing key keeps working untouched.
 */
export const storedKeys = (env: Env, owner: string = DEPLOYMENT): Promise<Record<string, string>> =>
  registry(env, owner).storedKeys();

export const setStoredKey = (
  env: Env,
  name: SettableKey,
  value: string | null,
  owner: string = DEPLOYMENT,
): Promise<void> => registry(env, owner).setKey(name, value);

/**
 * `env` with this owner's saved keys laid over it: what every readiness check
 * and every agent run should see.
 *
 * On a deployment that requires people to bring their own key (`BYOK`), the
 * deployment's own model credentials are stripped first — otherwise a user who
 * has saved nothing silently runs on whoever deployed it, which is the whole
 * thing BYOK exists to prevent.
 */
export async function withStoredKeys<E extends Env>(
  env: E,
  owner: string = DEPLOYMENT,
): Promise<E> {
  const base =
    env.BYOK && owner !== DEPLOYMENT
      ? { ...env, ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined }
      : env;
  const stored = await storedKeys(env, owner);
  return { ...base, ...stored };
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
