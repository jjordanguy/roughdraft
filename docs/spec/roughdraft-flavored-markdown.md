# Roughdraft Flavored Markdown 0.2

Status: Draft

Roughdraft Flavored Markdown is regular Markdown plus a portable review layer based on CriticMarkup. Its purpose is to let people and coding agents exchange comments, threaded replies, and pending changes inside the Markdown file itself.

The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" in this document are to be interpreted as described in RFC 2119.

## Scope

This specification defines the review markup that Roughdraft reads and writes. It does not define a replacement for Markdown, a hosted document format, a sync protocol, or a project database.

A conforming document is a Markdown document that may contain Roughdraft review spans. Markdown parsing SHOULD follow CommonMark with GitHub Flavored Markdown extensions. Implementations MAY preserve YAML frontmatter as document metadata. Roughdraft review state lives in the same Markdown file, either as inline review anchors or as final YAML endmatter.

## Canonical Review Format

This section describes the shape writers MUST produce. The prose keeps only markers: a highlight around the selected words with an id ref after it, and suggestion markers. Every comment's text, author, time, replies, status and resolution live in one review block at the end of the file. Readers MUST accept this shape and every legacy form listed under [Legacy Forms](#legacy-forms). The reference implementation is `packages/rfm` (`splitRoughdraftDocument`, `parseReviewModel`, `stringifyRoughdraftEndmatter`).

Example:

````markdown
# Launch plan

