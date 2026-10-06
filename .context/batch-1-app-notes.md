# Batch 1 app notes

Branch `worktree-agent-a260ed4714189e8d6`, based on `batch-1-watchers-and-handoffs` (040cdc2, batch 0). The worktree was created from 686919e, which predates batch 0, so I moved the branch onto the batch 1 base before starting. Nothing under `packages/server` changed.

## What landed

- `src/review-handoff.ts`: `getReviewHandoffView(input)`, a pure function that maps watcher count, disk state, save state, request phase, the last Done result, the polled handoff record and the session label to one of `hidden`, `ready-listening`, `ready-no-agent`, `blocked`, `sending`, `sent`, `saved-for-agent`, `not-received`, `picked-up`, `error`, with the label, copy, icon and button flags for each. `createClientId()` makes the handoff id and the tab id.
- `DocumentWorkspace.tsx` renders the split button whenever `backend.info.kind === "local-files"` and a document is loaded, and draws everything from the view. Copy follows the contract table. The split button carries `data-watcher-state` and `data-handoff-state`. Blocked shows a tooltip with the reason (the primary button uses `focusableWhenDisabled` so hover and focus still reach the tooltip in a real browser) plus screen reader text.
- Every Done sends a `handoffId`. The id is kept in a ref until a 2xx arrives, so Retry after an error, or a Done after an edit that followed an error, reuses it. The overall comment clears on any 2xx.
- `CompleteReviewResult` gains optional `pending`, `handoff`, `wake`; `ReviewWatchStatus` gains `tabs`, `handoff`, `session`. `ApiBackend` parses them defensively (a malformed record becomes null). Wire types `HandoffRecord`, `HandoffWake`, `SessionRecord` are duplicated by name in `storage.ts`.
- The 1.5 s status poll now also reads `handoff` and `session`. It only updates the Done record when the polled `handoffId` matches the one this tab sent, so another tab's Done never flips this tab to "Picked up". The session label shows in the comment popover as `Opened by <label>` and in the wake line.
- `src/open-requests.ts`: the open-requests stream sends `tabId` (a UUID in `sessionStorage` under `roughdraft.tabId`); on an event the tab focuses, POSTs `/api/open-request/ack { requestId }` with `keepalive`, then navigates if the URL differs. The ack goes first so the unload cannot cancel it.
- Removed `remote-backend.ts`, its test, `RemoteSessionBanner`, the remote branch in `detect-backend.ts` and `App.tsx`, and the `remote` kind plus `sessionId`/`originPath` in `BackendInfo`. A leftover `?session=&token=` link now opens as a plain local-files page (tested).
- Screenshot guide: new rows for every handoff state, the `Agent watching` row fixed (no such header text exists; the state is a tooltip and a data attribute), remote rows removed, every new test id listed.

## Decisions the contract did not cover

- "Waking <session>" is an extra wake line. The server answers Done before the wake route runs, so `wake.state: "none"` with a non-null `routeId` means "in flight", not "no route". Without this the tab would say "No wake route registered" for up to one poll while a route is running.
- `not-received` is an extra state for a server that answers `delivered: false` without `pending` (a pre-batch-1 server). Copy: "No agent received this", Copy message button.
- Error state title is "Done not recorded"; the body is the contract sentence. Retry is disabled while the file is blocked.
- Returning to ready: an edit (as the contract says), and also a new document version from disk that does not belong to the Done (the agent replied or changed the file). Without the second rule Jordan could not approve an agent's revision without editing. Versions that belong to the Done are the version at the time of Done plus `handoff.version` from the response and from the poll.
- The old rule "after Sent, a watcher that drops and then reconnects returns the button to ready" is kept for `sent` and `picked-up`, not for `saved-for-agent` (the next watcher is about to pick it up and the tab should show "Picked up").
- An automatic return to ready (watcher cycle or disk version) closes the status popover so it does not silently turn into the comment form.
- The button is hidden for the preview and browser-storage backends (both still have a `completeReview` that returns `delivered: false`); the gate is the backend kind, not the method.
- Trigger accessible name changed from "Add overall handoff comment" to "Overall comment options" (global comment UX finding 9). No test used the old name.
- The copy message stays `I am done reviewing this file: <path>` (existing tests and the sent-state link use it). The wake route message format in the contract is the server's.

## What the server owner must provide (not in the contract, or easy to miss)

