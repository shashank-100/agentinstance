// Live task data, shaped like the static array the cockpit was built against.
//
// The screens import `tasks` from mock-data as a plain array. Swapping that for
// a hook keeps their bodies unchanged: `useTasks()` returns the same list, and
// the only difference is that it arrives over the network and refreshes itself.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  fetchTasks,
  fetchStatus,
  fetchAgentHistory,
  fetchAgentOutput,
  fetchCatalog,
  type OutputRow,
} from "./api";
import type { Task } from "./mock-data";

/**
 * True once the component is running in the browser.
 *
 * This router has no query dehydration configured, so a query that runs during
 * the server render has nowhere to put its result and fails the render — the
 * whole page becomes the error boundary. Gating on mount keeps fetching on the
 * client, where the data is wanted anyway: the board polls, so the first paint
 * being empty costs nothing.
 */
function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/**
 * Every task on the board.
 *
 * Polled rather than pushed: agents claim and settle tasks with no client
 * connected, so a board that only updated on user action would show yesterday's
 * queue. Five seconds is frequent enough to watch a claim land and cheap enough
 * to leave open on a second monitor.
 *
 * An empty list is returned while loading so callers can treat it as an array
 * without a separate loading branch — an empty board and a board not yet
 * fetched look the same, and neither is an error.
 */
export function useTasks(): { tasks: Task[]; loading: boolean; error: Error | null } {
  const mounted = useMounted();
  const q = useQuery({
    queryKey: ["fleet", "tasks"],
    queryFn: fetchTasks,
    refetchInterval: 5000,
    enabled: mounted,
  });
  return {
    tasks: q.data ?? [],
    loading: q.isLoading,
    error: (q.error as Error) ?? null,
  };
}

/** One task by id, from the same cached list the rail renders. */
export function useTask(id: string): { task: Task | null; loading: boolean } {
  const { tasks, loading } = useTasks();
  return { task: tasks.find((t) => t.id === id) ?? null, loading };
}

/** Counts per state, for the overview tiles. */
export function useFleetStatus() {
  const mounted = useMounted();
  const q = useQuery({
    queryKey: ["fleet", "status"],
    queryFn: fetchStatus,
    refetchInterval: 5000,
    enabled: mounted,
  });
  return { status: q.data ?? {}, loading: q.isLoading };
}

/**
 * An agent's transcript, polled while it works.
 *
 * Faster than the board: a running agent is the thing being watched, and a
 * five-second gap between "it said something" and seeing it is the difference
 * between a live feed and a log.
 */
export function useAgentHistory(agentId: string | null, live: boolean) {
  const mounted = useMounted();
  const q = useQuery({
    queryKey: ["agent", agentId, "history"],
    queryFn: () => fetchAgentHistory(agentId!),
    enabled: mounted && Boolean(agentId),
    refetchInterval: live ? 3000 : false,
  });
  return { messages: q.data ?? [], loading: q.isLoading };
}

/**
 * The agent's live CLI output, followed as it is produced.
 *
 * Accumulated here rather than refetched whole: the endpoint takes `?since=`
 * and answers with only the rows past it, which is what makes following a
 * long run cheap. That also means the query result is a *delta*, so it is
 * appended to what we already hold instead of replacing it — react-query's
 * cache alone would show each poll's handful of new lines and drop the rest.
 *
 * Polled faster than the board: this is the thing being watched, and the whole
 * point of the buffer is seeing a run while it happens.
 */
export function useAgentOutput(agentId: string | null, live: boolean) {
  const mounted = useMounted();
  const [rows, setRows] = useState<OutputRow[]>([]);
  // The high-water mark, kept in a ref so advancing it cannot itself trigger
  // a render and re-run the query.
  const since = useRef(0);

  // A different agent is a different buffer; carrying rows across would append
  // one agent's output to another's.
  useEffect(() => {
    setRows([]);
    since.current = 0;
  }, [agentId]);

  const q = useQuery({
    queryKey: ["agent", agentId, "output"],
    queryFn: async () => {
      const next = await fetchAgentOutput(agentId!, since.current);
      const newest = next[next.length - 1];
      if (newest) {
        since.current = newest.seq;
        // Guard against a buffer that was trimmed or restored underneath us:
        // a row we already hold must never be appended twice.
        setRows((prev) => {
          const seen = new Set(prev.map((r) => r.seq));
          return [...prev, ...next.filter((r) => !seen.has(r.seq))];
        });
      }
      return next;
    },
    enabled: mounted && Boolean(agentId),
    refetchInterval: live ? 2000 : false,
  });

  return { rows, loading: q.isLoading && rows.length === 0 };
}

/**
 * What this deployment can build an agent from.
 *
 * Not polled: secrets change on deploy, not while someone is filling in a
 * form. Cached for the session so moving between screens does not refetch it.
 */
export function useCatalog() {
  const mounted = useMounted();
  const q = useQuery({
    queryKey: ["catalog"],
    queryFn: fetchCatalog,
    enabled: mounted,
    staleTime: Infinity,
  });
  return { catalog: q.data ?? null, loading: q.isLoading };
}
