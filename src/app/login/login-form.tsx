"use client";

import { AlertCircle, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const subscribeToHydration = () => () => {};
const clientReady = () => true;
const serverNotReady = () => false;

export function LoginForm() {
  const router = useRouter();
  // React uses the server snapshot during SSR and initial hydration. Enable
  // controls only on its subsequent client snapshot, after handlers attach.
  const hydrated = useSyncExternalStore(subscribeToHydration, clientReady, serverNotReady);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!hydrated || isPending) return;
    setError(null);
    setIsPending(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(payload?.error ?? "Login failed. Please try again.");
        return;
      }
      router.push("/workspaces");
      router.refresh();
    } catch {
      setError("Login failed. Please try again.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} aria-busy={!hydrated || isPending} className="w-full space-y-5">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <Input
          id="email"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          required
          autoComplete="email"
          disabled={!hydrated || isPending}
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <Input
          id="password"
          type="password"
          placeholder="••••••••"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          required
          autoComplete="current-password"
          disabled={!hydrated || isPending}
        />
      </div>
      <Button type="submit" className="mt-2 w-full" size="lg" disabled={!hydrated || isPending}>
        {isPending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Signing in…
          </>
        ) : (
          "Sign in"
        )}
      </Button>
    </form>
  );
}
