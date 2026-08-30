// Web chat. The reply rides the HTTP response (no outbound
// push needed), so `send` is a no-op and the pipeline returns { reply }.
import type { Env } from "../types.js";
import type { ChannelAdapter, Inbound } from "./index.js";

export class WebAdapter implements ChannelAdapter {
  name = "web";

  async parse(request: Request): Promise<Inbound | null> {
    const url = new URL(request.url);
    const agentId = url.pathname.split("/").filter(Boolean).pop() ?? "default";
    const body = (await request.json()) as { text?: string };
    if (!body.text) return null;
    return { agentId, text: body.text, channel: "web" };
  }

  async send(_env: Env, _to: string, _text: string, _key: string): Promise<void> {
    // Web replies synchronously via the HTTP response; nothing to push.
  }
}
