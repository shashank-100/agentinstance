// Worker gateway: REST agent API + channel webhooks.
//
// Routing is deliberately plain — a handful of `if`s over the path segments,
// no framework. Each route group gets its own function so the shape of a URL is
// visible at the top and the handling is separate from the matching.
import { Sandbox as CloudflareSandbox, ContainerProxy } from "@cloudflare/sandbox";
import type { AgentInstance } from "./agent-instance.js";
import type { RegistryDO } from "./registry-do.js";
import type { FleetDO, TaskState } from "./fleet-do.js";
import type { Env } from "./types.js";
import {
  handleChannel,
  TelegramAdapter,
  WebAdapter,
  type ChannelAdapter,
} from "./channels/index.js";
import {
  harnessCatalog,
  capabilityCatalog,
  type KeyEnv,
  MODELS,
  MACHINES,
  DEFAULT_MACHINE,
  HARNESS_MODELS,
  hourlyCost,
} from "./catalog.js";
import { checkCompatible, defaultSpec, IncompatibleSpec } from "./harnesses/index.js";
import { toText, type Part } from "./parts.js";

// The containers runtime reaches for this by name on the worker entrypoint to
// route a container's outbound requests; without the re-export it is undefined
// and interception fails at construction.
export { ContainerProxy };

export { AgentInstance } from "./agent-instance.js";
export { RegistryDO } from "./registry-do.js";
export { FleetDO } from "./fleet-do.js";

/**
 * The agent's container, one class per machine tier.
 *
 * A container class carries a fixed `instance_type`, so offering real hardware
 * choices means one class per tier rather than one class configured per
 * request. They differ only in which wrangler.jsonc entry names them; the
 * image and behaviour are identical.
 *
 * `sleepAfter` is short because a running container holds a slot against
 * `max_instances` whether or not its agent is still in use, and deleting an
 * agent does not reclaim it. Sleeping when idle returns the slot on its own;
 * the next message pays a cold start instead of waiting for a free slot.
 */
class TieredSandbox extends CloudflareSandbox {
  sleepAfter = "5m";

  constructor(ctx: ConstructorParameters<typeof CloudflareSandbox>[0], env: Env) {
    // The container runtime sets `ctx.container`; miniflare never does, and the
    // base constructor throws without it. The test pool constructs every DO
    // class just to enumerate its RPC methods, so that throw surfaces as an
    // unhandled rejection in a suite that is not testing containers at all.
    //
    // Presenting a fake container would be a lie — there is nothing to talk to,
    // and a sandbox that silently does nothing is worse than one that fails. A
    // bare `ctx.container` shaped enough to get past the base constructor's
    // `=== undefined` guard keeps construction quiet; every method on it throws,
    // so any code that actually tries to use a container still fails loudly.
    if (ctx.container === undefined) {
      const unavailable = (): never => {
        throw new Error(
          "No container runtime: containers do not exist under miniflare.",
        );
      };
      Object.defineProperty(ctx, "container", {
        // Properties the stand-in defines answer from it: the base class reads
        // `running` as a plain truthiness guard, and a thrower returned there
        // is a *function*, so the guard would pass and go on to call a method.
        // Only what the stand-in does not define throws.
        // `destroy` resolves instead of throwing: stopping a container that
        // does not exist is the goal already met, and the sandbox stores the
        // teardown promise before awaiting it — so a rejection there is
        // unhandled no matter what the caller does with its own copy.
        value: new Proxy({ running: false, destroy: async () => {} }, {
          get: (target, prop) =>
            prop in target ? target[prop as keyof typeof target] : unavailable,
        }),
        configurable: true,
      });
    }
    super(ctx, env);
  }
}

export class SandboxSmall extends TieredSandbox {}
export class SandboxMedium extends TieredSandbox {}
export class SandboxLarge extends TieredSandbox {}

const CHANNELS: Record<string, ChannelAdapter> = {
  telegram: new TelegramAdapter(),
  web: new WebAdapter(),
};

