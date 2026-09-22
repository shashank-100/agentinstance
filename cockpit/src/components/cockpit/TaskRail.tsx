import { Link } from "@tanstack/react-router";
import { type Task, type TaskStatus } from "@/lib/mock-data";
import { useTasks } from "@/lib/use-tasks";
import { cn } from "@/lib/utils";

type Group = { label: string; statuses: TaskStatus[] };

const groups: Group[] = [
  { label: "Needs review", statuses: ["review", "failed"] },
  { label: "In progress", statuses: ["running", "provisioning", "queued"] },
  { label: "Merged", statuses: ["merged"] },
];


export function TaskRail() {
  const { tasks } = useTasks();
  return (
    <aside className="sticky top-16 hidden h-[calc(100vh-4rem)] w-[280px] shrink-0 flex-col border-r border-border bg-surface md:flex lg:w-[320px]">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <p className="rule-label">Sessions</p>
        <span className="font-mono text-[10px] text-muted-foreground">
          {tasks.length}
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto px-2.5 py-4">
        {groups.map((group) => {
          const items = tasks.filter((t) => group.statuses.includes(t.status));
          if (items.length === 0) return null;
          return (
            <div key={group.label} className="mb-4 last:mb-0">
              <p className="rule-label mb-1.5 px-2">{group.label}</p>
              <ul className="space-y-0.5">
                {items.map((t) => (
                  <li key={t.id}>
                    <TaskRow task={t} />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="shrink-0 border-t border-border p-2">
        <Link
          to="/dispatch"
          className="flex w-full items-center justify-between rounded-md border border-border bg-surface-2/60 px-2.5 py-2 text-left text-xs transition-colors hover:border-border-strong hover:bg-surface-2"
        >
          <span className="text-muted-foreground">New session</span>
          <span className="kbd">⌘N</span>
        </Link>
      </div>
    </aside>
  );
}

/** Narrow-screen fallback: the same sessions as a scrollable strip. */
export function SessionsStrip() {
  const { tasks } = useTasks();
  return (
    <div className="flex gap-2 overflow-x-auto border-b border-border bg-surface px-4 py-2.5 md:hidden">
      {tasks.map((t) => (
        <Link
          key={t.id}
          to="/tasks/$id"
          params={{ id: t.id }}
          className="flex shrink-0 items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          activeProps={{
            className: "border-primary/50 bg-surface-2 text-foreground",
          }}
        >
          <StatusDot status={t.status} />
          <span className="max-w-[150px] truncate">{t.title}</span>
        </Link>
      ))}
    </div>
  );
}

function TaskRow({ task }: { task: Task }) {
  return (
    <Link
      to="/tasks/$id"
      params={{ id: task.id }}
      className="block rounded-lg border border-transparent px-3 py-2.5 transition-colors hover:bg-surface-2/70"
      activeProps={{
        className:
          "border-border-strong bg-background",
      }}
    >
      <span className="flex items-center gap-2">
        <StatusDot status={task.status} />
        <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-tight">
          {task.title}
        </span>
      </span>
      {/* Who has it and when it last moved — the two things the queue knows.
          A diff stat and a harness label were shown here before, and the queue
          records neither, so every row read "+0 −0 · Claude Code" whatever it
          was actually doing. */}
      <span className="mt-1.5 flex items-center justify-between gap-2 font-mono text-[10px] text-muted-foreground">
        <span className={cn("truncate", task.vm === "—" && "italic opacity-70")}>
          {task.vm === "—" ? "unclaimed" : task.vm}
        </span>
        <span className={cn("shrink-0", task.status === "running" && "text-info")}>
          {task.updated}
        </span>
      </span>
      {task.repo !== "—" && (
        <span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground/70">
          {task.repo}
        </span>
      )}
    </Link>
  );
}

function StatusDot({ status }: { status: TaskStatus }) {
  const tone: Record<TaskStatus, string> = {
    queued: "bg-muted-foreground",
    provisioning: "bg-info",
    running: "bg-info",
    review: "bg-warning",
    merged: "bg-success",
    failed: "bg-destructive",
  };
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        tone[status],
        (status === "running" || status === "provisioning") && "animate-pulse",
      )}
    />
  );
}
