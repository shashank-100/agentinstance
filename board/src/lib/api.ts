// The real work queue, in the shape the board already expects.
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
 * Where the deployment lives.
 *
 * Same-origin by default, so the board served from the Worker needs no
 * configuration. `VITE_AGENT_URL` points a local `vite dev` at a deployment.
 */
const BASE = import.meta.env["VITE_AGENT_URL"] ?? "";

/**
 * The session cookie, and nothing else.
 *
 * This used to send `VITE_FLEET_TOKEN` as a bearer. Vite inlines `import.meta.env`
 * at build time, so that shipped the deployment's shared secret inside the
 * JavaScript of a public page — readable by anyone who opened the board and
 * usable against every route it guards. The cookie is HttpOnly and per person,
 * so the page can send it without ever being able to read it.
 *
 * `credentials: "include"` rather than the `"same-origin"` default: production
 * is same-origin, but `VITE_AGENT_URL` points a dev board at a real deployment,
 * and the default would silently drop the cookie on exactly that setup.
 */
const CREDENTIALS: RequestCredentials = "include";

/**
 * A request refused because nobody is signed in.
 *
 * A distinct type because the board's answer to it is a sign-in screen, not an
 * error: rendering "failed to load tasks" for a 401 sends somebody to the logs
 * to find out that their session expired.
 */
export class SignedOutError extends Error {
  constructor() {
    super("not signed in");
    this.name = "SignedOutError";
  }
}

/** Throws `SignedOutError` on a 401, so every caller can tell the two apart. */
function check(res: Response, what: string): void {
  if (res.status === 401 || res.status === 403) throw new SignedOutError();
  if (!res.ok) throw new Error(`${what} (${res.status})`);
}

/**
 * A URL on the API, for a link the browser follows itself.
 *
 * Sign-in and sign-out are redirects, not fetches, so they cannot be relative:
 * when the board is served from its own Worker, `/auth/login` is a path on the
 * *board*, which does not serve it. `BASE` is empty in the same-origin case, so
 * this is the plain path there.
 */
export const apiUrl = (path: string): string => `${BASE}${path}`;

/** Who is signed in, or null. */
export async function fetchMe(): Promise<{
  login: string;
  name?: string;
  avatarUrl?: string;
} | null> {
  const res = await fetch(`${BASE}/auth/me`, { credentials: CREDENTIALS });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    signedIn?: boolean;
    user?: { login: string; name?: string; avatarUrl?: string };
  };
  return body.signedIn && body.user ? body.user : null;
}

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
 * One API task, as the board's Task.
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
  const res = await fetch(`${BASE}${path}`, { credentials: CREDENTIALS });
  check(res, `${path} failed`);
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
    headers: { "content-type": "application/json" },
    credentials: CREDENTIALS,
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
  check(res, "could not file the task");
  return adapt((await res.json()) as ApiTask, 0);
}

/**
 * Send a message to a task's agent and get its reply.
 *
 * A dispatch is the first message, not a one-shot job: the agent keeps its
 * history and its checkout, so a follow-up continues the same run rather than
 * starting over. This is what makes "also handle unicode" cost a sentence
 * instead of a second task.
 *
 * Slow by nature — the reply arrives when the agent has finished thinking, so
 * the caller shows the message as pending until it resolves.
 */
export async function sendToAgent(agentId: string, text: string): Promise<string> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(agentId)}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: CREDENTIALS,
    body: JSON.stringify({ text }),
  });
  check(res, "the agent did not accept the message");
  const body = (await res.json()) as { reply?: string; error?: string };
  if (body.error) throw new Error(body.error);
  return body.reply ?? "";
}

/** One file a task's pull request touches. */
export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

/**
 * The diff of a task's pull request.
 *
 * Read through the deployment rather than from GitHub directly: the App
 * credential lives on the Worker, and a browser fetching GitHub itself would
 * need a token in its own bundle. `reason` explains an empty list — a task
 * with no pull request has no diff, which is not the same as one that changed
 * nothing.
 */
export async function fetchTaskFiles(
  taskId: string,
): Promise<{ files: ChangedFile[]; reason?: string; prUrl?: string }> {
  try {
    return await get<{ files: ChangedFile[]; reason?: string; prUrl?: string }>(
      `/api/fleet/files/${encodeURIComponent(taskId)}`,
    );
  } catch (e) {
    return { files: [], reason: e instanceof Error ? e.message : "could not read the diff" };
  }
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
 * Start a task that is sitting queued.
 *
 * Nothing polls the board, so a queued task never begins on its own — an agent
 * has to be pointed at it. This is the only way to move a task the board
 * shows as "unclaimed" into running work.
 */
export async function dispatchTask(
  id: string,
  opts: { harness?: string; machine?: string } = {},
): Promise<void> {
  const res = await fetch(`${BASE}/api/fleet/tasks/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: CREDENTIALS,
    body: JSON.stringify({ dispatch: true, ...opts }),
  });
  if (res.status === 401 || res.status === 403) throw new SignedOutError();
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      body.error ??
        (res.status === 404
          ? "the task is no longer on the board"
          : `the queue refused to dispatch it (${res.status})`),
    );
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
    headers: { "content-type": "application/json" },
    credentials: CREDENTIALS,
    body: JSON.stringify({ state: "queued" }),
  });
  if (res.status === 401 || res.status === 403) throw new SignedOutError();
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

/** Whether the Anthropic key is set, and where from. The key itself never
 *  comes back, only its last four characters. */
export interface KeyStatus {
  set: boolean;
  source: "board" | "secret" | null;
  last4: string | null;
}

export async function fetchAnthropicKey(): Promise<KeyStatus> {
  const body = await get<Record<string, KeyStatus>>("/api/keys");
  return body["ANTHROPIC_API_KEY"] ?? { set: false, source: null, last4: null };
}

/** Save the Anthropic key, or remove it with null. The server checks it with
 *  Anthropic first, and its error says why a key was refused. */
export async function saveAnthropicKey(key: string | null): Promise<KeyStatus> {
  const res = await fetch(`${BASE}/api/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: CREDENTIALS,
    body: JSON.stringify({ ANTHROPIC_API_KEY: key }),
  });
  if (res.status === 401 || res.status === 403) throw new SignedOutError();
  const body = (await res.json().catch(() => ({}))) as Record<string, KeyStatus> & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `could not save the key (${res.status})`);
  return body["ANTHROPIC_API_KEY"] ?? { set: false, source: null, last4: null };
}
