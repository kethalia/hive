import type { RouteHandler, Route } from "./auth/types.js";

export type { RouteHandler };

const routes: Route[] = [];

export function addRoute(
  method: string,
  pattern: string,
  handler: RouteHandler
): void {
  const segments = pattern.split("/").filter(Boolean);
  routes.push({ method: method.toUpperCase(), segments, handler });
}

export function matchRoute(
  method: string,
  pathname: string
): { handler: RouteHandler; params: Record<string, string> } | null {
  const reqSegments = pathname.split("/").filter(Boolean);
  const upperMethod = method.toUpperCase();

  for (const route of routes) {
    if (route.method !== upperMethod) continue;
    if (route.segments.length !== reqSegments.length) continue;

    const params: Record<string, string> = {};
    let matched = true;

    for (let i = 0; i < route.segments.length; i++) {
      const routeSeg = route.segments[i];
      const reqSeg = reqSegments[i];
      if (routeSeg.startsWith(":")) {
        params[routeSeg.slice(1)] = reqSeg;
      } else if (routeSeg !== reqSeg) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return { handler: route.handler, params };
    }
  }

  return null;
}

export function clearRoutes(): void {
  routes.length = 0;
}
