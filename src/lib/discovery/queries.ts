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
} from "./types";

export function discoveryOptions<R extends DiscoveryResource>(
  resource: R,
  target: DiscoveryTarget = {},
) {
  return queryOptions({
    queryKey: ["discovery", resource, target.workspaceId ?? "", target.buildId ?? ""],
    queryFn: ({ signal }) => readDiscovery(resource, target, signal),
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
  const query = useQuery({
    ...discoveryOptions(resource, target),
    enabled: options.enabled,
    initialData: options.initialData,
    refetchInterval: options.poll
      ? resource === "workspaces"
        ? 15_000
        : discoveryFreshness[resource]
      : false,
    refetchIntervalInBackground: false,
  });
  // Authorization failures must never leave a previously authorized snapshot visible.
  const denied =
    query.error instanceof DiscoveryError && [401, 403, 404, 409].includes(query.error.status);
  const { workspaceId, buildId } = target;
  const refresh = useCallback(async () => {
    const target = { workspaceId, buildId };
    const queryKey = discoveryOptions(resource, target).queryKey;
    await queryClient.cancelQueries({ queryKey, exact: true });
    return queryClient.fetchQuery({
      ...discoveryOptions(resource, target),
      staleTime: 0,
      queryFn: ({ signal }) => readDiscovery(resource, target, signal, true),
    });
  }, [resource, workspaceId, buildId, queryClient]);
  return {
    ...query,
    data: denied ? undefined : (query.data ?? (query.isPending ? options.initialData : undefined)),
    refresh,
  };
}
