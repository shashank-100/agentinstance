import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { DispatchForm } from "@/components/board/DispatchForm";

export const Route = createFileRoute("/dispatch")({
  validateSearch: z.object({ prompt: z.string().optional() }),
  head: () => ({ meta: [
    { title: "Start a task — agentinstance" },
    { name: "description", content: "Describe your goal. Choose an available agent automatically and follow its work." },
  ] }),
  component: DispatchPage,
});

function DispatchPage() {
  const { prompt } = Route.useSearch();
  return <DispatchForm initialPrompt={prompt} />;
}
