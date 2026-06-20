import type { FileContent } from "../types";

interface Props {
  file: FileContent;
}

/** Read-only whole-file view with line numbers, VS Code editor style. */
export function FileViewer({ file }: Props) {
  if (file.tooLarge || file.content === null) {
    return (
      <div className="viewer-empty">
        File is too large to display
        {file.size ? ` (${(file.size / 1024).toFixed(0)} KB)` : ""}.
      </div>
    );
  }

  const lines = file.content.replace(/\n$/, "").split("\n");
  return (
    <pre className="code-view">
      {lines.map((line, i) => (
        <span key={i} className="code-line">
          <span className="code-gutter">{i + 1}</span>
          <span className="code-text">{line || " "}</span>
        </span>
      ))}
    </pre>
  );
}
