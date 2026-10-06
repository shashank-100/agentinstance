import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { DispatchForm } from "@/components/board/DispatchForm";

const title = "agentinstance — agent runs, reviewed as pull requests";
const description =
  "agentinstance dispatches coding agents into ephemeral cloud microVMs and returns their work as pull requests: diffs, sandbox checks, live terminal streams.";

// The home page *is* the dispatch form. An intermediate landing page that only
// linked here cost a click to reach the one thing this app does.
export const Route = createFileRoute("/")({
  validateSearch: z.object({ prompt: z.string().optional() }),
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
  component: Home,
});

function Home() {
  const { prompt } = Route.useSearch();
  return <DispatchForm initialPrompt={prompt} />;
}
