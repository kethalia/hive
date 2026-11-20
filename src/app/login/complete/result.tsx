"use client";

import { useEffect } from "react";
import { CODER_OAUTH_POPUP_MESSAGE } from "@/lib/auth/coder-oauth-popup";
import { coderOAuthPopupCss, coderOAuthPopupPanel } from "@/lib/auth/coder-oauth-popup-view";

export function CoderOAuthComplete({
  attempt,
  success,
}: {
  attempt: string | null;
  success: boolean;
}) {
  useEffect(() => {
    if (!attempt || !window.opener) return;
    window.opener.postMessage(
      { type: CODER_OAUTH_POPUP_MESSAGE, attempt, success },
      window.location.origin,
    );
    window.close();
  }, [attempt, success]);

  return (
    <>
      <style>{coderOAuthPopupCss}</style>
      <div
        className="coder-oauth-popup coder-oauth-popup--overlay"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: The shared markup uses fixed copy only.
        dangerouslySetInnerHTML={{ __html: coderOAuthPopupPanel(success ? "finishing" : "failed") }}
      />
    </>
  );
}
