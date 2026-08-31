// Worker gateway: REST agent API + channel webhooks.
//
// Routing is deliberately plain — a handful of `if`s over the path segments,
// no framework. Each route group gets its own function so the shape of a URL is
// visible at the top and the handling is separate from the matching.
import { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";
import type { AgentInstance } from "./agent-instance.js";
import type { RegistryDO } from "./registry-do.js";
import type { Env } from "./types.js";
import {
  handleChannel,
  TelegramAdapter,
  WebAdapter,
  type ChannelAdapter,
} from "./channels/index.js";
import {
  HARNESSES,
  MODELS,
  MACHINES,
  CAPABILITIES,
  DEFAULT_MACHINE,
  HARNESS_MODELS,
  estimateMonthCost,
} from "./catalog.js";
import { checkCompatible, defaultSpec, IncompatibleSpec } from "./harnesses/index.js";
import { toText, type Part } from "./parts.js";

export { AgentInstance } from "./agent-instance.js";
export { RegistryDO } from "./registry-do.js";

/**
 * The agent's container, one class per machine tier.
 *
 * A container class carries a fixed `instance_type`, so offering real hardware
 * choices means one class per tier rather than one class configured per
 * request. They differ only in which wrangler.jsonc entry names them; the
 * image and behaviour are identical.
 *
 * `sleepAfter` is short because a running container holds a slot against
 * `max_instances` whether or not its agent is still in use, and deleting an
 * agent does not reclaim it. Sleeping when idle returns the slot on its own;
 * the next message pays a cold start instead of waiting for a free slot.
 */
class TieredSandbox extends CloudflareSandbox {
  sleepAfter = "5m";
}

export class SandboxSmall extends TieredSandbox {}
export class SandboxMedium extends TieredSandbox {}
export class SandboxLarge extends TieredSandbox {}

const CHANNELS: Record<string, ChannelAdapter> = {
  telegram: new TelegramAdapter(),
  web: new WebAdapter(),
};

// Stub types come from the Durable Object classes themselves, so a method
// signature can never drift from a hand-written copy of it here.
//
// runTool is the exception: its result is arbitrary JSON from a capability, and
// RPC's serialization types narrow that to `never`. Overriding just that one
// method keeps the rest of the class as the source of truth.
type AgentStub = Omit<DurableObjectStub<AgentInstance>, "runTool"> & {
  runTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ result?: unknown; error?: string }>;
};
type RegistryStub = DurableObjectStub<RegistryDO>;

const agentStub = (env: Env, id: string): AgentStub =>
  env.AGENT.get(env.AGENT.idFromName(id)) as AgentStub;

const registry = (env: Env): RegistryStub =>
  env.REGISTRY.get(env.REGISTRY.idFromName("global")) as RegistryStub;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const bodyOf = <T>(request: Request) => request.json().catch(() => ({})) as Promise<T>;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const [first, second, third, fourth] = url.pathname.split("/").filter(Boolean);

    if (url.pathname === "/") {
      // No landing page, so the agent list is the front door.
      return Response.redirect(new URL("/agents/", url).toString(), 302);
    }
    if (first === "catalog") return catalogRoute(env);
    if (first === "api" && second === "launch" && request.method === "POST") {
      return launchRoute(request, env);
    }
    if (first === "api" && second === "agents" && request.method === "GET") {
      return listAgentsRoute(env);
    }
    if (first === "channels" && second) return channelRoute(request, env, second);

    if (first === "agents" && second) {
      // DELETE /agents/:id wipes the agent. The segment count matters: without
      // it, DELETE /agents/:id/schedule would match here and destroy the agent
      // instead of clearing its standing task.
      const isAgentItself = third === undefined;
      if (isAgentItself && request.method === "DELETE") return deleteAgentRoute(env, second);
      return agentRoute(request, env, { id: second, action: third ?? "send", arg: fourth });
    }

    return env.ASSETS.fetch(request); // static assets
  },
} satisfies ExportedHandler<Env>;

// --- what an agent can be built from -----------------------------------------
function catalogRoute(env: Env): Response {
  const entries = (m: Record<string, { desc: string; ready: boolean }>) =>
    Object.entries(m).map(([id, v]) => ({ id, ...v }));
  return json({
    harnesses: entries(HARNESSES),
    models: Object.values(MODELS),
    capabilities: entries(CAPABILITIES),
    machines: Object.entries(MACHINES).map(([id, m]) => ({ id, ...m })),
    defaultMachine: DEFAULT_MACHINE,
    // Which models each harness can actually drive, so the builder never
    // offers a pairing that would 404 at run time.
    harnessModels: HARNESS_MODELS,
  });
}

