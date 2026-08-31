// Model adapters. OpenAICompatModel talks to any
// OpenAI-shaped /chat/completions endpoint (Moonshot, DeepSeek, Z.ai, OpenAI
// itself) by swapping base_url, so adding a provider is a catalog entry plus a
// key. EchoModel needs no key and exists for offline tests.
import type { Message } from "../types.js";

/** A tool the model may call, in provider-neutral form. */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's input object. */
  parameters: Record<string, unknown>;
}

/** One tool invocation requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A turn's result: either final text, or tool calls the caller must run. */
export interface Turn {
  text: string;
  toolCalls: ToolCall[];
  /** Provider-native assistant message, echoed back verbatim on the next turn. */
  raw?: unknown;
}

export interface Model {
  name: string;
  complete(messages: Message[], system?: string): Promise<string>;
  /**
   * Tool-aware turn. Models that cannot call tools may leave this undefined;
   * callers fall back to complete().
   */
  turn?(
    messages: Message[],
    system: string | undefined,
    tools: ToolDef[],
    priorTurns?: unknown[],
  ): Promise<Turn>;
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
 * Stands in for a model the Worker never calls: a CLI harness authenticating
 * with its own subscription token drives the model itself, so there is no key
 * here to build a client from. Throwing on use keeps the "fail loudly" rule —
 * if something does try to complete through this, that is a bug, not a fallback.
 */
export class UnusedModel implements Model {
  name = "unused";
  constructor(private modelId: string) {}
  async complete(): Promise<string> {
    throw new Error(
      `'${this.modelId}' is driven by its CLI harness — the Worker cannot call it directly`,
    );
  }
}

/**
 * Any provider exposing OpenAI's /chat/completions shape. `baseUrl` selects
 * which one; `modelId` is the upstream's own name for the model.
 */
export class OpenAICompatModel implements Model {
  constructor(
    public name: string,
    private apiKey: string,
    private modelId: string,
    private baseUrl: string,
    // Reasoning models spend part of this budget on hidden reasoning tokens
    // before emitting any answer, so a small cap can return an empty message.
    private maxTokens = 10000,
  ) {}

  private body(messages: Message[], system: string | undefined, extra: object = {}) {
    const api: unknown[] = [];
    if (system) api.push({ role: "system", content: system });
    for (const m of messages) {
      if (m.role === "user" || m.role === "assistant")
        api.push({ role: m.role, content: m.content });
    }
    return { model: this.modelId, max_tokens: this.maxTokens, messages: api, ...extra };
  }

  private async post(body: object): Promise<{
    choices: {
      finish_reason?: string;
      message: {
        content?: string;
        tool_calls?: { id: string; function: { name: string; arguments: string } }[];
      };
    }[];
  }> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${this.name} ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async complete(messages: Message[], system?: string): Promise<string> {
    const data = await this.post(this.body(messages, system));
    const choice = data.choices[0];
    const content = choice?.message?.content ?? "";
    if (content) return content;
    // A reasoning model can burn the whole budget thinking and return nothing.
    // Say so plainly rather than handing back an empty string.
    if (choice?.finish_reason === "length") {
      throw new Error(
        `${this.modelId} hit the ${this.maxTokens}-token cap while reasoning and produced no answer`,
      );
    }
    return "";
  }

  async turn(
    messages: Message[],
    system: string | undefined,
    tools: ToolDef[],
    priorTurns: unknown[] = [],
  ): Promise<Turn> {
    const base = this.body(messages, system) as { messages: unknown[] };
    // Assistant tool-call messages and their tool results, in order.
    base.messages.push(...priorTurns);

    const data = await this.post({
      ...base,
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    });
    const choice = data.choices[0];
    const calls = choice?.message?.tool_calls ?? [];
    return {
      text: choice?.message?.content ?? "",
      toolCalls: calls.map((c) => ({
        id: c.id,
        name: c.function.name,
        input: safeParse(c.function.arguments),
      })),
      raw: choice?.message,
    };
  }
}

/** Tool arguments arrive as a JSON string; a malformed one must not throw. */
function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
