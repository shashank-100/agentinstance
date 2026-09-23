import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { sendToAgent, type OutputRow } from "@/lib/api";
import { Button } from "@/components/ui/button";

/**
 * A task as a conversation.
 *
 * A dispatch is the first message, not a one-shot job. The agent keeps its
 * history and its checkout between turns, so "also handle unicode" continues
 * the same run in the same container — which is why direction belongs here
 * rather than in a second task filed against the same repo.
 *
 * The turns are the spine and the CLI output is folded in beside them: what
 * the agent *said* is short and worth reading, what it *printed* is long and
 * worth having. Splitting them across tabs meant the interesting middle of a
 * run — cloned, edited, ran the tests — lived somewhere you had to go looking.
 */
export function Conversation({
  agentId,
  messages,
  output,
  live,
}: {
  agentId: string | null;
  messages: { role: string; content: string; ts: number }[];
  output: OutputRow[];
  live: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const queryClient = useQueryClient();

  const send = () => {
    const text = draft.trim();
    if (!text || !agentId) return;
    setSending(true);
    setDraft("");
    sendToAgent(agentId, text)
      .then(() => {
        // The reply is already in the agent's history; refetching shows it in
        // place rather than appending a second copy from the response.
        void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
        void queryClient.invalidateQueries({ queryKey: ["fleet"] });
      })
      .catch((e: Error) => {
        toast.error("The agent did not take that", { description: e.message });
        // Hand the text back rather than losing it to a failed request.
        setDraft(text);
      })
      .finally(() => setSending(false));
  };

  return (
    <div className="flex min-h-0 flex-col rounded-md border border-border bg-surface">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 && output.length === 0 && (
          <p className="p-4 font-mono text-[11.5px] text-muted-foreground">
            {agentId ? "Nothing yet — the agent is starting." : "No agent has claimed this task."}
          </p>
        )}

        {messages.map((m, i) => (
          <div key={i} className="border-b border-border/40 px-4 py-3 last:border-0">
            <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {m.role === "user" ? "you" : agentId}
              <span className="ml-2 opacity-60">{new Date(m.ts).toISOString().slice(11, 16)}</span>
            </p>
            <p
              className={cn(
                "whitespace-pre-wrap break-words text-[13px] leading-relaxed",
                m.role === "user" ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {m.content}
            </p>

            {/* The CLI output belongs to the turn that produced it, so it sits
                under the first agent reply rather than in a tab of its own. */}
            {i === messages.findIndex((x) => x.role !== "user") && output.length > 0 && (
              <details className="mt-2" open={live}>
                <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground">
                  terminal · {output.length} chunk{output.length === 1 ? "" : "s"}
                </summary>
                <pre className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-2.5 font-mono text-[11px] leading-5 text-muted-foreground">
                  {output.map((r) => r.text).join("")}
                </pre>
              </details>
            )}
          </div>
        ))}

        {live && (
          <p className="flex items-center gap-2 px-4 py-3 font-mono text-[11px] text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-info" />
            working…
          </p>
        )}
      </div>

      {/* Direction, not a chat box for its own sake: a settled task can still
          take a follow-up, because the agent kept its history and its
          checkout. Disabled only when there is no agent to talk to. */}
      <div className="shrink-0 border-t border-border p-2.5">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          disabled={!agentId || sending}
          placeholder={
            agentId ? "Ask for a change — ⌘↵ to send" : "No agent has claimed this task yet"
          }
          className="w-full resize-none rounded border border-border bg-background px-2.5 py-2 font-mono text-[12px] leading-5 placeholder:text-muted-foreground/70 focus:border-border-strong focus:outline-none disabled:opacity-50"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="font-mono text-[10px] text-muted-foreground">
            {sending ? "the agent is working — this can take a minute" : ""}
          </span>
          <Button size="sm" disabled={!draft.trim() || !agentId || sending} onClick={send}>
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}
