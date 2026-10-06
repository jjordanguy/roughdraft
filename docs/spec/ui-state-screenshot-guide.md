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
| Document | Save status: failed | Force save error | `document-save-status` | Icon-only error state; accessible label is `Save failed`. Use backend/API mocking or a component harness. |
| Document | Disk changed | Open local file, modify file externally while browser content is clean | `file-conflict-notice`, `file-conflict-action-reload`, `file-conflict-action-overwrite` | Banner title: `File changed on disk`. |
| Document | Save conflict | Edit in browser, then modify file externally before autosave resolves | `file-conflict-notice`, `file-conflict-action-keep-editing` | Banner title: `Save conflict`; autosave pauses. |
| Document | Autosave paused | Keep editing after conflict | `file-conflict-notice`, `file-conflict-action-overwrite` | Banner title: `Autosave paused`; no keep-editing action. |
| Document | Review handoff ready, agent listening | Open a local file while a watcher is connected | `review-handoff-split-button` (`data-watcher-state="listening"`, `data-handoff-state="ready-listening"`), `review-handoff-button`, `review-handoff-tooltip` | Label `Approve`, or `I'm done` after an edit. Hover tooltip: `Your agent is waiting`. There is no header text for this state. |
| Document | Review handoff ready, no agent | Open a local file with no watcher | `review-handoff-split-button` (`data-watcher-state="none"`, `data-handoff-state="ready-no-agent"`), `review-handoff-button` | The button shows whenever a local file is loaded. Tooltip: `No agent is listening. Roughdraft keeps your Done until it checks in.` |
| Document | Review handoff comment popover | From either ready state, click the handoff dropdown trigger | `review-handoff-comment-trigger`, `review-handoff-comment-popover`, `review-handoff-overall-comment`, `review-handoff-agent-status`, `review-handoff-session-label`, `review-handoff-submit-comment` | Capture the textarea with `Overall comment` placeholder, the agent status line, and `Opened by <label>` when the agent registered a session. Trigger accessible name: `Overall comment options`. |
| Document | Review handoff blocked | Open a local file, then cause a save conflict, a disk change, paused autosave, or a save error | `review-handoff-button`, `review-handoff-blocked-reason`, `review-handoff-tooltip` | Dimmed and disabled. The tooltip and the screen reader text name the reason, for example `Save conflict. Resolve it before you finish.` |
| Document | Review handoff sending | Submit from the comment popover with a slow server | `review-handoff-button`, `review-handoff-status` | Button label `Sending` with a spinner; popover reads `Sending your review` with no robots. Transient; easiest with a delayed route. |
| Document | Review handoff sent | Done while a watcher is connected | `review-handoff-status`, `review-handoff-robots-toy`, `review-handoff-close-window`, `review-handoff-copy-message` | Button `Sent`. Capture the random completion title, robot toy, primary close button, and fallback copy hint below it. |
| Document | Review handoff saved for agent | Done with no watcher (batch 1 server) | `review-handoff-status`, `review-handoff-wake-status`, `review-handoff-message-preview`, `review-handoff-copy-message` | Button `Done, waiting`. Title `Saved for your agent`. Wake line is one of `No wake route registered`, `Waking <session>`, `Sent to <session>`, `Wake failed: <error>`. Copy button reads `Copy message`, then `Copied`. |
| Document | Review handoff picked up | After a saved or sent Done, acknowledge it (`roughdraft pending --ack` or `POST /api/review-events/ack`) | `review-handoff-button`, `review-handoff-status` | Button `Picked up`; popover `Your agent picked this up at <time>.` Appears within one status poll (1.5 s). |
| Document | Review handoff not received | Done against a server without the handoff log (pre-batch-1) | `review-handoff-status`, `review-handoff-copy-message` | Button `Not sent`; title `No agent received this`. Only reachable with an older server. |
| Document | Review handoff error | Force a handoff API error (route the POST to a 500) | `review-handoff-status`, `review-handoff-retry`, `review-handoff-copy-message`, `review-handoff-message-preview` | Button `Not sent`. Title `Done not recorded`; body `Roughdraft could not record your Done. Your saved edits are on disk.` Retry reuses the same handoff id. |
| Editor | Selection menu | Select text in rich editor | `selection-menu` | Capture formatting buttons and comment/suggestion actions. |
| Editor | Selection menu on suggestion | Select existing suggestion text | `selection-menu-action-accept-suggestion`, `selection-menu-action-reject-suggestion` | Requires review fixture. |
| Editor | Link popover | Click a link or choose Link from selection menu | `link-popover`, `link-url-input`, `link-action-open`, `link-action-delete` | Use the plain fixture link. |
| Editor | Context menu | Right-click in rich editor | `editor-context-menu` | Capture comment, suggestion, paste, and paste-markdown actions. |
| Review rail | Comments | Open review fixture in rich mode | `document-review-rail`, `comment-thread-root` | Thread containers use `data-comment-thread-container="true"`. |
| Review rail | Suggestions | Open review fixture in rich mode | `suggestion-thread-s1`, `suggestion-thread-s2`, `suggestion-thread-s3` | Thread containers use `data-suggestion-thread-container="true"`. |
| Review rail | Draft suggestion | Select text and choose a suggestion action | `draft-suggestion-thread`, `draft-suggestion-editor` | Capture dismiss/cancel/apply actions. |
| Comment editor | New root comment draft | Select text and choose Add comment | `comment-rail-c1-editor`, `comment-rail-c1-action-save` | Save uses the popover-style button; footer Cancel is absent because the thread trash action dismisses the draft. |
| Comment editor | Root comment editing | Use a comment card edit action | `comment-rail-root-editor` | Comment test IDs follow `comment-${variant}-${id}-...`. |
| Comment editor | Reply editing | Use a reply action | `comment-rail-child-editor` | Useful for nested thread spacing. |
| Code mode | Review rail present | Open review fixture with `?editor=code` | `page-card-code`, `markdown-code-editor` | Confirms code editor and rail can coexist. |
| Code mode | Review rail absent | Open fenced fixture with `?editor=code` | `page-card-code`, `markdown-code-editor` | Confirms fenced CriticMarkup alone does not create review rail. |
| Error/home fallback | Non-Markdown path | Open URL with `?path=/tmp/file.txt` | homepage error message | Copy: `Roughdraft now opens one .md file at a time.` |
| Error/home fallback | Missing/unloadable path | Open URL with invalid markdown path through local backend | homepage error message | Captures load-error homepage variant. |
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
  
- Save status: saving, failed, and sometimes unsaved
  
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
