# Batch 1 server notes

Scope: the server part of batch 1 (`packages/server/src`: index.ts, review-events.ts, child.ts, new registry.ts, handoff-log.ts, wake-routes.ts, their tests). Built against `.context/batch-1-contract.md`.

## Before anything else

The worktree branch was created from `686919e` (upstream), not from batch 0. I fast-forwarded it to `batch-1-watchers-and-handoffs` (`040cdc2`, "Batch 0: safe install and rollback") before writing code, because the contract builds on batch 0's `version` and `instanceId`. The other batch 1 worktree (`worktree-agent-a260ed4714189e8d6`) was also on `686919e` when I looked.

## What landed

- `review-events.ts`: the queue now has `subscribe()` with a `deliver` callback that resolves true only on a real delivery, abort signals, a 2,147,483,647 ms cap instead of the 300 s clamp, key-based matching (`documentKey`), and seeding from the log (`nextSequence` plus unacknowledged events). `emit()` returns a `delivery` promise. `wait()` keeps its old behavior for existing callers.
- `handoff-log.ts`: `ReviewLog`, the session log in `<stateDir>/review-log.json`. Records, supersede, delivered, ack, wake result, sessions, retention, corrupt-file handling, atomic writes. Also the shared `readJsonState` and `writeJsonAtomic` helpers.
- `registry.ts`: `documentKey` (realpath, else resolved path), `DocumentRegistry` with in-memory tab and watcher presence, document views with the link, and the sweeper.
- `wake-routes.ts`: `WakeRouteStore` (`<stateDir>/wake-routes.json`), `runWakeRoute` for both kinds, the Done and test messages, and the express router for the five wake-route routes.
- `index.ts`: the long-poll fix, the SSE agent stream, Done, ack, status additions, `/api/documents`, `/api/documents/one`, `/api/documents/session`, open requests keyed by real path with the tab ack, the file watcher on `fs.promises`, the token gate on every `/api/*` route, `stateDir` in `createApp`, and `createServer(port, projectDir, stateDir)`. Every remote-document route, type, helper, constant and test is gone, along with the remote-only token gate and the `remoteDocumentToken` option.
- `child.ts`: `--state-dir <dir>`, falling back to `resolveStateDir()` (`ROUGHDRAFT_STATE_DIR`, then the directory of `ROUGHDRAFT_STATE_FILE`, then `~/.roughdraft`).
- `dev.ts` (not owned by anyone else): passes `<repo>/.roughdraft-state` (gitignored) unless `ROUGHDRAFT_STATE_DIR` is set. Without this, `pnpm dev` would have written its log into `~/.roughdraft` next to the real server.

## Decisions the contract left open

