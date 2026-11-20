// Both the blank popup and the callback document render before Hive's app CSS loads.
export const coderOAuthPopupCss = `
  .coder-oauth-popup {
    box-sizing: border-box; margin: 0; min-height: 100vh; min-height: 100dvh; padding: 1rem;
    display: grid; place-items: center; color-scheme: dark;
    color: #dcffe3; font-family: ui-monospace, monospace;
    background-color: #070a08;
    background-image: linear-gradient(#8dff9d0a 1px, transparent 1px),
                      linear-gradient(90deg, #8dff9d0a 1px, transparent 1px);
    background-size: 2rem 2rem;
  }
  .coder-oauth-popup--overlay { position: fixed; inset: 0; z-index: 1; overflow: auto; }
  .coder-oauth-popup-panel {
    box-sizing: border-box; width: min(100%, 22rem); min-height: 5.5rem; padding: 1.5rem;
    display: flex; align-items: center; gap: 1rem;
    border: 1px solid #8dff9d40; background: #0d130f;
    box-shadow: 0 0 3rem #8dff9d12;
  }
  .coder-oauth-popup-mark {
    box-sizing: border-box; display: grid; flex: 0 0 2.375rem; height: 2.375rem; place-items: center;
    border: 1px solid #8dff9d66; background: #8dff9d1a; color: #8dff9d;
    font-size: 0.875rem;
  }
  .coder-oauth-popup-copy { min-width: 0; }
  .coder-oauth-popup-status {
    display: flex; align-items: baseline; gap: 0.65em;
    margin: 0; font-size: 0.9375rem; line-height: 1.5;
  }
  .coder-oauth-popup-status[data-pending]::before {
    box-sizing: content-box; content: ""; flex: 0 0 0.75em; height: 0.75em;
    border: 1.5px solid #8dff9d; border-right-color: transparent; border-radius: 50%;
    animation: coder-oauth-spin 1s linear infinite;
  }
  .coder-oauth-popup-status[role=alert] { color: #ffac9f; }
  .coder-oauth-popup-help { margin: 0.5rem 0 0; color: #a4c7ac; font-size: 0.8125rem; line-height: 1.5; }
  .coder-oauth-popup-help a { color: #8dff9d; text-underline-offset: 3px; }
  @keyframes coder-oauth-spin { to { transform: rotate(1turn); } }
  @media (prefers-reduced-motion: reduce) { .coder-oauth-popup-status::before { animation: none; } }
`;

const statuses = {
  connecting: "Connecting to Coder…",
  finishing: "Finishing sign-in to Hive…",
  failed: "Coder sign-in did not complete.",
} as const;

// Only fixed strings live here. OAuth values are serialized separately by the caller.
export function coderOAuthPopupPanel(state: keyof typeof statuses) {
  return `<div class="coder-oauth-popup-panel">
    <span class="coder-oauth-popup-mark" aria-hidden="true">H_</span>
    <div class="coder-oauth-popup-copy">
      <p class="coder-oauth-popup-status" role="${state === "failed" ? "alert" : "status"}"${state === "failed" ? "" : " data-pending"}><span>${statuses[state]}</span></p>
      ${
        state === "connecting"
          ? ""
          : `<p class="coder-oauth-popup-help">${state === "failed" ? "Return to Hive to try again." : "Return to your original Hive window to continue."}</p>
      <p class="coder-oauth-popup-help"><a href="/workspaces">Open Hive</a></p>`
      }
    </div>
  </div>`;
}
