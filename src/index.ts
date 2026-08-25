// Worker gateway: REST agent API + channel webhooks.
import type { Env } from "./types.js";
import {
  handleChannel,
  TelegramAdapter,
  DiscordAdapter,
  SlackAdapter,
  WhatsAppAdapter,
  WebAdapter,
  type ChannelAdapter,
} from "./channels/index.js";
import {
  HARNESSES,
  MODELS,
  MACHINES,
  CAPABILITIES,
  DEFAULT_MACHINE,
  estimateMonthCost,
} from "./catalog.js";
import { checkCompatible, defaultSpec, IncompatibleSpec } from "./harnesses/index.js";
import { toText } from "./parts.js";
export { AgentInstance } from "./agent-instance.js";
export { RegistryDO } from "./registry-do.js";

function registry(env: Env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("global")) as unknown as {
    register(rec: {
      id: string;
      model: string;
      harness: string;
      machine: string;
      createdAt: number;
    }): Promise<void>;
    list(): Promise<
      { id: string; model: string; harness: string; machine: string; createdAt: number }[]
    >;
    remove(id: string): Promise<void>;
  };
}

const CHANNELS: Record<string, ChannelAdapter> = {
  telegram: new TelegramAdapter(),
  discord: new DiscordAdapter(),
  slack: new SlackAdapter(),
  whatsapp: new WhatsAppAdapter(),
  web: new WebAdapter(),
};

function agentStub(env: Env, id: string) {
  return env.AGENT.get(env.AGENT.idFromName(id)) as unknown as {
    send(t: string, c?: string): Promise<{ reply?: string; parked?: boolean }>;
    getHistory(): Promise<unknown>;
    park(): Promise<void>;
    unpark(): Promise<void>;
    status(): Promise<unknown>;
    configure(s: unknown): Promise<unknown>;
    snapshot(): Promise<unknown>;
    restore(s: unknown): Promise<void>;
    scheduleWakeup(atMs: number, prompt: string, cadenceMs?: number): Promise<void>;
    fireWakeup(): Promise<void>;
    runTool(
      name: string,
      input: Record<string, unknown>,
    ): Promise<{ result?: unknown; error?: string }>;
    wipe(): Promise<void>;
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // --- root: no landing page, so the agent list is the front door ---
    if (url.pathname === "/") {
      return Response.redirect(new URL("/agents/", url).toString(), 302);
    }

    // --- catalog for the builder UI ---
    if (parts[0] === "catalog") {
      return Response.json({
        harnesses: Object.entries(HARNESSES).map(([id, h]) => ({ id, ...h })),
        models: Object.values(MODELS),
        capabilities: Object.entries(CAPABILITIES).map(([id, c]) => ({ id, ...c })),
        machines: Object.entries(MACHINES).map(([id, m]) => ({ id, ...m })),
        defaultMachine: DEFAULT_MACHINE,
      });
    }

    // --- launch (compatibility check + configure) from the builder UI ---
    if (parts[0] === "api" && parts[1] === "launch" && request.method === "POST") {
      const body = (await request.json()) as {
        id?: string;
        harness?: string;
        model?: string;
        capabilities?: string[];
        machine?: string;
        system?: string;
      };
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
        const msg = e instanceof IncompatibleSpec ? e.message : String(e);
        return Response.json({ error: msg }, { status: 400 });
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
      return Response.json({ id, spec, estMonthly: estimateMonthCost(spec.machine) });
    }

    // --- channel webhooks: /channels/:name/:agentId ---
    if (parts[0] === "channels" && parts[1]) {
      const adapter = CHANNELS[parts[1]];
      if (!adapter) return new Response("unknown channel", { status: 404 });

      // Verification handshakes that must answer before normal parsing.
      if (parts[1] === "slack") {
        const body = (await request.clone().json().catch(() => ({}))) as {
          type?: string;
          challenge?: string;
        };
        if (body.type === "url_verification") return Response.json({ challenge: body.challenge });
      }
      if (parts[1] === "discord") {
        const body = (await request.clone().json().catch(() => ({}))) as { type?: number };
        if (body.type === 1) return Response.json({ type: 1 }); // PONG
      }
      try {
        return await handleChannel(adapter, request, env);
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 400 });
      }
    }

    // --- list all agents (dashboard): GET /api/agents ---
    if (parts[0] === "api" && parts[1] === "agents" && request.method === "GET") {
      const recs = await registry(env).list();
      const withStatus = await Promise.all(
        recs.map(async (r) => {
          const st = (await agentStub(env, r.id).status()) as { parked: boolean };
          return { ...r, parked: st.parked };
        }),
      );
      return Response.json(withStatus);
    }

    // --- delete an agent: DELETE /agents/:id (wipe state + drop from registry) ---
    if (parts[0] === "agents" && parts[1] && request.method === "DELETE") {
      await agentStub(env, parts[1]).wipe();
      await registry(env).remove(parts[1]);
      return Response.json({ ok: true, deleted: parts[1] });
    }

    // --- REST agent API: /agents/:id/:action ---
    if (parts[0] === "agents" && parts[1]) {
      const stub = agentStub(env, parts[1]);
      const action = parts[2] ?? "send";
      try {
        switch (action) {
          case "send": {
            // Accept either { text } or AgentSky-style { parts: [...] }.
            const body = (await request.json()) as {
              text?: string;
              parts?: import("./parts.js").Part[];
              channel?: string;
            };
            const text = body.parts ? toText(body.parts) : (body.text ?? "");
            const out = await stub.send(text, body.channel);
            if (out.parked) return Response.json({ error: "agent is parked", parked: true }, { status: 409 });
            return Response.json({ reply: out.reply });
          }
          case "history":
            return Response.json(await stub.getHistory());
          case "status":
            return Response.json(await stub.status());
          case "snapshot":
            return Response.json(await stub.snapshot());
          case "restore":
            await stub.restore(await request.json());
            return Response.json({ ok: true });
          case "park":
            await stub.park();
            return Response.json({ ok: true });
          case "unpark":
            await stub.unpark();
            return Response.json({ ok: true });
          case "configure":
            return Response.json(await stub.configure(await request.json()));
          case "schedule": {
            const { atMs, prompt, cadenceMs } = (await request.json()) as {
              atMs: number;
              prompt: string;
              cadenceMs?: number;
            };
            await stub.scheduleWakeup(atMs, prompt, cadenceMs);
            return Response.json({ ok: true });
          }
          case "wake":
            await stub.fireWakeup();
            return Response.json({ ok: true });
          case "a2a": {
            // Agent-to-agent: `from` agent sends `text` to this agent (parts[1]).
            const { from, text } = (await request.json()) as { from: string; text: string };
            const out = await stub.send(`[from agent ${from}] ${text}`, "a2a");
            if (out.parked) return Response.json({ error: "target agent parked", parked: true }, { status: 409 });
            return Response.json({ from, to: parts[1], reply: out.reply });
          }
          case "tool": {
            const name = parts[3];
            if (!name) return new Response("tool name required", { status: 400 });
            const input = (await request.json().catch(() => ({}))) as Record<string, unknown>;
            const out = await stub.runTool(name, input);
            if (out.error) return Response.json({ error: out.error }, { status: 400 });
            return Response.json({ result: out.result });
          }
          default:
            return new Response("unknown action", { status: 404 });
        }
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 400 });
      }
    }

    // Everything else -> static assets (landing page at /).
    return env.ASSETS.fetch(request);
  },
};
