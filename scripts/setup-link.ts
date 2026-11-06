// Operator command: prints a single-use Setup Link that works for 1 hour.
//
//   npm run operator:setup-link -- <label> [--local]
//
// The token is made here and never leaves this machine except inside the
// printed link; D1 receives only its SHA-256. Rerunning for the same label
// cancels that label's older unused link. Runs on Node's built-in type
// stripping, so it imports the shared token and SQL modules by their .ts paths.

import { hashToken, randomToken } from "../app/auth/crypto.ts";
import { setupLinkLabelError, setupLinkStatements } from "../app/auth/setup-link-sql.ts";
import { execute, fail } from "./d1.ts";

const PRODUCTION_URL = "https://daily-checkin.gamecheckin.workers.dev";
const LOCAL_URL = "http://localhost:5173";
const USAGE = "Usage: npm run operator:setup-link -- <label> [--local]";

const args = process.argv.slice(2);
const local = args.includes("--local");
const positional = args.filter((arg) => arg !== "--local");
if (positional.length !== 1 || positional[0].startsWith("-")) fail(USAGE);

const label = positional[0];
const labelProblem = setupLinkLabelError(label);
if (labelProblem) fail(`Invalid label "${label}". ${labelProblem}`);

const token = randomToken();
const tokenHash = await hashToken(token);
const sql = setupLinkStatements({ label, tokenHash, now: new Date() }).join(" ");

// wrangler's own output goes to stderr, so stdout carries only the link.
execute(sql, { local, json: false, failure: "no link was issued." });

console.log(`${local ? LOCAL_URL : PRODUCTION_URL}/setup/${token}`);
