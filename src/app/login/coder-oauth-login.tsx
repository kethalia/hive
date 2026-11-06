import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export type CoderLoginError = "failed" | null;
const messages = {
  failed: "We couldn’t complete Coder sign-in. Please try again.",
};

/** Ordinary browser navigation starts OAuth. No prefetch, client-side token,
 * provider URL input or password collection is involved in this view. */
export function CoderOAuthLogin({
  available,
  error,
}: {
  available: boolean;
  error: CoderLoginError;
}) {
  return (
    <div className="w-full space-y-5">
      {(!available || error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {available && error
              ? messages[error]
              : "Coder sign-in is temporarily unavailable. Please try again later."}
          </AlertDescription>
        </Alert>
      )}
      <p className="text-sm leading-6 text-muted-foreground">
        Sign in and approve access on Coder. You’ll return to Hive to open your workspaces.
      </p>
      {available ? (
        <Button
          render={<a href="/api/auth/coder/start">Continue with Coder</a>}
          nativeButton={false}
          role="link"
          className="w-full"
          size="lg"
        >
          Continue with Coder
        </Button>
      ) : (
        <Button type="button" className="w-full" size="lg" disabled>
          Continue with Coder
        </Button>
      )}
    </div>
  );
}
