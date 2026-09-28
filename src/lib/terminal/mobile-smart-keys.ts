import { VIRTUAL_KEY_SEQUENCES } from "@/lib/terminal/virtual-keys";

export type MobileSmartKeyIconName =
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowRightToLine"
  | "ArrowUp"
  | "CornerDownLeft"
  | "DoorOpen"
  | "RefreshCw"
  | "Plus"
  | "X";

export interface MobileSmartKey {
  id: string;
  label: string;
  sequence: string;
  iconName: MobileSmartKeyIconName;
  description?: string;
}

export interface MobileSmartKeyPage {
  id: string;
  label: string;
  ariaLabel: string;
  keys: readonly MobileSmartKey[];
}

export const MOBILE_SMART_KEY_PAGES = [
  {
    id: "keys",
    label: "Keys",
    ariaLabel: "Terminal quick actions",
    keys: [
      {
        id: "enter",
        label: "Enter",
        sequence: VIRTUAL_KEY_SEQUENCES.Enter,
        iconName: "CornerDownLeft",
      },
      {
        id: "tab",
        label: "Tab",
        sequence: VIRTUAL_KEY_SEQUENCES.Tab,
        iconName: "ArrowRightToLine",
      },
      { id: "esc", label: "Esc", sequence: VIRTUAL_KEY_SEQUENCES.Esc, iconName: "DoorOpen" },
      {
        id: "backspace",
        label: "Backspace",
        sequence: VIRTUAL_KEY_SEQUENCES.Backspace,
        iconName: "ArrowLeft",
      },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    ariaLabel: "Codex shortcuts",
    keys: [
      {
        id: "codex-queue",
        label: "Queue",
        sequence: "\t",
        iconName: "ArrowRightToLine",
        description: "Queue follow-up (Tab)",
      },
      {
        id: "codex-steer",
        label: "Steer",
        sequence: "\r",
        iconName: "CornerDownLeft",
        description: "Send or steer current turn (Enter)",
      },
      {
        id: "codex-transcript",
        label: "Transcript",
        sequence: "\x14",
        iconName: "ArrowUp",
        description: "Open transcript (Ctrl+T)",
      },
      {
        id: "codex-copy",
        label: "Copy reply",
        sequence: "\x0f",
        iconName: "ArrowLeft",
        description: "Copy latest Codex output (Ctrl+O)",
      },
    ],
  },
  {
    id: "questions",
    label: "Questions",
    ariaLabel: "Codex question controls",
    keys: [
      { id: "question-up", label: "Option up", sequence: "\x1b[A", iconName: "ArrowUp" },
      { id: "question-down", label: "Option down", sequence: "\x1b[B", iconName: "ArrowDown" },
      {
        id: "question-toggle",
        label: "Select",
        sequence: " ",
        iconName: "Plus",
        description: "Toggle an option (Space)",
      },
      {
        id: "question-answer",
        label: "Answer",
        sequence: "\r",
        iconName: "CornerDownLeft",
        description: "Confirm answer (Enter)",
      },
      {
        id: "question-back",
        label: "Previous",
        sequence: "\x1b[Z",
        iconName: "ArrowLeft",
        description: "Previous field (Shift+Tab)",
      },
      {
        id: "question-next",
        label: "Next",
        sequence: "\t",
        iconName: "ArrowRight",
        description: "Next field (Tab)",
      },
      { id: "question-left", label: "Choice left", sequence: "\x1b[D", iconName: "ArrowLeft" },
      { id: "question-right", label: "Choice right", sequence: "\x1b[C", iconName: "ArrowRight" },
    ],
  },
  {
    id: "control",
    label: "Control",
    ariaLabel: "Terminal control keys",
    keys: [
      { id: "ctrl-c", label: "Ctrl+C", sequence: VIRTUAL_KEY_SEQUENCES.CtrlC, iconName: "X" },
      {
        id: "ctrl-d",
        label: "Ctrl+D",
        sequence: VIRTUAL_KEY_SEQUENCES.CtrlD,
        iconName: "DoorOpen",
      },
      {
        id: "ctrl-l",
        label: "Ctrl+L",
        sequence: VIRTUAL_KEY_SEQUENCES.CtrlL,
        iconName: "RefreshCw",
      },
      {
        id: "ctrl-r",
        label: "Ctrl+R",
        sequence: VIRTUAL_KEY_SEQUENCES.CtrlR,
        iconName: "ArrowLeft",
      },
    ],
  },
  {
    id: "navigation",
    label: "Navigation",
    ariaLabel: "Terminal navigation keys",
    keys: [
      { id: "up", label: "Up", sequence: VIRTUAL_KEY_SEQUENCES.Up, iconName: "ArrowUp" },
      { id: "down", label: "Down", sequence: VIRTUAL_KEY_SEQUENCES.Down, iconName: "ArrowDown" },
      { id: "left", label: "Left", sequence: VIRTUAL_KEY_SEQUENCES.Left, iconName: "ArrowLeft" },
      {
        id: "right",
        label: "Right",
        sequence: VIRTUAL_KEY_SEQUENCES.Right,
        iconName: "ArrowRight",
      },
    ],
  },
] as const satisfies readonly MobileSmartKeyPage[];

export const MOBILE_SMART_KEYS: readonly MobileSmartKey[] = MOBILE_SMART_KEY_PAGES.flatMap(
  (page) => [...page.keys],
);
