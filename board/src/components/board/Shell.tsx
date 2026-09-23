import type { ReactNode } from "react";
import { TopBar } from "./CommandBar";
import { SessionsStrip, TaskRail } from "./TaskRail";

/** App frame: top bar, persistent session rail, and the workspace beside it. */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <TopBar />
      <div className="mx-auto flex max-w-[1680px] items-start">
        <TaskRail />
        <main className="min-w-0 flex-1">
          <SessionsStrip />
          {children}
        </main>
      </div>
    </div>
  );
}
