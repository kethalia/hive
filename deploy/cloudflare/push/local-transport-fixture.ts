// Local validation only; never referenced by a deployment configuration.
import { createECDH, randomBytes } from "node:crypto";
import webpush from "web-push";
import { sendFetchPush } from "../../../src/lib/push/fetch-transport";

export default {
  async fetch(): Promise<Response> {
    const subscriber = createECDH("prime256v1");
    subscriber.generateKeys();
    const subscription = {
      endpoint: "https://push.fixture.invalid/send/device",
      keys: {
        p256dh: subscriber.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    };
    const options = {
      TTL: 3600,
      vapidDetails: { subject: "mailto:fixture@example.invalid", ...webpush.generateVAPIDKeys() },
    };
    let encrypted = false;
    let vapid = false;
    let manualRedirects = false;
    await sendFetchPush(subscription, "private fixture message", options, async (_input, init) => {
      const headers = new Headers(init?.headers);
      encrypted =
        headers.get("content-encoding") === "aes128gcm" &&
        !Buffer.from(init?.body as Uint8Array).includes(Buffer.from("private fixture message"));
      vapid = headers.get("authorization")?.includes(options.vapidDetails.publicKey) ?? false;
      manualRedirects = init?.redirect === "manual";
      return new Response(null, { status: 201 });
    });
    const statuses: number[] = [];
    for (const status of [302, 404, 410, 429, 503]) {
      try {
        await sendFetchPush(
          subscription,
          "fixture",
          options,
          async () => new Response("private provider body", { status }),
        );
      } catch (error) {
        if (
          error instanceof webpush.WebPushError &&
          error.statusCode === status &&
          error.body === "" &&
          error.endpoint === ""
        )
          statuses.push(status);
      }
    }
    return Response.json(
      { encrypted, vapid, manualRedirects, statuses, externalRequests: 0 },
      { status: encrypted && vapid && manualRedirects && statuses.length === 5 ? 200 : 500 },
    );
  },
};
