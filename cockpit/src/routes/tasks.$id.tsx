import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { runtimeLabel, type DiffLine } from "@/lib/mock-data";
import { releaseTask, dispatchTask } from "@/lib/api";
import { useTask, useAgentHistory, useAgentOutput } from "@/lib/use-tasks";
import { Shell } from "@/components/cockpit/Shell";
import { Conversation } from "@/components/cockpit/Conversation";
import {
  CheckIcon,
  DiffStat,
  HarnessTag,
  NodeKindDot,
  StatusPill,
} from "@/components/cockpit/atoms";
import { ArrowLeft, GitBranch } from "lucide-react";

export const Route = createFileRoute("/tasks/$id")({
  // No fetch in the loader: it runs during SSR, where an unreachable API turns
  // the page into a 500. The task comes from the same client query the rail uses.
  loader: ({ params }) => ({ id: params.id }),
  head: ({ loaderData }) => {
    if (!loaderData) {
      return {
        meta: [
          { title: "Task unavailable — agentinstance" },
          { name: "robots", content: "noindex" },
        ],
      };
    }
    const title = `Task ${loaderData.id} — agentinstance`;
    const description = "An agent run on the work queue.";
    return {
      meta: [
        { title },
        { name: "description", content: description },
        { property: "og:title", content: title },
        { property: "og:description", content: description },
        { property: "og:type", content: "website" },
        { name: "twitter:card", content: "summary_large_image" },
      ],
    };
  },
  component: TaskView,
});

