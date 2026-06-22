import { useEffect, useState } from "react";
import {
  FiFolder,
  FiLogOut,
  FiPlus,
  FiTrash2,
  FiUsers,
} from "react-icons/fi";

import { DirectoryPicker } from "./DirectoryPicker";
import { ThemeToggle } from "./ThemeToggle";
import type { Theme } from "../hooks/useTheme";
import {
  createRoom,
  deleteRoom,
  joinRoom,
  listRooms,
} from "../lib/api";
import type { RoomSummary } from "../types";

interface Props {
  username: string;
  theme: Theme;
  onToggleTheme: () => void;
  onSignOut: () => void;
  onOpen: (roomId: string) => void;
}

export function Lobby({ username, theme, onToggleTheme, onSignOut, onOpen }: Props) {
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [code, setCode] = useState("");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setRooms(await listRooms());
    } catch {
      setRooms([]);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const room = await createRoom(source.trim(), name.trim() || undefined);
      onOpen(room.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create room.");
    } finally {
      setBusy(false);
    }
  }

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const room = await joinRoom(code.trim());
      onOpen(room.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join room.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(roomId: string) {
    if (!confirm("Delete this room for everyone? This cannot be undone.")) return;
    try {
      await deleteRoom(roomId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete room.");
    }
  }

  return (
    <div className="lobby-shell">
      <header className="app-header">
        <div className="header-brand">
          <span className="header-title">Live Diff Stream</span>
        </div>
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

      <main className="lobby-main">
        <div className="lobby-grid">
          <section className="lobby-card">
            <h2>Create a room</h2>
            <p className="lobby-hint">
              Watch a local directory or git repo and invite reviewers to follow
              your changes live.
            </p>
            <form className="lobby-form" onSubmit={handleCreate}>
              <input
                type="text"
                placeholder="Room name (optional)"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <span className="input-wrap">
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
                type="submit"
                className="primary-button"
                disabled={busy || !source.trim()}
              >
                <FiPlus size={16} />
                {busy ? "Creating…" : "Create room"}
              </button>
            </form>
          </section>

          <section className="lobby-card">
            <h2>Join a room</h2>
            <p className="lobby-hint">
              Got an invite code or link from a host? Enter the code to join as a
              reviewer.
            </p>
            <form className="lobby-form" onSubmit={handleJoin}>
              <input
                type="text"
                placeholder="Invite code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <button
                type="submit"
                className="ghost-button"
                disabled={busy || !code.trim()}
              >
                <FiUsers size={15} />
                Join room
              </button>
            </form>
          </section>
        </div>

        {error && <p className="auth-error lobby-error">{error}</p>}

        <section className="lobby-rooms">
          <h2>Your rooms</h2>
          {rooms === null ? (
            <p className="lobby-hint">Loading…</p>
          ) : rooms.length === 0 ? (
            <p className="lobby-hint">No rooms yet — create one above.</p>
          ) : (
            <ul className="room-list">
              {rooms.map((r) => (
                <li key={r.id} className="room-row">
                  <button
                    type="button"
                    className="room-open"
                    onClick={() => onOpen(r.id)}
                  >
                    <span className={`status-dot ${r.live ? "status-open" : "status-closed"}`} />
                    <span className="room-name">{r.name}</span>
                    <span className="room-source" title={r.source}>
                      {r.source}
                    </span>
                    <span className={`role-badge role-${r.role}`}>
                      {r.role === "owner" ? "Host" : "Reviewer"}
                    </span>
                    <span className="room-members">
                      <FiUsers size={13} /> {r.memberCount}
                    </span>
                  </button>
                  {r.role === "owner" && (
                    <button
                      type="button"
                      className="icon-button danger"
                      onClick={() => handleDelete(r.id)}
                      aria-label="Delete room"
                      title="Delete room"
                    >
                      <FiTrash2 size={16} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

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
    </div>
  );
}
