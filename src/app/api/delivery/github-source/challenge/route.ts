import { githubSourceRoute } from "@/lib/delivery/github-source-route.server";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => githubSourceRoute(request, "challenge");
