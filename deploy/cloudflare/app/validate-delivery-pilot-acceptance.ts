import { readFileSync } from "node:fs";
import { acceptanceDeploymentConfig } from "../../../src/lib/delivery/acceptance-config.server";

try {
  const input = readFileSync(0, "utf8");
  if (Buffer.byteLength(input) > 4096) throw new Error();
  const producer = acceptanceDeploymentConfig({
    HIVE_DELIVERY_ACCEPTANCE_ENABLED: "true",
    HIVE_DELIVERY_EXECUTION_ENABLED: "true",
    HIVE_DELIVERY_MANAGER_ENABLED: "true",
    HIVE_DELIVERY_REPOSITORY_POLICY_ENABLED: "true",
    HIVE_DELIVERY_ACCEPTANCE_PRODUCER: input,
  });
  if (
    !producer ||
    producer.runtimeVersion !== "0.165.0" ||
    producer.model !== "gpt-6.1-sol" ||
    producer.effort !== "high"
  )
    throw new Error();
} catch {
  process.stderr.write("Pilot acceptance producer rejected.\n");
  process.exitCode = 1;
}
