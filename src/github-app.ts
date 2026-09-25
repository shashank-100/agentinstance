/**
 * GitHub App credentials.
 *
 * A personal access token is the wrong shape for this. Someone has to mint it
 * by hand, tick the right permission boxes, and paste it somewhere — and the
 * failure when they miss a box is a 403 at `git push`, long after the token
 * looked fine. It also never expires on its own and carries whatever access
 * the person who made it happened to have.
 *
 * A GitHub App inverts all of that. Permissions are declared once, in the app
 * itself; installing is a consent screen rather than a form; and the tokens it
 * mints last an hour, so a leak stops mattering on its own. The install also
 * records *which* repositories were granted, which is the access boundary a
 * PAT cannot express.
 *
 * The exchange is: a JWT signed with the app's private key proves "I am this
 * app", and is good only for asking GitHub about installations. An
 * installation access token — scoped to one install and its repositories — is
 * what actually touches a repo, and is what we hand to git.
 */

/** An installation token and the moment it stops being valid. */
type CachedToken = { token: string; expiresAt: number };

/** Cached per installation. A worker isolate may serve many requests, and
 *  minting a token per git command would be a round trip each time. */
const tokenCache = new Map<string, CachedToken>();

/** Re-mint this long before expiry, so a token cannot lapse mid-push. */
const RENEW_MARGIN_MS = 5 * 60 * 1000;

const b64url = (data: ArrayBuffer | string): string => {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * Import a PEM private key for RS256 signing.
 *
 * GitHub issues PKCS#1 ("BEGIN RSA PRIVATE KEY"); WebCrypto only imports
 * PKCS#8 ("BEGIN PRIVATE KEY"). Converting between them means re-wrapping DER,
 * so rather than do that at run time we ask for a PKCS#8 key in the first
 * place and say so plainly when we get the other one — a silent failure here
 * looks like an authentication bug much further down.
 */
async function importKey(pem: string): Promise<CryptoKey> {
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is in PKCS#1 format. Convert it with: " +
        "openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem",
    );
  }
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * A JWT proving we are the app. Good for ten minutes, which is GitHub's
 * ceiling; `iat` is backdated a minute because GitHub rejects a token whose
 * issue time is in its future, and clocks disagree.
 */
async function appJwt(appId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }),
  );
  const key = await importKey(privateKey);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

const GH_HEADERS = {
  accept: "application/vnd.github+json",
  // GitHub rejects requests without one.
  "user-agent": "agentinstance",
};

/**
 * An installation access token: what actually authenticates a git operation.
 *
 * Scoped to the installation, so it reaches exactly the repositories that were
 * granted at install time and nothing else. Cached until shortly before it
 * expires.
 */
export async function installationToken(
  appId: string,
  privateKey: string,
  installationId: string,
): Promise<{ token?: string; error?: string }> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - RENEW_MARGIN_MS > Date.now()) {
    return { token: cached.token };
  }

  let jwt: string;
  try {
    jwt = await appJwt(appId, privateKey);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "could not sign app JWT" };
  }

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    { method: "POST", headers: { ...GH_HEADERS, authorization: `Bearer ${jwt}` } },
  );
  const body = (await res.json().catch(() => ({}))) as {
    token?: string;
    expires_at?: string;
    message?: string;
  };
  if (!res.ok || !body.token) {
    return { error: body.message ?? `github returned ${res.status}` };
  }

  tokenCache.set(installationId, {
    token: body.token,
    expiresAt: body.expires_at ? Date.parse(body.expires_at) : Date.now() + 3600_000,
  });
  return { token: body.token };
}

/**
 * Which installation covers a repository.
 *
 * Saves the caller from tracking installation ids: given `owner/name`, GitHub
 * says which installation (if any) was granted it. A 404 here is the ordinary
 * "not installed there" answer, not a failure, so it is reported as advice
 * rather than an error code.
 */
export async function installationForRepo(
  appId: string,
  privateKey: string,
  repo: string,
): Promise<{ installationId?: string; error?: string }> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return { error: `'${repo}' is not owner/name` };

  let jwt: string;
  try {
    jwt = await appJwt(appId, privateKey);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "could not sign app JWT" };
  }

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${name}/installation`,
    { headers: { ...GH_HEADERS, authorization: `Bearer ${jwt}` } },
  );
  if (res.status === 404) {
    return {
      error:
        `the GitHub App is not installed on ${repo}. Install it there, ` +
        `granting Contents and Pull requests write access.`,
    };
  }
  const body = (await res.json().catch(() => ({}))) as {
    id?: number;
    message?: string;
  };
  if (!res.ok || !body.id) {
    return { error: body.message ?? `github returned ${res.status}` };
  }
  return { installationId: String(body.id) };
}

/**
 * Who an installation belongs to, according to GitHub.
 *
 * The account that installed it — a user login or an organisation name. Read
 * from GitHub rather than taken from whoever is asking: `/github/installed` is
 * a redirect anybody can hit with any `installation_id` in the query, and
 * believing that number would let one person claim another's installation and
 * every repository in it.
 */
export async function installationAccount(
  appId: string,
  privateKey: string,
  installationId: string,
): Promise<{ account?: string; error?: string }> {
  let jwt: string;
  try {
    jwt = await appJwt(appId, privateKey);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "could not sign app JWT" };
  }

  const res = await fetch(`https://api.github.com/app/installations/${installationId}`, {
    headers: { ...GH_HEADERS, authorization: `Bearer ${jwt}` },
  });
  const body = (await res.json().catch(() => ({}))) as {
    account?: { login?: string };
    message?: string;
  };
  if (!res.ok || !body.account?.login) {
    return { error: body.message ?? `github returned ${res.status}` };
  }
  return { account: body.account.login };
}

