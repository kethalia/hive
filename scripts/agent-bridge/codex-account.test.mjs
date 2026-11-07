import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createCodexAccountManager } from "./codex-account.mjs";

function fixture({ signedIn = false, busy = false } = {}) {
  const calls = [],
    lifetimeId = randomUUID();
  let notify,
    release = 0,
    stamp = 1000;
  const manager = createCodexAccountManager({
    home: "/unused",
    profile: "software",
    lifetimeId,
    acquire() {
      if (busy) throw Error();
      return {
        fd: 3,
        close() {
          release++;
        },
      };
    },
    now: () => stamp,
    async open(_home, _fd, observe) {
      notify = observe;
      return {
        async call(method, params) {
          calls.push([method, params]);
          if (method === "account/read") return { account: signedIn ? { type: "chatgpt" } : null };
          if (method === "account/login/start")
            return {
              type: "chatgptDeviceCode",
              loginId: "owned-login",
              verificationUrl: "https://auth.openai.com/codex/device",
              userCode: "ABCD-1234",
            };
          if (method === "account/login/cancel") return { status: "canceled" };
          if (method === "account/logout") {
            signedIn = false;
            return {};
          }
          throw Error();
        },
        async close() {},
      };
    },
  });
  return {
    manager,
    calls,
    lifetimeId,
    release: () => release,
    expire() {
      stamp += 600001;
    },
    finish(loginId = "owned-login", success = true) {
      signedIn = success;
      notify({ method: "account/login/completed", params: { loginId, success } });
    },
    command: (action, generation) => manager.run({ action, lifetimeId, generation }),
  };
}
test("connect is deduplicated under concurrency; only exact completion advances pending", async () => {
  const f = fixture();
  try {
    const [a, b] = await Promise.all([f.command("connect", 0), f.command("connect", 0)]);
    assert.equal(a.state, "pending");
    assert.deepEqual(a, b);
    assert.equal(f.calls.filter(([m]) => m === "account/login/start").length, 1);
    f.finish("foreign-login");
    assert.equal((await f.manager.run({ action: "status" })).state, "pending");
    f.finish();
    assert.equal((await f.manager.run({ action: "status" })).state, "signed-in");
    assert.equal(f.release(), 1);
  } finally {
    await f.manager.close();
  }
});
test("stale owner/build lifetime or generation cannot cancel or overwrite a newer attempt", async () => {
  const f = fixture();
  try {
    await f.command("connect", 0);
    await assert.rejects(
      f.manager.run({ action: "cancel", lifetimeId: randomUUID(), generation: 1 }),
    );
    await assert.rejects(f.command("disconnect", 0));
    assert.equal((await f.manager.run({ action: "status" })).state, "pending");
    assert.equal(f.calls.filter(([m]) => m === "account/login/cancel").length, 0);
    assert.equal((await f.command("cancel", 1)).state, "cancelled");
    await f.command("connect", 2);
    f.finish();
    const account = await f.manager.run({ action: "status" });
    assert.equal(account.state, "signed-in");
    assert.equal((await f.command("disconnect", account.generation)).state, "signed-out");
  } finally {
    await f.manager.close();
  }
});
test("reconnect does not mistake an existing account for completion; expiry releases only its child", async () => {
  const f = fixture({ signedIn: true });
  try {
    assert.equal((await f.command("reconnect", 0)).state, "pending");
    assert.equal((await f.manager.run({ action: "status" })).state, "pending");
    f.expire();
    assert.equal((await f.manager.run({ action: "status" })).state, "expired");
    assert.equal(f.release(), 1);
    f.finish();
    assert.equal((await f.manager.run({ action: "status" })).state, "signed-in");
    assert.equal(
      f.calls.some(([m, p]) => m === "account/read" && p.refreshToken),
      false,
    );
  } finally {
    await f.manager.close();
  }
});
test("a managed native lock prevents account process creation and all credential mutations", async () => {
  const f = fixture({ busy: true });
  try {
    for (const action of ["status", "connect", "disconnect", "reconnect"])
      assert.equal((await f.command(action, 0)).state, "busy");
    assert.deepEqual(f.calls, []);
  } finally {
    await f.manager.close();
  }
});
