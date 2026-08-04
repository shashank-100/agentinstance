// Worker gateway. Feature #6 (REST) fleshes this out; a minimal router lives
// here so the DO is reachable and testable now.
import type { Env } from "./types.js";
export { AgentDO } from "./agent-do.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Routes: /agents/:id/(send|history|park|unpark|status|configure)
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "agents" && parts[1]) {
      const stub = env.AGENT.get(env.AGENT.idFromName(parts[1])) as unknown as {
        send(t: string, c?: string): Promise<string>;
        getHistory(): Promise<unknown>;
        park(): Promise<void>;
        unpark(): Promise<void>;
        status(): Promise<unknown>;
        configure(s: unknown): Promise<unknown>;
      };
      const action = parts[2] ?? "send";
      try {
        switch (action) {
          case "send": {
            const { text, channel } = (await request.json()) as {
              text: string;
              channel?: string;
            };
            return Response.json({ reply: await stub.send(text, channel) });
          }
          case "history":
            return Response.json(await stub.getHistory());
          case "status":
            return Response.json(await stub.status());
          case "park":
            await stub.park();
            return Response.json({ ok: true });
          case "unpark":
            await stub.unpark();
            return Response.json({ ok: true });
          case "configure":
            return Response.json(await stub.configure(await request.json()));
        }
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 400 });
      }
    }
    return new Response("Perch — always-on agents. POST /agents/:id/send", { status: 200 });
  },
};
