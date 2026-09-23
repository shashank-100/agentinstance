import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Shell } from "@/components/board/Shell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { createTask } from "@/lib/api";
import { useCatalog } from "@/lib/use-tasks";
import { cn } from "@/lib/utils";
import { type Harness, harnessLabel } from "@/lib/mock-data";

const title = "Dispatch a task — agentinstance";
const description =
  "Describe the change, pick the harness, and agentinstance provisions an ephemeral microVM with its own branch for review.";

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
  const { catalog } = useCatalog();
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [repo, setRepo] = useState("");
  const [harness, setHarness] = useState<Harness>("claude-code");
  // Null until the catalog names a default, so the first render cannot commit
  // to a tier this deployment does not offer.
  const [machine, setMachine] = useState<string | null>(null);
  const chosenMachine = machine ?? catalog?.defaultMachine ?? null;

  // A harness this deployment cannot run is not a choice. `ready` is computed
  // from its own secrets, so a missing key greys the option out here rather
  // than failing at dispatch with an error pointing at neither.
  const readiness = new Map(catalog?.harnesses.map((h) => [h.id, h.ready]) ?? []);
  const harnessReady = (h: Harness) => readiness.get(h) ?? true;

  // `git_repo clone` builds https://github.com/<repo>.git, so anything that is
  // not exactly owner/name produces a URL that 404s minutes into the run. Say
  // so here rather than letting the agent discover it.
  const trimmedRepo = repo.trim();
  const repoInvalid = trimmedRepo !== "" && !/^[\w.-]+\/[\w.-]+$/.test(trimmedRepo);

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

          {/* The repository the work is against. The API has always accepted
              one and names it in the agent's opening prompt; this screen never
              collected it, so a task told to "open a pull request" had no repo
              to open one on unless the prompt happened to spell it out. */}
          <p className="rule-label mt-6 mb-2">Repository</p>
          <Input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="owner/name"
            spellCheck={false}
            aria-invalid={repoInvalid}
            className="bg-surface font-mono text-xs"
          />
          <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
            {repoInvalid
              ? "Expected owner/name — a full URL or a bare name will not clone."
              : "Optional. Without one the agent has nothing to clone, so it cannot open a pull request."}
          </p>

          <p className="rule-label mt-6 mb-2">Harness</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {(["claude-code", "pi"] as Harness[]).map((h) => {
              const ready = harnessReady(h);
              return (
                <button
                  key={h}
                  disabled={!ready}
                  title={ready ? undefined : "No credentials for this harness on this deployment"}
                  onClick={() => setHarness(h)}
                  className={cn(
                    "rounded-lg border bg-surface px-3.5 py-3 text-left transition-colors",
                    !ready && "cursor-not-allowed opacity-40",
                    ready && harness === h
                      ? "border-primary/50 bg-surface-2"
                      : "border-border hover:border-border-strong",
                  )}
                >
                  <span className="block text-[13px] font-medium">{harnessLabel[h]}</span>
                  <span className="mt-1 block font-mono text-[10px] leading-relaxed text-muted-foreground">
                    {ready ? harnessNote[h] : "not configured"}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Machine. The API has always taken a tier and the builder has
              always offered one; this screen did not, so every dispatch got
              the API's default whatever the work needed. Tiers come from
              /catalog rather than a local list — they carry this deployment's
              own hardware and rates. */}
          <p className="rule-label mt-6 mb-2">Machine</p>
          {!catalog ? (
            <p className="font-mono text-[11px] text-muted-foreground">Loading tiers…</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-3">
              {catalog.machines.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMachine(m.id)}
                  className={cn(
                    "rounded-lg border bg-surface px-3.5 py-3 text-left transition-colors",
                    chosenMachine === m.id
                      ? "border-primary/50 bg-surface-2"
                      : "border-border hover:border-border-strong",
                  )}
                >
                  <span className="block text-[13px] font-medium">{m.label}</span>
                  <span className="mt-1 block font-mono text-[10px] leading-relaxed text-muted-foreground">
                    {m.ramGb} GB RAM · {m.diskGb} GB disk
                    <br />${m.usdPerHour}/hr active
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="mt-7 flex items-center justify-between border-t border-border pt-5">
            {/* The rate is the deployment's published figure for the tier
                actually selected. "est. boot ~150ms" stood here and was not
                measured from anything — a container cold start is seconds. */}
            <p className="font-mono text-[10px] text-muted-foreground">
              {(() => {
                const m = catalog?.machines.find((x) => x.id === chosenMachine);
                return m ? `${m.label} · $${m.usdPerHour}/hr while running` : "branch auto-created";
              })()}
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => void navigate({ to: "/" })}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!prompt.trim() || repoInvalid}
                onClick={() => {
                  const goal = prompt.trim();
                  if (!goal || repoInvalid) return;
                  setPrompt("");
                  setRepo("");
                  // File it for real, and say so only once the queue has it —
                  // a success toast fired before the POST lands is a lie the
                  // user acts on.
                  // `machine` is omitted rather than sent as undefined when
                  // the catalog has not loaded, so the API falls back to its
                  // own default instead of being handed a missing tier.
                  void createTask(goal, {
                    harness,
                    ...(chosenMachine ? { machine: chosenMachine } : {}),
                    ...(trimmedRepo ? { repo: trimmedRepo } : {}),
                  })
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
