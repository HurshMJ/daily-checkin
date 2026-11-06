/**
 * SQL text literals for statements run with `wrangler d1 execute --command`,
 * which takes no bound parameters. Shared by the Password Reset Link and the
 * right to create Groups SQL modules.
 *
 * This module is pure and imports nothing: Node runs it directly through type
 * stripping, so it must stay erasable TypeScript with no path aliases.
 */

/**
 * A SQL text literal. A typed value such as a username goes into the SQL
 * through this: single quotes are doubled, and a NUL character, which would
 * end the text early, is refused.
 */
export function sqlText(value: string): string {
  if (value.includes("\u0000")) throw new Error("Text holds a NUL character");
  return `'${value.replaceAll("'", "''")}'`;
}