The creator confirms {==the caption and the link placement==}{#c1} with ops.

```ts {#c2}
const port = 3000;
start({ port });
```

Add {++one concrete example++}{#s1} to the intro.

---
comments:
  c1:
    body: "Split these checks by owner."
    by: user
    at: "2026-10-04T09:00:00.000Z"
  a1:
    body: "Done: split into creator and ops checks."
    by: AI
    at: "2026-10-04T10:00:00.000Z"
    re: c1
  c2:
    body: "Read the port from the environment."
    by: user
    at: "2026-10-04T09:05:00.000Z"
    lines: [1, 1]
    quote: "const port = 3000;"
  c3:
    body: "Overall this reads well.<br>Shorten the intro."
    by: user
    at: "2026-10-04T09:10:00.000Z"
    scope: document
suggestions:
  s1:
    by: AI
    at: "2026-10-04T09:15:00.000Z"
````

### Layout

1. Optional frontmatter starting at byte 0, then the body, then at most one review block.
2. The review block is a `---` line, written after a blank line, followed by a YAML 1.2 mapping that runs to the end of the file. Its `comments` and `suggestions` keys are maps keyed by id. Other top-level keys belong to the user and MUST be preserved.
3. A final `---` block is review-shaped when its first non-blank line starts at column 0 with `comments:` or `suggestions:`, or when it parses as a mapping with a `comments` or `suggestions` map. `---` lines inside fenced code and the frontmatter are never candidates.
4. A review-shaped block has one of four statuses:
   - `recognized`: it parses and either the body (frontmatter excluded) contains Roughdraft metadata (a compact ref, an attribute block with `id=` after a CriticMarkup close, a legacy `{@...@}` block, or a fence-line ref) or the block holds a document-level comment.
   - `ignored`: it parses but fails that test. It is an ordinary final section of the document and stays part of the body (`endmatter-ignored` warning).
   - `invalid`: it does not parse (`invalid-endmatter-yaml`, with the file line and column), it repeats a key (`duplicate-endmatter-key`), `comments` or `suggestions` is not a map, or the file has two review blocks (`multiple-endmatter-blocks`). Editors MUST NOT rewrite a file whose block is invalid; they keep the block out of the editor and ask for it to be fixed on disk.
   - `absent`: there is no review-shaped block.

### Anchors

- **Prose anchor**: `{==highlighted text==}{#c1}`. No comment text inline. A highlight MAY carry several refs.
- **Continuation anchors**: a comment over several blocks has one prose anchor per block, all with the same id. The first in document order is the primary anchor. Readers show one thread whose highlight covers every anchor.
- **Code block anchor**: the opening fence line carries the ref after the info string, `` ```ts {#c1} ``, one or more refs separated by spaces. The entry records `lines: [start, end]` (1-based, inclusive, counted inside the block) and `quote` (the highlighted lines joined with a newline). Nothing inside the fence is review markup. Inline code keeps a normal prose anchor around the backticks: ``{==`pnpm dev`==}{#c2}``.
- **Standalone comment**: a bare `{#c1}` immediately after the text it follows, with no highlight. It shows as an anchorless card at that spot. A bare ref counts only when its id is a key in the review block or has the Roughdraft id shape (`c`, `a` or `s` followed by digits), so Pandoc heading ids such as `{#intro}` stay plain text.

### Document-level comments

A document-level (global) comment is an entry with `body`, no anchor anywhere in the body and no `re`. Writers add `scope: document` to say so explicitly. An entry with a body and no anchor, `re`, `scope` or `quote`, in a file whose anchored roots keep their text in the review block, is a comment whose highlight was deleted: readers show it with the document-level comments, marked as a lost anchor (`orphan-endmatter-entry` warning). In a legacy file such an entry is an ordinary document-level comment.

### Suggestions

Suggestions keep their inline form, one marker per block: `{++text++}{#s1}`, `{--text--}{#s1}`, `{~~old~>new~~}{#s1}`. A suggestion over several blocks is one marker per block, each with its own id, and every later part's entry carries `continues: <first id>`. Suggestion entries keep `by`, `at`, and optionally `status` and `resolved`. Every `suggestions` entry needs a marker in the text.

### Entries

| Key | Meaning |
| --- | --- |
| `body` | Comment text. A line break is stored as `<br>` and read back as a line break. |
| `by` | Author label. `user` for the person reviewing, `AI` for an agent. |
| `at` | ISO 8601 date-time with `T` and `Z` or an offset. |
| `re` | Parent comment or suggestion id. A non-empty string; any other value is an error (`re-not-string`). |
| `status` | `resolved` or absent. |
| `resolved` | Short resolution summary, `<br>` for line breaks. |
| `scope` | `document` for an explicit document-level comment. |
| `lines` | Code comments: `[start, end]` inside the block. |
| `quote` | Code comments: the highlighted lines joined with a newline. |
| `continues` | Suggestions: the id of the suggestion this part continues. |

Unknown keys MUST be preserved. Replies live only in the review block: an entry with `body`, `by`, `at` and `re`.

### Ids

`cN` for comments of every kind, `sN` for suggestions, `aN` for agent-written replies and notes. Ids are unique across refs, attribute blocks, legacy blocks and every key of both maps.

### Writing the review block

Writers emit the block in one fixed shape, so a file that has not changed is written back byte for byte:

- No line folding: every value stays on one line.
- `body`, `resolved`, `at` and `quote` are always double-quoted, with JSON-style escapes (`\"`, `\\`, `\t`, `\n` in `quote`, `\uXXXX` for characters YAML does not allow raw).
- `by`, `re`, `status`, `scope`, `continues`, ids and other string values are written plain when they match `^[A-Za-z][A-Za-z0-9_-]*$` and are not a YAML 1.1 keyword (`true`, `false`, `yes`, `no`, `on`, `off`, `y`, `n`, `null`, in any case), and double-quoted otherwise.
- Keys in the order `body`, `by`, `at`, `re`, `status`, `resolved`, `scope`, `lines`, `quote`, `continues`, then unknown keys in their existing order. Entries stay in creation order. Sections in the order `comments`, `suggestions`, then other top-level keys.
- Indentation is two spaces per level; `lines` and other lists are written as flow sequences such as `[3, 5]`.

Readers accept any YAML 1.2 string form.

### Legacy Forms

Readers continue to accept, and writers no longer produce:

- Comment trains with the text inline: `{==x==}{>>text<<}{#c1}` and `{>>text<<}{#c1}`, with the entry holding `by` and `at` (`legacy-inline-body` warning).
- Inline attribute blocks, `{id="c1" by="user" at="..."}`, including `re`, `status="resolved"` and unknown attributes.
- Legacy `{@id:c1; by:AI; at:...@}` blocks.
- Replicated trains: the same id and the same text written on several blocks. They read as one comment with several anchors (`replicated-comment` warning). Trains that share an id with different text are a `duplicate-id` error.
- Inline replies after their root, in attribute form. In compact form (`{>>reply<<}{#c2}` whose entry has `re`) they are an error (`inline-reply-not-allowed`).
- Highlights and comments that span several lines in one paragraph. A blank line inside an inline comment is an error (`inline-comment-blank-line`), because Markdown splits it into two paragraphs.
- A highlight with a train on the first block and continuation refs on later blocks.

The sections below describe these forms in detail.

### Doctor diagnostics added for this format

| Code | Severity | Meaning |
| --- | --- | --- |
| `invalid-endmatter-yaml` | error | The review block does not parse or has the wrong shape; the message gives the file line and column. |
| `duplicate-endmatter-key` | error | The review block repeats a key. |
| `multiple-endmatter-blocks` | error | The file has two review blocks. |
| `endmatter-ignored` | warning | A review-shaped block with no review markup in the body and no document-level comment. |
| `orphan-continuation` | error | An anchor ref whose entry has no `body` and no inline text. |
| `continuation-target-not-comment` | error | An anchor ref that names a suggestion. |
| `replicated-comment` | warning | Legacy replicas read as one comment or suggestion. |
| `endmatter-reply-missing-body` | error | An entry with `re` and no `body`. |
| `endmatter-body-not-string` | error | `body` is not text. |
| `endmatter-body-truncated` | error | A plain `body` cut short by ` #`, which YAML reads as a comment. |
| `re-not-string` | error | `re` is empty or not a string. |
| `inline-comment-blank-line` | error | A blank line inside an inline comment. |
| `inline-reply-not-allowed` | error | A reply written in the body. |
| `legacy-inline-body` | warning | Comment text kept inline (once per file). |
| `review-markup-in-code` | warning | A ref or id-carrying train inside fenced code (fence-line refs excepted). |
| `orphan-endmatter-entry` | warning | An entry with no anchor, no body and no `re`, a suggestion entry with no marker, or a lost anchor. |
| `mixed-metadata` | warning | Inline attribute or legacy metadata next to a review block. |
| `missing-reply-target` | warning | `re` names an id that does not exist. |

`summary.comments` counts roots plus document-level comments plus replies. The summary also reports `roots`, `documentComments`, `replies`, `suggestions` and `endmatter` (the block status).

## Canonical Markers

Roughdraft uses these CriticMarkup-compatible markers:

```markdown
{>>comment<<}
{++inserted text++}
{--deleted text--}
{~~old text~>new text~~}
{==highlighted text==}
```

An implementation MUST treat the opening and closing marker pairs as review delimiters outside inline code and fenced code blocks.

Implementations MUST treat review markers inside inline code spans and fenced code blocks as literal example text. They MUST NOT create comments, suggestions, or highlights from those code contexts.

## Comments

A comment is written as:

```ebnf
comment = "{>>" comment-text "<<}" [ metadata ]
```

Comment text is plain inline Markdown content. Comment text MUST NOT contain the literal closing delimiter `<<}` unless the implementation defines an escaping extension. Writers that do not implement escaping MUST reject comment or reply text containing raw CriticMarkup close delimiters instead of emitting ambiguous review markup.

A comment MAY appear by itself when the feedback applies to the surrounding paragraph or document:

```markdown
Add one concrete launch example here.{>>This should come from the customer story.<<}{#c1}

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
```

## Anchored Comments

An anchored comment is a highlight immediately followed by one or more comment blocks:

```ebnf
anchored-comment = highlight 1*comment
highlight        = "{==" anchor-text "==}"
```

Example:

```markdown
Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
```

The highlighted text is the visible anchor. Implementations SHOULD attach all immediately following comment blocks to the same anchor until another token interrupts the sequence.

A standalone highlight is valid CriticMarkup. Roughdraft 0.1 reserves it as review syntax, but standalone highlights are not required to produce a review-thread item unless an implementation explicitly supports highlight-only annotations.

## Suggestions

Suggestions represent pending edits. Implementations MUST NOT silently collapse suggestions into normal prose while reading or writing Roughdraft Flavored Markdown.

### Insertion

```ebnf
addition = "{++" new-text "++}" [ metadata ] *comment
```

```markdown
Add {++one concrete example++}{#s1}.

---
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:05:00.000Z"
```

### Deletion

```ebnf
deletion = "{--" old-text "--}" [ metadata ] *comment
```

```markdown
Remove {--vague phrasing--}{#s2}.

---
suggestions:
  s2:
    by: user
    at: "2026-04-28T12:06:00.000Z"
```

### Substitution

```ebnf
substitution = "{~~" old-text "~>" new-text "~~}" [ metadata ] *comment
```

```markdown
Use {~~rough~>specific~~}{#s3} wording.

---
suggestions:
  s3:
    by: AI
    at: "2026-04-28T12:07:00.000Z"
```

Trailing comment blocks after a suggestion attach discussion to that suggestion:

```markdown
Add {++one concrete example++}{#s1}.

---
comments:
  c2:
    body: Use the launch story.
    by: user
    at: "2026-04-28T12:08:00.000Z"
    re: s1
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:05:00.000Z"
```

## Metadata

Roughdraft's preferred metadata format is a compact inline reference backed by final YAML endmatter:

```ebnf
reference = "{#" id "}"
id        = ALPHA *( ALPHA / DIGIT / "_" / "-" )
```

```markdown
Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
```

Root comment bodies and suggestion text stay inline so their anchors remain portable. Replies live entirely in endmatter because their `re` field already points at a parent id:

```markdown
Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
  c2:
    body: I can add one from the intro.
    by: AI
    at: "2026-04-28T12:05:00.000Z"
    re: c1
```

Suggested-change metadata lives under `suggestions:`:

```markdown
Add {++one concrete example++}{#s1}.

---
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:05:00.000Z"
```

For compatibility, readers also accept the older inline attribute block written immediately after a comment or suggestion:

```ebnf
metadata  = "{" 1*attribute "}"
attribute = name "=" quoted-value
name      = ALPHA *( ALPHA / DIGIT / "_" / "-" )
```

Attribute values are double-quoted strings. Inside a quoted value, `\"` represents a literal quote and `\\` represents a literal backslash.

Known metadata attributes:

| Attribute | Applies to | Required when writing | Meaning |
| --- | --- | --- | --- |
| `id` | Comments and suggestions | Yes | Stable document-local identifier. |
| `by` | Comments and suggestions | Yes | Author or agent label. `AI` identifies an agent author. |
| `at` | Comments and suggestions | Yes | ISO 8601 timestamp. |
| `re` | Comments | No | Parent comment or suggestion id for threaded replies. |
| `status` | Comments and suggestions | No | Review state. Roughdraft currently writes `resolved` when an item has been addressed. |
| `resolved` | Comments and suggestions | No | Optional short resolution summary for an item whose `status` is `resolved`. |

Example:

```markdown
{>>Needs a source.<<}{#c1}

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
```

Implementations SHOULD generate simple document-local ids. Roughdraft uses `c1`, `c2`, and so on for comments and `s1`, `s2`, and so on for suggestions. Implementations MUST preserve unknown valid attributes or YAML keys when possible, but they MUST NOT require unknown metadata for correct review rendering.

For compatibility, readers MAY accept legacy comment metadata of the form `{@id:c1; by:AI; at:2026-04-28T12:00:00.000Z@}`. Writers SHOULD emit compact references plus YAML endmatter for new review data.

## Threads

Threading is represented by `re`.

```markdown
Review {==this sentence==}{>>Needs a source.<<}{#c1}.

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
  c2:
    body: I can add one from the intro.
    by: AI
    at: "2026-04-28T12:05:00.000Z"
    re: c1
```

A reply whose `re` points to a missing id SHOULD be treated as a top-level comment. A comment MUST NOT be its own parent.

## Parsing And Round Trips

Implementations SHOULD parse Roughdraft review markers as inline review annotations without rewriting unrelated Markdown.

Round trips SHOULD preserve:

- YAML frontmatter delimiters and content.
- Local links and image paths.
- Tables and task lists.
- Inline code and fenced code blocks.
- Raw review marker text inside code contexts.
- Metadata values, including escaped quotes and backslashes.

When importing a valid comment or suggestion without metadata, an implementation MAY synthesize missing `id`, `by`, and `at` values on write.

## Review Interchange JSON

The Markdown file is the normative storage format. For APIs, tests, and integrations, implementations MAY expose a review index JSON document that follows [`roughdraft-flavored-markdown.schema.json`](./roughdraft-flavored-markdown.schema.json).

The review index intentionally does not replace a Markdown AST. It indexes Roughdraft review annotations while leaving block parsing to the Markdown implementation.

Example:

```json
{
  "format": "roughdraft-flavored-markdown",
  "version": "0.1",
  "source": {
    "markdown": "Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.\\n\\n---\\ncomments:\\n  c1:\\n    by: user\\n    at: \"2026-04-28T12:00:00.000Z\"\\n"
  },
  "comments": [
    {
      "id": "c1",
      "body": "Needs a source.",
      "by": "user",
      "at": "2026-04-28T12:00:00.000Z",
      "anchor": {
        "text": "this sentence"
      }
    }
  ],
  "suggestions": []
}
```

Conformance fixtures live in [`fixtures/`](./fixtures/). A parser that claims Roughdraft Flavored Markdown 0.1 support SHOULD pass those examples or document any intentional differences.
