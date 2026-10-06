import { validateRoughdraftMarkdown } from "@roughdraft/rfm";
import { describe, expect, it } from "vitest";
import {
  describeDiskChange,
  findRemovedText,
  recordSavedText,
  restoreRemovedText,
  SAVED_TEXT_WINDOW_MS,
} from "./disk-changes";

const entry = (id: string, extra = "") =>
  `  ${id}:\n    body: "Text."\n    by: user\n    at: "2026-01-01T00:00:00.000Z"\n${extra}`;

describe("describeDiskChange", () => {
  it("counts replies, new comments and resolutions, and points at the first thread", () => {
    const before = `# Plan\n\nSee {==this==}{#c1} and {==that==}{#c2}.\n\n---\ncomments:\n${entry("c1")}${entry("c2")}`;
    const after = `# Plan\n\nSee {==this==}{#c1} and {==that==}{#c2}.\n\n---\ncomments:\n${entry("c1")}${entry("c2", "    status: resolved\n")}${entry("a1", "    re: c1\n")}${entry("a2", "    re: c2\n")}${entry("a3", "    scope: document\n")}`;

    expect(describeDiskChange(before, after)).toEqual({
      summary: "2 replies added, 1 comment added, 1 comment resolved",
      commentId: "c1",
    });
  });

  it("names one section, or the first and how many more", () => {
    const before = "# Plan\n\n## Rollout\n\nTwo weeks.\n\n## Risks\n\nNone.\n";
    expect(
      describeDiskChange(before, before.replace("Two", "Three")).summary,
    ).toBe("text changed in Rollout");
    expect(
      describeDiskChange(
        before,
        before.replace("Two", "Three").replace("None", "Some"),
      ).summary,
    ).toBe("text changed in Rollout and 1 more section");
    expect(describeDiskChange("Intro.\n", "Intro, longer.\n").summary).toBe(
      "text changed",
    );
    // A removed paragraph belongs to the section it was in, not the next.
    expect(
      describeDiskChange(
        "# Plan\n\n## Rollout\n\nTwo weeks.\n\nGone soon.\n\n## Risks\n\nNone.\n",
        before,
      ).summary,
    ).toBe("text changed in Rollout");
  });
});

describe("text this tab saved", () => {
  it("joins what successive saves typed on one line into one span", () => {
    let runs = recordSavedText([], "# T\n\nIntro.\n", "# T\n\nIntro. My\n", 0);
    runs = recordSavedText(
      runs,
      "# T\n\nIntro. My\n",
      "# T\n\nIntro. My point here.\n",
      1_000,
    );
    expect(runs).toEqual([
      { line: "Intro. My point here.", start: 6, end: 21, savedAt: 1_000 },
    ]);
  });

  it("finds the typed part an outside write removed from a line", () => {
    const base = "# T\n\nIntro. My point here. Outro.\n";
    const runs = recordSavedText([], "# T\n\nIntro. Outro.\n", base, 0);
    const removed = findRemovedText(
      runs,
      base,
      base,
      "# T\n\nIntro. Outro, agent.\n",
      1_000,
    );
    expect(removed).toMatchObject([
      { text: "My point here. ", before: "Intro. ", whole: false },
    ]);
  });

  it("ignores text the agent only moved, and text older than five minutes", () => {
    const base = "# T\n\nMy point about the rollout.\n\nOther.\n";
    const runs = recordSavedText([], "# T\n\nOther.\n", base, 0);
    expect(
      findRemovedText(
        runs,
        base,
        base,
        "# T\n\nOther.\n\nMy point about the rollout.\n",
        1_000,
      ),
    ).toEqual([]);
    expect(
      findRemovedText(
        runs,
        base,
        base,
        "# T\n\nOther.\n",
        SAVED_TEXT_WINDOW_MS,
      ),
    ).toEqual([]);
  });
});

describe("restoreRemovedText", () => {
  it("puts a removed sentence back inside its line as an insertion suggestion", () => {
    const now = "2026-01-02T00:00:00.000Z";
    const restored = restoreRemovedText(
      `# T\n\nIntro. Outro, agent.\n\n---\ncomments:\n${entry("c1")}`,
      {
        text: " My point here.",
        line: "Intro. My point here. Outro.",
        before: "Intro.",
        after: " Outro.",
        previousLine: "# T",
        nextLine: null,
        whole: false,
      },
      now,
    );
    expect(restored).toBe(
      `# T\n\nIntro. {++My point here.++}{#s1} Outro, agent.\n\n---\ncomments:\n${entry("c1")}suggestions:\n  s1:\n    by: user\n    at: "${now}"\n`,
    );
    expect(validateRoughdraftMarkdown(restored).ok).toBe(true);
  });

  it("puts a removed list item back with its marker outside the suggestion", () => {
    const restored = restoreRemovedText(
      "# T\n\n- one\n",
      {
        text: "- my item",
        line: "- my item",
        before: "",
        after: "",
        previousLine: "- one",
        nextLine: null,
        whole: true,
      },
      "2026-01-02T00:00:00.000Z",
    );
    expect(restored).toContain("- one\n\n- {++my item++}{#s1}\n");
    expect(validateRoughdraftMarkdown(restored).summary.suggestions).toBe(1);
  });

  it("puts text back plain in an older-format file", () => {
    const legacy =
      '# T\n\nSee {==this==}{>>Old inline body.<<}{id="c1" by="user"}.\n\nOutro.\n';
    const restored = restoreRemovedText(
      legacy,
      {
        text: "My paragraph.",
        line: "My paragraph.",
        before: "",
        after: "",
        previousLine: null,
        nextLine: "Outro.",
        whole: true,
      },
      "2026-01-02T00:00:00.000Z",
    );
    expect(restored).toBe(
      '# T\n\nSee {==this==}{>>Old inline body.<<}{id="c1" by="user"}.\n\nMy paragraph.\n\nOutro.\n',
    );
  });
});
