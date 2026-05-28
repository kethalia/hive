export type MobileViewportRectSnapshot = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type MobileViewportLayoutSnapshot = {
  width: number | null;
  height: number | null;
};

export type MobileVisualViewportSnapshot = {
  width: number | null;
  height: number | null;
  offsetLeft: number | null;
  offsetTop: number | null;
  pageLeft: number | null;
  pageTop: number | null;
  scale: number | null;
};

export type MobileDocumentBoxSnapshot = {
  clientWidth: number | null;
  clientHeight: number | null;
  scrollWidth: number | null;
  scrollHeight: number | null;
  offsetWidth: number | null;
  offsetHeight: number | null;
};

export type MobileDocumentScrollSnapshot = {
  scrollX: number | null;
  scrollY: number | null;
  documentElement: MobileDocumentBoxSnapshot | null;
  body: MobileDocumentBoxSnapshot | null;
};

export type MobileActiveElementSnapshot = {
  tagName: string;
  id: string | null;
  role: string | null;
  testId: string | null;
  ariaLabel: string | null;
  className: string | null;
  type: string | null;
  inputMode: string | null;
};

export type MobileViewportDiagnosticsSnapshot = {
  version: 1;
  sampledAt: number;
  viewport: {
    layout: MobileViewportLayoutSnapshot;
    visual: MobileVisualViewportSnapshot | null;
    keyboardInsetBottom: number | null;
  };
  document: MobileDocumentScrollSnapshot | null;
  cssVars: Record<string, string>;
  activeElement: MobileActiveElementSnapshot | null;
  terminal: {
    shellRect: MobileViewportRectSnapshot | null;
    helperTextareaRect: MobileViewportRectSnapshot | null;
  };
};

type SampleMobileViewportDiagnosticsOptions = {
  window?: Window;
  document?: Document;
  root?: ParentNode;
  now?: () => number;
  cssVarNames?: readonly string[];
  terminalShellSelector?: string;
  helperTextareaSelector?: string;
};

export const DEFAULT_TERMINAL_SHELL_SELECTOR =
  '[data-terminal-shell], [data-testid="terminal-shell"], .terminal-mobile-shell';
export const DEFAULT_XTERM_HELPER_TEXTAREA_SELECTOR = ".xterm-helper-textarea";
export const DEFAULT_MOBILE_VIEWPORT_CSS_VARS = [
  "--app-viewport-height",
  "--app-visual-viewport-height",
  "--app-visual-viewport-offset-top",
  "--safe-area-inset-top",
  "--safe-area-inset-right",
  "--safe-area-inset-bottom",
  "--safe-area-inset-left",
] as const;

function currentWindow(candidate?: Window): Window | null {
  if (candidate) return candidate;
  if (typeof window === "undefined") return null;
  return window;
}

function currentDocument(candidateDocument?: Document, candidateWindow?: Window): Document | null {
  if (candidateDocument) return candidateDocument;
  const resolvedWindow = currentWindow(candidateWindow);
  if (resolvedWindow?.document) return resolvedWindow.document;
  if (typeof document === "undefined") return null;
  return document;
}

function finiteNumber(value: number | undefined): number | null {
  if (typeof value !== "number") return null;
  return Number.isFinite(value) ? value : null;
}

function elementAttribute(element: Element, name: string): string | null {
  const value = element.getAttribute(name);
  return value && value.length > 0 ? value : null;
}

export function getElementRectSnapshot(
  element: Element | null | undefined,
): MobileViewportRectSnapshot | null {
  if (!element) return null;

  const rect = element.getBoundingClientRect();
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
  };
}

export function getLayoutViewportSnapshot(win?: Window): MobileViewportLayoutSnapshot {
  const resolvedWindow = currentWindow(win);
  return {
    width: finiteNumber(resolvedWindow?.innerWidth),
    height: finiteNumber(resolvedWindow?.innerHeight),
  };
}

export function getVisualViewportSnapshot(win?: Window): MobileVisualViewportSnapshot | null {
  const viewport = currentWindow(win)?.visualViewport;
  if (!viewport) return null;

  return {
    width: finiteNumber(viewport.width),
    height: finiteNumber(viewport.height),
    offsetLeft: finiteNumber(viewport.offsetLeft),
    offsetTop: finiteNumber(viewport.offsetTop),
    pageLeft: finiteNumber(viewport.pageLeft),
    pageTop: finiteNumber(viewport.pageTop),
    scale: finiteNumber(viewport.scale),
  };
}

