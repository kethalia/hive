import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No remote cache/add-on is provisioned by this compatibility build. Dynamic
// authenticated responses remain private; durable ISR/tag caching is a later gate.
const config = defineCloudflareConfig();
config.buildCommand = "pnpm exec next build --webpack";
export default config;
