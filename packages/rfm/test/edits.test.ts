import { describe, expect, it } from "vitest";
import { diffCleanText } from "../src/edits";

const section = [
  "## 4. Decisions",
  "",
  "**D1. Look after a pick.** Context: the cards collapse to a name. Options: (a) keep that, (b) chips. Recommendation: (a).",
  "",
  "**D2. Converting old values.** Context: old packs do not say which base. Options: (a) convert, (b) leave them. Recommendation: (a).",
  "",
  "**D3. The order page dropdown.** Context: the order page has its own dropdown. Options: (a) keep, (b) remove. Recommendation: (b).",
  "",
  "**D4. Wording of the shop line.** Context: documents need one line. Proposal: method, base, effects.",
  "",
  "## 5. Assumptions to confirm",
  "",
].join("\n");

const rewritten = [
  "## 4. Decisions (Updated round 2)",
  "",
  "**Round 2 update:** D1 and D4 locked (your c1, c4). D2 decided as (b) (your c2). D3 replaced by your ruling (your c3).",
  "",
  "**D1. Look after a pick. Locked:** row 1 collapses to its name with an X; rows 2 and 3 stay as chips.",
  "",
  "**D2. Old values. Decided (b):** old packs keep their old names and only new picks use the new rows.",
  "",
  "**D3. The order page. Decided, your ruling:** the separate section goes; the method is chosen inside the summary.",
  "",
  "**O1. Does Add options also offer the ink base swap?** Recommendation: offer both.",
  "",
  "**D4. Wording of the shop line. Locked:** method first, then base, then effects joined with +.",
  "",
  "## 5. Assumptions (Updated round 2)",
  "",
].join("\n");

const lineAt = (text: string, offset: number) =>
  text.slice(0, offset).split("\n").length;

describe("diffCleanText pairs rewritten paragraphs by content", () => {
  it("keeps each decision on its own hunk when a section is rewritten with paragraphs added", () => {
    const hunks = diffCleanText(section, rewritten);
    const byOldLine = new Map(
      hunks.map((hunk) => [lineAt(section, hunk.start), hunk]),
    );
    // Each D paragraph is replaced by its own rewrite, whole line.
    for (const [line, label] of [
      [3, "D1."],
      [5, "D2."],
      [7, "D3."],
      [9, "D4."],
    ] as const) {
      const hunk = byOldLine.get(line);
      expect(hunk, `hunk for line ${line}`).toBeDefined();
      expect(hunk?.text.startsWith(`**${label}`)).toBe(true);
      expect(
        section.slice(hunk?.start, hunk?.end).startsWith(`**${label}`),
      ).toBe(true);
    }
    // The update paragraph and O1 are insertions of their own (the heading
    // suffix "(Updated round 2)" is an insertion too, inside its own line).
    const insertions = hunks.filter(
      (hunk) => hunk.start === hunk.end && hunk.text.trim().startsWith("**"),
    );
    expect(insertions.map((hunk) => hunk.text.trim().slice(0, 18))).toEqual([
      "**Round 2 update:*",
      "**O1. Does Add opt",
    ]);
    // Nothing pairs a decision with the heading: the heading's own hunk is
    // narrowed to the words that changed in it.
    expect(byOldLine.get(11)?.text).toBe("(Updated round 2)");
  });

  it("never cuts a hunk inside a bold or code run", () => {
    const hunks = diffCleanText(
      "**D1. Look after a pick.** Context: today.\n\nUse `old()` here.\n",
      "**D1. Look after a pick. Locked:** rows stay.\n\nUse `new()` here.\n",
    );
    // The bold hunk runs from the line start (a cut after "pick." would sit
    // inside the bold) to just before the shared final "."; the code hunk
    // widens to its line because the cut would fall inside the backticks.
    expect(hunks.map((hunk) => hunk.text)).toEqual([
      "**D1. Look after a pick. Locked:** rows stay",
      "Use `new()` here.",
    ]);
    // A change inside a single bold word still widens to the line.
    const [bold] = diffCleanText(
      "**Keep this** now.\n",
      "**Keep that** now.\n",
    );
    expect(bold?.text).toBe("**Keep that** now.");
  });

  it("still narrows an ordinary edit to the words that changed", () => {
    expect(
      diffCleanText("We ship on Friday.\n", "We ship on Monday.\n"),
    ).toEqual([{ start: 11, end: 17, text: "Monday" }]);
    expect(diffCleanText("a\n\nb\n", "a\n\nb\n")).toEqual([]);
  });
});
