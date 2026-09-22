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

const authHeaders = (): HeadersInit => (TOKEN ? { authorization: `Bearer ${TOKEN}` } : {});

/**
 * `settled` is the API's word for over-and-not-failed; the UI calls that
 * `merged`. The rest line up. `provisioning` and `review` have no counterpart
 * — the queue does not model them — so nothing ever maps to them.
 */
const toStatus = (state: ApiTask["state"]): TaskStatus => (state === "settled" ? "merged" : state);

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
    // Null until an agent opens one. The detail view links it when present
    // rather than describing a pull request it cannot point at.
    prUrl: t.prUrl,
    state: t.state,
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

/**
 * One task, or null when the id is not on the board.
 *
 * Fetched by id rather than by pulling the whole board and searching it: the
 * API has had a per-task route all along. The `number` a listing gives a task
 * is positional, so a task fetched alone cannot know its own — 0 stands for
 * "not from a listing" rather than claiming a position it did not get.
 */
export async function fetchTask(id: string): Promise<Task | null> {
  try {
    const t = await get<ApiTask>(`/api/fleet/tasks/${encodeURIComponent(id)}`);
    return adapt(t, -1);
  } catch {
    return null;
  }
}

/** A machine tier an agent can run on, as this deployment offers it. */
export interface Machine {
  id: string;
  label: string;
  vcpu: number;
  ramGb: number;
  diskGb: number;
  usdPerHour: number;
}

/** What this deployment can actually build an agent from. */
export interface Catalog {
  harnesses: { id: string; desc: string; ready: boolean }[];
  machines: Machine[];
  defaultMachine: string;
}

/**
 * The deployment's own catalog.
 *
 * Fetched rather than hardcoded because `ready` is computed per deployment
 * from its secrets: a harness with no key behind it is offered nowhere, and a
 * picker built from a local list would present choices that 400 on dispatch.
 */
export async function fetchCatalog(): Promise<Catalog> {
  return get<Catalog>("/catalog");
}

/**
 * File a task. It sits queued until an agent claims it.
 *
 * `harness` and `machine` are passed through to the agent the dispatch
 * creates. They used to be dropped here, so the harness picker on the dispatch
 * screen chose nothing — every task ran claude-code on the API's default tier
 * whatever the UI showed.
 */
export async function createTask(
  goal: string,
  opts: { repo?: string; harness?: string; machine?: string } = {},
): Promise<Task> {
  const res = await fetch(`${BASE}/api/fleet/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    // `dispatch` launches an agent for the task and starts it immediately.
    // Filing without it leaves the task queued until somebody points an agent
    // at the board by hand, which is not what pressing "Dispatch" means.
    body: JSON.stringify({
      goal,
      repo: opts.repo ?? null,
      harness: opts.harness,
      machine: opts.machine,
      dispatch: true,
    }),
  });
  if (!res.ok) throw new Error(`could not file the task (${res.status})`);
  return adapt((await res.json()) as ApiTask, 0);
}

/** One chunk of live CLI output, as the agent's DO stored it. */
export interface OutputRow {
  seq: number;
  text: string;
  ts: number;
}

/**
 * What the agent's CLI has printed, as it prints it.
 *
 * This is the only view of a run that is still in progress: the transcript
 * records what the agent decided, and that is written once the turn is over.
 * `since` returns just what is new, so following a run costs one small
 * response per poll rather than re-reading the whole buffer each time.
 */
export async function fetchAgentOutput(agentId: string, since = 0): Promise<OutputRow[]> {
  try {
    return await get<OutputRow[]>(`/agents/${encodeURIComponent(agentId)}/output?since=${since}`);
  } catch {
    // An agent that has not been created yet has no output, which is not an
    // error worth showing in place of the run.
    return [];
  }
}

/**
 * Put a task back on the queue.
 *
 * The API allows this from `running` or `failed` only, and most failures are
 * environmental — a cold container, a missing key — so a task that failed is
 * usually good work waiting on a fixed deployment. Requeueing keeps its id and
 * its history rather than making someone retype the goal.
 */
export async function releaseTask(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/fleet/tasks/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ state: "queued" }),
  });
  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? "the task is no longer on the board"
        : `the queue refused the change (${res.status})`,
    );
  }
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

/** Counts per state, for the overview. */
export async function fetchStatus(): Promise<Record<string, number>> {
  return get<Record<string, number>>("/api/fleet/status");
}
