import { createFileRoute, Link } from "@tanstack/react-router";
import { Shell } from "@/components/cockpit/Shell";
import { GitHubConnect } from "@/components/cockpit/GitHubConnect";
import { Button } from "@/components/ui/button";
import { ArrowUpRight } from "lucide-react";

const title = "agentinstance — agent runs, reviewed as pull requests";
const description =
  "agentinstance dispatches coding agents into ephemeral cloud microVMs and returns their work as pull requests: diffs, sandbox checks, live terminal streams.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Overview,
});

const examples = [
  // Starting points, not real work: phrased as the kind of job this queue
  // takes — bounded, repo-scoped, ending in a pull request.
  "Find and fix a failing test, then open a pull request",
  "Update the dependencies that have security advisories",
  "Add missing test coverage for the module with the least",
];

function Overview() {
  return (
    <Shell>
      <div className="px-5 py-10 sm:px-8 lg:px-10">
        <section className="max-w-3xl rounded-lg border border-border bg-surface p-6 sm:p-8">
          <h1 className="font-display text-2xl font-medium leading-snug">
            Describe the change. Pick the harness.
          </h1>
          <ul className="mt-4 space-y-1.5">
            {examples.map((e) => (
              <li key={e}>
                <Link
                  to="/dispatch"
                  search={{ prompt: e }}
                  className="group flex w-full items-center gap-3 rounded-md border border-border bg-background/40 px-3 py-2.5 text-left text-[13px] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
                >
                  <span className="truncate">{e}</span>
                  <ArrowUpRight className="ml-auto size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                </Link>
              </li>
            ))}
          </ul>
          <Button asChild size="sm" className="mt-4">
            <Link to="/dispatch">Dispatch task</Link>
          </Button>
        </section>

        <div className="mx-auto mt-4 max-w-2xl">
          <GitHubConnect />
        </div>
      </div>
    </Shell>
  );
}