1. Legacy long-poll acknowledgement. A `POST /api/review-events/watch` body without an `includePending` key is treated as a legacy client (every installed 0.1.x CLI and MCP). When its response finishes, the handoff is marked delivered and acknowledged with `ackedBy: "long-poll"`, because those clients never ack. A body that carries `includePending` (true or false) is a new client: a finished response only marks the handoff delivered, and the client acks through `/api/review-events/ack`. This follows the lifecycle review's outbox design.
2. Cursor rule on both watch routes. An explicit cursor wins: for the stream, `Last-Event-ID`, then `afterSequence`, then `fromNow` (default true). For the long poll, `afterSequence` when it is a number, else `fromNow` as before. The old long poll ignored `afterSequence` unless `fromNow` was false. No installed client sends `afterSequence`, so nothing breaks.
3. "Unacknowledged" means `pending` or `delivered`. A new Done supersedes older handoffs in either state, so a stale round is never replayed as current. Superseded handoffs use the two-day retention window.
4. A Done replayed with a known `handoffId` answers 200 (a new Done answers 201) with the same body shape. `delivered` is then `deliveredTo.length > 0`.
5. Done waits up to 2 s (`deliveryWaitMs`) for a real delivery before it answers. With a long poll armed, that is the poll's batch window (250 ms by default).
6. The wake fires on every Done whose document has a session with a registered route for its harness, even when a live watcher also received the Done. That is the plan's D14 read literally ("Done writes the log and fires the wake"). If an agent both waits and has a route, it is woken twice. Flipping this to "only when not delivered" is a one-line change in the Done route.
7. In the Done response, `wake` is `{ routeId: <harness>, state: "none" }` while the wake is in flight. The app should read `routeId !== null && state === "none"` as "sending". If the route disappears between Done and firing, the handoff records `state: "failed"` with "No wake route for <harness>".
8. Wake route details: harness names match `[A-Za-z0-9._-]{1,64}`; `PUT` answers 400 `USAGE` on a bad body and resets `verifiedAt` and `lastError`; `DELETE` answers `{ ok: true, removed }`; the test route answers 404 `WAKE_ROUTE_NOT_FOUND` for an unknown harness, accepts an optional `by` in the body, and sets `ok` equal to `sent`. Commands run through the shell with `ROUGHDRAFT_TOKEN` stripped from their env, stdout ignored, the last 500 characters of stderr in the error, and SIGKILL at the timeout.
9. Wake route changes (`PUT`, `DELETE`, test) answer 403 `FORBIDDEN` when the request carries an `Origin` from another host, or when no token gate is active and the `Host` header is not localhost, 127.0.0.1 or ::1. Routes run shell commands, and the server has no CORS or DNS-rebinding protection, so this is the cheapest guard against a web page configuring one. The CLI sends neither header and is unaffected.
10. Token gate: `?token=` is accepted on any `GET /api/*` request, not only streams, because `<img src="/api/files?...">` cannot send a header either. A 401 carries `code: "UNAUTHORIZED"`. `createServer` turns the gate on only when a non-loopback host is bound, and it then applies to the whole app, loopback requests included.
11. `/api/status` adds `stateDir` (null when memory only) and `capabilities.tokenRequired`, besides the contract's flags and `warnings`. `stateless: true` stays.
12. `DocumentRecord` gains `lastOpenRequestAt` (persisted), set by the session route and by `POST /api/open-request`. `/api/documents` is sorted by `lastActivityAt`, newest first.
13. Only documents with a session or at least one handoff are written to the log file. Documents that only have tabs live in memory and come back when the tabs reconnect.
14. The sweeper removes an idle document from memory and from the log file. See residual gaps.
15. Open requests: the tab sends `tabId` (the server makes one up as `tab_<n>` when it is missing) and optionally `visible=false`. The `connected` event now carries `tabId`, and the `open-request` event carries `requestId`. The ack route is `POST /api/open-request/ack { requestId }` and answers `{ ok }`. `tabs` in the open-request response counts distinct live tab ids for that file. `tabs` in a `DocumentView` also counts tabs inside their 30 s grace period.
16. `GET` and `PUT /api/markdown-file` record the version and create the registry entry, so a document shows up in `/api/documents` as soon as a tab loads it. The file watcher's `change` event gains `available`; a read error sends `available: false, version: null` instead of crashing the process (sync finding 7).
17. `/api/documents/one` and `/api/documents/session` use the same validation as other document routes (the file must exist). `/one` answers 404 `DOCUMENT_NOT_FOUND`. The session route needs `harness` and `label` (400 `USAGE`).
18. Ack is idempotent: acking an acknowledged or superseded handoff answers `{ ok: true, handoff }` with the record unchanged. Neither `handoffId` nor `sequence` gives 400 `USAGE`.
19. The `handoff` inside a streamed `review.completed` already shows `state: "delivered"`. The long poll's `handoffs` array is a snapshot taken just before the body is flushed, so it still says `pending`.
20. Log writes are synchronous (temp file plus rename) on every change. A write error becomes a `warnings[]` entry and never fails a Done.

## Contract changes the CLI and app owners must know about

