/**
 * The title a document shows in window titles and the open documents list:
 * the text of its first heading, with review markup and inline Markdown
 * stripped. Null when the file has no heading (callers fall back to the file
 * name). Headings inside fenced code and YAML front matter do not count.
 */
const MAX_TITLE_LENGTH = 120;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?[ \t]*$/;

function stripInline(text: string): string {
  return (
    text
      // Closing sequence of an ATX heading: "# Title ##".
      .replace(/[ \t]+#+[ \t]*$/, "")
      // Review markup: anchors and inline comment bodies go, marked text stays
      // (a substitution keeps its original side).
      .replace(/\{#[^}\s]+\}/g, "")
      .replace(/\{id="[^"]*"[^}]*\}/g, "")
      .replace(/\{>>[\s\S]*?<<\}/g, "")
      .replace(/\{~~([\s\S]*?)~>[\s\S]*?~~\}/g, "$1")
      .replace(/\{==([\s\S]*?)==\}/g, "$1")
      .replace(/\{\+\+([\s\S]*?)\+\+\}/g, "$1")
      .replace(/\{--([\s\S]*?)--\}/g, "$1")
      // Inline Markdown: images and links keep their text, code keeps its
      // content, emphasis markers go.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1")
      .replace(/(^|[^\w])__(.+?)__(?![\w])/g, "$1$2")
      .replace(/(^|[^\w])_(.+?)_(?![\w])/g, "$1$2")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function documentTitleFromMarkdown(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  let index = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex(
      (line, at) => at > 0 && /^(---|\.\.\.)\s*$/.test(line),
    );
    if (end > 0) index = end + 1;
  }
  let fence: string | null = null;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1]?.[0] === fence[0] &&
        (fenceMatch[1]?.length ?? 0) >= fence.length
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1] ?? "```";
      continue;
    }
    const heading = ATX_HEADING.exec(line);
    if (!heading) continue;
    const title = stripInline(heading[1] ?? "");
    if (!title) continue;
    return title.length > MAX_TITLE_LENGTH
      ? `${title.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
      : title;
  }
  return null;
}
