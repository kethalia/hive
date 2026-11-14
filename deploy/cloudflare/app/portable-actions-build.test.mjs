import assert from "node:assert/strict";
import test from "node:test";
import { portableActionManifest } from "./portable-actions-build.mjs";

const supported = {
  "lib/actions/workspaces.ts": [
    "listWorkspacesAction",
    "listWorkspaceTemplatesAction",
    "getWorkspaceAction",
    "getWorkspaceAgentAction",
    "getWorkspaceSessionsAction",
    "createSessionAction",
    "createWorkspaceAction",
    "startWorkspaceAction",
    "stopWorkspaceAction",
    "deleteWorkspaceAction",
    "getExistingTerminalPathsAction",
    "getWorkspaceSessionToolsAction",
    "getWorkspaceAppToolAction",
    "restartWorkspaceAction",
    "renameSessionAction",
    "killSessionAction",
  ],
  "lib/actions/templates.ts": ["listTemplateStatusesAction"],
  "lib/actions/agent-tools.ts": [
    "inspectAgentToolsAction",
    "configureAgentToolsAction",
    "resumeAgentSessionAction",
  ],
  "lib/actions/git-clones.ts": [
    "restoreGitCloneTerminalsAction",
    "listGitClonesAction",
    "resolveGitCloneTerminalAction",
    "resolveGitCloneNotificationAction",
    "closeGitCloneTerminalAction",
  ],
  "lib/actions/clone-project.ts": ["cloneProjectAction"],
  "lib/actions/settings-window.ts": ["getSettingsWindowAction"],
  "lib/actions/user-settings.ts": ["getTerminalSettingsAction", "updateTerminalSettingsAction"],
  "lib/push/actions.ts": ["getVapidPublicKeyAction", "testPushAction"],
  "lib/push/subscribe.ts": [
    "subscribePushAction",
    "unsubscribePushAction",
    "getPushPreferencesAction",
    "updatePushPreferencesAction",
  ],
};
const id = (number) => number.toString(16).padStart(42, "0");
const entry = (filename, exportedName, worker = "app/(dashboard)/workspaces/page") => ({
  filename,
  exportedName,
  workers: { [worker]: {} },
});
test("all existing dashboard action families are admitted from their exact build exports", () => {
  const node = {};
  let index = 0;
  for (const [filename, names] of Object.entries(supported))
    for (const name of names) node[id(++index)] = entry(filename, name);
  const manifest = portableActionManifest({ node });
  assert.equal(Object.keys(manifest.actions).length, index);
  for (const value of Object.values(manifest.actions))
    assert.deepEqual(value, { paths: ["/workspaces"], maxBodyBytes: 65536 });
});
test("unknown, raw execution and privileged lookalike exports remain excluded", () => {
  const node = {
    [id(1)]: entry("lib/actions/workspaces.ts", "getWorkspaceAction"),
    [id(2)]: entry("lib/actions/workspaces.ts", "deleteAllWorkspacesAction"),
    [id(3)]: entry("lib/workspace/exec.ts", "execInWorkspace"),
    [id(4)]: entry("lib/agents/workspace.ts", "runWorkspaceAgentOperation"),
    [id(5)]: entry("lib/actions/admin.ts", "configureAgentToolsAction"),
    [id(6)]: entry("lib/actions/workspaces.ts", "getWorkspaceAction", "app/admin/page"),
  };
  assert.deepEqual(Object.keys(portableActionManifest({ node }).actions), [id(1)]);
});