// Stub types come from the Durable Object classes themselves, so a method
// signature can never drift from a hand-written copy of it here.
//
// runTool is the exception: its result is arbitrary JSON from a capability, and
// RPC's serialization types narrow that to `never`. Overriding just that one
// method keeps the rest of the class as the source of truth.
type AgentStub = Omit<DurableObjectStub<AgentInstance>, "runTool"> & {
  runTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ result?: unknown; error?: string }>;
};
type RegistryStub = DurableObjectStub<RegistryDO>;
type FleetStub = DurableObjectStub<FleetDO>;

const agentStub = (env: Env, id: string): AgentStub =>
  env.AGENT.get(env.AGENT.idFromName(id)) as AgentStub;

const registry = (env: Env): RegistryStub =>
  env.REGISTRY.get(env.REGISTRY.idFromName("global")) as RegistryStub;

const fleet = (env: Env): FleetStub =>
  env.FLEET.get(env.FLEET.idFromName("global")) as FleetStub;

/**
 * Every JSON reply is readable cross-origin.
 *
 * The API and the UI that reads it are separate Workers, so a dashboard on its
 * own origin is a browser request from somewhere else — and without these
 * headers the browser discards a perfectly good 200 before the page sees it.
 *
 * `*` rather than a named origin: what protects this deployment is FLEET_TOKEN
 * on every mutating route, not the browser's guess about who is asking. An
 * origin allowlist here would imply a protection that is not how this is
 * actually defended, while breaking every other client — curl, a script, a
 * second dashboard — for no gain.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-max-age": "86400",
};

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: CORS });

/**
 * Is this request allowed to change things?
 *
 * Unset FLEET_TOKEN means an open deployment — the default, so a fresh clone
 * runs with no configuration. Once set, every mutating route requires it, and
 * the agents' own VM tools carry it too.
 *
 * Reads are deliberately left open: the dashboard is static and fetches the
 * agent list before it could prompt for anything, and a listing is not what
 * costs money. Launching, deleting and sending are.
 */
const authorized = (request: Request, env: Env): boolean => {
  if (!env.FLEET_TOKEN) return true;
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Also accept the token on a query param: the VM tool scripts post from
  // python with no easy way to add headers per call.
  const param = new URL(request.url).searchParams.get("token") ?? "";
  return bearer === env.FLEET_TOKEN || param === env.FLEET_TOKEN;
};
const bodyOf = <T>(request: Request) => request.json().catch(() => ({})) as Promise<T>;

/** Like bodyOf, but tells the caller the body was unparseable rather than
 *  quietly handing back an empty object — launching on defaults because JSON
 *  failed to parse creates an agent nobody asked for. */
const parsedBody = async <T>(request: Request): Promise<T | null> => {
  const text = await request.text();
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Decode each segment: `url.pathname` keeps percent-encoding, so an agent
    // whose name needs escaping could never be addressed again — a DELETE would
    // match the literal "%3C..." string, hit a different (empty) object, and
    // report success while the real agent stayed put.
    const [first, second, third, fourth] = url.pathname
      .split("/")
      .filter(Boolean)
      .map((seg) => {
        try {
          return decodeURIComponent(seg);
        } catch {
          return seg; // malformed escape: treat it as literal rather than 500
        }
      });

    // A cross-origin request carrying an Authorization header is preflighted,
    // so this has to answer before any routing: the browser never sends the
    // real request until it does.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/") {
      // No landing page, so the agent list is the front door.
      return Response.redirect(new URL("/agents/", url).toString(), 302);
    }
    if (first === "catalog") return catalogRoute(env);
    if (first === "github") return githubRoute(request, env, second);
    if (first === "api" && second === "launch" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
      return launchRoute(request, env);
    }
    if (first === "api" && second === "agents" && request.method === "GET") {
      return listAgentsRoute(env);
    }
    if (first === "api" && second === "fleet") {
      return fleetRoute(request, env, ctx, third, fourth);
    }
    if (first === "channels" && second) return channelRoute(request, env, second);

    if (first === "agents" && second) {
      // DELETE /agents/:id wipes the agent. The segment count matters: without
      // it, DELETE /agents/:id/schedule would match here and destroy the agent
      // instead of clearing its standing task.
      const isAgentItself = third === undefined;
      if (isAgentItself && request.method === "DELETE") {
        if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
        return deleteAgentRoute(env, second);
      }
      return agentRoute(request, env, ctx, { id: second, action: third ?? "send", arg: fourth });
    }

    return env.ASSETS.fetch(request); // static assets
  },
} satisfies ExportedHandler<Env>;

