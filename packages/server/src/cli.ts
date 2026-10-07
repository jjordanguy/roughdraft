import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type RfmDiagnostic,
  validateRoughdraftMarkdown,
} from "@roughdraft/rfm";
import {
  ROUGHDRAFT_BIND_HOST,
  ROUGHDRAFT_DEFAULT_PORT,
  ROUGHDRAFT_LOOPBACK_HOSTS,
  ROUGHDRAFT_PUBLIC_HOST,
} from "./network.js";
import {
  CliError,
  EXIT_SERVER,
  errorEnvelope,
  interruptedError,
  toCliError,
  usageError,
} from "./errors.js";
import { findAvailablePort } from "./ports.js";
import {
  type ApiContext,
  ackHandoffs,
  authHeaders,
  collectHandoffs,
  createServerResolver,
  type DocumentRecord,
  type DocumentView,
  documentKey,
  documentViewFromRecord,
  getServerStateFilePath,
  getStateDir,
  type HandoffRecord,
  type ListedHandoff,
  listDocuments,
  listWakeRoutes,
  putWakeRoute,
  readReviewLogFromDisk,
  readWakeRoutesFromDisk,
  registerSession,
  removeWakeRoute,
  type ServerStatus,
  type SessionRecord,
  testWakeRoute,
  type WakeRoute,
  type WatchNotice,
  type WatchResult,
  type WatchTuning,
  watchReviewEvents,
} from "./review-watch-client.js";
import { resolveUpdateStatus, type UpdateStatus } from "./update-status.js";

export { CliError } from "./errors.js";
export { getServerStateFilePath } from "./review-watch-client.js";

const AGENT_SETUP_URL = "https://roughdraft.md/setup.md";
const ROUGHDRAFT_FLAVORED_MARKDOWN_SPEC_URL =
  "https://roughdraft.md/spec/roughdraft-flavored-markdown.md";
const AGENT_SETUP_PROMPT = `Install Roughdraft for me using \`npm i -g roughdraft\`, then read ${AGENT_SETUP_URL} and set yourself up to use it.`;
const STATUS_PATH = "/api/status";
const STATUS_TIMEOUT_MS = 750;
const OPEN_REQUEST_TIMEOUT_MS = 2_500;
const SERVER_WAIT_ATTEMPTS = 40;
const SERVER_WAIT_DELAY_MS = 150;
const PROCESS_WAIT_ATTEMPTS = 20;
const PROCESS_WAIT_DELAY_MS = 150;
const KNOWN_COMMANDS = [
  "open",
  "start",
  "status",
  "stop",
  "restart",
  "watch",
  "pending",
  "ack",
  "log",
  "route",
  "mcp",
  "doctor",
  "help",
  "agent-setup",
  "criticmarkup",
] as const;

export interface RoughdraftServerState {
  port: number;
  pid: number;
  startedAt: string;
  url: string;
}

interface StatusPayload {
  backend?: string;
  pid?: number;
  projectDir?: string;
  serverRoot?: string;
  port?: number;
  version?: string;
  instanceId?: string;
  warnings?: string[];
}

const SERVER_ERROR = EXIT_SERVER;

interface DevFrontendState {
  apiPort: number | null;
  appPort: number;
  mode?: "full-dev" | "preview-web";
  repoRoot: string;
  startedAt: string;
  url: string;
}

interface LiveDevFrontend {
  frontendUrl: string;
  apiUrl: string | null;
}

export interface SpawnedServer {
  pid: number;
}

export type InterruptSignal = "SIGINT" | "SIGTERM";

export interface CliDependencies {
  env: NodeJS.ProcessEnv;
  cwd: string;
  fetchImpl: typeof fetch;
  findAvailablePortImpl: typeof findAvailablePort;
  sleepImpl: (ms: number) => Promise<void>;
  spawnServerProcess: (options: {
    port: number;
    projectDir: string;
    stateDir: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<SpawnedServer> | SpawnedServer;
  isProcessRunning: (pid: number) => boolean;
  stopProcess: (pid: number) => Promise<void>;
  openUrl: (url: string) => OpenMode;
  resolveUpdateStatus: () => Promise<UpdateStatus>;
  log: (message: string) => void;
  error: (message: string) => void;
  /** Subscribes to SIGINT and SIGTERM while a watch runs; returns the unsubscribe. */
  onInterrupt: (handler: (signal: InterruptSignal) => void) => () => void;
  /** Watch timing overrides (tests shorten polls and backoff). */
  watchTuning?: Partial<WatchTuning>;
  /** Clock for the watch deadline (tests use a fake one). */
  now?: () => number;
}

type OpenMode =
  | "browser"
  | "chrome-app"
  | "disabled"
  | "existing-window"
  | "none";

interface EnsureRunningResult {
  server: ReusableServer;
  reused: boolean;
  portChanged: boolean;
}

interface ResolvedTargetPath {
  projectDir: string;
  openPath: string;
}

interface ReusableServer {
  port: number;
  url: string;
  tracked: boolean;
  pid: number | null;
  startedAt: string | null;
  version: string | null;
  instanceId: string | null;
  versionMatches: boolean;
}

type KnownCommand = (typeof KNOWN_COMMANDS)[number];

interface ParsedGlobalFlags {
  help: boolean;
  json: boolean;
  noColor: boolean;
  version: boolean;
}

interface ParsedCli {
  command: string | null;
  global: ParsedGlobalFlags;
  rest: string[];
}

interface ParsedCommandOptions {
  ack: boolean;
  after?: number;
  all: boolean;
  batchWindowSeconds: number;
  command?: string;
  harness?: string;
  help: boolean;
  json: boolean;
  label?: string;
  noAck: boolean;
  noOpen: boolean;
  noWatch: boolean;
  pending: boolean | null;
  printUrl: boolean;
  port?: string;
  reconnectSeconds?: number;
  replay: boolean;
  sessionId?: string;
  sessionLabel?: string;
  sessionLink?: string;
  stateDir?: string;
  stateFile?: string;
  timeoutSeconds?: number;
  url?: string;
  watch: boolean;
  positionals: string[];
}

const currentServerRoot = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);

function readPackageVersion(): string {
  try {
    const packageJsonPath = path.join(currentServerRoot, "package.json");
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      version?: unknown;
    };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {}

  return "0.0.0";
}

function emitJson(log: (message: string) => void, value: unknown) {
  log(JSON.stringify(value, null, 2));
}

function parseGlobalArgs(args: string[]): ParsedCli {
  const global: ParsedGlobalFlags = {
    help: false,
    json: false,
    noColor: false,
    version: false,
  };
  const rest = [...args];
  const commandParts: string[] = [];

  while (rest.length > 0) {
    const arg = rest.shift();
    if (!arg) break;

    if (arg === "--") {
      commandParts.push(...rest);
      break;
    }

    if (arg === "-h" || arg === "--help") {
      global.help = true;
      continue;
    }

    if (arg === "--version") {
      global.version = true;
      continue;
    }

    if (arg === "--json") {
      global.json = true;
      continue;
    }

    if (arg === "--no-color") {
      global.noColor = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw usageError(`Unknown flag: ${arg}`);
    }

    commandParts.push(arg, ...rest);
    break;
  }

  const [command, ...commandRest] = commandParts;
  return {
    command: command ?? null,
    global,
    rest: commandRest,
  };
}

function takeFlagValue(
  args: string[],
  index: number,
  flag: string,
): { value: string; nextIndex: number } {
  const value = args[index + 1];
  if (value === undefined || (value.startsWith("-") && value !== "-")) {
    throw usageError(`${flag} requires a value.`);
  }

  return { value, nextIndex: index + 1 };
}

type FlagGroup =
  | "all"
  | "open"
  | "port"
  | "watch"
  | "session"
  | "pendingAck"
  | "route";

const FLAG_GROUPS: Record<string, FlagGroup> = {
  "--all": "all",
  "--no-open": "open",
  "--print-url": "open",
  "--port": "port",
  "--watch": "watch",
  "--no-watch": "watch",
  "--replay": "watch",
  "--timeout": "watch",
  "--batch-window": "watch",
  "--pending": "watch",
  "--no-pending": "watch",
  "--after": "watch",
  "--no-ack": "watch",
  "--reconnect": "watch",
  "--harness": "session",
  "--session-label": "session",
  "--session-link": "session",
  "--session-id": "session",
  "--ack": "pendingAck",
  "--command": "route",
  "--url": "route",
  "--label": "route",
};

const VALUE_FLAGS = new Set([
  "--port",
  "--timeout",
  "--batch-window",
  "--after",
  "--reconnect",
  "--harness",
  "--session-label",
  "--session-link",
  "--session-id",
  "--command",
  "--url",
  "--label",
  "--state-file",
  "--state-dir",
]);

function parseCommandOptions(
  args: string[],
  allowed: FlagGroup[] = [],
): ParsedCommandOptions {
  const parsed: ParsedCommandOptions = {
    ack: false,
    all: false,
    batchWindowSeconds: 0.25,
    help: false,
    json: false,
    noAck: false,
    noOpen: false,
    noWatch: false,
    pending: null,
    positionals: [],
    printUrl: false,
    replay: false,
    watch: false,
  };
  const allowedGroups = new Set(allowed);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (arg === "--") {
      parsed.positionals.push(...args.slice(index + 1));
      break;
    }

    if (arg === "-h" || arg === "--help") {
      parsed.help = true;
      continue;
    }

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    if (!arg.startsWith("-") || arg === "-") {
      parsed.positionals.push(arg);
      continue;
    }

    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const group = FLAG_GROUPS[flag];
    const known =
      flag === "--state-file" ||
      flag === "--state-dir" ||
      (group !== undefined && allowedGroups.has(group));
    if (!known) {
      throw usageError(`Unknown flag: ${flag}`);
    }

    let value: string | undefined;
    if (VALUE_FLAGS.has(flag)) {
      if (equals !== -1) {
        value = arg.slice(equals + 1);
      } else {
        const next = takeFlagValue(args, index, flag);
        value = next.value;
        index = next.nextIndex;
      }
    } else if (equals !== -1) {
      throw usageError(`${flag} does not take a value.`);
    }

    switch (flag) {
      case "--all":
        parsed.all = true;
        break;
      case "--no-open":
        parsed.noOpen = true;
        break;
      case "--print-url":
        parsed.printUrl = true;
        parsed.noOpen = true;
        break;
      case "--watch":
        parsed.watch = true;
        break;
      case "--no-watch":
        parsed.noWatch = true;
        break;
      case "--replay":
        parsed.replay = true;
        break;
      case "--pending":
        parsed.pending = true;
        break;
      case "--no-pending":
        parsed.pending = false;
        break;
      case "--no-ack":
        parsed.noAck = true;
        break;
      case "--ack":
        parsed.ack = true;
        break;
      case "--timeout":
        parsed.timeoutSeconds = parsePositiveNumber(value ?? "", flag);
        break;
      case "--batch-window":
        parsed.batchWindowSeconds = parsePositiveNumber(value ?? "", flag);
        break;
      case "--reconnect":
        parsed.reconnectSeconds = parsePositiveNumber(value ?? "", flag);
        break;
      case "--after": {
        const after = Number.parseInt(value ?? "", 10);
        if (!Number.isInteger(after) || after < 0) {
          throw usageError("--after must be a sequence number (0 or more).");
        }
        parsed.after = after;
        break;
      }
      case "--port":
        parsed.port = value;
        break;
      case "--harness":
        parsed.harness = value;
        break;
      case "--session-label":
        parsed.sessionLabel = value;
        break;
      case "--session-link":
        parsed.sessionLink = value;
        break;
      case "--session-id":
        parsed.sessionId = value;
        break;
      case "--command":
        parsed.command = value;
        break;
      case "--url":
        parsed.url = value;
        break;
      case "--label":
        parsed.label = value;
        break;
      case "--state-file":
        parsed.stateFile = value;
        break;
      case "--state-dir":
        parsed.stateDir = value;
        break;
    }
  }

  return parsed;
}

function applyCliEnvOverrides(
  deps: CliDependencies,
  options: ParsedCommandOptions,
): CliDependencies {
  return {
    ...deps,
    env: {
      ...deps.env,
      ...(options.port ? { ROUGHDRAFT_PORT: options.port } : {}),
      ...(options.stateDir ? { ROUGHDRAFT_STATE_DIR: options.stateDir } : {}),
      ...(options.stateFile
        ? { ROUGHDRAFT_STATE_FILE: options.stateFile }
        : {}),
    },
  };
}

