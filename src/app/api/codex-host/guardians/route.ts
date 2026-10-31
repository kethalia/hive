import { guardianPost } from "@/lib/codex-session/guardian-route.server";
export const dynamic = "force-dynamic";
export function POST(request: Request) {
  return guardianPost(request);
}
