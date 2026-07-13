import Link from "next/link";

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return (
    <main
      id="main-content"
      className="crt-grid crt-scanlines grid min-h-[var(--app-viewport-height)] place-items-center px-4 py-10"
    >
      <div className="w-full max-w-md">
        <Link
          href="/"
          className="mb-8 inline-flex min-h-11 items-center gap-3 text-sm text-muted-foreground hover:text-primary"
        >
          <span
            className="grid size-9 place-items-center border border-primary/40 bg-primary/10 text-primary"
            aria-hidden="true"
          >
            H_
          </span>
          Return to hive.dev
        </Link>
        <div className="pixel-panel border border-primary/25 bg-card p-6 shadow-[0_0_60px_rgb(141_255_157/0.07)] sm:p-8">
          <div className="mb-8">
            <p className="text-xs uppercase tracking-[0.2em] text-primary">Secure operator link</p>
            <h1 className="mt-3 text-3xl font-medium tracking-[-0.04em]">Connect your Coder</h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Credentials establish a short-lived Hive session and are not stored in this browser.
            </p>
          </div>
          {children}
        </div>
      </div>
    </main>
  );
}
