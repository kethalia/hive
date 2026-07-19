import { CODER_FRAME_HOSTS_META } from "@/lib/security/content-security-policy";

export function readDocumentCoderFrameHosts(): string[] {
  if (typeof document === "undefined") return [];
  const content = document
    .querySelector<HTMLMetaElement>(`meta[name="${CODER_FRAME_HOSTS_META}"]`)
    ?.getAttribute("content");
  return content?.split("~").filter(Boolean) ?? [];
}
