"use client";

import { AlertCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useAction } from "next-safe-action/hooks";
import { type FormEvent, useRef, useState } from "react";
import { DashboardPageHeader } from "@/components/dashboard-page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createTaskAction } from "@/lib/actions/tasks";
import { readFileAsBase64 } from "@/lib/helpers/format";
import type { TaskAttachment } from "@/lib/types/tasks";

export default function NewTaskPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState("");

  const { execute, result, isPending } = useAction(createTaskAction, {
    onSuccess: ({ data }) => {
      if (data) {
        router.push(`/tasks/${data.id}`);
      }
    },
  });

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);

    const promptValue = formData.get("prompt");
    const repoUrl = formData.get("repoUrl");
    if (typeof promptValue !== "string" || typeof repoUrl !== "string") return;

    let attachments: TaskAttachment[] | undefined;
    const files = fileInputRef.current?.files;
    if (files && files.length > 0) {
      attachments = await Promise.all(
        Array.from(files).map(async (file) => ({
          name: file.name,
          data: await readFileAsBase64(file),
          type: file.type || "application/octet-stream",
        })),
      );
    }

    const councilSize = Number(formData.get("councilSize")) || 3;
    execute({ prompt: promptValue, repoUrl, attachments, councilSize });
  }

  const serverError = result.serverError;
  const validationErrors = result.validationErrors;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DashboardPageHeader title="New Task" />

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-2 pb-safe">
        {serverError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Submission failed</AlertTitle>
            <AlertDescription>{serverError}</AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Task Details</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit}>
              <FieldGroup>
                <Field data-invalid={!!validationErrors?.prompt}>
                  <FieldLabel htmlFor="prompt">
                    Prompt <span className="text-destructive">*</span>
                  </FieldLabel>
                  <Textarea
                    id="prompt"
                    name="prompt"
                    required
                    rows={4}
                    placeholder="Describe what you want built..."
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    aria-describedby="prompt-guidance"
                  />
                  <FieldDescription id="prompt-guidance" className="flex justify-between gap-4">
                    <span>Include the outcome, constraints, and proof you expect.</span>
                    <span className="shrink-0 tabular-nums">{prompt.length} chars</span>
                  </FieldDescription>
                  <FieldError>{validationErrors?.prompt?._errors?.[0]}</FieldError>
                </Field>

                <Field data-invalid={!!validationErrors?.repoUrl}>
                  <FieldLabel htmlFor="repoUrl">
                    Repository URL <span className="text-destructive">*</span>
                  </FieldLabel>
                  <Input
                    id="repoUrl"
                    name="repoUrl"
                    type="url"
                    required
                    placeholder="https://github.com/org/repo"
                  />
                  <FieldError>{validationErrors?.repoUrl?._errors?.[0]}</FieldError>
                </Field>

                <Field data-invalid={!!validationErrors?.councilSize}>
                  <FieldLabel htmlFor="councilSize">Council Size</FieldLabel>
                  <Input
                    id="councilSize"
                    name="councilSize"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={7}
                    step={1}
                    defaultValue={3}
                  />
                  <FieldDescription>Number of independent reviewers (1–7).</FieldDescription>
                  <FieldError>{validationErrors?.councilSize?._errors?.[0]}</FieldError>
                </Field>

                <Field>
                  <FieldLabel htmlFor="attachments">File Attachments</FieldLabel>
                  <Input
                    id="attachments"
                    name="attachments"
                    type="file"
                    multiple
                    ref={fileInputRef}
                  />
                  <FieldDescription>Attach any reference files for the task.</FieldDescription>
                </Field>

                <div className="pt-2">
                  <Button type="submit" disabled={isPending}>
                    {isPending ? "Submitting…" : "Create Task"}
                  </Button>
                </div>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
