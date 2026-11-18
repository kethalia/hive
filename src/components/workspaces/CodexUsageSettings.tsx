"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type CodexConfig,
  type CodexManagementRequest,
  type CodexUsage,
  codexManagementResponseSchema,
} from "@/lib/agents/codex-management-contracts";

type Section = "usage" | "config";
type Draft = { version: string; values: Partial<CodexConfig["values"]> };

export function CodexUsageSettings({
  section,
  workspaceId,
  buildId,
  lifetimeId,
  generation,
  disabled,
  onBusyChange,
  onAccountRefresh,
  onGeneration,
}: {
  section: Section;
  workspaceId: string;
  buildId: string;
  lifetimeId: string;
  generation: number;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onAccountRefresh: () => void;
  onGeneration?: (generation: number) => void;
}) {
  const [usage, setUsage] = useState<CodexUsage | null>(null);
  const [config, setConfig] = useState<CodexConfig | null>(null);
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsReadback, setNeedsReadback] = useState(false);
  const active = useRef<AbortController | null>(null);
  const fence = useRef(generation);
  const accountBusy = useRef(disabled);
  const refreshAccount = useRef(onAccountRefresh);
  const updateGeneration = useRef(onGeneration);
  useEffect(() => {
    updateGeneration.current = onGeneration;
  }, [onGeneration]);
  useEffect(() => {
    refreshAccount.current = onAccountRefresh;
  }, [onAccountRefresh]);
  useEffect(() => {
    accountBusy.current = disabled;
  }, [disabled]);
  useEffect(() => {
    fence.current = Math.max(fence.current, generation);
  }, [generation]);

  const execute = useCallback(
    async (request: CodexManagementRequest) => {
      if (active.current || accountBusy.current) return;
      const controller = new AbortController();
      active.current = controller;
      setBusy(true);
      onBusyChange(true);
      setError("");
      setNotice("");
      let unavailable = false;
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/codex-management`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
          body: JSON.stringify({ buildId, request }),
        });
        if (response.status === 404) {
          unavailable = true;
          throw Error();
        }
        if (!response.ok) throw Error();
        const result = codexManagementResponseSchema.parse(await response.json());
        if (controller.signal.aborted) return;
        if (result.lifetimeId !== lifetimeId || result.generation < request.generation)
          throw Error();
        if (
          (request.action === "usage" && !result.usage) ||
          (request.action === "config" && !result.config) ||
          (request.action === "save-config" && result.outcome === "saved" && !result.config)
        )
          throw Error();
        fence.current = Math.max(fence.current, result.generation);
        if (result.generation > request.generation) updateGeneration.current?.(result.generation);
        if (result.usage) setUsage(result.usage);
        if (result.config) setConfig(result.config);
        if (result.outcome === "unknown") {
          setNeedsReadback(true);
          setError("Settings outcome is unknown. Refresh runtime settings before saving again.");
        } else if (request.action === "save-config") {
          setDraft(undefined);
          setNeedsReadback(false);
          setNotice(
            result.overridden
              ? "Settings saved. Some effective values follow higher-priority configuration."
              : "Settings saved.",
          );
        } else if (request.action === "config") {
          setNeedsReadback(false);
        }
        return result;
      } catch {
        if (controller.signal.aborted) return;
        if (request.action === "save-config") {
          setNeedsReadback(true);
          setError("Settings outcome is unknown. Refresh runtime settings before saving again.");
        } else {
          setError(
            unavailable
              ? "Usage and settings are unavailable for this workspace. Check its runtime update and refresh."
              : "Codex details could not be refreshed. Try again.",
          );
          refreshAccount.current();
        }
      } finally {
        if (active.current === controller) {
          active.current = null;
          setBusy(false);
          onBusyChange(false);
        }
      }
    },
    [workspaceId, buildId, lifetimeId, onBusyChange],
  );
  const load = useCallback(
    () => execute({ action: section, lifetimeId, generation: fence.current }),
    [section, lifetimeId, execute],
  );
  useEffect(() => {
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      const controller = active.current;
      if (controller) {
        active.current = null;
        controller.abort();
        setBusy(false);
        onBusyChange(false);
      }
    };
  }, [load, onBusyChange]);

  async function save() {
    if (
      !draft ||
      !config ||
      draft.version !== config.version ||
      needsReadback ||
      disabled ||
      busy ||
      error
    )
      return;
    await execute({
      action: "save-config",
      lifetimeId,
      generation: fence.current,
      version: draft.version,
      values: draft.values,
    });
    onAccountRefresh();
  }

  const locked = busy || disabled;
  return (
    <div className="@container min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">{section === "usage" ? "Usage" : "Runtime settings"}</h2>
        <Button size="sm" variant="outline" disabled={locked} onClick={() => void load()}>
          {busy ? (
            <Loader2
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <RefreshCw className="size-4" aria-hidden="true" />
          )}
          Refresh {section === "usage" ? "usage" : "settings"}
        </Button>
      </div>
      {busy && !(section === "usage" ? usage : config) && (
        <p role="status" className="text-sm text-muted-foreground">
          {section === "usage" ? "Loading usage…" : "Updating runtime settings…"}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {section === "usage" && usage && <Usage data={usage} />}
      {section === "config" && config && (
        <RuntimeSettings
          config={config}
          draft={draft}
          disabled={locked}
          saveDisabled={
            locked || !!error || needsReadback || !draft || draft.version !== config.version
          }
          onDraft={setDraft}
          onSave={() => void save()}
        />
      )}
    </div>
  );
}

function Usage({ data }: { data: CodexUsage }) {
  return (
    <div className="min-w-0 space-y-4 pt-2">
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Lifetime tokens</dt>
          <dd>{data.tokens?.lifetime?.toLocaleString() ?? "Unavailable"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Peak daily tokens</dt>
          <dd>{data.tokens?.peakDaily?.toLocaleString() ?? "Unavailable"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Credits</dt>
          <dd className="break-all">
            {data.credits?.unlimited ? "Unlimited" : (data.credits?.balance ?? "Unavailable")}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Available usage resets</dt>
          <dd>{data.resetCredits?.toLocaleString() ?? "Unavailable"}</dd>
        </div>
      </dl>
      {!data.windows.length && (
        <p className="text-sm text-muted-foreground">
          Usage limits are unavailable from this runtime. Refresh to check again.
        </p>
      )}
      {data.windows.map((bucket) => (
        <section key={bucket.id} className="space-y-3">
          <h4 className="font-medium">{bucket.name}</h4>
          {(["primary", "secondary"] as const).map((kind) => {
            const window = bucket[kind];
            if (!window) return null;
            const remaining = Math.round((100 - window.usedPercent) * 10) / 10;
            const label =
              window.minutes == null
                ? `${kind === "primary" ? "Primary" : "Secondary"} window`
                : window.minutes >= 60
                  ? `${window.minutes / 60}-hour window`
                  : `${window.minutes}-minute window`;
            return (
              <div key={kind} className="space-y-1 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <span>{label}</span>
                  <span>{remaining}% left</span>
                </div>
                <progress
                  className="h-2 w-full accent-primary"
                  max={100}
                  value={remaining}
                  aria-label={`${bucket.name} ${kind} remaining allowance`}
                  aria-valuetext={`${remaining}% remaining`}
                />
                <p className="text-xs text-muted-foreground">
                  {window.resetsAt == null
                    ? "Reset time unavailable"
                    : `Resets ${new Date(window.resetsAt * 1000).toLocaleString()}`}
                </p>
              </div>
            );
          })}
        </section>
      ))}
      {data.tokens?.daily.length ? (
        <div className="max-h-56 overflow-auto">
          <table className="w-full text-left text-sm">
            <caption className="pb-2 text-left font-medium">Daily token activity</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col" className="text-right">
                  Tokens
                </th>
              </tr>
            </thead>
            <tbody>
              {data.tokens.daily.map((day) => (
                <tr key={day.date}>
                  <td>{day.date}</td>
                  <td className="text-right tabular-nums">{day.tokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Daily token activity is unavailable from this runtime.
        </p>
      )}
    </div>
  );
}

function RuntimeSettings({
  config,
  draft,
  disabled,
  saveDisabled,
  onDraft,
  onSave,
}: {
  config: CodexConfig;
  draft?: Draft;
  disabled: boolean;
  saveDisabled: boolean;
  onDraft: (draft: Draft | undefined) => void;
  onSave: () => void;
}) {
  const values = { ...config.values, ...draft?.values };
  const model = config.models.find((item) => item.id === values.model);
  const models = config.models.map((item) => ({ id: item.id, name: item.name }));
  function choice(
    key: keyof CodexConfig["values"],
    label: string,
    options: { id: string; name: string }[],
  ) {
    const current = values[key];
    const available =
      current && !options.some((option) => option.id === current)
        ? [{ id: current, name: current }, ...options]
        : options;
    const items = [
      { value: "__default", label: "Use default" },
      ...available.map((option) => ({ value: option.id, label: option.name })),
    ];
    return (
      <div className="min-w-0 space-y-1">
        <span className="text-sm">{label}</span>
        <Select
          value={current ?? "__default"}
          items={items}
          disabled={disabled}
          onValueChange={(value) => {
            if (value == null) return;
            onDraft({
              version: draft?.version ?? config.version,
              values: {
                ...draft?.values,
                ...(key === "model" ? { model_reasoning_effort: null, service_tier: null } : {}),
                [key]: value === "__default" ? null : value,
              },
            });
          }}
        >
          <SelectTrigger aria-label={label} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="break-all text-xs text-muted-foreground">
          Source {config.origins[key] ?? "default"}
        </p>
        {draft && draft.version !== config.version && key in draft.values && (
          <p className="text-xs text-muted-foreground">
            Current value {config.values[key] ?? "Default"}
          </p>
        )}
      </div>
    );
  }
  return (
    <form
      className="space-y-4 pt-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <p className="text-sm text-muted-foreground">
        Defaults apply to new Codex sessions. Project and managed settings follow native
        configuration precedence.
      </p>
      <div className="grid gap-3 @min-[28rem]:grid-cols-2">
        {choice("model", "Model", models)}
        {choice("review_model", "Review model", models)}
        {choice(
          "model_reasoning_effort",
          "Reasoning effort",
          (model?.efforts ?? ["low", "medium", "high"]).map((id) => ({ id, name: id })),
        )}
        {choice(
          "model_verbosity",
          "Response detail",
          ["low", "medium", "high"].map((id) => ({ id, name: id })),
        )}
        {choice(
          "web_search",
          "Web search",
          ["disabled", "cached", "live"].map((id) => ({ id, name: id })),
        )}
        {choice("service_tier", "Service tier", model?.tiers ?? [])}
      </div>
      {config.truncated && (
        <p className="text-sm text-muted-foreground">The runtime returned a partial model list.</p>
      )}
      {draft && draft.version !== config.version && (
        <div className="space-y-2 rounded-md border p-3 text-sm">
          <p>
            Configuration changed while you were editing. Review the current values before saving.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => onDraft({ ...draft, version: config.version })}
          >
            Keep edits on current version
          </Button>
        </div>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer">Execution policy details</summary>
        <dl className="grid gap-2 py-2">
          <div>
            <dt>Approval policy</dt>
            <dd>{config.approvalPolicy ?? "Default"}</dd>
          </div>
          <div>
            <dt>Sandbox</dt>
            <dd>{config.sandboxMode ?? "Default"}</dd>
          </div>
        </dl>
      </details>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={saveDisabled}>
          Save settings
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || !draft}
          onClick={() => onDraft(undefined)}
        >
          Discard edits
        </Button>
      </div>
    </form>
  );
}
