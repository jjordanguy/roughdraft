import { describe, expect, it } from "vitest";
import {
  describeCounts,
  describeStatus,
  documentLink,
  documentPlace,
  documentWindowTitle,
  groupOpenDocuments,
  harnessName,
  type OpenDocument,
  parseOpenDocuments,
} from "./open-documents";
import type { SessionRecord } from "./storage";

function session(label: string, overrides: Partial<SessionRecord> = {}) {
  return {
    harness: "claude-code",
    label,
    link: null,
    sessionId: label.toLowerCase().replace(/\s+/g, "-"),
    routeId: null,
    registeredAt: "2026-10-06T08:00:00.000Z",
    ...overrides,
  } satisfies SessionRecord;
}

function doc(name: string, overrides: Partial<OpenDocument> = {}) {
  return {
    key: `/work/${name}`,
    documentPath: `/Users/jordan/dev/${name}`,
    projectPath: "/Users/jordan/dev",
    relativePath: name,
    title: null,
    tabs: 1,
    tabsDirty: 0,
    session: null,
    lastSession: null,
    sessionState: "unknown",
    closedAt: null,
    sweptAt: null,
    firstSeenAt: "2026-10-06T08:00:00.000Z",
    lastActivityAt: "2026-10-06T08:00:00.000Z",
    lastOpenRequestAt: null,
    latestHandoff: null,
    round: null,
    ...overrides,
  } satisfies OpenDocument;
}

const clock = (iso: string | null) => `t(${iso})`;

describe("groupOpenDocuments", () => {
  it("groups by session, orders by latest activity, puts No session last and closed documents in Earlier", () => {
    const fork = session("Fork Roughdraft");
    const resnick = session("Resnick proposal", {
      harness: "openclaw",
      sessionId: null,
    });
    const list = groupOpenDocuments([
      doc("plan.md", { session: fork, lastActivityAt: "2026-10-06T09:00:00Z" }),
      doc("loose.md", { lastActivityAt: "2026-10-06T11:00:00Z" }),
      doc("proposal.md", {
        session: resnick,
        tabs: 2,
        lastActivityAt: "2026-10-06T10:00:00Z",
      }),
      doc("notes.md", {
        session: fork,
        lastActivityAt: "2026-10-06T10:30:00Z",
      }),
      doc("old.md", { closedAt: "2026-10-06T07:00:00Z", tabs: 1 }),
      doc("older.md", {
        closedAt: "2026-10-05T07:00:00Z",
        sweptAt: "2026-10-06T00:01:00Z",
      }),
    ]);

    expect(
      list.groups.map((group) => [
        group.session?.label ?? "No session",
        group.documents.map((document) => document.relativePath),
      ]),
    ).toEqual([
      ["Fork Roughdraft", ["notes.md", "plan.md"]],
      ["Resnick proposal", ["proposal.md"]],
      ["No session", ["loose.md"]],
    ]);
    expect(list.earlier.map((document) => document.relativePath)).toEqual([
      "old.md",
    ]);
    expect(describeCounts(list)).toBe("2 sessions, 5 windows");
  });
});

describe("describeStatus", () => {
  it("says what a row needs in one line", () => {
    expect(
      describeStatus(
        doc("a.md", {
          tabsDirty: 1,
          tabs: 2,
          sessionState: "ended",
          round: {
            roundId: "r1",
            state: "open",
            openedAt: "",
            updatedAt: null,
            stalledAt: null,
            closedAt: null,
          },
          latestHandoff: {
            handoffId: "h1",
            state: "pending",
            createdAt: "2026-10-06T09:40:00Z",
            ackedAt: null,
            droppedAt: null,
            comments: 3,
          },
        }),
        clock,
      ),
    ).toEqual([
      { text: "unsaved text in a window", tone: "warn" },
      { text: "Done waiting since t(2026-10-06T09:40:00Z)", tone: "warn" },
      { text: "AI editing", tone: "muted" },
      { text: "2 windows", tone: "muted" },
      { text: "session ended", tone: "muted" },
    ]);
    expect(
      describeStatus(
        doc("b.md", {
          latestHandoff: {
            handoffId: "h2",
            state: "acknowledged",
            createdAt: "",
            ackedAt: "2026-10-06T09:50:00Z",
            droppedAt: null,
            comments: 0,
          },
        }),
        clock,
      ).map((part) => part.text),
    ).toEqual(["Done picked up at t(2026-10-06T09:50:00Z)", "1 window"]);
    expect(
      describeStatus(doc("c.md", { closedAt: "x" }), clock).map(
        (part) => part.text,
      ),
    ).toEqual(["no Done yet"]);
  });
});

describe("labels", () => {
  it("names harnesses and places files", () => {
    expect(harnessName("claude-code")).toBe("Claude Code");
    expect(harnessName("codex")).toBe("Codex");
    expect(harnessName("openclaw")).toBe("OpenClaw");
    expect(harnessName("hermes")).toBe("hermes");
    expect(documentPlace("/Users/jordan/dev/roughdraft/.context/plan.md")).toBe(
      "plan.md · ~/dev/roughdraft/.context",
    );
    expect(documentPlace("/srv/docs/plan.md")).toBe("plan.md · /srv/docs");
  });

  it("titles a window with the session when there is one", () => {
    expect(documentWindowTitle("Fork plan", "Fork Roughdraft")).toBe(
      "Fork plan · Fork Roughdraft",
    );
    expect(documentWindowTitle("plan.md", null)).toBe("plan.md");
    expect(documentWindowTitle("plan.md", "  ")).toBe("plan.md");
  });

  it("links a document on the address the page was loaded from", () => {
    expect(documentLink("/tmp/a b.md", "http://100.64.0.2:7373")).toBe(
      "http://100.64.0.2:7373/?path=%2Ftmp%2Fa+b.md",
    );
  });
});

describe("parseOpenDocuments", () => {
  it("keeps well-formed documents and fills what an older server leaves out", () => {
    const [parsed] = parseOpenDocuments({
      documents: [
        {
          key: "/x/plan.md",
          documentPath: "/x/plan.md",
          projectPath: "/x",
          relativePath: "plan.md",
          tabs: 1,
          handoffs: [],
          lastActivityAt: "2026-10-06T08:00:00Z",
        },
        { nonsense: true },
      ],
    });
    expect(parsed).toMatchObject({
      documentPath: "/x/plan.md",
      title: null,
      sessionState: "unknown",
      closedAt: null,
      latestHandoff: null,
      tabsDirty: 0,
    });
    expect(parseOpenDocuments({ documents: "no" })).toEqual([]);
  });
});
