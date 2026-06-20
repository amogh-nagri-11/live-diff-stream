import { FiMoon, FiSun } from "react-icons/fi";

import type { Theme } from "../hooks/useTheme";

interface Props {
  theme: Theme;
  onToggle: () => void;
}

/** Icon button that flips between light and dark themes. */
export function ThemeToggle({ theme, onToggle }: Props) {
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      className="icon-button"
      onClick={onToggle}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Light theme" : "Dark theme"}
    >
      {isDark ? <FiSun size={18} /> : <FiMoon size={18} />}
    </button>
  );
}
