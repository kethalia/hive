import { describe, expect, it } from "vitest";
import {
  requiresPreviewAccess,
  runtimeRelayDeadline,
} from "../../../deploy/cloudflare/app/preview-auth";

describe("native public-login access contract", () => {
  it("removes only the extra native Preview authority and keeps legacy defaults private", () => {
    const native = { HIVE_NATIVE_MODE: "preview", HIVE_NATIVE_PREVIEW_ENABLED: "true" };
    expect(requiresPreviewAccess(native)).toBe(true);
    expect(requiresPreviewAccess({ ...native, HIVE_PREVIEW_ACCESS_REQUIRED: "false" })).toBe(false);
    expect(requiresPreviewAccess({ HIVE_PREVIEW_ACCESS_REQUIRED: "false" })).toBe(true);
    expect(requiresPreviewAccess({ ...native, HIVE_PREVIEW_ACCESS_REQUIRED: "False" })).toBe(true);
  });
  it("public native relays retain authenticated session/runtime deadlines without a preview-cookie deadline", () => {
    const request = new Request("https://hive.example/ws");
    expect(
      runtimeRelayDeadline(
        request,
        {
          HIVE_NATIVE_MODE: "preview",
          HIVE_NATIVE_PREVIEW_ENABLED: "true",
          HIVE_PREVIEW_ACCESS_REQUIRED: "false",
        },
        undefined,
        100,
      ),
    ).toBe(Infinity);
    expect(
      runtimeRelayDeadline(
        request,
        { HIVE_NATIVE_MODE: "preview", HIVE_NATIVE_PREVIEW_ENABLED: "true" },
        undefined,
        100,
      ),
    ).toBe(900100);
    expect(() =>
      runtimeRelayDeadline(
        request,
        { HIVE_NATIVE_MODE: "bootstrap", HIVE_PREVIEW_ACCESS_REQUIRED: "false" },
        undefined,
        100,
      ),
    ).toThrow();
  });
});
