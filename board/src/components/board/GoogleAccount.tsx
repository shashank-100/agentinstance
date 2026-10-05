import { useMe } from "./sign-in";
import { apiUrl } from "@/lib/api";

export function GoogleAccount() {
  const { data: me, isPending } = useMe();
  if (isPending) return <span className="text-xs text-muted-foreground">Checking account…</span>;
  return me ? (
    <div className="flex items-center gap-3 text-xs">
      <span className="max-w-48 truncate" title={me.name ?? me.login}>{me.name ?? me.login}</span>
      <a href={apiUrl("/auth/logout")} className="text-muted-foreground hover:text-foreground">Sign out</a>
    </div>
  ) : (
    <a href={apiUrl("/gmail/connect")} className="rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-surface-2" title="Sign in or create an account with Google and connect Gmail">Sign in with Google</a>
  );
}
