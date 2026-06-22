import { useEffect, useRef, useState } from "react";
import { FiSend } from "react-icons/fi";

import { Avatar } from "./Avatar";
import type { ChatMessage } from "../types";

interface Props {
  messages: ChatMessage[];
  onSend: (text: string) => Promise<void>;
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Real-time room chat: a scrolling message list plus a composer. */
export function ChatPanel({ messages, onSend }: Props) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onSend(text);
      setDraft("");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="chat-panel">
      <div className="chat-messages">
        {messages.length === 0 ? (
          <p className="sidebar-hint">No messages yet. Say hello 👋</p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="chat-message">
              <Avatar
                username={m.author?.username ?? "?"}
                avatarUrl={m.author?.avatarUrl}
                size={22}
              />
              <div className="chat-body">
                <div className="chat-meta">
                  <span className="chat-author">{m.author?.username ?? "unknown"}</span>
                  <span className="chat-time">{timeLabel(m.createdAt)}</span>
                </div>
                <div className="chat-text">{m.body}</div>
              </div>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
      <form className="chat-composer" onSubmit={submit}>
        <input
          type="text"
          placeholder="Message the room…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="icon-button" disabled={!draft.trim() || sending} aria-label="Send">
          <FiSend size={16} />
        </button>
      </form>
    </div>
  );
}
