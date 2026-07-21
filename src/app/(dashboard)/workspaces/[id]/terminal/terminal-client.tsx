"use client";

import { Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CommandPalette } from "@/components/terminal/CommandPalette";
import { MobileTerminalControls } from "@/components/terminal/MobileTerminalControls";
import { MobileTerminalDiagnosticsOverlay } from "@/components/terminal/MobileTerminalDiagnosticsOverlay";
import { MobileTerminalShell } from "@/components/terminal/MobileTerminalShell";
import { TerminalSessionCompose } from "@/components/terminal/TerminalSessionCompose";
import { Button } from "@/components/ui/button";
import {
  SingleTerminalSessionHeader,
  TerminalSessionFrame,
} from "@/components/workspaces/TerminalSessionFrame";
import { useIsComposeSheet } from "@/hooks/use-compose-sheet";
import { useFavoriteWindowNavigation } from "@/hooks/useFavoriteWindowNavigation";
import { useKeybindings } from "@/hooks/useKeybindings";
import { useVisualViewportKeyboardOffset } from "@/hooks/useVisualViewportKeyboardOffset";
import { resolveGitCloneTerminalAction } from "@/lib/actions/git-clones";
import { createSessionAction, getWorkspaceSessionsAction } from "@/lib/actions/workspaces";
import { triggerHapticFeedback } from "@/lib/device/haptics";
import type { GitCloneTerminalIdentity } from "@/lib/git/clone-actions-contract";
import {
  getGitRepositoryPresentation,
  isExpectedCloneSessionKey,
  isSafeCloneRelativePath,
} from "@/lib/git/clone-public-identifiers";
import {
  type ClipboardActionStatus,
  copyTerminalSelection,
  pasteClipboardApiToTerminal,
} from "@/lib/terminal/actions";
import type { TerminalComposeRequest } from "@/lib/terminal/clipboard";
import { TERMINAL_COMPOSE_OPEN_EVENT, TERMINAL_COMPOSE_TOGGLE_EVENT } from "@/lib/terminal/events";
import {
  isTerminalSettingsChangedDetail,
  TERMINAL_SETTINGS_CHANGED_EVENT,
} from "@/lib/terminal/settings-events";

const InteractiveTerminal = dynamic(
  () => import("@/components/workspaces/InteractiveTerminal").then((m) => m.InteractiveTerminal),
  { ssr: false },
);

const LAST_SESSION_STORAGE_PREFIX = "terminal:last-session:";
const TERMINAL_SHELL_CLASS_NAME = "h-full min-h-0 w-full";

function terminalSessionHref(
  workspaceId: string,
  sessionName: string,
  debugViewport = false,
): string {
  const href = `/workspaces/${workspaceId}/terminal?session=${encodeURIComponent(sessionName)}`;
  return debugViewport ? `${href}&debugViewport=1` : href;
}

function clipboardFallbackText(reason: string): string {
  switch (reason) {
    case "clipboard-api-denied":
      return "Clipboard permission was denied. Use selection mode or the browser paste control.";
    case "clipboard-api-unavailable":
      return "Clipboard API is unavailable. Use selection mode or the browser paste control.";
    default:
      return "Clipboard API failed. Use selection mode or the browser paste control.";
  }
}

function terminalHasSelection(term: {
  hasSelection?: () => boolean;
  getSelection?: () => string;
}): boolean {
  if (typeof term.hasSelection === "function") return term.hasSelection();
  return Boolean(term.getSelection?.());
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unwrapActionData(result: unknown): unknown {
  return isObjectRecord(result) && "data" in result ? result.data : result;
}

function isGitCloneTerminalIdentity(value: unknown): value is GitCloneTerminalIdentity {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.sessionName === "string" &&
    value.sessionName.length > 0 &&
    typeof value.clonePath === "string" &&
    value.clonePath.length > 0 &&
    typeof value.cloneProof === "string" &&
    value.cloneProof.length > 0
  );
}

function isTextEntryElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;

  const tagName = element.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}

