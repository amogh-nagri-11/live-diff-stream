import { useEffect, useRef, useState } from "react";

import { streamUrl } from "../lib/api";
import type { DiffEntry, ServerMessage } from "../types";

export type StreamStatus = "connecting" | "open" | "closed";

/** Most recent diffs first; capped so the list can't grow without bound. */
const MAX_DIFFS = 200;

/**
 * Subscribe to a session's diff stream. Returns the live diff list (newest
 * first) and the connection status. Reconnects are intentionally left to the
 * caller (recreate by changing `sessionId`) to keep the hook predictable.
 */
export function useDiffStream(sessionId: string | null): {
  diffs: DiffEntry[];
  status: StreamStatus;
} {
  const [diffs, setDiffs] = useState<DiffEntry[]>([]);
  const [status, setStatus] = useState<StreamStatus>("closed");
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setDiffs([]);
      setStatus("closed");
      return;
    }

    setDiffs([]);
    setStatus("connecting");
    const socket = new WebSocket(streamUrl(sessionId));
    socketRef.current = socket;

    socket.onopen = () => setStatus("open");
    socket.onclose = () => setStatus("closed");
    socket.onerror = () => setStatus("closed");
    socket.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === "diff") {
        setDiffs((prev) => [msg.entry, ...prev].slice(0, MAX_DIFFS));
      }
    };

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [sessionId]);

  return { diffs, status };
}