// --- create an agent from a spec, after checking the pieces fit --------------
async function launchRoute(request: Request, env: Env): Promise<Response> {
  const body = await bodyOf<{
    id?: string;
    harness?: string;
    model?: string;
    capabilities?: string[];
    machine?: string;
    system?: string;
  }>(request);

  const spec = defaultSpec({
    harness: body.harness,
    model: body.model,
    capabilities: body.capabilities ?? [],
    machine: body.machine,
    system: body.system,
  });
  try {
    checkCompatible(spec);
  } catch (e) {
    return json({ error: e instanceof IncompatibleSpec ? e.message : String(e) }, 400);
  }

  const id = body.id || `agent-${crypto.randomUUID().slice(0, 8)}`;
  await agentStub(env, id).configure(spec);
  await registry(env).register({
    id,
    model: spec.model,
    harness: spec.harness,
    machine: spec.machine,
    createdAt: Date.now(),
  });
  return json({ id, spec, estMonthly: estimateMonthCost(spec.machine) });
}

// --- dashboard listing: registry records plus each agent's live status -------
async function listAgentsRoute(env: Env): Promise<Response> {
  const records = await registry(env).list();
  const withStatus = await Promise.all(
    records.map(async (r) => ({ ...r, ...(await agentStub(env, r.id).status()) })),
  );
  return json(withStatus);
}

async function deleteAgentRoute(env: Env, id: string): Promise<Response> {
  await agentStub(env, id).wipe();
  await registry(env).remove(id);
  return json({ ok: true, deleted: id });
}

// --- inbound webhooks: /channels/:name/:agentId ------------------------------
async function channelRoute(request: Request, env: Env, name: string): Promise<Response> {
  const adapter = CHANNELS[name];
  if (!adapter) return new Response("unknown channel", { status: 404 });

  try {
    return await handleChannel(adapter, request, env);
  } catch (e) {
    return json({ error: String(e) }, 400);
  }
}

// --- REST agent API: /agents/:id/:action[/:arg] ------------------------------
async function agentRoute(
  request: Request,
  env: Env,
  route: { id: string; action: string; arg?: string },
): Promise<Response> {
  const agent = agentStub(env, route.id);
  try {
    switch (route.action) {
      case "send": {
        // Accept either { text } or AgentSky-style { parts: [...] }.
        const body = await bodyOf<{ text?: string; parts?: Part[]; channel?: string }>(request);
        const text = body.parts ? toText(body.parts) : (body.text ?? "");
        const out = await agent.send(text, body.channel);
        return json({ reply: out.reply });
      }

      case "history":
        return json(await agent.getHistory());
      case "status":
        return json(await agent.status());
      case "snapshot":
        return json(await agent.snapshot());
      case "configure":
        return json(await agent.configure(await bodyOf(request)));

      case "restore":
        await agent.restore(await bodyOf(request));
        return json({ ok: true });
      case "wake":
        await agent.fireWakeup();
        return json({ ok: true });

      case "schedule":
        return scheduleRoute(request, agent);

      case "agents-md": {
        if (request.method === "GET") return json(await agent.getAgentsMd());
        if (request.method === "DELETE") return json(await agent.setAgentsMd(null));
        const { content } = await bodyOf<{ content?: string }>(request);
        return json(await agent.setAgentsMd(content ?? null));
      }

      case "a2a": {
        // Agent-to-agent: `from` sends `text` to this agent.
        const { from, text } = await bodyOf<{ from: string; text: string }>(request);
        const out = await agent.send(`[from agent ${from}] ${text}`, "a2a");
        return json({ from, to: route.id, reply: out.reply });
      }

      case "tool": {
        if (!route.arg) return new Response("tool name required", { status: 400 });
        const out = await agent.runTool(route.arg, await bodyOf(request));
        return out.error ? json({ error: out.error }, 400) : json({ result: out.result });
      }

      default:
        return new Response("unknown action", { status: 404 });
    }
  } catch (e) {
    return json({ error: String(e) }, 400);
  }
}

/** The standing task: GET reads it, DELETE clears it, POST sets it. */
async function scheduleRoute(request: Request, agent: AgentStub): Promise<Response> {
  if (request.method === "GET") return json(await agent.getSchedule());
  if (request.method === "DELETE") {
    await agent.unschedule();
    return json({ ok: true });
  }

  const { atMs, prompt, cadenceMs } = await bodyOf<{
    atMs?: number;
    prompt?: string;
    cadenceMs?: number;
  }>(request);
  if (!prompt) return json({ error: "prompt required" }, 400);

  // Default to one cadence from now, so callers can post { prompt, cadenceMs }
  // without computing a timestamp themselves.
  await agent.scheduleWakeup(atMs ?? Date.now() + (cadenceMs ?? 60_000), prompt, cadenceMs);
  return json(await agent.getSchedule());
}
