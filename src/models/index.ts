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

/**
 * MockModel — a keyless "brain" that gives believable, varied replies so the
 * whole product can be demoed without any API key. Deterministic per input so
 * tests stay stable. Swap to ClaudeModel by setting ANTHROPIC_API_KEY.
 */
export class MockModel implements Model {
  name = "mock";
  constructor(private persona = "a helpful always-on agent") {}

  async complete(messages: Message[], system?: string): Promise<string> {
    const last = [...messages].reverse().find((m) => m.role === "user");
    const text = (last?.content ?? "").trim();
    const turns = messages.filter((m) => m.role === "user").length;
    const lower = text.toLowerCase();

    if (!text) return "I'm here and listening — what would you like to do?";
    if (/^(hi|hey|hello|yo|sup)\b/.test(lower))
      return `Hey! I'm ${this.persona}. What are we working on?`;
    if (lower.includes("?")) {
      return `Good question. Here's how I'd approach "${trim(text)}": break it into steps, ` +
        `tackle the riskiest part first, then verify. Want me to go deeper on any step?`;
    }
    if (/thank|thanks|ty\b/.test(lower)) return "Anytime — what's next?";
    if (/who are you|what are you|what can you do/.test(lower))
      return `I'm ${this.persona} running on Nimbus. I keep memory across our chats, ` +
        `work across channels, and stay parked (free) when idle. (Demo mode — add an API key for a real model.)`;
    if (turns > 1)
      return `Got it, continuing from before — on "${trim(text)}", here's my take: ` +
        `let's make one concrete change, confirm it works, then iterate.`;
    return `Understood: "${trim(text)}". I'll treat that as the goal and start on it. ` +
      `Tell me if you'd rather adjust scope.`;
  }
}

function trim(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
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
