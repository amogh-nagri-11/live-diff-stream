/**
 * Manual test client for live-diff-stream.
 *
 * Starts a watch session on a directory (defaults to the current working
 * directory), connects to the streamed diff WebSocket, and pretty-prints every
 * diff it receives. Run it, then edit a file under the watched directory in
 * another terminal to watch diffs stream in.
 *
 *   npx tsx src/test-client.ts [path]
 *
 * Honors BASE_URL (default http://localhost:4400).
 */
import process from "node:process";

import { WebSocket } from "ws";

import type { DiffEntry } from "./types.js";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4400";
const watchPath = process.argv[2] ?? process.cwd();

/** Minimal ANSI color helpers (no dependency needed). */
const color = {
  reset: "\x1b[0m",
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
};

/** Per-event-type label color. */
const eventColor: Record<DiffEntry["event"], (s: string) => string> = {
  add: color.green,
  change: color.yellow,
  unlink: color.red,
};

/** Print a single diff entry with a header and a colorized unified patch. */
function printDiff(entry: DiffEntry): void {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  const tag = eventColor[entry.event](entry.event.toUpperCase().padEnd(6));
  const stats = `${color.green(`+${entry.meta.linesAdded}`)} ${color.red(
    `-${entry.meta.linesRemoved}`,
  )}`;
  const source = entry.meta.isGitTracked
    ? color.cyan(`git:${entry.meta.gitRef}`)
    : color.gray("snapshot");

  console.log(
    `\n${color.dim(time)}  ${tag} ${color.bold(entry.filepath)}  ${stats}  ${source}`,
  );

  for (const line of entry.patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) console.log(color.green(line));
    else if (line.startsWith("-") && !line.startsWith("---")) console.log(color.red(line));
    else if (line.startsWith("@@")) console.log(color.cyan(line));
    else console.log(color.gray(line));
  }
}

async function main(): Promise<void> {
  // 1) Create a watch session for the target directory.
  const res = await fetch(`${BASE_URL}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: watchPath }),
  });
  if (!res.ok) {
    throw new Error(`failed to create session: ${res.status} ${await res.text()}`);
  }
  const { id, rootPath, wsUrl } = (await res.json()) as {
    id: string;
    rootPath: string;
    wsUrl: string;
  };
  console.log(color.bold("watching: ") + rootPath);
  console.log(color.dim(`session ${id}`));

  // 2) Connect to the diff stream.
  const ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    console.log(color.green("connected — edit a file to see diffs stream in...\n"));
  });

  // 3) Log every diff with colored output.
  ws.on("message", (data: Buffer) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "diff") printDiff(msg.entry as DiffEntry);
    else if (msg.type === "connected") {
      /* handshake ack — already logged on open */
    } else console.log(color.yellow(`message: ${JSON.stringify(msg)}`));
  });

  ws.on("error", (err) => console.error(color.red(`ws error: ${err.message}`)));
  ws.on("close", (code, reason) => {
    console.log(color.red(`\nconnection closed (${code}) ${reason.toString()}`));
    process.exit(0);
  });

  // Tidy up the session on Ctrl-C.
  process.on("SIGINT", () => {
    console.log(color.dim("\ncleaning up session..."));
    ws.close();
    void fetch(`${BASE_URL}/sessions/${id}`, { method: "DELETE" }).finally(() =>
      process.exit(0),
    );
  });
}

main().catch((err) => {
  console.error(color.red(String(err)));
  process.exit(1);
});
