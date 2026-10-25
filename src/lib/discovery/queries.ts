"use client";

import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { readDiscovery } from "./transport";
import {
  type DiscoveryData,
  DiscoveryError,
  type DiscoveryResource,
  type DiscoveryTarget,
  discoveryFreshness,
  isDiscoveryDenied,
} from "./types";

export function discoveryOptions<R extends DiscoveryResource>(
  resource: R,
  target: DiscoveryTarget = {},
  refresh = false,
) {
  return queryOptions({
    queryKey: ["discovery", resource, target.workspaceId ?? "", target.buildId ?? ""],
    queryFn: async ({ signal, client, queryKey }) => {
      try {
        return await readDiscovery(resource, target, signal, refresh);
      } catch (error) {
        // A transient failure cannot reauthorize a snapshot denied by an earlier request.
        // Keep that barrier on the shared query until a successful read clears its error.
        if (isDiscoveryDenied(client.getQueryState(queryKey)?.error) && !isDiscoveryDenied(error)) {
          const denied = new DiscoveryError(
            error instanceof Error ? error.message : "Could not refresh workspace data.",
            error instanceof DiscoveryError ? error.status : 0,
            true,
          );
          denied.cause = error;
          throw denied;
        }
        throw error;
      }
    },
    staleTime: discoveryFreshness[resource],
    gcTime: 300_000,
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}
export function useDiscovery<R extends DiscoveryResource>(
  resource: R,
  target: DiscoveryTarget = {},
  options: { enabled?: boolean; initialData?: DiscoveryData[R]; poll?: boolean } = {},
) {
  const queryClient = useQueryClient();
  const config = discoveryOptions(resource, target);
  // Do not let mounting another consumer seed old server props after a failed read.
  const initialData = queryClient.getQueryState(config.queryKey)?.errorUpdateCount
    ? undefined
    : options.initialData;
  const query = useQuery({
    ...config,
    enabled: options.enabled,
    initialData,
    refetchInterval: options.poll
      ? resource === "workspaces"
        ? 15_000
        : discoveryFreshness[resource]
      : false,
    refetchIntervalInBackground: false,
  });
  // Authorization failures must never leave a previously authorized snapshot visible.
  const denied = isDiscoveryDenied(query.error);
  const { workspaceId, buildId } = target;
  const refresh = useCallback(async () => {
    const target = { workspaceId, buildId };
    const queryKey = discoveryOptions(resource, target).queryKey;
    await queryClient.cancelQueries({ queryKey, exact: true });
    return queryClient.fetchQuery({
      ...discoveryOptions(resource, target, true),
      staleTime: 0,
    });
  }, [resource, workspaceId, buildId, queryClient]);
  return {
    ...query,
    data: denied ? undefined : (query.data ?? (query.isPending ? initialData : undefined)),
    refresh,
  };
}
