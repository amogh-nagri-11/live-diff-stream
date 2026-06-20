import { useEffect, useState } from "react";

import { Dashboard } from "./components/Dashboard";
import { LoginScreen } from "./components/LoginScreen";
import { useTheme } from "./hooks/useTheme";
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

  useEffect(() => {
    void consumeOAuthRedirect().then((result) => {
      if (result && "session" in result) setSession(result.session);
      else if (result && "error" in result) setAuthError(result.error);
      setReady(true);
    });
  }, []);

  function handleSignOut() {
    signOut();
    setSession(null);
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

  return (
    <Dashboard
      username={session.user.username}
      theme={theme}
      onToggleTheme={toggle}
      onSignOut={handleSignOut}
    />
  );
}
