import { describe, expect, it } from "vitest";
import type { WorkspaceResource } from "@/lib/coder/types";
import { readEmptyRootResource } from "@/lib/codex-session/guardian-empty-root.server";
import { guardianVolumeSchema } from "@/lib/codex-session/guardian-remount-contracts";

// Public provider shape from the 4Gi canary: the claim was created while
// spec.volume_name was still empty. No guest-derived PV name is substituted.
const agentId = "b0179ecf-9187-4021-a655-616a4d1ef31e";
const pvcUid = "4cd09896-c113-488b-b326-8273271b571c";
const volume = {
  pvcUid,
  pvcName: "coder-5172dea9-a2d7-4ddf-9f58-a970a777f280-home",
  namespace: "coder",
  storageClass: "longhorn",
  capacity: "4Gi",
  accessModes: ["ReadWriteOnce"],
  boundVolumeName: "",
  containerName: "dev",
  podVolumeName: "home",
  mountPath: "/home/coder",
  subPath: "",
  subPathExpr: "",
  readOnly: false,
  claimReadOnly: false,
};
function resource(value: unknown): WorkspaceResource {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    type: "kubernetes_deployment_v1",
    name: "workspace",
    agents: [{ id: agentId, name: "main", status: "connected" }],
    metadata: [{ key: "hive_home_volume_v1", value: JSON.stringify(value), sensitive: false }],
  };
}

describe("provider-backed HOME binding metadata", () => {
  it("holds incomplete provider state, then accepts the provider-observed bound PV", () => {
    expect(guardianVolumeSchema.safeParse(volume).success).toBe(false);
    expect(() => readEmptyRootResource([resource(volume)], agentId)).toThrow();
    const bound = { ...volume, boundVolumeName: `pvc-${pvcUid}` };
    expect(guardianVolumeSchema.parse(bound)).toEqual(bound);
    expect(readEmptyRootResource([resource(bound)], agentId).volume).toEqual(bound);
    expect(volume.boundVolumeName).toBe("");
  });

  it("keeps missing, null and malformed PV identities held without deriving a replacement", () => {
    for (const boundVolumeName of [undefined, null, "", "../pv", " pv "]) {
      const incomplete = { ...volume, boundVolumeName };
      expect(guardianVolumeSchema.safeParse(incomplete).success).toBe(false);
      expect(() => readEmptyRootResource([resource(incomplete)], agentId)).toThrow();
    }
  });
});
