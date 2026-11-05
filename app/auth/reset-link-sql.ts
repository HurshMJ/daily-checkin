/**
 * The SQL rules of a Password Reset Link, shared by the app
 * (app/auth/reset-links.ts) and the Operator command (scripts/reset-link.ts,
 * which runs its statements with `wrangler d1 execute`), so both issue links
 * the same way. The tests run the Operator statements too.
 *
 * This module is pure and imports nothing: Node runs it directly through type
 * stripping, so it must stay erasable TypeScript with no path aliases.
 */

/** How long a Password Reset Link works after it is made. */
export const RESET_LINK_LIFETIME_MS = 60 * 60 * 1000;

/**
 * The one usable rule for the password_reset_links row named `table`, given
 * the SQL for the current time: neither used nor cancelled, and not expired.
 */
export function usableResetLink(table: string, nowSql: string): string {
  return `${table}.used_at IS NULL AND ${table}.cancelled_at IS NULL AND ${table}.expires_at > ${nowSql}`;
}

const TOKEN_HASH = /^[0-9a-f]{64}$/;

/**
 * A SQL text literal. `wrangler d1 execute --command` takes no bound
 * parameters, so a typed value such as a username goes into the SQL through
 * this: single quotes are doubled, and a NUL character, which would end the
 * text early, is refused.
 */
export function sqlText(value: string): string {
  if (value.includes("\u0000")) throw new Error("Text holds a NUL character");
  return `'${value.replaceAll("'", "''")}'`;
}

/** The query the Operator command runs first: the Member's id for a username key, if any. */
export function memberLookupSql(usernameKey: string): string {
  return `SELECT id FROM members WHERE username_lower = ${sqlText(usernameKey)};`;
}

/**
 * The statements that issue an Operator's link, in order: cancel every usable
 * link of the Member, whoever made it, then insert the new link's hash with
 * made_by NULL, valid for 1 hour from `now`. Every value is checked before it
 * is placed in the SQL.
 */
export function operatorResetLinkStatements(input: { memberId: number; tokenHash: string; now: Date }): string[] {
  if (!Number.isSafeInteger(input.memberId) || input.memberId < 1) throw new Error("Invalid member id");
  if (!TOKEN_HASH.test(input.tokenHash)) throw new Error("Invalid token hash");
  if (Number.isNaN(input.now.getTime())) throw new Error("Invalid time");

  const now = sqlText(input.now.toISOString());
  const expires = sqlText(new Date(input.now.getTime() + RESET_LINK_LIFETIME_MS).toISOString());
  return [
    `UPDATE password_reset_links SET cancelled_at = ${now} WHERE member_id = ${input.memberId} AND ${usableResetLink("password_reset_links", now)};`,
    `INSERT INTO password_reset_links (token_hash, member_id, made_by, created_at, expires_at) VALUES ('${input.tokenHash}', ${input.memberId}, NULL, ${now}, ${expires});`,
  ];
}
