import { currentClaudeSessionId } from "./claude-session.js";
import { currentCodexSessionId } from "./codex-session.js";
import type { WakeRoute } from "./wake-routes.js";

/**
 * Routes Roughdraft ships with. `claude-code` delivers the Done straight into
 * the Claude Code session that opened the file, and `codex` queues it for the
 * Codex session that opened the file, so nothing has to be set up on a
 * machine that runs either. `route add` replaces a built-in route and
 * `route remove` brings it back.
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
  codex: {
    harness: "codex",
    kind: "codex-queue",
    label: "built in: the Codex session that opened the file",
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

/**
 * The harness session this process runs under, for `open` and for
 * registering a session: Claude Code wins when both are present.
 */
export function currentHarnessSession(
  env: NodeJS.ProcessEnv,
): { harness: "claude-code" | "codex"; sessionId: string } | null {
  const claude = currentClaudeSessionId(env);
  if (claude) return { harness: "claude-code", sessionId: claude };
  const codex = currentCodexSessionId(env);
  if (codex) return { harness: "codex", sessionId: codex };
  return null;
}

/**
 * The session a `route test` delivers into when none is named: the Codex
 * session for a codex-queue route, the Claude Code session for a
 * claude-session route, and for other kinds whichever this process runs
 * under (it fills {sessionId}).
 */
export function currentSessionIdForRoute(
  kind: WakeRoute["kind"] | null,
  env: NodeJS.ProcessEnv,
): string | null {
  if (kind === "codex-queue") return currentCodexSessionId(env);
  if (kind === "claude-session") return currentClaudeSessionId(env);
  return currentHarnessSession(env)?.sessionId ?? null;
}

/** A route as lists show it: header values (which can hold a token) replaced with "<set>". */
export function redactRoute(route: WakeRoute): WakeRoute {
  if (!route.headers) return route;
  return {
    ...route,
    headers: Object.fromEntries(
      Object.keys(route.headers).map((name) => [name, "<set>"]),
    ),
  };
}
