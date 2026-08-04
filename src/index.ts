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
export { AgentDO } from "./agent-do.js";

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
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

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

    // --- REST agent API: /agents/:id/:action ---
    if (parts[0] === "agents" && parts[1]) {
      const stub = agentStub(env, parts[1]);
      const action = parts[2] ?? "send";
      try {
        switch (action) {
          case "send": {
            const { text, channel } = (await request.json()) as { text: string; channel?: string };
            const out = await stub.send(text, channel);
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
