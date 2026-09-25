import { useQuery } from "@tanstack/react-query";
import { type ReactNode } from "react";

import { fetchMe, SignedOutError } from "@/lib/api";

/**
 * Who is signed in, cached for the session.
 *
 * `retry: false` because a 401 here is an answer, not a failure — retrying it
 * three times only delays the sign-in screen.
 */
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: fetchMe,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * The sign-in screen.
 *
 * A link, not a button with a handler: `/auth/login` is a redirect to GitHub,
 * and letting the browser follow it keeps the OAuth round trip out of the app.
 */
function SignIn({ denied }: { denied: string | null }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">agentinstance</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Run coding agents in cloud microVMs and review their work as pull requests.
        </p>

        {denied ? (
          // A refused login has done nothing wrong and pressed one button.
          // Saying who was refused and why beats a blank screen or a 403 body.
          <div className="mt-6 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-left text-sm text-foreground">
            <span className="font-medium">{denied}</span> is not on this deployment's invite
            list. Ask whoever runs it to add you.
          </div>
        ) : null}

        <a
          href="/auth/login"
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <svg viewBox="0 0 16 16" aria-hidden className="h-4 w-4 fill-current">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          Sign in with GitHub
        </a>

        <p className="mt-4 text-xs text-muted-foreground">Invite only.</p>
      </div>
    </div>
  );
}

/**
 * Renders the board to a signed-in person and the sign-in screen to anyone
 * else.
 *
 * One gate around the whole app rather than a check per route: every route
 * reads the same API, so a route that forgot the check would be a route that
 * showed a broken board instead of a sign-in screen.
 */
export function RequireSignIn({ children }: { children: ReactNode }) {
  const { data: me, isPending, error } = useMe();

  // Nothing at all while the answer is in flight. Rendering the signed-out
  // state first would flash a sign-in screen at a signed-in person on every
  // reload, which looks exactly like having been logged out.
  if (isPending) {
    return <div className="min-h-screen bg-background" />;
  }

  if (!me || error instanceof SignedOutError) {
    const denied =
      typeof window === "undefined"
        ? null
        : new URLSearchParams(window.location.search).get("denied");
    return <SignIn denied={denied} />;
  }

  return <>{children}</>;
}
