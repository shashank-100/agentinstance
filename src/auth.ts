// Who is asking.
//
// Until now a deployment had one credential — `FLEET_TOKEN` — and everything
// behind it belonged to nobody in particular. That is fine for one person and
// wrong for two: agents, tasks and transcripts would all be shared, and worse,
// two people who both name an agent `reviewer` do not get two agents with a
// visibility bug between them. `idFromName` means they get the *same Durable
// Object* — one memory, one container, one conversation. Isolation therefore
// has to happen in the address, not in a `WHERE` clause, and an address needs
// to know whose it is. That is what this file answers.
//
// Sign-in is GitHub's, through the App the deployment already owns. The users
// are developers signing in to work on repositories, so it is the identity they
// already have, and it doubles as the GitHub connection each of them needs.
import type { Env } from "./types.js";

/**
 * A signed-in person.
 *
 * The GitHub login is the id. It is stable, unique, and already the name under
 * which their repositories and installations exist — inventing a separate
 * internal id would mean keeping two things in step for no gain.
 */
export interface User {
  login: string;
  name?: string;
  avatarUrl?: string;
}

/** How long a session lasts before the person signs in again. */
const SESSION_DAYS = 30;

const COOKIE = "ai_session";

const enc = new TextEncoder();

/**
 * The key a session is signed with.
 *
 * The App's private key, reused. It is already present wherever GitHub works
 * at all, it is already used to sign JWTs (`github-app.ts`), and a deployment
 * that rotates it invalidates every session — which is the correct behaviour,
 * not a bug. A separate `SESSION_SECRET` would be one more thing to set and one
 * more thing to forget.
 */
async function signingKey(env: Env): Promise<CryptoKey | null> {
  const material = env.GITHUB_APP_PRIVATE_KEY ?? env.FLEET_TOKEN;
  if (!material) return null;
  return crypto.subtle.importKey(
    "raw",
    enc.encode(material),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of view) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const unb64url = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/**
 * A session as a signed string: `<payload>.<signature>`.
 *
 * Stateless on purpose. A session table would be a third Durable Object to
 * read on every request, on the hot path of every route, to learn something
 * the cookie can carry by itself.
 */
export async function issueSession(env: Env, user: User): Promise<string | null> {
  const key = await signingKey(env);
  if (!key) return null;
  const payload = b64url(
    enc.encode(
      JSON.stringify({
        login: user.login,
        name: user.name,
        avatarUrl: user.avatarUrl,
        exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
      }),
    ),
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

/**
 * The person a session names, or null.
 *
 * Verified before it is read: an unsigned payload is a cookie anyone can write,
 * and reading it first would make the signature decorative.
 */
export async function readSession(env: Env, token: string): Promise<User | null> {
  const key = await signingKey(env);
  if (!key) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;

  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      "HMAC",
      key,
      unb64url(sig) as unknown as ArrayBuffer,
      enc.encode(payload),
    );
  } catch {
    return null; // a malformed signature is a failed one, not an error
  }
  if (!ok) return null;

  try {
    const body = JSON.parse(new TextDecoder().decode(unb64url(payload))) as {
      login?: string;
      name?: string;
      avatarUrl?: string;
      exp?: number;
    };
    if (!body.login || !body.exp || body.exp < Date.now()) return null;
    return { login: body.login, name: body.name, avatarUrl: body.avatarUrl };
  } catch {
    return null;
  }
}

/** The session cookie on a request, if there is one. */
export function sessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

/** `Set-Cookie` for a session, or for clearing one. */
export const sessionHeader = (token: string | null): string =>
  token
    ? `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`
    : `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

/**
 * May this login sign in?
 *
 * Invite-only, and closed by default. Every agent runs on the deployment's own
 * subscription and every task boots a container, so an open sign-up is an open
 * invitation to spend someone else's money. A deployment that has not said who
 * may in has not said "everyone".
 *
 * `ALLOWED_LOGINS` is a comma-separated list of GitHub logins. Comparison is
 * case-insensitive, because GitHub logins are.
 */
export function allowed(env: Env, login: string): boolean {
  const list = (env.ALLOWED_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return false;
  return list.includes(login.toLowerCase());
}

/**
 * Who is making this request.
 *
 * Two credentials, deliberately. A person carries a session cookie. An agent's
 * tools call back from inside a container over plain HTTP with no cookie and no
 * browser, and they carry `FLEET_TOKEN` — so that stays valid and means "a
 * machine belonging to this deployment".
 *
 * `machine` is returned rather than a user because a tool call acts on the
 * agent it came from, whose owner the route already knows from the agent id.
 */
export async function whoIs(
  request: Request,
  env: Env,
): Promise<{ user: User | null; machine: boolean }> {
  const cookie = sessionCookie(request);
  if (cookie) {
    const user = await readSession(env, cookie);
    if (user) return { user, machine: false };
  }

  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const param = new URL(request.url).searchParams.get("token") ?? "";
  const machine =
    Boolean(env.FLEET_TOKEN) && (bearer === env.FLEET_TOKEN || param === env.FLEET_TOKEN);

  return { user: null, machine };
}

/**
 * Exchange GitHub's code for the person it belongs to.
 *
 * The App's own OAuth credentials — a GitHub App can sign users in without a
 * separate OAuth App, so this is the one the deployment already has.
 */
export async function exchangeCode(
  env: Env,
  code: string,
): Promise<{ user?: User; error?: string }> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return { error: "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are not set" };
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  const tokenBody = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string;
    error_description?: string;
  };
  if (!tokenBody.access_token) {
    return { error: tokenBody.error_description ?? "GitHub refused the code" };
  }

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${tokenBody.access_token}`,
      accept: "application/vnd.github+json",
      "user-agent": "agentinstance",
    },
  });
  const who = (await userRes.json().catch(() => ({}))) as {
    login?: string;
    name?: string;
    avatar_url?: string;
  };
  if (!who.login) return { error: "GitHub did not say who that was" };

  return { user: { login: who.login, name: who.name, avatarUrl: who.avatar_url } };
}
