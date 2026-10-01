import { createFileRoute } from "@tanstack/react-router";
import { Planner } from "@/components/planner";

export const Route = createFileRoute("/")({
  ssr: false,
  component: Home,
});

function Home() {
  return (
    <main className="min-h-dvh bg-bg text-fg">
      <Planner />
    </main>
  );
}
