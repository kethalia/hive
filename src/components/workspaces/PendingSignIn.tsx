import { ExternalLink } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { AccountChallengeExpiry } from "./AccountChallengeExpiry";
import { DeviceCode } from "./ConnectionStatus";

export function SignInLink({
  provider,
  href,
  expiresAt,
  onExpired,
  ref,
}: {
  provider: string;
  href: string;
  expiresAt: number;
  onExpired: () => void;
  ref?: Ref<HTMLAnchorElement>;
}) {
  return (
    <a
      ref={ref}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={buttonVariants({
        size: "sm",
        className: "h-auto min-h-10 whitespace-normal py-2",
      })}
      onClick={(event) => {
        if (expiresAt <= Date.now()) {
          event.preventDefault();
          onExpired();
        }
      }}
    >
      Open {provider} <ExternalLink aria-hidden="true" className="size-4" />
    </a>
  );
}

type SignInProgress = {
  expiresAt: number;
  remaining: number;
  onCancel: () => void;
  cancelDisabled: boolean;
  cancelling: boolean;
};

export function PendingSignIn({
  instructions,
  children,
  expiresAt,
  remaining,
  primaryAction,
  onCancel,
  cancelDisabled,
  cancelling,
}: Omit<SignInProgress, "expiresAt" | "remaining"> & {
  expiresAt?: number;
  remaining?: number;
  instructions?: string;
  children?: ReactNode;
  primaryAction?: ReactNode;
}) {
  return (
    <div className="mx-auto max-w-md space-y-4 text-center">
      {instructions && <p className="text-sm text-muted-foreground">{instructions}</p>}
      {children}
      {expiresAt !== undefined && remaining !== undefined && (
        <AccountChallengeExpiry expiresAt={expiresAt} remaining={remaining} />
      )}
      <div className="flex flex-wrap items-stretch gap-2">
        {primaryAction && <div className="flex min-w-28 flex-1 [&>*]:w-full">{primaryAction}</div>}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={cancelDisabled}
          onClick={onCancel}
        >
          {cancelling ? "Cancelling…" : "Cancel sign-in"}
        </Button>
      </div>
    </div>
  );
}

export function DeviceSignIn({
  provider,
  challenge,
  onExpired,
  linkRef,
  ...progress
}: SignInProgress & {
  provider: string;
  challenge: { code: string; url: string };
  onExpired: () => void;
  linkRef?: Ref<HTMLAnchorElement>;
}) {
  const active = progress.remaining > 0;
  return (
    <PendingSignIn
      {...progress}
      instructions={active ? `Enter this code on ${provider}.` : undefined}
      primaryAction={
        active ? (
          <SignInLink
            ref={linkRef}
            provider={provider}
            href={challenge.url}
            expiresAt={progress.expiresAt}
            onExpired={onExpired}
          />
        ) : undefined
      }
    >
      {active && (
        <DeviceCode
          code={challenge.code}
          expiresAt={progress.expiresAt}
          disabled={progress.cancelDisabled}
          onExpired={onExpired}
        />
      )}
    </PendingSignIn>
  );
}
