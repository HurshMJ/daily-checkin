import { redirect } from "react-router";

import { authFor, clearedSessionCookie, currentSession } from "~/auth/request";

import type { Route } from "./+types/logout-everywhere";

/** Log out everywhere: ends every session of the logged-in Member. */
export async function action({ context }: Route.ActionArgs) {
  const session = currentSession(context);
  if (session) await authFor(context).endAllSessions(session.member.id);
  return redirect("/login", { headers: { "Set-Cookie": clearedSessionCookie() } });
}
