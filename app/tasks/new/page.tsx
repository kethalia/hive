"use client";

import { useState, useRef, type FormEvent } from "react";
import { useRouter } from "next/navigation";

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
      // Strip the "data:...;base64," prefix
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

  const [prompt, setPrompt] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
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

      const body: Record<string, unknown> = { prompt, repoUrl };
      if (attachments && attachments.length > 0) {
        body.attachments = attachments;
      }

      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Request failed (${res.status})`);
      }

      const task = await res.json();
      router.push(`/tasks/${task.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold text-white">New Task</h1>

      {/* Error banner */}
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-900/30 p-4 text-sm text-red-300"
        >
          <p className="font-medium">Submission failed</p>
          <p className="mt-1 text-red-400">{error}</p>
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
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe what you want built..."
            className="block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors"
          />
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
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/org/repo"
            className="block w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 transition-colors"
          />
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
            disabled={submitting}
            className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-950 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? "Submitting…" : "Create Task"}
          </button>
        </div>
      </form>
    </div>
  );
}
