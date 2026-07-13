const PUBLIC_CACHE_PATHS = new Set(["/", "/robots.txt", "/manifest.webmanifest"]);

function applySecurityHeaders(headers) {
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "SAMEORIGIN");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  return headers;
}

function isPublicCacheRequest(request, url) {
  const staticAsset = url.pathname.startsWith("/_next/static/");
  return (
    request.method === "GET" &&
    (staticAsset || (!request.headers.has("cookie") && PUBLIC_CACHE_PATHS.has(url.pathname)))
  );
}

async function proxyRequest(request, env, ctx) {
  if (!env.HIVE_ORIGIN) {
    return new Response("Hive edge origin is not configured.", { status: 503 });
  }

  const incomingUrl = new URL(request.url);
  const originUrl = new URL(env.HIVE_ORIGIN);
  if (originUrl.protocol !== "https:") {
    return new Response("Hive edge origin must use HTTPS.", { status: 503 });
  }

  const targetUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, originUrl);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("X-Forwarded-Host", incomingUrl.host);
  requestHeaders.set("X-Forwarded-Proto", "https");

  const originRequest = new Request(targetUrl, {
    method: request.method,
    headers: requestHeaders,
    body: request.body,
    redirect: "manual",
  });

  const cacheable = isPublicCacheRequest(request, incomingUrl);
  const cache = caches.default;
  if (cacheable) {
    const cached = await cache.match(request);
    if (cached) return cached;
  }

  const originResponse = await fetch(originRequest);
  if (originResponse.status === 101) return originResponse;

  const headers = applySecurityHeaders(new Headers(originResponse.headers));
  if (cacheable && originResponse.ok) {
    headers.set("Cache-Control", "public, max-age=0, s-maxage=300, stale-while-revalidate=86400");
  } else {
    headers.set("Cache-Control", "private, no-store");
  }

  const response = new Response(originResponse.body, {
    status: originResponse.status,
    statusText: originResponse.statusText,
    headers,
  });

  if (cacheable && originResponse.ok) {
    ctx.waitUntil(cache.put(request, response.clone()));
  }

  return response;
}

export { applySecurityHeaders, isPublicCacheRequest };

export default {
  fetch: proxyRequest,
};
