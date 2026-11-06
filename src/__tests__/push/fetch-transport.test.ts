import { createECDH, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { sendFetchPush } from "@/lib/push/fetch-transport";

function fixture() {
  const subscriber = createECDH("prime256v1");
  subscriber.generateKeys();
  return {
    subscription: {
      endpoint: "https://push.fixture.invalid/send/device",
      keys: {
        p256dh: subscriber.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    },
    options: {
      TTL: 3600,
      vapidDetails: { subject: "mailto:fixture@example.invalid", ...webpush.generateVAPIDKeys() },
    },
  };
}
describe("Fetch web push transport", () => {
  it("uses vendor encryption and signs per-call keys without following redirects", async () => {
    const { subscription, options } = fixture();
    const transport = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    await sendFetchPush(subscription, "private fixture message", options, transport);
    const [url, request] = transport.mock.calls[0];
    expect(url).toBe(subscription.endpoint);
    expect(request.method).toBe("POST");
    expect(request.redirect).toBe("manual");
    expect(request.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(request.headers);
    expect(headers.get("authorization")).toContain("vapid t=");
    expect(headers.get("authorization")).toContain(options.vapidDetails.publicKey);
    expect(headers.get("content-encoding")).toBe("aes128gcm");
    expect(Buffer.from(request.body).includes(Buffer.from("private fixture message"))).toBe(false);
  });
  it.each([
    302, 404, 410, 429, 503,
  ])("preserves status %s for bounded retry/stale-subscription handling without leaking provider content", async (status) => {
    const { subscription, options } = fixture();
    const response = new Response("private provider body", { status });
    const cancel = vi.spyOn(response.body!, "cancel");
    const transport = vi.fn().mockResolvedValue(response);
    await expect(sendFetchPush(subscription, "fixture", options, transport)).rejects.toMatchObject({
      statusCode: status,
      body: "",
      endpoint: "",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });
  it.each([
    "http://push.fixture.invalid/send",
    "https://name:secret@push.fixture.invalid/send",
    "https://push.fixture.invalid/send#fragment",
  ])("rejects unsafe endpoint %s before encryption or network", async (endpoint) => {
    const { subscription, options } = fixture();
    const transport = vi.fn();
    await expect(
      sendFetchPush({ ...subscription, endpoint }, "fixture", options, transport),
    ).rejects.toThrow("HTTPS subscription");
    expect(transport).not.toHaveBeenCalled();
  });
});
