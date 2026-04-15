"use client";

import { usePathname, useParams } from "next/navigation";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { TerminalBreadcrumbs } from "@/components/workspaces/TerminalBreadcrumbs";

const ROUTE_TITLES: [string, string][] = [
  ["/tasks/new", "New Task"],
  ["/tasks", "Tasks"],
  ["/templates", "Templates"],
  ["/workspaces", "Workspaces"],
];

export function HeaderContent() {
  const pathname = usePathname();
  const params = useParams();

  if (pathname.includes("/terminal") && params.id) {
    return <TerminalBreadcrumbs workspaceId={params.id as string} />;
  }

  const title =
    ROUTE_TITLES.find(([prefix]) => pathname.startsWith(prefix))?.[1] ??
    "Dashboard";

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbPage>{title}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