/**
 * The GitHub App install flow.
 *
 * `/github/install` sends someone to GitHub's own consent screen, which is the
 * point of the App: GitHub asks which repositories to grant, and the
 * permissions being granted are the ones the App declares. Nobody ticks boxes
 * by hand, and nobody pastes a token anywhere.
 *
 * `/github/status` reports what this deployment is actually running on, so a
 * 403 at push time can be diagnosed without reading the source.
 *
 * GitHub redirects back to `/github/installed` after an install. There is
 * nothing to store: which repositories were granted lives on GitHub, and
 * `tokenForRepo` asks it per repo. That is deliberate — an installation id
 * cached here would go stale the moment someone changed the grant.
 */
function githubRoute(request: Request, env: Env, action?: string): Response {
  const appSlug = env.GITHUB_APP_SLUG;
  switch (action) {
    case "install": {
      if (!appSlug) {
        return json(
          { error: "GITHUB_APP_SLUG is not set, so there is no app to install" },
          400,
        );
      }
      return Response.redirect(
        `https://github.com/apps/${appSlug}/installations/new`,
        302,
      );
    }
    case "installed":
      return json({
        ok: true,
        message:
          "installed — agents can now reach the repositories you granted. " +
          "Check /github/status to confirm.",
      });
    case "status": {
      const app = Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
      return json({
        credential: app ? "github-app" : env.GITHUB_TOKEN ? "personal-access-token" : "none",
        // A PAT's permissions cannot be checked without using it: the repo
        // API's `permissions` block describes the *account's* access, not the
        // token's grants, so a read-only token looks identical to a writable
        // one until a push fails. The App has no such ambiguity.
        canVerifyPermissions: app,
        installUrl: appSlug ? `/github/install` : null,
      });
    }
    default:
      return json({ error: `unknown github action '${action ?? ""}'` }, 404);
  }
}

// --- what an agent can be built from -----------------------------------------
function catalogRoute(env: Env): Response {
  const entries = (m: Record<string, { desc: string; ready: boolean }>) =>
    Object.entries(m).map(([id, v]) => ({ id, ...v }));
  // Readiness is computed from this deployment's own secrets, so the builder
  // describes what the person looking at it can actually run.
  return json({
    harnesses: entries(harnessCatalog(env as unknown as KeyEnv)),
    models: Object.values(MODELS),
    capabilities: entries(capabilityCatalog(env as unknown as KeyEnv)),
    machines: Object.entries(MACHINES).map(([id, m]) => ({ id, ...m })),
    defaultMachine: DEFAULT_MACHINE,
    // Which models each harness can actually drive, so the builder never
    // offers a pairing that would 404 at run time.
    harnessModels: HARNESS_MODELS,
  });
}

// --- create an agent from a spec, after checking the pieces fit --------------
async function launchRoute(request: Request, env: Env): Promise<Response> {
  const body = await parsedBody<{
    id?: string;
    harness?: string;
    model?: string;
    capabilities?: string[];
    machine?: string;
    system?: string;
  }>(request);
  if (!body) return json({ error: "body is not valid JSON" }, 400);

  const spec = defaultSpec({
    harness: body.harness,
    model: body.model,
    capabilities: body.capabilities ?? [],
    machine: body.machine,
    system: body.system,
  });
  try {
    checkCompatible(spec);
  } catch (e) {
    return json({ error: e instanceof IncompatibleSpec ? e.message : String(e) }, 400);
  }

  const id = body.id || `agent-${crypto.randomUUID().slice(0, 8)}`;
  // Launching a name that already exists used to reconfigure that agent in
  // place: its capabilities and machine were replaced by the new spec's, with
  // no warning and no way to tell it had happened. Creating is not editing —
  // `POST /agents/:id/configure` is the route for changing an agent.
  if (body.id && (await agentStub(env, id).exists())) {
    return json({ error: `agent '${id}' already exists` }, 409);
  }
  await agentStub(env, id).configure({ ...spec, name: id }, true);
  await registry(env).register({
    id,
    model: spec.model,
    harness: spec.harness,
    machine: spec.machine,
    createdAt: Date.now(),
  });
  return json({ id, spec, usdPerHour: hourlyCost(spec.machine) });
}

