import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const node = require("@prisma/client/runtime/library");
const edge = require("@prisma/client/runtime/wasm-compiler-edge");

test("complete Prisma queries preserve fragments across Node and Workerd runtimes", () => {
  const columns = node.sqltag`id, repository_id AS "repositoryId"`;
  const broken = edge.sqltag`SELECT ${columns} FROM policy WHERE owner_id=${"owner"}`;
  assert.equal(broken.values[0], columns);
  const complete = node.sqltag`SELECT ${columns} FROM policy WHERE owner_id=${"owner"}`;
  assert.equal(
    complete.text,
    'SELECT id, repository_id AS "repositoryId" FROM policy WHERE owner_id=$1',
  );
  assert.deepEqual(complete.values, ["owner"]);
  const ids = ["a", "b"];
  const joined = node.sqltag`SELECT id FROM intents WHERE id IN (${node.join(ids.map((id) => node.sqltag`${id}::uuid`))})`;
  assert.equal(joined.text, "SELECT id FROM intents WHERE id IN ($1::uuid,$2::uuid)");
  assert.deepEqual(joined.values, ids);
});
