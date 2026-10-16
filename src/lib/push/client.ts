import { getVapidPublicKeyAction } from "./actions";
import { subscribePushAction } from "./subscribe";
export const DEVICE_DISABLED_KEY = "hive-push-disabled-v1";
export const PUSH_DEVICE_CHANGE_EVENT = "hive:push-device-change";

export function notifyPushDeviceChange(subscription: PushSubscription | null) {
  window.dispatchEvent(new CustomEvent(PUSH_DEVICE_CHANGE_EVENT, { detail: subscription }));
}
let subscribing: Promise<PushSubscription> | null = null;

export async function savePushSubscription(subscription: PushSubscription) {
  const json = subscription.toJSON();
  const saved = await subscribePushAction({
    endpoint: subscription.endpoint,
    p256dh: json.keys?.p256dh ?? "",
    auth: json.keys?.auth ?? "",
  });
  if (!saved?.data?.success) throw new Error("Could not save this device's push subscription");
}
export function subscribeToNotifications(): Promise<PushSubscription> {
  subscribing ??= subscribeDevice().finally(() => {
    subscribing = null;
  });
  return subscribing;
}
async function subscribeDevice(): Promise<PushSubscription> {
  const result = await getVapidPublicKeyAction();
  if (!result?.data?.publicKey) throw new Error("Could not get push configuration");
  const key = result.data.publicKey;
  const raw = atob(
    key.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (key.length % 4)) % 4),
  );
  const applicationServerKey = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) applicationServerKey[i] = raw.charCodeAt(i);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const registration = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Notification setup timed out. Reload Hive and retry.")),
        10_000,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }));
  await savePushSubscription(subscription);
  localStorage.removeItem(DEVICE_DISABLED_KEY);
  notifyPushDeviceChange(subscription);
  return subscription;
}
