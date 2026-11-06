// Operator command: gives a Member the right to create Groups, or takes it away.
//
//   npm run operator:allow-groups -- <username> [--off] [--local]
//
// The username is matched as login matches it: trimmed, NFC-normalised and
// lower-cased here in Node. An unknown username changes nothing. The right is
// one flag on the Member; owning a Group by hand-over does not set it. Runs on
// Node's built-in type stripping, so it imports the shared modules by their
// .ts paths.

import { spawnSync } from "node:child_process";

import { allowGroupsSql } from "../app/group-creators-sql.ts";
import { normaliseText } from "../app/text-rules.ts";

const USAGE = "Usage: npm run operator:allow-groups -- <username> [--off] [--local]";
const FLAGS = new Set(["--off", "--local"]);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const local = args.includes("--local");
const allowed = !args.includes("--off");
const positional = args.filter((arg) => !FLAGS.has(arg));
if (positional.length !== 1 || positional[0].startsWith("--") || normaliseText(positional[0]) === "") fail(USAGE);

const username = positional[0];
// The same key as usernameKey() in app/auth/rules.ts, which Node cannot
// import: it reaches text-rules through a path alias.
const usernameKey = normaliseText(username).toLowerCase();

const result = spawnSync(
  "npx",
  ["wrangler", "d1", "execute", "DB", local ? "--local" : "--remote", "--yes", "--json", "--command", allowGroupsSql(usernameKey, allowed)],
  { stdio: ["ignore", "pipe", process.stderr], encoding: "utf8" },
);
if (result.error) fail(`Could not run wrangler: ${result.error.message}`);
if (result.status !== 0) fail(`wrangler d1 execute failed (exit ${result.status}); the right may not have changed.`);

let changed: { username?: unknown; canCreateGroups?: unknown } | undefined;
try {
  const output = JSON.parse(result.stdout) as { results?: { username?: unknown; canCreateGroups?: unknown }[] }[];
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
