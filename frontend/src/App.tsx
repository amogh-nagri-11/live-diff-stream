import { useEffect, useState } from "react";

import { Lobby } from "./components/Lobby";
import { LoginScreen } from "./components/LoginScreen";
import { RoomView } from "./components/RoomView";
import { useTheme } from "./hooks/useTheme";
import { joinRoom } from "./lib/api";
import {
  consumeOAuthRedirect,
  getSession,
  signOut,
  type Session,
} from "./lib/auth";

export default function App() {
  const { theme, toggle } = useTheme();
  const [session, setSession] = useState<Session | null>(() => getSession());
  const [authError, setAuthError] = useState<string | null>(null);
  // Block first render until any OAuth redirect in the URL is processed.
  const [ready, setReady] = useState(false);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);

  useEffect(() => {
    void consumeOAuthRedirect().then((result) => {
      if (result && "session" in result) setSession(result.session);
      else if (result && "error" in result) setAuthError(result.error);
      setReady(true);
    });
  }, []);

  // Once signed in, honour a ?room=&code= share link: join via the code if
  // present, then open the room. Strip the query so a refresh doesn't re-run it.
  useEffect(() => {
    if (!ready || !session) return;
    const params = new URLSearchParams(window.location.search);
    const room = params.get("room");
    const code = params.get("code");
    if (!room && !code) return;
    window.history.replaceState({}, "", window.location.pathname);
    if (code) {
      void joinRoom(code)
        .then((r) => setActiveRoomId(r.id))
        .catch(() => room && setActiveRoomId(room));
    } else if (room) {
      setActiveRoomId(room);
    }
  }, [ready, session]);

  function handleSignOut() {
    signOut();
    setSession(null);
    setActiveRoomId(null);
  }

  if (!ready) return null;

  if (!session) {
    return (
      <LoginScreen
        theme={theme}
        onToggleTheme={toggle}
        onSignedIn={setSession}
        initialError={authError}
      />
    );
  }

  if (activeRoomId) {
    return (
      <RoomView
        roomId={activeRoomId}
        currentUserId={session.user.id}
        username={session.user.username}
        theme={theme}
        onToggleTheme={toggle}
        onSignOut={handleSignOut}
        onBack={() => setActiveRoomId(null)}
      />
    );
  }

  return (
    <Lobby
      username={session.user.username}
      theme={theme}
      onToggleTheme={toggle}
      onSignOut={handleSignOut}
      onOpen={setActiveRoomId}
    />
  );
}
