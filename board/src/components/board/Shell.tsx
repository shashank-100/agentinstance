import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
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
          <nav aria-label="Workspace" className="flex gap-6 border-b border-border px-5 sm:px-8 lg:px-10">
            <Link to="/dispatch" className="border-b-2 py-3 text-sm hover:text-foreground" activeProps={{ className: "border-primary text-foreground" }} inactiveProps={{ className: "border-transparent text-muted-foreground" }}>Tasks</Link>
            <Link to="/connectors" className="border-b-2 py-3 text-sm hover:text-foreground" activeProps={{ className: "border-primary text-foreground" }} inactiveProps={{ className: "border-transparent text-muted-foreground" }}>Connectors</Link>
          </nav>
          <SessionsStrip />
          {children}
        </main>
      </div>
    </div>
  );
}
