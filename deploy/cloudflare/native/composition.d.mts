export function createNativeWorker<A, B, C>(handlers: {
  app: A;
  auth: B;
  jobs: C;
  buildIdentity?: import("../../../src/lib/provider-build").ProviderBuildIdentity;
}): {
  fetch(
    request: Request,
    env: Record<string, unknown>,
    context: unknown,
  ): Promise<Response> | Response;
  scheduled(
    event: unknown,
    env: Record<string, unknown>,
    context: { waitUntil(promise: Promise<unknown>): void },
  ): void;
};
