import type { CoderDisconnectResult } from "@hive/auth";

export type CoderDisconnectOutcome =
  | { result: CoderDisconnectResult }
  | { error: "connection_changed" | "disconnect_unknown" };

/** Ephemeral outcome only: no account data or authority is retained here. */
export function CoderDisconnectNotice({ outcome }: { outcome: CoderDisconnectOutcome }) {
  return (
    <div className="space-y-3 p-4">
      {"result" in outcome ? (
        <div className="space-y-2" role="status">
          <p>This Coder connection was disconnected.</p>
          <p>
            {outcome.result.providerRevocation === "acknowledged"
              ? "Coder accepted its revocation request."
              : "Coder revocation could not be confirmed."}
          </p>
          <p>
            {outcome.result.currentConnection === "changed"
              ? "The connection changed. Refresh Hive to see its current status."
              : "Refresh Hive to check the current connection, or connect again."}
          </p>
        </div>
      ) : (
        <p role="alert">
          {outcome.error === "connection_changed"
            ? "The connection changed or is busy. Refresh Hive before disconnecting."
            : "The disconnect outcome is unknown. Refresh Hive to check the connection before trying again."}
        </p>
      )}
      <div className="flex flex-wrap gap-3 text-sm">
        <a className="underline" href="/workspaces">
          Refresh Hive
        </a>
        <a className="underline" href="/api/auth/coder/start">
          Continue with Coder
        </a>
      </div>
    </div>
  );
}
