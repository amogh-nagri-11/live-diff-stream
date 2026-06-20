import { useEffect, useMemo, useState } from "react";
import {
  FiFile,
  FiFolder,
  FiFolderPlus,
  FiLogOut,
  FiPlay,
  FiSquare,
} from "react-icons/fi";

import { DiffView } from "./DiffView";
import { DirectoryPicker } from "./DirectoryPicker";
import { FileTree } from "./FileTree";
import { FileViewer } from "./FileViewer";
import { ThemeToggle } from "./ThemeToggle";
import { useDiffStream } from "../hooks/useDiffStream";
import type { Theme } from "../hooks/useTheme";
import { createSession, deleteSession, fetchFile, fetchTree } from "../lib/api";
import type {
  CreatedSession,
  DiffEntry,
  DiffEventType,
  FileContent,
  TreeNode,
} from "../types";

interface Props {
  username: string;
  theme: Theme;
  onToggleTheme: () => void;
  onSignOut: () => void;
}

const STATUS_LABEL = {
  connecting: "Connecting",
  open: "Live",
  closed: "Offline",
} as const;

const EVENT_LABEL: Record<DiffEventType, string> = {
  add: "Added",
  change: "Changed",
  unlink: "Removed",
};

/** What the editor pane is currently showing. */
type View =
  | { path: string; mode: "file" }
  | { path: string; mode: "diff" };

