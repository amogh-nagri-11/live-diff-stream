import { useState } from "react";
import { FiCheck, FiCopy, FiUserPlus, FiX } from "react-icons/fi";

import { Avatar } from "./Avatar";
import { inviteMember, removeMember } from "../lib/api";
import type { RoomDetail } from "../types";

interface Props {
  room: RoomDetail;
  /** Refresh room detail after a membership change. */
  onChanged: () => void;
  onClose: () => void;
}

/** Owner-facing modal: share link/code, invite by username, manage members. */
export function SharePanel({ room, onChanged, onClose }: Props) {
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const shareLink = room.inviteCode
    ? `${window.location.origin}/?room=${room.id}&code=${room.inviteCode}`
    : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Could not copy to clipboard.");
    }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await inviteMember(room.id, username.trim());
      setUsername("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not invite user.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(userId: string) {
    try {
      await removeMember(room.id, userId);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove member.");
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal share-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>Invite reviewers</h3>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <FiX size={18} />
          </button>
        </header>

        <label className="field-label">Share link</label>
        <div className="share-link-row">
          <input type="text" readOnly value={shareLink} onFocus={(e) => e.target.select()} />
          <button type="button" className="ghost-button" onClick={copy}>
            {copied ? <FiCheck size={15} /> : <FiCopy size={15} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="lobby-hint">
          Anyone signed in who opens this link joins as a reviewer. Invite code:{" "}
          <code>{room.inviteCode}</code>
        </p>

        <label className="field-label">Invite by username</label>
        <form className="share-link-row" onSubmit={handleInvite}>
          <input
            type="text"
            placeholder="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <button
            type="submit"
            className="primary-button compact"
            disabled={busy || !username.trim()}
          >
            <FiUserPlus size={15} />
            Invite
          </button>
        </form>

        {error && <p className="auth-error">{error}</p>}

        <label className="field-label">Members ({room.members.length})</label>
        <ul className="member-list">
          {room.members.map((m) => (
            <li key={m.id} className="member-row">
              <Avatar username={m.username} avatarUrl={m.avatarUrl} online={m.online} />
              <span className="member-name">{m.username}</span>
              <span className={`role-badge role-${m.role}`}>
                {m.role === "owner" ? "Host" : "Reviewer"}
              </span>
              {m.online && <span className="member-online">online</span>}
              {m.role !== "owner" && (
                <button
                  type="button"
                  className="icon-button danger"
                  onClick={() => handleRemove(m.id)}
                  aria-label={`Remove ${m.username}`}
                  title="Remove member"
                >
                  <FiX size={15} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
