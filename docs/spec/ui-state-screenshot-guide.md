# Roughdraft UI State Screenshot Guide
This file is a reusable checklist for capturing Roughdraft's major UI states. It is meant to support periodic visual review, not to replace automated tests.
## Screenshot Folder Convention
Put each run in a timestamped directory:

```bash
mkdir -p .context/ui-state-screenshots/$(date +%Y%m%d-%H%M%S)
```

Use filenames that sort by product area, viewport, and state:

```text
01-open-documents-desktop.png
01-open-documents-mobile.png
02-open-documents-earlier.png
03-document-closed-from-list.png
04-preview-rich-review-rail.png
```
## Starting The App
For route-only states, the Vite app is enough:

```bash
pnpm --filter @roughdraft/app dev -- --host 127.0.0.1 --port 5173
```

Useful URLs:

```text
http://127.0.0.1:5173/                               (open documents; needs the API server)
http://127.0.0.1:5173/roughdraft-flavored-markdown
http://127.0.0.1:5173/preview
http://127.0.0.1:5173/preview?editor=code
http://127.0.0.1:5173/preview?editor=rich-text
```

For local file backend states, use the worktree-specific CLI wrapper:

```bash
worktree_root="$(git rev-parse --show-toplevel)"
worktree_name="$(basename "$worktree_root")"
roughdraft_cmd="roughdraft-dev-$worktree_name"

command -v "$roughdraft_cmd" >/dev/null || pnpm dev:install-cli
"$roughdraft_cmd" start
"$roughdraft_cmd" open "$worktree_root/.context/ui-state-fixtures/review.md" --print-url --no-open --no-watch
```
## Fixture Documents
Create these under `.context/ui-state-fixtures/` when a capture run needs stable local-file states.
### Plain Document
```markdown
# Plain document
Paragraph with **bold**, [link](https://example.com), `inline code`.

- [ ] Task
- [x] Done

| Area | Status |
| --- | --- |
| Intro | Draft |
```
### Review Document
```markdown
# Review document {==Select this sentence==}{>>Root comment<<}{#root} This sentence includes {++clearer wording++}{#s1}. Replace {~~old phrase~>new phrase~~}{#s2} and remove {--dead text--}{#s3}.

---
comments:
  root:
    by: Nora
    at: "2026-04-28T12:00:00.000Z"
  child:
    body: Nested reply
    by: AI
    at: "2026-04-28T12:01:00.000Z"
    re: root
  c1:
    body: Looks good.
    by: Nora
    at: "2026-04-28T12:03:00.000Z"
    re: s1
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:02:00.000Z"
  s2:
    by: AI
    at: "2026-04-28T12:04:00.000Z"
  s3:
    by: AI
    at: "2026-04-28T12:05:00.000Z"
```
### Fenced CriticMarkup Document
```markdown
# Fenced examples This page should not show a review rail just because examples appear inside code fences. ```text {==example==}{>>comment<<}{#c1} {++inserted++} {--deleted--} {~~old~>new~~} ```
```
## Capture Matrix
| Area | State | How to reach it | Useful selectors | Notes |
| --- | --- | --- | --- | --- |
| App shell | Initial loading | Load any route and capture before backend initialization completes, usually with a route/mock delay | none | Transient; easiest in a mocked route or component harness. |
| Open documents | Desktop | `/` with documents registered under two sessions (`roughdraft open <file> --no-watch --session-label ...`) | `open-documents-page`, `open-documents-count`, `open-documents-group`, `open-documents-harness`, `open-document-row`, `open-document-status` | Header `Open documents` with the `Roughdraft` pill and `Close all finished`; the count `N sessions, M windows`; one bordered group per session (harness tag, session title, `Close session`), rows with the first heading, `file.md · ~/folder`, the state line and Open / Close. Light and dark. |
| Open documents | Mobile | Same at 375 px wide | `open-documents-page`, `open-document-row` | Rows stack the actions under the text; no sideways scroll. |
| Open documents | Empty | `/` on a fresh state dir | `open-documents-empty` | `No open documents. Files you open with roughdraft open show up here.` |
| Open documents | Unsaved text | Type in a document while its saves fail (route the PUT to abort), then open `/` | `open-document-status`, `open-document-close` | State line starts with `unsaved text in a window` (amber dot); Close is disabled. |
| Open documents | Done waiting and Drop | Post a Done with no agent listening, open `/` | `open-document-status`, `open-document-drop` | `Done waiting since <time>` (amber); Drop turns it into `Done dropped` and the button goes. |
| Open documents | Earlier today | Close a document from the list, then open `Earlier today` | `open-documents-earlier-trigger`, `open-documents-earlier`, `open-documents-earlier-row`, `open-documents-reopen` | Collapsed by default: `Earlier today: N documents closed`. Rows show `Closed at <time> · <harness> · <session>`, Reopen (the link) and Drop when a Done still waits. |
| Open documents | Peer link | Start the server with `ROUGHDRAFT_PEER_URL` set | `open-documents-peer-link` | `Open documents on <host>` under the header. |
| Open documents | Server down | Stop the server with the page open | `open-documents-error` | Amber line `Could not reach the Roughdraft server (...)` with Retry; the last list stays. |
| Document | Closed from the list (tab) | Open a file in a tab that has navigated before (history longer than one entry), then Close it from `/` | `closed-from-list` | Full-page card `Closed from the open documents list. You can close this tab.` with an `Open documents` link; the window title starts with `Closed · `. A window Roughdraft or the list opened closes itself instead. |
| Document | File menu: Open documents | Open the file-name menu in the toolbar | `document-file-menu`, `document-file-menu-open-documents` | Below Path, Filename, Markdown and Rich text, after a divider: `Open documents` with `Every open window, by session`. |
| RFM guide | Default page | `/roughdraft-flavored-markdown` | none | The format reference page. |
| Preview | Rich text default | `/preview?editor=rich-text` | `page-card-rich-text`, `rich-text-editor` | Uses in-memory preview backend and includes a sample anchored comment. |
| Preview | Code editor default | `/preview?editor=code` | `page-card-code`, `markdown-code-editor` | Capture line wrapping, code editor chrome, and rail behavior. |
| Document | Rich/code toggle | Use `document-editor-view-toggle` | `document-editor-view-toggle` | URL changes to `?editor=code` or `?editor=rich-text`. |
| Document | Editing mode | Open mode menu and choose Editing | `document-mode-trigger` | Normal edit behavior. |
| Document | Suggesting mode | Open mode menu and choose Suggesting | `document-mode-trigger` | Selection actions should create suggestions instead of direct edits. |
| Document | Viewing mode | Open mode menu and choose Viewing | `document-mode-trigger` | Editing controls should look non-editable. |
| Document | Save status: saved | Any clean document after autosave | `document-save-status` | Checkmark should sit fixed in the top-left corner and fade out over 2 seconds; accessible label remains `Saved`. |
| Document | Save status: unsaved | Type in a local document before save completes | `document-save-status` | Spinner-only pending state; accessible label is `Unsaved changes`. Transient; often easier with save throttling or network mocking. |
| Document | Save status: saving | Type and capture during autosave | `document-save-status` | Spinner-only pending state; accessible label is `Saving`. Transient; easiest with mocked delayed save. |
| Document | Save status: offline, retrying | Abort the autosave PUT (route it to fail) or stop the server while typing | `document-save-status`, `sync-status-notice` (`data-sync-state="offline"`), `sync-status-retry` | Icon-only error state; accessible label is `Save failed, retrying`. The neutral banner reads `Roughdraft is offline.` with `Your edits are kept in this browser and will save when it is back. Trying again in N s.` and a `Retry now` button. Retries after 1, 2, 5, 10, then every 30 s; clears to `Saved` once a retry lands. |
| Document | Updated from disk (quiet toast) | With the file open, change it from outside (a clean tab), or type in one paragraph while an agent edits another | `sync-toast`, `disk-update-notice`, `disk-update-show`, `sync-notice-dismiss` | A small toast at the bottom center: `Updated from disk: <what changed>` (`1 reply added`, `2 comments resolved`, `text changed in <section>`), `show me` and an X. It goes after 10 s. `show me` scrolls to the changed block with a short blue wash and selects the thread a reply or resolution touched. No banner. When an overlap became a suggestion it adds `; your overlapping edit is kept as a suggestion`. When a round closes with a write, this toast takes over from the `AI editing...` badge. |
| Document | Overlap kept as a suggestion | In rich text (Editing mode), replace a word while an outside write replaces the same word | `disk-update-notice`, the suggestion card in the rail | Disk holds the agent's text with `{~~theirs~>mine~~}{#sN}` and an `sN` entry `by: user`; the suggestion card shows both. No banner. |
| Document | Overlap with disk (resolver banner) | With the tab channel blocked, open a file with a highlight in code view, change the highlighted words outside, then type inside the same highlight (the PUT answers 409 and the merge cannot hold a suggestion there) | `file-conflict-notice`, `file-conflict-hunks`, `file-conflict-hunk-h1`, `file-conflict-hunk-h1-mine`, `file-conflict-hunk-h1-disk`, `file-conflict-hunk-h1-theirs`, `file-conflict-hunk-h1-ours`, `file-conflict-disk-version`, `file-conflict-action-overwrite` | Amber banner `Your edit overlaps a change on disk`, one card per overlap with `Mine` and `On disk`, and its choices: `Keep mine as a suggestion` (first, when the engine offers it), `Use the disk version`, `Use mine`. Overlaps inside review markup, code, frontmatter or a review entry offer only the last two. Typing goes on elsewhere; autosave waits; the draft is kept in IndexedDB. Status label `Overlaps a change on disk`. No `Keep editing with autosave paused`. |
| Document | Overwrite confirmation | From the resolver banner, click `Overwrite the disk file with my draft...` | `overwrite-confirm-dialog`, `overwrite-confirm-diff`, `overwrite-diff-row-removed`, `overwrite-diff-row-added`, `overwrite-confirm-submit`, `overwrite-confirm-cancel` | Dialog `Overwrite the disk file?` with a line diff (minus lines leave the file, plus lines are written) and the disk version it replaces. Confirm sends that version as `expectedVersion`; if disk moved again, nothing is written and the banner shows the newer version. |
| Document | Removed text notice (loud) | Type a paragraph, let it save, then overwrite the file from outside without it within five minutes | `removed-text-notice`, `removed-text-preview`, `removed-text-restore`, `removed-text-dismiss` | Rose banner `An outside write removed text you saved. Restore it?` with the removed text, `Leave it out` and `Restore as a suggestion`. Restore puts the text back as `{++text++}{#sN}` by user and saves. |
| Document | Restored draft | Type with saves failing (route PUT to abort), then reload the page | `sync-toast`, `draft-restored-notice`, `sync-notice-dismiss` | Toast `Restored unsaved edits from your last session`; the draft is back in the editor, merged onto the file as it is now (or in the resolver banner if it overlaps). |
| Document | File unavailable | Move or delete the open file (batch 2 server) | `sync-status-notice` (`data-sync-state="unavailable"`), `sync-status-recreate`, `sync-status-error`, `document-save-status` | Neutral banner `File unavailable: <file> is not on disk` (or the reason for an unreadable file) with `Your edits are kept in this browser and will save when the file is readable again.` It clears by itself when the file is back. For a missing file, `Recreate from my draft` writes the draft back (needs a server that accepts `create` on PUT; an older one shows the reason in `sync-status-error`). Status label `File unavailable`. |
| Document | Review handoff ready, agent listening | Open a local file while a watcher is connected (batch 2 server; the count arrives on the tab channel, there is no status poll) | `review-handoff-split-button` (`data-watcher-state="listening"`, `data-handoff-state="ready-listening"`), `review-handoff-button`, `review-handoff-tooltip` | Label `Approve`, or `I'm done` after an edit. Hover tooltip: `Your agent is waiting`. There is no header text for this state. |
| Document | Review handoff ready, no agent | Open a local file with no watcher | `review-handoff-split-button` (`data-watcher-state="none"`, `data-handoff-state="ready-no-agent"`), `review-handoff-button` | The button shows whenever a local file is loaded. Tooltip: `No agent is listening. Roughdraft keeps your Done until it checks in.` |
| Document | Review handoff status popover | From either ready state, click the handoff dropdown trigger | `review-handoff-status-trigger`, `review-handoff-status`, `review-handoff-agent-status`, `review-handoff-session-label` | Status only (batch 4): the agent status line and `Opened by <label>` when the agent registered a session. No textarea and no `Submit with comment`; a comment for the whole document goes through the Global comment button. Trigger accessible name: `Review status`. |
| Document | Review handoff blocked | Open a local file, then cause an overlap with disk (resolver banner), an unavailable file, or a save error | `review-handoff-button`, `review-handoff-blocked-reason`, `review-handoff-tooltip` | Dimmed and disabled. With overlaps open the button reads `Resolve 1 overlap first` (`Resolve N overlaps first`); the tooltip and the screen reader text name the reason, for example `Resolve 1 overlap first: your edit overlaps a change on disk.` |
| Document | Review handoff sending | Click Done with a slow server | `review-handoff-button`, `review-handoff-status` | Button label `Sending` with a spinner; the status popover opens and reads `Sending your review` with no robots. Transient; easiest with a delayed route. |
| Document | Review handoff sent | Done while a watcher is connected | `review-handoff-status`, `review-handoff-robots-toy`, `review-handoff-close-window`, `review-handoff-copy-message` | Button `Sent`. Capture the random completion title, robot toy, primary close button, and fallback copy hint below it. |
| Document | Review handoff saved for agent | Done with no watcher (batch 1 server) | `review-handoff-status`, `review-handoff-wake-status`, `review-handoff-message-preview`, `review-handoff-copy-message` | Button `Done, waiting`. Title `Saved for your agent`. Wake line is one of `No wake route registered`, `Waking <session>`, `Sent to <session>`, `Wake failed: <error>`. Copy button reads `Copy message`, then `Copied`. |
| Document | Review handoff picked up | After a saved or sent Done, acknowledge it (`roughdraft pending --ack` or `POST /api/review-events/ack`) | `review-handoff-button`, `review-handoff-status` | Button `Picked up`; popover `Your agent picked this up at <time>.` Arrives as a `handoff` message on the tab channel (batch 2 server); there is no status poll. |
| Document | Review handoff not received | Done against a server without the handoff log (pre-batch-1) | `review-handoff-status`, `review-handoff-copy-message` | Button `Not sent`; title `No agent received this`. Only reachable with an older server. |
| Document | Review handoff error | Force a handoff API error (route the POST to a 500) | `review-handoff-status`, `review-handoff-retry`, `review-handoff-copy-message`, `review-handoff-message-preview` | Button `Not sent`. Title `Done not recorded`; body `Roughdraft could not record your Done. Your saved edits are on disk.` Retry reuses the same handoff id. |
| Document | Review handoff error, overlap | With the tab channel blocked, change a highlighted phrase outside, edit the same phrase, then click Done (the flush answers 409 and the merge leaves an overlap) | `review-handoff-status`, `review-handoff-retry`, `file-conflict-notice` | Body `Your edit overlaps a change on disk, so Roughdraft did not record your Done. Choose a version for each overlap, then retry.` Retry is disabled until the banner's overlaps are chosen. A disk change that merges cleanly is saved and Done is sent again with no error. |
| Document | Review handoff error, no answer | Abort the Done POST (route it to fail) | `review-handoff-status`, `review-handoff-retry` | Body `The Roughdraft server did not answer, so your Done was not recorded. Retry when it is back.` |
| Document | Global comment button | Open a local file in Editing or Suggesting mode (rich text or code view) | `global-comment-add`, `document-status-stack` | Outline button `Global comment` with the `MessageSquareText` icon, left of the Done split button, same height. Tooltip `Comment on the whole document`. Hidden in Viewing mode and outside a local file. From code view a click switches to rich text and opens the draft. |
| Document | Done saves an open global draft | Click `global-comment-add`, type, then click Done without Save | `review-handoff-button`, `global-comment-thread-c1` | The draft is written first (`scope: document` entry), the card closes its composer and stays in the global section, then the Done status shows. An empty draft is dropped. |
| Document | AI editing badge | Open a local file, then run `roughdraft round <file>` | `ai-round-badge` (`data-round-state="open"`), `ai-round-elapsed` | Sky badge in the row above the document card, after the file name (no layout shift): Bot icon, `AI editing...` and the elapsed time (`0:42`). The editor stays editable. A quick command (`reply`, `resolve`, `accept`, `reject`, `note`) shows it for the second its write takes. |
| Document | AI round stalled badge | Run `roughdraft round` and wait 30 minutes without `apply` (or start the server with a short `roundStallMs`) | `ai-round-badge` (`data-round-state="stalled"`), `ai-round-badge-dismiss` | Amber badge `AI round stalled` with an X; the X hides it until the next round. After `apply` the badge is gone. |
| Document | Global comment refused on an older file | Open `docs/spec/fixtures/legacy-multiline-span.md` and click `global-comment-add` | `review-format-global-comment-message`, `review-format-notice` | Amber line `Global comments need the current review format. Run roughdraft doctor --fix to convert this file.` No draft opens (the file has no review block to hold it). |
| Editor | Selection menu | Select text in rich editor | `selection-menu` | Capture formatting buttons and comment/suggestion actions. |
| Editor | Selection menu on suggestion | Select existing suggestion text | `selection-menu-action-accept-suggestion`, `selection-menu-action-reject-suggestion` | Requires review fixture. |
| Editor | Link popover | Click a link or choose Link from selection menu | `link-popover`, `link-url-input`, `link-action-open`, `link-action-delete` | Use the plain fixture link. |
| Editor | Context menu | Right-click in rich editor | `editor-context-menu` | Capture comment, suggestion, paste, and paste-markdown actions. |
| Review rail | Comments | Open review fixture in rich mode | `document-review-rail`, `comment-thread-root` | Thread containers use `data-comment-thread-container="true"`. |
| Review rail | Suggestions | Open review fixture in rich mode | `suggestion-thread-s1`, `suggestion-thread-s2`, `suggestion-thread-s3` | Thread containers use `data-suggestion-thread-container="true"`. |
| Review rail | Draft suggestion | Select text and choose a suggestion action | `draft-suggestion-thread`, `draft-suggestion-editor` | Capture dismiss/cancel/apply actions. |
| Review rail | Global comments | Open `docs/spec/fixtures/canonical-document-comments.md` in rich mode | `global-comments-section`, `global-comments-open-count`, `global-comment-thread-a2`, `global-comment-thread-c2`, `comment-rail-a1` | Section titled `Global comments` at the top of the rail, open count badge beside it, newest first (`a2` above `c2`); the AI reply `a1` is nested under `c2`; the `<br>` breaks in `c2` show as line breaks. |
| Review rail | Global comment draft | Open any local file and click `global-comment-add` | `global-comments-section`, `global-comment-thread-c<N>`, `comment-rail-c<N>-editor`, `comment-rail-c<N>-action-save` | Draft card on top of the section, focused, placeholder `Comment on the whole document`, primary Save. Escape or the trash icon discards an empty draft; nothing is written until Save. |
| Review rail | Agent round note | Open a file, then run `roughdraft note <file> "Round 1: ..."` (or `apply` a round with a note) | `global-comment-thread-a<N>` (`data-author="ai"`), `comment-rail-a<N>` | Arrives within a second or two with no reload; AI card with the sky Bot avatar and the author `AI`. Selected, it offers Reply and Resolve like any thread. |
| Review rail | Global comments below 1100px | Same fixture at 900px wide | `global-comments-fallback`, `global-comment-thread-c2`, `comment-banner-<id>-editor` | The section renders above the document card, always visible; a draft opened with `global-comment-add` appears there with `comment-banner-` ids. |
| Review rail | Resolved threads folded | Same fixture: `c1` is resolved; for global ones add `status: resolved` to a document comment, or click Resolve on a global card | `comment-threads-resolved-toggle`, `global-comments-resolved-toggle`, `resolved-comment-thread-c1`, `comment-rail-c1-action-reopen` | One `N resolved` row (shadcn Collapsible) at the bottom of its section (anchored threads: below the last card; global: bottom of the global section). Resolve folds the card away at once. Expanded cards are muted, show `Resolved: <summary>` and a Reopen action; selecting the highlight of a resolved thread opens the row. |
| Review rail | Comment on a code block | Open `docs/spec/fixtures/canonical-code-block.md` in rich mode, then click the `c1` card | `comment-code-anchor-c1`, `comment-code-anchor-c3`, `global-comment-thread-c1`, `comment-code-quote-c1`, `comment-code-lines-c1` | The fence line carries `{#c1} {#c3}`; the highlighted line ranges come from each entry's `lines`. The cards live in the global section (D10): a small code block headed `Lines 3–4` (`Line 1` for `c3`) with the quoted lines, then the comment. Selecting the card highlights its range in the document (`comment-decoration-active`) and scrolls it into view. Nothing inside the code shows review markup. |
| Review rail | Continuation anchors | Open `docs/spec/fixtures/canonical-continuation.md` in rich mode | `comment-thread-c1`, `comment-decoration` | One card for `c1`, placed at the heading; selecting it highlights the heading, the paragraph and the list item. |
| Document | Review block cannot be read | Open `docs/spec/fixtures/probe-R02-duplicate-endmatter-key.md` (or `probe-R13-two-endmatter-blocks.md`) | `review-block-error-notice`, `review-block-error-message`, `review-block-error-action-reload` | Blocking banner above the document: `The review block at the end of this file could not be read: line 13: duplicate key c2` and `Autosave is paused for this file...`. The editor shows the text above the block, read-only; the block never appears as prose and nothing is saved. Reload re-reads the file. |
| Comment editor | New root comment draft | Select text and choose Add comment | `comment-rail-c1-editor`, `comment-rail-c1-action-save` | Save uses the popover-style button; footer Cancel is absent because the thread trash action dismisses the draft. |
| Document | Older review format notice | Open `docs/spec/fixtures/repro-case2-ui-saved.md` (or any fixture whose review markup is an older shape: inline bodies, attribute or `{@...@}` metadata, replicas) | `review-format-notice` | One amber line above the document: `This file uses an older review format. Run roughdraft doctor --fix to convert it.` Saving keeps every byte of the review markup; new comments take the shape the file already uses. Canonical files and files with no review items show nothing. |
| Document | Comment on code refused (older format) | In the same kind of file, select lines inside a fenced code block and choose Add comment | `review-format-code-comment-message` | `Comments on code need the current review format. Run roughdraft doctor --fix to convert this file.` No composer opens for code; a selection that also covers prose comments on the prose part. |
| Comment editor | Close delimiter refused | Select text, choose Add comment, type `Use <<} here.` and Save | `comment-rail-c1-error` (or `comment-banner-c1-error`) | Red line under the composer: `Comments cannot contain "<<}" (it closes review markup). Remove it to save.` The composer stays open and nothing is saved; the line clears once the delimiter is gone. Same for `++}`, `--}`, `~~}`, `==}`. |
| Comment editor | Two-paragraph comment | Select text, choose Add comment, type a line, press Enter twice, type another, Save | `comment-rail-c1-editor`, then `comment-rail-c1` after the save | Enter adds a line break (Cmd/Ctrl+Enter saves). The file stores `<br><br>`; the card shows the two paragraphs. |
| Review rail | New comment on code lines | Open a canonical file (or one with no review items) with a fenced block, select lines inside it and choose Add comment | `comment-code-anchor-c1`, `global-comment-thread-c1` | The composer opens in the global section; the fence line gets `{#c1}`, the entry `lines` and `quote`; the selected lines highlight at once and stay highlighted after a reload. |
| Review rail | Suggestion over two paragraphs | In Suggesting mode select from one paragraph into the next and press Backspace | `suggestion-thread-s1` | One card. The file holds one marker per paragraph (`{#s1}`, `{#s2}` with `continues: s1`); after a reload the parts still show as one suggestion and Accept or Reject settles both. |
| Comment editor | Root comment editing | Use a comment card edit action | `comment-rail-root-editor` | Comment test IDs follow `comment-${variant}-${id}-...`. |
| Comment editor | Reply editing | Use a reply action | `comment-rail-child-editor` | Useful for nested thread spacing. |
| Code mode | Review rail present | Open review fixture with `?editor=code` | `page-card-code`, `markdown-code-editor` | Confirms code editor and rail can coexist. |
| Code mode | Review rail absent | Open fenced fixture with `?editor=code` | `page-card-code`, `markdown-code-editor` | Confirms fenced CriticMarkup alone does not create review rail. |
| Start-up | Non-Markdown path | Open URL with `?path=/tmp/file.txt` | `startup-not-markdown` | Card: `Roughdraft now opens one .md file at a time. /tmp/file.txt is not one.` with an `Open documents` link. |
| Start-up | Load failed | Open a file while `/api/status` or `GET /api/markdown-file` fails (route it to abort or 500) | `startup-error`, `startup-error-message`, `startup-error-retry-status`, `startup-error-retry` | Card reads `Could not load <name>: <what failed>`, for example `Could not load plan.md: The Roughdraft server did not answer (GET /api/markdown-file): Failed to fetch`. Status line `Trying again in N s.` during the 1, 2, 5 s automatic retries, then `Roughdraft stopped retrying on its own.` Replaces the old `Could not open that markdown file.` message. |
| Start-up | File not found | Open a `.md` path that does not exist yet | `startup-file-missing`, `startup-file-missing-path` | `File not found at <absolute path>`; the page checks every 5 s and opens the file when it appears. |
## Playwright Capture Skeleton
```ts
import { chromium, devices } from "playwright";

const baseUrl = process.env.ROUGHDRAFT_BASE_URL ?? "http://127.0.0.1:5173";
const outDir = process.env.ROUGHDRAFT_SCREENSHOT_DIR ?? ".context/ui-state-screenshots/manual";

const browser = await chromium.launch();
const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await desktop.goto(`${baseUrl}/`);
await desktop.screenshot({ path: `${outDir}/01-open-documents-desktop.png`, fullPage: true });

const mobile = await browser.newPage({ ...devices["iPhone 13"] });
await mobile.goto(`${baseUrl}/`);
await mobile.screenshot({ path: `${outDir}/01-open-documents-mobile.png`, fullPage: true });

await browser.close();
```

For interaction-heavy states, prefer selectors over coordinates. The current code has stable `data-testid` hooks for the open documents list, editor view toggle, mode trigger, conflict banner/actions, review rail, rich editor, code editor, selection menu, link popover, and context menu.
## States That Need A Harness Or Mocking
These are real product states, but they are awkward to capture deterministically through only public routes:

- Initial loading
  
- Save status: saving, failed and retrying, and sometimes unsaved
  
- File unavailable (move the file away and back)
  
- Start-up error and its automatic retries
  
- Overlap with disk (resolver banner), the overwrite confirmation, the removed-text notice and the restored-draft toast (the batch 5 e2e in `packages/app/e2e/merge.spec.ts` and `stale-write.spec.ts` drive each one)
  
- Review handoff sending, blocked, picked up, not received, and error
  
- Update notice
  

The most reliable long-term solution is a dedicated screenshot harness route or Playwright component harness that renders `DocumentWorkspace` with controlled backend, disk, watcher, handoff, and save states. Keep the production-route screenshots for broad layout coverage and use the harness for rare operational states.
## Maintenance Checklist
- Add a row when a new route, dialog, popover, banner, editor mode, or empty/error state ships.
  
- Add or update a fixture when a new Markdown/Roughdraft Format feature changes rendering.
  
- Prefer `data-testid` selectors for screenshot automation; add a selector when a state matters visually.
  
- Capture desktop and mobile for page-level states.
  
- Capture both rich-text and code editor for document states that affect the editor surface or review rail.
  
- Keep screenshots in `.context/` unless the run is intentionally being committed as visual documentation.
