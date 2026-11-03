import { redirect } from "react-router";

import { authFor, clearedSessionCookie, currentSession } from "~/auth/request";
import { CONFIRM_FIELD, isConfirmed } from "~/components/tap-again-button";

import type { Route } from "./+types/logout-everywhere";

/** The profile with Log out everywhere armed, after a first tap without JavaScript. */
const ARMED_PROFILE = `/profile?${CONFIRM_FIELD}=logout-everywhere`;

/**
 * Log out everywhere: ends every session of the logged-in Member, but only
 * when the tap-again button confirmed it. An unconfirmed post changes nothing
 * and returns the profile with the button armed.
 */
export async function action({ request, context }: Route.ActionArgs) {
  if (!isConfirmed(await request.formData())) return redirect(ARMED_PROFILE, 303);
  const session = currentSession(context);
  if (session) await authFor(context).endAllSessions(session.member.id);
  return redirect("/login", { headers: { "Set-Cookie": clearedSessionCookie() } });
}
