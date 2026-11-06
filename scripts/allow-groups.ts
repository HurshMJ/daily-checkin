// Operator command: gives a Member the right to create Groups, or takes it away.
//
//   npm run operator:allow-groups -- <username> [--off] [--local]
//
// The username is matched as login matches it: trimmed, NFC-normalised and
// lower-cased here in Node. An unknown username changes nothing. The right is
// one flag on the Member; owning a Group by hand-over does not set it. Runs on
// Node's built-in type stripping, so it imports the shared modules by their
// .ts paths.

import { allowGroupsSql } from "../app/group-creators-sql.ts";
import { nameKey, normaliseText } from "../app/text-rules.ts";
import { execute, fail } from "./d1.ts";

const USAGE = "Usage: npm run operator:allow-groups -- <username> [--off] [--local]";
const FLAGS = new Set(["--off", "--local"]);

const args = process.argv.slice(2);
const local = args.includes("--local");
const allowed = !args.includes("--off");
const positional = args.filter((arg) => !FLAGS.has(arg));
if (positional.length !== 1 || positional[0].startsWith("--") || normaliseText(positional[0]) === "") fail(USAGE);

const username = positional[0];
const usernameKey = nameKey(username);

const stdout = execute(allowGroupsSql(usernameKey, allowed), {
  local,
  json: true,
  failure: "the right may not have changed.",
});

let changed: { username?: unknown; canCreateGroups?: unknown } | undefined;
try {
  const output = JSON.parse(stdout) as { results?: { username?: unknown; canCreateGroups?: unknown }[] }[];
  changed = output[0]?.results?.[0];
} catch {
  fail("Could not read wrangler's answer; check the login's right before trying again.");
}
if (changed === undefined) fail(`No login named ${normaliseText(username)}.`);
if (typeof changed.username !== "string" || (changed.canCreateGroups !== 0 && changed.canCreateGroups !== 1)) {
  fail("wrangler's answer named no login; check the login's right before trying again.");
}

console.log(
  changed.canCreateGroups === 1
    ? `${changed.username} can now create Groups.`
    : `${changed.username} can no longer create Groups.`,
);
