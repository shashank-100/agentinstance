import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiUrl } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

async function gmailRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), { ...init, credentials: "include" });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Gmail request failed.");
  return data;
}

export function GmailConnection({ onExample }: { onExample: (text: string) => void }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const status = useQuery({ queryKey: ["gmail", "status"], queryFn: () => gmailRequest<{ configured: boolean; connected: boolean; email: string | null; writeEnabled: boolean }>("/gmail/status"), retry: false });
  async function disconnect() {
    setBusy(true);
    try {
      await gmailRequest("/gmail/disconnect", { method: "POST" });
      await queryClient.invalidateQueries({ queryKey: ["gmail", "status"] });
      toast.success("Gmail disconnected");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not disconnect Gmail."); }
    finally { setBusy(false); }
  }
  return <div className="mt-6 rounded-lg border border-border bg-surface p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="text-sm font-medium">Gmail</p><p className="mt-1 text-xs text-muted-foreground">{status.data?.connected ? status.data.email : "Sign in with Google to connect your inbox and create email drafts."}</p></div>
      {status.data?.connected ? <div className="flex items-center gap-3">
        {!status.data.writeEnabled ? <a href={apiUrl("/gmail/connect")} className="text-xs text-primary underline underline-offset-4">Enable write access</a> : null}
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void disconnect()}>Disconnect</Button>
      </div> : status.data?.configured ? <a href={apiUrl("/gmail/connect")} className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground">Connect Gmail</a>
        : <span className="text-xs text-muted-foreground">{status.isPending ? "Checking connection…" : status.error ? "Connection unavailable" : "Google setup required"}</span>}
    </div>
    {status.data?.connected ? <>
      <p className="mt-3 text-xs text-muted-foreground">{status.data.writeEnabled ? "Read and write enabled. Agents can create drafts in Gmail." : "Read-only connection. Reconnect to enable drafts and sending."}</p>
      <button type="button" onClick={() => onExample("Find inbox conversations about our open Product Designer role. Summarize each candidate’s relevant experience, link to the Gmail conversation, and flag follow-up questions. Do not send emails or make hiring decisions.")} className="mt-3 text-xs text-primary underline underline-offset-4">Try: find candidates for an open role</button>
    </> : null}
  </div>;
}
