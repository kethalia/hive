const FONT_SIZE_LADDER = [10, 12, 14, 16, 18, 20] as const;
const STORAGE_KEY = "terminal:font-size";
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = FONT_SIZE_LADDER[0];
const MAX_FONT_SIZE = FONT_SIZE_LADDER[FONT_SIZE_LADDER.length - 1];
const EVENT_NAME = "hive:terminal-font-size";

export { FONT_SIZE_LADDER, MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_FONT_SIZE, EVENT_NAME, STORAGE_KEY };

export function getTerminalFontSize(): number {
  if (typeof window === "undefined") return DEFAULT_FONT_SIZE;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_FONT_SIZE;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, parsed));
}

export function setTerminalFontSize(size: number): number {
  const clamped = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
  if (typeof window === "undefined") return clamped;
  localStorage.setItem(STORAGE_KEY, String(clamped));
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: clamped }));
  return clamped;
}