// --- the work queue ----------------------------------------------------------
/**
 * `/api/fleet/tasks` — file work and read it back.
 *
 * A task is not a message: it outlives the request that created it, which is
 * the whole reason for running an agent somewhere that does not have to stay
 * awake. Filing one does not run anything; an agent claims it when it is free.
 */
async function fleetRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  section: string | undefined,
  id: string | undefined,
): Promise<Response> {
  const f = fleet(env);
  // `sweep` changes state whatever the method: it requeues abandoned tasks and,
  // at the attempt limit, fails them permanently. Reads are deliberately open
  // here, so the method alone cannot decide — a GET to sweep would otherwise
  // let anyone strip a running agent's claim without a token.
  const write = request.method !== "GET" || section === "sweep";
  if (write && !authorized(request, env)) return json({ error: "unauthorized" }, 401);

  if (section === "status") return json(await f.stats());

  // Run the sweep now rather than waiting for the alarm. The alarm covers the
  // unattended case; this is for when someone is looking at a stuck board and
  // would otherwise have to file a task just to trigger a reclaim.
  if (section === "sweep") return json(await f.sweep());

  if (section !== "tasks") return json({ error: "unknown fleet route" }, 404);

  // One task: read it, patch its branch/PR, or drop it.
  if (id) {
    if (request.method === "GET") {
      const task = await f.get(id);
      return task ? json(task) : json({ error: `no task '${id}'` }, 404);
    }
    if (request.method === "DELETE") {
      const out = await f.remove(id);
      return out.ok ? json(out) : json({ error: `no task '${id}'` }, 404);
    }
    const body = await bodyOf<{
      branch?: string;
      prUrl?: string;
      repo?: string;
      result?: string;
      state?: TaskState;
      assignedTo?: string;
      backdateMs?: number;
      dispatch?: boolean;
      harness?: string;
      model?: string;
      machine?: string;
    }>(request);
    // Ageing a task is a test affordance: a lease expiring is worth covering,
    // and waiting fifteen real minutes for it is not a test anyone runs. Gated
    // on the echo-model flag, which only the test environment sets, so it
    // cannot be used against a real deployment to steal another agent's claim.
    if (body.backdateMs && env.USE_ECHO_MODEL) {
      await f.backdate(id, body.backdateMs);
      return finished(await f.get(id), id);
    }
    // Start a task that was filed without `dispatch`. Nothing polls the queue,
    // so a queued task has no other way to begin — this is what turns the
    // board's "unclaimed" rows into running work.
    if (body.dispatch) {
      const task = await f.get(id);
      if (!task) return json({ error: `no task '${id}'` }, 404);
      // Dispatching a task that already has an agent would create a second one
      // for the same work, with both pushing to the same branch.
      if (task.state === "running") {
        return json({ error: `task '${id}' is already running on ${task.assignedTo}` }, 409);
      }
      return json(
        await dispatchTask(env, ctx, f, task, new URL(request.url).origin, body),
      );
    }
    // Ending a task is a state change, not a patch: settle and fail record why.
    // Assigning is a state change too: it moves the task to `running` under a
    // named agent, rather than waiting for one to claim it.
    if (body.assignedTo) return finished(await f.assign(id, body.assignedTo), id);
    if (body.state === "settled") return finished(await f.settle(id, body.result ?? ""), id);
    if (body.state === "failed") return finished(await f.fail(id, body.result ?? ""), id);
    if (body.state === "queued") return finished(await f.release(id), id);
    return finished(await f.update(id, body), id);
  }

  if (request.method === "GET") {
    const state = new URL(request.url).searchParams.get("state") as TaskState | null;
    return json(await f.list(state ?? undefined));
  }

  // POST /api/fleet/tasks — file one, or claim the next.
  const body = await bodyOf<{
    goal?: string;
    repo?: string;
    createdBy?: string;
    claim?: string;
    dispatch?: boolean;
    harness?: string;
    model?: string;
    machine?: string;
  }>(
    request,
  );
  if (body.claim) {
    const task = await f.claim(body.claim);
    return json(task ?? { task: null, reason: "nothing queued" });
  }
  if (!body.goal) return json({ error: "goal required" }, 400);
  const task = await f.enqueue({
    goal: body.goal,
    repo: body.repo,
    createdBy: body.createdBy,
  });

  // `dispatch` is the difference between filing work and starting it. Without
  // it a task sits queued until somebody thinks to point an agent at the
  // board, which is a queue that needs a human to run it. With it, the task
  // gets an agent of its own and begins immediately.
  if (body.dispatch) {
    return json(await dispatchTask(env, ctx, f, task, new URL(request.url).origin, body));
  }

  return json(task);
}

