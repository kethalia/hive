import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCodexAccountManager, validManagementRequest } from "./codex-account.mjs";
import { readLibrary } from "./codex-library.mjs";

const lifetimeId = randomUUID();
const fence = { lifetimeId, generation: 0 };
const read = (section) => ({
  ...fence,
  action: "library",
  section,
  cursor: null,
  search: null,
  archived: false,
});

test("catalog requests carry bounded filters and never accept paths, commands, or unreviewed writes", () => {
  assert.ok(validManagementRequest({ ...read("skills"), sessionId: randomUUID() }));
  assert.ok(validManagementRequest({ ...read("sessions"), search: "project", archived: true }));
  assert.ok(!validManagementRequest({ ...read("skills"), cwd: "/outside" }));
  assert.ok(!validManagementRequest({ ...read("plugins"), search: "unreviewed" }));
  assert.ok(!validManagementRequest({ ...read("sessions"), cursor: "x".repeat(2049) }));
  assert.ok(!validManagementRequest({ ...read("integrations"), sessionId: randomUUID() }));
  assert.ok(
    !validManagementRequest({
      ...fence,
      action: "save-library",
      section: "skills",
      id: "a".repeat(64),
      revision: "b".repeat(64),
      change: "remove",
    }),
  );
});

test("directory skills resolve an existing managed thread and reject foreign directories", async () => {
  const home = await mkdtemp(join(tmpdir(), "hive-library-"));
  const id = randomUUID();
  const calls = [];
  let cwd = home;
  const rpc = async (method, params) => {
    calls.push([method, params]);
    return method === "thread/read"
      ? { thread: { id, cwd } }
      : { data: [{ cwd, skills: [], errors: [] }] };
  };
  try {
    assert.deepEqual(await readLibrary(rpc, home, { ...read("skills"), sessionId: id }), {
      section: "skills",
      directory: home,
      rows: [],
      partial: false,
      nextCursor: null,
    });
    assert.deepEqual(calls, [
      ["thread/read", { threadId: id, includeTurns: false }],
      ["skills/list", { cwds: [home], forceReload: true }],
    ]);
    cwd = `${home}-other`;
    await assert.rejects(
      readLibrary(rpc, home, { ...read("skills"), sessionId: id }),
      /managed_auth_stale/,
    );
    assert.equal(calls.length, 3);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("integration listing projects auth and tool names without returning endpoints, arguments or credentials", async () => {
  const answer = await readLibrary(
    async (method, params) => {
      assert.equal(method, "mcpServerStatus/list");
      assert.deepEqual(params, { cursor: null, limit: 20, detail: "toolsAndAuthOnly" });
      return {
        data: [
          {
            name: "test",
            authStatus: "oAuth",
            runtimeStatus: "connected",
            tools: { list: { inputSchema: { secret: "sensitive" } } },
            endpoint: "sensitive",
          },
        ],
        nextCursor: "next",
      };
    },
    "/unused",
    read("integrations"),
  );
  assert.deepEqual(answer, {
    section: "integrations",
    rows: [{ name: "test", pluginId: null, auth: "oAuth", runtime: "connected", tools: ["list"] }],
    partial: false,
    nextCursor: "next",
  });
});

test("a stale catalog cannot write and a lost write is read back without replay", async () => {
  let enabled = true;
  let writes = 0;
  const events = [];
  const manager = createCodexAccountManager({
    lifetimeId,
    home: "/unused",
    profile: "software",
    acquire: () => ({ fd: 3, close: () => events.push("unlock") }),
    open: async () => ({
      close: async () => events.push("close"),
      async call(method, params) {
        if (method === "account/read") return { account: { type: "chatgpt" } };
        if (method === "skills/list")
          return {
            data: [
              {
                cwd: "/unused",
                skills: [
                  {
                    path: "/unused/.agents/skills/fixture/SKILL.md",
                    name: "Fixture",
                    scope: "user",
                    enabled,
                  },
                ],
              },
            ],
          };
        assert.equal(method, "skills/config/write");
        assert.equal(params.path, "/unused/.agents/skills/fixture/SKILL.md");
        events.push("write");
        writes++;
        enabled = params.enabled;
        throw Error("lost acknowledgement");
      },
    }),
  });
  try {
    const result = await manager.manage(read("skills"));
    const [{ id, revision }] = result.library.rows;
    const change = {
      ...fence,
      action: "save-library",
      section: "skills",
      id,
      revision,
      change: "disable",
    };
    await assert.rejects(
      manager.manage({ ...change, revision: "a".repeat(64) }),
      /managed_auth_stale/,
    );
    assert.equal(writes, 0);
    events.length = 0;
    const changed = await manager.manage(change);
    assert.equal(changed.outcome, "unknown");
    assert.equal(changed.generation, 1);
    assert.equal(changed.library.rows[0].enabled, false);
    await assert.rejects(manager.manage(change), /managed_auth_stale/);
    assert.equal(writes, 1);
    assert.deepEqual(events, ["write", "close", "close", "unlock"]);
  } finally {
    await manager.close();
  }
});
