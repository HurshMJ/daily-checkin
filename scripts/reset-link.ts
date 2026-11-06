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

import { hashToken, randomToken } from "../app/auth/crypto.ts";
import { memberLookupSql, operatorResetLinkStatements } from "../app/auth/reset-link-sql.ts";
import { nameKey, normaliseText } from "../app/text-rules.ts";
import { execute, fail } from "./d1.ts";

const PRODUCTION_URL = "https://daily-checkin.gamecheckin.workers.dev";
const LOCAL_URL = "http://localhost:5173";
const USAGE = "Usage: npm run operator:reset-link -- <username> [--local]";

const args = process.argv.slice(2);
const local = args.includes("--local");
const positional = args.filter((arg) => arg !== "--local");
if (positional.length !== 1 || normaliseText(positional[0]) === "") fail(USAGE);

const username = positional[0];
const usernameKey = nameKey(username);
const NO_LINK = "no link was issued.";

let memberId: unknown;
try {
  const output = JSON.parse(execute(memberLookupSql(usernameKey), { local, json: true, failure: NO_LINK })) as { results?: { id?: unknown }[] }[];
  memberId = output[0]?.results?.[0]?.id;
} catch {
  fail("Could not read the login lookup from wrangler; no link was issued.");
}
if (memberId === undefined) fail(`No login named ${normaliseText(username)}.`);
if (typeof memberId !== "number") fail("The login lookup returned no id; no link was issued.");

const token = randomToken();
const tokenHash = await hashToken(token);
execute(operatorResetLinkStatements({ memberId, tokenHash, now: new Date() }).join(" "), { local, json: false, failure: NO_LINK });

console.log(`${local ? LOCAL_URL : PRODUCTION_URL}/reset/${token}`);
