import { ArrowRight, Boxes, Check, Github, Keyboard, ShieldCheck, Terminal } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { HiveLogo } from "@/components/hive-logo";

export const metadata: Metadata = {
  title: "Autonomous development, under your control",
  description:
    "Hive coordinates isolated Coder workspaces, AI agents, verification, and pull requests from one keyboard-first control plane.",
};

const workflow = [
  ["01", "Brief", "Describe the outcome, repository, and review depth."],
  ["02", "Isolate", "Hive provisions a clean Coder workspace for the run."],
  ["03", "Build + prove", "Agents implement, test, and verify by consuming the result."],
  ["04", "Review", "You receive an auditable branch and review-ready pull request."],
] as const;

const capabilities = [
  [
    Terminal,
    "Live session control",
    "Watch, compose, reconnect, and move between terminal sessions without losing context.",
  ],
  [
    Boxes,
    "Workspace isolation",
    "Each task runs in a dedicated Coder workspace with explicit lifecycle controls.",
  ],
  [
    ShieldCheck,
    "Proof before claims",
    "Verification is built into the workflow, with logs and artifacts kept visible.",
  ],
  [
    Keyboard,
    "Keyboard first",
    "A command palette and documented shortcuts keep high-frequency work one chord away.",
  ],
] as const;

