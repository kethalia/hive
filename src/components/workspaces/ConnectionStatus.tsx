import { Copy, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingStatus } from "@/components/ui/loading-status";

export function CheckingConnection({ provider }: { provider: string }) {
  return <LoadingStatus>Checking {provider} connection…</LoadingStatus>;
}

export function ConnectedAccount({
  provider,
  workspace,
  account,
  plan,
}: {
  provider: string;
  workspace: string;
  account?: string | null;
  plan?: string | null;
}) {
  return (
    <section aria-label={`${provider} connection details`} className="min-w-0 space-y-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{provider} connection</h2>
        <Badge>Connected</Badge>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 rounded-md border p-4">
        <dt className="text-muted-foreground">Workspace</dt>
        <dd className="text-right [overflow-wrap:anywhere]">{workspace}</dd>
        {account && (
          <>
            <dt className="text-muted-foreground">Account</dt>
            <dd className="text-right [overflow-wrap:anywhere]">{account}</dd>
          </>
        )}
        {plan && (
          <>
            <dt className="text-muted-foreground">Plan</dt>
            <dd className="text-right [overflow-wrap:anywhere]">{plan}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

function ConnectionMessage({
  title,
  children,
  error = false,
}: {
  title: string;
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div role={error ? "alert" : "status"} className="space-y-1 text-sm">
      <h2 className={error ? "font-medium text-destructive" : "font-medium"}>{title}</h2>
      <p className="text-muted-foreground">{children}</p>
    </div>
  );
}

export function DisconnectedAccount({
  provider,
  children,
}: {
  provider: string;
  children: ReactNode;
}) {
  return (
    <ConnectionMessage title={`No ${provider} account connected`}>{children}</ConnectionMessage>
  );
}

export function ConnectionProblem({
  provider,
  children,
}: {
  provider: string;
  children: ReactNode;
}) {
  return (
    <ConnectionMessage title={`Could not verify ${provider} connection`} error>
      {children}
    </ConnectionMessage>
  );
}

export function RefreshConnectionButton({
  refreshing,
  disabled,
  onClick,
}: {
  refreshing: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button size="sm" variant="outline" disabled={refreshing || disabled} onClick={onClick}>
      {refreshing && (
        <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
      )}
      Refresh status
    </Button>
  );
}

export function DeviceCode({
  code,
  disabled,
  expiresAt,
  onExpired,
}: {
  code: string;
  disabled?: boolean;
  expiresAt: number;
  onExpired: () => void;
}) {
  async function copy() {
    if (Date.now() >= expiresAt) return onExpired();
    try {
      await navigator.clipboard.writeText(code);
      toast.success("Sign-in code copied.");
    } catch {
      toast.error("Copy failed. Select and copy the code manually.");
    }
  }
  return (
    <div className="relative flex flex-wrap items-center justify-center gap-1 rounded-md border bg-muted/50 p-2 @lg:p-3">
      <code className="min-w-0 select-all break-all font-mono text-xl font-semibold tracking-wide @lg:text-3xl">
        {code}
      </code>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Copy code"
        title="Copy code"
        disabled={disabled}
        onClick={() => void copy()}
      >
        <Copy aria-hidden="true" />
      </Button>
    </div>
  );
}
