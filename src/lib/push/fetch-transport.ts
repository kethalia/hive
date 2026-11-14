import webpush, { type PushSubscription, type RequestOptions } from "web-push";

type FetchPushOptions = RequestOptions & {
  vapidDetails: NonNullable<RequestOptions["vapidDetails"]>;
};

/** Keep vendor encryption/VAPID signing, replace Node's HTTPS transport for Workers. */
export async function sendFetchPush(
  subscription: PushSubscription,
  payload: string,
  options: FetchPushOptions,
  transport: typeof fetch = fetch,
) {
  const endpoint = new URL(subscription.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash)
    throw new Error("Push requires an HTTPS subscription endpoint");
  const request = webpush.generateRequestDetails(subscription, payload, options);
  const response = await transport(request.endpoint, {
    method: request.method,
    headers: request.headers,
    body: request.body ? new Uint8Array(request.body) : null,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  // Neither response bodies nor provider URLs are needed for delivery decisions.
  // Cancel even rejected/redirected responses; never forward VAPID credentials.
  await response.body?.cancel();
  if (!response.ok)
    throw new webpush.WebPushError("Push provider rejected delivery", response.status, {}, "", "");
}
