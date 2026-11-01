// Operator command: prints a single-use Setup Link that works for 1 hour.
//
//   npm run operator:setup-link -- <label> [--local]
//
// The token is made here and never leaves this machine except inside the
// printed link; D1 receives only its SHA-256. Rerunning for the same label
// cancels that label's older unused link. Runs on Node's built-in type
// stripping, so it imports the shared SQL builder by its .ts path.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { setupLinkLabelError, setupLinkStatements } from "../app/auth/setup-link-sql.ts";

const PRODUCTION_URL = "https://daily-checkin.hurshm05.workers.dev";
const LOCAL_URL = "http://localhost:5173";
const USAGE = "Usage: npm run operator:setup-link -- <label> [--local]";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const local = args.includes("--local");
const positional = args.filter((arg) => arg !== "--local");
if (positional.length !== 1 || positional[0].startsWith("-")) fail(USAGE);

const label = positional[0];
const labelProblem = setupLinkLabelError(label);
if (labelProblem) fail(`Invalid label "${label}". ${labelProblem}`);

const token = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");
const sql = setupLinkStatements({ label, tokenHash, now: new Date() }).join(" ");

// wrangler's own output goes to stderr, so stdout carries only the link.
const result = spawnSync(
  "npx",
  ["wrangler", "d1", "execute", "DB", local ? "--local" : "--remote", "--yes", "--command", sql],
  { stdio: ["ignore", process.stderr, process.stderr] },
);
if (result.error) fail(`Could not run wrangler: ${result.error.message}`);
if (result.status !== 0) fail(`wrangler d1 execute failed (exit ${result.status}); no link was issued.`);

console.log(`${local ? LOCAL_URL : PRODUCTION_URL}/setup/${token}`);
