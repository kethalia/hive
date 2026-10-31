// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useModalOpen } from "@/hooks/useModalOpen";

afterEach(cleanup);
it("holds for Base UI role-only dialogs and releases as they close or disappear", async () => {
  const { result } = renderHook(useModalOpen);
  const portal = document.createElement("div");
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  portal.append(dialog);
  try {
    await act(async () => {
      document.body.append(portal);
    });
    await waitFor(() => expect(result.current).toBe(true));
    await act(async () => {
      dialog.setAttribute("data-ending-style", "");
    });
    await waitFor(() => expect(result.current).toBe(false));
    await act(async () => {
      dialog.removeAttribute("data-ending-style");
    });
    await waitFor(() => expect(result.current).toBe(true));
    await act(async () => {
      portal.remove();
    });
    await waitFor(() => expect(result.current).toBe(false));
  } finally {
    portal.remove();
  }
});
