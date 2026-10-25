"use client";

import { useEffect, useState } from "react";
import { TemplateDetailClient } from "@/components/templates/TemplateDetailClient";
import { TemplatesClient } from "@/components/templates/TemplatesClient";
import { Button } from "@/components/ui/button";
import { useDiscovery } from "@/lib/discovery/queries";

export function TemplatesWindow({ template }: { template?: string }) {
  const query = useDiscovery("templates");
  const [selected, setSelected] = useState(template ?? "");
  useEffect(() => setSelected(template ?? ""), [template]);
  if (!query.data && query.isPending)
    return (
      <p role="status" className="p-4">
        Loading templates…
      </p>
    );
  if (!query.data)
    return (
      <div className="space-y-3 p-4">
        <p role="alert">Could not load templates.</p>
        <Button onClick={() => void query.refresh().catch(() => {})}>Retry</Button>
      </div>
    );
  const status = query.data.find((s) => s.name === selected);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 pb-4">
      <label className="block shrink-0 space-y-2 p-4 text-sm">
        Template
        <select
          value={status?.name ?? ""}
          onChange={(e) => setSelected(e.target.value)}
          className="h-10 w-full rounded-md border bg-background px-3"
        >
          <option value="">All templates</option>
          {query.data.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      {status ? (
        <TemplateDetailClient key={status.name} status={status} />
      ) : (
        <TemplatesClient initialStatuses={query.data} embedded />
      )}
    </div>
  );
}
