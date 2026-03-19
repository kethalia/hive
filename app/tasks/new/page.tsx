"use client";

import { useRef, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAction } from "next-safe-action/hooks";
import { createTaskAction } from "@/lib/actions/tasks";

interface Attachment {
  name: string;
  data: string;
  type: string;
}

/** Read a File as a base64-encoded string (without the data URL prefix). */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

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

    // Read selected files as base64 attachments
    let attachments: Attachment[] | undefined;
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

    execute({
      prompt,
      repoUrl,
      attachments,
    });
  }

  const serverError = result.serverError;
  const validationErrors = result.validationErrors;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold text-white">New Task</h1>

      {/* Server error banner */}
      {serverError && (
        <div
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-900/30 p-4 text-sm text-red-300"
        >
          <p className="font-medium">Submission failed</p>
          <p className="mt-1 text-red-400">{serverError}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5 rounded-xl border border-gray-800 bg-gray-900 p-6">
        {/* Prompt */}
        <div className="space-y-1.5">
          <label htmlFor="prompt" className="block text-sm font-medium text-gray-300">
            Prompt <span className="text-red-400">*</span>
          </label>
          <textarea
            id="prompt"
            name="prompt"
            required
            rows={4}
            placeholder="Describe what you want built..."
            className="block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors"
          />
          {validationErrors?.prompt && (
            <p className="text-xs text-red-400">{validationErrors.prompt._errors?.[0]}</p>
          )}
        </div>

        {/* Repo URL */}
        <div className="space-y-1.5">
          <label htmlFor="repoUrl" className="block text-sm font-medium text-gray-300">
            Repository URL <span className="text-red-400">*</span>
          </label>
          <input
            id="repoUrl"
            name="repoUrl"
            type="url"
            required
            placeholder="https://github.com/org/repo"
            className="block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors"
          />
          {validationErrors?.repoUrl && (
            <p className="text-xs text-red-400">{validationErrors.repoUrl._errors?.[0]}</p>
          )}
        </div>

        {/* File Attachments */}
        <div className="space-y-1.5">
          <label htmlFor="attachments" className="block text-sm font-medium text-gray-300">
            File Attachments <span className="text-gray-500">(optional)</span>
          </label>
          <input
            id="attachments"
            name="attachments"
            type="file"
            multiple
            ref={fileInputRef}
            className="block w-full text-sm text-gray-400 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-700 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-gray-200 hover:file:bg-gray-600 file:transition-colors file:cursor-pointer"
          />
          <p className="text-xs text-gray-500">Attach any reference files for the task.</p>
        </div>

        {/* Submit */}
        <div className="pt-2">
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-950 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isPending ? "Submitting…" : "Create Task"}
          </button>
        </div>
      </form>
    </div>
  );
}