- CLI: send `Authorization: Bearer $ROUGHDRAFT_TOKEN` on every request when the variable is set; a non-loopback server now gates every `/api/*` route.
- CLI: a long poll that does not send `includePending` is auto-acknowledged (decision 1). Send `includePending` explicitly if you want to ack yourself.
- CLI: `route test` reads `sent` (also `ok`); 404 `WAKE_ROUTE_NOT_FOUND` for an unknown harness.
- CLI tests: the four "runCli open in remote mode" tests in `cli.test.ts` fail on this branch because the routes they call are gone. They belong to the CLI owner, who removes remote mode.
- App: open-request ack is `POST /api/open-request/ack { requestId }`, with `requestId` in the event data; send `tabId` on `/api/open-requests`.
- App: treat `wake.routeId !== null && wake.state === "none"` as in flight (decision 7). A replayed `handoffId` answers 200.
- App: a browser on a token-gated server has no way to learn the token yet. Out of scope here; it matters only for a non-loopback bind.

## Tests

New files: `review-routes.test.ts` (real listener on port 0 for every disconnect-sensitive case), `handoff-log.test.ts`, `registry.test.ts`, `wake-routes.test.ts`. Extended: `review-events.test.ts`. Updated: `index.test.ts` (exact status shape, open-request shape, remote tests deleted).

Prove-it evidence:
- T1.2 (headers at once, newline keepalives) and T3.2 (aborted watcher dropped within 200 ms, next Done `delivered: false, pending: true`) failed against the old server before any production change: the first timed out waiting for headers, the second still saw `watcherCount: 1`.
- T3.3 (a connected watcher still counts after 500 ms) passed against the old code, as a guard should. With the fix's `res.on("close")` swapped for `req.on("close")` it fails with `watcherCount: 0`, which proves it catches the trap.
- The new queue tests ran against the original `review-events.ts`: five of six failed. The sixth (a 2^31 ms timeout must not fire at once) passed only because of the old 300 s clamp; it guards against removing the clamp outright.
- The log, registry, wake-route and stream tests cover new behavior and were written alongside the code.

Contract test names covered: T1.1, T1.2, T3.1, T3.2, T3.3, T4.1, T4.2, T4.3, T4.4, T6.1, T6.2, T8.1, plus the wake-route and session tests. T10.1 and the remaining CLI and MCP tests belong to the CLI owner.

## Verification run

- `pnpm --filter @roughdraft/server test`: 167 passed, 4 failed (the CLI remote-mode tests above). My test files ran five times in a row with no flakes (93 tests each run).
- `pnpm lint` (after `pnpm lint:fix`): clean. `pnpm test:selectors`: clean.
- `pnpm --filter @roughdraft/server build`: exit 0.
- Realistic check (`scratchpad/realistic-check.sh`): the built `dist/child.js` on port 7461 with `--state-dir` under the session scratchpad, driven with curl. The status payload showed the state dir and the new capabilities. A curl SSE stream received `retry`, `hello`, a `: keepalive` comment after 15 s, then `id: 1` / `review.completed` with the handoff marked delivered. A curl legacy long poll received headers within 1 s, one newline at 15 s, then a parseable body. The Done answered `delivered: true, pending: false`. The command wake route wrote every `ROUGHDRAFT_*` variable, and a second Done fired the url route at a local listener. `review-log.json` held both handoffs with their wake results and `nextSequence: 3`. After a restart on the same state dir, a stream with `Last-Event-ID: 1` replayed sequence 2, `/api/documents` reported one pending handoff, and an ack cleared it. Ports 7373 and 7390 were never touched, and both test servers were stopped.

## Residual gaps

- No 330 s soak against undici's real timeouts. The lifecycle probes already showed that headers at once plus a 15 s keepalive survive it, and the keepalive was observed live at 15 s. The six-minute `watch` soak in the plan needs the CLI's new client.
- The sweeper drops an idle document from the log file too, so an hour after everything was acknowledged and every tab closed, `roughdraft log` no longer shows that document's session or history. Keeping acknowledged history for its two days would need a "hidden from status" flag instead of a delete.
- The double wake (decision 6) needs Jordan's call.
- The browser side of the open-request ack and the Chrome connection pool (finding 2) are untested here: the first is the app's, the second is batch 2.
- No Claude Code desktop wake route was verified; that needs a real harness command.
- Other DNS-rebinding exposure (for example `PUT /api/markdown-file`) predates this batch and is unchanged.
