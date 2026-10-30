"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  Command,
  Copy,
  FileUp,
  Grid2X2,
  Keyboard,
  Layers,
  Minus,
  Plus,
} from "lucide-react";
import { type ComponentProps, type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { MOBILE_SMART_KEYS } from "@/lib/terminal/mobile-smart-keys";
import { encodeTerminalShortcut, type TerminalKeyModifiers } from "@/lib/terminal/shortcut-keys";
import { cn } from "@/lib/utils";
import "./workspace-dock.css";

export type DockView = "home" | "workspaces" | "keyboard";
export type DockAction = "copy" | "paste" | "upload" | "font-decrease" | "font-increase";
export interface DockWorkspace {
  id: string;
  name: string;
}
export interface DockKeyPress {
  key: string;
  sequence: string;
  modifiers: TerminalKeyModifiers;
}

export interface WorkspaceDockProps {
  workspaces: readonly DockWorkspace[];
  activeWorkspaceId: string;
  onWorkspaceSelect: (id: string) => void;
  onWorkspaceCreate: () => void;
  onAppsOpen: () => void;
  onKeybindsOpen: () => void;
  onKeyPress: (press: DockKeyPress) => void;
  onAction: (action: DockAction) => void;
  /** Supply disabled reasons when the selected terminal cannot perform an action. */
  disabledActions?: Partial<Record<DockAction, string>>;
  canCreateWorkspace?: boolean;
  density?: "comfortable" | "compact";
  className?: string;
}

const NO_MODIFIERS: TerminalKeyModifiers = { ctrl: false, alt: false, shift: false };
const ARROWS = { Up: ArrowUp, Down: ArrowDown, Left: ArrowLeft, Right: ArrowRight };
const ACTIONS = [
  { id: "copy", label: "Copy terminal selection", Icon: Copy },
  { id: "paste", label: "Paste from clipboard", Icon: ClipboardPaste },
  { id: "upload", label: "Upload files", Icon: FileUp },
  { id: "font-decrease", label: "Decrease font size", Icon: Minus },
  { id: "font-increase", label: "Increase font size", Icon: Plus },
] as const;

function DockButton({
  label,
  children,
  className,
  ...props
}: ComponentProps<typeof Button> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            aria-label={label}
            className={cn("hive-dock-button", className)}
            {...props}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent className="hive-dock-tooltip" sideOffset={14}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** Standalone prototype: consumers own all workspace and terminal effects. */
export function WorkspaceDock({
  workspaces,
  activeWorkspaceId,
  onWorkspaceSelect,
  onWorkspaceCreate,
  onAppsOpen,
  onKeybindsOpen,
  onKeyPress,
  onAction,
  disabledActions,
  canCreateWorkspace = true,
  density = "comfortable",
  className,
}: WorkspaceDockProps) {
  const [view, setView] = useState<DockView>("home");
  const [modifiers, setModifiers] = useState(NO_MODIFIERS);
  const navRef = useRef<HTMLElement>(null);
  const previousView = useRef(view);
  const returnTarget = useRef("workspaces");

  useLayoutEffect(() => {
    if (previousView.current === view) return;
    const selector =
      view === "home" ? `[data-dock-opener="${returnTarget.current}"]` : "[data-dock-back]";
    navRef.current?.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
    const options = navRef.current?.querySelector(".hive-dock-options");
    if (options) options.scrollLeft = 0;
    previousView.current = view;
  }, [view]);

  function open(next: "workspaces" | "keyboard") {
    returnTarget.current = next;
    setView(next);
  }

  function back() {
    setModifiers(NO_MODIFIERS);
    setView("home");
  }

  function navigate(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && view !== "home") {
      event.preventDefault();
      event.stopPropagation();
      back();
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    );
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus({ preventScroll: true });
    const button = buttons[next];
    const options = navRef.current?.querySelector<HTMLElement>(".hive-dock-options");
    if (button && options?.contains(button)) {
      const item = button.getBoundingClientRect();
      const viewport = options.getBoundingClientRect();
      if (item.left < viewport.left) options.scrollLeft -= viewport.left - item.left + 3;
      else if (item.right > viewport.right) options.scrollLeft += item.right - viewport.right + 3;
    }
  }

  const prefix = `${modifiers.ctrl ? "Ctrl+" : ""}${modifiers.alt ? "Alt+" : ""}${modifiers.shift ? "Shift+" : ""}`;

  return (
    <TooltipProvider delay={250}>
      <nav
        ref={navRef}
        aria-label="Workspace dock"
        className={cn("hive-dock", className)}
        data-view={view}
        data-density={density}
        onKeyDown={navigate}
      >
        <span className="sr-only" aria-live="polite">
          {view === "home"
            ? "Main dock"
            : view === "workspaces"
              ? "Workspace controls"
              : "Extra keyboard controls"}
        </span>
        {view === "home" ? (
          <div className="hive-dock-home">
            <DockButton
              label="Apps"
              className="hive-dock-app hive-dock-launcher"
              onClick={onAppsOpen}
              aria-haspopup="dialog"
            >
              <Grid2X2 aria-hidden="true" />
            </DockButton>
            <DockButton
              label="Workspaces"
              className="hive-dock-app hive-dock-workspaces"
              data-dock-opener="workspaces"
              onClick={() => open("workspaces")}
              aria-expanded={false}
            >
              <Layers aria-hidden="true" />
              <span className="hive-dock-count">{workspaces.length}</span>
            </DockButton>
            <DockButton
              label="Extra keyboard"
              className="hive-dock-app hive-dock-keyboard"
              data-dock-opener="keyboard"
              onClick={() => open("keyboard")}
              aria-expanded={false}
            >
              <Keyboard aria-hidden="true" />
            </DockButton>
            <span className="hive-dock-divider" />
            <DockButton
              label="Keybinds"
              className="hive-dock-app hive-dock-keybinds"
              onClick={onKeybindsOpen}
              aria-haspopup="dialog"
            >
              <Command aria-hidden="true" />
            </DockButton>
          </div>
        ) : (
          <>
            <DockButton
              label="Back to main dock"
              className="hive-dock-back"
              data-dock-back
              onClick={back}
            >
              <ArrowLeft aria-hidden="true" />
            </DockButton>
            <span className="hive-dock-divider" />
            <div className="hive-dock-options" key={view}>
              {view === "workspaces" ? (
                <>
                  <DockButton
                    label="Create workspace"
                    className="hive-dock-create"
                    onClick={onWorkspaceCreate}
                    disabled={!canCreateWorkspace}
                  >
                    <Plus aria-hidden="true" />
                  </DockButton>
                  {workspaces.map((workspace, index) => (
                    <DockButton
                      key={workspace.id}
                      label={`Workspace ${index + 1}: ${workspace.name}`}
                      className="hive-dock-workspace"
                      aria-current={workspace.id === activeWorkspaceId ? "page" : undefined}
                      onClick={() => onWorkspaceSelect(workspace.id)}
                    >
                      {index + 1}
                    </DockButton>
                  ))}
                </>
              ) : (
                <>
                  {(["ctrl", "alt", "shift"] as const).map((modifier) => (
                    <DockButton
                      key={modifier}
                      label={`${modifier === "ctrl" ? "Ctrl" : modifier === "alt" ? "Alt" : "Shift"} modifier`}
                      className="hive-dock-key"
                      aria-pressed={modifiers[modifier]}
                      onClick={() =>
                        setModifiers((current) => ({ ...current, [modifier]: !current[modifier] }))
                      }
                    >
                      {modifier === "ctrl" ? "Ctrl" : modifier === "alt" ? "Alt" : "Shift"}
                    </DockButton>
                  ))}
                  <span className="hive-dock-divider" />
                  {MOBILE_SMART_KEYS.map(({ label }) => {
                    const Icon = ARROWS[label as keyof typeof ARROWS];
                    return (
                      <DockButton
                        key={label}
                        label={`${prefix}${label}`}
                        className="hive-dock-key"
                        onClick={() => {
                          onKeyPress({
                            key: label,
                            sequence: encodeTerminalShortcut(label, modifiers),
                            modifiers: { ...modifiers },
                          });
                          setModifiers(NO_MODIFIERS);
                        }}
                      >
                        {Icon ? (
                          <Icon aria-hidden="true" />
                        ) : label === "Backspace" ? (
                          "⌫"
                        ) : label === "Enter" ? (
                          "↵"
                        ) : label === "Space" ? (
                          "␣"
                        ) : (
                          label
                        )}
                      </DockButton>
                    );
                  })}
                  <span className="hive-dock-divider" />
                  {ACTIONS.map(({ id, label, Icon }) => (
                    <DockButton
                      key={id}
                      label={disabledActions?.[id] ?? label}
                      className="hive-dock-key"
                      disabled={Boolean(disabledActions?.[id])}
                      onClick={() => onAction(id)}
                    >
                      <Icon aria-hidden="true" />
                    </DockButton>
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </nav>
    </TooltipProvider>
  );
}
