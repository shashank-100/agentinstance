import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Shell } from "@/components/board/Shell";
import { GmailConnection } from "@/components/board/GmailConnection";

export const Route = createFileRoute("/connectors")({
  head: () => ({ meta: [{ title: "Connectors — agentinstance" }] }),
  component: ConnectorsPage,
});

function ConnectorsPage() {
  const navigate = useNavigate();
  return (
    <Shell>
      <div className="px-5 py-10 sm:px-8 lg:px-10">
        <section className="max-w-3xl">
          <h1 className="text-2xl font-semibold tracking-tight">Connectors</h1>
          <p className="mt-2 text-sm text-muted-foreground">Connect the apps your agents can use and manage their access.</p>
          <GmailConnection onExample={(prompt) => { void navigate({ to: "/dispatch", search: { prompt } }); }} />
        </section>
      </div>
    </Shell>
  );
}
