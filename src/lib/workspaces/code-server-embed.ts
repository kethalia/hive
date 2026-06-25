export function shouldEmbedCodeServerInCurrentBrowser(
  navigatorLike: Pick<Navigator, "userAgent" | "vendor"> = navigator,
): boolean {
  const userAgent = navigatorLike.userAgent;
  const vendor = navigatorLike.vendor;
  const isAppleBrowser = vendor.includes("Apple");
  const isWebKit = /AppleWebKit/i.test(userAgent);
  const isSafariFamily = /Safari/i.test(userAgent);
  const isChromiumFamily = /Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|OPiOS/i.test(userAgent);
  const isFirefoxFamily = /Firefox|FxiOS/i.test(userAgent);

  return !(isAppleBrowser && isWebKit && isSafariFamily && !isChromiumFamily && !isFirefoxFamily);
}

export const CODE_SERVER_POPUP_TARGET = "hive-code-server-popup";
export const CODE_SERVER_POPUP_FEATURES = [
  "popup=yes",
  "width=1440",
  "height=960",
  "left=80",
  "top=60",
  "location=no",
  "toolbar=no",
  "menubar=no",
  "status=no",
  "resizable=yes",
  "scrollbars=yes",
].join(",");

export function openCodeServerPopupWindow(): Window | null {
  const popup = window.open("about:blank", CODE_SERVER_POPUP_TARGET, CODE_SERVER_POPUP_FEATURES);
  if (popup) {
    popup.opener = null;
  }
  return popup;
}

export function openCodeServerPopupUrl(url: string): Window | null {
  const popup = window.open(url, CODE_SERVER_POPUP_TARGET, CODE_SERVER_POPUP_FEATURES);
  if (popup) {
    popup.opener = null;
  }
  return popup;
}

export function navigateCodeServerPopupWindow(popup: Window | null, url: string): boolean {
  if (!popup) return false;
  try {
    popup.location.href = url;
    return true;
  } catch {
    return false;
  }
}
