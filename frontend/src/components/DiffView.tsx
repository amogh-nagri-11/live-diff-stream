import type { DiffEntry } from "../types";

type RowKind = "add" | "del" | "ctx" | "hunk";

interface Row {
  kind: RowKind;
  /** Old-file line number, blank for additions. */
  oldNo: number | null;
  /** New-file line number, blank for deletions. */
  newNo: number | null;
  text: string;
}

/**
 * Parse a unified-diff patch into renderable rows, tracking old/new line
 * numbers from each `@@` hunk header. File/header metadata lines are dropped —
 * we only show the actual changes and their surrounding context.
 */
function parseHunks(patch: string): Row[] {
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;

  for (const line of patch.replace(/\n$/, "").split("\n")) {
    if (line.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      rows.push({ kind: "hunk", oldNo: null, newNo: null, text: line });
      continue;
    }
    // Skip file-level metadata lines produced by both git and createTwoFilesPatch.
    if (
      line.startsWith("Index:") ||
      line.startsWith("===") ||
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("diff ") ||
      line.startsWith("\\ No newline")
    ) {
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
    } else {
      const text = line.startsWith(" ") ? line.slice(1) : line;
      rows.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text });
    }
  }
  return rows;
}

const SIGN: Record<RowKind, string> = { add: "+", del: "-", ctx: " ", hunk: "" };

/** A diff rendered as changed hunks only, with old/new line-number gutters. */
export function DiffView({ entry }: { entry: DiffEntry }) {
  const rows = parseHunks(entry.patch);
  return (
    <pre className="code-view diff">
      {rows.map((row, i) => (
        <span key={i} className={`code-line dl-${row.kind}`}>
          <span className="code-gutter">{row.oldNo ?? ""}</span>
          <span className="code-gutter">{row.newNo ?? ""}</span>
          <span className="code-sign">{SIGN[row.kind]}</span>
          <span className="code-text">{row.text || " "}</span>
        </span>
      ))}
    </pre>
  );
}
