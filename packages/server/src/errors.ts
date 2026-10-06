/**
 * The agent-facing error contract shared by the CLI and the MCP server.
 *
 * Exit codes: 0 success, 1 internal bug (and a failed `doctor <file>`, and a
 * review write that was refused with nothing written), 2 the command or path
 * was wrong, 3 the server could not be started, reached or kept, 4 the
 * caller's `--timeout` elapsed (or the tab stayed dirty past `apply --wait`),
 * 130 and 143 SIGINT and SIGTERM.
 */

export const EXIT_INTERNAL = 1;
export const EXIT_USAGE = 2;
export const EXIT_SERVER = 3;
export const EXIT_TIMEOUT = 4;
export const EXIT_SIGINT = 130;
export const EXIT_SIGTERM = 143;

export type CliErrorCode =
  | "USAGE"
  | "PATH_NOT_FOUND"
  | "NOT_MARKDOWN"
  | "PATH_UNREADABLE"
  | "SERVER_START_FAILED"
  | "SERVER_UNREACHABLE"
  | "SERVER_LOST"
  | "SERVER_VERSION_MISMATCH"
  | "SERVER_NOT_MANAGED"
  | "SERVER_STOP_FAILED"
  | "HTTP_ERROR"
  | "WATCH_TIMEOUT"
  | "INTERRUPTED"
  | "HANDOFF_NOT_FOUND"
  | "WAKE_ROUTE_NOT_FOUND"
  | "WAKE_ROUTE_FAILED"
  | "REVIEW_REFUSED"
  | "LEGACY_FORMAT"
  | "NORMALIZE_REFUSED"
  | "VERSION_CONFLICT"
  | "TAB_DIRTY"
  | "ROUND_NOT_FOUND"
  | "INTERNAL";

const EXIT_BY_CODE: Record<CliErrorCode, number> = {
  USAGE: EXIT_USAGE,
  PATH_NOT_FOUND: EXIT_USAGE,
  NOT_MARKDOWN: EXIT_USAGE,
  PATH_UNREADABLE: EXIT_USAGE,
  SERVER_START_FAILED: EXIT_SERVER,
  SERVER_UNREACHABLE: EXIT_SERVER,
  SERVER_LOST: EXIT_SERVER,
  SERVER_VERSION_MISMATCH: EXIT_SERVER,
  SERVER_NOT_MANAGED: EXIT_SERVER,
  SERVER_STOP_FAILED: EXIT_SERVER,
  HTTP_ERROR: EXIT_SERVER,
  WATCH_TIMEOUT: EXIT_TIMEOUT,
  INTERRUPTED: EXIT_SIGINT,
  HANDOFF_NOT_FOUND: EXIT_USAGE,
  WAKE_ROUTE_NOT_FOUND: EXIT_USAGE,
  WAKE_ROUTE_FAILED: EXIT_SERVER,
  // Review writes: 1 means refused, nothing written (like a failed doctor).
  REVIEW_REFUSED: EXIT_INTERNAL,
  LEGACY_FORMAT: EXIT_INTERNAL,
  NORMALIZE_REFUSED: EXIT_INTERNAL,
  VERSION_CONFLICT: EXIT_INTERNAL,
  TAB_DIRTY: EXIT_TIMEOUT,
  ROUND_NOT_FOUND: EXIT_USAGE,
  INTERNAL: EXIT_INTERNAL,
};

const RETRYABLE: ReadonlySet<CliErrorCode> = new Set<CliErrorCode>([
  "SERVER_START_FAILED",
  "SERVER_UNREACHABLE",
  "SERVER_LOST",
  "WATCH_TIMEOUT",
  "INTERRUPTED",
  "WAKE_ROUTE_FAILED",
  "VERSION_CONFLICT",
  "TAB_DIRTY",
]);

export interface CliErrorOptions {
  exitCode?: number;
  hint?: string | null;
  cause?: unknown;
  /** Extra keys merged into the JSON envelope (for example `events`). */
  details?: Record<string, unknown>;
}

export class CliError extends Error {
  code: CliErrorCode;
  exitCode: number;
  hint: string | null;
  retryable: boolean;
  details: Record<string, unknown>;

  constructor(
    code: CliErrorCode,
    message: string,
    options: CliErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "CliError";
    this.code = code;
    this.exitCode = options.exitCode ?? EXIT_BY_CODE[code] ?? EXIT_INTERNAL;
    this.hint = options.hint ?? null;
    this.retryable = RETRYABLE.has(code);
    this.details = options.details ?? {};
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError("USAGE", message, hint ? { hint } : {});
}

export function interruptedError(
  signal: "SIGINT" | "SIGTERM",
  hint?: string,
): CliError {
  return new CliError("INTERRUPTED", `Stopped by ${signal}.`, {
    exitCode: signal === "SIGTERM" ? EXIT_SIGTERM : EXIT_SIGINT,
    hint,
    details: { signal },
  });
}

/** Any thrown value becomes a CliError; unknown errors become `INTERNAL`. */
export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message =
    error instanceof Error && error.message
      ? error.message
      : typeof error === "string" && error
        ? error
        : "Unexpected error.";
  return new CliError("INTERNAL", message, {
    cause: error,
    hint: "This is a Roughdraft bug. Run again with ROUGHDRAFT_DEBUG=1 for a stack trace.",
  });
}

/** A short, JSON-safe description of an underlying error (its code first). */
export function describeCause(
  cause: unknown,
): { code?: string; message?: string } | undefined {
  if (cause === undefined || cause === null) return undefined;
  const seen = new Set<unknown>();
  let current: unknown = cause;
  let code: string | undefined;
  let message: string | undefined;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; message?: unknown };
    if (!code && typeof candidate.code === "string") code = candidate.code;
    if (!message && typeof candidate.message === "string") {
      message = candidate.message;
    }
    current = (current as { cause?: unknown }).cause;
  }
  if (!code && !message) return undefined;
  return {
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
  };
}

export type EnvelopeStatus =
  | "completed"
  | "ok"
  | "timeout"
  | "error"
  | "interrupted";

export function statusForError(error: CliError): EnvelopeStatus {
  if (error.code === "WATCH_TIMEOUT") return "timeout";
  if (error.code === "INTERRUPTED") return "interrupted";
  return "error";
}

/** The one JSON object a failed command prints with `--json`. */
export function errorEnvelope(
  error: CliError,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const described = describeCause(
    (error as Error & { cause?: unknown }).cause ?? undefined,
  );
  const cause =
    described && (described.code || described.message !== error.message)
      ? described
      : undefined;
  return {
    ok: false,
    status: statusForError(error),
    exitCode: error.exitCode,
    ...extra,
    ...error.details,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.hint ? { hint: error.hint } : {}),
      ...(cause ? { cause } : {}),
    },
  };
}
