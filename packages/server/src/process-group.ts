/**
 * Stopping a child started with `detached: true`, which gives it its own
 * process group. Killing only the direct child leaves whatever it started
 * alive (a shell's `sleep`, a wrapper script's real command), and on Linux
 * that grandchild keeps the stderr pipe open, so "close" waits for it.
 */
export function killProcessGroup(child: {
  pid?: number;
  kill: (signal: NodeJS.Signals) => boolean;
}): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // No group to kill (already gone, or not detached): fall through.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {}
}
