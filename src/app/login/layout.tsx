import { Hexagon } from "lucide-react";

export default function LoginLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-sm space-y-6 px-4">
        <div className="flex flex-col items-center gap-2">
          <Hexagon className="h-10 w-10 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">Hive</h1>
          <p className="text-sm text-muted-foreground">
            Sign in to your Coder instance
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}
