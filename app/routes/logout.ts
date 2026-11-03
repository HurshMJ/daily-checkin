import { redirect } from "react-router";

import { authFor, clearedSessionCookie, readCookie, SESSION_COOKIE } from "~/auth/request";

import type { Route } from "./+types/logout";

/** Log out: ends only this device's session. */
export async function action({ request, context }: Route.ActionArgs) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await authFor(context).endSession(token);
  return redirect("/login", { headers: { "Set-Cookie": clearedSessionCookie() } });
}