export default function MarketingPage() {
  return (
    <div className="crt-grid crt-scanlines min-h-[var(--app-viewport-height)] bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-primary/15 bg-background/90 pt-safe backdrop-blur-md">
        <div className="mx-auto flex min-h-16 w-full max-w-7xl items-center justify-between gap-3 pl-[max(1rem,var(--safe-area-inset-left))] pr-[max(1rem,var(--safe-area-inset-right))] sm:px-6 lg:px-8">
          <Link href="/" className="flex min-h-11 items-center gap-3">
            <HiveLogo className="[&>span:first-child]:shadow-[3px_3px_0_rgb(141_255_157/0.12)]" />
          </Link>
          <nav aria-label="Primary" className="flex items-center gap-2 sm:gap-4">
            <a
              href="#workflow"
              className="hidden min-h-11 items-center px-2 text-sm text-muted-foreground hover:text-primary sm:flex"
            >
              Workflow
            </a>
            <a
              href="#capabilities"
              className="hidden min-h-11 items-center px-2 text-sm text-muted-foreground hover:text-primary md:flex"
            >
              System
            </a>
            <Link
              href="/login"
              className="inline-flex min-h-11 items-center gap-2 bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-[4px_4px_0_rgb(141_255_157/0.16)] transition-[scale,box-shadow] duration-150 active:scale-[0.96]"
            >
              <span className="hidden min-[380px]:inline">Open </span>console
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </nav>
        </div>
      </header>

      <main id="main-content">
        <section className="mx-auto grid min-h-[calc(100svh-4rem)] w-full max-w-7xl items-center gap-12 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[1.05fr_0.95fr] lg:px-8">
          <div>
            <p className="mb-6 inline-flex items-center gap-2 border border-primary/25 bg-primary/5 px-3 py-2 text-xs uppercase tracking-[0.18em] text-primary">
              <span className="size-2 animate-pulse bg-primary" aria-hidden="true" />
              Development control plane / online
            </p>
            <h1 className="max-w-4xl text-[clamp(2.6rem,8vw,6.8rem)] font-medium leading-[0.94] tracking-[-0.07em]">
              Ship the work.
              <span className="phosphor-text block">Keep the controls.</span>
            </h1>
            <p className="mt-8 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
              Hive turns an engineering brief into an isolated workspace, a verified implementation,
              and an auditable pull request—while you stay close to every terminal, decision, and
              proof.
            </p>
            <div className="mt-10 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/login"
                className="inline-flex min-h-12 items-center justify-center gap-2 bg-primary px-6 font-semibold text-primary-foreground shadow-[5px_5px_0_rgb(141_255_157/0.16)] transition-[scale,box-shadow] duration-150 active:scale-[0.96]"
              >
                Enter Hive <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
              <a
                href="#workflow"
                className="inline-flex min-h-12 items-center justify-center border border-primary/30 bg-card px-6 text-primary transition-[background-color,scale] duration-150 hover:bg-primary/10 active:scale-[0.96]"
              >
                Trace a run
              </a>
            </div>
            <ul
              className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-xs text-muted-foreground"
              aria-label="Product principles"
            >
              {["Self-hosted", "Coder-native", "Human in command"].map((item) => (
                <li key={item} className="flex items-center gap-2">
                  <Check className="size-3.5 text-primary" aria-hidden="true" /> {item}
                </li>
              ))}
            </ul>
          </div>

          <div className="pixel-panel relative border border-primary/25 bg-[#030604] p-2 shadow-[0_0_80px_rgb(141_255_157/0.08)]">
            <div className="flex items-center justify-between border-b border-primary/20 px-4 py-3 text-[0.68rem] uppercase tracking-[0.16em] text-muted-foreground">
              <span>hive://run/8F2A</span>
              <span className="text-primary">● live</span>
            </div>
            <div className="min-h-[420px] space-y-6 p-5 text-xs leading-6 sm:p-7 sm:text-sm">
              <div className="text-muted-foreground">
                <span className="text-primary">operator@hive</span>:~$ launch --repo kethalia/hive
              </div>
              <div className="grid gap-3">
                {[
                  ["hydrate", "done", "rules + repository context loaded"],
                  ["workspace", "done", "blush-scorpion-35 / isolated"],
                  ["implement", "running", "agent session attached"],
                  ["verify", "queued", "proof-by-consumption"],
                  ["pull-request", "waiting", "opens after gates pass"],
                ].map(([label, status, copy], index) => (
                  <div
                    key={label}
                    className="grid grid-cols-[1.2rem_1fr_auto] gap-3 border-b border-primary/10 pb-3"
                  >
                    <span className="tabular-nums text-muted-foreground">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <p className="text-foreground">{label}</p>
                      <p className="text-muted-foreground">{copy}</p>
                    </div>
                    <span
                      className={
                        status === "running"
                          ? "text-amber-300"
                          : status === "done"
                            ? "text-primary"
                            : "text-muted-foreground"
                      }
                    >
                      [{status}]
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-primary">▌ awaiting stream...</p>
            </div>
          </div>
        </section>

        <section id="workflow" className="border-y border-primary/15 bg-card/40 scroll-mt-16">
          <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
            <p className="text-xs uppercase tracking-[0.2em] text-primary">Run protocol</p>
            <div className="mt-4 flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
              <h2 className="max-w-3xl text-3xl font-medium tracking-[-0.04em] sm:text-5xl">
                From intent to evidence, in one observable loop.
              </h2>
              <p className="max-w-md text-sm leading-6 text-muted-foreground">
                No invisible handoff. Each stage has a state, owner, terminal, and recovery path.
              </p>
            </div>
            <ol className="mt-12 grid gap-px border border-primary/15 bg-primary/15 md:grid-cols-2 xl:grid-cols-4">
              {workflow.map(([number, title, copy]) => (
                <li key={number} className="min-h-56 bg-background p-6">
                  <span className="text-xs tabular-nums text-primary">/{number}</span>
                  <h3 className="mt-12 text-xl">{title}</h3>
                  <p className="mt-3 text-sm leading-6 text-muted-foreground">{copy}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section
          id="capabilities"
          className="mx-auto w-full max-w-7xl scroll-mt-16 px-4 py-20 sm:px-6 lg:px-8"
        >
          <p className="text-xs uppercase tracking-[0.2em] text-primary">Operator system</p>
          <h2 className="mt-4 max-w-3xl text-3xl font-medium tracking-[-0.04em] sm:text-5xl">
            Designed for intervention, not autopilot theatre.
          </h2>
          <div className="mt-12 grid gap-4 md:grid-cols-2">
            {capabilities.map(([Icon, title, copy]) => (
              <article
                key={title}
                className="pixel-panel border border-primary/15 bg-card p-6 sm:p-8"
              >
                <Icon className="size-6 text-primary" aria-hidden="true" />
                <h3 className="mt-8 text-xl">{title}</h3>
                <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">{copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="border-t border-primary/15 bg-primary text-primary-foreground">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-16 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] opacity-70">Ready signal</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">
                Your next run is waiting.
              </h2>
            </div>
            <Link
              href="/login"
              className="inline-flex min-h-12 items-center justify-center gap-2 bg-background px-6 text-foreground shadow-[5px_5px_0_rgb(7_16_9/0.25)] transition-[scale] duration-150 active:scale-[0.96]"
            >
              Open the console <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-primary/15">
        <div className="mx-auto flex min-h-20 w-full max-w-7xl flex-col justify-center gap-3 px-4 py-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <span>HIVE / autonomous development control plane</span>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 sm:justify-end">
            <a
              className="inline-flex min-h-10 items-center gap-2 hover:text-primary"
              href="https://github.com/kethalia/hive"
              target="_blank"
              rel="noreferrer"
            >
              <Github className="size-4" aria-hidden="true" /> Source
            </a>
            <span className="whitespace-nowrap text-muted-foreground/80">
              UI / UX by{" "}
              <a
                className="text-foreground underline-offset-4 hover:text-primary hover:underline"
                href="https://kethalia.com"
                target="_blank"
                rel="noreferrer"
              >
                Kethalia
              </a>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