function parsePositiveNumber(value: string, flag: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw usageError(`${flag} must be a positive number.`);
  }
  return parsed;
}

function isKnownCommand(value: string): value is KnownCommand {
  return (KNOWN_COMMANDS as readonly string[]).includes(value);
}

function isPathLikeInput(value: string): boolean {
  return (
    value.toLowerCase().endsWith(".md") ||
    value.startsWith(".") ||
    value.startsWith("/") ||
    value.startsWith("~") ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.includes("/") ||
    value.includes("\\")
  );
}

function levenshteinDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let aIndex = 1; aIndex <= a.length; aIndex += 1) {
    current[0] = aIndex;
    for (let bIndex = 1; bIndex <= b.length; bIndex += 1) {
      current[bIndex] = Math.min(
        previous[bIndex] + 1,
        current[bIndex - 1] + 1,
        previous[bIndex - 1] + (a[aIndex - 1] === b[bIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[b.length] ?? 0;
}

function suggestCommand(command: string): string | null {
  const suggestion = KNOWN_COMMANDS.map((candidate) => ({
    candidate,
    distance: levenshteinDistance(command, candidate),
  })).sort((left, right) => left.distance - right.distance)[0];

  return suggestion && suggestion.distance <= 3 ? suggestion.candidate : null;
}

type SpawnSyncCommand = typeof spawnSync;
type OpenDetachedCommand = typeof openDetached;

function hasChromeAppMode(
  platform: NodeJS.Platform = process.platform,
  spawnSyncCommand: SpawnSyncCommand = spawnSync,
) {
  if (platform !== "darwin") return false;
  return (
    spawnSyncCommand("open", ["-Ra", "Google Chrome"], {
      stdio: "ignore",
    }).status === 0
  );
}

function openDetached(command: string, args: string[]) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function resolveDefaultBrowserBundleId(
  platform: NodeJS.Platform = process.platform,
  spawnSyncCommand: SpawnSyncCommand = spawnSync,
): string | null {
  if (platform !== "darwin") return null;

  const result = spawnSyncCommand(
    "plutil",
    [
      "-extract",
      "LSHandlers",
      "json",
      "-o",
      "-",
      path.join(
        os.homedir(),
        "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist",
      ),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );

  if (result.status !== 0) return null;

  try {
    const handlers = JSON.parse(result.stdout) as Array<{
      LSHandlerRoleAll?: string;
      LSHandlerURLScheme?: string;
    }>;
    return (
      handlers
        .find((handler) => handler.LSHandlerURLScheme === "http")
        ?.LSHandlerRoleAll?.trim()
        .toLowerCase() ?? null
    );
  } catch {
    return null;
  }
}

function isChromeBundleId(bundleId: string | null): boolean {
  return bundleId === "com.google.chrome";
}

export function createDefaultOpenUrl({
  env = process.env,
  platform = process.platform,
  spawnSyncCommand = spawnSync,
  openDetachedCommand = openDetached,
}: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnSyncCommand?: SpawnSyncCommand;
  openDetachedCommand?: OpenDetachedCommand;
} = {}): (url: string) => OpenMode {
  return (url: string) => {
    if (env.ROUGHDRAFT_NO_OPEN === "1") {
      return "disabled";
    }

    if (
      isChromeBundleId(
        resolveDefaultBrowserBundleId(platform, spawnSyncCommand),
      )
    ) {
      if (hasChromeAppMode(platform, spawnSyncCommand)) {
        openDetachedCommand("open", [
          "-na",
          "Google Chrome",
          "--args",
          `--app=${url}`,
        ]);
        return "chrome-app";
      }
    }

    if (platform === "darwin") {
      openDetachedCommand("open", [url]);
      return "browser";
    }

    if (platform === "linux") {
      openDetachedCommand("xdg-open", [url]);
      return "browser";
    }

    if (platform === "win32") {
      openDetachedCommand("cmd", ["/c", "start", "", url]);
      return "browser";
    }

    return "none";
  };
}

function defaultOpenUrl(url: string): OpenMode {
  return createDefaultOpenUrl()(url);
}

function defaultIsProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

async function defaultStopProcess(pid: number): Promise<void> {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      throw error;
    }
    return;
  }

  for (let attempt = 0; attempt < PROCESS_WAIT_ATTEMPTS; attempt += 1) {
    if (!defaultIsProcessRunning(pid)) {
      return;
    }
    await sleep(PROCESS_WAIT_DELAY_MS);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      throw error;
    }
  }
}

function defaultSpawnServerProcess(options: {
  port: number;
  projectDir: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
}): SpawnedServer {
  const serverEntryPath = fileURLToPath(new URL("./child.js", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      serverEntryPath,
      "--port",
      String(options.port),
      "--project-dir",
      options.projectDir,
      "--state-dir",
      options.stateDir,
    ],
    {
      cwd: options.projectDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: options.env,
    },
  );

  child.unref();

  if (!child.pid) {
    throw new CliError(
      "SERVER_START_FAILED",
      "Failed to start Roughdraft in the background.",
      { hint: "Run `roughdraft doctor` to check the install." },
    );
  }

  return { pid: child.pid };
}

function defaultOnInterrupt(
  handler: (signal: InterruptSignal) => void,
): () => void {
  const onSigint = () => handler("SIGINT");
  const onSigterm = () => handler("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

export function createCliDependencies(
  overrides: Partial<CliDependencies> = {},
): CliDependencies {
  const fetchImpl = overrides.fetchImpl ?? fetch;

  return {
    env: overrides.env ?? process.env,
    cwd: overrides.cwd ?? process.cwd(),
    fetchImpl,
    findAvailablePortImpl: overrides.findAvailablePortImpl ?? findAvailablePort,
    sleepImpl: overrides.sleepImpl ?? ((ms) => sleep(ms)),
    spawnServerProcess:
      overrides.spawnServerProcess ?? defaultSpawnServerProcess,
    isProcessRunning: overrides.isProcessRunning ?? defaultIsProcessRunning,
    stopProcess: overrides.stopProcess ?? defaultStopProcess,
    openUrl: overrides.openUrl ?? defaultOpenUrl,
    resolveUpdateStatus:
      overrides.resolveUpdateStatus ??
      (() => resolveUpdateStatus({ fetchImpl })),
    log: overrides.log ?? ((message) => console.log(message)),
    error: overrides.error ?? ((message) => console.error(message)),
    onInterrupt: overrides.onInterrupt ?? defaultOnInterrupt,
    watchTuning: overrides.watchTuning,
    now: overrides.now,
  };
}

/** Request options with the token header added when ROUGHDRAFT_TOKEN is set. */
function withAuth(deps: CliDependencies, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(authHeaders(deps.env))) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return { ...init, headers };
}

function apiContext(deps: CliDependencies, baseUrl: string): ApiContext {
  return {
    fetchImpl: deps.fetchImpl,
    baseUrl,
    headers: authHeaders(deps.env),
  };
}

async function printUpdateNoticeIfAvailable(deps: CliDependencies) {
  try {
    const updateStatus = await deps.resolveUpdateStatus();
    if (!updateStatus.updateAvailable) return;

    deps.log(
      `Roughdraft update available: ${updateStatus.currentVersion} -> ${updateStatus.latestVersion}. Run \`${updateStatus.updateCommand}\` to update.`,
    );
  } catch {}
}

const DONE_LOG_PARAGRAPH = [
  "Every Done Reviewing click is written to the session log, so a Done that no",
  "agent was waiting for is kept until one asks. `roughdraft pending <file>`",
  "lists what is waiting (`--ack` to acknowledge it), `roughdraft ack <id>`",
  "acknowledges one, `roughdraft log` shows each document with its session,",
  "wake route and latest Done, and `roughdraft route add|test` registers and",
  "checks how Done wakes your harness.",
];

function printHelp(log: (message: string) => void) {
  log("Roughdraft is a local Markdown review app for AI-assisted workflows.");
  log("");
  log("Usage:");
  log("  roughdraft [flags] <command> [args]");
  log("  roughdraft <path>");
  log("");
  log("Commands:");
  log("  open <path>        Open a Markdown file and wait for Done Reviewing");
  log("  start              Start or reuse the background server");
  log("  status             Show server status and open documents");
  log("  stop               Stop the managed background server");
  log("  restart            Stop the managed server and start this version");
  log("  watch <path>       Wait for a Done Reviewing event");
  log("  pending [path]     List Dones no agent has acknowledged yet");
  log("  ack <id>...        Acknowledge Dones by handoff id");
  log("  log                Show the session log");
  log("  route <action>     List, add, remove or test wake routes");
  log("  mcp                Start the experimental stdio MCP server");
  log("  doctor [path]      Diagnose setup or validate Markdown");
  log("  help agent         Print the agent setup prompt");
  log("  help criticmarkup  Show CriticMarkup examples");
  log("  agent-setup        Print the agent setup prompt");
  log("  criticmarkup       Show CriticMarkup examples");
  log("");
  log("Flags:");
  log("  -h, --help         Show help");
  log("  --version          Print version");
  log("  --json             Print JSON for supported commands");
  log("  --no-color         Disable color");
  log("");
  log("Examples:");
  log("  roughdraft open ./draft.md");
  log("  roughdraft open ./draft.md --print-url");
  log("  roughdraft open ./draft.md --json");
  log("  roughdraft open ./draft.md --no-watch");
  log("  roughdraft watch ./draft.md --json");
  log("  roughdraft pending ./draft.md --json --ack");
  log("  roughdraft status --json");
  log("");
  for (const line of DONE_LOG_PARAGRAPH) log(line);
  log("");
  log(
    "Exit codes: 0 done, 2 bad command or path, 3 server problem, 4 timeout,",
  );
  log("130 or 143 stopped by a signal, 1 unexpected error.");
  log("");
  log(`Agent setup: ${AGENT_SETUP_URL}`);
  log("Use `roughdraft help agent` for a copyable setup prompt.");
}

const WATCH_FLAG_HELP = [
  "  --timeout <seconds>       Give up after this long (exit 4); omitted means no limit",
  "  --pending                 Return a Done no agent has acknowledged yet (default)",
  "  --no-pending              Only wait for the next Done",
  "  --after <sequence>        Only return Dones after this sequence number",
  "  --no-ack                  Do not acknowledge the returned Done",
  "  --reconnect <seconds>     How long to wait for a lost server, default 120",
  "  --replay                  Return every retained Done for this file",
  "  --batch-window <seconds>  Small event batching window, default 0.25",
];

function printCommandHelp(
  command: KnownCommand,
  log: (message: string) => void,
) {
  if (command === "open") {
    log("Usage:");
    log(
      "  roughdraft open <path> [--no-open] [--no-watch] [--print-url] [--port <port>]",
    );
    log(
      "                         [--harness <name>] [--session-label <text>] [--session-link <url>] [--session-id <id>]",
    );
    log("");
    log(
      "Opens one Markdown file and waits for Done Reviewing. Starts Roughdraft if needed.",
    );
    log(
      "The watcher is armed before the window opens, so an early Done is not missed.",
    );
    log("");
    log("Flags:");
    log(
      "  --no-open                 Start/reuse the server without opening a browser",
    );
    log(
      "  --print-url               Print only the document URL and do not open it",
    );
    log("  --no-watch                Open the file without waiting");
    for (const line of WATCH_FLAG_HELP) log(line);
    log(
      "  --harness <name>          Register the session that opened the file (ROUGHDRAFT_HARNESS)",
    );
    log(
      "  --session-label <text>    Session label shown in the app (ROUGHDRAFT_SESSION_LABEL)",
    );
    log(
      "  --session-link <url>      Link back to the session (ROUGHDRAFT_SESSION_LINK)",
    );
    log(
      "  --session-id <id>         Session id passed to the wake route (ROUGHDRAFT_SESSION_ID)",
    );
    log("  --json                    Print one JSON object");
    log("  --port <port>             Preferred server port");
    log("  --state-file <path>       Server state file");
    log("  --state-dir <dir>         Directory containing server.json");
    log("");
    log("Environment variables:");
    log(
      "  ROUGHDRAFT_TOKEN      Bearer token sent on every request. Required when",
    );
    log(
      "                        the server binds a non-loopback host (ROUGHDRAFT_BIND_HOST).",
    );
    log("  ROUGHDRAFT_NO_OPEN    Set to 1 to suppress browser launch.");
    return;
  }

  if (command === "start") {
    log("Usage:");
    log("  roughdraft start [--port <port>] [--json]");
    log("");
    log("Starts or reuses the background Roughdraft server.");
    log("");
    log("Flags:");
    log("  --json               Print machine-readable output");
    log("  --port <port>        Preferred server port");
    log("  --state-file <path>  Server state file");
    log("  --state-dir <dir>    Directory containing server.json");
    return;
  }

  if (command === "status") {
    log("Usage:");
    log("  roughdraft status [--json]");
    log("");
    log(
      "Shows whether Roughdraft is running, and one line per open document: tabs,",
    );
    log("whether an agent is listening, and whether a Done is waiting.");
    log("");
    log("Flags:");
    log("  --json               Print machine-readable output");
    log("  --state-file <path>  Server state file");
    log("  --state-dir <dir>    Directory containing server.json");
    return;
  }

  if (command === "restart") {
    log("Usage:");
    log("  roughdraft restart [--port <port>] [--json]");
    log("");
    log("Stop the managed background server, then start one from this");
    log("installed version. Use it after installing a new version.");
    return;
  }

  if (command === "stop") {
    log("Usage:");
    log("  roughdraft stop [--all]");
    log("");
    log("Stops the managed background Roughdraft server.");
    log("");
    log("Flags:");
    log(
      "  --all                Also stop a confidently detected unmanaged server",
    );
    log("  --state-file <path>  Server state file");
    log("  --state-dir <dir>    Directory containing server.json");
    return;
  }

  if (command === "watch") {
    log("Usage:");
    log("  roughdraft watch <path> [--json] [--timeout <seconds>]");
    log("");
    log(
      "Waits until Roughdraft receives Done Reviewing for one Markdown file. A Done",
    );
    log(
      "that is already waiting comes back at once. Survives server restarts.",
    );
    log("");
    log("Flags:");
    log("  --json                    Print one JSON object");
    for (const line of WATCH_FLAG_HELP) log(line);
    log("  --state-file <path>       Server state file");
    log("  --state-dir <dir>         Directory containing server.json");
    return;
  }

  if (command === "pending") {
    log("Usage:");
    log("  roughdraft pending [<path>] [--ack] [--all] [--json]");
    log("");
    log(
      "Lists Dones no agent has acknowledged, for one file or all of them. Reads",
    );
    log("the session log on disk when the server is not running.");
    log("");
    log("Flags:");
    log("  --ack    Acknowledge what it lists");
    log("  --all    Include acknowledged Dones from the last 7 days");
    log("  --json   Print one JSON object");
    return;
  }

  if (command === "ack") {
    log("Usage:");
    log("  roughdraft ack <handoffId>... [--json]");
    log("");
    log("Acknowledges Dones by handoff id. Exits 2 when no id is known.");
    return;
  }

  if (command === "log") {
    log("Usage:");
    log("  roughdraft log [--json]");
    log("");
    log(
      "Shows the session log: each document with its session, wake route, latest",
    );
    log("Done and the result of its wake.");
    return;
  }

  if (command === "route") {
    log("Usage:");
    log("  roughdraft route list");
    log(
      '  roughdraft route add <harness> --command "<text>" | --url <url> [--label <text>]',
    );
    log("  roughdraft route test <harness>");
    log("  roughdraft route remove <harness>");
    log("");
    log(
      "Wake routes tell Roughdraft how to reach a harness when you click Done.",
    );
    log(
      "A command runs through the shell with {message}, {file}, {link} and {sessionId}",
    );
    log(
      "replaced, and ROUGHDRAFT_* variables set. A url receives a JSON POST.",
    );
    log(
      "`route test` exits 0 when the test wake was sent and 3 when it failed.",
    );
    return;
  }

  if (command === "mcp") {
    log("Usage:");
    log("  roughdraft mcp");
    log("");
    log("Starts Roughdraft's experimental stdio MCP server.");
    return;
  }

  if (command === "doctor") {
    log("Usage:");
    log("  roughdraft doctor [path] [--json]");
    log("");
    log(
      "Diagnoses local Roughdraft setup and server state, or validates one Markdown file.",
    );
    log("");
    log("Flags:");
    log("  --json               Print machine-readable output");
    log("  --state-file <path>  Server state file");
    log("  --state-dir <dir>    Directory containing server.json");
    return;
  }

  if (command === "help") {
    printHelp(log);
    return;
  }

  if (command === "agent-setup") {
    printAgentHelp(log);
    return;
  }

  printCriticMarkupHelp(log);
}

function printAgentHelp(log: (message: string) => void) {
  log("To set up your coding agent, paste this into it:");
  log("");
  log(AGENT_SETUP_PROMPT);
  log("");
  log(`Live setup instructions: ${AGENT_SETUP_URL}`);
  log("");
  for (const line of DONE_LOG_PARAGRAPH) log(line);
  log("");
  log(
    "This command only prints setup text. It does not edit agent instruction files.",
  );
}

function printCriticMarkupHelp(log: (message: string) => void) {
  log("CriticMarkup reference:");
  log("  {>>comment<<}       Comment");
  log("  {++new text++}      Insertion");
  log("  {--old text--}      Deletion");
  log("  {~~old~>new~~}      Substitution");
  log("  {==text==}          Highlight");
  log("");
  log("Examples:");
  log("  The intro {~~is vague~>needs a tighter claim~~}.");
  log("  Add {>>one concrete example here<<} before the conclusion.");
  log("");
  log("When adding new review feedback:");
  log(
    "  Prefer compact references like {>>Comment<<}{#c1} with metadata in final YAML endmatter.",
  );
  log(
    "  Use `c1`, `c2`, etc. for comment ids and `s1`, `s2`, etc. for suggested-change ids.",
  );
  log(
    "  Set `by` to your agent or author label and `at` to the current ISO timestamp.",
  );
  log("");
  log("Anchored comment with id:");
  log("  Review {==this sentence==}{>>Needs a source<<}{#c1}.");
  log("  ---");
  log("  comments:");
  log("    c1:");
  log("      by: AI");
  log('      at: "2026-04-28T12:00:00.000Z"');
  log("");
  log("Suggested changes with ids:");
  log("  Add {++one concrete example++}{#s1}.");
  log("  Replace {~~vague phrasing~>specific wording~~}{#s2}.");
  log("  ---");
  log("  suggestions:");
  log("    s1:");
  log("      by: AI");
  log('      at: "2026-04-28T12:10:00.000Z"');
  log("    s2:");
  log("      by: AI");
  log('      at: "2026-04-28T12:11:00.000Z"');
  log("");
  log("Reply to an existing comment:");
  log("  Store replies in `comments.<id>.body` with `re: <parent-id>`.");
  log("");
  log("Reply guidance:");
  log(
    "  Existing inline attribute metadata is still accepted for compatibility.",
  );
  log(
    "  Comment ids are document-local and usually look like `c1`, `c2`, `c3`.",
  );
  log("");
  log("Code blocks:");
  log(
    "  Treat CriticMarkup inside fenced code blocks as literal example text.",
  );
  log("");
  log("Full spec:");
  log(`  ${ROUGHDRAFT_FLAVORED_MARKDOWN_SPEC_URL}`);
}

function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : ROUGHDRAFT_DEFAULT_PORT;
}

function getPreferredPort(env: NodeJS.ProcessEnv): number {
  return parsePort(env.ROUGHDRAFT_PORT || env.PORT);
}

function buildPublicBaseUrl(port: number): string {
  return `http://${ROUGHDRAFT_PUBLIC_HOST}:${port}`;
}

function getDevFrontendStateFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicitFile = env.ROUGHDRAFT_DEV_FRONTEND_STATE_FILE?.trim();
  if (explicitFile) {
    return path.resolve(explicitFile);
  }

  return path.join(currentServerRoot, ".context", "dev-frontend.json");
}

