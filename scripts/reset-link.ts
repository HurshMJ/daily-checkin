// Operator command: prints a single-use Password Reset Link that works for 1 hour.
//
//   npm run operator:reset-link -- <username> [--local]
//
// The username is matched as login matches it: trimmed, NFC-normalised and
// lower-cased here in Node. An unknown username issues no link. The token is
// made here and never leaves this machine except inside the printed link; D1
// receives only its SHA-256. Issuing a link cancels every older usable link
// of that Member, whoever made it. Runs on Node's built-in type stripping, so
// it imports the shared modules by their .ts paths.

import { spawnSync } from "node:child_process";

import { hashToken, randomToken } from "../app/auth/crypto.ts";
import { memberLookupSql, operatorResetLinkStatements } from "../app/auth/reset-link-sql.ts";
import { normaliseText } from "../app/text-rules.ts";

const PRODUCTION_URL = "https://daily-checkin.gamecheckin.workers.dev";
const LOCAL_URL = "http://localhost:5173";
const USAGE = "Usage: npm run operator:reset-link -- <username> [--local]";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const local = args.includes("--local");
const positional = args.filter((arg) => arg !== "--local");
if (positional.length !== 1 || normaliseText(positional[0]) === "") fail(USAGE);

const username = positional[0];
// The same key as usernameKey() in app/auth/rules.ts, which Node cannot
// import: it reaches text-rules through a path alias.
const usernameKey = normaliseText(username).toLowerCase();

/** Runs SQL against D1 with wrangler; wrangler's own messages go to stderr. */
function execute(sql: string, json: boolean): string {
  const result = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", "DB", local ? "--local" : "--remote", "--yes", ...(json ? ["--json"] : []), "--command", sql],
    { stdio: ["ignore", json ? "pipe" : process.stderr, process.stderr], encoding: "utf8" },
  );
  if (result.error) fail(`Could not run wrangler: ${result.error.message}`);
  if (result.status !== 0) fail(`wrangler d1 execute failed (exit ${result.status}); no link was issued.`);
  return result.stdout ?? "";
}

let memberId: unknown;
try {
  const output = JSON.parse(execute(memberLookupSql(usernameKey), true)) as { results?: { id?: unknown }[] }[];
  memberId = output[0]?.results?.[0]?.id;
} catch {
  fail("Could not read the login lookup from wrangler; no link was issued.");
}
if (memberId === undefined) fail(`No login named ${normaliseText(username)}.`);
if (typeof memberId !== "number") fail("The login lookup returned no id; no link was issued.");

const token = randomToken();
const tokenHash = await hashToken(token);
execute(operatorResetLinkStatements({ memberId, tokenHash, now: new Date() }).join(" "), false);

console.log(`${local ? LOCAL_URL : PRODUCTION_URL}/reset/${token}`);
