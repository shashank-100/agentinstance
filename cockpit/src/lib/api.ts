// The real work queue, in the shape the cockpit already expects.
//
// The UI was built against `mock-data.ts`, which describes a richer task than
// the API actually stores: diffs, logs, check runs, token counts. Those are not
// invented here. A field the deployment does not have comes back empty, and the
// screen that renders it shows nothing rather than something made up — an empty
// diff is honest, a fabricated one is a bug that looks like a feature.
import type { Task, TaskStatus, Harness, Runtime } from "./mock-data";

/** What the FleetDO actually stores. */
interface ApiTask {
  id: string;
  goal: string;
  repo: string | null;
  branch: string | null;
  prUrl: string | null;
  createdBy: string | null;
  assignedTo: string | null;
  state: "queued" | "running" | "settled" | "failed";
  result: string | null;
  createdAt: number;
  updatedAt: number;
  attempts?: number;
}

/**
 * Where the deployment lives, and the token that may change it.
 *
 * Same-origin by default, so the cockpit served from the Worker needs no
 * configuration. `VITE_AGENT_URL` points a local `vite dev` at a deployment.
 */
const BASE = import.meta.env["VITE_AGENT_URL"] ?? "";
const TOKEN = import.meta.env["VITE_FLEET_TOKEN"] ?? "";

const authHeaders = (): HeadersInit =>
  TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

/**
 * `settled` is the API's word for over-and-not-failed; the UI calls that
 * `merged`. The rest line up. `provisioning` and `review` have no counterpart
 * — the queue does not model them — so nothing ever maps to them.
 */
const toStatus = (state: ApiTask["state"]): TaskStatus =>
  state === "settled" ? "merged" : state;

/** A human-sized gap, for the "updated 4m ago" line. */
const ago = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

/** The first line of the goal is the title; the whole thing is the prompt. */
const titleOf = (goal: string): string => {
  const first = (goal.split("\n")[0] ?? goal).trim();
  return first.length > 80 ? `${first.slice(0, 77)}…` : first;
};

/**
 * One API task, as the cockpit's Task.
 *
 * `number` is positional rather than stored: the queue has no issue numbers,
 * and the rail wants something short to show. Everything the API does not know
 * is zero or empty by design — see the note at the top of this file.
 */
function adapt(t: ApiTask, index: number): Task {
  return {
    id: t.id,
    number: index + 1,
    title: titleOf(t.goal),
    prompt: t.goal,
    // The queue does not record which agent kind claimed a task, only its name.
    harness: "claude-code" as Harness,
    runtime: "node-22" as Runtime,
    status: toStatus(t.state),
    repo: t.repo ?? "—",
    branch: t.branch ?? "—",
    vm: t.assignedTo ?? "—",
    boot: "—",
    tokens: 0,
    cost: "—",
    elapsed: ago(t.createdAt),
    updated: ago(t.updatedAt),
    filesChanged: 0,
    added: 0,
    removed: 0,
    checks: [],
    files: [],
    // The result the agent reported is the only log the queue keeps, so it is
    // shown as one line rather than dropped.
    logs: t.result
      ? [
          {
            t: new Date(t.updatedAt).toISOString().slice(11, 19),
            stream: "event" as const,
            text: t.result,
          },
        ]
      : [],
    graph: [],
  } satisfies Task;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return (await res.json()) as T;
}

/** Every task on the board, newest first. */
export async function fetchTasks(): Promise<Task[]> {
  const raw = await get<ApiTask[] | { tasks: ApiTask[] }>("/api/fleet/tasks");
  const list = Array.isArray(raw) ? raw : (raw.tasks ?? []);
  return list
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(adapt);
}

/** One task, or null when the id is not on the board. */
export async function fetchTask(id: string): Promise<Task | null> {
  const all = await fetchTasks();
  return all.find((t) => t.id === id) ?? null;
}

/** File a task. It sits queued until an agent claims it. */
export async function createTask(goal: string, repo?: string): Promise<Task> {
  const res = await fetch(`${BASE}/api/fleet/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    // `dispatch` launches an agent for the task and starts it immediately.
    // Filing without it leaves the task queued until somebody points an agent
    // at the board by hand, which is not what pressing "Dispatch" means.
    body: JSON.stringify({ goal, repo: repo ?? null, dispatch: true }),
  });
  if (!res.ok) throw new Error(`could not file the task (${res.status})`);
  return adapt((await res.json()) as ApiTask, 0);
}

/**
 * What an agent has actually said, newest last.
 *
 * The queue stores a task's outcome, not its progress — so while a task is
 * running the only record of what the agent is doing is its own message
 * history. Polling it is the difference between a spinner and knowing the
 * agent decided to wait for a wakeup that was never scheduled.
 */
export async function fetchAgentHistory(
  agentId: string,
): Promise<{ role: string; content: string; ts: number }[]> {
  try {
    return await get<{ role: string; content: string; ts: number }[]>(
      `/agents/${encodeURIComponent(agentId)}/history`,
    );
  } catch {
    // An agent that has not been created yet has no history, which is not an
    // error worth showing in place of the task.
    return [];
  }
}

/**
 * What the CLI printed, as it printed it.
 *
 * The transcript records what the agent decided; this is what it was doing
 * while deciding, and it is the only view of a run still in progress. `since`
 * returns just the new rows, so following a run does not re-read it.
 */
export async function fetchAgentOutput(
  agentId: string,
  since = 0,
): Promise<{ seq: number; text: string; ts: number }[]> {
  try {
    return await get<{ seq: number; text: string; ts: number }[]>(
      `/agents/${encodeURIComponent(agentId)}/output?since=${since}`,
    );
  } catch {
    return [];
  }
}

/** Counts per state, for the overview. */
export async function fetchStatus(): Promise<Record<string, number>> {
  return get<Record<string, number>>("/api/fleet/status");
}
