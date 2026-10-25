import {
  type DiscoveryData,
  DiscoveryError,
  type DiscoveryResource,
  type DiscoveryTarget,
} from "./types";

export async function readDiscovery<R extends DiscoveryResource>(
  resource: R,
  target: DiscoveryTarget = {},
  signal?: AbortSignal,
  refresh = false,
): Promise<DiscoveryData[R]> {
  const query = new URLSearchParams();
  if (target.workspaceId) query.set("workspaceId", target.workspaceId);
  if (refresh) query.set("refresh", "1");
  const response = await fetch(`/api/discovery/${resource}?${query}`, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(35_000)])
      : AbortSignal.timeout(35_000),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.redirected) throw new DiscoveryError("Sign in to refresh workspace data.", 401);
  const result = await response.json().catch(() => null);
  if (!response.ok)
    throw new DiscoveryError(result?.error ?? "Could not refresh workspace data.", response.status);
  if (result?.data === undefined) throw new DiscoveryError("Invalid discovery response.", 502);
  return result.data;
}
