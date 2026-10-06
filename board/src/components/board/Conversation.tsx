import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { apiUrl, sendToAgent, type OutputRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function AgentMessage({ text }: { text: string }) {
  return <div className="break-words text-sm leading-7 [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-surface-2 [&_pre]:p-3 [&_code]:font-mono [&_code]:text-xs [&_table]:my-4 [&_table]:w-full [&_th]:border [&_th]:border-border [&_th]:p-2 [&_th]:text-left [&_td]:border [&_td]:border-border [&_td]:p-2 [&_a]:text-primary [&_a]:underline [&_h2]:my-4 [&_h2]:font-semibold [&_h3]:my-3 [&_h3]:font-semibold">
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{text}</ReactMarkdown>
  </div>;
}

function GmailRecovery({ onRetry }: { onRetry?: (() => Promise<void>) | undefined }) {
  const [retrying, setRetrying] = useState(false);
  const status = useQuery({ queryKey: ["gmail", "status"], queryFn: async () => {
    const response = await fetch(apiUrl("/gmail/status"), { credentials: "include" });
    if (!response.ok) throw new Error("Connection unavailable");
    return await response.json() as { connected: boolean };
  }, retry: false });
  const connected = status.data?.connected;
  return <div className="py-2 text-sm leading-7">
    <p>{connected ? "Gmail is connected now. Retry this task to summarize your emails." : "I need a Gmail connection to summarize your emails. Open Connectors, choose Connect Gmail, and approve access with Google. Then come back and retry this task."}</p>
    <div className="mt-3 flex gap-3">
      <a href="/connectors" className="rounded-md border border-border px-3 py-2 text-sm">{connected || status.isPending || status.isError ? "Check Gmail connection" : "Connect Gmail"}</a>
      {connected && onRetry && <Button disabled={retrying} onClick={() => {
        setRetrying(true);
        void onRetry().catch((error: Error) => toast.error("Could not retry", { description: error.message })).finally(() => setRetrying(false));
      }}>{retrying ? "Starting…" : "Retry task"}</Button>}
    </div>
  </div>;
}

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
  failed,
  onRetry,
}: {
  agentId: string | null;
  messages: { role: string; content: string; ts: number }[];
  output: OutputRow[];
  live: boolean;
  taskPrompt?: string;
  result?: string;
  failed?: boolean;
  onRetry?: (() => Promise<void>) | undefined;
}) {
  const failureText = result || messages.filter((m) => m.role === "assistant").at(-1)?.content || "";
  const needsGmail = Boolean(failed && /(?:no Gmail access|Gmail.*(?:not connected|unavailable)|connect Gmail|no.*Gmail.*tools|Gmail.*authorization expired)/i.test(failureText));
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
              {m.role === "user" ? <p className="whitespace-pre-wrap break-words text-sm leading-7">
                {i === 0 && taskPrompt && m.content.startsWith("You have been given this task:") ? taskPrompt : m.content}
              </p> : needsGmail && i === messages.length - 1 ? <GmailRecovery onRetry={onRetry} /> : <AgentMessage text={m.content} />}
            </div>
          </div>
        ))}
        {result && !messages.some((m) => m.role === "assistant") && (
          <div className="px-4 py-4"><p className="mb-2 text-xs font-medium text-muted-foreground">Agent</p>{needsGmail ? <GmailRecovery onRetry={onRetry} /> : <AgentMessage text={result} />}</div>
        )}

        {output.length > 0 && !needsGmail && (
          <details key={live || sending ? "live" : "finished"} open={live || sending} aria-label="Agent activity" className="border-t border-border/40 px-4 py-3">
            <summary className="mb-2 cursor-pointer text-xs text-muted-foreground">{live || sending ? "Live activity" : "View activity log"}</summary>
            <pre role="log" aria-live="polite" aria-relevant="additions text" className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-3 font-sans text-sm leading-6 text-muted-foreground">
              {output.map((r) => r.text).join("")}
            </pre>
          </details>
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