const finished = (task: unknown, id: string) =>
  task ? json(task) : json({ error: `no task '${id}'` }, 404);

/**
 * Give a task an agent of its own and set it going.
 *
 * Shared by filing-with-dispatch and starting an already-queued task, because
 * they are the same act at different moments. It used to live inline in the
 * create path only, so a task filed without `dispatch` could never be started
 * from the API at all: nothing polls the queue, and `claim` has to be called
 * by an agent that is already running. Tasks filed without it simply sat in
 * `queued` forever with no way to move them.
 *
 * The agent runs in `waitUntil` rather than inline: the work takes minutes,
 * and holding the request open for it would time out long before the agent
 * finished, reporting a failure for a task that is running perfectly well.
 */
async function dispatchTask(
  env: Env,
  ctx: ExecutionContext,
  f: FleetStub,
  task: { id: string; goal: string; repo: string | null },
  origin: string,
  opts: { harness?: string; model?: string; machine?: string },
): Promise<Record<string, unknown>> {
  const agentId = `task-${task.id}`;
  const spec = defaultSpec({
    harness: opts.harness ?? "claude-code",
    model: opts.model ?? "claude-opus-4.8",
    capabilities: ["fleet_task", "run_shell", "git_repo", "open_pr"],
    machine: opts.machine ?? "one-cpu",
  });
  const agent = agentStub(env, agentId);
  await agent.configure({ ...spec, name: agentId }, true);
  await registry(env).register({
    id: agentId,
    model: spec.model,
    harness: spec.harness,
    machine: spec.machine,
    createdAt: Date.now(),
  });
  await f.assign(task.id, agentId);

  ctx.waitUntil(
    agent
      .send(
        `You have been given this task: ${task.goal}\n\n` +
          (task.repo ? `It is against the repository ${task.repo}.\n\n` : "") +
          `Do it. Clone with git_repo, make the change, commit, push the branch, ` +
          `and open a pull request with open_pr. Record the branch and PR on task ` +
          `${task.id} with fleet_task as you go, then settle it. If you cannot ` +
          `finish, mark the task failed with the reason.`,
        undefined,
        origin,
      )
      .catch(async (e: unknown) => {
        // A crash here is invisible otherwise — nothing is awaiting this.
        await f.fail(task.id, e instanceof Error ? e.message : "agent failed to start");
      }),
  );
  return { ...task, state: "running", assignedTo: agentId, dispatched: true };
}

// --- dashboard listing: registry records plus each agent's live status -------
async function listAgentsRoute(env: Env): Promise<Response> {
  const records = await registry(env).list();
  const withStatus = await Promise.all(
    records.map(async (r) => ({ ...r, ...(await agentStub(env, r.id).status()) })),
  );
  return json(withStatus);
}

async function deleteAgentRoute(env: Env, id: string): Promise<Response> {
  // Ask the agent to release its container before its own state is erased:
  // afterwards nothing knows which machine tier it was on, so nothing can find
  // the container to stop. Left alone it keeps its slot against max_instances
  // until the idle timer expires, long after the agent is gone from the UI.
  await agentStub(env, id).releaseSandbox();
  await agentStub(env, id).wipe();
  await registry(env).remove(id);
  return json({ ok: true, deleted: id });
}

// --- inbound webhooks: /channels/:name/:agentId ------------------------------
async function channelRoute(request: Request, env: Env, name: string): Promise<Response> {
  const adapter = CHANNELS[name];
  if (!adapter) return new Response("unknown channel", { status: 404 });

  try {
    return await handleChannel(adapter, request, env);
  } catch (e) {
    return json({ error: String(e) }, 400);
  }
}

