const PUBLIC_CACHE_PATHS = new Set(["/", "/robots.txt", "/manifest.webmanifest"]);

function applySecurityHeaders(headers) {
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "SAMEORIGIN");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  return headers;
}

function scopeResponseCookiesToPublicHost(headers, publicCookieDomain) {
  const getSetCookie = headers.getSetCookie;
  const cookies =
    typeof getSetCookie === "function"
      ? getSetCookie.call(headers)
      : [headers.get("Set-Cookie")].filter(Boolean);
  if (cookies.length === 0) return headers;

  headers.delete("Set-Cookie");
  for (const cookie of cookies) {
    const domainAttribute = publicCookieDomain ? `; Domain=${publicCookieDomain}` : "";
    headers.append("Set-Cookie", cookie.replace(/;\s*Domain=[^;]*/gi, domainAttribute));
  }
  return headers;
}

function rewriteOriginRedirect(headers, originUrl, incomingUrl) {
  const location = headers.get("Location");
  if (!location) return headers;

  const redirectUrl = new URL(location, originUrl);
  if (redirectUrl.origin !== originUrl.origin) return headers;

  redirectUrl.protocol = incomingUrl.protocol;
  redirectUrl.host = incomingUrl.host;
  headers.set("Location", redirectUrl.toString());
  return headers;
}

function isPublicCacheRequest(request, url) {
  const staticAsset = url.pathname.startsWith("/_next/static/");
  return (
    request.method === "GET" &&
    (staticAsset || (!request.headers.has("cookie") && PUBLIC_CACHE_PATHS.has(url.pathname)))
  );
}

function buildOriginRequest(request, incomingUrl, originUrl) {
  const targetUrl = new URL(originUrl);
  targetUrl.pathname = incomingUrl.pathname;
  targetUrl.search = incomingUrl.search;
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete("Host");
  requestHeaders.delete("X-Forwarded-For");
  requestHeaders.delete("X-Real-IP");
  const clientIp = request.headers.get("CF-Connecting-IP");
  if (clientIp) {
    requestHeaders.set("X-Forwarded-For", clientIp);
    requestHeaders.set("X-Real-IP", clientIp);
  }
  requestHeaders.set("X-Forwarded-Host", incomingUrl.host);
  requestHeaders.set("X-Forwarded-Proto", "https");

  return new Request(targetUrl, {
    method: request.method,
    headers: requestHeaders,
    body: request.body,
    redirect: "manual",
  });
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

  const originRequest = buildOriginRequest(request, incomingUrl, originUrl);

  const cacheable = isPublicCacheRequest(request, incomingUrl);
  const cache = caches.default;
  if (cacheable) {
    const cached = await cache.match(request);
    if (cached) return cached;
  }

  let originResponse;
  try {
    originResponse = await fetch(originRequest);
  } catch {
    return new Response("Hive edge origin is unavailable.", { status: 502 });
  }
  if (originResponse.status === 101) return originResponse;

  const headers = rewriteOriginRedirect(
    scopeResponseCookiesToPublicHost(
      applySecurityHeaders(new Headers(originResponse.headers)),
      env.PUBLIC_COOKIE_DOMAIN,
    ),
    originUrl,
    incomingUrl,
  );
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

export {
  applySecurityHeaders,
  buildOriginRequest,
  isPublicCacheRequest,
  proxyRequest,
  rewriteOriginRedirect,
  scopeResponseCookiesToPublicHost,
};

export default {
  fetch: proxyRequest,
};