export function Dashboard({ username, theme, onToggleTheme, onSignOut }: Props) {
  const [path, setPath] = useState("");
  const [session, setSession] = useState<CreatedSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const { diffs, status } = useDiffStream(session?.id ?? null);

  // The newest diff per file path: drives the changes list and tree badges.
  const { changes, diffByPath, changed } = useMemo(() => {
    const byPath = new Map<string, DiffEntry>();
    for (const d of diffs) if (!byPath.has(d.filepath)) byPath.set(d.filepath, d);
    const badges = new Map<string, DiffEventType>();
    for (const [p, d] of byPath) badges.set(p, d.event);
    return { changes: [...byPath.values()], diffByPath: byPath, changed: badges };
  }, [diffs]);

  // Load the tree when a session starts; clear everything when it stops.
  useEffect(() => {
    if (!session) {
      setTree(null);
      setView(null);
      setFile(null);
      return;
    }
    let cancelled = false;
    void fetchTree(session.id)
      .then((r) => !cancelled && setTree(r.tree))
      .catch(() => !cancelled && setTree([]));
    return () => {
      cancelled = true;
    };
  }, [session]);

  // Refresh the tree when files are added or removed so it stays in sync.
  const latest = diffs[0];
  useEffect(() => {
    if (!session || !latest) return;
    if (latest.event === "add" || latest.event === "unlink") {
      void fetchTree(session.id)
        .then((r) => setTree(r.tree))
        .catch(() => {});
    }
  }, [session, latest?.id, latest?.event]);

  // Fetch file contents whenever a file view is opened (or the open file
  // changes on disk — keyed on its newest diff id).
  const openFileRev =
    view?.mode === "file" ? diffByPath.get(view.path)?.id ?? "" : "";
  useEffect(() => {
    if (!session || view?.mode !== "file") return;
    let cancelled = false;
    setFileLoading(true);
    void fetchFile(session.id, view.path)
      .then((c) => !cancelled && setFile(c))
      .catch(
        () =>
          !cancelled &&
          setFile({ path: view.path, content: "// could not read file" }),
      )
      .finally(() => !cancelled && setFileLoading(false));
    return () => {
      cancelled = true;
    };
  }, [session, view?.mode, view?.path, openFileRev]);

  async function handleStart(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const created = await createSession(path.trim());
      setSession(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start session.");
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    if (!session) return;
    setBusy(true);
    try {
      await deleteSession(session.id);
    } catch {
      // The session may already be gone; clearing locally is enough.
    } finally {
      setSession(null);
      setBusy(false);
    }
  }

  const diffForView =
    view && diffByPath.get(view.path) ? diffByPath.get(view.path)! : null;

  return (
    <div className="ide-shell">
      <header className="app-header">
        <div className="header-brand">
          <span className="header-title">Live Diff Stream</span>
        </div>
        <form className="watch-form" onSubmit={handleStart}>
          <span className="input-wrap grow">
            <FiFolder className="input-icon" size={15} aria-hidden="true" />
            <input
              type="text"
              placeholder="Directory path or GitHub repo URL"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              disabled={!!session}
            />
          </span>
          <button
            type="button"
            className="ghost-button"
            onClick={() => setPicking(true)}
            disabled={!!session || busy}
            title="Browse the server's filesystem"
          >
            <FiFolderPlus size={15} />
            Browse
          </button>
          {session ? (
            <button
              type="button"
              className="danger-button"
              onClick={handleStop}
              disabled={busy}
            >
              <FiSquare size={15} />
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="primary-button compact"
              disabled={busy || !path.trim()}
            >
              <FiPlay size={15} />
              {busy ? "Starting..." : "Start watching"}
            </button>
          )}
        </form>
        <div className="header-actions">
          <span className="header-user">{username}</span>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button
            type="button"
            className="icon-button"
            onClick={onSignOut}
            aria-label="Sign out"
            title="Sign out"
          >
            <FiLogOut size={18} />
          </button>
        </div>
      </header>

      {error && <p className="auth-error toolbar-error">{error}</p>}

      <div className="ide-body">
        <aside className="sidebar">
          <div className="sidebar-section explorer">
            <div className="sidebar-title">
              Explorer
              {session && (
                <span className={`status-dot status-${status}`} title={STATUS_LABEL[status]} />
              )}
            </div>
            <div className="sidebar-scroll">
              {tree && tree.length > 0 ? (
                <FileTree
                  tree={tree}
                  changed={changed}
                  selectedPath={view?.path ?? null}
                  onOpenFile={(p) => setView({ path: p, mode: "file" })}
                />
              ) : (
                <p className="sidebar-hint">
                  {session ? "Empty directory." : "Start watching to load the file tree."}
                </p>
              )}
            </div>
          </div>

          <div className="sidebar-section changes">
            <div className="sidebar-title">
              Changes <span className="title-count">{changes.length}</span>
            </div>
            <div className="sidebar-scroll">
              {changes.length === 0 ? (
                <p className="sidebar-hint">No changes yet.</p>
              ) : (
                <ul className="change-list">
                  {changes.map((d) => (
                    <li key={d.filepath}>
                      <button
                        type="button"
                        className={`change-row change-${d.event}${
                          view?.path === d.filepath && view.mode === "diff"
                            ? " selected"
                            : ""
                        }`}
                        onClick={() => setView({ path: d.filepath, mode: "diff" })}
                        title={d.filepath}
                      >
                        <span className="change-badge">
                          {EVENT_LABEL[d.event][0]}
                        </span>
                        <span className="change-name">
                          {d.filepath.split("/").pop()}
                        </span>
                        <span className="change-stats">
                          <span className="stat-add">+{d.meta.linesAdded}</span>
                          <span className="stat-del">-{d.meta.linesRemoved}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </aside>

        <main className="editor-main">
          {!view ? (
            <EmptyEditor hasSession={!!session} />
          ) : (
            <>
              <div className="editor-tab">
                <FiFile size={14} />
                <span className="editor-path" title={view.path}>
                  {view.path}
                </span>
                {diffForView && (
                  <div className="view-toggle">
                    <button
                      type="button"
                      className={view.mode === "file" ? "active" : ""}
                      onClick={() => setView({ path: view.path, mode: "file" })}
                    >
                      Contents
                    </button>
                    <button
                      type="button"
                      className={view.mode === "diff" ? "active" : ""}
                      onClick={() => setView({ path: view.path, mode: "diff" })}
                    >
                      Changes
                    </button>
                  </div>
                )}
              </div>
              <div className="editor-scroll">
                {view.mode === "diff" && diffForView ? (
                  <DiffView entry={diffForView} />
                ) : fileLoading || !file ? (
                  <div className="viewer-empty">Loading…</div>
                ) : (
                  <FileViewer file={file} />
                )}
              </div>
            </>
          )}
        </main>
      </div>

      {picking && (
        <DirectoryPicker
          initialPath={/^\w+:\/\/|^[^/\s]+@/.test(path.trim()) ? "" : path.trim()}
          onSelect={(selected) => {
            setPath(selected);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

function EmptyEditor({ hasSession }: { hasSession: boolean }) {
  return (
    <div className="editor-empty">
      <h2>{hasSession ? "Select a file" : "No active session"}</h2>
      <p>
        {hasSession
          ? "Open a file from the explorer to view its contents, or pick a changed file to see only what changed."
          : "Enter a directory path or GitHub repo URL above — or Browse — and start watching."}
      </p>
    </div>
  );
}
