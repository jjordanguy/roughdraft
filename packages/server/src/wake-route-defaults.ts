import type { WakeRoute } from "./wake-routes.js";

/**
 * Routes Roughdraft ships with. `claude-code` delivers the Done straight into
 * the Claude Code session that opened the file, so nothing has to be set up
 * on a machine that runs Claude Code. `route add` replaces a built-in route
 * and `route remove` brings it back.
 */
const BUILT_IN: Record<
  string,
  Pick<WakeRoute, "harness" | "kind" | "label">
> = {
  "claude-code": {
    harness: "claude-code",
    kind: "claude-session",
    label: "built in: the Claude Code session that opened the file",
  },
};

export function builtInRoute(harness: string): WakeRoute | null {
  const route = BUILT_IN[harness];
  return route
    ? { ...route, verifiedAt: null, verifiedBy: null, lastError: null }
    : null;
}

/** `routes` plus every built-in route not replaced by one of them, sorted. */
export function withBuiltInRoutes(routes: WakeRoute[]): WakeRoute[] {
  const all = [...routes];
  const seen = new Set(routes.map((route) => route.harness));
  for (const harness of Object.keys(BUILT_IN)) {
    if (seen.has(harness)) continue;
    const route = builtInRoute(harness);
    if (route) all.push(route);
  }
  return all.sort((a, b) => a.harness.localeCompare(b.harness));
}
