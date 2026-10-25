"use client";

import { useEffect, useState } from "react";
import { TemplateDetailClient } from "@/components/templates/TemplateDetailClient";
import { TemplatesClient } from "@/components/templates/TemplatesClient";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  const options = [
    { value: "", label: "All templates" },
    ...query.data.map((s) => ({ value: s.name, label: s.name })),
  ];
  const selector = (
    <Select
      value={status?.name ?? ""}
      onValueChange={(value) => setSelected(value ?? "")}
      items={options}
    >
      <SelectTrigger aria-label="Template" className="min-h-11 w-48 max-w-full shrink-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col pb-4">
      {status ? (
        <TemplateDetailClient key={status.name} status={status} headerControls={selector} />
      ) : (
        <TemplatesClient initialStatuses={query.data} embedded headerControls={selector} />
      )}
    </div>
  );
}
