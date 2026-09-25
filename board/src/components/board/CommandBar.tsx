import { useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTasks, useFleetStatus } from "@/lib/use-tasks";
import { Kbd } from "./atoms";
import { useMe } from "./sign-in";
import { apiUrl } from "@/lib/api";
import { Plus, Search } from "lucide-react";

export function CommandBar() {
  const { tasks } = useTasks();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        void navigate({ to: "/dispatch" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  return (
    <>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setPaletteOpen(true)}
          className="flex h-9 w-60 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-left text-xs text-muted-foreground transition-colors hover:border-border-strong"
        >
          <Search className="size-3.5" />
          <span className="flex-1">Search sessions…</span>
          <Kbd>⌘K</Kbd>
        </button>
        <Button asChild size="sm" className="gap-2">
          <Link to="/dispatch">
            <Plus className="size-3.5" />
            New session
            <span className="kbd border-primary-foreground/25 bg-primary-foreground/15 text-primary-foreground">
              ⌘N
            </span>
          </Link>
        </Button>
      </div>

      <Dialog open={paletteOpen} onOpenChange={setPaletteOpen}>
        <DialogContent className="max-w-xl overflow-hidden p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>Command palette</DialogTitle>
            <DialogDescription>Jump to a task or run an action</DialogDescription>
          </DialogHeader>
          <Command className="bg-popover">
            <CommandInput placeholder="Jump to session, branch, or action…" />
            <CommandList>
              <CommandEmpty>No matches.</CommandEmpty>
              <CommandGroup heading="Actions">
                {/* "Take over terminal (latest run)" sat here and reported
                    attaching to a hardcoded `vm-1c7ba0` without making a
                    request. There is no attach endpoint, so the honest
                    version of it is not to offer it. */}
                <CommandItem
                  onSelect={() => {
                    setPaletteOpen(false);
                    void navigate({ to: "/dispatch" });
                  }}
                >
                  <Plus className="size-3.5" /> Dispatch new task
                </CommandItem>
              </CommandGroup>
              <CommandGroup heading="Sessions">
                {tasks.map((t) => (
                  <CommandItem
                    key={t.id}
                    value={`${t.number} ${t.title} ${t.branch}`}
                    onSelect={() => {
                      setPaletteOpen(false);
                      void navigate({ to: "/tasks/$id", params: { id: t.id } });
                    }}
                  >
                    <span className="font-mono text-xs text-muted-foreground">#{t.number}</span>
                    <span className="truncate">{t.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Live counts from the queue. Renders nothing until they arrive, so the bar
 *  never shows a zero it has not actually read. */
function FleetSummary() {
  const { status } = useFleetStatus();
  const running = status["running"] ?? 0;
  const queued = status["queued"] ?? 0;
  if (!Object.keys(status).length) return null;
  return (
    <span className="rule-label hidden sm:inline">
      {running} running · {queued} queued
    </span>
  );
}

/**
 * The signed-in person, and the way out.
 *
 * Sign-out is a link to a server route because the session cookie is HttpOnly:
 * the page cannot clear what it cannot read, and a button that only dropped the
 * cached identity would leave a live session behind on the next reload.
 */
function Who() {
  const { data: me } = useMe();
  if (!me) return null;

  return (
    <div className="flex items-center gap-2">
      {me.avatarUrl ? (
        <img
          src={me.avatarUrl}
          alt=""
          className="size-6 rounded-full border border-border"
        />
      ) : null}
      <span className="hidden text-[13px] text-muted-foreground sm:inline">{me.login}</span>
      <a
        href={apiUrl("/auth/logout")}
        className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        Sign out
      </a>
    </div>
  );
}

export function TopBar() {
  return (
    <header className="sticky top-0 z-40 h-16 border-b border-border bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-full max-w-[1680px] items-center gap-4 px-5">
        <Link to="/" className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg bg-primary font-mono text-[11px] text-primary-foreground">
            ⇥
          </span>
          <span className="font-display text-[15px] font-medium">
            agentinstance
          </span>
        </Link>
        {/* The real queue, not a fixed string. This read "acme · 3 microVMs
            warm" whatever the board was doing. */}
        <FleetSummary />
        <div className="ml-auto flex items-center gap-3">
          <CommandBar />
          <Who />
        </div>
      </div>
    </header>
  );
}