function TaskView() {
  const { id } = Route.useLoaderData();
  const { task, loading } = useTask(id);
  const agentId = task && task.vm !== "—" ? task.vm : null;
  const { rows: outputRows } = useAgentOutput(agentId, task?.status === "running");
  const { messages } = useAgentHistory(agentId, task?.status === "running");
  const [activeFile, setActiveFile] = useState("");
  const [releasing, setReleasing] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const queryClient = useQueryClient();
  // Nothing claims a queued task on its own, so this is the only way one
  // starts. Offered exactly when the task is waiting for an agent.
  const canDispatch = task?.state === "queued";
  // The API allows a requeue from `running` or `failed` only, so the button is
  // gated on the queue's own state rather than the UI's mapped status — which
  // folds `settled` into `merged` and would offer the action on a finished task.
  const canRelease = task?.state === "running" || task?.state === "failed";

  if (!task) {
    return (
      <Shell>
        <div className="px-4 py-6 sm:px-6 lg:px-8">
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3" /> sessions
          </Link>
          <p className="mt-6 font-mono text-sm text-muted-foreground">
            {loading ? "Loading…" : `No task ${id} on the board.`}
          </p>
        </div>
      </Shell>
    );
  }

  const file = task.files.find((f) => f.path === activeFile) ?? task.files[0];

  return (
    <Shell>
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3" /> sessions
        </Link>

        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex items-baseline gap-2.5 font-display text-2xl font-medium leading-snug sm:text-3xl">
              <span className="font-mono text-sm text-muted-foreground">#{task.number}</span>
              <span className="min-w-0 lg:truncate">{task.title}</span>
            </h1>
            <div className="mt-2.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
              <StatusPill status={task.status} />
              <HarnessTag harness={task.harness} />
              <span className="inline-flex items-center gap-1.5">
                <GitBranch className="size-3" />
                {task.repo}:{task.branch}
              </span>
              <span className="text-border-strong">|</span>
              <span>{runtimeLabel[task.runtime]}</span>
              <span>
                {task.vm} · boot {task.boot}
              </span>
              <span className="text-border-strong">|</span>
              <span>
                {task.tokens.toLocaleString()} tok · {task.cost} · {task.elapsed}
              </span>
            </div>
          </div>

          {/* Only what the deployment can actually do. "Take over terminal",
              "Request rework" and "Approve & merge" lived here and each fired
              a success toast without making a request — the last of those was
              also permanently disabled, since nothing on the queue ever
              reaches a `review` state. A button that reports work it did not
              do is worse than no button. */}
          <div className="flex flex-wrap gap-2">
            {canDispatch && (
              <Button
                size="sm"
                disabled={dispatching}
                onClick={() => {
                  setDispatching(true);
                  dispatchTask(task.id)
                    .then(() => {
                      void queryClient.invalidateQueries({ queryKey: ["fleet"] });
                      toast.success("Agent dispatched", {
                        description: `an agent is starting on ${task.id}`,
                      });
                    })
                    .catch((e: Error) =>
                      toast.error("Could not dispatch the task", { description: e.message }),
                    )
                    .finally(() => setDispatching(false));
                }}
              >
                {dispatching ? "Dispatching…" : "Dispatch agent"}
              </Button>
            )}
            {task.prUrl && (
              <Button asChild variant="outline" size="sm" className="gap-2">
                <a href={task.prUrl} target="_blank" rel="noreferrer">
                  <GitBranch className="size-3.5" /> View pull request
                </a>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={releasing || !canRelease}
              title={
                canRelease
                  ? "Put this task back on the queue for another agent"
                  : "Only a running or failed task can be requeued"
              }
              onClick={() => {
                setReleasing(true);
                releaseTask(task.id)
                  .then(() => {
                    void queryClient.invalidateQueries({ queryKey: ["fleet"] });
                    toast.success("Task requeued", {
                      description: `${task.id} is back on the queue`,
                    });
                  })
                  .catch((e: Error) =>
                    toast.error("Could not requeue the task", { description: e.message }),
                  )
                  .finally(() => setReleasing(false));
              }}
            >
              {releasing ? "Requeueing…" : "Requeue task"}
            </Button>
          </div>
        </div>

        <div className="mt-7 border-t border-border pt-5" />

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Tabs defaultValue="chat" className="min-w-0">
            <TabsList className="h-10 bg-surface-2">
              <TabsTrigger value="chat" className="font-mono text-[11px] tracking-wide">
                Conversation
              </TabsTrigger>
              <TabsTrigger value="diff" className="font-mono text-[11px] tracking-wide">
                Files changed{" "}
                <span className="ml-1.5 text-muted-foreground">{task.filesChanged}</span>
              </TabsTrigger>
              <TabsTrigger value="terminal" className="font-mono text-[11px] tracking-wide">
                Terminal
              </TabsTrigger>
              <TabsTrigger value="graph" className="font-mono text-[11px] tracking-wide">
                A2A graph
              </TabsTrigger>
              <TabsTrigger value="prompt" className="font-mono text-[11px] tracking-wide">
                Prompt
              </TabsTrigger>
            </TabsList>

            {/* The turns, with the run's output folded in beside them, and a
                composer: a dispatch is the first message rather than a job,
                so direction after it continues the same agent in the same
                checkout. The Terminal tab keeps the raw stream on its own. */}
            <TabsContent value="chat" className="mt-3">
              <Conversation
                agentId={agentId}
                messages={messages}
                output={outputRows}
                live={task.status === "running"}
              />
            </TabsContent>

            <TabsContent value="diff" className="mt-3">
              {!file ? (
                <EmptyPanel text="No commits yet — the microVM is still provisioning." />
              ) : (
                <div className="grid gap-3 2xl:grid-cols-[230px_minmax(0,1fr)]">
                  <ul className="h-fit max-h-60 overflow-y-auto rounded-md border border-border bg-surface 2xl:max-h-none">
                    {task.files.map((f) => (
                      <li key={f.path}>
                        <button
                          onClick={() => setActiveFile(f.path)}
                          className={cn(
                            "flex w-full flex-col gap-0.5 border-l-2 px-2.5 py-2 text-left transition-colors",
                            f.path === file.path
                              ? "border-primary bg-surface-2"
                              : "border-transparent hover:bg-surface-2/60",
                          )}
                        >
                          <span className="truncate font-mono text-[11px]">
                            {f.path.split("/").slice(-1)[0]}
                          </span>
                          <span className="truncate font-mono text-[10px] text-muted-foreground">
                            {f.path.split("/").slice(0, -1).join("/")}
                          </span>
                          <DiffStat added={f.added} removed={f.removed} />
                        </button>
                      </li>
                    ))}
                  </ul>

                  <div className="overflow-hidden rounded-md border border-border bg-surface">
                    <div className="flex items-center justify-between border-b border-border px-3 py-2">
                      <span className="truncate font-mono text-[11px]">{file.path}</span>
                      <DiffStat added={file.added} removed={file.removed} />
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse font-mono text-[11.5px] leading-5">
                        <tbody>
                          {file.lines.map((line, i) => (
                            <DiffRow key={i} line={line} />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="terminal" className="mt-3">
              <div className="grid-rail overflow-hidden rounded-md border border-border bg-surface">
                <div className="flex items-center gap-2 border-b border-border px-3 py-2 font-mono text-[11px] text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-success" />
                  {task.vm} · {task.repo}
                </div>
                {/* What the CLI actually printed, streamed into the agent's DO
                    as it ran and followed here with `?since=`. This tab used
                    to render the transcript alone, on the since-outdated basis
                    that container stdout was never captured — so a run in
                    progress showed nothing until its turn had ended. */}
                <div className="max-h-[520px] overflow-y-auto p-3 font-mono text-[11.5px] leading-6">
                  {outputRows.length === 0 && (
                    <p className="text-muted-foreground">
                      {task.vm === "—"
                        ? "No agent has claimed this task yet."
                        : task.status === "running"
                          ? "Waiting for the first output…"
                          : "This run printed nothing, or its output has aged out."}
                    </p>
                  )}
                  {outputRows.length > 0 && (
                    <pre className="whitespace-pre-wrap break-words text-foreground">
                      {outputRows.map((r) => r.text).join("")}
                    </pre>
                  )}
                  {task.status === "running" && (
                    <div className="mt-1 inline-block h-4 w-2 animate-pulse bg-primary align-middle" />
                  )}
                </div>

                {/* The turns themselves: what the agent concluded, as opposed
                    to what it printed on the way there. */}
                {messages.length > 0 && (
                  <div className="border-t border-border">
                    <p className="rule-label px-3 pt-2.5">Transcript</p>
                    <div className="max-h-56 overflow-y-auto p-3 font-mono text-[11.5px] leading-6">
                      {messages.map((m, i) => (
                        <div
                          key={i}
                          className="flex gap-3 border-b border-border/40 py-1.5 last:border-0"
                        >
                          <span className="w-16 shrink-0 text-muted-foreground">
                            {new Date(m.ts).toISOString().slice(11, 19)}
                          </span>
                          <span
                            className={cn(
                              "min-w-0 whitespace-pre-wrap break-words",
                              m.role === "user" ? "text-muted-foreground" : "text-foreground",
                            )}
                          >
                            {m.content}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="graph" className="mt-3">
              <div className="rounded-md border border-border bg-surface p-4">
                <ol className="space-y-0">
                  {task.graph.map((n, i) => (
                    <li key={n.id} className="flex gap-3">
                      <div className="flex flex-col items-center">
                        <NodeKindDot status={n.status} />
                        {i < task.graph.length - 1 && (
                          <span className="my-1 w-px flex-1 bg-border" />
                        )}
                      </div>
                      <div className="pb-5">
                        <p className="text-xs font-medium">{n.label}</p>
                        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                          {n.kind} · {n.meta}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </TabsContent>

            <TabsContent value="prompt" className="mt-3">
              <div className="rounded-md border border-border bg-surface p-4">
                <p className="rule-label">Dispatched prompt</p>
                <p className="mt-2.5 font-mono text-xs leading-6">{task.prompt}</p>
              </div>
            </TabsContent>
          </Tabs>

          <aside className="space-y-3 lg:sticky lg:top-[4.5rem]">
            <div className="overflow-hidden rounded-md border border-border bg-surface">
              <div className="border-b border-border px-3 py-2.5">
                <p className="rule-label">Checks</p>
              </div>
              <ul>
                {task.checks.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-start gap-2.5 border-b border-border px-3 py-2.5 last:border-0"
                  >
                    <span className="mt-0.5">
                      <CheckIcon status={c.status} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-[11px]">{c.name}</p>
                      <p className="truncate font-mono text-[10px] text-muted-foreground">
                        {c.detail}
                      </p>
                    </div>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {c.duration}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </div>
      </div>
    </Shell>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  if (line.kind === "hunk") {
    return (
      <tr className="bg-surface-2/70 text-muted-foreground">
        <td colSpan={3} className="px-3 py-1">
          {line.text}
        </td>
      </tr>
    );
  }
  const tone =
    line.kind === "add"
      ? "bg-diff-add text-diff-add-text"
      : line.kind === "del"
        ? "bg-diff-del text-diff-del-text"
        : "";
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  return (
    <tr className={tone}>
      <td className="w-10 select-none border-r border-border px-2 text-right text-muted-foreground">
        {line.old ?? ""}
      </td>
      <td className="w-10 select-none border-r border-border px-2 text-right text-muted-foreground">
        {line.new ?? ""}
      </td>
      <td className="whitespace-pre px-3">
        {sign} {line.text}
      </td>
    </tr>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-surface px-4 py-10 text-center font-mono text-[11px] text-muted-foreground">
      {text}
    </div>
  );
}
