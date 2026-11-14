import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Export-level compatibility follows the existing dashboard entry point.
const dashboardActions = {
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
export function portableActionManifest(manifest) {
  assert.ok(manifest?.node && typeof manifest.node === "object");
  const actions = {};
  for (const [id, entry] of Object.entries(manifest.node)) {
    const allowed =
      Object.hasOwn(dashboardActions, entry.filename) &&
      dashboardActions[entry.filename].includes(entry.exportedName);
    if (!allowed || !Object.hasOwn(entry.workers ?? {}, "app/(dashboard)/workspaces/page"))
      continue;
    assert.match(id, /^[0-7][a-f0-9]{41}$/);
    actions[id] = { paths: ["/workspaces"], maxBodyBytes: 65536 };
  }
  assert.ok(Object.keys(actions).length > 0, "Build contains no reviewed workspace actions");
  return { schemaVersion: 1, actions };
}
export async function writePortableActions(root = process.cwd()) {
  const manifest = JSON.parse(
    await readFile(join(root, ".next-cloudflare/server/server-reference-manifest.json"), "utf8"),
  );
  const value = portableActionManifest(manifest);
  await writeFile(
    join(root, ".open-next/cloudflare/hive-portable-actions.mjs"),
    `export default ${JSON.stringify(value)};\n`,
  );
  return value;
}
