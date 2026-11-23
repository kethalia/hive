"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { isEmbeddedAppPreview, requestProduction } from "@/lib/app-preview-origin.mjs";

export function LoginHomeLink() {
  const [preview, setPreview] = useState(false);
  useEffect(() => setPreview(isEmbeddedAppPreview()), []);

  return (
    <Link
      href="/"
      onClick={(event) => {
        if (!isEmbeddedAppPreview()) return;
        event.preventDefault();
        requestProduction();
      }}
      className="inline-flex min-h-8 items-center text-sm text-muted-foreground underline-offset-4 hover:text-primary hover:underline"
    >
      {preview ? "Return to production" : "Return to hive.dev"}
    </Link>
  );
}