// --- REST agent API: /agents/:id/:action[/:arg] ------------------------------
async function agentRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  route: { id: string; action: string; arg?: string },
): Promise<Response> {
  const agent = agentStub(env, route.id);
  // Every deployment must call its own tools back, so the origin comes from
  // the request rather than from a value compiled into the repo.
  const origin = new URL(request.url).origin;
  // Actions that change something must not run on GET. A GET that boots a VM
  // and spends the model quota is triggered by anything that follows links —
  // a crawler, a prefetch, a chat client generating a preview.
  const WRITES = new Set([
    "send",
    "a2a",
    "restore",
    "wake",
    "tool",
    "configure",
    "handoff",
    // Not a write, but it is a POST: listing it keeps the method check from
    // rejecting it as a GET-only route.
    "validate-snapshot",
  ]);
  if (WRITES.has(route.action) && request.method === "GET") {
    return json({ error: `${route.action} requires POST` }, 405);
  }
  // Anything that changes state, boots a VM, or spends model quota needs the
  // token when one is configured. `schedule` and `agents-md` are included on
  // their mutating methods: a standing task is a recurring spend.
  const mutating =
    WRITES.has(route.action) ||
    ((route.action === "schedule" || route.action === "agents-md") &&
      request.method !== "GET");
  if (mutating && !authorized(request, env)) return json({ error: "unauthorized" }, 401);
  try {
    switch (route.action) {
      case "send": {
        // Accept either { text } or AgentSky-style { parts: [...] }.
        const body = await bodyOf<{ text?: string; parts?: Part[]; channel?: string }>(request);
        const text = body.parts ? toText(body.parts) : (body.text ?? "");
        const out = await agent.send(text, body.channel, origin);
        if (out.missing) return json({ error: `no agent '${route.id}'` }, 404);
        return json({ reply: out.reply });
      }

      // Reading an agent that was never launched should say so, rather than
      // describing the empty Durable Object that exists for every name.
      // Check a snapshot without restoring it. POST because the snapshot is
      // the body, but it changes nothing — the point is to answer "would this
      // restore?" while the agent that is there stays untouched.
      case "validate-snapshot": {
        if (!(await agent.exists())) return json({ error: `no agent '${route.id}'` }, 404);
        return json(await agent.validateSnapshot(await bodyOf(request)));
      }

      case "history":
      case "output":
      case "status":
      case "snapshot": {
        if (!(await agent.exists())) return json({ error: `no agent '${route.id}'` }, 404);
        if (route.action === "history") return json(await agent.getHistory());
        // Live CLI output. `since` returns only what is new, so a watcher
        // polls without re-reading the whole run each time.
        if (route.action === "output") {
          const since = Number(new URL(request.url).searchParams.get("since") ?? 0);
          return json(await agent.getOutput(Number.isFinite(since) ? since : 0));
        }
        if (route.action === "status") return json(await agent.status());
        return json(await agent.snapshot());
      }
      case "configure": {
        const out = await agent.configure(await bodyOf(request));
        if (out.missing) return json({ error: `no agent '${route.id}'` }, 404);
        // The registry holds its own copy of model/harness/machine for the
        // dashboard, so a spec change that skipped it left the list showing
        // hardware the agent no longer runs on, with nothing to correct it.
        const spec = out.spec!;
        await registry(env).register({
          id: route.id,
          model: spec.model,
          harness: spec.harness,
          machine: spec.machine,
          createdAt: Date.now(),
        });
        return json(spec);
      }

      // Move an agent onto a different harness or model, keeping its history:
      // a subscription hits its limit, or a cheap model is not up to the job.
      case "handoff": {
        const body = await bodyOf<{ harness?: string; model?: string; reason?: string }>(request);
        const out = await agent.handoff(body);
        if (out.missing) return json({ error: `no agent '${route.id}'` }, 404);
        const spec = out.spec!;
        // The registry keeps its own copy for the dashboard, so a handoff that
        // skipped it would leave the list naming the model the agent just left.
        await registry(env).register({
          id: route.id,
          model: spec.model,
          harness: spec.harness,
          machine: spec.machine,
          createdAt: Date.now(),
        });
        return json({ ok: true, from: out.from, spec });
      }

      case "restore": {
        // Restore may create: putting a backup under a fresh name is the point
        // of having one. It registers the result, so a restored agent is a
        // listed, deletable agent rather than one only its creator can find.
        const outcome = await agent.restore(await bodyOf(request));
        // A snapshot that cannot restore is reported rather than half-applied:
        // nothing was deleted, and the agent that was there is untouched.
        if (!outcome.ok) return json({ error: "snapshot cannot be restored", ...outcome }, 400);
        const spec = await agent.getSpec();
        await registry(env).register({
          id: route.id,
          model: spec.model,
          harness: spec.harness,
          machine: spec.machine,
          createdAt: Date.now(),
        });
        // What was actually taken, and anything the snapshot carried that
        // restore declined to write. A silent `{ok:true}` gives no way to tell
        // a full recovery from one that quietly dropped half its input.
        return json(outcome);
      }
      case "wake": {
        const out = await agent.fireWakeup();
        if (out?.missing) return json({ error: `no agent '${route.id}'` }, 404);
        return json({ ok: true });
      }

      // A standing task on an agent that was never launched is a recurring
      // alarm nothing owns: it does not appear in the dashboard, so nothing
      // will ever delete it, and it wakes forever.
      case "schedule": {
        if (!(await agent.exists())) return json({ error: `no agent '${route.id}'` }, 404);
        return scheduleRoute(request, agent);
      }

      case "agents-md": {
        if (!(await agent.exists())) return json({ error: `no agent '${route.id}'` }, 404);
        if (request.method === "GET") return json(await agent.getAgentsMd());
        if (request.method === "DELETE") return json(await agent.setAgentsMd(null));
        const { content } = await bodyOf<{ content?: string }>(request);
        return json(await agent.setAgentsMd(content ?? null));
      }

      case "a2a": {
        // Agent-to-agent: `from` sends `text` to this agent.
        //
        // `depth` counts hops so a cycle between two agents cannot run forever;
        // it rides with the message because each agent only ever sees its own
        // turn and has nowhere local to keep a total.
        const { from, text, depth, async: isAsync } = await bodyOf<{
          from: string;
          text: string;
          depth?: number;
          async?: boolean;
        }>(request);
        const message = `[from agent ${from}] ${text}`;

        // Fanning out to several agents in turn would otherwise block the
        // sender for the sum of all their replies. An async send is accepted
        // and acknowledged; the work continues after the response is returned.
        if (isAsync) {
          if (!(await agent.exists())) return json({ error: `no agent '${route.id}'` }, 404);
          ctx.waitUntil(
            agent.send(message, "a2a", origin, depth).then(
              () => {},
              (e: unknown) => console.log(`a2a to ${route.id} failed: ${e}`),
            ),
          );
          return json({ from, to: route.id, accepted: true });
        }

        const out = await agent.send(message, "a2a", origin, depth);
        if (out.missing) return json({ error: `no agent '${route.id}'` }, 404);
        return json({ from, to: route.id, reply: out.reply });
      }

      case "tool": {
        if (!route.arg) return new Response("tool name required", { status: 400 });
        if (!(await agent.exists())) return json({ error: `no agent '${route.id}'` }, 404);
        const out = await agent.runTool(route.arg, await bodyOf(request));
        return out.error ? json({ error: out.error }, 400) : json({ result: out.result });
      }

      default:
        return new Response("unknown action", { status: 404 });
    }
  } catch (e) {
    return json({ error: String(e) }, 400);
  }
}

/** The standing task: GET reads it, DELETE clears it, POST sets it. */
async function scheduleRoute(request: Request, agent: AgentStub): Promise<Response> {
  if (request.method === "GET") return json(await agent.getSchedule());
  if (request.method === "DELETE") {
    await agent.unschedule();
    return json({ ok: true });
  }

  const { atMs, prompt, cadenceMs } = await bodyOf<{
    atMs?: number;
    prompt?: string;
    cadenceMs?: number;
  }>(request);
  if (!prompt) return json({ error: "prompt required" }, 400);

  // Default to one cadence from now, so callers can post { prompt, cadenceMs }
  // without computing a timestamp themselves.
  await agent.scheduleWakeup(atMs ?? Date.now() + (cadenceMs ?? 60_000), prompt, cadenceMs);
  return json(await agent.getSchedule());
}
