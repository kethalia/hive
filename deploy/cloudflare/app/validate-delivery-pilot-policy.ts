import { readFileSync } from "node:fs";
import { githubSourceDigest } from "../../../src/lib/delivery/github-evidence.server";
import { repositoryPolicyCatalogSchema } from "../../../src/lib/delivery/repository-policy-contracts";

try {
  const input = readFileSync(0, "utf8");
  if (Buffer.byteLength(input) > 262144) throw new Error();
  const entries = repositoryPolicyCatalogSchema.parse(JSON.parse(input));
  if (entries.length !== 1) throw new Error();
  process.stdout.write(
    JSON.stringify({
      catalogDigest: githubSourceDigest(entries),
      policyDigest: githubSourceDigest(entries[0].policy),
    }),
  );
} catch {
  process.stderr.write("Pilot repository catalog rejected.\n");
  process.exitCode = 1;
}
