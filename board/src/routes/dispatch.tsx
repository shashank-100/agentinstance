import { GmailConnection } from "@/components/board/GmailConnection";
import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { toast } from "sonner";
import { Shell } from "@/components/board/Shell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { createTask } from "@/lib/api";
import { useCatalog } from "@/lib/use-tasks";
import { type Harness, harnessLabel } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/dispatch")({
  validateSearch: z.object({ prompt: z.string().optional() }),
  head: () => ({ meta: [
    { title: "Start a task — agentinstance" },
    { name: "description", content: "Describe your goal. Choose an available agent automatically and follow its work." },
  ] }),
  component: DispatchPage,
});

function DispatchPage() {
  const queryClient = useQueryClient();
  const { prompt: initialPrompt } = Route.useSearch();
  const navigate = useNavigate();
  const { catalog } = useCatalog();
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [repo, setRepo] = useState("");
  const [harness, setHarness] = useState<Harness | "auto">("auto");
  const [machine, setMachine] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const ready = (id: Harness) => catalog?.harnesses.some((h) => h.id === id && h.ready) ?? false;
  const chosenHarness = harness === "auto"
    ? (["claude-code", "pi"] as Harness[]).find(ready)
    : ready(harness) ? harness : undefined;
  const chosenMachine = machine ?? catalog?.defaultMachine;
  const tier = catalog?.machines.find((m) => m.id === chosenMachine);
  const trimmedRepo = repo.trim();
  const repoInvalid = trimmedRepo !== "" && !/^[\w.-]+\/[\w.-]+$/.test(trimmedRepo);

  async function startTask() {
    if (submitting || !prompt.trim() || repoInvalid || !chosenHarness || !tier) return;
    setSubmitting(true);
    try {
      const task = await createTask(prompt.trim(), {
        harness: chosenHarness,
        machine: tier.id,
        ...(trimmedRepo ? { repo: trimmedRepo } : {}),
      });
      void queryClient.invalidateQueries({ queryKey: ["fleet"] });
      toast.success("Task started", { description: "Follow your agent’s progress." });
      void navigate({ to: "/tasks/$id", params: { id: task.id } });
    } catch (error) {
      toast.error("Could not start the task", { description: error instanceof Error ? error.message : "Please try again." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Shell>
      <div className="px-5 py-10 sm:px-8 lg:px-10">
        <section className="max-w-3xl">
          <p className="rule-label mb-3">New task</p>
          <h1 className="font-display text-3xl font-medium leading-snug">What would you like to get done?</h1>
          <p className="mt-3 text-sm text-muted-foreground">Describe the outcome. We’ll choose an available agent and set up its workspace.</p>
          <GmailConnection onExample={setPrompt} />
          <form onSubmit={(event) => { event.preventDefault(); void startTask(); }}>
            <label htmlFor="task-goal" className="sr-only">Task description</label>
            <Textarea id="task-goal" autoFocus value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6}
              placeholder="Find and fix the failing tests, then prepare a pull request…"
              className="mt-7 resize-none bg-surface text-sm leading-relaxed" />
            <div className="mt-3 flex flex-wrap gap-2">
              {["Fix a bug", "Review a repository", "Build a feature"].map((label, index) => (
                <button type="button" key={label} onClick={() => setPrompt([
                  "Find and fix a bug in this repository. Run the relevant checks and prepare a pull request.",
                  "Review this repository for bugs. Explain the most important findings with file references. Do not change any code.",
                  "Build a feature in this repository: describe the feature here, including how it should behave.",
                ][index] ?? "")} className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground">{label}</button>
              ))}
            </div>
            <label htmlFor="task-repo" className="rule-label mt-7 mb-2 block">Repository <span className="normal-case">(optional)</span></label>
            <Input id="task-repo" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" spellCheck={false}
              aria-invalid={repoInvalid} aria-describedby="repo-help" className="bg-surface font-mono text-xs" />
            <p id="repo-help" className={cn("mt-2 text-xs", repoInvalid ? "text-destructive" : "text-muted-foreground")}>
              {repoInvalid ? "Enter owner/name, rather than a full URL." : "Add a repository for code changes and pull requests. Leave blank for a standalone task."}
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="rounded-full border border-border bg-surface px-3 py-1.5">Agent: {harness === "auto" ? "Auto" : harnessLabel[harness]}</span>
              <span>Machine: {machine ? tier?.label : "Auto"}</span>
            </div>
            <details className="mt-4 rounded-lg border border-border bg-surface p-4">
              <summary className="cursor-pointer text-sm font-medium">Advanced settings</summary>
              <p className="mt-2 text-xs text-muted-foreground">Choose the agent and machine yourself, or keep the automatic defaults.</p>
              <p className="rule-label mt-5 mb-2">Agent</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {(["auto", "claude-code", "pi"] as const).map((id) => (
                  <button type="button" key={id} aria-pressed={harness === id} disabled={id !== "auto" && !ready(id)} onClick={() => setHarness(id)}
                    className={cn("rounded-lg border px-3 py-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40", harness === id ? "border-primary/50 bg-surface-2" : "border-border hover:border-border-strong")}>
                    {id === "auto" ? "Auto" : harnessLabel[id]}
                    <span className="mt-1 block text-xs text-muted-foreground">{id === "auto" ? "Choose an available agent" : ready(id) ? "Available" : "Not configured"}</span>
                  </button>
                ))}
              </div>
              <p className="rule-label mt-5 mb-2">Machine</p>
              <button type="button" onClick={() => setMachine(null)} aria-pressed={machine === null} className="mb-3 text-xs text-muted-foreground underline underline-offset-4">Use automatic machine selection</button>
              <div className="grid gap-2 sm:grid-cols-3">
                {catalog?.machines.map((m) => (
                  <button type="button" key={m.id} aria-pressed={machine === m.id} onClick={() => setMachine(m.id)}
                    className={cn("rounded-lg border px-3 py-3 text-left text-sm transition-colors", machine === m.id ? "border-primary/50 bg-surface-2" : "border-border hover:border-border-strong")}>
                    {m.label}<span className="mt-1 block text-xs text-muted-foreground">{m.ramGb} GB RAM</span>
                  </button>
                ))}
              </div>
            </details>
            <p role="status" className="mt-4 text-xs text-muted-foreground">
              {!catalog ? "Loading available agents…" : !chosenHarness ? "No agent is configured. Add an agent credential before starting." : `Ready with ${harnessLabel[chosenHarness]}${tier ? ` · ${tier.label}` : ""}.`}
            </p>
            <div className="mt-6 flex items-center justify-between gap-4 border-t border-border pt-5">
              <p className="text-xs text-muted-foreground">Follow progress and review the result after starting.</p>
              <Button type="submit" disabled={submitting || !prompt.trim() || repoInvalid || !chosenHarness || !tier}>{submitting ? "Starting…" : "Start task"}</Button>
            </div>
          </form>
        </section>
      </div>
    </Shell>
  );
}