function buildLoopbackUrl(host: string, port: number, pathname = "/"): URL {
  const baseHost = host.includes(":") ? `[${host}]` : host;
  return new URL(`http://${baseHost}:${port}${pathname}`);
}

function buildTargetUrl(baseUrl: string, openPath: string): string {
  const url = new URL(baseUrl);

  url.pathname = "/";
  url.searchParams.set("path", openPath);
  return url.toString();
}

/**
 * Asks a tab that already shows this file to come forward. Only a tab that
 * acknowledges the request counts; anything else opens a new window.
 */
async function sendOpenRequestToExistingWindow(
  deps: CliDependencies,
  baseUrl: string,
  targetUrl: string,
  openPath: string,
): Promise<boolean> {
  try {
    const requestUrl = new URL("/api/open-request", baseUrl);
    const response = await deps.fetchImpl(
      requestUrl,
      withAuth(deps, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: openPath, url: targetUrl }),
        // The server waits up to 1 s for the tab's acknowledgement.
        signal: AbortSignal.timeout(OPEN_REQUEST_TIMEOUT_MS),
      }),
    );

    if (!response.ok) {
      return false;
    }

    const payload = (await response.json()) as {
      delivered?: unknown;
      acknowledged?: unknown;
    };
    return payload.acknowledged === true;
  } catch {
    return false;
  }
}

function resolveTargetPath(
  inputPath: string,
  cwd?: string,
): ResolvedTargetPath {
  const resolvedPath = cwd
    ? path.resolve(cwd, inputPath)
    : path.resolve(inputPath);
  const looksLikeMarkdownFile = resolvedPath.toLowerCase().endsWith(".md");
  let stat: fs.Stats;

  try {
    stat = fs.statSync(resolvedPath);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ENOENT" || errorCode === "ENOTDIR") {
      throw new CliError("PATH_NOT_FOUND", `Path not found: ${resolvedPath}`, {
        details: { path: resolvedPath },
      });
    }

    throw new CliError(
      "PATH_UNREADABLE",
      `Failed to read path: ${resolvedPath}`,
      { cause: error, details: { path: resolvedPath } },
    );
  }

  if (stat.isDirectory() || (stat.isFile() && !looksLikeMarkdownFile)) {
    throw new CliError(
      "NOT_MARKDOWN",
      `Roughdraft can only open .md files: ${resolvedPath}`,
      { details: { path: resolvedPath } },
    );
  }

  if (!stat.isFile()) {
    throw new CliError("PATH_UNREADABLE", `Unsupported path: ${resolvedPath}`, {
      details: { path: resolvedPath },
    });
  }

  try {
    fs.accessSync(resolvedPath, fs.constants.R_OK);
  } catch (error) {
    throw new CliError(
      "PATH_UNREADABLE",
      `Failed to read path: ${resolvedPath}`,
      { cause: error, details: { path: resolvedPath } },
    );
  }

  return {
    projectDir: path.dirname(resolvedPath),
    openPath: resolvedPath,
  };
}

function isValidServerState(value: unknown): value is RoughdraftServerState {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<RoughdraftServerState>;
  return (
    typeof candidate.port === "number" &&
    Number.isFinite(candidate.port) &&
    typeof candidate.pid === "number" &&
    Number.isFinite(candidate.pid) &&
    typeof candidate.startedAt === "string" &&
    candidate.startedAt.length > 0 &&
    typeof candidate.url === "string" &&
    candidate.url.length > 0
  );
}

function isValidDevFrontendState(value: unknown): value is DevFrontendState {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<DevFrontendState>;
  return (
    (candidate.apiPort === null ||
      (typeof candidate.apiPort === "number" &&
        Number.isFinite(candidate.apiPort))) &&
    typeof candidate.appPort === "number" &&
    Number.isFinite(candidate.appPort) &&
    (candidate.mode === undefined ||
      candidate.mode === "full-dev" ||
      candidate.mode === "preview-web") &&
    typeof candidate.repoRoot === "string" &&
    candidate.repoRoot.length > 0 &&
    typeof candidate.startedAt === "string" &&
    candidate.startedAt.length > 0 &&
    typeof candidate.url === "string" &&
    candidate.url.length > 0
  );
}

function readServerStateFromDisk(
  stateFilePath: string,
): RoughdraftServerState | null {
  try {
    const raw = fs.readFileSync(stateFilePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isValidServerState(parsed)) {
      return parsed;
    }
  } catch {}

  if (fs.existsSync(stateFilePath)) {
    removeServerStateFile(stateFilePath);
  }

  return null;
}

