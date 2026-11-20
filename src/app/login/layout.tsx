export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return (
    <main
      id="main-content"
      className="crt-grid crt-scanlines grid min-h-[var(--app-viewport-height)] place-items-center px-4 py-8"
    >
      <div className="w-full max-w-md rounded-lg border border-primary/25 bg-card px-6 py-8 sm:px-10 sm:py-10">
        {children}
      </div>
    </main>
  );
}
