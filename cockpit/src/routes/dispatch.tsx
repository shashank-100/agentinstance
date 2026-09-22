import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Shell } from "@/components/cockpit/Shell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { createTask } from "@/lib/api";
import { cn } from "@/lib/utils";
import { type Harness, harnessLabel } from "@/lib/mock-data";

const title = "Dispatch a task — Relay";
const description =
  "Describe the change, pick the harness, and Relay provisions an ephemeral microVM with its own branch for review.";

export const Route = createFileRoute("/dispatch")({
  validateSearch: z.object({ prompt: z.string().optional() }),
  head: () => ({
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DispatchPage,
});

const harnessNote: Record<Harness, string> = {
  "claude-code": "Headless CLI daemon · deep AST map · higher token spend",
  pi: "Event-driven RPC loop · tight tools · minimal tokens",
};

function DispatchPage() {
  const queryClient = useQueryClient();
  const { prompt: initialPrompt } = Route.useSearch();
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [harness, setHarness] = useState<Harness>("claude-code");

  return (
    <Shell>
      <div className="px-5 py-10 sm:px-8 lg:px-10">
        <section className="max-w-3xl">
          <h1 className="font-display text-2xl font-medium leading-snug">Dispatch task</h1>
          <p className="mt-2 text-[13px] text-muted-foreground">
            An ephemeral microVM is provisioned per task and a branch is opened for review.
          </p>

          <Textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            placeholder="Refactor the Stripe webhook handler to support tiered subscriptions…"
            className="mt-6 resize-none bg-surface font-mono text-xs"
          />

          <p className="rule-label mt-6 mb-2">Harness</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {(["claude-code", "pi"] as Harness[]).map((h) => (
              <button
                key={h}
                onClick={() => setHarness(h)}
                className={cn(
                  "rounded-lg border bg-surface px-3.5 py-3 text-left transition-colors",
                  harness === h
                    ? "border-primary/50 bg-surface-2"
                    : "border-border hover:border-border-strong",
                )}
              >
                <span className="block text-[13px] font-medium">{harnessLabel[h]}</span>
                <span className="mt-1 block font-mono text-[10px] leading-relaxed text-muted-foreground">
                  {harnessNote[h]}
                </span>
              </button>
            ))}
          </div>

          <div className="mt-7 flex items-center justify-between border-t border-border pt-5">
            <p className="font-mono text-[10px] text-muted-foreground">
              est. boot ~150ms · branch auto-created
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => void navigate({ to: "/" })}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!prompt.trim()}
                onClick={() => {
                  const goal = prompt.trim();
                  if (!goal) return;
                  setPrompt("");
                  // File it for real, and say so only once the queue has it —
                  // a success toast fired before the POST lands is a lie the
                  // user acts on.
                  void createTask(goal)
                    .then((t) => {
                      void queryClient.invalidateQueries({ queryKey: ["fleet"] });
                      toast.success("Task filed", { description: `queued as ${t.id}` });
                      void navigate({ to: "/" });
                    })
                    .catch((e: Error) =>
                      toast.error("Could not file the task", { description: e.message }),
                    );
                }}
              >
                Dispatch
              </Button>
            </div>
          </div>
        </section>
      </div>
    </Shell>
  );
}