function readDevFrontendStateFromDisk(
  stateFilePath: string,
): DevFrontendState | null {
  try {
    const raw = fs.readFileSync(stateFilePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isValidDevFrontendState(parsed)) {
      return parsed;
    }
  } catch {}

  return null;
}

function writeServerStateToDisk(
  stateFilePath: string,
  state: RoughdraftServerState,
) {
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(stateFilePath, `${JSON.stringify(state, null, 2)}\n`);
}

function removeServerStateFile(stateFilePath: string) {
  try {
    fs.rmSync(stateFilePath, { force: true });
  } catch {}
}

async function getStatusPayload(
  port: number,
  deps: CliDependencies,
): Promise<StatusPayload | null> {
  for (const host of [ROUGHDRAFT_BIND_HOST, ...ROUGHDRAFT_LOOPBACK_HOSTS]) {
    try {
      const response = await deps.fetchImpl(
        buildLoopbackUrl(host, port, STATUS_PATH),
        withAuth(deps, {
          signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
        }),
      );

      if (!response.ok) {
        continue;
      }

      const payload = (await response.json()) as StatusPayload;
      if (payload.backend === "local-files") {
        return payload;
      }
    } catch {}
  }

  return null;
}

async function waitForServer(port: number, deps: CliDependencies) {
  for (let attempt = 0; attempt < SERVER_WAIT_ATTEMPTS; attempt += 1) {
    const payload = await getStatusPayload(port, deps);
    if (payload) {
      return payload;
    }
    await deps.sleepImpl(SERVER_WAIT_DELAY_MS);
  }

  throw new CliError(
    "SERVER_START_FAILED",
    `Timed out waiting for Roughdraft to start on port ${port}.`,
    {
      hint: "Run `roughdraft doctor`, then `roughdraft start` to try again.",
    },
  );
}

async function waitForServerToStop(
  port: number,
  deps: CliDependencies,
): Promise<boolean> {
  for (let attempt = 0; attempt < PROCESS_WAIT_ATTEMPTS; attempt += 1) {
    const payload = await getStatusPayload(port, deps);
    if (!payload) {
      return true;
    }

    await deps.sleepImpl(PROCESS_WAIT_DELAY_MS);
  }

  return false;
}

async function resolveLiveDevFrontendBaseUrl(
  deps: CliDependencies,
): Promise<LiveDevFrontend | null> {
  const state = readDevFrontendStateFromDisk(
    getDevFrontendStateFilePath(deps.env),
  );
  if (!state) {
    return null;
  }

  if (path.resolve(state.repoRoot) !== currentServerRoot) {
    return null;
  }

  try {
    const frontendUrl = new URL(state.url);
    const mode =
      state.mode ?? (state.apiPort === null ? "preview-web" : "full-dev");

    if (mode === "preview-web") {
      const response = await deps.fetchImpl(frontendUrl, {
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }
    } else {
      const statusUrl = new URL("/api/status", frontendUrl);
      const response = await deps.fetchImpl(
        statusUrl,
        withAuth(deps, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) }),
      );

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as StatusPayload;
      if (payload.backend !== "local-files") {
        return null;
      }

      if (
        !payload.serverRoot ||
        path.resolve(payload.serverRoot) !== currentServerRoot
      ) {
        return null;
      }

      if (
        typeof payload.port === "number" &&
        state.apiPort !== null &&
        payload.port !== state.apiPort
      ) {
        return null;
      }
    }

    frontendUrl.pathname = "/";
    frontendUrl.search = "";
    frontendUrl.hash = "";
    return {
      frontendUrl: frontendUrl.toString(),
      apiUrl:
        mode === "full-dev" && state.apiPort !== null
          ? buildPublicBaseUrl(state.apiPort)
          : null,
    };
  } catch {
    return null;
  }
}

async function normalizeTrackedState(
  persistedState: RoughdraftServerState,
  stateFilePath: string,
): Promise<RoughdraftServerState> {
  const normalizedState = {
    ...persistedState,
    url: buildPublicBaseUrl(persistedState.port),
  };

  if (normalizedState.url !== persistedState.url) {
    writeServerStateToDisk(stateFilePath, normalizedState);
  }

  return normalizedState;
}

async function findReusableServer(
  deps: CliDependencies,
  options: { serverRoot?: string } = {},
): Promise<ReusableServer | null> {
  const stateFilePath = getServerStateFilePath(deps.env);
  const persistedState = readServerStateFromDisk(stateFilePath);
  const preferredPort = getPreferredPort(deps.env);
  const expectedServerRoot = path.resolve(
    options.serverRoot ?? currentServerRoot,
  );

  const matchesServerRoot = (payload: StatusPayload | null) =>
    payload?.serverRoot
      ? path.resolve(payload.serverRoot) === expectedServerRoot
      : false;

  if (persistedState) {
    const pidRunning = deps.isProcessRunning(persistedState.pid);
    const statusPayload = await getStatusPayload(persistedState.port, deps);

    if (pidRunning && statusPayload && matchesServerRoot(statusPayload)) {
      const normalizedState = await normalizeTrackedState(
        persistedState,
        stateFilePath,
      );
      return {
        port: normalizedState.port,
        url: normalizedState.url,
        tracked: true,
        pid: normalizedState.pid,
        startedAt: normalizedState.startedAt,
        ...describeServerVersion(statusPayload),
      };
    }

    const versionInfo = statusPayload
      ? describeServerVersion(statusPayload)
      : null;
    if (pidRunning && statusPayload && !versionInfo?.versionMatches) {
      // The tracked process is alive but runs another version (for example
      // the previous release installed at another path). Keep its state file
      // so stop and restart still find it, and report the mismatch.
      return {
        port: persistedState.port,
        url: buildPublicBaseUrl(persistedState.port),
        tracked: true,
        pid: persistedState.pid,
        startedAt: persistedState.startedAt,
        ...describeServerVersion(statusPayload),
        versionMatches: false,
      };
    }

    removeServerStateFile(stateFilePath);

    if (statusPayload && matchesServerRoot(statusPayload)) {
      return {
        port: persistedState.port,
        url: buildPublicBaseUrl(persistedState.port),
        tracked: false,
        pid: null,
        startedAt: null,
        ...describeServerVersion(statusPayload),
      };
    }
  }

  const preferredStatus = await getStatusPayload(preferredPort, deps);
  if (!preferredStatus || !matchesServerRoot(preferredStatus)) {
    return null;
  }

  return {
    port: preferredPort,
    url: buildPublicBaseUrl(preferredPort),
    tracked: false,
    pid: null,
    startedAt: null,
    ...describeServerVersion(preferredStatus),
  };
}

function describeServerVersion(payload: StatusPayload): {
  version: string | null;
  instanceId: string | null;
  versionMatches: boolean;
} {
  const version = typeof payload.version === "string" ? payload.version : null;
  return {
    version,
    instanceId:
      typeof payload.instanceId === "string" ? payload.instanceId : null,
    versionMatches: version === readPackageVersion(),
  };
}

function versionMismatchError(server: ReusableServer): CliError {
  const serverVersion = server.version ?? "older than 0.2.0";
  return new CliError(
    "SERVER_VERSION_MISMATCH",
    `The Roughdraft server at ${server.url} is version ${serverVersion} and this command is version ${readPackageVersion()}.`,
    {
      exitCode: SERVER_ERROR,
      hint: "Run `roughdraft restart` to replace the running server with this version.",
    },
  );
}

export async function readRunningServerState(
  deps: CliDependencies,
): Promise<RoughdraftServerState | null> {
  const reusableServer = await findReusableServer(deps, {
    serverRoot: currentServerRoot,
  });
  if (
    !reusableServer?.tracked ||
    reusableServer.pid === null ||
    reusableServer.startedAt === null
  ) {
    return null;
  }

  return {
    port: reusableServer.port,
    pid: reusableServer.pid,
    startedAt: reusableServer.startedAt,
    url: reusableServer.url,
  };
}

