import { useEffect, useState } from "react";
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
  taskPrompt,
  result,
}: {
  agentId: string | null;
  messages: { role: string; content: string; ts: number }[];
  output: OutputRow[];
  live: boolean;
  taskPrompt?: string;
  result?: string;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!sending || !agentId) return;
    const polling = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
    }, 2000);
    return () => clearInterval(polling);
  }, [sending, agentId, queryClient]);


  const send = () => {
    const text = draft.trim();
    if (!text || !agentId || sending) return;
    setSending(true);
    void queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
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
    <div className="flex min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 && output.length === 0 && (
          <p className="p-4 font-mono text-[11.5px] text-muted-foreground">
            {agentId ? "Nothing yet — the agent is starting." : "No agent has claimed this task."}
          </p>
        )}

        {messages.map((m, i) => (
          <div key={i} className={cn("flex px-4 py-4", m.role === "user" ? "justify-end" : "justify-start")}>
            <div className={cn("min-w-0 max-w-[90%]", m.role === "user" ? "rounded-2xl bg-surface-2 px-5 py-3" : "w-full py-2")}>
              <p className="mb-2 text-xs font-medium text-muted-foreground">{m.role === "user" ? "You" : "Agent"}</p>
              <p className="whitespace-pre-wrap break-words text-sm leading-7">
                {i === 0 && m.role === "user" && taskPrompt && m.content.startsWith("You have been given this task:") ? taskPrompt : m.content}
              </p>
            </div>
          </div>
        ))}
        {result && !messages.some((m) => m.role === "assistant") && (
          <div className="px-4 py-4"><p className="mb-2 text-xs font-medium text-muted-foreground">Agent</p><p className="whitespace-pre-wrap break-words text-sm leading-7">{result}</p></div>
        )}

        {output.length > 0 && (
          <section aria-label="Agent activity" className="border-t border-border/40 px-4 py-3">
            <p className="mb-2 text-xs font-medium">{live || sending ? "Live activity" : "Activity"}</p>
            <pre role="log" aria-live="polite" aria-relevant="additions text" className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-3 font-sans text-sm leading-6 text-muted-foreground">
              {output.map((r) => r.text).join("")}
            </pre>
          </section>
        )}
        {(live || sending) && (
          <p role="status" className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-info" />
            {output.length ? "Agent is running — new activity appears here." : "Starting the agent — waiting for its first activity."}
          </p>
        )}
      </div>

      {/* Direction, not a chat box for its own sake: a settled task can still
          take a follow-up, because the agent kept its history and its
          checkout. Disabled only when there is no agent to talk to. */}
      <div className="sticky bottom-0 mt-5 shrink-0 rounded-2xl border border-border bg-surface p-3">
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
            agentId ? "Message your agent…" : "No agent has claimed this task yet"
          }
          aria-label="Message your agent"
          className="w-full resize-none border-0 bg-transparent px-2 py-2 text-sm leading-6 placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="font-mono text-[10px] text-muted-foreground">
            {sending ? "the agent is working — this can take a minute" : ""}
          </span>
          <Button size="sm" disabled={!draft.trim() || !agentId || sending} onClick={send}>
            {sending ? "Running…" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}
