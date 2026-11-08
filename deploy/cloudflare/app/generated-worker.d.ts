declare module "*.open-next/worker.js" {
  const handler: {
    fetch(request: Request, env: unknown, context: unknown): Promise<Response>;
  };
  export default handler;
}
declare module "*.open-next/cloudflare/hive-portable-actions.mjs" {
  const manifest: {
    schemaVersion: number;
    actions: Record<string, { paths: readonly string[]; maxBodyBytes: number }>;
  };
  export default manifest;
}

declare module "*.open-next/cloudflare/hive-provider-build.mjs" {
  const identity: import("../../../src/lib/provider-build").ProviderBuildIdentity;
  export default identity;
}
