export function eventTargetElement(target: EventTarget | null): Element | null {
  if (typeof Element === "undefined") return null;
  return target instanceof Element ? target : null;
}

export function isTerminalHelperTextAreaTarget(target: EventTarget | null): boolean {
  const element = eventTargetElement(target);
  if (!element) return false;
  return element.closest(".xterm-helper-textarea, .xterm .xterm-helper-textarea") !== null;
}

function closestEditableElement(element: Element): HTMLElement | null {
  if (typeof HTMLElement === "undefined") return null;

  for (let current: Element | null = element; current; current = current.parentElement) {
    if (!(current instanceof HTMLElement)) continue;

    const contentEditable = current.getAttribute("contenteditable");
    if (contentEditable === null) continue;

    if (contentEditable.toLowerCase() === "false") return null;
    return current;
  }

  return null;
}

export function isTextEntryEventTarget(target: EventTarget | null): boolean {
  const element = eventTargetElement(target);
  if (!element || typeof HTMLElement === "undefined") return false;

  if (element instanceof HTMLElement && element.isContentEditable) return true;
  if (closestEditableElement(element)) return true;

  const control = element.closest("input, textarea, select");
  return control instanceof HTMLElement;
}