/**
 * The credential to use for a repository, whichever way this deployment is
 * configured.
 *
 * The App is preferred when configured, and a PAT still works: a deployment
 * that already had one keeps running, and the App is an upgrade rather than a
 * migration. Callers get a token and do not care which kind it is.
 */
export async function tokenForRepo(
  env: { GITHUB_APP_ID?: string; GITHUB_APP_PRIVATE_KEY?: string; GITHUB_TOKEN?: string },
  repo: string,
  /**
   * The login whose agent is asking, when there is one.
   *
   * Without it, an installation *is* the permission: `installationForRepo`
   * answers for any repository the App was ever installed on, whoever is
   * asking. On a deployment with two people that means one can name the
   * other's private repository and be handed a working token for it. With it,
   * a repository is reachable only through an installation its owner made.
   *
   * Undefined means an unowned agent — everything that predates sign-in — and
   * keeps working exactly as before. Tightening that would stop every agent
   * already running.
   */
  owner?: string,
): Promise<{ token?: string; error?: string }> {
  if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY) {
    const found = await installationForRepo(
      env.GITHUB_APP_ID,
      env.GITHUB_APP_PRIVATE_KEY,
      repo,
    );
    if (found.error) return { error: found.error };

    if (owner) {
      // One extra call per clone or push, and worth it: the alternative is a
      // boundary that exists only in the UI.
      const acct = await installationAccount(
        env.GITHUB_APP_ID,
        env.GITHUB_APP_PRIVATE_KEY,
        found.installationId!,
      );
      if (acct.error) return { error: acct.error };
      // An organisation the person belongs to is a legitimate grant, so the
      // check is on the installation's account, not on the repository owner.
      if (acct.account?.toLowerCase() !== owner.toLowerCase()) {
        return {
          error:
            `${repo} is reached through an installation belonging to ` +
            `${acct.account}, not ${owner}. Install the app on it yourself.`,
        };
      }
    }

    return installationToken(
      env.GITHUB_APP_ID,
      env.GITHUB_APP_PRIVATE_KEY,
      found.installationId!,
    );
  }
  if (env.GITHUB_TOKEN) return { token: env.GITHUB_TOKEN };
  return {
    error:
      "no GitHub credentials: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY " +
      "(preferred), or GITHUB_TOKEN",
  };
}

/**
 * True when either credential is configured — what the catalog gates on.
 *
 * Takes an open record so the catalog can pass its own `KeyEnv` without a
 * cast. A blank string counts as absent: an unset `wrangler secret` and one
 * set to "" are the same thing to every caller, and treating the second as
 * configured offers a capability that fails on first use.
 */
export const hasGitHubCredentials = (env: {
  GITHUB_APP_ID?: unknown;
  GITHUB_APP_PRIVATE_KEY?: unknown;
  GITHUB_TOKEN?: unknown;
}): boolean => {
  const set = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
  return (set(env.GITHUB_APP_ID) && set(env.GITHUB_APP_PRIVATE_KEY)) || set(env.GITHUB_TOKEN);
};

/** One file a pull request touches, as GitHub reports it. */
export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  /** The unified diff for this file. Absent on binaries and very large files,
   *  which GitHub omits rather than inlining. */
  patch?: string;
}

/**
 * What a pull request changed.
 *
 * The queue records that a PR exists, not what is in it — a diff belongs to
 * GitHub, and copying one into a task row would be a second copy to keep in
 * step with the branch. Fetching it when someone looks costs a request and is
 * always current.
 *
 * Read through the App the deployment already holds, so the credential stays
 * on this side: a browser asking GitHub directly would need a token of its own.
 */
export async function pullRequestFiles(
  env: { GITHUB_APP_ID?: string; GITHUB_APP_PRIVATE_KEY?: string; GITHUB_TOKEN?: string },
  repo: string,
  number: number,
): Promise<{ files?: ChangedFile[]; error?: string }> {
  const got = await tokenForRepo(env, repo);
  if (got.error) return { error: got.error };

  // 100 is GitHub's page limit. A pull request with more files than that is
  // not one anybody reads in a tab, so the first page is the whole story here.
  const res = await fetch(
    `https://api.github.com/repos/${repo}/pulls/${number}/files?per_page=100`,
    { headers: { ...GH_HEADERS, authorization: `Bearer ${got.token}` } },
  );
  const body = (await res.json().catch(() => ({}))) as
    | { message?: string }
    | {
        filename: string;
        status: string;
        additions: number;
        deletions: number;
        patch?: string;
      }[];
  if (!res.ok || !Array.isArray(body)) {
    return {
      error: (body as { message?: string }).message ?? `github returned ${res.status}`,
    };
  }
  return {
    files: body.map((f) => ({
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    })),
  };
}
