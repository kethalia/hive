const STORAGE_KEY = "terminal:font-size";
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
const EVENT_NAME = "hive:terminal-font-size";

export { MIN_FONT_SIZE, MAX_FONT_SIZE, DEFAULT_FONT_SIZE, EVENT_NAME };

export function getTerminalFontSize(): number {
  if (typeof window === "undefined") return DEFAULT_FONT_SIZE;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_FONT_SIZE;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < MIN_FONT_SIZE || parsed > MAX_FONT_SIZE) {
    return DEFAULT_FONT_SIZE;
  }
  return parsed;
}

export function setTerminalFontSize(size: number): number {
  const clamped = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
  localStorage.setItem(STORAGE_KEY, String(clamped));
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: clamped }));
  return clamped;
}
