import { installedDatabaseJobRoute } from "@/lib/delivery/database-job-route.server";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => installedDatabaseJobRoute(request, "job");