1. `handoff.version` in the Done response must equal the version the file watcher and `GET /api/markdown-file` report after the overall comment is appended (same `fileVersionFromFile`, read after the write). If it differs, the tab sees the server's own write as a new round and drops back to ready right after Done. The e2e "one comment in the file" test catches this.
2. `GET /api/review-events/status` must return `handoff` as the latest record for the document even after it is acknowledged (not only pending ones), with `ackedAt` set, so "Picked up" can show.
3. `wake.routeId` must be set in the Done response when a route exists, even though the wake has not run yet.
4. The open-request SSE event must carry `requestId`, and `GET /api/open-requests` must accept `tabId` as a query parameter.
5. The token rule for non-loopback binds (every `/api/*` route needs `Authorization: Bearer`) has no browser side in the contract. The app no longer reads `?token=` (that lived in the remote backend). Something must give the browser the token: a cookie set when the page is first loaded with `?token=`, or an app change that keeps `?token=` in `sessionStorage` and adds the header to every fetch and `?token=` to every EventSource. Until then the VPS page cannot call the API when a token is required.
6. TabPresence has a `visible` field, but the contract gives the tab no way to report visibility. The app sends only `tabId`.
7. The e2e server (`e2e/start-api.ts` calls `createServer(port)`) needs an isolated state dir per run, or the handoff log and wake routes from earlier runs leak into tests. The saved-for-agent e2e does not assert the wake line text for this reason.

## Verification run

- `pnpm --filter @roughdraft/app test`: 17 files, 254 tests pass. New: `src/review-handoff.test.ts` (table test, 20 rows plus session label and id tests), `src/api-backend.test.ts` (handoffId sent, fields parsed, old server answer, non-2xx throws, status poll parsing), `src/open-requests.test.ts` (tab id persistence and storage failure, URL, ack before navigate, old server without requestId, ack keepalive), component tests in `test/view-toggle-bugs.test.tsx` (button visible with no watcher, no-agent copy, agent waiting and session label, handoff id on Done, sending copy, saved for agent with Copy, picked up from the poll, another tab's ack ignored, retry reuses the handoff id and a fake server writes one comment, comment cleared on 2xx and a later Done carries no comment and a new id, blocked with a reason, not received). The new component tests were run against the old `DocumentWorkspace` first and 14 failed, as expected.
- `pnpm lint`, `pnpm test:selectors`, `pnpm --filter @roughdraft/app build`: green.
- E2E against the current (pre-batch-1) server on ports 4471 and 4472 with `--grep-invert @batch1-server`: 26 of 27 pass, including every `@smoke` test. The one failure, `homepage-storyboard.spec.ts` "docks the storyboard visual without mobile overlap", fails the same way on the base commit with my changes removed, so it is pre-existing. New tests that pass now: "an edit after Done returns the button to the ready state" and "a save conflict disables Done and the tooltip names the reason" (this one proves the tooltip shows on hover of a disabled button in real Chromium).
- `open-file.spec.ts` "focuses an existing window" now uses `toMatchObject({ delivered: true })` because the batch 1 server adds fields.

## E2E tests that await the batch 1 server

Tagged `@batch1-server`; run with `pnpm test:e2e --grep @batch1-server` once the server lands. Against the current server each fails at the expected step:

- `review-handoff.spec.ts` "Done with no watcher shows Saved for your agent with Copy" (T4.7, including `includePending` watch, ack, and "Picked up"). Today: "Not sent", because the old server returns no `pending`.
- `review-handoff.spec.ts` "a watch aborted by the test leaves the button in the no-agent ready state within 3 s and Done records pending instead of Sent" (T3.4). Today: the watcher still counts after the abort (lifecycle finding 3), which shows the test does reach the server's disconnect handling. It aborts against the API port directly, not through the Vite proxy.
- `review-handoff.spec.ts` "Done with an overall comment and no watcher, then a second Done, leaves one comment in the file" (T8.2). Today: the old server's write changes the version without a `handoff.version`, so the tab returns to ready (see item 1 above).
- `open-file.spec.ts` "the open tab acknowledges an open request so no second window opens". Today: no `acknowledged` field.

## Not done here

- `README.md` and other docs outside `packages/app` still mention the remote mode and the fallback prompt; they belong to the CLI and docs owners.
- `pnpm check` was not run in full because the server package is mid-change on another branch; its app parts (lint, selectors, app tests, app build) were run as listed above. The `@smoke` tests ran on ports 4471 and 4472 instead of the default 4317, as part of the e2e run above.
