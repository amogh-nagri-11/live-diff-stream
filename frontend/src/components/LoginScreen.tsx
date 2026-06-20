import { useEffect, useState } from "react";
import { FiEye, FiEyeOff, FiGithub, FiLock, FiMail, FiUser } from "react-icons/fi";

import { ThemeToggle } from "./ThemeToggle";
import type { Theme } from "../hooks/useTheme";
import {
  fetchProviders,
  signIn,
  signUp,
  startOAuth,
  type Session,
} from "../lib/auth";

interface Props {
  theme: Theme;
  onToggleTheme: () => void;
  onSignedIn: (session: Session) => void;
  initialError?: string | null;
}

type Mode = "login" | "register";

const COPY: Record<Mode, { title: string; cta: string; busy: string; switch: string; prompt: string }> = {
  login: {
    title: "Sign in to monitor your watched directories.",
    cta: "Sign in",
    busy: "Signing in...",
    switch: "Create one",
    prompt: "Don't have an account?",
  },
  register: {
    title: "Create an account to start streaming diffs.",
    cta: "Create account",
    busy: "Creating account...",
    switch: "Sign in",
    prompt: "Already have an account?",
  },
};

export function LoginScreen({ theme, onToggleTheme, onSignedIn, initialError }: Props) {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState({ github: false, google: false });

  const copy = COPY[mode];

  useEffect(() => {
    void fetchProviders().then(setProviders);
  }, []);

  function switchMode() {
    setMode((m) => (m === "login" ? "register" : "login"));
    setError(null);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const session =
        mode === "login"
          ? await signIn(email.trim(), password)
          : await signUp(username.trim(), email.trim(), password);
      onSignedIn(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const hasOAuth = providers.github || providers.google;

  return (
    <div className="auth-shell">
      <div className="auth-topbar">
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>

      <form className="auth-card" onSubmit={handleSubmit}>
        <div className="auth-brand">
          <div>
            <h1 className="auth-title">Live Diff Stream</h1>
            <p className="auth-subtitle">{copy.title}</p>
          </div>
        </div>

        {hasOAuth && (
          <>
            <div className="oauth-row">
              {providers.github && (
                <button
                  type="button"
                  className="oauth-button"
                  onClick={() => startOAuth("github")}
                >
                  <FiGithub size={17} />
                  Continue with GitHub
                </button>
              )}
              {providers.google && (
                <button
                  type="button"
                  className="oauth-button"
                  onClick={() => startOAuth("google")}
                >
                  <FiMail size={17} />
                  Continue with Google
                </button>
              )}
            </div>
            <div className="divider">
              <span>or</span>
            </div>
          </>
        )}

        {mode === "register" && (
          <label className="field">
            <span className="field-label">Username</span>
            <span className="input-wrap">
              <FiUser className="input-icon" size={16} aria-hidden="true" />
              <input
                type="text"
                autoComplete="username"
                placeholder="your.name"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </span>
          </label>
        )}

        <label className="field">
          <span className="field-label">Email</span>
          <span className="input-wrap">
            <FiMail className="input-icon" size={16} aria-hidden="true" />
            <input
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </span>
        </label>

        <label className="field">
          <span className="field-label">Password</span>
          <span className="input-wrap">
            <FiLock className="input-icon" size={16} aria-hidden="true" />
            <input
              type={showPassword ? "text" : "password"}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder={
                mode === "register" ? "At least 8 characters" : "Enter your password"
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              className="reveal-button"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              title={showPassword ? "Hide password" : "Show password"}
              tabIndex={-1}
            >
              {showPassword ? <FiEyeOff size={16} /> : <FiEye size={16} />}
            </button>
          </span>
        </label>

        {error && <p className="auth-error">{error}</p>}

        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? copy.busy : copy.cta}
        </button>

        <p className="auth-hint">
          {copy.prompt}{" "}
          <button type="button" className="link-button" onClick={switchMode}>
            {copy.switch}
          </button>
        </p>
      </form>
    </div>
  );
}
