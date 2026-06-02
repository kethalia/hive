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
  | "X";

export interface MobileSmartKey {
  id: string;
  label: string;
  sequence: string;
  iconName: MobileSmartKeyIconName;
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
  {
    id: "position",
    label: "Position",
    ariaLabel: "Terminal position keys",
    keys: [
      { id: "home", label: "Home", sequence: VIRTUAL_KEY_SEQUENCES.Home, iconName: "ArrowUp" },
      { id: "end", label: "End", sequence: VIRTUAL_KEY_SEQUENCES.End, iconName: "ArrowDown" },
      { id: "page-up", label: "PgUp", sequence: VIRTUAL_KEY_SEQUENCES.PgUp, iconName: "ArrowUp" },
      {
        id: "page-down",
        label: "PgDn",
        sequence: VIRTUAL_KEY_SEQUENCES.PgDn,
        iconName: "ArrowDown",
      },
    ],
  },
] as const satisfies readonly MobileSmartKeyPage[];

export const MOBILE_SMART_KEYS: readonly MobileSmartKey[] = MOBILE_SMART_KEY_PAGES.flatMap(
  (page) => [...page.keys],
);
