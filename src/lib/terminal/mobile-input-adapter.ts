export const XTERM_HELPER_TEXTAREA_SELECTOR = ".xterm-helper-textarea";

interface TerminalFocusTarget {
  focus?: () => void;
}

interface AttributeSnapshot {
  name: string;
  value: string | null;
}

interface StyleSnapshot {
  fontSize: string;
}

export interface MobileInputAdapterCleanup {
  applied: boolean;
  dispose: () => void;
  helper: HTMLTextAreaElement | null;
}

const MOBILE_INPUT_ATTRIBUTES: Record<string, string> = {
  autocapitalize: "off",
  autocomplete: "off",
  autocorrect: "off",
  "data-terminal-mobile-input": "true",
  enterkeyhint: "enter",
  inputmode: "text",
  spellcheck: "false",
};

function snapshotAttributes(
  helper: HTMLTextAreaElement,
  attributeNames: string[],
): AttributeSnapshot[] {
  return attributeNames.map((name) => ({
    name,
    value: helper.getAttribute(name),
  }));
}

function restoreAttributes(helper: HTMLTextAreaElement, snapshots: AttributeSnapshot[]) {
  for (const { name, value } of snapshots) {
    if (value === null) {
      helper.removeAttribute(name);
    } else {
      helper.setAttribute(name, value);
    }
  }
}

function applyMobileInputAttributes(helper: HTMLTextAreaElement) {
  for (const [name, value] of Object.entries(MOBILE_INPUT_ATTRIBUTES)) {
    helper.setAttribute(name, value);
  }
  helper.spellcheck = false;
}

function findXtermMobileHelper(
  root: ParentNode | null,
  selector = XTERM_HELPER_TEXTAREA_SELECTOR,
): HTMLTextAreaElement | null {
  return root?.querySelector<HTMLTextAreaElement>(selector) ?? null;
}

export function blurXtermMobileInput(
  root: ParentNode | null,
  selector = XTERM_HELPER_TEXTAREA_SELECTOR,
): boolean {
  const helper = findXtermMobileHelper(root, selector);
  if (!helper) return false;

  helper.blur();
  return true;
}

export function configureXtermMobileInput(
  root: ParentNode | null,
  selector = XTERM_HELPER_TEXTAREA_SELECTOR,
): MobileInputAdapterCleanup {
  const helper = findXtermMobileHelper(root, selector);
  if (!helper) {
    return { applied: false, dispose: () => {}, helper: null };
  }

  const attributeSnapshots = snapshotAttributes(helper, Object.keys(MOBILE_INPUT_ATTRIBUTES));
  const spellcheckProperty = helper.spellcheck;
  const styleSnapshot: StyleSnapshot = {
    fontSize: helper.style.fontSize,
  };

  applyMobileInputAttributes(helper);
  helper.style.fontSize = "16px";

  return {
    applied: true,
    helper,
    dispose: () => {
      restoreAttributes(helper, attributeSnapshots);
      helper.spellcheck = spellcheckProperty;
      helper.style.fontSize = styleSnapshot.fontSize;
    },
  };
}

export function focusTerminalForMobileInput(term: TerminalFocusTarget | null | undefined): boolean {
  if (typeof term?.focus !== "function") return false;
  term.focus();
  return true;
}
