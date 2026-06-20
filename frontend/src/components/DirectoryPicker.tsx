import { useEffect, useState } from "react";
import { FiArrowUp, FiCheck, FiFolder, FiX } from "react-icons/fi";

import { browseDir } from "../lib/api";
import type { BrowseResult } from "../types";

interface Props {
  /** Directory to open at; falls back to the server home dir when empty. */
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

/**
 * A modal that walks the server's filesystem so the user can pick a directory
 * to watch. Selection is server-driven because browsers can't read absolute
 * paths from a local file input.
 */
export function DirectoryPicker({ initialPath, onSelect, onClose }: Props) {
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load(path?: string) {
    setLoading(true);
    setError(null);
    try {
      setResult(await browseDir(path));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read directory.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(initialPath || undefined);
    // Load once on open; navigation is driven by clicks afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h3>Choose a directory</h3>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <FiX size={18} />
          </button>
        </header>

        <div className="modal-path" title={result?.path}>
          {result?.path ?? "…"}
        </div>

        <div className="modal-body">
          {error && <p className="auth-error">{error}</p>}
          {loading && <p className="modal-hint">Loading…</p>}

          {!loading && result && (
            <ul className="dir-list">
              {result.parent && (
                <li>
                  <button
                    type="button"
                    className="dir-item"
                    onClick={() => void load(result.parent ?? undefined)}
                  >
                    <FiArrowUp className="dir-icon" size={15} />
                    <span>..</span>
                  </button>
                </li>
              )}
              {result.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="dir-item"
                    onClick={() => void load(entry.path)}
                  >
                    <FiFolder className="dir-icon" size={15} />
                    <span>{entry.name}</span>
                  </button>
                </li>
              ))}
              {result.entries.length === 0 && (
                <li className="modal-hint">No sub-directories here.</li>
              )}
            </ul>
          )}
        </div>

        <footer className="modal-footer">
          <button type="button" className="ghost-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button compact"
            disabled={!result}
            onClick={() => result && onSelect(result.path)}
          >
            <FiCheck size={15} />
            Use this folder
          </button>
        </footer>
      </div>
    </div>
  );
}
