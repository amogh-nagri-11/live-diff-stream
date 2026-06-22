import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FiArrowLeft,
  FiFile,
  FiFolder,
  FiLogOut,
  FiMessageSquare,
  FiPlay,
  FiShare2,
  FiSquare,
} from "react-icons/fi";

import { Avatar } from "./Avatar";
import { ChatPanel } from "./ChatPanel";
import { DiffView } from "./DiffView";
import { DirectoryPicker } from "./DirectoryPicker";
import { FileTree } from "./FileTree";
import { FileViewer } from "./FileViewer";
import { SharePanel } from "./SharePanel";
import { ThemeToggle } from "./ThemeToggle";
import { useRoomStream } from "../hooks/useRoomStream";
import type { Theme } from "../hooks/useTheme";
import {
  fetchComments,
  fetchFile,
  fetchMessages,
  fetchRoom,
  fetchTree,
  postComment,
  postMessage,
  removeMember,
  startWatch,
  stopWatch,
} from "../lib/api";
import type {
  ChatMessage,
  DiffEntry,
  DiffEventType,
  FileComment,
  FileContent,
  RoomDetail,
  TreeNode,
} from "../types";

interface Props {
  roomId: string;
  currentUserId: string;
  username: string;
  theme: Theme;
  onToggleTheme: () => void;
  onSignOut: () => void;
  onBack: () => void;
}

type View = { path: string; mode: "file" | "diff" };

/** Append `item` to `list` unless an entry with the same id is already present. */
function dedupePush<T extends { id: string }>(list: T[], item: T): T[] {
  return list.some((x) => x.id === item.id) ? list : [...list, item];
}

