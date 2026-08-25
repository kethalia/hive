"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandPalette, type CommandPaletteAction } from "@/components/terminal/CommandPalette";
import { useSidebar } from "@/components/ui/sidebar";
import { useIsMobile } from "@/hooks/use-mobile";
import { useGlobalCommandPaletteGesture } from "@/hooks/useGlobalCommandPaletteGesture";
import { useRegisterKeybinding } from "@/hooks/useKeybindings";
import { listWorkspacesAction } from "@/lib/actions/workspaces";
import { formatRelativeDate } from "@/lib/helpers/format";
import { formatShortcut } from "@/lib/keyboard-shortcuts";
import { TERMINAL_COMPOSE_TOGGLE_EVENT } from "@/lib/terminal/events";
import {
  getGlobalCommandPaletteSources,
  subscribeGlobalCommandPaletteSources,
} from "@/lib/terminal/global-command-palette";

const GLOBAL_COMMAND_PALETTE_KEYS = ["ctrl+k", "cmd+k"] as const;
const GLOBAL_SIDEBAR_KEYS = ["ctrl+b", "cmd+b"] as const;
const GLOBAL_COMPOSE_KEYS = ["ctrl+`", "cmd+`"] as const;
const GLOBAL_FULLSCREEN_KEYS = ["ctrl+enter", "cmd+enter"] as const;
const NAV_WORKSPACES_KEYS = ["ctrl+shift+1", "cmd+shift+1"] as const;
const NAV_TEMPLATES_KEYS = ["ctrl+shift+2", "cmd+shift+2"] as const;
const NAV_STATUS_KEYS = ["ctrl+shift+3", "cmd+shift+3"] as const;

