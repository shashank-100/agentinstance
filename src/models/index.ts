// Feature #3 — pluggable model adapters. Claude default. Backends lazy-call
// their HTTP APIs; the Echo backend needs no key so the DO runs offline/in tests.
import type { Message } from "../types.js";

export interface Model {
  name: string;
  complete(messages: Message[], system?: string): Promise<string>;
}

export class EchoModel implements Model {
  name = "echo";
  async complete(messages: Message[]): Promise<string> {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return `echo: ${messages[i].content}`;
    }
    return "echo: (no user message)";
  }
}

export class ClaudeModel implements Model {
  name = "claude";
  constructor(
    private apiKey: string,
    private modelId = "claude-sonnet-4-6",
    private maxTokens = 1024,
  ) {}

  async complete(messages: Message[], system?: string): Promise<string> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.modelId,
        max_tokens: this.maxTokens,
        system: system ?? "You are a helpful always-on agent.",
        messages: messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    return data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }
}

export class OpenAIModel implements Model {
  name = "openai";
  constructor(
    private apiKey: string,
    private modelId = "gpt-4o",
    private baseUrl = "https://api.openai.com/v1",
    private maxTokens = 1024,
  ) {}

  async complete(messages: Message[], system?: string): Promise<string> {
    const api: { role: string; content: string }[] = [];
    if (system) api.push({ role: "system", content: system });
    for (const m of messages) {
      if (m.role === "user" || m.role === "assistant")
        api.push({ role: m.role, content: m.content });
    }
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: this.modelId, max_tokens: this.maxTokens, messages: api }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message?.content ?? "";
  }
}