export function RoomView({
  roomId,
  currentUserId,
  username,
  theme,
  onToggleTheme,
  onSignOut,
  onBack,
}: Props) {
  const [room, setRoom] = useState<RoomDetail | null>(null);
  const [source, setSource] = useState("");
  const [picking, setPicking] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tree, setTree] = useState<TreeNode[] | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [comments, setComments] = useState<FileComment[]>([]);

  const isOwner = room?.ownerId === currentUserId;

  // Live stream: diffs, presence, watch state, plus chat/comment fan-out.
  const onChat = useCallback(
    (m: ChatMessage) => setChat((prev) => dedupePush(prev, m)),
    [],
  );
  const onComment = useCallback(
    (c: FileComment) => setComments((prev) => dedupePush(prev, c)),
    [],
  );
  const { diffs, online, live, status } = useRoomStream(roomId, { onChat, onComment });

  const onlineIds = useMemo(() => new Set(online.map((u) => u.userId)), [online]);

  // Newest diff per file path: drives the changes list and tree badges.
  const { changes, diffByPath, changed } = useMemo(() => {
    const byPath = new Map<string, DiffEntry>();
    for (const d of diffs) if (!byPath.has(d.filepath)) byPath.set(d.filepath, d);
    const badges = new Map<string, DiffEventType>();
    for (const [p, d] of byPath) badges.set(p, d.event);
    return { changes: [...byPath.values()], diffByPath: byPath, changed: badges };
  }, [diffs]);

  const refreshRoom = useCallback(() => {
    void fetchRoom(roomId)
      .then(setRoom)
      .catch(() => setError("Could not load this room."));
  }, [roomId]);

  // Load room detail, chat, and comment history on entry.
  useEffect(() => {
    refreshRoom();
    void fetchMessages(roomId).then(setChat).catch(() => {});
    void fetchComments(roomId).then(setComments).catch(() => {});
  }, [roomId, refreshRoom]);

  // Pre-fill the watch source input from the room once loaded.
  useEffect(() => {
    if (room) setSource((s) => s || room.source);
  }, [room]);

  // Load (or clear) the file tree as the watch goes live/idle.
  useEffect(() => {
    if (!live) {
      setTree(null);
      setView(null);
      setFile(null);
      return;
    }
    let cancelled = false;
    void fetchTree(roomId)
      .then((r) => !cancelled && setTree(r.tree))
      .catch(() => !cancelled && setTree([]));
    return () => {
      cancelled = true;
    };
  }, [roomId, live]);

  // Keep the tree in sync as files are added/removed.
  const latest = diffs[0];
  useEffect(() => {
    if (!live || !latest) return;
    if (latest.event === "add" || latest.event === "unlink") {
      void fetchTree(roomId).then((r) => setTree(r.tree)).catch(() => {});
    }
  }, [roomId, live, latest?.id, latest?.event]);

  // Fetch file contents when a file view opens (or it changes on disk).
  const openFileRev = view?.mode === "file" ? diffByPath.get(view.path)?.id ?? "" : "";
  useEffect(() => {
    if (view?.mode !== "file") return;
    let cancelled = false;
    setFileLoading(true);
    void fetchFile(roomId, view.path)
      .then((c) => !cancelled && setFile(c))
      .catch(
        () => !cancelled && setFile({ path: view.path, content: "// could not read file" }),
      )
      .finally(() => !cancelled && setFileLoading(false));
    return () => {
      cancelled = true;
    };
  }, [roomId, view?.mode, view?.path, openFileRev]);

  async function handleStartWatch() {
    setError(null);
    setBusy(true);
    try {
      await startWatch(roomId, source.trim() || undefined);
      // `live` will flip via the socket "watch" message; refresh detail too.
      refreshRoom();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start watching.");
    } finally {
      setBusy(false);
    }
  }

  async function handleStopWatch() {
    setBusy(true);
    try {
      await stopWatch(roomId);
    } catch {
      /* already stopped */
    } finally {
      setBusy(false);
    }
  }

  async function handleLeave() {
    if (!confirm("Leave this room?")) return;
    try {
      await removeMember(roomId, currentUserId);
    } catch {
      /* ignore */
    }
    onBack();
  }

  const diffForView = view ? diffByPath.get(view.path) ?? null : null;
  const fileComments = view
    ? comments.filter((c) => c.filepath === view.path)
    : [];

  // Members with live presence merged in (for the share modal + avatars).
  const roomWithPresence: RoomDetail | null = room && {
    ...room,
    members: room.members.map((m) => ({ ...m, online: onlineIds.has(m.id) })),
  };
  const onlineMembers = roomWithPresence?.members.filter((m) => m.online) ?? [];

  return (
    <div className="ide-shell">
      <header className="app-header">
        <button type="button" className="icon-button" onClick={onBack} aria-label="Back to rooms" title="Back to rooms">
          <FiArrowLeft size={18} />
        </button>
        <div className="header-brand room-brand">
          <span className="header-title">{room?.name ?? "Room"}</span>
          <span className={`status-dot ${live ? "status-open" : "status-closed"}`} title={live ? "Watching" : "Not watching"} />
          {room && (
            <span className={`role-badge role-${isOwner ? "owner" : "reviewer"}`}>
              {isOwner ? "Host" : "Reviewer"}
            </span>
          )}
        </div>

        {isOwner &&
          (live ? (
            <button type="button" className="danger-button" onClick={handleStopWatch} disabled={busy}>
              <FiSquare size={15} />
              Stop
            </button>
          ) : (
            <div className="watch-form inline">
              <span className="input-wrap grow">
                <button
                  type="button"
                  className="input-icon-button"
                  onClick={() => setPicking(true)}
                  title="Browse the server's filesystem"
                  aria-label="Browse for a folder"
                >
                  <FiFolder size={15} />
                </button>
                <input
                  type="text"
                  placeholder="Directory path or GitHub repo URL"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                />
              </span>
              <button
                type="button"
                className="primary-button compact"
                onClick={handleStartWatch}
                disabled={busy || !source.trim()}
              >
                <FiPlay size={15} />
                {busy ? "Starting…" : "Start watching"}
              </button>
            </div>
          ))}

        <div className="header-actions">
          <div className="presence-stack" title={`${onlineMembers.length} online`}>
            {onlineMembers.slice(0, 5).map((m) => (
              <Avatar key={m.id} username={m.username} avatarUrl={m.avatarUrl} online size={26} />
            ))}
          </div>
          {isOwner && (
            <button type="button" className="ghost-button" onClick={() => setSharing(true)}>
              <FiShare2 size={15} />
              Share
            </button>
          )}
          {!isOwner && room && (
            <button type="button" className="ghost-button" onClick={handleLeave}>
              Leave
            </button>
          )}
          <span className="header-user">{username}</span>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button type="button" className="icon-button" onClick={onSignOut} aria-label="Sign out" title="Sign out">
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
              <span className={`status-dot status-${status}`} title={status} />
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
                  {live ? "Empty directory." : "The host isn't watching right now."}
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
                          view?.path === d.filepath && view.mode === "diff" ? " selected" : ""
                        }`}
                        onClick={() => setView({ path: d.filepath, mode: "diff" })}
                        title={d.filepath}
                      >
                        <span className="change-badge">{d.event[0].toUpperCase()}</span>
                        <span className="change-name">{d.filepath.split("/").pop()}</span>
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
            <div className="editor-empty">
              <h2>{live ? "Select a file" : "Waiting for the host"}</h2>
              <p>
                {live
                  ? "Open a file from the explorer to view its contents, or pick a changed file to see only what changed."
                  : isOwner
                    ? "Start watching to share your file tree and live changes with reviewers."
                    : "The host hasn't started watching yet. You'll see files and changes here as soon as they do."}
              </p>
            </div>
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
              <CommentsThread
                comments={fileComments}
                onAdd={(text) => postComment(roomId, view.path, text).then(() => {})}
              />
            </>
          )}
        </main>

        <aside className="chat-sidebar">
          <div className="sidebar-title">
            <FiMessageSquare size={13} /> Chat
          </div>
          <ChatPanel
            messages={chat}
            onSend={(text) => postMessage(roomId, text).then(() => {})}
          />
        </aside>
      </div>

      {picking && (
        <DirectoryPicker
          initialPath={/^\w+:\/\/|^[^/\s]+@/.test(source.trim()) ? "" : source.trim()}
          onSelect={(selected) => {
            setSource(selected);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}

      {sharing && roomWithPresence && (
        <SharePanel room={roomWithPresence} onChanged={refreshRoom} onClose={() => setSharing(false)} />
      )}
    </div>
  );
}

/** Comment thread shown beneath the open file. */
function CommentsThread({
  comments,
  onAdd,
}: {
  comments: FileComment[];
  onAdd: (text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await onAdd(text);
      setDraft("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="comments-thread">
      <div className="comments-title">Comments ({comments.length})</div>
      {comments.map((c) => (
        <div key={c.id} className="comment-row">
          <Avatar username={c.author?.username ?? "?"} avatarUrl={c.author?.avatarUrl} size={20} />
          <div className="comment-body">
            <span className="comment-author">{c.author?.username ?? "unknown"}</span>
            <span className="comment-text">{c.body}</span>
          </div>
        </div>
      ))}
      <form className="comment-composer" onSubmit={submit}>
        <input
          type="text"
          placeholder="Comment on this file…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="ghost-button compact" disabled={!draft.trim() || busy}>
          Comment
        </button>
      </form>
    </div>
  );
}
