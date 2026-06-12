"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandPalette, type CommandPaletteAction } from "@/components/terminal/CommandPalette";
import { useSidebar } from "@/components/ui/sidebar";
import { useRegisterKeybinding } from "@/hooks/useKeybindings";
import { listTasksAction } from "@/lib/actions/tasks";
import { listWorkspacesAction } from "@/lib/actions/workspaces";
import { formatRelativeDate, shortId } from "@/lib/helpers/format";
import { formatShortcut } from "@/lib/keyboard-shortcuts";
import { TERMINAL_COMPOSE_TOGGLE_EVENT } from "@/lib/terminal/events";
import { ACTIVE_STATUSES } from "@/lib/types/tasks";

const GLOBAL_COMMAND_PALETTE_KEYS = ["ctrl+k", "cmd+k"] as const;
const GLOBAL_SIDEBAR_KEYS = ["ctrl+b", "cmd+b"] as const;
const GLOBAL_COMPOSE_KEYS = ["ctrl+`", "cmd+`"] as const;
const GLOBAL_FULLSCREEN_KEYS = ["ctrl+enter", "cmd+enter"] as const;

type DashboardWorkspace = {
  id: string;
  name: string;
  status: string;
  updatedLabel: string;
};

type DashboardTask = {
  id: string;
  prompt: string;
  status: string;
  updatedLabel: string;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function actionData(value: unknown): unknown {
  return isObjectRecord(value) && "data" in value ? value.data : undefined;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseWorkspace(value: unknown): DashboardWorkspace | null {
  if (!isObjectRecord(value)) return null;
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const latestBuild = value.latest_build;
  if (!id || !name || !isObjectRecord(latestBuild)) return null;
  const status = stringValue(latestBuild.status) ?? "unknown";
  const lastUsedAt = stringValue(value.last_used_at);

  return {
    id,
    name,
    status,
    updatedLabel: lastUsedAt ? formatRelativeDate(lastUsedAt) : "never used",
  };
}

function parseTask(value: unknown): DashboardTask | null {
  if (!isObjectRecord(value)) return null;
  const id = stringValue(value.id);
  const prompt = stringValue(value.prompt);
  const status = stringValue(value.status);
  const updatedAt = stringValue(value.updatedAt);
  if (!id || !prompt || !status || !updatedAt) return null;

  return {
    id,
    prompt,
    status,
    updatedLabel: formatRelativeDate(updatedAt),
  };
}

function parseArray<T>(value: unknown, parse: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = parse(item);
    return parsed ? [parsed] : [];
  });
}

