"use client";

import { Bell, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { DashboardPageHeader } from "@/components/dashboard-page-header";
import { DashboardPageShell } from "@/components/dashboard-page-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { testPushAction } from "@/lib/push/actions";
import {
  DEVICE_DISABLED_KEY,
  notifyPushDeviceChange,
  PUSH_DEVICE_CHANGE_EVENT,
  subscribeToNotifications,
} from "@/lib/push/client";
import { playNotificationSound, SOUND_KEY, unlockNotificationAudio } from "@/lib/push/sound";
import {
  getPushPreferencesAction,
  unsubscribePushAction,
  updatePushPreferencesAction,
} from "@/lib/push/subscribe";
import {
  type NotificationKind,
  type NotificationPreferences,
  notificationLabels,
  notificationPreferencesSchema,
} from "@/lib/push/types";

type FeedbackScope = "device" | "events" | "sound" | "workspace";

function NotificationFeedback({ message, error }: { message: string; error: string }) {
  return (
    <>
      {message && (
        <p role="status" className="text-sm text-primary break-words">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive break-words">
          {error}
        </p>
      )}
    </>
  );
}

interface Props {
  connectedWorkspaceIds: string[];
  workspaces: { id: string; name: string; running: boolean }[];
  workspaceError: boolean;
  pendingWorkspaceIds?: string[];
}

export function NotificationSettings({
  connectedWorkspaceIds,
  workspaces,
  workspaceError,
  pendingWorkspaceIds = [],
}: Props) {
  const [status, setStatus] = useState("Checking this device…");
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [preferences, setPreferences] = useState<NotificationPreferences>(() =>
    notificationPreferencesSchema.parse({}),
  );
  const [sound, setSound] = useState(true);
  const [supported, setSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [feedbackScope, setFeedbackScope] = useState<FeedbackScope>("device");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(connectedWorkspaceIds);
  const [pending, setPending] = useState(pendingWorkspaceIds);

  useEffect(() => {
    setSound(localStorage.getItem(SOUND_KEY) !== "false");
    const available =
      window.isSecureContext &&
      "Notification" in window &&
      "serviceWorker" in navigator &&
      "PushManager" in window;
    setSupported(available);
    if (!available) {
      setStatus(
        "Push is unavailable in this browser. On iPhone or iPad, add Hive to your Home Screen and open it there.",
      );
      return;
    }
    let active = true;
    let revision = 0;
    const synchronize = (event: Event) => {
      const sub = (event as CustomEvent<PushSubscription | null>).detail;
      const current = ++revision;
      setError("");
      if (!sub) {
        setSubscription(null);
        setStatus("Notifications are off on this device.");
        return;
      }
      void getPushPreferencesAction({ endpoint: sub.endpoint })
        .then((result) => {
          if (!active || current !== revision) return;
          if (!result?.data) throw new Error("Could not load device preferences");
          setSubscription(sub);
          setPreferences(result.data);
          setStatus("Push connected on this device.");
        })
        .catch(() => {
          if (active && current === revision)
            setError("Could not load device preferences. Retry setup.");
        });
    };
    window.addEventListener(PUSH_DEVICE_CHANGE_EVENT, synchronize);
    setStatus(
      Notification.permission === "denied"
        ? "Blocked — allow Hive in your browser or system notification settings, then retry."
        : "Notifications are off on this device.",
    );
    if (
      Notification.permission === "granted" &&
      localStorage.getItem(DEVICE_DISABLED_KEY) !== "true"
    ) {
      subscribeToNotifications().catch(() => {
        if (active)
          setStatus(
            "Permission is allowed, but push setup needs repair. Enable notifications to retry.",
          );
      });
    }
    return () => {
      active = false;
      window.removeEventListener(PUSH_DEVICE_CHANGE_EVENT, synchronize);
    };
  }, []);

  async function run(task: () => Promise<void>, scope: FeedbackScope = "device") {
    setFeedbackScope(scope);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await task();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Notification setup failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-y-auto">
      <DashboardPageShell className="min-w-0">
        <DashboardPageHeader title="Notifications" description="Keep your agents within earshot" />
        <div className="mx-auto grid w-full min-w-0 max-w-6xl gap-4 pb-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Bell className="size-4" /> This device
                </CardTitle>
                <CardDescription>
                  Enable push separately on each phone, tablet, or desktop. Alerts arrive even when
                  Hive is closed.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p role="status" className="text-sm text-muted-foreground">
                  {status}
                </p>
                <div className="flex flex-wrap gap-2 [&>button]:max-w-full [&>button]:whitespace-normal [&>button]:h-auto [&>button]:min-h-10 [&>button]:py-2">
                  <Button
                    disabled={!supported || busy}
                    onClick={() => {
                      // Request permission directly in the click gesture (required by iOS).
                      const permission = Notification.requestPermission();
                      void unlockNotificationAudio().catch(() => {});
                      void run(async () => {
                        if ((await permission) !== "granted")
                          throw new Error("Allow notifications in browser settings, then retry.");
                        await subscribeToNotifications();
                      });
                    }}
                  >
                    {subscription ? "Reconnect" : "Enable notifications"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!subscription || busy}
                    onClick={() =>
                      void run(async () => {
                        if (!subscription) return;
                        const result = await testPushAction({ endpoint: subscription.endpoint });
                        if (!result?.data?.sent)
                          throw new Error(
                            result?.serverError ||
                              result?.data?.error ||
                              "The test could not be delivered. Try again shortly.",
                          );
                        setMessage(
                          "Test sent. Check your notification center, including when Hive is in the background.",
                        );
                      })
                    }
                  >
                    Send test push
                  </Button>
                  {subscription && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const result = await unsubscribePushAction({
                            endpoint: subscription.endpoint,
                          });
                          if (!result?.data?.success)
                            throw new Error("Could not disable this device");
                          localStorage.setItem(DEVICE_DISABLED_KEY, "true");
                          notifyPushDeviceChange(null);
                          if (!(await subscription.unsubscribe()))
                            throw new Error(
                              "Could not remove browser subscription. Retry disabling notifications.",
                            );
                          setSubscription(null);
                          setStatus("Notifications are off on this device.");
                        })
                      }
                    >
                      Disable this device
                    </Button>
                  )}
                </div>
                {feedbackScope === "device" && (
                  <NotificationFeedback message={message} error={error} />
                )}
                <p className="text-xs text-muted-foreground">
                  On iOS/iPadOS 16.4 or later: Share → Add to Home Screen, open Hive from its icon,
                  then enable notifications. Focus modes and system settings control background
                  alerts.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Events</CardTitle>
                <CardDescription>
                  Choose which alerts reach this device. Questions and approvals need your
                  attention; ready means the agent has finished a turn.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {(Object.keys(notificationLabels) as NotificationKind[]).map((kind) => (
                  <div key={kind} className="flex min-h-11 items-center justify-between gap-3">
                    <label htmlFor={`notify-${kind}`} className="text-sm">
                      {notificationLabels[kind]}
                    </label>
                    <Switch
                      id={`notify-${kind}`}
                      aria-label={notificationLabels[kind]}
                      checked={preferences[kind]}
                      disabled={!subscription || busy}
                      onCheckedChange={(checked) =>
                        void run(async () => {
                          if (!subscription) return;
                          const next = { ...preferences, [kind]: checked };
                          const result = await updatePushPreferencesAction({
                            endpoint: subscription.endpoint,
                            preferences: next,
                          });
                          if (!result?.data?.success)
                            throw new Error("Could not save event preferences");
                          setPreferences(next);
                        }, "events")
                      }
                    />
                  </div>
                ))}
                {feedbackScope === "events" && (
                  <NotificationFeedback message={message} error={error} />
                )}
              </CardContent>
            </Card>
          </div>
          <div className="min-w-0 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Volume2 className="size-4" /> CRT sounds
                </CardTitle>
                <CardDescription>
                  Distinct chirps for questions, ready reports, and warnings while Hive is open.
                  Background push uses the system notification sound.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex min-h-11 items-center justify-between gap-3">
                  <label htmlFor="notification-sound">Play sounds on this device</label>
                  <Switch
                    id="notification-sound"
                    aria-label="Play sounds on this device"
                    checked={sound}
                    onCheckedChange={(checked) => {
                      setSound(checked);
                      localStorage.setItem(SOUND_KEY, String(checked));
                      if (checked) void unlockNotificationAudio().catch(() => {});
                    }}
                  />
                </div>
                <div className="flex flex-wrap gap-2 [&>button]:max-w-full [&>button]:whitespace-normal [&>button]:h-auto [&>button]:min-h-10 [&>button]:py-2">
                  {(["question", "ready", "failure"] as const).map((kind) => (
                    <Button
                      key={kind}
                      variant="outline"
                      disabled={!sound}
                      onClick={() =>
                        void run(async () => {
                          await playNotificationSound(kind);
                        }, "sound")
                      }
                    >
                      Preview {kind === "failure" ? "warning" : kind}
                    </Button>
                  ))}
                </div>
                {feedbackScope === "sound" && (
                  <NotificationFeedback message={message} error={error} />
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Agent workspaces</CardTitle>
                <CardDescription>
                  Connect each workspace once for Codex and Claude Code. This installs notification
                  hooks for your agents. Only event type, agent, project name, and session name are
                  sent to Hive.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  After setup finishes, restart Claude Code and Codex. In Codex, open{" "}
                  <code>/hooks</code> and trust the Hive hooks once. New sessions keep that trust
                  unless the hooks change.
                </p>
                {feedbackScope === "workspace" && (
                  <NotificationFeedback message={message} error={error} />
                )}
                {workspaceError && (
                  <p role="alert">Could not load workspaces. Check your Coder access and reload.</p>
                )}
                {!workspaceError && !workspaces.length && <p>No workspaces yet.</p>}
                {workspaces.map((workspace) => (
                  <div
                    key={workspace.id}
                    className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded border p-3"
                  >
                    <div className="min-w-0 flex-1 basis-40">
                      <p className="break-words text-sm font-medium">{workspace.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {connected.includes(workspace.id)
                          ? pending.includes(workspace.id)
                            ? "Setup incomplete — retry installation"
                            : "Hooks installed"
                          : workspace.running
                            ? "Ready to connect"
                            : "Start workspace to connect"}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button
                        variant="outline"
                        disabled={busy || !workspace.running}
                        onClick={() =>
                          void run(async () => {
                            const response = await fetch("/api/notifications/sources", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ workspaceId: workspace.id }),
                            });
                            const result = await response.json();
                            if (!response.ok)
                              throw new Error(result.error || "Could not connect workspace");
                            setConnected((previous) => [...new Set([...previous, workspace.id])]);
                            setPending((previous) => previous.filter((id) => id !== workspace.id));
                            setMessage(
                              "Hooks installed. Restart agents, then trust the Hive hooks in Codex /hooks once.",
                            );
                          }, "workspace")
                        }
                      >
                        {pending.includes(workspace.id)
                          ? "Retry setup"
                          : connected.includes(workspace.id)
                            ? "Reinstall hooks"
                            : "Connect"}
                      </Button>
                      {connected.includes(workspace.id) && (
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              const response = await fetch("/api/notifications/sources", {
                                method: "DELETE",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ workspaceId: workspace.id }),
                              });
                              if (!response.ok) throw new Error("Could not disconnect workspace");
                              setConnected((previous) =>
                                previous.filter((id) => id !== workspace.id),
                              );
                              setPending((previous) =>
                                previous.filter((id) => id !== workspace.id),
                              );
                              setMessage(
                                "Workspace disconnected. Its callback credential has been revoked.",
                              );
                            }, "workspace")
                          }
                        >
                          Disconnect
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>
      </DashboardPageShell>
    </div>
  );
}
