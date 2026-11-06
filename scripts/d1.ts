// Shared by the Operator commands: how a command stops with a message, and
// how it runs SQL against D1 with `wrangler d1 execute`.

import { spawnSync } from "node:child_process";

/** Prints the message to stderr and ends the command with exit code 1. */
export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * Runs SQL against the local or remote D1 database. With `json`, wrangler's
 * JSON answer is returned; without it, wrangler's output goes to stderr too,
 * so the command's stdout carries only what the command prints. When wrangler
 * fails, the command stops, and the message ends with `failure`, which says
 * what that means for this command.
 */
export function execute(sql: string, options: { local: boolean; json: boolean; failure: string }): string {
  const { local, json, failure } = options;
  const result = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", "DB", local ? "--local" : "--remote", "--yes", ...(json ? ["--json"] : []), "--command", sql],
    { stdio: ["ignore", json ? "pipe" : process.stderr, process.stderr], encoding: "utf8" },
  );
  if (result.error) fail(`Could not run wrangler: ${result.error.message}`);
  if (result.status !== 0) fail(`wrangler d1 execute failed (exit ${result.status}); ${failure}`);
  return result.stdout ?? "";
}