export function getKeyboardInsetBottom(win?: Window): number | null {
  const layout = getLayoutViewportSnapshot(win);
  const visual = getVisualViewportSnapshot(win);
  if (!visual || layout.height === null || visual.height === null || visual.offsetTop === null) {
    return null;
  }

  return Math.max(0, layout.height - (visual.height + visual.offsetTop));
}

function getDocumentBoxSnapshot(element: HTMLElement | null): MobileDocumentBoxSnapshot | null {
  if (!element) return null;

  return {
    clientWidth: finiteNumber(element.clientWidth),
    clientHeight: finiteNumber(element.clientHeight),
    scrollWidth: finiteNumber(element.scrollWidth),
    scrollHeight: finiteNumber(element.scrollHeight),
    offsetWidth: finiteNumber(element.offsetWidth),
    offsetHeight: finiteNumber(element.offsetHeight),
  };
}

export function getDocumentScrollSnapshot(
  doc?: Document,
  win?: Window,
): MobileDocumentScrollSnapshot | null {
  const resolvedDocument = currentDocument(doc, win);
  if (!resolvedDocument) return null;

  const resolvedWindow = currentWindow(win);
  return {
    scrollX: finiteNumber(resolvedWindow?.scrollX ?? resolvedWindow?.pageXOffset),
    scrollY: finiteNumber(resolvedWindow?.scrollY ?? resolvedWindow?.pageYOffset),
    documentElement: getDocumentBoxSnapshot(resolvedDocument.documentElement),
    body: getDocumentBoxSnapshot(resolvedDocument.body),
  };
}

export function getActiveElementSnapshot(doc?: Document): MobileActiveElementSnapshot | null {
  const resolvedDocument = currentDocument(doc);
  const element = resolvedDocument?.activeElement;
  if (!element || element === resolvedDocument?.body) return null;

  const className =
    typeof element.className === "string" && element.className.length > 0
      ? element.className
      : null;

  return {
    tagName: element.tagName.toLowerCase(),
    id: element.id || null,
    role: elementAttribute(element, "role"),
    testId: elementAttribute(element, "data-testid"),
    ariaLabel: elementAttribute(element, "aria-label"),
    className,
    type: elementAttribute(element, "type"),
    inputMode: elementAttribute(element, "inputmode"),
  };
}

export function getCssViewportVars(
  doc?: Document,
  names: readonly string[] = DEFAULT_MOBILE_VIEWPORT_CSS_VARS,
): Record<string, string> {
  const resolvedDocument = currentDocument(doc);
  if (!resolvedDocument) return {};

  const styles = resolvedDocument.defaultView?.getComputedStyle(resolvedDocument.documentElement);
  if (!styles) return {};

  const values: Record<string, string> = {};
  for (const name of names) {
    values[name] = styles.getPropertyValue(name).trim();
  }
  return values;
}

export function sampleMobileViewportDiagnostics(
  options: SampleMobileViewportDiagnosticsOptions = {},
): MobileViewportDiagnosticsSnapshot {
  const win = currentWindow(options.window);
  const doc = currentDocument(options.document, win ?? undefined);
  const root = options.root ?? doc;
  const terminalShell =
    root?.querySelector(options.terminalShellSelector ?? DEFAULT_TERMINAL_SHELL_SELECTOR) ?? null;
  const helperTextarea =
    root?.querySelector(options.helperTextareaSelector ?? DEFAULT_XTERM_HELPER_TEXTAREA_SELECTOR) ??
    null;

  return {
    version: 1,
    sampledAt: options.now?.() ?? Date.now(),
    viewport: {
      layout: getLayoutViewportSnapshot(win ?? undefined),
      visual: getVisualViewportSnapshot(win ?? undefined),
      keyboardInsetBottom: getKeyboardInsetBottom(win ?? undefined),
    },
    document: getDocumentScrollSnapshot(doc ?? undefined, win ?? undefined),
    cssVars: getCssViewportVars(doc ?? undefined, options.cssVarNames),
    activeElement: getActiveElementSnapshot(doc ?? undefined),
    terminal: {
      shellRect: getElementRectSnapshot(terminalShell),
      helperTextareaRect: getElementRectSnapshot(helperTextarea),
    },
  };
}
