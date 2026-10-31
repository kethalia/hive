import { ORIGIN } from "./policy.mjs";
/** Fixed categories only. Never return URLs, query strings, messages or input values. */
export function requestCategory(url, resourceType) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "invalid";
  }
  if (u.origin !== ORIGIN) return "foreign";
  if (u.pathname === "/api/auth/login") return "login";
  if (u.pathname === "/api/auth/logout") return "logout";
  if (u.pathname === "/login") return "loginDocument";
  if (u.pathname === "/workspaces") return "dashboardDocument";
  if (u.pathname.startsWith("/_next/static/"))
    return (
      {
        script: "staticScript",
        stylesheet: "staticStyle",
        font: "staticFont",
        image: "staticImage",
      }[resourceType] ?? "staticOther"
    );
  if (u.pathname.startsWith("/_next/")) return "frameworkOther";
  if (u.pathname.startsWith("/api/")) return "otherApi";
  return (
    {
      script: "otherScript",
      stylesheet: "otherStyle",
      font: "otherFont",
      image: "otherImage",
      document: "otherDocument",
    }[resourceType] ?? "other"
  );
}
export function installPageDiagnostics() {
  const value = { clicks: 0, submits: 0, invalid: 0, csp: {} };
  window.__hiveBrowserDiagnostic = value;
  document.addEventListener(
    "click",
    (event) => {
      if (event.target instanceof Element && event.target.closest('button[type="submit"]'))
        value.clicks = Math.min(255, value.clicks + 1);
    },
    true,
  );
  document.addEventListener(
    "submit",
    () => {
      value.submits = Math.min(255, value.submits + 1);
    },
    true,
  );
  document.addEventListener(
    "invalid",
    () => {
      value.invalid = Math.min(255, value.invalid + 1);
    },
    true,
  );
  document.addEventListener("securitypolicyviolation", (event) => {
    const directive = [
      "script-src",
      "script-src-elem",
      "script-src-attr",
      "style-src",
      "style-src-elem",
      "font-src",
      "connect-src",
    ].includes(event.effectiveDirective)
      ? event.effectiveDirective
      : "other";
    value.csp[directive] = Math.min(255, (value.csp[directive] ?? 0) + 1);
  });
}
export function formDiagnostics() {
  const form = document.querySelector("form"),
    email = document.querySelector("#email"),
    password = document.querySelector("#password"),
    button = document.querySelector('button[type="submit"]');
  const props = (element) =>
    element &&
    Object.keys(element)
      .filter((key) => key.startsWith("__reactProps$"))
      .map((key) => element[key]);
  const controlledMatches = (element) =>
    !!element &&
    !!props(element)?.some(
      (value) => typeof value.value === "string" && value.value === element.value,
    );
  return {
    readyState: document.readyState,
    formPresent: !!form,
    reactSubmitHandlerPresent: !!props(form)?.some((value) => typeof value.onSubmit === "function"),
    emailFilled: !!email?.value,
    passwordFilled: !!password?.value,
    emailValid: !!email?.validity.valid,
    emailTypeMismatch: !!email?.validity.typeMismatch,
    emailMissing: !!email?.validity.valueMissing,
    passwordValid: !!password?.validity.valid,
    passwordMissing: !!password?.validity.valueMissing,
    emailControlledMatches: controlledMatches(email),
    passwordControlledMatches: controlledMatches(password),
    buttonDisabled: button?.disabled ?? null,
    clicks: window.__hiveBrowserDiagnostic?.clicks ?? 0,
    submits: window.__hiveBrowserDiagnostic?.submits ?? 0,
    invalid: window.__hiveBrowserDiagnostic?.invalid ?? 0,
    csp: window.__hiveBrowserDiagnostic?.csp ?? {},
  };
}