export async function ensureServerRunning(
  deps: CliDependencies,
  options: { projectDir?: string } = {},
): Promise<EnsureRunningResult> {
  const reusableServer = await findReusableServer(deps, {
    serverRoot: currentServerRoot,
  });
  if (reusableServer) {
    if (!reusableServer.versionMatches) {
      throw versionMismatchError(reusableServer);
    }
    return { server: reusableServer, reused: true, portChanged: false };
  }

  const preferredPort = getPreferredPort(deps.env);
  const port = await deps.findAvailablePortImpl(preferredPort);
  const projectDir = path.resolve(options.projectDir ?? deps.cwd);
  let spawned: SpawnedServer;
  try {
    spawned = await deps.spawnServerProcess({
      port,
      projectDir,
      stateDir: getStateDir(deps.env),
      env: deps.env,
    });
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "SERVER_START_FAILED",
      `Could not start Roughdraft: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, hint: "Run `roughdraft doctor` to check the install." },
    );
  }

  let startedStatus: StatusPayload;
  try {
    startedStatus = await waitForServer(port, deps);
  } catch (error) {
    await deps.stopProcess(spawned.pid);
    throw error;
  }

  const state: RoughdraftServerState = {
    port,
    pid: spawned.pid,
    startedAt: new Date().toISOString(),
    url: buildPublicBaseUrl(port),
  };
  writeServerStateToDisk(getServerStateFilePath(deps.env), state);

  return {
    server: {
      port: state.port,
      url: state.url,
      tracked: true,
      pid: state.pid,
      startedAt: state.startedAt,
      version: readPackageVersion(),
      instanceId:
        typeof startedStatus.instanceId === "string"
          ? startedStatus.instanceId
          : null,
      versionMatches: true,
    },
    reused: false,
    portChanged: port !== preferredPort,
  };
}

function buildServerStatusJson(
  server: ReusableServer | null,
  stateFilePath: string,
) {
  if (!server) {
    return {
      running: false,
      stateFile: stateFilePath,
    };
  }

  return {
    running: true,
    url: server.url,
    port: server.port,
    pid: server.pid,
    startedAt: server.startedAt,
    stateFile: stateFilePath,
    managed: server.tracked,
    serverVersion: server.version,
    cliVersion: readPackageVersion(),
    versionMatches: server.versionMatches,
    instanceId: server.instanceId,
  };
}

async function stopTrackedServer(deps: CliDependencies): Promise<{
  persistedState: RoughdraftServerState | null;
  stopped: boolean;
  portIsQuiet: boolean;
  failedPid: number | null;
}> {
  const stateFilePath = getServerStateFilePath(deps.env);
  const persistedState = readServerStateFromDisk(stateFilePath);

  if (!persistedState) {
    return {
      failedPid: null,
      persistedState: null,
      portIsQuiet: true,
      stopped: false,
    };
  }

  if (deps.isProcessRunning(persistedState.pid)) {
    await deps.stopProcess(persistedState.pid);
  }

  const trackedPidStillRunning = deps.isProcessRunning(persistedState.pid);
  const portIsQuiet = await waitForServerToStop(persistedState.port, deps);

  if (trackedPidStillRunning) {
    writeServerStateToDisk(stateFilePath, {
      ...persistedState,
      url: buildPublicBaseUrl(persistedState.port),
    });
    return {
      failedPid: persistedState.pid,
      persistedState,
      portIsQuiet,
      stopped: false,
    };
  }

  removeServerStateFile(stateFilePath);
  return {
    failedPid: null,
    persistedState,
    portIsQuiet,
    stopped: true,
  };
}

async function runDoctor(
  deps: CliDependencies,
  json: boolean,
): Promise<number> {
  const stateFilePath = getServerStateFilePath(deps.env);
  const persistedState = readServerStateFromDisk(stateFilePath);
  const preferredPort = getPreferredPort(deps.env);
  const preferredStatus = await getStatusPayload(preferredPort, deps);
  const trackedStatus = persistedState
    ? await getStatusPayload(persistedState.port, deps)
    : null;
  const cwdReadable = (() => {
    try {
      fs.accessSync(deps.cwd, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  })();
  const managedPidRunning = persistedState
    ? deps.isProcessRunning(persistedState.pid)
    : false;
  const serverRootMatches =
    trackedStatus?.serverRoot !== undefined
      ? path.resolve(trackedStatus.serverRoot) === currentServerRoot
      : false;
  const commandPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
  const devStateDir = deps.env.ROUGHDRAFT_STATE_DIR?.includes(
    `${path.sep}.roughdraft${path.sep}dev${path.sep}`,
  )
    ? path.resolve(deps.env.ROUGHDRAFT_STATE_DIR)
    : null;
  const devWrapperName = deps.env.ROUGHDRAFT_DEV_WRAPPER_NAME?.trim() || null;
  const devWrapperPath = deps.env.ROUGHDRAFT_DEV_WRAPPER_PATH?.trim()
    ? path.resolve(deps.env.ROUGHDRAFT_DEV_WRAPPER_PATH)
    : null;
  const devWrapperRepoRoot =
    deps.env.ROUGHDRAFT_DEV_WRAPPER_REPO_ROOT?.trim() || null;

  const report = {
    packageVersion: readPackageVersion(),
    nodeVersion: process.version,
    commandPath,
    stateFile: stateFilePath,
    stateFileExists: fs.existsSync(stateFilePath),
    managedPid: persistedState?.pid ?? null,
    managedPidRunning,
    recordedPort: persistedState?.port ?? null,
    recordedPortResponds: Boolean(trackedStatus),
    preferredPort,
    preferredPortResponds: Boolean(preferredStatus),
    serverRoot: trackedStatus?.serverRoot ?? null,
    serverRootMatches,
    browserOpeningDisabled: deps.env.ROUGHDRAFT_NO_OPEN === "1",
    serverWarnings: trackedStatus?.warnings ?? preferredStatus?.warnings ?? [],
    cwd: deps.cwd,
    cwdReadable,
    devWrapper:
      devStateDir || devWrapperName || devWrapperPath || devWrapperRepoRoot
        ? {
            commandName: devWrapperName,
            path: devWrapperPath,
            repoRoot: devWrapperRepoRoot,
            repoRootMatches: devWrapperRepoRoot
              ? path.resolve(devWrapperRepoRoot) === currentServerRoot
              : null,
            stateDir: devStateDir,
          }
        : null,
  };

  if (json) {
    emitJson(deps.log, okEnvelope(report));
    return 0;
  }

  deps.log(`Package version: ${report.packageVersion}`);
  deps.log(`Node version: ${report.nodeVersion}`);
  deps.log(`Command path: ${report.commandPath ?? "unknown"}`);
  deps.log(`State file: ${report.stateFile}`);
  deps.log(`State file exists: ${report.stateFileExists ? "yes" : "no"}`);
  deps.log(
    `Managed PID: ${
      report.managedPid === null
        ? "none"
        : `${report.managedPid} (${report.managedPidRunning ? "running" : "not running"})`
    }`,
  );
  deps.log(
    `Recorded port: ${
      report.recordedPort === null
        ? "none"
        : `${report.recordedPort} (${report.recordedPortResponds ? "responding" : "not responding"})`
    }`,
  );
  deps.log(
    `Preferred port: ${report.preferredPort} (${report.preferredPortResponds ? "responding" : "not responding"})`,
  );
  deps.log(
    `Server root matches checkout: ${report.serverRootMatches ? "yes" : "no"}`,
  );
  deps.log(
    `Browser opening disabled: ${report.browserOpeningDisabled ? "yes" : "no"}`,
  );
  deps.log(`Current directory readable: ${report.cwdReadable ? "yes" : "no"}`);
  for (const warning of report.serverWarnings) {
    deps.log(`Server warning: ${warning}`);
  }
  if (report.devWrapper) {
    deps.log(
      `Dev wrapper command: ${report.devWrapper.commandName ?? "unknown"}`,
    );
    deps.log(`Dev wrapper path: ${report.devWrapper.path ?? "unknown"}`);
    deps.log(
      `Dev wrapper repo root: ${report.devWrapper.repoRoot ?? "unknown"}`,
    );
    deps.log(`Dev state dir: ${report.devWrapper.stateDir ?? "unknown"}`);
  }

  return 0;
}

async function runMarkdownDoctor(
  deps: CliDependencies,
  targetPath: string,
  json: boolean,
): Promise<number> {
  if (!isMarkdownPath(targetPath)) {
    throw new CliError(
      "NOT_MARKDOWN",
      `Roughdraft doctor can only validate .md files: ${targetPath}`,
    );
  }

  const absolutePath = path.resolve(deps.cwd, targetPath);
  let markdown: string;

  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
      throw new CliError(
        "NOT_MARKDOWN",
        `Path is not a file: ${absolutePath}`,
        { details: { path: absolutePath } },
      );
    }
    markdown = fs.readFileSync(absolutePath, "utf8");
  } catch (error) {
    if (error instanceof CliError) throw error;
    const code =
      error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "";
    throw code === "ENOENT"
      ? new CliError("PATH_NOT_FOUND", `Path not found: ${absolutePath}`, {
          details: { path: absolutePath },
        })
      : new CliError(
          "PATH_UNREADABLE",
          `Could not read path: ${absolutePath}`,
          {
            cause: error,
            details: { path: absolutePath },
          },
        );
  }

  const validation = validateRoughdraftMarkdown(markdown);
  const payload = {
    kind: "markdown" as const,
    path: absolutePath,
    format: validation.format,
    version: validation.version,
    ok: validation.ok,
    errors: validation.errors,
    warnings: validation.warnings,
    summary: validation.summary,
  };

  if (json) {
    const exitCode = validation.ok ? 0 : 1;
    emitJson(deps.log, {
      ...payload,
      status: validation.ok ? "ok" : "error",
      exitCode,
    });
    return exitCode;
  }

  const displayPath = relativeDisplayPath(deps.cwd, absolutePath);
  deps.log(`Roughdraft Markdown doctor: ${displayPath}`);
  deps.log(`Status: ${validation.ok ? "passed" : "failed"}`);

  if (validation.errors.length > 0) {
    deps.log("");
    deps.log("Errors:");
    for (const diagnostic of validation.errors) {
      deps.log(formatMarkdownDiagnostic(diagnostic));
    }
  }

  if (validation.warnings.length > 0) {
    deps.log("");
    deps.log("Warnings:");
    for (const diagnostic of validation.warnings) {
      deps.log(formatMarkdownDiagnostic(diagnostic));
    }
  }

  if (validation.errors.length === 0 && validation.warnings.length === 0) {
    deps.log("");
    deps.log(
      `Found ${validation.summary.comments} comment(s) and ${validation.summary.suggestions} suggestion(s).`,
    );
  }

  return validation.ok ? 0 : 1;
}

interface CommandContext {
  /** Included as `path` in every envelope, errors too. */
  path?: string;
  /** Command keys every envelope of this command carries (errors too). */
  extra: () => Record<string, unknown>;
}

function okEnvelope(
  payload: Record<string, unknown>,
  options: { status?: "ok" | "completed"; exitCode?: number } = {},
): Record<string, unknown> {
  const exitCode = options.exitCode ?? 0;
  return {
    ok: exitCode === 0,
    status: exitCode === 0 ? (options.status ?? "ok") : "error",
    exitCode,
    ...payload,
  };
}

function quoteArg(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : JSON.stringify(value);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function describeSummary(summary: HandoffRecord["summary"] | undefined) {
  if (!summary) return "no counts";
  return [
    plural(summary.comments, "comment"),
    plural(summary.suggestions, "suggestion"),
    `${summary.unresolved} unresolved`,
  ].join(", ");
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "unknown time";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return time;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

function describeHandoffState(handoff: HandoffRecord): string {
  if (handoff.state === "acknowledged") {
    return `picked up at ${formatTime(handoff.ackedAt)}${handoff.ackedBy ? ` by ${handoff.ackedBy}` : ""}`;
  }
  if (handoff.state === "superseded") return "superseded by a later Done";
  if (handoff.state === "delivered") return "delivered, not acknowledged";
  return "waiting";
}

function describeWake(handoff: HandoffRecord): string {
  const wake = handoff.wake;
  if (!wake || (wake.routeId === null && wake.state === "none")) {
    return "no wake route";
  }
  if (wake.state === "sent") {
    return `sent to ${wake.routeId} at ${formatTime(wake.at)}`;
  }
  if (wake.state === "failed") {
    return `failed${wake.routeId ? ` (${wake.routeId})` : ""}: ${wake.error ?? "unknown error"}`;
  }
  return `sending to ${wake.routeId}`;
}

function describeRoute(route: WakeRoute | null | undefined): string {
  if (!route) return "none registered";
  const target = route.kind === "url" ? route.url : route.command;
  const state = route.lastError
    ? `last test failed: ${route.lastError}`
    : route.verifiedAt
      ? `verified ${formatTime(route.verifiedAt)}`
      : "not verified";
  return `${route.harness} (${route.kind} ${target}), ${state}`;
}

/** "plan.md: 1 tab, no agent listening, Done waiting since 3:42 PM (4 comments)" */
function formatDocumentLine(view: DocumentView): string {
  const parts = [
    plural(view.tabs, "tab"),
    view.watchers > 0
      ? `${plural(view.watchers, "agent")} listening`
      : "no agent listening",
  ];
  const latest = view.handoffs.at(-1);
  if (!latest) {
    parts.push("no Done yet");
  } else if (latest.state === "pending" || latest.state === "delivered") {
    parts.push(
      `Done waiting since ${formatTime(latest.createdAt)} (${plural(latest.summary.comments, "comment")})`,
    );
  } else if (latest.state === "acknowledged") {
    parts.push(`Done picked up at ${formatTime(latest.ackedAt)}`);
  }
  if (view.session) parts.push(`opened by ${view.session.label}`);
  return `${path.basename(view.documentPath)}: ${parts.join(", ")}`;
}

function printWatchNotice(deps: CliDependencies, notice: WatchNotice) {
  if (notice.type === "connection-lost") {
    deps.error(
      `roughdraft: lost the connection to Roughdraft${notice.serverUrl ? ` at ${notice.serverUrl}` : ""}; reconnecting.`,
    );
    return;
  }
  deps.error(
    `roughdraft: reconnected to ${notice.serverUrl}${notice.instanceChanged ? " (a new server instance)" : ""}.`,
  );
}

interface WatchFlowOptions {
  command: "watch" | "open";
  target: ResolvedTargetPath;
  json: boolean;
  includePending: boolean;
  afterSequence?: number;
  replay: boolean;
  timeoutSeconds?: number;
  reconnectSeconds?: number;
  batchWindowSeconds: number;
  ack: boolean;
  /** The dev API behind a live dev frontend; otherwise found from server.json. */
  fixedServerUrl?: string;
  /** Runs once the server holds the watcher (open opens the window here). */
  onArmed?: (server: ServerStatus) => Promise<void>;
}

function pendingHint(openPath: string): string {
  return `Run \`roughdraft pending ${quoteArg(openPath)} --json\` to check for a Done, then \`roughdraft watch ${quoteArg(openPath)} --json\` to keep waiting.`;
}

async function runWatchFlow(
  deps: CliDependencies,
  options: WatchFlowOptions,
  ctx: CommandContext,
): Promise<number> {
  const { target } = options;
  const relativePath = path.relative(target.projectDir, target.openPath);
  const hint = pendingHint(target.openPath);
  const controller = new AbortController();
  const unsubscribe = deps.onInterrupt((signal) => {
    controller.abort(interruptedError(signal, hint));
  });

  let result: WatchResult;
  try {
    result = await watchReviewEvents({
      fetchImpl: deps.fetchImpl,
      resolveServer: createServerResolver({
        env: deps.env,
        fetchImpl: deps.fetchImpl,
        fixedUrl: options.fixedServerUrl,
        serverRoot: currentServerRoot,
      }),
      projectPath: target.projectDir,
      relativePath,
      afterSequence: options.afterSequence,
      fromNow: !options.replay,
      includePending: options.includePending,
      timeoutMs:
        options.timeoutSeconds !== undefined
          ? options.timeoutSeconds * 1000
          : undefined,
      batchWindowSeconds: options.batchWindowSeconds,
      client: `roughdraft-cli ${options.command}`,
      headers: authHeaders(deps.env),
      signal: controller.signal,
      tuning: {
        ...deps.watchTuning,
        ...(options.reconnectSeconds !== undefined
          ? { reconnectMs: options.reconnectSeconds * 1000 }
          : {}),
      },
      now: deps.now,
      onArmed: async ({ server }) => {
        await options.onArmed?.(server);
      },
      onNotice: (notice) => printWatchNotice(deps, notice),
    });
  } catch (error) {
    if (error instanceof CliError && error.code === "SERVER_LOST") {
      error.hint = hint;
    }
    throw error;
  } finally {
    unsubscribe();
  }

  if (result.status === "timeout") {
    throw new CliError(
      "WATCH_TIMEOUT",
      `No Done Reviewing for ${target.openPath} within ${options.timeoutSeconds ?? 0} s.`,
      {
        hint,
        details: {
          events: [],
          timedOut: true,
          nextSequence: result.nextSequence,
          handoff: null,
          server: result.server,
        },
      },
    );
  }

  if (options.json) {
    emitJson(
      deps.log,
      okEnvelope(
        {
          path: target.openPath,
          ...ctx.extra(),
          server: result.server,
          handoff: result.handoff,
          events: result.events,
          timedOut: false,
          nextSequence: result.nextSequence,
        },
        { status: "completed" },
      ),
    );
  } else {
    deps.log(`Review completed for ${target.openPath}.`);
    deps.log(`Received ${result.events.length} event(s).`);
    const last = result.events.at(-1);
    if (last?.summary) deps.log(`Feedback: ${describeSummary(last.summary)}.`);
    if (last?.overallComment) {
      deps.log(`Overall comment: ${last.overallComment}`);
    }
  }

  // The handoff is acknowledged only after the result is out, so a reader
  // that never got it (a closed pipe, a crash) leaves it pending.
  const handoffIds = result.handoffs
    .filter((handoff) => handoff.state !== "acknowledged")
    .map((handoff) => handoff.handoffId);
  if (options.ack && handoffIds.length > 0) {
    try {
      await ackHandoffs(
        apiContext(deps, result.server.url),
        handoffIds,
        `roughdraft-cli ${options.command}`,
      );
    } catch (error) {
      deps.error(
        `roughdraft: could not acknowledge the Done (${error instanceof Error ? error.message : String(error)}). Run \`roughdraft ack ${handoffIds.join(" ")}\`.`,
      );
    }
  }

  return 0;
}

type DocumentsSnapshot =
  | {
      source: "server";
      server: ServerStatus;
      instanceId: string | null;
      logId: string | null;
      documents: DocumentView[];
    }
  | {
      source: "disk";
      server: null;
      instanceId: null;
      logId: string | null;
      documents: DocumentView[];
      stateDir: string;
    };

/** The session log from the running server, or from disk when it is down. */
async function readDocumentsSnapshot(
  deps: CliDependencies,
  server?: ServerStatus | null,
): Promise<DocumentsSnapshot> {
  const live =
    server === undefined
      ? await createServerResolver({
          env: deps.env,
          fetchImpl: deps.fetchImpl,
          serverRoot: currentServerRoot,
        })()
      : server;
  if (live && live.capabilities.documentRegistry === true) {
    const listed = await listDocuments(apiContext(deps, live.url));
    return {
      source: "server",
      server: live,
      instanceId: listed.instanceId,
      logId: listed.logId,
      documents: listed.documents,
    };
  }
  const stateDir = live?.stateDir ?? getStateDir(deps.env);
  const disk = readReviewLogFromDisk(stateDir);
  return {
    source: "disk",
    server: null,
    instanceId: null,
    logId: disk.logId,
    documents: disk.documents.map((record: DocumentRecord) =>
      documentViewFromRecord(record, null),
    ),
    stateDir,
  };
}

function countPending(documents: DocumentView[]): number {
  return documents.reduce(
    (total, document) =>
      total +
      document.handoffs.filter(
        (handoff) =>
          handoff.state === "pending" || handoff.state === "delivered",
      ).length,
    0,
  );
}

async function runPending(
  deps: CliDependencies,
  options: ParsedCommandOptions,
  json: boolean,
  ctx: CommandContext,
): Promise<number> {
  if (options.positionals.length > 1) {
    throw usageError("Usage: roughdraft pending [<path>] [--ack] [--all]");
  }
  const target = options.positionals[0]
    ? resolveTargetPath(options.positionals[0], deps.cwd)
    : null;
  if (target) ctx.path = target.openPath;
  const snapshot = await readDocumentsSnapshot(deps);
  const handoffs: ListedHandoff[] = collectHandoffs(snapshot.documents, {
    key: target ? documentKey(target.openPath) : undefined,
    includeAcked: options.all,
  });

  let acked: string[] | undefined;
  let ackError: string | undefined;
  if (options.ack) {
    const toAck = handoffs
      .filter(
        (handoff) =>
          handoff.state === "pending" || handoff.state === "delivered",
      )
      .map((handoff) => handoff.handoffId);
    if (snapshot.source === "server") {
      acked =
        toAck.length > 0
          ? (
              await ackHandoffs(
                apiContext(deps, snapshot.server.url),
                toAck,
                "roughdraft-cli pending",
              )
            ).acked
          : [];
    } else {
      acked = [];
      if (toAck.length > 0) {
        ackError =
          "Roughdraft is not running, so nothing was acknowledged. Start it with `roughdraft start` and run this again.";
      }
    }
  }

  if (json) {
    emitJson(
      deps.log,
      okEnvelope({
        ...(target ? { path: target.openPath } : {}),
        source: snapshot.source,
        handoffs,
        ...(acked !== undefined ? { acked } : {}),
        ...(ackError ? { ackError } : {}),
      }),
    );
    return 0;
  }

  if (handoffs.length === 0) {
    deps.log(
      target
        ? `No Done waiting for ${target.openPath}.`
        : "No Done waiting for any document.",
    );
  }
  for (const handoff of handoffs) {
    deps.log(
      `${handoff.documentPath}: Done at ${formatTime(handoff.createdAt)} (${describeSummary(handoff.summary)}), ${describeHandoffState(handoff)}`,
    );
    deps.log(`  id: ${handoff.handoffId}`);
    if (handoff.overallComment) {
      deps.log(`  overall comment: ${handoff.overallComment}`);
    }
  }
  if (snapshot.source === "disk") {
    deps.log("(Roughdraft is not running; read from the session log on disk.)");
  }
  if (acked && acked.length > 0) {
    deps.log(`Acknowledged ${plural(acked.length, "Done")}.`);
  }
  if (ackError) deps.error(`roughdraft: ${ackError}`);
  return 0;
}

async function requireLiveServer(
  deps: CliDependencies,
  action: string,
): Promise<ServerStatus> {
  const server = await createServerResolver({
    env: deps.env,
    fetchImpl: deps.fetchImpl,
    serverRoot: currentServerRoot,
  })();
  if (!server) {
    throw new CliError(
      "SERVER_UNREACHABLE",
      `Roughdraft is not running, so it cannot ${action}.`,
      { hint: "Start it with `roughdraft start`, then try again." },
    );
  }
  return server;
}

async function runAck(
  deps: CliDependencies,
  options: ParsedCommandOptions,
  json: boolean,
): Promise<number> {
  const ids = options.positionals;
  if (ids.length === 0) {
    throw usageError("Usage: roughdraft ack <handoffId>... [--json]");
  }
  const server = await requireLiveServer(deps, "acknowledge a Done");
  const result = await ackHandoffs(
    apiContext(deps, server.url),
    ids,
    "roughdraft-cli ack",
  );
  if (result.acked.length === 0) {
    throw new CliError(
      "HANDOFF_NOT_FOUND",
      `No handoff found for ${ids.join(", ")}.`,
      {
        hint: "Run `roughdraft pending --json` to list the Dones that are waiting.",
        details: { acked: [], unknown: result.unknown },
      },
    );
  }
  if (json) {
    emitJson(
      deps.log,
      okEnvelope({ acked: result.acked, unknown: result.unknown }),
    );
    return 0;
  }
  for (const id of result.acked) deps.log(`Acknowledged ${id}.`);
  for (const id of result.unknown)
    deps.error(`roughdraft: unknown handoff ${id}`);
  return 0;
}

async function runLog(
  deps: CliDependencies,
  options: ParsedCommandOptions,
  json: boolean,
): Promise<number> {
  if (options.positionals.length > 0) {
    throw usageError("Usage: roughdraft log [--json]");
  }
  const snapshot = await readDocumentsSnapshot(deps);
  const routes =
    snapshot.source === "server"
      ? await listWakeRoutes(apiContext(deps, snapshot.server.url))
      : readWakeRoutesFromDisk(snapshot.stateDir);
  const documents = snapshot.documents.map((view) => ({
    documentPath: view.documentPath,
    url: view.url || null,
    session: view.session,
    route: view.session
      ? (routes.find((route) => route.harness === view.session?.harness) ??
        null)
      : null,
    latestHandoff: view.handoffs.at(-1) ?? null,
    pendingHandoffs: view.pendingHandoffs,
    tabs: view.tabs,
    watchers: view.watchers,
    lastActivityAt: view.lastActivityAt,
  }));

  if (json) {
    emitJson(
      deps.log,
      okEnvelope({
        source: snapshot.source,
        ...(snapshot.server ? { serverUrl: snapshot.server.publicUrl } : {}),
        documents,
        routes,
      }),
    );
    return 0;
  }

  if (snapshot.source === "disk") {
    deps.log("Roughdraft is not running; this is the session log on disk.");
  }
  if (documents.length === 0) {
    deps.log("The session log is empty.");
  }
  for (const document of documents) {
    deps.log(document.documentPath);
    if (document.url) deps.log(`  Link: ${document.url}`);
    const session = document.session as SessionRecord | null;
    deps.log(
      session
        ? `  Session: ${session.label} (${session.harness}${session.sessionId ? `, id ${session.sessionId}` : ""})${session.link ? ` ${session.link}` : ""}`
        : "  Session: none registered",
    );
    if (session) deps.log(`  Wake route: ${describeRoute(document.route)}`);
    const latest = document.latestHandoff;
    if (latest) {
      deps.log(
        `  Latest Done: ${formatTime(latest.createdAt)} (${describeSummary(latest.summary)}), ${describeHandoffState(latest)}`,
      );
      deps.log(`  Wake: ${describeWake(latest)}`);
    } else {
      deps.log("  Latest Done: none");
    }
  }
  if (routes.length > 0) {
    deps.log("");
    deps.log("Wake routes:");
    for (const route of routes) deps.log(`  ${describeRoute(route)}`);
  }
  return 0;
}

async function runRoute(
  deps: CliDependencies,
  options: ParsedCommandOptions,
  json: boolean,
): Promise<number> {
  const [action, harness, ...extra] = options.positionals;
  const usage =
    "Usage: roughdraft route list | add <harness> --command <text> | --url <url> [--label <text>] | remove <harness> | test <harness>";
  if (!action || extra.length > 0) throw usageError(usage);

  if (action === "list") {
    if (harness) throw usageError(usage);
    const server = await createServerResolver({
      env: deps.env,
      fetchImpl: deps.fetchImpl,
      serverRoot: currentServerRoot,
    })();
    const routes = server
      ? await listWakeRoutes(apiContext(deps, server.url))
      : readWakeRoutesFromDisk(getStateDir(deps.env));
    if (json) {
      emitJson(
        deps.log,
        okEnvelope({ source: server ? "server" : "disk", routes }),
      );
      return 0;
    }
    if (routes.length === 0) deps.log("No wake routes registered.");
    for (const route of routes) deps.log(describeRoute(route));
    return 0;
  }

  if (!["add", "remove", "test"].includes(action)) throw usageError(usage);
  if (!harness) throw usageError(usage);
  if (action !== "add" && (options.command || options.url || options.label)) {
    throw usageError(usage);
  }

  if (action === "add") {
    if ((options.command ? 1 : 0) + (options.url ? 1 : 0) !== 1) {
      throw usageError(
        "route add needs exactly one of --command <text> or --url <url>.",
      );
    }
  }

  const { server } = await ensureServerRunning(deps);
  const api = apiContext(deps, server.url);

  if (action === "add") {
    const route = await putWakeRoute(api, harness, {
      kind: options.command ? "command" : "url",
      ...(options.command ? { command: options.command } : {}),
      ...(options.url ? { url: options.url } : {}),
      label: options.label ?? null,
    });
    if (json) {
      emitJson(deps.log, okEnvelope({ route }));
      return 0;
    }
    deps.log(`Saved the wake route for ${harness}.`);
    deps.log(`Test it with \`roughdraft route test ${quoteArg(harness)}\`.`);
    return 0;
  }

  if (action === "remove") {
    const removed = await removeWakeRoute(api, harness);
    if (!removed) {
      throw new CliError(
        "WAKE_ROUTE_NOT_FOUND",
        `No wake route for ${harness}.`,
        {
          details: { harness, removed: false },
        },
      );
    }
    if (json) {
      emitJson(deps.log, okEnvelope({ harness, removed: true }));
      return 0;
    }
    deps.log(`Removed the wake route for ${harness}.`);
    return 0;
  }

  const tested = await testWakeRoute(api, harness, "roughdraft-cli route test");
  if (!tested.sent) {
    throw new CliError(
      "WAKE_ROUTE_FAILED",
      `The wake route for ${harness} failed: ${tested.error ?? "unknown error"}`,
      {
        hint: `Fix it with \`roughdraft route add ${quoteArg(harness)} ...\` and test again.`,
        details: {
          harness,
          sent: false,
          error: tested.error,
          durationMs: tested.durationMs,
        },
      },
    );
  }
  if (json) {
    emitJson(
      deps.log,
      okEnvelope({
        harness,
        sent: true,
        error: null,
        durationMs: tested.durationMs,
      }),
    );
    return 0;
  }
  deps.log(
    `Sent a test wake through the ${harness} route${tested.durationMs !== null ? ` in ${tested.durationMs} ms` : ""}.`,
  );
  return 0;
}

function isMarkdownPath(targetPath: string): boolean {
  const extension = path.extname(targetPath).toLowerCase();
  return extension === ".md";
}

function relativeDisplayPath(cwd: string, absolutePath: string): string {
  const relativePath = path.relative(cwd, absolutePath);
  return relativePath && !relativePath.startsWith("..")
    ? relativePath
    : absolutePath;
}

function formatMarkdownDiagnostic(diagnostic: RfmDiagnostic): string {
  return `  ${diagnostic.line}:${diagnostic.column}  ${diagnostic.message}`;
}

function getConfidentStopCandidate(
  payload: StatusPayload | null,
): number | null {
  if (
    typeof payload?.pid !== "number" ||
    !Number.isFinite(payload.pid) ||
    payload.pid <= 0 ||
    !payload.serverRoot ||
    path.resolve(payload.serverRoot) !== currentServerRoot
  ) {
    return null;
  }

  return payload.pid;
}

async function runStop(
  deps: CliDependencies,
  options: ParsedCommandOptions,
  json: boolean,
): Promise<number> {
  const stateFilePath = getServerStateFilePath(deps.env);
  const stopResult = await stopTrackedServer(deps);
  const emit = (payload: Record<string, unknown>, exitCode: number) => {
    emitJson(deps.log, okEnvelope(payload, { exitCode }));
    return exitCode;
  };

  if (!stopResult.persistedState) {
    const preferredPort = getPreferredPort(deps.env);
    const unmanagedServer = await getStatusPayload(preferredPort, deps);
    if (unmanagedServer) {
      const candidatePid = options.all
        ? getConfidentStopCandidate(unmanagedServer)
        : null;
      if (candidatePid !== null) {
        await deps.stopProcess(candidatePid);
        const stopped = await waitForServerToStop(preferredPort, deps);
        if (stopped) {
          if (json) {
            return emit(
              {
                stopped: true,
                managed: false,
                pid: candidatePid,
                url: buildPublicBaseUrl(preferredPort),
                stateFile: stateFilePath,
              },
              0,
            );
          }

          deps.log(
            `Stopped unmanaged Roughdraft at ${buildPublicBaseUrl(preferredPort)}.`,
          );
          return 0;
        }
      }

      if (json) {
        return emit(
          {
            stopped: false,
            managed: false,
            url: buildPublicBaseUrl(preferredPort),
            ...(options.all
              ? { reason: "No confident unmanaged process candidate." }
              : {}),
            stateFile: stateFilePath,
          },
          1,
        );
      }

      deps.error(
        options.all
          ? `Roughdraft is still running at ${buildPublicBaseUrl(preferredPort)}, but it could not be matched to a safe process candidate. Stop it manually.`
          : `Roughdraft is still running at ${buildPublicBaseUrl(preferredPort)}, but it is not managed by ${stateFilePath}. Stop it manually.`,
      );
      return 1;
    }

    if (json) {
      return emit(
        {
          stopped: false,
          running: false,
          stateFile: stateFilePath,
        },
        0,
      );
    }

    deps.log("Roughdraft is not running.");
    return 0;
  }

  if (stopResult.failedPid !== null) {
    if (json) {
      return emit(
        {
          stopped: false,
          pid: stopResult.failedPid,
          stateFile: stateFilePath,
        },
        1,
      );
    }

    deps.error(`Failed to stop Roughdraft process ${stopResult.failedPid}.`);
    return 1;
  }

  if (!stopResult.portIsQuiet) {
    if (options.all) {
      const unmanagedServer = await getStatusPayload(
        stopResult.persistedState.port,
        deps,
      );
      const candidatePid = getConfidentStopCandidate(unmanagedServer);
      if (candidatePid !== null) {
        await deps.stopProcess(candidatePid);
        const stopped = await waitForServerToStop(
          stopResult.persistedState.port,
          deps,
        );
        if (stopped) {
          if (json) {
            return emit(
              {
                stopped: true,
                pid: stopResult.persistedState.pid,
                unmanagedPid: candidatePid,
                url: buildPublicBaseUrl(stopResult.persistedState.port),
                stateFile: stateFilePath,
              },
              0,
            );
          }

          deps.log(
            `Stopped Roughdraft at ${buildPublicBaseUrl(stopResult.persistedState.port)}.`,
          );
          deps.log(`Stopped unmanaged Roughdraft process ${candidatePid}.`);
          return 0;
        }
      }
    }

    if (json) {
      return emit(
        {
          stopped: true,
          pid: stopResult.persistedState.pid,
          url: buildPublicBaseUrl(stopResult.persistedState.port),
          anotherInstanceRunning: true,
          ...(options.all
            ? { reason: "No confident unmanaged process candidate." }
            : {}),
          stateFile: stateFilePath,
        },
        1,
      );
    }

    deps.error(
      `Stopped tracked Roughdraft process ${stopResult.persistedState.pid}, but another Roughdraft instance is still running at ${buildPublicBaseUrl(stopResult.persistedState.port)}.`,
    );
    return 1;
  }

  if (json) {
    return emit(
      {
        stopped: true,
        pid: stopResult.persistedState.pid,
        url: buildPublicBaseUrl(stopResult.persistedState.port),
        stateFile: stateFilePath,
      },
      0,
    );
  }

  deps.log(
    `Stopped Roughdraft at ${buildPublicBaseUrl(stopResult.persistedState.port)}.`,
  );
  return 0;
}

interface SessionOptions {
  harness: string;
  label: string;
  link: string | null;
  sessionId: string | null;
}

/**
 * The session to register on `open`: flags first, then ROUGHDRAFT_HARNESS,
 * ROUGHDRAFT_SESSION_LABEL, ROUGHDRAFT_SESSION_LINK, ROUGHDRAFT_SESSION_ID.
 * Nothing is registered without a harness.
 */
function resolveSessionOptions(
  options: ParsedCommandOptions,
  env: NodeJS.ProcessEnv,
): SessionOptions | null {
  const pick = (flag: string | undefined, envName: string) => {
    const value = flag ?? env[envName];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const harness = pick(options.harness, "ROUGHDRAFT_HARNESS");
  if (!harness) {
    if (options.sessionLabel || options.sessionLink || options.sessionId) {
      throw usageError(
        "--harness is required to register a session (or set ROUGHDRAFT_HARNESS).",
      );
    }
    return null;
  }
  return {
    harness,
    label: pick(options.sessionLabel, "ROUGHDRAFT_SESSION_LABEL") ?? harness,
    link: pick(options.sessionLink, "ROUGHDRAFT_SESSION_LINK"),
    sessionId: pick(options.sessionId, "ROUGHDRAFT_SESSION_ID"),
  };
}

function describeOpenMode(openMode: OpenMode, targetUrl: string): string {
  if (openMode === "chrome-app") {
    return `Opened Roughdraft in a Chrome app window: ${targetUrl}`;
  }
  if (openMode === "existing-window") {
    return `Reused an existing Roughdraft window: ${targetUrl}`;
  }
  if (openMode === "browser") {
    return `Opened Roughdraft in the default browser: ${targetUrl}`;
  }
  return `Roughdraft is running at ${targetUrl}`;
}

async function runOpen(
  deps: CliDependencies,
  options: ParsedCommandOptions,
  json: boolean,
  ctx: CommandContext,
): Promise<number> {
  const target = options.positionals[0];
  if (!target || options.positionals.length > 1) {
    throw usageError("Usage: roughdraft open <path>");
  }
  if (options.watch && options.noWatch) {
    throw usageError("Use either --watch or --no-watch, not both.");
  }
  if (options.watch && options.printUrl) {
    throw usageError("Use either --watch or --print-url, not both.");
  }

  const resolvedTarget = resolveTargetPath(target, deps.cwd);
  const { projectDir, openPath } = resolvedTarget;
  ctx.path = openPath;
  const sessionOptions = resolveSessionOptions(options, deps.env);

  const liveDevFrontend = await resolveLiveDevFrontendBaseUrl(deps);
  let result: EnsureRunningResult | null = null;
  let baseUrl: string;

  if (liveDevFrontend) {
    baseUrl = liveDevFrontend.frontendUrl;
  } else {
    result = await ensureServerRunning(deps, { projectDir });
    baseUrl = buildPublicBaseUrl(result.server.port);
  }
  const apiBaseUrl = liveDevFrontend ? liveDevFrontend.apiUrl : baseUrl;

  const targetUrl = buildTargetUrl(baseUrl, openPath);
  let openMode: OpenMode = "none";
  let session: SessionRecord | null = null;
  ctx.extra = () => ({
    url: targetUrl,
    serverUrl: baseUrl,
    openMode,
    session,
  });

  if (result?.portChanged) {
    const message = `Preferred port ${getPreferredPort(deps.env)} is busy, using ${result.server.port}.`;
    if (options.printUrl || json) {
      deps.error(message);
    } else {
      deps.log(message);
    }
  }

  if (options.printUrl) {
    if (json) {
      emitJson(deps.log, okEnvelope({ path: openPath, url: targetUrl }));
    } else {
      deps.log(targetUrl);
    }
    return 0;
  }

  // The session goes on the document before the window opens, so a Done
  // clicked in the first second already knows where to wake.
  if (sessionOptions && apiBaseUrl) {
    session = await registerSession(apiContext(deps, apiBaseUrl), {
      projectPath: projectDir,
      path: path.relative(projectDir, openPath),
      ...sessionOptions,
    });
  }

  const openWindow = async () => {
    openMode = "disabled";
    if (!options.noOpen && deps.env.ROUGHDRAFT_NO_OPEN !== "1") {
      openMode = (await sendOpenRequestToExistingWindow(
        deps,
        apiBaseUrl ?? baseUrl,
        targetUrl,
        openPath,
      ))
        ? "existing-window"
        : deps.openUrl(targetUrl);
    }
  };

  const shouldWatch = !options.noWatch;
  if (shouldWatch) {
    shouldPrintUpdateNoticeFor(ctx, false);
    if (liveDevFrontend && !liveDevFrontend.apiUrl) {
      // The preview-web frontend has no API behind it; Done goes to the
      // background server, so make sure one runs (as before).
      await ensureServerRunning(deps, { projectDir });
    }
    return runWatchFlow(
      deps,
      {
        command: "open",
        target: resolvedTarget,
        json,
        includePending: options.pending ?? true,
        afterSequence: options.after,
        replay: options.replay,
        timeoutSeconds: options.timeoutSeconds,
        reconnectSeconds: options.reconnectSeconds,
        batchWindowSeconds: options.batchWindowSeconds,
        ack: !options.noAck,
        fixedServerUrl: liveDevFrontend?.apiUrl ?? undefined,
        // The watcher is registered before the window opens, so a Done in
        // the first second is not missed.
        onArmed: async () => {
          await openWindow();
          if (json) {
            deps.error(
              `${describeOpenMode(openMode, targetUrl)}. Waiting for Done Reviewing.`,
            );
          } else {
            deps.log(describeOpenMode(openMode, targetUrl));
            deps.log("Waiting for Done Reviewing...");
          }
        },
      },
      ctx,
    );
  }

  await openWindow();
  if (json) {
    emitJson(
      deps.log,
      okEnvelope({
        opened: true,
        url: targetUrl,
        serverUrl: baseUrl,
        path: openPath,
        openMode,
        session,
      }),
    );
    return 0;
  }

  shouldPrintUpdateNoticeFor(ctx, true);
  deps.log(describeOpenMode(openMode, targetUrl));
  if (session) {
    deps.log(`Registered session: ${session.label} (${session.harness}).`);
  }
  return 0;
}

const updateNoticeRequests = new WeakMap<CommandContext, boolean>();

function shouldPrintUpdateNoticeFor(ctx: CommandContext, value: boolean) {
  updateNoticeRequests.set(ctx, value);
}

async function runStatus(
  deps: CliDependencies,
  json: boolean,
): Promise<number> {
  const stateFile = getServerStateFilePath(deps.env);
  const server = await findReusableServer(deps);
  if (!server) {
    const snapshot = await readDocumentsSnapshot(deps, null);
    const pendingHandoffs = countPending(snapshot.documents);
    if (json) {
      emitJson(
        deps.log,
        okEnvelope({
          ...buildServerStatusJson(null, stateFile),
          source: "disk",
          pendingHandoffs,
        }),
      );
      return 0;
    }

    deps.log("Roughdraft is not running. Start it with `roughdraft start`.");
    if (pendingHandoffs > 0) {
      deps.log(
        `${plural(pendingHandoffs, "Done")} waiting in the session log. Run \`roughdraft pending\` to see them.`,
      );
    }
    return 1;
  }

  let documents: DocumentView[] | null = null;
  try {
    const listed = await listDocuments(apiContext(deps, server.url));
    documents = listed.documents;
  } catch {}

  if (json) {
    emitJson(
      deps.log,
      okEnvelope({
        ...buildServerStatusJson(server, stateFile),
        ...(documents
          ? { documents, pendingHandoffs: countPending(documents) }
          : {}),
      }),
    );
    return 0;
  }

  deps.log(`Roughdraft is running at ${server.url}`);
  if (!server.versionMatches) {
    deps.log(
      `Version mismatch: the server is ${server.version ?? "older than 0.2.0"} and this command is ${readPackageVersion()}. Run \`roughdraft restart\`.`,
    );
  }
  if (server.tracked && server.pid !== null && server.startedAt !== null) {
    deps.log(`PID: ${server.pid}`);
    deps.log(`Started: ${server.startedAt}`);
    deps.log(`State file: ${stateFile}`);
  } else {
    deps.log(`This server is not managed by ${stateFile}.`);
  }
  if (documents && documents.length > 0) {
    deps.log("");
    for (const document of documents) {
      deps.log(formatDocumentLine(document));
      if (document.url) deps.log(`  ${document.url}`);
    }
  }
  return 0;
}

function printFailure(
  deps: CliDependencies,
  error: CliError,
  json: boolean,
  ctx: CommandContext,
) {
  if (json) {
    let extra: Record<string, unknown> = {};
    try {
      extra = ctx.extra();
    } catch {}
    emitJson(
      deps.log,
      errorEnvelope(error, {
        ...(ctx.path ? { path: ctx.path } : {}),
        ...extra,
      }),
    );
  } else {
    deps.error(`roughdraft: ${error.message}`);
    if (error.hint) deps.error(`hint: ${error.hint}`);
  }
  if (deps.env.ROUGHDRAFT_DEBUG === "1") {
    const cause = (error as Error & { cause?: unknown }).cause;
    const stack =
      error.code === "INTERNAL" && cause instanceof Error
        ? cause.stack
        : error.stack;
    if (stack) deps.error(stack);
  }
}

export async function runCli(
  args: string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  let deps = createCliDependencies(overrides);
  let shouldPrintUpdateNotice = false;
  let json = args.includes("--json");
  const ctx: CommandContext = { extra: () => ({}) };

  try {
    const parsed = parseGlobalArgs(args);
    json = parsed.global.json || json;

    if (parsed.global.version) {
      deps.log(readPackageVersion());
      return 0;
    }

    if (!parsed.command) {
      printHelp(deps.log);
      return 0;
    }

    if (parsed.command === "help") {
      const [topic, ...extra] = parsed.rest;
      if (extra.length > 0) {
        throw usageError("Usage: roughdraft help [agent|criticmarkup|command]");
      }

      if (!topic) {
        printHelp(deps.log);
        return 0;
      }

      if (topic === "agent") {
        printAgentHelp(deps.log);
        return 0;
      }

      if (topic === "criticmarkup") {
        printCriticMarkupHelp(deps.log);
        return 0;
      }

      if (isKnownCommand(topic)) {
        printCommandHelp(topic, deps.log);
        return 0;
      }

      throw usageError(`Unknown help topic: ${topic}`);
    }

    let command = parsed.command;
    let rest = parsed.rest;

    if (!isKnownCommand(command)) {
      if (isPathLikeInput(command)) {
        rest = [command, ...rest];
        command = "open";
      } else {
        const suggestion = suggestCommand(command);
        throw usageError(
          `Unknown command: ${command}.${suggestion ? ` Did you mean ${suggestion}?` : ""}`,
        );
      }
    }

    if (parsed.global.help) {
      printCommandHelp(command as KnownCommand, deps.log);
      return 0;
    }

    if (command === "criticmarkup") {
      shouldPrintUpdateNotice = true;
      printCriticMarkupHelp(deps.log);
      return 0;
    }

    if (command === "agent-setup") {
      shouldPrintUpdateNotice = true;
      printAgentHelp(deps.log);
      return 0;
    }

    const groupsByCommand: Record<string, FlagGroup[]> = {
      start: ["port"],
      status: [],
      restart: ["port"],
      stop: ["all"],
      watch: ["watch"],
      pending: ["all", "pendingAck"],
      ack: [],
      log: [],
      route: ["route", "port"],
      mcp: [],
      doctor: [],
      open: ["open", "port", "watch", "session"],
    };
    const options = parseCommandOptions(rest, groupsByCommand[command] ?? []);
    json = json || options.json;

    if (options.help) {
      printCommandHelp(command as KnownCommand, deps.log);
      return 0;
    }

    deps = applyCliEnvOverrides(deps, options);

    if (command === "start") {
      if (options.positionals.length > 0) {
        throw usageError("Usage: roughdraft start [--port <port>] [--json]");
      }

      shouldPrintUpdateNotice = !json;
      const result = await ensureServerRunning(deps);
      if (json) {
        emitJson(
          deps.log,
          okEnvelope({
            ...buildServerStatusJson(
              result.server,
              getServerStateFilePath(deps.env),
            ),
            reused: result.reused,
            portChanged: result.portChanged,
          }),
        );
        return 0;
      }

      if (result.reused) {
        if (result.server.tracked) {
          deps.log(`Roughdraft is already running at ${result.server.url}`);
        } else {
          deps.log(
            `Roughdraft is already running at ${result.server.url}, but it is not managed by ${getServerStateFilePath(deps.env)}.`,
          );
        }
        return 0;
      }

      if (result.portChanged) {
        deps.log(
          `Preferred port ${getPreferredPort(deps.env)} is busy, using ${result.server.port}.`,
        );
      }

      deps.log(`Roughdraft running at ${result.server.url}`);
      return 0;
    }

    if (command === "status") {
      if (options.positionals.length > 0) {
        throw usageError("Usage: roughdraft status [--json]");
      }
      shouldPrintUpdateNotice = !json;
      return await runStatus(deps, json);
    }

    if (command === "restart") {
      if (options.positionals.length > 0) {
        throw usageError("Usage: roughdraft restart [--port <port>] [--json]");
      }

      const stopResult = await stopTrackedServer(deps);
      if (stopResult.failedPid !== null) {
        throw new CliError(
          "SERVER_STOP_FAILED",
          `Could not stop the Roughdraft server with PID ${stopResult.failedPid}.`,
          {
            exitCode: SERVER_ERROR,
            hint: `Stop it yourself with \`kill ${stopResult.failedPid}\`, then run \`roughdraft start\`.`,
          },
        );
      }
      if (!stopResult.portIsQuiet) {
        const preferredPort = getPreferredPort(deps.env);
        const unmanaged = await getStatusPayload(preferredPort, deps);
        if (unmanaged && !stopResult.persistedState) {
          throw new CliError(
            "SERVER_NOT_MANAGED",
            `A Roughdraft server on port ${preferredPort} is not managed by ${getServerStateFilePath(deps.env)}.`,
            {
              exitCode: SERVER_ERROR,
              hint: "Run `roughdraft stop --all` to stop it, then `roughdraft start`.",
            },
          );
        }
      }

      const result = await ensureServerRunning(deps);
      if (json) {
        emitJson(
          deps.log,
          okEnvelope({
            ...buildServerStatusJson(
              result.server,
              getServerStateFilePath(deps.env),
            ),
            restarted: true,
            stoppedPid: stopResult.persistedState?.pid ?? null,
          }),
        );
        return 0;
      }

      if (stopResult.stopped && stopResult.persistedState) {
        deps.log(`Stopped Roughdraft PID ${stopResult.persistedState.pid}.`);
      }
      deps.log(`Roughdraft running at ${result.server.url}`);
      return 0;
    }

    if (command === "stop") {
      if (options.positionals.length > 0) {
        throw usageError("Usage: roughdraft stop [--all]");
      }

      shouldPrintUpdateNotice = !json;
      return await runStop(deps, options, json);
    }

    if (command === "watch") {
      if (options.positionals.length !== 1) {
        throw usageError("Usage: roughdraft watch <path> [--json]");
      }

      shouldPrintUpdateNotice = false;
      const target = resolveTargetPath(options.positionals[0] ?? "", deps.cwd);
      ctx.path = target.openPath;
      ctx.extra = () => ({ events: [], timedOut: false });
      await ensureServerRunning(deps, { projectDir: target.projectDir });
      return await runWatchFlow(
        deps,
        {
          command: "watch",
          target,
          json,
          includePending: options.pending ?? true,
          afterSequence: options.after,
          replay: options.replay,
          timeoutSeconds: options.timeoutSeconds,
          reconnectSeconds: options.reconnectSeconds,
          batchWindowSeconds: options.batchWindowSeconds,
          ack: !options.noAck,
          onArmed: async (server) => {
            if (json) {
              deps.error(
                `Waiting for Done Reviewing on ${target.openPath} (${server.publicUrl}).`,
              );
            }
          },
        },
        ctx,
      );
    }

    if (command === "pending") {
      return await runPending(deps, options, json, ctx);
    }

    if (command === "ack") {
      return await runAck(deps, options, json);
    }

    if (command === "log") {
      return await runLog(deps, options, json);
    }

    if (command === "route") {
      return await runRoute(deps, options, json);
    }

    if (command === "mcp") {
      if (options.positionals.length > 0) {
        throw usageError("Usage: roughdraft mcp");
      }

      const { startMcpServer } = await import("./mcp.js");
      startMcpServer({ env: deps.env, fetchImpl: deps.fetchImpl });
      return new Promise<number>(() => {});
    }

    if (command === "doctor") {
      if (options.positionals.length > 1) {
        throw usageError("Usage: roughdraft doctor [path] [--json]");
      }

      if (options.positionals.length === 1) {
        return await runMarkdownDoctor(
          deps,
          options.positionals[0] ?? "",
          json,
        );
      }

      shouldPrintUpdateNotice = !json;
      return await runDoctor(deps, json);
    }

    if (command === "open") {
      const exitCode = await runOpen(deps, options, json, ctx);
      shouldPrintUpdateNotice = updateNoticeRequests.get(ctx) ?? false;
      return exitCode;
    }

    throw usageError(`Unknown command: ${command}`);
  } catch (error) {
    const cliError = toCliError(error);
    shouldPrintUpdateNotice = false;
    printFailure(deps, cliError, json, ctx);
    return cliError.exitCode;
  } finally {
    if (shouldPrintUpdateNotice) {
      await printUpdateNoticeIfAvailable(deps);
    }
  }
}
