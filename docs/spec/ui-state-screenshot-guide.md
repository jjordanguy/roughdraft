# Roughdraft UI State Screenshot Guide
This file is a reusable checklist for capturing Roughdraft's major UI states. It is meant to support periodic visual review, not to replace automated tests.
## Screenshot Folder Convention
Put each run in a timestamped directory:

```bash
mkdir -p .context/ui-state-screenshots/$(date +%Y%m%d-%H%M%S)
```

Use filenames that sort by product area, viewport, and state:

```text
01-home-desktop.png
01-home-mobile.png
02-home-install-dialog.png
03-home-workflow-stage-1.png
04-preview-rich-review-rail.png
```
## Starting The App
For route-only states, the Vite app is enough:

```bash
pnpm --filter @roughdraft/app dev -- --host 127.0.0.1 --port 5173
```

Useful URLs:

```text
http://127.0.0.1:5173/
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
| Homepage | Desktop | `/` at desktop viewport | `homepage-workflow-storyboard` | Capture first viewport and a lower scroll position where the storyboard is active. |
| Homepage | Mobile | `/` at mobile viewport | `homepage-workflow-storyboard`, `homepage-workflow-scene-list` | Sticky visual is hidden until the workflow heading has scrolled past. |
| Homepage | Install dialog | Click the install CTA | Base UI dialog content | Include the terminal command and close affordance. |
| Homepage | Workflow stage 1 | Scroll storyboard to first scene | `homepage-workflow-terminal`, `homepage-workflow-scene` | User request visible; agent work and popup are hidden. |
| Homepage | Workflow stage 2 | Scroll to second scene | `homepage-workflow-agent-work` | Agent work becomes visible. |
| Homepage | Workflow stage 3 | Scroll to third scene | `homepage-workflow-terminal-command`, `homepage-workflow-popup` | Roughdraft command and document popup are visible. |
| Homepage | Workflow stage 4 | Scroll to fourth scene | `homepage-workflow-review-rail`, `homepage-workflow-comment-highlight` | User feedback appears in the document/review rail. |
| Homepage | Workflow stage 5 | Scroll to fifth scene | `homepage-workflow-handoff-button` | Done handoff button is visible. |
| Homepage | Workflow stage 6 | Scroll to final scene | `homepage-workflow-agent-resume` | Agent resume line and incorporated plan are visible; done button is hidden. |
| Homepage | Update notice | Start app with backend status returning `updateStatus` | update notice component | Best captured with API mocking unless an update is actually available. |
| RFM guide | Default page | `/roughdraft-flavored-markdown` | `rfm-source-editor` | Capture the source editor plus rendered output. |
| RFM guide | Plan review example | Click `rfm-format-example-plan-review` | `rfm-format-example-plan-review` | Default example if already selected. |
| RFM guide | Spec review example | Click `rfm-format-example-spec-review` | `rfm-format-example-spec-review` | Confirms comments/suggestions render in the embedded demo. |
| RFM guide | Writing edit example | Click `rfm-format-example-writing-edit` | `rfm-format-example-writing-edit` | Useful for prose-focused review states. |
| Preview | Rich text default | `/preview?editor=rich-text` | `page-card-rich-text`, `rich-text-editor` | Uses in-memory preview backend and includes a sample anchored comment. |
| Preview | Code editor default | `/preview?editor=code` | `page-card-code`, `markdown-code-editor` | Capture line wrapping, code editor chrome, and rail behavior. |
| Document | Rich/code toggle | Use `document-editor-view-toggle` | `document-editor-view-toggle` | URL changes to `?editor=code` or `?editor=rich-text`. |
| Document | Editing mode | Open mode menu and choose Editing | `document-mode-trigger` | Normal edit behavior. |
| Document | Suggesting mode | Open mode menu and choose Suggesting | `document-mode-trigger` | Selection actions should create suggestions instead of direct edits. |
| Document | Viewing mode | Open mode menu and choose Viewing | `document-mode-trigger` | Editing controls should look non-editable. |
| Document | Save status: saved | Any clean document after autosave | `document-save-status` | Checkmark should sit fixed in the top-left corner and fade out over 2 seconds; accessible label remains `Saved`. |
| Document | Save status: unsaved | Type in a local document before save completes | `document-save-status` | Spinner-only pending state; accessible label is `Unsaved changes`. Transient; often easier with save throttling or network mocking. |
| Document | Save status: saving | Type and capture during autosave | `document-save-status` | Spinner-only pending state; accessible label is `Saving`. Transient; easiest with mocked delayed save. |
| Document | Save status: failed, retrying | Abort the autosave PUT (route it to fail) or stop the server while typing | `document-save-status`, `sync-status-notice` (`data-sync-state="offline"`), `sync-status-retry` | Icon-only error state; accessible label is `Save failed, retrying`. The neutral banner reads `Roughdraft is not answering` with `Your edits stay in this tab and save when it is back. Trying again in N s.` and a `Retry now` button. Retries after 1, 2, 5, 10, then every 30 s; clears to `Saved` once a retry lands. |
| Document | Disk changed | Type in a local file and, before the 500 ms autosave fires, modify the file externally (a clean tab takes the new text silently) | `file-conflict-notice`, `file-conflict-disk-version`, `file-conflict-action-reload`, `file-conflict-action-overwrite` | Banner title: `File changed on disk`. The version line reads `Disk version from <time> (<short hash>). Overwrite replaces this version.` |
| Document | Save conflict | With the tab channel blocked, modify the file externally, then type (the PUT answers 409) | `file-conflict-notice`, `file-conflict-disk-version`, `file-conflict-action-keep-editing` | Banner title: `Save conflict`; autosave pauses. The version line names the disk version Overwrite will send as `expectedVersion`. |
| Document | Autosave paused | Keep editing after conflict | `file-conflict-notice`, `file-conflict-action-overwrite` | Banner title: `Autosave paused`; no keep-editing action. |
| Document | Autosave paused, file changed again | While paused, modify the file externally again | `file-conflict-later-change`, `file-conflict-disk-version` | The banner body adds `The file changed on disk again while autosave was paused.` and the version line moves to the newest disk version. |
| Document | File unavailable | Move or delete the open file (batch 2 server) | `sync-status-notice` (`data-sync-state="unavailable"`), `document-save-status` | Neutral banner `File not found on disk` (or `File unavailable` with the reason for an unreadable file). Edits stay in the tab; the banner clears by itself when the file is back. Status label `File unavailable`. |
| Document | Review handoff ready, agent listening | Open a local file while a watcher is connected (batch 2 server; the count arrives on the tab channel, there is no status poll) | `review-handoff-split-button` (`data-watcher-state="listening"`, `data-handoff-state="ready-listening"`), `review-handoff-button`, `review-handoff-tooltip` | Label `Approve`, or `I'm done` after an edit. Hover tooltip: `Your agent is waiting`. There is no header text for this state. |
| Document | Review handoff ready, no agent | Open a local file with no watcher | `review-handoff-split-button` (`data-watcher-state="none"`, `data-handoff-state="ready-no-agent"`), `review-handoff-button` | The button shows whenever a local file is loaded. Tooltip: `No agent is listening. Roughdraft keeps your Done until it checks in.` |
| Document | Review handoff comment popover | From either ready state, click the handoff dropdown trigger | `review-handoff-comment-trigger`, `review-handoff-comment-popover`, `review-handoff-overall-comment`, `review-handoff-agent-status`, `review-handoff-session-label`, `review-handoff-submit-comment` | Capture the textarea with `Overall comment` placeholder, the agent status line, and `Opened by <label>` when the agent registered a session. Trigger accessible name: `Overall comment options`. |
| Document | Review handoff blocked | Open a local file, then cause a save conflict, a disk change, paused autosave, or a save error | `review-handoff-button`, `review-handoff-blocked-reason`, `review-handoff-tooltip` | Dimmed and disabled. The tooltip and the screen reader text name the reason, for example `Save conflict. Resolve it before you finish.` |
| Document | Review handoff sending | Submit from the comment popover with a slow server | `review-handoff-button`, `review-handoff-status` | Button label `Sending` with a spinner; popover reads `Sending your review` with no robots. Transient; easiest with a delayed route. |
| Document | Review handoff sent | Done while a watcher is connected | `review-handoff-status`, `review-handoff-robots-toy`, `review-handoff-close-window`, `review-handoff-copy-message` | Button `Sent`. Capture the random completion title, robot toy, primary close button, and fallback copy hint below it. |
| Document | Review handoff saved for agent | Done with no watcher (batch 1 server) | `review-handoff-status`, `review-handoff-wake-status`, `review-handoff-message-preview`, `review-handoff-copy-message` | Button `Done, waiting`. Title `Saved for your agent`. Wake line is one of `No wake route registered`, `Waking <session>`, `Sent to <session>`, `Wake failed: <error>`. Copy button reads `Copy message`, then `Copied`. |
| Document | Review handoff picked up | After a saved or sent Done, acknowledge it (`roughdraft pending --ack` or `POST /api/review-events/ack`) | `review-handoff-button`, `review-handoff-status` | Button `Picked up`; popover `Your agent picked this up at <time>.` Arrives as a `handoff` message on the tab channel (batch 2 server); there is no status poll. |
| Document | Review handoff not received | Done against a server without the handoff log (pre-batch-1) | `review-handoff-status`, `review-handoff-copy-message` | Button `Not sent`; title `No agent received this`. Only reachable with an older server. |
| Document | Review handoff error | Force a handoff API error (route the POST to a 500) | `review-handoff-status`, `review-handoff-retry`, `review-handoff-copy-message`, `review-handoff-message-preview` | Button `Not sent`. Title `Done not recorded`; body `Roughdraft could not record your Done. Your saved edits are on disk.` Retry reuses the same handoff id. |
| Document | Review handoff error, file changed | Modify the file externally with the tab channel blocked, then click Done (the POST answers 409) | `review-handoff-status`, `review-handoff-retry`, `file-conflict-notice` | Body `The file changed on disk before Roughdraft could record your Done. Reload or overwrite it, then retry.` Retry is disabled until the conflict banner is resolved. |
| Document | Review handoff error, no answer | Abort the Done POST (route it to fail) | `review-handoff-status`, `review-handoff-retry` | Body `The Roughdraft server did not answer, so your Done was not recorded. Retry when it is back.` |
| Editor | Selection menu | Select text in rich editor | `selection-menu` | Capture formatting buttons and comment/suggestion actions. |
| Editor | Selection menu on suggestion | Select existing suggestion text | `selection-menu-action-accept-suggestion`, `selection-menu-action-reject-suggestion` | Requires review fixture. |
| Editor | Link popover | Click a link or choose Link from selection menu | `link-popover`, `link-url-input`, `link-action-open`, `link-action-delete` | Use the plain fixture link. |
| Editor | Context menu | Right-click in rich editor | `editor-context-menu` | Capture comment, suggestion, paste, and paste-markdown actions. |
| Review rail | Comments | Open review fixture in rich mode | `document-review-rail`, `comment-thread-root` | Thread containers use `data-comment-thread-container="true"`. |
| Review rail | Suggestions | Open review fixture in rich mode | `suggestion-thread-s1`, `suggestion-thread-s2`, `suggestion-thread-s3` | Thread containers use `data-suggestion-thread-container="true"`. |
| Review rail | Draft suggestion | Select text and choose a suggestion action | `draft-suggestion-thread`, `draft-suggestion-editor` | Capture dismiss/cancel/apply actions. |
| Review rail | Global comments | Open `docs/spec/fixtures/canonical-document-comments.md` in rich mode | `document-comments-section`, `document-comment-thread-a2`, `document-comment-thread-c2`, `comment-rail-a1` | Section titled `Global comments` at the top of the rail, open count beside it, newest first (`a2` above `c2`); the AI reply `a1` is nested under `c2`; the `<br>` breaks in `c2` show as line breaks. Below 1100px the same section renders in `document-comment-fallback-global` above the document. |
| Review rail | Resolved threads folded | Same fixture: `c1` is resolved; for global ones add `status: resolved` to a document comment | `comment-threads-resolved-toggle`, `document-comments-resolved-toggle`, `resolved-comment-thread-c1`, `comment-rail-c1-action-reopen` | One `N resolved` row at the bottom of its section (anchored threads: below the last card; global: bottom of the global section). Expanded cards are muted, show `Resolved: <summary>` and a Reopen action; selecting the highlight of a resolved thread opens the row. |
| Review rail | Comment on a code block | Open `docs/spec/fixtures/canonical-code-block.md` in rich mode | `comment-code-anchor-c1`, `comment-code-anchor-c3`, `comment-thread-c1`, `comment-code-quote-c1` | The fence line carries `{#c1} {#c3}`; the highlighted line ranges come from each entry's `lines`. The card sits beside the range and starts with `Lines 3-4:` and the first quoted line. Nothing inside the code shows review markup. |
| Review rail | Continuation anchors | Open `docs/spec/fixtures/canonical-continuation.md` in rich mode | `comment-thread-c1`, `comment-decoration` | One card for `c1`, placed at the heading; selecting it highlights the heading, the paragraph and the list item. |
| Document | Review block cannot be read | Open `docs/spec/fixtures/probe-R02-duplicate-endmatter-key.md` (or `probe-R13-two-endmatter-blocks.md`) | `review-block-error-notice`, `review-block-error-message`, `review-block-error-action-reload` | Blocking banner above the document: `The review block at the end of this file could not be read: line 13: duplicate key c2` and `Autosave is paused for this file...`. The editor shows the text above the block, read-only; the block never appears as prose and nothing is saved. Reload re-reads the file. |
| Comment editor | New root comment draft | Select text and choose Add comment | `comment-rail-c1-editor`, `comment-rail-c1-action-save` | Save uses the popover-style button; footer Cancel is absent because the thread trash action dismisses the draft. |
| Comment editor | Root comment editing | Use a comment card edit action | `comment-rail-root-editor` | Comment test IDs follow `comment-${variant}-${id}-...`. |
| Comment editor | Reply editing | Use a reply action | `comment-rail-child-editor` | Useful for nested thread spacing. |
| Code mode | Review rail present | Open review fixture with `?editor=code` | `page-card-code`, `markdown-code-editor` | Confirms code editor and rail can coexist. |
| Code mode | Review rail absent | Open fenced fixture with `?editor=code` | `page-card-code`, `markdown-code-editor` | Confirms fenced CriticMarkup alone does not create review rail. |
| Error/home fallback | Non-Markdown path | Open URL with `?path=/tmp/file.txt` | homepage error message | Copy: `Roughdraft now opens one .md file at a time.` |
| Start-up | Load failed | Open a file while `/api/status` or `GET /api/markdown-file` fails (route it to abort or 500) | `startup-error`, `startup-error-message`, `startup-error-retry-status`, `startup-error-retry` | Card reads `Could not load <name>: <what failed>`, for example `Could not load plan.md: The Roughdraft server did not answer (GET /api/markdown-file): Failed to fetch`. Status line `Trying again in N s.` during the 1, 2, 5 s automatic retries, then `Roughdraft stopped retrying on its own.` Replaces the old `Could not open that markdown file.` homepage. |
| Start-up | File not found | Open a `.md` path that does not exist yet | `startup-file-missing`, `startup-file-missing-path` | `File not found at <absolute path>`; the page checks every 5 s and opens the file when it appears. |
## Playwright Capture Skeleton
```ts
import { chromium, devices } from "playwright";

const baseUrl = process.env.ROUGHDRAFT_BASE_URL ?? "http://127.0.0.1:5173";
const outDir = process.env.ROUGHDRAFT_SCREENSHOT_DIR ?? ".context/ui-state-screenshots/manual";

const browser = await chromium.launch();
const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await desktop.goto(`${baseUrl}/`);
await desktop.screenshot({ path: `${outDir}/01-home-desktop.png`, fullPage: true });

const mobile = await browser.newPage({ ...devices["iPhone 13"] });
await mobile.goto(`${baseUrl}/`);
await mobile.screenshot({ path: `${outDir}/01-home-mobile.png`, fullPage: true });

await browser.close();
```

For interaction-heavy states, prefer selectors over coordinates. The current code has stable `data-testid` hooks for the homepage storyboard, editor view toggle, mode trigger, conflict banner/actions, review rail, rich editor, code editor, selection menu, link popover, and context menu.
## States That Need A Harness Or Mocking
These are real product states, but they are awkward to capture deterministically through only public routes:

- Initial loading
  
- Save status: saving, failed and retrying, and sometimes unsaved
  
- File unavailable (move the file away and back)
  
- Start-up error and its automatic retries
  
- Disk conflict and autosave paused
  
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
