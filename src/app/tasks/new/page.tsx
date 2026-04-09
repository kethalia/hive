"use client";

import { useRef, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAction } from "next-safe-action/hooks";
import { createTaskAction } from "@/lib/actions/tasks";
import { readFileAsBase64 } from "@/lib/helpers/format";
import type { TaskAttachment } from "@/lib/types/tasks";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
} from "@/components/ui/field";
import { AlertCircle } from "lucide-react";

export default function NewTaskPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { execute, result, isPending } = useAction(createTaskAction, {
    onSuccess: ({ data }) => {
      if (data) {
        router.push(`/tasks/${data.id}`);
      }
    },
  });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const formData = new FormData(form);

    const prompt = formData.get("prompt") as string;
    const repoUrl = formData.get("repoUrl") as string;

    let attachments: TaskAttachment[] | undefined;
    const files = fileInputRef.current?.files;
    if (files && files.length > 0) {
      attachments = await Promise.all(
        Array.from(files).map(async (file) => ({
          name: file.name,
          data: await readFileAsBase64(file),
          type: file.type || "application/octet-stream",
        }))
      );
    }

    const councilSize = parseInt(formData.get("councilSize") as string, 10) || 3;
    execute({ prompt, repoUrl, attachments, councilSize });
  }

  const serverError = result.serverError;
  const validationErrors = result.validationErrors;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">New Task</h1>

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
                />
                <FieldError>
                  {validationErrors?.prompt?._errors?.[0]}
                </FieldError>
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
                <FieldError>
                  {validationErrors?.repoUrl?._errors?.[0]}
                </FieldError>
              </Field>

              <Field>
                <FieldLabel htmlFor="councilSize">Council Size</FieldLabel>
                <Input
                  id="councilSize"
                  name="councilSize"
                  type="number"
                  min={1}
                  max={7}
                  defaultValue={3}
                />
                <FieldDescription>
                  Number of independent reviewers (1–7).
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="attachments">
                  File Attachments
                </FieldLabel>
                <Input
                  id="attachments"
                  name="attachments"
                  type="file"
                  multiple
                  ref={fileInputRef}
                />
                <FieldDescription>
                  Attach any reference files for the task.
                </FieldDescription>
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
  );
}
