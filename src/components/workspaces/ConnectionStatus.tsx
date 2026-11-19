import { Copy, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function CheckingConnection({ provider }: { provider: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
      Checking {provider} connection…
    </p>
  );
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
    <section
      aria-label={`${provider} connection details`}
      className="min-w-0 space-y-4 rounded-md border p-4 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{provider} connection</h2>
        <Badge>Connected</Badge>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2">
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

export function DisconnectedAccount({
  provider,
  children,
}: {
  provider: string;
  children?: ReactNode;
}) {
  return (
    <div role="status" className="space-y-1 text-sm">
      <p className="font-medium">No {provider} account connected</p>
      {children && <p className="text-muted-foreground">{children}</p>}
    </div>
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
