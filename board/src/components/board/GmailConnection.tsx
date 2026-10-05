import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiUrl } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type Draft = { id: string; to: string; subject: string; body: string; canSend: boolean };
async function gmailRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), { ...init, credentials: "include" });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Gmail request failed.");
  return data;
}

export function GmailConnection({ onExample }: { onExample: (text: string) => void }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [review, setReview] = useState<Draft | null>(null);
  const status = useQuery({ queryKey: ["gmail", "status"], queryFn: () => gmailRequest<{ configured: boolean; connected: boolean; email: string | null; writeEnabled: boolean }>("/gmail/status"), retry: false });
  const drafts = useQuery({ queryKey: ["gmail", "drafts"], queryFn: () => gmailRequest<{ drafts: Draft[] }>("/gmail/drafts"), enabled: status.data?.writeEnabled === true, retry: false });
  async function disconnect() {
    setBusy(true);
    try {
      await gmailRequest("/gmail/disconnect", { method: "POST" });
      setReview(null);
      queryClient.removeQueries({ queryKey: ["gmail", "drafts"] });
      await queryClient.invalidateQueries({ queryKey: ["gmail", "status"] });
      toast.success("Gmail disconnected");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not disconnect Gmail."); }
    finally { setBusy(false); }
  }
  async function send(draft: Draft) {
    if (sending) return;
    setSending(draft.id);
    try {
      await gmailRequest("/gmail/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: draft.id, expected: draft }) });
      setReview(null);
      await queryClient.invalidateQueries({ queryKey: ["gmail", "drafts"] });
      toast.success("Email sent");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not send. Check Sent mail before retrying."); }
    finally { setSending(null); }
  }
  return <div className="mt-6 rounded-lg border border-border bg-surface p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="text-sm font-medium">Gmail</p><p className="mt-1 text-xs text-muted-foreground">{status.data?.connected ? status.data.email : "Sign in with Google to connect your inbox and create email drafts."}</p></div>
      {status.data?.connected ? <div className="flex items-center gap-3">
        {!status.data.writeEnabled ? <a href={apiUrl("/gmail/connect")} className="text-xs text-primary underline underline-offset-4">Enable write access</a> : null}
        <Button type="button" variant="outline" size="sm" disabled={busy || sending !== null} onClick={() => void disconnect()}>Disconnect</Button>
      </div> : status.data?.configured ? <a href={apiUrl("/gmail/connect")} className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground">Connect Gmail</a>
        : <span className="text-xs text-muted-foreground">{status.isPending ? "Checking connection…" : status.error ? "Connection unavailable" : "Google setup required"}</span>}
    </div>
    {status.data?.connected ? <>
      <p className="mt-3 text-xs text-muted-foreground">{status.data.writeEnabled ? "Read and write enabled. Agents save drafts; you review and send them here." : "Read-only connection. Reconnect to enable drafts and sending."}</p>
      <button type="button" onClick={() => onExample("Find inbox conversations about our open Product Designer role. Summarize each candidate’s relevant experience, link to the Gmail conversation, and flag follow-up questions. Do not send emails or make hiring decisions.")} className="mt-3 text-xs text-primary underline underline-offset-4">Try: find candidates for an open role</button>
    </> : null}
    {status.data?.writeEnabled ? <section className="mt-5 border-t border-border pt-4" aria-label="Gmail drafts">
      <div className="flex items-center justify-between"><h2 className="text-sm font-medium">Drafts</h2><Button type="button" variant="ghost" size="sm" disabled={drafts.isFetching || sending !== null} onClick={() => { setReview(null); void drafts.refetch(); }}>Refresh</Button></div>
      {drafts.isPending ? <p className="mt-3 text-xs text-muted-foreground">Loading drafts…</p> : drafts.error ? <p role="alert" className="mt-3 text-xs text-destructive">{drafts.error.message}</p> : drafts.data?.drafts.length ? <ul className="mt-3 space-y-2">{drafts.data.drafts.map((draft) => <li key={draft.id} className="flex items-center justify-between gap-3 rounded-md border border-border p-3"><div className="min-w-0"><p className="truncate text-sm">{draft.subject || "(No subject)"}</p><p className="truncate text-xs text-muted-foreground">To: {draft.to}</p></div><Button type="button" variant="outline" size="sm" disabled={sending !== null} onClick={() => setReview(draft)}>Review</Button></li>)}</ul> : <p className="mt-3 text-xs text-muted-foreground">No drafts. Ask an agent to draft an email, then refresh.</p>}
      {review ? <div className="mt-4 rounded-md border border-primary/30 p-4"><h3 className="text-sm font-medium">Review before sending</h3><p className="mt-2 break-words text-xs">To: {review.to}</p><p className="mt-2 break-words text-sm font-medium">{review.subject}</p><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans text-sm">{review.body}</pre>{!review.canSend ? <p className="mt-3 text-xs text-muted-foreground">Send drafts with attachments, HTML, Cc or Bcc directly in Gmail.</p> : null}<p className="mt-3 text-xs text-muted-foreground">Send this email from {status.data.email} to the recipient shown above.</p><div className="mt-3 flex gap-2"><Button type="button" disabled={sending !== null || !review.canSend} onClick={() => void send(review)}>{sending ? "Sending…" : "Send email"}</Button><Button type="button" variant="outline" disabled={sending !== null} onClick={() => setReview(null)}>Cancel</Button></div></div> : null}
    </section> : null}
  </div>;
}
