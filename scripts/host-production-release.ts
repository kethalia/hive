import { readFileSync } from "node:fs";
import { hostProductionRelease } from "./host-epic-merge";

export { hostProductionRelease } from "./host-epic-merge";

if (process.argv[1]?.endsWith("production-release-host.mjs")) {
  try {
    const bytes = readFileSync(0);
    if (bytes.length > 114688) throw Error("release_limit");
    const frame = JSON.parse(bytes.toString("utf8"));
    if (frame?.request?.operation !== "database" && bytes.length > 16384)
      throw Error("release_limit");
    process.stdout.write(JSON.stringify(await hostProductionRelease(frame)));
  } catch {
    process.stdout.write(
      JSON.stringify({ schemaVersion: 1, error: "production_release_unavailable" }),
    );
    process.exitCode = 1;
  }
}
