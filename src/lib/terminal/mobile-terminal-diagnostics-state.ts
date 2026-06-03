export type MobileTerminalDiagnosticsSource = string;

export type MobileTerminalXtermDimensionsSnapshot = {
  rows: number | null;
  cols: number | null;
  updatedAt: number | null;
  source: MobileTerminalDiagnosticsSource | null;
};

export type MobileTerminalDiagnosticCounterSnapshot = {
  count: number;
  lastAt: number | null;
  lastSource: MobileTerminalDiagnosticsSource | null;
  rows: number | null;
  cols: number | null;
};

export type MobileTerminalDiagnosticsStateSnapshot = {
  xterm: MobileTerminalXtermDimensionsSnapshot;
  fit: MobileTerminalDiagnosticCounterSnapshot;
  resizeRequest: MobileTerminalDiagnosticCounterSnapshot;
  resizeSent: MobileTerminalDiagnosticCounterSnapshot;
};

const MAX_SOURCE_LENGTH = 80;

const emptyCounter = (): MobileTerminalDiagnosticCounterSnapshot => ({
  count: 0,
  lastAt: null,
  lastSource: null,
  rows: null,
  cols: null,
});

const emptyState = (): MobileTerminalDiagnosticsStateSnapshot => ({
  xterm: {
    rows: null,
    cols: null,
    updatedAt: null,
    source: null,
  },
  fit: emptyCounter(),
  resizeRequest: emptyCounter(),
  resizeSent: emptyCounter(),
});

let diagnosticsState = emptyState();

function sanitizeSource(source: MobileTerminalDiagnosticsSource | null | undefined) {
  if (!source) return null;
  const trimmed = source.trim();
  return trimmed.length > 0 ? trimmed.slice(0, MAX_SOURCE_LENGTH) : null;
}

function normalizeDimension(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}

function normalizedDimensions(rows: number, cols: number): { rows: number; cols: number } | null {
  const normalizedRows = normalizeDimension(rows);
  const normalizedCols = normalizeDimension(cols);
  if (normalizedRows === null || normalizedCols === null) return null;
  return { rows: normalizedRows, cols: normalizedCols };
}

function timestamp(now?: () => number) {
  const value = now?.() ?? Date.now();
  return Number.isFinite(value) ? value : Date.now();
}

function recordCounter(
  key: "fit" | "resizeRequest" | "resizeSent",
  rows: number,
  cols: number,
  source: MobileTerminalDiagnosticsSource,
  now?: () => number,
): boolean {
  const dimensions = normalizedDimensions(rows, cols);
  if (!dimensions) return false;

  const at = timestamp(now);
  diagnosticsState.xterm = {
    rows: dimensions.rows,
    cols: dimensions.cols,
    updatedAt: at,
    source: sanitizeSource(source),
  };
  diagnosticsState[key] = {
    count: diagnosticsState[key].count + 1,
    lastAt: at,
    lastSource: sanitizeSource(source),
    rows: dimensions.rows,
    cols: dimensions.cols,
  };
  return true;
}

export function recordMobileTerminalXtermDimensions(
  rows: number,
  cols: number,
  source: MobileTerminalDiagnosticsSource,
  now?: () => number,
): boolean {
  const dimensions = normalizedDimensions(rows, cols);
  if (!dimensions) return false;

  diagnosticsState.xterm = {
    rows: dimensions.rows,
    cols: dimensions.cols,
    updatedAt: timestamp(now),
    source: sanitizeSource(source),
  };
  return true;
}

export function recordMobileTerminalFit(
  rows: number,
  cols: number,
  source: MobileTerminalDiagnosticsSource,
  now?: () => number,
): boolean {
  return recordCounter("fit", rows, cols, source, now);
}

export function recordMobileTerminalResizeRequest(
  rows: number,
  cols: number,
  source: MobileTerminalDiagnosticsSource,
  now?: () => number,
): boolean {
  return recordCounter("resizeRequest", rows, cols, source, now);
}

export function recordMobileTerminalResizeSent(
  rows: number,
  cols: number,
  source: MobileTerminalDiagnosticsSource,
  now?: () => number,
): boolean {
  return recordCounter("resizeSent", rows, cols, source, now);
}

export function getMobileTerminalDiagnosticsState(): MobileTerminalDiagnosticsStateSnapshot {
  return {
    xterm: { ...diagnosticsState.xterm },
    fit: { ...diagnosticsState.fit },
    resizeRequest: { ...diagnosticsState.resizeRequest },
    resizeSent: { ...diagnosticsState.resizeSent },
  };
}

export function resetMobileTerminalDiagnosticsState() {
  diagnosticsState = emptyState();
}