function clipboardStatusText(
  status: ClipboardActionStatus | null,
  {
    canPaste,
    hasTerminal,
    selectionModeEnabled,
  }: { canPaste: boolean; hasTerminal: boolean; selectionModeEnabled: boolean },
): string {
  if (status) {
    switch (status.action) {
      case "copy":
        if (status.outcome === "copied") {
          return status.method === "exec-command"
            ? "Copy complete using clipboard fallback."
            : "Copy complete.";
        }
        if (status.outcome === "failed") {
          return clipboardFallbackText(status.reason);
        }
        return "No terminal selection. Terminal interrupt shortcuts remain available.";
      case "paste":
        if (status.outcome === "pasted") return "Paste complete.";
        if (status.outcome === "uploading") return "Uploading pasted files...";
        if (status.outcome === "empty") return "Clipboard was empty.";
        if (status.outcome === "failed") return status.message;
        if (status.reason === "clipboard-api-unavailable") {
          return clipboardFallbackText(status.reason);
        }
        return status.fallbackSucceeded
          ? "Paste fallback was attempted."
          : clipboardFallbackText(status.reason);
    }
  }

  if (!hasTerminal)
    return "Terminal is not ready. Clipboard controls will enable after connection.";
  if (selectionModeEnabled) return "Selection mode on. Select terminal text, then copy.";
  if (!canPaste) {
    return "Terminal ready. Select terminal text to copy; paste will enable after connection.";
  }
  return "Terminal ready. Use Select for text selection, Copy, or Paste.";
}

function toastPasteError(status: ClipboardActionStatus): void {
  if (status.action !== "paste" || status.outcome !== "failed") return;
  toast.error(status.message ?? "Paste failed.");
}

