export function eventTargetElement(target: EventTarget | null): Element | null {
  if (typeof Element === "undefined") return null;
  return target instanceof Element ? target : null;
}

export function isTerminalHelperTextAreaTarget(target: EventTarget | null): boolean {
  const element = eventTargetElement(target);
  if (!element) return false;
  return element.closest(".xterm-helper-textarea, .xterm .xterm-helper-textarea") !== null;
}

export function isTextEntryEventTarget(target: EventTarget | null): boolean {
  const element = eventTargetElement(target);
  if (!element || typeof HTMLElement === "undefined") return false;

  if (element.closest('[contenteditable="true"]')) return true;

  const control = element.closest("input, textarea, select");
  return control instanceof HTMLElement;
}
