import assert from "node:assert/strict";
import test from "node:test";
import { readJobsEnrollment } from "./jobs-enrollment.mjs";

const entry = {
  ownerId: "11111111-1111-4111-8111-111111111111",
  repositoryId: "123",
  providerAccountId: "456",
  fullName: "example/repo",
};
const record = {
  deliveryPilotCandidate: { repositoryPolicies: [entry] },
  repositoryPolicyDigest: "a".repeat(64),
  repositoryCatalogDigest: "b".repeat(64),
};
const pooled =
  "postgresql://hive_app_runtime:synthetic%40password@ep-jolly-sky-b7fhirib-pooler.c-13.us-east-1.aws.neon.tech/hive_app_preview?sslmode=require&channel_binding=require";
const row = {
  databaseName: "hive_app_preview",
  runtimeRole: "hive_app_runtime",
  ...entry,
  policyVersionId: "22222222-2222-4222-8222-222222222222",
  policyDigest: record.repositoryPolicyDigest,
  catalogDigest: record.repositoryCatalogDigest,
  active: true,
  revoked: false,
};

test("pooled preview URL uses only the fixed direct read-only libpq connection", () => {
  const original = process.env.PGHOSTADDR;
  process.env.PGHOSTADDR = "203.0.113.7";
  try {
    const result = readJobsEnrollment(
      pooled,
      record,
      new Date("2026-11-05T00:00:00Z"),
      (command, args, options) => {
        assert.equal(command, "/usr/bin/psql");
        assert.deepEqual(args.slice(0, 5), ["-X", "-tA", "-v", "ON_ERROR_STOP=1", "-c"]);
        assert.match(args[5], /^SELECT json_build_object\(/);
        assert.ok(
          !args.some((x) => x.includes("synthetic@password") || x.includes("postgresql://")),
        );
        assert.equal(options.env.PGHOST, "ep-jolly-sky-b7fhirib.c-13.us-east-1.aws.neon.tech");
        assert.equal(options.env.PGUSER, "hive_app_runtime");
        assert.equal(options.env.PGDATABASE, "hive_app_preview");
        assert.equal(options.env.PGPASSWORD, "synthetic@password");
        assert.equal(options.env.PGSSLMODE, "require");
        assert.equal(options.env.PGCHANNELBINDING, "require");
        assert.equal(
          options.env.PGOPTIONS,
          "-c default_transaction_read_only=on -c statement_timeout=5000",
        );
        assert.equal(options.env.PGHOSTADDR, undefined);
        assert.equal(options.env.PGSERVICE, undefined);
        assert.equal(options.timeout, 10000);
        return { status: 0, stdout: `${JSON.stringify(row)}\n` };
      },
    );
    assert.equal(result.verifiedReadOnlyDatabase, true);
    assert.equal(result.policyDigest, record.repositoryPolicyDigest);
  } finally {
    if (original === undefined) delete process.env.PGHOSTADDR;
    else process.env.PGHOSTADDR = original;
  }
});

test("scope drift, failed reads and nonmatching rows fail closed", () => {
  let calls = 0;
  const run = () => {
    calls++;
    return { status: 0, stdout: JSON.stringify(row) };
  };
  for (const url of [
    pooled.replace("hive_app_runtime", "owner"),
    pooled.replace("hive_app_preview", "production"),
    pooled.replace("ep-jolly-sky-b7fhirib", "ep-other"),
    pooled.replace("sslmode=require", "sslmode=disable"),
  ])
    assert.throws(() => readJobsEnrollment(url, record, new Date(), run));
  assert.equal(calls, 0);
  for (const response of [
    { status: 1, stdout: "" },
    { status: 0, stdout: "" },
    { status: 0, stdout: JSON.stringify({ ...row, runtimeRole: "owner" }) },
    {
      status: 0,
      stdout: JSON.stringify({ ...row, ownerId: "33333333-3333-4333-8333-333333333333" }),
    },
  ])
    assert.throws(() => readJobsEnrollment(pooled, record, new Date(), () => response));
});