function TerminalInner({
  agentId,
  terminalControlsBeyondMobile: initialTerminalControlsBeyondMobile,
  workspaceId,
}: {
  agentId: string;
  terminalControlsBeyondMobile: boolean;
  workspaceId: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const session = searchParams.get("session");
  const routeClonePath = session ? searchParams.get("clonePath") || undefined : undefined;
  const routeCloneProof =
    session && routeClonePath ? searchParams.get("cloneProof") || undefined : undefined;
  const routeCloneSessionKey = session
    ? searchParams.get("cloneSessionKey") || undefined
    : undefined;
  const routeRelativePath = session ? searchParams.get("relativePath") || undefined : undefined;
  const gitRepositoryPresentation = getGitRepositoryPresentation(
    routeRelativePath ?? routeClonePath ?? "",
    session ?? "Terminal",
  );
  const terminalDisplayLabel = gitRepositoryPresentation?.title ?? session ?? "Terminal";
  const terminalDisplaySubtitle = gitRepositoryPresentation?.subtitle;
  const debugViewportEnabled = searchParams.get("debugViewport") === "1";
  const { setActiveTerminal, activeTerminal, activeSend } = useKeybindings();
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDraft, setComposeDraft] = useState("");
  const [composeTargetLabel, setComposeTargetLabel] = useState<string | undefined>();
  const [windowSwitcherOpen, setWindowSwitcherOpen] = useState(false);
  const [selectionModeEnabled, setSelectionModeEnabled] = useState(false);
  const [terminalControlsBeyondMobile, setTerminalControlsBeyondMobile] = useState(
    initialTerminalControlsBeyondMobile,
  );
  const [hasTerminalSelection, setHasTerminalSelection] = useState(false);
  const [clipboardActionStatus, setClipboardActionStatus] = useState<ClipboardActionStatus | null>(
    null,
  );
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapRetryKey, setBootstrapRetryKey] = useState(0);
  const [cloneIdentity, setCloneIdentity] = useState<{
    clonePath?: string;
    cloneProof?: string;
    sessionName: string | null;
  }>(() => ({
    sessionName: session,
    clonePath: routeClonePath,
    cloneProof: routeCloneProof,
  }));
  const previousSessionRef = useRef(session);
  const isComposeSheet = useIsComposeSheet();
  const {
    liftPx: visualKeyboardLiftPx,
    isKeyboardVisible: visualKeyboardVisible = false,
    visualViewportHeightPx = 0,
    visualViewportOffsetTopPx = 0,
  } = useVisualViewportKeyboardOffset();
  const favoriteWindowNavigation = useFavoriteWindowNavigation(workspaceId);
  const favoriteWindowTabs = favoriteWindowNavigation.sessions.map((favoriteWindow) => ({
    id: favoriteWindow.id,
    sessionName: favoriteWindow.name,
  }));
  const handleSelectFavoriteWindowTab = useCallback(
    (tabId: string) => {
      favoriteWindowNavigation.select(tabId);
    },
    [favoriteWindowNavigation],
  );
  const isMobileKeyboardVisible = isComposeSheet && visualKeyboardVisible;
  const keyboardLiftPx = isComposeSheet ? visualKeyboardLiftPx : 0;
  const mobileLayoutSignal = isMobileKeyboardVisible
    ? `keyboard:${visualViewportHeightPx}:${visualViewportOffsetTopPx}`
    : `lift:${keyboardLiftPx}`;
  const controlsVisible = isComposeSheet || terminalControlsBeyondMobile;
  const controlsSelectionModeEnabled = controlsVisible && selectionModeEnabled;
  const hasActiveTerminal = Boolean(activeTerminal);
  const hasActiveSender = Boolean(activeSend);
  const clipboardStatus = clipboardStatusText(clipboardActionStatus, {
    canPaste: hasActiveSender,
    hasTerminal: hasActiveTerminal,
    selectionModeEnabled: controlsSelectionModeEnabled,
  });
  const cloneIdentityMatchesRoute = cloneIdentity.sessionName === session;
  const clonePath = cloneIdentityMatchesRoute ? cloneIdentity.clonePath : routeClonePath;
  const cloneProof = cloneIdentityMatchesRoute ? cloneIdentity.cloneProof : routeCloneProof;
  const canRefreshCloneIdentity = Boolean(
    session &&
      clonePath &&
      cloneProof &&
      routeCloneSessionKey &&
      routeRelativePath &&
      isExpectedCloneSessionKey(routeCloneSessionKey) &&
      isSafeCloneRelativePath(routeRelativePath),
  );

  const closeCompose = useCallback(() => {
    setComposeOpen(false);
    setComposeDraft("");
    setComposeTargetLabel(undefined);
  }, []);

  const refreshCloneTerminalIdentity = useCallback(async () => {
    if (
      !session ||
      !routeCloneSessionKey ||
      !routeRelativePath ||
      !isExpectedCloneSessionKey(routeCloneSessionKey) ||
      !isSafeCloneRelativePath(routeRelativePath)
    ) {
      throw new Error("Git clone terminal refresh unavailable");
    }

    const identity = unwrapActionData(
      await resolveGitCloneTerminalAction({
        agentId,
        workspaceId,
        cloneSessionKey: routeCloneSessionKey,
        relativePath: routeRelativePath,
      }),
    );

    if (!isGitCloneTerminalIdentity(identity) || identity.sessionName !== session) {
      throw new Error("Git clone terminal refresh failed");
    }

    setCloneIdentity({
      sessionName: session,
      clonePath: identity.clonePath,
      cloneProof: identity.cloneProof,
    });

    return {
      sessionName: identity.sessionName,
      clonePath: identity.clonePath,
      cloneProof: identity.cloneProof,
    };
  }, [agentId, routeCloneSessionKey, routeRelativePath, session, workspaceId]);

  const handleTerminalReady = useCallback(
    (term: import("@xterm/xterm").Terminal, send: (data: string) => void) => {
      setActiveTerminal(term, send);
    },
    [setActiveTerminal],
  );

  const handleTerminalDestroy = useCallback(() => {
    setActiveTerminal(null, null);
  }, [setActiveTerminal]);

  const handleSelectionModeChange = useCallback((enabled: boolean) => {
    setSelectionModeEnabled(enabled);
    setClipboardActionStatus(null);
  }, []);

  const handleClipboardActionStatus = useCallback((status: ClipboardActionStatus) => {
    setClipboardActionStatus(status);
    toastPasteError(status);
  }, []);

  const handleMobileCopy = useCallback(() => {
    if (!activeTerminal) return;
    copyTerminalSelection(activeTerminal, { onStatus: handleClipboardActionStatus });
  }, [activeTerminal, handleClipboardActionStatus]);

  const openComposeWithDraft = useCallback((request: TerminalComposeRequest) => {
    setComposeTargetLabel(request.targetLabel);
    setComposeDraft((current) => {
      if (!request.append || !current) return request.draft;
      return `${current.replace(/\s*$/, "")}\n${request.draft}`;
    });
    setComposeOpen(true);
  }, []);

  const sendComposeDraft = useCallback(
    (draft: string) => {
      if (!activeSend) return;
      activeSend(draft);
      activeSend("\r");
    },
    [activeSend],
  );

  const handleMobilePaste = useCallback(() => {
    if (!activeSend) return;
    pasteClipboardApiToTerminal(activeTerminal ?? null, activeSend, {
      onStatus: handleClipboardActionStatus,
      onCompose: openComposeWithDraft,
      targetLabel: session ?? undefined,
      workspaceId,
    });
  }, [
    activeSend,
    activeTerminal,
    handleClipboardActionStatus,
    openComposeWithDraft,
    session,
    workspaceId,
  ]);

  useEffect(() => {
    if (!session || isComposeSheet || composeOpen || selectionModeEnabled || !activeTerminal) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      if (isTextEntryElement(document.activeElement)) return;
      activeTerminal.focus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeTerminal, composeOpen, isComposeSheet, selectionModeEnabled, session]);

  useEffect(() => {
    setCloneIdentity({
      sessionName: session,
      clonePath: routeClonePath,
      cloneProof: routeCloneProof,
    });
  }, [routeClonePath, routeCloneProof, session]);

  useEffect(() => {
    if (previousSessionRef.current === session) return;

    previousSessionRef.current = session;
    setSelectionModeEnabled(false);
    setClipboardActionStatus(null);
  }, [session]);

  useEffect(() => {
    if (!activeTerminal) {
      setHasTerminalSelection(false);
      return;
    }

    const updateSelectionState = () =>
      setHasTerminalSelection(terminalHasSelection(activeTerminal));
    updateSelectionState();

    if (typeof activeTerminal.onSelectionChange !== "function") return;

    const disposable = activeTerminal.onSelectionChange(updateSelectionState);
    return () => disposable.dispose();
  }, [activeTerminal]);

  useEffect(() => {
    setTerminalControlsBeyondMobile(initialTerminalControlsBeyondMobile);
  }, [initialTerminalControlsBeyondMobile]);

  useEffect(() => {
    const handleComposeOpen = () => {
      setComposeOpen(true);
    };
    const handleComposeToggle = () => {
      setComposeOpen((open) => !open);
    };
    window.addEventListener(TERMINAL_COMPOSE_OPEN_EVENT, handleComposeOpen);
    window.addEventListener(TERMINAL_COMPOSE_TOGGLE_EVENT, handleComposeToggle);
    return () => {
      window.removeEventListener(TERMINAL_COMPOSE_OPEN_EVENT, handleComposeOpen);
      window.removeEventListener(TERMINAL_COMPOSE_TOGGLE_EVENT, handleComposeToggle);
    };
  }, []);

  useEffect(() => {
    const handleTerminalSettingsChanged = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      if (!isTerminalSettingsChangedDetail(event.detail)) return;
      setTerminalControlsBeyondMobile(event.detail.terminalControlsBeyondMobile);
    };

    window.addEventListener(TERMINAL_SETTINGS_CHANGED_EVENT, handleTerminalSettingsChanged);
    return () =>
      window.removeEventListener(TERMINAL_SETTINGS_CHANGED_EVENT, handleTerminalSettingsChanged);
  }, []);

  useEffect(() => {
    if (session) {
      try {
        window.localStorage.setItem(`${LAST_SESSION_STORAGE_PREFIX}${workspaceId}`, session);
      } catch {
        // Storage can be unavailable in hardened browser modes; session URL remains authoritative.
      }
      setBootstrapError(null);
      return;
    }

    let cancelled = false;
    setBootstrapError(null);
    console.log(
      `[workspaces] No session param for workspace ${workspaceId}, resolving terminal session (attempt ${bootstrapRetryKey + 1})`,
    );
    window.dispatchEvent(new CustomEvent("hive:sidebar-refresh", { detail: { workspaceId } }));

    async function resolveSession() {
      try {
        const sessionsResult = await getWorkspaceSessionsAction({ workspaceId });
        if (cancelled) return;

        if (sessionsResult?.data) {
          const sessions = sessionsResult.data;
          if (sessions.length > 0) {
            let preferred: string | null = null;
            try {
              preferred = window.localStorage.getItem(
                `${LAST_SESSION_STORAGE_PREFIX}${workspaceId}`,
              );
            } catch {
              preferred = null;
            }
            const selected = sessions.some((item) => item.name === preferred)
              ? preferred
              : sessions[0]?.name;
            if (selected) {
              router.replace(terminalSessionHref(workspaceId, selected, debugViewportEnabled));
              return;
            }
          }

          const created = await createSessionAction({ workspaceId });
          if (cancelled) return;
          if (created?.data?.name) {
            router.replace(
              terminalSessionHref(workspaceId, created.data.name, debugViewportEnabled),
            );
            return;
          }
          setBootstrapError(created?.serverError ?? "Failed to create terminal session");
          return;
        }

        setBootstrapError(sessionsResult?.serverError ?? "Failed to load terminal sessions");
      } catch (error) {
        if (cancelled) return;
        setBootstrapError(
          error instanceof Error ? error.message : "Failed to load terminal sessions",
        );
      }
    }

    void resolveSession();

    return () => {
      cancelled = true;
    };
  }, [session, workspaceId, router, bootstrapRetryKey, debugViewportEnabled]);

  if (!session) {
    const bootstrapCard = (
      <div className="mx-6 max-w-sm rounded-2xl border bg-background/95 p-5 text-center shadow-lg">
        {bootstrapError ? (
          <>
            <p className="text-sm font-medium text-foreground">Could not load terminal sessions</p>
            <p className="mt-2 text-xs text-muted-foreground">{bootstrapError}</p>
            <Button
              type="button"
              className="mt-4 min-h-11"
              onClick={() => setBootstrapRetryKey((value) => value + 1)}
            >
              Retry
            </Button>
          </>
        ) : (
          <div className="flex items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading terminal sessions…</span>
          </div>
        )}
      </div>
    );

    if (isComposeSheet) {
      return (
        <MobileTerminalShell
          className="items-center justify-center"
          diagnosticsEnabled={debugViewportEnabled}
          isKeyboardVisible={isMobileKeyboardVisible}
          reserveDashboardTrigger={false}
        >
          {bootstrapCard}
        </MobileTerminalShell>
      );
    }

    return (
      <div
        data-testid="terminal-bootstrap-shell"
        className={`${TERMINAL_SHELL_CLASS_NAME} flex items-center justify-center`}
      >
        {bootstrapCard}
      </div>
    );
  }

  const terminalPane = (
    <div
      className="h-full"
      data-sidebar-gesture-ignore={controlsSelectionModeEnabled ? "true" : undefined}
      data-terminal-surface="true"
    >
      <InteractiveTerminal
        key={session}
        agentId={agentId}
        workspaceId={workspaceId}
        sessionName={session}
        clonePath={clonePath}
        cloneProof={cloneProof}
        refreshCloneTerminalIdentity={
          canRefreshCloneIdentity ? refreshCloneTerminalIdentity : undefined
        }
        className="h-full rounded-none border-0"
        onTerminalReady={handleTerminalReady}
        onTerminalDestroy={handleTerminalDestroy}
        onComposeRequest={openComposeWithDraft}
        onClipboardStatus={handleClipboardActionStatus}
        targetLabel={terminalDisplayLabel}
        layoutSignal={mobileLayoutSignal}
        mobileInputMode={isComposeSheet}
        pinToBottomOnResize={isComposeSheet}
        selectionModeEnabled={controlsSelectionModeEnabled}
      />
    </div>
  );

  const terminalControls = (
    <MobileTerminalControls
      isKeyboardVisible={isMobileKeyboardVisible}
      onHapticFeedback={triggerHapticFeedback}
      hasSelection={hasTerminalSelection}
      selectionModeEnabled={controlsSelectionModeEnabled}
      onToggleSelectionMode={handleSelectionModeChange}
      onCopy={handleMobileCopy}
      onPaste={handleMobilePaste}
      clipboardStatusText={clipboardStatus}
      selectionModeDisabledReason={hasActiveTerminal ? undefined : "Terminal is not ready"}
      copyDisabledReason={
        hasActiveTerminal
          ? hasTerminalSelection
            ? undefined
            : "Select terminal text before copying"
          : "Terminal is not ready"
      }
      pasteDisabledReason={
        hasActiveSender ? undefined : "Paste is unavailable until the terminal sender is ready"
      }
      windowNavigation={{
        ...favoriteWindowNavigation,
        onOpenSwitcher: () => setWindowSwitcherOpen(true),
      }}
    />
  );

  if (isComposeSheet) {
    return (
      <MobileTerminalShell
        diagnosticsEnabled={debugViewportEnabled}
        isKeyboardVisible={isMobileKeyboardVisible}
        reserveDashboardTrigger={false}
      >
        <div className="flex h-full min-h-0 flex-col overflow-hidden overscroll-none bg-background">
          <SingleTerminalSessionHeader
            sessionLabel={terminalDisplayLabel}
            sessionSubtitle={terminalDisplaySubtitle}
          />
          <div className="min-h-0 flex-1 overflow-hidden p-1 pt-0">
            <TerminalSessionFrame
              label={terminalDisplayLabel}
              className="h-full rounded-lg"
              dataTestId="single-terminal-frame"
              showHeader={false}
            >
              {terminalPane}
            </TerminalSessionFrame>
          </div>
          {terminalControls}
        </div>
        <TerminalSessionCompose
          variant="sheet"
          open={composeOpen}
          onOpenChange={(open) => {
            if (open) {
              setComposeOpen(true);
            } else {
              closeCompose();
            }
          }}
          isKeyboardVisible={isMobileKeyboardVisible}
          initialDraft={composeDraft}
          targetLabel={composeTargetLabel}
          onSend={sendComposeDraft}
          onClose={closeCompose}
        />
        <CommandPalette
          open={windowSwitcherOpen}
          onOpenChange={setWindowSwitcherOpen}
          tabs={favoriteWindowTabs}
          onSelectTab={handleSelectFavoriteWindowTab}
          searchPlaceholder="Search favorite windows…"
          emptyText="No favorite windows found."
          groupHeading="Favorite windows"
        />
      </MobileTerminalShell>
    );
  }

  return (
    <div
      data-testid="terminal-desktop-shell"
      data-terminal-shell="true"
      className={`${TERMINAL_SHELL_CLASS_NAME} flex flex-col overflow-hidden bg-background`}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <SingleTerminalSessionHeader
        sessionLabel={terminalDisplayLabel}
        sessionSubtitle={terminalDisplaySubtitle}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 p-1 pt-0">
          <TerminalSessionFrame
            label={terminalDisplayLabel}
            className="h-full rounded-lg"
            dataTestId="single-terminal-frame"
            showHeader={false}
          >
            {terminalPane}
          </TerminalSessionFrame>
        </div>
        {composeOpen ? (
          <div className="h-72 min-h-56 shrink-0 p-1 pt-0">
            <TerminalSessionCompose
              variant="inline"
              initialDraft={composeDraft}
              targetLabel={composeTargetLabel}
              onSend={sendComposeDraft}
              onClose={closeCompose}
            />
          </div>
        ) : null}
      </div>
      {terminalControlsBeyondMobile ? terminalControls : null}
      <MobileTerminalDiagnosticsOverlay enabled={debugViewportEnabled} />
    </div>
  );
}

interface TerminalClientProps {
  agentId: string;
  agentName?: string;
  terminalControlsBeyondMobile?: boolean;
  workspaceId: string;
}

export function TerminalClient({
  agentId,
  terminalControlsBeyondMobile = false,
  workspaceId,
}: TerminalClientProps) {
  return (
    <Suspense
      fallback={
        <div
          data-testid="terminal-suspense-shell"
          className={`${TERMINAL_SHELL_CLASS_NAME} flex items-center justify-center`}
        >
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <TerminalInner
        agentId={agentId}
        terminalControlsBeyondMobile={terminalControlsBeyondMobile}
        workspaceId={workspaceId}
      />
    </Suspense>
  );
}