function openWorkspaceHref(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/terminal/workspace`;
}

export function DashboardKeyboardController() {
  const router = useRouter();
  const { setOpen, setOpenMobile, toggleSidebar } = useSidebar();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [workspaces, setWorkspaces] = useState<DashboardWorkspace[]>([]);
  const [tasks, setTasks] = useState<DashboardTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [appFullscreen, setAppFullscreen] = useState(false);
  const appFullscreenRef = useRef(appFullscreen);
  appFullscreenRef.current = appFullscreen;

  const toggleDashboardFullscreen = useCallback(() => {
    const nextFullscreen = !appFullscreenRef.current;
    setAppFullscreen(nextFullscreen);

    if (nextFullscreen) {
      setOpen(false);
      setOpenMobile(false);
      const root = document.documentElement;
      if (typeof root.requestFullscreen === "function" && !document.fullscreenElement) {
        root.requestFullscreen().catch(() => undefined);
      }
      return;
    }

    if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
      document.exitFullscreen().catch(() => undefined);
    }
  }, [setOpen, setOpenMobile]);

  useEffect(() => {
    const root = document.documentElement;
    if (appFullscreen) {
      root.dataset.dashboardFullscreen = "true";
    } else {
      delete root.dataset.dashboardFullscreen;
    }
  }, [appFullscreen]);

  useEffect(() => {
    const syncNativeFullscreen = () => {
      if (!document.fullscreenElement) {
        setAppFullscreen(false);
      }
    };
    document.addEventListener("fullscreenchange", syncNativeFullscreen);
    return () => {
      document.removeEventListener("fullscreenchange", syncNativeFullscreen);
    };
  }, []);

  useEffect(() => {
    if (!paletteOpen) return;
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);

    Promise.all([listWorkspacesAction(), listTasksAction()])
      .then(([workspaceResult, taskResult]) => {
        if (cancelled) return;
        setWorkspaces(parseArray(actionData(workspaceResult), parseWorkspace));
        setTasks(parseArray(actionData(taskResult), parseTask));
      })
      .catch(() => {
        if (!cancelled) {
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [paletteOpen]);

  useRegisterKeybinding({
    id: "dashboard:command-palette",
    keys: [...GLOBAL_COMMAND_PALETTE_KEYS],
    action: () => {
      setPaletteOpen(true);
      return false;
    },
    description: "Open command palette",
    category: "general",
    enabledInBrowser: true,
    global: true,
    allowTextEntry: true,
  });

  useRegisterKeybinding({
    id: "dashboard:toggle-sidebar",
    keys: [...GLOBAL_SIDEBAR_KEYS],
    action: () => {
      toggleSidebar();
      return false;
    },
    description: "Toggle sidebar",
    category: "general",
    enabledInBrowser: true,
    global: true,
    allowTextEntry: true,
  });

  useRegisterKeybinding({
    id: "dashboard:toggle-compose",
    keys: [...GLOBAL_COMPOSE_KEYS],
    action: () => {
      window.dispatchEvent(new CustomEvent(TERMINAL_COMPOSE_TOGGLE_EVENT));
      return false;
    },
    description: "Toggle terminal compose",
    category: "terminal",
    enabledInBrowser: true,
    global: true,
    allowTextEntry: true,
  });

  useRegisterKeybinding({
    id: "dashboard:toggle-fullscreen",
    keys: [...GLOBAL_FULLSCREEN_KEYS],
    action: () => {
      toggleDashboardFullscreen();
      return false;
    },
    description: "Toggle fullscreen",
    category: "general",
    enabledInBrowser: true,
    global: true,
    allowTextEntry: true,
  });

  const actions = useMemo<CommandPaletteAction[]>(() => {
    const activeTasks = tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
    const recentTasks = tasks.filter((task) => !ACTIVE_STATUSES.has(task.status)).slice(0, 6);
    const workspaceActions = workspaces.slice(0, 8).map<CommandPaletteAction>((workspace) => ({
      id: `dashboard:open-workspace:${workspace.id}`,
      label: workspace.name,
      description: `Open multi-session workspace • ${workspace.status} • ${workspace.updatedLabel}`,
      group: "Workspaces",
      value: `${workspace.name} ${workspace.status} workspace terminal multi session`,
      rightLabel: "Open",
      icon: "terminal",
      onSelect: () => {
        router.push(openWorkspaceHref(workspace.id));
      },
    }));

    return [
      {
        id: "dashboard:new-task",
        label: "New task",
        description: "Create a Hive task",
        group: "Actions",
        value: "new task create hive task",
        icon: "plus",
        onSelect: () => {
          router.push("/tasks/new");
        },
      },
      {
        id: "dashboard:tasks-progress",
        label: activeTasks.length > 0 ? `Check task progress (${activeTasks.length})` : "Tasks",
        description:
          activeTasks.length > 0
            ? "Review queued, running, and verifying tasks"
            : "Review recent task history",
        group: "Actions",
        value: "tasks progress status running queued verifying",
        rightLabel: "/tasks",
        icon: "search",
        onSelect: () => {
          router.push("/tasks");
        },
      },
      {
        id: "dashboard:toggle-fullscreen-action",
        label: appFullscreen ? "Exit fullscreen" : "Enter fullscreen",
        description: "Toggle the focused dashboard workspace",
        group: "Actions",
        value: "fullscreen focus dashboard terminal",
        shortcut: formatShortcut(GLOBAL_FULLSCREEN_KEYS),
        icon: "search",
        onSelect: toggleDashboardFullscreen,
      },
      ...workspaceActions,
      ...activeTasks.slice(0, 6).map<CommandPaletteAction>((task) => ({
        id: `dashboard:active-task:${task.id}`,
        label: `${shortId(task.id)} • ${task.status}`,
        description: task.prompt,
        group: "Active tasks",
        value: `${task.id} ${task.status} ${task.prompt}`,
        rightLabel: task.updatedLabel,
        icon: "search",
        onSelect: () => {
          router.push(`/tasks/${task.id}`);
        },
      })),
      ...recentTasks.map<CommandPaletteAction>((task) => ({
        id: `dashboard:recent-task:${task.id}`,
        label: `${shortId(task.id)} • ${task.status}`,
        description: task.prompt,
        group: "Recent tasks",
        value: `${task.id} ${task.status} ${task.prompt}`,
        rightLabel: task.updatedLabel,
        icon: "search",
        onSelect: () => {
          router.push(`/tasks/${task.id}`);
        },
      })),
    ];
  }, [appFullscreen, router, tasks, toggleDashboardFullscreen, workspaces]);

  const emptyText = loading
    ? "Loading dashboard commands…"
    : loadFailed
      ? "Could not load dashboard commands."
      : "No commands found.";

  return (
    <CommandPalette
      open={paletteOpen}
      onOpenChange={setPaletteOpen}
      tabs={[]}
      onSelectTab={() => undefined}
      actions={actions}
      searchValue={paletteQuery}
      onSearchValueChange={setPaletteQuery}
      searchPlaceholder="Search commands, workspaces, and tasks…"
      emptyText={emptyText}
      groupHeading="Open"
    />
  );
}
