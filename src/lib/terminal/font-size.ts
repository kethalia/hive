const FONT_SIZE_LADDER = [8, 10, 12, 14, 16, 18, 20, 22, 24, 28] as const;
const STORAGE_KEY = "terminal:font-size";
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = FONT_SIZE_LADDER[0];
const MAX_FONT_SIZE = FONT_SIZE_LADDER[FONT_SIZE_LADDER.length - 1];
const EVENT_NAME = "hive:terminal-font-size";

export {
  DEFAULT_FONT_SIZE,
  EVENT_NAME,
  FONT_SIZE_LADDER,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  STORAGE_KEY,
};

function finiteSizeOrDefault(size: number): number {
  return Number.isFinite(size) ? size : DEFAULT_FONT_SIZE;
}

export function snapTerminalFontSize(size: number): number {
  const clamped = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, finiteSizeOrDefault(size)));

  return FONT_SIZE_LADDER.reduce((closest, candidate) => {
    const candidateDistance = Math.abs(candidate - clamped);
    const closestDistance = Math.abs(closest - clamped);
    return candidateDistance < closestDistance ? candidate : closest;
  }, MIN_FONT_SIZE as number);
}

export function fontSizeFromPinchScale(baseSize: number, scale: number): number {
  const base = finiteSizeOrDefault(baseSize);
  if (!Number.isFinite(scale) || scale <= 0) return snapTerminalFontSize(base);
  return snapTerminalFontSize(base * scale);
}

export function terminalFontSizeScope(workspaceId: string, sessionName: string): string {
  return `${STORAGE_KEY}:${JSON.stringify([workspaceId, sessionName])}`;
}

export interface TerminalFontSizeChange {
  scope: string;
  size: number;
}

export function getTerminalFontSize(scope: string | null): number {
  if (typeof window === "undefined") return DEFAULT_FONT_SIZE;
  try {
    // Preserve the previous preference until this session has its own size.
    const raw = (scope ? localStorage.getItem(scope) : null) ?? localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_FONT_SIZE;
    const parsed = parseInt(raw, 10);
    if (Number.isNaN(parsed)) return DEFAULT_FONT_SIZE;
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, parsed));
  } catch {
    return DEFAULT_FONT_SIZE;
  }
}

export function setTerminalFontSize(size: number, scope: string): number {
  const clamped = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, finiteSizeOrDefault(size)));
  if (typeof window === "undefined") return clamped;
  try {
    localStorage.setItem(scope, String(clamped));
  } catch {
    // Storage can be unavailable; still notify mounted terminals so the live control works.
  }
  window.dispatchEvent(
    new CustomEvent<TerminalFontSizeChange>(EVENT_NAME, { detail: { scope, size: clamped } }),
  );
  return clamped;
}

export function subscribeTerminalFontSize(scope: string, onChange: (size: number) => void) {
  const handler = (event: Event) => {
    const change = (event as CustomEvent<TerminalFontSizeChange>).detail;
    if (change?.scope === scope) onChange(change.size);
  };
  const storageHandler = (event: StorageEvent) => {
    if (event.key === scope || event.key === null) onChange(getTerminalFontSize(scope));
  };
  window.addEventListener(EVENT_NAME, handler);
  window.addEventListener("storage", storageHandler);
  return () => {
    window.removeEventListener(EVENT_NAME, handler);
    window.removeEventListener("storage", storageHandler);
  };
}
