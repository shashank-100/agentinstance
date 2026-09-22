import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Github, ExternalLink, AlertTriangle } from "lucide-react";

/**
 * How this deployment reaches GitHub, and how to change it.
 *
 * Worth a panel of its own because the failure it prevents is a bad one: a
 * token with read access clones and commits perfectly well and then fails at
 * `git push` with a 403, minutes into a run. Nothing before that moment looks
 * wrong, and the API cannot warn about it — the `permissions` block GitHub
 * returns for a repository describes the *account's* access, not the token's
 * grants, so a read-only token is indistinguishable from a writable one until
 * a write is attempted.
 *
 * A GitHub App has no such ambiguity: the permissions are declared by the app,
 * installing is a consent screen rather than a form, and the tokens it mints
 * expire in an hour.
 */
type Status = {
  credential: "github-app" | "personal-access-token" | "none";
  canVerifyPermissions: boolean;
  installUrl: string | null;
};

const BASE = import.meta.env["VITE_AGENT_URL"] ?? "";
const TOKEN = import.meta.env["VITE_FLEET_TOKEN"] ?? "";

async function fetchGitHubStatus(): Promise<Status> {
  const res = await fetch(`${BASE}/github/status`, {
    headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
  });
  if (!res.ok) throw new Error(`github/status returned ${res.status}`);
  return (await res.json()) as Status;
}

export function GitHubConnect() {
  const { data, isLoading } = useQuery({
    queryKey: ["github", "status"],
    queryFn: fetchGitHubStatus,
    refetchInterval: 30000,
  });

  if (isLoading || !data) return null;

  const connected = data.credential !== "none";
  const viaApp = data.credential === "github-app";

  // A working connection is not news. Once the App is installed there is
  // nothing here to act on, so the panel shrinks to a line that confirms it
  // and offers the only thing still worth reaching — which repositories are
  // granted. The full panel is for the states that need a decision.
  if (viaApp) {
    return (
      <p className="flex items-center gap-2 px-1 font-mono text-[11px] text-muted-foreground">
        <Github className="size-3" />
        <span className="text-success">GitHub connected</span>
        <a
          href={`${BASE}${data.installUrl ?? "/github/install"}`}
          className="ml-auto underline-offset-2 hover:text-foreground hover:underline"
        >
          Manage repositories
        </a>
      </p>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-5">
      <div className="flex items-start gap-3">
        <Github className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-sm font-medium">GitHub</h2>
            <span
              className={
                "rounded-sm px-1.5 py-0.5 font-mono text-[10px] " +
                (connected ? "bg-warning/10 text-warning" : "bg-destructive/10 text-destructive")
              }
            >
              {connected ? "token" : "not connected"}
            </span>
          </div>

          {connected ? (
            <>
              <p className="mt-2 flex items-start gap-1.5 text-[13px] leading-relaxed text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" />
                Using a personal access token. Its permissions cannot be checked from here — if it
                lacks <span className="font-mono">Contents</span> and{" "}
                <span className="font-mono">Pull requests</span> write access, agents will clone and
                commit fine and then fail at push with a 403.
              </p>
              <ul className="mt-2 space-y-0.5 pl-4 font-mono text-[11px] text-muted-foreground">
                <li>· Contents: Read and write</li>
                <li>· Pull requests: Read and write</li>
              </ul>
            </>
          ) : (
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
              Agents cannot reach GitHub. Until this is connected,{" "}
              <span className="font-mono">git_repo</span> and{" "}
              <span className="font-mono">open_pr</span> are not offered to them at all.
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            {data.installUrl ? (
              <Button asChild size="sm">
                <a href={`${BASE}${data.installUrl}`}>
                  Connect GitHub
                  <ExternalLink className="ml-1.5 size-3" />
                </a>
              </Button>
            ) : (
              // No app configured on this deployment, so there is nothing to
              // send the user to. Saying so beats a button that 400s.
              <p className="font-mono text-[11px] text-muted-foreground">
                No GitHub App on this deployment — set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY and
                GITHUB_APP_SLUG to offer one-click connect.
              </p>
            )}
            {connected && (
              <Button asChild size="sm" variant="outline">
                <a
                  href="https://github.com/settings/personal-access-tokens"
                  target="_blank"
                  rel="noreferrer"
                >
                  Edit token permissions
                  <ExternalLink className="ml-1.5 size-3" />
                </a>
              </Button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
