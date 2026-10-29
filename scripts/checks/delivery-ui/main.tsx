import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DeliveryPanel } from "../../../src/components/delivery/DeliveryPanel";
import { ConversationView } from "../../../src/components/projects/ConversationView";
import { Button } from "../../../src/components/ui/button";
import type { SessionView } from "../../../src/lib/codex-session/adapter";
import "../../../src/app/globals.css";

// Explicitly synthetic, build-only harness. Never included in an application route.
const taskId = "22222222-2222-4222-8222-222222222222";
const reportId = "33333333-3333-4333-8333-333333333333";
const now = "2026-10-29T12:00:00.000Z";
const summary = {
  id: taskId,
  outcome: "Recover the same conversation after a network interruption",
  projectName: "kethalia/hive",
  branch: "codex/delivery-system-design",
  sourceSha: "a".repeat(40),
  createdAt: now,
  version: 1,
  pauseRequested: false,
  schedulingPaused: false,
  releaseMode: "disabled",
  counts: { total: 1, succeeded: 1, attention: 0 },
};
const detail = {
  ...summary,
  steps: [
    {
      id: "44444444-4444-4444-8444-444444444444",
      kind: "validate",
      state: "succeeded",
      acceptancePhase: "implementation_preview",
      attemptCount: 1,
      attemptBudget: 3,
      dependencies: [],
      latestAttempt: {
        requestedModel: "GPT-6.1 Sol",
        effectiveModel: "GPT-6.1 Sol",
        requestedEffort: "high",
        effectiveEffort: "high",
        outcome: "succeeded",
        startedAt: now,
        finishedAt: now,
      },
      reports: [
        {
          id: reportId,
          summary: "Synthetic reconnect check passed",
          difficulty: "moderate",
          difficultyReason:
            "The fixture exercises an interrupted stream and repeated completion events.",
          issues: [
            {
              summary: "A delayed event arrived after hydration.",
              resolution: "Reconciled from the authoritative snapshot.",
            },
          ],
          remainingUncertainty:
            "This harness does not validate a deployed native session or production traffic.",
          nextAction: "Run the authenticated shared-session browser pilot.",
          createdAt: now,
          evidence: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              kind: "check",
              status: "passed",
              verificationMode: "simulated",
              environment: "browser component fixture",
              sourceSha: "a".repeat(40),
              observedAt: now,
              invalidatedAt: null,
            },
          ],
        },
      ],
    },
  ],
};
let revoked = false;
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("/api/delivery/tasks")) return originalFetch(input, init);
  if (revoked) return Response.json({ error: "not_authenticated" }, { status: 401 });
  return Response.json(
    url.split("?")[0].endsWith(taskId) ? detail : { tasks: [summary], nextCursor: null },
  );
};
const view: SessionView = {
  phase: "live",
  needsRefresh: false,
  error: null,
  turns: Array.from({ length: 45 }, (_, index): SessionView["turns"][number] => ({
    id: `turn-${index}`,
    status: "completed",
    itemsView: "full",
    items: [
      {
        id: `user-${index}`,
        type: "userMessage",
        content: [{ type: "text", text: `Please validate step ${index + 1}.` }],
      },
      {
        id: `agent-${index}`,
        type: "agentMessage",
        text: `Step ${index + 1} report: the same conversation remains available. This is synthetic UI evidence.`,
      },
      ...(index === 44
        ? [
            {
              id: "command",
              type: "commandExecution" as const,
              command: "pnpm test",
              status: "completed",
              exitCode: 0,
              aggregatedOutput: "Fixture: 15 checks passed. <script>must remain text</script>",
            },
          ]
        : []),
    ],
  })),
};
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function App() {
  const [tab, setTab] = useState("delivery");
  const [terminal, setTerminal] = useState(false);
  return (
    <QueryClientProvider client={queryClient}>
      <main className="h-dvh overflow-auto bg-background text-foreground">
        <header className="flex flex-wrap items-center gap-2 border-b p-3">
          <h1 className="mr-auto font-semibold">Hive UI validation · synthetic data</h1>
          <Button onClick={() => setTab("delivery")}>Delivery fixture</Button>
          <Button onClick={() => setTab("conversation")}>Conversation fixture</Button>
          <Button
            variant="outline"
            onClick={() => {
              revoked = true;
              void queryClient.invalidateQueries();
            }}
          >
            Simulate expired session
          </Button>
        </header>
        <section className="mx-auto h-[calc(100dvh-10rem)] max-w-4xl">
          {tab === "delivery" ? (
            <DeliveryPanel userId="fixture-owner" enabled taskId={taskId} reportId={reportId} />
          ) : (
            <ConversationView
              sessionKey="fixture-thread"
              view={view}
              onReconnect={() => {}}
              onOpenTerminal={() => setTerminal(true)}
            />
          )}
          {terminal && (
            <p role="status">
              Terminal attachment requested for fixture-thread. No native process is started by this
              harness.
            </p>
          )}
        </section>
      </main>
    </QueryClientProvider>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Harness root is missing");
createRoot(root).render(<App />);
