/**
 * Builds the SQL that issues a Setup Link. Shared by the Operator command
 * (scripts/setup-link.ts, which runs it with `wrangler d1 execute`) and the
 * tests, so both exercise the same statements.
 *
 * This module is pure and imports nothing: Node runs it directly through type
 * stripping, so it must stay erasable TypeScript with no path aliases.
 */

/** How long a Setup Link works after it is issued. */
export const SETUP_LINK_LIFETIME_MS = 60 * 60 * 1000;

const LABEL = /^[A-Za-z0-9 _-]{1,40}$/;
const TOKEN_HASH = /^[0-9a-f]{64}$/;

/** Returns why a label is refused, or null when it is fine. */
export function setupLinkLabelError(label: string): string | null {
  return LABEL.test(label)
    ? null
    : "Use 1 to 40 characters: letters, digits, spaces, dashes and underscores.";
}

/**
 * The statements, in order: cancel every unused, uncancelled link with the
 * same label, then insert the new link's hash, valid for 1 hour from `now`.
 * Every value is checked against a strict pattern before it is placed in the
 * SQL, because `wrangler d1 execute --command` takes no bound parameters.
 */
export function setupLinkStatements(input: { label: string; tokenHash: string; now: Date }): string[] {
  const labelProblem = setupLinkLabelError(input.label);
  if (labelProblem) throw new Error(`Invalid label: ${labelProblem}`);
  if (!TOKEN_HASH.test(input.tokenHash)) throw new Error("Invalid token hash");
  if (Number.isNaN(input.now.getTime())) throw new Error("Invalid time");

  const now = input.now.toISOString();
  const expires = new Date(input.now.getTime() + SETUP_LINK_LIFETIME_MS).toISOString();
  return [
    `UPDATE setup_links SET cancelled_at = '${now}' WHERE label = '${input.label}' AND used_at IS NULL AND cancelled_at IS NULL;`,
    `INSERT INTO setup_links (token_hash, label, created_at, expires_at) VALUES ('${input.tokenHash}', '${input.label}', '${now}', '${expires}');`,
  ];
}