type DashboardWorkspace = {
  id: string;
  name: string;
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
  const { openMobileRight, setOpen, setOpenMobile, setOpenMobileRight, toggleSidebar } =
    useSidebar();
  const isMobile = useIsMobile();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [workspaces, setWorkspaces] = useState<DashboardWorkspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [appFullscreen, setAppFullscreen] = useState(false);
  const [paletteSources, setPaletteSources] = useState(getGlobalCommandPaletteSources);
  const appFullscreenRef = useRef(appFullscreen);
  const previousIsMobileRef = useRef(isMobile);
  appFullscreenRef.current = appFullscreen;
  const activePaletteSource = paletteSources.at(-1) ?? null;

  const openGlobalCommandPalette = useCallback(() => {
    setPaletteQuery("");
    activePaletteSource?.onSearchValueChange?.("");
    if (isMobile) {
      setOpenMobileRight(true);
    } else {
      setPaletteOpen(true);
    }
  }, [activePaletteSource, isMobile, setOpenMobileRight]);

  const commandPaletteOpen = isMobile ? openMobileRight : paletteOpen;
  const setCommandPaletteOpen = useCallback(
    (nextOpen: boolean) => {
      if (isMobile) {
        setOpenMobileRight(nextOpen);
      } else {
        setPaletteOpen(nextOpen);
      }
    },
    [isMobile, setOpenMobileRight],
  );

  useEffect(() => {
    const wasMobile = previousIsMobileRef.current;
    if (wasMobile === isMobile) return;
    previousIsMobileRef.current = isMobile;

    if (isMobile && paletteOpen) {
      setPaletteOpen(false);
      setOpenMobileRight(true);
      return;
    }
    if (!isMobile && openMobileRight) {
      setOpenMobileRight(false);
      setPaletteOpen(true);
    }
  }, [isMobile, openMobileRight, paletteOpen, setOpenMobileRight]);

  useGlobalCommandPaletteGesture({
    enabled: isMobile && !openMobileRight,
    onOpen: openGlobalCommandPalette,
  });

  const toggleDashboardFullscreen = useCallback(() => {
    const nextFullscreen = !appFullscreenRef.current;
    setAppFullscreen(nextFullscreen);

    if (nextFullscreen) {
      setOpen(false);
      setOpenMobile(false);
      setOpenMobileRight(false);
      const root = document.documentElement;
      if (typeof root.requestFullscreen === "function" && !document.fullscreenElement) {
        root.requestFullscreen().catch(() => undefined);
      }
      return;
    }

    if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
      document.exitFullscreen().catch(() => undefined);
    }
  }, [setOpen, setOpenMobile, setOpenMobileRight]);

  useEffect(() => {
    const root = document.documentElement;
    if (appFullscreen) {
      root.dataset.dashboardFullscreen = "true";
    } else {
      delete root.dataset.dashboardFullscreen;
    }
    return () => {
      delete root.dataset.dashboardFullscreen;
    };
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
    if (!commandPaletteOpen) return;
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);

    listWorkspacesAction()
      .then((workspaceResult) => {
        if (cancelled) return;
        setWorkspaces(parseArray(actionData(workspaceResult), parseWorkspace));
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
  }, [commandPaletteOpen]);

  useEffect(
    () =>
      subscribeGlobalCommandPaletteSources(() => {
        setPaletteSources(getGlobalCommandPaletteSources());
      }),
    [],
  );

  useRegisterKeybinding({
    id: "dashboard:command-palette",
    keys: [...GLOBAL_COMMAND_PALETTE_KEYS],
    action: () => {
      openGlobalCommandPalette();
      return false;
    },
    description: "Open command palette",
    category: "general",
    enabledInBrowser: true,
    global: true,
    allowTextEntry: true,
  });

  useRegisterKeybinding({
    id: "dashboard:navigate-workspaces",
    keys: [...NAV_WORKSPACES_KEYS],
    action: () => {
      router.push("/workspaces");
      return false;
    },
    description: "Open workspaces",
    category: "navigation",
    enabledInBrowser: true,
    global: true,
    allowTextEntry: true,
  });

  useRegisterKeybinding({
    id: "dashboard:navigate-templates",
    keys: [...NAV_TEMPLATES_KEYS],
    action: () => {
      router.push("/templates");
      return false;
    },
    description: "Open templates",
    category: "navigation",
    enabledInBrowser: true,
    global: true,
    allowTextEntry: true,
  });

  useRegisterKeybinding({
    id: "dashboard:navigate-terminal-status",
    keys: [...NAV_STATUS_KEYS],
    action: () => {
      router.push("/terminal/status");
      return false;
    },
    description: "Open terminal status",
    category: "navigation",
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

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.dashboardKeybindingsReady = "true";
    return () => {
      delete root.dataset.dashboardKeybindingsReady;
    };
  }, []);

  const dashboardActions = useMemo<CommandPaletteAction[]>(() => {
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
        id: "dashboard:open-workspaces",
        label: "Workspaces",
        description: "Open Coder workspaces and terminal sessions",
        group: "Navigate",
        value: "workspaces coder terminals sessions",
        shortcut: formatShortcut(NAV_WORKSPACES_KEYS),
        icon: "terminal",
        onSelect: () => {
          router.push("/workspaces");
        },
      },
      ...workspaceActions,
      {
        id: "dashboard:launch-workspace",
        label: "Launch workspace",
        description: "Choose a use-case profile and create an interactive workspace",
        group: "Workspaces",
        value:
          "launch create workspace profile software browser interview game electronics infrastructure",
        icon: "plus",
        onSelect: () => {
          router.push("/workspaces?launch=1");
        },
      },
      {
        id: "dashboard:open-templates",
        label: "Templates",
        description: "Review and push Coder templates",
        group: "Navigate",
        value: "templates coder push",
        shortcut: formatShortcut(NAV_TEMPLATES_KEYS),
        icon: "search",
        onSelect: () => {
          router.push("/templates");
        },
      },
      {
        id: "dashboard:open-terminal-status",
        label: "Terminal status",
        description: "Inspect safe connection diagnostics",
        group: "Navigate",
        value: "terminal status diagnostics connections",
        shortcut: formatShortcut(NAV_STATUS_KEYS),
        icon: "search",
        onSelect: () => {
          router.push("/terminal/status");
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
    ];
  }, [appFullscreen, router, toggleDashboardFullscreen, workspaces]);

  const sourceActions = activePaletteSource?.actions ?? [];
  const actions = useMemo(
    () => [...sourceActions, ...dashboardActions],
    [dashboardActions, sourceActions],
  );

  const handleSearchValueChange = useCallback(
    (value: string) => {
      setPaletteQuery(value);
      activePaletteSource?.onSearchValueChange?.(value);
    },
    [activePaletteSource],
  );

  const emptyText = loading
    ? "Loading dashboard commands…"
    : loadFailed
      ? "Could not load dashboard commands."
      : (activePaletteSource?.emptyText ?? "No commands found.");

  return (
    <CommandPalette
      open={commandPaletteOpen}
      onOpenChange={setCommandPaletteOpen}
      tabs={activePaletteSource?.tabs ?? []}
      onSelectTab={activePaletteSource?.onSelectTab ?? (() => undefined)}
      onCreateSession={activePaletteSource?.onCreateSession}
      actions={actions}
      searchValue={activePaletteSource?.searchValue ?? paletteQuery}
      onSearchValueChange={handleSearchValueChange}
      searchPlaceholder={
        activePaletteSource?.searchPlaceholder ?? "Search commands and workspaces…"
      }
      emptyText={emptyText}
      groupHeading={activePaletteSource?.groupHeading ?? "Open"}
      mobileSide="right"
    />
  );
}
