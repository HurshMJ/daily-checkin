/**
 * The SQL of the right to create Groups, shared by the Operator command
 * (scripts/allow-groups.ts, which runs it with `wrangler d1 execute`) and the
 * tests, so both grant and take away the right the same way.
 *
 * This module is pure: Node runs it directly through type stripping, so it
 * must stay erasable TypeScript with no path aliases, and it imports only
 * another module of the same kind, by its .ts path.
 */

import { sqlText } from "./sql-text.ts";

/**
 * The one statement that gives the Member with this username key the right
 * to create Groups (`allowed` true) or takes it away (false). It names the
 * login it changed and its new state; no row comes back for an unknown key,
 * and then nothing changed.
 */
export function allowGroupsSql(usernameKey: string, allowed: boolean): string {
  return `UPDATE members SET can_create_groups = ${allowed ? 1 : 0} WHERE username_lower = ${sqlText(usernameKey)} RETURNING username, can_create_groups AS canCreateGroups;`;
}
