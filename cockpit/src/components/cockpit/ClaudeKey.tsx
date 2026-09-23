import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound, Check } from "lucide-react";
import { fetchAnthropicKey, saveAnthropicKey } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The Anthropic API key that agents run Claude on.
 *
 * One key per deployment, saved on the server and used by every agent. It
 * replaces running `wrangler secret put` before anything works. The server
 * checks the key with Anthropic before saving it, so a typo is caught here and
 * not minutes into a run.
 */
export function ClaudeKey() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["keys", "anthropic"],
    queryFn: fetchAnthropicKey,
  });
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  if (isLoading || !data) return null;

  const save = async (key: string | null) => {
    setSaving(true);
    try {
      await saveAnthropicKey(key);
      setDraft("");
      toast.success(key ? "Key saved" : "Key removed");
      // Which harnesses are ready depends on the key.
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
      void queryClient.invalidateQueries({ queryKey: ["catalog"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="max-w-3xl rounded-lg border border-border bg-surface p-5">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-sm font-medium">Anthropic API key</h2>
            <span
              className={
                "rounded-sm px-1.5 py-0.5 font-mono text-[10px] " +
                (data.set ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive")
              }
            >
              {data.set ? `set · …${data.last4}` : "not set"}
            </span>
          </div>

          {data.set ? (
            <p className="mt-2 flex items-start gap-1.5 text-[13px] leading-relaxed text-muted-foreground">
              <Check className="mt-0.5 size-3 shrink-0 text-success" />
              {data.source === "secret"
                ? "Set as a Worker secret. A key saved here replaces it."
                : "Every agent on this deployment runs Claude on this key."}
            </p>
          ) : (
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
              Agents need a key to run Claude. Create one at{" "}
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                console.anthropic.com
              </a>
              .
            </p>
          )}

          <form
            className="mt-3 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) void save(draft.trim());
            }}
          >
            <Input
              type="password"
              autoComplete="off"
              placeholder="sk-ant-…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="h-8 min-w-0 flex-1 font-mono text-[12px] sm:max-w-sm"
            />
            <Button type="submit" size="sm" disabled={saving || !draft.trim()}>
              {saving ? "Checking…" : data.set ? "Replace" : "Save"}
            </Button>
            {data.source === "cockpit" && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => void save(null)}
              >
                Remove
              </Button>
            )}
          </form>
        </div>
      </div>
    </section>
  );
}
