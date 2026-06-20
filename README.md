# Live Diff Stream

Watch a local directory or a GitHub repository and stream file changes in real time
over WebSockets. The browser UI is laid out like VS Code: a file-tree explorer, a
list of changed files, click-to-view file contents, and a diff view that shows only
the changed hunks.

## Features

- **Live file watching** with [chokidar](https://github.com/paulmillr/chokidar) — adds, changes, and deletes stream to the browser as they happen.
- **Local path or GitHub URL** — point it at a directory on the server, or paste a repo URL and it is shallow-cloned to a temp dir (and cleaned up when the session stops).
- **Browse** the server's filesystem from a modal picker instead of typing a path.
- **VS Code–style UI** — file-tree explorer with git-style change decorations, a changed-files list, whole-file viewer with line numbers, and a hunks-only diff view.
- **Git-aware diffs** via [simple-git](https://github.com/steveukx/git-js), with a `createTwoFilesPatch` snapshot fallback for non-git directories.
- **Auth** — email/password (JWT) plus optional GitHub and Google OAuth login.
- **Light / dark theme** toggle.

## Architecture

| Layer    | Stack                                                            |
| -------- | --------------------------------------------------------------- |
| Backend  | Express HTTP API + `ws` WebSocket server, TypeScript (ESM), `tsx` |
| Storage  | SQLite via `better-sqlite3` (users); diffs are kept in memory   |
| Watcher  | chokidar + simple-git + the `diff` package                      |
| Frontend | React 18 + TypeScript + Vite                                    |

The backend listens on **`:4400`** (override with `PORT`). In development the Vite
dev server runs on **`:5173`** and proxies `/api` → backend HTTP and `/ws` → the
WebSocket server.

WebSocket handshakes are authenticated by passing the JWT as a query parameter;
unauthenticated clients are rejected at the HTTP upgrade.

## Getting started

### Prerequisites

- Node.js 18+ (ESM, `tsx`, native `better-sqlite3` build).

### 1. Backend

```bash
npm install
cp .env.example .env   # then edit JWT_SECRET (required)
npm run dev            # starts on http://localhost:4400
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev            # starts on http://localhost:5173
```

Open <http://localhost:5173>, register an account, then enter a directory path or a
GitHub repo URL (or click **Browse**) and hit **Start watching**.

## Configuration

Copy `.env.example` to `.env`. Only `JWT_SECRET` is required.

| Variable                              | Required | Description                                                              |
| ------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `JWT_SECRET`                          | yes      | Secret used to sign JWTs. Rotating it logs everyone out.                  |
| `JWT_EXPIRES_IN`                      | no       | Token lifetime, e.g. `1h`, `12h`, `7d`.                                   |
| `PORT`                                | no       | Backend port (default `4400`).                                           |
| `PUBLIC_URL`                          | no       | Browser-facing frontend origin; OAuth callbacks route through it (default `http://localhost:5173`). |
| `LDS_DB_PATH`                         | no       | Override the SQLite location (defaults to an OS temp dir).                |
| `GITHUB_CLIENT_ID` / `_SECRET`        | no       | Enables GitHub login when both are set.                                  |
| `GOOGLE_CLIENT_ID` / `_SECRET`        | no       | Enables Google login when both are set.                                  |

OAuth buttons only appear in the UI when the matching credentials are configured.

### GitHub login

Create an OAuth app under **GitHub → Settings → Developer settings → OAuth Apps**:

- **Authorization callback URL:** `http://localhost:5173/api/auth/github/callback`
- Scopes used: `read:user user:email`

### Google login

Create an OAuth client (Web) in **Google Cloud Console → APIs & Services → Credentials**:

- **Authorized redirect URI:** `http://localhost:5173/api/auth/google/callback`

## API

All `/sessions*` routes require an `Authorization: Bearer <token>` header.

| Method   | Route                       | Description                                              |
| -------- | --------------------------- | ------------------------------------------------------- |
| `GET`    | `/health`                   | Liveness check.                                          |
| `POST`   | `/auth/register`            | Create an account, returns a JWT.                        |
| `POST`   | `/auth/login`               | Log in, returns a JWT.                                   |
| `GET`    | `/auth/me`                  | Current user.                                            |
| `GET`    | `/auth/providers`           | Which OAuth providers are configured.                   |
| `GET`    | `/auth/:provider`           | Begin OAuth (`github` / `google`).                       |
| `GET`    | `/auth/:provider/callback`  | OAuth callback.                                          |
| `POST`   | `/sessions`                 | Start watching a local path or GitHub URL (`{ source }`). |
| `GET`    | `/sessions`                 | List active sessions.                                    |
| `GET`    | `/sessions/browse?path=`    | Browse server directories (defaults to home).           |
| `GET`    | `/sessions/:id/tree`        | Full file tree for a session.                            |
| `GET`    | `/sessions/:id/file?path=`  | Read a file's contents (root-scoped, 2 MB cap).         |
| `GET`    | `/sessions/:id/diffs`       | Recent diffs for a session.                              |
| `DELETE` | `/sessions/:id`             | Stop watching and clean up any temp clone.              |

WebSocket: connect to `/ws?token=<jwt>` (proxied by Vite in dev) to receive diff
events as they occur.

## Scripts

**Backend** (`package.json`):

- `npm run dev` — watch mode via `tsx`.
- `npm run build` — compile TypeScript to `dist/`.
- `npm start` — run the compiled server.
- `npm run client` — connect a test WebSocket client.

**Frontend** (`frontend/package.json`):

- `npm run dev` — Vite dev server.
- `npm run build` — type-check and build for production.
- `npm run preview` — preview the production build.

## Security notes

- File reads are scoped to the session root; path traversal is rejected.
- Files larger than 2 MB are not streamed to the browser.
- `node_modules`, `dist`, `.git`, dotfiles, and DB sidecar files are ignored by the watcher and tree.
- Keep `.env` out of version control.

## License

MIT
