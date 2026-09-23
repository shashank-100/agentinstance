import { cn } from "@/lib/utils";
import {
  type CheckRun,
  type Harness,
  type TaskStatus,
  harnessLabel,
  statusLabel,
} from "@/lib/mock-data";
import { Check, CircleDot, Clock, Loader2, X } from "lucide-react";

export function StatusPill({
  status,
  className,
}: {
  status: TaskStatus;
  className?: string;
}) {
  const tone: Record<TaskStatus, string> = {
    queued: "text-muted-foreground border-border",
    provisioning: "text-info border-info/35",
    running: "text-info border-info/35",
    review: "text-warning border-warning/35",
    merged: "text-success border-success/35",
    failed: "text-destructive border-destructive/35",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border bg-surface-2/50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em]",
        tone[status],
        className,
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full bg-current",
          (status === "running" || status === "provisioning") && "animate-pulse",
        )}
      />
      {statusLabel[status]}
    </span>
  );
}

export function HarnessTag({ harness }: { harness: Harness }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-[10px] tracking-[0.06em]",
        harness === "claude-code"
          ? "border-harness-claude/35 text-harness-claude"
          : "border-harness-pi/35 text-harness-pi",
      )}
    >
      <span className="size-1.5 rounded-sm bg-current" />
      {harnessLabel[harness]}
    </span>
  );
}

export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="font-mono text-[10.5px]">
      <span className="text-diff-add-text">+{added}</span>{" "}
      <span className="text-diff-del-text">−{removed}</span>
    </span>
  );
}

export function CheckIcon({ status }: { status: CheckRun["status"] }) {
  if (status === "pass") return <Check className="size-3.5 text-success" />;
  if (status === "fail") return <X className="size-3.5 text-destructive" />;
  if (status === "running")
    return <Loader2 className="size-3.5 animate-spin text-info" />;
  return <Clock className="size-3.5 text-muted-foreground" />;
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function NodeKindDot({ status }: { status: "done" | "active" | "pending" | "failed" }) {
  const tone = {
    done: "text-success",
    active: "text-info animate-pulse",
    pending: "text-muted-foreground",
    failed: "text-destructive",
  }[status];
  return <CircleDot className={cn("size-3.5", tone)} />;
}
