import { getHivePublicOrigin } from "./hive-origin.mjs";

export function coderAuthCookieName() {
  return `${getHivePublicOrigin()?.startsWith("https://") ? "__Host-" : ""}hive-auth`;
}

export function coderAuthCookieValues(header: string | null | undefined) {
  const name = coderAuthCookieName();
  return (header ?? "").split(";").flatMap((part) => {
    const at = part.indexOf("=");
    return at >= 0 && part.slice(0, at).trim() === name ? [part.slice(at + 1).trim()] : [];
  });
}
