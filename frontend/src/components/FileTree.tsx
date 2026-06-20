import { useState } from "react";
import { FiChevronDown, FiChevronRight, FiFile, FiFolder } from "react-icons/fi";

import type { DiffEventType, TreeNode } from "../types";

/** Single-letter VS Code-style git decoration for a changed file. */
const CHANGE_BADGE: Record<DiffEventType, string> = {
  add: "A",
  change: "M",
  unlink: "D",
};

interface Props {
  tree: TreeNode[];
  /** Map of changed file path -> the kind of change, for decorations. */
  changed: Map<string, DiffEventType>;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
}

/** The explorer's file tree. Directories expand/collapse; files open on click. */
export function FileTree({ tree, changed, selectedPath, onOpenFile }: Props) {
  return (
    <div className="tree" role="tree">
      {tree.map((node) => (
        <TreeItem
          key={node.path}
          node={node}
          depth={0}
          changed={changed}
          selectedPath={selectedPath}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  );
}

function TreeItem({
  node,
  depth,
  changed,
  selectedPath,
  onOpenFile,
}: {
  node: TreeNode;
  depth: number;
} & Omit<Props, "tree">) {
  // Top two levels start expanded so the structure is visible immediately.
  const [open, setOpen] = useState(depth < 1);
  const indent = { paddingLeft: 8 + depth * 14 };

  if (node.type === "dir") {
    return (
      <>
        <button
          type="button"
          className="tree-row"
          style={indent}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
          <FiFolder className="tree-icon dir" size={14} />
          <span className="tree-name">{node.name}</span>
        </button>
        {open &&
          node.children?.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              changed={changed}
              selectedPath={selectedPath}
              onOpenFile={onOpenFile}
            />
          ))}
      </>
    );
  }

  const change = changed.get(node.path);
  return (
    <button
      type="button"
      className={`tree-row file${selectedPath === node.path ? " selected" : ""}${
        change ? ` changed change-${change}` : ""
      }`}
      style={indent}
      onClick={() => onOpenFile(node.path)}
      title={node.path}
    >
      <span className="tree-spacer" />
      <FiFile className="tree-icon" size={14} />
      <span className="tree-name">{node.name}</span>
      {change && <span className="tree-badge">{CHANGE_BADGE[change]}</span>}
    </button>
  );
}
