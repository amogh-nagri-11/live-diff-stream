import { useEffect, useRef, useState } from "react";

import { roomStreamUrl } from "../lib/api";
import type {
  ChatMessage,
  DiffEntry,
  FileComment,
  PresenceUser,
  RoomServerMessage,
} from "../types";

export type StreamStatus = "connecting" | "open" | "closed";

/** Most recent diffs first; capped so the list can't grow without bound. */
const MAX_DIFFS = 300;

interface Handlers {
  /** Called for each chat message pushed over the socket. */
  onChat?: (message: ChatMessage) => void;
  /** Called for each comment pushed over the socket. */
  onComment?: (comment: FileComment) => void;
}

/**
 * Subscribe to a room's live stream: diffs, presence, watch state, plus chat
 * and comment events delivered via `handlers`. Reconnects by changing `roomId`.
 */
export function useRoomStream(
  roomId: string | null,
  handlers: Handlers = {},
): {
  diffs: DiffEntry[];
  online: PresenceUser[];
  live: boolean;
  status: StreamStatus;
} {
  const [diffs, setDiffs] = useState<DiffEntry[]>([]);
  const [online, setOnline] = useState<PresenceUser[]>([]);
  const [live, setLive] = useState(false);
  const [status, setStatus] = useState<StreamStatus>("closed");

  // Keep handlers in a ref so changing them doesn't re-open the socket.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!roomId) {
      setDiffs([]);
      setOnline([]);
      setLive(false);
      setStatus("closed");
      return;
    }

    setDiffs([]);
    setOnline([]);
    setStatus("connecting");
    const socket = new WebSocket(roomStreamUrl(roomId));

    socket.onopen = () => setStatus("open");
    socket.onclose = () => setStatus("closed");
    socket.onerror = () => setStatus("closed");
    socket.onmessage = (event) => {
      let msg: RoomServerMessage;
      try {
        msg = JSON.parse(event.data as string) as RoomServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case "diff":
          setDiffs((prev) => [msg.entry, ...prev].slice(0, MAX_DIFFS));
          break;
        case "presence":
          setOnline(msg.online);
          break;
        case "watch":
          setLive(msg.live);
          break;
        case "chat":
          handlersRef.current.onChat?.(msg.message);
          break;
        case "comment":
          handlersRef.current.onComment?.(msg.comment);
          break;
      }
    };

    return () => socket.close();
  }, [roomId]);

  return { diffs, online, live, status };
}
